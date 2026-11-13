'use strict';
/**
 * Gauge Log's gauge pages on iDrive 7: where each layout's tiles go on the 1600 x 520 page, how a
 * tile is drawn (kit/gauges), and the sheet that edits a tile (kit/sheet, drawn over the page by
 * the GPU renderer). This is the part an iDrive 8 version replaces; tiles.js stays.
 */
const { withAlpha } = require('./kit/canvas');
const { list, pill, TOP } = require('./kit/sheet');
const T = require('./tiles');
const LOGO = require('./logo');

const X0 = 24, Y0 = 44, W = 1552, H = 468, GAP = 16, SW = 1600;

/** n boxes side by side in (x, y, w, h). */
function row(x, y, w, h, n) {
    const bw = (w - GAP * (n - 1)) / n, out = [];
    for (let i = 0; i < n; i++) out.push({ x: Math.round(x + i * (bw + GAP)), y, w: Math.round(bw), h });
    return out;
}
/** cols x rows boxes, row by row. */
function grid(x, y, w, h, cols, rows) {
    const bh = (h - GAP * (rows - 1)) / rows;
    let out = [];
    for (let r = 0; r < rows; r++) out = out.concat(row(x, Math.round(y + r * (bh + GAP)), w, Math.round(bh), cols));
    return out;
}
/** Where a layout's tiles go, in its slot order: [{ x, y, w, h, kind }]. */
function boxes(layoutId) {
    const L = T.layout(layoutId);
    let b;
    switch (L.id) {
        case 'classic': b = [{ x: 24, y: Y0, w: 520, h: H }, { x: 560, y: Y0, w: 480, h: H }].concat(grid(1056, Y0, 520, H, 2, 3)); break;
        case 'dial1n4': b = [{ x: X0, y: Y0, w: 600, h: H }].concat(grid(640, Y0, 936, H, 2, 2)); break;
        case 'dial1b3': b = [{ x: X0, y: Y0, w: 600, h: H }].concat(grid(640, Y0, 936, H, 1, 3)); break;
        case 'dials3': b = row(X0, Y0, W, H, 3); break;
        case 'dials2': b = row(X0, Y0, W, H, 2); break;
        case 'nums6': b = grid(X0, Y0, W, H, 3, 2); break;
        case 'nums4': b = grid(X0, Y0, W, H, 2, 2); break;
        case 'bars4': b = grid(X0, Y0, W, H, 1, 4); break;
        default: b = grid(X0, Y0, W, H, 2, 2);
    }
    return b.map((x, i) => Object.assign(x, { kind: L.slots[i] }));
}

/** Dial ticks for a range: a round step giving 6-16 ticks, a number on every one or every second. */
function ticksFor(min, max, div) {
    const span = (max - min) / (div || 1);
    const step = [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500].filter((s) => span / s <= 16)[0] || 1000;
    const ticks = Math.max(2, Math.round(span / step)), majorEvery = ticks > 9 ? 2 : 1, label = step * majorEvery;
    return { ticks, majorEvery, tickDecimals: label % 1 === 0 ? 0 : (label * 10) % 1 === 0 ? 1 : 2 };
}

/**
 * Draw one tile. b = its box; id = its value (null: empty); now = readAll() of the latest data;
 * u = units; hist = History (for a number's trace); sel = marked (editing); G = kit/gauges; t = theme.
 */
