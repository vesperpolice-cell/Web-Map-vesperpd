/* ========================================
   VES-PD Map Module - POI Categories
   หมวดหมู่ POI อ่านจากไฟล์ PNG ใน blips/custom/ โดยอัตโนมัติ
   ======================================== */

const MAP_CATEGORIES = {};

// หมวดหมู่ start (ถ้ายังไม่มีไฟล์ PNG)
const DEFAULT_CATEGORIES = {
  custom: { id: 'custom', label: 'อื่นๆ', color: '#888888', description: 'จุดอื่นๆ' }
};

/**
 * โหลดหมวดหมู่จากไฟล์ PNG ใน blips/custom/
 * fetch /api/poi/categories → สร้าง MAP_CATEGORIES
 */
async function loadCategories() {
  try {
    const res = await fetch('/api/poi/categories');
    const data = await res.json();
    
    if (data.success && data.data.length > 0) {
      // ล้างของเก่าแล้วสร้างจากไฟล์ PNG
      Object.keys(MAP_CATEGORIES).forEach(k => delete MAP_CATEGORIES[k]);
      
      data.data.forEach(cat => {
        MAP_CATEGORIES[cat.id] = {
          id: cat.id,
          label: cat.label || cat.id,
          color: getCategoryColor(cat.id),
          description: cat.description || '',
          file: cat.file || ''
        };
      });
      
      // เผื่อมีไฟล์ custom.png ด้วย
      if (!MAP_CATEGORIES.custom) {
        MAP_CATEGORIES.custom = { ...DEFAULT_CATEGORIES.custom };
      }
    } else {
      // ไม่มีไฟล์ ใช้ค่า default
      Object.assign(MAP_CATEGORIES, DEFAULT_CATEGORIES);
    }
  } catch (err) {
    console.error('[VES-PD-CAT] Load failed, using defaults:', err.message);
    // fallback
    if (Object.keys(MAP_CATEGORIES).length === 0) {
      Object.assign(MAP_CATEGORIES, DEFAULT_CATEGORIES);
    }
  }
}

/** ดึงสีตามชื่อหมวด (hash from string) */
function getCategoryColor(id) {
  const colors = [
    '#ff4444', '#0066ff', '#ffaa00', '#ff6600', '#9933ff',
    '#00cc66', '#e94560', '#0fbcf9', '#f53b57', '#3c40c6',
    '#0be881', '#ffd32a', '#ff5e57', '#34e7e4', '#575fcf'
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length];
}

/** เรียกครั้งแรกเพื่อ load */
loadCategories();