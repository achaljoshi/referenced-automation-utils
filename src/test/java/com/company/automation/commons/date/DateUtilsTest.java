package com.company.automation.commons.date;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DateUtilsTest {

    @Test
    void formatsAndParsesDateRoundTrip() {
        LocalDate date = LocalDate.of(2026, 8, 24);
        String formatted = DateUtils.formatDate(date);
        assertEquals("2026-08-24", formatted);
        assertEquals(date, DateUtils.parseDate(formatted));
    }

    @Test
    void formatsAndParsesCustomPattern() {
        LocalDate date = LocalDate.of(2026, 1, 5);
        String formatted = DateUtils.formatDate(date, "dd/MM/yyyy");
        assertEquals("05/01/2026", formatted);
        assertEquals(date, DateUtils.parseDate(formatted, "dd/MM/yyyy"));
    }

    @Test
    void addsDaysAndMonths() {
        LocalDate date = LocalDate.of(2026, 1, 31);
        assertEquals(LocalDate.of(2026, 2, 5), DateUtils.addDays(date, 5));
        assertEquals(LocalDate.of(2026, 2, 28), DateUtils.addMonths(date, 1));
    }

    @Test
    void computesDaysBetween() {
        LocalDate start = LocalDate.of(2026, 1, 1);
        LocalDate end = LocalDate.of(2026, 1, 11);
        assertEquals(10, DateUtils.daysBetween(start, end));
    }

    @Test
    void beforeAndAfterComparisons() {
        LocalDate earlier = LocalDate.of(2026, 1, 1);
        LocalDate later = LocalDate.of(2026, 2, 1);
        assertTrue(DateUtils.isBefore(earlier, later));
        assertTrue(DateUtils.isAfter(later, earlier));
    }

    @Test
    void epochMillisRoundTrip() {
        LocalDateTime dateTime = LocalDateTime.of(2026, 6, 15, 10, 30, 0);
        long epoch = DateUtils.toEpochMillis(dateTime);
        assertEquals(dateTime, DateUtils.fromEpochMillis(epoch));
    }

    @Test
    void timestampForFileNameIsWellFormed() {
        String timestamp = DateUtils.timestampForFileName();
        assertTrue(timestamp.matches("\\d{8}-\\d{6}"), "Expected yyyyMMdd-HHmmss but got: " + timestamp);
    }
}
