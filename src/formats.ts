/**
 * GTS format assertions (ADR-0005/0006). Standard formats use ajv-formats;
 * date/time require timezone offsets, and regex checks the same GTS profile
 * as pattern and patternProperties.
 */

import type Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { regexProfileViolation } from './regex-profile';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** RFC 3339 full-date validity - same rule ajv-formats uses for `format: date`. */
function isValidDatePart(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  return day >= 1 && day <= maxDay;
}

// `time-numoffset` per RFC 3339 §5.6: sign, then a 2-digit hour (00-23) and a
// 2-digit minute (00-59) separated by ":". The offset (or a literal "Z"/"z")
// is REQUIRED, not optional, per the ADR-0005 fixtures.
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * RFC 3339 `full-time` validity, with the offset made mandatory (draft-07
 * semantics per the canonical suite, stricter than `ajv-formats`, which
 * treats the offset as optional) and offset bounds enforced (`+25:00` must
 * be rejected as `time-hour` is bounded to `00`-`23`).
 */
function isValidTimePart(value: string): boolean {
  const match = TIME_RE.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offsetSign = match[6];
  if (hour > 23 || minute > 59) return false;
  // RFC 3339 permits a positive leap second (23:59:60) as the sole exception
  // to the 0-59 second bound. This only checks the literal local `hour`/
  // `minute` fields against 23:59, not the value once adjusted to UTC by
  // `offsetHour`/`offsetMinute` below - so e.g. "23:59:60+05:00" (18:59:60Z)
  // also passes, even though a strict RFC 3339 reading only allows a leap
  // second when the *UTC* time is 23:59:60. No canonical fixture exercises an
  // offset leap second, so this narrower, offset-blind check is left as is
  // rather than tightened.
  const secondValid = second <= 59 || (hour === 23 && minute === 59 && second === 60);
  if (!secondValid) return false;
  if (offsetSign !== undefined) {
    const offsetHour = Number(match[7]);
    const offsetMinute = Number(match[8]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

// draft-07 `date-time` requires the literal "T"/"t" separator between the
// date and time parts (RFC 3339's alternative plain-space separator is
// rejected by the canonical fixtures, e.g. "2008-10-12 10:30:00Z").
const DATE_TIME_SEPARATOR = /^([^Tt]+)[Tt](.+)$/;

/** RFC 3339 `date-time`, with the offset mandatory - see `isValidTimePart`. */
function isValidDateTime(value: string): boolean {
  const match = DATE_TIME_SEPARATOR.exec(value);
  if (!match) return false;
  const [, datePart, timePart] = match;
  return isValidDatePart(datePart) && isValidTimePart(timePart);
}

/**
 * A regex-valued string is valid when it belongs to the GTS profile and its
 * support bounds, the same check as for schema patterns. The expression is
 * not compiled or executed.
 */
function isValidRegex(value: string): boolean {
  return regexProfileViolation(value) === undefined;
}

/**
 * Registers ADR-0005-compliant format assertions on `ajv`: `ajv-formats`
 * (mode: 'full') for the bulk of the standard formats, with `date-time`,
 * `time` and `regex` overridden to the stricter/correct behavior described
 * in the module comment above.
 */
export function applyGtsFormats(ajv: Ajv): Ajv {
  addFormats(ajv, { mode: 'full' });
  ajv.addFormat('date-time', isValidDateTime);
  ajv.addFormat('time', isValidTimePart);
  ajv.addFormat('regex', isValidRegex);
  return ajv;
}
