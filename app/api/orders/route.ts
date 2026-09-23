// app/api/orders/route.ts
//
// PATCH one order: move it along the status line, attach a tracking
// number, tell the customer, and let the assistant back into the
// thread once the reason it stepped out of it is gone.
//
// Behind the password via proxy.ts, which had to grow one more entry
// or this would be an open endpoint for marking anybody's orders
// paid.
//
// ─────────────────────────────────────────────────────────────
// WHAT THIS DELIBERATELY CANNOT DO
//
// items, subtotal, shipping and total are not accepted here, and
// lib/orders.ts would ignore them anyway. What a customer agreed to
// is a record, not a working document — if a price was wrong, the
// honest fix is to cancel and write a new order so both the mistake
// and the correction stay visible.
//
// It also cannot skip a step. An order can only move where
// canMove() in lib/orders.ts allows, so nothing can mark a parcel
// shipped while it is still awaiting payment — the rule lives in
// code, not in which buttons the dashboard happens to draw. Moving
// BACKWARDS is still allowed, because "I marked that paid by
// mistake" has to be undoable and a server that refuses to reverse a
// mis-tap turns it into a support call.
//
// ─────────────────────────────────────────────────────────────
// THE ORDER IS SAVED BEFORE ANYTHING ELSE IS ATTEMPTED
//
// Three things happen here and only one of them is reliable. Writing
// the status to Postgres always works. Sending a DM depends on
// Instagram's 24-hour window. Releasing the handover touches Redis.
//
// So the write happens first and is never rolled back. The
// alternative — refusing to record that a parcel shipped because
// Meta would not deliver a notification about it — would let a
// messaging limitation corrupt the shop's own records.
//
// Both follow-ups report their own outcome in the response, so the
// dashboard can show "saved, but not delivered" as the honest
// two-part result it is.
// ─────────────────────────────────────────────────────────────

import { and, eq } from 'drizzle-orm';
import { updateOrder, isOrderStatus, canMove, getOrder } from '../../../lib/orders';
import { sendDM, threadLang, shippedMessage } from '../../../lib/messenger';
import { logMessage, setHandover } from '../../../lib/conversations';
import { releaseToBot, clearOrdered } from '../../../lib/memory';
import { getShopConfig } from '../../../lib/shop';
import { db, getShopId } from '../../../lib/db';
import { conversations } from '../../../lib/db/schema';

export const dynamic = 'force-dynamic';

/** Long enough for any real courier code, short enough that a paste
 *  accident cannot put a paragraph in the column. */
const TRACKING_MAX = 64;

