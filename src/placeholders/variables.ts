import { loadEnv, type ConfigReader } from '../config/env';
import type { Dayjs } from 'dayjs';
import * as dateUtils from '../date/dateUtils';
import * as randomUtils from '../random/randomUtils';

/** The kinds of random value `{{random:<kind>}}` and the "I generate a random ..." step can produce. */
export const RANDOM_KINDS = [
  'uuid',
  'email',
  'name',
  'first-name',
  'last-name',
  'phone',
  'company',
  'city',
  'country',
  'alnum',
  'number',
] as const;
export type RandomKind = (typeof RANDOM_KINDS)[number];

/** One random value of the given kind. `alnum` and `number` take optional arguments: alnum(8), number(1,100). */
export function randomValue(spec: string): string {
  const match = /^([a-z-]+)(?:\(([^)]*)\))?$/.exec(spec.trim());
  const kind = match?.[1] as RandomKind | undefined;
  const args = (match?.[2] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  switch (kind) {
    case 'uuid':
      return randomUtils.uuid();
    case 'email':
      return randomUtils.email();
    case 'name':
      return randomUtils.fullName();
    case 'first-name':
      return randomUtils.firstName();
    case 'last-name':
      return randomUtils.lastName();
    case 'phone':
      return randomUtils.phoneNumber();
    case 'company':
      return randomUtils.companyName();
    case 'city':
      return randomUtils.city();
    case 'country':
      return randomUtils.country();
    case 'alnum':
      return randomUtils.alphaNumeric(Number(args[0] ?? 8));
    case 'number':
      return String(randomUtils.number(Number(args[0] ?? 0), Number(args[1] ?? 1_000_000)));
    default:
      throw new Error(
        `Unknown random kind "${spec}". Use one of: ${RANDOM_KINDS.join(', ')} (alnum(8) and number(1,100) take arguments).`,
      );
  }
}

/**
 * Variables the CI system provides to every job that are credentials. `{{env:X}}` refuses them: a feature file or test
 * that embeds one would print it into the HTML report, traces and logs, and nothing in a test needs the job's own token.
 */
const FORBIDDEN_ENV = [
  /^CI_JOB_TOKEN$/,
  /^CI_BUILD_TOKEN$/,
  /^CI_JOB_JWT/,
  /^CI_REGISTRY_PASSWORD$/,
  /^CI_DEPLOY_PASSWORD$/,
  /^CI_DEPENDENCY_PROXY_PASSWORD$/,
  /^CI_RUNNER_.*TOKEN/,
  /^CI_REPOSITORY_URL$/, // embeds gitlab-ci-token:<job token>@
];

/** True for a CI-provided credential variable (CI_JOB_TOKEN, CI_REGISTRY_PASSWORD, CI_JOB_JWT_V2, ...). */
export function isForbiddenEnvName(name: string): boolean {
  return FORBIDDEN_ENV.some((pattern) => pattern.test(name.trim()));
}

const OFFSET = /^([+-]?\d+)\s*(ms|s|m|h|d|w|M|y)$/;
const UNITS: Record<
  string,
  'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'
> = {
  ms: 'millisecond',
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  M: 'month',
  y: 'year',
};

/**
 * now, or now +/- an offset such as `+7d`, `-1M`, `+90m`, formatted with a dayjs pattern (default YYYY-MM-DD).
 * `from` replaces "now" as the starting point (a fixed date makes the result reproducible).
 */
export function relativeDate(
  offset: string,
  pattern: string = dateUtils.DEFAULT_DATE_PATTERN,
  from?: Dayjs,
): string {
  const trimmed = offset.trim();
  let moment = from ?? dateUtils.now();
  if (trimmed !== '' && trimmed !== 'now' && trimmed !== 'today') {
    const match = OFFSET.exec(trimmed);
    if (!match)
      throw new Error(
        `Bad date offset "${offset}". Use e.g. +7d, -1M, +90m, +2h (units: ms s m h d w M y), or "today".`,
      );
    moment = moment.add(Number(match[1]), UNITS[match[2] as string] as 'day');
  }
  return moment.format(pattern);
}

/**
 * A scenario's named values, plus the `{{...}}` placeholders every reusable step understands - so a feature file
 * (or any test) never has to hard-code data that must be unique or fresh:
 *
 *   {{name}}                  a value saved earlier in the scenario
 *   {{env:NAME}}              an environment / .env.<ENV> value ({{env:NAME|fallback}} when it may be absent)
 *   {{uuid}}  {{timestamp}}   a fresh UUID / epoch milliseconds
 *   {{random:email}}          a random value: uuid email name first-name last-name phone company city country alnum(8) number(1,100)
 *   {{date:+7d}}              today +/- an offset (units ms s m h d w M y), {{date:-1M|DD/MM/YYYY}} with a pattern
 *
 * A placeholder that cannot be resolved throws and names what is known, rather than sending "{{typo}}" to a system.
 */
export class ScenarioVariables {
  private readonly values = new Map<string, string>();
  private env: ConfigReader | undefined;

  /** @param env where `{{env:NAME}}` reads from after the real environment; default: the .env.<ENV> files, loaded once per instance. */
  constructor(env?: ConfigReader) {
    this.env = env;
  }

  set(name: string, value: unknown): this {
    this.values.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    return this;
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  require(name: string): string {
    const value = this.values.get(name);
    if (value === undefined) throw new Error(this.unknown(name));
    return value;
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  clear(): void {
    this.values.clear();
  }

  /** Replaces every `{{...}}` in `text`. */
  interpolate(text: string): string {
    return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_whole, expression: string) =>
      this.resolve(expression),
    );
  }

  /** Interpolates every string inside a JSON-like value (object keys are left alone). */
  interpolateDeep<T>(value: T): T {
    if (typeof value === 'string') return this.interpolate(value) as unknown as T;
    if (Array.isArray(value))
      return value.map((item) => this.interpolateDeep(item)) as unknown as T;
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          this.interpolateDeep(v),
        ]),
      ) as T;
    }
    return value;
  }

  private resolve(expression: string): string {
    if (expression.startsWith('env:')) {
      const [key, ...rest] = expression.slice(4).split('|');
      const fallback = rest.length > 0 ? rest.join('|') : undefined;
      const name = (key as string).trim();
      if (isForbiddenEnvName(name))
        throw new Error(
          `{{${expression}}}: ${name} is a credential the CI system injects (the job token, a registry password, ...) and is never available to test data. Use a variable you define for the test instead.`,
        );
      const value = process.env[name] ?? (this.env ??= loadEnv()).getOptional(name) ?? fallback;
      if (value === undefined)
        throw new Error(
          `{{${expression}}}: environment variable ${name} is not set (add "|fallback" to allow it to be absent).`,
        );
      return value;
    }
    if (expression === 'uuid') return randomUtils.uuid();
    if (expression === 'timestamp') return String(Date.now());
    if (expression.startsWith('random:')) return randomValue(expression.slice(7));
    if (expression.startsWith('date:')) {
      const [offset, ...pattern] = expression.slice(5).split('|');
      return relativeDate(offset as string, pattern.length > 0 ? pattern.join('|') : undefined);
    }
    return this.require(expression);
  }

  private unknown(name: string): string {
    const known = [...this.values.keys()];
    return `No scenario variable "${name}". ${known.length > 0 ? `Known: ${known.join(', ')}.` : 'None have been set yet.'}`;
  }
}
