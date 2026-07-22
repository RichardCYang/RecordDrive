import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_BCRYPT_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  passwordMeetsPolicy
} from '../src/password-policy.js';

test('password policy enforces Unicode character and bcrypt byte boundaries', () => {
  assert.equal(passwordMeetsPolicy('a'.repeat(MIN_PASSWORD_LENGTH - 1)), false);
  assert.equal(passwordMeetsPolicy('a'.repeat(MIN_PASSWORD_LENGTH)), true);

  const sixEmojiWithTwelveUtf16CodeUnits = '😀'.repeat(6);
  assert.equal(sixEmojiWithTwelveUtf16CodeUnits.length, MIN_PASSWORD_LENGTH);
  assert.equal(Array.from(sixEmojiWithTwelveUtf16CodeUnits).length, 6);
  assert.equal(passwordMeetsPolicy(sixEmojiWithTwelveUtf16CodeUnits), false);

  const exactlySeventyTwoBytes = `${'가'.repeat(23)}abc`;
  const moreThanSeventyTwoBytes = `${'가'.repeat(24)}a`;
  assert.equal(Buffer.byteLength(exactlySeventyTwoBytes, 'utf8'), MAX_BCRYPT_PASSWORD_BYTES);
  assert.equal(Buffer.byteLength(moreThanSeventyTwoBytes, 'utf8') > MAX_BCRYPT_PASSWORD_BYTES, true);
  assert.equal(passwordMeetsPolicy(exactlySeventyTwoBytes), true);
  assert.equal(passwordMeetsPolicy(moreThanSeventyTwoBytes), false);
});
