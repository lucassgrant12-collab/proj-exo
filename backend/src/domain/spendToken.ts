/**
 * SpendToken concepts on top of the real blind-signature primitives in
 * domain/blindSignature.ts. This file is intentionally thin — the actual
 * cryptography lives there; this just adds the token-specific pieces
 * (hashing a redeemed token for double-spend checks, and the SpendTokenForm
 * concept) and documents the client/server split, since in a real
 * deployment `blind` and `unblind` run on the user's device, never on
 * Atlas's servers — see services/spendTokenService.ts for where each step
 * is currently demonstrated (all four, clearly labeled) in the absence of a
 * separate client app to run the client-side half.
 *
 * Known simplification, worth being upfront about: the amount a token is
 * redeemed for is validated separately, against the grant's remaining
 * allowance, at redemption time (see spendTokenService.redeem) — the
 * blind-signed message itself doesn't bind a specific amount. A more
 * complete system would close this with a separate issuer key per
 * denomination (the classic Chaumian e-cash approach), since arbitrary data
 * can't be safely packed into a blind-signed value without its own padding
 * scheme. Tracked as a follow-up, not implemented here.
 */

import { sha256Hex } from "./encoding.js";
import { messageToHex } from "./blindSignature.js";

export type SpendTokenForm = "VIRTUAL_CARD" | "CRYPTO_ADDRESS";

/** The key a RedeemedSpendToken row is stored under — a hash of the
 * unblinded message, never the message or grant directly, and never
 * anything that could be reversed back to whichever issuance produced it. */
export function tokenHashFor(message: bigint): string {
  return sha256Hex(messageToHex(message));
}
