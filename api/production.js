// /api/production : the Print Production system. One production job per PAID order (production/<orderId>/doc-*.json).
// Two roles, enforced here (not only in the page):
//   General Administrator  = owner / payments login: sees every job, its progress, files and checks. Never downloads files.
//   Printing Administrator = printer login: everything above + downloads + moves the job through production.
import { json, role, adminName, findOrder, saveOrder, allOrders, saveDoc, loadDoc, loadDocs, limited } from './_lib.js';
import { templateFor, catalogue, checkTemplate } from './templates.js';
import { baseOf, SITE } from './_lib.js';
import { signPrivate } from './_blob.js';
import { waitUntil } from '@vercel/functions';
export const config = { maxDuration: 300 };

export const STAGES = ['new', 'generating', 'files-ready', 'downloaded', 'printing', 'cutting', 'qc', 'completed', 'dispatch'];
export const STAGE_NAME = { new: 'New order', generating: 'Files generating', 'files-ready': 'Files ready', downloaded: 'Downloaded', printing: 'Printing', cutting: 'Cutting', qc: 'Quality check', completed: 'Completed', dispatch: 'Ready for collection / dispatch', failed: 'Generation failed' };
// the customer's tracking page follows production (order statuses already used by the shop)
const ORDER_STEP = { generating: 'artwork', 'files-ready': 'artwork', downloaded: 'artwork', printing: 'printing', cutting: 'printing', qc: 'qc', completed: 'ready', dispatch: 'ready' };
const GENERAL = new Set(['owner', 'payments']);
export async function surfacePlan(req, job) {
  if (!job.surfaces.length) return { model: null, template: null, surfaces: {} };
  const { model, template } = job.laptop ? await templateFor(req, job.laptop) : { model: null, template: null };
  const ok = template && template.status === 'verified' && checkTemplate(template, model).ok, out = {};
  for (const s of job.surfaces) { const x = ok && template.surfaces[s];
    out[s] = x ? { ready: true, w: x.w, h: x.h, r: x.r, bleed: x.bleed, offset: x.offset, cutouts: (x.cutouts || []).length, keys: x.keyboard ? x.keyboard.keys.length : 0 }
      : { ready: false, why: !job.laptop ? 'Laptop model not given' : !model ? 'Model not found in the laptop catalogue' : !template ? 'No template for this model' : template.status !== 'verified' ? `Template v${template.version} is not verified` : `Template has no ${s} surface` }; }
  return { model: model && { key: model.key, name: `${model.brand} ${model.name}`, w: model.w, d: model.d }, template: template && { version: template.version, status: template.status }, surfaces: out };
}

