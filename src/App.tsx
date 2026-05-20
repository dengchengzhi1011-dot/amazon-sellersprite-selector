import { useEffect, useMemo, useState } from 'react';
import McpValidationPage from './pages/McpValidationPage';

type AppPage =
  | 'excel'
  | 'products'
  | 'product-detail'
  | 'screening'
  | 'review'
  | 'profit'
  | 'development'
  | 'export'
  | 'mcp-validation';

const navItems: Array<{ key: AppPage; label: string }> = [
  { key: 'excel', label: 'Excel导入' },
  { key: 'products', label: '商品列表' },
  { key: 'product-detail', label: '商品详情' },
  { key: 'screening', label: '初筛池' },
  { key: 'review', label: '前台复核池' },
  { key: 'profit', label: '利润测算' },
  { key: 'development', label: '开发池' },
  { key: 'export', label: '导出' },
  { key: 'mcp-validation', label: 'MCP验证' },
];

const sampleProducts = [
  {
    asin: 'B0GJSCQ3PS',
    title: '小样本验证产品',
    reviewCount: '待查',
    price: '待查',
    status: '等待 MCP 验证',
  },
];

function readInitialPage(): AppPage {
  const params = new URLSearchParams(window.location.search);
  const page = params.get('page') as AppPage | null;
  return navItems.some((item) => item.key === page) ? page! : 'mcp-validation';
}

function App() {
  const [activePage, setActivePage] = useState<AppPage>(() => readInitialPage());
  const [collapsed, setCollapsed] = useState(false);
  const [mcpAsin, setMcpAsin] = useState(() => new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');

  useEffect(() => {
    const onPopState = () => {
      setActivePage(readInitialPage());
      setMcpAsin(new URLSearchParams(window.location.search).get('asin') ?? 'B0GJSCQ3PS');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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
  };

  const title = useMemo(() => navItems.find((item) => item.key === activePage)?.label ?? 'MCP验证', [activePage]);

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

        {activePage === 'mcp-validation' ? (
          <McpValidationPage initialAsin={mcpAsin} />
        ) : activePage === 'products' ? (
          <section className="content-section">
            <div className="section-heading">
              <h2>商品列表</h2>
              <p>当前版本先放入一个测试 ASIN，用于演示“发送到 MCP 验证”的安全跳转。</p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ASIN</th>
                    <th>标题</th>
                    <th>价格</th>
                    <th>评论数</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleProducts.map((product) => (
                    <tr key={product.asin}>
                      <td>{product.asin}</td>
                      <td>{product.title}</td>
                      <td>{product.price}</td>
                      <td>{product.reviewCount}</td>
                      <td>{product.status}</td>
                      <td>
                        <button className="secondary-button" type="button" onClick={() => navigate('mcp-validation', { asin: product.asin })}>
                          发送到 MCP 验证
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <PlaceholderPage page={title} />
        )}
      </main>
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
