/* ========================================
   MHNK PD // GEO-INTEL MAP  (standalone)
   เว็บแผนที่แยกเดี่ยว — เสิร์ฟ map-module/ โดยไม่แก้ไฟล์ในโมดูลเลย

   โครงโฟลเดอร์ต้องเป็นแบบนี้เท่านั้น เพราะ map-module/server/poi-routes.js
   hardcode path ออกนอกโมดูลไว้:
     require('../../server/config')                        → server/config/
     path.join(__dirname,'..','..','data','poi-cache.json') → data/

   หน้าแผนที่ใช้ public/map.html ของเว็บนี้ (ไม่ใช่ของใน map-module)
   เพราะเปลี่ยนจากระบบ Discord เป็นรหัส 4 หลัก
   ======================================== */

// Load config first (triggers dotenv + validation)
const config = require('./config');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createLogger } = require('./utils/logger');

const { getSheets } = require('./config/googleAuth');
const pinAuth = require('./pin-auth');
const poiBackup = require('./poi-backup');
const poiVisibility = require('./poi-visibility');

const logger = createLogger('Server');
const app = express();

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAP_MODULE_DIR = path.join(ROOT, 'map-module');

// trust proxy - รองรับ X-Forwarded-For เมื่อรันหลัง Reverse Proxy (Render)
app.set('trust proxy', 1);

// ==================== SECURITY MIDDLEWARE (Helmet) ====================
app.use(helmet({
    contentSecurityPolicy: false, // ปิดเพราะใช้ inline styles
    crossOriginEmbedderPolicy: false // ปิดเพราะโหลด resource จาก CDN (fonts, Leaflet)
}));

// ==================== RATE LIMITING ====================
// ⚠️ นับเฉพาะ /api เท่านั้น — ห้ามนับ static file
// หน้าแผนที่โหลด tile + ไอคอนหมุด (413 หมุด) รวมหลายร้อยไฟล์ต่อการเปิด 1 ครั้ง
// ถ้านับรวมจะโดน 429 ตั้งแต่เปิดหน้าแรก
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 นาที
    max: 300,            // สูงสุด 300 request/นาที
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'มีการใช้งานมากเกินไป กรุณาลองใหม่ใน 1 นาที' }
});

// รหัสมีแค่ 4 หลัก (10,000 ความเป็นไปได้) ต้องจำกัดการเดาให้หนัก
const pinLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 นาที
    max: 8,                   // สูงสุด 8 ครั้ง/10 นาที ต่อ IP
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, error: 'ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 10 นาที' }
});

// ==================== MIDDLEWARE ====================
app.use(compression({
    threshold: config.COMPRESSION_THRESHOLD,
    level: config.COMPRESSION_LEVEL,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));
app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use('/api', apiLimiter);

// ==================== PIN AUTH ====================
pinAuth.mountRoutes(app, pinLimiter);

// ==================== MAP MODULE API ====================
// กันเขียนก่อน: GET ปล่อยผ่าน / POST-PUT-DELETE ต้องใส่รหัสก่อน
app.use('/api/poi', pinAuth.requirePin);

// สวิตช์ซ่อนจุดทั้งแผนที่ (โหมดสอบ) — ต้องมาก่อน poi-routes เพราะมันดัก GET /api/poi
app.use('/api/poi', poiVisibility.createVisibilityRoutes(() => getSheets()));

// createPoiRoutes รับ sheets client แบบ injection → ไม่ต้องแก้อะไรในโมดูล
try {
    const createPoiRoutes = require('../map-module/server/poi-routes');
    app.use('/api/poi', createPoiRoutes(() => getSheets()));
    logger.info('[MapModule] POI API mounted at /api/poi');
} catch (e) {
    logger.warn('[MapModule] POI API not loaded: ' + e.message);
}

// ==================== STATIC FILES ====================
const staticOptions = {
    maxAge: '1h',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.gif') || filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.webp')) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
};

// /logo.webp, /src/map-pin.js, /src/map-pin.css
app.use(express.static(PUBLIC_DIR, staticOptions));

// map-module: mount เฉพาะ 5 เส้นทางนี้เท่านั้น (เหมือนเว็บหลักเป๊ะ)
app.use('/map-module/src', express.static(path.join(MAP_MODULE_DIR, 'src'), staticOptions));
app.use('/map-module/map-styles', express.static(path.join(MAP_MODULE_DIR, 'map-styles'), staticOptions));
app.use('/map-module/blips', express.static(path.join(MAP_MODULE_DIR, 'blips'), staticOptions));
app.use('/map-module/Challenge/src', express.static(path.join(MAP_MODULE_DIR, 'Challenge', 'src'), staticOptions));
app.use('/map-module/overlay/src', express.static(path.join(MAP_MODULE_DIR, 'overlay', 'src'), staticOptions));

// ==================== PAGE ROUTES ====================
// หน้าแผนที่ของเว็บนี้ (ปุ่มรหัส 4 หลัก) — ไม่ใช่ map-module/public/map.html
app.get('/MapVesperPD', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'map.html'));
});

// เกมทายตำแหน่ง — ใช้ของ map-module ตรงๆ (ไม่เกี่ยวกับสิทธิ์แก้ไข)
app.get('/Challenge', (req, res) => {
    res.sendFile(path.join(MAP_MODULE_DIR, 'Challenge', 'game.html'));
});

// หน้าแรก → แผนที่ (Render healthCheckPath ชี้มาที่ / ต้องได้ 200/3xx)
app.get('/', (req, res) => res.redirect('/MapVesperPD'));

// ==================== ERROR HANDLER (must be last) ====================
app.use((err, req, res, next) => {
    logger.error(`${req.method} ${req.path} - ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// ==================== START SERVER ====================
// ข้าม listen บน Vercel (serverless ใช้ api/index.js แทน — ดู vercel.json)
// ตรวจด้วย VERCEL=1 ที่ Vercel เติมให้อัตโนมัติทุก deploy
if (!process.env.VERCEL) {
    app.listen(config.PORT, () => {
    logger.info(`Server running at http://localhost:${config.PORT}`);
    logger.info(`Map: /MapVesperPD   Game: /Challenge   API: /api/poi`);
    logger.info(`Sheets: ${config.MAP_SHEET_ID ? 'Google Sheets (' + config.MAP_SHEET_ID.slice(0, 8) + '…)' : 'fallback → data/poi-cache.json'}`);
    logger.info(`Credentials: ${process.env.GOOGLE_JSON_KEY ? 'GOOGLE_JSON_KEY (.env)' : 'NOT SET'}`);
    logger.info(`แก้ไขแผนที่: ${config.ADMIN_PIN ? 'ต้องใส่รหัส ' + config.ADMIN_PIN.length + ' หลัก' : '⚠️ ยังไม่ได้ตั้ง ADMIN_PIN'}`);

    // สำรองชีตลงไฟล์ (อ่านอย่างเดียว ไม่เขียนกลับ) — ตาข่ายรองรับเผื่อข้อมูลหาย
    // บน Vercel ข้าม (filesystem เขียนไม่ได้)
    if (!process.env.VERCEL) poiBackup.run(getSheets);
    });
} // if (!process.env.VERCEL)

module.exports = app; // ให้ api/index.js (Vercel) import ได้ ไม่ต้องแยกไฟล์
