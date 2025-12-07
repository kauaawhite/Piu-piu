/**
 * PikaShort Bot V17 (improved) - Full file
 * Required env:
 * TELEGRAM_BOT_TOKEN, ADMIN_PASSWORD, ALLOWED_ADMIN_ID, DASHBOARD_SECRET
 *
 * Put dashboard files in src/dashboard/
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// ENV
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_ADMIN_ID = String(process.env.ALLOWED_ADMIN_ID || "");
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || "dash_secret_1122";
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN || !ADMIN_PASSWORD || !ALLOWED_ADMIN_ID) {
  console.error("Missing required env vars: TELEGRAM_BOT_TOKEN, ADMIN_PASSWORD, ALLOWED_ADMIN_ID");
  process.exit(1);
}

// Telegram bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// DB path & ensure folder
const SRC_DIR = path.join(__dirname, "src");
if (!fs.existsSync(SRC_DIR)) fs.mkdirSync(SRC_DIR, { recursive: true });
const DB_PATH = path.join(SRC_DIR, "database.json");

function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    const init = {
      tokens: {},
      lastActive: {},
      admins: [ALLOWED_ADMIN_ID],
      premium: [],
      adsMessage: "🔥 *PikaShort SPECIAL!*  \nEarn More With SmallshortURL!  \nVisit 👉 https://smallshorturl.myvippanel.shop",
      headerText: "not available now",
      footerText: "not available now",
      adStats: { totalDelivered: 0, totalFailed: 0, history: [] },
      shortCache: {},
      inactiveMessage: "👋 Hey! It’s been a while since you used me.\nNeed to shorten links? Just send me any URL 🔗\nI'm here to help 😎"
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}
function writeDB(obj) {
  fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2));
}

// helpers
function escapeMd(text = "") {
  return String(text).replace(/([_*[\]()`~>#+-=|{}.!\\])/g, "\\$1");
}
function mdCode(text = "") {
  return "`" + String(text).replace(/`/g, "") + "`";
}
function extractLinks(text = "") {
  if (!text) return [];
  const re = /(https?:\/\/[^\s]+)/gi;
  const m = text.match(re);
  return m || [];
}

// short-cache helpers
function getCachedShort(chatId, original) {
  const db = readDB();
  db.shortCache = db.shortCache || {};
  db.shortCache[chatId] = db.shortCache[chatId] || {};
  return db.shortCache[chatId][original] || null;
}
function putCachedShort(chatId, original, short) {
  const db = readDB();
  db.shortCache = db.shortCache || {};
  db.shortCache[chatId] = db.shortCache[chatId] || {};
  db.shortCache[chatId][original] = short;
  writeDB(db);
}

// save last active
function saveLastActive(chatId) {
  const db = readDB();
  db.lastActive = db.lastActive || {};
  db.lastActive[String(chatId)] = Date.now();
  writeDB(db);
}

// token store
function setUserToken(chatId, token) {
  const db = readDB();
  db.tokens = db.tokens || {};
  db.tokens[String(chatId)] = token;
  writeDB(db);
}
function getUserToken(chatId) {
  const db = readDB();
  return (db.tokens || {})[String(chatId)];
}

// admin functions
function isAdmin(chatId) {
  const db = readDB();
  return (db.admins && db.admins.includes(String(chatId))) || String(chatId) === ALLOWED_ADMIN_ID;
}
function addAdmin(chatId) {
  const db = readDB();
  db.admins = db.admins || [];
  if (!db.admins.includes(String(chatId))) {
    db.admins.push(String(chatId));
    writeDB(db);
  }
}

// API validation (live call)
async function validateApiLive(apiKey) {
  if (!apiKey) return false;
  try {
    const url = `https://smallshorturl.myvippanel.shop/api?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent('https://google.com')}`;
    const r = await axios.get(url, { timeout: 12000 });
    const d = r.data || {};
    return !!(d.shortenedUrl || d.short || d.url);
  } catch (e) {
    return false;
  }
}

// perform shorten
async function shortenViaApi(apiKey, original) {
  try {
    const url = `https://smallshorturl.myvippanel.shop/api?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(original)}`;
    const r = await axios.get(url, { timeout: 15000 });
    const d = r.data || {};
    return d.shortenedUrl || d.short || d.url || null;
  } catch (e) {
    return null;
  }
}

/* -------------------------
   /start handler - always replies
   ------------------------- */
