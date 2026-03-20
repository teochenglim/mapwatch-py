/**
 * Effect: event-markers
 *
 * Replaces plain coloured dots with emoji event markers + animations.
 * Each severity maps to a Singapore urban incident type with its own
 * emoji, colour, and animation style.
 *
 * Animation catalogue:
 *   critical  🚗 Car Accident        — gyrocopter: spinning dashed ring + shake
 *   high      🔥 Building Fire       — flicker: rapid opacity pulse
 *   medium    🚧 Road Congestion     — bounce: gentle up/down
 *   low       🌳 Fallen Tree         — sway: slow left/right tilt
 *   info      💧 Flash Flood         — ripple: expanding ring
 *   test      🚨 Suspicious Activity — flash: strobe blink
 *   debug     👁️  General Sighting   — static
 *   unknown                grey      — pulse (fallback)
 */
(function () {
  'use strict';

  // ── Event map ─────────────────────────────────────────────────────────────

  const EVENTS = {
    critical: { emoji: '🚗', label: 'Car Accident',        color: '#FF4444', bg: 'rgba(255,68,68,0.18)',   anim: 'gyro'    },
    high:     { emoji: '🔥', label: 'Building Fire',       color: '#FF8844', bg: 'rgba(255,136,68,0.18)',  anim: 'flicker' },
    warning:  { emoji: '🔥', label: 'Building Fire',       color: '#FF8844', bg: 'rgba(255,136,68,0.18)',  anim: 'flicker' },
    medium:   { emoji: '🚧', label: 'Road Congestion',     color: '#FFCC44', bg: 'rgba(255,204,68,0.18)',  anim: 'bounce'  },
    low:      { emoji: '🌳', label: 'Fallen Tree',         color: '#44FF44', bg: 'rgba(68,255,68,0.15)',   anim: 'sway'    },
    info:     { emoji: '💧', label: 'Flash Flood',         color: '#4444FF', bg: 'rgba(68,68,255,0.18)',   anim: 'ripple'  },
    test:     { emoji: '🚨', label: 'Suspicious Activity', color: '#AA44FF', bg: 'rgba(170,68,255,0.18)',  anim: 'flash'   },
    debug:    { emoji: '👁️', label: 'General Sighting',   color: '#AAAAAA', bg: 'rgba(200,200,200,0.12)', anim: 'none'    },
    unknown:  { emoji: '⚠️', label: 'Unknown',             color: '#8b949e', bg: 'rgba(139,148,158,0.15)', anim: 'pulse'   },
  };

  // dominant_color label (from RisingWave exporter) → severity key
  const COLOR_TO_SEV = {
    '#ff4444': 'critical', '#FF4444': 'critical',
    '#ff8844': 'high',     '#FF8844': 'high',
    '#ffcc44': 'medium',   '#FFCC44': 'medium',
    '#44ff44': 'low',      '#44FF44': 'low',
    '#4444ff': 'info',     '#4444FF': 'info',
    '#aa44ff': 'test',     '#AA44FF': 'test',
    '#ffffff': 'debug',    '#FFFFFF': 'debug',
  };

  function sevFor(m) {
    if (!m) return 'unknown';
    const col = (m.labels && m.labels.dominant_color || '').toLowerCase();
    if (col && COLOR_TO_SEV[col]) return COLOR_TO_SEV[col];
    return (m.severity || 'unknown').toLowerCase();
  }

  // ── Inject CSS ────────────────────────────────────────────────────────────

  const CSS = `
    /* ── Base event marker ── */
    .mw-ev {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 2px solid;
      font-size: 18px;
      line-height: 1;
      user-select: none;
    }

    /* ── Gyrocopter: spinning dashed ring + emoji shake (critical) ── */
    @keyframes mw-gyro-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes mw-gyro-shake {
      0%,100% { transform: translate(0,0) rotate(0deg); }
      20%     { transform: translate(-2px,-1px) rotate(-5deg); }
      40%     { transform: translate(2px,1px) rotate(5deg); }
      60%     { transform: translate(-1px,2px) rotate(-3deg); }
      80%     { transform: translate(1px,-1px) rotate(3deg); }
    }
    .mw-ev-gyro .mw-ev-ring {
      position: absolute;
      inset: -7px;
      border-radius: 50%;
      border: 3px dashed #FF4444;
      animation: mw-gyro-spin 0.9s linear infinite;
      pointer-events: none;
    }
    .mw-ev-gyro .mw-ev-emoji {
      animation: mw-gyro-shake 0.55s ease-in-out infinite;
      display: inline-block;
    }

    /* ── Flicker: fire ── */
    @keyframes mw-flicker {
      0%,100% { opacity: 1;   transform: scale(1);    }
      15%     { opacity: 0.4; transform: scale(0.94); }
      30%     { opacity: 1;   transform: scale(1.06); }
      50%     { opacity: 0.6; transform: scale(0.97); }
      70%     { opacity: 1;   transform: scale(1.04); }
      85%     { opacity: 0.5; transform: scale(0.96); }
    }
    .mw-ev-flicker .mw-ev-emoji {
      animation: mw-flicker 0.75s ease-in-out infinite;
      display: inline-block;
    }

    /* ── Bounce: road congestion ── */
    @keyframes mw-bounce {
      0%,100% { transform: translateY(0);   }
      45%     { transform: translateY(-6px); }
    }
    .mw-ev-bounce .mw-ev-emoji {
      animation: mw-bounce 1.1s ease-in-out infinite;
      display: inline-block;
    }

    /* ── Sway: fallen tree ── */
    @keyframes mw-sway {
      0%,100% { transform: rotate(0deg);  }
      30%     { transform: rotate(-9deg); }
      70%     { transform: rotate(9deg);  }
    }
    .mw-ev-sway .mw-ev-emoji {
      animation: mw-sway 2.4s ease-in-out infinite;
      display: inline-block;
      transform-origin: bottom center;
    }

    /* ── Ripple: flood — expanding concentric ring ── */
    @keyframes mw-ripple {
      0%   { transform: scale(1);   opacity: 0.75; }
      100% { transform: scale(2.4); opacity: 0;    }
    }
    .mw-ev-ripple .mw-ev-ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 2px solid #4444FF;
      animation: mw-ripple 1.5s ease-out infinite;
      pointer-events: none;
    }

    /* ── Flash: suspicious activity — strobe ── */
    @keyframes mw-flash {
      0%,48%  { opacity: 1;    }
      50%,98% { opacity: 0.1;  }
      100%    { opacity: 1;    }
    }
    .mw-ev-flash .mw-ev-emoji {
      animation: mw-flash 0.65s step-end infinite;
      display: inline-block;
    }

    /* ── Pulse: unknown fallback ── */
    @keyframes mw-ev-pulse {
      0%,100% { box-shadow: 0 0 0 0   rgba(139,148,158,0.7); }
      50%     { box-shadow: 0 0 0 9px rgba(139,148,158,0);   }
    }
    .mw-ev-pulse { animation: mw-ev-pulse 1.6s ease-out infinite; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ── Build Leaflet DivIcon ─────────────────────────────────────────────────

  function makeEventIcon(sev) {
    const ev   = EVENTS[sev] || EVENTS.unknown;
    const ring = (ev.anim === 'gyro' || ev.anim === 'ripple')
      ? '<div class="mw-ev-ring"></div>'
      : '';
    const html =
      `<div class="mw-ev mw-ev-${ev.anim}" ` +
           `style="background:${ev.bg};border-color:${ev.color}">` +
        ring +
        `<span class="mw-ev-emoji" title="${ev.label}">${ev.emoji}</span>` +
      `</div>`;

    return L.divIcon({
      className:     '',
      html:          html,
      iconSize:      [36, 36],
      iconAnchor:    [18, 18],
      tooltipAnchor: [18, 0],
    });
  }

  // ── Register effect ───────────────────────────────────────────────────────

  if (typeof MapWatch !== 'undefined' && MapWatch.registerEffect) {
    MapWatch.registerEffect('blink-critical', function (event, map, markerMap) {
      if (event.type !== 'marker.add' && event.type !== 'marker.update') return;
      const m = event.marker;
      if (!m) return;

      const entry = markerMap[m.id];
      if (!entry || !entry.leafletMarker) return;

      const sev = sevFor(m);
      entry.leafletMarker.setIcon(makeEventIcon(sev));
      entry.leafletMarker._mwSev = sev;   // consumed by cluster iconCreateFunction
    });
  }

  // ── Expose event map for mobile.html color picker ─────────────────────────
  window.MW_EVENTS      = EVENTS;
  window.MW_COLOR_TO_SEV = COLOR_TO_SEV;

})();
