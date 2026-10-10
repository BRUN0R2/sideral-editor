# ADR 0004: Isolated extensions with shared tooling and extension-owned previews

## Status

Accepted.

## Decision

Every extension lives under `extensions/<name>` and owns its manifest, source,
tests, runtime dependency declarations and Worker bundle. npm workspaces share
one root lockfile and hoisted build tools; duplicating TypeScript, Vitest and
Rolldown installations per extension adds disk usage without runtime isolation.
SDK and testkit packages are the public development boundary. Application source
must never import an extension implementation, and extensions must never import
application or native backend modules. Editor and extension bundles are separate.

Protocol 4 replaces language-specific preview text with a bounded visual
tree. Extensions own language parsing and visual document presentation;
the host owns strict validation, generic element rendering, native link
actions, resource lifetime and source-document event delivery. No preview
language parser or extension-specific renderer belongs in the host.

Visual trees contain only inert text, allowlisted semantic elements,
attributes and inline styles. Both Rust and the frontend validate the same
shape and limits. Event handlers, resource-loading CSS, positioning,
executable elements and unsupported link schemes are rejected. Preview
source updates are delivered only to the active owning Worker with a read
grant and processed on its existing serial operation lane.

The previous `format: "markdown"` preview contract is removed, without an
adapter or fallback. Markdown Preview now uses `format: "tree"` and is built
and packaged independently. The editor release pipeline builds and stages
each extension as a separate artifact without running extension tests;
the explicit repository gate checks the extensions separately.
