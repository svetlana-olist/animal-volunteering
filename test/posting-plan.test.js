const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  GROUP_INTERVAL_MS,
  createPostingPlan,
  eligibleGroups,
  loadKnownAdvertisements,
  normalizeVkUrl,
  parseGroups,
  parseReport
} = require('../scripts/lib/posting-plan');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animal-volunteer-'));
  const dir = path.join(root, 'animals', 'dogs', 'Марта');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.md'), '# Марта\n\nРыжая собака.\n');
  fs.writeFileSync(path.join(dir, 'advertisement.md'), 'Марта ищет дом\n');
  fs.writeFileSync(path.join(dir, 'Марта-01.jpg'), 'image');
  fs.writeFileSync(path.join(root, 'VkGroups.md'), '1. Помощь животным\n   https://vk.com/help_animals\n');
  fs.writeFileSync(path.join(root, 'REPORT.MD'), '# Отчёт о размещениях\n');
  return { root, dir };
}

test('normalizes vk.com and vk.ru group URLs to one key', () => {
  assert.equal(normalizeVkUrl('https://vk.com/Club123/'), '/club123');
  assert.equal(normalizeVkUrl('http://vk.ru/club123'), '/club123');
});

test('parses groups and report records', () => {
  const groups = parseGroups('1. Test group\n  https://vk.com/test_group\n');
  assert.deepEqual(groups[0], { name: 'Test group', url: 'https://vk.com/test_group', key: '/test_group' });
  const report = parseReport('## 2026-09-18\n\n- 10:00 МСК — Марта — [Test](https://vk.ru/test_group) — запись;\n');
  assert.equal(report[0].animal, 'Марта');
  assert.equal(report[0].key, '/test_group');
});

test('creates an immutable validated plan', () => {
  const { root } = fixture();
  const plan = createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.ru/help_animals', mediaReviewed: true });
  assert.equal(plan.species, 'dogs');
  assert.equal(plan.expectedCount, 1);
  assert.match(plan.hash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(plan));
});

test('uses an explicit species when an animal name exists in dogs and cats', () => {
  const { root } = fixture();
  const catDir = path.join(root, 'animals', 'cats', 'Марта');
  fs.mkdirSync(catDir, { recursive: true });
  fs.writeFileSync(path.join(catDir, 'info.md'), '# Марта\n\nРыжая кошка.\n');
  fs.writeFileSync(path.join(catDir, 'advertisement.md'), 'Кошка Марта ищет дом\n');
  fs.writeFileSync(path.join(catDir, 'Марта-01.jpg'), 'cat image');

  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.ru/help_animals', mediaReviewed: true }),
    /ровно в одной папке/
  );
  const plan = createPostingPlan({
    root,
    animal: 'Марта',
    species: 'dogs',
    groupUrl: 'https://vk.ru/help_animals',
    mediaReviewed: true
  });
  assert.equal(plan.species, 'dogs');
  assert.equal(plan.text, 'Марта ищет дом\n');
});

test('requires an explicit visual media review assertion', () => {
  const { root } = fixture();
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.ru/help_animals' }),
    /визуально проверьте/
  );
});

test('loads advertisements from active animal cards only', () => {
  const { root } = fixture();
  const archived = path.join(root, 'animals', 'dogs', 'archive', 'Старая карточка');
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(path.join(archived, 'advertisement.md'), 'Старое объявление');
  assert.deepEqual(loadKnownAdvertisements(root), [{ animal: 'Марта', text: 'Марта ищет дом\n' }]);
});

test('rejects a media file with another prefix', () => {
  const { root, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'other.jpg'), 'image');
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.ru/help_animals', mediaReviewed: true }),
    /Неверный префикс/
  );
});

test('rejects a group before the 1.2 day interval expires', () => {
  const { root } = fixture();
  const lastPost = Date.parse('2026-09-18T10:00:00+03:00');
  fs.writeFileSync(
    path.join(root, 'REPORT.MD'),
    '# Отчёт\n\n## 2026-09-18\n\n- 10:00 МСК — Ириска — [Помощь](https://vk.com/help_animals) — запись;\n'
  );
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.ru/help_animals', mediaReviewed: true, now: lastPost + GROUP_INTERVAL_MS - 1 }),
    /интервал 1,2 дня/
  );
});

test('rejects a dog in a cats-only group', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'VkGroups.md'), '1. Кошки и котята\n   https://vk.com/cats_only\n');
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.com/cats_only', mediaReviewed: true }),
    /только для кошек/
  );
});

test('rejects the same animal in one group during seven days', () => {
  const { root } = fixture();
  fs.writeFileSync(
    path.join(root, 'REPORT.MD'),
    '# Отчёт\n\n## 2026-09-13\n\n- 10:00 МСК — Марта — [Помощь](https://vk.com/help_animals) — запись;\n'
  );
  assert.throws(
    () => createPostingPlan({
      root,
      animal: 'Марта',
      groupUrl: 'https://vk.ru/help_animals',
      mediaReviewed: true,
      now: Date.parse('2026-09-18T18:00:00+03:00')
    }),
    /два раза подряд|не прошли 7 дней/
  );
});

test('rejects paid groups', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'VkGroups.md'), '1. Помощь животным ПЛАТНО\n   https://vk.com/paid_group\n');
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.com/paid_group', mediaReviewed: true }),
    /платная/
  );
});

test('lists only groups currently eligible for an animal', () => {
  const { root } = fixture();
  fs.appendFileSync(
    path.join(root, 'VkGroups.md'),
    '2. Платная группа ПЛАТНО\n   https://vk.com/paid_group\n3. Другая группа\n   https://vk.com/other_group\n'
  );
  fs.writeFileSync(
    path.join(root, 'REPORT.MD'),
    '# Отчёт\n\n## 2026-09-18\n\n- 10:00 МСК — Ириска — [Помощь](https://vk.com/help_animals) — запись;\n'
  );
  assert.deepEqual(
    eligibleGroups({ root, animal: 'Марта', now: Date.parse('2026-09-18T10:01:00+03:00') }).map(group => group.key),
    ['/other_group']
  );
});

test('rejects a discussion topic instead of a group wall', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'VkGroups.md'), '1. Обсуждение\n   https://vk.com/topic-1_2\n');
  assert.throws(
    () => createPostingPlan({ root, animal: 'Марта', groupUrl: 'https://vk.com/topic-1_2', mediaReviewed: true }),
    /обсуждение/
  );
});
