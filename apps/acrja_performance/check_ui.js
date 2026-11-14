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
    knockRetard: '°', knockFlag: '', intakeC: '°C', chargeAirC: '°C', timing: '°', wastegate: '%', tim1: '°', tim2: '°', tim3: '°', tim4: '°', tim5: '°', tim6: '°',
    throttlePct: '%', boostErrHpa: 'hPa', fuelQualityFactor: '', sinceRefuelMin: 'min', ethanolPct: '%' };
const isNum = (v) => typeof v === 'number' && isFinite(v);
const ago = (ms) => (!isNum(ms) ? 'never' : ms < 1500 ? 'now' : ms < 60000 ? Math.round(ms / 1000) + ' s ago' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago' : 'over 1 h ago');

/**
 * o: { signals: [{ name, value (text), age (ms or null) }], demo, setting ('on'|'off'),
 *      link: { ready, available, error, sent, replies, missed }, status, rate, report: [{ id, name, answer, value, key, age }], keyOf(id) }
 */
function drawCheck(cv, t, G, o) {
    // car signals
    G.panel(cv, t, 24, 44, 560, 468, 'Car signals');
    cv.text('LAST CHANGE', 564, 110, 17, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    o.signals.forEach((s, i) => {
        const y = 146 + i * 34, seen = isNum(s.age);
        cv.circle(52, y - 7, 6, seen ? '#2fd27a' : t.crit);
        cv.text(s.name, 68, y, 22, t.text);
        cv.text(s.value, 420, y, 22, seen ? t.text : t.dim, { align: 'right' });
        cv.text(ago(s.age), 564, y, 18, t.dim, { align: 'right' });
    });
    if (o.credit) cv.text(o.credit, 44, 478, 15, t.dim);
    cv.text(o.demo ? 'Demo data is on: the values above are the car\'s own, or none' : 'Green: a value has come. Red: none yet (or this car lacks it).', 44, 504, 17, t.dim);

    // engine unit
    const L = o.link || {};
    G.panel(cv, t, 600, 44, 976, 468, 'Engine unit (DME)');
    LOGO.draw(cv, 'mark', 1576 - 20 - LOGO.size('mark').w, 62);
    let head, col = t.text;
    if (o.setting === 'off') { head = 'Off in Settings (Engine unit values)'; col = t.dim; } else if (o.demo) { head = 'Demo data: the engine unit is not asked'; col = t.warn; } else if (!L.ready) { head = 'Diagnostic link starting' + (L.error ? ': ' + L.error : ''); col = t.warn; } else if (o.status === 'reading') head = 'Reading ' + (isNum(o.rate) ? o.rate.toFixed(1) : '--') + ' times a second'; else if (o.status === 'no answer') { head = o.have ? 'No answer for ' + Math.round((o.health && o.health.since || 0) / 1000) + ' s: asking again' : 'No answer: another engine, or the ignition off? Asked again every 10 s'; col = t.crit; } else head = o.status === 'probing' ? 'Asking which values this engine has ...' : 'Waiting (asked while the app is shown)';
    // in plain words: how many values answer (the list below is for technicians)
    const rep = o.report || [], yes = rep.filter((r) => r.answer === 'yes').length, nr = rep.filter((r) => r.answer === 'no reply').length;
    const lacks = rep.filter((r) => r.answer === 'refused').length;
    if (o.status === 'reading' && L.ready && !o.demo && o.setting !== 'off') {
        head = (nr ? '' : 'All good  ·  ') + yes + ' values answering' + (nr ? '  ·  ' + nr + ' not yet (asked again)' : '') + (lacks ? '  ·  ' + lacks + ' not on this engine' : '');
        col = nr ? t.warn : '#2fd27a';
    }
    cv.text(head, 620, 110, 22, col, { font: 'bold' });
    if (o.status === 'reading' && isNum(o.rate)) cv.text(o.rate.toFixed(1) + ' updates a second', 1556, 110, 19, t.dim, { align: 'right' });
    const rows = o.report || [], half = Math.ceil(rows.length / 2), rh = Math.min(26, Math.floor(296 / Math.max(1, half)));
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
    // cross-checks of the targets: 4AB0 against the boost controller's own (actual + its error, 4536); lambda target as AFR
    const X = o.cross;
    if (X) {
        const f = (v, d) => (isNum(v) ? v.toFixed(d) : '--');
        cv.text('Boost target  4AB0 ' + f(X.boostTarget, 2) + ' bar  ·  controller (actual + 4536) ' + f(X.boostTargetCtl, 2) + ' bar  ·  boost ' + f(X.boost, 2) +
            ' bar     AFR target ' + f(X.afrTarget, 1) + ' (lambda ' + f(X.lambdaTarget, 2) + ' x ' + f(X.stoich, 2) + (X.stoichAuto ? ' auto' : '') + ')' +
            '     ethanol ' + (isNum(X.ethanol) ? Math.round(X.ethanol) + '% (' + (X.ethanolFrom || '550D') + ')' : '--'), 620, 450, 16, t.text);
    }
    if (o.gearbox) {
        const gs = { EGS: 'gearbox unit', signal: "car's signal" }[o.gearbox.source] || 'not found yet';
        cv.text('Gearbox oil ' + (isNum(o.gearbox.temp) ? Math.round(o.gearbox.temp) + ' °C' : '--') + ' (' + gs + ')', 1556, 474, 16, t.dim, { align: 'right' });
    }
    // Fuel quality: a sheet with the engine unit's fuel quality history (also the bar's Fuel quality)
    if (o.fuel) {
        const fx = 1100, fy = 54, fw = 200, fh = 38;
        cv.roundRect(fx, fy, fw, fh, 19, withAlpha('#ffffff', 0.08));
        cv.strokeRoundRect(fx, fy, fw, fh, 19, 1.5, withAlpha('#ffffff', 0.25));
        cv.text('Fuel quality', fx + fw / 2, fy + 26, 20, t.text, { align: 'center', font: 'bold' });
        if (cv.own) cv.target(fx - 4, fy - 4, fw + 8, fh + 8, o.fuel, 'check:fuel');
    }
    const H = o.health;
    if (H) cv.text((isNum(H.latency) ? Math.round(H.latency) + ' ms a request' + (H.fast ? ' · fast mode' : '') + '  ·  ' : '') + 'Dropouts ' + H.gaps + '  ·  errors ' + H.errors + '  ·  restarts ' + H.restarts + '  ·  requests ' + (L.sent || 0) + ' / replies ' + (L.replies || 0) + (H.lastError ? '  ·  last: ' + String(H.lastError).slice(0, 30) : ''),
        620, 476, 17, H.gaps || H.errors || H.restarts ? t.warn : t.dim);
    cv.text('Green answered  ·  amber not on this engine  ·  red no reply (asked again every 15 s)  ·  grey not asked', 620, 502, 19, t.dim);
}

module.exports = { drawCheck };
