(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────

  const SG_BOUNDS      = [[1.159, 103.605], [1.482, 104.088]];
  const COLOR_DEFAULT  = '#f59e0b';
  const COLOR_SELECTED = '#22d3ee';

  const TILE_LAYERS = {
    dark:      { url: '/tiles/dark/{z}/{x}/{y}.png',      label: 'Dark',      attr: '&copy; OpenStreetMap, &copy; CartoDB' },
    satellite: { url: '/tiles/satellite/{z}/{x}/{y}.png', label: 'Satellite', attr: '&copy; Esri' },
    streets:   { url: '/tiles/streets/{z}/{x}/{y}.png',   label: 'Streets',   attr: '&copy; OpenStreetMap contributors' },
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  let map;
  let tileLayer;
  let stopsLayer        = null;
  let currentLayerKey   = 'dark';
  let selectMode        = false;
  let selected          = new Map();   // code → { feature, layer }
  let bottomBarExpanded = true;
  let wasDragging       = false;

  // Drag-selection state
  let selectStart = null;
  let selectRect  = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function stopStyle(sel) {
    return {
      radius: 4,
      fillColor:   sel ? COLOR_SELECTED : COLOR_DEFAULT,
      color:       sel ? COLOR_SELECTED : COLOR_DEFAULT,
      weight: 1, opacity: 0.9,
      fillOpacity: sel ? 0.9 : 0.6,
    };
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    map = L.map('map', { preferCanvas: true })
      .fitBounds(SG_BOUNDS, { padding: [20, 20] });

    tileLayer = L.tileLayer(TILE_LAYERS.dark.url, {
      attribution: TILE_LAYERS.dark.attr,
      maxZoom: 19,
    }).addTo(map);

    // Drag-to-select map events — registered here, same as mapwatcher
    map.on('mousedown', _onSelectMouseDown);
    map.on('mousemove', _onSelectMouseMove);
    map.on('mouseup',   _onSelectMouseUp);

    autoLoadStops();
  }

  // ── Drag-to-select ────────────────────────────────────────────────────────────

  function _onSelectMouseDown(e) {
    if (!selectMode) return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;
    selectStart = { latlng: e.latlng, shift: e.originalEvent && e.originalEvent.shiftKey };
    if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
  }

  function _onSelectMouseMove(e) {
    if (!selectMode || !selectStart) return;
    const bounds = L.latLngBounds(selectStart.latlng, e.latlng);
    if (selectRect) {
      selectRect.setBounds(bounds);
    } else {
      selectRect = L.rectangle(bounds, {
        color: COLOR_SELECTED, weight: 1.5, fillOpacity: 0.08,
        dashArray: '5,5', interactive: false,
      }).addTo(map);
    }
  }

  function _onSelectMouseUp(e) {
    if (!selectMode || !selectStart) return;
    const bounds   = L.latLngBounds(selectStart.latlng, e.latlng);
    const additive = selectStart.shift || (e.originalEvent && e.originalEvent.shiftKey);
    if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
    selectStart = null;
    _selectInBounds(bounds, additive);
  }

  function _selectInBounds(bounds, additive) {
    if (!stopsLayer) return;
    if (!additive) {
      selected.forEach(({ layer: l }) => l.setStyle(stopStyle(false)).bringToBack());
      selected.clear();
    }

    stopsLayer.eachLayer((layer) => {
      if (typeof layer.getLatLng !== 'function') return;
      if (!bounds.contains(layer.getLatLng())) return;
      const p    = layer.feature.properties || {};
      const code = p.number || p.BusStopCode || p.code || '';
      if (!code || selected.has(code)) return;
      selected.set(code, { feature: layer.feature, layer });
      layer.setStyle(stopStyle(true)).bringToFront();
    });

    renderBottomBar();
  }

  // ── Select mode toggle ────────────────────────────────────────────────────────

  function toggleSelectMode(btn) {
    selectMode = !selectMode;
    btn.classList.toggle('active', selectMode);
    if (selectMode) {
      map.dragging.disable();
      map.getContainer().style.cursor = 'crosshair';
    } else {
      map.dragging.enable();
      map.getContainer().style.cursor = '';
      if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
      selectStart = null;
    }
  }

  // ── Home ──────────────────────────────────────────────────────────────────────

  function goHome() {
    map.fitBounds(SG_BOUNDS, { padding: [20, 20] });
  }

  // ── Layer buttons ─────────────────────────────────────────────────────────────

  function setLayer(key, btn) {
    if (currentLayerKey === key) return;
    currentLayerKey = key;
    const cfg = TILE_LAYERS[key];
    map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(cfg.url, { attribution: cfg.attr, maxZoom: 19 }).addTo(map);
    if (stopsLayer) stopsLayer.bringToFront();
    document.querySelectorAll('.btn-layer').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  // ── Bus stops layer ───────────────────────────────────────────────────────────

  async function autoLoadStops() {
    try {
      let r = await fetch('/api/geojson/sg-bus-stops');
      if (r.status === 404) {
        for (let i = 0; i < 5; i++) {
          await new Promise(res => setTimeout(res, 1500));
          r = await fetch('/api/geojson/sg-bus-stops');
          if (r.ok) break;
        }
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buildStopsLayer(await r.json());
    } catch (err) {
      console.error('[mapwatch-py] Failed to load bus stops:', err);
    }
  }

  function buildStopsLayer(geojson) {
    if (stopsLayer) stopsLayer.remove();

    stopsLayer = L.geoJSON(geojson, {
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, stopStyle(false)),
      onEachFeature: _onEachBusStop,
    }).addTo(map);
  }

  function _onEachBusStop(feature, layer) {
    const p    = feature.properties || {};
    const code = p.number || p.BusStopCode || p.code || '';
    const name = p.name   || p.Description || code;
    const road = p.road   || p.RoadName    || '';

    if (name) {
      layer.bindTooltip(
        `<b>${esc(name)}</b>` +
        (road ? `<br>${esc(road)}` : '') +
        (code ? `<br>Stop: ${esc(code)}` : ''),
        { sticky: true, opacity: 0.95 }
      );
    }

    layer.on('click', (e) => {
      if (wasDragging) return;
      const additive = selectMode || (e.originalEvent && e.originalEvent.shiftKey);
      _toggleStop(code, feature, layer, additive);
    });
  }

  // ── Selection logic ───────────────────────────────────────────────────────────

  function _toggleStop(code, feature, layer, additive) {
    if (!additive) {
      selected.forEach(({ layer: l }) => l.setStyle(stopStyle(false)).bringToBack());
      selected.clear();
    }
    if (selected.has(code)) {
      selected.get(code).layer.setStyle(stopStyle(false)).bringToBack();
      selected.delete(code);
    } else {
      selected.set(code, { feature, layer });
      layer.setStyle(stopStyle(true)).bringToFront();
    }
    renderBottomBar();
  }

  function _deselectByCode(code) {
    if (!selected.has(code)) return;
    selected.get(code).layer.setStyle(stopStyle(false)).bringToBack();
    selected.delete(code);
    renderBottomBar();
  }

  // ── Bottom bar ────────────────────────────────────────────────────────────────

  function renderBottomBar() {
    const bar = document.getElementById('bottom-bar');

    if (selected.size === 0) {
      bar.classList.remove('open', 'expanded');
      bottomBarExpanded = true;
      document.getElementById('bottom-bar-toggle').innerHTML = '&#9660;';
      return;
    }

    document.getElementById('bottom-bar-count').textContent =
      selected.size + ' stop' + (selected.size > 1 ? 's' : '') + ' selected';

    const wasOpen = bar.classList.contains('open');
    bar.classList.add('open');
    if (!wasOpen) {
      bottomBarExpanded = true;
      bar.classList.add('expanded');
      document.getElementById('bottom-bar-toggle').innerHTML = '&#9650;';
    }

    const list = document.getElementById('bottom-selection-list');
    list.innerHTML = '';

    selected.forEach(({ feature }, code) => {
      const p    = feature.properties || {};
      const name = p.name || p.Description || code;
      const road = p.road || p.RoadName    || '';

      const chip = document.createElement('div');
      chip.className = 'sel-chip';
      chip.innerHTML =
        '<span class="sel-chip-name">' + esc(name) + '</span>' +
        '<span class="sel-chip-sub">' + esc(road || code) + '</span>' +
        '<span class="sel-chip-remove" title="Remove">&times;</span>';

      chip.querySelector('.sel-chip-remove').addEventListener('click', (ev) => {
        ev.stopPropagation();
        _deselectByCode(code);
      });
      chip.addEventListener('click', () => {
        const coords = selected.get(code).feature.geometry.coordinates;
        map.setView([coords[1], coords[0]], 17);
      });
      list.appendChild(chip);
    });
  }

  function toggleBottomBar() {
    bottomBarExpanded = !bottomBarExpanded;
    document.getElementById('bottom-bar').classList.toggle('expanded', bottomBarExpanded);
    document.getElementById('bottom-bar-toggle').innerHTML = bottomBarExpanded ? '&#9650;' : '&#9660;';
  }

  // ── Expose to HTML onclick handlers ──────────────────────────────────────────

  window.toggleSelectMode = toggleSelectMode;
  window.goHome           = goHome;
  window.setLayer         = setLayer;
  window.toggleBottomBar  = toggleBottomBar;

  // ── Boot ──────────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);

})();
