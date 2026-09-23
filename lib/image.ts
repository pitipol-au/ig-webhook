// lib/image.ts
//
// Customers send images for two very different reasons:
//   1. A payment slip  -> hand to a human
//   2. A product photo -> "do you have something like this?"
//
// Treating every image as a slip kills the second conversation dead,
// so we classify first, then describe and match.
//
// ─────────────────────────────────────────────────────────────
// A PHOTO WITH NO WORDS IS STILL A QUESTION
//
// A customer who sends only a photo is asking "do you have this?".
// Two things used to stop that question being answered:
//
//   1. The classifier only called an image a "product" if it looked
//      like CLOTHING, so a bag, a jar of cream or a screenshot of
//      someone else's post came back as "other" and was never
//      described — even though the shop might sell something like it.
//      Now every image that is not a payment slip is described.
//
//   2. When nothing matched, the reply was "could you tell me which
//      item you are looking for?" — which asks the customer to do the
//      work they just did by sending the photo. Now the shop either
//      shows the closest things it really has, or says plainly that
//      it does not carry anything like it and flags the thread for
//      the owner.
//
// Whether something matched is decided in CODE, not by reading the
// model's tone: the reply must name a product that exists in the
// catalogue, or it does not count as a match.
// ─────────────────────────────────────────────────────────────

import { getFormattedCatalog, getProducts } from './catalog';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const CHAT_MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';

// typhoon-ocr-v1.5 is built for reading DOCUMENTS, not describing
// clothing. It classifies slips well; garment descriptions may be
// weak. Swap this for a general vision model if matching is poor.
const VISION_MODEL = process.env.TYPHOON_VISION_MODEL ?? 'typhoon-ocr-v1.5';

export type ImageKind = 'slip' | 'product' | 'other';

export type ImageAnalysis = {
  kind: ImageKind;
  /** Empty only for a slip, or if describing the image failed. */
  description: string;
};

/** What came back from matching a photo against the catalogue. */
export type SimilarResult = {
  /** True only if the reply names a product that really exists. */
  matched: boolean;
  reply: string;
};

const NO_MATCH_TH =
  'ตอนนี้ทางร้านไม่มีสินค้าที่คล้ายกับในรูปเลยค่ะ 🙏 ' +
  'เดี๋ยวแอดมินช่วยดูให้อีกทีนะคะ หรือถ้าสนใจแบบอื่น บอกได้เลยค่ะ';

const NO_MATCH_EN =
  'We don\'t have anything like the item in your photo at the moment 🙏 ' +
  'Our admin will take a look, and you\'re welcome to ask about anything else.';

/** Meta's CDN links are short-lived — always fetch immediately. */
async function toDataUrl(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`image fetch ${res.status} (link likely expired)`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 8 * 1024 * 1024) throw new Error('image too large');

  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function vision(dataUrl: string, instruction: string, maxTokens: number) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TYPHOON_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: instruction },
        ],
      }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Classify, and describe the item if it's a product photo.
 *
 * On failure this returns 'slip'. Wrongly routing a product photo to
 * a human costs a minute of their time; wrongly ignoring a real
 * payment slip loses a paid order. Fail toward the expensive miss.
 */
export async function analyzeImage(imageUrl: string): Promise<ImageAnalysis> {
  try {
    const dataUrl = await toDataUrl(imageUrl);

    const kindRaw = (await vision(
      dataUrl,
      'Classify this image. Reply with ONE word only.\n' +
      '"slip" = a bank transfer receipt or payment confirmation ' +
      '(shows an amount, a date, and account details)\n' +
      '"product" = ANY item a shop could sell — clothing, a bag, ' +
      'shoes, jewellery, cosmetics, food, homeware — or a screenshot ' +
      'of a shop listing or another shop\'s post\n' +
      '"other" = anything else',
      10
    )).toLowerCase();

    const kind: ImageKind = kindRaw.includes('slip')
      ? 'slip'
      : kindRaw.includes('product')
      ? 'product'
      : 'other';

    // A slip goes to a person and is never described. EVERYTHING
    // else is described, including "other" — a photo the classifier
    // was unsure about is still a customer asking a question, and
    // the catalogue match below is what decides whether the shop
    // has anything like it.
    if (kind === 'slip') return { kind, description: '' };

    const description = await vision(
      dataUrl,
      'Describe the main item in this photo for a shop assistant. Cover:\n' +
      '- what the item is (dress, t-shirt, bag, shoes, hat, scarf, ' +
      'jewellery, cosmetic, food, homeware...)\n' +
      '- main colour or colours\n' +
      '- material or finish if visible\n' +
      '- shape, cut or fit (tight, oversized, cropped, wide-leg, ' +
      'long, short...)\n' +
      '- any pattern, print, logo or visible detail\n' +
      'Two or three sentences. Describe only what you can actually ' +
      'see. If there is no product in the photo at all, reply with ' +
      'exactly: NO ITEM',
      250
    );

    if (/^\s*no item/i.test(description)) return { kind: 'other', description: '' };

    return { kind, description };
  } catch (err) {
    console.error('Image analysis failed:', err);
    return { kind: 'slip', description: '' };
  }
}

