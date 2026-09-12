// lib/memory.ts
//
// Conversation state in Upstash Redis.
//
// This replaced in-process Maps, which cannot work on serverless:
// each invocation may land on a different instance, so nothing is
// shared. That broke the duplicate-message guard, the handover flag,
// the duplicate-order guard, and the image/caption coordination —
// all of which looked fine locally and failed in production.
//
// Every function is async now because each is a network call.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/* ── TTLs ───────────────────────────────────────────────────────
   Redis expires these itself, so there is no cleanup code and no
   unbounded growth.
   ───────────────────────────────────────────────────────────── */
const DAY = 60 * 60 * 24;

const TTL = {
  history:   DAY,        // a conversation older than a day is finished
  handover:  DAY,        // auto-release: yesterday's thread shouldn't
                         // stay silent when the customer returns today
  ordered:   DAY,        // duplicate-order guard
  lang:      DAY * 7,    // language preference outlives a conversation
  botSent:   60 * 10,    // echoes arrive within seconds
  handled:   60 * 60,    // Meta retries for minutes, not hours
  imageFlight: 30,       // caption coordination window
  caption:   60,
} as const;

const MAX_TURNS = 20;

/* ── Keys ───────────────────────────────────────────────────── */
const k = {
  history:  (id: string) => `conv:${id}:history`,
  handover: (id: string) => `conv:${id}:handover`,
  ordered:  (id: string) => `conv:${id}:ordered`,
  lang:     (id: string) => `conv:${id}:lang`,
  image:    (id: string) => `conv:${id}:image`,
  caption:  (id: string) => `conv:${id}:caption`,
  botSent:  (hash: string) => `sent:${hash}`,
  handled:  (mid: string) => `mid:${mid}`,
};

export type Turn = { role: 'user' | 'model'; text: string };

/* ── Conversation history ───────────────────────────────────── */

export async function getHistory(senderId: string): Promise<Turn[]> {
  try {
    const raw = await redis.lrange<Turn>(k.history(senderId), 0, -1);
    return raw ?? [];
  } catch (err) {
    console.error('getHistory failed:', err);
    return [];   // degrade to a fresh conversation, never throw
  }
}

export async function addTurn(
  senderId: string,
  role: 'user' | 'model',
  text: string
): Promise<void> {
  try {
    const key = k.history(senderId);
    await redis.rpush(key, { role, text });
    // Keep only the most recent turns — Redis trims in place.
    await redis.ltrim(key, -MAX_TURNS, -1);
    await redis.expire(key, TTL.history);
  } catch (err) {
    console.error('addTurn failed:', err);
  }
}

export async function clearHistory(senderId: string): Promise<void> {
  try {
    await redis.del(k.history(senderId));
  } catch (err) {
    console.error('clearHistory failed:', err);
  }
}

/* ── Conversation language ──────────────────────────────────
   Set once, on first contact, then fixed. Per-message detection
   would flip a Thai customer to English the moment they type "ok".
   ───────────────────────────────────────────────────────────── */

export async function getLang(senderId: string): Promise<'th' | 'en' | null> {
  try {
    return (await redis.get<'th' | 'en'>(k.lang(senderId))) ?? null;
  } catch {
    return null;
  }
}

export async function setLang(senderId: string, lang: 'th' | 'en'): Promise<void> {
  try {
    // NX = only if absent. First contact wins.
    await redis.set(k.lang(senderId), lang, { nx: true, ex: TTL.lang });
  } catch (err) {
    console.error('setLang failed:', err);
  }
}

/* ── Human handover ─────────────────────────────────────────
   Auto-releases after 24 hours. A thread handled yesterday is
   finished; a message today is a new conversation.
   ───────────────────────────────────────────────────────────── */

export async function isTakenOver(senderId: string): Promise<boolean> {
  try {
    return (await redis.exists(k.handover(senderId))) === 1;
  } catch (err) {
    console.error('isTakenOver failed:', err);
    // Fail toward the bot staying quiet: a bot talking over a human
    // is worse than a missed automatic reply.
    return true;
  }
}

export async function takeOver(senderId: string): Promise<void> {
  try {
    await redis.set(k.handover(senderId), 1, { ex: TTL.handover });
  } catch (err) {
    console.error('takeOver failed:', err);
  }
}

