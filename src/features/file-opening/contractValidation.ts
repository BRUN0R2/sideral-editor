import type { CommandFailure } from "../../lib/errors";
import {
  arrayOf,
  BoundaryValidationError,
  enumeration,
  nonEmptyString,
  record,
  required,
  safeInteger,
} from "../../lib/runtime-validation";
import type { FileOpenInstruction } from "./contracts";

const maxRequestId = 2 ** 32 - 1;
const maxLaunchTargets = 128;

function commandFailure(value: unknown, path: string): CommandFailure {
  const source = record(value, path, ["code", "message"]);
  return {
    code: nonEmptyString(required(source, "code", path), `${path}.code`),
    message: nonEmptyString(required(source, "message", path), `${path}.message`),
  };
}

export function decodeFileOpenInstruction(value: unknown): FileOpenInstruction {
  const path = "file-opening instruction";
  const source = record(value, path);
  const kind = enumeration(required(source, "kind", path), ["open", "failure"], `${path}.kind`);
  if (kind === "failure") {
    record(source, path, ["kind", "error"]);
    return { kind, error: commandFailure(required(source, "error", path), `${path}.error`) };
  }
  record(source, path, ["kind", "request"]);
  const requestPath = `${path}.request`;
  const request = record(required(source, "request", path), requestPath, ["id", "files"]);
  const id = safeInteger(required(request, "id", requestPath), `${requestPath}.id`, 1);
  if (id > maxRequestId) {
    throw new BoundaryValidationError(`${requestPath}.id`, "must fit an unsigned 32-bit integer");
  }
  const filesPath = `${requestPath}.files`;
  const files = record(required(request, "files", requestPath), filesPath, ["paths", "errors"]);
  const paths = arrayOf(required(files, "paths", filesPath), `${filesPath}.paths`, nonEmptyString);
  const errors = arrayOf(
    required(files, "errors", filesPath),
    `${filesPath}.errors`,
    commandFailure,
  );
  if (paths.length > maxLaunchTargets || errors.length > maxLaunchTargets) {
    throw new BoundaryValidationError(filesPath, "exceeds the launch target limit");
  }
  if (paths.length === 0 && errors.length === 0) {
    throw new BoundaryValidationError(filesPath, "must contain a file or an error");
  }
  return { kind, request: { id, files: { paths, errors } } };
}
