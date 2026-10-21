/* ========================================
   MHNK Map - PIN Auth Manager
   ปลดล็อกการแก้ไขแผนที่ด้วยรหัส 4 หลัก

   ⚠️ ต้องใช้ชื่อ global ว่า VESPD_DC เพราะ map-module/src/map-poi.js
      เรียก VESPD_DC.canAdd() / canEdit() / isConnected() / getDcId() /
      setAuthorizedIds() อยู่ — และเราไม่แก้ไฟล์ใน map-module
   ======================================== */

const VESPD_DC = {
  _unlocked: false,
  _onStatusChange: null,
  _busy: false,

  // ───────── ที่ map.html เรียก ─────────
  init(onStatusChange) {
    this._onStatusChange = onStatusChange;
    this._buildModal();
    this._bindEvents();
    this._refresh();
  },

  // ───────── ที่ map-poi.js เรียก ─────────
  canAdd() { return this._unlocked; },
  canEdit() { return this._unlocked; },
  isConnected() { return this._unlocked; },
  getDcId() { return null; },
  getDcName() { return null; },
  /** ระบบเดิมใช้เช็ค ID จากคอลัมน์ J — ระบบรหัสไม่ใช้แล้ว แต่ต้องมีไว้ไม่ให้ error */
  setAuthorizedIds() {},
  disconnect() { this.lock(); },

  // ───────── สถานะ ─────────
  async _refresh() {
    try {
      const res = await fetch('/api/auth/pin', { credentials: 'same-origin' });
      const data = await res.json();
      this._setState(!!(data && data.unlocked));
    } catch (e) {
      this._setState(false);
    }
  },

  _setState(unlocked) {
    this._unlocked = unlocked;
    this._render();
    if (this._onStatusChange) this._onStatusChange(unlocked, null, null);
  },

  async unlock(pin) {
    if (this._busy) return false;
    this._busy = true;
    try {
      const res = await fetch('/api/auth/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin: pin })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this._setState(true);
        return true;
      }
      this._error((data && data.error) || 'รหัสไม่ถูกต้อง');
      return false;
    } catch (e) {
      this._error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
      return false;
    } finally {
      this._busy = false;
    }
  },

  async lock() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) { /* ไม่เป็นไร */ }
    this._setState(false);
  },

  // ───────── UI ─────────
  _render() {
    const btn = document.getElementById('mhnk-pin-btn');
    const info = document.getElementById('mhnk-pin-info');
    if (btn) btn.style.display = this._unlocked ? 'none' : 'flex';
    if (info) info.style.display = this._unlocked ? 'flex' : 'none';
  },

  _buildModal() {
    if (document.getElementById('mhnk-pin-overlay')) return;
    const el = document.createElement('div');
    el.className = 'mhnk-pin-overlay';
    el.id = 'mhnk-pin-overlay';
    el.innerHTML = [
      '<div class="mhnk-pin-modal" id="mhnk-pin-modal">',
        '<div class="mhnk-pin-modal-head">',
          '<span class="mhnk-pin-modal-ico">&#128274;</span>',
          '<h3>UNLOCK <span>// ใส่รหัสเพื่อแก้ไขแผนที่</span></h3>',
          '<button type="button" class="mhnk-pin-close" id="mhnk-pin-cancel">&times;</button>',
        '</div>',
        '<div class="mhnk-pin-modal-body">',
          '<input type="password" class="mhnk-pin-code" id="mhnk-pin-code" inputmode="numeric" ',
                 'maxlength="4" autocomplete="off" placeholder="&bull;&bull;&bull;&bull;">',
          '<div class="mhnk-pin-msg" id="mhnk-pin-msg"></div>',
        '</div>',
        '<div class="mhnk-pin-modal-foot">',
          '<button type="button" class="mhnk-pin-cta" id="mhnk-pin-submit">✓ ปลดล็อก</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);
  },

  _input() { return document.getElementById('mhnk-pin-code'); },

  _value() {
    const i = this._input();
    return i ? i.value : '';
  },

  _clear(focus) {
    const i = this._input();
    if (!i) return;
    i.value = '';
    if (focus) i.focus();
  },

  _error(msg) {
    const m = document.getElementById('mhnk-pin-msg');
    const modal = document.getElementById('mhnk-pin-modal');
    if (m) { m.textContent = '✕ ' + msg; m.classList.add('show'); }
    if (modal) {
      modal.classList.remove('shake');
      void modal.offsetWidth;
      modal.classList.add('shake');
    }
    this._clear(true);
  },

  open() {
    const ov = document.getElementById('mhnk-pin-overlay');
    const m = document.getElementById('mhnk-pin-msg');
    if (!ov) return;
    if (m) { m.textContent = ''; m.classList.remove('show'); }
    ov.classList.add('show');
    this._clear(false);
    const self = this;
    setTimeout(function () { const i = self._input(); if (i) i.focus(); }, 60);
  },

  close() {
    const ov = document.getElementById('mhnk-pin-overlay');
    if (ov) ov.classList.remove('show');
  },

  async _submit() {
    if (this._busy) return;
    const pin = this._value();
    if (pin.length < 4) { this._error('กรอกให้ครบ 4 หลัก'); return; }
    const ok = await this.unlock(pin);
    if (ok) { this._clear(false); this.close(); }
  },

  _bindEvents() {
    const self = this;

    const openBtn = document.getElementById('mhnk-pin-btn');
    if (openBtn) openBtn.addEventListener('click', function () { self.open(); });

    const lockBtn = document.getElementById('mhnk-pin-lock');
    if (lockBtn) lockBtn.addEventListener('click', function () { self.lock(); });

    const cancel = document.getElementById('mhnk-pin-cancel');
    if (cancel) cancel.addEventListener('click', function () { self.close(); });

    const submit = document.getElementById('mhnk-pin-submit');
    if (submit) submit.addEventListener('click', function () { self._submit(); });

    const ov = document.getElementById('mhnk-pin-overlay');
    if (ov) ov.addEventListener('click', function (e) { if (e.target === ov) self.close(); });

    const input = this._input();
    if (input) {
      // กรองให้เหลือแต่ตัวเลข แล้วยิงอัตโนมัติเมื่อครบ 4 หลัก
      input.addEventListener('input', function () {
        const cleaned = (input.value || '').replace(/\D/g, '').slice(0, 4);
        if (cleaned !== input.value) input.value = cleaned;
        if (cleaned.length === 4) self._submit();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); self._submit(); }
      });
    }

    document.addEventListener('keydown', function (e) {
      const isOpen = ov && ov.classList.contains('show');
      if (isOpen && e.key === 'Escape') self.close();
    });
  }
};

if (typeof window !== 'undefined') { window.VESPD_DC = VESPD_DC; }
