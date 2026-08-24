import * as fs from 'node:fs';
import { getPath } from '../validation/objectPath';

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function fromJson<T = unknown>(json: string): T {
  return JSON.parse(json) as T;
}

export function fromJsonFile<T = unknown>(filePath: string): T {
  return fromJson<T>(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Dot/bracket path read, e.g. readAt(json, 'data.users[0].name'). Thin
 * re-export of validation/objectPath's getPath so JSON-file-based test data
 * and live API responses are traversed the exact same way.
 */
export function readAt<T = unknown>(json: string, path: string): T {
  return getPath<T>(fromJson(json), path);
}
