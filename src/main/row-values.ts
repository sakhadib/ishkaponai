/**
 * Narrowing helpers for values coming out of `node:sqlite`.
 *
 * `node:sqlite` is typed as returning `SQLOutputValue` (a union of
 * `null | number | bigint | string | Uint8Array`) and, for `PRAGMA` results,
 * occasionally `undefined` columns. Rather than casting rows into the shared
 * domain types, every read goes through one of these coercions: a column that
 * somehow holds an unexpected type degrades to a documented fallback instead of
 * producing a corrupt `Session`.
 */
import type { Row } from './db'

export function readString(row: Row, column: string, fallback = ''): string {
  const value = row[column]
  return typeof value === 'string' ? value : fallback
}

export function readOptionalString(row: Row, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

export function readNumber(row: Row, column: string, fallback = 0): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

export function readOptionalNumber(row: Row, column: string): number | null {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

export function readBoolean(row: Row, column: string): boolean {
  return readNumber(row, column) !== 0
}
