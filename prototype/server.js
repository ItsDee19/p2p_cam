#!/usr/bin/env node
'use strict';

/**
 * less AI — P2P camera prototype
 *
 * This is the "thin control plane" from section 02 of the proposal, and nothing
 * more. It does exactly three jobs:
 *
 *   1. UID registry   — remembers which camera UIDs are online
 *   2. Signalling     — relays offer / answer / ICE between two paired peers
 *   3. Static files   — serves the two pages
 *
 * It never sees a byte of video or audio. /api/stats reports the counters that
 * prove it.
 *
 * SECURITY MODEL (see SECURITY.md for the full analysis)
 * -----------------------------------------------------
 * A camera creates a room and sets a pairing secret: sha256(uid + ':' + PIN),
 * where the PIN is shown on the device screen. A viewer must present the same
 * hash to join. The server never sees the PIN itself, only the hash, and it
 * compares in constant time.
 *
 * Every peer gets a per-connection bearer token, delivered only over its own
 * SSE stream. Signalling POSTs must carry it, which binds each POST to a live
 * connection and stops both peer impersonation and cross-site request forgery.
 *
 * This is prototype-grade, not product-grade. A shipped device authenticates
 * with the per-unit key pair burned at PCB flashing (section 04), not a shared
 * six-digit PIN.
 *
 * Zero npm dependencies. Node 18+.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const PORT = Number(process.env.PORT || 8443);
const REGEN = process.argv.includes('--regen-cert');
const PLAIN = process.argv.includes('--http');
const OPEN = process.argv.includes('--no-auth');   // escape hatch, loudly warned about

/* Resource ceilings. A prototype on a shared network still should not fall over
 * because somebody pointed a loop at it. */
const LIMITS = {
  rooms: 50,
  peersPerRoom: 8,
  connections: 120,
  bodyBytes: 256 * 1024,
  signalsPer10s: 150,
  authFailsPerMin: 10,
};

/* ------------------------------------------------------------------ *
 * network
 * ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

/* Hosts we will answer to. Anything else is refused, which is what stops a
 * malicious page from using DNS rebinding to talk to this server as if it were
 * same-origin. */
const ALLOWED_HOSTS = new Set([
  'localhost', '127.0.0.1', '[::1]', '::1',
  /* 10.0.2.2 is the Android emulator's fixed alias for its host's loopback.
   * It is only meaningful inside an emulator — nothing on a real network can
   * route to it — so allowing it costs nothing and is what lets the Android
   * app talk to a server running on the same machine. */
  '10.0.2.2',
]);
for (const a of lanAddresses()) ALLOWED_HOSTS.add(a.address);

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return ALLOWED_HOSTS.has(name);
}

/* ------------------------------------------------------------------ *
 * TLS
 * ------------------------------------------------------------------ */

function ensureCert() {
  const keyPath = path.join(CERTS, 'key.pem');
  const crtPath = path.join(CERTS, 'cert.pem');

  if (!REGEN && fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
  }

  fs.mkdirSync(CERTS, { recursive: true });
  const ips = lanAddresses().map((a) => a.address);
  const alt = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((i) => 'IP:' + i)].join(',');
  const cnfPath = path.join(CERTS, 'openssl.cnf');

  fs.writeFileSync(cnfPath, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = p2pcam.local', 'O = less AI prototype',
    '[v3]', 'subjectAltName = ' + alt,
    'basicConstraints = CA:FALSE',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth', '',
  ].join('\n'));

  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath, '-days', '365', '-config', cnfPath],
      { stdio: 'pipe' });
    try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
  } catch (err) {
    console.error('\n  Could not generate a TLS certificate with openssl.');
    console.error('  ' + (err.stderr ? err.stderr.toString().trim() : err.message));
    console.error('\n  Run with --http to serve plain HTTP instead. The camera page will');
    console.error('  then only work on http://localhost, not from a phone.\n');
    process.exit(1);
  }

  console.log('  minted a self-signed certificate for: ' + alt);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
}

/* ------------------------------------------------------------------ *
 * validation helpers
 * ------------------------------------------------------------------ */

