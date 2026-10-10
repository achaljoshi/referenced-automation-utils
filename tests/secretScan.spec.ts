import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { governance } from '../src';

const { scanFile, scanDirectory, isPlaceholder } = governance;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
const rules = (text: string, file = 'src/app.ts') => scanFile(file, text).map((f) => f.rule);

// A JWT-shaped string built from three base64url parts (header {"alg":"HS256","typ":"JWT"}, a payload, a signature).
const JWT = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"1234567890","name":"Ada"}').toString('base64url')}.${'x'.repeat(24)}`;

// Every class the scanner must find: [what it is, file, line, rule that must fire]
const POSITIVES: Array<[string, string, string, string]> = [
  ['JSON password', 'config/app.json', '{ "password": "Sup3rS3cret!" }', 'json-secret'],
  ['JSON client secret, nested, single line', 'config/app.json', '{"auth":{"clientSecret":"abcd1234efgh5678"}}', 'json-secret'],
  ['JSON api token', 'fixtures/session.json', '  "access_token": "ya29.a0AfH6SMBx"', 'json-secret'],
  ['YAML password', 'deploy/values.yml', '  password: Sup3rS3cret!', 'unquoted-secret'],
  ['YAML list item token', 'ci/pipeline.yaml', '    - API_TOKEN: abcd1234efgh5678', 'unquoted-secret'],
  ['properties file', 'src/main/resources/app.properties', 'db.password=Sup3rS3cret', 'unquoted-secret'],
  ['shell export', 'scripts/run.sh', 'export CLIENT_SECRET=abcd1234efgh5678', 'unquoted-secret'],
  ['Dockerfile ENV', 'docker/Dockerfile', 'ENV API_KEY=abcdef0123456789', 'unquoted-secret'],
  ['Authorization Bearer header', 'src/client.ts', "headers: { Authorization: 'Bearer abcdef0123456789' }", 'authorization-header'],
  ['curl -H header', 'scripts/call.sh', "curl -H 'Authorization: Bearer abcdef0123456789' https://api.example.test/v1", 'authorization-header'],
  ['Authorization Basic header', 'docs/api.txt', 'Authorization: Basic dXNlcjpTdXAzclMzY3JldA==', 'authorization-header'],
  ['curl -u user:password', 'scripts/call.sh', 'curl -u admin:Sup3rS3cret https://api.example.test', 'curl-credentials'],
  ['JWT in code', 'src/auth.ts', `const session = "${JWT}";`, 'jwt'],
  ['JWT in a JSON fixture', 'fixtures/cookie.json', `{"value": "${JWT}"}`, 'jwt'],
  ['postgres connection string', 'src/db.ts', "const url = 'postgres://app:Sup3rS3cret@db.internal:5432/orders';", 'connection-string'],
  ['mongodb+srv connection string', 'config/mongo.env.ts', 'uri = "mongodb+srv://svc:hunter22pw@cluster0.example.test/db"', 'connection-string'],
  ['ADO-style connection string', 'appsettings.cs', 'Server=db.internal;Database=orders;User Id=sa;Password=Sup3rS3cret;', 'connection-string'],
  ['password in a Gherkin step', 'features/login.feature', '    When I enter the password "Sup3rS3cret!"', 'feature-secret'],
  ['password typed into a field, Gherkin', 'features/login.feature', '    And I type "Sup3rS3cret!" into the password field', 'feature-secret'],
  ['api key in a Gherkin step', 'features/api.feature', "    Given the API key is 'abcd1234efgh5678'", 'feature-secret'],
  ['label then a literal value in a Gherkin step', 'features/login.feature', '    And I fill in "Password" with "Sup3rS3cret!"', 'feature-secret'],
];

