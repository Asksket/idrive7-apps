'use strict';
/**
 * keyboard.js - the on-screen keyboard's model: what is typed, which layout, what a key does. ui.js draws it, each
 * key a page target (touch, the iDrive controller, or the bar's Prev / Next / Select).
 *
 *   const kb = new Keyboard({ max: 100, secret: false })
 *   kb.rows() -> [[{ id, label, w }]]   (w: width in key units)
 *   kb.press(id) -> 'ok' | 'cancel' | null
 */
const LAYOUTS = {
    lower: ['1234567890', 'qwertyuiop', 'asdfghjkl\'', 'zxcvbnm,.-'],
    upper: ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL"', 'ZXCVBNM;:_'],
    symbols: ['!@#$%^&*()', '+=/\\|?~`<>', '[]{}\'"_-,.', ';:!?*&%$#@'],
};

class Keyboard {
    constructor(o) {
        o = o || {};
        this.max = o.max || 100;
        this.secret = !!o.secret;
        this.text = String(o.text || '').slice(0, this.max);
        this.layout = 'lower';
        this.show = false;                 // a secret shown in clear
        this.ascii = o.ascii !== false;    // only printable ASCII (a Wi-Fi password, a search)
    }
    rows() {
        const L = LAYOUTS[this.layout];
        const rows = L.map((r) => r.split('').filter((c) => !this.ascii || /[\x20-\x7e]/.test(c)).map((c) => ({ id: 'k:' + c, label: c, w: 1 })));
        const last = [
            { id: 'shift', label: this.layout === 'upper' ? 'abc' : 'ABC', w: 1.5 },
            { id: 'sym', label: this.layout === 'symbols' ? 'abc' : '#+=', w: 1.5 },
            { id: 'space', label: 'Space', w: 3 },
            { id: 'back', label: 'Del', w: 1.4 },
            { id: 'clear', label: 'Clear', w: 1.4 },
        ];
        if (this.secret) last.push({ id: 'showpw', label: this.show ? 'Hide' : 'Show', w: 1.2 });
        return rows.concat([last]);
    }
    /** Text as shown: a secret as dots unless shown. */
    shown() { return this.secret && !this.show ? '*'.repeat(this.text.length) : this.text; }
    press(id) {
        if (id.indexOf('k:') === 0) {
            if (this.text.length < this.max) this.text += id.slice(2);
            if (this.layout === 'upper' && !this.capsLock) this.layout = 'lower';
            return null;
        }
        switch (id) {
        case 'shift': this.layout = this.layout === 'upper' ? 'lower' : 'upper'; break;
        case 'sym': this.layout = this.layout === 'symbols' ? 'lower' : 'symbols'; break;
        case 'space': if (this.text.length < this.max) this.text += ' '; break;
        case 'back': this.text = this.text.slice(0, -1); break;
        case 'clear': this.text = ''; break;
        case 'showpw': this.show = !this.show; break;
        case 'ok': return 'ok';
        case 'cancel': return 'cancel';
        default: break;
        }
        return null;
    }
}

module.exports = { Keyboard, LAYOUTS };
