/**
 * Every authenticated request to Atlas is signed by the identity's own
 * Ed25519 private key — never a password, never a session cookie, never a
 * bearer token that could leak and be replayed indefinitely. This is the
 * literal implementation of "identity is a keypair" from §1 of the research
 * doc, applied to API auth specifically rather than just being a UI concept.
 *
 * Verified with a real Ed25519 generate/sign/verify round trip via Node's
 * Web Crypto implementation before this was written the way it is — see the
 * scratchpad test this was checked against.
 */

import type { webcrypto } from "node:crypto";
import { base64ToBytes } from "./encoding.js";

// This file's tsconfig has no "DOM" lib (appropriate for a Node backend —
// pulling in DOM types for one API would add a lot of unrelated globals).
// Node's own type declarations expose the Web Crypto types under the
// `webcrypto` namespace instead of as bare globals, so that's what's used
// here; the runtime object is still the same global `crypto.subtle`.
type CryptoKey = webcrypto.CryptoKey;

export interface SignedRequestInput {
  method: string;
  path: string;
  timestampMs: number;
  bodySha256Hex: string;
}

/** The exact bytes an identity signs (and a server re-derives to verify).
 * Every field that could change the meaning of the request is included, so
 * a signature can't be replayed against a different method, path, or body
 * by an attacker who intercepts it. */
export function canonicalSigningString(input: SignedRequestInput): string {
  return [input.method.toUpperCase(), input.path, String(input.timestampMs), input.bodySha256Hex].join("\n");
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes — bounds the replay window

export class InvalidSignatureError extends Error {}

async function importEd25519PublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(publicKeyBase64);
  if (raw.length !== 32) {
    throw new InvalidSignatureError(`Expected a 32-byte raw Ed25519 public key, got ${raw.length} bytes.`);
  }
  return crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
}

/**
 * Verifies a signed request. Throws InvalidSignatureError on any failure —
 * bad signature, wrong key, or a timestamp too far from "now" (replay
 * protection: a captured, valid signature stops being usable after the
 * clock-skew window closes, since the timestamp is part of what's signed).
 */
export async function verifyRequestSignature(args: {
  publicKeyBase64: string;
  signatureBase64: string;
  input: SignedRequestInput;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  if (Math.abs(now - args.input.timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw new InvalidSignatureError("Request timestamp is outside the allowed window — request is stale or replayed.");
  }

  const publicKey = await importEd25519PublicKey(args.publicKeyBase64);
  const message = new TextEncoder().encode(canonicalSigningString(args.input));
  const signature = base64ToBytes(args.signatureBase64);

  const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, message);
  if (!valid) {
    throw new InvalidSignatureError("Signature does not verify against the identity's public key.");
  }
}

/** Registration proof-of-possession: before Atlas will create an Identity
 * row for a given public key, the caller has to prove they hold the
 * matching private key by signing this fixed challenge. Stops someone from
 * registering a public key they don't actually control. */
export function registrationChallenge(publicKeyBase64: string): string {
  return `ATLAS_IDENTITY_REGISTRATION:${publicKeyBase64}`;
}

export async function verifyRegistrationProof(args: {
  publicKeyBase64: string;
  signatureBase64: string;
}): Promise<void> {
  const publicKey = await importEd25519PublicKey(args.publicKeyBase64);
  const message = new TextEncoder().encode(registrationChallenge(args.publicKeyBase64));
  const signature = base64ToBytes(args.signatureBase64);
  const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, message);
  if (!valid) {
    throw new InvalidSignatureError("Registration signature does not prove possession of the private key for this public key.");
  }
}
