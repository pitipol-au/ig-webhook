// lib/catalog.ts
//
// The product catalog is the shop's own Instagram posts, merged with
// overrides from the Products sheet.
//
// Instagram gives the description. The sheet gives what Instagram
// can't: stock status, a corrected price, and notes. Sheet wins.

import { readTableCached } from './sheets';

export type Product = {
  id: string;
  caption: string;
  permalink: string;
};

export type Override = {
  title: string;
  price: string;
  inStock: boolean;
  notes: string;
};

let cache: Product[] = [];
let fetchedAt = 0;
const TTL_MS = 5 * 60 * 1000;

/* ── Instagram posts ────────────────────────────────────────── */

export async function getCatalog(): Promise<Product[]> {
  if (cache.length > 0 && Date.now() - fetchedAt < TTL_MS) {
    return cache;
  }

  try {
    const token = process.env.IG_ACCESS_TOKEN;
    const res = await fetch(
      `https://graph.instagram.com/v23.0/me/media` +
      `?fields=id,caption,permalink&limit=50&access_token=${token}`
    );
    const data = await res.json();

    if (!data.data) {
      console.error('Catalog fetch failed:', JSON.stringify(data).slice(0, 300));
      return cache;
    }

    cache = data.data.filter((p: Product) => p.caption);
    fetchedAt = Date.now();
    console.log(`Catalog loaded: ${cache.length} product(s)`);
    return cache;
  } catch (err) {
    console.error('Catalog error:', err);
    return cache;   // stale beats empty
  }
}

/* ── Sheet overrides ────────────────────────────────────────── */

export async function getOverrides(): Promise<Map<string, Override>> {
  const map = new Map<string, Override>();

  try {
    const rows = await readTableCached('Products');
    for (const r of rows) {
      const id = String(r.ig_media_id ?? '').trim();
      if (!id) continue;

      map.set(id, {
        title: r.title ?? '',
        price: String(r.price ?? '').trim(),
        // Sheets checkboxes come back as the strings "TRUE"/"FALSE".
        // Default to in-stock so a blank cell doesn't hide a product.
        inStock: String(r.in_stock ?? '').toUpperCase() !== 'FALSE',
        notes: r.notes ?? '',
      });
    }
  } catch (err) {
    console.error('Override read failed, using captions only:', err);
  }

  return map;
}

/* ── Formatting for the model ───────────────────────────────── */

export function formatCatalog(
  products: Product[],
  overrides?: Map<string, Override>
): string {
  if (products.length === 0) return 'ยังไม่มีสินค้าในระบบ';

  return products
    .map((p, i) => {
      const o = overrides?.get(p.id);
      const parts = [`[สินค้าที่ ${i + 1}]`, p.caption];

      // Sheet price overrides whatever the caption says. Captions
      // carry promo strikethroughs and inconsistent formats; the
      // sheet is one authoritative number.
      if (o?.price) parts.push(`ราคาที่ถูกต้อง: ${o.price} บาท`);

      // Stated bluntly so a small model can't miss it.
      if (o && !o.inStock) {
        parts.push('⚠️ สถานะ: สินค้าหมด — ห้ามรับออเดอร์สินค้านี้เด็ดขาด');
      }

      if (o?.notes) parts.push(`หมายเหตุ: ${o.notes}`);
      parts.push(`ลิงก์: ${p.permalink}`);

      return parts.join('\n');
    })
    .join('\n\n');
}

/** Posts plus overrides, ready for the prompt. */
export async function getFormattedCatalog(): Promise<string> {
  const [products, overrides] = await Promise.all([
    getCatalog(),
    getOverrides(),
  ]);
  return formatCatalog(products, overrides);
}