bot.onText(/^\/start(@\S+)?(\s+.*)?$/i, (msg) => {
  try {
    const chatId = String(msg.chat.id);
    const username = (msg.from && (msg.from.username || msg.from.first_name)) ? (msg.from.username || msg.from.first_name) : "User";
    saveLastActive(chatId);

    const dashboardLink = "https://smallshorturl.myvippanel.shop/member/tools/api";
    const welcome = `👋 Hello *${escapeMd(username)}*!  

Send your *PikaShort API Key* from *[Dashboard](${dashboardLink})* (use /api YOUR_API_KEY)

Once your API key is set, just send any link — I will shorten it instantly 🔗🚀`;

    bot.sendMessage(chatId, welcome, { parse_mode: "Markdown" }).catch(console.error);
  } catch (e) {
    console.error("start error", e);
  }
});

/* -------------------------
   /api <key> - set API token for user (validate live)
   ------------------------- */
bot.onText(/\/api (.+)/i, async (msg, match) => {
  const chatId = String(msg.chat.id);
  saveLastActive(chatId);
  const key = match && match[1] ? match[1].trim() : null;
  if (!key) return bot.sendMessage(chatId, "❌ Please send your API key. Usage: /api YOUR_API_KEY");
  const ok = await validateApiLive(key);
  if (!ok) return bot.sendMessage(chatId, "❌ Invalid API. Please send your API key.");
  setUserToken(chatId, key);
  // reset short cache for that user
  const db = readDB(); db.shortCache = db.shortCache || {}; db.shortCache[chatId] = {}; writeDB(db);
  bot.sendMessage(chatId, "✅ Your API key has been saved successfully!");
});

/* -------------------------
   /admin <password> - only from ALLOWED_ADMIN_ID
   ------------------------- */
bot.onText(/\/admin (.+)/i, (msg, match) => {
  const chatId = String(msg.chat.id);
  if (chatId !== ALLOWED_ADMIN_ID) return; // silent for others
  const pass = match && match[1] ? String(match[1]).trim() : "";
  if (pass !== String(ADMIN_PASSWORD)) {
    bot.sendMessage(chatId, "❌ Incorrect password.");
    return;
  }
  addAdmin(chatId);
  bot.sendMessage(chatId, "✅ You are now an Admin!");
});

/* -------------------------
   Rate limiting (simple) - per-user sliding window
   ------------------------- */
const rateMap = {}; // chatId -> [timestamps]
function rateAllow(chatId) {
  const now = Date.now();
  rateMap[chatId] = rateMap[chatId] || [];
  // remove old
  rateMap[chatId] = rateMap[chatId].filter(t => now - t < 10000); // 10s window
  if (rateMap[chatId].length >= 6) return false; // >5 msgs in 10s blocked
  rateMap[chatId].push(now);
  return true;
}

/* -------------------------
   Message listener - single consolidated reply, caching, spacing & emoji fixes
   ------------------------- */
bot.on('message', async (msg) => {
  try {
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const raw = msg.text || msg.caption || "";
    if (!raw) return;

    // ignore handled commands (they are processed separately)
    if (/^\/(start|api|admin|status|adsstats|sendads|sendimgads|sendvideoads|setads|sethf|sendad)/i.test(raw.trim())) {
      // still update lastActive
      if (!/^\/(sendimgads|sendvideoads)/i.test(raw.trim())) saveLastActive(chatId);
      return;
    }

    // rate limit
    if (!rateAllow(chatId)) {
      return bot.sendMessage(chatId, "⚠️ You are sending messages too fast. Please slow down.");
    }

    saveLastActive(chatId);

    // extract links
    const links = extractLinks(raw);
    if (!links || links.length === 0) return;

    // premium lock (if applicable)
    const db0 = readDB();
    if (db0.premium && db0.premium.length > 0 && !db0.premium.includes(String(chatId))) {
      return bot.sendMessage(chatId, "❌ You are not allowed to use this feature.");
    }

    // ensure user token
    const apiKey = getUserToken(chatId);
    if (!apiKey) {
      return bot.sendMessage(chatId, '❌ Please set your *PikaShort API Key* first.\nUse: /api YOUR_API_KEY', { parse_mode: 'Markdown' });
    }
    const valid = await validateApiLive(apiKey);
    if (!valid) return bot.sendMessage(chatId, "❌ Invalid API. Please send your API key.");

    // prepare results - use cache if present
    const pairs = [];
    for (const l of links) {
      const cached = getCachedShort(chatId, l);
      if (cached) {
        pairs.push({ original: l, short: cached });
        continue;
      }
      const shortened = await shortenViaApi(apiKey, l);
      if (shortened) {
        pairs.push({ original: l, short: shortened });
        putCachedShort(chatId, l, shortened);
      }
    }

    if (!pairs.length) {
      return bot.sendMessage(chatId, "⚠️ Could not shorten links. Please check your API key or try again later.");
    }

    // format single message with spacing + emojis preserved
    let message = "✨✨ Congratulations! Your URL has been successfully shortened! 🚀🔗\n\n";
    pairs.forEach((p, idx) => {
      message += `🔗 **Original URL:**\n${escapeMd(p.original)}\n\n`;
      message += `🌐 **Shortened URL:**\n${mdCode(p.short)}\n`;
      if (idx < pairs.length - 1) message += `\n`;
    });

    // header/footer
    const dbCurrent = readDB();
    if (dbCurrent.headerText) message = `${dbCurrent.headerText}\n\n${message}`;
    if (dbCurrent.footerText) message = `${message}\n\n${dbCurrent.footerText}`;

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error("message handler error:", e && e.message ? e.message : e);
  }
});

