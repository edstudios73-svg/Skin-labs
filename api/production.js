// /api/production : the Print Production system. One production job per PAID order (production/<orderId>/doc-*.json).
// Two roles, enforced here (not only in the page):
//   General Administrator  = owner / payments login: sees every job, its progress, files and checks. Never downloads files.
//   Printing Administrator = printer login: everything above + downloads + moves the job through production.
import { json, role, adminName, findOrder, saveOrder, allOrders, saveDoc, loadDoc, loadDocs, limited } from './_lib.js';

export const STAGES = ['new', 'generating', 'files-ready', 'downloaded', 'printing', 'cutting', 'qc', 'completed', 'dispatch'];
export const STAGE_NAME = { new: 'New order', generating: 'Files generating', 'files-ready': 'Files ready', downloaded: 'Downloaded', printing: 'Printing', cutting: 'Cutting', qc: 'Quality check', completed: 'Completed', dispatch: 'Ready for collection / dispatch', failed: 'Generation failed' };
// the customer's tracking page follows production (order statuses already used by the shop)
const ORDER_STEP = { generating: 'artwork', 'files-ready': 'artwork', downloaded: 'artwork', printing: 'printing', cutting: 'printing', qc: 'qc', completed: 'ready', dispatch: 'ready' };
const GENERAL = new Set(['owner', 'payments']);

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

export default async function handler(req, res) {
  const who = role(req);
  if (!who) return limited(req, 'login-fail', 8, 15 * 60e3) ? json(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes' }) : json(res, 401, { error: 'Wrong password' });
  const isPrinter = who === 'printer', by = `${adminName(req)} (${isPrinter ? 'Printing Admin' : 'General Admin'})`, q = req.query || {}, b = req.body || {};
  if (req.method === 'GET' && q.a === 'me') return json(res, 200, { role: isPrinter ? 'printing' : 'general', login: who, canDownload: isPrinter, canManageTemplates: GENERAL.has(who) });
  if (req.method === 'GET' && q.a === 'jobs') {
    const orders = (await allOrders()).filter(o => o.paid);
    const jobs = await Promise.all(orders.map(async o => summary(await ensureJob(o), o)));
    return json(res, 200, { jobs, stages: STAGES, names: STAGE_NAME });
  }
  const id = String(q.id || b.id || '').toUpperCase(); if (!/^SL-[2-9A-Z]{5}$/.test(id)) return json(res, 400, { error: 'Bad order id' });
  const f = await findOrder(id); if (!f || !f.order.paid) return json(res, 404, { error: 'No paid order with that number' });
  const o = f.order, job = await ensureJob(o);
  if (req.method === 'GET' && q.a === 'job') {
    const order = { id: o.id, at: o.at, name: o.name, loc: o.loc, note: o.note, packs: o.packs, singles: o.singles, free: o.free, picks: o.picks ? { ...o.picks, layout: undefined } : null,
      design: o.design ? { laptop: o.design.laptop, packName: o.design.packName, size: o.design.size, n: o.design.n, skins: o.design.skins, sheet: o.design.sheet, mock: o.design.mock, art: o.design.art, skinSize: o.design.skinSize } : null,
      paid: { at: o.paid.at, channel: o.paid.channel, ...(isPrinter ? {} : { amount: o.paid.amount }) }, ...(isPrinter ? {} : { phone: o.phone, total: o.total }), status: o.status };
    return json(res, 200, { job: isPrinter ? job : forGeneral(job), order, names: STAGE_NAME, stages: STAGES });
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
  if (b.a === 'download') {   // file links are only ever handed to the Printing Administrator
    if (!isPrinter) return json(res, 403, { error: 'Production files are downloaded by the Printing Administrator only' });
    return json(res, 409, { error: 'No production files yet' });   // filled in when generation lands
  }
  return json(res, 400, { error: 'Unknown request' });
}
