import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FundingSourceService } from "../../services/fundingSourceService.js";
import { Money } from "../../domain/money.js";
import { serializeBigInts } from "../serialization.js";

const connectBody = z.object({
  kind: z.enum(["BANK", "CARD", "WALLET"]),
  rail: z.enum(["PISP", "CARD_NETWORK", "ONCHAIN"]),
  label: z.string().min(1),
  externalRef: z.string().min(1),
});

const grantBody = z.object({
  fundingSourceId: z.string(),
  limitAsset: z.string(),
  limitDecimal: z.string(), // e.g. "1000.00"
  windowSeconds: z.number().int().positive(),
  singleUse: z.boolean().default(false),
  merchantCategory: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

/** Every route here trusts req.atlasIdentityId — set by the signature-auth
 * middleware (authMiddleware.ts) after verifying the request was actually
 * signed by that identity's private key — never a client-supplied
 * identityId in the body. See auth's module comment for why: nothing here
 * should be actionable on someone else's behalf just because a request
 * happened to name their id. */
export function registerSourceRoutes(app: FastifyInstance) {
  const sources = new FundingSourceService(app.prisma);

  app.post("/funding-sources", async (req, reply) => {
    const body = connectBody.parse(req.body);
    const source = await sources.connect({ identityId: req.atlasIdentityId as string, ...body });
    reply.code(201).send(serializeBigInts(source));
  });

  // The web client uses this to render real connected sources instead of
  // trusting an unverified local cache — the server stays the source of
  // truth, the client just displays it.
  //
  // The `id` here must match the caller's own signed identity — a valid
  // signature proves *who* is asking, but says nothing about *whose* data
  // they're allowed to see unless a handler actually checks that, which is
  // exactly what this guards. Without it, any registered identity could
  // read any other identity's connected-source labels just by naming a
  // different id in the URL.
  app.get("/identities/:id/funding-sources", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (id !== req.atlasIdentityId) {
      reply.code(403).send({ error: "Forbidden", message: "Cannot read another identity's funding sources." });
      return;
    }
    const list = await sources.listForIdentity(id);
    reply.send(serializeBigInts(list));
  });

  app.post("/funding-sources/:id/revoke", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const source = await sources.revoke(id, req.atlasIdentityId as string);
    reply.send(serializeBigInts(source));
  });

  app.post("/permission-grants", async (req, reply) => {
    const body = grantBody.parse(req.body);
    const limit = Money.fromDecimalString(body.limitAsset, body.limitDecimal);
    const grant = await sources.createGrant({
      identityId: req.atlasIdentityId as string,
      fundingSourceId: body.fundingSourceId,
      limit,
      windowSeconds: body.windowSeconds,
      singleUse: body.singleUse,
      ...(body.merchantCategory !== undefined ? { merchantCategory: body.merchantCategory } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
    });
    reply.code(201).send(serializeBigInts(grant));
  });

  app.post("/permission-grants/:id/revoke", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const grant = await sources.revokeGrant(id, req.atlasIdentityId as string);
    reply.send(serializeBigInts(grant));
  });
}
