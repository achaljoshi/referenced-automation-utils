import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'off'];

/**
 * Typed accessor over whatever env file got loaded. Every consuming repo's
 * playwright.config.ts (and any test/helper) goes through this instead of
 * touching process.env directly, so "which env am I pointed at" and
 * "what happens when a key is missing" behave identically everywhere.
 */
export class ConfigReader {
  private readonly values: Record<string, string>;
  private readonly declared: Set<string>;

  /**
   * @param values every value the reader resolves (loadEnv also folds the process environment in, so it wins over files).
   * @param declaredKeys which of those keys were explicitly configured (from .env files or the caller); defaults to all
   *   of `values`. Only these are exposed by toObject() - the rest of the process environment (CI secrets) is not.
   */
  constructor(values: Record<string, string>, declaredKeys?: Iterable<string>) {
    this.values = values;
    this.declared = new Set(declaredKeys ?? Object.keys(values));
  }

  get(key: string, defaultValue?: string): string {
    const value = this.values[key] ?? process.env[key] ?? defaultValue;
    if (value === undefined) {
      throw new Error(`Config key "${key}" is not set and no default was provided`);
    }
    return value;
  }

  /** Like get(), but returns undefined instead of throwing when absent. */
  getOptional(key: string, defaultValue?: string): string | undefined {
    return this.values[key] ?? process.env[key] ?? defaultValue;
  }

  getInt(key: string, defaultValue?: number): number {
    const raw = this.getOptional(key);
    if (raw === undefined) {
      if (defaultValue === undefined) {
        throw new Error(`Config key "${key}" is not set and no default was provided`);
      }
      return defaultValue;
    }
    // Whole-string match: parseInt('12abc') would silently give 12.
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      throw new Error(`Config key "${key}" = "${raw}" is not a valid integer`);
    }
    return Number.parseInt(raw.trim(), 10);
  }

  /** true/false, 1/0, yes/no, on/off (any case). Anything else throws: HEADLESS=ture must not silently mean "headed". */
  getBoolean(key: string, defaultValue = false): boolean {
    const raw = this.getOptional(key);
    if (raw === undefined) return defaultValue;
    const normalised = raw.trim().toLowerCase();
    if (TRUE_VALUES.includes(normalised)) return true;
    if (FALSE_VALUES.includes(normalised)) return false;
    throw new Error(
      `Config key "${key}" = "${raw}" is not a valid boolean (use true/false, 1/0, yes/no or on/off)`,
    );
  }

  /** Comma-separated list, e.g. FEATURE_FLAGS=a,b,c -> ['a', 'b', 'c']. Empty entries ("a,,b," ) are dropped. */
  getList(key: string, defaultValue: string[] = []): string[] {
    const raw = this.getOptional(key);
    if (raw === undefined || raw.trim() === '') return defaultValue;
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }

  has(key: string): boolean {
    return this.getOptional(key) !== undefined;
  }

  /** The resolved environment name this reader was built for (qa/stage/dev/...). */
  get envName(): string {
    return this.get('ENV', 'qa');
  }

  /**
   * Snapshot of the keys that were explicitly configured (the loaded .env files / the values passed in), with their
   * effective values. It never includes the rest of process.env, so logging it cannot dump CI secrets.
   */
  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.declared) {
      const value = this.values[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
}

export interface LoadEnvOptions {
  /** Overrides process.env.ENV / ENVIRONMENT for this call only. */
  env?: string;
  /** Directory .env.<env> files live in. Defaults to process.cwd(). */
  dir?: string;
}

/**
 * Resolves which environment to run against (env.env, then $ENV, then
 * $ENVIRONMENT, then "qa") and loads its .env.<name> file, so every repo's
 * playwright.config.ts only has to do:
 *
 *   const env = loadEnv();
 *   use: { baseURL: env.get('BASE_URL') }
 *
 * and switching environments is just `ENV=stage npx playwright test` - no
 * code changes, no per-environment config branches.
 *
 * Load order (later wins): .env -> .env.<name> -> .env.<name>.local -> real
 * process.env. The .local file is gitignored, for secrets that shouldn't be
 * committed (see .env.example).
 */
export function loadEnv(options: LoadEnvOptions = {}): ConfigReader {
  const dir = options.dir ?? process.cwd();
  const name = options.env ?? process.env.ENV ?? process.env.ENVIRONMENT ?? 'qa';

  const values: Record<string, string> = { ENV: name };
  const declared = new Set<string>(['ENV']);

  for (const file of ['.env', `.env.${name}`, `.env.${name}.local`]) {
    const fullPath = path.join(dir, file);
    if (fs.existsSync(fullPath)) {
      const parsed = dotenv.parse(fs.readFileSync(fullPath));
      Object.assign(values, parsed);
      for (const key of Object.keys(parsed)) declared.add(key);
    }
  }

  // Real process.env (CI secrets, -D-style overrides via `FOO=bar npx playwright test`)
  // always wins over anything from a file.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values[key] = value;
  }
  values.ENV = name;

  return new ConfigReader(values, declared);
}
