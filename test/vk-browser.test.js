const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRenderedText } = require('../scripts/lib/vk-browser');

test('ignores only the trailing VK show-more control', () => {
  assert.equal(canonicalRenderedText('Марта ищет дом\nПоказать ещё'), 'Марта ищет дом');
  assert.equal(canonicalRenderedText('Показать ещё\nМарта ищет дом'), 'Показать ещё\nМарта ищет дом');
});
