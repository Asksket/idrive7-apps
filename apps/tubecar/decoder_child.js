'use strict';
/**
 * decoder_child.js - the picture half of playback, in its own process (child_process.fork from player.js):
 * reads the MP4 the app is downloading, decodes its H.264 (Baseline) track in software with h264bsd
 * (WebAssembly) and writes each picture, on time, to the renderer's frame file (mgvf.js).
 *
 * Own process so that a decoder fault, a stall or its memory never takes the app (or its HMI screen) with it,
 * and so that stopping is one kill. It exits by itself when the app goes (IPC channel closed) or on `quit`.
 *
 * Parent -> child (process.send):
 *   { op: 'open', file, frames, avail, done }   the MP4 being downloaded, the frame file, bytes there so far
 *   { op: 'avail', bytes, done }                 more of the file is there (done: all of it)
 *   { op: 'clock', ms, at }                      media position ms was true at Date.now() = at (the car's player)
 *   { op: 'pause' } / { op: 'resume' }           freeze / run the clock
 *   { op: 'seek', ms }                           go to ms (the picture there is shown at once)
 *   { op: 'video', on }                          stop decoding and writing (the car drives) / go on at the clock
 *   { op: 'quit' }
 * Child -> parent:
 *   { ev: 'ready', w, h, fps, durMs }            the frame file has pictures of w x h
 *   { ev: 'stats', decoded, shown, dropped, fps, behindMs, buffering, rss }   every 2 s
 *   { ev: 'eof' } / { ev: 'error', msg, fatal }
 *
 * Env TUBECAR_FAKE_DECODER=<module>: a decoder module with the same interface (tests).
 */
const fs = require('fs');
const path = require('path');
const mp4 = require('./mp4');
const { FrameFile } = require('./mgvf');

const MAX_AU = 1024 * 1024;              // the decoder's input buffer (h264bsd_wasm: 1 MiB)
const SHOW_EARLY_MS = 8;                 // a picture is shown when its time is at most this far ahead
const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* parent gone */ } };

/* ---------------- the decoder: h264bsd in WebAssembly ---------------- */

function loadDecoder() {
    if (process.env.TUBECAR_FAKE_DECODER) return Promise.resolve(require(process.env.TUBECAR_FAKE_DECODER).create());
    // the emscripten build is a web worker build: it reads self.location once, and decodes its embedded
    // WebAssembly from base64 itself (no fetch in Node 8)
    if (typeof global.self === 'undefined') global.self = { location: { href: '' } };
    const factory = require('./h264bsd_wasm');
    const mod = factory({ print: () => {}, printErr: (s) => send({ ev: 'log', msg: 'h264bsd: ' + s }) });
    return Promise.resolve(mod.ready || mod).then((m) => {
        m = m && m._h264bsdAlloc ? m : mod;
        const st = m._h264bsdAlloc(), pW = m._malloc(4), pH = m._malloc(4), pPic = m._malloc(4), inBuf = m._malloc(MAX_AU);
        m._h264bsdInit(st, 0);
        return {
            /** Decode one Annex B access unit; returns { pic (view into the decoder's memory), w, h } or null. */
            decode(au) {
                m.HEAPU8.set(au, inBuf);
                const rc = m._h264bsdDecode(st, inBuf, au.length, pPic, pW, pH);
                if (rc === 1) {          // H264BSD_PIC_RDY
                    const w = m.getValue(pW, 'i32'), h = m.getValue(pH, 'i32'), p = m.getValue(pPic, 'i8*');
                    return { pic: m.HEAPU8.subarray(p, p + w * h * 3 / 2), w, h };
                }
                if (rc >= 3) throw new Error('decoder error ' + rc);   // ERROR, PARAM_SET_ERROR, MEMALLOC_ERROR
                return null;
            },
            release() {
                try { m._h264bsdShutdown(st); m._h264bsdFree(st); m._free(pW); m._free(pH); m._free(pPic); m._free(inBuf); } catch (e) { /* gone */ }
            },
        };
    });
}

/* ---------------- state ---------------- */

const S = {
    file: null, fd: null, avail: 0, done: false,
    frames: null, out: null,                  // frame file path, FrameFile
    track: null, samples: null, params: null, sps: null,
    dec: null, decoding: null,
    next: 0, needParams: true,
    clockMs: 0, clockAt: 0, paused: true, clocked: false,
    videoOn: true, skipUntil: -1,
    held: null, heldPts: 0,                   // the decoded picture waiting for its time (a copy)
    stats: { decoded: 0, shown: 0, dropped: 0, shownT: [], behind: 0, behindN: 0, buffering: false },
    timer: null, quitting: false, eof: false, errors: 0,
};

function pos() { return S.paused || !S.clocked ? S.clockMs : S.clockMs + (Date.now() - S.clockAt); }

function readAt(p, len) {
    const b = Buffer.alloc(Math.max(0, Math.min(len, S.avail - p)));
    if (b.length) fs.readSync(S.fd, b, 0, b.length, p);
    return b;
}

