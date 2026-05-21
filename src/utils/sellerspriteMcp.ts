import type {
  AmazonCategoryNode,
  CategorySelection,
  DiscoveryFilters,
  McpCallStatus,
  McpDiscoveredProduct,
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
  competitor_lookup?: (payload: unknown) => Promise<unknown>;
  product_node?: (payload: unknown) => Promise<unknown>;
  product_research?: (payload: unknown) => Promise<unknown>;
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
  'fba_fee',
  'fba_fee_amount',
  'fulfillmentFee',
  'amazonFulfillmentFee',
  'deliveryFee',
  'shippingFee',
  'estimatedFbaFee',
  'fba',
  'referralFee',
  'referral_fee',
  'commission',
  'commissionFee',
  'referralRate',
  'referral_fee_rate',
  'categoryCommission',
  'profit',
  'profitRate',
  'profit_margin',
  'grossMargin',
  'margin',
  'monthlySales',
  'totalUnits',
  'units',
  'amzUnit',
  'monthlyRevenue',
  'totalAmount',
  'revenue',
  'amzSales',
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

const marketProductReturnFields = [
  'asin',
  'title',
  'brand',
  'nodeLabelPath',
  'price',
  'ratings',
  'rating',
  'bsr',
  'units',
  'revenue',
  'fba',
  'sellerName',
  'variations',
  'fulfillment',
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

const discoveryReturnFields = [
  'asin',
  'parent',
  'title',
  'brand',
  'nodeLabelPath',
  'nodeIdPath',
  'nodeId',
  'price',
  'couponPrice',
  'units',
  'revenue',
  'ratings',
  'reviews',
  'rating',
  'bsr',
  'fba',
  'sellerName',
  'fulfillment',
  'variations',
  'badge',
  'availableDate',
  'availableMonth',
  'listedAt',
  'listed_at',
  'launchDate',
  'launch_date',
  'firstAvailableDate',
  'first_available_date',
  'productAgeDays',
  'product_age_days',
  'listedDays',
  'listed_days',
].join(',');

const categoryNodeReturnFields = [
  'nodeIdPath',
  'nodeLabelPath',
  'nodeLabelLocale',
  'nodeLabelPathLocale',
  'products',
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
  if (String(message ?? '').includes('本地卖家精灵桥接') || String(message ?? '').includes('/api/sellersprite')) {
    return '本地卖家精灵 MCP 桥接未就绪。请用 npm run dev 启动页面与桥接后重试。';
  }
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
    const endpoint = import.meta.env.VITE_SELLERSPRITE_MCP_ENDPOINT || '/api/sellersprite/call';

    const request = async (): Promise<unknown> => {
      if (bridge?.callTool) return bridge.callTool(tool, payload);
      if (bridge?.invoke) return bridge.invoke(tool, payload);

      const methodMap = {
        asin_detail: bridge?.asin_detail,
        asin_prediction: bridge?.asin_prediction,
        traffic_keyword_stat: bridge?.traffic_keyword_stat,
        keyword_miner: bridge?.keyword_miner,
        competitor_lookup: bridge?.competitor_lookup,
        product_node: bridge?.product_node,
        product_research: bridge?.product_research,
      };
      const toolMethod = methodMap[tool as keyof typeof methodMap];
      if (typeof toolMethod === 'function') return toolMethod(payload);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, payload }),
      });
      const text = await response.text();
      const parsed = parseMaybeJson(text);
      if (!response.ok) {
        throw new Error(`本地卖家精灵桥接 HTTP ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
      }
      return parsed;
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

function asObjectArray(raw: unknown): Array<Record<string, unknown>> {
  const payload = unwrapMcpPayload(raw);
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  const record = asRecord(payload);
  return Array.isArray(record.items)
    ? record.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
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
  const variationNumber = toNumber(variations);
  if (variationNumber !== null) return variationNumber;
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

function productSourceFrom(raw: unknown): unknown {
  const payload = asRecord(raw);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.find((item) => item && typeof item === 'object') ?? raw;
}

function lastPathPart(value: string | null, separator: RegExp): string | null {
  if (!value) return null;
  const parts = value.split(separator).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function parentNodeId(nodeIdPath: string): string | null {
  const parts = nodeIdPath.split(':').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join(':') : null;
}

function normalizeCategoryNode(raw: Record<string, unknown>, marketplace: string): AmazonCategoryNode | null {
  const nodeIdPath = pickString(raw, ['nodeIdPath', 'node_id_path', 'nodePath']);
  const rawPath = pickString(raw, ['nodeLabelPath', 'path', 'nodePathLabel']);
  if (!nodeIdPath || !rawPath) return null;
  const localePath = pickString(raw, ['nodeLabelPathLocale', 'pathLocale']);
  const name = lastPathPart(rawPath, /[:>]/) ?? rawPath;
  return {
    id: nodeIdPath,
    node_id: nodeIdPath,
    name,
    name_cn: pickString(raw, ['nodeLabelLocale', 'nameCn']) ?? lastPathPart(localePath, /[:>]/),
    path: rawPath.replaceAll(':', ' > '),
    level: nodeIdPath.split(':').filter(Boolean).length,
    parent_id: parentNodeId(nodeIdPath),
    children: [],
    is_leaf: false,
    marketplace,
    raw,
  };
}

function categorySubLabel(path: string | null): string | null {
  return lastPathPart(path, /[:>]/);
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric)) return toIsoDate(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function pickIsoDate(raw: unknown, keys: string[]): string | null {
  return toIsoDate(pick(raw, keys));
}

function ageDaysFrom(dateValue: string | null): number | null {
  if (!dateValue) return null;
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function classifyRecentProduct(productAgeDays: number | null): McpDiscoveredProduct['recent_product_level'] {
  if (productAgeDays === null) return '时间缺失';
  if (productAgeDays <= 30) return '新品观察';
  if (productAgeDays <= 180) return '新品优先';
  if (productAgeDays <= 365) return '稳定新品';
  return '老品';
}

function normalizeProductAgeDays(raw: unknown, listedAt: string | null, launchDate: string | null, firstAvailableDate: string | null): number | null {
  const direct = pickNumber(raw, [
    'product_age_days',
    'productAgeDays',
    'listed_days',
    'listedDays',
    'listingDays',
    'availableDays',
  ]);
  if (direct !== null) return Math.max(0, Math.round(direct));
  return ageDaysFrom(listedAt) ?? ageDaysFrom(launchDate) ?? ageDaysFrom(firstAvailableDate);
}

function normalizeDiscoveredProduct(raw: Record<string, unknown>, source: CategorySelection, sourceKeyword = ''): McpDiscoveredProduct | null {
  const asin = pickString(raw, ['asin', 'ASIN']);
  if (!asin) return null;
  const categoryPath = pickString(raw, ['nodeLabelPath', 'categoryPath', 'category']);
  const seller = pickString(raw, ['sellerName', 'seller', 'shopName']);
  const sellerType = pickString(raw, ['sellerType', 'fulfillment', 'fulfillmentType']);
  const amazon = `${seller ?? ''} ${sellerType ?? ''}`.toLowerCase().includes('amazon') || `${sellerType ?? ''}`.toUpperCase() === 'AMZ';
  const listedAt = pickIsoDate(raw, ['listed_at', 'listedAt', 'availableDate', 'listedDate', 'releaseDate']);
  const launchDate = pickIsoDate(raw, ['launch_date', 'launchDate', 'releaseDate']);
  const firstAvailableDate = pickIsoDate(raw, ['first_available_date', 'firstAvailableDate', 'firstAvailableAt', 'availableDate']);
  const productAgeDays = normalizeProductAgeDays(raw, listedAt, launchDate, firstAvailableDate);
  const listedDays = pickNumber(raw, ['listed_days', 'listedDays', 'listingDays', 'availableDays']) ?? productAgeDays;
  return {
    asin,
    parent_asin: pickString(raw, ['parent', 'parentAsin', 'parent_asin']),
    title: pickString(raw, ['title', 'productTitle', 'name']),
    brand: pickString(raw, ['brand', 'brandName']),
    category: categoryPath,
    sub_category: categorySubLabel(categoryPath),
    category_node_id: pickString(raw, ['nodeIdPath', 'categoryNodeId', 'nodeId']),
    category_path: categoryPath ? categoryPath.replaceAll(':', ' > ') : null,
    price: pickNumber(raw, ['price', 'salePrice', 'currentPrice']),
    coupon_price: pickNumber(raw, ['couponPrice', 'coupon_price', 'finalPrice']),
    monthly_sales: pickNumber(raw, ['units', 'monthlySales', 'totalUnits', 'amzUnit']),
    monthly_revenue: pickNumber(raw, ['revenue', 'monthlyRevenue', 'totalAmount', 'amzSales']),
    review_count: pickNumber(raw, ['ratings', 'reviews', 'reviewCount', 'ratingsCount']),
    rating: pickNumber(raw, ['rating', 'ratingValue']),
    bsr: pickNumber(raw, ['bsr', 'bsrRank', 'rank']),
    fba_fee: pickNumber(raw, ['fba', 'fbaFee', 'fba_fee', 'fulfillmentFee']),
    seller,
    seller_type: sellerType,
    is_amazon: amazon,
    variation_count: countVariations(raw),
    product_url: `https://www.amazon.com/dp/${asin}`,
    listed_at: listedAt,
    launch_date: launchDate,
    first_available_date: firstAvailableDate,
    product_age_days: productAgeDays,
    listed_days: listedDays,
    is_recent_product: productAgeDays !== null && productAgeDays <= 365,
    recent_product_level: classifyRecentProduct(productAgeDays),
    source_keyword: sourceKeyword.trim() || null,
    source_type: 'category_node',
    source_node_id: source.node_id,
    source_category_path: source.path,
    discovered_at: nowIso(),
    raw,
  };
}

