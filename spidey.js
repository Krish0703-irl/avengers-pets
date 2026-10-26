#!/usr/bin/env -S gjs -m
// Spidey, a little web-slinger who lives on your screen. He crawls along the
// bottom, climbs the screen edges, swings on webs and hangs from the top.
// Left-click for a flip, drag to toss him, right-click for options.

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

const S = 1.6;            // drawing scale: the hero is about 75px tall
const G = 1500;           // gravity, px/s²
const STAND_H = 16.5 * S; // hip height above the floor when standing
const LEG = 16;           // leg length in drawing units

const RED = [0.86, 0.1, 0.14];
const RED_DK = [0.62, 0.06, 0.1];
const BLUE = [0.13, 0.27, 0.72];
const BLUE_DK = [0.08, 0.17, 0.48];
const LINE = [0.1, 0.04, 0.06];

const QUIPS = [
    'Thwip!', 'Just your friendly neighborhood desktop hero.', 'My spider-sense is tingling…',
    'Nice wallpaper!', 'Anyone need a web?', 'Hanging around, as usual.', 'Swinging by!',
];
const PAT_QUIPS = ['Thwip!', 'Hey there!', 'Woo-hoo!', 'Spider-flip!', 'That tickles!'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const now = () => GLib.get_monotonic_time() / 1e6;
const clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Limb angles are [upper, bend]: 0 points down, +π/2 points the way he faces.
function getPose(state, t) {
    const sw = Math.sin(t * 9);
    switch (state) {
    case 'crawl':
        return {na: [1.0 + 0.5 * sw, -0.4], fa: [1.0 - 0.5 * sw, -0.4],
            nl: [1.2 + 0.4 * sw, -1.7], fl: [1.2 - 0.4 * sw, -1.7]};
    case 'land':
        return {na: [0.7, -0.3], fa: [-0.7, 0.6], nl: [1.5, -1.9], fl: [0.5, -2.3]};
    case 'climb': {
        const c = Math.sin(t * 7);
        return {na: [2.5 + 0.35 * c, 0.3], fa: [2.2 - 0.35 * c, 0.4],
            nl: [1.5 + 0.3 * c, -1.4], fl: [1.2 - 0.3 * c, -1.2]};
    }
    case 'swing':
        return {na: [Math.PI, 0], fa: [1.1, 0.9], nl: [0.7, -1.3], fl: [0.25, -0.8]};
    case 'fly':
        return {na: [2.3, 0.2], fa: [-1.2, 0.6], nl: [0.5, -1.3], fl: [-0.3, -0.6]};
    case 'hang': {
        const d = Math.sin(t * 2) * 0.12;
        return {na: [2.9 + d, 0.3], fa: [3.4 - d, -0.3], nl: [0.06, 0], fl: [-0.06, 0]};
    }
    case 'drag': {
        const f = Math.sin(t * 14);
        return {na: [2.6 + 0.5 * f, 0.3], fa: [2.4 - 0.5 * f, 0.3],
            nl: [0.4 + 0.4 * f, -0.4], fl: [-0.3 - 0.4 * f, -0.4]};
    }
    default: // idle
        return {na: [0.3 + 0.06 * Math.sin(t * 2), 0.45], fa: [-0.3, 0.3], nl: [0.12, 0], fl: [-0.12, 0]};
    }
}

function limbEnd(ox, oy, [a, bend], l1, l2) {
    const x1 = ox + l1 * Math.sin(a), y1 = oy + l1 * Math.cos(a);
    return [x1, y1, x1 + l2 * Math.sin(a + bend), y1 + l2 * Math.cos(a + bend)];
}

// Where a point on the hero (in drawing units) lands on screen.
function toWorld(hx, hy, rot, dir, lx, ly) {
    const x = lx * dir * S, y = ly * S;
    return [hx + x * Math.cos(rot) - y * Math.sin(rot), hy + x * Math.sin(rot) + y * Math.cos(rot)];
}

function handPos(hx, hy, rot, dir, pose) {
    const [, , x, y] = limbEnd(0, -11, pose.na, 7, 7);
    return toWorld(hx, hy, rot, dir, x, y);
}

function feetPos(hx, hy, rot, dir, pose) {
    const [, , x1, y1] = limbEnd(0, 0, pose.nl, 8, 8);
    const [, , x2, y2] = limbEnd(0, 0, pose.fl, 8, 8);
    return toWorld(hx, hy, rot, dir, (x1 + x2) / 2, (y1 + y2) / 2);
}

function drawLimb(cr, ox, oy, angles, w, upper, lower, tip) {
    const [x1, y1, x2, y2] = limbEnd(ox, oy, angles, 7 + (w > 4.5 ? 1 : 0), 7 + (w > 4.5 ? 1 : 0));
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setSourceRGB(...LINE);
    cr.setLineWidth(w + 1.4);
    cr.moveTo(ox, oy);
    cr.lineTo(x1, y1);
    cr.lineTo(x2, y2);
    cr.stroke();
    cr.setLineWidth(w);
    cr.setSourceRGB(...upper);
    cr.moveTo(ox, oy);
    cr.lineTo(x1, y1);
    cr.stroke();
    cr.setSourceRGB(...lower);
    cr.moveTo(x1, y1);
    cr.lineTo(x2, y2);
    cr.stroke();
    // gloves and boots
    cr.setSourceRGB(...tip);
    const mx = x1 + (x2 - x1) * 0.5, my = y1 + (y2 - y1) * 0.5;
    cr.moveTo(mx, my);
    cr.lineTo(x2, y2);
    cr.stroke();
}

function drawHero(cr, hx, hy, rot, dir, pose, blink = false) {
    cr.save();
    cr.translate(hx, hy);
    cr.rotate(rot);
    cr.scale(S * dir, S);

    // far side, in shadow
    drawLimb(cr, 0, -11, pose.fa, 4, RED_DK, RED_DK, RED_DK);
    drawLimb(cr, -0.8, 0, pose.fl, 5, BLUE_DK, BLUE_DK, RED_DK);

    // torso: blue suit with a red chest and belt
    cr.setLineWidth(0.9);
    cr.moveTo(-5.2, -13.5);
    cr.lineTo(5.2, -13.5);
    cr.lineTo(4.2, 0.5);
    cr.lineTo(-4.2, 0.5);
    cr.closePath();
    cr.setSourceRGB(...BLUE);
    cr.fillPreserve();
    cr.setSourceRGB(...LINE);
    cr.stroke();
    cr.moveTo(-4.9, -13.2);
    cr.lineTo(4.9, -13.2);
    cr.lineTo(3.2, -4);
    cr.lineTo(0, -2.2);
    cr.lineTo(-3.2, -4);
    cr.closePath();
    cr.setSourceRGB(...RED);
    cr.fill();
    cr.rectangle(-4.25, -1.6, 8.5, 1.8);
    cr.fill();
    // chest emblem
    cr.setSourceRGB(...LINE);
    cr.setLineWidth(0.5);
    cr.arc(0, -9, 0.9, 0, 2 * Math.PI);
    cr.fill();
    for (const s of [-1, 1]) {
        cr.moveTo(0, -9);
        cr.lineTo(2.2 * s, -10.8);
        cr.moveTo(0, -9);
        cr.lineTo(2.2 * s, -7.2);
        cr.moveTo(0, -9);
        cr.lineTo(2.6 * s, -9.4);
    }
    cr.stroke();

    // head with web pattern
    cr.save();
    cr.translate(0, -21.5);
    cr.save();
    cr.scale(9, 9.5);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGB(...RED);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    cr.setSourceRGBA(...LINE, 0.55);
    cr.setLineWidth(0.35);
    for (let k = 0; k < 10; k++) {
        const a = k * Math.PI / 5;
        cr.moveTo(0, 1.5);
        cr.lineTo(Math.cos(a) * 12, 1.5 + Math.sin(a) * 12);
    }
    cr.stroke();
    for (const r of [3.5, 6.5]) {
        cr.arc(0, 1.5, r, 0, 2 * Math.PI);
        cr.stroke();
    }
    cr.restore();
    cr.newPath();
    cr.save();
    cr.scale(9, 9.5);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGB(...LINE);
    cr.setLineWidth(0.9);
    cr.stroke();
    // eyes: big white lenses tilted outward
    for (const s of [-1, 1]) {
        cr.save();
        cr.translate(1 + s * 3.6, -0.8);
        cr.rotate(s * 0.55);
        cr.scale(3.1, blink ? 0.5 : 2.2);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.setSourceRGB(1, 1, 1);
        cr.fillPreserve();
        cr.setSourceRGB(...LINE);
        cr.setLineWidth(1);
        cr.stroke();
    }
    cr.restore();

    // near side
    drawLimb(cr, 0.8, 0, pose.nl, 5, BLUE, BLUE, RED);
    drawLimb(cr, 0, -11, pose.na, 4, RED, RED, RED);
    cr.restore();
}

function drawWeb(cr, x1, y1, x2, y2, alpha = 1) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(0.25, 0.27, 0.32, 0.55 * alpha);
    cr.setLineWidth(3);
    cr.moveTo(x1, y1);
    cr.lineTo(x2, y2);
    cr.stroke();
    cr.setSourceRGBA(1, 1, 1, 0.95 * alpha);
    cr.setLineWidth(1.5);
    cr.moveTo(x1, y1);
    cr.lineTo(x2, y2);
    cr.stroke();
}

