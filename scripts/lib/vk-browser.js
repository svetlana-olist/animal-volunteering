const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const CDP_URL = 'http://127.0.0.1:9222';
const POST_SELECTOR = '[data-testid="post"], [data-spa-post-legacy-selector="1"][data-post-id][data-post-nesting-lvl="0"]';
const POST_TEXT_SELECTOR = '[data-testid="post_text"], span[data-post-id][id^="text-"]';
const ATTACHMENT_SELECTOR = '[data-testid="posting_attachment_item"], [data-sortable-item="true"][data-sortable-id]';

async function attachmentState(dialog) {
  return dialog.locator(ATTACHMENT_SELECTOR).evaluateAll(items => ({
    count: items.length,
    ready: items.every(item => {
      const id = item.getAttribute('data-sortable-id');
      return id === null
        ? item.getAttribute('data-testid') === 'posting_attachment_item'
        : /^(?:photo|video)-?\d+_\d+$/.test(id);
    })
  }));
}

async function waitForAttachmentCount(dialog, expected, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let stableSince = null;
  do {
    const { count, ready } = await attachmentState(dialog);
    if (count === expected && ready) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 1500) return;
    } else stableSince = null;
    if (count > expected) throw new Error(`Лишние вложения: ожидалось ${expected}, найдено ${count}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  throw new Error(`Не подтверждено число вложений ${expected}; повторная загрузка запрещена до проверки формы`);
}

function postSelector(postId) {
  if (!/^-\d+_\d+$/.test(postId)) throw new Error('Некорректный ID записи');
  return POST_SELECTOR.split(', ').map(selector => `${selector}[data-post-id="${postId}"]`).join(', ');
}

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
  let available = await cdpAvailable();
  if (!available) {
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
      available = await cdpAvailable();
      if (available) break;
    }
  }
  if (!available) throw new Error('Не удалось запустить Edge с CDP на порту 9222');

  if (!token) {
    if (!fs.existsSync(tokenPath)) throw new Error('Порт 9222 занят браузером, запущенным не этой CLI');
    token = fs.readFileSync(tokenPath, 'utf8').trim();
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 30000 });
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
    throw new Error('Порт 9222 принадлежит другому или неподтвержденному профилю Edge. Закройте окно Edge с отладочным портом 9222 и повторите npm run vk -- session, чтобы CLI запустила проверенный сеанс');
  }
  if (launched) await page.evaluate(value => localStorage.setItem('__animalVolunteerCliSession', value), token);
  await page.bringToFront();
  return { browser, context, page };
}

async function authorizationStatus(page) {
  const inspect = async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    const loginInputs = await page.locator('input[name="email"], input[name="login"], input[type="password"]').count();
    const profileEvidence = /Настройки профиля/.test(body);
    return { authorized: loginInputs === 0 && profileEvidence, loginInputs, profileEvidence, url: page.url() };
  };
  const immediate = await inspect();
  if (immediate.authorized || immediate.loginInputs) return immediate;
  await page.waitForTimeout(1000);
  return inspect();
}

async function selectGroupPage(context, plan, { requireDialog = false, preferredPage = null } = {}) {
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
  const selected = candidates.includes(preferredPage) ? preferredPage : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw new Error(`Ожидалась одна вкладка выбранной группы, найдено: ${candidates.length}`);
  await selected.bringToFront();
  return selected;
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
  const existing = newPostDialog(page);
  if (await existing.isVisible()) return existing;
  const candidates = ['Предложить пост', 'Предложить новость', 'Создать'];
  for (const label of candidates) {
    const locator = page.getByText(label, { exact: true }).filter({ visible: true }).first();
    if (await locator.count()) {
      await locator.click();
      if (label === 'Создать') {
        const post = page.getByText('Пост', { exact: true }).filter({ visible: true }).first();
        await post.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
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

async function discardPostingDraft(page) {
  const dialog = newPostDialog(page);
  if (!await dialog.isVisible()) throw new Error('Ожидался открытый черновик «Новый пост»');
  const count = await dialog.locator(ATTACHMENT_SELECTOR).count();
  for (let remaining = count; remaining > 0; remaining -= 1) {
    await dialog.getByRole('button', { name: 'Удалить', exact: true }).first().click();
    await waitForAttachmentCount(dialog, remaining - 1, 5000);
  }
  const editor = dialog.locator('[role="textbox"][contenteditable="true"]');
  await editor.fill('');
  if ((await editorText(editor)).trim() || await dialog.locator(ATTACHMENT_SELECTOR).count()) throw new Error('Черновик не очищен');
  await dialog.getByText('Закрыть', { exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

async function fillPostingDialog(page, plan) {
  const dialog = await openPostingDialog(page);
  const editor = dialog.locator('[data-testid="posting_base_screen_input_message"], [role="textbox"][contenteditable="true"][aria-label="Напишите что-нибудь..."]');
  if (!await editor.count()) throw new Error('Редактор текста в диалоге не найден');
  const draftCount = await dialog.locator(ATTACHMENT_SELECTOR).count();
  const draftText = await editorText(editor);
  const expectedText = normalizeNewlines(plan.text);
  const draftHtml = await editor.innerHTML();
  const draftMatches = draftText === expectedText || (draftText === `${expectedText}\n` && /<br><br>\s*$/.test(draftHtml));
  if (draftCount === plan.expectedCount && draftMatches) {
    await waitForAttachmentCount(dialog, plan.expectedCount);
    return { count: draftCount, textVerified: true, restoredDraft: true };
  }
  if (draftCount || draftText.trim()) {
    for (let remaining = draftCount; remaining > 0; remaining -= 1) {
      const remove = dialog.getByRole('button', { name: 'Удалить', exact: true }).first();
      if (!await remove.count()) throw new Error('В восстановленном черновике не найдена кнопка удаления вложения');
      await remove.click();
      await waitForAttachmentCount(dialog, remaining - 1, 5000);
    }
    await editor.fill('');
  }
  const input = dialog.locator('input[type="file"]').first();
  if (!await input.count()) throw new Error('В диалоге нового поста нет файлового input');
  for (let index = 0; index < plan.media.length; index += 1) {
    const expected = index + 1;
    await input.setInputFiles(plan.media[index]);
    await waitForAttachmentCount(dialog, expected);
  }
  const { count, ready } = await attachmentState(dialog);
  if (count !== plan.expectedCount || !ready) throw new Error(`Ожидалось готовых вложений: ${plan.expectedCount}, получено: ${count}`);

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
  const { count, ready } = await attachmentState(dialog);
  if (count !== plan.expectedCount || !ready) throw new Error('Количество или готовность вложений изменились после проверки');
  const editor = dialog.locator('[data-testid="posting_base_screen_input_message"], [role="textbox"][contenteditable="true"][aria-label="Напишите что-нибудь..."]');
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
  const previewItems = await settings.locator('[data-testid="posting_preview_attachment_item"]').count();
  const primaryVideos = await settings.locator('[data-testid="primary-attachment-video"]').count();
  const nestedPrimaryVideos = await settings.locator('[data-testid="posting_preview_attachment_item"] [data-testid="primary-attachment-video"]').count();
  const legacyPreviewCount = countPreviewAttachments(previewItems, primaryVideos, nestedPrimaryVideos);
  const previewCount = legacyPreviewCount || await settings.locator('[data-sortable-root="true"] > div:has(img)').count();
  const textMatches = canonicalRenderedText(previewText).includes(canonicalRenderedText(plan.text));
  const settingsTitleCount = await settings.locator('[data-testid="modalheader-title"]').getByText('Настройки', { exact: true }).count();
  const editButtonCount = await settings.getByText('Редактировать', { exact: true }).count();
  const textlessSettingsPreview = isTextlessSettingsPreview(
    previewCount,
    plan.expectedCount,
    settingsTitleCount,
    editButtonCount
  );
  if (!textMatches && !textlessSettingsPreview) {
    fs.writeFileSync(path.join(os.tmpdir(), 'animal-volunteer-settings-text-debug.txt'), previewText, 'utf8');
    fs.writeFileSync(path.join(os.tmpdir(), 'animal-volunteer-settings-debug.html'), await settings.innerHTML(), 'utf8');
    await settings.screenshot({ path: path.join(os.tmpdir(), 'animal-volunteer-settings-debug.png') });
    throw new Error('Текст превью на экране настроек не совпадает с advertisement.md');
  }
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
      if (/^(?:https?:\/\/)?(?:www\.)?vk\.(?:com|ru)\//i.test(link.textContent.trim())
          && /^https?:\/\/vk\.(?:com|ru)\//i.test(link.href)) link.textContent = link.href;
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
    .replace(/https?:\/\/(?:www\.)?/gi, '')
    .replace(/\nПоказать ещё$/, '')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/\n$/, '');
}

function parseResultUrl(value, expectedOwnerId) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error('Ссылка результата некорректна');
  }
  if (!/^https?:$/.test(target.protocol)
      || !/^(?:www\.)?vk\.(?:com|ru)$/i.test(target.hostname)
      || target.username
      || target.password
      || target.port
      || target.search
      || target.hash) {
    throw new Error('Ссылка результата должна вести на запись VK');
  }
  const match = target.pathname.match(/^\/wall(-\d+)_(\d+)$/);
  if (!match) throw new Error('Ссылка результата должна вести на отдельную запись VK');
  const ownerId = match[1];
  if (expectedOwnerId && ownerId !== expectedOwnerId) {
    throw new Error('Ссылка результата ведёт на запись другой группы');
  }
  const postId = `${ownerId}_${match[2]}`;
  return { ownerId, postId, url: `https://vk.ru/wall${postId}` };
}

