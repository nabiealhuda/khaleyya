import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/api";

export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx) return jsonError("Unauthorized", 401);

  const store = await prisma.store.findUnique({ where: { id: ctx.storeId } });

  return NextResponse.json({
    user: { id: ctx.userId, name: ctx.userName, email: ctx.userEmail },
    store: { id: ctx.storeId, name: store?.name ?? "" },
  });
}
