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
});

describe('OP#4 / OP#10 - chain-suffix wildcards', () => {
  /*
   * The two operations disagree in the gts-spec 0.13 suite and both verdicts
   * are asserted there, so the divergence is deliberate and pinned here:
   *
   *   OP#4  (§10 prose)    `type.v1~*` matches `type.v1~` itself.
   *   OP#10 (§10 examples) a collection query returns only derived identifiers.
   *
   * In gts-spec 0.12 both were exclusive; 0.13 flipped only the OP#4
   * assertions and left the OP#10 expectations unchanged.
   */
  test('pattern matching treats a chain-suffix wildcard as including the type itself', () => {
    expect(matchIDPattern('gts.vendor.pkg.ns.type.v0~', 'gts.vendor.pkg.ns.type.v0~*').match).toBe(true);
    expect(matchIDPattern('gts.vendor.pkg.ns.type.v0.1~', 'gts.vendor.pkg.ns.type.v0~*').match).toBe(true);
  });

  test('a collection query with a chain-suffix wildcard returns only derived identifiers', () => {
    const gts = new GTS({ validateRefs: false });
    const ids = [
      'gts.x.unit.wc.message.v1.0~',
      'gts.x.unit.wc.message.v1.0~x.unit._.system.v1.0~',
      'gts.x.unit.wc.message.v1.1~',
      'gts.x.unit.wc.message.v1.1~x.unit._.user.v1.1~',
    ];
    ids.forEach((id) => gts.register({ $id: id, $schema: DRAFT7, type: 'object' }));

    // Only the type derived from v1.0, not v1.0 itself.
    const derivedFromV10 = gts.query('gts.x.unit.wc.message.v1.0~*');
    expect(derivedFromV10.count).toBe(1);
    expect(derivedFromV10.items[0].$id).toBe('gts.x.unit.wc.message.v1.0~x.unit._.system.v1.0~');

    // Any minor of v1: both derived types, neither base.
    expect(gts.query('gts.x.unit.wc.message.v1~*').count).toBe(2);

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
