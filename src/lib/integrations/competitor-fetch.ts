/**
 * Best-effort real-page fetch for a merchant-tracked competitor URL — no
 * scraping infrastructure, just a plain GET plus light HTML parsing (title
 * tag + a currency-looking number). Used by /api/competitors/refresh as the
 * first thing tried for each CompetitorEntry, before falling back to the
 * SerpApi search (see marketsearch-client.ts) if this fails or the page
 * yields nothing readable. Every value returned here comes straight out of
 * the fetched page — nothing is invented when a page can't be read.
 */

export type PageSnapshot = { title: string | null; price: string | null } | null;

const PRICE_PATTERN =
  /(?:ر\.?\s?س\.?|SAR|SR|ريال|\$|USD)\s?[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s?(?:ر\.?\s?س\.?|SAR|SR|ريال|\$|USD)/i;

export async function fetchCompetitorPage(url: string): Promise<PageSnapshot> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; KhaleyyaBot/1.0; +https://khaleyya) — قراءة سعر منتج بطلب مباشر من التاجر",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : null;

    // Strip script/style blocks first so their content never leaks into the
    // price match (e.g. a price shown in an unrelated JSON blob elsewhere
    // on the page, or a completely different number in analytics code).
    const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
    const priceMatch = visibleText.match(PRICE_PATTERN);
    const price = priceMatch ? priceMatch[0].replace(/\s+/g, " ").trim() : null;

    if (!title && !price) return null;
    return { title, price };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
