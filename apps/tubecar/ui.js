'use strict';
/**
 * ui.js - TubeCar's pages, drawn on the kit's canvas (1600 x 520 logical px, page between G.TOP and the page's
 * bottom). Everything pressable is a page target (cv.target): a tap, the iDrive controller where the kit runs the
 * screen, or the bar's Prev / Next / Select where it does not (main.js moves a focus of its own then, drawn here).
 *
 *   ui.draw(cv, t, m)   m: the app's state and actions (main.js model())
 */
const G = require('./kit/gauges');

const W = 1600;
const TABS = ['Search', 'Results', 'Player', 'Wi-Fi'];
const ROWS_PER_PAGE = 5;

/* ---------------- text ---------------- */

/** The kit's fonts are ASCII (and a few signs): fold accents (ă -> a, ș -> s), quotes and dashes, drop the rest. */
function fold(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFD'); } catch (e) { /* no ICU data: as it is */ }
    return s.replace(/[̀-ͯ]/g, '').replace(/[‘’‚′]/g, '\'').replace(/[“”„″]/g, '"')
        .replace(/[‐-―]/g, '-').replace(/…/g, '...').replace(/[  -​]/g, ' ')
        .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd')
        .replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}
function txt(cv, s, x, y, size, color, o) { return cv.text(fold(s), x, y, size, color, Object.assign({ literal: true }, o || {})); }
/** s cut to fit w px, with "..." */
function fit(cv, s, w, size, o) {
    s = fold(s);
    const opt = Object.assign({ literal: true }, o || {});
    if (cv.textWidth(s, size, opt) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, opt) <= w) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}
/** s in lines of at most w px, at most n lines (the last cut with "..."). */
function wrap(cv, s, w, size, n, o) {
    const words = fold(s).split(' ').filter(Boolean), lines = [], opt = Object.assign({ literal: true }, o || {});
    let cur = '';
    for (let i = 0; i < words.length; i++) {
        const tryLine = cur ? cur + ' ' + words[i] : words[i];
        if (cv.textWidth(tryLine, size, opt) <= w) { cur = tryLine; continue; }
        if (cur) lines.push(cur);
        cur = words[i];
        if (lines.length === n - 1) { cur = words.slice(i).join(' '); break; }
    }
    if (cur) lines.push(cur);
    if (lines.length > n) lines.length = n;
    if (lines.length) lines[lines.length - 1] = fit(cv, lines[lines.length - 1], w, size, o);
    return lines;
}
function time(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}

/* ---------------- widgets ---------------- */

/** A button on the page, drawn in every layout (G.button draws only where the kit runs the screen). */
function btn(cv, t, x, y, w, h, label, run, o) {
    o = o || {};
    const S = t.sel || t.accent, c = o.color || S;
    cv.roundRect(x, y, w, h, Math.min(14, h / 2), o.primary ? G.withAlpha(c, o.busy ? 0.35 : 0.85) : G.withAlpha('#ffffff', o.busy ? 0.03 : 0.08));
    if (!o.primary) cv.strokeRoundRect(x, y, w, h, Math.min(14, h / 2), 1.5, G.withAlpha(o.color || '#ffffff', o.busy ? 0.15 : 0.32));
    const size = o.size || Math.min(26, h * 0.42);
    txt(cv, fit(cv, label, w - 16, size, { font: 'bold' }), x + w / 2, y + h / 2 + size * 0.36, size, o.primary ? '#ffffff' : o.busy ? t.dim : o.color || t.text, { align: 'center', font: 'bold' });
    if (run && !o.busy) cv.target(x, y, w, h, run, o.key || label, Math.min(14, h / 2));
}
function panel(cv, t, x, y, w, h) {
    cv.roundRect(x, y, w, h, 16, t.panelBottom || '#0d0d10');
    cv.strokeRoundRect(x, y, w, h, 16, 1, t.panelEdge || '#2a2b31');
}
function toneColor(t, tone) { return tone === 'ok' ? (t.cold || t.accent2) : tone === 'warn' ? t.warn : tone === 'crit' ? t.crit : t.dim; }

/* ---------------- pages ---------------- */

function draw(cv, t, m) {
    const badges = [];
    if (m.net && m.net.checked && !m.net.online) badges.push({ text: 'OFFLINE' });
    if (m.player.state === 'playing' && m.tab !== 2) badges.push({ text: 'PLAYING' });
    G.frame(cv, t, TABS, m.tab, badges);
    const top = G.TOP + 10, bottom = G.pageBottom(cv);
    if (m.tab === 0) pageSearch(cv, t, m, top, bottom);
    else if (m.tab === 1) pageResults(cv, t, m, top, bottom);
    else if (m.tab === 2) pagePlayer(cv, t, m, top, bottom);
    else pageWifi(cv, t, m, top, bottom);
    // the bar's Prev / Next / Select move this focus where the kit does not run the screen
    if (!cv.own && m.focusKey) {
        const f = cv.targets.find((q) => q.key === m.focusKey);
        if (f) cv.strokeRoundRect(f.x - 4, f.y - 4, f.w + 8, f.h + 8, (f.r || 10) + 4, 4, t.sel || t.accent);
    }
}

