import { GTS, matchIDPattern, idToUUID } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

describe('OP#4 - wildcard version matching', () => {
  test('a major-only version wildcard matches any minor of that major', () => {
    expect(matchIDPattern('gts.x.pkg.ns.type.v0.2~', 'gts.x.pkg.ns.type.v0.*').match).toBe(true);
  });

  test('a major-only version wildcard rejects a different major', () => {
    // Regression guard: `v0` must not be read as "no version specified".
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.2~', 'gts.x.pkg.ns.type.v0.*').match).toBe(false);
  });

  test('an omitted minor version in the pattern matches any minor', () => {
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.5~', 'gts.x.pkg.ns.type.v1~').match).toBe(true);
    expect(matchIDPattern('gts.x.pkg.ns.type.v2~', 'gts.x.pkg.ns.type.v1~').match).toBe(false);
  });

  test('a minor wildcard requires an explicit minor in its segment (spec §10)', () => {
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~', 'gts.x.pkg.ns.type.v1.*').match).toBe(false);
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.0~a.b.c.d.v1', 'gts.x.pkg.ns.type.v1.*').match).toBe(true);
  });

  test('omitted minors are flexible in every segment of a concrete instance selector', () => {
    const selector = 'gts.x.pkg.ns.type.v1~a.b._.item.v1';
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.3~a.b._.item.v1.2', selector).match).toBe(true);
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~a.b._.item.v12', selector).match).toBe(false);
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~a.b._.item.v1~a.b._.sub.v1', selector).match).toBe(false);
  });
});

describe('OP#4 - pattern grammar and coverage (spec §10)', () => {
  test('version components are unsigned 32-bit integers', () => {
    const largest = matchIDPattern('gts.x.pkg.ns.type.v4294967295~', 'gts.*');
    expect(largest.match).toBe(true);
    expect(largest.error).toBeUndefined();
    expect(matchIDPattern('gts.x.pkg.ns.type.v4294967296~', 'gts.*').error).toMatch(/exceeds 4294967295/);
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.4294967296~', 'gts.*').error).toBeTruthy();
  });

  test('identifiers are validated as spelled, without trimming', () => {
    expect(matchIDPattern(' gts.x.pkg.ns.type.v1~', 'gts.*').error).toBeTruthy();
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~ ', 'gts.*').error).toBeTruthy();
  });

  test('wildcards may only follow a complete token or the version marker', () => {
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~', 'gts.x.pkg.ns.type.v*').match).toBe(true);
    for (const invalid of ['gts.x.pkg.ns.typ*', 'gts.x.pkg.ns.type.v1*', 'gts.x.pkg.ns.type.v1.0.*']) {
      expect(matchIDPattern('gts.x.pkg.ns.type.v1~', invalid).error).toBeTruthy();
    }
  });

  test('a pattern candidate matches only when the filter covers it', () => {
    expect(matchIDPattern('gts.x.pkg.ns.type.v1.*', 'gts.x.pkg.ns.type.v1~').match).toBe(true);
    // `v1~*` also selects `v1~`, which `v1.*` excludes.
    expect(matchIDPattern('gts.x.pkg.ns.type.v1~*', 'gts.x.pkg.ns.type.v1.*').match).toBe(false);
    expect(matchIDPattern('gts.vendor.*', 'gts.vendor.pkg.*').match).toBe(false);
    expect(matchIDPattern('gts.vendor.pkg.*', 'gts.vendor.*').match).toBe(true);
  });

  test('a pattern that selects no identifier within the length limit is covered by any filter', () => {
    const empty = 'gts.' + 'a'.repeat(1011) + '.*';
    const nonEmpty = 'gts.' + 'a'.repeat(1010) + '.*';
    expect(matchIDPattern(empty, 'gts.x.core.resources.resource.*').match).toBe(true);
    expect(matchIDPattern(nonEmpty, 'gts.x.core.resources.resource.*').match).toBe(false);
  });
});

