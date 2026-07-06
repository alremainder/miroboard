(() => {
'use strict';

// ---------------- Setup ----------------
const boardId = window.BOARD_ID;
const isViewOnly = new URLSearchParams(location.search).get('access') === 'view';
const socket = io();
let myName = 'You';

if (isViewOnly) document.body.classList.add('view-only');

const canvas = document.getElementById('board-canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');
const cursorLayer = document.getElementById('cursor-layer');
const editLayer = document.getElementById('edit-layer');

// ---------------- State ----------------
const shapes = new Map();      // id -> shape
const shapeOrder = [];         // draw order (ids)
const selected = new Set();
const users = new Map();       // socketId -> {id,name,color,el,x,y}
let me = { id: null, name: myName, color: '#8fa3ff' };

let camera = { x: 0, y: 0, scale: 1 }; // screen = world*scale + {x,y}
let tool = 'select';
let currentColor = '#F97362';
let currentWidth = 3;
const PALETTE = ['#F97362', '#F2B84B', '#5FC9A8', '#5B9BD5', '#B78BE0', '#F088B6', '#FFF2A6', '#2B2E38'];
const BOX_SHAPES = ['rect', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star'];
const PATHLIKE_TYPES = ['path', 'highlighter'];

let drawing = null;      // in-progress shape while pointer down
let dragMode = null;     // 'move' | 'resize' | 'marquee' | 'pan'
let dragStart = null;
let dragOrigin = new Map(); // id -> {x,y,w,h,x1,y1,x2,y2} snapshot for move/resize
let marqueeRect = null;
let resizeHandle = null;
let spaceDown = false;
let eraseBatch = null;

const undoStack = [];
const redoStack = [];

let dirty = true;
function markDirty() { dirty = true; }

// ---------------- Coordinate helpers ----------------
function worldToScreen(x, y) { return { x: x * camera.scale + camera.x, y: y * camera.scale + camera.y }; }
function screenToWorld(x, y) { return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale }; }

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  markDirty();
}
window.addEventListener('resize', resizeCanvas);

// ---------------- Shape helpers ----------------
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function bbox(s) {
  if (s.type === 'line' || s.type === 'arrow') {
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1) || 1, h: Math.abs(s.y2 - s.y1) || 1 };
  }
  if (PATHLIKE_TYPES.includes(s.type)) {
    const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

function addLocalShape(shape, emit = true) {
  shapes.set(shape.id, shape);
  shapeOrder.push(shape.id);
  if (emit) socket.emit('shape:add', shape);
  markDirty();
}
function updateLocalShape(partial, emit = true) {
  const s = shapes.get(partial.id);
  if (s) Object.assign(s, partial);
  if (emit) socket.emit('shape:update', partial);
  markDirty();
}
function deleteLocalShape(id, emit = true) {
  shapes.delete(id);
  const i = shapeOrder.indexOf(id);
  if (i >= 0) shapeOrder.splice(i, 1);
  selected.delete(id);
  if (emit) socket.emit('shape:delete', { id });
  markDirty();
}

function pushUndo(op) { undoStack.push(op); redoStack.length = 0; updateUndoButtons(); }

function undo() {
  const op = undoStack.pop();
  if (!op) return;
  applyInverse(op, true);
  redoStack.push(op);
  updateUndoButtons();
}
function redo() {
  const op = redoStack.pop();
  if (!op) return;
  applyForward(op);
  undoStack.push(op);
  updateUndoButtons();
}
function applyInverse(op) {
  if (op.kind === 'add') deleteLocalShape(op.shape.id);
  else if (op.kind === 'delete') addLocalShape(op.shape);
  else if (op.kind === 'update') updateLocalShape({ id: op.id, ...op.before });
  else if (op.kind === 'bulk') {
    op.add.forEach(s => deleteLocalShape(s.id));
    op.del.forEach(s => addLocalShape(s));
    op.update.forEach(u => updateLocalShape({ id: u.id, ...u.before }));
  }
}
function applyForward(op) {
  if (op.kind === 'add') addLocalShape(op.shape);
  else if (op.kind === 'delete') deleteLocalShape(op.shape.id);
  else if (op.kind === 'update') updateLocalShape({ id: op.id, ...op.after });
  else if (op.kind === 'bulk') {
    op.add.forEach(s => addLocalShape(s));
    op.del.forEach(s => deleteLocalShape(s.id));
    op.update.forEach(u => updateLocalShape({ id: u.id, ...u.after }));
  }
}
function updateUndoButtons() {
  document.getElementById('undo-btn').disabled = undoStack.length === 0;
  document.getElementById('redo-btn').disabled = redoStack.length === 0;
}

function eraseAt(wx, wy) {
  const hit = hitTest(wx, wy);
  if (!hit) return;
  if (eraseBatch.some(s => s.id === hit.id)) return;
  eraseBatch.push({ ...hit });
  deleteLocalShape(hit.id);
}

function deleteSelected() {
  if (!selected.size) return;
  const del = Array.from(selected).map(id => shapes.get(id)).filter(Boolean);
  del.forEach(s => deleteLocalShape(s.id));
  pushUndo({ kind: 'bulk', add: [], update: [], del });
  selected.clear();
}

// ---------------- Rendering ----------------
function drawGrid() {
  const step = 40 * camera.scale;
  if (step < 6) return;
  ctx.save();
  ctx.fillStyle = 'rgba(18,20,28,0.14)';
  const ox = camera.x % step, oy = camera.y % step;
  for (let x = ox; x < wrap.clientWidth; x += step) {
    for (let y = oy; y < wrap.clientHeight; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function wrapText(text, maxWidth, fontSize) {
  ctx.font = fontSize + 'px Inter, sans-serif';
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

const imageCache = new Map();
function getImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.src = url;
  img.onload = markDirty;
  imageCache.set(url, img);
  return img;
}

function drawShape(s) {
  ctx.save();
  const strokeW = (s.strokeWidth || 2);
  ctx.lineWidth = strokeW;
  ctx.strokeStyle = s.color || '#2B2E38';
  ctx.fillStyle = s.color || '#2B2E38';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tl = worldToScreen(s.x || 0, s.y || 0);

  if (s.type === 'path') {
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const sp = worldToScreen(p[0], p[1]);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
  } else if (s.type === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = strokeW * 5;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const sp = worldToScreen(p[0], p[1]);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
  } else if (s.type === 'rect') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    ctx.strokeRect(tl.x, tl.y, w, h);
  } else if (s.type === 'ellipse') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    ctx.beginPath();
    ctx.ellipse(tl.x + w / 2, tl.y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === 'triangle') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    ctx.beginPath();
    ctx.moveTo(tl.x + w / 2, tl.y);
    ctx.lineTo(tl.x + w, tl.y + h);
    ctx.lineTo(tl.x, tl.y + h);
    ctx.closePath();
    ctx.stroke();
  } else if (s.type === 'diamond') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    ctx.beginPath();
    ctx.moveTo(tl.x + w / 2, tl.y);
    ctx.lineTo(tl.x + w, tl.y + h / 2);
    ctx.lineTo(tl.x + w / 2, tl.y + h);
    ctx.lineTo(tl.x, tl.y + h / 2);
    ctx.closePath();
    ctx.stroke();
  } else if (s.type === 'hexagon') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    const cx = tl.x + w / 2, cy = tl.y + h / 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 180 * (60 * i - 90);
      const px = cx + (w / 2) * Math.cos(ang), py = cy + (h / 2) * Math.sin(ang);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (s.type === 'star') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    const cx = tl.x + w / 2, cy = tl.y + h / 2;
    const outerX = w / 2, outerY = h / 2;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = Math.PI / 180 * (36 * i - 90);
      const r = i % 2 === 0 ? 1 : 0.45;
      const px = cx + outerX * r * Math.cos(ang), py = cy + outerY * r * Math.sin(ang);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (s.type === 'line' || s.type === 'arrow') {
    const p1 = worldToScreen(s.x1, s.y1), p2 = worldToScreen(s.x2, s.y2);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    if (s.type === 'arrow') {
      const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const size = 10 + strokeW;
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - size * Math.cos(ang - Math.PI / 6), p2.y - size * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(p2.x - size * Math.cos(ang + Math.PI / 6), p2.y - size * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }
  } else if (s.type === 'sticky') {
    const w = s.w * camera.scale, h = s.h * camera.scale;
    ctx.fillStyle = s.color || '#FFF2A6';
    ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    roundRect(tl.x, tl.y, w, h, 6 * camera.scale);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#2B2E38';
    const pad = 12 * camera.scale;
    const fontSize = Math.max(11, 15 * camera.scale);
    const lines = wrapText(s.text || '', w - pad * 2, fontSize);
    ctx.font = fontSize + 'px Inter, sans-serif';
    lines.slice(0, Math.floor((h - pad * 2) / (fontSize * 1.3))).forEach((line, i) => {
      ctx.fillText(line, tl.x + pad, tl.y + pad + fontSize + i * fontSize * 1.3);
    });
  } else if (s.type === 'text') {
    const fontSize = (s.fontSize || 20) * camera.scale;
    ctx.fillStyle = s.color || '#2B2E38';
    ctx.font = fontSize + 'px Inter, sans-serif';
    const lines = wrapText(s.text || '', (s.w || 300) * camera.scale, fontSize);
    lines.forEach((line, i) => ctx.fillText(line, tl.x, tl.y + fontSize + i * fontSize * 1.25));
  } else if (s.type === 'image') {
    const img = getImage(s.url);
    const w = s.w * camera.scale, h = s.h * camera.scale;
    if (img.complete && img.naturalWidth) ctx.drawImage(img, tl.x, tl.y, w, h);
    else { ctx.strokeStyle = '#ccc'; ctx.strokeRect(tl.x, tl.y, w, h); }
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSelectionHandles() {
  if (!selected.size) return;
  ctx.save();
  selected.forEach(id => {
    const s = shapes.get(id);
    if (!s) return;
    const b = bbox(s);
    const tl = worldToScreen(b.x, b.y);
    const w = b.w * camera.scale, h = b.h * camera.scale;
    ctx.strokeStyle = '#4C6FFF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(tl.x - 3, tl.y - 3, w + 6, h + 6);
    ctx.setLineDash([]);
    if (selected.size === 1 && s.type !== 'path') {
      const handles = handlePositions(s);
      ctx.fillStyle = '#4C6FFF';
      Object.values(handles).forEach(p => {
        const sp = worldToScreen(p.x, p.y);
        ctx.fillRect(sp.x - 5, sp.y - 5, 10, 10);
      });
    }
  });
  ctx.restore();
}

function handlePositions(s) {
  if (s.type === 'line' || s.type === 'arrow') {
    return { p1: { x: s.x1, y: s.y1 }, p2: { x: s.x2, y: s.y2 } };
  }
  const b = bbox(s);
  return {
    nw: { x: b.x, y: b.y }, ne: { x: b.x + b.w, y: b.y },
    sw: { x: b.x, y: b.y + b.h }, se: { x: b.x + b.w, y: b.y + b.h },
  };
}

function render() {
  requestAnimationFrame(render);
  if (!dirty) return;
  dirty = false;
  ctx.clearRect(0, 0, wrap.clientWidth, wrap.clientHeight);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg') || '#eceae3';
  ctx.fillRect(0, 0, wrap.clientWidth, wrap.clientHeight);
  drawGrid();
  shapeOrder.forEach(id => { const s = shapes.get(id); if (s) drawShape(s); });
  if (drawing) drawShape(drawing);
  drawSelectionHandles();
  if (marqueeRect) {
    ctx.save();
    ctx.strokeStyle = '#4C6FFF'; ctx.fillStyle = 'rgba(76,111,255,0.08)'; ctx.lineWidth = 1;
    ctx.fillRect(marqueeRect.x, marqueeRect.y, marqueeRect.w, marqueeRect.h);
    ctx.strokeRect(marqueeRect.x, marqueeRect.y, marqueeRect.w, marqueeRect.h);
    ctx.restore();
  }
}
setInterval(markDirty, 250); // keep grid crisp on subtle rounding; cheap safety redraw
requestAnimationFrame(render);

// ---------------- Hit testing ----------------
function distToSeg(px, py, x1, y1, x2, y2) {
  const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
  const dot = A * C + B * D, len = C * C + D * D;
  let t = len ? dot / len : -1;
  t = Math.max(0, Math.min(1, t));
  const xx = x1 + t * C, yy = y1 + t * D;
  return Math.hypot(px - xx, py - yy);
}

function hitTest(wx, wy) {
  for (let i = shapeOrder.length - 1; i >= 0; i--) {
    const s = shapes.get(shapeOrder[i]);
    if (!s) continue;
    if (s.type === 'line' || s.type === 'arrow') {
      if (distToSeg(wx, wy, s.x1, s.y1, s.x2, s.y2) < 8 / camera.scale) return s;
    } else if (PATHLIKE_TYPES.includes(s.type)) {
      for (let j = 0; j < s.points.length - 1; j++) {
        if (distToSeg(wx, wy, s.points[j][0], s.points[j][1], s.points[j + 1][0], s.points[j + 1][1]) < 8 / camera.scale) return s;
      }
    } else {
      const b = bbox(s);
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return s;
    }
  }
  return null;
}

function shapesInRect(rx, ry, rw, rh) {
  const out = [];
  shapes.forEach(s => {
    const b = bbox(s);
    if (b.x + b.w >= rx && b.x <= rx + rw && b.y + b.h >= ry && b.y <= ry + rh) out.push(s);
  });
  return out;
}

function findHandleAt(wx, wy) {
  if (selected.size !== 1) return null;
  const s = shapes.get(Array.from(selected)[0]);
  if (!s) return null;
  const handles = handlePositions(s);
  for (const [k, p] of Object.entries(handles)) {
    if (Math.hypot(wx - p.x, wy - p.y) < 10 / camera.scale) return { shape: s, key: k };
  }
  return null;
}

// ---------------- Pointer interaction ----------------
let lastPointer = { x: 0, y: 0 };
let panLast = null;

wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const before = screenToWorld(e.offsetX, e.offsetY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    camera.scale = Math.min(4, Math.max(0.1, camera.scale * factor));
    const after = worldToScreen(before.x, before.y);
    camera.x += e.offsetX - after.x;
    camera.y += e.offsetY - after.y;
  } else {
    camera.x -= e.deltaX;
    camera.y -= e.deltaY;
  }
  markDirty();
  updateZoomLabel();
}, { passive: false });

const COLOR_BAR_TOOLS = ['pen', 'highlighter', 'rect', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star', 'line', 'arrow', 'sticky', 'text'];
function setActiveTool(t) {
  if (isViewOnly) return;
  tool = t;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  wrap.style.cursor = t === 'hand' ? 'grab' : (t === 'select' ? 'default' : (t === 'eraser' ? 'cell' : 'crosshair'));
  document.getElementById('color-bar').hidden = !COLOR_BAR_TOOLS.includes(t);
}
document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.addEventListener('click', () => setActiveTool(b.dataset.tool)));

function onPointerDown(e) {
  const rect = wrap.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);
  lastPointer = { x: sx, y: sy };

  if (isViewOnly) {
    dragMode = 'pan'; panLast = { x: sx, y: sy }; wrap.style.cursor = 'grabbing';
    return;
  }

  if (tool === 'hand' || e.button === 1 || spaceDown) {
    dragMode = 'pan'; panLast = { x: sx, y: sy }; wrap.style.cursor = 'grabbing';
    return;
  }

  if (tool === 'eraser') {
    eraseBatch = [];
    dragMode = 'erase';
    eraseAt(world.x, world.y);
    markDirty();
    return;
  }

  if (tool === 'select') {
    const handle = findHandleAt(world.x, world.y);
    if (handle) {
      dragMode = 'resize'; resizeHandle = handle; dragStart = world;
      dragOrigin.set(handle.shape.id, { ...handle.shape });
      return;
    }
    const hit = hitTest(world.x, world.y);
    if (hit) {
      if (!e.shiftKey && !selected.has(hit.id)) selected.clear();
      selected.add(hit.id);
      dragMode = 'move'; dragStart = world;
      dragOrigin.clear();
      selected.forEach(id => dragOrigin.set(id, { ...shapes.get(id) }));
    } else {
      if (!e.shiftKey) selected.clear();
      dragMode = 'marquee'; dragStart = { x: sx, y: sy };
      marqueeRect = { x: sx, y: sy, w: 0, h: 0 };
    }
    markDirty();
    return;
  }

  // drawing tools
  const id = uid();
  if (tool === 'pen') {
    drawing = { id, type: 'path', points: [[world.x, world.y]], color: currentColor, strokeWidth: currentWidth };
  } else if (tool === 'highlighter') {
    drawing = { id, type: 'highlighter', points: [[world.x, world.y]], color: currentColor, strokeWidth: currentWidth };
  } else if (BOX_SHAPES.includes(tool)) {
    drawing = { id, type: tool, x: world.x, y: world.y, w: 0, h: 0, color: currentColor, strokeWidth: currentWidth };
  } else if (tool === 'line' || tool === 'arrow') {
    drawing = { id, type: tool, x1: world.x, y1: world.y, x2: world.x, y2: world.y, color: currentColor, strokeWidth: currentWidth };
  } else if (tool === 'sticky') {
    const shape = { id, type: 'sticky', x: world.x - 90, y: world.y - 70, w: 180, h: 140, text: '', color: '#FFF2A6' };
    addLocalShape(shape);
    pushUndo({ kind: 'add', shape });
    openEditor(shape);
    setActiveTool('select'); selected.clear(); selected.add(id);
    return;
  } else if (tool === 'text') {
    const shape = { id, type: 'text', x: world.x, y: world.y, w: 320, h: 40, text: '', color: currentColor, fontSize: 22 };
    addLocalShape(shape);
    pushUndo({ kind: 'add', shape });
    openEditor(shape);
    setActiveTool('select'); selected.clear(); selected.add(id);
    return;
  }
  dragMode = 'draw';
  markDirty();
}

function onPointerMove(e) {
  const rect = wrap.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  socket.emit('cursor', { x: world.x, y: world.y });

  if (isViewOnly) {
    if (dragMode === 'pan') {
      camera.x += sx - panLast.x; camera.y += sy - panLast.y;
      panLast = { x: sx, y: sy };
      markDirty();
    }
    return;
  }

  if (dragMode === 'pan') {
    camera.x += sx - panLast.x; camera.y += sy - panLast.y;
    panLast = { x: sx, y: sy };
    markDirty();
    return;
  }
  if (dragMode === 'erase') {
    eraseAt(world.x, world.y);
    return;
  }
  if (dragMode === 'draw' && drawing) {
    if (PATHLIKE_TYPES.includes(drawing.type)) drawing.points.push([world.x, world.y]);
    else if (BOX_SHAPES.includes(drawing.type)) {
      drawing.w = world.x - drawing.x; drawing.h = world.y - drawing.y;
    } else if (drawing.type === 'line' || drawing.type === 'arrow') {
      drawing.x2 = world.x; drawing.y2 = world.y;
    }
    markDirty();
    return;
  }
  if (dragMode === 'move' && dragStart) {
    const dx = world.x - dragStart.x, dy = world.y - dragStart.y;
    selected.forEach(id => {
      const orig = dragOrigin.get(id);
      const s = shapes.get(id);
      if (!s || !orig) return;
      if (s.type === 'line' || s.type === 'arrow') {
        updateLocalShape({ id, x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
      } else if (s.type === 'path') {
        updateLocalShape({ id, points: orig.points.map(p => [p[0] + dx, p[1] + dy]) });
      } else {
        updateLocalShape({ id, x: orig.x + dx, y: orig.y + dy });
      }
    });
    return;
  }
  if (dragMode === 'resize' && resizeHandle) {
    const s = resizeHandle.shape; const orig = dragOrigin.get(s.id);
    if (s.type === 'line' || s.type === 'arrow') {
      if (resizeHandle.key === 'p1') updateLocalShape({ id: s.id, x1: world.x, y1: world.y });
      else updateLocalShape({ id: s.id, x2: world.x, y2: world.y });
    } else {
      let { x, y, w, h } = orig;
      if (resizeHandle.key.includes('n')) { h = (orig.y + orig.h) - world.y; y = world.y; }
      if (resizeHandle.key.includes('s')) { h = world.y - orig.y; }
      if (resizeHandle.key.includes('w')) { w = (orig.x + orig.w) - world.x; x = world.x; }
      if (resizeHandle.key.includes('e')) { w = world.x - orig.x; }
      updateLocalShape({ id: s.id, x, y, w: Math.max(10, w), h: Math.max(10, h) });
    }
    return;
  }
  if (dragMode === 'marquee' && dragStart) {
    marqueeRect = { x: Math.min(sx, dragStart.x), y: Math.min(sy, dragStart.y), w: Math.abs(sx - dragStart.x), h: Math.abs(sy - dragStart.y) };
    markDirty();
  }
}

function onPointerUp() {
  if (dragMode === 'erase') {
    if (eraseBatch && eraseBatch.length) pushUndo({ kind: 'bulk', add: [], update: [], del: eraseBatch });
    eraseBatch = null;
    dragMode = null; marqueeRect = null;
    markDirty();
    return;
  }
  if (dragMode === 'draw' && drawing) {
    const shape = drawing;
    const b = bbox(shape);
    if (b.w > 2 || b.h > 2 || shape.type === 'path') {
      addLocalShape(shape);
      pushUndo({ kind: 'add', shape });
    }
    drawing = null;
  } else if (dragMode === 'move') {
    const updates = [];
    selected.forEach(id => {
      const orig = dragOrigin.get(id); const cur = shapes.get(id);
      if (orig && cur) updates.push({ id, before: pick(orig, cur), after: pick(cur, cur) });
    });
    if (updates.length) pushUndo({ kind: 'bulk', add: [], del: [], update: updates });
  } else if (dragMode === 'resize' && resizeHandle) {
    const s = resizeHandle.shape; const orig = dragOrigin.get(s.id); const cur = shapes.get(s.id);
    pushUndo({ kind: 'update', id: s.id, before: pick(orig, cur), after: pick(cur, cur) });
  } else if (dragMode === 'marquee' && marqueeRect) {
    const p1 = screenToWorld(marqueeRect.x, marqueeRect.y);
    const p2 = screenToWorld(marqueeRect.x + marqueeRect.w, marqueeRect.y + marqueeRect.h);
    const found = shapesInRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    found.forEach(s => selected.add(s.id));
  }
  dragMode = null; resizeHandle = null; dragStart = null; marqueeRect = null;
  wrap.style.cursor = tool === 'hand' ? 'grab' : 'default';
  markDirty();
}

function pick(orig, cur) {
  const keys = ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'points', 'text'];
  const o = {};
  keys.forEach(k => { if (k in orig) o[k] = orig[k]; });
  return o;
}

wrap.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);

wrap.addEventListener('dblclick', (e) => {
  const rect = wrap.getBoundingClientRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const hit = hitTest(world.x, world.y);
  if (hit && (hit.type === 'sticky' || hit.type === 'text')) openEditor(hit);
});

// ---------------- Text editing overlay ----------------
function openEditor(shape) {
  const ta = document.createElement('textarea');
  ta.className = 'shape-editor';
  ta.value = shape.text || '';
  const isSticky = shape.type === 'sticky';
  ta.style.fontSize = (isSticky ? 15 : (shape.fontSize || 22)) * camera.scale + 'px';
  ta.style.color = isSticky ? '#2B2E38' : (shape.color || '#2B2E38');
  ta.style.width = ((shape.w || 300) * camera.scale - (isSticky ? 24 : 0)) + 'px';
  ta.style.height = ((shape.h || 60) * camera.scale - (isSticky ? 24 : 0)) + 'px';
  const tl = worldToScreen(shape.x, shape.y);
  ta.style.left = (tl.x + (isSticky ? 12 : 0)) + 'px';
  ta.style.top = (tl.y + (isSticky ? 12 : 0)) + 'px';
  editLayer.appendChild(ta);
  ta.focus();
  function commit() {
    const text = ta.value;
    ta.remove();
    if (!text.trim() && shape.type === 'text') {
      deleteLocalShape(shape.id);
    } else {
      updateLocalShape({ id: shape.id, text });
    }
    markDirty();
  }
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ta.value = shape.text || ''; ta.blur(); } });
}