// What production needs to know about an order. Built from the paid order only.
export function jobFromOrder(o) {
  const d = o.design || null, k = d && d.raw && d.raw.k || {};
  const items = [];
  for (const p of o.packs || []) {
    const key = String(p.key || ''); let m;
    if ((m = /^skin~([\w-]+)~([SMLC])$/.exec(key))) items.push({ kind: 'skin', surface: 'lid', design: m[1], q: p.q, label: p.label });
    else if ((m = /^kb~([\w-]+)$/.exec(key))) items.push({ kind: 'keyboard', surface: 'kb', design: m[1], q: p.q, label: p.label });
    else if ((m = /^(?:tp|ms)~([\w-]+)$/.exec(key))) items.push({ kind: 'skin', surface: 'pad', design: m[1], q: p.q, label: p.label });
    else if ((m = /^dc~([\w-]+)/.exec(key))) items.push({ kind: 'decal', design: m[1], q: p.q, label: p.label });
    else items.push({ kind: 'sticker-pack', design: key.replace(/~5$/, ''), size: /~5$/.test(key) ? 'A5' : (p.size || 'A4'), q: p.q, label: p.label });
  }
  if ((o.singles || []).length) items.push({ kind: 'singles', codes: o.singles.map(s => ({ code: s.code, q: s.q })), q: 1, label: 'Single stickers' });
  if (o.free && !o.free.onDesign) items.push({ kind: 'free-sticker', code: o.free.code, q: 1, label: 'Free sticker' });
  if (d) {
    const SN = { lid: 'Lid skin', kb: 'Keyboard skin', pad: 'Trackpad skin', bot: 'Bottom skin' }, nm = id => String(id).startsWith('up:') ? "customer's own artwork" : String(id).startsWith('s-') ? 'solid colour ' + String(id).slice(2) : String(id).replace(/^ph-/, '').replace(/-/g, ' ');
    for (const [surf, id] of Object.entries(k)) if (id) items.push({ kind: surf === 'kb' ? 'keyboard' : 'skin', surface: surf, design: String(id).startsWith('up:') ? 'customer-artwork' : id, q: 1, label: `${SN[surf] || surf} · ${nm(id)}`, custom: true });
    if (d.n) items.push({ kind: 'custom-stickers', n: d.n, size: d.size, q: 1, label: d.packName || 'Custom sticker pack' });
  }
  const surfaces = [...new Set(items.filter(i => i.surface).map(i => i.surface))];
  return { laptop: d && d.laptop || o.laptop || '', laptopIndex: d && d.raw && Number.isInteger(d.raw.li) ? d.raw.li : null, skinSize: d && d.skinSize || '', surfaces, items, art: (d && d.art) || [] };
}
export function newJob(o, by = 'System') {
  const now = Date.now();
  return { id: o.id, at: now, stage: 'new', failed: false, ...jobFromOrder(o), files: [], checks: [], warnings: [], gen: null, downloads: [],
    log: [{ at: now, by, stage: 'new', note: 'Paid order received' }] };
}
export async function ensureJob(o) {
  if (!o || !o.paid) return null;                       // only paid orders ever become production jobs
  const j = await loadDoc(`production/${o.id}`); if (j) return j;
  const nj = newJob(o, 'Paystack'); await saveDoc(`production/${o.id}`, nj); return nj;
}
// the General Administrator sees that files exist and pass their checks, never where they are
const forGeneral = j => ({ ...j, files: (j.files || []).map(({ path, url, ...f }) => f), downloads: (j.downloads || []).map(({ ip, ...d }) => d) });
const summary = (j, o) => ({ id: j.id, at: j.at, stage: j.stage, failed: !!j.failed, laptop: j.laptop, surfaces: j.surfaces, items: j.items.length, files: (j.files || []).length,
  warnings: (j.warnings || []).length, name: o ? String(o.name || '').split(' ')[0] : '', updated: (j.log || []).slice(-1)[0] || null, pic: o && o.design && (o.design.mock || o.design.sheet) || o && o.picks && o.picks.sheet || '' });

