import { v5 as uuidv5 } from 'uuid';
import {
  GTS_PREFIX,
  MAX_ID_LENGTH,
  GtsID,
  GtsIDSegment,
  InvalidGtsIDError,
  InvalidSegmentError,
  ValidationResult,
  ParseResult,
  MatchResult,
  UUIDResult,
} from './types';

const GTS_NAMESPACE = uuidv5('gts', uuidv5.URL);

const SEGMENT_TOKEN_REGEX = /^[a-z_][a-z0-9_]*$/;

export class Gts {
  static parseGtsID(id: string): GtsID {
    const raw = id.trim();

    if (raw !== raw.toLowerCase()) {
      throw new InvalidGtsIDError(id, 'Must be lower case');
    }

    if (raw.includes('-')) {
      throw new InvalidGtsIDError(id, "Must not contain '-'");
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
    if (raw.endsWith('.')) {
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

      const segment = this.parseSegment(i + 1, offset, part);
      gtsId.segments.push(segment);
      offset += part.length;
    }

    // Ensure we have at least one segment
    if (gtsId.segments.length === 0) {
      throw new InvalidGtsIDError(id, 'No valid segments found');
    }

    return gtsId;
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
      verMajor: 0,
      verMinor: undefined,
      isType: false,
      isWildcard: false,
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

  static validateGtsID(id: string): ValidationResult {
    try {
      this.parseGtsID(id);
      return {
        id,
        ok: true,
        valid: true,
        error: '',
      };
    } catch (error) {
      return {
        id,
        ok: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
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
      this.parseGtsID(id);
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

  static matchIDPattern(candidate: string, pattern: string): MatchResult {
    try {
      // Validate and parse candidate
      let candidateId: GtsID;
      try {
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
      const match = this.wildcardMatch(candidateId, patternId);

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

    // If wildcard exists, must be at the end
    if (wildcardCount === 1) {
      if (!p.endsWith('.*') && !p.endsWith('~*')) {
        throw new InvalidGtsIDError(pattern, "The wildcard '*' token is allowed only at the end of the pattern");
      }
    }

    // Try to parse as a GtsID
    return this.parseGtsID(p);
  }

  private static wildcardMatch(candidate: GtsID, pattern: GtsID): boolean {
    if (!candidate || !pattern) {
      return false;
    }

    // If no wildcard in pattern, perform exact match with version flexibility
    if (!pattern.id.includes('*')) {
      return this.matchSegments(pattern.segments, candidate.segments);
    }

    // Wildcard case
    if ((pattern.id.match(/\*/g) || []).length > 1 || !pattern.id.endsWith('*')) {
      return false;
    }

    // Use segment matching for wildcard patterns too
    return this.matchSegments(pattern.segments, candidate.segments);
  }

  private static matchSegments(patternSegs: GtsIDSegment[], candidateSegs: GtsIDSegment[]): boolean {
    // If pattern is longer than candidate, no match
    if (patternSegs.length > candidateSegs.length) {
      return false;
    }

    for (let i = 0; i < patternSegs.length; i++) {
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
        // Check version fields if they are set in the pattern
        if (pSeg.verMajor !== 0 && pSeg.verMajor !== cSeg.verMajor) {
          return false;
        }
        if (pSeg.verMinor !== undefined && (cSeg.verMinor === undefined || pSeg.verMinor !== cSeg.verMinor)) {
          return false;
        }
        // Check is_type flag if set
        if (pSeg.isType && pSeg.isType !== cSeg.isType) {
          return false;
        }
        // Wildcard matches - accept anything after this point
        return true;
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
      if (pSeg.verMajor !== cSeg.verMajor) {
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
