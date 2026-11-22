// Customer artwork sent for the public catalogue. Nothing is published here: every submission waits as
// "pending" until the shop approves it in the admin. Uploads stay private on the customer's phone unless they send them.
import { put } from './_blob.js';
import { json, limited, rid, saveDoc, pushAll } from './_lib.js';

const MAX = 3.2e6;   // decoded bytes; the browser sends at most ~2400 px, well under the 4.5 MB request limit
const kindOf = buf => buf[0] === 0xff && buf[1] === 0xd8 ? ['jpg', 'image/jpeg']
  : buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' ? ['png', 'image/png']
  : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? ['webp', 'image/webp'] : null;
const str = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (limited(req, 'sub', 6, 60 * 60e3)) return json(res, 429, { error: 'Too many submissions, try again later' });
  const b = req.body || {};
  if (b.rights !== true) return json(res, 400, { error: 'Please confirm you own this artwork or have permission to use it', field: 'rights' });
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.img || ''));
  if (!m) return json(res, 400, { error: 'Send a JPG, PNG or WebP picture', field: 'img' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX) return json(res, 413, { error: 'That picture is too big' });
  const k = kindOf(buf); if (!k) return json(res, 400, { error: 'That file is not a picture we can read', field: 'img' });
  const id = 'ART-' + rid(6);
  const { url } = await put(`submissions/${id}/art.${k[0]}`, buf, { access: 'public', addRandomSuffix: true, contentType: k[1] });
  const sub = { id, at: Date.now(), status: 'pending', url, type: k[1], bytes: buf.length, w: Math.round(+b.w) || 0, h: Math.round(+b.h) || 0,
    name: str(b.name, 60), title: str(b.title, 80), note: str(b.note, 400), contact: str(b.contact, 40), log: [{ at: Date.now(), by: 'Customer', s: 'pending' }] };
  await saveDoc(`submissions/${id}`, sub);
  await pushAll({ title: `New artwork for the catalogue · ${id}`, body: sub.title || sub.name || 'Waiting for your approval', url: '/admin/', tag: id }).catch(() => {});
  return json(res, 200, { id, status: 'pending' });
}
