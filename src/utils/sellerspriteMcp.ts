import type {
  McpCallStatus,
  McpKeywordSnapshot,
  McpPredictionPoint,
  McpPredictionSnapshot,
  McpProductSnapshot,
  McpToolCallResult,
} from '../types/mcp';

const DEFAULT_MARKETPLACE = 'US';
const REQUEST_TIMEOUT_MS = 90_000;

type McpBridge = {
  callTool?: (tool: string, payload: unknown) => Promise<unknown>;
  invoke?: (tool: string, payload: unknown) => Promise<unknown>;
  asin_detail?: (payload: unknown) => Promise<unknown>;
  asin_prediction?: (payload: unknown) => Promise<unknown>;
  traffic_keyword_stat?: (payload: unknown) => Promise<unknown>;
  keyword_miner?: (payload: unknown) => Promise<unknown>;
};

declare global {
  interface Window {
    __SELLERSPRITE_MCP__?: McpBridge;
    sellerspriteMcp?: McpBridge;
  }
}

const productReturnFields = [
  'asin',
  'title',
  'brand',
  'price',
  'finalPrice',
  'couponPrice',
  'rating',
  'ratings',
  'reviews',
  'reviewCount',
  'bsr',
  'bsrRank',
  'category',
  'categoryPath',
  'nodeIdPath',
  'sellerName',
  'seller',
  'sellerType',
  'fulfillment',
  'fulfillmentType',
  'variations',
  'variationCount',
  'buyBoxSeller',
  'buyboxSeller',
  'fbaFee',
  'monthlySales',
  'totalUnits',
  'monthlyRevenue',
  'totalAmount',
].join(',');

const predictionReturnFields = [
  'asin',
  'title',
  'price',
  'totalUnits',
  'totalAmount',
  'units',
  'amount',
  'monthData',
  'dayData',
  'salesTrend',
  'revenueTrend',
  'priceTrend',
  'bsrTrend',
  'bsr',
  'bsrRank',
  'avgPrice',
].join(',');

const keywordReturnFields = [
  'keyword',
  'searches',
  'searchVolume',
  'purchases',
  'purchaseVolume',
  'purchaseRate',
  'bid',
  'ppcBid',
  'products',
  'supplyDemandRatio',
  'adProducts',
  'adProduct',
  'adCompetitorCount',
  'monopolyClickRate',
  'titleDensity',
  'spr',
  'avgPrice',
  'wordCount',
  'relevancy',
].join(',');

function nowIso(): string {
  return new Date().toISOString();
}

function timeoutError(): Error {
  return new Error('MCP request timeout: 卖家精灵 MCP 请求超时或自动权限审查超时');
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return '未知错误';
  }
}

export function isMcpPermissionLikeError(message: string | null | undefined): boolean {
  const text = String(message ?? '').toLowerCase();
  return [
    'permission',
    'review',
    'timeout',
    'auto approval',
    'authorization',
    'authorize',
    'unauthorized',
    '403',
    '429',
  ].some((keyword) => text.includes(keyword));
}

export function getMcpFriendlyError(message: string | null | undefined): string {
  if (isMcpPermissionLikeError(message)) {
    return '当前 MCP 调用未成功，可能是权限审查、额度、登录状态或网络问题。请确认卖家精灵 MCP 授权状态后重试。';
  }
  return message || '当前 MCP 调用未成功，请稍后重试。';
}

function createToolResult<T>(
  tool: string,
  status: McpCallStatus,
  data: T | null,
  raw: unknown,
  error: string | null,
): McpToolCallResult<T> {
  return {
    tool,
    status,
    checked_at: nowIso(),
    data,
    raw,
    error,
  };
}

