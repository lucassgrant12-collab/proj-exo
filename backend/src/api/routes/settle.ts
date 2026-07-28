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

const conversionBody = z.object({
  cryptoAsset: z.string(),
  cryptoDecimal: z.string(),
  fiatAsset: z.string(),
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

  // The reverse of card-crypto-purchase — converts a crypto position you
  // already hold back into a fiat position, still inside Atlas (no
  // grantId: you're not authorizing a new external charge, just
  // reallocating value you already own). See
  // settlementService.executeCryptoToFiatConversion's doc comment for why
  // this doesn't pay out to a real bank.
  app.post("/settlements/crypto-fiat-conversion", async (req, reply) => {
    const body = conversionBody.parse(req.body);
    const result = await settlement.executeCryptoToFiatConversion({
      identityId: req.atlasIdentityId as string,
      cryptoAmount: Money.fromDecimalString(body.cryptoAsset, body.cryptoDecimal),
      fiatAsset: body.fiatAsset,
    });
    reply.code(201).send(serializeBigInts(result));
  });

  app.post("/settlements/:id/release", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await settlement.releaseHold(id, req.atlasIdentityId as string);
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
    // A valid signature only proves who's asking, not whose data they may
    // see — without this check any registered identity could read any
    // other identity's balance just by naming a different id in the URL.
    if (id !== req.atlasIdentityId) {
      reply.code(403).send({ error: "Forbidden", message: "Cannot read another identity's balance." });
      return;
    }
    const balance = await ledger.balanceOf(id, asset);
    reply.send({ identityId: id, asset, balance: balance.toDecimalString() });
  });

  // Exempt from signature auth (see authMiddleware.ts) — a market quote
  // isn't identity-scoped data, so there's nothing to authenticate. This is
  // what the web client calls for the Convert tab's live estimate and the
  // currency-selector total, instead of a rate hardcoded into frontend JS.
  app.get("/rates/:cryptoAsset/:fiatAsset", async (req, reply) => {
    const { cryptoAsset, fiatAsset } = z.object({ cryptoAsset: z.string(), fiatAsset: z.string() }).parse(req.params);
    const quote = await liquidity.getQuote({ cryptoAsset, fiatAsset });
    reply.send({
      cryptoAsset: quote.cryptoAsset,
      fiatAsset: quote.fiatAsset,
      rate: quote.rateMinorPerMinor,
      expiresAt: quote.expiresAt.toISOString(),
    });
  });
}
