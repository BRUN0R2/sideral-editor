export type RuntimeRecord = Readonly<Record<string, unknown>>;

export interface RuntimeJsonObject {
  readonly [key: string]: RuntimeJsonValue;
}

export interface RuntimeJsonArray extends ReadonlyArray<RuntimeJsonValue> {}

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | RuntimeJsonArray
  | RuntimeJsonObject;

export class BoundaryValidationError extends Error {
  constructor(path: string, expectation: string) {
    super(`${path} ${expectation}.`);
    this.name = "BoundaryValidationError";
  }
}

export function record(
  value: unknown,
  path: string,
  allowedKeys?: readonly string[],
): RuntimeRecord {
  if (!isRuntimeRecord(value)) {
    throw new BoundaryValidationError(path, "must be an object");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BoundaryValidationError(path, "must be a plain object");
  }
  if (allowedKeys !== undefined) {
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new BoundaryValidationError(`${path}.${key}`, "is not supported");
      }
    }
  }
  return value;
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function required(source: RuntimeRecord, key: string, path: string): unknown {
  if (!Object.hasOwn(source, key)) {
    throw new BoundaryValidationError(`${path}.${key}`, "is required");
  }
  return source[key];
}

export function optional(source: RuntimeRecord, key: string): unknown | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

export function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new BoundaryValidationError(path, "must be a string");
  }
  return value;
}

export function nonEmptyString(value: unknown, path: string): string {
  const decoded = stringValue(value, path);
  if (decoded.length === 0) {
    throw new BoundaryValidationError(path, "must not be empty");
  }
  return decoded;
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new BoundaryValidationError(path, "must be a boolean");
  }
  return value;
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BoundaryValidationError(path, "must be a finite number");
  }
  return value;
}

export function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new BoundaryValidationError(
      path,
      `must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

export function literal<const Value extends string | number | boolean>(
  value: unknown,
  expected: Value,
  path: string,
): Value {
  if (value !== expected) {
    throw new BoundaryValidationError(path, `must equal ${JSON.stringify(expected)}`);
  }
  return expected;
}

export function enumeration<const Value extends string | number>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
): Value {
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new BoundaryValidationError(path, `must be one of ${allowed.join(", ")}`);
}

export function arrayOf<Value>(
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => Value,
): readonly Value[] {
  if (!Array.isArray(value)) {
    throw new BoundaryValidationError(path, "must be an array");
  }
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

export function nullable<Value>(
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => Value,
): Value | null {
  return value === null ? null : decode(value, path);
}

export function stringRecord(value: unknown, path: string): Readonly<Record<string, string>> {
  const source = record(value, path);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    assertSafePropertyKey(key, path);
    result[key] = stringValue(item, `${path}.${key}`);
  }
  return result;
}

export function jsonValue(value: unknown, path: string, maximumDepth = 64): RuntimeJsonValue {
  return decodeJsonValue(value, path, maximumDepth, 0, new WeakSet<object>());
}

export function jsonObject(value: unknown, path: string, maximumDepth = 64): RuntimeJsonObject {
  const decoded = jsonValue(value, path, maximumDepth);
  if (!isRuntimeJsonObject(decoded)) {
    throw new BoundaryValidationError(path, "must be a JSON object");
  }
  return decoded;
}

function isRuntimeJsonObject(value: RuntimeJsonValue): value is RuntimeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function voidValue(value: unknown, path: string): void {
  if (value !== null && value !== undefined) {
    throw new BoundaryValidationError(path, "must not contain a value");
  }
}

export function arrayBuffer(value: unknown, path: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new BoundaryValidationError(path, "must be an ArrayBuffer");
  }
  return value;
}

function decodeJsonValue(
  value: unknown,
  path: string,
  maximumDepth: number,
  depth: number,
  ancestors: WeakSet<object>,
): RuntimeJsonValue {
  if (depth > maximumDepth) {
    throw new BoundaryValidationError(path, `must not exceed ${maximumDepth} levels`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return finiteNumber(value, path);
  }
  if (typeof value !== "object") {
    throw new BoundaryValidationError(path, "must contain only JSON values");
  }
  if (ancestors.has(value)) {
    throw new BoundaryValidationError(path, "must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        decodeJsonValue(item, `${path}[${index}]`, maximumDepth, depth + 1, ancestors),
      );
    }
    const source = record(value, path);
    const result: Record<string, RuntimeJsonValue> = {};
    for (const [key, item] of Object.entries(source)) {
      assertSafePropertyKey(key, path);
      result[key] = decodeJsonValue(item, `${path}.${key}`, maximumDepth, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function assertSafePropertyKey(key: string, path: string): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new BoundaryValidationError(`${path}.${key}`, "is not a safe transport property");
  }
}
