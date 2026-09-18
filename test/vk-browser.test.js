const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRenderedText, countPreviewAttachments, matchKnownAdvertisement } = require('../scripts/lib/vk-browser');

test('ignores only the trailing VK show-more control', () => {
  assert.equal(canonicalRenderedText('Марта ищет дом\nПоказать ещё'), 'Марта ищет дом');
  assert.equal(canonicalRenderedText('Показать ещё\nМарта ищет дом'), 'Показать ещё\nМарта ищет дом');
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
