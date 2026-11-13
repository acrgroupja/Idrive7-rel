'use strict';
/**
 * usb_ui.js - Files page > USB stick: copy the logs to a stick, and export / import the set-up (a sheet).
 *
 *   ctx.sheet(usbSheet({ usb, logs: () => { dir, names, recording }, exportCfg: () => cfg, importCfg: (cfg) => text,
 *       canImport: () => null or why not, onDone }))
 * The work runs in the background; the sheet shows where it is. Import asks for a second tap (it replaces this car's set-up).
 */
const { withAlpha } = require('./kit/canvas');

const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' kB');

function usbSheet(o) {
    const S = {
        title: 'USB stick', list: [], seen: 0, busy: null, msg: null, bad: false, arm: 0,
        stick() { return this.list.find((s) => !s.ro) || this.list[0] || null; },
        say(text, bad) { this.msg = text; this.bad = !!bad; },
        copy() {
            const st = this.stick();
            if (!st || this.busy) return null;
            if (st.ro) return this.say('The stick is read-only. Use another one (FAT32 or exFAT).', true);
            const L = o.logs();
            if (!L.names.length) return this.say(L.recording ? 'Only the log being recorded now: stop it first.' : 'No logs to copy yet.', true);
            this.busy = 'Copying ' + L.names.length + ' log' + (L.names.length > 1 ? 's' : '') + '...';
            o.usb.copyLogs(L.dir, L.names, st, (err, r) => {
                this.busy = null;
                r = r || { copied: 0, skipped: 0, bytes: 0 };
                if (err && !r.copied) return this.say('Could not copy: ' + why(err), true);
                const parts = [r.copied + ' copied (' + mb(r.bytes) + ')'];
                if (r.skipped) parts.push(r.skipped + ' already on the stick');
                if (r.failed) parts.push(r.failed + ' failed' + (err ? ': ' + why(err) : ''));
                this.say(parts.join(', ') + '. In ' + o.usb.FOLDER + '/logs' + (L.recording ? '  (the log being recorded is left out)' : ''), !!r.failed);
            });
            return null;
        },
        exp() {
            const st = this.stick();
            if (!st || this.busy) return null;
            if (st.ro) return this.say('The stick is read-only. Use another one (FAT32 or exFAT).', true);
            this.busy = 'Saving the set-up...';
            o.usb.writeConfig(st, o.exportCfg(), (err) => {
                this.busy = null;
                if (err) return this.say('Could not save: ' + why(err), true);
                this.say('Set-up saved: ' + o.usb.FOLDER + '/' + o.usb.CONFIG + '. Plug the stick into the other car and Import there.');
            });
            return null;
        },
        imp() {
            const st = this.stick();
            if (!st || this.busy) return null;
            const no = o.canImport && o.canImport();
            if (no) return this.say(no, true);
            if (Date.now() - this.arm > 5000) { this.arm = Date.now(); return this.say('This replaces this car\'s tiles, pages, settings and map names. Tap Import again.'); }
            this.arm = 0;
            this.busy = 'Reading the set-up...';
            o.usb.readConfig(st, (err, cfg) => {
                this.busy = null;
                if (err) return this.say(why(err), true);
                try { this.say(o.importCfg(cfg)); } catch (e) { this.say('Could not import: ' + e.message, true); }
            });
            return null;
        },
        draw(r, t) {
            r.clear(t.bg);
            if (Date.now() - this.seen > 1500) { this.list = o.usb.sticks(); this.seen = Date.now(); }
            const st = this.stick(), targets = [];
            r.text('USB stick', 44, 90, 32, t.text, { font: 'bold' });
            r.text('Copy the logs, or carry the set-up to another car', 44, 120, 18, t.dim, { font: 'label' });
            const pill = (x, label, act) => {
                r.roundRect(x, 56, 150, 46, 23, withAlpha('#ffffff', 0.08));
                r.strokeRoundRect(x, 56, 150, 46, 23, 1.5, withAlpha('#ffffff', 0.25));
                r.text(label, x + 75, 86, 22, t.text, { align: 'center', font: 'bold' });
                targets.push({ x: x - 6, y: 50, w: 162, h: 58, act });
            };
            pill(1556 - 150, 'Close', () => { if (o.onDone) o.onDone(); return 'close'; });
            // the stick
            r.text('STICK', 44, 176, 18, t.dim, { font: 'bold', spacing: 1.5 });
            if (!st) {
                r.text('No USB stick found', 44, 216, 28, t.warn, { font: 'bold' });
                r.text('Plug one into the car\'s USB port (FAT32 or exFAT). It shows here within a few seconds.', 44, 248, 18, t.dim, { font: 'label' });
            } else {
                r.text(st.label, 44, 216, 28, t.text, { font: 'bold' });
                r.text(st.path + (st.ro ? '  ·  read-only' : '') + (this.list.length > 1 ? '  ·  ' + this.list.length + ' sticks, using this one' : ''), 44, 248, 18, st.ro ? t.crit : t.dim, { font: 'label' });
            }
            // the three actions
            const L = o.logs(), off = !st || !!this.busy;
            const card = (x, head, sub, act, accent) => {
                const w = 480, y = 290, h = 120;
                r.roundRect(x, y, w, h, 14, withAlpha('#ffffff', off ? 0.03 : 0.07));
                r.strokeRoundRect(x, y, w, h, 14, 1.5, off ? withAlpha('#ffffff', 0.12) : accent);
                r.text(head, x + 24, y + 50, 28, off ? t.dim : t.text, { font: 'bold' });
                r.text(sub, x + 24, y + 86, 18, t.dim, { font: 'label' });
                if (!off) targets.push({ x, y, w, h, act });
            };
            card(44, 'Copy logs', L.names.length + ' file' + (L.names.length === 1 ? '' : 's') + ' to ' + o.usb.FOLDER + '/logs', () => this.copy(), t.accent);
            card(44 + 504, 'Export set-up', 'Tiles, pages, settings, map names', () => this.exp(), t.accent2 || t.accent);
            card(44 + 1008, Date.now() - this.arm < 5000 ? 'Tap to confirm' : 'Import set-up', 'From ' + o.usb.FOLDER + ' on the stick (parked)', () => this.imp(), t.warn);
            // where it is
            const line = this.busy || this.msg;
            if (line) r.text(line, 44, 458, 20, this.busy ? t.text : this.bad ? t.crit : '#2fd27a', { font: 'label' });
            r.text('The PIN for the Tune page stays on each car. The stick may be pulled once a message shows here.', 44, 492, 16, t.dim, { font: 'label' });
            return targets;
        },
        move() {}, press() { return null; }, back() { if (o.onDone) o.onDone(); return 'close'; },
    };
    return S;
}

function why(e) {
    const c = e && e.code;
    if (c === 'EROFS') return 'the stick is read-only';
    if (c === 'ENOSPC') return 'the stick is full';
    if (c === 'EACCES' || c === 'EPERM') return 'the app is not allowed to write to the stick';
    if (c === 'ENOENT' || c === 'EIO') return 'the stick went away';
    return (e && e.message) || String(e);
}

module.exports = { usbSheet, why };
