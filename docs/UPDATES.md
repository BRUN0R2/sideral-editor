# Signed updates

Sideral Editor uses the official Tauri 2 updater. Development builds do not
invent a signing identity or silently enable updates.

## Configure releases

1. Generate and securely back up a Tauri updater signing key pair.
2. Create a protected GitHub environment named `release`.
3. Store the public key as the environment variable `TAURI_UPDATER_PUBLIC_KEY`.
4. Store `TAURI_SIGNING_PRIVATE_KEY` and, when applicable,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as environment secrets.
5. Push a tag that exactly matches the application version, such as `v0.1.0`.

The release workflow runs the complete quality gate, derives the HTTPS
`latest.json` endpoint from the current GitHub repository, validates the tag and
public key, generates the ignored release configuration, signs the updater
artifacts and creates a draft GitHub release for review. No release artifact is
published automatically.

The public key is not secret. The private key and password must never be
committed, logged or shipped.

GitHub Releases serves the generated `latest.json` manifest and signed NSIS
artifact. On Windows the current build targets NSIS, matching the updater
artifact flow.

## Interface behavior

- One automatic check occurs per app session.
- A top-bar arrow appears only when an update is available or in progress.
- Download progress uses transferred bytes, total size and measured ETA.
- Installation is a separate, non-dismissible stage after the download reaches
  100%.
- Restart is explicit when the installer returns control to the app.
- The updater resource is closed when replaced or when the provider is disposed.
