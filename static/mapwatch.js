/**
 * MapWatch — core client-side JS
 * Handles: WebSocket, marker management, clustering, side panel, themes,
 *          DC baseline markers, multi-alert aggregation, SG overlay layers.
 */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────

  const SEVERITY_COLORS = {
    critical: '#f85149',
    warning:  '#e3b341',
    info:     '#58a6ff',
    unknown:  '#8b949e',
  };

  // BASE      : path prefix for all API calls  (window.MW_BASE,      default "")
  // TILE_BASE : base URL for all tile requests (window.MW_TILE_BASE, default BASE + "/tiles")
  const BASE      = (window.MW_BASE      || '').replace(/\/$/, '');
  const TILE_BASE = (window.MW_TILE_BASE !== undefined && window.MW_TILE_BASE !== null)
    ? String(window.MW_TILE_BASE).replace(/\/$/, '')
    : BASE + '/tiles';

  const THEMES = {
    dark: {
      url: TILE_BASE + '/dark/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://carto.com/">CartoDB</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    light: {
      url: TILE_BASE + '/light/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://carto.com/">CartoDB</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
    streets: {
      url: TILE_BASE + '/streets/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    satellite: {
      url: TILE_BASE + '/satellite/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
    },
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  let map;
  let tileLayer;
  // id → { leafletMarker (null for DC-owned alerts), data }
  let markerMap    = {};
  let geoBoundsMap = {};  // id → L.Rectangle (hover overlay)
  let clusterGroup;       // L.markerClusterGroup
  let activeMarkerId = null;
  let activeDCName   = null;  // currently open DC panel
  let ws;
  let wsReconnectTimer;
  let effects = {};
  // Heatmap region definitions fetched from /api/config; read by heatmap.js effect.
  let heatmapRegions = [];

  // DC baseline markers: name → { leafletMarker, alerts: {alertId→data}, lat, lng }
  let dcMarkers = {};

  // ── Spatial selection state ───────────────────────────────────────────────────
  let selectionMode      = false;
  let selectStart        = null;   // L.LatLng where drag began
  let selectRect         = null;   // L.Rectangle shown while dragging
  let selectedSubLayers  = [];     // [{ sublayer, key }] — for color restoration

  // ── SG Overlay layers (all lazy-loaded, all off by default) ──────────────────
  // Each entry: { layer, visible, loading }

  const layerState = {
    division:  { layer: null, visible: false, loading: false },
    roads:     { layer: null, visible: false, loading: false },
    cycling:   { layer: null, visible: false, loading: false },
    mrt:       { layer: null, visible: false, loading: false },
    busStops:  { layer: null, visible: false, loading: false },
    busRoutes: { layer: null, visible: false, loading: false },
  };

  // Map layer key → { geojsonFile, geoJSONOptions, cmdSuffix }
  const LAYER_DEFS = {
    division: {
      file: 'sg-npc-boundary',
      options: { style: _styleNPC, onEachFeature: _onEachNPC },
      cmd: 'division',
    },
    roads: {
      file: 'sg-roads',
      options: { style: _styleRoads },
      cmd: 'roads',
    },
    cycling: {
      file: 'sg-cycling',
      options: { style: _styleCycling },
      cmd: 'cycling',
    },
    mrt: {
      file: 'sg-mrt',
      options: { style: _styleMRT, onEachFeature: _onEachMRT },
      cmd: 'mrt',
    },
    busStops: {
      file: 'sg-bus-stops',
      options: {
        pointToLayer: (_f, latlng) => L.circleMarker(latlng, {
          radius: 3, fillColor: '#f59e0b', color: '#f59e0b',
          weight: 1, opacity: 0.8, fillOpacity: 0.6,
        }),
        onEachFeature: _onEachBusStop,
      },
      cmd: 'busstops',
    },
    busRoutes: {
      file: 'sg-bus-routes',
      options: { style: _styleBusRoutes, onEachFeature: _onEachBusRoute },
      cmd: 'busroutes',
    },
  };

  // ── Initialise map ────────────────────────────────────────────────────────────

  // Singapore bounding box — matches geo/slice.go RegionBounds["SG"]
  const SG_BOUNDS = [[1.159, 103.605], [1.482, 104.088]];

  function init() {
    map = L.map('map', {
      zoomControl:     false,   // we provide our own zoom UI
      preferCanvas:    true,
    }).fitBounds(SG_BOUNDS, { padding: [20, 20] });

    // Zoom control — bottom-right so it doesn't overlap the toolbar.
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Sync zoom slider whenever map zoom changes.
    map.on('zoom', () => {
      const slider = document.getElementById('zoom-slider');
      if (slider) slider.value = map.getZoom();
    });

    tileLayer = L.tileLayer(THEMES.dark.url, {
      attribution: THEMES.dark.attribution,
      maxZoom: 19,
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      chunkedLoading: true,
      zoomToBoundsOnClick: false,
      iconCreateFunction(cluster) {
        // Severity order: worst → best
        const SEV_ORDER = ['critical','warning','high','medium','low','info','test','debug','unknown'];
        let worstIdx = SEV_ORDER.length - 1;
        for (const m of cluster.getAllChildMarkers()) {
          const idx = SEV_ORDER.indexOf(m._mwSev || 'unknown');
          if (idx !== -1 && idx < worstIdx) worstIdx = idx;
        }
        const sev = SEV_ORDER[worstIdx];
        const ev  = (window.MW_EVENTS && window.MW_EVENTS[sev]) || { emoji: '⚠️', color: '#8b949e', bg: 'rgba(139,148,158,0.15)' };
        const n   = cluster.getChildCount();
        const html =
          `<div style="width:40px;height:40px;border-radius:50%;` +
          `display:flex;flex-direction:column;align-items:center;justify-content:center;` +
          `background:${ev.bg};border:2px solid ${ev.color};gap:1px">` +
            `<span style="font-size:15px;line-height:1">${ev.emoji}</span>` +
            `<span style="font-size:9px;font-weight:700;color:${ev.color};line-height:1">${n}</span>` +
          `</div>`;
        return L.divIcon({ className: '', html, iconSize: [40, 40], iconAnchor: [20, 20] });
      },
    });
    clusterGroup.addTo(map);

    // Keyboard shortcut: Esc cancels selection or closes panel.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (selectionMode) _disableSelect();
        else MapWatch.closePanel();
      }
    });

    // Drag-to-select map events.
    map.on('mousedown', _onSelectMouseDown);
    map.on('mousemove', _onSelectMouseMove);
    map.on('mouseup',   _onSelectMouseUp);

    // Mouse coordinate display (bottom-left corner).
    const coordEl = document.getElementById('map-coords');
    if (coordEl) {
      map.on('mousemove', (e) => {
        coordEl.style.display = 'block';
        coordEl.textContent = e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4);
      });
      map.on('mouseout', () => { coordEl.style.display = 'none'; });
    }

    // Set initial zoom slider value.
    const slider = document.getElementById('zoom-slider');
    if (slider) slider.value = map.getZoom();

    // Fetch runtime config (Prometheus external URL, locations, layers, etc.) from server.
    fetchConfig();
    connectWS();
  }

  // ── Runtime config ────────────────────────────────────────────────────────────

  function fetchConfig() {
    fetch(BASE + '/api/config')
      .then(r => r.json())
      .then(cfg => {
        if (cfg && cfg.locations && cfg.locations.length) initDCMarkers(cfg.locations);
        if (cfg && Array.isArray(cfg.heatmapRegions)) {
          heatmapRegions = cfg.heatmapRegions;
          window.MapWatch.heatmapRegions = heatmapRegions;
          // Markers may have already arrived via WS before config loaded.
          // Re-run effects so the heatmap can draw with the now-known regions.
          runEffects({ type: 'config.loaded' });
        }
        // Show or hide layer buttons based on which GeoJSON files exist on disk
        // (reported by the server in availableLayers — no HEAD probes needed).
        for (const [key] of Object.entries(LAYER_DEFS)) {
          const available = cfg.availableLayers && cfg.availableLayers[key];
          const btn = document.getElementById('btn-layer-' + key.toLowerCase());
          if (btn) btn.style.display = available ? '' : 'none';
        }
        // Auto-enable layers configured in mapwatch.yaml (only if file is present).
        if (cfg.layers) {
          for (const [key, enabled] of Object.entries(cfg.layers)) {
            if (enabled && layerState[key]) {
              const btn = document.getElementById('btn-layer-' + key.toLowerCase());
              if (btn && btn.style.display !== 'none') _toggleLayer(key, btn);
            }
          }
        }
      })
      .catch(() => { /* use defaults */ });
  }

  // ── DC baseline markers ───────────────────────────────────────────────────────
  //
  // Known infrastructure locations from config are shown as small green "healthy"
  // dots.  When alerts fire for a DC, its dot changes colour/size and shows a count
  // badge.  All alerts for one DC are aggregated into a single clickable marker.

  function initDCMarkers(locations) {
    for (const loc of locations) {
      const lm = L.marker([loc.lat, loc.lng], {
        icon: makeDCIcon(0, null),
        zIndexOffset: -200,   // keep below alert markers
      });
      lm.bindTooltip(makeDCTooltipHtml(loc.name, {}), {
        permanent: false, direction: 'top', className: 'mw-tooltip', opacity: 1,
      });
      lm.on('click', () => { if (!selectionMode) MapWatch.openDCPanel(loc.name); });
      dcMarkers[loc.name] = { leafletMarker: lm, alerts: {}, lat: loc.lat, lng: loc.lng };
      lm.addTo(map);   // DC markers live directly on the map, not in cluster/spread
    }

    // Alerts may have arrived via WS before config loaded (dcMarkers was empty).
    // Re-aggregate any individual markers that belong to a known DC.
    for (const [id, entry] of Object.entries(markerMap)) {
      const dcName = getDCForAlert(entry.data);
      if (!dcName) continue;
      // Remove the stray individual Leaflet marker from the cluster layer.
      if (entry.leafletMarker) {
        clusterGroup.removeLayer(entry.leafletMarker);
        if (geoBoundsMap[id]) { map.removeLayer(geoBoundsMap[id]); delete geoBoundsMap[id]; }
        entry.leafletMarker = null;
      }
      dcMarkers[dcName].alerts[id] = entry.data;
      updateDCMarker(dcName);
    }
  }

  /**
   * Build a Leaflet DivIcon for a DC marker.
   * @param {number}      alertCount   number of active alerts (0 = healthy)
   * @param {string|null} worstSev     worst severity among active alerts
   */
  function makeDCIcon(alertCount, worstSev) {
    let color, pulse, dotSize;
    if (alertCount === 0) {
      color   = '#3fb950';  // green — healthy
      pulse   = 'mw-breathe';
      dotSize = 14;
    } else if (worstSev === 'critical') {
      color   = SEVERITY_COLORS.critical;
      pulse   = 'mw-pulse';
      dotSize = 20;
    } else if (worstSev === 'warning') {
      color   = SEVERITY_COLORS.warning;
      pulse   = '';
      dotSize = 18;
    } else {
      color   = SEVERITY_COLORS.info;
      pulse   = '';
      dotSize = 16;
    }

    const margin  = (22 - dotSize) / 2;
    const badge   = alertCount > 1
      ? `<span class="mw-dc-badge">${alertCount > 99 ? '99+' : alertCount}</span>`
      : '';

    return L.divIcon({
      className: '',
      html: `<div class="mw-dc-wrap">` +
              `<div class="mw-marker ${pulse}" ` +
                   `style="background:${color};border-color:${color};` +
                          `width:${dotSize}px;height:${dotSize}px;margin:${margin}px">` +
              `</div>${badge}</div>`,
      iconSize:      [28, 28],
      iconAnchor:    [14, 14],
      tooltipAnchor: [14, 0],
    });
  }

  /** Tooltip content for a DC marker — shows up to 3 alerts, then "+N more". */
  function makeDCTooltipHtml(name, alerts) {
    const list  = Object.values(alerts);
    const count = list.length;

    if (count === 0) {
      return `<div class="mw-tt">` +
               `<div class="mw-tt-title">${e(name)}</div>` +
               `<div class="mw-tt-sev" style="color:#3fb950">HEALTHY</div>` +
             `</div>`;
    }

    const worst   = worstSeverityOf(list);
    const preview = list.slice(0, 3).map(a => {
      const col = severityColor(a.severity || 'unknown');
      return `<div class="mw-tt-row" style="color:${col}">● ${e(a.alertname || a.id)}</div>`;
    }).join('');
    const more = count > 3
      ? `<div class="mw-tt-row" style="color:#8b949e">…and ${count - 3} more</div>`
      : '';

    return `<div class="mw-tt">` +
             `<div class="mw-tt-title">${e(name)}</div>` +
             `<div class="mw-tt-sev" style="color:${severityColor(worst)}">` +
               `${count} ALERT${count !== 1 ? 'S' : ''}` +
             `</div>` +
             preview + more +
             `<div class="mw-tt-hint">Click to view all ↗</div>` +
           `</div>`;
  }

  /** Return the worst severity label from an array of alert data objects. */
  function worstSeverityOf(alerts) {
    for (const a of alerts) if (a.severity === 'critical') return 'critical';
    for (const a of alerts) if (a.severity === 'warning')  return 'warning';
    return alerts.length ? (alerts[0].severity || 'unknown') : 'unknown';
  }

  /**
   * Find which DC (if any) owns this alert.
   * Checks labels.datacenter and labels.location (in that order) against dcMarkers.
   */
  function getDCForAlert(data) {
    for (const key of ['datacenter', 'location']) {
      if (data.labels && data.labels[key]) {
        const name = data.labels[key];
        if (dcMarkers[name]) return name;
      }
    }
    return null;
  }

  /** Recompute and redraw the DC marker icon + tooltip after its alert set changes. */
  function updateDCMarker(dcName) {
    const dc = dcMarkers[dcName];
    if (!dc) return;
    const list  = Object.values(dc.alerts);
    const count = list.length;
    const worst = count > 0 ? worstSeverityOf(list) : null;

    dc.leafletMarker.setIcon(makeDCIcon(count, worst));
    dc.leafletMarker.unbindTooltip();
    dc.leafletMarker.bindTooltip(makeDCTooltipHtml(dcName, dc.alerts), {
      permanent: false, direction: 'top', className: 'mw-tooltip', opacity: 1,
    });

    // Live-refresh the panel if this DC's panel is currently open.
    if (activeDCName === dcName) renderDCPanel(dcName, dc.alerts);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────────

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}${BASE}/ws`;
    console.log('[MapWatch] WS connecting to', url);
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[MapWatch] WS connected');
      document.getElementById('ws-status').classList.add('connected');
      clearTimeout(wsReconnectTimer);
    };

    ws.onclose = (evt) => {
      console.warn('[MapWatch] WS closed code=' + evt.code + ' reason=' + (evt.reason || 'none') + ' — reconnecting in 3s');
      document.getElementById('ws-status').classList.remove('connected');
      wsReconnectTimer = setTimeout(connectWS, 3000);
    };

    ws.onerror = (err) => {
      console.error('[MapWatch] WS error', err);
      ws.close();
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      console.log('[MapWatch] WS event', msg.type, msg.marker ? 'id=' + msg.marker.id + ' sev=' + msg.marker.severity : 'id=' + msg.id);
      handleWSEvent(msg);
    };
  }

  function handleWSEvent(msg) {
    switch (msg.type) {
      case 'marker.add':    upsertMarker(msg.marker, true);  break;
      case 'marker.update': upsertMarker(msg.marker, false); break;
      case 'marker.remove': removeMarker(msg.id);            break;
    }
    runEffects(msg);
  }

  // ── Marker management ─────────────────────────────────────────────────────────

  function effectiveLat(m) {
    return m.lat + (m.offset ? m.offset.Lat : 0);
  }

  function effectiveLng(m) {
    return m.lng + (m.offset ? m.offset.Lng : 0);
  }

  function makeIcon(data) {
    const color = severityColor(data.severity);
    const pulse = (data.severity === 'critical') ? 'mw-pulse' : '';
    return L.divIcon({
      className: '',
      html: `<div class="mw-marker ${pulse}" style="background:${color};border-color:${color}"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      tooltipAnchor: [10, 0],
    });
  }

  function makeTooltipHtml(d) {
    const sev      = d.severity || 'unknown';
    const color    = severityColor(sev);
    const instance = (d.labels && d.labels.instance) || '';
    const dc       = (d.labels && (d.labels.datacenter || d.labels.location)) || '';
    const summary  = (d.annotations && d.annotations.summary) || '';

    let html = `<div class="mw-tt">
      <div class="mw-tt-title">${e(d.alertname || d.id)}</div>
      <div class="mw-tt-sev" style="color:${color}">${sev.toUpperCase()}</div>`;

    if (instance) html += `<div class="mw-tt-row">${e(instance)}</div>`;
    if (dc)       html += `<div class="mw-tt-row">DC: ${e(dc)}</div>`;
    if (summary)  html += `<div class="mw-tt-row">${e(summary)}</div>`;

    html += `<div class="mw-tt-hint">Click for details ↗</div></div>`;
    return html;
  }

  function upsertMarker(data, isNew) {
    console.log('[MapWatch] upsertMarker', isNew ? 'ADD' : 'UPDATE', 'id=' + data.id,
                'sev=' + data.severity, 'lat=' + data.lat, 'lng=' + data.lng);

    // ── DC-owned alert: aggregate into the DC baseline marker ─────────────────
    const dcName = getDCForAlert(data);
    if (dcName) {
      dcMarkers[dcName].alerts[data.id] = data;
      updateDCMarker(dcName);
      // Keep a markerMap entry (null leafletMarker) so openPanel / loadLinks work.
      if (markerMap[data.id]) {
        markerMap[data.id].data = data;
      } else {
        markerMap[data.id] = { leafletMarker: null, data };
      }
      return;
    }

    // ── Regular alert: individual Leaflet marker ───────────────────────────────
    if (markerMap[data.id]) {
      const { leafletMarker } = markerMap[data.id];
      if (leafletMarker) {
        const lat = effectiveLat(data);
        const lng = effectiveLng(data);
        leafletMarker.setLatLng([lat, lng]);
        leafletMarker.setIcon(makeIcon(data));
        leafletMarker.unbindTooltip();
        leafletMarker.bindTooltip(makeTooltipHtml(data), {
          permanent: false, direction: 'top', className: 'mw-tooltip', opacity: 1,
        });
      }
      markerMap[data.id].data = data;
    } else {
      const lat = effectiveLat(data);
      const lng = effectiveLng(data);
      const lm  = L.marker([lat, lng], { icon: makeIcon(data) });

      lm.bindTooltip(makeTooltipHtml(data), {
        permanent: false, direction: 'top', className: 'mw-tooltip', opacity: 1,
      });
      lm.on('click', () => { if (!selectionMode) MapWatch.openPanel(data.id); });

      markerMap[data.id] = { leafletMarker: lm, data };
      addToActiveLayer(lm);
      console.log('[MapWatch] marker added to layer, pulse=' + (data.severity === 'critical'));
    }
  }

  function removeMarker(id) {
    if (!markerMap[id]) return;
    const { leafletMarker, data } = markerMap[id];

    // Remove from DC aggregation if this was a DC-owned alert.
    const dcName = getDCForAlert(data);
    if (dcName && dcMarkers[dcName]) {
      delete dcMarkers[dcName].alerts[id];
      updateDCMarker(dcName);
    }

    if (leafletMarker) {
      clusterGroup.removeLayer(leafletMarker);
    }
    delete markerMap[id];

    if (geoBoundsMap[id]) {
      map.removeLayer(geoBoundsMap[id]);
      delete geoBoundsMap[id];
    }
    if (activeMarkerId === id) MapWatch.closePanel();
  }

  function addToActiveLayer(lm) {
    clusterGroup.addLayer(lm);
  }

  function severityColor(sev) {
    return SEVERITY_COLORS[sev] || SEVERITY_COLORS.unknown;
  }

  // ── Effects plugin system ─────────────────────────────────────────────────────

  function registerEffect(name, fn) {
    effects[name] = fn;
  }

  function runEffects(event) {
    for (const fn of Object.values(effects)) {
      try { fn(event, map, markerMap); } catch (err) {
        console.error('effect error:', err);
      }
    }
  }

  // ── Theme switcher ────────────────────────────────────────────────────────────

  function setTheme(name) {
    const t = THEMES[name];
    if (!t) return;
    tileLayer.setUrl(t.url);
    ['dark', 'light', 'streets', 'satellite'].forEach((n) => {
      const btn = document.getElementById('btn-' + n);
      if (btn) btn.classList.toggle('active', n === name);
    });
  }

  // ── Map navigation ────────────────────────────────────────────────────────────

  /** Fly back to the default Singapore full-island view. */
  function resetToSG() {
    map.fitBounds(SG_BOUNDS, { padding: [20, 20] });
  }

  /** Set map zoom from slider input. */
  function setZoom(z) {
    map.setZoom(parseInt(z, 10));
  }

  // ── SG overlay layer system ───────────────────────────────────────────────────
  //
  // All layers are optional and lazy-loaded on first toggle.
  // Style helpers are prefixed with _ to distinguish from public API.

  function _styleNPC(_feature) {
    return { color: '#4fc3f7', weight: 1.5, opacity: 0.8, fillColor: '#4fc3f7', fillOpacity: 0.06 };
  }

  function _onEachNPC(feature, layer) {
    const p = feature.properties || {};
    const name = p.NPC_NAME || p.Name || p.name || '';
    const div  = p.DIVISION  || p.Division  || '';
    if (name) {
      layer.bindTooltip(
        `<div class="mw-tt-title">${e(name)}</div>` +
        (div ? `<div class="mw-tt-row">Division: ${e(div)}</div>` : ''),
        { sticky: true, className: 'mw-tooltip', opacity: 1 }
      );
    }
  }

  function _styleRoads(feature) {
    const hw = (feature.properties && feature.properties.highway) || '';
    const weight = /motorway|trunk/.test(hw) ? 3 : 2;
    return { color: '#f97316', weight, opacity: 0.65, fillOpacity: 0 };
  }

  function _styleCycling(_feature) {
    return { color: '#4ade80', weight: 2, opacity: 0.8, fillOpacity: 0, dashArray: '6,4' };
  }

  function _styleMRT(_feature) {
    return { color: '#e11d48', weight: 3, opacity: 0.9, fillOpacity: 0 };
  }

  function _onEachMRT(feature, layer) {
    const p = feature.properties || {};
    const name = p.name || p.ref || '';
    if (name) {
      layer.bindTooltip(`<div class="mw-tt-title">${e(name)}</div>`,
        { sticky: true, className: 'mw-tooltip', opacity: 1 });
    }
  }

  function _onEachBusStop(feature, layer) {
    const p = feature.properties || {};
    if (p.name || p.code) {
      layer.bindTooltip(
        `<div class="mw-tt-title">${e(p.name || p.code)}</div>` +
        (p.road ? `<div class="mw-tt-row">${e(p.road)}</div>` : '') +
        (p.code ? `<div class="mw-tt-row">Stop: ${e(p.code)}</div>` : ''),
        { sticky: true, className: 'mw-tooltip', opacity: 1 }
      );
    }
  }

  function _styleBusRoutes(_feature) {
    return { color: '#60a5fa', weight: 1, opacity: 0.45, fillOpacity: 0 };
  }

  function _onEachBusRoute(feature, layer) {
    const p = feature.properties || {};
    if (p.service) {
      layer.bindTooltip(
        `<div class="mw-tt-title">Bus ${e(p.service)}</div>` +
        (p.operator  ? `<div class="mw-tt-row">${e(p.operator)}</div>` : '') +
        (p.direction ? `<div class="mw-tt-row">Dir ${e(p.direction)}</div>` : ''),
        { sticky: true, className: 'mw-tooltip', opacity: 1 }
      );
    }
  }

  /**
   * Generic layer toggle factory.
   * Lazy-fetches /api/geojson/{def.file} on first call, then just shows/hides.
   */
  function _toggleLayer(key, btn) {
    const state = layerState[key];
    const def   = LAYER_DEFS[key];
    if (!state || !def || state.loading) return;

    if (state.layer) {
      state.visible = !state.visible;
      if (state.visible) { state.layer.addTo(map); btn && btn.classList.add('active'); }
      else               { state.layer.remove();   btn && btn.classList.remove('active'); }
      return;
    }

    state.loading = true;
    const origText = btn && btn.textContent;
    if (btn) btn.textContent = 'Loading…';

    fetch(BASE + '/api/geojson/' + def.file)
      .then(r => {
        if (r.status === 404) {
          // File not downloaded yet — silently hide the button.
          state.loading = false;
          if (btn) btn.style.display = 'none';
          console.warn('[MapWatch] ' + def.file + ' not found — run: mapwatch download-sg-' + def.cmd);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(geojson => {
        if (!geojson) return;
        state.layer   = L.geoJSON(geojson, def.options).addTo(map);
        state.visible = true;
        state.loading = false;
        if (btn) { btn.textContent = origText; btn.classList.add('active'); }
      })
      .catch(err => {
        state.loading = false;
        if (btn) btn.textContent = origText;
        console.error('[MapWatch] ' + key + ' layer load failed:', err);
      });
  }

  // ── Drag-to-select (spatial query) ───────────────────────────────────────────
  //
  // Generic rectangle selection over ALL currently-visible GeoJSON layers.
  // Works with any layer in layerState: bus stops, bus routes, MRT, roads, etc.

  const _SELECT_HIGHLIGHT = '#22d3ee';   // cyan — selection highlight colour
  const _SELECT_ORIG_STYLES = {          // per-layer default styles for restoration
    busStops:  { fillColor: '#f59e0b', color: '#f59e0b', weight: 1, opacity: 0.8, fillOpacity: 0.6 },
    busRoutes: { color: '#60a5fa', weight: 1, opacity: 0.45 },
    roads:     { color: '#f97316', opacity: 0.65 },
    cycling:   { color: '#4ade80', opacity: 0.8 },
    mrt:       { color: '#e11d48', opacity: 0.9 },
    division:  { color: '#4fc3f7', opacity: 0.8, fillOpacity: 0.06 },
  };

  const _LAYER_LABELS = {
    division:  'Divisions',
    roads:     'Roads',
    cycling:   'Cycling Paths',
    mrt:       'MRT Lines',
    busStops:  'Bus Stops',
    busRoutes: 'Bus Routes',
  };

  function toggleSelectionMode() {
    if (selectionMode) _disableSelect();
    else               _enableSelect();
  }

  function _enableSelect() {
    selectionMode = true;
    map.dragging.disable();
    map.getContainer().style.cursor = 'crosshair';
    const btn = document.getElementById('btn-select');
    if (btn) btn.classList.add('active');
  }

  function _disableSelect() {
    selectionMode = false;
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    const btn = document.getElementById('btn-select');
    if (btn) btn.classList.remove('active');
    if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
    selectStart = null;
    _clearSelectionHighlights();
    _hideSelectPanel();
  }

  function _clearSelectionHighlights() {
    const orig = _SELECT_ORIG_STYLES;
    for (const { sublayer, key } of selectedSubLayers) {
      if (typeof sublayer.setStyle === 'function') {
        sublayer.setStyle(orig[key] || {});
      }
    }
    selectedSubLayers = [];
  }

  function _onSelectMouseDown(e) {
    if (!selectionMode) return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;
    selectStart = e.latlng;
    if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
  }

  function _onSelectMouseMove(e) {
    if (!selectionMode || !selectStart) return;
    const bounds = L.latLngBounds(selectStart, e.latlng);
    if (selectRect) {
      selectRect.setBounds(bounds);
    } else {
      selectRect = L.rectangle(bounds, {
        color: _SELECT_HIGHLIGHT, weight: 1.5, fillOpacity: 0.08,
        dashArray: '5,5', interactive: false,
      }).addTo(map);
    }
  }

  function _onSelectMouseUp(e) {
    if (!selectionMode || !selectStart) return;
    const bounds = L.latLngBounds(selectStart, e.latlng);
    if (selectRect) { map.removeLayer(selectRect); selectRect = null; }
    selectStart = null;
    _clearSelectionHighlights();
    _queryAndShow(bounds);
  }

  /**
   * Flatten a GeoJSON geometry into an array of [lng, lat] coordinate pairs.
   * Handles Point, LineString, MultiLineString, Polygon, MultiPolygon.
   */
  function _flatCoords(geom) {
    switch (geom.type) {
      case 'Point':           return [geom.coordinates];
      case 'LineString':      return geom.coordinates;
      case 'MultiLineString': return geom.coordinates.flat();
      case 'Polygon':         return geom.coordinates.flat();
      case 'MultiPolygon':    return geom.coordinates.flat(2);
      default:                return [];
    }
  }

  /**
   * Returns true if any vertex of the geometry falls within the L.LatLngBounds.
   * Used for line/polygon features so that bounding-box false positives are avoided.
   */
  function _geomHitsBounds(geom, bounds) {
    return _flatCoords(geom).some(([lng, lat]) => bounds.contains([lat, lng]));
  }

  /**
   * Query ALL visible GeoJSON layers for features within bounds,
   * highlight the matching sublayers, and show the bottom panel.
   * Also queries always-visible blink-dots and (if on) heatmap regions.
   */
  function _queryAndShow(bounds) {
    const groups = {};   // key → [{ name, sub? }]

    // ── GeoJSON overlay layers ────────────────────────────────────────────────
    for (const [key, state] of Object.entries(layerState)) {
      if (!state.visible || !state.layer) continue;
      const hits = [];
      state.layer.eachLayer(sublayer => {
        let hit = false;
        if (typeof sublayer.getLatLng === 'function') {
          hit = bounds.contains(sublayer.getLatLng());
        } else if (sublayer.feature && sublayer.feature.geometry) {
          hit = _geomHitsBounds(sublayer.feature.geometry, bounds);
        }
        if (!hit || !sublayer.feature) return;

        const p = sublayer.feature.properties || {};
        // Skip sea/marine sectors (S-Sect, M-Sect) — only keep land NPC divisions.
        if (key === 'division') {
          const div = p.DIVISION || p.Division || '';
          if (!div || div.includes('Sect')) return;
        }

        hits.push({ props: p, sublayer });
        if (typeof sublayer.setStyle === 'function') {
          sublayer.setStyle({ color: _SELECT_HIGHLIGHT, fillColor: _SELECT_HIGHLIGHT, weight: 2, opacity: 1, fillOpacity: 0.75 });
        }
        selectedSubLayers.push({ sublayer, key });
      });
      if (hits.length) groups[key] = hits;
    }

    // ── DC baseline markers (always visible) ─────────────────────────────────
    const dcHits = [];
    for (const [name, dc] of Object.entries(dcMarkers)) {
      if (!bounds.contains([dc.lat, dc.lng])) continue;
      const alertCount = Object.keys(dc.alerts).length;
      const worst      = alertCount > 0 ? worstSeverityOf(Object.values(dc.alerts)) : null;
      dcHits.push({ name, alertCount, worst });
    }
    if (dcHits.length) groups['_dc'] = dcHits;

    // ── Individual alert markers (always visible) ─────────────────────────────
    const alertHits = [];
    for (const [, entry] of Object.entries(markerMap)) {
      if (!entry.leafletMarker) continue;   // DC-owned alerts have no individual marker
      if (!bounds.contains(entry.leafletMarker.getLatLng())) continue;
      alertHits.push({ data: entry.data });
    }
    if (alertHits.length) groups['_alerts'] = alertHits;

    // ── Heatmap regions (only when heatmap is toggled on) ─────────────────────
    const heatBtn = document.getElementById('btn-heatmap');
    if (heatBtn && heatBtn.classList.contains('active') && heatmapRegions.length) {
      const regionHits = [];
      for (const region of heatmapRegions) {
        if (!region.bounds) continue;
        const rb = L.latLngBounds(region.bounds[0], region.bounds[1]);
        if (bounds.intersects(rb)) regionHits.push({ region });
      }
      if (regionHits.length) groups['_heatmap'] = regionHits;
    }

    _showSelectPanel(groups);
  }

  function _showSelectPanel(groups) {
    const total = Object.values(groups).reduce((s, a) => s + a.length, 0);
    const titleEl   = document.getElementById('select-panel-title');
    const contentEl = document.getElementById('select-panel-content');
    if (!titleEl || !contentEl) return;

    titleEl.textContent = total > 0
      ? `${total} feature${total !== 1 ? 's' : ''} selected`
      : 'No features in selection';

    if (total === 0) {
      contentEl.innerHTML = '';
      document.getElementById('select-panel').classList.add('open');
      return;
    }

    let html = '';
    for (const [key, hits] of Object.entries(groups)) {
      let label, chips;

      if (key === '_dc') {
        label = 'Locations';
        chips = hits.map(({ name, alertCount, worst }) => {
          const col = alertCount > 0 ? severityColor(worst) : '#3fb950';
          const sub = alertCount > 0 ? `${alertCount} alert${alertCount !== 1 ? 's' : ''} · ${worst}` : 'healthy';
          return `<div class="sel-chip">` +
                   `<span class="sel-chip-name">${e(name)}</span>` +
                   `<span class="sel-chip-sub" style="color:${col}">${e(sub)}</span>` +
                 `</div>`;
        }).join('');

      } else if (key === '_alerts') {
        label = 'Alerts';
        chips = hits.map(({ data: d }) => {
          const sev = d.severity || 'unknown';
          return `<div class="sel-chip">` +
                   `<span class="sel-chip-name">${e(d.alertname || d.id)}</span>` +
                   `<span class="sel-chip-sub" style="color:${severityColor(sev)}">${e(sev)}</span>` +
                 `</div>`;
        }).join('');

      } else if (key === '_heatmap') {
        label = 'Heatmap Regions';
        chips = hits.map(({ region }) =>
          `<div class="sel-chip"><span class="sel-chip-name">${e(region.name)}</span></div>`
        ).join('');

      } else {
        label = _LAYER_LABELS[key] || key;
        chips = hits.map(({ props: p }) => {
          const name = p.name || p.NPC_NAME || p.Name || p.code || p.service || p.ref || '—';
          const sub  = p.road || p.operator || p.DIVISION || p.Division || '';
          return `<div class="sel-chip">` +
                   `<span class="sel-chip-name">${e(name)}</span>` +
                   (sub ? `<span class="sel-chip-sub">${e(sub)}</span>` : '') +
                 `</div>`;
        }).join('');
      }

      html += `<div class="sel-group">` +
                `<div class="sel-group-label">${e(label)} <span class="sel-group-count">${hits.length}</span></div>` +
                `<div class="sel-chips">${chips}</div>` +
              `</div>`;
    }
    contentEl.innerHTML = html;
    document.getElementById('select-panel').classList.add('open');
  }

  function _hideSelectPanel() {
    const panel = document.getElementById('select-panel');
    if (panel) panel.classList.remove('open');
  }

  // ── Side panel ────────────────────────────────────────────────────────────────

  /** Open the individual alert detail panel. */
  function openPanel(id) {
    const entry = markerMap[id];
    if (!entry) return;
    activeMarkerId = id;
    activeDCName   = null;
    renderPanel(entry.data);
    document.getElementById('panel').classList.add('open');
    loadLinks(id);
  }

  /**
   * Open the DC aggregated panel showing all alerts for a datacenter location.
   * Each alert row is clickable to drill into individual alert details.
   */
  function openDCPanel(dcName) {
    const dc = dcMarkers[dcName];
    if (!dc) return;
    activeDCName   = dcName;
    activeMarkerId = null;
    renderDCPanel(dcName, dc.alerts);
    document.getElementById('panel').classList.add('open');
  }

  function closePanel() {
    document.getElementById('panel').classList.remove('open');
    activeMarkerId = null;
    activeDCName   = null;
  }

  /**
   * Render the DC aggregated panel.
   * Shows a severity summary bar, severity chips, and a scrollable alert list.
   */
  function renderDCPanel(dcName, alerts) {
    const alertList = Object.values(alerts);
    document.getElementById('panel-title').textContent = dcName;
    const content = document.getElementById('panel-content');

    if (alertList.length === 0) {
      content.innerHTML =
        `<div style="text-align:center;padding:32px 0;color:#3fb950">` +
          `<div style="font-size:36px;margin-bottom:10px">✓</div>` +
          `<div style="font-weight:600;font-size:14px">All systems operational</div>` +
        `</div>`;
      return;
    }

    // Severity summary bar — proportional colour segments.
    const sevCounts = {};
    for (const a of alertList) {
      const s = a.severity || 'unknown';
      sevCounts[s] = (sevCounts[s] || 0) + 1;
    }
    const total = alertList.length;
    const SEV_ORDER = ['critical', 'warning', 'info', 'unknown'];
    const barSegs = SEV_ORDER
      .filter(s => sevCounts[s])
      .map(s => {
        const pct = ((sevCounts[s] / total) * 100).toFixed(1);
        return `<div class="dc-sev-seg" style="width:${pct}%;background:${severityColor(s)}" ` +
                    `title="${sevCounts[s]} ${s}"></div>`;
      }).join('');

    const chips = SEV_ORDER
      .filter(s => sevCounts[s])
      .map(s => {
        const cls = SEVERITY_COLORS[s] ? s : 'unknown';
        return `<span class="severity-badge sev-${cls}">${sevCounts[s]} ${s}</span>`;
      }).join(' ');

    // Sort alerts: critical first, then warning, info, unknown, then by startsAt desc.
    const sevRank = { critical: 0, warning: 1, info: 2, unknown: 3 };
    const sorted  = [...alertList].sort((a, b) => {
      const sr = (sevRank[a.severity] || 3) - (sevRank[b.severity] || 3);
      if (sr !== 0) return sr;
      return new Date(b.startsAt || 0) - new Date(a.startsAt || 0);
    });

    const rows = sorted.map(a => {
      const sev      = a.severity || 'unknown';
      const cls      = SEVERITY_COLORS[sev] ? sev : 'unknown';
      const inst     = (a.labels && a.labels.instance) || '';
      const dur      = a.startsAt ? timeSince(new Date(a.startsAt)) : '';
      const summary  = (a.annotations && a.annotations.summary) || '';
      return `<div class="dc-alert-item" onclick="MapWatch.openPanel('${e(a.id)}')">` +
               `<span class="severity-badge sev-${cls}">${sev}</span>` +
               `<div class="dc-alert-body">` +
                 `<div class="dc-alert-name">${e(a.alertname || a.id)}</div>` +
                 (inst    ? `<div class="dc-alert-meta">${e(inst)}${dur ? ' · ' + e(dur) : ''}</div>` : '') +
                 (summary ? `<div class="dc-alert-summary">${e(summary)}</div>` : '') +
               `</div>` +
               `<span class="dc-alert-arrow">↗</span>` +
             `</div>`;
    }).join('');

    content.innerHTML =
      `<div style="margin-bottom:14px">` +
        `<div class="dc-sev-bar">${barSegs}</div>` +
        `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${chips}</div>` +
      `</div>` +
      `<div class="panel-section">` +
        `<h3>${total} Active Alert${total !== 1 ? 's' : ''}</h3>` +
        `<div id="dc-alert-list">${rows}</div>` +
      `</div>`;
  }

  function renderPanel(m) {
    const dur = m.startsAt ? timeSince(new Date(m.startsAt)) : '—';
    const sev = m.severity || 'unknown';
    const badgeClass = 'sev-' + (SEVERITY_COLORS[sev] ? sev : 'unknown');

    document.getElementById('panel-title').textContent = m.alertname || m.id;

    const content = document.getElementById('panel-content');
    content.innerHTML = `
      <span class="severity-badge ${badgeClass}">${sev}</span>

      <div class="meta-row"><strong>Instance:</strong> ${e(m.labels && m.labels.instance || '—')}</div>
      <div class="meta-row"><strong>Location:</strong> ${e(m.labels && (m.labels.location || m.labels.datacenter) || '—')}</div>
      <div class="meta-row"><strong>Duration:</strong> ${e(dur)}</div>
      ${m.annotations && m.annotations.summary ? `<div class="meta-row"><strong>Summary:</strong> ${e(m.annotations.summary)}</div>` : ''}
      ${m.annotations && m.annotations.description ? `<div class="meta-row"><strong>Description:</strong> ${e(m.annotations.description)}</div>` : ''}

      <div class="panel-section">
        <h3>Prometheus Metrics</h3>
        <div id="links-loading">Loading…</div>
        <div id="links-error"></div>
        <div id="links-container"></div>
      </div>

      <div class="panel-section">
        <details>
          <summary>Raw labels</summary>
          <div class="labels-grid" style="margin-top:8px">
            ${Object.entries(m.labels || {}).map(([k, v]) =>
              `<span class="label-key">${e(k)}</span><span class="label-value">${e(v)}</span>`
            ).join('')}
          </div>
        </details>
      </div>
    `;
  }

  function loadLinks(id) {
    const loading   = document.getElementById('links-loading');
    const errEl     = document.getElementById('links-error');
    const container = document.getElementById('links-container');

    if (!container) return;
    container.innerHTML = '';
    if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (loading) loading.style.display = 'block';

    fetch(BASE + `/api/markers/${encodeURIComponent(id)}/links`)
      .then(r => r.json())
      .then(links => {
        if (loading) loading.style.display = 'none';
        if (!Array.isArray(links) || links.length === 0) {
          if (errEl) { errEl.textContent = 'No metrics configured for this alert.'; errEl.style.display = 'block'; }
          return;
        }
        container.innerHTML = links.map(l =>
          `<a class="prom-link" href="${e(l.url)}" target="_blank" rel="noopener noreferrer">
            <span>${e(l.label)}</span>
            <span class="prom-link-icon">↗</span>
          </a>`
        ).join('');
      })
      .catch(err => {
        if (loading) loading.style.display = 'none';
        if (errEl)   { errEl.textContent = 'Failed to load links: ' + err.message; errEl.style.display = 'block'; }
      });
  }

  function timeSince(date) {
    const secs = Math.floor((Date.now() - date) / 1000);
    if (secs < 60)    return secs + 's';
    if (secs < 3600)  return Math.floor(secs / 60) + 'm';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h';
    return Math.floor(secs / 86400) + 'd';
  }

  // HTML-escape helper
  function e(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function clearMap() {
    const ids = Object.keys(markerMap);
    for (const id of ids) removeMarker(id);
    // Reset DC alert counts after clearing all markers.
    for (const name of Object.keys(dcMarkers)) updateDCMarker(name);
  }

  window.MapWatch = {
    registerEffect,
    setTheme,
    openPanel,
    openDCPanel,
    closePanel,
    resetToSG,
    setZoom,
    clearMap,
    // Layer toggles — each wired to its toolbar button via onclick.
    toggleLayer: _toggleLayer,
    // Drag-to-select toggle.
    toggleSelect: toggleSelectionMode,
    // Heatmap region definitions — populated from /api/config by fetchConfig();
    // read by heatmap.js on every effect invocation.
    heatmapRegions: [],
    // Exposed for static export mode (pre-load markers without WS)
    loadStaticMarkers(markers) {
      for (const m of markers) upsertMarker(m, true);
    },
  };

  // Boot
  document.addEventListener('DOMContentLoaded', init);
})();
