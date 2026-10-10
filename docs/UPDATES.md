# Updates and releases

Sideral uses the official Tauri 2 updater. Updates are enabled only in a build with
a configured public key and HTTPS endpoint. Development does not invent a signing
identity.

Published installers and updater metadata belong on
[GitHub Releases](https://github.com/BRUN0R2/sideral-editor/releases).
Until a suitable build is published, use [a local installer](DEVELOPMENT.md#build-a-windows-installer).

## Configure the release environment

Generate and securely back up an updater key pair outside the repository, using
[Tauri's signing instructions](https://v2.tauri.app/plugin/updater/#signing-updates).
The private key must stay available for future updates to installed clients.

Create a protected GitHub environment named `release`:

| Setting | Kind | Value |
| --- | --- | --- |
| `TAURI_UPDATER_PUBLIC_KEY` | Environment variable | Generated public key |
| `TAURI_SIGNING_PRIVATE_KEY` | Environment secret | Private signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Environment secret | Key password, when applicable |

The public key can be shared. Never commit, print or distribute the private key
or password. Updater signing and extension-package signing use separate formats
and identities.

## Create a release

1. Update the application version consistently in its manifests and lockfiles.
2. Run `npm run check` and commit the release-ready change.
3. Push a tag named `v<application-version>` that exactly matches
   [`tauri.conf.json`](../src-tauri/tauri.conf.json).
4. Review and publish the draft created by the
   [release workflow](../.github/workflows/release.yml).

The workflow runs the complete gate, derives the repository's HTTPS `latest.json`
endpoint, validates the tag and public key, and writes the ignored
`src-tauri/tauri.release.conf.json`. The official Tauri action builds the NSIS
installer, updater signature and update manifest, then creates a **draft** release.
Publishing remains explicit.

The generated configuration is required for production updates. Missing settings
fail release generation; they do not silently produce an updater-enabled build.
An updater signature verifies update origin; Windows executable code signing is
a separate configuration.

The release workflow publishes editor artifacts. First-party `.sideralx` packages
use the [extension packaging workflow](EXTENSIONS.md#work-inside-this-repository)
and are installed separately.

## Update a portable copy

1. Close all running Sideral processes.
2. Build or obtain the new Windows executable.
3. Back up the existing executable, then replace it at the path your shortcuts
   and file associations launch.
4. Start that executable and verify the changed behavior.

Local builds place it at `build/cargo/release/sideral-editor.exe`. A process that
was already running retains old code until it exits. Replacing a portable
executable preserves its existing associations; new Explorer integration requires
the [NSIS installer](FILE-OPENING.md).

## In-app behavior

The updater checks once per app session and supports manual checks. The top-bar
arrow appears when an update is available or progressing. Download progress uses
transferred bytes, total size and measured ETA.

After download reaches 100%, installation is a separate non-dismissible stage.
Restart is explicit once the installer returns control. The updater resource
closes when replaced or its owner is disposed.
