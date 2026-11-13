'use strict';
/**
 * Gauge Log's gauge pages: what a tile can show (the value catalog), the page layouts, and the
 * pages saved in data/pages.json.
 *
 * No drawing and no head-unit APIs here (only fs / path), so this file moves to an iDrive 8 version
 * unchanged. Layouts only name the kind of each slot ('dial', 'num', 'bar'); where a slot goes on
 * the screen is the screen code's job. Node 8 syntax only.
 */
const fs = require('fs');
const path = require('path');

const KMH_PER_MPH = 1.609344, HP_PER_KW = 1.34102, LBFT_PER_NM = 0.737562, PSI_PER_BAR = 14.5038, FT_PER_M = 3.28084;

/**
 * Units. One setting, units: 'metric', 'imperial' or 'custom' (then the per-quantity settings decide).
 * resolveUnits(get) -> { system, speed: 'kmh'|'mph', temp: 'c'|'f', power: 'kw'|'hp', boost: 'bar'|'psi'|'kpa',
 * torque: 'nm'|'lbft', fuel: 'bar'|'psi', dist: 'm'|'ft' }. Inside, everything stays metric.
 */
const SYSTEMS = {
    metric: { speed: 'kmh', temp: 'c', power: 'kw', boost: 'bar', torque: 'nm', fuel: 'bar', dist: 'm' },
    imperial: { speed: 'mph', temp: 'f', power: 'hp', boost: 'psi', torque: 'lbft', fuel: 'psi', dist: 'ft' },
};
function resolveUnits(get) {
    const sys = get('units') || 'metric';
    if (SYSTEMS[sys]) return Object.assign({ system: sys }, SYSTEMS[sys]);
    const speed = get('speedUnit') === 'mph' ? 'mph' : 'kmh';
    return { system: 'custom', speed, temp: get('tempUnit') === 'f' ? 'f' : 'c', power: get('powerUnit') === 'hp' ? 'hp' : 'kw',
        boost: ['psi', 'kpa'].indexOf(get('boostUnit')) >= 0 ? get('boostUnit') : 'bar', torque: get('torqueUnit') === 'lbft' ? 'lbft' : 'nm',
        fuel: get('fuelUnit') === 'psi' ? 'psi' : 'bar', dist: speed === 'mph' ? 'ft' : 'm' };
}
/** Conversions from the metric inside to the unit shown, and the unit's name. */
const CONV = {
    speed: { f: (v, u) => (u.speed === 'mph' ? v / KMH_PER_MPH : v), unit: (u) => (u.speed === 'mph' ? 'mph' : 'km/h') },
    temp: { f: (v, u) => (u.temp === 'f' ? v * 9 / 5 + 32 : v), unit: (u) => (u.temp === 'f' ? '°F' : '°C') },
    power: { f: (v, u) => (u.power === 'hp' ? v * HP_PER_KW : v), unit: (u) => (u.power === 'hp' ? 'hp' : 'kW') },
    torque: { f: (v, u) => (u.torque === 'lbft' ? v * LBFT_PER_NM : v), unit: (u) => (u.torque === 'lbft' ? 'lb-ft' : 'Nm') },
    boost: { f: (v, u) => (u.boost === 'psi' ? v * PSI_PER_BAR : u.boost === 'kpa' ? v * 100 : v), unit: (u) => (u.boost === 'psi' ? 'psi' : u.boost === 'kpa' ? 'kPa' : 'bar') },
    fuel: { f: (v, u) => (u.fuel === 'psi' ? v * PSI_PER_BAR : v), unit: (u) => (u.fuel === 'psi' ? 'psi' : 'bar') },
    dist: { f: (v, u) => (u.dist === 'ft' ? v * FT_PER_M : v), unit: (u) => (u.dist === 'ft' ? 'ft' : 'm') },
};
/** A metric value of quantity q ('speed', 'temp', ...) in the chosen unit; null stays null. */
function conv(q, v, u) { return isNum(v) ? CONV[q].f(v, u) : null; }
function unitOf(q, u) { return CONV[q].unit(u); }
const fuel = (v, u) => CONV.fuel.f(v, u), fUnit = (u) => CONV.fuel.unit(u), fDec = () => 0;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const cToF = (c) => c * 9 / 5 + 32;

