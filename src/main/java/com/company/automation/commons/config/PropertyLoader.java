package com.company.automation.commons.config;

import com.company.automation.commons.exceptions.CommonsException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Generic, framework-agnostic {@code .properties} loader shared by every
 * consumer of this library (referenced-automation-ui, -api, -sap, -ui-api).
 * It is intentionally NOT aware of any framework-specific keys (browser,
 * baseUrl, etc.) - each consuming framework owns its own typed config reader
 * built on top of this class, the same way {@code referenced-automation-ui}'s
 * {@code ConfigReader} does.
 *
 * <p>Resolution order for every key, highest priority first:
 * <ol>
 *   <li>JVM system property ({@code -Dkey=value})</li>
 *   <li>Environment variable (key upper-cased, {@code .} and {@code -} replaced with {@code _})</li>
 *   <li>The loaded {@code .properties} file(s)</li>
 * </ol>
 *
 * <p>Multiple property files can be loaded into the same instance; later
 * loads override earlier ones for duplicate keys, which is useful for a
 * {@code base.properties} + {@code <env>.properties} overlay pattern.
 */
public final class PropertyLoader {

    private final Properties properties = new Properties();
    private static final ConcurrentHashMap<String, PropertyLoader> CLASSPATH_CACHE = new ConcurrentHashMap<>();

    private PropertyLoader() {
    }

    /**
     * Loads a {@code .properties} file from the classpath (e.g. {@code "config/db.properties"}).
     * Repeated calls for the same resource name return a cached, already-loaded instance.
     */
    public static PropertyLoader fromClasspath(String resourceName) {
        return CLASSPATH_CACHE.computeIfAbsent(resourceName, name -> {
            PropertyLoader loader = new PropertyLoader();
            loader.mergeClasspath(name);
            return loader;
        });
    }

    /** Loads a {@code .properties} file from an absolute or relative filesystem path. */
    public static PropertyLoader fromFile(String path) {
        PropertyLoader loader = new PropertyLoader();
        loader.mergeFile(path);
        return loader;
    }

    /** Starts from an empty, unbacked property set - useful when only system properties/env vars matter. */
    public static PropertyLoader empty() {
        return new PropertyLoader();
    }

    /** Merges another classpath resource on top of what is already loaded (later keys win). */
    public PropertyLoader mergeClasspath(String resourceName) {
        try (InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(resourceName)) {
            if (in == null) {
                throw new CommonsException("Classpath resource not found: " + resourceName);
            }
            properties.load(in);
            return this;
        } catch (IOException e) {
            throw new CommonsException("Failed to read classpath resource: " + resourceName, e);
        }
    }

    /** Merges another file on top of what is already loaded (later keys win). Silently skips a missing file. */
    public PropertyLoader mergeFile(String path) {
        Path file = Path.of(path);
        if (!Files.exists(file)) {
            return this;
        }
        try (InputStream in = Files.newInputStream(file)) {
            properties.load(in);
            return this;
        } catch (IOException e) {
            throw new CommonsException("Failed to read properties file: " + path, e);
        }
    }

    public String get(String key) {
        String systemProp = System.getProperty(key);
        if (systemProp != null && !systemProp.isBlank()) {
            return systemProp;
        }
        String envVar = System.getenv(toEnvVarName(key));
        if (envVar != null && !envVar.isBlank()) {
            return envVar;
        }
        return properties.getProperty(key);
    }

    public String get(String key, String defaultValue) {
        String value = get(key);
        return value != null ? value : defaultValue;
    }

    public int getInt(String key, int defaultValue) {
        String value = get(key);
        return value != null ? Integer.parseInt(value.trim()) : defaultValue;
    }

    public long getLong(String key, long defaultValue) {
        String value = get(key);
        return value != null ? Long.parseLong(value.trim()) : defaultValue;
    }

    public boolean getBoolean(String key, boolean defaultValue) {
        String value = get(key);
        return value != null ? Boolean.parseBoolean(value.trim()) : defaultValue;
    }

    /** Splits a comma-separated value into a trimmed list of strings; empty/missing returns an empty list. */
    public List<String> getList(String key) {
        String value = get(key);
        if (value == null || value.isBlank()) {
            return List.of();
        }
        return Arrays.stream(value.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toList());
    }

    public boolean containsKey(String key) {
        return get(key) != null;
    }

    private static String toEnvVarName(String key) {
        return key.toUpperCase().replace('.', '_').replace('-', '_');
    }
}
