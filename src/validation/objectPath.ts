import { get as lodashGet, set as lodashSet, has as lodashHas } from 'lodash';

/**
 * Dot/bracket path traversal over any parsed JSON/object value, e.g.
 * getPath(body, 'data.users[0].name') or getPath(body, 'items[2].id').
 * Thin, deliberately-named wrapper around lodash so every repo imports this
 * one function instead of each picking its own path library.
 */
export function getPath<T = unknown>(source: unknown, path: string, defaultValue?: T): T {
  return lodashGet(source as object, path, defaultValue) as T;
}

export function setPath<T extends object>(target: T, path: string, value: unknown): T {
  lodashSet(target as object, path, value);
  return target;
}

export function hasPath(source: unknown, path: string): boolean {
  return lodashHas(source as object, path);
}

/** Throws with a readable message instead of silently returning undefined. */
export function requirePath<T = unknown>(source: unknown, path: string): T {
  if (!hasPath(source, path)) {
    throw new Error(`Expected path "${path}" to exist in: ${safeStringify(source)}`);
  }
  return getPath<T>(source, path);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}
