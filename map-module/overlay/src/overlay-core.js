/* MHNK Overlay - Core with Drawing */
const VESPD_OVERLAY = {
  map: null,
  layers: {},
  drawnItems: null,
  currentColor: '#dc6d0b',
  zones: [],

  init(map, zones) {
    this.map = map;
    this.zones = zones;

    // Create layer for drawn items
    this.drawnItems = new L.FeatureGroup();
    this.map.addLayer(this.drawnItems);
    this._isAllVisible = true;

    // Initialize zones
    this.zones.forEach(zone => {
      this.layers[zone.id] = L.layerGroup();
      zone.areas.forEach(area => {
        if (area.coords && area.coords.length >= 3) {
          const latlngs = area.coords.map(c => L.latLng(c[0], c[1]));
          const polygon = L.polygon(latlngs, {
            color: zone.color,
            weight: 2,
            opacity: 0.8,
            fillColor: zone.color,
            fillOpacity: 0.15
          });
          polygon.bindTooltip(area.name, { permanent: false, direction: "center" });
          this.layers[zone.id].addLayer(polygon);
        }
      });
    });

    // Add draw control
    this._initDrawControl();

    // Load saved drawings
    this._loadSavedDrawings();

    // Make panel draggable
    this._makeDraggable();

    // Collapse panel by default
    this.togglePanel();
  },

  _makeDraggable() {
    const panel = document.getElementById('overlay-panel');
    const title = document.querySelector('.mhnk-overlay-title');
    if (!panel || !title) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    title.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = (startLeft + dx) + 'px';
      panel.style.top = (startTop + dy) + 'px';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  },

  _initDrawControl() {
    const drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: {
        polygon: {
          allowIntersection: false,
          shapeOptions: {
            color: this.currentColor,
            weight: 2,
            fillOpacity: 0.15
          }
        },
        rectangle: {
          shapeOptions: {
            color: this.currentColor,
            weight: 2,
            fillOpacity: 0.15
          }
        },
        circle: false,
        circlemarker: false,
        marker: false,
        polyline: false
      },
      edit: {
        featureGroup: this.drawnItems,
        remove: true
      }
    });
    this.map.addControl(drawControl);

    // Hide default toolbar (we use custom buttons)
    setTimeout(() => {
      const toolbar = document.querySelector('.leaflet-draw-toolbar');
      if (toolbar) toolbar.style.display = 'none';
    }, 100);

    // Handle created shapes
    this.map.on(L.Draw.Event.CREATED, (e) => {
      const layer = e.layer;
      layer.setStyle({
        color: this.currentColor,
        fillColor: this.currentColor
      });
      this.drawnItems.addLayer(layer);
      this._saveDrawings();
      this._clearActiveTool();
    });

    // Handle edited shapes
    this.map.on(L.Draw.Event.EDITED, (e) => {
      this._saveDrawings();
    });

    // Handle deleted shapes
    this.map.on(L.Draw.Event.DELETED, (e) => {
      this._saveDrawings();
    });
  },

  startDraw(type) {
    this._clearActiveTool();
    const tool = document.querySelector(`.mhnk-overlay-tool[onclick*="${type}"]`);
    if (tool) tool.classList.add('active');

    if (type === 'polygon') {
      this._polygonDrawer = new L.Draw.Polygon(this.map);
      this._polygonDrawer.enable();
    } else if (type === 'rectangle') {
      this._rectangleDrawer = new L.Draw.Rectangle(this.map);
      this._rectangleDrawer.enable();
    }
  },

  startEdit() {
    this._clearActiveTool();
    const tool = document.querySelector('.mhnk-overlay-tool[onclick*="startEdit"]');
    if (tool) tool.classList.add('active');

    // Remove delete click handlers and enable editing
    this.drawnItems.eachLayer(layer => {
      layer.off('click'); // Remove delete handler
      if (layer.editing) {
        layer.editing.enable();
      }
    });

    // Listen for edit events
    this.map.on('editable:editing', () => {
      this._saveDrawings();
    });
  },

  startDelete() {
    this._clearActiveTool();
    const tool = document.querySelector('.mhnk-overlay-tool[onclick*="startDelete"]');
    if (tool) tool.classList.add('active');

    // Enable delete on click
    this.drawnItems.eachLayer(layer => {
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.drawnItems.removeLayer(layer);
        this._saveDrawings();
      });
    });
  },

  changeColor(color) {
    this.currentColor = color;
    // Apply to selected/edited shapes
    this.drawnItems.eachLayer(layer => {
      if (layer._editing && layer._editing.enabled()) {
        layer.setStyle({ color: color, fillColor: color });
        this._saveDrawings();
      }
    });
  },

  finishDraw() {
    // Complete the polygon if drawing
    if (this._polygonDrawer && this._polygonDrawer.enabled()) {
      this._polygonDrawer.completeShape();
    }
    // Remove delete click handlers
    this.drawnItems.eachLayer(layer => {
      layer.off('click');
      if (layer.editing && layer.editing.enabled()) {
        layer.editing.disable();
      }
    });
    this._clearActiveTool();
  },

  _clearActiveTool() {
    // Remove active class from all tools
    document.querySelectorAll('.mhnk-overlay-tool').forEach(t => t.classList.remove('active'));

    // Disable any active drawers
    if (this._polygonDrawer) {
      this._polygonDrawer.disable();
      this._polygonDrawer = null;
    }
    if (this._rectangleDrawer) {
      this._rectangleDrawer.disable();
      this._rectangleDrawer = null;
    }
    if (this._editHandler) {
      this._editHandler.disable();
      this._editHandler = null;
    }
    if (this._deleteHandler) {
      this._deleteHandler.disable();
      this._deleteHandler = null;
    }
  },

  setColor(color) {
    this.currentColor = color;
    const colorBtns = document.querySelectorAll('.mhnk-overlay-color-btn');
    colorBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });

    // Apply to currently editing shapes
    this.drawnItems.eachLayer(layer => {
      if (layer.editing && layer.editing.enabled()) {
        layer.setStyle({ color: color, fillColor: color });
        this._saveDrawings();
      }
    });
  },

  toggle(zoneId) {
    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone) return;
    zone.visible = !zone.visible;
    if (zone.visible) {
      this.map.addLayer(this.layers[zoneId]);
    } else {
      this.map.removeLayer(this.layers[zoneId]);
    }
    const btn = document.getElementById("overlay-btn-" + zoneId);
    if (btn) btn.classList.toggle("active", zone.visible);
  },

  togglePanel() {
    const content = document.getElementById('overlay-content');
    const panel = document.getElementById('overlay-panel');
    if (content && panel) {
      content.style.display = content.style.display === 'none' ? 'flex' : 'none';
      panel.classList.toggle('collapsed');
    }
  },

  toggleAll() {
    if (this._isAllVisible) {
      // Hide all drawn items
      this.map.removeLayer(this.drawnItems);
    } else {
      // Show all drawn items
      this.map.addLayer(this.drawnItems);
    }
    const btn = document.getElementById("overlay-btn-all");
    if (btn) btn.classList.toggle("active", !this._isAllVisible);
    this._isAllVisible = !this._isAllVisible;
  },

  clearDrawn() {
    this.drawnItems.clearLayers();
    this._saveDrawings();
  },

  _saveDrawings() {
    const data = [];
    this.drawnItems.eachLayer(layer => {
      if (layer instanceof L.Polygon) {
        const latlngs = layer.getLatLngs()[0];
        data.push({
          color: layer.options.color,
          coords: latlngs.map(ll => [ll.lat, ll.lng])
        });
      }
    });
    localStorage.setItem('mhnk_overlay_drawn', JSON.stringify(data));
  },

  _loadSavedDrawings() {
    const saved = localStorage.getItem('mhnk_overlay_drawn');
    if (!saved) return;
    try {
      const data = JSON.parse(saved);
      data.forEach(item => {
        const latlngs = item.coords.map(c => L.latLng(c[0], c[1]));
        const polygon = L.polygon(latlngs, {
          color: item.color,
          weight: 2,
          opacity: 0.8,
          fillColor: item.color,
          fillOpacity: 0.15
        });
        this.drawnItems.addLayer(polygon);
      });
    } catch (e) {
      console.error('[Overlay] Load saved drawings failed:', e);
    }
  }
};