function drawTile(cv, t, G, b, id, now, u, hist, sel, pair) {
    const c = id ? T.BY_ID[id] : null;
    if (c && !c.pair && pair && pair.alarm) {
        // a single value with flash limits: the tile as usual, then the note of its limits and, flashing, the red
        drawTile(cv, t, G, b, id, now, u, hist, sel, null);
        drawAlarm(cv, t, b, c, u, pair);
        return;
    }
    if (c && c.logo) drawLogoTile(cv, t, G, b);
    else if (c && c.pair) drawPair(cv, t, G, b, c, now, u, hist, pair || {});
    else if (!c) {
        G.panel(cv, t, b.x, b.y, b.w, b.h, 'Empty');
        cv.text(cv.own ? 'Tap to choose a value' : 'Edit to choose a value', b.x + b.w / 2, b.y + b.h / 2 + 10, 22, t.dim, { align: 'center' });
    } else if (c.text) drawText(cv, t, G, b, c, now);
    else {
        const v = T.show(id, now[id], u), r = c.range(u), unit = c.unit(u), zones = c.zones ? c.zones(u) : [];
        if (b.kind === 'dial') {
            G.panel(cv, t, b.x, b.y, b.w, b.h, null);
            const rad = Math.round(Math.min(b.w, b.h) / 2 - 34), tk = ticksFor(r[0], r[1], c.div);
            G.radial(cv, t, b.x + b.w / 2, b.y + b.h / 2 + 18, rad, Object.assign({ value: v, min: r[0], max: r[1], label: c.name,
                unit, decimals: T.decOf(c.id, u), zones, tickDiv: c.div || 1 }, tk,
            c.id === 'rpm' ? { limit: u.redline } : {}));
        } else if (b.kind === 'bar') {
            G.panel(cv, t, b.x, b.y, b.w, b.h, null);
            G.bar(cv, t, b.x + 24, b.y + 14, b.w - 48, b.h - 30, { label: c.name, value: v, min: r[0], max: r[1], unit, decimals: T.decOf(c.id, u), zones,
                origin: r[0] < 0 ? 0 : undefined, ramp: c.id === 'rpm' ? 'hot' : undefined });
        } else {
            G.stat(cv, t, b.x, b.y, b.w, b.h, { label: c.name, value: v, unit, decimals: T.decOf(c.id, u), zones, size: Math.min(96, Math.round(b.h * 0.42)),
                history: hist ? hist.values(id).map((x) => T.show(id, x, u)) : null });
        }
    }
    if (sel) {
        cv.strokeRoundRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8, 10, 4, t.sel || t.accent);
        cv.roundRect(b.x, b.y, b.w, b.h, 6, withAlpha(t.sel || t.accent, 0.08));
    }
}
/** A single value's flash: "flash > 2.0°" at the tile's top right; flashing, the tile blinks red with a red frame. */
function drawAlarm(cv, t, b, c, u, st) {
    const A = st.alarm, unit = c.unit ? c.unit(u) : '', dec = T.decOf(c.id, u);
    const parts = [];
    if (G_isNum(A.ahi)) parts.push('> ' + T.show(c.id, A.ahi, u).toFixed(dec) + (unit ? ' ' + unit : ''));
    if (G_isNum(A.alo)) parts.push('< ' + T.show(c.id, A.alo, u).toFixed(dec) + (unit ? ' ' + unit : ''));
    if (parts.length) {
        // beside the name when there is room, else in the bottom corner
        const note = 'flash ' + parts.join('  '), room = b.w - 36 - cv.textWidth(c.name, 26, { font: 'bold' });
        const y = cv.textWidth(note, 15) <= room ? b.y + 30 : b.y + b.h - 12;
        cv.text(note, b.x + b.w - 14, y, 15, st.flash ? t.crit : t.dim, { align: 'right' });
    }
    if (st.flash) {
        if (Math.floor((st.ms || Date.now()) / 250) % 2 === 0) cv.roundRect(b.x, b.y, b.w, b.h, 6, withAlpha(t.crit, 0.35));
        cv.strokeRoundRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, 6, 4, t.crit);
    }
}
const G_isNum = (v) => typeof v === 'number' && isFinite(v);

/**
 * An actual-vs-target tile, in any kind of slot: the name, actual (big), target and the difference, and
 * the last 30 s of both on one graph, from the low to the high limit, the tolerance as a band round
 * the target, the actual in red where it was outside it. pair = { lim: { lo, hi, tol }, flash, ms }:
 * flashing, the tile blinks red (4 times a second) with a red frame.
 */
