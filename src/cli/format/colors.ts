/**
 * ANSI color helpers for CLI output.
 * Respects the NO_COLOR environment variable — if set, returns strings unmodified.
 */

const noColor = (): boolean => typeof process.env["NO_COLOR"] !== "undefined";

function wrap(code: string, reset: string, s: string): string {
  if (noColor()) return s;
  return `\x1b[${code}m${s}\x1b[${reset}m`;
}

export function bold(s: string): string {
  return wrap("1", "22", s);
}

export function dim(s: string): string {
  return wrap("2", "22", s);
}

export function red(s: string): string {
  return wrap("31", "39", s);
}

export function green(s: string): string {
  return wrap("32", "39", s);
}

export function yellow(s: string): string {
  return wrap("33", "39", s);
}

export function blue(s: string): string {
  return wrap("34", "39", s);
}

export function cyan(s: string): string {
  return wrap("36", "39", s);
}

export function magenta(s: string): string {
  return wrap("35", "39", s);
}

export function reset(s: string): string {
  return wrap("0", "0", s);
}
