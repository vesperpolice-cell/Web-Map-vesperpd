/* ========================================
   VES-PD Map - สวิตช์ซ่อนจุดทั้งแผนที่ (โหมดสอบ)

   แอดมินที่ใส่รหัสแล้วกดปิด → คนที่ไม่ได้ใส่รหัสจะไม่ได้ข้อมูลจุดเลย
   /api/poi คืน [] ออกไปเลย ไม่ใช่แค่ซ่อนด้วย JavaScript — เปิด URL ตรง ๆ ก็ไม่เห็น
   (เกม /Challenge ก็ปิดตามอัตโนมัติ เพราะมันดึงจุดจาก /api/poi เหมือนกัน)

   ── ทำไมไฟล์นี้อยู่นอก map-module ──
   map-module ก๊อปมาจากเว็บหลัก แก้ได้แค่ poi-routes.js (ดูตารางหัว README)
   ตัวนี้เลยเสียบเป็น middleware คั่นหน้า poi-routes แทนการเข้าไปแก้ในโมดูล

   ── ที่เก็บ flag ──
   ชีต "Settings" ช่อง A1 ในสเปรดชีตเดียวกับ MapPOI แต่คนละแท็บ
   ไม่มีคำสั่งไหนในไฟล์นี้แตะชีต MapPOI เลย (ชีตนั้นเคยข้อมูลหายมาแล้ว)

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

const SHEET_NAME = 'Settings';
const RANGE = `${SHEET_NAME}!A1`;
const HIDDEN = 'HIDDEN';
const VISIBLE = 'VISIBLE';
const TTL_MS = 15000;

/** cache ของ flag — { hidden, at } ; at = 0 แปลว่ายังไม่เคยอ่าน/เพิ่งถูกล้าง */
let cache = { hidden: false, at: 0 };

function sheetId() {
    return config.MAP_SHEET_ID || config.SHEET_ID;
}

/**
 * ยังไม่เคยมีการกดปิดสักครั้ง → ชีต Settings ยังไม่ถูกสร้าง
 * Sheets จะตอบ 400 "Unable to parse range" ซึ่งไม่ใช่ความผิดปกติ ต้องนับเป็น "เปิดอยู่"
 * ไม่งั้นแค่ deploy โค้ดนี้ขึ้นไป แผนที่จะดับทั้งเว็บทันทีทั้งที่ยังไม่มีใครสั่งอะไร
 */
function isMissingSheet(err) {
    const status = err && (err.code || (err.response && err.response.status));
    return status === 400 || /unable to parse range/i.test((err && err.message) || '');
}

/** อ่าน flag จากชีต (ผ่าน cache) — โยน error ออกไปถ้าอ่านไม่ได้จริง ให้ผู้เรียกตัดสินใจ */
async function readHidden(sheets) {
    if (cache.at && Date.now() - cache.at < TTL_MS) return cache.hidden;

    let cell = '';
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId(),
            range: RANGE
        });
        cell = ((res.data.values || [])[0] || [])[0] || '';
    } catch (err) {
        if (!isMissingSheet(err)) throw err;
    }

    cache = { hidden: String(cell).trim().toUpperCase() === HIDDEN, at: Date.now() };
    return cache.hidden;
}

/** เขียน flag ลงชีต — สร้างแท็บ Settings ให้เองถ้ายังไม่มี */
async function writeHidden(sheets, hidden) {
    const spreadsheetId = sheetId();

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some(s => s.properties.title === SHEET_NAME);
    if (!exists) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] }
        });
        logger.info(`สร้างชีต "${SHEET_NAME}" ใหม่`);
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: RANGE,
        valueInputOption: 'RAW',
        requestBody: { values: [[hidden ? HIDDEN : VISIBLE]] }
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
