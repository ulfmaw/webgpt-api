export class Fault extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.modelUnavailable = options.modelUnavailable === true;
    for (const field of ["requested_model", "actual_model"]) {
      if (typeof options[field] === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(options[field])) this[field] = options[field];
    }
    if (typeof options.reason === "string" && /^[a-z_]{1,60}$/.test(options.reason)) this.reason = options.reason;
  }
}

export function publicError(error) {
  return error instanceof Fault
    ? { code: error.code, message: error.message, type: "webgpt_error",
      ...(error.requested_model ? { requested_model: error.requested_model } : {}),
      ...(error.actual_model ? { actual_model: error.actual_model } : {}),
      ...(error.reason ? { reason: error.reason } : {}) }
    : { code: "internal_error", message: "Request failed; no credentials or upstream body are logged.", type: "webgpt_error" };
}
