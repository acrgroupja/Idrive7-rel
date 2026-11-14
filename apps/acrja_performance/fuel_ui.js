'use strict';
/**
 * fuel_ui.js - Check page > Fuel quality: what the engine unit learned about the fuel (a sheet over the page).
 *
 *   adapted octane      5776 (0 = RON 98 .. 1 = RON 91), read with the slow values
 *   since refuelling    57E3 (minutes), and the distance: the odometer (KOMBI) less the last refuelling's mileage
 *   ethanol             550D or OBD PID 52, as on the tiles
 *   refuellings         KQE 22 4035, asked when the sheet opens: how many the engine unit counted as low, medium
 *                       and high quality, and the last five with their mileage (x 8 km) and quality
 * Read only. B58 / B48 (DME8FF_R) and the S63's master unit have KQE; another engine shows what it answers.
 *
 *   ctx.sheet(fuelSheet({ get: () => Promise<parseKqe() or null>, now: () => engine values, units: () => u, onDone }))
 */
const { withAlpha } = require('./kit/canvas');

const QUALITY = { 0: '--', 1: 'Low', 2: 'Medium', 3: 'High' };
const isNum = (v) => typeof v === 'number' && isFinite(v);
/** RON -> AKI ((R+M)/2), about: 91 RON = 87 AKI, 95 = 90.4, 98 = 93. */
const aki = (ron) => 87 + (ron - 91) * 6 / 7;
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
            // left: now. Octane as RON (the engine unit's scale) and about as AKI ((R+M)/2, the US pump number)
            const big = (label, value, unit, x, y, extra) => {
                r.text(label, x, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
                const ok = value !== '--';
                const w = r.text(value, x, y + 56, 54, ok ? t.text : t.dim, { font: 'num' });
                let ux = x + (typeof w === 'number' ? w : r.textWidth(value, 54, { font: 'num' })) + 10;
                if (unit) ux += (r.text(unit, ux, y + 56, 24, t.dim) || r.textWidth(unit, 24)) + 22;
                if (extra) r.text(extra, ux, y + 56, 26, ok ? t.text : t.dim, { font: 'bold' });
            };
            const ron = isNum(e.octane) ? e.octane : null;
            big('ADAPTED OCTANE', ron === null ? '--' : ron.toFixed(1), 'RON', 44, 160, ron === null ? '' : '/  ' + aki(ron).toFixed(1) + ' AKI');
            big('ETHANOL', isNum(e.ethanol) ? e.ethanol.toFixed(0) : '--', '%', 44, 262, o.ethanolFrom ? 'from ' + (o.ethanolFrom() === 'OBD' ? 'OBD' : o.ethanolFrom() ? 'engine unit' : '--') : '');
            // since refuelling: the time (57E3) and the distance (the odometer less the last refuelling's mileage)
            const h = isNum(e.sinceRefuel) ? e.sinceRefuel / 60 : null;
            const time = h === null ? '--' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' days';
            const odo = o.odometer ? o.odometer() : null, last = this.kqe && this.kqe.last && this.kqe.last[0] && this.kqe.last[0].km;
            const km = isNum(odo) && last && odo >= last ? odo - last : null;
            const dist = km === null ? '--' : mi ? Math.round(km / 1.609344) + ' mi' : Math.round(km) + ' km';
            r.text('SINCE REFUELLING', 44, 364, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const tw = r.textWidth(time, 44, { font: 'num' });
            r.text(time, 44, 414, 44, time === '--' ? t.dim : t.text, { font: 'num' });
            r.text('\u00b7', 44 + tw + 18, 414, 40, t.dim);
            r.text(dist, 44 + tw + 48, 414, 44, dist === '--' ? t.dim : t.text, { font: 'num' });
            r.text('Octane: 98 RON = runs as on premium; towards 91 = adapted to poorer fuel', 44, 468, 18, t.dim, { font: 'label' });
            r.text('AKI is the US pump number, about RON less 4 to 5. Distance: odometer less the last refuelling', 44, 496, 18, t.dim, { font: 'label' });
            // right: the history
            const k = this.kqe, x0 = 760;
            r.text('REFUELLINGS BY QUALITY', x0, 170, 18, t.dim, { font: 'bold', spacing: 1.5 });
            if (k === undefined) r.text('Asking the engine unit...', x0, 214, 22, t.dim, { font: 'label' });
            else if (k === null) r.text('The engine unit has no fuel quality history (or did not answer)', x0, 214, 22, t.dim, { font: 'label' });
            else {
                [['Low', k.low, t.crit], ['Medium', k.medium, t.warn], ['High', k.high, '#2fd27a']].forEach((q, i) => {
                    const x = x0 + i * 270;
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

module.exports = { fuelSheet, DEMO, QUALITY, aki };
