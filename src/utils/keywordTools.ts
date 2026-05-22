import type {
  AsinKeywordClassification,
  AsinKeywordInsight,
  AsinKeywordInsightType,
  AsinKeywordSourceTool,
  KeywordSnapshot,
  KeywordSnapshotType,
  KeywordDataConfidence,
  LongTailOpportunityLevel,
  McpKeywordSnapshot,
} from '../types/mcp';

type KeywordProductSeed = {
  title?: string | null;
  category?: string | null;
  brand?: string | null;
  main_keyword?: string | null;
};

const stopWords = new Set([
  'a',
  'an',
  'and',
  'best',
  'by',
  'for',
  'from',
  'home',
  'in',
  'new',
  'of',
  'on',
  'pack',
  'pcs',
  'pc',
  'set',
  'the',
  'to',
  'with',
]);
const weakKeywordWords = new Set(['amazon', 'product', 'products', 'item', 'items', 'kit', 'accessories']);
const coreWords = new Set([
  'organizer',
  'basket',
  'storage',
  'holder',
  'rack',
  'tray',
  'cover',
  'case',
  'shelf',
  'stand',
  'container',
  'bin',
  'drawer',
  'bag',
  'mat',
  'tool',
  'filter',
  'brush',
  'bottle',
]);
const sceneWords = new Set([
  'bathroom',
  'cabinet',
  'car',
  'closet',
  'counter',
  'desk',
  'drawer',
  'garage',
  'garden',
  'kitchen',
  'office',
  'pantry',
  'sink',
  'under',
]);
const functionWords = new Set([
  'adjustable',
  'foldable',
  'hanging',
  'magnetic',
  'pull',
  'sliding',
  'stackable',
  'waterproof',
]);

