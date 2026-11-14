'use strict';
/**
 * The engine unit's values for Gauge Log: boost and its target, rail pressure and its target,
 * lambda / AFR and its target, knock (retard and the knock flag), misfires per cylinder, intake air.
 *
 * Read with UDS 22 (ReadDataByIdentifier, READ ONLY: kit/readonly-diag.js refuses anything else)
 * from the engine unit (DME, address 0x12). Identifiers from the DME8FF_R catalog (B58 / B48 / B38,
 * G series), as in Live Data (apps/live_data/useful.js):
 *
 *   fast (8 in one request, as often as the link allows, about 10 a second):
 *     4205 charge pressure (abs), 4201 ambient pressure, 4AB0 boost target (abs),
 *     58EF fuel HIGH pressure, the direct-injection rail (5658 on newer software), 5837 its target (56C1)
 *     (the low pressure side, 58F3 / 5463, is not read),
 *     5889 lambda (5640), 5816 lambda target, 554C knock retard (mean of the cylinders)
 *   fast 2 (in turn with the first): 59FA ignition angle, 5927 wastegate position,
 *     4A49-4A4F ignition angle of cylinders 1-6 (one cylinder later than the others: knock control on it)
 *   (from 0.9.8: 4201 moved to slow 2 and 4600 throttle plate (5858) into fast, which is asked twice as often as fast 2;
 *   the slow groups every 3 s)
 *   slow (once a second): 4A36 knock detected, 4B23-4B32 misfire counters cylinders 1-6, 580F intake air;
 *     59D4 charge air temperature before the throttle
 *
 * At the first start each identifier is asked alone once: those the unit refuses are dropped (and their
 * alternative tried), so the grouped requests only carry what this engine has. An engine unit that
 * answers none (another engine, or the ignition off) is asked again every 30 s.
 *
 * The decoding (DIDS, decode(), parse()) has no head-unit APIs; only start() uses the link.
 * Node 8 syntax only.
 */
const DME = 0x12;

