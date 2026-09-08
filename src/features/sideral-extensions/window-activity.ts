import type { Disposable, WindowActivityState } from "@sideral/extension-sdk";

export const WINDOW_IDLE_AFTER_MILLISECONDS: number = 5 * 60 * 1_000;

const WINDOW_ACTIVITY_EVENT_TYPES = [
  "focus",
  "keydown",
  "pointerdown",
  "pointermove",
  "wheel",
] as const;
const EVENT_LISTENER_OPTIONS: AddEventListenerOptions = {
  capture: true,
  passive: true,
};

export interface WindowActivityClock {
  now(): number;
  setTimer(callback: () => void, delayMilliseconds: number): number;
  clearTimer(timerId: number): void;
}

const BROWSER_CLOCK: WindowActivityClock = {
  now: () => globalThis.performance.now(),
  setTimer: (callback, delayMilliseconds) => window.setTimeout(callback, delayMilliseconds),
  clearTimer: (timerId) => window.clearTimeout(timerId),
};

export class WindowActivityMonitor implements Disposable {
  readonly #clock: WindowActivityClock;
  readonly #idleAfterMilliseconds: number;
  readonly #onStateChange: (state: WindowActivityState) => void;
  #deadline: number;
  #state: WindowActivityState = "active";
  #timerId: number | null = null;
  #disposed = false;

  constructor(
    onStateChange: (state: WindowActivityState) => void,
    idleAfterMilliseconds: number = WINDOW_IDLE_AFTER_MILLISECONDS,
    clock: WindowActivityClock = BROWSER_CLOCK,
  ) {
    if (!Number.isFinite(idleAfterMilliseconds) || idleAfterMilliseconds <= 0) {
      throw new RangeError("The window idle delay must be a positive finite number.");
    }
    this.#clock = clock;
    this.#idleAfterMilliseconds = idleAfterMilliseconds;
    this.#onStateChange = onStateChange;
    this.#deadline = clock.now() + idleAfterMilliseconds;
    this.#schedule(idleAfterMilliseconds);
  }

  recordActivity(): void {
    if (this.#disposed) {
      return;
    }
    this.#deadline = this.#clock.now() + this.#idleAfterMilliseconds;
    if (this.#timerId === null) {
      this.#schedule(this.#idleAfterMilliseconds);
    }
    if (this.#state === "idle") {
      this.#state = "active";
      this.#onStateChange("active");
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#timerId !== null) {
      this.#clock.clearTimer(this.#timerId);
      this.#timerId = null;
    }
  }

  #schedule(delayMilliseconds: number): void {
    this.#timerId = this.#clock.setTimer(
      () => this.#evaluateDeadline(),
      Math.max(0, delayMilliseconds),
    );
  }

  #evaluateDeadline(): void {
    this.#timerId = null;
    if (this.#disposed) {
      return;
    }
    const remainingMilliseconds = this.#deadline - this.#clock.now();
    if (remainingMilliseconds > 0) {
      this.#schedule(remainingMilliseconds);
      return;
    }
    if (this.#state === "active") {
      this.#state = "idle";
      this.#onStateChange("idle");
    }
  }
}

export function observeWindowActivity(
  onStateChange: (state: WindowActivityState) => void,
): Disposable {
  const monitor = new WindowActivityMonitor(onStateChange);
  const recordActivity = () => monitor.recordActivity();
  for (const eventType of WINDOW_ACTIVITY_EVENT_TYPES) {
    globalThis.addEventListener(eventType, recordActivity, EVENT_LISTENER_OPTIONS);
  }
  return {
    dispose() {
      for (const eventType of WINDOW_ACTIVITY_EVENT_TYPES) {
        globalThis.removeEventListener(eventType, recordActivity, EVENT_LISTENER_OPTIONS);
      }
      monitor.dispose();
    },
  };
}
