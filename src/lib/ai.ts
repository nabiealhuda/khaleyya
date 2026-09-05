import { env } from "./env";

/**
 * Minimal client for the store's configured AI provider — used to power
 * the real (non-canned) AI features: the leader/meeting-room chat, the
 * council decision-study endpoint, and AI-written cell insights. Plain
 * `fetch` calls rather than an SDK package: both providers' APIs are one
 * simple JSON POST, and avoiding a new dependency means nothing new to add
 * to the Docker runner's node_modules (see the Dockerfile's own notes on
 * why that copy step matters).
 *
 * Two providers are supported, selected by whichever key is actually set
 * on the server — OPENAI_API_KEY takes priority since that's what this
 * store's merchant has a subscription for; ANTHROPIC_API_KEY is used if
 * that's what's configured instead. If neither is set, every AI-backed
 * route returns a friendly "not configured" error instead of crashing.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
// gpt-6-astra is OpenAI's current flagship chat model (2026). It's a
// reasoning-family model: it takes `max_completion_tokens` (not the older
// `max_tokens`) and doesn't support temperature/top_p — both are simply
// omitted below rather than sent with a value that would be rejected.
const OPENAI_MODEL = "gpt-6-astra";

export class AiNotConfiguredError extends Error {}
export class AiRequestError extends Error {}

export type AiMessage = { role: "user" | "assistant"; content: string };

type AskAiOpts = {
  system: string;
  // Either a single one-shot message, or a full conversation (in
  // chronological order, ending with the latest "user" turn) so the model
  // has real prior context instead of guessing at things like "هذا المنتج"
  // with nothing behind them. Exactly one of these must be given.
  userMessage?: string;
  messages?: AiMessage[];
  maxTokens?: number;
};

function resolveMessages(opts: AskAiOpts): AiMessage[] {
  return opts.messages?.length ? opts.messages : [{ role: "user", content: opts.userMessage ?? "" }];
}

function withTimeout(): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  return { controller, clear: () => clearTimeout(timeoutId) };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const { controller, clear } = withTimeout();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiRequestError("انتهت مهلة الاتصال بخدمة الذكاء الاصطناعي — حاول مرة أخرى.");
    }
    throw new AiRequestError("تعذّر الوصول إلى خدمة الذكاء الاصطناعي.");
  } finally {
    clear();
  }
}

type AnthropicContentBlock = { type: string; text?: string };
type AnthropicResponse = { content?: AnthropicContentBlock[] };

async function askAnthropic(opts: AskAiOpts, apiKey: string): Promise<string> {
  const messages = resolveMessages(opts);
  const res = await fetchWithTimeout(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 700,
      system: opts.system,
      messages,
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      detail = errBody.error?.message ?? "";
    } catch {
      // Body wasn't JSON — ignore, we still have the status code.
    }
    if (res.status === 401) {
      throw new AiNotConfiguredError("مفتاح Anthropic غير صحيح أو منتهي — راجع إعدادات الخادم.");
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

type OpenAiChoice = { message?: { content?: string } };
type OpenAiResponse = { choices?: OpenAiChoice[] };

async function askOpenAi(opts: AskAiOpts, apiKey: string): Promise<string> {
  const conversation = resolveMessages(opts);
  const messages = [
    { role: "system", content: opts.system },
    ...conversation.map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetchWithTimeout(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: opts.maxTokens ?? 700,
      messages,
    }),
  });

  if (!res.ok) {
    let detail = "";
    let code = "";
    try {
      const errBody = (await res.json()) as { error?: { message?: string; code?: string } };
      detail = errBody.error?.message ?? "";
      code = errBody.error?.code ?? "";
    } catch {
      // Body wasn't JSON — ignore, we still have the status code.
    }
    if (res.status === 401 || code === "invalid_api_key") {
      throw new AiNotConfiguredError("مفتاح OpenAI غير صحيح أو منتهي — راجع إعدادات الخادم.");
    }
    if (res.status === 429) {
      throw new AiRequestError("تم تجاوز الحد المسموح من الطلبات لخدمة الذكاء الاصطناعي — حاول بعد قليل.");
    }
    throw new AiRequestError(`خدمة الذكاء الاصطناعي أعادت خطأ (${res.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const text = data?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new AiRequestError("رد غير متوقع من خدمة الذكاء الاصطناعي.");
  }
  return text;
}

/**
 * Provider-agnostic entry point every AI-backed route calls. Picks whichever
 * provider has a real key configured (OpenAI first, since that's what this
 * store is actually subscribed to; Anthropic as an alternative), and throws
 * AiNotConfiguredError if neither is set — callers already handle that as a
 * graceful "AI not configured" 503 rather than a crash.
 */
export async function askAI(opts: AskAiOpts): Promise<string> {
  if (env.OPENAI_API_KEY) {
    return askOpenAi(opts, env.OPENAI_API_KEY);
  }
  if (env.ANTHROPIC_API_KEY) {
    return askAnthropic(opts, env.ANTHROPIC_API_KEY);
  }
  throw new AiNotConfiguredError(
    "ميزة الذكاء الاصطناعي غير مُفعّلة بعد على الخادم — لم يتم إعداد مفتاح API (OPENAI_API_KEY أو ANTHROPIC_API_KEY)."
  );
}