/** Find and parse the moov as soon as its bytes are there. */
function tryMovie() {
    if (S.samples || S.fd === null) return;
    let top;
    try { top = mp4.scanTop(readAt, S.avail); } catch (e) { fail('not an MP4 file: ' + e.message, true); return; }
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) {
        // a file whose moov comes after the media (not a progressive download) can't start before it ends
        if (S.done) fail('the video file has no index (moov)', true);
        return;
    }
    if (moov.start + moov.size > S.avail) return;
    let movie;
    try { movie = mp4.parseMoov(readAt(moov.start, moov.size)); } catch (e) { fail('bad video index: ' + e.message, true); return; }
    const v = movie.tracks.find((t) => t.kind === 'video' && (t.codec === 'avc1' || t.codec === 'avc3') && t.avc);
    if (!v || !v.samples || !v.samples.n) { fail('no H.264 video track', true); return; }
    let sps = null;
    try { sps = v.avc.sps.length ? mp4.parseSps(v.avc.sps[0]) : null; } catch (e) { send({ ev: 'log', msg: 'sps: ' + e.message }); }
    const profile = sps ? sps.profile : v.avc.profile;
    if (profile !== 66 && !(v.avc.compat & 0x80)) {
        // h264bsd decodes Baseline: profile 66, or a stream that says it keeps to Baseline (constraint_set0_flag)
        fail('the video is H.264 profile ' + profile + ', the decoder takes Baseline only', true);
        return;
    }
    S.track = v; S.samples = v.samples; S.params = mp4.paramSets(v.avc); S.sps = sps;
    const w = (sps ? sps.width : v.width) & ~1, h = (sps ? sps.height : v.height) & ~1;
    try { S.out = new FrameFile(S.frames, process.env.TUBECAR_ANY_FRAME_PATH ? { anyPath: true } : null).open(w, h, h >= 720 ? 1 : 0); } catch (e) { fail('frame file: ' + e.message, true); return; }
    const s = S.samples, fps = s.n > 1 && s.durMs > 0 ? Math.round(s.n * 1000 / s.durMs * 100) / 100 : 0;
    send({ ev: 'ready', w, h, fps, durMs: s.durMs, samples: s.n });
    seekTo(pos());
}

/* ---------------- decoding, paced by the clock ---------------- */

function seekTo(ms) {
    if (!S.samples) return;
    const s = S.samples;
    S.next = mp4.keyAtOrBefore(s, ms);
    S.needParams = true;
    S.held = null;
    // pictures before the target are decoded (a P frame needs them) but not shown
    S.skipUntil = ms - frameMs() / 2;
    S.eof = false;
    kick(0);
}
function frameMs() { const s = S.samples; return s && s.n > 1 ? Math.max(10, s.durMs / s.n) : 33; }

function kick(ms) {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(step, ms);
}

function step() {
    S.timer = null;
    if (S.quitting) return;
    if (!S.samples) { tryMovie(); if (!S.samples) { kick(50); return; } }
    if (!S.videoOn || !S.dec) { kick(100); return; }
    const s = S.samples, now = pos();
    // a picture waiting for its time
    if (S.held) {
        const wait = S.heldPts - now - SHOW_EARLY_MS;
        if (wait > 0) { kick(Math.min(wait, 50)); return; }
        show();
    }
    if (S.next >= s.n) {
        if (!S.eof) { S.eof = true; send({ ev: 'eof' }); }
        kick(200);
        return;
    }
    // far behind (a slow unit, a stall): jump to the newest key frame we may reach instead of decoding
    // every picture on the way (Baseline has no frame that can be left out but non-reference ones)
    if (S.skipUntil < 0 && now - s.pts[S.next] > 1000) {
        const k = mp4.keyAtOrBefore(s, now);
        if (k > S.next) { S.stats.dropped += k - S.next; S.next = k; S.needParams = true; }
    }
    const i = S.next;
    if (s.offset[i] + s.size[i] > S.avail) {
        // the download has not got there yet
        S.stats.buffering = !S.done;
        if (S.done) { S.next = s.n; kick(0); return; }
        kick(40);
        return;
    }
    S.stats.buffering = false;
    if (s.size[i] > MAX_AU) { S.next++; S.stats.dropped++; kick(0); return; }
    const raw = Buffer.alloc(s.size[i]);
    fs.readSync(S.fd, raw, 0, raw.length, s.offset[i]);
    const au = mp4.annexB(raw, S.track.avc.lengthSize, S.needParams && s.key[i] ? S.params : null);
    if (S.needParams && s.key[i]) S.needParams = false;
    S.next++;
    let out = null;
    try { out = S.dec.decode(au); } catch (e) {
        if (++S.errors > 20) { fail('the decoder gives up: ' + e.message, true); return; }
        S.needParams = true;
        S.next = Math.min(s.n, nextKey(S.next));
        kick(0);
        return;
    }
    S.stats.decoded++;
    if (out) {
        const pts = s.pts[i];
        if (S.skipUntil >= 0 && pts < S.skipUntil) { kick(0); return; }
        S.skipUntil = -1;
        if (pts < pos() - 2 * frameMs()) { S.stats.dropped++; kick(0); return; }    // too late to be worth it
        hold(out, pts);
    }
    // let the IPC messages (clock, pause, quit) in between pictures
    setImmediate(step);
}
function nextKey(i) { const s = S.samples; while (i < s.n && !s.key[i]) i++; return i; }

