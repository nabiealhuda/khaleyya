import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { z } from "zod";

const postMeetingMessageSchema = z.object({
  role: z.enum(["MERCHANT", "LEADER", "CELL"]),
  cellSlug: z.string().trim().max(60).optional(),
  text: z.string().trim().min(1).max(2000),
});

export const POST = withRoute(async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = postMeetingMessageSchema.safeParse(body);
  if (!parsed.success) return jsonError("رسالة غير صالحة", 422, parsed.error.flatten());

  const message = await prisma.meetingMessage.create({
    data: {
      storeId: ctx.storeId,
      role: parsed.data.role,
      cellSlug: parsed.data.cellSlug,
      text: parsed.data.text,
    },
  });

  return NextResponse.json({ message }, { status: 201 });
});
