# TubeCar

An unofficial YouTube client for the BMW MGU (iDrive 7) head unit, built on this repository's kit. Search,
results, playback. **The sound plays through the car's own media player** (speakers, iDrive volume); **the picture
shows only while the car is parked.** Not affiliated with BMW, Google or YouTube.

> **Not yet run on a car.** Everything below was built and tested on a PC under the head unit's Node 8.16.2,
> against stand-ins for YouTube, the uplink, the MGU Store updater, the car's media player and the renderer
> (`kit/tools/test_tubecar.js`, 71 checks). What is not known yet is listed at the end.

## Needs

| | |
|---|---|
| MGU Store with **mgu-uplink** (Internet uplink) | the internet: the head unit has no route of its own. `"internet": true` in `app.json` becomes `"mguInternet": true` in the built `package.json`, and the Store's deploy tool lets this app's uid out |
| A GPU renderer with **video** (this kit's `idrive7-renderd` 2.1.12, or the Store's mgu-render) | the picture. Without it the app plays sound only and says so |
| `/etc/oap/someip` services `CommandControl` and `MediaPlayer/OapGenericMedia` | the sound. Both are `_optional` in `app.json`: a unit without them installs the app, which then says there is no sound |

## How it works

```
 main.js ── ui.js (pages, kit canvas)          the HMI: one canvas screen, bar buttons Prev / Next / Select / Settings
    │
    ├── yt.js ── net.js ───────────────▶ YouTube (InnerTube search, player), names through the uplink lease's DNS
    │
    └── player.js
          ├── net.download ─▶ /dev/shm/tubecar-<uid>/a-<id>.m4a   (complete, 0644, folder 0711)
          │       audio.js: CommandControl.connect(OAPGenericMedia -> MediaSink_Front), MediaPlayer.playFile
          │       ◀── currentItemTime every ~250 ms: the clock for everything
          │
          ├── net.download ─▶ /dev/shm/tubecar-<uid>/v-<id>.mp4   (itag 18, H.264 Baseline, as it arrives)
          │
          └── child_process.fork(decoder_child.js)  ── only while parked and the screen is shown
                  mp4.js (demux) -> h264bsd_wasm.js (decode) -> mgvf.js -> /dev/shm/mgu-video-tubecar
                                                                              │
              display.video(1, file) + cv.video(1, ...) in the page ──────────▶ renderer's video layer (op 19)
```

- **Search and results.** InnerTube `search` as the WEB client; results paged five at a time, more on demand.
- **Files.** InnerTube `player`, tried as `android_vr`, then `ios`, then `android` (each answers with plain file
  addresses); a client is accepted only if its files really download. Sound: itag 140 (AAC, m4a). Picture:
  itag 18 (H.264 Constrained Baseline, 360p), the one profile the software decoder handles.
- **Sound.** The car's media player takes complete files only, so the sound is downloaded first (4 ranged
  connections), then played. Pause is a STOP and resume plays the file again and seeks (the car's player
  ignores PAUSE; reports from cars, see `audio.js`).
- **Picture.** A child process decodes the MP4 as it downloads and writes each picture on time (the car player's
  clock) into the renderer's frame file. Driving (above 3 km/h, `kit/parked`), no renderer, or the screen not
  shown: no picture, the decoder is told to stop (driving) or is killed (screen left).
- **Text.** The kit's fonts are ASCII: titles are folded (`ă` -> `a`, quotes, dashes).

## The required behaviour, and where it is

| Requirement | Where |
|---|---|
| Explicit cleanup on leaving the screen | `main.js` `onShown(false)`: `loop.stop()`, page state dropped, `player.setVisible(false)` kills the decoder process (quit, SIGTERM, SIGKILL after 1 s), unnames and removes the frame file. Sound goes on (setting *Keep the sound playing when leaving the app*, on); with it off, `player.stop()` |
| Explicit cleanup on leaving the app | `main.js` `finish()` on MainApp's `shutdown`, and `process.on('exit')`: timers and loop stopped, watchdog stopped, `player.stopNow()` (downloads aborted, decoder SIGKILLed, STOP + disconnect sent, files removed), sockets closed |
| `player.stop()` | in order: downloads aborted, sound released (STOP, disconnect, the radio back), decoder killed, files removed, references dropped, `global.gc()` where exposed. Idempotent |
| Memory watchdog at ~70 % | `watchdog.js`: the limit is `oapAppSettings.memoryThresholdKB` from the installed `package.json` (`memoryKB` 262144 here), checked every 2 s as this process's `rss` **plus the decoder's** (`/proc/<pid>/status`); at 70 % playback stops with a message, re-armed 15 s later |
| Wi-Fi SSID + password, auto-connect | `wifi.js` + the Wi-Fi page: saved in `data/wifi.json` (0600). See the limit below |
| Connection check at start, clear message, no crash | `main.js` `netCheck()` 300 ms after start (never holding the start up), again every 30 s while offline; badge OFFLINE, the reason on Search and Wi-Fi, searches and plays refused with it |
| A run that died | at start: leftover media files removed (`sweepMedia`), an audio connection it left open disconnected (`data/audio-conn.json`) |

