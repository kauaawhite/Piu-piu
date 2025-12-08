/**
 * PikaShort V18 (God-level) - bot.js
 * Features:
 * - URL Shortening via smallshorturl API per-user API key
 * - /api <key> to save API key (live validate)
 * - /start welcome (always replies)
 * - Dashboard routes: login, main, API endpoints (data, save messages, send ads, upload media, send media, sendto, users, inactive)
 * - Dashboard media upload (multer) -> server -> upload once to Telegram to get file_id -> cached reuse
 * - Admin sendto: bot-command & dashboard
 * - Inactive notifier (every INACTIVE_DAYS)
 * - Broadcast queue (batch 25) with concurrency
 * - Rate limiting per-user
 * - DB (database.json) simple JSON file
 * - Backups rotate
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const mime = require('mime-types');

// ---------- CONFIG / ENVS ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '6358090699'); // main admin chat id
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'afiya1310');
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || 'pikashort_dashboard_secret';
const PORT = Number(process.env.PORT || 8080);
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS || 2);
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 50);

// basic checks
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set. Exiting.');
  process.exit(1);
}

// ---------- PATHS & FS ----------
const BASE_DIR = process.cwd();
const DB_PATH = path.join(BASE_DIR, 'database.json');
const UPLOADS_DIR = path.join(BASE_DIR, 'src', 'dashboard', 'uploads');
const BACKUP_DIR = path.join(BASE_DIR, 'backups');

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------- TELEGRAM BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------- DB helpers ----------
function defaultDB() {
  return {
    tokens: {},            // { chatId: apiKey }
    lastActive: {},        // { chatId: timestamp }
    admins: [ADMIN_ID],    // allowed admins
    premium: [],           // premium users (optional)
    adsMessage: '🔥 Special Offer! Shorten links & earn more 🚀',
    headerText: '',
    footerText: '',
    inactiveMessage: "👋 Hey! It’s been a while since you used me.\nNeed to shorten links? Just send me any URL 🔗\nI'm here to help 😎",
    adStats: { totalSent:0, totalDelivered:0, totalFailed:0, history:[] },
    shortCache: {},        // { chatId: { originalUrl: shortUrl } }
    lastUploads: [],       // uploaded files info
    uploadsCache: {}       // local filename -> telegram file_id
  };
}
function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const j = JSON.parse(raw);
    // ensure fields
    const d = Object.assign(defaultDB(), j);
    return d;
  } catch {
    const d = defaultDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2));
    return d;
  }
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- Utilities ----------
function escapeMdV2(text='') {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function isValidChatId(id) {
  return /^[0-9]{5,20}$/.test(String(id));
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------- Rate limiting ----------
const RATE_WINDOW_MS = 10000; // 10 seconds
const RATE_MAX = 6;
const rateMap = {}; // chatId -> timestamps array
function rateAllow(chatId) {
  const now = Date.now();
  rateMap[chatId] = (rateMap[chatId] || []).filter(t => now - t < RATE_WINDOW_MS);
  if (rateMap[chatId].length >= RATE_MAX) return false;
  rateMap[chatId].push(now);
  return true;
}

// ---------- Broadcast Queue ----------
class BroadcastQueue {
  constructor(concurrency=2, batchSize=25, delayMs=1100) {
    this.queue = [];
    this.running = 0;
    this.concurrency = concurrency;
    this.batchSize = batchSize;
    this.delayMs = delayMs;
  }
  push(job) {
    this.queue.push(job);
    this._process();
  }
  size(){ return this.queue.length + this.running; }
  async _process() {
    if (this.running >= this.concurrency) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running++;
    try {
      if (job.type === 'text') {
        await this._runText(job);
      } else if (job.type === 'media') {
        await this._runMedia(job);
      }
    } catch(e){ console.error('Broadcast job error', e); }
    this.running--;
    setImmediate(()=>this._process());
  }
  async _runText({text, users}) {
    let d=0,f=0;
    for (let i=0;i<users.length;i+=this.batchSize) {
      const batch = users.slice(i, i+this.batchSize);
      await Promise.all(batch.map(async uid=>{
        try { await bot.sendMessage(uid, text, { parse_mode:'Markdown' }); d++; } catch(e){ f++; }
      }));
      await sleep(this.delayMs);
    }
    const db = readDB();
    db.adStats.totalSent += users.length;
    db.adStats.totalDelivered += d;
    db.adStats.totalFailed += f;
    db.adStats.history.unshift({ id: Date.now(), type:'text', text, delivered:d, failed:f });
    if (db.adStats.history.length>200) db.adStats.history.pop();
    writeDB(db);
    return { delivered:d, failed:f };
  }
  async _runMedia({fileId, mediaType, caption, users}) {
    let d=0,f=0;
    for (let i=0;i<users.length;i+=this.batchSize) {
      const batch = users.slice(i, i+this.batchSize);
      await Promise.all(batch.map(async uid=>{
        try {
          if (mediaType==='image') await bot.sendPhoto(uid, fileId, { caption, parse_mode:'Markdown' });
          else if (mediaType==='video') await bot.sendVideo(uid, fileId, { caption, parse_mode:'Markdown' });
          else throw new Error('unsupported mediaType');
          d++;
        } catch(e){ f++; }
      }));
      await sleep(this.delayMs);
    }
    const db = readDB();
    db.adStats.totalSent += users.length;
    db.adStats.totalDelivered += d;
    db.adStats.totalFailed += f;
    db.adStats.history.unshift({ id: Date.now(), type:'media', mediaType, fileId, caption, delivered:d, failed:f });
    if (db.adStats.history.length>200) db.adStats.history.pop();
    writeDB(db);
    return { delivered:d, failed:f };
  }
}

const bqueue = new BroadcastQueue(2,25,1100);

// ---------- Shortener API helpers ----------
async function validateApiLive(apiKey) {
  if (!apiKey) return false;
  try {
    const testUrl = `https://smallshorturl.myvippanel.shop/api?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent('https://google.com')}`;
    const r = await axios.get(testUrl, { timeout: 10000 });
    const d = r.data || {};
    return !!(d.shortenedUrl || d.short || d.url || d.data);
  } catch(e){ return false; }
}
async function shortenViaApi(apiKey, url) {
  try {
    const r = await axios.get(`https://smallshorturl.myvippanel.shop/api?api=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(url)}`, { timeout: 15000 });
    const d = r.data || {};
    return d.shortenedUrl || d.short || d.url || (d.data && d.data.shortenedUrl) || null;
  } catch(e){ return null; }
}

// ---------- Multer for uploads ----------
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, UPLOADS_DIR),
  filename: (req,file,cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 } });

// ---------- Express app & Dashboard static ----------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/dashboard/static', express.static(path.join(BASE_DIR, 'src','dashboard')));
app.use('/dashboard/static/uploads', express.static(UPLOADS_DIR)); // previews

// session optional (we rely on token based auth header as well)
app.use(session({ secret: DASHBOARD_SECRET, resave:false, saveUninitialized:false, cookie:{ maxAge: 24*60*60*1000 }}));

// ---------- Auth middleware ----------
function requireAuth(req,res,next) {
  // allow via header token or session
  const token = req.headers['x-auth-token'] || req.body.token || req.query.token || (req.session && req.session.token);
  if (token === DASHBOARD_SECRET) return next();
  return res.status(403).json({ ok:false, error:'unauth' });
}

// ---------- /start bot handler (always reply) ----------
bot.onText(/^\/start(@\S+)?(\s+.*)?$/i, (msg) => {
  try {
    const db = readDB();
    const chatId = String(msg.chat.id);
    db.lastActive[chatId] = Date.now();
    writeDB(db);
    const username = (msg.from && (msg.from.first_name || msg.from.username)) ? (msg.from.first_name || msg.from.username) : 'User';
    const dashboardLink = 'https://smallshorturl.myvippanel.shop/member/tools/api';
    const text = `👋 Hello *${escapeMdV2(username)}*!\n\nSend your *Smallshorturl API Key* from *[Dashboard](${dashboardLink})* (use /api YOUR_API_KEY)\n\nOnce your API key is set, just send any link — I will shorten it instantly 🔗🚀`;
    bot.sendMessage(chatId, text, { parse_mode:'MarkdownV2' }).catch(()=>{});
  } catch(e){ console.error('start err', e); }
});

// ---------- /api <key> handler ----------
bot.onText(/\/api (.+)/i, async (msg, match) => {
  try {
    const chatId = String(msg.chat.id);
    const key = (match && match[1]) ? String(match[1]).trim() : '';
    if (!key) return bot.sendMessage(chatId, '❌ Please provide API key. Usage: /api YOUR_API_KEY');
    const db = readDB();
    db.lastActive[chatId] = Date.now();
    writeDB(db);
    if (key.length < 6) return bot.sendMessage(chatId, '❌ Invalid API key. Too short.');
    const ok = await validateApiLive(key);
    if (!ok) return bot.sendMessage(chatId, '❌ Invalid API. Please check the key on your smallshorturl dashboard.');
    db.tokens[chatId] = key;
    db.shortCache = db.shortCache || {};
    db.shortCache[chatId] = {};
    writeDB(db);
    return bot.sendMessage(chatId, '✅ API Saved Successfully!');
  } catch(e){ console.error('/api err', e); }
});

// ---------- Generic URL extraction ----------
function extractUrlsFromText(text='') {
  if (!text) return [];
  const re = /(https?:\/\/[^\s'"]+|www\.[^\s'"]+|[a-z0-9\-]+\.[a-z]{2,}(\/\S*)?)/gi;
  const matches = [...text.matchAll(re)].map(m => m[0]);
  return matches.map(u => u.startsWith('www.') ? 'http://' + u : u);
}

// ---------- Message handler for shortening (and capture admin pending sendto) ----------
const pendingSendTo = {}; // adminId -> { target, timeoutId }

bot.on('message', async (msg) => {
  try {
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const text = msg.text || msg.caption || '';
    if (!text && !msg.photo && !msg.video && !msg.document) return;

    // if admin has pending sendto and this message is from that admin and is not a command, forward it
    if (pendingSendTo[chatId]) {
      const payload = pendingSendTo[chatId];
      clearTimeout(payload.timeoutId);
      delete pendingSendTo[chatId];
      const target = payload.target;
      try {
        // forward content types
        if (msg.photo) {
          const fid = msg.photo[msg.photo.length-1].file_id;
          await bot.sendPhoto(target, fid, { caption: msg.caption || '', parse_mode:'Markdown' });
        } else if (msg.video) {
          await bot.sendVideo(target, msg.video.file_id, { caption: msg.caption || '', parse_mode:'Markdown' });
        } else if (msg.document) {
          await bot.sendDocument(target, msg.document.file_id, { caption: msg.caption || '', parse_mode:'Markdown' });
        } else if (msg.text) {
          await bot.sendMessage(target, msg.text, { parse_mode:'Markdown' });
        } else {
          await bot.sendMessage(chatId, '❌ Unsupported message type for forwarding.');
        }
        await bot.sendMessage(chatId, '✅ Message forwarded successfully.');
      } catch(e){
        console.error('forward error', e);
        await bot.sendMessage(chatId, '❌ Failed to forward message.');
      }
      return;
    }

    // ignore commands handled elsewhere
    if (String(text || '').trim().startsWith('/')) return;

    // SHORTENING flow: if message contains URL(s)
    const urls = extractUrlsFromText(text);
    if (!urls || urls.length === 0) return;

    // rate limit
    if (!rateAllow(chatId)) {
      await bot.sendMessage(chatId, '⚠️ You are sending messages too fast. Please slow down.');
      return;
    }

    const db = readDB();
    db.lastActive[chatId] = Date.now();
    writeDB(db);

    const apiKey = (db.tokens||{})[chatId];
    if (!apiKey) {
      await bot.sendMessage(chatId, '❌ Please set your Smallshorturl API Key first.\nUse: /api YOUR_API_KEY', { parse_mode:'Markdown' });
      return;
    }
    // optional quick validation (skip if heavy)
    const valid = await validateApiLive(apiKey);
    if (!valid) {
      await bot.sendMessage(chatId, '❌ Invalid API. Please set a valid API key.');
      return;
    }

    // ensure per-user cache
    db.shortCache = db.shortCache || {};
    db.shortCache[chatId] = db.shortCache[chatId] || {};

    const parts = [];
    for (const u of urls) {
      if (db.shortCache[chatId][u]) {
        parts.push(`✨✨ Congratulations! Your URL has been successfully shortened! 🚀🔗\n\n*Original URL:*\n${escapeMdV2(u)}\n\n🌐 *Shortened URL:*\n\`${escapeMdV2(db.shortCache[chatId][u])}\``);
        continue;
      }
      const short = await shortenViaApi(apiKey, u);
      if (!short) {
        parts.push(`⚠️ Could not shorten: ${escapeMdV2(u)}`);
      } else {
        db.shortCache[chatId][u] = short;
        writeDB(db);
        parts.push(`✨✨ Congratulations! Your URL has been successfully shortened! 🚀🔗\n\n*Original URL:*\n${escapeMdV2(u)}\n\n🌐 *Shortened URL:*\n\`${escapeMdV2(short)}\``);
      }
    }
    const finalMsg = parts.join('\n\n---\n\n');
    await bot.sendMessage(chatId, finalMsg, { parse_mode:'MarkdownV2' });
  } catch (e) {
    console.error('message handler err', e);
  }
});

// ---------- Bot command: /sendto <chatId> (admin-only interactive) ----------
bot.onText(/^\/sendto\s+([0-9]+)$/i, async (msg, match) => {
  try {
    const admin = String(msg.chat.id);
    if (!readDB().admins.includes(admin) && admin !== ADMIN_ID) return; // silent
    const target = String(match[1]);
    if (!isValidChatId(target)) {
      return bot.sendMessage(admin, '❌ Invalid chat id.');
    }
    if (pendingSendTo[admin]) clearTimeout(pendingSendTo[admin].timeoutId);
    bot.sendMessage(admin, `✅ Send the message (text/photo/video/document) you want to forward to *${escapeMdV2(target)}* now. I'll forward the next message you send (2 min timeout).`, { parse_mode:'MarkdownV2' });
    const to = setTimeout(()=>{ delete pendingSendTo[admin]; bot.sendMessage(admin, '⏳ sendto timed out.'); }, 2*60*1000);
    pendingSendTo[admin] = { target, timeoutId: to };
  } catch(e){ console.error('/sendto command err', e); }
});

// ---------- DASHBOARD / API endpoints ----------
/* Login */
app.post('/api/login', (req,res) => {
  const { chatId, password } = req.body || {};
  if (String(chatId) !== ADMIN_ID) return res.json({ success:false, error:'Invalid Chat ID' });
  if (String(password) !== ADMIN_PASSWORD) return res.json({ success:false, error:'Invalid Password' });
  // set session or return token
  req.session.token = DASHBOARD_SECRET;
  res.json({ success:true, token: DASHBOARD_SECRET });
});

