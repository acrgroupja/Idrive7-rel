'use strict';
/**
 * Gauge Log's dyno mode: records full-throttle pulls in one gear, against rpm.
 *
 * Made for a car on a chassis dyno (rollers): the car itself doesn't move, so nothing here uses
 * the accelerometers. The dyno measures the wheel power; this records what the engine did on the
 * pull, by rpm: the engine unit's own torque (FES, crank, as the car calculates it, not measured)
 * and the power from it, boost and its target, AFR and its target, knock retard, rail pressure and
 * its target, intake air; misfires during the pull. On the road a pull works the same way.
 *
 * A pull: the pedal at 90 % or more (no pedal signal: torque over 60 % of the highest seen) while the
 * rpm climbs in one gear (the gear signal, else rpm / speed staying within 4 %). It ends when the pedal
 * comes up, the rpm falls 300 under its highest, or the gear changes; it counts with 1500 rpm or more
 * covered in 1.5 s or more. Samples are averaged into 100 rpm bins. The last 20 pulls are saved in
 * data/dyno_pulls.json; demo pulls are kept apart and never saved.
 *
 * No drawing and no head-unit APIs (only fs). Node 8 syntax.
 */
const fs = require('fs');

const BIN = 100, MIN_SPAN = 1500, MIN_MS = 1500, MAX_PULLS = 20, WOT = 90, DROP = 300;
const FIELDS = ['torque', 'power', 'boost', 'boostTarget', 'afr', 'afrTarget', 'lambda', 'lambdaTarget', 'knock', 'timing', 'timingSpread', 'wastegate', 'rail', 'railTarget', 'intake', 'speed'];
const isNum = (v) => typeof v === 'number' && isFinite(v);

class Dyno {
    /** opts: { file, log, onStart(), onDone(pull) } */
    constructor(opts) {
        this.opts = opts; this.log = opts.log || { info() {}, warn() {} };
        this.saved = [];
        try { const s = JSON.parse(fs.readFileSync(opts.file, 'utf8')); if (Array.isArray(s.pulls)) this.saved = s.pulls; } catch (e) { /* first start */ }
        this.demoPulls = [];
        this.demo = false;
        this.cur = null;              // the pull being recorded
        this.torqueSeen = 0;
        this.state = 'wait';          // wait (for full throttle), pull, done (the last one counted), short (too short)
    }
    setSource(demo) {
        if (demo === this.demo) return;
        this.demo = demo; this.cur = null; this.state = 'wait';
    }
    pulls() { return this.demo ? this.demoPulls : this.saved; }

    _wot(d) {
        if (isNum(d.pedal)) return d.pedal >= WOT;
        return isNum(d.torque) && this.torqueSeen > 100 && d.torque >= 0.6 * this.torqueSeen;
    }
    _ratio(d) { return isNum(d.rpm) && isNum(d.speed) && d.speed > 5 ? d.rpm / d.speed : null; }

