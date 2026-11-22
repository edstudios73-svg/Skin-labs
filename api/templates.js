// /api/templates : production templates for laptop models, linked to the EXISTING laptop catalogue (laptops3d.json).
// The catalogue is never copied or changed: a template points at a model by its stable key (brand + model name) and
// adds what cutting needs (surface outlines, corners, cutouts, keyboard keys, bleed, cut offset) in millimetres.
// General Administrator: create, edit, verify.  Printing Administrator: read approved templates.
// A template is only used for automatic cutting files once it is VERIFIED; every edit makes a new version (draft again).
import { json, role, adminName, saveDoc, loadDoc, loadDocs, baseOf, limited } from './_lib.js';

export const lapKey = (brand, name) => `${brand} ${name}`.toLowerCase().normalize('NFKD').replace(/[″"]/g, 'in').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
export const SURFACES = ['lid', 'kb', 'pad', 'bot'];
let CAT = null, CATAT = 0;
export async function catalogue(req) {   // the shop's laptop list, read from the site itself (one source of truth)
  if (CAT && Date.now() - CATAT < 10 * 60e3) return CAT;
  const r = await fetch(`${baseOf(req)}/laptops3d.json`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('Laptop catalogue unavailable');
  const j = await r.json(); CAT = j.l.map((l, i) => ({ key: lapKey(l[0], l[1]), i, brand: l[0], name: l[1], scr: l[2], w: l[3], d: l[4], t: l[5] })); CATAT = Date.now(); return CAT;
}
export async function templateFor(req, laptopName) {   // by the model name stored on an order ("HP Victus 16 d")
  const cat = await catalogue(req), n = String(laptopName || '').toLowerCase();
  const m = cat.find(l => `${l.brand} ${l.name}`.toLowerCase() === n) || cat.find(l => `${l.brand} ${l.name.replace(/ \(.+\)$/, '')}`.toLowerCase() === n);
  if (!m) return { model: null, template: null };
  return { model: m, template: await loadDoc(`templates/${m.key}`) };
}
const num = (v, lo, hi) => { const x = +v; return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x * 100) / 100)) : null; };
function cleanShape(c) {
  if (c && Array.isArray(c.pts)) return { type: String(c.type || 'poly').slice(0, 20), label: String(c.label || '').slice(0, 12), pts: c.pts.slice(0, 40).map(p => [num(p[0], -10, 600), num(p[1], -10, 600)]) };
  return { type: String(c.type || 'rect').slice(0, 20), label: String(c.label || '').slice(0, 12), x: num(c.x, -10, 600), y: num(c.y, -10, 600), w: num(c.w, 0, 600), h: num(c.h, 0, 600), r: num(c.r, 0, 100) ?? 0 };
}
function clean(t) {
  const out = { surfaces: {}, notes: String(t.notes || '').slice(0, 1000) };
  for (const s of SURFACES) { const x = t.surfaces && t.surfaces[s]; if (!x || !x.on) continue;
    out.surfaces[s] = { on: true, w: num(x.w, 0, 600), h: num(x.h, 0, 600), r: num(x.r, 0, 100) ?? 0, bleed: num(x.bleed, 0, 10) ?? 2, offset: num(x.offset, -5, 5) ?? 0,
      cutouts: Array.isArray(x.cutouts) ? x.cutouts.slice(0, 60).map(cleanShape) : [],
      ...(s === 'kb' && x.keyboard ? { keyboard: { layout: x.keyboard.layout === 'ISO' ? 'ISO' : 'ANSI', pitch: num(x.keyboard.pitch, 10, 25), gap: num(x.keyboard.gap, 0, 6), x0: num(x.keyboard.x0, 0, 600), y0: num(x.keyboard.y0, 0, 600), fnH: num(x.keyboard.fnH, 4, 25), radius: num(x.keyboard.radius, 0, 5) ?? 1,
        keys: Array.isArray(x.keyboard.keys) ? x.keyboard.keys.slice(0, 140).map(cleanShape) : [] } } : {}) }; }
  return out;
}
// everything that must be true before a template may be used for automatic cutting
export function checkTemplate(t, model) {
  const errs = [], warn = [], S = t.surfaces || {};
  if (!Object.keys(S).length) errs.push('Turn on at least one surface');
  for (const [s, x] of Object.entries(S)) {
    const n = { lid: 'Lid', kb: 'Keyboard deck', pad: 'Trackpad', bot: 'Bottom' }[s];
    if (!(x.w > 0 && x.h > 0)) { errs.push(`${n}: width and height are required`); continue; }
    if (model && (s === 'lid' || s === 'bot') && (x.w > model.w * 10 + 3 || x.h > model.d * 10 + 3)) errs.push(`${n}: ${x.w} × ${x.h} mm is bigger than the laptop itself (${model.w * 10} × ${model.d * 10} mm in the catalogue)`);
    if (model && (s === 'lid' || s === 'bot') && (x.w < model.w * 10 * .8 || x.h < model.d * 10 * .8)) warn.push(`${n}: much smaller than the laptop (${model.w * 10} × ${model.d * 10} mm). Check the measurement`);
    if (x.r * 2 > Math.min(x.w, x.h)) errs.push(`${n}: corner radius is too large`);
    for (const c of x.cutouts || []) { const b = bbox(c); if (b.x < 0 || b.y < 0 || b.x + b.w > x.w || b.y + b.h > x.h) errs.push(`${n}: cutout "${c.label || c.type}" goes outside the surface`); }
    if (s === 'kb') { const k = x.keyboard;
      if (!k || !(k.keys || []).length) errs.push('Keyboard deck: no keyboard layout. Generate it, then adjust it to the real keyboard');
      else { for (const key of k.keys) { const b = bbox(key); if (b.x < 0 || b.y < 0 || b.x + b.w > x.w || b.y + b.h > x.h) { errs.push(`Keyboard: key "${key.label}" is outside the keyboard deck`); break; } }
        const bs = k.keys.map(bbox); outer: for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i], b = bs[j];
          if (a.x < b.x + b.w - .05 && b.x < a.x + a.w - .05 && a.y < b.y + b.h - .05 && b.y < a.y + a.h - .05 && !(k.keys[i].pts || k.keys[j].pts)) { errs.push(`Keyboard: keys "${k.keys[i].label}" and "${k.keys[j].label}" overlap`); break outer; } } } } }
  return { ok: !errs.length, errs, warn };
}
export const bbox = c => c.pts ? (() => { const xs = c.pts.map(p => p[0]), ys = c.pts.map(p => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; })()
  : (c.type === 'circle' ? { x: c.x - c.w / 2, y: c.y - c.w / 2, w: c.w, h: c.w } : { x: c.x, y: c.y, w: c.w, h: c.h });

export default async function handler(req, res) {
  const who = role(req); if (!who) return limited(req, 'login-fail', 8, 15 * 60e3) ? json(res, 429, { error: 'Too many wrong passwords' }) : json(res, 401, { error: 'Wrong password' });
  const general = who === 'owner' || who === 'payments', by = `${adminName(req)} (${general ? 'General Admin' : 'Printing Admin'})`, q = req.query || {}, b = req.body || {};
  if (req.method === 'GET' && q.a === 'list') {   // the whole catalogue with each model's template status
    const cat = await catalogue(req), docs = await loadDocs('templates/'), by_ = Object.fromEntries(docs.map(d => [d.laptop, d]));
    return json(res, 200, { laptops: cat.map(l => { const t = by_[l.key]; return { ...l, status: t ? t.status : 'none', version: t ? t.version : 0, surfaces: t ? Object.keys(t.surfaces || {}) : [] }; }) });
  }
  const key = String(q.key || b.key || ''); if (!/^[a-z0-9-]{3,90}$/.test(key)) return json(res, 400, { error: 'Unknown laptop' });
  const cat = await catalogue(req), model = cat.find(l => l.key === key); if (!model) return json(res, 404, { error: 'That laptop is not in the catalogue' });
  const cur = await loadDoc(`templates/${key}`);
  if (req.method === 'GET') { if (!general && cur && cur.status !== 'verified') return json(res, 200, { model, template: null, note: 'Only verified templates are shown to the Printing Administrator' });
    return json(res, 200, { model, template: cur, check: cur ? checkTemplate(cur, model) : null }); }
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
  if (!general) return json(res, 403, { error: 'Templates are managed by the General Administrator' });
  if (b.a === 'save') {
    const t = clean(b.template || {}), version = (cur ? cur.version : 0) + 1, now = Date.now();
    const doc = { laptop: key, catalogueIndex: model.i, brand: model.brand, name: model.name, version, status: 'draft', ...t, updatedAt: now, updatedBy: by,
      history: [...(cur ? cur.history || [] : []), { version, at: now, by, status: 'draft' }].slice(-50) };
    await saveDoc(`templates/${key}`, doc); return json(res, 200, { template: doc, check: checkTemplate(doc, model) });
  }
  if (b.a === 'verify') {
    if (!cur) return json(res, 400, { error: 'Save the template first' });
    if (+b.version !== cur.version) return json(res, 409, { error: 'The template changed since you opened it. Reload and check again' });
    const c = checkTemplate(cur, model); if (!c.ok) return json(res, 400, { error: 'This template cannot be verified yet', check: c });
    if (b.measured !== true) return json(res, 400, { error: 'Confirm the measurements were taken from the real laptop' });
    cur.status = 'verified'; cur.verifiedAt = Date.now(); cur.verifiedBy = by; cur.history.push({ version: cur.version, at: cur.verifiedAt, by, status: 'verified' });
    await saveDoc(`templates/${key}`, cur); return json(res, 200, { template: cur, check: c });
  }
  return json(res, 400, { error: 'Unknown request' });
}
