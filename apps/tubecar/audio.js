'use strict';
/**
 * audio.js - the sound, through the car's own media player: the head unit's media engine plays an audio file
 * as the OAP entertainment source, on the speakers, with the iDrive volume, as BMW's own online apps do.
 *
 * Two SOME/IP services (both in app.json "signals", so the installer gives this app their configs):
 *   - GENIVI AudioManager org.genivi.am.commandinterface.CommandControl (instance 1): connect the source
 *     "OAPGenericMedia" to the sink "MediaSink_Front" (the radio or whatever played drops), disconnect it after.
 *   - BMW's de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer, instance "OapGenericMedia": playFile(path),
 *     sendButtonEvent(STOP), setTime(ms); playerState and currentItemTime (every ~250 ms) come back.
 * Seen on cars by others (mgu-store community, RideTube, 2026-11): playFile needs a complete file the media engine
 * (its own uid) can open by name; PAUSE is answered OK but playing goes on, so a pause here is a STOP and a resume
 * plays the file again and seeks; after a STOP the player wants playFile again, not PLAY.
 *
 * Every way out goes through release(): STOP, disconnect, and the radio (or whatever was connected before) back.
 * A connection left by a run of this app that died is disconnected at the next start (data/audio-conn.json).
 */
const fs = require('fs');
const path = require('path');

const CC = 'org.genivi.am.commandinterface.CommandControl';
const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const MP_INSTANCE = 'OapGenericMedia';
const SOURCE_NAME = 'OAPGenericMedia', SINK_NAME = 'MediaSink_Front';
const SOURCE_ID = 1046, SINK_ID = 1024;       // as seen on cars; looked up by name first
const LANG = 7695972;                           // languageCode as BMW's apps send it

const ok = (r) => r && (r.amError === 'E_OK' || r.amError === 0 || r.amError === 'E_ALREADY_EXISTS');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connected = (c) => c && (c.connectionState === 'CS_CONNECTED' || c.connectionState === 2);

class CarAudio {
    /** signals: kit/runtime/signals.js; log: ctx.log; dataDir: where the open connection is remembered */
    constructor(signals, log, dataDir) {
        this.signals = signals; this.log = log;
        this.connFile = path.join(dataDir || '.', 'audio-conn.json');
        this.cc = null; this.mp = null;
        this.conn = null;           // { id, source, sink, previous }
        this.handlers = { time: [], state: [], error: [] };
        this.lastState = null;
        this.pending = Promise.resolve();
        this.initP = null;
    }
    /** Can sound play at all here (the SOME/IP binding is there: a head unit, not a PC). */
    available() { return !!(this.signals && this.signals.hasNative && this.signals.hasNative()); }
    on(ev, fn) { this.handlers[ev].push(fn); }
    _emit(ev, v) { this.handlers[ev].forEach((fn) => { try { fn(v); } catch (e) { this.log.warn('audio ' + ev + ': ' + e); } }); }

    init() {
        if (this.initP) return this.initP;
        this.initP = (async () => {
            if (!this.available()) throw new Error('no SOME/IP on this machine');
            this.cc = await this.signals.proxy(CC, '1');
            this.mp = await this.signals.proxy(MP, MP_INSTANCE);
            await this.signals.on(this.mp, 'currentItemTime', (v) => this._emit('time', normTime(v)), this.log);
            await this.signals.on(this.mp, 'playerState', (v) => { this.lastState = normState(v); this._emit('state', this.lastState); }, this.log);
            await this.signals.on(this.mp, 'playbackErrorEvent', (v) => this._emit('error', v), this.log).catch(() => {});
            await this.dropLeftover();
        })();
        this.initP.catch(() => { this.initP = null; });
        return this.initP;
    }
    async _waitAvailable(p, what) {
        for (let i = 0; i < 50; i++) {
            if (!p.isAvailable || p.isAvailable()) return;
            await sleep(100);
        }
        throw new Error(what + ' is not available');
    }
    _call(p, method, params, ms) { return this.signals.call(p, method, params || {}, ms || 5000); }

