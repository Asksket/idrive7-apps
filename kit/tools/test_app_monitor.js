'use strict';

// App Monitor against a made-up /proc and OAP tree (procscan.js), then a few frames of the app with that scanner.
// No SDK, head unit or Linux needed:
//   node kit/tools/test_app_monitor.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'app_monitor');
const MAIN = path.join(APP, 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const procscan = require(path.join(APP, 'procscan'));
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));

/* ---------- a fake root ---------- */
const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'app-monitor-'));
// Node 8 (the head unit's) has no mkdirSync recursive
const mkdirp = (d) => { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d); } };
const put = (p, text, mode) => {
    const f = path.join(fake, p);
    mkdirp(path.dirname(f));
    fs.writeFileSync(f, text);
    if (mode !== undefined) fs.chmodSync(f, mode);
};
let upS = 1000;
const setUptime = (s) => { upS = s; put('proc/uptime', s.toFixed(2) + ' 3600.00\n'); };
/** a process: stat fields in the kernel's order after "(comm) " */
function proc(pid, { comm = 'node', state = 'S', uid = 0, rss = 1000, hwm = 1200, threads = 10, utime = 0, stime = 0, start = 500, cmd = [] }) {
    const f = [state, 1, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, utime, stime, 0, 0, 20, 0, threads, 0, start, 0, 0];
    put('proc/' + pid + '/stat', pid + ' (' + comm + ') ' + f.join(' ') + '\n');
    put('proc/' + pid + '/cmdline', cmd.join('\0') + '\0');
    put('proc/' + pid + '/status', ['Name:\t' + comm, 'State:\t' + state, 'Uid:\t' + uid + '\t' + uid + '\t' + uid + '\t' + uid,
        'VmHWM:\t ' + hwm + ' kB', 'VmRSS:\t ' + rss + ' kB', 'Threads:\t' + threads].join('\n') + '\n');
}
const appCmd = (uid) => ['/usr/bin/node', '--expose-gc', '/var/opt/public/oap/oap_' + uid + '/source/javascript/app.js'];
const pkg = (uid, o) => put('var/opt/public/oap/oap_' + uid + '/source/package.json', JSON.stringify(o));

setUptime(1000);
put('proc/meminfo', 'MemTotal:        7864320 kB\nMemFree:          100000 kB\nMemAvailable:    2516582 kB\n');
put('proc/mounts', 'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n');
// MainApp (left out), a BMW app, two custom apps (one of them with a child process), a zombie, an unrelated process
proc(100, { comm: 'node', uid: 12201, rss: 90000, cmd: ['/usr/bin/node', '/usr/lib/oap-mainapp/src/main.js'] });
proc(201, { uid: 12203, rss: 40960, start: 3000, cmd: appCmd(12203) });
proc(301, { uid: 12223, rss: 98304, hwm: 120000, utime: 100, stime: 50, start: 20000, cmd: appCmd(12223) });
proc(302, { comm: 'helper (x) y', uid: 12223, rss: 51200, hwm: 60000, utime: 10, stime: 0, start: 30000, cmd: ['/var/opt/public/oap/oap_12223/source/javascript/bin/helper'] });
proc(401, { uid: 12236, rss: 20480, start: 90000, cmd: appCmd(12236) });
proc(402, { state: 'Z', uid: 12236, rss: 0, cmd: appCmd(12236) });
proc(500, { comm: 'systemd', uid: 0, cmd: ['/sbin/init'] });
pkg(12203, { name: 'weather', version: '24.1.0', author: 'BMW AG', oapAppSettings: { memoryThresholdKB: 65536, cpuLimit: 20 } });
pkg(12223, { name: 'redline', version: '2.0.0', author: 'custom', oapAppSettings: { memoryThresholdKB: 196608, cpuLimit: 60 } });
// 12236: no package.json readable (as on the car): the index has it
put('var/opt/public/mgu_app_monitor/limits.json', JSON.stringify({ apps: { 12236: { id: 'app_monitor', version: '1.0.0',
    memoryThresholdKB: 196608, cpuLimit: 60, custom: true } } }));

