import { useMemo, useState } from 'react';
import ProductThumbnail from '../components/ProductThumbnail';
import type { McpDiscoveredProduct, ProductRecord, SellerStoreSummary, SellerStoreTrackingRecord } from '../types/mcp';
import { loadCandidates, saveProducts, upsertDiscoveryCandidate, upsertDiscoveryProduct } from '../utils/productStore';
import { productResearchBySeller, productResearchByMarket, fetchSellerFromAsin, getMcpFriendlyError } from '../utils/sellerspriteMcp';
import { createProductFromDiscovery } from '../utils/productStore';

const trackedStoresKey = 'amazon-sellersprite-selector:tracked-seller-stores';

type StoreEntryTab = 'asin' | 'market';
type StoreLookupMode = 'asin' | 'seller';

type StoreProductRow = {
  discovered: McpDiscoveredProduct;
  product: ProductRecord;
};

type MarketStoreResult = {
  id: string;
  summary: SellerStoreSummary;
  rows: StoreProductRow[];
};

type MarketStoreFilters = {
  marketplace: string;
  keyword: string;
  nodeIdPath: string;
  categoryPath: string;
  priceMin: string;
  priceMax: string;
  monthlySalesMin: string;
  monthlySalesMax: string;
  reviewCountMin: string;
  reviewCountMax: string;
  listedDaysMin: string;
  listedDaysMax: string;
  prioritizeRecent: boolean;
  sampleLimit: string;
};

type StoreSummaryTone = 'good' | 'warn' | 'danger' | 'muted';

const defaultMarketFilters: MarketStoreFilters = {
  marketplace: 'US',
  keyword: '',
  nodeIdPath: '',
  categoryPath: '',
  priceMin: '12',
  priceMax: '40',
  monthlySalesMin: '5',
  monthlySalesMax: '300',
  reviewCountMin: '0',
  reviewCountMax: '300',
  listedDaysMin: '30',
  listedDaysMax: '365',
  prioritizeRecent: true,
  sampleLimit: '30',
};

