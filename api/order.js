// POST /api/order : a customer checks out. The server prices the cart from its own list and saves it as a CHECKOUT
// (checkouts/<id>-<secret>/), then starts the Paystack payment. Staff never see a checkout: the order is created in
// orders/ only after Paystack confirms the payment (confirmPayment in _lib.js), so unpaid carts never reach the admin.
import { put } from './_blob.js';
import { list } from './_blob.js';
import { catalogue } from './templates.js';
import { json, newId, secret, saveCheckout, startPayment, baseOf, payOn, priceOrder, limited, ghPhone, SITE } from './_lib.js';
import PR from './_prices.js';

const img = (d, max) => { if (typeof d !== 'string' || !d.startsWith('data:image/jpeg;base64,')) return null; const b = Buffer.from(d.slice(23), 'base64'); return b.length && b.length <= max ? b : null; };
const str = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!payOn()) return json(res, 503, { error: 'Online payment is switched off right now, so we cannot take orders here. Chat with us on WhatsApp and we will help you order', wa: true });
  if (limited(req, 'order', 30, 10 * 60e3)) return json(res, 429, { error: 'Too many orders from this phone in a short time. Wait a few minutes, or chat with us on WhatsApp' });
  const b = req.body || {};
  const name = str(b.name, 60), phone = ghPhone(b.phone), loc = str(b.loc, 80), note = str(b.note, 300);
  const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(str(b.email, 120)) ? str(b.email, 120) : '';
  if (name.length < 2) return json(res, 400, { error: 'Add your name', field: 'name' });
  if (!phone) return json(res, 400, { error: 'That WhatsApp number does not look right. Use e.g. 024 123 4567', field: 'phone' });
  const packs = Array.isArray(b.packs) ? b.packs.slice(0, 40).map(p => ({ key: str(p.key, 80), label: str(p.label, 90), size: str(p.size, 4), n: +p.n || 0, q: Math.max(1, Math.min(20, +p.q || 1)), price: 0 })) : [];
  const singles = Array.isArray(b.singles) ? b.singles.slice(0, 300).map(s => ({ code: str(s.code, 12), q: Math.max(1, Math.min(99, +s.q || 1)), pack: str(s.pack, 60), img: /^https:\/\//.test(s.img || '') ? str(s.img, 300) : '' })) : [];
  const d = b.design && typeof b.design === 'object' ? b.design : null;
  if (!packs.length && !singles.length && !d) return json(res, 400, { error: 'The cart is empty' });
  const design = d ? { line: str(d.line, 300), laptop: str(d.laptop, 80), packName: str(d.packName, 60), size: str(d.size, 4), n: +d.n || 0, skins: Array.isArray(d.skins) ? d.skins.slice(0, 4).map(x => str(x, 40)) : [], skinSize: /^[SMLC]$/.test(d.skinSize) ? d.skinSize : '',
    layout: Array.isArray(d.layout) ? d.layout.slice(0, 300) : [], scaled: !!d.scaled, raw: d.raw && typeof d.raw === 'object' ? d.raw : null } : null;
  if (design && Array.isArray(d.art) && d.art.length) {   // the customer's own pictures, one per surface, with how they were placed
    const art = [];
    for (const a of d.art.slice(0, 4)) {
      const path = String(a && a.path || ''); if (!/^uploads\/[a-z0-9]{20}\/art\.(jpg|png)$/.test(path)) return json(res, 400, { error: 'Your picture did not upload. Try again' });
      const { blobs } = await list({ prefix: path.slice(0, path.lastIndexOf('/') + 1) }); const blob = blobs.find(x => x.pathname === path); if (!blob) return json(res, 400, { error: 'Your picture did not upload. Try again' });
      const t = a.t && typeof a.t === 'object' ? a.t : {}, n = (v, lo, hi, df) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : df;
      art.push({ surface: ['lid', 'kb', 'pad', 'bot'].includes(a.surface) ? a.surface : 'lid', url: blob.url, path, name: str(a.name, 60), w: Math.round(+a.w) || 0, h: Math.round(+a.h) || 0,
        t: { z: n(t.z, .1, 8, 1), x: n(t.x, -3, 3, 0), y: n(t.y, -3, 3, 0), r: n(t.r, -360, 360, 0), fit: t.fit === 'contain' ? 'contain' : 'cover' } });
    }
    design.art = art;
  }
  // the skin size (and so the price) comes from the laptop's real screen size in the shop's catalogue, never from the browser
  const lapName = str(b.laptop || (d && d.laptop), 80).toLowerCase();
  if (lapName) { const cat = await catalogue(req).catch(() => null), m = cat && (cat.find(l => `${l.brand} ${l.name}`.toLowerCase() === lapName) || cat.find(l => `${l.brand} ${l.name.replace(/ \(.+\)$/, '')}`.toLowerCase() === lapName));
    if (m) { const z = m.scr <= 13.5 ? 'S' : m.scr <= 15.7 ? 'M' : 'L';
      for (const p of packs) { const k = /^skin~([\w-]+)~[SMLC]$/.exec(p.key); if (k) p.key = `skin~${k[1]}~${z}`; }
      if (design && design.skinSize) design.skinSize = z; } }
  const pr = priceOrder({ packs, singles, design });
  if (pr.bad.length) return json(res, 400, { error: 'Something in your cart is no longer in the shop. Remove it and try again', bad: pr.bad });
  if (pr.short) return json(res, 400, { error: `Single stickers start from GH₵${pr.minSingles} per order. Add GH₵${pr.short} more (${Math.ceil(pr.short / PR.single)} more sticker${Math.ceil(pr.short / PR.single) > 1 ? 's' : ''}), or pick a full pack`, field: 'singles', short: pr.short });
  if (design) design.skinPrice = design.skinSize ? PR.skin[design.skinSize] : 0;
  const id = newId(), dir = `checkouts/${id}-${secret()}`;
  if (design) {
    const sh = img(d.sheet, 3e6), mk = img(d.mock, 1e6);
    if (sh) design.sheet = (await put(`${dir}/sheet.jpg`, sh, { access: 'public', addRandomSuffix: false, contentType: 'image/jpeg' })).url;
    if (mk) design.mock = (await put(`${dir}/mock.jpg`, mk, { access: 'public', addRandomSuffix: false, contentType: 'image/jpeg' })).url;
  }
  const fr = b.free && typeof b.free === 'object' && /^XQV-\d{3}$/.test(b.free.code || '') ? { code: b.free.code, name: str(b.free.name, 40), img: /^https:\/\//.test(b.free.img || '') ? str(b.free.img, 300) : '', onDesign: !!b.free.onDesign } : null;
  let picks = null;   // the singles laid out on the Skin Lab sheet
  if (b.picks && typeof b.picks === 'object') { const sh = img(b.picks.sheet, 3e6);
    picks = { size: str(b.picks.size, 4), n: +b.picks.n || 0, scaled: !!b.picks.scaled, layout: Array.isArray(b.picks.layout) ? b.picks.layout.slice(0, 300) : [] };
    if (sh) picks.sheet = (await put(`${dir}/picks.jpg`, sh, { access: 'public', addRandomSuffix: false, contentType: 'image/jpeg' })).url; }
  const clientTotal = Math.round((+b.total || 0) * 100) / 100, total = pr.total;
  const ck = { id, at: Date.now(), status: 'pending', name, phone, email, loc, note, laptop: str(b.laptop, 80), packs, singles, picks, free: fr, design, total,
    ...(clientTotal !== total ? { clientTotal } : {}), skinOnDM: false, attempts: [] };
  if (!(total > 0)) return json(res, 400, { error: 'Nothing to pay in this cart' });
  let pay; try { pay = await startPayment(ck, baseOf(req)); } catch (e) { return json(res, 502, { error: e.message || 'Paystack is not answering, try again' }); }
  await saveCheckout(dir, ck);
  return json(res, 200, { id, total, url: pay.url, track: `${SITE}/o/${id}/` });
}
