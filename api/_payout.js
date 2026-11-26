// Printer payouts: when an order is paid, the printer's cost for it (from the owner's price calculator, api/_quote.js)
// is sent to the printer's Mobile Money through Paystack Transfers. Reference = the order number; the rest stays with the shop.
// Money safety: off until the owner turns it on; only orders paid after that are paid automatically; every order is paid at
// most once (a write-once lock here, and Paystack refuses a second transfer with the same reference).
import { createHash } from 'crypto';
import { put } from './_blob.js';
import { saveDoc, loadDoc, loadDocs, findOrder, saveOrder, paystack, payOn } from './_lib.js';
import { settings as priceSettings, cost } from './_quote.js';

const DIR = () => 'settings/payout-' + createHash('sha256').update('payout:' + (process.env.SUPABASE_SERVICE_ROLE_KEY || '')).digest('hex').slice(0, 20);
export const NETWORKS = { MTN: 'MTN', VOD: 'Telecel (Vodafone)', ATL: 'AirtelTigo' };
export async function payoutSettings() { return (await loadDoc(DIR()).catch(() => null)) || { enabled: false }; }
const SKIN = { S: [31, 22], M: [36, 25], L: [40, 27], C: [40, 27] }, SHEET = { A5: [14.8, 21], A4: [21, 29.7], A3: [29.7, 42], XL: [21, 29.7] };

// What the printer charges for one paid order, line by line, with the owner's calculator
export async function printerCost(o) {
  const s = await priceSettings(), lines = [], add = (label, w, h, q = 1, kind = 'sticker') => { const c = cost(s, w, h, q, kind); lines.push({ label, cost: c.cost, sheet: c.sheet }); };
  for (const p of o.packs || []) { const k = String(p.key || ''), q = Math.max(1, +p.q || 1); let m;
    for (let i = 0; i < q; i++) {
      if ((m = /^skin~[\w-]+~([SMLC])$/.exec(k))) add(`${p.label || 'Laptop skin'} (${m[1]})`, ...SKIN[m[1]]);
      else if (/^kb~/.test(k)) add(p.label || 'Keyboard skin', 34, 23);
      else if (/^(tp|ms)~/.test(k)) add(p.label || 'Trackpad skin', 12, 8);
      else if (/^dc~/.test(k)) add(p.label || 'Laptop Art', 20, 20, 1, 'decal');
      else { const size = /~5$/.test(k) ? 'A5' : SHEET[p.size] ? p.size : 'A4'; add(`${p.label || 'Sticker pack'} (${size})`, ...SHEET[size]); } } }
  const singles = (o.singles || []).filter(x => !/^XQV-/.test(x.code)).reduce((a, x) => a + (+x.q || 1), 0);
  if (singles) { const size = o.picks && SHEET[o.picks.size] ? o.picks.size : null; if (size) add(`${singles} single stickers on one ${size} sheet`, ...SHEET[size]); else add(`${singles} single stickers`, 5.5, 5.5, singles); }
  const d = o.design; if (d) {
    if (d.n) add(`${d.packName || 'Custom pack'} (${d.size || 'A4'} sheet)`, ...(SHEET[d.size] || SHEET.A4));
    const k = (d.raw && d.raw.k) || {}, z = SKIN[d.skinSize] ? d.skinSize : 'M';
    if (k.lid || (!d.raw && (d.skins || []).length)) add(`Lid skin (${z})`, ...SKIN[z]);
    if (k.kb) add('Keyboard skin', 34, 23); if (k.bot) add(`Bottom skin (${z})`, ...SKIN[z]); if (k.pad) add('Trackpad skin', 12, 8); }
  const total = Math.round(lines.reduce((a, l) => a + l.cost, 0) * 100) / 100;
  return { total, lines };
}

async function recipient(set) {   // create the printer as a Paystack transfer recipient once; reused for every payout
  if (set.recipient && set.recipientFor === `${set.network}:${set.number}`) return set.recipient;
  let r; try { r = await paystack('/transferrecipient', { type: 'mobile_money', name: set.name, account_number: set.number, bank_code: set.network, currency: 'GHS', description: 'Skin Lab printer' }); }
  catch (e) { throw new Error('Paystack did not accept the printer’s Mobile Money details: ' + e.message); }
  set.recipient = r.recipient_code; set.recipientFor = `${set.network}:${set.number}`; set.verifiedName = (r.details || {}).account_name || ''; await saveDoc(DIR(), set); return set.recipient;
}
export async function savePayoutSettings(b, by) {
  const cur = await payoutSettings(), number = String(b.number || '').replace(/\D/g, '').replace(/^233/, '0');
  if (b.enabled && !(cur.recipient || (b.name && NETWORKS[b.network] && /^0\d{9}$/.test(number)))) throw new Error('Enter the printer’s name, network and a 10-digit Mobile Money number first');
  const set = { ...cur, name: String(b.name ?? cur.name ?? '').slice(0, 60).trim(), network: NETWORKS[b.network] ? b.network : cur.network, number: number || cur.number || '',
    enabled: !!b.enabled, by, at: Date.now() };
  if (set.enabled && !cur.enabled) set.enabledAt = Date.now();   // only orders paid from now on are paid automatically
  if (set.name && set.network && set.number) await recipient(set);   // checks the details with Paystack straight away
  if (set.number && set.network && (!set.verifiedName || set.verifiedFor !== `${set.network}:${set.number}`)) {   // the name the network has for this number, shown to the owner before switching on
    const r = await paystack(`/bank/resolve?account_number=${encodeURIComponent(set.number)}&bank_code=${encodeURIComponent(set.network)}`).catch(() => null); if (r && r.account_name) { set.verifiedName = r.account_name; set.verifiedFor = `${set.network}:${set.number}`; } }
  await saveDoc(DIR(), set); return set;
}