function prefer<T>(...values: Array<T | null | undefined>): T | null {
  return values.find((value): value is T => value !== null && value !== undefined) ?? null;
}

function mergeProductSnapshots(
  detail: McpProductSnapshot | null,
  market: McpProductSnapshot | null,
  raw: unknown,
): McpProductSnapshot {
  return {
    asin: prefer(detail?.asin, market?.asin),
    title: prefer(detail?.title, market?.title),
    brand: prefer(detail?.brand, market?.brand),
    category: prefer(detail?.category, market?.category),
    price: prefer(detail?.price, market?.price),
    coupon_price: prefer(detail?.coupon_price, market?.coupon_price),
    rating: prefer(detail?.rating, market?.rating),
    review_count: prefer(detail?.review_count, market?.review_count),
    bsr: prefer(detail?.bsr, market?.bsr),
    monthly_sales: prefer(market?.monthly_sales, detail?.monthly_sales),
    monthly_revenue: prefer(market?.monthly_revenue, detail?.monthly_revenue),
    fba_fee: prefer(market?.fba_fee, detail?.fba_fee),
    referral_fee: prefer(detail?.referral_fee, market?.referral_fee),
    referral_fee_rate: prefer(detail?.referral_fee_rate, market?.referral_fee_rate),
    seller: prefer(detail?.seller, market?.seller),
    seller_type: prefer(detail?.seller_type, market?.seller_type),
    variation_count: prefer(detail?.variation_count, market?.variation_count),
    buybox_seller: prefer(detail?.buybox_seller, market?.buybox_seller),
    fulfillment_type: prefer(detail?.fulfillment_type, market?.fulfillment_type),
    raw,
  };
}

