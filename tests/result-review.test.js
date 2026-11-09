const test = require('node:test');
const assert = require('node:assert/strict');
const { captureMediaScreenshot } = require('../scripts/lib/result-review');

function fakePage(attempts) {
  let current;
  const calls = { navigations: 0, waits: 0, screenshots: [] };
  return {
    calls,
    async goto() {
      current = attempts[calls.navigations++] || {};
      return { ok: () => !!current.ok };
    },
    async waitForTimeout() { calls.waits += 1; },
    locator() {
      return {
        async evaluateAll(inspect) { return inspect(current.images || []); },
        async screenshot(options) { calls.screenshots.push(options); }
      };
    }
  };
}

test('retries CDN error and incomplete image before capturing decoded media', async () => {
  const page = fakePage([
    { ok: false },
    { ok: true, images: [{ complete: false, naturalWidth: 0 }] },
    { ok: true, images: [{ complete: true, naturalWidth: 640 }] }
  ]);
  await captureMediaScreenshot(page, 'https://example.test/image', 'media.png', 0);
  assert.equal(page.calls.navigations, 3);
  assert.equal(page.calls.waits, 2);
  assert.deepEqual(page.calls.screenshots, [{ path: 'media.png' }]);
});

test('never captures an error page and stops after three attempts', async () => {
  const page = fakePage([]);
  await assert.rejects(captureMediaScreenshot(page, 'https://example.test/image', 'media.png', 2), /вложения 3/);
  assert.equal(page.calls.navigations, 3);
  assert.equal(page.calls.waits, 2);
  assert.deepEqual(page.calls.screenshots, []);
});

test('rejects broken images even when the server responds successfully', async () => {
  const page = fakePage(Array(3).fill({ ok: true, images: [{ complete: true, naturalWidth: 0 }] }));
  await assert.rejects(captureMediaScreenshot(page, 'https://example.test/image', 'media.png', 0));
  assert.deepEqual(page.calls.screenshots, []);
});
