'use strict';
/**
 * watchdog.js - stops playback before the app manager stops the app. MainApp gives every app a memory threshold
 * (package.json oapAppSettings.memoryThresholdKB, from app.json "memoryKB") and kills an app that goes past it;
 * a killed app's data is wiped, a second time it is uninstalled. So at 70 % of it, playback is stopped (the
 * decoder process goes, buffers are let go) while the app itself stays up.
 *
 * What counts: this process's RSS (process.memoryUsage().rss) plus the RSS of its children (the decoder), read from
 * /proc/<pid>/status, because the decoder's memory is the app's too as far as the unit's limits go.
 *
 *   const wd = new Watchdog({ log, limitKB, ratio: 0.7, children: () => [pid, ...], onTrip(info) })
 *   wd.start(); ... wd.stop();
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_KB = 196608;     // build.py's default memoryThresholdKB

/** The app's memory threshold in KB: package.json next to javascript/ (the installed app), else the default. */
function limitKB(appRoot) {
    const candidates = [path.join(__dirname, '..', 'package.json')];
    if (appRoot) candidates.unshift(path.join(appRoot, 'source', 'package.json'));
    for (const f of candidates) {
        try {
            const pj = JSON.parse(fs.readFileSync(f, 'utf8'));
            const kb = pj && pj.oapAppSettings && Number(pj.oapAppSettings.memoryThresholdKB);
            if (kb > 0) return kb;
        } catch (e) { /* next */ }
    }
    return DEFAULT_KB;
}

/** RSS of a process in bytes from /proc (0 when it is gone or there is no /proc). */
function rssOf(pid) {
    try {
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'));
        return m ? Number(m[1]) * 1024 : 0;
    } catch (e) { return 0; }
}

class Watchdog {
    constructor(o) {
        this.log = o.log;
        this.limit = (o.limitKB || DEFAULT_KB) * 1024;
        this.ratio = o.ratio || 0.7;
        this.children = o.children || (() => []);
        this.onTrip = o.onTrip;
        this.everyMs = o.everyMs || 2000;
        this.rss = o.rss || (() => process.memoryUsage().rss);
        this.childRss = o.childRss || rssOf;
        this.timer = null;
        this.tripped = false;
        this.peak = 0;
        this.last = { self: 0, kids: 0, total: 0 };
    }
    get threshold() { return Math.floor(this.limit * this.ratio); }
    start() {
        if (this.timer) return;
        this.log.info('watchdog: memory limit ' + Math.round(this.limit / 1048576) + ' MB, playback stops at ' + Math.round(this.threshold / 1048576) + ' MB');
        this.timer = setInterval(() => this.check(), this.everyMs);
        if (this.timer.unref) this.timer.unref();
    }
    stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
    /** Re-arm after the app acted on a trip (playback stopped). */
    reset() { this.tripped = false; }
    check() {
        const self = this.rss();
        let kids = 0;
        (this.children() || []).forEach((pid) => { if (pid) kids += this.childRss(pid); });
        const total = self + kids;
        this.last = { self, kids, total };
        if (total > this.peak) this.peak = total;
        // past half of the limit: ask V8 to let go of what it holds (Node 8 frees big buffers late)
        if (total > this.limit * 0.5 && typeof global.gc === 'function') { try { global.gc(); } catch (e) { /* ignore */ } }
        if (total >= this.threshold && !this.tripped) {
            this.tripped = true;
            const info = { self, kids, total, limit: this.limit, ratio: this.ratio };
            this.log.warn('watchdog: ' + Math.round(total / 1048576) + ' MB (app ' + Math.round(self / 1048576) + ' + decoder ' + Math.round(kids / 1048576) +
                ') of ' + Math.round(this.limit / 1048576) + ' MB: stopping playback');
            try { this.onTrip(info); } catch (e) { this.log.error('watchdog trip', e); }
        }
        return this.last;
    }
}

module.exports = { Watchdog, limitKB, rssOf, DEFAULT_KB };
