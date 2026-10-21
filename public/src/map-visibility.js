/* ========================================
   MHNK Map - สวิตช์ซ่อนจุดทั้งแผนที่ (โหมดสอบ)

   ปุ่มนั่งแทนที่โลโก้ในแถบขวา ซ้ายมือของปุ่มใส่รหัส
   ล็อกอยู่ = เห็นโลโก้ / ใส่รหัสแล้ว = โลโก้กลายเป็นปุ่มนี้

   การซ่อนจริงทำที่ server (server/poi-visibility.js) — /api/poi คืน []
   คนที่ใส่รหัสแล้วยังเห็นจุดครบตามเดิม จะได้คุมสอบไปแก้แผนที่ไปได้

   ── คนที่เปิดหน้าค้างไว้ก่อนแอดมินกดปิด ──
   ข้อมูลอยู่ในหน่วยความจำเบราว์เซอร์แล้ว แพน/ซูม/สลับ style ก็ไม่โหลดใหม่
   ถ้าไม่ทำอะไรเลยเขาจะเห็นแผนที่ครบทั้งคาบสอบ
   ตัวเฝ้า (_watch) เลยถาม /api/poi/visibility ทุก 60 วิ — endpoint นี้หนักแค่ ~30 bytes
   ไม่ใช่ /api/poi ที่หนัก 83 KB

   ถามเพิ่มตอนสลับกลับมาที่แท็บด้วย (เห็นผลทันทีไม่ต้องรอครบ 60 วิ)
   แต่พึ่ง event นี้อย่างเดียวไม่ได้ เพราะคนเปิด 2-3 จอ หรือวางมือถือไว้ข้าง ๆ
   แท็บจะ "มองเห็น" ตลอด event ไม่ยิงสักครั้ง — timer จึงเป็นตาข่ายหลัก

   ถามไม่สำเร็จ (เน็ตหลุด) = ถือว่าปิดไว้ก่อน และซ่อนแบบไม่ง้อเน็ต

   ⚠️ ตอนซ่อน/แสดงใช้ทางเดียวกับที่โมดูลใช้เองเสมอ (clearPois / loadPois)
      ห้ามไปยุ่ง marker รายตัวหรือ tooltip เอง เพราะ VESPD_LABELS ครอบ
      VESPD_MAP.addPoi กับ event mouseover/mouseout ไว้ — แตะเองแล้วป้ายชื่อหมุดเพี้ยน
   ======================================== */

