import type {
  KeywordSnapshot,
  KeywordSnapshotType,
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
    error,
  };
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
