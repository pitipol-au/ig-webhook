// lib/sheets.ts
//
// Google Sheets as the database. Chosen because the shop owner edits it
// directly — the sheet IS the admin dashboard, so there's no UI to build.
//
// Constraints:
//   - ~60 writes/minute. Fine for products and orders, far too slow
//     for per-message conversation history.
//   - No transactions, no unique constraints. Duplicate rows are
//     possible. Acceptable where a human reviews the data anyway.
//   - Every call is a network round trip. Cache reads.

import { google } from 'googleapis';

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    // .env stores newlines as the two characters \n — restore them,
    // or the key fails to parse with a DECODER error.
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const sheets = google.sheets({ version: 'v4', auth: getAuth() });
const SHEET_ID = process.env.GOOGLE_SHEET_ID!;

/* ── Reading ────────────────────────────────────────────────── */

/**
 * A tab as objects keyed by header name. Safer than raw rows —
 * reordering columns in the sheet won't silently break the code,
 * which matters when the sheet is also the UI someone edits.
 */
export async function readTable(tab: string): Promise<Record<string, string>[]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:Z`,
  });

  const [headers, ...rows] = res.data.values ?? [];
  if (!headers) return [];

  return rows.map(
    row =>
      Object.fromEntries(
        headers.map((h, i) => [String(h).trim(), row[i] ?? ''])
      ) as Record<string, string>
  );
}

/* ── Writing ────────────────────────────────────────────────── */

export async function appendRow(tab: string, row: (string | number)[]) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

export async function appendRows(tab: string, rows: (string | number)[][]) {
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

/* ── Cached reads ───────────────────────────────────────────────
   Products are read on every customer message. Without caching
   that's a network round trip per message, and a handful of
   simultaneous conversations would hit the rate limit.
   ───────────────────────────────────────────────────────────── */

type CacheEntry = { data: Record<string, string>[]; at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function readTableCached(
  tab: string,
  ttlMs = TTL_MS
): Promise<Record<string, string>[]> {
  const hit = cache.get(tab);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;

  try {
    const data = await readTable(tab);
    cache.set(tab, { data, at: Date.now() });
    return data;
  } catch (err) {
    console.error(`Sheet read failed for "${tab}":`, err);
    // Serve stale data rather than breaking the conversation.
    // A failed read should degrade the answer, not kill the reply.
    return hit?.data ?? [];
  }
}

export function invalidateCache(tab?: string) {
  if (tab) cache.delete(tab);
  else cache.clear();
}

/* ── Health check ───────────────────────────────────────────── */

export async function checkConnection(): Promise<{
  ok: boolean;
  tabs?: string[];
  error?: string;
}> {
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    return {
      ok: true,
      tabs: (res.data.sheets ?? []).map(s => s.properties?.title ?? '?'),
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}