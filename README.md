# Boards — realtime collaborative whiteboard (Miro-style)

A self-contained realtime whiteboard app: one Node.js service, no external
database. Board data and uploaded files are stored on disk (SQLite file +
an `uploads` folder), so it deploys as a single Render web service.

## What's included

- **Infinite canvas** — pan (space/hand tool/middle-mouse-drag) & zoom (ctrl+scroll or +/– buttons)
- **Tools**: select/move/resize, hand-pan, pen (freehand), rectangle, ellipse,
  line, arrow, sticky notes, text, color palette
- **Multi-select** via shift-click or drag marquee, move/resize/recolor/delete in bulk
- **Undo/redo** (per browser tab)
- **File uploads**: images placed directly on the board; **PDFs are rendered
  page-by-page** into images on the board (via pdf.js, client-side)
- **Multiple boards** — anyone can create a new board (gets a short ID) and
  share the link/ID; unlimited boards, unlimited simultaneous users per board
- **True realtime sync** over WebSockets (Socket.IO): shape create/move/edit/delete
  and **live cursor positions with name labels** broadcast to everyone in the
  board with no polling and minimal latency
- **Persistence**: every change is saved to a local SQLite file, so boards
  survive reloads and reconnects (and restarts, if you attach a persistent disk — see below)

Not included (out of scope for this pass): video/voice chat, templates
library, mind-map/flowchart auto-layout, comment threads, frames & presentation
mode, permission/roles management. The architecture (Socket.IO rooms + one
shapes table) makes these addable later without a redesign.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Data is written to `./data/boards.db` and `./data/uploads/`.

## Deploy to Render

This repo includes `render.yaml` (Render "Blueprint"). Steps:

1. Push this folder to a new GitHub repo.
2. In Render: **New → Blueprint**, point it at the repo. It will read
   `render.yaml` and create one Web Service automatically.
3. Render will run `npm install` then `node server.js`.

### About persistence on Render

`render.yaml` attaches a small **persistent disk** mounted at `/data`
(`DATA_DIR=/data`), so the SQLite file and uploaded images survive deploys
and restarts. Persistent disks require a paid instance type (the blueprint
uses `starter`); if you deploy on the **free** plan instead, remove the
`disk:` block — the app still works and data stays intact for the life of
the running instance, it just resets on the next deploy/restart since the
free plan's filesystem isn't persisted across deploys.

No MongoDB/Postgres/Redis needed — everything lives in that one disk.

## How the realtime sync works

- Each board is a Socket.IO "room" (`boardId`).
- On join, the server sends the full current shape list for that board.
- Every shape add/move/resize/recolor/delete is broadcast to the room instantly
  and mirrored to an in-memory copy on the server; changes are also
  debounced (~600ms) to a SQLite row so a slow disk never blocks live updates.
- Cursor positions are broadcast on `pointermove` (world coordinates, so
  everyone renders them correctly regardless of their own pan/zoom).

## File layout

```
server.js         Express + Socket.IO + SQLite + uploads
render.yaml        Render blueprint (web service + disk)
public/
  index.html/.css/.js   Home page — create/join boards
  board.html/.css/.js   The whiteboard app itself
data/               SQLite DB + uploaded files (created at runtime)
```
# miroboard