function drawSplat(cr, x, y) {
    cr.setSourceRGBA(1, 1, 1, 0.9);
    cr.setLineWidth(1.2);
    for (let k = 0; k < 7; k++) {
        const a = k * Math.PI * 2 / 7;
        cr.moveTo(x, y);
        cr.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
    }
    cr.stroke();
    cr.arc(x, y, 3.5, 0, 2 * Math.PI);
    cr.stroke();
}

class Spidey {
    constructor(app) {
        this.state = 'hang';
        this.dir = 1;
        this.t = 0;
        this.rot = Math.PI;
        this.vx = 0;
        this.vy = 0;
        this.timer = 0;
        this.chain = 0;
        this.spin = 0;
        this.shot = null;      // a web on its way to an anchor point
        this.anchor = null;
        this.fading = [];
        this.bubble = null;
        this.bubbleTime = 0;
        this.blink = 3;
        this.paused = false;
        this.press = null;
        this.dragging = false;
        this.lastQuip = now();
        this.lastBox = null;
        this.lastShape = null;
        this.lastTick = now();
        if (!app)
            return;

        const a = this.area = this.workarea();
        this.W = a.width;
        this.H = a.height - 1; // one pixel short so GNOME doesn't treat it as a fullscreen window
        const win = this.win = new Gtk.ApplicationWindow({application: app, title: 'Spidey'});
        win.set_default_size(this.W, this.H);
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
        // Enter by dropping down from the top of the screen on a web.
        this.x = rand(this.W * 0.2, this.W * 0.8);
        this.y = 0;
        this.startHang(0);
        win.move(a.x, a.y);
        win.show_all();
        this.buildMenu();
        this.updateShape();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => this.tick());
        this.say('Hey! Your friendly neighborhood desktop hero.', 4);
    }

    workarea() {
        const display = Gdk.Display.get_default();
        const mon = display.get_primary_monitor() ?? display.get_monitor(0);
        return mon.get_workarea();
    }

    get floor() {
        return this.H;
    }

    pose() {
        return getPose(this.state === 'idle' && this.paused ? 'idle' : this.state, this.t);
    }

    say(text, secs = 3) {
        this.bubble = text;
        this.bubbleTime = secs;
    }

    // ---- moves ----
    decide() {
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
            return;
        }
        const r = Math.random();
        if (r < 0.3) {
            this.state = 'crawl';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 6);
        } else if (r < 0.65) {
            this.jump(Math.floor(rand(1, 4)));
        } else if (r < 0.8) {
            this.startHang();
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 4);
            if (Math.random() < 0.3)
                this.dir *= -1;
        }
    }

    jump(chain, vy = rand(700, 880)) {
        if (this.x < 80)
            this.dir = 1;
        else if (this.x > this.W - 80)
            this.dir = -1;
        this.state = 'fly';
        this.vx = this.dir * rand(140, 240);
        this.vy = -vy;
        this.chain = chain;
    }

    shootWeb() {
        const ay = rand(4, 50);
        const dy = this.y - ay;
        const maxL = this.floor - 30 * S - ay;
        if (dy <= 0 || dy >= maxL)
            return false;
        const room = Math.sqrt(maxL * maxL - dy * dy);
        let h = Math.min(rand(140, 340), room);
        const ax = clampv(this.x + this.dir * h, 20, this.W - 20);
        h = Math.abs(ax - this.x);
        if (h < 50)
            return false;
        this.shot = {x: ax, y: ay, p: 0};
        return true;
    }

    attach() {
        const {x: ax, y: ay} = this.shot;
        this.shot = null;
        this.anchor = {x: ax, y: ay};
        this.L = Math.hypot(this.x - ax, this.y - ay);
        this.theta = Math.atan2(this.x - ax, this.y - ay);
        this.omega = (this.vx * Math.cos(this.theta) - this.vy * Math.sin(this.theta)) / this.L;
        this.state = 'swing';
        this.timer = 0;
    }

    release() {
        const [hx, hy] = handPos(this.x, this.y, this.rot, this.dir, this.pose());
        this.fading.push({x1: this.anchor.x, y1: this.anchor.y, x2: hx, y2: hy, life: 0.6});
        this.vx = this.L * this.omega * Math.cos(this.theta);
        this.vy = -this.L * this.omega * Math.sin(this.theta) - 150;
        this.anchor = null;
        this.state = 'fly';
        this.chain--;
        if (this.chain <= 0 && Math.random() < 0.5)
            this.spin = 2 * Math.PI;
    }

    startHang(L) {
        this.anchor = {x: this.x, y: 0};
        this.L = L ?? Math.max(0, this.y);
        this.Lt = rand(110, this.floor * 0.5);
        this.theta = 0;
        this.state = 'hang';
        this.timer = rand(5, 11);
        this.shot = null;
    }

    startClimb(side) {
        this.dir = side;
        this.state = 'climb';
        this.vx = this.vy = 0;
        this.y = Math.min(this.y, this.floor - STAND_H);
        this.climbTo = Math.min(rand(this.floor * 0.3, this.floor * 0.7), this.y - 40);
    }

    // ---- input ----
    onPress(ev) {
        const [, button] = ev.get_button();
        const [, ex, ey] = ev.get_coords();
        if (button === 1) {
            this.press = {ex, ey, ox: this.x - ex, oy: this.y - ey, moves: []};
            this.dragging = false;
        } else if (button === 3) {
            this.pauseItem.set_label(this.paused ? 'Keep moving' : 'Stay put');
            this.menu.popup_at_pointer(ev);
        }
        return true;
    }

    onMotion(ev) {
        if (!this.press)
            return false;
        const [, ex, ey] = ev.get_coords();
        if (!this.dragging && Math.abs(ex - this.press.ex) + Math.abs(ey - this.press.ey) > 5) {
            this.dragging = true;
            this.state = 'drag';
            this.anchor = this.shot = null;
            this.say('Whoa, easy!', 1.5);
        }
        if (this.dragging) {
            this.x = ex + this.press.ox;
            this.y = ey + this.press.oy;
            this.press.moves.push([now(), this.x, this.y]);
            if (this.press.moves.length > 5)
                this.press.moves.shift();
        }
        return true;
    }

    onRelease(ev) {
        const [, button] = ev.get_button();
        if (button !== 1 || !this.press)
            return false;
        if (this.dragging) {
            const m = this.press.moves;
            let vx = 0, vy = 0;
            if (m.length > 1) {
                const [t0, x0, y0] = m[0], [t1, x1, y1] = m[m.length - 1];
                const dt = Math.max(t1 - t0, 0.01);
                vx = (x1 - x0) / dt;
                vy = (y1 - y0) / dt;
            }
            this.vx = clampv(vx, -900, 900);
            this.vy = clampv(vy, -900, 900);
            if (Math.abs(this.vx) > 30)
                this.dir = Math.sign(this.vx);
            this.state = 'fly';
            this.chain = 1;
        } else {
            this.flip();
        }
        this.press = null;
        this.dragging = false;
        return true;
    }

    flip() {
        this.say(pick(PAT_QUIPS), 1.8);
        if (['idle', 'crawl', 'land'].includes(this.state)) {
            this.state = 'fly';
            this.vx = 0;
            this.vy = -480;
            this.chain = 0;
            this.spin = 2 * Math.PI;
        }
    }

    buildMenu() {
        const m = this.menu = new Gtk.Menu();
        const add = (label, fn) => {
            const item = new Gtk.MenuItem({label});
            item.connect('activate', () => fn());
            m.append(item);
            return item;
        };
        add('Swing around', () => {
            this.paused = false;
            if (this.state === 'fly' || this.state === 'swing')
                this.chain = 3;
            else
                this.jump(3);
        });
        add('Hang from the top', () => this.startHang());
        add('Climb a wall', () => {
            this.paused = false;
            this.anchor = this.shot = null;
            this.dir = this.x < this.W / 2 ? -1 : 1;
            this.state = this.y >= this.floor - STAND_H - 2 ? 'crawl' : 'fly';
            this.timer = 99;
        });
        this.pauseItem = add('Stay put', () => {
            this.paused = !this.paused;
            this.say(this.paused ? "OK, I'll stay here." : "Let's go!", 2);
        });
        m.append(new Gtk.SeparatorMenuItem());
        add('Put away until later', () => this.win.get_application().quit());
        m.show_all();
    }

    // ---- loop ----
    tick() {
        const t = now();
        const dt = Math.min(t - this.lastTick, 0.05);
        this.lastTick = t;
        this.step(dt);
        this.updateShape();
        this.invalidate();
        return GLib.SOURCE_CONTINUE;
    }

    step(dt) {
        this.t += dt;
        this.blink -= dt;
        if (this.blink < -0.12)
            this.blink = rand(2.5, 6);
        if (this.bubble) {
            this.bubbleTime -= dt;
            if (this.bubbleTime <= 0)
                this.bubble = null;
        }
        for (const f of this.fading)
            f.life -= dt;
        this.fading = this.fading.filter(f => f.life > 0);
        if (!this.paused && now() - this.lastQuip > rand(40, 70)) {
            this.lastQuip = now();
            if (!this.bubble)
                this.say(pick(QUIPS), 3.5);
        }

        const W = this.W, floor = this.floor, side = 11 * S;
        let target = 0;
        switch (this.state) {
        case 'idle':
            this.y = floor - STAND_H;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;

        case 'crawl':
            this.y = floor - 9 * S;
            this.x += this.dir * 95 * dt;
            target = 0.6 * this.dir;
            if (this.x < side + 4 || this.x > W - side - 4) {
                this.x = clampv(this.x, side, W - side);
                this.startClimb(this.x < W / 2 ? -1 : 1);
                break;
            }
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;

        case 'land':
            this.y = floor - 9 * S;
            target = 0.3 * this.dir;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;

        case 'climb':
            this.x = this.dir < 0 ? side : W - side;
            this.y -= 150 * dt;
            if (this.y <= this.climbTo) {
                this.dir = -this.dir;
                this.jump(Math.floor(rand(1, 4)), 250);
                this.vx = this.dir * 260;
            }
            break;

        case 'fly':
            this.vy += G * dt;
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            target = clampv(this.vx * 0.0012, -0.5, 0.5);
            if (this.shot) {
                this.shot.p += dt / 0.12;
                if (this.shot.p >= 1)
                    this.attach();
            } else if (this.chain > 0 && this.vy > -80 && this.y < floor - 150) {
                if (!this.shootWeb())
                    this.chain = 0;
            }
            if (this.state !== 'fly')
                break;
            if (this.y < 20) {
                this.y = 20;
                this.vy = Math.abs(this.vy) * 0.2;
            }
            if (this.x < side || this.x > W - side) {
                this.x = clampv(this.x, side, W - side);
                this.shot = null;
                this.spin = 0;
                this.startClimb(this.x < W / 2 ? -1 : 1);
                break;
            }
            if (this.y >= floor - 9 * S && this.vy > 0) {
                this.y = floor - 9 * S;
                this.vx = this.vy = 0;
                this.spin = 0;
                this.shot = null;
                this.state = 'land';
                this.timer = 0.45;
            }
            break;

        case 'swing': {
            const pump = this.dir * 2.0;
            this.omega += (-(G / this.L) * Math.sin(this.theta) + pump) * dt;
            this.theta += this.omega * dt;
            this.x = this.anchor.x + this.L * Math.sin(this.theta);
            this.y = this.anchor.y + this.L * Math.cos(this.theta);
            target = -this.theta;
            this.timer += dt;
            if (this.x < side || this.x > W - side) {
                this.release();
                this.x = clampv(this.x, side, W - side);
                this.startClimb(this.x < W / 2 ? -1 : 1);
            } else if ((this.dir * this.omega > 0 && this.dir * this.theta > 0.55) || this.timer > 3.5 ||
                this.y > floor - STAND_H) {
                this.release();
            }
            break;
        }

        case 'hang': {
            const reel = this.Lt - this.L;
            this.L += Math.sign(reel) * Math.min(Math.abs(reel), (reel < 0 ? 300 : 120) * dt);
            this.theta = Math.sin(this.t * 1.4) * 0.06;
            this.x = this.anchor.x + (this.L + LEG * S) * Math.sin(this.theta);
            this.y = this.anchor.y + (this.L + LEG * S) * Math.cos(this.theta);
            target = Math.PI - this.theta;
            if (Math.abs(reel) < 2) {
                this.timer -= dt;
                if (!this.paused && this.timer <= 0) {
                    if (Math.random() < 0.5) {
                        // let go and flip down
                        const [fx, fy] = feetPos(this.x, this.y, this.rot, this.dir, this.pose());
                        this.fading.push({x1: this.anchor.x, y1: this.anchor.y, x2: fx, y2: fy, life: 0.5});
                        this.anchor = null;
                        this.state = 'fly';
                        this.vx = this.dir * 60;
                        this.vy = 0;
                        this.chain = 0;
                    } else {
                        // swing out from the hanging web
                        this.dir = this.x < W / 2 ? 1 : -1;
                        this.L = Math.hypot(this.x - this.anchor.x, this.y - this.anchor.y);
                        this.omega = this.dir * 2.2;
                        this.state = 'swing';
                        this.chain = Math.floor(rand(1, 4));
                        this.timer = 0;
                    }
                }
            }
            break;
        }

        case 'drag':
            target = Math.sin(this.t * 6) * 0.25;
            break;
        }

        if (this.spin > 0) {
            const d = Math.min(this.spin, 13 * dt);
            this.rot += d * this.dir;
            this.spin -= d;
        } else {
            this.rot += wrap(target - this.rot) * Math.min(1, dt * (this.state === 'swing' ? 14 : 8));
        }
    }

    // ---- painting only what changed ----
    box() {
        const pad = 34 * S;
        const [cx, cy] = toWorld(this.x, this.y, this.rot, this.dir, 0, -9);
        let x0 = cx - pad, y0 = cy - pad, x1 = cx + pad, y1 = cy + pad;
        const grow = (x, y) => {
            x0 = Math.min(x0, x - 10);
            y0 = Math.min(y0, y - 10);
            x1 = Math.max(x1, x + 10);
            y1 = Math.max(y1, y + 10);
        };
        if (this.anchor)
            grow(this.anchor.x, this.anchor.y);
        if (this.shot)
            grow(this.shot.x, this.shot.y);
        for (const f of this.fading) {
            grow(f.x1, f.y1);
            grow(f.x2, f.y2);
        }
        if (this.bubble) {
            grow(cx - 130, cy - 34 * S - 70);
            grow(cx + 130, cy);
        }
        return [x0, y0, x1, y1];
    }

    invalidate() {
        const b = this.box();
        const p = this.lastBox ?? b;
        this.lastBox = b;
        const x0 = Math.floor(Math.min(b[0], p[0])), y0 = Math.floor(Math.min(b[1], p[1]));
        const x1 = Math.ceil(Math.max(b[2], p[2])), y1 = Math.ceil(Math.max(b[3], p[3]));
        this.win.queue_draw_area(x0, y0, x1 - x0, y1 - y0);
    }

    updateShape() {
        // Only the hero catches clicks; the rest of the screen passes through to your windows.
        const [cx, cy] = toWorld(this.x, this.y, this.rot, this.dir, 0, -9);
        const r = Math.round(22 * S);
        const rect = {x: Math.round(cx) - r, y: Math.round(cy) - r, width: 2 * r, height: 2 * r};
        const l = this.lastShape;
        if (l && Math.abs(l.x - rect.x) < 2 && Math.abs(l.y - rect.y) < 2)
            return;
        this.lastShape = rect;
        const region = new Cairo.Region();
        region.unionRectangle(rect);
        this.win.input_shape_combine_region(region);
    }

    draw(cr) {
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        this.paint(cr);
    }

    paint(cr) {
        const pose = this.pose();
        for (const f of this.fading)
            drawWeb(cr, f.x1, f.y1, f.x2, f.y2, f.life / 0.6);
        const [hx, hy] = handPos(this.x, this.y, this.rot, this.dir, pose);
        if (this.shot) {
            const p = Math.min(1, this.shot.p);
            drawWeb(cr, hx, hy, hx + (this.shot.x - hx) * p, hy + (this.shot.y - hy) * p);
        }
        if (this.anchor) {
            // hanging: the web holds his feet once he's flipped over; swinging: his hand
            const upside = this.state === 'hang' && Math.cos(this.rot) < 0;
            const [ex, ey] = upside ? feetPos(this.x, this.y, this.rot, this.dir, pose) : [hx, hy];
            drawWeb(cr, this.anchor.x, this.anchor.y, ex, ey);
            drawSplat(cr, this.anchor.x, this.anchor.y);
        }
        drawHero(cr, this.x, this.y, this.rot, this.dir, pose, this.blink < 0);
        if (this.bubble) {
            const [cx, cy] = toWorld(this.x, this.y, this.rot, this.dir, 0, -9);
            this.drawBubble(cr, this.bubble, cx, cy - 34 * S);
        }
    }

    drawBubble(cr, msg, cx, bottom) {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string('Ubuntu, Cantarell, Sans Bold 10'));
        layout.set_width(220 * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        layout.set_alignment(Pango.Alignment.CENTER);
        layout.set_text(msg, -1);
        const [, logical] = layout.get_pixel_extents();
        const bw = logical.width + 22, bh = logical.height + 12, r = 10;
        const bx = clampv(cx - bw / 2, 4, (this.W ?? 1e4) - bw - 4);
        const by = Math.max(4, bottom - bh);
        const tail = clampv(cx, bx + 14, bx + bw - 14);
        cr.newPath();
        cr.arc(bx + bw - r, by + r, r, -Math.PI / 2, 0);
        cr.arc(bx + bw - r, by + bh - r, r, 0, Math.PI / 2);
        cr.lineTo(tail + 7, by + bh);
        cr.lineTo(tail, by + bh + 8);
        cr.lineTo(tail - 7, by + bh);
        cr.arc(bx + r, by + bh - r, r, Math.PI / 2, Math.PI);
        cr.arc(bx + r, by + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.setSourceRGBA(1, 1, 1, 0.97);
        cr.fillPreserve();
        cr.setSourceRGB(...LINE);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.setSourceRGB(...LINE);
        cr.moveTo(bx + 11 - logical.x, by + 6);
        PangoCairo.show_layout(cr, layout);
    }
}

