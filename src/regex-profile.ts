/**
 * GTS regex profile (gts-spec §11.0.1, ADR-0006): the shared ECMA-262 `u`/RE2
 * syntax subset and support bounds. Membership checks mirror gts-go's
 * `gts/regex_profile.go`; regex-engine.ts compiles accepted expressions unchanged.
 */

/** Largest expanded length, in code points (ADR-0006 "Common support bounds"). */
export const MAX_REGEX_EXPANDED_LENGTH = 4096;
/** Deepest group nesting. */
export const MAX_REGEX_GROUP_DEPTH = 32;
/** Largest repetition count, and product of counts along a nesting path. */
export const MAX_REGEX_REPEAT = 1000;

// Saturation above the largest bound prevents overflow.
const SATURATED = MAX_REGEX_EXPANDED_LENGTH + 1;
const satAdd = (a: number, b: number): number => Math.min(a + b, SATURATED);
const satMul = (a: number, b: number): number => Math.min(a * b, SATURATED);

const EOF = -1;
const cp = (char: string): number => char.codePointAt(0)!;

// Escaped syntax characters, accepted everywhere; `\-` only inside a class.
const SYNTAX_ESCAPES = new Set(Array.from('^$\\.*+?()[]{}|/', cp));
const CONTROL_ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b };
const SHORTHAND_ESCAPES = new Set(Array.from('dDwWsS', cp));

class ProfileViolation extends Error {}

/** One parsed class atom: a single code point, or a shorthand class. */
interface ClassAtom {
  codePoint: number;
  isSet: boolean;
}

/** Expanded length, and the largest counted-repetition product within it. */
interface Measure {
  length: number;
  product: number;
}

