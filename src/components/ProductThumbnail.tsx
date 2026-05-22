import { useEffect, useState } from 'react';

type ProductThumbnailSize = 'small' | 'table' | 'detail';

type ProductThumbnailProps = {
  src?: string | null;
  asin?: string | null;
  title?: string | null;
  size?: ProductThumbnailSize;
};

export default function ProductThumbnail({ src, asin, title, size = 'table' }: ProductThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const imageUrl = failed ? null : src?.trim() || null;
  const label = title || asin || '商品主图';

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!imageUrl) {
    return (
      <div className={`product-thumbnail product-thumbnail-${size} product-thumbnail-empty`} title="无图">
        无图
      </div>
    );
  }

  return (
    <div className={`product-thumbnail-wrap product-thumbnail-${size}`} title={imageUrl}>
      <img
        className="product-thumbnail-image"
        src={imageUrl}
        alt={`${asin ? `${asin} ` : ''}${label}`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <img className="product-thumbnail-preview" src={imageUrl} alt="" aria-hidden="true" loading="lazy" />
    </div>
  );
}
