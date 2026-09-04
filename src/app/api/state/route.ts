import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api";
import { prisma } from "@/lib/db";

/**
 * Single bootstrap endpoint: the dashboard fetches this once on load and
 * gets everything it needs to render (cells, decisions, automations, tasks,
 * activity feed, meeting history, integration connection status). Keeping
 * this as one call instead of eight separate ones keeps first paint fast and
 * avoids a waterfall of requests on every page load.
 */
export const GET = withRoute(async (_req, ctx) => {
  const [cells, decisions, automations, tasks, activity, meetingMessages, integrations] =
    await Promise.all([
      prisma.cell.findMany({ where: { storeId: ctx.storeId }, orderBy: { sortOrder: "asc" } }),
      prisma.decision.findMany({ where: { storeId: ctx.storeId }, orderBy: { createdAt: "desc" } }),
      prisma.automation.findMany({ where: { storeId: ctx.storeId }, orderBy: { createdAt: "desc" } }),
      prisma.cellTask.findMany({ where: { storeId: ctx.storeId }, orderBy: { createdAt: "asc" } }),
      prisma.activityItem.findMany({
        where: { storeId: ctx.storeId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.meetingMessage.findMany({ where: { storeId: ctx.storeId }, orderBy: { createdAt: "asc" } }),
      prisma.integrationConnection.findMany({ where: { storeId: ctx.storeId } }),
    ]);

  return NextResponse.json({ cells, decisions, automations, tasks, activity, meetingMessages, integrations });
});