// What must NOT be reported: environment reads, templates, filler words and the like - in every one of the same places.
const NEGATIVES: Array<[string, string, string]> = [
  ['JSON placeholder in angle brackets', 'config/app.json', '{ "password": "<your-password>" }'],
  ['JSON env template', 'config/app.json', '{ "token": "${API_TOKEN}" }'],
  ['JSON filler value', 'config/schema.json', '{ "password": "string" }'],
  ['JSON short value', 'config/app.json', '{ "token": "abc" }'],
  ['JSON key that merely contains a word', 'config/app.json', '{ "tokenizer": "whitespace-based-splitter" }'],
  ['YAML env reference', 'deploy/values.yml', '  password: ${DB_PASSWORD}'],
  ['YAML shell variable', 'ci/pipeline.yml', '  NPM_TOKEN: $NPM_TOKEN'],
  ['YAML template', 'deploy/values.yml', "  password: '{{ vault_password }}'"],
  ['YAML Kubernetes secret NAME (key does not end in a secret word)', 'deploy/pod.yml', '  secretName: my-database-credentials'],
  ['YAML token URL', 'deploy/auth.yml', '  tokenUrl: https://login.example.test/oauth/token'],
  ['YAML null', 'deploy/values.yml', '  password: null'],
  ['properties blank', 'app.properties', 'db.password='],
  ['shell reading the environment', 'scripts/run.sh', 'export CLIENT_SECRET=$CLIENT_SECRET'],
  ['Bearer with a template', 'src/client.ts', 'headers: { Authorization: `Bearer ${token}` }'],
  ['Bearer with a placeholder', 'docs/api.txt', 'Authorization: Bearer <your-token>'],
  ['Bearer with a short word', 'docs/api.txt', 'Authorization: Bearer token'],
  ['curl -u with an env variable', 'scripts/call.sh', 'curl -u "$USER:$PASSWORD" https://api.example.test'],
  ['connection string with an env variable', 'src/db.ts', "const url = 'postgres://app:${DB_PASSWORD}@db.internal/orders';"],
  ['connection string with a doc placeholder', 'docs/db.txt', 'postgres://user:password@localhost:5432/mydb'],
  ['ADO connection string, placeholder password', 'appsettings.cs', 'Server=db;Database=x;Password=your-password;'],
  ['Gherkin with {{env:...}}', 'features/login.feature', '    When I enter the password "{{env:SAP_PASSWORD}}"'],
  ['Gherkin scenario outline column', 'features/login.feature', '    When I enter the password "<password>"'],
  ['Gherkin masked value', 'features/login.feature', '    When I enter the password "********"'],
  ['Gherkin deliberately wrong password', 'features/login.feature', '    When I enter the password "wrong-password-1"'],
  ['Gherkin label then an {{env}} value', 'features/login.feature', '    And I fill in "Password" with "{{env:UI_PASSWORD}}"'],
  ['Gherkin label, a scenario-outline value and the word password inside it', 'features/login.feature', '    And I fill in "Password" with "<password>"'],
  ['Gherkin negative control: a deliberately wrong password', 'features/login.feature', '    And I fill in "Password" with "not-the-password"'],
  ['Gherkin label then an empty expected value', 'features/login.feature', '    And the field "Password" has value ""'],
  ['package.json bin entry named like a secret', 'package.json', '    "sap-gui-secret": "./dist/cli/secret.js",'],
  ['an environment variable NAME as the value', 'src/redact.ts', "const rule = { name: 'BEARER_TOKEN', token: 'BEARER_TOKEN' };"],
  ['Gherkin without a literal', 'features/login.feature', '    Then I see the password field'],
  ['a JWT-looking but too short string', 'src/auth.ts', 'const t = "eyJ.eyJ.x";'],
];

test.describe('secret scan: every class of leak is found, placeholders are not', () => {
  for (const [what, file, line, rule] of POSITIVES)
    test(`finds: ${what}`, () => {
      expect(rules(line, file), `${file}: ${line}`).toContain(rule);
    });

  for (const [what, file, line] of NEGATIVES)
    test(`ignores: ${what}`, () => {
      expect(rules(line, file), `${file}: ${line}`).toEqual([]);
    });
});

test.describe('secret scan: the placeholder test is anchored', () => {
  test('a value that merely STARTS like a placeholder is still a secret (true/null/</example prefixes)', () => {
    for (const secret of ['trueblue-Zk39sQ81', 'nullable-9f2aX7Qp', 'falsetto-Jp82kL0m', 'undefinedBehaviour9X', 'examplePassw0rd!', 'Xx9<Zk39sQ81', 'nonexistent-Qp82kL0']) {
      expect(isPlaceholder(secret), secret).toBe(false);
      expect(rules(`const password = "${secret}";`), secret).toContain('password-assignment');
    }
  });

  test('...and real placeholders are still skipped, whole or by leading word', () => {
    for (const value of ['', 'dist/cli/secret.js', './bin/tool', 'BEARER_TOKEN', 'true', 'false', 'null', 'undefined', '<secret>', '${VAR}', '$(cat file)', '%TOKEN%', '{{ x }}', '********', 'changeme', 'changeme-please', 'change-me', 'example', 'example.com', 'placeholder-value', 'your-api-key', 'your_token_here', 'replace-me', 'TODO-set-me', 'xxxxxxxx', 'process.env.TOKEN', 'dummy']) {
      expect(isPlaceholder(value), value).toBe(true);
    }
  });
});

