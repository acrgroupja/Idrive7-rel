'use strict';
/**
 * warnings.js - a flash limit crossed anywhere (any gauge page's tile, the Drag page's tiles) as a warning that
 * cannot be missed: a big red banner across every page of the app, and a red box on the instrument cluster.
 *
 *   const w = new Warnings({ T });
 *   w.feed(sources, now, ms)          sources: [{ key, id, A: { ahi, alo } }]; returns the warnings now
 *   w.list                            [{ id, name, v, side: 'hi' | 'lo', limit }] (one per value, the worst first)
 *   w.snooze(ms)                      tapped: the banner hides for ms (the cluster box stays)
 *   drawBanner(cv, t, list, u, T, ms, onTap)
 *
 * The cluster box goes through cluster-render (robertnisipeanu/idrive-apps, MPL-2.0; its client is
 * cluster_render_client.js): an image layer in the 'alert' class, the top of the cluster's stack, on 'panel'
 * (iDrive 7, the whole cluster 1920x720) or 'popup' (iDrive 8). Without cluster-render (not installed from the
 * MGU Store) nothing shows there and nothing fails.
 */
const { Canvas, withAlpha } = require('./kit/canvas');
let ClusterRender = null;
try { ClusterRender = require('./cluster_render_client').ClusterRender; } catch (e) { /* not bundled */ }

const BOX_W = 960, BOX_H = 180;

class Warnings {
    constructor(o) {
        this.T = o.T; this.alarms = {}; this.list = []; this.snoozed = 0;
    }
    feed(sources, now, ms) {
        const T = this.T, by = {};
        sources.forEach((s) => {
            const al = this.alarms[s.key] || (this.alarms[s.key] = new T.Alarm({ holdIn: 0, holdOut: 1500 }));
            const v = now[s.id];
            if (!al.feedLimits(v, s.A.ahi, s.A.alo, ms) || !T.isNum(v)) return;
            const side = T.isNum(s.A.ahi) && v > s.A.ahi ? 'hi' : 'lo', limit = side === 'hi' ? s.A.ahi : s.A.alo;
            const over = Math.abs(v - limit), was = by[s.id];
            if (!was || over > was.over) by[s.id] = { id: s.id, name: (T.BY_ID[s.id] || {}).name || s.id, v, side, limit, over };
        });
        this.list = Object.keys(by).map((k) => by[k]).sort((a, b) => b.over - a.over);
        if (!this.list.length) this.snoozed = 0;
        return this.list;
    }
    snooze(ms) { this.snoozed = Date.now() + ms; }
    bannerOn() { return this.list.length > 0 && Date.now() >= this.snoozed; }
}

/** "COOLANT  118 °C" and "limit 110 °C". */
function texts(w, u, T) {
    const c = T.BY_ID[w.id], unit = c && c.unit ? c.unit(u) : '', dec = T.decOf(w.id, u);
    const v = T.show(w.id, w.v, u).toFixed(dec), l = T.show(w.id, w.limit, u).toFixed(dec);
    return { name: w.name.toUpperCase(), value: v + (unit ? ' ' + unit : ''), limit: (w.side === 'hi' ? 'above ' : 'below ') + l + (unit ? ' ' + unit : '') };
}

/** The banner across the top of the page: red, blinking, big. Tapped: hidden for a minute. */
function drawBanner(cv, t, list, u, T, ms, onTap) {
    const w = list[0], x = 24, y = 44, W = 1552, H = 96, s = texts(w, u, T);
    const on = Math.floor(ms / 300) % 2 === 0;
    cv.roundRect(x - 4, y - 4, W + 8, H + 8, 12, withAlpha('#000000', 0.6));
    cv.roundRect(x, y, W, H, 10, on ? t.crit : mix(t.crit));
    cv.strokeRoundRect(x, y, W, H, 10, 4, '#ffffff');
    // a warning triangle
    const tx = x + 30, ty = y + 18;
    cv.quad([[tx + 30, ty], [tx + 60, ty + 58], [tx, ty + 58], [tx + 30, ty]], '#ffffff');
    cv.text('!', tx + 30, ty + 52, 44, on ? t.crit : mix(t.crit), { align: 'center', font: 'bold' });
    const nw = cv.text(s.name, x + 110, y + 66, 44, '#ffffff', { font: 'bold', spacing: 2 }) || cv.textWidth(s.name, 44, { font: 'bold', spacing: 2 });
    cv.text(s.value, x + 130 + nw, y + 68, 56, '#ffffff', { font: 'num' });
    const more = list.length > 1 ? '  +' + (list.length - 1) + ' more' : '';
    cv.text(s.limit + more, x + W - 24, y + 44, 24, '#ffffff', { align: 'right', font: 'bold' });
    cv.text('tap to hide for 1 min', x + W - 24, y + 78, 20, withAlpha('#ffffff', 0.8), { align: 'right' });
    if (cv.own && onTap) cv.target(x, y, W, H, onTap, 'warning');
}
function mix(c) { return withAlpha(c, 0.55); }