const RE_UID = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const RE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RE_HASH = /^[a-f0-9]{64}$/;
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* sliding-window counter, used for auth failures per IP */
const authFails = new Map();
function tooManyAuthFails(ip) {
  const now = Date.now();
  const hits = (authFails.get(ip) || []).filter((t) => now - t < 60000);
  authFails.set(ip, hits);
  return hits.length >= LIMITS.authFailsPerMin;
}
function noteAuthFail(ip) {
  const now = Date.now();
  const hits = (authFails.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  authFails.set(ip, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of authFails) {
    const live = hits.filter((t) => now - t < 60000);
    if (live.length) authFails.set(ip, live); else authFails.delete(ip);
  }
}, 60000).unref();

/* ------------------------------------------------------------------ *
 * rooms
 * ------------------------------------------------------------------ */

/** uid -> { auth, peers: Map<clientId, Peer>, createdAt, fails: number[] } */
const rooms = new Map();

/* Per-room lockout. The per-IP limiter alone is not enough on a LAN, where an
 * attacker can trivially change source address; this caps guesses against a
 * given camera no matter where they come from. */
const ROOM_FAIL_LIMIT = 20;
const ROOM_FAIL_WINDOW = 5 * 60 * 1000;

function roomLocked(r) {
  const now = Date.now();
  r.fails = (r.fails || []).filter((t) => now - t < ROOM_FAIL_WINDOW);
  return r.fails.length >= ROOM_FAIL_LIMIT;
}
function noteRoomFail(r) {
  const now = Date.now();
  r.fails = (r.fails || []).filter((t) => now - t < ROOM_FAIL_WINDOW);
  r.fails.push(now);
}
let connections = 0;

const counters = {
  signallingBytes: 0,
  mediaBytes: 0,          // structurally always zero
  messages: 0,
  rejected: 0,
  startedAt: Date.now(),
};

function send(peer, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  counters.signallingBytes += Buffer.byteLength(payload);
  counters.messages += 1;
  try { peer.res.write(payload); } catch (_) {}
}

function roster(uid) {
  const r = rooms.get(uid);
  if (!r) return [];
  return [...r.peers.values()].map((p) => ({ id: p.id, role: p.role, since: p.since }));
}

function broadcastRoster(uid) {
  const r = rooms.get(uid);
  if (!r) return;
  const list = roster(uid);
  for (const p of r.peers.values()) send(p, 'roster', { uid, peers: list });
}

function closePeer(peer) {
  clearInterval(peer.ping);
  connections = Math.max(0, connections - 1);
  try { peer.res.end(); } catch (_) {}
}

function dropPeer(uid, clientId) {
  const r = rooms.get(uid);
  if (!r) return;
  const p = r.peers.get(clientId);
  if (!p) return;

  closePeer(p);
  r.peers.delete(clientId);
  log('leave', uid, p.role, clientId.slice(0, 8));

  /* When the camera goes, the room goes. Otherwise an orphaned room would sit
   * there with its pairing secret and a later camera could inherit it. */
  if (p.role === 'camera') {
    for (const other of r.peers.values()) {
      send(other, 'bye', { from: clientId, role: 'camera' });
      closePeer(other);
    }
    rooms.delete(uid);
    log('close', uid, '(camera left)');
    return;
  }

  if (r.peers.size === 0) { rooms.delete(uid); return; }
  for (const other of r.peers.values()) send(other, 'bye', { from: clientId, role: p.role });
  broadcastRoster(uid);
}

function log(...parts) {
  console.log('  ' + new Date().toISOString().slice(11, 19) + '  ' + parts.join('  '));
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function baseHeaders(nonce) {
  const csp = [
    "default-src 'none'",
    "script-src " + (nonce ? "'nonce-" + nonce + "'" : "'self'"),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');

  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(self), microphone=(self), geolocation=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  if (code >= 400) counters.rejected += 1;
  res.writeHead(code, Object.assign(baseHeaders(null), {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  }));
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const decoded = safeDecode(pathname);
  if (decoded === null) { json(res, 400, { error: 'bad path encoding' }); return; }
  if (decoded.indexOf('\0') !== -1) { json(res, 400, { error: 'bad path' }); return; }

  let rel = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));

  /* Compare against PUBLIC + separator so a sibling like "publicXYZ" can never
   * satisfy a bare startsWith() check. */
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, Object.assign(baseHeaders(null), { 'content-type': 'text/plain; charset=utf-8' }));
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    let out = buf;
    let nonce = null;

    /* Stamp a fresh nonce on every <script> so the CSP can forbid everything
     * else outright rather than allowing 'unsafe-inline'. */
    if (ext === '.html') {
      nonce = crypto.randomBytes(16).toString('base64');
      out = Buffer.from(buf.toString('utf8').replace(/<script(?=[\s>])/g, '<script nonce="' + nonce + '"'), 'utf8');
    }

    res.writeHead(200, Object.assign(baseHeaders(nonce), {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': out.length,
    }));
    res.end(out);
  });
}

