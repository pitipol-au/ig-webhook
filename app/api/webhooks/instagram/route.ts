// app/api/webhooks/instagram/route.ts
//
// ─────────────────────────────────────────────────────────────
// THE ONE CHANGE IN THIS STEP
//
// Step 2a moved the whole app onto Postgres without touching this
// file, on purpose: if a DM had stopped being answered, there would
// have been one thing to blame. That held, so now this file gets its
// change — and it is only ever one kind of change.
//
// Every branch that answers a customer now also calls logMessage(),
// and every branch that stops the bot also calls setHandover(). None
// of the routing logic moved. No condition changed. No tier changed.
// The bot behaves exactly as it did; it just writes down what it did.
//
// The logging calls are all AFTER the reply has been sent, and every
// one of them swallows its own errors (see lib/conversations.ts). A
// database problem cannot stop a customer getting an answer.
// ─────────────────────────────────────────────────────────────

import { after } from 'next/server';
import { getAIReply, chooseLang } from '../../../../lib/ai';
import { analyze } from '../../../../lib/extract';
import { analyzeImage, findSimilar } from '../../../../lib/image';
import { saveOrder } from '../../../../lib/orders';
import { syncIfStale } from '../../../../lib/sync';
import { logMessage, setHandover, pruneIfDue } from '../../../../lib/conversations';
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
    // Retention, piggybacking on traffic the same way sync does. One
    // run a day across every instance, no cron to configure.
    pruneIfDue().catch(() => {});

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
        const slipReply = slipThai
          ? 'ได้รับสลิปแล้วค่ะ 🙏 เดี๋ยวแอดมินตรวจสอบและยืนยันให้นะคะ'
          : 'Slip received 🙏 Our admin will verify and confirm shortly.';

        await sendMessage(senderId, slipReply);

        // The slip URL is recorded on the message so the dashboard can
        // show the actual image next to the order rather than making
        // the seller hunt for it in Instagram. Meta's CDN links do
        // expire, which is a known limit of storing the URL rather
        // than the file.
        await logMessage({
          customerId: senderId,
          role: 'customer',
          text: '',
          imageUrl: url ?? '',
          imageKind: 'slip',
          intent: 'payment',
          tier: 3,
          tierReason: 'sent a payment slip',
          lang: slipThai ? 'th' : 'en',
        });
        await logMessage({ customerId: senderId, role: 'bot', text: slipReply });
        await setHandover(senderId, true, 'sent a payment slip');
        return;
      }

      // Give a caption time to arrive as its own webhook request.
      await new Promise(r => setTimeout(r, CAPTION_WAIT_MS));
      const caption = await takePendingCaption(senderId);
      if (caption) console.log(`[CAPTION] ${senderId} — "${caption}"`);

      // Language must be decided AFTER the caption arrives. A photo
      // carries no language signal, so an English caption was
      // previously ignored and every photo reply came back in Thai.
      if (caption) {
        await setLang(senderId, chooseLang(caption, await getLang(senderId)));
      }
      const thai = ((await getLang(senderId)) ?? 'th') === 'th';

      await logMessage({
        customerId: senderId,
        role: 'customer',
        // The vision model's description, so the thread reads
        // sensibly later even once the image link has expired.
        text: description ? `[รูป: ${description}]` : '[รูป]',
        imageUrl: url ?? '',
        imageKind: kind,
        lang: thai ? 'th' : 'en',
      });

      /* A photo with no words is still a question: "do you have
         this?". So ANY image that is not a payment slip is matched
         against the catalogue — including one the classifier was
         unsure about. The vision model describes; the chat model
         matches against the real catalogue; and findSimilar only
         reports a match when the reply names a product that exists.

         Two outcomes, both of them an answer:
           matched  -> the closest things the shop really has
           no match -> "we don't carry anything like this", and the
                       thread is flagged so the owner can follow up.
         Asking the customer to type the item name instead is the one
         thing we do not do — they already told us, with a picture. */
      if (description) {
        try {
          const match = await findSimilar(
            caption ? `${description}\n\nCustomer also said: ${caption}` : description,
            thai
          );

          await addTurn(
            senderId,
            'user',
            `[photo: ${description}]${caption ? ` ${caption}` : ''}`
          );
          await addTurn(senderId, 'model', match.reply);
          await sendMessage(senderId, match.reply);

          if (match.matched) {
            await logMessage({ customerId: senderId, role: 'bot', text: match.reply });
          } else {
            // Tier 2: answered, and put on the owner's follow-up list.
            // A photo of something we do not sell is demand the shop
            // cannot fill — worth seeing on the dashboard rather than
            // losing in a thread.
            console.log(`[NO MATCH] ${senderId} — ${description.slice(0, 80)}`);
            await logMessage({
              customerId: senderId,
              role: 'bot',
              text: match.reply,
              intent: 'other',
              tier: 2,
              tierReason: 'sent a photo of something the catalogue does not cover',
            });
          }
          return;
        } catch (err) {
          console.error('Similar-item match failed:', err);
        }
      }

      // Only reached when the image could not be described at all, or
      // matching threw. Then asking is the honest thing to do.
      const fallback = thai
        ? 'ได้รับรูปแล้วค่ะ 🙏 รบกวนบอกชื่อสินค้าที่สนใจได้ไหมคะ'
        : 'Thanks for the photo 🙏 Could you tell me which item you are looking for?';
      await sendMessage(senderId, fallback);
      await logMessage({ customerId: senderId, role: 'bot', text: fallback });
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
      await setHandover(customerId, false);
    } else {
      await takeOver(customerId);
      console.log(`[HUMAN MODE] ${customerId} — you replied manually`);
      // Recorded as 'human', not 'bot'. The dashboard needs to show
      // which replies the seller wrote themselves — otherwise the
      // transcript reads as though the bot said everything, and the
      // owner cannot tell what it actually handled for them.
      await logMessage({
        customerId,
        role: 'human',
        text: event.message.text,
      });
      await setHandover(customerId, true, 'seller replied in Instagram');
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

  // The one place the thread's language is decided, once per message.
  // chooseLang weighs the new message against what the thread is
  // already in — see the rule in lib/ai.ts.
  const chosen = chooseLang(text, await getLang(senderId));
  await setLang(senderId, chosen);
  const thai = chosen === 'th';
  const lang = chosen;

  /* ── Caption for an image being answered right now ────────
     Hand the text to the image handler and stay silent, so the
     customer gets one reply instead of two. The flag lives in
     Redis, so this works across instances.
     ─────────────────────────────────────────────────────── */
  if (await isImageInFlight(senderId)) {
    await setPendingCaption(senderId, text);
    await addTurn(senderId, 'user', text);
    console.log(`[CAPTION] ${senderId} — folded into the image reply`);
    await logMessage({ customerId: senderId, role: 'customer', text, lang });
    return;
  }

  /* ── Human is driving this thread ─────────────────────────
     Checked BEFORE analysis — no point spending an API call on a
     conversation the bot isn't allowed to answer.
     ─────────────────────────────────────────────────────── */
  if (await isTakenOver(senderId)) {
    await addTurn(senderId, 'user', text);
    console.log(`[HUMAN MODE] ${senderId} — bot silent`);
    // Logged with no intent: analyze() never ran, so there is nothing
    // to record. A guess here would put a fabricated topic in the
    // seller's report.
    await logMessage({ customerId: senderId, role: 'customer', text, lang });
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
    await logMessage({ customerId: senderId, role: 'customer', text, lang });
    await logMessage({ customerId: senderId, role: 'bot', text: reply });
    return;
  }

  console.log(
    `[TIER ${a.tier}] intent=${a.intent}` +
    (a.tierReason ? ` (${a.tierReason})` : '') +
    `  confirmed=${a.confirmed}  items=${a.items.length}` +
    (a.missing.length ? `  missing=${a.missing.join(',')}` : '')
  );

  // The customer's message, logged once here with what analyze()
  // decided about it. Every branch below logs only the reply, so a
  // message can never be recorded twice.
  await logMessage({
    customerId: senderId,
    role: 'customer',
    text,
    intent: a.intent,
    tier: a.tier,
    tierReason: a.tierReason,
    // The restock signal: sizes and colours the customer asked for and
    // the shop does not have. Read by the daily digest.
    missing: a.missing,
    lang,
  });

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

    const confirmation = orderConfirmation(orderNo, a.total, thai);
    await sendMessage(senderId, confirmation);
    await logMessage({ customerId: senderId, role: 'bot', text: confirmation });
    await setHandover(senderId, true, `order ${orderNo} awaiting payment`);
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
    await logMessage({ customerId: senderId, role: 'bot', text: msg });
    // The reason analyze() gave, stored verbatim. This is the column
    // the seller actually reads: "asked for bank account" tells them
    // what to do next, where a bare "handed over" does not.
    await setHandover(senderId, true, a.tierReason || a.intent);
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
    // Not setHandover() either — the thread is not quiet, so marking
    // it handed over would misrepresent it in the dashboard. The
    // tier-2 reason is on the message row instead, which is where a
    // "needs follow-up" list should read it from.
  }

  /* ── Everything else: normal conversation ────────────────── */
  const reply = await getAIReply(senderId, text);
  console.log(`REPLY: ${reply}`);
  await sendMessage(senderId, reply);
  await logMessage({ customerId: senderId, role: 'bot', text: reply });
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