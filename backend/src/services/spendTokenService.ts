/**
 * Issuing and redeeming SpendTokens via real RSA blind signatures
 * (domain/blindSignature.ts). Two methods here run steps that, in a real
 * deployment with a separate client app, would happen on the user's device
 * — `demoClientBlind` and `demoClientUnblind` — kept here only so the full
 * protocol can be exercised end to end without one yet. They're clearly
 * named and documented as the client half; nothing server-side calls them
 * as part of `issue` or `redeem`.
 *
 * Honest limitation, stated once here and not repeated everywhere it
 * matters: the issuer key (`d`, the private exponent) lives in this
 * process's memory only, generated fresh on first use — it is not persisted
 * or recoverable across a restart. A real deployment keeps this in a KMS.
 * See README.
 */

import type { PrismaClient } from "@prisma/client";
import {
  blind,
  createRandomTokenMessage,
  generateIssuerKeyPair,
  hexToMessage,
  messageToHex,
  publicKeyOf,
  unblind,
  verify,
  type IssuerKeyPair,
  type IssuerPublicKey,
} from "../domain/blindSignature.js";
import { blindSign as issuerBlindSign } from "../domain/blindSignature.js";
import { tokenHashFor, type SpendTokenForm } from "../domain/spendToken.js";
import { assertGrantUsable, checkAllowance, type GrantState, type PriorUsage } from "../domain/permissionGrant.js";
import { merchantSpend } from "../domain/ledger.js";
import { Money } from "../domain/money.js";
import { LedgerService } from "./ledgerService.js";

let cachedIssuerKey: IssuerKeyPair | null = null;

export class TokenAlreadyRedeemedError extends Error {}
export class InvalidTokenSignatureError extends Error {}

export class SpendTokenService {
  private readonly ledger: LedgerService;

  constructor(private readonly db: PrismaClient) {
    this.ledger = new LedgerService(db);
  }

  /** Generated once per process, on first use. Only the public parameters
   * (n, e) ever get persisted — see the file comment on why the private
   * exponent staying in memory is a deliberate, documented limitation here
   * rather than an oversight. */
  async getIssuerKey(): Promise<IssuerKeyPair> {
    if (cachedIssuerKey) return cachedIssuerKey;
    cachedIssuerKey = generateIssuerKeyPair();
    const pub = publicKeyOf(cachedIssuerKey);
    await this.db.issuerKey.updateMany({ where: { active: true }, data: { active: false } });
    await this.db.issuerKey.create({
      data: { modulusN: pub.n.toString(16), exponentE: pub.e.toString(16), active: true },
    });
    return cachedIssuerKey;
  }

  async getIssuerPublicKey(): Promise<IssuerPublicKey> {
    return publicKeyOf(await this.getIssuerKey());
  }

  // ---- CLIENT-SIDE steps, included here only to demonstrate the full
  // protocol without a separate client app yet — see file comment. ----

  demoClientBlind(pub: IssuerPublicKey) {
    const message = createRandomTokenMessage(pub.n);
    const { blindedMessage, blindingFactor } = blind(message, pub);
    return { messageHex: messageToHex(message), blindedMessageHex: messageToHex(blindedMessage), blindingFactorHex: messageToHex(blindingFactor) };
  }

  demoClientUnblind(args: { blindSignatureHex: string; blindingFactorHex: string; pub: IssuerPublicKey }) {
    const signature = unblind(hexToMessage(args.blindSignatureHex), hexToMessage(args.blindingFactorHex), args.pub);
    return { signatureHex: messageToHex(signature) };
  }

  // ---- ATLAS-SIDE steps — the actual server implementation. ----

  /** Checks the grant's remaining allowance for `amount` — the one point in
   * this whole flow where a token request is still linked to a grant, which
   * is why the check happens here and not at redemption — then blind-signs
   * whatever blinded value the caller sends. This method never sees, and
   * never needs to see, the real token value. */
  async issue(args: { requestingIdentityId: string; grantId: string; form: SpendTokenForm; amount: Money; blindedMessageHex: string }) {
    const grant = await this.db.permissionGrant.findUniqueOrThrow({ where: { id: args.grantId } });
    if (grant.identityId !== args.requestingIdentityId) {
      throw new Error(`Grant ${grant.id} does not belong to the requesting identity.`);
    }
    const grantState: GrantState = {
      id: grant.id,
      limit: Money.of(grant.limitAsset, grant.limitMinor),
      windowSeconds: grant.windowSeconds,
      singleUse: grant.singleUse,
      status: grant.status,
      expiresAt: grant.expiresAt,
      createdAt: grant.createdAt,
    };
    assertGrantUsable(grantState);

    const windowStart = new Date(Date.now() - grantState.windowSeconds * 1000);
    const priorIssuances = await this.db.spendTokenIssuance.findMany({
      where: { grantId: grant.id, issuedAt: { gte: windowStart } },
    });
    const priorUsage: PriorUsage[] = priorIssuances.map((i) => ({
      amount: Money.of(i.amountAsset, i.amountMinor),
      at: i.issuedAt,
    }));
    checkAllowance(grantState, priorUsage, args.amount);

    const key = await this.getIssuerKey();
    const blindSignature = issuerBlindSign(hexToMessage(args.blindedMessageHex), key);

    await this.db.spendTokenIssuance.create({
      data: {
        grantId: grant.id,
        form: args.form,
        amountMinor: args.amount.minorUnits,
        amountAsset: args.amount.asset,
      },
    });

    return { blindSignatureHex: messageToHex(blindSignature) };
  }

  /**
   * Redeems a finished (message, signature) token. Verifies the signature
   * is real (proves *some* legitimate issuance produced it), checks it
   * hasn't been redeemed before (double-spend prevention, keyed only by a
   * hash of the token — no grant or identity reference exists to check
   * against, by design), then credits the ledger.
   *
   * Honest limitation: because the signed message doesn't cryptographically
   * bind an amount (see domain/spendToken.ts's file comment), the amount
   * credited here is trusted at face value once signature validity and
   * non-double-spend are confirmed, rather than re-verified against
   * whatever was checked at issuance. A real deployment closes this with a
   * separate issuer key per denomination.
   */
  async redeem(args: { identityId: string; messageHex: string; signatureHex: string; amount: Money }) {
    const pub = await this.getIssuerPublicKey();
    const message = hexToMessage(args.messageHex);
    const signature = hexToMessage(args.signatureHex);

    if (!verify(message, signature, pub)) {
      throw new InvalidTokenSignatureError("Token signature does not verify against the current issuer public key.");
    }

    const tokenHash = tokenHashFor(message);
    const existing = await this.db.redeemedSpendToken.findUnique({ where: { tokenHash } });
    if (existing) {
      throw new TokenAlreadyRedeemedError(`Token ${tokenHash} has already been redeemed.`);
    }

    await this.db.redeemedSpendToken.create({
      data: { tokenHash, amountMinor: args.amount.minorUnits, amountAsset: args.amount.asset },
    });

    await this.ledger.post(merchantSpend({ identityId: args.identityId, amount: args.amount }));

    return { tokenHash };
  }
}