/* ------------------------------------------------------------------ *
 * /api/events — SSE, and the only place a room is created
 * ------------------------------------------------------------------ */

function handleEvents(req, res, q) {
  const ip = clientIp(req);
  const uid = String(q.get('uid') || '').trim().toUpperCase();
  const role = q.get('role') === 'camera' ? 'camera' : 'viewer';
  const clientId = String(q.get('id') || '').trim();
  const auth = String(q.get('auth') || '').trim().toLowerCase();

  if (!RE_UID.test(uid)) return json(res, 400, { error: 'bad uid' });
  if (!RE_ID.test(clientId)) return json(res, 400, { error: 'bad client id' });
  if (!OPEN && !RE_HASH.test(auth)) return json(res, 400, { error: 'pairing proof required' });

  if (tooManyAuthFails(ip)) {
    log('block', uid, role, 'rate-limited ' + ip);
    return json(res, 429, { error: 'too many failed attempts, wait a minute' });
  }
  if (connections >= LIMITS.connections) return json(res, 503, { error: 'server at capacity' });

  let r = rooms.get(uid);

  if (role === 'camera') {
    if (!r) {
      if (rooms.size >= LIMITS.rooms) return json(res, 503, { error: 'too many rooms' });
      r = { auth: OPEN ? null : auth, peers: new Map(), createdAt: Date.now(), fails: [] };
      rooms.set(uid, r);
    } else {
      const existingCam = [...r.peers.values()].find((p) => p.role === 'camera' && p.id !== clientId);
      if (existingCam) {
        noteAuthFail(ip);
        return json(res, 409, { error: 'that UID is already claimed by another camera' });
      }
      if (!OPEN && !constantTimeEqual(r.auth || '', auth)) {
        noteAuthFail(ip);
        return json(res, 403, { error: 'pairing proof does not match' });
      }
    }
  } else {
    /* A viewer may never create a room. If it could, an attacker would register
     * the UID first with their own secret and the real camera would then be
     * unable to claim it. */
    if (!r) return json(res, 404, { error: 'no camera online with that UID' });
    if (roomLocked(r)) {
      log('block', uid, 'viewer', 'room locked out');
      return json(res, 429, { error: 'too many wrong PINs for this camera, try again shortly' });
    }
    if (!OPEN && !constantTimeEqual(r.auth || '', auth)) {
      noteAuthFail(ip);
      noteRoomFail(r);
      log('deny ', uid, 'viewer', 'wrong PIN from ' + ip);
      return json(res, 403, { error: 'wrong PIN' });
    }
  }

  if (r.peers.size >= LIMITS.peersPerRoom && !r.peers.has(clientId)) {
    return json(res, 503, { error: 'room is full' });
  }

  res.writeHead(200, Object.assign(baseHeaders(null), {
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }));
  res.write('retry: 2000\n\n');

  /* A reconnecting peer replaces its own stream rather than doubling up. */
  const prior = r.peers.get(clientId);
  if (prior) { closePeer(prior); r.peers.delete(clientId); }

  connections += 1;
  const peer = {
    id: clientId,
    role,
    res,
    since: Date.now(),
    token: crypto.randomBytes(24).toString('hex'),
    sent: [],
    ping: setInterval(() => { try { res.write(': keepalive\n\n'); } catch (_) {} }, 15000),
  };
  r.peers.set(clientId, peer);
  log('join ', uid, role, clientId.slice(0, 8));

  /* The token only ever travels down this peer's own event stream. A
   * cross-origin page cannot read it, which is what makes it a CSRF defence as
   * well as an anti-impersonation one. */
  send(peer, 'ready', { uid, id: clientId, role, token: peer.token });

  for (const other of r.peers.values()) {
    if (other.id !== clientId) send(other, 'hello', { from: clientId, role });
  }
  broadcastRoster(uid);

  req.on('close', () => dropPeer(uid, clientId));
  req.on('error', () => dropPeer(uid, clientId));
}

/* ------------------------------------------------------------------ *
 * /api/signal — relay, bound to a live connection by bearer token
 * ------------------------------------------------------------------ */

