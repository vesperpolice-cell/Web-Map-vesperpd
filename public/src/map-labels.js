/* ========================================
   MHNK Map - Always-On Labels
   ปุ่ม [ เปิด / ปิด ] ใต้ MAP LAYER — โชว์ชื่อหมุดทุกจุดค้างไว้ ไม่ต้องเอาเมาส์ไปชี้

   ⚠️ ห้ามแก้ไฟล์ใน map-module — ไฟล์นี้จึงครอบ VESPD_MAP.addPoi จากข้างนอกแทน

   map-core.js ผูก tooltip ไว้ที่ event mouseover/mouseout ของ marker แต่ละตัว
   (ชี้ = bindTooltip, เอาเมาส์ออก = unbindTooltip)
   ถ้าไม่ถอด 2 event นี้ออกก่อน พอเอาเมาส์ออกจากหมุด ป้ายถาวรจะโดนลบทิ้งไปด้วย
   ======================================== */

const VESPD_LABELS = {
  enabled: false,
  _wrapped: false,
  STORE_KEY: 'mhnk_map_labels',

  /** เรียกหลัง VESPD_MAP.init() และก่อน VESPD_POI.init() */
  init() {
    this._wrapAddPoi();
    var saved = false;
    try { saved = localStorage.getItem(this.STORE_KEY) === '1'; } catch (e) { /* โหมดส่วนตัว/ปิดคุกกี้ */ }
    this.set(saved);
  },

  toggle() { this.set(!this.enabled); },

  set(on) {
    this.enabled = !!on;
    try { localStorage.setItem(this.STORE_KEY, this.enabled ? '1' : '0'); } catch (e) { /* ไม่ซีเรียส */ }
    this._applyAll();
    this._syncBtn();
  },

  // ───────── ภายใน ─────────

  _markers() {
    return (typeof VESPD_MAP !== 'undefined' && Array.isArray(VESPD_MAP.markers)) ? VESPD_MAP.markers : [];
  },

  _name(marker) {
    return (marker._poiData && marker._poiData.name) || 'ไม่มีชื่อ';
  },

  _applyAll() {
    var self = this;
    this._markers().forEach(function (m) { self._apply(m); });
  },

  _apply(marker) {
    if (!marker) return;
    // ล้างของเดิมก่อนเสมอ (ทั้ง event และ tooltip) แล้วค่อยติดตั้งโหมดใหม่
    marker.off('mouseover').off('mouseout');
    marker.unbindTooltip();

    if (this.enabled) {
      marker.bindTooltip(this._name(marker), {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'mhnk-poi-tooltip mhnk-poi-label'
      });
      // ป้ายทับกันเยอะ → ชี้ที่หมุดแล้วดันป้ายของหมุดนั้นขึ้นมาอยู่บนสุด
      marker.on('mouseover', function () { VESPD_LABELS._raise(marker, true); });
      marker.on('mouseout', function () { VESPD_LABELS._raise(marker, false); });
      return;
    }

    // ปิด → คืนพฤติกรรมเดิมของ map-core.js (ชี้แล้วค่อยโผล่)
    var self = this;
    marker.on('mouseover', function () {
      marker.bindTooltip(self._name(marker), {
        direction: 'top',
        offset: [0, -10],
        className: 'mhnk-poi-tooltip'
      }).openTooltip();
    });
    marker.on('mouseout', function () { marker.unbindTooltip(); });
  },

  /** ดัน/ลด ลำดับชั้นของป้ายหมุดหนึ่งใบ (ใช้ตอนป้ายทับกัน) */
  _raise(marker, on) {
    var tip = marker.getTooltip && marker.getTooltip();
    var el = tip && tip.getElement && tip.getElement();
    if (!el) return;
    el.classList.toggle('mhnk-poi-label-top', !!on);
  },

  /** ครอบ addPoi เพื่อให้หมุดที่โหลดทีหลัง (หรือเพิ่งปักใหม่) ได้ป้ายด้วย */
  _wrapAddPoi() {
    if (this._wrapped || typeof VESPD_MAP === 'undefined') return;
    var self = this;
    var orig = VESPD_MAP.addPoi;
    VESPD_MAP.addPoi = function (poi) {
      var marker = orig.call(this, poi);
      if (marker && self.enabled) self._apply(marker);
      return marker;
    };
    this._wrapped = true;
  },

  _syncBtn() {
    var btn = document.getElementById('mhnk-label-btn');
    if (!btn) return;
    btn.classList.toggle('active', this.enabled);
    btn.textContent = this.enabled ? '◉ ชื่อหมุด : เปิด' : '◎ ชื่อหมุด : ปิด';
    btn.setAttribute('aria-pressed', this.enabled ? 'true' : 'false');
  }
};
