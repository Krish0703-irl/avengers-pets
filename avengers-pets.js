#!/usr/bin/env -S gjs -m
// Avengers Pets: Spider-Man, Iron Man, Captain America, Hulk, Thor, Black Widow,
// Hawkeye and Mochi living on your screen, getting in each other's way.
// Launch it again to open the panel where you choose who stays.
// Click a hero for a trick, drag to toss them, right-click for their moves.

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

const S = 1.6;      // drawing scale: a hero is about 75px tall
const G = 1500;     // gravity, px/s²
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'avengers-pets']);
const SETTINGS_FILE = GLib.build_filenamev([DATA_DIR, 'settings.json']);

const ORDER = ['spidey', 'ironman', 'cap', 'hulk', 'thor', 'widow', 'hawkeye', 'strange', 'mochi'];
const NAMES = {
    spidey: 'Spider-Man', ironman: 'Iron Man', cap: 'Captain America', hulk: 'Hulk',
    thor: 'Thor', widow: 'Black Widow', hawkeye: 'Hawkeye', strange: 'Doctor Strange', mochi: 'Mochi',
};
const DEFAULT_ON = ['spidey', 'ironman', 'cap', 'hulk'];

// ---- colors ----
const INK = [0.1, 0.04, 0.06];
const SKIN = [0.98, 0.8, 0.66];
const RED = [0.86, 0.1, 0.14];
const BLUE = [0.13, 0.27, 0.72];
const IM_RED = [0.74, 0.08, 0.1];
const GOLD = [0.96, 0.74, 0.22];
const CAP_BLUE = [0.15, 0.24, 0.58];
const CAP_RED = [0.78, 0.12, 0.15];
const WHITE = [1, 1, 1];
const BROWN = [0.45, 0.27, 0.14];
const GREEN = [0.4, 0.64, 0.22];
const GREEN_DK = [0.25, 0.42, 0.13];
const PURPLE = [0.45, 0.22, 0.58];
const ARMOR = [0.22, 0.24, 0.3];
const SILVER = [0.74, 0.77, 0.82];
const CAPE = [0.74, 0.08, 0.1];
const BLOND = [0.95, 0.78, 0.35];
const SUIT_BLACK = [0.14, 0.14, 0.17];
const HAIR_RED = [0.8, 0.27, 0.12];
const HAIR_BROWN = [0.3, 0.2, 0.12];
const HAWK_PURPLE = [0.36, 0.18, 0.48];

// ---- small helpers ----
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const now = () => GLib.get_monotonic_time() / 1e6;
const dark = (c, k = 0.7) => c.map(v => v * k);

function rgb(cr, c, a = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], a);
}

function ell(cr, cx, cy, rx, ry) {
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

function poly(cr, pts) {
    cr.moveTo(...pts[0]);
    for (const p of pts.slice(1))
        cr.lineTo(...p);
    cr.closePath();
}

function fillOutline(cr, c, w = 0.9) {
    rgb(cr, c);
    cr.fillPreserve();
    rgb(cr, INK);
    cr.setLineWidth(w);
    cr.stroke();
}

function line(cr, x1, y1, x2, y2) {
    cr.moveTo(x1, y1);
    cr.lineTo(x2, y2);
}

function star(cr, cx, cy, r, rot = 0) {
    for (let i = 0; i < 10; i++) {
        const a = rot - Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 ? r * 0.42 : r;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (i)
            cr.lineTo(px, py);
        else
            cr.moveTo(px, py);
    }
    cr.closePath();
}

function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const t = clampv(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Where a ray from (x, y) at angle a leaves the screen.
function rayToEdge(x, y, a, W, H) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let t = 1e5;
    if (dx > 0)
        t = Math.min(t, (W - x) / dx);
    if (dx < 0)
        t = Math.min(t, -x / dx);
    if (dy > 0)
        t = Math.min(t, (H - y) / dy);
    if (dy < 0)
        t = Math.min(t, -y / dy);
    return [x + dx * t, y + dy * t];
}

// ---- particles ----
function spawn(list, kind, x, y, o = {}) {
    const life = o.life ?? rand(0.5, 1.0);
    list.push({
        kind, x, y, life, max: life,
        vx: o.vx ?? rand(-40, 40), vy: o.vy ?? rand(-80, -30),
        g: o.g ?? 0, size: o.size ?? 3, color: o.color ?? WHITE, rot: rand(0, 6),
    });
    if (list.length > 120)
        list.shift();
}

function dust(list, x, y, n, spread = 1) {
    for (let i = 0; i < n; i++) {
        spawn(list, 'dust', x + rand(-12, 12) * spread, y - 3, {
            vx: rand(-90, 90) * spread, vy: rand(-50, -10), size: rand(3, 6) * spread, life: rand(0.5, 0.9),
        });
    }
}

function sparks(list, x, y, n, color = [1, 0.85, 0.3]) {
    for (let i = 0; i < n; i++) {
        const a = rand(0, 2 * Math.PI), sp = rand(80, 220);
        spawn(list, 'spark', x, y, {vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.25, 0.5), color});
    }
}

function stepParticles(list, dt) {
    for (const p of list) {
        p.life -= dt;
        p.vy += p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += dt * 6;
    }
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].life <= 0)
            list.splice(i, 1);
    }
}

function drawParticles(cr, list) {
    for (const p of list) {
        const f = Math.max(0, p.life / p.max);
        cr.newPath();
        switch (p.kind) {
        case 'dust':
        case 'smoke': {
            const c = p.kind === 'dust' ? [0.78, 0.74, 0.68] : [0.35, 0.33, 0.33];
            rgb(cr, c, f * 0.55);
            cr.arc(p.x, p.y, p.size * (1 + (1 - f) * 1.6), 0, 2 * Math.PI);
            cr.fill();
            break;
        }
        case 'spark':
            rgb(cr, p.color, f);
            cr.setLineWidth(1.6);
            for (let k = 0; k < 4; k++) {
                const a = p.rot + k * Math.PI / 2;
                line(cr, p.x, p.y, p.x + Math.cos(a) * 4, p.y + Math.sin(a) * 4);
            }
            cr.stroke();
            break;
        case 'ember':
            rgb(cr, [1, 0.55 + 0.4 * f, 0.15], f);
            cr.arc(p.x, p.y, p.size * f + 0.6, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'rock':
            cr.save();
            cr.translate(p.x, p.y);
            cr.rotate(p.rot);
            rgb(cr, [0.48, 0.4, 0.33], Math.min(1, f * 2));
            cr.rectangle(-p.size / 2, -p.size / 2, p.size, p.size);
            cr.fill();
            cr.restore();
            break;
        case 'heart':
            rgb(cr, [1, 0.42, 0.56], f);
            cr.arc(p.x - 2.5, p.y, 3, Math.PI, 0);
            cr.arc(p.x + 2.5, p.y, 3, Math.PI, 0);
            cr.lineTo(p.x, p.y + 7);
            cr.closePath();
            cr.fill();
            break;
        case 'zap': {
            rgb(cr, [0.55, 0.85, 1], f);
            cr.setLineWidth(1.4);
            let x = p.x, y = p.y;
            cr.moveTo(x, y);
            for (let k = 0; k < 3; k++) {
                x += Math.cos(p.rot) * 4 + rand(-3, 3);
                y += Math.sin(p.rot) * 4 + rand(-3, 3);
                cr.lineTo(x, y);
            }
            cr.stroke();
            break;
        }
        }
    }
}

function drawBubble(cr, msg, cx, bottom, W) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string('Ubuntu, Cantarell, Sans Bold 10'));
    layout.set_width(220 * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_alignment(Pango.Alignment.CENTER);
    layout.set_text(msg, -1);
    const [, logical] = layout.get_pixel_extents();
    const bw = logical.width + 22, bh = logical.height + 12, r = 10;
    const bx = clampv(cx - bw / 2, 4, W - bw - 4);
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
    rgb(cr, INK);
    cr.setLineWidth(1.5);
    cr.stroke();
    cr.moveTo(bx + 11 - logical.x, by + 6);
    PangoCairo.show_layout(cr, layout);
}

// ---- the shared body rig ----
// Limb angles are [upper, bend]: 0 points down, +π/2 points the way the hero faces.
function limbEnd(ox, oy, [a, bend], l1, l2) {
    const x1 = ox + l1 * Math.sin(a), y1 = oy + l1 * Math.cos(a);
    return [x1, y1, x1 + l2 * Math.sin(a + bend), y1 + l2 * Math.cos(a + bend)];
}

function rigPoints(pose) {
    return {
        na: limbEnd(0, -11, pose.na, 7, 7), fa: limbEnd(0, -11, pose.fa, 7, 7),
        nl: limbEnd(0.8, 0, pose.nl, 8, 8), fl: limbEnd(-0.8, 0, pose.fl, 8, 8),
    };
}

function drawLimb(cr, ox, oy, pts, w, [upper, lower, tip]) {
    const [x1, y1, x2, y2] = pts;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    rgb(cr, INK);
    cr.setLineWidth(w + 1.4);
    cr.moveTo(ox, oy);
    cr.lineTo(x1, y1);
    cr.lineTo(x2, y2);
    cr.stroke();
    cr.setLineWidth(w);
    rgb(cr, upper);
    line(cr, ox, oy, x1, y1);
    cr.stroke();
    rgb(cr, lower);
    line(cr, x1, y1, x2, y2);
    cr.stroke();
    rgb(cr, tip);
    line(cr, (x1 + x2) / 2, (y1 + y2) / 2, x2, y2);
    cr.stroke();
}

function drawRig(cr, hero, pose) {
    const sk = hero.skin, k = hero.k;
    const P = rigPoints(pose);
    cr.save();
    cr.translate(hero.x, hero.y);
    cr.rotate(hero.rot);
    cr.scale(k * hero.dir, k);
    sk.back?.(cr, hero, P, pose);
    drawLimb(cr, 0, -11, P.fa, sk.armW ?? 4, sk.arm.map(c => dark(c)));
    drawLimb(cr, -0.8, 0, P.fl, sk.legW ?? 5, sk.leg.map(c => dark(c)));
    sk.torso(cr, hero);
    sk.head(cr, hero);
    drawLimb(cr, 0.8, 0, P.nl, sk.legW ?? 5, sk.leg);
    drawLimb(cr, 0, -11, P.na, sk.armW ?? 4, sk.arm);
    sk.front?.(cr, hero, P, pose);
    cr.restore();
}

function torsoPath(cr, w = 1) {
    poly(cr, [[-5.2 * w, -13.5], [5.2 * w, -13.5], [4.2 * w, 0.5], [-4.2 * w, 0.5]]);
}

function headPath(cr, rx = 9, ry = 9.5) {
    ell(cr, 0, -21.5, rx, ry);
}

function eyes(cr, hero, y = -21, spread = 2.7, size = 1.15) {
    const look = 0.9;
    for (const s of [-1, 1]) {
        const ex = s * spread + look;
        if (hero.blink < 0) {
            rgb(cr, INK);
            cr.setLineWidth(0.8);
            line(cr, ex - size, y, ex + size, y);
            cr.stroke();
        } else {
            rgb(cr, INK);
            ell(cr, ex, y, size, size * 1.25);
            cr.fill();
            rgb(cr, WHITE);
            ell(cr, ex + 0.4, y - 0.5, size * 0.35, size * 0.35);
            cr.fill();
        }
    }
}

function brows(cr, color, y = -23.6, tilt = 0, w = 0.8) {
    rgb(cr, color);
    cr.setLineWidth(w);
    for (const s of [-1, 1]) {
        line(cr, s * 1.4 + 0.9, y + tilt, s * 4 + 0.9, y - tilt * 0.3);
        cr.stroke();
    }
}

function mouth(cr, kind, y = -16.4) {
    rgb(cr, INK);
    cr.setLineWidth(0.8);
    cr.setLineCap(Cairo.LineCap.ROUND);
    if (kind === 'smile') {
        cr.moveTo(-1.6 + 0.9, y);
        quadTo(cr, 0.9, y + 1.6, 1.6 + 0.9, y);
        cr.stroke();
    } else if (kind === 'smirk') {
        cr.moveTo(-1.2 + 0.9, y + 0.3);
        quadTo(cr, 0.9, y + 0.9, 2.2 + 0.9, y - 0.5);
        cr.stroke();
    } else if (kind === 'open') {
        rgb(cr, [0.45, 0.1, 0.12]);
        ell(cr, 0.9, y + 0.3, 1.8, 1.4);
        cr.fill();
    } else {
        line(cr, -1.3 + 0.9, y, 1.3 + 0.9, y);
        cr.stroke();
    }
}

function drawShield(cr, x, y, r, spin) {
    cr.save();
    cr.translate(x, y);
    cr.newPath();
    for (const [f, c] of [[1, CAP_RED], [0.78, WHITE], [0.56, CAP_RED], [0.36, CAP_BLUE]]) {
        cr.arc(0, 0, r * f, 0, 2 * Math.PI);
        rgb(cr, c);
        cr.fill();
    }
    star(cr, 0, 0, r * 0.33, spin);
    rgb(cr, WHITE);
    cr.fill();
    cr.arc(0, 0, r, 0, 2 * Math.PI);
    rgb(cr, INK);
    cr.setLineWidth(r * 0.09);
    cr.stroke();
    cr.restore();
}

// Mjolnir, drawn with its handle along +y from (0, 0).
function drawHammer(cr, s = 1) {
    cr.save();
    cr.scale(s, s);
    cr.setLineCap(Cairo.LineCap.ROUND);
    rgb(cr, INK);
    cr.setLineWidth(2.6);
    line(cr, 0, -1.5, 0, 5);
    cr.stroke();
    rgb(cr, BROWN);
    cr.setLineWidth(1.6);
    line(cr, 0, -1.5, 0, 5);
    cr.stroke();
    cr.rectangle(-4.2, 5, 8.4, 4.6);
    fillOutline(cr, [0.62, 0.65, 0.7], 0.8);
    rgb(cr, [0.82, 0.85, 0.9]);
    cr.rectangle(-3.4, 5.7, 6.8, 1);
    cr.fill();
    cr.restore();
}

function flame(cr, x, y, ang, len, w = 1.6) {
    cr.save();
    cr.translate(x, y);
    cr.rotate(-ang);
    const g = new Cairo.LinearGradient(0, 0, 0, len);
    g.addColorStopRGBA(0, 1, 1, 1, 1);
    g.addColorStopRGBA(0.35, 0.55, 0.9, 1, 0.9);
    g.addColorStopRGBA(1, 0.4, 0.75, 1, 0);
    cr.moveTo(-w, 0);
    cr.curveTo(-w, len * 0.5, -0.3, len, 0, len);
    cr.curveTo(0.3, len, w, len * 0.5, w, 0);
    cr.closePath();
    cr.setSource(g);
    cr.fill();
    cr.restore();
}

// ---- costumes ----
const SPIDEY = {
    scale: 1, arm: [RED, RED, RED], leg: [BLUE, BLUE, RED],
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, BLUE);
        poly(cr, [[-4.9, -13.2], [4.9, -13.2], [3.2, -4], [0, -2.2], [-3.2, -4]]);
        rgb(cr, RED);
        cr.fill();
        cr.rectangle(-4.25, -1.6, 8.5, 1.8);
        cr.fill();
        rgb(cr, INK);
        cr.arc(0, -9, 0.9, 0, 2 * Math.PI);
        cr.fill();
        cr.setLineWidth(0.5);
        for (const s of [-1, 1]) {
            line(cr, 0, -9, 2.2 * s, -10.8);
            line(cr, 0, -9, 2.2 * s, -7.2);
            line(cr, 0, -9, 2.6 * s, -9.4);
        }
        cr.stroke();
    },
    head(cr, h) {
        headPath(cr);
        rgb(cr, RED);
        cr.fillPreserve();
        cr.save();
        cr.clip();
        rgb(cr, INK, 0.55);
        cr.setLineWidth(0.35);
        for (let k = 0; k < 10; k++) {
            const a = k * Math.PI / 5;
            line(cr, 0, -20, Math.cos(a) * 12, -20 + Math.sin(a) * 12);
        }
        cr.stroke();
        for (const r of [3.5, 6.5]) {
            cr.arc(0, -20, r, 0, 2 * Math.PI);
            cr.stroke();
        }
        cr.restore();
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
        for (const s of [-1, 1]) {
            cr.save();
            cr.translate(1 + s * 3.6, -22.3);
            cr.rotate(s * 0.55);
            cr.scale(3.1, h.blink < 0 ? 0.5 : 2.2);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            fillOutline(cr, WHITE, 1);
        }
    },
};