// ---------------- Keyboard shortcuts ----------------
const TOOL_KEYS = {
  v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser',
  r: 'rect', o: 'ellipse', g: 'triangle', d: 'diamond', x: 'hexagon', j: 'star',
  l: 'line', a: 'arrow', s: 'sticky', t: 'text', u: 'upload',
};
window.addEventListener('keydown', (e) => {
  if (document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
  if (e.code === 'Space') { spaceDown = true; wrap.style.cursor = 'grab'; }
  if (isViewOnly) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  const k = e.key.toLowerCase();
  if (TOOL_KEYS[k] && !e.ctrlKey && !e.metaKey) {
    if (TOOL_KEYS[k] === 'upload') document.getElementById('file-input').click();
    else setActiveTool(TOOL_KEYS[k]);
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; wrap.style.cursor = tool === 'hand' ? 'grab' : 'default'; } });

// ---------------- Color bar ----------------
const swatchesEl = document.getElementById('swatches');
PALETTE.forEach((c, i) => {
  const el = document.createElement('div');
  el.className = 'swatch' + (i === 0 ? ' active' : '');
  el.style.background = c;
  el.addEventListener('click', () => {
    currentColor = c;
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    if (selected.size) {
      selected.forEach(id => updateLocalShape({ id, color: c }));
    }
  });
  swatchesEl.appendChild(el);
});

document.querySelectorAll('.width-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentWidth = Number(btn.dataset.width);
    document.querySelectorAll('.width-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (selected.size) {
      selected.forEach(id => updateLocalShape({ id, strokeWidth: currentWidth }));
    }
  });
});