/**
 * u = the display units and limits: { speed: 'kmh'|'mph', temp: 'c'|'f', power: 'kw'|'hp', rpmMax, redline }.
 * Each value: id, name, group; metric(d) from car.data() in metric units; show(v, u) into the chosen unit;
 * unit(u), dec, range(u) -> [min, max], zones(u) -> [{ from, to, color }], div (dial numbers / div), text (not a number).
 */
const VALUES = [
    { id: 'rpm', name: 'Engine speed', group: 'Engine', metric: (d) => d.rpm, unit: () => 'rpm', dec: 0,
        range: (u) => [0, u.rpmMax || 7000], zones: (u) => [{ from: u.redline || 6500, to: u.rpmMax || 7000, color: 'crit' }], div: 1000 },
    { id: 'speed', name: 'Speed', group: 'Driving', metric: (d) => d.speed, show: (v, u) => CONV.speed.f(v, u),
        unit: (u) => CONV.speed.unit(u), dec: 0, range: (u) => [0, u.speed === 'mph' ? 160 : 280] },
    { id: 'coolant', name: 'Coolant', group: 'Engine', metric: (d) => d.coolant, show: (v, u) => (u.temp === 'f' ? cToF(v) : v),
        unit: (u) => (u.temp === 'f' ? '°F' : '°C'), dec: 0, range: (u) => temps(u, 40, 130), zones: (u) => tempZones(u, 60, 112) },
    { id: 'oil', name: 'Oil', group: 'Engine', metric: (d) => d.oil, show: (v, u) => (u.temp === 'f' ? cToF(v) : v),
        unit: (u) => (u.temp === 'f' ? '°F' : '°C'), dec: 0, range: (u) => temps(u, 40, 150), zones: (u) => tempZones(u, 70, 135) },
    // the gearbox oil: the gearbox unit's (EGS) or the car's signal (gearbox.js); in the demo the oil's, a little behind
    { id: 'gearboxOil', name: 'Gearbox oil', group: 'Engine', metric: (d) => d.gearboxOil, show: (v, u) => (u.temp === 'f' ? cToF(v) : v),
        unit: (u) => (u.temp === 'f' ? '°F' : '°C'), dec: 0, range: (u) => temps(u, 20, 140), zones: (u) => tempZones(u, 60, 125) },
    { id: 'torque', name: 'Torque', group: 'Engine', metric: (d) => d.torque, show: (v, u) => CONV.torque.f(v, u), unit: (u) => CONV.torque.unit(u), dec: 0,
        range: (u) => [0, u.torque === 'lbft' ? 500 : 700] },
    { id: 'power', name: 'Power', group: 'Engine', metric: (d) => powerKw(d.torque, d.rpm), show: (v, u) => (u.power === 'hp' ? v * HP_PER_KW : v),
        unit: (u) => (u.power === 'hp' ? 'hp' : 'kW'), dec: 0, range: (u) => [0, u.power === 'hp' ? 550 : 400] },
    { id: 'gear', name: 'Gear', group: 'Driving', metric: (d) => d.gear, text: true },
    { id: 'g', name: 'G combined', group: 'Driving', metric: (d) => (isNum(d.gLong) && isNum(d.gLat) ? Math.sqrt(d.gLong * d.gLong + d.gLat * d.gLat) : null),
        unit: () => 'g', dec: 2, range: () => [0, 1.5] },
    { id: 'gLong', name: 'G longitudinal', group: 'Driving', metric: (d) => d.gLong, unit: () => 'g', dec: 2, range: () => [-1.2, 1.2] },
    { id: 'gLat', name: 'G lateral', group: 'Driving', metric: (d) => d.gLat, unit: () => 'g', dec: 2, range: () => [-1.5, 1.5] },
    { id: 'pedal', name: 'Accelerator pedal', group: 'Driving', metric: (d) => d.pedal, unit: () => '%', dec: 0, range: () => [0, 100] },
    // the engine unit's (engine_dme.js): d.dme = values()
    { id: 'boost', name: 'Boost', group: 'Engine unit', metric: (d) => dme(d, 'boost'), show: pressure, unit: pUnit, dec: 2, decOf: pDec, range: pRange },
    { id: 'boostTarget', name: 'Boost target', group: 'Engine unit', metric: (d) => dme(d, 'boostTarget'), show: pressure, unit: pUnit, dec: 2, decOf: pDec, range: pRange },
    { id: 'boostDev', name: 'Boost minus target', group: 'Engine unit', metric: (d) => diff(dme(d, 'boost'), dme(d, 'boostTarget')), show: pressure, unit: pUnit, dec: 2, decOf: pDec,
        range: (u) => [-pressure(0.5, u), pressure(0.5, u)], zones: (u) => [{ from: -999, to: -pressure(0.15, u), color: 'warn' }] },
    { id: 'rail', name: 'Fuel high pressure', group: 'Engine unit', metric: (d) => dme(d, 'rail'), show: fuel, unit: fUnit, dec: 0, range: (u) => [0, fuel(400, u)] },
    { id: 'railTarget', name: 'Fuel high pressure target', group: 'Engine unit', metric: (d) => dme(d, 'railTarget'), show: fuel, unit: fUnit, dec: 0, range: (u) => [0, fuel(400, u)] },
    { id: 'railDev', name: 'Fuel HP minus target', group: 'Engine unit', metric: (d) => diff(dme(d, 'rail'), dme(d, 'railTarget')), show: fuel, unit: fUnit, dec: 0,
        range: (u) => [fuel(-60, u), fuel(60, u)], zones: (u) => [{ from: -1e9, to: fuel(-25, u), color: 'crit' }] },
    { id: 'afr', name: 'AFR', group: 'Engine unit', metric: (d) => dme(d, 'afr'), unit: () => ':1', dec: 1, range: (u) => [(u.stoich || 14.7) * 0.7, (u.stoich || 14.7) * 1.15],
        zones: (u) => [{ from: (u.stoich || 14.7) * 0.93, to: 99, color: 'warn' }] },
    { id: 'afrTarget', name: 'AFR target', group: 'Engine unit', metric: (d) => dme(d, 'afrTarget'), unit: () => ':1', dec: 1, range: (u) => [(u.stoich || 14.7) * 0.7, (u.stoich || 14.7) * 1.15] },
    { id: 'lambda', name: 'Lambda', group: 'Engine unit', metric: (d) => dme(d, 'lambda'), unit: () => '', dec: 2, range: () => [0.7, 1.15], zones: () => [{ from: 0.93, to: 9, color: 'warn' }] },
    { id: 'lambdaTarget', name: 'Lambda target', group: 'Engine unit', metric: (d) => dme(d, 'lambdaTarget'), unit: () => '', dec: 2, range: () => [0.7, 1.15] },
    { id: 'knock', name: 'Knock retard', group: 'Engine unit', metric: (d) => dme(d, 'knock'), unit: () => '°', dec: 1, range: () => [0, 6],
        zones: () => [{ from: 1.5, to: 3, color: 'warn' }, { from: 3, to: 99, color: 'crit' }] },
    { id: 'misfires', name: 'Misfires', group: 'Engine unit', metric: (d) => d.misfires, unit: () => '', dec: 0, range: () => [0, 50],
        zones: () => [{ from: 1, to: 99999, color: 'crit' }] },
    { id: 'timing', name: 'Ignition timing', group: 'Engine unit', metric: (d) => dme(d, 'timing'), unit: () => '°', dec: 1, range: () => [-10, 50] },
    { id: 'timingSpread', name: 'Timing spread', group: 'Engine unit', metric: (d) => dme(d, 'timingSpread'), unit: () => '°', dec: 1, range: () => [0, 6],
        zones: () => [{ from: 2, to: 4, color: 'warn' }, { from: 4, to: 99, color: 'crit' }] },
    { id: 'wastegate', name: 'Wastegate position', group: 'Engine unit', metric: (d) => dme(d, 'wastegate'), unit: () => '%', dec: 0, range: () => [0, 100] },
    { id: 'chargeAir', name: 'Charge air (before throttle)', group: 'Engine unit', metric: (d) => dme(d, 'chargeAir'), show: (v, u) => (u.temp === 'f' ? cToF(v) : v),
        unit: (u) => (u.temp === 'f' ? '°F' : '°C'), dec: 0, range: (u) => temps(u, 0, 100), zones: (u) => tempZones(u, -99, 65).slice(1) },
    // ACR Automobile's logo, as a tile of its own (any slot, any page)
    { id: 'ethanol', name: 'Ethanol', group: 'Engine unit', metric: (d) => dme(d, 'ethanol'), unit: () => '%', dec: 0, range: () => [0, 100] },
    { id: 'octane', name: 'Adapted octane', group: 'Engine unit', metric: (d) => dme(d, 'octane'), unit: () => 'RON', dec: 1, range: () => [91, 98] },
    { id: 'sinceRefuel', name: 'Since refuelling', group: 'Engine unit', metric: (d) => { const m = dme(d, 'sinceRefuel'); return isNum(m) ? m / 60 : null; },
        unit: () => 'h', dec: 1, range: () => [0, 48] },
    { id: 'throttle', name: 'Throttle plate', group: 'Engine unit', metric: (d) => dme(d, 'throttle'), unit: () => '%', dec: 0, range: () => [0, 100] },
    { id: 'acrLogo', name: 'ACR logo', group: 'ACR Automobile', metric: () => null, logo: true },
    // actual against target: drawn as one graph (gauges_ui), with limits and a tolerance (PAIRS)
    { id: 'boostPair', name: 'Boost vs target', group: 'Actual vs target', pair: ['boost', 'boostTarget'], metric: (d) => dme(d, 'boost'), show: pressure, unit: pUnit, dec: 2, decOf: pDec },
    { id: 'railPair', name: 'Fuel HP vs target', group: 'Actual vs target', pair: ['rail', 'railTarget'], metric: (d) => dme(d, 'rail'), show: fuel, unit: fUnit, dec: 0 },
    { id: 'afrPair', name: 'AFR vs target', group: 'Actual vs target', pair: ['afr', 'afrTarget'], metric: (d) => dme(d, 'afr'), unit: () => ':1', dec: 1 },
    { id: 'lambdaPair', name: 'Lambda vs target', group: 'Actual vs target', pair: ['lambda', 'lambdaTarget'], metric: (d) => dme(d, 'lambda'), unit: () => '', dec: 2 },
    { id: 'intake', name: 'Intake air', group: 'Engine unit', metric: (d) => dme(d, 'intake'), show: (v, u) => (u.temp === 'f' ? cToF(v) : v),
        unit: (u) => (u.temp === 'f' ? '°F' : '°C'), dec: 0, range: (u) => temps(u, -10, 80), zones: (u) => tempZones(u, -99, 60).slice(1) },
];
const BY_ID = {};
VALUES.forEach((v) => { BY_ID[v.id] = v; });