    /** Each sample: t (ms), d (car data with .dme, .pedal, .misfires). */
    feed(t, d) {
        if (isNum(d.torque)) this.torqueSeen = Math.max(this.torqueSeen, d.torque);
        const wot = this._wot(d), c = this.cur;
        if (!c) {
            // from a standstill is a launch, not a pull: wait until the car rolls, or (a 2WD dyno, where the
            // car may read no speed) a pull in 2nd gear or higher
            if (wot && isNum(d.rpm) && d.rpm > 1000 && ((isNum(d.speed) && d.speed > 3) || (isNum(d.gear) && d.gear >= 2))) this._start(t, d);
            return;
        }
        if (c.gear === null && isNum(d.gear) && d.gear > 0 && c.n < 3) c.gear = d.gear;     // the gear known a moment after the start
        const ratio = this._ratio(d);
        const gearChanged = isNum(c.gear) && isNum(d.gear) ? d.gear !== c.gear
            : isNum(c.ratio) && isNum(ratio) && c.n > 3 ? Math.abs(ratio - c.ratio) / c.ratio > 0.04 : false;
        if (!wot || gearChanged || (isNum(d.rpm) && d.rpm < c.rpmMax - DROP)) { this._end(t, gearChanged ? 'gear change' : !wot ? 'lift' : 'rpm fell'); return; }
        this._add(t, d);
    }
    _start(t, d) {
        const e = d.dme || {};
        this.cur = { t0: t, gear: isNum(d.gear) && d.gear > 0 ? d.gear : null, ratio: this._ratio(d), n: 0, rpm0: d.rpm, rpmMax: d.rpm, bins: {},
            mis0: d.misfires, misfires: 0, start: { intake: e.intake, outside: d.outside, coolant: d.coolant, oil: d.oil } };
        this.state = 'pull';
        if (this.opts.onStart) this.opts.onStart();
        this._add(t, d);
    }
    _add(t, d) {
        const c = this.cur, e = d.dme || {};
        if (!isNum(d.rpm)) return;
        c.n++;
        const r = this._ratio(d);
        if (isNum(r)) c.ratio = c.ratio === null ? r : c.ratio * 0.8 + r * 0.2;       // follows slow drift (tyre growth), not a shift
        c.rpmMax = Math.max(c.rpmMax, d.rpm);
        const vals = { torque: d.torque, power: isNum(d.torque) ? d.torque * d.rpm / 9549 : null, boost: e.boost, boostTarget: e.boostTarget,
            afr: e.afr, afrTarget: e.afrTarget, lambda: e.lambda, lambdaTarget: e.lambdaTarget, knock: e.knock, timing: e.timing, timingSpread: e.timingSpread, wastegate: e.wastegate, rail: e.rail, railTarget: e.railTarget, intake: e.intake, speed: d.speed };
        const k = Math.round(d.rpm / BIN) * BIN, b = c.bins[k] || (c.bins[k] = { n: {}, s: {} });
        FIELDS.forEach((f) => { if (isNum(vals[f])) { b.n[f] = (b.n[f] || 0) + 1; b.s[f] = (b.s[f] || 0) + vals[f]; } });
        if (isNum(d.misfires)) { if (!isNum(c.mis0)) c.mis0 = d.misfires; c.misfires = Math.max(c.misfires, d.misfires - c.mis0); }
    }
    _end(t, why) {
        const c = this.cur;
        this.cur = null;
        const span = c.rpmMax - c.rpm0, ms = t - c.t0;
        if (span < MIN_SPAN || ms < MIN_MS) { this.state = 'short'; this.shortWhy = Math.round(span) + ' rpm in ' + (ms / 1000).toFixed(1) + ' s'; return; }
        const pull = summarise(c, t, why, this.demo);
        const list = this.pulls();
        list.unshift(pull);
        list.splice(MAX_PULLS);
        this.state = 'done';
        this._save();
        this.log.info('dyno pull: ' + pull.rpmFrom + '-' + pull.rpmTo + ' rpm, peak ' + pull.peakTorque + ' Nm / ' + pull.peakPower + ' kW');
        if (this.opts.onDone) this.opts.onDone(pull);
    }
    /** The pull being recorded as a pull (for the live chart), or null. */
    live(now) { return this.cur ? summarise(this.cur, now, 'live', this.demo) : null; }
    clear() { this.pulls().splice(0); this.state = 'wait'; this._save(); }
    _save() {
        if (this.demo || !this.opts.file) return;
        try { fs.writeFileSync(this.opts.file + '.tmp', JSON.stringify({ v: 1, pulls: this.saved })); fs.renameSync(this.opts.file + '.tmp', this.opts.file); } catch (e) { this.log.warn('save pulls: ' + e.message); }
    }
}

/** A recorded pull: { at, gear, rpmFrom, rpmTo, ms, why, misfires, start, rpm: [..], torque: [..], ... (per bin), peaks } */
function summarise(c, t, why, demo) {
    const keys = Object.keys(c.bins).map(Number).sort((a, b) => a - b);
    const out = { at: Date.now(), demo, gear: c.gear, rpmFrom: Math.round(c.rpm0), rpmTo: Math.round(c.rpmMax), ms: t - c.t0, why, misfires: c.misfires, start: c.start, rpm: keys };
    FIELDS.forEach((f) => {
        out[f] = keys.map((k) => { const b = c.bins[k]; return b.n[f] ? Math.round(b.s[f] / b.n[f] * 1000) / 1000 : null; });
    });
    const peak = (f, lo) => {
        let best = null, at = null;
        out[f].forEach((v, i) => { if (isNum(v) && (best === null || (lo ? v < best : v > best))) { best = v; at = keys[i]; } });
        return [best, at];
    };
    const pt = peak('torque'), pp = peak('power'), pb = peak('boost'), ar = peak('afr', true), al = peak('afr'), kn = peak('knock'), rl = peak('rail', true);
    Object.assign(out, {
        peakTorque: isNum(pt[0]) ? Math.round(pt[0]) : null, peakTorqueRpm: pt[1], peakPower: isNum(pp[0]) ? Math.round(pp[0]) : null, peakPowerRpm: pp[1],
        peakBoost: pb[0], peakBoostRpm: pb[1], afrRich: ar[0], afrLean: al[0], knockMax: kn[0], knockRpm: kn[1], spreadMax: peak('timingSpread')[0], railLow: rl[0], railLowRpm: rl[1],
    });
    return out;
}

module.exports = { Dyno, summarise, BIN };
