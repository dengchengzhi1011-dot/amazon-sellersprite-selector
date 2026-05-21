import type {
  FinalDecisionStage,
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

export function createMcpSnapshotFromValidation(params: {
  product: McpProductSnapshot | null;
  keyword: McpKeywordSnapshot | null;
  mainKeyword?: string;
  longTailKeywords?: string[];
  keywordSnapshots?: KeywordSnapshot[];
  prediction: ProductMcpSnapshot['prediction_summary'];
  traffic: unknown;
  raw: ProductMcpSnapshot['raw'];
  asin: string;
}): ProductMcpSnapshot {
  const { product, keyword, mainKeyword, longTailKeywords, prediction, traffic, raw, asin } = params;
  const keywordSnapshots = params.keywordSnapshots ?? [];
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
    referral_fee: product?.referral_fee ?? null,
    referral_fee_rate: product?.referral_fee_rate ?? null,
    seller: product?.seller ?? null,
    seller_type: product?.seller_type ?? null,
    variation_count: product?.variation_count ?? null,
    buybox_seller: product?.buybox_seller ?? null,
    fulfillment_type: product?.fulfillment_type ?? null,
    listed_at: null,
    launch_date: null,
    first_available_date: null,
    product_age_days: null,
    listed_days: null,
    is_recent_product: false,
    recent_product_level: '时间缺失',
    main_keyword: mainKeyword?.trim() || keyword?.keyword || null,
    long_tail_keywords: longTailKeywords ?? [],
    keyword_snapshots: keywordSnapshots,
    long_tail_opportunity_level: longTailOpportunity.level,
    recommended_sp_keywords: longTailOpportunity.recommended_sp_keywords,
    rejected_keywords: longTailOpportunity.rejected_keywords,
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
  const fbaSource = mcp?.fba_fee ? 'MCP' : manual.fba_fee ? '人工录入' : estimatedFba ? '估算' : '缺失';

  const reviewCount = firstNumber(mcp?.review_count, excel.review_count);
  const monthlySales = firstNumber(mcp?.monthly_sales, mcp?.prediction_summary?.recent_30d_sales, excel.monthly_sales);
  const monthlyRevenue = firstNumber(mcp?.monthly_revenue, mcp?.prediction_summary?.recent_30d_revenue, excel.monthly_revenue);
  const productAgeDays = firstNumber(mcp?.product_age_days, mcp?.listed_days);

  if (reviewCount === null) notes.push('评论数缺失，需前台复核。');
  if (competitorPrice === null) notes.push('价格缺失，需前台复核。');
  if (monthlySales === null) notes.push('月销量缺失，需补充销量数据。');
  if (fbaSource === '估算') notes.push('FBA费用估算。');
  if (resolvedFba === null) notes.push('FBA费用缺失，需人工补充。');
  if (mcp && productAgeDays === null) notes.push('上架时间缺失，需前台复核。');

  return {
    asin: product.asin,
    title: firstString(mcp?.title, excel.title),
    brand: firstString(mcp?.brand, excel.brand),
    category: firstString(mcp?.category, excel.category),
    competitor_price: competitorPrice,
    price_source: priceSource,
    rating: firstNumber(mcp?.rating, excel.rating),
    review_count: reviewCount,
    monthly_sales: monthlySales,
    monthly_revenue: monthlyRevenue,
    bsr: firstNumber(mcp?.bsr, excel.bsr),
    fba_fee: resolvedFba,
    fba_fee_source: fbaSource,
    seller: firstString(mcp?.seller, excel.seller),
    seller_type: firstString(mcp?.seller_type, excel.seller_type),
    variation_count: firstNumber(mcp?.variation_count, excel.variation_count),
    listed_at: mcp?.listed_at ?? null,
    launch_date: mcp?.launch_date ?? null,
    first_available_date: mcp?.first_available_date ?? null,
    product_age_days: productAgeDays,
    listed_days: firstNumber(mcp?.listed_days, mcp?.product_age_days),
    is_recent_product: Boolean(mcp?.is_recent_product),
    recent_product_level: mcp?.recent_product_level ?? '时间缺失',
    main_keyword: mcp?.main_keyword ?? mcp?.keyword_summary?.keyword ?? null,
    long_tail_keywords: mcp?.long_tail_keywords ?? [],
    keyword_snapshots: mcp?.keyword_snapshots ?? [],
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
  const notes: string[] = [];
  const reviews = resolved.review_count;
  const sales = resolved.monthly_sales;
  let score = 0;

  if (reviews === null) {
    score = 10;
    notes.push('评论数缺失，需前台复核。');
  } else if (sales === null) {
    score = 8;
    notes.push('月销量缺失，低评论出单暂不能确认。');
  } else if (reviews <= 10 && sales >= 20) score = 30;
  else if (reviews <= 30 && sales >= 30) score = 28;
  else if (reviews <= 100 && sales >= 50) score = 22;
  else if (reviews <= 300 && sales >= 100) score = 14;
  else if (reviews > 300) score = 5;
  else score = 10;

  const salesPerReview = sales !== null && reviews !== null ? sales / Math.max(reviews, 1) : null;
  let signal = '待判断';
  if (salesPerReview !== null) {
    if (salesPerReview >= 10) signal = '极强低评论出单信号';
    else if (salesPerReview >= 5) signal = '强信号';
    else if (salesPerReview >= 2) signal = '中等信号';
    else if (salesPerReview >= 1) signal = '弱信号';
    else signal = '差';
  }

  return { score: clamp(score, 30), max: 30, label: '低评论出单分', notes, sales_per_review: salesPerReview, signal };
}

function platformMargin(targetPrice: number | null, referralFeeRate: number, fbaFee: number | null, platformOtherFee: number): number | null {
  if (targetPrice === null || targetPrice <= 0 || fbaFee === null) return null;
  const referralFee = targetPrice * referralFeeRate;
  return (targetPrice - referralFee - fbaFee - platformOtherFee) / targetPrice;
}

function scorePriceMargin(resolved: ResolvedProductData, manual: ProductManualData): ProductScoreResult['price_margin_score'] {
  const notes: string[] = [];
  const price = resolved.competitor_price;
  const referralFeeRate = manual.referral_fee_rate ?? 0.15;
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
  if (resolved.fba_fee_source === '估算') notes.push('FBA费用估算，平台后毛利需复核。');

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
    fba_fee_estimated: resolved.fba_fee_source === '估算',
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
  const referralFeeRate = manual.referral_fee_rate ?? 0.15;
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
  const keyword = mainKeywordData(resolved);
  const tails = resolved.keyword_snapshots.filter((snapshot) => snapshot.keyword_type !== 'main' && !snapshot.error);
  const longTailOpportunity = calculateLongTailOpportunity(resolved.keyword_snapshots);
  if (!tails.length) {
    return {
      score: 9,
      max: 15,
      label: '低竞价广告机会分',
      notes: ['待长尾词确认。'],
      long_tail_keyword_count: 0,
      opportunity_level: 'unknown',
      recommended_keywords: [],
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
    score: clamp(score, 15),
    max: 15,
    label: '低竞价广告机会分',
    notes,
    long_tail_keyword_count: longTailOpportunity.usable_keywords.length,
    opportunity_level: longTailOpportunity.level,
    recommended_keywords: longTailOpportunity.recommended_sp_keywords,
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

function assignLayer(
  product: ProductRecord,
  resolved: ResolvedProductData,
  score: Omit<ProductScoreResult, 'flea_market_score' | 'rating_risk_level' | 'rating_risk_note' | 'layer' | 'layer_reasons'>,
  total: number,
  recentNotes: string[],
): Pick<ProductScoreResult, 'layer' | 'layer_reasons'> {
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

  if (
    severeRisk ||
    (sales !== null && revenue !== null && sales < 10 && revenue < 1000) ||
    (platformMargin !== null && platformMargin < 0.5 && !canDiscount5) ||
    (costConfirmed && fullMargin !== null && fullMargin < 0.18) ||
    (reviews !== null && reviews > 1000) ||
    (ratingRisk.level === 'severe_low_rating_risk' && reviews !== null && reviews > 50) ||
    (price !== null && price < 10 && platformMargin !== null && platformMargin < 0.6)
  ) {
    reasons.push('触发放弃池规则。');
    return { layer: 'E放弃池', layer_reasons: reasons };
  }

  if ((reviews !== null && reviews > 300) || (reviews !== null && sales !== null && sales >= 200 && reviews >= 300) || amazonSelf || highVariation || ratingRisk.level === 'severe_low_rating_risk') {
    reasons.push(ratingRisk.level === 'severe_low_rating_risk' ? '低评分样本已放大，不进入 A/B 池。' : '评论、Amazon自营或变体竞争偏高。');
    return { layer: 'D竞争偏高池', layer_reasons: reasons };
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
    reasons.push('满足低评论出单优先池。');
    return { layer: 'A低评论出单优先池', layer_reasons: reasons };
  }

  if (total >= 65 && platformMargin !== null && platformMargin >= 0.6 && sales !== null && sales >= 20 && reviews !== null && reviews <= 300 && noSevereRisk && eligibleForBByAge) {
    if (productAgeDays !== null && productAgeDays > 365) reasons.push('老链接观察。');
    reasons.push('满足价格压制测试池。');
    return { layer: 'B价格压制测试池', layer_reasons: reasons };
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
    return { layer: 'C小类目观察池', layer_reasons: reasons };
  }

  reasons.push('关键字段不足或未命中明确分层规则。');
  return { layer: '待复核', layer_reasons: reasons };
}

export function scoreProduct(product: ProductRecord): ProductScoreResult {
  const resolved = resolveProductData(product);
  const ratingRisk = calculateRatingRiskLevel(resolved.review_count, resolved.rating);
  const lowReview = scoreLowReviewSales(resolved);
  const priceMargin = scorePriceMargin(resolved, product.manual);
  const finalMargin = scoreFinalMargin(priceMargin, resolved, product.manual);
  const lowBidAd = scoreLowBidAd(resolved);
  const safety = scoreListingSafety(product.manual, ratingRisk);
  const recentPreference = recentProductPreference(resolved);
  const partial = {
    low_review_sales_score: lowReview,
    price_margin_score: priceMargin,
    final_margin_score: finalMargin,
    low_bid_ad_score: lowBidAd,
    listing_safety_score: safety,
  };
  const total = clamp(lowReview.score + priceMargin.score + finalMargin.score + lowBidAd.score + safety.score + recentPreference.bonus, 100);
  const layer = assignLayer(product, resolved, partial, total, recentPreference.notes);
  return { ...partial, flea_market_score: total, rating_risk_level: ratingRisk.level, rating_risk_note: ratingRisk.note, ...layer };
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