const PAIR_S = 30;
function drawPair(cv, t, G, b, c, now, u, hist, pair) {
    const lim = pair.lim || { lo: 0, hi: 1, tol: 0 }, flash = !!pair.flash, ms = pair.ms || Date.now();
    const A = c.pair[0], B = c.pair[1], sh = (v) => T.show(c.id, v, u), dec = T.decOf(c.id, u), unit = c.unit(u);
    const blink = flash && Math.floor(ms / 250) % 2 === 0;
    G.panel(cv, t, b.x, b.y, b.w, b.h, null);
    if (blink) cv.roundRect(b.x, b.y, b.w, b.h, 6, withAlpha(t.crit, 0.42));
    if (flash) cv.strokeRoundRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, 6, 4, t.crit);
    const a = now[A], tg = 'target' in pair ? pair.target : now[B], dv = G.isNum(a) && G.isNum(tg) ? sh(a) - sh(tg) : null;
    const dir = lim.dir || 0, watch = pair.watch !== false;
    // the name, then actual (big) / target and the difference on the row under it
    const small = b.h < 200, big = small ? 34 : Math.min(64, Math.round(b.h * 0.2)), sz2 = small ? 17 : 24;
    const nw = cv.text(c.name, b.x + 18, b.y + (small ? 30 : 36), small ? 18 : 24, t.text, { font: 'bold' });
    // what changes the flashing, top right when it fits: below the pedal % (not watched), a custom target, one side only
    const room = b.w - 14 - 18 - nw - 16;
    let tags = [lim.thr > 0 && !watch ? 'pedal < ' + lim.thr + '%' : '', pair.custom ? 'custom target' : '', dir < 0 ? 'under only' : dir > 0 ? 'over only' : ''].filter(Boolean).join(' · ');
    if (tags && cv.textWidth(tags, 15, { font: 'label' }) > room) {      // a narrow tile: the short words
        tags = [lim.thr > 0 && !watch ? '<' + lim.thr + '%' : '', pair.custom ? 'custom' : '', dir < 0 ? 'under' : dir > 0 ? 'over' : ''].filter(Boolean).join(' · ');
    }
    if (tags && cv.textWidth(tags, 15, { font: 'label' }) <= room) {
        cv.text(tags, b.x + b.w - 14, b.y + (small ? 30 : 36), 15, lim.thr > 0 && !watch ? t.dim : t.accent2 || t.dim, { align: 'right', font: 'label' });
    }
    const ny = small ? b.y + 66 : b.y + 54 + big * 0.8, nx = b.x + 18;
    const at = G.fmt(G.isNum(a) ? sh(a) : null, dec);
    const rest = ' / ' + G.fmt(G.isNum(tg) ? sh(tg) : null, dec) + (pair.custom ? '*' : '') + ' ' + unit;
    const dtx = G.isNum(dv) ? '  diff ' + (dv > 0 ? '+' : '') + dv.toFixed(dec) : '';       // (the car's fonts have no delta sign)
    const w1 = cv.text(at, nx, ny, big, flash ? t.crit : t.text, { font: 'num' });
    const w2 = cv.text(rest, nx + w1, ny, sz2, t.dim);
    if (nx + w1 + w2 + cv.textWidth(dtx, sz2, { font: 'bold' }) < b.x + b.w - 12) cv.text(dtx, nx + w1 + w2, ny, sz2, flash ? t.crit : t.dim, { font: 'bold' });
    // the graph
    const gy = small ? ny + 8 : ny + 14, gh = b.y + b.h - 8 - gy;
    if (gh < 40 || !hist) return;
    const lo = sh(lim.lo), hi = sh(lim.hi), tol = Math.abs(sh(lim.tol));       // (all four scale without an offset)
    const ys = G.niceStep ? G.niceStep(hi - lo, small ? 2 : 4) : (hi - lo) / 4;
    const m = G.chart(cv, t, b.x + 8, gy, b.w - 16, gh, { xMin: -PAIR_S, xMax: 0, yMin: lo, yMax: hi, xStep: 10, yStep: ys,
        xFmt: (v) => (small ? '' : v ? String(-v) : 'now'), padLeft: 44, padBottom: small ? 4 : 22, padTop: small ? 4 : 8, marks: [], series: [] });
    const pa = hist.series(A, ms).filter((p) => p[0] >= -PAIR_S).map((p) => [p[0], G.isNum(p[1]) ? sh(p[1]) : null]);
    // the target line: the engine unit's history, or the custom target (flat) when that is the one compared with
    const pb = pair.custom ? pa.map((p) => [p[0], sh(pair.target)])
        : hist.series(B, ms).filter((p) => p[0] >= -PAIR_S).map((p) => [p[0], G.isNum(p[1]) ? sh(p[1]) : null]);
    const clampY = (v) => m.Y(Math.max(lo, Math.min(hi, v)));
    cv.clip(m.px, m.py - 2, m.pw, m.ph + 4);
    // the tolerance band round the target
    for (let i = 1; i < pb.length; i++) {
        const p = pb[i - 1], q = pb[i];
        if (!G.isNum(p[1]) || !G.isNum(q[1])) continue;
        cv.quad([[m.X(p[0]), clampY(p[1] + tol)], [m.X(q[0]), clampY(q[1] + tol)], [m.X(q[0]), clampY(q[1] - tol)], [m.X(p[0]), clampY(p[1] - tol)]], withAlpha(t.text, 0.09));
    }
    // the target, dashed
    for (let i = 1; i < pb.length; i += 2) {
        const p = pb[i - 1], q = pb[i];
        if (G.isNum(p[1]) && G.isNum(q[1])) cv.line(m.X(p[0]), clampY(p[1]), m.X(q[0]), clampY(q[1]), 2, withAlpha(t.text, 0.75));
    }
    // the actual: red where it was outside the tolerance
    for (let i = 1; i < pa.length; i++) {
        const p = pa[i - 1], q = pa[i], tq = pb[i] && pb[i][1];
        if (!G.isNum(p[1]) || !G.isNum(q[1])) continue;
        const out = watch && T.outOfTol(q[1], tq, tol, dir);
        cv.line(m.X(p[0]), clampY(p[1]), m.X(q[0]), clampY(q[1]), 3, out ? t.crit : t.accent2 || t.accent);
    }
    cv.noclip();
    if (!pa.some((p) => G.isNum(p[1]))) cv.text('No data', m.px + m.pw / 2, m.py + m.ph / 2 + 8, 20, t.dim, { align: 'center' });
}

