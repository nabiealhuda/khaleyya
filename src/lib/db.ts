import { PrismaClient } from "@prisma/client";
import "./env";

/**
 * Reuse a single PrismaClient across hot reloads in dev, and across
 * serverless/edge invocations sharing the same Node process in prod, so we
 * never exhaust the Postgres connection pool. This is the standard Next.js +
 * Prisma pattern.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
