import Ajv, { type ErrorObject, type Schema } from 'ajv';
import addFormats from 'ajv-formats';

export interface SchemaValidationResult {
  valid: boolean;
  errors: ErrorObject[];
  /** Human-readable one-line-per-error summary, ready to drop into an assertion message. */
  errorsText: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/**
 * Validates a parsed JSON value (typically an API response body) against a
 * JSON Schema (draft-07/2019-09/2020-12, all supported by ajv). Used for the
 * "response should validate against a schema" style of API assertion.
 */
export function validateSchema(data: unknown, schema: Schema): SchemaValidationResult {
  const validateFn = ajv.compile(schema);
  const valid = validateFn(data);
  const errors = validateFn.errors ?? [];
  return {
    valid,
    errors,
    errorsText: errors
      .map((err) => `${err.instancePath || '(root)'} ${err.message ?? ''}`.trim())
      .join('; '),
  };
}
