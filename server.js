const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');

// ---------- Storage setup (file-based, no external DB) ----------
// On Render, mount a persistent disk at DATA_DIR (see render.yaml) so
// boards & uploads survive restarts/deploys. Falls back to ./data locally.
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
`);

const getBoardStmt = db.prepare('SELECT * FROM boards WHERE id = ?');
const insertBoardStmt = db.prepare(
  'INSERT INTO boards (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
);
const updateBoardStmt = db.prepare(
  'UPDATE boards SET data = ?, updated_at = ? WHERE id = ?'
);
const renameBoardStmt = db.prepare(
  'UPDATE boards SET name = ?, updated_at = ? WHERE id = ?'
);
const listBoardsStmt = db.prepare(
  'SELECT id, name, created_at, updated_at FROM boards ORDER BY updated_at DESC LIMIT 100'
);

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

// Debounced per-board save to avoid hammering disk on every stroke point.
const pendingSaves = new Map();
function scheduleSave(boardId, shapesGetter) {
  if (pendingSaves.has(boardId)) return;
  const t = setTimeout(() => {
    pendingSaves.delete(boardId);
    const shapes = shapesGetter();
    updateBoardStmt.run(JSON.stringify(shapes), Date.now(), boardId);
  }, 600);
  pendingSaves.set(boardId, t);
}

// ---------- Express app ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25 * 1e6 }); // allow larger payloads for images

app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, nanoid(12) + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post('/api/boards', (req, res) => {
  const board = createBoard(req.body && req.body.name);
  res.json({ id: board.id, name: board.name });
});

app.get('/api/boards', (req, res) => {
  res.json(listBoardsStmt.all());
});

app.get('/api/boards/:id', (req, res) => {
  const board = loadBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'not_found' });
  res.json(board);
});

app.post('/api/upload/:boardId', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

app.get('/board/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Realtime collaboration ----------
// In-memory live state per board: shapes (source of truth while server is up)
// and connected users (id, name, color, cursor). Persisted to sqlite on change.
const liveBoards = new Map(); // boardId -> { shapes: Map<id,shape>, order: [] }

function getLive(boardId) {
  if (!liveBoards.has(boardId)) {
    let board = loadBoard(boardId);
    if (!board) board = createBoard('Untitled board'), (board.id = boardId);
    const map = new Map();
    for (const s of board.shapes) map.set(s.id, s);
    liveBoards.set(boardId, { shapes: map });
  }
  return liveBoards.get(boardId);
}

function currentShapesArray(boardId) {
  const live = liveBoards.get(boardId);
  if (!live) return [];
  return Array.from(live.shapes.values());
}

const USER_COLORS = ['#F97362', '#F2B84B', '#5FC9A8', '#5B9BD5', '#B78BE0', '#F088B6', '#7FD1D1', '#E8A75D'];

io.on('connection', (socket) => {
  let joinedBoard = null;
  let me = null;

  socket.on('join', ({ boardId, name }) => {
    if (!boardId) return;
    joinedBoard = boardId;
    const board = loadBoard(boardId) || (createBoard('Untitled board'), loadBoard(boardId));
    const live = getLive(boardId);
    socket.join(boardId);

    me = {
      id: socket.id,
      name: (name || 'Guest').slice(0, 40),
      color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
    };

    socket.emit('board:state', {
      boardId,
      name: board ? board.name : 'Untitled board',
      shapes: Array.from(live.shapes.values()),
      you: me,
    });

    socket.to(boardId).emit('user:join', me);

    // Send list of currently present users to the newcomer
    const room = io.sockets.adapter.rooms.get(boardId) || new Set();
    const others = [];
    for (const sid of room) {
      if (sid === socket.id) continue;
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.user) others.push(s.data.user);
    }
    socket.emit('users:list', others);
    socket.data.user = me;
  });

  socket.on('shape:add', (shape) => {
    if (!joinedBoard || !shape || !shape.id) return;
    const live = getLive(joinedBoard);
    live.shapes.set(shape.id, shape);
    socket.to(joinedBoard).emit('shape:add', shape);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });

  socket.on('shape:update', (partial) => {
    if (!joinedBoard || !partial || !partial.id) return;
    const live = getLive(joinedBoard);
    const existing = live.shapes.get(partial.id);
    if (existing) Object.assign(existing, partial);
    else live.shapes.set(partial.id, partial);
    socket.to(joinedBoard).emit('shape:update', partial);
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });

  socket.on('shape:delete', ({ id }) => {
    if (!joinedBoard || !id) return;
    const live = getLive(joinedBoard);
    live.shapes.delete(id);
    socket.to(joinedBoard).emit('shape:delete', { id });
    scheduleSave(joinedBoard, () => currentShapesArray(joinedBoard));
  });

  socket.on('shapes:bulk', ({ add = [], update = [], del = [] }) => {
    if (!joinedBoard) return;
    const live = getLive(joinedBoard);
    for (const s of add) live.shapes.set(s.id, s);
    for (const p of update) {
      const existing = live.shapes.get(p.id);
      if (existing) Object.assign(existing, p);
      else live.shapes.set(p.id, p);
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
    if (!joinedBoard || !me) return;
    socket.to(joinedBoard).emit('cursor', { ...pos, id: socket.id, name: me.name, color: me.color });
  });

  socket.on('disconnect', () => {
    if (joinedBoard) socket.to(joinedBoard).emit('user:leave', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Board server listening on port ' + PORT));