function dme(d, k) { return d.dme ? d.dme[k] : null; }
function diff(a, b) { return isNum(a) && isNum(b) ? a - b : null; }
/** Pressures are bar (over ambient) inside; shown as bar, psi or kPa. */
function pressure(bar, u) { return CONV.boost.f(bar, u); }
function pUnit(u) { return CONV.boost.unit(u); }
function pDec(u) { return u.boost === 'psi' ? 1 : u.boost === 'kpa' ? 0 : 2; }
function pRange(u) { return [0, pressure(2, u)]; }
function temps(u, lo, hi) { return u.temp === 'f' ? [cToF(lo), cToF(hi)] : [lo, hi]; }
function tempZones(u, cold, hot) {
    const c = (x) => (u.temp === 'f' ? cToF(x) : x);
    return [{ from: -999, to: c(cold), color: 'cold' }, { from: c(hot), to: 9999, color: 'crit' }];
}
function powerKw(torque, rpm) { return isNum(torque) && isNum(rpm) ? torque * rpm / 9549 : null; }

/** Every value's metric reading from car.data(): { rpm, speed, ... }. */
function readAll(d) {
    const out = {};
    VALUES.forEach((v) => { const x = v.metric(d); out[v.id] = isNum(x) ? x : null; });
    return out;
}
/** A metric reading in the chosen unit. */
function show(id, v, u) {
    const c = BY_ID[id];
    if (!c || !isNum(v)) return null;
    return c.show ? c.show(v, u) : v;
}
/** A value's decimals in the chosen units. */
function decOf(id, u) { const c = BY_ID[id]; return c ? (c.decOf ? c.decOf(u) : c.dec) : 0; }
/** The gear as text: R, N, 1-10, or '-'. */
function gearText(g) { return g === -1 ? 'R' : g === 0 ? 'N' : isNum(g) && g > 0 ? String(g) : '-'; }

