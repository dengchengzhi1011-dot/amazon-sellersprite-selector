import type {
  CandidateDecisionStatus,
  CategoryScanRecord,
  CategoryScanStatus,
  DevelopmentRecord,
  DiscoveryResult,
  DiscoveryRun,
  DuplicateStatus,
  FrontReview,
  HistoryRecord,
  McpCandidateRecord,
  McpDiscoveredProduct,
  McpManualCostInput,
  McpMarginSnapshot,
  McpValidationSession,
  McpValidationResult,
  ProductExcelData,
  ProductManualData,
  ProductMcpSnapshot,
  ProductRecord,
} from '../types/mcp';
import { calculateNewProductSalesSignalScore, calculateRatingRiskLevel, createExcelFromMcpSnapshot, decideProduct, resolveProductData, scoreFrontReview, scoreProduct } from './scoring';
import { extractImageUrl } from './imageTools';
import { generateLongTailKeywordCandidates } from './keywordTools';

const productsStorageKey = 'amazon-sellersprite-selector:products';
const candidatesStorageKey = 'amazon-sellersprite-selector:mcp-candidates';
const discoveryRunsStorageKey = 'amazon-sellersprite-selector:discovery-runs';
const discoveryResultsStorageKey = 'amazon-sellersprite-selector:discovery-results';
const categoryScanRecordsStorageKey = 'amazon-sellersprite-selector:category-scan-records';
const mcpValidationSessionsStorageKey = 'mcp-validation-sessions';
const historyLibraryStorageKey = 'amazon-sellersprite-selector:history-library';
const launchedStorageKey = 'amazon-sellersprite-selector:launched-records';
const developmentStorageKey = 'amazon-sellersprite-selector:development-records';
const maxDiscoveryRuns = 50;
const maxDiscoveryResultsPerRun = 50;
const maxMcpValidationSessions = 100;
const maxCategoryScanRecords = 1000;

