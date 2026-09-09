// lib/memory.ts
//
// Everything here lives in memory and is cleared when the dev server
// restarts. That's fine for now — Supabase replaces this later.

type Turn = { role: 'user' | 'model'; text: string };

const conversations = new Map<string, Turn[]>();
const takenOver = new Set<string>();
const botSent = new Set<string>();

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

/* ── Recognising our own echoes ─────────────────────────────
   Instagram echoes every outbound message back to the webhook,
   including ones the bot sent. Without this the bot sees its own
   reply, thinks a human typed it, and silences itself.
   Matching on text is crude but works because replies are unique
   enough. Switch to matching on message_id once we have Supabase.
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