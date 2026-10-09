import type { PlaywrightTestConfig, Project } from '@playwright/test';
import { loadEnv } from '../config/env';

export interface CreatePlaywrightConfigOptions {
  /** Directory the .env.<ENV> files live in - pass `__dirname` from the repo's playwright.config.ts so the same file is picked up no matter where the test process was started from (terminal, IDE "Run" button, CI). */
  dir: string;
  /** Shown in the report's metadata, e.g. '@automation/my-project'. */
  name?: string;
  testDir?: string;
  /** Which env key holds this suite's base URL. 'BASE_URL' for UI suites, 'API_BASE_URL' for API suites. */
  baseUrlKey?: string;
  /** Default per-test timeout when TEST_TIMEOUT_MS isn't set. */
  testTimeoutMs?: number;
  /** Default retries on CI when RETRIES isn't set (local default is always 0). */
  retriesOnCi?: number;
  /**
   * Log in once, reuse everywhere. Adds a `setup` project that runs the
   * matching spec(s) first (they save a storageState file), and makes every
   * browser project depend on it and start already authenticated - the
   * Playwright-recommended alternative to logging in through the UI in every test.
   */
  auth?: { setupMatch: string | RegExp; storageState: string };
  /** Include the Allure reporter. On by default; skipped automatically if `allure-playwright` isn't installed. */
  allure?: boolean;
  /** Extra projects appended after the BROWSER/DEVICE-selected ones. */
  extraProjects?: Project[];
  /** Shallow-merged over the result last - an escape hatch, not the normal path. */
  overrides?: Partial<PlaywrightTestConfig>;
}

const SYSTEM_BROWSER_CHANNELS = ['msedge', 'msedge-beta', 'msedge-dev', 'chrome', 'chrome-beta', 'chrome-dev'];
const DEFAULT_DEVICE_PROJECT_NAMES = ['iPhone 15', 'Pixel 7', 'iPad Pro 11'];

function allureInstalled(dir: string): boolean {
  try {
    require.resolve('allure-playwright', { paths: [dir] });
    return true;
  } catch {
    return false;
  }
}

/**
 * One place to define how every repo in the family runs Playwright, so the
 * five copies of playwright.config.ts can't drift apart (they already did
 * once: one repo's BROWSER=firefox silently ran chromium).
 *
 * Everything is driven by the active .env.<ENV> file or a real environment
 * variable, so a CI job, an IDE run and a terminal run all behave the same:
 *
 *   BROWSER   chromium | firefox | webkit | msedge | chrome | ... | all | all-devices
 *   DEVICE    any Playwright device name, e.g. "iPhone 15" (overrides BROWSER)
 *   HEADLESS, WORKERS, RETRIES, MAX_FAILURES, SLOW_MO_MS
 *   TEST_TIMEOUT_MS, EXPECT_TIMEOUT_MS, ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS, GLOBAL_TIMEOUT_MS
 *   LOCALE, TIMEZONE_ID, COLOR_SCHEME, IGNORE_HTTPS_ERRORS, VIEWPORT_WIDTH, VIEWPORT_HEIGHT
 *   TEST_ID_ATTRIBUTE (default data-testid), <baseUrlKey>
 *
 * An unrecognised BROWSER/DEVICE value fails immediately with the list of
 * valid names, rather than silently selecting no projects and reporting
 * "no tests found".
 */
