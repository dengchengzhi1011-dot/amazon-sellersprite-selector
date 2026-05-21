import type {
  DiscoveryRun,
  DuplicateStatus,
  FrontReview,
  McpCandidateRecord,
  McpDiscoveredProduct,
  McpManualCostInput,
  McpMarginSnapshot,
  McpValidationResult,
  ProductExcelData,
  ProductManualData,
  ProductMcpSnapshot,
  ProductRecord,
} from '../types/mcp';
import { calculateRatingRiskLevel, createExcelFromMcpSnapshot, decideProduct, resolveProductData, scoreFrontReview, scoreProduct } from './scoring';
import { generateLongTailKeywordCandidates } from './keywordTools';

const productsStorageKey = 'amazon-sellersprite-selector:products';
const candidatesStorageKey = 'amazon-sellersprite-selector:mcp-candidates';
const discoveryRunsStorageKey = 'amazon-sellersprite-selector:discovery-runs';
const historyLibraryStorageKey = 'amazon-sellersprite-selector:history-library';
const launchedStorageKey = 'amazon-sellersprite-selector:launched-records';

export const defaultManualData: ProductManualData = {
  fba_fee: null,
  purchase_cost_usd: null,
  first_mile_cost_usd: null,
  package_cost_usd: null,
  storage_cost_usd: null,
  platform_other_fee: null,
  return_loss: null,
  referral_fee_rate: 0.15,
  risk_level: 'none',
  risk_tags: [],
  front_review_status: 'pending',
  notes: '',
};

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
    referral_fee: next.referral_fee ?? previous.referral_fee,
    referral_fee_rate: next.referral_fee_rate ?? previous.referral_fee_rate,
    seller: next.seller ?? previous.seller,
    seller_type: next.seller_type ?? previous.seller_type,
    variation_count: next.variation_count ?? previous.variation_count,
    buybox_seller: next.buybox_seller ?? previous.buybox_seller,
    fulfillment_type: next.fulfillment_type ?? previous.fulfillment_type,
    listed_at: next.listed_at ?? previous.listed_at,
    launch_date: next.launch_date ?? previous.launch_date,
    first_available_date: next.first_available_date ?? previous.first_available_date,
    product_age_days: next.product_age_days ?? previous.product_age_days,
    listed_days: next.listed_days ?? previous.listed_days,
    is_recent_product: next.product_age_days !== null ? next.is_recent_product : previous.is_recent_product,
    recent_product_level: next.product_age_days !== null ? next.recent_product_level : previous.recent_product_level,
    main_keyword: next.main_keyword ?? previous.main_keyword,
    long_tail_keywords: next.long_tail_keywords.length ? next.long_tail_keywords : previous.long_tail_keywords,
    keyword_snapshots: next.keyword_snapshots.length ? next.keyword_snapshots : previous.keyword_snapshots,
    long_tail_opportunity_level:
      next.long_tail_opportunity_level !== 'unknown'
        ? next.long_tail_opportunity_level
        : previous.long_tail_opportunity_level,
    recommended_sp_keywords: next.recommended_sp_keywords.length ? next.recommended_sp_keywords : previous.recommended_sp_keywords,
    rejected_keywords: next.rejected_keywords.length ? next.rejected_keywords : previous.rejected_keywords,
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

