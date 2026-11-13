'use strict';
/**
 * tune_ui.js - the Tune page: engine map switching (and the tune's extras) for a BM3 or MHD tuned DME.
 * Which tune: Settings > "Tuning software" (Off sends nothing and hides the page). The commands are the
 * kit's Live Adjustments ones (tune.js, bm3_protocol.js, bm3_profiles.js, from idrive7-apps, MIT).
 *
 *   left   Engine map: the map big, MAP 1-4 (one press switches), what the DME said
 *   right  BM3: Burbles (- / + pick, Apply sends, Off) and Active Sound on / off
 *          MHD: Max Cooling on / off (on only with the engine running)
 *
 * Buttons are drawn here (they show on every renderer) and are touch targets where there is touch.
 */
const { withAlpha } = require('./kit/canvas');
const LOGO = require('./logo');

const NAMES = { bm3: 'BM3', mhd: 'MHD' };

/** A row of buttons; specs = [label, run, lit, small label above]. Returns nothing. */
function buttons(cv, t, x, y, w, h, gap, specs, busy, key) {
    const bw = (w - gap * (specs.length - 1)) / specs.length;
    specs.forEach((s, i) => {
        const bx = Math.round(x + i * (bw + gap)), lit = !!s[2], c = t.sel || t.accent;
        cv.roundRect(bx, y, Math.round(bw), h, 10, lit ? withAlpha(c, 0.9) : withAlpha('#ffffff', busy ? 0.04 : 0.08));
        cv.strokeRoundRect(bx, y, Math.round(bw), h, 10, 1.5, lit ? c : withAlpha('#ffffff', 0.25));
        const tc = busy && !lit ? t.dim : lit ? '#ffffff' : t.text;
        if (s[3]) {
            cv.text(s[3], bx + bw / 2, y + h / 2 - 12, 16, lit ? '#ffffff' : t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text(fitText(cv, s[0], 26, bw - 16), bx + bw / 2, y + h / 2 + 22, 26, tc, { align: 'center', font: 'bold' });
        } else cv.text(s[0], bx + bw / 2, y + h / 2 + 9, 26, tc, { align: 'center', font: 'bold' });
        if (cv.own && s[1] && !busy) cv.target(bx - 3, y - 3, Math.round(bw) + 6, h + 6, s[1], key + ':' + i);
    });
}

function fitText(cv, s, size, w) {
    if (!cv.textWidth || cv.textWidth(s, size, { font: 'bold' }) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, { font: 'bold' }) > w) s = s.slice(0, -1);
    return s + '...';
}

function note(cv, t, m, x, y) {
    if (!m.note) return;
    const c = m.noteType === 'warn' ? t.warn : m.noteType === 'go' ? (t.ok || t.accent) : t.dim;
    cv.text(m.note, x, y, 18, c, { font: 'label' });
}

