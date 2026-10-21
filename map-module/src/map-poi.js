/* ========================================
   MHNK Map Module - POI Manager
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

const MHNK_POI = {
  pois: [],
  _modalVisible: false,
  _selectedCoords: null,
  _searchQuery: '',
  _started: false,
  _suppressClicksUntil: 0,
  _submitting: false,

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
    document.addEventListener('mhnk-map-click', (e) => {

      // ตรวจสอบว่าสามารถเพิ่มจุดได้ (login + มี ID ในคอลัมน์ J)
      if (typeof MHNK_DC !== 'undefined' && !MHNK_DC.canAdd()) {
        return;
      }

      if (this._modalVisible) return;
      // ข้ามการเปิด modal ใหม่ทันทีหลังปิด (กันการคลิกนอกกรอบแล้วเด้งกลับ)
      if (Date.now() < this._suppressClicksUntil) return;
      this._selectedCoords = e.detail;
      this._showAddForm(e.detail.x, e.detail.y);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideModal();
    });

    const searchInput = document.getElementById('mhnk-poi-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._searchQuery = e.target.value;
        this._renderPoiList();
      });
    }

    const filterSelect = document.getElementById('mhnk-poi-filter');
    if (filterSelect) {
      filterSelect.addEventListener('change', (e) => {
        this._renderPoiList();
      });
    }
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
        MHNK_MAP.clearPois();
        this.pois.forEach(poi => MHNK_MAP.addPoi(poi));

        // อัปเดตรายการ ID ที่มีในคอลัมน์ J สำหรับตรวจสอบสิทธิ์
        if (typeof MHNK_DC !== 'undefined') {
          var authorizedIds = this.pois
            .map(function(poi) { return poi.dcId; })
            .filter(function(id) { return id && String(id).trim() !== ''; });
          MHNK_DC.setAuthorizedIds(authorizedIds);
        }

        this._renderPoiList();
        this._updateStats();
      } else {
        if (container) container.innerHTML = '<div class="mhnk-empty">⚠️ โหลดข้อมูลไม่สำเร็จ</div>';
      }
    } catch (err) {
      console.error('[MHNK-POI] Load failed:', err);
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
      console.error('[MHNK-POI] Add failed:', err);
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
      console.error('[MHNK-POI] Delete failed:', err);
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
          <button class="mhnk-modal-close" onclick="MHNK_POI._hideModal()">&times;</button>
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
          <button class="mhnk-btn mhnk-btn-ghost" onclick="MHNK_POI._hideModal()">✕ CANCEL</button>
          <button id="mhnk-edit-submit-btn" class="mhnk-btn mhnk-btn-primary" onclick="MHNK_POI._savePoiName()">✓ SAVE</button>
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
      console.error('[MHNK-POI] Edit failed:', err);
      alert('❌ เกิดข้อผิดพลาด');
    } finally {
      this._submitting = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '✓ SAVE'; }
    }
  },

  /** Helper: icon สำหรับ sidebar dot */
  _catDotHtml(cat) {
    if (cat && cat.file) {
      const file = encodeURI(cat.file);
      return `<img src="/map-module/blips/custom/${file}" alt="" onerror="this.style.display='none';this.parentElement.textContent='📍'">`;
    }
    return '📍';
  },
  _showAddForm(x, y) {
    const overlay = document.getElementById('mhnk-modal-overlay');
    const body = document.getElementById('mhnk-modal-body');
    if (!overlay || !body) return;

    this._modalVisible = true;
    overlay.classList.add('show');

    // Dropdown options - browser ไม่ support <img> ใน <option> ใช้ข้อความอย่างเดียว
    const catEntries = Object.values(MAP_CATEGORIES);
    const catOptions = catEntries.length > 0
      ? catEntries.map(cat => `<option value="${escapeHtml(cat.id)}">📌 ${escapeHtml(cat.label)}</option>`).join('')
      : '<option value="custom">📌 อื่นๆ</option>';

    body.innerHTML = `
      <div class="mhnk-modal">
        <div class="mhnk-modal-header">
          <div class="mhnk-modal-header-icon">📍</div>
          <h3>ADD POI <span>// ลงจุดแจ้ง</span></h3>
          <button class="mhnk-modal-close" onclick="MHNK_POI._hideModal()">&times;</button>
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
            <label for="mhnk-poi-category">หมวดหมู่ <span class="required">*</span></label>
            <select id="mhnk-poi-category">${catOptions}</select>
          </div>
          <div class="mhnk-form-group">
            <label for="mhnk-poi-desc">รายละเอียด</label>
            <textarea id="mhnk-poi-desc" rows="3" placeholder="รายละเอียดเพิ่มเติม..."></textarea>
          </div>
        </div>
        <div class="mhnk-modal-footer">
          <button class="mhnk-btn mhnk-btn-ghost" onclick="MHNK_POI._hideModal()">✕ CANCEL</button>
          <button id="mhnk-poi-submit-btn" class="mhnk-btn mhnk-btn-primary" onclick="MHNK_POI._submitAddForm()">✓ ADD POI</button>
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
      return finish(false);
    }
    if (isNaN(x) || isNaN(y)) {
      alert('⚠️ พิกัดไม่ถูกต้อง');
      return finish(false);
    }

    try {
      // เพิ่ม dcId ของผู้สร้างเข้าไปในข้อมูล POI
      var poiData = { name: name, category: category, description: description, x: x, y: y };
      if (typeof MHNK_DC !== 'undefined' && MHNK_DC.isConnected()) {
        poiData.dcId = MHNK_DC.getDcId();
      }
      const success = await this.addPoi(poiData);
      if (success) this._hideModal();
      return finish(success);
    } catch (err) {
      console.error('[MHNK-POI] Add form error:', err);
      return finish(false);
    }
  },

  _hideModal() {
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

    const filterCategory = document.getElementById('mhnk-poi-filter')?.value || 'all';
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
      const canEdit = (typeof MHNK_DC !== 'undefined') ? MHNK_DC.canEdit() : true;
      const editBtn = canEdit ? `<button class="mhnk-poi-item-edit" onclick="event.stopPropagation(); MHNK_POI._editPoiName('${escapeHtml(poi.id)}')" title="แก้ไขชื่อ">✎</button>` : '';
      const delBtn = canEdit ? `<button class="mhnk-poi-item-del" onclick="event.stopPropagation(); MHNK_POI.deletePoi('${escapeHtml(poi.id)}')" title="ลบ">✕</button>` : '';

      return `
        <div class="mhnk-poi-item" data-poi-id="${escapeHtml(poi.id)}" style="--mc:${mc}" onclick="MHNK_POI._goToPoi('${escapeHtml(poi.id)}')">
          <div class="mhnk-poi-item-dot" style="--mc:${mc}">${this._catDotHtml(cat)}</div>
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
    if (MHNK_MAP && MHNK_MAP.map) {
      MHNK_MAP.map.setView([Number(p.y), Number(p.x)], 4);
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

    const catEntries = Object.values(MAP_CATEGORIES);
    filter.innerHTML = '<option value="all">🏷️ ทั้งหมด</option>' +
      (catEntries.length > 0
        ? catEntries.map(cat => `<option value="${escapeHtml(cat.id)}">📌 ${escapeHtml(cat.label)}</option>`).join('')
        : '<option value="custom">📌 อื่นๆ</option>'
      );
  },

};