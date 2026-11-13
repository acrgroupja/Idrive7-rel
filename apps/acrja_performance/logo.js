'use strict';
/**
 * The ACR Automobile logo on Gauge Log's pages, drawn as TEXT: each logo size is a one-glyph font
 * (its atlas is the logo's coverage mask, logo_data.js from tools/make_logo.py), added to the kit's
 * fonts here. Why not a pixel image: on the car the kit talks to mgu-render in its own dialect (it
 * gives the header, tabs and touch), and pixel images are not drawn there; font atlases are, smooth
 * and in any colour. So the same logo shows on the GPU renderer, in the emulator and in software.
 * Node 8.
 *
 *   draw(cv, which, x, y, colour, h)  which: 'full' (the whole logo), 'mark' / 'markBig' / 'markTile'
 *                                     (the ACR letters at 30 / 54 / 120 px); x, y: the top left;
 *                                     h: the height drawn (default the baked one; smaller is smooth)
 *   size(which, h) -> { w, h }        colour: the logo's own silver when left out
 */
const zlib = require('zlib');
const fonts = require('./kit/fonts');
const D = require('./logo_data');

const GLYPH = 0xE000, CH = String.fromCharCode(GLYPH);
const WHICH = ['full', 'mark', 'markBig', 'markTile'];
const fams = {};
/** Family 'acr_<which>': one size, its height; one glyph, the logo, its top at -height (above the baseline). */
function fam(which) {
    if (fams[which]) return fams[which];
    const m = D[which];
    if (!m) return null;
    // the atlas a multiple of 16 wide (GPU texture rows; the kit's own are 1024), the logo at its left
    const src = zlib.inflateSync(Buffer.from(m.z, 'base64')), aw = Math.ceil(m.w / 16) * 16, alpha = Buffer.alloc(aw * m.h);
    for (let y = 0; y < m.h; y++) src.copy(alpha, y * aw, y * m.w, y * m.w + m.w);
    let key = 0;
    for (let i = 0; i < m.z.length; i += 7) key = (Math.imul(key, 31) + m.z.charCodeAt(i)) >>> 0;
    fams[which] = {
        size: m.h, ascent: m.h, descent: 0, atlasW: aw, atlasH: m.h,
        glyphs: { [GLYPH]: [0, 0, m.w, m.h, 0, -m.h, m.w] }, alpha, _alpha: null,
        family: 'acr_' + which, cacheKey: 'acr' + key.toString(36),     // (a new logo: a new atlas id)
    };
    return fams[which];
}
// fonts.get(name, ...) for 'acr_*': the logo's family (the kit's text drawing and its renderer upload do the rest)
if (!fonts._acrLogo) {
    const get = fonts.get;
    fonts.get = function (name, size, text) {
        if (typeof name === 'string' && name.indexOf('acr_') === 0) return fam(name.slice(4)) || get.call(fonts, 'label', size, text);
        return get.apply(fonts, arguments);
    };
    fonts._acrLogo = true;
}

function size(which, h) {
    const m = D[which];
    if (!m) return { w: 0, h: 0 };
    const hh = h || m.h;
    return { w: Math.round(m.w * hh / m.h), h: hh };
}
/** The logo with its top left at x, y, h px high, in colour (default the logo's silver). Returns its size. */
function draw(cv, which, x, y, colour, h) {
    const s = size(which, h);
    if (!s.h) return s;
    cv.text(CH, x, y + s.h, s.h, colour || D.colour, { font: 'acr_' + which, literal: true });
    return s;
}

module.exports = { draw, size, colour: D.colour, WHICH };
