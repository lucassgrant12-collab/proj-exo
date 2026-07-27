/**
 * The custody boundary — where a real MPC/threshold wallet provider (Turnkey,
 * Privy, Fireblocks) plugs in. See §9 of the research doc: the point of MPC
 * custody is that no single party, including Atlas, ever holds a complete
 * signing key. This interface only exposes what the rest of the system
 * needs (an address to receive into, and a signed send) — it deliberately
 * does not expose raw key material, so that constraint holds no matter which
 * provider implements it.
 */

export interface CustodyAdapter {
  /** Returns (creating if necessary) the deposit address this identity's
   * position in a given asset should be tracked against at the custody
   * provider. Note this is about the *real* underlying custody wallet, which
   * may be pooled — see prisma schema's ATLAS_CUSTODY_POOL account and
   * ledger.ts's comment on why pooled custody underneath is fine as long as
   * the accounting layer stays per-identity. */
  getOrCreateDepositAddress(args: { identityId: string; asset: string }): Promise<string>;

  /** Signs and broadcasts a send from Atlas's custody to an external
   * address — used for withdrawals. A real implementation cooperates with
   * the identity's device-held key share; it does not hold a complete key
   * on its own. */
  send(args: { asset: string; toAddress: string; amountMinor: bigint }): Promise<{ txRef: string }>;
}
