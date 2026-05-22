import type {
  AsinKeywordInsight,
  FinalDecisionStage,
  FbaFeeSource,
  FrontReview,
  KeywordSnapshot,
  McpKeywordSnapshot,
  McpProductSnapshot,
  ProductDecisionResult,
  ProductExcelData,
  ProductManualData,
  ProductMcpSnapshot,
  ProductRecord,
  ProductScoreResult,
  RatingRiskLevel,
  ReferralFeeRateSource,
  ResolvedProductData,
} from '../types/mcp';
import { calculateLongTailOpportunity } from './keywordTools';

const severeRiskKeywords = ['侵权', 'IP', '品牌限制', '危险品', '强认证', '医疗', '婴童', '食品', '补剂', '刀具', '武器', '大件', '重货', '液体', '粉末', '易碎', '带电'];

function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    const parsed = num(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value) return value;
  }
  return null;
}

function clamp(score: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(score)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function candidateRecords(input: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const push = (value: unknown) => {
    if (isRecord(value)) records.push(value);
  };
  push(input);
  if (isRecord(input)) {
    push(input.mcp_snapshot);
    push(input.excel);
    push(input.raw);
    const snapshot = input.mcp_snapshot;
    if (isRecord(snapshot)) {
      push(snapshot.raw);
      const raw = snapshot.raw;
      if (isRecord(raw)) {
        push(raw.asin_detail);
        push(raw.asin_prediction);
      }
    }
    const raw = input.raw;
    if (isRecord(raw)) {
      push(raw.asin_detail);
      push(raw.asin_prediction);
    }
  }
  return records;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[$,%\s,]/g, '');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pickNumberFrom(input: unknown, keys: string[]): number | null {
  for (const record of candidateRecords(input)) {
    for (const key of keys) {
      const parsed = numberFromUnknown(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function pickStringFrom(input: unknown, keys: string[]): string | null {
  for (const record of candidateRecords(input)) {
    for (const key of keys) {
      const parsed = stringFromUnknown(record[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function daysSince(value: string, referenceDate = new Date()): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}$/.test(trimmed) ? `${trimmed}-01` : trimmed;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  const diff = referenceDate.getTime() - timestamp;
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, Math.round(diff / 86_400_000));
}

export function normalizeProductAgeDays(input: unknown, referenceDate = new Date()): number | null {
  const direct = pickNumberFrom(input, ['product_age_days', 'listed_days', 'available_days', 'availableDays', 'listedDays']);
  if (direct !== null) return Math.max(0, Math.round(direct));

  const availableMonth = pickNumberFrom(input, ['availableMonth']);
  if (availableMonth !== null) return Math.max(0, Math.round(availableMonth * 30));

  const dateText = pickStringFrom(input, ['listed_at', 'first_available_date', 'date_first_available', 'launch_date', 'listedAt', 'firstAvailableDate', 'dateFirstAvailable']);
  if (dateText) return daysSince(dateText, referenceDate);

  const availableMonthText = pickStringFrom(input, ['availableMonth']);
  if (availableMonthText) {
    if (/^\d{4}-\d{2}/.test(availableMonthText) || /^\d{4}\/\d{2}/.test(availableMonthText)) {
      return daysSince(availableMonthText.replace(/\//g, '-'), referenceDate);
    }
    const parsed = numberFromUnknown(availableMonthText);
    if (parsed !== null) return Math.max(0, Math.round(parsed * 30));
  }

  return null;
}

export function normalizeReviewCount(input: unknown): number | null {
  const value = normalizeEffectiveReviewCount(input).effective_review_count;
  return value === null ? null : Math.max(0, Math.round(value));
}

export function normalizeEffectiveReviewCount(input: unknown): {
  effective_review_count: number | null;
  review_text_count: number | null;
  rating_count: number | null;
  review_count_source: 'ratings' | 'reviews' | 'raw_review_count' | 'missing';
} {
  const ratingCount = pickNumberFrom(input, ['ratings', 'ratings_count', 'rating_count', 'ratingCount', 'ratingsCount']);
  const reviewTextCount = pickNumberFrom(input, ['reviews', 'reviewTextCount', 'review_text_count']);
  const rawReviewCount = pickNumberFrom(input, ['review_count', 'reviewCount']);
  if (ratingCount !== null) {
    return {
      effective_review_count: Math.max(0, Math.round(ratingCount)),
      review_text_count: reviewTextCount === null ? null : Math.max(0, Math.round(reviewTextCount)),
      rating_count: Math.max(0, Math.round(ratingCount)),
      review_count_source: 'ratings',
    };
  }
  if (reviewTextCount !== null) {
    return {
      effective_review_count: Math.max(0, Math.round(reviewTextCount)),
      review_text_count: Math.max(0, Math.round(reviewTextCount)),
      rating_count: null,
      review_count_source: 'reviews',
    };
  }
  if (rawReviewCount !== null) {
    return {
      effective_review_count: Math.max(0, Math.round(rawReviewCount)),
      review_text_count: null,
      rating_count: null,
      review_count_source: 'raw_review_count',
    };
  }
  return {
    effective_review_count: null,
    review_text_count: null,
    rating_count: null,
    review_count_source: 'missing',
  };
}

export function normalizeMonthlySales(input: unknown): number | null {
  const value = pickNumberFrom(input, ['monthly_sales', 'month_sales', 'sales_monthly', 'estimated_monthly_sales', 'sales', 'units_sold_monthly', 'total_units', 'totalUnits']);
  return value === null ? null : Math.max(0, Math.round(value));
}

export function normalizeRating(input: unknown): number | null {
  return pickNumberFrom(input, ['rating', 'star', 'stars', 'ratingValue']);
}

export function calculateNewProductSalesSignalScore(
  product: unknown,
  referenceDate = new Date(),
): ProductScoreResult['new_product_sales_signal_score'] {
  const age = normalizeProductAgeDays(product, referenceDate);
  const reviewMeta = normalizeEffectiveReviewCount(product);
  const reviewCount = reviewMeta.effective_review_count;
  const monthlySales = normalizeMonthlySales(product);
  const rating = normalizeRating(product);
  const flags: string[] = [];
  const explanation: string[] = [];
  let signal = '';
  let score = 0;
  let missingReviewNeeded = false;
  const hasSales = monthlySales !== null && monthlySales > 0;
  const isZeroReview = reviewCount === 0;
  const isLowReview = reviewCount !== null && reviewCount <= 30;
  const salesPerReview = monthlySales === null ? null : monthlySales / Math.max(reviewCount ?? 1, 1);

  if (age === null) {
    flags.push('时间缺失待复核');
    explanation.push('上架时间缺失，作为待复核处理，不作为差品处理。');
  }
  if (reviewMeta.review_count_source === 'ratings') {
    explanation.push('低评论判断优先使用 ratings 评分数作为有效评论/社会证明数量。');
  } else if (reviewMeta.review_count_source === 'reviews') {
    explanation.push('低评论判断使用 reviews 评论数；ratings 未返回，需前台复核评分数。');
  } else if (reviewMeta.review_count_source === 'raw_review_count') {
    explanation.push('低评论判断使用 raw review_count 字段；ratings/reviews 未返回。');
  }

  if (reviewCount === null && hasSales) {
    score = 12;
    signal = '评论缺失待复核';
    flags.push('评论数缺失但已动销，待复核');
    explanation.push('评论数缺失但存在月销量，不能直接判为差品。');
    missingReviewNeeded = true;
  }

  if (monthlySales === null && reviewCount !== null && reviewCount <= 30) {
    score = Math.max(score, 10);
    signal = signal || '销量缺失待复核';
    flags.push('销量缺失但评论低，待复核');
    explanation.push('销量缺失但评论低，应进入观察/复核，不直接进 E。');
    missingReviewNeeded = true;
  }

  if (age !== null && age <= 90 && reviewCount !== null && reviewCount <= 5 && monthlySales !== null && monthlySales >= 10) {
    score = 30;
    signal = isZeroReview ? '0评论已出单' : '少评新品动销';
    flags.push('新品少评已动销，强机会');
    explanation.push('90天内、0-5评论、月销量>=10，属于极强新品动销信号。');
  } else if (isZeroReview && monthlySales !== null && monthlySales >= 20) {
    score = 28;
    signal = '0评论已出单';
    flags.push('0评论已出单');
    explanation.push('0评论但月销量>=20，说明无评论状态下已动销。');
  } else if (age !== null && age <= 180 && reviewCount !== null && reviewCount <= 10 && monthlySales !== null && monthlySales >= 20) {
    score = 28;
    signal = '180天内动销';
    flags.push('180天内少评动销');
    explanation.push('180天内、评论<=10、月销量>=20，属于强新品动销信号。');
  } else if (age !== null && age <= 365 && reviewCount !== null && reviewCount <= 30 && monthlySales !== null && monthlySales >= 30) {
    score = 26;
    signal = '365天内动销';
    flags.push('365天内少评动销');
    explanation.push('365天内、评论<=30、月销量>=30，属于中强新品动销信号。');
  } else if (isZeroReview && monthlySales !== null && monthlySales >= 5) {
    score = 22;
    signal = '0评论已出单';
    flags.push('0评论已出单');
    explanation.push('0评论但已有5-20单/月，属于小类目新品动销观察机会。');
  } else if (reviewCount !== null && reviewCount <= 10 && monthlySales !== null && monthlySales >= 20) {
    score = 26;
    signal = '少评动销';
    flags.push('少评论高动销');
    explanation.push('评论<=10且月销量>=20，说明少评状态下已有动销。');
  } else if (reviewCount !== null && reviewCount <= 30 && monthlySales !== null && monthlySales >= 30) {
    score = 24;
    signal = '少评动销';
    flags.push('低评论动销');
    explanation.push('评论<=30且月销量>=30，属于低评论出单机会。');
  } else if (reviewCount !== null && reviewCount <= 100 && monthlySales !== null && monthlySales >= 50) {
    score = 20;
    signal = '老品低评动销';
    flags.push('低评论高销量');
    explanation.push('评论<=100且月销量>=50，仍有低评论切入空间。');
  } else if (reviewCount !== null && reviewCount <= 300 && monthlySales !== null && monthlySales >= 100) {
    score = 14;
    signal = '中评论动销';
    flags.push('中评论动销');
    explanation.push('评论<=300且月销量>=100，有销量但评论优势较弱。');
  } else if (score === 0) {
    if (reviewCount === null) {
      score = 10;
      signal = '评论缺失待复核';
      flags.push('评论数缺失，需前台复核');
      explanation.push('评论数缺失，先作为待复核处理。');
      missingReviewNeeded = true;
    } else if (monthlySales === null) {
      score = reviewCount <= 30 ? 10 : 8;
      signal = reviewCount <= 30 ? '销量缺失待复核' : '待判断';
      flags.push('销量缺失但评论低，待复核');
      explanation.push('月销量缺失，低评论出单暂不能确认，但不直接判为差品。');
      missingReviewNeeded = reviewCount <= 30;
    } else if (reviewCount > 300) {
      score = 5;
      signal = '评论偏高';
      explanation.push('评论数超过300，少评论切入优势较弱。');
    } else {
      score = 10;
      signal = '待判断';
      explanation.push('未命中新品少评动销强规则，保留待复核。');
    }
  }

  if (salesPerReview !== null) {
    if (salesPerReview >= 20) {
      score = Math.min(30, score + 3);
      explanation.push('动销/评论比>=20，极强少评动销信号。');
    } else if (salesPerReview >= 10) {
      score = Math.min(30, score + 2);
      explanation.push('动销/评论比10-20，强少评动销信号。');
    } else if (salesPerReview >= 5) {
      score = Math.min(30, score + 1);
      explanation.push('动销/评论比5-10，中等少评动销信号。');
    } else if (salesPerReview >= 2) {
      explanation.push('动销/评论比2-5，可观察。');
    } else {
      explanation.push('动销/评论比<2，普通。');
    }
  }

  if (isZeroReview && hasSales) {
    explanation.push('0评论但已动销，rating 缺失按中性处理。');
  } else if (isLowReview && hasSales && rating === null) {
    explanation.push('少评论且已动销，rating 缺失不作为降级原因。');
  }

  return {
    score: clamp(score, 30),
    max: 30,
    label: '新品动销分',
    notes: explanation,
    signal_label: signal || (age === null ? '时间缺失待复核' : '待判断'),
    action_flags: Array.from(new Set(flags)),
    explanation,
    sales_per_review: salesPerReview,
    is_new_product_sales_signal: score >= 22 || (isZeroReview && hasSales),
    missing_review_needed: missingReviewNeeded,
  };
}

export function createMcpSnapshotFromValidation(params: {
  product: McpProductSnapshot | null;
  keyword: McpKeywordSnapshot | null;
  mainKeyword?: string;
  longTailKeywords?: string[];
  keywordSnapshots?: KeywordSnapshot[];
  keywordInsights?: AsinKeywordInsight[];
  keywordDataConfidence?: ProductMcpSnapshot['keyword_data_confidence'];
  prediction: ProductMcpSnapshot['prediction_summary'];
  traffic: unknown;
  raw: ProductMcpSnapshot['raw'];
  asin: string;
}): ProductMcpSnapshot {
  const { product, keyword, mainKeyword, longTailKeywords, prediction, traffic, raw, asin } = params;
  const keywordSnapshots = params.keywordSnapshots ?? [];
  const keywordInsights = params.keywordInsights ?? [];
  const longTailOpportunity = calculateLongTailOpportunity(keywordSnapshots);
  return {
    asin: product?.asin ?? prediction?.asin ?? asin,
    title: product?.title ?? null,
    brand: product?.brand ?? null,
    category: product?.category ?? null,
    price: product?.price ?? null,
    coupon_price: product?.coupon_price ?? null,
    rating: product?.rating ?? null,
    review_count: product?.review_count ?? null,
    bsr: product?.bsr ?? null,
    monthly_sales: product?.monthly_sales ?? prediction?.recent_30d_sales ?? null,
    monthly_revenue: product?.monthly_revenue ?? prediction?.recent_30d_revenue ?? null,
    fba_fee: product?.fba_fee ?? null,
    fba_fee_source: product?.fba_fee !== null && product?.fba_fee !== undefined ? (product.fba_fee_source ?? 'mcp') : 'missing',
    referral_fee: product?.referral_fee ?? null,
    referral_fee_rate: product?.referral_fee_rate ?? null,
    referral_fee_rate_source: product?.referral_fee_rate !== null && product?.referral_fee_rate !== undefined ? (product.referral_fee_rate_source ?? 'mcp') : 'default_rate',
    main_image_url: product?.main_image_url ?? null,
    main_image_source: product?.main_image_url ? (product.main_image_source ?? 'mcp') : 'missing',
    seller: product?.seller ?? null,
    seller_type: product?.seller_type ?? null,
    variation_count: product?.variation_count ?? null,
    buybox_seller: product?.buybox_seller ?? null,
    fulfillment_type: product?.fulfillment_type ?? null,
    listed_at: null,
    listed_at_source: 'missing',
    launch_date: null,
    first_available_date: null,
    product_age_days: null,
    listed_days: null,
    is_recent_product: false,
    recent_product_level: '时间缺失',
    main_keyword: mainKeyword?.trim() || keyword?.keyword || null,
    long_tail_keywords: longTailKeywords ?? [],
    keyword_snapshots: keywordSnapshots,
    keyword_insights: keywordInsights,
    keyword_data_confidence: params.keywordDataConfidence ?? (keywordInsights.some((insight) => insight.source_tool !== 'title_generated' && insight.source_tool !== 'title_split_fallback') ? 'high' : keywordInsights.length ? 'low' : 'unknown'),
    keyword_source:
      keywordInsights.some((insight) => insight.source_tool === 'traffic_keyword')
        ? 'traffic_keyword'
        : keywordInsights.some((insight) => insight.source_tool === 'keyword_order')
          ? 'keyword_order'
          : keywordInsights.some((insight) => insight.source_tool === 'keyword_miner' || insight.source_tool === 'keyword_research')
            ? 'keyword_metrics'
            : keywordInsights.length
              ? 'title_split_fallback'
              : null,
    demand_confirmed:
      keywordInsights.some((insight) => insight.source_tool === 'traffic_keyword' || insight.source_tool === 'keyword_order')
        ? true
        : keywordInsights.some((insight) => insight.source_tool === 'keyword_miner' || insight.source_tool === 'keyword_research')
          ? 'partial'
          : false,
    demand_confirm_source:
      keywordInsights.some((insight) => insight.source_tool === 'traffic_keyword')
        ? 'traffic_keyword'
        : keywordInsights.some((insight) => insight.source_tool === 'keyword_order')
          ? 'keyword_order'
          : keywordInsights.some((insight) => insight.source_tool === 'keyword_miner' || insight.source_tool === 'keyword_research')
            ? 'keyword_metrics'
            : keywordInsights.length
              ? 'title_split_fallback'
              : null,
    long_tail_opportunity_level: longTailOpportunity.level,
    recommended_sp_keywords: keywordInsights.filter((insight) => !insight.reject_reason && insight.recommended_action).map((insight) => insight.keyword).slice(0, 10).length
      ? keywordInsights.filter((insight) => !insight.reject_reason && insight.recommended_action).map((insight) => insight.keyword).slice(0, 10)
      : longTailOpportunity.recommended_sp_keywords,
    rejected_keywords: keywordInsights.filter((insight) => insight.reject_reason).map((insight) => insight.keyword).slice(0, 20).length
      ? keywordInsights.filter((insight) => insight.reject_reason).map((insight) => insight.keyword).slice(0, 20)
      : longTailOpportunity.rejected_keywords,
    keyword_summary: keyword,
    traffic_summary: traffic,
    prediction_summary: prediction,
    raw,
  };
}

export function resolveProductData(product: ProductRecord): ResolvedProductData {
  const notes: string[] = [];
  const mcp = product.mcp_snapshot;
  const excel = product.excel;
  const manual = product.manual;

  const competitorPrice = firstNumber(mcp?.coupon_price, mcp?.price, excel.price_mid);
  const priceSource = mcp?.coupon_price !== null && mcp?.coupon_price !== undefined ? 'MCP券后价' : mcp?.price ? 'MCP售价' : excel.price_mid ? 'Excel价格' : '缺失';
  const targetPriceForEstimate = competitorPrice ? competitorPrice * 0.95 : null;
  const estimatedFba = targetPriceForEstimate ? targetPriceForEstimate * 0.25 : null;
  const resolvedFba = firstNumber(mcp?.fba_fee, manual.fba_fee, estimatedFba);
  const fbaSource: FbaFeeSource =
    mcp?.fba_fee !== null && mcp?.fba_fee !== undefined
      ? (mcp.fba_fee_source ?? 'mcp')
      : manual.fba_fee !== null && manual.fba_fee !== undefined
        ? 'manual'
        : estimatedFba !== null
          ? 'estimated'
          : 'missing';
  const referralFeeRate = firstNumber(mcp?.referral_fee_rate, manual.referral_fee_rate, 0.15);
  const referralFeeRateSource: ReferralFeeRateSource =
    mcp?.referral_fee_rate !== null && mcp?.referral_fee_rate !== undefined
      ? (mcp.referral_fee_rate_source ?? 'mcp')
      : manual.referral_fee_rate !== null && manual.referral_fee_rate !== undefined && manual.referral_fee_rate !== 0.15
        ? 'manual'
        : 'default_rate';

  const reviewMeta = normalizeEffectiveReviewCount(product);
  const reviewCount = firstNumber(reviewMeta.effective_review_count, mcp?.review_count, excel.review_count);
  const monthlySales = firstNumber(normalizeMonthlySales(product), mcp?.monthly_sales, mcp?.prediction_summary?.recent_30d_sales, excel.monthly_sales);
  const monthlyRevenue = firstNumber(mcp?.monthly_revenue, mcp?.prediction_summary?.recent_30d_revenue, excel.monthly_revenue);
  const productAgeDays = firstNumber(normalizeProductAgeDays(product), mcp?.product_age_days, mcp?.listed_days);

  if (reviewCount === null) notes.push('评论数缺失，需前台复核。');
  if (competitorPrice === null) notes.push('价格缺失，需前台复核。');
  if (monthlySales === null) notes.push('月销量缺失，需补充销量数据。');
  if (fbaSource === 'estimated') notes.push('FBA费用估算。');
  if (resolvedFba === null) notes.push('FBA费用缺失，需人工补充。');
  if (mcp && productAgeDays === null) notes.push('上架时间缺失，需前台复核。');

  return {
    asin: product.asin,
    title: firstString(mcp?.title, excel.title),
    brand: firstString(mcp?.brand, excel.brand),
    category: firstString(mcp?.category, excel.category),
    competitor_price: competitorPrice,
    price_source: priceSource,
    rating: firstNumber(normalizeRating(product), mcp?.rating, excel.rating),
    review_count: reviewCount,
    effective_review_count: reviewCount,
    review_text_count: reviewMeta.review_text_count,
    rating_count: reviewMeta.rating_count,
    review_count_source: reviewMeta.review_count_source,
    monthly_sales: monthlySales,
    monthly_revenue: monthlyRevenue,
    bsr: firstNumber(mcp?.bsr, excel.bsr),
    fba_fee: resolvedFba,
    fba_fee_source: fbaSource,
    referral_fee_rate: referralFeeRate,
    referral_fee_rate_source: referralFeeRateSource,
    main_image_url: mcp?.main_image_url ?? null,
    main_image_source: mcp?.main_image_url ? (mcp.main_image_source ?? 'mcp') : 'missing',
    seller: firstString(mcp?.seller, excel.seller),
    seller_type: firstString(mcp?.seller_type, excel.seller_type),
    variation_count: firstNumber(mcp?.variation_count, excel.variation_count),
    listed_at: mcp?.listed_at ?? null,
    listed_at_source: mcp?.listed_at || mcp?.launch_date || mcp?.first_available_date ? (mcp?.listed_at_source ?? 'mcp') : 'missing',
    launch_date: mcp?.launch_date ?? null,
    first_available_date: mcp?.first_available_date ?? null,
    product_age_days: productAgeDays,
    listed_days: firstNumber(mcp?.listed_days, mcp?.product_age_days),
    is_recent_product: Boolean(mcp?.is_recent_product),
    recent_product_level: mcp?.recent_product_level ?? '时间缺失',
    main_keyword: mcp?.main_keyword ?? mcp?.keyword_summary?.keyword ?? null,
    long_tail_keywords: mcp?.long_tail_keywords ?? [],
    keyword_snapshots: mcp?.keyword_snapshots ?? [],
    keyword_insights: mcp?.keyword_insights ?? [],
    keyword_data_confidence: mcp?.keyword_data_confidence ?? 'unknown',
    keyword_source: mcp?.keyword_source ?? null,
    demand_confirmed: mcp?.demand_confirmed ?? 'partial',
    demand_confirm_source: mcp?.demand_confirm_source ?? null,
    long_tail_opportunity_level: mcp?.long_tail_opportunity_level ?? 'unknown',
    recommended_sp_keywords: mcp?.recommended_sp_keywords ?? [],
    rejected_keywords: mcp?.rejected_keywords ?? [],
    keyword: mcp?.main_keyword ?? mcp?.keyword_summary?.keyword ?? null,
    keyword_summary: mcp?.keyword_summary ?? null,
    missing_notes: notes,
  };
}

export function calculateRatingRiskLevel(
  reviewCount: number | null | undefined,
  rating: number | null | undefined,
): { level: RatingRiskLevel; note: string } {
  if (reviewCount === 0) return { level: 'no_rating_opportunity', note: '无评分 / 0评价机会，需前台复核。' };
  if (rating === null || rating === undefined) return { level: 'no_rating_opportunity', note: '评分缺失 / 待前台复核。' };
  if (reviewCount !== null && reviewCount !== undefined && reviewCount > 0 && reviewCount <= 10) {
    return { level: 'unstable_rating_sample', note: '少评样本，评分不稳定。' };
  }
  if (reviewCount !== null && reviewCount !== undefined && reviewCount > 30 && rating < 3.8) {
    return { level: 'severe_low_rating_risk', note: '严重低评分风险。' };
  }
  if (reviewCount !== null && reviewCount !== undefined && reviewCount > 10 && rating < 3.8) {
    return { level: 'low_rating_risk', note: '低评分风险。' };
  }
  return { level: 'normal', note: '评分风险正常。' };
}

function scoreLowReviewSales(resolved: ResolvedProductData): ProductScoreResult['low_review_sales_score'] {
  const signal = calculateNewProductSalesSignalScore(resolved);
  let strength = signal.signal_label;
  if (signal.sales_per_review !== null) {
    if (signal.sales_per_review >= 20) strength = `${signal.signal_label} / 极强动销评论比`;
    else if (signal.sales_per_review >= 10) strength = `${signal.signal_label} / 强动销评论比`;
    else if (signal.sales_per_review >= 5) strength = `${signal.signal_label} / 中等动销评论比`;
  }

  return {
    score: signal.score,
    max: 30,
    label: '低评论出单分',
    notes: signal.explanation,
    sales_per_review: signal.sales_per_review,
    signal: strength || '待判断',
    signal_label: signal.signal_label,
    action_flags: signal.action_flags,
    explanation: signal.explanation,
  };
}

function platformMargin(targetPrice: number | null, referralFeeRate: number, fbaFee: number | null, platformOtherFee: number): number | null {
  if (targetPrice === null || targetPrice <= 0 || fbaFee === null) return null;
  const referralFee = targetPrice * referralFeeRate;
  return (targetPrice - referralFee - fbaFee - platformOtherFee) / targetPrice;
}

function scorePriceMargin(resolved: ResolvedProductData, manual: ProductManualData): ProductScoreResult['price_margin_score'] {
  const notes: string[] = [];
  const price = resolved.competitor_price;
  const referralFeeRate = resolved.referral_fee_rate ?? manual.referral_fee_rate ?? 0.15;
  const platformOtherFee = manual.platform_other_fee ?? 0;
  const fbaFee = resolved.fba_fee;
  const target3 = price !== null ? price * 0.97 : null;
  const target5 = price !== null ? price * 0.95 : null;
  const target8 = price !== null ? price * 0.92 : null;
  const target10 = price !== null ? price * 0.9 : null;
  const margin5 = platformMargin(target5, referralFeeRate, fbaFee, platformOtherFee);
  const margin8 = platformMargin(target8, referralFeeRate, fbaFee, platformOtherFee);

  let score = 0;
  if (margin5 === null) {
    notes.push('价格或 FBA 费用缺失，无法计算平台后毛利。');
  } else if (margin5 >= 0.7) score += 15;
  else if (margin5 >= 0.6) score += 12;
  else if (margin5 >= 0.5) score += 6;

  if (margin5 !== null && margin5 >= 0.6) score += 5;
  if (margin8 !== null && margin8 >= 0.6) score += 3;
  if (price !== null && price >= 12 && price <= 40) score += 2;
  if (resolved.fba_fee_source === 'estimated') notes.push('FBA费用估算，平台后毛利需复核。');

  const platformCosts = target5 !== null && margin5 !== null ? target5 * (1 - margin5) : null;
  return {
    score: clamp(score, 25),
    max: 25,
    label: '价格压制与平台毛利分',
    notes,
    target_price_3: target3,
    target_price_5: target5,
    target_price_8: target8,
    target_price_10: target10,
    platform_margin_rate: margin5,
    platform_costs: platformCosts,
    fba_fee_estimated: resolved.fba_fee_source === 'estimated',
  };
}

function hasCostConfirmed(manual: ProductManualData): boolean {
  return [manual.purchase_cost_usd, manual.first_mile_cost_usd, manual.package_cost_usd, manual.return_loss].every((value) => value !== null && value !== undefined);
}

function scoreFinalMargin(
  priceScore: ProductScoreResult['price_margin_score'],
  resolved: ResolvedProductData,
  manual: ProductManualData,
): ProductScoreResult['final_margin_score'] {
  const notes: string[] = [];
  const targetPrice = priceScore.target_price_5;
  const referralFeeRate = resolved.referral_fee_rate ?? manual.referral_fee_rate ?? 0.15;
  const referralFee = targetPrice !== null ? targetPrice * referralFeeRate : null;
  const fbaFee = resolved.fba_fee;
  const costConfirmed = hasCostConfirmed(manual);

  if (!costConfirmed) notes.push('全成本毛利待测算。');

  if (targetPrice === null || referralFee === null || fbaFee === null) {
    return { score: 2, max: 20, label: '全成本毛利分', notes: [...notes, '缺少价格或 FBA 费用。'], full_costs: null, full_profit: null, full_margin_rate: null, cost_confirmed: costConfirmed };
  }

  const productCosts =
    (manual.purchase_cost_usd ?? 0) +
    (manual.first_mile_cost_usd ?? 0) +
    (manual.package_cost_usd ?? 0) +
    (manual.storage_cost_usd ?? 0) +
    (manual.return_loss ?? 0) +
    (manual.platform_other_fee ?? 0);
  const fullCosts = productCosts + referralFee + fbaFee;
  const fullProfit = targetPrice - fullCosts;
  const fullMargin = fullProfit / targetPrice;

  let score = 0;
  if (costConfirmed) {
    if (fullMargin >= 0.3) score = 20;
    else if (fullMargin >= 0.25) score = 16;
    else if (fullMargin >= 0.18) score = 8;
  } else {
    const platformMargin = priceScore.platform_margin_rate;
    if (platformMargin === null) score = 2;
    else if (platformMargin >= 0.7) score = 12;
    else if (platformMargin >= 0.6) score = 10;
    else if (platformMargin >= 0.5) score = 6;
    else score = 2;
  }

  return { score: clamp(score, 20), max: 20, label: '全成本毛利分', notes, full_costs: fullCosts, full_profit: fullProfit, full_margin_rate: fullMargin, cost_confirmed: costConfirmed };
}

function mainKeywordData(resolved: ResolvedProductData): McpKeywordSnapshot | null {
  const mainSnapshot = resolved.keyword_snapshots.find((snapshot) => snapshot.keyword_type === 'main' && !snapshot.error);
  return mainSnapshot ?? resolved.keyword_summary;
}

function keywordWordCount(keyword: string | null | undefined): number {
  return keyword?.trim().split(/\s+/).filter(Boolean).length ?? 0;
}

function scoreLowBidAd(resolved: ResolvedProductData): ProductScoreResult['low_bid_ad_score'] {
  const notes: string[] = [];
  const confidence = resolved.keyword_data_confidence;
  const insightRecommended = resolved.keyword_insights.filter((insight) => !insight.reject_reason && insight.recommended_action && insight.opportunity_score >= 45);
  const realInsightCount = resolved.keyword_insights.filter((insight) => insight.source_tool !== 'title_generated' && insight.source_tool !== 'title_split_fallback').length;
  const keyword = mainKeywordData(resolved);
  const tails = resolved.keyword_snapshots.filter((snapshot) => snapshot.keyword_type !== 'main' && !snapshot.error);
  const longTailOpportunity = calculateLongTailOpportunity(resolved.keyword_snapshots);
  if (realInsightCount && insightRecommended.length) {
    const base = insightRecommended.length >= 3 ? 11 : insightRecommended.length >= 1 ? 8 : 5;
    const strong = insightRecommended.filter((insight) => insight.opportunity_score >= 70).length;
    const score = clamp(base + Math.min(4, strong), 15);
    return {
      score,
      max: 15,
      label: '低竞价广告机会分',
      notes: confidence === 'high' ? ['基于 ASIN 反查关键词和关键词指标计算。'] : ['基于 ASIN 反查关键词计算，部分指标仍需 keyword_miner 补充。'],
      long_tail_keyword_count: insightRecommended.length,
      opportunity_level: insightRecommended.length >= 3 ? 'strong' : 'medium',
      recommended_keywords: insightRecommended.map((insight) => insight.keyword).slice(0, 10),
      keyword_data_confidence: confidence,
      signal: insightRecommended.length >= 3 ? '适合低预算 SP 捡漏' : '可小预算测试',
    };
  }
  if (!tails.length) {
    return {
      score: confidence === 'low' ? 5 : 9,
      max: 15,
      label: '低竞价广告机会分',
      notes: confidence === 'low' ? ['关键词仅标题拆解，需 ASIN 反查确认。'] : ['待长尾词确认。'],
      long_tail_keyword_count: 0,
      opportunity_level: 'unknown',
      recommended_keywords: [],
      keyword_data_confidence: confidence,
      signal: '待长尾词确认',
    };
  }

  let score = 0;
  if ((keyword?.search_volume ?? 0) > 0 || (keyword?.purchase_volume ?? 0) > 0) score += 2;
  else notes.push('主关键词需求信号待确认。');
  if (typeof keyword?.ppc_bid === 'number' && keyword.ppc_bid <= 2) score += 2;
  else notes.push('主关键词 PPC 偏高或未返回。');
  if ((keyword?.purchase_rate ?? 0) >= 0.03 || (keyword?.purchase_volume ?? 0) > 0) score += 1;

  const usefulSearchCount = tails.filter((snapshot) => (snapshot.search_volume ?? 0) >= 300 && (snapshot.search_volume ?? 0) <= 5000).length;
  const lowBidCount = tails.filter((snapshot) => {
    if (typeof snapshot.ppc_bid !== 'number') return false;
    return snapshot.ppc_bid <= 1 || (typeof keyword?.ppc_bid === 'number' && snapshot.ppc_bid <= keyword.ppc_bid);
  }).length;
  const lowTitleDensityCount = tails.filter((snapshot) => (snapshot.title_density ?? Number.POSITIVE_INFINITY) <= 50).length;
  const lowCompetitionCount = tails.filter(
    (snapshot) => (snapshot.ad_competitor_count ?? Number.POSITIVE_INFINITY) <= 100 || snapshot.competition_level === '低',
  ).length;
  if (usefulSearchCount >= 3) score += 2;
  if (lowBidCount >= 3) score += 2;
  if (lowTitleDensityCount >= 3) score += 2;
  if (lowCompetitionCount >= 3) score += 2;

  const distributedCount = new Set(
    tails
      .filter((snapshot) => keywordWordCount(snapshot.keyword) >= 3 && (snapshot.search_volume ?? 0) > 0)
      .map((snapshot) => snapshot.keyword),
  ).size;
  if (distributedCount >= 3) score += 2;
  else if (distributedCount >= 2) score += 1;

  if (longTailOpportunity.level === 'weak') notes.push('长尾词搜索量、PPC 或竞争结构偏弱。');
  const signal =
    longTailOpportunity.level === 'strong'
      ? '适合低预算 SP 捡漏'
      : longTailOpportunity.level === 'medium'
        ? '可小预算测试'
        : '广告机会一般';
  return {
    score: confidence === 'low' ? Math.min(clamp(score, 15), 6) : clamp(score, 15),
    max: 15,
    label: '低竞价广告机会分',
    notes: confidence === 'low' ? [...notes, '关键词仅标题拆解，需 ASIN 反查确认。'] : notes,
    long_tail_keyword_count: longTailOpportunity.usable_keywords.length,
    opportunity_level: longTailOpportunity.level,
    recommended_keywords: longTailOpportunity.recommended_sp_keywords,
    keyword_data_confidence: confidence,
    signal,
  };
}

function scoreListingSafety(
  manual: ProductManualData,
  ratingRisk: ReturnType<typeof calculateRatingRiskLevel>,
): ProductScoreResult['listing_safety_score'] {
  const tags = manual.risk_tags ?? [];
  const hasSevere = manual.risk_level === 'severe' || tags.some((tag) => severeRiskKeywords.some((risk) => tag.toLowerCase().includes(risk.toLowerCase())));
  if (hasSevere) return { score: 0, max: 10, label: '铺货安全分', notes: ['存在严重风险标签。'], risk_level: 'severe' };
  const notes: string[] = [];
  let score = manual.risk_level === 'medium' ? 4 : manual.risk_level === 'light' ? 7 : 10;
  if (manual.risk_level === 'medium') notes.push('存在中风险标签。');
  if (manual.risk_level === 'light') notes.push('存在轻风险标签。');
  if (ratingRisk.level === 'low_rating_risk') {
    score -= 2;
    notes.push('已有评论样本下出现低评分风险。');
  }
  if (ratingRisk.level === 'severe_low_rating_risk') {
    score -= 5;
    notes.push('评论样本已放大，低评分风险偏重。');
  }
  if (ratingRisk.level === 'no_rating_opportunity' || ratingRisk.level === 'unstable_rating_sample') notes.push(ratingRisk.note);
  return { score: clamp(score, 10), max: 10, label: '铺货安全分', notes, risk_level: manual.risk_level };
}

function recentProductPreference(resolved: ResolvedProductData): { bonus: number; notes: string[] } {
  const age = resolved.product_age_days;
  const reviews = resolved.review_count;
  const sales = resolved.monthly_sales;
  if (age === null) return { bonus: 0, notes: ['上架时间缺失，需前台复核。'] };
  if (age > 365) return { bonus: 0, notes: ['老链接，需确认是否靠历史权重。'] };
  if (reviews === null || sales === null) return { bonus: 0, notes: [] };
  if (age > 30 && age <= 180 && sales >= 30 && reviews <= 100) {
    return { bonus: 3, notes: ['30-180 天新品已有基础销量，时间信号加权。'] };
  }
  if (age > 180 && age <= 365 && sales >= 30 && reviews <= 100) {
    return { bonus: 1, notes: ['180-365 天稳定新品，时间信号中性偏好。'] };
  }
  return { bonus: 0, notes: [] };
}

function scoreSalesDataConfidence(resolved: ResolvedProductData): ProductScoreResult['sales_data_confidence_score'] {
  const notes: string[] = [];
  const hasMonthlySales = resolved.monthly_sales !== null;
  const hasBsr = resolved.bsr !== null;
  const hasKeywordEvidence = resolved.keyword_data_confidence === 'high' || resolved.keyword_data_confidence === 'medium_high';
  let score = 20;
  let labelText = '销量数据缺失或异常';
  if (hasMonthlySales && hasBsr && hasKeywordEvidence) {
    score = 90;
    labelText = '销量、BSR 与关键词证据一致';
    notes.push('月销量、BSR 和 ASIN 关键词/出单词数据均可交叉验证。');
  } else if (hasMonthlySales && hasBsr) {
    score = 75;
    labelText = '销量与 BSR 基本一致';
    notes.push('月销量与 BSR 可用于基础判断，关键词仍可补充。');
  } else if (hasMonthlySales) {
    score = 60;
    labelText = '仅有卖家精灵月销量预测';
    notes.push('已有月销量预测，但缺少趋势/关键词交叉验证。');
  } else if (hasBsr) {
    score = 40;
    labelText = '仅有 BSR 估算线索';
    notes.push('月销量缺失，仅可用 BSR 作为弱线索。');
  } else {
    notes.push('销量数据缺失、过期或未返回。');
  }
  return { score, max: 100, label: '销量置信度', notes, label_text: labelText };
}

function scoreVariationRisk(resolved: ResolvedProductData, product: ProductRecord): ProductScoreResult['variation_risk_score'] {
  const flags: string[] = [];
  const notes: string[] = [];
  const variationCount = resolved.variation_count ?? 0;
  let score = 15;
  let labelText = '低变体风险';
  if (variationCount >= 20) {
    score = 80;
    labelText = '复杂变体风险高';
    flags.push('复杂变体，需确认是否父体/子体共享动销');
  } else if (variationCount > 15) {
    score = 65;
    labelText = '变体偏多';
    flags.push('变体数偏多，正式 A 池前需复核');
  } else if (variationCount > 0) {
    score = 30;
    labelText = '存在少量变体';
  }

  const raw = product.mcp_snapshot?.raw;
  const rawText = raw ? JSON.stringify(raw).slice(0, 20_000) : '';
  if (rawText.includes('dataAsin') && product.asin && !rawText.includes(product.asin)) {
    flags.push('Keepa实际返回ASIN可能不同，需复核');
  }
  if (flags.length) notes.push(...flags);
  else notes.push('暂未发现明显父体/子体共享动销风险。');
  return { score, max: 100, label: '变体风险', notes, label_text: labelText, flags };
}

function scoreDemandConfirmation(resolved: ResolvedProductData): ProductScoreResult['demand_confirmation_score'] {
  const sources = new Set(resolved.keyword_insights.map((insight) => insight.source_tool));
  let confirmed: boolean | 'partial' = false;
  let source: string | null = null;
  let keywordConfidenceScore = 20;
  const notes: string[] = [];
  if (sources.has('traffic_keyword')) {
    confirmed = true;
    source = 'traffic_keyword';
    keywordConfidenceScore = 90;
    notes.push('ASIN真实流量词已返回，需求证据较强。');
  } else if (sources.has('keyword_order')) {
    confirmed = true;
    source = 'keyword_order';
    keywordConfidenceScore = 80;
    notes.push('出单词反查已返回，可用于需求确认和 SP 候选。');
  } else if (resolved.keyword_data_confidence === 'medium' || sources.has('keyword_miner') || sources.has('keyword_research')) {
    confirmed = 'partial';
    source = 'keyword_metrics';
    keywordConfidenceScore = 60;
    notes.push('仅有关键词指标/挖掘数据，需求为部分确认。');
  } else if (resolved.keyword_data_confidence === 'low') {
    source = 'title_split_fallback';
    keywordConfidenceScore = 20;
    notes.push('当前关键词仅标题拆解，不作为真实投放建议。');
  } else {
    notes.push('关键词需求未确认，需 ASIN 反查。');
  }
  return {
    score: keywordConfidenceScore,
    max: 100,
    label: '关键词需求确认',
    notes,
    confirmed,
    source,
    keyword_confidence_score: keywordConfidenceScore,
  };
}

function scoreListingTest(
  resolved: ResolvedProductData,
  priceScore: ProductScoreResult['price_margin_score'],
  finalScore: ProductScoreResult['final_margin_score'],
  safetyScore: ProductScoreResult['listing_safety_score'],
  newSignal: ProductScoreResult['new_product_sales_signal_score'],
  ratingRisk: ReturnType<typeof calculateRatingRiskLevel>,
): ProductScoreResult['listing_test_score'] {
  const notes: string[] = [];
  const whyTestable: string[] = [];
  const whyNotE: string[] = [];
  const missingReviewItems: string[] = [];
  const sales = resolved.monthly_sales;
  const reviews = resolved.review_count;
  const price = resolved.competitor_price;
  const age = resolved.product_age_days;
  const platformMargin = priceScore.platform_margin_rate;
  const fullMargin = finalScore.full_margin_rate;
  const costConfirmed = finalScore.cost_confirmed;
  const severeRisk = safetyScore.risk_level === 'severe';
  let score = 0;

  if (resolved.fba_fee_source === 'missing' || resolved.fba_fee_source === 'estimated') missingReviewItems.push('FBA费缺失/估算，待测算');
  if (resolved.keyword_data_confidence === 'unknown' || resolved.keyword_data_confidence === 'low') missingReviewItems.push('关键词未反查，待复核');
  if (resolved.main_image_source === 'missing') missingReviewItems.push('主图缺失，待补图/前台复核');
  if (age === null) missingReviewItems.push('上架时间缺失，待前台复核');
  if (!costConfirmed) missingReviewItems.push('全成本利润未完整测算');
  if (resolved.review_count_source === 'missing') missingReviewItems.push('评论/评分数缺失，待前台复核');

  if (severeRisk) {
    return {
      score: 0,
      max: 100,
      label: '硬风险放弃',
      notes: ['存在严重风险，铺货测试不放宽。'],
      action_advice: '放弃',
      why_testable: [],
      why_not_e: [],
      missing_review_items: missingReviewItems,
      suitable_small_batch: false,
      suitable_low_cost_test: false,
    };
  }

  score += 10;
  whyNotE.push('未命中严重风险，普通缺失字段按待复核处理。');

  if (newSignal.score >= 28) {
    score += 22;
    whyTestable.push('新品/少评动销信号强，适合优先测试。');
  } else if (newSignal.score >= 22) {
    score += 18;
    whyTestable.push('0评论/少评论已有动销，适合低成本试上架。');
  } else if (newSignal.score >= 10) {
    score += 10;
    whyTestable.push('评论或销量存在待复核机会，不直接判差品。');
  }

  if (sales !== null && reviews !== null) {
    if (sales >= 5 && sales < 20 && reviews <= 30) {
      score += 18;
      whyTestable.push('月销量5-20且评论<=30，小销量少评可测试。');
    } else if (sales >= 20 && sales <= 80 && reviews <= 100) {
      score += 26;
      whyTestable.push('月销量20-80且评论<=100，适合小批量上架测试。');
    } else if (sales > 80 && sales <= 300 && reviews <= 300) {
      score += 22;
      whyTestable.push('月销量80-300且评论<=300，有铺货测试容量。');
    } else if (sales > 300) {
      score += 12;
      whyTestable.push('月销量较高，可作为压价测试对象，但需关注竞争。');
    } else if (sales > 0 && reviews <= 100) {
      score += 10;
      whyTestable.push('已有动销且评论不高，适合观察复核。');
    }
  } else if (sales !== null && sales > 0) {
    score += 10;
    whyTestable.push('月销量存在但评论缺失，先进入待复核测试池。');
  } else if (reviews !== null && reviews <= 30) {
    score += 8;
    whyTestable.push('销量缺失但评论低，适合补数据后判断。');
  }

  if (price !== null && price >= 12 && price <= 40) {
    score += 14;
    whyTestable.push('价格带在$12-$40，符合铺货测试区间。');
  } else if (price !== null && price >= 10 && price <= 50) {
    score += 8;
    whyTestable.push('价格带接近可测范围。');
  } else if (price === null) {
    score += 5;
    whyNotE.push('价格缺失先待复核，不直接放弃。');
  }

  if (age !== null && age <= 365) {
    score += 10;
    whyTestable.push('上架时间不算太老。');
  } else if (age !== null && age <= 730) {
    score += 6;
    whyTestable.push('上架时间偏老但仍可观察测试。');
  } else if (age === null) {
    score += 5;
    whyNotE.push('上架时间缺失只标记待复核。');
  }

  if (platformMargin !== null && platformMargin >= 0.6) {
    score += 15;
    whyTestable.push('平台后毛利率初步达标。');
  } else if (platformMargin !== null && platformMargin >= 0.5) {
    score += 10;
    whyTestable.push('平台后毛利率接近达标，适合小批量测算。');
  } else if (platformMargin === null || resolved.fba_fee_source === 'missing' || resolved.fba_fee_source === 'estimated') {
    score += 8;
    whyNotE.push('利润/FBA未完整确认，先补测算而不是直接放弃。');
  }

  if (costConfirmed && fullMargin !== null && fullMargin < 0.18) {
    notes.push('全成本毛利率已确认严重不足，不建议测试。');
    score = Math.min(score, 20);
  }
  if (ratingRisk.level === 'severe_low_rating_risk') {
    notes.push('低评分且评论样本较多，铺货测试需暂缓。');
    score = Math.min(score, 35);
  }
  if (missingReviewItems.length) notes.push(`待复核项：${missingReviewItems.join('、')}。`);

  const listingScore = clamp(score, 100);
  let actionAdvice = '暂缓';
  if (costConfirmed && fullMargin !== null && fullMargin < 0.18) actionAdvice = '放弃';
  else if (listingScore >= 78 && platformMargin !== null && platformMargin >= 0.6) actionAdvice = '重点开发';
  else if (listingScore >= 60) actionAdvice = '小批量上架测试';
  else if (listingScore >= 45) actionAdvice = '低成本试上架';
  else if (missingReviewItems.some((item) => item.includes('FBA') || item.includes('利润'))) actionAdvice = '补 FBA/利润后再决策';
  else if (listingScore >= 30) actionAdvice = '前台复核后再测';

  return {
    score: listingScore,
    max: 100,
    label: actionAdvice,
    notes,
    action_advice: actionAdvice,
    why_testable: whyTestable,
    why_not_e: whyNotE,
    missing_review_items: missingReviewItems,
    suitable_small_batch: listingScore >= 60 && !(costConfirmed && fullMargin !== null && fullMargin < 0.18),
    suitable_low_cost_test: listingScore >= 35 && !(costConfirmed && fullMargin !== null && fullMargin < 0.18),
  };
}

function missingDataOnly(resolved: ResolvedProductData): boolean {
  return (
    resolved.rating === null ||
    resolved.fba_fee_source === 'missing' ||
    resolved.fba_fee_source === 'estimated' ||
    resolved.main_image_source === 'missing' ||
    resolved.keyword_data_confidence === 'unknown' ||
    resolved.keyword_data_confidence === 'low' ||
    resolved.product_age_days === null ||
    resolved.monthly_sales === null ||
    resolved.review_count === null
  );
}

function assignLayer(
  product: ProductRecord,
  resolved: ResolvedProductData,
  score: Omit<ProductScoreResult, 'flea_market_score' | 'action_advice' | 'rating_risk_level' | 'rating_risk_note' | 'layer' | 'layer_reasons' | 'is_a_candidate'>,
  total: number,
  recentNotes: string[],
): Pick<ProductScoreResult, 'layer' | 'layer_reasons' | 'is_a_candidate'> {
  const reasons: string[] = [...recentNotes];
  const reviews = resolved.review_count;
  const sales = resolved.monthly_sales;
  const revenue = resolved.monthly_revenue;
  const price = resolved.competitor_price;
  const rating = resolved.rating;
  const platformMargin = score.price_margin_score.platform_margin_rate;
  const fullMargin = score.final_margin_score.full_margin_rate;
  const costConfirmed = score.final_margin_score.cost_confirmed;
  const severeRisk = score.listing_safety_score.risk_level === 'severe';
  const sellerType = `${resolved.seller_type ?? ''} ${resolved.seller ?? ''}`.toLowerCase();
  const amazonSelf = sellerType.includes('amazon');
  const highVariation = (resolved.variation_count ?? 0) > 15;
  const canDiscount5 = platformMargin !== null && platformMargin >= 0.6;
  const noSevereRisk = !severeRisk;
  const productAgeDays = resolved.product_age_days;
  const eligibleForAByAge = productAgeDays === null || productAgeDays <= 365;
  const eligibleForBByAge = productAgeDays === null || productAgeDays <= 730;
  const ratingRisk = calculateRatingRiskLevel(reviews, rating);
  const newSignal = score.new_product_sales_signal_score;
  const salesPerReview = newSignal.sales_per_review;
  const priceReasonable = price !== null && price >= 12 && price <= 40;
  const fbaMissingOrEstimated = resolved.fba_fee_source === 'missing' || resolved.fba_fee_source === 'estimated';
  const keywordMissing = resolved.keyword_data_confidence === 'unknown' || resolved.keyword_data_confidence === 'low';
  const hasNewSalesOpportunity = newSignal.is_new_product_sales_signal || (newSignal.score >= 10 && (sales ?? 0) > 0);
  const listingTest = score.listing_test_score;
  const confirmedSevereProfitLoss = costConfirmed && fullMargin !== null && fullMargin < 0.18;
  const confirmedWeakPlatformMargin = platformMargin !== null && platformMargin < 0.35 && !fbaMissingOrEstimated && !hasNewSalesOpportunity;
  const clearlyNoSalesSignal =
    sales !== null &&
    sales < 5 &&
    (revenue === null || revenue < 1000) &&
    !hasNewSalesOpportunity &&
    !(reviews !== null && reviews <= 100 && sales > 0);
  const highReviewLowSales =
    reviews !== null &&
    reviews >= 500 &&
    sales !== null &&
    sales < 20 &&
    !hasNewSalesOpportunity;
  const hardRatingRisk = ratingRisk.level === 'severe_low_rating_risk' && reviews !== null && reviews > 30;
  const officialADataReady =
    score.sales_data_confidence_score.score >= 70 &&
    score.variation_risk_score.score < 65 &&
    (score.demand_confirmation_score.confirmed === true ||
      (score.demand_confirmation_score.confirmed === 'partial' && newSignal.score >= 28)) &&
    platformMargin !== null &&
    platformMargin >= 0.6;

  if (fbaMissingOrEstimated) reasons.push('FBA费缺失待测算。');
  if (keywordMissing) reasons.push('关键词未反查待复核。');
  if (resolved.main_image_source === 'missing') reasons.push('主图缺失待复核。');

  if (
    severeRisk ||
    clearlyNoSalesSignal ||
    confirmedWeakPlatformMargin ||
    confirmedSevereProfitLoss ||
    highReviewLowSales ||
    hardRatingRisk
  ) {
    reasons.push('触发放弃池硬规则：严重风险、确认利润严重不足、明确无销量、低评分大样本或高评论低销量。');
    return { layer: 'E放弃池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (reviews === 0 && sales !== null && sales >= 20 && productAgeDays !== null && productAgeDays <= 180) {
    reasons.push('0评论已出单，rating缺失按中性处理，至少进入 B。');
    if (platformMargin !== null && platformMargin >= 0.6 && noSevereRisk) {
      if (officialADataReady) {
        reasons.push('平台后毛利、销量置信度、关键词和变体风险达到正式 A 池条件。');
        return { layer: 'A低评论出单优先池', layer_reasons: reasons, is_a_candidate: false };
      }
      reasons.push('新品动销强，但关键词/趋势/变体/FBA或利润仍需复核，进入 A 候选。');
      return { layer: 'A候选强机会待复核', layer_reasons: reasons, is_a_candidate: true };
    }
    return { layer: 'B价格压制测试池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    productAgeDays !== null &&
    productAgeDays <= 365 &&
    reviews !== null &&
    reviews <= 30 &&
    sales !== null &&
    sales >= 20 &&
    salesPerReview !== null &&
    salesPerReview >= 5 &&
    noSevereRisk
  ) {
    if (platformMargin !== null && platformMargin >= 0.6) {
      if (officialADataReady) {
        reasons.push('低评论出单优先池。');
        return { layer: 'A低评论出单优先池', layer_reasons: reasons, is_a_candidate: false };
      }
      reasons.push('低评论出单强机会，但关键数据仍待复核，进入 A 候选。');
      return { layer: 'A候选强机会待复核', layer_reasons: reasons, is_a_candidate: true };
    }
    if (fbaMissingOrEstimated && priceReasonable) {
      reasons.push('新品动销强，但 FBA/毛利仍需测算，先进入价格压制测试池。');
      return { layer: 'B价格压制测试池', layer_reasons: reasons, is_a_candidate: false };
    }
  }

  if (
    reviews !== null &&
    reviews <= 10 &&
    eligibleForAByAge &&
    sales !== null &&
    sales >= 10 &&
    newSignal.score >= 22 &&
    noSevereRisk
  ) {
    reasons.push('新品动销但数据待补，进入价格压制测试池。');
    return { layer: 'B价格压制测试池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    noSevereRisk &&
    newSignal.score >= 10 &&
    listingTest.score < 50 &&
    newSignal.score < 22 &&
    ((reviews === 0 && sales !== null && sales >= 5) || fbaMissingOrEstimated || productAgeDays === null || keywordMissing) &&
    !(platformMargin !== null && platformMargin >= 0.6 && reviews !== null && reviews <= 30 && sales !== null && sales >= 20 && eligibleForAByAge)
  ) {
    reasons.push('小类目观察池，数据缺失按待复核处理。');
    return { layer: 'C小类目观察池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    total >= 75 &&
    score.low_review_sales_score.score >= 22 &&
    platformMargin !== null &&
    platformMargin >= 0.6 &&
    reviews !== null &&
    reviews <= 100 &&
    sales !== null &&
    sales >= 30 &&
    price !== null &&
    price >= 12 &&
    price <= 40 &&
    noSevereRisk &&
    eligibleForAByAge
  ) {
    if (productAgeDays === null) reasons.push('上架时间缺失，A池仍需前台复核。');
    if (officialADataReady) {
      reasons.push('满足重点开发条件。');
      return { layer: 'A低评论出单优先池', layer_reasons: reasons, is_a_candidate: false };
    }
    reasons.push('总分达到重点开发信号，但关键词/趋势/变体或利润仍需复核，进入 A 候选。');
    return { layer: 'A候选强机会待复核', layer_reasons: reasons, is_a_candidate: true };
  }

  if (
    noSevereRisk &&
    !highVariation &&
    !amazonSelf &&
    (
      newSignal.score >= 26 ||
      (listingTest.score >= 75 && newSignal.score >= 22) ||
      (total >= 65 && sales !== null && sales >= 20 && reviews !== null && reviews <= 100)
    ) &&
    !(ratingRisk.level === 'severe_low_rating_risk' && reviews !== null && reviews > 30)
  ) {
    reasons.push('强机会但仍有 FBA/利润/关键词/变体等待确认项，进入 A 候选。');
    return { layer: 'A候选强机会待复核', layer_reasons: reasons, is_a_candidate: true };
  }

  if (
    noSevereRisk &&
    (
      (listingTest.score >= 50 && ((sales !== null && sales >= 10) || newSignal.score >= 22)) ||
      newSignal.score >= 22 ||
      (sales !== null && sales >= 20 && sales <= 80 && (reviews === null || reviews <= 100) && priceReasonable) ||
      (sales !== null && sales > 80 && sales <= 300 && (reviews === null || reviews <= 300) && priceReasonable)
    ) &&
    !(ratingRisk.level === 'severe_low_rating_risk' && reviews !== null && reviews > 30)
  ) {
    reasons.push('小批量上架测试池：销量、评论和价格带具备铺货测试空间，允许部分数据待复核。');
    return { layer: 'B价格压制测试池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    noSevereRisk &&
    (
      listingTest.score >= 35 ||
      (sales !== null && sales >= 5 && (reviews === null || reviews <= 100)) ||
      (reviews !== null && reviews <= 30 && (sales === null || sales > 0)) ||
      (missingDataOnly(resolved) && listingTest.score >= 25)
    )
  ) {
    reasons.push('低成本观察/可试上架：普通数据缺失按待复核处理，不作为 E 池原因。');
    return { layer: 'C小类目观察池', layer_reasons: reasons, is_a_candidate: false };
  }

  if ((reviews !== null && reviews > 300) || (reviews !== null && sales !== null && sales >= 200 && reviews >= 300) || amazonSelf || highVariation || ratingRisk.level === 'severe_low_rating_risk') {
    reasons.push(ratingRisk.level === 'severe_low_rating_risk' ? '低评分样本已放大，不进入 A/B 池。' : '评论、Amazon自营或变体竞争偏高。');
    return { layer: 'D竞争偏高池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    total >= 75 &&
    score.low_review_sales_score.score >= 22 &&
    platformMargin !== null &&
    platformMargin >= 0.6 &&
    reviews !== null &&
    reviews <= 100 &&
    sales !== null &&
    sales >= 30 &&
    price !== null &&
    price >= 12 &&
    price <= 40 &&
    noSevereRisk &&
    eligibleForAByAge
  ) {
    if (productAgeDays === null) reasons.push('上架时间缺失，A池仍需前台复核。');
    if (officialADataReady) {
      reasons.push('满足低评论出单优先池。');
      return { layer: 'A低评论出单优先池', layer_reasons: reasons, is_a_candidate: false };
    }
    reasons.push('总分达到 A 信号，但关键词/趋势/变体或利润仍需复核，进入 A 候选。');
    return { layer: 'A候选强机会待复核', layer_reasons: reasons, is_a_candidate: true };
  }

  if (total >= 65 && platformMargin !== null && platformMargin >= 0.6 && sales !== null && sales >= 20 && reviews !== null && reviews <= 300 && noSevereRisk && eligibleForBByAge) {
    if (productAgeDays !== null && productAgeDays > 365) reasons.push('老链接观察。');
    reasons.push('满足价格压制测试池。');
    return { layer: 'B价格压制测试池', layer_reasons: reasons, is_a_candidate: false };
  }

  if (
    (reviews === null || reviews <= 100) &&
    sales !== null &&
    sales >= 10 &&
    sales <= 50 &&
    platformMargin !== null &&
    platformMargin >= 0.5 &&
    noSevereRisk
  ) {
    if (productAgeDays === null) reasons.push('上架时间缺失，适合先观察。');
    if (productAgeDays !== null && productAgeDays > 365) reasons.push('老链接进入观察池。');
    reasons.push('适合小类目观察或前台复核。');
    return { layer: 'C小类目观察池', layer_reasons: reasons, is_a_candidate: false };
  }

  reasons.push('关键字段不足或未命中明确分层规则。');
  return { layer: '待复核', layer_reasons: reasons, is_a_candidate: false };
}

export function scoreProduct(product: ProductRecord): ProductScoreResult {
  const resolved = resolveProductData(product);
  const ratingRisk = calculateRatingRiskLevel(resolved.review_count, resolved.rating);
  const lowReview = scoreLowReviewSales(resolved);
  const newProductSalesSignal = calculateNewProductSalesSignalScore(resolved);
  const priceMargin = scorePriceMargin(resolved, product.manual);
  const finalMargin = scoreFinalMargin(priceMargin, resolved, product.manual);
  const lowBidAd = scoreLowBidAd(resolved);
  const safety = scoreListingSafety(product.manual, ratingRisk);
  const salesConfidence = scoreSalesDataConfidence(resolved);
  const variationRisk = scoreVariationRisk(resolved, product);
  const demandConfirmation = scoreDemandConfirmation(resolved);
  const listingTest = scoreListingTest(resolved, priceMargin, finalMargin, safety, newProductSalesSignal, ratingRisk);
  const recentPreference = recentProductPreference(resolved);
  const partial = {
    low_review_sales_score: lowReview,
    new_product_sales_signal_score: newProductSalesSignal,
    price_margin_score: priceMargin,
    final_margin_score: finalMargin,
    low_bid_ad_score: lowBidAd,
    listing_safety_score: safety,
    sales_data_confidence_score: salesConfidence,
    variation_risk_score: variationRisk,
    demand_confirmation_score: demandConfirmation,
    listing_test_score: listingTest,
  };
  const total = clamp(lowReview.score + priceMargin.score + finalMargin.score + lowBidAd.score + safety.score + recentPreference.bonus, 100);
  const layer = assignLayer(product, resolved, partial, total, recentPreference.notes);
  return { ...partial, flea_market_score: total, action_advice: listingTest.action_advice, rating_risk_level: ratingRisk.level, rating_risk_note: ratingRisk.note, ...layer };
}

function trueValue(value: FrontReview['can_undercut_5']): boolean {
  return value === true;
}

function riskPenalty(level: 'low' | 'medium' | 'high', medium: number, high: number): number {
  if (level === 'high') return high;
  if (level === 'medium') return medium;
  return 0;
}

function qualityWeakness(quality: 'none' | 'weak' | 'normal' | 'strong', weights: { none?: number; weak: number; normal: number }): number {
  if (quality === 'none') return weights.none ?? weights.weak;
  if (quality === 'weak') return weights.weak;
  if (quality === 'normal') return weights.normal;
  return 0;
}

export function scoreFrontReview(review: FrontReview): FrontReview {
  if (review.status === 'not_started') {
    return {
      ...review,
      front_review_score: 0,
      front_review_level: '未开始',
      front_review_flags: ['前台复核未开始。'],
      final_manual_decision: 'wait',
    };
  }

  const flags: string[] = [];
  let priceScore = 0;
  if (trueValue(review.can_undercut_5)) priceScore += 12;
  else if (trueValue(review.can_undercut_3)) priceScore += 6;
  if (trueValue(review.can_undercut_8)) priceScore += 4;
  if (trueValue(review.can_undercut_10)) priceScore += 4;
  if (review.can_use_price_undercut_strategy === false) flags.push('前台确认低价切入不可行。');
  priceScore = Math.min(20, priceScore);

  let lowReviewScore = 0;
  if (review.low_review_competitors_exist === true) lowReviewScore = 20;
  else if (review.front_review_count !== null && review.front_review_count <= 100) {
    lowReviewScore = 12;
    flags.push('评论低但前台销量仍需确认。');
  } else if (review.low_review_competitors_exist === 'unknown') {
    lowReviewScore = 8;
    flags.push('少评论竞品出单未确认。');
  } else {
    lowReviewScore = 3;
  }
  if (review.reviews_concentrated_in_old_variants === true) {
    lowReviewScore = Math.min(lowReviewScore, 6);
    flags.push('评论可能集中在老变体。');
  }

  const pageWeaknessScore = Math.min(
    15,
    qualityWeakness(review.main_image_quality, { weak: 4, normal: 2 }) +
      qualityWeakness(review.aplus_quality, { none: 4, weak: 3, normal: 1 }) +
      (review.has_video === false ? 3 : review.has_video === 'unknown' ? 1 : 0) +
      qualityWeakness(review.bullet_quality, { weak: 2, normal: 1 }) +
      qualityWeakness(review.title_quality, { weak: 2, normal: 1 }),
  );

  let monopolyScore = 15;
  monopolyScore -= riskPenalty(review.brand_monopoly, 4, 9);
  monopolyScore -= review.amazon_self_operated === true ? 8 : review.amazon_self_operated === 'unknown' ? 2 : 0;
  monopolyScore -= riskPenalty(review.seller_count_level, 1, 3);
  if (review.brand_monopoly === 'high') flags.push('品牌垄断偏高。');
  if (review.amazon_self_operated === true) flags.push('前台存在 Amazon 自营。');
  monopolyScore = Math.max(0, monopolyScore);

  const differentiationScore = review.differentiation_space === 'high' ? 15 : review.differentiation_space === 'medium' ? 9 : 3;
  if (review.differentiation_space === 'low') flags.push('差异化空间低。');

  let riskScore = 15;
  riskScore -= riskPenalty(review.ip_risk, 4, 9);
  riskScore -= riskPenalty(review.compliance_risk, 4, 9);
  riskScore -= riskPenalty(review.return_risk, 3, 7);
  riskScore -= review.product_complexity === 'complex' ? 5 : review.product_complexity === 'medium' ? 2 : 0;
  if (review.ip_risk === 'high' || review.compliance_risk === 'high') flags.push('IP或合规风险高。');
  if (review.return_risk === 'high') flags.push('退货风险高。');
  if (review.product_complexity === 'complex') flags.push('产品复杂度高。');
  riskScore = Math.max(0, riskScore);

  const score = Math.round(priceScore + lowReviewScore + pageWeaknessScore + monopolyScore + differentiationScore + riskScore);
  const level = score >= 80 ? '前台复核优秀' : score >= 65 ? '前台复核通过' : score >= 50 ? '需二次确认' : '前台复核不通过';
  let decision: FrontReview['final_manual_decision'] = 'wait';
  if (review.status === 'failed' || score < 50) decision = 'reject';
  else if (review.status === 'need_second_check' || review.status === 'in_progress') decision = 'wait';
  else if (review.status === 'passed' && score >= 80) decision = 'develop';
  else if (review.status === 'passed' && score >= 65) decision = 'small_test';

  return { ...review, front_review_score: score, front_review_level: level, front_review_flags: flags, final_manual_decision: decision };
}

function stage(status: FinalDecisionStage['status'], label: string, reasons: string[]): FinalDecisionStage {
  return { status, label, reasons };
}

function hasSevereFrontRisk(review: FrontReview): boolean {
  return (
    review.ip_risk === 'high' ||
    review.compliance_risk === 'high' ||
    review.product_complexity === 'complex' ||
    review.brand_monopoly === 'high' ||
    review.amazon_self_operated === true
  );
}

export function decideProduct(product: ProductRecord, score = product.score): ProductDecisionResult {
  const review = scoreFrontReview(product.front_review);
  const platformMargin = score.price_margin_score.platform_margin_rate;
  const fullMargin = score.final_margin_score.full_margin_rate;
  const costConfirmed = score.final_margin_score.cost_confirmed;
  const safetySevere = score.listing_safety_score.risk_level === 'severe';
  const keywordPending = score.low_bid_ad_score.notes.some((note) => note.includes('关键词'));
  const resolved = resolveProductData(product);
  const excelDataPresent = product.excel.price_mid !== null || product.excel.monthly_sales !== null || product.excel.review_count !== null;
  const excelFailed = product.excel.monthly_sales !== null && product.excel.monthly_sales < 10 && (product.excel.monthly_revenue ?? 0) < 1000;
  const excelScreening = excelFailed
    ? stage('failed', '不通过', ['Excel 初筛销量或销售额偏弱。'])
    : excelDataPresent
      ? stage('passed', '通过', ['Excel 初筛数据已保留。'])
      : stage('pending', '待确认', ['Excel 初筛关键字段不足。']);
  const mcpReview =
    product.mcp_status === 'failed'
      ? stage('failed', '失败', [product.mcp_error || 'MCP 复核失败。'])
      : product.mcp_status !== 'checked'
        ? stage('pending', '待确认', ['尚未完成 MCP 复核。'])
        : resolved.missing_notes.length
          ? stage('pending', '待确认', resolved.missing_notes)
          : stage('passed', '通过', ['MCP 最新数据可用于评分。']);
  const frontReview =
    review.status === 'not_started' || review.status === 'in_progress' || review.status === 'need_second_check'
      ? stage('pending', '待确认', review.status === 'need_second_check' ? ['已标记待二次确认。'] : ['前台复核尚未通过。'])
      : review.status === 'failed' || review.front_review_score < 50
      ? stage('failed', '不通过', review.front_review_flags.length ? review.front_review_flags : ['前台复核未通过。'])
      : review.status === 'passed' && review.front_review_score >= 65
        ? stage('passed', '通过', [`${review.front_review_level}，${review.front_review_score} 分。`])
        : stage('pending', '待确认', ['前台复核尚未通过。']);
  const profitCheck =
    platformMargin === null
      ? stage('pending', '待测算', ['平台后毛利率待补充。'])
      : platformMargin < 0.6
        ? stage('failed', '不达标', ['平台后毛利率低于 60%。'])
        : costConfirmed && (fullMargin === null || fullMargin < 0.25)
          ? stage('failed', '不达标', ['全成本毛利率低于 25%。'])
          : costConfirmed
            ? stage('passed', '达标', ['平台后毛利和全成本毛利达标。'])
            : stage('pending', '待测算', ['平台后毛利达标，全成本仍待确认。']);

  const reasons: string[] = [];
  let finalDecision: ProductDecisionResult['final_decision'] = 'wait';
  if (
    safetySevere ||
    hasSevereFrontRisk(review) ||
    frontReview.status === 'failed' ||
    profitCheck.status === 'failed' ||
    review.reviews_concentrated_in_old_variants === true
  ) {
    finalDecision = 'reject';
    if (safetySevere || hasSevereFrontRisk(review)) reasons.push('存在严重风险、品牌/自营或复杂度阻碍。');
    if (frontReview.status === 'failed') reasons.push('前台复核不通过。');
    if (profitCheck.status === 'failed') reasons.push('利润测算不达标。');
    if (review.reviews_concentrated_in_old_variants === true) reasons.push('老变体评论优势过强。');
  } else if (
    score.flea_market_score >= 75 &&
    review.front_review_score >= 65 &&
    platformMargin !== null &&
    platformMargin >= 0.6 &&
    (!costConfirmed || (fullMargin !== null && fullMargin >= 0.25)) &&
    costConfirmed &&
    review.status === 'passed'
  ) {
    finalDecision = 'develop';
    reasons.push('评分、前台复核、平台毛利和全成本毛利均达开发线。');
  } else if (
    score.flea_market_score >= 65 &&
    review.front_review_score >= 50 &&
    platformMargin !== null &&
    platformMargin >= 0.6 &&
    review.status !== 'failed'
  ) {
    finalDecision = 'small_test';
    reasons.push('可小批量测试，仍需关闭成本、关键词或前台待确认项。');
    if (!costConfirmed) reasons.push('全成本尚未确认。');
    if (keywordPending) reasons.push('关键词机会待确认。');
    if (frontReview.status !== 'passed') reasons.push('前台复核仍待确认。');
  } else {
    reasons.push('数据、关键词、成本或前台复核闭环尚未完成。');
  }

  return { excel_screening: excelScreening, mcp_review: mcpReview, front_review: frontReview, profit_check: profitCheck, final_decision: finalDecision, reasons };
}

export function createExcelFromMcpSnapshot(asin: string, mcp: ProductMcpSnapshot | null): ProductExcelData {
  return {
    asin,
    title: mcp?.title ?? null,
    brand: mcp?.brand ?? null,
    category: mcp?.category ?? null,
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
    raw: null,
  };
}
