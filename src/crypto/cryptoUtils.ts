import * as crypto from 'node:crypto';

export function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

export function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input, 'utf8').digest('hex');
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha512Hex(input: string): string {
  return crypto.createHash('sha512').update(input, 'utf8').digest('hex');
}

export function hmacSha256Hex(data: string, secretKey: string): string {
  return crypto.createHmac('sha256', secretKey).update(data, 'utf8').digest('hex');
}

export function hmacSha1Hex(data: string, secretKey: string): string {
  return crypto.createHmac('sha1', secretKey).update(data, 'utf8').digest('hex');
}

export function base64Encode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

export function base64Decode(base64Input: string): string {
  return Buffer.from(base64Input, 'base64').toString('utf8');
}

/**
 * Masks a sensitive value for logging, e.g. mask('4111111111111111', 4) ->
 * '************1111'. Never log raw card numbers/tokens/passwords - log the
 * masked form instead.
 */
export function mask(value: string, visibleChars = 4): string {
  const shown = Math.max(0, Math.floor(visibleChars));
  if (value.length <= shown) return '*'.repeat(value.length);
  // slice(-0) would return the whole value, so mask(secret, 0) must not go through it
  const visible = shown > 0 ? value.slice(-shown) : '';
  return '*'.repeat(value.length - shown) + visible;
}
