import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api";
import { prisma } from "@/lib/db";

/**
 * Real product catalog synced from the connected commerce/ERP platform
 * (currently Odoo — see src/lib/integrations/odoo-sync.ts syncProducts()).
 * Empty until a real sync has run; the frontend shows an honest
 * "not synced yet" state rather than any placeholder catalog.
 */
export const GET = withRoute(async (_req, ctx) => {
  const products = await prisma.product.findMany({
    where: { storeId: ctx.storeId },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ products });
});
