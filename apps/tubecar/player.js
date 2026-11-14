'use strict';
/**
 * player.js - one video playing: its files fetched, the sound on the car's media player (audio.js), the picture
 * decoded by a child process (decoder_child.js) into the renderer's frame file, only while the car is parked.
 *
 *   const p = new Player({ log, audio, display, parked, settings, ... })
 *   p.play(item)       item from yt.search; resolves its files, downloads the sound, starts both halves
 *   p.toggle(), p.skip(+-ms), p.seek(ms)
 *   p.stop(reason)     ends everything this video holds: downloads, sound, decoder, files, buffers (idempotent)
 *   p.view()           what the screen shows
 *   p.childPids()      for the memory watchdog
 *   p.onChange(fn)     something on the screen changed
 *
 * The sound file must be complete before the car's player takes it, so the sound is fetched first (4 ranged
 * connections), then played; the picture's MP4 follows, and the decoder starts on it as it arrives.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const yt = require('./yt');
const net = require('./net');

const VIDEO_ID = 1;
const APP = 'tubecar';
const FRAMES = '/dev/shm/mgu-video-' + APP;
const MAX_AUDIO = 160 * 1024 * 1024, MAX_VIDEO = 320 * 1024 * 1024;
const KILL_AFTER_MS = 1000;

/** Where the media files go: RAM (/dev/shm), in a folder others may pass through but not list (0711): the car's
 *  media engine runs as its own user and opens the sound file by name. */