export function normalizeMcpProductData(raw: unknown): McpProductSnapshot {
  const source = productSourceFrom(raw);

  return {
    asin: pickString(source, ['asin', 'ASIN']),
    title: pickString(source, ['title', 'productTitle', 'name']),
    brand: pickString(source, ['brand', 'brandName']),
    category: pickString(source, ['category', 'categoryPath', 'bsrCategory', 'nodePath', 'nodeLabelPath', 'nodeIdPath']),
    price: pickNumber(source, ['price', 'salePrice', 'currentPrice', 'buyBoxPrice']),
    coupon_price: pickNumber(source, ['coupon_price', 'couponPrice', 'finalPrice', 'dealPrice', 'actualPrice']),
    rating: pickNumber(source, ['rating', 'ratingValue', 'stars', 'star']),
    review_count: pickNumber(source, ['review_count', 'reviewCount', 'reviews', 'ratings', 'ratingsCount', 'ratingCount']),
    bsr: pickNumber(source, ['bsr', 'bsrRank', 'bsr_rank', 'rank', 'mainBsrRank']),
    monthly_sales: pickNumber(source, ['monthly_sales', 'monthlySales', 'units', 'totalUnits', 'sales', 'monthUnits', 'amzUnit']),
    monthly_revenue: pickNumber(source, ['monthly_revenue', 'monthlyRevenue', 'revenue', 'totalAmount', 'amount', 'monthAmount', 'amzSales']),
    fba_fee: pickNumber(source, [
      'fba_fee',
      'fbaFee',
      'fba_fee_amount',
      'fba',
      'fulfillmentFee',
      'amazonFulfillmentFee',
      'estimatedFbaFee',
    ]),
    referral_fee: pickNumber(source, ['referral_fee', 'referralFee', 'commissionFee']),
    referral_fee_rate: pickNumber(source, ['referral_fee_rate', 'referralRate', 'commissionRate', 'categoryCommissionRate']),
    seller: pickString(source, ['seller', 'sellerName', 'buyBoxSellerName', 'shopName']),
    seller_type: pickString(source, ['seller_type', 'sellerType', 'sellerCategory']),
    variation_count: countVariations(source),
    buybox_seller: pickString(source, ['buybox_seller', 'buyBoxSeller', 'buyboxSeller', 'buyBoxSellerName']),
    fulfillment_type: pickString(source, ['fulfillment_type', 'fulfillmentType', 'fulfillment', 'deliveryType']),
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

export function normalizeMcpKeywordData(raw: unknown, requestedKeyword = ''): McpKeywordSnapshot {
  const payload = asRecord(raw);
  const keywordItems = Array.isArray(payload.items) ? payload.items.filter((item) => item && typeof item === 'object') : [];
  const normalizedRequestedKeyword = requestedKeyword.trim().toLowerCase();
  const preferred = keywordItems.find((item) => {
    const keyword = pickString(item, ['keyword', 'keywords', 'query']);
    return Boolean(keyword && normalizedRequestedKeyword && keyword.trim().toLowerCase() === normalizedRequestedKeyword);
  });
  const source = preferred ?? keywordItems[0] ?? raw;

  return {
    keyword: pickString(source, ['keyword', 'keywords', 'query']),
    search_volume: pickNumber(source, ['search_volume', 'searchVolume', 'searches', 'search']),
    purchase_volume: pickNumber(source, ['purchase_volume', 'purchaseVolume', 'purchases', 'keywordsIsHide']),
    purchase_rate: pickNumber(source, ['purchase_rate', 'purchaseRate', 'purchasesRate', 'conversionRate']),
    ppc_bid: pickNumber(source, ['ppc_bid', 'ppcBid', 'bid', 'avgBid', 'suggestedBid']),
    competition_level: pickString(source, ['competition_level', 'competitionLevel']) ?? classifyKeywordCompetition(source),
    ad_competitor_count: pickNumber(source, ['ad_competitor_count', 'adCompetitorCount', 'adProducts', 'adProduct', 'latest1daysAds']),
    organic_competitor_count: pickNumber(source, ['organic_competitor_count', 'organicCompetitorCount', 'products', 'productCount']),
    title_density: pickNumber(source, ['title_density', 'titleDensity', 'titleDensityExact']),
    spr: pickNumber(source, ['spr', 'SPR', 'cprExact']),
    click_concentration: pickNumber(source, ['click_concentration', 'clickConcentration', 'monopolyClickRate', 'araClickRate']),
    raw,
  };
}

export async function fetchAsinDetail(asin: string): Promise<McpToolCallResult<McpProductSnapshot>> {
  const normalizedAsin = asin.trim();
  const [detailResult, marketResult] = await Promise.all([
    invokeMcpTool('asin_detail', {
      asin: normalizedAsin,
      marketplace: DEFAULT_MARKETPLACE,
      returnFields: productReturnFields,
    }),
    invokeMcpTool('competitor_lookup', {
      request: {
        asins: [normalizedAsin],
        marketplace: DEFAULT_MARKETPLACE,
        page: 1,
        size: 1,
        variation: 'Y',
        returnFields: marketProductReturnFields,
      },
    }),
  ]);

  const detail = detailResult.status === 'success' ? normalizeMcpProductData(detailResult.data) : null;
  const market = marketResult.status === 'success' ? normalizeMcpProductData(marketResult.data) : null;
  const raw = {
    asin_detail: detailResult.raw,
    competitor_lookup: marketResult.raw,
    competitor_lookup_error: marketResult.error,
  };

  if (!detail && !market) {
    return {
      ...detailResult,
      data: null,
      raw,
      error: detailResult.error ?? marketResult.error,
    } as McpToolCallResult<McpProductSnapshot>;
  }

  return createToolResult(
    'asin_detail',
    'success',
    mergeProductSnapshots(detail, market, raw),
    raw,
    detailResult.error ?? marketResult.error,
  );
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
      filterRootWord: 1,
      returnFields: keywordReturnFields,
      order: { field: 'searches', desc: true },
    },
  });
  if (result.status !== 'success') return { ...result, data: null } as McpToolCallResult<McpKeywordSnapshot>;
  return { ...result, data: normalizeMcpKeywordData(result.data, keyword.trim()) };
}

