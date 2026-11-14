'use strict';
/**
 * net.js - the internet as the head unit gives it to an app: only through the MGU Store's uplink (mgu-uplink),
 * which lets out the uids of apps that ask for it ("internet": true in app.json -> "mguInternet" in package.json).
 * The unit's own resolver does not reach the internet: names are resolved through the DNS servers of the uplink's
 * lease (data/uplink.json for this app, else /run/mgu-uplink/lease.json), present only while online.
 *
 *   net.lease()                 -> { interface, ip, dns[] } or null (offline)
 *   net.request(url, opts)      -> Promise { status, headers, body (Buffer) }
 *   net.json(url, body, opts)   -> Promise of the parsed answer (POST when body is given)
 *   net.download(url, file, opts) -> Download: ranged parallel GETs into file; .promise, .abort(), .got, .size
 *   net.check()                 -> Promise { online, why }
 *
 * Node 8 only: http(s), dns.Resolver, zlib.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const zlib = require('zlib');
const { URL } = require('url');

const LEASES = [];                  // where to look for the lease, set by init()
let leaseCache = null, leaseT = 0;
let resolver = null, resolverKey = '';
const dnsCache = new Map();         // host -> { addr, until }

function init(dataDir) {
    LEASES.length = 0;
    if (process.env.TUBECAR_LEASE) LEASES.push(process.env.TUBECAR_LEASE);
    if (dataDir) LEASES.push(path.join(dataDir, 'uplink.json'));
    LEASES.push('/run/mgu-uplink/lease.json');
}

/** The uplink's lease ({ interface, ip, dns[] }), or null while offline. Read again at most every 2 s. */
function lease() {
    if (Date.now() - leaseT < 2000) return leaseCache;
    leaseT = Date.now();
    leaseCache = null;
    for (const f of LEASES) {
        try {
            const l = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (l && Array.isArray(l.dns) && l.dns.length) { leaseCache = l; break; }
        } catch (e) { /* not there: offline, or not this file */ }
    }
    return leaseCache;
}

/** No lease file anywhere: a PC, a bench unit with a normal route. Names then go to the system resolver. */
function noUplink() { return !LEASES.some((f) => fs.existsSync(f)) && !fs.existsSync('/run/mgu-uplink'); }

/** lookup() for http(s).request: through the lease's DNS servers. */
function lookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return process.nextTick(cb, null, host, 4);
    const hit = dnsCache.get(host);
    if (hit && hit.until > Date.now()) return process.nextTick(cb, null, hit.addr, 4);
    const l = lease();
    if (!l) {
        if (noUplink()) return dns.lookup(host, { family: 4 }, cb);
        const e = new Error('offline: the car has no internet connection (MGU Store uplink)');
        e.code = 'EOFFLINE';
        return process.nextTick(cb, e);
    }
    const key = l.dns.join(',');
    if (!resolver || key !== resolverKey) {
        resolver = new dns.Resolver();
        resolver.setServers(l.dns);
        resolverKey = key;
    }
    resolver.resolve4(host, { ttl: true }, (err, addrs) => {
        if (err || !addrs || !addrs.length) return cb(err || new Error('no address for ' + host));
        const a = addrs[Math.floor(Math.random() * addrs.length)];
        dnsCache.set(host, { addr: a.address, until: Date.now() + Math.max(30, Math.min(600, a.ttl || 60)) * 1000 });
        cb(null, a.address, 4);
    });
}

const agents = {
    'https:': new https.Agent({ keepAlive: true, maxSockets: 6, lookup }),
    'http:': new http.Agent({ keepAlive: true, maxSockets: 6, lookup }),
};
function destroyAgents() { Object.keys(agents).forEach((k) => agents[k].destroy()); }

/**
 * One HTTP(S) request. opts: { method, headers, body (Buffer|string), timeoutMs (10000), maxBytes (8 MiB),
 * redirects (5), stream (a writable: the body goes there, not into memory), onResponse(res) }.
 * Returns a promise with { status, headers, body }; .abort() on the promise ends it.
 */
