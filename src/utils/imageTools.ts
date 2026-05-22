type ImageCandidate = {
  url: string;
  source: string;
  priority: number;
};

const explicitImageFields = [
  'main_image_url',
  'mainImageUrl',
  'mainImage',
  'main_image',
  'primary_image_url',
  'primaryImageUrl',
  'primary_image',
  'primaryImage',
  'image_url',
  'imageUrl',
  'large_image_url',
  'largeImageUrl',
  'largeImage',
  'large_image',
  'landingImage',
  'landing_image',
  'thumbnail_url',
  'thumbnailUrl',
  'thumbnail',
  'small_image_url',
  'smallImageUrl',
  'smallImage',
  'imgUrl',
  'img_url',
  'picUrl',
  'pictureUrl',
  'picture_url',
];

const imageContainerFields = [
  'images',
  'imageUrls',
  'image_urls',
  'imageList',
  'image_list',
  'media',
  'mediaList',
  'pictures',
  'pictureList',
  'photos',
  'gallery',
];

const nestedImageFields = [
  'url',
  'src',
  'large',
  'largeUrl',
  'large_url',
  'hiRes',
  'hi_res',
  'image',
  'imageUrl',
  'image_url',
  'main',
  'mainUrl',
  'thumbnail',
  'thumbnailUrl',
  'thumbnail_url',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(withProtocol)) return null;
  if (
    /(?:\.jpg|\.jpeg|\.png|\.webp|\.gif)(?:[?#].*)?$/i.test(withProtocol) ||
    /(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)/i.test(withProtocol)
  ) {
    return withProtocol;
  }
  return null;
}

function collectFromKnownFields(
  record: Record<string, unknown>,
  fields: string[],
  basePriority: number,
  prefix: string,
  candidates: ImageCandidate[],
  depth: number,
) {
  fields.forEach((field, index) => {
    if (!Object.prototype.hasOwnProperty.call(record, field)) return;
    collectImageCandidates(record[field], `${prefix}${field}`, basePriority + index, candidates, depth + 1);
  });
}

function collectImageCandidates(
  value: unknown,
  source: string,
  priority: number,
  candidates: ImageCandidate[],
  depth = 0,
) {
  const direct = normalizeImageUrl(value);
  if (direct) {
    candidates.push({ url: direct, source, priority });
    return;
  }

  if (depth > 5 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const nestedSource = `${source}[${index}]`;
      collectImageCandidates(item, nestedSource, priority + index / 100, candidates, depth + 1);
      const nestedRecord = asRecord(item);
      if (nestedRecord) {
        collectFromKnownFields(nestedRecord, nestedImageFields, priority + index / 100, `${nestedSource}.`, candidates, depth + 1);
      }
    });
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  collectFromKnownFields(record, explicitImageFields, priority, `${source}.`, candidates, depth + 1);
  collectFromKnownFields(record, imageContainerFields, priority + 100, `${source}.`, candidates, depth + 1);

  Object.entries(record).forEach(([key, nestedValue], index) => {
    const keyLower = key.toLowerCase();
    if (!/(image|img|media|thumb|photo|picture|pic)/.test(keyLower)) return;
    if (explicitImageFields.includes(key) || imageContainerFields.includes(key)) return;
    collectImageCandidates(nestedValue, `${source}.${key}`, priority + 200 + index, candidates, depth + 1);
  });

  Object.entries(record).forEach(([key, nestedValue], index) => {
    if (explicitImageFields.includes(key) || imageContainerFields.includes(key)) return;
    if (nestedValue && typeof nestedValue === 'object') {
      collectImageCandidates(nestedValue, `${source}.${key}`, priority + 500 + index, candidates, depth + 1);
    }
  });
}

export function extractImageCandidate(raw: unknown): { url: string | null; source: string | null } {
  const candidates: ImageCandidate[] = [];
  collectImageCandidates(raw, 'raw', 0, candidates);
  const [best] = candidates
    .filter((candidate, index, list) => list.findIndex((item) => item.url === candidate.url) === index)
    .sort((a, b) => a.priority - b.priority);

  return {
    url: best?.url ?? null,
    source: best?.source ?? null,
  };
}

export function extractImageUrl(raw: unknown): string | null {
  return extractImageCandidate(raw).url;
}
