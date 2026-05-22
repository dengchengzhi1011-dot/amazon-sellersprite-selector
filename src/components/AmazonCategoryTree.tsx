import { useEffect, useMemo, useState } from 'react';
import type { AmazonCategoryNode, CategoryScanRecord, CategorySelection } from '../types/mcp';
import { sortCategoryNodes } from '../utils/categorySort';
import { fetchCategoryNodes, getMcpFriendlyError } from '../utils/sellerspriteMcp';

const categoryCacheKey = 'amazon-sellersprite-selector:amazon-category-tree:US';
const categoryExpandedCacheKey = 'amazon-sellersprite-selector:amazon-category-tree-expanded:US';

interface AmazonCategoryTreeProps {
  selected: CategorySelection | null;
  onSelect: (selection: CategorySelection) => void;
  refreshToken: number;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  scanRecords?: Record<string, CategoryScanRecord>;
  onNodesChange?: (nodes: AmazonCategoryNode[]) => void;
}

type ScanFilter = 'all' | 'not_scanned' | 'opportunity' | 'watch' | 'cooling' | 'blacklisted' | 'failed';

const scanFilterOptions: Array<[ScanFilter, string]> = [
  ['all', '全部节点'],
  ['not_scanned', '未扫描'],
  ['opportunity', '有机会'],
  ['watch', '观察复扫'],
  ['cooling', '冷却中'],
  ['blacklisted', '拉黑'],
  ['failed', '扫描失败'],
];

function readCachedNodes(): AmazonCategoryNode[] {
  try {
    const raw = window.localStorage.getItem(categoryCacheKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? sortCategoryNodes(parsed) : [];
  } catch {
    return [];
  }
}

function cacheNodes(nodes: AmazonCategoryNode[]) {
  window.localStorage.setItem(categoryCacheKey, JSON.stringify(nodes));
}

function readCachedExpanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(categoryExpandedCacheKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function cacheExpanded(expanded: Set<string>) {
  window.localStorage.setItem(categoryExpandedCacheKey, JSON.stringify(Array.from(expanded).sort()));
}

function flattenNodes(nodes: AmazonCategoryNode[]): AmazonCategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function findAncestorIds(nodes: AmazonCategoryNode[], targetId: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.id === targetId) return trail;
    const childTrail = findAncestorIds(node.children, targetId, [...trail, node.id]);
    if (childTrail) return childTrail;
  }
  return null;
}

function updateNode(nodes: AmazonCategoryNode[], id: string, updater: (node: AmazonCategoryNode) => AmazonCategoryNode): AmazonCategoryNode[] {
  return nodes.map((node) => {
    if (node.id === id) return updater(node);
    if (!node.children.length) return node;
    return { ...node, children: updateNode(node.children, id, updater) };
  });
}

function attachChildren(nodes: AmazonCategoryNode[], parentId: string | undefined, children: AmazonCategoryNode[]): AmazonCategoryNode[] {
  const sortedChildren = sortCategoryNodes(children);
  if (!parentId) return sortedChildren;
  return updateNode(nodes, parentId, (node) => ({ ...node, children: sortedChildren, is_leaf: sortedChildren.length === 0 }));
}

function toSelection(node: AmazonCategoryNode): CategorySelection {
  return {
    node_id: node.node_id,
    name: node.name,
    path: node.path,
    level: node.level,
    is_leaf: node.is_leaf,
    selected_at: new Date().toISOString(),
  };
}

