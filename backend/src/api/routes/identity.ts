import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IdentityService } from "../../services/identityService.js";
import { serializeBigInts } from "../serialization.js";

const registerBody = z.object({
  publicKey: z.string().min(1),
  registrationSignature: z.string().min(1),
});

export function registerIdentityRoutes(app: FastifyInstance) {
  const identities = new IdentityService(app.prisma);

  // Exempt from signature auth (see authMiddleware.ts) — this is the one
  // request that can't be signed by an already-registered identity, since
  // it's the act of creating one. Proof of key possession comes from
  // registrationSignature instead — see domain/auth.ts.
  app.post("/identities", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const identity = await identities.register(body);
    reply.code(201).send(serializeBigInts(identity));
  });

  app.get("/identities/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const identity = await identities.get(id);
    reply.send(serializeBigInts(identity));
  });
}
