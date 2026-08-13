import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tauriConfigurationPath = resolve(repositoryRoot, "src-tauri", "tauri.conf.json");
const releaseConfigurationPath = resolve(repositoryRoot, "src-tauri", "tauri.release.conf.json");

const updaterPublicKey = requiredEnvironmentValue(
  "SIDERAL_UPDATER_PUBLIC_KEY",
  process.env.SIDERAL_UPDATER_PUBLIC_KEY,
);
const updaterEndpoint = validateEndpoint(
  requiredEnvironmentValue("SIDERAL_UPDATER_ENDPOINT", process.env.SIDERAL_UPDATER_ENDPOINT),
);
requiredSecretEnvironmentValue("TAURI_SIGNING_PRIVATE_KEY", process.env.TAURI_SIGNING_PRIVATE_KEY);
validatePublicKey(updaterPublicKey);

const tauriConfiguration = JSON.parse(readFileSync(tauriConfigurationPath, "utf8"));
if (!isTauriConfiguration(tauriConfiguration)) {
  throw new Error("src-tauri/tauri.conf.json does not contain a valid application version.");
}

const releaseTag = process.env.SIDERAL_RELEASE_TAG;
if (releaseTag !== undefined && releaseTag !== `v${tauriConfiguration.version}`) {
  throw new Error(
    `Release tag ${releaseTag} does not match application version v${tauriConfiguration.version}.`,
  );
}

const releaseConfiguration = {
  bundle: {
    createUpdaterArtifacts: true,
  },
  plugins: {
    updater: {
      pubkey: updaterPublicKey,
      endpoints: [updaterEndpoint],
    },
  },
};

writeFileSync(releaseConfigurationPath, `${JSON.stringify(releaseConfiguration, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
console.log(`Created ${releaseConfigurationPath}.`);

function requiredEnvironmentValue(name, value) {
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty, trimmed environment value.`);
  }
  return value;
}

function requiredSecretEnvironmentValue(name, value) {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be configured in the protected release environment.`);
  }
}

function validatePublicKey(publicKey) {
  if (
    publicKey.length < 32 ||
    publicKey.length > 4096 ||
    publicKey.includes("\0") ||
    publicKey.includes("REPLACE_")
  ) {
    throw new Error("SIDERAL_UPDATER_PUBLIC_KEY is not a valid bounded Tauri public key.");
  }
}

function validateEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw new Error("SIDERAL_UPDATER_ENDPOINT must be an absolute URL.", { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "SIDERAL_UPDATER_ENDPOINT must be an HTTPS URL without credentials or a fragment.",
    );
  }
  return parsed.toString();
}

function isTauriConfiguration(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(value.version)
  );
}
