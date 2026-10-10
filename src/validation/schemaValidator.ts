import Ajv, { type ErrorObject, type Schema, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export interface SchemaValidationResult {
  valid: boolean;
  errors: ErrorObject[];
  /** Human-readable one-line-per-error summary, ready to drop into an assertion message. */
  errorsText: string;
}

export interface SchemaValidationOptions {
  /**
   * Default true: an unknown keyword (a misspelt `requried`, `propertes`, `minLenght`) or an unknown format makes the
   * schema fail to compile, instead of being ignored and letting every payload through. Pass false for a schema you do
   * not own (a vendor's OpenAPI document with its own extension keywords).
   */
  strict?: boolean;
}

function createAjv(strict: boolean): Ajv {
  // strictTypes/strictTuples stay off: they only log advice about style, and a log line per compile is noise in a test run.
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    strictSchema: strict,
    strictNumbers: strict,
    strictTypes: false,
    strictTuples: false,
  });
  addFormats(ajv);
  if (strict) {
    // Annotation keywords that appear in real API schemas (OpenAPI) and do not constrain data.
    ajv.addVocabulary(['example', 'externalDocs', 'xml', 'discriminator']);
  }
  return ajv;
}

interface Compiled {
  fn: ValidateFunction;
  json: string;
}

class ValidatorCache {
  private readonly ajv: Ajv;
  private readonly byObject = new WeakMap<object, ValidateFunction>();
  private readonly byJson = new Map<string, ValidateFunction>();
  private readonly byId = new Map<string, Compiled>();

  constructor(strict: boolean) {
    this.ajv = createAjv(strict);
  }

  compile(schema: Schema): ValidateFunction {
    if (typeof schema === 'object' && schema !== null) {
      const known = this.byObject.get(schema);
      if (known) return known;
    }
    const json = JSON.stringify(schema);
    const sameContent = this.byJson.get(json);
    if (sameContent) return this.remember(schema, sameContent);

    // Ajv refuses a second schema with the same $id ("schema with key or id ... already exists"). The same content is
    // answered from the cache above; different content under one $id replaces the earlier schema.
    const id = typeof schema === 'object' && schema !== null ? (schema as { $id?: unknown }).$id : undefined;
    if (typeof id === 'string') {
      const previous = this.byId.get(id);
      if (previous) {
        this.ajv.removeSchema(id);
        this.byJson.delete(previous.json);
        this.byId.delete(id);
      }
    }
    const fn = this.ajv.compile(schema);
    this.byJson.set(json, fn);
    if (typeof id === 'string') this.byId.set(id, { fn, json });
    return this.remember(schema, fn);
  }

  private remember(schema: Schema, fn: ValidateFunction): ValidateFunction {
    if (typeof schema === 'object' && schema !== null) this.byObject.set(schema, fn);
    return fn;
  }
}

const strictCache = new ValidatorCache(true);
const lenientCache = new ValidatorCache(false);

/**
 * Validates a parsed JSON value (typically an API response body) against a
 * JSON Schema (draft-07/2019-09/2020-12, all supported by ajv). Used for the
 * "response should validate against a schema" style of API assertion.
 *
 * Compiled schemas are cached (by object and by content), so validating many
 * responses against one schema is cheap and a schema with an `$id` can be used
 * in any number of tests. A schema that is itself invalid - including a
 * misspelt keyword, see `options.strict` - throws, naming the problem.
 */
export function validateSchema(
  data: unknown,
  schema: Schema,
  options: SchemaValidationOptions = {},
): SchemaValidationResult {
  const validateFn = (options.strict === false ? lenientCache : strictCache).compile(schema);
  const valid = validateFn(data) as boolean;
  const errors = validateFn.errors ?? [];
  return {
    valid,
    errors,
    errorsText: errors
      .map((err) => `${err.instancePath || '(root)'} ${err.message ?? ''}`.trim())
      .join('; '),
  };
}
