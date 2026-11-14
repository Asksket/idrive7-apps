#!/bin/sh
# app-monitor-index.sh - publish every installed OAP app's id, version and oapAppSettings limits for App Monitor.
#
#   sh app-monitor-index.sh            (on the head unit, as root)
#
# Each app's package.json is readable by MainApp and that app only, so App Monitor (apps/app_monitor) can't read the
# other apps' memory limits itself. This reads them as root and writes one world-readable file,
#   /var/opt/public/mgu_app_monitor/limits.json
# It reads the apps' package.json and MainApp's custom_apps.json and writes nothing else: no app, MainApp or
# registry file is changed, and no process is touched. Run it again after installing or updating apps.
set -eu
NODE=${NODE:-/usr/bin/node}
OAP=${OAP:-/var/opt/public/oap}
OUT_DIR=${OUT_DIR:-/var/opt/public/mgu_app_monitor}
[ -x "$NODE" ] || { echo "node not found at $NODE" >&2; exit 1; }
mkdir -p "$OUT_DIR"
chmod 755 "$OUT_DIR"
"$NODE" -e '
const fs = require("fs"), path = require("path");
const oap = process.argv[1], out = process.argv[2];
let custom = {};
try { custom = JSON.parse(fs.readFileSync(path.join(oap, "oap_12201/data/custom_apps.json"), "utf8")) || {}; } catch (e) {}
const apps = {};
fs.readdirSync(oap).forEach((d) => {
    const m = /^oap_(\d+)$/.exec(d);
    if (!m || m[1] === "12201") return;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(oap, d, "source/package.json"), "utf8")); } catch (e) { return; }
    const s = pkg.oapAppSettings || {};
    apps[m[1]] = { id: pkg.name, version: pkg.version, author: typeof pkg.author === "string" ? pkg.author : null,
        memoryThresholdKB: s.memoryThresholdKB, cpuLimit: s.cpuLimit, localOnly: pkg.mguLocalOnly === true,
        custom: pkg.mguLocalOnly === true || Object.prototype.hasOwnProperty.call(custom, pkg.name) };
});
const tmp = out + ".tmp";
fs.writeFileSync(tmp, JSON.stringify({ generated: new Date().toISOString(), apps: apps }, null, 1) + "\n", { mode: 0o644 });
fs.chmodSync(tmp, 0o644);
fs.renameSync(tmp, out);
console.log("App Monitor: limits of " + Object.keys(apps).length + " apps -> " + out);
' "$OAP" "$OUT_DIR/limits.json"
