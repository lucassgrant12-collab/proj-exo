/**
 * The double-entry engine. This is the direct answer to "balances are still
 * treated as a pooled value": a user's balance is never a stored number that
 * gets incremented. It's the sum of every LedgerEntry ever posted to their
 * LedgerAccount. Custody of the underlying asset can be pooled at a real
 * provider — most crypto custodians and exchanges do exactly that — and it's
 * still always possible to prove exactly whose claim is whose, because the
 * accounting layer and the custody layer are different things.
 *
 * The one rule this file exists to enforce: every LedgerTransaction's entries
 * must sum to exactly zero, per asset. Nothing is created or destroyed
 * inside Atlas's own accounts — value only ever moves in from, or out to,
 * one of the two system-boundary account types (EXTERNAL_FUNDING,
 * EXTERNAL_LIQUIDITY), which represent the outside world (the card network /
 * bank rail, and the crypto liquidity partner, respectively).
 */

import { AssetCode, Money, sumMoney } from "./money.js";

export type LedgerAccountOwnerType =
  | "IDENTITY"
  | "ATLAS_OPERATING"
  | "ATLAS_CUSTODY_POOL"
  | "EXTERNAL_FUNDING"
  | "EXTERNAL_LIQUIDITY";

export interface LedgerAccountRef {
  ownerType: LedgerAccountOwnerType;
  /** Identity id when ownerType === "IDENTITY", otherwise null. */
  ownerId: string | null;
  asset: AssetCode;
}

export interface LedgerLine {
  account: LedgerAccountRef;
  amount: Money;
}

export type LedgerTransactionKind =
  | "FUNDING_RECEIVED"
  | "LIQUIDITY_PURCHASE"
  | "POSITION_ALLOCATION"
  | "MERCHANT_SPEND"
  | "CHARGEBACK_REVERSAL"
  | "HOLD_UNWIND"
  | "WITHDRAWAL"
  | "POSITION_DEALLOCATION"
  | "LIQUIDITY_SALE"
  | "FIAT_CREDITED";

export interface DraftLedgerTransaction {
  kind: LedgerTransactionKind;
  memo: string;
  settlementRecordId?: string;
  lines: LedgerLine[];
}

export class UnbalancedTransactionError extends Error {
  constructor(public readonly asset: AssetCode, public readonly remainder: Money) {
    super(
      `Ledger transaction does not balance for ${asset}: entries sum to ${remainder.toString()}, expected 0.`,
    );
    this.name = "UnbalancedTransactionError";
  }
}

/**
 * Verifies a draft transaction's entries sum to zero for every asset they
 * touch. Throws UnbalancedTransactionError if not. This is the single
 * invariant everything else in the ledger depends on — call it before ever
 * persisting a transaction, and never provide a code path that skips it.
 */
export function assertBalanced(lines: LedgerLine[]): void {
  const byAsset = new Map<AssetCode, Money[]>();
  for (const line of lines) {
    const existing = byAsset.get(line.amount.asset) ?? [];
    existing.push(line.amount);
    byAsset.set(line.amount.asset, existing);
  }
  for (const [asset, amounts] of byAsset) {
    const total = sumMoney(asset, amounts);
    if (!total.isZero()) {
      throw new UnbalancedTransactionError(asset, total);
    }
  }
}

export function accountKey(ref: LedgerAccountRef): string {
  return `${ref.ownerType}:${ref.ownerId ?? "-"}:${ref.asset}`;
}

// ---------------------------------------------------------------------------
// Transaction builders — one per real-world event this system needs to
// record. Each returns a balanced DraftLedgerTransaction; none of them talk
// to a database. Persisting is services/ledgerService.ts's job.
// ---------------------------------------------------------------------------

/** Transaction A from the research doc's §10: a card/bank charge lands in
 * Atlas's operating account, sourced from outside the system. */
export function fundingReceived(args: {
  identityId: string;
  amount: Money; // positive
  settlementRecordId: string;
}): DraftLedgerTransaction {
  return {
    kind: "FUNDING_RECEIVED",
    memo: `Funding received for settlement ${args.settlementRecordId}`,
    settlementRecordId: args.settlementRecordId,
    lines: [
      { account: { ownerType: "ATLAS_OPERATING", ownerId: null, asset: args.amount.asset }, amount: args.amount },
      { account: { ownerType: "EXTERNAL_FUNDING", ownerId: null, asset: args.amount.asset }, amount: args.amount.negate() },
    ],
  };
}

