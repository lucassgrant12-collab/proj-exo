/**
 * The liquidity boundary — where a real exchange API or a provider like
 * Circle plugs in for fiat<->crypto conversion. See §10: this is
 * deliberately per-transaction execution against a live market, not a
 * standing inventory Atlas holds and hopes matches demand.
 */

import { Money } from "../../domain/money.js";

export interface LiquidityQuote {
  fiatAsset: string;
  cryptoAsset: string;
  rateMinorPerMinor: number; // illustrative only — a real integration returns a precise, provider-quoted rate
  expiresAt: Date;
}

export interface LiquidityAdapter {
  getQuote(args: { fiatAsset: string; cryptoAsset: string }): Promise<LiquidityQuote>;

  /** Executes a real purchase: spends `fiatAmount`, returns the crypto
   * actually bought. A real implementation places this against a live
   * exchange order book or a market maker — the returned amount can
   * legitimately differ slightly from a prior quote (slippage). */
  buy(args: { fiatAmount: Money; cryptoAsset: string }): Promise<{ cryptoBought: Money }>;

  /** The inverse — used when a HELD position needs to be unwound (§10's
   * "buy-then-hold" pattern): sell back the crypto that was bought for a
   * position that turned out to be fraudulent before release. */
  sell(args: { cryptoAmount: Money; fiatAsset: string }): Promise<{ fiatReceived: Money }>;
}