/** m = TuneControl.view() + names (n -> the owner's name or ''); act = { map(n), rename(), cooling(on), aggDown, aggUp, burblesApply, burblesOff, asd(on) }. */
function drawTune(cv, t, G, m, act) {
    if (!m.armed) return drawPick(cv, t, G, act);
    const f = m.features || {};
    // ---- engine map
    G.panel(cv, t, 24, 44, 900, 468, 'Engine map · ' + (NAMES[m.tuner] || ''));
    LOGO.draw(cv, 'mark', 924 - 20 - LOGO.size('mark').w, 62);
    const nm = (n) => (m.names && m.names(n)) || '';
    // the Rename button, left of the logo
    const rx = 924 - 20 - LOGO.size('mark').w - 20 - 150;
    cv.roundRect(rx, 58, 150, 38, 19, withAlpha('#ffffff', 0.08));
    cv.strokeRoundRect(rx, 58, 150, 38, 19, 1.5, withAlpha('#ffffff', 0.25));
    cv.text('Rename', rx + 75, 84, 20, t.text, { align: 'center', font: 'bold', spacing: 1 });
    if (cv.own && act.rename) cv.target(rx - 4, 54, 158, 46, act.rename, 'tune:rename');
    const big = m.map ? (nm(m.map) || 'MAP ' + m.map) : 'MAP –';
    cv.text(fitText(cv, big, 104, 840), 474, 214, 104, m.map ? t.text : t.dim, { align: 'center', font: 'bold', spacing: nm(m.map) ? 0 : 4 });
    cv.text((m.map && nm(m.map) ? 'Map ' + m.map + ' · ' : '') + (m.map ? (m.mapConfirmed ? 'active map, read back from the DME' : 'selected map, accepted by the DME') : 'No map read yet · pick one'),
        474, 258, 20, t.dim, { align: 'center', font: 'label' });
    for (let i = 0; i < 4; i++) cv.roundRect(84 + i * 200, 286, 180, 6, 3, m.map === i + 1 ? (t.sel || t.accent) : withAlpha('#ffffff', 0.12));
    if (m.tuner === 'mhd') cv.text('The engine light may flash while the map changes · that is normal with MHD', 474, 324, 17, t.dim, { align: 'center', font: 'label' });
    note(cv, t, m, 44, 364);
    buttons(cv, t, 44, 392, 860, 96, 20, [1, 2, 3, 4].map((n) => (nm(n) ? [nm(n), act.map && act.map(n), m.map === n, 'MAP ' + n] : ['Map ' + n, act.map && act.map(n), m.map === n])), m.busy, 'tune:map');
    // ---- the tune's extras
    if (f.burbles) {
        G.panel(cv, t, 940, 44, 636, 300, 'Burbles');
        const agg = typeof m.targetAgg === 'number' ? m.targetAgg : 0;
        const st = m.burbles == null ? 'unknown' : m.burbles === 'off' ? 'off' : m.burbles === 'custom' ? 'custom' : m.burbles;
        cv.text(agg.toFixed(1), 1100, 190, 80, t.text, { align: 'center', font: 'num' });
        cv.text('aggression 0 – 12', 1100, 222, 17, t.dim, { align: 'center', font: 'label' });
        cv.text('On the DME', 1260, 150, 17, t.dim, { font: 'label' });
        cv.text(st, 1260, 186, 32, t.text, { font: 'bold' });
        buttons(cv, t, 960, 252, 596, 72, 14, [['–', act.aggDown], ['+', act.aggUp], ['Apply', act.burblesApply], ['Off', act.burblesOff, m.burbles === 'off']], m.busy, 'tune:burb');
    }
    if (f.asd) {
        G.panel(cv, t, 940, 360, 636, 152, 'Active Sound');
        cv.text(m.asd === true ? 'ON' : m.asd === false ? 'OFF' : '–', 1556, 404, 26, m.asd == null ? t.dim : t.text, { align: 'right', font: 'bold' });
        buttons(cv, t, 960, 424, 596, 68, 14, [['On', act.asd && act.asd(true), m.asd === true], ['Off', act.asd && act.asd(false), m.asd === false]], m.busy, 'tune:asd');
    }
    if (f.cooling) {
        G.panel(cv, t, 940, 44, 636, 468, 'Max Cooling');
        const on = m.cooling === 'ON';
        cv.text(m.cooling || 'OFF', 1258, 240, 96, on ? (t.cold || t.accent2) : t.text, { align: 'center', font: 'num' });
        const r = m.rpm == null ? 'Engine speed unknown' : m.rpm > (m.minCoolingRpm || 500) ? 'Engine running · ' + Math.round(m.rpm) + ' rpm'
            : 'Start the engine to switch it on';
        cv.text(r, 1258, 290, 20, t.dim, { align: 'center', font: 'label' });
        cv.text('Fans and pump at full until switched off', 1258, 324, 17, t.dim, { align: 'center', font: 'label' });
        buttons(cv, t, 960, 392, 596, 96, 20, [['On', act.cooling && act.cooling(true), on], ['Off', act.cooling && act.cooling(false), m.cooling === 'OFF']], m.busy, 'tune:cool');
    }
    return cv;
}

/** No tune picked (Tuning software: Off): say so, and offer BM3 / MHD here too (the same setting). Nothing is sent. */
function drawPick(cv, t, G, act) {
    G.panel(cv, t, 24, 44, 1552, 468, 'Tune');
    LOGO.draw(cv, 'mark', 1576 - 20 - LOGO.size('mark').w, 62);
    cv.text('Pick your tune', 800, 176, 64, t.text, { align: 'center', font: 'bold' });
    cv.text('Settings > Tuning software, or tap the one this car runs. Until then nothing is sent to the car.', 800, 222, 20, t.dim, { align: 'center', font: 'label' });
    const opts = [['BM3', 'bootmod3', 'Map 1-4 · burbles · Active Sound', 'bm3'], ['MHD', 'MHD Flasher', 'Map 1-4 · Max Cooling', 'mhd']];
    opts.forEach((o, i) => {
        const x = 300 + i * 520, y = 270, w = 480, h = 180;
        cv.roundRect(x, y, w, h, 14, withAlpha('#ffffff', 0.06));
        cv.strokeRoundRect(x, y, w, h, 14, 1.5, withAlpha('#ffffff', 0.25));
        cv.fillRect(x, y + 24, 4, h - 48, t.sel || t.accent);
        cv.text(o[0], x + w / 2, y + 78, 56, t.text, { align: 'center', font: 'bold' });
        cv.text(o[1], x + w / 2, y + 114, 20, t.dim, { align: 'center', font: 'label' });
        cv.text(o[2], x + w / 2, y + 150, 20, t.text, { align: 'center', font: 'label' });
        if (cv.own && act.pick) cv.target(x, y, w, h, () => act.pick(o[3]), 'tune:pick:' + o[3]);
    });
    return cv;
}

module.exports = { drawTune, NAMES };
