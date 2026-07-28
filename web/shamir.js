/**
 * Shamir's Secret Sharing over GF(256), applied to a raw 32-byte Ed25519
 * private key seed. This replaces the prototype's original "recovery keys"
 * (five unrelated random hex strings with zero cryptographic connection to
 * the actual identity — enabling them didn't really let you recover
 * anything). These shares are real: any `threshold` of the `shares`
 * returned by split() reconstruct the exact original secret via Lagrange
 * interpolation at x=0; fewer than `threshold` reveal nothing about it
 * (information-theoretic, not just computationally hard).
 *
 * This is the same construction classic tools like `ssss` use — per-byte
 * polynomials of degree (threshold-1) over GF(256), constant term = the
 * secret byte, evaluated at points x=1..n for the shares.
 */

(function (global) {
  "use strict";

  // GF(256) exp/log tables, generator 0x03, reduction polynomial 0x11B
  // (x^8+x^4+x^3+x+1 — the same field AES uses). Built once at load.
  //
  // Generator must be 0x03, not 0x02: repeatedly doubling (multiply-by-2,
  // i.e. `x << 1` with reduction) does NOT cycle through all 255 nonzero
  // field elements under this reduction polynomial — 0x02 has an order
  // smaller than 255 here, so that table silently omits elements and
  // corrupts every gfMul/gfDiv that touches them. 0x03 is primitive for
  // this field (the standard choice in every Rijndael/AES log-table
  // derivation) and does visit all 255. Caught by round-trip testing this
  // file against Node before it ever ran in a browser — see the "ALL
  // SHAMIR TESTS PASSED" check this was verified with.
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function buildTables() {
    var p = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = p;
      LOG[p] = i;
      var xtimeP = ((p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff; // multiply-by-2 in GF(256)
      p = xtimeP ^ p; // multiply-by-3 = multiply-by-2 XOR original
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gfDiv(a, b) {
    if (a === 0) return 0;
    if (b === 0) throw new Error("gfDiv: division by zero");
    return EXP[(LOG[a] - LOG[b] + 255) % 255];
  }

  function randomByte() {
    var arr = new Uint8Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
  }

  /**
   * Splits `secret` (any-length byte array) into `n` shares, any `threshold`
   * of which reconstruct it. Returns an array of { x, y: Uint8Array } —
   * x in 1..n (never 0, since y(0) is the secret itself), y the same length
   * as the secret.
   */
  function split(secret, n, threshold) {
    if (threshold < 2 || threshold > n) {
      throw new Error("split: require 2 <= threshold <= n");
    }
    var shares = [];
    for (var s = 1; s <= n; s++) shares.push({ x: s, y: new Uint8Array(secret.length) });

    for (var byteIdx = 0; byteIdx < secret.length; byteIdx++) {
      // Random polynomial of degree (threshold-1): coeffs[0] is the secret
      // byte itself, coeffs[1..threshold-1] are random.
      var coeffs = new Uint8Array(threshold);
      coeffs[0] = secret[byteIdx];
      for (var c = 1; c < threshold; c++) coeffs[c] = randomByte();

      for (var si = 0; si < shares.length; si++) {
        var x = shares[si].x;
        // Horner's method, evaluated in GF(256).
        var y = 0;
        for (var ci = threshold - 1; ci >= 0; ci--) {
          y = gfMul(y, x) ^ coeffs[ci];
        }
        shares[si].y[byteIdx] = y;
      }
    }
    return shares;
  }

  /**
   * Reconstructs the secret from >= threshold shares via Lagrange
   * interpolation at x=0, per byte. Any subset of the correct size that was
   * actually produced by split() with the same secret reconstructs it
   * exactly; there is no way to tell from the shares alone whether enough
   * were supplied — a wrong subset just silently produces wrong bytes,
   * exactly like real secret sharing.
   */
  function combine(shares) {
    if (shares.length < 2) throw new Error("combine: need at least 2 shares");
    var length = shares[0].y.length;
    for (var i = 1; i < shares.length; i++) {
      if (shares[i].y.length !== length) throw new Error("combine: share length mismatch");
    }

    var secret = new Uint8Array(length);
    for (var byteIdx = 0; byteIdx < length; byteIdx++) {
      var acc = 0;
      for (var i2 = 0; i2 < shares.length; i2++) {
        var xi = shares[i2].x;
        var yi = shares[i2].y[byteIdx];
        // Lagrange basis polynomial L_i(0) = product over j!=i of (0-xj)/(xi-xj),
        // and in GF(256) subtraction is XOR, so (0 - xj) = xj and (xi - xj) = xi ^ xj.
        var num = 1;
        var den = 1;
        for (var j = 0; j < shares.length; j++) {
          if (j === i2) continue;
          var xj = shares[j].x;
          num = gfMul(num, xj);
          den = gfMul(den, xi ^ xj);
        }
        acc ^= gfMul(yi, gfDiv(num, den));
      }
      secret[byteIdx] = acc;
    }
    return secret;
  }

  global.Shamir = { split: split, combine: combine };
})(globalThis);
