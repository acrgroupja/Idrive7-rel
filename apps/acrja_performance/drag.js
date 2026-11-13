'use strict';
/**
 * Gauge Log's drag mode: times a run from a standstill and records what the engine did on it.
 *
 * Timing is the kit's RunTimer (kit/run_timer.js, as in the Drag Timer app): stop the car for 1 s
 * and it arms; the clock starts on the first movement (or after one foot of travel with rollout,
 * as a strip's staging beam does), distance is the speed integrated, crossings are interpolated
 * between samples. The run ends when you lift (5 km/h under the run's top speed), when every split
 * is done, or after 40 s. Distances come from the speed signal: a strip's timing slip is the
 * reference; this is close, not certified.
 *
 * Per run, besides the splits and trap speeds: launch rpm, the shifts (gear, rpm before, time),
 * peak boost and its target, the richest and leanest AFR at full throttle, the most knock retard,
 * misfires during the run, peak g, the lowest rail pressure against its target, and the conditions
 * at the start (intake, outside, coolant, oil). Runs are saved in data/drag_runs.json (the last 30,
 * and the best time of each split). Demo runs are kept apart and never saved.
 *
 * No drawing and no head-unit APIs (only fs / path); RunTimer is plain JavaScript. Node 8 syntax.
 */
const fs = require('fs');

const MPH = 1.609344, FT = 0.3048;
const SPLITS = [
    { key: '60ft', label: '60 ft', dist: 60 * FT, short: true },
    { key: '330ft', label: '330 ft', dist: 330 * FT, short: true },
    { key: '8th', label: '1/8 mile', dist: 660 * FT, trap: true },
    { key: '1000ft', label: '1000 ft', dist: 1000 * FT },
    { key: '4th', label: '1/4 mile', dist: 1320 * FT, trap: true },
    { key: '0-60mph', label: '0-60 mph', from: 0, to: 60 * MPH },
    { key: '0-100', label: '0-100 km/h', from: 0, to: 100 },
    { key: '60-130mph', label: '60-130 mph', from: 60 * MPH, to: 130 * MPH },
];
const MAX_RUNS = 30, WOT = 90;
const isNum = (v) => typeof v === 'number' && isFinite(v);

class Drag {
    /**
     * opts: { RunTimer (kit/run_timer.js), file (data/drag_runs.json), rollout () -> bool, log,
     * onLaunch(), onDone(run) }
     */
    constructor(opts) {
        this.opts = opts; this.log = opts.log || { info() {}, warn() {} };
        this.saved = { best: {}, runs: [] };
        try { const s = JSON.parse(fs.readFileSync(opts.file, 'utf8')); if (s && Array.isArray(s.runs)) this.saved = { best: s.best || {}, runs: s.runs }; } catch (e) { /* first start */ }
        this.demoStore = { best: {}, runs: [] };
        this.store = this.saved;
        this.demo = false;
        this.live = null;             // the run being timed: its engine stats
        this.newBest = {};
        this.timer = null;
        this.rollout = !!(opts.rollout && opts.rollout());
        this._newTimer();
    }
    _newTimer() {
        this.timer = new this.opts.RunTimer(SPLITS, { rollout: this.rollout, onDone: (r) => this._done(r), onLaunch: () => this._launch() });
    }
    /** Demo data on / off, or rollout changed: a clean timer (and the demo's own store). */
    setSource(demo, rollout) {
        if (demo === this.demo && !!rollout === this.rollout) return;
        this.demo = demo; this.rollout = !!rollout;
        this.store = demo ? this.demoStore : this.saved;
        this.live = null;
        this._newTimer();
    }
    get state() { return this.timer.state; }
    elapsed(now) { return this.timer.elapsed(now); }
    /** Splits reached so far in this run (or the last), seconds; and trap speeds (km/h). */
    result() { return this.timer.result; }
    traps() { return this.timer.trapSpeed; }
    distance() { return this.timer.dist - (this.timer.distOffset || 0); }

    /** Each sample: t (ms), d (car data with .dme, .pedal, .misfires). */
    feed(t, d) {
        this.last = d;
        if (this.live && this.timer.state === 'run') this._sample(t, d);
        if (isNum(d.speed)) this.timer.feed(t, d.speed);
    }
    /** Every 50 ms or so: arming by the clock (a standing car sends no new speed). */
    idle(now) { this.timer.idle(now); }

