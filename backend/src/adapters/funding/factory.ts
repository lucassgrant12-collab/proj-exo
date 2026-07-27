/**
 * Picks real vs. stub adapters based on whether credentials are configured.
 * This is the one place that decision gets made — routes and services never
 * import stub.ts or stripe.ts directly, only this factory, so the swap from
 * stub to real (or back, for local dev without hitting Stripe) is a config
 * change, not a code change.
 *
 * The bank/PISP side has no real implementation yet — no Open Banking
 * provider account exists — so it's always the stub for now. See README.md.
 */

import type { FundingAdapters } from "./types.js";
import { StubBankFundingAdapter, StubCardFundingAdapter } from "./stub.js";
import { StripeCardFundingAdapter } from "./stripe.js";

export function buildFundingAdapters(): FundingAdapters {
  const stripeKey = process.env["STRIPE_SECRET_KEY"];

  return {
    bank: new StubBankFundingAdapter(),
    card: stripeKey ? new StripeCardFundingAdapter(stripeKey) : new StubCardFundingAdapter(),
  };
}
