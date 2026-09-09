// lib/ai.ts
//
// Provider-agnostic. Switch with AI_PROVIDER in .env.local:
//   AI_PROVIDER=typhoon  → Typhoon (Thai-specialised, SCB 10X)
//   AI_PROVIDER=groq     → Groq (Qwen / GPT-OSS)
//   AI_PROVIDER=gemini   → Google Gemini
//
// Only this file knows which provider is in use. Everything else
// calls getAIReply() and doesn't care.
//
// Typhoon and Groq are both OpenAI-compatible, so they share one
// code path and differ only in base URL, key, and model.

import { getCatalog, formatCatalog } from './catalog';
import { getHistory, addTurn } from './memory';

const SHIPPING_THB = 40;
const FALLBACK_TH = 'ขอโทษค่ะ ระบบขัดข้อง เดี๋ยวแอดมินมาตอบนะคะ';

const SHOP_INFO = `
คุณเป็นแอดมินร้านขายเสื้อผ้าออนไลน์บน Instagram

ข้อมูลร้าน:
- ค่าส่ง ${SHIPPING_THB} บาททั่วประเทศ ส่งภายใน 1-2 วันทำการ
- รับชำระผ่าน PromptPay เท่านั้น

กติกาในการตอบ:
- ตอบสั้น กระชับ เป็นกันเอง
- ตอบไม่เกิน 2-3 ประโยค (ยกเว้นตอนสรุปคำสั่งซื้อ)
`;

function buildSystemPrompt(catalogText: string): string {
  return `${SHOP_INFO}

สินค้าทั้งหมดในร้าน:
${catalogText}

กฎเรื่องภาษา:
- ตอบด้วยภาษาเดียวกับที่ลูกค้าใช้
- ลูกค้าพิมพ์ไทย → ตอบไทย ใช้ "ค่ะ/นะคะ"
- ลูกค้าพิมพ์อังกฤษ → ตอบอังกฤษ สุภาพ เป็นกันเอง
- ลูกค้าพิมพ์ปนกัน → ตอบภาษาที่เป็นส่วนใหญ่
- ถ้าลูกค้าเปลี่ยนภาษากลางบทสนทนา ให้เปลี่ยนตาม
- ห้ามมีอักษรจีน ญี่ปุ่น เกาหลี ปะปน

กฎเรื่องข้อมูลสินค้า:
- ตอบราคาและรายละเอียดจากข้อมูลสินค้าด้านบนเท่านั้น
- ห้ามแต่งราคาเองเด็ดขาด ถ้าสินค้าไม่มีราคาระบุไว้ ให้บอกว่าจะเช็คให้
- ถ้าไม่มีสินค้าที่ลูกค้าถาม ให้บอกตรงๆ ว่าไม่มี
- ถ้าสินค้ามีสถานะ "สินค้าหมด" ห้ามรับออเดอร์เด็ดขาด
- ชื่อสินค้าให้ใช้ภาษาไทยตามข้อมูลเสมอ แม้ตอบเป็นภาษาอังกฤษ

กฎเรื่องบทสนทนา:
- ต้องเก็บข้อมูลให้ครบ 4 อย่างก่อนสรุป: (1) ชื่อสินค้า (2) สี (3) ไซส์ (4) จำนวน
- ก่อนตอบทุกครั้ง ให้ตรวจสอบจากประวัติว่าขาดข้อมูลอะไร
- ถามเฉพาะข้อที่ขาด ห้ามถามซ้ำข้อที่ลูกค้าบอกมาแล้ว
- สินค้าที่เป็น freesize ไม่ต้องถามไซส์
- สินค้าที่ไม่ได้ระบุสี ไม่ต้องถามสี

กฎการสรุปคำสั่งซื้อ (ทำตามรูปแบบนี้เท่านั้น):

  สรุปคำสั่งซื้อค่ะ
  • [สินค้า] [สี] ไซส์ [ไซส์] x[จำนวน] = [ราคา] x [จำนวน] = [ผลคูณ] บาท
  ค่าส่ง ${SHIPPING_THB} บาท
  ยอดรวมทั้งหมด [ผลคูณทุกรายการ + ${SHIPPING_THB}] บาท

  ยืนยันตามนี้ไหมคะ

- "ยอดรวมทั้งหมด" คือตัวเลขสุดท้ายที่รวมค่าส่งแล้ว ห้ามบวกค่าส่งซ้ำ
- ต้องแสดงการคูณให้เห็นชัด เช่น 590 x 2 = 1180
- ห้ามสรุปยอดถ้าข้อมูลยังไม่ครบ 4 อย่าง
- ถ้าลูกค้าใช้ภาษาอังกฤษ ให้แปลรูปแบบนี้เป็นอังกฤษ แต่คงตัวเลขและโครงสร้างเดิม

กฎหลังลูกค้ายืนยัน:
- ตอบสั้นๆ สื่อว่า (1) รับออเดอร์แล้ว (2) ขั้นตอนถัดไปคือชำระเงิน แอดมินจะส่งช่องทางให้
- ใช้คำพูดเป็นธรรมชาติ ไม่ต้องเหมือนกันทุกครั้ง
- ห้ามพูดว่าจะจัดส่ง เตรียมส่ง หรือขอบคุณที่อุดหนุน ก่อนลูกค้าชำระเงิน

กฎเรื่องการเงิน (สำคัญมาก):
- ห้ามให้เลขบัญชี เลขพร้อมเพย์ หรือ QR code เด็ดขาด
- ห้ามยืนยันว่าได้รับเงินแล้ว
- ถ้าลูกค้าพูดเรื่องการโอนเงิน ให้บอกว่าแอดมินจะมาดูแลต่อ

ห้ามแสดงกระบวนการคิด ให้ตอบข้อความสุดท้ายอย่างเดียว`;
}

