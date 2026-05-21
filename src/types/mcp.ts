export type McpCallStatus = 'idle' | 'loading' | 'success' | 'failed' | 'timeout';

export type NullableNumber = number | null;
export type NullableString = string | null;
export type LongTailOpportunityLevel = 'strong' | 'medium' | 'weak' | 'unknown';
export type KeywordSnapshotType = 'main' | 'long_tail' | 'auto_generated' | 'manual';
export type RatingRiskLevel =
  | 'no_rating_opportunity'
  | 'unstable_rating_sample'
  | 'low_rating_risk'
  | 'severe_low_rating_risk'
  | 'normal';
export type DuplicateStatus =
  | 'exact_asin_duplicate'
  | 'parent_asin_duplicate'
  | 'similar_title_duplicate'
  | 'possible_same_product'
  | 'already_rejected'
  | 'already_developed'
  | 'launched';

export interface AmazonCategoryNode {
  id: string;
  node_id: string;
  name: string;
  name_cn: NullableString;
  path: string;
  level: number;
  parent_id: NullableString;
  children: AmazonCategoryNode[];
  is_leaf: boolean;
  marketplace: string;
  raw: unknown;
}

export interface CategorySelection {
  node_id: string;
  name: string;
  path: string;
  level: number;
  is_leaf: boolean;
  selected_at: string;
}

export interface DiscoveryFilters {
  marketplace: string;
  keyword_optional: string;
  price_min: number;
  price_max: number;
  monthly_sales_min: number;
  monthly_sales_max: number;
  review_count_max: number;
  rating_min: number;
  limit: number;
  listing_range_days: 30 | 90 | 180 | 365 | null;
  listed_days_min: number;
  listed_days_max: number;
  prioritize_recent: boolean;
  strict_rating_filter_enabled: boolean;
  leaf_only: boolean;
  exclude_history: boolean;
  hide_parent_duplicates: boolean;
  hide_similar_products: boolean;
}

export interface DiscoveryRun {
  id: string;
  run_type: 'category_manual';
  marketplace: string;
  category_node_id: string;
  category_path: string;
  keyword_optional: string;
  filters: DiscoveryFilters;
  started_at: string;
  finished_at: string | null;
  status: 'loading' | 'success' | 'failed';
  total_mcp_calls: number;
  total_results: number;
  hidden_duplicates: number;
  saved_candidates: number;
  errors: string[];
}

export interface McpDiscoveredProduct {
  asin: string;
  parent_asin: NullableString;
  title: NullableString;
  brand: NullableString;
  category: NullableString;
  sub_category: NullableString;
  category_node_id: NullableString;
  category_path: NullableString;
  price: NullableNumber;
  coupon_price: NullableNumber;
  monthly_sales: NullableNumber;
  monthly_revenue: NullableNumber;
  review_count: NullableNumber;
  rating: NullableNumber;
  bsr: NullableNumber;
  fba_fee: NullableNumber;
  seller: NullableString;
  seller_type: NullableString;
  is_amazon: boolean;
  variation_count: NullableNumber;
  product_url: NullableString;
  listed_at: NullableString;
  launch_date: NullableString;
  first_available_date: NullableString;
  product_age_days: NullableNumber;
  listed_days: NullableNumber;
  is_recent_product: boolean;
  recent_product_level: RecentProductLevel;
  source_keyword: NullableString;
  source_type: 'category_node';
  source_node_id: string;
  source_category_path: string;
  discovered_at: string;
  raw: unknown;
}

export type RecentProductLevel = '新品观察' | '新品优先' | '稳定新品' | '老品' | '时间缺失';

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
  referral_fee: NullableNumber;
  referral_fee_rate: NullableNumber;
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

export interface KeywordSnapshot extends McpKeywordSnapshot {
  keyword_type: KeywordSnapshotType;
  checked_at: string;
  error: NullableString;
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
  main_keyword?: string;
  long_tail_keywords?: string[];
  keyword_snapshots?: KeywordSnapshot[];
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
  front_review_status?: FrontReviewStatus;
  front_review?: FrontReview | null;
  flea_market_score?: NullableNumber;
  decision?: ProductDecisionResult | null;
  final_advice?: string;
  product: ProductMcpSnapshot | null;
  keyword_snapshot: McpKeywordSnapshot | null;
  main_keyword?: string;
  long_tail_keywords?: string[];
  keyword_snapshots?: KeywordSnapshot[];
  long_tail_opportunity_level?: LongTailOpportunityLevel;
  low_bid_ad_score?: NullableNumber;
  recommended_sp_keywords?: string[];
  rejected_keywords?: string[];
  validation: McpValidationResult;
  costs: McpManualCostInput;
  margin: McpMarginSnapshot;
  notes: string;
  discovery_product?: McpDiscoveredProduct | null;
  discovery_run_id?: string | null;
  source_data?: 'mcp_category_discovery' | 'mcp_validation';
  duplicate_status?: DuplicateStatus[];
  decision_status?: 'candidate' | 'rejected' | 'developed' | 'launched';
}

