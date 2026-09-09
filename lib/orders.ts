// lib/orders.ts
//
// Writes confirmed orders to the Orders tab. That sheet is the
// admin dashboard — the shop owner sets status by hand.

import { appendRow } from './sheets';
import type { ExtractedOrder } from './extract';

export async function saveOrder(
  customerId: string,
  order: ExtractedOrder
): Promise<string> {
  const orderNo = `ORD-${Date.now().toString(36).toUpperCase()}`;

  const items = order.items
    .map(i => `${i.title} ${i.color} ${i.size} x${i.qty}`.replace(/\s+/g, ' ').trim())
    .join(' | ');

  await appendRow('Orders', [
    new Date().toISOString(),
    customerId,
    items,
    order.total,
    'pending_payment',
    '',            // slip_url — filled in later
    orderNo,
  ]);

  return orderNo;
}