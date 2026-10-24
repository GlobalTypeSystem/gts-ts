import { v5 as uuidv5 } from 'uuid';
import {
  GTS_PREFIX,
  MAX_ID_LENGTH,
  GtsID,
  GtsIDSegment,
  GtsPattern,
  InvalidGtsIDError,
  InvalidSegmentError,
  ValidationResult,
  ParseResult,
  MatchResult,
  UUIDResult,
} from './types';

const GTS_NAMESPACE = uuidv5('gts', uuidv5.URL);

const SEGMENT_TOKEN_REGEX = /^[a-z_][a-z0-9_]*$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Major and minor versions are unsigned 32-bit integers (spec §2.3 note 7).
const MAX_VERSION = 4294967295;

export class Gts {
  /**
   * Parses a GTS identifier, or a wildcard pattern when `id` contains `*`
   * (spec §2.3, §10). Use {@link parseConcreteID} where a pattern is not
   * acceptable.
   */
  static parseGtsID(id: string): GtsID {
    return this.parseInternal(id, this.containsWildcard(id));
  }

  /**
   * Whether `value` carries the `*` wildcard token. A single choke point so the
   * "is this a pattern?" test is not re-spelled as an inline `.includes('*')`
   * at every call site.
   */
  static containsWildcard(value: string): boolean {
    return value.includes('*');
  }

  /**
   * OP#4 - parse a GTS pattern (an identifier that may end in a `*` wildcard)
   * into a typed {@link GtsPattern}. Prefer this over {@link parseGtsID} when a
   * value is used for matching: it returns the {@link GtsPattern.hasWildcard}
   * flag directly, so callers need not re-scan the string. Throws on a
   * malformed pattern (same rules as {@link matchIDPattern}'s pattern side).
   */
  static parsePattern(pattern: string): GtsPattern {
    const parsed = this.parseInternal(pattern, true);
    return { id: parsed.id, segments: parsed.segments, hasWildcard: this.containsWildcard(parsed.id) };
  }

  /**
   * Parses a **concrete** GTS identifier: no wildcard, at least one type
   * segment before an instance segment (issue #37). Input is validated as
   * spelled - surrounding whitespace is an error, not trimmed (spec §9.6.3).
   */
  static parseConcreteID(id: string): GtsID {
    return this.parseInternal(id, false);
  }