async function invokeMcpTool(tool: string, payload: unknown): Promise<McpToolCallResult<unknown>> {
  try {
    const bridge = window.__SELLERSPRITE_MCP__ ?? window.sellerspriteMcp;
    const endpoint = import.meta.env.VITE_SELLERSPRITE_MCP_ENDPOINT;

    const request = async (): Promise<unknown> => {
      if (bridge?.callTool) return bridge.callTool(tool, payload);
      if (bridge?.invoke) return bridge.invoke(tool, payload);

      const methodMap = {
        asin_detail: bridge?.asin_detail,
        asin_prediction: bridge?.asin_prediction,
        traffic_keyword_stat: bridge?.traffic_keyword_stat,
        keyword_miner: bridge?.keyword_miner,
      };
      const toolMethod = methodMap[tool as keyof typeof methodMap];
      if (typeof toolMethod === 'function') return toolMethod(payload);

      if (endpoint) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, payload }),
        });
        const text = await response.text();
        const parsed = parseMaybeJson(text);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
        }
        return parsed;
      }

      throw new Error('未检测到可用的卖家精灵 MCP 前端桥接。请配置 window.__SELLERSPRITE_MCP__ 或 VITE_SELLERSPRITE_MCP_ENDPOINT。');
    };

    const raw = await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(timeoutError()), REQUEST_TIMEOUT_MS);
      }),
    ]);

    return createToolResult(tool, 'success', unwrapMcpPayload(raw), raw, null);
  } catch (error) {
    const message = safeMessage(error);
    const status: McpCallStatus = message.toLowerCase().includes('timeout') ? 'timeout' : 'failed';
    return createToolResult(tool, status, null, null, message);
  }
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapMcpPayload(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    if (raw.length === 1) return unwrapMcpPayload(raw[0]);
    return raw.map((item) => unwrapMcpPayload(item));
  }

  if (!raw || typeof raw !== 'object') return raw;
  const record = raw as Record<string, unknown>;

  if (typeof record.text === 'string') {
    return parseMaybeJson(record.text);
  }

  if (Array.isArray(record.content)) return unwrapMcpPayload(record.content);
  if ('data' in record) return unwrapMcpPayload(record.data);
  if ('result' in record) return unwrapMcpPayload(record.result);
  if ('body' in record) return unwrapMcpPayload(record.body);

  return raw;
}

function asRecord(raw: unknown): Record<string, unknown> {
  const payload = unwrapMcpPayload(raw);
  if (Array.isArray(payload)) {
    const firstObject = payload.find((item) => item && typeof item === 'object');
    return firstObject && typeof firstObject === 'object' ? (firstObject as Record<string, unknown>) : {};
  }
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function pick(raw: unknown, keys: string[]): unknown {
  const record = asRecord(raw);
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function pickString(raw: unknown, keys: string[]): string | null {
  const value = pick(raw, keys);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.filter(Boolean).join(' > ') || null;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.title ?? record.value ?? JSON.stringify(value));
  }
  return String(value);
}

function pickNumber(raw: unknown, keys: string[]): number | null {
  const value = pick(raw, keys);
  return toNumber(value);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,%\s,]/g, '');
    if (!cleaned) return null;
    const numeric = Number(cleaned);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function countVariations(raw: unknown): number | null {
  const direct = pickNumber(raw, ['variation_count', 'variationCount', 'variationsCount', 'variantCount', 'childCount']);
  if (direct !== null) return direct;
  const variations = pick(raw, ['variations', 'variationAsins', 'childAsins', 'variants']);
  return Array.isArray(variations) ? variations.length : null;
}

function trendFrom(raw: unknown, keys: string[]): McpPredictionPoint[] {
  const value = pick(raw, keys);
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      return { date: null, value: toNumber(item) };
    }
    const record = item as Record<string, unknown>;
    return {
      date: pickString(record, ['date', 'month', 'day', 'timePoint', 'time', 'createdAt']) ?? null,
      value: pickNumber(record, ['value', 'units', 'sales', 'amount', 'price', 'bsr', 'rank', 'totalUnits', 'totalAmount']),
    };
  });
}

