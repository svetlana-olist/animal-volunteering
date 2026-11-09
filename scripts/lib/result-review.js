async function captureMediaScreenshot(page, source, output, index) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await page.goto(source, { waitUntil: 'load' });
    const decoded = response?.ok() && await page.locator('img').evaluateAll(images =>
      images.length === 1 && images[0].complete && images[0].naturalWidth > 0);
    if (decoded) {
      await page.locator('img').screenshot({ path: output });
      return;
    }
    if (attempt < 2) await page.waitForTimeout(1500);
  }
  throw new Error(`Не удалось загрузить изображение вложения ${index + 1}; повторите inspect-result`);
}

module.exports = { captureMediaScreenshot };