const IRON = {
    scale: 1, arm: [GOLD, IM_RED, IM_RED], leg: [GOLD, IM_RED, IM_RED],
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, IM_RED);
        poly(cr, [[-3.6, -6], [3.6, -6], [3, 0.3], [-3, 0.3]]);
        rgb(cr, GOLD);
        cr.fill();
        const g = new Cairo.RadialGradient(0, -9.5, 0, 0, -9.5, 4.2);
        g.addColorStopRGBA(0, 1, 1, 1, 1);
        g.addColorStopRGBA(0.45, 0.6, 0.92, 1, 0.95);
        g.addColorStopRGBA(1, 0.4, 0.8, 1, 0);
        cr.setSource(g);
        cr.arc(0, -9.5, 4.2, 0, 2 * Math.PI);
        cr.fill();
        cr.arc(0, -9.5, 1.8, 0, 2 * Math.PI);
        rgb(cr, INK, 0.7);
        cr.setLineWidth(0.4);
        cr.stroke();
    },
    head(cr) {
        headPath(cr);
        rgb(cr, IM_RED);
        cr.fill();
        cr.save();
        headPath(cr);
        cr.clip();
        cr.moveTo(-6.6, -27);
        cr.curveTo(-3, -29.5, 3, -29.5, 6.6, -27);
        cr.lineTo(6.2, -18);
        cr.curveTo(5, -13, -5, -13, -6.2, -18);
        cr.closePath();
        rgb(cr, GOLD);
        cr.fill();
        cr.restore();
        for (const s of [-1, 1]) {
            poly(cr, [[s * 5.3 + 0.6, -23.2], [s * 1.4 + 0.6, -22.4], [s * 1.5 + 0.6, -21.1], [s * 5 + 0.6, -21.9]]);
            rgb(cr, [0.5, 0.85, 1], 0.45);
            cr.setLineWidth(1.6);
            cr.strokePreserve();
            rgb(cr, [0.9, 0.98, 1]);
            cr.fill();
        }
        rgb(cr, INK, 0.5);
        cr.setLineWidth(0.5);
        line(cr, -2.2, -16.3, 3.2, -16.3);
        cr.stroke();
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
    front(cr, h, P, pose) {
        if (h.thrust > 0) {
            for (const key of ['nl', 'fl']) {
                const [, , x2, y2] = P[key];
                flame(cr, x2, y2, pose[key][0] + pose[key][1], (5 + Math.random() * 3) * h.thrust, 1.8);
            }
        }
        if (h.palms > 0) {
            for (const key of ['na', 'fa']) {
                const [, , x2, y2] = P[key];
                flame(cr, x2, y2, pose[key][0] + pose[key][1], (3 + Math.random() * 2) * h.palms, 1.2);
            }
        }
    },
};

const CAP = {
    scale: 1, arm: [CAP_BLUE, CAP_BLUE, CAP_RED], leg: [CAP_BLUE, CAP_BLUE, CAP_RED],
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, CAP_BLUE);
        cr.save();
        torsoPath(cr);
        cr.clip();
        for (let i = 0; i < 8; i++) {
            rgb(cr, i % 2 ? WHITE : CAP_RED);
            cr.rectangle(-5.6 + i * 1.4, -5.5, 1.4, 4);
            cr.fill();
        }
        cr.restore();
        star(cr, 0, -9.6, 3.1);
        rgb(cr, WHITE);
        cr.fill();
        rgb(cr, BROWN);
        cr.rectangle(-4.25, -1.6, 8.5, 1.8);
        cr.fill();
    },
    head(cr, h) {
        headPath(cr);
        rgb(cr, CAP_BLUE);
        cr.fill();
        cr.save();
        headPath(cr);
        cr.clip();
        ell(cr, 0.8, -18.4, 5.8, 6.4);
        rgb(cr, SKIN);
        cr.fill();
        cr.restore();
        eyes(cr, h, -20.6, 2.5, 1.05);
        brows(cr, HAIR_BROWN, -22.8, 0.2, 0.6);
        mouth(cr, 'smile', -16.2);
        rgb(cr, WHITE);
        cr.setLineWidth(0.9);
        cr.moveTo(-0.6, -25.6);
        cr.lineTo(0.9, -29);
        cr.lineTo(2.4, -25.6);
        line(cr, -0.1, -26.8, 1.9, -26.8);
        cr.stroke();
        for (const s of [-1, 1]) {
            poly(cr, [[s * 6.2 + 0.6, -25.5], [s * 9 + 0.6, -27.6], [s * 8.4 + 0.6, -23.2]]);
            rgb(cr, WHITE);
            cr.fill();
        }
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
    front(cr, h, P) {
        if (h.hasShield) {
            const [, , x2, y2] = P.na;
            drawShield(cr, x2 + 1.5, y2 - 1.5, 7.5, 0);
        }
    },
};

const HULK = {
    scale: 1.4, armW: 6.5, legW: 7, arm: [GREEN, GREEN, GREEN], leg: [PURPLE, GREEN, GREEN],
    torso(cr) {
        torsoPath(cr, 1.35);
        fillOutline(cr, GREEN);
        rgb(cr, GREEN_DK);
        cr.setLineWidth(0.5);
        cr.moveTo(-5, -9.5);
        quadTo(cr, -2.5, -7.5, 0, -9.5);
        quadTo(cr, 2.5, -7.5, 5, -9.5);
        line(cr, 0, -9.5, 0, -3);
        line(cr, -2.2, -6, 2.2, -6);
        cr.stroke();
        poly(cr, [[-5.8, -2.6], [5.8, -2.6], [5.7, 0.6], [-5.7, 0.6]]);
        fillOutline(cr, PURPLE, 0.7);
    },
    head(cr, h) {
        headPath(cr, 8.4, 8.6);
        fillOutline(cr, GREEN);
        rgb(cr, [0.1, 0.1, 0.1]);
        cr.moveTo(-8.4, -22);
        const tips = [[-8, -28], [-5.5, -26.5], [-4, -31], [-1, -28], [1, -31.5], [3, -28], [5.5, -30.5], [6.5, -27], [8.8, -27.5], [8.4, -22]];
        for (const [tx, ty] of tips)
            cr.lineTo(tx, ty);
        cr.lineTo(6, -25.2);
        cr.lineTo(-6, -25.2);
        cr.closePath();
        cr.fill();
        brows(cr, [0.1, 0.1, 0.1], -23.2, 0.9, 1.4);
        const angry = ['roar', 'smash', 'leap'].includes(h.state);
        for (const s of [-1, 1]) {
            rgb(cr, angry ? [0.2, 0.55, 0.15] : INK);
            ell(cr, s * 2.8 + 0.9, -21, 1.1, h.blink < 0 ? 0.2 : 0.9);
            cr.fill();
        }
        if (angry) {
            rgb(cr, [0.35, 0.08, 0.1]);
            ell(cr, 0.9, -16, 3.6, 2.4);
            cr.fill();
            rgb(cr, WHITE);
            cr.rectangle(-2.2, -18.1, 6.2, 1);
            cr.fill();
        } else {
            rgb(cr, INK);
            cr.setLineWidth(0.9);
            cr.moveTo(-1.6, -15.6);
            quadTo(cr, 0.9, -17, 3.4, -15.6);
            cr.stroke();
        }
    },
};

const THOR = {
    scale: 1, arm: [ARMOR, SILVER, SILVER], leg: [ARMOR, ARMOR, [0.38, 0.32, 0.3]],
    back(cr, h) {
        const f = h.capeFlow ?? 0, wv = Math.sin(h.t * 7) * (0.6 + f);
        cr.moveTo(-3.5, -13.4);
        cr.curveTo(-7, -6, -8 - f * 3 + wv, 3 + f * 3, -6 - f * 2 + wv, 9 + f * 7);
        cr.lineTo(1 + wv * 0.6, 8 + f * 7);
        cr.curveTo(1, 2, 2.5, -6, 3, -13.4);
        cr.closePath();
        fillOutline(cr, CAPE, 0.8);
        ell(cr, -2.5, -18.5, 8.6, 10);
        rgb(cr, BLOND);
        cr.fill();
    },
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, ARMOR);
        for (const [x, y] of [[-2.3, -10.5], [2.3, -10.5], [-2.2, -7], [2.2, -7], [-2.1, -3.5], [2.1, -3.5]]) {
            cr.arc(x, y, 1.15, 0, 2 * Math.PI);
            fillOutline(cr, SILVER, 0.4);
        }
    },
    head(cr, h) {
        headPath(cr);
        fillOutline(cr, SKIN);
        cr.save();
        headPath(cr);
        cr.clip();
        cr.moveTo(-10, -22);
        cr.curveTo(-8, -33, 9, -34, 10, -23);
        cr.curveTo(6, -27, 1, -27.5, -3, -25.5);
        cr.curveTo(-6, -24, -7, -20, -10, -16);
        cr.closePath();
        rgb(cr, BLOND);
        cr.fill();
        cr.moveTo(-5.5, -17);
        cr.curveTo(-4, -11, 6, -11, 7, -17);
        cr.curveTo(4, -15, -2, -15, -5.5, -17);
        cr.fill();
        cr.restore();
        eyes(cr, h, -20.8, 2.6, 1.05);
        brows(cr, [0.75, 0.55, 0.2], -23, 0.2, 0.7);
        mouth(cr, 'smile', -16.6);
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
    front(cr, h, P, pose) {
        if (!h.hasHammer)
            return;
        const [, , x2, y2] = P.na;
        const a = pose.na[0] + pose.na[1];
        cr.save();
        cr.translate(x2, y2);
        cr.rotate(h.state === 'spinup' ? h.t * 22 : -a);
        drawHammer(cr);
        cr.restore();
    },
};

const WIDOW = {
    scale: 1, arm: [SUIT_BLACK, SUIT_BLACK, [0.55, 0.57, 0.62]], leg: [SUIT_BLACK, SUIT_BLACK, SUIT_BLACK],
    back(cr) {
        cr.moveTo(-9, -24);
        cr.curveTo(-11, -16, -9, -10, -5, -9);
        cr.lineTo(3, -12);
        cr.lineTo(4, -22);
        cr.closePath();
        rgb(cr, HAIR_RED);
        cr.fill();
    },
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, SUIT_BLACK);
        rgb(cr, [0.5, 0.5, 0.55]);
        cr.setLineWidth(0.4);
        line(cr, 0.5, -13.3, 0.5, -2);
        cr.stroke();
        cr.rectangle(-4.25, -1.8, 8.5, 1.9);
        rgb(cr, [0.6, 0.62, 0.66]);
        cr.fill();
        poly(cr, [[-1.3, -1.9], [1.3, -1.9], [0, -0.85]]);
        poly(cr, [[-1.3, 0.2], [1.3, 0.2], [0, -0.85]]);
        rgb(cr, RED);
        cr.fill();
    },
    head(cr, h) {
        headPath(cr);
        fillOutline(cr, SKIN);
        cr.save();
        headPath(cr);
        cr.clip();
        cr.moveTo(-10, -18);
        cr.curveTo(-10, -34, 10, -34, 10, -22);
        cr.curveTo(6, -27, 0, -26, -4, -23);
        cr.curveTo(-6, -21, -7, -18, -10, -14);
        cr.closePath();
        rgb(cr, HAIR_RED);
        cr.fill();
        cr.restore();
        eyes(cr, h, -20.4, 2.6, 1.1);
        rgb(cr, INK);
        cr.setLineWidth(0.5);
        for (const s of [-1, 1]) {
            line(cr, s * 2.6 + 0.9 + s * 0.9, -21.6, s * 2.6 + 0.9 + s * 1.9, -22.3);
            cr.stroke();
        }
        rgb(cr, [0.8, 0.25, 0.3]);
        ell(cr, 1, -16.4, 1.3, 0.55);
        cr.fill();
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
};

const HAWKEYE = {
    scale: 1, arm: [HAWK_PURPLE, SUIT_BLACK, SUIT_BLACK], leg: [SUIT_BLACK, SUIT_BLACK, HAWK_PURPLE],
    back(cr) {
        cr.save();
        cr.translate(-4.5, -11);
        cr.rotate(0.35);
        cr.rectangle(-1.8, -8, 3.6, 11);
        fillOutline(cr, BROWN, 0.6);
        for (const [x, c] of [[-1, RED], [0.2, WHITE], [1.2, RED]]) {
            poly(cr, [[x - 0.6, -8], [x + 0.6, -8], [x, -11]]);
            rgb(cr, c);
            cr.fill();
        }
        cr.restore();
    },
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, SUIT_BLACK);
        poly(cr, [[-5.1, -13.3], [-1.5, -13.3], [0.5, -5], [2.5, -13.3], [5.1, -13.3], [4.3, -1], [-4.3, -1]]);
        rgb(cr, HAWK_PURPLE);
        cr.fill();
        rgb(cr, BROWN);
        cr.setLineWidth(1);
        line(cr, -4.5, -13, 4, -2);
        cr.stroke();
    },
    head(cr, h) {
        headPath(cr);
        fillOutline(cr, SKIN);
        rgb(cr, HAIR_BROWN);
        cr.moveTo(-9, -22);
        for (const [x, y] of [[-8, -28], [-6, -27], [-4, -31], [-1.5, -28.5], [1, -31.5], [3, -28.5], [5.5, -30.5], [6.5, -27.5], [9, -26], [8.8, -23.5]])
            cr.lineTo(x, y);
        cr.lineTo(6, -25.5);
        cr.lineTo(-5, -25.5);
        cr.closePath();
        cr.fill();
        for (const s of [-1, 1]) {
            cr.save();
            cr.translate(s * 2.8 + 0.9, -21);
            cr.scale(2.2, 1.3);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            rgb(cr, [0.3, 0.15, 0.42]);
            cr.fill();
        }
        rgb(cr, [0.3, 0.15, 0.42]);
        cr.setLineWidth(0.6);
        line(cr, -0.3, -21.2, 2.1, -21.2);
        cr.stroke();
        mouth(cr, 'smirk', -16.6);
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
    front(cr, h, P, pose) {
        const [, , bx, by] = P.fa;
        const a = pose.fa[0] + pose.fa[1];
        const [, , nx, ny] = P.na;
        // the near hand, seen from the bow's own frame
        const dx = nx - bx, dy = ny - by;
        const fx = dx * Math.cos(a) - dy * Math.sin(a), fy = dx * Math.sin(a) + dy * Math.cos(a);
        const aiming = h.state === 'aim';
        cr.save();
        cr.translate(bx, by);
        cr.rotate(-a);
        cr.setLineCap(Cairo.LineCap.ROUND);
        const sx = aiming ? fx : 0, sy = aiming ? Math.min(fy, -1) : -2;
        rgb(cr, [0.85, 0.85, 0.85]);
        cr.setLineWidth(0.4);
        cr.moveTo(-9, -2);
        cr.lineTo(sx, sy);
        cr.lineTo(9, -2);
        cr.stroke();
        if (aiming) {
            rgb(cr, BROWN);
            cr.setLineWidth(0.6);
            line(cr, sx, sy, 0, 7);
            cr.stroke();
            poly(cr, [[-1, 6.5], [1, 6.5], [0, 8.6]]);
            rgb(cr, SILVER);
            cr.fill();
        }
        rgb(cr, INK);
        cr.setLineWidth(2);
        cr.moveTo(-9, -2);
        quadTo(cr, 0, 6, 9, -2);
        cr.stroke();
        rgb(cr, HAWK_PURPLE);
        cr.setLineWidth(1.1);
        cr.moveTo(-9, -2);
        quadTo(cr, 0, 6, 9, -2);
        cr.stroke();
        cr.restore();
    },
};

// ---- poses everyone shares ----
const IDLE = t => ({na: [0.3 + 0.06 * Math.sin(t * 2), 0.45], fa: [-0.3, 0.3], nl: [0.12, 0], fl: [-0.12, 0]});
const TUCK = {na: [1.6, -1.8], fa: [1.4, -1.6], nl: [1.9, -2.4], fl: [1.7, -2.3]};
const FALL = {na: [2.3, 0.2], fa: [-1.2, 0.6], nl: [0.5, -1.3], fl: [-0.3, -0.6]};
const LAND = {na: [0.7, -0.3], fa: [-0.7, 0.6], nl: [1.5, -1.9], fl: [0.5, -2.3]};
const OUCH = ['Ow!', 'Hey!', 'Watch it!', 'Whoa!', 'Not cool!'];

class Hero {
    constructor(world, skin) {
        this.world = world;
        this.skin = skin;
        this.k = S * (skin.scale ?? 1);
        this.x = world.W / 2;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.rot = 0;
        this.targetRot = 0;
        this.spin = 0;
        this.dir = 1;
        this.t = rand(0, 10);
        this.timer = 1;
        this.state = 'idle';
        this.blink = rand(1, 5);
        this.bubble = null;
        this.bubbleTime = 0;
        this.later = null;
        this.particles = [];
        this.fx = [];
        this.nextQuip = rand(25, 70);
        this.knockCd = 0;
        this.chatCd = rand(5, 15);
        this.paused = false;
        this.lastBox = null;
    }

