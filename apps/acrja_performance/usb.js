'use strict';
/**
 * usb.js - the car's USB stick: copy the logs to it, and export / import the app's set-up (tiles, pages, settings,
 * map names) so several cars can share one set-up. Plain fs, Node 8 (callbacks, no fs.promises).
 *
 * The head unit mounts a stick under /media/<label> (udisks; the MGU Store reads it the same way), so a stick is a
 * mount point directly under /media (or /run/media/<user>, /mnt) on a removable file system. On the stick:
 *
 *   ACR_Performance/logs/log_YYYYMMDD_HHMMSS.csv      the logs (a file already there with the same size is skipped)
 *   ACR_Performance/acr_performance_config.json       the set-up
 *
 *   USB.sticks()                      [{ path, label, ro }]
 *   USB.copyLogs(dir, names, stick, cb)   cb(err, { copied, skipped, bytes, failed })
 *   USB.writeConfig(stick, cfg, cb) / USB.readConfig(stick, cb)   cb(err, cfg)
 *   USB.applySettings(settings, values)   the values a car's settings accept, set; returns how many changed
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['/media', '/run/media', '/mnt'];
const FS_TYPES = ['vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'ext4', 'ext3', 'ext2', 'msdos', 'hfsplus'];
const FOLDER = 'ACR_Performance', CONFIG = 'acr_performance_config.json', APP = 'acrja_performance';

/** /proc/mounts escapes spaces and such as \040 */
const unescape = (s) => s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));

/** The sticks plugged in, from /proc/mounts (text: for tests). */
function sticks(text) {
    let t = text;
    if (t === undefined) { try { t = fs.readFileSync('/proc/mounts', 'utf8'); } catch (e) { return []; } }
    const out = [];
    t.split('\n').forEach((line) => {
        const f = line.split(' ');
        if (f.length < 4) return;
        const mp = unescape(f[1]), type = f[2], opts = f[3].split(',');
        if (FS_TYPES.indexOf(type) < 0) return;
        const root = ROOTS.find((r) => mp.indexOf(r + '/') === 0);
        if (!root) return;
        const rest = mp.slice(root.length + 1).split('/');
        // /media/<label>, /mnt/<label>, /run/media/<user>/<label>
        if (!(rest.length === 1 || (root === '/run/media' && rest.length === 2))) return;
        out.push({ path: mp, label: rest[rest.length - 1], ro: opts.indexOf('ro') >= 0 });
    });
    return out;
}

function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    fs.mkdirSync(dir);
}

/** Copy one file through a temporary name (a pulled stick leaves no half file under the real name). */
function copyFile(src, dst, cb) {
    const tmp = dst + '.part';
    let done = false;
    const end = (err) => {
        if (done) return; done = true;
        if (err) { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } return cb(err); }
        fs.rename(tmp, dst, cb);
    };
    const r = fs.createReadStream(src), w = fs.createWriteStream(tmp);
    r.on('error', end); w.on('error', end); w.on('finish', () => end(null));
    r.pipe(w);
}

/** The logs (names in dir) onto the stick's ACR_Performance/logs, one after the other. */
function copyLogs(dir, names, stick, cb) {
    const dest = path.join(stick.path, FOLDER, 'logs');
    try { mkdirs(dest); } catch (e) { return cb(e); }
    const res = { copied: 0, skipped: 0, bytes: 0, failed: 0, dest };
    let i = 0;
    const next = () => {
        if (i >= names.length) return cb(null, res);
        const n = names[i++], src = path.join(dir, n), dst = path.join(dest, n);
        let size;
        try { size = fs.statSync(src).size; } catch (e) { res.failed++; return next(); }
        try { if (fs.statSync(dst).size === size) { res.skipped++; return next(); } } catch (e) { /* not there yet */ }
        copyFile(src, dst, (err) => {
            if (err) { res.failed++; res.error = err.message; if (err.code === 'ENOSPC' || err.code === 'EROFS' || err.code === 'EACCES') return cb(err, res); }
            else { res.copied++; res.bytes += size; }
            next();
        });
    };
    next();
}

function writeConfig(stick, cfg, cb) {
    const dir = path.join(stick.path, FOLDER), file = path.join(dir, CONFIG);
    try { mkdirs(dir); } catch (e) { return cb(e); }
    const body = JSON.stringify(Object.assign({ app: APP, kind: 'ACR Performance set-up' }, cfg), null, 1) + '\n';
    fs.writeFile(file + '.part', body, (err) => {
        if (err) return cb(err);
        fs.rename(file + '.part', file, (e) => cb(e, { file }));
    });
}

function readConfig(stick, cb) {
    const file = path.join(stick.path, FOLDER, CONFIG);
    fs.readFile(file, 'utf8', (err, text) => {
        if (err) return cb(err.code === 'ENOENT' ? new Error('No ' + FOLDER + '/' + CONFIG + ' on the stick') : err);
        let cfg;
        try { cfg = JSON.parse(text); } catch (e) { return cb(new Error('The set-up file is not readable')); }
        if (!cfg || cfg.app !== APP) return cb(new Error('Not an ACR Performance set-up file'));
        cb(null, cfg);
    });
}

/** The settings worth carrying to another car: every shown one (hidden ones, such as the PIN's hash, stay). */
function exportSettings(settings) {
    const out = {};
    (settings.schema || []).forEach((s) => { if (!s.hidden) out[s.key] = settings.get(s.key); });
    return out;
}

/** Set the values this car's settings accept (a known key, a value of its kind / among its options). */
function applySettings(settings, values) {
    let n = 0;
    (settings.schema || []).forEach((s) => {
        if (s.hidden || !values || !(s.key in values)) return;
        const v = values[s.key];
        let ok = false;
        if (s.type === 'bool') ok = typeof v === 'boolean';
        else if (s.options) ok = s.options.some((o) => o[0] === v);
        else if (s.type === 'number') ok = typeof v === 'number' && isFinite(v) && (!s.steps || s.steps.indexOf(v) >= 0);
        else ok = typeof v === typeof s.default;
        if (ok && settings.get(s.key) !== v) { settings.set(s.key, v); n++; }
    });
    return n;
}

module.exports = { sticks, copyLogs, writeConfig, readConfig, exportSettings, applySettings, FOLDER, CONFIG };
