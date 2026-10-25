/* ========================================
   VES-PD Map - สวิตช์ซ่อนจุดทั้งแผนที่ (โหมดสอบ)

   แอดมินที่ใส่รหัสแล้วกดปิด → คนที่ไม่ได้ใส่รหัสจะไม่ได้ข้อมูลจุดเลย
   /api/poi คืน [] ออกไปเลย ไม่ใช่แค่ซ่อนด้วย JavaScript — เปิด URL ตรง ๆ ก็ไม่เห็น
   (เกม /Challenge ก็ปิดตามอัตโนมัติ เพราะมันดึงจุดจาก /api/poi เหมือนกัน)

   ── ทำไมไฟล์นี้อยู่นอก map-module ──
   map-module ก๊อปมาจากเว็บหลัก แก้ได้แค่ poi-routes.js (ดูตารางหัว README)
   ตัวนี้เลยเสียบเป็น middleware คั่นหน้า poi-routes แทนการเข้าไปแก้ในโมดูล

   ── ที่เก็บ flag ──
   ชีต MapPOI แถว 1 — H1 = "POI_VISIBILITY" (ป้ายบอกว่าช่องนี้คืออะไร)
   I1 = "VISIBLE" / "HIDDEN" (ค่าจริงที่ใช้ตัดสิน)

   ไฟล์นี้ "ไม่สร้างชีต/แท็บใด ๆ" เด็ดขาด: เขียนเฉพาะ MapPOI!I1 (และเติม H1 ให้ถ้ายังว่าง)
   ไม่แตะคอลัมน์ A:G ซึ่งเป็นตารางจุดจริง (ชีตนั้นเคยข้อมูลหายมาแล้ว)
   ชีต MapPOI ต้องมีอยู่ก่อน — ถ้าไม่มี ปุ่มจะได้ 409 พร้อมข้อความ ไม่ใช่สร้างขึ้นมาเอง

   คอลัมน์ H/I ถูกจองให้สวิตช์นี้: repairSheet เขียนใหม่เฉพาะ A:G (+ dcId ที่ J)
   ส่วน poi-backup อ่าน A:K จึงพาค่า flag ติดไปในไฟล์สำรองด้วย (อ่านอย่างเดียว ไม่กระทบ)

   cache ไว้ในหน่วยความจำ 15 วินาที ไม่งั้นทุก request จะยิง Sheets เพิ่มอีกหนึ่งครั้ง
   ซึ่งตอนคนเข้าพร้อมกันเยอะ ๆ จะไปชน quota ของ Sheets

   ── อ่าน flag ไม่ได้ = ถือว่าปิดไว้ก่อน (fail closed) ──
   poi-routes.js มี fallback ว่าถ้า Sheets ล่มให้อ่าน data/poi-cache.json แทน
   ถ้าปล่อยให้ fail open ตอนสอบแล้ว Sheets ดันล่ม ข้อมูลจะหลุดออกไปทั้งชุด
   ======================================== */

const { Router } = require('express');
const { createLogger } = require('./utils/logger');
const config = require('./config');
const pinAuth = require('./pin-auth');

const logger = createLogger('PoiVisibility');

/* ที่เก็บ flag: MapPOI!H1 = ป้าย, MapPOI!I1 = ค่า — ไม่มีแท็บ "Settings" อีกแล้ว */
const SHEET_NAME = 'MapPOI';
const LABEL = 'POI_VISIBILITY';
const LABEL_RANGE = `${SHEET_NAME}!H1`;
const VALUE_RANGE = `${SHEET_NAME}!I1`;
const PAIR_RANGE = `${SHEET_NAME}!H1:I1`;
const HIDDEN = 'HIDDEN';
const VISIBLE = 'VISIBLE';
const TTL_MS = 15000;

/** cache ของ flag — { hidden, at } ; at = 0 แปลว่ายังไม่เคยอ่าน/เพิ่งถูกล้าง */
let cache = { hidden: false, at: 0 };

function sheetId() {
    return config.MAP_SHEET_ID || config.SHEET_ID;
}

/**
 * ชีต MapPOI ยังไม่มี (สเปรดชีตว่าง/ยังไม่เคยสร้างจุด) → Sheets ตอบ 400 "Unable to parse range"
 * ไม่ใช่ความผิดปกติ: ตอนอ่านต้องนับเป็น "เปิดอยู่" ไม่งั้นแค่ deploy โค้ดนี้ขึ้นไป
 * แผนที่จะดับทั้งเว็บทันทีทั้งที่ยังไม่มีใครสั่งอะไร
 * ตอนเขียน (POST) กรณีนี้จะถูกแปลงเป็น 409 พร้อมบอกแอดมิน ไม่ใช่สร้างชีตขึ้นมาเอง
 */
function isMissingSheet(err) {
    const status = err && (err.code || (err.response && err.response.status));
    return status === 400 || /unable to parse range/i.test((err && err.message) || '');
}

/** แปลงค่าจาก H1:I1 เป็น true (ปิด) / false (เปิด) — พิมพ์ผิดหรือว่าง = เปิด */
function parseFlag(row) {
    const label = String((row && row[0]) || '').trim().toUpperCase();
    const value = String((row && row[1]) || '').trim().toUpperCase();
    if (value === HIDDEN) return true;
    if (value === VISIBLE) return false;
    // เผื่อมีคนสลับไปใส่ค่าในช่อง H (หรือย้ายคอลัมน์) — ยังอ่านได้ ไม่เงียบหาย
    return label === HIDDEN;
}

