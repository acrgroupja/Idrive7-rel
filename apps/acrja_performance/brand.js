'use strict';
/**
 * ACR Automobile Jamaica's logo in Gauge Log: the start-up screen (the full logo, centred, for SPLASH_MS
 * each time the app is opened). The logo is an alpha mask (logo_data.js) tinted here and given to the renderer as
 * a pixel image (kit/record setImage / cv.image), drawn at its own size so it stays sharp (the renderer
 * scales images by the nearest pixel). iDrive 7 drawing; an iDrive 8 version replaces this file and keeps
 * logo_data.js.
 */
const zlib = require('zlib');
const { setImage } = require('./kit/record');
const LOGO = require('./logo_data');

const IMG = 7101, SPLASH_MS = 4000;
let made = null;

/** '#rrggbb' -> [r, g, b] ([0, 0, 0] for anything else). */
function rgbOf(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}
/**
 * The logo as an image in colour rgb on background bg (both [r, g, b]): blended into it, since the kit's
 * pixel images are opaque (made for game frames). Drawn on that same background, the edges don't show.
 * Made once per colour pair.
 */
function logoImage(rgb, bg) {
    bg = bg || [0, 0, 0];
    const key = rgb.join(',') + '/' + bg.join(',');
    if (made === key) return IMG;
    const a = zlib.inflateSync(Buffer.from(LOGO.ALPHA, 'base64')), px = Buffer.alloc(LOGO.W * LOGO.H * 4);
    for (let i = 0, j = 0; i < a.length; i++, j += 4) {
        const k = a[i] / 255;
        px[j] = Math.round(bg[0] + (rgb[0] - bg[0]) * k); px[j + 1] = Math.round(bg[1] + (rgb[1] - bg[1]) * k);
        px[j + 2] = Math.round(bg[2] + (rgb[2] - bg[2]) * k); px[j + 3] = 255;
    }
    setImage(IMG, LOGO.W, LOGO.H, px);
    made = key;
    return IMG;
}

/**
 * The start-up screen shows each time the app is opened, not when its process starts (on the car apps start
 * in the background at boot). The screen is drawn only while shown, so a gap of over HIDDEN_MS since the
 * last frame means it was away: a new opening. splashing(now) is asked once per frame.
 */
const HIDDEN_MS = 2500;
let lastFrame = 0, until = 0;
function splashing(now) {
    now = now || Date.now();
    if (now - lastFrame > HIDDEN_MS) until = now + SPLASH_MS;
    lastFrame = now;
    return now < until;
}
/**
 * The start-up screen: the theme's background and the logo in white, centred. Drawn as a font glyph
 * (logo.js): on the car's GPU renderer pixel images are not drawn for an app with the kit's header and touch.
 */
const LOGO_FONT = require('./logo');
function drawSplash(cv, t) {
    cv.clear(t.bg);
    const s = LOGO_FONT.size('full'), w = cv.w || 1600, h = cv.h || 520;
    LOGO_FONT.draw(cv, 'full', Math.round((w - s.w) / 2), Math.round((h - s.h) / 2) - 6, '#ffffff');
    cv.text(CREDIT, w / 2, h - 18, 15, t.dim, { align: 'center' });
}
/** The kit's credit (its MIT licence asks for its notice; the full text is in NOTICE in the package). */
const CREDIT = 'Built on the idrive7-apps kit by cauliflowermossgrape (MIT licence)';

module.exports = { CREDIT, rgbOf, drawSplash, splashing, logoImage, SPLASH_MS, LOGO };
