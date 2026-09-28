import { Fault } from "./errors.js";

export class Gate {
  active = 0;
  waiting = [];
  constructor(limit = 1, queueLimit = 16) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("Concurrency must be 1–16.");
    this.limit = limit;
    this.queueLimit = queueLimit;
  }
  async enter(signal) {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queueLimit) throw new Fault(429, "queue_full", "Local request queue is full.");
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, abort: null };
        waiter.abort = () => {
          const i = this.waiting.indexOf(waiter);
          if (i !== -1) this.waiting.splice(i, 1);
          reject(signal.reason);
        };
        signal?.addEventListener("abort", waiter.abort, { once: true });
        this.waiting.push(waiter);
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.abort);
        next.resolve();
      } else this.active--;
    };
  }
}
