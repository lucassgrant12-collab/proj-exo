/**
 * Real disputes don't arrive by polling — a real card processor pushes them
 * via webhook, often weeks after the original charge, exactly as described
 * throughout the research doc's §10. This route is what turns a genuine
 * Stripe dispute event into a call to settlementService.reverseSettlement,
 * closing the loop between "Stripe says this was disputed" and "the ledger
 * reflects that."
 *
 * Authenticated differently from every other route in this API: not by an
 * Atlas identity signature (there isn't one — Stripe is calling this, not a
 * user), but by Stripe's own webhook signature scheme, verified against
 * STRIPE_WEBHOOK_SECRET. See authMiddleware.ts's AUTH_EXEMPT_ROUTES for why
 * this path is exempt from the identity-signature check.
 */

import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { SettlementService } from "../../services/settlementService.js";
import { buildFundingAdapters } from "../../adapters/funding/factory.js";
import { StubLiquidityAdapter } from "../../adapters/liquidity/stub.js";

export function registerWebhookRoutes(app: FastifyInstance) {
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
  const funding = buildFundingAdapters();
  const liquidity = new StubLiquidityAdapter();
  const settlement = new SettlementService(app.prisma, funding, liquidity);

  app.post("/webhooks/stripe", async (req, reply) => {
    if (!webhookSecret) {
      // Not configured — see .env.example. Fail loudly rather than silently
      // accepting unverified webhook payloads, which would let anyone who
      // finds this URL forge dispute events.
      reply.code(503).send({ error: "ServiceUnavailable", message: "STRIPE_WEBHOOK_SECRET is not configured." });
      return;
    }

    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      reply.code(400).send({ error: "BadRequest", message: "Missing Stripe-Signature header." });
      return;
    }

    let event: Stripe.Event;
    try {
      // constructEvent needs the *raw* body exactly as Stripe sent it —
      // req.rawBody is captured by the content-type parser in
      // authMiddleware.ts before any JSON parsing happens.
      event = Stripe.webhooks.constructEvent(req.rawBody ?? "", signature, webhookSecret);
    } catch (err) {
      req.log.warn({ err }, "Stripe webhook signature verification failed");
      reply.code(400).send({ error: "BadRequest", message: "Invalid webhook signature." });
      return;
    }

    if (event.type === "charge.dispute.created") {
      const dispute = event.data.object as Stripe.Dispute;
      const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;

      if (paymentIntentId) {
        const record = await app.prisma.settlementRecord.findFirst({
          where: { fundingChargeRef: paymentIntentId },
        });

        if (record && record.status !== "REVERSED") {
          // The identity and crypto asset the original purchase used —
          // needed to unwind a HELD position; see settlementService.
          const grant = await app.prisma.permissionGrant.findUniqueOrThrow({ where: { id: record.grantId } });
          const allocation = await app.prisma.ledgerTransaction.findFirst({
            where: { settlementRecordId: record.id, kind: "POSITION_ALLOCATION" },
            include: { entries: { include: { account: true } } },
          });
          const cryptoAsset = allocation?.entries.find((e) => e.account.ownerType === "IDENTITY")?.account.assetCode;

          if (cryptoAsset) {
            await settlement.reverseSettlement({
              settlementRecordId: record.id,
              identityId: grant.identityId,
              cryptoAsset,
            });
            req.log.info({ settlementRecordId: record.id }, "Settlement reversed due to Stripe dispute webhook");
          } else {
            req.log.error({ settlementRecordId: record.id }, "Disputed settlement has no crypto position allocation to unwind");
          }
        }
      }
    }

    reply.code(200).send({ received: true });
  });
}