/**
 * A tile in the same style as an actual-vs-target tile, but its graph against another axis (the Dyno's:
 * rpm across a pull) from given series. o = { id (value: name, unit, decimals, conversion), xs, a, b (target
 * series, optional), at (index for the numbers), atText ("at 5900 rpm"), lo, hi (metric), tol (pair) or
 * ahi / alo (single value's flash limits) }. Outside the tolerance or the limits anywhere: a red frame
 * (steady: a recording, not live) and the line red there.
 */
function drawCurveTile(cv, t, G, b, u, o) {
    const c = T.BY_ID[o.id], sh = (v) => T.show(o.id, v, u), dec = T.decOf(o.id, u), unit = c.unit ? c.unit(u) : '';
    const xs = o.xs || [], A = o.a || [], n = xs.length;
    const isN = G.isNum;
    // a pair's target: the recorded one, or its custom target (when set: where the engine gave none, or always)
    let B = o.b || null;
    if (B && o.ct > 0) B = B.map((v) => (o.tsrc === 1 || !isN(v) ? o.ct : v));
    const outAt = (j) => {
        const a = A[j];
        if (!isN(a)) return false;
        if (B && isN(o.tol)) return T.outOfTol(a, B[j], o.tol, o.dir || 0);
        return (isN(o.ahi) && a > o.ahi) || (isN(o.alo) && a < o.alo);
    };
    let anyOut = false;
    for (let j = 0; j < n; j++) if (outAt(j)) { anyOut = true; break; }
    G.panel(cv, t, b.x, b.y, b.w, b.h, null);
    if (anyOut) cv.strokeRoundRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, 6, 3, t.crit);
    const small = b.h < 200, big = small ? 34 : Math.min(64, Math.round(b.h * 0.2)), sz2 = small ? 17 : 24;
    const name = o.name || c.name;
    cv.text(name, b.x + 18, b.y + (small ? 30 : 36), small ? 18 : 24, t.text, { font: 'bold' });
    if (o.atText) cv.text(o.atText, b.x + b.w - 14, b.y + (small ? 30 : 36), 15, t.dim, { align: 'right' });
    const j = isN(o.at) ? o.at : n - 1, a = A[j], tg = B ? B[j] : null;
    const ny = small ? b.y + 66 : b.y + 54 + big * 0.8, nx = b.x + 18;
    const w1 = cv.text(G.fmt(isN(a) ? sh(a) : null, dec), nx, ny, big, outAt(j) ? t.crit : t.text, { font: 'num' });
    let rest = B ? ' / ' + G.fmt(isN(tg) ? sh(tg) : null, dec) + ' ' + unit : (unit ? ' ' + unit : '');
    const w2 = cv.text(rest, nx + w1, ny, sz2, t.dim);
    if (B && isN(a) && isN(tg)) {
        const dv = sh(a) - sh(tg), dtx = '  diff ' + (dv > 0 ? '+' : '') + dv.toFixed(dec);
        if (nx + w1 + w2 + cv.textWidth(dtx, sz2, { font: 'bold' }) < b.x + b.w - 12) cv.text(dtx, nx + w1 + w2, ny, sz2, outAt(j) ? t.crit : t.dim, { font: 'bold' });
    }
    // the graph against the x axis
    const gy = small ? ny + 8 : ny + 14, gh = b.y + b.h - 8 - gy;
    if (gh < 40 || n < 2) { if (n < 2) cv.text('No data', b.x + b.w / 2, b.y + b.h - 20, 18, t.dim, { align: 'center' }); return; }
    const lo = sh(o.lo), hi = sh(o.hi), tol = B && isN(o.tol) ? Math.abs(sh(o.tol)) : null;
    const xMin = Math.floor(xs[0] / 500) * 500, xMax = Math.ceil(xs[n - 1] / 500) * 500;
    const m = G.chart(cv, t, b.x + 8, gy, b.w - 16, gh, { xMin, xMax: Math.max(xMax, xMin + 500), yMin: lo, yMax: hi, xStep: 1000,
        yStep: G.niceStep(hi - lo, small ? 2 : 4), xFmt: (v) => (small ? '' : (v / 1000) + 'k'), padLeft: 44, padBottom: small ? 4 : 22, padTop: small ? 4 : 8, series: [] });
    const Y = (v) => m.Y(Math.max(lo, Math.min(hi, v)));
    cv.clip(m.px, m.py - 2, m.pw, m.ph + 4);
    if (B) {
        for (let k = 1; k < n; k++) {
            if (isN(tol) && isN(B[k - 1]) && isN(B[k])) {
                const p0 = sh(B[k - 1]), p1 = sh(B[k]);
                cv.quad([[m.X(xs[k - 1]), Y(p0 + tol)], [m.X(xs[k]), Y(p1 + tol)], [m.X(xs[k]), Y(p1 - tol)], [m.X(xs[k - 1]), Y(p0 - tol)]], withAlpha(t.text, 0.09));
            }
        }
        for (let k = 1; k < n; k += 2) if (isN(B[k - 1]) && isN(B[k])) cv.line(m.X(xs[k - 1]), Y(sh(B[k - 1])), m.X(xs[k]), Y(sh(B[k])), 2, withAlpha(t.text, 0.75));
    } else {
        // a single value's flash limits as lines
        [o.ahi, o.alo].forEach((v) => { if (isN(v) && sh(v) >= lo && sh(v) <= hi) cv.fillRect(m.px, Math.round(Y(sh(v))), m.pw, 1, withAlpha(t.crit, 0.7)); });
    }
    for (let k = 1; k < n; k++) {
        if (!isN(A[k - 1]) || !isN(A[k])) continue;
        cv.line(m.X(xs[k - 1]), Y(sh(A[k - 1])), m.X(xs[k]), Y(sh(A[k])), 3, outAt(k) ? t.crit : t.accent2 || t.accent);
    }
    cv.noclip();
}

