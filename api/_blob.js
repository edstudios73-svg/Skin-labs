// Supabase Storage drop-in for @vercel/blob. Keeps the same put/list/del surface the
// rest of the app uses, so no other file needed to change except the import line.
// Everything runs on native fetch: no extra npm dependency.
const BUCKET = 'blob';

const cfg = () => {
  const url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url: url.replace(/\/$/, ''), key };
};

const hdrs = (extra = {}) => {
  const { key } = cfg();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
};

const publicUrl = path => `${cfg().url}/storage/v1/object/public/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

const rand = () => Math.random().toString(36).slice(2, 10);
const withSuffix = (path, on) => {
  if (!on) return path;
  const i = path.lastIndexOf('.'), dot = i > 0 ? path.slice(i) : '';
  return (i > 0 ? path.slice(0, i) : path) + '-' + rand() + dot;
};

export async function put(path, body, opts = {}) {
  const p = withSuffix(String(path), opts.addRandomSuffix);
  const upsert = opts.allowOverwrite !== false ? 'true' : 'false';
  const r = await fetch(`${cfg().url}/storage/v1/object/${BUCKET}/${p.split('/').map(encodeURIComponent).join('/')}?upsert=${upsert}`, {
    method: 'PUT',
    headers: hdrs({ 'Content-Type': opts.contentType || 'application/octet-stream' }),
    body: typeof body === 'string' ? Buffer.from(body) : body,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`storage put failed ${r.status}: ${await r.text()}`);
  return { url: publicUrl(p), pathname: p };
}

async function rawList(prefix, offset, limit) {
  const body = JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } });
  const r = await fetch(`${cfg().url}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: hdrs({ 'Content-Type': 'application/json' }),
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`storage list failed ${r.status}: ${await r.text()}`);
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

// Supabase Storage lists one level per call; folders come back as entries with id === null.
// Vercel Blob listed recursively with prefix matching, so we walk the folder tree to mirror that.
// A prefix may end mid-name (e.g. 'orders/SL-XX') — we resolve it to its parent folder plus a name filter.
export async function list({ prefix = '', cursor, limit = 1000 } = {}) {
  const slash = prefix.lastIndexOf('/');
  const dir = slash < 0 ? '' : prefix.slice(0, slash + 1);
  const nameFilter = slash < 0 ? prefix : prefix.slice(slash + 1);
  const out = [], walk = async (d, depth) => {
    if (depth > 8 || out.length > 20000) return;
    const items = await rawList(d, cursor ? Number(cursor) : 0, limit);
    for (const i of items) {
      if (!i) continue;
      if (i.id) { const p = d + i.name; out.push({ pathname: p, url: publicUrl(p), uploadedAt: i.created_at || new Date(0).toISOString(), size: i.metadata && i.metadata.size || 0 }); }
      else await walk(d + i.name + '/', depth + 1);
    }
  };
  const items = await rawList(dir, cursor ? Number(cursor) : 0, limit);
  for (const i of items) {
    if (!i) continue;
    if (nameFilter && !i.name.startsWith(nameFilter)) continue;
    if (i.id) { const p = dir + i.name; out.push({ pathname: p, url: publicUrl(p), uploadedAt: i.created_at || new Date(0).toISOString(), size: i.metadata && i.metadata.size || 0 }); }
    else await walk(dir + i.name + '/', 1);
  }
  return { blobs: out, hasMore: false, cursor: '' };
}

export async function del(input) {
  const urls = Array.isArray(input) ? input : [input];
  for (const u of urls) {
    const m = String(u).match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/);
    const path = m ? decodeURIComponent(m[1]) : String(u);
    const r = await fetch(`${cfg().url}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'DELETE',
      headers: hdrs(),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`storage del failed ${r.status}: ${await r.text()}`);
  }
}
