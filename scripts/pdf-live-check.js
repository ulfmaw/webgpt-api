// Generated synthetic PDF only; no personal files are uploaded.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import OpenAI from "openai";
import { initialize, dataDirectory } from "../src/settings.js";
const client = new OpenAI({ baseURL: "http://127.0.0.1:17841/v1", apiKey: initialize(dataDirectory()).key, maxRetries: 0, timeout: 120_000 });
let stage = "create_fixture", response;
try {
  const marker = randomBytes(10).toString("hex");
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([400, 300]).drawText(marker, { x: 35, y: 200, size: 18, font });
  const bytes = await pdf.save();
  stage = "request";
  response = await client.responses.create({ model: "auto", store: false, input: [{ role: "user", content: [{ type: "input_text", text: "Read the attached PDF. Return exactly the text printed on its page, without explanation." }, { type: "input_file", filename: "verification.pdf", file_data: "data:application/pdf;base64," + Buffer.from(bytes).toString("base64") }] }] });
  stage = "validate_text";
  assert.equal(response.output_text.trim(), marker);
  console.log(JSON.stringify({ test: "live_pdf_input", passed: true, model: response.model }));
} catch (error) { console.error(JSON.stringify({ passed: false, stage, code: error.code ?? error.name, status: error.status ?? null, output_nonempty: Boolean(response?.output_text?.trim()), output_length: response?.output_text?.length ?? null })); process.exitCode = 1; }
