import { join } from "node:path";
import { ConversationStore } from "./state.js";
import { Engine } from "./engine.js";
import { createLocalServer } from "./http.js";
import { BrowserTransport } from "./transports/browser.js";
import { configureNetwork } from "./network.js";
import { ModelSelection } from "./model-selection.js";

export function createRuntime(directory, key) {
  configureNetwork();
  const store = new ConversationStore(join(directory, "conversations.sqlite"));
  const transport = new BrowserTransport(directory);
  const engine = new Engine(transport, store);
  const selection = new ModelSelection(directory, engine, () => transport.options());
  engine.selection = selection;
  const control = {};
  const app = createLocalServer({ key, engine, selection, control });
  let closing;
  return { store, transport, engine, app, selection, control,
    close() {
      return closing ??= (async () => { await app.close(); await transport.close(); store.close(); })();
    },
  };
}