function handleSignal(req, res, body) {
  let msg;
  try { msg = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'bad json' }); }
  if (!msg || typeof msg !== 'object') return json(res, 400, { error: 'bad message' });

  const uid = String(msg.uid || '').toUpperCase();
  const from = String(msg.from || '');
  const token = String(msg.token || '');
  const type = String(msg.type || '');
  const to = msg.to ? String(msg.to) : null;

  if (!RE_UID.test(uid) || !RE_ID.test(from)) return json(res, 400, { error: 'bad identifiers' });
  if (!SIGNAL_TYPES.has(type)) return json(res, 400, { error: 'unsupported signal type' });

  const r = rooms.get(uid);
  if (!r) return json(res, 404, { error: 'no such uid' });

  const sender = r.peers.get(from);
  if (!sender) return json(res, 403, { error: 'not a member of this room' });
  if (sender.role === 'viewer' && to) {
    const target = r.peers.get(to);
    if (target && target.role === 'viewer') return json(res, 403, { error: 'viewers may not signal each other' });
  }
  if (!constantTimeEqual(sender.token, token)) {
    noteAuthFail(clientIp(req));
    return json(res, 403, { error: 'bad session token' });
  }

  /* per-peer flood control */
  const now = Date.now();
  sender.sent = sender.sent.filter((t) => now - t < 10000);
  if (sender.sent.length >= LIMITS.signalsPer10s) {
    return json(res, 429, { error: 'signalling rate exceeded' });
  }
  sender.sent.push(now);

  counters.signallingBytes += Buffer.byteLength(body);

  const envelope = { from, type, data: msg.data, t: now };
  let delivered = 0;

  for (const p of r.peers.values()) {
    if (p.id === from) continue;
    if (to && p.id !== to) continue;
    send(p, 'signal', envelope);
    delivered += 1;
  }

  json(res, 200, { ok: true, delivered });
}

/* ------------------------------------------------------------------ *
 * request entry
 * ------------------------------------------------------------------ */

const server = PLAIN ? http.createServer() : https.createServer(ensureCert());

/* Every request is wrapped: a thrown handler must still produce a response.
 * Keeping the process alive is not enough — a client left hanging on a dead
 * request is its own denial of service. */
server.on('request', (req, res) => {
  try {
    dispatch(req, res);
  } catch (err) {
    console.error('  request failed: ' + (err && err.stack ? err.stack : err));
    if (!res.headersSent) {
      try { json(res, 500, { error: 'internal error' }); return; } catch (_) {}
    }
    try { res.end(); } catch (_) {}
  }
});