/** อ่าน flag จาก MapPOI!H1:I1 (ผ่าน cache) — โยน error ออกไปถ้าอ่านไม่ได้จริง ให้ผู้เรียกตัดสินใจ */
async function readHidden(sheets) {
    if (cache.at && Date.now() - cache.at < TTL_MS) return cache.hidden;

    let row = [];
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId(),
            range: PAIR_RANGE
        });
        row = (res.data.values || [])[0] || [];
    } catch (err) {
        if (!isMissingSheet(err)) throw err;
    }

    cache = { hidden: parseFlag(row), at: Date.now() };
    return cache.hidden;
}

/**
 * เขียน flag ลง MapPOI!I1 — ไม่สร้างชีต/แท็บใด ๆ และไม่แตะคอลัมน์ A:G
 * ถ้า H1 ยังว่าง จะเติมป้าย "POI_VISIBILITY" ให้ในครั้งเดียวกัน (ไม่ทับของเดิม)
 */
async function writeHidden(sheets, hidden) {
    const spreadsheetId = sheetId();
    const value = hidden ? HIDDEN : VISIBLE;

    let label = '';
    try {
        const cur = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: LABEL_RANGE
        });
        label = ((cur.data.values || [])[0] || [])[0] || '';
    } catch (err) {
        if (!isMissingSheet(err)) throw err;
    }

    const hasLabel = !!String(label).trim();
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: hasLabel ? VALUE_RANGE : PAIR_RANGE,
        valueInputOption: 'RAW',
        requestBody: { values: hasLabel ? [[value]] : [[LABEL, value]] }
    });

    cache = { hidden, at: Date.now() };
}

/**
 * router ที่ต้อง mount ก่อน poi-routes:
 *   GET  /api/poi/visibility  อ่านสถานะ (ใครก็อ่านได้ — หน้าเว็บต้องใช้ตอนวาดปุ่ม)
 *   POST /api/poi/visibility  สลับสถานะ (pinAuth.requirePin กัน POST ไว้ให้แล้ว)
 *   GET  /api/poi/game        ทางลัดให้เกม — ได้ข้อมูลเสมอ ไม่สนสวิตช์
 *   GET  /api/poi             ถ้าปิดอยู่และผู้เรียกไม่ได้ใส่รหัส → คืน [] แล้วจบตรงนี้
 */
function createVisibilityRoutes(getSheetsFn) {
    const router = Router();

    /* เกม /Challenge ใช้ทางนี้แทน /api/poi เพื่อให้เล่นได้ตลอดแม้สวิตช์ปิดอยู่
       รูปแบบการสอบคือขับรถพาดูใน map แล้วให้ผู้สอบทายว่าเป็นที่ไหน
       เกมสุ่มจุดมาทีละอัน กดหาให้ตรงกับที่เห็นตรงหน้าภายในไม่กี่วินาทีไม่ทัน
       จึงไม่นับเป็นทางลัดของการสอบแบบนี้

       ⚠️ แลกมาด้วย: ใครเปิด URL นี้ตรง ๆ ก็ได้ข้อมูลครบเหมือน /api/poi ตอนสวิตช์เปิด
       เป็นการยอมแลกที่ตั้งใจ ไม่ใช่มองข้าม */
    router.get('/game', (req, res, next) => {
        req.url = '/';      // ให้ poi-routes มองเป็น GET /api/poi ปกติ
        next('router');     // ออกจาก router นี้เลย ไม่ผ่านด่านเช็คสวิตช์ข้างล่าง
    });

    router.get('/visibility', async (req, res) => {
        if (!sheetId()) return res.json({ success: true, hidden: false });
        try {
            res.json({ success: true, hidden: await readHidden(getSheetsFn()) });
        } catch (err) {
            logger.warn('อ่านสถานะไม่ได้ ถือว่าปิดไว้ก่อน: ' + err.message);
            res.json({ success: true, hidden: true });
        }
    });

    router.post('/visibility', async (req, res) => {
        if (!sheetId()) {
            return res.status(500).json({ success: false, error: 'ไม่พบ MAP_SHEET_ID / SHEET_ID' });
        }
        const hidden = !!(req.body && req.body.hidden);
        try {
            await writeHidden(getSheetsFn(), hidden);
            logger.info(hidden ? 'ปิดจุดทั้งแผนที่แล้ว' : 'เปิดจุดทั้งแผนที่แล้ว');
            res.json({ success: true, hidden });
        } catch (err) {
            if (isMissingSheet(err)) {
                logger.error(`สลับสถานะไม่สำเร็จ: ไม่พบชีต "${SHEET_NAME}" หรือช่วง H1:I1 (${err.message})`);
                return res.status(409).json({
                    success: false,
                    error: `ยังไม่มีชีต "${SHEET_NAME}" ในสเปรดชีตนี้ — ระบบไม่สร้างชีตให้เอง `
                        + 'กรุณาเพิ่มจุด POI สักจุดจากหน้าแผนที่ (หรือสร้างชีต MapPOI) แล้วกดสลับอีกครั้ง'
                });
            }
            logger.error('สลับสถานะไม่สำเร็จ: ' + err.message);
            res.status(500).json({ success: false, error: 'สลับสถานะไม่สำเร็จ' });
        }
    });

    router.get('/', async (req, res, next) => {
        if (!sheetId()) return next();
        if (pinAuth.isUnlocked(req)) return next();

        let hidden;
        try {
            hidden = await readHidden(getSheetsFn());
        } catch (err) {
            logger.warn('อ่านสถานะไม่ได้ ถือว่าปิดไว้ก่อน: ' + err.message);
            hidden = true;
        }

        if (!hidden) return next();
        res.json({ success: true, data: [], hidden: true });
    });

    return router;
}

module.exports = { createVisibilityRoutes };