/** id -> how to read it: bytes, signed, factor, offset (raw x factor + offset in the catalog's unit). */
const DIDS = {
    '4205': { key: 'chargeHpa', bytes: 2, k: 0.078125 },
    '4201': { key: 'ambientHpa', bytes: 2, k: 0.0390625 },
    '4AB0': { key: 'boostTargetHpa', bytes: 2, k: 0.0390625 },
    '58EF': { key: 'railMpa', bytes: 2, k: 0.0005, alt: '5658' },
    '5658': { key: 'railMpa', bytes: 2, k: 0.002 },
    '5837': { key: 'railTargetMpa', bytes: 2, k: 0.0005, alt: '56C1' },
    '56C1': { key: 'railTargetMpa', bytes: 2, k: 0.002 },
    '5889': { key: 'lambda', bytes: 2, k: 0.000244140625, bad: 65535, alt: '5640' },
    '5640': { key: 'lambda', bytes: 2, k: 0.000244140625, bad: 65535 },
    '5816': { key: 'lambdaTarget', bytes: 2, k: 0.000244140625, bad: 65535 },
    '554C': { key: 'knockRetard', bytes: 1, signed: true, k: 0.375 },
    '4A36': { key: 'knockFlag', bytes: 1, k: 1 },
    '4B23': { key: 'mis1', bytes: 2, k: 1 },
    '4B24': { key: 'mis2', bytes: 2, k: 1 },
    '4B25': { key: 'mis3', bytes: 2, k: 1 },
    '4B30': { key: 'mis4', bytes: 2, k: 1 },
    '4B31': { key: 'mis5', bytes: 2, k: 1 },
    '4B32': { key: 'mis6', bytes: 2, k: 1 },
    '580F': { key: 'intakeC', bytes: 1, k: 0.75, o: -48 },
    '59FA': { key: 'timing', bytes: 1, signed: true, k: 0.75 },
    '5927': { key: 'wastegate', bytes: 1, k: 0.390625 },
    '4A49': { key: 'tim1', bytes: 2, signed: true, k: 0.1 },
    '4A4A': { key: 'tim2', bytes: 2, signed: true, k: 0.1 },
    '4A4C': { key: 'tim3', bytes: 2, signed: true, k: 0.1 },
    '4A4D': { key: 'tim4', bytes: 2, signed: true, k: 0.1 },
    '4A4E': { key: 'tim5', bytes: 2, signed: true, k: 0.1 },
    '4A4F': { key: 'tim6', bytes: 2, signed: true, k: 0.1 },
    '59D4': { key: 'chargeAirC', bytes: 2, k: 0.0234375, o: -273.15 },
    // the throttle plate (DK) angle from its lower stop, % (not the accelerator pedal: that comes from the car's own signal)
    // the boost controller's error (target minus actual, catalog: Regeldifferenz Ladedruck): a cross-check of 4AB0
    '4536': { key: 'boostErrHpa', bytes: 2, signed: true, k: 0.125 },
    // fuel quality (catalog: FAK_KRAFTSTOFFQUALITAET_ADAPT, 0 = RON 98 .. 1 = RON 91; TIME_FROM_LST_INST, min)
    // ethanol in the fuel, % (catalog: PROZENT_ALK_KRST; a flex-fuel tune may fill it from its sensor). Where the engine
    // unit refuses it: OBD-II PID 52 (ethanol fuel %), asked with the slow values
    '550D': { key: 'ethanolPct', bytes: 1, k: 0.39215686 },
    '5776': { key: 'fuelQualityFactor', bytes: 1, k: 0.00390625 },
    '57E3': { key: 'sinceRefuelMin', bytes: 2 },
    '4600': { key: 'throttlePct', bytes: 2, signed: true, k: 0.0078125, alt: '5858' },
    '5858': { key: 'throttlePct', bytes: 2, signed: true, k: 0.0078125 },
};
/** The request groups (8 identifiers at most each): fast ones every round, in turn; slow ones once a second. */
const GROUPS = [
    // fast: asked twice as often as fast 2 (boost, fuel, lambda, knock, throttle are what the tiles watch)
    { name: 'fast', ids: ['4205', '4AB0', '58EF', '5837', '5889', '5816', '554C', '4600'], fast: true, weight: 2 },
    { name: 'fast 2', ids: ['59FA', '5927', '4A49', '4A4A', '4A4C', '4A4D', '4A4E', '4A4F'], fast: true, weight: 1 },
    { name: 'slow', ids: ['4A36', '4B23', '4B24', '4B25', '4B30', '4B31', '4B32', '580F'] },
    // ambient pressure changes slowly: here, and kept for longer (boost is charge pressure minus it)
    { name: 'slow 2', ids: ['59D4', '4201', '4536', '5776', '57E3', '550D'] },
];
const FAST = GROUPS[0].ids, SLOW = GROUPS[2].ids;
/** What each identifier is, for the check page. */
const NAMES = {
    '4205': 'Charge pressure', '4201': 'Ambient pressure', '4AB0': 'Boost target', '58EF': 'Fuel high pressure', '5658': 'Fuel high pressure (new)',
    '5837': 'Fuel high pressure target', '56C1': 'Fuel HP target (new)', '5889': 'Lambda', '5640': 'Lambda (sensor)', '5816': 'Lambda target',
    '554C': 'Knock retard (mean)', '4A36': 'Knock detected', '4B23': 'Misfires cyl 1', '4B24': 'Misfires cyl 2', '4B25': 'Misfires cyl 3',
    '4B30': 'Misfires cyl 4', '4B31': 'Misfires cyl 5', '4B32': 'Misfires cyl 6', '580F': 'Intake air', '59FA': 'Ignition angle',
    '5927': 'Wastegate position', '4A49': 'Ignition cyl 1', '4A4A': 'Ignition cyl 2', '4A4C': 'Ignition cyl 3', '4A4D': 'Ignition cyl 4',
    '4A4E': 'Ignition cyl 5', '4A4F': 'Ignition cyl 6', '59D4': 'Charge air before throttle',
    '4600': 'Throttle plate', '5858': 'Throttle plate (alt.)', '4536': 'Boost control error',
    '550D': 'Ethanol in the fuel', '5776': 'Fuel quality (adapted)', '57E3': 'Since refuelling',
};
// RETRY_MS: an engine that answered none of its values is asked again after this. STALE_MS: a value older than
// this counts as none. Gaps (the unit stops answering for a while): asked again after GAP_MIN_MS, doubling to GAP_MAX_MS,
// keeping what it has; quiet for REPROBE_MS, it is asked which values it has again.
// (seen on a G-series car: one request takes about 200 ms over the head unit's link, so every request counts)
const SLOW_MS = 3000, SLOW_STALE_MS = 10000, AMBIENT_STALE_MS = 120000, RETRY_MS = 10000, STALE_MS = 3000, MIN_ROUND_MS = 50, GAP_MIN_MS = 500, GAP_MAX_MS = 5000, REPROBE_MS = 60000, NOREPLY_RETRY_MS = 15000;
// NOREPLY_RETRY_MS: a value that gave no reply when the unit was first asked (busy, not woken yet) is asked again this often,
// alone, while the rest are read; once it answers it joins its group. A refused value is not asked again (until reprobe()).