// Render each pose to a PNG, for checking the artwork without a display.
function snapshot(path) {
    const cw = 150, ch = 220, floor = ch - 10;
    const poses = ['idle', 'crawl', 'land', 'climb', 'fly', 'swing', 'hang', 'drag'];
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, cw * poses.length, ch);
    const cr = new Cairo.Context(surf);
    cr.setSourceRGB(0.55, 0.62, 0.72);
    cr.paint();
    poses.forEach((state, i) => {
        const s = new Spidey(null);
        s.W = 1e4;
        s.state = state;
        s.t = 0.2;
        s.dir = 1;
        const cx = i * cw + cw / 2;
        s.x = cx;
        s.y = {idle: floor - STAND_H, crawl: floor - 9 * S, land: floor - 9 * S, climb: 120,
            fly: 110, swing: 150, hang: 150, drag: 120}[state];
        s.rot = {crawl: 0.6, land: 0.3, fly: 0.2, swing: 0.3, hang: Math.PI}[state] ?? 0;
        if (state === 'climb')
            s.x = i * cw + cw - 10 - 11 * S;
        if (state === 'swing')
            s.anchor = {x: cx - 50, y: 5};
        if (state === 'hang')
            s.anchor = {x: cx, y: 5};
        if (state === 'idle')
            s.bubble = 'Thwip!';
        cr.save();
        cr.rectangle(i * cw, 0, cw, ch);
        cr.clip();
        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.rectangle(i * cw, floor, cw, 2);
        if (state === 'climb')
            cr.rectangle(i * cw + cw - 10, 0, 2, ch);
        cr.fill();
        s.paint(cr);
        cr.restore();
    });
    surf.writeToPNG(path);
}

if (ARGV[0] === '--snapshot') {
    snapshot(ARGV[1]);
} else {
    // Gtk.Application keeps it to one hero: launching again just gets a wave from the one already out.
    const app = new Gtk.Application({application_id: 'dev.pocketpet.Spidey'});
    let hero = null;
    app.connect('activate', () => {
        if (hero)
            hero.say("I'm right here!");
        else
            hero = new Spidey(app);
    });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
    app.run([System.programInvocationName]);
}
