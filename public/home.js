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

fetch('/api/auth/me').then(r => r.json()).then(({ user }) => {
  document.getElementById('whoami').textContent = user ? `Signed in as ${user.username}` : '';
}).catch(() => {});
document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

document.getElementById('create-btn').addEventListener('click', createBoard);
document.getElementById('join-btn').addEventListener('click', joinBoard);
document.getElementById('join-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBoard(); });
document.getElementById('board-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createBoard(); });

// Show saved boards on this server, with the ability to reopen or delete them.
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function loadBoards() {
  fetch('/api/boards').then(r => r.json()).then(list => {
    const section = document.getElementById('recent-section');
    const wrap = document.getElementById('recent-list');
    wrap.innerHTML = '';
    if (!list || !list.length) { section.hidden = true; return; }
    list.slice(0, 20).forEach(b => {
      const row = document.createElement('div');
      row.className = 'recent-item';
      row.innerHTML = `
        <a class="recent-item-link" href="/board/${b.id}">
          <span>${escapeHtml(b.name || 'Untitled board')}</span>
          <span class="rid">${escapeHtml(b.id)}</span>
        </a>
        <button class="delete-board-btn" title="Delete board" data-id="${b.id}" data-name="${escapeHtml(b.name || 'Untitled board')}">✕</button>
      `;
      wrap.appendChild(row);
    });
    section.hidden = false;
    wrap.querySelectorAll('.delete-board-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete "${btn.dataset.name}"? This can't be undone.`)) return;
        btn.disabled = true;
        try {
          const res = await fetch('/api/boards/' + btn.dataset.id, { method: 'DELETE' });
          if (res.ok) loadBoards();
        } catch (e) { btn.disabled = false; }
      });
    });
  }).catch(() => {});
}
loadBoards();