/* Protected data */
app.get('/api/data', requireAuth, (req,res) => {
  const db = readDB();
  const now = Date.now();
  const inactive = [];
  for (const uid of Object.keys(db.lastActive || {})) {
    if (now - db.lastActive[uid] >= INACTIVE_DAYS * 24 * 60 * 60 * 1000) inactive.push(uid);
  }
  res.json({
    ok:true,
    tokens: db.tokens,
    lastActive: db.lastActive,
    admins: db.admins,
    adsMessage: db.adsMessage,
    headerText: db.headerText,
    footerText: db.footerText,
    adStats: db.adStats,
    inactive,
    lastUploads: db.lastUploads || []
  });
});

/* Save default messages */
app.post('/api/save', requireAuth, (req,res) => {
  const { adsMessage, headerText, footerText, inactiveMessage } = req.body || {};
  const db = readDB();
  if (typeof adsMessage === 'string') db.adsMessage = adsMessage;
  if (typeof headerText === 'string') db.headerText = headerText;
  if (typeof footerText === 'string') db.footerText = footerText;
  if (typeof inactiveMessage === 'string') db.inactiveMessage = inactiveMessage;
  writeDB(db);
  res.json({ ok:true });
});

/* Users list & search */
app.get('/api/users', requireAuth, (req,res) => {
  const q = (req.query.q||'').trim();
  const db = readDB();
  let users = Object.keys(db.lastActive || {});
  if (q) users = users.filter(u => u.includes(q));
  res.json({ ok:true, users });
});

