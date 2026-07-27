import { randomUUID } from "node:crypto";
import type { CustodyAdapter } from "./types.js";

/** In-memory stand-in for a real MPC custody provider. See types.ts. */
export class StubCustodyAdapter implements CustodyAdapter {
  private readonly addresses = new Map<string, string>();

  async getOrCreateDepositAddress(args: { identityId: string; asset: string }): Promise<string> {
    const key = `${args.identityId}:${args.asset}`;
    const existing = this.addresses.get(key);
    if (existing) return existing;
    const address = `stub_addr_${args.asset.toLowerCase()}_${randomUUID()}`;
    this.addresses.set(key, address);
    return address;
  }

  async send(args: { asset: string; toAddress: string; amountMinor: bigint }): Promise<{ txRef: string }> {
    return { txRef: `stub_tx_${randomUUID()}` };
  }
}
