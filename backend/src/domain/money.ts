/**
 * Money is always an integer count of an asset's minor units (pence, satoshis,
 * USDC's 6-decimal base units, ...), carried as a bigint. Never a float.
 * Floats cannot represent most decimal fractions exactly, and a financial
 * ledger that's occasionally off by a fraction of a penny is not a ledger,
 * it's a bug generator. Every function here is exact.
 */

export type AssetCode = string;

export interface AssetDefinition {
  code: AssetCode;
  decimals: number;
  kind: "FIAT" | "CRYPTO";
}

/** The assets this codebase knows about. Adding one is a one-line change here
 * plus a matching row in the `assets` table (see prisma/schema.prisma). */
export const ASSETS: Record<AssetCode, AssetDefinition> = {
  GBP: { code: "GBP", decimals: 2, kind: "FIAT" },
  USD: { code: "USD", decimals: 2, kind: "FIAT" },
  BTC: { code: "BTC", decimals: 8, kind: "CRYPTO" },
  ETH: { code: "ETH", decimals: 18, kind: "CRYPTO" },
  USDC: { code: "USDC", decimals: 6, kind: "CRYPTO" },
};

export function assetOf(code: AssetCode): AssetDefinition {
  const asset = ASSETS[code];
  if (!asset) throw new Error(`Unknown asset code: ${code}`);
  return asset;
}

/** A signed amount of a specific asset, in minor units. */
export class Money {
  private constructor(
    public readonly asset: AssetCode,
    public readonly minorUnits: bigint,
  ) {}

  static of(asset: AssetCode, minorUnits: bigint | number): Money {
    const units = typeof minorUnits === "number" ? BigInt(Math.trunc(minorUnits)) : minorUnits;
    if (typeof minorUnits === "number" && !Number.isInteger(minorUnits)) {
      throw new Error(
        `Money.of received a non-integer number (${minorUnits}) for ${asset}. ` +
          "Minor units must always be a whole number — convert from a decimal amount with Money.fromDecimalString instead.",
      );
    }
    assetOf(asset); // throws on unknown asset
    return new Money(asset, units);
  }

  /** Parse a human decimal string ("12.50") into exact minor units for the asset. */
  static fromDecimalString(asset: AssetCode, decimal: string): Money {
    const { decimals } = assetOf(asset);
    const negative = decimal.trim().startsWith("-");
    const unsigned = decimal.trim().replace(/^-/, "");
    const [whole = "0", frac = ""] = unsigned.split(".");
    if (frac.length > decimals) {
      throw new Error(
        `${decimal} has more precision than ${asset} supports (${decimals} decimal places).`,
      );
    }
    const fracPadded = frac.padEnd(decimals, "0");
    const minorUnits = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
    return Money.of(asset, negative ? -minorUnits : minorUnits);
  }

  static zero(asset: AssetCode): Money {
    return Money.of(asset, 0n);
  }

  toDecimalString(): string {
    const { decimals } = assetOf(this.asset);
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const s = abs.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, s.length - decimals);
    const frac = decimals > 0 ? "." + s.slice(s.length - decimals) : "";
    return (negative ? "-" : "") + whole + frac;
  }

  private assertSameAsset(other: Money): void {
    if (other.asset !== this.asset) {
      throw new Error(`Cannot combine ${this.asset} and ${other.asset} directly — convert first.`);
    }
  }

  plus(other: Money): Money {
    this.assertSameAsset(other);
    return Money.of(this.asset, this.minorUnits + other.minorUnits);
  }

  minus(other: Money): Money {
    this.assertSameAsset(other);
    return Money.of(this.asset, this.minorUnits - other.minorUnits);
  }

  negate(): Money {
    return Money.of(this.asset, -this.minorUnits);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameAsset(other);
    if (this.minorUnits === other.minorUnits) return 0;
    return this.minorUnits > other.minorUnits ? 1 : -1;
  }

  greaterThan(other: Money): boolean {
    return this.compareTo(other) === 1;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.asset}`;
  }
}

export function sumMoney(asset: AssetCode, amounts: Money[]): Money {
  return amounts.reduce((total, m) => total.plus(m), Money.zero(asset));
}
