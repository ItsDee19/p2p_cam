#!/usr/bin/env node
'use strict';

/* Decodes the QR encoder's own output and checks it end to end:
 *
 *   - function patterns are where the spec says they are
 *   - the format information decodes back to ECC level M and the chosen mask
 *   - unmasking and reading the zigzag recovers the interleaved codewords
 *   - every Reed-Solomon block has all-zero syndromes
 *   - the decoded payload equals the input string
 *
 * If all of that passes, the symbol is standards-conformant. */

const path = require('path');
const QR = require(path.join(__dirname, '..', 'public', 'assets', 'qr.js'));
const I = QR._internal;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  pass   ' + name);
  } else {
    failures++;
    console.log('  FAIL   ' + name + (detail ? '  — ' + detail : ''));
  }
}

/* ---------------------------------------------------------- helpers -- */

function gmul(a, b) { return I.gmul(a, b); }

/* Syndromes of a full RS block (data followed by ECC). All zero == valid. */
function syndromes(block, nEcc) {
  const out = [];
  for (let i = 0; i < nEcc; i++) {
    const alpha = I.EXP[i];
    let acc = 0;
    for (let j = 0; j < block.length; j++) acc = gmul(acc, alpha) ^ block[j];
    out.push(acc);
  }
  return out;
}

function readFormat(m) {
  const size = m.length;
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= m[8][i] << i;
  bits |= m[8][7] << 6;
  bits |= m[8][8] << 7;
  bits |= m[7][8] << 8;
  for (let i = 9; i <= 14; i++) bits |= m[14 - i][8] << i;
  return bits;
}

function decodeFormat(raw) {
  const unmasked = raw ^ 0x5412;
  // brute-force the 32 valid codes and take the nearest by Hamming distance
  let best = null;
  for (let d = 0; d < 32; d++) {
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    const code = (d << 10) | (rem & 0x3ff);
    let diff = 0, x = code ^ unmasked;
    while (x) { diff += x & 1; x >>>= 1; }
    if (!best || diff < best.diff) best = { diff, ecc: (d >> 3) & 3, mask: d & 7 };
  }
  return best;
}

function unmask(modules, version, maskId) {
  const size = modules.length;
  const reserved = I.reservedMask(version, size);
  const fn = I.MASKS[maskId];
  const out = [];
  for (let r = 0; r < size; r++) {
    out.push(new Uint8Array(size));
    for (let c = 0; c < size; c++) {
      out[r][c] = (!reserved[r][c] && fn(r, c)) ? (modules[r][c] ^ 1) : modules[r][c];
    }
  }
  return { grid: out, reserved };
}

function readCodewords(grid, reserved, count) {
  const size = grid.length;
  const bits = [];
  let dir = -1, row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (!reserved[row][cc]) bits.push(grid[row][cc]);
      }
      row += dir;
      if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length && cw.length < count; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
    cw.push(v);
  }
  return cw;
}

function deinterleave(cw, version) {
  const t = I.VER[version];
  const eccPer = t[1], g1n = t[2], g1d = t[3], g2n = t[4], g2d = t[5];

  const blocks = [];
  for (let n = 0; n < g1n; n++) blocks.push(new Array(g1d).fill(0));
  for (let n = 0; n < g2n; n++) blocks.push(new Array(g2d).fill(0));
  const eccBlocks = blocks.map(() => new Array(eccPer).fill(0));

  let p = 0;
  const maxData = Math.max(g1d, g2d || 0);
  for (let c = 0; c < maxData; c++) {
    for (let n = 0; n < blocks.length; n++) {
      if (c < blocks[n].length) blocks[n][c] = cw[p++];
    }
  }
  for (let c = 0; c < eccPer; c++) {
    for (let n = 0; n < eccBlocks.length; n++) eccBlocks[n][c] = cw[p++];
  }
  return { blocks, eccBlocks, eccPer };
}

function decodePayload(blocks, version) {
  const data = [].concat.apply([], blocks);
  const bits = [];
  for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]; return v; };

  const mode = take(4);
  if (mode !== 0b0100) throw new Error('unexpected mode ' + mode);
  const len = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return Buffer.from(bytes).toString('utf8');
}

/* ------------------------------------------------------------- run -- */

const samples = [
  'https://192.168.0.116:8443/camera.html',
  'https://10.0.0.5:8443/viewer.html?uid=LESSAI-482913-XKQ',
  'A',
  'LESSAI-000000-AAA',
  'https://192.168.1.240:8443/camera.html?uid=LESSAI-999999-ZZZ&role=camera&x=1',
  'x'.repeat(180),
];

console.log('\n  QR encoder self-test\n  ' + '-'.repeat(58));

for (const text of samples) {
  const label = text.length > 44 ? text.slice(0, 41) + '...' : text;
  console.log('\n  "' + label + '"  (' + I.utf8Bytes(text).length + ' bytes)');

  let q;
  try {
    q = QR.encode(text);
  } catch (err) {
    check('encodes', false, err.message);
    continue;
  }

  const size = q.size;
  const m = q.modules;

  check('size matches version', size === 17 + 4 * q.version, 'got ' + size + ' for v' + q.version);

  // finder patterns: centre 3x3 dark, ring light
  const finderOk = (r0, c0) => {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        const expect = (i === 0 || i === 6 || j === 0 || j === 6) ? 1
          : (i >= 2 && i <= 4 && j >= 2 && j <= 4) ? 1 : 0;
        if (m[r0 + i][c0 + j] !== expect) return false;
      }
    }
    return true;
  };
  check('three finder patterns',
    finderOk(0, 0) && finderOk(0, size - 7) && finderOk(size - 7, 0));

  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  check('timing patterns alternate', timingOk);

  check('dark module set', m[size - 8][8] === 1);

  const fmt = decodeFormat(readFormat(m));
  check('format info: ECC level M', fmt.ecc === 0, 'got ' + fmt.ecc);
  check('format info: mask ' + q.mask, fmt.mask === q.mask, 'read ' + fmt.mask);
  check('format info is an exact BCH codeword', fmt.diff === 0, 'hamming ' + fmt.diff);

  const t = I.VER[q.version];
  const totalCw = t[0];
  const { grid, reserved } = unmask(m, q.version, fmt.mask);
  const cw = readCodewords(grid, reserved, totalCw);
  check('recovered ' + totalCw + ' codewords', cw.length === totalCw, 'got ' + cw.length);

  const { blocks, eccBlocks, eccPer } = deinterleave(cw, q.version);

  let allZero = true, worst = null;
  for (let n = 0; n < blocks.length; n++) {
    const full = blocks[n].concat(eccBlocks[n]);
    const s = syndromes(full, eccPer);
    if (s.some((x) => x !== 0)) { allZero = false; worst = n; }
  }
  check('Reed-Solomon syndromes all zero (' + blocks.length + ' block' +
        (blocks.length > 1 ? 's' : '') + ')', allZero,
        worst != null ? 'block ' + worst + ' failed' : '');

  let decoded = null;
  try { decoded = decodePayload(blocks, q.version); } catch (err) { /* reported below */ }
  check('payload round-trips', decoded === text,
        decoded == null ? 'could not parse' : 'got "' + String(decoded).slice(0, 30) + '"');
}

console.log('\n  ' + '-'.repeat(58));
if (failures) {
  console.log('  ' + failures + ' check(s) FAILED\n');
  process.exit(1);
}
console.log('  all checks passed\n');
