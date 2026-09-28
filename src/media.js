import { createHash } from "node:crypto";
import { Fault } from "./errors.js";
const types = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"], ["application/pdf", "pdf"], ["text/plain", "txt"], ["text/csv", "csv"]]);
const reject = message => { throw new Fault(400, "unsupported_media", message); };

export function contentParts(parts, role) {
  const text = [], attachments = [];
  for (const part of parts) {
    if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") { text.push(part.text); continue; }
    if (role !== "user") reject("Attachments currently require a user message.");
    const image = ["input_image", "image_url"].includes(part?.type);
    const file = ["input_file", "file"].includes(part?.type);
    if (!image && !file) reject("Only text, inline images and inline PDF/text/CSV files are supported.");
    const source = part.type === "file" ? part.file : part;
    const url = image ? (part.type === "image_url" ? part.image_url?.url : part.image_url) : source?.file_data;
    const detail = part.type === "image_url" ? part.image_url?.detail : part.detail;
    if (image && detail && detail !== "auto") reject("Independent image detail control is not available; use auto.");
    if (typeof url !== "string") reject("Supply inline base64 data; file IDs, local paths and remote URLs are not accepted.");
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || !types.has(match[1]) || (image && !match[1].startsWith("image/"))) reject("Supply a supported base64 data URL (PNG/JPEG/WebP/GIF/PDF/text/CSV).");
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.length > 5 * 1024 * 1024 || data.toString("base64") !== match[2]) reject("Attachment must contain canonical base64 and be at most 5 MiB.");
    const filename = image ? `image.${types.get(match[1])}` : source.filename;
    if (typeof filename !== "string" || !filename.length || filename.length > 100 || /[\\/:\x00-\x1f]/.test(filename) || filename === "." || filename === "..") reject("Files require a plain filename, not a path.");
    attachments.push({ mime: match[1], filename, base64: match[2], hash: createHash("sha256").update(data).digest("hex") });
  }
  return { content: text.join(""), ...(attachments.length ? { attachments } : {}) };
}

export function prepareMedia(records) {
  const attachments = [], names = new Map(); let bytes = 0;
  const input = records.map(record => {
    if (!record.attachments?.length) return record;
    const labels = record.attachments.map(file => {
      const identity = file.hash + ":" + file.filename;
      let name = names.get(identity);
      if (!name) {
        name = `attachment-${attachments.length + 1}-${file.filename}`; names.set(identity, name);
        bytes += Buffer.byteLength(file.base64, "base64"); attachments.push({ ...file, filename: name });
      }
      return { filename: name, mime: file.mime };
    });
    const { attachments: ignored, ...message } = record;
    return { ...message, attachments: labels };
  });
  if (attachments.length > 10 || bytes > 8 * 1024 * 1024) throw new Fault(413, "attachments_too_large", "At most 10 attachments and 8 MiB total are supported across the conversation; no files were omitted.");
  return { input, attachments };
}
