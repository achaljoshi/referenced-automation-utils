package com.company.automation.commons.json;

import com.company.automation.commons.exceptions.CommonsException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * JSON (de)serialization helpers shared across the whole family - most
 * commonly used by {@code referenced-automation-api} for request/response
 * payload handling, and by any framework reading JSON test-data fixtures.
 */
public final class JsonUtils {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private JsonUtils() {
    }

    /** Exposes the shared, pre-configured {@link ObjectMapper} for advanced/custom use. */
    public static ObjectMapper mapper() {
        return MAPPER;
    }

    public static String toJson(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new CommonsException("Failed to serialize object to JSON", e);
        }
    }

    public static String toPrettyJson(Object value) {
        try {
            return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new CommonsException("Failed to serialize object to pretty JSON", e);
        }
    }

    public static <T> T fromJson(String json, Class<T> type) {
        try {
            return MAPPER.readValue(json, type);
        } catch (IOException e) {
            throw new CommonsException("Failed to deserialize JSON to " + type.getSimpleName(), e);
        }
    }

    public static <T> T fromJson(String json, TypeReference<T> typeReference) {
        try {
            return MAPPER.readValue(json, typeReference);
        } catch (IOException e) {
            throw new CommonsException("Failed to deserialize JSON", e);
        }
    }

    public static <T> T fromJsonFile(File file, Class<T> type) {
        try {
            return MAPPER.readValue(file, type);
        } catch (IOException e) {
            throw new CommonsException("Failed to read/parse JSON file: " + file, e);
        }
    }

    /** Parses JSON into a generic {@code Map<String, Object>} - handy when no POJO exists yet. */
    public static Map<String, Object> toMap(String json) {
        return fromJson(json, new TypeReference<Map<String, Object>>() {
        });
    }

    public static List<Map<String, Object>> toListOfMaps(String json) {
        return fromJson(json, new TypeReference<List<Map<String, Object>>>() {
        });
    }

    /** Parses JSON into a navigable, schema-free {@link JsonNode} tree - useful for partial assertions. */
    public static JsonNode toJsonNode(String json) {
        try {
            return MAPPER.readTree(json);
        } catch (IOException e) {
            throw new CommonsException("Failed to parse JSON into a tree", e);
        }
    }

    /** Reads a single value at a JSON Pointer path, e.g. {@code readAt(json, "/data/id")}. Returns null if absent. */
    public static JsonNode readAt(String json, String jsonPointer) {
        JsonNode node = toJsonNode(json).at(jsonPointer);
        return node.isMissingNode() ? null : node;
    }
}
