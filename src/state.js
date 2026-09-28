import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { Fault } from "./errors.js";
import { randomUUID } from "node:crypto";

// Each row holds only this turn's delta, not another copy of the whole conversation.
// O(new input + output) writes; history is reconstructed only when a client continues.
export class ConversationStore {
  constructor(path, { ttl = 24 * 3600_000, maxBytes = 64 * 1024 * 1024, clock = Date.now } = {}) {
    this.ttl = ttl;
    this.maxBytes = maxBytes;
    this.clock = clock;
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, parent TEXT, input TEXT NOT NULL, output TEXT NOT NULL,
        model TEXT NOT NULL, expires INTEGER NOT NULL, bytes INTEGER NOT NULL
      );`);
    if (!this.db.prepare("PRAGMA table_info(turns)").all().some(column => column.name === "details")) this.db.exec("ALTER TABLE turns ADD COLUMN details TEXT");
  }

  history(id, maxBytes = 32 * 1024 * 1024) {
    const chunks = [];
    const visited = new Set();
    let size = 0;
    while (id) {
      if (visited.has(id) || visited.size >= 1000) throw new Fault(409, "history_invalid", "Conversation lineage is invalid or too long.");
      visited.add(id);
      const row = this.db.prepare("SELECT * FROM turns WHERE id = ? AND expires > ?").get(id, this.clock());
      if (!row) throw new Fault(409, "history_missing", "Local history is missing or expired. Send the full conversation; no partial context was submitted.");
      size += row.bytes;
      if (size > maxBytes) throw new Fault(413, "history_too_large", "Conversation exceeds the local context safety limit; nothing was truncated.");
      chunks.push([...JSON.parse(row.input), ...JSON.parse(row.output)]);
      id = row.parent;
    }
    return chunks.reverse().flat();
  }

  save({ id, parent = null, input, output, model, details = { created: Math.floor(this.clock() / 1000), itemId: `msg_${randomUUID()}` } }) {
    const encodedInput = JSON.stringify(input);
    const encodedOutput = JSON.stringify(output);
    const bytes = Buffer.byteLength(encodedInput) + Buffer.byteLength(encodedOutput);
    if (bytes > this.maxBytes) throw new Fault(507, "storage_full", "Response cannot fit the local history limit.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM turns WHERE expires <= ?").run(this.clock());
      if (parent) this.history(parent);
      const total = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM turns").get().total;
      // Do not evict ancestors silently: a full store is an explicit error.
      if (total + bytes > this.maxBytes) throw new Fault(507, "storage_full", "Local history storage is full.");
      this.db.prepare("INSERT INTO turns (id, parent, input, output, model, expires, bytes, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, parent, encodedInput, encodedOutput, model, this.clock() + this.ttl, bytes, JSON.stringify(details));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  retrieve(id) {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ? AND expires > ?").get(id, this.clock());
    if (!row) throw new Fault(404, "response_not_found", "This response was not stored locally, was deleted, or has expired.");
    if (!row.details) throw new Fault(409, "legacy_response_metadata_missing", "This older response lacks retrieval metadata. Its conversation history remains usable.");
    return { id: row.id, parent: row.parent, model: row.model, output: JSON.parse(row.output), ...JSON.parse(row.details) };
  }

  delete(id) {
    const result = this.db.prepare("DELETE FROM turns WHERE id = ? AND expires > ?").run(id, this.clock());
    if (!result.changes) throw new Fault(404, "response_not_found", "This response was not stored locally, was deleted, or has expired.");
    return { id, object: "response.deleted", deleted: true };
  }

  close() { this.db.close(); }
}
