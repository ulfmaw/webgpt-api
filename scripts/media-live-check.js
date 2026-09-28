import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import OpenAI from "openai";
import { PNG } from "pngjs";
import { initialize, dataDirectory } from "../src/settings.js";
const client = new OpenAI({ baseURL: "http://127.0.0.1:17841/v1", apiKey: initialize(dataDirectory()).key, maxRetries: 0, timeout: 120_000 });
try {
  const value = randomBytes(12).toString("hex");
  const file = await client.responses.create({ model: "auto", input: [{ role: "user", content: [{ type: "input_text", text: "Read the attached text file and reply with its exact entire content only. No explanation." }, { type: "input_file", filename: "verification.txt", file_data: "data:text/plain;base64," + Buffer.from(value).toString("base64") }] }], store: false });
  assert.equal(file.output_text.trim(), value); console.log(JSON.stringify({ test: "live_inline_text_file", passed: true, model: file.model }));
  const colors = [{ name: "red", rgb: [255, 0, 0] }, { name: "blue", rgb: [0, 0, 255] }, { name: "yellow", rgb: [255, 255, 0] }];
  const color = colors[randomInt(colors.length)], png = new PNG({ width: 256, height: 256 });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set([...color.rgb, 255], offset);
  const image = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: [{ type: "text", text: "What color fills this image? Reply with one lowercase English color name only." }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG.sync.write(png).toString("base64") } }] }] });
  assert.equal(image.choices[0].message.content.trim().toLowerCase(), color.name); console.log(JSON.stringify({ test: "live_image_input", passed: true, model: image.model }));
} catch (error) { console.error(JSON.stringify({ passed: false, code: error.code ?? error.name, status: error.status ?? null, message: error.error?.message ?? "Live media assertion failed" })); process.exitCode = 1; }
