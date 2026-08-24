package com.company.automation.commons.random;

import net.datafaker.Faker;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Thin, easy-to-use wrapper around {@link Faker} (net.datafaker) for
 * generating synthetic test data - names, emails, addresses, companies,
 * numbers, UUIDs - so step definitions and page objects across the
 * referenced-automation-* family never need to depend on DataFaker directly.
 *
 * <p>One {@link Faker} instance is shared per thread to stay parallel-safe
 * without needing a new seeded generator per call.
 */
public final class RandomDataUtils {

    private static final ThreadLocal<Faker> FAKER = ThreadLocal.withInitial(Faker::new);

    private RandomDataUtils() {
    }

    public static Faker faker() {
        return FAKER.get();
    }

    public static String firstName() {
        return faker().name().firstName();
    }

    public static String lastName() {
        return faker().name().lastName();
    }

    public static String fullName() {
        return faker().name().fullName();
    }

    public static String email() {
        return faker().internet().emailAddress();
    }

    public static String email(String localPartPrefix) {
        return localPartPrefix + "+" + randomAlphaNumeric(6) + "@" + faker().internet().domainName();
    }

    public static String phoneNumber() {
        return faker().phoneNumber().phoneNumber();
    }

    public static String streetAddress() {
        return faker().address().fullAddress();
    }

    public static String city() {
        return faker().address().city();
    }

    public static String country() {
        return faker().address().country();
    }

    public static String companyName() {
        return faker().company().name();
    }

    public static String jobTitle() {
        return faker().job().title();
    }

    public static String uuid() {
        return UUID.randomUUID().toString();
    }

    public static int number(int minInclusive, int maxInclusive) {
        return ThreadLocalRandom.current().nextInt(minInclusive, maxInclusive + 1);
    }

    public static String alphaNumeric(int length) {
        return randomAlphaNumeric(length);
    }

    public static String numericString(int length) {
        return faker().number().digits(length);
    }

    public static LocalDate futureDate(int maxDaysAhead) {
        Date date = faker().date().future(maxDaysAhead, java.util.concurrent.TimeUnit.DAYS);
        return date.toInstant().atZone(ZoneId.systemDefault()).toLocalDate();
    }

    public static LocalDate pastDate(int maxDaysBack) {
        Date date = faker().date().past(maxDaysBack, java.util.concurrent.TimeUnit.DAYS);
        return date.toInstant().atZone(ZoneId.systemDefault()).toLocalDate();
    }

    public static String creditCardNumber() {
        return faker().finance().creditCard();
    }

    private static String randomAlphaNumeric(int length) {
        return faker().regexify("[A-Za-z0-9]{" + length + "}");
    }
}