/* Inactive list */
app.get('/api/inactive', requireAuth, (req,res) => {
  const db = readDB();
  const now = Date.now();
  const list = Object.keys(db.lastActive||{}).filter(uid => now - db.lastActive[uid] >= INACTIVE_DAYS*24*60*60*1000);
  res.json({ ok:true, inactive:list });
});

/* Send text ads (queue) */
app.post('/api/sendads', requireAuth, (req,res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.json({ ok:false, error:'no text' });
  const db = readDB();
  const users = Object.keys(db.lastActive||{});
  bqueue.push({ type:'text', text, users });
  res.json({ ok:true, queued:true });
});

/* Send to single (dashboard) */
app.post('/api/sendto', requireAuth, async (req,res) => {
  const { userId, text } = req.body || {};
  if (!isValidChatId(String(userId)) || !text) return res.json({ ok:false, error:'invalid' });
  try {
    await bot.sendMessage(String(userId), text, { parse_mode:'Markdown' });
    return res.json({ ok:true });
  } catch(e){ return res.json({ ok:false, error:'send_failed' }); }
});

/* Upload media (image/video) to server */
app.post('/api/upload', requireAuth, upload.single('media'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
    const db = readDB();
    const entry = {
      id: Date.now(),
      filename: req.file.filename,
      original: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: `/dashboard/static/uploads/${req.file.filename}`,
      telegramFileId: db.uploadsCache[req.file.filename] || null,
      uploadedAt: new Date().toISOString()
    };
    db.lastUploads = db.lastUploads || [];
    db.lastUploads.unshift(entry);
    if (db.lastUploads.length>100) db.lastUploads.pop();
    writeDB(db);
    return res.json({ ok:true, file: entry });
  } catch(e){ console.error('upload err', e); return res.status(500).json({ ok:false, error:'upload_failed' }); }
});

