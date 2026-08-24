package com.company.automation.commons.json;

import com.company.automation.commons.exceptions.CommonsException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.io.File;
import java.io.IOException;
import java.util.Map;

/**
 * YAML (de)serialization helpers, built the same way as {@link JsonUtils} but
 * backed by a YAML-flavoured {@link ObjectMapper}. Handy for reading
 * environment/test-data config files written in YAML instead of properties/JSON.
 */
public final class YamlUtils {

    private static final ObjectMapper MAPPER = new ObjectMapper(new YAMLFactory())
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private YamlUtils() {
    }

    public static ObjectMapper mapper() {
        return MAPPER;
    }

    public static String toYaml(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (IOException e) {
            throw new CommonsException("Failed to serialize object to YAML", e);
        }
    }

    public static <T> T fromYaml(String yaml, Class<T> type) {
        try {
            return MAPPER.readValue(yaml, type);
        } catch (IOException e) {
            throw new CommonsException("Failed to deserialize YAML to " + type.getSimpleName(), e);
        }
    }

    public static <T> T fromYamlFile(File file, Class<T> type) {
        try {
            return MAPPER.readValue(file, type);
        } catch (IOException e) {
            throw new CommonsException("Failed to read/parse YAML file: " + file, e);
        }
    }

    public static Map<String, Object> toMap(String yaml) {
        return fromYaml(yaml, Map.class);
    }
}
