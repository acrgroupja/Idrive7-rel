'use strict';
/**
 * Data logger for Gauge Log: writes samples to CSV files in <dir>.
 *
 * No drawing and no head-unit APIs here, only Node's fs and path, so this file moves to an
 * iDrive 8 version of the app unchanged. Written for Node 8 (the head unit's Node).
 *
 *   const lg = new Logger({ dir, columns, maxFiles, maxBytes, log });
 *   lg.start('demo')  -> starts a new file (log_YYYYMMDD_HHMMSS[_demo].csv)
 *   lg.add(row)       -> row = { column: value, ... }; written within a second
 *   lg.stop()         -> writes what is left and closes the file
 *   lg.status()       -> { on, file, rows, bytes, startedAt, error }
 *   lg.list()         -> the newest files first: [{ name, bytes, at }]
 *   lg.deleteAll()    -> removes every log file (not the one being written)
 *
 * Files are flushed once a second, so a sudden power cut loses at most a second.
 * A file over maxBytes is closed and a new one is started. Only the newest maxFiles are kept.
 * Never throws: a full or read-only disk is reported in status().error.
 */
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 1000;
const NAME = /^log_.*\.csv$/;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function stamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function isoLocal(d) {
    const ms = String(d.getMilliseconds());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' +
        pad(d.getSeconds()) + '.' + ('00' + ms).slice(-3);
}
/** One CSV cell: numbers rounded to `dec` places, empty for no value, text quoted when it needs it. */
function cell(v, dec) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? (dec === undefined ? String(v) : v.toFixed(dec)) : '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

class Logger {
    /**
     * opts.dir: folder for the files (made when missing). opts.columns: [{ key, title, dec }] in file order;
     * 'time' and 'elapsed_s' are added in front. opts.maxFiles (20), opts.maxBytes (20 MB), opts.log ({ info, warn }),
     * opts.clock (() => ms, for tests).
     */
    constructor(opts) {
        this.dir = opts.dir;
        this.columns = opts.columns || [];
        this.maxFiles = opts.maxFiles || 20;
        this.maxBytes = opts.maxBytes || 20 * 1024 * 1024;
        this.log = opts.log || { info() {}, warn() {} };
        this.clock = opts.clock || Date.now;
        this.fd = null; this.file = null; this.tag = ''; this.part = 0;
        this.buf = []; this.rows = 0; this.bytes = 0; this.startedAt = 0; this.error = null;
        this.timer = null;
    }

    header() {
        return ['time', 'elapsed_s'].concat(this.columns.map((c) => c.title || c.key)).join(',') + '\n';
    }

    start(tag) {
        if (this.fd !== null) return this.file;
        this.tag = tag || ''; this.part = 0;
        this.startedAt = this.clock(); this.rows = 0;
        if (!this._open()) return null;
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        if (this.timer.unref) this.timer.unref();
        this.log.info('logging to ' + this.file);
        return this.file;
    }

    _open() {
        try {
            fs.mkdirSync(this.dir);
        } catch (e) { if (e.code !== 'EEXIST') { this.error = 'cannot make ' + this.dir + ': ' + e.message; this.log.warn(this.error); return false; } }
        const base = 'log_' + stamp(new Date(this.startedAt)) + (this.tag ? '_' + this.tag : '') + (this.part ? '_' + (this.part + 1) : '');
        let name = base + '.csv', n = 2;
        while (fs.existsSync(path.join(this.dir, name))) name = base + '-' + (n++) + '.csv';
        this.file = path.join(this.dir, name);
        try {
            this.fd = fs.openSync(this.file, 'a');
            const h = this.header();
            fs.writeSync(this.fd, h);
            this.bytes = Buffer.byteLength(h);
            this.error = null;
        } catch (e) {
            this.error = 'cannot write ' + name + ': ' + e.message; this.log.warn(this.error);
            this._close();
            return false;
        }
        this.prune();
        return true;
    }

    _close() {
        if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* already gone */ } }
        this.fd = null;
    }

    add(row) {
        if (this.fd === null) return;
        const now = this.clock();
        const cells = [isoLocal(new Date(now)), ((now - this.startedAt) / 1000).toFixed(2)];
        for (let i = 0; i < this.columns.length; i++) cells.push(cell(row[this.columns[i].key], this.columns[i].dec));
        this.buf.push(cells.join(','));
        this.rows++;
    }

    flush() {
        if (this.fd === null || !this.buf.length) return;
        const text = this.buf.join('\n') + '\n';
        this.buf = [];
        try {
            fs.writeSync(this.fd, text);
            this.bytes += Buffer.byteLength(text);
            this.error = null;
        } catch (e) {
            this.error = 'write failed: ' + e.message; this.log.warn(this.error);
            return;
        }
        if (this.bytes >= this.maxBytes) {
            this._close();
            this.part++;
            this._open();
        }
    }

    stop() {
        if (this.fd === null) return;
        this.flush();
        this._close();
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.log.info('logged ' + this.rows + ' rows to ' + this.file);
        this.file = null;
    }

    status() {
        return { on: this.fd !== null, file: this.file ? path.basename(this.file) : null, rows: this.rows, bytes: this.bytes,
            startedAt: this.startedAt, error: this.error };
    }

    list() {
        let names = [];
        try { names = fs.readdirSync(this.dir).filter((n) => NAME.test(n)); } catch (e) { return []; }
        return names.map((n) => {
            try { const st = fs.statSync(path.join(this.dir, n)); return { name: n, bytes: st.size, at: st.mtime.getTime() }; } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
    }

    /** Keeps the newest maxFiles; never removes the file being written. */
    prune() {
        const cur = this.file && path.basename(this.file);
        this.list().filter((f) => f.name !== cur).slice(Math.max(0, this.maxFiles - (cur ? 1 : 0))).forEach((f) => {
            try { fs.unlinkSync(path.join(this.dir, f.name)); } catch (e) { /* gone */ }
        });
    }

    deleteAll() {
        const cur = this.file && path.basename(this.file);
        let n = 0;
        this.list().forEach((f) => { if (f.name !== cur) { try { fs.unlinkSync(path.join(this.dir, f.name)); n++; } catch (e) { /* gone */ } } });
        return n;
    }
}

module.exports = Logger;
module.exports.cell = cell;
