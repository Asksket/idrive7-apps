'use strict';
/**
 * test_tubecar.js - TubeCar's parts on a PC, under the head unit's Node (8) or newer:
 *
 *   python3 kit/tools/build.py --preview-only tubecar && node kit/tools/test_tubecar.js [--shots DIR]
 *
 * Needs ffmpeg for the sample video (H.264 Baseline + AAC, as YouTube's itag 18). Nothing here talks to YouTube or
 * to a car: YouTube, the uplink's DNS server, the MGU Store updater, the car's media player and the renderer are
 * stand-ins. The real H.264 decoder (h264bsd_wasm.js) is used only with --real-decoder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const netm = require('net');
const { execFileSync, fork } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const JS = path.join(ROOT, 'dist', 'tubecar', 'source', 'javascript');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tubecar-test-'));
const argv = process.argv.slice(2);
const SHOTS = argv.indexOf('--shots') >= 0 ? path.resolve(argv[argv.indexOf('--shots') + 1]) : null;
const REAL_DECODER = argv.indexOf('--real-decoder') >= 0;

let pass = 0, fail = 0;
function ok(c, what) { if (c) { pass++; console.log('  ok   ' + what); } else { fail++; console.log('  FAIL ' + what); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms, what) {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) { ok(false, what + ' (timed out)'); return false; } await sleep(20); }
    return true;
}
const log = { info() {}, warn() {}, error() {}, debug() {} };
if (process.env.VERBOSE) ['info', 'warn', 'error'].forEach((k) => { log[k] = (...a) => console.log('    [' + k + '] ' + a.join(' ')); });

if (!fs.existsSync(path.join(JS, 'app.js'))) { console.error('stage the app first: python3 kit/tools/build.py --preview-only tubecar'); process.exit(2); }
const req = (m) => require(path.join(JS, m));

/* ---------------- fixtures ---------------- */
const SAMPLE = path.join(TMP, 'v18.mp4'), AUDIO = path.join(TMP, 'a140.m4a');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '6', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', SAMPLE]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', SAMPLE, '-vn', '-c:a', 'copy', AUDIO]);
const MAIN_PROFILE = path.join(TMP, 'main.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '1', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', MAIN_PROFILE]);

// a decoder stand-in: every access unit gives a 640x368 picture (macroblock rows, as h264bsd) with Y = a counter
const FAKE_DEC = path.join(TMP, 'fake_decoder.js');
fs.writeFileSync(FAKE_DEC, [
    "'use strict';",
    'exports.create = () => { let n = 0; return {',
    '  decode(au) { if (!(au && au.length)) return null; n++; const w = 640, h = 368, pic = new Uint8Array(w * h * 3 / 2);',
    '    pic.fill(n & 255, 0, w * h); for (let r = 360; r < 368; r++) pic.fill(7, r * w, r * w + w); pic.fill(128, w * h); return { pic, w, h }; },',
    '  release() {} }; };',
].join('\n'));