function request(url, opts) {
    opts = opts || {};
    let req = null, aborted = false, timer = null;
    const p = new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
        if (!mod) return reject(new Error('bad url ' + url));
        const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
        const headers = Object.assign({ 'Accept-Encoding': 'gzip', 'User-Agent': 'Mozilla/5.0' }, opts.headers || {});
        if (body) headers['Content-Length'] = body.length;
        req = mod.request({
            protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
            method: opts.method || (body ? 'POST' : 'GET'), headers, agent: agents[u.protocol], lookup,
        }, (res) => {
            const status = res.statusCode;
            if (status >= 300 && status < 400 && res.headers.location && (opts.redirects == null ? 5 : opts.redirects) > 0) {
                res.resume();
                clearTimeout(timer);
                const next = new URL(res.headers.location, url).toString();
                const o = Object.assign({}, opts, { redirects: (opts.redirects == null ? 5 : opts.redirects) - 1 });
                const p2 = request(next, o);
                p.abort = p2.abort;
                return p2.then(resolve, reject);
            }
            if (opts.onResponse) { try { opts.onResponse(res); } catch (e) { /* caller's */ } }
            let src = res;
            const enc = String(res.headers['content-encoding'] || '');
            if (enc === 'gzip' || enc === 'deflate') src = res.pipe(enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate());
            if (opts.stream) {
                src.on('data', (d) => { arm(); opts.stream.write(d); });
                src.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers, body: null }); });
                src.on('error', (e) => { clearTimeout(timer); reject(e); });
                return null;
            }
            const parts = [];
            let got = 0;
            const max = opts.maxBytes || 8 * 1024 * 1024;
            src.on('data', (d) => {
                arm();
                got += d.length;
                if (got > max) { req.abort(); reject(new Error('answer too big (' + got + ' bytes)')); return; }
                parts.push(d);
            });
            src.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers, body: Buffer.concat(parts) }); });
            src.on('error', (e) => { clearTimeout(timer); reject(e); });
            return null;
        });
        // a timeout counts from the last byte, not from the start (a big answer on a slow link)
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (req) req.abort(); reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); }, opts.timeoutMs || 10000);
        };
        arm();
        req.on('error', (e) => { clearTimeout(timer); reject(aborted ? Object.assign(new Error('aborted'), { code: 'EABORTED' }) : e); });
        if (body) req.write(body);
        req.end();
        return null;
    });
    p.abort = () => { aborted = true; clearTimeout(timer); if (req) req.abort(); };
    return p;
}

/** POST body as JSON (or GET without body) and parse the JSON answer; a status other than 2xx rejects. */
function json(url, body, opts) {
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (body !== undefined && body !== null) o.body = JSON.stringify(body);
    return request(url, o).then((r) => {
        let data = null;
        try { data = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not JSON */ }
        if (r.status < 200 || r.status >= 300) {
            const e = new Error('HTTP ' + r.status + (data && data.error && data.error.message ? ': ' + data.error.message : ''));
            e.status = r.status; e.data = data;
            throw e;
        }
        if (!data) throw new Error('not a JSON answer');
        return data;
    });
}

/** Size of a resource from a 1-byte ranged GET (Content-Range), for files whose size the API did not give. */
function sizeOf(url, headers) {
    return request(url, { headers: Object.assign({ Range: 'bytes=0-0' }, headers || {}), maxBytes: 4096 }).then((r) => {
        const m = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || ''));
        if (m) return Number(m[1]);
        if (r.status === 200 && r.headers['content-length']) return Number(r.headers['content-length']);
        throw new Error('no size (HTTP ' + r.status + ')');
    });
}

/**
 * Download url into file with ranged GETs: `parallel` connections, `chunk` bytes each request, in file order (the
 * front of the file first, so a player can start on it). opts: { size (else asked), parallel (3), chunk (1 MiB),
 * headers, onProgress(got, size, contiguous), maxBytes, mode (0644) }. The file is made at its full size up front.
 * Returns { promise, abort(), got, size, contiguous }: contiguous = bytes there from the start without a gap.
 */
