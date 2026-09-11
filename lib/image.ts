// lib/image.ts
//
// Customers send images for two very different reasons:
//   1. A payment slip  -> hand to a human
//   2. A product photo -> "do you have something like this?"
//
// Treating every image as a slip kills the second conversation dead,
// so we classify first, then describe and match.

import { getFormattedCatalog } from './catalog';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const CHAT_MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';

// typhoon-ocr-v1.5 is built for reading DOCUMENTS, not describing
// clothing. It classifies slips well; garment descriptions may be
// weak. Swap this for a general vision model if matching is poor.
const VISION_MODEL = process.env.TYPHOON_VISION_MODEL ?? 'typhoon-ocr-v1.5';

export type ImageKind = 'slip' | 'product' | 'other';

export type ImageAnalysis = {
  kind: ImageKind;
  description: string;   // empty unless kind === 'product'
};

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
      '"product" = clothing, a fashion item, or a shop listing\n' +
      '"other" = anything else',
      10
    )).toLowerCase();

    const kind: ImageKind = kindRaw.includes('slip')
      ? 'slip'
      : kindRaw.includes('product')
      ? 'product'
      : 'other';

    if (kind !== 'product') return { kind, description: '' };

    const description = await vision(
      dataUrl,
      'Describe this clothing item for a shop assistant. Cover:\n' +
      '- garment type (t-shirt, dress, trousers, bag, hat, scarf...)\n' +
      '- main colour or colours\n' +
      '- sleeve length and neckline if visible\n' +
      '- fit (tight, oversized, cropped, wide-leg...)\n' +
      '- any pattern, print, or visible detail\n' +
      'Two or three sentences. Describe only what you can actually see.',
      250
    );

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
): Promise<string> {
  const catalogText = await getFormattedCatalog();

  const prompt = `You are the admin of an online clothing shop on Instagram.

A customer sent a photo of an item they like. Here is what the photo shows:
"${description}"

PRODUCTS IN STOCK
${catalogText}

YOUR TASK
- Suggest products from the list above that are similar to the photo.
- Rank by similarity: garment type first, then colour, then style.
- Suggest at most 3. Include the price and the post link for each.
- Be honest about how close the match is. Say "คล้ายกัน" or "ใกล้เคียง"
  rather than claiming it is the same item.
- If nothing in the list is reasonably similar, say so plainly and
  offer to check with the seller. Do NOT force a suggestion.
- Never invent a product, a colour, or a price that is not listed above.
- Never claim to stock the exact item in the photo.
- Products marked "สินค้าหมด" must not be offered.
- Keep it to 3-4 short lines.
- ${thai
    ? 'Reply in THAI only, using ค่ะ/นะคะ.'
    : 'Reply in ENGLISH only. Thai product names may stay in Thai.'}`;

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
  return (data.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}