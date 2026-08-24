package com.company.automation.commons.json;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class JsonUtilsTest {

    record Person(String name, int age) {
    }

    @Test
    void serializesAndDeserializesPojo() {
        Person person = new Person("Ada", 30);
        String json = JsonUtils.toJson(person);
        Person roundTripped = JsonUtils.fromJson(json, Person.class);
        assertEquals(person, roundTripped);
    }

    @Test
    void parsesJsonIntoGenericMap() {
        Map<String, Object> map = JsonUtils.toMap("{\"id\": 1, \"name\": \"test\"}");
        assertEquals(1, map.get("id"));
        assertEquals("test", map.get("name"));
    }

    @Test
    void parsesJsonArrayIntoListOfMaps() {
        List<Map<String, Object>> list = JsonUtils.toListOfMaps("[{\"id\":1},{\"id\":2}]");
        assertEquals(2, list.size());
        assertEquals(1, list.get(0).get("id"));
    }

    @Test
    void readsValueAtJsonPointer() {
        String json = "{\"data\": {\"id\": \"abc-123\"}}";
        JsonNode node = JsonUtils.readAt(json, "/data/id");
        assertNotNull(node);
        assertEquals("abc-123", node.asText());
    }

    @Test
    void readAtReturnsNullForMissingPath() {
        assertNull(JsonUtils.readAt("{\"data\": {}}", "/data/missing"));
    }

    @Test
    void deserializationIgnoresUnknownProperties() {
        String json = "{\"name\":\"Ada\",\"age\":30,\"extra\":\"ignored\"}";
        Person person = JsonUtils.fromJson(json, Person.class);
        assertEquals(new Person("Ada", 30), person);
    }
}
