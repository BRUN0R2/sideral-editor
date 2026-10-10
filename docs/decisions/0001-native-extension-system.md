# ADR 0001: Native extension system

## Status

Accepted.

## Decision

Sideral has one strict versioned manifest, a declaration-only SDK and an isolated
Web Worker runtime. It does not inspect, adapt or execute another editor's
extension format. Architecture checks reject retired compatibility artifacts.

Extensions ship signed `.sideralx` archives containing a manifest, one ESM Worker
bundle, optional assets and `signature.json`. Ed25519 signatures bind the publisher
identity and canonical file digests. Validation rejects missing/extra files,
duplicate or case-colliding paths, links, encryption, traversal and
Windows-incompatible names. Archives stay compressed and are revalidated on load.

Publisher trust uses the public-key SHA-256 fingerprint. Installation rechecks
the exact reviewed package hash; active and rollback slots retain signed archives.
The [API reference](../EXTENSION-API.md#package-and-trust) defines size budgets.

Rust brokers native authority from exact signed grants. Workspace access is
canonical and contained. Network origins and methods are explicit. Process grants
own executable selection, working directory and typed argument slots; callers
cannot supply shell strings or arbitrary arguments. Settings validates declared
configuration natively and exposes effective values read-only to Workers.

## Consequences

- Shared host behavior keeps packages small; the SDK adds no runtime JavaScript.
- Manifest/API changes require explicit versioned decisions and validation.
- No alternate dialect, adapter, alias, migration or implicit fallback may bypass
  the capability boundary. Such a proposal must first replace this decision and
  the [project rules](../RULES.md).
- Worker isolation contains faults and removes direct native authority; it is not
  an OS sandbox. Signature and publisher trust remain explicit security decisions.
