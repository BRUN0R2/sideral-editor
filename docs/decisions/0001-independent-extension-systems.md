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

A production package will use the `.sideralx` extension and contain only:

```text
manifest.json
dist/extension.mjs
assets/*              optional
```

The SDK is a development-only, type-only package. It emits declarations but no
JavaScript, so it adds no runtime bytes to an extension. Extension authors ship
one minified, tree-shaken ESM worker bundle. Packages must not contain
`node_modules`, source files, tests, caches or source maps.

The editor supplies shared APIs through a capability broker. An extension never
embeds a JavaScript engine and never receives direct native filesystem, process
or shell access. The worker can request only capabilities declared in its own
manifest. Native WebAssembly may be an optional asset for measured compute-heavy
workloads; it is not the default extension format.

## Enforced size budget

| Artifact | Recommendation | Hard limit |
| --- | ---: | ---: |
| Manifest | - | 64 KiB |
| Worker bundle | 256 KiB | 2 MiB |
| Compressed package | - | 10 MiB |

The native core rejects hard-limit violations and reports when a worker exceeds
the recommendation. Future package installation must keep the signed package
compressed at rest, retain only the active and rollback versions, activate on
demand and dispose idle workers deterministically.

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
