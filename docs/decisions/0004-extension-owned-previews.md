# ADR 0004: Extension-owned previews and shared tooling

## Status

Accepted.

## Decision

Each `extensions/<name>` project owns its manifest, implementation, tests, runtime
dependencies and Worker bundle. npm workspaces share one root lockfile and hoisted
development tools. SDK/testkit packages are the public development boundary.

Application code must not import extension implementations; extensions must not
import application or native modules. Runtime bundles remain independent.

Protocol 4 replaces language-specific preview text with a bounded inert visual
tree. Extensions own parsing and document presentation. The host owns validation,
generic rendering, native links, source events and resource lifetime.

Rust and the frontend validate the same shape and limits. Executable elements,
event handlers, resource-loading CSS, positioning and unsupported links are
rejected. Source changes reach only the active owning Worker with workspace read
access and use its existing serial operation lane.

## Consequences

- Shared build tools avoid duplicate installations without merging runtime graphs.
- Markdown parsing and styling remain in Markdown Preview.
- The previous `format: "markdown"` contract is removed without an adapter or
  fallback; previews use `format: "tree"`.
- Repository release builds stage extensions independently without running their
  tests. The complete gate checks them explicitly.
- Visual-tree and lifecycle limits are documented in the
  [API reference](../EXTENSION-API.md#output-and-previews).
