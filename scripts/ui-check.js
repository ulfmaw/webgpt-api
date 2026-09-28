// Sends one explicit smoke-test prompt through the normal site's composer.
// Network headers, raw stream bodies, account data and credentials are never logged.
import { interactiveLogin } from "../src/login.js";
import { dataDirectory } from "../src/settings.js";
import { publicError } from "../src/errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { WebEventDecoder } from "../src/transports/web-events.js";

try {
  await interactiveLogin(dataDirectory(), { timeout: 60_000, background: process.argv.includes("--headless") ? "headless" : process.argv.includes("--background"), onAuthenticated: async connection => {
    const selected = process.argv.find(a=>a.startsWith('--model='))?.slice(8);
    if (selected) await connection.call("Page.navigate", { url: `https://chatgpt.com/?temporary-chat=true&model=${encodeURIComponent(selected)}` });
    const requests = new Map();
    const results = [];
    const streamed = new Map();
    let streamDone = false;
    const decoder = new TextDecoder();
    connection.on("Network.dataReceived", event => {
      const stream = streamed.get(event.requestId);
      if (stream && event.data) {
        stream.chunks.push(Buffer.from(event.data, "base64"));
        if (decoder.decode(Buffer.from(event.data, "base64")).includes("[DONE]")) streamDone = true;
      }
    });
    connection.on("Network.requestWillBeSent", event => {
      const url = new URL(event.request.url);
      if (url.origin === "https://chatgpt.com" && event.request.method === "POST" && url.pathname.includes("conversation")) {
        let keys = [], model, preparation; try { const body=JSON.parse(event.request.postData ?? "{}");keys = Object.keys(body);model=body.model;if(url.pathname.endsWith('/prepare'))preparation={stateType:typeof body.client_prepare_state,state:typeof body.client_prepare_state==='string'&&body.client_prepare_state.length<30?body.client_prepare_state:undefined,dispatch:body.client_prepare_dispatch,source:body.client_prepare_source,partialType:typeof body.partial_query,partialKeys:body.partial_query&&typeof body.partial_query==='object'?Object.keys(body.partial_query):undefined}; } catch {}
        requests.set(event.requestId, { path: url.pathname, keys, model, preparation, headerNames:Object.keys(event.request.headers??{}).filter(k=>!/^sec-|^user-agent|^accept/i.test(k)) });
      }
    });
    connection.on("Network.responseReceived", event => {
      if (!requests.has(event.requestId)) return;
      const info = requests.get(event.requestId);
      info.status = event.response.status; info.type = event.response.mimeType;
      if (info.type === "text/event-stream") {
        const stream = { chunks: [], buffered: null }; streamed.set(event.requestId, stream);
        connection.call("Network.streamResourceContent", { requestId: event.requestId }).then(result => {
          stream.buffered = Buffer.from(result.bufferedData, "base64");
          if (stream.buffered.includes(Buffer.from("[DONE]"))) streamDone = true;
        }).catch(() => { stream.error = true; });
      }
    });
    connection.on("Network.loadingFinished", event => {
      if (requests.has(event.requestId)) results.push({ id: event.requestId, ...requests.get(event.requestId) });
    });
    await connection.call("Network.enable", { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await connection.call("Runtime.evaluate", { expression: `(()=>{const e=document.querySelector('[contenteditable="true"][role="textbox"]');if(!e)return false;e.focus();return document.activeElement===e;})()`, returnByValue: true });
      if (result.result?.value === true) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw new Error("Composer not found");
    if (process.argv.includes("--select-sol")) {
      await delay(1500);
      await connection.call("Runtime.evaluate", { expression: `document.querySelector('button[aria-label="選取 ChatGPT 模型"]')?.click()` });
      await delay(500);
      const selection = await connection.call("Runtime.evaluate", { expression: `(()=>{const e=[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.innerText.trim()==='GPT-5.6 Sol');if(!e)return false;e.click();return true;})()`, returnByValue: true });
      if (selection.result?.value !== true) throw Error("Observed Sol option is unavailable");
      await delay(1000);
      const label = await connection.call("Runtime.evaluate", { expression: `document.querySelector('button[aria-label="選取 ChatGPT 模型"]')?.innerText`, returnByValue: true });
      console.log(JSON.stringify({ selectedSol: true, modelLabel: label.result?.value }));
    }
    if (process.argv.includes("--inspect-model")) {
      await delay(1500);
      const options = await connection.call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll('button,[role="button"]')].map(e=>({text:e.innerText,label:e.getAttribute('aria-label'),testid:e.getAttribute('data-testid')})).filter(e=>/gpt|model|thinking|instant|sol|pro/i.test([e.text,e.label,e.testid].join(' '))).slice(0,25))`, returnByValue: true });
      console.log(JSON.stringify({ modelControls: options.result?.value }));
      await connection.call("Runtime.evaluate", { expression: `document.querySelector('button[aria-label="選取 ChatGPT 模型"]')?.click()` });
      await delay(500);
      const menu = await connection.call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],[role="dialog"]')].map(e=>({role:e.getAttribute('role'),text:e.innerText,checked:e.getAttribute('aria-checked')})).slice(0,20))`, returnByValue: true });
      console.log(JSON.stringify({ modelMenu: menu.result?.value }));
      if (process.argv.includes("--inspect-tier")) {
        const tier = await connection.call("Runtime.evaluate", { expression: `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>/^5\\.6\\s+Pro$/.test(e.innerText.trim()));if(!e)return false;e.click();return true;})()`, returnByValue: true });
        if (tier.result?.value !== true) throw Error("Observed Sol Pro tier control is unavailable");
        await delay(500);
        const tiers = await connection.call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll('[role="menu"]')].map(e=>e.innerText.slice(0,1500)))`, returnByValue: true });
        console.log(JSON.stringify({ tierMenu: tiers.result?.value }));
        const sliders = await connection.call("Runtime.evaluate", { expression: `JSON.stringify([...document.querySelectorAll('[role="slider"],input[type="range"]')].map(e=>({role:e.getAttribute('role'),label:e.getAttribute('aria-label'),value:e.getAttribute('aria-valuenow'),min:e.getAttribute('aria-valuemin'),max:e.getAttribute('aria-valuemax'),valueText:e.getAttribute('aria-valuetext'),disabled:e.getAttribute('aria-disabled')})))`, returnByValue: true });
        console.log(JSON.stringify({ tierSliders: sliders.result?.value }));
      }
      return;
    }
    if (process.argv.includes("--sdk-info")) {
      const sdk = await connection.call("Runtime.evaluate", { expression: `JSON.stringify({globals:Object.keys(window).filter(k=>/sentinel/i.test(k)).map(k=>({name:k,type:typeof window[k],keys:window[k]&&typeof window[k]==='object'?Object.keys(window[k]):undefined})),scripts:performance.getEntriesByType('resource').map(e=>new URL(e.name)).filter(u=>/sentinel|turnstile/i.test(u.hostname+u.pathname)).map(u=>u.origin+u.pathname)})`, returnByValue: true });
      console.log(JSON.stringify({sdk:sdk.result?.value}));return;
    }
    await connection.call("Runtime.evaluate", { expression: `window.getSelection().selectAllChildren(document.querySelector('[contenteditable="true"][role="textbox"]'))` });
    await connection.call("Input.insertText", { text: "Reply only: OK" });
    await delay(750);
    const compose = await connection.call("Runtime.evaluate", { expression: `JSON.stringify({textLength:document.querySelector('[contenteditable="true"][role="textbox"]')?.innerText.length,buttons:[...document.querySelectorAll('button,[role="button"]')].map(e=>({label:e.getAttribute('aria-label')??e.getAttribute('title')??e.innerText,disabled:!!e.disabled})).filter(e=>/send|傳送|发送|送出|stop|停止/i.test(e.label??''))})`, returnByValue: true });
    console.log(JSON.stringify({ composer: compose.result?.value }));
    await connection.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await connection.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 45 && !streamDone && !results.some(r => r.status >= 400); i++) await delay(1000);
    console.log(JSON.stringify({ requestAudit: [...requests.values()].map(r => ({ path: r.path, model: r.model, status: r.status, type: r.type })) }));
    for (const stream of streamed.values()) {
      const text = Buffer.concat([stream.buffered ?? Buffer.alloc(0), ...stream.chunks]).toString();
      const frames = text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim());
      const decoded = new WebEventDecoder();
      const modelAudit = new Map();
      for (const frame of frames) {
        try {
          decoded.push(frame);
          const m = decoded.state?.message;
          if (m) {
            const entry = { role: m.author?.role, channel: m.channel, status: m.status,
              model_slug: m.metadata?.model_slug, default_model_slug: m.metadata?.default_model_slug };
            modelAudit.set(JSON.stringify(entry), entry);
          }
        } catch(error) {
          let e; try {e=JSON.parse(frame);} catch{}
          console.log(JSON.stringify({decoderFailure:{keys:e&&Object.keys(e),op:e?.o,path:e?.p,valueType:typeof e?.v,patches:Array.isArray(e?.v)?e.v.map(x=>({p:x.p,o:x.o,valueType:typeof x.v})):undefined}}));
          throw error;
        }
      }
      console.log(JSON.stringify({ modelAudit: [...modelAudit.values()].slice(0, 24) }));
      decoded.verify();
      console.log(JSON.stringify({ verifiedAnswer: decoded.text, model: decoded.model }));
      console.log(JSON.stringify({ streamBytes: text.length, done: frames.includes("[DONE]"), shapes: frames.filter(f => f !== "[DONE]").slice(0, 25).map(f => {
        try { const e=JSON.parse(f); return { keys:Object.keys(e), type:e.type, op:e.o, path:e.p, valueType:typeof e.v, valueKeys:e.v && typeof e.v==='object'?Object.keys(e.v):undefined, role:e.v?.message?.author?.role, channel:e.v?.message?.channel, status:e.v?.message?.status,patches:e.o==='patch'&&Array.isArray(e.v)?e.v.map(x=>({p:x.p,o:x.o,type:typeof x.v})):undefined }; } catch {return {nonJson:true};}
      }) }));
    }
    console.log(JSON.stringify({ requests: [...requests.values()], completed: results.map(({ id, ...r }) => r) }));
    for (const result of results.filter(r => r.type === "text/event-stream" && r.status === 200)) {
      const response = await connection.call("Network.getResponseBody", { requestId: result.id });
      const text = response.base64Encoded ? Buffer.from(response.body, "base64").toString() : response.body;
      const frames = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
      console.log(JSON.stringify({ completedStream: frames.includes("[DONE]"), shapes: frames.filter(frame => frame !== "[DONE]").slice(0, 15).map(frame => {
        try { const e = JSON.parse(frame); return { keys: Object.keys(e), type: e.type, op: e.o, path: e.p }; } catch { return { nonJson: true }; }
      }) }));
    }
  } });
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
