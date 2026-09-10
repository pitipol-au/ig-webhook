// lib/ai.ts
//
// Conversation replies via Typhoon (SCB 10X), a Thai-specialised model.
// The API is OpenAI-compatible.

import { getFormattedCatalog } from './catalog';
import { getHistory, addTurn } from './memory';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';
const SHIPPING_THB = Number(process.env.SHIPPING_THB ?? 40);

const FALLBACK_TH = 'ขอโทษค่ะ ระบบขัดข้อง เดี๋ยวแอดมินมาตอบนะคะ';
const FALLBACK_EN = 'Sorry, something went wrong. Our admin will reply shortly.';

/**
 * Which language to reply in.
 *
 * Typhoon is Thai-specialised and defaults to Thai unless pushed.
 * A short English message like "Hi" carries little signal against a
 * system prompt written entirely in Thai, so we decide in code and
 * tell the model outright rather than hoping a prompt rule holds.
 *
 * No letters at all (emoji, digits) defaults to Thai — most
 * customers are Thai, so that's the better guess.
 */
function detectLang(text: string): 'th' | 'en' {
  const thai = (text.match(/[\u0e00-\u0e7f]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (thai > 0) return 'th';
  return latin > 0 ? 'en' : 'th';
}

function buildSystemPrompt(catalogText: string): string {
  return `คุณเป็นแอดมินร้านขายเสื้อผ้าออนไลน์บน Instagram

ข้อมูลร้าน:
- ค่าส่ง ${SHIPPING_THB} บาททั่วประเทศ ส่งภายใน 1-2 วันทำการ
- รับชำระผ่าน PromptPay เท่านั้น

สินค้าทั้งหมดในร้าน:
${catalogText}

กฎเรื่องข้อมูลสินค้า:
- ตอบราคาและรายละเอียดจากข้อมูลสินค้าด้านบนเท่านั้น
- ถ้ามี "ราคาที่ถูกต้อง" ให้ใช้ตัวเลขนั้น ไม่ใช่ราคาในแคปชั่น
- ห้ามแต่งราคาเองเด็ดขาด ถ้าสินค้าไม่มีราคา ให้บอกว่าจะเช็คให้
- ถ้าไม่มีสินค้าที่ลูกค้าถาม ให้บอกตรงๆ ว่าไม่มี
- ถ้าสินค้ามีสถานะ "สินค้าหมด" ห้ามรับออเดอร์เด็ดขาด
- ชื่อสินค้าให้ใช้ภาษาไทยตามข้อมูลเสมอ แม้ตอบเป็นภาษาอังกฤษ

กฎเรื่องบทสนทนา:
- ต้องเก็บข้อมูลให้ครบ 4 อย่างก่อนสรุป: (1) สินค้า (2) สี (3) ไซส์ (4) จำนวน
- ก่อนตอบทุกครั้ง ตรวจสอบจากประวัติว่าขาดข้อมูลอะไร
- ถามเฉพาะข้อที่ขาด ห้ามถามซ้ำข้อที่ลูกค้าบอกมาแล้ว
- สินค้า freesize ไม่ต้องถามไซส์
- สินค้าที่ไม่ได้ระบุสี ไม่ต้องถามสี
- ตอบสั้น 2-3 ประโยค ยกเว้นตอนสรุปคำสั่งซื้อ
- ห้ามระบุเวลาที่แน่นอน เช่น "ไม่กี่วินาที" "5 นาที"
  ให้บอกกว้างๆ ว่าแอดมินจะติดต่อกลับ

กฎการสรุปคำสั่งซื้อ (ทำตามรูปแบบนี้เท่านั้น):

  สรุปคำสั่งซื้อค่ะ
  • [สินค้า] [สี] ไซส์ [ไซส์] x[จำนวน] = [ราคา] x [จำนวน] = [ผลคูณ] บาท
  ค่าส่ง ${SHIPPING_THB} บาท
  ยอดรวมทั้งหมด [ผลคูณทุกรายการ + ${SHIPPING_THB}] บาท

  ยืนยันตามนี้ไหมคะ

- "ยอดรวมทั้งหมด" คือตัวเลขสุดท้ายที่รวมค่าส่งแล้ว ห้ามบวกค่าส่งซ้ำ
- ต้องแสดงการคูณให้เห็นชัด เช่น 590 x 2 = 1180
- ห้ามสรุปยอดถ้าข้อมูลยังไม่ครบ 4 อย่าง
- ถ้าตอบเป็นภาษาอังกฤษ ให้แปลรูปแบบนี้เป็นอังกฤษ คงตัวเลขและโครงสร้างเดิม

กฎหลังลูกค้ายืนยัน:
- ตอบสั้นๆ สื่อว่า (1) รับออเดอร์แล้ว (2) ขั้นตอนถัดไปคือชำระเงิน แอดมินจะส่งช่องทางให้
- ใช้คำพูดเป็นธรรมชาติ ไม่ต้องเหมือนกันทุกครั้ง
- ห้ามพูดว่าจะจัดส่ง เตรียมส่ง หรือขอบคุณที่อุดหนุน ก่อนลูกค้าชำระเงิน

กฎเรื่องการเงิน (สำคัญที่สุด):
- ห้ามให้เลขบัญชี เลขพร้อมเพย์ หรือ QR code เด็ดขาด
- ห้ามยืนยันว่าได้รับเงินแล้ว
- ถ้าลูกค้าพูดเรื่องการโอนเงิน ให้บอกว่าแอดมินจะมาดูแลต่อ

ห้ามแสดงกระบวนการคิด ให้ตอบข้อความสุดท้ายอย่างเดียว`;
}

/** Backstop for artefacts the prompt doesn't reliably prevent. */
function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function getAIReply(senderId: string, text: string): Promise<string> {
  const lang = detectLang(text);

  try {
    const catalogText = await getFormattedCatalog();
    const history = getHistory(senderId);

    const messages = [
      { role: 'system', content: buildSystemPrompt(catalogText) },
      ...history.map(t => ({
        role: t.role === 'model' ? 'assistant' : 'user',
        content: t.text,
      })),
      { role: 'user', content: text },
      // Injected LAST, immediately before generation — a system message
      // here outweighs a rule buried in a long Thai prompt above.
      {
        role: 'system',
        content:
          lang === 'en'
            ? 'IMPORTANT: The customer wrote in English. Reply in ENGLISH only. ' +
              'Do not use Thai. Keep Thai product names as they are.'
            : 'สำคัญ: ลูกค้าพิมพ์ภาษาไทย ให้ตอบเป็นภาษาไทยเท่านั้น ใช้ "ค่ะ/นะคะ"',
      },
    ];

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.TYPHOON_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 600 }),
    });

    if (!res.ok) {
      throw new Error(`Typhoon ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = await res.json();
    const reply = clean(data.choices?.[0]?.message?.content ?? '');
    if (!reply) throw new Error('empty reply');

    addTurn(senderId, 'user', text);
    addTurn(senderId, 'model', reply);

    return reply;
  } catch (err) {
    console.error('AI error:', err);
    // Apologise in the customer's own language
    return lang === 'en' ? FALLBACK_EN : FALLBACK_TH;
  }
}