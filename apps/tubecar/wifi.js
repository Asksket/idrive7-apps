'use strict';
/**
 * wifi.js - the car's internet connection as far as an app can see and ask for it.
 *
 * Who does what on the head unit (mgu-store: native/mgu-uplink, native/mgu-updater):
 *   - mgu-uplink (root) joins Wi-Fi networks with the unit's radio and routes the listed apps through it. A network
 *     joined once is saved there and joined again by itself whenever it is in range.
 *   - It takes requests only on a root-only socket. The updater relays them from /dev/shm/mgu-updater/updater.sock,
 *     which every app may open, but joining a network ("wifi-connect") is a privileged request: only the MGU Store
 *     (with the secret in its own data folder) may make it. An app is answered "forbidden".
 *   - Anyone may read /run/mgu-uplink/status.json (the uplink's state, the networks in range, the saved ones).
 *
 * So this app keeps the SSID and password the user gives it (data/wifi.json, readable by this app only), reads the
 * uplink's state at start, and asks the updater to join the network when the car is offline and the network is
 * not one the uplink already knows. Where the updater refuses (every unit today), it says so and what to do:
 * join it once in the MGU Store; from then on the uplink joins it by itself.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const STATUS = process.env.TUBECAR_UPLINK_STATUS || '/run/mgu-uplink/status.json';
const UPDATER = process.env.TUBECAR_UPDATER_SOCK || '/dev/shm/mgu-updater/updater.sock';

class WifiConfig {
    constructor(dataDir, log) {
        this.file = path.join(dataDir || '.', 'wifi.json');
        this.log = log;
        this.v = { ssid: '', psk: '', auto: true };
        try { Object.assign(this.v, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* none saved */ }
    }
    get ssid() { return this.v.ssid || ''; }
    get psk() { return this.v.psk || ''; }
    get auto() { return this.v.auto !== false; }
    has() { return !!this.v.ssid; }
    /** Check what mgu-uplink takes: a name of 1-32 bytes, a password of 8-63 printable ASCII characters or none. */
    static check(ssid, psk) {
        if (!ssid || Buffer.byteLength(ssid) > 32) return 'The network name must be 1 to 32 characters.';
        if (psk && (psk.length < 8 || psk.length > 63 || !/^[\x20-\x7e]+$/.test(psk))) return 'The password must be 8 to 63 characters (letters, digits, symbols).';
        if (/"[^"]*#/.test(ssid) || /"[^"]*#/.test(psk || '')) return 'A quote followed by # can\'t be saved by the car.';
        return null;
    }
    save(ssid, psk, auto) {
        const bad = WifiConfig.check(ssid, psk);
        if (bad) throw new Error(bad);
        this.v = { ssid, psk: psk || '', auto: auto !== false };
        const tmp = this.file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.v), { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch (e) { /* umask kept it */ }
        fs.renameSync(tmp, this.file);
    }
    forget() { this.v = { ssid: '', psk: '', auto: true }; try { fs.unlinkSync(this.file); } catch (e) { /* none */ } }
}

/** The uplink's state: { installed, state, device, wifi: { enabled, link, ssid, saved[], networks[], error } } */
function uplinkStatus() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch (e) {
        return { installed: fs.existsSync(path.dirname(STATUS)), state: 'none', device: null, wifi: null };
    }
    return { installed: true, state: s.state || 'unknown', device: s.device || null, error: s.error || null, wifi: s.wifi || null };
}

/**
 * One request to the updater: connect, read its state line, send the request with a rid, wait for the answer that
 * carries it. Resolves { ok, error, state }. Never throws.
 */
