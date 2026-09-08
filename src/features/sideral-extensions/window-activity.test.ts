import { describe, expect, it } from "vitest";
import { type WindowActivityClock, WindowActivityMonitor } from "./window-activity";

const IDLE_DELAY_MILLISECONDS: number = 1_000;

describe("window activity monitor", () => {
  it("becomes idle only after a full delay without activity", () => {
    const clock = new ManualClock();
    const states: string[] = [];
    const monitor = new WindowActivityMonitor(
      (state) => states.push(state),
      IDLE_DELAY_MILLISECONDS,
      clock,
    );

    clock.advanceBy(900);
    monitor.recordActivity();
    clock.advanceBy(100);
    expect(states).toEqual([]);

    clock.advanceBy(900);
    expect(states).toEqual(["idle"]);
  });

  it("returns to active immediately and cancels its timer on disposal", () => {
    const clock = new ManualClock();
    const states: string[] = [];
    const monitor = new WindowActivityMonitor(
      (state) => states.push(state),
      IDLE_DELAY_MILLISECONDS,
      clock,
    );

    clock.advanceBy(IDLE_DELAY_MILLISECONDS);
    monitor.recordActivity();
    expect(states).toEqual(["idle", "active"]);

    monitor.dispose();
    clock.advanceBy(IDLE_DELAY_MILLISECONDS);
    expect(states).toEqual(["idle", "active"]);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

class ManualClock implements WindowActivityClock {
  readonly #timers = new Map<
    number,
    { readonly deadline: number; readonly callback: () => void }
  >();
  #now = 0;
  #nextTimerId = 1;

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  now(): number {
    return this.#now;
  }

  setTimer(callback: () => void, delayMilliseconds: number): number {
    const timerId = this.#nextTimerId;
    this.#nextTimerId += 1;
    this.#timers.set(timerId, {
      deadline: this.#now + delayMilliseconds,
      callback,
    });
    return timerId;
  }

  clearTimer(timerId: number): void {
    this.#timers.delete(timerId);
  }

  advanceBy(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const due = [...this.#timers]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (due === undefined) {
        break;
      }
      const [timerId, timer] = due;
      this.#now = timer.deadline;
      this.#timers.delete(timerId);
      timer.callback();
    }
    this.#now = target;
  }
}
