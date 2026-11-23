// /api/skins : laptop skins the owner adds from /admin (any number at once).
// For every picture the server does the work: shapes it to a laptop lid (3:2), makes the shop sizes (2400 x 1600 and
// 600 x 400, WebP + AVIF) and a 4800 x 3200 print master, checks print quality, suggests a name and a category, and
// prices it by laptop size like every other skin. Nothing shows in the shop until the owner presses Publish.
// GET            -> { skins: [published] }                       (public, used by the shop and the studio)
// GET ?f=<file>  -> redirect to the stored picture                (vercel.json sends /skins/sk-* and /print/skins/sk-* here)
// POST (owner)   {a: add | update | publish | unpublish | delete | list}
import sharp from 'sharp';
import { put, del, list, putPrivate, getPrivate } from './_blob.js';
import { json, isAdmin, limited, saveDoc, loadDocs, rid } from './_lib.js';
import PR from './_prices.js';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4.5mb' } } };
export const TAGS = { heroes: 'Marvel & heroes', anime: 'Anime', code: 'Coding', cars: 'Cars', girly: 'Girly', street: 'Street', art: 'Art & nature' };
export const FITS = { auto: 'Auto', crop: 'Fill the lid', rotate: 'Turn sideways', tile: 'Repeat across', whole: 'Whole picture' };
// one record per skin (skins-db/<id>/doc-<time>.json): many uploads at once never overwrite each other
const PUB = () => `${process.env.SUPABASE_URL}/storage/v1/object/public/blob/`;
let CACHE = null, CACHED = 0;
const load = async () => ({ skins: (await loadDocs('skins-db/')).sort((a, b) => b.at - a.at) });
const saveOne = async s => { await saveDoc(`skins-db/${s.id}`, s); CACHE = null; };
const dropOne = async s => { const { blobs } = await list({ prefix: `skins-db/${s.id}/` }); if (blobs.length) await del(blobs.map(b => b.url)).catch(() => {}); CACHE = null; };
const str = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'skin';

// ---------- picture analysis: colours, light, detail -> a name and a category to start from ----------
const HUES = [[0, 'Red'], [18, 'Ember'], [32, 'Orange'], [45, 'Gold'], [58, 'Lemon'], [80, 'Lime'], [120, 'Green'], [160, 'Jade'], [185, 'Teal'], [200, 'Sky'], [220, 'Blue'], [240, 'Cobalt'], [262, 'Indigo'], [280, 'Violet'], [300, 'Purple'], [322, 'Magenta'], [338, 'Pink'], [352, 'Rose'], [361, 'Red']];
function hueName(h, s, l) {
  if (s < .14) return l < .18 ? 'Black' : l > .82 ? 'White' : l > .6 ? 'Silver' : 'Grey';
  if (l > .78 && s > .2) { if (h > 300 || h < 20) return 'Blush'; if (h < 70) return 'Cream'; if (h > 180 && h < 260) return 'Ice'; return 'Pastel'; }
  if (h >= 8 && h < 45 && l < .5) return s < .3 ? 'Taupe' : 'Mocha';   // browns read as brown, not red or orange
  let best = HUES[0]; for (const x of HUES) if (Math.abs(x[0] - h) < Math.abs(best[0] - h)) best = x; return best[1];
}
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l]; }
async function analyse(buf) {
  const { data, info } = await sharp(buf).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = {}, n = info.width * info.height; let L = 0, S = 0, edge = 0;
  for (let i = 0; i < n; i++) { const [h, s, l] = rgb2hsl(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]); L += l; S += s; const k = hueName(h, s, l); w[k] = (w[k] || 0) + (s < .14 ? .55 : 1);
    if (i % info.width) edge += Math.abs(l - rgb2hsl(data[i * 3 - 3], data[i * 3 - 2], data[i * 3 - 1])[2]); }
  L /= n; S /= n; edge /= n; const top = Object.entries(w).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return { light: L, sat: S, detail: edge, colours: top.slice(0, 3) };
}
function suggest(a, file, taken) {
  const fromFile = String(file || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  const camera = /^(img|dsc|pxl|screenshot|whatsapp|image|photo|wp|fb|ig|mvimg|signal)\b|^\d|[0-9a-f]{8}-|^[\w]{20,}$/i.test(fromFile) || !/[a-z]{3}/i.test(fromFile);
  let name;
  if (!camera && fromFile.length >= 3) name = fromFile.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 34);
  else {
    const [c1, c2] = a.colours, noun = a.detail > .09 ? (a.sat > .45 ? 'Burst' : 'Collage') : a.detail > .05 ? (a.light < .3 ? 'Night' : 'Pattern') : a.light < .28 ? 'Shadow' : a.sat < .15 ? 'Mono' : 'Flow';
    const pair = c2 && c2 !== c1 && !(c1 === 'Black' && noun === 'Night') ? `${c1} & ${c2}` : c1;
    name = `${pair} ${noun}`;
  }
  let n = name, i = 2; while (taken.has(n.toLowerCase())) n = `${name} ${['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII'][i++] || i}`; return n;
}
const guessTag = a => (a.colours.slice(0, 2).some(c => ['Pink', 'Blush', 'Rose', 'Pastel', 'Magenta'].includes(c)) && a.light > .45 ? 'girly' : 'art');