/** The ACR logo tile: the ACR letters, as large as the tile allows (70 % of its width, 55 % of its height), centred. */
function drawLogoTile(cv, t, G, b) {
    G.panel(cv, t, b.x, b.y, b.w, b.h, null);
    const base = LOGO.size('markTile'), h = Math.max(12, Math.round(Math.min(b.h * 0.55, b.w * 0.7 * base.h / base.w)));
    const which = h > 54 ? 'markTile' : h > 30 ? 'markBig' : 'mark', s = LOGO.size(which, h);
    LOGO.draw(cv, which, b.x + (b.w - s.w) / 2, b.y + (b.h - s.h) / 2, null, h);
}

/** A value that is text (the gear): big, centred, in any kind of tile. */
function drawText(cv, t, G, b, c, now) {
    G.panel(cv, t, b.x, b.y, b.w, b.h, c.name);
    const size = Math.round(Math.min(b.h * 0.62, b.w * 0.5, 260));
    G.gear(cv, t, b.x + b.w / 2, b.y + b.h / 2 + size * 0.42 + 14, { gear: now.gear, size });
}

/**
 * The sheet that edits tile i of a page, drawn over it by the kit (ctx.sheet). o:
 *   title, current (value id or null), reading(id) -> text now, choose(id|null)
 *   layout, setLayout(id), add() (null when no page can be added), remove() (null for the last page)
 * Values first (with what each reads now), then the page's layout, add a page, remove this page
 * (pressed twice). A finger or the knob scrolls; press takes; push left goes back / closes.
 */
