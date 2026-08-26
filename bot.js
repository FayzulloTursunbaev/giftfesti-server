/* ============================================================
   GIFT FESTI — Telegram bot
   - /start        -> xush kelibsiz xabari + tugmalar
   - /admin90      -> admin panel (statistika, hammaga xabar yuborish)
   Tashqi kutubxonasiz, to'g'ridan-to'g'ri Telegram Bot API (long polling).
   Bu skript o'yin serveridan (server.js) mustaqil — ikkalasini ham
   bir vaqtda alohida ishga tushirish kerak (masalan pm2 bilan).
   ============================================================ */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // masalan: https://sizning-domen.com
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || '@GiftFesti';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error("XATOLIK: .env faylida BOT_TOKEN ko'rsatilmagan.");
  process.exit(1);
}
if (!WEBAPP_URL) {
  console.error("XATOLIK: .env faylida WEBAPP_URL ko'rsatilmagan (masalan https://sizning-domen.com).");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const channelUsername = MAIN_CHANNEL.replace(/^@/, '');

/* ============================================================
   Botga /start yozgan barcha chat ID'lar (broadcast uchun kerak)
   ============================================================ */
const CHATIDS_FILE = path.join(__dirname, 'chatids.json');
let chatIds = new Set();
function loadChatIds() {
  if (fs.existsSync(CHATIDS_FILE)) {
    try { chatIds = new Set(JSON.parse(fs.readFileSync(CHATIDS_FILE, 'utf8'))); }
    catch (e) { console.error('chatids.json o\'qishda xatolik:', e.message); }
  }
}
function saveChatIds() {
  fs.writeFileSync(CHATIDS_FILE, JSON.stringify(Array.from(chatIds)));
}
loadChatIds();

/* Admin'lar hozir "xabar yozyapti" holatini saqlab turamiz (chatId -> true) */
const awaitingBroadcast = new Set();

/* ============================================================
   Telegram API yordamchilari
   ============================================================ */
async function callApi(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`${method} xatolik:`, data.description);
  return data;
}
function sendMessage(chatId, text, extra = {}) {
  return callApi('sendMessage', { chat_id: chatId, text, ...extra });
}
function answerCallback(id, text) {
  return callApi('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

/* ============================================================
   /start
   ============================================================ */
const WELCOME_TEXT =
  "👋 *GiftFestiga xush kelibsiz\\!*\n\n" +
  "Bu yerda kunlik case ochib, turli sovrinlar qo'lga kiritishingiz mumkin\\. " +
  "Boshlash uchun quyidagi tugmani bosing 👇";

function sendWelcome(chatId) {
  return sendMessage(chatId, WELCOME_TEXT, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎁 Ilovani ochish', web_app: { url: WEBAPP_URL } }],
        [{ text: '📢 Rasmiy kanal', url: `https://t.me/${channelUsername}` }],
      ],
    },
  });
}

/* ============================================================
   /admin90 — admin panel
   ============================================================ */
function sendAdminPanel(chatId) {
  return sendMessage(chatId, '🛠 *Admin panel*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Statistika', callback_data: 'admin:stats' }],
        [{ text: '📢 Xabar yuborish', callback_data: 'admin:broadcast' }],
      ],
    },
  });
}

async function fetchStats() {
  const res = await fetch(`${SERVER_URL}/internal/stats`, {
    headers: { 'x-internal-key': INTERNAL_KEY },
  });
  if (!res.ok) throw new Error(`server javobi: ${res.status}`);
  return res.json();
}

