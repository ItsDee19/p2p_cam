#!/usr/bin/env node
'use strict';

/* End-to-end check of the control plane, without a browser.
 *
 * Part 1 exercises the happy path: a camera and a viewer pair with a PIN,
 * relay offer/answer/ICE, and tear down cleanly.
 * Part 2 is the security suite — every check here corresponds to a finding in
 * SECURITY.md and should fail loudly if a fix is ever regressed. */

const { spawn } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.TEST_PORT || 8477;
const HOST = '127.0.0.1';
const BASE = 'https://' + HOST + ':' + PORT;
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let failures = 0;
const section = (t) => console.log('\n  ' + t + '\n  ' + '-'.repeat(60));
function check(name, cond, detail) {
  if (cond) console.log('  pass   ' + name);
  else { failures++; console.log('  FAIL   ' + name + (detail ? '  — ' + detail : '')); }
}

const pairHash = (uid, pin) => crypto.createHash('sha256').update(uid + ':' + pin).digest('hex');

function req(method, p, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = Object.assign({}, opts.headers);
    let body = opts.body;
    if (body && !headers['content-type']) headers['content-type'] = 'application/json';
    if (body) headers['content-length'] = Buffer.byteLength(body);

    const r = https.request(BASE + p, { method, agent: opts.agentOverride || agent, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: null, raw: '', error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

const get = (p, o) => req('GET', p, o);
const post = (p, obj, o) => req('POST', p, Object.assign({ body: JSON.stringify(obj) }, o || {}));

/* minimal SSE client */
function sse(p) {
  const events = [];
  const waiters = [];
  let buf = '';
  let status = null;

  const r = https.get(BASE + p, { agent }, (res) => {
    status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.startsWith(':')) continue;
        let ev = 'message', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        const item = { event: ev, data: parsed };
        events.push(item);
        for (let k = waiters.length - 1; k >= 0; k--) {
          if (waiters[k].match(item)) { waiters[k].resolve(item); waiters.splice(k, 1); }
        }
      }
    });
  });

  return {
    events,
    get status() { return status; },
    close: () => r.destroy(),
    wait(match, ms) {
      const found = events.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx !== -1) { waiters.splice(idx, 1); reject(new Error('timeout')); }
        }, ms || 4000);
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== run == */

