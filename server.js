const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const session = require('express-session');
const bcrypt = require('bcryptjs');

// ---------- Storage setup (file-based, no external DB) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'boards.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT,
    data TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent INTEGER NOT NULL
  );
`);

// One-time migration: earlier versions of this app used email/OTP-by-email.
// If an old database with an "email" column is found, rebuild the auth
// tables for the new phone-based flow. Boards are untouched; only accounts
// and pending OTPs are reset (fine pre-launch, before real users exist).
const usersCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!usersCols.includes('phone')) {
  console.warn('Migrating users/otp_codes tables to phone-based auth (old data cleared).');
  db.exec(`
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS otp_codes;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE otp_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent INTEGER NOT NULL
    );
  `);
}

const getBoardStmt = db.prepare('SELECT * FROM boards WHERE id = ?');
const insertBoardStmt = db.prepare(
  'INSERT INTO boards (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
);
const updateBoardStmt = db.prepare('UPDATE boards SET data = ?, updated_at = ? WHERE id = ?');
const renameBoardStmt = db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?');
const listBoardsStmt = db.prepare('SELECT id, name, created_at, updated_at FROM boards ORDER BY updated_at DESC LIMIT 100');

const getUserByPhoneStmt = db.prepare('SELECT * FROM users WHERE phone = ?');
const getUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const insertUserStmt = db.prepare(
  'INSERT INTO users (id, username, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
);
const upsertOtpStmt = db.prepare(`
  INSERT INTO otp_codes (phone, code, purpose, expires_at, attempts, last_sent)
  VALUES (?, ?, ?, ?, 0, ?)
  ON CONFLICT(phone) DO UPDATE SET code=excluded.code, purpose=excluded.purpose,
    expires_at=excluded.expires_at, attempts=0, last_sent=excluded.last_sent
`);
const getOtpStmt = db.prepare('SELECT * FROM otp_codes WHERE phone = ?');
const bumpOtpAttemptsStmt = db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?');
const deleteOtpStmt = db.prepare('DELETE FROM otp_codes WHERE phone = ?');

function loadBoard(id) {
  const row = getBoardStmt.get(id);
  if (!row) return null;
  let shapes = [];
  try { shapes = JSON.parse(row.data); } catch (e) { shapes = []; }
  return { id: row.id, name: row.name, shapes };
}
function createBoard(name) {
  const id = nanoid(8);
  const now = Date.now();
  insertBoardStmt.run(id, name || 'Untitled board', '[]', now, now);
  return { id, name: name || 'Untitled board', shapes: [] };
}

const pendingSaves = new Map();
function scheduleSave(boardId, shapesGetter) {
  if (pendingSaves.has(boardId)) return;
  const t = setTimeout(() => {
    pendingSaves.delete(boardId);
    updateBoardStmt.run(JSON.stringify(shapesGetter()), Date.now(), boardId);
  }, 600);
  pendingSaves.set(boardId, t);
}

// ---------- Mailer ----------
// ---------- SMS (OTP) ----------
// Sends OTP codes via text.lk's HTTP API (https://text.lk) - Sri Lankan
// numbers only. Set these in Render's dashboard under Environment (never
// commit real values to the repo):
//   TEXTLK_API_TOKEN = your text.lk API token (Settings -> API)
//   TEXTLK_SENDER_ID  = an approved sender ID, e.g. "TextLKDemo" for testing
const TEXTLK_API_TOKEN = process.env.TEXTLK_API_TOKEN || '';
const TEXTLK_SENDER_ID = process.env.TEXTLK_SENDER_ID || 'TextLKDemo';
if (!TEXTLK_API_TOKEN) {
  console.warn('TEXTLK_API_TOKEN not set - OTP codes will be logged to console instead of texted.');
}

// Accepts Sri Lankan mobile numbers in common forms - 0712345678,
// +94712345678, 94712345678, 0094712345678, or bare 712345678 - and
// normalizes to the "94712345678" format text.lk expects. Returns null if
// the number isn't a valid Sri Lankan mobile number.
function normalizeLkPhone(input) {
  let digits = String(input || '').replace(/[^\d]/g, '');
  if (digits.startsWith('0094')) digits = digits.slice(2);
  else if (digits.startsWith('94')) { /* already has country code */ }
  else if (digits.startsWith('0')) digits = '94' + digits.slice(1);
  else if (digits.length === 9) digits = '94' + digits;

  // 94 + 7[0-8] + 7 more digits = 11 digits total, e.g. 94712345678
  return /^947[0-8]\d{7}$/.test(digits) ? digits : null;
}

async function sendOtpSms(phone, code) {
  if (!TEXTLK_API_TOKEN) {
    console.log(`[DEV] OTP for ${phone}: ${code}`);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res, data;
  try {
    res = await fetch('https://app.text.lk/api/http/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        api_token: TEXTLK_API_TOKEN,
        recipient: phone,
        sender_id: TEXTLK_SENDER_ID,
        type: 'plain',
        message: `${code} is your Boards verification code. It expires in 10 minutes.`,
      }),
      signal: controller.signal,
    });
    data = await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || data.status !== 'success') {
    throw new Error(`text.lk API error ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
}

