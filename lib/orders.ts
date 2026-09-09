import { appendRow } from './sheets';
import type { ExtractedOrder } from './extract';

export async function saveOrder(
  customerId: string,
  order: ExtractedOrder
): Promise<string> {
  const orderNo = `ORD-${Date.now().toString(36).toUpperCase()}`;

  const items = order.items
    .map(i => `${i.title} ${i.color} ${i.size} x${i.qty}`)
    .join(' | ');

  await appendRow('Orders', [
    new Date().toISOString(),
    customerId,
    items,
    order.total,
    'pending_payment',
    '',                 // slip_url — filled later
    orderNo,
  ]);

  return orderNo;
}