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
  keyword_summary?: McpKeywordSnapshot | null;
  traffic_summary?: unknown;
  prediction_summary?: McpPredictionSnapshot | null;
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

export interface McpManualCostInput {
  target_discount_rate: NullableNumber;
  referral_fee_rate: NullableNumber;
  manual_fba_fee: NullableNumber;
  purchase_cost: NullableNumber;
  first_leg_shipping: NullableNumber;
  packaging_cost: NullableNumber;
  other_cost: NullableNumber;
  platform_other_fee?: NullableNumber;
  storage_cost_usd?: NullableNumber;
  return_loss?: NullableNumber;
  risk_level?: 'none' | 'light' | 'medium' | 'severe';
  risk_tags?: string[];
}

export interface McpMarginSnapshot {
  base_price: NullableNumber;
  target_price: NullableNumber;
  referral_fee: NullableNumber;
  fba_fee: NullableNumber;
  platform_margin_rate: NullableNumber;
  product_full_cost: NullableNumber;
  final_margin_rate: NullableNumber;
  platform_margin_pass: boolean;
  final_margin_pass: boolean;
  warnings: string[];
}

export interface McpCandidateRecord {
  id: string;
  asin: string;
  keyword: string;
  saved_at: string;
  excel_result?: ProductExcelData | null;
  mcp_result?: ProductMcpSnapshot | null;
  front_review_status?: 'pending' | 'passed' | 'failed';
  final_advice?: string;
  product: ProductMcpSnapshot | null;
  keyword_snapshot: McpKeywordSnapshot | null;
  validation: McpValidationResult;
  costs: McpManualCostInput;
  margin: McpMarginSnapshot;
  notes: string;
}

export type ProductMcpStatus = 'not_checked' | 'checking' | 'checked' | 'failed';

export interface ProductExcelData {
  asin: string;
  title: NullableString;
  brand: NullableString;
  category: NullableString;
  price_mid: NullableNumber;
  rating: NullableNumber;
  review_count: NullableNumber;
  monthly_sales: NullableNumber;
  monthly_revenue: NullableNumber;
  bsr: NullableNumber;
  fba_fee: NullableNumber;
  seller: NullableString;
  seller_type: NullableString;
  variation_count: NullableNumber;
  fulfillment_type: NullableString;
  raw?: unknown;
}

export interface ProductMcpSnapshot {
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
  keyword_summary: McpKeywordSnapshot | null;
  traffic_summary: unknown;
  prediction_summary: McpPredictionSnapshot | null;
  raw: {
    asin_detail: unknown;
    asin_prediction: unknown;
    traffic_keyword_stat: unknown;
    keyword_miner: unknown;
  };
}

export interface ProductManualData {
  fba_fee: NullableNumber;
  purchase_cost_usd: NullableNumber;
  first_mile_cost_usd: NullableNumber;
  package_cost_usd: NullableNumber;
  storage_cost_usd: NullableNumber;
  platform_other_fee: NullableNumber;
  return_loss: NullableNumber;
  referral_fee_rate: NullableNumber;
  risk_level: 'none' | 'light' | 'medium' | 'severe';
  risk_tags: string[];
  front_review_status: 'pending' | 'passed' | 'failed';
  notes: string;
}

export interface ResolvedProductData {
  asin: string;
  title: NullableString;
  brand: NullableString;
  category: NullableString;
  competitor_price: NullableNumber;
  price_source: string;
  rating: NullableNumber;
  review_count: NullableNumber;
  monthly_sales: NullableNumber;
  monthly_revenue: NullableNumber;
  bsr: NullableNumber;
  fba_fee: NullableNumber;
  fba_fee_source: string;
  seller: NullableString;
  seller_type: NullableString;
  variation_count: NullableNumber;
  keyword: NullableString;
  keyword_summary: McpKeywordSnapshot | null;
  missing_notes: string[];
}

export interface ScorePart {
  score: number;
  max: number;
  label: string;
  notes: string[];
}

export interface ProductScoreResult {
  low_review_sales_score: ScorePart & {
    sales_per_review: NullableNumber;
    signal: string;
  };
  price_margin_score: ScorePart & {
    target_price_3: NullableNumber;
    target_price_5: NullableNumber;
    target_price_8: NullableNumber;
    target_price_10: NullableNumber;
    platform_margin_rate: NullableNumber;
    platform_costs: NullableNumber;
    fba_fee_estimated: boolean;
  };
  final_margin_score: ScorePart & {
    full_costs: NullableNumber;
    full_profit: NullableNumber;
    full_margin_rate: NullableNumber;
    cost_confirmed: boolean;
  };
  low_bid_ad_score: ScorePart & {
    long_tail_keyword_count: number;
    signal: string;
  };
  listing_safety_score: ScorePart & {
    risk_level: ProductManualData['risk_level'];
  };
  flea_market_score: number;
  layer: 'A低评论出单优先池' | 'B价格压制测试池' | 'C小类目观察池' | 'D竞争偏高池' | 'E放弃池' | '待复核';
  layer_reasons: string[];
}

export interface ProductRecord {
  id: string;
  asin: string;
  excel: ProductExcelData;
  manual: ProductManualData;
  mcp_status: ProductMcpStatus;
  mcp_checked_at: string | null;
  mcp_snapshot: ProductMcpSnapshot | null;
  mcp_error: string | null;
  score: ProductScoreResult;
  candidate_saved_at?: string | null;
}
