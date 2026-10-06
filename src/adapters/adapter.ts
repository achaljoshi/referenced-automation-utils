import { CommonsError } from '../exceptions/CommonsError';
import { getLogger } from '../logger/logger';

/**
 * The common contract for anything the framework talks to that Playwright
 * can't drive itself - SFTP, SMTP/IMAP, databases, SAP GUI, mainframe
 * terminals, and whatever comes next. A new system becomes a new Adapter,
 * not a new set of conventions: every adapter reports a name, can say
 * whether it is reachable, can release its resources, and runs its
 * operations through `adapterStep` so they all log, time, and fail the same
 * way.
 *
 * Connection details are always passed in by the caller (from that repo's
 * own .env.<name>) - an adapter never reads or stores credentials itself.
 */
export interface Adapter {
  readonly name: string;
  /** Cheap, side-effect-free reachability check (e.g. SMTP NOOP/verify, SAP "is a session attachable"). */
  healthCheck(): Promise<boolean>;
  close(): Promise<void> | void;
}

/** What went wrong, in which adapter, doing what - with the original error preserved as `cause`. */
export class AdapterError extends CommonsError {
  constructor(
    readonly adapter: string,
    readonly operation: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${adapter}] ${operation} failed: ${message}`, options);
    this.name = 'AdapterError';
    Object.setPrototypeOf(this, AdapterError.prototype);
  }
}

export interface AdapterStepOptions {
  /** Log level for the start/finish lines. Use 'debug' for chatty reads (list, exists, query). Default 'info'. */
  level?: 'info' | 'debug';
  /** Extra context for the log line - e.g. a remote path. Never put credentials or full payloads here (sensitive-looking keys are redacted anyway, but don't rely on it). */
  details?: Record<string, unknown>;
}

/**
 * Runs one adapter operation with uniform logging and error handling: logs
 * the start, the duration on success, and on failure logs the error and
 * rethrows it as an `AdapterError` naming the adapter and operation (an
 * AdapterError thrown from inside is passed through unchanged, so nested
 * adapter calls don't wrap twice).
 */
export async function adapterStep<T>(
  adapter: string,
  operation: string,
  action: () => Promise<T> | T,
  options: AdapterStepOptions = {},
): Promise<T> {
  const log = getLogger(adapter);
  const level = options.level ?? 'info';
  const startedAt = Date.now();
  log.log(level, `${operation} ...`, options.details);
  try {
    const result = await action();
    log.log(level, `${operation} ok (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.error(`${operation} FAILED (${Date.now() - startedAt}ms): ${message}`);
    throw new AdapterError(adapter, operation, message, { cause: error });
  }
}
