# ADR 0001: Independent extension systems

## Status

Accepted.

## Decision

Sideral Editor has two physically independent extension systems:

1. The modern Sideral system uses its own versioned manifest, capability model,
   type-only SDK and worker runtime contract.
2. The compatibility system inspects third-party VS Code manifests and will own
   any future compatibility hosts or adapters.

Neither system can import source, types, manifests, protocols or packages from
the other. They may meet only in the application composition module
`src-tauri/src/extension_systems.rs`, where each result keeps its original type.
The automated architecture check rejects cross-system references.

## Modern package contract

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
IPC access. Process execution is available only through an exact, fixed
manifest grant and never accepts caller-supplied arguments or a shell string.
The worker can request only capabilities declared in its own signed manifest.

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

## Compatibility boundary

The compatibility core accepts the broader third-party manifest shape and
classifies packages as declarative, web, Node or hybrid. A Node entry is always
reported as requiring a trusted process. Inspection does not authorize
execution. Future compatibility execution must live in separate processes and
must not reuse or influence the modern capability protocol.

## Consequences

- The modern API can evolve without historical compatibility constraints.
- Compatibility work cannot enlarge or destabilize modern extension packages.
- Extension packages remain small because shared behavior stays in the host.
- Supporting two systems costs an explicit composition layer and separate test
  suites, which is preferable to hidden coupling.
- A Web Worker is a stability and ownership boundary, not an operating-system
  sandbox. Trusting a publisher remains an explicit security decision.
