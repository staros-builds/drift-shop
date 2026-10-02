/**
 * Client-side image shrinking — the cheapest storage guardrail there
 * is. A phone photo leaves the camera at 3–5 MB; the same photo
 * resized to a 1600 px long edge and re-encoded as JPEG lands around
 * 120–200 KB and still looks great on any screen the shop has. Since
 * the free storage quota is 1 GB per backend project, shrinking at
 * upload multiplies how many shops fit by ~20× (see docs/capacity.md).
 *
 * Rules this module lives by:
 * - NEVER throws. Any surprise (old browser, odd format, decode
 *   failure) returns the original file untouched. An upload that works
 *   beats a perfectly-sized upload that fails.
 * - GIFs and SVGs pass through (animation / vector — canvas would
 *   flatten or rasterize them wrongly).
 * - Photos are flattened onto white when re-encoded to JPEG, so a
 *   transparent PNG doesn't come back with black corners.
 *
 * planImageShrink() is pure and unit-tested; the canvas parts are
 * thin wrappers around it.
 */

export const IMAGE_SHRINK_DEFAULTS = Object.freeze({
  maxDimension: 1600,
  quality: 0.82,
  outputType: 'image/jpeg',
  // Files at or below this many bytes AND already within the pixel
  // budget are stored exactly as picked — no re-encode, no risk.
  skipBelowBytes: 300 * 1024,
});

const SHRINKABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/** True when this MIME type is a raster photo canvas can safely shrink. */
export function isShrinkableImageType(type) {
  return SHRINKABLE_TYPES.has(String(type || '').toLowerCase());
}

/**
 * Pure planning: given pixel dimensions, decide the stored dimensions.
 * Returns { width, height, scaled } — dimensions are integers ≥ 1 and
 * never exceed maxDimension on either edge; aspect ratio is preserved.
 * Non-finite or non-positive inputs return unchanged with scaled:false.
 */
export function planImageShrink(width, height, options = {}) {
  const maxDimension = Math.max(1, Math.floor(options.maxDimension ?? IMAGE_SHRINK_DEFAULTS.maxDimension));
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    const clamp = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    return { width: clamp(w), height: clamp(h), scaled: false };
  }
  const longest = Math.max(w, h);
  if (longest <= maxDimension) {
    return { width: Math.floor(w), height: Math.floor(h), scaled: false };
  }
  const ratio = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

async function decodeImage(source) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(source);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
    });
    img.src = url;
    await loaded;
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawableSize(decoded) {
  return {
    width: decoded?.naturalWidth || decoded?.width || 0,
    height: decoded?.naturalHeight || decoded?.height || 0,
  };
}

async function canvasReencode(decoded, plan, { quality, outputType }) {
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (outputType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, quality));
  return blob;
}

/**
 * Shrink a picked image File/Blob for storage. Returns the original
 * input untouched whenever shrinking doesn't apply or anything fails —
 * callers can pass the result straight to the upload path.
 */
export async function shrinkImageFile(file, options = {}) {
  const opts = { ...IMAGE_SHRINK_DEFAULTS, ...options };
  try {
    if (!file || typeof file !== 'object' || !isShrinkableImageType(file.type)) return file;
    const decoded = await decodeImage(file);
    try {
      const { width, height } = drawableSize(decoded);
      const plan = planImageShrink(width, height, opts);
      if (!plan.scaled && file.size <= opts.skipBelowBytes) return file;
      const outPlan = plan.scaled ? plan : { width, height, scaled: false };
      const blob = await canvasReencode(decoded, outPlan, opts);
      if (!blob || blob.size >= file.size) return file; // never grow a file
      if (typeof File === 'function' && file.name) {
        return new File([blob], file.name, { type: blob.type || opts.outputType });
      }
      return blob;
    } finally {
      if (typeof decoded?.close === 'function') decoded.close();
    }
  } catch {
    return file;
  }
}

/**
 * Same shrink for an image already held as a data URL (Pinboard
 * imports). Returns the original string on any failure. Data URLs are
 * how Pinboard feeds the backend, so shrinking here shrinks both the
 * wire payload and the stored bytes.
 */
export async function shrinkImageDataUrl(dataUrl, options = {}) {
  try {
    const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
    if (!match || !isShrinkableImageType(match[1])) return dataUrl;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const shrunk = await shrinkImageFile(
      typeof File === 'function' ? new File([blob], 'image', { type: blob.type }) : blob,
      options,
    );
    // shrinkImageFile hands back the original bytes when shrinking
    // doesn't pay; only swap the data URL when we actually saved room.
    if (!shrunk || shrunk.size >= blob.size) return dataUrl;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || dataUrl));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(shrunk);
    });
  } catch {
    return dataUrl;
  }
}