export const defaultManualData: ProductManualData = {
  fba_fee: null,
  purchase_cost_rmb: null,
  exchange_rate: 7.2,
  purchase_cost_usd: null,
  first_mile_cost_usd: null,
  package_cost_usd: null,
  storage_cost_usd: null,
  platform_other_fee: null,
  return_loss: null,
  referral_fee_rate: 0.15,
  target_price: null,
  risk_level: 'none',
  risk_tags: [],
  front_review_status: 'pending',
  notes: '',
};

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function loadCategoryScanRecords(): CategoryScanRecord[] {
  try {
    const raw = window.localStorage.getItem(categoryScanRecordsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((item): item is CategoryScanRecord => Boolean(item?.node_id))
      .map((item) => {
        const nextScanAt = item.next_scan_at ?? null;
        const baseStatus = item.scan_status ?? 'scanned';
        const scanStatus =
          baseStatus !== 'failed' &&
          baseStatus !== 'blacklisted' &&
          nextScanAt &&
          new Date(nextScanAt).getTime() <= now
            ? 'expired'
            : baseStatus;
        const ACount = Number.isFinite(item.A_count) ? item.A_count : 0;
        const ACandidateCount = Number.isFinite(item.A_candidate_count) ? item.A_candidate_count : 0;
        const BCount = Number.isFinite(item.B_count) ? item.B_count : 0;
        const CCount = Number.isFinite(item.C_count) ? item.C_count : 0;
        const lastResultCount = Number.isFinite(item.last_result_count) ? item.last_result_count : 0;
        return {
          node_id: item.node_id,
          node_name: item.node_name ?? '',
          category_path: item.category_path ?? '',
          level: Number.isFinite(item.level) ? item.level : 1,
          last_scan_at: item.last_scan_at ?? null,
          next_scan_at: nextScanAt,
          scan_count: Number.isFinite(item.scan_count) ? item.scan_count : 0,
          last_result_count: lastResultCount,
          raw_result_count: Number.isFinite(item.raw_result_count) ? item.raw_result_count : lastResultCount,
          filtered_result_count: Number.isFinite(item.filtered_result_count) ? item.filtered_result_count : lastResultCount,
          testable_count: Number.isFinite(item.testable_count) ? item.testable_count : ACount + ACandidateCount + BCount + CCount,
          A_count: ACount,
          A_candidate_count: ACandidateCount,
          B_count: BCount,
          C_count: CCount,
          D_count: Number.isFinite(item.D_count) ? item.D_count : 0,
          E_count: Number.isFinite(item.E_count) ? item.E_count : 0,
          best_score: typeof item.best_score === 'number' ? item.best_score : null,
          scan_status: scanStatus,
          scan_note: item.scan_note ?? '',
        };
      });
  } catch {
    return [];
  }
}

export function loadCategoryScanRecordMap(): Record<string, CategoryScanRecord> {
  return loadCategoryScanRecords().reduce<Record<string, CategoryScanRecord>>((map, record) => {
    map[record.node_id] = record;
    return map;
  }, {});
}

export function saveCategoryScanRecords(records: CategoryScanRecord[]) {
  const unique = new Map<string, CategoryScanRecord>();
  records.forEach((record) => unique.set(record.node_id, record));
  const retained = Array.from(unique.values())
    .sort((left, right) => String(right.last_scan_at ?? '').localeCompare(String(left.last_scan_at ?? '')))
    .slice(0, maxCategoryScanRecords);
  window.localStorage.setItem(categoryScanRecordsStorageKey, JSON.stringify(retained));
}

export function upsertCategoryScanRecord(record: CategoryScanRecord): CategoryScanRecord[] {
  const previous = loadCategoryScanRecords().find((item) => item.node_id === record.node_id);
  const nextRecord = previous?.scan_status === 'blacklisted'
    ? { ...record, scan_status: 'blacklisted' as const, next_scan_at: null }
    : record;
  const next = [nextRecord, ...loadCategoryScanRecords().filter((item) => item.node_id !== record.node_id)];
  saveCategoryScanRecords(next);
  return loadCategoryScanRecords();
}

export function deriveCategoryScanStatus(params: {
  raw_result_count: number;
  filtered_result_count: number;
  testable_count: number;
  A_count: number;
  A_candidate_count: number;
  B_count: number;
  C_count: number;
  D_count: number;
  E_count: number;
  failed?: boolean;
}): CategoryScanStatus {
  if (params.failed) return 'failed';
  if (params.raw_result_count === 0) return 'raw_empty';
  if (params.filtered_result_count === 0) return 'filtered_empty';
  if (params.testable_count === 0) return 'no_testable';
  const opportunityCount = params.A_count + params.A_candidate_count + params.B_count;
  if (opportunityCount > 0) return 'priority_rescan';
  if (params.C_count > 0) return 'watch_rescan';
  if (params.filtered_result_count > 0 && params.E_count / params.filtered_result_count >= 0.8) return 'cooling';
  if (params.D_count > 0) return 'cooling';
  return 'scanned';
}

export function calculateCategoryNextScanAt(status: CategoryScanStatus, counts: Pick<CategoryScanRecord, 'last_result_count' | 'raw_result_count' | 'filtered_result_count' | 'testable_count' | 'A_count' | 'A_candidate_count' | 'B_count' | 'C_count' | 'D_count' | 'E_count'>, fromIso: string): string | null {
  if (status === 'blacklisted') return null;
  if (status === 'failed' || status === 'filtered_empty') return fromIso;
  if (status === 'raw_empty' || status === 'no_testable') return addDays(fromIso, 45);
  if (counts.A_count + counts.A_candidate_count + counts.B_count > 0) return addDays(fromIso, 10);
  if (counts.C_count >= 3 || counts.C_count > counts.D_count) return addDays(fromIso, 21);
  if (counts.D_count > 0 && counts.E_count === 0) return addDays(fromIso, 30);
  if (counts.filtered_result_count > 0 && counts.E_count / counts.filtered_result_count >= 0.8) return addDays(fromIso, 75);
  return addDays(fromIso, 30);
}

export function isCategoryScanDue(record: CategoryScanRecord, now = new Date()): boolean {
  if (record.scan_status === 'failed') return true;
  if (record.scan_status === 'blacklisted') return false;
  if (!record.next_scan_at) return true;
  return new Date(record.next_scan_at).getTime() <= now.getTime();
}

const seedExcel: ProductExcelData = {
  asin: 'B0GJSCQ3PS',
  title: '小样本验证产品',
  brand: null,
  category: null,
  price_mid: null,
  rating: null,
  review_count: null,
  monthly_sales: null,
  monthly_revenue: null,
  bsr: null,
  fba_fee: null,
  seller: null,
  seller_type: null,
  variation_count: null,
  fulfillment_type: null,
  raw: { source: 'seed' },
};

export function createDefaultFrontReview(asin: string): FrontReview {
  const trimmedAsin = asin.trim();
  return {
    asin: trimmedAsin,
    status: 'not_started',
    reviewed_at: null,
    reviewer: '',
    amazon_url: trimmedAsin ? `https://www.amazon.com/dp/${trimmedAsin}` : 'https://www.amazon.com',
    search_url: 'https://www.amazon.com/s?k=',
    notes: '',
    front_price: null,
    coupon_value: null,
    actual_buybox_price: null,
    price_match_mcp: 'unknown',
    can_undercut_3: 'unknown',
    can_undercut_5: 'unknown',
    can_undercut_8: 'unknown',
    can_undercut_10: 'unknown',
    price_notes: '',
    front_review_count: null,
    front_rating: null,
    review_count_match_mcp: 'unknown',
    variation_count_front: null,
    reviews_concentrated_in_old_variants: 'unknown',
    low_review_competitors_exist: 'unknown',
    review_notes: '',
    main_image_quality: 'normal',
    aplus_quality: 'normal',
    has_video: 'unknown',
    bullet_quality: 'normal',
    title_quality: 'normal',
    page_weakness_notes: '',
    brand_monopoly: 'low',
    amazon_self_operated: 'unknown',
    seller_count_level: 'low',
    ip_risk: 'low',
    compliance_risk: 'low',
    return_risk: 'low',
    product_complexity: 'simple',
    risk_notes: '',
    differentiation_space: 'medium',
    sp_low_bid_opportunity: 'unknown',
    spv_or_video_opportunity: 'medium',
    can_use_price_undercut_strategy: 'unknown',
    recommended_ad_keywords: '',
    ad_notes: '',
    front_review_score: 0,
    front_review_level: '未开始',
    front_review_flags: [],
    final_manual_decision: 'wait',
  };
}

function normalizeFrontReview(asin: string, frontReview?: Partial<FrontReview> | null): FrontReview {
  return scoreFrontReview({
    ...createDefaultFrontReview(asin),
    ...frontReview,
    asin,
  });
}

type ProductInput = Omit<ProductRecord, 'score' | 'decision' | 'front_review'> & {
  front_review?: Partial<FrontReview> | null;
  score?: ProductRecord['score'];
  decision?: ProductRecord['decision'];
};

function withScore(product: ProductInput): ProductRecord {
  const frontReview = normalizeFrontReview(product.asin, product.front_review);
  const record = { ...product, front_review: frontReview } as ProductRecord;
  const score = scoreProduct(record);
  const scored = { ...record, score } as ProductRecord;
  return { ...scored, decision: decideProduct(scored, score) };
}

export function createProductFromExcel(excel: ProductExcelData): ProductRecord {
  return withScore({
    id: excel.asin,
    asin: excel.asin,
    excel,
    manual: { ...defaultManualData },
    mcp_status: 'not_checked',
    mcp_checked_at: null,
    mcp_snapshot: null,
    mcp_error: null,
    front_review: createDefaultFrontReview(excel.asin),
    candidate_saved_at: null,
  });
}

function normalizeProduct(raw: ProductRecord): ProductRecord {
  return withScore({
    ...raw,
    manual: { ...defaultManualData, ...raw.manual },
    mcp_status: raw.mcp_status ?? 'not_checked',
    mcp_checked_at: raw.mcp_checked_at ?? null,
    mcp_snapshot: raw.mcp_snapshot ?? null,
    mcp_error: raw.mcp_error ?? null,
    front_review: raw.front_review ?? createDefaultFrontReview(raw.asin),
  });
}

export function loadProducts(): ProductRecord[] {
  try {
    const raw = window.localStorage.getItem(productsStorageKey);
    if (!raw) return [createProductFromExcel(seedExcel)];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [createProductFromExcel(seedExcel)];
    return parsed.map((item) => normalizeProduct(item));
  } catch {
    return [createProductFromExcel(seedExcel)];
  }
}

export function saveProducts(products: ProductRecord[]) {
  window.localStorage.setItem(productsStorageKey, JSON.stringify(products.map((product) => withScore(product))));
}

export function upsertProductMcpData(params: {
  products: ProductRecord[];
  asin: string;
  mcpSnapshot: ProductMcpSnapshot | null;
  validation: McpValidationResult;
  manualCosts?: McpManualCostInput;
  notes?: string;
  markCandidate?: boolean;
}): ProductRecord[] {
  const asin = params.asin.trim();
  const now = new Date().toISOString();
  const error = params.validation.errors[params.validation.errors.length - 1] ?? null;
  const status = params.mcpSnapshot ? 'checked' : 'failed';
  const existing = params.products.find((product) => product.asin === asin);
  const manualFromCosts = mapManualCosts(params.manualCosts, existing?.manual, params.notes);
  const base: ProductRecord =
    existing ??
    createProductFromExcel({
      ...createExcelFromMcpSnapshot(asin, params.mcpSnapshot),
      asin,
    });

  const updated = withScore({
    ...base,
    manual: { ...base.manual, ...manualFromCosts },
    mcp_status: status,
    mcp_checked_at: now,
    mcp_snapshot: mergeProductMcpSnapshots(base.mcp_snapshot, params.mcpSnapshot),
    mcp_error: status === 'failed' ? error : null,
    candidate_saved_at: params.markCandidate ? now : base.candidate_saved_at ?? null,
  });

  const next = [updated, ...params.products.filter((product) => product.asin !== asin)];
  saveProducts(next);
  return next;
}

function mergeProductMcpSnapshots(previous: ProductMcpSnapshot | null, next: ProductMcpSnapshot | null): ProductMcpSnapshot | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...previous,
    ...next,
    asin: next.asin ?? previous.asin,
    title: next.title ?? previous.title,
    brand: next.brand ?? previous.brand,
    category: next.category ?? previous.category,
    price: next.price ?? previous.price,
    coupon_price: next.coupon_price ?? previous.coupon_price,
    rating: next.rating ?? previous.rating,
    review_count: next.review_count ?? previous.review_count,
    bsr: next.bsr ?? previous.bsr,
    monthly_sales: next.monthly_sales ?? previous.monthly_sales,
    monthly_revenue: next.monthly_revenue ?? previous.monthly_revenue,
    fba_fee: next.fba_fee ?? previous.fba_fee,
    fba_fee_source: next.fba_fee_source ?? previous.fba_fee_source,
    referral_fee: next.referral_fee ?? previous.referral_fee,
    referral_fee_rate: next.referral_fee_rate ?? previous.referral_fee_rate,
    referral_fee_rate_source: next.referral_fee_rate_source ?? previous.referral_fee_rate_source,
    main_image_url: next.main_image_url ?? previous.main_image_url,
    main_image_source: next.main_image_source ?? previous.main_image_source,
    seller: next.seller ?? previous.seller,
    seller_type: next.seller_type ?? previous.seller_type,
    variation_count: next.variation_count ?? previous.variation_count,
    buybox_seller: next.buybox_seller ?? previous.buybox_seller,
    fulfillment_type: next.fulfillment_type ?? previous.fulfillment_type,
    listed_at: next.listed_at ?? previous.listed_at,
    listed_at_source: next.listed_at_source ?? previous.listed_at_source,
    launch_date: next.launch_date ?? previous.launch_date,
    first_available_date: next.first_available_date ?? previous.first_available_date,
    product_age_days: next.product_age_days ?? previous.product_age_days,
    listed_days: next.listed_days ?? previous.listed_days,
    is_recent_product: next.product_age_days !== null ? next.is_recent_product : previous.is_recent_product,
    recent_product_level: next.product_age_days !== null ? next.recent_product_level : previous.recent_product_level,
    main_keyword: next.main_keyword ?? previous.main_keyword,
    long_tail_keywords: next.long_tail_keywords.length ? next.long_tail_keywords : previous.long_tail_keywords,
    keyword_snapshots: next.keyword_snapshots.length ? next.keyword_snapshots : previous.keyword_snapshots,
    keyword_insights: next.keyword_insights.length ? next.keyword_insights : previous.keyword_insights,
    keyword_data_confidence: next.keyword_data_confidence !== 'unknown' ? next.keyword_data_confidence : previous.keyword_data_confidence,
    keyword_source: next.keyword_source ?? previous.keyword_source,
    demand_confirmed: next.demand_confirmed ?? previous.demand_confirmed,
    demand_confirm_source: next.demand_confirm_source ?? previous.demand_confirm_source,
    long_tail_opportunity_level:
      next.long_tail_opportunity_level !== 'unknown'
        ? next.long_tail_opportunity_level
        : previous.long_tail_opportunity_level,
    recommended_sp_keywords: next.recommended_sp_keywords.length ? next.recommended_sp_keywords : previous.recommended_sp_keywords,
    rejected_keywords: next.rejected_keywords.length ? next.rejected_keywords : previous.rejected_keywords,
    mcp_request_status_summary: next.mcp_request_status_summary ?? previous.mcp_request_status_summary,
    mcp_data_status_summary: next.mcp_data_status_summary ?? previous.mcp_data_status_summary,
    new_product_sales_signal: next.new_product_sales_signal ?? previous.new_product_sales_signal,
    new_product_sales_signal_score: next.new_product_sales_signal_score ?? previous.new_product_sales_signal_score,
    sales_per_review: next.sales_per_review ?? previous.sales_per_review,
    sales_data_confidence_score: next.sales_data_confidence_score ?? previous.sales_data_confidence_score,
    variation_risk_score: next.variation_risk_score ?? previous.variation_risk_score,
    action_flags: next.action_flags?.length ? next.action_flags : previous.action_flags,
    score_explanation: next.score_explanation?.length ? next.score_explanation : previous.score_explanation,
    review_tasks: next.review_tasks?.length ? next.review_tasks : previous.review_tasks,
    layer: next.layer ?? previous.layer,
    layer_reason_type: next.layer_reason_type ?? previous.layer_reason_type,
    is_a_candidate: next.is_a_candidate ?? previous.is_a_candidate,
    keyword_summary: next.keyword_summary ?? previous.keyword_summary,
    traffic_summary: next.traffic_summary ?? previous.traffic_summary,
    prediction_summary: next.prediction_summary ?? previous.prediction_summary,
  };
}