(async function () {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  const stop = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const r = await get('/api/stats');
    if (r.status === 200) { up = true; break; }
  }
  section('boot');
  check('server boots and serves HTTPS', up, out.slice(-300));
  if (!up) { stop(); process.exit(1); }

  /* ---------------------------------------------------------- part 1 -- */
  section('pairing and signalling');

  const UID = 'LESSAI-424242-TST';
  const PIN = '135790';
  const AUTH = pairHash(UID, PIN);
  const camId = 'cam-0000-1111';
  const viewId = 'view-2222-3333';

  const cam = sse(`/api/events?uid=${UID}&role=camera&id=${camId}&auth=${AUTH}`);
  const camReady = await cam.wait((e) => e.event === 'ready');
  check('camera registers with a pairing hash', camReady.data.uid === UID);
  check('camera receives a session token', /^[a-f0-9]{48}$/.test(camReady.data.token || ''));
  const camToken = camReady.data.token;

  await sleep(150);
  const reg = await get('/api/cameras');
  check('camera appears in the registry', reg.body.cameras.some((c) => c.uid === UID));
  check('registry marks the camera as protected',
    reg.body.cameras.find((c) => c.uid === UID).protected === true);

  const okProbe = await get(`/api/check?uid=${UID}&auth=${AUTH}`);
  check('correct PIN passes the pairing probe', okProbe.status === 200);

  const viewer = sse(`/api/events?uid=${UID}&role=viewer&id=${viewId}&auth=${AUTH}`);
  const vReady = await viewer.wait((e) => e.event === 'ready');
  const viewToken = vReady.data.token;
  check('viewer joins with the correct PIN', !!viewToken);

  const hello = await cam.wait((e) => e.event === 'hello');
  check('camera is told a viewer joined', hello.data.from === viewId);

  const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  const r1 = await post('/api/signal', { uid: UID, from: camId, token: camToken, to: viewId, type: 'offer', data: offer });
  check('offer relayed', r1.status === 200 && r1.body.delivered === 1, JSON.stringify(r1.body));

  const gotOffer = await viewer.wait((e) => e.event === 'signal' && e.data.type === 'offer');
  check('viewer receives the offer intact', gotOffer.data.data.sdp === offer.sdp);

  const answer = { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' };
  await post('/api/signal', { uid: UID, from: viewId, token: viewToken, to: camId, type: 'answer', data: answer });
  const gotAnswer = await cam.wait((e) => e.event === 'signal' && e.data.type === 'answer');
  check('camera receives the answer intact', gotAnswer.data.data.sdp === answer.sdp);

  const before = (await get('/api/stats')).body;
  check('media byte counter is zero', before.mediaBytes === 0);
  check('signalling byte counter advanced', before.signallingBytes > 0);

  /* ---------------------------------------------------------- part 2 -- */
  section('security — availability');

  const crashProbe = await get('/%');
  check('malformed percent-escape is rejected, not fatal', crashProbe.status === 400,
    'status ' + crashProbe.status);
  const stillUp = await get('/api/stats');
  check('server survives the malformed request', stillUp.status === 200);

  const nulByte = await get('/%00');
  check('NUL byte in path rejected', nulByte.status === 400 || nulByte.status === 404);

  const big = await post('/api/signal', { uid: UID, from: camId, token: camToken, type: 'ice', data: { x: 'A'.repeat(300 * 1024) } });
  check('oversized body answered with 413', big.status === 413, 'status ' + big.status);
  /* Fresh agent: the 413 closes that connection by design, so reusing the
   * pooled socket would test the client, not the server. */
  const freshAgent = new https.Agent({ rejectUnauthorized: false });
  const alive = await get('/api/stats', { agentOverride: freshAgent });
  check('server survives the oversized body', alive.status === 200, 'status ' + alive.status);

  section('security — origin and transport');

  const rebind = await get('/api/cameras', { headers: { host: 'evil.example.com' } });
  check('unknown Host header refused (DNS rebinding)', rebind.status === 421, 'status ' + rebind.status);

  const xorigin = await post('/api/signal', { uid: UID, from: camId, token: camToken, type: 'ice', data: {} },
    { headers: { origin: 'https://evil.example.com' } });
  check('cross-origin POST refused', xorigin.status === 403, 'status ' + xorigin.status);

  const formPost = await req('POST', '/api/signal', {
    body: JSON.stringify({ uid: UID, from: camId, token: camToken, type: 'ice', data: {} }),
    headers: { 'content-type': 'text/plain' },
  });
  check('simple-request content-type refused (CSRF)', formPost.status === 415, 'status ' + formPost.status);

  const page = await get('/viewer.html');
  const csp = page.headers['content-security-policy'] || '';
  check('CSP present', csp.length > 0);
  check('CSP uses a script nonce, not unsafe-inline',
    /script-src 'nonce-[^']+'/.test(csp) && !/unsafe-inline/.test(csp.split('style-src')[0]), csp.slice(0, 90));
  const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
  check('served HTML carries that nonce on every script',
    !!nonce && page.raw.split('<script').length - 1 === page.raw.split('nonce="' + nonce + '"').length - 1);
  check('X-Content-Type-Options set', page.headers['x-content-type-options'] === 'nosniff');
  check('framing denied', page.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(csp));
  check('referrer suppressed', page.headers['referrer-policy'] === 'no-referrer');

  const trav = await get('/../server.js');
  check('path traversal blocked', !String(trav.raw).includes('control plane listening'), 'status ' + trav.status);

  section('security — authentication and authorisation');

  const noAuth = sse(`/api/events?uid=${UID}&role=viewer&id=noauth-1234-5678`);
  await sleep(300);
  check('viewer without a pairing proof is rejected', noAuth.status === 400, 'status ' + noAuth.status);
  noAuth.close();

  const wrongPin = await get(`/api/check?uid=${UID}&auth=${pairHash(UID, '000000')}`);
  check('wrong PIN rejected by the probe', wrongPin.status === 403, 'status ' + wrongPin.status);

  const wrongSse = sse(`/api/events?uid=${UID}&role=viewer&id=wrong-1234-5678&auth=${pairHash(UID, '111111')}`);
  await sleep(300);
  check('wrong PIN cannot open an event stream', wrongSse.status === 403, 'status ' + wrongSse.status);
  wrongSse.close();

  const ghostUid = 'LESSAI-999999-ZZZ';
  const ghost = sse(`/api/events?uid=${ghostUid}&role=viewer&id=ghost-1234-5678&auth=${pairHash(ghostUid, '123456')}`);
  await sleep(300);
  check('a viewer cannot create a room (UID squatting)', ghost.status === 404, 'status ' + ghost.status);
  ghost.close();

  const dupCam = sse(`/api/events?uid=${UID}&role=camera&id=cam-9999-8888&auth=${AUTH}`);
  await sleep(300);
  check('a second camera cannot claim a live UID', dupCam.status === 409, 'status ' + dupCam.status);
  dupCam.close();

  section('security — signalling integrity');

  const noToken = await post('/api/signal', { uid: UID, from: camId, type: 'ice', data: {} });
  check('signal without a session token refused', noToken.status === 403, 'status ' + noToken.status);

  const badToken = await post('/api/signal', { uid: UID, from: camId, token: 'f'.repeat(48), type: 'ice', data: {} });
  check('signal with a forged token refused', badToken.status === 403, 'status ' + badToken.status);

  const impersonate = await post('/api/signal', { uid: UID, from: camId, token: viewToken, type: 'offer', data: offer });
  check('cannot send as another peer using your own token', impersonate.status === 403, 'status ' + impersonate.status);

  const stranger = await post('/api/signal', { uid: UID, from: 'nobody-0000-0000', token: camToken, type: 'ice', data: {} });
  check('non-member cannot signal into a room', stranger.status === 403, 'status ' + stranger.status);

  const badType = await post('/api/signal', { uid: UID, from: camId, token: camToken, type: 'evil', data: {} });
  check('unknown signal type rejected', badType.status === 400, 'status ' + badType.status);

  const badUid = await post('/api/signal', { uid: '../../etc', from: camId, token: camToken, type: 'ice', data: {} });
  check('malformed uid rejected', badUid.status === 400, 'status ' + badUid.status);

  const selfBefore = viewer.events.filter((e) => e.event === 'signal').length;
  await post('/api/signal', { uid: UID, from: viewId, token: viewToken, type: 'ice', data: {} });
  await sleep(250);
  check('sender never receives its own signal',
    viewer.events.filter((e) => e.event === 'signal').length === selfBefore);

  section('security — rate limiting');

  let limited = 0;
  for (let i = 0; i < 200; i++) {
    const r = await post('/api/signal', { uid: UID, from: camId, token: camToken, to: viewId, type: 'ice', data: { i } });
    if (r.status === 429) { limited = i; break; }
  }
  check('signalling flood is throttled', limited > 0, 'never hit 429');

  section('lifecycle');

  viewer.close();
  const bye = await cam.wait((e) => e.event === 'bye', 6000).catch(() => null);
  check('camera is told the viewer left', !!bye && bye.data.from === viewId);

  cam.close();
  await sleep(500);
  const reg2 = await get('/api/cameras');
  check('registry empties when the camera disconnects',
    !reg2.body.cameras.some((c) => c.uid === UID), JSON.stringify(reg2.body));

  /* room lockout last: it deliberately burns the per-IP failure budget */
  section('security — brute-force lockout');

  const LU = 'LESSAI-555555-LCK';
  const LP = '246810';
  const lockCam = sse(`/api/events?uid=${LU}&role=camera&id=lock-1111-2222&auth=${pairHash(LU, LP)}`);
  await lockCam.wait((e) => e.event === 'ready');

  let sawLock = false;
  for (let i = 0; i < 40; i++) {
    const r = await get(`/api/check?uid=${LU}&auth=${pairHash(LU, String(100000 + i))}`);
    if (r.status === 429) { sawLock = true; break; }
  }
  check('repeated wrong PINs lock the camera out', sawLock);

  const stillRight = await get(`/api/check?uid=${LU}&auth=${pairHash(LU, LP)}`);
  check('lockout applies even to the correct PIN while active', stillRight.status === 429,
    'status ' + stillRight.status);

  lockCam.close();
  await sleep(300);
  check('server still healthy at the end', (await get('/api/stats')).status === 200);

  stop();
  console.log('\n  ' + '='.repeat(62));
  if (failures) { console.log('  ' + failures + ' check(s) FAILED\n'); process.exit(1); }
  console.log('  all checks passed\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n  self-test crashed:', err.stack || err.message, '\n');
  process.exit(1);
});
