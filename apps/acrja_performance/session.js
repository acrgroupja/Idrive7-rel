'use strict';
/**
 * Gauge Log's car-side logic: units, the CSV columns, auto start / stop and the recent history.
 *
 * No drawing and no head-unit APIs here, so this file moves to an iDrive 8 version unchanged.
 * Node 8 syntax only.
 */

const tiles = require('./tiles');

const KMH_PER_MPH = 1.609344, HP_PER_KW = 1.34102;

/** The CSV columns, always in metric units (the screen shows the chosen units). */
const COLUMNS = [
    { key: 'rpm', title: 'rpm', dec: 0 },
    { key: 'speed', title: 'speed_kmh', dec: 1 },
    { key: 'coolant', title: 'coolant_c', dec: 0 },
    { key: 'oil', title: 'oil_c', dec: 0 },
    { key: 'torque', title: 'torque_nm', dec: 0 },
    { key: 'power', title: 'power_kw', dec: 1 },
    { key: 'gear', title: 'gear' },
    { key: 'gLong', title: 'g_long', dec: 3 },
    { key: 'gLat', title: 'g_lat', dec: 3 },
    { key: 'pedal', title: 'pedal_pct', dec: 0 },
    // the engine unit's (empty when it doesn't answer)
    { key: 'boost', title: 'boost_bar', dec: 3 },
    { key: 'boostTarget', title: 'boost_target_bar', dec: 3 },
    { key: 'rail', title: 'fuel_hp_bar', dec: 1 },
    { key: 'railTarget', title: 'fuel_hp_target_bar', dec: 1 },
    { key: 'lambda', title: 'lambda', dec: 3 },
    { key: 'lambdaTarget', title: 'lambda_target', dec: 3 },
    { key: 'afr', title: 'afr', dec: 2 },
    { key: 'knock', title: 'knock_retard_deg', dec: 2 },
    { key: 'knockFlag', title: 'knock_flag', dec: 0 },
    { key: 'misfireTotal', title: 'misfires_total', dec: 0 },
    { key: 'mis1', title: 'misfires_cyl1', dec: 0 },
    { key: 'mis2', title: 'misfires_cyl2', dec: 0 },
    { key: 'mis3', title: 'misfires_cyl3', dec: 0 },
    { key: 'mis4', title: 'misfires_cyl4', dec: 0 },
    { key: 'mis5', title: 'misfires_cyl5', dec: 0 },
    { key: 'mis6', title: 'misfires_cyl6', dec: 0 },
    { key: 'intake', title: 'intake_c', dec: 0 },
    { key: 'chargeAir', title: 'charge_air_c', dec: 0 },
    { key: 'timing', title: 'timing_deg', dec: 2 },
    { key: 'tim1', title: 'timing_cyl1_deg', dec: 1 },
    { key: 'tim2', title: 'timing_cyl2_deg', dec: 1 },
    { key: 'tim3', title: 'timing_cyl3_deg', dec: 1 },
    { key: 'tim4', title: 'timing_cyl4_deg', dec: 1 },
    { key: 'tim5', title: 'timing_cyl5_deg', dec: 1 },
    { key: 'tim6', title: 'timing_cyl6_deg', dec: 1 },
    { key: 'wastegate', title: 'wastegate_pct', dec: 0 },
    { key: 'outside', title: 'outside_c', dec: 1 },
    { key: 'map', title: 'tune_map', dec: 0 },       // the BM3 / MHD map last confirmed or accepted (Tuning software)
    { key: 'mapName', title: 'tune_map_name' },       // its name on the Tune page (Rename maps), or empty
];

const isNum = (v) => typeof v === 'number' && isFinite(v);

/** kW from torque (Nm) and rpm. */
function powerKw(torque, rpm) { return isNum(torque) && isNum(rpm) ? torque * rpm / 9549 : null; }

/** The gear as the CSV writes it: R, N, 1-10, or empty. */
function gearText(g) { return g === -1 ? 'R' : g === 0 ? 'N' : isNum(g) && g > 0 ? String(g) : null; }

/**
 * The quantity of each column that has a unit (the rest - rpm, g, lambda, AFR, degrees, % - are the
 * same everywhere), its metric title's ending, and its decimals in the other units.
 */
const QUANT = { speed: 'speed', coolant: 'temp', oil: 'temp', intake: 'temp', chargeAir: 'temp', outside: 'temp', torque: 'torque',
    power: 'power', boost: 'boost', boostTarget: 'boost', rail: 'fuel', railTarget: 'fuel' };
const SUFFIX = { speed: { kmh: 'kmh', mph: 'mph' }, temp: { c: 'c', f: 'f' }, torque: { nm: 'nm', lbft: 'lbft' }, power: { kw: 'kw', hp: 'hp' },
    boost: { bar: 'bar', psi: 'psi', kpa: 'kpa' }, fuel: { bar: 'bar', psi: 'psi' } };
const UKEY = { speed: 'speed', temp: 'temp', torque: 'torque', power: 'power', boost: 'boost', fuel: 'fuel' };
const DEC = { psi: { boost: 2, fuel: 0 }, kpa: { boost: 1 }, hp: { power: 1 }, lbft: { torque: 0 }, mph: { speed: 1 }, f: { temp: 0 } };
/**
 * The columns for a log: u = null (or metric units): COLUMNS as they are; else each column with a unit
 * in u's unit, its title ending in it (speed_mph, boost_psi, torque_lbft, coolant_f, fuel_hp_psi ...).
 */
