import { useEffect, useMemo, useRef, useState } from 'react';
import FrontReviewPanel from './components/FrontReviewPanel';
import ProductThumbnail from './components/ProductThumbnail';
import SidebarNavigation, { type SidebarNavItem } from './components/SidebarNavigation';
import McpDiscoveryPage from './pages/McpDiscoveryPage';
import McpStoreDiscoveryPage from './pages/McpStoreDiscoveryPage';
import McpValidationPage from './pages/McpValidationPage';
import type {
  CandidateDecisionStatus,
  DevelopmentRecord,
  DevelopmentStatus,
  DiscoveryResult,
  FrontReview,
  FrontReviewStatus,
  HistoryRecord,
  KeywordSnapshot,
  McpCandidateRecord,
  McpDiscoveredProduct,
  ProductDecisionResult,
  ProductExcelData,
  ProductRecord,
} from './types/mcp';
import {
  addProductToDevelopment,
  createCandidateRecord,
  createProductFromDiscovery,
  createProductFromExcel,
  deleteCandidatePermanently,
  deleteDevelopmentRecord,
  deleteHistoryRecord,
  exportCandidatesCsv,
  getDiscoveryResultsByRunId,
  loadAllDiscoveryResults,
  loadCandidates,
  loadDevelopmentRecords,
  loadDiscoveryRuns,
  loadHistoryRecords,
  loadProducts,
  removeCandidateFromPool,
  restoreCandidatePoolSnapshot,
  saveCandidates,
  saveDevelopmentRecords,
  saveHistoryRecords,
  saveProducts,
  updateProductFrontReview,
  updateProductManualData,
  upsertDevelopmentRecord,
  upsertHistoryRecord,
} from './utils/productStore';
import { resolveProductData } from './utils/scoring';
import { longTailOpportunityLabel } from './utils/keywordTools';
import { extractImageUrl } from './utils/imageTools';

type AppPage =
  | 'mcp-discovery'
  | 'mcp-store-discovery'
  | 'excel'
  | 'products'
  | 'product-detail'
  | 'screening'
  | 'review'
  | 'profit'
  | 'development'
  | 'history'
  | 'export'
  | 'mcp-validation';

const navItems: ReadonlyArray<SidebarNavItem<AppPage>> = [
  {
    key: 'mcp-discovery',
    label: 'MCP找品',
    children: [
      { key: 'mcp-discovery', label: '类目节点选品' },
      { key: 'mcp-store-discovery', label: '店铺选品' },
    ],
  },
  { key: 'products', label: '候选池' },
  { key: 'product-detail', label: '商品详情' },
  { key: 'mcp-validation', label: 'MCP验证' },
  { key: 'review', label: '前台复核池' },
  { key: 'profit', label: '利润测算' },
  { key: 'development', label: '开发池' },
  { key: 'history', label: '历史库' },
  { key: 'excel', label: 'Excel导入' },
  { key: 'export', label: '导出' },
];

type ValidationSeed = {
  mainKeyword: string;
  title: string;
  category: string;
  generateLongTail: boolean;
  queryLongTail: boolean;
};

type DetailSourcePage = Extract<AppPage, 'mcp-discovery' | 'mcp-store-discovery' | 'products' | 'review' | 'profit' | 'development' | 'history'>;
type CandidateQuickFilter =
  | 'all'
  | 'A'
  | 'A_candidate'
  | 'B'
  | 'C'
  | 'mcp_pending'
  | 'profit_pending'
  | 'front_pending'
  | 'archived';

type ProductDetailContext = {
  source_page: DetailSourcePage;
  source_label: string;
  source_list: string[];
  current_index: number;
  asin: string;
  saved_at: string;
};

type DetailSearchOption = {
  asin: string;
  title: string | null;
  layer: string;
  source_label: string;
  product: ProductRecord;
};

const productDetailContextKey = 'amazon-sellersprite-selector:product-detail-context';
const candidateValidationQueueKey = 'amazon-sellersprite-selector:mcp-validation-candidate-queue';
const mcpDiscoveryEntryKey = 'amazon-sellersprite-selector:mcp-discovery-entry';
const abandonReasons = ['利润不足', '风险较高', '重复产品', '关键词弱', '竞争高', '供应链不合适', '其他'] as const;
const candidateFilterOptions: Array<[CandidateQuickFilter, string]> = [
  ['all', '全部'],
  ['A', 'A重点开发'],
  ['A_candidate', 'A候选'],
  ['B', 'B小批量测试'],
  ['C', 'C低成本试上架'],
  ['mcp_pending', '待MCP复核'],
  ['profit_pending', '待利润测算'],
  ['front_pending', '待前台复核'],
  ['archived', '已放弃/已移出'],
];

function readInitialPage(): AppPage {
  const params = new URLSearchParams(window.location.search);
  const page = params.get('page') as AppPage | null;
  if (isKnownPage(page)) return page!;
  return readLastMcpDiscoveryEntry();
}

function isKnownPage(page: AppPage | null): page is AppPage {
  return navItems.some((item) => item.key === page || item.children?.some((child) => child.key === page));
}

function readLastMcpDiscoveryEntry(): Extract<AppPage, 'mcp-discovery' | 'mcp-store-discovery'> {
  const stored = window.localStorage.getItem(mcpDiscoveryEntryKey);
  return stored === 'mcp-store-discovery' ? 'mcp-store-discovery' : 'mcp-discovery';
}

function readValidationSeed(): ValidationSeed {
  const params = new URLSearchParams(window.location.search);
  return {
    mainKeyword: params.get('main_keyword') ?? '',
    title: params.get('seed_title') ?? '',
    category: params.get('seed_category') ?? '',
    generateLongTail: params.get('generate_long_tail') === '1',
    queryLongTail: params.get('query_long_tail') === '1',
  };
}

