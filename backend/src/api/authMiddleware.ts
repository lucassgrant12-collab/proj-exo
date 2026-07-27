/**
 * Signature-based auth. There is no password and no session cookie anywhere
 * in this codebase — every authenticated request carries three headers:
 *
 *   X-Atlas-Identity:  the identity id making the request
 *   X-Atlas-Timestamp: milliseconds since epoch, at signing time
 *   X-Atlas-Signature: base64 Ed25519 signature over the canonical string
 *                       from domain/auth.ts's canonicalSigningString, using
 *                       that identity's private key (which only ever lives
 *                       client-side — see the "Atlas never sees the private
 *                       key" line that's been true since the prototype)
 *
 * A client constructs the signature over:
 *   `${METHOD}\n${path}\n${timestampMs}\n${sha256hex(rawBodyString)}`
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyRequestSignature, InvalidSignatureError } from "../domain/auth.js";
import { sha256Hex } from "../domain/encoding.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    atlasIdentityId?: string;
  }
}

const AUTH_EXEMPT_ROUTES: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/health" },
  { method: "POST", path: "/identities" }, // registration is what proves key possession, not a prerequisite for it
  { method: "POST", path: "/webhooks/stripe" }, // authenticated a different way — see routes/webhooks.ts
  { method: "GET", path: "/spend-tokens/issuer-key" }, // public by definition — needed to blind a token request at all
];

function isExempt(req: FastifyRequest): boolean {
  return AUTH_EXEMPT_ROUTES.some((r) => r.method === req.method && req.routeOptions.url === r.path);
}

export function registerAuthMiddleware(app: FastifyInstance) {
  // Captures the exact raw body bytes the client sent, so the server hashes
  // precisely what was signed — parsing and re-serializing JSON before
  // hashing would let whitespace/key-order differences silently break every
  // signature.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body || (body as string).length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (isExempt(req)) return;

    const identityId = req.headers["x-atlas-identity"];
    const signature = req.headers["x-atlas-signature"];
    const timestamp = req.headers["x-atlas-timestamp"];

    if (typeof identityId !== "string" || typeof signature !== "string" || typeof timestamp !== "string") {
      reply.code(401).send({ error: "Unauthorized", message: "Missing X-Atlas-Identity / X-Atlas-Signature / X-Atlas-Timestamp headers." });
      return reply;
    }

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs)) {
      reply.code(401).send({ error: "Unauthorized", message: "X-Atlas-Timestamp must be milliseconds since epoch." });
      return reply;
    }

    const identity = await app.prisma.identity.findUnique({ where: { id: identityId } });
    if (!identity) {
      reply.code(401).send({ error: "Unauthorized", message: "Unknown identity." });
      return reply;
    }

    try {
      await verifyRequestSignature({
        publicKeyBase64: identity.publicKey,
        signatureBase64: signature,
        input: {
          method: req.method,
          path: req.url,
          timestampMs,
          bodySha256Hex: sha256Hex(req.rawBody ?? ""),
        },
      });
    } catch (err) {
      if (err instanceof InvalidSignatureError) {
        reply.code(401).send({ error: "Unauthorized", message: err.message });
        return reply;
      }
      throw err;
    }

    req.atlasIdentityId = identity.id;
    return;
  });
}