function normalizedTokens(value: string | null | undefined): string[] {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

function brandWords(brand: string | null | undefined): Set<string> {
  return new Set(normalizedTokens(brand));
}

function cleanPhrase(tokens: string[], blockedBrandWords: Set<string>): string {
  return tokens
    .filter((token) => !stopWords.has(token) && !weakKeywordWords.has(token) && !blockedBrandWords.has(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseScore(tokens: string[]): number {
  const joined = tokens.join(' ');
  const coreScore = tokens.some((token) => coreWords.has(token)) ? 4 : 0;
  const sceneScore = tokens.some((token) => sceneWords.has(token)) ? 2 : 0;
  const functionScore = tokens.some((token) => functionWords.has(token)) ? 2 : 0;
  const numberScore = tokens.some((token) => /\d/.test(token) || token === 'tier') ? 1 : 0;
  return coreScore + sceneScore + functionScore + numberScore + Math.min(3, joined.split(' ').length);
}

function addCandidate(output: Map<string, number>, phrase: string, score: number) {
  const normalized = phrase.trim().replace(/\s+/g, ' ');
  const tokens = normalized.split(' ');
  if (!normalized || tokens.length < 2) return;
  if (/^\d+$/.test(tokens[tokens.length - 1] ?? '')) return;
  if (sceneWords.has(tokens[tokens.length - 1] ?? '') && !coreWords.has(tokens[tokens.length - 1] ?? '')) return;
  output.set(normalized, Math.max(output.get(normalized) ?? 0, score));
}

export function generateLongTailKeywordCandidates(product: KeywordProductSeed): string[] {
  const titleTokens = normalizedTokens(product.title);
  const categoryTokens = normalizedTokens(product.category);
  const blockedBrandWords = brandWords(product.brand);
  const output = new Map<string, number>();
  const rawTokens = titleTokens.filter((token) => !blockedBrandWords.has(token));
  const contentTokens = rawTokens.filter((token) => !stopWords.has(token) && !weakKeywordWords.has(token));

  const main = cleanPhrase(normalizedTokens(product.main_keyword), blockedBrandWords);
  if (main) addCandidate(output, main, 12);

  for (let length = 2; length <= 4; length += 1) {
    for (let index = 0; index <= rawTokens.length - length; index += 1) {
      const rawSlice = rawTokens.slice(index, index + length);
      const phrase = cleanPhrase(rawSlice, blockedBrandWords);
      const tokens = phrase.split(' ').filter(Boolean);
      if (tokens.length < 2 || !tokens.some((token) => coreWords.has(token))) continue;
      addCandidate(output, phrase, phraseScore(tokens));
    }
  }

  const corePhrase =
    Array.from(output.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ??
    contentTokens.slice(0, 3).join(' ');
  const corePhraseTokens = corePhrase.split(' ').filter(Boolean);
  const coreNoun = corePhraseTokens.find((token) => coreWords.has(token)) ?? corePhraseTokens[corePhraseTokens.length - 1];

  rawTokens
    .filter((token) => sceneWords.has(token) && !corePhraseTokens.includes(token))
    .slice(0, 5)
    .forEach((scene) => addCandidate(output, cleanPhrase([scene, ...corePhraseTokens], blockedBrandWords), 9));

  rawTokens
    .filter((token) => functionWords.has(token))
    .slice(0, 4)
    .forEach((feature) => addCandidate(output, cleanPhrase([feature, ...corePhraseTokens], blockedBrandWords), 8));

  rawTokens
    .map((token, index) => {
      if (/\d/.test(token) && rawTokens[index + 1] === 'tier') return [token, 'tier'];
      if (/\d/.test(token)) return [token];
      return null;
    })
    .filter((tokens): tokens is string[] => Boolean(tokens))
    .slice(0, 3)
    .forEach((sizeTokens) => addCandidate(output, cleanPhrase([...sizeTokens, ...corePhraseTokens], blockedBrandWords), 8));

  if (coreNoun) {
    categoryTokens
      .filter((token) => sceneWords.has(token) || functionWords.has(token))
      .slice(0, 4)
      .forEach((token) => addCandidate(output, cleanPhrase([token, coreNoun], blockedBrandWords), 6));
  }

  return Array.from(output.entries())
    .filter(([phrase]) => phrase.length <= 80)
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .map(([phrase]) => phrase)
    .filter((phrase, index, phrases) => phrases.findIndex((item) => item === phrase) === index)
    .slice(0, 10);
}

export function normalizeKeywordSnapshot(
  keyword: string,
  keywordType: KeywordSnapshotType,
  snapshot: McpKeywordSnapshot | null,
  error: string | null = null,
  checkedAt = new Date().toISOString(),
  sourceTool: AsinKeywordSourceTool = keywordType === 'auto_generated' ? 'title_generated' : 'keyword_miner',
  dataConfidence: KeywordDataConfidence = keywordType === 'auto_generated' ? 'low' : 'medium',
): KeywordSnapshot {
  return {
    keyword: snapshot?.keyword ?? (keyword.trim() || null),
    keyword_type: keywordType,
    search_volume: snapshot?.search_volume ?? null,
    purchase_volume: snapshot?.purchase_volume ?? null,
    purchase_rate: snapshot?.purchase_rate ?? null,
    ppc_bid: snapshot?.ppc_bid ?? null,
    competition_level: snapshot?.competition_level ?? null,
    ad_competitor_count: snapshot?.ad_competitor_count ?? null,
    organic_competitor_count: snapshot?.organic_competitor_count ?? null,
    title_density: snapshot?.title_density ?? null,
    spr: snapshot?.spr ?? null,
    click_concentration: snapshot?.click_concentration ?? null,
    raw: snapshot?.raw ?? null,
    checked_at: checkedAt,
    source_tool: sourceTool,
    data_confidence: dataConfidence,
    error,
  };
}

function recordFrom(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function recordsFrom(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const record = recordFrom(raw);
  const candidates = [record.items, record.list, record.data, record.rows, record.keywords, record.result];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return recordsFrom(candidate);
    if (candidate && typeof candidate === 'object') {
      const nested = recordsFrom(candidate);
      if (nested.length) return nested;
    }
  }
  return Object.keys(record).length ? [record] : [];
}

function pick(raw: unknown, keys: string[]): unknown {
  const record = recordFrom(raw);
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function num(raw: unknown, keys: string[]): number | null {
  const value = pick(raw, keys);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,%\s,]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(raw: unknown, keys: string[]): string | null {
  const value = pick(raw, keys);
  if (value === null || value === undefined) return null;
  return String(value);
}

function wordCount(keyword: string): number {
  return keyword.trim().split(/\s+/).filter(Boolean).length;
}

function brandMatch(keyword: string, brand?: string | null): boolean {
  const brandTokens = normalizedTokens(brand);
  if (!brandTokens.length) return false;
  const lower = keyword.toLowerCase();
  return brandTokens.some((token) => token.length > 2 && lower.includes(token));
}

function isTitleFallbackSource(sourceTool: AsinKeywordSourceTool | undefined): boolean {
  return sourceTool === 'title_generated' || sourceTool === 'title_split_fallback';
}

function sourceConfidence(sourceTool: AsinKeywordSourceTool): KeywordDataConfidence {
  if (sourceTool === 'traffic_keyword') return 'high';
  if (sourceTool === 'keyword_order') return 'medium_high';
  if (sourceTool === 'keyword_miner' || sourceTool === 'keyword_research' || sourceTool === 'traffic_extend') return 'medium';
  if (isTitleFallbackSource(sourceTool)) return 'low';
  return 'unknown';
}

function relevance(keyword: string, title?: string | null, category?: string | null): number {
  const keywordTokens = new Set(normalizedTokens(keyword).filter((token) => !stopWords.has(token)));
  const contextTokens = new Set([...normalizedTokens(title), ...normalizedTokens(category)].filter((token) => !stopWords.has(token)));
  if (!keywordTokens.size) return 0;
  let overlap = 0;
  keywordTokens.forEach((token) => {
    if (contextTokens.has(token)) overlap += 1;
  });
  const semanticBonus = Array.from(keywordTokens).some((token) => coreWords.has(token) || sceneWords.has(token)) ? 0.18 : 0;
  return Math.min(1, overlap / keywordTokens.size + semanticBonus);
}

export function calculateKeywordOpportunityScore(insight: Partial<AsinKeywordInsight>): number {
  let score = 0;
  const search = insight.search_volume ?? null;
  if (typeof search === 'number') {
    if (search >= 300 && search <= 5000) score += 24;
    else if (search > 0 && search < 300) score += 8;
    else if (search > 5000 && search <= 20000) score += 14;
  }
  if (typeof insight.purchase_rate === 'number' && insight.purchase_rate >= 0.02) score += 14;
  if (typeof insight.purchase_volume === 'number' && insight.purchase_volume > 0) score += 10;
  if (typeof insight.ppc_bid === 'number') score += insight.ppc_bid <= 0.75 ? 18 : insight.ppc_bid <= 1.5 ? 10 : 2;
  if (typeof insight.title_density === 'number') score += insight.title_density <= 20 ? 12 : insight.title_density <= 50 ? 8 : 0;
  if (typeof insight.ad_competitor_count === 'number') score += insight.ad_competitor_count <= 50 ? 10 : insight.ad_competitor_count <= 120 ? 5 : 0;
  if (typeof insight.click_concentration === 'number') score += insight.click_concentration <= 0.35 ? 6 : 0;
  score += Math.round((insight.relevance_score ?? 0) * 16);
  if (insight.is_brand_keyword || insight.is_competitor_brand) score -= 35;
  if (insight.keyword && wordCount(insight.keyword) >= 3) score += 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function classifyRawKeywordType(raw: unknown, sourceTool: AsinKeywordSourceTool): AsinKeywordInsightType {
  const text = `${str(raw, ['badge', 'badges', 'type', 'keywordType', 'trafficKeywordType', 'conversionType', 'relation']) ?? ''}`.toLowerCase();
  if (sourceTool === 'keyword_order' || text.includes('excellent') || text.includes('conversion') || text.includes('转化')) return 'converting';
  if (text.includes('ads') || text.includes('sponsor') || text.includes('广告')) return 'ads';
  if (text.includes('amazonchoice') || text.includes('editorial') || text.includes('recommend') || text.includes('推荐')) return 'recommended';
  if (text.includes('natural') || text.includes('自然')) return 'natural';
  return 'unknown';
}

export function normalizeAsinKeywordInsights(params: {
  asin: string;
  raw: unknown;
  sourceTool: AsinKeywordSourceTool;
  title?: string | null;
  category?: string | null;
  brand?: string | null;
  checkedAt?: string;
  error?: string | null;
}): AsinKeywordInsight[] {
  const checkedAt = params.checkedAt ?? new Date().toISOString();
  return recordsFrom(params.raw)
    .map((record) => {
      const keyword = str(record, ['keyword', 'keywords', 'query', 'word', 'searchTerm', 'search_term'])?.trim();
      if (!keyword) return null;
      const relevanceScore = relevance(keyword, params.title, params.category);
      const brandKeyword = brandMatch(keyword, params.brand);
      const insight: AsinKeywordInsight = {
        asin: params.asin,
        keyword,
        keyword_type: classifyRawKeywordType(record, params.sourceTool),
        source_tool: params.sourceTool,
        search_volume: num(record, ['search_volume', 'searchVolume', 'searches', 'searchesRank', 'searchRank']),
        purchase_volume: num(record, ['purchase_volume', 'purchaseVolume', 'purchases', 'keywordsIsHide']),
        purchase_rate: num(record, ['purchase_rate', 'purchaseRate', 'purchasesRate', 'conversionRate']),
        ppc_bid: num(record, ['ppc_bid', 'ppcBid', 'bid', 'avgBid', 'suggestedBid']),
        competition_level: str(record, ['competition_level', 'competitionLevel']),
        ad_competitor_count: num(record, ['ad_competitor_count', 'adCompetitorCount', 'adProducts', 'adProduct', 'latest1daysAds']),
        organic_competitor_count: num(record, ['organic_competitor_count', 'organicCompetitorCount', 'products', 'productCount']),
        title_density: num(record, ['title_density', 'titleDensity', 'titleDensityExact']),
        click_concentration: num(record, ['click_concentration', 'clickConcentration', 'monopolyClickRate', 'araClickRate']),
        spr: num(record, ['spr', 'SPR', 'cprExact']),
        traffic_share: num(record, ['traffic_share', 'trafficShare', 'trafficPercentage']),
        conversion_share: num(record, ['conversion_share', 'conversionShare', 'sumConversionRate', 'conversionRate']),
        order_count: num(record, ['order_count', 'orderCount', 'orders', 'purchases']),
        rank_position: num(record, ['rank_position', 'rankPosition', 'naturalRank', 'adPosition']),
        is_brand_keyword: brandKeyword,
        is_competitor_brand: false,
        relevance_score: relevanceScore,
        opportunity_score: 0,
        data_confidence: sourceConfidence(params.sourceTool),
        raw: record,
        checked_at: checkedAt,
        error: params.error ?? null,
      };
      insight.opportunity_score = calculateKeywordOpportunityScore(insight);
      return insight;
    })
    .filter((item): item is AsinKeywordInsight => Boolean(item));
}

export function insightsFromTitleCandidates(params: {
  asin: string;
  title?: string | null;
  category?: string | null;
  brand?: string | null;
  mainKeyword?: string | null;
}): AsinKeywordInsight[] {
  return generateLongTailKeywordCandidates({
    title: params.title,
    category: params.category,
    brand: params.brand,
    main_keyword: params.mainKeyword,
  }).map((keyword) => {
    const insight: AsinKeywordInsight = {
      asin: params.asin,
      keyword,
      keyword_type: 'auto_generated',
      source_tool: 'title_split_fallback',
      search_volume: null,
      purchase_volume: null,
      purchase_rate: null,
      ppc_bid: null,
      competition_level: null,
      ad_competitor_count: null,
      organic_competitor_count: null,
      title_density: null,
      click_concentration: null,
      spr: null,
      traffic_share: null,
      conversion_share: null,
      order_count: null,
      rank_position: null,
      is_brand_keyword: brandMatch(keyword, params.brand),
      is_competitor_brand: false,
      relevance_score: relevance(keyword, params.title, params.category),
      opportunity_score: 0,
      recommended_action: '待 ASIN 反查或关键词指标确认',
      reject_reason: '标题拆词兜底，未验证真实流量',
      data_confidence: 'low',
      raw: { source: 'title_split_fallback', data_confidence: 'low' },
      checked_at: new Date().toISOString(),
      error: null,
    };
    insight.opportunity_score = Math.min(35, calculateKeywordOpportunityScore(insight));
    return insight;
  });
}

function rejectReason(insight: AsinKeywordInsight, mainKeyword: string | null): string | null {
  if (insight.is_brand_keyword || insight.is_competitor_brand) return '品牌词/竞品品牌词';
  if (insight.relevance_score < 0.25) return '相关性弱';
  if ((insight.search_volume ?? 1) === 0) return '搜索量太低';
  if (typeof insight.ppc_bid === 'number' && insight.ppc_bid > 2.5) return 'PPC 太高';
  if ((insight.ad_competitor_count ?? 0) > 250) return '广告竞争过强';
  if (wordCount(insight.keyword) <= 1 && insight.keyword !== mainKeyword) return '大词过宽泛';
  return null;
}

export function classifyAsinKeywords(params: {
  asin: string;
  insights: AsinKeywordInsight[];
  title?: string | null;
  category?: string | null;
  brand?: string | null;
  fallbackMainKeyword?: string | null;
}): AsinKeywordClassification {
  const deduped = Array.from(
    new Map(params.insights.map((insight) => [insight.keyword.trim().toLowerCase(), insight])).values(),
  ).filter((insight) => !insight.error);
  const realInsights = deduped.filter((insight) => !isTitleFallbackSource(insight.source_tool));
  const usable = deduped
    .map((insight) => ({ ...insight, relevance_score: insight.relevance_score || relevance(insight.keyword, params.title, params.category) }))
    .map((insight) => ({ ...insight, opportunity_score: calculateKeywordOpportunityScore(insight) }));
  const main =
    usable
      .filter((insight) => !insight.is_brand_keyword && !insight.is_competitor_brand && wordCount(insight.keyword) <= 3 && insight.relevance_score >= 0.25)
      .sort((left, right) => (right.conversion_share ?? 0) - (left.conversion_share ?? 0) || (right.traffic_share ?? 0) - (left.traffic_share ?? 0) || (right.search_volume ?? 0) - (left.search_volume ?? 0) || right.opportunity_score - left.opportunity_score)[0]?.keyword ??
    params.fallbackMainKeyword ??
    null;

  const classified = usable.map((insight) => {
    const reason = rejectReason(insight, main);
    const words = wordCount(insight.keyword);
    const isLongTail = words >= 3 || (insight.search_volume !== null && insight.search_volume <= 5000 && insight.relevance_score >= 0.35);
    const keyword_type: AsinKeywordInsightType =
      insight.keyword === main
        ? 'main'
        : reason
          ? 'invalid'
          : isLongTail
            ? 'long_tail'
            : insight.keyword_type;
    const recommended =
      !reason &&
      !isTitleFallbackSource(insight.source_tool) &&
      keyword_type === 'long_tail' &&
      insight.opportunity_score >= 45 &&
      (insight.search_volume === null || insight.search_volume > 0);
    return {
      ...insight,
      keyword_type,
      reject_reason: reason,
      recommended_action: recommended
        ? insight.opportunity_score >= 70
          ? 'Exact 小预算测试'
          : 'Phrase 拓词'
        : reason,
    };
  });

  const recommended = classified
    .filter((insight) => insight.recommended_action && !insight.reject_reason && insight.keyword_type === 'long_tail' && !isTitleFallbackSource(insight.source_tool))
    .sort((left, right) => right.opportunity_score - left.opportunity_score)
    .map((insight) => insight.keyword)
    .slice(0, 10);
  const rejected = classified.filter((insight) => insight.reject_reason).map((insight) => insight.keyword).slice(0, 20);
  const longTail = classified
    .filter((insight) => insight.keyword_type === 'long_tail' && (!insight.reject_reason || isTitleFallbackSource(insight.source_tool)))
    .sort((left, right) => right.opportunity_score - left.opportunity_score)
    .map((insight) => insight.keyword)
    .slice(0, 10);
  const level: LongTailOpportunityLevel = recommended.length >= 3 ? 'strong' : recommended.length >= 1 ? 'medium' : longTail.length ? 'weak' : 'unknown';
  const hasTrafficKeyword = realInsights.some((insight) => insight.source_tool === 'traffic_keyword');
  const hasKeywordOrder = realInsights.some((insight) => insight.source_tool === 'keyword_order');
  const hasMetricOnly = realInsights.some((insight) => insight.source_tool === 'keyword_miner' || insight.source_tool === 'keyword_research' || insight.source_tool === 'traffic_extend');
  const confidence: KeywordDataConfidence = hasTrafficKeyword
    ? 'high'
    : hasKeywordOrder
      ? 'medium_high'
      : hasMetricOnly || realInsights.length
        ? 'medium'
        : classified.some((insight) => isTitleFallbackSource(insight.source_tool))
          ? 'low'
          : 'unknown';
  return {
    main_keyword: main,
    long_tail_keywords: longTail,
    recommended_sp_keywords: recommended,
    rejected_keywords: rejected,
    keyword_insights: classified,
    keyword_data_confidence: confidence,
    long_tail_opportunity_level: level,
  };
}

export function exportKeywordInsightsCsv(insights: AsinKeywordInsight[]): string {
  const headers = [
    'ASIN',
    'keyword',
    'keyword_type',
    'source_tool',
    'search_volume',
    'purchase_volume',
    'purchase_rate',
    'ppc_bid',
    'competition_level',
    'ad_competitor_count',
    'organic_competitor_count',
    'title_density',
    'click_concentration',
    'traffic_share',
    'conversion_share',
    'order_count',
    'relevance_score',
    'opportunity_score',
    'recommended_action',
    'reject_reason',
    'checked_at',
  ];
  const rows = insights.map((insight) => [
    insight.asin,
    insight.keyword,
    insight.keyword_type,
    insight.source_tool,
    insight.search_volume,
    insight.purchase_volume,
    insight.purchase_rate,
    insight.ppc_bid,
    insight.competition_level,
    insight.ad_competitor_count,
    insight.organic_competitor_count,
    insight.title_density,
    insight.click_concentration,
    insight.traffic_share,
    insight.conversion_share,
    insight.order_count,
    insight.relevance_score,
    insight.opportunity_score,
    insight.recommended_action ?? '',
    insight.reject_reason ?? '',
    insight.checked_at,
  ]);
  return [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

function hasUsefulSearch(snapshot: KeywordSnapshot): boolean {
  return typeof snapshot.search_volume === 'number' && snapshot.search_volume >= 300 && snapshot.search_volume <= 5000;
}

function hasPurchasingSignal(snapshot: KeywordSnapshot): boolean {
  return (snapshot.purchase_rate ?? 0) >= 0.03 || (snapshot.purchase_volume ?? 0) > 0;
}

function hasLowTitleDensity(snapshot: KeywordSnapshot): boolean {
  return typeof snapshot.title_density === 'number' && snapshot.title_density <= 50;
}

function hasLowAdCompetition(snapshot: KeywordSnapshot): boolean {
  return (
    (typeof snapshot.ad_competitor_count === 'number' && snapshot.ad_competitor_count <= 100) ||
    snapshot.competition_level === '低'
  );
}

function ppcAcceptable(snapshot: KeywordSnapshot, mainBid: number | null): boolean {
  if (typeof snapshot.ppc_bid !== 'number') return false;
  if (snapshot.ppc_bid <= 1) return true;
  return typeof mainBid === 'number' && snapshot.ppc_bid <= mainBid;
}

export function calculateLongTailOpportunity(keywordSnapshots: KeywordSnapshot[]): {
  level: LongTailOpportunityLevel;
  usable_keywords: string[];
  recommended_sp_keywords: string[];
  rejected_keywords: string[];
} {
  const mainBid =
    keywordSnapshots.find((snapshot) => snapshot.keyword_type === 'main' && typeof snapshot.ppc_bid === 'number')?.ppc_bid ??
    null;
  const tails = keywordSnapshots.filter((snapshot) => snapshot.keyword_type !== 'main' && !snapshot.error && snapshot.keyword);
  if (!tails.length) {
    return { level: 'unknown', usable_keywords: [], recommended_sp_keywords: [], rejected_keywords: [] };
  }

  const usable = tails.filter(
    (snapshot) =>
      hasUsefulSearch(snapshot) &&
      ppcAcceptable(snapshot, mainBid) &&
      hasLowTitleDensity(snapshot) &&
      hasLowAdCompetition(snapshot),
  );
  const recommended = usable.filter((snapshot) => hasPurchasingSignal(snapshot));
  const rejected = tails.filter((snapshot) => !recommended.includes(snapshot));
  const strongSignal = usable.length >= 3 && recommended.length >= 2;
  const mediumSignal = usable.length >= 1;
  const level: LongTailOpportunityLevel = strongSignal ? 'strong' : mediumSignal ? 'medium' : 'weak';

  return {
    level,
    usable_keywords: usable.map((snapshot) => snapshot.keyword!).slice(0, 10),
    recommended_sp_keywords: recommended.map((snapshot) => snapshot.keyword!).slice(0, 10),
    rejected_keywords: rejected.map((snapshot) => snapshot.keyword!).slice(0, 10),
  };
}

export function longTailOpportunityLabel(level: LongTailOpportunityLevel): string {
  const labels: Record<LongTailOpportunityLevel, string> = {
    strong: '强长尾广告机会',
    medium: '中等长尾广告机会',
    weak: '长尾机会弱',
    unknown: '待长尾词确认',
  };
  return labels[level];
}
