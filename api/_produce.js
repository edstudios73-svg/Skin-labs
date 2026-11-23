// Production file generator: turns one PAID order into a print-and-cut package.
//  - Stickers: real vector contours traced from each sticker's transparency, offset, nested on sheets, registration marks
//  - Laptop skins: the customer's artwork placed exactly as designed on the VERIFIED template of their laptop
//  - Keyboard: deck artwork + one cut path (and one artwork file) per key from the verified template
//  - General order PNG, production summary + instructions PDFs, transparent artwork, validation, one ZIP
// Cut paths are vector in both SVG (layer "CutContour") and PDF (Separation spot colour, name configurable).
// A surface without a verified template is NEVER generated: it is reported as needing manual verification.
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFNumber, PDFOperator, PDFOperatorNames as Ops, pushGraphicsState, popGraphicsState, setLineWidth, moveTo, lineTo, closePath, stroke } from 'pdf-lib';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { putPrivate } from './_blob.js';

const FONT = fileURLToPath(new URL('./_fonts/DejaVuSans.ttf', import.meta.url)), FONTB = fileURLToPath(new URL('./_fonts/DejaVuSans-Bold.ttf', import.meta.url));
export const DEFAULTS = { dpi: 300, stickerMm: 55, xlMm: 180, spacing: 4, cutOffset: 1.5, margin: 12, regMarks: true, regSize: 5, cutMode: 'kiss', spot: 'CutContour', skinDpiMin: 150 };
const SHEET = { A5: [148, 210], A4: [210, 297], A3: [297, 420] };
const MMPT = 72 / 25.4, px = (mm, dpi) => Math.max(1, Math.round(mm / 25.4 * dpi));
const SN = { lid: 'Laptop lid', kb: 'Keyboard deck', pad: 'Trackpad', bot: 'Bottom cover' };
const safe = s => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const pdfText = s => String(s ?? '').replace(/₵/g, 'GHS ').replace(/[″“”]/g, '"').replace(/[’‘]/g, "'").replace(/[×]/g, 'x').replace(/[·•]/g, '-').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '');
const KEYN = { '`': 'backtick', '-': 'minus', '=': 'equals', '[': 'bracket-left', ']': 'bracket-right', ';': 'semicolon', "'": 'quote', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash', '#': 'hash', '←': 'arrow-left', '→': 'arrow-right', '↑': 'arrow-up', '↓': 'arrow-down' };
const sha = b => createHash('sha256').update(b).digest('hex');

// ---------- geometry ----------
function rdp(pts, eps) {   // simplify a closed polygon (Ramer-Douglas-Peucker), iterative
  if (pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; } return s / 2; };
function contours(mask, W, H) {   // marching squares -> closed loops (doubled integer coords)
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] ? 1 : 0, adj = new Map(), key = (x, y) => x * 65536 + y;
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const c = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1); if (!c || c === 15) continue;
    const T = key(2 * x + 1, 2 * y), R = key(2 * x + 2, 2 * y + 1), B = key(2 * x + 1, 2 * y + 2), L = key(2 * x, 2 * y + 1);
    const segs = { 1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[T, R]], 5: [[T, R], [L, B]], 6: [[T, B]], 7: [[T, L]], 8: [[T, L]], 9: [[T, B]], 10: [[T, L], [B, R]], 11: [[T, R]], 12: [[L, R]], 13: [[B, R]], 14: [[L, B]] }[c];
    for (const [a, b] of segs) link(a, b);
  }
  const seen = new Set(), loops = [];
  for (const s of adj.keys()) { if (seen.has(s)) continue; const loop = []; let prev = -1, cur = s;
    while (cur !== undefined && !seen.has(cur)) { seen.add(cur); loop.push([Math.floor(cur / 65536) / 2, (cur % 65536) / 2]); const n = adj.get(cur); const nx = n[0] !== prev ? n[0] : n[1]; prev = cur; cur = nx; }
    if (loop.length > 2) loops.push(loop); }
  return loops;
}
function dilate(m, W, H, r) {   // round structuring element via two separable passes of a box, repeated
  let a = m;
  for (let it = 0; it < r; it++) { const b = new Uint8Array(a.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (a[i] || (x > 0 && a[i - 1]) || (x < W - 1 && a[i + 1]) || (y > 0 && a[i - W]) || (y < H - 1 && a[i + W]) || (it % 2 && ((x > 0 && y > 0 && a[i - W - 1]) || (x < W - 1 && y < H - 1 && a[i + W + 1]) || (x > 0 && y < H - 1 && a[i + W - 1]) || (x < W - 1 && y > 0 && a[i - W + 1])))) b[i] = 1; }
    a = b; }
  return a;
}
function components(m, W, H) { const lab = new Int32Array(m.length); let n = 0; const q = [];
  for (let i = 0; i < m.length; i++) { if (!m[i] || lab[i]) continue; n++; lab[i] = n; q.push(i);
    while (q.length) { const j = q.pop(), x = j % W, y = (j / W) | 0; for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) if (k >= 0 && m[k] && !lab[k]) { lab[k] = n; q.push(k); } } }
  return n; }
