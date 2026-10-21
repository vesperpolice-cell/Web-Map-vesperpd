/* ========================================
   VES-PD Map Module - POI API Routes
   CRUD สำหรับจุดแจ้งบนแผนที่
   ใช้ Google Sheets API (sheet "MapPOI")
   ======================================== */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');

const SHEET_NAME = 'MapPOI';

/** อ่านข้อมูล fallback จาก data/poi-cache.json (ใช้เมื่อไม่มี Google Sheets credentials หรือ Sheets error) */
function readLocalCache() {
  try {
    const cachePath = path.join(__dirname, '..', '..', 'data', 'poi-cache.json');
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8').replace(/^\uFEFF/, ''); // ตัด BOM
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
      return parsed.data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** เขียนข้อมูล fallback กลับลง data/poi-cache.json (สำหรับแก้ชื่อตอนไม่มี Sheets) */
function writeLocalCache(data) {
  try {
    const cachePath = path.join(__dirname, '..', '..', 'data', 'poi-cache.json');
    const payload = {
      success: true,
      data: data,
      source: 'fallback-cache',
      note: 'snapshot from production /api/poi for local/dev fallback when Google Sheets is unavailable'
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/** สแกนไฟล์ไอคอนใน blips/custom/ (รับทั้ง .webp และ .png)
 *
 *  id = ชื่อไฟล์ที่ตัดนามสกุลออก ซึ่งเป็นค่าที่เก็บอยู่ในคอลัมน์หมวดของชีต MapPOI
 *  → ต้องตัดได้ทั้งสองนามสกุลแล้วได้ id เดิมเป๊ะ ไม่งั้น POI หลุดหมวดทั้งแผนที่
 *  ยังรับ .png ต่อไปเพื่อให้ดรอปไฟล์ใหม่ลงโฟลเดอร์แบบเดิมได้อยู่
 */
const ICON_EXT = /\.(webp|png)$/i;

function scanCustomIcons() {
  const iconsDir = path.join(__dirname, '..', 'blips', 'custom');
  try {
    if (!fs.existsSync(iconsDir)) return [];

    // ถ้ามีทั้ง X.png และ X.webp ให้เหลือ id เดียว โดยเลือก .webp
    // (ไม่งั้น loadCategories() จะได้ id ซ้ำแล้วทับกันเองตามลำดับ readdir)
    const byId = new Map();
    for (const f of fs.readdirSync(iconsDir)) {
      if (!ICON_EXT.test(f)) continue;
      const id = f.replace(ICON_EXT, '');
      if (!id.trim()) continue;
      if (byId.has(id) && !/\.webp$/i.test(f)) continue;
      byId.set(id, { id, label: `📌 ${id}`, file: f });
    }
    return [...byId.values()];
  } catch (e) {
    return [];
  }
}

/** Helper: ตรวจสอบ/สร้าง Sheet "MapPOI" ถ้ายังไม่มี */
async function ensureSheetExists(sheets, spreadsheetId) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = spreadsheet.data.sheets.some(s => s.properties.title === SHEET_NAME);
  if (exists) return;

  // สร้าง sheet ใหม่
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
    }
  });

  // ใส่ headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:G1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [['id', 'name', 'category', 'description', 'x', 'y', 'createdAt']]
    }
  });
}

/**
 * ซ่อม/จัดระเบียบชีต MapPOI ให้เป็นตารางเดียวติดกัน เริ่มที่คอลัมน์ A (A-G)
 * - กู้แถวที่ข้อมูลเพี้ยนไปอยู่คอลัมน์ D-K (ที่เกิดจาก values.append ตรวจจับ table ผิด) กลับมา
 * - ลบแถวว่าง/ข้อมูลขยะที่ค้างออก
 * ใช้สำหรับเรียกครั้งเดียวตอน mount + ผ่าน route /api/poi/repair
 */