/** One identifier's raw bytes -> its value, or null (no data). */
function decode(id, bytes) {
    const c = DIDS[id];
    if (!c || !bytes || bytes.length < c.bytes) return null;
    let raw = 0;
    for (let i = 0; i < c.bytes; i++) raw = raw * 256 + bytes[i];
    if (c.bad !== undefined && raw === c.bad) return null;
    if (c.signed && raw >= Math.pow(2, 8 * c.bytes - 1)) raw -= Math.pow(2, 8 * c.bytes);
    return raw * c.k + (c.o || 0);
}

/**
 * A reply to 22 with several identifiers (62 <id> <data> <id> <data> ...) -> { id: value }.
 * ids: the identifiers asked, in order (the unit answers those it has, in that order).
 * Stops at anything it doesn't expect, keeping what came before.
 */
function parse(uds, ids) {
    const out = {};
    if (!uds || uds[0] !== 0x62) return out;
    let i = 1;
    while (i + 2 <= uds.length) {
        const id = ((uds[i] << 8) | uds[i + 1]).toString(16).toUpperCase();
        const pad = ('0000' + id).slice(-4), c = DIDS[pad];
        if (!c || ids.indexOf(pad) < 0 || i + 2 + c.bytes > uds.length) break;
        out[pad] = decode(pad, uds.slice(i + 2, i + 2 + c.bytes));
        i += 2 + c.bytes;
    }
    return out;
}

/**
 * The engine values in display terms from the catalog values (by key): boost / target in bar over
 * ambient, rail in bar, lambda, AFR (x stoich), knock, misfires per cylinder and their total.
 */
/**
 * KQE (22 4035, DME8FF_R): refuellings the engine unit counted as low / medium / high quality, then the last five
 * refuellings' mileage (x 8 km) and quality range (1 low, 2 medium, 3 high; 0: none yet).
 * { low, medium, high, last: [{ km, q }] } from the reply (62 40 35 + 21 bytes), or null.
 */
function parseKqe(u) {
    if (!u || u[0] !== 0x62 || u[1] !== 0x40 || u[2] !== 0x35 || u.length < 3 + 21) return null;
    const d = u.slice(3), w = (i) => (d[i] << 8) | d[i + 1];
    const last = [0, 1, 2, 3, 4].map((n) => ({ km: w(6 + n * 3) * 8, q: d[8 + n * 3] }));
    return { low: w(0), medium: w(2), high: w(4), last };
}