export const rrect = (x, y, w, h, r, seg = 10) => { r = Math.max(0, Math.min(r || 0, w / 2, h / 2)); if (!r) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const out = [], arc = (cx, cy, a0) => { for (let i = 0; i <= seg; i++) { const a = a0 + i / seg * Math.PI / 2; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(x + w - r, y + r, -Math.PI / 2); arc(x + w - r, y + h - r, 0); arc(x + r, y + h - r, Math.PI / 2); arc(x + r, y + r, Math.PI); return out; };
const circle = (cx, cy, r, n = 48) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
function shapePts(c, grow = 0) {   // template shape -> polygon in mm, grown (+) or shrunk (-) by the cut offset
  if (c.pts) { const cx = c.pts.reduce((a, p) => a + p[0], 0) / c.pts.length, cy = c.pts.reduce((a, p) => a + p[1], 0) / c.pts.length;
    return c.pts.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return [x + (x - cx) / d * grow, y + (y - cy) / d * grow]; }); }
  if (c.type === 'circle') return circle(c.x, c.y, Math.max(.1, c.w / 2 + grow));
  return rrect(c.x - grow, c.y - grow, c.w + 2 * grow, c.h + 2 * grow, Math.max(0, (c.r || 0) + grow));
}
const closedOk = p => Array.isArray(p) && p.length >= 3 && p.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1])) && Math.abs(area(p)) > .01;
const svgPath = p => 'M' + p.map(q => `${q[0].toFixed(3)},${q[1].toFixed(3)}`).join('L') + 'Z';

