'use strict';
/**
 * monsim.js - demo data for App Monitor, in the shape procscan.scan() returns: a few apps whose memory breathes
 * and climbs, one of them close to its limit. For the preview, the emulator and a unit without /proc access.
 */
const APPS = [
    // id, uid, base RSS MB, swing MB, limit KB, cpu %, cpuLimit, started (s after boot)
    ['redline', 12223, 92, 14, 196608, 18, 60, 40],
    ['live_data', 12225, 71, 6, 196608, 7, 60, 42],
    ['robertn_store', 12229, 58, 4, 131072, 2, 30, 35],
    ['doom', 12231, 168, 22, 196608, 41, 60, 900],
    ['warmup', 12224, 44, 2, 196608, 1, 60, 41],
    ['app_monitor', 12236, 39, 1, 196608, 3, 60, 1200],
];

function create() {
    const t0 = Date.now();
    return {
        scan() {
            const s = (Date.now() - t0) / 1000, upS = 1500 + s;
            const apps = APPS.map(([id, uid, base, swing, memKB, cpu, cpuLimit, started], k) => {
                const rssKB = Math.round((base + swing * (0.5 + 0.5 * Math.sin(s / (6 + k * 2) + k))) * 1024);
                return { uid, id, version: '1.0.0', pids: [3100 + k * 7], rssKB, hwmKB: Math.round((base + swing) * 1024),
                    threads: 11 + k, cpu: Math.max(0, cpu * (0.7 + 0.6 * Math.abs(Math.sin(s / 3 + k)))), runS: upS - started,
                    memKB, cpuLimit, pct: rssKB / memKB * 100, custom: true, self: id === 'app_monitor', metaFrom: 'package', metaWhy: null };
            });
            return { ok: true, apps, system: { totalKB: 7864320, availableKB: 2516582, uptimeS: upS }, hidden: false, at: Date.now(), demo: true };
        },
    };
}

module.exports = { create };
