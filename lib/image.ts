// lib/image.ts
//
// Not every image is a payment slip. A customer sending a product
// photo to ask "do you have this?" must not be told their slip is
// being verified.

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const VISION_MODEL = process.env.TYPHOON_VISION_MODEL ?? 'typhoon-ocr-v1.5';

export type ImageKind = 'slip' | 'product' | 'other';

export async function classifyImage(imageUrl: string): Promise<ImageKind> {
  try {
    // Meta's CDN links are short-lived — fetch immediately.
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!img.ok) throw new Error(`image fetch ${img.status}`);

    const buf = Buffer.from(await img.arrayBuffer());
    const mime = (img.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
    const b64 = buf.toString('base64');

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
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            {
              type: 'text',
              text:
                'Classify this image. Reply with ONE word only.\n' +
                '"slip" = a bank transfer receipt or payment confirmation ' +
                '(shows an amount, date, and account details)\n' +
                '"product" = clothing, a fashion item, or a shop post\n' +
                '"other" = anything else',
            },
          ],
        }],
        max_tokens: 10,
      }),
    });

    if (!res.ok) throw new Error(`vision ${res.status}`);

    const data = await res.json();
    const answer = (data.choices?.[0]?.message?.content ?? '').toLowerCase();

    if (answer.includes('slip')) return 'slip';
    if (answer.includes('product')) return 'product';
    return 'other';
  } catch (err) {
    console.error('Image classification failed:', err);
    // Safe default: treat it as a slip. Wrongly handing a product
    // photo to a human wastes a minute. Wrongly ignoring a real slip
    // loses a paid order.
    return 'slip';
  }
}