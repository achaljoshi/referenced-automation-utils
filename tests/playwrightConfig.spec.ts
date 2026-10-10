import { test, expect } from '@playwright/test';
import * as os from 'node:os';
import { createPlaywrightConfig } from '../src/playwright/config';

// An empty directory: no .env files, so only the env vars each test sets matter.
const dir = os.tmpdir();

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const clean = { BROWSER: undefined, DEVICE: undefined, CI: undefined, RETRIES: undefined, WORKERS: undefined };

test.describe('createPlaywrightConfig', () => {
  test('defaults to a single chromium project, headless, no retries locally', () => {
    const config = withEnv(clean, () => createPlaywrightConfig({ dir, allure: false }));
    expect(config.projects?.map((p) => p.name)).toEqual(['chromium']);
    expect(config.use?.headless).toBe(true);
    expect(config.retries).toBe(0);
    expect(config.fullyParallel).toBe(true);
  });

  test('BROWSER selects exactly that engine - firefox/webkit are not silently swapped for chromium', () => {
    for (const browser of ['firefox', 'webkit', 'msedge']) {
      const config = withEnv({ ...clean, BROWSER: browser }, () => createPlaywrightConfig({ dir, allure: false }));
      expect(config.projects?.map((p) => p.name)).toEqual([browser]);
    }
  });

  test('BROWSER=all selects the three bundled browsers; all-devices selects the device presets', () => {
    expect(
      withEnv({ ...clean, BROWSER: 'all' }, () => createPlaywrightConfig({ dir, allure: false })).projects?.map((p) => p.name),
    ).toEqual(['chromium', 'firefox', 'webkit']);
    expect(
      withEnv({ ...clean, BROWSER: 'all-devices' }, () => createPlaywrightConfig({ dir, allure: false })).projects?.map((p) => p.name),
    ).toEqual(['iPhone 15', 'Pixel 7', 'iPad Pro 11']);
  });

  test('DEVICE overrides BROWSER', () => {
    const config = withEnv({ ...clean, BROWSER: 'firefox', DEVICE: 'Pixel 7' }, () => createPlaywrightConfig({ dir, allure: false }));
    expect(config.projects?.map((p) => p.name)).toEqual(['Pixel 7']);
  });

  test('an unknown BROWSER or DEVICE fails loudly with guidance, instead of selecting no projects', () => {
    expect(() => withEnv({ ...clean, BROWSER: 'netscape' }, () => createPlaywrightConfig({ dir, allure: false }))).toThrow(
      /Unknown BROWSER "netscape".*chromium, firefox, webkit/,
    );
    expect(() => withEnv({ ...clean, DEVICE: 'Nokia 3310' }, () => createPlaywrightConfig({ dir, allure: false }))).toThrow(
      /Unknown Playwright device "Nokia 3310"/,
    );
  });

  test('retries default to 0 locally and to retriesOnCi in CI; RETRIES wins over both', () => {
    expect(withEnv({ ...clean, CI: '1' }, () => createPlaywrightConfig({ dir, allure: false })).retries).toBe(1);
    expect(withEnv({ ...clean, CI: '1' }, () => createPlaywrightConfig({ dir, allure: false, retriesOnCi: 2 })).retries).toBe(2);
    expect(withEnv({ ...clean, CI: '1', RETRIES: '5' }, () => createPlaywrightConfig({ dir, allure: false })).retries).toBe(5);
  });

  test('baseUrlKey picks which env var supplies baseURL', () => {
    const config = withEnv({ ...clean, API_BASE_URL: 'https://api.example.test', BASE_URL: 'https://ui.example.test' }, () =>
      createPlaywrightConfig({ dir, allure: false, baseUrlKey: 'API_BASE_URL' }),
    );
    expect(config.use?.baseURL).toBe('https://api.example.test');
  });

  test('auth adds a setup project that every browser project depends on, and applies the storageState to them but not to setup', () => {
    const config = withEnv(clean, () =>
      createPlaywrightConfig({ dir, allure: false, auth: { setupMatch: /auth\.setup\.ts/, storageState: '.auth/user.json' } }),
    );
    const [setup, browser] = config.projects ?? [];
    expect(setup?.name).toBe('setup');
    expect(setup?.use?.storageState).toBeUndefined();
    expect(browser?.dependencies).toEqual(['setup']);
    expect(browser?.use?.storageState).toBe('.auth/user.json');
    expect(browser?.testIgnore).toEqual(/auth\.setup\.ts/);
  });

  test('always includes list, html, junit and json reporters; allure only when asked for and installed', () => {
    const names = (config: ReturnType<typeof createPlaywrightConfig>) => (config.reporter as unknown as [string, ...unknown[]][]).map((r) => r[0]);
    expect(names(withEnv(clean, () => createPlaywrightConfig({ dir, allure: false })))).toEqual(['list', 'html', 'junit', 'json']);
    // The os.tmpdir() dir has no allure-playwright to resolve from, so it is skipped rather than crashing.
    expect(names(withEnv(clean, () => createPlaywrightConfig({ dir })))).toEqual(['list', 'html', 'junit', 'json']);
  });

  test('an extra project that chooses no browser inherits the selected BROWSER project (a firefox leg runs BDD in firefox)', () => {
    const bdd = { name: 'bdd', testDir: 'features-gen', use: { actionTimeout: 1234 } };
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      const config = withEnv({ ...clean, BROWSER: browser }, () => createPlaywrightConfig({ dir, allure: false, extraProjects: [bdd] }));
      const extra = config.projects?.find((p) => p.name === 'bdd');
      const selected = config.projects?.find((p) => p.name === browser);
      expect(extra?.use?.defaultBrowserType).toBe(browser);
      expect(extra?.use?.defaultBrowserType).toBe(selected?.use?.defaultBrowserType);
      expect(extra?.use?.actionTimeout).toBe(1234); // its own settings still win
    }
    const edge = withEnv({ ...clean, BROWSER: 'msedge' }, () => createPlaywrightConfig({ dir, allure: false, extraProjects: [bdd] }));
    expect(edge.projects?.find((p) => p.name === 'bdd')?.use?.channel).toBe('msedge');
  });

  test('an extra project that names its own browser keeps it, and does not inherit storageState from auth', () => {
    const own = { name: 'own', use: { browserName: 'webkit' as const } };
    const config = withEnv({ ...clean, BROWSER: 'firefox' }, () =>
      createPlaywrightConfig({ dir, allure: false, extraProjects: [own, { name: 'bdd' }], auth: { setupMatch: /auth\.setup\.ts/, storageState: '.auth/user.json' } }),
    );
    expect(config.projects?.find((p) => p.name === 'own')?.use).toEqual({ browserName: 'webkit' });
    const bdd = config.projects?.find((p) => p.name === 'bdd');
    expect(bdd?.use?.defaultBrowserType).toBe('firefox');
    expect(bdd?.use?.storageState).toBeUndefined();
  });

  test('maxWorkers caps WORKERS (a SAP suite passes 1), by number, percentage and default; without it WORKERS passes through', () => {
    const workers = (env: Record<string, string | undefined>, maxWorkers?: number) =>
      withEnv({ ...clean, ...env }, () => createPlaywrightConfig({ dir, allure: false, maxWorkers })).workers;
    expect(workers({ WORKERS: '8' }, 1)).toBe(1);
    expect(workers({ WORKERS: '100%' }, 1)).toBe(1);
    expect(workers({ WORKERS: undefined }, 1)).toBe(1);
    expect(workers({ WORKERS: '2' }, 4)).toBe(2);
    expect(workers({ WORKERS: '8' }, 4)).toBe(4);
    expect(workers({ WORKERS: '8' })).toBe('8');
    expect(() => workers({ WORKERS: 'lots' }, 1)).toThrow(/WORKERS "lots"/);
    expect(() => workers({}, 0)).toThrow(/maxWorkers/);
  });

  test('fullyParallel defaults to true and can be turned off', () => {
    expect(withEnv(clean, () => createPlaywrightConfig({ dir, allure: false, fullyParallel: false })).fullyParallel).toBe(false);
    expect(withEnv(clean, () => createPlaywrightConfig({ dir, allure: false })).fullyParallel).toBe(true);
  });

  test('overrides are merged last', () => {
    const config = withEnv(clean, () => createPlaywrightConfig({ dir, allure: false, overrides: { timeout: 1234 } }));
    expect(config.timeout).toBe(1234);
  });
});