function mediaDir() {
    const base = process.env.TUBECAR_MEDIA_DIR || (fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir());
    const d = path.join(base, APP + '-' + process.getuid());
    try { fs.mkdirSync(d, 0o711); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { fs.chmodSync(d, 0o711); } catch (e) { /* not ours: the next step says */ }
    return d;
}
/** Files a run that died left behind. */
function sweepMedia(log) {
    try {
        const d = mediaDir();
        fs.readdirSync(d).forEach((f) => { try { fs.unlinkSync(path.join(d, f)); } catch (e) { /* gone */ } });
    } catch (e) { if (log) log.warn('media folder: ' + e.message); }
    try { fs.unlinkSync(process.env.TUBECAR_FRAMES || FRAMES); } catch (e) { /* none */ }
}

class Player {
    constructor(o) {
        this.log = o.log; this.audio = o.audio; this.display = o.display; this.parked = o.parked;
        this.settings = o.settings;
        this.framesPath = process.env.TUBECAR_FRAMES || FRAMES;
        this.childScript = o.childScript || path.join(__dirname, 'decoder_child.js');
        this.childEnv = o.childEnv || null;
        this.listeners = [];
        this.s = null;                    // the session: everything one video holds
        this.gen = 0;                     // bumps on every play/stop: late answers of an old session are dropped
        this.last = { state: 'idle' };
        this.audio.on('time', (t) => this._onTime(t));
        this.audio.on('state', (st) => this._onAudioState(st));
        this.audio.on('error', (e) => this._onAudioError(e));
        this.parkTimer = setInterval(() => this._checkParked(), 500);
        if (this.parkTimer.unref) this.parkTimer.unref();
    }
    onChange(fn) { this.listeners.push(fn); }
    _changed() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { this.log.error('player listener', e); } }); }
    _set(patch) { if (this.s) Object.assign(this.s, patch); this._changed(); }
    childPids() { return this.s && this.s.child && this.s.child.pid && !this.s.childGone ? [this.s.child.pid] : []; }
    active() { return !!this.s; }

    /* ---------------- start ---------------- */

    async play(item) {
        await this.stop('new video');
        const gen = ++this.gen;
        const s = this.s = {
            gen, item, state: 'resolving', msg: 'Asking YouTube...', title: item.title || '', channel: item.channel || '',
            durMs: (item.seconds || 0) * 1000, posMs: 0, posAt: 0, playing: false, pct: 0, buffering: false,
            info: null, dir: null, audioFile: null, videoFile: null, dlA: null, dlV: null, vGot: 0, vSize: 0, vDone: false,
            child: null, childGone: true, childReady: null, childStats: null, childErr: null, videoNamed: false,
            videoWhy: 'Picture: loading', ticked: false, localClock: !this.audio.available(), resumeAt: null, wantVideo: false,
        };
        this._changed();
        const alive = () => this.s === s && this.gen === gen;
        try {
            s.dir = mediaDir();
            const info = await yt.player(item.id, { hl: this.settings.get('hl'), gl: this.settings.get('gl') });
            if (!alive()) return;
            s.info = info;
            s.title = info.title || s.title; s.channel = info.channel || s.channel;
            if (info.seconds) s.durMs = info.seconds * 1000;
            this.log.info('play ' + item.id + ' via ' + info.client + ': sound itag ' + info.audio.itag + ' ' + mb(info.audio.size) +
                (info.video ? ', picture itag ' + info.video.itag + ' ' + info.video.w + 'x' + info.video.h + ' ' + mb(info.video.size) : ', no picture: ' + info.videoError));
            // RAM: the files live in /dev/shm; leave the unit room
            const need = (info.audio.size || 0) + (info.video ? info.video.size || 0 : 0);
            if (info.audio.size > MAX_AUDIO) throw new Error('This video is too long for the car (' + mb(info.audio.size) + ' of sound).');
            const avail = memAvailable();
            if (avail !== null && avail - need < 384 * 1024 * 1024) {
                if (avail - info.audio.size < 256 * 1024 * 1024) throw new Error('Not enough free memory on the head unit for this video.');
                this.log.warn('play: little free memory, sound only');
                info.video = null; info.videoError = 'not enough free memory for the picture';
            }
            if (info.video && info.video.size > MAX_VIDEO) { info.video = null; info.videoError = 'the picture file is too big'; }
            // the sound first: the car's player takes complete files only
            s.audioFile = path.join(s.dir, 'a-' + item.id + '.m4a');
            s.state = 'loading'; s.msg = 'Loading the sound...';
            this._changed();
            s.dlA = net.download(info.audio.url, s.audioFile, {
                size: info.audio.size, parallel: 4, chunk: 1024 * 1024, headers: info.headers, maxBytes: MAX_AUDIO,
                onProgress: (got, size) => { if (alive()) { const pct = Math.floor(got * 100 / size); if (pct !== s.pct) { s.pct = pct; this._changed(); } } },
            });
            await s.dlA.promise;
            s.dlA = null;
            if (!alive()) return;
            try { fs.chmodSync(s.audioFile, 0o644); } catch (e) { /* made so */ }
            // the picture's file, as it comes; the decoder starts once the car parks and the renderer can show it
            if (info.video) this._startVideoDownload(s);
            else s.videoWhy = 'Sound only: ' + (info.videoError || 'no picture file');
            await this._startSound(s, 0);
            if (!alive()) return;
            s.state = 'playing'; s.playing = true; s.msg = '';
            this._changed();
            this._checkParked();
        } catch (e) {
            if (!alive()) return;
            const why = e instanceof yt.YtError ? ytMessage(e) : e.code === 'EABORTED' ? null : (e.message || String(e));
            if (!why) return;
            this.log.warn('play ' + item.id + ': ' + (e.stack || e));
            await this.stop('error', why);
        }
    }

    async _startSound(s, atMs) {
        s.ticked = false;
        if (s.localClock) {
            // no car player here (a PC): the picture runs on the system clock, without sound
            s.posMs = atMs; s.posAt = Date.now(); s.playing = true;
            s.soundWhy = 'No sound: the car\'s media player is not reachable here';
            this._sendChild({ op: 'clock', ms: atMs, at: Date.now() }); this._sendChild({ op: 'resume' });
            return;
        }
        await this.audio.play(s.audioFile);
        if (atMs > 500) {
            // a setTime before the file's first time report is dropped by the car's player: wait for one
            await waitFor(() => s.ticked || this.s !== s, 3000);
            if (this.s === s) await this.audio.seek(atMs);
        }
    }

    _startVideoDownload(s) {
        const info = s.info;
        s.videoFile = path.join(s.dir, 'v-' + s.item.id + '.mp4');
        s.vSize = info.video.size;
        s.dlV = net.download(info.video.url, s.videoFile, {
            size: info.video.size, parallel: 2, chunk: 2 * 1024 * 1024, headers: info.headers, maxBytes: MAX_VIDEO, mode: 0o600,
            onProgress: (got, size, contig) => { if (this.s === s) { s.vGot = contig; this._sendChild({ op: 'avail', bytes: contig, done: false }); } },
        });
        s.dlV.promise.then(() => {
            if (this.s !== s) return;
            s.dlV = null; s.vDone = true; s.vGot = s.vSize;
            this._sendChild({ op: 'avail', bytes: s.vSize, done: true });
        }, (e) => {
            if (this.s !== s || e.code === 'EABORTED') return;
            this.log.warn('picture download: ' + e.message);
            s.dlV = null; s.videoWhy = 'Sound only: the picture did not download (' + e.message + ')';
            this._stopChild(s);
            this._changed();
        });
    }

    /* ---------------- the picture: only while parked, only with the renderer ---------------- */

    /** Whether the picture may be shown now, and why not. */
    _videoGate(s) {
        if (!s.info || !s.info.video || !s.videoFile) return { on: false, why: s.videoWhy };
        if (s.childErr) return { on: false, why: 'Sound only: ' + s.childErr };
        if (this.parked.moving()) return { on: false, why: 'Picture off while driving' };
        if (!this.display.videoReady()) return { on: false, why: 'Sound only: the picture needs the GPU renderer (MGU Store Renderer with video)' };
        if (!this.visible) return { on: false, why: 'Picture: screen not shown' };
        return { on: true, why: '' };
    }
    _checkParked() {
        const s = this.s;
        if (!s || s.state === 'error' || s.state === 'ended' || s.state === 'resolving' || s.state === 'loading') return;
        const g = this._videoGate(s);
        if (g.on && s.childGone) this._startChild(s);
        if (!s.childGone) this._sendChild({ op: 'video', on: g.on });
        if (s.wantVideo !== g.on || (!g.on && s.videoWhy !== g.why)) {
            s.wantVideo = g.on;
            if (!g.on) s.videoWhy = g.why;
            this._changed();
        }
    }
    /** The screen is shown or not (main.js). Hidden: the decoder process goes at once (it comes back when shown). */
    setVisible(on) {
        this.visible = !!on;
        if (!on && this.s) this._stopChild(this.s);
        this._checkParked();
    }

    _startChild(s) {
        if (!s.childGone || s.childErr) return;
        const env = Object.assign({}, process.env, this.childEnv || {});
        // a small heap: the decoder's memory is mostly its WebAssembly memory (16 MiB) and one picture
        const child = fork(this.childScript, [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=48'] });
        s.child = child; s.childGone = false; s.childReady = null;
        this.log.info('decoder: started, pid ' + child.pid);
        child.on('message', (m) => this._onChild(s, child, m));
        child.on('error', (e) => this.log.warn('decoder: ' + e.message));
        child.on('exit', (code, sig) => {
            if (s.child === child) { s.childGone = true; s.child = null; s.childReady = null; }
            this.log.info('decoder: ended (' + (sig || code) + ')');
            if (this.s === s && s.videoNamed) { this.display.video(VIDEO_ID, null); s.videoNamed = false; }
            if (this.s === s && code && code !== 0 && !s.stopping && !s.childErr) {
                s.childCrashes = (s.childCrashes || 0) + 1;
                if (s.childCrashes >= 2) s.childErr = 'the picture decoder failed twice';
                this._changed();
            }
        });
        child.send({ op: 'open', file: s.videoFile, frames: this.framesPath, avail: s.vGot, done: s.vDone });
        this._sendChild({ op: 'clock', ms: this._pos(s), at: Date.now() });
        this._sendChild({ op: s.playing ? 'resume' : 'pause' });
    }
    _onChild(s, child, m) {
        if (!m || this.s !== s || s.child !== child) return;
        if (m.ev === 'ready') {
            s.childReady = m;
            this.log.info('decoder: ' + m.w + 'x' + m.h + ' at ' + m.fps + ' fps, ' + m.samples + ' pictures');
            // the frame file exists now: name it to the renderer (a file named before it exists draws nothing)
            this.display.video(VIDEO_ID, this.framesPath);
            s.videoNamed = true;
            this._changed();
        } else if (m.ev === 'stats') {
            s.childStats = m;
            if (s.stats0 == null || Date.now() - s.stats0 > 10000) {
                s.stats0 = Date.now();
                this.log.info('decoder: ' + m.fps + ' fps shown, ' + m.dropped + ' dropped, ' + Math.round(m.rss / 1048576) + ' MB' + (m.buffering ? ', waiting for the download' : ''));
            }
            this._changed();
        } else if (m.ev === 'error') {
            this.log.warn('decoder: ' + m.msg);
            if (m.fatal) { s.childErr = m.msg; this._stopChild(s); this._changed(); }
        } else if (m.ev === 'log') this.log.info('decoder: ' + m.msg);
    }
    _sendChild(m) {
        const s = this.s;
        if (!s || !s.child || s.childGone) return;
        try { s.child.send(m); } catch (e) { /* exiting */ }
    }
    /** End the decoder process: quit, then SIGTERM, then SIGKILL; the frame file is unnamed and removed. */
    _stopChild(s) {
        const child = s.child;
        if (s.videoNamed) { this.display.video(VIDEO_ID, null); s.videoNamed = false; }
        if (!child) return Promise.resolve();
        s.child = null; s.childGone = true; s.childReady = null; s.childStats = null;
        return new Promise((resolve) => {
            let finished = false;
            const done = () => { if (finished) return; finished = true; clearTimeout(t1); clearTimeout(t2); resolve(); };
            if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
            child.once('exit', done);
            try { child.send({ op: 'quit' }); } catch (e) { /* channel closed */ }
            const t1 = setTimeout(() => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }, KILL_AFTER_MS / 2);
            const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } done(); }, KILL_AFTER_MS);
        }).then(() => { try { fs.unlinkSync(this.framesPath); } catch (e) { /* gone */ } });
    }

    /* ---------------- the clock: the car's player ---------------- */

    _pos(s) { return s.playing && s.posAt ? s.posMs + (Date.now() - s.posAt) : s.posMs; }
    _onTime(t) {
        const s = this.s;
        if (!s || s.localClock || !(t.total > 1)) return;     // {elapsed: 0, total: 1} right after playFile
        s.ticked = true;
        s.posMs = t.elapsed; s.posAt = Date.now();
        if (t.total > 1000) s.durMs = t.total;
        this._sendChild({ op: 'clock', ms: t.elapsed, at: s.posAt });
        if (s.durMs && t.elapsed >= s.durMs - 400 && s.state === 'playing') s.nearEnd = true;
    }
    _onAudioState(st) {
        const s = this.s;
        if (!s || s.localClock) return;
        if (st === 'play') {
            if (s.state === 'playing') { s.playing = true; s.posAt = Date.now(); this._sendChild({ op: 'resume' }); }
        } else if (st === 'stop' || st === 'pause') {
            if (s.state === 'playing' && !s.pausing) {
                if (s.nearEnd) { this._ended(s); return; }
                // stopped by someone else (the driver chose the radio, a call): our pause
                s.posMs = this._pos(s); s.playing = false; s.state = 'paused'; s.msg = 'Stopped by the car';
                this._sendChild({ op: 'pause' });
                this._changed();
            }
        }
    }
    _onAudioError(e) {
        const s = this.s;
        if (!s || s.state !== 'playing') return;
        this.log.warn('car player error: ' + JSON.stringify(e));
        this.stop('error', 'The car\'s media player could not play the sound (' + (e && (e.error || e.reason) || 'error') + ').');
    }
    _ended(s) {
        s.state = 'ended'; s.playing = false; s.posMs = s.durMs; s.msg = 'Ended';
        this._stopChild(s);
        this.audio.release();
        this._changed();
    }

    /* ---------------- controls ---------------- */

    async toggle() {
        const s = this.s;
        if (!s) return;
        if (s.state === 'playing') {
            s.pausing = true;
            s.posMs = this._pos(s); s.playing = false; s.state = 'paused'; s.msg = '';
            this._sendChild({ op: 'pause' });
            this._changed();
            if (!s.localClock) await this.audio.stop();
            s.pausing = false;
        } else if (s.state === 'paused' || s.state === 'ended') {
            const at = s.state === 'ended' ? 0 : s.posMs;
            s.state = 'playing'; s.msg = ''; s.nearEnd = false;
            this._changed();
            try {
                await this._startSound(s, at);
                if (this.s !== s) return;
                s.posMs = at; s.posAt = Date.now(); s.playing = true;
                this._sendChild({ op: 'seek', ms: at }); this._sendChild({ op: 'resume' });
                this._checkParked();
            } catch (e) { if (this.s === s) this.stop('error', e.message); }
        }
    }
    skip(ms) { const s = this.s; if (s) return this.seek(this._pos(s) + ms); return Promise.resolve(); }
    async seek(ms) {
        const s = this.s;
        if (!s || (s.state !== 'playing' && s.state !== 'paused')) return;
        ms = Math.max(0, s.durMs > 1000 ? Math.min(ms, s.durMs - 1000) : ms);
        s.posMs = ms; s.posAt = Date.now(); s.nearEnd = false;
        this._sendChild({ op: 'seek', ms });
        this._changed();
        if (s.state === 'playing' && !s.localClock) await this.audio.seek(ms);
    }

    /**
     * Stop everything this video holds, in this order: downloads (their sockets), the sound (STOP, the speakers
     * back), the decoder process (killed if it does not quit), the frame file and the media files, the buffers.
     * reason 'error' with a message leaves the error on the screen.
     */
    async stop(reason, message) {
        const s = this.s;
        this.gen++;
        if (!s) {
            if (reason === 'error' && message) { this.last = { state: 'error', msg: message }; this._changed(); }
            return;
        }
        s.stopping = true;
        this.s = null;
        this.log.info('stop: ' + reason + (message ? ' (' + message + ')' : ''));
        if (s.dlA) { s.dlA.abort(); s.dlA = null; }
        if (s.dlV) { s.dlV.abort(); s.dlV = null; }
        await Promise.all([
            this.audio.release().catch((e) => this.log.warn('audio release: ' + e)),
            this._stopChild(s),
        ]);
        [s.audioFile, s.videoFile].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } } });
        // let go of everything the session referenced
        s.info = null; s.childStats = null; s.item = null;
        this.last = reason === 'error' ? { state: 'error', msg: message || 'Playback stopped.' }
            : reason === 'memory' ? { state: 'error', msg: message || 'Playback stopped: the app was running out of memory.' }
            : { state: 'idle' };
        if (typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
        this._changed();
    }
    /** For process exit: synchronous parts only (the app ends within ~200 ms). */
    stopNow() {
        const s = this.s;
        if (!s) return;
        this.s = null;
        if (s.dlA) s.dlA.abort();
        if (s.dlV) s.dlV.abort();
        if (s.child) { try { s.child.kill('SIGKILL'); } catch (e) { /* gone */ } }
        this.audio.releaseNow();
        [s.audioFile, s.videoFile, this.framesPath].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } } });
    }
    dispose() { clearInterval(this.parkTimer); }

    /* ---------------- for the screen ---------------- */

    view() {
        const s = this.s;
        if (!s) return Object.assign({ state: 'idle', title: '', channel: '', posMs: 0, durMs: 0 }, this.last);
        const g = this._videoGate(s);
        const st = s.childStats;
        return {
            state: s.state, msg: s.msg, title: s.title, channel: s.channel, pct: s.pct,
            posMs: Math.min(this._pos(s), s.durMs || Infinity), durMs: s.durMs, playing: s.playing,
            video: g.on && s.childReady && s.videoNamed ? { id: VIDEO_ID, w: s.childReady.w, h: s.childReady.h } : null,
            videoWhy: g.on ? (s.childReady ? '' : 'Picture: starting...') : g.why,
            slow: !!(st && st.fps > 0 && s.childReady && s.childReady.fps && st.fps < s.childReady.fps * 0.6),
            buffering: !!(st && st.buffering) || !!s.buffering,
            loadedPct: s.vSize ? Math.floor(s.vGot * 100 / s.vSize) : 0,
            soundWhy: s.soundWhy || '',
        };
    }
}

