// app/api/webhooks/instagram/route.ts
import { after } from 'next/server';
import { getAIReply, detectLang } from '../../../../lib/ai';
import { analyze } from '../../../../lib/extract';
import { analyzeImage, findSimilar } from '../../../../lib/image';
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
  getLang,
  setLang,
} from '../../../../lib/memory';

// Meta resends the same message if we're slow or if we error.
// Tracking message IDs prevents duplicate replies and duplicate orders.
const handled = new Set<string>();

/* ── Image / caption coordination ───────────────────────────────
   Instagram delivers a photo and its caption as SEPARATE webhook
   deliveries, not one batch. Without coordination the customer gets
   two replies: one for the picture, one for the words.

   The image handler waits briefly for a caption; the text handler
   hands its message over and stays quiet if an image is mid-flight.

   NOTE: this state is in process memory. On Vercel, separate
   invocations may land on different instances, so this is
   best-effort until conversation state moves to a real store.
   ───────────────────────────────────────────────────────────── */
const imageInFlight = new Map<string, number>();
const pendingCaption = new Map<string, string>();
const CAPTION_WAIT_MS = 2000;

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
  // before assuming failure and resending the same message.
  after(async () => {
    syncIfStale().catch(() => {});

    for (const entry of body.entry ?? []) {
      const events = entry.messaging ?? [];

      // Same-batch case: a photo and caption occasionally do arrive
      // together. Cheap to check, and saves the 2s wait.
      const batchHasText = events.some(
        (e: any) => e.message?.text && !e.message?.is_echo
      );

      for (const event of events) {
        try {
          await handleEvent(event, batchHasText);
        } catch (err) {
          console.error('Event failed:', err);
        }
      }
    }
  });

  return new Response('EVENT_RECEIVED', { status: 200 });
}

