/* Signalling transport.
 *
 * Server-Sent Events downstream, plain POST upstream. No WebSocket, no library.
 * This carries offer / answer / ICE only — never media.
 *
 * Two secrets are in play:
 *   - the pairing proof, sha256(uid + ':' + PIN), which authorises joining a room
 *   - a per-connection bearer token, handed back on our own event stream, which
 *     must accompany every POST. It binds each POST to a live connection, so a
 *     third party can neither impersonate a peer nor forge requests from
 *     another origin. */

(function (global) {
  'use strict';

  function randomId() {
    var b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  function Signal(uid, role, auth) {
    this.uid = String(uid).toUpperCase();
    this.role = role;
    this.auth = auth || '';
    this.id = randomId();
    this.token = null;
    this.handlers = {};
    this.es = null;
    this.peers = [];
    this.failures = 0;
    this.closed = false;
  }

  Signal.prototype.on = function (ev, fn) {
    (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    return this;
  };

  Signal.prototype.emit = function (ev, data) {
    (this.handlers[ev] || []).forEach(function (fn) {
      try { fn(data); } catch (err) { console.error('[signal]', ev, err); }
    });
  };

  /* Side-effect-free pairing probe. Resolves { ok: true } or { ok: false,
   * status, error } so the caller can show a real message — EventSource itself
   * never exposes the HTTP status. */
  Signal.check = function (uid, auth) {
    var url = '/api/check?uid=' + encodeURIComponent(String(uid).toUpperCase()) +
              '&auth=' + encodeURIComponent(auth || '');
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return r.ok ? { ok: true } : { ok: false, status: r.status, error: body.error || ('HTTP ' + r.status) };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, error: 'cannot reach the server (' + err.message + ')' };
    });
  };

  Signal.prototype.connect = function () {
    var self = this;
    var url = '/api/events?uid=' + encodeURIComponent(this.uid) +
              '&role=' + encodeURIComponent(this.role) +
              '&id=' + encodeURIComponent(this.id) +
              '&auth=' + encodeURIComponent(this.auth);

    var es = new EventSource(url);
    this.es = es;

    ['ready', 'hello', 'bye', 'roster', 'signal'].forEach(function (name) {
      es.addEventListener(name, function (e) {
        var data;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        if (name === 'ready') { self.token = data.token; self.failures = 0; }
        if (name === 'roster') self.peers = data.peers || [];
        self.emit(name, data);
      });
    });

    es.onopen = function () { self.failures = 0; self.emit('open'); };

    es.onerror = function () {
      if (self.closed) return;
      self.failures += 1;
      /* EventSource retries forever by default, which against a 403 is an
       * accidental PIN-guessing loop. Give up after a few. */
      if (self.failures >= 4) {
        self.close();
        self.emit('failed', { attempts: self.failures });
      } else {
        self.emit('down', { attempts: self.failures });
      }
    };

    return this;
  };

  Signal.prototype.send = function (type, data, to) {
    if (!this.token) return Promise.resolve({ error: 'not authorised yet' });
    var body = JSON.stringify({
      uid: this.uid, from: this.id, token: this.token,
      to: to || null, type: type, data: data,
    });
    return fetch('/api/signal', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: body,
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function (err) { return { error: String(err) }; });
  };

  Signal.prototype.close = function () {
    this.closed = true;
    if (this.es) { this.es.close(); this.es = null; }
  };

  global.Signal = Signal;
  global.randomId = randomId;
})(window);
