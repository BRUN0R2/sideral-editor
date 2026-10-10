# ADR 0002: Deterministic extension runtime

## Status

Accepted.

## Context

Delay-based startup makes results depend on machine speed and lets late work
mutate state after the host considers an extension stopped.

## Decision

Use explicit acknowledgements and generation-scoped ownership. Rust owns the
registry, trust, state machine, command routing and native broker. One main-document
supervisor negotiates the native session without exposing its token to Workers.
Each active extension owns one Worker and one serial command/event lane.

`ready`, `activated`, `commandResult` and `deactivated` acknowledge actual work.
No sleep, polling loop or arbitrary delay coordinates success. Workbench/language
events are explicit; contributed commands imply command activation. Up to eight
independent activations may start concurrently.

Disable or reload immediately invalidates the generation, cancels broker requests
and aborts startup. Bounded early-cancellation markers preserve cancellation that
arrives before its request. Late generation results cannot become authoritative.
Nested commands owned by the same extension execute locally with cycle/depth
checks. Cleanup attempts every subscription in reverse order.

Startup, activation, command and shutdown have finite safety deadlines of 5, 10,
30 and 2 seconds. Deadlines terminate or invalidate work; they never schedule
normal startup.

Native requests remain bounded and capability-validated. Canonical workspace
containment, atomic versioned writes, deterministic search, DNS-pinned networking
and fixed process grants protect native authority. Process working directories
are explicit: workspace, extension data or executable directory.

## Consequences

- Startup duration reflects actual work.
- Disable and shutdown have bounded owned termination paths.
- Independent extensions remain concurrent; each extension's state is serialized.
- Monotonic snapshots expose reason, state, durations, counters and structured
  errors.
- A failed extension requires explicit restart. Host failure closes all Workers,
  cancels requests and invalidates the session; supervisor recovery requires a
  fresh main-document lifecycle.
- New protocol support requires an explicit contract decision, never a fallback.