// ---------------- Zoom controls ----------------
function updateZoomLabel() { document.getElementById('zoom-level').textContent = Math.round(camera.scale * 100) + '%'; }
document.getElementById('zoom-in').addEventListener('click', () => { camera.scale = Math.min(4, camera.scale * 1.2); markDirty(); updateZoomLabel(); });
document.getElementById('zoom-out').addEventListener('click', () => { camera.scale = Math.max(0.1, camera.scale / 1.2); markDirty(); updateZoomLabel(); });
document.getElementById('zoom-reset').addEventListener('click', () => { camera = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2, scale: 1 }; markDirty(); updateZoomLabel(); });

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);

// ---------------- Upload (images + PDF) ----------------
const fileInput = document.getElementById('file-input');
document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files);
  let offset = 0;
  for (const file of files) {
    if (file.type === 'application/pdf') {
      await handlePdf(file, offset);
    } else if (file.type.startsWith('image/')) {
      await uploadAndPlace(file, offset);
    }
    offset += 40;
  }
  fileInput.value = '';
});

async function uploadAndPlace(file, offset, forcedW, forcedH) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload/' + boardId, { method: 'POST', body: form });
  const data = await res.json();
  const center = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
  const img = new Image();
  await new Promise(resolve => { img.onload = resolve; img.src = data.url; });
  const maxW = 420;
  const ratio = img.naturalHeight / img.naturalWidth;
  const w = forcedW || Math.min(maxW, img.naturalWidth);
  const h = forcedH || w * ratio;
  const shape = { id: uid(), type: 'image', x: center.x - w / 2 + offset, y: center.y - h / 2 + offset, w, h, url: data.url };
  addLocalShape(shape);
  pushUndo({ kind: 'add', shape });
}