function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ---------- Express app ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25 * 1e6 });

app.use(express.json({ limit: '5mb' }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // share sessions with socket.io

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}
function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

// ---------- Auth API ----------
app.post('/api/auth/request-otp', async (req, res) => {
  const phone = normalizeLkPhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });

  const existing = getOtpStmt.get(phone);
  if (existing && Date.now() - existing.last_sent < 45 * 1000) {
    return res.status(429).json({ error: 'rate_limited', retryAfterMs: 45000 - (Date.now() - existing.last_sent) });
  }
  const code = genOtp();
  const expires = Date.now() + 10 * 60 * 1000;
  upsertOtpStmt.run(phone, code, 'signup', expires, Date.now());
  try {
    await sendOtpSms(phone, code);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to send OTP SMS', e);
    res.status(500).json({ error: 'sms_failed' });
  }
});

app.post('/api/auth/signup', (req, res) => {
  const { username, phone: rawPhone, password, otp } = req.body || {};
  const phone = normalizeLkPhone(rawPhone);
  if (!username || username.length < 3) return res.status(400).json({ error: 'invalid_username' });
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'weak_password' });
  if (!otp) return res.status(400).json({ error: 'otp_required' });

  const record = getOtpStmt.get(phone);
  if (!record) return res.status(400).json({ error: 'otp_not_requested' });
  if (record.attempts >= 6) return res.status(429).json({ error: 'too_many_attempts' });
  if (Date.now() > record.expires_at) return res.status(400).json({ error: 'otp_expired' });
  if (record.code !== String(otp).trim()) {
    bumpOtpAttemptsStmt.run(phone);
    return res.status(400).json({ error: 'otp_incorrect' });
  }

  if (getUserByPhoneStmt.get(phone)) return res.status(409).json({ error: 'phone_taken' });
  if (getUserByUsernameStmt.get(username)) return res.status(409).json({ error: 'username_taken' });

  const id = nanoid(12);
  const hash = bcrypt.hashSync(password, 10);
  insertUserStmt.run(id, username, phone, hash, Date.now());
  deleteOtpStmt.run(phone);

  req.session.user = { id, username, phone };
  res.json({ ok: true, user: { username, phone } });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'missing_fields' });
  const id = String(identifier).trim();
  // If it looks like a phone number (mostly digits/+/spaces), look up by
  // normalized phone; otherwise treat it as a username.
  const looksLikePhone = /^[\d+\s-]+$/.test(id);
  const user = looksLikePhone
    ? (normalizeLkPhone(id) ? getUserByPhoneStmt.get(normalizeLkPhone(id)) : null)
    : getUserByUsernameStmt.get(id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { id: user.id, username: user.username, phone: user.phone };
  res.json({ ok: true, user: { username: user.username, phone: user.phone } });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});

