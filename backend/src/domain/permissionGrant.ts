/**
 * PermissionGrant — the scoped, revocable authorization primitive from
 * docs/research/atlas-protocol-research.md §9. This module holds the pure
 * validation rules: whether a grant is currently usable, and whether a
 * requested spend fits within what it allows. It does not touch a database —
 * services/settlementService.ts is what actually looks up prior usage and
 * calls into this.
 */

import { AssetCode, Money } from "./money.js";

export type FundingRail = "PISP" | "CARD_NETWORK" | "ONCHAIN";
export type FundingSourceKind = "BANK" | "CARD" | "WALLET";

export interface FundingSourceRef {
  id: string;
  kind: FundingSourceKind;
  rail: FundingRail;
  status: "ACTIVE" | "REVOKED";
}

export interface PermissionGrantInput {
  identityId: string;
  fundingSourceId: string;
  limit: Money;
  windowSeconds: number;
  singleUse: boolean;
  merchantCategory?: string;
  expiresAt?: Date;
}

export class InvalidGrantError extends Error {}

export function prepareGrant(
  input: PermissionGrantInput,
  fundingSource: FundingSourceRef,
): PermissionGrantInput {
  if (fundingSource.status !== "ACTIVE") {
    throw new InvalidGrantError(
      `Funding source ${fundingSource.id} is not active; cannot grant a permission against it.`,
    );
  }
  if (fundingSource.kind === "WALLET" && fundingSource.rail === "ONCHAIN") {
    // See §5 / the prototype: a connected external wallet is an attestation
    // only, never a spend funding source. Positions come from converting a
    // real funding source, not from an attached wallet — see the "Connect a
    // wallet stays optional, never a funding path" decision.
    throw new InvalidGrantError(
      "Connected wallets are attestations, not funding sources. A PermissionGrant must target a bank or card.",
    );
  }
  if (!input.limit.isPositive()) {
    throw new InvalidGrantError("A permission grant's limit must be a positive amount.");
  }
  if (input.windowSeconds <= 0) {
    throw new InvalidGrantError("windowSeconds must be positive.");
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new InvalidGrantError("expiresAt must be in the future.");
  }
  return input;
}

export interface GrantState {
  id: string;
  limit: Money;
  windowSeconds: number;
  singleUse: boolean;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expiresAt: Date | null;
  createdAt: Date;
}

/** Prior usage against this grant, within any window — the caller
 * (settlementService) is responsible for having already filtered this down
 * to entries inside the relevant velocity window before calling
 * `remainingAllowance`. */
export interface PriorUsage {
  amount: Money;
  at: Date;
}

export class GrantNotUsableError extends Error {}

export function assertGrantUsable(grant: GrantState, now: Date = new Date()): void {
  if (grant.status === "REVOKED") {
    throw new GrantNotUsableError(`Permission grant ${grant.id} has been revoked.`);
  }
  if (grant.status === "EXPIRED") {
    throw new GrantNotUsableError(`Permission grant ${grant.id} has expired.`);
  }
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) {
    throw new GrantNotUsableError(`Permission grant ${grant.id} expired at ${grant.expiresAt.toISOString()}.`);
  }
}

/**
 * How much of the grant's limit is still available, given usage already
 * recorded inside the current velocity window. Throws if the requested
 * amount would exceed what's left, or if a single-use grant has already
 * been used once.
 */
export function checkAllowance(
  grant: GrantState,
  usageInWindow: PriorUsage[],
  requested: Money,
): void {
  if (grant.singleUse && usageInWindow.length > 0) {
    throw new GrantNotUsableError(`Permission grant ${grant.id} is single-use and has already been used.`);
  }
  const spent = usageInWindow.reduce((total, u) => total.plus(u.amount), Money.zero(grant.limit.asset));
  const remaining = grant.limit.minus(spent);
  if (requested.greaterThan(remaining)) {
    throw new GrantNotUsableError(
      `Requested ${requested.toString()} exceeds remaining allowance ${remaining.toString()} on grant ${grant.id}.`,
    );
  }
}

export function assetOfGrant(grant: GrantState): AssetCode {
  return grant.limit.asset;
}
