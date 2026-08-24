# referenced-automation-utils

Shared, framework-agnostic commons library for the **referenced-automation-\*** family:

| Repository | Depends on this library for |
|---|---|
| [referenced-automation-ui](https://github.com/achaljoshi/referenced-automation-ui) | test data, config loading, JSON/YAML fixtures |
| [referenced-automation-api](https://github.com/achaljoshi/referenced-automation-api) | JSON helpers, test data, crypto (request signing) |
| [referenced-automation-sap](https://github.com/achaljoshi/referenced-automation-sap) | Excel/CSV test data, DB verification, config loading |
| [referenced-automation-ui-api](https://github.com/achaljoshi/referenced-automation-ui-api) | everything above, transitively via ui + api |

It ships **no** Selenium, Playwright, Cucumber, or reporting code - just the
plumbing every automation framework ends up re-writing badly. Add it as a
Maven dependency from Nexus exactly like any third-party library:

```xml
<dependency>
    <groupId>com.company.automation</groupId>
    <artifactId>referenced-automation-utils</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

## What's inside

All classes live under `com.company.automation.commons` - a package
deliberately distinct from `com.company.automation.utils` (used internally by
`referenced-automation-ui`) so that a project depending on both this library
*and* `referenced-automation-ui` never hits a split-package/class-shadowing
surprise on its classpath.

| Package | Class | Purpose |
|---|---|---|
| `commons.excel` | `ExcelUtils` | Read/write `.xlsx` sheets as `List<Map<String,String>>` or raw rows (Apache POI) |
| `commons.csv` | `CsvUtils` | Read/write CSV as maps or raw rows (opencsv) |
| `commons.json` | `JsonUtils` | JSON (de)serialization, generic map/tree parsing, JSON Pointer lookups (Jackson) |
| `commons.json` | `YamlUtils` | YAML (de)serialization, mirrors `JsonUtils` (Jackson + YAML) |
| `commons.date` | `DateUtils` | `java.time`-based formatting, parsing, arithmetic, epoch conversions |
| `commons.random` | `RandomDataUtils` | Synthetic test data - names, emails, addresses, UUIDs, numbers (DataFaker) |
| `commons.db` | `DatabaseUtils` | JDBC query/update helpers returning `List<Map<String,Object>>` (commons-dbutils) - **bring your own JDBC driver** |
| `commons.email` | `EmailUtils` | Send over SMTP, search an IMAP inbox by subject (Jakarta Mail / Angus) |
| `commons.crypto` | `CryptoUtils` | MD5/SHA-1/SHA-256/SHA-512 digests, HMAC signing, Base64, PII masking |
| `commons.config` | `PropertyLoader` | Generic `.properties` loader: system property > env var > file, typed getters |
| `commons.exceptions` | `CommonsException` | Single unchecked exception every utility throws, so call sites stay `throws`-free |

## Why a shared library, and why these boundaries

- **No logging backend, on purpose.** This library depends only on
  `slf4j-api` - it never ships a `log4j2.xml` or pulls in `log4j-core`/
  `log4j-slf4j2-impl` at compile scope. A shared jar that bundles its own
  logging configuration causes "multiple `log4j2.xml` on the classpath"
  warnings (and unpredictable *which one wins* behaviour) the moment two
  libraries that both ship one are combined - which is exactly what happens
  in `referenced-automation-sap` and `referenced-automation-ui-api`, which
  pull in this library *alongside* `referenced-automation-ui`/`-api`. The
  **terminal** framework (ui, api, sap, ui-api) is the only place a
  `log4j2.xml` and a concrete logging backend belong.
- **No JDBC driver bundled.** `DatabaseUtils` works against any JDBC 4+
  driver, but which database an organisation runs (Oracle, Postgres, MySQL,
  MSSQL, ...) is a per-project choice - add the driver you need in the
  consuming project's own `pom.xml`.
- **No Selenium/Playwright/Cucumber.** Keeping this library UI- and
  test-runner-agnostic means it can be reused unchanged even if a future
  framework in this family targets something other than Playwright.

## Building

```bash
./mvnw clean test      # compile + run the unit test suite
./mvnw clean install   # ...and install into your local ~/.m2 for use by a sibling repo
```

`DatabaseUtilsTest` runs against a real in-memory H2 database (test scope
only - never shipped in the published jar) rather than a mocked
`java.sql.Connection`, so the SQL/parameter-binding path is actually
exercised, not just the mock's configured behaviour.

> This library was authored and statically verified without a working
> Maven Central connection in the build sandbox (see the top-level
> `referenced-automation-ui` README for the full explanation). Every
> third-party API used here (POI, opencsv, Jackson, DataFaker, commons-dbutils,
> Jakarta Mail, commons-codec) was checked against its official documentation.
> Please run `./mvnw clean test` yourself (or let CI do it) before relying on
> a release build.

## IntelliJ setup

Open the project root in IntelliJ - the checked-in `.idea/` directory already
configures:

- Project SDK: Java 17
- Git as the VCS root
- Two ready-to-run Maven run configurations: **Maven: clean test** and
  **Maven: clean install**

No Cucumber/Gherkin plugin is required for this repository (there are no
`.feature` files here), so nothing else needs to be installed - just open and
run.

## Using the Maven Wrapper

No local Maven install is required:

```bash
./mvnw clean test        # macOS/Linux
mvnw.cmd clean test       # Windows
```

## Publishing to Nexus

Same convention as every repo in this family - see `settings.xml.sample` for
local publishing, and `.gitlab-ci.yml`/`.github/workflows/ci.yml` for how CI
publishes automatically from protected secrets (`NEXUS_USER`, `NEXUS_PASS`,
`NEXUS_RELEASE_URL`, `NEXUS_SNAPSHOT_URL`) on the default branch and on tags.

## CI/CD

Both pipelines run the same three stages and are kept functionally identical:

- **`.gitlab-ci.yml`** - GitLab CI, `maven:3.9-eclipse-temurin-17` image.
- **`.github/workflows/ci.yml`** - GitHub Actions, `actions/setup-java@v4` (Temurin 17).

`build` compiles main + test sources, `test` runs the JUnit 5 suite and
publishes a JUnit XML report, `deploy` runs `mvn -DskipTests deploy` to Nexus
on the default branch or a tag. There is no retry stage here (unlike the
Cucumber-based repos in this family) - flaky unit tests should be fixed, not
retried.