// ---------- Board API (auth required) ----------
app.post('/api/boards', requireAuth, (req, res) => {
  const board = createBoard(req.body && req.body.name);
  res.json({ id: board.id, name: board.name });
});
app.get('/api/boards', requireAuth, (req, res) => res.json(listBoardsStmt.all()));
app.get('/api/boards/:id', requireAuth, (req, res) => {
  const board = loadBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'not_found' });
  res.json(board);
});
app.delete('/api/boards/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const existing = getBoardStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  liveBoards.delete(id);
  const pending = pendingSaves.get(id);
  if (pending) { clearTimeout(pending); pendingSaves.delete(id); }
  // Kick anyone currently viewing/editing this board back to the home page.
  io.to(id).emit('board:deleted');
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, nanoid(12) + (path.extname(file.originalname) || '')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});
app.post('/api/upload/:boardId', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// ---------- Pages ----------
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/board/:id', requireAuthPage, (req, res) => {
  const filePath = path.join(__dirname, 'public', 'board.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Server error');
    // Inject the board id server-side so the client never has to parse it
    // out of the URL (avoids edge cases with trailing slashes / proxies).
    const injected = html.replace('__BOARD_ID__', req.params.id);
    res.send(injected);
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Static files + gated home page (must come after the specific routes above)
app.get('/', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Realtime collaboration ----------
const liveBoards = new Map();
function getLive(boardId) {
  if (!liveBoards.has(boardId)) {
    let board = loadBoard(boardId);
    if (!board) { board = createBoard('Untitled board'); board.id = boardId; }
    const map = new Map();
    for (const s of board.shapes) map.set(s.id, s);
    liveBoards.set(boardId, { shapes: map });
  }
  return liveBoards.get(boardId);
}
function currentShapesArray(boardId) {
  const live = liveBoards.get(boardId);
  return live ? Array.from(live.shapes.values()) : [];
}

const USER_COLORS = ['#F97362', '#F2B84B', '#5FC9A8', '#5B9BD5', '#B78BE0', '#F088B6', '#7FD1D1', '#E8A75D'];

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess || !sess.user) return next(new Error('unauthenticated'));
  next();
});

io.on('connection', (socket) => {
  let joinedBoard = null;
  const sessUser = socket.request.session.user;
  const me = {
    id: socket.id,
    name: sessUser.username,
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  };
  socket.data.user = me;

  socket.on('join', ({ boardId, viewOnly }) => {
    if (!boardId) return;
    joinedBoard = boardId;
    socket.data.viewOnly = !!viewOnly;
    me.viewOnly = !!viewOnly;
    const board = loadBoard(boardId) || (createBoard('Untitled board'), loadBoard(boardId));
    const live = getLive(boardId);
    socket.join(boardId);

    socket.emit('board:state', {
      boardId,
      name: board ? board.name : 'Untitled board',
      shapes: Array.from(live.shapes.values()),
      you: me,
    });
    socket.to(boardId).emit('user:join', me);

    const room = io.sockets.adapter.rooms.get(boardId) || new Set();
    const others = [];
    for (const sid of room) {
      if (sid === socket.id) continue;
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.user) others.push(s.data.user);
    }
    socket.emit('users:list', others);
  });

  socket.on('shape:add', (shape) => {
    if (!joinedBoard || !shape || !shape.id || socket.data.viewOnly) return;
    getLive(joinedBoard).shapes.set(shape.id, shape);
    socket.to(joinedBoard).emit('shape:add', shape);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shape:update', (partial) => {
    if (!joinedBoard || !partial || !partial.id || socket.data.viewOnly) return;
    const live = getLive(joinedBoard);
    const existing = live.shapes.get(partial.id);
    if (existing) Object.assign(existing, partial); else live.shapes.set(partial.id, partial);
    socket.to(joinedBoard).emit('shape:update', partial);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shape:delete', ({ id }) => {
    if (!joinedBoard || !id || socket.data.viewOnly) return;
    getLive(joinedBoard).shapes.delete(id);
    socket.to(joinedBoard).emit('shape:delete', { id });
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shapes:bulk', ({ add = [], update = [], del = [] }) => {
    if (!joinedBoard || socket.data.viewOnly) return;
    const live = getLive(joinedBoard);
    for (const s of add) live.shapes.set(s.id, s);
    for (const p of update) {
      const existing = live.shapes.get(p.id);
      if (existing) Object.assign(existing, p); else live.shapes.set(p.id, p);
    }
    for (const id of del) live.shapes.delete(id);
    socket.to(joinedBoard).emit('shapes:bulk', { add, update, del });
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('board:rename', (name) => {
    if (!joinedBoard || !name || socket.data.viewOnly) return;
    renameBoardStmt.run(name.slice(0, 100), Date.now(), joinedBoard);
    socket.to(joinedBoard).emit('board:rename', name.slice(0, 100));
  });
  socket.on('cursor', (pos) => {
    if (!joinedBoard) return;
    socket.to(joinedBoard).emit('cursor', { ...pos, id: socket.id, name: me.name, color: me.color });
  });
  socket.on('disconnect', () => {
    if (joinedBoard) socket.to(joinedBoard).emit('user:leave', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Board server listening on port ' + PORT));
