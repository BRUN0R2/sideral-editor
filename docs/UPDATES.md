# Signed updates

Sideral Editor uses the official Tauri 2 updater. A release endpoint and signing
identity are intentionally not invented in development builds.

## Configure a release build

1. Generate and securely back up a Tauri updater signing key pair.
2. Copy `src-tauri/tauri.release.conf.example.json` to a release configuration.
3. Replace the endpoint and public-key placeholders.
4. Provide `TAURI_SIGNING_PRIVATE_KEY` and, when applicable,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only through the protected release
   environment.
5. Build with the release configuration:

```powershell
npm run tauri build -- --config src-tauri/tauri.release.conf.json
```

The public key and endpoint may be committed. The private key and password must
never be committed, logged or shipped.

The server returns `204 No Content` when no update exists, or a signed Tauri
update manifest when a newer version is available. On Windows the current build
targets NSIS, matching the updater artifact flow.

## Interface behavior

- One automatic check occurs per app session.
- A top-bar arrow appears only when an update is available or in progress.
- Download progress uses transferred bytes, total size and measured ETA.
- Installation is a separate, non-dismissible stage after the download reaches
  100%.
- Restart is explicit when the installer returns control to the app.
- The updater resource is closed when replaced or when the provider is disposed.
