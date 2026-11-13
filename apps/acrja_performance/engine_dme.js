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
};
/** The request groups (8 identifiers at most each): fast ones every round, in turn; slow ones once a second. */
const GROUPS = [
    { name: 'fast', ids: ['4205', '4201', '4AB0', '58EF', '5837', '5889', '5816', '554C'], fast: true },
    { name: 'fast 2', ids: ['59FA', '5927', '4A49', '4A4A', '4A4C', '4A4D', '4A4E', '4A4F'], fast: true },
    { name: 'slow', ids: ['4A36', '4B23', '4B24', '4B25', '4B30', '4B31', '4B32', '580F'] },
    { name: 'slow 2', ids: ['59D4'] },
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
};
const SLOW_MS = 1000, RETRY_MS = 30000, STALE_MS = 2000, MIN_ROUND_MS = 50;

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
        rail: n(raw.railMpa) !== null ? raw.railMpa * 10 : null, railTarget: n(raw.railTargetMpa) !== null ? raw.railTargetMpa * 10 : null,
        lambda: n(raw.lambda), lambdaTarget: n(raw.lambdaTarget),
        afr: n(raw.lambda) !== null ? raw.lambda * st : null, afrTarget: n(raw.lambdaTarget) !== null ? raw.lambdaTarget * st : null,
        knock: n(raw.knockRetard), knockFlag: n(raw.knockFlag), misfires: mis, misfireTotal: got.length ? got.reduce((a, b) => a + b, 0) : null,
        intake: n(raw.intakeC), chargeAir: n(raw.chargeAirC), wastegate: n(raw.wastegate),
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
        this.raw = {}; this.t = {}; this.status = 'off'; this.have = null; this.fast = []; this.slow = [];
        this.running = false; this.lastSlow = 0; this.triedAt = 0; this.reads = []; this.rate = 0;
    }
    start() {
        if (this.running) return;
        this.running = true;
        this._loop().catch((e) => { this.log.warn('engine unit: ' + (e && e.message || e)); this.running = false; this.status = 'off'; });
    }
    stop() { this.running = false; }
    /** Ask which values the engine has again, now (the Check page's button). */
    reprobe() { this.have = null; this.triedAt = 0; this.status = 'off'; if (this.link.wake) this.link.wake(DME); }
    /** The latest catalog values (older than 2 s count as none). */
    fresh() {
        const out = {}, now = Date.now();
        Object.keys(this.raw).forEach((k) => { if (now - this.t[k] < STALE_MS) out[k] = this.raw[k]; });
        return out;
    }
    _put(got, now) {
        Object.keys(got).forEach((id) => { const c = DIDS[id]; if (got[id] !== null) { this.raw[c.key] = got[id]; this.t[c.key] = now; } });
    }
    async _ask(ids) {
        const uds = await this.link.readMany(DME, ids.map((x) => parseInt(x, 16)));
        if (uds === undefined) return null;                 // cancelled before it went
        return uds ? parse(uds, ids) : null;
    }
    /** Each identifier alone (its alternative when refused): what this engine has. Answers noted per identifier. */
    async _probe() {
        this.status = 'probing';
        const have = [];
        this.answer = {};
        for (const g of GROUPS) {
            for (const id of g.ids) {
                let ok = await this._ask([id]);
                if (ok && ok[id] !== undefined) { have.push(id); this.answer[id] = 'yes'; continue; }
                this.answer[id] = ok === null ? 'no reply' : 'refused';
                const alt = DIDS[id].alt;
                if (alt) {
                    ok = await this._ask([alt]);
                    if (ok && ok[alt] !== undefined) { have.push(alt); this.answer[alt] = 'yes'; } else this.answer[alt] = ok === null ? 'no reply' : 'refused';
                }
            }
        }
        return have;
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
                // each group: the identifiers it has (an alternative in its original's group)
                this.groups = GROUPS.map((g) => ({ name: g.name, fast: !!g.fast, last: 0,
                    ids: have.filter((id) => g.ids.indexOf(id) >= 0 || g.ids.indexOf(alternativeOf(id)) >= 0) })).filter((g) => g.ids.length);
                this.fast = [].concat.apply([], this.groups.filter((g) => g.fast).map((g) => g.ids));
                this.slow = [].concat.apply([], this.groups.filter((g) => !g.fast).map((g) => g.ids));
                this.status = 'reading';
                this.log.info('engine unit: reading ' + have.join(' '));
            }
            const now = Date.now(), fast = this.groups.filter((g) => g.fast);
            if (fast.length) {
                const g = fast[turn++ % fast.length];                     // the fast groups in turn
                const got = await this._ask(g.ids);
                if (got) { this._put(got, Date.now()); if (g === fast[0]) this.reads.push(Date.now()); }
            }
            for (const g of this.groups.filter((x) => !x.fast)) {
                if (now - g.last < SLOW_MS) continue;
                g.last = now;
                const got = await this._ask(g.ids);
                if (got) this._put(got, Date.now());
            }
            while (this.reads.length && Date.now() - this.reads[0] > 2000) this.reads.shift();
            this.rate = this.reads.length / 2;
            // several misses in a row: the link skips the unit; start over (probe again in 30 s)
            if (this.link.silent && this.link.silent(DME)) { this.have = []; this.triedAt = Date.now(); this.status = 'no answer'; }
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
        timing: th > 0.9 ? 8 + (rpm - 4000) / 1000 : 22, wastegate: th > 0.9 ? 30 : 85,
        tim1: th > 0.9 ? 8 : 22, tim2: th > 0.9 ? 8 : 22, tim3: th > 0.9 ? 8 : 22, tim4: th > 0.9 && Math.sin(t / 2300) > 0.8 ? 5 : th > 0.9 ? 8 : 22, tim5: th > 0.9 ? 8 : 22, tim6: th > 0.9 ? 8 : 22,
    };
}

module.exports = { EngineDme, DIDS, GROUPS, NAMES, FAST, SLOW, decode, parse, values, demoRaw, DME };