export type ProductMcpStatus = 'not_checked' | 'checking' | 'checked' | 'failed';
export type TriState = true | false | 'unknown';
export type FrontReviewStatus = 'not_started' | 'in_progress' | 'passed' | 'failed' | 'need_second_check';
export type ReviewStrength = 'weak' | 'normal' | 'strong';
export type ReviewRiskLevel = 'low' | 'medium' | 'high';
export type FrontDecision = 'develop' | 'small_test' | 'wait' | 'reject';

export interface FrontReview {
  asin: string;
  status: FrontReviewStatus;
  reviewed_at: string | null;
  reviewer: string;
  amazon_url: string;
  search_url: string;
  notes: string;
  front_price: NullableNumber;
  coupon_value: NullableNumber;
  actual_buybox_price: NullableNumber;
  price_match_mcp: TriState;
  can_undercut_3: TriState;
  can_undercut_5: TriState;
  can_undercut_8: TriState;
  can_undercut_10: TriState;
  price_notes: string;
  front_review_count: NullableNumber;
  front_rating: NullableNumber;
  review_count_match_mcp: TriState;
  variation_count_front: NullableNumber;
  reviews_concentrated_in_old_variants: TriState;
  low_review_competitors_exist: TriState;
  review_notes: string;
  main_image_quality: ReviewStrength;
  aplus_quality: 'none' | ReviewStrength;
  has_video: TriState;
  bullet_quality: ReviewStrength;
  title_quality: ReviewStrength;
  page_weakness_notes: string;
  brand_monopoly: ReviewRiskLevel;
  amazon_self_operated: TriState;
  seller_count_level: ReviewRiskLevel;
  ip_risk: ReviewRiskLevel;
  compliance_risk: ReviewRiskLevel;
  return_risk: ReviewRiskLevel;
  product_complexity: 'simple' | 'medium' | 'complex';
  risk_notes: string;
  differentiation_space: ReviewRiskLevel;
  sp_low_bid_opportunity: ReviewRiskLevel | 'unknown';
  spv_or_video_opportunity: ReviewRiskLevel;
  can_use_price_undercut_strategy: TriState;
  recommended_ad_keywords: string;
  ad_notes: string;
  front_review_score: number;
  front_review_level: string;
  front_review_flags: string[];
  final_manual_decision: FrontDecision;
}

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
  referral_fee: NullableNumber;
  referral_fee_rate: NullableNumber;
  seller: NullableString;
  seller_type: NullableString;
  variation_count: NullableNumber;
  buybox_seller: NullableString;
  fulfillment_type: NullableString;
  listed_at: NullableString;
  launch_date: NullableString;
  first_available_date: NullableString;
  product_age_days: NullableNumber;
  listed_days: NullableNumber;
  is_recent_product: boolean;
  recent_product_level: RecentProductLevel;
  main_keyword: NullableString;
  long_tail_keywords: string[];
  keyword_snapshots: KeywordSnapshot[];
  long_tail_opportunity_level: LongTailOpportunityLevel;
  recommended_sp_keywords: string[];
  rejected_keywords: string[];
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
  listed_at: NullableString;
  launch_date: NullableString;
  first_available_date: NullableString;
  product_age_days: NullableNumber;
  listed_days: NullableNumber;
  is_recent_product: boolean;
  recent_product_level: RecentProductLevel;
  main_keyword: NullableString;
  long_tail_keywords: string[];
  keyword_snapshots: KeywordSnapshot[];
  long_tail_opportunity_level: LongTailOpportunityLevel;
  recommended_sp_keywords: string[];
  rejected_keywords: string[];
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
    opportunity_level: LongTailOpportunityLevel;
    recommended_keywords: string[];
  };
  listing_safety_score: ScorePart & {
    risk_level: ProductManualData['risk_level'];
  };
  flea_market_score: number;
  rating_risk_level: RatingRiskLevel;
  rating_risk_note: string;
  layer: 'A低评论出单优先池' | 'B价格压制测试池' | 'C小类目观察池' | 'D竞争偏高池' | 'E放弃池' | '待复核';
  layer_reasons: string[];
}

export interface FinalDecisionStage {
  status: 'passed' | 'pending' | 'failed';
  label: string;
  reasons: string[];
}

export interface ProductDecisionResult {
  excel_screening: FinalDecisionStage;
  mcp_review: FinalDecisionStage;
  front_review: FinalDecisionStage;
  profit_check: FinalDecisionStage;
  final_decision: FrontDecision;
  reasons: string[];
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
  front_review: FrontReview;
  score: ProductScoreResult;
  decision: ProductDecisionResult;
  candidate_saved_at?: string | null;
}
