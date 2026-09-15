# gts-spec v0.13.3 conformance baseline

Recorded: 2026-09-14. Command: `make e2e` (pytest + httprunner against `node dist/server/index.js --port 8000`).
Spec pin: `.gts-spec-version` = v0.13.3, submodule `5b5d5786bab1de1192d977a94752e492b66d17a6`.

Result: **43 failed, 442 passed** (485 total).

Progress: **COMPLETE** — all 43 cases green. `make e2e` = **485 passed, 0 failed** (verified 2026-09-15). Phases closed in order 0, 4, 1, 2, 3, 5, 6.

Progress: Phase 1 closed 6 cases — now **32 failed, 453 passed** (verified 2026-09-15, zero new failures).

Progress: Phase 2 closed 5 cases — now **27 failed, 458 passed** (verified 2026-09-15, zero new failures).

Progress: Phase 5 closed 3 cases (x-gts-ref traversal gaps + trait-ref registry existence) — now **18 failed, 467 passed** (verified 2026-09-15, zero new failures). Remaining: validate-json (18, Phase 6).

Each phase of the conformance plan must reduce this list by exactly its own case count,
introducing no new failures. Delete entries as they go green; the file is empty when done.

## Failing cases (43)

- [x] test_op10_query_execution.py::TestCaseTestOp10Query_ExplicitMajorZeroInstance
- [x] test_op13_schema_traits_validation.py::TestCaseOp13_TraitRef_TopicRefNonexistent
- [x] test_op13_schema_traits_validation.py::TestCaseOp13_Traits_RegexEcma262
- [x] test_op13_schema_traits_validation.py::TestCaseOp13_TraitsInvalid_StandardFormats
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoBaseSchema
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoDerivedSchema
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoDerivedSchemaMissingParent
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoIdlessInstance
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoInstance
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoInstanceMissingType
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoInvalidInstance
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_AutoInvalidSchema
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitDerivedType
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitNonSchemaType
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitSchemaWithoutEmbeddedIdentity
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitType
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitTypeInvalidInstance
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitTypeMismatch
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_ExplicitTypeRejectsSchema
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_MalformedExplicitType
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_NonObjectBody
- [x] test_op6_schema_validation.py::TestCaseOp6ValidateJson_UnknownExplicitType
- [x] test_op6_schema_validation.py::TestCaseTestOp6SchemaValidation_DoubleDollarRefDerivedSchemaMismatch
- [x] test_op6_schema_validation.py::TestCaseTestOp6SchemaValidation_DoubleDollarRefNotMapped
- [x] test_op6_schema_validation.py::TestCaseTestOp6SchemaValidation_DoubleDollarSchemaAndId_TreatedAsInstance
- [x] test_op6_schema_validation.py::TestCaseTestOp6SchemaValidation_DoubleDollarSchemaWithRealId_TreatedAsInstance
- [x] test_op6_schema_validation.py::TestCaseTestOp6SchemaValidation_LiteralDoubleDollarIdRejected
- [x] test_op6_schema_validation.py::TestCaseTestOp6Validation_RegexEcma262
- [x] test_op6_schema_validation.py::TestCaseTestOp6Validation_StandardFormats
- [x] test_op6_schema_validation.py::TestCaseTestOp6Validation_UuidRejectsGtsId
- [x] test_op6_schema_validation.py::TestCaseUnknown_InsideAllOfRejected
- [x] test_op6_schema_validation.py::TestCaseUnknown_InsideDefsRejected
- [x] test_op6_schema_validation.py::TestCaseUnknown_InsidePropertiesRejected
- [x] test_op6_schema_validation.py::TestCaseUnknown_RefTypoRejected
- [x] test_op6_schema_validation.py::TestCaseUnknown_TopLevelRejected
- [x] test_op6_schema_validation.py::TestCaseUnknown_TraitsTypoRejected
- [x] test_op8_compatibility_checking.py::TestCaseTestOp8Compatibility_DistinctDialects
- [x] test_op9_version_casting.py::TestCaseTestOp9Cast_AllOfHiddenConstraintVisible
- [x] test_op9_version_casting.py::TestCaseTestOp9Cast_DistinctDialects
- [x] test_op9_version_casting.py::TestCaseTestOp9Cast_EnumAdded
- [x] test_op9_version_casting.py::TestCaseTestOp9Cast_EnumRemoved
- [x] test_refimpl_x_gts_ref.py::TestCaseXGtsRef_ImplicitObjectAndLocalRef
- [x] test_refimpl_x_gts_ref.py::TestCaseXGtsRef_RootLocalReference

## Phase mapping

| Phase | Cases | Group |
|---|---:|---|
| 1 | 6 | OP#8 DistinctDialects, OP#9 ×4, OP#10 ExplicitMajorZeroInstance |
| 2 | 5 | OP#6 StandardFormats / RegexEcma262 / UuidRejectsGtsId, OP#13 TraitsInvalid_StandardFormats / Traits_RegexEcma262 |
| 3 | 6 | TestCaseUnknown_* |
| 4 | 5 | TestCaseTestOp6SchemaValidation_*DoubleDollar* |
| 5 | 3 | XGtsRef_RootLocalReference, XGtsRef_ImplicitObjectAndLocalRef, Op13_TraitRef_TopicRefNonexistent |
| 6 | 18 | Op6ValidateJson_* |
