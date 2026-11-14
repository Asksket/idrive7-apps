'use strict';
/**
 * TubeCar - an unofficial YouTube client for the BMW MGU (iDrive 7) head unit, on the idrive7-apps kit.
 *
 * Pages: Search (on-screen keyboard, recent searches), Results, Player, Wi-Fi.
 * Sound: the car's media player (audio.js). Picture: decoded by a child process (decoder_child.js) into the GPU
 * renderer's video layer, only while the car is parked (player.js). Internet: the MGU Store's uplink (net.js, wifi.js).
 *
 * Leaving the screen: the decoder process is killed, the render loop stopped, the picture's buffers let go; the
 * sound goes on unless the setting says otherwise (then everything stops). The app's exit stops everything.
 * A memory watchdog stops playback at 70 % of the app's memory limit (watchdog.js).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Parked = require('./kit/parked');
const net = require('./net');
const yt = require('./yt');
const ui = require('./ui');
const wifi = require('./wifi');
const { Keyboard } = require('./keyboard');
const { CarAudio } = require('./audio');
const { Player, sweepMedia } = require('./player');
const { Watchdog, limitKB } = require('./watchdog');

const W = 1600, H = 520;
const RECHECK_OFFLINE_MS = 30000;

mgu.run({
    async start(ctx) {
        const log = ctx.log, ui0 = ctx.ui, settings = ctx.settings;
        net.init(ctx.dataDir);
        sweepMedia(log);                                   // what a run that died left in /dev/shm

        /* ---------------- state ---------------- */
        const st = {
            tab: 0, kb: new Keyboard({ max: 100 }), recent: loadRecent(ctx.dataDir),
            results: null, resPage: 0, searching: false, nowId: null,
            net: { checked: false, online: false, checking: false }, netMsg: null,
            focusKey: null, targets: [],
        };
        const cfg = new wifi.WifiConfig(ctx.dataDir, log);
        const wv = { ssid: cfg.ssid, psk: cfg.psk, auto: cfg.auto, savedSsid: cfg.ssid, editing: null, kb: null, dirty: false, busy: false, error: null };
        const region = () => { const r = String(settings.get('region') || 'en-US').split('-'); return { hl: r[0] || 'en', gl: r[1] || 'US' }; };

        /* ---------------- the car ---------------- */
        const audio = new CarAudio(ctx.signals, log, ctx.dataDir);
        if (audio.available()) audio.init().then(() => log.info('audio: car media player ready'), (e) => log.warn('audio: ' + e.message));
        else log.info('audio: no SOME/IP here (not a head unit): the picture plays without sound');
        const parked = Parked.watch(ctx, log);
        const player = new Player({
            log, audio, display: ctx.display, parked,
            settings: { get: (k) => (k === 'hl' ? region().hl : k === 'gl' ? region().gl : settings.get(k)) },
        });
        let loop = null;
        const redraw = () => { if (loop) loop.kick(); };
        player.onChange(redraw);

        /* ---------------- memory watchdog ---------------- */
        const wd = new Watchdog({
            log, limitKB: limitKB(), ratio: 0.7, children: () => player.childPids(),
            onTrip: () => {
                // nothing playing: only let go of what the pages hold
                const stopping = player.active() ? player.stop('memory', 'Playback stopped: TubeCar was using 70 % of the memory the car allows it.') : Promise.resolve();
                stopping.then(() => {
                    st.results = st.results && { q: st.results.q, items: st.results.items.slice(0, 50), continuation: st.results.continuation };
                    if (typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
                    setTimeout(() => wd.reset(), 15000);
                    redraw();
                });
            },
        });
        wd.start();

        /* ---------------- the internet ---------------- */
        let netTimer = null;
        const netCheck = () => {
            if (st.net.checking) return Promise.resolve();
            st.net.checking = true; redraw();
            return wifi.ensureConnected(cfg, () => net.check(), log).then((r) => {
                st.net = { checked: true, online: r.online, checking: false };
                st.netMsg = r;
                log.info('internet: ' + (r.online ? 'online' : 'offline (' + r.why + ')') + ' - ' + r.message);
            }, (e) => {
                st.net = { checked: true, online: false, checking: false };
                st.netMsg = { online: false, tone: 'warn', message: 'Could not check the internet: ' + e.message };
            }).then(() => {
                clearTimeout(netTimer);
                if (!st.net.online) netTimer = setTimeout(netCheck, RECHECK_OFFLINE_MS);
                redraw();
            });
        };
        // at start, without holding the start up (MainApp waits for it)
        setTimeout(netCheck, 300);

        /* ---------------- actions ---------------- */
        const setTab = (i) => { if (i >= 0 && i < ui.TABS.length) { st.tab = i; st.focusKey = null; redraw(); } };
        const remember = (q) => {
            if (!settings.get('keepHistory')) return;
            st.recent = [q].concat(st.recent.filter((x) => x.toLowerCase() !== q.toLowerCase())).slice(0, 8);
            saveRecent(ctx.dataDir, st.recent);
        };
        const offlineText = () => (st.netMsg && st.netMsg.message) || 'No internet connection.';
        const act = {
            tab: setTab,
            key(id) {
                const kb = st.tab === 3 && wv.editing ? wv.kb : st.kb;
                if (kb) kb.press(id);
                redraw();
            },
            search(q) {
                q = String(q || st.kb.text || '').trim();
                if (!q || st.searching) return;
                st.kb.text = q;
                remember(q);
                st.results = { q, items: [], loading: true, continuation: null, error: null };
                st.resPage = 0; st.searching = true;
                setTab(1);
                if (st.net.checked && !st.net.online) {
                    st.results.loading = false; st.searching = false; st.results.error = offlineText();
                    netCheck();
                    return;
                }
                yt.search(q, region()).then((r) => {
                    if (!st.results || st.results.q !== q) return;
                    st.results = { q, items: r.items, continuation: r.continuation, loading: false, error: r.items.length ? null : 'No videos found.' };
                }, (e) => {
                    log.warn('search: ' + e.message);
                    if (!st.results || st.results.q !== q) return;
                    st.results.loading = false;
                    st.results.error = e.code === 'offline' ? offlineText() : 'Search failed: ' + e.message;
                    if (e.code === 'offline') netCheck();
                }).then(() => { st.searching = false; redraw(); });
            },
            resPage(d) {
                const r = st.results;
                if (!r) return;
                const pages = Math.max(1, Math.ceil(r.items.length / ui.ROWS_PER_PAGE));
                if (d > 0 && st.resPage >= pages - 1) {
                    if (!r.continuation || r.loading) return;
                    r.loading = true; redraw();
                    yt.search(null, Object.assign({ continuation: r.continuation }, region())).then((more) => {
                        if (st.results !== r) return;
                        const seen = new Set(r.items.map((x) => x.id));
                        r.items = r.items.concat(more.items.filter((x) => !seen.has(x.id))).slice(0, 200);
                        r.continuation = more.items.length ? more.continuation : null;
                        st.resPage = Math.min(st.resPage + 1, Math.ceil(r.items.length / ui.ROWS_PER_PAGE) - 1);
                    }, (e) => { r.error = 'More results failed: ' + e.message; }).then(() => { r.loading = false; redraw(); });
                    return;
                }
                st.resPage = Math.max(0, Math.min(pages - 1, st.resPage + d));
                st.focusKey = null;
                redraw();
            },
            play(item) {
                st.nowId = item.id;
                setTab(2);
                if (st.net.checked && !st.net.online) { player.stop('error', offlineText()); netCheck(); return; }
                player.play(item);
            },
            toggle() { player.toggle(); },
            skip(ms) { player.skip(ms); },
            stop() { player.stop('user'); },
            netCheck() { netCheck(); },
            wifiEdit(field) {
                wv.editing = field; wv.error = null;
                wv.kb = new Keyboard({ text: field === 'ssid' ? wv.ssid : wv.psk, secret: field === 'psk', max: field === 'ssid' ? 32 : 63 });
                st.focusKey = null; redraw();
            },
            wifiDone() {
                if (!wv.editing) return;
                wv[wv.editing] = wv.kb.text;
                wv.dirty = true; wv.editing = null; wv.kb = null; redraw();
            },
            wifiCancel() { wv.editing = null; wv.kb = null; redraw(); },
            wifiAuto() { wv.auto = !wv.auto; wv.dirty = true; redraw(); },
            wifiSave() {
                const bad = wifi.WifiConfig.check(wv.ssid, wv.psk);
                if (bad) { wv.error = bad; redraw(); return; }
                try { cfg.save(wv.ssid, wv.psk, wv.auto); } catch (e) { wv.error = e.message; redraw(); return; }
                wv.savedSsid = wv.ssid; wv.dirty = false; wv.error = null;
                log.info('wifi: saved network "' + wv.ssid + '"');
                wv.busy = true; redraw();
                netCheck().then(() => { wv.busy = false; redraw(); });
            },
            wifiForget() {
                cfg.forget();
                Object.assign(wv, { ssid: '', psk: '', auto: true, savedSsid: '', dirty: false, error: null });
                redraw();
            },
        };

        /* ---------------- input: page targets; the bar's Prev / Next / Select where the kit does not run the screen ---------------- */
        ctx.onTab((i) => setTab(i));
        ['BTN_PREV', 'BTN_NEXT', 'BTN_OK'].forEach((id) => ctx.hideButton(id));    // with the renderer's touch: the page has them
        const moveFocus = (d) => {
            const keys = st.targets.map((q) => q.key);
            if (!keys.length) return;
            const i = keys.indexOf(st.focusKey);
            const n = i < 0 ? (d > 0 ? 0 : keys.length - 1) : (i + d + keys.length) % keys.length;
            st.focusKey = keys[n];
            redraw();
        };
        ui0.onClick('BTN_NEXT', () => moveFocus(1));
        ui0.onClick('BTN_PREV', () => moveFocus(-1));
        ui0.onClick('BTN_OK', () => {
            const q = st.targets.find((x) => x.key === st.focusKey);
            if (q) Promise.resolve().then(() => q.run()).catch((e) => log.error('select', e));
        });

        /* ---------------- drawing ---------------- */
        const model = () => ({
            tab: st.tab, kb: st.kb, recent: settings.get('keepHistory') ? st.recent : [], results: st.results, resPage: st.resPage,
            searching: st.searching, nowId: st.nowId, net: st.net, netMsg: st.netMsg, focusKey: st.focusKey,
            player: player.view(), wifi: wv, act,
        });
        const render = () => {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            ui.draw(cv, t, model());
            st.targets = cv.targets.map((q) => ({ key: q.key, run: q.run }));
            if (st.focusKey && !st.targets.some((q) => q.key === st.focusKey)) st.focusKey = null;
            return ui0.image('MAIN_GFX', cv);
        };
        // every display refresh with the GPU renderer (frames that did not change are not sent); 6 a second as PNGs
        loop = ctx.loop('MAIN', 6, render);
        // the caret, the clock and the download progress move by themselves
        const tick = setInterval(() => { if (ui0.isVisible('MAIN')) redraw(); }, 500);

        /* ---------------- leaving the screen, leaving the app ---------------- */
        const onShown = (on) => {
            player.setVisible(on);
            if (on) { log.info('screen shown'); redraw(); return; }
            // explicit: the loop stops (it would on its own, but nothing is left to chance), the decoder process is
            // killed by player.setVisible(false), and the page's state that holds memory goes
            if (loop) loop.stop();
            st.targets = [];
            if (ui0.isVisible('SETTINGS')) return;           // our own settings screen: the app is still in front
            if (!settings.get('keepSound') && player.active()) player.stop('screen left');
            log.info('screen left' + (player.active() ? ' (sound goes on)' : ''));
            if (typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
        };
        ui0.onVisible((name, on) => { if (name === 'MAIN') onShown(on); });
        player.setVisible(ui0.isVisible('MAIN'));

        const finish = () => {
            clearInterval(tick); clearTimeout(netTimer);
            if (loop) loop.stop();
            wd.stop();
            player.stopNow();
            player.dispose();
            net.destroyAgents();
        };
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', finish);   // MainApp stops the app (the kit exits ~200 ms later)
        process.on('exit', () => player.stopNow());        // and whatever else ends the process
        log.info('TubeCar ' + ctx.spec.version + ' started; memory limit ' + Math.round(limitKB() / 1024) + ' MB');
    },
});

function loadRecent(dir) {
    try { const a = JSON.parse(fs.readFileSync(path.join(dir, 'recent.json'), 'utf8')); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 8) : []; } catch (e) { return []; }
}
function saveRecent(dir, list) {
    try { fs.writeFileSync(path.join(dir, 'recent.json'), JSON.stringify(list)); } catch (e) { /* read-only */ }
}
