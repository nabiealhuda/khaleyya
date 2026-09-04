import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { decryptJson } from "@/lib/crypto";
import { odooAuthenticate, parseOdooConfig } from "@/lib/integrations/odoo-client";
import { syncOdooCells } from "@/lib/integrations/odoo-sync";
import { IntegrationConfigError } from "@/lib/integrations/types";

/**
 * Re-pulls real data from the already-connected Odoo instance into the four
 * Odoo-backed cells (see odoo-sync.ts). Re-authenticates on every call
 * (cheap — one RPC round trip) rather than trusting a cached uid, since the
 * API key could have been revoked in Odoo since the last sync.
 *
 * Rate-limited low (5/min): this fans out into ~20 outbound Odoo RPC calls
 * per run (four cells × several aggregate queries each).
 */
export const POST = withRoute(
  async (_req, ctx) => {
    const connection = await prisma.integrationConnection.findUnique({
      where: { storeId_providerId: { storeId: ctx.storeId, providerId: "odoo" } },
    });
    if (!connection || connection.status !== "CONNECTED") {
      return jsonError("أودو غير متصل بعد — اربطه أولاً من صفحة التكاملات.", 422);
    }

    const config = decryptJson(connection.config);
    let cfg;
    let uid: number;
    try {
      cfg = parseOdooConfig(config);
      uid = await odooAuthenticate(cfg);
    } catch (err) {
      if (err instanceof IntegrationConfigError) {
        // Credentials no longer work — reflect that in the stored status
        // instead of silently leaving it marked CONNECTED.
        await prisma.integrationConnection.update({
          where: { id: connection.id },
          data: { status: "ISSUE" },
        });
        return jsonError(err.message, 422);
      }
      throw err;
    }

    const outcomes = await syncOdooCells(ctx.storeId, cfg, uid);

    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: { status: "CONNECTED", lastSyncAt: new Date() },
    });

    return NextResponse.json({ outcomes });
  },
  { rateLimit: { limit: 5, windowMs: 60_000 } }
);
