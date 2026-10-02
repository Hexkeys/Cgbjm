'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!ACCESS_PASSWORD || !AGENT_TOKEN) {
  console.error('ACCESS_PASSWORD and AGENT_TOKEN environment variables are required.');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');

function signSession() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${hmac(exp)}`;
}
function verifySession(tok) {
  if (typeof tok !== 'string') return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expect = hmac(exp);
  return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}

const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  attempts.set(ip, a);
  return a.n >= 10;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || !safeEqual(pw, ACCESS_PASSWORD)) {
    attempts.get(req.ip).n += 1;
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: signSession() });
});

app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const agents = new Map();
const viewers = new Set();
const INPUT_TYPES = new Set(['move', 'abs', 'click', 'down', 'up', 'scroll', 'key', 'text', 'quality']);

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const deviceList = () => [...agents.values()].map((a) => ({ id: a.id, name: a.name }));
const broadcastDevices = () => {
  for (const v of viewers) send(v, { type: 'devices', devices: deviceList() });
};
const notifyAgent = (a) => send(a.ws, { type: 'viewers', count: a.viewers.size });

function leave(v) {
  const a = agents.get(v.agentId);
  v.agentId = null;
  if (a && a.viewers.delete(v)) notifyAgent(a);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/agent') {
    const auth = req.headers['authorization'] || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(tok, AGENT_TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const id = (url.searchParams.get('id') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
    if (!id) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    const name = (url.searchParams.get('name') || 'PC').slice(0, 64);
    wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, id, name));
  } else if (url.pathname === '/viewer') {
    wss.handleUpgrade(req, socket, head, (ws) => onViewer(ws));
  } else {
    socket.destroy();
  }
});

function onAgent(ws, id, name) {
  const old = agents.get(id);
  if (old) old.ws.close(4000, 'replaced');
  const agent = { id, name, ws, w: 0, h: 0, viewers: new Set() };
  agents.set(id, agent);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`agent connected: ${name} (${id})`);
  broadcastDevices();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      for (const v of agent.viewers) {
        if (v.readyState === 1 && v.bufferedAmount < 1000000) v.send(data, { binary: true });
      }
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'hello') {
      agent.w = Number(m.w) || 0;
      agent.h = Number(m.h) || 0;
      for (const v of agent.viewers) send(v, { type: 'info', w: agent.w, h: agent.h, name: agent.name });
    }
  });

  ws.on('close', () => {
    if (agents.get(id) === agent) agents.delete(id);
    for (const v of agent.viewers) { v.agentId = null; send(v, { type: 'agent-left' }); }
    agent.viewers.clear();
    console.log(`agent disconnected: ${name} (${id})`);
    broadcastDevices();
  });
}

function onViewer(ws) {
  ws.authed = false;
  ws.agentId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const timer = setTimeout(() => { if (!ws.authed) ws.close(4401, 'auth timeout'); }, 5000);

  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > 4096) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }

    if (!ws.authed) {
      if (m.type === 'auth' && verifySession(m.token)) {
        ws.authed = true;
        clearTimeout(timer);
        viewers.add(ws);
        send(ws, { type: 'devices', devices: deviceList() });
      } else {
        ws.close(4401, 'unauthorized');
      }
      return;
    }

    if (m.type === 'watch') {
      leave(ws);
      const a = agents.get(String(m.id));
      if (!a) return send(ws, { type: 'agent-left' });
      ws.agentId = a.id;
      a.viewers.add(ws);
      send(ws, { type: 'info', w: a.w, h: a.h, name: a.name });
      notifyAgent(a);
    } else if (m.type === 'leave') {
      leave(ws);
    } else if (INPUT_TYPES.has(m.type)) {
      const a = agents.get(ws.agentId);
      if (a) send(a.ws, m);
    }
  });

  ws.on('close', () => {
    clearTimeout(timer);
    leave(ws);
    viewers.delete(ws);
  });
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`RemotePad server listening on :${PORT}`));
