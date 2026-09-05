import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { ODOO_LINKED_CELL_SLUGS } from "@/lib/integrations/odoo-sync";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Disconnects a provider: marks the connection DISCONNECTED and wipes its
 * (encrypted) stored config — there is no "keep the old credentials around"
 * state; reconnecting later means re-entering them.
 *
 * For Odoo specifically, also removes "أودو" from the sources list of the
 * cells it exclusively feeds (see ODOO_LINKED_CELL_SLUGS) — otherwise those
 * cells would keep claiming a data source that is no longer actually
 * connected, which is exactly the kind of false claim this app is supposed
 * to never make. Their kpis/insight/chart are intentionally left as the
 * last real synced values rather than wiped, since they were genuinely true
 * as of the last sync.
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

  if (id === "odoo") {
    const linkedCells = await prisma.cell.findMany({
      where: { storeId: ctx.storeId, slug: { in: ODOO_LINKED_CELL_SLUGS } },
    });
    for (const cell of linkedCells) {
      const sources = Array.isArray(cell.sources) ? (cell.sources as unknown[]) : [];
      if (!sources.includes("أودو")) continue;
      await prisma.cell.update({
        where: { id: cell.id },
        data: { sources: sources.filter((s) => s !== "أودو") as never },
      });
    }
  }

  return NextResponse.json({
    integration: {
      id: connection.id,
      providerId: connection.providerId,
      status: connection.status,
      lastSyncAt: connection.lastSyncAt,
    },
  });
});
