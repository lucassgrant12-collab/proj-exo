import { describe, expect, it } from "vitest";
import { Money } from "../src/domain/money.js";

describe("Money", () => {
  it("parses decimal strings into exact minor units", () => {
    expect(Money.fromDecimalString("GBP", "12.50").minorUnits).toBe(1250n);
    expect(Money.fromDecimalString("BTC", "0.00000001").minorUnits).toBe(1n);
    expect(Money.fromDecimalString("GBP", "-3.20").minorUnits).toBe(-320n);
  });

  it("round-trips decimal string -> minor units -> decimal string", () => {
    expect(Money.fromDecimalString("GBP", "1000.00").toDecimalString()).toBe("1000.00");
    expect(Money.fromDecimalString("USDC", "0.5").toDecimalString()).toBe("0.500000");
  });

  it("rejects more precision than the asset supports", () => {
    expect(() => Money.fromDecimalString("GBP", "1.005")).toThrow(/more precision/);
  });

  it("refuses to combine different assets", () => {
    const gbp = Money.fromDecimalString("GBP", "10");
    const btc = Money.fromDecimalString("BTC", "1");
    expect(() => gbp.plus(btc)).toThrow(/Cannot combine/);
  });

  it("arithmetic is exact, not float-approximate", () => {
    // 0.1 + 0.2 === 0.3 fails with floats; this must not.
    const a = Money.fromDecimalString("GBP", "0.10");
    const b = Money.fromDecimalString("GBP", "0.20");
    expect(a.plus(b).toDecimalString()).toBe("0.30");
  });

  it("rejects non-integer minor units from Money.of", () => {
    expect(() => Money.of("GBP", 10.5)).toThrow(/non-integer/);
  });
});
