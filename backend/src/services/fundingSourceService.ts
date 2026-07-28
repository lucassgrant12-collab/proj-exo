/**
 * Connecting a funding source. Note what's *not* here: there's no raw card
 * number or bank account number anywhere in this service or its inputs.
 * `externalRef` is assumed to already be an opaque reference handed back by
 * a real provider SDK (Stripe Elements / a card-issuing platform's tokenize
 * call for cards, an Open Banking consent flow for bank accounts) — exactly
 * the "collect via Apple Pay / a provider SDK, never a raw text field"
 * decision from the research doc. This service never sees sensitive data
 * because nothing upstream of it should ever produce any for it to see.
 */

import type { PrismaClient } from "@prisma/client";
import type { FundingRail, FundingSourceKind } from "../domain/permissionGrant.js";
import { prepareGrant } from "../domain/permissionGrant.js";
import { Money } from "../domain/money.js";

export class FundingSourceService {
  constructor(private readonly db: PrismaClient) {}

  async connect(args: {
    identityId: string;
    kind: FundingSourceKind;
    rail: FundingRail;
    label: string;
    externalRef: string;
  }) {
    return this.db.fundingSource.create({
      data: {
        identityId: args.identityId,
        kind: args.kind,
        rail: args.rail,
        label: args.label,
        externalRef: args.externalRef,
      },
    });
  }

  async listForIdentity(identityId: string) {
    return this.db.fundingSource.findMany({ where: { identityId }, orderBy: { createdAt: "asc" } });
  }

  async revoke(fundingSourceId: string, requestingIdentityId: string) {
    const source = await this.db.fundingSource.findUniqueOrThrow({ where: { id: fundingSourceId } });
    if (source.identityId !== requestingIdentityId) {
      throw new Error(`Funding source ${fundingSourceId} does not belong to the requesting identity.`);
    }
    return this.db.fundingSource.update({ where: { id: fundingSourceId }, data: { status: "REVOKED" } });
  }

  async createGrant(args: {
    identityId: string;
    fundingSourceId: string;
    limit: Money;
    windowSeconds: number;
    singleUse: boolean;
    merchantCategory?: string;
    expiresAt?: Date;
  }) {
    const fundingSource = await this.db.fundingSource.findUniqueOrThrow({ where: { id: args.fundingSourceId } });

    prepareGrant(
      {
        identityId: args.identityId,
        fundingSourceId: args.fundingSourceId,
        limit: args.limit,
        windowSeconds: args.windowSeconds,
        singleUse: args.singleUse,
        ...(args.merchantCategory !== undefined ? { merchantCategory: args.merchantCategory } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
      },
      {
        id: fundingSource.id,
        kind: fundingSource.kind,
        rail: fundingSource.rail,
        status: fundingSource.status,
      },
    );

    return this.db.permissionGrant.create({
      data: {
        identityId: args.identityId,
        fundingSourceId: args.fundingSourceId,
        limitMinor: args.limit.minorUnits,
        limitAsset: args.limit.asset,
        windowSeconds: args.windowSeconds,
        singleUse: args.singleUse,
        merchantCategory: args.merchantCategory ?? null,
        expiresAt: args.expiresAt ?? null,
      },
    });
  }

  async revokeGrant(grantId: string, requestingIdentityId: string) {
    const grant = await this.db.permissionGrant.findUniqueOrThrow({ where: { id: grantId } });
    if (grant.identityId !== requestingIdentityId) {
      throw new Error(`Permission grant ${grantId} does not belong to the requesting identity.`);
    }
    return this.db.permissionGrant.update({ where: { id: grantId }, data: { status: "REVOKED" } });
  }
}
