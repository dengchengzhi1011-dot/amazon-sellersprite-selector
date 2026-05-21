import { useEffect, useMemo, useState } from 'react';
import FrontReviewPanel from './components/FrontReviewPanel';
import McpDiscoveryPage from './pages/McpDiscoveryPage';
import McpValidationPage from './pages/McpValidationPage';
import type { FrontReview, FrontReviewStatus, KeywordSnapshot, ProductDecisionResult, ProductRecord } from './types/mcp';
import { loadProducts, updateProductFrontReview } from './utils/productStore';
import { resolveProductData } from './utils/scoring';
import { longTailOpportunityLabel } from './utils/keywordTools';

type AppPage =
  | 'mcp-discovery'
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

const navItems: Array<{ key: AppPage; label: string }> = [
  { key: 'mcp-discovery', label: 'MCP找品' },
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

function readInitialPage(): AppPage {
  const params = new URLSearchParams(window.location.search);
  const page = params.get('page') as AppPage | null;
  return navItems.some((item) => item.key === page) ? page! : 'mcp-discovery';
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

function App() {
  const [activePage, setActivePage] = useState<AppPage>(() => readInitialPage());
  const [collapsed, setCollapsed] = useState(false);
  const [mcpAsin, setMcpAsin] = useState(() => new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
  const [mcpSeed, setMcpSeed] = useState<ValidationSeed>(() => readValidationSeed());
  const [detailAsin, setDetailAsin] = useState(() => new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
  const [products, setProducts] = useState<ProductRecord[]>(() => loadProducts());

  useEffect(() => {
    const onPopState = () => {
      setActivePage(readInitialPage());
      setMcpAsin(new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
      setMcpSeed(readValidationSeed());
      setDetailAsin(new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
    };
    const reloadProducts = () => setProducts(loadProducts());
    window.addEventListener('popstate', onPopState);
    window.addEventListener('focus', reloadProducts);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('focus', reloadProducts);
    };
  }, []);

  const navigate = (page: AppPage, params?: Record<string, string>) => {
    const next = new URLSearchParams();
    next.set('page', page);
    Object.entries(params ?? {}).forEach(([key, value]) => {
      if (value) next.set(key, value);
    });
    window.history.pushState(null, '', `?${next.toString()}`);
    setActivePage(page);
    if (params?.asin) setMcpAsin(params.asin);
    if (page === 'mcp-validation') {
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

  const title = useMemo(() => navItems.find((item) => item.key === activePage)?.label ?? 'MCP找品', [activePage]);
  const saveFrontReview = (asin: string, review: FrontReview) => setProducts((current) => updateProductFrontReview(current, asin, review));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">AS</div>
          {!collapsed && (
            <div>
              <div className="brand-title">SellerSprite Selector</div>
              <div className="brand-subtitle">铺货单品验证</div>
            </div>
          )}
        </div>
        <button className="nav-toggle" type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? '展开' : '收缩'}
        </button>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => (
            <button
              className={`nav-item ${activePage === item.key ? 'nav-item-active' : ''}`}
              key={item.key}
              type="button"
              onClick={() => navigate(item.key)}
              title={item.label}
            >
              <span className="nav-dot" />
              {!collapsed && <span>{item.label}</span>}
            </button>
          ))}
        </nav>
      </aside>

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
            onOpenReview={(asin) => navigate('product-detail', { asin })}
            onOpenDevelopment={() => navigate('development')}
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
          <ProductListPage products={products} navigate={navigate} reload={() => setProducts(loadProducts())} />
        ) : activePage === 'product-detail' ? (
          <ProductDetailPage product={products.find((product) => product.asin === detailAsin) ?? products[0]} navigate={navigate} onSaveReview={saveFrontReview} />
        ) : activePage === 'review' ? (
          <FrontReviewPoolPage products={products} navigate={navigate} onSaveReview={saveFrontReview} />
        ) : (
          <PlaceholderPage page={title} />
        )}
      </main>
    </div>
  );
}

function ProductListPage({ products, navigate, reload }: { products: ProductRecord[]; navigate: (page: AppPage, params?: Record<string, string>) => void; reload: () => void }) {
  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>候选池</h2>
        <p>MCP 类目找品、Excel 原始数据与 MCP 复核数据分开保存，列表评分优先使用 MCP 最新数据。</p>
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-button" type="button" onClick={reload}>
          刷新本地商品
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ASIN</th>
              <th>标题</th>
              <th>MCP状态</th>
              <th>最近MCP复核时间</th>
              <th>低评论出单信号</th>
              <th>平台后毛利率</th>
              <th>全成本毛利率</th>
              <th>低竞价广告机会</th>
              <th>最终铺货分</th>
              <th>分层</th>
              <th>前台复核状态</th>
              <th>前台复核分</th>
              <th>最终建议</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <ProductRow key={product.asin} product={product} navigate={navigate} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProductRow({ product, navigate }: { product: ProductRecord; navigate: (page: AppPage, params?: Record<string, string>) => void }) {
  const resolved = resolveProductData(product);
  const score = product.score;
  return (
    <tr>
      <td>{product.asin}</td>
      <td>{resolved.title || '未返回'}</td>
      <td><StatusBadge product={product} /></td>
      <td>{product.mcp_checked_at ? new Date(product.mcp_checked_at).toLocaleString() : '未复核'}</td>
      <td>{score.low_review_sales_score.signal}</td>
      <td>{formatPercent(score.price_margin_score.platform_margin_rate)}</td>
      <td>{formatPercent(score.final_margin_score.full_margin_rate)}</td>
      <td>{score.low_bid_ad_score.signal}</td>
      <td><strong>{score.flea_market_score}</strong></td>
      <td>{score.layer}</td>
      <td>{frontReviewStatusLabel(product.front_review.status)}</td>
      <td>{product.front_review.front_review_score}</td>
      <td>{decisionLabel(product.decision.final_decision)}</td>
      <td className="table-actions">
        <button className="secondary-button" type="button" onClick={() => navigate('mcp-validation', { asin: product.asin })}>
          发送到 MCP 验证
        </button>
        <button className="secondary-button" type="button" onClick={() => navigate('product-detail', { asin: product.asin })}>
          商品详情
        </button>
      </td>
    </tr>
  );
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
  navigate,
  onSaveReview,
}: {
  product: ProductRecord | undefined;
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  onSaveReview: (asin: string, review: FrontReview) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'front-review'>('overview');
  if (!product) return <PlaceholderPage page="商品详情" />;
  const resolved = resolveProductData(product);
  const diffRows = buildDiffRows(product);
  const hasLargeDiff = diffRows.some((row) => row.large);

  return (
    <div className="detail-stack">
      <section className="content-section">
        <div className="section-heading">
          <h2>{resolved.title || product.asin}</h2>
          <p>当前评分：{product.score.flea_market_score} 分，分层：{product.score.layer}</p>
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
            </div>
          </section>
        </>
      )}
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
        <p>长尾机会：{longTailOpportunityLabel(snapshot?.long_tail_opportunity_level ?? 'unknown')}，广告机会分 {product.score.low_bid_ad_score.score}/15。</p>
      </div>
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
  navigate,
  onSaveReview,
}: {
  products: ProductRecord[];
  navigate: (page: AppPage, params?: Record<string, string>) => void;
  onSaveReview: (asin: string, review: FrontReview) => void;
}) {
  const [selectedAsin, setSelectedAsin] = useState(products[0]?.asin ?? '');
  const selected = products.find((product) => product.asin === selectedAsin) ?? products[0];

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
                  <td>{resolveProductData(product).title || '未返回'}</td>
                  <td><StatusBadge product={product} /></td>
                  <td>{frontReviewStatusLabel(product.front_review.status)}</td>
                  <td>{product.front_review.front_review_score}</td>
                  <td>{decisionLabel(product.decision.final_decision)}</td>
                  <td className="table-actions">
                    <button className="secondary-button" type="button" onClick={() => setSelectedAsin(product.asin)}>
                      前台复核
                    </button>
                    <button className="secondary-button" type="button" onClick={() => navigate('product-detail', { asin: product.asin })}>
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
  return [
    ['价格', formatMoney(mcp?.coupon_price ?? mcp?.price ?? null)],
    ['评论数', valueLabel(mcp?.review_count)],
    ['评分', valueLabel(mcp?.rating)],
    ['月销量', valueLabel(mcp?.monthly_sales ?? mcp?.prediction_summary?.recent_30d_sales)],
    ['月销售额', formatMoney(mcp?.monthly_revenue ?? mcp?.prediction_summary?.recent_30d_revenue ?? null)],
    ['BSR', valueLabel(mcp?.bsr)],
    ['FBA费', formatMoney(mcp?.fba_fee)],
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
