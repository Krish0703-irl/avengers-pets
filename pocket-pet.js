#!/usr/bin/env -S gjs -m
// Mochi, a pocket pet that wanders along the bottom of your screen.
// Left-click to pat, drag to pick it up, right-click for care options.
// State lives in ~/.local/share/pocket-pet/state.json.

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

// GNOME on Wayland won't let a native window stay on top or place itself,
// so run under XWayland where both work.
GLib.setenv('GDK_BACKEND', 'x11', false);

import Cairo from 'cairo';
import System from 'system';
import Gdk from 'gi://Gdk?version=3.0';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const W = 210, H = 200;   // window size; the pet stands at the bottom, speech bubble above
const SCALE = 0.6;        // pet drawing scale (artwork is in a 400x330 space)
const SPEED = 3;          // pet time runs 3x real time
const RATES = {food: 4, fun: 3, energy: 2.5, clean: 1.5}; // points lost per pet-hour
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'pocket-pet']);
const STATE_FILE = GLib.build_filenamev([DATA_DIR, 'state.json']);

const BODY = [1.0, 0.72, 0.66];
const SHADE = [0.95, 0.60, 0.53];
const CHEEK = [1.0, 0.50, 0.56, 0.45];
const INK = [0.16, 0.14, 0.13];

const clamp = v => Math.max(0, Math.min(100, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const now = () => GLib.get_monotonic_time() / 1e6;

function freshState() {
    const t = Date.now() / 1000;
    return {name: 'Mochi', food: 80, fun: 80, energy: 80, clean: 80, asleep: false, born: t, last: t};
}

function loadState() {
    try {
        const [, bytes] = GLib.file_get_contents(STATE_FILE);
        return {...freshState(), ...JSON.parse(new TextDecoder().decode(bytes))};
    } catch {
        return freshState();
    }
}

function ellipse(cr, cx, cy, rx, ry) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
}

function quadTo(cr, qx, qy, x, y) {
    const [x0, y0] = cr.getCurrentPoint();
    cr.curveTo(x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0),
        x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
}

class Pet {
    constructor(app) {
        this.s = loadState();
        this.mode = this.s.asleep ? 'sleep' : 'idle';
        this.timer = 2;
        this.dir = 1;
        this.t = 0;
        this.vy = 0;
        this.hops = 0;
        this.squish = 0;
        this.blink = 3;
        this.bubble = null;
        this.bubbleTime = 0;
        this.particles = [];
        this.press = null;
        this.dragging = false;
        this.lastTick = now();
        this.lastSave = now();
        this.lastComplaint = now();
        if (!app)
            return;

        const win = this.win = new Gtk.ApplicationWindow({application: app, title: 'Pocket Pet'});
        win.set_default_size(W, H);
        win.set_resizable(false);
        win.set_decorated(false);
        win.set_app_paintable(true);
        win.set_keep_above(true);
        win.set_skip_taskbar_hint(true);
        win.set_skip_pager_hint(true);
        win.set_accept_focus(false);
        win.set_type_hint(Gdk.WindowTypeHint.UTILITY);
        const visual = win.get_screen().get_rgba_visual();
        if (visual)
            win.set_visual(visual);
        win.stick();

        win.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK |
            Gdk.EventMask.POINTER_MOTION_MASK);
        win.connect('draw', (_w, cr) => {
            this.draw(cr);
            cr.$dispose();
            return true;
        });
        win.connect('button-press-event', (_w, ev) => this.onPress(ev));
        win.connect('button-release-event', (_w, ev) => this.onRelease(ev));
        win.connect('motion-notify-event', (_w, ev) => this.onMotion(ev));
        win.connect('delete-event', () => {
            this.save();
            return false;
        });

        const a = this.workarea();
        this.x = Math.floor(rand(a.x, a.x + a.width - W));
        this.y = this.ground();
        win.move(this.x, this.y);
        win.show_all();
        this.setInputShape();
        this.buildMenu();
        this.catchUp();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => this.tick());
        this.say(`Hi! I'm ${this.s.name}.`);
    }

    // ---- screen geometry ----
    workarea() {
        const display = Gdk.Display.get_default();
        const mon = display.get_primary_monitor() ?? display.get_monitor(0);
        return mon.get_workarea();
    }

    ground() {
        const a = this.workarea();
        return a.y + a.height - H;
    }

    setInputShape() {
        // Only the pet itself catches clicks; the empty space above it passes through.
        try {
            const region = new Cairo.Region();
            region.unionRectangle({x: W / 2 - 58, y: H - 118, width: 116, height: 116});
            this.win.input_shape_combine_region(region);
        } catch (e) {
            logError(e, 'could not limit the clickable area');
        }
    }

    // ---- needs ----
    updateNeeds(dt) {
        const hours = dt / 3600 * SPEED, s = this.s;
        s.food = clamp(s.food - RATES.food * hours);
        s.fun = clamp(s.fun - RATES.fun * hours * (s.asleep ? 0.2 : 1));
        s.clean = clamp(s.clean - RATES.clean * hours);
        s.energy = clamp(s.energy + (s.asleep ? 12 : -RATES.energy) * hours);
        s.last = Date.now() / 1000;
    }

    catchUp() {
        // Needs keep changing while the pet is put away, capped at two pet-days.
        const away = Math.min(Date.now() / 1000 - this.s.last, 48 * 3600 / SPEED);
        if (away > 0)
            this.updateNeeds(away);
    }

    mood() {
        const s = this.s;
        if (s.asleep)
            return 'sleep';
        if (this.mode === 'eat')
            return 'eat';
        const low = Math.min(s.food, s.fun, s.energy, s.clean);
        const avg = (s.food + s.fun + s.energy + s.clean) / 4;
        if (low < 20)
            return 'sad';
        if (avg > 75 && low > 50)
            return 'joy';
        return avg > 50 ? 'ok' : 'meh';
    }

    complaint() {
        const s = this.s;
        if (s.food < 25)
            return pick(['My tummy is rumbling…', 'Snack time? Please?']);
        if (s.clean < 25)
            return 'I feel a bit grubby.';
        if (s.fun < 25)
            return pick(["I'm bored. Play with me!", `${s.name} wants to play.`]);
        return null;
    }

    // ---- actions ----
    say(text, secs = 3.5) {
        this.bubble = text;
        this.bubbleTime = secs;
    }

    burst(kind, n, y = H - 70) {
        for (let i = 0; i < n; i++) {
            const life = rand(1.1, 1.6);
            this.particles.push({
                kind, life, maxLife: life,
                x: W / 2 + rand(-25, 25), y: y + rand(-15, 15),
                vx: rand(-20, 20), vy: rand(-70, -40),
            });
        }
    }

    awakeOnly() {
        if (this.s.asleep) {
            this.say("Zzz… (shh, I'm sleeping)");
            return false;
        }
        return true;
    }

    feed() {
        if (!this.awakeOnly())
            return;
        if (this.s.food > 92) {
            this.say("I'm too full!");
            return;
        }
        this.s.food = clamp(this.s.food + 25);
        this.s.clean = clamp(this.s.clean - 4);
        this.mode = 'eat';
        this.timer = 2;
        this.burst('crumb', 6, H - 35);
        this.say('Nom nom nom!');
    }

    play() {
        if (!this.awakeOnly())
            return;
        const s = this.s;
        if (s.energy < 12) {
            this.say('Too tired… nap first?');
            return;
        }
        s.fun = clamp(s.fun + 22);
        s.energy = clamp(s.energy - 10);
        s.food = clamp(s.food - 5);
        s.clean = clamp(s.clean - 6);
        this.hops = 3;
        this.startJump();
        this.burst('spark', 6);
        this.say('Wheee!');
    }

    bathe() {
        if (!this.awakeOnly())
            return;
        this.s.clean = 100;
        this.s.fun = clamp(this.s.fun - 3);
        this.mode = 'bath';
        this.timer = 2.5;
        this.say('Splish splash!');
    }

    toggleSleep() {
        if (this.s.asleep) {
            this.wake("*yawn* I'm up.");
        } else {
            this.s.asleep = true;
            this.mode = 'sleep';
            this.say('Goodnight…', 2);
        }
    }

    wake(text) {
        this.s.asleep = false;
        this.mode = 'idle';
        this.timer = 2;
        this.say(text);
    }

    pat() {
        if (!this.awakeOnly())
            return;
        this.s.fun = clamp(this.s.fun + 4);
        this.squish = 1;
        this.burst('heart', 3);
        this.say(pick(['Purr…', 'Hehe!', '♥', 'More pats please.']), 2);
    }

    startJump() {
        this.mode = 'jump';
        this.vy = -330;
    }

    // ---- input ----
    onPress(ev) {
        const [, button] = ev.get_button();
        const [, rx, ry] = ev.get_root_coords();
        if (button === 1) {
            this.press = {rx, ry, wx: this.x, wy: this.y};
            this.dragging = false;
        } else if (button === 3) {
            this.refreshMenu();
            this.menu.popup_at_pointer(ev);
        }
        return true;
    }

    onMotion(ev) {
        if (!this.press)
            return false;
        const [, rx, ry] = ev.get_root_coords();
        const dx = rx - this.press.rx, dy = ry - this.press.ry;
        if (!this.dragging && Math.abs(dx) + Math.abs(dy) > 5) {
            this.dragging = true;
            this.mode = 'drag';
            if (!this.s.asleep)
                this.say('Whoa!', 1.5);
        }
        if (this.dragging) {
            this.x = Math.round(this.press.wx + dx);
            this.y = Math.round(this.press.wy + dy);
            this.win.move(this.x, this.y);
        }
        return true;
    }

    onRelease(ev) {
        const [, button] = ev.get_button();
        if (button !== 1 || !this.press)
            return false;
        if (this.dragging) {
            this.mode = 'fall';
            this.vy = 0;
        } else {
            this.pat();
        }
        this.press = null;
        this.dragging = false;
        return true;
    }

    // ---- menu ----
    buildMenu() {
        const m = this.menu = new Gtk.Menu();
        const add = (label, fn) => {
            const item = new Gtk.MenuItem({label});
            item.connect('activate', () => fn());
            m.append(item);
            return item;
        };
        this.statusItem = add('', () => {});
        this.statusItem.set_sensitive(false);
        m.append(new Gtk.SeparatorMenuItem());
        add('Feed', () => this.feed());
        add('Play', () => this.play());
        add('Bathe', () => this.bathe());
        this.sleepItem = add('Sleep', () => this.toggleSleep());
        m.append(new Gtk.SeparatorMenuItem());
        add('Rename…', () => this.rename());
        add('Put away until later', () => this.quit());
        m.show_all();
    }

    refreshMenu() {
        const s = this.s, n = v => Math.round(v);
        this.statusItem.set_label(
            `${s.name}  ·  Food ${n(s.food)}  Fun ${n(s.fun)}  Energy ${n(s.energy)}  Clean ${n(s.clean)}`);
        this.sleepItem.set_label(s.asleep ? 'Wake up' : 'Sleep');
    }

    rename() {
        const dlg = new Gtk.Dialog({title: 'Rename your pet', modal: true});
        dlg.set_keep_above(true);
        dlg.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dlg.add_button('Rename', Gtk.ResponseType.OK);
        dlg.set_default_response(Gtk.ResponseType.OK);
        const entry = new Gtk.Entry({text: this.s.name, max_length: 12, activates_default: true});
        const box = dlg.get_content_area();
        box.set_border_width(12);
        box.add(entry);
        dlg.connect('response', (_d, resp) => {
            const name = entry.get_text().trim();
            if (resp === Gtk.ResponseType.OK && name) {
                this.s.name = name;
                this.say(`I'm ${name} now!`);
                this.save();
            }
            dlg.destroy();
        });
        dlg.show_all();
    }

    // ---- loop ----
    tick() {
        const t = now();
        const dt = Math.min(t - this.lastTick, 0.1);
        this.lastTick = t;
        this.step(dt);
        if (!this.dragging)
            this.win.move(Math.round(this.x), Math.round(this.y));
        this.win.queue_draw();
        if (t - this.lastSave > 30) {
            this.save();
            this.lastSave = t;
        }
        return GLib.SOURCE_CONTINUE;
    }

    step(dt) {
        const s = this.s;
        this.t += dt;
        this.updateNeeds(dt);
        this.squish = Math.max(0, this.squish - dt * 3);
        this.blink -= dt;
        if (this.blink < -0.12)
            this.blink = rand(2.5, 6);
        if (this.bubble) {
            this.bubbleTime -= dt;
            if (this.bubbleTime <= 0)
                this.bubble = null;
        }
        for (const p of this.particles) {
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
        this.particles = this.particles.filter(p => p.life > 0);

        if (this.mode === 'drag')
            return;
        const a = this.workarea(), ground = this.ground();

        if (this.mode === 'fall' || this.mode === 'jump') {
            this.vy += 1100 * dt;
            this.y += this.vy * dt;
            if (this.y >= ground) {
                this.y = ground;
                this.squish = 1;
                if (this.mode === 'jump' && this.hops > 1) {
                    this.hops--;
                    this.startJump();
                } else {
                    this.mode = s.asleep ? 'sleep' : 'idle';
                    this.timer = 1.5;
                }
            }
            return;
        }
        this.y = ground;

        if (s.asleep) {
            this.mode = 'sleep';
            if (s.energy >= 100)
                this.wake('Good morning!');
            return;
        }
        if (s.energy < 15 && (this.mode === 'idle' || this.mode === 'walk')) {
            this.say('So sleepy…', 2);
            s.asleep = true;
            this.mode = 'sleep';
            return;
        }

        this.timer -= dt;
        if (this.mode === 'bath' && Math.random() < dt * 12)
            this.burst('bubble', 1);
        if (this.mode === 'walk') {
            const pace = ['sad', 'meh'].includes(this.mood()) ? 25 : 45;
            this.x += this.dir * pace * dt;
            if (this.x < a.x || this.x > a.x + a.width - W) {
                this.dir *= -1;
                this.x = Math.max(a.x, Math.min(this.x, a.x + a.width - W));
            }
        }
        if (this.timer <= 0) {
            if (Math.random() < 0.55) {
                this.mode = 'walk';
                this.dir = pick([-1, 1]);
                this.timer = rand(2, 7);
            } else {
                this.mode = 'idle';
                this.timer = rand(2, 6);
                if (Math.random() < 0.2)
                    this.dir *= -1;
            }
        }
        if (now() - this.lastComplaint > 45) {
            this.lastComplaint = now();
            const msg = this.complaint();
            if (msg)
                this.say(msg, 4);
        }
    }

    // ---- drawing ----
    draw(cr) {
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const mood = this.mood();
        const walking = this.mode === 'walk';
        let bob;
        if (walking)
            bob = -Math.abs(Math.sin(this.t * 8)) * 6;
        else if (mood === 'sleep')
            bob = 0;
        else
            bob = Math.sin(this.t * 2.4) * 3;
        const breathe = mood === 'sleep' ? 1 + Math.sin(this.t * 1.6) * 0.03 : 1;
        const sq = Math.sin(this.squish * Math.PI) * 0.14;
        let sx = 1 + sq, sy = (1 - sq) * breathe;
        if (this.mode === 'fall' || this.mode === 'drag')
            [sx, sy] = [0.94, 1.08];

        cr.save();
        cr.translate(W / 2, H - 4 + bob);
        cr.scale(SCALE * sx, SCALE * sy);
        cr.translate(-200, -273);
        this.drawBody(cr, mood, walking);
        cr.restore();

        if (mood === 'sleep')
            this.drawZzz(cr);
        for (const p of this.particles)
            this.drawParticle(cr, p);
        if (this.bubble)
            this.drawBubble(cr, this.bubble);
    }

    drawBody(cr, mood, walking) {
        const face = walking || this.mode === 'idle' ? this.dir * 6 : 0;
        const held = this.mode === 'fall' || this.mode === 'drag';
        // ears
        cr.setSourceRGB(...SHADE);
        for (const [x0, qx, x1] of [[150, 138, 172], [250, 262, 228]]) {
            cr.moveTo(x0, 150);
            quadTo(cr, qx, 100, x1, 122);
            cr.closePath();
            cr.fill();
        }
        // feet, stepping when walking
        const step = walking ? Math.sin(this.t * 8) * 5 : 0;
        ellipse(cr, 170, 266 - Math.max(step, 0), 16, 7);
        cr.fill();
        ellipse(cr, 230, 266 - Math.max(-step, 0), 16, 7);
        cr.fill();
        // body
        cr.setSourceRGB(...BODY);
        cr.moveTo(200, 115);
        cr.curveTo(265, 115, 285, 175, 280, 215);
        cr.curveTo(276, 252, 245, 268, 200, 268);
        cr.curveTo(155, 268, 124, 252, 120, 215);
        cr.curveTo(115, 175, 135, 115, 200, 115);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.35);
        ellipse(cr, 200, 225, 48, 32);
        cr.fill();
        // smudges when dirty
        if (this.s.clean < 35) {
            cr.setSourceRGBA(0.45, 0.35, 0.25, 0.35);
            for (const [cx, cy, r] of [[150, 235, 7], [245, 245, 5], [232, 150, 6], [168, 140, 4]]) {
                ellipse(cr, cx, cy, r, r);
                cr.fill();
            }
        }
        cr.setSourceRGBA(...CHEEK);
        ellipse(cr, 152 + face / 2, 200, 13, 8);
        cr.fill();
        ellipse(cr, 248 + face / 2, 200, 13, 8);
        cr.fill();
        // eyes
        cr.setSourceRGB(...INK);
        cr.setLineWidth(4);
        cr.setLineCap(Cairo.LineCap.ROUND);
        if (mood === 'sleep') {
            for (const ex of [172, 228]) {
                cr.moveTo(ex - 10, 180);
                quadTo(cr, ex, 188, ex + 10, 180);
                cr.stroke();
            }
        } else {
            let open = this.blink < 0 ? 0.12 : 1;
            if (held)
                open = 1.25;
            for (const ex of [172, 228]) {
                ellipse(cr, ex + face, 178, 9, 12 * open);
                cr.fill();
                if (open > 0.5) {
                    cr.setSourceRGB(1, 1, 1);
                    ellipse(cr, ex + face + 3, 173, 3.2, 3.2);
                    cr.fill();
                    cr.setSourceRGB(...INK);
                }
            }
        }
        // mouth
        const mx = face / 2;
        if (held) {
            ellipse(cr, 200 + mx, 210, 6, 8);
            cr.fill();
        } else if (mood === 'eat') {
            ellipse(cr, 200 + mx, 210, 9, 4 + Math.abs(Math.sin(this.t * 14)) * 7);
            cr.fill();
        } else if (mood === 'joy') {
            cr.moveTo(184 + mx, 202);
            quadTo(cr, 200 + mx, 226, 216 + mx, 202);
            cr.closePath();
            cr.setSourceRGB(0.48, 0.18, 0.18);
            cr.fillPreserve();
            cr.setSourceRGB(...INK);
            cr.stroke();
        } else if (mood === 'ok') {
            cr.moveTo(188 + mx, 205);
            quadTo(cr, 200 + mx, 218, 212 + mx, 205);
            cr.stroke();
        } else if (mood === 'meh') {
            cr.moveTo(189 + mx, 210);
            cr.lineTo(211 + mx, 210);
            cr.stroke();
        } else if (mood === 'sad') {
            cr.moveTo(188 + mx, 214);
            quadTo(cr, 200 + mx, 202, 212 + mx, 214);
            cr.stroke();
        } else { // sleep
            cr.moveTo(195, 210);
            quadTo(cr, 200, 214, 205, 210);
            cr.stroke();
        }
    }

    layout(cr, text, size, width) {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string(`Ubuntu, Cantarell, Sans Bold ${size}`));
        if (width) {
            layout.set_width(width * Pango.SCALE);
            layout.set_wrap(Pango.WrapMode.WORD_CHAR);
            layout.set_alignment(Pango.Alignment.CENTER);
        }
        layout.set_text(text, -1);
        return layout;
    }

    drawZzz(cr) {
        [10, 13, 16].forEach((size, i) => {
            const phase = (this.t / 3 + i / 3) % 1;
            cr.moveTo(W / 2 + 40 + phase * 16, H - 80 - i * 4 - phase * 40);
            cr.setSourceRGBA(0.35, 0.42, 0.75, Math.sin(phase * Math.PI));
            PangoCairo.show_layout(cr, this.layout(cr, i === 2 ? 'Z' : 'z', size));
        });
    }

    drawParticle(cr, p) {
        const a = Math.max(0, Math.min(1, p.life / p.maxLife * 1.5));
        cr.newPath();
        if (p.kind === 'heart') {
            cr.setSourceRGBA(1, 0.42, 0.54, a);
            cr.arc(p.x - 2.5, p.y, 3, Math.PI, 0);
            cr.arc(p.x + 2.5, p.y, 3, Math.PI, 0);
            cr.lineTo(p.x, p.y + 7);
            cr.closePath();
            cr.fill();
        } else if (p.kind === 'bubble') {
            cr.setSourceRGBA(0.55, 0.78, 1, a * 0.9);
            cr.setLineWidth(1.5);
            cr.arc(p.x, p.y, 5, 0, 2 * Math.PI);
            cr.stroke();
            cr.setSourceRGBA(1, 1, 1, a * 0.8);
            cr.arc(p.x - 1.5, p.y - 1.5, 1.3, 0, 2 * Math.PI);
            cr.fill();
        } else if (p.kind === 'crumb') {
            cr.setSourceRGBA(0.98, 0.97, 0.92, a);
            cr.arc(p.x, p.y, 2.5, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(0.2, 0.3, 0.2, a);
            cr.rectangle(p.x - 1, p.y + 1, 2, 1.5);
            cr.fill();
        } else { // spark
            cr.setSourceRGBA(1, 0.8, 0.2, a);
            for (let k = 0; k < 4; k++) {
                const th = k * Math.PI / 2 + this.t * 3;
                cr.moveTo(p.x, p.y);
                cr.lineTo(p.x + Math.cos(th) * 5, p.y + Math.sin(th) * 5);
            }
            cr.setLineWidth(2);
            cr.stroke();
        }
    }

    drawBubble(cr, msg) {
        const layout = this.layout(cr, msg, 9.5, W - 36);
        const [, logical] = layout.get_pixel_extents();
        const bw = logical.width + 20, bh = logical.height + 12;
        const bx = (W - bw) / 2, by = Math.max(2, H - 114 - bh), r = 10;
        cr.newPath();
        cr.arc(bx + bw - r, by + r, r, -Math.PI / 2, 0);
        cr.arc(bx + bw - r, by + bh - r, r, 0, Math.PI / 2);
        cr.lineTo(W / 2 + 7, by + bh);
        cr.lineTo(W / 2, by + bh + 8);
        cr.lineTo(W / 2 - 7, by + bh);
        cr.arc(bx + r, by + bh - r, r, Math.PI / 2, Math.PI);
        cr.arc(bx + r, by + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.setSourceRGBA(1, 1, 1, 0.96);
        cr.fillPreserve();
        cr.setSourceRGBA(0.14, 0.19, 0.16, 0.25);
        cr.setLineWidth(1);
        cr.stroke();
        cr.setSourceRGB(0.14, 0.19, 0.16);
        cr.moveTo(bx + 10 - logical.x, by + 6);
        PangoCairo.show_layout(cr, layout);
    }

    // ---- lifecycle ----
    save() {
        try {
            GLib.mkdir_with_parents(DATA_DIR, 0o755);
            GLib.file_set_contents(STATE_FILE, JSON.stringify(this.s));
        } catch (e) {
            logError(e, 'pocket-pet: could not save');
        }
    }

    quit() {
        this.save();
        this.win.get_application().quit();
    }
}

// Render a few poses to a PNG, for checking the artwork without a display.
function snapshot(path) {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, W * 4, H);
    const cr = new Cairo.Context(surf);
    cr.setSourceRGB(0.86, 0.94, 1);
    cr.paint();
    const poses = [['idle', {}, "Hi! I'm Mochi."], ['walk', {}, null],
        ['sleep', {asleep: true}, null], ['eat', {food: 15}, 'Nom nom nom!']];
    poses.forEach(([mode, extra, msg], i) => {
        const pet = new Pet(null);
        Object.assign(pet.s, {food: 90, fun: 90, energy: 90, clean: 90, asleep: false}, extra);
        pet.mode = mode;
        pet.t = 0.3;
        if (msg)
            pet.say(msg);
        if (mode === 'eat')
            pet.burst('crumb', 5, H - 35);
        cr.save();
        cr.translate(i * W, 0);
        cr.rectangle(0, 0, W, H);
        cr.clip();
        cr.pushGroup();
        pet.draw(cr);
        cr.popGroupToSource();
        cr.paint();
        cr.restore();
    });
    surf.writeToPNG(path);
}

if (ARGV[0] === '--snapshot') {
    snapshot(ARGV[1]);
} else {
    // Gtk.Application keeps it to one pet: launching again just wakes the one already out.
    const app = new Gtk.Application({application_id: 'dev.pocketpet.Mochi'});
    let pet = null;
    app.connect('activate', () => {
        if (pet)
            pet.say("I'm right here!");
        else
            pet = new Pet(app);
    });
    app.connect('shutdown', () => pet?.save());
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
        pet?.quit();
        return GLib.SOURCE_REMOVE;
    });
    app.run([System.programInvocationName]);
}
