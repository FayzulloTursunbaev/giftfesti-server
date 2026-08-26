/* ============================================================
   GIFT FESTI — Multiplayer backend (Express + Socket.io)
   Frontend (public/index.html) shu server bilan bitta portda serve qilinadi.
   ============================================================ */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const MAIN_CHANNEL = process.env.MAIN_CHANNEL || '@GiftFesti';
const VOUCHER_CHANNEL = process.env.VOUCHER_CHANNEL || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const DB_FILE = path.join(__dirname, 'db.json');

/* ============================================================
   MA'LUMOTLAR (in-memory, db.json ga davriy saqlanadi)
   ============================================================ */
const users = new Map(); // id -> {id,name,balance,isAdmin,completedTasks:Set,dailyDay,dailyStreak,dailyLastClaim}
let tasks = [];          // [{id,name,channel,reward,type}]
let promos = [];         // [{code,reward,limit,used,usedBy:Set,requiredChannel?,requiredChannelType?,isVoucher}]

const dailyRewards = [10, 10, 20, 30, 40, 50, 100];

function defaultWheelState() {
  return { state: 'waiting', timeLeft: 0, round: 1, players: [], total: 0, history: [] };
}
function defaultHockeyState() {
  return { state: 'betting', timeLeft: 15, round: 1, players: [], total: 0, history: [] };
}
let wheelState = defaultWheelState();
let hockeyState = defaultHockeyState();

function createUser(id, name) {
  return {
    id, name, balance: 100, isAdmin: false,
    completedTasks: new Set(),
    dailyDay: 1, dailyStreak: 0, dailyLastClaim: null,
  };
}

/* ---- saqlash / yuklash ---- */
function serializeState() {
  return {
    users: Array.from(users.values()).map(u => ({
      ...u, completedTasks: Array.from(u.completedTasks),
    })),
    tasks,
    promos: promos.map(p => ({ ...p, usedBy: Array.from(p.usedBy) })),
    wheelHistory: wheelState.history,
    hockeyHistory: hockeyState.history,
    wheelRound: wheelState.round,
    hockeyRound: hockeyState.round,
  };
}
function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(serializeState(), null, 2)); }
  catch (e) { console.error('DB saqlashda xatolik:', e.message); }
}
function loadDb() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    (data.users || []).forEach(u => {
      users.set(u.id, { ...u, completedTasks: new Set(u.completedTasks || []) });
    });
    tasks = data.tasks || [];
    promos = (data.promos || []).map(p => ({ ...p, usedBy: new Set(p.usedBy || []) }));
    wheelState.history = data.wheelHistory || [];
    hockeyState.history = data.hockeyHistory || [];
    wheelState.round = data.wheelRound || 1;
    hockeyState.round = data.hockeyRound || 1;
    console.log(`DB yuklandi: ${users.size} foydalanuvchi, ${tasks.length} vazifa, ${promos.length} promo/voucher`);
  } catch (e) { console.error('DB yuklashda xatolik:', e.message); }
}
loadDb();
setInterval(saveDb, 10000);
process.on('SIGINT', () => { saveDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); process.exit(0); });

/* ============================================================
   YORDAMCHI FUNKSIYALAR
   ============================================================ */
function initials(name) {
  return (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '??';
}
function pickWeighted(players) {
  const total = players.reduce((s, p) => s + p.amount, 0);
  let r = Math.random() * total;
  for (const p of players) {
    if (r < p.amount) return p;
    r -= p.amount;
  }
  return players[players.length - 1];
}
function pushHistory(historyArr, entry) {
  historyArr.unshift(entry);
  if (historyArr.length > 10) historyArr.length = 10;
}

/* ---- Telegram WebApp initData tekshiruvi ---- */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckArr = [];
    for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${k}=${v}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userJson = params.get('user');
    if (!userJson) return null;
    return { user: JSON.parse(userJson) };
  } catch (e) { return null; }
}
function parseInitDataUnsafe(initData) {
  // BOT_TOKEN yo'q bo'lganda (dev/test) — imzo tekshirilmaydi, faqat parse qilinadi
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    if (!userJson) return null;
    return { user: JSON.parse(userJson) };
  } catch (e) { return null; }
}