export async function fetchCategoryNodes(nodeIdPath?: string, marketplace = DEFAULT_MARKETPLACE): Promise<McpToolCallResult<AmazonCategoryNode[]>> {
  const result = await invokeMcpTool('product_node', {
    request: {
      marketplace,
      nodeIdPath: nodeIdPath || undefined,
      returnFields: categoryNodeReturnFields,
    },
  });
  if (result.status !== 'success') return { ...result, data: null } as McpToolCallResult<AmazonCategoryNode[]>;
  const nodes = asObjectArray(result.data)
    .map((item) => normalizeCategoryNode(item, marketplace))
    .filter((item): item is AmazonCategoryNode => item !== null);
  return { ...result, data: nodes };
}

export interface McpCategoryResearchResult {
  products: McpDiscoveredProduct[];
  used_category_fallback: boolean;
  warnings: string[];
}

function effectiveListingDayRange(filters: DiscoveryFilters): { min: number; max: number | null } {
  if (filters.listing_range_days === null) return { min: 0, max: null };
  const rangeMax = filters.listing_range_days;
  const manualMax = filters.listed_days_max > 0 ? filters.listed_days_max : rangeMax;
  return {
    min: Math.max(0, Math.round(filters.listed_days_min || 0)),
    max: Math.max(1, Math.min(rangeMax, Math.round(manualMax))),
  };
}

