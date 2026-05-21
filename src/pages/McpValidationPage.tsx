import { useEffect, useMemo, useState } from 'react';
import type {
  KeywordSnapshot,
  McpCallStatus,
  McpCandidateRecord,
  McpKeywordSnapshot,
  McpManualCostInput,
  McpMarginSnapshot,
  McpPredictionSnapshot,
  McpProductSnapshot,
  McpToolCallResult,
  McpValidationResult,
} from '../types/mcp';
import {
  fetchAsinDetail,
  fetchAsinPrediction,
  fetchKeywordMiner,
  fetchTrafficKeywordStat,
  getMcpFriendlyError,
} from '../utils/sellerspriteMcp';
import { createMcpSnapshotFromValidation } from '../utils/scoring';
import {
  createCandidateRecord,
  exportCandidatesCsv,
  loadCandidates,
  loadProducts,
  saveCandidates,
  upsertProductMcpData,
} from '../utils/productStore';
import {
  calculateLongTailOpportunity,
  generateLongTailKeywordCandidates,
  longTailOpportunityLabel,
  normalizeKeywordSnapshot,
} from '../utils/keywordTools';

type FieldStatus = '可用' | '未返回' | '需要人工补充' | '需要前台复核';
type FieldItem = {
  group: '商品侧' | '关键词侧';
  field: string;
  label: string;
  value: unknown;
  status: FieldStatus;
};

type SectionKey = 'asin_detail' | 'asin_prediction' | 'traffic_keyword_stat' | 'keyword_miner';
type CostInputKey =
  | 'target_discount_rate'
  | 'referral_fee_rate'
  | 'manual_fba_fee'
  | 'purchase_cost'
  | 'first_leg_shipping'
  | 'packaging_cost'
  | 'storage_cost_usd'
  | 'platform_other_fee'
  | 'return_loss'
  | 'other_cost';

const defaultKeyword = 'easter eggs fillers';
const defaultCostInputs: Record<CostInputKey, string> = {
  target_discount_rate: '0.05',
  referral_fee_rate: '0.15',
  manual_fba_fee: '',
  purchase_cost: '',
  first_leg_shipping: '',
  packaging_cost: '',
  storage_cost_usd: '',
  platform_other_fee: '',
  return_loss: '',
  other_cost: '',
};

const emptyResult: McpValidationResult = {
  asin: 'B0GJSCQ3PS',
  keyword: defaultKeyword,
  main_keyword: defaultKeyword,
  long_tail_keywords: [],
  keyword_snapshots: [],
  status: 'idle',
  checked_at: '',
  asin_detail: null,
  asin_prediction: null,
  traffic_keyword_stat: null,
  keyword_miner: null,
  errors: [],
};

function createInitialSectionStatus(): Record<SectionKey, McpCallStatus> {
  return {
    asin_detail: 'idle',
    asin_prediction: 'idle',
    traffic_keyword_stat: 'idle',
    keyword_miner: 'idle',
  };
}

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未返回';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未返回';
  if (Array.isArray(value)) return value.length ? `${value.length} 条` : '未返回';
  return String(value);
}

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未返回';
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未返回';
  return `${(value * 100).toFixed(1)}%`;
}

function parseInputNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readCostInputs(inputs: Record<CostInputKey, string>): McpManualCostInput {
  return {
    target_discount_rate: parseInputNumber(inputs.target_discount_rate),
    referral_fee_rate: parseInputNumber(inputs.referral_fee_rate),
    manual_fba_fee: parseInputNumber(inputs.manual_fba_fee),
    purchase_cost: parseInputNumber(inputs.purchase_cost),
    first_leg_shipping: parseInputNumber(inputs.first_leg_shipping),
    packaging_cost: parseInputNumber(inputs.packaging_cost),
    storage_cost_usd: parseInputNumber(inputs.storage_cost_usd),
    platform_other_fee: parseInputNumber(inputs.platform_other_fee),
    return_loss: parseInputNumber(inputs.return_loss),
    other_cost: parseInputNumber(inputs.other_cost),
    risk_level: 'none',
    risk_tags: [],
  };
}

