// app/api/webhooks/instagram/route.ts
import { after } from 'next/server';
import { getAIReply } from '../../../../lib/ai';
import { extractOrder } from '../../../../lib/extract';
import { saveOrder } from '../../../../lib/orders';
import {
  isTakenOver,
  takeOver,
  releaseToBot,
  addTurn,
  markBotSent,
  wasBotSent,
} from '../../../../lib/memory';

// Meta resends the same message if we're slow or if we error.
// Track message IDs so retries don't cause duplicate replies —
// or, now, duplicate order rows.
const handled = new Set<string>();

// Customer agreeing to a summarised order. This is the commitment point.
// These keywords only trigger a CHECK — extractOrder decides whether an
// order was actually summarised, so "โอเค" mid-browse creates nothing.
const CONFIRM_TRIGGERS = [
  'ยืนยัน', 'ตกลง', 'เอาตามนี้', 'จัดมาเลย', 'เอาเลย',
  'ครับผม', 'โอเค', 'ok', 'ได้ค่ะ', 'ได้ครับ', 'ใช่ค่ะ', 'ใช่ครับ',
];

// Anything touching money goes to a human. The bot must never hand out
// an account number — it cannot verify a transfer, and a wrong or
// hallucinated PromptPay ID sends a customer's money to a stranger.
const HANDOVER_TRIGGERS = [
  'แอดมิน', 'คุยกับคน', 'admin',
  'โอน', 'สลิป', 'จ่าย', 'ชำระ',
  'พร้อมเพย์', 'promptpay', 'เลขบัญชี', 'บัญชี', 'qr',
];

/* ─────────────────────────────────────────────────────────────
   Webhook verification — Meta calls this on "Verify and save"
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
  // before assuming failure and resending. Order extraction adds a
  // second AI call here, so this matters more than ever.
  after(async () => {
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
  /* ── Images (bank slips) ────────────────────────────────────
     Acknowledged and handed to a human. Not read yet.
     ───────────────────────────────────────────────────────── */
  const images = (event.message?.attachments ?? []).filter(
    (a: any) => a.type === 'image'
  );
  if (images.length > 0 && !event.message?.is_echo) {
    const senderId = event.sender.id;
    takeOver(senderId);
    console.log(`[HANDOVER] ${senderId} — sent ${images.length} image(s)`);
    console.log(`[SLIP URL] ${images[0].payload?.url}`);
    await sendMessage(
      senderId,
      'ได้รับสลิปแล้วค่ะ 🙏 เดี๋ยวแอดมินตรวจสอบและยืนยันให้นะคะ'
    );
    return;
  }

  if (!event.message?.text) return;

  /* ── Echoes of our own outbound messages ────────────────────
     Replying manually from the Instagram app means you've taken
     the thread. But the bot's own replies echo back too, so
     ignore those or the bot silences itself.
     ───────────────────────────────────────────────────────── */
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
  const lower = text.toLowerCase();

  /* ── Order confirmation ─────────────────────────────────────
     Write the order here, not when the customer asks about
     payment — they may never ask, and the conversation would
     end with no record.

     The order number and amount are generated in CODE, not by
     the model. Facts that must be exact don't go through an AI
     that occasionally miscalculates.
     ───────────────────────────────────────────────────────── */
  if (CONFIRM_TRIGGERS.some(w => lower.includes(w))) {
    addTurn(senderId, 'user', text);
    const order = await extractOrder(senderId);

    if (order?.confirmed && order.items.length > 0) {
      takeOver(senderId);
      const orderNo = await saveOrder(senderId, order);
      console.log(`[ORDER] ${orderNo} — ${order.total} THB — ${order.items.length} item(s)`);

      await sendMessage(
        senderId,
        `รับออเดอร์แล้วค่ะ 🙏\n` +
        `เลขที่ ${orderNo}\n` +
        `ยอดชำระ ${order.total} บาท\n\n` +
        `เดี๋ยวแอดมินส่งช่องทางชำระเงินให้นะคะ`
      );
      return;
    }

    // Not a real confirmation — fall through to normal conversation
    console.log(`[CONFIRM?] ${senderId} — no order to confirm, continuing chat`);
  }

  /* ── Handover: payment or admin request ─────────────────────
     Also writes an order if one was confirmed but not yet saved —
     covers the customer who skips straight to "โอนยังไงคะ".
     ───────────────────────────────────────────────────────── */
  if (HANDOVER_TRIGGERS.some(w => lower.includes(w))) {
    takeOver(senderId);
    addTurn(senderId, 'user', text);

    const order = await extractOrder(senderId);

    if (order?.confirmed && order.items.length > 0) {
      const orderNo = await saveOrder(senderId, order);
      console.log(`[ORDER] ${orderNo} — ${order.total} THB`);
      await sendMessage(
        senderId,
        `รับออเดอร์แล้วค่ะ 🙏\n` +
        `เลขที่ ${orderNo}\n` +
        `ยอดชำระ ${order.total} บาท\n\n` +
        `เดี๋ยวแอดมินส่งช่องทางชำระเงินให้นะคะ`
      );
    } else {
      const missing = order?.missing?.length
        ? ` (ขาด: ${order.missing.join(', ')})`
        : '';
      console.log(`[HANDOVER] ${senderId} — no confirmed order${missing}`);
      await sendMessage(
        senderId,
        'รับทราบค่ะ 🙏 เดี๋ยวแอดมินมาสรุปยอดและแจ้งช่องทางชำระเงินให้นะคะ'
      );
    }
    return;
  }

  /* ── Human is driving this thread ───────────────────────── */
  if (isTakenOver(senderId)) {
    addTurn(senderId, 'user', text);
    console.log(`[HUMAN MODE] ${senderId} — bot silent`);
    return;
  }

  const reply = await getAIReply(senderId, text);
  console.log(`REPLY: ${reply}`);
  await sendMessage(senderId, reply);
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
    // Expected once a day has passed — reply from the IG app instead.
    console.log('Reply FAILED:', JSON.stringify(data));
  }
}