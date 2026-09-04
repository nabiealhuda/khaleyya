import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { connectIntegrationSchema } from "@/lib/validators";
import { getIntegrationProvider } from "@/lib/integrations/registry";
import { findIntegrationCatalogEntry } from "@/lib/integrations/catalog";
import { IntegrationConfigError } from "@/lib/integrations/types";
import { encryptJson } from "@/lib/crypto";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Attempts a real connection to the named provider (currently only Odoo has
 * a real implementation — see src/lib/integrations/registry.ts) using
 * merchant-supplied credentials, and persists the result. The provider
 * itself validates the credentials against the live platform (e.g. an
 * actual Odoo JSON-RPC authenticate call) before anything is saved, so a
 * wrong URL/db/username/API key never gets stored as "connected".
 *
 * Rate-limited tighter than the default (10/min) since each call makes an
 * outbound network request to a third-party server.
 */
export const POST = withRoute<RouteCtx>(
  async (req, ctx, routeCtx) => {
    const { id } = await routeCtx.params;
    if (!findIntegrationCatalogEntry(id)) return jsonError("منصة غير معروفة", 404);

    const provider = getIntegrationProvider(id);
    if (!provider) {
      return jsonError("الربط الفعلي مع هذه المنصة غير مُفعّل بعد — سيتم تفعيله قريباً.", 501);
    }

    const body = await req.json().catch(() => null);
    const parsed = connectIntegrationSchema.safeParse(body);
    if (!parsed.success) return jsonError("بيانات غير صالحة", 422, parsed.error.flatten());

    let result;
    try {
      result = await provider.connect(parsed.data.config);
    } catch (err) {
      if (err instanceof IntegrationConfigError) return jsonError(err.message, 422);
      throw err;
    }

    // Never store credentials in plaintext — config is encrypted at rest
    // (see src/lib/crypto.ts) and is never sent back to the browser.
    const encryptedConfig = encryptJson(parsed.data.config);

    const connection = await prisma.integrationConnection.upsert({
      where: { storeId_providerId: { storeId: ctx.storeId, providerId: id } },
      create: {
        storeId: ctx.storeId,
        providerId: id,
        status: result.status,
        config: encryptedConfig,
        lastSyncAt: new Date(),
      },
      update: {
        status: result.status,
        config: encryptedConfig,
        lastSyncAt: new Date(),
      },
    });

    return NextResponse.json({
      integration: {
        id: connection.id,
        providerId: connection.providerId,
        status: connection.status,
        lastSyncAt: connection.lastSyncAt,
      },
      reads: result.reads,
      actions: result.actions,
    });
  },
  { rateLimit: { limit: 10, windowMs: 60_000 } }
);
