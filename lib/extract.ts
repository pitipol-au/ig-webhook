import { getHistory } from './memory';
import { getCatalog, formatCatalog } from './catalog';

export type ExtractedOrder = {
  confirmed: boolean;          // did the customer actually agree?
  items: { title: string; color: string; size: string; qty: number; price: number }[];
  subtotal: number;
  shipping: number;
  total: number;
  missing: string[];           // fields still unknown
};

const EXTRACT_PROMPT = `คุณคือระบบดึงข้อมูลคำสั่งซื้อ ไม่ใช่แชทบอท

อ่านบทสนทนาแล้วสรุปคำสั่งซื้อเป็น JSON เท่านั้น ห้ามมีข้อความอื่น

กฎ:
- confirmed = true เฉพาะเมื่อลูกค้ายืนยันชัดเจน (เช่น "ยืนยัน" "ตกลง" "เอาตามนี้" "ครับ/ค่ะ" หลังบอทสรุปรายการ)
- ถ้าลูกค้ายังไม่ยืนยัน ให้ confirmed = false
- ใช้ราคาจากข้อมูลสินค้าเท่านั้น ห้ามคิดราคาเอง
- ถ้าข้อมูลไม่ครบ ใส่ชื่อฟิลด์ที่ขาดใน missing เช่น ["สี","ไซส์"]
- ค่าส่ง 40 บาท

รูปแบบ:
{"confirmed":false,"items":[{"title":"","color":"","size":"","qty":0,"price":0}],"subtotal":0,"shipping":40,"total":0,"missing":[]}`;

export async function extractOrder(senderId: string): Promise<ExtractedOrder | null> {
  const history = getHistory(senderId);
  if (history.length === 0) return null;

  const products = await getCatalog();
  const transcript = history
    .map(t => `${t.role === 'user' ? 'ลูกค้า' : 'ร้าน'}: ${t.text}`)
    .join('\n');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL ?? 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: `${EXTRACT_PROMPT}\n\nสินค้า:\n${formatCatalog(products)}` },
          { role: 'user', content: transcript },
        ],
        // Forces valid JSON — no parsing prose, no stray markdown fences
        response_format: { type: 'json_object' },
        max_tokens: 800,
        reasoning_effort: 'none',
      }),
    });

    if (!res.ok) throw new Error(`Groq ${res.status}`);

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    return JSON.parse(raw) as ExtractedOrder;
  } catch (err) {
    console.error('Extraction failed:', err);
    return null;
  }
}