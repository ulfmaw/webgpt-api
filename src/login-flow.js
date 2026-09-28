import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "./errors.js";

export async function waitForAuthenticatedSession({ probe, isClosed = () => false,
  signal, timeout = 600_000, now = Date.now, sleep = delay }) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    signal?.throwIfAborted();
    if (isClosed()) throw new Fault(409, "login_window_closed", "The login window closed before authentication finished.");
    const session = await probe();
    signal?.throwIfAborted();
    if (typeof session?.accessToken === "string" && session.accessToken.length >= 20 && !/\s/.test(session.accessToken)) return session;
    await sleep(1500, undefined, { signal });
  }
  throw new Fault(408, "login_timeout", "Login timed out. No login window will be reopened automatically.");
}