async function handlePdf(file, offset) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const center = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas');
    c.width = viewport.width; c.height = viewport.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    const form = new FormData();
    form.append('file', new File([blob], `page-${i}.png`, { type: 'image/png' }));
    const res = await fetch('/api/upload/' + boardId, { method: 'POST', body: form });
    const data = await res.json();
    const w = 380, h = w * (viewport.height / viewport.width);
    const col = (i - 1) % 4, row = Math.floor((i - 1) / 4);
    const shape = { id: uid(), type: 'image', x: center.x + col * (w + 24) - (w + 24) * 1.5 + offset, y: center.y + row * (h + 24) + offset, w, h, url: data.url };
    addLocalShape(shape);
    pushUndo({ kind: 'add', shape });
  }
}

wrap.addEventListener('dragover', (e) => e.preventDefault());
wrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  let offset = 0;
  for (const file of files) {
    if (file.type === 'application/pdf') await handlePdf(file, offset);
    else if (file.type.startsWith('image/')) await uploadAndPlace(file, offset);
    offset += 40;
  }
});

// ---------------- Presence & cursors ----------------
function renderPresence() {
  const el = document.getElementById('presence');
  el.innerHTML = '';
  const list = [me, ...Array.from(users.values())];
  list.slice(0, 6).forEach(u => {
    const a = document.createElement('div');
    a.className = 'avatar';
    a.style.background = u.color;
    a.title = u.name;
    a.textContent = (u.name || '?').slice(0, 1).toUpperCase();
    el.appendChild(a);
  });
}