/* -------------------------
   Admin-only commands: /status, /adsstats
   ------------------------- */
bot.onText(/\/status/i, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isAdmin(chatId) && chatId !== ALLOWED_ADMIN_ID) return;
  const db = readDB();
  const usersCount = Object.keys(db.lastActive || {}).length;
  const adminsCount = (db.admins || []).length;
  const premiumCount = (db.premium || []).length;
  bot.sendMessage(chatId, `📊 Status\nUsers: ${usersCount}\nAdmins: ${adminsCount}\nPremium: ${premiumCount}`);
});

bot.onText(/\/adsstats/i, (msg) => {
  const chatId = String(msg.chat.id);
  if (!isAdmin(chatId) && chatId !== ALLOWED_ADMIN_ID) return;
  const db = readDB();
  const s = db.adStats || { totalDelivered: 0, totalFailed: 0, history: [] };
  let out = `📊 Ads Stats\nTotal Delivered: ${s.totalDelivered}\nTotal Failed: ${s.totalFailed}\nRecent:\n`;
  (s.history || []).slice(0, 10).forEach(h => out += `${h.id} | ${h.type} | delivered:${h.delivered} failed:${h.failed}\n`);
  bot.sendMessage(chatId, out);
});

/* -------------------------
   Inactive checker (every 12 hours)
   ------------------------- */
setInterval(() => {
  try {
    const db = readDB();
    const now = Date.now();
    const limit = 3 * 24 * 60 * 60 * 1000; // 3 days
    Object.keys(db.lastActive || {}).forEach(uid => {
      try {
        if (now - db.lastActive[uid] >= limit) {
          const msg = db.inactiveMessage || "👋 Hey! It’s been a while since you used me.\nNeed to shorten links? Just send me any URL 🔗\nI'm here to help 😎";
          bot.sendMessage(uid, msg).catch(() => {});
          // reset to avoid repeat spamming
          db.lastActive[uid] = now;
        }
      } catch (e) { /* ignore per-user errors */ }
    });
    writeDB(db);
  } catch (e) { console.error("inactive checker top error", e); }
}, 12 * 60 * 60 * 1000);

/* -------------------------
   EXPRESS DASHBOARD (login + main + endpoints)
   ------------------------- */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// session for dashboard
app.use(session({
  secret: DASHBOARD_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24*60*60*1000 } // 1 day
}));

// serve static dashboard assets (you must put index.html, style.css, script.js under src/dashboard)
app.use('/dashboard/static', express.static(path.join(__dirname, 'src', 'dashboard')));

// Login page (serves src/dashboard/login.html if exists)
app.get('/dashboard', (req, res) => {
  if (req.session && req.session.isAuth) return res.redirect('/dashboard/main');
  const loginPath = path.join(__dirname, 'src', 'dashboard', 'login.html');
  if (fs.existsSync(loginPath)) {
    return res.sendFile(loginPath);
  }
  const fallback = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport"content="width=device-width,initial-scale=1"/><title>Login</title></head><body style="background:#071029;color:#fff;font-family:Arial;padding:28px"><form method="POST" action="/dashboard/login" style="max-width:420px;margin:40px auto"><h2>PikaShort Admin Login</h2><input name="chatid" placeholder="Chat ID" style="width:100%;padding:10px;margin:8px 0"/><input name="password" placeholder="Password" type="password" style="width:100%;padding:10px;margin:8px 0"/><button style="padding:10px;background:#7c4dff;color:#fff;border:none;width:100%;">Login</button></form></body></html>`;
  res.send(fallback);
});

