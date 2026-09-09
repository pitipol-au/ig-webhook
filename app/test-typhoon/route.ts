export async function GET() {
  const res = await fetch('https://api.opentyphoon.ai/v1/models', {
    headers: { authorization: `Bearer ${process.env.TYPHOON_API_KEY}` },
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}