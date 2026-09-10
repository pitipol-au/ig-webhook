// lib/extract.ts
//
// One call that does two jobs: classify what the customer wants, and
// pull out the order if there is one.
//
// This REPLACES the keyword trigger lists. Keywords cannot work here —
// they need to be loose enough to catch real intent and tight enough
// to avoid false matches, in two languages, and that does not converge.
// Every fix so far proved it:
//
//   สี      matched inside unrelated Thai words
//   ครับ    matched inside สวัสดีครับ
//   account matched "what's this account for?"
//   ok      matched inside "book"
//
// A model reads the sentence and knows the difference.

import { getHistory } from './memory';
import { getFormattedCatalog } from './catalog';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';
const SHIPPING_THB = Number(process.env.SHIPPING_THB ?? 40);

export type Intent =
  | 'question'        // browsing, asking about products or the shop
  | 'confirm_order'   // agreeing to a summarised order
  | 'payment'         // asking how to pay, or claiming to have paid
  | 'human_request'   // explicitly wants a person
  | 'other';

export type OrderItem = {
  title: string;
  color: string;
  size: string;
  qty: number;
  price: number;
};

export type Analysis = {
  intent: Intent;
  confirmed: boolean;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  total: number;
  missing: string[];
};

const PROMPT = `คุณคือระบบวิเคราะห์บทสนทนาการขาย ไม่ใช่แชทบอท
อ่านบทสนทนาแล้วตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น

--- การจำแนก intent (ดูจากข้อความล่าสุดของลูกค้า) ---

"question"      = ถามข้อมูลสินค้า ราคา สต็อก ค่าส่ง หรือถามเรื่องทั่วไป
                  รวมถึงถามว่าบัญชีนี้คือร้านอะไร ขายอะไร
"confirm_order" = ตอบตกลงกับรายการที่ร้านสรุปไปแล้ว
                  ต้องมีการสรุปรายการก่อนเท่านั้น
"payment"       = ถามวิธีชำระเงิน ขอเลขบัญชี ขอ QR หรือแจ้งว่าโอนแล้ว
"human_request" = ขอคุยกับคน ขอแอดมิน
"other"         = ทักทาย คุยเล่น หรืออื่นๆ

สำคัญมาก:
- "ครับ" "ค่ะ" เป็นคำลงท้ายสุภาพ ไม่ใช่การยืนยัน
  "สวัสดีครับ" = other, ไม่ใช่ confirm_order
- คำว่า "บัญชี" "account" อาจหมายถึงบัญชี Instagram ไม่ใช่บัญชีธนาคาร
  "What's this account for?" = question, ไม่ใช่ payment
- ดูความหมายของทั้งประโยค ห้ามดูแค่คำเดี่ยวๆ
- บทสนทนาอาจเป็นภาษาไทยหรืออังกฤษ

--- การดึงข้อมูลคำสั่งซื้อ ---

- confirmed = true เฉพาะเมื่อ intent = "confirm_order" หรือ "payment"
  และร้านได้สรุปรายการไปแล้ว และลูกค้าตกลง
- ถ้าร้านยังไม่ได้สรุปรายการ ให้ confirmed = false เสมอ
- ใช้ราคาจากข้อมูลสินค้าเท่านั้น ถ้ามี "ราคาที่ถูกต้อง" ให้ใช้ตัวเลขนั้น
- ห้ามคิดราคาเอง ถ้าไม่รู้ราคาให้ใส่ 0
- title ให้ใช้ชื่อสินค้าภาษาไทยเสมอ แม้บทสนทนาเป็นภาษาอังกฤษ
- ถ้าข้อมูลไม่ครบ ใส่ชื่อฟิลด์ที่ขาดใน missing เช่น ["สี","ไซส์"]

รูปแบบ:
{"intent":"question","confirmed":false,"items":[],"subtotal":0,"shipping":${SHIPPING_THB},"total":0,"missing":[]}`;

export async function analyze(
  senderId: string,
  latestText: string
): Promise<Analysis | null> {
  const history = getHistory(senderId);
  const catalogText = await getFormattedCatalog();

  const transcript = [
    ...history.map(t => `${t.role === 'user' ? 'ลูกค้า' : 'ร้าน'}: ${t.text}`),
    `ลูกค้า (ข้อความล่าสุด): ${latestText}`,
  ].join('\n');

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
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    return recompute(parsed);
  } catch (err) {
    console.error('Analysis failed:', err);
    return null;
  }
}

/**
 * Totals computed in code, never trusted from the model.
 *
 * An earlier build double-counted shipping and quoted 1,260 instead
 * of 1,220. items.reduce() does not make that mistake.
 */
function recompute(raw: any): Analysis {
  const items: OrderItem[] = (raw.items ?? []).filter(
    (i: OrderItem) => i?.title && Number(i.qty) > 0
  );

  const subtotal = items.reduce(
    (sum, i) => sum + Number(i.price || 0) * Number(i.qty || 0),
    0
  );

  const validIntents: Intent[] = [
    'question', 'confirm_order', 'payment', 'human_request', 'other',
  ];
  const intent: Intent = validIntents.includes(raw.intent)
    ? raw.intent
    : 'question';   // safest default — keeps the bot talking

  return {
    intent,
    confirmed: Boolean(raw.confirmed),
    items,
    subtotal,
    shipping: SHIPPING_THB,
    total: subtotal + SHIPPING_THB,
    missing: raw.missing ?? [],
  };
}