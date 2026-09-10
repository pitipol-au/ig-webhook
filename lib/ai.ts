// lib/ai.ts
//
// Conversation replies via Typhoon (SCB 10X), a Thai-specialised model.
// OpenAI-compatible API.

import { getFormattedCatalog } from './catalog';
import { getHistory, addTurn, getLang, setLang } from './memory';

const API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
const MODEL = process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct';
const SHIPPING_THB = Number(process.env.SHIPPING_THB ?? 40);

const FALLBACK_TH = 'ขอโทษค่ะ ระบบขัดข้อง เดี๋ยวแอดมินมาตอบนะคะ';
const FALLBACK_EN = 'Sorry, something went wrong. Our admin will reply shortly.';

/**
 * Which language this message is in. Used only to set the thread
 * language on first contact — after that memory decides, so a Thai
 * customer typing "ok" doesn't flip the reply to English mid-order.
 *
 * No letters at all (emoji, digits) defaults to Thai.
 */
export function detectLang(text: string): 'th' | 'en' {
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

กฎขอบเขตการสนทนา (สำคัญ):
- ตอบได้เฉพาะเรื่องร้าน: สินค้า ราคา สี ไซส์ สต็อก ค่าส่ง วิธีสั่งซื้อ
  และสถานะคำสั่งซื้อ
- ถ้าถามเรื่องอื่น (อาหาร ข่าว สุขภาพ การเมือง ดวง เขียนโค้ด แปลภาษา)
  ให้ปฏิเสธสุภาพสั้นๆ แล้วชวนกลับมาเรื่องสินค้า
- ห้ามอธิบายความรู้ทั่วไป เช่น "ผ้ายืดคืออะไร" แม้ลูกค้าจะถามตรงๆ
- ทักทายตอบได้ตามปกติ แต่ให้ชวนเข้าเรื่องสินค้า

กฎเรื่องข้อมูลสินค้า (สำคัญที่สุด):
- ข้อมูลสินค้ามีแค่ที่เขียนไว้ด้านบนเท่านั้น ไม่มีข้อมูลอื่นอีก
- ถ้ามี "ราคาที่ถูกต้อง" ให้ใช้ตัวเลขนั้น ไม่ใช่ราคาในแคปชั่น
- ห้ามแต่งราคาเอง ถ้าสินค้าไม่มีราคา ให้บอกว่าจะเช็คให้
- สีและไซส์ต้องคัดลอกจากข้อมูลแบบคำต่อคำ
  ห้ามรวมชื่อสีจากสินค้าคนละชิ้น ห้ามสร้างชื่อสีใหม่
- ถ้าลูกค้าขอสีหรือไซส์ที่ไม่มี ให้บอกตรงๆ ว่าไม่มี แล้วบอกที่มีจริง
  ห้ามรับออเดอร์เด็ดขาด
- ห้ามให้ข้อมูลที่ไม่ได้เขียนไว้ เช่น วิธีซัก วิธีดูแล ส่วนผสมของผ้า
  เปอร์เซ็นต์เส้นใย แหล่งผลิต ความหนา การยืดหด
- ถ้าไม่มีข้อมูล ให้ตอบว่า "ข้อมูลนี้ไม่ได้ระบุไว้ค่ะ เดี๋ยวแอดมินเช็คให้นะคะ"
  แล้วหยุด ห้ามเดา ห้ามอธิบายเพิ่ม
- ถ้าสินค้ามีสถานะ "สินค้าหมด" ห้ามรับออเดอร์เด็ดขาด
- ถ้าลูกค้าทักท้วงว่าข้อมูลผิด ให้กลับไปอ่านข้อมูลใหม่แล้วแก้ให้ถูก
  ห้ามยืนยันสิ่งที่ตัวเองพูดผิดไปแล้ว

กฎเรื่องบทสนทนา:
- ต้องเก็บข้อมูลให้ครบ 4 อย่างก่อนสรุป: (1) สินค้า (2) สี (3) ไซส์ (4) จำนวน
- ก่อนตอบทุกครั้ง ตรวจสอบจากประวัติว่าขาดข้อมูลอะไร
- ถามเฉพาะข้อที่ขาด ห้ามถามซ้ำข้อที่ลูกค้าบอกมาแล้ว
- สินค้า freesize ไม่ต้องถามไซส์ / สินค้าที่ไม่ระบุสี ไม่ต้องถามสี
- ระวัง: ชื่อไซส์อาจมีตัวเลขนำหน้า เช่น 2XL 3XL
  ตัวเลขนั้นเป็นส่วนหนึ่งของชื่อไซส์ ไม่ใช่จำนวน
- ถ้าลูกค้าไม่ได้บอกจำนวนชัดเจน ให้ถาม ห้ามเดาจำนวนเอง
- ตอบสั้น 2-3 ประโยค ยกเว้นตอนสรุปคำสั่งซื้อ
- ห้ามระบุเวลาที่แน่นอน เช่น "ไม่กี่วินาที" "5 นาที"

กฎการสรุปคำสั่งซื้อ — ภาษาไทย (ทำตามรูปแบบนี้เท่านั้น):

  สรุปคำสั่งซื้อค่ะ
  • [สินค้า] [สี] ไซส์ [ไซส์] x[จำนวน] = [ราคา] x [จำนวน] = [ผลคูณ] บาท
  ค่าส่ง ${SHIPPING_THB} บาท
  ยอดรวมทั้งหมด [ผลคูณทุกรายการ + ${SHIPPING_THB}] บาท

  ยืนยันตามนี้ไหมคะ

กฎการสรุปคำสั่งซื้อ — ภาษาอังกฤษ (ใช้รูปแบบนี้เมื่อคุยภาษาอังกฤษ):

  Order summary
  • [product] [color] size [size] x[qty] = [price] x [qty] = [subtotal] THB
  Shipping ${SHIPPING_THB} THB
  Total [subtotal + ${SHIPPING_THB}] THB

  Please confirm?

- "ยอดรวมทั้งหมด" / "Total" คือตัวเลขสุดท้ายที่รวมค่าส่งแล้ว
  ห้ามบวกค่าส่งซ้ำ
- ต้องแสดงการคูณให้เห็นชัด เช่น 590 x 2 = 1180
- ห้ามสรุปยอดถ้าข้อมูลยังไม่ครบ 4 อย่าง
- ห้ามผสมสองภาษาในข้อความเดียว
- ชื่อสินค้าใช้ภาษาไทยได้ แม้ข้อความอื่นเป็นภาษาอังกฤษ

กฎหลังลูกค้ายืนยัน:
- ตอบสั้นๆ สื่อว่า (1) รับออเดอร์แล้ว (2) ขั้นตอนถัดไปคือชำระเงิน
  แอดมินจะส่งช่องทางให้
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
  setLang(senderId, detectLang(text));
  const lang = getLang(senderId) ?? 'th';

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
      // Injected LAST, immediately before generation. A system message
      // here outweighs a rule buried in a long Thai prompt above —
      // Typhoon is Thai-specialised and defaults to Thai otherwise.
      {
        role: 'system',
        content:
          lang === 'en'
            ? 'IMPORTANT: This conversation is in English. Reply in ENGLISH only. ' +
              'Use the English order summary format. Do not write Thai sentences. ' +
              'Thai product names may stay as they are.'
            : 'สำคัญ: บทสนทนานี้เป็นภาษาไทย ให้ตอบเป็นภาษาไทยเท่านั้น ใช้ "ค่ะ/นะคะ"',
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
    return lang === 'en' ? FALLBACK_EN : FALLBACK_TH;
  }
}