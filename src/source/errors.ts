/** Typed errors for the remote source. Every one carries a stable `code` tests and hosts can switch on. */
export class PVecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type PVecOptionErrorCode = "url-not-absolute" | "cache-budget-invalid" | "worker-count-invalid" | "limit-invalid";
export class PVecOptionError extends PVecError {
  declare readonly code: PVecOptionErrorCode;
}

/** The bytes on the wire are not a readable container, or a pointer in them lies. */
export class PVecFormatError extends PVecError {}

/** A required capability is not supported (or the file needs a newer reader). `capability` names it. */
export class PVecCapabilityError extends PVecError {
  constructor(
    code: string,
    readonly capability: string,
    message: string,
    reason?: "unsupported" | "version",
  ) {
    super(code, message, reason ? { capability, reason } : { capability });
  }
}

/** The origin is misbehaving: wrong status, missing header, short or reset body. */
export class PVecTransportError extends PVecError {}

/** No usable version identity, or the artifact changed under the session. */
export class PVecVersionError extends PVecError {}

/** Queued work passed a cap. `current` and `max` are the values at refusal. */
export class PVecBackpressureError extends PVecError {
  constructor(
    readonly current: number,
    readonly max: number,
    what: string,
  ) {
    super("backpressure", `${what} would pass the cap (${current} of ${max})`, { current, max });
  }
}

/** Cancellation is a normal outcome, not a failure to surface to the host. */
export class PVecAbortError extends PVecError {
  constructor() {
    super("aborted", "request aborted");
  }
}