/**
 * Match a described photo against the catalog.
 *
 * The vision model describes; the chat model matches. Splitting them
 * means a weak description can't invent a product, because matching
 * happens against the real catalog text.
 */
export async function findSimilar(
  description: string,
  thai: boolean
): Promise<SimilarResult> {
  const [catalogText, products] = await Promise.all([
    getFormattedCatalog(),
    getProducts(),
  ]);

  const prompt = `You are the admin of an online shop on Instagram.

A customer sent a photo of an item they like. Here is what the photo shows:
"${description}"

PRODUCTS IN STOCK
${catalogText}

YOUR TASK
- Suggest products from the list above that are similar to the photo.
- Rank by similarity: garment type first, then colour, then style.
- Suggest at most 2. Include the price and the post link for each.
- Be honest about how close the match is. Say "คล้ายกัน" or "ใกล้เคียง"
  (or "similar to" in English) rather than claiming it is the same item.
- If nothing in the list is reasonably similar, reply with exactly
  this one word and nothing else: NONE
  Do NOT force a suggestion, and do not apologise at length — the
  shop's own wording is added afterwards.
- Never invent a product, a colour, or a price that is not listed above.
- Never claim to stock the exact item in the photo.
- Products marked "สินค้าหมด" must not be offered.

FORMATTING — this is an Instagram DM, which is PLAIN TEXT ONLY
- NEVER use markdown. No [text](url), no **bold**, no # headings,
  no tables. A customer sees the raw characters.
- Write links as a bare URL on its own line.
- NEVER write internal labels such as "[สินค้าที่ 5]" or "[Product 3]".
  Those are catalog markers, not product names.
- Keep the whole reply under 6 short lines.

${thai
  ? `LANGUAGE: Reply in THAI only, using ค่ะ/นะคะ. Prices in บาท.

  Use this shape for each suggestion:

    ชื่อสินค้า - ราคา XXX บาท
    (เหตุผลที่คล้าย)
    https://www.instagram.com/p/XXXX/`
  : `LANGUAGE: Reply in ENGLISH only. Prices in THB, not บาท.

  Translate each product name into English, then give the original
  Thai name in brackets. The customer needs the English to understand
  it and the Thai to match it against the post.

  Use this shape for each suggestion:

    English Product Name (ชื่อไทย) - XXX THB
    (why it is similar)
    https://www.instagram.com/p/XXXX/`}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TYPHOON_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: thai
            ? 'มีสินค้าคล้ายแบบนี้ไหมคะ'
            : 'Do you have anything similar to this?',
        },
      ],
      max_tokens: 400,
    }),
  });

  if (!res.ok) throw new Error(`match ${res.status}`);

  const data = await res.json();
  const reply = stripMarkdown(data.choices?.[0]?.message?.content ?? '').trim();

  /* Did it actually match something real?

     Not judged by the model's wording. A reply counts as a match only
     if it names a product that exists in this shop's catalogue. That
     way "we have something similar" about a product we do not stock
     never reaches a customer. */
  const named = products.some(p => mentions(reply, p.title ?? ''));
  const saidNone = /^\s*none\b/i.test(reply);

  if (!reply || saidNone || !named) {
    return { matched: false, reply: thai ? NO_MATCH_TH : NO_MATCH_EN };
  }

  return { matched: true, reply };
}

/** Is this product's name in the text? Compared without spaces or
 *  punctuation, because a model rewrites "เสื้อครอป แขนสั้น" as
 *  "เสื้อครอปแขนสั้น" and either spelling means the same product. */
function mentions(text: string, title: string): boolean {
  const flat = (v: string) => v.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const t = flat(title);
  if (t.length < 4) return false;
  return flat(text).includes(t.slice(0, 12));
}

/**
 * Instagram DMs are plain text. Markdown arrives as literal characters,
 * so a customer sees "[Link](https://...)" rather than a link.
 *
 * The prompt forbids markdown, but prompts are guidance, not
 * guarantees — this is the backstop.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // [Link](https://x) -> https://x   (keep the URL, drop the label)
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '$2')
    // Internal catalog markers: [สินค้าที่ 5], [Product 3]
    .replace(/\[\s*(สินค้าที่|Product|Item)\s*\d+\s*\]\s*/gi, '')
    // **bold** and *italic*
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    // Leading # headings
    .replace(/^#{1,6}\s+/gm, '')
    // Collapse the blank lines those removals leave behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}