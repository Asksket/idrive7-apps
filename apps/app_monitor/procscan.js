'use strict';
/**
 * procscan.js - a read-only view of the running OAP apps: per app (its Linux uid), the memory, CPU and run time
 * of its processes, and the limits from its oapAppSettings.
 *
 * It only reads files: /proc, the app's installed package.json and the optional limits index. It never sends a
 * signal, never writes, never talks to MainApp. (Stopping an app process by hand counts as a crash for MainApp's
 * CorruptAppsHandler, which wipes the app's data or uninstalls it.)
 *
 * Where each value comes from:
 *   - app processes: /proc/<pid>/cmdline names the app's folder, .../oap/oap_<uid>/source/... (MainApp starts every
 *     app from there; MainApp itself, uid 12201, is left out)
 *   - memory: VmRSS / VmHWM of /proc/<pid>/status, summed over the app's processes
 *   - CPU: utime + stime of /proc/<pid>/stat between two scans, % of one core
 *   - run time: the oldest process's start (/proc/<pid>/stat starttime) against /proc/uptime
 *   - id, version, memoryThresholdKB, cpuLimit: /var/opt/public/oap/oap_<uid>/source/package.json. The installer
 *     makes that folder readable by MainApp and the app itself only, so another app usually can't read it; then
 *     from INDEX, which deploy/app-monitor-index.sh writes as root (world-readable), else unknown.
 *
 * Node 8 compatible.
 */
const fs = require('fs');
const path = require('path');

const OAP = '/var/opt/public/oap';
const INDEX = '/var/opt/public/mgu_app_monitor/limits.json';
const MAINAPP_UID = 12201;
const HZ = 100;                              // USER_HZ: /proc/<pid>/stat times are in 1/100 s on x86 Linux
const APP_DIR = /\/oap_(\d+)\/source\//;     // as the Store's deploy tool finds an app's process
const META_OK_MS = 60000, META_RETRY_MS = 30000;

/** /proc/<pid>/status -> { name, uid, rssKB, hwmKB, threads } (null where a line is missing). */
function parseStatus(text) {
    const field = (k) => { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(text); return m ? m[1].trim() : null; };
    const kb = (k) => { const v = field(k); return v === null ? null : parseInt(v, 10); };
    const uid = field('Uid');
    return { name: field('Name'), uid: uid === null ? null : parseInt(uid, 10), rssKB: kb('VmRSS'), hwmKB: kb('VmHWM'),
        threads: kb('Threads') };
}

/** /proc/<pid>/stat -> { state, ticks (utime + stime), start (ticks after boot) }. The command name may hold spaces
 * and parentheses: the fields start after its last ')'. */
function parseStat(text) {
    const end = text.lastIndexOf(')');
    if (end < 0) return null;
    const f = text.slice(end + 2).split(' ');       // f[0] = state (field 3)
    const n = (i) => parseInt(f[i], 10);
    if (f.length < 20) return null;
    return { state: f[0], ticks: n(11) + n(12), start: n(19) };
}

/** /proc/meminfo -> { totalKB, availableKB } */
function parseMeminfo(text) {
    const kb = (k) => { const m = new RegExp('^' + k + ':\\s*(\\d+)', 'm').exec(text || ''); return m ? parseInt(m[1], 10) : null; };
    return { totalKB: kb('MemTotal'), availableKB: kb('MemAvailable') };
}

/** Whether /proc is mounted with hidepid (other users' processes hidden): from /proc/mounts. */
function hidepid(mounts) {
    return (mounts || '').split('\n').some((l) => {
        const p = l.split(' ');
        return p[1] === '/proc' && p[2] === 'proc' && /(^|,)hidepid=(1|2|invisible|noaccess)(,|$)/.test(p[3] || '');
    });
}

/** The limits a package.json gives: { id, version, memKB, cpuLimit, localOnly, author }. */
function metaOfPackage(pkg) {
    const s = (pkg && pkg.oapAppSettings) || {};
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    return { id: typeof pkg.name === 'string' ? pkg.name : null, version: typeof pkg.version === 'string' ? pkg.version : null,
        memKB: num(s.memoryThresholdKB), cpuLimit: num(s.cpuLimit), localOnly: pkg.mguLocalOnly === true,
        author: typeof pkg.author === 'string' ? pkg.author : null };
}

/**
 * A scanner. opts.root: a folder standing in for '/' (tests); opts.selfUid: this app's uid (marked "self").
 * scan() -> { ok, why, apps: [...], system: { totalKB, availableKB, uptimeS }, hidden, at }
 * each app: { uid, id, version, pids, rssKB, hwmKB, threads, cpu (% of one core, null on the first scan),
 *             runS, memKB, cpuLimit, pct (rss / memKB, %), custom (true/false/null), self, metaFrom, metaWhy }
 */
