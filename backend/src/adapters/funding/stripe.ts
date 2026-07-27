/**
 * The real card-funding adapter — everything in the last stretch of
 * conversation about how Stripe actually fits in, as working code.
 *
 * `fundingSourceExternalRef` is a composite `${stripeCustomerId}:${stripePaymentMethodId}`,
 * set when a card is connected — the card itself is captured client-side via
 * Stripe Elements (never touches Atlas's servers) and Atlas only ever
 * receives back the PaymentMethod id Stripe hands over, which is what
 * `FundingSourceService.connect` stores as `externalRef`. This adapter never
 * sees a raw card number, only Stripe's own tokenized references to it.
 *
 * Requires apiVersion pinning — Stripe's API is versioned and can change
 * shape between releases; pinning avoids a Stripe-side update silently
 * changing behavior here.
 */

import Stripe from "stripe";
import type { CardFundingAdapter, ChargeResult } from "./types.js";
import type { Money } from "../../domain/money.js";

const STRIPE_API_VERSION = "2024-06-20" as const;

export class StripeCardFundingAdapter implements CardFundingAdapter {
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  }

  private parseRef(fundingSourceExternalRef: string): { customerId: string; paymentMethodId: string } {
    const [customerId, paymentMethodId] = fundingSourceExternalRef.split(":");
    if (!customerId || !paymentMethodId) {
      throw new Error(`Malformed Stripe funding source reference: "${fundingSourceExternalRef}" (expected "cus_xxx:pm_xxx").`);
    }
    return { customerId, paymentMethodId };
  }

  private toStripeAmount(amount: Money): number {
    // Stripe wants the amount in the currency's smallest unit for standard
    // (2-decimal) currencies, which lines up with our minor-units
    // convention for GBP/USD. This does *not* generalize to zero-decimal
    // currencies (e.g. JPY) without adjustment — not a concern for the
    // fiat assets this system currently funds from, but worth flagging
    // before adding one that isn't 2-decimal.
    const asNumber = Number(amount.minorUnits);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error(`Amount ${amount.toString()} is too large to represent safely for Stripe's API.`);
    }
    return asNumber;
  }

  async chargeCard(args: { fundingSourceExternalRef: string; amount: Money; reference: string }): Promise<ChargeResult> {
    const { customerId, paymentMethodId } = this.parseRef(args.fundingSourceExternalRef);

    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: this.toStripeAmount(args.amount),
        currency: args.amount.asset.toLowerCase(),
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true, // the cardholder isn't present — this is Atlas-initiated, per the permission grant
        confirm: true,
        metadata: { atlasReference: args.reference },
      });

      return {
        externalRef: intent.id,
        status: intent.status === "succeeded" ? "CONFIRMED" : intent.status === "processing" ? "PENDING" : "FAILED",
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        // Declined, insufficient funds, etc. — a real failure, not a bug.
        return { externalRef: err.payment_intent?.id ?? `stripe_error_${Date.now()}`, status: "FAILED" };
      }
      throw err;
    }
  }

  async checkStatus(externalRef: string): Promise<ChargeResult["status"] | "DISPUTED"> {
    const intent = await this.stripe.paymentIntents.retrieve(externalRef);

    if (intent.status !== "succeeded") {
      return intent.status === "processing" ? "PENDING" : "FAILED";
    }

    const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
    if (chargeId) {
      const charge = await this.stripe.charges.retrieve(chargeId);
      if (charge.disputed) return "DISPUTED";
    }
    return "CONFIRMED";
  }
}
