/**
 * Module: leaderboard
 *
 * Injects a collapsible leaderboard sidebar on the left.
 * Data source: GET /api/leaderboard  (MapWatch proxies to leaderboard_url in config).
 * Auto-refreshes every 5 s while visible.
 *
 * Enabled via mapwatch.yaml:
 *   modules:
 *     leaderboard: true
 *   leaderboard_url: http://exporter:8000/leaderboard
 */
(function () {
  'use strict';

  // ── Inject CSS ────────────────────────────────────────────────────────────

  const style = document.createElement('style');
  style.textContent = `
    #mw-leaderboard {
      position: absolute;
      top: 60px;
      left: 12px;
      z-index: 1000;
      width: 220px;
      background: rgba(13,17,23,.92);
      border: 1px solid #30363d;
      border-radius: 8px;
      backdrop-filter: blur(6px);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #e6edf3;
      overflow: hidden;
      transition: height .2s ease;
    }
    #mw-lb-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid #30363d;
      cursor: pointer;
      user-select: none;
    }
    #mw-lb-header:hover { background: #161b22; }
    #mw-lb-title { font-size: 12px; font-weight: 700; color: #e3b341; }
    #mw-lb-toggle { color: #8b949e; font-size: 14px; }
    #mw-lb-clear {
      color: #8b949e; font-size: 11px; padding: 2px 6px;
      background: none; border: 1px solid #30363d; border-radius: 4px;
      cursor: pointer; line-height: 1.4;
    }
    #mw-lb-clear:hover { color: #f85149; border-color: #f85149; }
    #mw-lb-body { padding: 6px 0; }
    .mw-lb-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
    }
    .mw-lb-row:hover { background: #161b22; }
    .mw-lb-rank  { width: 18px; color: #8b949e; font-size: 11px; text-align: right; flex-shrink: 0; }
    .mw-lb-rank.gold   { color: #e3b341; font-weight: 700; }
    .mw-lb-rank.silver { color: #c0c0c0; font-weight: 700; }
    .mw-lb-rank.bronze { color: #cd7f32; font-weight: 700; }
    .mw-lb-dot   { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .mw-lb-name  { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mw-lb-count { color: #58a6ff; font-weight: 600; flex-shrink: 0; font-size: 11px; }
    .mw-lb-empty { color: #8b949e; padding: 10px; text-align: center; }
    .mw-lb-err   { color: #f85149; padding: 10px; text-align: center; font-size: 11px; }
  `;
  document.head.appendChild(style);

  // ── Build DOM ─────────────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id = 'mw-leaderboard';
  panel.innerHTML = `
    <div id="mw-lb-header">
      <span id="mw-lb-title">🏆 Top Tappers</span>
      <span style="display:flex;align-items:center;gap:6px">
        <button id="mw-lb-clear" title="Clear map">🗺️</button>
        <span id="mw-lb-toggle">▲</span>
      </span>
    </div>
    <div id="mw-lb-body"><div class="mw-lb-empty">Loading…</div></div>
  `;
  document.body.appendChild(panel);

  let collapsed  = false;
  const header   = document.getElementById('mw-lb-header');
  const body     = document.getElementById('mw-lb-body');
  const toggle   = document.getElementById('mw-lb-toggle');
  const clearBtn = document.getElementById('mw-lb-clear');

  header.addEventListener('click', function(e) {
    if (e.target === clearBtn) return;
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    toggle.textContent = collapsed ? '▼' : '▲';
  });

  clearBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (window.MapWatch && window.MapWatch.clearMap) window.MapWatch.clearMap();
  });

  // ── Data fetch ────────────────────────────────────────────────────────────

  const RANK_CLASS = ['gold', 'silver', 'bronze'];

  function render(rows) {
    if (!rows || rows.length === 0) {
      body.innerHTML = '<div class="mw-lb-empty">No tappers yet</div>';
      return;
    }
    body.innerHTML = rows.slice(0, 10).map(function(r, i) {
      const rankCls = RANK_CLASS[i] || '';
      const color   = r.favorite_color || r.dominant_color || '#58a6ff';
      return `<div class="mw-lb-row">
        <span class="mw-lb-rank ${rankCls}">#${i + 1}</span>
        <span class="mw-lb-dot" style="background:${color}"></span>
        <span class="mw-lb-name" title="${r.username}">${r.username}</span>
        <span class="mw-lb-count">${r.tap_count}</span>
      </div>`;
    }).join('');
  }

  function refresh() {
    fetch('/api/leaderboard')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) {
          body.innerHTML = '<div class="mw-lb-err">No data</div>';
          return;
        }
        render(data);
      })
      .catch(function() {
        body.innerHTML = '<div class="mw-lb-err">Unavailable</div>';
      });
  }

  refresh();
  setInterval(refresh, 5000);
})();