// ---------- shaping: every picture becomes a 3:2 laptop lid ----------
async function cover32(img) { const m = await sharp(img).metadata(); let w = m.width, h = Math.round(w * 2 / 3); if (h > m.height) { h = m.height; w = Math.round(h * 1.5); }
  return sharp(img).extract({ left: Math.round((m.width - w) / 2), top: Math.round((m.height - h) / 2), width: w, height: h }).toBuffer(); }
async function edgesPlain(img) {   // a calm border (e.g. black behind butterflies) means the picture can repeat without seams
  const { data, info } = await sharp(img).resize(40, 40, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }); let sum = 0, sq = 0, n = 0;
  for (let y = 0; y < 40; y++) for (const x of [0, 1, 38, 39]) { const i = (y * 40 + x) * 3, v = (data[i] + data[i + 1] + data[i + 2]) / 3; sum += v; sq += v * v; n++; }
  const mean = sum / n; return Math.sqrt(sq / n - mean * mean) < 18;
}
async function shape(src, fit) {
  const img = await sharp(src).rotate().toBuffer(), m = await sharp(img).metadata(), portrait = m.height > m.width * 1.05;
  let mode = fit === 'auto' ? (!portrait ? 'crop' : (await edgesPlain(img)) ? 'tile' : 'rotate') : fit;
  if (mode === 'rotate') return { buf: await cover32(await sharp(img).rotate(90).toBuffer()), mode };
  if (mode === 'tile') { const a = img, b = await sharp(img).flop().toBuffer(), H = m.height, n = Math.max(3, Math.ceil(H * 1.5 / m.width) + 1);
    const strip = await sharp({ create: { width: m.width * n, height: H, channels: 3, background: '#000' } }).composite([...Array(n)].map((_, i) => ({ input: i % 2 ? a : b, left: i * m.width, top: 0 }))).png().toBuffer();
    return { buf: await cover32(strip), mode }; }
  if (mode === 'whole') { const W = Math.max(m.width, Math.round(m.height * 1.5)), H = Math.round(W / 1.5);
    const bg = await sharp(img).resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: .55 }).toBuffer(), fg = await sharp(img).resize(W, H, { fit: 'inside' }).toBuffer(), fm = await sharp(fg).metadata();
    return { buf: await sharp(bg).composite([{ input: fg, left: Math.round((W - fm.width) / 2), top: Math.round((H - fm.height) / 2) }]).jpeg({ quality: 95 }).toBuffer(), mode }; }
  return { buf: await cover32(img), mode: 'crop' };
}
async function render(s, src) {   // all the files the shop, the studio and the printer need
  const { buf, mode } = await shape(src, s.fit), m = await sharp(buf).metadata(), v = Date.now().toString(36);
  const out = [[`skins/${s.id}.webp`, sharp(buf).resize(2400, 1600, { kernel: 'lanczos3' }).webp({ quality: 86 }), 'image/webp'], [`skins/${s.id}.avif`, sharp(buf).resize(2400, 1600).avif({ quality: 58, effort: 3 }), 'image/avif'],
    [`skins/${s.id}-s.webp`, sharp(buf).resize(600, 400).webp({ quality: 82 }), 'image/webp'], [`skins/${s.id}-s.avif`, sharp(buf).resize(600, 400).avif({ quality: 52, effort: 3 }), 'image/avif'],
    [`print/skins/${s.id}.jpg`, sharp(buf).resize(4800, 3200, { kernel: 'lanczos3' }).sharpen({ sigma: .6 }).jpeg({ quality: 92, mozjpeg: true }).withMetadata({ density: 300 }), 'image/jpeg']];
  await Promise.all(out.map(async ([p, pipe, t]) => put(p, await pipe.toBuffer(), { addRandomSuffix: false, contentType: t, allowOverwrite: true })));
  const dpi = Math.round(m.width / (38 / 2.54));   // across a large 17.3" lid (about 38 cm)
  Object.assign(s, { mode, w: m.width, h: m.height, dpi, quality: dpi >= 150 ? 'good' : dpi >= 100 ? 'ok' : 'low', v, thumb: `${PUB()}skins/${s.id}-s.webp?v=${v}`, big: `${PUB()}skins/${s.id}.webp?v=${v}` });
  return s;
}
const prices = () => ({ S: PR.skin.S, M: PR.skin.M, L: PR.skin.L });
const pub = s => ({ id: s.id, name: s.name, tag: s.tag, at: s.publishedAt || s.at });

