#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPostingPlan, hashPlan, loadKnownAdvertisements } = require('./lib/posting-plan');
const {
  authorizationStatus,
  clickPublishOnce,
  ensureSession,
  fillPostingDialog,
  findResult,
  inspectSuggestedPosts,
  selectGroupPage,
  verifyResultUrl,
  visiblePostIds
} = require('./lib/vk-browser');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, '.tmp-vk-post-state.json');
const lockPath = path.join(root, '.tmp-vk-post.lock');

function argsFrom(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index];
    else args[key] = true;
  }
  return args;
}

function saveState(state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
}

function loadState() {
  if (!fs.existsSync(statePath)) throw new Error('Сначала выполните команду prepare');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function checkedPlan(state, { eligibility = true } = {}) {
  const plan = state.plan;
  const currentHash = eligibility
    ? createPostingPlan({ root, animal: plan.animal, groupUrl: plan.group.url, mediaReviewed: true }).hash
    : hashPlan(plan);
  if (currentHash !== plan.hash) throw new Error('Файлы карточки изменились после prepare; создайте план заново');
  return plan;
}

function transition(state, expected, next) {
  const current = loadState();
  if (current.plan.hash !== state.plan.hash || current.stage !== state.stage) {
    throw new Error('Состояние изменилось другим процессом; повторите безопасную проверку');
  }
  if (!expected.includes(current.stage)) throw new Error(`Команда недоступна в состоянии ${current.stage}`);
  state.stage = next;
  state.updatedAt = new Date().toISOString();
  saveState(state);
}

async function withLock(action) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\n`, 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerPath = path.join(lockPath, 'owner');
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      const owner = fs.existsSync(ownerPath) ? Number.parseInt(fs.readFileSync(ownerPath, 'utf8'), 10) : null;
      let alive = Number.isInteger(owner) || age < 60000;
      if (Number.isInteger(owner)) {
        try {
          process.kill(owner, 0);
        } catch {
          alive = false;
        }
      }
      if (alive || attempt === 1) throw new Error(`Другая команда VK уже выполняется${owner ? ` (PID ${owner})` : ''}`);
      fs.rmSync(lockPath, { recursive: true });
    }
  }
  try {
    return await action();
  } finally {
    fs.rmSync(lockPath, { recursive: true });
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function checkSuggestedPosts(context, state) {
  if (!state.expectedOwnerId) throw new Error('Не определён owner ID выбранной группы');
  const suggestedUrl = state.suggestedHref || `https://vk.ru/wall${state.expectedOwnerId}?suggested=1`;
  const suggestedPage = await context.newPage();
  try {
    await suggestedPage.goto(suggestedUrl, { waitUntil: 'domcontentloaded' });
    await suggestedPage.waitForTimeout(2000);
    const result = await inspectSuggestedPosts(suggestedPage, loadKnownAdvertisements(root), {
      expectedCount: state.expectedSuggestedCount ?? null
    });
    state.suggestedHref = suggestedPage.url();
    state.suggestedPostIds = result.postIds;
    if (result.duplicate) {
      throw new Error(`В предложенных уже есть наше объявление (${result.duplicate.animal}, ${result.duplicate.postId || 'без ID'}). Публикация в эту группу запрещена`);
    }
    if (!result.complete) {
      throw new Error(`Не удалось проверить всю предложку: найдено ${result.postIds.length} из ${state.expectedSuggestedCount} записей. Публикация запрещена`);
    }
  } finally {
    await suggestedPage.close();
  }
}

async function withSession(action) {
  const session = await ensureSession(root);
  try {
    return await action(session);
  } finally {
    await session.browser.close();
  }
}

async function prepare(args) {
  if (fs.existsSync(statePath)) {
    const existing = loadState();
    if (['submit_attempted', 'result_unknown'].includes(existing.stage)) {
      throw new Error('Предыдущая отправка не подтверждена. Разрешена только команда verify');
    }
    if (!args.replace) throw new Error('План уже существует. Используйте его или добавьте --replace до новой отправки');
    if (existing.stage === 'form_verified') throw new Error('Сначала закройте заполненную форму; заменять проверенный план запрещено');
  }
  const plan = createPostingPlan({
    root,
    animal: args.animal,
    groupUrl: args['group-url'],
    mediaReviewed: args['media-reviewed'] === true
  });
  const state = { version: 1, stage: 'prepared', plan };
  saveState(state);
  print({ stage: state.stage, animal: plan.animal, group: plan.group, media: plan.media, expectedCount: plan.expectedCount });
}