function filterProductsByListingAge(products: McpDiscoveredProduct[], filters: DiscoveryFilters): {
  products: McpDiscoveredProduct[];
  warnings: string[];
} {
  const { min, max } = effectiveListingDayRange(filters);
  if (max === null) return { products, warnings: [] };

  const filtered = products.filter((product) => {
    if (product.product_age_days === null) return true;
    return product.product_age_days >= min && product.product_age_days <= max;
  });
  const missingCount = filtered.filter((product) => product.product_age_days === null).length;
  const droppedCount = products.length - filtered.length;
  const sorted = filters.prioritize_recent
    ? [...filtered].sort((left, right) => (left.product_age_days ?? Number.MAX_SAFE_INTEGER) - (right.product_age_days ?? Number.MAX_SAFE_INTEGER))
    : filtered;
  const warnings = ['卖家精灵 MCP 当前按 availableMonth 做上架时间粗筛，精确上架天数已在本地按返回字段过滤。'];
  if (droppedCount > 0) warnings.push(`已在本地过滤 ${droppedCount} 条超出上架天数范围的结果。`);
  if (missingCount > 0) warnings.push(`有 ${missingCount} 条结果未返回上架时间，已保留并标记为时间缺失。`);
  return { products: sorted, warnings };
}

function normalizeCategoryResearchProducts(
  raw: unknown,
  selection: CategorySelection,
  filters: DiscoveryFilters,
  warnings: string[] = [],
): McpCategoryResearchResult {
  const normalized = asObjectArray(raw)
    .map((item) => normalizeDiscoveredProduct(item, selection, filters.keyword_optional))
    .filter((item): item is McpDiscoveredProduct => item !== null);
  const filtered = filterProductsByListingAge(normalized, filters);
  return {
    products: filtered.products,
    used_category_fallback: warnings.some((warning) => warning.includes('类目名称')),
    warnings: [...warnings, ...filtered.warnings],
  };
}

