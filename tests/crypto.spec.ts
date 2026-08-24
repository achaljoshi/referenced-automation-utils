import { test, expect } from '@playwright/test';
import * as crypto from '../src/crypto/cryptoUtils';

test.describe('cryptoUtils', () => {
  test('hashes are stable and correct length', () => {
    expect(crypto.md5Hex('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(crypto.sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(crypto.sha1Hex('hello')).toHaveLength(40);
    expect(crypto.sha512Hex('hello')).toHaveLength(128);
  });

  test('hmac is deterministic for the same key', () => {
    const a = crypto.hmacSha256Hex('payload', 'secret');
    const b = crypto.hmacSha256Hex('payload', 'secret');
    const c = crypto.hmacSha256Hex('payload', 'different-secret');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('base64 round-trips', () => {
    expect(crypto.base64Decode(crypto.base64Encode('round-trip me'))).toBe('round-trip me');
  });

  test('mask hides all but the last N characters', () => {
    expect(crypto.mask('4111111111111111', 4)).toBe('************1111');
    expect(crypto.mask('abc', 4)).toBe('***');
  });
});
