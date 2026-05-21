import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FrontReview, FrontReviewStatus, ProductRecord, ReviewRiskLevel, ReviewStrength, TriState } from '../types/mcp';
import { scoreFrontReview, resolveProductData } from '../utils/scoring';

type Props = {
  product: ProductRecord;
  onSave: (review: FrontReview) => void;
};

type NumberKey = 'front_price' | 'coupon_value' | 'actual_buybox_price' | 'front_review_count' | 'front_rating' | 'variation_count_front';
type TextKey =
  | 'reviewer'
  | 'amazon_url'
  | 'search_url'
  | 'notes'
  | 'price_notes'
  | 'review_notes'
  | 'page_weakness_notes'
  | 'risk_notes'
  | 'recommended_ad_keywords'
  | 'ad_notes';
type TriStateKey =
  | 'price_match_mcp'
  | 'can_undercut_3'
  | 'can_undercut_5'
  | 'can_undercut_8'
  | 'can_undercut_10'
  | 'review_count_match_mcp'
  | 'reviews_concentrated_in_old_variants'
  | 'low_review_competitors_exist'
  | 'has_video'
  | 'amazon_self_operated'
  | 'can_use_price_undercut_strategy';

const riskOptions: ReviewRiskLevel[] = ['low', 'medium', 'high'];
const qualityOptions: ReviewStrength[] = ['weak', 'normal', 'strong'];

function valueLabel(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function triStateValue(value: TriState): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'unknown';
}

function parseTriState(value: string): TriState {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'unknown';
}

