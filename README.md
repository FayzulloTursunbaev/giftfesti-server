# GIFT FESTI — Multiplayer Server

Bu server `public/index.html` dagi Baraban va Xokkey o'yinlarini **haqiqiy real-time multiplayer**ga aylantiradi: barcha ulangan foydalanuvchilar bitta umumiy o'yin holatini (bank, ishtirokchilar, taymer, g'olib) ko'radi.

## Nima qildi

- Node.js + Express + Socket.io backend
- Frontend (`public/index.html`) o'zgartirilmadi (u allaqachon socket.io mijozi sifatida yozilgan edi) — faqat `/socket.io/socket.io.js` skripti qo'shildi
- Baraban: kamida 2 kishi tikkanda 15 soniyalik taymer boshlanadi, vaqt tugagach og'irlik bo'yicha (tikkan summaga proporsional) tasodifiy g'olib tanlanadi, bank g'olibga o'tadi
- Xokkey: har 15 soniyada bitta raund, g'olib xuddi shunday og'irlikli tasodif bilan tanlanadi, barcha mijozlarda bir xil animatsiya uchun `seed` yuboriladi
- Balans, kunlik bonus, vazifalar, promokod/voucher, admin panel — hammasi serverda saqlanadi va sinxronlanadi
- Ma'lumotlar `db.json` fayliga har 10 soniyada avtomatik saqlanadi (server qayta ishga tushsa yo'qolmaydi)

## O'rnatish

```bash
npm install
cp .env.example .env
```

`.env` faylini oching va kamida quyidagilarni to'ldiring:

```
PORT=3000
ADMIN_IDS=748213905        # o'zingizning Telegram ID yoki dev ID'ingiz
```

Ishga tushirish:

```bash
npm start
```

Brauzerda oching: `http://localhost:3000`

Bir nechta oynada/telefonda oching — barchasi bitta o'yinni ko'radi.

## Admin bo'lish

1. Serverni `.env`da `ADMIN_IDS` bo'sh holda ishga tushiring
2. Saytni oching, konsolda (yoki server logida) "Yangi foydalanuvchi: XXXXXX" qatorini toping — bu sizning `devId`ingiz
3. `.env` dagi `ADMIN_IDS` ga shu ID'ni yozing, serverni qayta ishga tushiring
4. Sahifani yangilang — Profil bo'limida "Admin panel" tugmasi chiqadi

Telegram orqali ishlatilganda `ADMIN_IDS` ga haqiqiy Telegram user ID yoziladi.

## Telegram bilan ishlatish (production)

1. [@BotFather](https://t.me/BotFather) orqali bot yarating, botdan token oling
2. `.env` ga: `BOT_TOKEN=...`, `WEBAPP_URL=https://sizning-domen.com` (server internetga chiqarilgandan keyingi manzil)
3. Shundan keyin `server.js` `initData` imzosini tekshiradi va kanalga obuna bo'lishni (`getChatMember` orqali) haqiqiy tekshiradi
4. `MAIN_CHANNEL` — asosiy majburiy kanal (masalan `@GiftFesti`)
5. `VOUCHER_CHANNEL` — voucherlar avtomatik post qilinadigan kanal/chat ID (ixtiyoriy)

### `/start` xabari (bot.js)

`bot.js` — alohida, mustaqil skript. U foydalanuvchi botga `/start` yozganda quyidagini yuboradi:
- Xush kelibsiz matni
- **"🎁 Ilovani ochish"** tugmasi — WebApp'ni (`WEBAPP_URL`) ochadi
- **"📢 Rasmiy kanal"** tugmasi — `MAIN_CHANNEL`ga (`@GiftFesti`) olib boradi

Ishga tushirish (o'yin serveridan **alohida**, ikkinchi terminalda):

```bash
npm run bot
```

Ikkalasini birga doimiy ishlab turishi uchun `pm2` tavsiya qilinadi:

```bash
npm i -g pm2
pm2 start server.js --name giftfesti-server
pm2 start bot.js --name giftfesti-bot
pm2 save
```

BotFather'da botingizga quyidagilarni ham sozlang:
- `/setmenubutton` — "Ilovani ochish" tugmasini chat menyusiga ham qo'shish uchun, `WEBAPP_URL`ni bering
- Web App URL faqat **https** bo'lishi shart (Telegram http'ni qabul qilmaydi)

### Admin panel (`/admin90`)

Faqat `.env`dagi `ADMIN_IDS` ro'yxatidagi Telegram ID'lar botga `/admin90` yozganda panelni ko'radi (boshqa hech kimga hech narsa qaytarilmaydi). Panelda ikkita tugma:

- **📊 Statistika** — foydalanuvchilar soni, umumiy balans, faol promo/voucherlar, Baraban/Xokkey raundlari haqida ma'lumot. Bu ma'lumotni `bot.js` `server.js`dagi `/internal/stats` endpointidan `INTERNAL_KEY` orqali oladi — shuning uchun **`.env`da `INTERNAL_KEY` server.js va bot.js uchun bir xil bo'lishi shart**.
- **📢 Xabar yuborish** — bosilgach, admin keyingi yozadigan matnini botga yozgan **barcha** foydalanuvchilarga (kimki bir marta `/start` bosgan bo'lsa) yuboradi. Bekor qilish uchun `/bekor`.

Kimlar ro'yxati `chatids.json` faylida saqlanadi (har kim `/start` bosganda avtomatik qo'shiladi).

**Eslatma:** Telegram flood-limitiga tushmaslik uchun xabar yuborish har bir foydalanuvchi orasida ~40ms pauza bilan ketma-ket yuboriladi — juda katta auditoriyada (o'n minglab) bu bir necha daqiqa vaqt olishi mumkin.

**Muhim:** `BOT_TOKEN` bo'sh bo'lganda barcha obuna tekshiruvlari avtomatik "muvaffaqiyatli" deb hisoblanadi — bu faqat local test uchun, production'da albatta tokenni kiriting.

## Serverni internetga chiqarish (deploy)

Eng oson variantlar (hammasi bepul reja bilan boshlanadi):

- **Railway.app** — GitHub repo'ni ulaysiz, avtomatik deploy qiladi, `.env` o'zgaruvchilarini Dashboard'da kiritasiz
- **Render.com** — xuddi shunday, "Web Service" yarating, build: `npm install`, start: `npm start`
- **VPS (masalan Timeweb, Hetzner)** — `pm2` bilan ishga tushiring: `npm i -g pm2 && pm2 start server.js --name giftfesti`

Har qanday variantda ham WebSocket ulanishlariga ruxsat berilganini tekshiring (Railway/Render standart holatda qo'llab-quvvatlaydi).

## Fayl tuzilishi

```
server.js          — butun backend logikasi (bitta faylda)
public/index.html  — frontend (o'zgarishsiz, faqat socket.io skripti qo'shilgan)
db.json             — avtomatik yaratiladi, ma'lumotlar shu yerda saqlanadi
.env                — sozlamalar (o'zingiz yaratasiz, .env.example dan nusxa)
```

## Keyingi qadamlar (tavsiya)

- Wheel/Hockey natijalarini "provably fair" qilish uchun raund boshida hash e'lon qilib, keyin seedni ochish (hozir server ichida oddiy `Math.random()`)
- Real vaqtli reyting jadvali (hozir faqat joriy sessiya tarixidan hisoblanadi)
- Ma'lumotlar bazasini `db.json` o'rniga PostgreSQL/MongoDB'ga o'tkazish (yuqori yuklama uchun)