function keyboard(cv, t, m, kb, top, o) {
    // the field
    const fx = 40, fw = o.fieldW || 1060, fh = 62;
    panel(cv, t, fx, top, fw, fh);
    const shown = kb.shown();
    if (shown) txt(cv, fit(cv, shown, fw - 40, 30, { font: 'bold' }) + (Date.now() % 1000 < 600 ? '_' : ''), fx + 20, top + 42, 30, t.text, { font: 'bold' });
    else txt(cv, o.placeholder || '', fx + 20, top + 42, 28, t.dim);
    let bx = fx + fw + 20;
    btn(cv, t, bx, top, 220, fh, o.okLabel || 'OK', o.onOk, { primary: true, key: 'kb:ok', busy: o.okBusy });
    bx += 240;
    if (o.onCancel) btn(cv, t, bx, top, 200, fh, 'Cancel', o.onCancel, { key: 'kb:cancel' });
    // the keys
    const unit = 101, gap = 7, rh = 60, rgap = 8;
    let y = top + fh + 18;
    kb.rows().forEach((row) => {
        let x = fx;
        row.forEach((k) => {
            const w = k.w * unit + (k.w - 1) * gap;
            const special = k.id.indexOf('k:') !== 0;
            cv.roundRect(x, y, w, rh, 10, G.withAlpha('#ffffff', special ? 0.12 : 0.07));
            const size = special ? 22 : 30;
            txt(cv, k.label, x + w / 2, y + rh / 2 + size * 0.36, size, special ? t.dim : t.text, { align: 'center', font: special ? 'bold' : 'label' });
            cv.target(x, y, w, rh, () => m.act.key(k.id), 'key:' + k.id, 10);
            x += w + gap;
        });
        y += rh + rgap;
    });
    return { right: fx + 10 * unit + 9 * gap };
}

function pageSearch(cv, t, m, top, bottom) {
    const k = keyboard(cv, t, m, m.kb, top, {
        placeholder: 'Search YouTube', okLabel: m.searching ? 'Searching' : 'Search', okBusy: m.searching || !m.kb.text.trim(),
        onOk: () => m.act.search(), fieldW: 1060,
    });
    // recent searches, beside the keys
    const x = k.right + 30, w = W - 40 - x;
    let y = top + 80;
    txt(cv, 'RECENT', x, y + 4, 18, t.dim, { font: 'bold', spacing: 2 });
    y += 16;
    const recent = (m.recent || []).slice(0, 5);
    if (!recent.length) txt(cv, 'Nothing yet', x, y + 40, 22, t.dim);
    recent.forEach((q, i) => {
        btn(cv, t, x, y + i * 68, w, 58, q, () => m.act.search(q), { key: 'recent:' + i, size: 22 });
    });
    if (m.netMsg && !m.net.online) txt(cv, fit(cv, m.netMsg.message, W - 80, 20), 40, bottom - 4, 20, toneColor(t, m.netMsg.tone));
}

function pageResults(cv, t, m, top, bottom) {
    const r = m.results;
    if (!r || (!r.items.length && !r.loading)) {
        txt(cv, r && r.error ? r.error : 'Search for something first.', W / 2, (top + bottom) / 2, 28, r && r.error ? t.warn : t.dim, { align: 'center' });
        if (!r || r.error) btn(cv, t, W / 2 - 150, (top + bottom) / 2 + 40, 300, 60, 'Search', () => m.act.tab(0), { key: 'res:gosearch' });
        return;
    }
    const pages = Math.max(1, Math.ceil(r.items.length / ROWS_PER_PAGE));
    const page = Math.min(m.resPage, pages - 1);
    const rowH = 74, x = 40, w = W - 80;
    txt(cv, fit(cv, 'Results for "' + r.q + '"', 1000, 20, { font: 'bold' }), x, top + 14, 20, t.dim, { font: 'bold' });
    let y = top + 24;
    r.items.slice(page * ROWS_PER_PAGE, page * ROWS_PER_PAGE + ROWS_PER_PAGE).forEach((it) => {
        const playing = m.player.title && m.nowId === it.id;
        cv.roundRect(x, y, w, rowH - 6, 12, G.withAlpha('#ffffff', playing ? 0.12 : 0.05));
        txt(cv, fit(cv, it.title, w - 200, 26, { font: 'bold' }), x + 20, y + 30, 26, t.text, { font: 'bold' });
        const meta = [it.channel, it.views, it.age].filter(Boolean).join('  |  ');
        txt(cv, fit(cv, meta, w - 200, 20), x + 20, y + 56, 20, t.dim);
        if (it.duration) txt(cv, it.duration, x + w - 24, y + 43, 26, playing ? (t.sel || t.accent) : t.text, { align: 'right', font: 'bold' });
        cv.target(x, y, w, rowH - 6, () => m.act.play(it), 'res:' + it.id, 12);
        y += rowH;
    });
    const by = bottom - 54, bh = 50;
    btn(cv, t, x, by, 220, bh, 'Previous', page > 0 ? () => m.act.resPage(-1) : null, { key: 'res:prev', busy: page === 0 });
    txt(cv, 'Page ' + (page + 1) + ' of ' + pages + (r.continuation ? '+' : ''), x + 360, by + 34, 22, t.dim, { align: 'center' });
    const more = page >= pages - 1 && r.continuation;
    btn(cv, t, x + 500, by, 260, bh, r.loading ? 'Loading...' : more ? 'More results' : 'Next', (page < pages - 1 || more) && !r.loading ? () => m.act.resPage(1) : null,
        { key: 'res:next', busy: r.loading || !(page < pages - 1 || more) });
    if (r.error) txt(cv, fit(cv, r.error, 700, 20), x + 800, by + 34, 20, t.warn);
}