export default async function handler(req, res) {
  const q = req.query || {};
  if (req.method === 'GET' && q.f) {   // /skins/sk-xxx(-s).webp|avif and /print/skins/sk-xxx.jpg -> the stored file
    const f = String(q.f); if (!/^(print\/skins\/)?sk-[a-z0-9-]{3,60}(-s)?\.(webp|avif|jpg)$/.test(f)) { res.statusCode = 404; return res.end('Not found'); }
    const path = f.startsWith('print/') ? f : `skins/${f}`; res.statusCode = 302; res.setHeader('Location', PUB() + path);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400'); return res.end();
  }
  if (req.method === 'GET') {
    if (!CACHE || Date.now() - CACHED > 20e3) { CACHE = await load(); CACHED = Date.now(); }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=300');
    return json(res, 200, { skins: CACHE.skins.filter(s => s.published).map(pub) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
  if (!isAdmin(req)) return limited(req, 'login-fail', 8, 15 * 60e3) ? json(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes and try again' }) : json(res, 401, { error: 'Only the owner adds skins' });
  const b = req.body || {}, c = b.a === 'add' ? null : await load(), find = () => c.skins.find(s => s.id === b.id);
  const reply = s => json(res, 200, { skin: s, prices: prices(), tags: TAGS, fits: FITS });
  if (b.a === 'list') return json(res, 200, { skins: c.skins, prices: prices(), tags: TAGS, fits: FITS });
  if (b.a === 'add') {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.img || '')); if (!m) return json(res, 400, { error: 'Send a JPG, PNG or WebP picture' });
    const src = Buffer.from(m[2], 'base64'); if (src.length > 4.2e6) return json(res, 413, { error: 'Picture too big' });
    let meta; try { meta = await sharp(src).metadata(); } catch (e) { return json(res, 400, { error: 'That file is not a picture we can read' }); }
    if (Math.min(meta.width, meta.height) < 300) return json(res, 400, { error: `Too small (${meta.width} × ${meta.height}). Use a picture at least 1200 pixels wide` });
    const a = await analyse(src), taken = new Set((await load()).skins.map(s => s.name.toLowerCase())), name = str(b.name, 40) || suggest(a, b.file, taken);
    const s = { id: `sk-${slug(name)}-${rid(4).toLowerCase()}`, name, tag: TAGS[b.tag] ? b.tag : guessTag(a), fit: FITS[b.fit] ? b.fit : 'auto', colours: a.colours, file: str(b.file, 80),
      srcW: meta.width, srcH: meta.height, published: false, at: Date.now() };
    await putPrivate(`skin-src/${s.id}.jpg`, await sharp(src).rotate().jpeg({ quality: 94 }).toBuffer(), 'image/jpeg');
    await render(s, src); if (b.publish === true) { s.published = true; s.publishedAt = Date.now(); }
    await saveOne(s); return reply(s);
  }
  const s = find(); if (!s) return json(res, 404, { error: 'No such skin' });
  if (b.a === 'update') {
    if (b.name !== undefined) { const n = str(b.name, 40); if (!n) return json(res, 400, { error: 'Give it a name' }); s.name = n; }
    if (b.tag !== undefined && TAGS[b.tag]) s.tag = b.tag;
    if (b.fit !== undefined && FITS[b.fit] && b.fit !== s.fit) { if (s.published) return json(res, 409, { error: 'Unpublish it first to change how it fits' }); s.fit = b.fit; await render(s, await getPrivate(`skin-src/${s.id}.jpg`)); }
    await saveOne(s); return reply(s);
  }
  if (b.a === 'publish' || b.a === 'unpublish') { s.published = b.a === 'publish'; if (s.published) s.publishedAt = Date.now(); await saveOne(s); return reply(s); }
  if (b.a === 'delete') {
    await dropOne(s);
    await del([`skins/${s.id}.webp`, `skins/${s.id}.avif`, `skins/${s.id}-s.webp`, `skins/${s.id}-s.avif`, `print/skins/${s.id}.jpg`].map(p => PUB() + p)).catch(() => {});
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'Unknown request' });
}
