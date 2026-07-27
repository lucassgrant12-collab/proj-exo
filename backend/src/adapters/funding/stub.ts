/**
 * In-memory stand-ins for the real funding rails. These let the rest of the
 * codebase (services, API, tests) be written and exercised end-to-end today,
 * without a Stripe/TrueLayer/Marqeta account existing yet. Nothing here
 * talks to a network. Swap these for real adapter implementations behind
 * the same interface — nothing above this layer should need to change when
 * that happens.
 */

import { randomUUID } from "node:crypto";
import type { BankFundingAdapter, CardFundingAdapter, ChargeResult } from "./types.js";

export class StubBankFundingAdapter implements BankFundingAdapter {
  private readonly charges = new Map<string, ChargeResult["status"]>();

  async initiateTransfer(): Promise<ChargeResult> {
    const externalRef = `stub_bank_${randomUUID()}`;
    this.charges.set(externalRef, "CONFIRMED"); // PISP transfers confirm fast in practice
    return { externalRef, status: "CONFIRMED" };
  }

  async checkStatus(externalRef: string): Promise<ChargeResult["status"]> {
    return this.charges.get(externalRef) ?? "FAILED";
  }
}

export class StubCardFundingAdapter implements CardFundingAdapter {
  private readonly charges = new Map<string, ChargeResult["status"] | "DISPUTED">();

  async chargeCard(): Promise<ChargeResult> {
    const externalRef = `stub_card_${randomUUID()}`;
    this.charges.set(externalRef, "CONFIRMED");
    return { externalRef, status: "CONFIRMED" };
  }

  async checkStatus(externalRef: string): Promise<ChargeResult["status"] | "DISPUTED"> {
    return this.charges.get(externalRef) ?? "FAILED";
  }

  /** Test/demo-only seam: simulate a card network dispute landing on a
   * previously confirmed charge, the way a real webhook would weeks later. */
  simulateDispute(externalRef: string): void {
    this.charges.set(externalRef, "DISPUTED");
  }
}
