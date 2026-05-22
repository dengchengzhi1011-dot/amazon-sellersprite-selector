import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = await mkdtemp(join(tmpdir(), 'seller-signal-'));
const outfile = join(tmp, 'scoring.mjs');

await build({
  entryPoints: ['src/utils/scoring.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});

const { scoreProduct } = await import(pathToFileURL(outfile).href);

function product({
  asin,
  age,
  reviews,
  sales,
  rating = null,
  price = 20,
  fba = 2,
  fbaSource = 'mcp',
  keywordConfidence = 'low',
  image = 'https://example.com/main.jpg',
  riskLevel = 'none',
}) {
  return {
    id: asin,
    asin,
    excel: {
      asin,
      title: `${asin} sample`,
      brand: null,
      category: null,
      price_mid: null,
      rating: null,
      review_count: null,
      monthly_sales: null,
      monthly_revenue: null,
      bsr: null,
      fba_fee: null,
      seller: null,
      seller_type: null,
      variation_count: null,
      fulfillment_type: null,
      raw: {},
    },
    manual: {
      fba_fee: null,
      purchase_cost_rmb: null,
      exchange_rate: 7.2,
      purchase_cost_usd: null,
      first_mile_cost_usd: null,
      package_cost_usd: null,
      storage_cost_usd: null,
      platform_other_fee: null,
      return_loss: null,
      referral_fee_rate: 0.15,
      target_price: null,
      risk_level: riskLevel,
      risk_tags: riskLevel === 'severe' ? ['危险品'] : [],
      front_review_status: 'pending',
      notes: '',
    },
    mcp_status: 'checked',
    mcp_checked_at: '2026-05-21T00:00:00.000Z',
    mcp_error: null,
    mcp_snapshot: {
      asin,
      title: `${asin} sample`,
      brand: null,
      category: 'Sample',
      price,
      coupon_price: null,
      rating,
      review_count: reviews,
      bsr: null,
      monthly_sales: sales,
      monthly_revenue: sales === null ? null : sales * price,
      fba_fee: fba,
      fba_fee_source: fba === null ? fbaSource : 'mcp',
      referral_fee: null,
      referral_fee_rate: null,
      referral_fee_rate_source: 'default_rate',
      main_image_url: image,
      main_image_source: image ? 'mcp' : 'missing',
      seller: null,
      seller_type: null,
      variation_count: null,
      buybox_seller: null,
      fulfillment_type: null,
      listed_at: null,
      listed_at_source: age === null ? 'missing' : 'mcp',
      launch_date: null,
      first_available_date: null,
      product_age_days: age,
      listed_days: age,
      is_recent_product: age !== null && age <= 365,
      recent_product_level: age === null ? '时间缺失' : age <= 30 ? '新品观察' : age <= 180 ? '新品优先' : age <= 365 ? '稳定新品' : '老品',
      main_keyword: null,
      long_tail_keywords: [],
      keyword_snapshots: [],
      keyword_insights: [],
      keyword_data_confidence: keywordConfidence,
      long_tail_opportunity_level: 'unknown',
      recommended_sp_keywords: [],
      rejected_keywords: [],
      keyword_summary: null,
      traffic_summary: null,
      prediction_summary: null,
      raw: {
        asin_detail: {
          product_age_days: age,
          reviewCount: reviews,
          estimated_monthly_sales: sales,
        },
        asin_prediction: null,
        traffic_keyword_stat: null,
        keyword_miner: null,
      },
    },
    front_review: {},
  };
}

const tests = [
  {
    name: '90天内，0评论，月销量10',
    product: product({ asin: 'T1', age: 90, reviews: 0, sales: 10, rating: null }),
    assert: (score) => score.new_product_sales_signal_score.score === 30 && score.layer !== 'E放弃池',
  },
  {
    name: '180天内，10评论，月销量20',
    product: product({ asin: 'T2', age: 180, reviews: 10, sales: 20 }),
    assert: (score) => score.new_product_sales_signal_score.score >= 28 && /A|B/.test(score.layer),
  },
  {
    name: '365天内，30评论，月销量30，毛利达标',
    product: product({ asin: 'T3', age: 365, reviews: 30, sales: 30 }),
    assert: (score) => score.new_product_sales_signal_score.score >= 26 && /A|B/.test(score.layer),
  },
  {
    name: '0评论，月销量20，180天内，rating缺失',
    product: product({ asin: 'T4', age: 180, reviews: 0, sales: 20, rating: null }),
    assert: (score) => score.new_product_sales_signal_score.score >= 28 && /A|B/.test(score.layer),
  },
  {
    name: '0评论，月销量5-20',
    product: product({ asin: 'T5', age: 300, reviews: 0, sales: 12, rating: null }),
    assert: (score) => score.new_product_sales_signal_score.score >= 22 && score.layer !== 'E放弃池',
  },
  {
    name: '评论缺失但月销量有',
    product: product({ asin: 'T6', age: 120, reviews: null, sales: 25 }),
    assert: (score) => score.new_product_sales_signal_score.score >= 12 && score.layer !== 'E放弃池',
  },
  {
    name: '销量缺失但评论低',
    product: product({ asin: 'T7', age: 120, reviews: 20, sales: null }),
    assert: (score) => score.new_product_sales_signal_score.score >= 10 && score.layer !== 'E放弃池',
  },
  {
    name: 'rating/关键词/FBA/主图缺失但0评论月销25',
    product: product({ asin: 'T8', age: 120, reviews: 0, sales: 25, rating: null, fba: null, fbaSource: 'missing', image: null }),
    assert: (score) => score.layer !== 'E放弃池' && /A|B|C/.test(score.layer),
  },
  {
    name: '严重风险产品仍进入E',
    product: product({ asin: 'T9', age: 60, reviews: 0, sales: 25, riskLevel: 'severe' }),
    assert: (score) => score.layer === 'E放弃池',
  },
  {
    name: '评论高但销量低不触发新品少评',
    product: product({ asin: 'T10', age: 700, reviews: 1000, sales: 5 }),
    assert: (score) => !score.new_product_sales_signal_score.is_new_product_sales_signal,
  },
];

const failures = [];
for (const test of tests) {
  const score = scoreProduct(test.product);
  const passed = test.assert(score);
  const line = `${passed ? 'PASS' : 'FAIL'} ${test.name}: 新品动销分=${score.new_product_sales_signal_score.score}, 分层=${score.layer}, 信号=${score.new_product_sales_signal_score.signal_label}`;
  console.log(line);
  if (!passed) failures.push(line);
}

await rm(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} 个样例未通过`);
  process.exit(1);
}

console.log('\n全部新品动销样例验证通过。');
