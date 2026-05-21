import { useEffect, useMemo, useState } from 'react';
import type { AmazonCategoryNode, CategorySelection } from '../types/mcp';
import { fetchCategoryNodes, getMcpFriendlyError } from '../utils/sellerspriteMcp';

const categoryCacheKey = 'amazon-sellersprite-selector:amazon-category-tree:US';

interface AmazonCategoryTreeProps {
  selected: CategorySelection | null;
  onSelect: (selection: CategorySelection) => void;
  refreshToken: number;
}

function readCachedNodes(): AmazonCategoryNode[] {
  try {
    const raw = window.localStorage.getItem(categoryCacheKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cacheNodes(nodes: AmazonCategoryNode[]) {
  window.localStorage.setItem(categoryCacheKey, JSON.stringify(nodes));
}

function flattenNodes(nodes: AmazonCategoryNode[]): AmazonCategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

function updateNode(nodes: AmazonCategoryNode[], id: string, updater: (node: AmazonCategoryNode) => AmazonCategoryNode): AmazonCategoryNode[] {
  return nodes.map((node) => {
    if (node.id === id) return updater(node);
    if (!node.children.length) return node;
    return { ...node, children: updateNode(node.children, id, updater) };
  });
}

function attachChildren(nodes: AmazonCategoryNode[], parentId: string | undefined, children: AmazonCategoryNode[]): AmazonCategoryNode[] {
  if (!parentId) return children;
  return updateNode(nodes, parentId, (node) => ({ ...node, children, is_leaf: children.length === 0 }));
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

export default function AmazonCategoryTree({ selected, onSelect, refreshToken }: AmazonCategoryTreeProps) {
  const [nodes, setNodes] = useState<AmazonCategoryNode[]>(() => readCachedNodes());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [leafOnly, setLeafOnly] = useState(false);
  const [loadingNode, setLoadingNode] = useState<string | null>(null);
  const [error, setError] = useState('');

  const saveTree = (next: AmazonCategoryNode[]) => {
    setNodes(next);
    cacheNodes(next);
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
    setExpanded(new Set());
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
    setExpanded((current) => new Set(current).add(node.id));
  };

  const matches = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return flattenNodes(nodes).filter((node) => {
      if (leafOnly && !node.is_leaf) return false;
      if (!normalized) return true;
      return `${node.name} ${node.name_cn ?? ''} ${node.path}`.toLowerCase().includes(normalized);
    });
  }, [leafOnly, nodes, search]);

  return (
    <section className="content-section category-tree-panel">
      <div className="section-heading">
        <h2>Amazon 类目节点栏</h2>
        <p>默认 US。先取根类目，再按需加载下级节点并缓存到当前浏览器。</p>
      </div>
      <div className="category-tree-tools">
        <label>
          搜索类目名称
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已加载节点" />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={leafOnly} onChange={(event) => setLeafOnly(event.target.checked)} />
          只显示叶子类目
        </label>
      </div>
      <div className="action-row compact-actions">
        <button className="secondary-button" type="button" onClick={requestRefresh} disabled={loadingNode !== null}>
          刷新类目节点
        </button>
      </div>
      {error && <div className="error-box">类目节点加载失败，请检查卖家精灵 MCP 授权或稍后重试。{error ? ` ${error}` : ''}</div>}
      {loadingNode === 'ROOT' && <div className="empty-state">正在获取 US 根类目节点。</div>}
      {!nodes.length && loadingNode === null && <div className="empty-state">还没有类目缓存。点击“刷新类目节点”开始加载。</div>}
      {nodes.length > 0 && search.trim() === '' && !leafOnly && (
        <div className="category-tree">
          {nodes.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              selectedNodeId={selected?.node_id ?? ''}
              expanded={expanded}
              loadingNode={loadingNode}
              onSelect={onSelect}
              onToggle={(id) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onLoad={loadChildren}
            />
          ))}
        </div>
      )}
      {(search.trim() !== '' || leafOnly) && (
        <div className="category-search-results">
          {matches.slice(0, 80).map((node) => (
            <button className={`category-search-item ${selected?.node_id === node.node_id ? 'category-selected' : ''}`} key={node.id} type="button" onClick={() => onSelect(toSelection(node))}>
              <strong>{chineseName(node)}</strong>
              <em>{node.name}</em>
              <span>{chinesePath(node) ?? englishPathLabel(node)}</span>
              <small>{node.is_leaf ? '叶子类目' : `层级 ${node.level}`}</small>
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
}: {
  node: AmazonCategoryNode;
  depth: number;
  selectedNodeId: string;
  expanded: Set<string>;
  loadingNode: string | null;
  onSelect: (selection: CategorySelection) => void;
  onToggle: (id: string) => void;
  onLoad: (node: AmazonCategoryNode) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  return (
    <div className="category-node">
      <div className={`category-node-row ${selectedNodeId === node.node_id ? 'category-selected' : ''}`} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        <button className="category-node-main" type="button" onClick={() => onSelect(toSelection(node))}>
          <strong>{chineseName(node)}</strong>
          <em>{node.name}</em>
          <span>{chinesePath(node) ?? englishPathLabel(node)}</span>
        </button>
        {hasChildren && (
          <button className="category-expand-button" type="button" onClick={() => onToggle(node.id)}>
            {isExpanded ? '收起下级' : '展开下级'}
          </button>
        )}
        {!node.is_leaf && !hasChildren && (
          <button className="category-load-button" type="button" onClick={() => onLoad(node)} disabled={loadingNode === node.id}>
            {loadingNode === node.id ? '加载中' : '加载下级类目'}
          </button>
        )}
        {node.is_leaf && <span className="category-leaf-pill">叶子类目</span>}
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
            />
          ))}
        </div>
      )}
    </div>
  );
}
