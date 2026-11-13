'use strict';
/**
 * Gauge Log's Drag and Dyno pages on iDrive 7 (1600 x 520, kit/gauges). drag.js and dyno.js hold the
 * logic; this only draws. An iDrive 8 version replaces this file.
 */
const { withAlpha } = require('./kit/canvas');
const T = require('./tiles');
const { SPLITS } = require('./drag');
const UI = require('./gauges_ui');
const LOGO = require('./logo');

const GO = '#2fd27a';
const isNum = (v) => typeof v === 'number' && isFinite(v);
const f = (v, d) => (isNum(v) ? v.toFixed(d) : '--');

/** u: units ({ speed, boost, power, stoich ... }); fmt helpers in them. */
// every number in the chosen units (tiles.js resolveUnits / conv)
function spd(kmh, u) { return T.conv('speed', kmh, u); }
function spdUnit(u) { return T.unitOf('speed', u); }
function pres(bar, u) { return T.conv('boost', bar, u); }
function presText(bar, u) { return isNum(bar) ? f(pres(bar, u), T.decOf('boost', u)) + ' ' + T.unitOf('boost', u) : '--'; }
function pw(kw, u) { return T.conv('power', kw, u); }
function pwUnit(u) { return T.unitOf('power', u); }
function tq(nm, u) { return T.conv('torque', nm, u); }
function fp(bar, u) { return T.conv('fuel', bar, u); }
function tmp(c, u) { return T.conv('temp', c, u); }
const stamp = (at) => { const d = new Date(at), p = (n) => (n < 10 ? '0' : '') + n; return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

/** A list of label / value rows from (x, y), 34 px apart, values right-aligned at x + w. */
function rows(cv, t, x, y, w, list) {
    list.forEach((r, i) => {
        const yy = y + i * 34;
        cv.text(r[0].toUpperCase(), x, yy, 18, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text(r[1], x + w, yy, 23, r[2] ? t[r[2]] || r[2] : t.text, { align: 'right' });
    });
}

/* ---------------- drag ---------------- */
function drawDrag(cv, t, G, o) {
    const { drag, d, u, now, history } = o;
    if (history) return drawDragHistory(cv, t, G, o);
    const st = drag.state, run = st === 'run', res = drag.result(), traps = drag.traps(), last = drag.lastRun;
    // status
    G.panel(cv, t, 24, 44, 500, 468, 'Drag');
    LOGO.draw(cv, 'mark', 524 - 20 - LOGO.size('mark').w, 62);
    const label = run ? 'RUNNING' : st === 'ready' ? 'ARMED - GO' : 'STOP TO ARM';
    G.pill(cv, t, 44, 108, 220, 38, label, { color: run ? t.crit : st === 'ready' ? GO : t.dim, filled: run || st === 'ready' ? 0.25 : 0.08 });
    if (drag.rollout) cv.text('1 ft rollout', 500, 134, 20, t.dim, { align: 'right' });
    const w = cv.text(f(drag.elapsed(now), 2), 44, 250, 104, run ? t.text : st === 'ready' ? t.dim : t.text, { font: 'num' });
    cv.text('s', 54 + w, 250, 30, t.dim);
    const dist = drag.distance();
    rows(cv, t, 44, 300, 456, [
        ['Speed', f(spd(d.speed, u), 0) + ' ' + spdUnit(u)],
        ['Distance', run || last ? f(T.conv('dist', dist, u), 0) + ' ' + T.unitOf('dist', u) : '--'],
        ['Launch rpm', drag.live ? String(drag.live.launchRpm || '--') : last && last.launchRpm ? String(last.launchRpm) : '--'],
        ['Boost now', presText(d.dme && d.dme.boost, u)],
    ]);
    cv.text(st === 'ready' ? 'Clock starts on the first movement' : run ? 'Lift to end the run' : 'Stop the car for 1 s to arm the timer', 44, 496, 20, t.dim);

    // splits
    G.panel(cv, t, 540, 44, 500, 468, 'Splits');
    cv.text('S  @ ' + spdUnit(u).toUpperCase(), 560, 112, 16, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text('THIS RUN', 870, 112, 16, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    cv.text('BEST', 1016, 112, 16, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    SPLITS.forEach((s, i) => {
        const y = 154 + i * 44, v = res[s.key], b = drag.best(s.key), nb = drag.newBest[s.key];
        cv.text(s.label, 560, y, 24, t.text);
        let txt = f(v, s.short ? 3 : 2);
        if (s.trap && isNum(traps[s.key])) txt += ' @ ' + f(spd(traps[s.key], u), 0);
        cv.text(txt, 870, y, 24, nb ? GO : isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
        cv.text(b ? f(b.s, s.short ? 3 : 2) : '--', 1016, y, 22, t.dim, { align: 'right' });
    });

    // engine on the run (o.hideEngine: main.js shows the live tiles there instead)
    if (o.hideEngine) return;
    const r = drag.live ? Object.assign({}, drag.live, { misfires: drag.live.misfires }) : last;
    G.panel(cv, t, 1056, 44, 520, 468, drag.live ? 'Engine, this run' : 'Last run');
    if (!r) { cv.text('No run yet', 1316, 290, 26, t.dim, { align: 'center' }); return; }
    let shifts = (r.shifts || []).map((x) => x.from + '>' + x.to + ' ' + x.rpm).join('  ');
    while (shifts && cv.textWidth(shifts, 23) > 330) shifts = shifts.slice(0, shifts.lastIndexOf('  ')) + ' ...';
    rows(cv, t, 1076, 136, 480, [
        ['Shifts', shifts || '--'],
        ['Peak boost', presText(r.boost, u) + (isNum(r.boostTarget) ? '  (target ' + f(pres(r.boostTarget, u), T.decOf('boost', u)) + ')' : '')],
        ['AFR at full throttle', isNum(r.afrRich) ? f(r.afrRich, 1) + ' - ' + f(r.afrLean, 1) : '--', isNum(r.afrLean) && r.afrLean > (u.stoich || 14.7) * 0.93 ? 'warn' : null],
        ['Knock retard, most', isNum(r.knock) ? f(r.knock, 1) + '°' : '--', isNum(r.knock) && r.knock >= 3 ? 'crit' : isNum(r.knock) && r.knock >= 1.5 ? 'warn' : null],
        ['Misfires', isNum(r.misfires) ? String(r.misfires) : '--', r.misfires > 0 ? 'crit' : null],
        ['Fuel HP, lowest', isNum(r.railLow) ? f(fp(r.railLow, u), 0) + ' ' + T.unitOf('fuel', u) + (isNum(r.railTargetAtLow) ? ' (target ' + f(fp(r.railTargetAtLow, u), 0) + ')' : '') : '--',
            isNum(r.railLow) && isNum(r.railTargetAtLow) && r.railLow < r.railTargetAtLow - 25 ? 'crit' : null],
        ['Peak g', f(r.peakG, 2) + ' g'],
        ['Top rpm', r.rpmMax ? String(Math.round(r.rpmMax)) : '--'],
    ]);
    const s = r.start || {};
    cv.text('Start: intake ' + f(tmp(s.intake, u), 0) + '  outside ' + f(tmp(s.outside, u), 0) + '  coolant ' + f(tmp(s.coolant, u), 0) +
        '  oil ' + f(tmp(s.oil, u), 0) + ' ' + T.unitOf('temp', u), 1076, 496, 18, t.dim);
}

function drawDragHistory(cv, t, G, o) {
    const { drag, u } = o, runs = drag.runs();
    G.panel(cv, t, 24, 44, 1552, 468, 'Drag runs  (' + runs.length + ')' + (drag.demo ? '  demo' : ''));
    const cols = [{ label: 'When', w: 170 }, { label: '60 ft', w: 120, align: 'right' }, { label: '1/8 mile', w: 210, align: 'right' }, { label: '1/4 mile', w: 210, align: 'right' },
        { label: '0-60 mph', w: 130, align: 'right' }, { label: 'Launch', w: 120, align: 'right' }, { label: 'Boost', w: 150, align: 'right' }, { label: 'AFR', w: 140, align: 'right' },
        { label: 'Knock', w: 110, align: 'right' }, { label: 'Misfire', w: 120, align: 'right' }];
    const tr = (r, k) => (isNum(r.result[k]) ? f(r.result[k], 2) + (isNum(r.trap[k]) ? ' @ ' + f(spd(r.trap[k], u), 0) : '') : '--');
    const list = runs.slice(0, 9).map((r) => [stamp(r.at), f(r.result['60ft'], 3), tr(r, '8th'), tr(r, '4th'), f(r.result['0-60mph'], 2), r.launchRpm ? String(r.launchRpm) : '--',
        isNum(r.boost) ? f(pres(r.boost, u), T.decOf('boost', u)) : '--', isNum(r.afrRich) ? f(r.afrRich, 1) + '-' + f(r.afrLean, 1) : '--',
        { text: isNum(r.knock) ? f(r.knock, 1) + '°' : '--', color: r.knock >= 3 ? 'crit' : null }, { text: String(r.misfires || 0), color: r.misfires ? 'crit' : null }]);
    G.table(cv, t, 48, 112, 1504, cols, list, { empty: 'No runs yet' });
}

/* ---------------- dyno ---------------- */
function niceMax(v, step) { return Math.max(step, Math.ceil((v || 0) / step) * step); }
function drawDyno(cv, t, G, o) {
    const { dyno, u, now, view } = o;
    const live = dyno.live(now), list = dyno.pulls(), p = live || list[view] || null, prev = live ? list[0] : list[view + 1];
    let title = 'Dyno';
    if (live) title = 'Recording pull' + (live.gear ? ', gear ' + live.gear : '');
    else if (p) title = 'Pull ' + (view + 1) + ' of ' + list.length + (p.gear ? ', gear ' + p.gear : '') + '  ·  ' + stamp(p.at);
    G.panel(cv, t, 24, 44, 900, 468, title);
    // the shop's mark in the chart's title row (left of Older pull): every screenshot of a pull carries it
    const ms = LOGO.size('mark'), mx = 924 - 20 - 170 - 22 - ms.w, my = 62;
    LOGO.draw(cv, 'mark', mx, my);
    if (!p) {
        cv.text(dyno.state === 'short' ? 'Too short (' + dyno.shortWhy + '): cover 1500 rpm or more' : 'Full throttle in one gear (3rd or 4th) from about 2000 rpm', 474, 260, 24, t.text, { align: 'center' });
        cv.text('The pull is recorded by itself and ends when you lift or shift.', 474, 300, 22, t.dim, { align: 'center' });
        cv.text('Torque is the engine unit\'s own figure (crank, calculated), not the dyno\'s.', 474, 340, 20, t.dim, { align: 'center' });
    } else {
        const xMin = Math.floor(Math.min(p.rpm[0] || 1000, prev && prev.rpm[0] || 9e9) / 500) * 500;
        const xMax = Math.ceil(Math.max(p.rpm[p.rpm.length - 1] || 2000, prev && prev.rpm[prev.rpm.length - 1] || 0) / 500) * 500;
        const pwv = p.power.map((x) => pw(x, u)), tqv = p.torque.map((x) => tq(x, u));
        const ymax = niceMax(Math.max.apply(null, tqv.concat(pwv).filter(isNum).concat([100])) * 1.1, 100);
        const S = (pp, key, conv) => pp ? pp.rpm.map((r, i) => [r, conv ? conv(pp[key][i]) : pp[key][i]]) : [];
        G.chart(cv, t, 44, 100, 860, 340, { xMin, xMax, yMin: 0, yMax: ymax, xStep: 1000, xFmt: (v) => (v / 1000) + 'k', xUnit: 'rpm',
            series: [
                prev && { pts: S(prev, 'torque', (x) => tq(x, u)), color: withAlpha(t.dim, 0.6), dash: true, width: 2 },
                prev && { pts: S(prev, 'power', (x) => pw(x, u)), color: withAlpha(t.dim, 0.6), dash: true, width: 2 },
                { pts: S(p, 'torque', (x) => tq(x, u)), color: 'accent2', width: 3 },
                { pts: S(p, 'power', (x) => pw(x, u)), color: 'accent', width: 3, fill: 0.08 },
            ].filter(Boolean), empty: 'Waiting for data' });
        // the shared axis: both units, in their curves' colours
        const ax = cv.text(T.unitOf('torque', u), 96, 126, 17, t.accent2, { font: 'bold' });
        cv.text('  /  ' + pwUnit(u), 96 + ax, 126, 17, t.accent, { font: 'bold' });
        cv.text('TORQUE ' + f(tq(p.peakTorque, u), 0) + ' ' + T.unitOf('torque', u) + ' @ ' + (p.peakTorqueRpm || '--'), 44, 474, 22, t.accent2, { font: 'bold', spacing: 1 });
        cv.text('POWER ' + f(pw(p.peakPower, u), 0) + ' ' + pwUnit(u) + ' @ ' + (p.peakPowerRpm || '--'), 420, 474, 22, t.accent, { font: 'bold', spacing: 1 });
        cv.text((prev ? 'dashed: the pull before  ·  ' : '') + p.rpmFrom + '-' + p.rpmTo + ' rpm in ' + f(p.ms / 1000, 1) + ' s', 900, 500, 18, t.dim, { align: 'right' });
    }
    // the engine on the pull: six tiles in the Drag panel's style, their graphs against rpm. The numbers: now
    // (a pull being recorded) or at peak power (a saved one). o.limitsFor(id): the matching Drag tile's limits.
    const DYNO_TILES = ['boostPair', 'railPair', 'afrPair', 'lambdaPair', 'knock', 'timing'];
    const x0 = 940, y0 = 44, w = 636, h = 468, gap = 12, bw = (w - gap) / 2, bh = (h - gap * 2) / 3;
    const at = p ? (live ? p.rpm.length - 1 : Math.max(0, p.rpm.indexOf(p.peakPowerRpm))) : null;
    const atText = p && p.rpm.length ? (live ? 'now ' : 'at ') + p.rpm[at] + ' rpm' : '';
    DYNO_TILES.forEach((id, i) => {
        const b = { x: Math.round(x0 + (i % 2) * (bw + gap)), y: Math.round(y0 + Math.floor(i / 2) * (bh + gap)), w: Math.round(bw), h: Math.round(bh) };
        const c = T.BY_ID[id], L = o.limitsFor ? o.limitsFor(id) : {};
        const key = c.pair ? c.pair[0] : id, tkey = c.pair ? c.pair[1] : null;
        UI.drawCurveTile(cv, t, G, b, u, Object.assign({ id: c.pair ? c.pair[0] : id, name: c.name, xs: p ? p.rpm : [], a: p ? p[key] : [], b: p && tkey ? p[tkey] : null,
            at, atText }, L));
    });
    if (p) {
        const mis = p.misfires;
        cv.text('Misfires ' + (isNum(mis) ? mis : '--') + '  ·  intake ' + f(tmp(p.start && p.start.intake, u), 0) + ' ' + T.unitOf('temp', u),
            44, 500, 18, mis > 0 ? t.crit : t.dim);
    }
}

module.exports = { drawDrag, drawDyno };