/** Atlas spends fiat operating cash to buy crypto from a liquidity partner,
 * and the purchased crypto lands in the pooled custody account. Two
 * independent asset legs in one transaction: fiat out, crypto in. */
export function liquidityPurchase(args: {
  fiatSpent: Money; // positive, e.g. GBP
  cryptoBought: Money; // positive, e.g. BTC
  settlementRecordId: string;
}): DraftLedgerTransaction {
  return {
    kind: "LIQUIDITY_PURCHASE",
    memo: `Liquidity purchase for settlement ${args.settlementRecordId}`,
    settlementRecordId: args.settlementRecordId,
    lines: [
      { account: { ownerType: "ATLAS_OPERATING", ownerId: null, asset: args.fiatSpent.asset }, amount: args.fiatSpent.negate() },
      { account: { ownerType: "EXTERNAL_LIQUIDITY", ownerId: null, asset: args.fiatSpent.asset }, amount: args.fiatSpent },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.cryptoBought.asset }, amount: args.cryptoBought },
      { account: { ownerType: "EXTERNAL_LIQUIDITY", ownerId: null, asset: args.cryptoBought.asset }, amount: args.cryptoBought.negate() },
    ],
  };
}

/** Moves a position out of the pooled custody account into a specific
 * identity's own claim account. This is the entry that actually makes the
 * position "theirs" for balance-reporting purposes — see §10, "buy-then-hold":
 * this can be posted immediately (so the balance shows up right away) while
 * the accompanying SettlementRecord stays HELD, gating withdrawal/spend
 * separately from whether the ledger already reflects the position. */
export function positionAllocation(args: {
  identityId: string;
  amount: Money; // positive
  settlementRecordId: string;
}): DraftLedgerTransaction {
  return {
    kind: "POSITION_ALLOCATION",
    memo: `Position allocated to identity ${args.identityId}`,
    settlementRecordId: args.settlementRecordId,
    lines: [
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.amount.asset }, amount: args.amount.negate() },
    ],
  };
}

/**
 * The reverse of positionAllocation: moves a position out of a specific
 * identity's claim account and back into the pooled custody account, ready
 * to be sold. This is Convert's crypto->fiat direction, step 1 of 3 (see
 * services/settlementService.ts's executeCryptoToFiatConversion) — mirrors
 * positionAllocation exactly, entries flipped.
 */
