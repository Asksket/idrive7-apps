'use strict';
/**
 * mp4.js - just enough ISO BMFF (MP4) to play a progressive download: the top-level boxes, the `moov` with its
 * tracks' sample tables, and the video track's H.264 parameter sets (avcC). Plus an H.264 SPS reader for the
 * picture's real size (the decoder hands out whole macroblocks: 640x368 for a 640x360 video).
 *
 *   const top = mp4.scanTop(readAt, size)      -> [{ type, start, size, header }] as far as the bytes go
 *   const movie = mp4.parseMoov(moovBuffer)    -> { timescale, duration, tracks: [...] }
 *   const v = movie.tracks.find((t) => t.kind === 'video' && t.codec === 'avc1')
 *   v.samples: { n, offset (Float64Array), size (Uint32Array), dts, pts (Float64Array, ms), key (Uint8Array) }
 *   v.avc: { lengthSize, sps: [Buffer], pps: [Buffer], profile, level }
 *
 * Only what YouTube's progressive MP4 (and ffmpeg's) uses: no fragments (moof), one sample description per
 * track. Throws on anything malformed; the caller treats that as "this file cannot be played".
 */

/* ---------------- boxes ---------------- */

/**
 * Top-level boxes of a file as far as the bytes go. readAt(pos, len) -> Buffer (may be shorter at the end of what
 * is there). A box whose header is not there yet ends the list.
 */
function scanTop(readAt, available) {
    const out = [];
    let pos = 0;
    while (pos + 8 <= available) {
        const h = readAt(pos, 16);
        if (h.length < 8) break;
        let size = h.readUInt32BE(0), header = 8;
        const type = h.toString('latin1', 4, 8);
        if (size === 1) {
            if (h.length < 16) break;
            size = h.readUInt32BE(8) * 4294967296 + h.readUInt32BE(12);
            header = 16;
        } else if (size === 0) size = Infinity;           // to the end of the file
        if (size < header) throw new Error('mp4: bad box ' + type + ' at ' + pos);
        out.push({ type, start: pos, size, header });
        if (!isFinite(size)) break;
        pos += size;
    }
    return out;
}

/** Child boxes of buf[start, end): [{ type, start (of the content), end }]. */
function children(buf, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
        let size = buf.readUInt32BE(p), header = 8;
        const type = buf.toString('latin1', p + 4, p + 8);
        if (size === 1) { size = buf.readUInt32BE(p + 8) * 4294967296 + buf.readUInt32BE(p + 12); header = 16; } else if (size === 0) size = end - p;
        if (size < header || p + size > end) throw new Error('mp4: bad box ' + type);
        out.push({ type, start: p + header, end: p + size });
        p += size;
    }
    return out;
}
function child(buf, box, type) { return children(buf, box.start, box.end).find((b) => b.type === type) || null; }
function path(buf, box, types) {
    let b = box;
    for (const t of types) { b = b && child(buf, b, t); if (!b) return null; }
    return b;
}

/* ---------------- moov ---------------- */

/** buf: the whole moov box (header included). */
function parseMoov(buf) {
    const top = children(buf, 0, buf.length);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('mp4: no moov');
    const mvhd = child(buf, moov, 'mvhd');
    const movie = { timescale: 1000, duration: 0, tracks: [] };
    if (mvhd) {
        const v = buf[mvhd.start];
        movie.timescale = buf.readUInt32BE(mvhd.start + (v === 1 ? 20 : 12));
        movie.duration = v === 1 ? u64(buf, mvhd.start + 24) : buf.readUInt32BE(mvhd.start + 16);
    }
    children(buf, moov.start, moov.end).filter((b) => b.type === 'trak').forEach((trak) => {
        try { movie.tracks.push(parseTrak(buf, trak, movie.timescale)); } catch (e) { movie.tracks.push({ kind: 'bad', error: String(e.message || e) }); }
    });
    return movie;
}