export function updateProductFrontReview(products: ProductRecord[], asin: string, frontReview: Partial<FrontReview>): ProductRecord[] {
  const targetAsin = asin.trim();
  const next = products.map((product) =>
    product.asin === targetAsin
      ? withScore({
          ...product,
          front_review: {
            ...product.front_review,
            ...frontReview,
            asin: targetAsin,
          },
        })
      : withScore(product),
  );
  const updated = next.find((product) => product.asin === targetAsin);
  saveProducts(next);
  if (updated) syncCandidateFrontReviews(updated);
  return next;
}

export function updateProductManualData(products: ProductRecord[], asin: string, manualPatch: Partial<ProductManualData>): ProductRecord[] {
  const targetAsin = asin.trim();
  const next = products.map((product) =>
    product.asin === targetAsin
      ? withScore({
          ...product,
          manual: {
            ...product.manual,
            ...manualPatch,
          },
        })
      : withScore(product),
  );
  const updated = next.find((product) => product.asin === targetAsin);
  saveProducts(next);
  if (updated) syncCandidateProduct(updated);
  return next;
}

function mapManualCosts(costs?: McpManualCostInput, existing: ProductManualData = defaultManualData, notes = ''): ProductManualData {
  if (!costs) return { ...existing, notes: notes || existing.notes };
  return {
    ...existing,
    fba_fee: costs.manual_fba_fee ?? existing.fba_fee,
    purchase_cost_rmb: existing.purchase_cost_rmb ?? null,
    exchange_rate: existing.exchange_rate ?? 7.2,
    purchase_cost_usd: costs.purchase_cost ?? existing.purchase_cost_usd,
    first_mile_cost_usd: costs.first_leg_shipping ?? existing.first_mile_cost_usd,
    package_cost_usd: costs.packaging_cost ?? existing.package_cost_usd,
    storage_cost_usd: costs.storage_cost_usd ?? existing.storage_cost_usd,
    platform_other_fee: costs.platform_other_fee ?? existing.platform_other_fee,
    return_loss: costs.return_loss ?? existing.return_loss,
    referral_fee_rate: costs.referral_fee_rate ?? existing.referral_fee_rate,
    target_price: existing.target_price ?? null,
    risk_level: costs.risk_level ?? existing.risk_level,
    risk_tags: costs.risk_tags ?? existing.risk_tags,
    notes: notes || existing.notes,
  };
}

