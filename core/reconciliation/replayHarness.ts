// Placeholder implementation of a deterministic replay harness for tests.
// In the real codebase this would integrate with the existing reconciliation
// engine. Here we provide a minimal in‑memory implementation sufficient for the
// unit tests added in `deterministic-replay.test.ts`.

export interface ReplayEvent {
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  /** Optional custom executor used by the test harness */
  execute?: () => any;
}

export interface ReplayOptions {
  retries?: number;
  authorizedActors?: string[];
}

export class ReplayHarness {
  private events: ReplayEvent[] = [];
  private opts: ReplayOptions;

  constructor(opts: ReplayOptions = {}) {
    this.opts = opts;
  }

  recordEvent(event: ReplayEvent) {
    this.events.push(event);
  }

  async replay() {
    const state: Record<string, any> = {};
    for (const ev of this.events) {
      // Authorization check
      if (
        this.opts.authorizedActors &&
        !this.opts.authorizedActors.includes(ev.actor)
      ) {
        throw new Error(`unauthorized actor ${ev.actor}`);
      }

      // Execution handling – if a custom executor is supplied use it
      const exec = ev.execute ?? (() => this.applyEvent(state, ev));
      let attempt = 0;
      const maxAttempts = (this.opts.retries ?? 0) + 1;
      while (true) {
        try {
          const result = await exec();
          // If the custom executor returns a result, merge it into state
          if (result && typeof result === "object") Object.assign(state, result);
          break; // success
        } catch (e) {
          attempt++;
          if (attempt >= maxAttempts) throw e;
          // retry loop continues
        }
      }
    }
    return { state };
  }

  private applyEvent(state: Record<string, any>, ev: ReplayEvent) {
    // Very simple increment example used by the tests
    if (ev.type === "increment" && typeof ev.payload.key === "string") {
      const key = ev.payload.key as string;
      const delta = Number(ev.payload.delta ?? 1);
      state[key] = (state[key] ?? 0) + delta;
    } else if (ev.type === "error") {
      throw new Error("forced error");
    }
    // other types could be added later
    return state;
  }
}
