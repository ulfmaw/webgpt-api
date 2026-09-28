import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "../errors.js";

export async function attachFiles(connection, attachments, directory, signal) {
  if (!attachments?.length) return () => {};
  const temp = mkdtempSync(join(directory, "upload-")), paths = [];
  let released = false;
  const release = () => {
    if (released) return;
    for (const path of paths) { try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    rmdirSync(temp); released = true;
  };
  try {
    for (const file of attachments) {
      if (!file.filename || /[\\/:\x00-\x1f]/.test(file.filename)) throw new Fault(400, "invalid_attachment", "Invalid attachment filename.");
      const path = join(temp, file.filename); paths.push(path);
      writeFileSync(path, Buffer.from(file.base64, "base64"), { mode: 0o600, flag: "wx" });
    }
    signal.throwIfAborted();
    let hydrated = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      const state = await connection.call("Runtime.evaluate", { expression: `(()=>{const e=document.querySelector('input[type="file"][multiple]:not([accept])');const key=e&&Object.keys(e).find(k=>k.startsWith('__reactProps$'));return !!e&&!e.disabled&&typeof e[key]?.onChange==='function';})()`, returnByValue: true });
      if (state.result?.value === true) { hydrated = true; break; }
      await delay(250, undefined, { signal });
    }
    if (!hydrated) throw new Fault(503, "upload_control_unavailable", "The website attachment control has not finished initializing.");
    const { root } = await connection.call("DOM.getDocument", { depth: 0 });
    const { nodeId } = await connection.call("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"][multiple]:not([accept])' });
    if (!nodeId) throw new Fault(503, "upload_control_unavailable", "The website attachment control is unavailable.");
    await connection.call("DOM.setFileInputFiles", { nodeId, files: paths }, 20_000);
    for (let attempt = 0; attempt < 120; attempt++) {
      signal.throwIfAborted();
      const state = await connection.call("Runtime.evaluate", { expression: `(()=>{const names=${JSON.stringify(attachments.map(f => f.filename))};const composer=document.querySelector('[contenteditable="true"][role="textbox"]');const form=composer?.closest('form');if(!form)return false;const clone=form.cloneNode(true);for(const e of clone.querySelectorAll('[contenteditable],textarea,input'))e.remove();const found=names.every(name=>clone.textContent.includes(name)||[...clone.querySelectorAll('[aria-label],img[alt]')].some(e=>e.getAttribute('aria-label')===name||e.getAttribute('alt')===name));const send=form.querySelector('[data-testid="send-button"],button[type="submit"]');return found&&!!send&&!send.disabled;})()`, returnByValue: true });
      if (state.result?.value === true) return release;
      await delay(500, undefined, { signal });
    }
    throw new Fault(503, "upload_not_ready", "The website did not accept every attachment or finish preparing the message. No message was sent.");
  } catch (error) { release(); throw error; }
}
