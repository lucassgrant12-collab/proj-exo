/**
 * The funding adapter boundary — this is exactly where a real provider
 * integration plugs in later. See §10 of the research doc: bank-rail and
 * card-rail funding are structurally different (PISP vs. merchant-of-record),
 * which is why they're two separate interfaces rather than one generic
 * "charge a source" method that would paper over that difference.
 */

import { Money } from "../../domain/money.js";

export interface ChargeResult {
  /** Opaque reference to the real charge/transfer at the provider. Stored on
   * SettlementRecord.fundingChargeRef — never a raw card/account number. */
  externalRef: string;
  status: "PENDING" | "CONFIRMED" | "FAILED";
}

/**
 * Bank-linked funding via Open Banking payment initiation (PISP). A real
 * implementation talks to a provider like TrueLayer, Tink, or Plaid's UK/EU
 * Open Banking product. Atlas's own account is never a hop in this path —
 * see FundingRail.PISP in the Prisma schema and §10's explanation of why
 * that's a real, not cosmetic, distinction.
 */
export interface BankFundingAdapter {
  initiateTransfer(args: {
    fundingSourceExternalRef: string;
    amount: Money;
    reference: string;
  }): Promise<ChargeResult>;

  checkStatus(externalRef: string): Promise<ChargeResult["status"]>;
}

/**
 * Card-linked funding. A real implementation talks to a processor (Stripe,
 * Adyen) or a card-issuing platform (Marqeta, Lithic) for the SpendToken
 * side. Atlas (or its processor, acting for it) is unavoidably the merchant
 * of record for charges made through this adapter — see §10.
 */
export interface CardFundingAdapter {
  chargeCard(args: {
    fundingSourceExternalRef: string;
    amount: Money;
    reference: string;
  }): Promise<ChargeResult>;

  /** Card charges can be disputed long after they're made; a real
   * implementation subscribes to the provider's dispute/chargeback webhooks
   * rather than polling. This method exists so callers (and tests) have an
   * explicit seam to simulate that happening. */
  checkStatus(externalRef: string): Promise<ChargeResult["status"] | "DISPUTED">;
}

export interface FundingAdapters {
  bank: BankFundingAdapter;
  card: CardFundingAdapter;
}
