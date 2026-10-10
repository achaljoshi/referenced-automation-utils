import { test, expect } from '@playwright/test';
import * as crypto from '../src/crypto/cryptoUtils';

// Known-answer vectors from the standards (FIPS 180 / RFC 1321 for the digests of "abc", RFC 2202 and RFC 4231 for
// HMAC), so a wrong algorithm, encoding or argument order fails - a "same input gives same output" test cannot.
test.describe('cryptoUtils', () => {
  test('digests match the published vectors for "abc"', () => {
    expect(crypto.md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(crypto.sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(crypto.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(crypto.sha512Hex('abc')).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
  });

  test('the empty string and non-ASCII input are hashed as UTF-8', () => {
    expect(crypto.sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // "é" is the two bytes C3 A9 in UTF-8 (sha256 of those bytes, computed independently with openssl)
    expect(crypto.sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });

  test('HMAC matches RFC 4231 (SHA-256) and RFC 2202 (SHA-1) test case 2: key "Jefe"', () => {
    expect(crypto.hmacSha256Hex('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(crypto.hmacSha1Hex('what do ya want for nothing?', 'Jefe')).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });

  test('the HMAC key and the data are not interchangeable (argument order is data, key)', () => {
    expect(crypto.hmacSha256Hex('Jefe', 'what do ya want for nothing?')).not.toBe(
      crypto.hmacSha256Hex('what do ya want for nothing?', 'Jefe'),
    );
  });

  test('base64 matches RFC 4648 vectors, including padding, and decodes UTF-8', () => {
    expect(crypto.base64Encode('')).toBe('');
    expect(crypto.base64Encode('f')).toBe('Zg==');
    expect(crypto.base64Encode('fo')).toBe('Zm8=');
    expect(crypto.base64Encode('foo')).toBe('Zm9v');
    expect(crypto.base64Encode('foobar')).toBe('Zm9vYmFy');
    expect(crypto.base64Decode('Zm9vYmFy')).toBe('foobar');
    expect(crypto.base64Decode(crypto.base64Encode('héllo ✓'))).toBe('héllo ✓');
    expect(crypto.base64Encode('héllo')).toBe('aMOpbGxv');
  });

  test('mask hides all but the last N characters, and never reveals a value no longer than N', () => {
    expect(crypto.mask('4111111111111111', 4)).toBe('************1111');
    expect(crypto.mask('abc', 4)).toBe('***');
    expect(crypto.mask('abcd', 4)).toBe('****'); // exactly N long: nothing safe to show
    expect(crypto.mask('abcde', 4)).toBe('*bcde');
    expect(crypto.mask('secret', 0)).toBe('******');
    expect(crypto.mask('secret', -3)).toBe('******');
    expect(crypto.mask('')).toBe('');
  });
});
