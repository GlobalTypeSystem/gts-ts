import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import { GTS } from '../src';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

/**
 * Property-based soundness test for the OP#8 subsumption engine.
 *
 * The engine's verdicts are defined by accepted-instance-set inclusion (§4.3),
 * which makes them checkable against an actual JSON Schema validator rather
 * than against our reading of the spec:
 *
 *   backward === 'compatible'  =>  every instance ajv accepts under `old`
 *                                  is also accepted under `new`
 *   forward  === 'compatible'  =>  every instance ajv accepts under `new`
 *                                  is also accepted under `old`
 *
 * A violation is a definite bug: the engine claimed inclusion that does not
 * hold. This is the failure mode that repeatedly slipped past hand-written
 * tests - a keyword modeled in one place and not another silently widens a
 * verdict, and no single example test looks wrong.
 *
 * Only `compatible` is checked. `unknown` is inconclusive by construction, and
 * `incompatible` cannot be refuted by sampling: not finding a distinguishing
 * instance among finitely many does not prove none exists. So this test is a
 * soundness check, not a completeness one.
 *
 * The space is enumerated rather than randomised, so a failure reproduces
 * exactly and CI cannot flake.
 *
 * Deliberate exclusions, so the boundary is explicit rather than silent:
 *
 * - `additionalProperties` never appears *inside* an `allOf` branch. The engine
 *   builds one resolved effective schema (§4.4 requires classifying the content
 *   model from it), whereas ajv evaluates `allOf` branches independently, so a
 *   closed branch beside a branch declaring properties genuinely disagrees. That
 *   divergence is a modeling decision, not a defect, and would swamp the signal.
 * - No `gts://` `$ref`, because ajv would need the registry's ref loader to see
 *   the same schema the engine does. Plain `allOf` composition is covered.
 * - No malformed schemas (`allOf` as an object, a property schema of `1`). ajv
 *   cannot compile them, so there is no oracle to compare against; that
 *   behaviour stays covered by the hand-written cases in compatibility.test.ts.
 *
 * Verified to have teeth by mutation: reverting the position-aware walker
 * reports `{"title":"a"}` distinguishing two schemas it called compatible, and
 * reverting the numeric-widening fix reports `1.5` doing the same. If a change
 * here makes those mutations pass, this test has stopped working.
 */

/** Leaf property schemas, chosen to cover every keyword the engine models. */
const LEAVES: Array<[string, Record<string, unknown>]> = [
  ['any', {}],
  ['string', { type: 'string' }],
  ['number', { type: 'number' }],
  ['integer', { type: 'integer' }],
  ['string-max3', { type: 'string', maxLength: 3 }],
  ['string-min2', { type: 'string', minLength: 2 }],
  ['num-min0', { type: 'number', minimum: 0 }],
  ['num-gt0', { type: 'number', exclusiveMinimum: 0 }],
  ['num-max10', { type: 'number', maximum: 10 }],
  ['num-lt10', { type: 'number', exclusiveMaximum: 10 }],
  ['enum-ab', { type: 'string', enum: ['a', 'b'] }],
  ['enum-abc', { type: 'string', enum: ['a', 'b', 'c'] }],
  ['const-a', { type: 'string', const: 'a' }],
  ['pattern-a', { type: 'string', pattern: '^a' }],
];

interface Candidate {
  label: string;
  body: Record<string, any>;
}

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  // The main matrix: one property, varying its schema, requiredness and the
  // content model of the object around it.
  for (const [leafName, leaf] of LEAVES) {
    for (const required of [false, true]) {
      for (const [apName, apKey, ap] of [
        ['open', 'additionalProperties', undefined],
        ['closed', 'additionalProperties', false],
        ['up-string', 'unevaluatedProperties', { type: 'string' }],
      ] as Array<[string, string, unknown]>) {
        const body: Record<string, any> = { type: 'object', properties: { p: leaf } };
        if (required) body.required = ['p'];
        if (ap !== undefined) body[apKey] = ap;
        candidates.push({ label: `p:${leafName}/${required ? 'req' : 'opt'}/${apName}`, body });
      }
    }
  }

  // A property whose name collides with an annotation keyword. Stripping
  // annotations without knowing that `properties` keys are user-chosen names
  // deleted these and made the schemas compare as identical.
  for (const dataKey of ['title', 'description', 'format', 'default']) {
    for (const [leafName, leaf] of [LEAVES[1], LEAVES[2]].map((l, i) => [i === 0 ? 'string' : 'number', l[1]]) as Array<
      [string, Record<string, unknown>]
    >) {
      candidates.push({
        label: `data-key ${dataKey}:${leafName}`,
        body: { type: 'object', properties: { [dataKey]: leaf }, required: [dataKey] },
      });
    }
  }

  // allOf composition, including a branch restating the same type - which is
  // what a derived type declaring a numeric property looks like.
  candidates.push(
    { label: 'allOf number+number', body: { allOf: [{ type: 'number' }, { type: 'number' }] } },
    { label: 'allOf number+integer', body: { allOf: [{ type: 'number' }, { type: 'integer' }] } },
    { label: 'allOf string+max3', body: { allOf: [{ type: 'string' }, { type: 'string', maxLength: 3 }] } },
    {
      label: 'allOf props p+q',
      body: { allOf: [{ properties: { p: { type: 'string' } } }, { properties: { q: { type: 'number' } } }] },
    },
    {
      label: 'allOf min0+max10',
      body: {
        allOf: [
          { type: 'number', minimum: 0 },
          { type: 'number', maximum: 10 },
        ],
      },
    },
    { label: 'bare number', body: { type: 'number' } },
    { label: 'bare integer', body: { type: 'integer' } },
    { label: 'bare string', body: { type: 'string' } },
    { label: 'empty', body: {} },
    {
      label: 'nested object',
      body: {
        type: 'object',
        properties: { outer: { type: 'object', properties: { inner: { type: 'string' } }, required: ['inner'] } },
        required: ['outer'],
      },
    }
  );

  return candidates;
}

