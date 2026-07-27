import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SettlementService } from "../../services/settlementService.js";
import { LedgerService } from "../../services/ledgerService.js";
import { Money } from "../../domain/money.js";
import { buildFundingAdapters } from "../../adapters/funding/factory.js";
import { StubLiquidityAdapter } from "../../adapters/liquidity/stub.js";
import { serializeBigInts } from "../serialization.js";

const purchaseBody = z.object({
  grantId: z.string(),
  fiatAsset: z.string(),
  fiatDecimal: z.string(),
  cryptoAsset: z.string(),
});

export function registerSettleRoutes(app: FastifyInstance) {
  const funding = buildFundingAdapters();
  const liquidity = new StubLiquidityAdapter();
  const settlement = new SettlementService(app.prisma, funding, liquidity);
  const ledger = new LedgerService(app.prisma);

  app.post("/settlements/card-crypto-purchase", async (req, reply) => {
    const body = purchaseBody.parse(req.body);
    const result = await settlement.executeCardFundedCryptoPurchase({
      identityId: req.atlasIdentityId as string,
      grantId: body.grantId,
      fiatAmount: Money.fromDecimalString(body.fiatAsset, body.fiatDecimal),
      cryptoAsset: body.cryptoAsset,
    });
    reply.code(201).send(serializeBigInts(result));
  });

  app.post("/settlements/:id/release", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await settlement.releaseHold(id);
    reply.send({ settlementRecordId: id, status: "RELEASED" });
  });

  app.post("/settlements/:id/reverse", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { cryptoAsset } = z.object({ cryptoAsset: z.string() }).parse(req.body);
    const result = await settlement.reverseSettlement({
      settlementRecordId: id,
      identityId: req.atlasIdentityId as string,
      cryptoAsset,
    });
    reply.send(result);
  });

  app.get("/identities/:id/balance/:asset", async (req, reply) => {
    const { id, asset } = z.object({ id: z.string(), asset: z.string() }).parse(req.params);
    const balance = await ledger.balanceOf(id, asset);
    reply.send({ identityId: id, asset, balance: balance.toDecimalString() });
  });
}
