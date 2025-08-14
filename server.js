// server.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Socket.io (optional, for realtime job push)
const io = require('socket.io')(server, {
  cors: { origin: '*' }
});

// Load worker (it may start itself on import)
let bus, scanNow;
try {
  ({ bus, scanNow } = require('./worker')); // expect worker to export { bus, scanNow }
} catch (e) {
  console.warn('Worker load warning:', e.message);
}

// DB health check at startup (uses shared pool)
(async () => {
  try {
    await db.query('SELECT 1');
    console.log('✅ Postgres reachable');
  } catch (e) {
    console.error('❌ Postgres connection error', e);
  }
})();

// Basic routes
app.get('/', (_req, res) => res.send('OK'));

app.post('/scanNow', async (_req, res) => {
  try {
    if (typeof scanNow === 'function') {
      await scanNow();
      return res.json({ ok: true });
    }
    return res.status(501).json({ ok: false, error: 'scanNow not available' });
  } catch (e) {
    console.error('scanNow failed:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// --- DEBUG: list tables and peek data ---
app.get('/debug/schema', async (_req, res) => {
  try {
    const tables = await db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema='public'
       ORDER BY 1`
    );
    res.json({ tables: tables.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/jobs', async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, source, title, company, location, fetched_at
       FROM job
       ORDER BY fetched_at DESC
       LIMIT 20`
    );
    res.json(rows.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Realtime: forward worker bus events to clients (if worker exports a bus)
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('subscribe', (filter) => {
    socket.data.filter = filter;
    socket.emit('subscribed', filter);
  });
});

if (bus && bus.on) {
  bus.on('job', (j) => io.emit('job', j));
  bus.on('stats', (s) => io.emit('stats', s));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server up at http://localhost:${PORT}`);
});
