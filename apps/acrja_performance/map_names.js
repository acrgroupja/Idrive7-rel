'use strict';
/**
 * map_names.js - the owner's names for engine maps 1-4 (Tune page), and the head unit sheet that renames them.
 *
 *   const names = new MapNames(file, log);   names.get(2) -> 'Race' or ''    names.label(2) -> 'Race' / 'Map 2'
 *   ctx.sheet(renameSheet({ names, start: 2, locked: () => moving, onDone() }))
 *
 * The sheet: Map 1-4 to pick which one, the name being typed, quick picks (Stock, Street, ...), an on-screen keyboard,
 * Cancel / Save. Touch and the iDrive controller (turn to move, press to type). Saved in map_names.json (dataDir).
 */
const fs = require('fs');
const { withAlpha } = require('./kit/canvas');

const MAX = 14;
const PRESETS = ['Stock', 'Street', 'Sport', 'Track', 'Race', 'E85', 'Pump', 'Valet'];
const ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL-', 'ZXCVBNM.+/'];
const clean = (s) => String(s || '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').replace(/^ /, '').slice(0, MAX);

class MapNames {
    constructor(file, log) {
        this.file = file; this.log = log || { warn() {} }; this.names = {};
        try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); [1, 2, 3, 4].forEach((n) => { if (d[n]) this.names[n] = clean(d[n]).trim(); }); } catch (e) { /* none yet */ }
    }
    get(n) { return this.names[n] || ''; }
    label(n) { return this.get(n) || 'Map ' + n; }
    setAll(m) {
        [1, 2, 3, 4].forEach((n) => { const v = clean(m[n]).trim(); if (v) this.names[n] = v; else delete this.names[n]; });
        try { fs.writeFileSync(this.file, JSON.stringify(this.names)); } catch (e) { this.log.warn('map names: ' + e.message); }
    }
}

