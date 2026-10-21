/* ========================================
   PIN Auth — ปลดล็อกการแก้ไขแผนที่ด้วยรหัส 4 หลัก
   แทนที่ระบบ Discord OAuth เดิม

   - เก็บ session ในหน่วยความจำ (รีสตาร์ท server = ทุกคนต้องใส่รหัสใหม่)
   - ส่ง token ผ่าน cookie แบบ HttpOnly → เบราว์เซอร์แนบให้เองทุก request
     ทำให้ไม่ต้องไปแก้โค้ด fetch ใน map-module/src/map-poi.js
   ======================================== */

const crypto = require('crypto');
const config = require('./config');
const { createLogger } = require('./utils/logger');

const logger = createLogger('PinAuth');

const COOKIE_NAME = 'map_auth';
const TTL_MS = 8 * 60 * 60 * 1000; // 8 ชั่วโมง

// fallback session ในหน่วยความจำ (Vercel ใช้ HMAC ด้านล่างเป็นหลัก)
const sessions = new Map();

function signingKey() {
    const pin = String(config.ADMIN_PIN || '');
    const salt = process.env.PIN_TOKEN_SALT || 'vesperpd-map-pin';
    return crypto.createHash('sha256').update(salt + ':' + pin, 'utf8').digest();
}

function b64uEncode(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
    const pad = (4 - (str.length % 4)) % 4;
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    return Buffer.from(b64, 'base64');
}

function sweep() {
    const now = Date.now();
    for (const [token, exp] of sessions) {
        if (now > exp) sessions.delete(token);
    }
}

function issue() {
    sweep();
    const exp = Date.now() + TTL_MS;
    const payload = Buffer.from(String(exp), 'utf8');
    const sig = crypto.createHmac('sha256', signingKey()).update(payload).digest();
    const token = `${b64uEncode(payload)}.${b64uEncode(sig)}`;
    sessions.set(token, exp);
    return token;
}

function isValid(token) {
    if (!token) return false;
    try {
        const parts = String(token).split('.');
        if (parts.length === 2) {
            const payload = b64uDecode(parts[0]);
            const sig = b64uDecode(parts[1]);
            const expect = crypto.createHmac('sha256', signingKey()).update(payload).digest();
            if (sig.length === expect.length && crypto.timingSafeEqual(sig, expect)) {
                const exp = parseInt(payload.toString('utf8'), 10);
                if (Number.isFinite(exp) && Date.now() < exp) return true;
            }
        }
    } catch (e) { /* fallback ข้างล่าง */ }
    const exp = sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function revoke(token) {
    if (token) sessions.delete(token);
}

/** อ่าน cookie โดยไม่ต้องพึ่ง cookie-parser */
function readCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch (e) {
            return null;
        }
    }
    return null;
}

/** เทียบรหัสแบบ timing-safe (กันเดาจากเวลาตอบสนอง) */
function pinMatches(input) {
    const expected = String(config.ADMIN_PIN || '');
    const got = String(input == null ? '' : input);
    if (!expected) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function isHttps(req) {
    return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req, res, token) {
    const bits = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(TTL_MS / 1000)}`
    ];
    if (isHttps(req)) bits.push('Secure');
    res.setHeader('Set-Cookie', bits.join('; '));
}

function clearCookie(req, res) {
    const bits = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isHttps(req)) bits.push('Secure');
    res.setHeader('Set-Cookie', bits.join('; '));
}

function isUnlocked(req) {
    return isValid(readCookie(req, COOKIE_NAME));
}

/**
 * Middleware กัน POST/PUT/DELETE บน /api/poi
 * (อ่าน GET ปล่อยผ่าน — ใครก็ดูแผนที่ได้)
 */
function requirePin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (isUnlocked(req)) return next();
    logger.warn(`ปฏิเสธ ${req.method} ${req.originalUrl} — ยังไม่ได้ใส่รหัส`);
    return res.status(401).json({ success: false, error: 'ต้องใส่รหัส 4 หลักก่อนแก้ไขแผนที่' });
}

/** ติดตั้ง route /api/auth/* */
function mountRoutes(app, limiter) {
    // สถานะปัจจุบัน — ใช้ตอนโหลดหน้าเพื่อกู้สถานะกลับมา
    app.get('/api/auth/pin', (req, res) => {
        res.json({ success: true, unlocked: isUnlocked(req) });
    });

    // ส่งรหัสมาปลดล็อก
    app.post('/api/auth/pin', limiter, (req, res) => {
        const pin = req.body && req.body.pin;
        if (!config.ADMIN_PIN) {
            return res.status(500).json({ success: false, error: 'ยังไม่ได้ตั้ง ADMIN_PIN ใน .env' });
        }
        if (!pinMatches(pin)) {
            logger.warn('ใส่รหัสผิด');
            return res.status(401).json({ success: false, error: 'รหัสไม่ถูกต้อง' });
        }
        setCookie(req, res, issue());
        logger.info('ปลดล็อกสำเร็จ');
        res.json({ success: true, unlocked: true });
    });

    // ล็อกกลับ
    app.post('/api/auth/logout', (req, res) => {
        revoke(readCookie(req, COOKIE_NAME));
        clearCookie(req, res);
        res.json({ success: true, unlocked: false });
    });
}

module.exports = { requirePin, mountRoutes, isUnlocked };
