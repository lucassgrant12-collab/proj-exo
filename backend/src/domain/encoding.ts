/** Small, boring encoding helpers used by the signature-auth code. Kept
 * separate from money.ts's base64 helpers (which exist for the vault
 * encryption pattern carried over from the prototype) because this file is
 * Node-only (uses Buffer), while that one's written to be portable. */

import { createHash } from "node:crypto";

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
