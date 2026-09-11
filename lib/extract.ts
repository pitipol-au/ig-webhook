// lib/extract.ts
//
// One call that classifies the message AND extracts the order.
//
// Replaced keyword trigger lists, which could never be both loose
// enough to catch real intent and tight enough to avoid false matches,
// in two languages. Every attempt proved it:
//
//   สี      matched inside unrelated Thai words
//   ครับ    matched inside สวัสดีครับ
//   account matched "what's this account for?"
//   ok      matched inside "book"
//
// The tier system comes from a colleague's prompt design, with one
// change: tiers are returned as STRUCTURED DATA, never appended to
// the reply text. The original design had the model write
// "[SYSTEM NOTE: Tier 3 triggered]" into its answer — which would
// send internal telemetry straight to the customer.

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
  | 'complaint'       // frustrated, unhappy, cancelling
  | 'uncovered'       // customisation or logistics not in the catalog
  | 'other';

/**
 * 1 = bot handles it
 * 2 = bot keeps helping, seller gets notified (soft handoff)
 * 3 = bot stops, human takes over (hard cutoff)
 */
export type Tier = 1 | 2 | 3;

export type OrderItem = {
  title: string;
  color: string;
  size: string;
  qty: number;
  price: number;
};

export type Analysis = {
  intent: Intent;
  tier: Tier;
  tierReason: string;
  confirmed: boolean;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  total: number;
  missing: string[];
};

const PROMPT = `You analyse sales conversations. You are not a chatbot.
Read the conversation and reply with JSON only. No other text.

=== INTENT (judge the customer's LATEST message) ===

"question"      = asking about products, prices, stock, shipping, or
                  general shop questions, including "what is this
                  account for"
"confirm_order" = agreeing to an order the shop has already summarised.
                  Requires a prior summary.
"payment"       = asking how to pay, requesting an account number or QR,
                  or saying they have transferred
"human_request" = explicitly asking to speak to a person
"complaint"     = frustrated, dissatisfied, complaining about service,
                  or cancelling
"uncovered"     = asking for customisation, or a shipping/logistics
                  detail the product information does not cover,
                  asked in a neutral tone
"other"         = greetings, small talk, anything else

CRITICAL:
- "ครับ" and "ค่ะ" are politeness particles, NOT confirmations.
  "สวัสดีครับ" is "other", not "confirm_order".
- "บัญชี" / "account" may mean an Instagram account, not a bank account.
  "What's this account for?" is "question", not "payment".
- Judge the meaning of the whole sentence. Never match on single words.
- Judge complaints by TONE and MEANING, not by keyword.
  "พอแล้วค่ะ ขอบคุณ" is a polite ending, not a complaint.
  "พอแล้ว! ตอบช้ามาก" is a complaint.
- The conversation may be in Thai or English.

=== TIER ===

tier 1 = intent is question, confirm_order, or other.
         The bot handles it.
tier 2 = intent is uncovered.
         The bot keeps helping with what it knows; the seller is
         notified in the background.
tier 3 = intent is payment, human_request, or complaint.
         The bot stops and a human takes over.

tierReason = a short phrase in English explaining the trigger,
             e.g. "asked for bank account", "frustrated tone",
             "custom embroidery request"

=== ORDER EXTRACTION ===

- confirmed = true only when intent is "confirm_order" or "payment",
  AND the shop has already summarised the order, AND the customer
  agreed.
- If the shop has not summarised yet, confirmed = false always.
- Use prices from the product information only. If a product shows
  "ราคาที่ถูกต้อง", use that number.
- Never calculate a price yourself. If unknown, use 0.
- title must be the Thai product name, even in an English conversation.

VALIDATION BEFORE CONFIRMING:
- size must match that product's "ไซส์ที่มีจริงทั้งหมด".
  If not, confirmed = false and add "ไซส์ไม่ถูกต้อง" to missing.
- color must match that product's "สีที่มีจริงทั้งหมด".
  If not, confirmed = false and add "สีไม่ถูกต้อง" to missing.
- If the product is marked "สินค้าหมด", confirmed = false and add
  "สินค้าหมด" to missing.

QUANTITY:
- qty comes only from an explicit quantity the customer stated.
- Never take a number from a size name. "2XL Grey" is size 2XL,
  not quantity 2.
- If no quantity was stated, add "จำนวน" to missing and
  confirmed = false.

=== FORMAT ===
{"intent":"question","tier":1,"tierReason":"","confirmed":false,"items":[],"subtotal":0,"shipping":${SHIPPING_THB},"total":0,"missing":[]}`;

export async function analyze(
  senderId: string,
  latestText: string
): Promise<Analysis | null> {
  const history = getHistory(senderId);
  const catalogText = await getFormattedCatalog();

  const transcript = [
    ...history.map(t => `${t.role === 'user' ? 'Customer' : 'Shop'}: ${t.text}`),
    `Customer (latest message): ${latestText}`,
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
          { role: 'system', content: `${PROMPT}\n\nPRODUCTS:\n${catalogText}` },
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
    'question', 'confirm_order', 'payment',
    'human_request', 'complaint', 'uncovered', 'other',
  ];
  const intent: Intent = validIntents.includes(raw.intent)
    ? raw.intent
    : 'question';   // safest default — keeps the bot talking

  // Derive the tier from intent rather than trusting the model's own
  // tier field. Intent is a simpler judgement and less likely to drift.
  const tier: Tier =
    intent === 'payment' || intent === 'human_request' || intent === 'complaint'
      ? 3
      : intent === 'uncovered'
      ? 2
      : 1;

  // An item priced at 0 means no price was found. Writing that to the
  // sheet would create a free order.
  const priced = items.every(i => Number(i.price) > 0);

  return {
    intent,
    tier,
    tierReason: String(raw.tierReason ?? '').slice(0, 120),
    confirmed: Boolean(raw.confirmed) && priced && items.length > 0,
    items,
    subtotal,
    shipping: SHIPPING_THB,
    total: subtotal + SHIPPING_THB,
    missing: raw.missing ?? [],
  };
}