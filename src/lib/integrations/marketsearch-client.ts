import { IntegrationConfigError } from "./types";

/**
 * Low-level SerpApi client (Google Shopping engine) — the real data source
 * behind the "رصد الأسعار والمنافسين" integration and, through it, the
 * "رصد وتحليل السوق" cell's competitor search. SerpApi was chosen after
 * checking the current (2026) market: Bing's Web Search API was retired in
 * 2025, and Google's own Custom Search JSON API is being sunset in 2027 —
 * SerpApi's Google Shopping engine is currently active, self-serve, and
 * returns merchant/price fields already parsed instead of raw HTML.
 *
 * Every result returned here is exactly what SerpApi reports for the given
 * query — nothing is invented if a query returns few or no results.
 */

export type ShoppingResult = {
  title: string;
  price: string | null;
  source: string | null;
  link: string | null;
};

const SERPAPI_URL = "https://serpapi.com/search.json";

export function parseMarketSearchConfig(config: Record<string, unknown>): { apiKey: string } {
  const apiKey = String(config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new IntegrationConfigError("الرجاء إدخال مفتاح SerpApi (API Key) أولاً.");
  }
  return { apiKey };
}

async function serpApiGet(params: Record<string, string>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  const url = new URL(SERPAPI_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new IntegrationConfigError("انتهت مهلة الاتصال بخدمة البحث الخارجية (SerpApi).");
    }
    throw new IntegrationConfigError("تعذّر الوصول إلى خدمة البحث الخارجية (SerpApi).");
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !payload) {
    const message =
      (payload && typeof payload.error === "string" && payload.error) ||
      `خدمة البحث الخارجية أعادت خطأ (رمز ${res.status}) — تحقق من مفتاح API.`;
    throw new IntegrationConfigError(message);
  }
  if (typeof payload.error === "string") {
    throw new IntegrationConfigError(`SerpApi رفض الطلب: ${payload.error}`);
  }
  return payload;
}

/** Validates the API key with one cheap, real search — used by connect()/getSnapshot() so a wrong key is never stored as "connected". */
export async function verifyMarketSearchKey(apiKey: string): Promise<void> {
  await serpApiGet({ engine: "google_shopping", q: "test", api_key: apiKey, num: "1" });
}

/** Real Google Shopping search for one query — used to find a competitor's current price for a product the merchant is tracking. */
export async function searchShopping(apiKey: string, query: string): Promise<ShoppingResult[]> {
  const payload = await serpApiGet({ engine: "google_shopping", q: query, api_key: apiKey });
  const raw = Array.isArray(payload.shopping_results) ? (payload.shopping_results as Record<string, unknown>[]) : [];
  return raw.slice(0, 5).map((r) => ({
    title: typeof r.title === "string" ? r.title : "—",
    price: typeof r.price === "string" ? r.price : null,
    source: typeof r.source === "string" ? r.source : null,
    link: typeof r.link === "string" ? r.link : null,
  }));
}
