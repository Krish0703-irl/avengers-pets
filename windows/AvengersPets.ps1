# Avengers Pets for Windows: Spider-Man, Iron Man, Captain America, Hulk, Thor, Black Widow,
# Hawkeye, Doctor Strange and Mochi living on your screen, getting in each other's way.
# Start it with "Start Avengers Pets.bat", or install it with "Install.bat".
# Uses only what ships with Windows 10 and 11.

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AvengersPets
{
    // ---- small helpers and colors ----
    public static class U
    {
        public const double S = 1.6;   // drawing scale: a hero is about 75px tall
        public const double G = 1500;  // gravity, px/s^2
        public static readonly Random Rng = new Random();
        public static double Rand(double a, double b) { return a + Rng.NextDouble() * (b - a); }
        public static T Pick<T>(IList<T> a) { return a[Rng.Next(a.Count)]; }
        public static double Clamp(double v, double lo, double hi) { return Math.Max(lo, Math.Min(hi, v)); }
        public static double Wrap(double a) { return Math.Atan2(Math.Sin(a), Math.Cos(a)); }
        public static int Sign(double v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
        public static double[] Dark(double[] c) { return new[] { c[0] * 0.7, c[1] * 0.7, c[2] * 0.7 }; }
        public static double[][] DarkAll(double[][] cs) { return new[] { Dark(cs[0]), Dark(cs[1]), Dark(cs[2]) }; }

        public static double SegDist(double px, double py, double x1, double y1, double x2, double y2)
        {
            double dx = x2 - x1, dy = y2 - y1;
            double len = dx * dx + dy * dy;
            double t = Clamp(((px - x1) * dx + (py - y1) * dy) / (len == 0 ? 1 : len), 0, 1);
            double qx = x1 + t * dx - px, qy = y1 + t * dy - py;
            return Math.Sqrt(qx * qx + qy * qy);
        }

        // Where a ray from (x, y) at angle a leaves the screen.
        public static void RayToEdge(double x, double y, double a, double W, double H, out double ex, out double ey)
        {
            double dx = Math.Cos(a), dy = Math.Sin(a), t = 1e5;
            if (dx > 0) t = Math.Min(t, (W - x) / dx);
            if (dx < 0) t = Math.Min(t, -x / dx);
            if (dy > 0) t = Math.Min(t, (H - y) / dy);
            if (dy < 0) t = Math.Min(t, -y / dy);
            ex = x + dx * t;
            ey = y + dy * t;
        }

        public static readonly double[] INK = { 0.1, 0.04, 0.06 };
        public static readonly double[] SKIN = { 0.98, 0.8, 0.66 };
        public static readonly double[] RED = { 0.86, 0.1, 0.14 };
        public static readonly double[] BLUE = { 0.13, 0.27, 0.72 };
        public static readonly double[] IM_RED = { 0.74, 0.08, 0.1 };
        public static readonly double[] GOLD = { 0.96, 0.74, 0.22 };
        public static readonly double[] CAP_BLUE = { 0.15, 0.24, 0.58 };
        public static readonly double[] CAP_RED = { 0.78, 0.12, 0.15 };
        public static readonly double[] WHITE = { 1, 1, 1 };
        public static readonly double[] BROWN = { 0.45, 0.27, 0.14 };
        public static readonly double[] GREEN = { 0.4, 0.64, 0.22 };
        public static readonly double[] GREEN_DK = { 0.25, 0.42, 0.13 };
        public static readonly double[] PURPLE = { 0.45, 0.22, 0.58 };
        public static readonly double[] ARMOR = { 0.22, 0.24, 0.3 };
        public static readonly double[] SILVER = { 0.74, 0.77, 0.82 };
        public static readonly double[] CAPE = { 0.74, 0.08, 0.1 };
        public static readonly double[] BLOND = { 0.95, 0.78, 0.35 };
        public static readonly double[] SUIT_BLACK = { 0.14, 0.14, 0.17 };
        public static readonly double[] HAIR_RED = { 0.8, 0.27, 0.12 };
        public static readonly double[] HAIR_BROWN = { 0.3, 0.2, 0.12 };
        public static readonly double[] HAWK_PURPLE = { 0.36, 0.18, 0.48 };
        public static readonly double[] MAGIC = { 1, 0.62, 0.15 };
        public static readonly double[] ST_BLUE = { 0.15, 0.24, 0.42 };
        public static readonly double[] ST_DARK = { 0.16, 0.17, 0.24 };
        public static readonly double[] SPARK = { 1, 0.85, 0.3 };
        public static readonly double[] ZAP = { 0.55, 0.85, 1 };
    }

    // ---- a small path-and-paint canvas over GDI+, so the drawing reads like the Linux version ----
    public class Cv : IDisposable
    {
        public Graphics G;
        class St { public Matrix m; public Color color; public Brush brush; public double lw; public bool round; public GraphicsState gs; }
        Matrix m;
        Color color = Color.Black;
        Brush brush;
        public double LineWidth = 2;
        public bool Round;
        readonly Stack<St> stack = new Stack<St>();
        readonly GraphicsPath path = new GraphicsPath(FillMode.Winding);
        readonly List<IDisposable> trash = new List<IDisposable>();
        PointF cur, start;
        bool hasCur;

        public Cv(Graphics g, double scale)
        {
            G = g;
            m = new Matrix();
            m.Scale((float)scale, (float)scale);
        }

        public Matrix M { get { return m; } }

        public void Dispose()
        {
            foreach (IDisposable d in trash) d.Dispose();
            trash.Clear();
            path.Dispose();
            m.Dispose();
        }

        public void Save()
        {
            stack.Push(new St { m = m.Clone(), color = color, brush = brush, lw = LineWidth, round = Round, gs = G.Save() });
        }

        public void Restore()
        {
            St s = stack.Pop();
            m.Dispose();
            m = s.m;
            color = s.color;
            brush = s.brush;
            LineWidth = s.lw;
            Round = s.round;
            G.Restore(s.gs);
        }

        public void Translate(double x, double y) { m.Translate((float)x, (float)y); }
        public void Rotate(double a) { m.Rotate((float)(a * 180 / Math.PI)); }
        public void Scale(double sx, double sy) { m.Scale((float)sx, (float)sy); }

        PointF T(double x, double y)
        {
            PointF[] p = { new PointF((float)x, (float)y) };
            m.TransformPoints(p);
            return p[0];
        }

        PointF UserCur()
        {
            using (Matrix inv = m.Clone())
            {
                if (!inv.IsInvertible) return cur;
                inv.Invert();
                PointF[] p = { cur };
                inv.TransformPoints(p);
                return p[0];
            }
        }

        public void NewPath()
        {
            path.Reset();
            path.FillMode = FillMode.Winding;
            hasCur = false;
        }

        public void MoveTo(double x, double y)
        {
            path.StartFigure();
            cur = start = T(x, y);
            hasCur = true;
        }

        public void LineTo(double x, double y)
        {
            if (!hasCur) { MoveTo(x, y); return; }
            PointF p = T(x, y);
            path.AddLine(cur, p);
            cur = p;
        }

        public void CurveTo(double x1, double y1, double x2, double y2, double x3, double y3)
        {
            if (!hasCur) MoveTo(x1, y1);
            PointF p = T(x3, y3);
            path.AddBezier(cur, T(x1, y1), T(x2, y2), p);
            cur = p;
        }

        public void QuadTo(double qx, double qy, double x, double y)
        {
            PointF u = UserCur();
            double x0 = u.X, y0 = u.Y;
            CurveTo(x0 + 2.0 / 3 * (qx - x0), y0 + 2.0 / 3 * (qy - y0),
                    x + 2.0 / 3 * (qx - x), y + 2.0 / 3 * (qy - y), x, y);
        }

        public void ClosePath()
        {
            path.CloseFigure();
            cur = start;
        }

        public void Arc(double cx, double cy, double r, double a0, double a1) { ArcImpl(cx, cy, r, a0, a1, false); }
        public void ArcNeg(double cx, double cy, double r, double a0, double a1) { ArcImpl(cx, cy, r, a0, a1, true); }

        void ArcImpl(double cx, double cy, double r, double a0, double a1, bool neg)
        {
            if (!neg) { while (a1 < a0) a1 += 2 * Math.PI; }
            else { while (a1 > a0) a1 -= 2 * Math.PI; }
            int n = Math.Max(4, (int)Math.Ceiling(Math.Abs(a1 - a0) / (2 * Math.PI) * 40));
            PointF prev = T(cx + r * Math.Cos(a0), cy + r * Math.Sin(a0));
            if (hasCur) path.AddLine(cur, prev);
            else { path.StartFigure(); start = prev; hasCur = true; }
            for (int i = 1; i <= n; i++)
            {
                double a = a0 + (a1 - a0) * i / n;
                PointF p = T(cx + r * Math.Cos(a), cy + r * Math.Sin(a));
                path.AddLine(prev, p);
                prev = p;
            }
            cur = prev;
        }

        public void Rect(double x, double y, double w, double h)
        {
            MoveTo(x, y);
            LineTo(x + w, y);
            LineTo(x + w, y + h);
            LineTo(x, y + h);
            ClosePath();
        }

        public void RGB(double[] c, double a = 1)
        {
            brush = null;
            color = Color.FromArgb(B(a), B(c[0]), B(c[1]), B(c[2]));
        }

        static int B(double v) { return (int)U.Clamp(v * 255, 0, 255); }

        public void SetBrush(Brush b) { brush = b; }

        public void Fill() { FillPreserve(); NewPath(); }

        public void FillPreserve()
        {
            if (brush != null) { G.FillPath(brush, path); return; }
            using (SolidBrush b = new SolidBrush(color)) G.FillPath(b, path);
        }

        public void Stroke() { StrokePreserve(); NewPath(); }

        public void StrokePreserve()
        {
            float[] e = m.Elements;
            float w = (float)(LineWidth * Math.Sqrt(Math.Abs(e[0] * e[3] - e[1] * e[2])));
            using (Pen pen = brush != null ? new Pen(brush, w) : new Pen(color, w))
            {
                if (Round)
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                }
                G.DrawPath(pen, path);
            }
        }

        public void Clip()
        {
            G.SetClip(path, CombineMode.Intersect);
            NewPath();
        }

        // stops are {position, r, g, b, alpha}
        public Brush Linear(double x0, double y0, double x1, double y1, double[][] stops)
        {
            PointF p0 = T(x0, y0), p1 = T(x1, y1);
            float dx = p1.X - p0.X, dy = p1.Y - p0.Y;
            if (Math.Abs(dx) + Math.Abs(dy) < 0.01f) { dy = 0.01f; p1 = new PointF(p0.X, p0.Y + dy); }
            // stretch the line so colors pad past both ends, like Cairo does
            const float E = 4;
            PointF q0 = new PointF(p0.X - dx * E, p0.Y - dy * E), q1 = new PointF(p1.X + dx * E, p1.Y + dy * E);
            LinearGradientBrush b = new LinearGradientBrush(q0, q1, Color.Black, Color.White);
            List<Color> cols = new List<Color>();
            List<float> pos = new List<float>();
            cols.Add(StopColor(stops[0]));
            pos.Add(0);
            foreach (double[] s in stops)
            {
                cols.Add(StopColor(s));
                pos.Add((float)((E + s[0]) / (1 + 2 * E)));
            }
            cols.Add(StopColor(stops[stops.Length - 1]));
            pos.Add(1);
            ColorBlend cb = new ColorBlend();
            cb.Colors = cols.ToArray();
            cb.Positions = pos.ToArray();
            b.InterpolationColors = cb;
            trash.Add(b);
            return b;
        }

        public Brush Radial(double cx, double cy, double r, double[][] stops)
        {
            PointF c = T(cx, cy);
            float[] e = m.Elements;
            float rr = (float)(r * Math.Sqrt(Math.Abs(e[0] * e[3] - e[1] * e[2])));
            if (rr < 0.5f) rr = 0.5f;
            GraphicsPath gp = new GraphicsPath();
            gp.AddEllipse(c.X - rr, c.Y - rr, 2 * rr, 2 * rr);
            PathGradientBrush b = new PathGradientBrush(gp);
            b.CenterPoint = c;
            List<Color> cols = new List<Color>();
            List<float> pos = new List<float>();
            for (int i = stops.Length - 1; i >= 0; i--)
            {
                cols.Add(StopColor(stops[i]));
                pos.Add((float)(1 - stops[i][0]));
            }
            if (pos[0] > 0) { cols.Insert(0, cols[0]); pos.Insert(0, 0); }
            if (pos[pos.Count - 1] < 1) { cols.Add(cols[cols.Count - 1]); pos.Add(1); }
            ColorBlend cb = new ColorBlend();
            cb.Colors = cols.ToArray();
            cb.Positions = pos.ToArray();
            b.InterpolationColors = cb;
            trash.Add(b);
            trash.Add(gp);
            return b;
        }

        static Color StopColor(double[] s) { return Color.FromArgb(B(s[4]), B(s[1]), B(s[2]), B(s[3])); }
    }

    // ---- particles ----
    public class Particle
    {
        public string kind;
        public double x, y, vx, vy, g, life, max, size = 3, rot;
        public double[] color = U.WHITE;
        public Particle V(double a, double b) { vx = a; vy = b; return this; }
        public Particle Grav(double v) { g = v; return this; }
        public Particle Life(double l) { life = max = l; return this; }
        public Particle Size(double s) { size = s; return this; }
        public Particle Col(double[] c) { color = c; return this; }
    }

    public class Fx
    {
        public string kind;
        public double x, y, r, life, max;
    }

    public static class Fxs
    {
        public static Particle Spawn(List<Particle> list, string kind, double x, double y)
        {
            Particle p = new Particle { kind = kind, x = x, y = y, vx = U.Rand(-40, 40), vy = U.Rand(-80, -30), rot = U.Rand(0, 6) };
            p.Life(U.Rand(0.5, 1.0));
            list.Add(p);
            if (list.Count > 120) list.RemoveAt(0);
            return p;
        }

        public static void Dust(List<Particle> list, double x, double y, int n, double spread = 1)
        {
            for (int i = 0; i < n; i++)
                Spawn(list, "dust", x + U.Rand(-12, 12) * spread, y - 3)
                    .V(U.Rand(-90, 90) * spread, U.Rand(-50, -10)).Size(U.Rand(3, 6) * spread).Life(U.Rand(0.5, 0.9));
        }

        public static void Sparks(List<Particle> list, double x, double y, int n, double[] color)
        {
            for (int i = 0; i < n; i++)
            {
                double a = U.Rand(0, 2 * Math.PI), sp = U.Rand(80, 220);
                Spawn(list, "spark", x, y).V(Math.Cos(a) * sp, Math.Sin(a) * sp).Life(U.Rand(0.25, 0.5)).Col(color);
            }
        }

        public static void Step(List<Particle> list, double dt)
        {
            foreach (Particle p in list)
            {
                p.life -= dt;
                p.vy += p.g * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.rot += dt * 6;
            }
            list.RemoveAll(delegate (Particle p) { return p.life <= 0; });
        }

        // Particles shrink instead of fading: see-through pixels would turn dark on the
        // window's see-through color.
        public static void Draw(Cv cv, List<Particle> list)
        {
            foreach (Particle p in list)
            {
                double f = Math.Max(0, p.life / p.max);
                cv.NewPath();
                switch (p.kind)
                {
                    case "dust":
                    case "smoke":
                        cv.RGB(p.kind == "dust" ? new[] { 0.82, 0.78, 0.72 } : new[] { 0.45, 0.43, 0.43 });
                        cv.Arc(p.x, p.y, p.size * (0.4 + f), 0, 2 * Math.PI);
                        cv.Fill();
                        break;
                    case "spark":
                        cv.RGB(p.color);
                        cv.LineWidth = 1.6;
                        for (int k = 0; k < 4; k++)
                        {
                            double a = p.rot + k * Math.PI / 2;
                            cv.MoveTo(p.x, p.y);
                            cv.LineTo(p.x + Math.Cos(a) * 4 * f, p.y + Math.Sin(a) * 4 * f);
                        }
                        cv.Stroke();
                        break;
                    case "ember":
                        cv.RGB(new[] { 1, 0.55 + 0.4 * f, 0.15 });
                        cv.Arc(p.x, p.y, p.size * f + 0.6, 0, 2 * Math.PI);
                        cv.Fill();
                        break;
                    case "rock":
                        cv.Save();
                        cv.Translate(p.x, p.y);
                        cv.Rotate(p.rot);
                        cv.RGB(new[] { 0.48, 0.4, 0.33 });
                        double s = p.size * Math.Min(1, f * 2);
                        cv.Rect(-s / 2, -s / 2, s, s);
                        cv.Fill();
                        cv.Restore();
                        break;
                    case "heart":
                        cv.RGB(new[] { 1, 0.42, 0.56 });
                        double hs = 0.5 + 0.5 * f;
                        cv.Arc(p.x - 2.5 * hs, p.y, 3 * hs, Math.PI, 0);
                        cv.Arc(p.x + 2.5 * hs, p.y, 3 * hs, Math.PI, 0);
                        cv.LineTo(p.x, p.y + 7 * hs);
                        cv.ClosePath();
                        cv.Fill();
                        break;
                    case "zap":
                        cv.RGB(U.ZAP);
                        cv.LineWidth = 1.4;
                        double zx = p.x, zy = p.y;
                        cv.MoveTo(zx, zy);
                        for (int k = 0; k < 3; k++)
                        {
                            zx += Math.Cos(p.rot) * 4 + U.Rand(-3, 3);
                            zy += Math.Sin(p.rot) * 4 + U.Rand(-3, 3);
                            cv.LineTo(zx, zy);
                        }
                        cv.Stroke();
                        break;
                }
            }
        }
    }

    public static class Bubble
    {
        static readonly Font font = new Font("Segoe UI", 13f, FontStyle.Bold, GraphicsUnit.Pixel);

        public static void Draw(Cv cv, string msg, double cx, double bottom, double W)
        {
            Graphics g = cv.G;
            Matrix old = g.Transform;
            g.Transform = cv.M;
            SizeF size = g.MeasureString(msg, font, 220);
            float bw = size.Width + 20, bh = size.Height + 10, r = 10;
            float bx = (float)U.Clamp(cx - bw / 2, 4, W - bw - 4);
            float by = (float)Math.Max(4, bottom - bh);
            float tail = (float)U.Clamp(cx, bx + 14, bx + bw - 14);
            using (GraphicsPath p = new GraphicsPath())
            {
                p.AddArc(bx + bw - 2 * r, by, 2 * r, 2 * r, 270, 90);
                p.AddArc(bx + bw - 2 * r, by + bh - 2 * r, 2 * r, 2 * r, 0, 90);
                p.AddLine(tail + 7, by + bh, tail, by + bh + 8);
                p.AddLine(tail, by + bh + 8, tail - 7, by + bh);
                p.AddArc(bx, by + bh - 2 * r, 2 * r, 2 * r, 90, 90);
                p.AddArc(bx, by, 2 * r, 2 * r, 180, 90);
                p.CloseFigure();
                using (Brush b = new SolidBrush(Color.White)) g.FillPath(b, p);
                using (Pen pen = new Pen(Color.FromArgb(26, 10, 15), 1.5f)) g.DrawPath(pen, p);
            }
            using (Brush b = new SolidBrush(Color.FromArgb(26, 10, 15)))
            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = StringAlignment.Center;
                g.DrawString(msg, font, b, new RectangleF(bx + 10, by + 5, size.Width, size.Height + 2), sf);
            }
            g.Transform = old;
            old.Dispose();
        }

        public static void Text(Cv cv, string s, double x, double y, float px, double[] c)
        {
            Graphics g = cv.G;
            Matrix old = g.Transform;
            g.Transform = cv.M;
            using (Font f = new Font("Segoe UI", px, FontStyle.Bold, GraphicsUnit.Pixel))
            using (Brush b = new SolidBrush(Color.FromArgb((int)(c[0] * 255), (int)(c[1] * 255), (int)(c[2] * 255))))
                g.DrawString(s, f, b, (float)x, (float)y);
            g.Transform = old;
            old.Dispose();
        }
    }

    // ---- the shared body rig ----
    // Limb angles are {upper, bend}: 0 points down, +pi/2 points the way the hero faces.
    public class Pose
    {
        public double[] na, fa, nl, fl;
        public static Pose Of(double a, double b, double c, double d, double e, double f, double g, double h)
        {
            return new Pose { na = new[] { a, b }, fa = new[] { c, d }, nl = new[] { e, f }, fl = new[] { g, h } };
        }
        public double[] Get(string key)
        {
            switch (key) { case "na": return na; case "fa": return fa; case "nl": return nl; default: return fl; }
        }
    }

    public class Pts
    {
        public double[] na, fa, nl, fl;
        public double[] Get(string key)
        {
            switch (key) { case "na": return na; case "fa": return fa; case "nl": return nl; default: return fl; }
        }
    }

    public static class Rig
    {
        public static double[] LimbEnd(double ox, double oy, double[] a, double l1, double l2)
        {
            double x1 = ox + l1 * Math.Sin(a[0]), y1 = oy + l1 * Math.Cos(a[0]);
            return new[] { x1, y1, x1 + l2 * Math.Sin(a[0] + a[1]), y1 + l2 * Math.Cos(a[0] + a[1]) };
        }

        public static Pts Points(Pose p)
        {
            return new Pts
            {
                na = LimbEnd(0, -11, p.na, 7, 7), fa = LimbEnd(0, -11, p.fa, 7, 7),
                nl = LimbEnd(0.8, 0, p.nl, 8, 8), fl = LimbEnd(-0.8, 0, p.fl, 8, 8)
            };
        }

        public static void Ell(Cv cv, double cx, double cy, double rx, double ry)
        {
            cv.Save();
            cv.Translate(cx, cy);
            cv.Scale(rx, ry);
            cv.Arc(0, 0, 1, 0, 2 * Math.PI);
            cv.Restore();
        }

        public static void Poly(Cv cv, double[][] pts)
        {
            cv.MoveTo(pts[0][0], pts[0][1]);
            for (int i = 1; i < pts.Length; i++) cv.LineTo(pts[i][0], pts[i][1]);
            cv.ClosePath();
        }

        public static void FillOutline(Cv cv, double[] c, double w = 0.9)
        {
            cv.RGB(c);
            cv.FillPreserve();
            cv.RGB(U.INK);
            cv.LineWidth = w;
            cv.Stroke();
        }

        public static void Line(Cv cv, double x1, double y1, double x2, double y2)
        {
            cv.MoveTo(x1, y1);
            cv.LineTo(x2, y2);
        }

        public static void Star(Cv cv, double cx, double cy, double r, double rot)
        {
            for (int i = 0; i < 10; i++)
            {
                double a = rot - Math.PI / 2 + i * Math.PI / 5;
                double rr = i % 2 == 1 ? r * 0.42 : r;
                double px = cx + Math.Cos(a) * rr, py = cy + Math.Sin(a) * rr;
                if (i > 0) cv.LineTo(px, py); else cv.MoveTo(px, py);
            }
            cv.ClosePath();
        }

        public static void DrawLimb(Cv cv, double ox, double oy, double[] p, double w, double[][] c)
        {
            cv.Round = true;
            cv.RGB(U.INK);
            cv.LineWidth = w + 1.4;
            cv.MoveTo(ox, oy);
            cv.LineTo(p[0], p[1]);
            cv.LineTo(p[2], p[3]);
            cv.Stroke();
            cv.LineWidth = w;
            cv.RGB(c[0]);
            Line(cv, ox, oy, p[0], p[1]);
            cv.Stroke();
            cv.RGB(c[1]);
            Line(cv, p[0], p[1], p[2], p[3]);
            cv.Stroke();
            cv.RGB(c[2]);
            Line(cv, (p[0] + p[2]) / 2, (p[1] + p[3]) / 2, p[2], p[3]);
            cv.Stroke();
        }

        public static void DrawRig(Cv cv, Hero hero, Pose pose)
        {
            Skin sk = hero.skin;
            Pts P = Points(pose);
            cv.Save();
            cv.Translate(hero.x, hero.y);
            cv.Rotate(hero.rot);
            cv.Scale(hero.k * hero.dir, hero.k);
            sk.Back(cv, hero, P, pose);
            DrawLimb(cv, 0, -11, P.fa, sk.armW, U.DarkAll(sk.arm));
            DrawLimb(cv, -0.8, 0, P.fl, sk.legW, U.DarkAll(sk.leg));
            sk.Torso(cv, hero);
            sk.Head(cv, hero);
            DrawLimb(cv, 0.8, 0, P.nl, sk.legW, sk.leg);
            DrawLimb(cv, 0, -11, P.na, sk.armW, sk.arm);
            sk.Front(cv, hero, P, pose);
            cv.Restore();
        }

        public static void TorsoPath(Cv cv, double w = 1)
        {
            Poly(cv, new[] { new[] { -5.2 * w, -13.5 }, new[] { 5.2 * w, -13.5 }, new[] { 4.2 * w, 0.5 }, new[] { -4.2 * w, 0.5 } });
        }

        public static void HeadPath(Cv cv, double rx = 9, double ry = 9.5) { Ell(cv, 0, -21.5, rx, ry); }

        public static void HeadOutline(Cv cv)
        {
            HeadPath(cv);
            cv.RGB(U.INK);
            cv.LineWidth = 0.9;
            cv.Stroke();
        }

        public static void Eyes(Cv cv, Hero hero, double y = -21, double spread = 2.7, double size = 1.15)
        {
            const double look = 0.9;
            for (int s = -1; s <= 1; s += 2)
            {
                double ex = s * spread + look;
                if (hero.blink < 0)
                {
                    cv.RGB(U.INK);
                    cv.LineWidth = 0.8;
                    Line(cv, ex - size, y, ex + size, y);
                    cv.Stroke();
                }
                else
                {
                    cv.RGB(U.INK);
                    Ell(cv, ex, y, size, size * 1.25);
                    cv.Fill();
                    cv.RGB(U.WHITE);
                    Ell(cv, ex + 0.4, y - 0.5, size * 0.35, size * 0.35);
                    cv.Fill();
                }
            }
        }

        public static void Brows(Cv cv, double[] color, double y = -23.6, double tilt = 0, double w = 0.8)
        {
            cv.RGB(color);
            cv.LineWidth = w;
            for (int s = -1; s <= 1; s += 2)
            {
                Line(cv, s * 1.4 + 0.9, y + tilt, s * 4 + 0.9, y - tilt * 0.3);
                cv.Stroke();
            }
        }

        public static void Mouth(Cv cv, string kind, double y = -16.4)
        {
            cv.RGB(U.INK);
            cv.LineWidth = 0.8;
            cv.Round = true;
            if (kind == "smile")
            {
                cv.MoveTo(-1.6 + 0.9, y);
                cv.QuadTo(0.9, y + 1.6, 1.6 + 0.9, y);
                cv.Stroke();
            }
            else if (kind == "smirk")
            {
                cv.MoveTo(-1.2 + 0.9, y + 0.3);
                cv.QuadTo(0.9, y + 0.9, 2.2 + 0.9, y - 0.5);
                cv.Stroke();
            }
            else
            {
                Line(cv, -1.3 + 0.9, y, 1.3 + 0.9, y);
                cv.Stroke();
            }
        }

        public static void DrawShield(Cv cv, double x, double y, double r, double spin)
        {
            cv.Save();
            cv.Translate(x, y);
            cv.NewPath();
            double[] fs = { 1, 0.78, 0.56, 0.36 };
            double[][] cs = { U.CAP_RED, U.WHITE, U.CAP_RED, U.CAP_BLUE };
            for (int i = 0; i < 4; i++)
            {
                cv.Arc(0, 0, r * fs[i], 0, 2 * Math.PI);
                cv.RGB(cs[i]);
                cv.Fill();
            }
            Star(cv, 0, 0, r * 0.33, spin);
            cv.RGB(U.WHITE);
            cv.Fill();
            cv.Arc(0, 0, r, 0, 2 * Math.PI);
            cv.RGB(U.INK);
            cv.LineWidth = r * 0.09;
            cv.Stroke();
            cv.Restore();
        }

        // Mjolnir, drawn with its handle along +y from (0, 0).
        public static void DrawHammer(Cv cv, double s = 1)
        {
            cv.Save();
            cv.Scale(s, s);
            cv.Round = true;
            cv.RGB(U.INK);
            cv.LineWidth = 2.6;
            Line(cv, 0, -1.5, 0, 5);
            cv.Stroke();
            cv.RGB(U.BROWN);
            cv.LineWidth = 1.6;
            Line(cv, 0, -1.5, 0, 5);
            cv.Stroke();
            cv.Rect(-4.2, 5, 8.4, 4.6);
            FillOutline(cv, new[] { 0.62, 0.65, 0.7 }, 0.8);
            cv.RGB(new[] { 0.82, 0.85, 0.9 });
            cv.Rect(-3.4, 5.7, 6.8, 1);
            cv.Fill();
            cv.Restore();
        }

        public static void Flame(Cv cv, double x, double y, double ang, double len, double w = 1.6)
        {
            cv.Save();
            cv.Translate(x, y);
            cv.Rotate(-ang);
            cv.SetBrush(cv.Linear(0, 0, 0, len, new[] {
                new double[] { 0, 1, 1, 1, 1 }, new[] { 0.45, 0.55, 0.9, 1, 1 }, new[] { 1, 0.3, 0.65, 1, 1 } }));
            cv.MoveTo(-w, 0);
            cv.CurveTo(-w, len * 0.5, -0.3, len, 0, len);
            cv.CurveTo(0.3, len, w, len * 0.5, w, 0);
            cv.ClosePath();
            cv.Fill();
            cv.Restore();
        }
    }

    // ---- costumes ----
    public abstract class Skin
    {
        public double scale = 1, armW = 4, legW = 5;
        public double[][] arm, leg;
        public virtual void Back(Cv cv, Hero h, Pts P, Pose pose) { }
        public abstract void Torso(Cv cv, Hero h);
        public abstract void Head(Cv cv, Hero h);
        public virtual void Front(Cv cv, Hero h, Pts P, Pose pose) { }
    }

    public class SpideySkin : Skin
    {
        public SpideySkin() { arm = new[] { U.RED, U.RED, U.RED }; leg = new[] { U.BLUE, U.BLUE, U.RED }; }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.BLUE);
            Rig.Poly(cv, new[] { new[] { -4.9, -13.2 }, new[] { 4.9, -13.2 }, new[] { 3.2, -4.0 }, new[] { 0, -2.2 }, new[] { -3.2, -4.0 } });
            cv.RGB(U.RED);
            cv.Fill();
            cv.Rect(-4.25, -1.6, 8.5, 1.8);
            cv.Fill();
            cv.RGB(U.INK);
            cv.Arc(0, -9, 0.9, 0, 2 * Math.PI);
            cv.Fill();
            cv.LineWidth = 0.5;
            for (int s = -1; s <= 1; s += 2)
            {
                Rig.Line(cv, 0, -9, 2.2 * s, -10.8);
                Rig.Line(cv, 0, -9, 2.2 * s, -7.2);
                Rig.Line(cv, 0, -9, 2.6 * s, -9.4);
            }
            cv.Stroke();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            cv.RGB(U.RED);
            cv.FillPreserve();
            cv.Save();
            cv.Clip();
            cv.RGB(U.INK, 0.55);
            cv.LineWidth = 0.35;
            for (int k = 0; k < 10; k++)
            {
                double a = k * Math.PI / 5;
                Rig.Line(cv, 0, -20, Math.Cos(a) * 12, -20 + Math.Sin(a) * 12);
            }
            cv.Stroke();
            foreach (double r in new[] { 3.5, 6.5 })
            {
                cv.Arc(0, -20, r, 0, 2 * Math.PI);
                cv.Stroke();
            }
            cv.Restore();
            Rig.HeadOutline(cv);
            for (int s = -1; s <= 1; s += 2)
            {
                cv.Save();
                cv.Translate(1 + s * 3.6, -22.3);
                cv.Rotate(s * 0.55);
                cv.Scale(3.1, h.blink < 0 ? 0.5 : 2.2);
                cv.Arc(0, 0, 1, 0, 2 * Math.PI);
                cv.Restore();
                Rig.FillOutline(cv, U.WHITE, 1);
            }
        }
    }

    public class IronSkin : Skin
    {
        public IronSkin() { arm = new[] { U.GOLD, U.IM_RED, U.IM_RED }; leg = new[] { U.GOLD, U.IM_RED, U.IM_RED }; }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.IM_RED);
            Rig.Poly(cv, new[] { new[] { -3.6, -6.0 }, new[] { 3.6, -6.0 }, new[] { 3.0, 0.3 }, new[] { -3.0, 0.3 } });
            cv.RGB(U.GOLD);
            cv.Fill();
            cv.SetBrush(cv.Radial(0, -9.5, 4.2, new[] {
                new double[] { 0, 1, 1, 1, 1 }, new[] { 0.45, 0.6, 0.92, 1, 1 }, new[] { 1, 0.74, 0.08, 0.1, 1 } }));
            cv.Arc(0, -9.5, 4.2, 0, 2 * Math.PI);
            cv.Fill();
            cv.Arc(0, -9.5, 1.8, 0, 2 * Math.PI);
            cv.RGB(U.INK, 0.7);
            cv.LineWidth = 0.4;
            cv.Stroke();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            cv.RGB(U.IM_RED);
            cv.Fill();
            cv.Save();
            Rig.HeadPath(cv);
            cv.Clip();
            cv.MoveTo(-6.6, -27);
            cv.CurveTo(-3, -29.5, 3, -29.5, 6.6, -27);
            cv.LineTo(6.2, -18);
            cv.CurveTo(5, -13, -5, -13, -6.2, -18);
            cv.ClosePath();
            cv.RGB(U.GOLD);
            cv.Fill();
            cv.Restore();
            for (int s = -1; s <= 1; s += 2)
            {
                Rig.Poly(cv, new[] { new[] { s * 5.3 + 0.6, -23.2 }, new[] { s * 1.4 + 0.6, -22.4 }, new[] { s * 1.5 + 0.6, -21.1 }, new[] { s * 5.0 + 0.6, -21.9 } });
                cv.RGB(new[] { 0.6, 0.88, 1 });
                cv.LineWidth = 1.2;
                cv.StrokePreserve();
                cv.RGB(new[] { 0.9, 0.98, 1 });
                cv.Fill();
            }
            cv.RGB(U.INK, 0.5);
            cv.LineWidth = 0.5;
            Rig.Line(cv, -2.2, -16.3, 3.2, -16.3);
            cv.Stroke();
            Rig.HeadOutline(cv);
        }

        public override void Front(Cv cv, Hero h, Pts P, Pose pose)
        {
            if (h.thrust > 0)
            {
                foreach (string key in new[] { "nl", "fl" })
                {
                    double[] e = P.Get(key), a = pose.Get(key);
                    Rig.Flame(cv, e[2], e[3], a[0] + a[1], (5 + U.Rng.NextDouble() * 3) * h.thrust, 1.8);
                }
            }
            if (h.palms > 0)
            {
                foreach (string key in new[] { "na", "fa" })
                {
                    double[] e = P.Get(key), a = pose.Get(key);
                    Rig.Flame(cv, e[2], e[3], a[0] + a[1], (3 + U.Rng.NextDouble() * 2) * h.palms, 1.2);
                }
            }
        }
    }

    public class CapSkin : Skin
    {
        public CapSkin() { arm = new[] { U.CAP_BLUE, U.CAP_BLUE, U.CAP_RED }; leg = new[] { U.CAP_BLUE, U.CAP_BLUE, U.CAP_RED }; }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.CAP_BLUE);
            cv.Save();
            Rig.TorsoPath(cv);
            cv.Clip();
            for (int i = 0; i < 8; i++)
            {
                cv.RGB(i % 2 == 1 ? U.WHITE : U.CAP_RED);
                cv.Rect(-5.6 + i * 1.4, -5.5, 1.4, 4);
                cv.Fill();
            }
            cv.Restore();
            Rig.Star(cv, 0, -9.6, 3.1, 0);
            cv.RGB(U.WHITE);
            cv.Fill();
            cv.RGB(U.BROWN);
            cv.Rect(-4.25, -1.6, 8.5, 1.8);
            cv.Fill();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            cv.RGB(U.CAP_BLUE);
            cv.Fill();
            cv.Save();
            Rig.HeadPath(cv);
            cv.Clip();
            Rig.Ell(cv, 0.8, -18.4, 5.8, 6.4);
            cv.RGB(U.SKIN);
            cv.Fill();
            cv.Restore();
            Rig.Eyes(cv, h, -20.6, 2.5, 1.05);
            Rig.Brows(cv, U.HAIR_BROWN, -22.8, 0.2, 0.6);
            Rig.Mouth(cv, "smile", -16.2);
            cv.RGB(U.WHITE);
            cv.LineWidth = 0.9;
            cv.MoveTo(-0.6, -25.6);
            cv.LineTo(0.9, -29);
            cv.LineTo(2.4, -25.6);
            Rig.Line(cv, -0.1, -26.8, 1.9, -26.8);
            cv.Stroke();
            for (int s = -1; s <= 1; s += 2)
            {
                Rig.Poly(cv, new[] { new[] { s * 6.2 + 0.6, -25.5 }, new[] { s * 9.0 + 0.6, -27.6 }, new[] { s * 8.4 + 0.6, -23.2 } });
                cv.RGB(U.WHITE);
                cv.Fill();
            }
            Rig.HeadOutline(cv);
        }

        public override void Front(Cv cv, Hero h, Pts P, Pose pose)
        {
            if (h.hasShield) Rig.DrawShield(cv, P.na[2] + 1.5, P.na[3] - 1.5, 7.5, 0);
        }
    }

    public class HulkSkin : Skin
    {
        public HulkSkin()
        {
            scale = 1.4; armW = 6.5; legW = 7;
            arm = new[] { U.GREEN, U.GREEN, U.GREEN };
            leg = new[] { U.PURPLE, U.GREEN, U.GREEN };
        }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv, 1.35);
            Rig.FillOutline(cv, U.GREEN);
            cv.RGB(U.GREEN_DK);
            cv.LineWidth = 0.5;
            cv.MoveTo(-5, -9.5);
            cv.QuadTo(-2.5, -7.5, 0, -9.5);
            cv.QuadTo(2.5, -7.5, 5, -9.5);
            Rig.Line(cv, 0, -9.5, 0, -3);
            Rig.Line(cv, -2.2, -6, 2.2, -6);
            cv.Stroke();
            Rig.Poly(cv, new[] { new[] { -5.8, -2.6 }, new[] { 5.8, -2.6 }, new[] { 5.7, 0.6 }, new[] { -5.7, 0.6 } });
            Rig.FillOutline(cv, U.PURPLE, 0.7);
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv, 8.4, 8.6);
            Rig.FillOutline(cv, U.GREEN);
            cv.RGB(new[] { 0.1, 0.1, 0.1 });
            cv.MoveTo(-8.4, -22);
            double[][] tips = { new[] { -8.0, -28 }, new[] { -5.5, -26.5 }, new[] { -4.0, -31 }, new[] { -1.0, -28 }, new[] { 1.0, -31.5 },
                                new[] { 3.0, -28 }, new[] { 5.5, -30.5 }, new[] { 6.5, -27 }, new[] { 8.8, -27.5 }, new[] { 8.4, -22 } };
            foreach (double[] tp in tips) cv.LineTo(tp[0], tp[1]);
            cv.LineTo(6, -25.2);
            cv.LineTo(-6, -25.2);
            cv.ClosePath();
            cv.Fill();
            Rig.Brows(cv, new[] { 0.1, 0.1, 0.1 }, -23.2, 0.9, 1.4);
            bool angry = h.state == "roar" || h.state == "smash" || h.state == "leap";
            for (int s = -1; s <= 1; s += 2)
            {
                cv.RGB(angry ? new[] { 0.2, 0.55, 0.15 } : U.INK);
                Rig.Ell(cv, s * 2.8 + 0.9, -21, 1.1, h.blink < 0 ? 0.2 : 0.9);
                cv.Fill();
            }
            if (angry)
            {
                cv.RGB(new[] { 0.35, 0.08, 0.1 });
                Rig.Ell(cv, 0.9, -16, 3.6, 2.4);
                cv.Fill();
                cv.RGB(U.WHITE);
                cv.Rect(-2.2, -18.1, 6.2, 1);
                cv.Fill();
            }
            else
            {
                cv.RGB(U.INK);
                cv.LineWidth = 0.9;
                cv.MoveTo(-1.6, -15.6);
                cv.QuadTo(0.9, -17, 3.4, -15.6);
                cv.Stroke();
            }
        }
    }

    public class ThorSkin : Skin
    {
        public ThorSkin() { arm = new[] { U.ARMOR, U.SILVER, U.SILVER }; leg = new[] { U.ARMOR, U.ARMOR, new[] { 0.38, 0.32, 0.3 } }; }

        public override void Back(Cv cv, Hero h, Pts P, Pose pose)
        {
            double f = h.capeFlow, wv = Math.Sin(h.t * 7) * (0.6 + f);
            cv.MoveTo(-3.5, -13.4);
            cv.CurveTo(-7, -6, -8 - f * 3 + wv, 3 + f * 3, -6 - f * 2 + wv, 9 + f * 7);
            cv.LineTo(1 + wv * 0.6, 8 + f * 7);
            cv.CurveTo(1, 2, 2.5, -6, 3, -13.4);
            cv.ClosePath();
            Rig.FillOutline(cv, U.CAPE, 0.8);
            Rig.Ell(cv, -2.5, -18.5, 8.6, 10);
            cv.RGB(U.BLOND);
            cv.Fill();
        }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.ARMOR);
            double[][] discs = { new[] { -2.3, -10.5 }, new[] { 2.3, -10.5 }, new[] { -2.2, -7.0 }, new[] { 2.2, -7.0 }, new[] { -2.1, -3.5 }, new[] { 2.1, -3.5 } };
            foreach (double[] d in discs)
            {
                cv.Arc(d[0], d[1], 1.15, 0, 2 * Math.PI);
                Rig.FillOutline(cv, U.SILVER, 0.4);
            }
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            Rig.FillOutline(cv, U.SKIN);
            cv.Save();
            Rig.HeadPath(cv);
            cv.Clip();
            cv.MoveTo(-10, -22);
            cv.CurveTo(-8, -33, 9, -34, 10, -23);
            cv.CurveTo(6, -27, 1, -27.5, -3, -25.5);
            cv.CurveTo(-6, -24, -7, -20, -10, -16);
            cv.ClosePath();
            cv.RGB(U.BLOND);
            cv.Fill();
            cv.MoveTo(-5.5, -17);
            cv.CurveTo(-4, -11, 6, -11, 7, -17);
            cv.CurveTo(4, -15, -2, -15, -5.5, -17);
            cv.Fill();
            cv.Restore();
            Rig.Eyes(cv, h, -20.8, 2.6, 1.05);
            Rig.Brows(cv, new[] { 0.75, 0.55, 0.2 }, -23, 0.2, 0.7);
            Rig.Mouth(cv, "smile", -16.6);
            Rig.HeadOutline(cv);
        }

        public override void Front(Cv cv, Hero h, Pts P, Pose pose)
        {
            if (!h.hasHammer) return;
            cv.Save();
            cv.Translate(P.na[2], P.na[3]);
            cv.Rotate(h.state == "spinup" ? h.t * 22 : -(pose.na[0] + pose.na[1]));
            Rig.DrawHammer(cv);
            cv.Restore();
        }
    }

    public class WidowSkin : Skin
    {
        public WidowSkin() { arm = new[] { U.SUIT_BLACK, U.SUIT_BLACK, new[] { 0.55, 0.57, 0.62 } }; leg = new[] { U.SUIT_BLACK, U.SUIT_BLACK, U.SUIT_BLACK }; }

        public override void Back(Cv cv, Hero h, Pts P, Pose pose)
        {
            cv.MoveTo(-9, -24);
            cv.CurveTo(-11, -16, -9, -10, -5, -9);
            cv.LineTo(3, -12);
            cv.LineTo(4, -22);
            cv.ClosePath();
            cv.RGB(U.HAIR_RED);
            cv.Fill();
        }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.SUIT_BLACK);
            cv.RGB(new[] { 0.5, 0.5, 0.55 });
            cv.LineWidth = 0.4;
            Rig.Line(cv, 0.5, -13.3, 0.5, -2);
            cv.Stroke();
            cv.Rect(-4.25, -1.8, 8.5, 1.9);
            cv.RGB(new[] { 0.6, 0.62, 0.66 });
            cv.Fill();
            Rig.Poly(cv, new[] { new[] { -1.3, -1.9 }, new[] { 1.3, -1.9 }, new[] { 0, -0.85 } });
            Rig.Poly(cv, new[] { new[] { -1.3, 0.2 }, new[] { 1.3, 0.2 }, new[] { 0, -0.85 } });
            cv.RGB(U.RED);
            cv.Fill();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            Rig.FillOutline(cv, U.SKIN);
            cv.Save();
            Rig.HeadPath(cv);
            cv.Clip();
            cv.MoveTo(-10, -18);
            cv.CurveTo(-10, -34, 10, -34, 10, -22);
            cv.CurveTo(6, -27, 0, -26, -4, -23);
            cv.CurveTo(-6, -21, -7, -18, -10, -14);
            cv.ClosePath();
            cv.RGB(U.HAIR_RED);
            cv.Fill();
            cv.Restore();
            Rig.Eyes(cv, h, -20.4, 2.6, 1.1);
            cv.RGB(U.INK);
            cv.LineWidth = 0.5;
            for (int s = -1; s <= 1; s += 2)
            {
                Rig.Line(cv, s * 2.6 + 0.9 + s * 0.9, -21.6, s * 2.6 + 0.9 + s * 1.9, -22.3);
                cv.Stroke();
            }
            cv.RGB(new[] { 0.8, 0.25, 0.3 });
            Rig.Ell(cv, 1, -16.4, 1.3, 0.55);
            cv.Fill();
            Rig.HeadOutline(cv);
        }
    }

    public class HawkSkin : Skin
    {
        public HawkSkin() { arm = new[] { U.HAWK_PURPLE, U.SUIT_BLACK, U.SUIT_BLACK }; leg = new[] { U.SUIT_BLACK, U.SUIT_BLACK, U.HAWK_PURPLE }; }

        public override void Back(Cv cv, Hero h, Pts P, Pose pose)
        {
            cv.Save();
            cv.Translate(-4.5, -11);
            cv.Rotate(0.35);
            cv.Rect(-1.8, -8, 3.6, 11);
            Rig.FillOutline(cv, U.BROWN, 0.6);
            double[] xs = { -1, 0.2, 1.2 };
            double[][] cs = { U.RED, U.WHITE, U.RED };
            for (int i = 0; i < 3; i++)
            {
                Rig.Poly(cv, new[] { new[] { xs[i] - 0.6, -8.0 }, new[] { xs[i] + 0.6, -8.0 }, new[] { xs[i], -11.0 } });
                cv.RGB(cs[i]);
                cv.Fill();
            }
            cv.Restore();
        }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.SUIT_BLACK);
            Rig.Poly(cv, new[] { new[] { -5.1, -13.3 }, new[] { -1.5, -13.3 }, new[] { 0.5, -5.0 }, new[] { 2.5, -13.3 }, new[] { 5.1, -13.3 }, new[] { 4.3, -1.0 }, new[] { -4.3, -1.0 } });
            cv.RGB(U.HAWK_PURPLE);
            cv.Fill();
            cv.RGB(U.BROWN);
            cv.LineWidth = 1;
            Rig.Line(cv, -4.5, -13, 4, -2);
            cv.Stroke();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            Rig.FillOutline(cv, U.SKIN);
            cv.RGB(U.HAIR_BROWN);
            cv.MoveTo(-9, -22);
            double[][] tips = { new[] { -8.0, -28 }, new[] { -6.0, -27 }, new[] { -4.0, -31 }, new[] { -1.5, -28.5 }, new[] { 1.0, -31.5 },
                                new[] { 3.0, -28.5 }, new[] { 5.5, -30.5 }, new[] { 6.5, -27.5 }, new[] { 9.0, -26 }, new[] { 8.8, -23.5 } };
            foreach (double[] tp in tips) cv.LineTo(tp[0], tp[1]);
            cv.LineTo(6, -25.5);
            cv.LineTo(-5, -25.5);
            cv.ClosePath();
            cv.Fill();
            for (int s = -1; s <= 1; s += 2)
            {
                Rig.Ell(cv, s * 2.8 + 0.9, -21, 2.2, 1.3);
                cv.RGB(new[] { 0.3, 0.15, 0.42 });
                cv.Fill();
            }
            cv.RGB(new[] { 0.3, 0.15, 0.42 });
            cv.LineWidth = 0.6;
            Rig.Line(cv, -0.3, -21.2, 2.1, -21.2);
            cv.Stroke();
            Rig.Mouth(cv, "smirk", -16.6);
            Rig.HeadOutline(cv);
        }

        public override void Front(Cv cv, Hero h, Pts P, Pose pose)
        {
            double bx = P.fa[2], by = P.fa[3];
            double a = pose.fa[0] + pose.fa[1];
            // the near hand, seen from the bow's own frame
            double dx = P.na[2] - bx, dy = P.na[3] - by;
            double fx = dx * Math.Cos(a) - dy * Math.Sin(a), fy = dx * Math.Sin(a) + dy * Math.Cos(a);
            bool aiming = h.state == "aim";
            cv.Save();
            cv.Translate(bx, by);
            cv.Rotate(-a);
            cv.Round = true;
            double sx = aiming ? fx : 0, sy = aiming ? Math.Min(fy, -1) : -2;
            cv.RGB(new[] { 0.85, 0.85, 0.85 });
            cv.LineWidth = 0.4;
            cv.MoveTo(-9, -2);
            cv.LineTo(sx, sy);
            cv.LineTo(9, -2);
            cv.Stroke();
            if (aiming)
            {
                cv.RGB(U.BROWN);
                cv.LineWidth = 0.6;
                Rig.Line(cv, sx, sy, 0, 7);
                cv.Stroke();
                Rig.Poly(cv, new[] { new[] { -1.0, 6.5 }, new[] { 1.0, 6.5 }, new[] { 0, 8.6 } });
                cv.RGB(U.SILVER);
                cv.Fill();
            }
            cv.RGB(U.INK);
            cv.LineWidth = 2;
            cv.MoveTo(-9, -2);
            cv.QuadTo(0, 6, 9, -2);
            cv.Stroke();
            cv.RGB(U.HAWK_PURPLE);
            cv.LineWidth = 1.1;
            cv.MoveTo(-9, -2);
            cv.QuadTo(0, 6, 9, -2);
            cv.Stroke();
            cv.Restore();
        }
    }

    public class StrangeSkin : Skin
    {
        public StrangeSkin() { arm = new[] { U.ST_BLUE, U.ST_DARK, new[] { 0.4, 0.28, 0.2 } }; leg = new[] { U.ST_DARK, U.ST_DARK, U.BROWN }; }

        public override void Back(Cv cv, Hero h, Pts P, Pose pose)
        {
            // the Cloak of Levitation, with its tall collar
            double f = h.capeFlow, wv = Math.Sin(h.t * 4) * (1 + f);
            cv.MoveTo(-4.5, -13.4);
            cv.CurveTo(-9, -6, -10 - f * 3 + wv, 4 + f * 3, -8 - f * 2 + wv, 12 + f * 6);
            cv.CurveTo(-5 + wv, 13 + f * 6, -1 + wv * 0.5, 11 + f * 6, 2 + wv * 0.6, 12 + f * 6);
            cv.CurveTo(2, 2, 3, -6, 4, -13.4);
            cv.ClosePath();
            Rig.FillOutline(cv, U.CAPE, 0.8);
            cv.MoveTo(-6.5, -13);
            cv.CurveTo(-12, -18, -12.5, -26, -9.8, -31);
            cv.LineTo(-4, -16);
            cv.LineTo(4, -16);
            cv.LineTo(10.8, -31);
            cv.CurveTo(13.5, -25, 12, -17, 6.5, -13);
            cv.ClosePath();
            Rig.FillOutline(cv, new[] { 0.62, 0.06, 0.08 }, 0.8);
        }

        public override void Torso(Cv cv, Hero h)
        {
            Rig.TorsoPath(cv);
            Rig.FillOutline(cv, U.ST_BLUE);
            cv.RGB(new[] { 0.82, 0.68, 0.45 });
            cv.LineWidth = 0.9;
            Rig.Line(cv, -4.6, -13, 3.6, -2.5);
            Rig.Line(cv, 4.6, -13, -3.6, -2.5);
            cv.Stroke();
            cv.Rect(-4.25, -2.2, 8.5, 2.4);
            cv.RGB(new[] { 0.62, 0.38, 0.18 });
            cv.Fill();
            cv.Arc(0, -10.5, 2.1, 0, 2 * Math.PI);
            Rig.FillOutline(cv, U.GOLD, 0.5);
            Rig.Ell(cv, 0, -10.5, 1.2, 0.7);
            bool casting = h.state == "shield" || h.state == "portalOut" || h.state == "portalIn" || h.state == "prank";
            cv.RGB(casting ? new[] { 0.4, 1, 0.45 } : new[] { 0.3, 0.75, 0.35 });
            cv.Fill();
        }

        public override void Head(Cv cv, Hero h)
        {
            Rig.HeadPath(cv);
            Rig.FillOutline(cv, U.SKIN);
            cv.Save();
            Rig.HeadPath(cv);
            cv.Clip();
            // swept-back dark hair, grey at the temples
            cv.MoveTo(-10, -21);
            cv.CurveTo(-9, -33, 9, -34, 10, -22);
            cv.CurveTo(7, -27, 2, -28, -2, -27);
            cv.CurveTo(-6, -26, -8, -24, -10, -17);
            cv.ClosePath();
            double[] hair = { 0.17, 0.12, 0.1 };
            cv.RGB(hair);
            cv.Fill();
            cv.RGB(new[] { 0.75, 0.75, 0.75 });
            Rig.Ell(cv, -8, -22, 1.4, 2.6);
            cv.Fill();
            // goatee and moustache
            cv.RGB(hair);
            cv.MoveTo(-1.6, -17.6);
            cv.QuadTo(0.9, -18.6, 3.4, -17.6);
            cv.QuadTo(3, -16.8, 0.9, -17.1);
            cv.QuadTo(-1.2, -16.8, -1.6, -17.6);
            cv.Fill();
            Rig.Ell(cv, 0.9, -14, 1.6, 1.8);
            cv.Fill();
            cv.Restore();
            Rig.Eyes(cv, h, -20.8, 2.6, 1.05);
            Rig.Brows(cv, hair, -23.4, 0.5, 0.8);
            Rig.Mouth(cv, "flat", -15.9);
            Rig.HeadOutline(cv);
        }

        public override void Front(Cv cv, Hero h, Pts P, Pose pose)
        {
            if (h.state == "shield")
            {
                Strange.Mandala(cv, P.na[2] + 2.5, P.na[3], 10, h.t);
                Strange.Mandala(cv, P.fa[2] + 2.5, P.fa[3], 8, -h.t);
            }
            else if (h.state == "portalOut" || h.state == "portalIn" || h.state == "prank")
            {
                cv.RGB(U.MAGIC);
                for (int i = 0; i < 5; i++)
                {
                    double ang = h.t * 9 + i * 1.25;
                    cv.Arc(P.na[2] + Math.Cos(ang) * 3, P.na[3] + Math.Sin(ang) * 3, 0.6, 0, 2 * Math.PI);
                    cv.Fill();
                }
            }
        }
    }

    public class NoSkin : Skin
    {
        public override void Torso(Cv cv, Hero h) { }
        public override void Head(Cv cv, Hero h) { }
    }

    public class MenuEntry
    {
        public string Label;
        public Action Act;
        public MenuEntry(string l, Action a) { Label = l; Act = a; }
    }

    public class World
    {
        public double W, H;
        public List<Hero> Heroes = new List<Hero>();
    }

    // ---- what every hero shares ----
    public class Hero
    {
        public static readonly string[] OUCH = { "Ow!", "Hey!", "Watch it!", "Whoa!", "Not cool!" };

        public World world;
        public Skin skin;
        public double k;
        public string id;
        public double x, y, vx, vy, rot, targetRot, spin, t, timer, blink, bubbleTime, nextQuip, knockCd, chatCd;
        public int dir = 1;
        public string state = "idle";
        public string bubble;
        public string laterText;
        public double laterDelay, laterSecs;
        public List<Particle> particles = new List<Particle>();
        public List<Fx> fx = new List<Fx>();
        public bool paused;
        public RectangleF lastBox = RectangleF.Empty;
        public double thrust, palms, capeFlow;
        public bool hasShield, hasHammer;

        public Hero(World w, Skin s)
        {
            world = w;
            skin = s;
            k = U.S * s.scale;
            x = w.W / 2;
            t = U.Rand(0, 10);
            timer = 1;
            blink = U.Rand(1, 5);
            nextQuip = U.Rand(25, 70);
            chatCd = U.Rand(5, 15);
        }

        public double W { get { return world.W; } }
        public double Floor { get { return world.H; } }
        public virtual double StandH { get { return 16.5 * k; } }
        public virtual double CrouchH { get { return 9 * k; } }
        public double Margin { get { return 10 * k; } }
        public virtual bool Grounded { get { return state == "idle" || state == "walk" || state == "run" || state == "land" || state == "chat"; } }
        public virtual bool Chatty { get { return state == "idle" || state == "walk" || state == "run"; } }
        public virtual bool Blocking { get { return false; } }
        public virtual string[] Quips() { return new string[0]; }
        public virtual string[] Ouch() { return OUCH; }

        public void Say(string text, double secs = 3) { bubble = text; bubbleTime = secs; }
        public void SayLater(string text, double delay) { laterText = text; laterDelay = delay; laterSecs = 2.6; }

        public void ToWorld(double lx, double ly, out double wx, out double wy)
        {
            double px = lx * dir * k, py = ly * k;
            wx = x + px * Math.Cos(rot) - py * Math.Sin(rot);
            wy = y + px * Math.Sin(rot) + py * Math.Cos(rot);
        }

        public virtual void Center(out double cx, out double cy) { ToWorld(0, -9, out cx, out cy); }

        public void LimbPos(string key, out double lx, out double ly)
        {
            double[] e = Rig.Points(GetPose()).Get(key);
            ToWorld(e[2], e[3], out lx, out ly);
        }

        public virtual bool Hit(double px, double py)
        {
            double cx, cy;
            Center(out cx, out cy);
            return Math.Abs(px - cx) < 24 * k && Math.Abs(py - cy) < 26 * k;
        }

        // Enter by dropping in from the top of the screen.
        public virtual void Enter()
        {
            x = U.Rand(W * 0.15, W * 0.85);
            y = -40;
            vx = 0;
            vy = 200;
            state = "fall";
        }

        public void Step(double dt)
        {
            t += dt;
            knockCd -= dt;
            chatCd -= dt;
            blink -= dt;
            if (blink < -0.12) blink = U.Rand(2.5, 6);
            if (bubble != null)
            {
                bubbleTime -= dt;
                if (bubbleTime <= 0) bubble = null;
            }
            if (laterText != null)
            {
                laterDelay -= dt;
                if (laterDelay <= 0) { Say(laterText, laterSecs); laterText = null; }
            }
            nextQuip -= dt;
            if (nextQuip <= 0)
            {
                nextQuip = U.Rand(50, 100);
                string[] q = Quips();
                if (bubble == null && !paused && q.Length > 0) Say(U.Pick(q), 3.5);
            }
            Fxs.Step(particles, dt);
            foreach (Fx f in fx) f.life -= dt;
            fx.RemoveAll(delegate (Fx f) { return f.life <= 0; });

            targetRot = 0;
            if (state == "drag") targetRot = Math.Sin(t * 6) * 0.25;
            else Behave(dt);

            if (spin > 0)
            {
                double d = Math.Min(spin, 13 * dt);
                rot += d * dir;
                spin -= d;
            }
            else
            {
                rot += U.Wrap(targetRot - rot) * Math.Min(1, dt * 8);
            }
        }

        public virtual void Decide()
        {
            if (paused || U.Rng.NextDouble() < 0.3)
            {
                state = "idle";
                timer = U.Rand(1.5, 4);
                if (U.Rng.NextDouble() < 0.3) dir = -dir;
            }
            else
            {
                state = "walk";
                dir = U.Rng.Next(2) == 0 ? -1 : 1;
                timer = U.Rand(2, 5);
            }
        }

        public void GroundWalk(double dt, double speed, double bounce = 1.5)
        {
            x += dir * speed * dt;
            if (x < Margin) { x = Margin; dir = 1; }
            else if (x > W - Margin) { x = W - Margin; dir = -1; }
            y = Floor - StandH - Math.Abs(Math.Cos(t * 8)) * bounce;
            timer -= dt;
            if (timer <= 0) Decide();
        }

        // Free fall; returns true on touching the floor.
        public bool Ballistic(double dt, double g = U.G)
        {
            vy += g * dt;
            x += vx * dt;
            y += vy * dt;
            if (x < Margin) { x = Margin; vx = Math.Abs(vx) * 0.4; }
            else if (x > W - Margin) { x = W - Margin; vx = -Math.Abs(vx) * 0.4; }
            if (y < 20 && vy < 0) { y = 20; vy = Math.Abs(vy) * 0.2; }
            if (vy > 0 && y >= Floor - CrouchH)
            {
                y = Floor - CrouchH;
                spin = 0;
                return true;
            }
            return false;
        }

        public void Land(double time = 0.45)
        {
            state = "land";
            timer = time;
            vx = vy = 0;
            y = Floor - CrouchH;
            Fxs.Dust(particles, x, Floor, 4);
        }

        public void JumpTo(double jx, double jy, double sp = 0)
        {
            if (x < W * 0.15) dir = 1;
            else if (x > W * 0.85) dir = -1;
            state = "fall";
            vx = dir * Math.Abs(jx);
            vy = -jy;
            spin = sp;
        }

        // Steer through the air toward a point; returns the distance left.
        public double Steer(double dt, double tx, double ty, double max)
        {
            double dx = tx - x, dy = ty - y, d = Math.Sqrt(dx * dx + dy * dy);
            if (d == 0) d = 1;
            double sp = Math.Min(max, d * 1.8), kk = Math.Min(1, dt * 1.8);
            vx += (dx / d * sp - vx) * kk;
            vy += (dy / d * sp - vy) * kk;
            x += vx * dt;
            y += vy * dt;
            x = U.Clamp(x, Margin, W - Margin);
            y = U.Clamp(y, 30, Floor - StandH);
            if (Math.Abs(vx) > 40) dir = U.Sign(vx);
            return d;
        }

        // Upright when hovering, stretched out along the flight path when going fast.
        public double FlightRot()
        {
            double sp = Math.Sqrt(vx * vx + vy * vy);
            double f = U.Clamp((sp - 140) / 220, 0, 1);
            double fast = Math.Atan2(vx, -vy);
            double slow = U.Clamp(vx * 0.0015, -0.35, 0.35);
            return slow + U.Wrap(fast - slow) * f;
        }

        public virtual void Behave(double dt)
        {
            switch (state)
            {
                case "walk":
                    GroundWalk(dt, 60);
                    break;
                case "land":
                    y = Floor - CrouchH;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                case "fall":
                    if (Ballistic(dt)) Land();
                    break;
                default: // idle, chat
                    y = Floor - StandH;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
            }
        }

        public static readonly Pose TUCK = Pose.Of(1.6, -1.8, 1.4, -1.6, 1.9, -2.4, 1.7, -2.3);
        public static readonly Pose FALL = Pose.Of(2.3, 0.2, -1.2, 0.6, 0.5, -1.3, -0.3, -0.6);
        public static readonly Pose LAND = Pose.Of(0.7, -0.3, -0.7, 0.6, 1.5, -1.9, 0.5, -2.3);
        public Pose Idle() { return Pose.Of(0.3 + 0.06 * Math.Sin(t * 2), 0.45, -0.3, 0.3, 0.12, 0, -0.12, 0); }

        public virtual Pose GetPose()
        {
            switch (state)
            {
                case "walk":
                {
                    double w = Math.Sin(t * 8);
                    return Pose.Of(-0.5 * w, 0.4, 0.5 * w, 0.4, 0.5 * w, -0.3 - 0.3 * Math.Max(0, -w), -0.5 * w, -0.3 - 0.3 * Math.Max(0, w));
                }
                case "run":
                {
                    double w = Math.Sin(t * 13);
                    return Pose.Of(-1.0 * w, 1.2, 1.0 * w, 1.2, 0.9 * w, -0.5 - 0.7 * Math.Max(0, -w), -0.9 * w, -0.5 - 0.7 * Math.Max(0, w));
                }
                case "land":
                    return LAND;
                case "fall":
                    return spin > 0 ? TUCK : FALL;
                case "drag":
                {
                    double f = Math.Sin(t * 14);
                    return Pose.Of(2.6 + 0.5 * f, 0.3, 2.4 - 0.5 * f, 0.3, 0.4 + 0.4 * f, -0.4, -0.3 - 0.4 * f, -0.4);
                }
                case "chat":
                    return Pose.Of(0.9 + 0.3 * Math.Sin(t * 5), 1.2, -0.2, 0.3, 0.12, 0, -0.12, 0);
                default:
                    return Idle();
            }
        }

        // ---- being pushed around by the others ----
        public virtual bool Knock(double kx, double ky)
        {
            if (state == "drag" || knockCd > 0) return false;
            knockCd = 1.5;
            vx = kx;
            vy = ky;
            if (Math.Abs(kx) > 20) dir = -U.Sign(kx); // face whatever hit them
            OnKnocked();
            Say(U.Pick(Ouch()), 1.6);
            return true;
        }

        public virtual void OnKnocked()
        {
            state = "fall";
            spin = U.Rng.NextDouble() < 0.5 ? 2 * Math.PI : 0;
        }

        // Dropped through one of Doctor Strange's portals.
        public void Warp(double wx, double wy)
        {
            if (state == "drag") return;
            x = wx;
            y = wy;
            vx = 0;
            vy = 60;
            knockCd = 0;
            OnKnocked();
            Say(U.Pick(new[] { "Whoa!", "Where am I?!", "Not again!", "Strange!" }), 1.8);
        }

        public virtual void StartChat(Hero other, string text, double delay)
        {
            state = "chat";
            timer = 3.6;
            chatCd = U.Rand(25, 45);
            dir = other.x > x ? 1 : -1;
            y = Floor - StandH;
            if (delay > 0) SayLater(text, delay);
            else Say(text, 2.6);
        }

        public List<Hero> Others() { return world.Heroes.FindAll(delegate (Hero h) { return h != this; }); }

        public virtual void OnClick()
        {
            if (Grounded)
            {
                JumpTo(0, 480, 2 * Math.PI);
                List<string> q = new List<string>(Quips());
                q.Add("Ha!");
                Say(U.Pick(q), 1.8);
            }
        }

        public virtual void OnRelease(double rvx, double rvy)
        {
            vx = rvx;
            vy = rvy;
            state = "fall";
        }

        public virtual List<MenuEntry> Menu() { return new List<MenuEntry>(); }
        public virtual List<double[]> ExtraPoints() { return new List<double[]>(); }

        public virtual RectangleF Box()
        {
            double cx, cy;
            Center(out cx, out cy);
            double pad = 34 * k;
            double x0 = cx - pad, y0 = cy - pad, x1 = cx + pad, y1 = cy + pad;
            List<double[]> pts = ExtraPoints();
            foreach (Particle p in particles) pts.Add(new[] { p.x, p.y, 16 });
            foreach (Fx f in fx)
            {
                pts.Add(new[] { f.x - f.r, f.y - f.r * 0.5, 12 });
                pts.Add(new[] { f.x + f.r, f.y + f.r * 0.3, 12 });
            }
            if (bubble != null)
            {
                pts.Add(new[] { cx - 140, cy - 34 * k - 80, 12 });
                pts.Add(new[] { cx + 140, cy, 12 });
            }
            foreach (double[] p in pts)
            {
                x0 = Math.Min(x0, p[0] - p[2]);
                y0 = Math.Min(y0, p[1] - p[2]);
                x1 = Math.Max(x1, p[0] + p[2]);
                y1 = Math.Max(y1, p[1] + p[2]);
            }
            return new RectangleF((float)x0, (float)y0, (float)(x1 - x0), (float)(y1 - y0));
        }

        public void PaintFx(Cv cv)
        {
            foreach (Fx f in fx)
            {
                double p = 1 - f.life / f.max;
                if (f.kind == "ring")
                {
                    cv.Save();
                    cv.Translate(f.x, f.y);
                    cv.Scale(1, 0.25);
                    cv.Arc(0, 0, Math.Max(1, f.r * p), 0, 2 * Math.PI);
                    cv.Restore();
                    cv.RGB(new[] { 0.85, 0.8, 0.7 });
                    cv.LineWidth = 5 * (1 - p) + 0.5;
                    cv.Stroke();
                }
                else if (f.kind == "boom")
                {
                    double r = f.r * (0.5 + p * 0.7) * (1 - p * 0.6);
                    cv.RGB(new[] { 1, 0.45, 0.08 });
                    cv.Arc(f.x, f.y, r, 0, 2 * Math.PI);
                    cv.Fill();
                    cv.RGB(new[] { 1, 0.85, 0.35 });
                    cv.Arc(f.x, f.y, r * 0.6, 0, 2 * Math.PI);
                    cv.Fill();
                }
            }
        }

        public virtual void PaintBehind(Cv cv) { }
        public virtual void PaintFront(Cv cv) { }
        public virtual void PaintBody(Cv cv) { Rig.DrawRig(cv, this, GetPose()); }

        public void Paint(Cv cv)
        {
            PaintFx(cv);
            PaintBehind(cv);
            PaintBody(cv);
            PaintFront(cv);
            Fxs.Draw(cv, particles);
        }

        public void PaintBubble(Cv cv)
        {
            if (bubble == null) return;
            double cx, cy;
            Center(out cx, out cy);
            Bubble.Draw(cv, bubble, cx, cy - 34 * k, W);
        }

        // Ground shockwave that throws nearby heroes into the air.
        public void Shockwave(double sx, double radius, double power)
        {
            fx.Add(new Fx { kind = "ring", x = sx, y = Floor, r = radius, life = 0.7, max = 0.7 });
            foreach (Hero o in Others())
            {
                double ox, oy;
                o.Center(out ox, out oy);
                double d = Math.Abs(ox - sx);
                if (d < radius && oy > Floor - 140)
                    o.Knock((ox - sx >= 0 ? 1 : -1) * (250 + (radius - d)), -power * (1 - d / radius * 0.5));
            }
        }

        public void Explode(double ex, double ey, double radius)
        {
            fx.Add(new Fx { kind = "boom", x = ex, y = ey, r = radius * 0.6, life = 0.5, max = 0.5 });
            for (int i = 0; i < 8; i++)
                Fxs.Spawn(particles, "smoke", ex + U.Rand(-10, 10), ey + U.Rand(-10, 10)).V(U.Rand(-30, 30), U.Rand(-60, -20)).Size(U.Rand(4, 7)).Life(U.Rand(0.6, 1));
            for (int i = 0; i < 8; i++)
                Fxs.Spawn(particles, "ember", ex, ey).V(U.Rand(-200, 200), U.Rand(-250, 50)).Grav(500).Size(2.5).Life(U.Rand(0.4, 0.8));
            foreach (Hero o in world.Heroes)
            {
                double ox, oy;
                o.Center(out ox, out oy);
                if (Math.Sqrt((ox - ex) * (ox - ex) + (oy - ey) * (oy - ey)) < radius)
                    o.Knock((ox - ex >= 0 ? 1 : -1) * 300, -520);
            }
        }

        // A thrown thing hits the first other hero it touches.
        public Hero HitTest(double hx, double hy, double r)
        {
            foreach (Hero o in Others())
            {
                double ox, oy;
                o.Center(out ox, out oy);
                if (Math.Sqrt((ox - hx) * (ox - hx) + (oy - hy) * (oy - hy)) < r + 16 * o.k) return o;
            }
            return null;
        }
    }

    // ---- Spider-Man ----
    public class SpiderMan : Hero
    {
        class Fade { public double x1, y1, x2, y2, life; }
        int chain;
        bool hasShot, hasAnchor;
        double sx, sy, sp, ax, ay, L, Lt, theta, omega, climbTo;
        readonly List<Fade> fading = new List<Fade>();

        public SpiderMan(World w) : base(w, new SpideySkin()) { }

        public override string[] Quips() { return new[] { "Thwip!", "Just your friendly neighborhood desktop hero.", "My spider-sense is tingling...", "Anyone need a web?", "Hanging around, as usual." }; }
        public override string[] Ouch() { return new[] { "Ow!", "Spider-sense was late!", "Not cool!", "Hey, I was swinging!" }; }
        public override bool Grounded { get { return state == "idle" || state == "crawl" || state == "land" || state == "chat"; } }
        public override bool Chatty { get { return state == "idle" || state == "crawl"; } }

        public override void Enter()
        {
            x = U.Rand(W * 0.2, W * 0.8);
            y = 0;
            StartHang(0);
        }

        public override Pose GetPose()
        {
            double sw = Math.Sin(t * 9);
            switch (state)
            {
                case "crawl":
                    return Pose.Of(1.0 + 0.5 * sw, -0.4, 1.0 - 0.5 * sw, -0.4, 1.2 + 0.4 * sw, -1.7, 1.2 - 0.4 * sw, -1.7);
                case "climb":
                {
                    double c = Math.Sin(t * 7);
                    return Pose.Of(2.5 + 0.35 * c, 0.3, 2.2 - 0.35 * c, 0.4, 1.5 + 0.3 * c, -1.4, 1.2 - 0.3 * c, -1.2);
                }
                case "swing":
                    return Pose.Of(Math.PI, 0, 1.1, 0.9, 0.7, -1.3, 0.25, -0.8);
                case "fly":
                    return spin > 0 ? TUCK : Pose.Of(2.3, 0.2, -1.2, 0.6, 0.5, -1.3, -0.3, -0.6);
                case "hang":
                {
                    double d = Math.Sin(t * 2) * 0.12;
                    return Pose.Of(2.9 + d, 0.3, 3.4 - d, -0.3, 0.06, 0, -0.06, 0);
                }
                default:
                    return base.GetPose();
            }
        }

        void FeetPos(out double fx, out double fy)
        {
            Pts P = Rig.Points(GetPose());
            ToWorld((P.nl[2] + P.fl[2]) / 2, (P.nl[3] + P.fl[3]) / 2, out fx, out fy);
        }

        public override void Decide()
        {
            if (paused) { state = "idle"; timer = 3; return; }
            double r = U.Rng.NextDouble();
            if (r < 0.3)
            {
                state = "crawl";
                dir = U.Rng.Next(2) == 0 ? -1 : 1;
                timer = U.Rand(2, 6);
            }
            else if (r < 0.65) Jump(U.Rng.Next(1, 4), U.Rand(700, 880));
            else if (r < 0.8) StartHang(-1);
            else { state = "idle"; timer = U.Rand(1.5, 4); }
        }

        void Jump(int c, double up)
        {
            if (x < 80) dir = 1;
            else if (x > W - 80) dir = -1;
            state = "fly";
            vx = dir * U.Rand(140, 240);
            vy = -up;
            chain = c;
        }

        bool ShootWeb()
        {
            double ty = U.Rand(4, 50), dy = y - ty;
            double maxL = Floor - 30 * k - ty;
            if (dy <= 0 || dy >= maxL) return false;
            double room = Math.Sqrt(maxL * maxL - dy * dy);
            double tx = U.Clamp(x + dir * Math.Min(U.Rand(140, 340), room), 20, W - 20);
            if (Math.Abs(tx - x) < 50) return false;
            hasShot = true;
            sx = tx; sy = ty; sp = 0;
            return true;
        }

        void Attach()
        {
            hasShot = false;
            hasAnchor = true;
            ax = sx; ay = sy;
            L = Math.Sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay));
            theta = Math.Atan2(x - ax, y - ay);
            omega = (vx * Math.Cos(theta) - vy * Math.Sin(theta)) / L;
            state = "swing";
            timer = 0;
        }

        void Release()
        {
            double hx, hy;
            LimbPos("na", out hx, out hy);
            fading.Add(new Fade { x1 = ax, y1 = ay, x2 = hx, y2 = hy, life = 0.6 });
            vx = L * omega * Math.Cos(theta);
            vy = -L * omega * Math.Sin(theta) - 150;
            hasAnchor = false;
            state = "fly";
            chain--;
            if (chain <= 0 && U.Rng.NextDouble() < 0.5) spin = 2 * Math.PI;
        }

        void StartHang(double startL)
        {
            hasAnchor = true;
            hasShot = false;
            ax = x; ay = 0;
            L = startL >= 0 ? startL : Math.Max(0, y);
            Lt = U.Rand(110, Floor * 0.5);
            theta = 0;
            state = "hang";
            timer = U.Rand(5, 11);
        }

        void StartClimb(int side)
        {
            dir = side;
            state = "climb";
            vx = vy = 0;
            y = Math.Min(y, Floor - StandH);
            climbTo = Math.Min(U.Rand(Floor * 0.3, Floor * 0.7), y - 40);
        }

        public override void OnKnocked()
        {
            hasAnchor = hasShot = false;
            state = "fly";
            chain = 1; // web to safety
            spin = 2 * Math.PI;
        }

        public override void OnRelease(double rvx, double rvy)
        {
            hasAnchor = hasShot = false;
            vx = rvx;
            vy = rvy;
            if (Math.Abs(rvx) > 30) dir = U.Sign(rvx);
            state = "fly";
            chain = 1;
        }

        public override void OnClick()
        {
            Say(U.Pick(new[] { "Thwip!", "Hey there!", "Woo-hoo!", "Spider-flip!" }), 1.8);
            if (Grounded)
            {
                state = "fly";
                vx = 0;
                vy = -480;
                chain = 0;
                spin = 2 * Math.PI;
            }
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Swing around", () => { if (state == "fly" || state == "swing") chain = 3; else Jump(3, U.Rand(700, 880)); }),
                new MenuEntry("Hang from the top", () => StartHang(-1)),
            };
        }

        public override void Behave(double dt)
        {
            foreach (Fade f in fading) f.life -= dt;
            fading.RemoveAll(delegate (Fade f) { return f.life <= 0; });
            double side = 11 * k;
            switch (state)
            {
                case "crawl":
                    y = Floor - 9 * k;
                    x += dir * 95 * dt;
                    targetRot = 0.6 * dir;
                    if (x < side + 4 || x > W - side - 4)
                    {
                        x = U.Clamp(x, side, W - side);
                        StartClimb(x < W / 2 ? -1 : 1);
                        break;
                    }
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;

                case "land":
                    targetRot = 0.3 * dir;
                    base.Behave(dt);
                    break;

                case "climb":
                    x = dir < 0 ? side : W - side;
                    y -= 150 * dt;
                    if (y <= climbTo)
                    {
                        dir = -dir;
                        Jump(U.Rng.Next(1, 4), 250);
                        vx = dir * 260;
                    }
                    break;

                case "fly":
                    vy += U.G * dt;
                    x += vx * dt;
                    y += vy * dt;
                    targetRot = U.Clamp(vx * 0.0012, -0.5, 0.5);
                    if (hasShot)
                    {
                        sp += dt / 0.12;
                        if (sp >= 1) Attach();
                    }
                    else if (chain > 0 && vy > -80 && y < Floor - 150)
                    {
                        if (!ShootWeb()) chain = 0;
                    }
                    if (state != "fly") break;
                    if (y < 20) { y = 20; vy = Math.Abs(vy) * 0.2; }
                    if (x < side || x > W - side)
                    {
                        x = U.Clamp(x, side, W - side);
                        hasShot = false;
                        spin = 0;
                        StartClimb(x < W / 2 ? -1 : 1);
                        break;
                    }
                    if (y >= Floor - 9 * k && vy > 0)
                    {
                        hasShot = false;
                        spin = 0;
                        Land();
                    }
                    break;

                case "swing":
                {
                    omega += (-(U.G / L) * Math.Sin(theta) + dir * 2.0) * dt;
                    theta += omega * dt;
                    x = ax + L * Math.Sin(theta);
                    y = ay + L * Math.Cos(theta);
                    targetRot = -theta;
                    timer += dt;
                    if (x < side || x > W - side)
                    {
                        Release();
                        x = U.Clamp(x, side, W - side);
                        StartClimb(x < W / 2 ? -1 : 1);
                    }
                    else if ((dir * omega > 0 && dir * theta > 0.55) || timer > 3.5 || y > Floor - StandH)
                    {
                        Release();
                    }
                    else
                    {
                        // swinging feet-first into someone knocks them over
                        Hero o = HitTest(x, y, 10 * k);
                        if (o != null && Math.Abs(omega) > 1.2) o.Knock(U.Sign(omega) * 380, -380);
                    }
                    break;
                }

                case "hang":
                {
                    double reel = Lt - L;
                    L += U.Sign(reel) * Math.Min(Math.Abs(reel), (reel < 0 ? 300 : 120) * dt);
                    // sway gently, but never more than about 20px, so a long web can't swing him off screen
                    theta = Math.Sin(t * 1.4) * Math.Min(0.06, 20 / (L + 16 * k));
                    x = ax + (L + 16 * k) * Math.Sin(theta);
                    y = ay + (L + 16 * k) * Math.Cos(theta);
                    targetRot = Math.PI - theta;
                    if (Math.Abs(reel) < 2)
                    {
                        timer -= dt;
                        if (!paused && timer <= 0)
                        {
                            if (U.Rng.NextDouble() < 0.5)
                            {
                                double fx2, fy2;
                                FeetPos(out fx2, out fy2);
                                fading.Add(new Fade { x1 = ax, y1 = ay, x2 = fx2, y2 = fy2, life = 0.5 });
                                hasAnchor = false;
                                state = "fly";
                                vx = dir * 60;
                                vy = 0;
                                chain = 0;
                            }
                            else
                            {
                                dir = x < W / 2 ? 1 : -1;
                                L = Math.Sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay));
                                omega = dir * 2.2;
                                state = "swing";
                                chain = U.Rng.Next(1, 4);
                                timer = 0;
                            }
                        }
                    }
                    break;
                }

                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            if (hasAnchor) pts.Add(new[] { ax, ay, 12 });
            if (hasShot) pts.Add(new[] { sx, sy, 12 });
            foreach (Fade f in fading) { pts.Add(new[] { f.x1, f.y1, 10 }); pts.Add(new[] { f.x2, f.y2, 10 }); }
            return pts;
        }

        static void Web(Cv cv, double x1, double y1, double x2, double y2)
        {
            cv.Round = true;
            cv.RGB(new[] { 0.45, 0.47, 0.52 });
            cv.LineWidth = 3;
            Rig.Line(cv, x1, y1, x2, y2);
            cv.Stroke();
            cv.RGB(U.WHITE);
            cv.LineWidth = 1.5;
            Rig.Line(cv, x1, y1, x2, y2);
            cv.Stroke();
        }

        public override void PaintBehind(Cv cv)
        {
            foreach (Fade f in fading) Web(cv, f.x1, f.y1, f.x2, f.y2);
            double hx, hy;
            LimbPos("na", out hx, out hy);
            if (hasShot)
            {
                double p = Math.Min(1, sp);
                Web(cv, hx, hy, hx + (sx - hx) * p, hy + (sy - hy) * p);
            }
            if (hasAnchor)
            {
                double ex = hx, ey = hy;
                if (state == "hang" && Math.Cos(rot) < 0) FeetPos(out ex, out ey);
                Web(cv, ax, ay, ex, ey);
                cv.RGB(U.WHITE);
                cv.LineWidth = 1.2;
                for (int i = 0; i < 7; i++)
                {
                    double a = i * Math.PI * 2 / 7;
                    Rig.Line(cv, ax, ay, ax + Math.Cos(a) * 7, ay + Math.Sin(a) * 7);
                }
                cv.Stroke();
            }
        }
    }

    // ---- Iron Man ----
    public class IronMan : Hero
    {
        class Beam { public double a, x1, y1, x2, y2; public bool on; }
        double tx, ty;
        Beam beam;

        public IronMan(World w) : base(w, new IronSkin()) { }

        public override string[] Quips() { return new[] { "I am Iron Man.", "JARVIS, run diagnostics.", "Genius, billionaire, desktop pet.", "Suit up!" }; }
        public override string[] Ouch() { return new[] { "Hey! This suit is new!", "Ow!", "Rude.", "JARVIS, who did that?" }; }
        public override bool Chatty { get { return state == "idle" || state == "walk"; } }

        public override void Enter()
        {
            dir = U.Rng.Next(2) == 0 ? -1 : 1;
            x = dir > 0 ? Margin : W - Margin;
            y = U.Rand(80, Floor * 0.5);
            vx = dir * 300;
            state = "fly";
            NewTarget();
        }

        void NewTarget()
        {
            if (paused) { tx = x; ty = y; return; }
            tx = U.Rand(60, W - 60);
            ty = U.Rand(60, Floor - 160);
        }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused || r < 0.25) { state = "idle"; timer = U.Rand(2, 4); }
            else if (r < 0.5) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else Takeoff();
        }

        void Takeoff()
        {
            state = "takeoff";
            timer = 0.7;
            vx = 0;
            vy = -60;
        }

        void StartBlast()
        {
            state = "blast";
            timer = 0.9;
            double a = U.Rand(-0.35, 0.45);
            beam = new Beam { a = dir > 0 ? a : Math.PI - a };
        }

        public override void OnKnocked()
        {
            beam = null;
            state = "fly";
            spin = 2 * Math.PI;
            NewTarget();
        }

        public override void OnRelease(double rvx, double rvy)
        {
            vx = rvx;
            vy = rvy;
            state = "fly";
            NewTarget();
        }

        public override void OnClick()
        {
            Say(U.Pick(new[] { "I am Iron Man.", "Barrel roll!", "Repulsors online." }), 1.8);
            if (Grounded) Takeoff();
            else if (state == "fly") spin = 2 * Math.PI;
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Fire repulsors", () => { if (Grounded) Takeoff(); else StartBlast(); }),
                new MenuEntry("Land", () => { if (!Grounded) { state = "descend"; tx = x; } }),
                new MenuEntry("Take off", () => { if (Grounded) Takeoff(); }),
            };
        }

        public override void Behave(double dt)
        {
            thrust = 0;
            palms = 0;
            switch (state)
            {
                case "fly":
                {
                    double d = Steer(dt, tx, ty + Math.Sin(t * 2) * 6, 380);
                    thrust = 1;
                    palms = Math.Sqrt(vx * vx + vy * vy) < 160 ? 1 : 0;
                    targetRot = FlightRot();
                    if (d < 25)
                    {
                        double r = U.Rng.NextDouble();
                        if (paused) NewTarget();
                        else if (r < 0.25) StartBlast();
                        else if (r < 0.45) { state = "descend"; tx = U.Rand(60, W - 60); }
                        else NewTarget();
                    }
                    break;
                }
                case "descend":
                {
                    double gy = Floor - StandH;
                    double d = Steer(dt, tx, gy, 320);
                    thrust = 1;
                    palms = 1;
                    targetRot = FlightRot();
                    if (y >= gy - 4 || d < 12)
                    {
                        Land(0.9);
                        Fxs.Dust(particles, x, Floor, 6);
                    }
                    break;
                }
                case "takeoff":
                    vy = Math.Max(vy - 1100 * dt, -420);
                    y += vy * dt;
                    thrust = 1;
                    palms = 1;
                    timer -= dt;
                    if (timer <= 0 || y < 80) { state = "fly"; NewTarget(); }
                    break;
                case "blast":
                {
                    double damp = 1 - Math.Min(1, dt * 4);
                    vx *= damp;
                    vy *= damp;
                    x += vx * dt;
                    y += vy * dt;
                    thrust = 1;
                    timer -= dt;
                    beam.on = timer < 0.7 && timer > 0.05;
                    if (beam.on)
                    {
                        double bx, by, ex, ey;
                        LimbPos("na", out bx, out by);
                        U.RayToEdge(bx, by, beam.a, W, Floor, out ex, out ey);
                        beam.x1 = bx; beam.y1 = by; beam.x2 = ex; beam.y2 = ey;
                        foreach (Hero o in Others())
                        {
                            double ox, oy;
                            o.Center(out ox, out oy);
                            if (U.SegDist(ox, oy, bx, by, ex, ey) < 18 * o.k)
                                o.Knock(Math.Cos(beam.a) * 520, Math.Sin(beam.a) * 300 - 380);
                        }
                        if (U.Rng.NextDouble() < dt * 30) Fxs.Sparks(particles, ex, ey, 2, new[] { 0.6, 0.9, 1 });
                    }
                    if (timer <= 0) { beam = null; state = "fly"; NewTarget(); }
                    break;
                }
                case "walk":
                    GroundWalk(dt, 55);
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            double sp = Math.Sqrt(vx * vx + vy * vy);
            switch (state)
            {
                case "fly":
                    if (spin > 0 || sp > 200) return Pose.Of(-0.35, 0, -0.45, 0, 0.05, 0, -0.05, 0);
                    return Pose.Of(0.6, -0.5, -0.5, 0.4, 0.1, -0.2, -0.1, -0.1);
                case "descend":
                case "takeoff":
                    return Pose.Of(0.6, -0.5, -0.5, 0.4, 0.1, -0.2, -0.1, -0.1);
                case "blast":
                {
                    double arm = Math.Atan2(dir * Math.Cos(beam.a), Math.Sin(beam.a));
                    return Pose.Of(arm, 0, -0.4, 0.3, 0.08, 0, -0.08, 0);
                }
                case "land":
                    return Pose.Of(0.35, 0, -1.3, 0.4, 1.5, -2.1, 0.3, -2.5);
                default:
                    return base.GetPose();
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            if (beam != null && beam.on) { pts.Add(new[] { beam.x1, beam.y1, 14 }); pts.Add(new[] { beam.x2, beam.y2, 18 }); }
            return pts;
        }

        public override void PaintFront(Cv cv)
        {
            if (beam == null || !beam.on) return;
            double flick = 1 + Math.Sin(t * 60) * 0.15;
            cv.Round = true;
            cv.RGB(new[] { 0.55, 0.85, 1 });
            cv.LineWidth = 6 * flick;
            Rig.Line(cv, beam.x1, beam.y1, beam.x2, beam.y2);
            cv.Stroke();
            cv.RGB(U.WHITE);
            cv.LineWidth = 2.4 * flick;
            Rig.Line(cv, beam.x1, beam.y1, beam.x2, beam.y2);
            cv.Stroke();
            cv.RGB(new[] { 0.85, 0.97, 1 });
            cv.Arc(beam.x1, beam.y1, 5, 0, 2 * Math.PI);
            cv.Fill();
        }
    }

    // ---- Captain America ----
    public class Cap : Hero
    {
        class Thrown { public double x, y, vx, vy, spin, t; public int b, maxB; public bool back; }
        Thrown shield;
        Hero aim;
        bool thrown;

        public Cap(World w) : base(w, new CapSkin()) { hasShield = true; }

        public override string[] Quips() { return new[] { "I can do this all day.", "Avengers, assemble!", "On your left.", "Language!" }; }
        public override string[] Ouch() { return new[] { "Hey!", "I can do this all day.", "Not cool, soldier.", "Ow!" }; }
        public override bool Grounded { get { return base.Grounded || state == "wait" || state == "catch"; } }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.35 && hasShield) StartThrow();
            else if (r < 0.55) { state = "run"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(1.5, 3); }
            else if (r < 0.75) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else if (r < 0.87) JumpTo(U.Rand(120, 200), U.Rand(600, 700), 2 * Math.PI);
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        void StartThrow()
        {
            if (x < W * 0.25) dir = 1;
            else if (x > W * 0.75) dir = -1;
            // aim at a teammate now and then
            Hero target = Others().Find(delegate (Hero o) { return U.Sign(o.x - x) == dir; });
            aim = target != null && U.Rng.NextDouble() < 0.6 ? target : null;
            state = "throw";
            timer = 0.38;
            thrown = false;
        }

        void ThrowShield()
        {
            double hx, hy;
            LimbPos("na", out hx, out hy);
            double a = U.Rand(-0.6, 0.05);
            if (aim != null)
            {
                double ox, oy;
                aim.Center(out ox, out oy);
                a = Math.Atan2(oy - hy, Math.Abs(ox - hx));
            }
            shield = new Thrown { x = hx, y = hy, vx = Math.Cos(a) * 720 * dir, vy = Math.Sin(a) * 720, maxB = U.Rng.Next(2, 5) };
            hasShield = false;
            thrown = true;
        }

        void UpdateShield(double dt)
        {
            Thrown s = shield;
            if (s == null) return;
            s.spin += dt * 16;
            s.t += dt;
            double r = 7.5 * k;
            if (!s.back)
            {
                s.x += s.vx * dt;
                s.y += s.vy * dt;
                bool hit = false;
                if (s.x < r) { s.x = r; s.vx = Math.Abs(s.vx); hit = true; }
                else if (s.x > W - r) { s.x = W - r; s.vx = -Math.Abs(s.vx); hit = true; }
                if (s.y < r) { s.y = r; s.vy = Math.Abs(s.vy); hit = true; }
                else if (s.y > Floor - r) { s.y = Floor - r; s.vy = -Math.Abs(s.vy); hit = true; }
                Hero o = HitTest(s.x, s.y, r);
                if (o != null && (o.Knock(U.Sign(s.vx) * 260, -420) || o.Blocking)) { s.vx = -s.vx; hit = true; }
                if (hit) { s.b++; Fxs.Sparks(particles, s.x, s.y, 6, U.SPARK); }
                if (s.b >= s.maxB || s.t > 2.6) s.back = true;
            }
            else
            {
                double hx, hy;
                LimbPos("na", out hx, out hy);
                double dx = hx - s.x, dy = hy - s.y, d = Math.Sqrt(dx * dx + dy * dy);
                if (d == 0) d = 1;
                double kk = Math.Min(1, dt * 6);
                s.vx += (dx / d * 820 - s.vx) * kk;
                s.vy += (dy / d * 820 - s.vy) * kk;
                s.x += s.vx * dt;
                s.y += s.vy * dt;
                if (d < 16 || s.t > 6)
                {
                    shield = null;
                    hasShield = true;
                    Fxs.Sparks(particles, hx, hy, 4, U.WHITE);
                }
            }
        }

        public override void OnKnocked()
        {
            if (state == "throw" && !thrown) state = "fall";
            base.OnKnocked();
        }

        public override void OnClick()
        {
            if (hasShield && Grounded)
            {
                Say(U.Pick(new[] { "Heads up!", "Catch!", "Avengers, assemble!" }), 1.8);
                StartThrow();
            }
            else base.OnClick();
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Throw the shield", () => { if (hasShield && Grounded) StartThrow(); }),
                new MenuEntry("Run", () => { if (Grounded) { state = "run"; timer = 3; } }),
            };
        }

        public override void Behave(double dt)
        {
            UpdateShield(dt);
            double stand = Floor - StandH;
            switch (state)
            {
                case "run":
                    GroundWalk(dt, 170, 3);
                    targetRot = 0.2 * dir;
                    break;
                case "throw":
                    y = stand;
                    timer -= dt;
                    if (!thrown && timer < 0.16) ThrowShield();
                    if (timer <= 0) state = "wait";
                    break;
                case "wait":
                    y = stand;
                    if (shield != null && Math.Abs(shield.x - x) > 10) dir = U.Sign(shield.x - x);
                    if (hasShield) { state = "catch"; timer = 0.35; }
                    break;
                case "catch":
                    y = stand;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            switch (state)
            {
                case "throw":
                    if (timer > 0.16) return Pose.Of(-1.9, 1.2, 1.0, 0.3, 0.4, -0.2, -0.4, 0);
                    return Pose.Of(1.6, 0.1, -0.6, 0.3, 0.4, -0.2, -0.4, 0);
                case "wait":
                    return Pose.Of(1.2, -0.4, -0.3, 0.3, 0.25, -0.1, -0.25, 0);
                case "catch":
                    return Pose.Of(1.4, -0.9, -0.4, 0.3, 0.25, -0.1, -0.25, 0);
                default:
                    return base.GetPose();
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            if (shield != null) pts.Add(new[] { shield.x, shield.y, 8 * k + 4 });
            return pts;
        }

        public override void PaintFront(Cv cv)
        {
            if (shield != null) Rig.DrawShield(cv, shield.x, shield.y, 7.5 * k, shield.spin);
        }
    }

    // ---- Hulk ----
    public class Hulk : Hero
    {
        int stomp;
        bool angry;

        public Hulk(World w) : base(w, new HulkSkin()) { }

        public override string[] Quips() { return new[] { "HULK SMASH!", "Hulk strongest there is.", "Puny desktop.", "RAAAWR!" }; }
        public override string[] Ouch() { return new[] { "GRRR!", "Hulk ANGRY!", "Who did that?!" }; }
        public override bool Grounded { get { return base.Grounded || state == "roar" || state == "chest" || state == "smash"; } }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (angry) { angry = false; Roar(); }
            else if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.35) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 5); }
            else if (r < 0.6) Leap();
            else if (r < 0.72) Roar();
            else if (r < 0.85) { state = "chest"; timer = 1.6; }
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        void Leap()
        {
            // sometimes leap right at somebody
            List<Hero> others = Others();
            Hero target = U.Rng.NextDouble() < 0.4 && others.Count > 0 ? U.Pick(others) : null;
            if (target != null)
            {
                dir = target.x >= x ? 1 : -1;
                state = "leap";
                vy = -U.Rand(900, 1050);
                double flight = -2 * vy / U.G;
                vx = U.Clamp((target.x - x) / flight, -500, 500);
            }
            else
            {
                JumpTo(U.Rand(220, 380), U.Rand(900, 1100));
                state = "leap";
            }
        }

        void Roar()
        {
            state = "roar";
            timer = 2;
            Say(U.Pick(new[] { "HULK SMASH!", "RAAAWR!" }), 2);
        }

        void Smash()
        {
            Land(0.8);
            state = "smash";
            for (int i = 0; i < 8; i++)
                Fxs.Spawn(particles, "rock", x + U.Rand(-20, 20), Floor - 4).V(U.Rand(-220, 220), U.Rand(-420, -180)).Grav(1200).Size(U.Rand(3, 6)).Life(U.Rand(0.7, 1.1));
            Fxs.Dust(particles, x, Floor, 10, 1.6);
            Shockwave(x, 230, 620);
            if (U.Rng.NextDouble() < 0.4) Say("SMASH!", 1.5);
        }

        public override void OnKnocked()
        {
            // Hulk barely moves, but he remembers
            vx *= 0.35;
            vy *= 0.5;
            state = "fall";
            angry = true;
        }

        public override void OnRelease(double rvx, double rvy)
        {
            base.OnRelease(rvx, rvy);
            state = "leap";
        }

        public override void OnClick()
        {
            if (!Grounded) return;
            if (U.Rng.NextDouble() < 0.5) Roar(); else Leap();
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Smash!", () => { if (Grounded) Leap(); }),
                new MenuEntry("Roar", () => { if (Grounded) Roar(); }),
            };
        }

        public override void Behave(double dt)
        {
            switch (state)
            {
                case "walk":
                {
                    GroundWalk(dt, 45, 3);
                    int s = U.Sign(Math.Sin(t * 8));
                    if (s != stomp)
                    {
                        stomp = s;
                        Fxs.Dust(particles, x + stomp * 8, Floor, 2, 0.7);
                    }
                    break;
                }
                case "leap":
                case "fall":
                    targetRot = U.Clamp(vx * 0.001, -0.3, 0.3);
                    if (Ballistic(dt)) Smash();
                    break;
                case "smash":
                    y = Floor - CrouchH;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                case "roar":
                case "chest":
                    y = Floor - StandH;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            double s = Math.Sin(t * 12);
            switch (state)
            {
                case "roar":
                    return Pose.Of(2.2, 1.0, 2.0, 1.0, 0.35, -0.2, -0.35, -0.1);
                case "chest":
                    return Pose.Of(1.0 + 0.5 * Math.Max(0, s), 2.3, 1.0 + 0.5 * Math.Max(0, -s), 2.3, 0.3, -0.1, -0.3, 0);
                case "smash":
                    return Pose.Of(0.45, 0, 0.2, 0, 1.4, -2.0, 0.4, -2.4);
                case "leap":
                case "fall":
                    return Pose.Of(2.8, 0.3, 2.6, 0.4, 0.9, -1.4, 0.4, -1.0);
                case "walk":
                {
                    double w = Math.Sin(t * 8);
                    return Pose.Of(-0.4 * w + 0.2, 0.6, 0.4 * w + 0.2, 0.6, 0.4 * w, -0.3 - 0.3 * Math.Max(0, -w), -0.4 * w, -0.3 - 0.3 * Math.Max(0, w));
                }
                default:
                    return base.GetPose();
            }
        }
    }

    // ---- Thor ----
    public class Thor : Hero
    {
        class Thrown { public double x, y, vx, vy, spin, t; public bool back; }
        Thrown hammer;
        List<double[]> bolt;
        double boltAge, tx, ty;
        bool thrown;

        public Thor(World w) : base(w, new ThorSkin()) { hasHammer = true; }

        public override string[] Quips() { return new[] { "For Asgard!", "Another!", "I am still worthy.", "Point Break, at your service." }; }
        public override string[] Ouch() { return new[] { "You dare?!", "Ow!", "Is that all?" }; }
        public override bool Grounded
        {
            get
            {
                return base.Grounded || state == "wait" || state == "catch" || state == "throw" || state == "spinup" ||
                       (state == "lightning" && y >= Floor - StandH - 5);
            }
        }

        public override void Enter()
        {
            x = U.Rand(W * 0.15, W * 0.85);
            y = Floor - StandH;
            StartLightning();
            Say("For Asgard!", 2.5);
        }

        void NewTarget()
        {
            tx = paused ? x : U.Rand(60, W - 60);
            ty = paused ? y : U.Rand(60, Floor - 160);
        }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.3) { state = "spinup"; timer = 0.9; }
            else if (r < 0.5 && hasHammer) StartThrow();
            else if (r < 0.65) StartLightning();
            else if (r < 0.85) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        void StartLightning()
        {
            if (!hasHammer) return;
            state = "lightning";
            timer = 1.4;
            bolt = null;
            boltAge = 0;
        }

        void StartThrow()
        {
            if (x < W * 0.25) dir = 1;
            else if (x > W * 0.75) dir = -1;
            state = "throw";
            timer = 0.38;
            thrown = false;
        }

        void ThrowHammer()
        {
            double hx, hy;
            LimbPos("na", out hx, out hy);
            double a = U.Rand(-0.25, 0.05);
            hammer = new Thrown { x = hx, y = hy, vx = Math.Cos(a) * 850 * dir, vy = Math.Sin(a) * 850 };
            hasHammer = false;
            thrown = true;
        }

        void UpdateHammer(double dt)
        {
            Thrown m = hammer;
            if (m == null) return;
            m.spin += dt * 18;
            m.t += dt;
            if (!m.back)
            {
                m.x += m.vx * dt;
                m.y += m.vy * dt;
                if (m.x < 10 || m.x > W - 10 || m.y < 10 || m.y > Floor - 10 || m.t > 0.7)
                {
                    m.back = true;
                    Fxs.Sparks(particles, m.x, m.y, 5, U.SPARK);
                }
                Hero o = HitTest(m.x, m.y, 8);
                if (o != null && (o.Knock(U.Sign(m.vx) * 320, -460) || o.Blocking))
                {
                    m.back = true;
                    Fxs.Sparks(particles, m.x, m.y, 6, U.SPARK);
                }
            }
            else
            {
                double hx, hy;
                LimbPos("na", out hx, out hy);
                double dx = hx - m.x, dy = hy - m.y, d = Math.Sqrt(dx * dx + dy * dy);
                if (d == 0) d = 1;
                double kk = Math.Min(1, dt * 7);
                m.vx += (dx / d * 900 - m.vx) * kk;
                m.vy += (dy / d * 900 - m.vy) * kk;
                m.x += m.vx * dt;
                m.y += m.vy * dt;
                if (d < 16 || m.t > 5) { hammer = null; hasHammer = true; }
            }
        }

        void HammerTip(out double hx, out double hy)
        {
            Pose p = GetPose();
            Pts P = Rig.Points(p);
            double a = p.na[0] + p.na[1];
            ToWorld(P.na[2] + Math.Sin(a) * 8, P.na[3] + Math.Cos(a) * 8, out hx, out hy);
        }

        public override void OnKnocked()
        {
            bolt = null;
            if (hasHammer) { state = "fly"; spin = 2 * Math.PI; NewTarget(); }
            else base.OnKnocked();
        }

        public override void OnRelease(double rvx, double rvy)
        {
            vx = rvx;
            vy = rvy;
            if (hasHammer) { state = "fly"; NewTarget(); }
            else state = "fall";
        }

        public override void OnClick()
        {
            if (Grounded)
            {
                Say(U.Pick(new[] { "For Asgard!", "Behold!", "Another!" }), 1.8);
                StartLightning();
            }
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Call the lightning", () => StartLightning()),
                new MenuEntry("Throw the hammer", () => { if (hasHammer && Grounded) StartThrow(); }),
                new MenuEntry("Fly", () => { if (Grounded && hasHammer) { state = "spinup"; timer = 0.9; } }),
            };
        }

        public override void Behave(double dt)
        {
            UpdateHammer(dt);
            capeFlow = U.Clamp(Math.Sqrt(vx * vx + vy * vy) / 400, 0, 1);
            double stand = Floor - StandH;
            switch (state)
            {
                case "spinup":
                    y = stand;
                    timer -= dt;
                    if (U.Rng.NextDouble() < dt * 20) Fxs.Dust(particles, x, Floor, 1);
                    if (timer <= 0) { state = "fly"; vx = 0; vy = -350; NewTarget(); }
                    break;
                case "fly":
                {
                    double d = Steer(dt, tx, ty + Math.Sin(t * 2) * 6, 420);
                    targetRot = FlightRot();
                    if (d < 25)
                    {
                        double r = U.Rng.NextDouble();
                        if (paused) NewTarget();
                        else if (r < 0.25) StartLightning();
                        else if (r < 0.5) { state = "descend"; tx = U.Rand(60, W - 60); }
                        else NewTarget();
                    }
                    break;
                }
                case "descend":
                {
                    double d = Steer(dt, tx, stand, 360);
                    targetRot = FlightRot();
                    if (y >= stand - 4 || d < 12)
                    {
                        Land(0.6);
                        fx.Add(new Fx { kind = "ring", x = x, y = Floor, r = 80, life = 0.5, max = 0.5 });
                    }
                    break;
                }
                case "lightning":
                {
                    double damp = 1 - Math.Min(1, dt * 4);
                    vx *= damp;
                    vy *= damp;
                    x += vx * dt;
                    y += vy * dt;
                    timer -= dt;
                    boltAge -= dt;
                    if (timer < 1.2 && timer > 0.1)
                    {
                        if (boltAge <= 0)
                        {
                            boltAge = 0.06;
                            double hx, hy;
                            HammerTip(out hx, out hy);
                            double bx0 = hx + U.Rand(-60, 60);
                            List<double[]> pts = new List<double[]>();
                            for (int i = 0; i <= 12; i++)
                            {
                                double f = i / 12.0;
                                pts.Add(new[] { bx0 + (hx - bx0) * f + (i > 0 && i < 12 ? U.Rand(-14, 14) : 0), hy * f });
                            }
                            bolt = pts;
                            if (U.Rng.NextDouble() < 0.5) Fxs.Sparks(particles, hx, hy, 2, new[] { 0.7, 0.9, 1 });
                            // anyone close gets a jolt
                            foreach (Hero o in Others())
                            {
                                double ox, oy;
                                o.Center(out ox, out oy);
                                if (Math.Sqrt((ox - hx) * (ox - hx) + (oy - hy) * (oy - hy)) < 110)
                                    o.Knock((ox - hx >= 0 ? 1 : -1) * 200, -460);
                            }
                        }
                    }
                    else bolt = null;
                    if (timer <= 0)
                    {
                        bolt = null;
                        if (y < stand - 5) { state = "fly"; NewTarget(); }
                        else Decide();
                    }
                    break;
                }
                case "throw":
                    y = stand;
                    timer -= dt;
                    if (!thrown && timer < 0.16) ThrowHammer();
                    if (timer <= 0) state = "wait";
                    break;
                case "wait":
                    y = stand;
                    if (hammer != null && Math.Abs(hammer.x - x) > 10) dir = U.Sign(hammer.x - x);
                    if (hasHammer) { state = "catch"; timer = 0.35; }
                    break;
                case "catch":
                    y = stand;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            double sp = Math.Sqrt(vx * vx + vy * vy);
            switch (state)
            {
                case "fly":
                case "descend":
                    if (sp > 200 || spin > 0) return Pose.Of(Math.PI, 0, -0.3, 0.2, 0.1, -0.1, -0.1, 0);
                    return Pose.Of(2.6, 0.2, -0.4, 0.3, 0.1, -0.2, -0.1, -0.1);
                case "lightning":
                    return Pose.Of(Math.PI, 0, -0.5, 0.4, 0.3, -0.1, -0.3, 0);
                case "spinup":
                    return Pose.Of(2.3, 0.4, -0.4, 0.3, 0.3, -0.1, -0.3, 0);
                case "throw":
                    if (timer > 0.16) return Pose.Of(-2.2, 0.8, 0.9, 0.3, 0.4, -0.2, -0.4, 0);
                    return Pose.Of(1.7, 0, -0.6, 0.3, 0.4, -0.2, -0.4, 0);
                case "wait":
                case "catch":
                    return Pose.Of(1.3, -0.5, -0.3, 0.3, 0.25, -0.1, -0.25, 0);
                default:
                    return base.GetPose();
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            if (hammer != null) pts.Add(new[] { hammer.x, hammer.y, 20 });
            if (bolt != null) foreach (double[] p in bolt) pts.Add(new[] { p[0], p[1], 20 });
            return pts;
        }

        public override void PaintFront(Cv cv)
        {
            if (hammer != null)
            {
                cv.Save();
                cv.Translate(hammer.x, hammer.y);
                cv.Rotate(hammer.spin);
                cv.Translate(0, -7 * k);
                Rig.DrawHammer(cv, k);
                cv.Restore();
            }
            if (bolt != null)
            {
                cv.Round = true;
                double[][] passes = { new[] { 4, 0.7, 0.85, 1 }, new[] { 1.8, 1, 1, 1 } };
                foreach (double[] ps in passes)
                {
                    cv.RGB(new[] { ps[1], ps[2], ps[3] });
                    cv.LineWidth = ps[0];
                    cv.MoveTo(bolt[0][0], bolt[0][1]);
                    for (int i = 1; i < bolt.Count; i++) cv.LineTo(bolt[i][0], bolt[i][1]);
                    cv.Stroke();
                }
            }
        }
    }

    // ---- Black Widow ----
    public class Widow : Hero
    {
        public Widow(World w) : base(w, new WidowSkin()) { }

        public override string[] Quips() { return new[] { "Let me handle this.", "Nice try.", "Stay sharp, boys.", "I've got red in my ledger." }; }
        public override string[] Ouch() { return new[] { "Seriously?", "Watch it.", "Ow!", "Bad idea." }; }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.3) { state = "run"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(1.5, 3); }
            else if (r < 0.5) JumpTo(U.Rand(120, 220), U.Rand(600, 720), 2 * Math.PI);
            else if (r < 0.65) StartSlide();
            else if (r < 0.8) { state = "bite"; timer = 1; }
            else if (r < 0.9) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        void StartSlide()
        {
            if (x < W * 0.2) dir = 1;
            else if (x > W * 0.8) dir = -1;
            state = "slide";
            vx = dir * 430;
        }

        public override void OnClick()
        {
            if (Grounded)
            {
                Say(U.Pick(new[] { "Hup!", "Too slow.", "Nice try." }), 1.8);
                JumpTo(U.Rand(80, 160), 640, 2 * Math.PI);
            }
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Flip", () => { if (Grounded) JumpTo(140, 640, 2 * Math.PI); }),
                new MenuEntry("Widow's bite", () => { if (Grounded) { state = "bite"; timer = 1; } }),
                new MenuEntry("Slide", () => { if (Grounded) StartSlide(); }),
            };
        }

        public override void Behave(double dt)
        {
            switch (state)
            {
                case "run":
                    GroundWalk(dt, 220, 3);
                    targetRot = 0.25 * dir;
                    break;
                case "slide":
                {
                    y = Floor - 6 * k;
                    x += vx * dt;
                    vx -= U.Sign(vx) * 600 * dt;
                    targetRot = -0.5 * dir;
                    if (U.Rng.NextDouble() < dt * 25) Fxs.Dust(particles, x, Floor, 1, 0.6);
                    // slide-tackle anyone in the way
                    Hero o = HitTest(x, Floor - 10, 10);
                    if (o != null) o.Knock(dir * 220, -480);
                    if (Math.Abs(vx) < 40 || x < Margin || x > W - Margin)
                    {
                        x = U.Clamp(x, Margin, W - Margin);
                        Land(0.3);
                    }
                    break;
                }
                case "bite":
                {
                    y = Floor - StandH;
                    timer -= dt;
                    double hx, hy;
                    if (U.Rng.NextDouble() < dt * 30)
                    {
                        LimbPos(U.Rng.NextDouble() < 0.5 ? "na" : "fa", out hx, out hy);
                        Fxs.Spawn(particles, "zap", hx, hy).V(0, 0).Life(0.15);
                    }
                    LimbPos("na", out hx, out hy);
                    foreach (Hero o in Others())
                    {
                        double ox, oy;
                        o.Center(out ox, out oy);
                        if (Math.Sqrt((ox - hx) * (ox - hx) + (oy - hy) * (oy - hy)) < 30) o.Knock(dir * 240, -420);
                    }
                    if (timer <= 0) Decide();
                    break;
                }
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            switch (state)
            {
                case "slide": return Pose.Of(-0.9, 0.4, -0.6, 0.5, 1.55, 0.05, 0.9, -1.9);
                case "bite": return Pose.Of(1.5, 0, 1.3, 0.2, 0.45, -0.3, -0.45, -0.1);
                default: return base.GetPose();
            }
        }
    }

    // ---- Hawkeye ----
    public class Hawkeye : Hero
    {
        class Arrow { public double x, y, vx, vy, life = 4, ang; public bool stuck, boom; }
        readonly List<Arrow> arrows = new List<Arrow>();
        double up = 0.2;
        Hero aimAt;

        public Hawkeye(World w) : base(w, new HawkSkin()) { }

        public override string[] Quips() { return new[] { "I never miss.", "Just a guy with a bow.", "Eyes on target.", "Nice shot. Mine, obviously." }; }
        public override string[] Ouch() { return new[] { "Hey!", "I saw that coming. Mostly.", "Ow!" }; }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.45) StartAim(0.75);
            else if (r < 0.75) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        void StartAim(double time)
        {
            List<Hero> others = Others();
            aimAt = U.Rng.NextDouble() < 0.5 && others.Count > 0 ? U.Pick(others) : null;
            if (aimAt != null) dir = aimAt.x >= x ? 1 : -1;
            else if (x < W * 0.2) dir = 1;
            else if (x > W * 0.8) dir = -1;
            up = U.Rand(0.05, 0.55);
            state = "aim";
            timer = time;
        }

        void Shoot()
        {
            double bx, by;
            LimbPos("fa", out bx, out by);
            double a = up, v = 1000;
            if (aimAt != null)
            {
                // aim straight at the target, a touch high for the drop
                double ox, oy;
                aimAt.Center(out ox, out oy);
                a = Math.Atan2(by - oy, Math.Abs(ox - bx)) + 0.06;
            }
            arrows.Add(new Arrow { x = bx, y = by, vx = dir * Math.Cos(a) * v, vy = -Math.Sin(a) * v, boom = U.Rng.NextDouble() < 0.25 });
            if (arrows.Count > 8) arrows.RemoveAt(0);
            state = "recover";
            timer = 0.35;
        }

        void UpdateArrows(double dt)
        {
            foreach (Arrow a in arrows)
            {
                if (a.stuck) { a.life -= dt; continue; }
                a.vy += U.G * 0.45 * dt;
                a.x += a.vx * dt;
                a.y += a.vy * dt;
                a.ang = Math.Atan2(a.vy, a.vx);
                Hero o = HitTest(a.x, a.y, 4);
                bool outside = a.x < 2 || a.x > W - 2 || a.y < 2 || a.y > Floor - 2;
                if (o != null || outside)
                {
                    a.x = U.Clamp(a.x, 2, W - 2);
                    a.y = U.Clamp(a.y, 2, Floor - 2);
                    a.stuck = true;
                    if (a.boom) { Explode(a.x, a.y, 110); a.life = 0; }
                    else if (o != null) { o.Knock(U.Sign(a.vx) * 200, -380); a.life = 0; }
                }
            }
            arrows.RemoveAll(delegate (Arrow a) { return a.stuck && a.life <= 0; });
        }

        public override void OnKnocked()
        {
            if (state == "aim") state = "fall";
            base.OnKnocked();
        }

        public override void OnClick()
        {
            if (Grounded)
            {
                Say(U.Pick(new[] { "I never miss.", "Watch this.", "Bullseye!" }), 1.8);
                StartAim(0.3);
            }
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> { new MenuEntry("Shoot an arrow", () => { if (Grounded) StartAim(0.5); }) };
        }

        public override void Behave(double dt)
        {
            UpdateArrows(dt);
            switch (state)
            {
                case "aim":
                    y = Floor - StandH;
                    timer -= dt;
                    if (timer <= 0) Shoot();
                    break;
                case "recover":
                    y = Floor - StandH;
                    timer -= dt;
                    if (timer <= 0) Decide();
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            switch (state)
            {
                case "aim":
                {
                    double arm = Math.Atan2(Math.Cos(up), -Math.Sin(up));
                    return new Pose { fa = new[] { arm, 0.0 }, na = new[] { arm + Math.PI, -Math.PI + 0.25 }, nl = new[] { 0.35, -0.1 }, fl = new[] { -0.35, 0.0 } };
                }
                case "recover":
                    return new Pose { fa = new[] { Math.PI / 2, 0.0 }, na = new[] { 0.3, 0.4 }, nl = new[] { 0.35, -0.1 }, fl = new[] { -0.35, 0.0 } };
                default:
                    return base.GetPose();
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            foreach (Arrow a in arrows) pts.Add(new[] { a.x, a.y, 24 });
            return pts;
        }

        public override void PaintFront(Cv cv)
        {
            foreach (Arrow a in arrows)
            {
                cv.Save();
                cv.Translate(a.x, a.y);
                cv.Rotate(a.ang);
                cv.Round = true;
                cv.RGB(U.INK);
                cv.LineWidth = 2.4;
                Rig.Line(cv, -20, 0, 0, 0);
                cv.Stroke();
                cv.RGB(U.BROWN);
                cv.LineWidth = 1.2;
                Rig.Line(cv, -20, 0, 0, 0);
                cv.Stroke();
                Rig.Poly(cv, new[] { new[] { 0.0, -2.5 }, new[] { 5.0, 0 }, new[] { 0.0, 2.5 } });
                cv.RGB(a.boom ? new[] { 1, 0.5, 0.1 } : U.SILVER);
                cv.Fill();
                Rig.Poly(cv, new[] { new[] { -20.0, 0 }, new[] { -16.0, -3 }, new[] { -14.0, 0 } });
                Rig.Poly(cv, new[] { new[] { -20.0, 0 }, new[] { -16.0, 3 }, new[] { -14.0, 0 } });
                cv.RGB(U.HAWK_PURPLE);
                cv.Fill();
                cv.Restore();
            }
        }
    }

    // ---- Doctor Strange ----
    public class Strange : Hero
    {
        class Portal { public double x, y, rx, ry, life, max; }
        readonly List<Portal> portals = new List<Portal>();
        double tx, ty, vis = 1;
        Hero victim;
        bool warped;

        public Strange(World w) : base(w, new StrangeSkin()) { }

        public override string[] Quips() { return new[] { "By the Vishanti!", "The Sorcerer Supreme is in.", "Dormammu, I've come to bargain.", "Time is relative." }; }
        public override string[] Ouch() { return new[] { "How rude.", "My cloak!", "Hmph." }; }
        public override bool Blocking { get { return state == "shield"; } }
        public override bool Grounded { get { return state == "idle" || state == "walk" || state == "land" || state == "chat"; } }

        // A glowing spell circle, as used for his shields.
        public static void Mandala(Cv cv, double mx, double my, double r, double t)
        {
            cv.Save();
            cv.Translate(mx, my);
            cv.RGB(U.MAGIC);
            cv.LineWidth = r * 0.07;
            cv.Arc(0, 0, r, 0, 2 * Math.PI);
            cv.Stroke();
            cv.Arc(0, 0, r * 0.72, 0, 2 * Math.PI);
            cv.Stroke();
            cv.Rotate(t * 1.5);
            foreach (double off in new[] { 0, Math.PI / 4 })
            {
                for (int i = 0; i < 4; i++)
                {
                    double ang = off + i * Math.PI / 2;
                    double px = Math.Cos(ang) * r * 0.72, py = Math.Sin(ang) * r * 0.72;
                    if (i > 0) cv.LineTo(px, py); else cv.MoveTo(px, py);
                }
                cv.ClosePath();
                cv.Stroke();
            }
            cv.LineWidth = r * 0.05;
            for (int i = 0; i < 16; i++)
            {
                double ang = -t * 3 + i * Math.PI / 8;
                Rig.Line(cv, Math.Cos(ang) * r * 0.78, Math.Sin(ang) * r * 0.78, Math.Cos(ang) * r * 0.92, Math.Sin(ang) * r * 0.92);
            }
            cv.Stroke();
            cv.Restore();
        }

        static void DrawPortal(Cv cv, Portal p, double t)
        {
            double f = Math.Min(1, Math.Min((p.max - p.life) / 0.25, p.life / 0.25));
            double rx = p.rx * f, ry = p.ry * f;
            if (rx < 1) return;
            cv.Save();
            cv.Translate(p.x, p.y);
            Rig.Ell(cv, 0, 0, rx, ry);
            cv.RGB(new[] { 0.16, 0.07, 0.12 });
            cv.Fill();
            Rig.Ell(cv, 0, 0, rx, ry);
            cv.RGB(U.MAGIC);
            cv.LineWidth = 2.5;
            cv.Stroke();
            cv.RGB(new[] { 1, 0.85, 0.4 });
            for (int i = 0; i < 18; i++)
            {
                double ang = t * 6 + i * Math.PI / 9;
                double px = Math.Cos(ang) * rx, py = Math.Sin(ang) * ry;
                cv.Arc(px + Math.Cos(ang) * 3, py + Math.Sin(ang) * 3, 1.1, 0, 2 * Math.PI);
                cv.Fill();
            }
            cv.Restore();
        }

        public override void Enter()
        {
            x = U.Rand(W * 0.15, W * 0.85);
            y = U.Rand(120, Floor * 0.55);
            Arrive();
            Say("The Sorcerer Supreme is in.", 2.5);
        }

        void NewTarget()
        {
            tx = paused ? x : U.Rand(60, W - 60);
            ty = paused ? y : U.Rand(80, Floor - 140);
        }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused) { state = "idle"; timer = 3; }
            else if (r < 0.4) { state = "float"; NewTarget(); }
            else if (r < 0.55 && PrankTarget() != null) StartPrank();
            else if (r < 0.7) StartPortal();
            else if (r < 0.85) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 4); }
            else { state = "idle"; timer = U.Rand(1.5, 3); }
        }

        Hero PrankTarget()
        {
            List<Hero> ok = Others().FindAll(delegate (Hero o) { return o.Grounded && o.state != "drag"; });
            return ok.Count > 0 ? U.Pick(ok) : null;
        }

        void StartPrank()
        {
            victim = PrankTarget();
            if (victim == null) return;
            if (victim.x != x) dir = victim.x > x ? 1 : -1;
            state = "prank";
            timer = 1.3;
            warped = false;
            portals.Add(new Portal { x = victim.x, y = Floor - 2, rx = 24, ry = 6, life = 1.1, max = 1.1 });
            Say(U.Pick(new[] { "Going somewhere?", "Watch your step.", "Hold still." }), 1.8);
        }

        void StartPortal()
        {
            state = "portalOut";
            timer = 0.7;
            double cx, cy;
            Center(out cx, out cy);
            portals.Add(new Portal { x = cx, y = cy, rx = 18, ry = 30, life = 1, max = 1 });
        }

        void Arrive()
        {
            state = "portalIn";
            timer = 0.7;
            vis = 0;
            double cx, cy;
            Center(out cx, out cy);
            portals.Add(new Portal { x = cx, y = cy, rx = 18, ry = 30, life = 1, max = 1 });
        }

        public override bool Knock(double kx, double ky)
        {
            if (state == "shield")
            {
                double cx, cy;
                Center(out cx, out cy);
                Fxs.Sparks(particles, cx + dir * 12, cy, 6, U.MAGIC);
                return false;
            }
            return base.Knock(kx, ky);
        }

        public override void OnKnocked()
        {
            vis = 1;
            state = "float";
            spin = 2 * Math.PI;
            NewTarget();
        }

        public override void OnRelease(double rvx, double rvy)
        {
            vx = rvx;
            vy = rvy;
            state = "float";
            NewTarget();
        }

        public override void OnClick()
        {
            Say(U.Pick(new[] { "By the Vishanti!", "Shields up.", "Behold." }), 1.8);
            state = "shield";
            timer = 2;
        }

        public override List<MenuEntry> Menu()
        {
            return new List<MenuEntry> {
                new MenuEntry("Cast a shield", () => { state = "shield"; timer = 2.5; }),
                new MenuEntry("Open a portal", () => StartPortal()),
                new MenuEntry("Portal-prank someone", () => { if (PrankTarget() != null) StartPrank(); }),
                new MenuEntry("Meditate", () => { if (Grounded) { state = "float"; NewTarget(); } else { state = "meditate"; timer = 5; } }),
            };
        }

        public override void Behave(double dt)
        {
            foreach (Portal p in portals) p.life -= dt;
            portals.RemoveAll(delegate (Portal p) { return p.life <= 0; });
            capeFlow = U.Clamp(Math.Sqrt(vx * vx + vy * vy) / 300, 0, 1);
            bool airborne = y < Floor - StandH - 4;
            switch (state)
            {
                case "float":
                {
                    double d = Steer(dt, tx, ty + Math.Sin(t * 1.6) * 8, 130);
                    targetRot = U.Clamp(vx * 0.001, -0.15, 0.15);
                    if (d < 20)
                    {
                        double r = U.Rng.NextDouble();
                        if (paused) NewTarget();
                        else if (r < 0.25) { state = "meditate"; timer = U.Rand(3, 6); }
                        else if (r < 0.45) StartPortal();
                        else if (r < 0.6 && PrankTarget() != null) StartPrank();
                        else if (r < 0.72) { state = "shield"; timer = 2; }
                        else if (r < 0.85) { state = "descend"; tx = x + U.Rand(-100, 100); }
                        else NewTarget();
                    }
                    break;
                }
                case "descend":
                {
                    double gy = Floor - StandH;
                    double d = Steer(dt, U.Clamp(tx, 60, W - 60), gy, 110);
                    if (y >= gy - 3 || d < 6) Land(0.3);
                    break;
                }
                case "meditate":
                case "shield":
                case "prank":
                {
                    double damp = 1 - Math.Min(1, dt * 4);
                    vx *= damp;
                    vy *= damp;
                    x += vx * dt;
                    if (airborne || state == "meditate") y += Math.Sin(t * 1.6) * 0.3;
                    timer -= dt;
                    if (state == "prank" && !warped && timer < 0.8)
                    {
                        warped = true;
                        if (victim != null && world.Heroes.Contains(victim))
                        {
                            double nx = U.Rand(80, W - 80);
                            portals.Add(new Portal { x = nx, y = 30, rx = 24, ry = 6, life = 1, max = 1 });
                            victim.Warp(nx, 40);
                        }
                    }
                    if (timer <= 0)
                    {
                        if (airborne || state == "meditate") { state = "float"; NewTarget(); }
                        else Decide();
                    }
                    break;
                }
                case "portalOut":
                    timer -= dt;
                    vis = U.Clamp(timer / 0.5, 0, 1);
                    if (timer <= 0)
                    {
                        x = U.Rand(60, W - 60);
                        y = U.Rand(100, Floor - 160);
                        Arrive();
                    }
                    break;
                case "portalIn":
                    timer -= dt;
                    vis = U.Clamp(1 - (timer - 0.1) / 0.5, 0, 1);
                    if (timer <= 0) { vis = 1; state = "float"; NewTarget(); }
                    break;
                default:
                    base.Behave(dt);
                    break;
            }
        }

        public override Pose GetPose()
        {
            switch (state)
            {
                case "float":
                case "descend":
                    return Pose.Of(0.9, 0.6, -0.5, 0.4, 0.15, -0.35, -0.1, -0.25);
                case "meditate":
                    return Pose.Of(1.1, 1.3, 1.0, 1.4, 1.4, -2.6, 1.2, -2.5);
                case "shield":
                    return Pose.Of(1.5, 0.2, 1.3, 0.3, 0.3, -0.2, -0.3, -0.1);
                case "portalOut":
                case "portalIn":
                    return Pose.Of(1.6 + 0.6 * Math.Sin(t * 10), 0.5, -0.4, 0.3, 0.1, -0.2, -0.1, -0.1);
                case "prank":
                    return Pose.Of(0.9, 0, -0.4, 0.3, 0.2, -0.2, -0.2, -0.1);
                default:
                    return base.GetPose();
            }
        }

        public override List<double[]> ExtraPoints()
        {
            List<double[]> pts = new List<double[]>();
            foreach (Portal p in portals)
            {
                pts.Add(new[] { p.x - p.rx, p.y - p.ry, 10 });
                pts.Add(new[] { p.x + p.rx, p.y + p.ry, 10 });
            }
            return pts;
        }

        public override void PaintBehind(Cv cv)
        {
            foreach (Portal p in portals) DrawPortal(cv, p, t);
        }

        // Fades into a portal by shrinking: see-through pixels would turn dark here.
        public override void PaintBody(Cv cv)
        {
            if (vis <= 0.05) return;
            double saved = k;
            k = saved * vis;
            base.PaintBody(cv);
            k = saved;
        }
    }

    // ---- Mochi, the original pocket pet ----
    public class Mochi : Hero
    {
        const double M = 0.48; // artwork scale; x, y is the point between its feet
        double squish;

        public Mochi(World w) : base(w, new NoSkin()) { k = 1.3; }

        public override string[] Quips() { return new[] { "Hi!", "Mochi wants pats.", "*happy wiggle*", "Hehe!" }; }
        public override string[] Ouch() { return new[] { "Eep!", "Waah!", "Mochi is OK!" }; }
        public override double StandH { get { return 0; } }
        public override double CrouchH { get { return 0; } }
        public override bool Grounded { get { return state == "idle" || state == "walk" || state == "land" || state == "chat" || state == "sleep"; } }

        public override void Center(out double cx, out double cy) { cx = x; cy = y - 85 * M; }

        public override bool Hit(double px, double py)
        {
            double cx, cy;
            Center(out cx, out cy);
            return Math.Abs(px - cx) < 85 * M && Math.Abs(py - cy) < 80 * M;
        }

        public override void Decide()
        {
            double r = U.Rng.NextDouble();
            if (paused || r < 0.3) { state = "idle"; timer = U.Rand(2, 5); }
            else if (r < 0.65) { state = "walk"; dir = U.Rng.Next(2) == 0 ? -1 : 1; timer = U.Rand(2, 6); }
            else if (r < 0.85) JumpTo(U.Rand(40, 90), U.Rand(300, 420));
            else { state = "sleep"; timer = U.Rand(8, 15); }
        }

        void Hearts()
        {
            for (int i = 0; i < 3; i++) Fxs.Spawn(particles, "heart", x + U.Rand(-20, 20), y - 60).V(U.Rand(-40, 40), U.Rand(-70, -40));
        }

        public override void OnClick()
        {
            if (state == "sleep") Say("*yawn* Hi!", 1.8);
            else Say(U.Pick(new[] { "Purr...", "Hehe!", "<3", "More pats please." }), 1.8);
            squish = 1;
            Hearts();
            if (state == "sleep") { state = "idle"; timer = 2; }
        }

        public override void StartChat(Hero other, string text, double delay)
        {
            base.StartChat(other, text, delay);
            Hearts();
        }

        public override void Behave(double dt)
        {
            squish = Math.Max(0, squish - dt * 3);
            switch (state)
            {
                case "walk":
                    GroundWalk(dt, 35, 0);
                    y = Floor;
                    break;
                case "sleep":
                    y = Floor;
                    timer -= dt;
                    if (timer <= 0) { Say("Good morning!", 2); Decide(); }
                    break;
                case "fall":
                    if (Ballistic(dt)) { squish = 1; Land(0.3); }
                    break;
                default:
                    base.Behave(dt);
                    if (state != "fall") y = Floor;
                    break;
            }
        }

        public override RectangleF Box()
        {
            RectangleF b = base.Box();
            return new RectangleF(b.X - 30, b.Y - 30, b.Width + 60, b.Height + 50);
        }

        public override void PaintBody(Cv cv)
        {
            bool asleep = state == "sleep", walking = state == "walk", held = state == "drag" || state == "fall";
            double bob = walking ? -Math.Abs(Math.Sin(t * 8)) * 6 : asleep ? 0 : Math.Sin(t * 2.4) * 3;
            double sq = Math.Sin(squish * Math.PI) * 0.14;
            double sx = 1 + sq, sy = 1 - sq;
            if (held) { sx = 0.94; sy = 1.08; }
            cv.Save();
            cv.Translate(x, y + bob);
            cv.Rotate(rot);
            cv.Scale(M * sx, M * sy);
            cv.Translate(-200, -273);
            double face = walking || state == "idle" ? dir * 6 : 0;
            double[] body = { 1.0, 0.72, 0.66 }, shade = { 0.95, 0.6, 0.53 }, ink = { 0.16, 0.14, 0.13 };
            cv.RGB(shade);
            double[][] ears = { new[] { 150.0, 138, 172 }, new[] { 250.0, 262, 228 } };
            foreach (double[] e in ears)
            {
                cv.MoveTo(e[0], 150);
                cv.QuadTo(e[1], 100, e[2], 122);
                cv.ClosePath();
                cv.Fill();
            }
            double step = walking ? Math.Sin(t * 8) * 5 : 0;
            Rig.Ell(cv, 170, 266 - Math.Max(step, 0), 16, 7);
            cv.Fill();
            Rig.Ell(cv, 230, 266 - Math.Max(-step, 0), 16, 7);
            cv.Fill();
            cv.RGB(body);
            cv.MoveTo(200, 115);
            cv.CurveTo(265, 115, 285, 175, 280, 215);
            cv.CurveTo(276, 252, 245, 268, 200, 268);
            cv.CurveTo(155, 268, 124, 252, 120, 215);
            cv.CurveTo(115, 175, 135, 115, 200, 115);
            cv.Fill();
            cv.RGB(U.WHITE, 0.35);
            Rig.Ell(cv, 200, 225, 48, 32);
            cv.Fill();
            cv.RGB(new[] { 1, 0.5, 0.56 }, 0.45);
            Rig.Ell(cv, 152 + face / 2, 200, 13, 8);
            cv.Fill();
            Rig.Ell(cv, 248 + face / 2, 200, 13, 8);
            cv.Fill();
            cv.RGB(ink);
            cv.LineWidth = 4;
            cv.Round = true;
            if (asleep)
            {
                foreach (double ex in new[] { 172.0, 228 })
                {
                    cv.MoveTo(ex - 10, 180);
                    cv.QuadTo(ex, 188, ex + 10, 180);
                    cv.Stroke();
                }
            }
            else
            {
                double open = held ? 1.25 : blink < 0 ? 0.12 : 1;
                foreach (double ex in new[] { 172.0, 228 })
                {
                    Rig.Ell(cv, ex + face, 178, 9, 12 * open);
                    cv.Fill();
                    if (open > 0.5)
                    {
                        cv.RGB(U.WHITE);
                        Rig.Ell(cv, ex + face + 3, 173, 3.2, 3.2);
                        cv.Fill();
                        cv.RGB(ink);
                    }
                }
            }
            double mx = face / 2;
            if (held)
            {
                Rig.Ell(cv, 200 + mx, 210, 6, 8);
                cv.Fill();
            }
            else if (asleep)
            {
                cv.MoveTo(195, 210);
                cv.QuadTo(200, 214, 205, 210);
                cv.Stroke();
            }
            else
            {
                cv.MoveTo(184 + mx, 202);
                cv.QuadTo(200 + mx, 226, 216 + mx, 202);
                cv.ClosePath();
                cv.RGB(new[] { 0.48, 0.18, 0.18 });
                cv.FillPreserve();
                cv.RGB(ink);
                cv.Stroke();
            }
            cv.Restore();
            if (asleep)
            {
                float[] sizes = { 13, 17, 21 };
                for (int i = 0; i < 3; i++)
                {
                    double ph = (t / 3 + i / 3.0) % 1;
                    if (Math.Sin(ph * Math.PI) < 0.3) continue;
                    Bubble.Text(cv, i == 2 ? "Z" : "z", x + 40 + ph * 16, y - 95 - i * 4 - ph * 40, sizes[i], new[] { 0.45, 0.52, 0.85 });
                }
            }
        }
    }

    // ---- who they are, and what they say when they meet ----
    public static class Cast
    {
        public static readonly string[] ORDER = { "spidey", "ironman", "cap", "hulk", "thor", "widow", "hawkeye", "strange", "mochi" };
        public static readonly string[] DEFAULT_ON = { "spidey", "ironman", "cap", "hulk" };

        public static string Name(string id)
        {
            switch (id)
            {
                case "spidey": return "Spider-Man";
                case "ironman": return "Iron Man";
                case "cap": return "Captain America";
                case "hulk": return "Hulk";
                case "thor": return "Thor";
                case "widow": return "Black Widow";
                case "hawkeye": return "Hawkeye";
                case "strange": return "Doctor Strange";
                default: return "Mochi";
            }
        }

        public static Hero Make(string id, World w)
        {
            Hero h;
            switch (id)
            {
                case "spidey": h = new SpiderMan(w); break;
                case "ironman": h = new IronMan(w); break;
                case "cap": h = new Cap(w); break;
                case "hulk": h = new Hulk(w); break;
                case "thor": h = new Thor(w); break;
                case "widow": h = new Widow(w); break;
                case "hawkeye": h = new Hawkeye(w); break;
                case "strange": h = new Strange(w); break;
                default: h = new Mochi(w); break;
            }
            h.id = id;
            return h;
        }

        // {first, second, first line, reply}
        static readonly string[][] CHATS = {
            new[] { "spidey", "ironman", "Hi Mr. Stark!", "Kid. We talked about this." },
            new[] { "ironman", "cap", "Nice outfit, Cap. Very vintage.", "Language, Tony." },
            new[] { "cap", "spidey", "Where are you from, kid?", "Queens!" },
            new[] { "thor", "hulk", "Friend from work!", "Hulk... happy." },
            new[] { "ironman", "thor", "Point Break!", "Metal man!" },
            new[] { "widow", "hawkeye", "You got my back?", "Always." },
            new[] { "widow", "hulk", "Hey, big guy.", "Hulk... calm." },
            new[] { "hawkeye", "spidey", "Nice webs, kid.", "Nice arrows, Mr. Hawkeye!" },
            new[] { "thor", "cap", "Your shield is quite sturdy.", "Your hammer's not bad either." },
            new[] { "ironman", "hulk", "Easy, big guy.", "Hulk SMASH tin man?" },
            new[] { "hulk", "spidey", "Bug man!", "Spider, actually!" },
            new[] { "cap", "widow", "Ready, Nat?", "Always, Rogers." },
            new[] { "strange", "ironman", "Stark.", "Nice cape, Doctor." },
            new[] { "strange", "spidey", "Focus, kid.", "Yes, Doctor Strange!" },
            new[] { "thor", "strange", "Wizard!", "Hello, Thor." },
            new[] { "strange", "hulk", "Hello, big guy.", "Magic man!" },
            new[] { "strange", "cap", "Captain.", "Doctor. Nice tricks." },
        };

        static void Lines(Hero a, Hero b, out Hero first, out Hero second, out string l1, out string l2)
        {
            foreach (string[] c in CHATS)
            {
                if (c[0] == a.id && c[1] == b.id) { first = a; second = b; l1 = c[2]; l2 = c[3]; return; }
                if (c[0] == b.id && c[1] == a.id) { first = b; second = a; l1 = c[2]; l2 = c[3]; return; }
            }
            if (b.id == "mochi") { first = a; second = b; l1 = "Aww, hi Mochi!"; l2 = "Mochi! <3"; return; }
            if (a.id == "mochi") { first = b; second = a; l1 = "Aww, hi Mochi!"; l2 = "Mochi! <3"; return; }
            first = a; second = b;
            l1 = "Hey, " + Name(b.id) + "!";
            l2 = "Hey, " + Name(a.id) + "!";
        }

        // Heroes walking past each other stop for a chat, or bump and turn around.
        public static void Interact(World world)
        {
            List<Hero> hs = world.Heroes;
            for (int i = 0; i < hs.Count; i++)
            {
                for (int j = i + 1; j < hs.Count; j++)
                {
                    Hero a = hs[i], b = hs[j];
                    if (!a.Chatty || !b.Chatty) continue;
                    double d = Math.Abs(a.x - b.x), kk = Math.Max(a.k, b.k);
                    if (d > 32 * kk) continue;
                    if (a.chatCd <= 0 && b.chatCd <= 0 && !a.paused && !b.paused)
                    {
                        Hero first, second;
                        string l1, l2;
                        Lines(a, b, out first, out second, out l1, out l2);
                        first.StartChat(second, l1, 0);
                        second.StartChat(first, l2, 1.6);
                    }
                    else if (d < 18 * kk)
                    {
                        if ((a.x - b.x) * a.dir < 0) a.dir = -a.dir;
                        if ((b.x - a.x) * b.dir < 0) b.dir = -b.dir;
                    }
                }
            }
        }
    }

    // ---- the see-through window the heroes live in ----
    public class Overlay : Form
    {
        // Everything painted in this color turns see-through. It is a near-black, so the
        // soft edges of the heroes' dark outlines blend into it without a visible fringe.
        public static readonly Color Key = Color.FromArgb(10, 4, 8);

        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        public double K;
        public World world = new World();
        public Action<string, bool> OnToggle;
        public Action ShowPanel;
        readonly Stopwatch clock = Stopwatch.StartNew();
        double lastTick, lastTop;
        Hero pressHero;
        bool dragging;
        double pressX, pressY, offX, offY;
        readonly List<double[]> moves = new List<double[]>();

        public Overlay()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Text = "Avengers Pets";
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Bounds = wa;
            BackColor = Key;
            TransparencyKey = Key;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            using (Graphics g = CreateGraphics()) K = g.DpiX / 96.0;
            world.W = wa.Width / K;
            world.H = wa.Height / K;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 33;
            timer.Tick += delegate { Tick(); };
            timer.Start();
        }

        // Never take focus away from what you're doing, and stay out of Alt+Tab.
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x80 | 0x08000000; // WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
                return cp;
            }
        }

        public bool Has(string id) { return world.Heroes.Exists(delegate (Hero h) { return h.id == id; }); }

        public void Add(string id)
        {
            if (Has(id)) return;
            Hero h = Cast.Make(id, world);
            h.Enter();
            world.Heroes.Add(h);
        }

        public void Remove(string id)
        {
            Hero h = world.Heroes.Find(delegate (Hero x) { return x.id == id; });
            if (h == null) return;
            InvalidateBox(h.lastBox);
            world.Heroes.Remove(h);
            if (pressHero == h) pressHero = null;
        }

        void InvalidateBox(RectangleF b)
        {
            if (b.IsEmpty) return;
            Invalidate(new Rectangle((int)Math.Floor(b.X * K), (int)Math.Floor(b.Y * K),
                                     (int)Math.Ceiling(b.Width * K) + 2, (int)Math.Ceiling(b.Height * K) + 2));
        }

        void Tick()
        {
            double now = clock.Elapsed.TotalSeconds;
            double dt = Math.Min(now - lastTick, 0.05);
            lastTick = now;
            foreach (Hero h in world.Heroes.ToArray()) h.Step(dt);
            Cast.Interact(world);
            foreach (Hero h in world.Heroes)
            {
                RectangleF b = h.Box();
                InvalidateBox(h.lastBox);
                InvalidateBox(b);
                h.lastBox = b;
            }
            // Other always-on-top windows can push us down; climb back up now and then.
            if (now - lastTop > 5)
            {
                lastTop = now;
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            }
        }

        Hero HeroAt(double px, double py)
        {
            for (int i = world.Heroes.Count - 1; i >= 0; i--)
                if (world.Heroes[i].Hit(px, py)) return world.Heroes[i];
            return null;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            double ex = e.X / K, ey = e.Y / K;
            Hero h = HeroAt(ex, ey);
            if (h == null) return;
            if (e.Button == MouseButtons.Left)
            {
                pressHero = h;
                dragging = false;
                pressX = ex; pressY = ey;
                offX = h.x - ex; offY = h.y - ey;
                moves.Clear();
            }
            else if (e.Button == MouseButtons.Right)
            {
                ShowMenu(h);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (pressHero == null) return;
            double ex = e.X / K, ey = e.Y / K;
            if (!dragging && Math.Abs(ex - pressX) + Math.Abs(ey - pressY) > 5)
            {
                dragging = true;
                pressHero.state = "drag";
                pressHero.spin = 0;
                pressHero.Say("Whoa, easy!", 1.5);
            }
            if (dragging)
            {
                pressHero.x = ex + offX;
                pressHero.y = ey + offY;
                moves.Add(new[] { clock.Elapsed.TotalSeconds, pressHero.x, pressHero.y });
                if (moves.Count > 5) moves.RemoveAt(0);
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || pressHero == null) return;
            if (dragging)
            {
                double mvx = 0, mvy = 0;
                if (moves.Count > 1)
                {
                    double[] a = moves[0], b = moves[moves.Count - 1];
                    double dt = Math.Max(b[0] - a[0], 0.01);
                    mvx = (b[1] - a[1]) / dt;
                    mvy = (b[2] - a[2]) / dt;
                }
                mvx = U.Clamp(mvx, -900, 900);
                mvy = U.Clamp(mvy, -900, 900);
                if (Math.Abs(mvx) > 30) pressHero.dir = U.Sign(mvx);
                pressHero.OnRelease(mvx, mvy);
            }
            else
            {
                pressHero.OnClick();
            }
            pressHero = null;
            dragging = false;
        }

        void ShowMenu(Hero h)
        {
            ContextMenuStrip m = new ContextMenuStrip();
            ToolStripMenuItem title = new ToolStripMenuItem(Cast.Name(h.id));
            title.Enabled = false;
            m.Items.Add(title);
            m.Items.Add(new ToolStripSeparator());
            foreach (MenuEntry entry in h.Menu())
            {
                Action act = entry.Act;
                m.Items.Add(entry.Label, null, delegate { act(); });
            }
            m.Items.Add(h.paused ? "Keep moving" : "Stay put", null, delegate
            {
                h.paused = !h.paused;
                h.Say(h.paused ? "OK, I'll stay here." : "Let's go!", 2);
            });
            m.Items.Add(new ToolStripSeparator());
            string id = h.id;
            m.Items.Add("Send " + Cast.Name(id) + " home", null, delegate { if (OnToggle != null) OnToggle(id, false); });
            m.Items.Add("Choose heroes...", null, delegate { if (ShowPanel != null) ShowPanel(); });
            m.Items.Add("Put everyone away", null, delegate { Application.Exit(); });
            m.Closed += delegate { BeginInvoke(new Action(m.Dispose)); };
            m.Show(Cursor.Position);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (Cv cv = new Cv(g, K))
            {
                foreach (Hero h in world.Heroes) h.Paint(cv);
                foreach (Hero h in world.Heroes) h.PaintBubble(cv);
            }
        }
    }

    // ---- settings ----
    public static class Settings
    {
        static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AvengersPets"); } }
        static string File { get { return Path.Combine(Dir, "settings.json"); } }

        public static List<string> Load(out bool first)
        {
            first = false;
            try
            {
                string text = System.IO.File.ReadAllText(File);
                Match list = Regex.Match(text, "\"on\"\\s*:\\s*\\[([^\\]]*)\\]");
                List<string> on = new List<string>();
                if (list.Success)
                    foreach (Match m in Regex.Matches(list.Groups[1].Value, "\"(\\w+)\""))
                        if (Array.IndexOf(Cast.ORDER, m.Groups[1].Value) >= 0) on.Add(m.Groups[1].Value);
                return on;
            }
            catch
            {
                first = true;
                return new List<string>(Cast.DEFAULT_ON);
            }
        }

        public static void Save(IEnumerable<string> on)
        {
            try
            {
                Directory.CreateDirectory(Dir);
                List<string> quoted = new List<string>();
                foreach (string id in on) quoted.Add("\"" + id + "\"");
                System.IO.File.WriteAllText(File, "{\"on\":[" + string.Join(",", quoted.ToArray()) + "]}");
            }
            catch { }
        }
    }

    // ---- the window where you pick who stays ----
    public class Panel : Form
    {
        readonly Dictionary<string, CheckBox> boxes = new Dictionary<string, CheckBox>();
        bool syncing;

        public Panel(Action<string, bool> onToggle, Func<string, bool> isOn)
        {
            Text = "Avengers Pets";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Segoe UI", 9.5f);
            BackColor = Color.White;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(16);

            FlowLayoutPanel outer = new FlowLayoutPanel();
            outer.FlowDirection = FlowDirection.TopDown;
            outer.AutoSize = true;
            outer.WrapContents = false;

            Label title = new Label();
            title.Text = "Who's hanging around?";
            title.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
            title.AutoSize = true;
            Label sub = new Label();
            sub.Text = "Tick heroes to bring them out. Click one on screen for a trick, drag to toss them,\nor right-click for their moves. Open Avengers Pets again to bring this window back.";
            sub.ForeColor = Color.FromArgb(90, 90, 100);
            sub.AutoSize = true;
            sub.Margin = new Padding(3, 4, 3, 12);
            outer.Controls.Add(title);
            outer.Controls.Add(sub);

            TableLayoutPanel grid = new TableLayoutPanel();
            grid.ColumnCount = 5;
            grid.AutoSize = true;
            for (int i = 0; i < Cast.ORDER.Length; i++)
            {
                string id = Cast.ORDER[i];
                FlowLayoutPanel card = new FlowLayoutPanel();
                card.FlowDirection = FlowDirection.TopDown;
                card.AutoSize = true;
                card.Margin = new Padding(6);
                PictureBox pic = new PictureBox();
                pic.Size = new Size(120, 124);
                pic.Image = Preview(id, 120, 124);
                CheckBox cb = new CheckBox();
                cb.Text = Cast.Name(id);
                cb.AutoSize = true;
                cb.Checked = isOn(id);
                cb.CheckedChanged += delegate { if (!syncing) onToggle(id, cb.Checked); };
                boxes[id] = cb;
                card.Controls.Add(pic);
                card.Controls.Add(cb);
                grid.Controls.Add(card, i % 5, i / 5);
            }
            outer.Controls.Add(grid);

            FlowLayoutPanel row = new FlowLayoutPanel();
            row.AutoSize = true;
            row.Margin = new Padding(3, 12, 3, 3);
            Button all = new Button(); all.Text = "Everyone"; all.AutoSize = true;
            all.Click += delegate { foreach (CheckBox b in boxes.Values) b.Checked = true; };
            Button none = new Button(); none.Text = "Nobody"; none.AutoSize = true;
            none.Click += delegate { foreach (CheckBox b in boxes.Values) b.Checked = false; };
            Button quit = new Button(); quit.Text = "Put everyone away"; quit.AutoSize = true;
            quit.Click += delegate { Application.Exit(); };
            Button done = new Button(); done.Text = "Done"; done.AutoSize = true;
            done.Click += delegate { Hide(); };
            row.Controls.Add(all);
            row.Controls.Add(none);
            row.Controls.Add(quit);
            row.Controls.Add(done);
            outer.Controls.Add(row);
            Controls.Add(outer);
            AcceptButton = done;
        }

        static Bitmap Preview(string id, int w, int h)
        {
            Bitmap bmp = new Bitmap(w, h);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.FromArgb(240, 242, 248));
                World world = new World { W = w, H = h - 6 };
                Hero hero = Cast.Make(id, world);
                hero.x = w / 2.0;
                hero.y = world.H - hero.StandH;
                hero.blink = 3;
                hero.t = 0.3;
                using (Cv cv = new Cv(g, 1)) hero.PaintBody(cv);
            }
            return bmp;
        }

        public void Sync(string id, bool on)
        {
            CheckBox cb;
            if (!boxes.TryGetValue(id, out cb) || cb.Checked == on) return;
            syncing = true;
            cb.Checked = on;
            syncing = false;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            base.OnFormClosing(e);
        }
    }

    public static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        public static void Run()
        {
            bool first;
            using (Mutex one = new Mutex(true, "AvengersPetsSingleInstance", out first))
            using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, "AvengersPetsShowPanel"))
            {
                // Launching again while they're out just opens the panel in the running copy.
                if (!first) { show.Set(); return; }
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();

                bool firstRun;
                List<string> on = Settings.Load(out firstRun);
                Overlay overlay = new Overlay();
                Panel panel = null;
                Action<string, bool> toggle = null;
                toggle = delegate (string id, bool yes)
                {
                    if (yes) overlay.Add(id); else overlay.Remove(id);
                    if (panel != null) panel.Sync(id, yes);
                    List<string> now = new List<string>();
                    foreach (string x in Cast.ORDER) if (overlay.Has(x)) now.Add(x);
                    Settings.Save(now);
                };
                foreach (string id in on) overlay.Add(id);
                panel = new Panel(toggle, overlay.Has);
                Action showPanel = delegate { panel.Show(); panel.Activate(); };
                overlay.OnToggle = toggle;
                overlay.ShowPanel = showPanel;
                overlay.Shown += delegate { if (firstRun) showPanel(); };
                ThreadPool.RegisterWaitForSingleObject(show, delegate
                {
                    if (overlay.IsHandleCreated) overlay.BeginInvoke(showPanel);
                }, null, -1, false);
                Settings.Save(on);
                Application.Run(overlay);
            }
        }
    }
}
'@

[AvengersPets.Program]::Run()
