export function getReply(text: string): string {
  const t = text.toLowerCase();

  // Order matters — first match wins.
  // Specific rules go above general ones.

  if (t.includes('สวัสดี') || t.includes('hello') || t.includes('hi')) {
    return 'สวัสดีค่ะ 🙏 สนใจสินค้าชิ้นไหน พิมพ์ถามได้เลยนะคะ';
  }

  if (t.includes('ค่าส่ง') || t.includes('จัดส่ง') || t.includes('กี่วัน')) {
    return 'ค่าส่ง 40 บาททั่วประเทศค่ะ ส่งภายใน 1-2 วันทำการนะคะ 📦';
  }

  if (t.includes('โอน') || t.includes('จ่าย') || t.includes('พร้อมเพย์')) {
    return 'รับชำระผ่าน PromptPay ค่ะ แจ้งสินค้าที่ต้องการก่อนนะคะ 💳';
  }

  if (t.includes('ไซส์') || t.includes('ไซซ์') || t.includes('มีสี')) {
    return 'รบกวนแจ้งชื่อสินค้าและไซส์ที่ต้องการนะคะ เดี๋ยวเช็คให้ค่ะ';
  }

  if (t.includes('ราคา') || t.includes('เท่าไหร่') || t.includes('กี่บาท')) {
    return 'รบกวนส่งลิงก์โพสต์สินค้าที่สนใจมาได้เลยค่ะ เดี๋ยวแจ้งราคาให้นะคะ 😊';
  }

  return 'ได้รับข้อความแล้วค่ะ 🙏 เดี๋ยวแอดมินมาตอบนะคะ';
}