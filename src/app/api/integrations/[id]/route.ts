import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Disconnects a provider: marks the connection DISCONNECTED and wipes its
 * (encrypted) stored config — there is no "keep the old credentials around"
 * state; reconnecting later means re-entering them.
 */
export const DELETE = withRoute<RouteCtx>(async (_req, ctx, routeCtx) => {
  const { id } = await routeCtx.params;

  const existing = await prisma.integrationConnection.findUnique({
    where: { storeId_providerId: { storeId: ctx.storeId, providerId: id } },
  });
  if (!existing) return jsonError("لا يوجد ربط قائم مع هذه المنصة", 404);

  const connection = await prisma.integrationConnection.update({
    where: { id: existing.id },
    data: { status: "DISCONNECTED", config: {}, lastSyncAt: null },
  });

  return NextResponse.json({
    integration: {
      id: connection.id,
      providerId: connection.providerId,
      status: connection.status,
      lastSyncAt: connection.lastSyncAt,
    },
  });
});
