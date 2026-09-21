const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm']);
const GROUP_INTERVAL_MS = 1.2 * 24 * 60 * 60 * 1000;
const ANIMAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeVkUrl(value) {
  try {
    const url = new URL(value.replace(/^http:/, 'https:'));
    if (!['vk.com', 'vk.ru', 'www.vk.com', 'www.vk.ru'].includes(url.hostname.toLowerCase())) return null;
    return url.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return null;
  }
}

function parseGroups(markdown) {
  const lines = markdown.split(/\r?\n/);
  const groups = [];
  for (let index = 0; index < lines.length; index += 1) {
    const url = lines[index].trim();
    if (!/^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//i.test(url)) continue;
    const previous = lines[index - 1]?.trim().replace(/^\d+\.\s*/, '') || '';
    groups.push({ name: previous, url, key: normalizeVkUrl(url) });
  }
  return groups;
}

function parseReport(markdown) {
  const records = [];
  let date = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (heading) {
      date = heading[1];
      continue;
    }
    if (!date || !line.startsWith('- ')) continue;
    const time = line.match(/^-\s+(\d{2}:\d{2})\s+МСК\s+—\s+([^—]+?)\s+—/);
    if (!time) continue;
    const urls = [...line.matchAll(/https?:\/\/vk\.(?:com|ru)\/[^)\s;]+/gi)].map(match => match[0]);
    const groupUrl = urls.find(url => !/\/wall-?\d+_\d+/i.test(url) && !/[?&]suggested=1/i.test(url));
    const key = groupUrl && normalizeVkUrl(groupUrl);
    if (!key) continue;
    const timestamp = Date.parse(`${date}T${time[1]}:00+03:00`);
    records.push({ timestamp, animal: time[2].trim(), key, line });
  }
  return records;
}

function findAnimal(root, animal) {
  const matches = ['dogs', 'cats']
    .map(species => ({ species, dir: path.join(root, 'animals', species, animal) }))
    .filter(item => fs.existsSync(item.dir) && fs.statSync(item.dir).isDirectory());
  if (matches.length !== 1) throw new Error(`Животное ${animal} должно находиться ровно в одной папке dogs или cats`);
  return matches[0];
}

function readRequired(file, label) {
  if (!fs.existsSync(file)) throw new Error(`Отсутствует ${label}: ${file}`);
  const value = fs.readFileSync(file, 'utf8');
  if (!value.trim()) throw new Error(`${label} пуст: ${file}`);
  return value;
}