async function sessionCommand() {
  await withSession(async ({ context, page }) => {
    const auth = await authorizationStatus(page);
    print({ stage: 'session', ...auth, action: auth.authorized ? 'continue' : 'login_required' });
    if (!auth.authorized) process.exitCode = 2;
  });
}

async function openGroup() {
  const state = loadState();
  const plan = checkedPlan(state);
  if (!['prepared', 'group_checked'].includes(state.stage)) throw new Error(`Команда недоступна в состоянии ${state.stage}`);
  await withSession(async ({ context, page }) => {
    const auth = await authorizationStatus(page);
    if (!auth.authorized) throw new Error('Сначала войдите в VK в открытом Edge и повторите session');
    await page.goto(plan.group.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => /Создать|Предложить пост|Предложить новость/.test(document.body?.innerText || ''),
      null,
      { timeout: 5000 }
    ).catch(() => {});
    const actualKey = new URL(page.url()).pathname.replace(/\/$/, '').toLowerCase();
    if (actualKey !== plan.group.key) throw new Error(`VK перенаправил на другую страницу: ${page.url()}`);
    const title = await page.title();
    const body = await page.locator('body').innerText();
    if (!/Создать|Предложить пост|Предложить новость/.test(body)) throw new Error('В группе нет доступного способа создать запись');
    const suggested = page.getByText(/Предложенные\s+\d+/).first();
    const suggestedLabel = await suggested.innerText().catch(() => '');
    const suggestedHref = await suggested.getAttribute('href').catch(() => null);
    state.suggestedHref = suggestedHref ? new URL(suggestedHref, page.url()).href : null;
    state.expectedSuggestedCount = suggestedLabel ? Number.parseInt(suggestedLabel.match(/\d+/)?.[0], 10) : null;
    const visibleIds = await visiblePostIds(page);
    const owners = visibleIds.map(id => id.split('_')[0]).filter(owner => /^-\d+$/.test(owner));
    const counts = new Map(owners.map(owner => [owner, owners.filter(value => value === owner).length]));
    const rankedOwners = [...counts].sort((left, right) => right[1] - left[1]);
    const numericOwner = plan.group.key.match(/^\/club(\d+)$/)?.[1];
    if (numericOwner && counts.has(`-${numericOwner}`)) state.expectedOwnerId = `-${numericOwner}`;
    else if (!numericOwner && rankedOwners.length && rankedOwners[0][1] !== rankedOwners[1]?.[1]) state.expectedOwnerId = rankedOwners[0][0];
    else {
      throw new Error('Не удалось однозначно определить owner ID выбранной группы');
    }
    await checkSuggestedPosts(context, state);
    transition(state, ['prepared', 'group_checked'], 'group_checked');
    print({ stage: state.stage, title, url: page.url(), suggestedHref: state.suggestedHref, next: 'Проверьте предложенные, затем fill --suggested-reviewed' });
  });
}

async function fill(args) {
  if (args['suggested-reviewed'] !== true) throw new Error('Сначала проверьте отсутствие дубля в предложенных и добавьте --suggested-reviewed');
  const state = loadState();
  const plan = checkedPlan(state);
  if (!['group_checked', 'form_verified'].includes(state.stage)) throw new Error(`Команда недоступна в состоянии ${state.stage}`);
  await withSession(async ({ context }) => {
    const page = await selectGroupPage(context, plan);
    const auth = await authorizationStatus(page);
    if (!auth.authorized) throw new Error('Авторизация VK не подтверждена');
    await checkSuggestedPosts(context, state);
    const result = await fillPostingDialog(page, plan);
    state.reviewToken = crypto.randomBytes(6).toString('hex');
    transition(state, ['group_checked', 'form_verified'], 'form_verified');
    print({ stage: state.stage, ...result, reviewToken: state.reviewToken, next: `publish --token ${state.reviewToken}` });
  });
}

