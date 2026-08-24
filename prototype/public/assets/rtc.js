/* WebRTC helpers, stats reader and the on-screen log. */

(function (global) {
  'use strict';

  /* No ICE servers at all: on one LAN, host candidates connect directly and
   * nothing outside this network is contacted. Section 02 of the proposal
   * describes the STUN and TURN tier a real deployment adds for the internet
   * case — deliberately absent here so the prototype is provably self-contained. */
  var RTC_CONFIG = {
    iceServers: [],
    bundlePolicy: 'max-bundle',
  };

  /* ------------------------------------------------------------- log -- */

  function Logger(el, cap) {
    this.el = el;
    this.cap = cap || 300;
  }

  Logger.prototype.add = function (text, kind) {
    if (!this.el) return;
    var row = document.createElement('div');
    var t = document.createElement('time');
    var d = new Date();
    t.textContent =
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
    var s = document.createElement('span');
    if (kind) s.className = 't-' + kind;
    s.textContent = text;
    row.appendChild(t);
    row.appendChild(s);
    this.el.appendChild(row);
    while (this.el.childElementCount > this.cap) this.el.removeChild(this.el.firstChild);
    this.el.scrollTop = this.el.scrollHeight;
  };

  /* ----------------------------------------------------------- stats -- */

  /* Returns a flat snapshot, or null if nothing is flowing yet.
   * `prev` is the previous snapshot, used to turn byte totals into a rate. */
  function readStats(pc, prev) {
    return pc.getStats().then(function (report) {
      var inVideo = null, inAudio = null, outAudio = null, pair = null;
      var cands = {};

      report.forEach(function (r) {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inVideo = r;
        else if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
        else if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
        else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
        else if (r.type === 'candidate-pair') {
          if (r.nominated || r.state === 'succeeded') {
            if (!pair || (r.nominated && !pair.nominated)) pair = r;
          }
        }
      });

      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var bytes = (inVideo && inVideo.bytesReceived) || 0;
      var kbps = 0;

      if (prev && prev.bytes != null && now > prev.now) {
        var dt = (now - prev.now) / 1000;
        if (dt > 0.2) kbps = Math.max(0, ((bytes - prev.bytes) * 8) / 1000 / dt);
        else kbps = prev.kbps || 0;
      }

      var localType = null, remoteType = null;
      if (pair) {
        var lc = cands[pair.localCandidateId];
        var rc = cands[pair.remoteCandidateId];
        localType = lc && lc.candidateType;
        remoteType = rc && rc.candidateType;
      }

      var path = 'unknown';
      if (localType || remoteType) {
        if (localType === 'relay' || remoteType === 'relay') path = 'relayed';
        else if (localType === 'host' && remoteType === 'host') path = 'direct-lan';
        else path = 'direct';
      }

      return {
        now: now,
        bytes: bytes,
        kbps: kbps,
        width: (inVideo && inVideo.frameWidth) || 0,
        height: (inVideo && inVideo.frameHeight) || 0,
        fps: (inVideo && inVideo.framesPerSecond) || 0,
        packetsLost: (inVideo && inVideo.packetsLost) || 0,
        jitter: (inVideo && inVideo.jitter) || 0,
        rtt: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
        path: path,
        localType: localType,
        remoteType: remoteType,
        audioIn: !!(inAudio && inAudio.bytesReceived),
        audioOut: !!(outAudio && outAudio.bytesSent),
        audioOutBytes: (outAudio && outAudio.bytesSent) || 0,
      };
    });
  }

  /* ------------------------------------------------------------ misc -- */

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function pathLabel(p) {
    if (p === 'direct-lan') return 'DIRECT · LAN';
    if (p === 'direct') return 'DIRECT · P2P';
    if (p === 'relayed') return 'RELAYED';
    return 'CONNECTING';
  }

  /* Uniform random integer in [0, max) from the CSPRNG. Rejection sampling
   * keeps it unbiased; Math.random() is not used anywhere that matters because
   * V8's generator is predictable from a handful of outputs. */
  function randomBelow(max) {
    var limit = Math.floor(4294967296 / max) * max;
    var buf = new Uint32Array(1);
    var v;
    do { global.crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % max;
  }

  /* A camera UID that looks like something burned into a real unit, kept in
   * localStorage so reloading the page does not mint a new "device". */
  function deviceUid() {
    var KEY = 'lessai.p2pcam.uid';
    var existing = null;
    try { existing = localStorage.getItem(KEY); } catch (_) {}
    if (existing && /^LESSAI-\d{6}-[A-Z]{3}$/.test(existing)) return existing;

    var digits = '';
    for (var i = 0; i < 6; i++) digits += randomBelow(10);
    var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    var tail = '';
    for (var j = 0; j < 3; j++) tail += alpha[randomBelow(alpha.length)];

    var uid = 'LESSAI-' + digits + '-' + tail;
    try { localStorage.setItem(KEY, uid); } catch (_) {}
    return uid;
  }

  /* Six-digit pairing PIN, shown on the device and typed into the viewer.
   * Deliberately short enough to read aloud; the server's per-IP and per-room
   * lockouts are what make a 10^6 space adequate here. A shipped unit uses the
   * per-device key pair from section 04 instead. */
  function mintPin() {
    var s = '';
    for (var i = 0; i < 6; i++) s += randomBelow(10);
    return s;
  }

  /* The proof handed to the server. The PIN itself never leaves the device. */
  function pairHash(uid, pin) {
    var data = new TextEncoder().encode(String(uid).toUpperCase() + ':' + String(pin));
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var b = new Uint8Array(buf), s = '';
      for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
      return s;
    });
  }

  function secureOk() {
    return global.isSecureContext === true ||
           location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1';
  }

  global.RTC = {
    CONFIG: RTC_CONFIG,
    Logger: Logger,
    readStats: readStats,
    fmtBytes: fmtBytes,
    pathLabel: pathLabel,
    deviceUid: deviceUid,
    secureOk: secureOk,
    randomBelow: randomBelow,
    mintPin: mintPin,
    pairHash: pairHash,
  };
})(window);
