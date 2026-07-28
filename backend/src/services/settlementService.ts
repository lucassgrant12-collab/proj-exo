/**
 * Orchestrates a single card-funded crypto purchase end to end: validates
 * the PermissionGrant, charges the funding source, buys the crypto, posts
 * the ledger entries, and holds the resulting position before release. This
 * is the concrete implementation of §10's "buy-then-hold" pattern and the
 * fraud/chargeback economics worked through there — see reverseSettlement
 * below for the part that demonstrates why a late chargeback can leave
 * Atlas net negative even though the ledger always balances.
 */

import type { PrismaClient } from "@prisma/client";
import {
  assertGrantUsable,
  checkAllowance,
  prepareGrant,
  type FundingSourceRef,
  type GrantState,
  type PriorUsage,
} from "../domain/permissionGrant.js";
import { chargebackReversal, fundingReceived, holdUnwind, liquidityPurchase, positionAllocation } from "../domain/ledger.js";
import { Money } from "../domain/money.js";
import type { FundingAdapters } from "../adapters/funding/types.js";
import type { LiquidityAdapter } from "../adapters/liquidity/types.js";
import { LedgerService } from "./ledgerService.js";

const DEFAULT_HOLD_HOURS = 72; // §10: short enough to stay usable, long enough to catch the fast-fraud pattern

export class SettlementService {
  private readonly ledger: LedgerService;

  constructor(
    private readonly db: PrismaClient,
    private readonly funding: FundingAdapters,
    private readonly liquidity: LiquidityAdapter,
  ) {
    this.ledger = new LedgerService(db);
  }

  /**
   * Card-funded crypto purchase. Returns the SettlementRecord id and the
   * amount of crypto allocated (visible to the user immediately — it's the
   * *release*, not the allocation, that's gated by the hold).
   */
  async executeCardFundedCryptoPurchase(args: {
    identityId: string;
    grantId: string;
    fiatAmount: Money;
    cryptoAsset: string;
    holdHours?: number;
  }): Promise<{ settlementRecordId: string; cryptoAllocated: Money }> {
    const grantRow = await this.db.permissionGrant.findUniqueOrThrow({
      where: { id: args.grantId },
      include: { fundingSource: true },
    });

    const fundingSourceRef: FundingSourceRef = {
      id: grantRow.fundingSource.id,
      kind: grantRow.fundingSource.kind,
      rail: grantRow.fundingSource.rail,
      status: grantRow.fundingSource.status,
    };
    prepareGrant(
      {
        identityId: grantRow.identityId,
        fundingSourceId: grantRow.fundingSourceId,
        limit: Money.of(grantRow.limitAsset, grantRow.limitMinor),
        windowSeconds: grantRow.windowSeconds,
        singleUse: grantRow.singleUse,
      },
      fundingSourceRef,
    );

    const grantState: GrantState = {
      id: grantRow.id,
      limit: Money.of(grantRow.limitAsset, grantRow.limitMinor),
      windowSeconds: grantRow.windowSeconds,
      singleUse: grantRow.singleUse,
      status: grantRow.status,
      expiresAt: grantRow.expiresAt,
      createdAt: grantRow.createdAt,
    };
    assertGrantUsable(grantState);

    const windowStart = new Date(Date.now() - grantState.windowSeconds * 1000);
    const priorRecords = await this.db.settlementRecord.findMany({
      where: { grantId: grantRow.id, createdAt: { gte: windowStart }, status: { not: "REVERSED" } },
    });
    const priorUsage: PriorUsage[] = priorRecords.map((r) => ({
      amount: Money.of(r.amountAsset, r.amountMinor),
      at: r.createdAt,
    }));
    checkAllowance(grantState, priorUsage, args.fiatAmount);

    // Transaction A (§10): charge the real funding source.
    const isCard = fundingSourceRef.rail === "CARD_NETWORK";
    const chargeResult = isCard
      ? await this.funding.card.chargeCard({
          fundingSourceExternalRef: grantRow.fundingSource.externalRef,
          amount: args.fiatAmount,
          reference: `grant:${grantRow.id}`,
        })
      : await this.funding.bank.initiateTransfer({
          fundingSourceExternalRef: grantRow.fundingSource.externalRef,
          amount: args.fiatAmount,
          reference: `grant:${grantRow.id}`,
        });

    if (chargeResult.status === "FAILED") {
      throw new Error(`Funding charge failed for grant ${grantRow.id} (ref ${chargeResult.externalRef}).`);
    }

    const holdHours = args.holdHours ?? DEFAULT_HOLD_HOURS;
    const record = await this.db.settlementRecord.create({
      data: {
        grantId: grantRow.id,
        fundingChargeRef: chargeResult.externalRef,
        amountMinor: args.fiatAmount.minorUnits,
        amountAsset: args.fiatAmount.asset,
        status: "PENDING",
        // Bank-linked (PISP) funding doesn't carry card-style dispute risk
        // the same way — see §10 — so there's nothing to hold it against.
        heldUntil: isCard ? new Date(Date.now() + holdHours * 60 * 60 * 1000) : null,
      },
    });

    await this.ledger.post(
      fundingReceived({ identityId: args.identityId, amount: args.fiatAmount, settlementRecordId: record.id }),
    );

    const { cryptoBought } = await this.liquidity.buy({ fiatAmount: args.fiatAmount, cryptoAsset: args.cryptoAsset });

    await this.ledger.post(
      liquidityPurchase({ fiatSpent: args.fiatAmount, cryptoBought, settlementRecordId: record.id }),
    );
    await this.ledger.post(
      positionAllocation({ identityId: args.identityId, amount: cryptoBought, settlementRecordId: record.id }),
    );

    await this.db.settlementRecord.update({
      where: { id: record.id },
      data: { status: isCard ? "HELD" : "RELEASED" },
    });

    return { settlementRecordId: record.id, cryptoAllocated: cryptoBought };
  }

