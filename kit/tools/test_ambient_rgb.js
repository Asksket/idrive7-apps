'use strict';
// Ambient config's any colour (apps/ambient_config: lin.js, scenes.js, lights.js, control.js): the body controller's
// status read and writes, the animations, one write at a time with the lights renewed and given back, the
// driving modes' looks, favourites and the flash file.
//   node kit/tools/test_ambient_rgb.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-rgb-'));
process.env.MGU_AMBIENT_FLASH = path.join(TMP, 'flash.json');
const A = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const L = require(path.join(A, 'lin'));
const S = require(path.join(A, 'scenes'));
const { Lights, sameShade } = require(path.join(A, 'lights'));
const { Control, DEFAULT_LOOK } = require(path.join(A, 'control'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// status reply: 62 DA5F, records of 10 (location, blue, green, red, brightness, white, 4 faults), empty FF
const reply = (did, locs, fault) => {
    const b = [0x62].concat(did);
    for (let i = 0; i < 26; i++) b.push.apply(b, locs[i] ? [locs[i], 254, 60, 120, 100, 0, fault === i ? 1 : 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
    return b.concat([2]);
};
// the ring: a tap near red / green / blue gives exactly that colour; the < / > steps land on them (#135)
const same = (a, b) => a.join() === b.join();
ok(same(S.hsv(S.snapHue(3), 1, 1), [255, 0, 0]) && same(S.hsv(S.snapHue(357.5), 1, 1), [255, 0, 0]), 'a tap 3 degrees off red is red');
ok(same(S.hsv(S.snapHue(118), 1, 1), [0, 255, 0]) && same(S.hsv(S.snapHue(244), 1, 1), [0, 0, 255]), 'near green / blue: exactly green / blue');
ok(S.snapHue(20) === 20 && S.snapHue(90) === 90, 'a hue between them stays as tapped');
let h = S.hueOf([120, 60, 255]), seen = [];      // the default violet, 258.5 degrees
for (let i = 0; i < 24; i++) { h = S.stepHue(h, 15); seen.push(h); }
ok(seen.indexOf(0) >= 0 && seen.indexOf(120) >= 0 && seen.indexOf(240) >= 0 && seen.every((x) => x % 15 === 0 && x >= 0 && x < 360), '> from violet comes to 0, 120, 240 exactly');
ok(S.stepHue(0, -15) === 345 && S.stepHue(345, 15) === 0, '< from red wraps to 345, > back to red');
const bus1 = L.parseStatus(0, reply([0xda, 0x5f], [0x0f, 0x0e, 0x0c], 1));
ok(bus1.length === 3 && bus1[2].nad === 3 && bus1[2].name === 'Passenger front door line' && bus1[2].part === 'upper' && bus1[1].part === 'lower', 'status: lights, places, upper / lower');
ok(bus1[0].rgb.join() === '120,60,254' && bus1[0].bright === 100 && bus1[1].fault && !bus1[0].fault, 'status: colour read red, green, blue; a fault');
ok(L.parseStatus(0, [0x7f, 0x22, 0x31]) === null && L.parseStatus(1, reply([0xda, 0x5f], [1])) === null, 'status: a refusal or another bus\'s reply is none');
ok(L.writeFrame(0, 3, [255, 0, 300], 120, 400).join() === [0xda, 0x5e, 3, 1, 100, 0xfe, 0, 0xfe, 254].join(), 'write: colours stop at FE, brightness 100, 254 s');
ok(L.writeFrame(1, 1, [10, 20, 30], 50, 5).slice(0, 2).join() === [0xe3, 0xd1].join() && L.releaseFrame(1, 4).join() === [0xe3, 0xd1, 4, 0, 0, 0, 0, 0, 0].join(), 'bus 2 write; give back');
{
    // a G30's bus: 19 lights, then 7 empty records with location 00 and colour FF FF FF
    const g30 = [0x62, 0xda, 0x5f];
    for (let i = 0; i < 26; i++) g30.push.apply(g30, i < 19 ? [0x01 + i, 58, 5, 0, 100, 0, 0, 0, 0, 0] : [0, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);
    const got = L.parseStatus(0, g30);
    ok(got.length === 19 && got.every((l) => l.loc !== 0), 'status: a G30\'s empty records (location 00) are no lights (' + got.length + ')');
}
ok(L.sample().length === 19, 'the picture\'s G20 before the car answers');

// scenes
const look = (kind, extra) => Object.assign({ kind, upper: { rgb: [255, 0, 0], bright: 80 }, lower: { rgb: [0, 0, 255], bright: 40 }, speed: 2 }, extra);
const up = { part: 'upper', y: 0.2 }, low = { part: 'lower', y: 0.8 };
ok(S.lightAt(look('solid'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('solid'), low, 0).bright === 40, 'solid: upper and lower colours');
const br = [0, 1000, 2000].map((t) => S.lightAt(look('breathing'), up, t).bright);
ok(br[0] < 15 && br[2] === 80 && br[1] > br[0] && br[1] < br[2], 'breathing: dim to bright (' + br + ')');
ok(S.lightAt(look('rainbow'), up, 0).rgb.join() !== S.lightAt(look('rainbow'), up, 4000).rgb.join(), 'rainbow moves on');
ok(S.lightAt(look('fade'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('fade'), up, 4000).rgb.join() === '0,0,255', 'fade: upper colour to lower');
ok(S.lightAt(look('wave'), { part: 'upper', y: 0 }, 0).rgb.join() !== S.lightAt(look('wave'), { part: 'upper', y: 0.25 }, 0).rgb.join(), 'wave: front and rear differ');
ok(S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 100).bright === 0 && S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 2600).bright === 80, 'welcome: the rear comes on last');
ok(S.lightAt(look('pulse'), low, 1000).rgb.join() === '255,0,0' && S.lightAt(look('pulse'), low, 1600).rgb.join() === '0,0,255', 'pulse: red for 1.5 s, then the colour');
ok(S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 0 }, 300).rgb.join() === S.lightAt(look('wave'), { part: 'lower', y: 0.8, bus: 0 }, 300).rgb.join()
    && S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 0 }, 300).rgb.join() !== S.lightAt(look('wave'), { part: 'upper', y: 0, bus: 1 }, 300).rgb.join(),
    'wave on the car: one colour a bus, the buses apart');
ok(S.moves(look('wave')) && !S.moves(look('solid')) && S.lasts(look('welcome')) > 0 && S.lasts(look('wave')) === 0, 'moving and once-only scenes');
ok(Math.round(S.hueOf([0, 0, 255])) === 240 && S.hsv(120, 1, 1).join() === '0,255,0', 'hue');

(async () => {
    // a body controller (as the car's, BDC_G05): remembers each light's colour, NAD 0 colours every light of its bus,
    // reads report what the lights show; drop: the next write to that NAD is answered but not taken (as the car does)
    const BUS = [[0x0f, 0x0c], [0x15, 0x01, 0x05, 0x13]];
    const lit = BUS.map((b) => b.map(() => [0, 0, 0]));
    const writes = [];
    let refuse = false, drop = null, asleep = false, dimRead = 1;   // dimRead: the reads scaled, as a G30 reports them
    const diag = {
        physical: async (target, sid, data) => {
            await sleep(2);
            if (target !== L.BDC) return null;
            const bus = data[0] === 0xda ? 0 : 1;
            if (sid === 0x22 && asleep) return null;
            if (sid === 0x22) {
                const b = [0x62].concat(data);
                for (let i = 0; i < 26; i++) b.push.apply(b, BUS[bus][i] ? [BUS[bus][i], Math.round(lit[bus][i][2] * dimRead), Math.round(lit[bus][i][1] * dimRead), Math.round(lit[bus][i][0] * dimRead), 100, 0, 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
                return b.concat([2]);
            }
            writes.push(data.slice());
            if (refuse) return [0x7f, 0x2e, 0x22];
            const nad = data[2], rgb = data[3] ? data.slice(5, 8) : [0, 0, 0];
            if (drop !== null && drop.bus === bus && drop.nad === nad) drop = null;
            else if (nad === 0) lit[bus].forEach((x, i) => { lit[bus][i] = rgb; });
            else if (lit[bus][nad - 1]) lit[bus][nad - 1] = rgb;
            return [0x6e, data[0], data[1]];
        },
    };
    const lights = new Lights({ diag, log, checkMs: 40 });
    const found = await lights.find();
    ok(found.length === 6 && lights.state === 'car', 'find: both buses, nothing written yet');
    ok(writes.length === 0, 'nothing written before a colour is picked');

    lights.show(look('solid', { lower: { rgb: [255, 0, 0], bright: 80 } }));
    await sleep(100);
    ok(writes.length === 2 && writes.every((w) => w[2] === 0) && lights.state === 'ours', 'one colour on every light: one write a bus, NAD 0 (' + writes.length + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '254,0,0'), 'every light red');

    writes.length = 0;
    lights.show(look('solid'));
    await sleep(100);
    const fw = writes.find((w) => w[0] === 0xe3 && w[2] === 2);
    ok(writes.length === 2 && writes.every((w) => w[2] !== 0), 'from all red to lower blue: only the two lower lights written, the red ones left as they are (' + writes.map((w) => w[2]).join() + ')');
    ok(fw && fw[4] === 40 && fw[7] === 0xfe && fw[8] === 60, 'the footwell (lower): blue at 40 %, held 60 s');
    ok(lit[1][1].join() === '0,0,254' && lit[1][0].join() === '254,0,0', 'the footwell blue, the dash red');
    await sleep(300);
    ok(writes.length === 2, 'a still colour: read back, nothing more until the renewal');

    // the car puts its own colour on by itself after our checks (as on a new driving mode): left as it is until the
    // renewal, unless asked to look again (recheck): then written again within the next read-back
    lit[0].forEach((x, i) => { lit[0][i] = [0, 0, 254]; }); lit[1].forEach((x, i) => { lit[1][i] = [0, 0, 254]; });
    writes.length = 0;
    await sleep(200);
    ok(writes.length === 0 && lit[1][0].join() === '0,0,254', 'the car\'s own colour over ours: not seen without a read-back');
    lights.recheck(3);
    await sleep(300);
    // (bus 1: 0x0f pocket lower, 0x0c door line upper; bus 2: 0x15 dash, 0x01 footwell lower, 0x05 and 0x13 lines)
    const want = [['0,0,254', '254,0,0'], ['254,0,0', '0,0,254', '254,0,0', '254,0,0']];
    ok(lit.every((b, i) => b.every((c, j) => c.join() === want[i][j])) && writes.length === 4 && writes.every((w) => w[2] !== 0),
        'recheck: read back, the upper lights red again, each on its own (the footwell, still blue, not touched) (' + writes.length + ' writes)');
    // reassert (a new driving mode): the car's own colour on every light; once the car takes writes again the whole look
    // goes on (a write a bus for the majority first), then every light once more on its own, then one read-back
    lit[0].forEach((x, i) => { lit[0][i] = [0, 0, 254]; }); lit[1].forEach((x, i) => { lit[1][i] = [0, 0, 254]; });
    writes.length = 0;
    lights.reassert({ whole: 30, each: 140 });
    ok(lights._checks === 0 && !lights._checkAt, 'reassert: no read-back before the rewrites (a read holds the writes up)');
    await sleep(120);
    const whole = writes.slice();
    ok(lit.every((b, i) => b.every((c, j) => c.join() === want[i][j])) && whole.some((w) => w[0] === 0xe3 && w[2] === 0),
        'reassert, the whole look: the majority on the whole bus at once, then the others (' + whole.map((w) => w[2]).join() + ')');
    await sleep(250);
    const each = writes.slice(whole.length);
    ok(each.length >= 6 && each.every((w) => w[2] !== 0) && lit.every((b, i) => b.every((c, j) => c.join() === want[i][j])),
        'reassert, then each light once more on its own, nothing on the whole bus (' + each.length + ' writes)');
    lights._perLightTill = 0;
    // the zone test: each light on its own (no NAD 0), then read back; a light the body module drops: missed
    writes.length = 0; drop = { bus: 1, nad: 2 }; lit[1][1] = [0, 254, 0];
    const tr = await lights.test();
    ok(tr.length === 6 && writes.every((w) => w[2] !== 0) && writes.length === 6, 'zone test: one write a light, by its NAD');
    const fw2 = tr.find((r) => r.light.bus === 1 && r.light.nad === 2), dash = tr.find((r) => r.light.bus === 1 && r.light.nad === 1);
    ok(fw2 && fw2.reply === '6E' && !fw2.ok && dash.ok && dash.want.join() === '0,254,0' && tr.filter((r) => r.ok).length === 5,
        'zone test: upper red, lower blue, the dropped one missed');
    ok(lights.tested && lights.tested.results === tr && !lights.held, 'zone test: kept for the Check tab, the writing goes on');
    await sleep(300);
    ok(lit[1][1].join() === '0,0,254' && lit[1][0].join() === '254,0,0', 'after the zone test: the look written again');
    // a G30 reads each colour scaled (254,0,0 as 44,2,0): the zone test and the read-back compare the shade
    dimRead = 0.18; drop = null;
    const tr2 = await lights.test();
    ok(tr2.every((r) => r.ok), 'zone test, reads scaled: every light took it (' + tr2.filter((r) => r.ok).length + ' of ' + tr2.length + ')');
    await sleep(300);
    writes.length = 0; lights.recheck(2);
    await sleep(300);
    ok(writes.length === 0, 'read back scaled: nothing written again (' + writes.length + ' writes)');
    dimRead = 1;
    ok(sameShade([254, 0, 0], [44, 2, 0]) && sameShade([0, 0, 254], [0, 5, 58]) && !sameShade([254, 0, 0], [0, 5, 58]) && !sameShade([254, 0, 0], [0, 0, 0]) && !sameShade([254, 0, 0], [254, 100, 0])
        && sameShade([160, 0, 254], [20, 2, 24]) && sameShade([160, 0, 254], [32, 1, 31]) && sameShade([0, 254, 0], [0, 73, 0]) && !sameShade([160, 0, 254], [0, 5, 58]),
        'the shade: a G30\'s dimmed reads match, another colour or dark does not');
    lit[1][3] = [9, 9, 9];
    const rb = await lights.readBack();
    ok(rb.find((l) => l.bus === 1 && l.nad === 4).rgb.join() === '9,9,9' && lights.readAt > 0 && !lights.held, 'read lights: the colours as the body module reports them');
    await sleep(300);
    lights.show(look('breathing')); lights.recheck(3);
    ok(lights._checks === 0, 'recheck: nothing to read back for a moving look (written over and over anyway)');
    lights.show(look('solid'));
    await sleep(300);

    // the body controller drops a write (answered 6E, not taken): the read-back writes it again
    writes.length = 0; drop = { bus: 1, nad: 0 };
    lights.show(look('solid', { upper: { rgb: [0, 255, 0], bright: 80 }, lower: { rgb: [0, 255, 0], bright: 80 } }));
    await sleep(400);
    ok(lit[1].every((c) => c.join() === '0,254,0') && writes.length === 3, 'a dropped write: seen in the read-back, written again (' + writes.length + ')');

    writes.length = 0;
    lights.show(look('breathing', { speed: 3 }));
    await sleep(600);
    ok(writes.length > 10 && writes.every((w) => w[8] === 5) && writes.filter((w) => w[2] === 0).length > 5, 'moving: written over and over, held 5 s, a bus at a time (' + writes.length + ')');
    writes.length = 0;
    lights.show(look('rainbow'));
    await sleep(60);
    // (the first write may be the breathing's, under way when the rainbow was put on)
    const rbw = writes.slice(0, 4).filter((w) => w[2] === 0);
    ok(rbw.length >= 2 && rbw[0].slice(5, 8).join() === rbw[1].slice(5, 8).join() && rbw[0][0] !== rbw[1][0], 'rainbow: the whole car one colour, one write a bus');
    writes.length = 0;
    lights.show(look('wave'));
    await sleep(100);
    ok(writes.length >= 2 && writes.every((w) => w[2] === 0) && writes[0].slice(5, 8).join() !== writes[1].slice(5, 8).join(),
        'a colour wave: a colour a bus, one write each (NAD 0), the two buses apart');

    writes.length = 0;
    lights.carColour();
    await sleep(300);
    const offs = writes.filter((w) => w[3] === 0 && w[8] === 0);
    ok(offs.length === 2 && offs.every((w) => w[2] === 0) && lights.state === 'car', 'original colour: every light given back, one write a bus (' + writes.map((w) => w[2] + '/' + w[3]).join() + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'every light given back');

    writes.length = 0;
    lights.flash([0, 255, 0], 200);
    await sleep(120);
    ok(writes.length >= 2 && writes.slice(0, 2).every((w) => w[2] === 0 && w[5] === 0 && w[6] === 0xfe), 'flash: green on every light, one write a bus');
    await sleep(500);
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'after the flash with the car\'s colour on: given back');

    // an overlay with the car's own colour on: only the lights it picks are written, the rest keep the car's colour
    writes.length = 0;
    lights.overlay('doors', (l) => l.name === 'Driver front door line', () => ({ rgb: [255, 0, 0], bright: 100 }));
    await sleep(150);
    ok(writes.length >= 1 && writes.every((w) => w[0] === 0xe3 && w[2] === 3) && lit[1][2].join() === '254,0,0' && lit[1][0].join() === '0,0,0',
        'an open door: its light red alone, no write to the whole bus (' + writes.map((w) => w[2]).join() + ')');
    writes.length = 0;
    lights.overlay('turn', (l) => /^Passenger/.test(l.name), (t) => ({ rgb: [0, 230, 60], bright: 50 }));
    await sleep(150);
    ok(writes.some((w) => w[0] === 0xda && w[2] === 0) && lit[0].every((c) => c.join() === '0,230,60') && lit[1][2].join() === '254,0,0',
        'a turn signal\'s glow over that side (a bus all of it: one write), the door still red');
    // a blink: on one frame, off the next
    writes.length = 0;
    lights.overlay('turn', (l) => l.name === 'Driver front door line', (t, on) => (on ? { rgb: [0, 230, 60], bright: 100 } : { rgb: [0, 0, 0], bright: 0 }));
    await sleep(200);
    const nad3 = writes.filter((w) => w[0] === 0xe3 && w[2] === 3).map((w) => w[4]);
    ok(nad3.length >= 4 && nad3.every((b, i) => i === 0 || b !== nad3[i - 1]), 'a blink: fully on, then dark, write after write (' + nad3.join() + ')');
    lights.overlay('doors', null); lights.overlay('turn', null);
    await sleep(300);
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'both taken off with the car\'s colour on: given back');

    // a door blinking over a two-colour look (upper red, lower blue): only the door's light is written, never the whole
    // bus, so the other lights keep their colours (the car: every light swapping red and blue while the door was open)
    lights.show(look('solid'));
    await sleep(300);
    writes.length = 0;
    const seen = [];
    lights.overlay('doors', (l) => l.name === 'Driver front door line', (t, on) => (on ? { rgb: [255, 0, 0], bright: 100 } : { rgb: [0, 0, 0], bright: 0 }));
    for (let i = 0; i < 20; i++) { await sleep(10); seen.push(lit[1][1].join()); }
    ok(writes.length >= 3 && writes.every((w) => w[2] === 3) && seen.every((c) => c === '0,0,254'),
        'a door blinking over upper red / lower blue: its light alone, the footwell stays blue (' + writes.map((w) => w[2]).join() + ')');
    lights.overlay('doors', null);
    await sleep(300);
    lights.carColour();
    await sleep(300);

    refuse = true; writes.length = 0;
    lights.show(look('solid', { upper: { rgb: [1, 2, 3], bright: 50 } }));
    await sleep(400);
    ok(writes.length === 4 && /refused/.test(lights.error), 'refused writes: paused after 4 (' + writes.length + ', ' + lights.error + ')');
    // giving back to a body module that no longer answers (the car going to sleep): each bus tried 3 times, then left
    refuse = false; lights._pauseTill = 0;
    lights.show(look('solid', { upper: { rgb: [9, 9, 9], bright: 50 } }));
    await sleep(150);
    refuse = true; asleep = true; writes.length = 0;
    lights.carColour();
    await sleep(12500);
    const gb = writes.filter((w) => w[3] === 0);
    ok(gb.length <= 6 && gb.length >= 2, 'a give-back not taken: at most 3 tries a bus, then nothing more (' + gb.length + ')');
    writes.length = 0; await sleep(300);
    ok(writes.length === 0, 'and nothing after');
    refuse = false; asleep = false;
    lights.stop();

    // control: the driver's look, driving modes, favourites
    const values = { follow: true, keep: true, welcome: false, sportPulse: true, nightDim: true, flashAlerts: true }, fns = [];
    const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f) => fns.push(f) };
    const shows = [];
    const fake = { scene: null, overs: {}, show(s) { this.scene = s; shows.push(s); }, carColour() { this.scene = null; shows.push(null); }, dim(f) { this.f = f; }, flash(rgb, ms) { this.flashed = [rgb, ms]; },
        overlay(k, test, at) { if (test) this.overs[k] = { test, at }; else delete this.overs[k]; }, recheck(n) { this.rechecks = (this.rechecks || 0) + 1; }, reassert() { this.reasserts = (this.reasserts || 0) + 1; } };
    const amb = new EventEmitter(); amb._m = 'comfort'; amb.mode = () => amb._m;
    const c = new Control({ settings, lights: fake, ambient: amb, log });
    c.start();
    ok(shows.length === 1 && shows[0] === null, 'start: nothing picked, the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    ok(values.on === true && fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.lower.rgb.join() === DEFAULT_LOOK.lower.rgb.join(), 'a colour picked: on, the rest of the look kept');
    c.setModeLook('sport', look('breathing'));
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.kind === 'pulse' && fake.scene.then.kind === 'breathing', 'Sport picked: the pulse, then Sport\'s look');
    const ra = fake.reasserts || 0;
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene.kind === 'solid' && fake.scene.upper.rgb.join() === '0,255,0', 'Comfort (Leave as is): the driver\'s look back');
    ok(fake.reasserts === ra + 1, 'a new driving mode: every light written again over the next seconds');
    settings.set('follow', false); c.apply();
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.kind !== 'breathing', 'not following: the driver\'s look in Sport too');
    settings.set('follow', true);
    c.carColour();
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene === null, 'car colour back, Comfort Leave as is: the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    c.setModeLook('comfort', 'original');
    ok(fake.scene === null && c.modeOriginal('comfort'), 'Comfort on Original colour: BMW\'s colour, the Colour tab\'s colour on');
    c.setModeLook('comfort', null);
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,255,0', 'Original colour undone: the Colour tab\'s colour back');
    c.carColour();
    c.night(true); ok(fake.f === 0.5, 'night: dimmer');
    settings.set('nightDim', false); c.night(true); ok(fake.f === 1, 'night dimming off');

    for (let i = 0; i < 7; i++) { c.setLook({ upper: { rgb: [i, 0, 0], bright: 50 } }); c.saveFav(); }
    ok(c.favs().length === 6 && c.favs()[0].upper.rgb[0] === 1, 'favourites: six, the oldest goes');
    c.useFav(2); ok(c.look().upper.rgb[0] === 3 && values.on, 'a favourite put on');
    c.dropFav(0); ok(c.favs().length === 5, 'a favourite deleted');

    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    await sleep(700);
    ok(fake.flashed && fake.flashed[1] === 1000, 'the flash file: a flash, at least 1 s (all the lights)');
    settings.set('flashAlerts', false); fake.flashed = null;
    await sleep(50);
    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    const t = new Date(Date.now() + 2000); fs.utimesSync(process.env.MGU_AMBIENT_FLASH, t, t);
    await sleep(700);
    ok(!fake.flashed, 'flashes off: none');
    c.stop();

    // the car locked and left: the car's own light; someone back in: the look again
    c.setLook({ kind: 'solid', upper: { rgb: [0, 0, 255], bright: 60 } });
    c.away(true);
    ok(fake.scene === null && values.on === true, 'parked, nobody in: the car\'s own light, the look kept for later');
    c.away(false);
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,0,255', 'someone back in: the look again');
    // the turn signals and the doors over the look, each with its setting
    const pl = (code) => L.place(code);
    // both off until switched on (a car on Original colour gets no writes from a turn signal or a door)
    c.turn('left'); c.doors(['driver front']);
    ok(!fake.overs.turn && !fake.overs.doors, 'Turn signal glow and Open door red: off by default');
    c.turn(null); c.doors([]);
    values.turnGlow = true; values.doorRed = true;
    c.turn('left');
    ok(fake.overs.turn && fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x19)) && !fake.overs.turn.test(pl(0x0c)) && !fake.overs.turn.test(pl(0x01)),
        'left turn signal: the driver\'s side lights (left-hand drive), not the footwells nor the other side');
    const g = [true, false].map((on) => fake.overs.turn.at(0, on));
    ok(g[0].rgb.join() === '0,230,60' && g[0].bright === 100 && g[1].bright === 0 && g[1].rgb.join() === '0,0,0', 'its blink: green fully on, then dark');
    values.drive = 'rhd'; c.turn('left');
    ok(fake.overs.turn.test(pl(0x0c)) && !fake.overs.turn.test(pl(0x05)), 'right-hand drive: left is the passenger\'s side');
    values.drive = 'lhd'; c.turn('both');
    ok(fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x0c)), 'hazards: both sides');
    ok(!fake.overs.hazard, 'Hazard red: off by default');
    settings.set('hazardRed', true); c.signals();
    const hz = fake.overs.hazard;
    ok(hz && hz.test(pl(0x05)) && hz.test(pl(0x01)) && hz.test(pl(0x13)) && !fake.overs.turn, 'Hazard red on: every light, in place of the green glow');
    const hp = [true, false].map((on) => hz.at(0, on));
    ok(hp[0].rgb.join() === '255,0,0' && hp[0].bright === 100 && hp[1].rgb.join() === '255,0,0' && hp[1].bright > 0 && hp[1].bright < 50, 'its pulse: red bright, then dim');
    c.turn('left');
    ok(!fake.overs.hazard && fake.overs.turn && fake.overs.turn.test(pl(0x05)), 'a plain turn signal: no red, the green glow');
    c.turn('both'); c.away(true);
    ok(!fake.overs.hazard, 'the car locked and left: no red pulse');
    c.away(false);
    ok(fake.overs.hazard, 'someone back in, hazards still on: the pulse again');
    settings.set('hazardRed', false); c.signals();
    ok(!fake.overs.hazard && fake.overs.turn, 'Hazard red off: the green glow on both sides again');
    c.away(true);
    ok(!fake.overs.turn, 'the car locked and left: no glow');
    c.away(false); c.turn(null);
    ok(!fake.overs.turn, 'turn signal off: the glow off');
    settings.set('turnGlow', false); c.turn('right');
    ok(!fake.overs.turn, 'Turn signal glow off: none');
    c.doors(['passenger rear']);
    ok(fake.overs.doors && fake.overs.doors.test(pl(0x10)) && fake.overs.doors.test(pl(0x22)) && fake.overs.doors.test(pl(0x45)) && !fake.overs.doors.test(pl(0x0c))
        && fake.overs.doors.at(0).rgb.join() === '255,0,0' && fake.overs.doors.at(0).bright === 100 && fake.overs.doors.at(1600).bright === 35
        && fake.overs.doors.at(2500).bright === 0 && fake.overs.doors.at(3500).bright === 35 && fake.overs.doors.at(3900).bright === 100,
        'the passenger rear door open: its lights pulse red slowly (full, half, dark, half), the front door\'s not');
    c.away(true);
    ok(!fake.overs.doors, 'the car locked and left with a door open: no red, so the body module can sleep');
    c.away(false);
    ok(fake.overs.doors && fake.overs.doors.test(pl(0x10)), 'someone back in, the door still open: red again');
    c.doors([]);
    ok(!fake.overs.doors, 'closed: red off');
    settings.set('doorRed', false); c.doors(['driver front']);
    ok(!fake.overs.doors, 'Open door red off: none');
    // a car with door lines (G20): only those blink, one write each a frame; a door without its own line: all its lights
    fake.lights = [0x05, 0x07, 0x08, 0x09, 0x0b, 0x21, 0x13, 0x01, 0x0c, 0x0e, 0x0f, 0x10, 0x12, 0x22, 0x04].map(pl);
    settings.set('turnGlow', true); settings.set('doorRed', true); c.turn('left');
    ok(fake.overs.turn.test(pl(0x05)) && fake.overs.turn.test(pl(0x09)) && !fake.overs.turn.test(pl(0x07)) && !fake.overs.turn.test(pl(0x0b))
        && !fake.overs.turn.test(pl(0x0c)), 'door lines on the car: the turn glow blinks the driver\'s front and rear door lines only');
    c.doors(['passenger rear']);
    ok(fake.overs.doors.test(pl(0x10)) && fake.overs.doors.test(pl(0x12)) && fake.overs.doors.test(pl(0x22)) && fake.overs.doors.test(pl(0x11)) && !fake.overs.doors.test(pl(0x0c)),
        'an open door blinks all its lights (line, decor, pocket, handle), not another door\'s');
    c.doors([]); c.doors(['driver front']);
    fake.lights = fake.lights.filter((l) => l.loc !== 0x05);
    ok(fake.overs.doors.test(pl(0x07)) && fake.overs.doors.test(pl(0x08)), 'a door without its line: its other lights blink');
    delete fake.lights;
    values.turnGlow = undefined; values.doorRed = undefined; c.doors([]); c.turn(null);
    // a restart with Welcome on: the sweep, then the look
    values.welcome = true; shows.length = 0;
    const c2 = new Control({ settings, lights: fake, ambient: amb, log });
    c.setLook({ kind: 'solid' }); shows.length = 0;
    c2.start();
    ok(shows[0].kind === 'welcome' && shows[0].then.kind === 'solid', 'welcome sweep at start, then the look');
    c2.stop();

    // hold (the strobe talks to the body controller): no write while held, the one under way finished first, then on again
    {
        refuse = false; asleep = false; drop = null;
        const lh = new Lights({ diag, log, checkMs: 40 });
        await lh.find();
        lh.show(look('wave'));
        for (let i = 0; i < 500 && !lh._running; i++) await new Promise((r) => setImmediate(r));   // a write under way
        const busy = lh._running;
        await lh.hold('strobe', true);
        ok(busy && !lh._running && lh.held, 'hold: resolves once the write under way is done');
        writes.length = 0;
        await sleep(200);
        ok(writes.length === 0, 'held: a moving scene writes nothing (' + writes.length + ' writes)');
        lh.hold('other', true); lh.hold('strobe', false);
        await sleep(100);
        ok(writes.length === 0, 'still held by another key: nothing written');
        lh.hold('other', false);
        await sleep(100);
        ok(writes.length > 0 && !lh.held, 'let go: the scene is written again (' + writes.length + ' writes)');
        lh.stop && lh.stop();
        await sleep(50);
    }

    fs.unlinkSync(process.env.MGU_AMBIENT_FLASH); fs.rmdirSync(TMP);
    console.log('ambient rgb: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