describe('OP#4 / OP#10 - chain-suffix wildcards', () => {
  /*
   * Since gts-spec 0.16.1 the two operations agree: a bare chain-suffix
   * wildcard may match an empty suffix, so `type.v1~*` selects `type.v1~`
   * itself in both OP#4 matching and OP#10 collection queries (§10).
   */
  test('pattern matching treats a chain-suffix wildcard as including the type itself', () => {
    expect(matchIDPattern('gts.vendor.pkg.ns.type.v0~', 'gts.vendor.pkg.ns.type.v0~*').match).toBe(true);
    expect(matchIDPattern('gts.vendor.pkg.ns.type.v0.1~', 'gts.vendor.pkg.ns.type.v0~*').match).toBe(true);
  });

  test('a collection query with a chain-suffix wildcard includes the root type', () => {
    const gts = new GTS({ validateRefs: false });
    const ids = [
      'gts.x.unit.wc.message.v1.0~',
      'gts.x.unit.wc.message.v1.0~x.unit._.system.v1.0~',
      'gts.x.unit.wc.message.v1.1~',
      'gts.x.unit.wc.message.v1.1~x.unit._.user.v1.1~',
    ];
    ids.forEach((id) => gts.register({ $id: id, $schema: DRAFT7, type: 'object' }));

    // v1.0 itself and the type derived from it.
    const fromV10 = gts.query('gts.x.unit.wc.message.v1.0~*');
    expect(fromV10.items.map((item) => item.$id).sort()).toEqual([
      'gts.x.unit.wc.message.v1.0~',
      'gts.x.unit.wc.message.v1.0~x.unit._.system.v1.0~',
    ]);

    // Any minor of v1: both bases and both derived types.
    expect(gts.query('gts.x.unit.wc.message.v1~*').count).toBe(4);

    // A minor wildcard requires an explicit minor; here every id has one.
    expect(gts.query('gts.x.unit.wc.message.v1.*').count).toBe(4);

    // A plain token wildcard is unaffected and still matches everything.
    expect(gts.query('gts.x.unit.wc.message.*').count).toBe(4);
  });
});

describe('OP#10 - an explicit major version v0 is a genuine version, not "unspecified" (spec §9.2)', () => {
  /*
   * GTS major and minor versions are non-negative integers, so an explicit
   * `v0` segment is a complete version, not a sentinel for "no version
   * given". Mirrors gts-rust `gts-id/src/gts_id_segment.rs`, which models
   * `ver_major` as `Option<u32>` precisely so an unspecified wildcard major
   * is distinguishable from a literal `0`, and `matches_views`
   * (gts-id/src/gts_id_pattern.rs:88, both the wildcard branch @121-125 and
   * the exact branch @161) compares `ver_major_opt()` rather than treating
   * `0` as falsy.
   *
   * Canonical case: `TestCaseTestOp10Query_ExplicitMajorZeroInstance`
   * (test_op10_query_execution.py:666); gts-rust pin:
   * gts-id/src/gts_id_pattern.rs:342-350.
   */
  const V0_INSTANCE_ID = 'gts.x.test10_zero.zero.event.v0~x.test10_zero._.instance.v0';

  // TODO(phase-1): `GtsQuery.query()` (src/query.ts) rejects this exact,
  // wildcard-free query with "Invalid query: incomplete GTS ID pattern"
  // because its incomplete-pattern guard is `if (!lastSeg.isType &&
  // !lastSeg.verMajor)` - `!lastSeg.verMajor` is true for a genuine `v0`
  // segment (0 is falsy in JS), so an explicit v0 instance segment is
  // indistinguishable from one with no version at all. Needs a
  // `verMajor === undefined` (or equivalent presence flag) check instead of a
  // truthiness check.
  test('an exact, wildcard-free query for an explicit v0 instance id returns that instance rather than being rejected as incomplete', () => {
    const gts = new GTS({ validateRefs: false });
    gts.register({ $id: 'gts.x.test10_zero.zero.event.v0~', $schema: DRAFT7, type: 'object' });
    gts.register({ id: V0_INSTANCE_ID, type: 'gts.x.test10_zero.zero.event.v0~', eventId: 'evt-v0' });

    const result = gts.query(V0_INSTANCE_ID);

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.items[0].id).toBe(V0_INSTANCE_ID);
  });

  test('matchIDPattern also treats the explicit v0 instance id as a complete, matching candidate', () => {
    expect(matchIDPattern(V0_INSTANCE_ID, V0_INSTANCE_ID).match).toBe(true);
  });
});

describe('OP#5 - ID to UUID mapping', () => {
  test('derives a deterministic UUID for an identifier with no UUID tail', () => {
    const first = idToUUID('gts.x.test5.events.type.v1~abc.app._.custom_event.v1.2');
    const second = idToUUID('gts.x.test5.events.type.v1~abc.app._.custom_event.v1.2');

    expect(first.uuid).toBe(second.uuid);
    expect(first.uuid).toBe('c7f8cca7-3af6-58af-b72b-3febfd93f1a8');
  });

  test('returns the embedded UUID of a combined anonymous instance verbatim', () => {
    // The tail already is the instance identity; deriving a second UUID from
    // the string would discard it.
    const id = 'gts.x.core.events.type.v1~x.commerce.orders.order_placed.v1.0~7a1d2f34-5678-49ab-9012-abcdef123456';

    expect(idToUUID(id).uuid).toBe('7a1d2f34-5678-49ab-9012-abcdef123456');
  });
});
