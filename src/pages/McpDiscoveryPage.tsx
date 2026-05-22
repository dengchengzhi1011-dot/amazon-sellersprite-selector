import { Fragment, useMemo, useRef, useState } from 'react';
import AmazonCategoryTree from '../components/AmazonCategoryTree';
import ProductThumbnail from '../components/ProductThumbnail';
import type {
  AmazonCategoryNode,
  CategorySelection,
  CategoryScanRecord,
  DiscoveryFilters,
  DiscoveryResult,
  DiscoveryRun,
  DuplicateStatus,
  McpCandidateRecord,
  McpDiscoveredProduct,
  ProductRecord,
} from '../types/mcp';
import {
  createProductFromDiscovery,
  deleteDiscoveryRun,
  getDiscoveryDuplicateStatuses,
  getDiscoveryResultsByRunId,
  getLatestDiscoveryRun,
  isCategoryScanDue,
  loadCandidates,
  loadCategoryScanRecordMap,
  loadDiscoveryRuns,
  markDiscoveryResultAsCandidate,
  saveDiscoveryResults,
  upsertCategoryScanRecord,
  deriveCategoryScanStatus,
  calculateCategoryNextScanAt,
  updateCandidateDecisionStatus,
  updateDiscoveryRunSavedCandidates,
  upsertDiscoveryCandidate,
  upsertDiscoveryProduct,
  upsertDiscoveryRun,
} from '../utils/productStore';
import { buildCategoryResearchRequest, getMcpFriendlyError, productResearchByCategory } from '../utils/sellerspriteMcp';
import { longTailOpportunityLabel } from '../utils/keywordTools';
import { extractImageUrl } from '../utils/imageTools';
import { normalizeEffectiveReviewCount } from '../utils/scoring';
import { sortCategoryNodes } from '../utils/categorySort';

const selectionStorageKey = 'amazon-sellersprite-selector:selected-category:US';
const categoryCacheKey = 'amazon-sellersprite-selector:amazon-category-tree:US';

type DiscoveryRow = {
  discovered: McpDiscoveredProduct;
  product: ProductRecord;
  duplicate_status: DuplicateStatus[];
  hidden: boolean;
  run_id: string | null;
  result_id: string | null;
  saved_as_candidate: boolean;
};
type AgeQuickFilter = 'all' | '30' | '90' | '180' | '365' | 'exclude_old' | 'missing';
type LayerQuickFilter = 'all' | 'A' | 'A_candidate' | 'B' | 'C' | 'D' | 'E' | 'review';
type BatchTargetLevel = 'L2' | 'L3' | 'L4' | 'L5' | 'leaf';
type BatchScanMode = 'children' | 'level';
type ResultSortMode =
  | 'opportunity'
  | 'score_desc'
  | 'listing_test_desc'
  | 'new_sales_signal_desc'
  | 'low_review_desc'
  | 'age_asc'
  | 'monthly_sales_desc'
  | 'review_count_asc'
  | 'platform_margin_desc';

const defaultFilters: DiscoveryFilters = {
  marketplace: 'US',
  keyword_optional: '',
  price_min: 12,
  price_max: 40,
  monthly_sales_min: 30,
  monthly_sales_max: 300,
  review_count_max: 100,
  rating_min: 3.8,
  limit: 20,
  listing_range_days: 365,
  listed_days_min: 7,
  listed_days_max: 365,
  prioritize_recent: true,
  strict_rating_filter_enabled: false,
  leaf_only: true,
  exclude_history: true,
  hide_parent_duplicates: true,
  hide_similar_products: false,
};
const categoryPanelCollapsedKey = 'amazon-sellersprite-selector:mcp-discovery-category-collapsed';

type BatchScanConfig = {
  targetLevel: BatchTargetLevel;
  maxNodes: number;
  perNodeLimit: number;
  skipScanned: boolean;
  skipCooling: boolean;
  onlyUnscanned: boolean;
  leafOnly: boolean;
  intervalSeconds: number;
};

type BatchPreview = {
  mode: BatchScanMode;
  targetNodes: AmazonCategoryNode[];
  allCandidateCount: number;
  eligibleBeforeLimit: number;
  skippedScanned: number;
  skippedCooling: number;
  skippedLeaf: number;
  skippedBlacklisted: number;
};

type BatchProgress = {
  running: boolean;
  paused: boolean;
  current: number;
  total: number;
  currentNodeName: string;
};

type BatchSummary = {
  scannedNodes: number;
  successNodes: number;
  failedNodes: number;
  rawResults: number;
  filteredResults: number;
  A_count: number;
  A_candidate_count: number;
  B_count: number;
  C_count: number;
  D_count: number;
  E_count: number;
  testableCount: number;
  recommendedNodes: string[];
};

function readCategoryCollapsed(): boolean {
  return window.localStorage.getItem(categoryPanelCollapsedKey) === '1';
}

function saveCategoryCollapsed(collapsed: boolean) {
  window.localStorage.setItem(categoryPanelCollapsedKey, collapsed ? '1' : '0');
}

