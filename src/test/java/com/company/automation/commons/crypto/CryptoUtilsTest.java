package com.company.automation.commons.crypto;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class CryptoUtilsTest {

    @Test
    void sha256HexMatchesKnownVector() {
        // sha256("hello") - well-known test vector
        assertEquals(
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                CryptoUtils.sha256Hex("hello"));
    }

    @Test
    void md5HexMatchesKnownVector() {
        // md5("hello") - well-known test vector
        assertEquals("5d41402abc4b2a76b9719d911017c592", CryptoUtils.md5Hex("hello"));
    }

    @Test
    void hmacSha256IsDeterministicForSameInputs() {
        String first = CryptoUtils.hmacSha256Hex("payload", "secret");
        String second = CryptoUtils.hmacSha256Hex("payload", "secret");
        assertEquals(first, second);
    }

    @Test
    void hmacSha256DiffersForDifferentSecrets() {
        String withSecretA = CryptoUtils.hmacSha256Hex("payload", "secretA");
        String withSecretB = CryptoUtils.hmacSha256Hex("payload", "secretB");
        org.junit.jupiter.api.Assertions.assertNotEquals(withSecretA, withSecretB);
    }

    @Test
    void base64RoundTrip() {
        String original = "referenced-automation-utils";
        String encoded = CryptoUtils.base64Encode(original);
        assertEquals(original, CryptoUtils.base64Decode(encoded));
    }

    @Test
    void masksAllButVisibleTrailingChars() {
        assertEquals("************1234", CryptoUtils.mask("4111111111111234", 4));
    }

    @Test
    void maskReturnsOriginalWhenShorterThanVisibleChars() {
        assertEquals("123", CryptoUtils.mask("123", 5));
    }
}
