import { AdapterError } from '../adapters/adapter';

/** What can go wrong when running steps on a remote desktop host. */
export type RemoteErrorCode =
  | 'NOT_ENABLED'
  | 'UNSUPPORTED_PLATFORM'
  | 'RDP_LAUNCH_FAILED'
  | 'AGENT_NOT_STARTED'
  | 'AGENT_STALE'
  | 'DENIED'
  | 'TIMEOUT'
  | 'REMOTE_ERROR'
  | 'PROTOCOL';

export interface RemoteErrorOptions {
  /** What was being done (`connect`, `db.query`, ...). Shown in the message as `[remote] <operation> failed: ...`. */
  operation?: string;
  cause?: unknown;
  /** Extra text from the far side (never a stack trace, never a secret). */
  detail?: string;
  /** The code the agent itself answered with (`BAD_REQUEST`, `NOT_FOUND`, ...) when it differs from `code`. */
  remoteCode?: string;
}

/**
 * Every failure of the remote-host layer. It is an `AdapterError` (so `adapterStep` passes it through unchanged and
 * `instanceof RemoteError` still works after a step), with a stable `code` to branch on instead of parsing messages.
 */
export class RemoteError extends AdapterError {
  readonly code: RemoteErrorCode;
  readonly detail?: string;
  readonly remoteCode?: string;

  constructor(code: RemoteErrorCode, message: string, options: RemoteErrorOptions = {}) {
    super('remote', options.operation ?? code.toLowerCase(), message, { cause: options.cause });
    this.name = 'RemoteError';
    this.code = code;
    this.detail = options.detail;
    this.remoteCode = options.remoteCode;
    Object.setPrototypeOf(this, RemoteError.prototype);
  }
}
