import { readFileSync } from 'node:fs';

const checks = [];

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const app = read('src/App.tsx');
const sidebar = read('src/components/SidebarNavigation.tsx');
const tree = read('src/components/AmazonCategoryTree.tsx');
const sortUtils = read('src/utils/categorySort.ts');
const discovery = read('src/pages/McpDiscoveryPage.tsx');
const pkg = JSON.parse(read('package.json'));

const expectedLabels = [
  'MCP找品',
  '候选池',
  '商品详情',
  'MCP验证',
  '前台复核池',
  '利润测算',
  '开发池',
  '历史库',
  'Excel导入',
  '导出',
];

const navBlock = between(app, 'const navItems', '];');
const actualLabels = Array.from(navBlock.matchAll(/label:\s*'([^']+)'/g)).map((match) => match[1]);
const actualTopLevelLabels = actualLabels.filter((label) => !['类目节点选品', '店铺选品'].includes(label));
const chooseCategoryBlock = between(discovery, 'const chooseCategory', '};');

check('package.json exposes validate:navigation', Boolean(pkg.scripts?.['validate:navigation']));
check('left navigation labels are in the required stable order', JSON.stringify(actualTopLevelLabels) === JSON.stringify(expectedLabels), `actual=${actualTopLevelLabels.join(' > ')}`);
check('MCP discovery exposes stable second-level menu', actualLabels.includes('类目节点选品') && actualLabels.includes('店铺选品') && navBlock.includes('children'));
check('left navigation is declared as a fixed array', navBlock.includes('ReadonlyArray') && navBlock.includes("key: 'mcp-discovery'") && navBlock.includes("label: 'MCP找品'"));
check('SidebarNavigation renders provided items through stable groups', sidebar.includes('NAV_GROUPS') && sidebar.includes('group.items.map((item)') && sidebar.includes('key={item.key}'));
check('SidebarNavigation does not render from Object.keys', !/Object\.keys\s*\(/.test(sidebar));
check('App navigation does not derive nav order from Object.keys', !/Object\.keys\s*\([^)]*nav/i.test(app));
check('SidebarNavigation persists collapse state with sidebar_collapsed key', sidebar.includes('sidebar_collapsed') && sidebar.includes('localStorage.setItem') && sidebar.includes('localStorage.getItem'));
check('SidebarNavigation provides icons, aria labels and collapsed tooltips', sidebar.includes('NAV_VISUALS') && sidebar.includes('aria-label={item.label}') && sidebar.includes('data-tooltip={item.label}'));
check('SidebarNavigation auto collapses on <=1280px media query', sidebar.includes('(max-width: 1280px)') && sidebar.includes('matchMedia'));
check('AmazonCategoryTree imports stable category sorting helper', tree.includes("import { sortCategoryNodes } from '../utils/categorySort'"));
check('AmazonCategoryTree sorts cached/root/children nodes', ['readCachedNodes', 'saveTree', 'attachChildren'].every((name) => tree.includes(name)) && tree.match(/sortCategoryNodes/g)?.length >= 4);
check('categorySort orders by level, alphabetic name, then node id', sortUtils.includes('left.level - right.level') && sortUtils.includes('localeCompare') && sortUtils.includes('node_id.localeCompare'));
check('AmazonCategoryTree persists expanded state', tree.includes('categoryExpandedCacheKey') && tree.includes('readCachedExpanded') && tree.includes('cacheExpanded') && tree.includes('window.localStorage'));
check('selecting a category does not clear discovery results', chooseCategoryBlock.includes('setSelection') && chooseCategoryBlock.includes('saveSelection') && !chooseCategoryBlock.includes('setRows') && !chooseCategoryBlock.includes('clear'));
check('tree node click only selects, expand button handles loading separately', tree.includes('onClick={() => onSelect(toSelection(node))}') && tree.includes('handleExpand') && tree.includes('onLoad(node)'));

const failed = checks.filter((item) => !item.passed);
for (const item of checks) {
  console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
}

if (failed.length) {
  console.error(`\n${failed.length} navigation checks failed.`);
  process.exit(1);
}

console.log('\nNavigation checks passed.');