function parseTrak(buf, trak, movieScale) {
    const mdia = child(buf, trak, 'mdia');
    if (!mdia) throw new Error('mp4: track without mdia');
    const hdlr = child(buf, mdia, 'hdlr'), mdhd = child(buf, mdia, 'mdhd');
    const handler = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : '';
    const v = mdhd ? buf[mdhd.start] : 0;
    const timescale = mdhd ? buf.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12)) : 1000;
    const duration = mdhd ? (v === 1 ? u64(buf, mdhd.start + 24) : buf.readUInt32BE(mdhd.start + 16)) : 0;
    const stbl = path(buf, mdia, ['minf', 'stbl']);
    if (!stbl) throw new Error('mp4: track without stbl');
    const t = {
        kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler,
        timescale, duration, durationMs: timescale ? duration * 1000 / timescale : 0,
        codec: null, width: 0, height: 0, avc: null, samples: null,
    };
    const stsd = child(buf, stbl, 'stsd');
    if (stsd && buf.readUInt32BE(stsd.start + 4) >= 1) {
        const e = stsd.start + 8, size = buf.readUInt32BE(e);
        t.codec = buf.toString('latin1', e + 4, e + 8);
        if (t.kind === 'video') {
            t.width = buf.readUInt16BE(e + 8 + 24); t.height = buf.readUInt16BE(e + 8 + 26);
            if (t.codec === 'avc1' || t.codec === 'avc3') {
                // VisualSampleEntry: 8 (box header) + 78 bytes, then its boxes (avcC, pasp, ...)
                const sub = children(buf, e + 8 + 78, e + size);
                const avcC = sub.find((b) => b.type === 'avcC');
                if (avcC) t.avc = parseAvcC(buf.slice(avcC.start, avcC.end));
            }
        }
    }
    // edit list: the first entry's media time is where the track's time 0 is (a decoder delay)
    let shift = 0;
    const elst = path(buf, trak, ['edts', 'elst']);
    if (elst && buf.readUInt32BE(elst.start + 4) >= 1) {
        const ver = buf[elst.start], at = elst.start + 8;
        const mediaTime = ver === 1 ? u64(buf, at + 8) : buf.readInt32BE(at + 4);
        if (mediaTime > 0) shift = mediaTime;
        void movieScale;
    }
    t.samples = sampleTable(buf, stbl, timescale, shift);
    return t;
}

function sampleTable(buf, stbl, timescale, shift) {
    const box = (type) => child(buf, stbl, type);
    const stsz = box('stsz') || box('stz2');
    if (!stsz) throw new Error('mp4: no stsz');
    let n, sizeOf;
    if (stsz.type === 'stsz') {
        const fixed = buf.readUInt32BE(stsz.start + 4);
        n = buf.readUInt32BE(stsz.start + 8);
        sizeOf = fixed ? () => fixed : (i) => buf.readUInt32BE(stsz.start + 12 + i * 4);
    } else {
        const bits = buf[stsz.start + 7];
        n = buf.readUInt32BE(stsz.start + 8);
        const at = stsz.start + 12;
        sizeOf = bits === 8 ? (i) => buf[at + i] : bits === 16 ? (i) => buf.readUInt16BE(at + i * 2) : (i) => ((buf[at + (i >> 1)] >> ((i & 1) ? 0 : 4)) & 15);
    }
    if (n > 2000000) throw new Error('mp4: ' + n + ' samples');
    const s = {
        n, offset: new Float64Array(n), size: new Uint32Array(n), dts: new Float64Array(n), pts: new Float64Array(n),
        key: new Uint8Array(n), durMs: 0,
    };
    for (let i = 0; i < n; i++) s.size[i] = sizeOf(i);
    // chunk offsets
    const stco = box('stco'), co64 = box('co64');
    const cbox = stco || co64;
    if (!cbox) throw new Error('mp4: no stco');
    const nChunks = buf.readUInt32BE(cbox.start + 4);
    const chunkOff = (c) => (stco ? buf.readUInt32BE(stco.start + 8 + c * 4) : u64(buf, co64.start + 8 + c * 8));
    // sample to chunk
    const stsc = box('stsc');
    if (!stsc) throw new Error('mp4: no stsc');
    const ne = buf.readUInt32BE(stsc.start + 4);
    let i = 0;
    for (let e = 0; e < ne && i < n; e++) {
        const at = stsc.start + 8 + e * 12;
        const first = buf.readUInt32BE(at) - 1, per = buf.readUInt32BE(at + 4);
        const last = e + 1 < ne ? buf.readUInt32BE(at + 12) - 1 : nChunks;
        for (let c = first; c < last && i < n; c++) {
            let off = chunkOff(c);
            for (let k = 0; k < per && i < n; k++, i++) { s.offset[i] = off; off += s.size[i]; }
        }
    }
    if (i < n) throw new Error('mp4: sample table short');
    // decode times
    const stts = box('stts');
    if (!stts) throw new Error('mp4: no stts');
    let t = 0;
    i = 0;
    for (let e = 0, ne2 = buf.readUInt32BE(stts.start + 4); e < ne2 && i < n; e++) {
        const cnt = buf.readUInt32BE(stts.start + 8 + e * 8), d = buf.readUInt32BE(stts.start + 12 + e * 8);
        for (let k = 0; k < cnt && i < n; k++, i++) { s.dts[i] = t; t += d; }
    }
    for (; i < n; i++) s.dts[i] = t;
    // composition offsets (B-frames; none in Baseline)
    const ctts = box('ctts');
    for (i = 0; i < n; i++) s.pts[i] = s.dts[i];
    if (ctts) {
        const ver = buf[ctts.start];
        i = 0;
        for (let e = 0, ne3 = buf.readUInt32BE(ctts.start + 4); e < ne3 && i < n; e++) {
            const cnt = buf.readUInt32BE(ctts.start + 8 + e * 8);
            const off = ver === 1 ? buf.readInt32BE(ctts.start + 12 + e * 8) : buf.readUInt32BE(ctts.start + 12 + e * 8);
            for (let k = 0; k < cnt && i < n; k++, i++) s.pts[i] += off;
        }
    }
    const k = 1000 / (timescale || 1000);
    for (i = 0; i < n; i++) { s.dts[i] = (s.dts[i] - shift) * k; s.pts[i] = (s.pts[i] - shift) * k; }
    s.durMs = t * k;
    // sync samples: none listed = every sample is a key frame
    const stss = box('stss');
    if (stss) {
        for (let e = 0, m = buf.readUInt32BE(stss.start + 4); e < m; e++) {
            const idx = buf.readUInt32BE(stss.start + 8 + e * 4) - 1;
            if (idx >= 0 && idx < n) s.key[idx] = 1;
        }
    } else s.key.fill(1);
    return s;
}

