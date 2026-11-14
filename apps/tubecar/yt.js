'use strict';
/**
 * yt.js - YouTube, asked the way YouTube's own apps ask it (InnerTube, /youtubei/v1/...). YouTube has no public API
 * that hands a video's files to a player of one's own, so this can break whenever YouTube changes its answers; every
 * failure says what YouTube answered, and the client table below is what to update then.
 *
 *   yt.search(q, { hl, gl, continuation }) -> { items: [{ id, title, channel, seconds, duration, views, age }], continuation }
 *   yt.player(id, { hl, gl })              -> { id, title, channel, seconds, video: { url, size, itag, w, h } | null,
 *                                                audio: { url, size, itag }, client, headers }
 *
 * The files: the picture from the progressive MP4 (itag 18: H.264 Constrained Baseline, 360p, with AAC), which
 * the app's software decoder can play; the sound from the AAC-only MP4 (itag 140, else 139), which the car's
 * media player plays from a file. File addresses are bound to the address that asked, so they are fetched on the
 * car itself, right before playing.
 */
const net = require('./net');

const BASE = process.env.TUBECAR_YT_BASE || 'https://www.youtube.com/youtubei/v1/';      // (tests: a stand-in)
const WEB = { clientName: 'WEB', clientVersion: '2.20251110.01.00' };
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// tried in this order for a video's files; each gives addresses without a signature to work out
const CLIENTS = [
    {
        name: 'android_vr', id: 28,
        ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    },
    {
        name: 'ios', id: 5,
        ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    },
    {
        name: 'android', id: 3,
        ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
        client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
    },
];
const SEARCH_VIDEOS = 'EgIQAQ%3D%3D';     // search filter: videos only

class YtError extends Error {
    constructor(code, message) { super(message); this.code = code; }   // unavailable, live, age, botcheck, nofiles, changed, offline
}

/* ---------------- reading answers ---------------- */

const text = (t) => (!t ? '' : typeof t === 'string' ? t : t.simpleText != null ? String(t.simpleText) : t.content != null ? String(t.content)
    : Array.isArray(t.runs) ? t.runs.map((r) => r.text || '').join('') : '');
/** "1:09:25" -> 4165 */
function seconds(s) {
    s = String(s || '').trim();
    if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) return 0;
    return s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
}
function duration(sec) {
    if (!(sec > 0)) return '';
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}
/** Every object under `key` anywhere in o, in document order. */
function findAll(o, key, out, depth) {
    out = out || []; depth = depth || 0;
    if (!o || typeof o !== 'object' || depth > 40) return out;
    if (Array.isArray(o)) { o.forEach((x) => findAll(x, key, out, depth + 1)); return out; }
    Object.keys(o).forEach((k) => { if (k === key) out.push(o[k]); else findAll(o[k], key, out, depth + 1); });
    return out;
}

function fromVideoRenderer(v) {
    if (!v || !v.videoId) return null;
    const lenText = text(v.lengthText);
    const live = !lenText && findAll(v.badges || [], 'metadataBadgeRenderer').some((b) => /LIVE/.test(String(b.style || '') + text(b.label)));
    return {
        id: String(v.videoId), title: text(v.title), channel: text(v.ownerText || v.longBylineText || v.shortBylineText),
        seconds: seconds(lenText), duration: lenText, views: text(v.shortViewCountText || v.viewCountText), age: text(v.publishedTimeText),
        live: live || (!lenText && /watching/i.test(text(v.viewCountText))),
    };
}
/** The newer tile (lockupViewModel) as YouTube sends it for some searches. */
function fromLockup(l) {
    if (!l || !l.contentId || (l.contentType && !/VIDEO/.test(l.contentType))) return null;
    const meta = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
    const rows = findAll(meta, 'metadataParts').reduce((a, parts) => a.concat((parts || []).map((p) => text(p.text))), []).filter(Boolean);
    const badge = findAll(l.contentImage || {}, 'thumbnailBadgeViewModel').map((b) => String(b.text || '')).find((s) => /^\d+(:\d{1,2}){1,2}$/.test(s)) || '';
    return {
        id: String(l.contentId), title: text(meta.title), channel: rows[0] || '', seconds: seconds(badge), duration: badge,
        views: rows.find((r) => /view/i.test(r)) || '', age: rows.find((r) => /ago/i.test(r)) || '', live: /LIVE/i.test(JSON.stringify(l.contentImage || {}).slice(0, 4000)) && !badge,
    };
}

