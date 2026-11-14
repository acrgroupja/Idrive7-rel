'use strict';
/**
 * log_summary.js - one log file, summed up for the Files page (tap a file): how long, how many rows, the highest
 * rpm, speed, boost, coolant and oil, the worst knock retard, misfires in the file, the richest and leanest AFR at
 * full throttle (pedal 90 % and up). Read as a stream (a long log is many MB), Node 8.
 *
 *   summarize(file, cb)   cb(err, { rows, seconds, cols: { key: { max, min, unit } }, misfires, afrRich, afrLean, units })
 */
const fs = require('fs');

// what is looked for: a column whose title starts with the prefix (its unit after it: boost_bar, boost_psi ...)
const WANT = [
    ['rpm', /^rpm$/], ['speed', /^speed_(kmh|mph)$/], ['boost', /^boost_(bar|psi|kpa)$/], ['knock', /^knock_retard_deg$/],
    ['coolant', /^coolant_(c|f)$/], ['oil', /^oil_(c|f)$/], ['power', /^power_(kw|hp)$/], ['iat', /^charge_air_(c|f)$/],
];

function summarize(file, cb) {
    let head = null, idx = {}, iMis = -1, iAfr = -1, iPedal = -1, iEl = -1, rest = '', rows = 0, firstEl = null, lastEl = null;
    const out = { rows: 0, seconds: null, cols: {}, misfires: null, afrRich: null, afrLean: null };
    let mis0 = null, mis1 = null, done = false;
    const line = (l) => {
        if (!l) return;
        const f = l.split(',');
        if (!head) {
            head = f;
            f.forEach((h, i) => {
                WANT.forEach((w) => { const m = w[1].exec(h); if (m && !(w[0] in idx)) { idx[w[0]] = i; out.cols[w[0]] = { max: null, min: null, unit: m[1] || '' }; } });
                if (h === 'misfires_total') iMis = i;
                if (h === 'afr') iAfr = i;
                if (h === 'pedal_pct') iPedal = i;
                if (h === 'elapsed_s') iEl = i;
            });
            return;
        }
        rows++;
        Object.keys(idx).forEach((k) => {
            const v = parseFloat(f[idx[k]]);
            if (!isFinite(v)) return;
            const c = out.cols[k];
            if (c.max === null || v > c.max) c.max = v;
            if (c.min === null || v < c.min) c.min = v;
        });
        if (iEl >= 0) { const e = parseFloat(f[iEl]); if (isFinite(e)) { if (firstEl === null) firstEl = e; lastEl = e; } }
        if (iMis >= 0) { const m = parseFloat(f[iMis]); if (isFinite(m)) { if (mis0 === null) mis0 = m; mis1 = m; } }
        if (iAfr >= 0 && iPedal >= 0) {
            const a = parseFloat(f[iAfr]), p = parseFloat(f[iPedal]);
            if (isFinite(a) && a > 5 && isFinite(p) && p >= 90) {
                if (out.afrRich === null || a < out.afrRich) out.afrRich = a;
                if (out.afrLean === null || a > out.afrLean) out.afrLean = a;
            }
        }
    };
    const end = (err) => {
        if (done) return; done = true;
        if (err) return cb(err);
        if (rest) line(rest.trim());
        out.rows = rows;
        out.seconds = firstEl !== null ? lastEl - firstEl : null;
        // the counters are the engine unit's running totals: the misfires in this file are the rise
        out.misfires = mis0 !== null ? Math.max(0, mis1 - mis0) : null;
        cb(null, out);
    };
    let st;
    try { st = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 }); } catch (e) { return end(e); }
    st.on('data', (chunk) => {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop();
        parts.forEach((l) => line(l.trim()));
    });
    st.on('error', end);
    st.on('end', () => end(null));
}

module.exports = { summarize };
