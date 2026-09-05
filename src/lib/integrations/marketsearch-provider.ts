import { IntegrationProvider, IntegrationSnapshot } from "./types";
import { parseMarketSearchConfig, verifyMarketSearchKey } from "./marketsearch-client";

/**
 * Real connection to SerpApi's Google Shopping search, used by the
 * competitor/market-research workflow (see src/app/api/competitors) to look
 * up a tracked product's price across the web when the merchant hasn't
 * supplied a direct competitor URL. Config shape: { apiKey: string } —
 * a SerpApi key from https://serpapi.com/manage-api-key.
 */
function snapshot(status: IntegrationSnapshot["status"]): IntegrationSnapshot {
  return {
    status,
    lastSyncLabel: status === "CONNECTED" ? "الآن" : "—",
    reads: ["نتائج بحث المنتجات والأسعار من جوجل شوبينج"],
    actions: ["بحث عن سعر منافس لمنتج تتابعه"],
  };
}

export class MarketSearchProvider implements IntegrationProvider {
  readonly id = "marketsearch";

  async getSnapshot(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    const { apiKey } = parseMarketSearchConfig(config);
    await verifyMarketSearchKey(apiKey);
    return snapshot("CONNECTED");
  }

  async connect(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    const { apiKey } = parseMarketSearchConfig(config);
    await verifyMarketSearchKey(apiKey);
    return snapshot("CONNECTED");
  }
}
