import { describe, expect, it } from "vitest";
import {
  assertBalanced,
  chargebackReversal,
  fundingReceived,
  holdUnwind,
  liquidityPurchase,
  positionAllocation,
  UnbalancedTransactionError,
  type DraftLedgerTransaction,
} from "../src/domain/ledger.js";
import { Money, sumMoney } from "../src/domain/money.js";

function balanceOf(
  transactions: DraftLedgerTransaction[],
  ownerType: string,
  ownerId: string | null,
  asset: string,
): Money {
  const amounts: Money[] = [];
  for (const tx of transactions) {
    for (const line of tx.lines) {
      if (
        line.account.ownerType === ownerType &&
        line.account.ownerId === ownerId &&
        line.amount.asset === asset
      ) {
        amounts.push(line.amount);
      }
    }
  }
  return sumMoney(asset, amounts);
}

describe("ledger invariants", () => {
  it("every builder produces a balanced transaction", () => {
    const settlementRecordId = "settlement_1";
    const gbp1000 = Money.fromDecimalString("GBP", "1000.00");
    const btc = Money.fromDecimalString("BTC", "0.0196");

    const drafts = [
      fundingReceived({ identityId: "id_1", amount: gbp1000, settlementRecordId }),
      liquidityPurchase({ fiatSpent: gbp1000, cryptoBought: btc, settlementRecordId }),
      positionAllocation({ identityId: "id_1", amount: btc, settlementRecordId }),
      chargebackReversal({ amount: gbp1000, settlementRecordId }),
      holdUnwind({ identityId: "id_1", amount: btc, settlementRecordId }),
    ];

    for (const draft of drafts) {
      expect(() => assertBalanced(draft.lines)).not.toThrow();
    }
  });

  it("rejects a transaction that doesn't sum to zero", () => {
    const bad = [
      { account: { ownerType: "ATLAS_OPERATING" as const, ownerId: null, asset: "GBP" }, amount: Money.fromDecimalString("GBP", "10.00") },
      { account: { ownerType: "EXTERNAL_FUNDING" as const, ownerId: null, asset: "GBP" }, amount: Money.fromDecimalString("GBP", "-9.99") },
    ];
    expect(() => assertBalanced(bad)).toThrow(UnbalancedTransactionError);
  });

  it(
    "reproduces the §10 fraud scenario numerically: a card-funded crypto purchase " +
      "followed by a chargeback after the position was already released leaves Atlas " +
      "net negative by exactly the stolen amount, even though every transaction balances",
    () => {
      const settlementRecordId = "settlement_fraud";
      const identityId = "thief_identity"; // in reality, a fresh, disposable Atlas identity — see §10
      const stolen = Money.fromDecimalString("GBP", "1000.00");
      const btcBought = Money.fromDecimalString("BTC", "0.0196");

      // Day 0: card charged, crypto bought and allocated, thief moves it away.
      const day0: DraftLedgerTransaction[] = [
        fundingReceived({ identityId, amount: stolen, settlementRecordId }),
        liquidityPurchase({ fiatSpent: stolen, cryptoBought: btcBought, settlementRecordId }),
        positionAllocation({ identityId, amount: btcBought, settlementRecordId }),
      ];
      for (const tx of day0) assertBalanced(tx.lines);

      // At this point Atlas's operating account is flat: +1000 in, -1000 out to liquidity.
      const operatingAfterDay0 = balanceOf(day0, "ATLAS_OPERATING", null, "GBP");
      expect(operatingAfterDay0.toDecimalString()).toBe("0.00");

      // Day 30: chargeback approved. The position already left — see §10 — so
      // there is no holdUnwind here, only the reversal of the funding leg.
      const day30: DraftLedgerTransaction[] = [
        chargebackReversal({ amount: stolen, settlementRecordId }),
      ];
      for (const tx of day30) assertBalanced(tx.lines);

      const operatingTotal = balanceOf([...day0, ...day30], "ATLAS_OPERATING", null, "GBP");
      expect(operatingTotal.toDecimalString()).toBe("-1000.00");

      // The thief's position was never clawed back — it was already gone.
      const identityPosition = balanceOf([...day0, ...day30], "IDENTITY", identityId, "BTC");
      expect(identityPosition.toDecimalString()).toBe(btcBought.toDecimalString());
    },
  );

  it(
    "the same fraud caught inside the hold window (§10 'buy-then-hold') recovers the " +
      "crypto asset itself instead of losing it entirely — the fiat leg is still down " +
      "until Atlas actually re-sells the recovered position, which is a deliberately " +
      "separate step (see settlementService.reverseSettlement's comment)",
    () => {
      const settlementRecordId = "settlement_caught";
      const identityId = "thief_identity_2";
      const stolen = Money.fromDecimalString("GBP", "1000.00");
      const btcBought = Money.fromDecimalString("BTC", "0.0196");

      const allTx: DraftLedgerTransaction[] = [
        fundingReceived({ identityId, amount: stolen, settlementRecordId }),
        liquidityPurchase({ fiatSpent: stolen, cryptoBought: btcBought, settlementRecordId }),
        positionAllocation({ identityId, amount: btcBought, settlementRecordId }),
        // Caught before release: the position never actually left the identity's
        // Atlas balance for an external wallet, so it can still be unwound.
        holdUnwind({ identityId, amount: btcBought, settlementRecordId }),
        chargebackReversal({ amount: stolen, settlementRecordId }),
      ];
      for (const tx of allTx) assertBalanced(tx.lines);

      const identityPosition = balanceOf(allTx, "IDENTITY", identityId, "BTC");
      expect(identityPosition.toDecimalString()).toBe("0.00000000"); // recovered

      const custodyPool = balanceOf(allTx, "ATLAS_CUSTODY_POOL", null, "BTC");
      expect(custodyPool.toDecimalString()).toBe(btcBought.toDecimalString()); // sitting in the pool, Atlas's to re-sell

      // The fiat operating account is down £1000 here too — identical to the
      // "too late" case at this point. holdUnwind only moves the crypto leg
      // back; it deliberately does not also sell it, so the two scenarios
      // only diverge once Atlas actually liquidates the recovered BTC. The
      // real difference "caught in time" buys is optionality: Atlas holds a
      // sellable asset instead of nothing, not an automatic fix.
      const operatingTotal = balanceOf(allTx, "ATLAS_OPERATING", null, "GBP");
      expect(operatingTotal.toDecimalString()).toBe("-1000.00");
    },
  );
});
