import * as winston from 'winston';

/**
 * Shared logger: console (always, so steps are visible locally AND in raw
 * CI job logs) + a rolling file under logs/automation.log. LOG_LEVEL env
 * var controls verbosity (see src/config/env.ts) without any code change.
 */
const level = process.env.LOG_LEVEL ?? 'info';

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level: lvl, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${lvl}] ${message}${extra}`;
  }),
);

export const logger = winston.createLogger({
  level,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: 'logs/automation.log',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
});

/**
 * Wraps a step (a UI action, an API call, a business step) with start/pass/fail
 * logging, so every step's outcome is visible without hand-adding log lines
 * everywhere - the equivalent of the Java framework's StepLoggerPlugin, but
 * usable directly around any function rather than tied to a Cucumber hook.
 */
export async function loggedStep<T>(name: string, action: () => Promise<T> | T): Promise<T> {
  const startedAt = Date.now();
  logger.info(`>> STEP: ${name}`);
  try {
    const result = await action();
    logger.info(`<< STEP PASSED (${Date.now() - startedAt}ms): ${name}`);
    return result;
  } catch (error) {
    logger.error(`<< STEP FAILED (${Date.now() - startedAt}ms): ${name}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
