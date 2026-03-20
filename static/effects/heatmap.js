/**
 * Effect: choropleth heatmap
 *
 * Draws filled L.rectangle overlays for each configured heatmap.region,
 * similar to a US state-level choropleth map.  Each active region also gets
 * a floating count label at the top edge of the rectangle.
 *
 * Color priority:
 *   1. region.color from mapwatch.yaml  (user-configured, e.g. "#4a9eff")
 *   2. Severity-based colour            (critical=red, warning=amber, info=blue)
 *
 * Requires heatmap.regions with `bounds` in mapwatch.yaml:
 *   bounds: [[lat_sw, lng_sw], [lat_ne, lng_ne]]
 *
 * Regions with no active alerts are not drawn.
 * Toggle via the "Heatmap" toolbar button → MapWatch.toggleHeatmap().
 */
(function () {
  let choroplethLayer = null;  // L.LayerGroup of rectangles + labels
  let heatVisible     = true;  // on by default
  let _map            = null;

  // ── Region matching ───────────────────────────────────────────────────────────
  // Matches a marker to a region by checking if its lat/lng falls inside the
  // rectangle bounds [[lat_sw, lng_sw], [lat_ne, lng_ne]].

  function markerToRegion(lat, lng, regions) {
    if (lat == null || lng == null) return null;
    for (const region of regions) {
      const b = region.bounds;
      if (!b) continue;
      if (lat >= b[0][0] && lat <= b[1][0] && lng >= b[0][1] && lng <= b[1][1]) {
        return region;
      }
    }
    return null;
  }

  // ── Severity helpers ──────────────────────────────────────────────────────────

  const SEVERITY_RANK = { critical: 3, warning: 2, info: 1, unknown: 1 };

  function severityWeight(sev) {
    if (sev === 'critical') return 1.0;
    if (sev === 'warning')  return 0.6;
    return 0.3;
  }

  function worstSeverity(a, b) {
    return (SEVERITY_RANK[b] || 1) > (SEVERITY_RANK[a] || 1) ? b : a;
  }

  // ── Color mapping ─────────────────────────────────────────────────────────────

  function severityColor(sev) {
    if (sev === 'critical') return '#f85149';
    if (sev === 'warning')  return '#e3b341';
    return '#58a6ff';
  }

  // Opacity starts at 0.50 and ramps up to 0.85 as alerts accumulate.
  function fillOpacity(totalWeight) {
    return Math.min(0.50 + totalWeight * 0.08, 0.85);
  }

  // ── Count label ───────────────────────────────────────────────────────────────

  /**
   * Returns a Leaflet marker with a styled count badge, anchored at the
   * top-centre of the rectangle (NE-lat, midpoint-lng).
   */
  function makeCountLabel(bounds, color, count, name) {
    const topLat    = bounds[1][0];
    const centerLng = (bounds[0][1] + bounds[1][1]) / 2;
    const label     = count + ' alert' + (count !== 1 ? 's' : '');

    const html =
      '<div style="' +
        'transform:translateX(-50%);' +
        'background:' + color + ';' +
        'color:#fff;' +
        'font-size:11px;font-weight:700;' +
        'padding:2px 7px;' +
        'border-radius:3px;' +
        'white-space:nowrap;' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.55);' +
        'pointer-events:none;' +
      '">' + name + ' · ' + label + '</div>';

    return L.marker([topLat, centerLng], {
      icon: L.divIcon({ className: '', html, iconAnchor: [0, 0] }),
      interactive: false,
      zIndexOffset: 500,
    });
  }

  // ── Choropleth redraw ─────────────────────────────────────────────────────────

  function redraw(markerMap, regions) {
    if (!regions || regions.length === 0 || !_map) {
      console.debug('[heatmap] redraw skipped: no regions or map not ready');
      return;
    }

    // Bucket markers by region (spatial containment check against bounds).
    const buckets = {};
    let totalMarkers = 0;
    for (const { data } of Object.values(markerMap)) {
      totalMarkers++;
      const region = markerToRegion(data.lat, data.lng, regions);
      if (!region) {
        console.debug('[heatmap] marker lat=%s lng=%s matched no region', data.lat, data.lng);
        continue;
      }
      if (!buckets[region.name]) {
        buckets[region.name] = { totalWeight: 0, worstSev: null, count: 0 };
      }
      buckets[region.name].totalWeight += severityWeight(data.severity);
      buckets[region.name].worstSev    = worstSeverity(buckets[region.name].worstSev, data.severity);
      buckets[region.name].count++;
    }

    console.debug('[heatmap] redraw: %d markers, %d regions active out of %d configured',
      totalMarkers, Object.keys(buckets).length, regions.length);

    // Rebuild the layer group.
    if (!choroplethLayer) choroplethLayer = L.layerGroup();
    choroplethLayer.clearLayers();

    for (const region of regions) {
      if (!region.bounds || !region.bounds[0] || !region.bounds[1]) {
        console.warn('[heatmap] region "%s" has no bounds — skipping.', region.name);
        continue;
      }

      const bucket = buckets[region.name];  // may be undefined (no alerts)

      // Empty region: grey outline, no fill, no label.
      if (!bucket) {
        L.rectangle(region.bounds, {
          color:       '#8b949e',
          weight:      1,
          opacity:     0.5,
          fillOpacity: 0,
          interactive: true,
        })
          .bindTooltip('<b>' + region.name + '</b><br><span style="color:#8b949e">No active alerts</span>',
            { sticky: true, className: 'mw-tooltip' })
          .addTo(choroplethLayer);
        continue;
      }

      // Active region: severity colour + count label.
      const color   = region.color || severityColor(bucket.worstSev);
      const opacity = fillOpacity(bucket.totalWeight);

      console.debug('[heatmap] drawing region="%s" sev=%s weight=%.1f opacity=%.2f color=%s',
        region.name, bucket.worstSev, bucket.totalWeight, opacity, color);

      L.rectangle(region.bounds, {
        color,
        weight:      1.5,
        opacity:     0.85,
        fillColor:   color,
        fillOpacity: opacity,
        interactive: true,
      })
        .bindTooltip(
          '<b>' + region.name + '</b><br>' +
          'Severity: <b style="color:' + color + '">' + bucket.worstSev + '</b><br>' +
          'Alerts: ' + bucket.count,
          { sticky: true, className: 'mw-tooltip' }
        )
        .addTo(choroplethLayer);

      makeCountLabel(region.bounds, color, bucket.count, region.name)
        .addTo(choroplethLayer);
    }

    // Keep visible if toggle is on.
    if (heatVisible && _map) {
      choroplethLayer.addTo(_map);
    }
  }

  // ── Effect handler ────────────────────────────────────────────────────────────

  MapWatch.registerEffect('heatmap', function (event, map, markerMap) {
    if (!['marker.add', 'marker.update', 'marker.remove', 'config.loaded'].includes(event.type)) return;

    _map = map;

    const regions = window.MapWatch.heatmapRegions || [];
    console.debug('[heatmap] effect triggered: event=%s regions=%d markers=%d',
      event.type, regions.length, Object.keys(markerMap).length);

    redraw(markerMap, regions);
  });

  // ── Public toggle ─────────────────────────────────────────────────────────────

  window.MapWatch.toggleHeatmap = function () {
    heatVisible = !heatVisible;
    console.log('[heatmap] toggleHeatmap: visible=%s _map=%s layer=%s',
      heatVisible, !!_map, !!choroplethLayer);

    if (!choroplethLayer) {
      choroplethLayer = L.layerGroup();
    }
    if (!_map) {
      console.warn('[heatmap] toggleHeatmap called before map was ready');
      return;
    }
    if (heatVisible) {
      choroplethLayer.addTo(_map);
    } else {
      _map.removeLayer(choroplethLayer);
    }
  };
})();
