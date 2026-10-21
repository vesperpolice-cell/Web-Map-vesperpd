/* ========================================
   VES-PD Map Module - Core Map Component
   ใช้ Leaflet + GTA V map tiles
   ======================================== */

const VESPD_MAP = {
  map: null,
  tileLayers: {},
  currentStyle: 'atlas',
  poiLayer: null,
  markers: [],
  _initialized: false,

  // ค่าเริ่มต้น
  config: {
    zoom: 3,
    minZoom: 2,
    maxZoom: 5,
    center: [0, 0],
    tileBaseUrl: '/map-module/map-styles',
    blipsUrl: '/map-module/blips',
    maxBounds: [[-6000, -8000], [12000, 10000]],
    maxBoundsViscosity: 0.8,
    styles: ['atlas', 'satelite'],
    styleLabels: { atlas: 'ATLAS', satelite: 'SATELITE' },
    styleFolders: { atlas: 'styleAtlas', satelite: 'styleSatelite' },
    styleExts: { atlas: 'jpg', satelite: 'jpg' },
    styleMaxZooms: { atlas: 5, satelite: 5 }
  },

  /**
   * เริ่มต้นแผนที่
   */
  init(containerId, options = {}) {
    if (this._initialized) return;
    Object.assign(this.config, options);

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[VES-PD-MAP] Container not found:', containerId);
      return;
    }

    const CRS = this._createGtaCRS();
    this._buildTileLayers();

    const mapOptions = {
      crs: CRS,
      minZoom: this.config.minZoom,
      maxZoom: this.config.maxZoom,
      preferCanvas: true,
      layers: [this.tileLayers[this.currentStyle]],
      center: this.config.center,
      zoom: this.config.zoom,
      zoomControl: false,
      scrollWheelZoom: 'center',
      doubleClickZoom: true
    };

    if (this.config.maxBounds) {
      mapOptions.maxBounds = L.latLngBounds(
        L.latLng(this.config.maxBounds[0][0], this.config.maxBounds[0][1]),
        L.latLng(this.config.maxBounds[1][0], this.config.maxBounds[1][1])
      );
      mapOptions.maxBoundsViscosity = this.config.maxBoundsViscosity ?? 0.8;
    }

    this.map = L.map(container, mapOptions);
    setTimeout(() => this.map.invalidateSize(), 100);
    this.map.getContainer().style.background = '#0a0a0a';
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.poiLayer = L.layerGroup().addTo(this.map);
    this.map.on('click', (e) => this._onMapClick(e));

    this._initialized = true;
    document.dispatchEvent(new CustomEvent('vesperpd-map-ready', { detail: { map: this.map } }));
  },

  _createGtaCRS() {
    return Object.assign({}, L.CRS.Simple, {
      projection: L.Projection.LonLat,
      scale: (zoom) => Math.pow(2, zoom),
      zoom: (sc) => Math.log(sc) / Math.LN2,
      transformation: new L.Transformation(0.02072, 117.3, -0.0205, 172.8),
      infinite: true
    });
  },

  _buildTileLayers() {
    const { styles, styleFolders, styleExts, tileBaseUrl } = this.config;
    styles.forEach(style => {
      const folder = styleFolders[style];
      const ext = styleExts[style];
      const url = `${tileBaseUrl}/${folder}/{z}/{x}/{y}.${ext}`;
      const styleMaxZoom = (this.config.styleMaxZooms && this.config.styleMaxZooms[style]) || 5;
      const layer = L.tileLayer(url, {
        minZoom: 2,
        maxZoom: styleMaxZoom,
        noWrap: true,
        attribution: 'VES-PD Map',
        errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsvICAAEQAJ+lYp46AAAAAElFTkSuQmCC'
      });
      layer.on('tileerror', (e) => {
        e.tile.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsvICAAEQAJ+lYp46AAAAAElFTkSuQmCC';
      });
      this.tileLayers[style] = layer;
    });
  },

  switchStyle(style) {
    if (!this.tileLayers[style] || style === this.currentStyle) return;
    this.map.removeLayer(this.tileLayers[this.currentStyle]);
    this.map.addLayer(this.tileLayers[style]);
    this.currentStyle = style;
    // อัปเดตปุ่ม active ใน UI
    document.querySelectorAll('.mhnk-style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === style);
    });
  },

  _onMapClick(e) {
    const x = e.latlng.lng;
    const y = e.latlng.lat;
    const detail = { x, y };

    document.dispatchEvent(new CustomEvent('vesperpd-map-click', { detail }));
  },

  async loadPois() {
    try {
      const res = await fetch('/api/poi');
      const data = await res.json();
      if (data.success) {
        this.clearPois();
        data.data.forEach(poi => this.addPoi(poi));
      }
    } catch (err) {
      console.error('[VES-PD-MAP] Load POIs failed:', err);
    }
  },

  addPoi(poi) {
    if (!this.map) return;
    const xx = Number(poi.x);
    const yy = Number(poi.y);
    if (isNaN(xx) || isNaN(yy)) {
      console.warn('[VES-PD-MAP] Invalid coords for POI:', poi);
      return;
    }
    const icon = this._createPoiIcon(poi.category);
    const marker = L.marker([yy, xx], { icon })
      .addTo(this.poiLayer);
    marker._poiData = poi;
    this.markers.push(marker);
    // คลิก → เลื่อนแผนที่ให้จุดอยู่กึ่งกลาง + ไฮไลต์รายการด้านขวา
    marker.on('click', () => {
      this.map.setView([yy, xx], this.map.getZoom());
      if (typeof VESPD_POI !== 'undefined' && VESPD_POI._selectPoi) {
        VESPD_POI._selectPoi(String(poi.id));
      }
    });
    // ชี้ → แสดงชื่อ
    marker.on('mouseover', () => {
      marker.bindTooltip(poi.name || 'ไม่มีชื่อ', {
        direction: 'top',
        offset: [0, -10],
        className: 'mhnk-poi-tooltip'
      }).openTooltip();
    });
    marker.on('mouseout', () => {
      marker.unbindTooltip();
    });
    return marker;
  },

  clearPois() {
    this.poiLayer.clearLayers();
    this.markers = [];
  },

  /**
   * สร้าง marker icon — ใช้ชื่อไฟล์จาก MAP_CATEGORIES (โหลดจาก blips/custom/)
   * เป็น divIcon ไอคอนเดี่ยว (ไม่มีวงแหวน)
   */
  _createPoiIcon(category) {
    const blipsUrl = this.config.blipsUrl || '/map-module/blips';

    // หาชื่อไฟล์ + สีจาก MAP_CATEGORIES
    let fileName = '2mark.png'; // fallback: ใช้ไฟล์ที่มีใน blips/custom/ จริง (ไม่มี 1mark/custom.png)
    let color = '#dc6d0b';
    try {
      const cat = MAP_CATEGORIES[category];
      if (cat && cat.file) fileName = cat.file;
      if (cat && cat.color) color = cat.color;
    } catch (e) {
      // fallback
    }

    const url = `${blipsUrl}/custom/${encodeURI(fileName)}`;

    return L.divIcon({
      className: 'mhnk-marker',
      html: `
        <img class="mhnk-marker-img" src="${url}" alt="" onerror="this.style.display='none'" style="--mc:${color}">
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -22]
    });
  }
};