  /** Whether `id` is a concrete GTS identifier (no wildcard). */
  static isConcreteGtsID(id: string): boolean {
    try {
      this.parseConcreteID(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates the shared string structure and splits it into raw segments
   * (type segments keep their trailing `~`) plus an optional UUID tail.
   */
  private static splitRawSegments(id: string, allowWildcard: boolean): { raw: string[]; uuidTail?: string } {
    if (!id.startsWith(GTS_PREFIX)) {
      throw new InvalidGtsIDError(id, `Does not start with '${GTS_PREFIX}'`);
    }
    if (id !== id.toLowerCase()) {
      throw new InvalidGtsIDError(id, 'Must be lower case');
    }
    if (id.length > MAX_ID_LENGTH) {
      throw new InvalidGtsIDError(id, 'Too long');
    }
    if (allowWildcard) {
      const wildcards = (id.match(/\*/g) || []).length;
      if (wildcards > 1) {
        throw new InvalidGtsIDError(id, "The wildcard '*' token is allowed only once");
      }
      if (wildcards === 1 && !id.endsWith('*')) {
        throw new InvalidGtsIDError(id, "The wildcard '*' token is allowed only at the end of the pattern");
      }
    }

    const parts = id.substring(GTS_PREFIX.length).split('~');
    const last = parts[parts.length - 1];
    const uuidTail = parts.length >= 2 && UUID_REGEX.test(last) ? last : undefined;
    const segmentsPortion = uuidTail ? id.slice(0, id.length - uuidTail.length - 1) : id;
    if (segmentsPortion.includes('-')) {
      throw new InvalidGtsIDError(id, "Must not contain '-'");
    }

    // With a UUID tail every preceding part was followed by `~`, so each is a
    // type segment. Otherwise the last part is an instance segment, or empty
    // when the identifier ends with the type marker.
    const count = parts.length - (uuidTail ? 1 : 0);
    const raw: string[] = [];
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      if (parts[i] === '') {
        if (!(isLast && !uuidTail)) {
          throw new InvalidGtsIDError(id, i === 0 ? 'Empty segment' : 'Double tildes not allowed');
        }
      } else {
        raw.push(isLast && !uuidTail ? parts[i] : `${parts[i]}~`);
      }
    }
    if (raw.length === 0) {
      throw new InvalidGtsIDError(id, 'ID cannot be just the prefix');
    }
    return { raw, uuidTail };
  }

  private static parseInternal(id: string, allowWildcard: boolean): GtsID {
    const { raw, uuidTail } = this.splitRawSegments(id, allowWildcard);
    const segments: GtsIDSegment[] = [];
    let offset = GTS_PREFIX.length;
    raw.forEach((segment, index) => {
      segments.push(this.parseSegment(index + 1, offset, segment, allowWildcard));
      offset += segment.length;
    });
    if (uuidTail) {
      segments.push({
        num: segments.length + 1,
        offset,
        segment: uuidTail,
        vendor: '',
        package: '',
        namespace: '',
        type: '',
        verMajor: undefined,
        verMinor: undefined,
        isType: false,
        isWildcard: false,
        isUuidTail: true,
      });
    }

    // Issue #37: a lone instance segment is prohibited; wildcards and UUID
    // tails are exempt.
    const only = segments[0];
    if (segments.length === 1 && !only.isType && !only.isWildcard) {
      throw new InvalidGtsIDError(
        id,
        'Single-segment instance IDs are prohibited. Instance IDs must be chained with a type segment (e.g., gts.vendor.pkg.ns.type.v1~instance.segment.v1)'
      );
    }
    return { id, segments };
  }

  /**
   * Parses one raw segment (with its trailing `~`, if any). With
   * `allowWildcard`, a final `*` token - or the version marker `v*` - ends the
   * segment as a wildcard (spec §10 grammar); every version component must be
   * an unsigned 32-bit integer without leading zeros (spec §2.3 note 7).
   */
  private static parseSegment(num: number, offset: number, segment: string, allowWildcard: boolean): GtsIDSegment {
    const seg: GtsIDSegment = {
      num,
      offset,
      segment,
      vendor: '',
      package: '',
      namespace: '',
      type: '',
      verMajor: undefined,
      verMinor: undefined,
      isType: segment.endsWith('~'),
      isWildcard: false,
      isUuidTail: false,
    };
    const body = seg.isType ? segment.slice(0, -1) : segment;
    if (body.includes('~')) {
      throw new InvalidSegmentError(num, offset, segment, "Too many '~' characters");
    }

    const tokens = body.split('.');
    if (tokens.length > 6) {
      throw new InvalidSegmentError(num, offset, segment, 'Too many tokens');
    }
    const endsWithWildcard = allowWildcard && body.endsWith('*');
    if (!endsWithWildcard && tokens.length < 5) {
      throw new InvalidSegmentError(num, offset, segment, 'Too few tokens');
    }
    if (
      !endsWithWildcard &&
      tokens.length === 6 &&
      !tokens[4].startsWith('v') &&
      tokens[5].startsWith('v') &&
      SEGMENT_TOKEN_REGEX.test(tokens[4])
    ) {
      throw new InvalidSegmentError(num, offset, segment, 'Too many name tokens before version');
    }

    const wildcardAt = (index: number): boolean => {
      if (!allowWildcard || (tokens[index] !== '*' && !(index === 4 && tokens[index] === 'v*'))) return false;
      if (index !== tokens.length - 1) {
        throw new InvalidSegmentError(num, offset, segment, "The wildcard '*' is only allowed as the final token");
      }
      seg.isWildcard = true;
      return true;
    };

    const names = ['vendor', 'package', 'namespace', 'type'] as const;
    for (let index = 0; index < Math.min(4, tokens.length); index++) {
      if (wildcardAt(index)) return seg;
      if (!SEGMENT_TOKEN_REGEX.test(tokens[index])) {
        throw new InvalidSegmentError(num, offset, segment, `Invalid segment token: ${tokens[index]}`);
      }
      seg[names[index]] = tokens[index];
    }

    if (tokens.length > 4) {
      if (wildcardAt(4)) return seg;
      if (!tokens[4].startsWith('v')) {
        throw new InvalidSegmentError(num, offset, segment, "Major version must start with 'v'");
      }
      seg.verMajor = this.parseVersion(tokens[4].substring(1), 'Major', num, offset, segment);
    }
    if (tokens.length > 5) {
      if (wildcardAt(5)) return seg;
      seg.verMinor = this.parseVersion(tokens[5], 'Minor', num, offset, segment);
    }
    return seg;
  }

  private static parseVersion(
    value: string,
    label: 'Major' | 'Minor',
    num: number,
    offset: number,
    segment: string
  ): number {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new InvalidSegmentError(num, offset, segment, `${label} version must be an integer`);
    }
    const version = Number(value);
    if (version > MAX_VERSION) {
      throw new InvalidSegmentError(num, offset, segment, `${label} version exceeds ${MAX_VERSION}`);
    }
    return version;
  }

  static isValidGtsID(id: string): boolean {
    if (!id.startsWith(GTS_PREFIX)) {
      return false;
    }
    try {
      this.parseGtsID(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `value` is a plain UUID (v4/v5-shaped) string - the id form
   * gts-spec §3.7 permits for an "anonymous instance" (a non-schema entity
   * identified by a bare UUID, with schema resolution carried by a separate
   * `type` field rather than by the id's own GTS-chain shape).
   */
  static isUuid(value: string): boolean {
    return UUID_REGEX.test(value);
  }

  static validateGtsID(id: string): ValidationResult {
    const isWildcard = this.containsWildcard(id);
    try {
      this.parseGtsID(id);
      return {
        id,
        ok: true,
        valid: true,
        error: '',
        is_wildcard: isWildcard,
      };
    } catch (error) {
      return {
        id,
        ok: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
        is_wildcard: isWildcard,
      };
    }
  }

  static parseID(id: string): ParseResult {
    try {
      const gtsId = this.parseGtsID(id);
      return {
        ok: true,
        segments: gtsId.segments,
      };
    } catch (error) {
      return {
        ok: false,
        segments: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  static isType(id: string): boolean {
    return id.endsWith('~');
  }

  static toUUID(id: string): string {
    return uuidv5(id, GTS_NAMESPACE);
  }

  static idToUUID(id: string): UUIDResult {
    try {
      const parsed = this.parseGtsID(id);

      // A combined anonymous instance already carries its UUID as the tail
      // segment; that UUID is the instance identity, so return it as-is rather
      // than deriving a second one from the string.
      const lastSegment = parsed.segments[parsed.segments.length - 1];
      if (lastSegment && lastSegment.isUuidTail) {
        return { id, uuid: lastSegment.segment };
      }

      return {
        id,
        uuid: this.toUUID(id),
      };
    } catch (error) {
      return {
        id,
        uuid: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * OP#4 - match a candidate against a pattern (spec §10). A concrete
   * candidate matches when it is in M(pattern); a wildcard candidate matches
   * when the pattern covers it, i.e. M(candidate) ⊆ M(pattern).
   */
  static matchIDPattern(candidate: string, pattern: string): MatchResult {
    try {
      const candidateId = this.containsWildcard(candidate)
        ? this.parsePattern(candidate)
        : this.parseConcreteID(candidate);
      const patternId = this.parsePattern(pattern);
      const match = this.containsWildcard(candidate)
        ? this.patternCovers(patternId, candidateId)
        : this.idMatchesPattern(candidateId, patternId);
      return { match, pattern, candidate };
    } catch (error) {
      return {
        match: false,
        pattern,
        candidate,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Whether the concrete identifier `candidate` is in M(`pattern`) (spec §10).
   * In every specified segment the major must match exactly; an omitted minor
   * accepts any minor, an explicit one requires that minor. A concrete Type ID
   * also selects everything derived from it; a final bare `~*` may match an
   * empty suffix, while a partial wildcard (`~acme.*`, `v1.*`) still requires
   * its segment to exist.
   */
  static idMatchesPattern(candidate: GtsID, pattern: GtsID): boolean {
    const patternSegs = pattern.segments;
    const candidateSegs = candidate.segments;
    const last = patternSegs[patternSegs.length - 1];
    const matchesEmptySuffix = last.isWildcard && last.segment === '*';
    if (patternSegs.length - (matchesEmptySuffix ? 1 : 0) > candidateSegs.length) {
      return false;
    }

    for (let i = 0; i < patternSegs.length; i++) {
      if (i === candidateSegs.length) {
        return matchesEmptySuffix && i === patternSegs.length - 1;
      }
      const p = patternSegs[i];
      const c = candidateSegs[i];
      if (p.isWildcard) {
        return partialAdmits(p, c);
      }
      if (p.isUuidTail || c.isUuidTail) {
        if (p.segment !== c.segment || p.isUuidTail !== c.isUuidTail) return false;
        continue;
      }
      if (!segmentCovers(p, c) || p.isType !== c.isType) return false;
    }
    return true;
  }

  /**
   * Whether pattern `a` covers pattern `b`: M(b) ⊆ M(a) over every canonical
   * identifier, registered or not (spec §10 "Pattern coverage"). Coverage is
   * decided on the parsed segments, honoring minor-version flexibility,
   * type/instance boundaries and the identifier length limit: a pattern that
   * can select no identifier of at most 1024 characters is covered by
   * anything. Port of gts-rust `GtsIdPattern::covers`.
   */
  static patternCovers(a: GtsID, b: GtsID): boolean {
    const value = selectionOf(b);
    const shortest = shortestSelected(value);
    return shortest > MAX_ID_LENGTH || coversNonempty(selectionOf(a), value, shortest === MAX_ID_LENGTH);
  }
}

/**
 * What a valid pattern selects, viewed through its parsed segments: either
 * instances with a fixed chain (`instance`), or everything under a chain of
 * type segments, optionally narrowed by a partial wildcard segment `next`
 * (`prefixed`). A concrete Type ID is `prefixed` with no `next`.
 */
type Selection =
  | { kind: 'instance'; types: GtsIDSegment[]; tail: GtsIDSegment; length: number }
  | { kind: 'prefixed'; types: GtsIDSegment[]; next?: GtsIDSegment };

function selectionOf(pattern: GtsID): Selection {
  const segments = pattern.segments;
  const end = segments.length - 1;
  const last = segments[end];
  if (last.isWildcard) {
    return { kind: 'prefixed', types: segments.slice(0, end), next: last.segment === '*' ? undefined : last };
  }
  if (last.isType) {
    return { kind: 'prefixed', types: segments };
  }
  return { kind: 'instance', types: segments.slice(0, end), tail: last, length: pattern.id.length };
}

/** The length of the shortest identifier a selection contains. */
function shortestSelected(selection: Selection): number {
  if (selection.kind === 'instance') return selection.length;
  const chain = GTS_PREFIX.length + selection.types.reduce((sum, segment) => sum + segment.segment.length, 0);
  if (!selection.next && selection.types.length > 0) return chain;
  // Four one-letter names, four dots, and `v0` need ten characters.
  const segment = selection.next ? shortestPartial(selection.next) : 10;
  // A first segment must end in the type marker.
  return chain + segment + (selection.types.length === 0 ? 1 : 0);
}

function shortestPartial(partial: GtsIDSegment): number {
  // In `v1.*`, replacing `*` with the shortest minor (`0`) keeps the length.
  if (partial.verMajor !== undefined) return partial.segment.length;
  // Missing names are one character; `.v0` and the name separators add six.
  return [partial.vendor, partial.package, partial.namespace, partial.type].reduce(
    (sum, name) => sum + Math.max(name.length, 1),
    6
  );
}

function coversNonempty(operand: Selection, value: Selection, atLimit: boolean): boolean {
  if (operand.kind === 'instance' && value.kind === 'instance') {
    if (!sameChainCovers(operand.types, value.types)) return false;
    if (operand.tail.isUuidTail || value.tail.isUuidTail) {
      return operand.tail.isUuidTail && value.tail.isUuidTail && operand.tail.segment === value.tail.segment;
    }
    return segmentCovers(operand.tail, value.tail);
  }
  if (operand.kind === 'instance' && value.kind === 'prefixed') {
    // Only one-digit instance minors fit; appending a type marker or another
    // chain segment would exceed the length limit.
    const partial = value.next;
    return (
      atLimit &&
      partial !== undefined &&
      sameChainCovers(operand.types, value.types) &&
      !operand.tail.isUuidTail &&
      operand.tail.verMinor === undefined &&
      sameNames(operand.tail, partial) &&
      partial.verMajor === operand.tail.verMajor
    );
  }
  if (operand.kind === 'prefixed' && value.kind === 'instance') {
    const ids = value.types;
    if (ids.length < operand.types.length) return false;
    if (!operand.types.every((segment, i) => segmentCovers(segment, ids[i]))) return false;
    return !operand.next || partialAdmits(operand.next, ids[operand.types.length] ?? value.tail);
  }
  if (operand.kind === 'prefixed' && value.kind === 'prefixed') {
    return prefixedCovers(operand.types, operand.next, value.types, value.next);
  }
  return false;
}

function sameNames(a: GtsIDSegment, b: GtsIDSegment): boolean {
  return a.vendor === b.vendor && a.package === b.package && a.namespace === b.namespace && a.type === b.type;
}

/** Segment `a` selects segment `b`: same names and major, and `b` pins `a`'s minor if `a` does. */
function segmentCovers(a: GtsIDSegment, b: GtsIDSegment): boolean {
  return sameNames(a, b) && a.verMajor === b.verMajor && (a.verMinor === undefined || a.verMinor === b.verMinor);
}

function sameChainCovers(a: GtsIDSegment[], b: GtsIDSegment[]): boolean {
  return a.length === b.length && a.every((segment, i) => segmentCovers(segment, b[i]));
}

function partialNamesCover(a: GtsIDSegment, b: GtsIDSegment): boolean {
  return (
    (!a.vendor || a.vendor === b.vendor) &&
    (!a.package || a.package === b.package) &&
    (!a.namespace || a.namespace === b.namespace) &&
    (!a.type || a.type === b.type)
  );
}

/** Whether a partial wildcard segment admits the concrete segment `segment`; `v1.*` requires an explicit minor. */
function partialAdmits(partial: GtsIDSegment, segment: GtsIDSegment): boolean {
  if (!partialNamesCover(partial, segment)) return false;
  if (partial.verMajor === undefined) return true;
  return segment.verMajor === partial.verMajor && segment.verMinor !== undefined;
}

function partialCovers(a: GtsIDSegment, b: GtsIDSegment): boolean {
  return partialNamesCover(a, b) && (a.verMajor === undefined || b.verMajor === a.verMajor);
}

function prefixedCovers(
  a: GtsIDSegment[],
  aNext: GtsIDSegment | undefined,
  b: GtsIDSegment[],
  bNext: GtsIDSegment | undefined
): boolean {
  if (a.length > b.length) {
    // A first-segment minor wildcard selects types contained in a bare type
    // scope with the same names and major and an omitted minor.
    return (
      a.length === 1 &&
      aNext === undefined &&
      b.length === 0 &&
      bNext !== undefined &&
      a[0].verMinor === undefined &&
      sameNames(a[0], bNext) &&
      a[0].verMajor === bNext.verMajor
    );
  }
  if (!a.every((segment, i) => segmentCovers(segment, b[i]))) return false;
  if (!aNext) return true;
  const segment = b[a.length];
  if (segment) return partialAdmits(aNext, segment);
  return bNext !== undefined && partialCovers(aNext, bNext);
}
