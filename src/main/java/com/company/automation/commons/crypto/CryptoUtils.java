package com.company.automation.commons.crypto;

import com.company.automation.commons.exceptions.CommonsException;
import org.apache.commons.codec.binary.Hex;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/**
 * Hashing, HMAC and Base64 helpers commonly needed in test automation -
 * verifying checksums, signing API requests, masking PII in logs/reports.
 */
public final class CryptoUtils {

    private CryptoUtils() {
    }

    public static String md5Hex(String input) {
        return digestHex(input, "MD5");
    }

    public static String sha1Hex(String input) {
        return digestHex(input, "SHA-1");
    }

    public static String sha256Hex(String input) {
        return digestHex(input, "SHA-256");
    }

    public static String sha512Hex(String input) {
        return digestHex(input, "SHA-512");
    }

    private static String digestHex(String input, String algorithm) {
        try {
            MessageDigest digest = MessageDigest.getInstance(algorithm);
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return Hex.encodeHexString(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new CommonsException("Unsupported digest algorithm: " + algorithm, e);
        }
    }

    /** HMAC-SHA256, hex-encoded - typical usage: signing webhook/API payloads in tests. */
    public static String hmacSha256Hex(String data, String secretKey) {
        return hmacHex(data, secretKey, "HmacSHA256");
    }

    public static String hmacSha1Hex(String data, String secretKey) {
        return hmacHex(data, secretKey, "HmacSHA1");
    }

    private static String hmacHex(String data, String secretKey, String algorithm) {
        try {
            Mac mac = Mac.getInstance(algorithm);
            mac.init(new SecretKeySpec(secretKey.getBytes(StandardCharsets.UTF_8), algorithm));
            byte[] rawHmac = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            return Hex.encodeHexString(rawHmac);
        } catch (Exception e) {
            throw new CommonsException("Failed to compute " + algorithm, e);
        }
    }

    public static String base64Encode(String input) {
        return Base64.getEncoder().encodeToString(input.getBytes(StandardCharsets.UTF_8));
    }

    public static String base64Decode(String base64Input) {
        return new String(Base64.getDecoder().decode(base64Input), StandardCharsets.UTF_8);
    }

    /** Masks all but the last {@code visibleChars} characters - e.g. for logging card/account numbers safely. */
    public static String mask(String value, int visibleChars) {
        if (value == null || value.length() <= visibleChars) {
            return value;
        }
        int maskedLength = value.length() - visibleChars;
        return "*".repeat(maskedLength) + value.substring(maskedLength);
    }
}