function searchUrl(keyword: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(keyword || '')}`;
}

function reviewSearchUrl(review: FrontReview, keyword: string): string {
  return review.search_url && !review.search_url.endsWith('s?k=') ? review.search_url : searchUrl(keyword);
}

function decisionLabel(decision: FrontReview['final_manual_decision']): string {
  const labels = {
    develop: '开发',
    small_test: '小批量测试',
    wait: '等待',
    reject: '放弃',
  };
  return labels[decision];
}

function statusLabel(status: FrontReviewStatus): string {
  const labels: Record<FrontReviewStatus, string> = {
    not_started: '未开始',
    in_progress: '复核中',
    passed: '通过',
    failed: '不通过',
    need_second_check: '待二次确认',
  };
  return labels[status];
}

export default function FrontReviewPanel({ product, onSave }: Props) {
  const resolved = resolveProductData(product);
  const mainKeyword = resolved.keyword ?? '';
  const [draft, setDraft] = useState<FrontReview>(() => ({
    ...product.front_review,
    search_url: reviewSearchUrl(product.front_review, mainKeyword),
  }));
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setDraft({
      ...product.front_review,
      search_url: reviewSearchUrl(product.front_review, mainKeyword),
    });
    setNotice('');
  }, [mainKeyword, product.asin, product.front_review]);

  const preview = useMemo(() => scoreFrontReview(draft), [draft]);

  const updateText = (key: TextKey, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const updateNumber = (key: NumberKey, value: string) => setDraft((current) => ({ ...current, [key]: parseNumber(value) }));
  const updateTriState = (key: TriStateKey, value: string) => setDraft((current) => ({ ...current, [key]: parseTriState(value) }));

  const save = (status = draft.status === 'not_started' ? 'in_progress' : draft.status) => {
    const next = scoreFrontReview({
      ...draft,
      status,
      reviewed_at: new Date().toISOString(),
      search_url: draft.search_url || searchUrl(mainKeyword),
    });
    setDraft(next);
    onSave(next);
    setNotice(status === draft.status ? '前台复核结果已保存。' : `已标记为${statusLabel(status)}并保存。`);
  };

  const openPage = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  const copyText = async (label: string, value: string | null) => {
    if (!value) {
      setNotice(`${label}暂未返回。`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`已复制${label}。`);
    } catch {
      setNotice(`${label}复制失败，可直接从页面字段中选取。`);
    }
  };

  return (
    <section className="content-section front-review-panel">
      <div className="section-heading front-review-heading">
        <div>
          <h2>前台复核</h2>
          <p>把 Amazon 前台看到的切入点、风险和广告机会落回商品记录。</p>
        </div>
        <div className="front-review-score">
          <span>{statusLabel(draft.status)}</span>
          <strong>{preview.front_review_score}/100</strong>
          <em>{preview.front_review_level}</em>
        </div>
      </div>

      <div className="action-row compact-actions">
        <button className="secondary-button" type="button" onClick={() => openPage(draft.amazon_url)}>
          打开 Amazon 商品页
        </button>
        <button className="secondary-button" type="button" onClick={() => openPage(draft.search_url || searchUrl(mainKeyword))}>
          打开 Amazon 搜索页
        </button>
        <button className="secondary-button" type="button" onClick={() => copyText('ASIN', product.asin)}>
          复制 ASIN
        </button>
        <button className="secondary-button" type="button" onClick={() => copyText('标题', resolved.title)}>
          复制标题
        </button>
        <button className="secondary-button" type="button" onClick={() => copyText('主关键词', mainKeyword)}>
          复制主关键词
        </button>
      </div>

      <div className="front-review-meta">
        <TextInput label="复核人" value={draft.reviewer} onChange={(value) => updateText('reviewer', value)} placeholder="输入负责人" />
        <TextInput label="Amazon 商品页" value={draft.amazon_url} onChange={(value) => updateText('amazon_url', value)} placeholder="商品页链接" />
        <TextInput label="Amazon 搜索页" value={draft.search_url} onChange={(value) => updateText('search_url', value)} placeholder="搜索页链接" />
      </div>

      <div className="front-review-grid">
        <ReviewSection title="A. 价格复核" note={draft.price_notes} noteLabel="价格备注" onNote={(value) => updateText('price_notes', value)}>
          <NumberInput label="前台售价" value={draft.front_price} onChange={(value) => updateNumber('front_price', value)} />
          <NumberInput label="Coupon" value={draft.coupon_value} onChange={(value) => updateNumber('coupon_value', value)} />
          <NumberInput label="实际 Buy Box 价" value={draft.actual_buybox_price} onChange={(value) => updateNumber('actual_buybox_price', value)} />
          <TriStateSelect label="价格是否匹配 MCP" value={draft.price_match_mcp} onChange={(value) => updateTriState('price_match_mcp', value)} />
          <TriStateSelect label="能便宜 3%" value={draft.can_undercut_3} onChange={(value) => updateTriState('can_undercut_3', value)} />
          <TriStateSelect label="能便宜 5%" value={draft.can_undercut_5} onChange={(value) => updateTriState('can_undercut_5', value)} />
          <TriStateSelect label="能便宜 8%" value={draft.can_undercut_8} onChange={(value) => updateTriState('can_undercut_8', value)} />
          <TriStateSelect label="能便宜 10%" value={draft.can_undercut_10} onChange={(value) => updateTriState('can_undercut_10', value)} />
        </ReviewSection>

        <ReviewSection title="B. 评论 / 变体复核" note={draft.review_notes} noteLabel="评论备注" onNote={(value) => updateText('review_notes', value)}>
          <NumberInput label="前台评论数" value={draft.front_review_count} onChange={(value) => updateNumber('front_review_count', value)} />
          <NumberInput label="前台评分" value={draft.front_rating} onChange={(value) => updateNumber('front_rating', value)} step="0.1" />
          <NumberInput label="前台变体数" value={draft.variation_count_front} onChange={(value) => updateNumber('variation_count_front', value)} />
          <TriStateSelect label="评论数匹配 MCP" value={draft.review_count_match_mcp} onChange={(value) => updateTriState('review_count_match_mcp', value)} />
          <TriStateSelect label="评论集中在老变体" value={draft.reviews_concentrated_in_old_variants} onChange={(value) => updateTriState('reviews_concentrated_in_old_variants', value)} />
          <TriStateSelect label="存在少评论也在卖的竞品" value={draft.low_review_competitors_exist} onChange={(value) => updateTriState('low_review_competitors_exist', value)} />
        </ReviewSection>

        <ReviewSection title="C. 页面质量复核" note={draft.page_weakness_notes} noteLabel="页面弱点备注" onNote={(value) => updateText('page_weakness_notes', value)}>
          <QualitySelect label="主图质量" value={draft.main_image_quality} onChange={(value) => setDraft((current) => ({ ...current, main_image_quality: value as ReviewStrength }))} />
          <AplusSelect label="A+ 质量" value={draft.aplus_quality} onChange={(value) => setDraft((current) => ({ ...current, aplus_quality: value as FrontReview['aplus_quality'] }))} />
          <TriStateSelect label="是否有视频" value={draft.has_video} onChange={(value) => updateTriState('has_video', value)} />
          <QualitySelect label="标题质量" value={draft.title_quality} onChange={(value) => setDraft((current) => ({ ...current, title_quality: value as ReviewStrength }))} />
          <QualitySelect label="五点质量" value={draft.bullet_quality} onChange={(value) => setDraft((current) => ({ ...current, bullet_quality: value as ReviewStrength }))} />
        </ReviewSection>

        <ReviewSection title="D. 竞争风险复核" note={draft.risk_notes} noteLabel="风险备注" onNote={(value) => updateText('risk_notes', value)}>
          <RiskSelect label="品牌垄断程度" value={draft.brand_monopoly} onChange={(value) => setDraft((current) => ({ ...current, brand_monopoly: value as ReviewRiskLevel }))} />
          <TriStateSelect label="是否 Amazon 自营" value={draft.amazon_self_operated} onChange={(value) => updateTriState('amazon_self_operated', value)} />
          <RiskSelect label="卖家数量等级" value={draft.seller_count_level} onChange={(value) => setDraft((current) => ({ ...current, seller_count_level: value as ReviewRiskLevel }))} />
          <RiskSelect label="IP 风险" value={draft.ip_risk} onChange={(value) => setDraft((current) => ({ ...current, ip_risk: value as ReviewRiskLevel }))} />
          <RiskSelect label="合规风险" value={draft.compliance_risk} onChange={(value) => setDraft((current) => ({ ...current, compliance_risk: value as ReviewRiskLevel }))} />
          <RiskSelect label="退货风险" value={draft.return_risk} onChange={(value) => setDraft((current) => ({ ...current, return_risk: value as ReviewRiskLevel }))} />
          <label>
            <span>产品复杂度</span>
            <select value={draft.product_complexity} onChange={(event) => setDraft((current) => ({ ...current, product_complexity: event.target.value as FrontReview['product_complexity'] }))}>
              <option value="simple">简单</option>
              <option value="medium">中等</option>
              <option value="complex">复杂</option>
            </select>
          </label>
        </ReviewSection>

        <ReviewSection title="E. 差异化 / 广告复核" note={draft.ad_notes} noteLabel="广告备注" onNote={(value) => updateText('ad_notes', value)}>
          <RiskSelect label="差异化空间" value={draft.differentiation_space} onChange={(value) => setDraft((current) => ({ ...current, differentiation_space: value as ReviewRiskLevel }))} />
          <TriStateSelect label="低价切入是否可行" value={draft.can_use_price_undercut_strategy} onChange={(value) => updateTriState('can_use_price_undercut_strategy', value)} />
          <AdSelect label="低竞价 SP 机会" value={draft.sp_low_bid_opportunity} onChange={(value) => setDraft((current) => ({ ...current, sp_low_bid_opportunity: value as FrontReview['sp_low_bid_opportunity'] }))} />
          <RiskSelect label="视频 / SPV 机会" value={draft.spv_or_video_opportunity} onChange={(value) => setDraft((current) => ({ ...current, spv_or_video_opportunity: value as ReviewRiskLevel }))} />
          <label className="review-wide">
            <span>推荐广告切入词</span>
            <textarea value={draft.recommended_ad_keywords} onChange={(event) => updateText('recommended_ad_keywords', event.target.value)} placeholder="可记录长尾词、否词或前台广告位观察" />
          </label>
        </ReviewSection>
      </div>

      <label className="notes-field">
        <span>复核总备注</span>
        <textarea value={draft.notes} onChange={(event) => updateText('notes', event.target.value)} placeholder="写下是否适合开发、小测、等待或放弃的人工判断" />
      </label>

      {preview.front_review_flags.length > 0 && (
        <div className="warning-list front-review-flags">
          {preview.front_review_flags.map((flag) => (
            <p key={flag}>{flag}</p>
          ))}
        </div>
      )}

      <div className="action-row front-review-actions">
        <button className="primary-button" type="button" onClick={() => save()}>
          保存复核结果
        </button>
        <button className="secondary-button" type="button" onClick={() => save('passed')}>
          标记通过
        </button>
        <button className="secondary-button" type="button" onClick={() => save('failed')}>
          标记不通过
        </button>
        <button className="secondary-button" type="button" onClick={() => save('need_second_check')}>
          标记待二次确认
        </button>
        <span className="front-review-decision">人工建议：{decisionLabel(preview.final_manual_decision)}</span>
      </div>
      {notice && <p className="save-notice">{notice}</p>}
    </section>
  );
}

function ReviewSection({
  title,
  note,
  noteLabel,
  onNote,
  children,
}: {
  title: string;
  note: string;
  noteLabel: string;
  onNote: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="review-section">
      <h3>{title}</h3>
      <div className="review-fields">{children}</div>
      <label className="review-note">
        <span>{noteLabel}</span>
        <textarea value={note} onChange={(event) => onNote(event.target.value)} />
      </label>
    </section>
  );
}

function TextInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function NumberInput({ label, value, onChange, step = '0.01' }: { label: string; value: number | null; onChange: (value: string) => void; step?: string }) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min="0" step={step} value={valueLabel(value)} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TriStateSelect({ label, value, onChange }: { label: string; value: TriState; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={triStateValue(value)} onChange={(event) => onChange(event.target.value)}>
        <option value="unknown">待确认</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    </label>
  );
}

function QualitySelect({ label, value, onChange }: { label: string; value: ReviewStrength; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {qualityOptions.map((option) => (
          <option value={option} key={option}>
            {option === 'weak' ? '弱' : option === 'normal' ? '正常' : '强'}
          </option>
        ))}
      </select>
    </label>
  );
}

function AplusSelect({ label, value, onChange }: { label: string; value: FrontReview['aplus_quality']; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="none">无</option>
        <option value="weak">弱</option>
        <option value="normal">正常</option>
        <option value="strong">强</option>
      </select>
    </label>
  );
}

function RiskSelect({ label, value, onChange }: { label: string; value: ReviewRiskLevel; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {riskOptions.map((option) => (
          <option value={option} key={option}>
            {option === 'low' ? '低' : option === 'medium' ? '中' : '高'}
          </option>
        ))}
      </select>
    </label>
  );
}

function AdSelect({ label, value, onChange }: { label: string; value: FrontReview['sp_low_bid_opportunity']; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="unknown">待确认</option>
        <option value="low">低</option>
        <option value="medium">中</option>
        <option value="high">高</option>
      </select>
    </label>
  );
}