/**
 * Strip artefacts that leak through despite the prompt.
 * Prompts are guidance, not guarantees — this is the backstop.
 */
function clean(text: string): string {
  return text
    // Reasoning models sometimes emit their thinking
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // Qwen is Chinese-developed and occasionally bleeds CJK into Thai
    .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '')
    .trim();
}

type Turn = { role: 'user' | 'model'; text: string };

/* ─────────────────────────────────────────────────────────────
   OpenAI-compatible providers (Typhoon, Groq)
   ───────────────────────────────────────────────────────────── */
type OpenAICompatConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Qwen-style reasoning suppression. Not all providers accept it. */
  suppressReasoning?: boolean;
};

const PROVIDERS: Record<string, OpenAICompatConfig> = {
  typhoon: {
    baseUrl: 'https://api.opentyphoon.ai/v1',
    apiKey: process.env.TYPHOON_API_KEY,
    model: process.env.TYPHOON_MODEL ?? 'typhoon-v2.5-30b-a3b-instruct',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL ?? 'qwen/qwen3.8-27b',
    suppressReasoning: true,
  },
};

async function callOpenAICompat(
  cfg: OpenAICompatConfig,
  systemPrompt: string,
  history: Turn[],
  text: string
): Promise<string> {
  const messages = [
    { role: 'system', content: systemPrompt },
    // OpenAI-compatible APIs use "assistant" where Gemini uses "model"
    ...history.map(t => ({
      role: t.role === 'model' ? 'assistant' : 'user',
      content: t.text,
    })),
    { role: 'user', content: text },
  ];

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: 600,
  };
  if (cfg.suppressReasoning) body.reasoning_effort = 'none';

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`${cfg.model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  return clean(data.choices?.[0]?.message?.content ?? '');
}

/* ─────────────────────────────────────────────────────────────
   Gemini — different request shape, so its own path
   ───────────────────────────────────────────────────────────── */
async function callGemini(
  systemPrompt: string,
  history: Turn[],
  text: string
): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const contents = [
    ...history.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user' as const, parts: [{ text }] },
  ];

  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
    contents,
    config: { systemInstruction: systemPrompt },
  });

  return clean(res.text ?? '');
}

/* ─────────────────────────────────────────────────────────────
   Public entry point
   ───────────────────────────────────────────────────────────── */
export async function getAIReply(senderId: string, text: string): Promise<string> {
  const provider = process.env.AI_PROVIDER ?? 'typhoon';

  try {
    const products = await getCatalog();
    const history = getHistory(senderId);
    const systemPrompt = buildSystemPrompt(formatCatalog(products));

    let reply: string;
    if (provider === 'gemini') {
      reply = await callGemini(systemPrompt, history, text);
    } else {
      const cfg = PROVIDERS[provider];
      if (!cfg) throw new Error(`Unknown AI_PROVIDER: ${provider}`);
      if (!cfg.apiKey) throw new Error(`Missing API key for ${provider}`);
      reply = await callOpenAICompat(cfg, systemPrompt, history, text);
    }

    if (!reply) throw new Error('empty reply');

    addTurn(senderId, 'user', text);
    addTurn(senderId, 'model', reply);

    return reply;
  } catch (err) {
    console.error(`AI error (${provider}):`, err);
    // Match the customer's language even when apologising
    return /[\u0e00-\u0e7f]/.test(text)
      ? FALLBACK_TH
      : 'Sorry, something went wrong. Our admin will reply shortly.';
  }
}