async function inspectResult(args) {
  const state = loadState();
  const plan = checkedPlan(state, { eligibility: false });
  await withSession(async ({ page }) => {
    const inspectPage = async () => page.locator('[data-testid="post"]').evaluateAll((posts, animal) => posts.map(post => ({
      postId: post.getAttribute('data-post-id'),
      mentionsAnimal: (post.innerText || '').includes(animal),
      textStart: (post.innerText || '').slice(0, 120),
      postText: (post.querySelector('[data-testid="post_text"]')?.innerText || '').includes(animal)
        ? post.querySelector('[data-testid="post_text"]').innerText
        : null,
      mediaLinks: new Set([...post.querySelectorAll('a')].map(link => link.getAttribute('href') || '').filter(href => href.includes('/photo') || href.includes('/video'))).size
    })), plan.animal);
    if (args.url) {
      const target = new URL(args.url);
      if (!/^(?:www\.)?vk\.(?:com|ru)$/i.test(target.hostname) || !target.pathname.startsWith(`/wall${state.expectedOwnerId}_`)) {
        throw new Error('Диагностическая ссылка должна вести на запись выбранной группы');
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
      await page.locator(`[data-testid="post"][data-post-id="${target.pathname.slice(5)}"]`).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const posts = await inspectPage();
      let screenshot = null;
      const mediaScreenshots = [];
      if (args.screenshot) {
        screenshot = path.join(os.tmpdir(), 'animal-volunteer-result.png');
        await page.locator(`[data-testid="post"][data-post-id="${target.pathname.slice(5)}"]`).screenshot({ path: screenshot });
      }
      if (args['screenshot-all']) {
        const post = page.locator(`[data-testid="post"][data-post-id="${target.pathname.slice(5)}"]`);
        const mediaSources = await post.locator('a').evaluateAll(elements => elements
          .map(element => ({ href: element.getAttribute('href') || '', src: element.querySelector('img')?.src || '' }))
          .filter(item => (item.href.includes('/photo') || item.href.includes('/video')) && item.src)
          .filter((item, index, items) => items.findIndex(candidate => candidate.href === item.href) === index)
          .map(item => item.src));
        for (let index = 0; index < mediaSources.length; index += 1) {
          await page.goto(mediaSources[index], { waitUntil: 'load' });
          const mediaPath = path.join(os.tmpdir(), `animal-volunteer-media-${index + 1}.png`);
          await page.screenshot({ path: mediaPath });
          mediaScreenshots.push(mediaPath);
        }
      }
      print({ stage: state.stage, url: target.href, posts, screenshot, mediaScreenshots });
      return;
    }
    await page.goto(plan.group.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const suggested = page.getByText(/Предложенные\s+\d+/).first();
    const suggestedHref = await suggested.getAttribute('href').catch(() => null);
    const groupPosts = await inspectPage();
    let suggestedPosts = [];
    const suggestedUrl = suggestedHref || (state.expectedOwnerId ? `https://vk.ru/wall${state.expectedOwnerId}?suggested=1` : null);
    if (suggestedUrl) {
      await page.goto(new URL(suggestedUrl, page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      suggestedPosts = await inspectPage();
    }
    print({ stage: state.stage, suggestedHref: suggestedUrl, groupPosts, suggestedPosts });
  });
}

async function publish(args) {
  const state = loadState();
  const plan = checkedPlan(state);
  if (state.stage === 'submit_attempted' || state.stage === 'result_unknown') {
    throw new Error('Отправка уже предпринималась. Повторный клик запрещен; выполните verify');
  }
  if (state.stage !== 'form_verified') throw new Error(`Команда недоступна в состоянии ${state.stage}`);
  if (!args.token || args.token !== state.reviewToken) throw new Error('Нужен reviewToken из команды fill');
  await withSession(async ({ context }) => {
    const page = await selectGroupPage(context, plan, { requireDialog: true });
    const beforePostIds = await visiblePostIds(page);
    state.beforePostIds = beforePostIds;
    await checkSuggestedPosts(context, state);
    const submission = await clickPublishOnce(page, plan, async () => transition(state, ['form_verified'], 'submit_attempted'));
    const result = await findResult(page, plan, {
      excludedPostIds: [...beforePostIds, ...(state.suggestedPostIds || [])],
      expectedOwnerId: state.expectedOwnerId
    });
    if (!result) {
      transition(state, ['submit_attempted'], 'result_unknown');
      print({
        stage: state.stage,
        dialogClosed: submission.dialogClosed,
        warning: 'Результат не подтвержден. Не обновляйте страницу и не повторяйте отправку; выполните только verify.'
      });
      process.exitCode = 3;
      return;
    }
    state.result = result;
    transition(state, ['submit_attempted'], 'result_verified');
    print({ stage: state.stage, dialogClosed: submission.dialogClosed, result, next: 'Проверьте все изображения и внесите запись в REPORT.MD' });
  });
}

async function verify(args) {
  const state = loadState();
  const plan = checkedPlan(state, { eligibility: false });
  if (state.stage === 'form_verified') {
    if (!args.url) throw new Error('Для проверки ручной публикации укажите verify --url <ссылка на запись>');
    await withSession(async ({ page }) => {
      const result = await verifyResultUrl(page, plan, args.url, {
        excludedPostIds: [...(state.beforePostIds || []), ...(state.suggestedPostIds || [])],
        expectedOwnerId: state.expectedOwnerId
      });
      if (!result) throw new Error('Ручная публикация не совпадает с подготовленным текстом или составом вложений');
      state.result = { ...result, verifiedAt: new Date().toISOString() };
      transition(state, ['form_verified'], 'result_verified');
      print({ stage: state.stage, verified: true, result: state.result });
    });
    return;
  }
  if (!['submit_attempted', 'result_unknown', 'result_verified'].includes(state.stage)) {
    throw new Error(`Команда verify недоступна в состоянии ${state.stage}`);
  }
  await withSession(async ({ page }) => {
    const result = await findResult(page, plan, {
      excludedPostIds: [...(state.beforePostIds || []), ...(state.suggestedPostIds || [])],
      expectedOwnerId: state.expectedOwnerId
    });
    if (!result) {
      print({ stage: state.stage, verified: false, warning: 'Запись не найдена. Не нажимайте отправку повторно.' });
      process.exitCode = 3;
      return;
    }
    state.result = result;
    transition(state, ['submit_attempted', 'result_unknown', 'result_verified'], 'result_verified');
    print({ stage: state.stage, verified: true, result });
  });
}

async function resolveDeleted(args) {
  const state = loadState();
  const plan = checkedPlan(state, { eligibility: false });
  if (state.stage !== 'result_unknown') throw new Error(`Команда resolve-deleted недоступна в состоянии ${state.stage}`);
  if (!args.url) throw new Error('Укажите --url удалённой записи');
  const target = new URL(args.url);
  if (!/^(?:www\.)?vk\.(?:com|ru)$/i.test(target.hostname) || !target.pathname.startsWith(`/wall${state.expectedOwnerId}_`)) {
    throw new Error('Ссылка должна вести на запись выбранной группы');
  }
  await withSession(async ({ page }) => {
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const post = page.locator(`[data-testid="post"][data-post-id="${target.pathname.slice(5)}"]`);
    if (!await post.count() || !/Пост удалён/.test(await post.innerText())) {
      throw new Error('VK не подтверждает, что эта запись удалена');
    }
    state.result = { type: 'deleted', url: target.href };
    transition(state, ['result_unknown'], 'result_deleted');
    print({ stage: state.stage, result: state.result, next: 'Можно подготовить другую группу с prepare --replace' });
  });
}

function status() {
  const state = loadState();
  print({
    stage: state.stage,
    animal: state.plan.animal,
    group: state.plan.group,
    expectedCount: state.plan.expectedCount,
    reviewToken: state.stage === 'form_verified' ? state.reviewToken : null,
    result: state.result || null
  });
}

function usage() {
  process.stdout.write(`Команды:\n  prepare --animal <имя> --group-url <url> --media-reviewed [--replace]\n  session\n  open-group\n  fill --suggested-reviewed\n  publish --token <reviewToken>\n  verify [--url <post-url>]\n  inspect-result [--url <post-url>] [--screenshot-all]\n  resolve-deleted --url <post-url>\n  status\n`);
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  const command = args._[0];
  if (command === 'prepare') return withLock(() => prepare(args));
  if (command === 'session') return sessionCommand();
  if (command === 'open-group') return withLock(() => openGroup());
  if (command === 'fill') return withLock(() => fill(args));
  if (command === 'inspect-result') return inspectResult(args);
  if (command === 'publish') return withLock(() => publish(args));
  if (command === 'verify') return withLock(() => verify(args));
  if (command === 'resolve-deleted') return withLock(() => resolveDeleted(args));
  if (command === 'status') return status();
  usage();
  if (command) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