function create(opts) {
    opts = opts || {};
    const root = opts.root || '/';
    const P = (p) => (root === '/' ? p : path.join(root, p));
    const selfUid = opts.selfUid !== undefined ? opts.selfUid : (process.getuid ? process.getuid() : null);
    const now = opts.now || Date.now;
    const read = (p) => { try { return { text: fs.readFileSync(P(p), 'utf8') }; } catch (e) { return { err: e.code || 'error' }; } };
    const text = (p) => read(p).text || null;

    const procs = new Map();    // pid -> { start, uid }: the app a process belongs to (null: not an app)
    const metas = new Map();    // uid -> { at, meta }
    const prev = new Map();     // uid -> { ticks, upS, pids }: the last scan, for CPU %
    let index = { mtime: -1, apps: {} };

    function loadIndex() {
        try {
            const st = fs.statSync(P(INDEX));
            if (st.mtime.getTime() !== index.mtime) {
                const j = JSON.parse(fs.readFileSync(P(INDEX), 'utf8'));
                index = { mtime: st.mtime.getTime(), apps: (j && typeof j.apps === 'object' && j.apps) || {} };
            }
        } catch (e) { index = { mtime: -1, apps: {} }; }
        return index.apps;
    }

    function meta(uid) {
        const t = now(), c = metas.get(uid);
        if (c && t - c.at < (c.meta.metaFrom === 'none' ? META_RETRY_MS : META_OK_MS)) return c.meta;
        let m;
        const r = read(OAP + '/oap_' + uid + '/source/package.json');
        try { if (r.text) m = Object.assign(metaOfPackage(JSON.parse(r.text)), { metaFrom: 'package' }); } catch (e) { /* below */ }
        if (!m) {
            const e = loadIndex()[String(uid)];
            if (e && typeof e === 'object') {
                m = Object.assign(metaOfPackage({ name: e.id, version: e.version, author: e.author, mguLocalOnly: e.localOnly,
                    oapAppSettings: { memoryThresholdKB: e.memoryThresholdKB, cpuLimit: e.cpuLimit } }),
                { metaFrom: 'index', custom: typeof e.custom === 'boolean' ? e.custom : undefined });
            }
        }
        if (!m) m = { id: null, version: null, memKB: null, cpuLimit: null, localOnly: false, author: null, metaFrom: 'none',
            metaWhy: r.err === 'EACCES' || r.err === 'EPERM' ? 'no access' : r.err === 'ENOENT' ? 'not found' : (r.err || 'unreadable') };
        if (m.custom === undefined) {
            // MGU Store apps carry mguLocalOnly; this kit's apps have the author "custom"; BMW's own apps name BMW
            m.custom = m.localOnly || (m.author !== null ? !/\bbmw\b/i.test(m.author) : null);
        }
        metas.set(uid, { at: t, meta: m });
        return m;
    }

    function scan() {
        const up = text('/proc/uptime');
        const upS = up ? parseFloat(up) : NaN;
        if (!isFinite(upS)) return { ok: false, why: 'no /proc on this system', apps: [], at: now() };
        let pids;
        try { pids = fs.readdirSync(P('/proc')).filter((d) => /^\d+$/.test(d)); } catch (e) { return { ok: false, why: '/proc unreadable', apps: [], at: now() }; }
        const seen = new Set(pids), groups = new Map();
        for (const k of procs.keys()) if (!seen.has(k)) procs.delete(k);
        pids.forEach((pid) => {
            const sTxt = text('/proc/' + pid + '/stat'), st = sTxt && parseStat(sTxt);
            if (!st || st.state === 'Z') return;
            let p = procs.get(pid);
            if (!p || p.start !== st.start) {            // a new process (or the pid reused): which app is it?
                const cmd = (text('/proc/' + pid + '/cmdline') || '').split('\0').join(' ');
                const m = APP_DIR.exec(cmd);
                p = { start: st.start, uid: m ? parseInt(m[1], 10) : null };
                procs.set(pid, p);
            }
            if (p.uid === null || p.uid === MAINAPP_UID) return;
            const s = parseStatus(text('/proc/' + pid + '/status') || '');
            let g = groups.get(p.uid);
            if (!g) groups.set(p.uid, g = { uid: p.uid, pids: [], rssKB: 0, hwmKB: 0, threads: 0, ticks: 0, start: Infinity });
            g.pids.push(parseInt(pid, 10));
            g.rssKB += s.rssKB || 0;
            g.hwmKB += s.hwmKB || 0;
            g.threads += s.threads || 0;
            g.ticks += st.ticks;
            g.start = Math.min(g.start, st.start);
        });
        const maxGapS = opts.maxGapS || 30;
        const apps = Array.from(groups.values()).map((g) => {
            const m = meta(g.uid), last = prev.get(g.uid);
            // CPU over the time since the last scan; not across a long gap (screen hidden) or a changed process set
            let cpu = null;
            if (last && upS > last.upS && upS - last.upS <= maxGapS && last.pids === g.pids.join(',')) {
                cpu = Math.max(0, (g.ticks - last.ticks) / HZ / (upS - last.upS) * 100);
            }
            prev.set(g.uid, { ticks: g.ticks, upS, pids: g.pids.join(',') });
            return { uid: g.uid, id: m.id, version: m.version, pids: g.pids, rssKB: g.rssKB, hwmKB: g.hwmKB, threads: g.threads,
                cpu, runS: Math.max(0, upS - g.start / HZ), memKB: m.memKB, cpuLimit: m.cpuLimit,
                pct: m.memKB ? g.rssKB / m.memKB * 100 : null, custom: m.custom, self: g.uid === selfUid,
                metaFrom: m.metaFrom, metaWhy: m.metaWhy || null };
        });
        for (const uid of prev.keys()) if (!groups.has(uid)) prev.delete(uid);
        const mem = parseMeminfo(text('/proc/meminfo'));
        return { ok: true, apps, system: { totalKB: mem.totalKB, availableKB: mem.availableKB, uptimeS: upS },
            hidden: hidepid(text('/proc/mounts')), at: now() };
    }

    return { scan };
}

module.exports = { create, parseStatus, parseStat, parseMeminfo, hidepid, metaOfPackage, OAP, INDEX, MAINAPP_UID, HZ };