/** The red box on the cluster. */
class ClusterAlert {
    constructor(log, appId) {
        this.log = log; this.cr = null; this.ref = 0; this.shown = false; this.last = ''; this.at = 0; this.failed = false;
        if (!ClusterRender) { this.failed = true; return; }
        try {
            this.cr = new ClusterRender(appId);
            this.cr.on('layer', (ref, state, reason) => this.log.info('cluster warning: ' + state + (reason ? ' (' + reason + ')' : '')));
            this.cr.on('ready', () => { this.ref = 0; this.last = ''; });
            this.cr.on('error', () => {});
            this.cr.connect();
        } catch (e) { this.failed = true; this.log.warn('cluster warning: ' + e); }
    }
    /** The target this head unit's cluster offers ('panel' 1920x720, iDrive 8 'popup'), and where the box sits. */
    _place() {
        const ts = String(this.cr.targets || ''), m = /(panel|popup):(\d+)x(\d+)/.exec(ts);
        if (!m) return null;
        const W = +m[2], H = +m[3];
        return { target: m[1], x: Math.round((W - BOX_W) / 2), y: Math.round(H * 0.42 - BOX_H / 2) };
    }
    /** Show (list not empty) or hide; redrawn at most twice a second when the text changes. */
    show(list, u, T, t, ms) {
        if (this.failed || !this.cr || !this.cr.ready) return;
        try {
            if (!list.length) { if (this.shown && this.ref) this.cr.set(this.ref, { visible: false }); this.shown = false; return; }
            if (!this.ref) {
                const p = this._place();
                if (!p) return;
                this.ref = this.cr.image({ target: p.target, klass: 'alert', x: p.x, y: p.y, w: BOX_W, h: BOX_H, iw: BOX_W, ih: BOX_H, visible: false });
                this.last = '';
            }
            const s = texts(list[0], u, T), key = s.name + s.value + s.limit + list.length + (Math.floor(ms / 500) % 2);
            if (key !== this.last && ms - this.at >= 450) {
                this.last = key; this.at = ms;
                const cv = new Canvas(BOX_W, BOX_H), on = Math.floor(ms / 500) % 2 === 0;
                cv.roundRect(0, 0, BOX_W, BOX_H, 24, on ? t.crit : '#5a0d0d');
                cv.strokeRoundRect(3, 3, BOX_W - 6, BOX_H - 6, 22, 6, '#ffffff');
                cv.text(s.name + '  ' + s.value, BOX_W / 2, 92, 64, '#ffffff', { align: 'center', font: 'bold' });
                cv.text(s.limit + (list.length > 1 ? '  ·  +' + (list.length - 1) + ' more' : '') + '  ·  ACR Performance', BOX_W / 2, 146, 30, '#ffffff', { align: 'center' });
                this.cr.pixels(this.ref, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length));
            }
            if (!this.shown) { this.cr.set(this.ref, { visible: true }); this.shown = true; this.log.info('cluster warning: ' + s.name + ' ' + s.value); }
        } catch (e) { this.failed = true; this.log.warn('cluster warning: ' + e); }
    }
    close() { try { if (this.cr) this.cr.close(); } catch (e) { /* gone */ } }
}

module.exports = { Warnings, drawBanner, ClusterAlert, texts };
