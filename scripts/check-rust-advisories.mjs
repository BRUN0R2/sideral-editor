import { spawnSync } from "node:child_process";

const CARGO_AUDIT_ARGUMENTS = ["audit", "--file", "src-tauri/Cargo.lock", "--json"];
const MAX_AUDIT_OUTPUT_BYTES = 8 * 1024 * 1024;

const LINUX_TAURI_SCOPE =
  "Linux-only dependency of the official Tauri runtime; absent from the Windows dependency graph.";

const EXPECTED_WARNINGS = new Map(
  [
    ["RUSTSEC-2024-0370", "proc-macro-error", "1.0.4", "unmaintained", LINUX_TAURI_SCOPE],
    ["RUSTSEC-2024-0429", "glib", "0.18.5", "unsound", LINUX_TAURI_SCOPE],
  ].map(([advisoryId, packageName, version, kind, scope]) => [
    advisoryId,
    { packageName, version, kind, scope },
  ]),
);

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }

  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }

  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }

  return value;
}

function parseAuditReport(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("cargo audit returned invalid JSON.", { cause: error });
  }

  const report = requireObject(parsed, "report");
  const vulnerabilities = requireObject(report.vulnerabilities, "report.vulnerabilities");
  const vulnerabilityList = requireArray(vulnerabilities.list, "report.vulnerabilities.list");
  const warningsByKind = requireObject(report.warnings, "report.warnings");
  const warnings = [];

  for (const [category, entries] of Object.entries(warningsByKind)) {
    for (const [index, entryValue] of requireArray(
      entries,
      `report.warnings.${category}`,
    ).entries()) {
      const path = `report.warnings.${category}[${index}]`;
      const entry = requireObject(entryValue, path);
      const packageDetails = requireObject(entry.package, `${path}.package`);
      if (category === "yanked") {
        throw new Error(
          `Yanked Rust package: ${requireString(packageDetails.name, `${path}.package.name`)}@${requireString(packageDetails.version, `${path}.package.version`)}. Update the lockfile.`,
        );
      }
      const advisory = requireObject(entry.advisory, `${path}.advisory`);
      warnings.push({
        advisoryId: requireString(advisory.id, `${path}.advisory.id`),
        kind: requireString(entry.kind, `${path}.kind`),
        packageName: requireString(packageDetails.name, `${path}.package.name`),
        version: requireString(packageDetails.version, `${path}.package.version`),
      });
    }
  }

  return { vulnerabilities: vulnerabilityList, warnings };
}

function describeWarning(warning) {
  return `${warning.advisoryId} (${warning.kind}: ${warning.packageName}@${warning.version})`;
}

const audit = spawnSync("cargo", CARGO_AUDIT_ARGUMENTS, {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
  windowsHide: true,
});

if (audit.error !== undefined) {
  throw new Error("Unable to execute cargo audit.", { cause: audit.error });
}

if (audit.stdout.trim().length === 0) {
  throw new Error(`cargo audit returned no report. ${audit.stderr.trim()}`.trim());
}

const report = parseAuditReport(audit.stdout);

if (report.vulnerabilities.length > 0) {
  const identifiers = report.vulnerabilities.map((entry, index) => {
    const advisory = requireObject(
      requireObject(entry, `report.vulnerabilities[${index}]`).advisory,
      `report.vulnerabilities[${index}].advisory`,
    );
    return requireString(advisory.id, `report.vulnerabilities[${index}].advisory.id`);
  });
  throw new Error(`Rust vulnerabilities found: ${identifiers.join(", ")}.`);
}

if (audit.signal !== null) {
  throw new Error(`cargo audit was terminated by signal ${audit.signal}.`);
}

if (audit.status !== 0) {
  throw new Error(`cargo audit exited with status ${audit.status}. ${audit.stderr.trim()}`.trim());
}

const observedIds = new Set();
const unexpectedWarnings = [];

for (const warning of report.warnings) {
  if (observedIds.has(warning.advisoryId)) {
    throw new Error(`cargo audit returned duplicate advisory ${warning.advisoryId}.`);
  }

  observedIds.add(warning.advisoryId);
  const expected = EXPECTED_WARNINGS.get(warning.advisoryId);
  if (
    expected === undefined ||
    expected.packageName !== warning.packageName ||
    expected.version !== warning.version ||
    expected.kind !== warning.kind
  ) {
    unexpectedWarnings.push(describeWarning(warning));
  }
}

const resolvedWarnings = [...EXPECTED_WARNINGS.keys()].filter(
  (advisoryId) => !observedIds.has(advisoryId),
);

if (unexpectedWarnings.length > 0 || resolvedWarnings.length > 0) {
  const diagnostics = [];
  if (unexpectedWarnings.length > 0) {
    diagnostics.push(`Unexpected advisories: ${unexpectedWarnings.join(", ")}.`);
  }
  if (resolvedWarnings.length > 0) {
    diagnostics.push(
      `Resolved advisories still present in the policy: ${resolvedWarnings.join(", ")}.`,
    );
  }
  throw new Error(diagnostics.join(" "));
}

const scopes = new Map();
for (const expected of EXPECTED_WARNINGS.values()) {
  scopes.set(expected.scope, (scopes.get(expected.scope) ?? 0) + 1);
}

console.log(
  `Rust advisory policy passed: 0 vulnerabilities and ${report.warnings.length} reviewed informational advisories.`,
);
for (const [scope, count] of scopes) {
  console.log(`- ${count}: ${scope}`);
}