function updaterRequest(req, timeoutMs) {
    return new Promise((resolve) => {
        const rid = 'tc' + Date.now().toString(36);
        let done = false, buf = '', state = null, sent = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch (e) { /* closed */ } resolve(Object.assign({ state }, r)); };
        const t = setTimeout(() => finish({ ok: false, error: 'the updater gave no answer' }), timeoutMs || 12000);
        const s = net.createConnection(UPDATER);
        s.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? 'no MGU Store updater on this unit' : e.code === 'EACCES' ? 'no access to the updater' : String(e.message || e) }));
        s.on('connect', () => { s.write(JSON.stringify(Object.assign({ rid }, req)) + '\n'); sent = true; });
        s.on('data', (d) => {
            buf += d.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m = null;
                try { m = JSON.parse(line); } catch (e) { continue; }
                if (m.type === 'state') { state = m; if (m.rid === rid) finish({ ok: true }); }
                else if (m.type === 'error' && (m.rid === rid || (sent && m.op === req.op))) finish({ ok: false, error: String(m.error || 'refused') });
            }
        });
    });
}

/**
 * At start (and from the Wi-Fi page): where the car's internet stands, and a try to get it.
 * Returns { online, message, tone: 'ok' | 'info' | 'warn', why } for the screen. checkNet: net.check.
 */
async function ensureConnected(cfg, checkNet, log) {
    const first = await checkNet();
    if (first.online) {
        const st = uplinkStatus();
        const via = st.device ? (st.device.kind === 'wifi' ? 'Wi-Fi "' + (st.device.name || '') + '"' : st.device.name || st.device.kind) : 'the uplink';
        return { online: true, tone: 'ok', message: 'Online through ' + via + '.' };
    }
    const st = uplinkStatus();
    if (!st.installed) {
        return { online: false, tone: 'warn', why: 'no-uplink', message: 'No internet: the car has no MGU Store uplink. Install "Internet uplink" in the MGU Store, then connect Wi-Fi or a phone there.' };
    }
    if (first.why === 'portal' || first.why === 'no-answer') {
        if (st.state === 'online') return { online: false, tone: 'warn', why: first.why, message: 'Connected' + (st.device ? ' to ' + (st.device.name || st.device.kind) : '') + ', but the internet does not answer (no mobile data, or a sign-in page).' };
    }
    if (!cfg.has() || !cfg.auto) {
        return { online: false, tone: 'warn', why: 'offline', message: 'No internet. ' + (st.error ? st.error + '. ' : '') + 'Set your Wi-Fi in TubeCar\'s Wi-Fi page, or connect in the MGU Store.' };
    }
    const w = st.wifi || {};
    if (w.enabled && (w.saved || []).indexOf(cfg.ssid) >= 0) {
        const inRange = (w.networks || []).some((n) => n.ssid === cfg.ssid);
        return {
            online: false, tone: 'info', why: 'waiting',
            message: inRange ? 'Joining Wi-Fi "' + cfg.ssid + '"...' : 'Wi-Fi "' + cfg.ssid + '" is saved but not in range. The car joins it as soon as it is.',
        };
    }
    log.info('wifi: offline; asking the updater to join "' + cfg.ssid + '"');
    const r = await updaterRequest({ op: 'wifi-connect', ssid: cfg.ssid, psk: cfg.psk || undefined });
    if (r.ok) return { online: false, tone: 'info', why: 'joining', message: 'Joining Wi-Fi "' + cfg.ssid + '"...' };
    log.warn('wifi: the updater refused wifi-connect: ' + r.error);
    if (/forbidden/i.test(r.error)) {
        return {
            online: false, tone: 'warn', why: 'forbidden',
            message: 'No internet. The car lets only the MGU Store join Wi-Fi networks: open MGU Store > Settings > Wi-Fi and join "' + cfg.ssid + '" once. After that the car joins it by itself.',
        };
    }
    return { online: false, tone: 'warn', why: 'updater', message: 'No internet, and the Wi-Fi could not be asked for (' + r.error + '). Connect in the MGU Store.' };
}

module.exports = { WifiConfig, uplinkStatus, updaterRequest, ensureConnected };
