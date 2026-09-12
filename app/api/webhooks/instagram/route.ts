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
  claimMessage,
  markImageInFlight,
  isImageInFlight,
  clearImageInFlight,
  setPendingCaption,
  takePendingCaption,
} from '../../../../lib/memory';

// How long to wait for a caption to arrive as its own webhook request.
const CAPTION_WAIT_MS = 2500;

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

    // Shared flag, so the text handler on ANOTHER instance can see it.
    await markImageInFlight(senderId);

    try {
      // Classify first — a slip must never wait, and must never be
      // confused with a product enquiry.
      const { kind, description } = await analyzeImage(url);
      console.log(
        `[IMAGE] ${senderId} — ${kind}` +
        (description ? `: ${description.slice(0, 80)}` : '')
      );

      if (kind === 'slip') {
        await takeOver(senderId);
        console.log(`[SLIP URL] ${url}`);
        const slipThai = ((await getLang(senderId)) ?? 'th') === 'th';
        await sendMessage(
          senderId,
          slipThai
            ? 'ได้รับสลิปแล้วค่ะ 🙏 เดี๋ยวแอดมินตรวจสอบและยืนยันให้นะคะ'
            : 'Slip received 🙏 Our admin will verify and confirm shortly.'
        );
        return;
      }

      // Give a caption time to arrive as its own webhook request.
      await new Promise(r => setTimeout(r, CAPTION_WAIT_MS));
      const caption = await takePendingCaption(senderId);
      if (caption) console.log(`[CAPTION] ${senderId} — "${caption}"`);

      // Language must be decided AFTER the caption arrives. A photo
      // carries no language signal, so an English caption was
      // previously ignored and every photo reply came back in Thai.
      if (caption) await setLang(senderId, detectLang(caption));
      const thai = ((await getLang(senderId)) ?? 'th') === 'th';

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
            await addTurn(
              senderId,
              'user',
              `[photo: ${description}]${caption ? ` ${caption}` : ''}`
            );
            await addTurn(senderId, 'model', suggestion);
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
      await clearImageInFlight(senderId);
    }
    return;
  }

  if (!event.message?.text) return;

  /* ── Echoes of our own outbound messages ─────────────────── */
  if (event.message.is_echo) {
    const customerId = event.recipient.id;

    if (await wasBotSent(event.message.text)) return;

    if (event.message.text.startsWith('/bot')) {
      await releaseToBot(customerId);
      await clearOrdered(customerId);   // allow a new order on this thread
      console.log(`[BOT RESUMED] ${customerId}`);
    } else {
      await takeOver(customerId);
      console.log(`[HUMAN MODE] ${customerId} — you replied manually`);
    }
    return;
  }

  const senderId = event.sender.id;
  const text = event.message.text;
  const mid = event.message.mid;

  // Atomic claim: the first invocation to see this message wins,
  // even across instances. Meta retries can no longer duplicate an order.
  if (!(await claimMessage(mid))) {
    console.log('Duplicate, skipping:', mid);
    return;
  }

  console.log(`Message from ${senderId}: ${text}`);

  await setLang(senderId, detectLang(text));
  const thai = ((await getLang(senderId)) ?? 'th') === 'th';

  /* ── Caption for an image being answered right now ────────
     Hand the text to the image handler and stay silent, so the
     customer gets one reply instead of two. The flag lives in
     Redis, so this works across instances.
     ─────────────────────────────────────────────────────── */
  if (await isImageInFlight(senderId)) {
    await setPendingCaption(senderId, text);
    await addTurn(senderId, 'user', text);
    console.log(`[CAPTION] ${senderId} — folded into the image reply`);
    return;
  }

  /* ── Human is driving this thread ─────────────────────────
     Checked BEFORE analysis — no point spending an API call on a
     conversation the bot isn't allowed to answer.
     ─────────────────────────────────────────────────────── */
  if (await isTakenOver(senderId)) {
    await addTurn(senderId, 'user', text);
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
     ─────────────────────────────────────────────────────── */
  if (
    (a.intent === 'confirm_order' || a.intent === 'payment') &&
    a.confirmed &&
    a.items.length > 0 &&
    !(await hasOrdered(senderId))
  ) {
    await markOrdered(senderId);
    await takeOver(senderId);
    await addTurn(senderId, 'user', text);

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
    await takeOver(senderId);
    await addTurn(senderId, 'user', text);
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
  // Record before sending so we recognise the echo when it returns.
  await markBotSent(text);

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