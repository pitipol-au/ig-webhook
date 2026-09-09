// lib/sheets.ts
//
// Google Sheets as the database. Chosen because the shop owner can edit
// it directly — the sheet IS the admin dashboard, so there's no UI to build
// and nothing new to learn.
//
// Constraints worth remembering:
//   - Roughly 60 writes per minute. Fine for products and orders,
//     far too slow for per-message conversation history.
//   - No transactions and no unique constraints. Two events arriving
//     together can produce duplicate rows. Acceptable where a human
//     reviews the data anyway; not acceptable for anything automated.
//   - Every call is a network round trip (200-500ms). Cache reads.

import { google } from 'googleapis';

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    // .env files store newlines as the two characters \n — restore them,
    // or the key fails to parse with a DECODER error.
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const sheets = google.sheets({ version: 'v4', auth: getAuth() });
const SHEET_ID = process.env.GOOGLE_SHEET_ID!;

/* ─────────────────────────────────────────────────────────────
   Reading
   ───────────────────────────────────────────────────────────── */

/** Raw rows from a tab, excluding the header row. */
export async function readRows(tab: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A2:Z`,
  });
  return res.data.values ?? [];
}

/**
 * A tab as objects keyed by header name.
 * Safer than readRows — reordering columns in the sheet won't
 * silently break your code.
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

/* ─────────────────────────────────────────────────────────────
   Writing
   ───────────────────────────────────────────────────────────── */

/** Append one row to the bottom of a tab. */
export async function appendRow(tab: string, row: (string | number)[]) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

/** Append several rows in a single API call. Use this over a loop. */
export async function appendRows(tab: string, rows: (string | number)[][]) {
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rows].flat() },
  });
}

/**
 * Overwrite a single cell.
 * rowIndex is 0-based over DATA rows, so 0 is the first row under
 * the header, which is spreadsheet row 2.
 */
export async function updateCell(
  tab: string,
  rowIndex: number,
  column: string,
  value: string | number
) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${column}${rowIndex + 2}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

/* ─────────────────────────────────────────────────────────────
   Cached reads

   Products are read on every customer message. Without a cache
   that's a network round trip per message, and you'd hit the
   rate limit with a handful of simultaneous conversations.
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
    // Sheets is not a reliable database — a failed read should
    // degrade the answer, not kill the reply.
    return hit?.data ?? [];
  }
}

/** Drop the cache — call after a sync so new rows appear immediately. */
export function invalidateCache(tab?: string) {
  if (tab) cache.delete(tab);
  else cache.clear();
}

/* ─────────────────────────────────────────────────────────────
   Health check
   ───────────────────────────────────────────────────────────── */

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