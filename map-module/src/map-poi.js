/* ========================================
   VES-PD Map Module - POI Manager
   จัดการจุดแจ้ง (CRUD + UI)
   หมวดหมู่อ่านจากไฟล์ PNG ใน blips/custom/ อัตโนมัติ
   ======================================== */

/** Escape HTML เพื่อป้องกัน XSS จากชื่อ/รายละเอียดจุด */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VESPD_POI = {
  pois: [],
  _modalVisible: false,
  _selectedCoords: null,
  _searchQuery: '',
  _filterCategory: 'all',
  _started: false,
  _suppressClicksUntil: 0,
  _submitting: false,
  _openMenu: null,        // เมนู dropdown หมวดหมู่ที่เปิดอยู่
  _openSelectBtn: null,   // ปุ่มที่เปิดเมนูนั้น
  _ignoreScrollUntil: 0,  // กัน scroll ที่เกิดจากการเปิดเมนูเอง

  async init() {
    if (this._started) return; // ป้องกัน init ซ้ำ (จาก event + timeout fallback)
    this._started = true;
    this._bindEvents();
    if (typeof loadCategories === 'function') {
      await loadCategories();
    }
    this._renderCategoryFilter();
    this.loadPois();
  },

  _bindEvents() {
    document.addEventListener('vesperpd-map-click', (e) => {

      // ตรวจสอบว่าสามารถเพิ่มจุดได้ (login + มี ID ในคอลัมน์ J)
      if (typeof VESPD_DC !== 'undefined' && !VESPD_DC.canAdd()) {
        return;
      }

      if (this._modalVisible) return;
      // ข้ามการเปิด modal ใหม่ทันทีหลังปิด (กันการคลิกนอกกรอบแล้วเด้งกลับ)
      if (Date.now() < this._suppressClicksUntil) return;
      this._selectedCoords = e.detail;
      this._showAddForm(e.detail.x, e.detail.y);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;

      // dropdown หมวดหมู่เปิดอยู่ → Esc = เคลียร์คำค้นก่อน (ถ้ามี) แล้วค่อยปิด ไม่ปิด modal
      if (this._openMenu) {
        const search = this._openMenu.querySelector('.mhnk-cat-menu-search');
        if (search && search.value) {
          search.value = '';
          this._filterCatMenu('');
          search.focus({ preventScroll: true });
          return;
        }
        this._closeCatMenu(true);
        return;
      }

      this._hideModal();
    });

    const searchInput = document.getElementById('mhnk-poi-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._searchQuery = e.target.value;
        this._renderPoiList();
      });
    }

    // ตัวกรองหมวดหมู่ = dropdown ที่มีรูปในตัวเลือก (เดิมเป็น <select> ซึ่งใส่รูปใน <option> ไม่ได้)
    const filterBox = document.getElementById('mhnk-poi-filter');
    if (filterBox) {
      filterBox.addEventListener('change', (e) => {
        if (!e.target || e.target.type !== 'hidden') return;
        this._filterCategory = e.target.value || 'all';
        this._renderPoiList();
      });
    }

    // เปิด/ปิด dropdown หมวดหมู่ (ใช้ร่วมกันทั้งฟอร์มเพิ่มจุดและตัวกรอง)
    document.addEventListener('click', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;

      const trigger = e.target.closest('.mhnk-cat-select');
      if (trigger) {
        e.preventDefault();
        this._toggleCatMenu(trigger);
        return;
      }

      const option = e.target.closest('.mhnk-cat-menu-item');
      if (option) {
        e.preventDefault();
        this._pickCatOption(option);
        return;
      }

      // คลิกที่อื่น → ปิด dropdown
      if (this._openMenu && !e.target.closest('.mhnk-cat-menu')) this._closeCatMenu();
    });

    // คีย์บอร์ดใน dropdown: ↑ ↓ เลื่อน, Enter/Space เลือก, Tab ปิด
    document.addEventListener('keydown', (e) => {
      // ปุ่ม dropdown ที่โฟกัสอยู่ + กด ↑/↓ → เปิดเมนูแล้วเลื่อนไปตัวถัดไป/ก่อนหน้าเลย
      if (!this._openMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const el = document.activeElement;
        if (el && el.classList && el.classList.contains('mhnk-cat-select')) {
          e.preventDefault();
          this._openCatMenu(el);
          this._moveCatFocus(e.key === 'ArrowDown' ? 1 : -1);
        }
        return;
      }

      if (!this._openMenu) return;

      const inSearch = !!(e.target && e.target.classList && e.target.classList.contains('mhnk-cat-menu-search'));

      if (inSearch) {
        // พิมพ์ค้นหาได้ตามปกติ (รวม Space) — ↑↓ กระโดดไปในลิสต์, Enter เลือกตัวที่กรองไว้
        if (e.key === 'Tab') { this._closeCatMenu(true); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._moveCatFocus(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const hits = this._catMenuItems();
          if (!hits.length) return;
          const sel = hits.find(it => it.classList.contains('is-selected')) || hits[0];
          this._pickCatOption(sel);
        }
        return;
      }

      if (e.key === 'Tab') { this._closeCatMenu(); return; }

      const items = this._catMenuItems();
      if (items.length === 0) return;
      const cur = items.indexOf(document.activeElement);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._moveCatFocus(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if ((e.key === 'Enter' || e.key === ' ') && cur !== -1) {
        e.preventDefault();
        this._pickCatOption(items[cur]);
      }
    });

    // เลื่อนหน้า/ย่อขยายจอ → ปิด dropdown (ตำแหน่ง fixed จะเพี้ยน)
    // แต่ scroll ที่เกิด "ในเมนูเอง" (ล้อเมาส์/ลากแถบเลื่อนดูทุกหมวด) ต้องไม่ปิดเมนู
    window.addEventListener('resize', () => this._closeCatMenu());
    document.addEventListener('scroll', (e) => {
      if (Date.now() < this._ignoreScrollUntil) return;
      const t = e.target;
      if (t && t.nodeType === 1 && typeof t.closest === 'function' && t.closest('.mhnk-cat-menu')) return;
      this._closeCatMenu();
    }, true);
  },

  async loadPois() {
    // แสดงสถานะกำลังโหลด
    const container = document.getElementById('mhnk-poi-list');
    if (container) container.innerHTML = '<div class="mhnk-empty">⏳ กำลังโหลด...</div>';
    try {
      const res = await fetch('/api/poi');
      const data = await res.json();
      if (data.success) {
        this.pois = data.data;
        VESPD_MAP.clearPois();
        this.pois.forEach(poi => VESPD_MAP.addPoi(poi));

        // อัปเดตรายการ ID ที่มีในคอลัมน์ J สำหรับตรวจสอบสิทธิ์
        if (typeof VESPD_DC !== 'undefined') {
          var authorizedIds = this.pois
            .map(function(poi) { return poi.dcId; })
            .filter(function(id) { return id && String(id).trim() !== ''; });
          VESPD_DC.setAuthorizedIds(authorizedIds);
        }

        this._renderPoiList();
        this._updateStats();
      } else {
        if (container) container.innerHTML = '<div class="mhnk-empty">⚠️ โหลดข้อมูลไม่สำเร็จ</div>';
      }
    } catch (err) {
      console.error('[VES-PD-POI] Load failed:', err);
      if (container) container.innerHTML = '<div class="mhnk-empty">⚠️ เกิดข้อผิดพลาดในการโหลด</div>';
    }
  },

  async addPoi(poiData) {
    try {
      const res = await fetch('/api/poi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(poiData)
      });
      const data = await res.json();
      if (data.success) {
        await this.loadPois();
        return true;
      } else {
        alert('❌ ' + (data.error || 'ไม่สามารถเพิ่มจุดได้'));
        return false;
      }
    } catch (err) {
      console.error('[VES-PD-POI] Add failed:', err);
      alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
      return false;
    }
  },

  async deletePoi(id) {
    if (!confirm('🗑️ ยืนยันการลบจุดนี้?')) return;
    try {
      const res = await fetch(`/api/poi/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        await this.loadPois();
      } else {
        alert('❌ ' + (data.error || 'ไม่สามารถลบจุดได้'));
      }
    } catch (err) {
      console.error('[VES-PD-POI] Delete failed:', err);
      alert('❌ เกิดข้อผิดพลาด');
    }
  },

  /** เปิด modal แก้ไขชื่อ/รายละเอียดของจุด */
  _editPoiName(id) {
    const poi = this.pois.find(p => String(p.id) === String(id));
    if (!poi) return;

    const overlay = document.getElementById('mhnk-modal-overlay');
    const body = document.getElementById('mhnk-modal-body');
    if (!overlay || !body) return;

    this._editingPoiId = id;
    this._modalVisible = true;
    overlay.classList.add('show');

    body.innerHTML = `
      <div class="mhnk-modal">
        <div class="mhnk-modal-header">
          <div class="mhnk-modal-header-icon">✎</div>
          <h3>EDIT NAME <span>// แก้ไขชื่อจุด</span></h3>
          <button class="mhnk-modal-close" onclick="VESPD_POI._hideModal()">&times;</button>
        </div>
        <div class="mhnk-modal-content">
          <div class="mhnk-form-group">
            <label for="mhnk-edit-name">ชื่อสถานที่ <span class="required">*</span></label>
            <input type="text" id="mhnk-edit-name" value="${escapeHtml(poi.name || '')}" placeholder="กรอกชื่อใหม่...">
          </div>
          <div class="mhnk-form-group">
            <label for="mhnk-edit-desc">รายละเอียด</label>
            <textarea id="mhnk-edit-desc" rows="3" placeholder="รายละเอียดเพิ่มเติม...">${escapeHtml(poi.description || '')}</textarea>
          </div>
        </div>
        <div class="mhnk-modal-footer">
          <button class="mhnk-btn mhnk-btn-ghost" onclick="VESPD_POI._hideModal()">✕ CANCEL</button>
          <button id="mhnk-edit-submit-btn" class="mhnk-btn mhnk-btn-primary" onclick="VESPD_POI._savePoiName()">✓ SAVE</button>
        </div>
      </div>
    `;

    setTimeout(() => document.getElementById('mhnk-edit-name')?.focus(), 100);
  },

  /** บันทึกชื่อ/รายละเอียดที่แก้ไข */
  async _savePoiName() {
    if (this._submitting) return;
    const id = this._editingPoiId;
    if (!id) return;

    this._submitting = true;
    const submitBtn = document.getElementById('mhnk-edit-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '⏳ กำลังบันทึก...'; }

    const name = document.getElementById('mhnk-edit-name')?.value?.trim();
    const description = document.getElementById('mhnk-edit-desc')?.value?.trim();

    if (!name) {
      alert('⚠️ กรุณากรอกชื่อ');
      document.getElementById('mhnk-edit-name')?.focus();
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '✓ SAVE'; }
      this._submitting = false;
      return;
    }

    try {
      const res = await fetch(`/api/poi/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });
      const data = await res.json();
      if (data.success) {
        await this.loadPois();
        this._hideModal();
        this._toast('✔ บันทึกชื่อแล้ว');
      } else {
        alert('❌ ' + (data.error || 'ไม่สามารถแก้ไขได้'));
      }
    } catch (err) {
      console.error('[VES-PD-POI] Edit failed:', err);
      alert('❌ เกิดข้อผิดพลาด');
    } finally {
      this._submitting = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '✓ SAVE'; }
    }
  },

  /**
   * Helper: ไอคอนหมวดหมู่ = รูปจริงจาก blips/custom/ (ขนาดเท่าไอคอนเดิมในฟอร์ม)
   * - ไม่มีไฟล์ไอคอน → จุดสีตามหมวด (ไม่ใช้ emoji แล้ว)
   * - รูปโหลดไม่ขึ้น → ซ่อนรูปแล้วโชว์จุดสีแทน ไม่ให้เห็นไอคอนแตก
   */
  _catIconHtml(cat) {
    const color = (cat && cat.color) || '#dc6d0b';
    if (cat && cat.file) {
      const file = escapeHtml(encodeURI(cat.file));
      return `<span class="mhnk-cat-ico" style="--mc:${color}"><img src="/map-module/blips/custom/${file}" alt="" loading="lazy" onerror="var w=this.parentElement;this.remove();if(w)w.classList.add('is-empty')"></span>`;
    }
    return `<span class="mhnk-cat-ico is-empty" style="--mc:${color}"></span>`;
  },

  /**
   * สร้าง dropdown หมวดหมู่ (custom select) — หน้าตาเหมือน <select> เดิม
   * แต่ใส่ "รูปจริงจาก blips/custom/" ในแต่ละตัวเลือกได้
   * @param {string} inputId id ของ <input type="hidden"> ที่เก็บค่าจริง (โค้ดเดิมอ่าน .value ได้เหมือนเดิม)
   * @param {Array}  items   [{ value, label, iconHtml }]
   * @param {string} selected ค่าที่เลือกอยู่
   * @param {string} ariaLabel ชื่อสำหรับ screen reader
   */
  _catSelectHtml(inputId, items, selected, ariaLabel) {
    const cur = items.find(it => it.value === selected) || items[0] || { value: '', label: '', iconHtml: '' };
    // ลิสต์ยาว (เกิน 8 หมวด) → มีช่องค้นหาบนหัวเมนู (หมวดเยอะเลื่อนหาเองยาก)
    const withSearch = items.length > 8;

    const options = items.map(it => {
      const on = it.value === cur.value;
      return `
        <div class="mhnk-cat-menu-item${on ? ' is-selected' : ''}" role="option" tabindex="-1"
             aria-selected="${on ? 'true' : 'false'}" data-value="${escapeHtml(it.value)}">
          ${it.iconHtml || '<span class="mhnk-cat-ico"></span>'}
          <span class="mhnk-cat-menu-label">${escapeHtml(it.label)}</span>
          <span class="mhnk-cat-menu-check" aria-hidden="true">✓</span>
        </div>`;
    }).join('');

    const searchHtml = withSearch
      ? `
          <div class="mhnk-cat-menu-head">
            <input type="text" class="mhnk-cat-menu-search" placeholder="ค้นหาหมวดหมู่..."
                   autocomplete="off" spellcheck="false" aria-label="ค้นหาหมวดหมู่">
          </div>`
      : '';

    return `
      <div class="mhnk-cat-select-wrap">
        <input type="hidden" id="${inputId}" value="${escapeHtml(cur.value)}">
        <button type="button" class="mhnk-cat-select" data-cat-select="${inputId}"
                aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(ariaLabel || 'หมวดหมู่')}">
          ${cur.iconHtml || '<span class="mhnk-cat-ico"></span>'}
          <span class="mhnk-cat-select-label" title="${escapeHtml(cur.label)}">${escapeHtml(cur.label)}</span>
          <span class="mhnk-cat-select-caret" aria-hidden="true">▾</span>
        </button>
        <div class="mhnk-cat-menu" hidden>${searchHtml}
          <div class="mhnk-cat-menu-list" role="listbox" aria-label="${escapeHtml(ariaLabel || 'หมวดหมู่')}">${options}</div>
          <div class="mhnk-cat-menu-empty" hidden>ไม่พบหมวดหมู่ที่ค้นหา</div>
        </div>
      </div>`;
  },

  /** กดปุ่มซ้ำ = ปิด, กดปุ่มอื่น = เปิดเมนูนั้น */
  _toggleCatMenu(trigger) {
    if (this._openMenu && this._openSelectBtn === trigger) {
      this._closeCatMenu(true);
      return;
    }
    this._openCatMenu(trigger);
  },

  /** เปิดเมนูให้ "เลื่อนลงมา" ใต้ปุ่ม (ถ้าที่ไม่พอจะพลิกขึ้นบน) */
  _openCatMenu(trigger) {
    const wrap = trigger.closest('.mhnk-cat-select-wrap');
    const menu = wrap && wrap.querySelector('.mhnk-cat-menu');
    if (!menu) return;
    this._closeCatMenu();

    // ล้างคำค้น/ตัวเลือกที่ถูกซ่อนจากการเปิดครั้งก่อน ให้เห็นครบทุกหมวด
    this._resetCatMenuSearch(menu);

    // ย้ายเมนูไปต่อท้าย <body> เพื่อไม่ให้ overflow ของ sidebar/modal ตัดขอบ
    menu._mhnkHome = wrap;
    document.body.appendChild(menu);
    menu.hidden = false;
    menu.style.visibility = 'hidden'; // ซ่อนไว้ก่อน ระหว่างวัดขนาด

    const parts = this._catMenuParts(menu);

    const r = trigger.getBoundingClientRect();
    const menuH = menu.offsetHeight;
    const menuW = Math.max(menu.offsetWidth, r.width);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const openUp = menuH > spaceBelow && r.top > spaceBelow;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));

    menu.style.minWidth = Math.round(r.width) + 'px';
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(openUp ? r.top - menuH - 6 : r.bottom + 6) + 'px';
    menu.style.visibility = '';
    menu.classList.add('is-open');

    trigger.setAttribute('aria-expanded', 'true');
    this._openMenu = menu;
    this._openSelectBtn = trigger;
    this._ignoreScrollUntil = Date.now() + 250;

    // ผูกช่องค้นหา (ผูกครั้งเดียวต่อ node — เมนูถูกสร้างใหม่ทุกครั้งที่ re-render)
    if (parts.search && !parts.search._mhnkBound) {
      parts.search._mhnkBound = true;
      parts.search.addEventListener('input', () => this._filterCatMenu(parts.search.value));
    }

    // เลื่อนไปที่ตัวเลือกปัจจุบัน (แตะ scrollTop ของลิสต์เอง ไม่ใช้ scrollIntoView กันหน้าเว็บกระโดด)
    const list = parts.list;
    const sel = menu.querySelector('.mhnk-cat-menu-item.is-selected');
    if (list && sel) {
      const lr = list.getBoundingClientRect();
      const sr = sel.getBoundingClientRect();
      list.scrollTop = Math.max(0, list.scrollTop + (sr.top + sr.height / 2) - (lr.top + lr.height / 2));
    }

    // มีช่องค้นหา → โฟกัสให้พิมพ์ค้นหาได้ทันที (↑/↓ ใช้ต่อได้เลย)
    if (parts.search) parts.search.focus({ preventScroll: true });
  },

  /** ปิดเมนู + คืนเมนูกลับเข้า wrapper เดิม (เพื่อให้ re-render ล้างทิ้งได้ปกติ) */
  _closeCatMenu(restoreFocus) {
    const menu = this._openMenu;
    const btn = this._openSelectBtn;
    this._openMenu = null;
    this._openSelectBtn = null;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (menu) {
      menu.classList.remove('is-open');
      this._resetCatMenuSearch(menu);
      menu.hidden = true;
      menu.removeAttribute('style');
      if (menu._mhnkHome && menu._mhnkHome.isConnected) menu._mhnkHome.appendChild(menu);
      menu._mhnkHome = null;
    }
    if (restoreFocus && btn && btn.isConnected) btn.focus();
  },

  /** ดึงส่วนประกอบของเมนู (ลิสต์ที่เลื่อนได้ / ช่องค้นหา / ข้อความ "ไม่พบ") */
  _catMenuParts(menu) {
    return {
      list: menu.querySelector('.mhnk-cat-menu-list'),
      search: menu.querySelector('.mhnk-cat-menu-search'),
      empty: menu.querySelector('.mhnk-cat-menu-empty')
    };
  },

  /** เฉพาะตัวเลือกที่มองเห็นอยู่ (หลังกรองด้วยคำค้น) */
  _catMenuItems() {
    if (!this._openMenu) return [];
    return Array.prototype.slice.call(this._openMenu.querySelectorAll('.mhnk-cat-menu-item:not([hidden])'));
  },

  /**
   * เลื่อนโฟกัสไปตัวเลือกถัดไป/ก่อนหน้า (+1/-1)
   * - ถ้าโฟกัสยังไม่ใช่ตัวเลือก (อยู่ที่ปุ่มหรือช่องค้นหา) → เริ่มจากตัวที่เลือกอยู่ ±1
   *   (กด ↑/↓ ครั้งแรกจึงขยับทันที ไม่รู้สึกว่า "ลูกศรไม่ทำงาน")
   * - ใช้ preventScroll + เลื่อน scrollTop ของลิสต์เอง → หน้าเว็บไม่เลื่อน เมนูจึงไม่ถูกปิด
   */
  _moveCatFocus(dir) {
    const items = this._catMenuItems();
    if (items.length === 0) return;

    const cur = items.indexOf(document.activeElement);
    let next;
    if (cur === -1) {
      const selIdx = items.findIndex(el => el.classList.contains('is-selected'));
      next = selIdx === -1 ? (dir > 0 ? 0 : items.length - 1) : selIdx + dir;
    } else {
      next = cur + dir;
    }
    if (next < 0) next = 0;
    if (next > items.length - 1) next = items.length - 1;

    this._focusCatItem(items[next]);
  },

  /** โฟกัสตัวเลือก + เลื่อนเฉพาะลิสต์ให้เห็นตัวนั้น (ไม่แตะ scroll ของหน้าเว็บ) */
  _focusCatItem(item) {
    if (!item) return;
    item.focus({ preventScroll: true });

    const list = this._openMenu && this._openMenu.querySelector('.mhnk-cat-menu-list');
    if (!list) return;
    const lr = list.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    if (ir.top < lr.top) list.scrollTop -= (lr.top - ir.top) + 6;
    else if (ir.bottom > lr.bottom) list.scrollTop += (ir.bottom - lr.bottom) + 6;
  },

  /** ล้างคำค้น + แสดงตัวเลือกทั้งหมด (เรียกตอนเปิด/ปิดเมนู) */
  _resetCatMenuSearch(menu) {
    if (!menu) return;
    const parts = this._catMenuParts(menu);
    if (parts.search) parts.search.value = '';
    if (parts.empty) parts.empty.hidden = true;
    Array.prototype.forEach.call(menu.querySelectorAll('.mhnk-cat-menu-item'), el => { el.hidden = false; });
    if (parts.list) parts.list.scrollTop = 0;
  },

  /** กรองตัวเลือกตามคำค้น (ตรงกับชื่อหมวดหรือ id ก็ได้) */
  _filterCatMenu(query) {
    const menu = this._openMenu;
    if (!menu) return;
    const parts = this._catMenuParts(menu);
    const q = String(query || '').trim().toLowerCase();

    let shown = 0;
    Array.prototype.forEach.call(menu.querySelectorAll('.mhnk-cat-menu-item'), el => {
      const labelEl = el.querySelector('.mhnk-cat-menu-label');
      const label = (labelEl ? labelEl.textContent : '').toLowerCase();
      const val = (el.getAttribute('data-value') || '').toLowerCase();
      const hit = !q || label.indexOf(q) !== -1 || val.indexOf(q) !== -1;
      el.hidden = !hit;
      if (hit) shown++;
    });

    if (parts.empty) parts.empty.hidden = shown !== 0;
    if (parts.list) parts.list.scrollTop = 0;
  },

  /** เลือกตัวเลือก → อัปเดตปุ่ม + hidden input แล้วยิง change ให้โค้ดเดิมทำงานต่อ */
  _pickCatOption(item) {
    const menu = item.closest('.mhnk-cat-menu');
    const btn = this._openSelectBtn;
    if (!menu || !btn) return;

    const value = item.getAttribute('data-value') || '';

    menu.querySelectorAll('.mhnk-cat-menu-item').forEach(el => {
      const on = el === item;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // อัปเดตไอคอน + ข้อความบนปุ่ม
    const curIco = btn.querySelector('.mhnk-cat-ico');
    const newIco = item.querySelector('.mhnk-cat-ico');
    if (curIco && newIco) curIco.replaceWith(newIco.cloneNode(true));

    const curLabel = btn.querySelector('.mhnk-cat-select-label');
    const newLabel = item.querySelector('.mhnk-cat-menu-label');
    if (curLabel && newLabel) {
      curLabel.textContent = newLabel.textContent;
      curLabel.setAttribute('title', newLabel.textContent);
    }

    const inputId = btn.getAttribute('data-cat-select');
    const input = inputId ? document.getElementById(inputId) : null;
    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    this._closeCatMenu(true);
  },

  _showAddForm(x, y) {
    const overlay = document.getElementById('mhnk-modal-overlay');
    const body = document.getElementById('mhnk-modal-body');
    if (!overlay || !body) return;

    this._modalVisible = true;
    overlay.classList.add('show');

    // หมวดหมู่ — dropdown ที่มีรูปจริงจาก blips/custom ในแต่ละตัวเลือก
    // (browser ใส่ <img> ใน <option> ของ <select> ไม่ได้ จึงสร้าง dropdown เอง)
    const catEntries = Object.values(MAP_CATEGORIES);
    const catItems = (catEntries.length > 0
      ? catEntries
      : [{ id: 'custom', label: 'อื่นๆ', color: '#888888', file: '' }]
    ).map(cat => ({
      value: cat.id,
      label: cat.label || cat.id,
      iconHtml: this._catIconHtml(cat)
    }));
    const catSelect = this._catSelectHtml('mhnk-poi-category', catItems, catItems[0].value, 'หมวดหมู่');

    body.innerHTML = `
      <div class="mhnk-modal">
        <div class="mhnk-modal-header">
          <div class="mhnk-modal-header-icon">📍</div>
          <h3>ADD POI <span>// ลงจุดแจ้ง</span></h3>
          <button class="mhnk-modal-close" onclick="VESPD_POI._hideModal()">&times;</button>
        </div>
        <div class="mhnk-modal-content">
          <div class="mhnk-coord-box">
            <div class="mhnk-coord-item">
              <label>AXIS X</label>
              <input type="text" id="mhnk-poi-x" value="${x.toFixed(2)}" readonly class="mhnk-input-readonly">
            </div>
            <div class="mhnk-coord-item">
              <label>AXIS Y</label>
              <input type="text" id="mhnk-poi-y" value="${y.toFixed(2)}" readonly class="mhnk-input-readonly">
            </div>
          </div>
          <div class="mhnk-form-group">
            <label for="mhnk-poi-name">ชื่อสถานที่ <span class="required">*</span></label>
            <input type="text" id="mhnk-poi-name" placeholder="เช่น ด่านตรวจถนนจ้าว...">
          </div>
          <div class="mhnk-form-group">
            <div class="mhnk-form-group-label" id="mhnk-poi-category-label">หมวดหมู่ <span class="required">*</span></div>
            ${catSelect}
          </div>
          <div class="mhnk-form-group">
            <label for="mhnk-poi-desc">รายละเอียด</label>
            <textarea id="mhnk-poi-desc" rows="3" placeholder="รายละเอียดเพิ่มเติม..."></textarea>
          </div>
        </div>
        <div class="mhnk-modal-footer">
          <button class="mhnk-btn mhnk-btn-ghost" onclick="VESPD_POI._hideModal()">✕ CANCEL</button>
          <button id="mhnk-poi-submit-btn" class="mhnk-btn mhnk-btn-primary" onclick="VESPD_POI._submitAddForm()">✓ ADD POI</button>
        </div>
      </div>
    `;

    setTimeout(() => document.getElementById('mhnk-poi-name')?.focus(), 100);
  },

  async _submitAddForm() {
    // ป้องกันการกดซ้ำหลายที (จะสร้างจุดซ้ำ)
    if (this._submitting) return;
    this._submitting = true;

    const submitBtn = document.getElementById('mhnk-poi-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '⏳ กำลังบันทึก...';
    }

    const name = document.getElementById('mhnk-poi-name')?.value?.trim();
    const category = document.getElementById('mhnk-poi-category')?.value;
    const description = document.getElementById('mhnk-poi-desc')?.value?.trim();
    const x = parseFloat(document.getElementById('mhnk-poi-x')?.value);
    const y = parseFloat(document.getElementById('mhnk-poi-y')?.value);

    const finish = (valid) => {
      this._submitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '✅ เพิ่มจุด';
      }
      return valid;
    };

    if (!name) {
      alert('⚠️ กรุณากรอกชื่อสถานที่');
      document.getElementById('mhnk-poi-name')?.focus();
      return finish(false);
    }
    if (!category) {
      alert('⚠️ กรุณาเลือกหมวดหมู่');
      document.querySelector('.mhnk-cat-select')?.focus();
      return finish(false);
    }
    if (isNaN(x) || isNaN(y)) {
      alert('⚠️ พิกัดไม่ถูกต้อง');
      return finish(false);
    }

    try {
      // เพิ่ม dcId ของผู้สร้างเข้าไปในข้อมูล POI
      var poiData = { name: name, category: category, description: description, x: x, y: y };
      if (typeof VESPD_DC !== 'undefined' && VESPD_DC.isConnected()) {
        poiData.dcId = VESPD_DC.getDcId();
      }
      const success = await this.addPoi(poiData);
      if (success) this._hideModal();
      return finish(success);
    } catch (err) {
      console.error('[VES-PD-POI] Add form error:', err);
      return finish(false);
    }
  },

  _hideModal() {
    this._closeCatMenu();
    const overlay = document.getElementById('mhnk-modal-overlay');
    if (overlay) overlay.classList.remove('show');
    this._modalVisible = false;
    this._selectedCoords = null;
    // กัน modal เปิดใหม่ทันทีหลังปิด (หลังคลิกนอกกรอบเพื่อปิด)
    this._suppressClicksUntil = Date.now() + 300;
  },

  _renderPoiList() {
    const container = document.getElementById('mhnk-poi-list');
    if (!container) return;

    const filterCategory = this._filterCategory || 'all';
    const query = this._searchQuery?.toLowerCase() || '';

    let filtered = this.pois;
    if (filterCategory !== 'all') {
      filtered = filtered.filter(p => p.category === filterCategory);
    }
    if (query) {
      filtered = filtered.filter(p =>
        (p.name || '').toLowerCase().includes(query) ||
        (p.description || '').toLowerCase().includes(query)
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="mhnk-empty">ไม่มีจุดแจ้ง</div>';
      return;
    }

    container.innerHTML = filtered.map(poi => {
      const cat = MAP_CATEGORIES[poi.category];
      const name = escapeHtml(poi.name || 'ไม่ระบุชื่อ');
      const mc = cat?.color || '#dc6d0b';
      const x = isFinite(Number(poi.x)) ? Number(poi.x).toFixed(1) : '0.0';
      const y = isFinite(Number(poi.y)) ? Number(poi.y).toFixed(1) : '0.0';

      // Check edit permission (login + มี ID ในคอลัมน์ J)
      const canEdit = (typeof VESPD_DC !== 'undefined') ? VESPD_DC.canEdit() : true;
      const editBtn = canEdit ? `<button class="mhnk-poi-item-edit" onclick="event.stopPropagation(); VESPD_POI._editPoiName('${escapeHtml(poi.id)}')" title="แก้ไขชื่อ">✎</button>` : '';
      const delBtn = canEdit ? `<button class="mhnk-poi-item-del" onclick="event.stopPropagation(); VESPD_POI.deletePoi('${escapeHtml(poi.id)}')" title="ลบ">✕</button>` : '';

      return `
        <div class="mhnk-poi-item" data-poi-id="${escapeHtml(poi.id)}" style="--mc:${mc}" onclick="VESPD_POI._goToPoi('${escapeHtml(poi.id)}')">
          <div class="mhnk-poi-item-dot" style="--mc:${mc}">${this._catIconHtml(cat)}</div>
          <div class="mhnk-poi-item-name" title="${name}">${name}</div>
          <span class="mhnk-poi-item-coord">X:${x} Y:${y}</span>
          ${editBtn}
          ${delBtn}
        </div>
      `;
    }).join('');

    // ยืนยัน selection เดิมหลัง rerender (ถ้ายังมีจุดนั้นอยู่)
    if (this._selectedPoiId) this._applySelection(this._selectedPoiId);
  },

  /** เลือกจุดที่รับมาจากแผนที่ (กด marker) — ไฮไลต์ + เลื่อนรายการด้านขวาไปหาจุดนั้น */
  _selectPoi(id) {
    this._selectedPoiId = id;
    this._applySelection(id);
  },

  /** ไฮไลต์การ์ดที่เลือก + เลื่อนให้เห็นในรายการ */
  _applySelection(id) {
    const items = document.querySelectorAll('.mhnk-poi-item');
    items.forEach(el => {
      const on = el.dataset.poiId === id;
      el.classList.toggle('selected', !!on);
      if (on) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  },

  /** กดการ์ดด้านขวา → แผนที่เลื่อนไปยังจุด + ไฮไลต์การ์ด */
  _goToPoi(id) {
    const p = this.pois.find(x => String(x.id) === String(id));
    if (!p) return;
    if (VESPD_MAP && VESPD_MAP.map) {
      VESPD_MAP.map.setView([Number(p.y), Number(p.x)], 4);
    }
    this._selectPoi(id);
  },

  _updateStats() {
    const statEl = document.getElementById('mhnk-poi-stats');
    if (!statEl) return;
    const count = this.pois.length;
    statEl.innerHTML = `<span class="mhnk-stat-num">${count}</span><span class="mhnk-stat-unit">BEACONS</span><span class="mhnk-stat-sig">●&nbsp;REC&nbsp;✓</span>`;
    // แอนิเมชันกระตุกตัวเลขเมื่ออัปเดต
    statEl.classList.remove('bump');
    void statEl.offsetWidth;
    statEl.classList.add('bump');
  },

  _renderCategoryFilter() {
    const filter = document.getElementById('mhnk-poi-filter');
    if (!filter) return;

    // ถ้าหมวดที่กรองอยู่ถูกลบ/เปลี่ยนชื่อ → กลับไป "ทั้งหมด"
    if (this._filterCategory !== 'all' && !MAP_CATEGORIES[this._filterCategory]) {
      this._filterCategory = 'all';
    }

    // ปิดเมนูที่ค้างอยู่ก่อนวาดใหม่ (กัน node กำพร้า)
    this._closeCatMenu();

    const items = [{ value: 'all', label: 'ทั้งหมด', iconHtml: '' }].concat(
      Object.values(MAP_CATEGORIES).map(cat => ({
        value: cat.id,
        label: cat.label || cat.id,
        iconHtml: this._catIconHtml(cat)
      }))
    );

    filter.innerHTML = this._catSelectHtml('mhnk-poi-filter-value', items, this._filterCategory, 'กรองตามหมวดหมู่');
  },

};