function ensureCursorEl(u) {
  if (u.el) return u.el;
  const el = document.createElement('div');
  el.className = 'cursor';
  el.innerHTML = `<span class="cursor-arrow" style="color:${u.color}">➤</span><span class="cursor-label" style="background:${u.color}">${escapeHtml(u.name)}</span>`;
  cursorLayer.appendChild(el);
  u.el = el;
  return el;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function repositionCursors() {
  users.forEach(u => {
    if (u.x === undefined) return;
    const sp = worldToScreen(u.x, u.y);
    const el = ensureCursorEl(u);
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
  });
  requestAnimationFrame(repositionCursors);
}
requestAnimationFrame(repositionCursors);

// ---------------- Socket wiring ----------------
socket.on('connect', () => { socket.emit('join', { boardId, viewOnly: isViewOnly }); });
socket.on('board:deleted', () => {
  alert('This board was deleted.');
  window.location.href = '/';
});

socket.on('board:state', (data) => {
  me.id = socket.id;
  if (data.you) { me.name = data.you.name; me.color = data.you.color; myName = data.you.name; renderPresence(); }
  document.getElementById('board-name').value = data.name || 'Untitled board';
  if (isViewOnly) {
    document.getElementById('view-only-badge').hidden = false;
    document.getElementById('board-name').readOnly = true;
  }
  shapes.clear(); shapeOrder.length = 0;
  data.shapes.forEach(s => { shapes.set(s.id, s); shapeOrder.push(s.id); });
  camera = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2, scale: 1 };
  resizeCanvas();
  updateZoomLabel();
  markDirty();
});