function pagePlayer(cv, t, m, top, bottom) {
    const v = m.player;
    const vx = 40, vy = top + 4, vw = 768, vh = 432;
    // the picture box: black, the video over it where it may be shown
    cv.roundRect(vx, vy, vw, vh, 14, '#000000');
    if (v.video) cv.video(v.video.id, vx, vy, vw, vh, 14);
    else {
        cv.strokeRoundRect(vx, vy, vw, vh, 14, 1, t.panelEdge || '#2a2b31');
        const why = v.state === 'idle' ? 'Pick a video in Search or Results.' : v.videoWhy || '';
        wrap(cv, why, vw - 80, 26, 3).forEach((line, i) => txt(cv, line, vx + vw / 2, vy + vh / 2 - 10 + i * 36, 26, t.dim, { align: 'center' }));
    }
    if (v.state === 'playing' || v.state === 'paused') cv.target(vx, vy, vw, vh, () => m.act.toggle(), 'pl:picture', 14);
    // the side
    const x = vx + vw + 40, w = W - 40 - x;
    let y = top + 36;
    const lines = wrap(cv, v.title || (v.state === 'idle' ? 'Nothing playing' : ''), w, 30, 2, { font: 'bold' });
    lines.forEach((l, i) => txt(cv, l, x, y + i * 38, 30, t.text, { font: 'bold' }));
    y += lines.length * 38 + 4;
    if (v.channel) txt(cv, fit(cv, v.channel, w, 22), x, y, 22, t.dim);
    y += 40;
    const stateText = v.state === 'resolving' ? v.msg : v.state === 'loading' ? (v.msg || 'Loading') + ' ' + (v.pct || 0) + '%'
        : v.state === 'playing' ? (v.buffering ? 'Playing (picture waiting for the download)' : 'Playing') : v.state === 'paused' ? (v.msg || 'Paused')
        : v.state === 'ended' ? 'Ended' : v.state === 'error' ? v.msg : '';
    wrap(cv, stateText, w, 22, v.state === 'error' ? 3 : 1).forEach((l, i) => txt(cv, l, x, y + i * 28, 22, v.state === 'error' ? t.crit : (t.sel || t.accent), { font: 'bold' }));
    y += v.state === 'error' ? 96 : 34;
    // progress
    const dur = v.durMs || 0, posMs = v.posMs || 0, frac = dur ? Math.max(0, Math.min(1, posMs / dur)) : 0;
    cv.roundRect(x, y, w, 10, 5, t.track || '#222');
    if (v.state === 'loading') cv.roundRect(x, y, w * (v.pct || 0) / 100, 10, 5, G.withAlpha(t.dim, 0.6));
    else if (frac > 0) cv.roundRect(x, y, Math.max(10, w * frac), 10, 5, t.sel || t.accent);
    y += 40;
    txt(cv, time(posMs) + (dur ? ' / ' + time(dur) : ''), x, y, 24, t.text, { font: 'bold' });
    if (v.loadedPct && v.loadedPct < 100 && (v.state === 'playing' || v.state === 'paused')) txt(cv, 'picture loaded ' + v.loadedPct + '%', x + w, y, 18, t.dim, { align: 'right' });
    y += 24;
    // controls
    const can = v.state === 'playing' || v.state === 'paused';
    const bw = (w - 4 * 12) / 5, bh = 64;
    btn(cv, t, x, y, bw, bh, '-60 s', can ? () => m.act.skip(-60000) : null, { key: 'pl:b60', busy: !can });
    btn(cv, t, x + (bw + 12), y, bw, bh, '-10 s', can ? () => m.act.skip(-10000) : null, { key: 'pl:b10', busy: !can });
    const playLabel = v.state === 'playing' ? 'Pause' : v.state === 'ended' ? 'Again' : 'Play';
    btn(cv, t, x + 2 * (bw + 12), y, bw, bh, playLabel, can || v.state === 'ended' ? () => m.act.toggle() : null, { key: 'pl:toggle', primary: true, busy: !(can || v.state === 'ended') });
    btn(cv, t, x + 3 * (bw + 12), y, bw, bh, '+10 s', can ? () => m.act.skip(10000) : null, { key: 'pl:f10', busy: !can });
    btn(cv, t, x + 4 * (bw + 12), y, bw, bh, '+60 s', can ? () => m.act.skip(60000) : null, { key: 'pl:f60', busy: !can });
    y += bh + 16;
    const active = v.state !== 'idle' && v.state !== 'error';
    btn(cv, t, x, y, 220, 54, 'Stop', active ? () => m.act.stop() : null, { key: 'pl:stop', busy: !active });
    const notes = [v.soundWhy, v.slow ? 'The head unit cannot decode the picture fast enough: pictures are left out.' : ''].filter(Boolean);
    notes.forEach((n, i) => wrap(cv, n, w - 240, 18, 2).forEach((l, j) => txt(cv, l, x + 240, y + 22 + (i * 2 + j) * 22, 18, t.warn)));
}

