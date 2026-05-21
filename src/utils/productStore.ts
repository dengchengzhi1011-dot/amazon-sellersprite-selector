import type {
  McpCandidateRecord,
  McpManualCostInput,
  McpMarginSnapshot,
  McpValidationResult,
  ProductExcelData,
  ProductManualData,
  ProductMcpSnapshot,
  ProductRecord,
} from '../types/mcp';
import { createExcelFromMcpSnapshot, scoreProduct } from './scoring';

const productsStorageKey = 'amazon-sellersprite-selector:products';
const candidatesStorageKey = 'amazon-sellersprite-selector:mcp-candidates';

export const defaultManualData: ProductManualData = {
  fba_fee: null,
  purchase_cost_usd: null,
  first_mile_cost_usd: null,
  package_cost_usd: null,
  storage_cost_usd: null,
  platform_other_fee: null,
  return_loss: null,
  referral_fee_rate: 0.15,
  risk_level: 'none',
  risk_tags: [],
  front_review_status: 'pending',
  notes: '',
};

const seedExcel: ProductExcelData = {
  asin: 'B0GJSCQ3PS',
  title: '小样本验证产品',
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
  raw: { source: 'seed' },
};

function withScore(product: Omit<ProductRecord, 'score'> & { score?: ProductRecord['score'] }): ProductRecord {
  const record = { ...product, score: product.score as ProductRecord['score'] } as ProductRecord;
  return { ...record, score: scoreProduct(record) };
}

export function createProductFromExcel(excel: ProductExcelData): ProductRecord {
  return withScore({
    id: excel.asin,
    asin: excel.asin,
    excel,
    manual: { ...defaultManualData },
    mcp_status: 'not_checked',
    mcp_checked_at: null,
    mcp_snapshot: null,
    mcp_error: null,
    candidate_saved_at: null,
  });
}

function normalizeProduct(raw: ProductRecord): ProductRecord {
  return withScore({
    ...raw,
    manual: { ...defaultManualData, ...raw.manual },
    mcp_status: raw.mcp_status ?? 'not_checked',
    mcp_checked_at: raw.mcp_checked_at ?? null,
    mcp_snapshot: raw.mcp_snapshot ?? null,
    mcp_error: raw.mcp_error ?? null,
  });
}

export function loadProducts(): ProductRecord[] {
  try {
    const raw = window.localStorage.getItem(productsStorageKey);
    if (!raw) return [createProductFromExcel(seedExcel)];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [createProductFromExcel(seedExcel)];
    return parsed.map((item) => normalizeProduct(item));
  } catch {
    return [createProductFromExcel(seedExcel)];
  }
}

export function saveProducts(products: ProductRecord[]) {
  window.localStorage.setItem(productsStorageKey, JSON.stringify(products.map((product) => withScore(product))));
}

export function upsertProductMcpData(params: {
  products: ProductRecord[];
  asin: string;
  mcpSnapshot: ProductMcpSnapshot | null;
  validation: McpValidationResult;
  manualCosts?: McpManualCostInput;
  notes?: string;
  markCandidate?: boolean;
}): ProductRecord[] {
  const asin = params.asin.trim();
  const now = new Date().toISOString();
  const error = params.validation.errors[params.validation.errors.length - 1] ?? null;
  const status = params.mcpSnapshot ? 'checked' : 'failed';
  const existing = params.products.find((product) => product.asin === asin);
  const manualFromCosts = mapManualCosts(params.manualCosts, existing?.manual, params.notes);
  const base: ProductRecord =
    existing ??
    createProductFromExcel({
      ...createExcelFromMcpSnapshot(asin, params.mcpSnapshot),
      asin,
    });

  const updated = withScore({
    ...base,
    manual: { ...base.manual, ...manualFromCosts },
    mcp_status: status,
    mcp_checked_at: now,
    mcp_snapshot: params.mcpSnapshot,
    mcp_error: status === 'failed' ? error : null,
    candidate_saved_at: params.markCandidate ? now : base.candidate_saved_at ?? null,
  });

  const next = [updated, ...params.products.filter((product) => product.asin !== asin)];
  saveProducts(next);
  return next;
}

function mapManualCosts(costs?: McpManualCostInput, existing: ProductManualData = defaultManualData, notes = ''): ProductManualData {
  if (!costs) return { ...existing, notes: notes || existing.notes };
  return {
    ...existing,
    fba_fee: costs.manual_fba_fee ?? existing.fba_fee,
    purchase_cost_usd: costs.purchase_cost ?? existing.purchase_cost_usd,
    first_mile_cost_usd: costs.first_leg_shipping ?? existing.first_mile_cost_usd,
    package_cost_usd: costs.packaging_cost ?? existing.package_cost_usd,
    storage_cost_usd: costs.storage_cost_usd ?? existing.storage_cost_usd,
    platform_other_fee: costs.platform_other_fee ?? existing.platform_other_fee,
    return_loss: costs.return_loss ?? existing.return_loss,
    referral_fee_rate: costs.referral_fee_rate ?? existing.referral_fee_rate,
    risk_level: costs.risk_level ?? existing.risk_level,
    risk_tags: costs.risk_tags ?? existing.risk_tags,
    notes: notes || existing.notes,
  };
}

export function loadCandidates(): McpCandidateRecord[] {
  try {
    const raw = window.localStorage.getItem(candidatesStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCandidates(candidates: McpCandidateRecord[]) {
  window.localStorage.setItem(candidatesStorageKey, JSON.stringify(candidates));
}

export function createCandidateRecord(params: {
  asin: string;
  keyword: string;
  product: ProductRecord | null;
  validation: McpValidationResult;
  costs: McpManualCostInput;
  margin: McpMarginSnapshot;
  notes: string;
}): McpCandidateRecord {
  const product = params.product;
  return {
    id: `${Date.now()}-${params.asin || 'unknown'}`,
    asin: params.asin,
    keyword: params.keyword,
    saved_at: new Date().toISOString(),
    excel_result: product?.excel ?? null,
    mcp_result: product?.mcp_snapshot ?? null,
    front_review_status: product?.manual.front_review_status ?? 'pending',
    final_advice: product?.score.layer ?? '待复核',
    product: product?.mcp_snapshot ?? null,
    keyword_snapshot: product?.mcp_snapshot?.keyword_summary ?? null,
    validation: params.validation,
    costs: params.costs,
    margin: params.margin,
    notes: params.notes,
  };
}

export function exportCandidatesCsv(candidates: McpCandidateRecord[]): string {
  const headers = ['ASIN', '关键词', '保存时间', '前台复核状态', '最终建议', '平台后毛利率', '最终毛利率', '备注'];
  const rows = candidates.map((candidate) => [
    candidate.asin,
    candidate.keyword,
    candidate.saved_at,
    candidate.front_review_status ?? 'pending',
    candidate.final_advice ?? '',
    candidate.margin.platform_margin_rate ?? '',
    candidate.margin.final_margin_rate ?? '',
    candidate.notes,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}