function readProductDetailContext(): ProductDetailContext | null {
  try {
    const raw = window.localStorage.getItem(productDetailContextKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProductDetailContext>;
    if (!parsed.asin || !Array.isArray(parsed.source_list) || !parsed.source_page) return null;
    const sourceList = uniqueAsins(parsed.source_list);
    return {
      source_page: parsed.source_page as DetailSourcePage,
      source_label: parsed.source_label ?? sourcePageLabel(parsed.source_page as DetailSourcePage),
      source_list: sourceList,
      current_index: Math.max(0, Math.min(parsed.current_index ?? sourceList.indexOf(parsed.asin), Math.max(sourceList.length - 1, 0))),
      asin: parsed.asin,
      saved_at: parsed.saved_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveProductDetailContext(context: ProductDetailContext) {
  window.localStorage.setItem(productDetailContextKey, JSON.stringify(context));
}

function uniqueAsins(asins: Array<string | null | undefined>): string[] {
  return asins
    .map((asin) => (asin ?? '').trim())
    .filter((asin, index, list) => asin && list.indexOf(asin) === index);
}

function sourcePageLabel(page: DetailSourcePage): string {
  const labels: Record<DetailSourcePage, string> = {
    'mcp-discovery': 'MCP找品',
    'mcp-store-discovery': '店铺选品',
    products: '候选池',
    review: '前台复核池',
    profit: '利润测算',
    development: '开发池',
    history: '历史库',
  };
  return labels[page] ?? '来源列表';
}

function pageTitle(page: AppPage): string {
  for (const item of navItems) {
    if (item.key === page) return item.children?.length && page === 'mcp-discovery' ? '类目节点选品' : item.label;
    const child = item.children?.find((entry) => entry.key === page);
    if (child) return child.label;
  }
  return 'MCP找品';
}

function buildDetailProducts(products: ProductRecord[]): ProductRecord[] {
  const productMap = new Map<string, ProductRecord>();
  products.forEach((product) => productMap.set(product.asin, product));
  loadAllDiscoveryResults().forEach((result) => {
    if (!productMap.has(result.asin)) productMap.set(result.asin, createProductFromDiscovery(discoveryResultToProduct(result)));
  });
  return Array.from(productMap.values());
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
    is_amazon: false,
    variation_count: result.variation_count ?? null,
    product_url: result.product_url ?? null,
    main_image_url: result.main_image_url,
    main_image_source: result.main_image_source,
    listed_at: result.listed_at,
    launch_date: null,
    first_available_date: result.listed_at,
    product_age_days: result.product_age_days,
    listed_days: result.product_age_days,
    is_recent_product: typeof result.product_age_days === 'number' ? result.product_age_days <= 365 : false,
    recent_product_level: recentLevelFromStoredAge(result.product_age_days),
    source_keyword: result.source_keyword,
    source_type: 'category_node',
    source_node_id: result.category_node_id ?? '',
    source_category_path: result.category_path ?? '',
    discovered_at: result.created_at,
    raw: result.raw,
  };
}

function recentLevelFromStoredAge(age: number | null): McpDiscoveredProduct['recent_product_level'] {
  if (age === null) return '时间缺失';
  if (age <= 30) return '新品观察';
  if (age <= 180) return '新品优先';
  if (age <= 365) return '稳定新品';
  return '老品';
}

function App() {
  const [activePage, setActivePage] = useState<AppPage>(() => readInitialPage());
  const [collapsed, setCollapsed] = useState(false);
  const [mcpAsin, setMcpAsin] = useState(() => new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
  const [mcpSeed, setMcpSeed] = useState<ValidationSeed>(() => readValidationSeed());
  const [detailContext, setDetailContext] = useState<ProductDetailContext | null>(() => readProductDetailContext());
  const [detailAsin, setDetailAsin] = useState(() => new URLSearchParams(window.location.search).get('asin') ?? readProductDetailContext()?.asin ?? '');
  const [products, setProducts] = useState<ProductRecord[]>(() => loadProducts());

  useEffect(() => {
    const onPopState = () => {
      setActivePage(readInitialPage());
      setMcpAsin(new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
      setMcpSeed(readValidationSeed());
      const storedContext = readProductDetailContext();
      setDetailContext(storedContext);
      setDetailAsin(new URLSearchParams(window.location.search).get('asin') ?? storedContext?.asin ?? '');
    };
    const reloadProducts = () => setProducts(loadProducts());
    window.addEventListener('popstate', onPopState);
    window.addEventListener('focus', reloadProducts);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('focus', reloadProducts);
    };
  }, []);

  const navigate = (page: AppPage, params?: Record<string, string>, meta?: { fromParent?: boolean }) => {
    const targetPage = page === 'mcp-discovery' && !params && meta?.fromParent ? readLastMcpDiscoveryEntry() : page;
    const next = new URLSearchParams();
    next.set('page', targetPage);
    Object.entries(params ?? {}).forEach(([key, value]) => {
      if (value) next.set(key, value);
    });
    window.history.pushState(null, '', `?${next.toString()}`);
    setActivePage(targetPage);
    if (targetPage === 'mcp-discovery' || targetPage === 'mcp-store-discovery') {
      window.localStorage.setItem(mcpDiscoveryEntryKey, targetPage);
    }
    if (params?.asin) setMcpAsin(params.asin);
    if (targetPage === 'mcp-validation') {
      setMcpSeed({
        mainKeyword: params?.main_keyword ?? '',
        title: params?.seed_title ?? '',
        category: params?.seed_category ?? '',
        generateLongTail: params?.generate_long_tail === '1',
        queryLongTail: params?.query_long_tail === '1',
      });
    }
    if (params?.asin) setDetailAsin(params.asin);
    setProducts(loadProducts());
  };

  const openProductDetail = (
    asin: string,
    context?: {
      source_page: DetailSourcePage;
      source_list: string[];
      current_index?: number;
      source_label?: string;
    },
  ) => {
    const sourceList = uniqueAsins(context?.source_list?.length ? context.source_list : products.map((product) => product.asin));
    const currentIndex = Math.max(0, context?.current_index ?? sourceList.indexOf(asin));
    const nextContext: ProductDetailContext = {
      source_page: context?.source_page ?? 'products',
      source_label: context?.source_label ?? sourcePageLabel(context?.source_page ?? 'products'),
      source_list: sourceList.includes(asin) ? sourceList : [asin, ...sourceList],
      current_index: currentIndex >= 0 ? currentIndex : 0,
      asin,
      saved_at: new Date().toISOString(),
    };
    setDetailContext(nextContext);
    saveProductDetailContext(nextContext);
    navigate('product-detail', { asin });
  };

  const title = useMemo(() => pageTitle(activePage), [activePage]);
  const detailProducts = useMemo(() => buildDetailProducts(products), [products, activePage]);
  const detailProduct = useMemo(() => detailProducts.find((product) => product.asin === detailAsin), [detailAsin, detailProducts]);
  const saveFrontReview = (asin: string, review: FrontReview) => setProducts((current) => updateProductFrontReview(current, asin, review));

  return (
    <div className="app-shell">
      <SidebarNavigation
        activePage={activePage}
        collapsed={collapsed}
        items={navItems}
        onNavigate={(page, meta) => navigate(page, undefined, meta)}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
      />

      <main className="main">
        <header className="page-header">
          <div>
            <p className="eyebrow">Amazon 精铺工具</p>
            <h1>{title}</h1>
          </div>
          <div className="header-note">单次手动验证，不做批量抓取</div>
        </header>

        {activePage === 'mcp-discovery' ? (
          <McpDiscoveryPage
            products={products}
            onProductsChange={setProducts}
            onSendToValidation={(asin, seed) => navigate('mcp-validation', {
              asin,
              main_keyword: seed?.mainKeyword ?? '',
              seed_title: seed?.title ?? '',
              seed_category: seed?.category ?? '',
              generate_long_tail: seed?.generateLongTail ? '1' : '',
              query_long_tail: seed?.queryLongTail ? '1' : '',
            })}
            onOpenReview={(asin, context) => openProductDetail(asin, {
              source_page: 'mcp-discovery',
              source_label: 'MCP找品',
              source_list: context?.sourceList ?? [asin],
              current_index: context?.currentIndex,
            })}
            onOpenDevelopment={() => navigate('development')}
          />
        ) : activePage === 'mcp-store-discovery' ? (
          <McpStoreDiscoveryPage
            products={products}
            onProductsChange={setProducts}
            onSendToValidation={(asin, seed) => navigate('mcp-validation', {
              asin,
              seed_title: seed?.title ?? '',
              seed_category: seed?.category ?? '',
              main_keyword: seed?.mainKeyword ?? '',
            })}
            onOpenProductDetail={(asin, context) => openProductDetail(asin, {
              source_page: 'mcp-store-discovery',
              source_label: '店铺选品',
              source_list: context?.sourceList ?? [asin],
              current_index: context?.currentIndex,
            })}
          />
        ) : activePage === 'mcp-validation' ? (
          <McpValidationPage
            initialAsin={mcpAsin}
            initialMainKeyword={mcpSeed.mainKeyword}
            initialTitle={mcpSeed.title}
            initialCategory={mcpSeed.category}
            initialGenerateLongTail={mcpSeed.generateLongTail}
            initialQueryLongTail={mcpSeed.queryLongTail}
          />
        ) : activePage === 'products' ? (
          <ProductListPage products={products} navigate={navigate} openProductDetail={openProductDetail} reload={() => setProducts(loadProducts())} />
        ) : activePage === 'product-detail' ? (
          <ProductDetailPage
            product={detailProduct}
            products={detailProducts}
            currentAsin={detailAsin}
            detailContext={detailContext}
            navigate={navigate}
            openProductDetail={openProductDetail}
            onSaveReview={saveFrontReview}
          />
        ) : activePage === 'review' ? (
          <FrontReviewPoolPage products={products} openProductDetail={openProductDetail} onSaveReview={saveFrontReview} />
        ) : activePage === 'profit' ? (
          <ProfitPage products={products} onProductsChange={setProducts} openProductDetail={openProductDetail} />
        ) : activePage === 'development' ? (
          <DevelopmentPoolPage products={products} onProductsChange={setProducts} openProductDetail={openProductDetail} />
        ) : activePage === 'history' ? (
          <HistoryLibraryPage products={products} onProductsChange={setProducts} openProductDetail={openProductDetail} />
        ) : activePage === 'export' ? (
          <UnifiedExportPage products={products} />
        ) : activePage === 'excel' ? (
          <ExcelImportPage products={products} onProductsChange={setProducts} />
        ) : (
          <PlaceholderPage page={title} />
        )}
      </main>
    </div>
  );
}

function ProductListPage({
  products,
  navigate,
  openProductDetail,
  reload,
}: {
  products: ProductRecord[];
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
  reload: () => void;
}) {
  const [candidates, setCandidates] = useState<McpCandidateRecord[]>(() => loadCandidates());
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>(() => loadHistoryRecords());
  const [selectedAsins, setSelectedAsins] = useState<string[]>([]);
  const [activeFilter, setActiveFilter] = useState<CandidateQuickFilter>('all');
  const [expandedAsins, setExpandedAsins] = useState<string[]>([]);
  const [compactMode, setCompactMode] = useState(true);
  const [notice, setNotice] = useState('');
  const [undoState, setUndoState] = useState<{
    candidates: McpCandidateRecord[];
    selectedAsins: string[];
    affectedAsins: string[];
    message: string;
  } | null>(null);
  const productMap = useMemo(() => new Map(products.map((product) => [product.asin, product])), [products]);
  const filteredCandidates = useMemo(
    () => candidates.filter((candidate) => matchCandidateQuickFilter(candidate, productMap.get(candidate.asin), activeFilter)),
    [activeFilter, candidates, productMap],
  );
  const sourceList = filteredCandidates.map((candidate) => candidate.asin);
  const selectedSet = new Set(selectedAsins);
  const visibleAsins = filteredCandidates.map((candidate) => candidate.asin);
  const allSelected = visibleAsins.length > 0 && visibleAsins.every((asin) => selectedAsins.includes(asin));
  const archivedCount = historyRecords.filter((record) => record.decision_status === 'abandoned' || record.decision_status === 'removed_from_candidate').length;
  const stats = useMemo(() => buildCandidateOverviewStats(candidates, productMap, archivedCount), [archivedCount, candidates, productMap]);

  const refresh = () => {
    reload();
    setCandidates(loadCandidates());
    setHistoryRecords(loadHistoryRecords());
    setSelectedAsins([]);
    setNotice('已刷新候选池。');
  };

  const toggleSelected = (asin: string) => {
    setSelectedAsins((current) => (current.includes(asin) ? current.filter((item) => item !== asin) : [...current, asin]));
  };

  const toggleAll = () => {
    setSelectedAsins(allSelected ? selectedAsins.filter((asin) => !visibleAsins.includes(asin)) : uniqueAsins([...selectedAsins, ...visibleAsins]));
  };

  const toggleExpanded = (asin: string) => {
    setExpandedAsins((current) => (current.includes(asin) ? current.filter((item) => item !== asin) : [...current, asin]));
  };

  const applyCandidateAction = (
    action: (current: McpCandidateRecord[]) => McpCandidateRecord[],
    affectedAsins: string[],
    message: string,
  ) => {
    const previous = candidates;
    const next = action(candidates);
    setCandidates(next);
    setHistoryRecords(loadHistoryRecords());
    setSelectedAsins((current) => current.filter((asin) => !affectedAsins.includes(asin)));
    setUndoState({ candidates: previous, selectedAsins, affectedAsins, message });
    setNotice(`${message} 可点击“撤销上次操作”恢复候选池显示。`);
  };

  const removeFromCandidate = (asins: string[]) => {
    const targetAsins = asins.filter(Boolean);
    if (!targetAsins.length) {
      window.alert('请先选择候选商品。');
      return;
    }
    if (!window.confirm(`确认将 ${targetAsins.length} 个商品移出候选池吗？历史库会保留 ASIN 记录用于后续去重。`)) return;
    applyCandidateAction(
      (current) => targetAsins.reduce((next, asin) => removeCandidateFromPool(next, asin, 'removed_from_candidate', '移出候选'), current),
      targetAsins,
      `已移出 ${targetAsins.length} 个候选商品。`,
    );
  };

  const askAbandonReason = (): string | null => {
    const input = window.prompt(`请选择放弃原因，输入序号或文字：\n${abandonReasons.map((reason, index) => `${index + 1}. ${reason}`).join('\n')}`);
    if (input === null) return null;
    const trimmed = input.trim();
    const byIndex = Number(trimmed);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= abandonReasons.length) return abandonReasons[byIndex - 1];
    if (abandonReasons.includes(trimmed as (typeof abandonReasons)[number])) return trimmed;
    return trimmed || '其他';
  };

  const abandonCandidates = (asins: string[]) => {
    const targetAsins = asins.filter(Boolean);
    if (!targetAsins.length) {
      window.alert('请先选择候选商品。');
      return;
    }
    const reason = askAbandonReason();
    if (reason === null) return;
    if (!window.confirm(`确认将 ${targetAsins.length} 个商品标记为放弃吗？原因：${reason}`)) return;
    applyCandidateAction(
      (current) => targetAsins.reduce((next, asin) => removeCandidateFromPool(next, asin, 'abandoned', reason), current),
      targetAsins,
      `已标记放弃 ${targetAsins.length} 个候选商品。`,
    );
  };

  const permanentlyDeleteCandidate = (asin: string) => {
    if (!window.confirm('永久删除只会从候选池记录中删除，不会自动清理历史库。确认继续吗？')) return;
    if (!window.confirm('请再次确认永久删除该候选记录。建议优先使用“移出候选”保留去重记录。')) return;
    setCandidates((current) => deleteCandidatePermanently(current, asin));
    setSelectedAsins((current) => current.filter((item) => item !== asin));
    setNotice(`已永久删除候选记录 ${asin}。`);
  };

  const addToDevelopment = (asins: string[]) => {
    const targetAsins = asins.filter(Boolean);
    if (!targetAsins.length) {
      window.alert('请先选择候选商品。');
      return;
    }
    const missingProducts = targetAsins.filter((asin) => !productMap.has(asin));
    if (missingProducts.length) {
      window.alert(`以下 ASIN 还没有商品记录，需先完成 MCP 验证或保存商品后再加入开发池：${missingProducts.join(', ')}`);
      return;
    }
    if (!window.confirm(`确认将 ${targetAsins.length} 个候选加入开发池吗？`)) return;
    let nextCandidates = candidates;
    targetAsins.forEach((asin) => {
      const result = addProductToDevelopment(products, nextCandidates, asin);
      nextCandidates = result.candidates;
    });
    setCandidates(nextCandidates);
    setHistoryRecords(loadHistoryRecords());
    setSelectedAsins((current) => current.filter((asin) => !targetAsins.includes(asin)));
    setNotice(`已加入开发池 ${targetAsins.length} 个候选商品。`);
  };

  const undoLastAction = () => {
    if (!undoState) return;
    setCandidates(restoreCandidatePoolSnapshot(undoState.candidates, undoState.affectedAsins));
    setHistoryRecords(loadHistoryRecords());
    setSelectedAsins(undoState.selectedAsins);
    setNotice(`已撤销：${undoState.message}`);
    setUndoState(null);
  };

  const sendToValidation = (asins: string[]) => {
    const targetAsins = asins.filter(Boolean);
    if (!targetAsins.length) {
      window.alert('请先选择候选商品。');
      return;
    }
    window.localStorage.setItem(candidateValidationQueueKey, JSON.stringify({ asins: targetAsins, created_at: new Date().toISOString() }));
    const first = candidates.find((candidate) => candidate.asin === targetAsins[0]);
    navigate('mcp-validation', {
      asin: targetAsins[0],
      main_keyword: first?.main_keyword ?? first?.keyword ?? '',
      seed_title: candidateTitle(first, productMap.get(targetAsins[0])),
      seed_category: candidateCategory(first, productMap.get(targetAsins[0])),
    });
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>候选池</h2>
        <p>候选池以本地候选记录为准；移出候选会保留历史去重记录，标记放弃会写入放弃原因。</p>
      </div>
      <div className="candidate-overview-grid">
        <CandidateOverviewCard label="候选总数" value={stats.total} tone="neutral" />
        <CandidateOverviewCard label="A" value={stats.A} tone="good" />
        <CandidateOverviewCard label="A候选" value={stats.A_candidate} tone="good" />
        <CandidateOverviewCard label="B" value={stats.B} tone="good" />
        <CandidateOverviewCard label="C" value={stats.C} tone="warn" />
        <CandidateOverviewCard label="D/E" value={`${stats.D}/${stats.E}`} tone="muted" />
        <CandidateOverviewCard label="待MCP复核" value={stats.mcpPending} tone="warn" />
        <CandidateOverviewCard label="待利润测算" value={stats.profitPending} tone="warn" />
        <CandidateOverviewCard label="待前台复核" value={stats.frontPending} tone="warn" />
        <CandidateOverviewCard label="已放弃/移出" value={stats.archived} tone="danger" />
      </div>
      <div className="candidate-toolbar">
        <div className="candidate-filter-chips" aria-label="候选池快捷筛选">
          {candidateFilterOptions.map(([value, label]) => (
            <button key={value} className={activeFilter === value ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setActiveFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <button className="secondary-button" type="button" onClick={refresh}>
          刷新本地商品
        </button>
        <button className="secondary-button" type="button" onClick={() => setCompactMode((value) => !value)}>
          {compactMode ? '标准行高' : '紧凑模式'}
        </button>
        {undoState && (
          <button className="secondary-button" type="button" onClick={undoLastAction}>
            撤销上次操作
          </button>
        )}
      </div>
      {selectedAsins.length > 0 && (
        <div className="candidate-bulk-bar">
          <strong>已选择 {selectedAsins.length} 个候选</strong>
          <button className="secondary-button" type="button" onClick={() => sendToValidation(selectedAsins)}>
            批量发送 MCP 验证
          </button>
          <button className="secondary-button" type="button" onClick={() => addToDevelopment(selectedAsins)}>
            批量加入开发池
          </button>
          <button className="secondary-button danger-button" type="button" onClick={() => removeFromCandidate(selectedAsins)}>
            批量移出候选
          </button>
          <button className="secondary-button danger-button" type="button" onClick={() => abandonCandidates(selectedAsins)}>
            批量标记放弃
          </button>
        </div>
      )}
      {notice && <p className="save-notice">{notice}</p>}
      {activeFilter === 'archived' && (
        <p className="candidate-action-hint">已放弃/已移出的商品保留在历史库中，用于后续去重。需要恢复时请到历史库操作。</p>
      )}
      <div className="candidate-table-wrap">
        <table className={`candidate-table ${compactMode ? 'candidate-table-compact' : ''}`}>
          <colgroup>
            <col className="candidate-col-select" />
            <col className="candidate-col-image" />
            <col className="candidate-col-asin" />
            <col className="candidate-col-title" />
            <col className="candidate-col-layer" />
            <col className="candidate-col-advice" />
            <col className="candidate-col-score" />
            <col className="candidate-col-score" />
            <col className="candidate-col-margin" />
            <col className="candidate-col-number" />
            <col className="candidate-col-number" />
            <col className="candidate-col-status" />
            <col className="candidate-col-date" />
            <col className="candidate-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input type="checkbox" aria-label="选择全部候选" checked={allSelected} onChange={toggleAll} />
              </th>
              <th>主图</th>
              <th>ASIN</th>
              <th>标题</th>
              <th>分层</th>
              <th>铺货动作建议</th>
              <th>新品动销分</th>
              <th>综合评分</th>
              <th>平台后毛利率</th>
              <th>月销量</th>
              <th>有效评论数</th>
              <th>MCP状态</th>
              <th>最近MCP复核时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredCandidates.map((candidate, index) => {
              const product = productMap.get(candidate.asin);
              return (
              <ProductRow
                key={candidate.id}
                candidate={candidate}
                product={product}
                selected={selectedSet.has(candidate.asin)}
                expanded={expandedAsins.includes(candidate.asin)}
                onToggleSelected={() => toggleSelected(candidate.asin)}
                onToggleExpanded={() => toggleExpanded(candidate.asin)}
                onSendToValidation={() => sendToValidation([candidate.asin])}
                onOpenDetail={() => openProductDetail(candidate.asin, {
                  source_page: 'products',
                  source_label: '候选池',
                  source_list: sourceList,
                  current_index: index,
                })}
                onRemove={() => removeFromCandidate([candidate.asin])}
                onAbandon={() => abandonCandidates([candidate.asin])}
                onAddToDevelopment={() => addToDevelopment([candidate.asin])}
                onPermanentDelete={() => permanentlyDeleteCandidate(candidate.asin)}
              />
              );
            })}
          </tbody>
        </table>
        {!candidates.length && <div className="empty-state">候选池暂无商品。可以从 MCP 找品或 MCP 验证页保存候选。</div>}
        {candidates.length > 0 && !filteredCandidates.length && <div className="empty-state">当前筛选下没有候选商品。</div>}
      </div>
    </section>
  );
}

function ProductRow({
  candidate,
  product,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
  onSendToValidation,
  onOpenDetail,
  onRemove,
  onAbandon,
  onAddToDevelopment,
  onPermanentDelete,
}: {
  candidate: McpCandidateRecord;
  product?: ProductRecord;
  selected: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onSendToValidation: () => void;
  onOpenDetail: () => void;
  onRemove: () => void;
  onAbandon: () => void;
  onAddToDevelopment: () => void;
  onPermanentDelete: () => void;
}) {
  const score = product?.score;
  const title = candidateTitle(candidate, product);
  const display = buildCandidateDisplay(candidate, product);
  return (
    <>
      <tr className={selected ? 'candidate-row-selected' : undefined}>
        <td className="candidate-sticky-cell candidate-select-cell">
          <input type="checkbox" aria-label={`选择 ${candidate.asin}`} checked={selected} onChange={onToggleSelected} />
        </td>
        <td className="candidate-sticky-cell candidate-image-cell"><ProductThumbnail src={productMainImageUrl(product, candidate)} asin={candidate.asin} title={title} size="small" /></td>
        <td className="candidate-asin-cell"><strong>{candidate.asin}</strong></td>
        <td className="candidate-title-cell">
          <button className="link-button table-title-button" type="button" onClick={onToggleExpanded} title={title}>
            {title}
          </button>
          <small title={candidateCategory(candidate, product)}>{candidateCategory(candidate, product) || '类目未返回'}</small>
        </td>
        <td><LayerPill layer={display.layer} /></td>
        <td><span className="candidate-advice-pill" title={display.actionAdvice}>{display.actionAdvice}</span></td>
        <td><strong>{valueLabel(display.newProductScore)}</strong></td>
        <td><strong>{valueLabel(display.finalScore)}</strong></td>
        <td><MarginPill value={display.platformMarginRate} /></td>
        <td>{valueLabel(display.monthlySales)}</td>
        <td>{valueLabel(display.effectiveReviewCount)}</td>
        <td>{product ? <StatusBadge product={product} /> : <span className="mcp-status">候选记录</span>}</td>
        <td>{display.checkedAt}</td>
        <td className="candidate-actions-cell">
          <button className="secondary-button" type="button" onClick={onOpenDetail}>
            商品详情
          </button>
          <button className="secondary-button" type="button" onClick={onSendToValidation}>
            MCP验证
          </button>
          <details className="candidate-more-actions">
            <summary>更多</summary>
            <div>
              <button className="secondary-button" type="button" onClick={onToggleExpanded}>
                {expanded ? '收起详情' : '展开详情'}
              </button>
              <button className="secondary-button" type="button" onClick={onAddToDevelopment}>
                加入开发池
              </button>
              <button className="secondary-button danger-button" type="button" onClick={onRemove}>
                移出候选
              </button>
              <button className="secondary-button danger-button" type="button" onClick={onAbandon}>
                标记放弃
              </button>
              <button className="secondary-button danger-button" type="button" onClick={onPermanentDelete}>
                永久删除
              </button>
            </div>
          </details>
        </td>
      </tr>
      {expanded && (
        <tr className="candidate-detail-row">
          <td colSpan={14}>
            <CandidateExpandedDetail candidate={candidate} product={product} score={score} />
          </td>
        </tr>
      )}
    </>
  );
}

function CandidateOverviewCard({ label, value, tone }: { label: string; value: string | number; tone: 'neutral' | 'good' | 'warn' | 'danger' | 'muted' }) {
  return (
    <div className={`candidate-overview-card candidate-overview-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LayerPill({ layer }: { layer: string }) {
  const tone = layer.startsWith('A')
    ? 'good'
    : layer.startsWith('B') || layer.startsWith('C')
      ? 'warn'
      : layer.startsWith('E')
        ? 'danger'
        : 'muted';
  return <span className={`candidate-layer-pill candidate-layer-${tone}`} title={layer}>{shortLayerLabel(layer)}</span>;
}

function MarginPill({ value }: { value: number | null }) {
  const tone = value === null ? 'pending' : value >= 0.6 ? 'good' : value >= 0.5 ? 'warn' : 'danger';
  return <span className={`candidate-margin-pill candidate-margin-${tone}`}>{formatPercent(value)}</span>;
}

function CandidateExpandedDetail({
  candidate,
  product,
  score,
}: {
  candidate: McpCandidateRecord;
  product?: ProductRecord;
  score?: ProductRecord['score'];
}) {
  const resolved = product ? resolveProductData(product) : null;
  const explanation = uniqueAsins([
    ...(score?.new_product_sales_signal_score.explanation ?? []),
    ...(score?.low_review_sales_score.explanation ?? []),
    ...(candidate.mcp_result?.score_explanation ?? []),
  ]);
  const actionFlags = uniqueAsins([
    ...(score?.new_product_sales_signal_score.action_flags ?? []),
    ...(score?.low_review_sales_score.action_flags ?? []),
    ...(candidate.mcp_result?.action_flags ?? []),
  ]);
  const missingItems = uniqueAsins([
    ...(resolved?.missing_notes ?? []),
    ...(score?.listing_test_score.missing_review_items ?? []),
  ]);
  const whyTestable = uniqueAsins([...(score?.listing_test_score.why_testable ?? [])]);
  const whyNotE = uniqueAsins([...(score?.listing_test_score.why_not_e ?? [])]);
  const riskNotes = uniqueAsins([...(score?.listing_safety_score.notes ?? [])]);
  const keywordHints = uniqueAsins([
    ...(candidate.recommended_sp_keywords ?? []),
    ...(candidate.mcp_result?.recommended_sp_keywords ?? []),
    ...(candidate.rejected_keywords ?? []).map((keyword) => `不建议：${keyword}`),
  ]);

  return (
    <div className="candidate-expanded-panel">
      <DetailBlock title="评分解释" items={explanation} emptyText="暂无评分解释，建议先完成 MCP 验证。" />
      <DetailBlock title="动作标签" items={actionFlags} emptyText="暂无动作标签。" badge />
      <DetailBlock title="缺失数据" items={missingItems} emptyText="关键字段暂未发现明显缺失。" />
      <DetailBlock title="为什么可测" items={whyTestable} emptyText="暂无可测说明。" />
      <DetailBlock title="为什么不是E" items={whyNotE} emptyText="暂无说明。" />
      <DetailBlock title="风险提示" items={riskNotes} emptyText="暂无硬风险提示。" />
      <DetailBlock title="关键词建议" items={keywordHints} emptyText="暂无推荐 SP 词或不建议词。" />
      <div className="candidate-detail-mini-grid">
        <span>低竞价广告：{score?.low_bid_ad_score.signal ?? longTailOpportunityLabel(candidate.long_tail_opportunity_level ?? 'unknown')}</span>
        <span>前台复核：{frontReviewStatusLabel(product?.front_review.status ?? candidate.front_review?.status ?? candidate.front_review_status ?? 'not_started')}</span>
        <span>最终建议：{product ? decisionLabel(product.decision.final_decision) : candidate.final_advice ?? decisionStatusLabel(candidate.decision_status ?? 'candidate')}</span>
        <span>全成本毛利：{formatPercent(score?.final_margin_score.full_margin_rate ?? candidate.margin?.final_margin_rate)}</span>
      </div>
    </div>
  );
}

function DetailBlock({ title, items, emptyText, badge = false }: { title: string; items: string[]; emptyText: string; badge?: boolean }) {
  const cleanItems = items.filter(Boolean);
  return (
    <div className="candidate-detail-block">
      <strong>{title}</strong>
      {cleanItems.length ? (
        <div className={badge ? 'candidate-chip-list' : 'candidate-detail-list'}>
          {cleanItems.slice(0, 8).map((item) => (
            badge ? <span key={item}>{item}</span> : <p key={item}>{item}</p>
          ))}
          {cleanItems.length > 8 && <small>还有 {cleanItems.length - 8} 条，详情页可继续查看。</small>}
        </div>
      ) : (
        <small>{emptyText}</small>
      )}
    </div>
  );
}

function buildCandidateOverviewStats(candidates: McpCandidateRecord[], productMap: Map<string, ProductRecord>, archivedCount: number) {
  return candidates.reduce(
    (stats, candidate) => {
      const product = productMap.get(candidate.asin);
      const group = candidateLayerGroup(candidate, product);
      if (group === 'A') stats.A += 1;
      else if (group === 'A_candidate') stats.A_candidate += 1;
      else if (group === 'B') stats.B += 1;
      else if (group === 'C') stats.C += 1;
      else if (group === 'D') stats.D += 1;
      else if (group === 'E') stats.E += 1;
      if (isCandidateMcpPending(candidate, product)) stats.mcpPending += 1;
      if (isCandidateProfitPending(candidate, product)) stats.profitPending += 1;
      if (isCandidateFrontPending(candidate, product)) stats.frontPending += 1;
      return stats;
    },
    { total: candidates.length, A: 0, A_candidate: 0, B: 0, C: 0, D: 0, E: 0, mcpPending: 0, profitPending: 0, frontPending: 0, archived: archivedCount },
  );
}

function matchCandidateQuickFilter(candidate: McpCandidateRecord, product: ProductRecord | undefined, filter: CandidateQuickFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'archived') return candidate.decision_status === 'abandoned' || candidate.decision_status === 'removed_from_candidate';
  if (filter === 'mcp_pending') return isCandidateMcpPending(candidate, product);
  if (filter === 'profit_pending') return isCandidateProfitPending(candidate, product);
  if (filter === 'front_pending') return isCandidateFrontPending(candidate, product);
  return candidateLayerGroup(candidate, product) === filter;
}

function buildCandidateDisplay(candidate: McpCandidateRecord, product: ProductRecord | undefined) {
  const resolved = product ? resolveProductData(product) : null;
  const score = product?.score;
  return {
    layer: candidateLayer(candidate, product),
    actionAdvice: score?.action_advice ?? candidate.final_advice ?? '待复核',
    newProductScore: score?.new_product_sales_signal_score.score ?? candidate.mcp_result?.new_product_sales_signal_score ?? null,
    finalScore: score?.flea_market_score ?? candidate.flea_market_score ?? null,
    platformMarginRate: score?.price_margin_score.platform_margin_rate ?? candidate.margin?.platform_margin_rate ?? null,
    monthlySales: resolved?.monthly_sales ?? candidate.discovery_product?.monthly_sales ?? candidate.mcp_result?.monthly_sales ?? candidate.product?.monthly_sales ?? null,
    effectiveReviewCount: resolved?.review_count ?? candidate.discovery_product?.review_count ?? candidate.mcp_result?.review_count ?? candidate.product?.review_count ?? null,
    checkedAt: product?.mcp_checked_at ? dateLabel(product.mcp_checked_at) : dateLabel(candidate.validation?.checked_at ?? candidate.saved_at),
  };
}

function candidateLayer(candidate: McpCandidateRecord, product?: ProductRecord): string {
  return product?.score.layer ?? candidate.mcp_result?.layer ?? candidate.final_advice ?? '待复核';
}

function candidateLayerGroup(candidate: McpCandidateRecord, product?: ProductRecord): CandidateQuickFilter | 'D' | 'E' | 'pending' {
  const layer = candidateLayer(candidate, product);
  if (layer.startsWith('A候选')) return 'A_candidate';
  if (layer.startsWith('A')) return 'A';
  if (layer.startsWith('B')) return 'B';
  if (layer.startsWith('C')) return 'C';
  if (layer.startsWith('D')) return 'D';
  if (layer.startsWith('E')) return 'E';
  return 'pending';
}

function shortLayerLabel(layer: string): string {
  if (layer.startsWith('A候选')) return 'A候选';
  if (layer.startsWith('A')) return 'A重点';
  if (layer.startsWith('B')) return 'B测试';
  if (layer.startsWith('C')) return 'C试上架';
  if (layer.startsWith('D')) return 'D暂缓';
  if (layer.startsWith('E')) return 'E放弃';
  return '待复核';
}

function isCandidateMcpPending(candidate: McpCandidateRecord, product?: ProductRecord): boolean {
  return !product || product.mcp_status === 'not_checked' || product.mcp_status === 'checking' || candidate.validation?.status === 'idle';
}

function isCandidateProfitPending(candidate: McpCandidateRecord, product?: ProductRecord): boolean {
  return !(product?.score.final_margin_score.cost_confirmed) && candidate.margin?.final_margin_rate == null;
}

function isCandidateFrontPending(candidate: McpCandidateRecord, product?: ProductRecord): boolean {
  const status = product?.front_review.status ?? candidate.front_review?.status ?? candidate.front_review_status ?? 'not_started';
  return status === 'not_started' || status === 'in_progress' || status === 'need_second_check';
}

function StatusBadge({ product }: { product: ProductRecord }) {
  const missing = resolveProductData(product).missing_notes.length > 0;
  const label =
    product.mcp_status === 'not_checked'
      ? '未复核'
      : product.mcp_status === 'failed'
        ? '复核失败'
        : product.mcp_status === 'checked' && missing
          ? '数据不完整'
          : product.mcp_status === 'checked'
            ? '复核成功'
            : '检查中';
  return <span className={`mcp-status mcp-status-${product.mcp_status}`}>{label}</span>;
}

function ProductDetailPage({
  product,
  products,
  currentAsin,
  detailContext,
  navigate,
  openProductDetail,
  onSaveReview,
}: {
  product: ProductRecord | undefined;
  products: ProductRecord[];
  currentAsin: string;
  detailContext: ProductDetailContext | null;
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
  onSaveReview: (asin: string, review: FrontReview) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'front-review'>('overview');
  const [searchTerm, setSearchTerm] = useState('');
  const fallbackSourceList = products.map((item) => item.asin);
  const sourceList = uniqueAsins(detailContext?.source_list?.length ? detailContext.source_list : fallbackSourceList);
  const currentIndex = sourceList.findIndex((asin) => asin === currentAsin);
  const sourcePage = detailContext?.source_page ?? 'products';
  const sourceLabelText = detailContext?.source_label ?? sourcePageLabel(sourcePage);
  const previousAsin = currentIndex > 0 ? sourceList[currentIndex - 1] : '';
  const nextAsin = currentIndex >= 0 && currentIndex < sourceList.length - 1 ? sourceList[currentIndex + 1] : '';
  const productByAsin = useMemo(() => new Map(products.map((item) => [item.asin, item])), [products]);
  const searchOptions = useMemo<DetailSearchOption[]>(() => {
    const orderedAsins = uniqueAsins([...sourceList, ...fallbackSourceList]);
    return orderedAsins.flatMap((asin) => {
      const item = productByAsin.get(asin);
      if (!item) return [];
      const resolvedItem = resolveProductData(item);
      return [{
        asin: item.asin,
        title: resolvedItem.title,
        layer: item.score.layer,
        source_label: sourceList.includes(item.asin) ? sourceLabelText : '全部商品',
        product: item,
      }];
    });
  }, [fallbackSourceList, productByAsin, sourceLabelText, sourceList]);

  useEffect(() => {
    setSearchTerm('');
  }, [currentAsin]);

  const openFromDetail = (asin: string) => {
    if (!asin) return;
    openProductDetail(asin, {
      source_page: sourcePage,
      source_label: sourceLabelText,
      source_list: sourceList.length ? sourceList : fallbackSourceList,
      current_index: sourceList.findIndex((item) => item === asin),
    });
  };

  const searchProduct = () => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return;
    const matched = products.find((item) => {
      const resolvedItem = resolveProductData(item);
      return item.asin.toLowerCase() === query || item.asin.toLowerCase().includes(query) || (resolvedItem.title ?? '').toLowerCase().includes(query);
    });
    if (!matched) {
      window.alert('没有在本地商品、候选和已保存记录中找到这个 ASIN/标题。');
      return;
    }
    openProductDetail(matched.asin, {
      source_page: 'products',
      source_label: '搜索结果',
      source_list: products.map((item) => item.asin),
      current_index: products.findIndex((item) => item.asin === matched.asin),
    });
  };

  if (!product) {
    return (
      <div className="detail-stack">
        <section className="content-section product-detail-switcher">
          <div className="section-heading">
            <h2>请选择一个商品，或输入 ASIN 搜索</h2>
            <p>{currentAsin ? `当前 ASIN ${currentAsin} 未在本地商品记录中找到。` : '商品详情页会保留上一次来源列表，方便逐个复核。'}</p>
          </div>
          <DetailSearchBox
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            searchOptions={searchOptions}
            currentAsin={currentAsin}
            sourceLabel={sourceLabelText}
            onSelect={openFromDetail}
            onSearch={searchProduct}
          />
          <div className="action-row compact-actions">
            <button className="secondary-button" type="button" onClick={() => navigate('products')}>
              返回候选池
            </button>
            <button className="secondary-button" type="button" onClick={() => navigate('mcp-discovery')}>
              返回MCP找品
            </button>
          </div>
        </section>
      </div>
    );
  }
  const resolved = resolveProductData(product);
  const diffRows = buildDiffRows(product);
  const hasLargeDiff = diffRows.some((row) => row.large);

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="product-detail-switcher">
          <div className="detail-switcher-meta">
            <span>来源：{sourceLabelText}</span>
            <span>{currentIndex >= 0 ? `${currentIndex + 1}/${sourceList.length}` : '未定位来源顺序'}</span>
          </div>
          <div className="detail-switcher-actions">
            <button className="secondary-button" type="button" onClick={() => openFromDetail(previousAsin)} disabled={!previousAsin}>
              上一个商品
            </button>
            <button className="secondary-button" type="button" onClick={() => openFromDetail(nextAsin)} disabled={!nextAsin}>
              下一个商品
            </button>
            <button className="secondary-button" type="button" onClick={() => navigate(sourcePage)}>
              返回来源列表
            </button>
          </div>
          <DetailSearchBox
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            searchOptions={searchOptions}
            currentAsin={product.asin}
            sourceLabel={sourceLabelText}
            onSelect={openFromDetail}
            onSearch={searchProduct}
          />
        </div>
        <div className="product-detail-hero">
          <ProductThumbnail src={productMainImageUrl(product)} asin={product.asin} title={resolved.title} size="detail" />
          <div className="section-heading">
            <h2>{resolved.title || product.asin}</h2>
            <p>ASIN：{product.asin} · 当前评分：{product.score.flea_market_score} 分，分层：{product.score.layer} · 来自：{sourceLabelText}</p>
            <p>主图来源：{sourceLabel(resolved.main_image_source)}</p>
          </div>
        </div>
        <div className="action-row compact-actions">
          <button className="secondary-button" type="button" onClick={() => navigate('mcp-validation', { asin: product.asin })}>
            发送到 MCP 验证
          </button>
        </div>
        <div className="detail-tabs">
          <button className={tab === 'overview' ? 'detail-tab detail-tab-active' : 'detail-tab'} type="button" onClick={() => setTab('overview')}>
            数据与决策
          </button>
          <button className={tab === 'front-review' ? 'detail-tab detail-tab-active' : 'detail-tab'} type="button" onClick={() => setTab('front-review')}>
            前台复核
          </button>
        </div>
      </section>

      {tab === 'front-review' ? (
        <FrontReviewPanel product={product} onSave={(review) => onSaveReview(product.asin, review)} />
      ) : (
        <>
          <DecisionCard decision={product.decision} />
          <KeywordAdOpportunityCard product={product} />
        <div className="score-grid">
          <Metric label="低评论出单分" value={`${product.score.low_review_sales_score.score}/30`} />
          <Metric label="价格毛利分" value={`${product.score.price_margin_score.score}/25`} />
          <Metric label="全成本毛利分" value={`${product.score.final_margin_score.score}/20`} />
          <Metric label="广告机会分" value={`${product.score.low_bid_ad_score.score}/15`} />
          <Metric label="安全分" value={`${product.score.listing_safety_score.score}/10`} />
          <Metric label="铺货测试分" value={`${product.score.listing_test_score.score}/100`} />
          <Metric label="铺货动作建议" value={product.score.action_advice} />
          <Metric label="评分风险" value={product.score.rating_risk_note} />
        </div>

          <section className="compare-grid">
            <DataCard title="Excel 数据" rows={excelRows(product)} />
            <DataCard title="MCP 数据" rows={mcpRows(product)} />
            <div className="content-section">
              <div className="section-heading">
                <h2>数据差异</h2>
                <p>{hasLargeDiff ? 'Excel 数据与 MCP 最新数据存在差异，建议以前台/MCP复核为准。' : '暂无明显差异，缺失字段仍需复核。'}</p>
              </div>
              <div className="diff-list">
                {diffRows.map((row) => (
                  <div className={`diff-row ${row.large ? 'diff-large' : ''}`} key={row.label}>
                    <span>{row.label}</span>
                    <strong>{row.message}</strong>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="content-section">
            <div className="section-heading">
              <h2>评分备注</h2>
            </div>
            <div className="warning-list">
              {[...resolved.missing_notes, ...product.score.layer_reasons, ...product.score.price_margin_score.notes, ...product.score.final_margin_score.notes, ...product.score.low_bid_ad_score.notes, ...product.score.listing_safety_score.notes].map((note) => (
                <p key={note}>{note}</p>
              ))}
              {product.score.listing_test_score.why_testable.map((note) => (
                <p key={`test-${note}`}>为什么可测：{note}</p>
              ))}
              {product.score.listing_test_score.why_not_e.map((note) => (
                <p key={`not-e-${note}`}>为什么不是 E：{note}</p>
              ))}
              {product.score.listing_test_score.missing_review_items.map((note) => (
                <p key={`missing-${note}`}>待复核：{note}</p>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DetailSearchBox({
  searchTerm,
  setSearchTerm,
  searchOptions,
  currentAsin,
  sourceLabel,
  onSelect,
  onSearch,
}: {
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  searchOptions: DetailSearchOption[];
  currentAsin: string;
  sourceLabel: string;
  onSelect: (asin: string) => void;
  onSearch: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const query = searchTerm.trim().toLowerCase();
  const currentOption = searchOptions.find((option) => option.asin === currentAsin) ?? null;
  const visibleOptions = searchOptions.filter((option) => {
    if (!query) return true;
    return option.asin.toLowerCase().includes(query) || (option.title ?? '').toLowerCase().includes(query);
  });
  const currentDisplay = currentOption
    ? `${currentOption.asin}${currentOption.title ? ` · ${currentOption.title}` : ''}`
    : currentAsin || '未选择商品';

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  const openAllOptions = () => {
    setIsOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const selectOption = (asin: string) => {
    setSearchTerm('');
    setIsOpen(false);
    onSelect(asin);
  };

  return (
    <div className="detail-search-box" ref={wrapperRef}>
      <div className="detail-search-control">
        <div className="detail-current-product" title={currentDisplay}>
          <span>当前商品</span>
          <strong>{currentDisplay}</strong>
          <small>来源：{currentOption?.source_label ?? sourceLabel}</small>
        </div>
        <label>
          ASIN / 标题搜索商品
          <div className="detail-search-input-row">
            <input
              ref={inputRef}
              value={searchTerm}
              placeholder={currentAsin ? `点击展开全部商品，当前 ${currentAsin}` : '点击展开全部商品，或输入 ASIN / 标题'}
              aria-label="按 ASIN 或标题搜索商品"
              onFocus={() => setIsOpen(true)}
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setIsOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setIsOpen(false);
                  return;
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (isOpen && visibleOptions.length === 1) {
                    selectOption(visibleOptions[0].asin);
                    return;
                  }
                  onSearch();
                }
              }}
            />
            <button
              className="detail-search-clear"
              type="button"
              onClick={() => {
                setSearchTerm('');
                openAllOptions();
              }}
            >
              清空
            </button>
            <button
              className="detail-search-toggle"
              type="button"
              aria-label="展开商品选择列表"
              onClick={() => {
                if (isOpen) {
                  setIsOpen(false);
                } else {
                  openAllOptions();
                }
              }}
            >
              {isOpen ? '收起' : '展开'}
            </button>
          </div>
        </label>
        {isOpen && (
          <div className="detail-search-menu" role="listbox" aria-label="可选择商品列表">
            {visibleOptions.length ? (
              visibleOptions.map((option) => (
                <button
                  className={option.asin === currentAsin ? 'detail-search-option detail-search-option-active' : 'detail-search-option'}
                  key={option.asin}
                  type="button"
                  role="option"
                  aria-selected={option.asin === currentAsin}
                  onClick={() => selectOption(option.asin)}
                >
                  <ProductThumbnail src={productMainImageUrl(option.product)} asin={option.asin} title={option.title} size="small" />
                  <span className="detail-search-option-text">
                    <strong>{option.asin}</strong>
                    <small title={option.title ?? option.asin}>{option.title || '标题未返回'}</small>
                  </span>
                  <span className="detail-search-option-meta">
                    <span>{shortLayerLabel(option.layer)}</span>
                    <small>{option.source_label}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="detail-search-empty">没有匹配商品。清空关键词后可查看当前来源列表全部商品。</div>
            )}
          </div>
        )}
      </div>
      <button className="primary-button" type="button" onClick={onSearch}>
        搜索商品
      </button>
    </div>
  );
}

function KeywordAdOpportunityCard({ product }: { product: ProductRecord }) {
  const snapshot = product.mcp_snapshot;
  const keywordSnapshots = snapshot?.keyword_snapshots ?? [];
  const mainSnapshot = keywordSnapshots.find((keyword) => keyword.keyword_type === 'main') ?? null;
  const longTailSnapshots = keywordSnapshots.filter((keyword) => keyword.keyword_type !== 'main');
  return (
    <section className="content-section keyword-opportunity-card">
      <div className="section-heading">
        <h2>关键词广告机会</h2>
        <p>长尾机会：{longTailOpportunityLabel(snapshot?.long_tail_opportunity_level ?? 'unknown')}，广告机会分 {product.score.low_bid_ad_score.score}/15，关键词可信度：{keywordConfidenceLabel(snapshot?.keyword_data_confidence ?? 'unknown')}。</p>
      </div>
      {snapshot?.keyword_data_confidence === 'low' && (
        <div className="warning-list">
          <p>当前关键词仅来自标题拆解，未完成 ASIN 反查，广告判断可信度较低。</p>
        </div>
      )}
      <div className="keyword-opportunity-summary">
        <Metric label="主关键词" value={snapshot?.main_keyword || mainSnapshot?.keyword || '待补充'} />
        <Metric label="长尾词数量" value={String((snapshot?.long_tail_keywords ?? []).length)} />
        <Metric label="推荐 SP 词" value={String((snapshot?.recommended_sp_keywords ?? []).length)} />
        <Metric label="评分解释" value={product.score.low_bid_ad_score.signal} />
      </div>
      <KeywordOpportunityTable snapshots={keywordSnapshots} />
      <div className="compare-grid keyword-recommend-grid">
        <KeywordList title="推荐低预算 SP 测试词" keywords={snapshot?.recommended_sp_keywords ?? []} empty="待查询长尾词后确认。" />
        <KeywordList title="不建议测试词" keywords={snapshot?.rejected_keywords ?? []} empty="暂未沉淀不建议词。" />
      </div>
      {!longTailSnapshots.length && <p className="helper-copy">尚未查询长尾词数据，当前广告分为中性分并标记待确认。</p>}
    </section>
  );
}

function KeywordOpportunityTable({ snapshots }: { snapshots: KeywordSnapshot[] }) {
  if (!snapshots.length) return <div className="empty-state">当前商品还没有关键词快照。</div>;
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
              <td>{snapshot.keyword || '未返回'}</td>
              <td>{keywordTypeLabel(snapshot.keyword_type)}</td>
              <td>{valueLabel(snapshot.search_volume)}</td>
              <td>{formatMoney(snapshot.ppc_bid)}</td>
              <td>{formatPercent(snapshot.purchase_rate)}</td>
              <td>{valueLabel(snapshot.ad_competitor_count)}</td>
              <td>{valueLabel(snapshot.title_density)}</td>
              <td>{keywordOpportunityVerdict(snapshot)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function keywordConfidenceLabel(confidence: string): string {
  const labels: Record<string, string> = {
    high: '高',
    medium_high: '中高',
    medium: '中',
    low: '低',
    unknown: '待确认',
  };
  return labels[confidence] ?? confidence;
}

function KeywordList({ title, keywords, empty }: { title: string; keywords: string[]; empty: string }) {
  return (
    <div className="keyword-list-panel">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <p>{keywords.join('、') || empty}</p>
    </div>
  );
}

function keywordTypeLabel(type: KeywordSnapshot['keyword_type']): string {
  const labels: Record<KeywordSnapshot['keyword_type'], string> = {
    main: '主词',
    long_tail: '长尾',
    auto_generated: '自动建议',
    manual: '手动长尾',
  };
  return labels[type];
}

function keywordOpportunityVerdict(snapshot: KeywordSnapshot): string {
  if (snapshot.error) return '查询失败';
  const searchReady = (snapshot.search_volume ?? 0) >= 300 && (snapshot.search_volume ?? 0) <= 5000;
  const bidReady = (snapshot.ppc_bid ?? Number.POSITIVE_INFINITY) <= 1;
  const competitionReady = (snapshot.ad_competitor_count ?? Number.POSITIVE_INFINITY) <= 100 && (snapshot.title_density ?? Number.POSITIVE_INFINITY) <= 50;
  if (snapshot.keyword_type === 'main') return '主需求参考';
  return searchReady && bidReady && competitionReady ? '推荐测试' : '谨慎测试';
}

function FrontReviewPoolPage({
  products,
  openProductDetail,
  onSaveReview,
}: {
  products: ProductRecord[];
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
  onSaveReview: (asin: string, review: FrontReview) => void;
}) {
  const [selectedAsin, setSelectedAsin] = useState(products[0]?.asin ?? '');
  const selected = products.find((product) => product.asin === selectedAsin) ?? products[0];
  const sourceList = products.map((product) => product.asin);

  if (!selected) return <PlaceholderPage page="前台复核池" />;

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="section-heading">
          <h2>前台复核池</h2>
          <p>这里继续人工确认前台页面切入点，保存后会回写商品和已有候选记录。</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
	              <tr>
	                <th>ASIN</th>
	                <th>主图</th>
	                <th>标题</th>
                <th>MCP</th>
                <th>前台复核</th>
                <th>复核分</th>
                <th>最终建议</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.asin}>
	                  <td>{product.asin}</td>
	                  <td><ProductThumbnail src={productMainImageUrl(product)} asin={product.asin} title={resolveProductData(product).title} size="small" /></td>
	                  <td>{resolveProductData(product).title || '未返回'}</td>
                  <td><StatusBadge product={product} /></td>
                  <td>{frontReviewStatusLabel(product.front_review.status)}</td>
                  <td>{product.front_review.front_review_score}</td>
                  <td>{decisionLabel(product.decision.final_decision)}</td>
                  <td className="table-actions">
                    <button className="secondary-button" type="button" onClick={() => setSelectedAsin(product.asin)}>
                      前台复核
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => openProductDetail(product.asin, {
                        source_page: 'review',
                        source_label: '前台复核池',
                        source_list: sourceList,
                        current_index: sourceList.indexOf(product.asin),
                      })}
                    >
                      商品详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <FrontReviewPanel product={selected} onSave={(review) => onSaveReview(selected.asin, review)} />
    </div>
  );
}

function ProfitPage({
  products,
  onProductsChange,
  openProductDetail,
}: {
  products: ProductRecord[];
  onProductsChange: (products: ProductRecord[]) => void;
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
}) {
  const [selectedAsin, setSelectedAsin] = useState(products[0]?.asin ?? '');
  const selected = products.find((product) => product.asin === selectedAsin) ?? products[0];
  const sourceList = products.map((product) => product.asin);
  const [form, setForm] = useState(() => createProfitForm(selected));

  useEffect(() => {
    setForm(createProfitForm(selected));
  }, [selected?.asin]);

  if (!selected) return <PlaceholderPage page="利润测算" />;

  const resolved = resolveProductData(selected);
  const calc = calculateProfitPreview(selected, form);

  const update = (key: keyof ProfitForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = () => {
    const targetPrice = numberFromText(form.target_price) ?? selected.score.price_margin_score.target_price_5;
    const exchangeRate = numberFromText(form.exchange_rate) ?? 7.2;
    const purchaseRmb = numberFromText(form.purchase_cost_rmb);
    const next = updateProductManualData(products, selected.asin, {
      fba_fee: numberFromText(form.fba_fee),
      referral_fee_rate: numberFromText(form.referral_fee_rate) ?? 0.15,
      purchase_cost_rmb: purchaseRmb,
      exchange_rate: exchangeRate,
      purchase_cost_usd: purchaseRmb !== null && exchangeRate > 0 ? purchaseRmb / exchangeRate : numberFromText(form.purchase_cost_usd),
      first_mile_cost_usd: numberFromText(form.first_mile_cost_usd),
      package_cost_usd: numberFromText(form.package_cost_usd),
      storage_cost_usd: numberFromText(form.storage_cost_usd),
      platform_other_fee: numberFromText(form.platform_other_fee),
      return_loss: targetPrice !== null ? targetPrice * ((numberFromText(form.return_loss_rate) ?? 0) / 100) : null,
      target_price: targetPrice,
      notes: form.notes,
    });
    onProductsChange(next);
    window.alert('利润测算结果已保存，并已重新计算铺货评分。');
  };

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="section-heading">
          <h2>利润测算</h2>
          <p>从候选商品选择一个 ASIN，录入采购和物流成本后自动回写评分与最终建议。</p>
        </div>
        <div className="input-grid compact-filter-grid">
          <label>
            选择 ASIN
            <select value={selected.asin} onChange={(event) => setSelectedAsin(event.target.value)}>
              {products.map((product) => (
                <option key={product.asin} value={product.asin}>
                  {product.asin} - {resolveProductData(product).title || '未返回标题'}
                </option>
              ))}
            </select>
          </label>
          <Metric label="竞品价" value={formatMoney(resolved.competitor_price)} />
          <Metric label="FBA费用" value={`${formatMoney(resolved.fba_fee)} / ${sourceLabel(resolved.fba_fee_source)}`} />
          <Metric label="佣金比例" value={`${formatPercent(resolved.referral_fee_rate)} / ${sourceLabel(resolved.referral_fee_rate_source)}`} />
        </div>
        <div className="product-identity-strip">
          <ProductThumbnail src={productMainImageUrl(selected)} asin={selected.asin} title={resolved.title} size="table" />
          <div>
            <strong>{selected.asin}</strong>
            <span>{resolved.title || '未返回标题'}</span>
            <small>分层：{selected.score.layer} · 铺货分：{selected.score.flea_market_score} · 主图来源：{sourceLabel(resolved.main_image_source)}</small>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => openProductDetail(selected.asin, {
              source_page: 'profit',
              source_label: '利润测算',
              source_list: sourceList,
              current_index: sourceList.indexOf(selected.asin),
            })}
          >
            商品详情
          </button>
        </div>
      </section>

      <section className="content-section cost-layout">
        <div>
          <div className="section-heading">
            <h2>人工成本录入</h2>
            <p>缺失字段允许为空；保存后不会覆盖 Excel 原始数据。</p>
          </div>
          <div className="cost-input-grid">
            <NumberInput label="采购成本 RMB" value={form.purchase_cost_rmb} onChange={(value) => update('purchase_cost_rmb', value)} />
            <NumberInput label="汇率" value={form.exchange_rate} onChange={(value) => update('exchange_rate', value)} />
            <NumberInput label="采购成本 USD" value={form.purchase_cost_usd} onChange={(value) => update('purchase_cost_usd', value)} />
            <NumberInput label="头程 USD" value={form.first_mile_cost_usd} onChange={(value) => update('first_mile_cost_usd', value)} />
            <NumberInput label="包装 USD" value={form.package_cost_usd} onChange={(value) => update('package_cost_usd', value)} />
            <NumberInput label="仓储 USD" value={form.storage_cost_usd} onChange={(value) => update('storage_cost_usd', value)} />
            <NumberInput label="退货损耗率 %" value={form.return_loss_rate} onChange={(value) => update('return_loss_rate', value)} />
            <NumberInput label="其他成本 USD" value={form.platform_other_fee} onChange={(value) => update('platform_other_fee', value)} />
            <NumberInput label="目标售价" value={form.target_price} onChange={(value) => update('target_price', value)} />
            <NumberInput label="手动 FBA 费用" value={form.fba_fee} onChange={(value) => update('fba_fee', value)} />
            <NumberInput label="佣金比例" value={form.referral_fee_rate} onChange={(value) => update('referral_fee_rate', value)} />
            <label className="review-wide">
              备注
              <textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} />
            </label>
          </div>
          <div className="action-row">
            <button className="primary-button" type="button" onClick={save}>
              保存测算结果
            </button>
          </div>
        </div>

        <div className="margin-panel">
          <div className="section-heading">
            <h2>测算结果</h2>
            <p>{calc.verdict}</p>
          </div>
          <div className="margin-kpis">
            <Metric label="便宜3%目标价" value={formatMoney(selected.score.price_margin_score.target_price_3)} />
            <Metric label="便宜5%目标价" value={formatMoney(selected.score.price_margin_score.target_price_5)} />
            <Metric label="便宜8%目标价" value={formatMoney(selected.score.price_margin_score.target_price_8)} />
            <Metric label="便宜10%目标价" value={formatMoney(selected.score.price_margin_score.target_price_10)} />
            <Metric label="采购成本 USD" value={formatMoney(calc.purchase_cost_usd)} />
            <Metric label="平台佣金" value={formatMoney(calc.referral_fee)} />
            <Metric label="平台后毛利率" value={formatPercent(calc.platform_margin_rate)} />
            <Metric label="全成本利润" value={formatMoney(calc.full_profit)} />
            <Metric label="全成本毛利率" value={formatPercent(calc.full_margin_rate)} />
            <Metric label="保本 ACOS" value={formatPercent(calc.break_even_acos)} />
          </div>
          <div className="warning-list">
            <p>{calc.platform_margin_rate !== null && calc.platform_margin_rate >= 0.6 ? '平台后毛利率达标。' : '平台后毛利率待补充或未达 60%。'}</p>
            <p>{calc.full_margin_rate === null ? '全成本毛利待测算。' : calc.full_margin_rate >= 0.25 ? '全成本毛利率达标。' : calc.full_margin_rate >= 0.18 ? '全成本毛利偏低。' : '全成本毛利不建议。'}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function DevelopmentPoolPage({
  products,
  onProductsChange,
  openProductDetail,
}: {
  products: ProductRecord[];
  onProductsChange: (products: ProductRecord[]) => void;
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
}) {
  const [records, setRecords] = useState<DevelopmentRecord[]>(() => loadDevelopmentRecords());
  const [candidates, setCandidates] = useState<McpCandidateRecord[]>(() => loadCandidates());
  const [statusFilter, setStatusFilter] = useState<'all' | DevelopmentStatus>('all');
  const [selectedAsin, setSelectedAsin] = useState(candidates[0]?.asin ?? products[0]?.asin ?? '');
  const filtered = statusFilter === 'all' ? records : records.filter((record) => record.status === statusFilter);
  const sourceList = filtered.map((record) => record.asin);

  const addSelected = () => {
    const next = addProductToDevelopment(products, candidates, selectedAsin);
    setCandidates(next.candidates);
    setRecords(next.development);
    onProductsChange(loadProducts());
    window.alert('已加入开发池，后续 MCP 找品会把它视为已开发/开发中产品。');
  };

  const updateRecord = (record: DevelopmentRecord, patch: Partial<DevelopmentRecord>) => {
    setRecords((current) => current.map((item) => (item.asin === record.asin ? { ...item, ...patch } : item)));
  };

  const saveRecord = (record: DevelopmentRecord) => {
    setRecords(upsertDevelopmentRecord(record));
  };

  const removeRecord = (asin: string) => {
    if (!window.confirm('确认从开发池删除这条记录吗？历史库不会自动删除。')) return;
    setRecords(deleteDevelopmentRecord(asin));
  };

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="section-heading">
          <h2>开发池</h2>
          <p>候选加入开发池后会写入历史库，后续找品默认按已开发/开发中去重。</p>
        </div>
        <div className="input-grid compact-filter-grid">
          <label>
            从候选池选择 ASIN
            <select value={selectedAsin} onChange={(event) => setSelectedAsin(event.target.value)}>
              {[...candidates.map((candidate) => candidate.asin), ...products.map((product) => product.asin)]
                .filter((asin, index, list) => asin && list.indexOf(asin) === index)
                .map((asin) => (
                  <option key={asin} value={asin}>
                    {asin}
                  </option>
                ))}
            </select>
          </label>
          <label>
            状态筛选
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | DevelopmentStatus)}>
              <option value="all">全部状态</option>
              {developmentStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="action-row">
          <button className="primary-button" type="button" onClick={addSelected} disabled={!selectedAsin}>
            加入开发池
          </button>
          <button className="secondary-button" type="button" onClick={() => downloadRows('development-pool', buildExportRows('developed', products))}>
            导出开发池
          </button>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>开发记录</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ASIN</th>
                <th>主图</th>
                <th>标题</th>
                <th>分层/分数</th>
                <th>利润</th>
                <th>负责人</th>
                <th>供应商</th>
                <th>采购价/目标价</th>
                <th>状态</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const product = products.find((item) => item.asin === record.asin);
                const resolved = product ? resolveProductData(product) : null;
                return (
                  <tr key={record.asin}>
	                    <td>{record.asin}</td>
	                    <td><ProductThumbnail src={productMainImageUrl(product, undefined, undefined, record)} asin={record.asin} title={resolved?.title ?? null} size="small" /></td>
	                    <td>{resolved?.title ?? '未返回'}</td>
                    <td>{product ? `${product.score.layer} / ${product.score.flea_market_score}` : '未返回'}</td>
                    <td>{product ? `${formatPercent(product.score.price_margin_score.platform_margin_rate)} / ${formatPercent(product.score.final_margin_score.full_margin_rate)}` : '未返回'}</td>
                    <td><input value={record.owner} onChange={(event) => updateRecord(record, { owner: event.target.value })} /></td>
                    <td>
                      <input value={record.supplier_name} placeholder="供应商" onChange={(event) => updateRecord(record, { supplier_name: event.target.value })} />
                      <input value={record.supplier_url} placeholder="1688链接" onChange={(event) => updateRecord(record, { supplier_url: event.target.value })} />
                    </td>
                    <td>
                      <input value={valueForInput(record.purchase_cost_rmb)} placeholder="采购价RMB" onChange={(event) => updateRecord(record, { purchase_cost_rmb: numberFromText(event.target.value) })} />
                      <input value={valueForInput(record.target_price)} placeholder="目标售价" onChange={(event) => updateRecord(record, { target_price: numberFromText(event.target.value) })} />
                    </td>
                    <td>
                      <select value={record.status} onChange={(event) => updateRecord(record, { status: event.target.value as DevelopmentStatus })}>
                        {developmentStatuses.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </td>
                    <td><textarea value={record.notes} onChange={(event) => updateRecord(record, { notes: event.target.value })} /></td>
                    <td className="table-actions">
                      <button className="secondary-button" type="button" onClick={() => saveRecord(record)}>保存</button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => openProductDetail(record.asin, {
                          source_page: 'development',
                          source_label: '开发池',
                          source_list: sourceList,
                          current_index: sourceList.indexOf(record.asin),
                        })}
                      >
                        详情
                      </button>
                      <button className="secondary-button danger-button" type="button" onClick={() => removeRecord(record.asin)}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filtered.length && <div className="empty-state">开发池暂无记录。</div>}
        </div>
      </section>
    </div>
  );
}

function HistoryLibraryPage({
  products,
  onProductsChange,
  openProductDetail,
}: {
  products: ProductRecord[];
  onProductsChange: (products: ProductRecord[]) => void;
  openProductDetail: (asin: string, context?: { source_page: DetailSourcePage; source_list: string[]; current_index?: number; source_label?: string }) => void;
}) {
  const [records, setRecords] = useState<HistoryRecord[]>(() => loadHistoryRecords());
  const [filter, setFilter] = useState<'all' | CandidateDecisionStatus | 'duplicates'>('all');
  const filtered = records.filter((record) => {
    if (filter === 'all') return true;
    if (filter === 'duplicates') return record.duplicate_status.length > 0;
    return record.decision_status === filter;
  });
  const sourceList = filtered.map((record) => record.asin);

  const restoreCandidate = (record: HistoryRecord) => {
    const product = products.find((item) => item.asin === record.asin);
    if (!product) {
      window.alert('当前本地商品中没有这条 ASIN，无法恢复为候选。');
      return;
    }
    const candidates = loadCandidates();
    if (!candidates.some((candidate) => candidate.asin === product.asin)) {
      saveCandidates([createCandidateFromProduct(product), ...candidates]);
    }
    const nextHistory = records.map((item) =>
      item.asin === record.asin
        ? { ...item, decision_status: 'candidate' as const, decision_result: 'candidate', reject_reason: '', last_seen_at: new Date().toISOString() }
        : item,
    );
    saveHistoryRecords(nextHistory);
    setRecords(nextHistory);
    onProductsChange(loadProducts());
    window.alert('已恢复为候选。');
  };

  const remove = (id: string) => {
    if (!window.confirm('确认删除这条历史记录吗？该操作不会删除商品本身。')) return;
    setRecords(deleteHistoryRecord(id));
  };

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="section-heading">
          <h2>历史库</h2>
          <p>用于查看候选、放弃、开发、已上架与重复记录，支撑后续去重。</p>
        </div>
        <div className="input-grid compact-filter-grid">
          <label>
            状态筛选
            <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">全部历史</option>
              <option value="candidate">已候选</option>
              <option value="removed_from_candidate">已移出候选</option>
              <option value="abandoned">已放弃</option>
              <option value="rejected">已放弃</option>
              <option value="development">已开发/开发中</option>
              <option value="developed">已开发</option>
              <option value="launched">已上架</option>
              <option value="duplicates">疑似重复/同父体重复</option>
            </select>
          </label>
        </div>
        <div className="action-row">
          <button className="secondary-button" type="button" onClick={() => downloadRows('history-library', buildExportRows('history', products))}>
            导出历史库
          </button>
        </div>
      </section>
      <section className="content-section">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
	                <th>ASIN</th>
	                <th>主图</th>
	                <th>标题</th>
                <th>来源</th>
                <th>状态</th>
                <th>结果/原因</th>
                <th>分数</th>
                <th>首次/最近</th>
                <th>重复状态</th>
                <th>备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
	              {filtered.map((record) => {
	                const product = products.find((item) => item.asin === record.asin);
	                return (
	                <tr key={record.id}>
	                  <td>{record.asin}</td>
	                  <td><ProductThumbnail src={productMainImageUrl(product, undefined, record)} asin={record.asin} title={record.title} size="small" /></td>
	                  <td>{record.title || '未返回'}</td>
	                  <td>{record.source}</td>
                  <td>{decisionStatusLabel(record.decision_status)}</td>
                  <td>{record.reject_reason || record.decision_result || '未记录'}</td>
                  <td>{valueLabel(record.flea_market_score)} / {valueLabel(record.front_review_score)}</td>
                  <td>{dateLabel(record.first_seen_at)} / {dateLabel(record.last_seen_at)}<br />出现 {record.seen_count} 次</td>
                  <td>{record.duplicate_status.join('、') || '未见重复'}</td>
                  <td>{record.notes || '无'}</td>
                  <td className="table-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => openProductDetail(record.asin, {
                        source_page: 'history',
                        source_label: '历史库',
                        source_list: sourceList,
                        current_index: sourceList.indexOf(record.asin),
                      })}
                    >
                      详情
                    </button>
                    {(record.decision_status === 'rejected' || record.decision_status === 'abandoned' || record.decision_status === 'removed_from_candidate') && (
                      <button className="secondary-button" type="button" onClick={() => restoreCandidate(record)}>恢复候选</button>
                    )}
                    <button className="secondary-button danger-button" type="button" onClick={() => remove(record.id)}>删除</button>
                  </td>
	                </tr>
	                );
	              })}
            </tbody>
          </table>
          {!filtered.length && <div className="empty-state">历史库暂无记录。</div>}
        </div>
      </section>
    </div>
  );
}

function UnifiedExportPage({ products }: { products: ProductRecord[] }) {
  const [exportType, setExportType] = useState<ExportType>('discovery-current');
  const rows = buildExportRows(exportType, products);
  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>统一导出</h2>
        <p>导出从本地持久化数据读取，不依赖当前页面临时状态。缺失字段会显示空值或“未返回”。</p>
      </div>
      <div className="input-grid compact-filter-grid">
        <label>
          导出对象
          <select value={exportType} onChange={(event) => setExportType(event.target.value as ExportType)}>
            <option value="discovery-current">当前/最近 MCP 找品结果</option>
            <option value="discovery-all">全部 MCP 找品结果</option>
            <option value="candidates">候选池</option>
            <option value="history">历史选品库</option>
            <option value="rejected">已放弃产品</option>
            <option value="developed">已开发产品</option>
            <option value="front-review">前台复核池</option>
            <option value="profit">利润测算结果</option>
            <option value="all">全部运营数据</option>
          </select>
        </label>
        <Metric label="预计导出行数" value={String(rows.length)} />
      </div>
      <div className="action-row">
        <button className="primary-button" type="button" onClick={() => downloadRows(exportType, rows)}>
          导出 CSV
        </button>
        <button className="secondary-button" type="button" onClick={() => downloadCsvText('candidate-legacy', exportCandidatesCsv(loadCandidates()))}>
          导出候选简表
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ASIN</th>
              <th>主图</th>
              <th>标题</th>
              <th>主图 URL</th>
              <th>来源</th>
              <th>价格</th>
              <th>月销量</th>
              <th>评论数</th>
              <th>铺货分</th>
              <th>铺货测试分</th>
              <th>动作建议</th>
              <th>分层</th>
              <th>最终状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((row, index) => (
              <tr key={`${row.ASIN}-${index}`}>
                <td>{row.ASIN}</td>
                <td><ProductThumbnail src={row['主图 URL']} asin={row.ASIN} title={row.标题} size="small" /></td>
                <td>{row.标题}</td>
                <td><span className="export-image-url" title={row['主图 URL']}>{row['主图 URL'] || '未返回'}</span></td>
                <td>{row.来源类型}</td>
                <td>{row.价格}</td>
                <td>{row.月销量}</td>
                <td>{row.评论数}</td>
                <td>{row.flea_market_score}</td>
                <td>{row.listing_test_score}</td>
                <td>{row.action_advice}</td>
                <td>{row.layer}</td>
                <td>{row.decision_status || row.development_status || row.final_manual_decision}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty-state">当前导出对象暂无数据。</div>}
      </div>
    </section>
  );
}

function ExcelImportPage({ products, onProductsChange }: { products: ProductRecord[]; onProductsChange: (products: ProductRecord[]) => void }) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');

  const importRows = () => {
    const rows = parseCsvLike(text);
    if (!rows.length) {
      setMessage('没有识别到可导入数据。');
      return;
    }
    const imported = rows
      .map((row) => excelFromRow(row))
      .filter((row): row is ProductExcelData => Boolean(row));
    if (!imported.length) {
      setMessage('未找到 ASIN 字段，无法导入。');
      return;
    }
    const nextProducts = [
      ...imported.map(createProductFromExcel),
      ...products.filter((product) => !imported.some((item) => item.asin === product.asin)),
    ];
    saveProducts(nextProducts);
    onProductsChange(loadProducts());
    setMessage(`已导入 ${imported.length} 条 Excel/CSV 商品数据。`);
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>Excel导入</h2>
        <p>第一阶段支持粘贴 CSV/表格文本导入。保留原 Excel 数据，不会覆盖 MCP 数据。</p>
      </div>
      <label>
        粘贴 CSV 或从 Excel 复制的表格内容
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="asin,title,price,review_count,monthly_sales..." />
      </label>
      <div className="action-row">
        <button className="primary-button" type="button" onClick={importRows}>导入数据</button>
      </div>
      {message && <p className="save-notice">{message}</p>}
    </section>
  );
}

function DecisionCard({ decision }: { decision: ProductDecisionResult }) {
  const stages = [
    ['Excel 初筛', decision.excel_screening],
    ['MCP 复核', decision.mcp_review],
    ['前台复核', decision.front_review],
    ['利润测算', decision.profit_check],
  ] as const;
  return (
    <section className="content-section decision-card">
      <div className="section-heading">
        <h2>最终决策</h2>
        <p>最终建议：<strong>{decisionLabel(decision.final_decision)}</strong></p>
      </div>
      <div className="decision-grid">
        {stages.map(([title, stage]) => (
          <div className={`decision-stage decision-stage-${stage.status}`} key={title}>
            <span>{title}</span>
            <strong>{stage.label}</strong>
            <small>{stage.reasons[0] ?? '暂无备注'}</small>
          </div>
        ))}
      </div>
      <div className="decision-reasons">
        {decision.reasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </div>
    </section>
  );
}

function DataCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <div className="snapshot-grid">
        {rows.map(([label, value]) => (
          <div className="snapshot-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function excelRows(product: ProductRecord): Array<[string, string]> {
  const excel = product.excel;
  return [
    ['价格', formatMoney(excel.price_mid)],
    ['评论数', valueLabel(excel.review_count)],
    ['评分', valueLabel(excel.rating)],
    ['月销量', valueLabel(excel.monthly_sales)],
    ['月销售额', formatMoney(excel.monthly_revenue)],
    ['BSR', valueLabel(excel.bsr)],
    ['FBA费', formatMoney(excel.fba_fee)],
    ['变体数', valueLabel(excel.variation_count)],
  ];
}

function mcpRows(product: ProductRecord): Array<[string, string]> {
  const mcp = product.mcp_snapshot;
  const resolved = resolveProductData(product);
  return [
    ['价格', formatMoney(mcp?.coupon_price ?? mcp?.price ?? null)],
    ['评论数', valueLabel(mcp?.review_count)],
    ['评分', valueLabel(mcp?.rating)],
    ['月销量', valueLabel(mcp?.monthly_sales ?? mcp?.prediction_summary?.recent_30d_sales)],
    ['月销售额', formatMoney(mcp?.monthly_revenue ?? mcp?.prediction_summary?.recent_30d_revenue ?? null)],
    ['BSR', valueLabel(mcp?.bsr)],
    ['FBA费', `${formatMoney(resolved.fba_fee)} / ${sourceLabel(resolved.fba_fee_source)}`],
    ['佣金比例', `${formatPercent(resolved.referral_fee_rate)} / ${sourceLabel(resolved.referral_fee_rate_source)}`],
    ['主图来源', sourceLabel(resolved.main_image_source)],
    ['上架时间来源', sourceLabel(resolved.listed_at_source)],
    ['变体数', valueLabel(mcp?.variation_count)],
  ];
}

function buildDiffRows(product: ProductRecord): Array<{ label: string; message: string; large: boolean }> {
  const pairs: Array<[string, number | null, number | null, number]> = [
    ['价格', product.excel.price_mid, product.mcp_snapshot?.coupon_price ?? product.mcp_snapshot?.price ?? null, 0.1],
    ['评论数', product.excel.review_count, product.mcp_snapshot?.review_count ?? null, 0.2],
    ['评分', product.excel.rating, product.mcp_snapshot?.rating ?? null, 0.1],
    ['月销量', product.excel.monthly_sales, product.mcp_snapshot?.monthly_sales ?? product.mcp_snapshot?.prediction_summary?.recent_30d_sales ?? null, 0.25],
    ['月销售额', product.excel.monthly_revenue, product.mcp_snapshot?.monthly_revenue ?? product.mcp_snapshot?.prediction_summary?.recent_30d_revenue ?? null, 0.25],
    ['BSR', product.excel.bsr, product.mcp_snapshot?.bsr ?? null, 0.25],
    ['FBA费', product.excel.fba_fee, product.mcp_snapshot?.fba_fee ?? null, 0.15],
    ['变体数', product.excel.variation_count, product.mcp_snapshot?.variation_count ?? null, 0.2],
  ];
  return pairs.map(([label, excel, mcp, threshold]) => {
    if (excel === null || excel === undefined || mcp === null || mcp === undefined) return { label, message: '缺少一侧数据，待补充。', large: false };
    const base = Math.max(Math.abs(excel), 1);
    const diffRate = Math.abs(mcp - excel) / base;
    return { label, message: `Excel ${excel} / MCP ${mcp}，差异 ${(diffRate * 100).toFixed(1)}%`, large: diffRate >= threshold };
  });
}

const developmentStatuses: DevelopmentStatus[] = [
  '待找供应链',
  '已找到货源',
  '待利润测算',
  '已下样品',
  '待拍图/视频',
  '待上架',
  '待SP测试',
  '成功',
  '放弃',
];

type ProfitForm = {
  purchase_cost_rmb: string;
  exchange_rate: string;
  purchase_cost_usd: string;
  first_mile_cost_usd: string;
  package_cost_usd: string;
  storage_cost_usd: string;
  return_loss_rate: string;
  platform_other_fee: string;
  target_price: string;
  fba_fee: string;
  referral_fee_rate: string;
  notes: string;
};

function createProfitForm(product: ProductRecord | undefined): ProfitForm {
  const manual = product?.manual;
  const target = manual?.target_price ?? product?.score.price_margin_score.target_price_5 ?? null;
  const returnLossRate = manual?.return_loss && target ? (manual.return_loss / target) * 100 : null;
  return {
    purchase_cost_rmb: valueForInput(manual?.purchase_cost_rmb),
    exchange_rate: valueForInput(manual?.exchange_rate ?? 7.2),
    purchase_cost_usd: valueForInput(manual?.purchase_cost_usd),
    first_mile_cost_usd: valueForInput(manual?.first_mile_cost_usd),
    package_cost_usd: valueForInput(manual?.package_cost_usd),
    storage_cost_usd: valueForInput(manual?.storage_cost_usd),
    return_loss_rate: valueForInput(returnLossRate),
    platform_other_fee: valueForInput(manual?.platform_other_fee),
    target_price: valueForInput(target),
    fba_fee: valueForInput(manual?.fba_fee ?? product?.mcp_snapshot?.fba_fee),
    referral_fee_rate: valueForInput(manual?.referral_fee_rate ?? 0.15),
    notes: manual?.notes ?? '',
  };
}

function calculateProfitPreview(product: ProductRecord, form: ProfitForm) {
  const targetPrice = numberFromText(form.target_price) ?? product.score.price_margin_score.target_price_5;
  const referralRate = numberFromText(form.referral_fee_rate) ?? 0.15;
  const fbaFee = numberFromText(form.fba_fee) ?? resolveProductData(product).fba_fee;
  const exchangeRate = numberFromText(form.exchange_rate) ?? 7.2;
  const purchaseRmb = numberFromText(form.purchase_cost_rmb);
  const purchaseUsd = purchaseRmb !== null && exchangeRate > 0 ? purchaseRmb / exchangeRate : numberFromText(form.purchase_cost_usd);
  const firstMile = numberFromText(form.first_mile_cost_usd) ?? 0;
  const packageCost = numberFromText(form.package_cost_usd) ?? 0;
  const storage = numberFromText(form.storage_cost_usd) ?? 0;
  const other = numberFromText(form.platform_other_fee) ?? 0;
  const returnLoss = targetPrice !== null ? targetPrice * ((numberFromText(form.return_loss_rate) ?? 0) / 100) : 0;
  const referralFee = targetPrice !== null ? targetPrice * referralRate : null;
  const platformMarginRate =
    targetPrice !== null && referralFee !== null && fbaFee !== null
      ? (targetPrice - referralFee - fbaFee - other) / targetPrice
      : null;
  const fullCosts =
    targetPrice !== null && referralFee !== null && fbaFee !== null
      ? (purchaseUsd ?? 0) + firstMile + packageCost + storage + returnLoss + other + referralFee + fbaFee
      : null;
  const fullProfit = targetPrice !== null && fullCosts !== null ? targetPrice - fullCosts : null;
  const fullMarginRate = targetPrice !== null && fullProfit !== null ? fullProfit / targetPrice : null;
  const verdict =
    platformMarginRate === null
      ? '平台后毛利待补充。'
      : platformMarginRate < 0.6
        ? '平台后毛利不足，暂不建议开发。'
        : fullMarginRate === null
          ? '平台后毛利达标，全成本待测算。'
          : fullMarginRate >= 0.25
            ? '全成本毛利达标。'
            : fullMarginRate >= 0.18
              ? '全成本毛利偏低，需要压采购或物流。'
              : '全成本毛利不足，不建议开发。';
  return {
    target_price: targetPrice,
    purchase_cost_usd: purchaseUsd,
    referral_fee: referralFee,
    platform_margin_rate: platformMarginRate,
    full_profit: fullProfit,
    full_margin_rate: fullMarginRate,
    break_even_acos: fullMarginRate !== null ? Math.max(0, fullMarginRate) : null,
    verdict,
  };
}

function NumberInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} inputMode="decimal" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function numberFromText(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function valueForInput(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(4))) : '';
}

function sourceLabel(source: string | null | undefined): string {
  const labels: Record<string, string> = {
    mcp: 'MCP返回',
    manual: '人工录入',
    estimated: '系统估算',
    missing: '未返回/待补充',
    default_rate: '系统默认估算',
    amazon_front: 'Amazon前台',
    excel: 'Excel',
  };
  return labels[source ?? 'missing'] ?? source ?? '未返回';
}

function productMainImageUrl(
  product?: ProductRecord | null,
  candidate?: McpCandidateRecord | null,
  history?: HistoryRecord | null,
  development?: DevelopmentRecord | null,
): string | null {
  const resolved = product ? resolveProductData(product) : null;
  return (
    resolved?.main_image_url ??
    product?.mcp_snapshot?.main_image_url ??
    candidate?.mcp_result?.main_image_url ??
    candidate?.product?.main_image_url ??
    candidate?.discovery_product?.main_image_url ??
    history?.main_image_url ??
    development?.main_image_url ??
    extractImageUrl(candidate?.discovery_product?.raw) ??
    extractImageUrl(candidate?.validation) ??
    null
  );
}

function candidateTitle(candidate: McpCandidateRecord | undefined, product?: ProductRecord): string {
  const resolved = product ? resolveProductData(product) : null;
  return (
    resolved?.title ??
    candidate?.discovery_product?.title ??
    candidate?.mcp_result?.title ??
    candidate?.excel_result?.title ??
    candidate?.product?.title ??
    '未返回'
  );
}

function candidateCategory(candidate: McpCandidateRecord | undefined, product?: ProductRecord): string {
  const resolved = product ? resolveProductData(product) : null;
  return (
    resolved?.category ??
    candidate?.discovery_product?.category_path ??
    candidate?.discovery_product?.category ??
    candidate?.mcp_result?.category ??
    candidate?.excel_result?.category ??
    ''
  );
}

function decisionStatusLabel(status: CandidateDecisionStatus): string {
  const labels: Record<CandidateDecisionStatus, string> = {
    candidate: '已候选',
    removed_from_candidate: '已移出候选',
    abandoned: '已放弃',
    rejected: '已放弃',
    developed: '已开发',
    development: '开发中',
    launched: '已上架',
  };
  return labels[status] ?? status;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return '未返回';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createCandidateFromProduct(product: ProductRecord): McpCandidateRecord {
  const resolved = resolveProductData(product);
  const target = product.score.price_margin_score.target_price_5;
  const referralRate = product.manual.referral_fee_rate ?? 0.15;
  return createCandidateRecord({
    asin: product.asin,
    keyword: product.mcp_snapshot?.main_keyword ?? '',
    product,
    validation: {
      asin: product.asin,
      keyword: product.mcp_snapshot?.main_keyword ?? '',
      main_keyword: product.mcp_snapshot?.main_keyword ?? '',
      long_tail_keywords: product.mcp_snapshot?.long_tail_keywords ?? [],
      keyword_snapshots: product.mcp_snapshot?.keyword_snapshots ?? [],
      status: product.mcp_status === 'failed' ? 'failed' : 'success',
      checked_at: product.mcp_checked_at ?? new Date().toISOString(),
      asin_detail: null,
      asin_prediction: null,
      traffic_keyword_stat: null,
      keyword_miner: null,
      errors: product.mcp_error ? [product.mcp_error] : [],
    },
    costs: {
      target_discount_rate: 0.05,
      referral_fee_rate: referralRate,
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
    },
    margin: {
      base_price: resolved.competitor_price,
      target_price: target,
      referral_fee: target !== null ? target * referralRate : null,
      fba_fee: resolved.fba_fee,
      platform_margin_rate: product.score.price_margin_score.platform_margin_rate,
      product_full_cost: product.score.final_margin_score.full_costs,
      final_margin_rate: product.score.final_margin_score.full_margin_rate,
      platform_margin_pass: (product.score.price_margin_score.platform_margin_rate ?? 0) >= 0.6,
      final_margin_pass: (product.score.final_margin_score.full_margin_rate ?? 0) >= 0.25,
      warnings: [...product.score.price_margin_score.notes, ...product.score.final_margin_score.notes],
    },
    notes: product.manual.notes,
  });
}

type ExportType = 'discovery-current' | 'discovery-all' | 'candidates' | 'history' | 'rejected' | 'developed' | 'front-review' | 'profit' | 'all';
type ExportRow = Record<string, string>;

const exportHeaders = [
  'ASIN',
  'parent_asin',
  '标题',
  '品牌',
  '类目',
  '类目路径',
  '来源类型',
  '来源关键词',
  '来源节点',
  '商品链接',
  '主图 URL',
  '主图来源',
  '价格',
  'coupon_price',
  '月销量',
  '月销售额',
  '评论数',
  '评分',
  'BSR',
  '变体数',
  '上架时间',
  '上架天数',
  '上架时间来源',
  'sales_per_review',
  'new_product_sales_signal',
  'new_product_sales_signal_score',
  'listing_test_score',
  'action_advice',
  'why_testable',
  'why_not_e',
  'missing_review_items',
  'suitable_small_batch',
  'suitable_low_cost_test',
  'low_review_sales_signal',
  'low_review_sales_score',
  'score_explanation',
  '便宜3%目标价',
  '便宜5%目标价',
  '便宜8%目标价',
  '便宜10%目标价',
  'FBA费用',
  'FBA费用来源',
  'referral_fee_rate',
  'referral_fee_rate_source',
  '平台佣金',
  '平台后毛利率',
  '全成本毛利率',
  '全成本毛利状态',
  'main_keyword',
  'long_tail_keywords',
  'long_tail_opportunity_level',
  'keyword_data_confidence',
  'recommended_sp_keywords',
  'rejected_keywords',
  'low_bid_ad_score',
  'PPC',
  '搜索量',
  '广告竞品数',
  '标题密度',
  'flea_market_score',
  'layer',
  'layer_reasons',
  'risk_flags',
  'data_flags',
  'action_flags',
  'rating_risk_level',
  'rating_risk_note',
  'duplicate_status',
  'decision_status',
  'decision_result',
  'reject_reason',
  'similar_asin',
  'history_notes',
  'first_seen_at',
  'last_seen_at',
  'seen_count',
  'mcp_status',
  'mcp_checked_at',
  'mcp_error',
  'front_review_status',
  'front_review_score',
  'front_review_level',
  'final_manual_decision',
  'front_review_notes',
  'development_status',
  'owner',
  'supplier_url',
  'purchase_cost_rmb',
  'sample_status',
  'listing_status',
  'ad_status',
  'notes',
] as const;

function buildExportRows(type: ExportType | 'development-pool' | 'history-library', products: ProductRecord[]): ExportRow[] {
  const candidates = loadCandidates();
  const history = loadHistoryRecords();
  const development = loadDevelopmentRecords();
  const runs = loadDiscoveryRuns();
  const allDiscovery = loadAllDiscoveryResults();
  const latestRun = runs.find((run) => getDiscoveryResultsByRunId(run.id).length > 0);
  const productMap = new Map(products.map((product) => [product.asin, product]));
  const devMap = new Map(development.map((record) => [record.asin, record]));
  const historyMap = new Map(history.map((record) => [record.asin, record]));
  const candidateMap = new Map(candidates.map((candidate) => [candidate.asin, candidate]));

  if (type === 'discovery-current') {
    return latestRun ? getDiscoveryResultsByRunId(latestRun.id).map((result) => exportRowFromDiscovery(result, productMap.get(result.asin), candidateMap.get(result.asin), devMap.get(result.asin), historyMap.get(result.asin))) : [];
  }
  if (type === 'discovery-all') {
    return allDiscovery.map((result) => exportRowFromDiscovery(result, productMap.get(result.asin), candidateMap.get(result.asin), devMap.get(result.asin), historyMap.get(result.asin)));
  }
  if (type === 'candidates') {
    return candidates.map((candidate) => exportRowFromProduct(productMap.get(candidate.asin), candidate, devMap.get(candidate.asin), historyMap.get(candidate.asin)));
  }
  if (type === 'history' || type === 'history-library') {
    return history.map((record) => exportRowFromProduct(productMap.get(record.asin), candidateMap.get(record.asin), devMap.get(record.asin), record));
  }
  if (type === 'rejected') {
    const rejectedAsins = new Set([
      ...candidates.filter((candidate) => candidate.decision_status === 'rejected' || candidate.decision_status === 'abandoned').map((candidate) => candidate.asin),
      ...history.filter((record) => record.decision_status === 'rejected' || record.decision_status === 'abandoned').map((record) => record.asin),
    ]);
    return Array.from(rejectedAsins).map((asin) => exportRowFromProduct(productMap.get(asin), candidateMap.get(asin), devMap.get(asin), historyMap.get(asin)));
  }
  if (type === 'developed' || type === 'development-pool') {
    return development.map((record) => exportRowFromProduct(productMap.get(record.asin), candidateMap.get(record.asin), record, historyMap.get(record.asin)));
  }
  if (type === 'front-review') {
    return products.filter((product) => product.front_review.status !== 'not_started').map((product) => exportRowFromProduct(product, candidateMap.get(product.asin), devMap.get(product.asin), historyMap.get(product.asin)));
  }
  if (type === 'profit') {
    return products.filter((product) => product.score.final_margin_score.cost_confirmed || product.manual.target_price !== null).map((product) => exportRowFromProduct(product, candidateMap.get(product.asin), devMap.get(product.asin), historyMap.get(product.asin)));
  }
  const asins = new Set([
    ...products.map((product) => product.asin),
    ...candidates.map((candidate) => candidate.asin),
    ...history.map((record) => record.asin),
    ...development.map((record) => record.asin),
    ...allDiscovery.map((result) => result.asin),
  ]);
  return Array.from(asins).map((asin) => {
    const discovery = allDiscovery.find((result) => result.asin === asin);
    if (discovery) return exportRowFromDiscovery(discovery, productMap.get(asin), candidateMap.get(asin), devMap.get(asin), historyMap.get(asin));
    return exportRowFromProduct(productMap.get(asin), candidateMap.get(asin), devMap.get(asin), historyMap.get(asin));
  });
}

function exportRowFromDiscovery(
  result: DiscoveryResult,
  product?: ProductRecord,
  candidate?: McpCandidateRecord,
  development?: DevelopmentRecord,
  history?: HistoryRecord,
): ExportRow {
  const row = exportRowFromProduct(product, candidate, development, history);
  return {
    ...row,
    ASIN: result.asin,
    parent_asin: clean(result.parent_asin),
    标题: clean(result.title || row.标题),
    品牌: clean(result.brand || row.品牌),
    类目: clean(result.category || row.类目),
    类目路径: clean(result.category_path || row.类目路径),
    来源类型: 'mcp_category_discovery',
    来源关键词: clean(result.source_keyword),
    来源节点: clean(result.category_node_id),
    商品链接: clean(result.product_url),
    '主图 URL': clean(result.main_image_url || row['主图 URL']),
    主图来源: sourceLabel(result.main_image_source ?? row.主图来源),
    价格: clean(result.price ?? row.价格),
    coupon_price: clean(result.coupon_price ?? row.coupon_price),
    月销量: clean(result.monthly_sales ?? row.月销量),
    月销售额: clean(result.monthly_revenue ?? row.月销售额),
    评论数: clean(result.review_count ?? row.评论数),
    评分: clean(result.rating ?? row.评分),
    BSR: clean(result.bsr ?? row.BSR),
    上架时间: clean(result.listed_at ?? row.上架时间),
    上架天数: clean(result.product_age_days ?? row.上架天数),
    上架时间来源: sourceLabel(result.listed_at_source ?? row.上架时间来源),
    sales_per_review: clean(result.sales_per_review ?? row.sales_per_review),
    new_product_sales_signal: clean(result.new_product_sales_signal ?? row.new_product_sales_signal),
    new_product_sales_signal_score: clean(result.new_product_sales_signal_score ?? row.new_product_sales_signal_score),
    listing_test_score: clean(result.listing_test_score ?? row.listing_test_score),
    action_advice: clean(result.action_advice ?? row.action_advice),
    why_testable: (result.why_testable ?? []).join('|') || row.why_testable,
    why_not_e: (result.why_not_e ?? []).join('|') || row.why_not_e,
    missing_review_items: (result.missing_review_items ?? []).join('|') || row.missing_review_items,
    suitable_small_batch: typeof result.suitable_small_batch === 'boolean' ? (result.suitable_small_batch ? '是' : '否') : row.suitable_small_batch,
    suitable_low_cost_test: typeof result.suitable_low_cost_test === 'boolean' ? (result.suitable_low_cost_test ? '是' : '否') : row.suitable_low_cost_test,
    score_explanation: (result.score_explanation ?? []).join('|') || row.score_explanation,
    平台后毛利率: clean(result.platform_margin_rate ?? row.平台后毛利率),
    flea_market_score: clean(result.flea_market_score ?? row.flea_market_score),
    layer: clean(result.layer ?? row.layer),
    duplicate_status: result.duplicate_status.join('|') || row.duplicate_status,
    risk_flags: result.risk_flags.join('|') || row.risk_flags,
    data_flags: result.data_flags.join('|') || row.data_flags,
    action_flags: result.action_flags.join('|') || row.action_flags,
    first_seen_at: clean(result.created_at),
    last_seen_at: clean(result.created_at),
  };
}

function exportRowFromProduct(
  product?: ProductRecord,
  candidate?: McpCandidateRecord,
  development?: DevelopmentRecord,
  history?: HistoryRecord,
): ExportRow {
  const resolved = product ? resolveProductData(product) : null;
  const mainKeyword = product?.mcp_snapshot?.main_keyword ?? candidate?.main_keyword ?? '';
  const mainSnapshot = product?.mcp_snapshot?.keyword_snapshots.find((item) => item.keyword_type === 'main') ?? candidate?.keyword_snapshots?.find((item) => item.keyword_type === 'main') ?? null;
  const target = product?.score.price_margin_score;
  const referralRate = resolved?.referral_fee_rate ?? candidate?.costs.referral_fee_rate ?? 0.15;
  const target5 = target?.target_price_5 ?? candidate?.margin.target_price ?? null;
  const referralFee = target5 !== null ? target5 * referralRate : candidate?.margin.referral_fee ?? null;
  const costStatus = product?.score.final_margin_score.cost_confirmed ? '已测算' : '待测算';
  const actionFlags = product?.decision.reasons ?? [];
  const mainImageUrl = productMainImageUrl(product, candidate, history, development);
  const mainImageSource =
    resolved?.main_image_source ??
    product?.mcp_snapshot?.main_image_source ??
    candidate?.mcp_result?.main_image_source ??
    candidate?.product?.main_image_source ??
    candidate?.discovery_product?.main_image_source ??
    history?.main_image_source ??
    development?.main_image_source ??
    (mainImageUrl ? 'mcp' : 'missing');
  return baseExportRow({
    ASIN: product?.asin ?? candidate?.asin ?? history?.asin ?? development?.asin ?? '',
    parent_asin: candidate?.discovery_product?.parent_asin ?? history?.parent_asin ?? '',
    标题: resolved?.title ?? candidate?.mcp_result?.title ?? candidate?.excel_result?.title ?? history?.title ?? '',
    品牌: resolved?.brand ?? candidate?.mcp_result?.brand ?? candidate?.excel_result?.brand ?? '',
    类目: resolved?.category ?? candidate?.mcp_result?.category ?? candidate?.excel_result?.category ?? '',
    类目路径: candidate?.discovery_product?.category_path ?? resolved?.category ?? '',
    来源类型: candidate?.source_data ?? history?.source ?? 'product',
    来源关键词: candidate?.keyword ?? mainKeyword,
    来源节点: candidate?.discovery_product?.category_node_id ?? '',
    商品链接: product?.asin ? `https://www.amazon.com/dp/${product.asin}` : '',
    '主图 URL': mainImageUrl ?? '',
    主图来源: sourceLabel(mainImageSource),
    价格: resolved?.competitor_price ?? '',
    coupon_price: product?.mcp_snapshot?.coupon_price ?? '',
    月销量: resolved?.monthly_sales ?? '',
    月销售额: resolved?.monthly_revenue ?? '',
    评论数: resolved?.review_count ?? '',
    评分: resolved?.rating ?? '',
    BSR: resolved?.bsr ?? '',
    变体数: resolved?.variation_count ?? '',
    上架时间: resolved?.listed_at ?? resolved?.launch_date ?? resolved?.first_available_date ?? '',
    上架天数: resolved?.product_age_days ?? '',
    上架时间来源: sourceLabel(resolved?.listed_at_source),
    sales_per_review: product?.score.low_review_sales_score.sales_per_review ?? '',
    new_product_sales_signal: product?.score.new_product_sales_signal_score.signal_label ?? '',
    new_product_sales_signal_score: product?.score.new_product_sales_signal_score.score ?? '',
    listing_test_score: product?.score.listing_test_score.score ?? '',
    action_advice: product?.score.action_advice ?? '',
    why_testable: (product?.score.listing_test_score.why_testable ?? []).join('|'),
    why_not_e: (product?.score.listing_test_score.why_not_e ?? []).join('|'),
    missing_review_items: (product?.score.listing_test_score.missing_review_items ?? []).join('|'),
    suitable_small_batch: product ? (product.score.listing_test_score.suitable_small_batch ? '是' : '否') : '',
    suitable_low_cost_test: product ? (product.score.listing_test_score.suitable_low_cost_test ? '是' : '否') : '',
    low_review_sales_signal: product?.score.low_review_sales_score.signal ?? '',
    low_review_sales_score: product?.score.low_review_sales_score.score ?? '',
    score_explanation: (product?.score.new_product_sales_signal_score.explanation ?? []).join('|'),
    '便宜3%目标价': target?.target_price_3 ?? '',
    '便宜5%目标价': target?.target_price_5 ?? '',
    '便宜8%目标价': target?.target_price_8 ?? '',
    '便宜10%目标价': target?.target_price_10 ?? '',
    FBA费用: resolved?.fba_fee ?? candidate?.margin.fba_fee ?? '',
    FBA费用来源: sourceLabel(resolved?.fba_fee_source),
    referral_fee_rate: referralRate,
    referral_fee_rate_source: sourceLabel(resolved?.referral_fee_rate_source),
    平台佣金: referralFee ?? '',
    平台后毛利率: product?.score.price_margin_score.platform_margin_rate ?? candidate?.margin.platform_margin_rate ?? '',
    全成本毛利率: product?.score.final_margin_score.full_margin_rate ?? candidate?.margin.final_margin_rate ?? '',
    全成本毛利状态: costStatus,
    main_keyword: mainKeyword,
    long_tail_keywords: (product?.mcp_snapshot?.long_tail_keywords ?? candidate?.long_tail_keywords ?? []).join('|'),
    long_tail_opportunity_level: product?.mcp_snapshot?.long_tail_opportunity_level ?? candidate?.long_tail_opportunity_level ?? '',
    keyword_data_confidence: product?.mcp_snapshot?.keyword_data_confidence ?? candidate?.keyword_data_confidence ?? '',
    recommended_sp_keywords: (product?.mcp_snapshot?.recommended_sp_keywords ?? candidate?.recommended_sp_keywords ?? []).join('|'),
    rejected_keywords: (product?.mcp_snapshot?.rejected_keywords ?? candidate?.rejected_keywords ?? []).join('|'),
    low_bid_ad_score: product?.score.low_bid_ad_score.score ?? candidate?.low_bid_ad_score ?? '',
    PPC: mainSnapshot?.ppc_bid ?? '',
    搜索量: mainSnapshot?.search_volume ?? '',
    广告竞品数: mainSnapshot?.ad_competitor_count ?? '',
    标题密度: mainSnapshot?.title_density ?? '',
    flea_market_score: product?.score.flea_market_score ?? candidate?.flea_market_score ?? history?.flea_market_score ?? '',
    layer: product?.score.layer ?? '',
    layer_reasons: (product?.score.layer_reasons ?? []).join('|'),
    risk_flags: (product?.manual.risk_tags ?? []).join('|'),
    data_flags: (resolved?.missing_notes ?? []).join('|'),
    action_flags: [...(product?.score.new_product_sales_signal_score.action_flags ?? []), ...actionFlags].join('|'),
    rating_risk_level: product?.score.rating_risk_level ?? '',
    rating_risk_note: product?.score.rating_risk_note ?? '',
    duplicate_status: (candidate?.duplicate_status ?? history?.duplicate_status ?? []).join('|'),
    decision_status: candidate?.decision_status ?? history?.decision_status ?? '',
    decision_result: product?.decision.final_decision ?? candidate?.final_advice ?? history?.decision_result ?? '',
    reject_reason: history?.reject_reason ?? '',
    similar_asin: history?.similar_asin ?? '',
    history_notes: history?.notes ?? '',
    first_seen_at: history?.first_seen_at ?? candidate?.saved_at ?? '',
    last_seen_at: history?.last_seen_at ?? product?.mcp_checked_at ?? '',
    seen_count: history?.seen_count ?? '',
    mcp_status: product?.mcp_status ?? '',
    mcp_checked_at: product?.mcp_checked_at ?? '',
    mcp_error: product?.mcp_error ?? '',
    front_review_status: product?.front_review.status ?? candidate?.front_review_status ?? '',
    front_review_score: product?.front_review.front_review_score ?? candidate?.front_review?.front_review_score ?? history?.front_review_score ?? '',
    front_review_level: product?.front_review.front_review_level ?? candidate?.front_review?.front_review_level ?? '',
    final_manual_decision: product?.front_review.final_manual_decision ?? candidate?.front_review?.final_manual_decision ?? '',
    front_review_notes: product?.front_review.notes ?? candidate?.front_review?.notes ?? '',
    development_status: development?.status ?? '',
    owner: development?.owner ?? '',
    supplier_url: development?.supplier_url ?? '',
    purchase_cost_rmb: development?.purchase_cost_rmb ?? product?.manual.purchase_cost_rmb ?? '',
    sample_status: development?.sample_status ?? '',
    listing_status: development?.listing_status ?? '',
    ad_status: development?.ad_status ?? '',
    notes: development?.notes ?? candidate?.notes ?? product?.manual.notes ?? '',
  });
}

function baseExportRow(values: Record<string, unknown>): ExportRow {
  return Object.fromEntries(exportHeaders.map((header) => [header, clean(values[header])]));
}

function clean(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '';
  return String(value).replace(/\r?\n/g, ' ').trim();
}

function downloadRows(type: string, rows: ExportRow[]) {
  const csv = [exportHeaders.join(','), ...rows.map((row) => exportHeaders.map((header) => csvEscape(row[header])).join(','))].join('\n');
  downloadCsvText(type, csv);
}

function downloadCsvText(type: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${type}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function csvEscape(value: string): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function parseCsvLike(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const separator = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(separator).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(separator);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? '']));
  });
}

function rowValue(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (row[lower]) return row[lower];
  }
  return '';
}

function excelFromRow(row: Record<string, string>): ProductExcelData | null {
  const asin = rowValue(row, 'asin', 'ASIN').trim();
  if (!asin) return null;
  return {
    asin,
    title: rowValue(row, 'title', '标题') || null,
    brand: rowValue(row, 'brand', '品牌') || null,
    category: rowValue(row, 'category', '类目') || null,
    price_mid: numberFromText(rowValue(row, 'price', 'price_mid', '价格')),
    rating: numberFromText(rowValue(row, 'rating', '评分')),
    review_count: numberFromText(rowValue(row, 'review_count', 'reviews', '评论数')),
    monthly_sales: numberFromText(rowValue(row, 'monthly_sales', '销量', '月销量')),
    monthly_revenue: numberFromText(rowValue(row, 'monthly_revenue', '月销售额')),
    bsr: numberFromText(rowValue(row, 'bsr', 'BSR')),
    fba_fee: numberFromText(rowValue(row, 'fba_fee', 'FBA费用')),
    seller: rowValue(row, 'seller', '卖家') || null,
    seller_type: rowValue(row, 'seller_type', '卖家类型') || null,
    variation_count: numberFromText(rowValue(row, 'variation_count', '变体数')),
    fulfillment_type: rowValue(row, 'fulfillment_type', '配送方式') || null,
    raw: row,
  };
}

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未返回';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未返回';
  return String(value);
}

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未返回';
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '待补充';
  return `${(value * 100).toFixed(1)}%`;
}

function frontReviewStatusLabel(status: FrontReviewStatus): string {
  const labels: Record<FrontReviewStatus, string> = {
    not_started: '未开始',
    in_progress: '复核中',
    passed: '通过',
    failed: '不通过',
    need_second_check: '待二次确认',
  };
  return labels[status];
}

function decisionLabel(decision: ProductDecisionResult['final_decision']): string {
  const labels: Record<ProductDecisionResult['final_decision'], string> = {
    develop: '开发',
    small_test: '小批量测试',
    wait: '等待',
    reject: '放弃',
  };
  return labels[decision];
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlaceholderPage({ page }: { page: string }) {
  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>{page}</h2>
        <p>项目第一版已保留该业务入口，后续可以继续接入 Excel 数据、筛选、分页、利润测算和导出流程。</p>
      </div>
      <div className="placeholder-grid">
        <div className="placeholder-panel">
          <strong>当前状态</strong>
          <span>入口已创建</span>
        </div>
        <div className="placeholder-panel">
          <strong>下一步</strong>
          <span>等 MCP 字段稳定后再接入批量流程</span>
        </div>
      </div>
    </section>
  );
}

export default App;