function countPreviewAttachments(previewItems, primaryVideos, nestedPrimaryVideos) {
  return previewItems + Math.max(0, primaryVideos - nestedPrimaryVideos);
}

function isTextlessSettingsPreview(previewCount, expectedCount, settingsTitleCount, editButtonCount) {
  return previewCount === expectedCount && settingsTitleCount === 1 && editButtonCount === 1;
}

function matchKnownAdvertisement(value, advertisements) {
  const rendered = canonicalRenderedText(value);
  return advertisements.find(item => canonicalRenderedText(item.text) === rendered) || null;
}

async function inspectSuggestedPosts(page, advertisements, { expectedCount = null } = {}) {
  const postIds = new Set();
  const reviewedPosts = new Map();
  let stableRounds = 0;
  for (let attempt = 0; attempt < 20 && stableRounds < 2; attempt += 1) {
    const sizeBefore = postIds.size;
    const posts = page.locator(POST_SELECTOR);
    for (let index = 0; index < await posts.count(); index += 1) {
      const post = posts.nth(index);
      const postId = await post.getAttribute('data-post-id');
      if (postId) postIds.add(postId);
      const textLocator = post.locator(POST_TEXT_SELECTOR);
      if (!await textLocator.count()) continue;
      const text = await renderedText(textLocator);
      reviewedPosts.set(postId || `without-id-${index}`, { postId, text });
      const match = matchKnownAdvertisement(text, advertisements);
      if (match) return { postIds: [...postIds], posts: [...reviewedPosts.values()], duplicate: { animal: match.animal, postId }, complete: true };
    }
    stableRounds = postIds.size === sizeBefore ? stableRounds + 1 : 0;
    if (expectedCount !== null && postIds.size >= expectedCount) break;
    if (stableRounds >= 2) break;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(750);
  }
  return {
    postIds: [...postIds],
    posts: [...reviewedPosts.values()],
    duplicate: null,
    complete: expectedCount === null || postIds.size >= expectedCount
  };
}

