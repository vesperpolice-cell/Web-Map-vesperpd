/* MHNK GEO-CHALLENGE - Game Core */
const GAME = {
  map: null, allPois: [], roundPois: [], currentRound: 0, totalRounds: 50,
  totalScore: 0, currentTarget: null, playerMarker: null, targetMarker: null,
  resultLine: null, timerInterval: null, timeLeft: 30, isAnswered: false,
  tileLayer: null, currentStyle: 'atlas',

  showStartup() {
    this._initMap();
    this._loadPois();
    var popup = document.getElementById('game-startup');
    if (popup) popup.style.display = 'flex';
  },

  startGame() {
    var popup = document.getElementById('game-startup');
    if (popup) popup.classList.add('hidden');
    var self = this;
    setTimeout(function() {
      if (popup) popup.style.display = 'none';
      self._startRound();
    }, 300);
  },

  _initMap() {
    const CRS = Object.assign({}, L.CRS.Simple, {
      projection: L.Projection.LonLat, scale: (z) => Math.pow(2, z),
      zoom: (s) => Math.log(s) / Math.LN2,
      transformation: new L.Transformation(0.02072, 117.3, -0.0205, 172.8), infinite: true
    });
    this.map = L.map('game-map', { crs: CRS, minZoom: 2, maxZoom: 5, zoom: 4, center: [0, 0], zoomControl: false, maxBounds: L.latLngBounds(L.latLng(-6000, -8000), L.latLng(12000, 10000)), maxBoundsViscosity: 0.8 });
    this.map.getContainer().style.background = '#0a0a0a';
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.tileLayer = L.tileLayer('/map-module/map-styles/styleAtlas/{z}/{x}/{y}.webp', { minZoom: 0, maxZoom: 5, noWrap: true, errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsvICAAEQAJ+lYp46AAAAAElFTkSuQmCC' }).addTo(this.map);
    this.map.on('click', (e) => this._onMapClick(e));
    setTimeout(() => this.map.invalidateSize(), 100);
  },

  toggleMapStyle() {
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
    }
    this.currentStyle = this.currentStyle === 'atlas' ? 'satelite' : 'atlas';
    var styleDir = this.currentStyle === 'atlas' ? 'styleAtlas' : 'styleSatelite';
    this.tileLayer = L.tileLayer('/map-module/map-styles/' + styleDir + '/{z}/{x}/{y}.webp', { minZoom: 0, maxZoom: 5, noWrap: true, errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsvICAAEQAJ+lYp46AAAAAElFTkSuQmCC' }).addTo(this.map);
    var icon = document.getElementById('game-map-toggle-icon');
    var label = document.getElementById('game-map-toggle-label');
    if (icon) icon.textContent = this.currentStyle === 'atlas' ? '🗺' : '🛰';
    if (label) label.textContent = this.currentStyle === 'atlas' ? 'ATLAS' : 'SATELITE';
  },

  async _loadPois() {
    try {
      const res = await fetch('/api/poi/game'); const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        this.allPois = data.data.filter(p => p.x && p.y && p.name);
        this.roundPois = this._shuffle(this.allPois).slice(0, this.totalRounds);
      }
    } catch (e) { console.error('[GAME] Load POIs failed:', e); }
  },

  _shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },

  _startRound() {
    if (this.currentRound >= this.roundPois.length) { this._showFinal(); return; }
    this.isAnswered = false;
    this.currentTarget = this.roundPois[this.currentRound];
    this.currentRound++;
    this._clearMarkers();
    document.getElementById('game-round').textContent = this.currentRound + '/' + this.totalRounds;
    document.getElementById('game-question-name').textContent = this.currentTarget.name || 'UNKNOWN';
    document.getElementById('game-question-desc').textContent = this.currentTarget.description || '';
    document.getElementById('game-result').style.display = 'none';
    this._startTimer();
  },

  _startTimer() {
    this.timeLeft = 30; this._updateTimer();
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.timeLeft--; this._updateTimer();
      if (this.timeLeft <= 0) { clearInterval(this.timerInterval); if (!this.isAnswered) this._submitAnswer(null); }
    }, 1000);
  },

  _updateTimer() {
    var e = document.getElementById('game-timer');
    e.textContent = this.timeLeft;
    e.style.color = this.timeLeft <= 10 ? '#ff2d55' : '';
    // แถบเวลาที่ขอบล่างการ์ดสถานะ — ฟ้า / ส้มตอนเหลือ 10 / แดงตอนเหลือ 5
    var bar = document.getElementById('game-timer-fill');
    if (bar) {
      bar.style.width = Math.max(0, Math.min(1, this.timeLeft / 30)) * 100 + '%';
      bar.style.background = this.timeLeft <= 5 ? '#ff2d55' : (this.timeLeft <= 10 ? '#ffb020' : '#dc6d0b');
    }
  },

  _onMapClick(e) { if (this.isAnswered) return; this._submitAnswer({ x: e.latlng.lng, y: e.latlng.lat }); },

  _submitAnswer(coords) {
    this.isAnswered = true; clearInterval(this.timerInterval);
    var t = this.currentTarget, tX = Number(t.x), tY = Number(t.y);
    var dist = 0, score = 0;
    if (coords) {
      this.playerMarker = L.marker([coords.y, coords.x], { icon: L.divIcon({ className: 'game-player-marker', html: '<div class="game-player-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(this.map);
      dist = Math.sqrt(Math.pow(coords.x - tX, 2) + Math.pow(coords.y - tY, 2));
      score = Math.max(0, Math.round(1000 - (dist / 500) * 1000));
    }
    this.totalScore += score;
    this.targetMarker = L.marker([tY, tX], { icon: L.divIcon({ className: 'game-target-marker', html: '<div class="game-target-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(this.map);
    if (coords) this.resultLine = L.polyline([[coords.y, coords.x], [tY, tX]], { color: score > 500 ? '#2aff9b' : '#ff2d55', weight: 2, dashArray: '6,4' }).addTo(this.map);
    this._showResult(coords, dist, score);
    document.getElementById('game-score').textContent = this.totalScore;
  },

  _showResult(coords, dist, score) {
    document.getElementById('game-result').style.display = 'flex';
    document.getElementById('game-result-target').textContent = this.currentTarget.name;
    document.getElementById('game-result-click').textContent = coords ? 'X:' + Math.round(coords.x) + ' Y:' + Math.round(coords.y) : 'TIMEOUT';
    document.getElementById('game-result-distance').textContent = coords ? Math.round(dist) + ' units' : '—';
    var pEl = document.getElementById('game-result-points'); pEl.textContent = score; pEl.style.color = score > 700 ? '#2aff9b' : score > 300 ? '#ffb020' : '#ff2d55';
    document.getElementById('game-next-btn').textContent = this.currentRound >= this.roundPois.length ? 'VIEW RESULTS' : 'NEXT TARGET';
  },

  nextRound() { this._startRound(); },

  _showFinal() {
    var max = this.totalRounds * 1000, pct = (this.totalScore / max) * 100;
    var g = 'F';
    if (pct >= 90) g = 'S'; else if (pct >= 75) g = 'A'; else if (pct >= 60) g = 'B'; else if (pct >= 40) g = 'C'; else if (pct >= 20) g = 'D';
    document.getElementById('game-final-score').textContent = this.totalScore;
    var gEl = document.getElementById('game-final-grade'); gEl.textContent = g;
    gEl.style.color = { S: '#2aff9b', A: '#dc6d0b', B: '#ffb020', C: '#ff9500', D: '#ff6600', F: '#ff2d55' }[g] || '#ff2d55';
    document.getElementById('game-final-details').innerHTML = 'Accuracy: ' + pct.toFixed(1) + '%<br>Max: ' + max;
    document.getElementById('game-final').style.display = 'flex';
  },

  _clearMarkers() { if (this.playerMarker) { this.map.removeLayer(this.playerMarker); this.playerMarker = null; } if (this.targetMarker) { this.map.removeLayer(this.targetMarker); this.targetMarker = null; } if (this.resultLine) { this.map.removeLayer(this.resultLine); this.resultLine = null; } },

  restart() { this.currentRound = 0; this.totalScore = 0; this.roundPois = this._shuffle(this.allPois).slice(0, this.totalRounds); document.getElementById('game-final').style.display = 'none'; document.getElementById('game-score').textContent = '0'; this.showStartup(); },

  exit() { window.location.href = '/MapMhnkPD'; }
};