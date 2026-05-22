import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = await mkdtemp(join(tmpdir(), 'seller-mcp-flow-'));
const keywordOut = join(tmp, 'keywordTools.mjs');
const scoringOut = join(tmp, 'scoring.mjs');

await Promise.all([
  build({
    entryPoints: ['src/utils/keywordTools.ts'],
    outfile: keywordOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  }),
  build({
    entryPoints: ['src/utils/scoring.ts'],
    outfile: scoringOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  }),
]);

const {
  classifyAsinKeywords,
  insightsFromTitleCandidates,
  normalizeAsinKeywordInsights,
} = await import(pathToFileURL(keywordOut).href);
const { scoreProduct } = await import(pathToFileURL(scoringOut).href);

function product({ asin, ratings, reviews, sales, rating = null, age = 120, fba = 2, keywordInsights = [], keywordConfidence = 'unknown' }) {
  return {
    id: asin,
    asin,
    excel: {
      asin,
      title: 'Sample Snack Tray Basket',
      brand: null,
      category: 'Home',
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
      risk_level: 'none',
      risk_tags: [],
      front_review_status: 'pending',
      notes: '',
    },
    mcp_status: 'checked',
    mcp_checked_at: '2026-05-21T00:00:00.000Z',
    mcp_error: null,
    mcp_snapshot: {
      asin,
      title: 'Sample Snack Tray Basket',
      brand: null,
      category: 'Home',
      price: 20,
      coupon_price: null,
      rating,
      review_count: ratings ?? reviews,
      bsr: 50000,
      monthly_sales: sales,
      monthly_revenue: sales === null ? null : sales * 20,
      fba_fee: fba,
      fba_fee_source: fba === null ? 'missing' : 'mcp',
      referral_fee: null,
      referral_fee_rate: null,
      referral_fee_rate_source: 'default_rate',
      main_image_url: null,
      main_image_source: 'missing',
      seller: null,
      seller_type: null,
      variation_count: null,
      buybox_seller: null,
      fulfillment_type: null,
      listed_at: null,
      listed_at_source: 'mcp',
      launch_date: null,
      first_available_date: null,
      product_age_days: age,
      listed_days: age,
      is_recent_product: age <= 365,
      recent_product_level: '新品优先',
      main_keyword: null,
      long_tail_keywords: [],
      keyword_snapshots: [],
      keyword_insights: keywordInsights,
      keyword_data_confidence: keywordConfidence,
      long_tail_opportunity_level: 'unknown',
      recommended_sp_keywords: [],
      rejected_keywords: [],
      keyword_summary: null,
      traffic_summary: null,
      prediction_summary: null,
      raw: {
        asin_detail: { ratings, reviews, rating, product_age_days: age, monthly_sales: sales },
        asin_prediction: null,
        traffic_keyword_stat: null,
        keyword_miner: null,
      },
    },
    front_review: {},
  };
}

const trafficInsights = normalizeAsinKeywordInsights({
  asin: 'KW1',
  sourceTool: 'traffic_keyword',
  title: 'Under Sink Organizer 2 Tier Sliding Cabinet Basket',
  category: 'Kitchen Storage',
  raw: [
    { keyword: 'under sink organizer', searches: 2500, purchases: 120, purchaseRate: 0.048, bid: 0.62, titleDensity: 8, adProducts: 12, trafficPercentage: 0.18 },
    { keyword: '2 tier under sink organizer', searches: 900, purchases: 40, purchaseRate: 0.044, bid: 0.51, titleDensity: 4, adProducts: 5, trafficPercentage: 0.12 },
  ],
});
const orderInsights = normalizeAsinKeywordInsights({
  asin: 'KW2',
  sourceTool: 'keyword_order',
  title: 'Under Sink Organizer 2 Tier Sliding Cabinet Basket',
  category: 'Kitchen Storage',
  raw: [{ keyword: 'bathroom sink organizer', searches: 800, purchases: 32, purchaseRate: 0.04, bid: 0.55, titleDensity: 5, adProducts: 6 }],
});
const titleFallback = insightsFromTitleCandidates({
  asin: 'KW3',
  title: 'Snack Trays Basket Handles Bucket Bowl Container Storage Gifts Theater',
  category: 'Home Storage',
});

const tests = [
  {
    name: 'traffic_keyword 返回真实词，可信度高',
    assert: () => {
      const classified = classifyAsinKeywords({ asin: 'KW1', insights: trafficInsights, title: 'Under Sink Organizer 2 Tier Sliding Cabinet Basket', category: 'Kitchen Storage' });
      return classified.keyword_data_confidence === 'high' && classified.recommended_sp_keywords.length > 0;
    },
  },
  {
    name: 'keyword_order 返回出单词，可信度中高',
    assert: () => {
      const classified = classifyAsinKeywords({ asin: 'KW2', insights: orderInsights, title: 'Under Sink Organizer 2 Tier Sliding Cabinet Basket', category: 'Kitchen Storage' });
      return classified.keyword_data_confidence === 'medium_high' && classified.keyword_insights.some((item) => item.source_tool === 'keyword_order');
    },
  },
  {
    name: '只有标题拆词，不推荐SP且低可信',
    assert: () => {
      const classified = classifyAsinKeywords({ asin: 'KW3', insights: titleFallback, title: 'Snack Trays Basket Handles Bucket Bowl Container Storage Gifts Theater', category: 'Home Storage' });
      return classified.keyword_data_confidence === 'low' && classified.recommended_sp_keywords.length === 0 && classified.keyword_insights.every((item) => item.data_confidence === 'low');
    },
  },
  {
    name: 'reviews=null 但 ratings=130，不识别成0评论',
    assert: () => {
      const score = scoreProduct(product({ asin: 'RV1', ratings: 130, reviews: null, sales: 25 }));
      return score.new_product_sales_signal_score.signal_label !== '0评论已出单';
    },
  },
  {
    name: 'ratings=0 且月销量>=20，0评论已出单',
    assert: () => {
      const score = scoreProduct(product({ asin: 'RV2', ratings: 0, reviews: 0, sales: 25, rating: null }));
      return score.new_product_sales_signal_score.score >= 28 && score.layer !== 'E放弃池';
    },
  },
  {
    name: 'FBA缺失但新品动销强，不进E',
    assert: () => {
      const score = scoreProduct(product({ asin: 'FBA1', ratings: 0, reviews: 0, sales: 25, rating: null, fba: null }));
      return score.layer !== 'E放弃池' && score.layer_reasons.some((item) => item.includes('FBA'));
    },
  },
];

const failures = [];
for (const test of tests) {
  const passed = test.assert();
  console.log(`${passed ? 'PASS' : 'FAIL'} ${test.name}`);
  if (!passed) failures.push(test.name);
}

await rm(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} 个 MCP 验证流程样例未通过：${failures.join('、')}`);
  process.exit(1);
}

console.log('\n全部 MCP 验证流程样例通过。');