function classifyDemandStability(salesTrend: McpPredictionPoint[]): string | null {
  const values = salesTrend.map((item) => item.value).filter((value): value is number => typeof value === 'number');
  if (values.length < 3) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average === 0) return '低';
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  const cv = Math.sqrt(variance) / average;
  if (cv <= 0.35) return '稳定';
  if (cv <= 0.75) return '波动';
  return '强波动';
}

function classifyKeywordCompetition(raw: unknown): string | null {
  const adCompetitors = pickNumber(raw, ['ad_competitor_count', 'adCompetitorCount', 'adProducts', 'adProduct', 'latest1daysAds']);
  const products = pickNumber(raw, ['organic_competitor_count', 'organicCompetitorCount', 'products', 'productCount']);
  const titleDensity = pickNumber(raw, ['title_density', 'titleDensity', 'titleDensityExact']);

  if (adCompetitors === null && products === null && titleDensity === null) return null;
  const score = (adCompetitors ?? 0) * 0.5 + (titleDensity ?? 0) * 0.4 + (products ?? 0) / 10_000;
  if (score <= 20) return '低';
  if (score <= 60) return '中';
  return '高';
}

export function normalizeMcpProductData(raw: unknown): McpProductSnapshot {
  return {
    asin: pickString(raw, ['asin', 'ASIN']),
    title: pickString(raw, ['title', 'productTitle', 'name']),
    brand: pickString(raw, ['brand', 'brandName']),
    category: pickString(raw, ['category', 'categoryPath', 'bsrCategory', 'nodePath', 'nodeIdPath']),
    price: pickNumber(raw, ['price', 'salePrice', 'currentPrice', 'buyBoxPrice']),
    coupon_price: pickNumber(raw, ['coupon_price', 'couponPrice', 'finalPrice', 'dealPrice', 'actualPrice']),
    rating: pickNumber(raw, ['rating', 'ratingValue', 'stars', 'star']),
    review_count: pickNumber(raw, ['review_count', 'reviewCount', 'reviews', 'ratings', 'ratingsCount', 'ratingCount']),
    bsr: pickNumber(raw, ['bsr', 'bsrRank', 'bsr_rank', 'rank', 'mainBsrRank']),
    monthly_sales: pickNumber(raw, ['monthly_sales', 'monthlySales', 'totalUnits', 'units', 'sales', 'monthUnits']),
    monthly_revenue: pickNumber(raw, ['monthly_revenue', 'monthlyRevenue', 'totalAmount', 'amount', 'revenue', 'monthAmount']),
    fba_fee: pickNumber(raw, ['fba_fee', 'fbaFee', 'fba', 'fulfillmentFee']),
    seller: pickString(raw, ['seller', 'sellerName', 'buyBoxSellerName', 'shopName']),
    seller_type: pickString(raw, ['seller_type', 'sellerType', 'sellerCategory']),
    variation_count: countVariations(raw),
    buybox_seller: pickString(raw, ['buybox_seller', 'buyBoxSeller', 'buyboxSeller', 'buyBoxSellerName']),
    fulfillment_type: pickString(raw, ['fulfillment_type', 'fulfillmentType', 'fulfillment', 'deliveryType']),
    raw,
  };
}

export function normalizeMcpPredictionData(raw: unknown): McpPredictionSnapshot {
  const salesTrend = trendFrom(raw, ['sales_trend', 'salesTrend', 'unitsTrend', 'monthData', 'monthlySalesData']);
  const revenueTrend = trendFrom(raw, ['revenue_trend', 'revenueTrend', 'amountTrend', 'monthlyRevenueData']);
  const priceTrend = trendFrom(raw, ['price_trend', 'priceTrend', 'avgPriceTrend']);
  const bsrTrend = trendFrom(raw, ['bsr_trend', 'bsrTrend', 'rankTrend', 'bsrRankTrend']);

  return {
    asin: pickString(raw, ['asin', 'ASIN']),
    sales_trend: salesTrend,
    revenue_trend: revenueTrend,
    price_trend: priceTrend,
    bsr_trend: bsrTrend,
    recent_30d_sales: pickNumber(raw, ['recent_30d_sales', 'recent30dSales', 'last30DaysSales', 'totalUnits', 'units']),
    recent_30d_revenue: pickNumber(raw, ['recent_30d_revenue', 'recent30dRevenue', 'last30DaysRevenue', 'totalAmount', 'amount']),
    demand_stability_level: pickString(raw, ['demand_stability_level', 'demandStabilityLevel']) ?? classifyDemandStability(salesTrend),
    raw,
  };
}