socket.on('users:list', (list) => { list.forEach(u => users.set(u.id, { ...u })); renderPresence(); });
socket.on('user:join', (u) => { users.set(u.id, { ...u }); renderPresence(); });
socket.on('user:leave', ({ id }) => {
  const u = users.get(id);
  if (u && u.el) u.el.remove();
  users.delete(id);
  renderPresence();
});
socket.on('cursor', (data) => {
  const u = users.get(data.id) || { id: data.id, name: data.name, color: data.color };
  u.x = data.x; u.y = data.y; u.name = data.name; u.color = data.color;
  users.set(data.id, u);
});
socket.on('shape:add', (s) => { shapes.set(s.id, s); shapeOrder.push(s.id); markDirty(); });
socket.on('shape:update', (p) => { const s = shapes.get(p.id); if (s) Object.assign(s, p); markDirty(); });
socket.on('shape:delete', ({ id }) => {
  shapes.delete(id);
  const i = shapeOrder.indexOf(id); if (i >= 0) shapeOrder.splice(i, 1);
  selected.delete(id);
  markDirty();
});
socket.on('shapes:bulk', ({ add, update, del }) => {
  add.forEach(s => { shapes.set(s.id, s); shapeOrder.push(s.id); });
  update.forEach(p => { const s = shapes.get(p.id); if (s) Object.assign(s, p); });
  del.forEach(id => { shapes.delete(id); const i = shapeOrder.indexOf(id); if (i >= 0) shapeOrder.splice(i, 1); });
  markDirty();
});
socket.on('board:rename', (name) => { document.getElementById('board-name').value = name; });