/* Send media: will upload local file to Telegram (once) to get file_id if needed, then queue */
app.post('/api/sendmedia', requireAuth, async (req,res) => {
  try {
    const { uploadId, fileName, fileId, caption='', mediaType, target } = req.body || {};
    const db = readDB();
    let telegramFileId = fileId || null;
    // if uploadId or fileName provided, locate entry
    let entry = null;
    if (!telegramFileId && (uploadId || fileName)) {
      entry = db.lastUploads.find(e => (uploadId && e.id==uploadId) || (fileName && e.filename===fileName));
      if (!entry) return res.json({ ok:false, error:'upload_not_found' });
      const localPath = path.join(UPLOADS_DIR, entry.filename);
      if (!fs.existsSync(localPath)) return res.json({ ok:false, error:'file_missing' });
      // upload to Telegram via admin chat to obtain file_id and then delete the test message
      try {
        let resp;
        if ((mediaType && mediaType==='video') || entry.mimetype.startsWith('video/')) {
          resp = await bot.sendVideo(ADMIN_ID, localPath, { caption: 'upload-temp' });
          telegramFileId = resp && resp.video && resp.video.file_id ? resp.video.file_id : null;
        } else {
          resp = await bot.sendPhoto(ADMIN_ID, localPath, { caption: 'upload-temp' });
          telegramFileId = resp && resp.photo && resp.photo[resp.photo.length-1] && resp.photo[resp.photo.length-1].file_id ? resp.photo[resp.photo.length-1].file_id : null;
        }
        // store file_id in db.uploadsCache and entry
        if (telegramFileId) {
          db.uploadsCache = db.uploadsCache || {};
          db.uploadsCache[entry.filename] = telegramFileId;
          entry.telegramFileId = telegramFileId;
          writeDB(db);
          // try delete the test message in admin chat (bot can delete messages it sent)
          try {
            if (resp && resp.message_id) {
              await bot.deleteMessage(ADMIN_ID, resp.message_id).catch(()=>{});
            }
          } catch(e){}
        }
      } catch(e){
        console.error('upload->telegram err', e);
        return res.json({ ok:false, error:'telegram_upload_failed' });
      }
    }
    if (!telegramFileId) return res.json({ ok:false, error:'no_file_id' });
    // targets
    let users = Object.keys(db.lastActive || {});
    if (target && isValidChatId(String(target))) users = [String(target)];
    // queue media broadcast
    bqueue.push({ type:'media', fileId: telegramFileId, mediaType: mediaType || (entry && entry.mimetype && entry.mimetype.startsWith('video/') ? 'video':'image'), caption, users });
    return res.json({ ok:true, queued:true });
  } catch(e){ console.error('sendmedia err', e); return res.status(500).json({ ok:false, error:'server_err' }); }
});