async function visiblePostIds(page) {
  return page.locator(POST_SELECTOR).evaluateAll(posts => posts.map(post => post.getAttribute('data-post-id')).filter(Boolean));
}

async function findMatchingPost(page, plan, { excludedPostIds = [], expectedOwnerId, targetPostId = null } = {}) {
  const posts = targetPostId
    ? page.locator(postSelector(targetPostId))
    : page.locator(POST_SELECTOR);
  for (let index = 0; index < await posts.count(); index += 1) {
    const post = posts.nth(index);
    const postId = await post.getAttribute('data-post-id');
    if (!postId || excludedPostIds.includes(postId)) continue;
    const ownerId = postId.split('_')[0];
    if (expectedOwnerId && ownerId !== expectedOwnerId) continue;
    const textLocator = post.locator(POST_TEXT_SELECTOR);
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
}

async function verifyResultUrl(page, plan, value, { excludedPostIds = [], expectedOwnerId } = {}) {
  const target = parseResultUrl(value, expectedOwnerId);
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });
  await page.locator(postSelector(target.postId)).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const result = await findMatchingPost(page, plan, {
    excludedPostIds,
    expectedOwnerId,
    targetPostId: target.postId
  });
  if (!result) return null;
  return {
    type: 'published',
    source: 'manual',
    url: target.url,
    postId: result.postId,
    attachmentCount: result.attachmentCount
  };
}

async function findResult(page, plan, { excludedPostIds = [], expectedOwnerId } = {}) {
  const inspect = () => findMatchingPost(page, plan, { excludedPostIds, expectedOwnerId });

  await page.goto(plan.group.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  let result = await inspect();
  if (!result) {
    const suggested = page.getByText(/Предложенные\s+\d+/).first();
    const href = await suggested.count() ? await suggested.getAttribute('href') : null;
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
  POST_SELECTOR,
  POST_TEXT_SELECTOR,
  postSelector,
  authorizationStatus,
  canonicalRenderedText,
  clickPublishOnce,
  countPreviewAttachments,
  discardPostingDraft,
  ensureSession,
  fillPostingDialog,
  findResult,
  inspectSuggestedPosts,
  isTextlessSettingsPreview,
  matchKnownAdvertisement,
  newPostDialog,
  normalizeNewlines,
  parseResultUrl,
  renderedText,
  selectGroupPage,
  verifyResultUrl,
  visiblePostIds,
  waitForAttachmentCount,
  verifyPreparedForm
};
