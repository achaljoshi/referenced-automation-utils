package com.company.automation.commons.json;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class YamlUtilsTest {

    record Environment(String baseUrl, int timeoutSeconds) {
    }

    @Test
    void serializesAndDeserializesPojo() {
        Environment env = new Environment("https://example.com", 30);
        String yaml = YamlUtils.toYaml(env);
        Environment roundTripped = YamlUtils.fromYaml(yaml, Environment.class);
        assertEquals(env, roundTripped);
    }

    @Test
    void parsesYamlIntoGenericMap() {
        String yaml = "name: test\ncount: 3\n";
        Map<String, Object> map = YamlUtils.toMap(yaml);
        assertEquals("test", map.get("name"));
        assertEquals(3, map.get("count"));
    }
}
