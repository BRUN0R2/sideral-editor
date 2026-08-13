# ADR 0002: Deterministic extension runtime

## Status

Accepted.

## Context

Extension startup previously depended on delays and timeout-shaped coordination.
That makes success depend on machine speed, hides invalid state transitions and
allows late work to mutate a runtime that the application already considers
stopped.

## Decision

The modern runtime uses explicit acknowledgements and generation-scoped state:

```text
dormant -> starting -> activating -> active -> stopping -> stopped
              |             |          |            |
              +-------------+----------+------------+-> failed
```

- Rust owns the registry, trust store, runtime state machine, generations,
  command routing, capability enforcement and persisted data.
- The main document owns one trusted supervisor for its complete lifetime. It
  establishes and negotiates the native session before initialization and never
  exposes its random native-session token to an extension Worker.
- Every active extension owns one ESM Web Worker and one serial command lane.
  Different extensions can start and execute independently.
- `ready`, `activated`, `commandResult` and `deactivated` are explicit protocol
  acknowledgements. No sleep, polling loop or arbitrary startup delay is part
  of successful coordination.
- Commands contributed by a manifest imply command activation. Workbench and
  language activation are explicit events. A maximum of eight independent
  activations may start concurrently.
- A deactivation invalidates its generation immediately, cancels native broker
  work and aborts any bundle startup in progress. Late events from that
  generation are ignored. A newer generation is the only recovery path.
- Cancellation that reaches Rust before its broker request is retained as a
  bounded early-cancellation marker, so transport ordering cannot lose it.
- Extension commands are serial per extension. Nested calls to commands owned
  by the same extension execute locally, with cycle and depth checks, rather
  than deadlocking behind their own command lane.
- Every disposable registered by an extension is attempted in reverse order.
  One cleanup failure cannot prevent the remaining resources from being
  released.

Startup, activation, command and shutdown deadlines remain as finite safety
boundaries (5 s, 10 s, 30 s and 2 s respectively). They are not scheduling
mechanisms. Crossing one terminates or invalidates the owned runtime; the timed
out operation cannot complete later and become authoritative.

## Capability boundary

Workers receive a small typed API. Rust validates every request against the
signed manifest and enforces payload, response, concurrency and storage limits.
Workspace paths are canonical and contained, text writes use optimistic
versions and atomic replacement, file search has deterministic traversal,
network destinations are DNS-validated and pinned, and processes use fixed
grants resolved outside the workspace with an explicit workspace or isolated
extension-data working directory.

A Web Worker is not an OS security sandbox. It protects the workbench from a
crashed or blocked extension and removes direct native authority. Installation
still requires a valid signature and explicit publisher-key trust. Process
grants deserve the same scrutiny as installing a native tool.

## Observability and recovery

The UI receives monotonic snapshots and shows state, activation reason, last
activation duration, activation count, command count, failure count, last
command duration and the latest structured error. Host failure terminates all
owned Workers, cancels broker work, invalidates the native session and advances
every generation. A failed extension requires an explicit restart; a failed
supervisor requires a fresh main-document lifecycle instead of an implicit
retry.

## Consequences

- Normal startup duration is determined by actual work, not a configured delay.
- Shutdown and disable operations have a bounded, owned termination path.
- Extensions cannot enlarge native authority by forging a frontend request.
- Serial command execution favors predictable state over intra-extension
  throughput; independent extensions remain parallel.
- Supporting another API version requires an explicit protocol negotiation and
  versioned contract decision rather than an implicit fallback.
