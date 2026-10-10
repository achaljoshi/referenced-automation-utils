/** A bad command line: reported with the usage text, exit code 2 (the tool could not run), never a silently ignored typo. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type FlagKind = 'string' | 'int' | 'boolean';
export type Flags = Record<string, string | number | boolean | undefined>;

/**
 * Parses `--name value` and `--name=value`. Unknown flags, a missing value, and a value that is not a whole number for
 * an `int` flag are a `UsageError` - a mistyped gate such as `--fail-on-flaky=abc` or `--fail-on-flakey 1` must not
 * quietly switch the gate off.
 */
export function parseFlags(argv: string[], spec: Record<string, FlagKind>): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument "${token}"`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown option ${name} (known: ${Object.keys(spec).join(', ')})`);
    if (kind === 'boolean') {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      out[name] = true;
      continue;
    }
    let value: string | undefined = eq === -1 ? argv[i + 1] : token.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith('--')) value = undefined;
      else i++;
    }
    if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
    if (kind === 'int') {
      if (!/^\d+$/.test(value)) throw new UsageError(`${name} needs a whole number >= 0 (got "${value}")`);
      out[name] = Number(value);
    } else out[name] = value;
  }
  return out;
}

/** Runs a CLI body, turning a UsageError into the usage text on stderr and exit code 2. */
export function runCli(usage: string, body: () => void): void {
  try {
    body();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage}`);
      process.exit(2);
    }
    throw error;
  }
}
