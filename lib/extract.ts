// lib/extract.ts
//
// Reads a conversation and returns the order as structured data.
//
// Deliberately a SEPARATE call from the chat reply. A bad extraction
// can't corrupt what the customer sees, and a chatty reply can't
// corrupt what lands in the sheet.

import { getHistory } from './memory';
import { getFormattedCatalog } from './catalog';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';
const SHIPPING_THB = Number(process.env.SHIPPING_THB ?? 40);

export type OrderItem = {
  title: string;
  color: string;
  size: string;
  qty: number;
  price: number;
};

export type ExtractedOrder = {
  confirmed: boolean;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  total: number;
  missing: string[];
};

const PROMPT = `คุณคือระบบดึงข้อมูลคำสั่งซื้อ ไม่ใช่แชทบอท
อ่านบทสนทนาแล้วตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น

กฎ:
- บทสนทนาอาจเป็นภาษาไทยหรืออังกฤษ ให้เข้าใจทั้งสองภาษา
- confirmed = true เฉพาะเมื่อบอทสรุปรายการแล้ว และลูกค้ายืนยัน
  (เช่น "ยืนยัน" "ตกลง" "เอาตามนี้" "yes" "confirm" "ok")
- ถ้าบอทยังไม่ได้สรุปรายการ ให้ confirmed = false เสมอ
- ใช้ราคาจากข้อมูลสินค้าเท่านั้น ถ้ามี "ราคาที่ถูกต้อง" ให้ใช้ตัวเลขนั้น
- ห้ามคิดราคาเอง ถ้าไม่รู้ราคาให้ใส่ 0
- title ให้ใช้ชื่อสินค้าภาษาไทยเสมอ แม้บทสนทนาเป็นภาษาอังกฤษ
- ถ้าข้อมูลไม่ครบ ใส่ชื่อฟิลด์ที่ขาดใน missing เช่น ["สี","ไซส์"]
- shipping = ${SHIPPING_THB} เสมอ

รูปแบบ:
{"confirmed":false,"items":[{"title":"","color":"","size":"","qty":0,"price":0}],"subtotal":0,"shipping":${SHIPPING_THB},"total":0,"missing":[]}`;

export async function extractOrder(senderId: string): Promise<ExtractedOrder | null> {
  const history = getHistory(senderId);
  if (history.length === 0) return null;

  const catalogText = await getFormattedCatalog();
  const transcript = history
    .map(t => `${t.role === 'user' ? 'ลูกค้า' : 'ร้าน'}: ${t.text}`)
    .join('\n');

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TYPHOON_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: `${PROMPT}\n\nสินค้า:\n${catalogText}` },
          { role: 'user', content: transcript },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800,
      }),
    });

    if (!res.ok) throw new Error(`Typhoon ${res.status}`);

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as ExtractedOrder;

    return recompute(parsed);
  } catch (err) {
    console.error('Extraction failed:', err);
    return null;
  }
}

/**
 * Recalculate totals in code rather than trusting the model.
 *
 * Language models are unreliable at arithmetic — an earlier build
 * double-counted shipping and quoted 1,260 instead of 1,220.
 * items.reduce() does not make that mistake.
 */
function recompute(order: ExtractedOrder): ExtractedOrder {
  const items = (order.items ?? []).filter(i => i.title && i.qty > 0);

  const subtotal = items.reduce(
    (sum, i) => sum + Number(i.price || 0) * Number(i.qty || 0),
    0
  );

  return {
    confirmed: Boolean(order.confirmed),
    items,
    subtotal,
    shipping: SHIPPING_THB,
    total: subtotal + SHIPPING_THB,
    missing: order.missing ?? [],
  };
}