function nodeRawString(node: AmazonCategoryNode, keys: string[]): string | null {
  if (!node.raw || typeof node.raw !== 'object') return null;
  const raw = node.raw as Record<string, unknown>;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function lastPathLabel(value: string | null): string | null {
  if (!value) return null;
  const labels = value.split(/[:>]/).map((part) => part.trim()).filter(Boolean);
  return labels[labels.length - 1] ?? null;
}

function chineseName(node: AmazonCategoryNode): string {
  return node.name_cn || lastPathLabel(nodeRawString(node, ['nodeLabelPathLocale', 'pathLocale'])) || '中文名称未返回';
}

function chinesePath(node: AmazonCategoryNode): string | null {
  const path = nodeRawString(node, ['nodeLabelPathLocale', 'pathLocale']);
  return path ? path.replaceAll(':', ' > ') : null;
}

function englishPathLabel(node: AmazonCategoryNode): string {
  return node.path === node.name ? `英文：${node.name}` : `英文路径：${node.path}`;
}

function levelLabel(node: AmazonCategoryNode): string {
  if (node.is_leaf || node.level >= 4) return '叶子';
  return `L${Math.max(1, node.level)}`;
}

function levelClass(node: AmazonCategoryNode): string {
  if (node.is_leaf || node.level >= 4) return 'category-level-leaf';
  if (node.level <= 1) return 'category-level-1';
  if (node.level === 2) return 'category-level-2';
  return 'category-level-3';
}

function highlightedText(text: string, query: string) {
  const normalized = query.trim();
  if (!normalized) return text;
  const index = text.toLowerCase().indexOf(normalized.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalized.length)}</mark>
      {text.slice(index + normalized.length)}
    </>
  );
}

function isRecordDue(record: CategoryScanRecord | undefined): boolean {
  if (!record) return false;
  if (record.scan_status === 'failed') return true;
  if (record.scan_status === 'blacklisted') return false;
  if (!record.next_scan_at) return true;
  return new Date(record.next_scan_at).getTime() <= Date.now();
}

function scanDisplay(record: CategoryScanRecord | undefined): { label: string; tone: string; title: string } {
  if (!record) return { label: '未扫', tone: 'scan-muted', title: '未扫描：尚未调用 MCP 扫描该类目。' };
  const due = isRecordDue(record);
  const ABCount = record.A_count + record.A_candidate_count + record.B_count;
  const testableCount = record.testable_count ?? ABCount + record.C_count;
  const daysToNext = record.next_scan_at
    ? Math.ceil((new Date(record.next_scan_at).getTime() - Date.now()) / 86_400_000)
    : null;
  const coolingText = !due && daysToNext !== null && daysToNext > 0 ? `冷却${daysToNext}天` : '';
  const title = [
    `状态：${record.scan_note || record.scan_status}`,
    `上次扫描：${record.last_scan_at ? new Date(record.last_scan_at).toLocaleString() : '未记录'}`,
    `下次建议：${record.next_scan_at ? new Date(record.next_scan_at).toLocaleString() : '不自动复扫'}`,
    `结果：原始 ${record.raw_result_count} 条，筛选后 ${record.filtered_result_count} 条，可测 ${testableCount} 条`,
    `分层：A ${record.A_count}，A候选 ${record.A_candidate_count}，B ${record.B_count}，C ${record.C_count}，D ${record.D_count}，E ${record.E_count}`,
    record.best_score !== null ? `最高分：${record.best_score}` : '',
  ].filter(Boolean).join('\n');

  if (record.scan_status === 'blacklisted') return { label: '已拉黑', tone: 'scan-danger', title };
  if (record.scan_status === 'failed') return { label: '失败可重试', tone: 'scan-warning', title };
  if (due && record.scan_status === 'expired') return { label: '可复扫', tone: testableCount > 0 ? 'scan-success' : 'scan-info', title };
  if (record.raw_result_count === 0 || record.scan_status === 'raw_empty') return { label: '原始0条', tone: 'scan-muted', title };
  if (record.filtered_result_count === 0 || record.scan_status === 'filtered_empty') return { label: '筛后0条', tone: 'scan-warning', title };
  if (testableCount === 0 || record.scan_status === 'no_testable') return { label: coolingText || '无可测产品', tone: 'scan-muted', title };
  if (ABCount > 0) return { label: coolingText || `A/B ${ABCount}条`, tone: 'scan-success', title };
  if (record.C_count > 0 || record.scan_status === 'watch_rescan') return { label: coolingText || `可测${testableCount}条`, tone: 'scan-watch', title };
  if (record.scan_status === 'cooling') return { label: coolingText || '冷却中', tone: 'scan-muted', title };
  return { label: coolingText || `可测${testableCount}条`, tone: 'scan-info', title };
}