### The Wi-Fi limit

On this platform **an app cannot join a Wi-Fi network.** mgu-uplink (root) joins networks; it takes requests on a
root-only socket, relayed by the MGU Store updater, and `wifi-connect` there is privileged: only the MGU Store
(with a secret in its own data folder) may ask. So TubeCar keeps the network you give it, and at start, if the car
is offline and the uplink does not already know that network, asks the updater to join it. On every unit today
the updater answers `forbidden`, and the app says what to do: join the network once in MGU Store > Settings >
Wi-Fi; mgu-uplink saves it and joins it by itself from then on. If the network is already saved there, the app
just waits for it. (mgu-store `native/mgu-uplink/README.md` "Requests", `native/mgu-updater/README.md` "The socket".)

## Settings

Search language and region; keep the sound playing when leaving the app; remember searches; colour theme. The
Wi-Fi network is on the app's own Wi-Fi page (the kit's settings have no text fields).

## Kit changes this app needs

- `kit/runtime/record.js`: `video(id, x, y, w, h, r)` records the renderer's VIDEO op (19); the software path skips it.
- `kit/runtime/renderd.js`: `video(id, file)` names a frame file (VIDEO 13 / DROP_VIDEO 14, mgu-render/1 with the
  video capability), again after every reconnect and new size; `videoReady()`.
- `kit/runtime/display.js`: `display.video(id, file)`, `display.videoReady()`.
- `kit/tools/build.py`: `"internet": true` -> `"mguInternet": true`.

## Tests

```sh
python3 kit/tools/build.py --preview-only tubecar
node kit/tools/test_tubecar.js                  # 71 checks; needs ffmpeg
node kit/tools/test_tubecar.js --shots DIR      # also each page as a PNG
node kit/tools/test_tubecar.js --real-decoder   # also the real h264bsd WebAssembly decoder on the sample
node kit/tools/preview.js dist/tubecar out wait=3 render BTN_NEXT BTN_OK render   # the whole app, stubbed unit
```

The stand-ins: a DNS server for the lease's names, an HTTP server playing YouTube (bot check on the first
client, then answers) and its file host (byte ranges, a 403), the updater's socket answering `forbidden`, the
car's media player, the renderer. The decoder process runs for real with a stand-in decoder (pacing, pause,
seek, driving, exit when the app goes).

## Not known yet (needs a car)

| | |
|---|---|
| **The real decoder** | `h264bsd_wasm.js` (tinyh264) was never run here: `--real-decoder` does it. Its speed on the unit's Atom at 360p, and whether it loads under the unit's Node 8, are not measured |
| **YouTube's answers** | the clients and their versions are those that answered in public projects in November 2026; not asked from this machine. YouTube binds file addresses to the address that asked, so files are fetched on the car |
| **itag 18** | YouTube has been dropping it for some videos; such a video plays sound only, and says so |
| **The car's media player from an app's uid** | RideTube and others call it from a root daemon; an OAP app has the same services through its manifest (the kit's installer generates their configs), and BMW names the instance after OAP apps, but this exact call from an app was not seen. The media engine must also be able to read `/dev/shm/tubecar-<uid>/` |
| **The renderer drawing this app's frame file** | protocol as documented (`kit/renderd/PROTOCOL.md` "Video"), file owned by the app's uid, not yet drawn by a real renderer |
| **Memory** | a decoder process is about Node's base plus 16 MiB of WebAssembly memory; the 256 MB threshold and 70 % stop are a starting point |