// ---------------- Board name & share ----------------
const nameInput = document.getElementById('board-name');
nameInput.addEventListener('change', () => socket.emit('board:rename', nameInput.value));

const shareModal = document.getElementById('share-modal');
document.getElementById('share-btn').addEventListener('click', () => {
  const editLink = location.origin + '/board/' + boardId;
  const viewLink = editLink + '?access=view';
  document.getElementById('share-link-edit').value = editLink;
  document.getElementById('share-link-view').value = viewLink;
  document.getElementById('share-id').textContent = boardId || '(unknown)';
  shareModal.hidden = false;
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});
document.getElementById('close-share').addEventListener('click', () => shareModal.hidden = true);

function wireCopyButton(btnId, inputId) {
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById(inputId).value);
    btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500);
  });
}
wireCopyButton('copy-link-edit', 'share-link-edit');
wireCopyButton('copy-link-view', 'share-link-view');

// ---------------- Delete board ----------------
const deleteModal = document.getElementById('delete-modal');
document.getElementById('delete-board-btn').addEventListener('click', () => {
  document.getElementById('delete-board-name').textContent = nameInput.value || 'this board';
  deleteModal.hidden = false;
});
document.getElementById('cancel-delete').addEventListener('click', () => deleteModal.hidden = true);
document.getElementById('confirm-delete').addEventListener('click', async () => {
  const btn = document.getElementById('confirm-delete');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    const res = await fetch('/api/boards/' + boardId, { method: 'DELETE' });
    if (res.ok) { window.location.href = '/'; return; }
  } catch (e) { /* fall through to re-enable button */ }
  btn.disabled = false; btn.textContent = 'Delete board';
});

// ---------------- Init ----------------
resizeCanvas();
setActiveTool('select');
updateUndoButtons();
})();
