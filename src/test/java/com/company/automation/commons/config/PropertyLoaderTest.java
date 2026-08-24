package com.company.automation.commons.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PropertyLoaderTest {

    @AfterEach
    void clearSystemProperty() {
        System.clearProperty("app.name");
    }

    @Test
    void readsValueFromClasspathFile() {
        PropertyLoader loader = PropertyLoader.fromClasspath("test-app.properties");
        assertEquals("referenced-automation-utils", loader.get("app.name"));
    }

    @Test
    void systemPropertyOverridesFileValue() {
        System.setProperty("app.name", "overridden-by-system-property");
        PropertyLoader loader = PropertyLoader.fromClasspath("test-app.properties");
        assertEquals("overridden-by-system-property", loader.get("app.name"));
    }

    @Test
    void returnsDefaultWhenKeyMissing() {
        PropertyLoader loader = PropertyLoader.empty();
        assertEquals("fallback", loader.get("does.not.exist", "fallback"));
    }

    @Test
    void parsesTypedValues() {
        PropertyLoader loader = PropertyLoader.fromClasspath("test-app.properties");
        assertEquals(5, loader.getInt("app.retries", -1));
        assertTrue(loader.getBoolean("app.enabled", false));
    }

    @Test
    void splitsCommaSeparatedListAndTrims() {
        PropertyLoader loader = PropertyLoader.fromClasspath("test-app.properties");
        List<String> tags = loader.getList("app.tags");
        assertEquals(List.of("smoke", "regression", "sanity"), tags);
    }

    @Test
    void containsKeyReflectsResolution() {
        PropertyLoader loader = PropertyLoader.fromClasspath("test-app.properties");
        assertTrue(loader.containsKey("app.name"));
        assertFalse(loader.containsKey("totally.unknown.key"));
    }
}
