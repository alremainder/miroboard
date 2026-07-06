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
const nodemailer = require('nodemailer');

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
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    email TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent INTEGER NOT NULL
  );
`);

const getBoardStmt = db.prepare('SELECT * FROM boards WHERE id = ?');
const insertBoardStmt = db.prepare(
  'INSERT INTO boards (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
);
const updateBoardStmt = db.prepare('UPDATE boards SET data = ?, updated_at = ? WHERE id = ?');
const renameBoardStmt = db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?');
const listBoardsStmt = db.prepare('SELECT id, name, created_at, updated_at FROM boards ORDER BY updated_at DESC LIMIT 100');

const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const insertUserStmt = db.prepare(
  'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
);
const upsertOtpStmt = db.prepare(`
  INSERT INTO otp_codes (email, code, purpose, expires_at, attempts, last_sent)
  VALUES (?, ?, ?, ?, 0, ?)
  ON CONFLICT(email) DO UPDATE SET code=excluded.code, purpose=excluded.purpose,
    expires_at=excluded.expires_at, attempts=0, last_sent=excluded.last_sent
`);
const getOtpStmt = db.prepare('SELECT * FROM otp_codes WHERE email = ?');
const bumpOtpAttemptsStmt = db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?');
const deleteOtpStmt = db.prepare('DELETE FROM otp_codes WHERE email = ?');

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
// Reads credentials from environment variables ONLY (set these in Render's
// dashboard under Environment, never commit them to the repo):
//   SMTP_USER = your gmail address
//   SMTP_PASS = a gmail "app password" (Google Account -> Security -> App passwords)
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Without these, a blocked/slow connection to Gmail can hang the request
    // indefinitely, which is what makes the "Sending…" button appear stuck.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
} else {
  console.warn('SMTP_USER / SMTP_PASS not set - OTP emails will be logged to console instead of sent.');
}

function otpEmailHtml(code) {
  return `
  <div style="background:#12141c;padding:40px 20px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="max-width:420px;margin:0 auto;background:#1b1e2a;border-radius:16px;padding:36px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:28px;">
        <span style="width:12px;height:12px;border-radius:3px;background:#c8ff4d;display:inline-block;transform:rotate(12deg);"></span>
        <span style="font-size:18px;font-weight:700;color:#f4f3ef;">Boards</span>
      </div>
      <h1 style="color:#f4f3ef;font-size:20px;margin:0 0 12px;">Your verification code</h1>
      <p style="color:rgba(244,243,239,0.65);font-size:14px;line-height:1.6;margin:0 0 24px;">
        Enter this code to verify your email and finish setting up your account.
        It expires in 10 minutes.
      </p>
      <div style="background:#262b3a;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
        <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:#c8ff4d;font-family:monospace;">${code}</span>
      </div>
      <p style="color:rgba(244,243,239,0.4);font-size:12px;line-height:1.6;margin:0;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  </div>`;
}

async function sendOtpEmail(email, code) {
  if (!transporter) {
    console.log(`[DEV] OTP for ${email}: ${code}`);
    return;
  }
  await transporter.sendMail({
    from: `"Boards" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `${code} is your Boards verification code`,
    html: otpEmailHtml(code),
  });
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
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const existing = getOtpStmt.get(email);
  if (existing && Date.now() - existing.last_sent < 45 * 1000) {
    return res.status(429).json({ error: 'rate_limited', retryAfterMs: 45000 - (Date.now() - existing.last_sent) });
  }
  const code = genOtp();
  const expires = Date.now() + 10 * 60 * 1000;
  upsertOtpStmt.run(email, code, 'signup', expires, Date.now());
  try {
    await sendOtpEmail(email, code);
    res.json({ ok: true });
  } catch (e) {
    console.error('Failed to send OTP email', e);
    res.status(500).json({ error: 'email_failed' });
  }
});

app.post('/api/auth/signup', (req, res) => {
  const { username, email: rawEmail, password, otp } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!username || username.length < 3) return res.status(400).json({ error: 'invalid_username' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'weak_password' });
  if (!otp) return res.status(400).json({ error: 'otp_required' });

  const record = getOtpStmt.get(email);
  if (!record) return res.status(400).json({ error: 'otp_not_requested' });
  if (record.attempts >= 6) return res.status(429).json({ error: 'too_many_attempts' });
  if (Date.now() > record.expires_at) return res.status(400).json({ error: 'otp_expired' });
  if (record.code !== String(otp).trim()) {
    bumpOtpAttemptsStmt.run(email);
    return res.status(400).json({ error: 'otp_incorrect' });
  }

  if (getUserByEmailStmt.get(email)) return res.status(409).json({ error: 'email_taken' });
  if (getUserByUsernameStmt.get(username)) return res.status(409).json({ error: 'username_taken' });

  const id = nanoid(12);
  const hash = bcrypt.hashSync(password, 10);
  insertUserStmt.run(id, username, email, hash, Date.now());
  deleteOtpStmt.run(email);

  req.session.user = { id, username, email };
  res.json({ ok: true, user: { username, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'missing_fields' });
  const id = String(identifier).trim();
  const user = id.includes('@')
    ? getUserByEmailStmt.get(id.toLowerCase())
    : getUserByUsernameStmt.get(id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.user = { id: user.id, username: user.username, email: user.email };
  res.json({ ok: true, user: { username: user.username, email: user.email } });
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

  socket.on('join', ({ boardId }) => {
    if (!boardId) return;
    joinedBoard = boardId;
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
    if (!joinedBoard || !shape || !shape.id) return;
    getLive(joinedBoard).shapes.set(shape.id, shape);
    socket.to(joinedBoard).emit('shape:add', shape);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shape:update', (partial) => {
    if (!joinedBoard || !partial || !partial.id) return;
    const live = getLive(joinedBoard);
    const existing = live.shapes.get(partial.id);
    if (existing) Object.assign(existing, partial); else live.shapes.set(partial.id, partial);
    socket.to(joinedBoard).emit('shape:update', partial);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shape:delete', ({ id }) => {
    if (!joinedBoard || !id) return;
    getLive(joinedBoard).shapes.delete(id);
    socket.to(joinedBoard).emit('shape:delete', { id });
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });
  socket.on('shapes:bulk', ({ add = [], update = [], del = [] }) => {
    if (!joinedBoard) return;
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
    if (!joinedBoard || !name) return;
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
