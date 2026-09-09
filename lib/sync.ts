// lib/sync.ts
//
// Instagram has no "new post" webhook, so the catalog is polled.
// Sync is APPEND-ONLY: rows already in the sheet are never touched,
// so stock ticks and corrected prices survive every run.

import { readTable, appendRows, invalidateCache } from './sheets';

type IgPost = { id: string; caption?: string; permalink: string };

export async function syncProducts(): Promise<{
  added: number;
  existing: number;
  titles: string[];
}> {
  const token = process.env.IG_ACCESS_TOKEN;
  const res = await fetch(
    `https://graph.instagram.com/v23.0/me/media` +
    `?fields=id,caption,permalink&limit=100&access_token=${token}`
  );
  const data = await res.json();

  if (!data.data) {
    throw new Error(`IG fetch failed: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const posts: IgPost[] = data.data.filter((p: IgPost) => p.caption);

  const existing = await readTable('Products');
  const knownIds = new Set(
    existing.map(r => String(r.ig_media_id ?? '').trim()).filter(Boolean)
  );

  const newPosts = posts.filter(p => !knownIds.has(String(p.id).trim()));

  const rows = newPosts.map(p => [
    p.id,
    guessTitle(p.caption!),
    guessPrice(p.caption!),
    guessStock(p.caption!),
    '',
  ]);

  await appendRows('Products', rows);
  if (rows.length > 0) invalidateCache('Products');

  return {
    added: rows.length,
    existing: knownIds.size,
    titles: rows.map(r => String(r[1])),
  };
}

/* ── Throttled sync ─────────────────────────────────────────────
   Piggybacks on inbound DMs. No cron needed, and DMs arrive often
   enough to keep the catalog current. Trade-off: no messages means
   no sync — acceptable, since nobody is asking about the new product
   either. Replace with a scheduled job once deployed.
   ───────────────────────────────────────────────────────────── */

let lastSyncAt = 0;
const SYNC_INTERVAL_MS = 10 * 60 * 1000;

export async function syncIfStale(): Promise<void> {
  if (Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return;
  lastSyncAt = Date.now();

  try {
    const result = await syncProducts();
    if (result.added > 0) {
      console.log(`[SYNC] added ${result.added}: ${result.titles.join(', ')}`);
    }
  } catch (err) {
    console.error('[SYNC] failed:', err);
  }
}

/* ── Caption parsing ────────────────────────────────────────── */

function guessTitle(caption: string): string {
  return caption
    .split('\n')[0]
    .replace(/[\u2728\u{1F525}\u{1F495}\u{1F338}\u274C\u2b50]/gu, '')
    .replace(/NEW ARRIVAL/gi, '')
    .trim()
    .slice(0, 60);
}

/**
 * Best-effort price extraction. Deliberately conservative:
 * a blank cell the owner fills in beats a wrong number the bot quotes.
 */
function guessPrice(caption: string): string {
  const promo = caption.match(/เหลือ\s*([\d,]+)/);      // "ลดจาก 1,090 เหลือ 890"
  if (promo) return promo[1].replace(/,/g, '');

  const baht = caption.match(/([\d,]+)\s*บาท/);
  if (baht) return baht[1].replace(/,/g, '');

  const dash = caption.match(/([\d,]+)\.-/);            // "1190.-"
  if (dash) return dash[1].replace(/,/g, '');

  return '';
}

/** Only applies to NEW rows — never overwrites a value set by hand. */
function guessStock(caption: string): string {
  const soldOut = [
    'ของหมด', 'สินค้าหมด', 'หมดแล้ว',
    'sold out', 'soldout', 'พรีออเดอร์', 'pre-order',
  ];
  const lower = caption.toLowerCase();
  return soldOut.some(w => lower.includes(w)) ? 'FALSE' : 'TRUE';
}