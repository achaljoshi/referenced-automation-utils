import { faker } from '@faker-js/faker';
import dayjs, { type Dayjs } from 'dayjs';

/** Escape hatch for anything not wrapped below - the full faker API. */
export { faker };

export function firstName(): string {
  return faker.person.firstName();
}

export function lastName(): string {
  return faker.person.lastName();
}

export function fullName(): string {
  return faker.person.fullName();
}

/**
 * A random address on a domain reserved for examples (example.com/.org/.net, RFC 2606): a test that sends mail to it
 * can never reach a real person, which an @gmail.com / @yahoo.com address might.
 */
export function email(localPartPrefix?: string): string {
  return faker.internet.exampleEmail({ firstName: localPartPrefix ?? faker.string.alphanumeric(8) });
}

/**
 * Makes everything generated from here on reproducible: the same seed gives the same sequence. Call it with the seed
 * printed by an earlier run to replay that run's data, or with no argument to pick one now. The seed is logged, so a
 * failure's data can be regenerated. (Seeded values repeat across runs: do not seed tests that need globally unique data.)
 */
export function seed(value: number = Math.floor(Math.random() * 2 ** 31)): number {
  if (!Number.isInteger(value)) throw new Error(`random seed must be an integer (got ${value})`);
  faker.seed(value);
  // Lazily required: the logger opens its log file on import, which a plain random-data import should not do.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLogger } = require('../logger/logger') as typeof import('../logger/logger');
  getLogger('random').info(`random data seeded with ${value} (RANDOM_SEED=${value} replays it)`);
  return value;
}

// RANDOM_SEED=<integer> in the environment seeds the generators for the whole process (each Playwright worker).
const envSeed = process.env.RANDOM_SEED;
if (envSeed !== undefined && envSeed.trim() !== '') seed(Number(envSeed));

export function phoneNumber(): string {
  return faker.phone.number();
}

export function streetAddress(): string {
  return faker.location.streetAddress();
}

export function city(): string {
  return faker.location.city();
}

export function country(): string {
  return faker.location.country();
}

export function companyName(): string {
  return faker.company.name();
}

export function jobTitle(): string {
  return faker.person.jobTitle();
}

export function uuid(): string {
  return faker.string.uuid();
}

export function number(minInclusive: number, maxInclusive: number): number {
  return faker.number.int({ min: minInclusive, max: maxInclusive });
}

export function alphaNumeric(length: number): string {
  return faker.string.alphanumeric(length);
}

export function numericString(length: number): string {
  return faker.string.numeric(length);
}

export function futureDate(maxDaysAhead: number): Dayjs {
  return dayjs(faker.date.soon({ days: maxDaysAhead }));
}

export function pastDate(maxDaysBack: number): Dayjs {
  return dayjs(faker.date.recent({ days: maxDaysBack }));
}

export function creditCardNumber(): string {
  return faker.finance.creditCardNumber();
}
