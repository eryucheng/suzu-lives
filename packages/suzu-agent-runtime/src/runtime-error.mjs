export class SuzuAgentRuntimeError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SuzuAgentRuntimeError";
    this.code = code;
    this.details = details;
  }
}
