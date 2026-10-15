/**
 * A startup trace this plugin owns.
 *
 * The host's own logs have moved between at least three directories across the
 * 0.1.x / 0.2.x / DSH NEXT lines, and on a machine with no outbound network
 * they are not always where anyone thinks to look. When a provider fails to
 * register, "the model picker does not list xdpool" is the only symptom the
 * user can report, and answering it needs the exact throw — so the plugin
 * writes one small append-only file next to the settings it already owns.
 *
 * Everything here is best-effort: a diagnostic that can crash the thing it is
 * diagnosing is worse than no diagnostic, so every path swallows its own
 * failure and returns a value the caller can log instead.
 *
 * @module dsh-xdpool/diagnostics
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
/**
 * Cap the trace so a plugin that restarts in a loop cannot fill the disk.
 * Half a megabyte is roughly a month of restarts, which is far more than the
 * single boot this file is meant to explain.
 */
const MAX_BYTES = 512 * 1024
/** The file lives beside the settings store, so one directory explains both. */
export function startupLogPath(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : homedir()
  return join(home, '.xdpool', 'startup.log')
}
/**
 * Render any thrown value as one line of text.
 *
 * `String(error)` on a real `Error` collapses the stack to "Error: message",
 * which is exactly the part worth keeping; the object form (`{}` for a
 * structured clone, `[object Object]` for anything else) is what produced the
 * unreadable `{}` markers in this project's earlier logs.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? ` (${String((error as { code: string }).code)})`
      : ''
    return `${error.name}: ${error.message}${code}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
/**
 * Append one timestamped line. Returns the text that was written, so a caller
 * that cannot write the file can still put the same words in the host log.
 */
export function recordStartupNote(line: string): string {
  const stamp = new Date().toISOString()
  const text = `${stamp} ${line}`
  try {
    const path = startupLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    try {
      if (statSync(path).size > MAX_BYTES) truncateSync(path, 0)
    } catch {
      // No file yet, or it cannot be sized; appending will report if it is fatal.
    }
    appendFileSync(path, `${text}\n`, 'utf8')
  } catch {
    // Reported through the host log by the caller; never thrown from here.
  }
  return text
}