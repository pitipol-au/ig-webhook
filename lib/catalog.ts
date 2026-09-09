type Product = {
  id: string;
  caption: string;
  permalink: string;
};

let cache: Product[] = [];
let fetchedAt = 0;

export async function getCatalog(): Promise<Product[]> {
  // Re-fetch at most once every 5 minutes
  if (cache.length > 0 && Date.now() - fetchedAt < 5 * 60 * 1000) {
    return cache;
  }

  try {
    const token = process.env.IG_ACCESS_TOKEN;
    const res = await fetch(
      `https://graph.instagram.com/v23.0/me/media?fields=id,caption,permalink&limit=50&access_token=${token}`
    );
    const data = await res.json();

    if (!data.data) {
      console.error('Catalog fetch failed:', JSON.stringify(data));
      return cache;
    }

    cache = data.data.filter((p: Product) => p.caption);
    fetchedAt = Date.now();
    console.log(`Catalog loaded: ${cache.length} product(s)`);
    return cache;
  } catch (err) {
    console.error('Catalog error:', err);
    return cache;
  }
}

export function formatCatalog(products: Product[]): string {
  if (products.length === 0) return 'ยังไม่มีสินค้าในระบบ';

  return products
    .map((p, i) => `[สินค้าที่ ${i + 1}]\n${p.caption}\nลิงก์: ${p.permalink}`)
    .join('\n\n');
}