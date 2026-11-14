'use strict';
/**
 * App Monitor - every running OAP app with its memory (RSS, peak), the share of the memory limit in its
 * oapAppSettings (memoryThresholdKB), its CPU against its cpuLimit, and how long it has been running.
 * Refreshed every few seconds (setting "interval") while the screen is shown.
 *
 * Read-only by design: it reads /proc and package files (procscan.js) and never stops, signals or restarts another
 * process. MainApp's CorruptAppsHandler treats any app process that ends without MainApp stopping it as a crash:
 * it wipes the app's data and, on a second crash, uninstalls it.
 *
 * The limits come from each app's installed package.json, which only MainApp and the app itself can usually read.
 * deploy/app-monitor-index.sh, run as root on the head unit, publishes them (id, version, limits) in a world-readable
 * file this app reads; without it the limit column shows "--" and a note says why.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const procscan = require('./procscan');
const monsim = require('./monsim');

const W = 1600, H = 520;
const GO = '#2fd27a';
const ROW_H = 42;
// columns: [label, x (left edge, or right edge for align right), align]
const COLS = {
    app: [32, 'left'], uid: [430, 'left'], rss: [668, 'right'], peak: [800, 'right'], limit: [935, 'right'],
    bar: [965, 'left'], pct: [1296, 'right'], cpu: [1440, 'right'], run: [1568, 'right'],
};
const BAR_W = 230;

const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

/** KB -> "512 MB", "9.4 MB", "1.2 GB" */
function mb(kb) {
    if (!G.isNum(kb)) return '--';
    const m = kb / 1024;
    if (m >= 1024) return (m / 1024).toFixed(1) + ' GB';
    return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + ' MB';
}
/** seconds -> "45s", "12m 05s", "3h 07m", "2d 04h" */
function runTime(s) {
    if (!G.isNum(s)) return '--';
    s = Math.floor(s);
    const p = (n) => (n < 10 ? '0' : '') + n;
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + p(s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + p(Math.floor(s / 60) % 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + p(Math.floor(s / 3600) % 24) + 'h';
}
const SORTS = {
    pct: (a, b) => (b.pct === null) - (a.pct === null) || (b.pct || 0) - (a.pct || 0) || b.rssKB - a.rssKB,
    rss: (a, b) => b.rssKB - a.rssKB,
    cpu: (a, b) => (b.cpu || 0) - (a.cpu || 0) || b.rssKB - a.rssKB,
    uptime: (a, b) => b.runS - a.runS,
    name: (a, b) => String(a.id || '~' + a.uid).localeCompare(String(b.id || '~' + b.uid)),
};

/** The rows to show: scope (custom apps, or every app), then the sort order. */
function visibleApps(snap, scope, sort) {
    const apps = (snap && snap.apps || []).filter((a) => scope === 'all' || a.custom !== false);
    return apps.sort(SORTS[sort] || SORTS.pct);
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let real = null, sim = null, snap = null, lastScan = -Infinity, page = 0, failed = false;

        function scan() {
            const demo = settings.get('demo');
            try {
                if (demo !== 'on') {
                    real = real || procscan.create();
                    const s = real.scan();
                    if (s.ok || demo === 'off') { snap = s; failed = false; return; }
                }
                sim = sim || monsim.create();
                snap = sim.scan();
            } catch (e) {
                // never let a read error end the app (MainApp counts that as a crash)
                if (!failed) log.warn('scan failed: ' + (e && e.stack || e));
                failed = true;
                snap = { ok: false, why: 'scan failed: ' + (e && e.message || e), apps: [] };
            }
        }

        ui.onClick('BTN_SORT', () => { settings.cycle('sort'); page = 0; });
        ui.onClick('BTN_PAGE', () => { page++; });
        settings.onChange(() => { lastScan = -Infinity; });

        function render() {
            const m = mono();
            if (m - lastScan >= settings.get('interval') * 1000) { lastScan = m; scan(); }
            const t = ctx.theme(), warnAt = settings.get('warnAt');
            const cv = ctx.canvas(W, H).clear(t.bg);
            const apps = visibleApps(snap, settings.get('scope'), settings.get('sort'));

            // ---- notes (bottom), from the most to the least important
            const notes = [];
            if (snap && !snap.ok) notes.push([snap.why, t.warn]);
            if (snap && snap.hidden) notes.push(['/proc is mounted with hidepid: other apps\' processes are hidden from this app', t.warn]);
            const noLimit = apps.filter((a) => a.metaFrom === 'none').length;
            if (noLimit) {
                notes.push(['No limit readable for ' + noLimit + (noLimit === 1 ? ' app' : ' apps') +
                    ' (its package.json is private): run deploy/app-monitor-index.sh as root to publish them', t.dim]);
            }
            const bottom = G.pageBottom(cv) - notes.length * 28;

            // ---- summary line
            const sys = (snap && snap.system) || {};
            const total = apps.reduce((n, a) => n + a.rssKB, 0);
            let x = 32;
            const item = (label, value, col) => {
                x += cv.text(label, x, 84, 18, t.dim, { font: 'bold', spacing: 1.5 }) + 10;
                x += cv.text(value, x, 84, 26, col || t.text, { font: 'bold' }) + 40;
            };
            item(settings.get('scope') === 'all' ? 'APPS' : 'CUSTOM APPS', String(apps.length));
            item('TOTAL RSS', mb(total));
            if (G.isNum(sys.availableKB) && G.isNum(sys.totalKB)) {
                const freePct = sys.availableKB / sys.totalKB * 100;
                item('SYSTEM AVAILABLE', mb(sys.availableKB) + ' / ' + mb(sys.totalKB), freePct < 10 ? t.crit : freePct < 20 ? t.warn : null);
            }
            const rowsFit = Math.max(1, Math.floor((bottom - 140) / ROW_H));
            const pages = Math.max(1, Math.ceil(apps.length / rowsFit));
            page %= pages;
            cv.text('every ' + settings.get('interval') + ' s' + (pages > 1 ? '  ·  page ' + (page + 1) + '/' + pages : ''),
                1568, 84, 20, t.dim, { align: 'right' });

            // ---- table
            const head = 122;
            const label = (k, s) => cv.text(s, COLS[k][0], head, 16, t.dim, { align: COLS[k][1], font: 'bold', spacing: 1.5 });
            label('app', 'APP'); label('uid', 'UID'); label('rss', 'RSS'); label('peak', 'PEAK'); label('limit', 'LIMIT');
            label('bar', 'OF LIMIT'); label('cpu', 'CPU / LIMIT'); label('run', 'RUNNING');
            cv.fillRect(24, head + 10, 1552, 1, withAlpha(t.tick || t.dim, 0.4));
            if (!apps.length) {
                cv.text(snap && snap.ok ? 'No ' + (settings.get('scope') === 'all' ? '' : 'custom ') + 'app is running' : 'No data',
                    32, head + 60, 26, t.dim);
            }
            apps.slice(page * rowsFit, (page + 1) * rowsFit).forEach((a, k) => {
                const y = head + 18 + k * ROW_H, base = y + ROW_H * 0.68;
                if (k % 2 === 1) cv.fillRect(24, y, 1552, ROW_H, withAlpha('#ffffff', 0.03));
                const cell = (key, s, col, font) => cv.text(s, COLS[key][0], base, 24, col || t.text, { align: COLS[key][1], font: font || 'label' });
                const level = G.isNum(a.pct) ? (a.pct >= 95 ? t.crit : a.pct >= warnAt ? t.warn : null) : null;
                const name = (a.id || 'oap_' + a.uid) + (a.pids.length > 1 ? '  ×' + a.pids.length : '');
                const nw = cell('app', name, level || t.text, 'bold');
                if (a.self) cv.text('THIS APP', COLS.app[0] + nw + 12, base - 2, 14, t.dim, { font: 'bold', spacing: 1.5 });
                cell('uid', String(a.uid), t.dim);
                cell('rss', mb(a.rssKB), level);
                cell('peak', mb(a.hwmKB), t.dim);
                cell('limit', a.memKB ? mb(a.memKB) : '--', a.memKB ? t.text : t.dim);
                // share of the limit: a bar (the warn level marked) and the %
                const bx = COLS.bar[0], by = y + ROW_H / 2 - 5;
                cv.roundRect(bx, by, BAR_W, 10, 5, t.track);
                cv.fillRect(bx + BAR_W * G.clamp(warnAt / 100, 0, 1), by - 3, 2, 16, withAlpha(t.warn, 0.7));
                if (G.isNum(a.pct)) {
                    const f = G.clamp(a.pct / 100, 0, 1);
                    if (f > 0) cv.roundRect(bx, by, Math.max(10, BAR_W * f), 10, 5, level || GO);
                    cell('pct', Math.round(a.pct) + '%', level || t.text, 'bold');
                } else {
                    cell('pct', a.metaFrom === 'none' ? a.metaWhy || 'n/a' : 'n/a', t.dim);
                }
                const cpu = G.isNum(a.cpu) ? Math.round(a.cpu) + '%' : '--';
                const cpuHot = G.isNum(a.cpu) && G.isNum(a.cpuLimit) && a.cpu >= a.cpuLimit * warnAt / 100;
                cell('cpu', cpu + (G.isNum(a.cpuLimit) ? ' / ' + a.cpuLimit + '%' : ''), cpuHot ? t.warn : null);
                cell('run', runTime(a.runS));
            });

            notes.forEach(([s, col], i) => cv.text(s, 32, G.pageBottom(cv) - 10 - (notes.length - 1 - i) * 28, 20, col));
            G.frame(cv, t, ['Apps'], 0, [snap && snap.demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh with the GPU renderer, 2 fps in software (PNG frames); /proc is read only every
        // "interval" seconds, and only while the screen is shown
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { mb, runTime, visibleApps };