function pageWifi(cv, t, m, top, bottom) {
    const wv = m.wifi;
    if (wv.editing) {
        keyboard(cv, t, m, wv.kb, top, {
            placeholder: wv.editing === 'ssid' ? 'Wi-Fi network name (SSID)' : 'Wi-Fi password',
            okLabel: 'Done', onOk: () => m.act.wifiDone(), onCancel: () => m.act.wifiCancel(), fieldW: 1040,
        });
        return;
    }
    const x = 40, w = W - 80;
    // status
    panel(cv, t, x, top, w, 112);
    txt(cv, 'INTERNET', x + 24, top + 32, 18, t.dim, { font: 'bold', spacing: 2 });
    const msg = m.netMsg || { message: m.net.checking ? 'Checking...' : 'Not checked yet.', tone: 'info' };
    wrap(cv, msg.message, w - 260, 22, 2).forEach((l, i) => txt(cv, l, x + 24, top + 64 + i * 28, 22, toneColor(t, msg.tone)));
    btn(cv, t, x + w - 220, top + 30, 196, 54, m.net.checking ? 'Checking' : 'Check again', m.net.checking ? null : () => m.act.netCheck(), { key: 'wf:check', busy: m.net.checking });
    // the saved network
    let y = top + 130;
    const row = (label, value, edit, key, action) => {
        panel(cv, t, x, y, w, 66);
        txt(cv, label, x + 24, y + 42, 22, t.dim);
        txt(cv, fit(cv, value || '(not set)', w - 640, 26, { font: 'bold' }), x + 360, y + 43, 26, value ? t.text : t.dim, { font: 'bold' });
        if (edit) btn(cv, t, x + w - 220, y + 8, 196, 50, action || 'Edit', edit, { key });
        y += 76;
    };
    row('Network (SSID)', wv.ssid, () => m.act.wifiEdit('ssid'), 'wf:ssid');
    row('Password', wv.psk ? '*'.repeat(Math.min(16, wv.psk.length)) : (wv.ssid ? '(open network)' : ''), () => m.act.wifiEdit('psk'), 'wf:psk');
    row('Connect automatically at start', wv.auto ? 'On' : 'Off', () => m.act.wifiAuto(), 'wf:auto', wv.auto ? 'Turn off' : 'Turn on');
    const dirty = wv.dirty;
    btn(cv, t, x, y + 4, 300, 56, 'Save and connect', wv.ssid && !wv.busy ? () => m.act.wifiSave() : null, { key: 'wf:save', primary: true, busy: !wv.ssid || wv.busy });
    btn(cv, t, x + 320, y + 4, 200, 56, 'Forget', wv.savedSsid ? () => m.act.wifiForget() : null, { key: 'wf:forget', busy: !wv.savedSsid });
    if (wv.error) txt(cv, fit(cv, wv.error, w - 560, 20), x + 540, y + 40, 20, t.crit);
    else if (dirty) txt(cv, 'Not saved yet', x + 540, y + 40, 20, t.warn);
    txt(cv, fit(cv, 'Only the MGU Store may join a Wi-Fi network on this car; TubeCar asks it when offline. A network joined once is joined again by the car itself.', w, 18), x, bottom - 4, 18, t.dim);
}

module.exports = { draw, fold, fit, wrap, time, TABS, ROWS_PER_PAGE };