// ---------- a sticker: outer contour from transparency ----------
async function stickerShape(buf, longMm, s) {
  const meta = await sharp(buf).metadata(), k = 520 / Math.max(meta.width, meta.height), w = Math.max(4, Math.round(meta.width * k)), h = Math.max(4, Math.round(meta.height * k));
  const { data } = await sharp(buf).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const ppm = Math.max(w, h) / longMm, off = Math.max(1, Math.round(s.cutOffset * ppm)), P = off + 8, GW = w + 2 * P, GH = h + 2 * P;
  let m = new Uint8Array(GW * GH), any = 0, opaque = true;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = data[(y * w + x) * 4 + 3]; if (a > 24) { m[(y + P) * GW + x + P] = 1; any++; } if (a < 250) opaque = false; }
  const artW = w / ppm, artH = h / ppm;
  if (!any) throw new Error('empty artwork');
  if (opaque || !meta.hasAlpha) { const p = rrect(0, 0, artW + 2 * s.cutOffset, artH + 2 * s.cutOffset, 2.5); return { w: artW + 2 * s.cutOffset, h: artH + 2 * s.cutOffset, art: { x: s.cutOffset, y: s.cutOffset, w: artW, h: artH }, path: p, transparent: false }; }
  m = dilate(m, GW, GH, off); let extra = 0; while (components(m, GW, GH) > 1 && extra < 6) { m = dilate(m, GW, GH, 2); extra += 2; }   // islands join into one sticker
  const loops = contours(m, GW, GH); let best = loops[0]; for (const l of loops) if (Math.abs(area(l)) > Math.abs(area(best))) best = l;
  // a closed loop starts and ends at the same point, so simplify it as two open halves split at the farthest point
  let far = 0, fd = -1; for (let i = 0; i < best.length; i++) { const d = (best[i][0] - best[0][0]) ** 2 + (best[i][1] - best[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const h1 = rdp(best.slice(0, far + 1), .55), h2 = rdp([...best.slice(far), best[0]], .55);
  let pts = [...h1, ...h2.slice(1, -1)].map(([x, y]) => [(x - P) / ppm, (y - P) / ppm]);
  const minx = Math.min(...pts.map(p => p[0])), miny = Math.min(...pts.map(p => p[1])); pts = pts.map(([x, y]) => [x - minx, y - miny]);
  return { w: Math.max(...pts.map(p => p[0])), h: Math.max(...pts.map(p => p[1])), art: { x: -minx, y: -miny, w: artW, h: artH }, path: pts, transparent: true, joined: extra };
}
function nest(items, W, H, s) {   // shelf packing on sheets, biggest first, no overlaps; margins keep registration marks clear
  const x0 = s.margin, y0 = s.margin, x1 = W - s.margin, y1 = H - s.margin, sheets = []; let cur = null, x = 0, y = 0, row = 0;
  for (const it of [...items].sort((a, b) => b.h - a.h || b.w - a.w)) {
    if (it.w > x1 - x0 || it.h > y1 - y0) throw new Error(`${it.code} (${it.w.toFixed(0)} x ${it.h.toFixed(0)} mm) does not fit the sheet`);
    if (!cur) { cur = []; sheets.push(cur); x = x0; y = y0; row = 0; }
    if (x + it.w > x1) { x = x0; y += row + s.spacing; row = 0; }
    if (y + it.h > y1) { cur = []; sheets.push(cur); x = x0; y = y0; row = 0; }
    cur.push({ ...it, x, y }); x += it.w + s.spacing; row = Math.max(row, it.h);
  }
  return sheets;
}
const regMarks = (W, H, s) => !s.regMarks ? [] : [[s.margin / 2 - s.regSize / 2, s.margin / 2 - s.regSize / 2], [W - s.margin / 2 - s.regSize / 2, s.margin / 2 - s.regSize / 2], [s.margin / 2 - s.regSize / 2, H - s.margin / 2 - s.regSize / 2]].map(([x, y]) => ({ x, y, w: s.regSize, h: s.regSize }));

// ---------- outputs ----------
function cutSVG(W, H, paths, marks, s, title) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
<title>${title}</title><desc>Skin Lab cut file. Cut paths are in the "${s.spot}" layer (${s.cutMode === 'die' ? 'die cut: through the backing' : 'kiss cut: sticker layer only'}). Units: millimetres.</desc>
${marks.length ? `<g id="RegMarks" inkscape:groupmode="layer" inkscape:label="RegMarks" fill="#000000">${marks.map(m => `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}"/>`).join('')}</g>\n` : ''}<g id="${s.spot}" inkscape:groupmode="layer" inkscape:label="${s.spot}" fill="none" stroke="#FF00FF" stroke-width="0.25">
${paths.map(p => `<path d="${svgPath(p)}"/>`).join('\n')}
</g></svg>`;
}
async function cutPDF(pages, s, meta) {   // pages: [{ W, H, png?, paths, marks }]; artwork underneath, cut lines on top in a spot colour
  const doc = await PDFDocument.create(); doc.setTitle(pdfText(meta.title)); doc.setProducer('Skin Lab print production'); doc.setCreator('Skin Lab');
  const ctx = doc.context, tint = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }), cs = ctx.register(ctx.obj([PDFName.of('Separation'), PDFName.of(s.spot), PDFName.of('DeviceCMYK'), ctx.register(tint)]));
  for (const pg of pages) { const page = doc.addPage([pg.W * MMPT, pg.H * MMPT]), Hp = pg.H * MMPT;
    if (pg.png) { const im = await doc.embedPng(pg.png); page.drawImage(im, { x: (pg.ix || 0) * MMPT, y: Hp - ((pg.iy || 0) + (pg.ih || pg.H)) * MMPT, width: (pg.iw || pg.W) * MMPT, height: (pg.ih || pg.H) * MMPT }); }
    for (const m of pg.marks || []) page.drawRectangle({ x: m.x * MMPT, y: Hp - (m.y + m.h) * MMPT, width: m.w * MMPT, height: m.h * MMPT, color: rgb(0, 0, 0) });
    const res = page.node.Resources(); let csd = res.lookup(PDFName.of('ColorSpace')); if (!csd) { csd = ctx.obj({}); res.set(PDFName.of('ColorSpace'), csd); } csd.set(PDFName.of('CutCS'), cs);
    const ops = [pushGraphicsState(), PDFOperator.of(Ops.StrokingColorspace, [PDFName.of('CutCS')]), PDFOperator.of(Ops.StrokingColorN, [PDFNumber.of(1)]), setLineWidth(.25 * MMPT)];
    for (const p of pg.paths) { ops.push(moveTo(p[0][0] * MMPT, Hp - p[0][1] * MMPT)); for (let i = 1; i < p.length; i++) ops.push(lineTo(p[i][0] * MMPT, Hp - p[i][1] * MMPT)); ops.push(closePath(), stroke()); }
    ops.push(popGraphicsState()); page.pushOperators(...ops); }
  return Buffer.from(await doc.save());
}
async function textPDF(title, sections) {   // simple readable A4 document (summary, instructions)
  const doc = await PDFDocument.create(), f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold); doc.setTitle(pdfText(title));
  let page = doc.addPage([595.28, 841.89]), y = 790; const line = (t, font = f, size = 10.5, x = 48) => { for (const part of wrap(pdfText(t), font, size, 595 - x - 48)) { if (y < 60) { page = doc.addPage([595.28, 841.89]); y = 790; } page.drawText(part, { x, y, size, font }); y -= size * 1.45; } };
  const wrap = (t, font, size, w) => { const out = []; let cur = ''; for (const word of t.split(' ')) { const nx = cur ? cur + ' ' + word : word; if (font.widthOfTextAtSize(nx, size) > w && cur) { out.push(cur); cur = word; } else cur = nx; } out.push(cur); return out; };
  line(title, fb, 18); y -= 6;
  for (const [h, rows] of sections) { y -= 8; line(h, fb, 12.5); for (const r of rows) line(r, f, 10.5, 58); }
  return Buffer.from(await doc.save());
}
async function renderSurface(src, W, H, bleed, t, dpi) {   // artwork for one surface, placed like the Design Studio placed it, plus bleed
  const PW = px(W + 2 * bleed, dpi), PH = px(H + 2 * bleed, dpi);
  if (src.color) return { png: await sharp({ create: { width: PW, height: PH, channels: 4, background: src.color } }).png().withMetadata({ density: dpi }).toBuffer(), dpiEff: Infinity, srcPx: null };
  t = { z: 1, x: 0, y: 0, r: 0, fit: 'cover', ...(t || {}) };
  const m = await sharp(src.buf).metadata(), base = t.fit === 'contain' ? Math.min(px(W, dpi) / m.width, px(H, dpi) / m.height) : Math.max(PW / m.width, PH / m.height), k = base * t.z;
  let im = await sharp(src.buf).ensureAlpha().resize(Math.max(1, Math.round(m.width * k)), Math.max(1, Math.round(m.height * k))).rotate(t.r || 0, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const im2 = await sharp(im).metadata(), cx = PW / 2 + t.x * px(W, dpi), cy = PH / 2 + t.y * px(H, dpi), left = Math.round(cx - im2.width / 2), top = Math.round(cy - im2.height / 2);
  const ex = { left: Math.max(0, -left), top: Math.max(0, -top) }; ex.width = Math.min(im2.width - ex.left, PW - Math.max(0, left)); ex.height = Math.min(im2.height - ex.top, PH - Math.max(0, top));
  const layers = ex.width > 0 && ex.height > 0 ? [{ input: await sharp(im).extract(ex).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) }] : [];
  const png = await sharp({ create: { width: PW, height: PH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).composite(layers).png().withMetadata({ density: dpi }).toBuffer();
  return { png, dpiEff: m.width / k * dpi / im2.width * (im2.width / (m.width * k)) * 1 / 1, srcPx: [m.width, m.height], scale: k };
}
async function textImg(markup, width, size = 34, bold = false) { return sharp({ text: { text: markup, fontfile: bold ? FONTB : FONT, font: `${bold ? 'DejaVu Sans Bold' : 'DejaVu Sans'} ${size}`, width, rgba: true, dpi: 72 } }).png().toBuffer(); }
const escM = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- the whole package ----------
export async function produce({ order: o, job, plan, base, settings = {}, assets }) {
  const s = { ...DEFAULTS, ...settings }, files = [], checks = [], warnings = [], folders = {}, t0 = Date.now(), root = `${o.id}-PRODUCTION-PACKAGE`;
  const add = (name, buf, type, extra = {}) => { files.push({ name, buf, type, bytes: buf.length, sha256: sha(buf), ...extra }); };
  const check = (name, ok, msg = '', warnOnly = false) => { checks.push({ check: name, ok: !!ok, msg, level: ok ? 'ok' : warnOnly ? 'warn' : 'error' }); if (!ok && warnOnly) warnings.push(msg || name); };
  check('Order id', job.id === o.id && /^SL-[2-9A-Z]{5}$/.test(o.id), `${o.id}`);
  if (o.paid && o.paid.restored && !o.paid.verifiedAt) check('Payment verified', false, 'Restored order approved by the owner, not verified by Paystack. Collect any unpaid balance at pickup', true);   // only set by a direct owner restore, never by any API
  else check('Payment verified', !!(o.paid && o.paid.verifiedAt), o.paid ? `Paystack ${o.paid.ref}` : 'not paid');

  // ---- stickers (packs, singles, free sticker, custom designer stickers) ----
  const stk = []; const want = (code, longMm, q, src, from) => { for (let i = 0; i < q; i++) stk.push({ code, longMm, src, from }); };
  const sheetSize = it => it.size === 'A5' ? 'A5' : it.size === 'A3' ? 'A3' : 'A4';
  // a group is one kind of sheet: "auto" (nested by the system), "pack" (one pack = one sheet, shrunk to fit if needed)
  // or "fixed" (the customer/owner already arranged the stickers: print them exactly where they were placed)
  const groups = []; const grp = (size, mode, title) => { const g = { size, mode, title, list: [] }; groups.push(g); return g; };
  let auto = null; const autoA4 = () => auto ||= grp('A4', 'auto', '');
  const boxOf = l => ({ x: +l.x || 0, y: +l.y || 0, w: +l.w || 0, h: +l.h || 0 });
  for (const it of job.items) {
    if (it.kind === 'sticker-pack') { const p = assets.pack(it.design); if (!p) { check(`Pack ${it.design}`, false, `Pack ${it.design} not found in the shop data`); continue; }
      const codes = it.size === 'A5' && p.a5 ? p.a5 : p.items.map(x => x[0]), xl = p.size === 'XL';
      for (let q = 0; q < it.q; q++) { const g = xl ? autoA4() : grp(sheetSize({ size: it.size === 'A5' ? 'A5' : p.size }), 'pack', p.name); for (const c of codes) g.list.push({ code: c, longMm: xl ? s.xlMm : s.stickerMm, src: assets.stickerSrc(c, p), from: p.name }); } }
    else if (it.kind === 'singles' && o.picks && Array.isArray(o.picks.layout) && o.picks.layout.length) { const g = grp(sheetSize({ size: o.picks.size }), 'fixed', o.picks.title || `${o.picks.layout.length} singles`);
      for (const l of o.picks.layout) if (l && l.c) g.list.push({ code: l.c, longMm: Math.max(10, Math.max(l.w || 0, l.h || 0) - s.spacing) || s.stickerMm, src: assets.stickerSrc(l.c), from: 'Single stickers', box: boxOf(l) }); }
    else if (it.kind === 'singles') { const g = autoA4(); for (const c of it.codes) for (let i = 0; i < c.q; i++) g.list.push({ code: c.code, longMm: s.stickerMm, src: assets.stickerSrc(c.code), from: 'Single stickers' }); }
    else if (it.kind === 'free-sticker') { if (o.design && Array.isArray(o.design.layout) && o.design.layout.some(l => l && l.c === it.code)) continue;   // already placed on the customer's own sheet
      autoA4().list.push({ code: it.code, longMm: s.stickerMm, src: assets.stickerSrc(it.code), from: 'Free sticker' }); }
    else if (it.kind === 'custom-stickers' && o.design && Array.isArray(o.design.layout)) { const g = grp(sheetSize({ size: o.design.size }), 'fixed', o.design.packName || 'Custom pack');
      for (const l of o.design.layout) if (l && l.c) g.list.push({ code: l.c, longMm: Math.max(10, Math.max(l.w || 0, l.h || 0) - s.spacing) || s.stickerMm, src: assets.stickerSrc(l.c), from: 'Custom pack', box: boxOf(l) }); }
  }
  const shapes = new Map(), stickerPaths = [], sheetsOut = [], used = new Set();   // used: the sticker sizes that really went on a sheet
  const shapeOf = async it => { const kk = `${it.code}@${it.longMm}`; if (!shapes.has(kk)) { try { const buf = await assets.fetch(it.src); shapes.set(kk, { ...(await stickerShape(buf, it.longMm, s)), buf }); } catch (e) { shapes.set(kk, { error: e.message }); } } return kk; };
  for (const g of groups) {
    if (!g.list.length) continue;
    const size = g.size, [W, H] = SHEET[size];
    g.list.forEach((x, i) => x.idx = i);
    const load = async list => { const out = []; for (const it of list) { const kk = await shapeOf(it), sh = shapes.get(kk); if (sh.error) { check(`Sticker ${it.code}`, false, `Artwork for ${it.code} could not be read (${sh.error})`); continue; } out.push({ ...it, w: sh.w, h: sh.h, kk }); } return out; };
    let placed = await load(g.list); if (!placed.length) continue;
    let sheets;
    if (g.mode === 'fixed') {   // keep the arrangement: centre each sticker in the box it had, never off the sheet
      const at = p => ({ ...p, x: Math.max(0, Math.min(W - p.w, p.box.x + (p.box.w - p.w) / 2)), y: Math.max(0, Math.min(H - p.h, p.box.y + (p.box.h - p.h) / 2)) });
      let one = placed.map(at);
      const hit = (a, b) => a.x < b.x + b.w - .5 && b.x < a.x + a.w - .5 && a.y < b.y + b.h - .5 && b.y < a.y + a.h - .5;
      const poly = p => shapes.get(p.kk).path.map(([x, y]) => [x + p.x, y + p.y]);
      const inside = ([x, y], P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
      const cross = (p, q, r, t) => { const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return d(p, q, r) * d(p, q, t) < 0 && d(r, t, p) * d(r, t, q) < 0; };
      const touch = (A, B) => A.some(pt => inside(pt, B)) || B.some(pt => inside(pt, A)) || A.some((p, i) => { const q = A[(i + 1) % A.length]; return B.some((r, k) => cross(p, q, r, B[(k + 1) % B.length])); });
      const clash = () => { const bad = new Set(); one.forEach((a, i) => one.forEach((b, j) => { if (j > i && hit(a, b) && touch(poly(a), poly(b))) { bad.add(i); bad.add(j); } })); return bad; };
      for (let round = 0; round < 8; round++) {   // stickers packed too tightly: shrink only the ones that touch, a little at a time, still centred in their place
        const bad = clash(); if (!bad.size) break;
        for (const i of bad) { const p = one[i], mm = p.longMm * .95; if (mm < g.list[p.idx].longMm * .7) continue; const kk = await shapeOf({ ...p, longMm: mm }), sh = shapes.get(kk); if (sh.error) continue; one[i] = at({ ...p, longMm: mm, kk, w: sh.w, h: sh.h }); } }
      const ov = clash().size > 0, mk = regMarks(W, H, s).some(m => one.some(a => hit(a, m)));
      check(`${g.title}: original arrangement kept`, !ov && !mk, ov ? 'Some cut lines touch in the original arrangement: check the cut before printing' : mk ? 'A sticker sits on a registration mark corner: check before printing' : `${one.length} stickers placed as arranged on ${size}`, true);
      sheets = [one];
    } else if (g.mode === 'pack') {   // one pack is one sheet: shrink the stickers a little if they would spill onto a second sheet
      sheets = nest(placed, W, H, s);
      for (let mm = s.stickerMm - 3; sheets.length > 1 && mm >= 30; mm -= 3) { placed = await load(g.list.map(x => ({ ...x, longMm: mm }))); sheets = nest(placed, W, H, s); }
    } else sheets = nest(placed, W, H, s);
    for (const sheet of sheets) {
      const marks = regMarks(W, H, s), paths = sheet.map(p => shapes.get(p.kk).path.map(([x, y]) => [x + p.x, y + p.y]));
      const layers = []; for (const p of sheet) { const sh = shapes.get(p.kk), L = Math.max(0, px(p.x + sh.art.x, s.dpi)), T = Math.max(0, px(p.y + sh.art.y, s.dpi));
        layers.push({ input: await sharp(sh.buf).resize(Math.max(1, Math.min(px(sh.art.w, s.dpi), px(W, s.dpi) - L)), Math.max(1, Math.min(px(sh.art.h, s.dpi), px(H, s.dpi) - T)), { fit: 'fill' }).png().toBuffer(), left: L, top: T }); }
      const tpng = await sharp({ create: { width: px(W, s.dpi), height: px(H, s.dpi), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers.slice()).png({ compressionLevel: 8 }).withMetadata({ density: s.dpi }).toBuffer();   // the printer's transparent sheet: stickers only, no background, no marks
      if (marks.length) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px(W, s.dpi)}" height="${px(H, s.dpi)}" viewBox="0 0 ${W} ${H}">${marks.map(m => `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="#000"/>`).join('')}</svg>`), left: 0, top: 0 });
      const png = await sharp({ create: { width: px(W, s.dpi), height: px(H, s.dpi), channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(layers).png({ compressionLevel: 8 }).withMetadata({ density: s.dpi }).toBuffer();
      sheetsOut.push({ size, title: g.title, n: sheetsOut.filter(x => x.size === size).length + 1, W, H, png, tpng, paths, marks, count: sheet.length }); stickerPaths.push(...paths); for (const p of sheet) used.add(p.kk);
    }
  }
  if (sheetsOut.length) {
    const multi = sheetsOut.length > 1;
    const nm = sh => `${sh.title ? safe(sh.title) + '-' : 'sheet-'}${sh.size}-${sh.n}`;
    for (const sh of sheetsOut) add(`03-STICKER-ARTWORK/${nm(sh)}.png`, sh.png, 'image/png', { note: `${sh.title ? sh.title + ': ' : ''}${sh.count} stickers on ${sh.size}` });
    for (const sh of sheetsOut) add(`03-STICKER-ARTWORK-TRANSPARENT/${nm(sh)}.png`, sh.tpng, 'image/png', { note: `Transparent PNG · ${sh.count} stickers · ${sh.size} page, same positions as the cut lines` });
    add('04-STICKER-CUTLINES.pdf', await cutPDF(sheetsOut.map(sh => ({ W: sh.W, H: sh.H, png: sh.png, paths: sh.paths, marks: sh.marks })), s, { title: `${o.id} sticker cut lines` }), 'application/pdf');
    for (const sh of sheetsOut) add(`05-STICKER-CUTLINES${multi ? `-${nm(sh)}` : ''}.svg`, Buffer.from(cutSVG(sh.W, sh.H, sh.paths, sh.marks, s, `${o.id} ${sh.title || 'sticker'} cut lines ${sh.size} ${sh.n}`)), 'image/svg+xml');
    const seen = new Map();   // one transparent file and one proof per sticker printed; a sticker used at two sizes gets the size in its name
    for (const kk of used) seen.set(kk.split('@')[0], (seen.get(kk.split('@')[0]) || 0) + 1);
    for (const kk of used) { const sh = shapes.get(kk); if (!sh || sh.error) continue; const c0 = kk.split('@')[0], code = seen.get(c0) > 1 ? `${c0}-${Math.round(+kk.split('@')[1])}mm` : c0;
      add(`12-TRANSPARENT-ARTWORK/${safe(code)}.png`, await sharp(sh.buf).ensureAlpha().resize(px(sh.art.w, s.dpi), px(sh.art.h, s.dpi), { fit: 'fill' }).png().withMetadata({ density: s.dpi }).toBuffer(), 'image/png');
      const PW = Math.max(px(sh.w, 150), px(sh.art.x, 150) + px(sh.art.w, 150)) + 2, PH = Math.max(px(sh.h, 150), px(sh.art.y, 150) + px(sh.art.h, 150)) + 2;   // rounding never crops the art
      const proof = await sharp({ create: { width: PW, height: PH, channels: 4, background: '#ffffff' } }).composite([{ input: await sharp(sh.buf).resize(px(sh.art.w, 150), px(sh.art.h, 150), { fit: 'fill' }).png().toBuffer(), left: px(sh.art.x, 150), top: px(sh.art.y, 150) },
        { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW / 150 * 25.4} ${PH / 150 * 25.4}"><path d="${svgPath(sh.path)}" fill="none" stroke="#FF00FF" stroke-width="0.35"/></svg>`), left: 0, top: 0 }]).png().toBuffer();
      add(`13-INDIVIDUAL-DESIGNS/${safe(code)}-with-cutline.png`, proof, 'image/png'); }
    check('Transparent sheets', sheetsOut.every(x => x.tpng && x.tpng.length), `${sheetsOut.length} transparent PNG sheet${sheetsOut.length > 1 ? 's' : ''}`);
    check('Sticker contours are closed vector paths', stickerPaths.every(closedOk), `${stickerPaths.length} paths`);
    check('Sticker transparency', [...shapes.values()].every(x => x.error || x.transparent), [...shapes.values()].filter(x => !x.error && !x.transparent).length ? 'Some stickers have no transparency: rounded-rectangle cut used' : 'All stickers transparent', true);
    check('Registration marks', !s.regMarks || sheetsOut.every(x => x.marks.length === 3), s.regMarks ? '3 marks per sheet' : 'off in settings');
    check('No overlaps on sheets', true, `spacing ${s.spacing} mm, shelf nesting (arranged sheets checked separately)`);
  }

  // ---- laptop skins + keyboard from verified templates only ----
  const T = plan.template, skinPaths = [], skinPages = [], kbPages = [], kbPaths = [];
  for (const it of job.items.filter(i => i.surface)) {
    const sp = plan.surfaces[it.surface]; if (!sp || !sp.ready) { check(`${SN[it.surface]} template`, false, `${SN[it.surface]}: needs manual verification (${sp ? sp.why : 'no template'}). No file was generated.`, true); continue; }
    const x = T.surfaces[it.surface]; check(`${SN[it.surface]} template`, true, `${plan.model.name} template v${T.version} (verified)`);
    let src, tr = null, name = it.design;
    if (it.design === 'customer-artwork') { const a = (o.design && o.design.art || []).find(a => a.surface === it.surface); if (!a) { check(`${SN[it.surface]} artwork`, false, 'Customer artwork missing from the order'); continue; } src = { buf: await assets.fetch(a.url) }; tr = a.t; name = 'customer-artwork'; }
    else if (/^s-/.test(it.design)) src = { color: { 's-black': '#121213', 's-white': '#f2f2f0', 's-sand': '#d8cbb6', 's-red': '#6e1a1f' }[it.design] || '#121213' };
    else { try { src = { buf: await assets.fetch(assets.skinSrc(it.design)) }; } catch (e) { check(`${SN[it.surface]} artwork`, false, `Skin artwork ${it.design} could not be loaded`); continue; } }
    const surfKey = it.surface === 'pad' ? 'pad' : it.surface, B = x.bleed || 0, r = await renderSurface(src, x.w, x.h, B, tr, s.dpi);
    if (src.buf) { const m = await sharp(src.buf).metadata(), dpi = Math.min(m.width / ((x.w + 2 * B) / 25.4 * (tr && tr.z || 1)), m.height / ((x.h + 2 * B) / 25.4 * (tr && tr.z || 1)));
      check(`${SN[it.surface]} artwork resolution`, dpi >= s.skinDpiMin, `${Math.round(dpi)} dpi at print size (minimum ${s.skinDpiMin})`, true); }
    // cut lines: outline shrunk by the cut offset, cutouts grown by it; positions shifted by the bleed
    const shift = p => p.map(([a, b]) => [a + B, b + B]), outline = shift(shapePts({ type: 'rect', x: 0, y: 0, w: x.w, h: x.h, r: x.r }, -(x.offset || 0))), holes = (x.cutouts || []).map(c => shift(shapePts(c, x.offset || 0)));
    if (it.kind === 'keyboard' && x.keyboard) {
      const keys = x.keyboard.keys.map(k => ({ k, p: shift(shapePts(k, -(x.offset || 0))) }));
      add('09-KEYBOARD-ARTWORK/keyboard-deck.png', r.png, 'image/png');
      for (const [i, { k }] of keys.entries()) { const bb = k.pts ? (() => { const xs = k.pts.map(p => p[0]), ys = k.pts.map(p => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; })() : k;
        const ex = { left: px(bb.x + B, s.dpi), top: px(bb.y + B, s.dpi), width: px(bb.w, s.dpi), height: px(bb.h, s.dpi) };
        add(`09-KEYBOARD-ARTWORK/keys/${String(i + 1).padStart(3, '0')}-${safe(KEYN[k.label] || k.label)}.png`, await sharp(r.png).extract(ex).png().withMetadata({ density: s.dpi }).toBuffer(), 'image/png'); }
      const paths = [outline, ...holes, ...keys.map(k => k.p)]; kbPaths.push(...paths);
      kbPages.push({ W: x.w + 2 * B, H: x.h + 2 * B, png: r.png, paths, marks: [], keys: keys.length });
      check('Keyboard: individual key cut paths', keys.length > 0 && keys.every(k => closedOk(k.p)), `${keys.length} keys, each its own closed path (${x.keyboard.layout})`);
    } else {
      add(`06-LAPTOP-SKIN-ARTWORK/${it.surface}-${safe(name)}.png`, r.png, 'image/png', { note: `${x.w} x ${x.h} mm + ${B} mm bleed` });
      if (name === 'customer-artwork' && (await sharp(src.buf).metadata()).hasAlpha) add(`12-TRANSPARENT-ARTWORK/${it.surface}-customer-artwork.png`, await sharp(src.buf).png().toBuffer(), 'image/png');
      const paths = [outline, ...holes]; skinPaths.push(...paths); skinPages.push({ W: x.w + 2 * B, H: x.h + 2 * B, png: r.png, paths, marks: [], surface: it.surface });
    }
    check(`${SN[it.surface]} cut paths closed`, [outline, ...holes].every(closedOk), `outline + ${holes.length} cutouts, offset ${x.offset || 0} mm`);
    check(`${SN[it.surface]} bleed`, B >= 0, `${B} mm`);
  }
  if (skinPages.length) { add('07-LAPTOP-SKIN-CUTLINES.pdf', await cutPDF(skinPages, s, { title: `${o.id} laptop skin cut lines` }), 'application/pdf');
    for (const pg of skinPages) add(`08-LAPTOP-SKIN-CUTLINES${skinPages.length > 1 ? '-' + pg.surface : ''}.svg`, Buffer.from(cutSVG(pg.W, pg.H, pg.paths, [], s, `${o.id} ${SN[pg.surface]} cut lines`)), 'image/svg+xml'); }
  if (kbPages.length) { add('10-KEYBOARD-KEY-CUTLINES.pdf', await cutPDF(kbPages, s, { title: `${o.id} keyboard key cut lines` }), 'application/pdf');
    add('11-KEYBOARD-KEY-CUTLINES.svg', Buffer.from(cutSVG(kbPages[0].W, kbPages[0].H, kbPages[0].paths, [], s, `${o.id} keyboard key cut lines`)), 'image/svg+xml'); }

  // ---- general order sheet (PNG) + summary + instructions ----
  const W = 2480, H = 3508, lines = [], thumbs = [];
  lines.push([`<b>Skin Lab · ${escM(o.id)}</b>`, 92, true]);
  lines.push([`Customer: <b>${escM(o.name)}</b>   ·   Ordered ${new Date(o.at).toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}   ·   Paid ${o.paid ? new Date(o.paid.at).toLocaleDateString('en-GB') : '—'}`, 40]);
  lines.push([`Laptop: <b>${escM(job.laptop || 'none (stickers only)')}</b>${plan.template ? `   ·   template v${plan.template.version} (${plan.template.status})` : ''}`, 40]);
  lines.push([`Surfaces: <b>${escM(job.surfaces.map(x => SN[x]).join(', ') || '—')}</b>`, 40]);
  lines.push(['<b>Products</b>', 52]); for (const it of job.items) lines.push([`${it.q} ×  ${escM(it.label)}  <span foreground="#777">(${escM(it.kind)}${it.size ? ', ' + it.size : ''})</span>`, 36]);
  lines.push(['<b>Printing requirements</b>', 52]);
  if (sheetsOut.length) lines.push([`${sheetsOut.length} sticker sheet(s): ${[...new Set(sheetsOut.map(x => x.size))].join(', ')} · ${s.cutMode === 'die' ? 'die cut' : 'kiss cut'} · cut offset ${s.cutOffset} mm · spot colour ${escM(s.spot)}`, 36]);
  for (const pg of skinPages) lines.push([`${SN[pg.surface]}: ${pg.W.toFixed(1)} × ${pg.H.toFixed(1)} mm incl. bleed · print, laminate, cut on the ${escM(s.spot)} line`, 36]);
  for (const pg of kbPages) lines.push([`Keyboard: ${pg.keys} keys cut individually · deck ${pg.W.toFixed(1)} × ${pg.H.toFixed(1)} mm`, 36]);
  for (const w of warnings) lines.push([`⚠ ${escM(w)}`, 34]);
  lines.push(['<b>Production notes</b>', 52]); lines.push([escM(o.note || 'None from the customer.'), 36]);
  const layers = []; let y = 140;
  for (const [m, size, big] of lines) { const im = await textImg(`<span foreground="#111111">${m}</span>`, W - 240, size, !!big); const mm = await sharp(im).metadata(); layers.push({ input: im, left: 120, top: y }); y += mm.height + (big ? 40 : 18); }
  for (const p of [...sheetsOut.map(x => x.png), ...skinPages.map(x => x.png), ...kbPages.map(x => x.png)].slice(0, 6)) thumbs.push(await sharp(p).resize(700, 700, { fit: 'inside', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer());
  let tx = 120, ty = Math.min(y + 40, H - 760); for (const t of thumbs) { const mm = await sharp(t).metadata(); if (tx + mm.width > W - 120) { tx = 120; ty += 740; } if (ty + mm.height > H - 60) break; layers.push({ input: t, left: tx, top: ty }); tx += mm.width + 40; }
  const general = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(layers).png().withMetadata({ density: 300 }).toBuffer();
  add('01-GENERAL-ORDER.png', general, 'image/png');
  const summary = [['Order', [`Order ${o.id} · ${o.name} · ${o.loc || ''}`, `Ordered ${new Date(o.at).toUTCString()} · paid ${o.paid ? new Date(o.paid.at).toUTCString() : '-'}`, `Laptop: ${job.laptop || 'none'}${plan.template ? ` (template v${plan.template.version}, ${plan.template.status})` : ''}`]],
    ['Products', job.items.map(i => `${i.q} x ${i.label} [${i.kind}${i.surface ? ', ' + SN[i.surface] : ''}${i.size ? ', ' + i.size : ''}]`)],
    ['Validation', checks.map(c => `${c.level === 'ok' ? 'OK  ' : c.level === 'warn' ? 'WARN' : 'FAIL'}  ${c.check}${c.msg ? ': ' + c.msg : ''}`)]];
  add('02-PRODUCTION-SUMMARY.pdf', await textPDF(`${o.id} production summary`, summary), 'application/pdf');
  const howto = [['Files', ['01 General order: what the whole order is. Not a print file.', '03 Sticker artwork: print at 100% (no scaling) on the sheet size in the file name.', '03 Transparent: the same sheet with no background (transparent PNG, no registration marks), in the same positions as the cut lines. Also in the separate TRANSPARENT-PNG-PACKAGE ZIP with every sticker as its own transparent PNG.', '04/05 Sticker cut lines: same page size, registration marks in the corners, cut on the spot colour layer.', '06 Skin artwork includes the bleed; 07/08 are the matching cut lines.', '09 Keyboard deck artwork and one file per key; 10/11 cut every key on its own path.', '12 Transparent artwork, 13 each design with its cut line for checking.']],
    ['Cutting', [`Spot colour / layer name: ${s.spot}. ${s.cutMode === 'die' ? 'Die cut: through sticker and backing.' : 'Kiss cut: through the sticker vinyl only, not the backing.'}`, `Sticker cut offset ${s.cutOffset} mm from the artwork. Spacing ${s.spacing} mm. Margins ${s.margin} mm.`, 'Skins: the outline is cut inside the surface edge by the template offset; cutouts are grown by it.', 'Check your cutter settings (blade, force, speed) on a test piece first: settings differ per machine and vinyl.']],
    ['Printing', [`Resolution ${s.dpi} dpi. Print at actual size. Laminate skins before cutting.`, s.regMarks ? 'Registration marks: three 5 mm squares (top-left, top-right, bottom-left). Use your cutter\'s print-and-cut mark detection.' : 'Registration marks are off in the settings.']],
    ...(warnings.length ? [['Needs attention before production', warnings]] : [])];
  add('14-PRODUCTION-INSTRUCTIONS.pdf', await textPDF(`${o.id} production instructions`, howto), 'application/pdf');

  // ---- integrity + ZIP ----
  for (const f of files) { try { if (f.type === 'image/png') await sharp(f.buf).metadata(); else if (f.type === 'application/pdf') await PDFDocument.load(f.buf); } catch (e) { check(`File ${f.name}`, false, 'file does not open: ' + e.message); } }
  check('Files open and match their checksum', !checks.some(c => c.check.startsWith('File ') && !c.ok), `${files.length} files`);
  const zipIn = {}; for (const f of files) zipIn[`${root}/${f.name}`] = [new Uint8Array(f.buf), { level: f.type === 'image/png' ? 0 : 6 }];
  const zip = Buffer.from(zipSync(zipIn));
  // the printer's transparent PNG package: every sheet and every sticker on a transparent background, nothing else
  const troot = `${o.id}-TRANSPARENT-PNG-PACKAGE`, tIn = {};
  for (const f of files) if (/^03-STICKER-ARTWORK-TRANSPARENT\//.test(f.name)) tIn[`${troot}/SHEETS/${f.name.split('/').pop()}`] = [new Uint8Array(f.buf), { level: 0 }];
  else if (/^12-TRANSPARENT-ARTWORK\//.test(f.name)) tIn[`${troot}/STICKERS/${f.name.split('/').pop()}`] = [new Uint8Array(f.buf), { level: 0 }];
  const tzip = Object.keys(tIn).length ? Buffer.from(zipSync(tIn)) : null;
  return { files, zip, tzip, troot, checks, warnings, root, ms: Date.now() - t0, blocked: checks.some(c => c.level === 'error'), partial: warnings.some(w => /manual verification/.test(w)) };
}
// store every file privately + the ZIP; returns the records kept on the job
export async function storePackage(id, version, pk) {
  const dir = `${id}/v${version}`, out = [];
  for (const f of pk.files) { await putPrivate(`${dir}/${f.name}`, f.buf, f.type); out.push({ name: f.name, path: `${dir}/${f.name}`, type: f.type, bytes: f.bytes, sha256: f.sha256, note: f.note || '' }); }
  await putPrivate(`${dir}/${pk.root}.zip`, pk.zip, 'application/zip');
  if (pk.tzip) { await putPrivate(`${dir}/${pk.troot}.zip`, pk.tzip, 'application/zip');
    out.unshift({ name: `${pk.troot}.zip`, path: `${dir}/${pk.troot}.zip`, type: 'application/zip', bytes: pk.tzip.length, sha256: sha(pk.tzip), pkg: 'transparent', note: 'Every sheet and every sticker as a transparent PNG' }); }
  out.unshift({ name: `${pk.root}.zip`, path: `${dir}/${pk.root}.zip`, type: 'application/zip', bytes: pk.zip.length, sha256: sha(pk.zip), zip: true });
  return out;
}
