/**
 * Unit tests for the pure parts of src/lib/imageShrink.js.
 * Run: node test/image-shrink.test.mjs
 *
 * Only the planning logic is tested here (canvas code needs a browser;
 * its failure mode — return the original file untouched — is covered
 * by code review, not a DOM harness). What matters: dimensions never
 * exceed the budget, aspect ratio survives, and odd inputs can't
 * produce zero/negative/NaN sizes that would break an upload.
 */
import assert from 'node:assert/strict';
import { planImageShrink, isShrinkableImageType, IMAGE_SHRINK_DEFAULTS } from '../src/lib/imageShrink.js';

let n = 0;
function check(name, fn) {
  const idx = ++n;
  try {
    fn();
    console.log(`  ok ${idx} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${idx} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

check('small images are left alone', () => {
  assert.deepEqual(planImageShrink(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(planImageShrink(1600, 1200), { width: 1600, height: 1200, scaled: false });
});

check('wide phone photo scales to the long edge, ratio preserved', () => {
  const p = planImageShrink(4032, 3024); // 12 MP phone photo
  assert.equal(p.scaled, true);
  assert.equal(p.width, 1600);
  assert.equal(p.height, 1200);
});

check('tall photo scales the height edge', () => {
  const p = planImageShrink(1080, 2400);
  assert.equal(p.height, 1600);
  assert.equal(p.width, 720);
});

check('square stays square', () => {
  const p = planImageShrink(3000, 3000);
  assert.deepEqual(p, { width: 1600, height: 1600, scaled: true });
});

check('custom maxDimension is honored', () => {
  assert.deepEqual(planImageShrink(4000, 1000, { maxDimension: 800 }), { width: 800, height: 200, scaled: true });
});

check('rounding never yields zero', () => {
  const p = planImageShrink(100000, 3);
  assert.equal(p.width, 1600);
  assert.ok(p.height >= 1);
});

check('degenerate inputs cannot produce NaN/negative sizes', () => {
  for (const [w, h] of [[0, 0], [-5, 10], [NaN, 100], [undefined, undefined], [Infinity, 10]]) {
    const p = planImageShrink(w, h);
    assert.equal(p.scaled, false);
    assert.ok(Number.isFinite(p.width) && Number.isFinite(p.height));
    assert.ok(p.width >= 0 && p.height >= 0);
  }
});

check('only raster photo types are shrinkable', () => {
  for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'IMAGE/JPEG']) {
    assert.equal(isShrinkableImageType(t), true, t);
  }
  // GIF animation, SVG vectors, HEIC (browser can't decode), and
  // non-images all pass through untouched.
  for (const t of ['image/gif', 'image/svg+xml', 'image/heic', 'application/pdf', '', null, undefined]) {
    assert.equal(isShrinkableImageType(t), false, String(t));
  }
});

check('defaults match the capacity plan (1600px, q0.82)', () => {
  assert.equal(IMAGE_SHRINK_DEFAULTS.maxDimension, 1600);
  assert.equal(IMAGE_SHRINK_DEFAULTS.quality, 0.82);
  assert.equal(IMAGE_SHRINK_DEFAULTS.outputType, 'image/jpeg');
});

console.log(process.exitCode ? '\nFAILED' : '\nAll image-shrink tests passed.');
