import { env } from "./env";

/**
 * Minimal client for the Anthropic Messages API — used to power the real
 * (non-canned) AI features: the leader/meeting-room chat and AI-written
 * cell insights. A plain `fetch` call rather than the @anthropic-ai/sdk
 * package: the Messages API is one simple JSON POST, and avoiding a new
 * dependency means nothing new to add to the Docker runner's node_modules
 * (see the Dockerfile's own notes on why that copy step matters).
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5";

export class AiNotConfiguredError extends Error {}
export class AiRequestError extends Error {}

type AnthropicContentBlock = { type: string; text?: string };
type AnthropicResponse = { content?: AnthropicContentBlock[] };

export async function askClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AiNotConfiguredError(
      "ميزة الذكاء الاصطناعي غير مُفعّلة بعد على الخادم — لم يتم إعداد مفتاح API."
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 700,
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiRequestError("انتهت مهلة الاتصال بخدمة الذكاء الاصطناعي — حاول مرة أخرى.");
    }
    throw new AiRequestError("تعذّر الوصول إلى خدمة الذكاء الاصطناعي.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      detail = errBody.error?.message ?? "";
    } catch {
      // Body wasn't JSON — ignore, we still have the status code.
    }
    if (res.status === 401) {
      throw new AiNotConfiguredError("مفتاح الذكاء الاصطناعي غير صحيح أو منتهي — راجع إعدادات الخادم.");
    }
    if (res.status === 429) {
      throw new AiRequestError("تم تجاوز الحد المسموح من الطلبات لخدمة الذكاء الاصطناعي — حاول بعد قليل.");
    }
    throw new AiRequestError(`خدمة الذكاء الاصطناعي أعادت خطأ (${res.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
  const text = data?.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new AiRequestError("رد غير متوقع من خدمة الذكاء الاصطناعي.");
  }
  return text;
}
