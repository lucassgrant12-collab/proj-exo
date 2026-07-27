/**
 * Persists DraftLedgerTransactions produced by domain/ledger.ts. This is the
 * only place in the codebase allowed to write to ledger_transactions /
 * ledger_entries — every other service goes through here, so the balance
 * invariant (assertBalanced) can never be bypassed by a shortcut written
 * somewhere else later.
 */

import type { PrismaClient } from "@prisma/client";
import {
  accountKey,
  assertBalanced,
  balanceFromEntries,
  type DraftLedgerTransaction,
  type LedgerAccountRef,
} from "../domain/ledger.js";
import { Money } from "../domain/money.js";

export class LedgerService {
  constructor(private readonly db: PrismaClient) {}

  /** Finds or creates the LedgerAccount row for a given account reference.
   * Accounts are created lazily on first use rather than provisioned ahead
   * of time — see the unique constraint on (ownerType, ownerId, assetCode)
   * in the Prisma schema, which is what actually prevents duplicates under
   * concurrent access. */
  private async findOrCreateAccount(ref: LedgerAccountRef) {
    return this.db.ledgerAccount.upsert({
      where: {
        ownerType_ownerId_assetCode: {
          ownerType: ref.ownerType,
          ownerId: ref.ownerId ?? "",
          assetCode: ref.asset,
        },
      },
      create: {
        ownerType: ref.ownerType,
        ownerId: ref.ownerId,
        assetCode: ref.asset,
      },
      update: {},
    });
  }

  /** Posts a draft transaction atomically: re-validates balance, resolves
   * every account, writes the transaction and all its entries in a single
   * DB transaction. Throws UnbalancedTransactionError (from domain/ledger.ts)
   * before touching the database at all if the draft doesn't balance. */
  async post(draft: DraftLedgerTransaction): Promise<{ transactionId: string }> {
    assertBalanced(draft.lines);

    return this.db.$transaction(async (tx) => {
      const accounts = await Promise.all(
        draft.lines.map((line) =>
          tx.ledgerAccount.upsert({
            where: {
              ownerType_ownerId_assetCode: {
                ownerType: line.account.ownerType,
                ownerId: line.account.ownerId ?? "",
                assetCode: line.account.asset,
              },
            },
            create: {
              ownerType: line.account.ownerType,
              ownerId: line.account.ownerId,
              assetCode: line.account.asset,
            },
            update: {},
          }),
        ),
      );

      const created = await tx.ledgerTransaction.create({
        data: {
          kind: draft.kind,
          memo: draft.memo,
          settlementRecordId: draft.settlementRecordId ?? null,
          entries: {
            create: draft.lines.map((line, i) => ({
              accountId: (accounts[i] as { id: string }).id,
              amountMinor: line.amount.minorUnits,
            })),
          },
        },
      });

      return { transactionId: created.id };
    });
  }

  /** An identity's balance for one asset — always computed as a sum over
   * every entry ever posted to their account, never read from a stored
   * field. This is the direct, checkable answer to "balances shouldn't be
   * treated as a pooled value": ask the ledger, don't trust a cached number. */
  async balanceOf(identityId: string, asset: string): Promise<Money> {
    const account = await this.db.ledgerAccount.findUnique({
      where: {
        ownerType_ownerId_assetCode: { ownerType: "IDENTITY", ownerId: identityId, assetCode: asset },
      },
      include: { entries: true },
    });
    if (!account) return Money.zero(asset);
    const amounts = account.entries.map((e) => Money.of(asset, e.amountMinor));
    return balanceFromEntries(asset, amounts);
  }

  /** How much of `asset` was allocated to an identity by the
   * POSITION_ALLOCATION transaction tied to a specific settlement record.
   * Used to unwind a hold with the *actual* amount that was given out,
   * rather than re-pricing at whatever the market rate is by the time a
   * reversal happens — see settlementService.reverseSettlement. */
  async positionAllocatedFor(settlementRecordId: string, asset: string): Promise<Money> {
    const transaction = await this.db.ledgerTransaction.findFirst({
      where: { settlementRecordId, kind: "POSITION_ALLOCATION" },
      include: { entries: { include: { account: true } } },
    });
    if (!transaction) return Money.zero(asset);
    const identityEntries = transaction.entries.filter(
      (e) => e.account.ownerType === "IDENTITY" && e.account.assetCode === asset,
    );
    return balanceFromEntries(asset, identityEntries.map((e) => Money.of(asset, e.amountMinor)));
  }

  /** System-account balances (Atlas operating cash, custody pool) — useful
   * for the smoke test and for real operational monitoring later: the
   * custody pool balance should always equal the sum of every identity's
   * position in that asset, which is a checkable reconciliation, not an
   * assumption. */
  async systemBalance(
    ownerType: "ATLAS_OPERATING" | "ATLAS_CUSTODY_POOL" | "EXTERNAL_FUNDING" | "EXTERNAL_LIQUIDITY",
    asset: string,
  ): Promise<Money> {
    const account = await this.db.ledgerAccount.findUnique({
      where: { ownerType_ownerId_assetCode: { ownerType, ownerId: "", assetCode: asset } },
      include: { entries: true },
    });
    if (!account) return Money.zero(asset);
    const amounts = account.entries.map((e) => Money.of(asset, e.amountMinor));
    return balanceFromEntries(asset, amounts);
  }
}