/* API: metrics */
app.get('/api/metrics', requireAuth, (req,res) => {
  const db = readDB();
  res.json({ ok:true, users: Object.keys(db.lastActive||{}).length, queueSize: bqueue.size(), adStats: db.adStats });
});

/* lastuploads */
app.get('/api/lastuploads', requireAuth, (req,res) => {
  const db = readDB();
  res.json({ ok:true, lastUploads: db.lastUploads || [] });
});

// ---------- Inactive notifier (run every 12 hours) - but send every INACTIVE_DAYS days as requested ----------
// We'll run every 12 hours and check INACTIVE_DAYS threshold (default 2)
setInterval(async () => {
  try {
    const db = readDB();
    const now = Date.now();
    const threshold = INACTIVE_DAYS * 24 * 60 * 60 * 1000;
    const toNotify = [];
    for (const uid of Object.keys(db.lastActive || {})) {
      if (!db.lastActive[uid]) continue;
      if (now - db.lastActive[uid] >= threshold) toNotify.push(uid);
    }
    for (const uid of toNotify) {
      try {
        await bot.sendMessage(uid, db.inactiveMessage);
        db.lastActive[uid] = Date.now();
      } catch(e){}
    }
    writeDB(db);
  } catch(e){ console.error('inactive notifier err', e); }
}, 12 * 60 * 60 * 1000); // every 12 hours