/**
 * Limits of an actual-vs-target tile, in the values' own units (bar over ambient, bar, :1, lambda):
 * lo / hi = the graph's range, tol = how far actual may be from target before the tile flashes.
 * The choices offered for each, and what a new tile starts with.
 */
// also: dir = which side flashes (0 both, -1 under target only, 1 over target only); thr = flash only with the accelerator
// pedal at or above this % (0: always); AFR / lambda: ct = a custom target (0: off), tsrc = when it is used (0: when the
// engine unit gives no target, 1: always, in place of the engine unit's)
const DIR = [0, -1, 1], THR = [0, 25, 40, 50, 60, 70, 80, 90], TSRC = [0, 1];
const PAIRS = {
    boostPair: { lo: 0, hi: 2, tol: 0.15, dir: 0, thr: 0, steps: { lo: [-1, -0.5, 0, 0.5], hi: [1, 1.5, 2, 2.5, 3, 3.5], tol: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5], dir: DIR, thr: THR } },
    railPair: { lo: 0, hi: 400, tol: 25, dir: 0, thr: 0, steps: { lo: [0, 50, 100, 150, 200], hi: [200, 250, 300, 350, 400, 500], tol: [10, 15, 20, 25, 35, 50], dir: DIR, thr: THR } },
    afrPair: { lo: 10, hi: 16, tol: 0.6, dir: 0, thr: 70, ct: 0, tsrc: 0, steps: { lo: [8, 9, 10, 11, 12], hi: [13, 14, 15, 16, 17], tol: [0.2, 0.3, 0.4, 0.6, 0.8, 1, 1.5],
        dir: DIR, thr: THR, ct: [0, 11, 11.3, 11.5, 11.8, 12, 12.2, 12.5, 13, 13.5, 14.7], tsrc: TSRC } },
    lambdaPair: { lo: 0.7, hi: 1.1, tol: 0.04, dir: 0, thr: 70, ct: 0, tsrc: 0, steps: { lo: [0.6, 0.7, 0.8, 0.9], hi: [1, 1.05, 1.1, 1.2], tol: [0.02, 0.03, 0.04, 0.05, 0.08, 0.1],
        dir: DIR, thr: THR, ct: [0, 0.75, 0.77, 0.78, 0.8, 0.82, 0.83, 0.85, 0.88, 0.92, 1], tsrc: TSRC } },
};
const LIMIT_KEYS = ['tol', 'dir', 'thr', 'ct', 'tsrc', 'lo', 'hi'];   // in the sheet: what decides the flashing first, the graph's range last
const LIMIT_NAMES = { lo: 'Graph low', hi: 'Graph high', tol: 'Tolerance', dir: 'Flash when', thr: 'Watch from', ct: 'Custom target', tsrc: 'Use custom target' };
/** A limit as text where it isn't a number in the value's unit (null: it is one). */
function limitText(k, v) {
    if (k === 'dir') return v < 0 ? 'Under target only' : v > 0 ? 'Over target only' : 'Under or over';
    if (k === 'thr') return v > 0 ? v + ' % and up' : 'Always';
    if (k === 'ct' && !(v > 0)) return 'Off';
    if (k === 'tsrc') return v === 1 ? 'Always (ignore the engine)' : 'When the engine gives none';
    return null;
}
/** The target an actual-vs-target tile compares with: the engine unit's, or the custom one. { v, custom } */
function pairTarget(lim, engine) {
    if (lim && lim.ct > 0 && (lim.tsrc === 1 || !isNum(engine))) return { v: lim.ct, custom: true };
    return { v: isNum(engine) ? engine : null, custom: false };
}
/** Out of tolerance on the side that counts: dir 0 either, -1 under (a < target - tol), 1 over. */
function outOfTol(a, tg, tol, dir) {
    if (!isNum(a) || !isNum(tg) || !isNum(tol)) return false;
    return dir < 0 ? a < tg - tol : dir > 0 ? a > tg + tol : Math.abs(a - tg) > tol;
}
/** A pair's defaults (its limits with nothing saved). */
function pairDefaults(id) { return limitsOf({ tiles: [id], cfg: {} }, 0); }
/** A tile's limits: the page's saved ones over the defaults; null for a tile that is no pair. */
function limitsOf(pg, i) {
    const id = pg && pg.tiles[i], P = PAIRS[id];
    if (!P) return null;
    const c = (pg.cfg && pg.cfg[i]) || {};
    const out = {};
    LIMIT_KEYS.forEach((k) => { if (k in P) out[k] = isNum(c[k]) ? c[k] : P[k]; });
    if (out.hi <= out.lo) out.hi = P.steps.hi.filter((x) => x > out.lo)[0] || out.lo + 1;
    return out;
}

