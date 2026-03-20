/**
 * Module: stats
 *
 * Shows a live counter overlay (bottom-right corner) with:
 *   • total markers on map
 *   • markers added in the last 60 s (rate)
 *
 * Enabled via mapwatch.yaml:
 *   modules:
 *     stats: true
 */
(function () {
  'use strict';

  // ── Inject CSS ────────────────────────────────────────────────────────────

  const style = document.createElement('style');
  style.textContent = `
    #mw-stats {
      position: absolute;
      bottom: 32px;
      right: 12px;
      z-index: 1000;
      background: rgba(13,17,23,.88);
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 6px 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px;
      color: #8b949e;
      display: flex;
      gap: 14px;
      pointer-events: none;
    }
    .mw-stat-val { color: #58a6ff; font-weight: 700; font-size: 13px; }
    .mw-stat-lbl { display: block; font-size: 10px; color: #8b949e; margin-top: 1px; }
  `;
  document.head.appendChild(style);

  // ── Build DOM ─────────────────────────────────────────────────────────────

  const el = document.createElement('div');
  el.id = 'mw-stats';
  el.innerHTML = `
    <div><span class="mw-stat-val" id="mw-stat-total">0</span><span class="mw-stat-lbl">active</span></div>
    <div><span class="mw-stat-val" id="mw-stat-rate">0</span><span class="mw-stat-lbl">/ min</span></div>
  `;
  document.body.appendChild(el);

  const elTotal = document.getElementById('mw-stat-total');
  const elRate  = document.getElementById('mw-stat-rate');

  // ── Tracking ──────────────────────────────────────────────────────────────

  // Ring buffer of add-event timestamps (last 60 s).
  const addTimes = [];
  let totalActive = 0;

  function pruneOld() {
    const cutoff = Date.now() - 60000;
    while (addTimes.length && addTimes[0] < cutoff) addTimes.shift();
  }

  function update() {
    pruneOld();
    elTotal.textContent = totalActive;
    elRate.textContent  = addTimes.length;
  }

  setInterval(update, 1000);

  // ── Register as MapWatch effect ───────────────────────────────────────────

  if (typeof MapWatch !== 'undefined' && MapWatch.registerEffect) {
    MapWatch.registerEffect('stats-counter', function (event) {
      if (event.type === 'marker.add') {
        totalActive++;
        addTimes.push(Date.now());
        update();
      } else if (event.type === 'marker.remove') {
        totalActive = Math.max(0, totalActive - 1);
        update();
      }
    });
  }
})();
