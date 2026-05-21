import { useMemo, useState } from 'react';
import AmazonCategoryTree from '../components/AmazonCategoryTree';
import type {
  CategorySelection,
  DiscoveryFilters,
  DiscoveryRun,
  DuplicateStatus,
  McpCandidateRecord,
  McpDiscoveredProduct,
  ProductRecord,
} from '../types/mcp';
import {
  createProductFromDiscovery,
  getDiscoveryDuplicateStatuses,
  loadCandidates,
  loadDiscoveryRuns,
  updateCandidateDecisionStatus,
  updateDiscoveryRunSavedCandidates,
  upsertDiscoveryCandidate,
  upsertDiscoveryProduct,
  upsertDiscoveryRun,
} from '../utils/productStore';
import { getMcpFriendlyError, productResearchByCategory } from '../utils/sellerspriteMcp';
import { longTailOpportunityLabel } from '../utils/keywordTools';

const selectionStorageKey = 'amazon-sellersprite-selector:selected-category:US';

type DiscoveryRow = {
  discovered: McpDiscoveredProduct;
  product: ProductRecord;
  duplicate_status: DuplicateStatus[];
  hidden: boolean;
};
type AgeQuickFilter = 'all' | '30' | '90' | '180' | '365' | 'exclude_old' | 'missing';

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
  onOpenReview: (asin: string) => void;
  onOpenDevelopment: () => void;
}) {
  const [selection, setSelection] = useState<CategorySelection | null>(() => readSelection());
  const [filters, setFilters] = useState<DiscoveryFilters>({ ...defaultFilters });
  const [refreshToken, setRefreshToken] = useState(0);
  const [rows, setRows] = useState<DiscoveryRow[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>(() => loadDiscoveryRuns());
  const [candidates, setCandidates] = useState<McpCandidateRecord[]>(() => loadCandidates());
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState('请选择 Amazon 类目节点，使用 MCP 小批量找品。');
  const [ageQuickFilter, setAgeQuickFilter] = useState<AgeQuickFilter>('all');

  const visibleRows = useMemo(() => rows.filter((row) => !row.hidden && matchAgeQuickFilter(row.discovered, ageQuickFilter)), [rows, ageQuickFilter]);

  const chooseCategory = (next: CategorySelection) => {
    setSelection(next);
    saveSelection(next);
  };

  const refreshCategories = () => {
    if (!window.confirm('本次将调用卖家精灵 MCP 获取类目节点，可能消耗额度，是否继续？')) return;
    setRefreshToken((value) => value + 1);
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

  const runDiscovery = async () => {
    if (!selection) {
      setErrors(['请先选择一个 Amazon 类目节点。']);
      return;
    }
    if (!selection.is_leaf && !window.confirm('建议选择更细的小类目，当前为上级类目，结果可能过宽。是否继续？')) return;
    if (!window.confirm(`本次将通过卖家精灵 MCP 按类目找品，可能消耗额度。每次最多返回 ${Math.min(filters.limit, 50)} 个候选。是否继续？`)) return;

    const run: DiscoveryRun = {
      id: `${Date.now()}-${selection.node_id}`,
      run_type: 'category_manual',
      marketplace: filters.marketplace,
      category_node_id: selection.node_id,
      category_path: selection.path,
      keyword_optional: filters.keyword_optional,
      filters: { ...filters, limit: Math.min(filters.limit, 50) },
      started_at: new Date().toISOString(),
      finished_at: null,
      status: 'loading',
      total_mcp_calls: 1,
      total_results: 0,
      hidden_duplicates: 0,
      saved_candidates: 0,
      errors: [],
    };
    setRuns(upsertDiscoveryRun(run));
    setErrors([]);
    setWarnings([]);
    setNotice('');
    setLoading(true);
    const result = await productResearchByCategory(selection, run.filters);
    setLoading(false);

    if (result.status !== 'success' || !result.data) {
      const message = getMcpFriendlyError(result.error);
      const failed = { ...run, finished_at: new Date().toISOString(), status: 'failed' as const, errors: [message] };
      setRuns(upsertDiscoveryRun(failed));
      setErrors([message]);
      return;
    }

    const scannedRows = buildRows(result.data.products, products, candidates, filters);
    const finished: DiscoveryRun = {
      ...run,
      finished_at: new Date().toISOString(),
      status: 'success',
      total_results: result.data.products.length,
      hidden_duplicates: scannedRows.filter((row) => row.hidden).length,
      errors: result.data.warnings,
    };
    setRuns(upsertDiscoveryRun(finished));
    setRows(scannedRows);
    setWarnings(result.data.warnings);
    setNotice(`当前类目返回 ${result.data.products.length} 条，展示 ${scannedRows.filter((row) => !row.hidden).length} 条。关键词与 PPC 可在保存候选后继续 MCP 验证。`);
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
      runId: runs[0]?.id ?? null,
      duplicateStatus: row.duplicate_status,
      notes: note || existing?.notes || '',
      decisionStatus,
    });
    if (decisionStatus !== 'candidate') nextCandidates = updateCandidateDecisionStatus(nextCandidates, row.discovered.asin, decisionStatus, note);
    onProductsChange(nextProducts);
    setCandidates(nextCandidates);
    if (!existing && runs[0]) setRuns(updateDiscoveryRunSavedCandidates(runs[0].id, 1));
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
    saveable.forEach((row) => {
      nextProducts = upsertDiscoveryProduct(nextProducts, row.discovered, true);
      const savedProduct = nextProducts.find((product) => product.asin === row.discovered.asin);
      if (!savedProduct) return;
      nextCandidates = upsertDiscoveryCandidate({
        candidates: nextCandidates,
        product: savedProduct,
        discovered: row.discovered,
        runId: runs[0]?.id ?? null,
        duplicateStatus: row.duplicate_status,
        decisionStatus: 'candidate',
      });
    });
    onProductsChange(nextProducts);
    setCandidates(nextCandidates);
    if (runs[0]) setRuns(updateDiscoveryRunSavedCandidates(runs[0].id, saveable.length));
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
    const headers = ['ASIN', '标题', '品牌', '类目路径', '来源节点', '上架时间', 'product_age_days', 'recent_product_level', 'is_recent_product', '价格', '月销量', '月销售额', '评论数', '评分', 'rating_risk_level', 'rating_risk_note', 'BSR', 'FBA费', 'main_keyword', 'long_tail_keywords', 'long_tail_opportunity_level', 'recommended_sp_keywords', 'rejected_keywords', 'low_bid_ad_score', 'strict_rating_filter_enabled', '铺货捡漏分', '分层', '重复状态'];
    const csv = [
      headers,
      ...visibleRows.map((row) => [
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
      ]),
    ]
      .map((line) => line.map(csvCell).join(','))
      .join('\n');
    downloadCsv(csv, `mcp-category-discovery-${Date.now()}.csv`);
  };

  return (
    <div className="discovery-layout">
      <AmazonCategoryTree selected={selection} onSelect={chooseCategory} refreshToken={refreshToken} />
      <div className="discovery-main">
        <section className="content-section">
          <div className="section-heading">
            <h2>MCP 按类目找品</h2>
            <p>第一页只做当前节点小样本扫描，不自动翻页，不递归所有子类目。</p>
          </div>
          <div className="selected-category">
            <Metric label="节点名称" value={selection?.name ?? '未选择'} />
            <Metric label="节点路径" value={selection?.path ?? '请先从左侧选择'} />
            <Metric label="节点 ID" value={selection?.node_id ?? '未选择'} />
            <Metric label="叶子类目" value={selection ? (selection.is_leaf ? '是' : '未确认/上级类目') : '未选择'} />
          </div>
          <div className="filter-grid">
            <ReadOnlyField label="站点" value="US" />
            <Field label="关键词，可选" value={filters.keyword_optional} onChange={(value) => setFilters((current) => ({ ...current, keyword_optional: value }))} />
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
            <NumberField label="每次最多返回数量" value={filters.limit} max="50" onChange={(value) => updateNumber('limit', value)} />
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
          <div className="action-row">
            <button className="primary-button" type="button" onClick={runDiscovery} disabled={loading}>
              {loading ? '找品中' : '按当前类目找品'}
            </button>
            <button className="secondary-button" type="button" onClick={refreshCategories}>刷新类目节点</button>
            <button className="secondary-button" type="button" onClick={() => setRows([])}>清空结果</button>
            <button className="secondary-button" type="button" onClick={saveVisibleCandidates} disabled={!visibleRows.length}>保存候选</button>
            <button className="secondary-button" type="button" onClick={exportRows} disabled={!visibleRows.length}>导出当前结果</button>
          </div>
          {notice && <p className="save-notice">{notice}</p>}
          {warnings.length > 0 && <div className="warning-list">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
          {errors.length > 0 && <div className="error-box">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
        </section>

        <section className="content-section">
          <div className="section-heading">
            <h2>找品结果</h2>
            <p>首轮按类目看低评论出单、价格带、平台毛利与历史去重；无关键词时广告分保持中性并标记待确认。</p>
          </div>
          <div className="age-filter-row" aria-label="上架时间快捷筛选">
            {([
              ['all', '全部结果'],
              ['30', '最近30天'],
              ['90', '最近90天'],
              ['180', '最近180天'],
              ['365', '最近365天'],
              ['exclude_old', '排除365天以上老品'],
              ['missing', '上架时间缺失'],
            ] as Array<[AgeQuickFilter, string]>).map(([value, label]) => (
              <button
                className={ageQuickFilter === value ? 'primary-button' : 'secondary-button'}
                key={value}
                type="button"
                onClick={() => setAgeQuickFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {!rows.length ? (
            <div className="empty-state">还没有类目扫描结果。</div>
          ) : (
            <div className="table-wrap discovery-table">
              <table>
                <thead>
                  <tr>
                    <th>ASIN</th>
                    <th>标题</th>
                    <th>品牌</th>
                    <th>类目路径</th>
                    <th>来源节点</th>
                    <th>上架时间</th>
                    <th>上架天数</th>
                    <th>新品等级</th>
                    <th>价格</th>
                    <th>月销量</th>
                    <th>月销售额</th>
                    <th>评论数</th>
                    <th>评分</th>
                    <th>评分风险</th>
                    <th>主关键词</th>
                    <th>长尾词状态</th>
                    <th>长尾词机会</th>
                    <th>推荐 SP 词数</th>
                    <th>BSR</th>
                    <th>FBA费</th>
                    <th>销量/评论</th>
                    <th>低评论信号</th>
                    <th>便宜5%目标价</th>
                    <th>平台后毛利率</th>
                    <th>铺货捡漏分</th>
                    <th>分层</th>
                    <th>重复状态</th>
                    <th>风险标签</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <ResultRow
                      key={row.discovered.asin}
                      row={row}
                      onSave={() => persistCandidate(row)}
                      onValidate={() => onSendToValidation(row.discovered.asin, validationSeed(row, true))}
                      onQueryLongTail={() => onSendToValidation(row.discovered.asin, validationSeed(row, true, true))}
                      onViewKeywords={() => window.alert(keywordOpportunityText(row))}
                      onReview={() => {
                        if (persistCandidate(row, 'candidate', '', true)) onOpenReview(row.discovered.asin);
                      }}
                      onDevelop={() => developRow(row)}
                      onReject={() => rejectRow(row)}
                    />
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
                  <th>返回数量</th>
                  <th>隐藏重复</th>
                  <th>保存候选</th>
                  <th>MCP失败</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 8).map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.started_at).toLocaleString()}</td>
                    <td>{run.category_path}</td>
                    <td>{run.total_results}</td>
                    <td>{run.hidden_duplicates}</td>
                    <td>{run.saved_candidates}</td>
                    <td>{run.status === 'failed' ? run.errors.length || 1 : run.errors.length}</td>
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

function buildRows(
  discoveredProducts: McpDiscoveredProduct[],
  products: ProductRecord[],
  candidates: McpCandidateRecord[],
  filters: DiscoveryFilters,
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
    };
  });
}

function ResultRow({
  row,
  onSave,
  onValidate,
  onQueryLongTail,
  onViewKeywords,
  onReview,
  onDevelop,
  onReject,
}: {
  row: DiscoveryRow;
  onSave: () => void;
  onValidate: () => void;
  onQueryLongTail: () => void;
  onViewKeywords: () => void;
  onReview: () => void;
  onDevelop: () => void;
  onReject: () => void;
}) {
  const score = row.product.score;
  return (
    <tr>
      <td>{row.discovered.asin}</td>
      <td>{row.discovered.title ?? '未返回'}</td>
      <td>{row.discovered.brand ?? '未返回'}</td>
      <td>{row.discovered.category_path ?? '未返回'}</td>
      <td>{row.discovered.source_node_id}</td>
      <td>{formatDate(row.discovered.listed_at ?? row.discovered.launch_date ?? row.discovered.first_available_date)}</td>
      <td>{listedDayLabel(row.discovered.product_age_days)}</td>
      <td>{recentProductLabel(row.discovered)}</td>
      <td>{formatMoney(row.discovered.coupon_price ?? row.discovered.price)}</td>
      <td>{valueLabel(row.discovered.monthly_sales)}</td>
      <td>{formatMoney(row.discovered.monthly_revenue)}</td>
      <td>{valueLabel(row.discovered.review_count)}</td>
      <td>{valueLabel(row.discovered.rating)}</td>
      <td>{ratingRiskLabel(score.rating_risk_level, row.discovered.rating)}</td>
      <td>{row.product.mcp_snapshot?.main_keyword ?? '待生成'}</td>
      <td>{longTailStatus(row.product)}</td>
      <td>{longTailOpportunityLabel(row.product.mcp_snapshot?.long_tail_opportunity_level ?? 'unknown')}</td>
      <td>{row.product.mcp_snapshot?.recommended_sp_keywords.length ?? 0}</td>
      <td>{valueLabel(row.discovered.bsr)}</td>
      <td>{formatMoney(row.discovered.fba_fee)}</td>
      <td>{valueLabel(score.low_review_sales_score.sales_per_review, 1)}</td>
      <td>{score.low_review_sales_score.signal}</td>
      <td>{formatMoney(score.price_margin_score.target_price_5)}</td>
      <td>{formatPercent(score.price_margin_score.platform_margin_rate)}</td>
      <td><strong>{score.flea_market_score}</strong></td>
      <td>{score.layer}</td>
      <td><DuplicatePills statuses={row.duplicate_status} /></td>
      <td>{score.listing_safety_score.notes[0] ?? '待前台风险复核'}</td>
      <td className="table-actions">
        <button className="secondary-button" type="button" onClick={onSave}>保存为候选</button>
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

function DuplicatePills({ statuses }: { statuses: DuplicateStatus[] }) {
  if (!statuses.length) return <span className="duplicate-pill duplicate-clear">未命中</span>;
  return <>{statuses.map((status) => <span className="duplicate-pill" key={status}>{duplicateLabel([status])}</span>)}</>;
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

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
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