class ProfileParser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly src: readonly number[]) {}

  /** Parse the whole expression and return its expanded length. */
  parse(): number {
    const { length } = this.parseDisjunction();
    // parseDisjunction stops only at the end or at an unmatched ')'.
    if (!this.eof()) this.fail("unmatched ')'");
    return length;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(offset = 0): number {
    const i = this.pos + offset;
    return i < this.src.length ? this.src[i] : EOF;
  }

  private fail(message: string): never {
    throw new ProfileViolation(`${message} at offset ${this.pos}`);
  }

  private static isQuantifierStart(c: number): boolean {
    return c === cp('*') || c === cp('+') || c === cp('?') || c === cp('{');
  }

  private parseDisjunction(): Measure {
    let { length, product } = this.parseAlternative();
    while (this.peek() === cp('|')) {
      this.pos++;
      const alternative = this.parseAlternative();
      length = satAdd(length, alternative.length + 1);
      product = Math.max(product, alternative.product);
    }
    return { length, product };
  }

  private parseAlternative(): Measure {
    let length = 0;
    let product = 1;
    while (!this.eof() && this.peek() !== cp('|') && this.peek() !== cp(')')) {
      const term = this.parseTerm();
      length = satAdd(length, term.length);
      product = Math.max(product, term.product);
    }
    return { length, product };
  }

  private parseTerm(): Measure {
    const start = this.pos;
    const c = this.peek();
    if (c === cp('^') || c === cp('$')) {
      this.pos++;
      // Assertions are not quantifiable in ECMA-262 `u`.
      if (ProfileParser.isQuantifierStart(this.peek())) this.fail('quantifier after an assertion');
      return { length: 1, product: 1 };
    }
    if (c === cp('(')) return this.parseQuantifier(this.parseGroup());
    if (c === cp('[')) {
      this.parseClass();
    } else if (c === cp('\\')) {
      this.parseEscape(false);
    } else if (ProfileParser.isQuantifierStart(c)) {
      this.fail('nothing to repeat');
    } else if (c === cp('}') || c === cp(']')) {
      this.fail(`unescaped '${String.fromCodePoint(c)}'`);
    } else {
      this.pos++; // a literal or '.'
    }
    // A literal, escape or class counts by its spelling.
    return this.parseQuantifier({ length: this.pos - start, product: 1 });
  }

  private parseGroup(): Measure {
    const start = this.pos;
    this.pos++; // '('
    if (this.peek() === cp('?')) {
      if (this.peek(1) !== cp(':')) this.fail('unsupported group construct');
      this.pos += 2;
    }
    if (++this.depth > MAX_REGEX_GROUP_DEPTH) this.fail(`groups nested deeper than ${MAX_REGEX_GROUP_DEPTH}`);
    const opening = this.pos - start;
    const { length, product } = this.parseDisjunction();
    this.depth--;
    if (this.peek() !== cp(')')) this.fail('unterminated group');
    this.pos++;
    return { length: satAdd(length, opening + 1), product };
  }

  /** Parse an optional quantifier after an atom with the given measure. */
  private parseQuantifier(atom: Measure): Measure {
    const start = this.pos;
    let copies = 1;
    let factor = 1;
    const c = this.peek();
    if (c === cp('*') || c === cp('+') || c === cp('?')) {
      this.pos++;
    } else if (c === cp('{')) {
      const [low, high] = this.parseBraceQuantifier();
      if (high === undefined) {
        copies = low + 1;
        factor = Math.max(low, 1);
      } else {
        copies = factor = Math.max(high, 1);
      }
    } else {
      return atom;
    }
    if (this.peek() === cp('?')) this.pos++; // lazy
    if (ProfileParser.isQuantifierStart(this.peek())) this.fail('nested quantifier');
    const product = factor * atom.product;
    if (product > MAX_REGEX_REPEAT) this.fail(`nested repetition above ${MAX_REGEX_REPEAT}`);
    return { length: satAdd(this.pos - start, satMul(copies, atom.length)), product };
  }

  /**
   * Return n and m for `{n}`, `{n,}` or `{n,m}`; m is undefined for `{n,}`.
   * Other uses of `{` are invalid in ECMA-262 `u`, even if RE2 accepts them.
   */
  private parseBraceQuantifier(): [number, number | undefined] {
    this.pos++; // '{'
    const low = this.parseRepeatCount();
    let high: number | undefined = low;
    if (this.peek() === cp(',')) {
      this.pos++;
      high = this.peek() === cp('}') ? undefined : this.parseRepeatCount();
    }
    if (this.peek() !== cp('}')) this.fail('malformed repetition');
    this.pos++;
    if (high !== undefined && high < low) this.fail(`repetition range {${low},${high}} out of order`);
    return [low, high];
  }

  /**
   * Parse a decimal count without leading zeros (RE2 reads `a{01}` as a
   * literal) and at most {@link MAX_REGEX_REPEAT}.
   */
  private parseRepeatCount(): number {
    const start = this.pos;
    while (this.peek() >= cp('0') && this.peek() <= cp('9')) this.pos++;
    const digits = String.fromCodePoint(...this.src.slice(start, this.pos));
    if (digits === '') this.fail('malformed repetition');
    if (digits.length > 1 && digits[0] === '0') this.fail('repetition count with a leading zero');
    if (digits.length > 4 || Number(digits) > MAX_REGEX_REPEAT) this.fail(`repetition count above ${MAX_REGEX_REPEAT}`);
    return Number(digits);
  }

  /** Parse the escape at the current position. */
  private parseEscape(inClass: boolean): ClassAtom {
    this.pos++; // '\'
    if (this.eof()) this.fail('trailing backslash');
    const c = this.peek();
    this.pos++;
    if (SYNTAX_ESCAPES.has(c) || (inClass && c === cp('-'))) return { codePoint: c, isSet: false };
    const control = CONTROL_ESCAPES[String.fromCodePoint(c)];
    if (control !== undefined) return { codePoint: control, isSet: false };
    if (SHORTHAND_ESCAPES.has(c)) return { codePoint: 0, isSet: true };
    if (c === cp('x')) {
      const high = hexDigitValue(this.peek());
      const low = hexDigitValue(this.peek(1));
      if (high < 0 || low < 0) this.fail('\\x requires two hexadecimal digits');
      this.pos += 2;
      return { codePoint: (high << 4) | low, isSet: false };
    }
    this.pos--;
    this.fail(`unsupported escape \\${String.fromCodePoint(c)}`);
  }

  /**
   * Reject empty, nested and ambiguous classes (GTS §11.0.1).
   * Doubled `&&`, `--` and `~~` are set operations in Rust and ECMA-262 `v`.
   */
  private parseClass(): void {
    this.pos++; // '['
    if (this.peek() === cp('^')) this.pos++;
    for (let first = true; ; first = false) {
      const c = this.peek();
      if (c === EOF) this.fail('unterminated class');
      if (c === cp(']')) {
        if (first) this.fail('empty class');
        this.pos++;
        return;
      }
      if ((c === cp('&') || c === cp('-') || c === cp('~')) && this.peek(1) === c) {
        this.fail(`ambiguous class spelling '${String.fromCodePoint(c, c)}'`);
      }
      if (c === cp('-') && !first && this.peek(1) !== cp(']')) {
        this.fail("'-' must start or end a class or form a range");
      }
      this.parseClassRange();
    }
  }

  /** Parse one class atom, or a range of two single code points. */
  private parseClassRange(): void {
    const low = this.parseClassAtom();
    if (this.peek() !== cp('-') || this.peek(1) === cp(']') || this.peek(1) === EOF) return;
    if (this.peek(1) === cp('-')) this.fail("ambiguous class spelling '--'");
    this.pos++; // '-'
    if (low.isSet) this.fail('class range with a shorthand class');
    const high = this.parseClassAtom();
    if (high.isSet) this.fail('class range with a shorthand class');
    if (high.codePoint < low.codePoint) this.fail('class range out of order');
  }

  private parseClassAtom(): ClassAtom {
    const c = this.peek();
    if (c === cp('\\')) return this.parseEscape(true);
    if (c === cp('[')) this.fail("unescaped '[' in a class");
    if ((c === cp('&') || c === cp('-') || c === cp('~')) && this.peek(1) === c) {
      this.fail(`ambiguous class spelling '${String.fromCodePoint(c, c)}'`);
    }
    this.pos++;
    return { codePoint: c, isSet: false };
  }
}

function hexDigitValue(c: number): number {
  if (c >= cp('0') && c <= cp('9')) return c - cp('0');
  if (c >= cp('a') && c <= cp('f')) return c - cp('a') + 10;
  if (c >= cp('A') && c <= cp('F')) return c - cp('A') + 10;
  return -1;
}

/**
 * Return a profile or support-bound violation, or undefined for a supported expression.
 */
export function regexProfileViolation(source: string): string | undefined {
  // Expanded length is at least the source length; each code point uses at most two UTF-16 units.
  const tooLong = `expanded length above ${MAX_REGEX_EXPANDED_LENGTH}`;
  if (source.length > 2 * MAX_REGEX_EXPANDED_LENGTH) return tooLong;
  const codePoints = Array.from(source, cp);
  if (codePoints.length > MAX_REGEX_EXPANDED_LENGTH) return tooLong;
  // The profile is defined over Unicode scalar values.
  const surrogate = codePoints.findIndex((c) => c >= 0xd800 && c <= 0xdfff);
  if (surrogate >= 0) return `unpaired surrogate at offset ${surrogate}`;
  try {
    if (new ProfileParser(codePoints).parse() > MAX_REGEX_EXPANDED_LENGTH) return tooLong;
  } catch (error) {
    if (error instanceof ProfileViolation) return error.message;
    throw error;
  }
  return undefined;
}
