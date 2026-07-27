/**
 * Real RSA blind signatures (Chaum's construction), implemented directly
 * with BigInt modular arithmetic. This is what makes §9's claim — "Atlas
 * can issue a SpendToken without being able to see, at spend time, which
 * PermissionGrant it came from" — a provable, structural property instead
 * of a promise. The previous version of domain/spendToken.ts generated an
 * opaque random reference, which is real tokenization (merchants never see
 * the funding source) but did nothing to stop Atlas's own database from
 * storing a direct grant→token link. This file, plus the schema change that
 * goes with it, is the actual fix.
 *
 * The four steps, and who runs each one in a real deployment:
 *   1. blind    — CLIENT. Picks a random token, hides it with a random
 *                 blinding factor before sending anything to Atlas.
 *   2. blindSign — ATLAS. Signs the blinded value. Atlas never sees the
 *                 real token here, only a value that looks random to it —
 *                 this is the entire unlinkability property, and it's math,
 *                 not policy.
 *   3. unblind  — CLIENT. Removes the blinding factor locally, ending up
 *                 with a valid signature on the *original* token. Atlas is
 *                 never involved in this step and never sees its output.
 *   4. verify   — ANYONE (a merchant, or Atlas at redemption time). Checks
 *                 the signature is real, using only the public key. Proves
 *                 the token was legitimately issued without revealing, or
 *                 needing, which issuance request produced it.
 *
 * Honest caveat: this is a correct implementation of the underlying
 * mathematical construction, not a drop-in production-grade library.
 * Textbook RSA blind signatures (as implemented here) are vulnerable to
 * certain chosen-message attacks that a real deployment should close with
 * proper padding — see RFC 9474 ("RSA Blind Signatures"), which
 * standardizes exactly that. Swapping this file's internals for an
 * RFC 9474-compliant implementation is the concrete next step; the protocol
 * shape (blind → sign → unblind → verify) stays the same.
 */

import { generateKeyPairSync } from "node:crypto";

function base64UrlToBigInt(b64url: string): bigint {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return bytesToBigInt(new Uint8Array(Buffer.from(b64, "base64")));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function bigIntToBytes(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/** Extended Euclidean algorithm — returns [gcd, x, y] such that ax + by = gcd. */
function egcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = egcd(b, a % b);
  return [g, y1, x1 - (a / b) * y1];
}

function modInverse(a: bigint, m: bigint): bigint {
  const [g, x] = egcd(((a % m) + m) % m, m);
  if (g !== 1n) throw new Error("Modular inverse does not exist (blinding factor was not coprime to the modulus).");
  return ((x % m) + m) % m;
}

export interface IssuerKeyPair {
  n: bigint;
  e: bigint;
  d: bigint;
}

export interface IssuerPublicKey {
  n: bigint;
  e: bigint;
}

export function publicKeyOf(key: IssuerKeyPair): IssuerPublicKey {
  return { n: key.n, e: key.e };
}

/** Generates a real RSA keypair via Node's own key generation (this is
 * where the actual large primes come from — nothing here fakes the hard
 * part) and extracts the raw n/e/d parameters the blind-signature math
 * needs, via JWK export. In-memory only for now — see README for the
 * honest note on key custody (a real deployment needs this behind a KMS,
 * persisted, not regenerated on every process restart). */
export function generateIssuerKeyPair(modulusLength = 2048): IssuerKeyPair {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength });
  const jwk = privateKey.export({ format: "jwk" }) as { n: string; e: string; d: string };
  return {
    n: base64UrlToBigInt(jwk.n),
    e: base64UrlToBigInt(jwk.e),
    d: base64UrlToBigInt(jwk.d),
  };
}

/** A fresh, random token identifier — the thing that ultimately becomes a
 * spendable SpendToken. Reduced mod n so it's always a valid RSA message. */
export function createRandomTokenMessage(n: bigint): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBigInt(bytes) % n;
}

export interface BlindedRequest {
  blindedMessage: bigint;
  blindingFactor: bigint;
}

/** Step 1 (client-side). Hides `message` behind a random factor before it
 * ever reaches Atlas. */
export function blind(message: bigint, pub: IssuerPublicKey): BlindedRequest {
  let r: bigint;
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    r = bytesToBigInt(bytes) % pub.n;
    // r must be invertible mod n. With a 2048-bit RSA modulus and a random
    // 256-bit candidate this fails with negligible probability, but the
    // loop makes it correct rather than merely "correct almost always."
    if (r > 1n && egcd(r, pub.n)[0] === 1n) break;
  }
  const blindedMessage = (message * modPow(r, pub.e, pub.n)) % pub.n;
  return { blindedMessage, blindingFactor: r };
}

/** Step 2 (Atlas-side). Signs the *blinded* value — Atlas never sees
 * `message` here, only something that looks like random noise to it. */
export function blindSign(blindedMessage: bigint, key: IssuerKeyPair): bigint {
  return modPow(blindedMessage, key.d, key.n);
}

/** Step 3 (client-side). Recovers a valid signature on the original,
 * un-blinded `message`. Atlas is never involved in, or shown the result
 * of, this step. */
export function unblind(blindSignature: bigint, blindingFactor: bigint, pub: IssuerPublicKey): bigint {
  return (blindSignature * modInverse(blindingFactor, pub.n)) % pub.n;
}

/** Step 4 (anyone). Confirms `signature` is a real signature on `message`
 * from the holder of this public key — no knowledge of the blinding factor
 * or the original issuance request required. */
export function verify(message: bigint, signature: bigint, pub: IssuerPublicKey): boolean {
  return modPow(signature, pub.e, pub.n) === ((message % pub.n) + pub.n) % pub.n;
}

export function messageToHex(message: bigint): string {
  return Buffer.from(bigIntToBytes(message)).toString("hex");
}

export function hexToMessage(hex: string): bigint {
  return bytesToBigInt(new Uint8Array(Buffer.from(hex, "hex")));
}