const VESPD_VIS = {
  hidden: false,
  _busy: false,

  POLL_MS: 60000,     // ตาข่ายหลัก
  EVENT_GAP_MS: 5000, // กันถามรัวตอนสลับแท็บไปมาเร็ว ๆ
  _timer: null,
  _lastCheck: 0,
  _restoring: false,  // กันสั่ง loadPois ซ้อนกันตอนกำลังดึงข้อมูลกลับ
  _onWake: null,

  ICON_ON: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>'
    + '</svg>',

  ICON_OFF: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">'
    + '<path d="M2.1 3.5 3.5 2.1l18.4 18.4-1.4 1.4-3.2-3.2A11 11 0 0 1 12 19C7 19 3 14.5 2 12c.6-1.4 2-3.5 4.2-5.1L2.1 3.5Zm5.6 5.6A4 4 0 0 0 12 16c.7 0 1.4-.2 2-.5l-1.5-1.5a2 2 0 0 1-2.5-2.5L7.7 9.1ZM12 5c5 0 9 4.5 10 7-.5 1.2-1.6 2.9-3.3 4.3l-2.8-2.8A4 4 0 0 0 10.5 8l-2-2c1.1-.6 2.3-1 3.5-1Z"/>'
    + '</svg>',

  /** เรียกครั้งเดียวหลัง DOM พร้อม */
  init() {
    var self = this;
    var btn = this._btn();
    if (btn) btn.addEventListener('click', function () { self.toggle(); });
  },

  /** VESPD_DC เรียกทุกครั้งที่สถานะรหัสเปลี่ยน */
  setUnlocked(on) {
    var unlocked = !!on;
    var logo = document.getElementById('mhnk-sidebar-badge');
    var btn = this._btn();
    if (logo) logo.style.display = unlocked ? 'none' : 'flex';
    if (btn) btn.style.display = unlocked ? 'flex' : 'none';

    if (unlocked) {
      // แอดมินเห็นจุดครบเสมอไม่ว่าสวิตช์จะปิดอยู่หรือเปล่า ไม่ต้องเฝ้า
      this._stopWatch();
      this._load();
    } else {
      this._startWatch();
    }
  },

  async toggle() {
    if (this._busy) return;
    this._busy = true;
    this._render();
    try {
      var res = await fetch('/api/poi/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ hidden: !this.hidden })
      });
      var data = await res.json();
      if (res.ok && data.success) this.hidden = !!data.hidden;
    } catch (e) {
      console.error('[MHNK-VIS] สลับสถานะไม่สำเร็จ:', e);
    } finally {
      this._busy = false;
      this._render();
    }
  },

  // ───────── ตัวเฝ้า (เฉพาะคนที่ยังไม่ใส่รหัส) ─────────

  _startWatch() {
    if (this._timer) return;
    var self = this;

    this._onWake = function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - self._lastCheck < self.EVENT_GAP_MS) return;
      self._check();
    };
    document.addEventListener('visibilitychange', this._onWake);
    window.addEventListener('focus', this._onWake);

    this._timer = setInterval(function () { self._check(); }, this.POLL_MS);
  },

  _stopWatch() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._onWake) {
      document.removeEventListener('visibilitychange', this._onWake);
      window.removeEventListener('focus', this._onWake);
      this._onWake = null;
    }
  },

  async _check() {
    this._lastCheck = Date.now();
    var hidden;
    try {
      var res = await fetch('/api/poi/visibility', { cache: 'no-store', credentials: 'same-origin' });
      var data = await res.json();
      hidden = !!(data && data.hidden);
    } catch (e) {
      hidden = true;   // ถามไม่ได้ = ปิดไว้ก่อน
    }
    this._applyToPage(hidden);
  },

  _hasPois() {
    return !!(typeof VESPD_POI !== 'undefined' && VESPD_POI.pois && VESPD_POI.pois.length);
  },

  /** ปรับหน้าเว็บให้ตรงกับสวิตช์
   *
   *  เทียบกับ "สิ่งที่หน้าเว็บมีอยู่จริง" ไม่ใช่สถานะที่จำไว้
   *  เพราะตอน setUnlocked ถูกเรียกครั้งแรก loadPois ยังโหลดไม่เสร็จ
   *  ถ้าไปจำสถานะตั้งต้นตอนนั้นจะได้ค่าผิดแล้วสั่งโหลดซ้ำฟรี ๆ ในรอบถัดไป
   */
  _applyToPage(hidden) {
    if (typeof VESPD_POI === 'undefined' || typeof VESPD_MAP === 'undefined') return;
    var showing = this._hasPois();

    if (hidden && showing) {
      // ล้างแบบไม่ง้อเน็ต (เน็ตหลุดก็ยังซ่อนได้) — ใช้ทางเดียวกับที่ loadPois ใช้
      VESPD_POI.pois = [];
      VESPD_MAP.clearPois();
      VESPD_POI._renderPoiList();
      VESPD_POI._updateStats();
      return;
    }

    // เปิดกลับ → ต้องไปเอาข้อมูลมาใหม่ เพราะตอนปิด server ไม่ได้ส่งอะไรมาเลย
    if (!hidden && !showing && !this._restoring) {
      this._restoring = true;
      var self = this;
      Promise.resolve(VESPD_POI.loadPois()).catch(function () {})
        .then(function () { self._restoring = false; });
    }
  },

  // ───────── ภายใน ─────────

  _btn() { return document.getElementById('mhnk-vis-btn'); },

  async _load() {
    try {
      var res = await fetch('/api/poi/visibility', { credentials: 'same-origin' });
      var data = await res.json();
      this.hidden = !!(data && data.hidden);
    } catch (e) {
      console.error('[MHNK-VIS] อ่านสถานะไม่ได้:', e);
    }
    this._render();
  },

  _render() {
    var btn = this._btn();
    if (!btn) return;
    btn.innerHTML = this.hidden ? this.ICON_OFF : this.ICON_ON;
    btn.classList.toggle('is-hidden', this.hidden);
    btn.disabled = this._busy;
    btn.title = this.hidden
      ? 'จุดถูกซ่อนจากคนทั่วไปอยู่ — กดเพื่อเปิดให้เห็น'
      : 'คนทั่วไปเห็นจุดอยู่ — กดเพื่อซ่อนทั้งหมด';
    btn.setAttribute('aria-pressed', this.hidden ? 'true' : 'false');
  }
};

if (typeof window !== 'undefined') { window.VESPD_VIS = VESPD_VIS; }
