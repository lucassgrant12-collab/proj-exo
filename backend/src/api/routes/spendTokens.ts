import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SpendTokenService } from "../../services/spendTokenService.js";
import { Money } from "../../domain/money.js";
import { serializeBigInts } from "../serialization.js";

const issueBody = z.object({
  grantId: z.string(),
  form: z.enum(["VIRTUAL_CARD", "CRYPTO_ADDRESS"]),
  asset: z.string(),
  amountDecimal: z.string(),
  blindedMessageHex: z.string(),
});

const redeemBody = z.object({
  asset: z.string(),
  amountDecimal: z.string(),
  messageHex: z.string(),
  signatureHex: z.string(),
});

export function registerSpendTokenRoutes(app: FastifyInstance) {
  const spendTokens = new SpendTokenService(app.prisma);

  // Lets a client fetch the current issuer public key to blind a token
  // request locally — see domain/blindSignature.ts. No auth needed, it's
  // public by definition.
  app.get("/spend-tokens/issuer-key", async (_req, reply) => {
    const pub = await spendTokens.getIssuerPublicKey();
    reply.send({ n: pub.n.toString(16), e: pub.e.toString(16) });
  });

  app.post("/spend-tokens/issue", async (req, reply) => {
    const body = issueBody.parse(req.body);
    const result = await spendTokens.issue({
      requestingIdentityId: req.atlasIdentityId as string,
      grantId: body.grantId,
      form: body.form,
      amount: Money.fromDecimalString(body.asset, body.amountDecimal),
      blindedMessageHex: body.blindedMessageHex,
    });
    reply.code(201).send(result);
  });

  app.post("/spend-tokens/redeem", async (req, reply) => {
    const body = redeemBody.parse(req.body);
    const result = await spendTokens.redeem({
      identityId: req.atlasIdentityId as string,
      messageHex: body.messageHex,
      signatureHex: body.signatureHex,
      amount: Money.fromDecimalString(body.asset, body.amountDecimal),
    });
    reply.send(serializeBigInts(result));
  });
}
