#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPostingPlan, hashPlan } = require('./lib/posting-plan');
const {
  authorizationStatus,
  clickPublishOnce,
  ensureSession,
  fillPostingDialog,
  findResult,
  selectGroupPage,
  visiblePostIds,
  verifyPreparedForm
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
  await withSession(async ({ page }) => {
    const auth = await authorizationStatus(page);
    if (!auth.authorized) throw new Error('Сначала войдите в VK в открытом Edge и повторите session');
    await page.goto(plan.group.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const actualKey = new URL(page.url()).pathname.replace(/\/$/, '').toLowerCase();
    if (actualKey !== plan.group.key) throw new Error(`VK перенаправил на другую страницу: ${page.url()}`);
    const title = await page.title();
    const body = await page.locator('body').innerText();
    if (!/Создать|Предложить пост|Предложить новость/.test(body)) throw new Error('В группе нет доступного способа создать запись');
    const suggested = page.getByText(/Предложенные\s+\d+/).first();
    const suggestedHref = await suggested.getAttribute('href').catch(() => null);
    state.suggestedHref = suggestedHref ? new URL(suggestedHref, page.url()).href : null;
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
    state.suggestedPostIds = [];
    if (suggestedHref) {
      const suggestedPage = await context.newPage();
      try {
        await suggestedPage.goto(state.suggestedHref, { waitUntil: 'domcontentloaded' });
        await suggestedPage.waitForTimeout(2000);
        state.suggestedPostIds = await visiblePostIds(suggestedPage);
      } finally {
        await suggestedPage.close();
      }
    }
    transition(state, ['prepared', 'group_checked'], 'group_checked');
    print({ stage: state.stage, title, url: page.url(), suggestedHref, next: suggestedHref ? 'Проверьте предложенные, затем fill --suggested-reviewed' : 'Выполните fill --suggested-reviewed' });
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
    const result = await fillPostingDialog(page, plan);
    state.reviewToken = crypto.randomBytes(6).toString('hex');
    transition(state, ['group_checked', 'form_verified'], 'form_verified');
    print({ stage: state.stage, ...result, reviewToken: state.reviewToken, next: `publish --token ${state.reviewToken}` });
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
    await verifyPreparedForm(page, plan);
    const beforePostIds = await visiblePostIds(page);
    state.beforePostIds = beforePostIds;
    if (state.suggestedHref) {
      const suggestedPage = await context.newPage();
      try {
        await suggestedPage.goto(state.suggestedHref, { waitUntil: 'domcontentloaded' });
        await suggestedPage.waitForTimeout(2000);
        state.suggestedPostIds = await visiblePostIds(suggestedPage);
      } finally {
        await suggestedPage.close();
      }
    }
    await clickPublishOnce(page, plan, async () => transition(state, ['form_verified'], 'submit_attempted'));
    const result = await findResult(page, plan, {
      excludedPostIds: [...beforePostIds, ...(state.suggestedPostIds || [])],
      expectedOwnerId: state.expectedOwnerId
    });
    if (!result) {
      transition(state, ['submit_attempted'], 'result_unknown');
      print({ stage: state.stage, warning: 'Результат не подтвержден. Не повторяйте отправку; выполните verify.' });
      process.exitCode = 3;
      return;
    }
    state.result = result;
    transition(state, ['submit_attempted'], 'result_verified');
    print({ stage: state.stage, result, next: 'Проверьте все изображения и внесите запись в REPORT.MD' });
  });
}

async function verify() {
  const state = loadState();
  const plan = checkedPlan(state, { eligibility: false });
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

function status() {
  const state = loadState();
  print({ stage: state.stage, animal: state.plan.animal, group: state.plan.group, expectedCount: state.plan.expectedCount, result: state.result || null });
}

function usage() {
  process.stdout.write(`Команды:\n  prepare --animal <имя> --group-url <url> --media-reviewed [--replace]\n  session\n  open-group\n  fill --suggested-reviewed\n  publish --token <reviewToken>\n  verify\n  status\n`);
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  const command = args._[0];
  if (command === 'prepare') return withLock(() => prepare(args));
  if (command === 'session') return sessionCommand();
  if (command === 'open-group') return withLock(() => openGroup());
  if (command === 'fill') return withLock(() => fill(args));
  if (command === 'publish') return withLock(() => publish(args));
  if (command === 'verify') return withLock(() => verify());
  if (command === 'status') return status();
  usage();
  if (command) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