/** Keep a copy of the decoder's picture (its memory is used again by the next decode), cropped later. */
function hold(out, pts) {
    const need = out.w * out.h * 3 / 2;
    if (!S.holdBuf || S.holdBuf.length !== need) S.holdBuf = Buffer.alloc(need);
    S.holdBuf.set(out.pic);
    S.held = { w: out.w, h: out.h }; S.heldPts = pts;
}
function show() {
    const pic = S.held;
    S.held = null;
    if (!S.out || !S.out.size) return;
    const W = pic.w, H = pic.h, c = S.sps ? S.sps.crop : { left: 0, top: 0 };
    const b = S.holdBuf;
    const yOff = c.top * W + c.left, uOff = W * H + (c.top >> 1) * (W >> 1) + (c.left >> 1), vOff = uOff + (W >> 1) * (H >> 1);
    try {
        if (W === S.out.w && H === S.out.h) S.out.write(b);
        else S.out.write({ y: b, u: b, v: b, yOff, uOff, vOff, stride: W, cstride: W >> 1 });
    } catch (e) { fail('frame file: ' + e.message, true); return; }
    const st = S.stats;
    st.shown++;
    st.shownT.push(Date.now());
    const behind = pos() - S.heldPts;
    st.behind += behind; st.behindN++;
}

/* ---------------- control ---------------- */

function fail(msg, fatal) {
    send({ ev: 'error', msg, fatal: !!fatal });
    if (fatal) { S.videoOn = false; if (S.timer) { clearTimeout(S.timer); S.timer = null; } }
}

function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.op) {
    case 'open':
        S.file = m.file; S.frames = m.frames; S.avail = m.avail || 0; S.done = !!m.done;
        try { S.fd = fs.openSync(S.file, 'r'); } catch (e) { fail('open ' + path.basename(String(S.file)) + ': ' + e.message, true); return; }
        if (!S.decoding) {
            S.decoding = loadDecoder().then((d) => { S.dec = d; send({ ev: 'log', msg: 'decoder loaded' }); kick(0); })
                .catch((e) => fail('the decoder did not load: ' + (e && e.message || e), true));
        }
        kick(0);
        break;
    case 'avail': S.avail = Math.max(S.avail, m.bytes || 0); S.done = !!m.done; break;
    case 'clock':
        S.clockMs = m.ms; S.clockAt = m.at || Date.now(); S.clocked = true;
        // the car's player and the pictures disagree by more than a second: the player is right
        if (S.samples && !S.held && S.next < S.samples.n && Math.abs(S.samples.pts[S.next] - m.ms) > 3000 && S.skipUntil < 0) seekTo(m.ms);
        break;
    case 'pause': S.clockMs = pos(); S.paused = true; break;
    case 'resume': S.clockAt = Date.now(); S.paused = false; kick(0); break;
    case 'seek': S.clockMs = m.ms; S.clockAt = Date.now(); seekTo(m.ms); break;
    case 'video':
        S.videoOn = !!m.on;
        if (S.videoOn) seekTo(pos()); else S.held = null;
        break;
    case 'quit': quit(0); break;
    default: break;
    }
}

function statsTick() {
    const st = S.stats, now = Date.now();
    st.shownT = st.shownT.filter((t) => now - t < 2000);
    send({
        ev: 'stats', decoded: st.decoded, shown: st.shown, dropped: st.dropped, fps: st.shownT.length / 2,
        behindMs: st.behindN ? Math.round(st.behind / st.behindN) : 0, buffering: st.buffering,
        rss: process.memoryUsage().rss,
    });
    st.behind = 0; st.behindN = 0;
}

function quit(code) {
    if (S.quitting) return;
    S.quitting = true;
    if (S.timer) clearTimeout(S.timer);
    if (S.dec) S.dec.release();
    S.dec = null; S.holdBuf = null; S.held = null; S.samples = null;
    if (S.out) S.out.close(true);              // the parent removes the frame file (it named it to the renderer)
    if (S.fd !== null) { try { fs.closeSync(S.fd); } catch (e) { /* closed */ } S.fd = null; }
    process.exit(code);
}

if (require.main === module) {
    process.on('message', onMessage);
    // the app went (or closed the channel): nothing left to draw for
    process.on('disconnect', () => quit(0));
    process.on('SIGTERM', () => quit(0));
    process.on('uncaughtException', (e) => { send({ ev: 'error', msg: 'decoder crashed: ' + (e && e.stack || e), fatal: true }); quit(70); });
    setInterval(statsTick, 2000);
    S.paused = true;
}

module.exports = { _state: S, _onMessage: onMessage };