function costValue(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function missingStatus(value: unknown, fallback: FieldStatus): FieldStatus {
  return hasValue(value) ? '可用' : fallback;
}

function getMergedProduct(product: McpProductSnapshot | null, prediction: McpPredictionSnapshot | null): McpProductSnapshot | null {
  if (!product && !prediction) return null;
  return {
    asin: product?.asin ?? prediction?.asin ?? null,
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
    raw: product?.raw ?? prediction?.raw ?? null,
  };
}

function buildFieldItems(product: McpProductSnapshot | null, keyword: McpKeywordSnapshot | null): FieldItem[] {
  return [
    { group: '商品侧', field: 'price', label: '售价', value: product?.price, status: missingStatus(product?.price, '需要前台复核') },
    { group: '商品侧', field: 'review_count', label: '评论数', value: product?.review_count, status: missingStatus(product?.review_count, '需要前台复核') },
    { group: '商品侧', field: 'rating', label: '评分', value: product?.rating, status: missingStatus(product?.rating, '需要前台复核') },
    { group: '商品侧', field: 'monthly_sales', label: '月销量', value: product?.monthly_sales, status: missingStatus(product?.monthly_sales, '未返回') },
    { group: '商品侧', field: 'monthly_revenue', label: '月销售额', value: product?.monthly_revenue, status: missingStatus(product?.monthly_revenue, '未返回') },
    { group: '商品侧', field: 'bsr', label: 'BSR', value: product?.bsr, status: missingStatus(product?.bsr, '需要前台复核') },
    { group: '商品侧', field: 'fba_fee', label: 'FBA费用', value: product?.fba_fee, status: missingStatus(product?.fba_fee, '需要人工补充') },
    { group: '商品侧', field: 'variation_count', label: '变体数', value: product?.variation_count, status: missingStatus(product?.variation_count, '需要前台复核') },
    { group: '商品侧', field: 'brand', label: '品牌', value: product?.brand, status: missingStatus(product?.brand, '需要前台复核') },
    { group: '商品侧', field: 'seller', label: '卖家', value: product?.seller, status: missingStatus(product?.seller, '需要前台复核') },
    { group: '关键词侧', field: 'search_volume', label: '搜索量', value: keyword?.search_volume, status: missingStatus(keyword?.search_volume, '未返回') },
    { group: '关键词侧', field: 'purchase_volume', label: '购买量', value: keyword?.purchase_volume, status: missingStatus(keyword?.purchase_volume, '未返回') },
    { group: '关键词侧', field: 'purchase_rate', label: '购买率', value: keyword?.purchase_rate, status: missingStatus(keyword?.purchase_rate, '未返回') },
    { group: '关键词侧', field: 'ppc_bid', label: 'PPC竞价', value: keyword?.ppc_bid, status: missingStatus(keyword?.ppc_bid, '需要前台复核') },
    { group: '关键词侧', field: 'ad_competitor_count', label: '广告竞品数', value: keyword?.ad_competitor_count, status: missingStatus(keyword?.ad_competitor_count, '未返回') },
    { group: '关键词侧', field: 'organic_competitor_count', label: '自然竞品数', value: keyword?.organic_competitor_count, status: missingStatus(keyword?.organic_competitor_count, '未返回') },
    { group: '关键词侧', field: 'title_density', label: '标题密度', value: keyword?.title_density, status: missingStatus(keyword?.title_density, '未返回') },
    { group: '关键词侧', field: 'click_concentration', label: '点击集中度', value: keyword?.click_concentration, status: missingStatus(keyword?.click_concentration, '未返回') },
  ];
}

function diagnoseLowReviewSales(product: McpProductSnapshot | null): string {
  const reviewCount = product?.review_count;
  const monthlySales = product?.monthly_sales;
  if (typeof reviewCount !== 'number' || typeof monthlySales !== 'number') {
    return '无法判断，缺少 review_count 或 monthly_sales。';
  }
  if (reviewCount <= 10 && monthlySales >= 20) return '强信号：评论数 <= 10 且月销量 >= 20，符合低评论出单特征。';
  if (reviewCount <= 30 && monthlySales >= 30) return '强信号：评论数 <= 30 且月销量 >= 30，适合继续复核。';
  if (reviewCount <= 100 && monthlySales >= 50) return '中强信号：评论数 <= 100 且月销量 >= 50，有低评论出单迹象。';
  if (reviewCount <= 100 && monthlySales > 0) return '弱到中等信号：低评论有出单，但销量强度还需要结合价格和关键词确认。';
  return '暂未形成低评论出单信号。';
}

function buildPriceDiagnostics(product: McpProductSnapshot | null): Array<{ label: string; target: string; margin: string }> {
  const price = product?.coupon_price ?? product?.price;
  const fbaFee = product?.fba_fee;
  if (typeof price !== 'number') return [];
  const discounts = [0.03, 0.05, 0.08, 0.1];
  return discounts.map((discount) => {
    const target = price * (1 - discount);
    const referralFee = target * 0.15;
    const margin = typeof fbaFee === 'number' ? (target - referralFee - fbaFee) / target : null;
    return {
      label: `便宜 ${Math.round(discount * 100)}%`,
      target: formatMoney(target),
      margin: typeof margin === 'number' ? formatPercent(margin) : 'FBA费用未返回',
    };
  });
}

function calculateMarginSnapshot(product: McpProductSnapshot | null, costs: McpManualCostInput): McpMarginSnapshot {
  const warnings: string[] = [];
  const basePrice = product?.coupon_price ?? product?.price ?? null;
  const targetDiscountRate = costs.target_discount_rate ?? 0.05;
  const referralFeeRate = costs.referral_fee_rate ?? 0.15;
  const fbaFee = costs.manual_fba_fee ?? product?.fba_fee ?? null;

  if (typeof basePrice !== 'number') warnings.push('缺少 price，无法计算目标售价和毛利率。');
  if (typeof fbaFee !== 'number') warnings.push('FBA费用未返回，需人工补充后才能计算完整平台后毛利率。');
  if (typeof product?.referral_fee_rate !== 'number') warnings.push('佣金比例为系统默认估算，非 MCP 返回。');
  if (costs.purchase_cost === null) warnings.push('采购价未录入，最终毛利率会偏高。');
  if (costs.first_leg_shipping === null) warnings.push('头程费用未录入，最终毛利率会偏高。');
  if (costs.packaging_cost === null) warnings.push('包装费用未录入，最终毛利率会偏高。');
  if (costs.return_loss === null) warnings.push('退货损耗未录入，最终毛利率会偏高。');

  const targetPrice = typeof basePrice === 'number' ? basePrice * (1 - targetDiscountRate) : null;
  const referralFee = typeof targetPrice === 'number' ? targetPrice * referralFeeRate : null;
  const productFullCost =
    costValue(costs.purchase_cost) +
    costValue(costs.first_leg_shipping) +
    costValue(costs.packaging_cost) +
    costValue(costs.storage_cost_usd ?? null) +
    costValue(costs.platform_other_fee ?? null) +
    costValue(costs.return_loss ?? null) +
    costValue(costs.other_cost);

  const platformMarginRate =
    typeof targetPrice === 'number' && typeof referralFee === 'number' && typeof fbaFee === 'number' && targetPrice > 0
      ? (targetPrice - referralFee - fbaFee - costValue(costs.platform_other_fee ?? null)) / targetPrice
      : null;

  const finalMarginRate =
    typeof targetPrice === 'number' && typeof referralFee === 'number' && typeof fbaFee === 'number' && targetPrice > 0
      ? (targetPrice - referralFee - fbaFee - productFullCost) / targetPrice
      : null;

  return {
    base_price: basePrice,
    target_price: targetPrice,
    referral_fee: referralFee,
    fba_fee: fbaFee,
    platform_margin_rate: platformMarginRate,
    product_full_cost: productFullCost,
    final_margin_rate: finalMarginRate,
    platform_margin_pass: typeof platformMarginRate === 'number' ? platformMarginRate >= 0.6 : false,
    final_margin_pass: typeof finalMarginRate === 'number' ? finalMarginRate >= 0.25 : false,
    warnings,
  };
}

function marginVerdict(margin: McpMarginSnapshot): string {
  if (margin.platform_margin_rate === null || margin.final_margin_rate === null) return '缺少关键成本，暂不能判断。';
  const platformText = margin.platform_margin_pass ? '平台后毛利率达到 60% 以上' : '平台后毛利率低于 60%';
  const finalText = margin.final_margin_pass ? '最终毛利率达到 25% 以上' : '最终毛利率低于 25%';
  return `${platformText}，${finalText}。`;
}

function diagnoseAdKeyword(keyword: McpKeywordSnapshot | null, keywordText: string): string[] {
  const missing: string[] = [];
  if (typeof keyword?.ppc_bid !== 'number') missing.push('ppc_bid');
  if (typeof keyword?.search_volume !== 'number') missing.push('search_volume');
  if (typeof keyword?.ad_competitor_count !== 'number') missing.push('ad_competitor_count');
  if (missing.length) return [`无法完整判断，缺少 ${missing.join('、')}。`];

  const ppcBid = keyword!.ppc_bid!;
  const searchVolume = keyword!.search_volume!;
  const adCompetitors = keyword!.ad_competitor_count!;
  const wordCount = keywordText.trim().split(/\s+/).filter(Boolean).length;
  const lowBid = ppcBid <= 0.75;
  const longTail = wordCount >= 3 || searchVolume <= 10_000;
  const lowCompetition = adCompetitors <= 50;
  const fit = lowBid && longTail && lowCompetition;

  return [
    `是否低竞价：${lowBid ? '是' : '否'}，当前 PPC 约 ${formatMoney(ppcBid)}。`,
    `是否长尾词：${longTail ? '是' : '否'}，当前词长 ${wordCount} 个词，搜索量 ${searchVolume}。`,
    `是否广告竞争低：${lowCompetition ? '是' : '否'}，广告竞品数 ${adCompetitors}。`,
    `是否适合低预算 SP 捡漏：${fit ? '适合优先测试' : '需要谨慎，建议补充转化率和前台广告位复核'}。`,
  ];
}

function resultErrors(result: McpValidationResult): string[] {
  return [
    result.asin_detail?.error,
    result.asin_prediction?.error,
    result.traffic_keyword_stat?.error,
    result.keyword_miner?.error,
    ...result.errors,
  ].filter((item): item is string => Boolean(item));
}

function statusText(status: McpCallStatus): string {
  const map: Record<McpCallStatus, string> = {
    idle: '未查询',
    loading: '查询中',
    success: '成功',
    failed: '失败',
    timeout: '超时',
  };
  return map[status];
}

function confirmMcpCall(): boolean {
  return window.confirm('本次将调用卖家精灵 MCP，可能消耗额度。是否继续？');
}

function parseLongTailKeywords(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/\n+/)
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  ).slice(0, 10);
}