function parseAvcC(b) {
    if (b.length < 7 || b[0] !== 1) throw new Error('mp4: bad avcC');
    const out = { profile: b[1], compat: b[2], level: b[3], lengthSize: (b[4] & 3) + 1, sps: [], pps: [] };
    let p = 5;
    const nsps = b[p++] & 31;
    for (let i = 0; i < nsps; i++) { const l = b.readUInt16BE(p); p += 2; out.sps.push(b.slice(p, p + l)); p += l; }
    const npps = b[p++];
    for (let i = 0; i < npps; i++) { const l = b.readUInt16BE(p); p += 2; out.pps.push(b.slice(p, p + l)); p += l; }
    return out;
}

function u64(buf, at) { return buf.readUInt32BE(at) * 4294967296 + buf.readUInt32BE(at + 4); }

/* ---------------- H.264 ---------------- */

const START = Buffer.from([0, 0, 0, 1]);

/** A length-prefixed access unit (MP4 sample) as an Annex B byte stream (start codes), optionally after the
 *  parameter sets (a key frame after a seek). */
function annexB(sample, lengthSize, prefix) {
    const parts = prefix ? prefix.slice() : [];
    let p = 0;
    while (p + lengthSize <= sample.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = len * 256 + sample[p + i];
        p += lengthSize;
        if (len <= 0 || p + len > sample.length) break;
        parts.push(START, sample.slice(p, p + len));
        p += len;
    }
    return Buffer.concat(parts);
}
/** The parameter sets as Annex B parts (for annexB's prefix). */
function paramSets(avc) {
    const out = [];
    avc.sps.forEach((s) => out.push(START, s));
    avc.pps.forEach((s) => out.push(START, s));
    return out;
}

/** Exp-Golomb bit reader over an RBSP (emulation prevention bytes removed). */
class Bits {
    constructor(nal) {
        const b = [];
        for (let i = 0; i < nal.length; i++) {
            if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
            b.push(nal[i]);
        }
        this.b = b; this.p = 0;
    }
    u(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = this.b[this.p >> 3]; if (byte === undefined) throw new Error('sps: short'); v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
    ue() { let z = 0; while (this.u(1) === 0) { if (++z > 31) throw new Error('sps: bad ue'); } return z ? Math.pow(2, z) - 1 + this.u(z) : 0; }
    se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
}

/** A sequence parameter set NAL (with its 1-byte header) -> { profile, level, width, height, crop, mbW, mbH }. */
function parseSps(nal) {
    const r = new Bits(nal);
    r.u(8);                                       // NAL header
    const profile = r.u(8); r.u(8); const level = r.u(8);
    r.ue();                                       // seq_parameter_set_id
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
        chroma = r.ue();
        if (chroma === 3) r.u(1);
        r.ue(); r.ue(); r.u(1);
        if (r.u(1)) {                             // seq_scaling_matrix_present_flag
            for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (r.u(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; } }
            }
        }
    }
    r.ue();                                       // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.u(1);                               // max_num_ref_frames, gaps
    const mbW = r.ue() + 1, mbHUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);                                       // direct_8x8_inference
    const mbH = mbHUnits * (2 - frameMbsOnly);
    const crop = { left: 0, right: 0, top: 0, bottom: 0 };
    if (r.u(1)) {
        const cx = chroma === 0 || chroma === 3 ? 1 : 2, cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
        crop.left = r.ue() * cx; crop.right = r.ue() * cx; crop.top = r.ue() * cy; crop.bottom = r.ue() * cy;
    }
    const fullW = mbW * 16, fullH = mbH * 16;
    return { profile, level, mbW, mbH, fullW, fullH, crop, width: fullW - crop.left - crop.right, height: fullH - crop.top - crop.bottom };
}

/** Index of the last key frame at or before time ms (0 when none). */
function keyAtOrBefore(s, ms) {
    let lo = 0, hi = s.n - 1, best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (s.pts[mid] <= ms) { lo = mid + 1; best = mid; } else hi = mid - 1;
    }
    for (let i = best; i >= 0; i--) if (s.key[i]) return i;
    return 0;
}

module.exports = { scanTop, parseMoov, parseAvcC, annexB, paramSets, parseSps, keyAtOrBefore, Bits };
