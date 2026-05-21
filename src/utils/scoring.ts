import type {
  McpKeywordSnapshot,
  McpProductSnapshot,
  ProductExcelData,
  ProductManualData,
  ProductMcpSnapshot,
  ProductRecord,
  ProductScoreResult,
  ResolvedProductData,
} from '../types/mcp';

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
  prediction: ProductMcpSnapshot['prediction_summary'];
  traffic: unknown;
  raw: ProductMcpSnapshot['raw'];
  asin: string;
}): ProductMcpSnapshot {
  const { product, keyword, prediction, traffic, raw, asin } = params;
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
    seller: product?.seller ?? null,
    seller_type: product?.seller_type ?? null,
    variation_count: product?.variation_count ?? null,
    buybox_seller: product?.buybox_seller ?? null,
    fulfillment_type: product?.fulfillment_type ?? null,
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

  if (reviewCount === null) notes.push('评论数缺失，需前台复核。');
  if (competitorPrice === null) notes.push('价格缺失，需前台复核。');
  if (monthlySales === null) notes.push('月销量缺失，需补充销量数据。');
  if (fbaSource === '估算') notes.push('FBA费用估算。');
  if (resolvedFba === null) notes.push('FBA费用缺失，需人工补充。');

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
    keyword: mcp?.keyword_summary?.keyword ?? null,
    keyword_summary: mcp?.keyword_summary ?? null,
    missing_notes: notes,
  };
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

function scoreLowBidAd(keyword: McpKeywordSnapshot | null): ProductScoreResult['low_bid_ad_score'] {
  const notes: string[] = [];
  if (!keyword || keyword.ppc_bid === null || keyword.ppc_bid === undefined) {
    return { score: 9, max: 15, label: '低竞价广告机会分', notes: ['待关键词确认。'], long_tail_keyword_count: 0, signal: '待关键词确认' };
  }

  const wordCount = keyword.keyword?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  const search = keyword.search_volume;
  const bid = keyword.ppc_bid;
  const adCompetitors = keyword.ad_competitor_count;
  const titleDensity = keyword.title_density;
  const purchaseRate = keyword.purchase_rate;
  const clickConcentration = keyword.click_concentration;
  let score = 0;

  if (search !== null && search !== undefined && search >= 300 && search <= 5000) score += 3;
  else if (search !== null && search > 0) score += 1;
  if (bid <= 0.75) score += 4;
  else if (bid <= 1) score += 2;
  if (adCompetitors !== null && adCompetitors !== undefined && adCompetitors <= 50) score += 3;
  else if (adCompetitors !== null && adCompetitors <= 100) score += 1;
  if (titleDensity !== null && titleDensity !== undefined && titleDensity <= 20) score += 2;
  else if (titleDensity !== null && titleDensity <= 50) score += 1;
  if (purchaseRate !== null && purchaseRate !== undefined && purchaseRate >= 0.08) score += 2;
  else if (purchaseRate !== null && purchaseRate >= 0.03) score += 1;
  if (clickConcentration !== null && clickConcentration !== undefined && clickConcentration <= 0.35) score += 1;
  if (wordCount >= 3) score += 1;

  const signal = score >= 12 ? '适合低预算 SP 捡漏' : score >= 9 ? '可小预算测试' : '广告机会一般';
  return { score: clamp(score, 15), max: 15, label: '低竞价广告机会分', notes, long_tail_keyword_count: wordCount >= 3 ? 1 : 0, signal };
}

function scoreListingSafety(manual: ProductManualData): ProductScoreResult['listing_safety_score'] {
  const tags = manual.risk_tags ?? [];
  const hasSevere = manual.risk_level === 'severe' || tags.some((tag) => severeRiskKeywords.some((risk) => tag.toLowerCase().includes(risk.toLowerCase())));
  if (hasSevere) return { score: 0, max: 10, label: '铺货安全分', notes: ['存在严重风险标签。'], risk_level: 'severe' };
  if (manual.risk_level === 'medium') return { score: 4, max: 10, label: '铺货安全分', notes: ['存在中风险标签。'], risk_level: 'medium' };
  if (manual.risk_level === 'light') return { score: 7, max: 10, label: '铺货安全分', notes: ['存在轻风险标签。'], risk_level: 'light' };
  return { score: 10, max: 10, label: '铺货安全分', notes: [], risk_level: 'none' };
}

function assignLayer(product: ProductRecord, resolved: ResolvedProductData, score: Omit<ProductScoreResult, 'flea_market_score' | 'layer' | 'layer_reasons'>): Pick<ProductScoreResult, 'layer' | 'layer_reasons'> {
  const reasons: string[] = [];
  const total =
    score.low_review_sales_score.score +
    score.price_margin_score.score +
    score.final_margin_score.score +
    score.low_bid_ad_score.score +
    score.listing_safety_score.score;
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

  if (
    severeRisk ||
    (sales !== null && revenue !== null && sales < 10 && revenue < 1000) ||
    (platformMargin !== null && platformMargin < 0.5 && !canDiscount5) ||
    (costConfirmed && fullMargin !== null && fullMargin < 0.18) ||
    (reviews !== null && reviews > 1000) ||
    (rating !== null && rating < 3.8 && reviews !== null && reviews > 50) ||
    (price !== null && price < 10 && platformMargin !== null && platformMargin < 0.6)
  ) {
    reasons.push('触发放弃池规则。');
    return { layer: 'E放弃池', layer_reasons: reasons };
  }

  if ((reviews !== null && reviews > 300) || (reviews !== null && sales !== null && sales >= 200 && reviews >= 300) || amazonSelf || highVariation) {
    reasons.push('评论、Amazon自营或变体竞争偏高。');
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
    noSevereRisk
  ) {
    reasons.push('满足低评论出单优先池。');
    return { layer: 'A低评论出单优先池', layer_reasons: reasons };
  }

  if (total >= 65 && platformMargin !== null && platformMargin >= 0.6 && sales !== null && sales >= 20 && reviews !== null && reviews <= 300 && noSevereRisk) {
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
    reasons.push('适合小类目观察或前台复核。');
    return { layer: 'C小类目观察池', layer_reasons: reasons };
  }

  reasons.push('关键字段不足或未命中明确分层规则。');
  return { layer: '待复核', layer_reasons: reasons };
}

export function scoreProduct(product: ProductRecord): ProductScoreResult {
  const resolved = resolveProductData(product);
  const lowReview = scoreLowReviewSales(resolved);
  const priceMargin = scorePriceMargin(resolved, product.manual);
  const finalMargin = scoreFinalMargin(priceMargin, resolved, product.manual);
  const lowBidAd = scoreLowBidAd(resolved.keyword_summary);
  const safety = scoreListingSafety(product.manual);
  const partial = {
    low_review_sales_score: lowReview,
    price_margin_score: priceMargin,
    final_margin_score: finalMargin,
    low_bid_ad_score: lowBidAd,
    listing_safety_score: safety,
  };
  const total = lowReview.score + priceMargin.score + finalMargin.score + lowBidAd.score + safety.score;
  const layer = assignLayer(product, resolved, partial);
  return { ...partial, flea_market_score: total, ...layer };
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