export function normalizeMcpKeywordData(raw: unknown): McpKeywordSnapshot {
  return {
    keyword: pickString(raw, ['keyword', 'keywords', 'query']),
    search_volume: pickNumber(raw, ['search_volume', 'searchVolume', 'searches', 'search']),
    purchase_volume: pickNumber(raw, ['purchase_volume', 'purchaseVolume', 'purchases', 'keywordsIsHide']),
    purchase_rate: pickNumber(raw, ['purchase_rate', 'purchaseRate', 'purchasesRate', 'conversionRate']),
    ppc_bid: pickNumber(raw, ['ppc_bid', 'ppcBid', 'bid', 'avgBid', 'suggestedBid']),
    competition_level: pickString(raw, ['competition_level', 'competitionLevel']) ?? classifyKeywordCompetition(raw),
    ad_competitor_count: pickNumber(raw, ['ad_competitor_count', 'adCompetitorCount', 'adProducts', 'adProduct', 'latest1daysAds']),
    organic_competitor_count: pickNumber(raw, ['organic_competitor_count', 'organicCompetitorCount', 'products', 'productCount']),
    title_density: pickNumber(raw, ['title_density', 'titleDensity', 'titleDensityExact']),
    spr: pickNumber(raw, ['spr', 'SPR', 'cprExact']),
    click_concentration: pickNumber(raw, ['click_concentration', 'clickConcentration', 'monopolyClickRate', 'araClickRate']),
    raw,
  };
}

export async function fetchAsinDetail(asin: string): Promise<McpToolCallResult<McpProductSnapshot>> {
  const result = await invokeMcpTool('asin_detail', {
    asin: asin.trim(),
    marketplace: DEFAULT_MARKETPLACE,
    returnFields: productReturnFields,
  });
  if (result.status !== 'success') return { ...result, data: null } as McpToolCallResult<McpProductSnapshot>;
  return { ...result, data: normalizeMcpProductData(result.data) };
}

export async function fetchAsinPrediction(asin: string): Promise<McpToolCallResult<McpPredictionSnapshot>> {
  const result = await invokeMcpTool('asin_prediction', {
    asin: asin.trim(),
    marketplace: DEFAULT_MARKETPLACE,
    returnFields: predictionReturnFields,
  });
  if (result.status !== 'success') return { ...result, data: null } as McpToolCallResult<McpPredictionSnapshot>;
  return { ...result, data: normalizeMcpPredictionData(result.data) };
}

export async function fetchTrafficKeywordStat(asin: string): Promise<McpToolCallResult<unknown>> {
  return invokeMcpTool('traffic_keyword_stat', {
    asin: asin.trim(),
    marketplace: DEFAULT_MARKETPLACE,
    returnFields: 'asin,total,naturalSearching,amazonChoice,editorialRecommendations,fourStar,highlyRated,sponsorBrand,sponsorVideo,ads',
  });
}

export async function fetchKeywordMiner(keyword: string): Promise<McpToolCallResult<McpKeywordSnapshot>> {
  const result = await invokeMcpTool('keyword_miner', {
    request: {
      keyword: keyword.trim(),
      marketplace: DEFAULT_MARKETPLACE,
      size: 5,
      page: 1,
      returnFields: keywordReturnFields,
      order: { field: 'searches', desc: true },
    },
  });
  if (result.status !== 'success') return { ...result, data: null } as McpToolCallResult<McpKeywordSnapshot>;
  return { ...result, data: normalizeMcpKeywordData(result.data) };
}