/**
 * When to flash: actual further than tol from target for HOLD_IN ms in a row; it keeps flashing until
 * back inside for HOLD_OUT ms (so a value on the edge doesn't flicker). A target the car changes in a
 * step (boost on a tip-in) leads the actual by a moment: HOLD_IN keeps that from flashing.
 * new Alarm(); alarm.feed(actual, target, tol, now) -> true while flashing.
 */
const HOLD_IN = 500, HOLD_OUT = 1000;
class Alarm {
    /** opts: { holdIn, holdOut } ms (a single value's flash: 0 and 1500, see ALARMS). */
    constructor(opts) {
        this.outSince = null; this.inSince = null; this.on = false;
        this.holdIn = opts && isNum(opts.holdIn) ? opts.holdIn : HOLD_IN; this.holdOut = opts && isNum(opts.holdOut) ? opts.holdOut : HOLD_OUT;
    }
    feed(a, b, tol, now, dir, watch) { return this.step(watch !== false && outOfTol(a, b, tol, dir || 0), now); }
    /** A single value against its flash limits (null: that side off). */
    feedLimits(v, hi, lo, now) { return this.step(isNum(v) && ((isNum(hi) && v > hi) || (isNum(lo) && v < lo)), now); }
    step(out, now) {
        const HOLD_IN = this.holdIn, HOLD_OUT = this.holdOut;
        if (out) {
            this.inSince = null;
            if (this.outSince === null) this.outSince = now;
            if (now - this.outSince >= HOLD_IN) this.on = true;
        } else {
            this.outSince = null;
            if (this.on) { if (this.inSince === null) this.inSince = now; if (now - this.inSince >= HOLD_OUT) this.on = false; }
        }
        return this.on;
    }
}