/** Search answer (first page or continuation) -> { items, continuation }. Exported for the tests. */
function parseSearch(data) {
    const items = [], seen = new Set();
    const add = (it) => { if (it && it.id && !seen.has(it.id) && !it.live) { seen.add(it.id); items.push(it); } };
    findAll(data, 'videoRenderer').forEach((v) => add(fromVideoRenderer(v)));
    findAll(data, 'lockupViewModel').forEach((l) => add(fromLockup(l)));
    const tokens = findAll(data, 'continuationCommand').map((c) => c && c.token).filter(Boolean);
    return { items, continuation: tokens.length ? tokens[tokens.length - 1] : null };
}

function context(client, o) {
    return { client: Object.assign({}, client, { hl: (o && o.hl) || 'en', gl: (o && o.gl) || 'US' }) };
}

/* ---------------- search ---------------- */

function search(q, o) {
    o = o || {};
    const body = { context: context(WEB, o) };
    if (o.continuation) body.continuation = o.continuation;
    else { body.query = String(q || '').slice(0, 200); body.params = decodeURIComponent(SEARCH_VIDEOS); }
    return net.json(BASE + 'search?prettyPrint=false', body, {
        headers: { 'User-Agent': WEB_UA, 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': WEB.clientVersion, Origin: 'https://www.youtube.com' },
        timeoutMs: 12000,
    }).then((data) => {
        const r = parseSearch(data);
        if (!r.items.length && !o.continuation && !findAll(data, 'itemSectionRenderer').length) {
            throw new YtError('changed', 'YouTube\'s search answer has no results list (it may have changed)');
        }
        return r;
    }).catch((e) => { throw wrapNet(e); });
}

/* ---------------- a video's files ---------------- */

/** Pick the files the app can play from one client's player answer. Exported for the tests. */
function pickFormats(data) {
    const sd = (data && data.streamingData) || {};
    const prog = (sd.formats || []).filter((f) => f && f.url);
    const adapt = (sd.adaptiveFormats || []).filter((f) => f && f.url);
    // the picture: H.264 Baseline (avc1.42xxxx) in MP4; itag 18 is YouTube's
    const baseline = (f) => /video\/mp4/.test(f.mimeType || '') && /avc1\.42/i.test(f.mimeType || '');
    const vids = prog.filter(baseline).concat(adapt.filter(baseline))
        .sort((a, b) => (a.itag === 18 ? -1 : b.itag === 18 ? 1 : (a.height || 0) - (b.height || 0)));
    const v = vids.find((f) => (f.height || 360) <= 480) || vids[0] || null;
    // the sound: AAC in MP4 (m4a), the car's media player takes it from a file
    const aacs = adapt.filter((f) => /^audio\/mp4/.test(f.mimeType || '') && /mp4a/.test(f.mimeType || ''))
        .sort((a, b) => (a.itag === 140 ? -1 : b.itag === 140 ? 1 : (b.bitrate || 0) - (a.bitrate || 0)));
    const a = aacs[0] || null;
    const num = (x) => (x == null || x === '' ? 0 : Number(x));
    return {
        video: v ? { url: v.url, size: num(v.contentLength), itag: v.itag, w: v.width || 0, h: v.height || 0, mime: v.mimeType } : null,
        audio: a ? { url: a.url, size: num(a.contentLength), itag: a.itag, mime: a.mimeType } : null,
    };
}

function playability(data) {
    const ps = (data && data.playabilityStatus) || {};
    const reason = text(ps.reason) || text(ps.messages && ps.messages[0]) || ps.status || 'no answer';
    if (ps.status === 'OK') return null;
    if (ps.status === 'LOGIN_REQUIRED') {
        if (/bot/i.test(reason)) return new YtError('botcheck', 'YouTube wants a sign-in to prove this is not a bot: ' + reason);
        return new YtError('age', 'YouTube wants a sign-in for this video (age or private): ' + reason);
    }
    if (ps.status === 'LIVE_STREAM_OFFLINE') return new YtError('live', 'a live stream: ' + reason);
    return new YtError('unavailable', reason);
}

function player(id, o) {
    o = o || {};
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(id))) return Promise.reject(new YtError('unavailable', 'bad video id'));
    const tried = [];
    const attempt = (k) => {
        if (k >= CLIENTS.length) {
            const why = tried.map((t) => t.name + ': ' + t.why).join('; ');
            const codes = tried.map((t) => t.code);
            const code = codes.indexOf('age') >= 0 ? 'age' : codes.indexOf('live') >= 0 ? 'live' : codes.every((c) => c === 'botcheck') ? 'botcheck'
                : codes.every((c) => c === 'unavailable') ? 'unavailable' : 'nofiles';
            return Promise.reject(new YtError(code, why || 'no answer'));
        }
        const c = CLIENTS[k];
        const headers = { 'User-Agent': c.ua, 'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': c.client.clientVersion, Origin: 'https://www.youtube.com' };
        const body = { videoId: id, context: context(c.client, o), contentCheckOk: true, racyCheckOk: true };
        return net.json(BASE + 'player?prettyPrint=false', body, { headers, timeoutMs: 12000 }).then((data) => {
            const bad = playability(data);
            if (bad) { tried.push({ name: c.name, why: bad.message, code: bad.code }); return attempt(k + 1); }
            const vd = data.videoDetails || {};
            if (vd.isLive || vd.isLiveContent && !(Number(vd.lengthSeconds) > 0)) {
                return Promise.reject(new YtError('live', 'live streams are not supported'));
            }
            const f = pickFormats(data);
            if (!f.audio) { tried.push({ name: c.name, why: 'no AAC sound file in the answer', code: 'nofiles' }); return attempt(k + 1); }
            const dlHeaders = { 'User-Agent': c.ua };
            // the addresses must really download (YouTube answers 403 for some clients from some addresses)
            return net.sizeOf(f.audio.url, dlHeaders).then((size) => {
                f.audio.size = f.audio.size || size;
                if (!f.video) return null;
                return net.sizeOf(f.video.url, dlHeaders).then((vs) => { f.video.size = f.video.size || vs; })
                    .catch((e) => { f.videoError = 'picture file refused: ' + e.message; f.video = null; });
            }).then(() => ({
                id, title: String(vd.title || ''), channel: String(vd.author || ''), seconds: Number(vd.lengthSeconds) || 0,
                video: f.video, audio: f.audio, videoError: f.videoError || (f.video ? null : 'no H.264 Baseline picture file'),
                client: c.name, headers: dlHeaders,
            }), (e) => { tried.push({ name: c.name, why: 'sound file refused: ' + e.message, code: 'nofiles' }); return attempt(k + 1); });
        }, (e) => {
            if (e.code === 'EOFFLINE') return Promise.reject(wrapNet(e));
            tried.push({ name: c.name, why: e.message, code: 'nofiles' });
            return attempt(k + 1);
        });
    };
    return attempt(0);
}

function wrapNet(e) {
    if (e instanceof YtError) return e;
    if (e && e.code === 'EOFFLINE') return new YtError('offline', e.message);
    return new YtError('changed', 'YouTube did not answer as expected: ' + (e && e.message || e));
}

module.exports = { search, player, parseSearch, pickFormats, playability, seconds, duration, CLIENTS, YtError, _findAll: findAll };
