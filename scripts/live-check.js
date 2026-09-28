// End-to-end live smoke test. Prints only our synthetic test answers and statuses.
import { BrowserTransport } from "../src/transports/browser.js";
import { dataDirectory } from "../src/settings.js";
import { Engine, validateRequest } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { publicError } from "../src/errors.js";

const transport = new BrowserTransport(dataDirectory());
const store = new ConversationStore(":memory:");
try {
  const engine = new Engine(transport, store);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    let result;
    const started = Date.now();
    const model = process.argv.find(argument => argument.startsWith("--model="))?.slice(8) ?? "auto";
    for await (const event of engine.run(validateRequest({ model, input: "Reply only: OK", store: false }), controller.signal)) {
      if (event.kind === "done") result = { text: event.text, model: event.model, stored: event.stored, elapsed_ms: Date.now() - started };
    }
    console.log(JSON.stringify({ result }));
  } finally { clearTimeout(timer); }
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
finally { await transport.close(); store.close(); }