/* ---------------- stand-ins: a DNS server (the uplink lease's), YouTube, media files ---------------- */
function dnsServer() {
    const s = dgram.createSocket('udp4');
    s.queries = [];
    s.on('message', (m, rinfo) => {
        // one question; answer every A query with 127.0.0.1
        let p = 12; const labels = [];
        while (m[p]) { labels.push(m.toString('latin1', p + 1, p + 1 + m[p])); p += m[p] + 1; }
        const qend = p + 5, qtype = m.readUInt16BE(p + 1);
        s.queries.push(labels.join('.'));
        const head = Buffer.from(m.slice(0, 12)); head.writeUInt16BE(0x8180, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(qtype === 1 ? 1 : 0, 6); head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
        const ans = qtype === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        s.send(Buffer.concat([head, m.slice(12, qend), ans]), rinfo.port, rinfo.address);
    });
    return new Promise((r) => s.bind(0, '127.0.0.1', () => r(s)));
}

function mediaServer(files) {
    const hits = { ranges: 0, search: [], player: [] };
    const srv = http.createServer((rq, rs) => {
        const u = rq.url;
        if (u.indexOf('/youtubei/v1/search') === 0) return body(rq, (b) => { hits.search.push(JSON.parse(b)); json(rs, searchAnswer(JSON.parse(b))); });
        if (u.indexOf('/youtubei/v1/player') === 0) return body(rq, (b) => { const j = JSON.parse(b); hits.player.push(j); json(rs, playerAnswer(j, srv.address().port)); });
        if (u === '/generate_204') { rs.writeHead(204); return rs.end(); }
        const m = /^\/media\/(\w+)/.exec(u);
        const f = m && files[m[1]];
        if (!f) { rs.writeHead(404); return rs.end(); }
        if (/refuse/.test(u)) { rs.writeHead(403); return rs.end(); }
        const data = fs.readFileSync(f), r = /bytes=(\d+)-(\d+)/.exec(rq.headers.range || '');
        if (!r) { rs.writeHead(200, { 'Content-Length': data.length }); return rs.end(data); }
        hits.ranges++;
        const a = Number(r[1]), b = Math.min(Number(r[2]), data.length - 1);
        rs.writeHead(206, { 'Content-Range': 'bytes ' + a + '-' + b + '/' + data.length, 'Content-Length': b - a + 1 });
        rs.end(data.slice(a, b + 1));
    });
    srv.hits = hits;
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function body(rq, cb) { const p = []; rq.on('data', (d) => p.push(d)); rq.on('end', () => cb(Buffer.concat(p).toString())); }
function json(rs, o) { const b = Buffer.from(JSON.stringify(o)); rs.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length }); rs.end(b); }
function searchAnswer(q) {
    if (q.continuation) return { onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [
        { videoRenderer: { videoId: 'cccccccccc3', title: { runs: [{ text: 'Third ' }, { text: 'video' }] }, ownerText: { runs: [{ text: 'Chan C' }] }, lengthText: { simpleText: '1:02:03' } } },
    ] } }] };
    return { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
        { itemSectionRenderer: { contents: [
            { videoRenderer: { videoId: 'aaaaaaaaaa1', title: { runs: [{ text: 'Țară și munți — “test” ' + q.query }] }, ownerText: { runs: [{ text: 'Chan A' }] }, lengthText: { simpleText: '4:05' }, shortViewCountText: { simpleText: '12K views' }, publishedTimeText: { simpleText: '2 days ago' } } },
            { videoRenderer: { videoId: 'livelivelv0', title: { simpleText: 'A live one' }, viewCountText: { runs: [{ text: '1,234 watching' }] } } },
            { lockupViewModel: { contentId: 'bbbbbbbbbb2', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '10:00' } }] } }] } },
                metadata: { lockupMetadataViewModel: { title: { content: 'Second video' }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Chan B' } }] }, { metadataParts: [{ text: { content: '3M views' } }, { text: { content: '5 years ago' } }] }] } } } } } },
        ] } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN1' } } } },
    ] } } } } };
}
function playerAnswer(j, port) {
    const c = j.context.client.clientName;
    if (c === 'ANDROID_VR') return { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you\'re not a bot' } };
    const base = 'http://media.test:' + port + '/media/';
    return {
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: j.videoId, title: 'Sample video', author: 'Chan A', lengthSeconds: '6' },
        streamingData: {
            formats: [{ itag: 18, url: base + 'v18?x=1', mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', width: 640, height: 360 }],
            adaptiveFormats: [
                { itag: 137, url: base + 'v137', mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
                { itag: 251, url: base + 'a251', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
                { itag: 140, url: base + 'a140', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: String(fs.statSync(AUDIO).size) },
            ],
        },
    };
}

/* ---------------- tests ---------------- */
async function main() {
    console.log('Node ' + process.version + ', staged app ' + JS);

    console.log('mp4.js');
    const mp4 = req('mp4.js');
    const buf = fs.readFileSync(SAMPLE);
    const top = mp4.scanTop((p, l) => buf.slice(p, p + l), buf.length);
    ok(top.map((b) => b.type).join(',').indexOf('ftyp,moov') === 0, 'progressive file: moov right after ftyp (' + top.map((b) => b.type).join(',') + ')');
    const moovBox = top.find((b) => b.type === 'moov');
    const movie = mp4.parseMoov(buf.slice(moovBox.start, moovBox.start + moovBox.size));
    const v = movie.tracks.find((t) => t.kind === 'video');
    const a = movie.tracks.find((t) => t.kind === 'audio');
    ok(v && v.codec === 'avc1' && v.width === 640 && v.height === 360, 'video track avc1 640x360');
    ok(a && a.codec === 'mp4a', 'audio track mp4a');
    ok(v.samples.n === 180, '180 pictures (6 s at 30 fps): ' + v.samples.n);
    ok(Array.prototype.filter.call(v.samples.key, (k) => k).length === 6, 'a key frame every 30 pictures');
    ok(Math.abs(v.samples.pts[30] - 1000) < 1 && v.samples.pts[0] === 0, 'times in ms');
    let inside = true;
    for (let i = 0; i < v.samples.n; i++) if (v.samples.offset[i] + v.samples.size[i] > buf.length) inside = false;
    ok(inside, 'every sample inside the file');
    ok(v.avc.profile === 66 && v.avc.lengthSize === 4 && v.avc.sps.length === 1 && v.avc.pps.length === 1, 'avcC: Baseline, 4-byte lengths, one SPS and PPS');
    const sps = mp4.parseSps(v.avc.sps[0]);
    ok(sps.fullW === 640 && sps.fullH === 368 && sps.width === 640 && sps.height === 360 && sps.crop.bottom === 8, 'SPS: 640x368 decoded, cropped to 640x360');
    const s0 = buf.slice(v.samples.offset[0], v.samples.offset[0] + v.samples.size[0]);
    const au = mp4.annexB(s0, 4, mp4.paramSets(v.avc));
    ok(au.readUInt32BE(0) === 1 && (au[4] & 31) === 7, 'Annex B: start code, SPS first');
    ok(Array.prototype.indexOf.call(au, 5) >= 0 && au.length > s0.length, 'Annex B: key frame after the parameter sets');
    ok(mp4.keyAtOrBefore(v.samples, 2500) === 60 && mp4.keyAtOrBefore(v.samples, 0) === 0, 'key frame at or before a time');
    const mbuf = fs.readFileSync(MAIN_PROFILE), mtop = mp4.scanTop((p, l) => mbuf.slice(p, p + l), mbuf.length), mm = mtop.find((b) => b.type === 'moov');
    const mv = mp4.parseMoov(mbuf.slice(mm.start, mm.start + mm.size)).tracks.find((t) => t.kind === 'video');
    ok(mp4.parseSps(mv.avc.sps[0]).profile === 77, 'Main profile told apart (the decoder refuses it)');

    console.log('mgvf.js');
    const { FrameFile, readHeader, MAGIC } = req('mgvf.js');
    let threw = false;
    try { new FrameFile(path.join(TMP, 'x')); } catch (e) { threw = true; }
    ok(threw, 'only /dev/shm/mgu-video-<name> without anyPath');
    const ff = new FrameFile(path.join(TMP, 'frames'), { anyPath: true }).open(640, 360, 0);
    const fsz = 640 * 360 * 3 / 2;
    ok(fs.statSync(ff.path).size === 64 + 3 * fsz, 'file: header + 3 slots');
    let h = readHeader(ff.path);
    ok(h.magic === MAGIC && h.version === 1 && h.w === 640 && h.h === 360 && h.nslot === 3 && h.seq === 0 && h.slot === 2, 'header');
    ff.write(Buffer.alloc(fsz, 1)); ff.write(Buffer.alloc(fsz, 2));
    h = readHeader(ff.path);
    ok(h.seq === 2 && h.slot === 1, 'seq and slot advance (slot 0, then 1)');
    const pic = Buffer.alloc(640 * 368 * 3 / 2, 9);
    for (let r = 360; r < 368; r++) pic.fill(77, r * 640, r * 640 + 640);
    ff.write({ y: pic, u: pic, v: pic, yOff: 0, uOff: 640 * 368, vOff: 640 * 368 + 320 * 184, stride: 640, cstride: 320 });
    const raw = fs.readFileSync(ff.path), slot2 = raw.slice(64 + 2 * fsz, 64 + 3 * fsz);
    ok(readHeader(ff.path).slot === 2 && slot2.indexOf(77) < 0 && slot2[0] === 9, 'cropped planes: the padding rows are left out');
    ff.close();
    ok(!fs.existsSync(ff.path), 'close removes the file');

    console.log('decoder_child.js (stand-in decoder)');
    const frames = path.join(TMP, 'mgu-video-test');
    const child = fork(path.join(JS, 'decoder_child.js'), [], { env: Object.assign({}, process.env, { TUBECAR_FAKE_DECODER: FAKE_DEC, TUBECAR_ANY_FRAME_PATH: '1' }), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const evs = [];
    child.on('message', (m) => evs.push(m));
    child.send({ op: 'open', file: SAMPLE, frames, avail: buf.length, done: true });
    child.send({ op: 'clock', ms: 0, at: Date.now() });
    await until(() => evs.some((e) => e.ev === 'ready'), 3000, 'ready');
    const ready = evs.find((e) => e.ev === 'ready') || {};
    ok(ready.w === 640 && ready.h === 360 && Math.round(ready.fps) === 30, 'ready: 640x360 at 30 fps (' + JSON.stringify(ready) + ')');
    await sleep(300);
    const paused0 = readHeader(frames).seq;
    ok(paused0 === 1, 'before the clock runs: the first picture, held (' + paused0 + ')');
    child.send({ op: 'resume' });
    await sleep(1000);
    const after1s = readHeader(frames).seq;
    ok(after1s >= 25 && after1s <= 34, 'running: ~30 pictures a second, on time (' + after1s + ')');
    child.send({ op: 'pause' });
    await sleep(100);
    const p1 = readHeader(frames).seq; await sleep(500); const p2 = readHeader(frames).seq;
    ok(p2 - p1 <= 1, 'paused: no new pictures');
    child.send({ op: 'seek', ms: 4000 });
    await sleep(300);
    ok(readHeader(frames).seq > p2, 'seek: the picture there at once, also while paused');
    child.send({ op: 'video', on: false });
    await sleep(100);
    const v1 = readHeader(frames).seq; child.send({ op: 'resume' }); await sleep(400);
    ok(readHeader(frames).seq === v1, 'video off (driving): nothing decoded or written');
    child.send({ op: 'video', on: true }); await sleep(400);
    ok(readHeader(frames).seq > v1, 'video on again: goes on at the clock');
    await until(() => evs.some((e) => e.ev === 'stats'), 3000, 'stats');
    const exit1 = new Promise((r) => child.on('exit', (c) => r(c)));
    child.disconnect();
    ok(await Promise.race([exit1, sleep(2000).then(() => 'still running')]) === 0, 'the app\'s channel closed: the decoder exits');

    const bad = fork(path.join(JS, 'decoder_child.js'), [], { env: Object.assign({}, process.env, { TUBECAR_FAKE_DECODER: FAKE_DEC, TUBECAR_ANY_FRAME_PATH: '1' }), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const bevs = []; bad.on('message', (m) => bevs.push(m));
    bad.send({ op: 'open', file: MAIN_PROFILE, frames: path.join(TMP, 'mgu-video-bad'), avail: mbuf.length, done: true });
    await until(() => bevs.some((e) => e.ev === 'error'), 3000, 'main profile refused');
    ok(bevs.some((e) => e.ev === 'error' && e.fatal && /Baseline/.test(e.msg)), 'a Main profile video: a clear error, no crash');
    bad.send({ op: 'quit' });

    if (REAL_DECODER) {
        console.log('decoder_child.js (h264bsd WebAssembly)');
        const real = fork(path.join(JS, 'decoder_child.js'), [], { env: Object.assign({}, process.env, { TUBECAR_ANY_FRAME_PATH: '1' }), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        const revs = []; real.on('message', (m) => revs.push(m));
        const rframes = path.join(TMP, 'mgu-video-real');
        real.send({ op: 'open', file: SAMPLE, frames: rframes, avail: buf.length, done: true });
        real.send({ op: 'clock', ms: 0, at: Date.now() }); real.send({ op: 'resume' });
        await until(() => revs.some((e) => e.ev === 'stats' && e.shown > 0) || revs.some((e) => e.ev === 'error'), 8000, 'real decoder pictures');
        const err = revs.find((e) => e.ev === 'error');
        ok(!err, 'h264bsd decodes the sample' + (err ? ': ' + err.msg : ''));
        await sleep(2500);
        const st = revs.filter((e) => e.ev === 'stats').pop() || {};
        ok(st.fps >= 25, 'h264bsd keeps up with 640x360 at 30 fps on this machine (' + st.fps + ' fps, ' + st.dropped + ' dropped)');
        if (fs.existsSync(rframes)) {
            // the decoded picture against ffmpeg's: frame at the slot written last
            const hh = readHeader(rframes), sz = hh.w * hh.h * 3 / 2, data = fs.readFileSync(rframes).slice(64 + hh.slot * sz, 64 + (hh.slot + 1) * sz);
            const y = data.slice(0, hh.w * hh.h);
            let sum = 0; for (let i = 0; i < y.length; i += 97) sum += y[i];
            ok(sum / (y.length / 97) > 16, 'the picture is not empty (mean luma ' + (sum / (y.length / 97)).toFixed(1) + ')');
        }
        real.send({ op: 'quit' });
    }

    console.log('net.js (names through the uplink lease\'s DNS server)');
    const dns = await dnsServer();
    const srv = await mediaServer({ v18: SAMPLE, a140: AUDIO, v137: SAMPLE });
    const port = srv.address().port;
    const lease = path.join(TMP, 'lease.json');
    fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['127.0.0.1:' + dns.address().port] }));
    process.env.TUBECAR_LEASE = lease;
    process.env.TUBECAR_YT_BASE = 'http://www.youtube.test:' + port + '/youtubei/v1/';
    process.env.TUBECAR_CHECK_URL = 'http://check.test:' + port + '/generate_204';
    const net = req('net.js');
    net.init(TMP);
    ok(net.lease() && net.lease().interface === 'vethuplink', 'lease read');
    const chk = await net.check();
    ok(chk.online && dns.queries.indexOf('check.test') >= 0, 'online check: name resolved by the lease\'s server, 204 answered');
    const out = path.join(TMP, 'dl.mp4');
    const progress = [];
    const d = net.download('http://media.test:' + port + '/media/v18', out, { parallel: 3, chunk: 65536, onProgress: (g, s, c) => progress.push(c) });
    await d.promise;
    ok(fs.readFileSync(out).equals(buf), 'ranged parallel download: the same bytes (' + srv.hits.ranges + ' ranges)');
    ok(progress.length > 3 && progress.every((c, i) => i === 0 || c >= progress[i - 1]), 'contiguous bytes only grow');
    ok((fs.statSync(out).mode & 0o777) === 0o644, 'file readable by the car\'s media engine (0644)');
    const d2 = net.download('http://media.test:' + port + '/media/v18', path.join(TMP, 'dl2.mp4'), { parallel: 1, chunk: 4096 });
    setTimeout(() => d2.abort(), 30);
    let aborted = null;
    try { await d2.promise; } catch (e) { aborted = e.code; }
    ok(aborted === 'EABORTED', 'abort ends a download (' + aborted + ')');
    let refused = null;
    try { await net.download('http://media.test:' + port + '/media/v18?refuse', path.join(TMP, 'dl3'), { size: 100 }).promise; } catch (e) { refused = e.message; }
    ok(/403/.test(String(refused)), 'a refused download says so');
    fs.writeFileSync(lease + '.off', '');
    process.env.TUBECAR_LEASE = lease + '.off';
    net.init(path.join(TMP, 'nodata'));
    fs.mkdirSync(path.join(TMP, 'nodata'));
    fs.writeFileSync(path.join(TMP, 'nodata', 'uplink.json'), '{}');
    await sleep(2100);
    net._dnsCache.clear();
    const off = await net.check();
    ok(!off.online && off.why === 'no-uplink', 'no lease: offline, without trying the system resolver (' + off.why + ')');
    process.env.TUBECAR_LEASE = lease;
    net.init(TMP);
    await sleep(2100);

    console.log('yt.js (YouTube stand-in)');
    const yt = req('yt.js');
    const r1 = await yt.search('cats', { hl: 'ro', gl: 'RO' });
    ok(r1.items.map((x) => x.id).join() === 'aaaaaaaaaa1,bbbbbbbbbb2', 'search: videoRenderer and lockupViewModel tiles, live left out');
    ok(r1.items[0].seconds === 245 && r1.items[0].channel === 'Chan A' && r1.items[1].duration === '10:00' && r1.items[1].channel === 'Chan B', 'durations and channels');
    ok(r1.continuation === 'TOKEN1' && srv.hits.search[0].context.client.hl === 'ro' && srv.hits.search[0].params, 'continuation token, language, videos-only filter');
    const r2 = await yt.search(null, { continuation: 'TOKEN1' });
    ok(r2.items.length === 1 && r2.items[0].seconds === 3723 && r2.items[0].title === 'Third video', 'more results');
    const pl = await yt.player('aaaaaaaaaa1');
    ok(pl.client === 'ios' && srv.hits.player.map((x) => x.context.client.clientName).join() === 'ANDROID_VR,IOS', 'player: a bot check moves on to the next client');
    ok(pl.video && pl.video.itag === 18 && pl.video.size === buf.length, 'picture: itag 18 (Baseline), its size asked');
    ok(pl.audio && pl.audio.itag === 140 && pl.audio.size === fs.statSync(AUDIO).size, 'sound: itag 140 (AAC), not Opus');
    let bad2 = null;
    try { await yt.player('short'); } catch (e) { bad2 = e.code; }
    ok(bad2 === 'unavailable', 'bad id refused');

    console.log('ui.js text');
    const ui = req('ui.js');
    ok(ui.fold('Țară și munți — “test” …') === 'Tara si munti - "test" ...', 'fold: Romanian letters, quotes, dashes (' + ui.fold('Țară și munți — “test” …') + ')');
    ok(ui.time(3723000) === '1:02:03' && ui.time(65000) === '1:05', 'times');

    console.log('wifi.js');
    const wifi = req('wifi.js');
    ok(wifi.WifiConfig.check('', 'x') && wifi.WifiConfig.check('Home', 'short') && !wifi.WifiConfig.check('Home', 'longenough') && !wifi.WifiConfig.check('Open', ''), 'checks as mgu-uplink does');
    const wdir = path.join(TMP, 'wifi'); fs.mkdirSync(wdir);
    const cfg = new wifi.WifiConfig(wdir, log);
    cfg.save('Phone', 'secret-pass', true);
    ok((fs.statSync(path.join(wdir, 'wifi.json')).mode & 0o777) === 0o600, 'saved readable by the app only (0600)');
    ok(new wifi.WifiConfig(wdir, log).psk === 'secret-pass', 'read back');
    // the MGU Store updater stand-in: state on connect, "forbidden" for wifi-connect (an app has no secret)
    const sock = path.join(TMP, 'updater.sock'), status = path.join(TMP, 'status.json');
    const upd = netm.createServer((c) => {
        c.write(JSON.stringify({ type: 'state', online: false }) + '\n');
        let b = '';
        c.on('data', (dd) => {
            b += dd; const i = b.indexOf('\n'); if (i < 0) return;
            const m = JSON.parse(b.slice(0, i)); upd.got = m;
            c.write(JSON.stringify({ type: 'error', op: m.op, rid: m.rid, error: 'forbidden' }) + '\n');
        });
    });
    await new Promise((r) => upd.listen(sock, r));
    process.env.TUBECAR_UPDATER_SOCK = sock;
    process.env.TUBECAR_UPLINK_STATUS = status;
    delete require.cache[path.join(JS, 'wifi.js')];
    const wifi2 = req('wifi.js');
    fs.writeFileSync(status, JSON.stringify({ state: 'searching', device: null, wifi: { enabled: true, link: 'idle', saved: [], networks: [{ ssid: 'Phone' }] } }));
    const offline = () => Promise.resolve({ online: false, why: 'no-uplink' });
    const e1 = await wifi2.ensureConnected(cfg, offline, log);
    ok(e1.why === 'forbidden' && /MGU Store/.test(e1.message) && upd.got && upd.got.op === 'wifi-connect' && upd.got.ssid === 'Phone', 'offline: asks the updater, "forbidden" explained (' + e1.message + ')');
    fs.writeFileSync(status, JSON.stringify({ state: 'searching', device: null, wifi: { enabled: true, link: 'scanning', saved: ['Phone'], networks: [] } }));
    upd.got = null;
    const e2 = await wifi2.ensureConnected(cfg, offline, log);
    ok(e2.why === 'waiting' && !upd.got, 'a network the car already saved: waits for it, asks nothing');
    const e3 = await wifi2.ensureConnected(cfg, () => Promise.resolve({ online: true }), log);
    ok(e3.online && e3.tone === 'ok', 'online');
    fs.unlinkSync(status);
    upd.close();

    console.log('watchdog.js');
    const { Watchdog } = req('watchdog.js');
    let rss = 100, kid = 0, trips = 0;
    const wdg = new Watchdog({ log, limitKB: 1000 / 1024, ratio: 0.7, rss: () => rss, children: () => [42], childRss: () => kid, onTrip: () => trips++ });
    wdg.check();
    ok(trips === 0, 'under 70 %: nothing');
    rss = 500; kid = 210; wdg.check();
    ok(trips === 1, 'app + decoder past 70 %: trips');
    wdg.check();
    ok(trips === 1, 'once, until reset');
    wdg.reset(); wdg.check();
    ok(trips === 2, 'again after reset');
    ok(req('watchdog.js').limitKB() === 262144, 'the limit from the staged package.json (memoryKB 262144)');

    console.log('player.js (stand-ins: the car\'s player, the renderer, the decoder)');
    process.env.TUBECAR_MEDIA_DIR = TMP;
    const framesP = path.join(TMP, 'mgu-video-player');
    process.env.TUBECAR_FRAMES = framesP;
    const { Player } = req('player.js');
    const fa = fakeAudio(), fd = fakeDisplay();
    let moving = false;
    const pl2 = new Player({ log, audio: fa, display: fd, parked: { moving: () => moving }, settings: { get: () => null },
        childEnv: { TUBECAR_FAKE_DECODER: FAKE_DEC, TUBECAR_ANY_FRAME_PATH: '1' } });
    pl2.setVisible(true);
    const playing = pl2.play({ id: 'aaaaaaaaaa1', title: 'x' });
    await playing;
    ok(pl2.view().state === 'playing' && fa.played.length === 1 && /a-aaaaaaaaaa1\.m4a$/.test(fa.played[0]), 'sound downloaded whole, then handed to the car\'s player');
    if (!fa.played.length) { console.log('    player: ' + JSON.stringify(pl2.view())); process.exit(1); }
    ok(fs.readFileSync(fa.played[0]).equals(fs.readFileSync(AUDIO)), 'the sound file is complete');
    ok((fs.statSync(path.dirname(fa.played[0])).mode & 0o777) === 0o711, 'media folder 0711 (the media engine opens by name)');
    fa.tick(0, 6000);
    await until(() => fd.named.length === 1, 4000, 'frame file named to the renderer');
    ok(fd.named[0] === framesP && pl2.view().video, 'decoder ready: frame file named, the page draws the video');
    const pid = pl2.childPids()[0];
    ok(pid > 0 && alive(pid), 'the decoder process runs');
    moving = true; await sleep(700);
    ok(!pl2.view().video && /driving/.test(pl2.view().videoWhy), 'driving: no picture (' + pl2.view().videoWhy + ')');
    moving = false; await sleep(700);
    ok(pl2.view().video, 'parked again: the picture is back');
    pl2.setVisible(false);
    await sleep(1200);
    ok(!alive(pid) && fd.dropped >= 1 && !fs.existsSync(framesP), 'screen left: decoder killed, frame file unnamed and removed');
    ok(pl2.view().state === 'playing', 'screen left: the sound goes on');
    pl2.setVisible(true);
    await until(() => pl2.childPids().length === 1, 3000, 'decoder back when shown');
    const pid2 = pl2.childPids()[0];
    const files = fs.readdirSync(TMP).filter((f) => /^tubecar-/.test(f)).map((f) => path.join(TMP, f));
    await pl2.stop('user');
    ok(!alive(pid2), 'stop: decoder process gone');
    ok(fa.released === 1, 'stop: the speakers given back (STOP + disconnect)');
    ok(files.every((dd) => fs.readdirSync(dd).length === 0), 'stop: sound and picture files removed');
    ok(pl2.childPids().length === 0 && pl2.view().state === 'idle' && !pl2.active(), 'stop: nothing held');
    // a memory trip mid-play
    await pl2.play({ id: 'aaaaaaaaaa1', title: 'x' });
    fa.tick(0, 6000);
    await until(() => pl2.childPids().length === 1, 3000, 'decoder');
    const pid3 = pl2.childPids()[0];
    const wd2 = new Watchdog({ log, limitKB: 1, ratio: 0.7, children: () => pl2.childPids(), onTrip: () => pl2.stop('memory') });
    wd2.check();
    await until(() => !pl2.active(), 3000, 'memory trip stops playback');
    await sleep(300);
    ok(!alive(pid3) && pl2.view().state === 'error' && /memory/.test(pl2.view().msg), 'watchdog: playback stopped, decoder gone, said why');
    // a decoder that dies twice: sound only, said so
    pl2.dispose();

    if (SHOTS) await shots(ui, req);

    srv.close(); dns.close();
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
function fakeAudio() {
    const hs = { time: [], state: [], error: [] };
    const fa = {
        played: [], released: 0, stopped: 0, seeks: [],
        available: () => true, on: (e, fn) => hs[e].push(fn),
        play: (f) => { fa.played.push(f); fa.conn = true; setTimeout(() => hs.state.forEach((fn) => fn('play')), 10); return Promise.resolve(); },
        stop: () => { fa.stopped++; return Promise.resolve(); },
        seek: (ms) => { fa.seeks.push(ms); return Promise.resolve(); },
        release: () => { if (fa.conn) { fa.conn = false; fa.released++; } return Promise.resolve(); },
        releaseNow: () => {},
        tick: (el, tot) => hs.time.forEach((fn) => fn({ elapsed: el, total: tot })),
    };
    return fa;
}
function fakeDisplay() {
    const fd = { named: [], dropped: 0, videoReady: () => true };
    fd.video = (id, file) => { if (file) fd.named.push(file); else fd.dropped++; };
    return fd;
}

/** --shots DIR: each page drawn in software as PNG, to look at. */
async function shots(ui) {
    console.log('pages -> ' + SHOTS);
    SHOTS.split(path.sep).reduce((acc, part) => { const p = acc + part + path.sep; if (part && !fs.existsSync(p)) fs.mkdirSync(p); return p; }, path.isAbsolute(SHOTS) ? '' : '');
    const rec = require(path.join(JS, 'kit', 'record.js')), { Canvas } = require(path.join(JS, 'kit', 'canvas.js'));
    const themes = require(path.join(JS, 'kit', 'themes.js'));
    const { Keyboard } = require(path.join(JS, 'keyboard.js'));
    const t = themes.theme('m_tricolour');
    const noop = () => {};
    const act = new Proxy({}, { get: () => noop });
    const kb = new Keyboard({ text: 'lofi hip hop' });
    const base = { tab: 0, kb, recent: ['lofi hip hop', 'bmw m5 review', 'romanian news'], results: null, resPage: 0, net: { checked: true, online: true }, netMsg: null, player: { state: 'idle' }, act,
        wifi: { ssid: 'iPhone Mario', psk: 'secret-pass', auto: true, savedSsid: 'iPhone Mario' } };
    const items = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'id' + i, title: 'Țară video number ' + i + ' with a fairly long title that goes on and on', channel: 'Channel ' + i, duration: '1' + i + ':0' + i, views: i + 'K views', age: i + ' days ago' }));
    const pages = {
        search: base,
        results: Object.assign({}, base, { tab: 1, results: { q: 'lofi hip hop', items, continuation: 'x' } }),
        player: Object.assign({}, base, { tab: 2, nowId: 'id1', player: { state: 'playing', title: items[0].title, channel: 'Channel 1', posMs: 83000, durMs: 245000, videoWhy: 'Picture off while driving', loadedPct: 40, soundWhy: '' } }),
        player_loading: Object.assign({}, base, { tab: 2, player: { state: 'loading', msg: 'Loading the sound...', pct: 42, title: 'Sample', channel: 'Chan', videoWhy: 'Picture: loading' } }),
        player_error: Object.assign({}, base, { tab: 2, player: { state: 'error', msg: 'Playback stopped: TubeCar was using 70 % of the memory the car allows it.' } }),
        wifi: Object.assign({}, base, { tab: 3, netMsg: { tone: 'warn', message: 'No internet. The car lets only the MGU Store join Wi-Fi networks: open MGU Store > Settings > Wi-Fi and join "iPhone Mario" once. After that the car joins it by itself.' } }),
        wifi_edit: Object.assign({}, base, { tab: 3, wifi: Object.assign({}, base.wifi, { editing: 'psk', kb: new Keyboard({ text: 'secret', secret: true }) }) }),
        offline: Object.assign({}, base, { net: { checked: true, online: false }, netMsg: { tone: 'warn', message: 'No internet: the car has no MGU Store uplink.' } }),
    };
    Object.keys(pages).forEach((name) => {
        const r = new rec.Recorder(1600, 520);
        r.own = true;
        r.clear(t.bg);
        ui.draw(r, t, pages[name]);
        const cv = new Canvas(1600, 520);
        rec.play(r.words(), cv);
        fs.writeFileSync(path.join(SHOTS, name + '.png'), cv.png());
        console.log('  ' + name + '.png (' + r.targets.length + ' targets)');
    });
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