export async function PATCH(req: Request) {
  try {
    const body = await req.json();

    const orderNo = typeof body?.orderNo === 'string' ? body.orderNo.trim() : '';
    if (!orderNo) {
      return Response.json({ ok: false, error: 'missing orderNo' }, { status: 400 });
    }

    const patch: Parameters<typeof updateOrder>[1] = {};

    if (body.status !== undefined) {
      if (!isOrderStatus(body.status)) {
        return Response.json({ ok: false, error: 'bad status' }, { status: 400 });
      }
      patch.status = body.status;
    }

    if (body.trackingNo !== undefined) {
      // Couriers print these with spaces in them; the spaces are not
      // part of the number and make it impossible to search for.
      const raw = String(body.trackingNo ?? '').replace(/\s+/g, '').trim();
      if (raw.length > TRACKING_MAX) {
        return Response.json({ ok: false, error: 'tracking too long' }, { status: 400 });
      }
      patch.trackingNo = raw;
    }

    if (body.note !== undefined) {
      patch.note = String(body.note ?? '').trim().slice(0, 500);
    }

    if (Object.keys(patch).length === 0) {
      return Response.json({ ok: false, error: 'nothing to update' }, { status: 400 });
    }

    // Read the order first, so an illegal move is refused before
    // anything is written. Both reads are scoped to this shop, so a
    // guessed order number from another shop matches nothing rather
    // than being read or edited.
    const current = await getOrder(orderNo);
    if (!current) {
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    }

    if (patch.status !== undefined && !canMove(current.status, patch.status)) {
      // 409: the request is well formed, but the order is not in a
      // state where this move makes sense. The message says both
      // ends, because "cannot do that" with no reason is the kind of
      // error that costs an afternoon.
      return Response.json(
        {
          ok: false,
          error: `cannot move an order from ${current.status} to ${patch.status}`,
          from: current.status,
          to: patch.status,
        },
        { status: 409 }
      );
    }

    const order = await updateOrder(orderNo, patch);
    if (!order) {
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    }

    const [notify, handover] = await Promise.all([
      maybeTellCustomer({
        wanted: body.notify === true,
        orderNo: order.orderNo,
        customerId: order.customerId,
        tracking: order.trackingNo ?? '',
      }),
      maybeHandBackToBot({
        customerId: order.customerId,
        orderNo: order.orderNo,
        status: order.status,
        tracking: order.trackingNo ?? '',
      }),
    ]);

    // Hand the saved row back. The card shows what was actually
    // stored rather than what was tapped — so if the tracking number
    // came back stripped of spaces, that is what appears on screen.
    return Response.json({ ok: true, order, notify, handover });
  } catch (err: any) {
    console.error('Order update failed:', err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────
   Letting the assistant back in

   When a customer confirms an order, the webhook hands the thread to
   a human with the reason "order ORD-XXXX awaiting payment" and the
   bot goes quiet. That is right: the next thing to happen is money,
   and the assistant has no business anywhere near it.

   But nothing was ever undoing it. Once payment was confirmed the
   reason had evaporated, and the thread sat in the แชท tab flagged
   ด่วน forever — a red mark for a job already done, with the bot
   still silent, so the customer's next question went unanswered.

   TWO DIFFERENT RULES, ON PURPOSE

   Paid or cancelled → release only if the stored reason names THIS
   order. A thread can be handed over for reasons that have nothing
   to do with payment, and dropping someone back onto the bot in the
   middle of a complaint is worse than a stale flag.

   Shipped with a tracking number → release, whatever the reason.
   The parcel is gone and the customer has the number; the
   transaction is finished, and the thread should be open for the
   next one.

   That second rule is safe because handover is self-healing. If the
   customer's next message needs a person, analyze() hands the thread
   over again on that message. The cost of being wrong is one
   automated reply before it steps back out — against the cost of
   being wrong the other way, which is a customer who cannot buy
   anything because the assistant is permanently muted on their
   thread.
   ───────────────────────────────────────────────────────────── */

type Handover =
  /** Nothing to do: the thread was not handed over, or was handed
   *  over for some other reason, or the order is still unpaid. */
  | { released: false; keptReason?: string }
  | { released: true };

async function maybeHandBackToBot(opts: {
  customerId: string;
  orderNo: string;
  status: string;
  tracking: string;
}): Promise<Handover> {
  // Still awaiting payment — the reason the bot stepped back is
  // still true, so leave it alone.
  if (opts.status === 'pending_payment') return { released: false };

  // Shipped AND the customer has a tracking number: done, releases
  // no matter why the thread was handed over. Shipped with no
  // tracking number is not the same thing — nothing has been sent to
  // the customer, so it falls through to the cautious rule below.
  const finished = opts.status === 'shipped' && opts.tracking.length > 0;

  try {
    const shopId = await getShopId();
    const [convo] = await db
      .select({
        handedOver: conversations.handedOver,
        handoverReason: conversations.handoverReason,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.shopId, shopId),
          eq(conversations.customerId, opts.customerId)
        )
      )
      .limit(1);

    if (!convo?.handedOver) return { released: false };

    if (!finished && !convo.handoverReason?.includes(opts.orderNo)) {
      // Paid or cancelled, handed over for something else. Not ours
      // to undo — the owner clears it with ให้ผู้ช่วยตอบต่อ.
      return { released: false, keptReason: convo.handoverReason ?? '' };
    }

    // Three keys, not one. The handover flag is what makes the bot
    // speak again; clearOrdered is what lets it ACCEPT A NEW ORDER.
    // Without the second one the assistant would be chatting away
    // and then refusing to take an order on that thread for 24
    // hours, which is the exact opposite of what shipping should
    // leave behind.
    await releaseToBot(opts.customerId);
    await clearOrdered(opts.customerId);
    await setHandover(opts.customerId, false);

    console.log(`[BOT RESUMED] ${opts.customerId} — ${opts.orderNo} is ${opts.status}`);
    return { released: true };
  } catch (err) {
    // Never fail the status change over this. The order is already
    // saved correctly; the worst case is a stale red flag the owner
    // can clear by hand.
    console.error('Handover release failed:', err);
    return { released: false };
  }
}

/* ─────────────────────────────────────────────────────────────
   Telling the customer
   ───────────────────────────────────────────────────────────── */

type Notify =
  | { attempted: false }
  | { attempted: true; sent: true; text: string }
  | {
      attempted: true;
      sent: false;
      /** True when Meta refused because the 24-hour window is shut,
       *  which is an ordinary outcome and not a fault. */
      windowClosed: boolean;
      error: string;
      /** Handed back so the owner can paste it into Instagram. */
      text: string;
    };

async function maybeTellCustomer(opts: {
  wanted: boolean;
  orderNo: string;
  customerId: string;
  tracking: string;
}): Promise<Notify> {
  // No tracking number, nothing to tell them. This is why the
  // checkbox being ticked with an empty box is harmless.
  if (!opts.wanted || !opts.tracking) return { attempted: false };

  // The customer's own language, not the dashboard's. The owner may
  // be reading the dashboard in English while the thread is Thai.
  const [lang, shop] = await Promise.all([
    threadLang(opts.customerId),
    getShopConfig().catch(() => null),
  ]);

  const text = shippedMessage({
    orderNo: opts.orderNo,
    tracking: opts.tracking,
    carrier: shop?.shipping_carrier ?? '',
    lang,
  });

  const result = await sendDM(opts.customerId, text);

  if (!result.ok) {
    return {
      attempted: true,
      sent: false,
      windowClosed: result.windowClosed,
      error: result.error,
      text,
    };
  }

  // Logged so it appears in the thread on the แชท tab. The webhook
  // will not log it: sendDM marks it as ours, and the echo Meta
  // sends back is dropped as a duplicate.
  //
  // Recorded as a bot message because the system composed and sent
  // it. 'human' is reserved for what the seller types inside
  // Instagram itself.
  await logMessage({ customerId: opts.customerId, role: 'bot', text }).catch(() => {});

  return { attempted: true, sent: true, text };
}