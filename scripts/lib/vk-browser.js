const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const CDP_URL = 'http://127.0.0.1:9222';

async function cdpAvailable() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edge = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!edge) throw new Error('Microsoft Edge не найден');
  return edge;
}

async function ensureSession(root) {
  const profile = path.join(root, '.playwright-vk-profile');
  const tokenPath = path.join(profile, 'managed-token');
  let token;
  let launched = false;
  let markerUrl;
  if (!await cdpAvailable()) {
    launched = true;
    fs.mkdirSync(profile, { recursive: true });
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenPath, token, 'utf8');
    markerUrl = `data:text/html,%3Ctitle%3Eanimal-volunteer-${token}%3C/title%3E`;
    const child = spawn(findEdge(), [
      '--remote-debugging-port=9222',
      `--user-data-dir=${profile}`,
      '--new-window',
      markerUrl
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await cdpAvailable()) break;
    }
  }
  if (!await cdpAvailable()) throw new Error('Не удалось запустить Edge с CDP на порту 9222');

  if (!token) {
    if (!fs.existsSync(tokenPath)) throw new Error('Порт 9222 занят браузером, запущенным не этой CLI');
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  let page;
  if (launched) {
    page = context.pages().find(item => item.url() === markerUrl);
    if (!page) {
      await browser.close();
      throw new Error('На порту 9222 ответил Edge, который не был запущен этой CLI');
    }
    await page.goto('https://vk.com', { waitUntil: 'domcontentloaded' });
  } else {
    page = context.pages().find(item => /https:\/\/(?:www\.)?vk\.(?:com|ru)\//i.test(item.url()));
  }
  if (!page) page = await context.newPage();
  if (!/https:\/\/(?:www\.)?vk\.(?:com|ru)\//i.test(page.url())) await page.goto('https://vk.com', { waitUntil: 'domcontentloaded' });
  const storedToken = await page.evaluate(() => localStorage.getItem('__animalVolunteerCliSession'));
  if (!launched && storedToken !== token) {
    await browser.close();
    throw new Error('Порт 9222 принадлежит другому или неподтвержденному профилю Edge');
  }
  if (launched) await page.evaluate(value => localStorage.setItem('__animalVolunteerCliSession', value), token);
  await page.bringToFront();
  return { browser, context, page };
}

async function authorizationStatus(page) {
  await page.waitForTimeout(1000);
  const body = await page.locator('body').innerText().catch(() => '');
  const loginInputs = await page.locator('input[name="email"], input[name="login"], input[type="password"]').count();
  const profileEvidence = /Настройки профиля/.test(body);
  return { authorized: loginInputs === 0 && profileEvidence, loginInputs, profileEvidence, url: page.url() };
}

async function selectGroupPage(context, plan, { requireDialog = false } = {}) {
  const candidates = [];
  for (const page of context.pages()) {
    let key = null;
    try {
      const url = new URL(page.url());
      if (/^(?:www\.)?vk\.(?:com|ru)$/i.test(url.hostname)) key = url.pathname.replace(/\/$/, '').toLowerCase();
    } catch {
      // Ignore non-HTTP browser pages.
    }
    if (key !== plan.group.key) continue;
    if (requireDialog && !await postingDialog(page).count()) continue;
    candidates.push(page);
  }
  if (candidates.length !== 1) throw new Error(`Ожидалась одна вкладка выбранной группы, найдено: ${candidates.length}`);
  await candidates[0].bringToFront();
  return candidates[0];
}

function newPostDialog(page) {
  return page.locator('[role="dialog"]').filter({ hasText: 'Новый пост' }).first();
}

function settingsDialog(page) {
  const testIdDialog = page.locator(
    '[role="dialog"]:has([data-testid="posting_suggest_button"]), [role="dialog"]:has([data-testid="posting_publish_button"])'
  );
  const submitButton = page.getByRole('button', { name: /^(Опубликовать|Предложить(?: пост| новость)?)$/ });
  const semanticDialog = page.locator('[role="dialog"]').filter({ has: submitButton });
  return testIdDialog.or(semanticDialog).first();
}

function postingDialog(page) {
  return newPostDialog(page).or(settingsDialog(page)).first();
}

async function openPostingDialog(page) {
  const candidates = ['Предложить пост', 'Предложить новость', 'Создать'];
  for (const label of candidates) {
    const locator = page.getByText(label, { exact: true }).filter({ visible: true }).first();
    if (await locator.count()) {
      await locator.click();
      if (label === 'Создать') {
        await page.waitForTimeout(500);
        const post = page.getByText('Пост', { exact: true }).filter({ visible: true }).first();
        if (await post.count()) await post.click();
      }
      try {
        await newPostDialog(page).waitFor({ state: 'visible', timeout: 5000 });
        return newPostDialog(page);
      } catch {
        // Try the next known entry point.
      }
    }
  }
  throw new Error('Диалог «Новый пост» не открылся');
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

async function editorText(editor) {
  return normalizeNewlines(await editor.innerText());
}

async function fillPostingDialog(page, plan) {
  const dialog = await openPostingDialog(page);
  const editor = dialog.locator('[data-testid="posting_base_screen_input_message"]');
  if (!await editor.count()) throw new Error('Редактор текста в диалоге не найден');
  const draftCount = await dialog.locator('[data-testid="posting_attachment_item"]').count();
  const draftText = await editorText(editor);
  const expectedText = normalizeNewlines(plan.text);
  const draftHtml = await editor.innerHTML();
  const draftMatches = draftText === expectedText || (draftText === `${expectedText}\n` && /<br><br>\s*$/.test(draftHtml));
  if (draftCount === plan.expectedCount && draftMatches) {
    return { count: draftCount, textVerified: true, restoredDraft: true };
  }
  if (draftCount || draftText.trim()) {
    for (let remaining = draftCount; remaining > 0; remaining -= 1) {
      const remove = dialog.locator('[data-testid="posting_attachment_photo_item_remove"], [data-testid="posting_attachment_video_item_remove"]').first();
      if (!await remove.count()) throw new Error('В восстановленном черновике не найдена кнопка удаления вложения');
      await remove.click();
      await page.waitForFunction(
        count => document.querySelectorAll('[role="dialog"] [data-testid="posting_attachment_item"]').length === count,
        remaining - 1,
        { timeout: 5000 }
      );
    }
    await editor.fill('');
  }
  const input = dialog.locator('input[type="file"]').first();
  if (!await input.count()) throw new Error('В диалоге нового поста нет файлового input');
  for (let index = 0; index < plan.media.length; index += 1) {
    const expected = index + 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await input.setInputFiles(plan.media[index]);
      try {
        await page.waitForFunction(
          count => document.querySelectorAll('[role="dialog"] [data-testid="posting_attachment_item"]').length === count,
          expected,
          { timeout: 30000 }
        );
        break;
      } catch (error) {
        const actual = await dialog.locator('[data-testid="posting_attachment_item"]').count();
        if (actual === expected) break;
        if (actual !== index || attempt === 1) {
          throw new Error(`Фото ${index + 1} не загрузилось: ожидалось вложений ${expected}, найдено ${actual}`);
        }
        // The count proves that VK did not add this file, so one retry cannot create a duplicate.
      }
    }
  }
  await page.waitForTimeout(1500);
  const count = await dialog.locator('[data-testid="posting_attachment_item"]').count();
  if (count !== plan.expectedCount) throw new Error(`Ожидалось вложений: ${plan.expectedCount}, получено: ${count}`);

  await editor.fill(plan.text);
  const actual = await editorText(editor);
  const expected = normalizeNewlines(plan.text);
  const html = await editor.innerHTML();
  const technicalTrailingBreak = actual === `${expected}\n` && /<br><br>\s*$/.test(html);
  if (actual !== expected && !technicalTrailingBreak) throw new Error('Текст в редакторе не совпадает с advertisement.md');
  return { count, textVerified: true };
}

async function verifyPreparedForm(page, plan) {
  const dialog = newPostDialog(page);
  if (!await dialog.count()) throw new Error('Проверенная форма «Новый пост» больше не открыта');
  const count = await dialog.locator('[data-testid="posting_attachment_item"]').count();
  if (count !== plan.expectedCount) throw new Error('Количество вложений изменилось после проверки');
  const editor = dialog.locator('[data-testid="posting_base_screen_input_message"]');
  const actual = await editorText(editor);
  const expected = normalizeNewlines(plan.text);
  const html = await editor.innerHTML();
  if (actual !== expected && !(actual === `${expected}\n` && /<br><br>\s*$/.test(html))) {
    throw new Error('Текст изменился после проверки');
  }
  return dialog;
}

async function clickPublishOnce(page, plan, beforeSubmit) {
  let settings = settingsDialog(page);
  const settingsCount = await settings.count();
  if (!settingsCount) {
    const settingsButtonCount = await page.locator('[data-testid="posting_suggest_button"], [data-testid="posting_publish_button"]').count();
    if (settingsButtonCount) throw new Error(`Кнопка отправки найдена вне ожидаемого диалога (кнопок: ${settingsButtonCount})`);
    const dialog = await verifyPreparedForm(page, plan);
    await dialog.getByText('Далее', { exact: true }).click();
    settings = settingsDialog(page);
    await settings.waitFor({ state: 'visible', timeout: 10000 });
  }
  const previewText = await renderedText(settings);
  if (!canonicalRenderedText(previewText).includes(canonicalRenderedText(plan.text))) {
    throw new Error('Текст превью на экране настроек не совпадает с advertisement.md');
  }
  const previewCount = await settings.locator('[data-testid="posting_preview_attachment_item"]').count();
  if (previewCount !== plan.expectedCount) {
    const html = await settings.innerHTML();
    fs.writeFileSync(path.join(os.tmpdir(), 'animal-volunteer-settings-debug.html'), html, 'utf8');
    throw new Error(`В превью ожидалось вложений: ${plan.expectedCount}, найдено: ${previewCount}`);
  }
  if (await settings.locator('input:checked, [aria-checked="true"]').count()) throw new Error('На экране настроек включена дополнительная опция');
  const publish = settings.getByRole('button', { name: /^(Опубликовать|Предложить(?: пост| новость)?)$/ });
  if (await publish.count() !== 1) throw new Error('Не найдена единственная кнопка отправки');
  await beforeSubmit();
  await publish.click();
  const dialogClosed = await settings.waitFor({ state: 'hidden', timeout: 30000 }).then(() => true, () => false);
  return { dialogClosed };
}

async function renderedText(locator) {
  return locator.evaluate(element => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('img[alt]').forEach(image => image.replaceWith(document.createTextNode(image.alt)));
    clone.querySelectorAll('a[href]').forEach(link => {
      if (/^https?:\/\/vk\.(?:com|ru)\//i.test(link.href)) link.textContent = link.href;
    });
    clone.style.position = 'fixed';
    clone.style.left = '-9999px';
    document.body.appendChild(clone);
    const value = clone.innerText;
    clone.remove();
    return value;
  });
}

function canonicalRenderedText(value) {
  return normalizeNewlines(value)
    .replace(/\nПоказать ещё$/, '')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/\n$/, '');
}

async function visiblePostIds(page) {
  return page.locator('[data-testid="post"]').evaluateAll(posts => posts.map(post => post.getAttribute('data-post-id')).filter(Boolean));
}

async function findResult(page, plan, { excludedPostIds = [], expectedOwnerId } = {}) {
  await page.waitForTimeout(3000);
  const inspect = async () => {
    const posts = page.locator('[data-testid="post"]');
    for (let index = 0; index < await posts.count(); index += 1) {
      const post = posts.nth(index);
      const postId = await post.getAttribute('data-post-id');
      if (!postId || excludedPostIds.includes(postId)) continue;
      const ownerId = postId.split('_')[0];
      if (!expectedOwnerId || ownerId !== expectedOwnerId) continue;
      const textLocator = post.locator('[data-testid="post_text"]');
      if (!await textLocator.count()) continue;
      const text = await renderedText(textLocator);
      if (canonicalRenderedText(text) !== canonicalRenderedText(plan.text)) continue;
      const attachmentCount = await post.locator('a').evaluateAll(elements => {
        const links = elements.map(element => element.getAttribute('href') || '');
        return new Set(links.filter(link => link.includes('/photo') || link.includes('/video'))).size;
      });
      if (attachmentCount !== plan.expectedCount) continue;
      return { postId, attachmentCount };
    }
    return null;
  };

  await page.goto(plan.group.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  let result = await inspect();
  if (!result) {
    const suggested = page.getByText(/Предложенные\s+\d+/).first();
    const href = await suggested.getAttribute('href').catch(() => null);
    const suggestedUrl = href
      ? new URL(href, page.url()).href
      : expectedOwnerId ? `https://vk.ru/wall${expectedOwnerId}?suggested=1` : null;
    if (suggestedUrl) {
      await page.goto(suggestedUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      result = await inspect();
      if (result) {
        return {
          type: 'suggested',
          url: `https://vk.ru/wall${result.postId}`,
          suggestedUrl: page.url(),
          attachmentCount: result.attachmentCount
        };
      }
    }
  }
  if (!result?.postId) return null;
  return {
    type: 'published',
    url: `https://vk.ru/wall${result.postId}`,
    attachmentCount: result.attachmentCount
  };
}

module.exports = {
  authorizationStatus,
  canonicalRenderedText,
  clickPublishOnce,
  ensureSession,
  fillPostingDialog,
  findResult,
  newPostDialog,
  normalizeNewlines,
  selectGroupPage,
  visiblePostIds,
  verifyPreparedForm
};