/**
 * Flash limits of a single-value tile (not an actual-vs-target one): ahi = flash above, alo = flash below,
 * in the value's metric unit, null = off. The values that have them, what a new tile starts with, and the
 * choices offered. A crossing flashes at once (a short knock spike counts) and for 1.5 s after.
 */
const ALARMS = {
    knock: { ahi: 2, steps: { ahi: [0.5, 1, 1.5, 2, 3, 4] } },
    timingSpread: { ahi: 3, steps: { ahi: [1, 1.5, 2, 3, 4, 5] } },
    misfires: { ahi: 0, steps: { ahi: [0, 1, 2, 5, 10] } },
    coolant: { ahi: 110, alo: null, steps: { ahi: [100, 105, 110, 115, 120], alo: [40, 60, 70, 80] } },
    oil: { ahi: 135, alo: null, steps: { ahi: [120, 125, 130, 135, 140, 150], alo: [50, 60, 70, 80] } },
    intake: { ahi: null, steps: { ahi: [40, 45, 50, 55, 60, 70] } },
    chargeAir: { ahi: null, steps: { ahi: [40, 50, 55, 60, 70, 80] } },
    boost: { ahi: null, steps: { ahi: [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5] } },
    rail: { alo: null, steps: { alo: [100, 150, 200, 250, 300] } },
    railDev: { alo: null, steps: { alo: [-50, -35, -25, -15, -10] } },
    afr: { ahi: null, steps: { ahi: [12, 12.5, 13, 13.5, 14, 15] } },
    lambda: { ahi: null, steps: { ahi: [0.85, 0.88, 0.9, 0.95, 1, 1.05] } },
    rpm: { ahi: null, steps: { ahi: [4500, 5000, 5500, 6000, 6500, 7000, 7500] } },
    speed: { ahi: null, steps: { ahi: [80, 100, 120, 150, 200, 250] } },
    timing: { alo: null, steps: { alo: [-5, 0, 5, 10] } },
};
const ALARM_KEYS = ['ahi', 'alo'];
const ALARM_NAMES = { ahi: 'Flash above', alo: 'Flash below' };
/** A single-value tile's flash limits { ahi, alo } (null: off), or null for a value that has none. */
function alarmsOf(pg, i) {
    const id = pg && pg.tiles[i], A = ALARMS[id];
    if (!A) return null;
    const c = (pg.cfg && pg.cfg[i]) || {}, out = {};
    ALARM_KEYS.forEach((k) => { if (k in A) out[k] = c[k] === null || isNum(c[k]) ? c[k] : A[k]; });
    return out;
}

