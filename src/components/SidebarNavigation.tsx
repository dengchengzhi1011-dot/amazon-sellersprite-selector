import { useEffect, useMemo, useState } from 'react';

export interface SidebarNavItem<Key extends string = string> {
  key: Key;
  label: string;
  children?: ReadonlyArray<SidebarNavItem<Key>>;
}

type NavGroupId = 'main' | 'ops' | 'tools';

const sidebarCollapsedStorageKey = 'sidebar_collapsed';
const narrowScreenQuery = '(max-width: 1280px)';

const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; label: string; itemKeys: string[] }> = [
  { id: 'main', label: '主流程', itemKeys: ['mcp-discovery', 'products', 'product-detail', 'mcp-validation'] },
  { id: 'ops', label: '运营辅助', itemKeys: ['review', 'profit', 'development', 'history'] },
  { id: 'tools', label: '工具模块', itemKeys: ['excel', 'export'] },
];

const NAV_VISUALS: ReadonlyArray<{ key: string; icon: string; group: NavGroupId }> = [
  { key: 'mcp-discovery', icon: '找', group: 'main' },
  { key: 'mcp-store-discovery', icon: '店', group: 'main' },
  { key: 'products', icon: '候', group: 'main' },
  { key: 'product-detail', icon: '详', group: 'main' },
  { key: 'mcp-validation', icon: '验', group: 'main' },
  { key: 'review', icon: '复', group: 'ops' },
  { key: 'profit', icon: '利', group: 'ops' },
  { key: 'development', icon: '发', group: 'ops' },
  { key: 'history', icon: '史', group: 'ops' },
  { key: 'excel', icon: '表', group: 'tools' },
  { key: 'export', icon: '出', group: 'tools' },
];

function readInitialCollapsed(fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(sidebarCollapsedStorageKey);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return window.matchMedia?.(narrowScreenQuery).matches ? true : fallback;
}

function saveCollapsed(value: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(sidebarCollapsedStorageKey, value ? '1' : '0');
}

function visualFor(key: string): { icon: string; group: NavGroupId } {
  return NAV_VISUALS.find((item) => item.key === key) ?? { icon: key.slice(0, 1).toUpperCase(), group: 'tools' };
}

function isItemActive<Key extends string>(item: SidebarNavItem<Key>, activePage: Key): boolean {
  return activePage === item.key || Boolean(item.children?.some((child) => child.key === activePage));
}

interface SidebarNavigationProps<Key extends string = string> {
  activePage: Key;
  collapsed: boolean;
  items: ReadonlyArray<SidebarNavItem<Key>>;
  onNavigate: (page: Key, meta?: { fromParent?: boolean }) => void;
  onToggleCollapsed: () => void;
}

export default function SidebarNavigation<Key extends string>({
  activePage,
  collapsed,
  items,
  onNavigate,
  onToggleCollapsed,
}: SidebarNavigationProps<Key>) {
  const [isCollapsed, setIsCollapsed] = useState(() => readInitialCollapsed(collapsed));
  const groupedItems = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: items.filter((item) => visualFor(String(item.key)).group === group.id),
      })).filter((group) => group.items.length > 0),
    [items],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(narrowScreenQuery);
    const collapseForNarrowScreen = () => {
      if (!media.matches) return;
      setIsCollapsed(true);
      saveCollapsed(true);
    };
    collapseForNarrowScreen();
    media.addEventListener?.('change', collapseForNarrowScreen);
    return () => media.removeEventListener?.('change', collapseForNarrowScreen);
  }, []);

  const toggleCollapsed = () => {
    setIsCollapsed((current) => {
      const next = !current;
      saveCollapsed(next);
      return next;
    });
    onToggleCollapsed();
  };

  return (
    <aside className={`sidebar ${isCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`} aria-label="左侧导航">
      <div className="sidebar-topbar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">AS</div>
          {!isCollapsed && (
            <div className="brand-copy">
              <div className="brand-title">SellerSprite Selector</div>
              <div className="brand-subtitle">铺货单品验证</div>
            </div>
          )}
        </div>
        <button
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? '展开左侧导航' : '收起左侧导航'}
          className="nav-toggle"
          type="button"
          onClick={toggleCollapsed}
          title={isCollapsed ? '展开左侧导航' : '收起左侧导航'}
        >
          <span className="nav-toggle-icon" aria-hidden="true">{isCollapsed ? '›' : '‹'}</span>
          {!isCollapsed && <span>收起</span>}
        </button>
      </div>
      <nav className="nav-list" aria-label="主导航">
        {groupedItems.map((group) => (
          <div className="nav-group" key={group.id}>
            <div className="nav-group-label" aria-hidden={isCollapsed ? 'true' : 'false'}>
              {isCollapsed ? '' : group.label}
            </div>
            {group.items.map((item) => {
              const visual = visualFor(String(item.key));
              const active = isItemActive(item, activePage);
              return (
                <div className="nav-item-wrap" key={item.key}>
                  <button
                    aria-current={active ? 'page' : undefined}
                    aria-label={item.label}
                    className={`nav-item ${active ? 'nav-item-active' : ''}`}
                    data-tooltip={item.label}
                    type="button"
                    onClick={() => onNavigate(item.key, { fromParent: Boolean(item.children?.length) })}
                    title={item.label}
                  >
                    <span className="nav-icon" aria-hidden="true">{visual.icon}</span>
                    {!isCollapsed && <span className="nav-label">{item.label}</span>}
                  </button>
                  {!isCollapsed && item.children?.length ? (
                    <div className="nav-submenu" aria-label={`${item.label}二级菜单`}>
                      {item.children.map((child) => {
                        const childVisual = visualFor(String(child.key));
                        return (
                          <button
                            aria-current={activePage === child.key ? 'page' : undefined}
                            aria-label={child.label}
                            className={`nav-subitem ${activePage === child.key ? 'nav-subitem-active' : ''}`}
                            data-tooltip={child.label}
                            key={child.key}
                            type="button"
                            onClick={() => onNavigate(child.key, { fromParent: false })}
                            title={child.label}
                          >
                            <span className="nav-subicon" aria-hidden="true">{childVisual.icon}</span>
                            <span>{child.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
