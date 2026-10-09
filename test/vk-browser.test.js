const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalRenderedText,
  countPreviewAttachments,
  isTextlessSettingsPreview,
  matchKnownAdvertisement,
  parseResultUrl,
  renderedText
} = require('../scripts/lib/vk-browser');

test('ignores only the trailing VK show-more control', () => {
  assert.equal(canonicalRenderedText('Марта ищет дом\nПоказать ещё'), 'Марта ищет дом');
  assert.equal(canonicalRenderedText('Показать ещё\nМарта ищет дом'), 'Показать ещё\nМарта ищет дом');
});

test('restores a shortened contact URL without rewriting the VK show-more control', async () => {
  const links = [
    { textContent: 'vk.ru/id175402691', href: 'https://vk.ru/id175402691' },
    { textContent: 'Показать ещё', href: 'https://vk.ru/wall-11798322_25218' }
  ];
  const clone = {
    style: {},
    querySelectorAll: selector => selector === 'a[href]' ? links : [],
    get innerText() { return `Рыся ищет дом\n${links.map(link => link.textContent).join('\n')}`; },
    remove() {}
  };
  const locator = { evaluate: callback => {
    const previous = global.document;
    global.document = { body: { appendChild() {} } };
    try { return callback({ cloneNode: () => clone }); }
    finally { global.document = previous; }
  } };
  const value = await renderedText(locator);
  assert.equal(value, 'Рыся ищет дом\nhttps://vk.ru/id175402691\nПоказать ещё');
  assert.equal(canonicalRenderedText(value), canonicalRenderedText('Рыся ищет дом\nhttps://vk.ru/id175402691\n'));
});

test('recognizes an existing known advertisement after VK rendering changes', () => {
  const advertisements = [
    { animal: 'Марта', text: 'Марта ищет дом\n\nhttps://vk.ru/id1\n' },
    { animal: 'Ириска', text: 'Ириска ищет дом\n' }
  ];
  assert.deepEqual(
    matchKnownAdvertisement('Марта ищет дом\n\nhttps://vk.ru/id1\nПоказать ещё', advertisements),
    advertisements[0]
  );
  assert.equal(matchKnownAdvertisement('Чужое объявление', advertisements), null);
});

test('counts a separately rendered primary video in the settings preview', () => {
  assert.equal(countPreviewAttachments(5, 1, 0), 6);
  assert.equal(countPreviewAttachments(6, 1, 1), 6);
});

test('accepts a textless settings preview only with exact attachments and controls', () => {
  assert.equal(isTextlessSettingsPreview(4, 4, 1, 1), true);
  assert.equal(isTextlessSettingsPreview(3, 4, 1, 1), false);
  assert.equal(isTextlessSettingsPreview(4, 4, 0, 1), false);
  assert.equal(isTextlessSettingsPreview(4, 4, 1, 0), false);
});

test('parses only an exact post URL from the expected group', () => {
  assert.deepEqual(parseResultUrl('https://vk.ru/wall-86265443_34094', '-86265443'), {
    ownerId: '-86265443',
    postId: '-86265443_34094',
    url: 'https://vk.ru/wall-86265443_34094'
  });
  assert.throws(
    () => parseResultUrl('https://vk.ru/wall-1_2', '-86265443'),
    /другой группы/
  );
  assert.throws(
    () => parseResultUrl('https://vk.ru/wall-86265443_34094/edit', '-86265443'),
    /отдельную запись/
  );
  assert.throws(
    () => parseResultUrl('https://vk.ru.example.com/wall-86265443_34094', '-86265443'),
    /запись VK/
  );
});