/* ---- Telegram kanalga obuna tekshiruvi (Bot API) ---- */
async function isSubscribed(telegramUserId, channel) {
  if (!BOT_TOKEN) return true; // dev rejimida har doim "obuna" deb hisoblanadi
  if (!/^\d+$/.test(String(telegramUserId))) return true; // devId (raqamli bo'lsa ham telegram user emas) — tekshirib bo'lmaydi, o'tkazib yuboramiz
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${telegramUserId}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    return ['creator', 'administrator', 'member'].includes(data.result.status);
  } catch (e) { return false; }
}

/* ---- Kunlik bonus holati ---- */
function getDailyState(user) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (!user.dailyLastClaim) {
    return { day: user.dailyDay, canClaim: true, nextClaimAt: null, streak: user.dailyStreak };
  }
  const elapsed = Date.now() - user.dailyLastClaim;
  if (elapsed >= DAY_MS) {
    return { day: user.dailyDay, canClaim: true, nextClaimAt: null, streak: user.dailyStreak };
  }
  return { day: user.dailyDay, canClaim: false, nextClaimAt: new Date(user.dailyLastClaim + DAY_MS).toISOString(), streak: user.dailyStreak };
}

/* ============================================================
   EXPRESS + SOCKET.IO SETUP
   ============================================================ */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ---- Bot uchun ichki statistika API (faqat INTERNAL_KEY bilan) ---- */
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
app.get('/internal/stats', (req, res) => {
  if (!INTERNAL_KEY || req.get('x-internal-key') !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const allUsers = Array.from(users.values());
  const totalBalance = allUsers.reduce((s, u) => s + u.balance, 0);
  res.json({
    totalUsers: allUsers.length,
    totalBalance,
    adminCount: allUsers.filter(u => u.isAdmin).length,
    tasksCount: tasks.length,
    activePromos: promos.filter(p => !p.isVoucher && p.used < p.limit).length,
    activeVouchers: promos.filter(p => p.isVoucher && p.used < p.limit).length,
    wheelRound: wheelState.round,
    hockeyRound: hockeyState.round,
    wheelPlayersNow: wheelState.players.length,
    hockeyPlayersNow: hockeyState.players.length,
  });
});

function balanceUpdate(userId) {
  const user = users.get(userId);
  if (!user) return;
  io.to('user:' + userId).emit('balance:update', { balance: user.balance });
}
function emitTasksList() {
  io.emit('tasks:list', tasks.map(t => ({ id: t.id, name: t.name, channel: t.channel, reward: t.reward, type: t.type })));
}
function serializePromo(p) {
  return { code: p.code, reward: p.reward, limit: p.limit, used: p.used, requiredChannel: p.requiredChannel, requiredChannelType: p.requiredChannelType };
}
function emitPromoList() {
  io.to('admins').emit('promo:list', promos.filter(p => !p.isVoucher).map(serializePromo));
}
function emitVoucherList() {
  io.to('admins').emit('voucher:list', promos.filter(p => p.isVoucher).map(serializePromo));
}

/* ============================================================
   BARABAN (WHEEL) — o'yin sikli
   ============================================================ */
const WHEEL_BET_SECONDS = 15;
const WHEEL_SPIN_MS = 8700;     // vizual aylanish davomiyligi (frontenddagi 3200+5500ms bilan mos)
const WHEEL_RESULT_MS = 3200;   // natija ekranda turadigan vaqt

function emitWheelState() { io.emit('wheel:state', wheelState); }

function finishWheelRound() {
  const winnerPlayer = pickWeighted(wheelState.players);
  const winnerIndex = wheelState.players.indexOf(winnerPlayer);
  const total = wheelState.total;

  const user = users.get(winnerPlayer.userId);
  if (user) { user.balance += total; balanceUpdate(user.id); }

  pushHistory(wheelState.history, { name: winnerPlayer.name, initials: winnerPlayer.initials, colorIdx: winnerIndex });
  io.emit('wheel:result', { winner: winnerPlayer.name, amount: total });

  setTimeout(() => {
    wheelState = { state: 'waiting', timeLeft: 0, round: wheelState.round + 1, players: [], total: 0, history: wheelState.history };
    emitWheelState();
  }, WHEEL_RESULT_MS);
}

setInterval(() => {
  if (wheelState.state === 'betting') {
    wheelState.timeLeft -= 1;
    if (wheelState.timeLeft <= 0) {
      wheelState.state = 'spinning';
      emitWheelState();
      setTimeout(finishWheelRound, WHEEL_SPIN_MS);
      return;
    }
    emitWheelState();
  }
}, 1000);

/* ============================================================
   XOKKEY (HOCKEY) — o'yin sikli
   ============================================================ */
const HOCKEY_BET_SECONDS = 15;
const HOCKEY_SLIDE_MS = 4200;
const HOCKEY_RESULT_MS = 2200;

function emitHockeyState() { io.emit('hockey:state', hockeyState); }

function finishHockeyRound() {
  if (hockeyState.players.length === 0) {
    hockeyState = { state: 'betting', timeLeft: HOCKEY_BET_SECONDS, round: hockeyState.round + 1, players: [], total: 0, history: hockeyState.history };
    emitHockeyState();
    return;
  }
  // mijozdagi getHockeyZones bilan bir xil tartib: amount bo'yicha kamayish tartibida saralangan
  const sorted = [...hockeyState.players].sort((a, b) => b.amount - a.amount);
  const winnerPlayer = pickWeighted(sorted);
  const winnerIdx = sorted.indexOf(winnerPlayer);
  const seed = Math.random();
  const total = hockeyState.total;

  hockeyState.state = 'sliding';
  io.emit('hockey:sliding', { winnerIdx, winnerName: winnerPlayer.name, seed });

  setTimeout(() => {
    const user = users.get(winnerPlayer.userId);
    if (user) { user.balance += total; balanceUpdate(user.id); }
    pushHistory(hockeyState.history, { name: winnerPlayer.name, initials: winnerPlayer.initials, colorIdx: winnerIdx });
    io.emit('hockey:result', { winner: winnerPlayer.name, amount: total });

    setTimeout(() => {
      hockeyState = { state: 'betting', timeLeft: HOCKEY_BET_SECONDS, round: hockeyState.round + 1, players: [], total: 0, history: hockeyState.history };
      emitHockeyState();
    }, HOCKEY_RESULT_MS);
  }, HOCKEY_SLIDE_MS);
}

setInterval(() => {
  if (hockeyState.state === 'betting') {
    hockeyState.timeLeft -= 1;
    if (hockeyState.timeLeft <= 0) {
      finishHockeyRound();
      return;
    }
    emitHockeyState();
  }
}, 1000);

/* ============================================================
   SOCKET ULANISHLARI
   ============================================================ */
io.on('connection', (socket) => {

  socket.on('auth', async (payload, cb) => {
    if (typeof cb !== 'function') return;
    try {
      let userId, name;
      if (payload && payload.initData) {
        const parsed = BOT_TOKEN
          ? validateInitData(payload.initData, BOT_TOKEN)
          : parseInitDataUnsafe(payload.initData);
        if (!parsed || !parsed.user) return cb({ error: 'invalid_auth' });
        userId = String(parsed.user.id);
        name = [parsed.user.first_name, parsed.user.last_name].filter(Boolean).join(' ') || parsed.user.username || "O'yinchi";
      } else if (payload && payload.devId) {
        userId = String(payload.devId);
        name = payload.devName || "O'yinchi";
      } else {
        return cb({ error: 'invalid_auth' });
      }

      let user = users.get(userId);
      if (!user) {
        user = createUser(userId, name);
        users.set(userId, user);
        console.log(`Yangi foydalanuvchi: ${userId} (${name})`);
      } else {
        user.name = name;
      }
      user.isAdmin = ADMIN_IDS.includes(userId);

      socket.data.userId = userId;
      socket.join('user:' + userId);
      if (user.isAdmin) socket.join('admins');

      cb({
        user: { id: userId, balance: user.balance, isAdmin: user.isAdmin },
        wheel: wheelState,
        hockey: hockeyState,
        tasks: tasks.map(t => ({ ...t, done: user.completedTasks.has(t.id) })),
        daily: getDailyState(user),
      });

      if (user.isAdmin) {
        socket.emit('promo:list', promos.filter(p => !p.isVoucher).map(serializePromo));
        socket.emit('voucher:list', promos.filter(p => p.isVoucher).map(serializePromo));
      }
    } catch (e) {
      console.error('auth xatolik:', e);
      cb({ error: 'server_error' });
    }
  });

  function getUser() {
    const id = socket.data.userId;
    return id ? users.get(id) : null;
  }

  /* ---- Kunlik bonus ---- */
  socket.on('daily:status', (cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    cb(getDailyState(user));
  });

  socket.on('daily:claim', async (cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    const state = getDailyState(user);
    if (!state.canClaim) return cb({ error: 'already_claimed' });

    const subscribed = await isSubscribed(user.id, MAIN_CHANNEL);
    if (!subscribed) return cb({ error: 'not_subscribed' });

    const claimedDay = user.dailyDay;
    const reward = dailyRewards[(claimedDay - 1) % dailyRewards.length];
    user.balance += reward;
    user.dailyStreak += 1;
    user.dailyDay = claimedDay >= dailyRewards.length ? 1 : claimedDay + 1;
    user.dailyLastClaim = Date.now();

    cb({ balance: user.balance, daily: getDailyState(user), reward, day: claimedDay });
  });

  /* ---- Baraban (Wheel) tikish ---- */
  socket.on('wheel:bet', (amount, cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    amount = Number(amount);
    if (!amount || amount <= 0) return cb({ error: 'invalid_amount' });
    if (wheelState.state === 'spinning') return cb({ error: 'round_closed' });
    if (amount > user.balance) return cb({ error: 'insufficient_balance' });

    user.balance -= amount;
    const existing = wheelState.players.find(p => p.userId === user.id);
    if (existing) { existing.amount += amount; }
    else { wheelState.players.push({ userId: user.id, name: user.name, initials: initials(user.name), amount }); }
    wheelState.total += amount;

    if (wheelState.state === 'waiting' && wheelState.players.length >= 2) {
      wheelState.state = 'betting';
      wheelState.timeLeft = WHEEL_BET_SECONDS;
    }
    emitWheelState();
    cb({ balance: user.balance });
  });

  /* ---- Xokkey tikish ---- */
  socket.on('hockey:bet', (amount, cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    amount = Number(amount);
    if (!amount || amount < 10) return cb({ error: 'invalid_amount' });
    if (hockeyState.state !== 'betting') return cb({ error: 'round_closed' });
    if (amount > user.balance) return cb({ error: 'insufficient_balance' });

    user.balance -= amount;
    const existing = hockeyState.players.find(p => p.userId === user.id);
    if (existing) { existing.amount += amount; }
    else { hockeyState.players.push({ userId: user.id, name: user.name, initials: initials(user.name), amount }); }
    hockeyState.total += amount;

    emitHockeyState();
    cb({ balance: user.balance });
  });

  /* ---- Vazifalar ---- */
  socket.on('task:complete', async (id, cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    const task = tasks.find(t => t.id === id);
    if (!task) return cb({ error: 'not_found' });
    if (user.completedTasks.has(id)) return cb({ balance: user.balance });

    if (task.type === 'channel' || task.type === 'chat') {
      const ok = await isSubscribed(user.id, task.channel);
      if (!ok) return cb({ error: 'not_subscribed' });
    }
    user.balance += task.reward;
    user.completedTasks.add(id);
    cb({ balance: user.balance });
  });

  /* ---- Promokod ishlatish (vaucherlar ham shu yerdan) ---- */
  socket.on('promo:redeem', async (code, cb) => {
    const user = getUser(); if (!user || typeof cb !== 'function') return;
    if (!code) return cb({ error: 'not_found' });
    const promo = promos.find(p => p.code === String(code).toUpperCase());
    if (!promo) return cb({ error: 'not_found' });
    if (promo.usedBy.has(user.id)) return cb({ error: 'already_used' });
    if (promo.used >= promo.limit) return cb({ error: 'limit_reached' });

    const mainOk = await isSubscribed(user.id, MAIN_CHANNEL);
    if (!mainOk) return cb({ error: 'not_subscribed_main' });

    if (promo.requiredChannel) {
      const extraOk = await isSubscribed(user.id, promo.requiredChannel);
      if (!extraOk) return cb({ error: 'not_subscribed_extra', channel: promo.requiredChannel });
    }

    user.balance += promo.reward;
    promo.used += 1;
    promo.usedBy.add(user.id);
    if (promo.isVoucher) emitVoucherList(); else emitPromoList();

    cb({ balance: user.balance, reward: promo.reward });
  });

  /* ============================================================
     ADMIN
     ============================================================ */
  function requireAdmin(cb) {
    const user = getUser();
    if (!user || !user.isAdmin) { if (typeof cb === 'function') cb({ error: 'forbidden' }); return null; }
    return user;
  }

  socket.on('admin:giveCoins', ({ targetId, amount }, cb) => {
    if (!requireAdmin(cb)) return;
    amount = Number(amount);
    const target = users.get(String(targetId));
    if (!target || !amount || amount <= 0) return cb({ error: 'invalid' });
    target.balance += amount;
    balanceUpdate(target.id);
    cb({ ok: true });
  });

  socket.on('admin:addTask', ({ name, channel, reward, type }, cb) => {
    if (!requireAdmin(cb)) return;
    if (!name || !channel || !reward) return cb({ error: 'invalid' });
    const task = { id: crypto.randomUUID(), name, channel, reward: Number(reward), type: type || 'channel' };
    tasks.push(task);
    emitTasksList();
    cb({ ok: true });
  });

  socket.on('admin:deleteTask', (id, cb) => {
    if (!requireAdmin(cb)) return;
    tasks = tasks.filter(t => t.id !== id);
    emitTasksList();
    cb({ ok: true });
  });

  socket.on('admin:createPromo', (payload, cb) => {
    if (!requireAdmin(cb)) return;
    const code = String(payload.code || '').toUpperCase().trim();
    if (!code || !payload.reward || !payload.limit) return cb({ error: 'invalid' });
    if (promos.find(p => p.code === code)) return cb({ error: 'exists' });
    promos.push({
      code, reward: Number(payload.reward), limit: Number(payload.limit), used: 0,
      usedBy: new Set(), requiredChannel: payload.requiredChannel || null,
      requiredChannelType: payload.requiredChannelType || null, isVoucher: false,
    });
    emitPromoList();
    cb({ ok: true });
  });

  socket.on('admin:deletePromo', (code) => {
    if (!requireAdmin()) return;
    promos = promos.filter(p => !(p.code === code && !p.isVoucher));
    emitPromoList();
  });

  socket.on('admin:createVoucher', async ({ reward, limit }, cb) => {
    if (!requireAdmin(cb)) return;
    if (!reward || !limit) return cb({ error: 'invalid' });
    const code = 'VCH-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    promos.push({
      code, reward: Number(reward), limit: Number(limit), used: 0,
      usedBy: new Set(), requiredChannel: null, requiredChannelType: null, isVoucher: true,
    });
    emitVoucherList();

    if (BOT_TOKEN && VOUCHER_CHANNEL) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: VOUCHER_CHANNEL,
            text: `🎁 Yangi voucher!\nKod: <code>${code}</code>\nMukofot: ${reward} FC\nLimit: ${limit} kishi`,
            parse_mode: 'HTML',
          }),
        });
      } catch (e) { console.error('Voucherni kanalga yuborishda xatolik:', e.message); }
    }
    cb({ ok: true, code });
  });

  socket.on('admin:deleteVoucher', (code) => {
    if (!requireAdmin()) return;
    promos = promos.filter(p => !(p.code === code && p.isVoucher));
    emitVoucherList();
  });

  socket.on('admin:resetWheel', () => {
    if (!requireAdmin()) return;
    wheelState = defaultWheelState();
    emitWheelState();
  });

  socket.on('admin:resetHockey', () => {
    if (!requireAdmin()) return;
    hockeyState = defaultHockeyState();
    emitHockeyState();
  });

  socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
  console.log(`GIFT FESTI server ${PORT}-portda ishga tushdi`);
  console.log(`Admin ID'lar: ${ADMIN_IDS.length ? ADMIN_IDS.join(', ') : '(hech biri belgilanmagan — .env dagi ADMIN_IDS ni to\'ldiring)'}`);
});