export async function releaseToBot(senderId: string): Promise<void> {
  try {
    await redis.del(k.handover(senderId));
  } catch (err) {
    console.error('releaseToBot failed:', err);
  }
}

/* ── Duplicate order guard ──────────────────────────────────
   Without this, a customer agreeing twice produces two order rows
   — and gets charged and shipped twice.
   ───────────────────────────────────────────────────────────── */

export async function hasOrdered(senderId: string): Promise<boolean> {
  try {
    return (await redis.exists(k.ordered(senderId))) === 1;
  } catch (err) {
    console.error('hasOrdered failed:', err);
    // Fail toward NOT writing a duplicate order. A missed order is
    // recoverable by a human; a double charge is not.
    return true;
  }
}

export async function markOrdered(senderId: string): Promise<void> {
  try {
    await redis.set(k.ordered(senderId), 1, { ex: TTL.ordered });
  } catch (err) {
    console.error('markOrdered failed:', err);
  }
}

export async function clearOrdered(senderId: string): Promise<void> {
  try {
    await redis.del(k.ordered(senderId));
  } catch (err) {
    console.error('clearOrdered failed:', err);
  }
}

/* ── Message deduplication ──────────────────────────────────
   Meta resends on timeout or error. Without this a retry means a
   duplicate reply — or, worse, a duplicate order row.

   SET NX is atomic: the first caller gets true, everyone else
   false, even across instances.
   ───────────────────────────────────────────────────────────── */

export async function claimMessage(mid: string): Promise<boolean> {
  try {
    const res = await redis.set(k.handled(mid), 1, { nx: true, ex: TTL.handled });
    return res === 'OK';
  } catch (err) {
    console.error('claimMessage failed:', err);
    return true;   // process it rather than drop it
  }
}

/* ── Recognising our own echoes ─────────────────────────────
   Instagram echoes every outbound message back to the webhook,
   including ones the bot sent. Without this the bot sees its own
   reply, assumes a human typed it, and silences itself.
   ───────────────────────────────────────────────────────────── */

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export async function markBotSent(text: string): Promise<void> {
  try {
    await redis.set(k.botSent(hash(text)), 1, { ex: TTL.botSent });
  } catch (err) {
    console.error('markBotSent failed:', err);
  }
}

export async function wasBotSent(text: string): Promise<boolean> {
  try {
    return (await redis.exists(k.botSent(hash(text)))) === 1;
  } catch (err) {
    console.error('wasBotSent failed:', err);
    // Fail toward treating it as ours — a missed handover beats the
    // bot silencing itself on its own reply.
    return true;
  }
}

/* ── Image / caption coordination ───────────────────────────
   Instagram delivers a photo and its caption as SEPARATE webhook
   requests. On serverless these can hit different instances, which
   is exactly why in-process state failed here three times.
   ───────────────────────────────────────────────────────────── */

export async function markImageInFlight(senderId: string): Promise<void> {
  try {
    await redis.set(k.image(senderId), Date.now(), { ex: TTL.imageFlight });
  } catch (err) {
    console.error('markImageInFlight failed:', err);
  }
}

export async function isImageInFlight(senderId: string): Promise<boolean> {
  try {
    return (await redis.exists(k.image(senderId))) === 1;
  } catch {
    return false;
  }
}

export async function clearImageInFlight(senderId: string): Promise<void> {
  try {
    await redis.del(k.image(senderId));
  } catch (err) {
    console.error('clearImageInFlight failed:', err);
  }
}

export async function setPendingCaption(senderId: string, text: string): Promise<void> {
  try {
    await redis.set(k.caption(senderId), text, { ex: TTL.caption });
  } catch (err) {
    console.error('setPendingCaption failed:', err);
  }
}

export async function takePendingCaption(senderId: string): Promise<string> {
  try {
    const key = k.caption(senderId);
    const text = await redis.get<string>(key);
    if (text) await redis.del(key);
    return text ?? '';
  } catch {
    return '';
  }
}

/* ── Health check ───────────────────────────────────────────── */

export async function checkRedis(): Promise<{ ok: boolean; error?: string }> {
  try {
    await redis.set('healthcheck', Date.now(), { ex: 60 });
    const v = await redis.get('healthcheck');
    return { ok: v !== null };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}