function dispatch(req, res) {
  /* DNS-rebinding defence: only answer to hostnames we recognise. */
  if (!hostAllowed(req.headers.host)) {
    counters.rejected += 1;
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('misdirected request');
    return;
  }

  let u;
  try {
    u = new URL(req.url, 'https://' + req.headers.host);
  } catch (_) {
    return json(res, 400, { error: 'bad request' });
  }

  const q = u.searchParams;
  const origin = req.headers.origin;

  /* Same-origin enforcement for anything with a side effect. */
  if (req.method === 'POST') {
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (_) { ok = false; }
      if (!ok) { counters.rejected += 1; return json(res, 403, { error: 'cross-origin POST refused' }); }
    }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
      counters.rejected += 1;
      return json(res, 415, { error: 'content-type must be application/json' });
    }
  }

  /* Side-effect-free pairing probe. EventSource surfaces no status code to the
   * page, so the client checks here first and can show a real error instead of
   * reconnecting forever against a 403. Failures count toward the same limits. */
  if (u.pathname === '/api/check' && req.method === 'GET') {
    const ip = clientIp(req);
    const uid = String(q.get('uid') || '').trim().toUpperCase();
    const auth = String(q.get('auth') || '').trim().toLowerCase();

    if (!RE_UID.test(uid)) return json(res, 400, { error: 'bad uid' });
    if (tooManyAuthFails(ip)) return json(res, 429, { error: 'too many failed attempts, wait a minute' });

    const r = rooms.get(uid);
    if (!r) return json(res, 404, { error: 'no camera online with that UID' });
    if (roomLocked(r)) return json(res, 429, { error: 'too many wrong PINs for this camera, try again shortly' });

    if (!OPEN && !constantTimeEqual(r.auth || '', auth)) {
      noteAuthFail(ip);
      noteRoomFail(r);
      return json(res, 403, { error: 'wrong PIN' });
    }
    return json(res, 200, { ok: true, uid });
  }

  if (u.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, q);

  if (u.pathname === '/api/signal' && req.method === 'POST') {
    let raw = '';
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      raw += c;
      if (raw.length > LIMITS.bodyBytes) {
        aborted = true;
        raw = '';
        /* Answer properly and ask for the connection to close, rather than
         * destroying the socket mid-flight — a reset would deny the client the
         * 413 it needs to understand what went wrong. */
        const payload = JSON.stringify({ error: 'body too large' });
        try {
          res.writeHead(413, Object.assign(baseHeaders(null), {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            connection: 'close',
          }));
          res.end(payload);
        } catch (_) {}
        counters.rejected += 1;
        req.on('data', () => {});      // drain the rest, keep nothing
      }
    });
    req.on('end', () => {
      if (aborted) return;
      /* This fires on a later tick, outside the dispatch try/catch. */
      try {
        handleSignal(req, res, raw);
      } catch (err) {
        console.error('  signal handler failed: ' + (err && err.stack ? err.stack : err));
        if (!res.headersSent) { try { json(res, 500, { error: 'internal error' }); } catch (_) {} }
        else { try { res.end(); } catch (_) {} }
      }
    });
    req.on('error', () => { aborted = true; });
    return;
  }

  if (u.pathname === '/api/cameras' && req.method === 'GET') {
    /* Listing is a demo convenience. It reveals that a UID exists, never how to
     * open it — the PIN is required to join and is not derivable from this. */
    const list = [];
    for (const [uid, r] of rooms) {
      const cam = [...r.peers.values()].find((p) => p.role === 'camera');
      if (cam) {
        list.push({
          uid,
          since: cam.since,
          protected: !!r.auth,
          viewers: [...r.peers.values()].filter((p) => p.role === 'viewer').length,
        });
      }
    }
    return json(res, 200, { cameras: list, open: OPEN });
  }

  if (u.pathname === '/api/stats' && req.method === 'GET') {
    return json(res, 200, Object.assign({}, counters, {
      uptimeSeconds: Math.round((Date.now() - counters.startedAt) / 1000),
      rooms: rooms.size,
      connections,
    }));
  }

  if (u.pathname === '/api/net' && req.method === 'GET') {
    return json(res, 200, { port: PORT, scheme: PLAIN ? 'http' : 'https', addresses: lanAddresses(), open: OPEN });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });

  return serveStatic(req, res, u.pathname);
}

/* Stop slow-loris style half-open requests from parking sockets forever.
 * SSE responses are exempt: only the request phase is bounded. */
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 65000;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use by another program.');
    console.error('  Start on a different one, for example:\n');
    console.error('      PORT=8444 node server.js\n');
  } else {
    console.error('\n  Server error: ' + err.message + '\n');
  }
  process.exit(1);
});

/* A malformed request must never be able to take the process down. */
process.on('uncaughtException', (err) => {
  console.error('  uncaught: ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  console.error('  unhandled rejection: ' + (err && err.stack ? err.stack : err));
});

server.listen(PORT, '0.0.0.0', () => {
  const scheme = PLAIN ? 'http' : 'https';
  const bar = '  ' + '─'.repeat(64);

  console.log('');
  console.log('  less AI — P2P camera prototype');
  console.log('  control plane listening. media will not pass through this process.');
  console.log(bar);
  console.log('  On this machine   ' + scheme + '://localhost:' + PORT + '/');
  for (const a of lanAddresses()) {
    console.log('  On the LAN        ' + scheme + '://' + a.address + ':' + PORT + '/   (' + a.iface + ')');
  }
  console.log(bar);
  if (OPEN) {
    console.log('  !!  --no-auth: pairing is DISABLED. Anyone who can reach this port');
    console.log('  !!  can watch any camera. Never use this on a network you do not own.');
  } else {
    console.log('  Pairing is on. The phone shows a 6-digit PIN; the viewer needs it.');
  }
  if (!PLAIN) {
    console.log('  The certificate is self-signed, so each device warns once —');
    console.log('  accept it with Advanced ▸ Proceed.');
  } else {
    console.log('  Plain HTTP: the camera page will only work on localhost.');
  }
  console.log('');
});

process.on('SIGINT', () => { console.log('\n  shutting down\n'); process.exit(0); });