export function loadCandidates(): McpCandidateRecord[] {
  try {
    const raw = window.localStorage.getItem(candidatesStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((candidate) => ({
          ...candidate,
          front_review_status: candidate.front_review?.status ?? candidate.front_review_status ?? 'not_started',
          flea_market_score: candidate.flea_market_score ?? null,
          decision: candidate.decision ?? null,
          source_data: candidate.source_data ?? (candidate.discovery_product ? 'mcp_category_discovery' : 'mcp_validation'),
          duplicate_status: candidate.duplicate_status ?? [],
          decision_status: candidate.decision_status ?? 'candidate',
          main_keyword: candidate.main_keyword ?? candidate.mcp_result?.main_keyword ?? candidate.keyword ?? '',
          long_tail_keywords: candidate.long_tail_keywords ?? candidate.mcp_result?.long_tail_keywords ?? [],
          keyword_snapshots: candidate.keyword_snapshots ?? candidate.mcp_result?.keyword_snapshots ?? [],
          keyword_insights: candidate.keyword_insights ?? candidate.mcp_result?.keyword_insights ?? [],
          keyword_data_confidence: candidate.keyword_data_confidence ?? candidate.mcp_result?.keyword_data_confidence ?? 'unknown',
          long_tail_opportunity_level: candidate.long_tail_opportunity_level ?? candidate.mcp_result?.long_tail_opportunity_level ?? 'unknown',
          low_bid_ad_score: candidate.low_bid_ad_score ?? null,
          recommended_sp_keywords: candidate.recommended_sp_keywords ?? candidate.mcp_result?.recommended_sp_keywords ?? [],
          rejected_keywords: candidate.rejected_keywords ?? candidate.mcp_result?.rejected_keywords ?? [],
        }))
      : [];
  } catch {
    return [];
  }
}

export function saveCandidates(candidates: McpCandidateRecord[]) {
  window.localStorage.setItem(candidatesStorageKey, JSON.stringify(candidates));
}

export function listMcpValidationSessions(): McpValidationSession[] {
  try {
    const raw = window.localStorage.getItem(mcpValidationSessionsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .map(normalizeMcpValidationSession)
          .filter((item): item is McpValidationSession => Boolean(item))
          .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      : [];
  } catch {
    return [];
  }
}

export function saveMcpValidationSession(session: McpValidationSession): McpValidationSession[] {
  const now = new Date().toISOString();
  const existing = listMcpValidationSessions().find((item) => item.id === session.id);
  const normalizedSnapshot = enrichSnapshotImage(session.normalized_snapshot, {
    asin_detail: session.asin_detail_result?.raw ?? session.raw_responses?.asin_detail,
    asin_prediction: session.asin_prediction_result?.raw ?? session.raw_responses?.asin_prediction,
  });
  const nextSession: McpValidationSession = {
    ...(existing ?? session),
    ...session,
    normalized_snapshot: normalizedSnapshot,
    created_at: existing?.created_at ?? session.created_at ?? now,
    updated_at: now,
    raw_responses: compactValidationRaw(session.raw_responses),
  };
  const next = [nextSession, ...listMcpValidationSessions().filter((item) => item.id !== nextSession.id)]
    .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
    .slice(0, maxMcpValidationSessions);
  window.localStorage.setItem(mcpValidationSessionsStorageKey, JSON.stringify(next));
  return next;
}

export function getMcpValidationSessionByAsin(asin: string): McpValidationSession | null {
  const target = asin.trim().toUpperCase();
  return listMcpValidationSessions().find((session) => session.asin.trim().toUpperCase() === target) ?? null;
}

export function getLatestMcpValidationSession(): McpValidationSession | null {
  return listMcpValidationSessions()[0] ?? null;
}

export function deleteMcpValidationSession(id: string): McpValidationSession[] {
  const next = listMcpValidationSessions().filter((session) => session.id !== id);
  window.localStorage.setItem(mcpValidationSessionsStorageKey, JSON.stringify(next));
  return next;
}

export function buildNormalizedSnapshotFromSession(session: McpValidationSession): ProductMcpSnapshot | null {
  return session.normalized_snapshot ?? null;
}

function normalizeMcpValidationSession(raw: Partial<McpValidationSession> | null | undefined): McpValidationSession | null {
  if (!raw?.asin) return null;
  const now = new Date().toISOString();
  const rawResponses = raw.raw_responses ?? {
    asin_detail: null,
    asin_prediction: null,
    traffic_keyword_stat: null,
    keyword_miner: null,
    long_tail_keywords: [],
    asin_keywords: null,
  };
  const normalizedSnapshot = enrichSnapshotImage(raw.normalized_snapshot ?? null, {
    asin_detail: raw.asin_detail_result?.raw ?? rawResponses.asin_detail,
    asin_prediction: raw.asin_prediction_result?.raw ?? rawResponses.asin_prediction,
  });
  return {
    id: raw.id ?? `${raw.asin}-${raw.created_at ?? now}`,
    asin: raw.asin,
    main_keyword: raw.main_keyword ?? '',
    long_tail_keywords: raw.long_tail_keywords ?? [],
    source: raw.source ?? 'unknown',
    created_at: raw.created_at ?? now,
    updated_at: raw.updated_at ?? raw.created_at ?? now,
    last_checked_at: raw.last_checked_at ?? null,
    asin_detail_status: raw.asin_detail_status ?? 'idle',
    asin_prediction_status: raw.asin_prediction_status ?? 'idle',
    traffic_keyword_stat_status: raw.traffic_keyword_stat_status ?? 'idle',
    keyword_miner_status: raw.keyword_miner_status ?? 'idle',
    long_tail_keywords_status: raw.long_tail_keywords_status ?? 'idle',
    asin_detail_result: raw.asin_detail_result ?? null,
    asin_prediction_result: raw.asin_prediction_result ?? null,
    traffic_keyword_stat_result: raw.traffic_keyword_stat_result ?? null,
    main_keyword_result: raw.main_keyword_result ?? null,
    long_tail_keyword_results: raw.long_tail_keyword_results ?? [],
    keyword_insights: raw.keyword_insights ?? [],
    keyword_data_confidence: raw.keyword_data_confidence ?? 'unknown',
    keyword_source: raw.keyword_source ?? null,
    demand_confirmed: raw.demand_confirmed ?? false,
    demand_confirm_source: raw.demand_confirm_source ?? null,
    mcp_request_status_summary: raw.mcp_request_status_summary ?? [],
    mcp_data_status_summary: raw.mcp_data_status_summary ?? [],
    raw_responses: rawResponses,
    asin_detail_error: raw.asin_detail_error ?? raw.asin_detail_result?.error ?? null,
    asin_prediction_error: raw.asin_prediction_error ?? raw.asin_prediction_result?.error ?? null,
    traffic_keyword_stat_error: raw.traffic_keyword_stat_error ?? raw.traffic_keyword_stat_result?.error ?? null,
    keyword_miner_error: raw.keyword_miner_error ?? raw.main_keyword_result?.error ?? null,
    long_tail_keyword_errors: raw.long_tail_keyword_errors ?? [],
    normalized_snapshot: normalizedSnapshot,
    field_availability: raw.field_availability ?? [],
    data_flags: raw.data_flags ?? [],
    action_flags: raw.action_flags ?? [],
    score_explanation: raw.score_explanation ?? [],
    review_tasks: raw.review_tasks ?? [],
    saved_as_candidate: raw.saved_as_candidate ?? false,
  };
}

function enrichSnapshotImage(snapshot: ProductMcpSnapshot | null, raw: unknown): ProductMcpSnapshot | null {
  if (!snapshot) return snapshot;
  const mainImageUrl = snapshot.main_image_url ?? extractImageUrl(raw);
  return {
    ...snapshot,
    main_image_url: mainImageUrl,
    main_image_source: mainImageUrl ? (snapshot.main_image_source ?? 'mcp') : 'missing',
  };
}

function compactValidationRaw(raw: McpValidationSession['raw_responses']): McpValidationSession['raw_responses'] {
  return {
    asin_detail: compactDiscoveryRaw(raw.asin_detail),
    asin_prediction: compactDiscoveryRaw(raw.asin_prediction),
    traffic_keyword_stat: compactDiscoveryRaw(raw.traffic_keyword_stat),
    keyword_miner: compactDiscoveryRaw(raw.keyword_miner),
    long_tail_keywords: raw.long_tail_keywords.slice(0, 10).map(compactDiscoveryRaw),
    asin_keywords: compactDiscoveryRaw(raw.asin_keywords ?? null),
  };
}

export function createCandidateRecord(params: {
  asin: string;
  keyword: string;
  product: ProductRecord | null;
  validation: McpValidationResult;
  costs: McpManualCostInput;
  margin: McpMarginSnapshot;
  notes: string;
}): McpCandidateRecord {
  const product = params.product;
  return {
    id: `${Date.now()}-${params.asin || 'unknown'}`,
    asin: params.asin,
    keyword: params.keyword,
    saved_at: new Date().toISOString(),
    excel_result: product?.excel ?? null,
    mcp_result: product?.mcp_snapshot ?? null,
    front_review_status: product?.front_review.status ?? 'not_started',
    front_review: product?.front_review ?? null,
    flea_market_score: product?.score.flea_market_score ?? null,
    decision: product?.decision ?? null,
    final_advice: product?.decision.final_decision ?? product?.score.layer ?? 'wait',
    product: product?.mcp_snapshot ?? null,
    keyword_snapshot: product?.mcp_snapshot?.keyword_summary ?? null,
    main_keyword: product?.mcp_snapshot?.main_keyword ?? params.keyword,
    long_tail_keywords: product?.mcp_snapshot?.long_tail_keywords ?? [],
    keyword_snapshots: product?.mcp_snapshot?.keyword_snapshots ?? [],
    keyword_insights: product?.mcp_snapshot?.keyword_insights ?? [],
    keyword_data_confidence: product?.mcp_snapshot?.keyword_data_confidence ?? 'unknown',
    long_tail_opportunity_level: product?.mcp_snapshot?.long_tail_opportunity_level ?? 'unknown',
    low_bid_ad_score: product?.score.low_bid_ad_score.score ?? null,
    recommended_sp_keywords: product?.mcp_snapshot?.recommended_sp_keywords ?? [],
    rejected_keywords: product?.mcp_snapshot?.rejected_keywords ?? [],
    validation: params.validation,
    costs: params.costs,
    margin: params.margin,
    notes: params.notes,
  };
}

export function exportCandidatesCsv(candidates: McpCandidateRecord[]): string {
  const runs = loadDiscoveryRuns();
  const headers = ['ASIN', '标题', '主图 URL', '主图来源', 'MCP复核状态', '铺货捡漏分', '铺货可上架测试分', '铺货动作建议', '为什么可测', '为什么不是E', '缺失数据待复核项', '是否适合小批量上架', '是否适合低成本试上架', '新品动销信号', '新品动销分', '动销/评论比', '评分解释', 'action_flags', '前台复核分', '平台后毛利率', '全成本毛利率', '最终建议', '主关键词', '长尾关键词', '长尾机会等级', '推荐SP词', '不建议词', '低竞价广告分', 'rating_risk_level', 'rating_risk_note', 'strict_rating_filter_enabled', '备注'];
  const rows = candidates.map((candidate) => {
    const ratingRisk = calculateRatingRiskLevel(candidate.mcp_result?.review_count ?? candidate.excel_result?.review_count, candidate.mcp_result?.rating ?? candidate.excel_result?.rating);
    const run = runs.find((item) => item.id === candidate.discovery_run_id);
    const signal = calculateNewProductSalesSignalScore(candidate.mcp_result ?? candidate.product ?? candidate.discovery_product ?? candidate.excel_result ?? {});
    const scoredDiscovery = candidate.discovery_product ? createProductFromDiscovery(candidate.discovery_product).score : null;
    return [
      candidate.asin,
      candidate.mcp_result?.title ?? candidate.excel_result?.title ?? '',
      candidateMainImageUrl(candidate) ?? '',
      candidateMainImageUrl(candidate) ? 'mcp' : 'missing',
      candidate.product ? 'checked' : 'not_checked',
      candidate.flea_market_score ?? '',
      scoredDiscovery?.listing_test_score.score ?? '',
      scoredDiscovery?.action_advice ?? '',
      scoredDiscovery?.listing_test_score.why_testable.join(' | ') ?? '',
      scoredDiscovery?.listing_test_score.why_not_e.join(' | ') ?? '',
      scoredDiscovery?.listing_test_score.missing_review_items.join(' | ') ?? '',
      scoredDiscovery ? (scoredDiscovery.listing_test_score.suitable_small_batch ? '是' : '否') : '',
      scoredDiscovery ? (scoredDiscovery.listing_test_score.suitable_low_cost_test ? '是' : '否') : '',
      signal?.signal_label ?? '',
      signal?.score ?? '',
      signal?.sales_per_review ?? '',
      signal?.explanation.join(' | ') ?? '',
      signal?.action_flags.join(' | ') ?? '',
      candidate.front_review?.front_review_score ?? '',
      candidate.margin.platform_margin_rate ?? '',
      candidate.margin.final_margin_rate ?? '',
      candidate.final_advice ?? '',
      candidate.main_keyword ?? candidate.mcp_result?.main_keyword ?? '',
      (candidate.long_tail_keywords ?? candidate.mcp_result?.long_tail_keywords ?? []).join(' | '),
      candidate.long_tail_opportunity_level ?? candidate.mcp_result?.long_tail_opportunity_level ?? 'unknown',
      (candidate.recommended_sp_keywords ?? candidate.mcp_result?.recommended_sp_keywords ?? []).join(' | '),
      (candidate.rejected_keywords ?? candidate.mcp_result?.rejected_keywords ?? []).join(' | '),
      candidate.low_bid_ad_score ?? '',
      ratingRisk.level,
      ratingRisk.note,
      run?.filters.strict_rating_filter_enabled ?? '',
      candidate.notes || candidate.front_review?.notes || '',
    ];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function loadHistoryRecords(): HistoryRecord[] {
  try {
    const raw = window.localStorage.getItem(historyLibraryStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeHistoryRecord).filter((item): item is HistoryRecord => Boolean(item)) : [];
  } catch {
    return [];
  }
}

export function saveHistoryRecords(records: HistoryRecord[]) {
  window.localStorage.setItem(historyLibraryStorageKey, JSON.stringify(records));
}

export function deleteHistoryRecord(id: string): HistoryRecord[] {
  const next = loadHistoryRecords().filter((record) => record.id !== id);
  saveHistoryRecords(next);
  return next;
}

export function upsertHistoryRecord(record: HistoryRecord): HistoryRecord[] {
  const existing = loadHistoryRecords().find((item) => item.asin === record.asin);
  const now = new Date().toISOString();
  const nextRecord: HistoryRecord = existing
    ? {
        ...existing,
        ...record,
        first_seen_at: existing.first_seen_at,
        last_seen_at: now,
        seen_count: Math.max(existing.seen_count + 1, record.seen_count ?? 1),
        notes: record.notes || existing.notes,
      }
    : { ...record, first_seen_at: record.first_seen_at || now, last_seen_at: record.last_seen_at || now, seen_count: record.seen_count || 1 };
  const next = [nextRecord, ...loadHistoryRecords().filter((item) => item.asin !== nextRecord.asin)];
  saveHistoryRecords(next);
  return next;
}

function normalizeHistoryRecord(raw: Partial<HistoryRecord> | null | undefined): HistoryRecord | null {
  if (!raw?.asin) return null;
  const now = new Date().toISOString();
  return {
    id: raw.id ?? raw.asin,
    asin: raw.asin,
    parent_asin: raw.parent_asin ?? null,
    title: raw.title ?? null,
    main_image_url: raw.main_image_url ?? null,
    main_image_source: raw.main_image_source ?? (raw.main_image_url ? 'mcp' : 'missing'),
    source: raw.source ?? 'unknown',
    decision_status: raw.decision_status ?? 'candidate',
    decision_result: raw.decision_result ?? '',
    reject_reason: raw.reject_reason ?? '',
    flea_market_score: raw.flea_market_score ?? null,
    front_review_score: raw.front_review_score ?? null,
    final_score: raw.final_score ?? raw.flea_market_score ?? null,
    first_seen_at: raw.first_seen_at ?? now,
    last_seen_at: raw.last_seen_at ?? raw.first_seen_at ?? now,
    seen_count: raw.seen_count ?? 1,
    duplicate_status: raw.duplicate_status ?? [],
    notes: raw.notes ?? '',
    similar_asin: raw.similar_asin ?? null,
  };
}

function isAbandonedStatus(status: CandidateDecisionStatus | string | undefined): boolean {
  return status === 'rejected' || status === 'abandoned';
}

function upsertHistoryFromCandidate(candidate: McpCandidateRecord, status: CandidateDecisionStatus, note = '') {
  const score = candidate.flea_market_score ?? null;
  const title = candidate.discovery_product?.title ?? candidate.mcp_result?.title ?? candidate.excel_result?.title ?? null;
  const mainImageUrl = candidateMainImageUrl(candidate);
  upsertHistoryRecord({
    id: candidate.asin,
    asin: candidate.asin,
    parent_asin: candidate.discovery_product?.parent_asin ?? null,
    title,
    main_image_url: mainImageUrl,
    main_image_source: mainImageUrl ? 'mcp' : 'missing',
    source: candidate.source_data ?? 'mcp_validation',
    decision_status: status,
    decision_result: candidate.final_advice ?? candidate.decision?.final_decision ?? status,
    reject_reason: isAbandonedStatus(status) ? note || candidate.notes : '',
    flea_market_score: score,
    front_review_score: candidate.front_review?.front_review_score ?? null,
    final_score: score,
    first_seen_at: candidate.saved_at,
    last_seen_at: new Date().toISOString(),
    seen_count: 1,
    duplicate_status: candidate.duplicate_status ?? [],
    notes: note || candidate.notes || '',
    similar_asin: null,
  });
}

function upsertHistoryFromProduct(product: ProductRecord, status: CandidateDecisionStatus, note = '') {
  const resolved = resolveProductData(product);
  const score = product.score.flea_market_score;
  upsertHistoryRecord({
    id: product.asin,
    asin: product.asin,
    parent_asin: null,
    title: resolved.title,
    main_image_url: resolved.main_image_url,
    main_image_source: resolved.main_image_source,
    source: product.candidate_saved_at ? 'candidate_product' : 'product_record',
    decision_status: status,
    decision_result: product.decision.final_decision,
    reject_reason: isAbandonedStatus(status) ? note || product.manual.notes : '',
    flea_market_score: score,
    front_review_score: product.front_review.front_review_score,
    final_score: score,
    first_seen_at: product.candidate_saved_at ?? product.mcp_checked_at ?? new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    seen_count: 1,
    duplicate_status: [],
    notes: note || product.manual.notes || '',
    similar_asin: null,
  });
}

export function loadDiscoveryRuns(): DiscoveryRun[] {
  try {
    const raw = window.localStorage.getItem(discoveryRunsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadAllDiscoveryResults(): DiscoveryResult[] {
  try {
    const raw = window.localStorage.getItem(discoveryResultsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAllDiscoveryResults(results: DiscoveryResult[]) {
  window.localStorage.setItem(discoveryResultsStorageKey, JSON.stringify(results));
}

function compactDiscoveryRaw(raw: unknown): unknown {
  try {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= 25_000) return raw;
    if (raw && typeof raw === 'object') {
      const record = raw as Record<string, unknown>;
      return {
        raw_truncated: true,
        asin: record.asin,
        title: record.title,
        brand: record.brand,
        price: record.price,
        main_image_url: extractImageUrl(raw),
        reviews: record.reviews ?? record.ratings,
        rating: record.rating,
      };
    }
    return { raw_truncated: true };
  } catch {
    return { raw_unserializable: true };
  }
}

function pruneDiscoveryResultsForRuns(runs: DiscoveryRun[]) {
  const allowedRunIds = new Set(runs.map((run) => run.id));
  const counts = new Map<string, number>();
  const next = loadAllDiscoveryResults().filter((result) => {
    if (!allowedRunIds.has(result.run_id)) return false;
    const count = counts.get(result.run_id) ?? 0;
    if (count >= maxDiscoveryResultsPerRun) return false;
    counts.set(result.run_id, count + 1);
    return true;
  });
  saveAllDiscoveryResults(next);
}

export function saveDiscoveryRuns(runs: DiscoveryRun[]) {
  const retained = runs.slice(0, maxDiscoveryRuns);
  window.localStorage.setItem(discoveryRunsStorageKey, JSON.stringify(retained));
  pruneDiscoveryResultsForRuns(retained);
}

export function saveDiscoveryRun(run: DiscoveryRun): DiscoveryRun[] {
  const normalized: DiscoveryRun = {
    ...run,
    created_at: run.created_at ?? run.started_at,
    mcp_failed_count: run.mcp_failed_count ?? (run.status === 'failed' ? run.errors.length || 1 : 0),
  };
  const next = [normalized, ...loadDiscoveryRuns().filter((item) => item.id !== run.id)].slice(0, maxDiscoveryRuns);
  saveDiscoveryRuns(next);
  return next;
}

export function upsertDiscoveryRun(run: DiscoveryRun): DiscoveryRun[] {
  return saveDiscoveryRun(run);
}

export function updateDiscoveryRunSavedCandidates(runId: string, delta: number): DiscoveryRun[] {
  const next = loadDiscoveryRuns().map((run) =>
    run.id === runId ? { ...run, saved_candidates: Math.max(0, run.saved_candidates + delta) } : run,
  );
  saveDiscoveryRuns(next);
  return next;
}

export function saveDiscoveryResults(runId: string, results: DiscoveryResult[]): DiscoveryResult[] {
  const normalized = results.slice(0, maxDiscoveryResultsPerRun).map((result) => ({
    ...result,
    main_image_url: result.main_image_url ?? extractImageUrl(result.raw),
    main_image_source: result.main_image_url || extractImageUrl(result.raw) ? 'mcp' as const : 'missing' as const,
    run_id: runId,
    raw: compactDiscoveryRaw(result.raw),
  }));
  const otherResults = loadAllDiscoveryResults().filter((result) => result.run_id !== runId);
  const next = [...normalized, ...otherResults];
  saveAllDiscoveryResults(next);
  pruneDiscoveryResultsForRuns(loadDiscoveryRuns());
  return normalized;
}

export function getDiscoveryResultsByRunId(runId: string): DiscoveryResult[] {
  return loadAllDiscoveryResults().filter((result) => result.run_id === runId).slice(0, maxDiscoveryResultsPerRun);
}

export function getLatestDiscoveryRun(): DiscoveryRun | null {
  return loadDiscoveryRuns().find((run) => getDiscoveryResultsByRunId(run.id).length > 0) ?? null;
}

export function loadDevelopmentRecords(): DevelopmentRecord[] {
  try {
    const raw = window.localStorage.getItem(developmentStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeDevelopmentRecord).filter((item): item is DevelopmentRecord => Boolean(item)) : [];
  } catch {
    return [];
  }
}

export function saveDevelopmentRecords(records: DevelopmentRecord[]) {
  window.localStorage.setItem(developmentStorageKey, JSON.stringify(records));
}

export function upsertDevelopmentRecord(record: DevelopmentRecord): DevelopmentRecord[] {
  const now = new Date().toISOString();
  const existing = loadDevelopmentRecords().find((item) => item.asin === record.asin);
  const nextRecord = {
    ...(existing ?? record),
    ...record,
    created_at: existing?.created_at ?? record.created_at ?? now,
    updated_at: now,
  };
  const next = [nextRecord, ...loadDevelopmentRecords().filter((item) => item.asin !== record.asin)];
  saveDevelopmentRecords(next);
  return next;
}

export function createDevelopmentRecordFromProduct(product: ProductRecord, existing?: DevelopmentRecord | null): DevelopmentRecord {
  const now = new Date().toISOString();
  const resolved = resolveProductData(product);
  return {
    id: existing?.id ?? product.asin,
    asin: product.asin,
    main_image_url: existing?.main_image_url ?? resolved.main_image_url,
    main_image_source: existing?.main_image_source ?? resolved.main_image_source,
    status: existing?.status ?? '待找供应链',
    owner: existing?.owner ?? '',
    supplier_url: existing?.supplier_url ?? '',
    supplier_name: existing?.supplier_name ?? '',
    purchase_cost_rmb: existing?.purchase_cost_rmb ?? product.manual.purchase_cost_rmb ?? null,
    weight: existing?.weight ?? null,
    dimensions: existing?.dimensions ?? null,
    target_price: existing?.target_price ?? product.manual.target_price ?? product.score.price_margin_score.target_price_5,
    break_even_acos: existing?.break_even_acos ?? breakEvenAcos(product),
    sample_status: existing?.sample_status ?? '未开始',
    listing_status: existing?.listing_status ?? '未开始',
    ad_status: existing?.ad_status ?? '未开始',
    notes: existing?.notes ?? product.manual.notes ?? '',
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function addProductToDevelopment(products: ProductRecord[], candidates: McpCandidateRecord[], asin: string): {
  candidates: McpCandidateRecord[];
  development: DevelopmentRecord[];
} {
  const product = products.find((item) => item.asin === asin);
  if (!product) return { candidates, development: loadDevelopmentRecords() };
  const existingDev = loadDevelopmentRecords().find((item) => item.asin === asin);
  const development = upsertDevelopmentRecord(createDevelopmentRecordFromProduct(product, existingDev));
  const nextCandidates = candidates.map((candidate) =>
    candidate.asin === asin ? { ...candidate, decision_status: 'development' as const, final_advice: product.decision.final_decision } : candidate,
  );
  saveCandidates(nextCandidates);
  upsertHistoryFromProduct(product, 'development', '加入开发池');
  return { candidates: nextCandidates, development };
}

export function deleteDevelopmentRecord(asin: string): DevelopmentRecord[] {
  const next = loadDevelopmentRecords().filter((record) => record.asin !== asin);
  saveDevelopmentRecords(next);
  return next;
}

function normalizeDevelopmentRecord(raw: Partial<DevelopmentRecord> | null | undefined): DevelopmentRecord | null {
  if (!raw?.asin) return null;
  const now = new Date().toISOString();
  return {
    id: raw.id ?? raw.asin,
    asin: raw.asin,
    main_image_url: raw.main_image_url ?? null,
    main_image_source: raw.main_image_source ?? (raw.main_image_url ? 'mcp' : 'missing'),
    status: raw.status ?? '待找供应链',
    owner: raw.owner ?? '',
    supplier_url: raw.supplier_url ?? '',
    supplier_name: raw.supplier_name ?? '',
    purchase_cost_rmb: raw.purchase_cost_rmb ?? null,
    weight: raw.weight ?? null,
    dimensions: raw.dimensions ?? null,
    target_price: raw.target_price ?? null,
    break_even_acos: raw.break_even_acos ?? null,
    sample_status: raw.sample_status ?? '未开始',
    listing_status: raw.listing_status ?? '未开始',
    ad_status: raw.ad_status ?? '未开始',
    notes: raw.notes ?? '',
    created_at: raw.created_at ?? now,
    updated_at: raw.updated_at ?? raw.created_at ?? now,
  };
}

function candidateMainImageUrl(candidate: McpCandidateRecord): string | null {
  return (
    candidate.mcp_result?.main_image_url ??
    candidate.product?.main_image_url ??
    candidate.discovery_product?.main_image_url ??
    extractImageUrl(candidate.discovery_product?.raw) ??
    extractImageUrl(candidate.validation)
  );
}

function breakEvenAcos(product: ProductRecord): number | null {
  const target = product.manual.target_price ?? product.score.price_margin_score.target_price_5;
  const final = product.score.final_margin_score.full_margin_rate;
  if (typeof target !== 'number' || typeof final !== 'number') return null;
  return Math.max(0, final);
}

export function deleteDiscoveryRun(runId: string): DiscoveryRun[] {
  const nextRuns = loadDiscoveryRuns().filter((run) => run.id !== runId);
  window.localStorage.setItem(discoveryRunsStorageKey, JSON.stringify(nextRuns));
  saveAllDiscoveryResults(loadAllDiscoveryResults().filter((result) => result.run_id !== runId));
  return nextRuns;
}

export function markDiscoveryResultAsCandidate(runId: string | null, asin: string): DiscoveryResult[] {
  if (!runId) return [];
  const next = loadAllDiscoveryResults().map((result) =>
    result.run_id === runId && result.asin === asin ? { ...result, saved_as_candidate: true } : result,
  );
  saveAllDiscoveryResults(next);
  return next.filter((result) => result.run_id === runId);
}

export function createProductFromDiscovery(discovered: McpDiscoveredProduct): ProductRecord {
  const mcpSnapshot = createMcpSnapshotFromDiscovery(discovered);
  const base = createProductFromExcel({
    ...createExcelFromMcpSnapshot(discovered.asin, mcpSnapshot),
    title: null,
    brand: null,
    category: null,
    price_mid: null,
    rating: null,
    review_count: null,
    monthly_sales: null,
    monthly_revenue: null,
    bsr: null,
    fba_fee: null,
    seller: null,
    seller_type: null,
    variation_count: null,
    fulfillment_type: null,
    raw: { source: 'mcp_category_discovery' },
  });
  return withScore({
    ...base,
    mcp_status: 'checked',
    mcp_checked_at: discovered.discovered_at,
    mcp_snapshot: mcpSnapshot,
    mcp_error: null,
  });
}

export function upsertDiscoveryProduct(products: ProductRecord[], discovered: McpDiscoveredProduct, markCandidate = false): ProductRecord[] {
  const existing = products.find((product) => product.asin === discovered.asin);
  const snapshot = createMcpSnapshotFromDiscovery(discovered);
  const base = existing ?? createProductFromDiscovery(discovered);
  const updated = withScore({
    ...base,
    mcp_status: 'checked',
    mcp_checked_at: discovered.discovered_at,
    mcp_snapshot: mergeProductMcpSnapshots(base.mcp_snapshot, snapshot),
    mcp_error: null,
    candidate_saved_at: markCandidate ? new Date().toISOString() : base.candidate_saved_at ?? null,
  });
  const next = [updated, ...products.filter((product) => product.asin !== discovered.asin)];
  saveProducts(next);
  return next;
}

export function upsertDiscoveryCandidate(params: {
  candidates: McpCandidateRecord[];
  product: ProductRecord;
  discovered: McpDiscoveredProduct;
  runId: string | null;
  duplicateStatus: DuplicateStatus[];
  notes?: string;
  decisionStatus?: McpCandidateRecord['decision_status'];
}): McpCandidateRecord[] {
  const existing = params.candidates.find((candidate) => candidate.asin === params.discovered.asin);
  const resolved = resolveProductData(params.product);
  const score = params.product.score;
  const validation = createDiscoveryValidation(params.discovered);
  const margin = createDiscoveryMargin(params.product, resolved.fba_fee);
  const nextRecord: McpCandidateRecord = {
    id: existing?.id ?? `${Date.now()}-${params.discovered.asin}`,
    asin: params.discovered.asin,
    keyword: '',
    saved_at: new Date().toISOString(),
    excel_result: params.product.excel,
    mcp_result: params.product.mcp_snapshot,
    front_review_status: params.product.front_review.status,
    front_review: params.product.front_review,
    flea_market_score: score.flea_market_score,
    decision: params.product.decision,
    final_advice: params.product.decision.final_decision,
    product: params.product.mcp_snapshot,
    keyword_snapshot: null,
    main_keyword: params.product.mcp_snapshot?.main_keyword ?? '',
    long_tail_keywords: params.product.mcp_snapshot?.long_tail_keywords ?? [],
    keyword_snapshots: params.product.mcp_snapshot?.keyword_snapshots ?? [],
    keyword_insights: params.product.mcp_snapshot?.keyword_insights ?? [],
    keyword_data_confidence: params.product.mcp_snapshot?.keyword_data_confidence ?? 'unknown',
    long_tail_opportunity_level: params.product.mcp_snapshot?.long_tail_opportunity_level ?? 'unknown',
    low_bid_ad_score: score.low_bid_ad_score.score,
    recommended_sp_keywords: params.product.mcp_snapshot?.recommended_sp_keywords ?? [],
    rejected_keywords: params.product.mcp_snapshot?.rejected_keywords ?? [],
    validation,
    costs: createManualCostInput(params.product),
    margin,
    notes: params.notes ?? existing?.notes ?? '',
    discovery_product: params.discovered,
    discovery_run_id: params.runId,
    source_data: 'mcp_category_discovery',
    duplicate_status: params.duplicateStatus,
    decision_status: params.decisionStatus ?? existing?.decision_status ?? 'candidate',
  };
  const next = [nextRecord, ...params.candidates.filter((candidate) => candidate.asin !== nextRecord.asin)];
  saveCandidates(next);
  upsertHistoryFromCandidate(nextRecord, nextRecord.decision_status ?? 'candidate', nextRecord.notes);
  return next;
}

export function updateCandidateDecisionStatus(
  candidates: McpCandidateRecord[],
  asin: string,
  decisionStatus: CandidateDecisionStatus,
  note = '',
): McpCandidateRecord[] {
  const next = candidates.map((candidate) =>
    candidate.asin === asin
      ? { ...candidate, decision_status: decisionStatus, notes: note || candidate.notes }
      : candidate,
  );
  saveCandidates(next);
  const updated = next.find((candidate) => candidate.asin === asin);
  if (updated) upsertHistoryFromCandidate(updated, decisionStatus, note);
  return next;
}

export function removeCandidateFromPool(
  candidates: McpCandidateRecord[],
  asin: string,
  status: Extract<CandidateDecisionStatus, 'removed_from_candidate' | 'abandoned'>,
  note = '',
): McpCandidateRecord[] {
  const removed = candidates.find((candidate) => candidate.asin === asin);
  const next = candidates.filter((candidate) => candidate.asin !== asin);
  saveCandidates(next);
  if (removed) {
    upsertHistoryFromCandidate(
      {
        ...removed,
        decision_status: status,
        notes: note || removed.notes,
      },
      status,
      note || removed.notes,
    );
  }
  return next;
}

export function deleteCandidatePermanently(candidates: McpCandidateRecord[], asin: string): McpCandidateRecord[] {
  const next = candidates.filter((candidate) => candidate.asin !== asin);
  saveCandidates(next);
  return next;
}

export function restoreCandidatePoolSnapshot(
  candidates: McpCandidateRecord[],
  affectedAsins: string[],
  note = '撤销候选池操作',
): McpCandidateRecord[] {
  saveCandidates(candidates);
  const affected = new Set(affectedAsins);
  candidates
    .filter((candidate) => affected.has(candidate.asin))
    .forEach((candidate) => upsertHistoryFromCandidate({ ...candidate, decision_status: 'candidate' }, 'candidate', note));
  return candidates;
}

export function getDiscoveryDuplicateStatuses(
  discovered: McpDiscoveredProduct,
  products: ProductRecord[],
  candidates: McpCandidateRecord[],
): DuplicateStatus[] {
  const statuses = new Set<DuplicateStatus>();
  const candidate = candidates.find((item) => item.asin === discovered.asin);
  const product = products.find((item) => item.asin === discovered.asin);

  if (candidate || product) statuses.add('exact_asin_duplicate');
  if (isAbandonedStatus(candidate?.decision_status) || product?.decision.final_decision === 'reject' || product?.score.layer === 'E放弃池') statuses.add('already_rejected');
  if (candidate?.decision_status === 'developed' || candidate?.decision_status === 'development' || product?.decision.final_decision === 'develop') statuses.add('already_developed');

  const knownParent = discovered.parent_asin;
  if (
    knownParent &&
    candidates.some((item) => item.discovery_product?.parent_asin === knownParent && item.asin !== discovered.asin)
  ) {
    statuses.add('parent_asin_duplicate');
  }

  const references = [
    ...products.map((item) => ({ asin: item.asin, title: resolveProductData(item).title, brand: resolveProductData(item).brand })),
    ...candidates.map((item) => ({
      asin: item.asin,
      title: item.discovery_product?.title ?? item.mcp_result?.title ?? item.excel_result?.title ?? null,
      brand: item.discovery_product?.brand ?? item.mcp_result?.brand ?? item.excel_result?.brand ?? null,
    })),
  ].filter((item) => item.asin !== discovered.asin && item.title);

  references.forEach((item) => {
    const similarity = titleSimilarity(discovered.title, item.title);
    if (similarity >= 0.82) statuses.add('similar_title_duplicate');
    if (similarity >= 0.62 && normalizeText(item.brand) && normalizeText(item.brand) === normalizeText(discovered.brand)) statuses.add('possible_same_product');
  });

  readAsinLedger(historyLibraryStorageKey).forEach((entry) => {
    if (entry.asin === discovered.asin) statuses.add(isAbandonedStatus(entry.status) ? 'already_rejected' : 'exact_asin_duplicate');
    if (knownParent && entry.parent_asin && entry.parent_asin === knownParent) statuses.add('parent_asin_duplicate');
  });
  readAsinLedger(launchedStorageKey).forEach((entry) => {
    if (entry.asin === discovered.asin) statuses.add('launched');
    if (knownParent && entry.parent_asin && entry.parent_asin === knownParent) statuses.add('parent_asin_duplicate');
  });

  return Array.from(statuses);
}

function createMcpSnapshotFromDiscovery(discovered: McpDiscoveredProduct): ProductMcpSnapshot {
  const generatedKeywords = generateLongTailKeywordCandidates({
    title: discovered.title,
    category: discovered.category_path ?? discovered.category,
    brand: discovered.brand,
    main_keyword: discovered.source_keyword,
  });
  const mainKeyword = discovered.source_keyword ?? generatedKeywords[0] ?? null;
  const mainImageUrl = discovered.main_image_url ?? extractImageUrl(discovered.raw);
  return {
    asin: discovered.asin,
    title: discovered.title,
    brand: discovered.brand,
    category: discovered.category_path ?? discovered.category,
    price: discovered.price,
    coupon_price: discovered.coupon_price,
    rating: discovered.rating,
    review_count: discovered.review_count,
    bsr: discovered.bsr,
    monthly_sales: discovered.monthly_sales,
    monthly_revenue: discovered.monthly_revenue,
    fba_fee: discovered.fba_fee,
    fba_fee_source: discovered.fba_fee !== null ? 'mcp' : 'missing',
    referral_fee: null,
    referral_fee_rate: null,
    referral_fee_rate_source: 'default_rate',
    main_image_url: mainImageUrl,
    main_image_source: mainImageUrl ? 'mcp' : 'missing',
    seller: discovered.seller,
    seller_type: discovered.seller_type,
    variation_count: discovered.variation_count,
    buybox_seller: discovered.seller,
    fulfillment_type: discovered.seller_type,
    listed_at: discovered.listed_at,
    listed_at_source: discovered.listed_at || discovered.launch_date || discovered.first_available_date ? 'mcp' : 'missing',
    launch_date: discovered.launch_date,
    first_available_date: discovered.first_available_date,
    product_age_days: discovered.product_age_days,
    listed_days: discovered.listed_days,
    is_recent_product: discovered.is_recent_product,
    recent_product_level: discovered.recent_product_level,
    main_keyword: mainKeyword,
    long_tail_keywords: generatedKeywords.filter((keyword) => keyword !== mainKeyword).slice(0, 10),
    keyword_snapshots: [],
    keyword_insights: [],
    keyword_data_confidence: 'low',
    long_tail_opportunity_level: 'unknown',
    recommended_sp_keywords: [],
    rejected_keywords: [],
    keyword_summary: null,
    traffic_summary: null,
    prediction_summary: null,
    raw: {
      asin_detail: discovered.raw,
      asin_prediction: null,
      traffic_keyword_stat: null,
      keyword_miner: null,
      asin_keywords: null,
    },
  };
}


function createDiscoveryValidation(discovered: McpDiscoveredProduct): McpValidationResult {
  return {
    asin: discovered.asin,
    keyword: '',
    main_keyword: discovered.source_keyword ?? '',
    long_tail_keywords: [],
    keyword_snapshots: [],
    status: 'success',
    checked_at: discovered.discovered_at,
    asin_detail: null,
    asin_prediction: null,
    traffic_keyword_stat: null,
    keyword_miner: null,
    errors: [],
  };
}

function createManualCostInput(product: ProductRecord): McpManualCostInput {
  return {
    target_discount_rate: 0.05,
    referral_fee_rate: product.manual.referral_fee_rate,
    manual_fba_fee: product.manual.fba_fee,
    purchase_cost: product.manual.purchase_cost_usd,
    first_leg_shipping: product.manual.first_mile_cost_usd,
    packaging_cost: product.manual.package_cost_usd,
    other_cost: null,
    platform_other_fee: product.manual.platform_other_fee,
    storage_cost_usd: product.manual.storage_cost_usd,
    return_loss: product.manual.return_loss,
    risk_level: product.manual.risk_level,
    risk_tags: product.manual.risk_tags,
  };
}

function createDiscoveryMargin(product: ProductRecord, fbaFee: number | null): McpMarginSnapshot {
  const price = product.score.price_margin_score;
  const final = product.score.final_margin_score;
  const targetPrice = price.target_price_5;
  const referralRate = product.manual.referral_fee_rate ?? 0.15;
  return {
    base_price: resolveProductData(product).competitor_price,
    target_price: targetPrice,
    referral_fee: targetPrice !== null ? targetPrice * referralRate : null,
    fba_fee: fbaFee,
    platform_margin_rate: price.platform_margin_rate,
    product_full_cost: final.full_costs,
    final_margin_rate: final.full_margin_rate,
    platform_margin_pass: (price.platform_margin_rate ?? 0) >= 0.6,
    final_margin_pass: (final.full_margin_rate ?? 0) >= 0.25,
    warnings: [...price.notes, ...final.notes],
  };
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function titleSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const ignored = new Set(['for', 'with', 'and', 'the', 'of', 'a', 'an', 'set', 'pack', 'pcs', 'pc', 'amazon']);
  const tokens = (value: string | null | undefined) =>
    new Set(
      normalizeText(value)
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 2 && !ignored.has(token)),
    );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return overlap / new Set([...leftTokens, ...rightTokens]).size;
}

function readAsinLedger(storageKey: string): Array<{ asin: string; parent_asin: string | null; status?: string }> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        asin: String(item?.asin ?? '').trim(),
        parent_asin: item?.parent_asin ? String(item.parent_asin).trim() : null,
        status: item?.status ? String(item.status) : item?.decision_status ? String(item.decision_status) : undefined,
      }))
      .filter((item) => item.asin);
  } catch {
    return [];
  }
}

function syncCandidateProduct(product: ProductRecord) {
  const candidates = loadCandidates();
  if (!candidates.some((candidate) => candidate.asin === product.asin)) return;
  saveCandidates(
    candidates.map((candidate) =>
      candidate.asin === product.asin
        ? {
            ...candidate,
            excel_result: product.excel,
            mcp_result: product.mcp_snapshot,
            product: product.mcp_snapshot,
            front_review_status: product.front_review.status,
            front_review: product.front_review,
            flea_market_score: product.score.flea_market_score,
            decision: product.decision,
            final_advice: product.decision.final_decision,
            costs: createManualCostInput(product),
            margin: createDiscoveryMargin(product, resolveProductData(product).fba_fee),
            low_bid_ad_score: product.score.low_bid_ad_score.score,
            recommended_sp_keywords: product.mcp_snapshot?.recommended_sp_keywords ?? candidate.recommended_sp_keywords ?? [],
            rejected_keywords: product.mcp_snapshot?.rejected_keywords ?? candidate.rejected_keywords ?? [],
            keyword_insights: product.mcp_snapshot?.keyword_insights ?? candidate.keyword_insights ?? [],
            keyword_data_confidence: product.mcp_snapshot?.keyword_data_confidence ?? candidate.keyword_data_confidence ?? 'unknown',
          }
        : candidate,
    ),
  );
  upsertHistoryFromProduct(product, product.decision.final_decision === 'reject' ? 'rejected' : 'candidate', product.manual.notes);
}

function syncCandidateFrontReviews(product: ProductRecord) {
  syncCandidateProduct(product);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}
