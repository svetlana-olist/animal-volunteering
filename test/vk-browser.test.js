const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRenderedText, matchKnownAdvertisement } = require('../scripts/lib/vk-browser');

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
