'use strict';
/**
 * Gauge Log's Check page (iDrive 7): is the data coming? Left, each car signal the app reads: its value
 * and when it last changed (the car only sends a signal when it changes, so a parked car's speed can be
 * minutes old and still right). Right, the engine unit: the diagnostic link, how fast it is read, and
 * each identifier: answered (with its value), refused (this engine doesn't have it), no reply, or not
 * asked yet. Drawing only; main.js gathers o.
 */
const { withAlpha } = require('./kit/canvas');
const LOGO = require('./logo');

const UNITS = { chargeHpa: 'hPa', ambientHpa: 'hPa', boostTargetHpa: 'hPa', railMpa: 'MPa', railTargetMpa: 'MPa', lambda: '', lambdaTarget: '',
    knockRetard: '°', knockFlag: '', intakeC: '°C', chargeAirC: '°C', timing: '°', wastegate: '%', tim1: '°', tim2: '°', tim3: '°', tim4: '°', tim5: '°', tim6: '°' };
const isNum = (v) => typeof v === 'number' && isFinite(v);
const ago = (ms) => (!isNum(ms) ? 'never' : ms < 1500 ? 'now' : ms < 60000 ? Math.round(ms / 1000) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago' : 'over 1 h ago');

/**
 * o: { signals: [{ name, value (text), age (ms or null) }], demo, setting ('on'|'off'),
 *      link: { ready, available, error, sent, replies, missed }, status, rate, report: [{ id, name, answer, value, key, age }], keyOf(id) }
 */
function drawCheck(cv, t, G, o) {
    // car signals
    G.panel(cv, t, 24, 44, 560, 468, 'Car signals');
    cv.text('LAST CHANGE', 564, 110, 15, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    o.signals.forEach((s, i) => {
        const y = 146 + i * 34, seen = isNum(s.age);
        cv.circle(52, y - 7, 6, seen ? '#2fd27a' : t.crit);
        cv.text(s.name, 68, y, 22, t.text);
        cv.text(s.value, 420, y, 22, seen ? t.text : t.dim, { align: 'right' });
        cv.text(ago(s.age), 564, y, 18, t.dim, { align: 'right' });
    });
    if (o.credit) cv.text(o.credit, 44, 470, 15, t.dim);
    cv.text(o.demo ? 'Demo data is on: the values above are the car\'s own, or none' : 'Green: a value has come. Red: none yet (or this car lacks it).', 44, 500, 17, t.dim);

    // engine unit
    const L = o.link || {};
    G.panel(cv, t, 600, 44, 976, 468, 'Engine unit (DME)');
    LOGO.draw(cv, 'mark', 1576 - 20 - LOGO.size('mark').w, 62);
    let head, col = t.text;
    if (o.setting === 'off') { head = 'Off in Settings (Engine unit values)'; col = t.dim; } else if (o.demo) { head = 'Demo data: the engine unit is not asked'; col = t.warn; } else if (!L.ready) { head = 'Diagnostic link starting' + (L.error ? ': ' + L.error : ''); col = t.warn; } else if (o.status === 'reading') head = 'Reading ' + (isNum(o.rate) ? o.rate.toFixed(1) : '--') + ' times a second'; else if (o.status === 'no answer') { head = 'No answer: another engine, or the ignition off? Asked again every 30 s'; col = t.crit; } else head = o.status === 'probing' ? 'Asking which values this engine has ...' : 'Waiting (asked while the app is shown)';
    cv.text(head, 620, 108, 21, col);
    cv.text('requests ' + (L.sent || 0) + '  ·  replies ' + (L.replies || 0) + '  ·  none ' + (L.missed || 0), 1556, 108, 17, t.dim, { align: 'right' });
    const rows = o.report || [], half = Math.ceil(rows.length / 2), rh = Math.min(26, Math.floor(370 / Math.max(1, half)));
    rows.forEach((r, i) => {
        const x = i < half ? 620 : 1100, y = 144 + (i % half) * rh;
        const c = r.answer === 'yes' ? '#2fd27a' : r.answer === 'refused' ? t.warn : r.answer === 'no reply' ? t.crit : withAlpha(t.dim, 0.6);
        cv.circle(x + 6, y - 6, 5, c);
        cv.text(r.id, x + 18, y, 16, t.dim, { font: 'bold' });
        cv.text(r.name, x + 66, y, 17, t.text);
        const unit = UNITS[o.keyOf(r.id)] || '';
        const v = r.answer === 'yes' ? (isNum(r.value) ? (Math.abs(r.value) >= 100 ? r.value.toFixed(0) : r.value.toFixed(2)) + (unit ? ' ' + unit : '') : '--') : r.answer;
        cv.text(v, x + 456, y, 17, r.answer === 'yes' ? t.text : c, { align: 'right' });
    });
    cv.text('Green: answered  ·  amber: refused (this engine lacks it)  ·  red: no reply  ·  grey: not asked yet', 620, 500, 16, t.dim);
}

module.exports = { drawCheck };
