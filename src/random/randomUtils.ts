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

export function email(localPartPrefix?: string): string {
  return faker.internet.email({ firstName: localPartPrefix ?? faker.string.alphanumeric(8) });
}

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
