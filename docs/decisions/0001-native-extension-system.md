# ADR 0001: Native extension system

## Status

Accepted.

## Decision

Sideral Editor has one extension system. It uses a strict, versioned manifest,
an explicit capability model, a declaration-only SDK and an isolated Web Worker
runtime. The product does not inspect, adapt or execute manifests from other
editors and has no alternate extension protocol.

The automated architecture check rejects references to retired compatibility
artifacts from every native extension module, SDK and test harness. Adding a
second manifest dialect, adapter, alias, migration or implicit fallback requires
replacing this decision and the project constitution first; it cannot be hidden
inside the current boundary.

## Package contract

A production package uses the `.sideralx` extension and contains only:

```text
manifest.json
dist/extension.mjs
assets/*              optional
signature.json
```

The SDK is a development-only, type-only package. It emits declarations but no
JavaScript, so it adds no runtime bytes to an extension. Extension authors ship
one minified, tree-shaken ESM worker bundle. Packages must not contain
`node_modules`, source files, tests, caches or source maps.

`signature.json` contains an Ed25519 publisher identity, a digest for every
other file and a signature over a canonical, domain-separated payload. The
package validator rejects missing files, extra files outside the declared
runtime and `assets/`, duplicate or case-colliding paths, links, encryption,
path traversal and Windows-incompatible names. The signed archive stays
compressed at rest and is revalidated before every bundle load.

The editor supplies shared APIs through a capability broker. An extension never
embeds a JavaScript engine and never receives direct native filesystem or Tauri
IPC access. User-facing extension configuration is a signed contribution. Its
native Settings renderer is schema-driven; executable overrides require an
explicit file selection and native validation, are stored atomically per
extension and are read-only to Worker code.

Process execution is available only through an exact manifest grant with a
declared working directory. The executable source is either an immutable
literal or a reference to an executable configuration property declared by the
same signed manifest. The signed grant owns argument order and shape: literals
are immutable, while typed workspace file and directory slots accept only
runtime `file:` URIs whose read/write containment and allowed file extensions
are validated natively. It never accepts an untyped caller-supplied argument
list or a shell string. Canonical Windows paths are converted from the verbatim
`\\?\` representation only after validation so native tools receive compatible
arguments. The worker can request only capabilities declared in its own signed
manifest.

## Enforced size budget

| Artifact | Recommendation | Hard limit |
| --- | ---: | ---: |
| Manifest | - | 64 KiB |
| Worker bundle | 256 KiB | 2 MiB |
| Compressed package | - | 10 MiB |
| Uncompressed package | - | 20 MiB |

The native core rejects hard-limit violations and reports when a worker exceeds
the recommendation. Installation keeps the signed package compressed at rest,
retains the active and rollback slots, activates on demand and disposes workers
deterministically. Publisher trust is keyed by the SHA-256 digest of the public
key, and installation verifies the inspected package hash again to close the
review/install race.

## Consequences

- The API evolves through explicit manifest and protocol versions.
- Extension packages remain small because shared behavior stays in the host.
- There is no tolerant parser or alternate runtime that can bypass the native
  capability model.
- A Web Worker is a stability and ownership boundary, not an operating-system
  sandbox. Trusting a publisher remains an explicit security decision.
