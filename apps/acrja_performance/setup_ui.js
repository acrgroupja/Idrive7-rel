'use strict';
/**
 * setup_ui.js - the first start: three questions (units, tuning software, logging by itself) on one sheet, so a
 * new car is set up without a trip through Settings. Done or Later both mark it done (Settings has them all).
 *
 *   ctx.sheet(setupSheet({ get: (k) => value, set: (k, v), onDone }))
 */
const { withAlpha } = require('./kit/canvas');

const QUESTIONS = [
    { key: 'units', title: 'Units', options: [['metric', 'Metric', 'km/h · °C · bar · kW'], ['imperial', 'Imperial', 'mph · °F · psi · hp']] },
    { key: 'tuner', title: 'Tuning software', options: [['off', 'None', 'nothing is sent to the car'], ['bm3', 'BM3', 'bootmod3 map switching'], ['mhd', 'MHD', 'MHD map switching']] },
    { key: 'autoLog', title: 'Start logging by itself', options: [['off', 'Off', 'the Start button'], ['engine', 'Engine running', ''], ['moving', 'Car moving', ''], ['runs', 'Drag and dyno', 'runs and pulls']] },
];

function setupSheet(o) {
    const S = {
        title: 'Set up ACR Performance',
        draw(r, t) {
            r.clear(t.bg);
            const targets = [];
            r.text('Welcome to ACR Performance', 44, 84, 34, t.text, { font: 'bold' });
            r.text('Three choices to start. Everything can be changed later in Settings.', 44, 118, 20, t.dim, { font: 'label' });
            const pill = (x, label, act, primary) => {
                r.roundRect(x, 50, 170, 52, 26, primary ? withAlpha(t.accent, 0.9) : withAlpha('#ffffff', 0.08));
                if (!primary) r.strokeRoundRect(x, 50, 170, 52, 26, 1.5, withAlpha('#ffffff', 0.25));
                r.text(label, x + 85, 84, 24, '#ffffff', { align: 'center', font: 'bold' });
                targets.push({ x: x - 6, y: 44, w: 182, h: 64, act });
            };
            const done = () => { o.set('setupDone', true); if (o.onDone) o.onDone(); return 'close'; };
            pill(1556 - 170, 'Done', done, true);
            pill(1556 - 360, 'Later', done, false);
            QUESTIONS.forEach((q, i) => {
                const y = 170 + i * 116;
                r.text(q.title.toUpperCase(), 44, y, 19, t.dim, { font: 'bold', spacing: 1.5 });
                const cur = o.get(q.key), bw = 300, gap = 18;
                q.options.forEach((op, j) => {
                    const x = 44 + j * (bw + gap), on = cur === op[0];
                    r.roundRect(x, y + 14, bw, 72, 12, on ? withAlpha(t.accent, 0.35) : withAlpha('#ffffff', 0.06));
                    r.strokeRoundRect(x, y + 14, bw, 72, 12, on ? 3 : 1.5, on ? t.accent : withAlpha('#ffffff', 0.22));
                    r.text(op[1], x + 20, y + 48, 26, t.text, { font: 'bold' });
                    if (op[2]) r.text(op[2], x + 20, y + 74, 18, t.dim, { font: 'label' });
                    targets.push({ x, y: y + 14, w: bw, h: 72, act: () => { o.set(q.key, op[0]); return null; } });
                });
            });
            return targets;
        },
        move() {}, press() { return null; }, back() { o.set('setupDone', true); if (o.onDone) o.onDone(); return 'close'; },
    };
    return S;
}

module.exports = { setupSheet, QUESTIONS };