// ---------- Backup DB rotation (every 6 hours) ----------
setInterval(() => {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dest = path.join(BACKUP_DIR, `backup-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f=>f.startsWith('backup-')).sort();
    if (files.length > 200) {
      const remove = files.slice(0, files.length - 200);
      remove.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    }
  } catch(e){ console.error('db backup err', e); }
}, 6 * 60 * 60 * 1000);

// ---------- Graceful shutdown ----------
let shuttingDown = false;
async function graceful() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down gracefully...');
  const start = Date.now();
  while (bqueue.size()>0 && (Date.now()-start) < 30*1000) await sleep(500);
  try { const db = readDB(); fs.writeFileSync(DB_PATH, JSON.stringify(db, null,2)); } catch(e){}
  process.exit(0);
}
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);

// ---------- Express start & static routes ----------
app.get('/login', (req,res) => {
  res.sendFile(path.join(BASE_DIR, 'src','dashboard','login.html'));
});
app.get('/dashboard', (req,res) => {
  if (req.session && req.session.token === DASHBOARD_SECRET) return res.sendFile(path.join(BASE_DIR,'src','dashboard','index.html'));
  // if token header set, allow (SPA will send token)
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === DASHBOARD_SECRET) return res.sendFile(path.join(BASE_DIR,'src','dashboard','index.html'));
  res.redirect('/login');
});

// For SPA static files under /dashboard/static (already mounted above)

// Start server
app.listen(PORT, () => {
  console.log(`PikaShort V18 running on port ${PORT}`);
  console.log(`Admin ID: ${ADMIN_ID}`);
  console.log(`Inactive days: ${INACTIVE_DAYS}`);
  console.log('Features: Shortening, Dashboard, SendTo, Media Ads, Inactive notifier, Queue, Backups');
});
