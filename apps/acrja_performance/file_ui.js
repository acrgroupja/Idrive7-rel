'use strict';
/**
 * file_ui.js - Files page > a log tapped: what is in it (log_summary.js) and Delete this file (asks twice).
 *
 *   ctx.sheet(fileSheet({ file: { name, bytes, at }, path, summarize, recording, remove: () => bool, size: (b) => text, onDone }))
 */
const { withAlpha } = require('./kit/canvas');
const isNum = (v) => typeof v === 'number' && isFinite(v);

function fileSheet(o) {
    const S = {
        title: 'Log file', sum: undefined, armedAt: 0, msg: null,
        draw(r, t) {
            r.clear(t.bg);
            if (this.sum === undefined) {
                this.sum = null;
                o.summarize(o.path, (err, s) => { this.sum = err ? { error: err.message } : s; });
            }
            const targets = [], f = o.file, d = new Date(f.at), p = (n) => String(n).padStart(2, '0');
            r.text(f.name, 44, 84, 30, t.text, { font: 'bold' });
            r.text(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '  ·  ' + o.size(f.bytes)
                + (o.recording ? '  ·  being recorded' : ''), 44, 116, 20, o.recording ? t.crit : t.dim, { font: 'label' });
            const pill = (x, w, label, act, col) => {
                r.roundRect(x, 50, w, 52, 26, col ? withAlpha(col, 0.85) : withAlpha('#ffffff', 0.08));
                if (!col) r.strokeRoundRect(x, 50, w, 52, 26, 1.5, withAlpha('#ffffff', 0.25));
                r.text(label, x + w / 2, 84, 22, '#ffffff', { align: 'center', font: 'bold' });
                targets.push({ x: x - 6, y: 44, w: w + 12, h: 64, act });
            };
            pill(1556 - 150, 150, 'Close', () => { if (o.onDone) o.onDone(); return 'close'; });
            if (!o.recording) {
                const armed = Date.now() - this.armedAt < 5000;
                pill(1556 - 150 - 24 - 230, 230, armed ? 'Yes, delete' : 'Delete file', () => {
                    if (!armed) { this.armedAt = Date.now(); return null; }
                    if (o.remove()) { if (o.onDone) o.onDone(); return 'close'; }
                    this.msg = 'Could not delete it'; return null;
                }, armed ? t.crit : null);
            }
            const s = this.sum;
            if (!s) { r.text('Reading the file...', 44, 200, 24, t.dim); return targets; }
            if (s.error) { r.text('Could not read it: ' + s.error, 44, 200, 24, t.crit); return targets; }
            const c = s.cols, n = (k, dec) => (c[k] && isNum(c[k].max) ? c[k].max.toFixed(dec) + ' ' + unitText(k, c[k].unit) : '--');
            const mins = isNum(s.seconds) ? Math.floor(s.seconds / 60) + ':' + String(Math.round(s.seconds % 60)).padStart(2, '0') : '--';
            const items = [
                ['Length', mins + ' min', null], ['Rows', String(s.rows), null],
                ['Highest rpm', n('rpm', 0), null], ['Top speed', n('speed', 0), null],
                ['Peak boost', n('boost', c.boost && c.boost.unit === 'bar' ? 2 : 1), null], ['Peak power', n('power', 0), null],
                ['Worst knock retard', n('knock', 1), c.knock && c.knock.max >= 2 ? t.crit : null], ['Misfires in this file', isNum(s.misfires) ? String(s.misfires) : '--', s.misfires > 0 ? t.crit : null],
                ['Hottest coolant', n('coolant', 0), null], ['Hottest oil', n('oil', 0), null],
                ['AFR at full throttle', isNum(s.afrRich) ? s.afrRich.toFixed(1) + ' to ' + s.afrLean.toFixed(1) : '--', null], ['Hottest charge air', n('iat', 0), null],
            ];
            items.forEach((it, i) => {
                const x = 44 + (i % 2) * 760, y = 186 + Math.floor(i / 2) * 52;
                r.text(it[0].toUpperCase(), x, y, 19, t.dim, { font: 'bold', spacing: 1.5 });
                r.text(it[1], x + 700, y, 28, it[2] || t.text, { align: 'right', font: 'num' });
            });
            if (this.msg) r.text(this.msg, 44, 500, 20, t.crit);
            return targets;
        },
        move() {}, press() { return null; }, back() { if (o.onDone) o.onDone(); return 'close'; },
    };
    return S;
}
function unitText(k, u) {
    return ({ kmh: 'km/h', mph: 'mph', bar: 'bar', psi: 'psi', kpa: 'kPa', c: '°C', f: '°F', kw: 'kW', hp: 'hp' })[u] || (k === 'rpm' ? 'rpm' : k === 'knock' ? 'deg' : u);
}

module.exports = { fileSheet };