// handle login
app.post('/dashboard/login', (req, res) => {
  // Accept both JSON (fetch) and form POST
  const body = req.body || {};
  const chatid = String(body.chatid || req.body.chatid || "");
  const pass = String(body.password || req.body.password || "");
  if (chatid === ALLOWED_ADMIN_ID && pass === String(ADMIN_PASSWORD)) {
    req.session.isAuth = true;
    req.session.adminId = chatid;
    return res.json ? res.json({ success: true }) : res.redirect('/dashboard/main');
  }
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    return res.status(403).json({ success: false });
  }
  return res.status(403).send('Forbidden');
});

// protected dashboard main
app.get('/dashboard/main', (req, res) => {
  if (!req.session || !req.session.isAuth) return res.redirect('/dashboard');
  const indexPath = path.join(__dirname, 'src', 'dashboard', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(500).send('Dashboard not found (create src/dashboard/index.html)');
});

// middleware to ensure auth for AJAX
function ensureAuth(req, res, next) {
  if (req.session && req.session.isAuth) return next();
  return res.status(403).json({ ok: false, msg: 'unauth' });
}

// data endpoint
app.get('/dashboard/data', ensureAuth, (req, res) => {
  const db = readDB();
  const users = Object.keys(db.lastActive || {}).map(id => ({ id, lastActive: db.lastActive[id], hasApi: !!(db.tokens && db.tokens[id]) }));
  const now = Date.now();
  const limit = 3 * 24 * 60 * 60 * 1000;
  const inactive = users.filter(u => (now - (u.lastActive || 0)) >= limit).map(u => u.id);
  res.json({
    users,
    inactive,
    adsMessage: db.adsMessage,
    headerText: db.headerText,
    footerText: db.footerText,
    adStats: db.adStats || { totalDelivered:0, totalFailed:0, history:[] },
    premium: db.premium || []
  });
});

// save ads message
app.post('/dashboard/setads', ensureAuth, (req, res) => {
  const text = req.body.adtext || "";
  const db = readDB(); db.adsMessage = text; writeDB(db);
  res.json({ ok: true });
});

// save header/footer
app.post('/dashboard/sethf', ensureAuth, (req, res) => {
  const header = req.body.header || ""; const footer = req.body.footer || "";
  const db = readDB(); db.headerText = header; db.footerText = footer; writeDB(db);
  res.json({ ok: true });
});

// send ad now (batched)
app.post('/dashboard/sendad', ensureAuth, async (req, res) => {
  const text = req.body.adtext || "";
  if (!text) return res.json({ ok: false, msg: 'no text' });
  const users = Object.keys(readDB().lastActive || {});
  let delivered = 0, failed = 0;
  for (let i = 0; i < users.length; i += 25) {
    const batch = users.slice(i, i + 25);
    await Promise.all(batch.map(async uid => {
      try { await bot.sendMessage(uid, text, { parse_mode: 'Markdown' }); delivered++; } catch { failed++; }
    }));
    await new Promise(r => setTimeout(r, 1000));
  }
  const db = readDB();
  db.adStats = db.adStats || { totalDelivered:0, totalFailed:0, history:[] };
  db.adStats.totalDelivered += delivered;
  db.adStats.totalFailed += failed;
  db.adStats.history.unshift({ id: Date.now(), type: 'manual', delivered, failed, content: text });
  writeDB(db);
  res.json({ ok: true, delivered, failed });
});

// user search endpoint
app.get('/dashboard/users', ensureAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  const db = readDB();
  const users = Object.keys(db.lastActive || {}).map(id => ({ id, lastActive: db.lastActive[id], hasApi: !!(db.tokens && db.tokens[id]) }));
  if (!q) return res.json({ ok: true, users });
  const filtered = users.filter(u => u.id.includes(q));
  return res.json({ ok: true, users: filtered });
});

/* -------------------------
   start express
   ------------------------- */
app.listen(PORT, () => console.log(`PikaShort V17 dashboard running on port ${PORT}`));
console.log("PikaShort Bot V17 started");