function matchesScanFilter(node: AmazonCategoryNode, records: Record<string, CategoryScanRecord>, filter: ScanFilter): boolean {
  if (filter === 'all') return true;
  const record = records[node.node_id];
  if (filter === 'not_scanned') return !record;
  if (!record) return false;
  if (filter === 'blacklisted') return record.scan_status === 'blacklisted';
  if (filter === 'failed') return record.scan_status === 'failed';
  if (filter === 'opportunity') return record.testable_count > 0 || record.A_count + record.A_candidate_count + record.B_count > 0;
  if (filter === 'watch') return record.scan_status === 'watch_rescan' || record.scan_status === 'filtered_empty' || record.C_count > 0;
  if (filter === 'cooling') return ['cooling', 'raw_empty', 'no_testable'].includes(record.scan_status) && !isRecordDue(record);
  return true;
}

function filterTreeByScan(nodes: AmazonCategoryNode[], records: Record<string, CategoryScanRecord>, filter: ScanFilter): AmazonCategoryNode[] {
  if (filter === 'all') return nodes;
  return nodes
    .map((node) => {
      const children = filterTreeByScan(node.children, records, filter);
      if (matchesScanFilter(node, records, filter) || children.length) return { ...node, children };
      return null;
    })
    .filter((node): node is AmazonCategoryNode => Boolean(node));
}