function loadKnownAdvertisements(root) {
  const advertisements = [];
  for (const species of ['dogs', 'cats']) {
    const speciesDir = path.join(root, 'animals', species);
    if (!fs.existsSync(speciesDir)) continue;
    for (const entry of fs.readdirSync(speciesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const advertisementPath = path.join(speciesDir, entry.name, 'advertisement.md');
      if (!fs.existsSync(advertisementPath)) continue;
      const text = fs.readFileSync(advertisementPath, 'utf8');
      if (text.trim()) advertisements.push({ animal: entry.name, text });
    }
  }
  return advertisements;
}

function assertGroupEligibility({ animal, species, group, records, now }) {
  if (/платно|пропустить/i.test(group.name)) throw new Error(`Группа помечена как платная или пропускаемая: ${group.name}`);
  if (/^\/topic-/i.test(group.key)) throw new Error(`Ссылка ведёт на обсуждение, а не на стену группы: ${group.name}`);
  if (species === 'dogs' && /кошк|котят/i.test(group.name) && !/собак/i.test(group.name)) {
    throw new Error(`Группа предназначена только для кошек: ${group.name}`);
  }
  if (species === 'cats' && /собак|щен/i.test(group.name) && !/кошк|кот/i.test(group.name)) {
    throw new Error(`Группа предназначена только для собак: ${group.name}`);
  }

  const history = records.filter(record => record.key === group.key).sort((a, b) => b.timestamp - a.timestamp);
  if (history[0] && now - history[0].timestamp < GROUP_INTERVAL_MS) {
    throw new Error(`В группе еще не прошел интервал 1,2 дня: ${group.name}`);
  }
  if (history[0]?.animal === animal) throw new Error(`Нельзя размещать одно животное два раза подряд в группе: ${group.name}`);
  const sameAnimal = history.find(record => record.animal === animal);
  if (sameAnimal && now - sameAnimal.timestamp < ANIMAL_INTERVAL_MS) {
    throw new Error(`Для ${animal} в этой группе еще не прошли 7 дней`);
  }
}

function eligibleGroups({ root, animal, now = Date.now() }) {
  const found = findAnimal(root, animal);
  const groups = parseGroups(readRequired(path.join(root, 'VkGroups.md'), 'VkGroups.md'));
  const records = parseReport(readRequired(path.join(root, 'REPORT.MD'), 'REPORT.MD'));
  return groups.filter(group => {
    try {
      assertGroupEligibility({ animal, species: found.species, group, records, now });
      return true;
    } catch {
      return false;
    }
  });
}

function hashPlan(plan) {
  const hash = crypto.createHash('sha256');
  hash.update(plan.animal);
  hash.update(plan.info);
  hash.update(plan.text);
  hash.update(plan.group.url);
  for (const file of plan.media) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function createPostingPlan({ root, animal, groupUrl, mediaReviewed = false, now = Date.now() }) {
  if (!animal || !groupUrl) throw new Error('Нужны параметры --animal и --group-url');
  if (!mediaReviewed) throw new Error('Сначала визуально проверьте все медиа, затем добавьте --media-reviewed');

  const found = findAnimal(root, animal);
  const infoPath = path.join(found.dir, 'info.md');
  const advertisementPath = path.join(found.dir, 'advertisement.md');
  const info = readRequired(infoPath, 'info.md');
  const text = readRequired(advertisementPath, 'advertisement.md');
  const media = fs.readdirSync(found.dir)
    .filter(name => MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, 'ru'))
    .map(name => path.resolve(found.dir, name));
  if (!media.length) throw new Error(`В папке ${found.dir} нет медиа`);
  const realAnimalDir = fs.realpathSync(found.dir);
  for (const file of media) {
    if (!path.basename(file).startsWith(`${animal}-`)) throw new Error(`Неверный префикс медиафайла: ${file}`);
    if (path.dirname(file) !== path.resolve(found.dir)) throw new Error(`Медиафайл вне папки животного: ${file}`);
    if (fs.lstatSync(file).isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== realAnimalDir) {
      throw new Error(`Медиафайл ссылается за пределы папки животного: ${file}`);
    }
  }

  const groups = parseGroups(readRequired(path.join(root, 'VkGroups.md'), 'VkGroups.md'));
  const groupKey = normalizeVkUrl(groupUrl);
  const group = groups.find(item => item.key === groupKey);
  if (!group) throw new Error(`Группа отсутствует в VkGroups.md: ${groupUrl}`);
  const records = parseReport(readRequired(path.join(root, 'REPORT.MD'), 'REPORT.MD'));
  assertGroupEligibility({ animal, species: found.species, group, records, now });

  const plan = {
    animal,
    species: found.species,
    animalDir: path.resolve(found.dir),
    infoPath,
    advertisementPath,
    info,
    text,
    media,
    expectedCount: media.length,
    group,
    createdAt: new Date(now).toISOString()
  };
  plan.hash = hashPlan(plan);
  return Object.freeze(plan);
}

module.exports = {
  ANIMAL_INTERVAL_MS,
  GROUP_INTERVAL_MS,
  createPostingPlan,
  eligibleGroups,
  hashPlan,
  loadKnownAdvertisements,
  normalizeVkUrl,
  parseGroups,
  parseReport
};
