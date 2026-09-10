// app/api/webhooks/instagram/route.ts
import { after } from 'next/server';
import { getAIReply } from '../../../../lib/ai';
import { analyze } from '../../../../lib/extract';
import { saveOrder } from '../../../../lib/orders';
import { syncIfStale } from '../../../../lib/sync';
import {
  isTakenOver,
  takeOver,
  releaseToBot,
  addTurn,
  markBotSent,
  wasBotSent,
  hasOrdered,
  markOrdered,
  clearOrdered,
} from '../../../../lib/memory';

// Meta resends the same message if we're slow or if we error.
// Tracking message IDs prevents duplicate replies and duplicate orders.
const handled = new Set<string>();

const isThai = (s: string) => /[\u0e00-\u0e7f]/.test(s);

/* ─────────────────────────────────────────────────────────────
   Webhook verification
   ───────────────────────────────────────────────────────────── */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  if (
    sp.get('hub.mode') === 'subscribe' &&
    sp.get('hub.verify_token') === process.env.META_VERIFY_TOKEN
  ) {
    console.log('Verification OK');
    return new Response(sp.get('hub.challenge') ?? '', { status: 200 });
  }

  console.log('Verification FAILED');
  return new Response('Forbidden', { status: 403 });
}

/* ─────────────────────────────────────────────────────────────
   Incoming events
   ───────────────────────────────────────────────────────────── */
export async function POST(req: Request) {
  const raw = await req.text();

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  // Slow work runs AFTER the response. Meta waits ~5 seconds for a 200
  // before assuming failure and resending.
  after(async () => {
    syncIfStale().catch(() => {});

    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        try {
          await handleEvent(event);
        } catch (err) {
          console.error('Event failed:', err);
        }
      }
    }
  });

  return new Response('EVENT_RECEIVED', { status: 200 });
}