function values(raw, stoich) {
    const n = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
    const amb = n(raw.ambientHpa);
    const over = (abs) => (n(abs) !== null && amb !== null ? (abs - amb) / 1000 : null);
    const st = stoich || 14.7;
    const mis = [1, 2, 3, 4, 5, 6].map((c) => n(raw['mis' + c]));
    const got = mis.filter((x) => x !== null);
    const tims = [1, 2, 3, 4, 5, 6].map((c) => n(raw['tim' + c])), timsGot = tims.filter((x) => x !== null);
    return {
        boost: over(raw.chargeHpa), boostTarget: over(raw.boostTargetHpa),
        // the target the boost controller works to, from its error: actual + (target - actual); for the Check page
        boostTargetCtl: n(raw.boostErrHpa) !== null ? over(n(raw.chargeHpa) !== null ? raw.chargeHpa + raw.boostErrHpa : null) : null,
        rail: n(raw.railMpa) !== null ? raw.railMpa * 10 : null, railTarget: n(raw.railTargetMpa) !== null ? raw.railTargetMpa * 10 : null,
        lambda: n(raw.lambda), lambdaTarget: n(raw.lambdaTarget),
        afr: n(raw.lambda) !== null ? raw.lambda * st : null, afrTarget: n(raw.lambdaTarget) !== null ? raw.lambdaTarget * st : null,
        knock: n(raw.knockRetard), knockFlag: n(raw.knockFlag), misfires: mis, misfireTotal: got.length ? got.reduce((a, b) => a + b, 0) : null,
        intake: n(raw.intakeC), chargeAir: n(raw.chargeAirC), wastegate: n(raw.wastegate),
        // adapted octane: the engine unit's fuel quality factor on its scale, 0 = RON 98 .. 1 = RON 91
        octane: n(raw.fuelQualityFactor) !== null ? 98 - 7 * Math.max(0, Math.min(1, raw.fuelQualityFactor)) : null,
        sinceRefuel: n(raw.sinceRefuelMin),
        ethanol: n(raw.ethanolPct) !== null ? Math.max(0, Math.min(100, raw.ethanolPct)) : null,
        throttle: n(raw.throttlePct) !== null ? Math.max(0, Math.min(100, raw.throttlePct)) : null,
        timing: n(raw.timing), timingCyl: tims, timingSpread: timsGot.length >= 2 ? Math.max.apply(null, timsGot) - Math.min.apply(null, timsGot) : null,
    };
}

/**
 * The reader. new EngineDme({ link, log, wanted }) where link is a kit ReadOnlyDiag (or anything with
 * readMany(addr, [ids]) -> reply bytes and wake(addr)), wanted() -> poll now?
 * start() / stop(); raw (catalog values by key, with their times); status: 'off', 'probing',
 * 'reading', 'no answer'; have (the identifiers this engine answered); rate (fast reads a second).
 */
