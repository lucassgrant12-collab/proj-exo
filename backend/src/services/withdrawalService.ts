/**
 * Moving a released position out of Atlas to an external address. This is
 * deliberately separate from SettlementService — withdrawal only touches a
 * position that's already RELEASED (see §10's hold pattern); it has nothing
 * to do with funding, permission grants, or liquidity.
 */

import type { PrismaClient } from "@prisma/client";
import { withdrawal } from "../domain/ledger.js";
import { Money } from "../domain/money.js";
import type { CustodyAdapter } from "../adapters/custody/types.js";
import { LedgerService } from "./ledgerService.js";

export class InsufficientBalanceError extends Error {}

export class WithdrawalService {
  private readonly ledger: LedgerService;

  constructor(private readonly db: PrismaClient, private readonly custody: CustodyAdapter) {
    this.ledger = new LedgerService(db);
  }

  async withdraw(args: { identityId: string; amount: Money; toAddress: string }): Promise<{ txRef: string }> {
    const balance = await this.ledger.balanceOf(args.identityId, args.amount.asset);
    if (args.amount.greaterThan(balance)) {
      throw new InsufficientBalanceError(
        `Identity ${args.identityId} has ${balance.toString()}, cannot withdraw ${args.amount.toString()}.`,
      );
    }

    // Move the position out of the identity's Atlas balance first — if the
    // external send then fails, that's a real operational incident to
    // reconcile, not something silently swallowed by trying the send before
    // the books reflect the attempt.
    await this.ledger.post(withdrawal({ identityId: args.identityId, amount: args.amount }));

    const result = await this.custody.send({
      asset: args.amount.asset,
      toAddress: args.toAddress,
      amountMinor: args.amount.minorUnits,
    });

    return result;
  }
}