async function handleStats(chatId) {
  try {
    const s = await fetchStats();
    const text =
      `📊 *Statistika*\n\n` +
      `👥 Foydalanuvchilar: *${s.totalUsers}*\n` +
      `💰 Umumiy balans: *${s.totalBalance} FC*\n` +
      `🛡 Adminlar: *${s.adminCount}*\n\n` +
      `📋 Vazifalar soni: *${s.tasksCount}*\n` +
      `🎟 Faol promokodlar: *${s.activePromos}*\n` +
      `🎁 Faol voucherlar: *${s.activeVouchers}*\n\n` +
      `🎡 Baraban — ${s.wheelRound}-raund (hozir ${s.wheelPlayersNow} kishi tikkan)\n` +
      `🏒 Xokkey — ${s.hockeyRound}-raund (hozir ${s.hockeyPlayersNow} kishi tikkan)\n\n` +
      `📩 Botga start bosganlar: *${chatIds.size}*`;
    await sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    await sendMessage(chatId, `⚠️ Statistikani olishda xatolik: ${e.message}\n\nServer ishlab turganini va INTERNAL_KEY server.js bilan bot.js da bir xil ekanini tekshiring.`);
  }
}

async function startBroadcastFlow(chatId) {
  awaitingBroadcast.add(chatId);
  await sendMessage(chatId,
    "📢 Hammaga yubormoqchi bo'lgan xabaringizni yozing.\n\nBekor qilish uchun /bekor yozing.");
}

async function broadcastToAll(fromChatId, text) {
  const ids = Array.from(chatIds);
  let ok = 0, fail = 0;
  await sendMessage(fromChatId, `⏳ ${ids.length} kishiga yuborilyapti...`);
  for (const id of ids) {
    try {
      const res = await sendMessage(id, text);
      if (res.ok) ok++; else fail++;
    } catch (e) { fail++; }
    // Telegram flood-limitiga tushmaslik uchun kichik pauza
    await new Promise(r => setTimeout(r, 40));
  }
  await sendMessage(fromChatId, `✅ Xabar yuborildi.\n\nMuvaffaqiyatli: ${ok}\nXatolik: ${fail}`);
}

/* ============================================================
   Yangilanishlarni qabul qilish
   ============================================================ */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start')) {
    chatIds.add(chatId);
    saveChatIds();
    console.log(`/start -> chat ${chatId} (${msg.from.first_name || ''})`);
    return sendWelcome(chatId);
  }

  if (text.startsWith('/admin90')) {
    if (!isAdmin(userId)) return; // admin bo'lmaganlarga hech narsa qaytarmaymiz
    return sendAdminPanel(chatId);
  }

  if (text.startsWith('/bekor')) {
    if (awaitingBroadcast.has(chatId)) {
      awaitingBroadcast.delete(chatId);
      return sendMessage(chatId, '❌ Bekor qilindi.');
    }
    return;
  }

  // Admin xabar yozish holatida bo'lsa — bu keyingi xabar broadcast matni
  if (isAdmin(userId) && awaitingBroadcast.has(chatId) && text) {
    awaitingBroadcast.delete(chatId);
    return broadcastToAll(chatId, text);
  }
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id;
  if (!isAdmin(userId)) {
    return answerCallback(cq.id, "Sizda ruxsat yo'q.");
  }
  await answerCallback(cq.id);
  if (cq.data === 'admin:stats') return handleStats(chatId);
  if (cq.data === 'admin:broadcast') return startBroadcastFlow(chatId);
}

async function handleUpdate(update) {
  if (update.message) return handleMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

/* ============================================================
   Long polling
   ============================================================ */
let offset = 0;
async function pollLoop() {
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) {
        console.error('getUpdates xatolik:', data.description);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch(e => console.error('Update ishlov berishda xatolik:', e.message));
      }
    } catch (e) {
      console.error('Ulanish xatosi:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

console.log("GIFT FESTI bot ishga tushdi (long polling). /start va /admin90 buyruqlarini kuting...");
if (!INTERNAL_KEY) {
  console.warn("OGOHLANTIRISH: INTERNAL_KEY bo'sh — /admin90 statistikasi ishlamaydi. .env ga to'ldiring (server.js dagi bilan bir xil bo'lishi kerak).");
}
if (!ADMIN_IDS.length) {
  console.warn("OGOHLANTIRISH: ADMIN_IDS bo'sh — hech kim /admin90 ni ishlata olmaydi.");
}
pollLoop();