function mb(n) { return n ? (n / 1048576).toFixed(1) + ' MB' : '? MB'; }
/** Memory the kernel can hand out (MemAvailable: free + reclaimable cache), bytes; null where there is no /proc.
 *  (os.freemem() in Node 8 is MemFree, which a unit with a full page cache reports as nearly nothing.) */
function memAvailable() {
    try {
        const m = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        return m ? Number(m[1]) * 1024 : null;
    } catch (e) { return null; }
}
function waitFor(cond, ms) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => { if (cond() || Date.now() - t0 > ms) resolve(); else setTimeout(tick, 50); };
        tick();
    });
}
function ytMessage(e) {
    switch (e.code) {
    case 'offline': return 'No internet connection.';
    case 'age': return 'YouTube wants a sign-in for this video (age-restricted or private).';
    case 'botcheck': return 'YouTube asks for a sign-in to check this is not a bot. Try again later.';
    case 'live': return 'Live streams are not supported.';
    case 'unavailable': return 'This video is not available: ' + e.message;
    case 'nofiles': return 'YouTube gave no file the car can play (' + e.message + ').';
    default: return 'YouTube answered in a way this app does not understand (' + e.message + ').';
    }
}

module.exports = { Player, sweepMedia, mediaDir, FRAMES, VIDEO_ID };
