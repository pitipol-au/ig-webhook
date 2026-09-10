// lib/memory.ts
//
// Conversation history and per-thread state, held in memory.
// Cleared on every restart — including customers mid-order.
// This is the largest known limitation of the current build.

type Turn = { role: 'user' | 'model'; text: string };

const conversations = new Map<string, Turn[]>();
const takenOver = new Set<string>();
const botSent = new Set<string>();
const ordered = new Set<string>();

const MAX_TURNS = 20;

/* ── Conversation history ───────────────────────────────────── */

export function getHistory(senderId: string): Turn[] {
  return conversations.get(senderId) ?? [];
}

export function addTurn(senderId: string, role: 'user' | 'model', text: string) {
  const history = conversations.get(senderId) ?? [];
  history.push({ role, text });
  if (history.length > MAX_TURNS) history.shift();
  conversations.set(senderId, history);
}

/* ── Human handover ─────────────────────────────────────────── */

export function isTakenOver(senderId: string): boolean {
  return takenOver.has(senderId);
}

export function takeOver(senderId: string) {
  takenOver.add(senderId);
}

export function releaseToBot(senderId: string) {
  takenOver.delete(senderId);
}

/* ── Duplicate order guard ──────────────────────────────────
   Without this, a customer agreeing twice produces two order
   rows — and gets charged and shipped twice.
   ───────────────────────────────────────────────────────────── */

export function hasOrdered(senderId: string): boolean {
  return ordered.has(senderId);
}

export function markOrdered(senderId: string) {
  ordered.add(senderId);
}

export function clearOrdered(senderId: string) {
  ordered.delete(senderId);
}

/* ── Recognising our own echoes ─────────────────────────────
   Instagram echoes every outbound message back to the webhook,
   including ones the bot sent. Without this the bot sees its own
   reply, assumes a human typed it, and silences itself.
   ───────────────────────────────────────────────────────────── */

export function markBotSent(text: string) {
  botSent.add(text);
  if (botSent.size > 200) {
    botSent.delete(botSent.values().next().value!);
  }
}

export function wasBotSent(text: string): boolean {
  return botSent.has(text);
}