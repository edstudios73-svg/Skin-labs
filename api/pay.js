// GET /api/pay : are online payments on?   POST /api/pay {id} : start (or resume) the Paystack payment for an order.
// The amount is the order's server-priced total. A payment started in the last 10 minutes is reused, so a double tap never makes two.
import { json, findOrder, saveOrder, findCheckout, saveCheckout, startPayment, baseOf, payOn, limited } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, 200, { enabled: payOn() });
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
  if (!payOn()) return json(res, 503, { error: 'Online payment is not switched on yet' });
  if (limited(req, 'pay', 40, 10 * 60e3)) return json(res, 429, { error: 'Too many tries. Wait a minute, then try again' });
  const id = String((req.body || {}).id || '').toUpperCase(), f = await findOrder(id);
  if (!f) {   // a checkout that was not paid yet: try again (it becomes an order only once Paystack confirms)
    const c = await findCheckout(id); if (!c) return json(res, 404, { error: 'No such order' });
    if (c.ck.status === 'paid') return json(res, 200, { paid: true });
    try { const p = await startPayment(c.ck, baseOf(req)); await saveCheckout(c.dir, c.ck); return json(res, 200, p); }
    catch (e) { return json(res, 502, { error: e.message || 'Paystack is not answering, try again' }); }
  }
  const o = f.order;
  if (o.paid) return json(res, 200, { paid: true });
  if (['cancelled', 'refunded', 'refund-review'].includes(o.status)) return json(res, 400, { error: 'This order is closed. Chat with us if you still want it' });
  if (!(o.total > 0)) return json(res, 400, { error: 'Nothing to pay on this order' });
  try { const p = await startPayment(o, baseOf(req)); await saveOrder(f.dir, o); return json(res, 200, p); }
  catch (e) { return json(res, 502, { error: e.message || 'Paystack is not answering, try again' }); }
}