/** The rename sheet (sheet.js contract: draw / move / press / back / title). */
function renameSheet(o) {
    const draft = { 1: o.names.get(1), 2: o.names.get(2), 3: o.names.get(3), 4: o.names.get(4) };
    const S = {
        title: 'Rename maps', map: o.start >= 1 && o.start <= 4 ? o.start : 1, caps: true, focus: 0, controller: false, items: [],
        text() { return draft[this.map]; },
        type(ch) {
            let s = draft[this.map];
            if (s.length >= MAX) return;
            const c = this.caps ? ch : ch.toLowerCase();
            draft[this.map] = s + c;
            if (this.caps && /[A-Z]/.test(ch) && this.autoCaps) { this.caps = false; this.autoCaps = false; }
        },
        save() { o.names.setAll(draft); if (o.onDone) o.onDone(); return 'close'; },
        cancel() { if (o.onDone) o.onDone(); return 'close'; },
        /** Every touchable thing, in controller order: [{ x, y, w, h, label, act, lit, kind }]. */
        layout() {
            const it = [];
            for (let n = 1; n <= 4; n++) it.push({ x: 380 + (n - 1) * 132, y: 56, w: 124, h: 44, label: 'Map ' + n, lit: n === this.map, act: () => { this.map = n; this.caps = !draft[n]; this.autoCaps = !draft[n]; } });
            it.push({ x: 1556 - 300 - 12, y: 56, w: 150, h: 44, label: 'Cancel', act: () => this.cancel() });
            it.push({ x: 1556 - 150, y: 56, w: 150, h: 44, label: 'Save', lit: true, act: () => this.save() });
            const pw = (1556 - 760 - 7 * 8) / 8;
            PRESETS.forEach((p, i) => it.push({ x: Math.round(760 + i * (pw + 8)), y: 114, w: Math.round(pw), h: 48, label: p, small: true, act: () => { draft[this.map] = p; } }));
            const kw = (1512 - 9 * 8) / 10, kh = 58;
            ROWS.forEach((row, r) => row.split('').forEach((ch, i) => it.push({ x: Math.round(44 + i * (kw + 8)), y: 176 + r * (kh + 8), w: Math.round(kw), h: kh,
                label: this.caps ? ch : ch.toLowerCase(), act: () => this.type(ch) })));
            const u = (1512 - 3 * 8) / 10, y5 = 176 + 4 * (kh + 8);
            it.push({ x: 44, y: y5, w: Math.round(2 * u), h: kh, label: this.caps ? 'ABC' : 'abc', lit: this.caps, act: () => { this.caps = !this.caps; this.autoCaps = false; } });
            it.push({ x: Math.round(44 + 2 * u + 8), y: y5, w: Math.round(4 * u), h: kh, label: 'Space', act: () => this.type(' ') });
            it.push({ x: Math.round(44 + 6 * u + 16), y: y5, w: Math.round(2 * u), h: kh, label: 'Delete', act: () => { draft[this.map] = draft[this.map].slice(0, -1); } });
            it.push({ x: Math.round(44 + 8 * u + 24), y: y5, w: Math.round(2 * u), h: kh, label: 'Clear', act: () => { draft[this.map] = ''; this.caps = true; this.autoCaps = true; } });
            return it;
        },
        draw(r, t) {
            r.clear(t.bg);
            const C = t.sel || t.accent;
            if (o.locked && o.locked()) {
                r.text('Stop the car to rename maps', 800, 250, 40, t.text, { align: 'center', font: 'bold' });
                r.roundRect(690, 330, 220, 56, 28, withAlpha(C, 0.9));
                r.text('Close', 800, 367, 24, '#ffffff', { align: 'center', font: 'bold' });
                this.items = [{ x: 690, y: 330, w: 220, h: 56, act: () => this.cancel() }];
                return this.items.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h, act: q.act }));
            }
            r.text('Rename maps', 44, 90, 32, t.text, { font: 'bold' });
            // the name being typed, with a caret
            r.roundRect(44, 114, 696, 48, 10, withAlpha('#ffffff', 0.06));
            r.strokeRoundRect(44, 114, 696, 48, 10, 2, C);
            const s = this.text(), w = s ? r.textWidth(s, 30, { font: 'bold' }) : 0;
            if (s) r.text(s, 62, 149, 30, t.text, { font: 'bold' });
            else r.text('Map ' + this.map + ' (no name)', 62, 147, 22, t.dim, { font: 'label' });
            if (Math.floor(Date.now() / 500) % 2 === 0) r.fillRect(64 + w, 124, 3, 30, C);
            r.text(s.length + ' / ' + MAX, 724, 147, 17, t.dim, { align: 'right', font: 'label' });
            this.items = this.layout();
            this.focus = Math.max(0, Math.min(this.items.length - 1, this.focus));
            this.items.forEach((q, i) => {
                const f = this.controller && i === this.focus;
                r.roundRect(q.x, q.y, q.w, q.h, 10, q.lit ? withAlpha(C, 0.9) : withAlpha('#ffffff', 0.08));
                r.strokeRoundRect(q.x, q.y, q.w, q.h, 10, f ? 3 : 1.5, f ? '#ffffff' : q.lit ? C : withAlpha('#ffffff', 0.22));
                r.text(q.label, q.x + q.w / 2, q.y + q.h / 2 + (q.small ? 7 : 9), q.small ? 20 : 26, q.lit ? '#ffffff' : t.text, { align: 'center', font: 'bold' });
            });
            return this.items.map((q) => ({ x: q.x - 2, y: q.y - 2, w: q.w + 4, h: q.h + 4, act: () => { q.act(); return q.label === 'Save' || q.label === 'Cancel' ? 'close' : null; } }));
        },
        move(d) { this.controller = true; this.focus = Math.max(0, Math.min((this.items.length || 1) - 1, this.focus + d)); },
        press() {
            this.controller = true;
            const q = this.items[this.focus];
            if (!q) return null;
            const v = q.act();
            return v === 'close' ? 'close' : null;
        },
        back() { return this.cancel(); },
    };
    S.caps = !draft[S.map]; S.autoCaps = !draft[S.map];
    return S;
}

module.exports = { MapNames, renameSheet, PRESETS, MAX, clean };
