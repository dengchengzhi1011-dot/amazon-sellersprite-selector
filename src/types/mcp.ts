export type McpCallStatus = 'idle' | 'loading' | 'success' | 'failed' | 'timeout';

export type NullableNumber = number | null;
export type NullableString = string | null;

export interface McpProductSnapshot {
  asin: NullableString;
  title: NullableString;
  brand: NullableString;
  category: NullableString;
  price: NullableNumber;
  coupon_price: NullableNumber;
  rating: NullableNumber;
  review_count: NullableNumber;
  bsr: NullableNumber;
  monthly_sales: NullableNumber;
  monthly_revenue: NullableNumber;
  fba_fee: NullableNumber;
  seller: NullableString;
  seller_type: NullableString;
  variation_count: NullableNumber;
  buybox_seller: NullableString;
  fulfillment_type: NullableString;
  raw: unknown;
}

export interface McpPredictionPoint {
  date: string | null;
  value: number | null;
}

export interface McpPredictionSnapshot {
  asin: NullableString;
  sales_trend: McpPredictionPoint[];
  revenue_trend: McpPredictionPoint[];
  price_trend: McpPredictionPoint[];
  bsr_trend: McpPredictionPoint[];
  recent_30d_sales: NullableNumber;
  recent_30d_revenue: NullableNumber;
  demand_stability_level: NullableString;
  raw: unknown;
}

export interface McpKeywordSnapshot {
  keyword: NullableString;
  search_volume: NullableNumber;
  purchase_volume: NullableNumber;
  purchase_rate: NullableNumber;
  ppc_bid: NullableNumber;
  competition_level: NullableString;
  ad_competitor_count: NullableNumber;
  organic_competitor_count: NullableNumber;
  title_density: NullableNumber;
  spr: NullableNumber;
  click_concentration: NullableNumber;
  raw: unknown;
}

export interface McpToolCallResult<T = unknown> {
  tool: string;
  status: McpCallStatus;
  checked_at: string;
  data: T | null;
  raw: unknown;
  error: string | null;
}

export interface McpValidationResult {
  asin: string;
  keyword: string;
  status: McpCallStatus;
  checked_at: string;
  asin_detail: McpToolCallResult<McpProductSnapshot> | null;
  asin_prediction: McpToolCallResult<McpPredictionSnapshot> | null;
  traffic_keyword_stat: McpToolCallResult<unknown> | null;
  keyword_miner: McpToolCallResult<McpKeywordSnapshot> | null;
  errors: string[];
}
