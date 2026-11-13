'use strict';
/**
 * fuel_ui.js - Check page > Fuel quality: what the engine unit learned about the fuel (a sheet over the page).
 *
 *   adapted octane      5776 (0 = RON 98 .. 1 = RON 91), read with the slow values
 *   since refuelling    57E3 (minutes)
 *   refuellings         KQE 22 4035, asked when the sheet opens: how many the engine unit counted as low, medium
 *                       and high quality, and the last five with their mileage (x 8 km) and quality
 * Read only. B58 / B48 (DME8FF_R) and the S63's master unit have KQE; another engine shows what it answers.
 *
 *   ctx.sheet(fuelSheet({ get: () => Promise<parseKqe() or null>, now: () => engine values, units: () => u, onDone }))
 */
const { withAlpha } = require('./kit/canvas');

const QUALITY = { 0: '--', 1: 'Low', 2: 'Medium', 3: 'High' };
const isNum = (v) => typeof v === 'number' && isFinite(v);
/** The demo's history (no car). */
const DEMO = { low: 1, medium: 4, high: 27, last: [{ km: 41216, q: 3 }, { km: 40720, q: 3 }, { km: 40232, q: 2 }, { km: 39744, q: 3 }, { km: 39296, q: 3 }] };

function fuelSheet(o) {
    const S = {
        title: 'Fuel quality', kqe: undefined, asked: 0,
        ask() {
            this.asked = Date.now(); this.kqe = undefined;
            Promise.resolve(o.get()).then((k) => { this.kqe = k || null; }).catch(() => { this.kqe = null; });
        },
        draw(r, t) {
            r.clear(t.bg);
            if (!this.asked) this.ask();
            const e = o.now() || {}, u = o.units ? o.units() : {}, mi = u.speed === 'mph';
            r.text('Fuel quality', 44, 90, 32, t.text, { font: 'bold' });
            r.text('What the engine unit learned about the fuel', 44, 120, 18, t.dim, { font: 'label' });
            const targets = [];
            const pill = (x, label, act) => {
                r.roundRect(x, 56, 150, 46, 23, withAlpha('#ffffff', 0.08));
                r.strokeRoundRect(x, 56, 150, 46, 23, 1.5, withAlpha('#ffffff', 0.25));
                r.text(label, x + 75, 86, 22, t.text, { align: 'center', font: 'bold' });
                targets.push({ x: x - 6, y: 50, w: 162, h: 58, act });
            };
            pill(1556 - 150, 'Close', () => { if (o.onDone) o.onDone(); return 'close'; });
            pill(1556 - 312, 'Ask again', () => { this.ask(); return null; });
            // left: now
            const big = (label, value, unit, x, y) => {
                r.text(label, x, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
                const w = r.text(value, x, y + 66, 64, isNum(parseFloat(value)) ? t.text : t.dim, { font: 'num' });
                if (unit) r.text(unit, x + (typeof w === 'number' ? w : 0) + 12, y + 66, 24, t.dim);
            };
            big('ADAPTED OCTANE', isNum(e.octane) ? e.octane.toFixed(1) : '--', 'RON', 44, 170);
            const h = isNum(e.sinceRefuel) ? e.sinceRefuel / 60 : null;
            big('SINCE REFUELLING', h === null ? '--' : h < 48 ? h.toFixed(1) : (h / 24).toFixed(1), h !== null && h >= 48 ? 'days' : 'h', 44, 290);
            r.text('98: the engine runs as on premium fuel  ·  towards 91: it has adapted to poorer fuel (less ignition timing)', 44, 420, 16, t.dim, { font: 'label' });
            // right: the history
            const k = this.kqe, x0 = 620;
            r.text('REFUELLINGS BY QUALITY', x0, 170, 18, t.dim, { font: 'bold', spacing: 1.5 });
            if (k === undefined) r.text('Asking the engine unit...', x0, 214, 22, t.dim, { font: 'label' });
            else if (k === null) r.text('The engine unit has no fuel quality history (or did not answer)', x0, 214, 22, t.dim, { font: 'label' });
            else {
                [['Low', k.low, t.crit], ['Medium', k.medium, t.warn], ['High', k.high, '#2fd27a']].forEach((q, i) => {
                    const x = x0 + i * 300;
                    r.fillRect(x, 194, 4, 40, q[2]);
                    r.text(String(q[1]), x + 18, 228, 40, t.text, { font: 'num' });
                    r.text(q[0], x + 110, 226, 20, t.dim, { font: 'label' });
                });
                r.text('LAST FIVE REFUELLINGS', x0, 290, 18, t.dim, { font: 'bold', spacing: 1.5 });
                k.last.forEach((f, i) => {
                    const y = 330 + i * 34, km = f.km;
                    const dist = !km ? '--' : mi ? Math.round(km / 1.609344).toLocaleString('en-US') + ' mi' : km.toLocaleString('en-US') + ' km';
                    const c = f.q === 1 ? t.crit : f.q === 2 ? t.warn : f.q === 3 ? '#2fd27a' : t.dim;
                    r.text(String(i + 1), x0, y, 20, t.dim, { font: 'label' });
                    r.text('at ' + dist, x0 + 40, y, 22, t.text);
                    r.circle(x0 + 330, y - 7, 7, c);
                    r.text(QUALITY[f.q] || String(f.q), x0 + 350, y, 22, t.text);
                });
            }
            return targets;
        },
        move() {}, press() { if (o.onDone) o.onDone(); return 'close'; }, back() { if (o.onDone) o.onDone(); return 'close'; },
    };
    return S;
}

module.exports = { fuelSheet, DEMO, QUALITY };
