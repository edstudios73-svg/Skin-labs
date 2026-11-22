// POST /api/art : the customer's own picture for an order, sent just before checkout. Stored under an unguessable
// path and referenced by the checkout; nothing is listed or published. Pictures stay on the phone until this moment.
import { put } from './_blob.js';
import { json, limited, secret } from './_lib.js';

const MAX = 3.2e6;
const kindOf = buf => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? ['jpg', 'image/jpeg'] : buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' ? ['png', 'image/png'] : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (limited(req, 'art', 24, 10 * 60e3)) return json(res, 429, { error: 'Too many uploads, wait a few minutes' });
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).img || ''));
  if (!m) return json(res, 400, { error: 'Send a JPG or PNG picture' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX) return json(res, 413, { error: 'That picture is too big' });
  const k = kindOf(buf); if (!k) return json(res, 400, { error: 'That file is not a picture we can read' });
  const path = `uploads/${(secret() + secret()).slice(0, 20)}/art.${k[0]}`;
  await put(path, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: k[1] });
  return json(res, 200, { path, bytes: buf.length });
}