function mapManualCosts(costs?: McpManualCostInput, existing: ProductManualData = defaultManualData, notes = ''): ProductManualData {
  if (!costs) return { ...existing, notes: notes || existing.notes };
  return {
    ...existing,
    fba_fee: costs.manual_fba_fee ?? existing.fba_fee,
    purchase_cost_usd: costs.purchase_cost ?? existing.purchase_cost_usd,
    first_mile_cost_usd: costs.first_leg_shipping ?? existing.first_mile_cost_usd,
    package_cost_usd: costs.packaging_cost ?? existing.package_cost_usd,
    storage_cost_usd: costs.storage_cost_usd ?? existing.storage_cost_usd,
    platform_other_fee: costs.platform_other_fee ?? existing.platform_other_fee,
    return_loss: costs.return_loss ?? existing.return_loss,
    referral_fee_rate: costs.referral_fee_rate ?? existing.referral_fee_rate,
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
  const headers = ['ASIN', '标题', 'MCP复核状态', '铺货捡漏分', '前台复核分', '平台后毛利率', '全成本毛利率', '最终建议', '主关键词', '长尾关键词', '长尾机会等级', '推荐SP词', '不建议词', '低竞价广告分', 'rating_risk_level', 'rating_risk_note', 'strict_rating_filter_enabled', '备注'];
  const rows = candidates.map((candidate) => {
    const ratingRisk = calculateRatingRiskLevel(candidate.mcp_result?.review_count ?? candidate.excel_result?.review_count, candidate.mcp_result?.rating ?? candidate.excel_result?.rating);
    const run = runs.find((item) => item.id === candidate.discovery_run_id);
    return [
      candidate.asin,
      candidate.mcp_result?.title ?? candidate.excel_result?.title ?? '',
      candidate.product ? 'checked' : 'not_checked',
      candidate.flea_market_score ?? '',
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

export function loadDiscoveryRuns(): DiscoveryRun[] {
  try {
    const raw = window.localStorage.getItem(discoveryRunsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDiscoveryRuns(runs: DiscoveryRun[]) {
  window.localStorage.setItem(discoveryRunsStorageKey, JSON.stringify(runs.slice(0, 30)));
}

export function upsertDiscoveryRun(run: DiscoveryRun): DiscoveryRun[] {
  const next = [run, ...loadDiscoveryRuns().filter((item) => item.id !== run.id)].slice(0, 30);
  saveDiscoveryRuns(next);
  return next;
}

export function updateDiscoveryRunSavedCandidates(runId: string, delta: number): DiscoveryRun[] {
  const next = loadDiscoveryRuns().map((run) =>
    run.id === runId ? { ...run, saved_candidates: Math.max(0, run.saved_candidates + delta) } : run,
  );
  saveDiscoveryRuns(next);
  return next;
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
  return next;
}

export function updateCandidateDecisionStatus(
  candidates: McpCandidateRecord[],
  asin: string,
  decisionStatus: NonNullable<McpCandidateRecord['decision_status']>,
  note = '',
): McpCandidateRecord[] {
  const next = candidates.map((candidate) =>
    candidate.asin === asin
      ? { ...candidate, decision_status: decisionStatus, notes: note || candidate.notes }
      : candidate,
  );
  saveCandidates(next);
  return next;
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
  if (candidate?.decision_status === 'rejected' || product?.decision.final_decision === 'reject' || product?.score.layer === 'E放弃池') statuses.add('already_rejected');
  if (candidate?.decision_status === 'developed' || product?.decision.final_decision === 'develop') statuses.add('already_developed');

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
    if (entry.asin === discovered.asin) statuses.add(entry.status === 'rejected' ? 'already_rejected' : 'exact_asin_duplicate');
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
    referral_fee: null,
    referral_fee_rate: null,
    seller: discovered.seller,
    seller_type: discovered.seller_type,
    variation_count: discovered.variation_count,
    buybox_seller: discovered.seller,
    fulfillment_type: discovered.seller_type,
    listed_at: discovered.listed_at,
    launch_date: discovered.launch_date,
    first_available_date: discovered.first_available_date,
    product_age_days: discovered.product_age_days,
    listed_days: discovered.listed_days,
    is_recent_product: discovered.is_recent_product,
    recent_product_level: discovered.recent_product_level,
    main_keyword: mainKeyword,
    long_tail_keywords: generatedKeywords.filter((keyword) => keyword !== mainKeyword).slice(0, 10),
    keyword_snapshots: [],
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
        status: item?.status ? String(item.status) : undefined,
      }))
      .filter((item) => item.asin);
  } catch {
    return [];
  }
}

function syncCandidateFrontReviews(product: ProductRecord) {
  const candidates = loadCandidates();
  if (!candidates.some((candidate) => candidate.asin === product.asin)) return;
  saveCandidates(
    candidates.map((candidate) =>
      candidate.asin === product.asin
        ? {
            ...candidate,
            front_review_status: product.front_review.status,
            front_review: product.front_review,
            flea_market_score: product.score.flea_market_score,
            decision: product.decision,
            final_advice: product.decision.final_decision,
          }
        : candidate,
    ),
  );
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}