function loadTrackedStores(): SellerStoreTrackingRecord[] {
  try {
    const raw = window.localStorage.getItem(trackedStoresKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTrackedStores(records: SellerStoreTrackingRecord[]) {
  window.localStorage.setItem(trackedStoresKey, JSON.stringify(records.slice(0, 100)));
}

export default function McpStoreDiscoveryPage({
  products,
  onProductsChange,
  onSendToValidation,
  onOpenProductDetail,
}: {
  products: ProductRecord[];
  onProductsChange: (products: ProductRecord[]) => void;
  onSendToValidation: (asin: string, seed?: { title?: string; category?: string; mainKeyword?: string }) => void;
  onOpenProductDetail: (asin: string, context?: { sourceList?: string[]; currentIndex?: number }) => void;
}) {
  const [activeTab, setActiveTab] = useState<StoreEntryTab>('asin');
  const [mode, setMode] = useState<StoreLookupMode>('asin');
  const [asin, setAsin] = useState('');
  const [sellerId, setSellerId] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [limit, setLimit] = useState('30');
  const [marketFilters, setMarketFilters] = useState<MarketStoreFilters>(defaultMarketFilters);
  const [rows, setRows] = useState<StoreProductRow[]>([]);
  const [marketStoreResults, setMarketStoreResults] = useState<MarketStoreResult[]>([]);
  const [selectedAsins, setSelectedAsins] = useState<string[]>([]);
  const [trackedStores, setTrackedStores] = useState<SellerStoreTrackingRecord[]>(() => loadTrackedStores());
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [storefrontUrl, setStorefrontUrl] = useState<string | null>(null);

  const summary = useMemo(() => analyzeSellerStore(rows, { sellerId, sellerName, storefrontUrl }), [rows, sellerId, sellerName, storefrontUrl]);
  const selectedSet = new Set(selectedAsins);
  const sourceList = rows.map((row) => row.discovered.asin);

  const reverseSellerFromAsin = async () => {
    const targetAsin = asin.trim();
    if (!targetAsin) {
      window.alert('请先输入一个 ASIN。');
      return;
    }
    const size = Math.max(1, Math.min(50, Number(limit) || 30));
    if (!window.confirm(`本次将调用卖家精灵 MCP 反查 ASIN 卖家，并最多拉取 ${size} 个同卖家产品，可能消耗额度。是否继续？`)) return;
    setLoading(true);
    setError('');
    setNotice('');
    const result = await fetchSellerFromAsin(targetAsin);
    if (result.status !== 'success' || !result.data) {
      setLoading(false);
      setError(getMcpFriendlyError(result.error || 'ASIN 反查卖家失败。'));
      return;
    }
    const foundSellerId = result.data.seller_id ?? '';
    const foundSellerName = result.data.seller_name ?? '';
    setSellerId(foundSellerId);
    setSellerName(foundSellerName);
    setStorefrontUrl(result.data.storefront_url);
    setMode('seller');
    if (!foundSellerId && !foundSellerName) {
      setLoading(false);
      setNotice('已完成 ASIN 查询，但 MCP 未返回可用于店铺分析的 seller_id / 店铺名。');
      return;
    }
    const sellerProducts = await productResearchBySeller({
      sellerName: foundSellerName || undefined,
      sellerId: foundSellerId || undefined,
      size,
    });
    setLoading(false);
    if (sellerProducts.status !== 'success' || !sellerProducts.data) {
      setNotice(`已识别卖家：${foundSellerName || foundSellerId}，但同卖家产品池拉取失败。`);
      setError(getMcpFriendlyError(sellerProducts.error || '同卖家产品查询失败。'));
      return;
    }
    setStorefrontUrl(sellerProducts.data.storefront_url ?? result.data.storefront_url);
    const nextRows = sellerProducts.data.products.map((discovered) => ({ discovered, product: createProductFromDiscovery(discovered) }));
    setRows(nextRows);
    setSelectedAsins([]);
    const warning = sellerProducts.data.warnings.length ? ` ${sellerProducts.data.warnings.join(' ')}` : '';
    setNotice(`已识别卖家：${foundSellerName || foundSellerId}，并返回 ${nextRows.length} 个同卖家产品。${warning}`);
  };

  const querySellerProducts = async () => {
    const targetSellerName = sellerName.trim();
    const targetSellerId = sellerId.trim();
    if (!targetSellerName && !targetSellerId) {
      window.alert('请先输入 seller_id 或店铺名，也可以先通过 ASIN 反查卖家。');
      return;
    }
    const size = Math.max(1, Math.min(50, Number(limit) || 30));
    if (!window.confirm(`本次将调用卖家精灵 MCP 查询同卖家产品，最多返回 ${size} 条。是否继续？`)) return;
    setLoading(true);
    setError('');
    setNotice('');
    const result = await productResearchBySeller({
      sellerName: targetSellerName || undefined,
      sellerId: targetSellerId || undefined,
      size,
    });
    setLoading(false);
    if (result.status !== 'success' || !result.data) {
      setError(getMcpFriendlyError(result.error || '同卖家产品查询失败。'));
      return;
    }
    setSellerId(result.data.seller_id ?? targetSellerId);
    setSellerName(result.data.seller_name ?? targetSellerName);
    setStorefrontUrl(result.data.storefront_url);
    const nextRows = result.data.products.map((discovered) => ({ discovered, product: createProductFromDiscovery(discovered) }));
    setRows(nextRows);
    setSelectedAsins([]);
    const warning = result.data.warnings.length ? ` ${result.data.warnings.join(' ')}` : '';
    setNotice(`已返回 ${result.data.products.length} 个同卖家产品。${warning}`);
  };

  const updateMarketFilter = <Key extends keyof MarketStoreFilters>(key: Key, value: MarketStoreFilters[Key]) => {
    setMarketFilters((current) => ({ ...current, [key]: value }));
  };

  const queryMarketStores = async () => {
    const keyword = marketFilters.keyword.trim();
    const nodeIdPath = marketFilters.nodeIdPath.trim();
    if (!keyword && !nodeIdPath) {
      window.alert('请至少填写类目节点 ID 或关键词。');
      return;
    }
    const sampleLimit = Math.max(1, Math.min(50, Number(marketFilters.sampleLimit) || 30));
    if (!window.confirm(`本次将通过卖家精灵 MCP 按市场指标抽样 ${sampleLimit} 个产品，并聚合疑似铺货店铺。是否继续？`)) return;
    setLoading(true);
    setError('');
    setNotice('');
    const result = await productResearchByMarket({
      marketplace: marketFilters.marketplace.trim() || 'US',
      keyword,
      nodeIdPath,
      categoryPath: marketFilters.categoryPath.trim(),
      priceMin: Number(marketFilters.priceMin) || 12,
      priceMax: Number(marketFilters.priceMax) || 40,
      monthlySalesMin: Number(marketFilters.monthlySalesMin) || 5,
      monthlySalesMax: Number(marketFilters.monthlySalesMax) || 300,
      reviewCountMin: Number(marketFilters.reviewCountMin) || 0,
      reviewCountMax: Number(marketFilters.reviewCountMax) || 300,
      listedDaysMin: Number(marketFilters.listedDaysMin) || 30,
      listedDaysMax: Number(marketFilters.listedDaysMax) || 365,
      prioritizeRecent: marketFilters.prioritizeRecent,
      size: sampleLimit,
    });
    setLoading(false);
    if (result.status !== 'success' || !result.data) {
      setError(getMcpFriendlyError(result.error || '市场指标找店铺失败。'));
      return;
    }
    const sampleRows = result.data.products.map((discovered) => ({ discovered, product: createProductFromDiscovery(discovered) }));
    const grouped = groupRowsBySeller(sampleRows)
      .map((group) => ({
        id: group.id,
        rows: group.rows,
        summary: analyzeSellerStore(group.rows, {
          sellerId: group.seller_id ?? '',
          sellerName: group.seller_name ?? '',
          storefrontUrl: group.storefront_url,
        }),
      }))
      .sort((left, right) => right.summary.store_puhuo_score - left.summary.store_puhuo_score);
    setMarketStoreResults(grouped);
    setRows(sampleRows);
    setSelectedAsins([]);
    const warning = result.data.warnings.length ? ` ${result.data.warnings.join(' ')}` : '';
    setNotice(`已抽样 ${sampleRows.length} 个产品，识别到 ${grouped.length} 个疑似店铺。${warning}`);
  };

  const toggleSelected = (targetAsin: string) => {
    setSelectedAsins((current) => (current.includes(targetAsin) ? current.filter((item) => item !== targetAsin) : [...current, targetAsin]));
  };

  const saveRowsAsCandidates = (sourceRows: StoreProductRow[], targetAsins: string[], note: string) => {
    const targets = sourceRows.filter((row) => targetAsins.includes(row.discovered.asin));
    if (!targets.length) {
      window.alert('请先选择或指定要保存的 ASIN。');
      return;
    }
    if (!window.confirm(`确认将 ${targets.length} 个可借鉴产品保存为候选吗？`)) return;
    let nextProducts = products;
    let nextCandidates = loadCandidates();
    targets.forEach((row) => {
      nextProducts = upsertDiscoveryProduct(nextProducts, row.discovered, true);
      const product = nextProducts.find((item) => item.asin === row.discovered.asin) ?? row.product;
      nextCandidates = upsertDiscoveryCandidate({
        candidates: nextCandidates,
        product,
        discovered: row.discovered,
        runId: null,
        duplicateStatus: [],
        notes: note,
      });
    });
    saveProducts(nextProducts);
    onProductsChange(nextProducts);
    setSelectedAsins((current) => current.filter((item) => !targetAsins.includes(item)));
    setNotice(`已保存 ${targets.length} 个可借鉴产品到候选池。`);
  };

  const saveAsCandidates = (targetAsins: string[]) => {
    saveRowsAsCandidates(rows, targetAsins, `来自店铺选品：${summary.seller_name || summary.seller_id || '未知卖家'}`);
  };

  const viewMarketStoreProducts = (result: MarketStoreResult) => {
    setRows(result.rows);
    setSellerId(result.summary.seller_id ?? '');
    setSellerName(result.summary.seller_name ?? '');
    setStorefrontUrl(result.summary.storefront_url);
    setSelectedAsins([]);
    setNotice(`正在查看疑似店铺：${result.summary.seller_name || result.summary.seller_id || '未知卖家'}，样本 ${result.rows.length} 个产品。`);
  };

  const saveMarketStoreCandidates = (result: MarketStoreResult) => {
    const testable = result.rows.filter((row) => isTestableStoreProduct(row));
    const targets = testable.length ? testable : result.rows;
    saveRowsAsCandidates(
      result.rows,
      targets.map((row) => row.discovered.asin),
      `来自市场指标找店铺：${result.summary.seller_name || result.summary.seller_id || '未知卖家'}，疑似铺货分 ${result.summary.store_puhuo_score}`,
    );
  };

  const trackStoreSummary = (targetSummary: SellerStoreSummary) => {
    if (!targetSummary.seller_name && !targetSummary.seller_id) {
      window.alert('请先识别或查询一个卖家。');
      return;
    }
    const now = new Date().toISOString();
    const record: SellerStoreTrackingRecord = {
      ...targetSummary,
      id: targetSummary.seller_id || targetSummary.seller_name || `${Date.now()}`,
      tracked_at: now,
      last_checked_at: now,
    };
    const next = [record, ...trackedStores.filter((item) => item.id !== record.id)];
    setTrackedStores(next);
    saveTrackedStores(next);
    setNotice(`已加入店铺跟踪：${targetSummary.seller_name || targetSummary.seller_id}`);
  };

  const trackStore = () => {
    if (!summary.seller_name && !summary.seller_id) {
      window.alert('请先识别或查询一个卖家。');
      return;
    }
    trackStoreSummary(summary);
  };

  return (
    <div className="store-discovery-page">
      <section className="content-section">
        <div className="section-heading">
          <h2>店铺选品</h2>
          <p>支持从 ASIN 反查店铺，也支持从类目/关键词市场样本里反向发现疑似铺货型店铺。这里输出的是“疑似”判断，仍需单品复核。</p>
        </div>
        <div className="store-entry-tabs">
          <button className={activeTab === 'asin' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setActiveTab('asin')}>
            ASIN反查店铺
          </button>
          <button className={activeTab === 'market' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setActiveTab('market')}>
            市场指标找店铺
          </button>
        </div>
        <div className="store-discovery-layout">
          <div className="store-form-panel">
            {activeTab === 'asin' ? (
              <>
                <div className="store-mode-tabs">
                  <button className={mode === 'asin' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setMode('asin')}>
                    ASIN反查卖家
                  </button>
                  <button className={mode === 'seller' ? 'primary-button' : 'secondary-button'} type="button" onClick={() => setMode('seller')}>
                    seller_id / 店铺名
                  </button>
                </div>
                {mode === 'asin' ? (
                  <label>
                    输入 ASIN
                    <input value={asin} placeholder="例如 B0GJSCQ3PS" onChange={(event) => setAsin(event.target.value)} />
                  </label>
                ) : (
                  <div className="store-input-grid">
                    <label>
                      seller_id
                      <input value={sellerId} placeholder="可选，若 MCP 支持则优先识别" onChange={(event) => setSellerId(event.target.value)} />
                    </label>
                    <label>
                      店铺名
                      <input value={sellerName} placeholder="例如 Wayuen" onChange={(event) => setSellerName(event.target.value)} />
                    </label>
                  </div>
                )}
                <label>
                  每次最多返回
                  <input value={limit} inputMode="numeric" onChange={(event) => setLimit(event.target.value)} />
                </label>
                <div className="action-row compact-actions">
                  <button className="primary-button" type="button" onClick={mode === 'asin' ? reverseSellerFromAsin : querySellerProducts} disabled={loading}>
                    {mode === 'asin' ? '反查 ASIN 卖家' : '查询同卖家产品'}
                  </button>
                  <button className="secondary-button" type="button" onClick={querySellerProducts} disabled={loading || (!sellerName.trim() && !sellerId.trim())}>
                    查看同卖家产品
                  </button>
                  <button className="secondary-button" type="button" onClick={trackStore} disabled={!summary.seller_name && !summary.seller_id}>
                    加入店铺跟踪
                  </button>
                </div>
              </>
            ) : (
              <MarketStoreForm filters={marketFilters} onChange={updateMarketFilter} onSubmit={queryMarketStores} loading={loading} />
            )}
            {loading && <p className="candidate-action-hint">正在调用卖家精灵 MCP，请稍候...</p>}
            {notice && <p className="save-notice">{notice}</p>}
            {error && <p className="error-box">{error}</p>}
          </div>
          <StoreSummaryPanel summary={summary} />
        </div>
      </section>

      {activeTab === 'market' && (
        <section className="content-section">
          <div className="section-heading">
            <h2>市场指标发现的疑似店铺</h2>
            <p>按抽样产品聚合同一卖家，分数越高代表越像可参考的铺货/精铺测试店铺，不代表确定结论。</p>
          </div>
          <div className="store-market-table-wrap">
            <table className="store-market-table">
              <thead>
                <tr>
                  <th>店铺名</th>
                  <th>seller_id</th>
                  <th>样本产品</th>
                  <th>疑似铺货分</th>
                  <th>店铺分层</th>
                  <th>可借鉴</th>
                  <th>90天新品</th>
                  <th>低评论动销</th>
                  <th>价格带匹配</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {marketStoreResults.map((result) => (
                  <MarketStoreRow
                    key={result.id}
                    result={result}
                    onView={() => viewMarketStoreProducts(result)}
                    onTrack={() => trackStoreSummary(result.summary)}
                    onSave={() => saveMarketStoreCandidates(result)}
                  />
                ))}
              </tbody>
            </table>
            {!marketStoreResults.length && <div className="empty-state">暂无市场指标店铺样本。请先按类目节点或关键词做一次受控抽样。</div>}
          </div>
        </section>
      )}

      <section className="content-section">
        <div className="section-heading">
          <h2>同卖家产品池</h2>
          <p>这里按现有商品评分做参考统计；保存候选后仍需单品 MCP 验证和前台复核。</p>
        </div>
        {selectedAsins.length > 0 && (
          <div className="candidate-bulk-bar">
            <strong>已选择 {selectedAsins.length} 个 ASIN</strong>
            <button className="secondary-button" type="button" onClick={() => saveAsCandidates(selectedAsins)}>
              保存可借鉴 ASIN 到候选池
            </button>
          </div>
        )}
        <div className="store-product-table-wrap">
          <table className="store-product-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>主图</th>
                <th>ASIN</th>
                <th>标题</th>
                <th>类目</th>
                <th>价格</th>
                <th>月销量</th>
                <th>评论数</th>
                <th>上架天数</th>
                <th>分层</th>
                <th>铺货分</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <StoreProductRow
                  key={row.discovered.asin}
                  row={row}
                  selected={selectedSet.has(row.discovered.asin)}
                  onToggle={() => toggleSelected(row.discovered.asin)}
                  onSave={() => saveAsCandidates([row.discovered.asin])}
                  onValidate={() => onSendToValidation(row.discovered.asin, { title: row.discovered.title ?? '', category: row.discovered.category_path ?? '', mainKeyword: row.discovered.source_keyword ?? '' })}
                  onOpenDetail={() => onOpenProductDetail(row.discovered.asin, { sourceList, currentIndex: index })}
                />
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty-state">暂无同卖家产品。请先反查卖家或查询店铺产品。</div>}
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>店铺跟踪</h2>
          <p>保留你认为值得后续复扫的铺货型店铺。</p>
        </div>
        <div className="tracked-store-list">
          {trackedStores.map((store) => (
            <div className="tracked-store-card" key={store.id}>
              <strong>{store.seller_name || store.seller_id || '未知店铺'}</strong>
              <span>{store.store_layer} · {store.store_action_advice}</span>
              <small>产品 {store.seller_product_count} · 可借鉴 {store.testable_product_count} · 上次 {new Date(store.last_checked_at).toLocaleString()}</small>
            </div>
          ))}
          {!trackedStores.length && <div className="empty-state">暂无跟踪店铺。</div>}
        </div>
      </section>
    </div>
  );
}

function MarketStoreForm({
  filters,
  onChange,
  onSubmit,
  loading,
}: {
  filters: MarketStoreFilters;
  onChange: <Key extends keyof MarketStoreFilters>(key: Key, value: MarketStoreFilters[Key]) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <div className="market-store-form">
      <div className="store-input-grid">
        <label>
          站点
          <input value={filters.marketplace} onChange={(event) => onChange('marketplace', event.target.value)} />
        </label>
        <label>
          关键词，可选
          <input value={filters.keyword} placeholder="例如 under sink organizer" onChange={(event) => onChange('keyword', event.target.value)} />
        </label>
      </div>
      <div className="store-input-grid">
        <label>
          类目节点 ID，可选
          <input value={filters.nodeIdPath} placeholder="可从类目节点选品复制 nodeIdPath" onChange={(event) => onChange('nodeIdPath', event.target.value)} />
        </label>
        <label>
          类目路径备注
          <input value={filters.categoryPath} placeholder="例如 Office Products > Office Supplies" onChange={(event) => onChange('categoryPath', event.target.value)} />
        </label>
      </div>
      <div className="market-filter-grid">
        <NumberInput label="价格下限" value={filters.priceMin} onChange={(value) => onChange('priceMin', value)} />
        <NumberInput label="价格上限" value={filters.priceMax} onChange={(value) => onChange('priceMax', value)} />
        <NumberInput label="月销量下限" value={filters.monthlySalesMin} onChange={(value) => onChange('monthlySalesMin', value)} />
        <NumberInput label="月销量上限" value={filters.monthlySalesMax} onChange={(value) => onChange('monthlySalesMax', value)} />
        <NumberInput label="评论数下限" value={filters.reviewCountMin} onChange={(value) => onChange('reviewCountMin', value)} />
        <NumberInput label="评论数上限" value={filters.reviewCountMax} onChange={(value) => onChange('reviewCountMax', value)} />
        <NumberInput label="上架天数下限" value={filters.listedDaysMin} onChange={(value) => onChange('listedDaysMin', value)} />
        <NumberInput label="上架天数上限" value={filters.listedDaysMax} onChange={(value) => onChange('listedDaysMax', value)} />
        <NumberInput label="样本产品数" value={filters.sampleLimit} onChange={(value) => onChange('sampleLimit', value)} />
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={filters.prioritizeRecent} onChange={(event) => onChange('prioritizeRecent', event.target.checked)} />
        是否优先新品/少评论动销
      </label>
      <div className="action-row compact-actions">
        <button className="primary-button" type="button" onClick={onSubmit} disabled={loading}>
          按市场指标发现店铺
        </button>
      </div>
      <p className="candidate-action-hint">默认只抽样 20-50 个产品，不会无限抓取店铺或递归类目。</p>
    </div>
  );
}

function MarketStoreRow({
  result,
  onView,
  onTrack,
  onSave,
}: {
  result: MarketStoreResult;
  onView: () => void;
  onTrack: () => void;
  onSave: () => void;
}) {
  const summary = result.summary;
  return (
    <tr>
      <td>
        <strong>{summary.seller_name || '未知店铺'}</strong>
        {summary.storefront_url && <small className="storefront-link">有店铺链接</small>}
      </td>
      <td className="store-product-title" title={summary.seller_id ?? ''}>{summary.seller_id || '未返回'}</td>
      <td>{summary.sampled_product_count}</td>
      <td><strong>{summary.store_puhuo_score}</strong></td>
      <td><span className={`store-layer-pill store-layer-${summary.store_layer}`}>{summary.store_layer}</span></td>
      <td>{summary.testable_product_count}</td>
      <td>{summary.new_product_count_90d}</td>
      <td>{summary.zero_review_sales_count}</td>
      <td>{percent(summary.price_band_match_rate)}</td>
      <td className="table-actions">
        <button className="secondary-button" type="button" onClick={onView}>查看店铺产品</button>
        <button className="secondary-button" type="button" onClick={onTrack}>加入店铺跟踪</button>
        <button className="secondary-button" type="button" onClick={onSave}>保存可借鉴</button>
      </td>
    </tr>
  );
}

function StoreSummaryPanel({ summary }: { summary: SellerStoreSummary }) {
  return (
    <div className="store-summary-panel">
      <div>
        <span>店铺分层</span>
        <strong>{summary.store_layer}</strong>
        <em>{summary.store_action_advice}</em>
      </div>
      <StoreMetric label="铺货相似度" value={`${summary.store_puhuo_score}/100`} tone={summary.store_puhuo_score >= 70 ? 'good' : summary.store_puhuo_score >= 45 ? 'warn' : 'muted'} />
      <StoreMetric label="同卖家产品" value={summary.seller_product_count} tone="muted" />
      <StoreMetric label="覆盖类目" value={summary.seller_category_count} tone="muted" />
      <StoreMetric label="低评产品" value={summary.low_review_product_count} tone="good" />
      <StoreMetric label="0评动销" value={summary.zero_review_sales_count} tone="good" />
      <StoreMetric label="90天新品" value={summary.new_product_count_90d} tone="good" />
      <StoreMetric label="180天新品" value={summary.new_product_count_180d} tone="good" />
      <StoreMetric label="可借鉴产品" value={summary.testable_product_count} tone="good" />
      <StoreMetric label="价格带匹配" value={percent(summary.price_band_match_rate)} tone="warn" />
      <StoreMetric label="A/A候选/B/C" value={`${summary.A_count}/${summary.A_candidate_count}/${summary.B_count}/${summary.C_count}`} tone="warn" />
      <div className="store-summary-notes">
        {(summary.notes.length ? summary.notes : ['查询同卖家产品后会自动生成店铺画像。']).map((note) => <p key={note}>{note}</p>)}
      </div>
    </div>
  );
}

function StoreMetric({ label, value, tone }: { label: string; value: string | number; tone: StoreSummaryTone }) {
  return (
    <div className={`store-metric store-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StoreProductRow({
  row,
  selected,
  onToggle,
  onSave,
  onValidate,
  onOpenDetail,
}: {
  row: StoreProductRow;
  selected: boolean;
  onToggle: () => void;
  onSave: () => void;
  onValidate: () => void;
  onOpenDetail: () => void;
}) {
  const score = row.product.score;
  return (
    <tr>
      <td><input type="checkbox" checked={selected} onChange={onToggle} aria-label={`选择 ${row.discovered.asin}`} /></td>
      <td><ProductThumbnail src={row.discovered.main_image_url} asin={row.discovered.asin} title={row.discovered.title} size="small" /></td>
      <td><strong>{row.discovered.asin}</strong></td>
      <td className="store-product-title" title={row.discovered.title ?? ''}>{row.discovered.title || '未返回'}</td>
      <td className="store-product-category" title={row.discovered.category_path ?? ''}>{row.discovered.category_path || row.discovered.category || '未返回'}</td>
      <td>{money(row.discovered.price)}</td>
      <td>{value(row.discovered.monthly_sales)}</td>
      <td>{value(row.discovered.review_count)}</td>
      <td>{value(row.discovered.product_age_days)}</td>
      <td><span className="candidate-layer-pill candidate-layer-good">{shortStoreLayer(score.layer)}</span></td>
      <td><strong>{score.flea_market_score}</strong></td>
      <td className="table-actions">
        <button className="secondary-button" type="button" onClick={onOpenDetail}>详情</button>
        <button className="secondary-button" type="button" onClick={onValidate}>MCP验证</button>
        <button className="secondary-button" type="button" onClick={onSave}>保存候选</button>
      </td>
    </tr>
  );
}

function analyzeSellerStore(rows: StoreProductRow[], seller: { sellerId: string; sellerName: string; storefrontUrl: string | null }): SellerStoreSummary {
  const categories = new Set(rows.map((row) => row.discovered.category_path || row.discovered.category).filter(Boolean));
  const lowReview = rows.filter((row) => (row.discovered.review_count ?? Number.MAX_SAFE_INTEGER) <= 100).length;
  const zeroReviewSales = rows.filter((row) => (row.discovered.review_count ?? 0) === 0 && (row.discovered.monthly_sales ?? 0) > 0).length;
  const new90 = rows.filter((row) => row.discovered.product_age_days !== null && row.discovered.product_age_days <= 90).length;
  const new180 = rows.filter((row) => row.discovered.product_age_days !== null && row.discovered.product_age_days <= 180).length;
  const prices = rows.map((row) => row.discovered.price).filter((price): price is number => typeof price === 'number' && Number.isFinite(price));
  const reviewCounts = rows.map((row) => row.discovered.review_count).filter((count): count is number => typeof count === 'number' && Number.isFinite(count));
  const monthlySales = rows.map((row) => row.discovered.monthly_sales).filter((count): count is number => typeof count === 'number' && Number.isFinite(count));
  const priceBandMatches = rows.filter((row) => typeof row.discovered.price === 'number' && row.discovered.price >= 12 && row.discovered.price <= 40).length;
  const sellerRiskFlags = sellerRiskFlagsFor(rows, categories.size);
  const counts = rows.reduce(
    (total, row) => {
      const layer = row.product.score.layer;
      if (layer.startsWith('A候选')) total.A_candidate += 1;
      else if (layer.startsWith('A')) total.A += 1;
      else if (layer.startsWith('B')) total.B += 1;
      else if (layer.startsWith('C')) total.C += 1;
      else if (layer.startsWith('D')) total.D += 1;
      else if (layer.startsWith('E')) total.E += 1;
      return total;
    },
    { A: 0, A_candidate: 0, B: 0, C: 0, D: 0, E: 0 },
  );
  const testable = counts.A + counts.A_candidate + counts.B + counts.C;
  const priceBandMatchRate = rows.length ? priceBandMatches / rows.length : 0;
  const productCountScore = Math.min(18, rows.length * 1.3);
  const categoryScore = Math.min(16, categories.size * 4);
  const lowReviewScore = rows.length ? Math.min(20, (lowReview / rows.length) * 22) : 0;
  const zeroReviewScore = rows.length ? Math.min(14, (zeroReviewSales / rows.length) * 28) : 0;
  const newScore = rows.length ? Math.min(14, (new90 / rows.length) * 22 + (new180 / rows.length) * 8) : 0;
  const testableScore = rows.length ? Math.min(20, (testable / rows.length) * 30) : 0;
  const priceScore = Math.min(10, priceBandMatchRate * 10);
  const riskPenalty = Math.min(25, sellerRiskFlags.length * 8);
  const score = Math.max(0, Math.round(productCountScore + categoryScore + lowReviewScore + zeroReviewScore + newScore + testableScore + priceScore - riskPenalty));
  const layer: SellerStoreSummary['store_layer'] = sellerRiskFlags.some((flag) => flag.includes('高风险'))
    ? 'E'
    : score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 45 ? 'B' : score >= 25 ? 'C' : 'E';
  const advice =
    layer === 'S'
      ? '重点跟踪疑似铺货店铺'
      : layer === 'A'
        ? '高参考价值疑似店铺'
        : layer === 'B'
          ? '可观察店铺'
          : layer === 'C'
            ? '普通店铺'
            : '无参考价值/风险店铺';
  const notes = [
    rows.length ? `样本 ${rows.length} 个产品，覆盖 ${categories.size} 个类目。` : '尚未查询同卖家产品。',
    lowReview ? `${lowReview} 个低评论产品，可用于观察少评动销。` : '暂未发现低评论产品。',
    zeroReviewSales ? `${zeroReviewSales} 个 0 评论但有销量产品，疑似铺货测试信号更强。` : '暂未发现 0 评论已动销产品。',
    new180 ? `${new180} 个 180 天内新品，可观察上新节奏。` : '暂未发现明显新品节奏。',
    testable ? `${testable} 个产品落在 A/A候选/B/C，可作为可借鉴池。` : '暂未发现明显可借鉴产品。',
    sellerRiskFlags.length ? `风险提示：${sellerRiskFlags.join('、')}。` : '未发现明显店铺级硬风险，但仍需前台复核。',
    '当前仅为疑似铺货店铺识别，不作为确定结论。',
  ];
  return {
    seller_id: seller.sellerId || null,
    seller_name: seller.sellerName || null,
    storefront_url: seller.storefrontUrl,
    seller_product_count: rows.length,
    sampled_product_count: rows.length,
    seller_category_count: categories.size,
    low_review_product_count: lowReview,
    zero_review_sales_count: zeroReviewSales,
    new_product_count_90d: new90,
    new_product_count_180d: new180,
    testable_product_count: testable,
    A_count: counts.A,
    A_candidate_count: counts.A_candidate,
    B_count: counts.B,
    C_count: counts.C,
    D_count: counts.D,
    E_count: counts.E,
    category_count: categories.size,
    avg_price: average(prices),
    price_band_match_rate: priceBandMatchRate,
    avg_review_count: average(reviewCounts),
    avg_monthly_sales: average(monthlySales),
    seller_risk_flags: sellerRiskFlags,
    store_puhuo_score: score,
    store_layer: layer,
    store_action_advice: advice,
    notes,
  };
}

function groupRowsBySeller(rows: StoreProductRow[]): Array<{
  id: string;
  seller_id: string | null;
  seller_name: string | null;
  storefront_url: string | null;
  rows: StoreProductRow[];
}> {
  const groups = new Map<string, { id: string; seller_id: string | null; seller_name: string | null; storefront_url: string | null; rows: StoreProductRow[] }>();
  rows.forEach((row) => {
    const identity = sellerIdentityFrom(row.discovered);
    const key = identity.seller_id || identity.seller_name || `unknown-${row.discovered.asin}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.seller_id = existing.seller_id ?? identity.seller_id;
      existing.seller_name = existing.seller_name ?? identity.seller_name;
      existing.storefront_url = existing.storefront_url ?? identity.storefront_url;
      return;
    }
    groups.set(key, { id: key, ...identity, rows: [row] });
  });
  return Array.from(groups.values());
}

function sellerIdentityFrom(product: McpDiscoveredProduct): { seller_id: string | null; seller_name: string | null; storefront_url: string | null } {
  const raw = product.raw && typeof product.raw === 'object' ? product.raw as Record<string, unknown> : {};
  const sellerId = pickText(raw, ['sellerId', 'seller_id', 'merchantId', 'merchant_id', 'shopId']);
  const sellerName = pickText(raw, ['sellerName', 'seller', 'shopName']) ?? product.seller;
  const storefrontUrl = pickText(raw, ['storefrontUrl', 'storefront_url', 'sellerUrl', 'shopUrl']) ?? (sellerId ? `https://www.amazon.com/sp?seller=${encodeURIComponent(sellerId)}` : null);
  return { seller_id: sellerId, seller_name: sellerName, storefront_url: storefrontUrl };
}

function pickText(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function isTestableStoreProduct(row: StoreProductRow): boolean {
  const layer = row.product.score.layer;
  return layer.startsWith('A') || layer.startsWith('B') || layer.startsWith('C');
}

function sellerRiskFlagsFor(rows: StoreProductRow[], categoryCount: number): string[] {
  const text = rows.map((row) => `${row.discovered.title ?? ''} ${row.discovered.category_path ?? ''} ${row.discovered.category ?? ''}`).join(' ').toLowerCase();
  const flags: string[] = [];
  if (rows.some((row) => row.discovered.is_amazon)) flags.push('Amazon自营占比需复核');
  if (/\bmedical|supplement|food|baby|knife|weapon|battery|liquid|powder\b/.test(text)) flags.push('疑似高风险品类');
  if (rows.length >= 8 && categoryCount <= 1 && rows.filter((row) => (row.discovered.review_count ?? 0) > 300).length >= rows.length * 0.6) {
    flags.push('可能偏单一精品品牌');
  }
  return flags;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(2));
}

function shortStoreLayer(layer: string): string {
  if (layer.startsWith('A候选')) return 'A候选';
  if (layer.startsWith('A')) return 'A';
  if (layer.startsWith('B')) return 'B';
  if (layer.startsWith('C')) return 'C';
  if (layer.startsWith('D')) return 'D';
  if (layer.startsWith('E')) return 'E';
  return '待复核';
}

function NumberInput({ label, value: currentValue, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={currentValue} inputMode="decimal" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function money(input: number | null): string {
  return typeof input === 'number' && Number.isFinite(input) ? `$${input.toFixed(2)}` : '未返回';
}

function percent(input: number | null): string {
  return typeof input === 'number' && Number.isFinite(input) ? `${Math.round(input * 100)}%` : '未返回';
}

function value(input: unknown): string {
  if (input === null || input === undefined || input === '') return '未返回';
  return String(input);
}
