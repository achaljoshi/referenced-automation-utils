package com.company.automation.commons.random;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.RepeatedTest;

import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RandomDataUtilsTest {

    @Test
    void generatesNonBlankNames() {
        assertFalse(RandomDataUtils.firstName().isBlank());
        assertFalse(RandomDataUtils.lastName().isBlank());
        assertFalse(RandomDataUtils.fullName().isBlank());
    }

    @Test
    void generatesValidLookingEmail() {
        String email = RandomDataUtils.email();
        assertTrue(email.contains("@"), "Expected an email address but got: " + email);
    }

    @Test
    void generatesUniqueUuids() {
        assertFalse(RandomDataUtils.uuid().equals(RandomDataUtils.uuid()));
    }

    @RepeatedTest(20)
    void numberRespectsInclusiveBounds() {
        int value = RandomDataUtils.number(1, 5);
        assertTrue(value >= 1 && value <= 5, "Value out of bounds: " + value);
    }

    @Test
    void alphaNumericHasRequestedLength() {
        assertEquals(10, RandomDataUtils.alphaNumeric(10).length());
    }

    @Test
    void numericStringHasRequestedLengthAndIsDigitsOnly() {
        String digits = RandomDataUtils.numericString(6);
        assertEquals(6, digits.length());
        assertTrue(digits.chars().allMatch(Character::isDigit));
    }

    @Test
    void futureDateIsAfterToday() {
        LocalDate future = RandomDataUtils.futureDate(30);
        assertTrue(!future.isBefore(LocalDate.now()));
    }

    @Test
    void pastDateIsBeforeOrEqualToday() {
        LocalDate past = RandomDataUtils.pastDate(30);
        assertTrue(!past.isAfter(LocalDate.now()));
    }
}
