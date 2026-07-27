import { PrismaClient } from "@prisma/client";

// Standard singleton pattern to avoid exhausting DB connections under
// tsx/ts-node's module reload in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}
