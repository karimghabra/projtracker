/**
 * Failures the command layer can produce.
 *
 * Every one carries a machine-readable code and a message written for a person
 * to read directly — the UI shows these verbatim, so "Cannot add a task to a
 * project; add it to a goal" is the standard, not "invalid parent kind".
 */

export type ErrorCode =
  | 'not-found'
  | 'ambiguous'
  | 'invalid'
  | 'conflict'
  | 'cycle'
  | 'not-allowed';

export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.details = details;
  }
}

export function notFound(what: string, token: string): CommandError {
  return new CommandError('not-found', `No ${what} matching "${token}".`, { token });
}

export function invalid(message: string, details?: Record<string, unknown>): CommandError {
  return new CommandError('invalid', message, details);
}

export function notAllowed(message: string, details?: Record<string, unknown>): CommandError {
  return new CommandError('not-allowed', message, details);
}

export function conflict(message: string, details?: Record<string, unknown>): CommandError {
  return new CommandError('conflict', message, details);
}

export function isCommandError(error: unknown): error is CommandError {
  return error instanceof CommandError;
}

/** Normalise anything thrown into something the surfaces can render. */
export function toCommandError(error: unknown): CommandError {
  if (isCommandError(error)) return error;
  if (error instanceof Error) return new CommandError('invalid', error.message);
  return new CommandError('invalid', String(error));
}