function readCachedCategoryTree(): AmazonCategoryNode[] {
  try {
    const raw = window.localStorage.getItem(categoryCacheKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? sortCategoryNodes(parsed) : [];
  } catch {
    return [];
  }
}

function readSelection(): CategorySelection | null {
  try {
    const raw = window.localStorage.getItem(selectionStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSelection(selection: CategorySelection) {
  window.localStorage.setItem(selectionStorageKey, JSON.stringify(selection));
}

function selectionFromNode(node: AmazonCategoryNode): CategorySelection {
  return {
    node_id: node.node_id,
    name: node.name,
    path: node.path,
    level: node.level,
    is_leaf: node.is_leaf,
    selected_at: new Date().toISOString(),
  };
}

function findCategoryNode(nodes: AmazonCategoryNode[], nodeId: string): AmazonCategoryNode | null {
  for (const node of nodes) {
    if (node.node_id === nodeId) return node;
    const child = findCategoryNode(node.children ?? [], nodeId);
    if (child) return child;
  }
  return null;
}

function collectDescendantNodes(node: AmazonCategoryNode): AmazonCategoryNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...collectDescendantNodes(child)]);
}

function batchLevelLabel(level: BatchTargetLevel): string {
  return level === 'leaf' ? '叶子类目' : level;
}

function nodeMatchesBatchLevel(node: AmazonCategoryNode, targetLevel: BatchTargetLevel): boolean {
  if (targetLevel === 'leaf') return node.is_leaf;
  return node.level === Number(targetLevel.replace('L', ''));
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function selectionFromRun(run: DiscoveryRun): CategorySelection {
  const parts = run.category_path.split('>').map((part) => part.trim()).filter(Boolean);
  return {
    node_id: run.category_node_id,
    name: parts[parts.length - 1] ?? run.category_path,
    path: run.category_path,
    level: Math.max(1, parts.length),
    is_leaf: true,
    selected_at: run.created_at ?? run.started_at,
  };
}

function recordsToMap(records: CategoryScanRecord[]): Record<string, CategoryScanRecord> {
  return records.reduce<Record<string, CategoryScanRecord>>((map, record) => {
    map[record.node_id] = record;
    return map;
  }, {});
}

function categoryScanStatusLabel(record: CategoryScanRecord): string {
  if (record.scan_status === 'blacklisted') return '已拉黑';
  if (record.scan_status === 'failed') return '扫描失败';
  if (record.next_scan_at && new Date(record.next_scan_at).getTime() <= Date.now()) return '数据过期可复扫';
  if (record.raw_result_count === 0 || record.scan_status === 'raw_empty') return '原始返回0条';
  if (record.filtered_result_count === 0 || record.scan_status === 'filtered_empty') return '筛选后0条';
  if (record.testable_count === 0 || record.scan_status === 'no_testable') return '无可测产品';
  if (record.A_count + record.A_candidate_count + record.B_count > 0) return `有机会，可测${record.testable_count}条`;
  if (record.C_count > 0 || record.scan_status === 'watch_rescan') return `观察，可测${record.testable_count}条`;
  if (record.scan_status === 'cooling') return '冷却中';
  return `已扫描，可测${record.testable_count}条`;
}

function categoryScanButtonLabel(record?: CategoryScanRecord): string {
  if (!record) return '扫描当前类目';
  if (record.scan_status === 'failed') return '重试当前类目';
  if (record.scan_status === 'blacklisted') return '已拉黑';
  return isCategoryScanDue(record) ? '复扫当前类目' : '已扫过';
}

function categoryScanNote(record: CategoryScanRecord): string {
  if (record.scan_status === 'failed') return '上次扫描失败，可立即重试';
  if (record.scan_status === 'filtered_empty') return 'MCP 有原始结果，但当前筛选/去重后为 0 条，可放宽筛选重扫';
  if (record.scan_status === 'raw_empty') return '卖家精灵当前未返回结果，建议换相邻节点或稍后复扫';
  if (record.scan_status === 'no_testable') return '有商品返回，但当前没有达到铺货测试标准，可进入冷却';
  if (record.scan_status === 'priority_rescan') return '有 A/A候选/B 机会，建议重点复扫';
  if (record.scan_status === 'watch_rescan') return '有 C 类观察机会，建议观察复扫';
  if (record.scan_status === 'cooling') return '结果偏弱或基本全 E，进入冷却';
  if (record.scan_status === 'blacklisted') return '风险类目，不建议扫描';
  return '已扫描，按复扫时间控制';
}

function buildCategoryScanRecord(
  selection: CategorySelection,
  run: DiscoveryRun,
  rows: DiscoveryRow[],
  previous?: CategoryScanRecord,
): CategoryScanRecord {
  const visibleRows = rows.filter((row) => !row.hidden);
  const counts = visibleRows.reduce(
    (summary, row) => {
      const group = layerGroupKey(row);
      if (group === 'A') summary.A_count += 1;
      else if (group === 'A_candidate') summary.A_candidate_count += 1;
      else if (group === 'B') summary.B_count += 1;
      else if (group === 'C') summary.C_count += 1;
      else if (group === 'D' || group === 'review') summary.D_count += 1;
      else if (group === 'E') summary.E_count += 1;
      summary.best_score = Math.max(summary.best_score, row.product.score.flea_market_score, row.product.score.listing_test_score.score);
      return summary;
    },
    { A_count: 0, A_candidate_count: 0, B_count: 0, C_count: 0, D_count: 0, E_count: 0, best_score: 0 },
  );
  const rawResultCount = run.raw_result_count ?? rows.length;
  const filteredResultCount = run.visible_result_count ?? visibleRows.length;
  const testableCount = counts.A_count + counts.A_candidate_count + counts.B_count + counts.C_count;
  const finishedAt = run.finished_at ?? new Date().toISOString();
  const scanStatus = deriveCategoryScanStatus({
    raw_result_count: rawResultCount,
    filtered_result_count: filteredResultCount,
    testable_count: testableCount,
    ...counts,
  });
  const draft: CategoryScanRecord = {
    node_id: selection.node_id,
    node_name: selection.name,
    category_path: selection.path,
    level: selection.level,
    last_scan_at: finishedAt,
    next_scan_at: null,
    scan_count: (previous?.scan_count ?? 0) + 1,
    last_result_count: rawResultCount,
    raw_result_count: rawResultCount,
    filtered_result_count: filteredResultCount,
    testable_count: testableCount,
    A_count: counts.A_count,
    A_candidate_count: counts.A_candidate_count,
    B_count: counts.B_count,
    C_count: counts.C_count,
    D_count: counts.D_count,
    E_count: counts.E_count,
    best_score: rawResultCount ? counts.best_score : null,
    scan_status: scanStatus,
    scan_note: '',
  };
  return {
    ...draft,
    next_scan_at: calculateCategoryNextScanAt(scanStatus, draft, finishedAt),
    scan_note: categoryScanNote(draft),
  };
}

function buildFailedCategoryScanRecord(
  selection: CategorySelection,
  run: DiscoveryRun,
  previous: CategoryScanRecord | undefined,
  error: string,
): CategoryScanRecord {
  const failedAt = run.finished_at ?? new Date().toISOString();
  return {
    node_id: selection.node_id,
    node_name: selection.name,
    category_path: selection.path,
    level: selection.level,
    last_scan_at: failedAt,
    next_scan_at: failedAt,
    scan_count: (previous?.scan_count ?? 0) + 1,
    last_result_count: 0,
    raw_result_count: 0,
    filtered_result_count: 0,
    testable_count: 0,
    A_count: 0,
    A_candidate_count: 0,
    B_count: 0,
    C_count: 0,
    D_count: 0,
    E_count: 0,
    best_score: null,
    scan_status: 'failed',
    scan_note: `上次扫描失败，可重试：${error}`,
  };
}

export default function McpDiscoveryPage({
  products,
  onProductsChange,
  onSendToValidation,
  onOpenReview,
  onOpenDevelopment,
}: {
  products: ProductRecord[];
  onProductsChange: (products: ProductRecord[]) => void;
  onSendToValidation: (
    asin: string,
    seed?: { mainKeyword?: string; title?: string; category?: string; generateLongTail?: boolean; queryLongTail?: boolean },
  ) => void;
  onOpenReview: (asin: string, context?: { sourceList: string[]; currentIndex: number }) => void;
  onOpenDevelopment: () => void;
}) {
  const [initialRestore] = useState(() => {
    const run = getLatestDiscoveryRun();
    const results = run ? getDiscoveryResultsByRunId(run.id) : [];
    return { run, results };
  });
  const [selection, setSelection] = useState<CategorySelection | null>(() => initialRestore.run ? selectionFromRun(initialRestore.run) : readSelection());
  const [filters, setFilters] = useState<DiscoveryFilters>(() => initialRestore.run?.filters ?? { ...defaultFilters });
  const [refreshToken] = useState(0);
  const [rows, setRows] = useState<DiscoveryRow[]>(() =>
    initialRestore.run ? rowsFromDiscoveryResults(initialRestore.results, products, initialRestore.run.filters) : [],
  );
  const [runs, setRuns] = useState<DiscoveryRun[]>(() => loadDiscoveryRuns());
  const [categoryScanMap, setCategoryScanMap] = useState<Record<string, CategoryScanRecord>>(() => loadCategoryScanRecordMap());
  const [candidates, setCandidates] = useState<McpCandidateRecord[]>(() => loadCandidates());
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialRestore.run?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState(
    initialRestore.run && initialRestore.results.length
      ? `已恢复最近一次找品结果：${initialRestore.run.category_path}，返回 ${initialRestore.results.length} 条。`
      : '请选择 Amazon 类目节点，使用 MCP 小批量找品。',
  );
  const [categoryCollapsed, setCategoryCollapsed] = useState(() => readCategoryCollapsed());
  const [categoryNodes, setCategoryNodes] = useState<AmazonCategoryNode[]>(() => readCachedCategoryTree());
  const [layerQuickFilter, setLayerQuickFilter] = useState<LayerQuickFilter>('all');
  const [ageQuickFilter, setAgeQuickFilter] = useState<AgeQuickFilter>('all');
  const [sortMode, setSortMode] = useState<ResultSortMode>('opportunity');
  const [batchConfig, setBatchConfig] = useState<BatchScanConfig>({
    targetLevel: 'L3',
    maxNodes: 5,
    perNodeLimit: 20,
    skipScanned: true,
    skipCooling: true,
    onlyUnscanned: false,
    leafOnly: false,
    intervalSeconds: 1,
  });
  const [batchPreview, setBatchPreview] = useState<BatchPreview | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress>({ running: false, paused: false, current: 0, total: 0, currentNodeName: '' });
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const resultsSectionRef = useRef<HTMLElement | null>(null);
  const batchControlRef = useRef({ cancelled: false, paused: false });

  const visibleRows = useMemo(
    () =>
      sortDiscoveryRows(
        rows.filter((row) => !row.hidden && matchLayerQuickFilter(row, layerQuickFilter) && matchAgeQuickFilter(row.discovered, ageQuickFilter)),
        sortMode,
      ),
    [rows, layerQuickFilter, ageQuickFilter, sortMode],
  );
  const groupedVisibleRows = useMemo(() => groupRowsForDisplay(visibleRows, layerQuickFilter), [visibleRows, layerQuickFilter]);
  const storedResultCounts = useMemo(
    () =>
      runs.reduce<Record<string, number>>((counts, run) => {
        counts[run.id] = getDiscoveryResultsByRunId(run.id).length;
        return counts;
      }, {}),
    [runs],
  );
  const selectedScanRecord = selection ? categoryScanMap[selection.node_id] : undefined;
  const currentRun = currentRunId ? runs.find((run) => run.id === currentRunId) : null;

  const scrollToResults = () => {
    window.setTimeout(() => {
      resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const chooseCategory = (next: CategorySelection) => {
    setSelection(next);
    saveSelection(next);
  };

  const updateCategoryCollapsed = (collapsed: boolean) => {
    setCategoryCollapsed(collapsed);
    saveCategoryCollapsed(collapsed);
  };

  const updateNumber = (key: keyof DiscoveryFilters, value: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    setFilters((current) => ({ ...current, [key]: key === 'limit' ? Math.max(1, Math.min(50, Math.round(number))) : number }));
  };

  const updateListingRange = (value: string) => {
    const nextRange = value === 'unlimited' ? null : Number(value) as DiscoveryFilters['listing_range_days'];
    setFilters((current) => ({
      ...current,
      listing_range_days: nextRange,
      listed_days_max: nextRange ?? current.listed_days_max,
    }));
  };

  const executeDiscoveryScan = async (
    targetSelection: CategorySelection,
    scanFilters: DiscoveryFilters,
    options: { updateDisplay: boolean },
  ) => {
    const existingScan = loadCategoryScanRecordMap()[targetSelection.node_id];
    const safeFilters = { ...scanFilters, limit: Math.min(scanFilters.limit, 50) };
    const requestParams = buildCategoryResearchRequest(targetSelection, safeFilters);
    const run: DiscoveryRun = {
      id: `${Date.now()}-${targetSelection.node_id}-${Math.random().toString(36).slice(2, 7)}`,
      run_type: 'category_manual',
      marketplace: safeFilters.marketplace,
      category_node_id: targetSelection.node_id,
      category_path: targetSelection.path,
      keyword_optional: safeFilters.keyword_optional,
      filters: safeFilters,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      status: 'loading',
      total_mcp_calls: 1,
      total_results: 0,
      hidden_duplicates: 0,
      saved_candidates: 0,
      mcp_failed_count: 0,
      errors: [],
      result_state: undefined,
      raw_result_count: 0,
      filtered_result_count: 0,
      visible_result_count: 0,
      error_message: null,
      failed_tool: null,
      request_params: requestParams,
      raw_response_summary: undefined,
    };
    setRuns(upsertDiscoveryRun(run));
    setCurrentRunId(run.id);
    if (options.updateDisplay) {
      setErrors([]);
      setWarnings([]);
      setNotice('');
    }

    const result = await productResearchByCategory(targetSelection, run.filters);

    if (result.status !== 'success' || !result.data) {
      const message = getMcpFriendlyError(result.error);
      const failed = {
        ...run,
        finished_at: new Date().toISOString(),
        status: 'failed' as const,
        mcp_failed_count: 1,
        errors: [message],
        result_state: 'request_failed' as const,
        error_message: message,
        failed_tool: result.tool,
        raw_response_summary: { error: result.error, status: result.status },
      };
      setRuns(upsertDiscoveryRun(failed));
      const scanRecord = buildFailedCategoryScanRecord(targetSelection, failed, existingScan, message);
      setCategoryScanMap(recordsToMap(upsertCategoryScanRecord(scanRecord)));
      if (options.updateDisplay) {
        setErrors([message]);
        setNotice('本次 MCP 请求失败，不代表该类目没有产品，请查看失败原因或重试。');
      }
      return { ok: false, run: failed, rows: [] as DiscoveryRow[], scanRecord, message };
    }

    const scannedRows = buildRows(result.data.products, products, candidates, safeFilters, run.id);
    const visibleResultCount = scannedRows.filter((row) => !row.hidden).length;
    const resultState = result.data.raw_result_count === 0
      ? 'raw_empty'
      : visibleResultCount === 0
        ? 'filtered_empty'
        : 'has_results';
    const finished: DiscoveryRun = {
      ...run,
      finished_at: new Date().toISOString(),
      status: 'success',
      total_results: result.data.raw_result_count,
      raw_result_count: result.data.raw_result_count,
      filtered_result_count: result.data.filtered_result_count,
      visible_result_count: visibleResultCount,
      hidden_duplicates: scannedRows.filter((row) => row.hidden).length,
      mcp_failed_count: 0,
      errors: result.data.warnings,
      result_state: resultState,
      error_message: null,
      failed_tool: null,
      request_params: result.data.request_params,
      raw_response_summary: result.data.raw_response_summary,
    };
    setRuns(upsertDiscoveryRun(finished));
    saveDiscoveryResults(finished.id, scannedRows.map((row) => rowToDiscoveryResult(row, finished.id)));
    const scanRecord = buildCategoryScanRecord(targetSelection, finished, scannedRows, existingScan);
    setCategoryScanMap(recordsToMap(upsertCategoryScanRecord(scanRecord)));
    if (options.updateDisplay) {
      setRows(scannedRows);
      setWarnings(result.data.warnings);
      if (resultState === 'raw_empty') {
        setNotice('MCP 请求成功，但原始返回 0 条。建议换相邻节点、放宽条件，或确认该 L3/L4 节点是否需要先加载更细子类目。');
      } else if (resultState === 'filtered_empty') {
        setNotice(`MCP 原始返回 ${result.data.raw_result_count} 条，但本地筛选/历史去重后 0 条。可以点击“放宽筛选重扫”。`);
      } else {
        setNotice(`当前类目原始返回 ${result.data.raw_result_count} 条，筛选后 ${visibleResultCount} 条。关键词与 PPC 可在保存候选后继续 MCP 验证。`);
      }
    }
    return { ok: true, run: finished, rows: scannedRows, scanRecord, message: '' };
  };

  const runDiscovery = async () => {
    if (!selection) {
      setErrors(['请先选择一个 Amazon 类目节点。']);
      return;
    }
    const existingScan = categoryScanMap[selection.node_id];
    if (existingScan?.scan_status === 'blacklisted') {
      if (!window.confirm('该节点已被标记为风险类目/已拉黑，默认不建议扫描。确定要高级强制扫描吗？')) return;
    } else if (existingScan && !isCategoryScanDue(existingScan)) {
      const lastScan = existingScan.last_scan_at ? new Date(existingScan.last_scan_at).toLocaleString() : '未知时间';
      const nextScan = existingScan.next_scan_at ? new Date(existingScan.next_scan_at).toLocaleString() : '未设置';
      if (!window.confirm(`该节点已于 ${lastScan} 扫描过，当前状态：${categoryScanStatusLabel(existingScan)}，建议下次复扫时间：${nextScan}。\n\n确定=强制复扫，取消=取消。`)) return;
    }
    if (!selection.is_leaf && !window.confirm('建议选择更细的小类目，当前为上级类目，结果可能过宽。是否继续？')) return;
    if (!window.confirm(`本次将通过卖家精灵 MCP 按类目找品，可能消耗额度。每次最多返回 ${Math.min(filters.limit, 50)} 个候选。是否继续？`)) return;

    setLoading(true);
    const outcome = await executeDiscoveryScan(selection, { ...filters, limit: Math.min(filters.limit, 50) }, { updateDisplay: true });
    setLoading(false);
    if (outcome.ok) scrollToResults();
  };

  const updateBatchConfig = <K extends keyof BatchScanConfig>(key: K, value: BatchScanConfig[K]) => {
    setBatchConfig((current) => ({
      ...current,
      [key]: key === 'maxNodes'
        ? Math.max(1, Math.min(20, Number(value)))
        : key === 'perNodeLimit'
          ? Math.max(1, Math.min(50, Number(value)))
          : key === 'intervalSeconds'
            ? Math.max(1, Math.min(3, Number(value)))
            : value,
    }));
  };

  const buildBatchPreview = (mode: BatchScanMode) => {
    if (!selection) {
      setErrors(['请先选择一个 Amazon 类目节点。']);
      return;
    }
    const selectedNode = findCategoryNode(categoryNodes, selection.node_id);
    if (!selectedNode) {
      setErrors(['当前选中节点不在已加载类目树缓存中。请先在左侧展开/加载该节点后再批量扫描。']);
      return;
    }
    const baseNodes = mode === 'children'
      ? sortCategoryNodes(selectedNode.children ?? [])
      : sortCategoryNodes(collectDescendantNodes(selectedNode).filter((node) => nodeMatchesBatchLevel(node, batchConfig.targetLevel)));
    if (!baseNodes.length) {
      setErrors([mode === 'children'
        ? '当前节点还没有已加载的子节点。请先点击左侧“加载/展开”下级类目。'
        : `当前已加载子树里没有 ${batchLevelLabel(batchConfig.targetLevel)} 节点。请先展开更多下级类目。`]);
      return;
    }

    let skippedScanned = 0;
    let skippedCooling = 0;
    let skippedLeaf = 0;
    let skippedBlacklisted = 0;
    const eligible = baseNodes.filter((node) => {
      const record = categoryScanMap[node.node_id];
      if (batchConfig.leafOnly && !node.is_leaf) {
        skippedLeaf += 1;
        return false;
      }
      if (record?.scan_status === 'blacklisted') {
        skippedBlacklisted += 1;
        return false;
      }
      if (record && batchConfig.skipCooling && !isCategoryScanDue(record)) {
        skippedCooling += 1;
        return false;
      }
      if (record && batchConfig.onlyUnscanned) {
        skippedScanned += 1;
        return false;
      }
      if (record && batchConfig.skipScanned && record.scan_status !== 'failed') {
        skippedScanned += 1;
        return false;
      }
      return true;
    });

    const preview: BatchPreview = {
      mode,
      targetNodes: eligible.slice(0, batchConfig.maxNodes),
      allCandidateCount: baseNodes.length,
      eligibleBeforeLimit: eligible.length,
      skippedScanned,
      skippedCooling,
      skippedLeaf,
      skippedBlacklisted,
    };
    setBatchPreview(preview);
    setBatchSummary(null);
    setErrors([]);
    setNotice(`已生成批量扫描预览：将扫描 ${preview.targetNodes.length} 个节点，预计 MCP 请求 ${preview.targetNodes.length} 次。`);
  };

  const waitIfPausedOrCancelled = async () => {
    while (batchControlRef.current.paused && !batchControlRef.current.cancelled) {
      await sleep(250);
    }
    return batchControlRef.current.cancelled;
  };

  const startBatchScan = async () => {
    if (!batchPreview?.targetNodes.length) {
      setErrors(['没有可扫描的子节点。请先生成预览，或调整跳过规则/目标层级。']);
      return;
    }
    if (!window.confirm(`父节点扫描不等于自动扫描所有子节点。\n\n本次将按指定层级逐个扫描 ${batchPreview.targetNodes.length} 个节点，预计 MCP 请求 ${batchPreview.targetNodes.length} 次，每个节点最多返回 ${batchConfig.perNodeLimit} 条。\n\n是否继续？`)) return;

    batchControlRef.current = { cancelled: false, paused: false };
    const summary: BatchSummary = {
      scannedNodes: 0,
      successNodes: 0,
      failedNodes: 0,
      rawResults: 0,
      filteredResults: 0,
      A_count: 0,
      A_candidate_count: 0,
      B_count: 0,
      C_count: 0,
      D_count: 0,
      E_count: 0,
      testableCount: 0,
      recommendedNodes: [],
    };
    setBatchSummary(null);
    setBatchProgress({ running: true, paused: false, current: 0, total: batchPreview.targetNodes.length, currentNodeName: '' });
    setLoading(true);
    setErrors([]);

    const batchFilters = { ...filters, limit: batchConfig.perNodeLimit };
    let lastRows: DiscoveryRow[] = [];
    for (let index = 0; index < batchPreview.targetNodes.length; index += 1) {
      const node = batchPreview.targetNodes[index];
      if (await waitIfPausedOrCancelled()) break;
      setBatchProgress((current) => ({ ...current, current: index + 1, currentNodeName: node.name }));
      const targetSelection = selectionFromNode(node);
      setSelection(targetSelection);
      saveSelection(targetSelection);
      const outcome = await executeDiscoveryScan(targetSelection, batchFilters, { updateDisplay: true });
      summary.scannedNodes += 1;
      if (outcome.ok) summary.successNodes += 1;
      else summary.failedNodes += 1;
      summary.rawResults += outcome.run.raw_result_count ?? outcome.run.total_results ?? 0;
      summary.filteredResults += outcome.run.visible_result_count ?? 0;
      summary.A_count += outcome.scanRecord.A_count;
      summary.A_candidate_count += outcome.scanRecord.A_candidate_count;
      summary.B_count += outcome.scanRecord.B_count;
      summary.C_count += outcome.scanRecord.C_count;
      summary.D_count += outcome.scanRecord.D_count;
      summary.E_count += outcome.scanRecord.E_count;
      summary.testableCount += outcome.scanRecord.testable_count;
      if (outcome.scanRecord.A_count + outcome.scanRecord.A_candidate_count + outcome.scanRecord.B_count > 0) {
        summary.recommendedNodes.push(`${node.name}（可测 ${outcome.scanRecord.testable_count} 条）`);
      }
      lastRows = outcome.rows;
      if (index < batchPreview.targetNodes.length - 1) {
        await sleep(batchConfig.intervalSeconds * 1000);
      }
    }

    setLoading(false);
    setBatchSummary(summary);
    setBatchProgress({ running: false, paused: false, current: summary.scannedNodes, total: batchPreview.targetNodes.length, currentNodeName: '' });
    if (lastRows.length) setRows(lastRows);
    setNotice(`批量扫描完成：成功 ${summary.successNodes} 个，失败 ${summary.failedNodes} 个，可测试产品 ${summary.testableCount} 个。`);
    scrollToResults();
  };

  const pauseBatchScan = () => {
    batchControlRef.current.paused = !batchControlRef.current.paused;
    setBatchProgress((current) => ({ ...current, paused: batchControlRef.current.paused }));
  };

  const cancelBatchScan = () => {
    batchControlRef.current.cancelled = true;
    setNotice('已请求取消批量扫描：当前节点完成后会停止。');
  };

  const persistCandidate = (
    row: DiscoveryRow,
    decisionStatus: NonNullable<McpCandidateRecord['decision_status']> = 'candidate',
    note = '',
    quiet = false,
  ) => {
    const existing = candidates.find((candidate) => candidate.asin === row.discovered.asin);
    if (row.duplicate_status.includes('launched') || existing?.decision_status === 'launched') {
      window.alert('该 ASIN 已在已上架记录中，建议不要重复开发。');
      return null;
    }
    if ((row.duplicate_status.includes('already_developed') || existing?.decision_status === 'developed') && decisionStatus === 'candidate') {
      window.alert('该产品已开发，建议不要重复开发。');
      return null;
    }
    if ((row.duplicate_status.includes('already_rejected') || existing?.decision_status === 'rejected') && decisionStatus === 'candidate') {
      if (!window.confirm(`该产品已有放弃记录：${existing?.notes || '未写原因'}。是否恢复为候选？`)) return null;
    } else if (existing && decisionStatus === 'candidate' && !quiet) {
      if (!window.confirm('该产品已在候选记录中，是否用当前类目扫描结果更新？')) return null;
    }

    const nextProducts = upsertDiscoveryProduct(products, row.discovered, decisionStatus === 'candidate');
    const savedProduct = nextProducts.find((product) => product.asin === row.discovered.asin);
    if (!savedProduct) return null;
    let nextCandidates = upsertDiscoveryCandidate({
      candidates,
      product: savedProduct,
      discovered: row.discovered,
      runId: row.run_id ?? currentRunId,
      duplicateStatus: row.duplicate_status,
      notes: note || existing?.notes || '',
      decisionStatus,
    });
    if (decisionStatus !== 'candidate') nextCandidates = updateCandidateDecisionStatus(nextCandidates, row.discovered.asin, decisionStatus, note);
    onProductsChange(nextProducts);
    setCandidates(nextCandidates);
    if (decisionStatus === 'candidate') {
      const runId = row.run_id ?? currentRunId;
      markDiscoveryResultAsCandidate(runId, row.discovered.asin);
      setRows((current) => current.map((item) => item.discovered.asin === row.discovered.asin ? { ...item, saved_as_candidate: true } : item));
      if (!existing && !row.saved_as_candidate && runId) setRuns(updateDiscoveryRunSavedCandidates(runId, 1));
    }
    if (!quiet) setNotice(decisionStatus === 'candidate' ? `已保存 ${row.discovered.asin} 为候选。` : `已更新 ${row.discovered.asin} 状态。`);
    return { nextProducts, nextCandidates };
  };

  const saveVisibleCandidates = () => {
    const saveable = visibleRows.filter(
      (row) => !row.duplicate_status.some((status) => ['already_developed', 'already_rejected', 'launched'].includes(status)),
    );
    if (!saveable.length) {
      setNotice('当前没有可直接批量保存的候选。已开发、已放弃和已上架产品需要逐条处理。');
      return;
    }
    if (!window.confirm(`将把当前显示的 ${saveable.length} 个结果保存为候选，不会再调用 MCP。是否继续？`)) return;
    let nextProducts = products;
    let nextCandidates = candidates;
    const currentIds = new Set(saveable.map((row) => row.discovered.asin));
    const newlySavedCount = saveable.filter((row) => !row.saved_as_candidate).length;
    saveable.forEach((row) => {
      nextProducts = upsertDiscoveryProduct(nextProducts, row.discovered, true);
      const savedProduct = nextProducts.find((product) => product.asin === row.discovered.asin);
      if (!savedProduct) return;
      nextCandidates = upsertDiscoveryCandidate({
        candidates: nextCandidates,
        product: savedProduct,
        discovered: row.discovered,
        runId: row.run_id ?? currentRunId,
        duplicateStatus: row.duplicate_status,
        decisionStatus: 'candidate',
      });
      markDiscoveryResultAsCandidate(row.run_id ?? currentRunId, row.discovered.asin);
    });
    onProductsChange(nextProducts);
    setCandidates(nextCandidates);
    setRows((current) => current.map((row) => currentIds.has(row.discovered.asin) ? { ...row, saved_as_candidate: true } : row));
    if (currentRunId && newlySavedCount) setRuns(updateDiscoveryRunSavedCandidates(currentRunId, newlySavedCount));
    setNotice(`已保存 ${saveable.length} 个当前类目候选。`);
  };

  const rejectRow = (row: DiscoveryRow) => {
    const note = window.prompt('写下放弃原因，方便历史去重时提示。', '') ?? '';
    persistCandidate(row, 'rejected', note);
  };

  const developRow = (row: DiscoveryRow) => {
    if (!window.confirm('将该产品标记为已开发并加入开发记录，是否继续？')) return;
    if (persistCandidate(row, 'developed')) onOpenDevelopment();
  };

  const exportRows = () => {
    const baseRows = currentRunId
      ? rowsFromDiscoveryResults(getDiscoveryResultsByRunId(currentRunId), products, filters)
      : visibleRows;
    const exportVisibleRows = sortDiscoveryRows(
      baseRows.filter((row) => !row.hidden && matchLayerQuickFilter(row, layerQuickFilter) && matchAgeQuickFilter(row.discovered, ageQuickFilter)),
      sortMode,
    );
    exportDiscoveryRows(currentRunId, exportVisibleRows, filters);
  };

  const exportRunResults = (run: DiscoveryRun) => {
    const runRows = rowsFromDiscoveryResults(getDiscoveryResultsByRunId(run.id), products, run.filters);
    if (!runRows.length) {
      window.alert('该任务没有保存到找品结果，可能是旧版本任务或结果已删除。请重新按当前类目找品后再导出。');
      return;
    }
    exportDiscoveryRows(run.id, runRows.filter((row) => !row.hidden), run.filters);
  };

  const restoreRun = (run: DiscoveryRun) => {
    const results = getDiscoveryResultsByRunId(run.id);
    if (!results.length) {
      const message = '该任务没有保存到找品结果，可能是旧版本任务或结果已删除。请重新按当前类目找品。';
      setErrors([message]);
      setNotice(message);
      window.alert(message);
      return;
    }
    const restoredRows = rowsFromDiscoveryResults(results, products, run.filters);
    setRows(restoredRows);
    setCurrentRunId(run.id);
    setFilters(run.filters);
    setSelection(selectionFromRun(run));
    setLayerQuickFilter('all');
    setAgeQuickFilter('all');
    setErrors([]);
    setWarnings(run.errors);
    setNotice(`已恢复找品结果：${run.category_path}，返回 ${results.length} 条，当前展示 ${restoredRows.filter((row) => !row.hidden).length} 条。`);
    scrollToResults();
  };

  const deleteRun = (runId: string) => {
    if (!window.confirm('删除后将无法恢复本次找品结果，是否继续？')) return;
    const nextRuns = deleteDiscoveryRun(runId);
    setRuns(nextRuns);
    if (currentRunId === runId) {
      setRows([]);
      setCurrentRunId(null);
    }
    setNotice('已删除本次任务和对应找品结果。');
  };

  const clearCurrentDisplay = () => {
    setRows([]);
    setNotice('已清空当前页面显示，历史任务结果仍可从最近任务记录恢复。');
  };

  const deleteCurrentResult = () => {
    if (!currentRunId) {
      setNotice('当前没有已加载的任务结果可删除。');
      return;
    }
    deleteRun(currentRunId);
  };

  const relaxFiltersForRescan = () => {
    setFilters((current) => ({
      ...current,
      monthly_sales_min: 0,
      monthly_sales_max: Math.max(current.monthly_sales_max, 1000),
      review_count_max: Math.max(current.review_count_max, 1000),
      listing_range_days: null,
      listed_days_min: 0,
      strict_rating_filter_enabled: false,
    }));
    setNotice('已放宽月销量、评论数、上架时间和低评分硬过滤。请再次点击扫描/复扫当前类目。');
  };

  return (
    <div className={`discovery-layout ${categoryCollapsed ? 'category-collapsed-layout' : ''}`}>
      <AmazonCategoryTree
        selected={selection}
        onSelect={chooseCategory}
        refreshToken={refreshToken}
	        collapsed={categoryCollapsed}
	        onCollapsedChange={updateCategoryCollapsed}
	        scanRecords={categoryScanMap}
	        onNodesChange={setCategoryNodes}
	      />
      <div className="discovery-main">
        <section className="content-section">
          <div className="section-heading">
            <h2>MCP 按类目找品</h2>
            <p>第一页只做当前节点小样本扫描，不自动翻页，不递归所有子类目。</p>
          </div>
          <SelectedCategoryBar selection={selection} scanRecord={selectedScanRecord} />
          <div className="filter-grid compact-filter-grid">
            <ReadOnlyField label="站点" value="US" />
            <Field label="关键词，可选" value={filters.keyword_optional} onChange={(value) => setFilters((current) => ({ ...current, keyword_optional: value }))} />
            <NumberField label="每次最多返回数量" value={filters.limit} max="50" onChange={(value) => updateNumber('limit', value)} />
            <NumberField label="价格下限" value={filters.price_min} onChange={(value) => updateNumber('price_min', value)} />
            <NumberField label="价格上限" value={filters.price_max} onChange={(value) => updateNumber('price_max', value)} />
            <NumberField label="月销量下限" value={filters.monthly_sales_min} onChange={(value) => updateNumber('monthly_sales_min', value)} />
            <NumberField label="月销量上限" value={filters.monthly_sales_max} onChange={(value) => updateNumber('monthly_sales_max', value)} />
            <NumberField label="评论数上限" value={filters.review_count_max} onChange={(value) => updateNumber('review_count_max', value)} />
            <label>
              低评分风险线
              <input type="number" value={filters.rating_min} min="0" step="0.1" onChange={(event) => updateNumber('rating_min', event.target.value)} />
              <small>0评价/无评分产品不按评分过滤；仅当产品已有一定评论数时，低评分才作为风险过滤。</small>
            </label>
            <SelectField
              label="上架时间范围"
              value={filters.listing_range_days === null ? 'unlimited' : String(filters.listing_range_days)}
              options={[
                ['30', '最近30天'],
                ['90', '最近90天'],
                ['180', '最近180天'],
                ['365', '最近365天'],
                ['unlimited', '不限制'],
              ]}
              onChange={updateListingRange}
            />
            <NumberField label="上架天数下限" value={filters.listed_days_min} onChange={(value) => updateNumber('listed_days_min', value)} />
            <NumberField label="上架天数上限" value={filters.listed_days_max} onChange={(value) => updateNumber('listed_days_max', value)} />
          </div>
          <p className="helper-copy">建议优先筛选最近 30-365 天上架且已有基础销量的产品，避免老链接历史权重干扰。</p>
	          <div className="toggle-grid">
	            <Check label="是否优先新品" checked={filters.prioritize_recent} onChange={(checked) => setFilters((current) => ({ ...current, prioritize_recent: checked }))} />
	            <Check label="严格过滤低评分产品" checked={filters.strict_rating_filter_enabled} onChange={(checked) => setFilters((current) => ({ ...current, strict_rating_filter_enabled: checked }))} />
	            <Check label="只扫叶子类目" checked={filters.leaf_only} onChange={(checked) => setFilters((current) => ({ ...current, leaf_only: checked }))} />
	            <Check label="排除历史已选/已放弃/已开发" checked={filters.exclude_history} onChange={(checked) => setFilters((current) => ({ ...current, exclude_history: checked }))} />
	            <Check label="隐藏同父体重复" checked={filters.hide_parent_duplicates} onChange={(checked) => setFilters((current) => ({ ...current, hide_parent_duplicates: checked }))} />
	            <Check label="隐藏疑似同款" checked={filters.hide_similar_products} onChange={(checked) => setFilters((current) => ({ ...current, hide_similar_products: checked }))} />
	          </div>
	          <div className="batch-scan-panel">
	            <div className="section-heading compact-heading">
	              <h3>受控批量扫描子节点</h3>
	              <p>父节点扫描不等于自动扫描所有子节点。批量扫描会按指定层级逐个节点扫描，默认最多 5 个节点。</p>
	            </div>
	            <div className="batch-config-grid">
	              <label>
	                目标层级
	                <select value={batchConfig.targetLevel} onChange={(event) => updateBatchConfig('targetLevel', event.target.value as BatchTargetLevel)}>
	                  <option value="L2">L2</option>
	                  <option value="L3">L3</option>
	                  <option value="L4">L4</option>
	                  <option value="L5">L5</option>
	                  <option value="leaf">叶子类目</option>
	                </select>
	              </label>
	              <NumberField label="最大扫描节点数" value={batchConfig.maxNodes} max="20" onChange={(value) => updateBatchConfig('maxNodes', Number(value))} />
	              <NumberField label="每个节点返回数量" value={batchConfig.perNodeLimit} max="50" onChange={(value) => updateBatchConfig('perNodeLimit', Number(value))} />
	              <NumberField label="扫描间隔（秒）" value={batchConfig.intervalSeconds} max="3" onChange={(value) => updateBatchConfig('intervalSeconds', Number(value))} />
	            </div>
	            <div className="toggle-grid batch-toggle-grid">
	              <Check label="跳过已扫描节点" checked={batchConfig.skipScanned} onChange={(checked) => updateBatchConfig('skipScanned', checked)} />
	              <Check label="跳过冷却中节点" checked={batchConfig.skipCooling} onChange={(checked) => updateBatchConfig('skipCooling', checked)} />
	              <Check label="只扫未扫描节点" checked={batchConfig.onlyUnscanned} onChange={(checked) => updateBatchConfig('onlyUnscanned', checked)} />
	              <Check label="只扫叶子类目" checked={batchConfig.leafOnly} onChange={(checked) => updateBatchConfig('leafOnly', checked)} />
	            </div>
	            <div className="action-row batch-actions">
	              <button className="secondary-button" type="button" onClick={() => buildBatchPreview('children')} disabled={!selection || batchProgress.running}>
	                扫描当前节点子节点
	              </button>
	              <button className="secondary-button" type="button" onClick={() => buildBatchPreview('level')} disabled={!selection || batchProgress.running}>
	                批量扫描指定层级
	              </button>
	              {batchPreview && (
	                <button className="primary-button" type="button" onClick={startBatchScan} disabled={!batchPreview.targetNodes.length || batchProgress.running}>
	                  开始批量扫描
	                </button>
	              )}
	              {batchProgress.running && (
	                <>
	                  <button className="secondary-button" type="button" onClick={pauseBatchScan}>
	                    {batchProgress.paused ? '继续扫描' : '暂停扫描'}
	                  </button>
	                  <button className="secondary-button danger-button" type="button" onClick={cancelBatchScan}>
	                    取消批量扫描
	                  </button>
	                </>
	              )}
	            </div>
	            {batchPreview && (
	              <div className="batch-preview-card">
	                <strong>批量扫描预览：{batchPreview.mode === 'children' ? '当前节点子节点' : batchLevelLabel(batchConfig.targetLevel)}</strong>
	                <p>
	                  即将扫描 {batchPreview.targetNodes.length} 个节点；候选节点 {batchPreview.allCandidateCount} 个，跳过已扫 {batchPreview.skippedScanned} 个，
	                  跳过冷却 {batchPreview.skippedCooling} 个，跳过非叶子 {batchPreview.skippedLeaf} 个，跳过拉黑 {batchPreview.skippedBlacklisted} 个。
	                  预计 MCP 请求 {batchPreview.targetNodes.length} 次。
	                </p>
	                <div className="batch-node-list">
	                  {batchPreview.targetNodes.map((node) => (
	                    <span key={node.node_id} title={node.path}>{node.name}</span>
	                  ))}
	                </div>
	                {batchPreview.eligibleBeforeLimit > batchPreview.targetNodes.length && <p className="helper-copy">还有 {batchPreview.eligibleBeforeLimit - batchPreview.targetNodes.length} 个符合条件节点未纳入本次扫描，可调高最大扫描节点数。</p>}
	              </div>
	            )}
	            {batchProgress.running && (
	              <div className="batch-progress-card">
	                <strong>扫描进度：{batchProgress.current} / {batchProgress.total}</strong>
	                <span>{batchProgress.paused ? '已暂停' : `当前节点：${batchProgress.currentNodeName || '准备中'}`}</span>
	              </div>
	            )}
	            {batchSummary && (
	              <div className="batch-summary-card">
	                <strong>批量扫描汇总</strong>
	                <p>
	                  扫描 {batchSummary.scannedNodes} 个节点，成功 {batchSummary.successNodes} 个，失败 {batchSummary.failedNodes} 个；
	                  原始返回 {batchSummary.rawResults} 条，筛选后 {batchSummary.filteredResults} 条，可测试 {batchSummary.testableCount} 条。
	                </p>
	                <p>A {batchSummary.A_count} / A候选 {batchSummary.A_candidate_count} / B {batchSummary.B_count} / C {batchSummary.C_count} / D {batchSummary.D_count} / E {batchSummary.E_count}</p>
	                <p>推荐继续深挖：{batchSummary.recommendedNodes.length ? batchSummary.recommendedNodes.join('、') : '暂无，建议换相邻节点或放宽筛选。'}</p>
	              </div>
	            )}
	          </div>
	          <div className="action-row">
	            <button className="primary-button" type="button" onClick={runDiscovery} disabled={loading}>
	              {loading ? '找品中' : categoryScanButtonLabel(selectedScanRecord)}
            </button>
            <button className="secondary-button" type="button" onClick={clearCurrentDisplay}>清空当前显示</button>
            <button className="secondary-button danger-button" type="button" onClick={deleteCurrentResult} disabled={!currentRunId}>删除本次结果</button>
            <button
              className="secondary-button"
              type="button"
              onClick={relaxFiltersForRescan}
              disabled={
                !(
                  currentRun && ['raw_empty', 'filtered_empty'].includes(currentRun.result_state ?? '')
                ) && selectedScanRecord?.scan_status !== 'filtered_empty'
              }
            >
              放宽筛选重扫
            </button>
            <button className="secondary-button" type="button" onClick={saveVisibleCandidates} disabled={!visibleRows.length}>保存候选</button>
            <button className="secondary-button" type="button" onClick={exportRows} disabled={!visibleRows.length}>导出当前结果</button>
          </div>
          {notice && <p className="save-notice">{notice}</p>}
          {warnings.length > 0 && <div className="warning-list">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
          {errors.length > 0 && <div className="error-box">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
        </section>

        <section className="content-section" ref={resultsSectionRef}>
          <div className="section-heading">
            <h2>找品结果</h2>
            <p>首轮按类目看低评论出单、价格带、平台毛利与历史去重；无关键词时广告分保持中性并标记待确认。</p>
          </div>
          {rows.length > 0 && (
            <p className="helper-copy">
              当前加载 {rows.length} 条结果，显示 {visibleRows.length} 条；隐藏项来自历史去重、同父体重复或快捷筛选。
            </p>
          )}
          <div className="result-filter-panel discovery-result-controls">
            <div className="filter-chip-row result-filter-primary" aria-label="机会等级筛选">
              <span>主筛选：机会等级</span>
              {layerFilterOptions.map(([value, label]) => (
                <button
                  className={layerQuickFilter === value ? 'primary-button' : 'secondary-button'}
                  key={value}
                  type="button"
                  onClick={() => setLayerQuickFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="filter-chip-row result-filter-secondary" aria-label="上架时间辅助筛选">
              <span>辅助：上架时间</span>
              {ageFilterOptions.map(([value, label]) => (
                <button
                  className={ageQuickFilter === value ? 'secondary-button filter-button-active' : 'secondary-button'}
                  key={value}
                  type="button"
                  onClick={() => setAgeQuickFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="result-sort-control">
              排序
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as ResultSortMode)}>
                {sortOptions.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <p className="helper-copy">
              当前主筛选：{layerFilterLabel(layerQuickFilter)}；辅助时间筛选：{ageFilterLabel(ageQuickFilter)}；排序：{sortLabel(sortMode)}。
            </p>
          </div>
          {!rows.length ? (
            <div className="empty-state">还没有类目扫描结果。</div>
          ) : !visibleRows.length ? (
            <div className="empty-state">当前机会等级和上架时间筛选下没有结果。</div>
          ) : (
            <div className="table-wrap discovery-table">
              <table>
                <colgroup>
                  <col className="col-asin" />
                  <col className="col-image" />
                  <col className="col-title" />
                  <col className="col-price" />
                  <col className="col-sales" />
                  <col className="col-reviews" />
                  <col className="col-age" />
                  <col className="col-new-score" />
                  <col className="col-listing-score" />
                  <col className="col-total-score" />
                  <col className="col-layer" />
                  <col className="col-action-advice" />
                  <col className="col-signal" />
                  <col className="col-brand" />
                  <col className="col-category" />
                  <col className="col-source" />
                  <col className="col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>ASIN</th>
                    <th>主图</th>
                    <th>标题</th>
                    <th>价格</th>
                    <th>月销量</th>
                    <th>有效评论数</th>
                    <th>上架天数</th>
                    <th>新品动销分</th>
                    <th>铺货测试分</th>
                    <th>综合评分</th>
                    <th>分层</th>
                    <th>动作建议</th>
                    <th>新品动销信号</th>
                    <th>品牌</th>
                    <th>类目路径</th>
                    <th>来源节点</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedVisibleRows.map((group) => (
                    <Fragment key={group.key}>
                      {layerQuickFilter === 'all' && (
                        <tr className={`result-group-row result-group-${group.key}`} key={`${group.key}-heading`}>
                          <td colSpan={17}>
                            <strong>机会分层：{group.label}</strong>
                            <span>{group.rows.length} 条</span>
                          </td>
                        </tr>
                      )}
                      {group.rows.map((row) => (
                        <ResultRow
                          key={row.discovered.asin}
                          row={row}
                          onSave={() => persistCandidate(row)}
                          onDetail={() => {
                            if (persistCandidate(row, 'candidate', '', true)) {
                              onOpenReview(row.discovered.asin, {
                                sourceList: visibleRows.map((item) => item.discovered.asin),
                                currentIndex: visibleRows.findIndex((item) => item.discovered.asin === row.discovered.asin),
                              });
                            }
                          }}
                          onValidate={() => onSendToValidation(row.discovered.asin, validationSeed(row, true))}
                          onQueryLongTail={() => onSendToValidation(row.discovered.asin, validationSeed(row, true, true))}
                          onViewKeywords={() => window.alert(keywordOpportunityText(row))}
                          onReview={() => {
                            if (persistCandidate(row, 'candidate', '', true)) {
                              onOpenReview(row.discovered.asin, {
                                sourceList: visibleRows.map((item) => item.discovered.asin),
                                currentIndex: visibleRows.findIndex((item) => item.discovered.asin === row.discovered.asin),
                              });
                            }
                          }}
                          onDevelop={() => developRow(row)}
                          onReject={() => rejectRow(row)}
                        />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="content-section">
          <div className="section-heading">
            <h2>最近类目找品任务</h2>
            <p>这里只记录手动类目扫描，不会自动继续翻页。</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类目路径</th>
                  <th>状态</th>
                  <th>原始返回</th>
                  <th>筛选后</th>
                  <th>隐藏重复</th>
	                  <th>保存候选</th>
	                  <th>已存结果</th>
	                    <th>MCP失败</th>
                    <th>失败/请求信息</th>
	                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                {runs.slice(0, 8).map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.started_at).toLocaleString()}</td>
                    <td>{run.category_path}</td>
                    <td><span className={`result-badge ${runStateTone(run)}`}>{runStateLabel(run)}</span></td>
	                    <td>{run.raw_result_count ?? run.total_results}</td>
	                    <td>{run.visible_result_count ?? storedResultCounts[run.id] ?? 0}</td>
	                    <td>{run.hidden_duplicates}</td>
	                    <td>{run.saved_candidates}</td>
	                    <td>{storedResultCounts[run.id] ?? 0}</td>
	                    <td>{run.mcp_failed_count ?? (run.status === 'failed' ? run.errors.length || 1 : run.errors.length)}</td>
                    <td>
                      <span className="result-truncate" title={runDebugTitle(run)}>
                        {runDebugSummary(run)}
                      </span>
                    </td>
                    <td className="table-actions">
                      <button className="secondary-button" type="button" onClick={() => restoreRun(run)}>查看结果</button>
                      {run.result_state === 'filtered_empty' && <button className="secondary-button" type="button" onClick={relaxFiltersForRescan}>放宽筛选</button>}
                      <button className="secondary-button" type="button" onClick={() => exportRunResults(run)}>导出结果</button>
                      <button className="secondary-button danger-button" type="button" onClick={() => deleteRun(run.id)}>删除任务</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

const layerFilterOptions: Array<[LayerQuickFilter, string]> = [
  ['all', '全部'],
  ['A', 'A 优先开发'],
  ['A_candidate', 'A候选'],
  ['B', 'B 价格测试'],
  ['C', 'C 观察复核'],
  ['D', 'D 竞争偏高'],
  ['E', 'E 放弃'],
  ['review', '待复核'],
];

const ageFilterOptions: Array<[AgeQuickFilter, string]> = [
  ['all', '不限时间'],
  ['30', '最近30天'],
  ['90', '最近90天'],
  ['180', '最近180天'],
  ['365', '最近365天'],
  ['exclude_old', '排除365天以上老品'],
  ['missing', '上架时间缺失'],
];

const sortOptions: Array<[ResultSortMode, string]> = [
  ['opportunity', '机会优先'],
  ['listing_test_desc', '铺货测试分高到低'],
  ['score_desc', '综合评分高到低'],
  ['new_sales_signal_desc', '新品动销分高到低'],
  ['low_review_desc', '低评论出单分高到低'],
  ['age_asc', '上架时间新到旧'],
  ['monthly_sales_desc', '月销量高到低'],
  ['review_count_asc', '评论少到多'],
  ['platform_margin_desc', '平台后毛利率高到低'],
];

function layerFilterLabel(value: LayerQuickFilter): string {
  return layerFilterOptions.find(([option]) => option === value)?.[1] ?? value;
}

function ageFilterLabel(value: AgeQuickFilter): string {
  return ageFilterOptions.find(([option]) => option === value)?.[1] ?? value;
}

function sortLabel(value: ResultSortMode): string {
  return sortOptions.find(([option]) => option === value)?.[1] ?? value;
}

function runStateLabel(run: DiscoveryRun): string {
  if (run.result_state === 'request_failed' || run.status === 'failed') return 'MCP请求失败';
  if (run.result_state === 'raw_empty') return '原始返回0条';
  if (run.result_state === 'filtered_empty') return '筛选后0条';
  if (run.result_state === 'has_results') return '有结果';
  return run.status === 'loading' ? '查询中' : '已扫描';
}

function runStateTone(run: DiscoveryRun): string {
  if (run.result_state === 'request_failed' || run.status === 'failed') return 'badge-danger';
  if (run.result_state === 'raw_empty') return 'badge-muted';
  if (run.result_state === 'filtered_empty') return 'badge-warning';
  if (run.result_state === 'has_results') return 'badge-success';
  return 'badge-info';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function runDebugTitle(run: DiscoveryRun): string {
  const request = run.request_params ?? {};
  return [
    `node_id: ${run.category_node_id}`,
    `category_path: ${run.category_path}`,
    `marketplace: ${request.marketplace ?? run.marketplace}`,
    `availableMonth: ${String(request.availableMonth ?? '未传')}`,
    `failed_tool: ${run.failed_tool ?? '无'}`,
    `error_message: ${run.error_message ?? '无'}`,
    'request_params:',
    safeJson(request),
    'raw_response_summary:',
    safeJson(run.raw_response_summary),
  ].join('\n');
}

function runDebugSummary(run: DiscoveryRun): string {
  if (run.result_state === 'request_failed' || run.status === 'failed') {
    return `${run.failed_tool ?? 'product_research'}：${run.error_message ?? run.errors[0] ?? '失败原因未返回'}`;
  }
  const request = run.request_params ?? {};
  const month = request.availableMonth ? `availableMonth=${request.availableMonth}` : '上架不限';
  const path = run.raw_response_summary?.detected_items_path ? `path=${run.raw_response_summary.detected_items_path}` : 'path=未识别';
  return `${request.marketplace ?? run.marketplace} / ${month} / ${path}`;
}

function layerRank(row: DiscoveryRow): number {
  const layer = row.product.score.layer;
  if (layer.startsWith('A低')) return 0;
  if (layer.startsWith('A候选')) return 1;
  if (layer.startsWith('B')) return 2;
  if (layer.startsWith('C')) return 3;
  if (layer.startsWith('D')) return 4;
  if (layer.startsWith('待复核')) return 5;
  if (layer.startsWith('E')) return 6;
  return 5;
}

function layerGroupKey(row: DiscoveryRow): LayerQuickFilter {
  const rank = layerRank(row);
  if (rank === 0) return 'A';
  if (rank === 1) return 'A_candidate';
  if (rank === 2) return 'B';
  if (rank === 3) return 'C';
  if (rank === 4) return 'D';
  if (rank === 6) return 'E';
  return 'review';
}

function matchLayerQuickFilter(row: DiscoveryRow, filter: LayerQuickFilter): boolean {
  if (filter === 'all') return true;
  return layerGroupKey(row) === filter;
}

function compareNumberDesc(left: number | null | undefined, right: number | null | undefined): number {
  const leftValue = typeof left === 'number' && Number.isFinite(left) ? left : -Infinity;
  const rightValue = typeof right === 'number' && Number.isFinite(right) ? right : -Infinity;
  return rightValue - leftValue;
}

function compareNumberAscMissingLast(left: number | null | undefined, right: number | null | undefined): number {
  const leftValid = typeof left === 'number' && Number.isFinite(left);
  const rightValid = typeof right === 'number' && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return left - right;
}

function compareOpportunity(left: DiscoveryRow, right: DiscoveryRow): number {
  return (
    layerRank(left) - layerRank(right) ||
    compareNumberDesc(left.product.score.new_product_sales_signal_score.score, right.product.score.new_product_sales_signal_score.score) ||
    compareNumberDesc(left.product.score.listing_test_score.score, right.product.score.listing_test_score.score) ||
    compareNumberDesc(left.discovered.monthly_sales, right.discovered.monthly_sales) ||
    compareNumberAscMissingLast(effectiveReviewCount(left).value, effectiveReviewCount(right).value) ||
    compareNumberDesc(left.product.score.price_margin_score.platform_margin_rate, right.product.score.price_margin_score.platform_margin_rate) ||
    compareNumberDesc(left.product.score.flea_market_score, right.product.score.flea_market_score) ||
    compareNumberAscMissingLast(left.discovered.product_age_days, right.discovered.product_age_days) ||
    compareNumberDesc(left.product.score.low_review_sales_score.score, right.product.score.low_review_sales_score.score)
  );
}

function sortDiscoveryRows(rows: DiscoveryRow[], mode: ResultSortMode): DiscoveryRow[] {
  return [...rows].sort((left, right) => {
    if (mode === 'score_desc') return compareNumberDesc(left.product.score.flea_market_score, right.product.score.flea_market_score) || compareOpportunity(left, right);
    if (mode === 'listing_test_desc') return compareNumberDesc(left.product.score.listing_test_score.score, right.product.score.listing_test_score.score) || compareOpportunity(left, right);
    if (mode === 'new_sales_signal_desc') return compareNumberDesc(left.product.score.new_product_sales_signal_score.score, right.product.score.new_product_sales_signal_score.score) || compareOpportunity(left, right);
    if (mode === 'low_review_desc') return compareNumberDesc(left.product.score.low_review_sales_score.score, right.product.score.low_review_sales_score.score) || compareOpportunity(left, right);
    if (mode === 'age_asc') return compareNumberAscMissingLast(left.discovered.product_age_days, right.discovered.product_age_days) || compareOpportunity(left, right);
    if (mode === 'monthly_sales_desc') return compareNumberDesc(left.discovered.monthly_sales, right.discovered.monthly_sales) || compareOpportunity(left, right);
    if (mode === 'review_count_asc') return compareNumberAscMissingLast(left.discovered.review_count, right.discovered.review_count) || compareOpportunity(left, right);
    if (mode === 'platform_margin_desc') return compareNumberDesc(left.product.score.price_margin_score.platform_margin_rate, right.product.score.price_margin_score.platform_margin_rate) || compareOpportunity(left, right);
    return compareOpportunity(left, right);
  });
}

function groupRowsForDisplay(rows: DiscoveryRow[], layerFilter: LayerQuickFilter): Array<{ key: string; label: string; rows: DiscoveryRow[] }> {
  if (layerFilter !== 'all') return [{ key: layerFilter, label: layerFilterLabel(layerFilter), rows }];
  return layerFilterOptions
    .filter(([key]) => key !== 'all')
    .map(([key, label]) => ({ key, label, rows: rows.filter((row) => layerGroupKey(row) === key) }))
    .filter((group) => group.rows.length > 0);
}

function buildRows(
  discoveredProducts: McpDiscoveredProduct[],
  products: ProductRecord[],
  candidates: McpCandidateRecord[],
  filters: DiscoveryFilters,
  runId: string | null,
): DiscoveryRow[] {
  const parentCounts = discoveredProducts.reduce<Record<string, number>>((counts, item) => {
    if (item.parent_asin) counts[item.parent_asin] = (counts[item.parent_asin] ?? 0) + 1;
    return counts;
  }, {});
  return discoveredProducts.map((discovered) => {
    const statuses = new Set(getDiscoveryDuplicateStatuses(discovered, products, candidates));
    if (discovered.parent_asin && (parentCounts[discovered.parent_asin] ?? 0) > 1) statuses.add('parent_asin_duplicate');
    const duplicateStatus = Array.from(statuses);
    const historyHidden =
      filters.exclude_history &&
      duplicateStatus.some((status) =>
        ['exact_asin_duplicate', 'already_rejected', 'already_developed', 'launched'].includes(status),
      );
    const parentHidden = filters.hide_parent_duplicates && duplicateStatus.includes('parent_asin_duplicate');
    const similarHidden =
      filters.hide_similar_products &&
      duplicateStatus.some((status) => ['similar_title_duplicate', 'possible_same_product'].includes(status));
    return {
      discovered,
      product: createProductFromDiscovery(discovered),
      duplicate_status: duplicateStatus,
      hidden: historyHidden || parentHidden || similarHidden,
      run_id: runId,
      result_id: runId ? `${runId}:${discovered.asin}` : null,
      saved_as_candidate: false,
    };
  });
}

function shouldHideResult(duplicateStatus: DuplicateStatus[], filters: DiscoveryFilters): boolean {
  const historyHidden =
    filters.exclude_history &&
    duplicateStatus.some((status) =>
      ['exact_asin_duplicate', 'already_rejected', 'already_developed', 'launched'].includes(status),
    );
  const parentHidden = filters.hide_parent_duplicates && duplicateStatus.includes('parent_asin_duplicate');
  const similarHidden =
    filters.hide_similar_products &&
    duplicateStatus.some((status) => ['similar_title_duplicate', 'possible_same_product'].includes(status));
  return historyHidden || parentHidden || similarHidden;
}

function rowsFromDiscoveryResults(
  results: DiscoveryResult[],
  products: ProductRecord[],
  filters: DiscoveryFilters,
): DiscoveryRow[] {
  return results.map((result) => {
    const discovered = discoveryResultToProduct(result);
    const existingProduct = products.find((product) => product.asin === result.asin);
    return {
      discovered,
      product: existingProduct ?? createProductFromDiscovery(discovered),
      duplicate_status: result.duplicate_status,
      hidden: shouldHideResult(result.duplicate_status, filters),
      run_id: result.run_id,
      result_id: result.id,
      saved_as_candidate: result.saved_as_candidate,
    };
  });
}

function discoveryResultToProduct(result: DiscoveryResult): McpDiscoveredProduct {
  return {
    asin: result.asin,
    parent_asin: result.parent_asin,
    title: result.title,
    brand: result.brand,
    category: result.category,
    sub_category: null,
    category_node_id: result.category_node_id,
    category_path: result.category_path,
    price: result.price,
    coupon_price: result.coupon_price ?? null,
    monthly_sales: result.monthly_sales,
    monthly_revenue: result.monthly_revenue,
    review_count: result.review_count,
    rating: result.rating,
    bsr: result.bsr,
    fba_fee: result.fba_fee,
    seller: result.seller ?? null,
    seller_type: result.seller_type ?? null,
    is_amazon: String(result.seller_type ?? '').toLowerCase().includes('amazon'),
    variation_count: result.variation_count ?? null,
    product_url: result.product_url ?? null,
    main_image_url: result.main_image_url ?? extractImageUrl(result.raw),
    main_image_source: result.main_image_source ?? (result.main_image_url ? 'mcp' : 'missing'),
    listed_at: result.listed_at,
    launch_date: null,
    first_available_date: null,
    product_age_days: result.product_age_days,
    listed_days: result.product_age_days,
    is_recent_product: typeof result.product_age_days === 'number' && result.product_age_days <= 365,
    recent_product_level: recentLevelFromAge(result.product_age_days),
    source_keyword: result.source_keyword,
    source_type: result.source_type,
    source_node_id: result.category_node_id ?? '',
    source_category_path: result.category_path ?? '',
    discovered_at: result.created_at,
    raw: result.raw && typeof result.raw === 'object'
      ? { ...(result.raw as Record<string, unknown>), main_image_url: result.main_image_url }
      : { main_image_url: result.main_image_url, raw: result.raw },
  };
}

function rowToDiscoveryResult(row: DiscoveryRow, runId: string): DiscoveryResult {
  const score = row.product.score;
  return {
    id: `${runId}:${row.discovered.asin}`,
    run_id: runId,
    asin: row.discovered.asin,
    parent_asin: row.discovered.parent_asin,
    title: row.discovered.title,
    brand: row.discovered.brand,
    category: row.discovered.category,
    category_path: row.discovered.category_path,
    category_node_id: row.discovered.category_node_id ?? row.discovered.source_node_id,
    source_type: row.discovered.source_type,
    source_keyword: row.discovered.source_keyword,
    price: row.discovered.coupon_price ?? row.discovered.price,
    coupon_price: row.discovered.coupon_price,
    monthly_sales: row.discovered.monthly_sales,
    monthly_revenue: row.discovered.monthly_revenue,
    review_count: row.discovered.review_count,
    rating: row.discovered.rating,
    bsr: row.discovered.bsr,
    fba_fee: row.discovered.fba_fee,
    seller: row.discovered.seller,
    seller_type: row.discovered.seller_type,
    variation_count: row.discovered.variation_count,
    product_url: row.discovered.product_url,
    main_image_url: row.discovered.main_image_url ?? extractImageUrl(row.discovered.raw),
    main_image_source: row.discovered.main_image_url || extractImageUrl(row.discovered.raw) ? 'mcp' : 'missing',
    product_age_days: row.discovered.product_age_days,
    listed_at: row.discovered.listed_at ?? row.discovered.launch_date ?? row.discovered.first_available_date,
    sales_per_review: score.low_review_sales_score.sales_per_review,
    new_product_sales_signal: score.new_product_sales_signal_score.signal_label,
    new_product_sales_signal_score: score.new_product_sales_signal_score.score,
    listing_test_score: score.listing_test_score.score,
    action_advice: score.action_advice,
    why_testable: score.listing_test_score.why_testable,
    why_not_e: score.listing_test_score.why_not_e,
    missing_review_items: score.listing_test_score.missing_review_items,
    suitable_small_batch: score.listing_test_score.suitable_small_batch,
    suitable_low_cost_test: score.listing_test_score.suitable_low_cost_test,
    score_explanation: score.new_product_sales_signal_score.explanation,
    action_flags: [
      ...score.new_product_sales_signal_score.action_flags,
      score.action_advice,
      ...score.layer_reasons,
    ],
    platform_margin_rate: score.price_margin_score.platform_margin_rate,
    flea_market_score: score.flea_market_score,
    layer: score.layer,
    duplicate_status: row.duplicate_status,
    risk_flags: score.listing_safety_score.notes,
    data_flags: [
      score.rating_risk_note,
      ...score.new_product_sales_signal_score.explanation,
      ...score.low_bid_ad_score.notes,
      ...score.price_margin_score.notes,
      ...score.final_margin_score.notes,
    ].filter(Boolean),
    saved_as_candidate: row.saved_as_candidate,
    raw: row.discovered.raw,
    created_at: row.discovered.discovered_at,
  };
}

function productImageUrl(product: McpDiscoveredProduct): string | null {
  return product.main_image_url ?? extractImageUrl(product.raw);
}

function recentLevelFromAge(age: number | null): McpDiscoveredProduct['recent_product_level'] {
  if (age === null) return '时间缺失';
  if (age <= 30) return '新品观察';
  if (age <= 180) return '新品优先';
  if (age <= 365) return '稳定新品';
  return '老品';
}

function exportDiscoveryRows(runId: string | null, rows: DiscoveryRow[], filters: DiscoveryFilters) {
  const run = runId ? loadDiscoveryRuns().find((item) => item.id === runId) : null;
  const headers = ['run_id', 'discovery_time', 'category_path', 'category_node_id', 'ASIN', '标题', '品牌', '类目路径', '来源节点', '上架时间', 'product_age_days', 'recent_product_level', 'is_recent_product', '价格', '月销量', '月销售额', '评论数', '评分', 'rating_risk_level', 'rating_risk_note', 'BSR', 'FBA费', 'sales_per_review', 'new_product_sales_signal', 'new_product_sales_signal_score', 'listing_test_score', 'action_advice', 'why_testable', 'why_not_e', 'missing_review_items', 'suitable_small_batch', 'suitable_low_cost_test', 'score_explanation', 'action_flags', 'main_keyword', 'long_tail_keywords', 'long_tail_opportunity_level', 'recommended_sp_keywords', 'rejected_keywords', 'low_bid_ad_score', 'strict_rating_filter_enabled', '铺货捡漏分', '分层', '重复状态', '候选状态'];
  const csv = [
    headers,
    ...rows.map((row) => [
      runId ?? '',
      run?.created_at ?? run?.started_at ?? row.discovered.discovered_at,
      run?.category_path ?? row.discovered.category_path ?? '',
      run?.category_node_id ?? row.discovered.source_node_id,
      row.discovered.asin,
      row.discovered.title ?? '',
      row.discovered.brand ?? '',
      row.discovered.category_path ?? '',
      row.discovered.source_node_id,
      row.discovered.listed_at ?? '',
      row.discovered.product_age_days ?? '',
      row.discovered.recent_product_level,
      row.discovered.is_recent_product,
      row.discovered.price ?? '',
      row.discovered.monthly_sales ?? '',
      row.discovered.monthly_revenue ?? '',
      row.discovered.review_count ?? '',
      row.discovered.rating ?? '',
      row.product.score.rating_risk_level,
      row.product.score.rating_risk_note,
      row.discovered.bsr ?? '',
      row.discovered.fba_fee ?? '',
      row.product.score.low_review_sales_score.sales_per_review ?? '',
      row.product.score.new_product_sales_signal_score.signal_label,
      row.product.score.new_product_sales_signal_score.score,
      row.product.score.listing_test_score.score,
      row.product.score.action_advice,
      row.product.score.listing_test_score.why_testable.join(' | '),
      row.product.score.listing_test_score.why_not_e.join(' | '),
      row.product.score.listing_test_score.missing_review_items.join(' | '),
      row.product.score.listing_test_score.suitable_small_batch ? '是' : '否',
      row.product.score.listing_test_score.suitable_low_cost_test ? '是' : '否',
      row.product.score.new_product_sales_signal_score.explanation.join(' | '),
      row.product.score.new_product_sales_signal_score.action_flags.join(' | '),
      row.product.mcp_snapshot?.main_keyword ?? '',
      (row.product.mcp_snapshot?.long_tail_keywords ?? []).join(' | '),
      row.product.mcp_snapshot?.long_tail_opportunity_level ?? 'unknown',
      (row.product.mcp_snapshot?.recommended_sp_keywords ?? []).join(' | '),
      (row.product.mcp_snapshot?.rejected_keywords ?? []).join(' | '),
      row.product.score.low_bid_ad_score.score,
      filters.strict_rating_filter_enabled,
      row.product.score.flea_market_score,
      row.product.score.layer,
      duplicateLabel(row.duplicate_status),
      row.saved_as_candidate ? '已候选' : '未保存',
    ]),
  ]
    .map((line) => line.map(csvCell).join(','))
    .join('\n');
  downloadCsv(csv, `mcp-category-discovery-${runId ?? Date.now()}.csv`);
}

function SelectedCategoryBar({ selection, scanRecord }: { selection: CategorySelection | null; scanRecord?: CategoryScanRecord }) {
  return (
    <div className="selected-category-bar">
      <div className="selected-category-primary">
        <span>当前选中类目</span>
        <strong>{selection?.name ?? '未选择'}</strong>
      </div>
      <div className="selected-category-path" title={selection?.path ?? '请先从左侧选择'}>
        {selection?.path ?? '请先从左侧选择一个 Amazon 类目节点'}
      </div>
      <div className="selected-category-meta">
        <span>{selection?.node_id ?? '无节点 ID'}</span>
        <span>{selection ? `L${selection.level}` : '无层级'}</span>
        <span>{selection ? (selection.is_leaf ? '叶子类目' : '上级类目') : '未选择'}</span>
        <span>{scanRecord ? categoryScanStatusLabel(scanRecord) : '未扫描'}</span>
      </div>
    </div>
  );
}

function RiskBadge({ text, level }: { text: string; level: ProductRecord['score']['rating_risk_level'] }) {
  const tone =
    level === 'severe_low_rating_risk'
      ? 'badge-danger'
      : level === 'low_rating_risk'
        ? 'badge-warning'
        : level === 'no_rating_opportunity' || level === 'unstable_rating_sample'
          ? 'badge-info'
          : 'badge-success';
  return <span className={`result-badge ${tone}`}>{text}</span>;
}

function LayerBadge({ layer }: { layer: string }) {
  const tone = layer.startsWith('A')
    ? 'badge-success'
    : layer.startsWith('B') || layer.startsWith('C')
      ? 'badge-info'
      : layer.startsWith('E')
        ? 'badge-danger'
        : 'badge-warning';
  return <span className={`result-badge ${tone}`}>{layer}</span>;
}

function ResultRow({
  row,
  onSave,
  onDetail,
  onValidate,
  onQueryLongTail,
  onViewKeywords,
  onReview,
  onDevelop,
  onReject,
}: {
  row: DiscoveryRow;
  onSave: () => void;
  onDetail: () => void;
  onValidate: () => void;
  onQueryLongTail: () => void;
  onViewKeywords: () => void;
  onReview: () => void;
  onDevelop: () => void;
  onReject: () => void;
}) {
  const score = row.product.score;
  const sourceNode = sourceNodeDisplay(row);
  const reviewCount = effectiveReviewCount(row);
  return (
    <tr>
      <td>
        <button className="asin-copy-button" type="button" onClick={() => void navigator.clipboard?.writeText(row.discovered.asin)} title="点击复制 ASIN">
          {row.discovered.asin}
        </button>
      </td>
      <td><ProductThumbnail src={productImageUrl(row.discovered)} asin={row.discovered.asin} title={row.discovered.title} size="table" /></td>
      <td><span className="result-title" title={row.discovered.title ?? ''}>{row.discovered.title ?? '未返回'}</span></td>
      <td>{formatMoney(row.discovered.coupon_price ?? row.discovered.price)}</td>
      <td>{valueLabel(row.discovered.monthly_sales)}</td>
      <td>
        {valueLabel(reviewCount.value)}
        <small className="muted-cell">{reviewCount.source}</small>
      </td>
      <td>
        <span>{listedDayLabel(row.discovered.product_age_days)}</span>
        <small className="muted-cell">{recentProductLabel(row.discovered)}</small>
      </td>
      <td><strong>{score.new_product_sales_signal_score.score}</strong></td>
      <td>
        <strong>{score.listing_test_score.score}</strong>
        <small className="muted-cell" title={score.listing_test_score.why_testable.join('；') || score.listing_test_score.notes.join('；')}>{score.listing_test_score.suitable_small_batch ? '适合小批量' : score.listing_test_score.suitable_low_cost_test ? '可试上架' : '待补数据'}</small>
      </td>
      <td><strong>{score.flea_market_score}</strong></td>
      <td><LayerBadge layer={score.layer} /></td>
      <td><span className="result-badge badge-info">{score.action_advice}</span></td>
      <td>
        <span className="result-badge badge-success">{score.new_product_sales_signal_score.signal_label}</span>
        <small className="muted-cell" title={score.new_product_sales_signal_score.explanation.join('；')}>{score.new_product_sales_signal_score.explanation[0] ?? '待复核'}</small>
      </td>
      <td><span className="result-truncate" title={row.discovered.brand ?? '未返回'}>{row.discovered.brand ?? '未返回'}</span></td>
      <td><span className="result-category-path" title={row.discovered.category_path ?? ''}>{row.discovered.category_path ?? '未返回'}</span></td>
      <td><span className="result-source-node" title={sourceNode.title}>{sourceNode.label}</span></td>
      <td className="table-actions">
        <button className="secondary-button" type="button" onClick={onSave}>保存为候选</button>
        <button className="secondary-button" type="button" onClick={onDetail}>商品详情</button>
        <button className="secondary-button" type="button" onClick={onValidate}>发送到 MCP 验证并生成长尾词</button>
        <button className="secondary-button" type="button" onClick={onQueryLongTail}>查询该品长尾词</button>
        <button className="secondary-button" type="button" onClick={onViewKeywords}>查看关键词机会</button>
        <button className="secondary-button" type="button" onClick={onReview}>加入前台复核池</button>
        <button className="secondary-button" type="button" onClick={onDevelop}>加入开发池</button>
        <button className="secondary-button" type="button" onClick={onReject}>放弃</button>
        <button className="secondary-button" type="button" onClick={() => window.alert(duplicateLabel(row.duplicate_status) || '当前未命中已有历史记录。')}>查看历史记录</button>
      </td>
    </tr>
  );
}

function sourceNodeDisplay(row: DiscoveryRow): { label: string; title: string } {
  const path = row.discovered.source_category_path || row.discovered.category_path || row.discovered.category || '';
  const nodeId = row.discovered.source_node_id || row.discovered.category_node_id || '';
  const labels = path.split('>').map((part) => part.trim()).filter(Boolean);
  const label = labels[labels.length - 1] || (nodeId ? `节点ID：${nodeId.slice(0, 12)}...` : '未返回');
  return {
    label,
    title: nodeId ? `${path || label}\n节点ID：${nodeId}` : path || label,
  };
}

function effectiveReviewCount(row: DiscoveryRow): { value: number | null; source: string } {
  const meta = normalizeEffectiveReviewCount(row.discovered);
  if (meta.effective_review_count !== null) {
    const sourceLabel: Record<typeof meta.review_count_source, string> = {
      ratings: 'ratings',
      reviews: 'reviews',
      raw_review_count: 'review_count',
      missing: '未返回',
    };
    return { value: meta.effective_review_count, source: sourceLabel[meta.review_count_source] };
  }
  return { value: row.discovered.review_count, source: row.discovered.review_count === null ? '未返回' : 'review_count' };
}

function DuplicatePills({ statuses }: { statuses: DuplicateStatus[] }) {
  if (!statuses.length) return <span className="result-badge badge-success">未见过</span>;
  return <>{statuses.map((status) => <span className={`result-badge ${duplicateTone(status)}`} key={status}>{duplicateLabel([status])}</span>)}</>;
}

function duplicateTone(status: DuplicateStatus): string {
  if (status === 'already_developed' || status === 'launched') return 'badge-danger';
  if (status === 'already_rejected') return 'badge-warning';
  if (status === 'parent_asin_duplicate' || status === 'possible_same_product' || status === 'similar_title_duplicate') return 'badge-info';
  return 'badge-muted';
}

function duplicateLabel(statuses: DuplicateStatus[]): string {
  const labels: Record<DuplicateStatus, string> = {
    exact_asin_duplicate: 'ASIN重复',
    parent_asin_duplicate: '同父体重复',
    similar_title_duplicate: '标题相似',
    possible_same_product: '疑似同款',
    already_rejected: '已放弃',
    already_developed: '已开发',
    launched: '已上架',
  };
  return statuses.map((status) => labels[status]).join(' / ');
}

function validationSeed(row: DiscoveryRow, generateLongTail = false, queryLongTail = false) {
  return {
    mainKeyword: row.product.mcp_snapshot?.main_keyword ?? row.discovered.source_keyword ?? undefined,
    title: row.discovered.title ?? undefined,
    category: row.discovered.category_path ?? row.discovered.category ?? undefined,
    generateLongTail,
    queryLongTail,
  };
}

function longTailStatus(product: ProductRecord): string {
  const snapshots = product.mcp_snapshot?.keyword_snapshots ?? [];
  const tailSnapshots = snapshots.filter((snapshot) => snapshot.keyword_type !== 'main');
  if (tailSnapshots.length) return `已查 ${tailSnapshots.length} 个`;
  const prepared = product.mcp_snapshot?.long_tail_keywords?.length ?? 0;
  return prepared ? `已生成 ${prepared} 个待查` : '待生成';
}

function keywordOpportunityText(row: DiscoveryRow): string {
  const snapshot = row.product.mcp_snapshot;
  return [
    `主关键词：${snapshot?.main_keyword || '待生成'}`,
    `长尾词：${snapshot?.long_tail_keywords?.join('、') || '尚未生成'}`,
    `长尾机会：${longTailOpportunityLabel(snapshot?.long_tail_opportunity_level ?? 'unknown')}`,
    `推荐 SP 词：${snapshot?.recommended_sp_keywords?.join('、') || '待查询长尾词后确认'}`,
  ].join('\n');
}

function ratingRiskLabel(level: ProductRecord['score']['rating_risk_level'], rating: number | null): string {
  const labels: Record<ProductRecord['score']['rating_risk_level'], string> = {
    no_rating_opportunity: rating === null ? '评分缺失 / 待前台复核' : '无评分 / 0评价机会',
    unstable_rating_sample: `${rating ?? '评分缺失'} / 少评样本`,
    low_rating_risk: `${rating ?? '评分缺失'} / 低评分风险`,
    severe_low_rating_risk: `${rating ?? '评分缺失'} / 严重低评分风险`,
    normal: `${rating ?? '评分缺失'} / 正常`,
  };
  return labels[level];
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, onChange, max, step = '1' }: { label: string; value: number; onChange: (value: string) => void; max?: string; step?: string }) {
  return <label>{label}<input type="number" value={value} min="0" max={max} step={step} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <label>{label}<input value={value} readOnly /></label>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="checkbox-label"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function formatMoney(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '未返回';
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '待补充';
}

function valueLabel(value: unknown, decimals?: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return decimals === undefined ? String(value) : value.toFixed(decimals);
  return value === null || value === undefined || value === '' ? '未返回' : String(value);
}

function matchAgeQuickFilter(product: McpDiscoveredProduct, filter: AgeQuickFilter): boolean {
  const age = product.product_age_days;
  if (filter === 'all') return true;
  if (filter === 'missing') return age === null;
  if (filter === 'exclude_old') return age === null || age <= 365;
  return age !== null && age <= Number(filter);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未返回';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function listedDayLabel(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}天` : '未返回';
}

function recentProductLabel(product: McpDiscoveredProduct): string {
  if (product.recent_product_level === '老品') return '老链接需复核';
  return product.recent_product_level;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