function download(url, file, opts) {
    opts = opts || {};
    const d = { got: 0, size: opts.size || 0, contiguous: 0, aborted: false, reqs: new Set(), fd: null };
    const chunk = opts.chunk || 1024 * 1024, parallel = opts.parallel || 3;
    d.abort = () => {
        d.aborted = true;
        d.reqs.forEach((r) => r.abort());
        d.reqs.clear();
        if (d.fd !== null) { try { fs.closeSync(d.fd); } catch (e) { /* closed */ } d.fd = null; }
    };
    d.promise = (d.size ? Promise.resolve(d.size) : sizeOf(url, opts.headers)).then((size) => {
        if (d.aborted) throw Object.assign(new Error('aborted'), { code: 'EABORTED' });
        if (opts.maxBytes && size > opts.maxBytes) throw Object.assign(new Error('the file is ' + Math.round(size / 1048576) + ' MB, more than ' + Math.round(opts.maxBytes / 1048576) + ' MB'), { code: 'ETOOBIG' });
        d.size = size;
        d.fd = fs.openSync(file, 'w', opts.mode || 0o644);
        try { fs.fchmodSync(d.fd, opts.mode || 0o644); } catch (e) { /* umask kept it */ }
        fs.ftruncateSync(d.fd, size);
        const n = Math.ceil(size / chunk), done = new Uint8Array(n);
        let nextIdx = 0;
        const markContig = () => {
            let i = Math.floor(d.contiguous / chunk);
            while (i < n && done[i]) i++;
            d.contiguous = Math.min(size, i * chunk);
        };
        const one = (i, tries) => {
            if (d.aborted) return Promise.reject(Object.assign(new Error('aborted'), { code: 'EABORTED' }));
            const a = i * chunk, b = Math.min(size, a + chunk) - 1;
            let at = a;
            const sink = {
                write(buf) {
                    if (d.fd === null) return;
                    fs.writeSync(d.fd, buf, 0, buf.length, at);
                    at += buf.length; d.got += buf.length;
                    if (opts.onProgress) opts.onProgress(d.got, size, d.contiguous);
                },
            };
            const r = request(url, { headers: Object.assign({ Range: 'bytes=' + a + '-' + b }, opts.headers || {}), stream: sink, timeoutMs: 15000 });
            d.reqs.add(r);
            return r.then((res) => {
                d.reqs.delete(r);
                if (res.status !== 206 && !(res.status === 200 && a === 0 && b === size - 1)) throw new Error('HTTP ' + res.status);
                if (at !== b + 1) throw new Error('short range ' + (at - a) + '/' + (b + 1 - a));
                done[i] = 1;
                markContig();
                if (opts.onProgress) opts.onProgress(d.got, size, d.contiguous);
            }).catch((e) => {
                d.reqs.delete(r);
                d.got -= at - a;              // what this try wrote is written again
                if (d.aborted || e.code === 'EABORTED') throw Object.assign(new Error('aborted'), { code: 'EABORTED' });
                if (tries >= 3) throw e;
                return new Promise((res2) => setTimeout(res2, 500 * (tries + 1))).then(() => one(i, tries + 1));
            });
        };
        const worker = () => {
            if (nextIdx >= n) return Promise.resolve();
            const i = nextIdx++;
            return one(i, 0).then(worker);
        };
        const ws = [];
        for (let k = 0; k < Math.min(parallel, n); k++) ws.push(worker());
        return Promise.all(ws).then(() => {
            if (d.fd !== null) { fs.closeSync(d.fd); d.fd = null; }
            d.contiguous = size;
            return size;
        });
    }).catch((e) => {
        if (d.fd !== null) { try { fs.closeSync(d.fd); } catch (e2) { /* closed */ } d.fd = null; }
        d.reqs.forEach((r) => r.abort());
        throw e;
    });
    return d;
}

/**
 * Is the car online? { online, why }: no lease = the uplink has no connection; a lease but no answer from the
 * internet = a captive portal, no data, or a hotspot without a link.
 */
function check(timeoutMs) {
    if (!lease() && !noUplink()) return Promise.resolve({ online: false, why: 'no-uplink' });
    return request(process.env.TUBECAR_CHECK_URL || 'https://www.google.com/generate_204', { timeoutMs: timeoutMs || 6000, maxBytes: 65536, redirects: 0 })
        .then((r) => (r.status === 204 ? { online: true, why: 'ok' } : { online: false, why: 'portal', status: r.status }))
        .catch((e) => ({ online: false, why: e.code === 'EOFFLINE' ? 'no-uplink' : 'no-answer', error: String(e.message || e) }));
}

module.exports = { init, lease, lookup, request, json, sizeOf, download, check, destroyAgents, _dnsCache: dnsCache };
