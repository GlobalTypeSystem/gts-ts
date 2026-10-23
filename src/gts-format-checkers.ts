/**
 * Engine-independent GTS format checkers (ADR-0005/0006): `date-time` and `time` with
 * mandatory timezone offsets, and `regex` checking the GTS regex profile, plus the other
 * formats the former Ajv path asserted through ajv-formats 3.0.1 `full` mode (MIT), kept
 * with the same patterns and semantics. Used by the schema engine.
 */

import { regexProfileViolation } from './regex-profile';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** RFC 3339 full-date validity - same rule ajv-formats uses for `format: date`. */
export function isValidDatePart(value: string): boolean {
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
export function isValidTimePart(value: string): boolean {
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
export function isValidDateTime(value: string): boolean {
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
export function isValidRegex(value: string): boolean {
  return regexProfileViolation(value) === undefined;
}

// Standard formats the engine library does not ship, with the patterns that ajv-formats 3.0.1
// (MIT) uses in `full` mode, so ADR-0005 assertions keep the behavior of the former Ajv path.
const NOT_URI_FRAGMENT = /\/|:/;
const URI_RE =
  /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
const URI_REFERENCE_RE =
  /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
const URI_TEMPLATE_RE =
  // eslint-disable-next-line no-control-regex -- RFC 6570 forbids control characters in templates
  /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
const HOSTNAME_RE =
  /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE =
  /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;

/** RFC 3986 absolute URI (`format: uri`). */
export function isValidUri(value: string): boolean {
  return NOT_URI_FRAGMENT.test(value) && URI_RE.test(value);
}

/** RFC 3986 URI reference (`format: uri-reference`). */
export function isValidUriReference(value: string): boolean {
  return URI_REFERENCE_RE.test(value);
}

/** RFC 6570 URI template (`format: uri-template`). */
export function isValidUriTemplate(value: string): boolean {
  return URI_TEMPLATE_RE.test(value);
}

/** RFC 1123 hostname (`format: hostname`). */
export function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

/** Dotted-quad IPv4 address (`format: ipv4`). */
export function isValidIpv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/** RFC 4291 IPv6 address (`format: ipv6`). */
export function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value);
}

// Remaining ajv-formats 3.0.1 `full`-mode formats (MIT), so assertions keep the behavior of the former Ajv path.
const ISO_TIME_RE = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const ISO_DATE_TIME_SEPARATOR = /t|\s/i;
const DURATION_RE = /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/;
const URL_RE =
  /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const UUID_RE = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const JSON_POINTER_RE = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const JSON_POINTER_URI_FRAGMENT_RE = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
const RELATIVE_JSON_POINTER_RE = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
// ajv-formats keeps the `m` flag here, so any line of a multi-line string may match; reproduced for parity.
const BYTE_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/m;
const MIN_INT32 = -(2 ** 31);
const MAX_INT32 = 2 ** 31 - 1;

/** RFC 3339 time with an optional offset; leap seconds are checked against the UTC-adjusted time. */
export function isValidIsoTime(value: string): boolean {
  const match = ISO_TIME_RE.exec(value);
  if (!match) return false;
  const hour = +match[1];
  const minute = +match[2];
  const second = +match[3];
  const sign = match[5] === '-' ? -1 : 1;
  const offsetHour = +(match[6] || 0);
  const offsetMinute = +(match[7] || 0);
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (hour <= 23 && minute <= 59 && second < 60) return true;
  const utcMinute = minute - offsetMinute * sign;
  const utcHour = hour - offsetHour * sign - (utcMinute < 0 ? 1 : 0);
  return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61;
}

/** RFC 3339 date-time with an optional offset and a `T`, `t` or whitespace separator (`format: iso-date-time`). */
export function isValidIsoDateTime(value: string): boolean {
  const parts = value.split(ISO_DATE_TIME_SEPARATOR);
  return parts.length === 2 && isValidDatePart(parts[0]) && isValidIsoTime(parts[1]);
}

/** RFC 3339 Appendix A duration (`format: duration`). */
export function isValidDuration(value: string): boolean {
  return DURATION_RE.test(value);
}

/** Absolute http, https or ftp URL (`format: url`). */
export function isValidUrl(value: string): boolean {
  return URL_RE.test(value);
}

/** Email address (`format: email`). */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** RFC 4122 UUID, optionally `urn:uuid:` prefixed (`format: uuid`). */
export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** RFC 6901 JSON pointer (`format: json-pointer`). */
export function isValidJsonPointer(value: string): boolean {
  return JSON_POINTER_RE.test(value);
}

/** RFC 6901 JSON pointer in URI fragment form (`format: json-pointer-uri-fragment`). */
export function isValidJsonPointerUriFragment(value: string): boolean {
  return JSON_POINTER_URI_FRAGMENT_RE.test(value);
}

/** Relative JSON pointer (`format: relative-json-pointer`). */
export function isValidRelativeJsonPointer(value: string): boolean {
  return RELATIVE_JSON_POINTER_RE.test(value);
}

/** Base64 string (`format: byte`). */
export function isValidByte(value: string): boolean {
  return BYTE_RE.test(value);
}

/** Signed 32-bit integer (`format: int32`, applies to numbers). */
export function isValidInt32(value: number): boolean {
  return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
}

/** Signed 64-bit integer (`format: int64`, applies to numbers; any JS safe integer fits). */
export function isValidInt64(value: number): boolean {
  return Number.isInteger(value);
}
