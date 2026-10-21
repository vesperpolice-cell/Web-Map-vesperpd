# 🗺️ VES-PD Map Module

โมดูลแผนที่ GTA V สำหรับระบบ VES-PD Police Department

## 📁 โครงสร้าง
```
map-module/
├── public/
│   └── map.html              # หน้าแผนที่ (เข้าถึงที่ /MapVesperPD)
├── src/
│   ├── map-core.js            # ตัวแผนที่ Leaflet + GTA V CRS
│   ├── map-poi.js             # ระบบ POI (CRUD + UI)
│   ├── map-categories.js      # หมวดหมู่ POI
│   └── map-style.css          # สไตล์ธีม VES-PD
├── server/
│   └── poi-routes.js          # API routes สำหรับ POI
├── map-styles/
│   ├── styleSatelite/         # Tile images (Satellite)
│   └── styleAtlas/            # Tile images (Atlas)
├── blips/
│   ├── 1.png - 5.png          # Marker icons
│   └── custom/                # ไอคอนหมวดหมู่เพิ่มเติม
└── README.md
```

## 🚀 การใช้งาน
เข้าถึงแผนที่ได้ที่: `https://mhnk-pd-0-1.onrender.com/MapVesperPD`

## 🎯 ฟีเจอร์
- แผนที่ GTA V (Satellite + Atlas)
- เพิ่มจุดแจ้ง (POI) ด้วยการคลิกบนแผนที่
- 8 หมวดหมู่ (จุดตรวจ, สถานีตำรวจ, โรงพยาบาล, จุดนัดพบ, จุดเกิดเหตุ, สถานที่สำคัญ, เขตปลอดภัย, อื่นๆ)
- ค้นหาและกรอง POI
- บันทึกข้อมูลลง Google Sheets (Sheet: MapPOI)

## 🗑️ วิธีลบ (Zero Dead Code)
```
1. ลบโฟลเดอร์ map-module/ ทั้งหมด
2. ลบ public/map.html (ถ้ามี)
3. คืนโค้ดใน server/index.js (ลบ try/catch blocks ที่เกี่ยวกับ map-module)
   - ค้นหา "[MapModule]" ในไฟล์ แล้วลบ 4 blocks นั้น