    get W() {
        return this.world.W;
    }

    get floor() {
        return this.world.H;
    }

    get standH() {
        return 16.5 * this.k;
    }

    get crouchH() {
        return 9 * this.k;
    }

    get margin() {
        return 10 * this.k;
    }

    get grounded() {
        return ['idle', 'walk', 'run', 'land', 'chat'].includes(this.state);
    }

    // states where a passer-by may stop for a chat
    get chatty() {
        return ['idle', 'walk', 'run'].includes(this.state);
    }

    quips() {
        return [];
    }

    ouch() {
        return OUCH;
    }

    say(text, secs = 3) {
        this.bubble = text;
        this.bubbleTime = secs;
    }

    sayLater(text, delay, secs = 2.6) {
        this.later = {text, delay, secs};
    }

    toWorld(lx, ly) {
        const x = lx * this.dir * this.k, y = ly * this.k;
        return [this.x + x * Math.cos(this.rot) - y * Math.sin(this.rot),
            this.y + x * Math.sin(this.rot) + y * Math.cos(this.rot)];
    }

    center() {
        return this.toWorld(0, -9);
    }

    limbPos(key) {
        const P = rigPoints(this.pose());
        return this.toWorld(P[key][2], P[key][3]);
    }

    hit(px, py) {
        const [cx, cy] = this.center();
        return Math.abs(px - cx) < 24 * this.k && Math.abs(py - cy) < 26 * this.k;
    }

    // Enter by dropping in from the top of the screen.
    enter() {
        this.x = rand(this.W * 0.15, this.W * 0.85);
        this.y = -40;
        this.vx = 0;
        this.vy = 200;
        this.state = 'fall';
    }

    step(dt) {
        this.t += dt;
        this.knockCd -= dt;
        this.chatCd -= dt;
        this.blink -= dt;
        if (this.blink < -0.12)
            this.blink = rand(2.5, 6);
        if (this.bubble) {
            this.bubbleTime -= dt;
            if (this.bubbleTime <= 0)
                this.bubble = null;
        }
        if (this.later) {
            this.later.delay -= dt;
            if (this.later.delay <= 0) {
                this.say(this.later.text, this.later.secs);
                this.later = null;
            }
        }
        this.nextQuip -= dt;
        if (this.nextQuip <= 0) {
            this.nextQuip = rand(50, 100);
            const q = this.quips();
            if (!this.bubble && !this.paused && q.length)
                this.say(pick(q), 3.5);
        }
        stepParticles(this.particles, dt);
        for (const f of this.fx)
            f.life -= dt;
        this.fx = this.fx.filter(f => f.life > 0);

        this.targetRot = 0;
        if (this.state === 'drag')
            this.targetRot = Math.sin(this.t * 6) * 0.25;
        else
            this.behave(dt);

        if (this.spin > 0) {
            const d = Math.min(this.spin, 13 * dt);
            this.rot += d * this.dir;
            this.spin -= d;
        } else {
            this.rot += wrap(this.targetRot - this.rot) * Math.min(1, dt * 8);
        }
    }