// ---------- file generation (runs in the background after payment, or when the Printing Administrator asks) ----------
let SHOP = null;
async function shopData(base) {   // the shop's own sticker data (data.<hash>.js) + packs added in the admin
  if (SHOP && Date.now() - SHOP.at < 10 * 60e3) return SHOP;
  const html = await (await fetch(base + '/')).text(), f = (html.match(/src="\/?(data\.[0-9a-f]{8}\.js)"/) || [])[1]; if (!f) throw new Error('shop data not found');
  const D = JSON.parse((await (await fetch(`${base}/${f}`)).text()).replace(/^window\.SL=/, '').replace(/;\s*$/, ''));
  const drops = await fetch(base + '/api/catalog/').then(r => r.ok ? r.json() : { packs: [] }).catch(() => ({ packs: [] }));
  const PK = Object.fromEntries(D.packs.map(p => [p.id, p])), URL_ = {};
  for (const d of drops.packs || []) { PK[d.id] = { id: d.id, name: d.name, size: 'A4', items: d.items.map(i => [i.code]), a5: d.items.slice(0, 14).map(i => i.code) }; for (const i of d.items) URL_[i.code] = i.url; }
  return SHOP = { at: Date.now(), PK, URL_ };
}
export async function generate(base, id, by = 'System') {
  const { produce, storePackage } = await import('./_produce.js');
  const f = await findOrder(id); if (!f || !f.order.paid) throw new Error('No paid order');
  const o = f.order, job = await ensureJob(o);
  if (job.stage === 'generating' && job.gen && Date.now() - job.gen.started < 5 * 60e3) return job;   // already running: never two at once
  job.stage = 'generating'; job.failed = false; job.gen = { started: Date.now(), by }; job.log.push({ at: Date.now(), by, stage: 'generating' }); await saveDoc(`production/${id}`, job);
  try {
    const fakeReq = { headers: { host: new URL(base).host }, __base: base }, shop = await shopData(base), plan = await surfacePlan(fakeReq, job);
    if (job.laptop) plan.template = (await templateFor(fakeReq, job.laptop)).template || plan.template;   // the full template, for drawing
    const abs = u => /^https?:/.test(u) ? u : base + u, cache = new Map();
    const assets = { pack: k => shop.PK[k], skinSrc: k => `/print/skins/${encodeURIComponent(k)}.jpg`,
      stickerSrc: c => /^XQV-/.test(c) ? `/free/${c}.webp` : shop.URL_[c] || `/hd/${encodeURIComponent(c)}.avif`,
      fetch: async u => { u = abs(u); if (cache.has(u)) return cache.get(u); const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`could not load the file ${decodeURIComponent(u.split('/').slice(-2).join('/'))} (${r.status === 404 ? 'it is missing from storage' : 'error ' + r.status}). Put the file back or ask the customer to resend it, then regenerate`); const b = Buffer.from(await r.arrayBuffer()); cache.set(u, b); return b; } };
    const pk = await produce({ order: o, job, plan, base, assets, settings: (await loadDoc('production-settings')) || {} });
    const version = (job.version || 0) + 1;
    job.version = version; job.files = await storePackage(id, version, pk); job.checks = pk.checks; job.warnings = pk.warnings;
    const err = pk.checks.filter(c => c.level === 'error');
    job.failed = err.length > 0; job.blocked = pk.partial ? 'needs-verification' : '';
    job.stage = !job.failed && !pk.partial ? 'files-ready' : 'new';
    job.gen = { ...job.gen, finished: Date.now(), ms: pk.ms, version, error: err.map(e => e.msg).join('; ').slice(0, 500) };
    job.log.push({ at: Date.now(), by: 'System', stage: job.failed ? 'failed' : job.stage, note: job.failed ? `Generation failed: ${job.gen.error}` : pk.partial ? `Files v${version} made for the verified parts only. ${pk.warnings.length} surface(s) need manual verification` : `Files v${version} ready · ${job.files.length} files · ${(pk.ms / 1000).toFixed(1)} s` });
  } catch (e) {
    job.failed = true; job.stage = 'new'; job.gen = { ...job.gen, finished: Date.now(), error: String(e.message || e).slice(0, 500), at: String(e.stack || '').split('\n').slice(1, 3).join(' | ').slice(0, 300) };
    job.log.push({ at: Date.now(), by: 'System', stage: 'failed', note: `Generation failed: ${job.gen.error}` });
  }
  await saveDoc(`production/${id}`, job); return job;
}
export const kickGenerate = (base, id) => { const p = generate(base, id, 'System').catch(() => null); try { waitUntil(p); } catch (e) {} return p; };

