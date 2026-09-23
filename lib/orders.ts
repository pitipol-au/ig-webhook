// lib/orders.ts
//
// Confirmed orders. Previously a row appended to the Orders tab; now
// a row in Postgres, with the dashboard reading it instead of Sheets.
//
// What changed beyond storage:
//
// - subtotal and shipping are stored alongside the total, not just
//   the total. Recomputing an old order's shipping from today's
//   setting would rewrite history the moment the seller changes
//   their shipping fee.
//
// - items keeps its structure. The sheet flattened them to
//   "เสื้อ ขาว M x2 | กระโปรง ดำ L x1" because a cell holds text, so
//   nothing downstream could read back what was actually ordered.
//   The dashboard can now show a real line-item list.
//
// - The order number is still generated HERE, in code. Same rule as
//   the total: the model never produces a number a customer sees.

import { eq, and, desc } from 'drizzle-orm';
import { db, getShopId } from './db';
import { orders, ORDER_STATUSES, type Order, type OrderStatus } from './db/schema';
import type { Analysis } from './extract';

export type { Order, OrderStatus };
export { ORDER_STATUSES };

/**
 * Write a confirmed order and return its number.
 *
 * The duplicate guard is NOT here — it is hasOrdered()/markOrdered()
 * in memory.ts, checked before this is called. That guard is in Redis
 * because SET NX is atomic across instances, which is what makes a
 * double order impossible even when Meta retries the same message.
 * A database check-then-insert would have a gap between the two.
 */
export async function saveOrder(
  customerId: string,
  order: Analysis
): Promise<string> {
  const shopId = await getShopId();
  const orderNo = `ORD-${Date.now().toString(36).toUpperCase()}`;

  await db.insert(orders).values({
    shopId,
    orderNo,
    customerId,
    items: order.items.map(i => ({
      title: i.title,
      color: i.color,
      size: i.size,
      qty: i.qty,
      price: i.price,
    })),
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    status: 'pending_payment',
  });

  return orderNo;
}

/* ─────────────────────────────────────────────────────────────
   Reads for the dashboard
   ───────────────────────────────────────────────────────────── */

export async function listOrders(limit = 200): Promise<Order[]> {
  const shopId = await getShopId();
  return db
    .select()
    .from(orders)
    .where(eq(orders.shopId, shopId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

export async function countPendingPayment(): Promise<number> {
  const shopId = await getShopId();
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.status, 'pending_payment')));
  return rows.length;
}

export async function getOrdersForCustomer(customerId: string): Promise<Order[]> {
  const shopId = await getShopId();
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.customerId, customerId)))
    .orderBy(desc(orders.createdAt));
}

/* ─────────────────────────────────────────────────────────────
   Writes from the dashboard
   ───────────────────────────────────────────────────────────── */

export function isOrderStatus(v: unknown): v is OrderStatus {
  return typeof v === 'string' && (ORDER_STATUSES as readonly string[]).includes(v);
}

/* ─────────────────────────────────────────────────────────────
   WHICH MOVES ARE ALLOWED

   The dashboard only offers the sensible next move, so this could
   not be reached by tapping. It is here because the rule belongs in
   code, not in the shape of a button: nothing should be able to mark
   a parcel shipped before a person has confirmed the money arrived.

   Going backwards IS allowed, deliberately. "I tapped that by
   mistake" has to be undoable, and a server that refuses to reverse
   a mis-tap turns it into a support call. What is refused is only
   skipping a step forward:

     awaiting payment  ->  paid | cancelled
     paid              ->  shipped | awaiting payment (undo) | cancelled
     shipped           ->  shipped (edit tracking) | paid (undo)
     cancelled         ->  awaiting payment (reopen)

   Not listed, and therefore refused: awaiting payment -> shipped,
   cancelled -> paid or shipped.
   ───────────────────────────────────────────────────────────── */

const ALLOWED_MOVES: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['pending_payment', 'paid', 'cancelled'],
  paid: ['paid', 'shipped', 'pending_payment', 'cancelled'],
  shipped: ['shipped', 'paid'],
  cancelled: ['cancelled', 'pending_payment'],
};

/** True if an order in `from` may be moved to `to`. */
export function canMove(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_MOVES[from].includes(to);
}

/** One order by its number, scoped to this shop. Null if there is no
 *  such order here — a guessed number from another shop finds
 *  nothing rather than leaking a row. */
export async function getOrder(orderNo: string): Promise<Order | null> {
  const shopId = await getShopId();
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.orderNo, orderNo)))
    .limit(1);
  return row ?? null;
}

/**
 * Move an order along, or attach a slip or tracking number.
 *
 * Note what is NOT updatable: items, subtotal, shipping, total. What
 * the customer agreed to is a record, not a working document. If a
 * price was wrong, the honest fix is cancelling and writing a new
 * order, so both the mistake and the correction are visible.
 */
export async function updateOrder(
  orderNo: string,
  patch: {
    status?: OrderStatus;
    slipUrl?: string;
    trackingNo?: string;
    note?: string;
  }
): Promise<Order | null> {
  const shopId = await getShopId();

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.slipUrl !== undefined) set.slipUrl = patch.slipUrl;
  if (patch.trackingNo !== undefined) set.trackingNo = patch.trackingNo;
  if (patch.note !== undefined) set.note = patch.note;

  const [row] = await db
    .update(orders)
    .set(set)
    .where(and(eq(orders.shopId, shopId), eq(orders.orderNo, orderNo)))
    .returning();

  return row ?? null;
}