    _launch() {
        const d = this.last || {}, e = d.dme || {};
        this.newBest = {};
        this.live = {
            launchRpm: isNum(d.rpm) ? Math.round(d.rpm) : null, shifts: [], gear: d.gear, rpmMax: 0, peakG: 0,
            boost: null, boostTarget: null, afrRich: null, afrLean: null, knock: null, railLow: null, railTargetAtLow: null,
            mis0: d.misfires, misfires: 0, recent: [], trace: [],
            start: { intake: e.intake, outside: d.outside, coolant: d.coolant, oil: d.oil },
        };
        if (this.opts.onLaunch) this.opts.onLaunch();
    }
    _sample(t, d) {
        const L = this.live, e = d.dme || {}, t0 = this.timer.t0 || this.timer.tLaunch || t;
        // shifts: the gear going up; the rpm before it is the highest of the last 0.4 s
        L.recent.push([t, d.rpm]);
        while (L.recent.length && t - L.recent[0][0] > 400) L.recent.shift();
        if (isNum(d.gear) && isNum(L.gear) && d.gear > L.gear && L.gear > 0) {
            const rpm = Math.max.apply(null, L.recent.map((r) => r[1]).filter(isNum).concat([0]));
            L.shifts.push({ from: L.gear, to: d.gear, rpm: Math.round(rpm), t: Math.round((t - t0) / 10) / 100 });
        }
        if (isNum(d.gear)) L.gear = d.gear;
        if (isNum(d.rpm)) L.rpmMax = Math.max(L.rpmMax, d.rpm);
        if (isNum(d.gLong)) L.peakG = Math.max(L.peakG, d.gLong);
        if (isNum(e.boost) && (L.boost === null || e.boost > L.boost)) { L.boost = e.boost; L.boostTarget = e.boostTarget; }
        const wot = !isNum(d.pedal) || d.pedal >= WOT;
        if (wot && isNum(e.afr)) {
            if (L.afrRich === null || e.afr < L.afrRich) L.afrRich = e.afr;
            if (L.afrLean === null || e.afr > L.afrLean) L.afrLean = e.afr;
        }
        if (isNum(e.knock) && (L.knock === null || e.knock > L.knock)) L.knock = e.knock;
        if (wot && isNum(e.rail) && (L.railLow === null || e.rail < L.railLow)) { L.railLow = e.rail; L.railTargetAtLow = e.railTarget; }
        if (isNum(d.misfires) && isNum(L.mis0)) L.misfires = Math.max(L.misfires, d.misfires - L.mis0);
        else if (isNum(d.misfires) && !isNum(L.mis0)) L.mis0 = d.misfires;
        const rt = (t - t0) / 1000, last = L.trace[L.trace.length - 1];
        if (rt >= 0 && (!last || rt - last[0] >= 0.1)) L.trace.push([Math.round(rt * 100) / 100, round(d.speed, 1), round(d.rpm, 0), round(e.boost, 3)]);
    }
    _done(r) {
        const L = this.live || {};
        const run = Object.assign({ demo: this.demo }, r, {
            launchRpm: L.launchRpm, shifts: L.shifts || [], rpmMax: Math.round(L.rpmMax || 0), peakG: round(L.peakG, 2),
            boost: round(L.boost, 3), boostTarget: round(L.boostTarget, 3), afrRich: round(L.afrRich, 2), afrLean: round(L.afrLean, 2),
            knock: L.knock, railLow: round(L.railLow, 1), railTargetAtLow: round(L.railTargetAtLow, 1), misfires: L.misfires || 0,
            start: L.start || {}, trace: L.trace || [],
        });
        this.newBest = {};
        Object.keys(run.result).forEach((k) => {
            const key = k + (run.rollout ? '@ro' : ''), b = this.store.best[key];
            if (!b || run.result[k] < b.s) { this.store.best[key] = { s: run.result[k], at: run.at, trap: run.trap[k] }; this.newBest[k] = true; }
        });
        this.store.runs.unshift(run);
        this.store.runs = this.store.runs.slice(0, MAX_RUNS);
        this.lastRun = run;
        this.live = null;
        this._save();
        this.log.info('drag run: ' + JSON.stringify(run.result));
        if (this.opts.onDone) this.opts.onDone(run);
    }
    best(key) { return this.store.best[key + (this.rollout ? '@ro' : '')] || null; }
    runs() { return this.store.runs; }
    clear() {
        this.store.best = {}; this.store.runs = []; this.lastRun = null; this.newBest = {};
        this._save();
    }
    _save() {
        if (this.store !== this.saved || !this.opts.file) return;
        try { fs.writeFileSync(this.opts.file + '.tmp', JSON.stringify(this.saved)); fs.renameSync(this.opts.file + '.tmp', this.opts.file); } catch (e) { this.log.warn('save runs: ' + e.message); }
    }
}
function round(v, d) { return isNum(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null; }

module.exports = { Drag, SPLITS };
