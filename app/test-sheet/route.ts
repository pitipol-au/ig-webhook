import { checkConnection, readTable } from '../../lib/sheets';

export async function GET() {
  const conn = await checkConnection();
  if (!conn.ok) {
    return Response.json({ step: 'auth', ...conn }, { status: 500 });
  }

  try {
    const products = await readTable('Products');
    const orders = await readTable('Orders');

    return Response.json({
      ok: true,
      tabs: conn.tabs,
      productCount: products.length,
      orderCount: orders.length,
      headers: products[0] ? Object.keys(products[0]) : [],
      firstProduct: products[0] ?? null,
    });
  } catch (err: any) {
    return Response.json({ step: 'read', ok: false, error: err.message }, { status: 500 });
  }
}