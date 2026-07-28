import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { prisma } from "../db/client.js";
import { registerAuthMiddleware } from "./authMiddleware.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerSettleRoutes } from "./routes/settle.js";
import { registerSpendTokenRoutes } from "./routes/spendTokens.js";
import { registerWithdrawalRoutes } from "./routes/withdrawals.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: typeof prisma;
  }
}

export function buildServer() {
  const app = Fastify({ logger: true });
  app.decorate("prisma", prisma);

  // Registers the raw-body content-type parser and the signature-verifying
  // preHandler hook. Must be registered before the routes that depend on
  // req.atlasIdentityId being set.
  registerAuthMiddleware(app);

  app.get("/health", async () => ({ status: "ok" }));

  // This is an API with no visual frontend of its own (see web/ for that) —
  // this route exists purely so opening the deployed URL in a browser shows
  // something informative instead of a bare 404.
  app.get("/", async () => ({
    service: "atlas-backend",
    status: "ok",
    docs: "See README.md in the backend/ directory of the repo.",
  }));

  registerIdentityRoutes(app);
  registerSourceRoutes(app);
  registerSettleRoutes(app);
  registerSpendTokenRoutes(app);
  registerWithdrawalRoutes(app);
  registerWebhookRoutes(app); // authenticated via Stripe's own signature, not ours — see authMiddleware's exempt list

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    reply.code(status).send({ error: err.name, message: err.message });
  });

  return app;
}

async function main() {
  const app = buildServer();
  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

// Only auto-start when run directly (`npm run dev` / `npm start`), not when
// imported by tests or the smoke script. Comparing raw strings here
// (`file://${process.argv[1]}`) breaks on Windows — process.argv[1] uses
// backslashes ("C:\...") while import.meta.url is a properly encoded URL
// ("file:///C:/..."), so they never match and the server silently never
// starts. pathToFileURL() does the platform-correct conversion.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