export async function productResearchByCategory(
  selection: CategorySelection,
  filters: DiscoveryFilters,
): Promise<McpToolCallResult<McpCategoryResearchResult>> {
  const size = Math.max(1, Math.min(50, Math.round(filters.limit || 20)));
  const listingRange = effectiveListingDayRange(filters);
  const request = {
    marketplace: filters.marketplace || DEFAULT_MARKETPLACE,
    nodeIdPath: selection.node_id,
    nodeIdPathEqual: filters.leaf_only,
    keyword: filters.keyword_optional.trim() || undefined,
    minPrice: filters.price_min,
    maxPrice: filters.price_max,
    minUnits: filters.monthly_sales_min,
    maxUnits: filters.monthly_sales_max,
    maxRatings: filters.review_count_max,
    minRating: filters.strict_rating_filter_enabled ? filters.rating_min : undefined,
    availableMonth: listingRange.max === null ? undefined : Math.max(1, Math.ceil(listingRange.max / 30)),
    size,
    page: 1,
    variation: 'Y',
    returnFields: discoveryReturnFields,
  };
  const result = await invokeMcpTool('product_research', { request });
  if (result.status === 'success') {
    return {
      ...result,
      data: normalizeCategoryResearchProducts(result.data, selection, filters),
    };
  }

  const canFallbackByCategoryName = ['node', 'category', '类目'].some((keyword) =>
    String(result.error ?? '').toLowerCase().includes(keyword.toLowerCase()),
  );
  if (!canFallbackByCategoryName) {
    return { ...result, data: null } as McpToolCallResult<McpCategoryResearchResult>;
  }

  const fallbackResult = await invokeMcpTool('product_research', {
    request: {
      ...request,
      nodeIdPath: undefined,
      nodeIdPathEqual: undefined,
      keyword: filters.keyword_optional.trim() || selection.name,
    },
  });
  if (fallbackResult.status !== 'success') {
    return { ...result, data: null } as McpToolCallResult<McpCategoryResearchResult>;
  }
  return {
    ...fallbackResult,
    data: normalizeCategoryResearchProducts(fallbackResult.data, selection, filters, ['当前 MCP 工具未确认支持 node_id，已使用类目名称降级查询。']),
  };
}