const ref = id => `skinlab-${id.toLowerCase()}`;   // the order number, in Paystack's reference format
// Pay the printer for one order. auto: only if switched on and the order was paid after that. Never twice.
export async function payOrder(id, { manual = false, by = 'System' } = {}) {
  if (!payOn()) return { skipped: 'Payments are off' };
  const set = await payoutSettings(); if (!set.enabled && !manual) return { skipped: 'Printer payouts are off' };
  if (!set.recipient) return { skipped: 'No printer Mobile Money details yet' };
  const f = await findOrder(id); if (!f || !f.order.paid || !f.order.paid.verifiedAt) return { skipped: 'Not a Paystack-verified paid order' };
  const o = f.order; if (['refunded', 'cancelled', 'refund-review'].includes(o.status)) return { skipped: 'Order refunded or cancelled' };
  if (!manual && (!set.enabledAt || o.paid.at < set.enabledAt)) return { skipped: 'Paid before printer payouts were switched on' };
  if (o.payout && ['sent', 'success', 'pending', 'processing'].includes(o.payout.status)) return { skipped: 'Already paid', payout: o.payout };
  const pc = await printerCost(o); if (!(pc.total > 0)) return { skipped: 'Nothing for the printer in this order' };
  if (pc.total > o.paid.amount) return { skipped: `Printer cost GH₵${pc.total} is more than the payment GH₵${o.paid.amount}: check the price calculator` };
  // one payout per order, however many times this runs (webhook, browser return, retries)
  try { await put(`locks/payout-${id}.json`, JSON.stringify({ at: Date.now(), by }), { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' }); }
  catch (e) { if (!(o.payout && ['waiting', 'failed', 'needs-otp', 'reversed'].includes(o.payout.status))) return { skipped: 'A payout for this order is already in progress' }; }
  const n = o.payout && o.payout.code ? (o.payout.tries || 1) + 1 : (o.payout && o.payout.tries) || 1, reference = n > 1 && o.payout && o.payout.code ? `${ref(id)}-r${n}` : ref(id);   // a transfer Paystack already created keeps its reference
  let td = null, err = ''; try { td = await paystack('/transfer', { source: 'balance', amount: Math.round(pc.total * 100), currency: 'GHS', recipient: set.recipient, reference, reason: `Skin Lab ${id} printing` }); } catch (e) { err = e.message; }
  const st = td ? (td.status === 'otp' ? 'needs-otp' : td.status === 'success' ? 'success' : 'pending') : /balance|insufficient/i.test(err) ? 'waiting' : 'failed';
  o.payout = { amount: pc.total, lines: pc.lines, ref: reference, tries: n, to: `${set.name} · ${NETWORKS[set.network] || set.network} ${set.number.slice(0, 3)}****${set.number.slice(-3)}`, status: st,
    code: td ? td.transfer_code : '', msg: td ? (td.status === 'otp' ? 'Paystack asks for an OTP: turn off OTP for transfers in Paystack settings' : '') : String(err).slice(0, 200), at: Date.now(), by, profit: Math.round((o.paid.amount - pc.total - (o.paid.fees || 0)) * 100) / 100 };
  (o.history ||= []).push({ s: 'printer-payout', at: Date.now(), by, note: `GH₵${pc.total} to printer: ${st}${o.payout.msg ? ' · ' + o.payout.msg : ''}` });
  await saveOrder(f.dir, o); await saveDoc(`payouts/${id}`, { id, ...o.payout, orderAt: o.paid.at, total: o.paid.amount });
  return { payout: o.payout };
}
// Paystack's transfer webhooks: the final word on a payout
export async function transferEvent(ev) {
  const r = String((ev.data && ev.data.reference) || ''); if (!/^skinlab-sl-[2-9a-z]{5}(-r\d+)?$/.test(r)) return;
  const id = r.slice(8, 16).toUpperCase(), f = await findOrder(id); if (!f || !f.order.payout) return;
  const o = f.order, st = ev.event === 'transfer.success' ? 'success' : ev.event === 'transfer.failed' ? 'failed' : ev.event === 'transfer.reversed' ? 'reversed' : null; if (!st) return;
  o.payout = { ...o.payout, status: st, doneAt: Date.now(), msg: st === 'success' ? '' : String((ev.data && ev.data.reason) || ev.event).slice(0, 200) };
  o.history.push({ s: 'printer-payout', at: Date.now(), by: 'Paystack', note: `Printer payout ${st}` }); await saveOrder(f.dir, o);
  await saveDoc(`payouts/${id}`, { ...(await loadDoc(`payouts/${id}`)) || {}, ...o.payout });
}
// Retry payouts that waited for the Paystack balance (called when new payments arrive and from the admin)
export async function retryWaiting(limit = 5) { const ps = (await loadDocs('payouts/')).filter(p => p.status === 'waiting').slice(0, limit); for (const p of ps) await payOrder(p.id, { manual: true, by: 'System (retry)' }).catch(() => null); return ps.length; }
export const listPayouts = () => loadDocs('payouts/');