async function handleEvent(event: any) {
  /* ── Images (bank slips) ─────────────────────────────────── */
  const images = (event.message?.attachments ?? []).filter(
    (a: any) => a.type === 'image'
  );
  if (images.length > 0 && !event.message?.is_echo) {
    const senderId = event.sender.id;
    takeOver(senderId);
    console.log(`[HANDOVER] ${senderId} — ${images.length} image(s)`);
    console.log(`[SLIP URL] ${images[0].payload?.url}`);
    await sendMessage(
      senderId,
      'ได้รับสลิปแล้วค่ะ 🙏 เดี๋ยวแอดมินตรวจสอบและยืนยันให้นะคะ'
    );
    return;
  }

  if (!event.message?.text) return;

  /* ── Echoes of our own outbound messages ─────────────────── */
  if (event.message.is_echo) {
    const customerId = event.recipient.id;

    if (wasBotSent(event.message.text)) return;

    if (event.message.text.startsWith('/bot')) {
      releaseToBot(customerId);
      clearOrdered(customerId);       // allow a new order on this thread
      console.log(`[BOT RESUMED] ${customerId}`);
    } else {
      takeOver(customerId);
      console.log(`[HUMAN MODE] ${customerId} — you replied manually`);
    }
    return;
  }

  const senderId = event.sender.id;
  const text = event.message.text;
  const mid = event.message.mid;

  if (handled.has(mid)) {
    console.log('Duplicate, skipping:', mid);
    return;
  }
  handled.add(mid);

  console.log(`Message from ${senderId}: ${text}`);

  /* ── Human is driving this thread ─────────────────────────
     Checked BEFORE analysis — no point spending an API call on
     a conversation the bot isn't allowed to answer.
     ─────────────────────────────────────────────────────── */
  if (isTakenOver(senderId)) {
    addTurn(senderId, 'user', text);
    console.log(`[HUMAN MODE] ${senderId} — bot silent`);
    return;
  }

  /* ── One call: classify intent AND extract the order ──────
     Replaces four keyword lists that could never be both loose
     enough and tight enough at the same time.
     ─────────────────────────────────────────────────────── */
  const a = await analyze(senderId, text);

  if (!a) {
    // Analysis failed. Fall back to chatting rather than going
    // silent — a wrong answer beats no answer here.
    console.error(`[ANALYSIS FAILED] ${senderId} — falling back to chat`);
    const reply = await getAIReply(senderId, text);
    await sendMessage(senderId, reply);
    return;
  }

  console.log(`[INTENT] ${a.intent}  confirmed=${a.confirmed}  items=${a.items.length}`);

  const thai = isThai(text);

  /* ── Explicit request for a person ───────────────────────── */
  if (a.intent === 'human_request') {
    takeOver(senderId);
    addTurn(senderId, 'user', text);
    console.log(`[HANDOVER] ${senderId} — asked for a human`);
    await sendMessage(
      senderId,
      thai
        ? 'สักครู่นะคะ เดี๋ยวแอดมินมาตอบเองค่ะ 🙏'
        : 'One moment please — our admin will reply to you shortly 🙏'
    );
    return;
  }

  /* ── Order confirmed, or payment raised with an order ready ─
     Order number and total come from CODE, never the model.
     hasOrdered() stops a second row on the same thread — a
     customer agreeing twice must not be charged twice.
     ─────────────────────────────────────────────────────── */
  if (
    (a.intent === 'confirm_order' || a.intent === 'payment') &&
    a.confirmed &&
    a.items.length > 0 &&
    !hasOrdered(senderId)
  ) {
    markOrdered(senderId);
    takeOver(senderId);
    addTurn(senderId, 'user', text);

    const orderNo = await saveOrder(senderId, a);
    console.log(`[ORDER] ${orderNo} — ${a.total} THB — ${a.items.length} item(s)`);

    await sendMessage(senderId, orderConfirmation(orderNo, a.total, thai));
    return;
  }

  /* ── Payment topic, but no order to write ─────────────────
     The bot must never hand out an account number: it cannot
     verify a transfer, and a wrong PromptPay ID sends a
     customer's money to a stranger.
     ─────────────────────────────────────────────────────── */
  if (a.intent === 'payment') {
    takeOver(senderId);
    addTurn(senderId, 'user', text);
    console.log(`[HANDOVER] ${senderId} — payment topic, no confirmed order`);
    await sendMessage(
      senderId,
      thai
        ? 'รับทราบค่ะ 🙏 เดี๋ยวแอดมินมาสรุปยอดและแจ้งช่องทางชำระเงินให้นะคะ'
        : 'Noted 🙏 Our admin will confirm your order and send payment details shortly.'
    );
    return;
  }

  /* ── Everything else: normal conversation ────────────────── */
  const reply = await getAIReply(senderId, text);
  console.log(`REPLY: ${reply}`);
  await sendMessage(senderId, reply);
}

/** Hardcoded, not model-generated. These numbers must be exact. */
function orderConfirmation(orderNo: string, total: number, thai: boolean): string {
  return thai
    ? `รับออเดอร์แล้วค่ะ 🙏\nเลขที่ ${orderNo}\nยอดชำระ ${total} บาท\n\n` +
      `เดี๋ยวแอดมินส่งช่องทางชำระเงินให้นะคะ`
    : `Order received 🙏\nOrder no. ${orderNo}\nTotal ${total} THB\n\n` +
      `Our admin will send you the payment details shortly.`;
}

/* ─────────────────────────────────────────────────────────────
   Sending
   ───────────────────────────────────────────────────────────── */
async function sendMessage(recipientId: string, text: string) {
  markBotSent(text);

  const res = await fetch('https://graph.instagram.com/v23.0/me/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.IG_ACCESS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  const data = await res.json();

  if (res.ok) {
    console.log('Reply sent');
  } else {
    // code 10 / subcode 2534022 = 24-hour messaging window closed.
    console.log('Reply FAILED:', JSON.stringify(data));
  }
}