export function createPlaywrightConfig(options: CreatePlaywrightConfigOptions): PlaywrightTestConfig {
  // Lazy: importing this package must not require Playwright to be loadable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { devices } = require('@playwright/test') as typeof import('@playwright/test');
  const env = loadEnv({ dir: options.dir });

  const requestedBrowser = env.get('BROWSER', 'chromium');
  const requestedDevice = env.getOptional('DEVICE');

  const testTimeoutMs = env.getInt('TEST_TIMEOUT_MS', options.testTimeoutMs ?? 30_000);
  const expectTimeoutMs = env.getInt('EXPECT_TIMEOUT_MS', 10_000);
  const actionTimeoutMs = env.getInt('ACTION_TIMEOUT_MS', 15_000);
  const navigationTimeoutMs = env.getInt('NAVIGATION_TIMEOUT_MS', 30_000);
  const globalTimeoutMs = env.getInt('GLOBAL_TIMEOUT_MS', 0);
  const retries = env.getInt('RETRIES', process.env.CI ? (options.retriesOnCi ?? 1) : 0);
  const maxFailures = env.getInt('MAX_FAILURES', 0);
  const slowMoMs = env.getInt('SLOW_MO_MS', 0);
  const viewport = { width: env.getInt('VIEWPORT_WIDTH', 1280), height: env.getInt('VIEWPORT_HEIGHT', 800) };

  const desktopProjects: Project[] = [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport } },
    ...SYSTEM_BROWSER_CHANNELS.map((channel) => ({
      name: channel,
      use: { ...devices['Desktop Chrome'], viewport, channel },
    })),
  ];

  const deviceNames = requestedDevice ? [requestedDevice] : DEFAULT_DEVICE_PROJECT_NAMES;
  const unknownDevices = deviceNames.filter((name) => !devices[name]);
  if (requestedDevice && unknownDevices.length > 0) {
    throw new Error(
      `Unknown Playwright device "${requestedDevice}". Valid names include: ${Object.keys(devices).slice(0, 12).join(', ')}, ...`,
    );
  }
  const deviceProjects: Project[] = deviceNames
    .filter((name) => devices[name])
    .map((name) => ({ name, use: { ...devices[name] } }));

  let browserProjects: Project[];
  if (requestedDevice || requestedBrowser === 'all-devices') {
    browserProjects = deviceProjects;
  } else if (requestedBrowser === 'all') {
    browserProjects = desktopProjects.slice(0, 3);
  } else {
    browserProjects = desktopProjects.filter((project) => project.name === requestedBrowser);
    if (browserProjects.length === 0) {
      throw new Error(
        `Unknown BROWSER "${requestedBrowser}". Use one of: ${desktopProjects.map((p) => p.name).join(', ')}, all, all-devices (or set DEVICE).`,
      );
    }
  }

  let projects: Project[] = browserProjects;
  if (options.auth) {
    projects = [
      { name: 'setup', testMatch: options.auth.setupMatch },
      ...browserProjects.map((project) => ({
        ...project,
        dependencies: ['setup'],
        testIgnore: options.auth?.setupMatch,
        use: { ...project.use, storageState: options.auth?.storageState },
      })),
    ];
  }
  projects = [...projects, ...(options.extraProjects ?? [])];

  const reporters: NonNullable<PlaywrightTestConfig['reporter']> = [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    // machine-readable results for `automation-run-report` (flaky tests, slowest tests, history)
    ['json', { outputFile: 'test-results/results.json' }],
  ];
  if ((options.allure ?? true) && allureInstalled(options.dir)) {
    // Raw results only - generating the viewable HTML report is a separate
    // step (`npm run allure:report`) since it needs a JRE on PATH.
    (reporters as unknown[]).push(['allure-playwright', { resultsDir: 'allure-results' }]);
  }

  const config: PlaywrightTestConfig = {
    testDir: options.testDir ?? './tests',
    outputDir: './test-results',
    fullyParallel: true,
    workers: env.getOptional('WORKERS'),
    retries,
    maxFailures: maxFailures || undefined,
    globalTimeout: globalTimeoutMs || undefined,
    timeout: testTimeoutMs,
    // Never let an accidentally-committed `.only` slip through in CI.
    forbidOnly: !!process.env.CI,
    preserveOutput: process.env.CI ? 'always' : 'failures-only',
    // Flags tests taking far longer than expected without failing them.
    reportSlowTests: { max: 10, threshold: testTimeoutMs * 2 },
    expect: { timeout: expectTimeoutMs },
    metadata: { framework: options.name ?? 'referenced-automation', env: env.envName },
    reporter: reporters,
    use: {
      baseURL: env.getOptional(options.baseUrlKey ?? 'BASE_URL'),
      headless: env.getBoolean('HEADLESS', true),
      actionTimeout: actionTimeoutMs,
      navigationTimeout: navigationTimeoutMs,
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
      trace: 'retain-on-failure',
      ignoreHTTPSErrors: env.getBoolean('IGNORE_HTTPS_ERRORS', false),
      locale: env.getOptional('LOCALE'),
      timezoneId: env.getOptional('TIMEZONE_ID'),
      colorScheme: env.getOptional('COLOR_SCHEME') as 'light' | 'dark' | 'no-preference' | undefined,
      launchOptions: { slowMo: slowMoMs || undefined },
      testIdAttribute: env.get('TEST_ID_ATTRIBUTE', 'data-testid'),
    },
    projects,
  };

  return { ...config, ...options.overrides };
}
