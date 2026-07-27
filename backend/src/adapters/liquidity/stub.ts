import { Money } from "../../domain/money.js";
import type { LiquidityAdapter, LiquidityQuote } from "./types.js";

/** Illustrative fixed rates (fiat per whole unit of crypto), matching the
 * prototype's demo rates for continuity. A real implementation queries a
 * live exchange/market-maker instead of a static table. */
const ILLUSTRATIVE_RATES: Record<string, number> = {
  BTC: 51000,
  ETH: 2800,
  USDC: 0.79,
};

/** In-memory stand-in for a real liquidity provider. See types.ts. */
export class StubLiquidityAdapter implements LiquidityAdapter {
  async getQuote(args: { fiatAsset: string; cryptoAsset: string }): Promise<LiquidityQuote> {
    const rate = ILLUSTRATIVE_RATES[args.cryptoAsset];
    if (rate === undefined) throw new Error(`No illustrative rate configured for ${args.cryptoAsset}`);
    return {
      fiatAsset: args.fiatAsset,
      cryptoAsset: args.cryptoAsset,
      rateMinorPerMinor: rate,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  async buy(args: { fiatAmount: Money; cryptoAsset: string }): Promise<{ cryptoBought: Money }> {
    const rate = ILLUSTRATIVE_RATES[args.cryptoAsset];
    if (rate === undefined) throw new Error(`No illustrative rate configured for ${args.cryptoAsset}`);
    const fiatWhole = Number(args.fiatAmount.toDecimalString());
    const cryptoWhole = fiatWhole / rate;
    return { cryptoBought: Money.fromDecimalString(args.cryptoAsset, cryptoWhole.toFixed(8)) };
  }

  async sell(args: { cryptoAmount: Money; fiatAsset: string }): Promise<{ fiatReceived: Money }> {
    const rate = ILLUSTRATIVE_RATES[args.cryptoAmount.asset];
    if (rate === undefined) throw new Error(`No illustrative rate configured for ${args.cryptoAmount.asset}`);
    const cryptoWhole = Number(args.cryptoAmount.toDecimalString());
    const fiatWhole = cryptoWhole * rate;
    return { fiatReceived: Money.fromDecimalString(args.fiatAsset, fiatWhole.toFixed(2)) };
  }
}