let clock = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('parses stat with spaces and parentheses in the command name', () => {
    const s = procscan.parseStat('302 (helper (x) y) S 1 302 302 0 -1 4194304 0 0 0 0 10 5 0 0 20 0 3 0 30000 0 0');
    assert.deepStrictEqual(s, { state: 'S', ticks: 15, start: 30000 });
    assert.strictEqual(procscan.parseStat('garbage'), null);
});
check('hidepid is noticed', () => {
    assert.strictEqual(procscan.hidepid('proc /proc proc rw,relatime,hidepid=2 0 0'), true);
    assert.strictEqual(procscan.hidepid('proc /proc proc rw,relatime 0 0'), false);
});

let scanner, first;
check('groups processes by app, leaves out MainApp, zombies and other processes', () => {
    scanner = procscan.create({ root: fake, selfUid: 12236, now: () => clock });
    first = scanner.scan();
    assert.strictEqual(first.ok, true);
    const uids = first.apps.map((a) => a.uid).sort();
    assert.deepStrictEqual(uids, [12203, 12223, 12236]);
    const r = first.apps.find((a) => a.uid === 12223);
    assert.deepStrictEqual(r.pids.sort(), [301, 302]);
    assert.strictEqual(r.rssKB, 98304 + 51200);
    assert.strictEqual(r.hwmKB, 120000 + 60000);
    assert.strictEqual(r.runS, 1000 - 200, 'run time from the oldest process (start 20000 ticks = 200 s)');
    assert.strictEqual(r.cpu, null, 'no CPU on the first scan');
    assert.strictEqual(first.system.availableKB, 2516582);
    assert.strictEqual(first.hidden, false);
});
check('limits from package.json, the share of the limit, custom or BMW', () => {
    const r = first.apps.find((a) => a.uid === 12223), w = first.apps.find((a) => a.uid === 12203);
    assert.strictEqual(r.id, 'redline');
    assert.strictEqual(r.memKB, 196608);
    assert.strictEqual(r.cpuLimit, 60);
    assert.ok(Math.abs(r.pct - (98304 + 51200) / 196608 * 100) < 1e-9);
    assert.strictEqual(r.metaFrom, 'package');
    assert.strictEqual(r.custom, true);
    assert.strictEqual(w.custom, false, 'author BMW AG');
});
check('limits from the index when package.json is not there; this app is marked', () => {
    const a = first.apps.find((x) => x.uid === 12236);
    assert.strictEqual(a.metaFrom, 'index');
    assert.strictEqual(a.id, 'app_monitor');
    assert.strictEqual(a.memKB, 196608);
    assert.strictEqual(a.custom, true);
    assert.strictEqual(a.self, true);
});
check('CPU between two scans, as % of one core', () => {
    setUptime(1002);
    proc(301, { uid: 12223, rss: 98304, hwm: 120000, utime: 150, stime: 60, start: 20000, cmd: appCmd(12223) });   // +60 ticks
    proc(302, { comm: 'helper (x) y', uid: 12223, rss: 51200, hwm: 60000, utime: 30, stime: 0, start: 30000, cmd: [] }); // +20
    const r = scanner.scan().apps.find((a) => a.uid === 12223);
    assert.ok(Math.abs(r.cpu - 80 / 100 / 2 * 100) < 1e-6, 'cpu ' + r.cpu);
});
check('a reused pid is looked up again (its cmdline read anew)', () => {
    setUptime(1004);
    proc(302, { comm: 'sh', uid: 0, start: 99000, cmd: ['/bin/sh'] });                 // 302 ended, the pid now another process
    const r = scanner.scan().apps.find((a) => a.uid === 12223);
    assert.deepStrictEqual(r.pids, [301]);
    assert.strictEqual(r.cpu, null, 'the process set changed: no CPU for this scan');
});
check('no limit anywhere: unknown, with the reason', () => {
    proc(601, { uid: 12240, rss: 4096, start: 95000, cmd: appCmd(12240) });
    const f = path.join(fake, 'var/opt/public/oap/oap_12240/source');
    mkdirp(f);
    fs.writeFileSync(path.join(f, 'package.json'), '{}');
    fs.chmodSync(path.join(f, 'package.json'), 0);
    const a = scanner.scan().apps.find((x) => x.uid === 12240);
    const root = process.getuid && process.getuid() === 0;
    if (!root) {                       // root reads it anyway
        assert.strictEqual(a.metaFrom, 'none');
        assert.strictEqual(a.metaWhy, 'no access');
    }
    assert.strictEqual(a.pct, null);
    if (!root) assert.strictEqual(a.custom, null, 'unknown, so "Custom apps" still shows it');
});
check('no /proc: not ok, no throw', () => {
    const s = procscan.create({ root: path.join(fake, 'nowhere') }).scan();
    assert.strictEqual(s.ok, false);
    assert.deepStrictEqual(s.apps, []);
});
check('the scanner only reads (no write, signal or spawn)', () => {
    const src = fs.readFileSync(path.join(APP, 'procscan.js'), 'utf8') + fs.readFileSync(MAIN, 'utf8');
    [/\.kill\(/, /child_process/, /\bspawn|execSync|execFile|\bexec\(['"`]/, /writeFile|appendFile|unlink|rename|mkdir|rmdir|chmod|chown/]
        .forEach((re) => assert.ok(!re.test(src), 'App Monitor must not use ' + re));
});

/* ---------- the app, drawn with the fake root ---------- */
let app = null;
const realCreate = procscan.create;
const stubs = { './kit/mgu': { run(a) { app = a; } } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req === './procscan') return Object.assign({}, procscan, { create: () => realCreate({ root: fake, selfUid: 12236 }) });
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
async function start(over) {
    delete require.cache[MAIN];
    require(MAIN);
    const S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    Object.assign(S, over || {});
    let texts = [], frame = null;
    const clicks = {};
    await app.start({
        ui: { image: async () => {}, onClick: (n, fn) => { clicks[n] = fn; } },
        settings: { get: (k) => S[k], onChange() {}, cycle(k) { const o = SPEC.settings.find((s) => s.key === k).options.map((x) => x[0]); S[k] = o[(o.indexOf(S[k]) + 1) % o.length]; } },
        log: { info() {}, warn() {} },
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv);
            texts = [];
            cv.text = (str, ...a) => { texts.push(String(str)); return text(str, ...a); };
            return cv;
        },
    });
    return { render: async () => { await frame(); return texts; }, clicks, S };
}
check('the table: custom apps only by default, with limits and %', async () => {
    const a = await start();
    const t = await a.render();
    assert.ok(t.indexOf('redline') >= 0, t.join(' | '));
    assert.ok(t.indexOf('weather') < 0, 'BMW app left out in "Custom apps"');
    assert.ok(t.indexOf('THIS APP') >= 0);
    assert.ok(t.some((s) => /^\d+%$/.test(s)), 'a share of the limit');
    assert.ok(t.indexOf('192 MB') >= 0, 'redline limit 196608 KB');
});
check('all apps, sort cycles', async () => {
    const a = await start({ scope: 'all' });
    assert.ok((await a.render()).indexOf('weather') >= 0);
    a.clicks.BTN_SORT();
    assert.strictEqual(a.S.sort, 'rss');
});
check('demo data where there is no /proc', async () => {
    Module._load = ((prev) => function (req, parent, isMain) {
        if (req === './procscan') return Object.assign({}, procscan, { create: () => realCreate({ root: path.join(fake, 'nowhere') }) });
        return prev.call(this, req, parent, isMain);
    })(Module._load);
    const a = await start();
    const t = await a.render();
    assert.ok(t.indexOf('doom') >= 0, 'the demo apps: ' + t.join(' | '));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    if (failed) { console.log(failed + ' failed'); process.exit(1); }
    console.log('all ' + checks.length + ' passed');
})();