/** Instances chosen to distinguish the schemas above. */
const INSTANCES: unknown[] = [
  {},
  { p: 'a' },
  { p: 'b' },
  { p: 'c' },
  { p: 'ab' },
  { p: 'abcd' },
  { p: 0 },
  { p: 1 },
  { p: 5 },
  { p: 10 },
  { p: 10.5 },
  { p: -1 },
  { p: null },
  { p: true },
  { p: {} },
  { p: [] },
  { q: 'x' },
  { p: 'a', q: 'x' },
  { title: 'a' },
  { title: 1 },
  { description: 'a' },
  { format: 1 },
  { default: 'a' },
  { outer: { inner: 'a' } },
  { outer: {} },
  'a',
  1,
  1.5,
  null,
  true,
  [],
];

describe('OP#8 - subsumption soundness against a real JSON Schema validator', () => {
  const candidates = buildCandidates();
  const ids = candidates.map((_, index) => `gts.x.prop.gen.s${index}.v1~`);

  // accepts[i][m] - does schema i accept instance m, per ajv
  let accepts: boolean[][];
  let gts: GTS;

  beforeAll(() => {
    const ajv = new Ajv({ strict: false, validateSchema: false, allErrors: false });
    // Draft-07 (the `ajv` default dialect) has no `unevaluatedProperties`
    // keyword at all, so candidates that use it need a 2019-09 instance -
    // otherwise the oracle would silently ignore the keyword and the
    // comparison would prove nothing about it either way.
    const ajv2019 = new Ajv2019({ strict: false, validateSchema: false, allErrors: false });
    accepts = candidates.map((candidate) => {
      const usesUnevaluated = 'unevaluatedProperties' in candidate.body;
      const validate = usesUnevaluated
        ? ajv2019.compile(candidate.body)
        : ajv.compile({ $schema: DRAFT7, ...candidate.body });
      return INSTANCES.map((instance) => validate(instance) as boolean);
    });

    gts = new GTS({ validateRefs: false });
    candidates.forEach((candidate, index) => {
      gts.register({ $id: ids[index], $schema: DRAFT7, ...candidate.body });
    });
  });

  test(`no 'compatible' verdict overstates inclusion`, () => {
    const violations: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        const result = gts.checkCompatibility(ids[i], ids[j]);

        // backward: Valid(old=i) subset-of Valid(new=j)
        if (result.backward_compatibility === 'compatible') {
          const witness = INSTANCES.findIndex((_, m) => accepts[i][m] && !accepts[j][m]);
          if (witness !== -1) {
            violations.push(
              `backward said compatible but instance ${JSON.stringify(INSTANCES[witness])} ` +
                `is accepted by old [${candidates[i].label}] and rejected by new [${candidates[j].label}]`
            );
          }
        }

        // forward: Valid(new=j) subset-of Valid(old=i)
        if (result.forward_compatibility === 'compatible') {
          const witness = INSTANCES.findIndex((_, m) => accepts[j][m] && !accepts[i][m]);
          if (witness !== -1) {
            violations.push(
              `forward said compatible but instance ${JSON.stringify(INSTANCES[witness])} ` +
                `is accepted by new [${candidates[j].label}] and rejected by old [${candidates[i].label}]`
            );
          }
        }
      }
    }

    expect(violations.slice(0, 10)).toEqual([]);
  });

  test('full compatibility holds exactly when both directions hold', () => {
    const inconsistent: string[] = [];

    for (let i = 0; i < candidates.length; i += 7) {
      for (let j = 0; j < candidates.length; j += 5) {
        const r = gts.checkCompatibility(ids[i], ids[j]);
        const expected =
          r.backward_compatibility === 'incompatible' || r.forward_compatibility === 'incompatible'
            ? 'incompatible'
            : r.backward_compatibility === 'unknown' || r.forward_compatibility === 'unknown'
              ? 'unknown'
              : 'compatible';
        if (r.full_compatibility !== expected) {
          inconsistent.push(
            `[${candidates[i].label}] -> [${candidates[j].label}]: full=${r.full_compatibility} ` +
              `but backward=${r.backward_compatibility}, forward=${r.forward_compatibility}`
          );
        }
      }
    }

    expect(inconsistent).toEqual([]);
  });

  test('the generated space is large enough to be meaningful', () => {
    // Guards against a future edit quietly shrinking coverage to nothing.
    expect(candidates.length).toBeGreaterThanOrEqual(60);
    expect(INSTANCES.length).toBeGreaterThanOrEqual(25);
  });
});
