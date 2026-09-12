// app/api/health/route.ts
//
// One endpoint that tells you whether the three external services
// are reachable. Visit this after any deploy or env change.

import { checkRedis } from '../../../lib/memory';
import { checkConnection } from '../../../lib/sheets';

export async function GET() {
  const [redis, sheets] = await Promise.all([
    checkRedis(),
    checkConnection(),
  ]);

  const ig = await fetch(
    `https://graph.instagram.com/v23.0/me?fields=id,username` +
    `&access_token=${process.env.IG_ACCESS_TOKEN}`
  )
    .then(async r => (r.ok ? { ok: true, ...(await r.json()) } : { ok: false, status: r.status }))
    .catch((e) => ({ ok: false, error: String(e) }));

  const ok = redis.ok && sheets.ok && (ig as any).ok;

  return Response.json({ ok, redis, sheets, instagram: ig }, { status: ok ? 200 : 500 });
}