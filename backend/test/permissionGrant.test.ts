import { describe, expect, it } from "vitest";
import {
  assertGrantUsable,
  checkAllowance,
  GrantNotUsableError,
  InvalidGrantError,
  prepareGrant,
  type GrantState,
} from "../src/domain/permissionGrant.js";
import { Money } from "../src/domain/money.js";

const activeCardSource = { id: "src_1", kind: "CARD" as const, rail: "CARD_NETWORK" as const, status: "ACTIVE" as const };

function makeGrant(overrides: Partial<GrantState> = {}): GrantState {
  return {
    id: "grant_1",
    limit: Money.fromDecimalString("GBP", "100.00"),
    windowSeconds: 86400,
    singleUse: false,
    status: "ACTIVE",
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("permission grant validation", () => {
  it("refuses to prepare a grant against a revoked funding source", () => {
    expect(() =>
      prepareGrant(
        { identityId: "id_1", fundingSourceId: "src_1", limit: Money.fromDecimalString("GBP", "10"), windowSeconds: 60, singleUse: false },
        { ...activeCardSource, status: "REVOKED" },
      ),
    ).toThrow(InvalidGrantError);
  });

  it("refuses to prepare a grant against a connected wallet — attestation only, never a funding path", () => {
    expect(() =>
      prepareGrant(
        { identityId: "id_1", fundingSourceId: "src_2", limit: Money.fromDecimalString("GBP", "10"), windowSeconds: 60, singleUse: false },
        { id: "src_2", kind: "WALLET", rail: "ONCHAIN", status: "ACTIVE" },
      ),
    ).toThrow(/attestations, not funding sources/);
  });

  it("rejects a revoked or expired grant as unusable", () => {
    expect(() => assertGrantUsable(makeGrant({ status: "REVOKED" }))).toThrow(GrantNotUsableError);
    expect(() => assertGrantUsable(makeGrant({ expiresAt: new Date(Date.now() - 1000) }))).toThrow(GrantNotUsableError);
    expect(() => assertGrantUsable(makeGrant())).not.toThrow();
  });

  it("allows spending up to, but not beyond, the remaining allowance in the window", () => {
    const grant = makeGrant({ limit: Money.fromDecimalString("GBP", "100.00") });
    const priorUsage = [{ amount: Money.fromDecimalString("GBP", "60.00"), at: new Date() }];

    expect(() => checkAllowance(grant, priorUsage, Money.fromDecimalString("GBP", "40.00"))).not.toThrow();
    expect(() => checkAllowance(grant, priorUsage, Money.fromDecimalString("GBP", "40.01"))).toThrow(GrantNotUsableError);
  });

  it("enforces single-use grants strictly — any prior usage blocks a second spend", () => {
    const grant = makeGrant({ singleUse: true });
    const oneUse = [{ amount: Money.fromDecimalString("GBP", "1.00"), at: new Date() }];
    expect(() => checkAllowance(grant, oneUse, Money.fromDecimalString("GBP", "0.01"))).toThrow(/single-use/);
    expect(() => checkAllowance(grant, [], Money.fromDecimalString("GBP", "100.00"))).not.toThrow();
  });
});
