'use strict';
/**
 * ACR Performance's own look: colour themes in ACR Automobile's colours (the logo's silver, orange and blue)
 * with their own panel style, in place of the kit's stock themes (and BMW M's tricolour stripe).
 * Requiring this file adds the themes to the kit's list; the app's "Colour theme" setting picks one.
 * The kit draws a panel with t.panel when a theme has one (kit/gauges.js drawPanel).
 */
const { withAlpha } = require('./kit/canvas');
const { THEMES } = require('./kit/themes');

const SILVER = '#a3a9a5', ORANGE = '#ff6a13', BLUE = '#2f8cff';

/** Silver Line: a thin silver outline with the top-right corner cut off, an orange mark before the title. */
function panelLine(cv, t, x, y, w, h, title) {
    const C = 22, e = withAlpha(SILVER, 0.38), fill = t.panelFill || withAlpha(SILVER, 0.06);
    cv.quad([[x, y], [x + w - C, y], [x + w, y + C], [x, y + C]], fill);
    cv.fillRect(x, y + C, w, h - C, fill);
    cv.fillRect(x, y, w - C, 1.5, e);                       // top
    cv.line(x + w - C, y + 0.75, x + w - 0.75, y + C, 1.5, e); // the cut corner
    cv.fillRect(x + w - 1.5, y + C, 1.5, h - C, e);         // right
    cv.fillRect(x, y, 1.5, h, e);                           // left
    cv.fillRect(x, y + h - 1.5, w, 1.5, e);                 // bottom
    cv.fillRect(x, y, 46, 4, t.mark || t.accent);           // orange corner tab
    if (title) {
        cv.fillRect(x + 18, y + 20, 4, 26, t.mark || t.accent);
        cv.text(String(title), x + 30, y + 42, 25, t.text, { font: 'bold' });
    }
}

/** Orange Edge: an orange edge down the left, a thin blue line along the top, the title in silver-white. */
function panelEdge(cv, t, x, y, w, h, title) {
    cv.gradientRect(x, y, w, h, [[0, withAlpha('#ffffff', 0.075)], [1, withAlpha('#ffffff', 0.03)]]);
    cv.fillRect(x + 6, y, w - 6, 2, withAlpha(BLUE, 0.85));
    cv.fillRect(x, y, 6, h, t.accent);
    if (title) cv.text(String(title), x + 24, y + 41, 26, t.text, { font: 'bold' });
}

/** Blue Night: rounded navy cards, a short orange underline below the title. */
function panelCard(cv, t, x, y, w, h, title) {
    cv.card(x, y, w, h, 14, [[0, withAlpha('#1c3c6e', 0.55)], [1, withAlpha('#0b1830', 0.55)]]);
    cv.strokeRoundRect(x, y, w, h, 14, 1.5, withAlpha(BLUE, 0.35));
    if (title) {
        cv.text(String(title), x + 20, y + 40, 25, t.text, { font: 'bold' });
        cv.roundRect(x + 20, y + 49, 40, 3, 1.5, ORANGE);
    }
}

const base = {
    bg: '#060708', panelTop: '#17191b', panelBottom: '#0c0d0e', panelEdge: '#2b2e30',
    tab: '#e8eaea', track: '#1f2224', tick: '#5d625f', text: '#f3f4f4', dim: '#9ba19d',
    accent: ORANGE, accent2: '#4aa3ff', ok: ORANGE, warn: '#ffc233', crit: '#ff2d2d', cold: BLUE,
    glow: ORANGE + '55', stripes: [ORANGE], oil: ORANGE, bar: ORANGE, sel: ORANGE, selText: '#ffffff', marker: '#ffffff',
    ramp: ['#7a3206', ORANGE, '#ffb27a'], hotRamp: ['#a8440a', ORANGE, ORANGE, '#ff4a1c', '#ff2020'],
};
const night = { bg: '#03060c', track: '#16213a', tick: '#4a5a78', dim: '#8d9bb4',
    accent: BLUE, ok: BLUE, bar: BLUE, oil: ORANGE, accent2: ORANGE, stripes: [BLUE],
    ramp: ['#1d4fa8', BLUE, '#9ccaff'], hotRamp: ['#1d4fa8', BLUE, BLUE, ORANGE, '#ff2a1a'] };
const ACR = {
    // A's panels (silver outline, cut corner, orange marks) on C's navy, with C's blue dials
    acr_signature: Object.assign({}, base, night, { name: 'ACR Signature', panel: panelLine,
        panelFill: withAlpha('#1c3c6e', 0.30), mark: ORANGE, sel: ORANGE }),
    acr_line: Object.assign({}, base, { name: 'ACR Silver Line', panel: panelLine }),
    acr_edge: Object.assign({}, base, { name: 'ACR Orange Edge', bg: '#070605', track: '#231f1c', panel: panelEdge,
        sel: BLUE, accent2: '#7fb6ff' }),
    acr_night: Object.assign({}, base, night, { name: 'ACR Blue Night', panel: panelCard }),
};
Object.assign(THEMES, ACR);

module.exports = { ACR, SILVER, ORANGE, BLUE };
