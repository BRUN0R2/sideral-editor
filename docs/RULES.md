# Project rules

These rules govern implementation and architectural decisions. A proposed change
that conflicts with them must identify the conflict before implementation
continues. Long-term project integrity is mandatory.

When weighing a decision, prioritize project rules, architecture, maintainability,
predictability, security, performance, then development speed. Speed never
justifies architectural degradation.

## Design principles

Keep the project clean, minimal, modular, explicit, predictable and maintainable.
Solve real problems with the least necessary complexity. Prepare modules for
growth without speculative features or destructive rewrites.

- Give each small, cohesive module one clear responsibility.
- Prefer composition, explicit contracts and deterministic flows.
- Keep APIs small; expose inputs, outputs, side effects, failures and state changes.
- Resolve root causes. Avoid temporary fixes, premature abstractions and hidden
  recovery paths that conceal broken initialization.
- Refactoring must simplify the code. Remove dead, obsolete and duplicated logic.
- Prefer the solution with lower future maintenance, clearer debugging, less
  coupling and fewer moving parts.

## Technology and integration

Use supported current stable languages, tools and APIs. The stack is Rust edition
2024, Tauri 2, strict TypeScript and Vite; Windows is the initial operational target.
A new dependency or technology needs a clear purpose, isolated scope and
maintenance cost proportional to its benefit.

Consult current official documentation, release notes and compatibility before
adding or changing an integration. Prefer the platform's official APIs, plugins,
SDKs and libraries. Use a nonofficial implementation only when no official option
meets the real requirement; isolate it and document the technical reason.

Do not add adapters, aliases, migrations or alternate compatibility paths.
Do not preserve obsolete behavior or accumulate intentional technical debt.
Avoid legacy shims and polyfills without a current documented product need.
Modern features should reduce complexity, risk or operating cost; novelty alone
is insufficient.

## Code and naming

- Use strong types, domain types where semantics matter, and structured errors.
- Rust uses explicit ownership and `Result` for recoverable failures. Avoid
  `panic!`, `unwrap` and `expect` outside irrecoverable initialization.
- Avoid unsafe code. If unavoidable, isolate it, document invariants and validate
  them at runtime; the current native workspace forbids project-owned unsafe code.
- TypeScript stays strict. Keep boundary types synchronized with Rust.
- UI calls must use small, explicit, traceable native commands.
- Use descriptive names and camelCase where appropriate. Follow native language
  conventions, including idiomatic Rust names; ecosystem-required snake_case and
  kebab-case are permitted.
- Avoid artificial prefixes, obscure abbreviations, magic numbers, obsolete
  commented code and hidden mutation. Constants need semantic meaning, an
  explicit type and clear context.
- Apply single responsibility, DRY, explicit ownership and explicit lifetimes.

An action crosses one public boundary when one call suffices. Duplicate requests,
equivalent concurrent work, unnecessary polling and repeated effects are
prohibited. Unavoidable simultaneous work needs explicit deduplication,
ownership and cancellation.

## Failure and resource ownership

No silent fallback. An operational fallback is allowed only with deterministic
ordering, bounded scope and an explicit contract. Ignored options and failed
attempts must remain observable even when a later candidate succeeds.

Every listener, watcher, timer, Worker, stream, file, process and asynchronous task
needs an owner and deterministic disposal. Rust uses RAII and structured
concurrency; detached tasks without cancellation and shutdown are prohibited.
TypeScript removes listeners, aborts requests and destroys imperative instances
in the lifecycle that created them.

Resources must not outlive the workspace, document or window that owns them.
Observe long-running heap, handles, threads and tasks during development.
Continuous growth without an identified owner blocks delivery until fixed.
Configuration and file changes must validate their target and be explicit and
reversible where possible.

## Validation and performance

Runtime validation is the primary reliability boundary. Continuously validate
memory safety, ownership, lifetime, initialization order and visible failures.
Prefer meaningful live checks over excessive automated tests. Tests must provide
real value; avoid redundant, noisy or costly tests and debug logging.

Measure before aggressive optimization. Avoid unnecessary allocations and runtime
overhead without trading maintainability for micro-optimizations. Favor stable,
predictable performance. Every dependency must justify its existence; prefer a
small internal solution when its complexity is low. Keep external integrations
isolated and dependencies current and secure.

## Repository and documentation

- Maintain Git history and commit every completed logical change.
- Write short English imperative commit messages describing the actual change.
- Create new branches from `main`.
- Keep documentation current, clear and in English. Keep [TODO](TODO.md) minimal
  and actionable.
- Never commit secrets, credentials, tokens or private data.
- Use LF for text and CRLF only for Batch scripts, as declared in
  [`.gitattributes`](../.gitattributes).
- Avoid unnecessary files, dependencies, assets, logs and tools.

On Windows, background builds, tests, benchmarks, diagnostics and helpers must
run without visible consoles. Use `CreateNoWindow=true` with
`UseShellExecute=false`, or Python `CREATE_NO_WINDOW`, and redirect output and
errors to logs. `WindowStyle Hidden` alone is insufficient. Scheduled helpers
that would expose PowerShell must use a windowless launcher such as `pythonw.exe`.
Show an interactive terminal only when the user requests it.

## UI and automated contributions

Keep UI direct, functional and organized. Controls, visual complexity and
information density need practical value; minimize friction in menus and flows.

Automated contributors must preserve architectural consistency, identify future
maintenance risks and flag rule violations before proceeding. Do not invent APIs
or behavior, implement speculative systems, or leave partial work as completed.

Before finishing, review duplication, dead code, ambiguity, resource ownership,
maintenance impact and architectural consistency. Avoid singleton/service-locator
abuse, hidden globals, circular dependencies, deep inheritance, oversized classes,
runtime-reflection abuse and state mutation without an owner.
