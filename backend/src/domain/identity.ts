/**
 * Identity is the root primitive — see docs/research/atlas-protocol-research.md
 * §1. The keypair is generated client-side and Atlas never sees the private
 * key; what this module handles is turning a submitted public key into a
 * registerable identity, including deriving its display fingerprint
 * deterministically (a hash of the real key), rather than trusting a
 * client-asserted fingerprint string that could be inconsistent with the
 * key it's supposedly derived from.
 */

import { sha256Hex } from "./encoding.js";

const DISPLAY_ID_GROUP_COUNT = 4;
const DISPLAY_ID_GROUP_LENGTH = 4;

function randomDigits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(cryptoRandomInt(10));
  }
  return out;
}

function cryptoRandomInt(maxExclusive: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] as number) % maxExclusive;
}

/** Generates the human-shown identity number: "ATLAS 4471 8823 0091 5567".
 * Display convenience only — the real root of the identity is its keypair;
 * see §1 of the research doc for why that distinction matters (the number
 * is opaque and non-sequential on purpose, it encodes nothing about the
 * holder). This is independent of the key — two different identities get
 * unrelated display numbers even if that were ever a concern. */
export function generateDisplayId(): string {
  const groups = Array.from({ length: DISPLAY_ID_GROUP_COUNT }, () =>
    randomDigits(DISPLAY_ID_GROUP_LENGTH),
  );
  return `ATLAS ${groups.join(" ")}`;
}

/** Deterministic, display-only fingerprint derived from the actual public
 * key — formatted to match the prototype's "7f2a 9c41 ..." grouped-hex
 * style. Two registrations of the same key would always produce the same
 * fingerprint (the uniqueness constraint on Identity.publicKey is what
 * actually prevents duplicate registration, not this). */
export function deriveFingerprint(publicKeyBase64: string): string {
  const hex = sha256Hex(publicKeyBase64).slice(0, 32); // 16 bytes worth of hex
  const groups = hex.match(/.{1,4}/g) ?? [];
  return groups.join(" ");
}

export interface NewIdentityInput {
  publicKey: string; // base64, raw 32-byte Ed25519 public key
}

export interface NewIdentity {
  displayId: string;
  publicKey: string;
  publicKeyFingerprint: string;
}

export function prepareNewIdentity(input: NewIdentityInput): NewIdentity {
  if (!input.publicKey || input.publicKey.trim().length === 0) {
    throw new Error("publicKey is required to register an identity.");
  }
  return {
    displayId: generateDisplayId(),
    publicKey: input.publicKey.trim(),
    publicKeyFingerprint: deriveFingerprint(input.publicKey.trim()),
  };
}
