import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export const createCellSchema = z.object({
  name: z.string().trim().min(1).max(80),
  tagline: z.string().trim().max(240).optional().default(""),
  color: z.enum(["good", "accent", "info", "alert", "risk"]),
  icon: z.enum(["grid", "bolt", "flag", "eye", "doc", "bookmark", "card", "mail"]),
});

export const updateCellSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tagline: z.string().trim().max(240).optional(),
  color: z.enum(["good", "accent", "info", "alert", "risk"]).optional(),
  icon: z.string().trim().min(1).max(40).optional(),
});

export const decisionStatusSchema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "FAILED", "REJECTED"]),
});

export const createTaskSchema = z.object({
  cellId: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  freq: z.enum(["يومي", "أسبوعي", "شهري", "مستمر", "عند الحاجة"]),
});

export const confirmAutomationSchema = z.object({
  decisionId: z.string().min(1),
});

export const meetingMessageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  participantCellSlugs: z.array(z.string()).max(20).optional().default([]),
});

export const connectIntegrationSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional().default({}),
});
