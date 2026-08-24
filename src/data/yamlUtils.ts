import * as yaml from 'js-yaml';
import * as fs from 'node:fs';

export function toYaml(value: unknown): string {
  return yaml.dump(value);
}

export function fromYaml<T = unknown>(text: string): T {
  return yaml.load(text) as T;
}

export function fromYamlFile<T = unknown>(filePath: string): T {
  return fromYaml<T>(fs.readFileSync(filePath, 'utf8'));
}