export default async function handler(req, res) {
  const who = role(req);
  if (!who) return limited(req, 'login-fail', 8, 15 * 60e3) ? json(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes' }) : json(res, 401, { error: 'Wrong password' });
  const isPrinter = who === 'printer', by = `${adminName(req)} (${isPrinter ? 'Printing Admin' : 'General Admin'})`, q = req.query || {}, b = req.body || {};
  if (req.method === 'GET' && q.a === 'me') return json(res, 200, { role: isPrinter ? 'printing' : 'general', login: who, canDownload: isPrinter, canManageTemplates: GENERAL.has(who) });
  if (q.a === 'subs' || b.a === 'sub') {   // customer artwork sent for the public catalogue: General Admin approves or rejects
    if (!GENERAL.has(who)) return json(res, 403, { error: 'Artwork submissions are reviewed by the General Administrator' });
    if (req.method === 'GET') return json(res, 200, { subs: await loadDocs('submissions/') });
    const sid = String(b.id || ''); if (!/^ART-[2-9A-Z]{6}$/.test(sid)) return json(res, 400, { error: 'Bad submission id' });
    const sub = await loadDoc(`submissions/${sid}`); if (!sub) return json(res, 404, { error: 'No such submission' });
    if (!['approved', 'rejected'].includes(b.decision)) return json(res, 400, { error: 'Approve or reject' });
    sub.status = b.decision; sub.note = String(b.note || '').slice(0, 300); (sub.log ||= []).push({ at: Date.now(), by, s: b.decision, note: sub.note });
    await saveDoc(`submissions/${sid}`, sub); return json(res, 200, { sub });
  }
  if (q.a === 'settings' || b.a === 'settings') {   // cutting / printing settings: General Admin edits, everyone reads
    const { DEFAULTS } = await import('./_produce.js'), cur = { ...DEFAULTS, ...((await loadDoc('production-settings')) || {}) };
    if (req.method === 'GET') return json(res, 200, { settings: cur, defaults: DEFAULTS, canEdit: GENERAL.has(who) });
    if (!GENERAL.has(who)) return json(res, 403, { error: 'Production settings are managed by the General Administrator' });
    const v = b.settings || {}, n = (x, lo, hi) => Number.isFinite(+x) ? Math.max(lo, Math.min(hi, +x)) : undefined;
    const next = { ...cur, cutMode: v.cutMode === 'die' ? 'die' : 'kiss', spot: String(v.spot || cur.spot).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'CutContour',
      cutOffset: n(v.cutOffset, 0, 6) ?? cur.cutOffset, spacing: n(v.spacing, 1, 20) ?? cur.spacing, margin: n(v.margin, 5, 30) ?? cur.margin, regMarks: v.regMarks !== false,
      regSize: n(v.regSize, 3, 10) ?? cur.regSize, stickerMm: n(v.stickerMm, 20, 150) ?? cur.stickerMm, xlMm: n(v.xlMm, 80, 280) ?? cur.xlMm, skinDpiMin: n(v.skinDpiMin, 72, 300) ?? cur.skinDpiMin,
      updatedAt: Date.now(), updatedBy: by };
    await saveDoc('production-settings', next); return json(res, 200, { settings: next });
  }
  if (req.method === 'GET' && q.a === 'jobs') {
    const orders = (await allOrders()).filter(o => o.paid);
    const jobs = await Promise.all(orders.map(async o => { const j = await ensureJob(o), sum = summary(j, o), plan = await surfacePlan(req, j).catch(() => ({ surfaces: {} }));
      sum.needVerify = Object.values(plan.surfaces).filter(x => !x.ready).length; sum.warnings += sum.needVerify; return sum; }));
    return json(res, 200, { jobs, stages: STAGES, names: STAGE_NAME });
  }
  const id = String(q.id || b.id || '').toUpperCase(); if (!/^SL-[2-9A-Z]{5}$/.test(id)) return json(res, 400, { error: 'Bad order id' });
  const f = await findOrder(id); if (!f || !f.order.paid) return json(res, 404, { error: 'No paid order with that number' });
  const o = f.order, job = await ensureJob(o);
  if (req.method === 'GET' && q.a === 'job') {
    const order = { id: o.id, at: o.at, name: o.name, loc: o.loc, note: o.note, packs: o.packs, singles: o.singles, free: o.free, picks: o.picks ? { ...o.picks, layout: undefined } : null,
      design: o.design ? { laptop: o.design.laptop, packName: o.design.packName, size: o.design.size, n: o.design.n, skins: o.design.skins, sheet: o.design.sheet, mock: o.design.mock, art: o.design.art, skinSize: o.design.skinSize } : null,
      paid: { at: o.paid.at, channel: o.paid.channel, ...(isPrinter ? {} : { amount: o.paid.amount }) }, ...(isPrinter ? {} : { phone: o.phone, total: o.total }), status: o.status };
    const plan = await surfacePlan(req, job).catch(e => ({ error: e.message, surfaces: {} }));
    return json(res, 200, { job: isPrinter ? job : forGeneral(job), order, plan, names: STAGE_NAME, stages: STAGES });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
  if (b.a === 'stage') {   // the Printing Administrator moves the job; every change is recorded with who and when
    if (!isPrinter) return json(res, 403, { error: 'Only the Printing Administrator updates production' });
    if (!STAGES.includes(b.stage)) return json(res, 400, { error: 'Unknown production stage' });
    if (['generating', 'files-ready'].includes(b.stage)) return json(res, 400, { error: 'Files are generated by the system' });
    if (['downloaded', 'printing', 'cutting'].includes(b.stage) && job.stage !== b.stage && !(job.files || []).length) return json(res, 409, { error: 'No production files yet. Generate them first' });
    job.stage = b.stage; job.log.push({ at: Date.now(), by, stage: b.stage, ...(b.note ? { note: String(b.note).slice(0, 300) } : {}) });
    const os = ORDER_STEP[b.stage];
    if (os && o.status !== os && !['cancelled', 'refunded', 'refund-review', 'delivered', 'on-the-way'].includes(o.status)) { o.status = os; (o.history ||= []).push({ s: os, at: Date.now(), by }); await saveOrder(f.dir, o); }
    await saveDoc(`production/${id}`, job);
    return json(res, 200, { job });
  }
  if (b.a === 'note') { job.log.push({ at: Date.now(), by, stage: job.stage, note: String(b.note || '').slice(0, 500) }); await saveDoc(`production/${id}`, job); return json(res, 200, { job: isPrinter ? job : forGeneral(job) }); }
  if (b.a === 'download') {   // file links are only ever handed to the Printing Administrator: short-lived, signed, private
    if (!isPrinter) return json(res, 403, { error: 'Production files are downloaded by the Printing Administrator only' });
    const want = String(b.name || ''), fl = (job.files || []).find(x => want ? x.name === want : x.zip); if (!fl) return json(res, 404, { error: (job.files || []).length ? 'That file is not in this package' : 'No production files yet. Generate them first' });
    const fname = fl.zip ? fl.name : `${id}-${fl.name.split('/').pop()}`, url = await signPrivate(fl.path, 900, fname);
    (job.downloads ||= []).push({ at: Date.now(), by, name: fl.name }); job.downloads = job.downloads.slice(-100);
    if (fl.zip && job.stage === 'files-ready') { job.stage = 'downloaded'; job.log.push({ at: Date.now(), by, stage: 'downloaded', note: 'Complete package downloaded' }); }
    await saveDoc(`production/${id}`, job);
    return json(res, 200, { url, name: fname, bytes: fl.bytes, sha256: fl.sha256, type: fl.type });
  }
  if (b.a === 'generate') {
    if (!isPrinter) return json(res, 403, { error: 'The Printing Administrator generates production files' });
    if (job.stage === 'generating' && job.gen && Date.now() - job.gen.started < 5 * 60e3) return json(res, 409, { error: 'Files are already being generated' });
    const done = await generate(baseOf(req), id, by); return json(res, 200, { job: done });
  }
  return json(res, 400, { error: 'Unknown request' });
}