test.describe('secret scan: output never shows a secret', () => {
  test('EVERY occurrence of a secret in a line is masked, not just the first', () => {
    const line = 'const password = "hunter2-very-secret"; // retry with "hunter2-very-secret" or hunter2-very-secret';
    const [finding] = scanFile('x.ts', line);
    expect(finding?.rule).toBe('password-assignment');
    expect(finding?.excerpt).not.toContain('hunter2-very-secret');
    expect(finding?.excerpt.match(/hu\*\*\*/g)).toHaveLength(3);
  });

  test('a line with two different secrets masks both in every finding for it, whichever rule reported it', () => {
    const line = '{"password": "Sup3rS3cret!", "clientSecret": "abcd1234efgh5678", "url": "postgres://app:Qw3rtyPass@db/x"}';
    const findings = scanFile('config/app.json', line);
    expect(findings.map((f) => f.rule).sort()).toEqual(['connection-string', 'json-secret']);
    for (const f of findings) {
      for (const secret of ['Sup3rS3cret!', 'abcd1234efgh5678', 'Qw3rtyPass']) expect(f.excerpt, `${f.rule} excerpt`).not.toContain(secret);
    }
  });

  test('a short secret is fully masked (no prefix leaks)', () => {
    const [finding] = scanFile('config/app.json', '{"password": "abc123"}');
    expect(finding?.excerpt).toBe('{"password": "***"}');
  });

  test('the CLI output for a leak with repeated secrets contains none of them, and reports what was not scanned', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'app.json'), '{ "password": "do-not-print-me-9", "again": "do-not-print-me-9" }\n');
    fs.writeFileSync(path.join(dir, 'a.feature'), 'When I enter the password "feature-leak-77"\n');
    const run = spawnSync('node', [path.resolve(__dirname, '../dist/cli/scanSecrets.js'), '--dir', dir], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    const output = run.stdout + run.stderr;
    expect(output).not.toContain('do-not-print-me-9');
    expect(output).not.toContain('feature-leak-77');
    expect(output).toContain('app.json:1  json-secret');
    expect(output).toContain('a.feature:1  feature-secret');
    expect(output).toMatch(/not scanned: \d+ in generated directories, \d+ binary, \d+ over 1 MB, \d+ unreadable/);
  });
});

test.describe('secret scan: generated directories do not exempt tracked files', () => {
  const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

  test('a TRACKED file under node_modules/ or logs/ is scanned (the secret is in the history); an untracked one is skipped and counted', () => {
    const dir = tmp();
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/leak.js'), 'const password = "committed-secret-1";\n');
    fs.writeFileSync(path.join(dir, 'logs/run.log'), 'token: "abcdefgh12345678"\n');
    fs.writeFileSync(path.join(dir, 'dist/generated.js'), 'const password = "generated-secret-2";\n');
    git(dir, 'add', '-f', 'node_modules/pkg/leak.js'); // committed despite the directory name

    const result = scanDirectory(dir);
    expect(result.findings.map((f) => f.file)).toEqual(['node_modules/pkg/leak.js']);
    expect(result.skipped.generated).toBe(2); // logs/run.log and dist/generated.js: untracked, in generated directories
  });

  test('without git, generated directories are not entered, and their files are counted as skipped', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/x/leak.js'), 'password = "should-be-skipped-1"');
    fs.writeFileSync(path.join(dir, 'node_modules/x/other.js'), 'nothing');
    fs.writeFileSync(path.join(dir, 'ok.ts'), 'const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    fs.writeFileSync(path.join(dir, 'huge.txt'), 'a'.repeat(1_000_001));
    const result = scanDirectory(dir);
    expect(result.findings).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(result.skipped).toEqual({ generated: 2, binary: 1, tooLarge: 1, unreadable: 0 });
  });
});