/** Page layouts: the kind of each slot, in reading order. */
const LAYOUTS = [
    { id: 'classic', name: '2 dials + 6 numbers', slots: ['dial', 'dial', 'num', 'num', 'num', 'num', 'num', 'num'] },
    { id: 'dial1n4', name: 'Dial + 4 numbers', slots: ['dial', 'num', 'num', 'num', 'num'] },
    { id: 'dial1b3', name: 'Dial + 3 bars', slots: ['dial', 'bar', 'bar', 'bar'] },
    { id: 'dials3', name: '3 dials', slots: ['dial', 'dial', 'dial'] },
    { id: 'dials2', name: '2 dials', slots: ['dial', 'dial'] },
    { id: 'nums6', name: '6 numbers', slots: ['num', 'num', 'num', 'num', 'num', 'num'] },
    { id: 'nums4', name: '4 numbers', slots: ['num', 'num', 'num', 'num'] },
    { id: 'bars4', name: '4 bars', slots: ['bar', 'bar', 'bar', 'bar'] },
];
const MAX_PAGES = 6, MAX_SLOTS = 8;      // a page keeps 8 values, so a layout with fewer tiles and back loses none
const layout = (id) => LAYOUTS.filter((l) => l.id === id)[0] || LAYOUTS[0];
const nextLayout = (id) => LAYOUTS[(LAYOUTS.indexOf(layout(id)) + 1) % LAYOUTS.length].id;

/** The Drag page's 6 live tiles to start with: the actual-vs-target graphs (left), knock and timing (right, bottom). */
const DRAG_DEFAULT = { layout: 'nums6', tiles: ['boostPair', 'railPair', 'afrPair', 'lambdaPair', 'knock', 'timing'] };

/** What a new install starts with. */
const DEFAULTS = [
    { layout: 'classic', tiles: ['rpm', 'speed', 'coolant', 'oil', 'torque', 'power', 'gear', 'g'] },
    { layout: 'dial1b3', tiles: ['rpm', 'oil', 'coolant', 'power'] },
    { layout: 'nums4', tiles: ['boostPair', 'railPair', 'afrPair', 'knock'] },
    { layout: 'nums6', tiles: ['boost', 'boostTarget', 'afr', 'knock', 'rail', 'misfires'] },
];
/** The value a new tile gets: the first one the page doesn't show yet. */
function fill(tiles, n) {
    const out = tiles.slice(0, n);
    while (out.length < n) {
        const free = VALUES.filter((v) => out.indexOf(v.id) < 0)[0];
        out.push(free ? free.id : VALUES[0].id);
    }
    return out;
}
function clean(p) {
    if (!p || typeof p !== 'object') return null;
    const L = layout(p.layout);
    const tiles = Array.isArray(p.tiles) ? p.tiles.map((id) => (BY_ID[id] || id === null ? id : null)) : [];
    const cfg = {};
    if (p.cfg && typeof p.cfg === 'object') {
        Object.keys(p.cfg).forEach((i) => {
            const c = p.cfg[i], o = {};
            if (c && typeof c === 'object') LIMIT_KEYS.forEach((k) => { if (isNum(c[k])) o[k] = c[k]; });
            if (c && typeof c === 'object') ALARM_KEYS.forEach((k) => { if (isNum(c[k]) || c[k] === null) o[k] = c[k]; });
            if (Object.keys(o).length && Number(i) >= 0 && Number(i) < MAX_SLOTS) cfg[i] = o;
        });
    }
    return { layout: L.id, tiles: fill(tiles, MAX_SLOTS), cfg };
}