function mergeKeywordSnapshots(current: KeywordSnapshot[], incoming: KeywordSnapshot[]): KeywordSnapshot[] {
  const next = [...current];
  incoming.forEach((snapshot) => {
    const key = `${snapshot.keyword_type}:${snapshot.keyword?.trim().toLowerCase()}`;
    const index = next.findIndex((item) => `${item.keyword_type}:${item.keyword?.trim().toLowerCase()}` === key);
    if (index >= 0) next[index] = snapshot;
    else next.push(snapshot);
  });
  return next.filter((snapshot) => snapshot.keyword).slice(-20);
}

export default function McpValidationPage({
  initialAsin,
  initialMainKeyword,
  initialTitle,
  initialCategory,
  initialGenerateLongTail = false,
  initialQueryLongTail = false,
}: {
  initialAsin?: string;
  initialMainKeyword?: string;
  initialTitle?: string;
  initialCategory?: string;
  initialGenerateLongTail?: boolean;
  initialQueryLongTail?: boolean;
}) {
  const [asin, setAsin] = useState(initialAsin || 'B0GJSCQ3PS');
  const [mainKeyword, setMainKeyword] = useState(defaultKeyword);
  const [longTailText, setLongTailText] = useState('');
  const [keywordSnapshots, setKeywordSnapshots] = useState<KeywordSnapshot[]>([]);
  const [longTailSuggestions, setLongTailSuggestions] = useState<string[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<string[]>([]);
  const [longTailLoading, setLongTailLoading] = useState(false);
  const [keywordNotice, setKeywordNotice] = useState('');
  const [pendingLongTailQuery, setPendingLongTailQuery] = useState(false);
  const [result, setResult] = useState<McpValidationResult>({ ...emptyResult, asin: initialAsin || emptyResult.asin });
  const [sectionStatus, setSectionStatus] = useState<Record<SectionKey, McpCallStatus>>(createInitialSectionStatus);
  const [costInputs, setCostInputs] = useState<Record<CostInputKey, string>>(defaultCostInputs);
  const [notes, setNotes] = useState('');
  const [candidates, setCandidates] = useState<McpCandidateRecord[]>(() => loadCandidates());
  const [saveNotice, setSaveNotice] = useState('');

  useEffect(() => {
    if (initialAsin) {
      const seededMainKeyword = initialMainKeyword?.trim() ?? '';
      const generated = initialGenerateLongTail
        ? generateLongTailKeywordCandidates({
            title: initialTitle,
            category: initialCategory,
            main_keyword: seededMainKeyword,
          })
        : [];
      const generatedLongTails = generated.filter((keyword) => keyword !== seededMainKeyword);
      setAsin(initialAsin);
      setMainKeyword(seededMainKeyword);
      setLongTailText(generatedLongTails.join('\n'));
      setKeywordSnapshots([]);
      setLongTailSuggestions(generated);
      setSelectedSuggestions(generatedLongTails);
      setPendingLongTailQuery(initialQueryLongTail && generated.length > 0);
      setResult((current) => ({ ...current, asin: initialAsin, keyword: seededMainKeyword, main_keyword: seededMainKeyword, long_tail_keywords: generatedLongTails, keyword_snapshots: [] }));
    }
  }, [initialAsin, initialCategory, initialGenerateLongTail, initialMainKeyword, initialQueryLongTail, initialTitle]);

  const mergedProduct = useMemo(
    () => getMergedProduct(result.asin_detail?.data ?? null, result.asin_prediction?.data ?? null),
    [result.asin_detail, result.asin_prediction],
  );
  const longTailKeywords = useMemo(() => parseLongTailKeywords(longTailText), [longTailText]);
  const activeKeywordSnapshots = useMemo(
    () =>
      keywordSnapshots.filter((snapshot) => {
        const keyword = snapshot.keyword?.trim().toLowerCase();
        if (!keyword) return false;
        if (snapshot.keyword_type === 'main') return keyword === mainKeyword.trim().toLowerCase();
        return longTailKeywords.some((longTailKeyword) => longTailKeyword.trim().toLowerCase() === keyword);
      }),
    [keywordSnapshots, longTailKeywords, mainKeyword],
  );
  const keywordData =
    activeKeywordSnapshots.find((snapshot) => snapshot.keyword_type === 'main' && !snapshot.error) ??
    (result.keyword_miner?.data?.keyword?.trim().toLowerCase() === mainKeyword.trim().toLowerCase() ? result.keyword_miner.data : null);
  const fieldItems = useMemo(() => buildFieldItems(mergedProduct, keywordData), [mergedProduct, keywordData]);
  const priceDiagnostics = useMemo(() => buildPriceDiagnostics(mergedProduct), [mergedProduct]);
  const adDiagnostics = useMemo(() => diagnoseAdKeyword(keywordData, mainKeyword), [keywordData, mainKeyword]);
  const longTailOpportunity = useMemo(() => calculateLongTailOpportunity(activeKeywordSnapshots), [activeKeywordSnapshots]);
  const manualCosts = useMemo(() => readCostInputs(costInputs), [costInputs]);
  const marginSnapshot = useMemo(() => calculateMarginSnapshot(mergedProduct, manualCosts), [manualCosts, mergedProduct]);
  const errors = resultErrors(result);
  const isLoading = Object.values(sectionStatus).some((status) => status === 'loading');

  const updateResult = (patch: Partial<McpValidationResult>) => {
    setResult((current) => ({
      ...current,
      asin,
      keyword: mainKeyword,
      main_keyword: mainKeyword,
      long_tail_keywords: longTailKeywords,
      keyword_snapshots: keywordSnapshots,
      checked_at: new Date().toISOString(),
      ...patch,
    }));
  };

  const saveKeywordSnapshotsToResult = (incoming: KeywordSnapshot[]) => {
    setKeywordSnapshots((current) => {
      const next = mergeKeywordSnapshots(current, incoming);
      setResult((resultCurrent) => ({
        ...resultCurrent,
        asin,
        keyword: mainKeyword,
        main_keyword: mainKeyword,
        long_tail_keywords: longTailKeywords,
        keyword_snapshots: next,
      }));
      return next;
    });
  };

  const runSection = async (section: SectionKey, skipConfirm = false) => {
    if (section === 'keyword_miner' && !mainKeyword.trim()) {
      setKeywordNotice('未填写主关键词，已跳过主关键词数据查询。');
      return;
    }
    if (!skipConfirm && !confirmMcpCall()) return;
    setSectionStatus((current) => ({ ...current, [section]: 'loading' }));
    updateResult({ status: 'loading' });

    let callResult: McpToolCallResult<unknown>;
    if (section === 'asin_detail') callResult = await fetchAsinDetail(asin);
    else if (section === 'asin_prediction') callResult = await fetchAsinPrediction(asin);
    else if (section === 'traffic_keyword_stat') callResult = await fetchTrafficKeywordStat(asin);
    else callResult = await fetchKeywordMiner(mainKeyword);

    setSectionStatus((current) => ({ ...current, [section]: callResult.status }));
    if (section === 'keyword_miner') {
      saveKeywordSnapshotsToResult([
        normalizeKeywordSnapshot(
          mainKeyword,
          'main',
          callResult.status === 'success' ? (callResult.data as McpKeywordSnapshot | null) : null,
          callResult.error,
          callResult.checked_at,
        ),
      ]);
    }
    setResult((current) => ({
      ...current,
      asin,
      keyword: mainKeyword,
      main_keyword: mainKeyword,
      long_tail_keywords: longTailKeywords,
      checked_at: new Date().toISOString(),
      status: callResult.status === 'success' ? 'success' : callResult.status,
      [section]: callResult,
      errors: callResult.error ? [...current.errors, callResult.error] : current.errors,
    }));
  };

  const runAll = async () => {
    if (!confirmMcpCall()) return;
    setResult({ ...emptyResult, asin, keyword: mainKeyword, main_keyword: mainKeyword, long_tail_keywords: longTailKeywords, keyword_snapshots: keywordSnapshots, status: 'loading', checked_at: new Date().toISOString() });
    setSectionStatus({
      asin_detail: 'loading',
      asin_prediction: 'loading',
      traffic_keyword_stat: 'loading',
      keyword_miner: mainKeyword.trim() ? 'loading' : 'idle',
    });

    await runSection('asin_detail', true);
    await runSection('asin_prediction', true);
    await runSection('traffic_keyword_stat', true);
    if (mainKeyword.trim()) await runSection('keyword_miner', true);
    if (longTailKeywords.length) await queryLongTailKeywords();
    if (!mainKeyword.trim() && !longTailKeywords.length) setKeywordNotice('未填写关键词，已跳过关键词数据查询。');
  };

  const queryLongTailKeywords = async () => {
    const keywords = longTailKeywords.slice(0, 10);
    if (!keywords.length) {
      setKeywordNotice('请先填写或勾选长尾关键词。');
      return;
    }
    if (!window.confirm(`本次将查询 ${keywords.length} 个关键词，可能消耗 MCP 额度，是否继续？`)) return;
    setLongTailLoading(true);
    setKeywordNotice('');
    const snapshots: KeywordSnapshot[] = [];
    for (const longTailKeyword of keywords) {
      const result = await fetchKeywordMiner(longTailKeyword);
      const keywordType = selectedSuggestions.includes(longTailKeyword) ? 'auto_generated' : 'manual';
      snapshots.push(
        normalizeKeywordSnapshot(
          longTailKeyword,
          keywordType,
          result.status === 'success' ? result.data : null,
          result.error,
          result.checked_at,
        ),
      );
    }
    saveKeywordSnapshotsToResult(snapshots);
    setLongTailLoading(false);
    const failed = snapshots.filter((snapshot) => snapshot.error).length;
    setKeywordNotice(failed ? `长尾词查询完成，其中 ${failed} 个未成功，其余结果已保留。` : `已查询 ${snapshots.length} 个长尾关键词。`);
  };

  const queryAllKeywords = async () => {
    if (!mainKeyword.trim() && !longTailKeywords.length) {
      setKeywordNotice('未填写关键词，已跳过关键词数据查询。');
      if (!confirmMcpCall()) return;
      await runSection('asin_detail', true);
      await runSection('asin_prediction', true);
      await runSection('traffic_keyword_stat', true);
      return;
    }
    if (mainKeyword.trim()) await runSection('keyword_miner');
    if (longTailKeywords.length) await queryLongTailKeywords();
  };

  const generateSuggestions = () => {
    const savedProduct = loadProducts().find((product) => product.asin === asin.trim());
    const generated = generateLongTailKeywordCandidates({
      title: mergedProduct?.title ?? savedProduct?.mcp_snapshot?.title ?? savedProduct?.excel.title ?? null,
      category: mergedProduct?.category ?? savedProduct?.mcp_snapshot?.category ?? savedProduct?.excel.category ?? null,
      brand: mergedProduct?.brand ?? savedProduct?.mcp_snapshot?.brand ?? savedProduct?.excel.brand ?? null,
      main_keyword: mainKeyword,
    });
    setLongTailSuggestions(generated);
    setSelectedSuggestions([]);
    setKeywordNotice(generated.length ? '已根据当前 ASIN 标题和类目生成长尾词建议，可勾选加入列表。' : '当前标题信息不足，暂未生成长尾词建议。');
  };

  const toggleSuggestion = (keyword: string, checked: boolean) => {
    setSelectedSuggestions((current) => checked ? Array.from(new Set([...current, keyword])).slice(0, 10) : current.filter((item) => item !== keyword));
    if (checked) setLongTailText((current) => parseLongTailKeywords(`${current}\n${keyword}`).join('\n'));
    else setLongTailText((current) => parseLongTailKeywords(current).filter((item) => item !== keyword).join('\n'));
  };

  const clearLongTailKeywords = () => {
    setLongTailText('');
    setLongTailSuggestions([]);
    setSelectedSuggestions([]);
    const next = keywordSnapshots.filter((snapshot) => snapshot.keyword_type === 'main');
    setKeywordSnapshots(next);
    setResult((current) => ({ ...current, long_tail_keywords: [], keyword_snapshots: next }));
    setKeywordNotice('长尾关键词已清空。');
  };

  const changeAsin = (value: string) => {
    setAsin(value);
    setMainKeyword('');
    setLongTailText('');
    setLongTailSuggestions([]);
    setSelectedSuggestions([]);
    setKeywordSnapshots([]);
    setKeywordNotice('已切换 ASIN，已清空上一条商品的关键词。');
    setResult({ ...emptyResult, asin: value, keyword: '', main_keyword: '', long_tail_keywords: [], keyword_snapshots: [] });
    setSectionStatus(createInitialSectionStatus());
  };

  useEffect(() => {
    if (!pendingLongTailQuery || !longTailKeywords.length || longTailLoading) return;
    setPendingLongTailQuery(false);
    void queryLongTailKeywords();
  }, [longTailKeywords, longTailLoading, pendingLongTailQuery]);

  const updateCostInput = (key: CostInputKey, value: string) => {
    setCostInputs((current) => ({ ...current, [key]: value }));
  };

  const buildMcpSnapshot = () => {
    const hasSuccessData = result.asin_detail?.data || result.asin_prediction?.data || result.keyword_miner?.data || result.traffic_keyword_stat?.data || activeKeywordSnapshots.length;
    if (!hasSuccessData) return null;
    return createMcpSnapshotFromValidation({
      product: mergedProduct,
      keyword: keywordData,
      mainKeyword,
      longTailKeywords,
      keywordSnapshots: activeKeywordSnapshots,
      prediction: result.asin_prediction?.data ?? null,
      traffic: result.traffic_keyword_stat?.data ?? result.traffic_keyword_stat?.raw ?? null,
      asin: asin.trim(),
      raw: {
        asin_detail: result.asin_detail?.raw ?? null,
        asin_prediction: result.asin_prediction?.raw ?? null,
        traffic_keyword_stat: result.traffic_keyword_stat?.raw ?? null,
        keyword_miner: result.keyword_miner?.raw ?? null,
      },
    });
  };

  const saveBackToProduct = (markCandidate = false) => {
    const products = loadProducts();
    const nextProducts = upsertProductMcpData({
      products,
      asin,
      mcpSnapshot: buildMcpSnapshot(),
      validation: result,
      manualCosts,
      notes,
      markCandidate,
    });
    const savedProduct = nextProducts.find((product) => product.asin === asin.trim()) ?? null;
    setSaveNotice(markCandidate ? '已保存为候选商品，并已回填商品 MCP 数据。' : '已保存到当前商品，并已重新计算铺货评分。');
    return savedProduct;
  };

  const updateProductMcpData = () => {
    saveBackToProduct(false);
    setSaveNotice('已更新商品 MCP 数据，并重新计算铺货评分。');
  };

  const saveCandidate = () => {
    const savedProduct = saveBackToProduct(true);
    const record = createCandidateRecord({
      asin: asin.trim(),
      keyword: mainKeyword.trim(),
      product: savedProduct,
      validation: result,
      costs: manualCosts,
      margin: marginSnapshot,
      notes,
    });
    const nextCandidates = [record, ...candidates].slice(0, 50);
    setCandidates(nextCandidates);
    saveCandidates(nextCandidates);
    setSaveNotice('已保存为候选商品和本地候选记录。');
  };

  const deleteCandidate = (id: string) => {
    const nextCandidates = candidates.filter((candidate) => candidate.id !== id);
    setCandidates(nextCandidates);
    saveCandidates(nextCandidates);
  };

  const updateCandidate = (id: string) => {
    const savedProduct = saveBackToProduct(true);
    const replacement = createCandidateRecord({
      asin: asin.trim(),
      keyword: mainKeyword.trim(),
      product: savedProduct,
      validation: result,
      costs: manualCosts,
      margin: marginSnapshot,
      notes,
    });
    const nextCandidates = candidates.map((candidate) =>
      candidate.id === id ? { ...replacement, id, saved_at: new Date().toISOString() } : candidate,
    );
    setCandidates(nextCandidates);
    saveCandidates(nextCandidates);
    setSaveNotice('已更新候选记录和商品评分。');
  };

  const exportCandidateRecords = () => {
    const csv = exportCandidatesCsv(candidates);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mcp-candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mcp-page">
      <section className="content-section">
        <div className="section-heading">
          <h2>MCP 单品验证</h2>
          <p>只做单 ASIN 手动查询。广告机会分开看主关键词和多个长尾词，避免只盯一个大词。</p>
        </div>
        <div className="input-grid">
          <label>
            <span>ASIN</span>
            <input value={asin} onChange={(event) => changeAsin(event.target.value)} placeholder="输入 ASIN" />
          </label>
          <label>
            <span>主关键词</span>
            <input value={mainKeyword} onChange={(event) => setMainKeyword(event.target.value)} placeholder="产品最核心的大词/类目词" />
            <small>产品最核心的大词/类目词，用于判断市场和主需求。</small>
          </label>
          <label className="keyword-textarea">
            <span>长尾关键词列表</span>
            <textarea value={longTailText} onChange={(event) => setLongTailText(parseLongTailKeywords(event.target.value).join('\n'))} placeholder="一行一个长尾词，单次最多 10 个" />
          </label>
        </div>
        {longTailSuggestions.length > 0 && (
          <div className="keyword-suggestion-box">
            <strong>自动生成的长尾词建议</strong>
            <div className="keyword-suggestion-grid">
              {longTailSuggestions.map((suggestion) => (
                <Check
                  key={suggestion}
                  label={suggestion}
                  checked={selectedSuggestions.includes(suggestion)}
                  onChange={(checked) => toggleSuggestion(suggestion, checked)}
                />
              ))}
            </div>
          </div>
        )}
        <div className="action-row">
          <button type="button" onClick={() => runSection('asin_detail')} disabled={isLoading}>
            查询 ASIN 详情
          </button>
          <button type="button" onClick={() => runSection('asin_prediction')} disabled={isLoading}>
            查询 ASIN 销量趋势
          </button>
          <button type="button" onClick={() => runSection('traffic_keyword_stat')} disabled={isLoading}>
            查询 ASIN 流量关键词统计
          </button>
          <button type="button" onClick={() => runSection('keyword_miner')} disabled={isLoading}>
            查询主关键词数据
          </button>
          <button type="button" onClick={queryLongTailKeywords} disabled={isLoading || longTailLoading}>
            {longTailLoading ? '长尾词查询中' : '查询长尾关键词数据'}
          </button>
          <button type="button" onClick={queryAllKeywords} disabled={isLoading || longTailLoading}>
            一键查询全部关键词
          </button>
          <button type="button" onClick={generateSuggestions} disabled={isLoading}>
            自动生成长尾词建议
          </button>
          <button type="button" onClick={clearLongTailKeywords} disabled={isLoading || longTailLoading}>
            清空长尾词
          </button>
          <button className="primary-button" type="button" onClick={runAll} disabled={isLoading}>
            一键小样本验证
          </button>
        </div>
        {keywordNotice && <p className="save-notice">{keywordNotice}</p>}
        <div className="action-row">
          <button type="button" onClick={() => saveBackToProduct(false)}>
            保存到当前商品
          </button>
          <button type="button" onClick={saveCandidate}>
            保存为候选商品
          </button>
          <button type="button" onClick={updateProductMcpData}>
            更新商品 MCP 数据
          </button>
        </div>
        <div className="status-grid">
          {Object.entries(sectionStatus).map(([section, status]) => (
            <div className={`status-pill status-${status}`} key={section}>
              <span>{section}</span>
              <strong>{statusText(status)}</strong>
            </div>
          ))}
        </div>
        {errors.length > 0 && (
          <div className="error-box">
            {errors.slice(-4).map((error, index) => (
              <p key={`${error}-${index}`}>{getMcpFriendlyError(error)}</p>
            ))}
          </div>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>字段可用性</h2>
          <p>用于判断哪些数据已可用于铺货模型，哪些需要人工录入或 Amazon 前台复核。</p>
        </div>
        <div className="availability-grid">
          {fieldItems.map((item) => (
            <div className="field-card" key={`${item.group}-${item.field}`}>
              <div>
                <span className="field-group">{item.group}</span>
                <strong>{item.label}</strong>
                <small>{item.field}</small>
              </div>
              <span className={`field-status field-status-${item.status.replace(/\s/g, '')}`}>{item.status}</span>
              <em>{valueLabel(item.value)}</em>
            </div>
          ))}
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>是否支撑铺货模型</h2>
          <p>这里先做规则诊断，不自动把候选品加入批量池。</p>
        </div>
        <div className="diagnosis-grid">
          <div className="diagnosis-card">
            <h3>低评论出单判断</h3>
            <p>{diagnoseLowReviewSales(mergedProduct)}</p>
          </div>
          <div className="diagnosis-card">
            <h3>价格压制判断</h3>
            {priceDiagnostics.length ? (
              <>
                {typeof mergedProduct?.fba_fee !== 'number' && <p>FBA费用未返回，平台后毛利只能估算或需人工补充。</p>}
                <table>
                  <thead>
                    <tr>
                      <th>目标</th>
                      <th>目标价</th>
                      <th>平台后毛利率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceDiagnostics.map((item) => (
                      <tr key={item.label}>
                        <td>{item.label}</td>
                        <td>{item.target}</td>
                        <td>{item.margin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p>无法判断，缺少 price。FBA费用和 referral fee 也需要继续复核。</p>
            )}
          </div>
          <div className="diagnosis-card">
            <h3>低竞价广告判断</h3>
            {adDiagnostics.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>长尾词机会：{longTailOpportunityLabel(longTailOpportunity.level)}。</p>
            <p>推荐低预算 SP 词：{longTailOpportunity.recommended_sp_keywords.join('、') || '待长尾词查询后确认'}。</p>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>人工成本与最终毛利</h2>
          <p>录入采购、头程、包装等成本，计算平台后毛利率和最终毛利率。</p>
        </div>
        <div className="cost-layout">
          <div className="cost-input-grid">
            <CostInput label="目标降价比例" suffix="例：0.05" value={costInputs.target_discount_rate} onChange={(value) => updateCostInput('target_discount_rate', value)} />
            <CostInput label="Referral Fee比例" suffix="默认 0.15" value={costInputs.referral_fee_rate} onChange={(value) => updateCostInput('referral_fee_rate', value)} />
            <CostInput label="人工FBA费用" suffix="MCP未返回时填" value={costInputs.manual_fba_fee} onChange={(value) => updateCostInput('manual_fba_fee', value)} />
            <CostInput label="采购价" suffix="单件成本" value={costInputs.purchase_cost} onChange={(value) => updateCostInput('purchase_cost', value)} />
            <CostInput label="头程费用" suffix="单件分摊" value={costInputs.first_leg_shipping} onChange={(value) => updateCostInput('first_leg_shipping', value)} />
            <CostInput label="包装费用" suffix="单件分摊" value={costInputs.packaging_cost} onChange={(value) => updateCostInput('packaging_cost', value)} />
            <CostInput label="仓储费用" suffix="单件分摊" value={costInputs.storage_cost_usd} onChange={(value) => updateCostInput('storage_cost_usd', value)} />
            <CostInput label="平台其他费用" suffix="广告外平台费" value={costInputs.platform_other_fee} onChange={(value) => updateCostInput('platform_other_fee', value)} />
            <CostInput label="退货损耗" suffix="单件估算" value={costInputs.return_loss} onChange={(value) => updateCostInput('return_loss', value)} />
            <CostInput label="其他成本" suffix="贴标/损耗等" value={costInputs.other_cost} onChange={(value) => updateCostInput('other_cost', value)} />
          </div>
          <div className="margin-panel">
            <div className="margin-kpis">
              <Metric label="原始售价" value={formatMoney(marginSnapshot.base_price)} />
              <Metric label="目标售价" value={formatMoney(marginSnapshot.target_price)} />
              <Metric label="平台佣金" value={formatMoney(marginSnapshot.referral_fee)} />
              <Metric label="FBA费用" value={formatMoney(marginSnapshot.fba_fee)} />
              <Metric label="商品全成本" value={formatMoney(marginSnapshot.product_full_cost)} />
              <Metric label="平台后毛利率" value={formatPercent(marginSnapshot.platform_margin_rate)} tone={marginSnapshot.platform_margin_pass ? 'good' : 'warn'} />
              <Metric label="最终毛利率" value={formatPercent(marginSnapshot.final_margin_rate)} tone={marginSnapshot.final_margin_pass ? 'good' : 'warn'} />
            </div>
            <div className="margin-verdict">{marginVerdict(marginSnapshot)}</div>
            {marginSnapshot.warnings.length > 0 && (
              <div className="warning-list">
                {marginSnapshot.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            )}
            <label className="notes-field">
              <span>候选备注</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="记录供应商、风险点、前台复核结论等" />
            </label>
            <button className="primary-button" type="button" onClick={saveCandidate}>
              保存为候选记录
            </button>
            {saveNotice && <p className="save-notice">{saveNotice}</p>}
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>本地候选记录</h2>
          <p>只保存在当前浏览器本地，用于小样本验证沉淀；不会触发 MCP 调用。</p>
        </div>
        {candidates.length > 0 && (
          <div className="action-row compact-actions">
            <button className="secondary-button" type="button" onClick={exportCandidateRecords}>
              导出候选记录
            </button>
          </div>
        )}
        {candidates.length ? (
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <div className="candidate-card" key={candidate.id}>
                <div>
                  <strong>{candidate.asin || '未填写 ASIN'}</strong>
                  <span>{candidate.keyword || '未填写关键词'}</span>
                  <span>前台复核：{candidate.front_review?.front_review_level || candidate.front_review_status || '未开始'}</span>
                  <span>最终建议：{candidate.final_advice || '待复核'}</span>
                  <span>负责人：{candidate.front_review?.reviewer || '未填写'}</span>
                  <small>{new Date(candidate.saved_at).toLocaleString()}</small>
                </div>
                <div className="candidate-metrics">
                  <Metric label="目标价" value={formatMoney(candidate.margin.target_price)} />
                  <Metric label="平台后毛利" value={formatPercent(candidate.margin.platform_margin_rate)} tone={candidate.margin.platform_margin_pass ? 'good' : 'warn'} />
                  <Metric label="最终毛利" value={formatPercent(candidate.margin.final_margin_rate)} tone={candidate.margin.final_margin_pass ? 'good' : 'warn'} />
                  <Metric label="铺货捡漏分" value={valueLabel(candidate.flea_market_score)} />
                  <Metric label="前台复核分" value={valueLabel(candidate.front_review?.front_review_score)} />
                  <Metric label="月销量" value={valueLabel(candidate.product?.monthly_sales)} />
                  <Metric label="评论数" value={valueLabel(candidate.product?.review_count)} />
                </div>
                {(candidate.notes || candidate.front_review?.notes) && <p className="candidate-notes">{candidate.notes || candidate.front_review?.notes}</p>}
                <div className="action-row compact-actions">
                  <button className="secondary-button" type="button" onClick={() => updateCandidate(candidate.id)}>
                    用当前验证更新
                  </button>
                  <button className="secondary-button" type="button" onClick={() => deleteCandidate(candidate.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">暂无候选记录。完成小样本验证和成本录入后，可以手动保存。</div>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>ASIN详情标准化字段</h2>
        </div>
        <SnapshotGrid snapshot={result.asin_detail?.data ?? null} fields={productFields} />
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>ASIN趋势字段</h2>
        </div>
        <SnapshotGrid snapshot={result.asin_prediction?.data ?? null} fields={predictionFields} />
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>流量关键词统计字段</h2>
        </div>
        <RawSummary raw={result.traffic_keyword_stat?.data ?? result.traffic_keyword_stat?.raw ?? null} />
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>关键词广告机会</h2>
          <p>主词用于判断需求，长尾词用于找低预算 SP 捡漏入口。</p>
        </div>
        <SnapshotGrid snapshot={result.keyword_miner?.data ?? null} fields={keywordFields} />
        <KeywordSnapshotTable snapshots={activeKeywordSnapshots} />
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>原始 raw response</h2>
        </div>
        <div className="raw-stack">
          <RawBlock title="asin_detail raw" raw={result.asin_detail?.raw ?? null} />
          <RawBlock title="asin_prediction raw" raw={result.asin_prediction?.raw ?? null} />
          <RawBlock title="traffic_keyword_stat raw" raw={result.traffic_keyword_stat?.raw ?? null} />
          <RawBlock title="keyword_miner raw" raw={result.keyword_miner?.raw ?? null} />
          <RawBlock title="keyword_snapshots raw" raw={activeKeywordSnapshots} />
        </div>
      </section>
    </div>
  );
}

const productFields: Array<[keyof McpProductSnapshot, string]> = [
  ['asin', 'ASIN'],
  ['title', '标题'],
  ['brand', '品牌'],
  ['category', '类目'],
  ['price', '售价'],
  ['coupon_price', '券后价'],
  ['rating', '评分'],
  ['review_count', '评论数'],
  ['bsr', 'BSR'],
  ['monthly_sales', '月销量'],
  ['monthly_revenue', '月销售额'],
  ['fba_fee', 'FBA费用'],
  ['referral_fee', '平台佣金'],
  ['referral_fee_rate', '佣金比例'],
  ['seller', '卖家'],
  ['seller_type', '卖家类型'],
  ['variation_count', '变体数'],
  ['buybox_seller', 'Buy Box卖家'],
  ['fulfillment_type', '配送类型'],
];

const predictionFields: Array<[keyof McpPredictionSnapshot, string]> = [
  ['asin', 'ASIN'],
  ['recent_30d_sales', '近30天销量'],
  ['recent_30d_revenue', '近30天销售额'],
  ['demand_stability_level', '需求稳定度'],
  ['sales_trend', '销量趋势'],
  ['revenue_trend', '销售额趋势'],
  ['price_trend', '价格趋势'],
  ['bsr_trend', 'BSR趋势'],
];

const keywordFields: Array<[keyof McpKeywordSnapshot, string]> = [
  ['keyword', '关键词'],
  ['search_volume', '搜索量'],
  ['purchase_volume', '购买量'],
  ['purchase_rate', '购买率'],
  ['ppc_bid', 'PPC竞价'],
  ['competition_level', '竞争等级'],
  ['ad_competitor_count', '广告竞品数'],
  ['organic_competitor_count', '自然竞品数'],
  ['title_density', '标题密度'],
  ['spr', 'SPR'],
  ['click_concentration', '点击集中度'],
];

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="checkbox-label"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function KeywordSnapshotTable({ snapshots }: { snapshots: KeywordSnapshot[] }) {
  if (!snapshots.length) return <div className="empty-state">暂未查询主词或长尾词数据。</div>;
  return (
    <div className="table-wrap keyword-table">
      <table>
        <thead>
          <tr>
            <th>关键词</th>
            <th>类型</th>
            <th>搜索量</th>
            <th>PPC</th>
            <th>购买率</th>
            <th>广告竞品数</th>
            <th>标题密度</th>
            <th>判断</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((snapshot) => (
            <tr key={`${snapshot.keyword_type}-${snapshot.keyword}`}>
              <td>{snapshot.keyword ?? '未返回'}</td>
              <td>{keywordTypeLabel(snapshot.keyword_type)}</td>
              <td>{valueLabel(snapshot.search_volume)}</td>
              <td>{formatMoney(snapshot.ppc_bid)}</td>
              <td>{formatPercent(snapshot.purchase_rate)}</td>
              <td>{valueLabel(snapshot.ad_competitor_count)}</td>
              <td>{valueLabel(snapshot.title_density)}</td>
              <td>{keywordSnapshotVerdict(snapshot)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function keywordTypeLabel(type: KeywordSnapshot['keyword_type']): string {
  const labels: Record<KeywordSnapshot['keyword_type'], string> = {
    main: '主关键词',
    long_tail: '长尾词',
    auto_generated: '自动建议',
    manual: '手动长尾',
  };
  return labels[type];
}

function keywordSnapshotVerdict(snapshot: KeywordSnapshot): string {
  if (snapshot.error) return '查询失败';
  const searchFit = (snapshot.search_volume ?? 0) >= 300 && (snapshot.search_volume ?? 0) <= 5000;
  const ppcFit = typeof snapshot.ppc_bid === 'number' && snapshot.ppc_bid <= 1;
  const competitionFit = (snapshot.ad_competitor_count ?? Number.POSITIVE_INFINITY) <= 100 && (snapshot.title_density ?? Number.POSITIVE_INFINITY) <= 50;
  if (snapshot.keyword_type === 'main') return searchFit || (snapshot.purchase_volume ?? 0) > 0 ? '主需求可参考' : '主需求待确认';
  return searchFit && ppcFit && competitionFit ? '推荐低预算 SP 测试' : '谨慎测试';
}

function CostInput({ label, suffix, value, onChange }: { label: string; suffix: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min="0" step="0.01" value={value} onChange={(event) => onChange(event.target.value)} placeholder={suffix} />
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SnapshotGrid<T extends object>({ snapshot, fields }: { snapshot: T | null; fields: Array<[keyof T, string]> }) {
  if (!snapshot) return <div className="empty-state">暂未返回数据。</div>;
  return (
    <div className="snapshot-grid">
      {fields.map(([field, label]) => (
        <div className="snapshot-item" key={String(field)}>
          <span>{label}</span>
          <strong>{valueLabel(snapshot[field])}</strong>
        </div>
      ))}
    </div>
  );
}

function RawSummary({ raw }: { raw: unknown }) {
  if (!raw) return <div className="empty-state">暂未返回数据。</div>;
  if (typeof raw !== 'object') return <div className="empty-state">{String(raw)}</div>;
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, 12);
  return (
    <div className="snapshot-grid">
      {entries.map(([key, value]) => (
        <div className="snapshot-item" key={key}>
          <span>{key}</span>
          <strong>{valueLabel(value)}</strong>
        </div>
      ))}
    </div>
  );
}

function RawBlock({ title, raw }: { title: string; raw: unknown }) {
  return (
    <details className="raw-block">
      <summary>{title}</summary>
      <pre>{raw ? JSON.stringify(raw, null, 2) : '未返回'}</pre>
    </details>
  );
}