export function positionDeallocation(args: {
  identityId: string;
  amount: Money; // positive — deducted from the identity, added to the pool
  settlementRecordId?: string;
}): DraftLedgerTransaction {
  return {
    kind: "POSITION_DEALLOCATION",
    memo: `Position deallocated from identity ${args.identityId}`,
    ...(args.settlementRecordId ? { settlementRecordId: args.settlementRecordId } : {}),
    lines: [
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/** The reverse of liquidityPurchase: Atlas sells pooled crypto to a
 * liquidity partner and the fiat proceeds land in Atlas's own operating
 * account (not yet the identity's — see fiatCredited for that next step).
 * Step 2 of 3 for Convert's crypto->fiat direction. */
export function liquiditySale(args: {
  cryptoSold: Money; // positive, e.g. BTC
  fiatReceived: Money; // positive, e.g. GBP
  settlementRecordId?: string;
}): DraftLedgerTransaction {
  return {
    kind: "LIQUIDITY_SALE",
    memo: `Liquidity sale for settlement ${args.settlementRecordId ?? "n/a"}`,
    ...(args.settlementRecordId ? { settlementRecordId: args.settlementRecordId } : {}),
    lines: [
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.cryptoSold.asset }, amount: args.cryptoSold.negate() },
      { account: { ownerType: "EXTERNAL_LIQUIDITY", ownerId: null, asset: args.cryptoSold.asset }, amount: args.cryptoSold },
      { account: { ownerType: "EXTERNAL_LIQUIDITY", ownerId: null, asset: args.fiatReceived.asset }, amount: args.fiatReceived.negate() },
      { account: { ownerType: "ATLAS_OPERATING", ownerId: null, asset: args.fiatReceived.asset }, amount: args.fiatReceived },
    ],
  };
}

/**
 * Credits the fiat sale proceeds to the identity's own fiat position —
 * deliberately staying inside Atlas rather than paying out to an external
 * bank/card. That's the concrete difference between "Atlas integrates fiat
 * and crypto into one balance" and "Atlas is an exchange that settles
 * trades to the outside world": there is no real payout rail built (the
 * same missing-infrastructure gap as bank funding — see
 * adapters/funding/stub.ts), so rather than fake one, converting crypto
 * back to fiat just leaves you holding a real, ledger-tracked GBP/USD
 * position inside Atlas, exactly the way converting fiat to crypto leaves
 * you holding a crypto position. Step 3 of 3.
 */
export function fiatCredited(args: {
  identityId: string;
  amount: Money; // positive, fiat
  settlementRecordId?: string;
}): DraftLedgerTransaction {
  return {
    kind: "FIAT_CREDITED",
    memo: `Fiat credited to identity ${args.identityId}`,
    ...(args.settlementRecordId ? { settlementRecordId: args.settlementRecordId } : {}),
    lines: [
      { account: { ownerType: "ATLAS_OPERATING", ownerId: null, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/** A funding charge gets clawed back by the card network. This reverses only
 * the FUNDING_RECEIVED leg — it does not and cannot touch whatever the money
 * was already used for, which is exactly why this can leave Atlas net
 * negative: see docs/research/atlas-protocol-research.md §10. */
export function chargebackReversal(args: {
  amount: Money; // positive — the amount being clawed back
  settlementRecordId: string;
}): DraftLedgerTransaction {
  return {
    kind: "CHARGEBACK_REVERSAL",
    memo: `Chargeback reversal for settlement ${args.settlementRecordId}`,
    settlementRecordId: args.settlementRecordId,
    lines: [
      { account: { ownerType: "ATLAS_OPERATING", ownerId: null, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "EXTERNAL_FUNDING", ownerId: null, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/** A HELD position gets unwound before ever being released — the fraud was
 * caught inside the hold window, so the position is pulled back into the
 * custody pool instead of staying with the identity. Atlas still loses the
 * fiat that funded the original liquidity purchase (see chargebackReversal),
 * but does not lose the crypto itself, because it was never released. */
export function holdUnwind(args: {
  identityId: string;
  amount: Money; // positive — must match the original positionAllocation amount
  settlementRecordId: string;
}): DraftLedgerTransaction {
  return {
    kind: "HOLD_UNWIND",
    memo: `Hold unwound for identity ${args.identityId}`,
    settlementRecordId: args.settlementRecordId,
    lines: [
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/** An identity withdraws a released position out of Atlas entirely (e.g. to
 * an external wallet). Leaves the pooled custody account and the system. */
export function withdrawal(args: {
  identityId: string;
  amount: Money; // positive
}): DraftLedgerTransaction {
  return {
    kind: "WITHDRAWAL",
    memo: `Withdrawal for identity ${args.identityId}`,
    lines: [
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/** A SpendToken gets used at a merchant (Transaction B from §10). Same
 * shape as withdrawal() — value leaves the identity's position and returns
 * to the custody pool, ready to be sent onward to whichever merchant the
 * token was used at — kept as a separate transaction kind purely so
 * activity/reporting can tell "spent somewhere" apart from "withdrawn to my
 * own external wallet," which are the same ledger movement but mean
 * different things to the person looking at their activity. */
export function merchantSpend(args: {
  identityId: string;
  amount: Money; // positive
  settlementRecordId?: string;
}): DraftLedgerTransaction {
  return {
    kind: "MERCHANT_SPEND",
    memo: `Merchant spend by identity ${args.identityId}`,
    ...(args.settlementRecordId ? { settlementRecordId: args.settlementRecordId } : {}),
    lines: [
      { account: { ownerType: "IDENTITY", ownerId: args.identityId, asset: args.amount.asset }, amount: args.amount.negate() },
      { account: { ownerType: "ATLAS_CUSTODY_POOL", ownerId: null, asset: args.amount.asset }, amount: args.amount },
    ],
  };
}

/**
 * Computes a balance from a plain list of entries — the reference
 * implementation of "a balance is a sum, not a stored field." Used by
 * services/ledgerService.ts after querying entries from the database, and
 * directly by tests to check invariants without touching Prisma at all.
 */
export function balanceFromEntries(asset: AssetCode, entries: Money[]): Money {
  return sumMoney(asset, entries);
}