/**
 * The saved gauge pages. new Pages(file, log): reads it (or the defaults). Every change saves.
 *   list                       [{ layout, tiles: [valueId|null] x 8 }]: the layout shows the first slots.length
 *   setTile(p, i, id)          tile i of page p shows value id (null: empty)
 *   setLayout(p, id)           the page's layout; its values stay by position (all 8 are kept)
 *   add()                      a new page after the last (copy of the defaults' first); false at MAX_PAGES
 *   remove(p)                  false for the last page left
 */
class Pages {
    constructor(file, log) {
        this.file = file; this.log = log || { info() {}, warn() {} };
        this.ver = 0;
        this.load();
    }
    /** (Re)read the file: at start, and after a set-up came from a USB stick. */
    load() {
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* first start */ }
        const list = saved && Array.isArray(saved.pages) ? saved.pages.map(clean).filter(Boolean).slice(0, MAX_PAGES) : [];
        this.list = list.length ? list : DEFAULTS.map(clean);
        // the Drag page's live mini tiles: a page of its own (6 slots; the 4-tile setting shows the first 4), p = 'drag'
        this.drag = clean(saved && saved.drag) || clean(DRAG_DEFAULT);
        if (this.drag.layout !== 'nums6') this.drag.layout = 'nums6';
        this.ver++;
    }
    /** What a set-up export carries (and import() takes back): the pages and the Drag page's tiles. */
    data() { return { pages: this.list, drag: this.drag }; }
    import(d) {
        const list = d && Array.isArray(d.pages) ? d.pages.map(clean).filter(Boolean).slice(0, MAX_PAGES) : [];
        if (!list.length) return false;
        this.list = list;
        const dr = clean(d.drag);
        if (dr) { dr.layout = 'nums6'; this.drag = dr; }
        this.save(); return true;
    }
    save() {
        this.ver++;
        try {
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ v: 1, pages: this.list, drag: this.drag }) + '\n');
            fs.renameSync(tmp, this.file);
        } catch (e) { this.log.warn('save pages: ' + e.message); }
    }
    /** Page p: an index into list, or 'drag' (the Drag page's mini tiles). */
    page(p) { return p === 'drag' ? this.drag : this.list[p]; }
    setTile(p, i, id) {
        const pg = this.page(p);
        if (!pg || i < 0 || i >= layout(pg.layout).slots.length || (id !== null && !BY_ID[id])) return false;
        if (pg.tiles[i] !== id && pg.cfg) delete pg.cfg[i];         // a new value starts with its own defaults
        pg.tiles[i] = id; this.save(); return true;
    }
    /** Limit k ('lo', 'hi', 'tol') of tile i (an actual-vs-target tile). */
    setLimit(p, i, k, v) {
        const pg = this.page(p), id = pg && pg.tiles[i];
        if (!pg) return false;
        const pairOk = PAIRS[id] && LIMIT_KEYS.indexOf(k) >= 0 && (k in PAIRS[id]) && isNum(v);
        const alarmOk = ALARMS[id] && ALARM_KEYS.indexOf(k) >= 0 && (k in ALARMS[id]) && (isNum(v) || v === null);
        if (!pairOk && !alarmOk) return false;
        pg.cfg = pg.cfg || {};
        pg.cfg[i] = Object.assign({}, pg.cfg[i], { [k]: v });
        this.save(); return true;
    }
    setLayout(p, id) {
        const pg = this.list[p];
        if (!pg) return false;
        pg.layout = layout(id).id;
        this.save(); return true;
    }
    add() {
        if (this.list.length >= MAX_PAGES) return false;
        this.list.push(clean({ layout: 'nums4', tiles: [] }));
        this.save(); return true;
    }
    remove(p) {
        if (this.list.length <= 1 || !this.list[p]) return false;
        this.list.splice(p, 1); this.save(); return true;
    }
}

module.exports = { limitText, pairTarget, outOfTol, pairDefaults, ALARMS, ALARM_KEYS, ALARM_NAMES, alarmsOf, DRAG_DEFAULT, SYSTEMS, resolveUnits, CONV, conv, unitOf, PAIRS, LIMIT_KEYS, LIMIT_NAMES, limitsOf, Alarm, decOf, VALUES, BY_ID, LAYOUTS, MAX_PAGES, MAX_SLOTS, DEFAULTS, layout, nextLayout, readAll, show, gearText, powerKw, Pages, isNum };
