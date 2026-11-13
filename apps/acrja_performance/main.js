'use strict';
/**
 * Gauge Log - live gauges with a CSV data logger.
 *
 *   Gauges pages (up to 6): tiles of your own. Tap a tile (or press it with the controller) to
 *   choose its value, the page's layout, add or remove a page; or Edit tiles on the bar.
 *   Drag page:   timed runs (60 ft to 1/4 mile, trap speeds, 0-60 mph ...) with the engine's figures on
 *                each run; the runs and best times.
 *   Dyno page:   full-throttle pulls in one gear against rpm: torque / power, boost, AFR, knock, rail.
 *   Logger page: start / stop, what is being written, the last 60 s of rpm and speed.
 *   Files page:  the log files on the head unit, newest first; delete all.
 *
 * Logs go to data/logs/log_YYYYMMDD_HHMMSS.csv in the app's folder on the head unit
 * (/var/opt/public/oap/oap_<uid>/data/logs/), one row per sample at the chosen rate, in
 * metric units. Copy them off over SSH (scp).
 *
 * The drawing is the only iDrive 7-specific part: logger.js and session.js have no drawing
 * and no head-unit APIs, so an iDrive 8 version keeps them and replaces this file.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Car = require('./kit/car');
const Logger = require('./logger');
const S = require('./session');
const T = require('./tiles');
const UI = require('./gauges_ui');
const MUI = require('./modes_ui');
const CUI = require('./check_ui');
const LOGO = require('./logo');
const BRAND = require('./brand');
const ACR_STYLE = require('./acr_style');   // ACR's own themes (adds them to the kit's list)
const EDME = require('./engine_dme');
const { Drag } = require('./drag');
const { Dyno } = require('./dyno');
const { RunTimer } = require('./kit/run_timer');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { TuneControl } = require('./tune');          // BM3 / MHD map switching (the kit's Live Adjustments commands)
const { DiagLink } = require('./diaglink');
const TUI = require('./tune_ui');
const { MapNames, renameSheet } = require('./map_names');

const W = 1600, H = 520;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // the car's own signals, and the pedal and outside temperature beside them
        const ext = { pedal: null, outside: null };
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'accel', 'torque', 'gear'], {
            'de.bmw.powertrain.AcceleratorPedal': { AngleAcceleratorPedal: (v) => {
                const x = v && v.actualValueAngleAcceleratorPedal;
                ext.pedal = typeof x === 'number' && x * 0.025 >= -2 && x * 0.025 <= 102 ? Math.max(0, Math.min(100, x * 0.025)) : null;
            } },
            'de.bmw.infrastructure.EnvironmentalInformation': { ExteriorTemperature: (v) => {
                const x = v && v.temperatureExterior;
                ext.outside = typeof x === 'number' && x !== 255 ? x * 0.5 - 40 : null;
            } },
        });

        // the engine unit's values over read-only diagnostics, while the app is shown or logging
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init().catch((e) => log.warn('diagnostic link: ' + e));
        let dyno = null, drag = null;
        // engine map switching for a BM3 or MHD tune (Settings > Tuning software). Off: no link, nothing sent, no Tune tab.
        // A command only leaves on a press; the engine reads pause while one runs (one conversation with the DME at a time).
        const tune = new TuneControl(ctx, { rpm: () => { const d = car.data(); return d.demo ? null : d.rpm; } });
        let tuneLink = null, tunerWas = tune.tuner;
        function startTune() {
            if (!tune.armed) return tune.refresh().then(() => refresh());
            if (tuneLink) return tune.refresh().then(() => refresh());
            tuneLink = new DiagLink(ctx.signals, log);
            return tuneLink.init()
                .then(() => { tuneLink.onAvailable(() => tune.refresh().then(() => refresh())); return tune.start(tuneLink); })
                .then(() => refresh()).catch((e) => log.warn('tune link: ' + (e && e.message || e)));
        }
        const tuneAct = (fn) => () => { const p = fn(); refresh(); return Promise.resolve(p).then(() => refresh()).catch((e) => log.warn('tune: ' + e)); };
        const mapNames = new MapNames(path.join(ctx.dataDir, 'map_names.json'), log);
        function openRename() {
            const sh = renameSheet({ names: mapNames, start: tune.map || 1, locked: moving, onDone: () => refresh() });
            if (!(ctx.sheet && ctx.sheet(sh))) log.info('rename maps: needs the full-screen renderer (touch)');
            return null;
        }
        const tuneActs = {
            rename: () => openRename(),
            pick: (k) => { log.info('tune picked on the Tune page: ' + k); settings.set('tuner', k); return null; },
            map: (k) => tuneAct(() => tune.setMap(k)), cooling: (on) => tuneAct(() => tune.setCooling(on)), asd: (on) => tuneAct(() => tune.setAsd(on)),
            aggDown: () => { tune.stepAggression(-0.5); refresh(); }, aggUp: () => { tune.stepAggression(0.5); refresh(); },
            burblesApply: tuneAct(() => tune.applyBurbles(false)), burblesOff: tuneAct(() => tune.applyBurbles(true)),
        };
        // fast mode (Settings > Engine values): the main group only, in turn: on, off, or Auto (logging, Drag, Dyno)
        const fastMode = () => {
            const m = settings.get('engineRate');
            if (m === 'fast' || m === 'balanced') return m === 'fast';
            const k = kindOf();
            return logger.status().on || k === 'drag' || k === 'dyno' || (drag && drag.state === 'run') || (dyno && dyno.state === 'pull');
        };
        const dme = new EDME.EngineDme({ link, log, fast: fastMode, wanted: () => settings.get('engineData') !== 'off' && !car.data().demo && !tune.busy &&
            (ui.isVisible('MAIN') || logger.status().on || (drag && drag.state === 'run') || (dyno && dyno.state === 'pull')) });
        const misCount = new S.MisfireCount();
        // for the Check page: when each of the car's own signals last changed (demo data or not)
        // [name, key, decimals, quantity (units.js-style: shown in the chosen unit) or a fixed unit]
        const SIGNALS = [['Engine speed', 'rpm', 0, 'rpm'], ['Speed', 'speed', 0, '@speed'], ['Coolant', 'coolant', 0, '@temp'], ['Oil', 'oil', 0, '@temp'],
            ['Accel., longitudinal', 'gLong', 2, 'g'], ['Accel., lateral', 'gLat', 2, 'g'], ['Engine torque', 'torque', 0, '@torque'], ['Gear', 'gear', 0, ''],
            ['Accelerator pedal', 'pedal', 0, '%'], ['Outside temperature', 'outside', 1, '@temp']];
        const sigSeen = {}, sigPrev = {};
        setInterval(() => {
            const now = Date.now();
            SIGNALS.forEach((s) => {
                const v = s[1] === 'pedal' || s[1] === 'outside' ? ext[s[1]] : car.live[s[1]];
                if (v !== null && v !== undefined && v !== sigPrev[s[1]]) { sigPrev[s[1]] = v; sigSeen[s[1]] = now; }
            });
        }, 250);
        /** Everything at this moment: car.data() plus pedal, outside, the engine unit's values (.dme), misfires this session. */
        function data() {
            const d = car.data(), now = Date.now();
            d.pedal = d.demo ? (typeof d.throttle === 'number' ? d.throttle * 100 : null) : ext.pedal;
            d.outside = d.demo ? 24 : ext.outside;
            d.dme = settings.get('engineData') === 'off' ? {} : EDME.values(d.demo ? EDME.demoRaw(d, now) : dme.fresh(), settings.get('stoich'));
            d.misfires = misCount.feed(d.dme.misfireTotal);
            d.tuneMap = tune.armed ? tune.map : null;
            d.tuneMapName = tune.armed && tune.map ? mapNames.get(tune.map) : '';
            return d;
        }
        const logger = new Logger({ dir: path.join(ctx.dataDir, 'logs'), columns: S.COLUMNS, maxFiles: settings.get('maxFiles'), log });
        const auto = new S.AutoLog();
        const hist = new S.History(60, 200);
        const pages = new T.Pages(path.join(ctx.dataDir, 'pages.json'), log);
        let page = 0, files = logger.list(), filesAt = 0;

        /* ---------- logging ---------- */
        const canLog = () => !car.data().demo || settings.get('logDemo');
        function startLog(byHand) {
            if (logger.status().on) return;
            if (!canLog()) { log.info('not logging demo data (setting "Log demo data too" is off)'); return; }
            logger.maxFiles = settings.get('maxFiles');
            // the file's units are fixed when it starts: metric, or the screen's (Settings > Log file units)
            logUnits = settings.get('logUnits') === 'screen' ? unitsNow() : null;
            logger.columns = S.columnsFor(logUnits);
            logger.start(car.data().demo ? 'demo' : '');
            if (byHand) auto.manual();
            refresh();
        }
        function stopLog() {
            if (!logger.status().on) return;
            logger.stop();
            files = logger.list();
            refresh();
        }
        let logUnits = null;
        const toggleLog = () => (logger.status().on ? stopLog() : startLog(true));

        // one row per tick at the log rate, from the latest values (the car only sends a signal when it changes)
        let sampler = null;
        function startSampler() {
            if (sampler) clearInterval(sampler);
            const hz = settings.get('logRate') || 10;
            sampler = setInterval(() => {
                const d = data(), now = Date.now(), st = logger.status();
                if (st.on && d.demo && !settings.get('logDemo')) stopLog();       // the car went quiet: no demo rows in a car log
                const a = auto.feed(settings.get('autoLog'), d, now, st.on);
                if (a === 'start') startLog(false);
                else if (a === 'stop') stopLog();
                if (logger.status().on) logger.add(S.rowIn(S.row(d), logUnits));
            }, Math.round(1000 / hz));
        }
        startSampler();
        settings.onChange(() => {
            startSampler(); logger.maxFiles = settings.get('maxFiles');
            if (tune.tuner !== tunerWas) { tunerWas = tune.tuner; startTune(); }   // the Tune page follows the picked tune
        });
        /* ---------- drag and dyno ---------- */
        // "During drag runs and dyno pulls": a log from the launch / the pull's start to its end
        const runLog = (on) => { if (settings.get('autoLog') !== 'runs') return; if (on) startLog(false); else setTimeout(stopLog, 2000); };
        drag = new Drag({ RunTimer, file: path.join(ctx.dataDir, 'drag_runs.json'), rollout: () => settings.get('rollout'), log,
            onLaunch: () => runLog(true), onDone: () => { runLog(false); refresh(); } });
        dyno = new Dyno({ file: path.join(ctx.dataDir, 'dyno_pulls.json'), log,
            onStart: () => { dynoView = 0; runLog(true); }, onDone: () => { dynoView = 0; runLog(false); refresh(); } });
        let dragHistory = false, dynoView = 0;
        car.onSample((d0, t) => {
            const d = data();
            hist.feed(d, t);
            drag.setSource(d.demo, settings.get('rollout'));
            dyno.setSource(d.demo);
            drag.feed(t, d);
            dyno.feed(t, d);
        }, () => hist.clear());
        setInterval(() => drag.idle(Date.now()), 50);
        dme.start();
        // MainApp stops the app at shutdown: write what is left
        process.on('exit', () => logger.stop());

        /* ---------- units ---------- */
        // every page's units: Settings > Units (metric, imperial, or custom: the per-quantity settings)
        const unitsNow = () => Object.assign(T.resolveUnits((k) => settings.get(k)),
            { stoich: settings.get('stoich'), rpmMax: settings.get('rpmMax'), redline: settings.get('redline') });
        const spd = (v) => T.conv('speed', v, unitsNow());
        const mph = () => unitsNow().speed === 'mph';

        /* ---------- pages ---------- */
        /* ---------- gauge pages: tiles of your own ---------- */
        const isGauge = () => page < pages.list.length;
        const reading = (id) => {
            const c = T.BY_ID[id], v = T.readAll(data())[id];
            if (c.logo) return '';
            if (c.text) return T.gearText(v);
            return T.isNum(v) ? G.fmt(T.show(id, v, unitsNow()), T.decOf(id, unitsNow())) + ' ' + c.unit(unitsNow()) : '--';
        };
        // no editing while the car drives (the car's own speed: demo data never locks)
        const moving = () => T.isNum(car.live.speed) && car.live.speed > 3;
        let lockNoteAt = 0;
        function locked() {
            if (!moving()) return false;
            lockNoteAt = Date.now(); refresh();
            return true;
        }
        setInterval(() => { if (edit && moving()) { log.info('editing ended: the car moves'); edit = null; lockNoteAt = Date.now(); refresh(); } }, 500);
        // an actual-vs-target tile's alarm (per page, tile and value): flashing while outside its tolerance
        const alarms = {};
        const fmtLimit = (id, k, v) => {
            const u = unitsNow(), c = T.BY_ID[id];
            if (k === 'thr' && v > 0) return v + ' % ' + (settings.get('watchBy') === 'throttle' ? 'throttle' : 'pedal') + ' and up';
            const txt = T.limitText(k, v);
            if (txt) return txt;
            return (k === 'tol' ? '± ' : '') + G.fmt(T.show(id, v, u), T.decOf(id, u) + (k === 'tol' && T.decOf(id, u) < 2 ? 1 : 0)) + ' ' + c.unit(u);
        };
        /** A tile's flash state: an actual-vs-target tile against its tolerance, a single value against its flash limits. */
        function tileState(pg, i, id, now, ms, prefix) {
            const c = id && T.BY_ID[id];
            if (!c) return null;
            const key = prefix + ':' + i + ':' + id;
            if (c.pair) {
                // the target: the engine unit's, or the tile's custom one; watched only from the pedal % set (thr)
                const lim = T.limitsOf(pg, i), al = alarms[key] || (alarms[key] = new T.Alarm());
                // watched from: the accelerator pedal (the car's signal) or the throttle plate (engine unit), Settings;
                // the plate when there is no reading of it falls back to the pedal
                const byThrottle = settings.get('watchBy') === 'throttle' && T.isNum(now.throttle), gv = byThrottle ? now.throttle : now.pedal;
                const tg = T.pairTarget(lim, now[c.pair[1]]), watch = !(lim.thr > 0) || (T.isNum(gv) && gv >= lim.thr);
                return { lim, ms, target: tg.v, custom: tg.custom, watch, gateName: byThrottle ? 'throttle' : 'pedal', flash: al.feed(now[c.pair[0]], tg.v, lim.tol, ms, lim.dir, watch) };
            }
            const A = T.alarmsOf(pg, i);
            if (!A) return null;
            const al = alarms[key] || (alarms[key] = new T.Alarm({ holdIn: 0, holdOut: 1500 }));
            return { alarm: A, ms, flash: al.feedLimits(now[id], A.ahi, A.alo, ms) };
        }
        function drawGauges(cv, t) {
            const pg = pages.list[page], u = unitsNow(), now = T.readAll(data()), bx = UI.boxes(pg.layout), ms = Date.now();
            const marked = edit ? editItem().tile : -1;
            bx.forEach((b, i) => {
                const id = pg.tiles[i], pair = tileState(pg, i, id, now, ms, String(page));
                UI.drawTile(cv, t, G, b, id, now, u, hist, marked === i, pair);
                // a tile tapped (or pressed with the controller): its sheet
                if (cv.own && !edit) cv.target(b.x, b.y, b.w, b.h, () => openTile(i), 'tile:' + page + ':' + i);
            });
            if (edit) drawEditBar(cv, t, pg, bx);
            else if (Date.now() - lockNoteAt < 3000) {
                cv.roundRect(424, 452, 752, 52, 12, withAlpha(t.bg, 0.94));
                cv.strokeRoundRect(424, 452, 752, 52, 12, 2, t.warn);
                cv.text('Stop the car to edit tiles', 800, 486, 26, t.warn, { align: 'center', font: 'bold' });
            }
        }

        // Editing with the bar's buttons (works with any renderer): Next tile / Change value / Done
        let edit = null;                 // { sel: tile index, then the page items after the tiles }
        const ITEMS = ['layout', 'add', 'remove'];
        const slots = () => T.layout(pages.list[page].layout).slots.length;
        /** What Next tile steps through: each tile (an actual-vs-target tile, then its 3 limits), then the page's items. */
        const editList = () => {
            const pg = pages.list[page], out = [];
            for (let i = 0; i < slots(); i++) {
                out.push({ tile: i });
                if (T.PAIRS[pg.tiles[i]]) T.LIMIT_KEYS.filter((k) => k in T.PAIRS[pg.tiles[i]]).forEach((k) => out.push({ tile: i, lim: k }));
                const A = T.ALARMS[pg.tiles[i]];
                if (A) T.ALARM_KEYS.forEach((k) => { if (k in A) out.push({ tile: i, al: k }); });
            }
            return out.concat(ITEMS.map((x) => ({ item: x })));
        };
        const editItem = () => { const l = editList(); return l[edit.sel % l.length]; };
        function startEdit(tile) {
            edit = { sel: 0, at: Date.now(), armed: 0 };
            edit.sel = Math.max(0, editList().findIndex((x) => x.tile === (tile || 0) && !x.lim && !x.al));
            refresh();
        }
        function endEdit() { edit = null; refresh(); }
        function nextTile() {
            if (locked()) { edit = null; return refresh(); }
            edit.sel = (edit.sel + 1) % editList().length; edit.at = Date.now(); edit.armed = 0; refresh();
        }
        function changeValue() {
            if (locked()) { edit = null; return refresh(); }
            const it = editItem(), pg = pages.list[page];
            edit.at = Date.now();
            if (!it) return refresh();
            if (it.al) {
                // Off, then each choice in turn
                const id = pg.tiles[it.tile], st = [null].concat(T.ALARMS[id].steps[it.al]), cur = T.alarmsOf(pg, it.tile)[it.al];
                const at = st.findIndex((v) => (v === null ? cur === null : T.isNum(cur) && Math.abs(v - cur) < 1e-9));
                pages.setLimit(page, it.tile, it.al, st[(at + 1) % st.length]);
            } else if (it.lim) {
                const id = pg.tiles[it.tile], st = T.PAIRS[id].steps[it.lim], cur = T.limitsOf(pg, it.tile)[it.lim];
                const at = st.findIndex((v) => Math.abs(v - cur) < 1e-9);
                pages.setLimit(page, it.tile, it.lim, st[(at + 1) % st.length]);
            } else if (it.tile !== undefined) {
                const ids = [null].concat(T.VALUES.map((v) => v.id)), cur = ids.indexOf(pg.tiles[it.tile]);
                pages.setTile(page, it.tile, ids[(cur + 1) % ids.length]);
                edit.sel = editList().findIndex((x) => x.tile === it.tile && !x.lim && !x.al);      // (its limits came or went)
            } else if (it.item === 'layout') {
                pages.setLayout(page, T.nextLayout(pg.layout));
                edit.sel = editList().findIndex((x) => x.item === 'layout');           // stay on it (the number of tiles changed)
            } else if (it.item === 'add') {
                if (pages.add()) { page = pages.list.length - 1; edit.sel = 0; log.info('gauge page added: ' + pages.list.length); }
            } else if (it.item === 'remove') {
                if (pages.list.length <= 1) { /* the last page stays */ } else if (Date.now() - edit.armed < 5000) {
                    pages.remove(page); log.info('gauge page removed: ' + pages.list.length + ' left');
                    page = Math.min(page, pages.list.length - 1); edit = null;
                } else edit.armed = Date.now();
            }
            refresh();
        }
        function drawEditBar(cv, t, pg, bx) {
            const it = editItem(), y = 466, h = 42, S = t.sel || t.accent;
            cv.roundRect(24, y, 1552, h, 10, withAlpha(t.bg, 0.92));
            cv.strokeRoundRect(24, y, 1552, h, 10, 2, S);
            let what;
            if (it.al) {
                const id = pg.tiles[it.tile], v = T.alarmsOf(pg, it.tile)[it.al];
                what = 'Tile ' + (it.tile + 1) + ', ' + T.BY_ID[id].name + ':  ' + T.ALARM_NAMES[it.al] + ' ' + (v === null ? 'Off' : fmtLimit(id, it.al, v)) + '   ·   Change: the next one';
            } else if (it.lim) {
                const id = pg.tiles[it.tile];
                what = 'Tile ' + (it.tile + 1) + ', ' + T.BY_ID[id].name + ':  ' + T.LIMIT_NAMES[it.lim] + ' ' + fmtLimit(id, it.lim, T.limitsOf(pg, it.tile)[it.lim]) + '   ·   Change value: the next one';
            } else if (it.tile !== undefined) {
                const id = pg.tiles[it.tile];
                what = 'Tile ' + (it.tile + 1) + ' of ' + bx.length + ':  ' + (id ? T.BY_ID[id].name : 'Empty') + '   ·   Change value: the next one';
            } else if (it.item === 'layout') what = 'Page layout:  ' + T.layout(pg.layout).name + '   ·   Next layout: the next one';
            else if (it.item === 'add') what = pages.list.length < T.MAX_PAGES ? 'Add a gauge page (' + pages.list.length + ' of ' + T.MAX_PAGES + ')' : 'No more pages (' + T.MAX_PAGES + ' at most)';
            else what = pages.list.length > 1 ? (Date.now() - edit.armed < 5000 ? 'Press again to remove this page' : 'Remove this page') : 'The last gauge page stays';
            cv.text('EDITING', 44, y + 29, 20, S, { font: 'bold', spacing: 2 });
            cv.text(what, 170, y + 29, 22, t.text);
            cv.text('Next tile  ·  Done', 1556, y + 29, 20, t.dim, { align: 'right' });
        }

        // the sheet over the page (GPU renderer); elsewhere the bar's edit mode on that tile
        function openTile(i) {
            if (locked()) return;
            const pg = pages.list[page], p = page;
            const sh = UI.tileSheet({
                title: 'Tile ' + (i + 1) + '  (' + ({ dial: 'dial', num: 'number', bar: 'bar' }[UI.boxes(pg.layout)[i].kind]) + ')',
                current: pg.tiles[i], reading, locked: moving,
                choose: (id) => { pages.setTile(p, i, id); refresh(); },
                limits: () => T.limitsOf(pages.list[p], i),
                limitSteps: (k) => (T.PAIRS[pages.list[p].tiles[i]] || { steps: {} }).steps[k] || [],
                fmtLimit: (k, v) => fmtLimit(pages.list[p].tiles[i], k, v),
                setLimit: (k, v) => { pages.setLimit(p, i, k, v); refresh(); },
                alarms: () => T.alarmsOf(pages.list[p], i),
                alarmSteps: (k) => ((T.ALARMS[pages.list[p].tiles[i]] || { steps: {} }).steps[k] || []),
                setAlarm: (k, v) => { pages.setLimit(p, i, k, v); refresh(); },
                layout: pg.layout, setLayout: (id) => { pages.setLayout(p, id); refresh(); },
                add: pages.list.length < T.MAX_PAGES ? () => { if (pages.add()) { page = pages.list.length - 1; refresh(); } } : null,
                remove: pages.list.length > 1 ? () => { pages.remove(p); page = Math.min(page, pages.list.length - 1); refresh(); } : null,
            });
            if (!(ctx.sheet && ctx.sheet(sh))) startEdit(i);
        }
        setInterval(() => { if (edit && Date.now() - edit.at > 90000) { log.info('editing ended (idle)'); endEdit(); } }, 5000);
        function drawLogger(cv, t) {
            const st = logger.status(), now = Date.now();
            G.panel(cv, t, 24, 44, 640, 468, 'Logger');
            LOGO.draw(cv, 'mark', 664 - 20 - 200 - 24 - LOGO.size('mark').w, 62);
            G.button(cv, t, 664 - 20 - 200, 56, 200, 40, st.on ? 'Stop log' : 'Start log', toggleLog, { key: 'log', primary: !st.on, color: st.on ? t.crit : null });
            G.pill(cv, t, 48, 112, 170, 36, st.on ? 'RECORDING' : 'STOPPED', { color: st.on ? t.crit : t.dim, filled: st.on ? 0.25 : 0.08 });
            const w = cv.text(st.on ? S.duration(now - st.startedAt) : '--:--', 48, 238, 96, st.on ? t.text : t.dim, { font: 'num' });
            if (st.on) cv.text('elapsed', 60 + w, 238, 24, t.dim);
            const rows = [
                ['Rows', st.on ? String(st.rows) : '--'],
                ['File size', st.on ? S.size(st.bytes) : '--'],
                ['Rate', settings.get('logRate') + ' Hz'],
                ['Auto start', { off: 'Off', engine: 'Engine running', moving: 'Car moving', runs: 'Drag runs, dyno pulls' }[settings.get('autoLog')] || 'Off'],
                ['Engine unit', settings.get('engineData') === 'off' ? 'Off' : car.data().demo ? 'Demo values' : dme.status + (dme.status === 'reading' ? ' (' + dme.rate.toFixed(0) + '/s)' : '')],
            ];
            rows.forEach((r, i) => {
                const y = 292 + i * 40;
                cv.text(r[0].toUpperCase(), 48, y, 20, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(r[1], 640, y, 24, t.text, { align: 'right' });
            });
            const note = st.error ? st.error : st.on ? st.file : car.data().demo && !settings.get('logDemo') ? 'Demo data: not logged (see settings)' : 'Logs are kept in the app\'s data/logs folder';
            cv.text(note.length > 52 ? note.slice(0, 50) + '...' : note, 48, 496, 20, st.error ? t.crit : t.dim);

            G.panel(cv, t, 688, 44, 888, 468, 'Last 60 s:  rpm and ' + T.unitOf('speed', unitsNow()));
            const rmax = settings.get('rpmMax'), vmax = mph() ? 160 : 280;
            G.chart(cv, t, 704, 96, 856, 196, { xMin: -60, xMax: 0, yMin: 0, yMax: rmax, xStep: 10, yStep: rmax / 7 % 1 ? 1000 : rmax / 7,
                xFmt: (v) => (v ? String(-v) : 'now'), yFmt: (v) => (v / 1000) + 'k rpm',
                series: [{ pts: hist.series('rpm', now), color: 'accent', fill: true }], marks: [{ y: settings.get('redline'), color: 'crit' }], empty: 'Waiting for data' });
            G.chart(cv, t, 704, 304, 856, 196, { xMin: -60, xMax: 0, yMin: 0, yMax: vmax, xStep: 10, yUnit: T.unitOf('speed', unitsNow()).toUpperCase(),
                xFmt: (v) => (v ? String(-v) : 'now'), xUnit: 's',
                series: [{ pts: hist.series('speed', now, spd), color: 'accent2', fill: true }], empty: 'Waiting for data' });
        }

        function drawFiles(cv, t) {
            if (Date.now() - filesAt > 2000) { files = logger.list(); filesAt = Date.now(); }
            G.panel(cv, t, 24, 44, 1552, 468, 'Log files  (' + files.length + ')');
            LOGO.draw(cv, 'mark', 1576 - 20 - 200 - 24 - LOGO.size('mark').w, 62);
            G.button(cv, t, 1576 - 20 - 200, 56, 200, 40, 'Delete all', deleteAll, { key: 'delete', confirm: true });
            const cur = logger.status().file, p = (n) => String(n).padStart(2, '0');
            const rows = files.slice(0, 9).map((f) => {
                const d = new Date(f.at);
                return [{ text: f.name, color: f.name === cur ? 'crit' : null }, d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()),
                    S.size(f.bytes), f.name === cur ? 'recording' : ''];
            });
            G.table(cv, t, 48, 116, 1504, [{ label: 'File', w: 760 }, { label: 'Last written', w: 340 }, { label: 'Size', w: 200, align: 'right' }, { label: '', w: 204, align: 'right', color: 'crit' }],
                rows, { empty: 'No logs yet. Start one on the Logger page.' });
            if (files.length > 9) cv.text('+ ' + (files.length - 9) + ' older', 48, 500, 20, t.dim);
        }

        function deleteAll() {
            const n = logger.deleteAll();
            log.info('deleted ' + n + ' log files');
            files = logger.list(); filesAt = Date.now();
            refresh();
        }

        /* ---------- screen ---------- */
        const MODE_NAMES = { drag: 'Drag', dyno: 'Dyno', tune: 'Tune', logger: 'Logger', files: 'Files', check: 'Check' };
        const modes = () => ['drag', 'dyno', 'tune', 'logger', 'files', 'check'];   // Tune: "pick your tune" while Off
        // the header: one tab for all gauge pages (which one: "Gauges 2/4"; the tab again: the next one), then
        // the modes. Few tabs, so the kit's own Settings tab after them always fits.
        let lastGauge = 0;
        const tabs = () => [pages.list.length > 1 ? 'Gauges ' + ((isGauge() ? page : Math.min(lastGauge, pages.list.length - 1)) + 1) + '/' + pages.list.length : 'Gauges']
            .concat(modes().map((k) => MODE_NAMES[k]));
        const tabOf = () => (isGauge() ? 0 : page - pages.list.length + 1);
        function drawCheck(cv, t) {
            const now = Date.now();
            CUI.drawCheck(cv, t, G, { credit: BRAND.CREDIT,
                signals: SIGNALS.map((s) => {
                    const v = sigPrev[s[1]];
                    const q = s[3].charAt(0) === '@' ? s[3].slice(1) : null, u = unitsNow();
                    const vv = q ? T.conv(q, v, u) : v, un = q ? T.unitOf(q, u) : s[3];
                    const txt = s[1] === 'gear' ? (v === undefined ? '--' : T.gearText(v)) : T.isNum(vv) ? vv.toFixed(s[2]) + (un ? ' ' + un : '') : '--';
                    return { name: s[0], value: txt, age: sigSeen[s[1]] ? now - sigSeen[s[1]] : null };
                }),
                demo: car.data().demo, setting: settings.get('engineData'),
                link: Object.assign({ ready: link.ready, available: link.available, error: link.error }, link.stats),
                status: dme.status, rate: dme.rate, health: dme.health(),
                cross: (() => { const e = EDME.values(dme.fresh(), settings.get('stoich')); return Object.assign({ stoich: settings.get('stoich') }, e); })(), have: !!(dme.have && dme.have.length), report: dme.report(), keyOf: (id) => (EDME.DIDS[id] || {}).key,
            });
        }
        const kindOf = () => (isGauge() ? 'gauges' : modes()[page - pages.list.length]);
        const drawTunePage = (cv, t) => TUI.drawTune(cv, t, G, Object.assign(tune.view(), { names: (k) => mapNames.get(k) }), tuneActs);
        const drawMode = (cv, t) => {
            const o = { drag, dyno, d: data(), u: unitsNow(), now: Date.now(), history: dragHistory, view: dynoView, limitsFor: dynoLimits };
            if (kindOf() === 'drag') {
                o.hideEngine = !dragHistory && dragLive();
                MUI.drawDrag(cv, t, G, o);
                if (o.hideEngine) drawDragTiles(cv, t);
                if (!dragHistory) drawViewButtons(cv, t);
                if (Date.now() - lockNoteAt < 3000) {
                    cv.roundRect(424, 452, 752, 52, 12, withAlpha(t.bg, 0.94));
                    cv.strokeRoundRect(424, 452, 752, 52, 12, 2, t.warn);
                    cv.text('Stop the car to edit tiles', 800, 486, 26, t.warn, { align: 'center', font: 'bold' });
                }
                if (dragHistory) G.button(cv, t, 1576 - 20 - 200, 56, 200, 40, 'Delete runs', () => { drag.clear(); refresh(); }, { key: 'dragclear', confirm: true });
            } else {
                MUI.drawDyno(cv, t, G, o);
                if (dyno.pulls().length > 1) G.button(cv, t, 924 - 20 - 170, 56, 170, 40, 'Older pull', olderPull, { key: 'older' });
            }
        };
        /* ---------- the Drag page's right panel: live tiles during a run, the engine's summary after it ---------- */
        // auto: live tiles while armed or running, the summary when the run is over; live / last: pinned
        let dragView = 'auto';
        const VIEWS = ['auto', 'live', 'last'], VIEW_NAMES = { auto: 'Auto', live: 'Live', last: 'Last' };
        const dragLive = () => dragView === 'live' || (dragView === 'auto' && (drag.state === 'run' || drag.state === 'ready'));
        function cycleDragView() { dragView = VIEWS[(VIEWS.indexOf(dragView) + 1) % VIEWS.length]; refresh(); return null; }
        function setDragView(v) { dragView = v; refresh(); return null; }
        /** Auto / Live / Last at the panel's top right, the one in use lit; each a touch target (the bar's Panel: button steps them). */
        function drawViewButtons(cv, t) {
            const S = t.sel || t.accent, w = 84, h = 32, gap = 6, y = 48;
            let x = 1566 - VIEWS.length * w - (VIEWS.length - 1) * gap;
            VIEWS.forEach((v) => {
                const on = v === dragView;
                cv.roundRect(x, y, w, h, h / 2, on ? withAlpha(S, 0.9) : withAlpha('#ffffff', 0.08));
                if (!on) cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha('#ffffff', 0.25));
                cv.text(VIEW_NAMES[v].toUpperCase(), x + w / 2, y + 22, 16, on ? '#ffffff' : t.text, { align: 'center', font: 'bold', spacing: 1 });
                if (cv.own) { const vv = v; cv.target(x - 3, y - 4, w + 6, h + 8, () => setDragView(vv), 'drag:view:' + v); }
                x += w + gap;
            });
        }
        /** The mini tiles' boxes in the panel: 2 x 3 under the title strip. */
        function dragBoxes() {
            const n = 6, rows = 3, x0 = 1056, y0 = 92, w = 520, h = 420, gap = 12;
            const bw = (w - gap) / 2, bh = (h - gap * (rows - 1)) / rows, out = [];
            for (let i = 0; i < n; i++) out.push({ x: Math.round(x0 + (i % 2) * (bw + gap)), y: Math.round(y0 + Math.floor(i / 2) * (bh + gap)), w: Math.round(bw), h: Math.round(bh), kind: 'num' });
            return out;
        }
        function drawDragTiles(cv, t) {
            const pg = pages.drag, u = unitsNow(), now = T.readAll(data()), ms = Date.now();
            // title strip: what is shown, and that a tap switches it
            cv.roundRect(1056, 44, 520, 40, 8, withAlpha('#ffffff', 0.05));
            cv.text(drag.state === 'run' ? 'LIVE, THIS RUN' : drag.state === 'ready' ? 'LIVE, ARMED' : 'LIVE', 1074, 71, 18, t.text, { font: 'bold', spacing: 1.5 });
            dragBoxes().forEach((b, i) => {
                const id = pg.tiles[i], pair = tileState(pg, i, id, now, ms, 'drag');
                UI.drawTile(cv, t, G, b, id, now, u, hist, false, pair);
                if (cv.own) cv.target(b.x, b.y, b.w, b.h, () => openDragTile(i), 'drag:tile:' + i);
            });
        }
        /** A mini tile's sheet: its value and limits (no layout or pages here); parked only, as the gauge pages. */
        function openDragTile(i) {
            if (moving()) { lockNoteAt = Date.now(); return refresh(); }
            const sh = UI.tileSheet({
                title: 'Drag tile ' + (i + 1), current: pages.drag.tiles[i], reading, locked: moving,
                choose: (id) => { pages.setTile('drag', i, id); refresh(); },
                limits: () => T.limitsOf(pages.drag, i),
                limitSteps: (k) => (T.PAIRS[pages.drag.tiles[i]] || { steps: {} }).steps[k] || [],
                fmtLimit: (k, v) => fmtLimit(pages.drag.tiles[i], k, v),
                setLimit: (k, v) => { pages.setLimit('drag', i, k, v); refresh(); },
                alarms: () => T.alarmsOf(pages.drag, i),
                alarmSteps: (k) => ((T.ALARMS[pages.drag.tiles[i]] || { steps: {} }).steps[k] || []),
                setAlarm: (k, v) => { pages.setLimit('drag', i, k, v); refresh(); },
                layout: null, setLayout() {}, add: null, remove: null,
            });
            if (!(ctx.sheet && ctx.sheet(sh))) { log.info('drag tiles: editing needs the full-screen renderer (touch)'); }
        }
        /**
         * The Dyno tiles' limits: those of the Drag tile with the same value (else its defaults), in metric:
         * { lo, hi, tol } for actual against target, { lo, hi, ahi, alo } for a single value (its range).
         */
        function dynoLimits(id) {
            const c = T.BY_ID[id], i = pages.drag.tiles.indexOf(id), u = unitsNow();
            if (c.pair) return i >= 0 ? T.limitsOf(pages.drag, i) : T.pairDefaults(id);
            const A = i >= 0 ? T.alarmsOf(pages.drag, i) : T.ALARMS[id] ? { ahi: T.ALARMS[id].ahi, alo: T.ALARMS[id].alo } : {};
            const r = id === 'timing' ? [-5, 40] : c.range(u);            // (knock and timing read the same in any units)
            return Object.assign({ lo: r[0], hi: r[1] }, A || {});
        }
        const olderPull = () => { const n = dyno.pulls().length; dynoView = n ? (dynoView + 1) % n : 0; refresh(); };
        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), st = logger.status();
            // the first moments: ACR's start-up screen (no tabs, no targets), then the pages
            if (BRAND.splashing()) { BRAND.drawSplash(cv, t); await ui.image('MAIN_GFX', cv); return; }
            ({ gauges: drawGauges, drag: drawMode, dyno: drawMode, tune: drawTunePage, logger: drawLogger, files: drawFiles, check: drawCheck })[kindOf()](cv, t);
            G.frame(cv, t, tabs(), tabOf(), [st.on && { text: 'REC ' + S.duration(Date.now() - st.startedAt), color: 'crit' }, car.data().demo && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }
        // the bar's Delete all asks twice (the page's button has its own Confirm)
        let armed = null;
        function actionLabel() {
            const k = kindOf();
            let a;
            if (edit) {
                const it = editItem();
                a = it.al ? 'Change ' + T.ALARM_NAMES[it.al].toLowerCase() : it.lim ? 'Change ' + T.LIMIT_NAMES[it.lim].toLowerCase() : it.tile !== undefined ? 'Change value' : it.item === 'layout' ? 'Next layout' : it.item === 'add' ? 'Add page'
                    : Date.now() - edit.armed < 5000 ? 'Yes, remove' : 'Remove page';
            } else if (k === 'drag') a = dragHistory ? 'Live run' : 'Runs';
            else if (k === 'dyno') a = 'Older pull';
            else if (k === 'check') a = 'Ask engine again';
            else if (k === 'tune') a = tune.armed ? 'Next map' : 'Pick in Settings';
            else a = k === 'files' ? (armed ? 'Yes, delete' : 'Delete all') : logger.status().on ? 'Stop log' : 'Start log';
            ui.text('BTN_ACTION', a);
            ui.text('BTN_PAGE', edit ? 'Next tile' : 'Next page');
            ui.text('BTN_EDIT', k === 'drag' ? 'Panel: ' + VIEW_NAMES[dragView] : k === 'tune' ? 'Rename maps' : edit ? 'Done' : 'Edit tiles');
            if (ui.visible) ui.visible('BTN_EDIT', k === 'gauges' || (k === 'tune' && tune.armed) || (k === 'drag' && !dragHistory));
        }
        function barDelete() {
            if (!armed) { armed = setTimeout(() => { armed = null; actionLabel(); }, 5000); return actionLabel(); }
            clearTimeout(armed); armed = null;
            return deleteAll();
        }
        function refresh() { actionLabel(); return render().catch((e) => log.warn('render: ' + e)); }
        const n = () => pages.list.length + modes().length;
        const go = (p) => { edit = null; page = (p + n()) % n(); if (isGauge()) lastGauge = page; return refresh(); };
        ui.onClick('BTN_PAGE', () => (edit ? nextTile() : go(page + 1)));
        ui.onClick('BTN_EDIT', () => {
            if (kindOf() === 'drag') return cycleDragView();
            if (kindOf() === 'tune') return tune.armed ? openRename() : null;
            return edit ? endEdit() : isGauge() && !locked() && startEdit(0);
        });
        ctx.onTab((i) => {
            if (i === 0) {
                // Gauges: back to the gauge page last shown, or (already on one) the next gauge page
                if (!isGauge()) return go(Math.min(lastGauge, pages.list.length - 1));
                return pages.list.length > 1 ? go((page + 1) % pages.list.length) : null;
            }
            const p = pages.list.length + i - 1;
            return p !== page ? go(p) : null;
        });
        ui.onClick('BTN_ACTION', () => {
            const k = kindOf();
            if (edit) return changeValue();
            if (k === 'files') return barDelete();
            if (k === 'drag') { dragHistory = !dragHistory; return refresh(); }
            if (k === 'dyno') return olderPull();
            if (k === 'tune') return tune.armed ? tuneAct(() => tune.setMap(((tune.map || 0) % 4) + 1))() : null;
            if (k === 'check') { dme.reprobe(); log.info('engine unit: asked again (Check page)'); return refresh(); }
            return toggleLog();
        });
        G.onConfirm(() => render().catch(() => {}));
        startTune();                            // nothing at all while Tuning software is Off
        ctx.loop('MAIN', 10, render);
        refresh().then(() => log.info('first frame done'));
        setTimeout(() => refresh(), BRAND.SPLASH_MS + 50);      // the pages after the start-up screen (also without the loop running)
    },
});
