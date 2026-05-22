import { readFileSync } from 'node:fs';

const checks = [];

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
}

function block(source, selector) {
  const index = source.indexOf(selector);
  if (index < 0) return '';
  const next = source.indexOf('\n}', index);
  return next < 0 ? source.slice(index) : source.slice(index, next + 2);
}

const page = read('src/pages/McpDiscoveryPage.tsx');
const tree = read('src/components/AmazonCategoryTree.tsx');
const styles = read('src/styles.css');
const pkg = JSON.parse(read('package.json'));

check('package.json exposes validate:discovery-layout', Boolean(pkg.scripts?.['validate:discovery-layout']));
check('McpDiscoveryPage keeps category collapse localStorage state', page.includes('mcp-discovery-category-collapsed') && page.includes('readCategoryCollapsed') && page.includes('saveCategoryCollapsed'));
check('AmazonCategoryTree accepts collapse controls', tree.includes('collapsed?: boolean') && tree.includes('onCollapsedChange') && tree.includes('展开类目') && tree.includes('收起类目'));
check('category column defaults to 320px with result area taking remaining space', /grid-template-columns:\s*320px\s+minmax\(0,\s*1fr\)/.test(styles));
check('category panel width is 320px and max is below 380px', /width:\s*320px/.test(styles) && /max-width:\s*3[0-7]\dpx/.test(styles));
check('collapsed category panel widens result area', /category-collapsed-layout[\s\S]*grid-template-columns:\s*52px\s+minmax\(0,\s*1fr\)/.test(styles));
check('result area can shrink without squeezing table', page.includes('className="discovery-main"') && styles.includes('.discovery-main') && styles.includes('min-width: 0'));
check('result table scrolls internally', /\.discovery-table\s*\{[\s\S]*(overflow-x:\s*auto|overflow:\s*auto)/.test(styles));
check('result table header is sticky in the scroll container', /\.discovery-table thead th\s*\{[\s\S]*position:\s*sticky/.test(styles));
check('result table has min-width for readable columns', /\.discovery-table table\s*\{[\s\S]*min-width:\s*(1[1-9]\d{2}|[2-9]\d{3})px/.test(styles));
check('main result filter is layer/opportunity first', page.indexOf('result-filter-primary') > -1 && page.indexOf('layerFilterOptions') < page.indexOf('ageFilterOptions'));
check('main layer filter contains all required labels', ['全部', 'A 优先开发', 'A候选', 'B 价格测试', 'C 观察复核', 'D 竞争偏高', 'E 放弃', '待复核'].every((label) => page.includes(label)));
check('time filter is secondary, not the only main filter', page.includes('result-filter-secondary') && page.includes('辅助：上架时间') && page.includes('ageFilterOptions'));
check('default sorting is opportunity first', page.includes("useState<ResultSortMode>('opportunity')"));
check('opportunity sort prioritizes layer then score signals', ['layerRank(left) - layerRank(right)', 'flea_market_score', 'new_product_sales_signal_score.score', 'low_review_sales_score.score'].every((text) => page.includes(text)));
check('all results are grouped by layer/opportunity level', page.includes('groupRowsForDisplay') && page.includes('机会分层：') && page.includes("layerQuickFilter === 'all'"));
check('source node display prefers category path before node id', page.includes('source_category_path || row.discovered.category_path') && page.indexOf('source_category_path || row.discovered.category_path') < page.indexOf('节点ID：'));
check('result table includes key business columns', ['价格', '月销量', '有效评论数', '上架天数', '新品动销分', '综合评分', '分层', '新品动销信号'].every((text) => page.includes(text)));

const failed = checks.filter((item) => !item.passed);
for (const item of checks) {
  console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
}

if (failed.length) {
  console.error(`\n${failed.length} discovery layout checks failed.`);
  process.exit(1);
}

console.log('\nDiscovery layout checks passed.');
