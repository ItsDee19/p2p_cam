/* Minimal QR encoder — byte mode, error correction level M, versions 1..10.
 * Enough for a LAN URL, and small enough to read. No dependencies.
 * Exposed as window.QR in the browser and module.exports under Node (the
 * self-test in tools/qr-selftest.js decodes its own output to prove it). */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------ GF(256) -- */

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* Generator polynomial for n ECC codewords. */
  function rsGenerator(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, nEcc) {
    var gen = rsGenerator(nEcc);
    var res = new Array(nEcc).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < nEcc; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* ------------------------------------------------ version tables -- */

  /* [ total codewords, ecc per block, g1 blocks, g1 data, g2 blocks, g2 data ]
   * for error correction level M, versions 1..10. */
  var VER = {
    1:  [26,  10, 1, 16, 0, 0],
    2:  [44,  16, 1, 28, 0, 0],
    3:  [70,  26, 1, 44, 0, 0],
    4:  [100, 18, 2, 32, 0, 0],
    5:  [134, 24, 2, 43, 0, 0],
    6:  [172, 16, 4, 27, 0, 0],
    7:  [196, 18, 4, 31, 0, 0],
    8:  [242, 22, 2, 38, 2, 39],
    9:  [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  function dataCapacity(v) {
    var t = VER[v];
    return t[2] * t[3] + t[4] * t[5];
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var countBits = v < 10 ? 8 : 16;
      var needBits = 4 + countBits + byteLen * 8;
      if (needBits <= dataCapacity(v) * 8) return v;
    }
    return null;
  }

  /* ------------------------------------------------------ bitstream -- */

  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (value, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /** Build the final interleaved codeword sequence. */
  function buildCodewords(text, version) {
    var bytes = utf8Bytes(text);
    var t = VER[version];
    var eccPer = t[1], g1n = t[2], g1d = t[3], g2n = t[4], g2d = t[5];
    var totalData = dataCapacity(version);

    var buf = new BitBuf();
    buf.put(0b0100, 4);                          // byte mode
    buf.put(bytes.length, version < 10 ? 8 : 16); // character count
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    // terminator, up to four zeroes
    var room = totalData * 8 - buf.bits.length;
    buf.put(0, Math.min(4, room));
    // pad to a byte boundary
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);
    // alternating pad codewords
    var pad = [0xec, 0x11], p = 0;
    while (buf.bits.length < totalData * 8) buf.put(pad[p++ % 2], 8);

    var dataCw = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | buf.bits[b + k];
      dataCw.push(v);
    }

    // split into blocks
    var blocks = [], eccBlocks = [], pos = 0, n;
    for (n = 0; n < g1n; n++) { blocks.push(dataCw.slice(pos, pos + g1d)); pos += g1d; }
    for (n = 0; n < g2n; n++) { blocks.push(dataCw.slice(pos, pos + g2d)); pos += g2d; }
    for (n = 0; n < blocks.length; n++) eccBlocks.push(rsEncode(blocks[n], eccPer));

    // interleave
    var out = [], maxData = Math.max(g1d, g2d || 0), c;
    for (c = 0; c < maxData; c++) {
      for (n = 0; n < blocks.length; n++) if (c < blocks[n].length) out.push(blocks[n][c]);
    }
    for (c = 0; c < eccPer; c++) {
      for (n = 0; n < eccBlocks.length; n++) out.push(eccBlocks[n][c]);
    }
    return out;
  }

  /* --------------------------------------------------------- matrix -- */

  function blank(size) {
    var m = [], r;
    for (r = 0; r < size; r++) m.push(new Int8Array(size).fill(-1));
    return m;
  }

  function placeFunctionPatterns(m, version) {
    var size = m.length, i, j;

    function finder(r0, c0) {
      for (i = -1; i <= 7; i++) {
        for (j = -1; j <= 7; j++) {
          var r = r0 + i, c = c0 + j;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          var on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                   (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                   (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          m[r][c] = on ? 1 : 0;
        }
      }
    }

    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // timing
    for (i = 8; i < size - 8; i++) {
      m[6][i] = (i % 2 === 0) ? 1 : 0;
      m[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    // alignment
    var pts = ALIGN[version];
    for (i = 0; i < pts.length; i++) {
      for (j = 0; j < pts.length; j++) {
        var ar = pts[i], ac = pts[j];
        if ((ar <= 7 && ac <= 7) || (ar <= 7 && ac >= size - 8) || (ar >= size - 8 && ac <= 7)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            m[ar + dr][ac + dc] = on ? 1 : 0;
          }
        }
      }
    }

    // dark module
    m[size - 8][8] = 1;

    // reserve format areas (marked 0 for now, overwritten later)
    for (i = 0; i <= 8; i++) {
      if (m[8][i] === -1) m[8][i] = 0;
      if (m[i][8] === -1) m[i][8] = 0;
    }
    for (i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0;
    }

    // reserve version areas
    if (version >= 7) {
      for (i = 0; i < 6; i++) {
        for (j = 0; j < 3; j++) {
          m[size - 11 + j][i] = 0;
          m[i][size - 11 + j] = 0;
        }
      }
    }
  }

  function reservedMask(version, size) {
    var probe = blank(size);
    placeFunctionPatterns(probe, version);
    var res = [];
    for (var r = 0; r < size; r++) {
      res.push(new Uint8Array(size));
      for (var c = 0; c < size; c++) res[r][c] = probe[r][c] === -1 ? 0 : 1;
    }
    return res;
  }

  function placeData(m, reserved, codewords) {
    var size = m.length;
    var bits = [];
    for (var i = 0; i < codewords.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((codewords[i] >> b) & 1);
    }

    var idx = 0, dir = -1, row = size - 1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var k = 0; k < 2; k++) {
          var cc = col - k;
          if (!reserved[row][cc]) {
            m[row][cc] = idx < bits.length ? bits[idx++] : 0;
          }
        }
        row += dir;
        if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
      }
    }
  }

  var MASKS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; },
    function (i, j) { return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0; },
    function (i, j) { return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0; },
  ];

  function applyMask(m, reserved, maskId) {
    var size = m.length, fn = MASKS[maskId];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!reserved[r][c] && fn(r, c)) m[r][c] ^= 1;
      }
    }
  }

  function formatBits(maskId) {
    // ECC level M => 00
    var data = (0b00 << 3) | maskId;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
  }

  function versionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
    return (version << 12) | (rem & 0xfff);
  }

  function writeFormat(m, maskId) {
    var size = m.length, bitsVal = formatBits(maskId), i, bit;

    for (i = 0; i <= 5; i++) { bit = (bitsVal >> i) & 1; m[8][i] = bit; }
    m[8][7] = (bitsVal >> 6) & 1;
    m[8][8] = (bitsVal >> 7) & 1;
    m[7][8] = (bitsVal >> 8) & 1;
    for (i = 9; i <= 14; i++) { bit = (bitsVal >> i) & 1; m[14 - i][8] = bit; }

    for (i = 0; i <= 7; i++) { bit = (bitsVal >> i) & 1; m[size - 1 - i][8] = bit; }
    for (i = 8; i <= 14; i++) { bit = (bitsVal >> i) & 1; m[8][size - 15 + i] = bit; }

    m[size - 8][8] = 1;
  }

  function writeVersion(m, version) {
    if (version < 7) return;
    var size = m.length, bitsVal = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bitsVal >> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  function penalty(m) {
    var size = m.length, score = 0, r, c, i, run, last;

    // rule 1 — runs of five or more
    for (r = 0; r < size; r++) {
      run = 1; last = m[r][0];
      for (c = 1; c < size; c++) {
        if (m[r][c] === last) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; last = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (c = 0; c < size; c++) {
      run = 1; last = m[0][c];
      for (r = 1; r < size; r++) {
        if (m[r][c] === last) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; last = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // rule 2 — 2x2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // rule 3 — finder-like patterns
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, len, start) {
      var ok1 = true, ok2 = true;
      for (var k = 0; k < 11; k++) {
        var val = get(start + k);
        if (val !== pat1[k]) ok1 = false;
        if (val !== pat2[k]) ok2 = false;
      }
      return ok1 || ok2;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) {
        if (matches(function (x) { return m[r][x]; }, size, c)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r <= size - 11; r++) {
        if (matches(function (x) { return m[x][c]; }, size, r)) score += 40;
      }
    }

    // rule 4 — dark/light balance
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  /** Encode text; returns { size, version, mask, modules: Uint8Array[] }. */
  function encode(text) {
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    if (!version) throw new Error('text too long for this encoder (max ~213 bytes)');

    var size = 17 + 4 * version;
    var codewords = buildCodewords(text, version);
    var reserved = reservedMask(version, size);

    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var m = blank(size);
      placeFunctionPatterns(m, version);
      placeData(m, reserved, codewords);
      applyMask(m, reserved, mask);
      writeFormat(m, mask);
      writeVersion(m, version);

      var grid = [];
      for (var r = 0; r < size; r++) {
        grid.push(new Uint8Array(size));
        for (var c = 0; c < size; c++) grid[r][c] = m[r][c] & 1;
      }
      var p = penalty(grid);
      if (!best || p < best.penalty) best = { penalty: p, mask: mask, modules: grid };
    }

    return { size: size, version: version, mask: best.mask, modules: best.modules };
  }

  /** Render to an SVG string. */
  function svg(text, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var q = encode(text);
    var dim = q.size + quiet * 2;
    var parts = [];

    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
               '" shape-rendering="crispEdges" role="img" aria-label="QR code">');
    parts.push('<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>');

    for (var r = 0; r < q.size; r++) {
      var c = 0;
      while (c < q.size) {
        if (!q.modules[r][c]) { c++; continue; }
        var start = c;
        while (c < q.size && q.modules[r][c]) c++;
        parts.push('<rect x="' + (start + quiet) + '" y="' + (r + quiet) +
                   '" width="' + (c - start) + '" height="1" fill="#000000"/>');
      }
    }
    parts.push('</svg>');
    return parts.join('');
  }

  return {
    encode: encode,
    svg: svg,
    _internal: {
      VER: VER, ALIGN: ALIGN, rsEncode: rsEncode, rsGenerator: rsGenerator,
      buildCodewords: buildCodewords, reservedMask: reservedMask,
      utf8Bytes: utf8Bytes, pickVersion: pickVersion, dataCapacity: dataCapacity,
      MASKS: MASKS, formatBits: formatBits, gmul: gmul, EXP: EXP, LOG: LOG,
    },
  };
});
