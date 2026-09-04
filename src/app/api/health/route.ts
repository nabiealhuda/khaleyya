import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Unauthenticated liveness + readiness check for Railway (and any uptime
 * monitor). Verifies the process is up AND can actually reach Postgres —
 * a process that's alive but DB-unreachable should still fail health checks
 * so the platform can react (restart, alert), not report "healthy".
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "up", time: new Date().toISOString() });
  } catch {
    return NextResponse.json(
      { status: "error", db: "down", time: new Date().toISOString() },
      { status: 503 }
    );
  }
}