class EngineDme {
    constructor(opts) {
        this.link = opts.link; this.log = opts.log || { info() {}, warn() {} };
        this.wanted = opts.wanted || (() => true);
        this.retryMs = opts.noReplyRetryMs || NOREPLY_RETRY_MS; this.missing = [];
        this.raw = {}; this.t = {}; this.status = 'off'; this.have = null; this.fast = []; this.slow = [];
        this.running = false; this.lastSlow = 0; this.triedAt = 0; this.reads = []; this.rate = 0;
        // health, for the Check page: gaps (the unit went quiet and came back), request errors, loop restarts
        this.fastMode = opts.fast || null;          // () => true: only the main group in turn (drag, dyno, logging ...)
        this.latency = null;                     // ms a request takes (smoothed)
        this.lastReply = 0; this.quietSince = null; this.gap = GAP_MIN_MS; this.gaps = 0; this.errors = 0; this.restarts = 0; this.lastError = null;
    }
    start() {
        if (this.running) return;
        this.running = true;
        // the loop never stays down: anything thrown is logged and it starts again a second later
        const run = () => this._loop().catch((e) => {
            this.restarts++; this.lastError = String(e && e.message || e);
            this.log.warn('engine unit: reader stopped (' + this.lastError + '), starting again');
            if (this.running) setTimeout(() => { if (this.running) run(); }, 1000); else this.status = 'off';
        });
        run();
    }
    stop() { this.running = false; }
    /** Ask which values the engine has again, now (the Check page's button). */
    reprobe() { this.missing = []; this.obdEthanol = undefined; this.obdMiss = 0; this.ethanolFrom = null; this.have = null; this.triedAt = 0; this.status = 'off'; this.quietSince = null; this.gap = GAP_MIN_MS; if (this.link.wake) this.link.wake(DME); }
    /** For the Check page: gaps, request errors, restarts, the last error, ms since the last answer. */
    health() {
        return { gaps: this.gaps, errors: this.errors, restarts: this.restarts, lastError: this.lastError, since: this.lastReply ? Date.now() - this.lastReply : null,
            latency: this.latency, fast: this._fastNow() };
    }
    /** The latest catalog values (older than 2 s count as none). */
    fresh() {
        const out = {}, now = Date.now();
        const fm = this._fastNow();
        Object.keys(this.raw).forEach((k) => { if (now - this.t[k] < staleMs(k, fm)) out[k] = this.raw[k]; });
        return out;
    }
    _put(got, now) {
        Object.keys(got).forEach((id) => { const c = DIDS[id]; if (got[id] !== null) { this.raw[c.key] = got[id]; this.t[c.key] = now; } });
    }
    /** { id: value } for the identifiers it answered, or null (no answer, refused, or the request failed). */
    /** The fuel quality history (KQE, 22 4035), asked once (Check page > Fuel quality): parseKqe's, or null. */
    async fuelQuality() {
        try { const r = await this.link.readMany(DME, [0x4035]); return r ? parseKqe(r) : null; } catch (e) { return null; }
    }
    /**
     * Ethanol from OBD-II (service 01 PID 52: A x 100 / 255 %) where the engine unit doesn't have 550D. Asked with the
     * slow values; once refused (or unanswered 3 times) not again until reprobe(). ethanolFrom: '550D' | 'OBD' | null.
     */
    async _ethanolObd() {
        if (this.have && this.have.indexOf('550D') >= 0) { this.ethanolFrom = '550D'; return; }
        if (this.obdEthanol === false || !this.link.physical) return;
        let u = null;
        try {
            u = await this.link.physical(DME, 0x01, [0x52], 1500, (r) => (r[0] === 0x41 && r[1] === 0x52) || (r[0] === 0x7F && r[1] === 0x01));
        } catch (e) { this.errors++; this.lastError = String(e && e.message || e); return; }
        if (u && u[0] === 0x41 && u.length >= 3) {
            this.raw.ethanolPct = u[2] * 100 / 255; this.t.ethanolPct = Date.now(); this.ethanolFrom = 'OBD'; this.obdMiss = 0;
            if (this.obdEthanol !== true) { this.obdEthanol = true; this.log.info('engine unit: ethanol from OBD PID 52'); }
        } else if (u && u[0] === 0x7F) { this.obdEthanol = false; this.log.info('engine unit: no ethanol value (550D refused, OBD PID 52 refused)'); }
        else if (++this.obdMiss >= 3 && this.obdEthanol !== true) this.obdEthanol = false;
    }
    _fastNow() { try { return !!(this.fastMode && this.fastMode()); } catch (e) { return false; } }
    async _ask(ids) {
        let uds;
        const t0 = Date.now();
        try {
            uds = await this.link.readMany(DME, ids.map((x) => parseInt(x, 16)));
            if (uds) { const dt = Date.now() - t0; this.latency = this.latency === null ? dt : this.latency * 0.9 + dt * 0.1; }
        } catch (e) {
            // the transport refused the request (busy, restarting): count it, try again next round
            this.errors++; this.lastError = String(e && e.message || e);
            if (this.errors % 20 === 1) this.log.warn('engine unit: request failed (' + this.lastError + ')');
            await sleep(200);
            return null;
        }
        if (uds === undefined) return null;                 // cancelled before it went
        const got = uds ? parse(uds, ids) : null;
        if (got && Object.keys(got).length) this.lastReply = Date.now();
        return got;
    }
    /** The unit went quiet (no answer several times in a row): keep what it has, ask again soon, then less often. */
    async _gap() {
        const now = Date.now();
        if (this.quietSince === null) { this.quietSince = now; this.gaps++; this.log.info('engine unit: no answer - asking again in ' + this.gap + ' ms'); }
        this.status = 'no answer';
        await sleep(this.gap);
        this.gap = Math.min(GAP_MAX_MS, this.gap * 2);
        if (this.link.wake) this.link.wake(DME);
        // quiet a long time (ignition off and on, the unit restarted): find out again which values it has
        if (now - this.quietSince > REPROBE_MS) { this.have = null; this.triedAt = 0; this.quietSince = null; this.gap = GAP_MIN_MS; }
    }
    _answered() {
        if (this.quietSince !== null) this.log.info('engine unit: answering again after ' + Math.round((Date.now() - this.quietSince) / 1000) + ' s');
        this.quietSince = null; this.gap = GAP_MIN_MS; this.status = 'reading';
    }
    /** Each identifier alone (its alternative when refused): what this engine has. Answers noted per identifier. */
    async _probe() {
        this.status = 'probing';
        const have = [];
        this.answer = {}; this.missing = [];
        for (const g of GROUPS) {
            for (const id of g.ids) {
                let ok = await this._ask([id]);
                if (ok && ok[id] !== undefined) { have.push(id); this.answer[id] = 'yes'; continue; }
                this.answer[id] = ok === null ? 'no reply' : 'refused';
                const alt = DIDS[id].alt;
                if (alt) {
                    ok = await this._ask([alt]);
                    if (ok && ok[alt] !== undefined) { have.push(alt); this.answer[alt] = 'yes'; continue; }
                    this.answer[alt] = ok === null ? 'no reply' : 'refused';
                }
                // no reply (to it, or to its alternative): ask again later
                if (this.answer[id] === 'no reply') this.missing.push(id);
                else if (alt && this.answer[alt] === 'no reply') this.missing.push(alt);
            }
        }
        return have;
    }
    /** Each group: the identifiers it has (an alternative in its original's group). */
    _groups() {
        const have = this.have;
        const last = {};
        (this.groups || []).forEach((g) => { last[g.name] = g.last; });
        this.groups = GROUPS.map((g) => ({ name: g.name, fast: !!g.fast, weight: g.weight || 1, last: last[g.name] || 0,
            ids: have.filter((id) => g.ids.indexOf(id) >= 0 || g.ids.indexOf(alternativeOf(id)) >= 0) })).filter((g) => g.ids.length);
        this.fast = [].concat.apply([], this.groups.filter((g) => g.fast).map((g) => g.ids));
        this.slow = [].concat.apply([], this.groups.filter((g) => !g.fast).map((g) => g.ids));
    }
    /** The values with no reply so far, each alone (and its alternative): an answer joins the reading, a refusal drops it. */
    async _askMissing() {
        const still = [];
        for (const id of this.missing) {
            if (!this.running) return;
            const ok = await this._ask([id]);
            if (ok && ok[id] !== undefined) {
                this.answer[id] = 'yes'; this._put(ok, Date.now());
                if (this.have.indexOf(id) < 0) this.have.push(id);
                this.log.info('engine unit: ' + id + ' answers now');
                continue;
            }
            if (ok !== null) { this.answer[id] = 'refused'; continue; }   // it answered: not this value
            still.push(id);
        }
        const added = this.missing.length - still.length;
        this.missing = still;
        if (added) this._groups();
    }
    async _loop() {
        let turn = 0;
        while (this.running) {
            if (!this.wanted() || (this.link.ready === false)) { await sleep(250); continue; }
            if (!this.have || !this.have.length) {
                if (this.have && Date.now() - this.triedAt < RETRY_MS) { await sleep(500); continue; }
                this.triedAt = Date.now();
                if (this.link.wake) this.link.wake(DME);
                const have = await this._probe();
                this.have = have;
                if (!have.length) { this.status = 'no answer'; this.log.info('engine unit: no answer to its values (another engine, or the ignition off?)'); continue; }
                this.quietSince = null; this.gap = GAP_MIN_MS; this.lastReply = Date.now(); this.missedAt = Date.now();
                this._groups();
                this.status = 'reading';
                this.log.info('engine unit: reading ' + have.join(' ') + (this.missing.length ? ' (no reply yet: ' + this.missing.join(' ') + ')' : ''));
            }
            // values that gave no reply at first: asked again, one at a time, every 15 s
            if (this.missing && this.missing.length && this.quietSince === null && Date.now() - this.missedAt >= this.retryMs) {
                this.missedAt = Date.now();
                await this._askMissing();
            }
            // fast mode: the main group only, in turn; the ignition group joins the slow ones (less often)
            const fm = this._fastNow();
            const now = Date.now(), fast = this.groups.filter((g) => g.fast && (!fm || g.weight >= 2));
            const before = this.lastReply;
            if (fast.length) {
                const seq = [].concat.apply([], fast.map((x) => Array(x.weight || 1).fill(x)));   // by weight: fast, fast, fast 2, ...
                const g = seq[turn++ % seq.length];
                const got = await this._ask(g.ids);
                if (got) { this._put(got, Date.now()); if (g === fast[0]) this.reads.push(Date.now()); }
            }
            for (const g of this.groups.filter((x) => !x.fast || (fm && x.weight < 2))) {
                if (now - g.last < (fm ? FAST_MODE_OTHERS_MS : SLOW_MS)) continue;
                g.last = now;
                const got = await this._ask(g.ids);
                if (got) this._put(got, Date.now());
            }
            // ethanol from OBD where the engine unit has no 550D: as often as the slow values
            if (now - (this.lastEth || 0) >= (fm ? FAST_MODE_OTHERS_MS : SLOW_MS)) { this.lastEth = now; await this._ethanolObd(); }
            while (this.reads.length && Date.now() - this.reads[0] > 2000) this.reads.shift();
            this.rate = this.reads.length / 2;
            if (this.lastReply !== before) this._answered();
            // several misses in a row: the link skips the unit. Keep its values list and ask again soon (was: 30 s and a full probe)
            if (this.link.silent && this.link.silent(DME)) { await this._gap(); continue; }
            // at most 20 rounds a second (the link paces too); and a round always lets timers run
            await sleep(fast.length ? Math.max(1, MIN_ROUND_MS - (Date.now() - now)) : 200);
        }
        this.status = 'off';
    }
    /** For the check page: [{ id, name, group, answer ('yes', 'refused', 'no reply', 'not asked'), value, age ms }]. */
    report() {
        const out = [], now = Date.now();
        GROUPS.forEach((g) => g.ids.forEach((id) => {
            [id].concat(DIDS[id].alt ? [DIDS[id].alt] : []).forEach((x) => {
                const k = DIDS[x].key, ans = (this.answer && this.answer[x]) || 'not asked';
                if (x !== id && ans === 'not asked') return;            // an alternative only once it was tried
                out.push({ id: x, name: NAMES[x] || x, group: g.name, answer: ans, value: this.raw[k] !== undefined && this.t[k] && ans === 'yes' ? this.raw[k] : null,
                    age: this.t[k] ? now - this.t[k] : null });
            });
        }));
        return out;
    }
}
/** The identifier whose alternative this one is ('5658' -> '58EF'). */
function alternativeOf(id) { return Object.keys(DIDS).filter((k) => DIDS[k].alt === id)[0] || null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a value counts as current: the fast ones 3 s, the slow ones 10 s, ambient pressure 2 minutes. */
const SLOW_KEYS = {};
GROUPS.filter((g) => !g.fast).forEach((g) => g.ids.forEach((id) => { SLOW_KEYS[DIDS[id].key] = true; if (DIDS[id].alt) SLOW_KEYS[DIDS[DIDS[id].alt].key] = true; }));
const MAIN_KEYS = {};
GROUPS.filter((g) => g.weight === 2).forEach((g) => g.ids.forEach((id) => { MAIN_KEYS[DIDS[id].key] = true; if (DIDS[id].alt) MAIN_KEYS[DIDS[DIDS[id].alt].key] = true; }));
/** Fast mode: only the main group is asked in turn; the rest every FAST_MODE_OTHERS_MS (and kept that long). */
const FAST_MODE_OTHERS_MS = 5000, FAST_MODE_STALE_MS = 16000;
function staleMs(key, fastMode) {
    if (key === 'ambientHpa') return AMBIENT_STALE_MS;
    if (fastMode && !MAIN_KEYS[key]) return FAST_MODE_STALE_MS;
    return SLOW_KEYS[key] ? SLOW_STALE_MS : STALE_MS;
}

/** Demo values that follow the simulated drive (throttle 0..1, rpm). */
function demoRaw(d, t) {
    const th = typeof d.throttle === 'number' ? d.throttle : 0, rpm = d.rpm || 800;
    const spool = Math.min(1, Math.max(0, (rpm - 1500) / 2000));
    const tgt = 1000 + th * spool * 1250;
    const wob = Math.sin(t / 700) * 15;
    return {
        ambientHpa: 1013, chargeHpa: 1013 + Math.max(0, tgt - 1013) * 0.96 + wob, boostTargetHpa: tgt,
        railMpa: 5 + th * 30 + Math.sin(t / 500) * 0.4, railTargetMpa: 5 + th * 30,
        lambda: th > 0.9 ? 0.82 + Math.sin(t / 900) * 0.01 : 1.0 + Math.sin(t / 1100) * 0.01, lambdaTarget: th > 0.9 ? 0.82 : 1.0,
        knockRetard: th > 0.9 && rpm > 5000 && Math.sin(t / 2300) > 0.8 ? 1.5 : 0, knockFlag: 0,
        mis1: 0, mis2: 0, mis3: 2, mis4: 0, mis5: 0, mis6: 0, intakeC: 31, chargeAirC: 34 + th * 12,
        timing: th > 0.9 ? 8 + (rpm - 4000) / 1000 : 22, wastegate: th > 0.9 ? 30 : 85, throttlePct: Math.min(100, th * 130), fuelQualityFactor: 0.12, sinceRefuelMin: 340, ethanolPct: 30,
        tim1: th > 0.9 ? 8 : 22, tim2: th > 0.9 ? 8 : 22, tim3: th > 0.9 ? 8 : 22, tim4: th > 0.9 && Math.sin(t / 2300) > 0.8 ? 5 : th > 0.9 ? 8 : 22, tim5: th > 0.9 ? 8 : 22, tim6: th > 0.9 ? 8 : 22,
    };
}

/** The AFR stoichiometric ratio of a petrol / ethanol blend (by volume, linear: petrol 14.7, ethanol 9.0): E85 9.86. */
function stoichFor(ethanolPct) { const e = Math.max(0, Math.min(100, ethanolPct)) / 100; return 14.7 - 5.7 * e; }

module.exports = { stoichFor, EngineDme, DIDS, GROUPS, NAMES, FAST, SLOW, decode, parse, parseKqe, values, demoRaw, DME };
