'use strict';
/**
 * mgvf.js - writes decoded pictures where the GPU renderer reads them: mgu-render's video frame file
 * (kit/renderd/PROTOCOL.md, "Video"). The app names the file to the renderer (display.video) and draws a
 * VIDEO op (record.js video()); the renderer shows the newest frame each time it draws.
 *
 * File: a 64-byte header (16 little-endian u32 words), then NSLOT frames of w*h*3/2 bytes, I420 (Y, then U,
 * then V, rows without padding). Word 0 magic "MGVF", 1 version 1, 2-3 w h (even, 16..2048), 4 seq (frames
 * written), 5 slot (the newest frame's), 6 nslot, 7 matrix (0 BT.601, 1 BT.709), 8 range (0 limited).
 * A frame goes to slot (slot + 1) % nslot first, then slot is set, then seq + 1: the renderer, reading the
 * header and then that slot, is always two frames away from the one being written.
 *
 * The file is this process's (the app's uid), which the renderer accepts; it is opened without following a
 * link. Node 8: fs only, no mmap.
 */
const fs = require('fs');

const MAGIC = 0x4656474d, NSLOT = 3, HEAD = 64;
const NAME_RE = /^\/dev\/shm\/mgu-video-[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

class FrameFile {
    /** path: /dev/shm/mgu-video-<name> (the renderer takes no other); opts.anyPath: any path (tests) */
    constructor(path, opts) {
        if (!(opts && opts.anyPath) && !NAME_RE.test(path)) throw new Error('mgvf: bad frame file name ' + path);
        this.path = path;
        this.fd = null;
        this.w = 0; this.h = 0; this.size = 0;
        this.seq = 0; this.slot = 0;
        this.head = Buffer.alloc(HEAD);
        this.word = Buffer.alloc(4);
    }
    /** (Re)make the file for w x h pictures. matrix: 0 BT.601 (SD), 1 BT.709 (HD). */
    open(w, h, matrix) {
        w &= ~1; h &= ~1;
        if (w < 16 || h < 16 || w > 2048 || h > 2048) throw new Error('mgvf: size ' + w + 'x' + h);
        if (w * h * 3 > 12 * 1024 * 1024) throw new Error('mgvf: ' + w + 'x' + h + ' is past the renderer\'s 12 MiB per app');
        if (this.fd === null) {
            const c = fs.constants;
            // O_NOFOLLOW: a link planted under the name leads nowhere
            this.fd = fs.openSync(this.path, c.O_RDWR | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o644);
        }
        this.w = w; this.h = h; this.size = w * h * 3 / 2;
        this.seq = 0; this.slot = NSLOT - 1;
        fs.ftruncateSync(this.fd, HEAD + NSLOT * this.size);
        const b = this.head;
        b.fill(0);
        b.writeUInt32LE(MAGIC, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(w, 8); b.writeUInt32LE(h, 12);
        b.writeUInt32LE(0, 16); b.writeUInt32LE(this.slot, 20); b.writeUInt32LE(NSLOT, 24);
        b.writeUInt32LE(matrix ? 1 : 0, 28); b.writeUInt32LE(0, 32);
        fs.writeSync(this.fd, b, 0, HEAD, 0);
        return this;
    }
    /**
     * Write one picture. Either a packed I420 buffer of w*h*3/2 bytes, or planes { y, u, v, stride, cstride }
     * with row strides (a decoder's picture that is wider than the picture shown: rows are cropped here).
     */
    write(pic) {
        if (this.fd === null || !this.size) throw new Error('mgvf: not open');
        const next = (this.slot + 1) % NSLOT, base = HEAD + next * this.size;
        if (Buffer.isBuffer(pic) || pic instanceof Uint8Array) {
            if (pic.length < this.size) throw new Error('mgvf: short frame');
            const buf = Buffer.isBuffer(pic) ? pic : Buffer.from(pic.buffer, pic.byteOffset, this.size);
            fs.writeSync(this.fd, buf, 0, this.size, base);
        } else {
            this._planes(pic, base);
        }
        // slot first, then seq (the renderer reads seq to know a new frame is there)
        this.slot = next; this.seq = (this.seq + 1) >>> 0;
        this.word.writeUInt32LE(this.slot, 0); fs.writeSync(this.fd, this.word, 0, 4, 20);
        this.word.writeUInt32LE(this.seq, 0); fs.writeSync(this.fd, this.word, 0, 4, 16);
        return this.seq;
    }
    _planes(p, base) {
        const w = this.w, h = this.h, cw = w >> 1, ch = h >> 1;
        const row = (src, srcOff, len, at) => fs.writeSync(this.fd, src, srcOff, len, at);
        const y = toBuf(p.y), u = toBuf(p.u), v = toBuf(p.v);
        if (p.stride === w) row(y, p.yOff || 0, w * h, base);
        else for (let r = 0; r < h; r++) row(y, (p.yOff || 0) + r * p.stride, w, base + r * w);
        const uBase = base + w * h, vBase = uBase + cw * ch;
        if (p.cstride === cw) { row(u, p.uOff || 0, cw * ch, uBase); row(v, p.vOff || 0, cw * ch, vBase); } else {
            for (let r = 0; r < ch; r++) {
                row(u, (p.uOff || 0) + r * p.cstride, cw, uBase + r * cw);
                row(v, (p.vOff || 0) + r * p.cstride, cw, vBase + r * cw);
            }
        }
    }
    /** Close and remove the file (the renderer then draws nothing for the video op). */
    close(keep) {
        if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* closed */ } this.fd = null; }
        if (!keep) { try { fs.unlinkSync(this.path); } catch (e) { /* not there */ } }
        this.size = 0;
    }
}

function toBuf(a) { return Buffer.isBuffer(a) ? a : Buffer.from(a.buffer, a.byteOffset, a.byteLength); }

/** Read a frame file's header (tests, diagnostics). */
function readHeader(path) {
    const fd = fs.openSync(path, 'r'), b = Buffer.alloc(HEAD);
    try { fs.readSync(fd, b, 0, HEAD, 0); } finally { fs.closeSync(fd); }
    const w = (i) => b.readUInt32LE(i * 4);
    return { magic: w(0), version: w(1), w: w(2), h: w(3), seq: w(4), slot: w(5), nslot: w(6), matrix: w(7), range: w(8) };
}

module.exports = { FrameFile, readHeader, MAGIC, NSLOT, HEAD, NAME_RE };
