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

export class Gts {
  static parseGtsID(id: string): GtsID {
    // If ID contains wildcard, validate as wildcard first
    if (this.containsWildcard(id)) {
      return this.validateWildcard(id);
    }
    return this.parseGtsIDInternal(id, false);
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
    const parsed = this.validateWildcard(pattern);
    return { id: parsed.id, segments: parsed.segments, hasWildcard: this.containsWildcard(parsed.id) };
  }

  private static splitPreservingTilde(s: string): string[] {
    const parts: string[] = [];
    let current = '';

    for (let i = 0; i < s.length; i++) {
      if (s[i] === '~') {
        // Add the segment with the tilde
        parts.push(current + '~');
        current = '';
      } else {
        current += s[i];
      }
    }

    // Add any remaining content (instance without trailing ~)
    // This could be a regular instance segment or a UUID tail
    if (current) {
      parts.push(current);
    }

    return parts.filter((p) => p !== '~'); // Remove any standalone tildes
  }

  private static parseSegment(num: number, offset: number, segment: string): GtsIDSegment {
    const seg: GtsIDSegment = {
      num,
      offset,
      segment: segment.trim(),
      vendor: '',
      package: '',
      namespace: '',
      type: '',
      verMajor: undefined,
      verMinor: undefined,
      isType: false,
      isWildcard: false,
      isUuidTail: false,
    };

    let workingSegment = seg.segment;

    // Check for empty segment
    if (!workingSegment || workingSegment === '~') {
      throw new InvalidSegmentError(num, offset, segment, 'Empty segment');
    }

    const tildeCount = (workingSegment.match(/~/g) || []).length;
    if (tildeCount > 0) {
      if (tildeCount > 1) {
        throw new InvalidSegmentError(num, offset, segment, "Too many '~' characters");
      }
      if (workingSegment.endsWith('~')) {
        seg.isType = true;
        workingSegment = workingSegment.slice(0, -1);
      } else {
        throw new InvalidSegmentError(num, offset, segment, " '~' must be at the end");
      }
    }

    // Check for empty tokens (double dots)
    if (workingSegment.includes('..')) {
      throw new InvalidSegmentError(num, offset, segment, 'Empty token (double dots)');
    }

    const tokens = workingSegment.split('.');

    // Check for empty tokens
    for (const token of tokens) {
      if (token === '') {
        throw new InvalidSegmentError(num, offset, segment, 'Empty token');
      }
    }

    if (tokens.length > 6) {
      throw new InvalidSegmentError(num, offset, segment, 'Too many tokens');
    }

    if (!workingSegment.endsWith('*')) {
      if (tokens.length < 5) {
        throw new InvalidSegmentError(num, offset, segment, 'Too few tokens');
      }

      for (let t = 0; t < 4; t++) {
        if (!SEGMENT_TOKEN_REGEX.test(tokens[t])) {
          throw new InvalidSegmentError(num, offset, segment, 'Invalid segment token: ' + tokens[t]);
        }
      }
    }

    if (tokens.length > 0) {
      if (tokens[0] === '*') {
        seg.isWildcard = true;
        return seg;
      }
      seg.vendor = tokens[0];
    }

    if (tokens.length > 1) {
      if (tokens[1] === '*') {
        seg.isWildcard = true;
        return seg;
      }
      seg.package = tokens[1];
    }

    if (tokens.length > 2) {
      if (tokens[2] === '*') {
        seg.isWildcard = true;
        return seg;
      }
      seg.namespace = tokens[2];
    }

    if (tokens.length > 3) {
      if (tokens[3] === '*') {
        seg.isWildcard = true;
        return seg;
      }
      seg.type = tokens[3];
    }

    if (tokens.length > 4) {
      if (tokens[4] === '*') {
        seg.isWildcard = true;
        return seg;
      }

      if (!tokens[4].startsWith('v')) {
        throw new InvalidSegmentError(num, offset, segment, "Major version must start with 'v'");
      }

      const majorStr = tokens[4].substring(1);
      const major = parseInt(majorStr, 10);

      if (isNaN(major)) {
        throw new InvalidSegmentError(num, offset, segment, 'Major version must be an integer');
      }

      if (major < 0) {
        throw new InvalidSegmentError(num, offset, segment, 'Major version must be >= 0');
      }

      if (major.toString() !== majorStr) {
        throw new InvalidSegmentError(num, offset, segment, 'Major version must be an integer');
      }

      seg.verMajor = major;
    }

    if (tokens.length > 5) {
      if (tokens[5] === '*') {
        seg.isWildcard = true;
        return seg;
      }

      const minor = parseInt(tokens[5], 10);

      if (isNaN(minor)) {
        throw new InvalidSegmentError(num, offset, segment, 'Minor version must be an integer');
      }

      if (minor < 0) {
        throw new InvalidSegmentError(num, offset, segment, 'Minor version must be >= 0');
      }

      if (minor.toString() !== tokens[5]) {
        throw new InvalidSegmentError(num, offset, segment, 'Minor version must be an integer');
      }

      seg.verMinor = minor;
    }

    return seg;
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
      if (isWildcard) {
        // For wildcard patterns, use validateWildcard
        this.validateWildcard(id);
      } else {
        this.parseGtsID(id);
      }
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
   * OP#4 - match a candidate identifier against a pattern.
   *
   * `chainSuffixMatchesSelf` controls whether a bare chain-suffix wildcard
   * (`type.v1~*`) also matches the type it is anchored on, rather than only the
   * identifiers derived from it. Spec §10 states the inclusive reading for
   * pattern matching, while its collection examples (and OP#10) enumerate only
   * the strictly-derived identifiers, so OP#10 queries pass `false`.
   */
  static matchIDPattern(
    candidate: string,
    pattern: string,
    options?: { chainSuffixMatchesSelf?: boolean }
  ): MatchResult {
    const chainSuffixMatchesSelf = options?.chainSuffixMatchesSelf !== false;
    try {
      // Validate and parse candidate
      // If candidate contains '*', validate it as a wildcard pattern first
      // This catches malformed wildcards like 'a*' (wildcard not on token boundary)
      let candidateId: GtsID;
      try {
        if (this.containsWildcard(candidate)) {
          // Validate candidate as a wildcard pattern first
          this.validateWildcard(candidate);
        }
        candidateId = this.parseGtsID(candidate);
      } catch (error) {
        return {
          match: false,
          pattern,
          candidate,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Validate and parse pattern (allow wildcards)
      let patternId: GtsID;
      try {
        patternId = this.validateWildcard(pattern);
      } catch (error) {
        return {
          match: false,
          pattern,
          candidate,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Perform matching
      const match = this.wildcardMatch(candidateId, patternId, chainSuffixMatchesSelf);

      return {
        match,
        pattern,
        candidate,
      };
    } catch (error) {
      return {
        match: false,
        pattern,
        candidate,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private static validateWildcard(pattern: string): GtsID {
    const p = pattern.trim();

    // Must start with gts.
    if (!p.startsWith(GTS_PREFIX)) {
      throw new InvalidGtsIDError(pattern, `Does not start with '${GTS_PREFIX}'`);
    }

    // Count wildcards
    const wildcardCount = (p.match(/\*/g) || []).length;
    if (wildcardCount > 1) {
      throw new InvalidGtsIDError(pattern, "The wildcard '*' token is allowed only once");
    }

    // If wildcard exists, validate its position
    if (wildcardCount === 1) {
      // Wildcard must be at a token boundary at the end (either .* or ~*)
      // Pattern like "gts.a.b.c.d.v1~a.*" is valid (wildcard at end after .)
      // Pattern like "gts.a.b.c.d.v1~a.*~" is invalid (wildcard not at end of pattern)
      // Pattern like "gts.a.b.c.d.v1~a*" is invalid (wildcard not at token boundary)
      // Pattern like "gts.a.b.c.*.v1~a.*" is invalid (wildcard in middle of segment)

      const wildcardIndex = p.indexOf('*');

      // Check if wildcard is at the very end
      if (wildcardIndex !== p.length - 1) {
        throw new InvalidGtsIDError(pattern, "The wildcard '*' token is allowed only at the end of the pattern");
      }

      // Check if wildcard is preceded by . or ~ (token boundary)
      if (wildcardIndex > 0 && p[wildcardIndex - 1] !== '.' && p[wildcardIndex - 1] !== '~') {
        throw new InvalidGtsIDError(pattern, "The wildcard '*' must be preceded by '.' or '~' (token boundary)");
      }

      // Check that there's no wildcard in the middle of a segment (before a ~)
      // Split by ~ to get segments, check if any segment except the last has a wildcard
      const segments = p.split('~');
      for (let i = 0; i < segments.length - 1; i++) {
        if (segments[i].includes('*')) {
          throw new InvalidGtsIDError(pattern, "The wildcard '*' token cannot appear in the middle of a chained ID");
        }
      }
    }

    // Parse the pattern - parseGtsID will handle the segment validation
    return this.parseGtsIDInternal(p, true);
  }

  // Internal parse method that can be called with wildcard mode
  private static parseGtsIDInternal(id: string, allowWildcard: boolean = false): GtsID {
    const raw = id.trim();

    if (raw !== raw.toLowerCase()) {
      throw new InvalidGtsIDError(id, 'Must be lower case');
    }

    if (!raw.startsWith(GTS_PREFIX)) {
      throw new InvalidGtsIDError(id, `Does not start with '${GTS_PREFIX}'`);
    }

    if (raw.length > MAX_ID_LENGTH) {
      throw new InvalidGtsIDError(id, 'Too long');
    }

    // Additional validation
    if (raw.includes('..')) {
      throw new InvalidGtsIDError(id, 'Double dots not allowed');
    }
    if (raw.endsWith('.') && !raw.endsWith('.*')) {
      throw new InvalidGtsIDError(id, 'Cannot end with a dot');
    }
    if (raw.includes('~~')) {
      throw new InvalidGtsIDError(id, 'Double tildes not allowed');
    }
    if (raw === GTS_PREFIX || raw === GTS_PREFIX + '~') {
      throw new InvalidGtsIDError(id, 'ID cannot be just the prefix');
    }

    const gtsId: GtsID = {
      id: raw,
      segments: [],
    };

    const remainder = raw.substring(GTS_PREFIX.length);
    const parts = this.splitPreservingTilde(remainder);

    let offset = GTS_PREFIX.length;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '') {
        continue;
      }

      // Check if this is a UUID tail (last part, no tilde, matches UUID format)
      if (i > 0 && i === parts.length - 1 && !part.endsWith('~') && UUID_REGEX.test(part)) {
        // UUID tail segment for combined anonymous instances
        const seg: GtsIDSegment = {
          num: i + 1,
          offset,
          segment: part,
          vendor: '',
          package: '',
          namespace: '',
          type: '',
          verMajor: undefined,
          verMinor: undefined,
          isType: false,
          isWildcard: false,
          isUuidTail: true,
        };
        gtsId.segments.push(seg);
        offset += part.length;
        continue;
      }

      // Regular segments must not contain hyphens
      if (part.includes('-')) {
        throw new InvalidGtsIDError(id, "Must not contain '-'");
      }

      const segment = this.parseSegment(i + 1, offset, part);
      gtsId.segments.push(segment);
      offset += part.length;
    }

    // Ensure we have at least one segment
    if (gtsId.segments.length === 0) {
      throw new InvalidGtsIDError(id, 'No valid segments found');
    }

    // v0.7: Single-segment instance IDs are prohibited (skip for wildcard patterns)
    // Exception: combined anonymous instances (UUID tail) are always valid
    if (!allowWildcard && !this.containsWildcard(raw)) {
      const lastSegment = gtsId.segments[gtsId.segments.length - 1];
      if (!lastSegment.isType && !lastSegment.isUuidTail && gtsId.segments.length === 1) {
        throw new InvalidGtsIDError(
          id,
          'Single-segment instance IDs are prohibited. Instance IDs must be chained with a type segment (e.g., gts.vendor.pkg.ns.type.v1~instance.segment.v1)'
        );
      }
    }

    return gtsId;
  }

  private static wildcardMatch(candidate: GtsID, pattern: GtsID, chainSuffixMatchesSelf: boolean = true): boolean {
    if (!candidate || !pattern) {
      return false;
    }

    // If no wildcard in pattern, perform exact match with version flexibility
    if (!this.containsWildcard(pattern.id)) {
      return this.matchSegments(pattern.segments, candidate.segments, chainSuffixMatchesSelf);
    }

    // Wildcard case
    if ((pattern.id.match(/\*/g) || []).length > 1 || !pattern.id.endsWith('*')) {
      return false;
    }

    // Use segment matching for wildcard patterns too
    return this.matchSegments(pattern.segments, candidate.segments, chainSuffixMatchesSelf);
  }

  /**
   * Reads the major version out of a wildcard pattern segment such as
   * `x.pkg.ns.type.v0.*`. The parsed segment cannot express this: an omitted
   * major version and `v0` both leave `verMajor` at 0.
   *
   * Only the major version can appear before the wildcard. A minor-qualified
   * form (`type.v1.2.*`) would be a seven-token segment, which the parser
   * rejects; the way to select one minor version and its derived types is the
   * chain-suffix wildcard `type.v1.2~*`.
   */
  private static wildcardPatternVersion(segment: string): { majorSpecified: boolean; major: number } {
    const match = /(?:^|\.)v(\d+)\.\*$/.exec(segment);
    if (!match) {
      return { majorSpecified: false, major: 0 };
    }
    return { majorSpecified: true, major: parseInt(match[1], 10) };
  }

  private static matchSegments(
    patternSegs: GtsIDSegment[],
    candidateSegs: GtsIDSegment[],
    chainSuffixMatchesSelf: boolean = true
  ): boolean {
    // A bare chain-suffix wildcard (`type.v1~*`) matches everything derived
    // from the type, and - unless the caller opts out - the type itself, so it
    // may absorb zero segments.
    const lastPattern = patternSegs[patternSegs.length - 1];
    const hasBareTrailingWildcard = !!lastPattern && lastPattern.isWildcard && lastPattern.segment === '*';
    const requiredSegs = hasBareTrailingWildcard ? patternSegs.length - 1 : patternSegs.length;

    // If pattern is longer than candidate, no match
    if (requiredSegs > candidateSegs.length) {
      return false;
    }

    // Strictly-derived mode: the wildcard must absorb at least one segment.
    if (hasBareTrailingWildcard && !chainSuffixMatchesSelf && candidateSegs.length <= requiredSegs) {
      return false;
    }

    for (let i = 0; i < requiredSegs; i++) {
      const pSeg = patternSegs[i];
      const cSeg = candidateSegs[i];

      // If pattern segment is a wildcard, check non-wildcard fields first
      if (pSeg.isWildcard) {
        // Check the fields that are set (non-empty) in the wildcard pattern
        if (pSeg.vendor && pSeg.vendor !== cSeg.vendor) {
          return false;
        }
        if (pSeg.package && pSeg.package !== cSeg.package) {
          return false;
        }
        if (pSeg.namespace && pSeg.namespace !== cSeg.namespace) {
          return false;
        }
        if (pSeg.type && pSeg.type !== cSeg.type) {
          return false;
        }
        // Check the version only when the pattern actually spells one out.
        // A major-only wildcard matches any minor of that major.
        const patternVersion = this.wildcardPatternVersion(pSeg.segment);
        if (patternVersion.majorSpecified && patternVersion.major !== (cSeg.verMajor ?? 0)) {
          return false;
        }
        // Check is_type flag if set
        if (pSeg.isType && pSeg.isType !== cSeg.isType) {
          return false;
        }
        // Wildcard matches - accept anything after this point
        return true;
      }

      // Non-wildcard UUID tail - compare raw segment string
      if (pSeg.isUuidTail) {
        if (pSeg.segment !== cSeg.segment) {
          return false;
        }
        continue;
      }

      // Non-wildcard segment - all fields must match
      if (pSeg.vendor !== cSeg.vendor) {
        return false;
      }
      if (pSeg.package !== cSeg.package) {
        return false;
      }
      if (pSeg.namespace !== cSeg.namespace) {
        return false;
      }
      if (pSeg.type !== cSeg.type) {
        return false;
      }

      // Check version matching
      // Major version must match
      if ((pSeg.verMajor ?? 0) !== (cSeg.verMajor ?? 0)) {
        return false;
      }

      // Minor version: if pattern has no minor version, accept any minor in candidate
      // If pattern has minor version, it must match exactly
      if (pSeg.verMinor !== undefined) {
        if (cSeg.verMinor === undefined || pSeg.verMinor !== cSeg.verMinor) {
          return false;
        }
      }
      // else: pattern has no minor version, so any minor version in candidate is OK

      // Check is_type flag matches
      if (pSeg.isType !== cSeg.isType) {
        return false;
      }
    }

    // If we've matched all pattern segments, it's a match
    return true;
  }
}