function tileSheet(o) {
    const LAYOUT = 'layout';
    const values = T.VALUES;
    const startAt = Math.max(0, values.map((v) => v.id).indexOf(o.current) + 1);
    return {
        title: o.title,
        open: null, focus: startAt, sub: 0, controller: false, armedAt: 0,
        armed() { return Date.now() - this.armedAt < 5000; },
        extras() {
            const L = o.limits ? o.limits() : null, A = o.alarms ? o.alarms() : null;
            return (L ? T.LIMIT_KEYS.filter((k) => k in L).map((k) => ({ id: 'lim:' + k, label: T.LIMIT_NAMES[k], value: o.fmtLimit(k, L[k]), kind: 'more' })) : [])
                .concat(A ? T.ALARM_KEYS.filter((k) => k in A).map((k) => ({ id: 'al:' + k, label: T.ALARM_NAMES[k], value: A[k] === null ? 'Off' : o.fmtLimit(k, A[k]), kind: 'more' })) : [])
                .concat(o.layout ? [{ id: LAYOUT, label: 'Page layout', value: T.layout(o.layout).name, kind: 'more' }] : [])
                .concat(o.add ? [{ id: 'add', label: 'Add a gauge page' }] : [])
                .concat(o.remove ? [{ id: 'remove', label: this.armed() ? 'Press again to remove this page' : 'Remove this page' }] : []);
        },
        rows() {
            if (this.open && this.open.al) {
                const k = this.open.al, cur = o.alarms()[k];
                return [{ label: 'Off', kind: 'radio', on: cur === null }].concat(o.alarmSteps(k).map((v) => ({ label: o.fmtLimit(k, v), kind: 'radio', on: G_isNum(cur) && Math.abs(v - cur) < 1e-9 })));
            }
            if (this.open && this.open.lim) {
                const k = this.open.lim, cur = o.limits()[k];
                return o.limitSteps(k).map((v) => ({ label: o.fmtLimit(k, v), kind: 'radio', on: Math.abs(v - cur) < 1e-9 }));
            }
            if (this.open === LAYOUT) return T.LAYOUTS.map((l) => ({ label: l.name, value: l.slots.length + ' tiles', kind: 'radio', on: l.id === o.layout }));
            return [{ label: 'Empty', kind: 'radio', on: o.current === null }]
                .concat(values.map((v) => ({ label: v.name, value: o.reading(v.id), kind: 'radio', on: v.id === o.current })))
                .concat(this.extras());
        },
        key() { return this.open ? (this.open.al ? 'tile:al:' + this.open.al : this.open.lim ? 'tile:lim:' + this.open.lim : 'tile:layouts') : 'tile:values'; },
        at() { return this.open ? this.sub : this.focus; },
        top() { return this.at() === -1; },
        draw(r, t) {
            r.clear(t.bg);
            if (o.locked && o.locked()) {
                // the car drives: nothing to change here, only Close
                r.text('Stop the car to edit tiles', 800, 250, 40, t.text, { align: 'center', font: 'bold' });
                r.text('Tiles and their limits can be changed while parked.', 800, 300, 26, t.dim, { align: 'center' });
                const bw = 220, bx = 800 - bw / 2, by = 350;
                pill(r, t, bx, by, bw, 56, 'Close', true);
                return [{ x: bx, y: by, w: bw, h: 56, act: () => 'close' }];
            }
            r.text(this.open ? (this.open.al ? T.ALARM_NAMES[this.open.al] : this.open.lim ? T.LIMIT_NAMES[this.open.lim] : 'Page layout') : o.title, 44, TOP + 40, 32, t.text, { font: 'bold' });
            const targets = [], bw = 150, bx = SW - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Close', this.controller && this.at() === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            list(r, t, this.key(), this.rows(), this.at(), TOP + 74, this.controller).forEach((q) => targets.push(Object.assign(q, {
                act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.take(); },
            })));
            return targets;
        },
        scroll(dy) { const st = list.scroll[this.key()]; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() { this.controller = true; if (o.locked && o.locked()) return 'close'; return this.at() === -1 ? this.back() : this.take(); },
        take() {
            if (o.locked && o.locked()) return 'close';
            if (this.open && this.open.al) {
                const v = this.sub === 0 ? null : o.alarmSteps(this.open.al)[this.sub - 1];
                if (v !== undefined) o.setAlarm(this.open.al, v);
                this.open = null;
                return null;
            }
            if (this.open && this.open.lim) {
                const v = o.limitSteps(this.open.lim)[this.sub];
                if (v !== undefined) o.setLimit(this.open.lim, v);
                this.open = null;                                // back to the tile's rows (more limits to set)
                return null;
            }
            if (this.open === LAYOUT) {
                const l = T.LAYOUTS[this.sub];
                if (l) { o.setLayout(l.id); o.layout = l.id; }
                return 'close';
            }
            if (this.focus === 0) { o.choose(null); return 'close'; }
            if (this.focus <= values.length) { o.choose(values[this.focus - 1].id); return 'close'; }
            const x = this.extras()[this.focus - values.length - 1];
            if (!x) return null;
            if (x.id.indexOf('al:') === 0) {
                const k = x.id.slice(3), st = o.alarmSteps(k), cur = o.alarms()[k];
                this.open = { al: k };
                this.sub = cur === null ? 0 : Math.max(0, st.map((v) => Math.abs(v - cur) < 1e-9).indexOf(true) + 1);
                return null;
            }
            if (x.id.indexOf('lim:') === 0) {
                const k = x.id.slice(4), st = o.limitSteps(k), cur = o.limits()[k];
                this.open = { lim: k };
                this.sub = Math.max(0, st.map((v) => Math.abs(v - cur) < 1e-9).indexOf(true));
                return null;
            }
            if (x.id === LAYOUT) { this.open = LAYOUT; this.sub = Math.max(0, T.LAYOUTS.map((l) => l.id).indexOf(o.layout)); return null; }
            if (x.id === 'add') { o.add(); return 'close'; }
            if (x.id === 'remove') {
                if (this.armed()) { o.remove(); return 'close'; }
                this.armedAt = Date.now();
                return null;
            }
            return null;
        },
        back() { if (this.open) { this.open = null; return null; } return 'close'; },
    };
}

module.exports = { drawCurveTile, boxes, drawTile, tileSheet, ticksFor };
