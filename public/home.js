async function createBoard() {
  const name = document.getElementById('board-name').value.trim();
  const res = await fetch('/api/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  window.location.href = '/board/' + data.id;
}

function extractBoardId(raw) {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/\/board\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return s.replace(/[^a-zA-Z0-9_-]/g, '');
}

function joinBoard() {
  const raw = document.getElementById('join-id').value;
  const id = extractBoardId(raw);
  if (!id) return;
  window.location.href = '/board/' + id;
}

document.getElementById('create-btn').addEventListener('click', createBoard);
document.getElementById('join-btn').addEventListener('click', joinBoard);
document.getElementById('join-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBoard(); });
document.getElementById('board-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createBoard(); });

// Show recently created boards on this server (nice-to-have, not required)
fetch('/api/boards').then(r => r.json()).then(list => {
  if (!list || !list.length) return;
  const section = document.getElementById('recent-section');
  const wrap = document.getElementById('recent-list');
  list.slice(0, 8).forEach(b => {
    const a = document.createElement('a');
    a.className = 'recent-item';
    a.href = '/board/' + b.id;
    a.innerHTML = `<span>${(b.name || 'Untitled board')}</span><span class="rid">${b.id}</span>`;
    wrap.appendChild(a);
  });
  section.hidden = false;
}).catch(() => {});