async function repairSheet(sheets, sid) {
  // ตรวจสอบว่ามีชีต MapPOI หรือไม่ (ถ้ายังไม่มีก็ไม่มีอะไรต้องซ่อม)
  let spreadsheet;
  try {
    spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sid });
  } catch (e) {
    return { recovered: 0, total: 0 };
  }
  const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === SHEET_NAME);
  if (!sheetExists) return { recovered: 0, total: 0 };

  // อ่านช่วงกว้าง A:K เพื่อจับทั้งแถวปกติ (A-G) และแถวที่เพี้ยน (D-K)
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: sid,
    range: `${SHEET_NAME}!A:K`
  });
  const rows = read.data.values || [];
  if (rows.length === 0) return { recovered: 0, total: 0 };

  const normalized = [];
  let recovered = 0;

  // rows[0] = header (ข้ามไป) เริ่มที่แถวข้อมูล
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];

    // แถวถูกต้อง: col A มี id
    if (row[0] && String(row[0]).trim()) {
      normalized.push([
        String(row[0]).trim(),
        (row[1] || '').toString(),
        (row[2] || '').toString(),
        (row[3] || '').toString(),
        (row[4] || '').toString(),
        (row[5] || '').toString(),
        (row[6] || '').toString(),
        (row[9] || '').toString()  // ← column J (dcId) รักษาไว้
      ]);
      continue;
    }

    // แถวเพี้ยน (เลื่อนไป D): col D มี id แต่ col A ว่าง
    if (row[3] && String(row[3]).trim()) {
      recovered++;
      normalized.push([
        String(row[3]).trim(),    // id          ← D
        (row[4] || '').toString(), // name       ← E
        (row[5] || '').toString(), // category   ← F
        (row[6] || '').toString(), // description← G
        (row[7] || '').toString(), // x          ← H
        (row[8] || '').toString(), // y          ← I
        (row[9] || '').toString(), // createdAt  ← J
        ''                         // dcId ว่าง (ไม่มีในแถวเพี้ยน)
      ]);
      continue;
    }

    // แถวว่าง/ขยะ (ไม่มี id ทั้ง col A และ col D) → ข้าม
  }

  // ⚠️ กันข้อมูลหาย (1): ถ้าอ่านไม่ได้สักแถวเลย แปลว่าผิดปกติ — ห้ามแตะชีตเด็ดขาด
  // ของเดิมจะ clear ทิ้งแล้วไม่เขียนอะไรกลับ (เพราะ values.length === 1) = ข้อมูลหายเกลี้ยง
  if (normalized.length === 0) {
    return {
      recovered: 0,
      total: 0,
      skipped: 'ไม่พบแถวที่อ่านได้ — ยกเลิกการซ่อมเพื่อกันข้อมูลหาย'
    };
  }

  // เขียน header + ข้อมูลที่กู้ได้ กลับเป็น A-G ติดกัน (ไม่รวม dcId)
  const values = [
    ['id', 'name', 'category', 'description', 'x', 'y', 'createdAt'],
    ...normalized.map(row => row.slice(0, 7)) // ตัดเหลือ 7 columns
  ];

  // ⚠️ กันข้อมูลหาย (2): เขียนทับลงไปก่อน แล้วค่อยล้างส่วนเกิน
  // ของเดิม clear ก่อนแล้วค่อย update ถ้า process ตายคั่นกลาง (เน็ตหลุด/timeout/ถูก kill)
  // ชีตจะเหลือว่างเปล่า — ลำดับใหม่นี้ไม่มีช่วงเวลาที่ข้อมูลหายไปจากชีต
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });

  // ล้างเฉพาะแถวส่วนเกินที่ค้างอยู่ท้ายตาราง (ตอนนี้ข้อมูลจริงเขียนเสร็จแล้ว)
  if (rows.length > values.length) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sid,
      range: `${SHEET_NAME}!A${values.length + 1}:G${rows.length}`
    });
  }

  // เขียน dcId ลง column J (index 9)
  if (normalized.length > 0) {
    const dcIdValues = normalized.map(row => [row[7] || '']); // column H ใน array คือ dcId
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `${SHEET_NAME}!J2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: dcIdValues }
    });
  }

  return { recovered, total: normalized.length };
}

function createPoiRoutes(getSheetsFn) {
  const router = Router();

  // ==================== GET /api/poi/categories ====================
  router.get('/categories', (req, res) => {
    const icons = scanCustomIcons();
    res.json({ success: true, data: icons });
  });

  // ==================== POST /api/poi/repair ====================
  // ซ่อมชีต MapPOI: กู้ข้อมูลที่เพี้ยน (D-K) กลับมาเป็น A-G + ลบแถวว่าง
  router.post('/repair', async (req, res) => {
    try {
      const sheets = getSheetsFn();
      const config = require('../../server/config');
      const sid = config.MAP_SHEET_ID || config.SHEET_ID;
      if (!sid) {
        return res.status(500).json({ success: false, error: 'ไม่พบ MAP_SHEET_ID / SHEET_ID' });
      }
      const result = await repairSheet(sheets, sid);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[POI] Repair error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== GET /api/poi ====================
  router.get('/', async (req, res) => {
    try {
      const sheets = getSheetsFn();
      const config = require('../../server/config');
      const sid = config.MAP_SHEET_ID || config.SHEET_ID;

      // ไม่มี Google Sheets config → ใช้ข้อมูลจาก local cache (เพื่อให้ dev/local ยังเห็นข้อมูลเดิม)
      if (!sid) {
        const cached = readLocalCache();
        if (cached) {
          return res.json({ success: true, data: cached });
        }
        return res.json({ success: true, data: [] });
      }

      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sid });
      const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === SHEET_NAME);

      if (!sheetExists) {
        return res.json({ success: true, data: [] });
      }

      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${SHEET_NAME}!A:J`
      });

      const rows = result.data.values || [];
      if (rows.length <= 1) {
        return res.json({ success: true, data: [] });
      }

      const headers = rows[0];
      const data = rows.slice(1).map(row => {
        const item = {};
        headers.forEach((h, i) => { item[h] = row[i] || ''; });
        // รองรับทั้ง header "dcId" และ "ID DC"
        const dcId = item.dcId || item['ID DC'] || '';
        return {
          id: item.id,
          name: item.name || '',
          category: item.category || 'custom',
          description: item.description || '',
          x: parseFloat(item.x) || 0,
          y: parseFloat(item.y) || 0,
          createdAt: item.createdAt || new Date().toISOString(),
          dcId: dcId
        };
      }).filter(item => item.id);

      res.json({ success: true, data });
    } catch (err) {
      console.error('[POI] GET error:', err.message);
      // Sheets ล้มเหลว (เช่น credentials ไม่ถูกต้อง) → ให้ข้อมูลจาก local cache แทน เพื่อให้หน้าไม่ว่าง
      const cached = readLocalCache();
      if (cached) {
        return res.json({ success: true, data: cached });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== POST /api/poi ====================
  router.post('/', async (req, res) => {
    try {
      const { name, category, description, x, y, dcId } = req.body;

      if (!name || !category || x === undefined || y === undefined) {
        return res.status(400).json({
          success: false,
          error: 'กรุณากรอกข้อมูลให้ครบ: name, category, x, y'
        });
      }

      const sheets = getSheetsFn();
      const config = require('../../server/config');
      const sid = config.MAP_SHEET_ID || config.SHEET_ID;
      const id = require('crypto').randomUUID();

      // ตรวจสอบ/สร้าง sheet ถ้ายังไม่มี
      await ensureSheetExists(sheets, sid);

      // ⚠️ ห้ามใช้ values.append เด็ดขาด — นี่คือต้นตอของปัญหาข้อมูลเพี้ยน
      //    append จะให้ Google "เดา" ขอบเขตตารางเอง พอชีตนี้มีข้อมูลอื่นอยู่คอลัมน์ I/J ด้วย
      //    มันเคยเดาผิดแล้วเขียนจุดใหม่ลงคอลัมน์ D-K แทน A-G (ดูคอมเมนต์ของ repairSheet ด้านบน)
      //    แถวที่เพี้ยนจะมีคอลัมน์ A ว่าง → repairSheet มองเป็นขยะ → ข้อมูลหาย
      //
      //    วิธีใหม่: คำนวณเลขแถวเองแล้วเขียนลงตำแหน่งที่ระบุชัดเจน ไม่มีการเดาอีกต่อไป
      const colA = await sheets.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${SHEET_NAME}!A:A`
      });
      const nextRow = (colA.data.values || []).length + 1;

      await sheets.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${SHEET_NAME}!A${nextRow}:G${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[id, name, category, description || '', x, y, new Date().toISOString()]]
        }
      });

      // ถ้ามี dcId ให้เขียนลง column J ของ "แถวเดียวกัน"
      // (ของเดิมนับจำนวนเซลล์ในคอลัมน์ A มาใช้เป็นเลขแถว ซึ่งคลาดเคลื่อนได้ → เขียนทับแถวอื่น)
      if (dcId) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sid,
          range: `${SHEET_NAME}!J${nextRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[dcId]] }
        });
      }

      res.json({ success: true, data: { id, name, category, description, x, y, dcId: dcId || '' } });
    } catch (err) {
      console.error('[POI] POST error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== DELETE /api/poi/:id ====================
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const sheets = getSheetsFn();
      const config = require('../../server/config');
      const sid = config.MAP_SHEET_ID || config.SHEET_ID;

      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${SHEET_NAME}!A:G`
      });

      const rows = result.data.values || [];
      const rowIndex = rows.findIndex(row => row[0] === id);

      if (rowIndex === -1) {
        return res.status(404).json({ success: false, error: 'ไม่พบจุดที่ต้องการลบ' });
      }
      // ป้องกันการลบ header (แถวแรก)
      if (rowIndex < 1) {
        return res.status(400).json({ success: false, error: 'ไม่สามารถลบแถว header ได้' });
      }

      // หา sheetId ของชีต MapPOI (จำเป็นสำหรับ deleteDimension)
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sid });
      const sheet = spreadsheet.data.sheets.find(s => s.properties.title === SHEET_NAME);
      if (!sheet) {
        return res.status(404).json({ success: false, error: 'ไม่พบชีต MapPOI' });
      }

      // ลบแถวจริงออกจากชีต (ไม่ใช้ values.clear ที่ทิ้งแถวว่าง)
      // rows[0] = header = แถวที่ 1 ของชีต; rowIndex คือ zero-based index ในอาร์เรย์
      // แถวเป้าหมาย = แถวที่ (rowIndex+1) ของชีต → deleteDimension startIndex = rowIndex
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex,
                endIndex: rowIndex + 1
              }
            }
          }]
        }
      });

      res.json({ success: true });
    } catch (err) {
      console.error('[POI] DELETE error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== PUT /api/poi/:id (แก้ไขชื่อ/รายละเอียด) ====================
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;

      // ต้องมี name หรือ description อย่างน้อยอย่างหนึ่ง
      if (!name && description === undefined) {
        return res.status(400).json({ success: false, error: 'กรุณาส่ง name หรือ description ที่ต้องการแก้ไข' });
      }

      const sheets = getSheetsFn();
      const config = require('../../server/config');
      const sid = config.MAP_SHEET_ID || config.SHEET_ID;

      // ── โหมดไม่มี Google Sheets → แก้ใน local cache (dev/offline) ──
      if (!sid) {
        const cached = readLocalCache();
        if (!cached) return res.status(404).json({ success: false, error: 'ไม่พบไฟล์ข้อมูลสำรอง' });
        const idx = cached.findIndex(p => String(p.id) === String(id));
        if (idx === -1) return res.status(404).json({ success: false, error: 'ไม่พบจุดที่ต้องการแก้ไข' });
        if (name !== undefined && name !== null) cached[idx].name = String(name).trim() || cached[idx].name;
        if (description !== undefined) cached[idx].description = description;
        if (!writeLocalCache(cached)) return res.status(500).json({ success: false, error: 'บันทึกไฟล์สำรองไม่สำเร็จ' });
        return res.json({ success: true, data: cached[idx] });
      }

      // ── โหมด Google Sheets ──
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${SHEET_NAME}!A:G`
      });
      const rows = result.data.values || [];
      const rowIndex = rows.findIndex(row => row[0] === id);
      if (rowIndex === -1) {
        return res.status(404).json({ success: false, error: 'ไม่พบจุดที่ต้องการแก้ไข' });
      }
      if (rowIndex < 1) {
        return res.status(400).json({ success: false, error: 'ไม่สามารถแก้ไขแถว header ได้' });
      }

      // คอลัมน์ B=name, D=description (แถวที่ rowIndex+1 เพราะ rowIndex นับจาก 0 และแถว 0 คือ header)
      const updates = [];
      if (name !== undefined && name !== null) {
        updates.push({ range: `${SHEET_NAME}!B${rowIndex + 1}`, value: String(name).trim() });
      }
      if (description !== undefined) {
        updates.push({ range: `${SHEET_NAME}!D${rowIndex + 1}`, value: description });
      }

      for (const u of updates) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sid,
          range: u.range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[u.value]] }
        });
      }

      res.json({ success: true, data: { id, name: String(name).trim(), description } });
    } catch (err) {
      console.error('[POI] PUT error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== AUTO-REPAIR ON MOUNT (ปิดถาวร) ====================
  // ⛔ เดิมตรงนี้สั่งซ่อมชีตเองทุกครั้งที่ server เริ่มทำงาน โดยไม่มีใครสั่งและไม่มีเงื่อนไข
  //    ซึ่งแปลว่า "เปิดเว็บ 1 ครั้ง = แตะข้อมูลจริง 1 ครั้ง" และเคยทำข้อมูลหายทั้งแผ่นมาแล้ว
  //    (กู้คืนจาก Google Sheets > ไฟล์ > ประวัติเวอร์ชัน)
  //    หมายเหตุ: ระบบรหัสผ่านกันจุดนี้ไม่ได้ เพราะมันรันตอน mount router
  //    ซึ่งเกิดก่อนจะมี HTTP request ใดๆ เข้ามา
  //
  //    ถ้าต้องการซ่อมชีตจริงๆ ให้เรียกมือผ่าน POST /api/poi/repair แทน
  //    (ซึ่งตอนนี้ต้องใส่รหัสก่อนด้วย)

  return router;
}

module.exports = createPoiRoutes;