async function handleEvent(event: any, batchHasText = false) {
  /* ── Images ──────────────────────────────────────────────
     Not every image is a payment slip. A customer sending a
     product photo to ask "do you have this?" must not be told
     their slip is being verified.
     ─────────────────────────────────────────────────────── */
  const images = (event.message?.attachments ?? []).filter(
    (a: any) => a.type === 'image'
  );

  if (images.length > 0 && !event.message?.is_echo) {
    const senderId = event.sender.id;
    const url = images[0].payload?.url;
    const thai = (getLang(senderId) ?? 'th') === 'th';

    imageInFlight.set(senderId, Date.now());

    try {
      // Classify first — a slip must never wait, and must never be
      // confused with a product enquiry.
      const { kind, description } = await analyzeImage(url);
      console.log(
        `[IMAGE] ${senderId} — ${kind}` +
        (description ? `: ${description.slice(0, 80)}` : '')
      );

      if (kind === 'slip') {
        takeOver(senderId);
        console.log(`[SLIP URL] ${url}`);
        await sendMessage(
          senderId,
          thai
            ? 'ได้รับสลิปแล้วค่ะ 🙏 เดี๋ยวแอดมินตรวจสอบและยืนยันให้นะคะ'
            : 'Slip received 🙏 Our admin will verify and confirm shortly.'
        );
        return;
      }

      // Give a caption time to arrive as its own webhook delivery.
      // Two seconds is invisible to a customer and removes the
      // duplicate reply.
      if (!batchHasText) {
        await new Promise(r => setTimeout(r, CAPTION_WAIT_MS));
      }
      const caption = pendingCaption.get(senderId) ?? '';
      pendingCaption.delete(senderId);

      if (kind === 'product' && description) {
        // The vision model describes; the chat model matches against
        // the real catalog. Splitting them means a weak description
        // can't invent stock we don't have.
        try {
          const suggestion = await findSimilar(
            caption ? `${description}\n\nCustomer also said: ${caption}` : description,
            thai
          );
          if (suggestion) {
            addTurn(
              senderId,
              'user',
              `[photo: ${description}]${caption ? ` ${caption}` : ''}`
            );
            addTurn(senderId, 'model', suggestion);
            await sendMessage(senderId, suggestion);
            return;
          }
        } catch (err) {
          console.error('Similar-item match failed:', err);
        }
      }

      // Unrecognised image, or matching failed.
      await sendMessage(
        senderId,
        thai
          ? 'ได้รับรูปแล้วค่ะ 🙏 รบกวนบอกชื่อสินค้าที่สนใจได้ไหมคะ'
          : 'Thanks for the photo 🙏 Could you tell me which item you are looking for?'
      );
    } finally {
      imageInFlight.delete(senderId);
    }
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

  // Language is fixed on first contact. Per-message detection would
  // flip a Thai customer to English the moment they type "ok".
  setLang(senderId, detectLang(text));
  const thai = (getLang(senderId) ?? 'th') === 'th';

  /* ── Caption for an image we're already answering ─────────
     Hand the text to the image handler and stay silent, so the
     customer gets one reply instead of two.
     ─────────────────────────────────────────────────────── */
  const inFlight = imageInFlight.get(senderId);
  if (inFlight !== undefined && Date.now() - inFlight < CAPTION_WAIT_MS + 1000) {
    pendingCaption.set(senderId, text);
    addTurn(senderId, 'user', text);
    console.log(`[CAPTION] ${senderId} — folded into the image reply`);
    return;
  }

  /* ── Human is driving this thread ─────────────────────────
     Checked BEFORE analysis — no point spending an API call on a
     conversation the bot isn't allowed to answer.
     ─────────────────────────────────────────────────────── */
  if (isTakenOver(senderId)) {
    addTurn(senderId, 'user', text);
    console.log(`[HUMAN MODE] ${senderId} — bot silent`);
    return;
  }

  /* ── One call: classify intent AND extract the order ─────── */
  const a = await analyze(senderId, text);

  if (!a) {
    // Analysis failed. Fall back to chatting rather than going silent —
    // a plain answer beats no answer.
    console.error(`[ANALYSIS FAILED] ${senderId} — falling back to chat`);
    const reply = await getAIReply(senderId, text);
    await sendMessage(senderId, reply);
    return;
  }

  console.log(
    `[TIER ${a.tier}] intent=${a.intent}` +
    (a.tierReason ? ` (${a.tierReason})` : '') +
    `  confirmed=${a.confirmed}  items=${a.items.length}` +
    (a.missing.length ? `  missing=${a.missing.join(',')}` : '')
  );

  /* ── Order confirmed, or payment raised with an order ready ─
     Checked before the tier cutoff: a customer saying "โอนยังไง"
     with a complete order should get their order number, not a
     bare handover message.

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

  /* ── TIER 3 — hard cutoff ─────────────────────────────────
     Payment, an explicit request for a person, or a complaint.
     Acknowledge briefly and stop. Do NOT keep selling or
     reassuring — that is what annoys an already-unhappy customer.

     The bot must never hand out an account number: it cannot
     verify a transfer, and a wrong PromptPay ID sends a
     customer's money to a stranger.
     ─────────────────────────────────────────────────────── */
  if (a.tier === 3) {
    takeOver(senderId);
    addTurn(senderId, 'user', text);
    console.warn(`[TIER 3] ${senderId} — ${a.intent}: ${a.tierReason}`);

    let msg: string;
    if (a.intent === 'complaint') {
      msg = thai
        ? 'ขอบคุณที่แจ้งนะคะ ทางร้านขอเช็คให้เดี๋ยวนี้เลยค่ะ 🙏'
        : 'Thank you for letting us know — we are looking into this right away 🙏';
    } else if (a.intent === 'human_request') {
      msg = thai
        ? 'สักครู่นะคะ เดี๋ยวแอดมินมาตอบเองค่ะ 🙏'
        : 'One moment please — our admin will reply to you shortly 🙏';
    } else {
      msg = thai
        ? 'รับทราบค่ะ 🙏 เดี๋ยวแอดมินมาสรุปยอดและแจ้งช่องทางชำระเงินให้นะคะ'
        : 'Noted 🙏 Our admin will confirm your order and send payment details shortly.';
    }

    await sendMessage(senderId, msg);
    return;
  }

  /* ── TIER 2 — soft handoff ────────────────────────────────
     Customisation or logistics the catalog doesn't cover. Keep
     helping with what we do know, but flag it so the seller can
     step in. The customer sees a normal reply — the flag is
     internal only.
     ─────────────────────────────────────────────────────── */
  if (a.tier === 2) {
    console.warn(`[TIER 2] ${senderId} — seller should follow up: ${a.tierReason}`);
    // Not takeOver(): the bot stays available for other questions.
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