    decide() {
        if (this.paused || Math.random() < 0.3) {
            this.state = 'idle';
            this.timer = rand(1.5, 4);
            if (Math.random() < 0.3)
                this.dir *= -1;
        } else {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 5);
        }
    }

    groundWalk(dt, speed, bounce = 1.5) {
        this.x += this.dir * speed * dt;
        const m = this.margin;
        if (this.x < m) {
            this.x = m;
            this.dir = 1;
        } else if (this.x > this.W - m) {
            this.x = this.W - m;
            this.dir = -1;
        }
        this.y = this.floor - this.standH - Math.abs(Math.cos(this.t * 8)) * bounce;
        this.timer -= dt;
        if (this.timer <= 0)
            this.decide();
    }

    // Free fall; returns true on touching the floor.
    ballistic(dt, g = G) {
        this.vy += g * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        const m = this.margin;
        if (this.x < m) {
            this.x = m;
            this.vx = Math.abs(this.vx) * 0.4;
        } else if (this.x > this.W - m) {
            this.x = this.W - m;
            this.vx = -Math.abs(this.vx) * 0.4;
        }
        if (this.y < 20 && this.vy < 0) {
            this.y = 20;
            this.vy = Math.abs(this.vy) * 0.2;
        }
        if (this.vy > 0 && this.y >= this.floor - this.crouchH) {
            this.y = this.floor - this.crouchH;
            this.spin = 0;
            return true;
        }
        return false;
    }

    land(time = 0.45) {
        this.state = 'land';
        this.timer = time;
        this.vx = this.vy = 0;
        this.y = this.floor - this.crouchH;
        dust(this.particles, this.x, this.floor, 4);
    }

    jumpTo(vx, vy, spin = 0) {
        if (this.x < this.W * 0.15)
            this.dir = 1;
        else if (this.x > this.W * 0.85)
            this.dir = -1;
        this.state = 'fall';
        this.vx = this.dir * Math.abs(vx);
        this.vy = -vy;
        this.spin = spin;
    }

    // Steer through the air toward a point; returns the distance left.
    steer(dt, tx, ty, max) {
        const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy) || 1;
        const sp = Math.min(max, d * 1.8), k = Math.min(1, dt * 1.8);
        this.vx += (dx / d * sp - this.vx) * k;
        this.vy += (dy / d * sp - this.vy) * k;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.x = clampv(this.x, this.margin, this.W - this.margin);
        this.y = clampv(this.y, 30, this.floor - this.standH);
        if (Math.abs(this.vx) > 40)
            this.dir = Math.sign(this.vx);
        return d;
    }

    // Upright when hovering, stretched out along the flight path when going fast.
    flightRot() {
        const sp = Math.hypot(this.vx, this.vy);
        const f = clampv((sp - 140) / 220, 0, 1);
        const fast = Math.atan2(this.vx, -this.vy);
        const slow = clampv(this.vx * 0.0015, -0.35, 0.35);
        return slow + wrap(fast - slow) * f;
    }

    behave(dt) {
        switch (this.state) {
        case 'walk':
            this.groundWalk(dt, 60);
            break;
        case 'land':
            this.y = this.floor - this.crouchH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        case 'fall':
            if (this.ballistic(dt))
                this.land();
            break;
        default: // idle, chat
            this.y = this.floor - this.standH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
        }
    }

    pose() {
        switch (this.state) {
        case 'walk': {
            const w = Math.sin(this.t * 8);
            return {na: [-0.5 * w, 0.4], fa: [0.5 * w, 0.4],
                nl: [0.5 * w, -0.3 - 0.3 * Math.max(0, -w)], fl: [-0.5 * w, -0.3 - 0.3 * Math.max(0, w)]};
        }
        case 'run': {
            const w = Math.sin(this.t * 13);
            return {na: [-1.0 * w, 1.2], fa: [1.0 * w, 1.2],
                nl: [0.9 * w, -0.5 - 0.7 * Math.max(0, -w)], fl: [-0.9 * w, -0.5 - 0.7 * Math.max(0, w)]};
        }
        case 'land':
            return LAND;
        case 'fall':
            return this.spin > 0 ? TUCK : FALL;
        case 'drag': {
            const f = Math.sin(this.t * 14);
            return {na: [2.6 + 0.5 * f, 0.3], fa: [2.4 - 0.5 * f, 0.3],
                nl: [0.4 + 0.4 * f, -0.4], fl: [-0.3 - 0.4 * f, -0.4]};
        }
        case 'chat':
            return {na: [0.9 + 0.3 * Math.sin(this.t * 5), 1.2], fa: [-0.2, 0.3], nl: [0.12, 0], fl: [-0.12, 0]};
        default:
            return IDLE(this.t);
        }
    }

    // ---- being pushed around by the others ----
    knock(vx, vy) {
        if (this.state === 'drag' || this.knockCd > 0)
            return false;
        this.knockCd = 1.5;
        this.vx = vx;
        this.vy = vy;
        if (Math.abs(vx) > 20)
            this.dir = -Math.sign(vx); // face whatever hit them
        this.onKnocked();
        this.say(pick(this.ouch()), 1.6);
        return true;
    }

    onKnocked() {
        this.state = 'fall';
        this.spin = Math.random() < 0.5 ? 2 * Math.PI : 0;
    }

    // Dropped through one of Doctor Strange's portals.
    warp(x, y) {
        if (this.state === 'drag')
            return;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 60;
        this.knockCd = 0;
        this.onKnocked();
        this.say(pick(['Whoa!', 'Where am I?!', 'Not again!', 'Strange!']), 1.8);
    }

    startChat(other, text, delay) {
        this.state = 'chat';
        this.timer = 3.6;
        this.chatCd = rand(25, 45);
        this.dir = other.x > this.x ? 1 : -1;
        this.y = this.floor - this.standH;
        if (delay)
            this.sayLater(text, delay);
        else
            this.say(text, 2.6);
    }

    others() {
        return this.world.heroes.filter(h => h !== this);
    }

    onClick() {
        if (this.grounded) {
            this.jumpTo(0, 480, 2 * Math.PI);
            this.say(pick(this.quips().concat(['Ha!'])), 1.8);
        }
    }

    onRelease(vx, vy) {
        this.vx = vx;
        this.vy = vy;
        this.state = 'fall';
    }

    menu() {
        return [];
    }

    extraPoints() {
        return [];
    }

    box() {
        const [cx, cy] = this.center();
        const pad = 34 * this.k;
        let x0 = cx - pad, y0 = cy - pad, x1 = cx + pad, y1 = cy + pad;
        const grow = (x, y, m = 12) => {
            x0 = Math.min(x0, x - m);
            y0 = Math.min(y0, y - m);
            x1 = Math.max(x1, x + m);
            y1 = Math.max(y1, y + m);
        };
        for (const [x, y, m] of this.extraPoints())
            grow(x, y, m);
        for (const p of this.particles)
            grow(p.x, p.y, 16);
        for (const f of this.fx) {
            grow(f.x - f.r, f.y - f.r * 0.5);
            grow(f.x + f.r, f.y + f.r * 0.3);
        }
        if (this.bubble) {
            grow(cx - 140, cy - 34 * this.k - 80);
            grow(cx + 140, cy);
        }
        return [x0, y0, x1, y1];
    }

    paintFx(cr) {
        for (const f of this.fx) {
            const p = 1 - f.life / f.max;
            if (f.kind === 'ring') {
                cr.save();
                cr.translate(f.x, f.y);
                cr.scale(1, 0.25);
                cr.arc(0, 0, f.r * p, 0, 2 * Math.PI);
                cr.restore();
                rgb(cr, [0.85, 0.8, 0.7], (1 - p) * 0.9);
                cr.setLineWidth(5 * (1 - p) + 1);
                cr.stroke();
            } else if (f.kind === 'boom') {
                const g = new Cairo.RadialGradient(f.x, f.y, 0, f.x, f.y, f.r * (0.4 + p * 0.6));
                g.addColorStopRGBA(0, 1, 0.95, 0.6, 1 - p);
                g.addColorStopRGBA(0.5, 1, 0.5, 0.1, (1 - p) * 0.9);
                g.addColorStopRGBA(1, 0.9, 0.2, 0.05, 0);
                cr.setSource(g);
                cr.arc(f.x, f.y, f.r, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }

    paintBehind(_cr) {}

    paintFront(_cr) {}

    paintBody(cr) {
        drawRig(cr, this, this.pose());
    }

    paint(cr) {
        this.paintFx(cr);
        this.paintBehind(cr);
        this.paintBody(cr);
        this.paintFront(cr);
        drawParticles(cr, this.particles);
    }

    paintBubble(cr) {
        if (!this.bubble)
            return;
        const [cx, cy] = this.center();
        drawBubble(cr, this.bubble, cx, cy - 34 * this.k, this.W);
    }

    // Ground shockwave that throws nearby heroes into the air.
    shockwave(x, radius, power) {
        this.fx.push({kind: 'ring', x, y: this.floor, r: radius, life: 0.7, max: 0.7});
        for (const o of this.others()) {
            const [ox, oy] = o.center();
            const d = Math.abs(ox - x);
            if (d < radius && oy > this.floor - 140)
                o.knock(Math.sign(ox - x || 1) * (250 + (radius - d)), -power * (1 - d / radius * 0.5));
        }
    }

    explode(x, y, radius) {
        this.fx.push({kind: 'boom', x, y, r: radius * 0.6, life: 0.5, max: 0.5});
        for (let i = 0; i < 8; i++)
            spawn(this.particles, 'smoke', x + rand(-10, 10), y + rand(-10, 10), {vy: rand(-60, -20), size: rand(4, 7), life: rand(0.6, 1)});
        for (let i = 0; i < 8; i++)
            spawn(this.particles, 'ember', x, y, {vx: rand(-200, 200), vy: rand(-250, 50), g: 500, size: 2.5, life: rand(0.4, 0.8)});
        for (const o of this.world.heroes) {
            const [ox, oy] = o.center();
            const d = Math.hypot(ox - x, oy - y);
            if (d < radius)
                o.knock(Math.sign(ox - x || 1) * 300, -520);
        }
    }

    // A thrown thing hits the first other hero it touches.
    hitTest(x, y, r) {
        for (const o of this.others()) {
            const [ox, oy] = o.center();
            if (Math.hypot(ox - x, oy - y) < r + 16 * o.k)
                return o;
        }
        return null;
    }
}

// ---- Spider-Man ----
class SpiderMan extends Hero {
    constructor(world) {
        super(world, SPIDEY);
        this.chain = 0;
        this.shot = null;
        this.anchor = null;
        this.fading = [];
    }

    quips() {
        return ['Thwip!', 'Just your friendly neighborhood desktop hero.', 'My spider-sense is tingling…',
            'Anyone need a web?', 'Hanging around, as usual.'];
    }

    ouch() {
        return ['Ow!', 'Spider-sense was late!', 'Not cool!', 'Hey, I was swinging!'];
    }

    get grounded() {
        return ['idle', 'crawl', 'land', 'chat'].includes(this.state);
    }

    get chatty() {
        return ['idle', 'crawl'].includes(this.state);
    }

    enter() {
        this.x = rand(this.W * 0.2, this.W * 0.8);
        this.y = 0;
        this.startHang(0);
    }

    pose() {
        const sw = Math.sin(this.t * 9);
        switch (this.state) {
        case 'crawl':
            return {na: [1.0 + 0.5 * sw, -0.4], fa: [1.0 - 0.5 * sw, -0.4],
                nl: [1.2 + 0.4 * sw, -1.7], fl: [1.2 - 0.4 * sw, -1.7]};
        case 'climb': {
            const c = Math.sin(this.t * 7);
            return {na: [2.5 + 0.35 * c, 0.3], fa: [2.2 - 0.35 * c, 0.4],
                nl: [1.5 + 0.3 * c, -1.4], fl: [1.2 - 0.3 * c, -1.2]};
        }
        case 'swing':
            return {na: [Math.PI, 0], fa: [1.1, 0.9], nl: [0.7, -1.3], fl: [0.25, -0.8]};
        case 'fly':
            return this.spin > 0 ? TUCK : {na: [2.3, 0.2], fa: [-1.2, 0.6], nl: [0.5, -1.3], fl: [-0.3, -0.6]};
        case 'hang': {
            const d = Math.sin(this.t * 2) * 0.12;
            return {na: [2.9 + d, 0.3], fa: [3.4 - d, -0.3], nl: [0.06, 0], fl: [-0.06, 0]};
        }
        default:
            return super.pose();
        }
    }

    feetPos() {
        const P = rigPoints(this.pose());
        return this.toWorld((P.nl[2] + P.fl[2]) / 2, (P.nl[3] + P.fl[3]) / 2);
    }

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
        const ay = rand(4, 50), dy = this.y - ay;
        const maxL = this.floor - 30 * this.k - ay;
        if (dy <= 0 || dy >= maxL)
            return false;
        const room = Math.sqrt(maxL * maxL - dy * dy);
        const ax = clampv(this.x + this.dir * Math.min(rand(140, 340), room), 20, this.W - 20);
        if (Math.abs(ax - this.x) < 50)
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
        const [hx, hy] = this.limbPos('na');
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
        this.y = Math.min(this.y, this.floor - this.standH);
        this.climbTo = Math.min(rand(this.floor * 0.3, this.floor * 0.7), this.y - 40);
    }

    onKnocked() {
        this.anchor = this.shot = null;
        this.state = 'fly';
        this.chain = 1; // web to safety
        this.spin = 2 * Math.PI;
    }

    onRelease(vx, vy) {
        this.anchor = this.shot = null;
        this.vx = vx;
        this.vy = vy;
        if (Math.abs(vx) > 30)
            this.dir = Math.sign(vx);
        this.state = 'fly';
        this.chain = 1;
    }

    onClick() {
        this.say(pick(['Thwip!', 'Hey there!', 'Woo-hoo!', 'Spider-flip!']), 1.8);
        if (this.grounded) {
            this.state = 'fly';
            this.vx = 0;
            this.vy = -480;
            this.chain = 0;
            this.spin = 2 * Math.PI;
        }
    }

    menu() {
        return [
            ['Swing around', () => {
                if (this.state === 'fly' || this.state === 'swing')
                    this.chain = 3;
                else
                    this.jump(3);
            }],
            ['Hang from the top', () => this.startHang()],
        ];
    }

    behave(dt) {
        for (const f of this.fading)
            f.life -= dt;
        this.fading = this.fading.filter(f => f.life > 0);
        const W = this.W, floor = this.floor, side = 11 * this.k;
        switch (this.state) {
        case 'crawl':
            this.y = floor - 9 * this.k;
            this.x += this.dir * 95 * dt;
            this.targetRot = 0.6 * this.dir;
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
            this.targetRot = 0.3 * this.dir;
            super.behave(dt);
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
            this.targetRot = clampv(this.vx * 0.0012, -0.5, 0.5);
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
            if (this.y >= floor - 9 * this.k && this.vy > 0) {
                this.shot = null;
                this.spin = 0;
                this.land();
            }
            break;

        case 'swing': {
            this.omega += (-(G / this.L) * Math.sin(this.theta) + this.dir * 2.0) * dt;
            this.theta += this.omega * dt;
            this.x = this.anchor.x + this.L * Math.sin(this.theta);
            this.y = this.anchor.y + this.L * Math.cos(this.theta);
            this.targetRot = -this.theta;
            this.timer += dt;
            if (this.x < side || this.x > W - side) {
                this.release();
                this.x = clampv(this.x, side, W - side);
                this.startClimb(this.x < W / 2 ? -1 : 1);
            } else if ((this.dir * this.omega > 0 && this.dir * this.theta > 0.55) || this.timer > 3.5 ||
                this.y > floor - this.standH) {
                this.release();
            } else {
                // swinging feet-first into someone knocks them over
                const o = this.hitTest(this.x, this.y, 10 * this.k);
                if (o && Math.abs(this.omega) > 1.2)
                    o.knock(Math.sign(this.omega) * 380, -380);
            }
            break;
        }

        case 'hang': {
            const reel = this.Lt - this.L;
            this.L += Math.sign(reel) * Math.min(Math.abs(reel), (reel < 0 ? 300 : 120) * dt);
            // sway gently, but never more than about 20px, so a long web can't swing him off screen
            this.theta = Math.sin(this.t * 1.4) * Math.min(0.06, 20 / (this.L + 16 * this.k));
            this.x = this.anchor.x + (this.L + 16 * this.k) * Math.sin(this.theta);
            this.y = this.anchor.y + (this.L + 16 * this.k) * Math.cos(this.theta);
            this.targetRot = Math.PI - this.theta;
            if (Math.abs(reel) < 2) {
                this.timer -= dt;
                if (!this.paused && this.timer <= 0) {
                    if (Math.random() < 0.5) {
                        const [fx, fy] = this.feetPos();
                        this.fading.push({x1: this.anchor.x, y1: this.anchor.y, x2: fx, y2: fy, life: 0.5});
                        this.anchor = null;
                        this.state = 'fly';
                        this.vx = this.dir * 60;
                        this.vy = 0;
                        this.chain = 0;
                    } else {
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

        default:
            super.behave(dt);
        }
    }

    extraPoints() {
        const pts = [];
        if (this.anchor)
            pts.push([this.anchor.x, this.anchor.y, 12]);
        if (this.shot)
            pts.push([this.shot.x, this.shot.y, 12]);
        for (const f of this.fading)
            pts.push([f.x1, f.y1, 10], [f.x2, f.y2, 10]);
        return pts;
    }

    paintBehind(cr) {
        const web = (x1, y1, x2, y2, a = 1) => {
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(0.25, 0.27, 0.32, 0.55 * a);
            cr.setLineWidth(3);
            line(cr, x1, y1, x2, y2);
            cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 0.95 * a);
            cr.setLineWidth(1.5);
            line(cr, x1, y1, x2, y2);
            cr.stroke();
        };
        for (const f of this.fading)
            web(f.x1, f.y1, f.x2, f.y2, f.life / 0.6);
        const [hx, hy] = this.limbPos('na');
        if (this.shot) {
            const p = Math.min(1, this.shot.p);
            web(hx, hy, hx + (this.shot.x - hx) * p, hy + (this.shot.y - hy) * p);
        }
        if (this.anchor) {
            const upside = this.state === 'hang' && Math.cos(this.rot) < 0;
            const [ex, ey] = upside ? this.feetPos() : [hx, hy];
            web(this.anchor.x, this.anchor.y, ex, ey);
            const {x, y} = this.anchor;
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.setLineWidth(1.2);
            for (let k = 0; k < 7; k++) {
                const a = k * Math.PI * 2 / 7;
                line(cr, x, y, x + Math.cos(a) * 7, y + Math.sin(a) * 7);
            }
            cr.stroke();
        }
    }
}

// ---- Iron Man ----
class IronMan extends Hero {
    constructor(world) {
        super(world, IRON);
        this.thrust = 0;
        this.palms = 0;
        this.tx = 0;
        this.ty = 0;
        this.beam = null;
    }

    quips() {
        return ['I am Iron Man.', 'JARVIS, run diagnostics.', 'Genius, billionaire, desktop pet.', 'Suit up!'];
    }

    ouch() {
        return ['Hey! This suit is new!', 'Ow!', 'Rude.', 'JARVIS, who did that?'];
    }

    get chatty() {
        return ['idle', 'walk'].includes(this.state);
    }

    enter() {
        this.dir = pick([-1, 1]);
        this.x = this.dir > 0 ? this.margin : this.W - this.margin;
        this.y = rand(80, this.floor * 0.5);
        this.vx = this.dir * 300;
        this.state = 'fly';
        this.newTarget();
    }

    newTarget() {
        if (this.paused) {
            this.tx = this.x;
            this.ty = this.y;
            return;
        }
        this.tx = rand(60, this.W - 60);
        this.ty = rand(60, this.floor - 160);
    }

    decide() {
        const r = Math.random();
        if (this.paused || r < 0.25) {
            this.state = 'idle';
            this.timer = rand(2, 4);
        } else if (r < 0.5) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else {
            this.takeoff();
        }
    }

    takeoff() {
        this.state = 'takeoff';
        this.timer = 0.7;
        this.vx = 0;
        this.vy = -60;
    }

    startBlast() {
        this.state = 'blast';
        this.timer = 0.9;
        const a = rand(-0.35, 0.45);
        this.beam = {a: this.dir > 0 ? a : Math.PI - a, on: false};
    }

    onKnocked() {
        this.beam = null;
        this.state = 'fly';
        this.spin = 2 * Math.PI;
        this.newTarget();
    }

    onRelease(vx, vy) {
        this.vx = vx;
        this.vy = vy;
        this.state = 'fly';
        this.newTarget();
    }

    onClick() {
        this.say(pick(['I am Iron Man.', 'Barrel roll!', 'Repulsors online.']), 1.8);
        if (this.grounded)
            this.takeoff();
        else if (this.state === 'fly')
            this.spin = 2 * Math.PI;
    }

    menu() {
        return [
            ['Fire repulsors', () => {
                if (this.grounded)
                    this.takeoff();
                else
                    this.startBlast();
            }],
            ['Land', () => {
                if (!this.grounded) {
                    this.state = 'descend';
                    this.tx = this.x;
                }
            }],
            ['Take off', () => this.grounded && this.takeoff()],
        ];
    }

    behave(dt) {
        this.thrust = 0;
        this.palms = 0;
        switch (this.state) {
        case 'fly': {
            const d = this.steer(dt, this.tx, this.ty + Math.sin(this.t * 2) * 6, 380);
            this.thrust = 1;
            this.palms = Math.hypot(this.vx, this.vy) < 160 ? 1 : 0;
            this.targetRot = this.flightRot();
            if (d < 25) {
                const r = Math.random();
                if (this.paused) {
                    this.newTarget();
                } else if (r < 0.25) {
                    this.startBlast();
                } else if (r < 0.45) {
                    this.state = 'descend';
                    this.tx = rand(60, this.W - 60);
                } else {
                    this.newTarget();
                }
            }
            break;
        }
        case 'descend': {
            const gy = this.floor - this.standH;
            const d = this.steer(dt, this.tx, gy, 320);
            this.thrust = 1;
            this.palms = 1;
            this.targetRot = this.flightRot();
            if (this.y >= gy - 4 || d < 12) {
                this.land(0.9);
                dust(this.particles, this.x, this.floor, 6);
            }
            break;
        }
        case 'takeoff':
            this.vy = Math.max(this.vy - 1100 * dt, -420);
            this.y += this.vy * dt;
            this.thrust = 1;
            this.palms = 1;
            this.timer -= dt;
            if (this.timer <= 0 || this.y < 80) {
                this.state = 'fly';
                this.newTarget();
            }
            break;
        case 'blast': {
            const damp = 1 - Math.min(1, dt * 4);
            this.vx *= damp;
            this.vy *= damp;
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.thrust = 1;
            this.timer -= dt;
            this.beam.on = this.timer < 0.7 && this.timer > 0.05;
            if (this.beam.on) {
                const [bx, by] = this.limbPos('na');
                const [ex, ey] = rayToEdge(bx, by, this.beam.a, this.W, this.floor);
                this.beam.x1 = bx;
                this.beam.y1 = by;
                this.beam.x2 = ex;
                this.beam.y2 = ey;
                for (const o of this.others()) {
                    const [ox, oy] = o.center();
                    if (segDist(ox, oy, bx, by, ex, ey) < 18 * o.k)
                        o.knock(Math.cos(this.beam.a) * 520, Math.sin(this.beam.a) * 300 - 380);
                }
                if (Math.random() < dt * 30)
                    sparks(this.particles, ex, ey, 2, [0.6, 0.9, 1]);
            }
            if (this.timer <= 0) {
                this.beam = null;
                this.state = 'fly';
                this.newTarget();
            }
            break;
        }
        case 'walk':
            this.groundWalk(dt, 55);
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        const sp = Math.hypot(this.vx, this.vy);
        switch (this.state) {
        case 'fly':
            if (this.spin > 0 || sp > 200)
                return {na: [-0.35, 0], fa: [-0.45, 0], nl: [0.05, 0], fl: [-0.05, 0]};
            return {na: [0.6, -0.5], fa: [-0.5, 0.4], nl: [0.1, -0.2], fl: [-0.1, -0.1]};
        case 'descend':
        case 'takeoff':
            return {na: [0.6, -0.5], fa: [-0.5, 0.4], nl: [0.1, -0.2], fl: [-0.1, -0.1]};
        case 'blast': {
            const a = this.beam.a;
            const arm = Math.atan2(this.dir * Math.cos(a), Math.sin(a));
            return {na: [arm, 0], fa: [-0.4, 0.3], nl: [0.08, 0], fl: [-0.08, 0]};
        }
        case 'land':
            return {na: [0.35, 0], fa: [-1.3, 0.4], nl: [1.5, -2.1], fl: [0.3, -2.5]};
        default:
            return super.pose();
        }
    }

    extraPoints() {
        const b = this.beam;
        return b?.on ? [[b.x1, b.y1, 14], [b.x2, b.y2, 18]] : [];
    }

    paintFront(cr) {
        const b = this.beam;
        if (!b?.on)
            return;
        const flick = 1 + Math.sin(this.t * 60) * 0.15;
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (const [w, c, a] of [[11, [0.4, 0.8, 1], 0.25], [6, [0.6, 0.9, 1], 0.6], [2.4, WHITE, 1]]) {
            rgb(cr, c, a);
            cr.setLineWidth(w * flick);
            line(cr, b.x1, b.y1, b.x2, b.y2);
            cr.stroke();
        }
        const g = new Cairo.RadialGradient(b.x1, b.y1, 0, b.x1, b.y1, 10);
        g.addColorStopRGBA(0, 1, 1, 1, 1);
        g.addColorStopRGBA(1, 0.5, 0.85, 1, 0);
        cr.setSource(g);
        cr.arc(b.x1, b.y1, 10, 0, 2 * Math.PI);
        cr.fill();
    }
}

// ---- Captain America ----
class Cap extends Hero {
    constructor(world) {
        super(world, CAP);
        this.hasShield = true;
        this.shield = null;
    }

    quips() {
        return ['I can do this all day.', 'Avengers, assemble!', 'On your left.', 'Language!'];
    }

    ouch() {
        return ['Hey!', 'I can do this all day.', 'Not cool, soldier.', 'Ow!'];
    }

    get grounded() {
        return super.grounded || ['wait', 'catch'].includes(this.state);
    }

    decide() {
        const r = Math.random();
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.35 && this.hasShield) {
            this.startThrow();
        } else if (r < 0.55) {
            this.state = 'run';
            this.dir = pick([-1, 1]);
            this.timer = rand(1.5, 3);
        } else if (r < 0.75) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else if (r < 0.87) {
            this.jumpTo(rand(120, 200), rand(600, 700), 2 * Math.PI);
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    startThrow() {
        if (this.x < this.W * 0.25)
            this.dir = 1;
        else if (this.x > this.W * 0.75)
            this.dir = -1;
        // aim at a teammate now and then
        const target = this.others().find(o => Math.sign(o.x - this.x) === this.dir);
        this.aim = target && Math.random() < 0.6 ? target : null;
        this.state = 'throw';
        this.timer = 0.38;
        this.thrown = false;
    }

    throwShield() {
        const [hx, hy] = this.limbPos('na');
        let a = rand(-0.6, 0.05);
        if (this.aim) {
            const [ox, oy] = this.aim.center();
            a = Math.atan2(oy - hy, Math.abs(ox - hx));
        }
        this.shield = {x: hx, y: hy, vx: Math.cos(a) * 720 * this.dir, vy: Math.sin(a) * 720,
            spin: 0, b: 0, maxB: Math.floor(rand(2, 5)), t: 0, back: false};
        this.hasShield = false;
        this.thrown = true;
    }

    updateShield(dt) {
        const s = this.shield;
        if (!s)
            return;
        s.spin += dt * 16;
        s.t += dt;
        const r = 7.5 * this.k;
        if (!s.back) {
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            let hit = false;
            if (s.x < r) {
                s.x = r;
                s.vx = Math.abs(s.vx);
                hit = true;
            } else if (s.x > this.W - r) {
                s.x = this.W - r;
                s.vx = -Math.abs(s.vx);
                hit = true;
            }
            if (s.y < r) {
                s.y = r;
                s.vy = Math.abs(s.vy);
                hit = true;
            } else if (s.y > this.floor - r) {
                s.y = this.floor - r;
                s.vy = -Math.abs(s.vy);
                hit = true;
            }
            const o = this.hitTest(s.x, s.y, r);
            if (o && (o.knock(Math.sign(s.vx) * 260, -420) || o.blocking)) {
                s.vx = -s.vx;
                hit = true;
            }
            if (hit) {
                s.b++;
                sparks(this.particles, s.x, s.y, 6);
            }
            if (s.b >= s.maxB || s.t > 2.6)
                s.back = true;
        } else {
            const [hx, hy] = this.limbPos('na');
            const dx = hx - s.x, dy = hy - s.y, d = Math.hypot(dx, dy) || 1;
            const k = Math.min(1, dt * 6);
            s.vx += (dx / d * 820 - s.vx) * k;
            s.vy += (dy / d * 820 - s.vy) * k;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            if (d < 16 || s.t > 6) {
                this.shield = null;
                this.hasShield = true;
                sparks(this.particles, hx, hy, 4, WHITE);
            }
        }
    }

    onKnocked() {
        if (this.state === 'throw' && !this.thrown)
            this.state = 'fall';
        super.onKnocked();
    }

    onClick() {
        if (this.hasShield && this.grounded) {
            this.say(pick(['Heads up!', 'Catch!', 'Avengers, assemble!']), 1.8);
            this.startThrow();
        } else {
            super.onClick();
        }
    }

    menu() {
        return [
            ['Throw the shield', () => {
                if (this.hasShield && this.grounded)
                    this.startThrow();
            }],
            ['Run', () => {
                if (this.grounded) {
                    this.state = 'run';
                    this.timer = 3;
                }
            }],
        ];
    }

    behave(dt) {
        this.updateShield(dt);
        const stand = this.floor - this.standH;
        switch (this.state) {
        case 'run':
            this.groundWalk(dt, 170, 3);
            this.targetRot = 0.2 * this.dir;
            break;
        case 'throw':
            this.y = stand;
            this.timer -= dt;
            if (!this.thrown && this.timer < 0.16)
                this.throwShield();
            if (this.timer <= 0)
                this.state = 'wait';
            break;
        case 'wait':
            this.y = stand;
            if (this.shield && Math.abs(this.shield.x - this.x) > 10)
                this.dir = Math.sign(this.shield.x - this.x);
            if (this.hasShield) {
                this.state = 'catch';
                this.timer = 0.35;
            }
            break;
        case 'catch':
            this.y = stand;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        switch (this.state) {
        case 'throw':
            if (this.timer > 0.16)
                return {na: [-1.9, 1.2], fa: [1.0, 0.3], nl: [0.4, -0.2], fl: [-0.4, 0]};
            return {na: [1.6, 0.1], fa: [-0.6, 0.3], nl: [0.4, -0.2], fl: [-0.4, 0]};
        case 'wait':
            return {na: [1.2, -0.4], fa: [-0.3, 0.3], nl: [0.25, -0.1], fl: [-0.25, 0]};
        case 'catch':
            return {na: [1.4, -0.9], fa: [-0.4, 0.3], nl: [0.25, -0.1], fl: [-0.25, 0]};
        default:
            return super.pose();
        }
    }

    extraPoints() {
        return this.shield ? [[this.shield.x, this.shield.y, 8 * this.k + 4]] : [];
    }

    paintFront(cr) {
        if (this.shield)
            drawShield(cr, this.shield.x, this.shield.y, 7.5 * this.k, this.shield.spin);
    }
}

// ---- Hulk ----
class Hulk extends Hero {
    constructor(world) {
        super(world, HULK);
        this.stomp = 0;
        this.angry = false;
    }

    quips() {
        return ['HULK SMASH!', 'Hulk strongest there is.', 'Puny desktop.', 'RAAAWR!'];
    }

    ouch() {
        return ['GRRR!', 'Hulk ANGRY!', 'Who did that?!'];
    }

    get grounded() {
        return super.grounded || ['roar', 'chest', 'smash'].includes(this.state);
    }

    decide() {
        const r = Math.random();
        if (this.angry) {
            this.angry = false;
            this.roar();
        } else if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.35) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 5);
        } else if (r < 0.6) {
            this.leap();
        } else if (r < 0.72) {
            this.roar();
        } else if (r < 0.85) {
            this.state = 'chest';
            this.timer = 1.6;
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    leap() {
        // sometimes leap right at somebody
        const target = Math.random() < 0.4 ? pick(this.others()) : null;
        if (target) {
            this.dir = Math.sign(target.x - this.x) || 1;
            this.state = 'leap';
            this.vy = -rand(900, 1050);
            const flight = -2 * this.vy / G;
            this.vx = clampv((target.x - this.x) / flight, -500, 500);
        } else {
            this.jumpTo(rand(220, 380), rand(900, 1100));
            this.state = 'leap';
        }
    }

    roar() {
        this.state = 'roar';
        this.timer = 2;
        this.say(pick(['HULK SMASH!', 'RAAAWR!']), 2);
    }

    smash() {
        this.land(0.8);
        this.state = 'smash';
        for (let i = 0; i < 8; i++)
            spawn(this.particles, 'rock', this.x + rand(-20, 20), this.floor - 4, {vx: rand(-220, 220), vy: rand(-420, -180), g: 1200, size: rand(3, 6), life: rand(0.7, 1.1)});
        dust(this.particles, this.x, this.floor, 10, 1.6);
        this.shockwave(this.x, 230, 620);
        if (Math.random() < 0.4)
            this.say('SMASH!', 1.5);
    }

    onKnocked() {
        // Hulk barely moves, but he remembers
        this.vx *= 0.35;
        this.vy *= 0.5;
        this.state = 'fall';
        this.angry = true;
    }

    onRelease(vx, vy) {
        super.onRelease(vx, vy);
        this.state = 'leap';
    }

    onClick() {
        if (this.grounded)
            Math.random() < 0.5 ? this.roar() : this.leap();
    }

    menu() {
        return [
            ['Smash!', () => this.grounded && this.leap()],
            ['Roar', () => this.grounded && this.roar()],
        ];
    }

    behave(dt) {
        switch (this.state) {
        case 'walk': {
            this.groundWalk(dt, 45, 3);
            const s = Math.sin(this.t * 8);
            if (Math.sign(s) !== this.stomp) {
                this.stomp = Math.sign(s);
                dust(this.particles, this.x + this.stomp * 8, this.floor, 2, 0.7);
            }
            break;
        }
        case 'leap':
        case 'fall':
            this.targetRot = clampv(this.vx * 0.001, -0.3, 0.3);
            if (this.ballistic(dt))
                this.smash();
            break;
        case 'smash':
            this.y = this.floor - this.crouchH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        case 'roar':
        case 'chest':
            this.y = this.floor - this.standH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        const s = Math.sin(this.t * 12);
        switch (this.state) {
        case 'roar':
            return {na: [2.2, 1.0], fa: [2.0, 1.0], nl: [0.35, -0.2], fl: [-0.35, -0.1]};
        case 'chest':
            return {na: [1.0 + 0.5 * Math.max(0, s), 2.3], fa: [1.0 + 0.5 * Math.max(0, -s), 2.3], nl: [0.3, -0.1], fl: [-0.3, 0]};
        case 'smash':
            return {na: [0.45, 0], fa: [0.2, 0], nl: [1.4, -2.0], fl: [0.4, -2.4]};
        case 'leap':
        case 'fall':
            return {na: [2.8, 0.3], fa: [2.6, 0.4], nl: [0.9, -1.4], fl: [0.4, -1.0]};
        case 'walk': {
            const w = Math.sin(this.t * 8);
            return {na: [-0.4 * w + 0.2, 0.6], fa: [0.4 * w + 0.2, 0.6],
                nl: [0.4 * w, -0.3 - 0.3 * Math.max(0, -w)], fl: [-0.4 * w, -0.3 - 0.3 * Math.max(0, w)]};
        }
        default:
            return super.pose();
        }
    }
}

// ---- Thor ----
class Thor extends Hero {
    constructor(world) {
        super(world, THOR);
        this.hasHammer = true;
        this.hammer = null;
        this.bolt = null;
        this.capeFlow = 0;
    }

    quips() {
        return ['For Asgard!', 'Another!', 'I am still worthy.', 'Point Break, at your service.'];
    }

    ouch() {
        return ['You dare?!', 'Ow!', 'Is that all?'];
    }

    get grounded() {
        return super.grounded || ['wait', 'catch', 'throw', 'spinup'].includes(this.state) ||
            (this.state === 'lightning' && this.y >= this.floor - this.standH - 5);
    }

    enter() {
        this.x = rand(this.W * 0.15, this.W * 0.85);
        this.y = this.floor - this.standH;
        this.startLightning();
        this.say('For Asgard!', 2.5);
    }

    newTarget() {
        this.tx = this.paused ? this.x : rand(60, this.W - 60);
        this.ty = this.paused ? this.y : rand(60, this.floor - 160);
    }

    decide() {
        const r = Math.random();
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.3) {
            this.state = 'spinup';
            this.timer = 0.9;
        } else if (r < 0.5 && this.hasHammer) {
            this.startThrow();
        } else if (r < 0.65) {
            this.startLightning();
        } else if (r < 0.85) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    startLightning() {
        if (!this.hasHammer)
            return;
        this.state = 'lightning';
        this.timer = 1.4;
        this.bolt = null;
        this.boltAge = 0;
    }

    startThrow() {
        if (this.x < this.W * 0.25)
            this.dir = 1;
        else if (this.x > this.W * 0.75)
            this.dir = -1;
        this.state = 'throw';
        this.timer = 0.38;
        this.thrown = false;
    }

    throwHammer() {
        const [hx, hy] = this.limbPos('na');
        const a = rand(-0.25, 0.05);
        this.hammer = {x: hx, y: hy, vx: Math.cos(a) * 850 * this.dir, vy: Math.sin(a) * 850, spin: 0, t: 0, back: false};
        this.hasHammer = false;
        this.thrown = true;
    }

    updateHammer(dt) {
        const m = this.hammer;
        if (!m)
            return;
        m.spin += dt * 18;
        m.t += dt;
        if (!m.back) {
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            if (m.x < 10 || m.x > this.W - 10 || m.y < 10 || m.y > this.floor - 10 || m.t > 0.7) {
                m.back = true;
                sparks(this.particles, m.x, m.y, 5);
            }
            const o = this.hitTest(m.x, m.y, 8);
            if (o && (o.knock(Math.sign(m.vx) * 320, -460) || o.blocking)) {
                m.back = true;
                sparks(this.particles, m.x, m.y, 6);
            }
        } else {
            const [hx, hy] = this.limbPos('na');
            const dx = hx - m.x, dy = hy - m.y, d = Math.hypot(dx, dy) || 1;
            const k = Math.min(1, dt * 7);
            m.vx += (dx / d * 900 - m.vx) * k;
            m.vy += (dy / d * 900 - m.vy) * k;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            if (d < 16 || m.t > 5) {
                this.hammer = null;
                this.hasHammer = true;
            }
        }
    }

    hammerTip() {
        const P = rigPoints(this.pose());
        const [, , x2, y2] = P.na;
        const a = this.pose().na[0] + this.pose().na[1];
        return this.toWorld(x2 + Math.sin(a) * 8, y2 + Math.cos(a) * 8);
    }

    onKnocked() {
        this.bolt = null;
        if (this.hasHammer) {
            this.state = 'fly';
            this.spin = 2 * Math.PI;
            this.newTarget();
        } else {
            super.onKnocked();
        }
    }

    onRelease(vx, vy) {
        this.vx = vx;
        this.vy = vy;
        if (this.hasHammer) {
            this.state = 'fly';
            this.newTarget();
        } else {
            this.state = 'fall';
        }
    }

    onClick() {
        if (this.grounded) {
            this.say(pick(['For Asgard!', 'Behold!', 'Another!']), 1.8);
            this.startLightning();
        }
    }

    menu() {
        return [
            ['Call the lightning', () => this.startLightning()],
            ['Throw the hammer', () => this.hasHammer && this.grounded && this.startThrow()],
            ['Fly', () => {
                if (this.grounded && this.hasHammer) {
                    this.state = 'spinup';
                    this.timer = 0.9;
                }
            }],
        ];
    }

    behave(dt) {
        this.updateHammer(dt);
        this.capeFlow = clampv(Math.hypot(this.vx, this.vy) / 400, 0, 1);
        const stand = this.floor - this.standH;
        switch (this.state) {
        case 'spinup':
            this.y = stand;
            this.timer -= dt;
            if (Math.random() < dt * 20)
                dust(this.particles, this.x, this.floor, 1);
            if (this.timer <= 0) {
                this.state = 'fly';
                this.vx = 0;
                this.vy = -350;
                this.newTarget();
            }
            break;
        case 'fly': {
            const d = this.steer(dt, this.tx, this.ty + Math.sin(this.t * 2) * 6, 420);
            this.targetRot = this.flightRot();
            if (d < 25) {
                const r = Math.random();
                if (this.paused)
                    this.newTarget();
                else if (r < 0.25)
                    this.startLightning();
                else if (r < 0.5) {
                    this.state = 'descend';
                    this.tx = rand(60, this.W - 60);
                } else {
                    this.newTarget();
                }
            }
            break;
        }
        case 'descend': {
            const d = this.steer(dt, this.tx, stand, 360);
            this.targetRot = this.flightRot();
            if (this.y >= stand - 4 || d < 12) {
                this.land(0.6);
                this.fx.push({kind: 'ring', x: this.x, y: this.floor, r: 80, life: 0.5, max: 0.5});
            }
            break;
        }
        case 'lightning': {
            const damp = 1 - Math.min(1, dt * 4);
            this.vx *= damp;
            this.vy *= damp;
            this.x += this.vx * dt;
            this.y += this.vy * dt;
            this.timer -= dt;
            this.boltAge -= dt;
            if (this.timer < 1.2 && this.timer > 0.1) {
                if (this.boltAge <= 0) {
                    this.boltAge = 0.06;
                    const [tx, ty] = this.hammerTip();
                    const sx = tx + rand(-60, 60), pts = [];
                    for (let i = 0; i <= 12; i++) {
                        const f = i / 12;
                        pts.push([sx + (tx - sx) * f + (i && i < 12 ? rand(-14, 14) : 0), ty * f]);
                    }
                    this.bolt = pts;
                    if (Math.random() < 0.5)
                        sparks(this.particles, tx, ty, 2, [0.7, 0.9, 1]);
                    // anyone close gets a jolt
                    for (const o of this.others()) {
                        const [ox, oy] = o.center();
                        if (Math.hypot(ox - tx, oy - ty) < 110)
                            o.knock(Math.sign(ox - tx || 1) * 200, -460);
                    }
                }
            } else {
                this.bolt = null;
            }
            if (this.timer <= 0) {
                this.bolt = null;
                if (this.y < stand - 5) {
                    this.state = 'fly';
                    this.newTarget();
                } else {
                    this.decide();
                }
            }
            break;
        }
        case 'throw':
            this.y = stand;
            this.timer -= dt;
            if (!this.thrown && this.timer < 0.16)
                this.throwHammer();
            if (this.timer <= 0)
                this.state = 'wait';
            break;
        case 'wait':
            this.y = stand;
            if (this.hammer && Math.abs(this.hammer.x - this.x) > 10)
                this.dir = Math.sign(this.hammer.x - this.x);
            if (this.hasHammer) {
                this.state = 'catch';
                this.timer = 0.35;
            }
            break;
        case 'catch':
            this.y = stand;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        const sp = Math.hypot(this.vx, this.vy);
        switch (this.state) {
        case 'fly':
        case 'descend':
            if (sp > 200 || this.spin > 0)
                return {na: [Math.PI, 0], fa: [-0.3, 0.2], nl: [0.1, -0.1], fl: [-0.1, 0]};
            return {na: [2.6, 0.2], fa: [-0.4, 0.3], nl: [0.1, -0.2], fl: [-0.1, -0.1]};
        case 'lightning':
            return {na: [Math.PI, 0], fa: [-0.5, 0.4], nl: [0.3, -0.1], fl: [-0.3, 0]};
        case 'spinup':
            return {na: [2.3, 0.4], fa: [-0.4, 0.3], nl: [0.3, -0.1], fl: [-0.3, 0]};
        case 'throw':
            if (this.timer > 0.16)
                return {na: [-2.2, 0.8], fa: [0.9, 0.3], nl: [0.4, -0.2], fl: [-0.4, 0]};
            return {na: [1.7, 0], fa: [-0.6, 0.3], nl: [0.4, -0.2], fl: [-0.4, 0]};
        case 'wait':
        case 'catch':
            return {na: [1.3, -0.5], fa: [-0.3, 0.3], nl: [0.25, -0.1], fl: [-0.25, 0]};
        default:
            return super.pose();
        }
    }

    extraPoints() {
        const pts = [];
        if (this.hammer)
            pts.push([this.hammer.x, this.hammer.y, 20]);
        if (this.bolt) {
            for (const [x, y] of this.bolt)
                pts.push([x, y, 20]);
        }
        return pts;
    }

    paintFront(cr) {
        if (this.hammer) {
            cr.save();
            cr.translate(this.hammer.x, this.hammer.y);
            cr.rotate(this.hammer.spin);
            cr.translate(0, -7 * this.k);
            drawHammer(cr, this.k);
            cr.restore();
        }
        if (this.bolt) {
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            for (const [w, c, a] of [[9, [0.5, 0.7, 1], 0.25], [4, [0.7, 0.85, 1], 0.6], [1.8, WHITE, 1]]) {
                rgb(cr, c, a);
                cr.setLineWidth(w);
                cr.moveTo(...this.bolt[0]);
                for (const p of this.bolt.slice(1))
                    cr.lineTo(...p);
                cr.stroke();
            }
        }
    }
}

// ---- Black Widow ----
class Widow extends Hero {
    constructor(world) {
        super(world, WIDOW);
    }

    quips() {
        return ['Let me handle this.', 'Nice try.', 'Stay sharp, boys.', 'I\'ve got red in my ledger.'];
    }

    ouch() {
        return ['Seriously?', 'Watch it.', 'Ow!', 'Bad idea.'];
    }

    decide() {
        const r = Math.random();
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.3) {
            this.state = 'run';
            this.dir = pick([-1, 1]);
            this.timer = rand(1.5, 3);
        } else if (r < 0.5) {
            this.jumpTo(rand(120, 220), rand(600, 720), 2 * Math.PI);
        } else if (r < 0.65) {
            this.startSlide();
        } else if (r < 0.8) {
            this.state = 'bite';
            this.timer = 1;
        } else if (r < 0.9) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    startSlide() {
        if (this.x < this.W * 0.2)
            this.dir = 1;
        else if (this.x > this.W * 0.8)
            this.dir = -1;
        this.state = 'slide';
        this.vx = this.dir * 430;
    }

    onClick() {
        if (this.grounded) {
            this.say(pick(['Hup!', 'Too slow.', 'Nice try.']), 1.8);
            this.jumpTo(rand(80, 160), 640, 2 * Math.PI);
        }
    }

    menu() {
        return [
            ['Flip', () => this.grounded && this.jumpTo(140, 640, 2 * Math.PI)],
            ['Widow\'s bite', () => {
                if (this.grounded) {
                    this.state = 'bite';
                    this.timer = 1;
                }
            }],
            ['Slide', () => this.grounded && this.startSlide()],
        ];
    }

    behave(dt) {
        switch (this.state) {
        case 'run':
            this.groundWalk(dt, 220, 3);
            this.targetRot = 0.25 * this.dir;
            break;
        case 'slide':
            this.y = this.floor - 6 * this.k;
            this.x += this.vx * dt;
            this.vx -= Math.sign(this.vx) * 600 * dt;
            this.targetRot = -0.5 * this.dir;
            if (Math.random() < dt * 25)
                dust(this.particles, this.x, this.floor, 1, 0.6);
            {
                // slide-tackle anyone in the way
                const o = this.hitTest(this.x, this.floor - 10, 10);
                if (o)
                    o.knock(this.dir * 220, -480);
            }
            if (Math.abs(this.vx) < 40 || this.x < this.margin || this.x > this.W - this.margin) {
                this.x = clampv(this.x, this.margin, this.W - this.margin);
                this.land(0.3);
            }
            break;
        case 'bite':
            this.y = this.floor - this.standH;
            this.timer -= dt;
            if (Math.random() < dt * 30) {
                const [hx, hy] = this.limbPos(Math.random() < 0.5 ? 'na' : 'fa');
                spawn(this.particles, 'zap', hx, hy, {vx: 0, vy: 0, life: 0.15});
            }
            for (const o of this.others()) {
                const [ox, oy] = o.center();
                const [hx, hy] = this.limbPos('na');
                if (Math.hypot(ox - hx, oy - hy) < 30)
                    o.knock(this.dir * 240, -420);
            }
            if (this.timer <= 0)
                this.decide();
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        switch (this.state) {
        case 'slide':
            return {na: [-0.9, 0.4], fa: [-0.6, 0.5], nl: [1.55, 0.05], fl: [0.9, -1.9]};
        case 'bite':
            return {na: [1.5, 0], fa: [1.3, 0.2], nl: [0.45, -0.3], fl: [-0.45, -0.1]};
        default:
            return super.pose();
        }
    }
}

// ---- Hawkeye ----
class Hawkeye extends Hero {
    constructor(world) {
        super(world, HAWKEYE);
        this.arrows = [];
        this.up = 0.2;
    }

    quips() {
        return ['I never miss.', 'Just a guy with a bow.', 'Eyes on target.', 'Nice shot. Mine, obviously.'];
    }

    ouch() {
        return ['Hey!', 'I saw that coming. Mostly.', 'Ow!'];
    }

    decide() {
        const r = Math.random();
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.45) {
            this.startAim(0.75);
        } else if (r < 0.75) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    startAim(time) {
        const target = Math.random() < 0.5 ? pick(this.others()) : null;
        this.aimAt = target;
        if (target)
            this.dir = Math.sign(target.x - this.x) || 1;
        else if (this.x < this.W * 0.2)
            this.dir = 1;
        else if (this.x > this.W * 0.8)
            this.dir = -1;
        this.up = rand(0.05, 0.55);
        this.state = 'aim';
        this.timer = time;
    }

    shoot() {
        const [bx, by] = this.limbPos('fa');
        let up = this.up, v = 1000;
        if (this.aimAt) {
            // aim straight at the target, a touch high for the drop
            const [ox, oy] = this.aimAt.center();
            up = Math.atan2(by - oy, Math.abs(ox - bx)) + 0.06;
        }
        this.arrows.push({x: bx, y: by, vx: this.dir * Math.cos(up) * v, vy: -Math.sin(up) * v,
            stuck: false, life: 4, boom: Math.random() < 0.25});
        if (this.arrows.length > 8)
            this.arrows.shift();
        this.state = 'recover';
        this.timer = 0.35;
    }

    updateArrows(dt) {
        for (const a of this.arrows) {
            if (a.stuck) {
                a.life -= dt;
                continue;
            }
            a.vy += G * 0.45 * dt;
            a.x += a.vx * dt;
            a.y += a.vy * dt;
            const o = this.hitTest(a.x, a.y, 4);
            const out = a.x < 2 || a.x > this.W - 2 || a.y < 2 || a.y > this.floor - 2;
            if (o || out) {
                a.x = clampv(a.x, 2, this.W - 2);
                a.y = clampv(a.y, 2, this.floor - 2);
                if (a.boom) {
                    this.explode(a.x, a.y, 110);
                    a.life = 0;
                    a.stuck = true;
                } else if (o) {
                    o.knock(Math.sign(a.vx) * 200, -380);
                    a.life = 0;
                    a.stuck = true;
                } else {
                    a.stuck = true;
                }
            }
        }
        this.arrows = this.arrows.filter(a => !a.stuck || a.life > 0);
    }

    onKnocked() {
        if (this.state === 'aim')
            this.state = 'fall';
        super.onKnocked();
    }

    onClick() {
        if (this.grounded) {
            this.say(pick(['I never miss.', 'Watch this.', 'Bullseye!']), 1.8);
            this.startAim(0.3);
        }
    }

    menu() {
        return [
            ['Shoot an arrow', () => this.grounded && this.startAim(0.5)],
        ];
    }

    behave(dt) {
        this.updateArrows(dt);
        switch (this.state) {
        case 'aim':
            this.y = this.floor - this.standH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.shoot();
            break;
        case 'recover':
            this.y = this.floor - this.standH;
            this.timer -= dt;
            if (this.timer <= 0)
                this.decide();
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        switch (this.state) {
        case 'aim': {
            const arm = Math.atan2(Math.cos(this.up), -Math.sin(this.up));
            return {fa: [arm, 0], na: [arm + Math.PI, -Math.PI + 0.25], nl: [0.35, -0.1], fl: [-0.35, 0]};
        }
        case 'recover':
            return {fa: [Math.PI / 2, 0], na: [0.3, 0.4], nl: [0.35, -0.1], fl: [-0.35, 0]};
        default:
            return super.pose();
        }
    }

    extraPoints() {
        return this.arrows.map(a => [a.x, a.y, 20]);
    }

    paintFront(cr) {
        for (const a of this.arrows) {
            const ang = a.stuck ? a.ang ?? 0 : Math.atan2(a.vy, a.vx);
            a.ang = ang;
            const alpha = a.stuck ? Math.min(1, a.life) : 1;
            cr.save();
            cr.translate(a.x, a.y);
            cr.rotate(ang);
            cr.setLineCap(Cairo.LineCap.ROUND);
            rgb(cr, INK, alpha);
            cr.setLineWidth(2.4);
            line(cr, -20, 0, 0, 0);
            cr.stroke();
            rgb(cr, BROWN, alpha);
            cr.setLineWidth(1.2);
            line(cr, -20, 0, 0, 0);
            cr.stroke();
            poly(cr, [[0, -2.5], [5, 0], [0, 2.5]]);
            rgb(cr, a.boom ? [1, 0.5, 0.1] : SILVER, alpha);
            cr.fill();
            poly(cr, [[-20, 0], [-16, -3], [-14, 0]]);
            poly(cr, [[-20, 0], [-16, 3], [-14, 0]]);
            rgb(cr, HAWK_PURPLE, alpha);
            cr.fill();
            cr.restore();
        }
    }
}

// ---- Mochi, the original pocket pet ----
class Mochi extends Hero {
    constructor(world) {
        super(world, {scale: 1});
        this.m = 0.48; // Mochi artwork scale; x, y is the point between its feet
        this.squish = 0;
    }

    quips() {
        return ['Hi!', 'Mochi wants pats.', '*happy wiggle*', 'Hehe!'];
    }

    ouch() {
        return ['Eep!', 'Waah!', 'Mochi is OK!'];
    }

    get standH() {
        return 0;
    }

    get crouchH() {
        return 0;
    }

    get grounded() {
        return ['idle', 'walk', 'land', 'chat', 'sleep'].includes(this.state);
    }

    center() {
        return [this.x, this.y - 85 * this.m];
    }

    hit(px, py) {
        const [cx, cy] = this.center();
        return Math.abs(px - cx) < 85 * this.m && Math.abs(py - cy) < 80 * this.m;
    }

    get k() {
        return 1.3;
    }

    set k(_v) {}

    decide() {
        const r = Math.random();
        if (this.paused || r < 0.3) {
            this.state = 'idle';
            this.timer = rand(2, 5);
        } else if (r < 0.65) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 6);
        } else if (r < 0.85) {
            this.jumpTo(rand(40, 90), rand(300, 420));
        } else {
            this.state = 'sleep';
            this.timer = rand(8, 15);
        }
    }

    onClick() {
        if (this.state === 'sleep')
            this.say('*yawn* Hi!', 1.8);
        else
            this.say(pick(['Purr…', 'Hehe!', '♥', 'More pats please.']), 1.8);
        this.squish = 1;
        for (let i = 0; i < 3; i++)
            spawn(this.particles, 'heart', this.x + rand(-20, 20), this.y - 60, {vy: rand(-70, -40)});
        if (this.state === 'sleep') {
            this.state = 'idle';
            this.timer = 2;
        }
    }

    startChat(other, text, delay) {
        super.startChat(other, text, delay);
        for (let i = 0; i < 3; i++)
            spawn(this.particles, 'heart', this.x + rand(-20, 20), this.y - 60, {vy: rand(-70, -40)});
    }

    behave(dt) {
        this.squish = Math.max(0, this.squish - dt * 3);
        switch (this.state) {
        case 'walk':
            this.groundWalk(dt, 35, 0);
            this.y = this.floor;
            break;
        case 'sleep':
            this.y = this.floor;
            this.timer -= dt;
            if (this.timer <= 0) {
                this.say('Good morning!', 2);
                this.decide();
            }
            break;
        case 'fall':
            if (this.ballistic(dt)) {
                this.squish = 1;
                this.land(0.3);
            }
            break;
        default:
            super.behave(dt);
            this.y = this.state === 'fall' ? this.y : this.floor;
        }
    }

    box() {
        const b = super.box();
        return [b[0] - 30, b[1] - 30, b[2] + 30, b[3] + 20];
    }

    paintBody(cr) {
        const s = this.state;
        const asleep = s === 'sleep';
        const walking = s === 'walk';
        const held = s === 'drag' || s === 'fall';
        const bob = walking ? -Math.abs(Math.sin(this.t * 8)) * 6 : asleep ? 0 : Math.sin(this.t * 2.4) * 3;
        const sq = Math.sin(this.squish * Math.PI) * 0.14;
        let sx = 1 + sq, sy = 1 - sq;
        if (held)
            [sx, sy] = [0.94, 1.08];
        cr.save();
        cr.translate(this.x, this.y + bob);
        cr.rotate(this.rot);
        cr.scale(this.m * sx, this.m * sy);
        cr.translate(-200, -273);
        const face = walking || s === 'idle' ? this.dir * 6 : 0;
        const body = [1.0, 0.72, 0.66], shade = [0.95, 0.6, 0.53];
        rgb(cr, shade);
        for (const [x0, qx, x1] of [[150, 138, 172], [250, 262, 228]]) {
            cr.moveTo(x0, 150);
            quadTo(cr, qx, 100, x1, 122);
            cr.closePath();
            cr.fill();
        }
        const step = walking ? Math.sin(this.t * 8) * 5 : 0;
        ell(cr, 170, 266 - Math.max(step, 0), 16, 7);
        cr.fill();
        ell(cr, 230, 266 - Math.max(-step, 0), 16, 7);
        cr.fill();
        rgb(cr, body);
        cr.moveTo(200, 115);
        cr.curveTo(265, 115, 285, 175, 280, 215);
        cr.curveTo(276, 252, 245, 268, 200, 268);
        cr.curveTo(155, 268, 124, 252, 120, 215);
        cr.curveTo(115, 175, 135, 115, 200, 115);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.35);
        ell(cr, 200, 225, 48, 32);
        cr.fill();
        cr.setSourceRGBA(1, 0.5, 0.56, 0.45);
        ell(cr, 152 + face / 2, 200, 13, 8);
        cr.fill();
        ell(cr, 248 + face / 2, 200, 13, 8);
        cr.fill();
        const ink = [0.16, 0.14, 0.13];
        rgb(cr, ink);
        cr.setLineWidth(4);
        cr.setLineCap(Cairo.LineCap.ROUND);
        if (asleep) {
            for (const ex of [172, 228]) {
                cr.moveTo(ex - 10, 180);
                quadTo(cr, ex, 188, ex + 10, 180);
                cr.stroke();
            }
        } else {
            const open = held ? 1.25 : this.blink < 0 ? 0.12 : 1;
            for (const ex of [172, 228]) {
                ell(cr, ex + face, 178, 9, 12 * open);
                cr.fill();
                if (open > 0.5) {
                    rgb(cr, WHITE);
                    ell(cr, ex + face + 3, 173, 3.2, 3.2);
                    cr.fill();
                    rgb(cr, ink);
                }
            }
        }
        const mx = face / 2;
        if (held) {
            ell(cr, 200 + mx, 210, 6, 8);
            cr.fill();
        } else if (asleep) {
            cr.moveTo(195, 210);
            quadTo(cr, 200, 214, 205, 210);
            cr.stroke();
        } else {
            cr.moveTo(184 + mx, 202);
            quadTo(cr, 200 + mx, 226, 216 + mx, 202);
            cr.closePath();
            rgb(cr, [0.48, 0.18, 0.18]);
            cr.fillPreserve();
            rgb(cr, ink);
            cr.stroke();
        }
        cr.restore();
        if (asleep) {
            [10, 13, 16].forEach((size, i) => {
                const ph = (this.t / 3 + i / 3) % 1;
                const layout = PangoCairo.create_layout(cr);
                layout.set_font_description(Pango.FontDescription.from_string(`Sans Bold ${size}`));
                layout.set_text(i === 2 ? 'Z' : 'z', -1);
                cr.moveTo(this.x + 40 + ph * 16, this.y - 80 - i * 4 - ph * 40);
                cr.setSourceRGBA(0.35, 0.42, 0.75, Math.sin(ph * Math.PI));
                PangoCairo.show_layout(cr, layout);
            });
        }
    }
}

// ---- Doctor Strange ----
const MAGIC = [1, 0.62, 0.15];

// A glowing spell circle, as used for his shields.
function drawMandala(cr, x, y, r, t, a = 1) {
    cr.save();
    cr.translate(x, y);
    const g = new Cairo.RadialGradient(0, 0, 0, 0, 0, r * 1.3);
    g.addColorStopRGBA(0, 1, 0.7, 0.2, 0.25 * a);
    g.addColorStopRGBA(1, 1, 0.5, 0.1, 0);
    cr.setSource(g);
    cr.arc(0, 0, r * 1.3, 0, 2 * Math.PI);
    cr.fill();
    rgb(cr, MAGIC, 0.95 * a);
    cr.setLineWidth(r * 0.07);
    cr.arc(0, 0, r, 0, 2 * Math.PI);
    cr.stroke();
    cr.arc(0, 0, r * 0.72, 0, 2 * Math.PI);
    cr.stroke();
    cr.rotate(t * 1.5);
    for (const off of [0, Math.PI / 4]) {
        cr.newPath();
        for (let i = 0; i < 4; i++) {
            const ang = off + i * Math.PI / 2;
            const px = Math.cos(ang) * r * 0.72, py = Math.sin(ang) * r * 0.72;
            if (i)
                cr.lineTo(px, py);
            else
                cr.moveTo(px, py);
        }
        cr.closePath();
        cr.stroke();
    }
    cr.setLineWidth(r * 0.05);
    for (let i = 0; i < 16; i++) {
        const ang = -t * 3 + i * Math.PI / 8;
        line(cr, Math.cos(ang) * r * 0.78, Math.sin(ang) * r * 0.78, Math.cos(ang) * r * 0.92, Math.sin(ang) * r * 0.92);
    }
    cr.stroke();
    cr.restore();
}

// A sparking portal ring; flat ones sit on the floor or open in the air.
function drawPortal(cr, p, t) {
    const f = Math.min(1, (p.max - p.life) / 0.25, p.life / 0.25);
    const rx = p.rx * f, ry = p.ry * f;
    if (rx < 1)
        return;
    cr.save();
    cr.translate(p.x, p.y);
    cr.save();
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGBA(0.12, 0.05, 0.1, 0.55);
    cr.fill();
    for (const [w, a] of [[6, 0.3], [2.5, 0.9]]) {
        cr.save();
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        rgb(cr, MAGIC, a);
        cr.setLineWidth(w);
        cr.stroke();
    }
    for (let i = 0; i < 18; i++) {
        const ang = t * 6 + i * Math.PI / 9;
        const px = Math.cos(ang) * rx, py = Math.sin(ang) * ry;
        rgb(cr, [1, 0.85, 0.4], 0.9);
        cr.arc(px + Math.cos(ang) * 3, py + Math.sin(ang) * 3, 1.1, 0, 2 * Math.PI);
        cr.fill();
    }
    cr.restore();
}

// the Eye of Agamotto glows brighter while he's casting
let h_eyeColor = [0.3, 0.75, 0.35];
const ST_BLUE = [0.15, 0.24, 0.42];
const ST_DARK = [0.16, 0.17, 0.24];

const STRANGE = {
    scale: 1, arm: [ST_BLUE, ST_DARK, [0.4, 0.28, 0.2]], leg: [ST_DARK, ST_DARK, BROWN],
    back(cr, h) {
        // the Cloak of Levitation, with its tall collar
        const f = h.capeFlow ?? 0, wv = Math.sin(h.t * 4) * (1 + f);
        cr.moveTo(-4.5, -13.4);
        cr.curveTo(-9, -6, -10 - f * 3 + wv, 4 + f * 3, -8 - f * 2 + wv, 12 + f * 6);
        cr.curveTo(-5 + wv, 13 + f * 6, -1 + wv * 0.5, 11 + f * 6, 2 + wv * 0.6, 12 + f * 6);
        cr.curveTo(2, 2, 3, -6, 4, -13.4);
        cr.closePath();
        fillOutline(cr, CAPE, 0.8);
        cr.moveTo(-6.5, -13);
        cr.curveTo(-12, -18, -12.5, -26, -9.8, -31);
        cr.lineTo(-4, -16);
        cr.lineTo(4, -16);
        cr.lineTo(10.8, -31);
        cr.curveTo(13.5, -25, 12, -17, 6.5, -13);
        cr.closePath();
        fillOutline(cr, [0.62, 0.06, 0.08], 0.8);
    },
    torso(cr) {
        torsoPath(cr);
        fillOutline(cr, ST_BLUE);
        rgb(cr, [0.82, 0.68, 0.45]);
        cr.setLineWidth(0.9);
        line(cr, -4.6, -13, 3.6, -2.5);
        line(cr, 4.6, -13, -3.6, -2.5);
        cr.stroke();
        cr.rectangle(-4.25, -2.2, 8.5, 2.4);
        rgb(cr, [0.62, 0.38, 0.18]);
        cr.fill();
        cr.arc(0, -10.5, 2.1, 0, 2 * Math.PI);
        fillOutline(cr, GOLD, 0.5);
        ell(cr, 0, -10.5, 1.2, 0.7);
        rgb(cr, h_eyeColor);
        cr.fill();
    },
    head(cr, h) {
        headPath(cr);
        fillOutline(cr, SKIN);
        cr.save();
        headPath(cr);
        cr.clip();
        // swept-back dark hair, grey at the temples
        cr.moveTo(-10, -21);
        cr.curveTo(-9, -33, 9, -34, 10, -22);
        cr.curveTo(7, -27, 2, -28, -2, -27);
        cr.curveTo(-6, -26, -8, -24, -10, -17);
        cr.closePath();
        rgb(cr, [0.17, 0.12, 0.1]);
        cr.fill();
        rgb(cr, [0.75, 0.75, 0.75]);
        ell(cr, -8, -22, 1.4, 2.6);
        cr.fill();
        // goatee and moustache
        rgb(cr, [0.17, 0.12, 0.1]);
        cr.moveTo(-1.6, -17.6);
        quadTo(cr, 0.9, -18.6, 3.4, -17.6);
        quadTo(cr, 3, -16.8, 0.9, -17.1);
        quadTo(cr, -1.2, -16.8, -1.6, -17.6);
        cr.fill();
        ell(cr, 0.9, -14, 1.6, 1.8);
        cr.fill();
        cr.restore();
        eyes(cr, h, -20.8, 2.6, 1.05);
        brows(cr, [0.17, 0.12, 0.1], -23.4, 0.5, 0.8);
        mouth(cr, 'flat', -15.9);
        headPath(cr);
        rgb(cr, INK);
        cr.setLineWidth(0.9);
        cr.stroke();
    },
    front(cr, h, P) {
        if (h.state === 'shield') {
            for (const key of ['na', 'fa']) {
                const [, , x2, y2] = P[key];
                drawMandala(cr, x2 + 2.5, y2, key === 'na' ? 10 : 8, h.t * (key === 'na' ? 1 : -1));
            }
        } else if (['portalOut', 'portalIn', 'prank'].includes(h.state)) {
            const [, , x2, y2] = P.na;
            rgb(cr, MAGIC, 0.9);
            for (let i = 0; i < 5; i++) {
                const ang = h.t * 9 + i * 1.25;
                cr.arc(x2 + Math.cos(ang) * 3, y2 + Math.sin(ang) * 3, 0.6, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    },
};
class Strange extends Hero {
    constructor(world) {
        super(world, STRANGE);
        this.portals = [];
        this.vis = 1;
        this.capeFlow = 0;
        this.tx = 0;
        this.ty = 0;
    }

    quips() {
        return ['By the Vishanti!', 'The Sorcerer Supreme is in.', 'Dormammu, I\'ve come to bargain.', 'Time is relative.'];
    }

    ouch() {
        return ['How rude.', 'My cloak!', 'Hmph.'];
    }

    get blocking() {
        return this.state === 'shield';
    }

    get grounded() {
        return ['idle', 'walk', 'land', 'chat'].includes(this.state);
    }

    enter() {
        this.x = rand(this.W * 0.15, this.W * 0.85);
        this.y = rand(120, this.floor * 0.55);
        this.arrive();
        this.say('The Sorcerer Supreme is in.', 2.5);
    }

    newTarget() {
        this.tx = this.paused ? this.x : rand(60, this.W - 60);
        this.ty = this.paused ? this.y : rand(80, this.floor - 140);
    }

    decide() {
        const r = Math.random();
        if (this.paused) {
            this.state = 'idle';
            this.timer = 3;
        } else if (r < 0.4) {
            this.state = 'float';
            this.newTarget();
        } else if (r < 0.55 && this.prankTarget()) {
            this.startPrank();
        } else if (r < 0.7) {
            this.startPortal();
        } else if (r < 0.85) {
            this.state = 'walk';
            this.dir = pick([-1, 1]);
            this.timer = rand(2, 4);
        } else {
            this.state = 'idle';
            this.timer = rand(1.5, 3);
        }
    }

    prankTarget() {
        const ok = this.others().filter(o => o.grounded && o.state !== 'drag');
        return ok.length ? pick(ok) : null;
    }

    startPrank() {
        this.victim = this.prankTarget();
        if (!this.victim)
            return;
        this.dir = Math.sign(this.victim.x - this.x) || this.dir;
        this.state = 'prank';
        this.timer = 1.3;
        this.warped = false;
        this.portals.push({x: this.victim.x, y: this.floor - 2, rx: 24, ry: 6, life: 1.1, max: 1.1});
        this.say(pick(['Going somewhere?', 'Watch your step.', 'Hold still.']), 1.8);
    }

    startPortal() {
        this.state = 'portalOut';
        this.timer = 0.7;
        const [cx, cy] = this.center();
        this.portals.push({x: cx, y: cy, rx: 18, ry: 30, life: 1, max: 1});
    }

    arrive() {
        this.state = 'portalIn';
        this.timer = 0.7;
        this.vis = 0;
        const [cx, cy] = this.center();
        this.portals.push({x: cx, y: cy, rx: 18, ry: 30, life: 1, max: 1});
    }

    knock(vx, vy) {
        if (this.state === 'shield') {
            const [cx, cy] = this.center();
            sparks(this.particles, cx + this.dir * 12, cy, 6, MAGIC);
            return false;
        }
        return super.knock(vx, vy);
    }

    onKnocked() {
        this.vis = 1;
        this.state = 'float';
        this.spin = 2 * Math.PI;
        this.newTarget();
    }

    onRelease(vx, vy) {
        this.vx = vx;
        this.vy = vy;
        this.state = 'float';
        this.newTarget();
    }

    onClick() {
        this.say(pick(['By the Vishanti!', 'Shields up.', 'Behold.']), 1.8);
        this.state = 'shield';
        this.timer = 2;
    }

    menu() {
        return [
            ['Cast a shield', () => {
                this.state = 'shield';
                this.timer = 2.5;
            }],
            ['Open a portal', () => this.startPortal()],
            ['Portal-prank someone', () => this.prankTarget() && this.startPrank()],
            ['Meditate', () => {
                if (this.grounded) {
                    this.state = 'float';
                    this.newTarget();
                } else {
                    this.state = 'meditate';
                    this.timer = 5;
                }
            }],
        ];
    }

    behave(dt) {
        for (const p of this.portals)
            p.life -= dt;
        this.portals = this.portals.filter(p => p.life > 0);
        this.capeFlow = clampv(Math.hypot(this.vx, this.vy) / 300, 0, 1);
        h_eyeColor = ['shield', 'portalOut', 'portalIn', 'prank'].includes(this.state) ? [0.4, 1, 0.45] : [0.3, 0.75, 0.35];
        const airborne = this.y < this.floor - this.standH - 4;
        switch (this.state) {
        case 'float': {
            const d = this.steer(dt, this.tx, this.ty + Math.sin(this.t * 1.6) * 8, 130);
            this.targetRot = clampv(this.vx * 0.001, -0.15, 0.15);
            if (d < 20) {
                const r = Math.random();
                if (this.paused) {
                    this.newTarget();
                } else if (r < 0.25) {
                    this.state = 'meditate';
                    this.timer = rand(3, 6);
                } else if (r < 0.45) {
                    this.startPortal();
                } else if (r < 0.6 && this.prankTarget()) {
                    this.startPrank();
                } else if (r < 0.72) {
                    this.state = 'shield';
                    this.timer = 2;
                } else if (r < 0.85) {
                    this.state = 'descend';
                    this.tx = this.x + rand(-100, 100);
                } else {
                    this.newTarget();
                }
            }
            break;
        }
        case 'descend': {
            const gy = this.floor - this.standH;
            const d = this.steer(dt, clampv(this.tx, 60, this.W - 60), gy, 110);
            if (this.y >= gy - 3 || d < 6)
                this.land(0.3);
            break;
        }
        case 'meditate':
        case 'shield':
        case 'prank': {
            const damp = 1 - Math.min(1, dt * 4);
            this.vx *= damp;
            this.vy *= damp;
            this.x += this.vx * dt;
            if (airborne || this.state === 'meditate')
                this.y += Math.sin(this.t * 1.6) * 0.3;
            this.timer -= dt;
            if (this.state === 'prank' && !this.warped && this.timer < 0.8) {
                this.warped = true;
                const v = this.victim;
                if (v && this.world.heroes.includes(v)) {
                    const nx = rand(80, this.W - 80);
                    this.portals.push({x: nx, y: 30, rx: 24, ry: 6, life: 1, max: 1});
                    v.warp(nx, 40);
                }
            }
            if (this.timer <= 0) {
                if (airborne || this.state === 'meditate') {
                    this.state = 'float';
                    this.newTarget();
                } else {
                    this.decide();
                }
            }
            break;
        }
        case 'portalOut':
            this.timer -= dt;
            this.vis = clampv(this.timer / 0.5, 0, 1);
            if (this.timer <= 0) {
                this.x = rand(60, this.W - 60);
                this.y = rand(100, this.floor - 160);
                this.arrive();
            }
            break;
        case 'portalIn':
            this.timer -= dt;
            this.vis = clampv(1 - (this.timer - 0.1) / 0.5, 0, 1);
            if (this.timer <= 0) {
                this.vis = 1;
                this.state = 'float';
                this.newTarget();
            }
            break;
        default:
            super.behave(dt);
        }
    }

    pose() {
        switch (this.state) {
        case 'float':
        case 'descend':
            return {na: [0.9, 0.6], fa: [-0.5, 0.4], nl: [0.15, -0.35], fl: [-0.1, -0.25]};
        case 'meditate':
            return {na: [1.1, 1.3], fa: [1.0, 1.4], nl: [1.4, -2.6], fl: [1.2, -2.5]};
        case 'shield':
            return {na: [1.5, 0.2], fa: [1.3, 0.3], nl: [0.3, -0.2], fl: [-0.3, -0.1]};
        case 'portalOut':
        case 'portalIn':
            return {na: [1.6 + 0.6 * Math.sin(this.t * 10), 0.5], fa: [-0.4, 0.3], nl: [0.1, -0.2], fl: [-0.1, -0.1]};
        case 'prank':
            return {na: [0.9, 0], fa: [-0.4, 0.3], nl: [0.2, -0.2], fl: [-0.2, -0.1]};
        default:
            return super.pose();
        }
    }

    extraPoints() {
        return this.portals.flatMap(p => [[p.x - p.rx, p.y - p.ry, 10], [p.x + p.rx, p.y + p.ry, 10]]);
    }

    paintBehind(cr) {
        for (const p of this.portals)
            drawPortal(cr, p, this.t);
    }

    paintBody(cr) {
        if (this.vis >= 1) {
            super.paintBody(cr);
            return;
        }
        if (this.vis <= 0)
            return;
        cr.pushGroup();
        super.paintBody(cr);
        cr.popGroupToSource();
        cr.paintWithAlpha(this.vis);
    }
}

const CLASSES = {
    spidey: SpiderMan, ironman: IronMan, cap: Cap, hulk: Hulk,
    thor: Thor, widow: Widow, hawkeye: Hawkeye, strange: Strange, mochi: Mochi,
};

// What two heroes say when they bump into each other: [first, second, first line, reply].
const CHATS = [
    ['spidey', 'ironman', 'Hi Mr. Stark!', 'Kid. We talked about this.'],
    ['ironman', 'cap', 'Nice outfit, Cap. Very vintage.', 'Language, Tony.'],
    ['cap', 'spidey', 'Where are you from, kid?', 'Queens!'],
    ['thor', 'hulk', 'Friend from work!', 'Hulk… happy.'],
    ['ironman', 'thor', 'Point Break!', 'Metal man!'],
    ['widow', 'hawkeye', 'You got my back?', 'Always.'],
    ['widow', 'hulk', 'Hey, big guy.', 'Hulk… calm.'],
    ['hawkeye', 'spidey', 'Nice webs, kid.', 'Nice arrows, Mr. Hawkeye!'],
    ['thor', 'cap', 'Your shield is quite sturdy.', 'Your hammer\'s not bad either.'],
    ['ironman', 'hulk', 'Easy, big guy.', 'Hulk SMASH tin man?'],
    ['hulk', 'spidey', 'Bug man!', 'Spider, actually!'],
    ['cap', 'widow', 'Ready, Nat?', 'Always, Rogers.'],
    ['strange', 'ironman', 'Stark.', 'Nice cape, Doctor.'],
    ['strange', 'spidey', 'Focus, kid.', 'Yes, Doctor Strange!'],
    ['thor', 'strange', 'Wizard!', 'Hello, Thor.'],
    ['strange', 'hulk', 'Hello, big guy.', 'Magic man!'],
    ['strange', 'cap', 'Captain.', 'Doctor. Nice tricks.'],
];

function chatLines(a, b) {
    for (const [x, y, la, lb] of CHATS) {
        if (x === a.id && y === b.id)
            return [a, b, la, lb];
        if (x === b.id && y === a.id)
            return [b, a, la, lb];
    }
    if (b.id === 'mochi')
        return [a, b, 'Aww, hi Mochi!', 'Mochi! ♥'];
    if (a.id === 'mochi')
        return [b, a, 'Aww, hi Mochi!', 'Mochi! ♥'];
    return [a, b, `Hey, ${NAMES[b.id]}!`, `Hey, ${NAMES[a.id]}!`];
}

// Heroes walking past each other stop for a chat, or bump and turn around.
function interact(world) {
    const hs = world.heroes;
    for (let i = 0; i < hs.length; i++) {
        for (let j = i + 1; j < hs.length; j++) {
            const a = hs[i], b = hs[j];
            if (!a.chatty || !b.chatty)
                continue;
            const d = Math.abs(a.x - b.x);
            if (d > 32 * Math.max(a.k, b.k))
                continue;
            if (a.chatCd <= 0 && b.chatCd <= 0 && !a.paused && !b.paused) {
                const [first, second, l1, l2] = chatLines(a, b);
                first.startChat(second, l1, 0);
                second.startChat(first, l2, 1.6);
            } else if (d < 18 * Math.max(a.k, b.k)) {
                if ((a.x - b.x) * a.dir < 0)
                    a.dir *= -1;
                if ((b.x - a.x) * b.dir < 0)
                    b.dir *= -1;
            }
        }
    }
}

// ---- the see-through window the heroes live in ----
class Overlay {
    constructor(app, panelOpener) {
        this.app = app;
        this.openPanel = panelOpener;
        const a = this.workarea();
        this.world = {W: a.width, H: a.height - 1, heroes: []}; // a pixel short so GNOME won't treat it as fullscreen
        const win = this.win = new Gtk.ApplicationWindow({application: app, title: 'Avengers Pets'});
        win.set_default_size(this.world.W, this.world.H);
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
        win.connect('delete-event', () => true);
        win.move(a.x, a.y);
        win.show_all();
        this.shapeKey = '';
        this.updateShape();
        this.lastTick = now();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => this.tick());
    }

    workarea() {
        const display = Gdk.Display.get_default();
        const mon = display.get_primary_monitor() ?? display.get_monitor(0);
        return mon.get_workarea();
    }

    has(id) {
        return this.world.heroes.some(h => h.id === id);
    }

    add(id) {
        if (this.has(id))
            return;
        const h = new CLASSES[id](this.world);
        h.id = id;
        h.enter();
        this.world.heroes.push(h);
    }

    remove(id) {
        const h = this.world.heroes.find(x => x.id === id);
        if (!h)
            return;
        this.queueBox(h.lastBox);
        this.world.heroes = this.world.heroes.filter(x => x !== h);
        if (this.press?.hero === h)
            this.press = null;
    }

    queueBox(b) {
        if (!b)
            return;
        const x0 = Math.floor(b[0]), y0 = Math.floor(b[1]);
        this.win.queue_draw_area(x0, y0, Math.ceil(b[2]) - x0 + 1, Math.ceil(b[3]) - y0 + 1);
    }

    tick() {
        const t = now();
        const dt = Math.min(t - this.lastTick, 0.05);
        this.lastTick = t;
        for (const h of this.world.heroes)
            h.step(dt);
        interact(this.world);
        for (const h of this.world.heroes) {
            const b = h.box();
            this.queueBox(h.lastBox);
            this.queueBox(b);
            h.lastBox = b;
        }
        this.updateShape();
        return GLib.SOURCE_CONTINUE;
    }

    updateShape() {
        // Only the heroes catch clicks; everywhere else passes through to your windows.
        const rects = this.world.heroes.map(h => {
            const [cx, cy] = h.center();
            const r = Math.round(24 * h.k);
            return {x: Math.round(cx / 3) * 3 - r, y: Math.round(cy / 3) * 3 - r, width: 2 * r, height: 2 * r};
        });
        const key = rects.map(r => `${r.x},${r.y}`).join(';');
        if (key === this.shapeKey)
            return;
        this.shapeKey = key;
        const region = new Cairo.Region();
        for (const r of rects)
            region.unionRectangle(r);
        this.win.input_shape_combine_region(region);
    }

    heroAt(x, y) {
        const hs = this.world.heroes;
        for (let i = hs.length - 1; i >= 0; i--) {
            if (hs[i].hit(x, y))
                return hs[i];
        }
        return null;
    }

    onPress(ev) {
        const [, button] = ev.get_button();
        const [, ex, ey] = ev.get_coords();
        const h = this.heroAt(ex, ey);
        if (!h)
            return false;
        if (button === 1) {
            this.press = {hero: h, ex, ey, ox: h.x - ex, oy: h.y - ey, moves: [], dragging: false};
        } else if (button === 3) {
            this.showMenu(h, ev);
        }
        return true;
    }

    onMotion(ev) {
        const p = this.press;
        if (!p)
            return false;
        const [, ex, ey] = ev.get_coords();
        const h = p.hero;
        if (!p.dragging && Math.abs(ex - p.ex) + Math.abs(ey - p.ey) > 5) {
            p.dragging = true;
            h.state = 'drag';
            h.spin = 0;
            h.say('Whoa, easy!', 1.5);
        }
        if (p.dragging) {
            h.x = ex + p.ox;
            h.y = ey + p.oy;
            p.moves.push([now(), h.x, h.y]);
            if (p.moves.length > 5)
                p.moves.shift();
        }
        return true;
    }

    onRelease(ev) {
        const [, button] = ev.get_button();
        const p = this.press;
        if (button !== 1 || !p)
            return false;
        if (p.dragging) {
            let vx = 0, vy = 0;
            if (p.moves.length > 1) {
                const [t0, x0, y0] = p.moves[0], [t1, x1, y1] = p.moves[p.moves.length - 1];
                const dt = Math.max(t1 - t0, 0.01);
                vx = (x1 - x0) / dt;
                vy = (y1 - y0) / dt;
            }
            vx = clampv(vx, -900, 900);
            vy = clampv(vy, -900, 900);
            if (Math.abs(vx) > 30)
                p.hero.dir = Math.sign(vx);
            p.hero.onRelease(vx, vy);
        } else {
            p.hero.onClick();
        }
        this.press = null;
        return true;
    }

    showMenu(h, ev) {
        const m = new Gtk.Menu();
        const add = (label, fn, sensitive = true) => {
            const item = new Gtk.MenuItem({label});
            item.set_sensitive(sensitive);
            item.connect('activate', () => fn());
            m.append(item);
        };
        add(NAMES[h.id], () => {}, false);
        m.append(new Gtk.SeparatorMenuItem());
        for (const [label, fn] of h.menu())
            add(label, fn);
        add(h.paused ? 'Keep moving' : 'Stay put', () => {
            h.paused = !h.paused;
            h.say(h.paused ? 'OK, I\'ll stay here.' : 'Let\'s go!', 2);
        });
        m.append(new Gtk.SeparatorMenuItem());
        add(`Send ${NAMES[h.id]} home`, () => this.onToggle?.(h.id, false));
        add('Choose heroes…', () => this.openPanel());
        add('Put everyone away', () => this.app.quit());
        m.show_all();
        m.popup_at_pointer(ev);
    }

    draw(cr) {
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        for (const h of this.world.heroes)
            h.paint(cr);
        for (const h of this.world.heroes)
            h.paintBubble(cr);
    }
}

// ---- settings ----
function loadSettings() {
    try {
        const [, bytes] = GLib.file_get_contents(SETTINGS_FILE);
        const s = JSON.parse(new TextDecoder().decode(bytes));
        return {first: false, on: (s.on ?? DEFAULT_ON).filter(id => CLASSES[id])};
    } catch {
        return {first: true, on: [...DEFAULT_ON]};
    }
}

function saveSettings(on) {
    try {
        GLib.mkdir_with_parents(DATA_DIR, 0o755);
        GLib.file_set_contents(SETTINGS_FILE, JSON.stringify({on}));
    } catch (e) {
        logError(e, 'avengers-pets: could not save settings');
    }
}

// ---- the panel where you pick who stays ----
class Panel {
    constructor(app, onToggle, isOn) {
        this.onToggle = onToggle;
        const win = this.win = new Gtk.Window({title: 'Avengers Pets'});
        win.set_default_size(620, 0);
        win.set_resizable(false);
        win.set_position(Gtk.WindowPosition.CENTER);
        win.set_keep_above(true);
        win.connect('delete-event', () => {
            win.hide();
            return true;
        });
        app.add_window(win);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14});
        box.set_border_width(18);
        const title = new Gtk.Label({xalign: 0});
        title.set_markup('<span size="x-large" weight="bold">Who\'s hanging around?</span>');
        const sub = new Gtk.Label({xalign: 0, wrap: true, max_width_chars: 70});
        sub.set_text('Switch heroes on or off. Click one on screen for a trick, drag to toss them, or right-click for their moves. Open the app again to bring this window back.');
        sub.get_style_context().add_class('dim-label');
        box.pack_start(title, false, false, 0);
        box.pack_start(sub, false, false, 0);

        const grid = new Gtk.Grid({column_spacing: 10, row_spacing: 10, column_homogeneous: true});
        this.switches = {};
        ORDER.forEach((id, i) => {
            const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            card.set_border_width(6);
            const art = new Gtk.DrawingArea();
            art.set_size_request(130, 130);
            const preview = new CLASSES[id]({W: 130, H: 124, heroes: []});
            preview.id = id;
            preview.x = 65;
            preview.y = 124 - preview.standH;
            preview.blink = 3;
            if (id === 'cap')
                preview.hasShield = true;
            art.connect('draw', (_w, cr) => {
                preview.paintBody(cr);
                cr.$dispose();
                return false;
            });
            const name = new Gtk.Label({label: NAMES[id]});
            name.get_style_context().add_class('heading');
            const sw = new Gtk.Switch({active: isOn(id), halign: Gtk.Align.CENTER});
            sw.connect('notify::active', () => this.onToggle(id, sw.get_active()));
            this.switches[id] = sw;
            card.pack_start(art, false, false, 0);
            card.pack_start(name, false, false, 0);
            card.pack_start(sw, false, false, 0);
            grid.attach(card, i % 5, Math.floor(i / 5), 1, 1);
        });
        box.pack_start(grid, false, false, 0);

        const row = new Gtk.Box({spacing: 8});
        const all = new Gtk.Button({label: 'Everyone'});
        all.connect('clicked', () => ORDER.forEach(id => this.switches[id].set_active(true)));
        const none = new Gtk.Button({label: 'Nobody'});
        none.connect('clicked', () => ORDER.forEach(id => this.switches[id].set_active(false)));
        const quit = new Gtk.Button({label: 'Put everyone away'});
        quit.get_style_context().add_class('destructive-action');
        quit.connect('clicked', () => app.quit());
        const done = new Gtk.Button({label: 'Done'});
        done.get_style_context().add_class('suggested-action');
        done.connect('clicked', () => win.hide());
        row.pack_start(all, false, false, 0);
        row.pack_start(none, false, false, 0);
        row.pack_end(done, false, false, 0);
        row.pack_end(quit, false, false, 0);
        box.pack_start(row, false, false, 0);
        win.add(box);
    }

    sync(id, on) {
        const sw = this.switches[id];
        if (sw && sw.get_active() !== on)
            sw.set_active(on);
    }

    show() {
        this.win.show_all();
        this.win.present();
    }
}

// ---- checks without a display ----
function snapshot(path) {
    const cw = 150, ch = 200, cols = 6;
    const ids = ORDER;
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, cw * cols, ch * ids.length);
    const cr = new Cairo.Context(surf);
    cr.setSourceRGB(0.55, 0.62, 0.72);
    cr.paint();
    const demos = {
        spidey: ['idle', 'walk', 'crawl', 'swing', 'hang', 'fall'],
        ironman: ['idle', 'fly', 'flyfast', 'blast', 'land', 'chat'],
        cap: ['idle', 'run', 'throw', 'wait', 'land', 'chat'],
        hulk: ['idle', 'walk', 'roar', 'chest', 'smash', 'leap'],
        thor: ['idle', 'walk', 'lightning', 'flyfast', 'throw', 'spinup'],
        widow: ['idle', 'run', 'slide', 'bite', 'fall', 'chat'],
        hawkeye: ['idle', 'walk', 'aim', 'recover', 'land', 'chat'],
        strange: ['idle', 'float', 'meditate', 'shield', 'portalIn', 'chat'],
        mochi: ['idle', 'walk', 'sleep', 'fall', 'chat', 'idle'],
    };
    ids.forEach((id, r) => {
        demos[id].forEach((st, c) => {
            const world = {W: cw, H: ch - 8, heroes: []};
            const h = new CLASSES[id](world);
            h.id = id;
            h.t = 0.3;
            h.blink = 3;
            h.state = st;
            h.x = cw / 2;
            h.y = world.H - h.standH;
            if (st === 'flyfast') {
                h.state = 'fly';
                h.vx = 400;
                h.y = 90;
                h.rot = Math.PI / 2;
                if (id === 'ironman')
                    h.thrust = 1;
            }
            if (st === 'fly') {
                h.y = 100;
                h.thrust = 1;
                h.palms = 1;
            }
            if (st === 'blast') {
                h.y = 100;
                h.beam = {a: -0.2, on: true};
                h.thrust = 1;
                const [bx, by] = h.limbPos('na');
                h.beam.x1 = bx;
                h.beam.y1 = by;
                h.beam.x2 = cw;
                h.beam.y2 = by - 15;
            }
            if (['land', 'smash', 'slide'].includes(st))
                h.y = world.H - (st === 'slide' ? 6 * h.k : h.crouchH);
            if (st === 'crawl')
                h.y = world.H - 9 * h.k, h.rot = 0.6;
            if (st === 'fall' || st === 'leap')
                h.y = 90;
            if (st === 'swing')
                h.anchor = {x: 20, y: 5}, h.y = 120, h.rot = 0.3;
            if (st === 'hang')
                h.anchor = {x: cw / 2, y: 5}, h.y = 110, h.rot = Math.PI;
            if (st === 'throw')
                h.timer = 0.1, h.hasShield = false, h.hasHammer = false;
            if (st === 'wait' && id === 'cap')
                h.hasShield = false;
            if (st === 'lightning') {
                h.bolt = [[60, 0], [70, 30], [55, 60], [h.x + 20, 90]];
            }
            if (st === 'aim')
                h.up = 0.25;
            if (id === 'mochi')
                h.y = world.H;
            if (st === 'chat' || (id === 'mochi' && c === 5))
                h.say(c === 5 && id === 'mochi' ? 'Mochi! ♥' : 'Hi!', 2);
            cr.save();
            cr.translate(c * cw, r * ch);
            cr.rectangle(0, 0, cw, ch);
            cr.clip();
            cr.setSourceRGBA(0, 0, 0, 0.25);
            cr.rectangle(0, world.H, cw, 2);
            cr.fill();
            h.paint(cr);
            h.paintBubble(cr);
            cr.restore();
        });
    });
    surf.writeToPNG(path);
}

function simulate(minutes) {
    const world = {W: 1600, H: 900, heroes: []};
    for (const id of ORDER) {
        const h = new CLASSES[id](world);
        h.id = id;
        h.enter();
        world.heroes.push(h);
    }
    const counts = {};
    let bad = 0;
    for (let k = 0; k < minutes * 60 * 30; k++) {
        for (const h of world.heroes)
            h.step(1 / 30);
        interact(world);
        for (const h of world.heroes) {
            const key = `${h.id}:${h.state}`;
            counts[key] = (counts[key] ?? 0) + 1;
            if (!Number.isFinite(h.x) || !Number.isFinite(h.y) || !Number.isFinite(h.rot)) {
                print('NaN', h.id, h.state);
                return;
            }
            if (h.x < -20 || h.x > world.W + 20 || h.y > world.H + 20 || h.y < -120) {
                if (bad++ < 8)
                    print('off screen', h.id, h.state, Math.round(h.x), Math.round(h.y));
            }
        }
    }
    print(JSON.stringify(counts));
    print('off-screen frames', bad);
}

// ---- start ----
if (ARGV[0] === '--snapshot') {
    snapshot(ARGV[1]);
} else if (ARGV[0] === '--simulate') {
    simulate(Number(ARGV[1] ?? 10));
} else {
    // Gtk.Application keeps it to one copy: launching again opens the panel.
    const app = new Gtk.Application({application_id: 'dev.pocketpet.Avengers'});
    let overlay = null, panel = null, settings = null;
    const toggle = (id, on) => {
        if (on)
            overlay.add(id);
        else
            overlay.remove(id);
        panel?.sync(id, on);
        saveSettings(ORDER.filter(x => overlay.has(x)));
    };
    app.connect('activate', () => {
        if (overlay) {
            panel.show();
            return;
        }
        settings = loadSettings();
        overlay = new Overlay(app, () => panel.show());
        overlay.onToggle = toggle;
        for (const id of settings.on)
            overlay.add(id);
        panel = new Panel(app, toggle, id => overlay.has(id));
        if (settings.first)
            panel.show();
        saveSettings(ORDER.filter(x => overlay.has(x)));
    });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
    app.run([System.programInvocationName]);
}
