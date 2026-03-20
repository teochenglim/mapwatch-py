/**
 * Effect: geohash-grid
 * On marker hover, draws the geohash bounding rectangle on the map.
 * Removes it on mouse-out.
 */
MapWatch.registerEffect('geohash-grid', function (event, map, markerMap) {
  if (event.type !== 'marker.add' && event.type !== 'marker.update') return;
  const m = event.marker;
  if (!m || !m.geoBounds) return;

  const entry = markerMap[m.id];
  if (!entry || !entry.leafletMarker) return;

  const lm = entry.leafletMarker;

  // Remove previous event listeners to avoid stacking
  lm.off('mouseover mouseout');

  lm.on('mouseover', function () {
    const b = m.geoBounds;
    if (!b) return;
    if (entry._geohashRect) map.removeLayer(entry._geohashRect);
    entry._geohashRect = L.rectangle(
      [[b.MinLat, b.MinLng], [b.MaxLat, b.MaxLng]],
      { className: 'geohash-rect', interactive: false }
    ).addTo(map);
  });

  lm.on('mouseout', function () {
    if (entry._geohashRect) {
      map.removeLayer(entry._geohashRect);
      entry._geohashRect = null;
    }
  });
});