function columnsFor(u) {
    if (!u) return COLUMNS;
    return COLUMNS.map((c) => {
        const q = QUANT[c.key];
        if (!q) return c;
        const now = u[UKEY[q]], metric = Object.keys(SUFFIX[q])[0];
        if (!now || now === metric) return c;
        const title = c.title.replace(new RegExp('_' + SUFFIX[q][metric] + '$'), '_' + SUFFIX[q][now]);
        const dec = DEC[now] && DEC[now][q] !== undefined ? DEC[now][q] : c.dec;
        return Object.assign({}, c, { title, dec });
    });
}
/** A row (from row()) in u's units (null: as it is, metric). */
function rowIn(r, u) {
    if (!u) return r;
    const out = Object.assign({}, r);
    Object.keys(QUANT).forEach((k) => { if (typeof r[k] === 'number') out[k] = tiles.conv(QUANT[k], r[k], u); });
    return out;
}

/** One sample from car.data() for the logger. */
function row(d) {
    const e = d.dme || {}, mis = e.misfires || [], tim = e.timingCyl || [];
    return { rpm: d.rpm, speed: d.speed, coolant: d.coolant, oil: d.oil, torque: d.torque, power: powerKw(d.torque, d.rpm),
        gear: gearText(d.gear), gLong: d.gLong, gLat: d.gLat, pedal: d.pedal, outside: d.outside, map: d.tuneMap, mapName: d.tuneMapName,
        boost: e.boost, boostTarget: e.boostTarget, rail: e.rail, railTarget: e.railTarget, lambda: e.lambda, lambdaTarget: e.lambdaTarget,
        afr: e.afr, knock: e.knock, knockFlag: e.knockFlag, misfireTotal: e.misfireTotal, intake: e.intake,
        chargeAir: e.chargeAir, timing: e.timing, wastegate: e.wastegate,
        tim1: tim[0], tim2: tim[1], tim3: tim[2], tim4: tim[3], tim5: tim[4], tim6: tim[5],
        mis1: mis[0], mis2: mis[1], mis3: mis[2], mis4: mis[3], mis5: mis[4], mis6: mis[5] };
}

/**
 * Misfires counted from a start: the engine unit's counters are totals since its own start, so
 * this keeps the first total seen (and a new one when they go back to 0) and counts from it.
 */
class MisfireCount {
    constructor() { this.base = null; this.last = null; }
    feed(total) {
        if (!isNum(total)) return this.count();
        if (this.base === null || total < this.last) this.base = total;
        this.last = total;
        return this.count();
    }
    count() { return this.base === null ? null : this.last - this.base; }
    reset() { this.base = this.last; }
}

const units = {
    speed: (kmh, u) => (isNum(kmh) ? (u === 'mph' ? kmh / KMH_PER_MPH : kmh) : null),
    temp: (c, u) => (isNum(c) ? (u === 'f' ? c * 9 / 5 + 32 : c) : null),
    power: (kw, u) => (isNum(kw) ? (u === 'hp' ? kw * HP_PER_KW : kw) : null),
    /** A Celsius threshold in the chosen unit (for gauge zones). */
    tempAt: (c, u) => (u === 'f' ? c * 9 / 5 + 32 : c),
};

/**
 * Starts and stops logging by itself. mode: 'off', 'engine' (rpm over 400; stops 30 s after it
 * falls under 100 or goes quiet) or 'moving' (over 3 km/h; stops after 2 min under 1 km/h).
 * feed(d, now) returns 'start', 'stop' or null. A log stopped by hand while the condition holds
 * is not restarted until the condition has ended once (so Stop does what it says).
 */
class AutoLog {
    constructor() { this.active = false; this.offSince = 0; this.held = false; }

    feed(mode, d, now, logging) {
        if (mode !== 'engine' && mode !== 'moving') { this.active = false; this.held = false; return null; }
        const on = mode === 'engine' ? isNum(d.rpm) && d.rpm > 400 : isNum(d.speed) && d.speed > 3;
        const off = mode === 'engine' ? !isNum(d.rpm) || d.rpm < 100 : !isNum(d.speed) || d.speed < 1;
        const wait = mode === 'engine' ? 30000 : 120000;
        if (this.active && !logging) { this.active = false; this.held = true; }    // stopped by hand
        if (off) {
            if (!this.offSince) this.offSince = now;
            if (now - this.offSince >= wait) {
                this.held = false;
                if (this.active) { this.active = false; return 'stop'; }
            }
        } else this.offSince = 0;
        if (on && !logging && !this.held && !this.active) { this.active = true; return 'start'; }
        return null;
    }

    /** Logging started by hand: auto start/stop leaves it alone. */
    manual() { this.active = false; }
}

/** The last `seconds` of samples (one every `stepMs`), for the charts and tile traces. */
class History {
    constructor(seconds, stepMs) { this.max = Math.round(seconds * 1000 / stepMs); this.stepMs = stepMs; this.pts = []; this.last = 0; }
    feed(d, now) {
        if (now - this.last < this.stepMs) return;
        this.last = now;
        this.pts.push(Object.assign({ t: now }, tiles.readAll(d)));      // every value a tile can show
        if (this.pts.length > this.max) this.pts.splice(0, this.pts.length - this.max);
    }
    clear() { this.pts = []; this.last = 0; }
    /** [[seconds ago (negative), value], ...] of one field, the value passed through fn. */
    series(key, now, fn) {
        return this.pts.map((p) => [(p.t - now) / 1000, fn ? fn(p[key]) : p[key]]);
    }
    values(key) { return this.pts.map((p) => p[key]); }
}

/** "1:05:09" / "5:09" for a duration in ms. */
function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    const p = (n) => (n < 10 ? '0' : '') + n;
    return h ? h + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
}

/** "812 B" / "14.2 KB" / "3.1 MB". */
function size(bytes) {
    if (!isNum(bytes)) return '--';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = { columnsFor, rowIn, QUANT, MisfireCount, COLUMNS, row, powerKw, gearText, units, AutoLog, History, duration, size, isNum };