  /** Called once a HELD record's hold window has passed with no dispute —
   * the position becomes freely withdrawable/spendable. */
  async releaseHold(settlementRecordId: string, requestingIdentityId: string): Promise<void> {
    const record = await this.db.settlementRecord.findUniqueOrThrow({
      where: { id: settlementRecordId },
      include: { grant: true },
    });
    if (record.grant.identityId !== requestingIdentityId) {
      throw new Error(`Settlement ${settlementRecordId} does not belong to the requesting identity.`);
    }
    if (record.status !== "HELD") {
      throw new Error(`Settlement ${settlementRecordId} is ${record.status}, not HELD; nothing to release.`);
    }
    await this.db.settlementRecord.update({ where: { id: settlementRecordId }, data: { status: "RELEASED" } });
  }

  /**
   * A funding charge gets disputed. This is the method that makes §10's
   * accounting concrete: what happens depends entirely on whether the
   * position was still HELD (caught in time — Atlas unwinds the crypto and
   * only eats the trading spread) or already RELEASED (too late — the
   * crypto is gone, Atlas eats the full amount). Both paths post a real
   * chargebackReversal against Atlas's operating account; only the HELD
   * path also gets the crypto back.
   */
  async reverseSettlement(args: {
    settlementRecordId: string;
    identityId: string;
    cryptoAsset: string;
  }): Promise<{ recoveredCrypto: boolean }> {
    const record = await this.db.settlementRecord.findUniqueOrThrow({
      where: { id: args.settlementRecordId },
      include: { grant: true },
    });
    // Without this, any identity could reverse *any* settlement it merely
    // knows the id of — since holdUnwind below posts ledger entries against
    // whatever identityId is passed in, that wouldn't just leak data, it
    // would let an attacker move someone else's held position's ledger
    // entries onto their own account.
    if (record.grant.identityId !== args.identityId) {
      throw new Error(`Settlement ${args.settlementRecordId} does not belong to the requesting identity.`);
    }
    if (record.status === "REVERSED") {
      throw new Error(`Settlement ${args.settlementRecordId} was already reversed.`);
    }

    const wasHeld = record.status === "HELD";

    if (wasHeld) {
      // Recover the crypto: pull back the *actual* amount that was
      // allocated (not a fresh purchase at today's rate — the position
      // already exists, it just needs to move back to the pool) out of the
      // identity's position and into ATLAS_CUSTODY_POOL. Whether Atlas later
      // re-sells that recovered crypto is a separate operational decision;
      // it doesn't affect whether the books balance right now.
      const allocated = await this.ledger.positionAllocatedFor(record.id, args.cryptoAsset);
      await this.ledger.post(
        holdUnwind({ identityId: args.identityId, amount: allocated, settlementRecordId: record.id }),
      );
    }

    await this.ledger.post(
      chargebackReversal({
        amount: Money.of(record.amountAsset, record.amountMinor),
        settlementRecordId: record.id,
      }),
    );

    await this.db.settlementRecord.update({ where: { id: record.id }, data: { status: "REVERSED" } });

    return { recoveredCrypto: wasHeld };
  }
}
