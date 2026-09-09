// app/api/webhooks/instagram/route.ts
import { after } from 'next/server';
import { getAIReply } from '../../../../lib/ai';
import { extractOrder } from '../../../../lib/extract';
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
  markOrdered
} from '../../../../lib/memory';

// Meta resends the same message if we're slow or if we error.
// Tracking message IDs prevents duplicate replies — and, more
// importantly now, duplicate order rows.
const handled = new Set<string>();

/* ── Trigger words ──────────────────────────────────────────────
   Thai uses substring matching: the script has no word boundaries,
   so \b never matches.

   English uses WHOLE-WORD matching. "ok" appears inside "book" and
   "look"; "pay" inside "paypal". Substring matching on English
   produces false confirmations and phantom orders.
   ───────────────────────────────────────────────────────────── */

const TH_CONFIRM = [
  'ยืนยัน', 'ตกลง', 'เอาตามนี้', 'จัดมาเลย', 'เอาเลย',
  'ครับผม', 'โอเค', 'ได้ค่ะ', 'ได้ครับ', 'ใช่ค่ะ', 'ใช่ครับ',
  'รับทราบ', 'จัดไป', 'สั่งเลย', 'เอาอันนี้',
];

const EN_CONFIRM = [
  'yes', 'confirm', 'confirmed', 'ok', 'okay', 'sure',
  'deal', 'agreed', 'take it', 'order it',
];

const TH_HANDOVER = [
  'แอดมิน', 'คุยกับคน', 'โอน', 'สลิป', 'จ่าย', 'ชำระ',
  'พร้อมเพย์', 'เลขบัญชี', 'บัญชี',
];

const EN_HANDOVER = [
  'admin', 'human', 'transfer', 'pay', 'payment', 'paid',
  'promptpay', 'qr', 'bank', 'account', 'slip', 'receipt',
  'checkout', 'invoice',
];

function matches(text: string, thai: string[], english: string[]): boolean {
  const lower = text.toLowerCase();
  if (thai.some(w => lower.includes(w))) return true;
  return english.some(w =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)
  );
}

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

  // Slow work runs AFTER the response. Meta waits ~5 seconds for a
  // 200 before assuming failure and resending. Two AI calls happen
  // in here, so this is not optional.
  after(async () => {
    syncIfStale().catch(() => {});   // fire and forget

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

  /* ── Echoes of our own outbound messages ──────────────────
     Replying manually in the Instagram app takes the thread.
     But the bot's replies echo back too — without the
     wasBotSent check it silences itself.
     ─────────────────────────────────────────────────────── */
  if (event.message.is_echo) {
    const customerId = event.recipient.id;

    if (wasBotSent(event.message.text)) return;

    if (event.message.text.startsWith('/bot')) {
      releaseToBot(customerId);
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

  /* ── Order confirmation ───────────────────────────────────
     Written here, not when the customer asks about payment —
     they may never ask, and the order would be lost.

     The keywords only trigger a CHECK. extractOrder decides
     whether an order actually exists, so "ok" mid-browse
     creates nothing.

     Order number and total come from CODE, not the model.
     ─────────────────────────────────────────────────────── */
  if (matches(text, TH_CONFIRM, EN_CONFIRM) || isShortAgreement(text)) {
    addTurn(senderId, 'user', text);
    const order = await extractOrder(senderId);

    if (order?.confirmed && order.items.length > 0 && !hasOrdered(senderId)) {
      markOrdered(senderId);
      takeOver(senderId);
      const orderNo = await saveOrder(senderId, order);
      console.log(`[ORDER] ${orderNo} — ${order.total} THB`);
      await sendMessage(senderId, orderConfirmation(orderNo, order.total, isThai(text)));
      return;
    }

    console.log(`[CONFIRM?] ${senderId} — nothing to confirm, continuing chat`);
  }

  /* ── Handover: payment or admin request ──────────────────── */
  if (matches(text, TH_HANDOVER, EN_HANDOVER)) {
    takeOver(senderId);
    addTurn(senderId, 'user', text);

    const order = await extractOrder(senderId);

    if (order?.confirmed && order.items.length > 0) {
      const orderNo = await saveOrder(senderId, order);
      console.log(`[ORDER] ${orderNo} — ${order.total} THB`);
      await sendMessage(senderId, orderConfirmation(orderNo, order.total, isThai(text)));
    } else {
      console.log(`[HANDOVER] ${senderId} — no confirmed order`);
      await sendMessage(
        senderId,
        isThai(text)
          ? 'รับทราบค่ะ 🙏 เดี๋ยวแอดมินมาสรุปยอดและแจ้งช่องทางชำระเงินให้นะคะ'
          : 'Noted 🙏 Our admin will confirm your order and send payment details shortly.'
      );
    }
    return;
  }

  /* ── Human is driving this thread ────────────────────────── */
  if (isTakenOver(senderId)) {
    addTurn(senderId, 'user', text);
    console.log(`[HUMAN MODE] ${senderId} — bot silent`);
    return;
  }

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
  // Record before sending so we recognise the echo when it returns.
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
    // Expected after a day — reply from the IG app instead.
    console.log('Reply FAILED:', JSON.stringify(data));
  }
}

function isShortAgreement(text: string): boolean {
  const t = text.trim().replace(/[!?.\s]/g, '');
  return ['ครับ', 'ค่ะ', 'คะ', 'จ้า', 'ok', 'yes'].includes(t.toLowerCase());
}