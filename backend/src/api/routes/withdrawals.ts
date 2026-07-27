import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WithdrawalService } from "../../services/withdrawalService.js";
import { StubCustodyAdapter } from "../../adapters/custody/stub.js";
import { Money } from "../../domain/money.js";
import { serializeBigInts } from "../serialization.js";

const withdrawBody = z.object({
  asset: z.string(),
  amountDecimal: z.string(),
  toAddress: z.string().min(1),
});

export function registerWithdrawalRoutes(app: FastifyInstance) {
  // See adapters/custody/stub.ts — real deployment swaps this for an MPC
  // wallet provider (Turnkey, Privy, Fireblocks); nothing here changes.
  const withdrawals = new WithdrawalService(app.prisma, new StubCustodyAdapter());

  app.post("/withdrawals", async (req, reply) => {
    const body = withdrawBody.parse(req.body);
    const result = await withdrawals.withdraw({
      identityId: req.atlasIdentityId as string,
      amount: Money.fromDecimalString(body.asset, body.amountDecimal),
      toAddress: body.toAddress,
    });
    reply.code(201).send(serializeBigInts(result));
  });
}