export default function AmazonCategoryTree({ selected, onSelect, refreshToken, collapsed = false, onCollapsedChange, scanRecords = {}, onNodesChange }: AmazonCategoryTreeProps) {
  const [nodes, setNodes] = useState<AmazonCategoryNode[]>(() => readCachedNodes());
  const [expanded, setExpanded] = useState<Set<string>>(() => readCachedExpanded());
  const [search, setSearch] = useState('');
  const [leafOnly, setLeafOnly] = useState(false);
  const [scanFilter, setScanFilter] = useState<ScanFilter>('all');
  const [loadingNode, setLoadingNode] = useState<string | null>(null);
  const [error, setError] = useState('');

  const saveTree = (next: AmazonCategoryNode[]) => {
    const sorted = sortCategoryNodes(next);
    setNodes(sorted);
    cacheNodes(sorted);
    onNodesChange?.(sorted);
  };

  useEffect(() => {
    onNodesChange?.(nodes);
  }, []);

  const saveExpanded = (updater: (current: Set<string>) => Set<string>) => {
    setExpanded((current) => {
      const next = updater(current);
      cacheExpanded(next);
      return next;
    });
  };

  const refreshRoots = async () => {
    setError('');
    setLoadingNode('ROOT');
    const result = await fetchCategoryNodes();
    setLoadingNode(null);
    if (result.status !== 'success' || !result.data) {
      setError(getMcpFriendlyError(result.error) || '类目节点加载失败，请检查卖家精灵 MCP 授权或稍后重试。');
      return;
    }
    saveTree(result.data);
  };

  useEffect(() => {
    if (refreshToken > 0) void refreshRoots();
  }, [refreshToken]);

  const requestRefresh = () => {
    if (!window.confirm('本次将调用卖家精灵 MCP 获取类目节点，可能消耗额度，是否继续？')) return;
    void refreshRoots();
  };

  const loadChildren = async (node: AmazonCategoryNode) => {
    if (!window.confirm(`本次将调用卖家精灵 MCP 获取「${node.name}」下级类目，可能消耗额度，是否继续？`)) return;
    setError('');
    setLoadingNode(node.id);
    const result = await fetchCategoryNodes(node.node_id);
    setLoadingNode(null);
    if (result.status !== 'success' || !result.data) {
      setError(getMcpFriendlyError(result.error) || '类目节点加载失败，请检查卖家精灵 MCP 授权或稍后重试。');
      return;
    }
    const next = attachChildren(nodes, node.id, result.data);
    saveTree(next);
    saveExpanded((current) => new Set(current).add(node.id));
  };

  const selectFromSearch = (node: AmazonCategoryNode) => {
    onSelect(toSelection(node));
    const parents = findAncestorIds(nodes, node.id) ?? [];
    if (parents.length) {
      saveExpanded((current) => {
        const next = new Set(current);
        parents.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const matches = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return flattenNodes(nodes).filter((node) => {
      if (leafOnly && !node.is_leaf) return false;
      if (!matchesScanFilter(node, scanRecords, scanFilter)) return false;
      if (!normalized) return true;
      return `${node.name} ${node.name_cn ?? ''} ${node.path}`.toLowerCase().includes(normalized);
    });
  }, [leafOnly, nodes, scanFilter, scanRecords, search]);

  const visibleTreeNodes = useMemo(() => filterTreeByScan(nodes, scanRecords, scanFilter), [nodes, scanFilter, scanRecords]);

  if (collapsed) {
    return (
      <section className="content-section category-tree-panel category-tree-panel-collapsed">
        <button className="category-collapsed-button" type="button" onClick={() => onCollapsedChange?.(false)} title="展开 Amazon 类目节点">
          展开类目
        </button>
      </section>
    );
  }

  return (
    <section className="content-section category-tree-panel">
      <div className="section-heading category-panel-heading">
        <div>
          <h2>Amazon 类目节点栏</h2>
          <p>默认 US。按需展开下级节点，缓存到当前浏览器。</p>
        </div>
        <div className="category-heading-actions">
          <button className="secondary-button category-refresh-button" type="button" onClick={requestRefresh} disabled={loadingNode !== null}>
            刷新节点
          </button>
          <button className="secondary-button category-refresh-button" type="button" onClick={() => onCollapsedChange?.(true)}>
            收起类目
          </button>
        </div>
      </div>
      <div className="category-tree-tools">
        <label>
          搜索类目名称
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已加载节点" />
        </label>
        <label>
          扫描状态
          <select value={scanFilter} onChange={(event) => setScanFilter(event.target.value as ScanFilter)}>
            {scanFilterOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={leafOnly} onChange={(event) => setLeafOnly(event.target.checked)} />
          只显示叶子类目
        </label>
      </div>
      {error && <div className="error-box">类目节点加载失败，请检查卖家精灵 MCP 授权或稍后重试。{error ? ` ${error}` : ''}</div>}
      {loadingNode === 'ROOT' && <div className="empty-state">正在获取 US 根类目节点。</div>}
      {!nodes.length && loadingNode === null && <div className="empty-state">还没有类目缓存。点击“刷新类目节点”开始加载。</div>}
      {nodes.length > 0 && search.trim() === '' && !leafOnly && (
        <div className="category-tree">
          {visibleTreeNodes.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              selectedNodeId={selected?.node_id ?? ''}
              expanded={expanded}
              loadingNode={loadingNode}
              onSelect={onSelect}
              onToggle={(id) =>
                saveExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onLoad={loadChildren}
              scanRecords={scanRecords}
            />
          ))}
          {!visibleTreeNodes.length && <div className="empty-state">当前扫描状态筛选下没有已加载类目。</div>}
        </div>
      )}
      {(search.trim() !== '' || leafOnly) && (
        <div className="category-search-results">
          {matches.slice(0, 80).map((node) => (
            <button className={`category-search-item ${levelClass(node)} ${selected?.node_id === node.node_id ? 'category-selected' : ''}`} key={node.id} type="button" onClick={() => selectFromSearch(node)}>
              <span className="category-level-pill">{levelLabel(node)}</span>
              <strong>{highlightedText(chineseName(node), search)}</strong>
              <em>{highlightedText(node.name, search)}</em>
              <span>{highlightedText(chinesePath(node) ?? englishPathLabel(node), search)}</span>
              <span className={`category-scan-pill ${scanDisplay(scanRecords[node.node_id]).tone}`} title={scanDisplay(scanRecords[node.node_id]).title}>
                {scanDisplay(scanRecords[node.node_id]).label}
              </span>
            </button>
          ))}
          {!matches.length && <div className="empty-state">已加载节点里没有匹配类目。可以先展开上级类目加载更多节点。</div>}
        </div>
      )}
    </section>
  );
}

function TreeNode({
  node,
  depth,
  selectedNodeId,
  expanded,
  loadingNode,
  onSelect,
  onToggle,
  onLoad,
  scanRecords,
}: {
  node: AmazonCategoryNode;
  depth: number;
  selectedNodeId: string;
  expanded: Set<string>;
  loadingNode: string | null;
  onSelect: (selection: CategorySelection) => void;
  onToggle: (id: string) => void;
  onLoad: (node: AmazonCategoryNode) => void;
  scanRecords: Record<string, CategoryScanRecord>;
}) {
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const canExpand = hasChildren || !node.is_leaf;
  const rowHeightClass = depth === 0 ? 'category-node-l1' : depth === 1 ? 'category-node-l2' : 'category-node-l3';
  const childCount = hasChildren ? node.children.length : null;
  const scan = scanDisplay(scanRecords[node.node_id]);

  const handleExpand = () => {
    if (hasChildren) onToggle(node.id);
    else if (!node.is_leaf) onLoad(node);
  };

  return (
    <div className="category-node">
      <div className={`category-node-row ${levelClass(node)} ${rowHeightClass} ${selectedNodeId === node.node_id ? 'category-selected' : ''}`} style={{ marginLeft: `${Math.min(depth, 4) * 16}px` }}>
        <button
          aria-label={isExpanded ? '收起下级类目' : '展开下级类目'}
          className={`category-arrow-button ${canExpand ? '' : 'category-arrow-spacer'}`}
          type="button"
          onClick={canExpand ? handleExpand : undefined}
          disabled={!canExpand || loadingNode === node.id}
          title={hasChildren ? (isExpanded ? '收起下级' : '展开下级') : node.is_leaf ? '叶子类目' : '加载下级'}
        >
          {loadingNode === node.id ? '...' : canExpand ? (isExpanded ? '▼' : '▶') : '•'}
        </button>
        <button className="category-node-main" type="button" onClick={() => onSelect(toSelection(node))}>
          <span className="category-title-line">
            <strong>{chineseName(node)}</strong>
            {selectedNodeId === node.node_id && <small className="category-current-pill">当前选中</small>}
            <small className={`category-scan-pill ${scan.tone}`} title={scan.title}>{scan.label}</small>
          </span>
          <span className="category-sub-line">
            <em>{node.name}</em>
            <small>{levelLabel(node)}</small>
            {node.is_leaf && <small>叶子</small>}
            {childCount !== null && <small>{childCount} 个子类目</small>}
          </span>
          <span className="category-path-line">{chinesePath(node) ?? englishPathLabel(node)}</span>
        </button>
        {!node.is_leaf && !hasChildren && (
          <button className="category-load-button" type="button" onClick={() => onLoad(node)} disabled={loadingNode === node.id}>
            {loadingNode === node.id ? '加载中' : '加载'}
          </button>
        )}
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              expanded={expanded}
              loadingNode={loadingNode}
              onSelect={onSelect}
              onToggle={onToggle}
              onLoad={onLoad}
              scanRecords={scanRecords}
            />
          ))}
        </div>
      )}
    </div>
  );
}