    /** A connection this app made in an earlier run that ended without releasing it. */
    async dropLeftover() {
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(this.connFile, 'utf8')); } catch (e) { return; }
        await this._waitAvailable(this.cc, 'the audio manager');
        const list = await this._connections().catch(() => []);
        const still = list.find((c) => c.mainConnectionID === saved.id && c.sourceID === saved.source);
        if (still) {
            const r = await this._call(this.cc, 'disconnect', { mainConnectionID: saved.id }).catch((e) => String(e));
            this.log.info('audio: disconnected connection ' + saved.id + ' left by an earlier run: ' + JSON.stringify(r));
        }
        try { fs.unlinkSync(this.connFile); } catch (e) { /* gone */ }
    }
    async _connections() {
        const r = await this._call(this.cc, 'getListMainConnections');
        return (r && (r.listConnections || r.listMainConnections)) || [];
    }

    /** Connect the OAP media source to the front speakers and play `file` (a complete m4a the media engine can read). */
    play(file) {
        const p = this.pending = this.pending.catch(() => {}).then(() => this._play(file));
        return p;
    }
    async _play(file) {
        await this.init();
        await this._waitAvailable(this.cc, 'the audio manager');
        await this._waitAvailable(this.mp, 'the car\'s media player');
        // the driver chose another source (the radio) since: the audio manager took our connection down
        if (this.conn && this.conn.id !== -1) {
            const now = await this._connections().catch(() => null);
            if (now && !now.some((c) => c.mainConnectionID === this.conn.id)) { this.log.info('audio: connection ' + this.conn.id + ' is gone, connecting again'); this.conn = null; }
        }
        if (!this.conn) {
            const src = await this._call(this.cc, 'getListMainSources').catch(() => null);
            const snk = await this._call(this.cc, 'getListMainSinks').catch(() => null);
            const source = ((src && src.listMainSources) || []).find((s) => s.name === SOURCE_NAME);
            const sink = ((snk && snk.listMainSinks) || []).find((s) => s.name === SINK_NAME);
            const sourceID = source ? source.sourceID : SOURCE_ID, sinkID = sink ? sink.sinkID : SINK_ID;
            const before = await this._connections().catch(() => []);
            const previous = before.filter((c) => c.sinkID === sinkID && c.sourceID !== sourceID && connected(c)).map((c) => ({ sourceID: c.sourceID, sinkID: c.sinkID }));
            const r = await this._call(this.cc, 'connect', { sourceID, sinkID });
            if (!ok(r)) throw new Error('the audio manager refused the connection: ' + (r && r.amError));
            let id = r.mainConnectionID;
            if (id == null) {
                const now = await this._connections().catch(() => []);
                const mine = now.find((c) => c.sourceID === sourceID && c.sinkID === sinkID);
                id = mine ? mine.mainConnectionID : -1;
            }
            this.conn = { id, source: sourceID, sink: sinkID, previous };
            try { fs.writeFileSync(this.connFile, JSON.stringify({ id, source: sourceID, at: Date.now() })); } catch (e) { /* read-only: no leftover check */ }
            this.log.info('audio: connected source ' + sourceID + ' -> sink ' + sinkID + ' (connection ' + id + ')');
        }
        const p = await this._call(this.mp, 'playFile', { path: file, languageCode: LANG });
        if (!p || (p.EntError && p.EntError !== 'OK')) throw new Error('the car\'s media player refused the file: ' + (p && p.EntError));
        this.log.info('audio: playing ' + path.basename(file));
    }

    /** Jump to ms in the file playing. */
    seek(ms) {
        if (!this.mp || !this.conn) return Promise.resolve();
        return this._call(this.mp, 'setTime', { newTimeElapsed: Math.max(0, Math.round(ms)) }, 3000).catch((e) => this.log.warn('audio seek: ' + e));
    }
    /** STOP (the car's player goes on after PAUSE): resume with play(file) again, then seek(). */
    stop() {
        if (!this.mp || !this.conn) return Promise.resolve();
        return this._call(this.mp, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 3000).catch((e) => this.log.warn('audio stop: ' + e));
    }

    /** Stop and give the speakers back. Safe to call any number of times, also while a play() is on its way. */
    release() {
        const p = this.pending = this.pending.catch(() => {}).then(() => this._release());
        return p;
    }
    async _release() {
        const c = this.conn;
        if (!c) return;
        this.conn = null;
        await this._call(this.mp, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 3000).catch(() => {});
        if (c.id !== -1) {
            const r = await this._call(this.cc, 'disconnect', { mainConnectionID: c.id }).catch((e) => String(e));
            this.log.info('audio: disconnected ' + c.id + ': ' + JSON.stringify(r));
        } else {
            const list = await this._connections().catch(() => []);
            for (const x of list.filter((y) => y.sourceID === c.source && y.sinkID === c.sink)) {
                await this._call(this.cc, 'disconnect', { mainConnectionID: x.mainConnectionID }).catch(() => {});
            }
        }
        try { fs.unlinkSync(this.connFile); } catch (e) { /* gone */ }
        // what played before (the radio) back, unless the driver chose something else meanwhile
        if (c.previous && c.previous.length === 1) {
            await sleep(150);
            const now = await this._connections().catch(() => null);
            if (now && !now.some((x) => x.sinkID === c.sink)) {
                await this._call(this.cc, 'connect', c.previous[0]).catch(() => {});
            }
        }
    }
    /** For the app's exit: what can be sent without waiting (the process ends in ~200 ms). */
    releaseNow() {
        if (!this.conn || !this.cc) return;
        const c = this.conn;
        this.conn = null;
        // through signals.call (a fresh setImmediate each): the binding deadlocks on calls made inline
        this._call(this.mp, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 1000).catch(() => {});
        if (c.id !== -1) this._call(this.cc, 'disconnect', { mainConnectionID: c.id }, 1000).catch(() => {});
        // the file stays: if the disconnect did not get out, the next start drops the connection
    }
}

function normTime(v) {
    if (!v || typeof v !== 'object') return { elapsed: Number(v) || 0, total: 0 };
    return { elapsed: Number(v.elapsed != null ? v.elapsed : v.timeElapsed) || 0, total: Number(v.total != null ? v.total : v.timeTotal) || 0 };
}
function normState(v) {
    const s = String(v && typeof v === 'object' ? (v.playerState || v.state || JSON.stringify(v)) : v);
    if (/PLAY/.test(s) && !/PAUSE|STOP/.test(s)) return 'play';
    if (/PAUSE/.test(s)) return 'pause';
    if (/STOP|IDLE|END/.test(s)) return 'stop';
    if (/BUFFER|LOAD/.test(s)) return 'buffering';
    return s.toLowerCase();
}

module.exports = { CarAudio, normTime, normState, CC, MP, MP_INSTANCE };
