import Ajv from 'ajv';
import { GtsConfig, JsonEntity, ValidationResult, CompatibilityResult, GTS_URI_PREFIX } from './types';
import { Gts } from './gts';
import { GtsExtractor } from './extract';
import { XGtsRefValidator } from './x-gts-ref';

export class GtsStore {
  private byId: Map<string, JsonEntity> = new Map();
  private config: GtsConfig;
  private ajv: Ajv;

  constructor(config?: Partial<GtsConfig>) {
    this.config = {
      validateRefs: config?.validateRefs ?? false,
      strictMode: config?.strictMode ?? false,
    };

    this.ajv = new Ajv({
      strict: false,
      validateSchema: false,
      addUsedSchema: false,
      loadSchema: this.loadSchema.bind(this),
      validateFormats: false, // Disable format validation to match Go implementation
    });
    // Don't add format validators since Go uses lenient validation
  }

  private async loadSchema(uri: string): Promise<any> {
    const normalizedUri = uri.startsWith(GTS_URI_PREFIX) ? uri.substring(GTS_URI_PREFIX.length) : uri;

    if (Gts.isValidGtsID(normalizedUri)) {
      const entity = this.get(normalizedUri);
      if (entity && entity.isSchema) {
        return entity.content;
      }
    }
    throw new Error(`Unresolvable GTS reference: ${uri}`);
  }

  register(entity: JsonEntity): void {
    if (this.config.validateRefs) {
      for (const ref of entity.references) {
        if (!this.byId.has(ref)) {
          throw new Error(`Unresolved reference: ${ref}`);
        }
      }
    }
    this.byId.set(entity.id, entity);

    // If this is a schema, add it to AJV for reference resolution
    if (entity.isSchema && entity.content) {
      try {
        const normalizedSchema = this.normalizeSchema(entity.content);
        // Set $id to the GTS ID if not already set
        if (!normalizedSchema.$id) {
          normalizedSchema.$id = entity.id;
        }
        this.ajv.addSchema(normalizedSchema, entity.id);
      } catch (err) {
        // Ignore errors adding schema - it might already exist or be invalid
      }
    }
  }

  get(id: string): JsonEntity | undefined {
    return this.byId.get(id);
  }

  getAll(): JsonEntity[] {
    return Array.from(this.byId.values());
  }

  query(pattern: string, limit?: number): string[] {
    const results: string[] = [];
    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;

    for (const [id] of this.byId) {
      if (results.length >= maxResults) break;

      const matchResult = Gts.matchIDPattern(id, pattern);
      if (matchResult.match) {
        results.push(id);
      }
    }

    return results;
  }

  validateInstance(gtsId: string): ValidationResult {
    try {
      const gid = Gts.parseGtsID(gtsId);

      const obj = this.get(gid.id);
      if (!obj) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Entity not found: ${gtsId}`,
        };
      }

      if (!obj.schemaId) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `No schema found for instance: ${gtsId}`,
        };
      }

      const schemaEntity = this.get(obj.schemaId);
      if (!schemaEntity) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Schema not found: ${obj.schemaId}`,
        };
      }

      if (!schemaEntity.isSchema) {
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `Entity '${obj.schemaId}' is not a schema`,
        };
      }

      const validate = this.ajv.compile(this.normalizeSchema(schemaEntity.content));
      const isValid = validate(obj.content);

      if (!isValid) {
        const errors =
          validate.errors
            ?.map((e) => {
              if (e.keyword === 'required') {
                return `${e.instancePath || '/'} must have required property '${(e.params as any)?.missingProperty}'`;
              }
              return `${e.instancePath} ${e.message}`;
            })
            .join('; ') || 'Validation failed';
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: errors,
        };
      }

      // Validate x-gts-ref constraints
      const xGtsRefValidator = new XGtsRefValidator(this);
      const xGtsRefErrors = xGtsRefValidator.validateInstance(obj.content, schemaEntity.content);
      if (xGtsRefErrors.length > 0) {
        const errorMsgs = xGtsRefErrors.map((err) => err.reason).join('; ');
        return {
          id: gtsId,
          ok: false,
          valid: false,
          error: `x-gts-ref validation failed: ${errorMsgs}`,
        };
      }

      return {
        id: gtsId,
        ok: true,
        valid: true,
        error: '',
      };
    } catch (error) {
      return {
        id: gtsId,
        ok: false,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private normalizeSchema(schema: any): any {
    return this.normalizeSchemaRecursive(schema);
  }

  private normalizeSchemaRecursive(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.normalizeSchemaRecursive(item));
    }

    const normalized: any = {};

    for (const [key, value] of Object.entries(obj)) {
      // Strip x-gts-ref so Ajv never sees the unknown keyword
      if (key === 'x-gts-ref') continue;

      let newKey = key;
      let newValue = value;

      // Convert $$ prefixed keys to $ prefixed keys
      switch (key) {
        case '$$id':
          newKey = '$id';
          break;
        case '$$schema':
          newKey = '$schema';
          break;
        case '$$ref':
          newKey = '$ref';
          break;
        case '$$defs':
          newKey = '$defs';
          break;
      }

      // Recursively normalize nested objects
      if (value && typeof value === 'object') {
        newValue = this.normalizeSchemaRecursive(value);
      }

      normalized[newKey] = newValue;
    }

    // Clean up combinator arrays: remove subschemas that were x-gts-ref-only (now empty after stripping)
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(normalized[combinator])) {
        normalized[combinator] = normalized[combinator].filter((_sub: any, idx: number) => {
          const original = (obj as any)[combinator]?.[idx];
          const isXGtsRefOnly =
            original &&
            typeof original === 'object' &&
            !Array.isArray(original) &&
            Object.keys(original).length === 1 &&
            original['x-gts-ref'] !== undefined;
          return !isXGtsRefOnly;
        });
        if (normalized[combinator].length === 0) {
          delete normalized[combinator];
        }
      }
    }

    // Normalize $id values
    if (normalized['$id'] && typeof normalized['$id'] === 'string') {
      if (normalized['$id'].startsWith(GTS_URI_PREFIX)) {
        normalized['$id'] = normalized['$id'].substring(GTS_URI_PREFIX.length);
      }
    }

    // Normalize $ref values
    if (normalized['$ref'] && typeof normalized['$ref'] === 'string') {
      if (normalized['$ref'].startsWith(GTS_URI_PREFIX)) {
        normalized['$ref'] = normalized['$ref'].substring(GTS_URI_PREFIX.length);
      }
    }

    return normalized;
  }

  resolveRelationships(gtsId: string): any {
    const seen = new Set<string>();
    return this.buildSchemaGraphNode(gtsId, seen);
  }

  private buildSchemaGraphNode(gtsId: string, seen: Set<string>): any {
    const node: any = {
      id: gtsId,
    };

    // Check for cycles
    if (seen.has(gtsId)) {
      return node;
    }
    seen.add(gtsId);

    // Get the entity from store
    const entity = this.get(gtsId);
    if (!entity) {
      node.errors = ['Entity not found'];
      return node;
    }

    // Process GTS references found in the entity
    const refs = this.extractGtsReferences(entity.content);
    const nodeRefs: any = {};

    for (const ref of refs) {
      // Skip self-references
      if (ref.id === gtsId) {
        continue;
      }
      // Skip JSON Schema meta-schema references
      if (this.isJsonSchemaUrl(ref.id)) {
        continue;
      }
      // Recursively build node for this reference
      nodeRefs[ref.sourcePath] = this.buildSchemaGraphNode(ref.id, seen);
    }

    if (Object.keys(nodeRefs).length > 0) {
      node.refs = nodeRefs;
    }

    // Process schema ID if present
    if (entity.schemaId) {
      if (!this.isJsonSchemaUrl(entity.schemaId)) {
        node.schema_id = this.buildSchemaGraphNode(entity.schemaId, seen);
      }
    } else if (!entity.isSchema) {
      // Instance without schema ID is an error
      node.errors = node.errors || [];
      node.errors.push('Schema not recognized');
    }

    return node;
  }

  private extractGtsReferences(content: any): Array<{ id: string; sourcePath: string }> {
    const refs: Array<{ id: string; sourcePath: string }> = [];
    const seen = new Set<string>();

    const walkAndCollectRefs = (node: any, path: string) => {
      if (node === null || node === undefined) {
        return;
      }

      // Check if current node is a GTS ID string
      if (typeof node === 'string') {
        if (Gts.isValidGtsID(node)) {
          const sourcePath = path || 'root';
          const key = `${node}|${sourcePath}`;
          if (!seen.has(key)) {
            refs.push({ id: node, sourcePath });
            seen.add(key);
          }
        }
        return;
      }

      // Recurse into object
      if (typeof node === 'object' && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node)) {
          const nextPath = path ? `${path}.${k}` : k;
          walkAndCollectRefs(v, nextPath);
        }
        return;
      }

      // Recurse into array
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const nextPath = path ? `${path}[${i}]` : `[${i}]`;
          walkAndCollectRefs(node[i], nextPath);
        }
      }
    };

    walkAndCollectRefs(content, '');
    return refs;
  }

  private isJsonSchemaUrl(s: string): boolean {
    return (s.startsWith('http://') || s.startsWith('https://')) && s.includes('json-schema.org');
  }

  checkCompatibility(oldSchemaId: string, newSchemaId: string, _mode?: string): CompatibilityResult {
    const oldEntity = this.get(oldSchemaId);
    const newEntity = this.get(newSchemaId);

    if (!oldEntity || !newEntity) {
      return {
        from: oldSchemaId,
        to: newSchemaId,
        old: oldSchemaId,
        new: newSchemaId,
        direction: 'unknown',
        added_properties: [],
        removed_properties: [],
        changed_properties: [],
        is_fully_compatible: false,
        is_backward_compatible: false,
        is_forward_compatible: false,
        incompatibility_reasons: [],
        backward_errors: ['Schema not found'],
        forward_errors: ['Schema not found'],
      };
    }

    const oldSchema = oldEntity.content;
    const newSchema = newEntity.content;

    if (!oldSchema || !newSchema) {
      return {
        from: oldSchemaId,
        to: newSchemaId,
        old: oldSchemaId,
        new: newSchemaId,
        direction: 'unknown',
        added_properties: [],
        removed_properties: [],
        changed_properties: [],
        is_fully_compatible: false,
        is_backward_compatible: false,
        is_forward_compatible: false,
        incompatibility_reasons: [],
        backward_errors: ['Invalid schema content'],
        forward_errors: ['Invalid schema content'],
      };
    }

    // Check compatibility
    const { isBackward, backwardErrors } = this.checkBackwardCompatibility(oldSchema, newSchema);
    const { isForward, forwardErrors } = this.checkForwardCompatibility(oldSchema, newSchema);

    // Determine direction
    const direction = this.inferDirection(oldSchemaId, newSchemaId);

    return {
      from: oldSchemaId,
      to: newSchemaId,
      old: oldSchemaId,
      new: newSchemaId,
      direction,
      added_properties: [],
      removed_properties: [],
      changed_properties: [],
      is_fully_compatible: isBackward && isForward,
      is_backward_compatible: isBackward,
      is_forward_compatible: isForward,
      incompatibility_reasons: [],
      backward_errors: backwardErrors,
      forward_errors: forwardErrors,
    };
  }

  private inferDirection(fromId: string, toId: string): string {
    try {
      const fromGtsId = Gts.parseGtsID(fromId);
      const toGtsId = Gts.parseGtsID(toId);

      if (!fromGtsId.segments.length || !toGtsId.segments.length) {
        return 'unknown';
      }

      const fromSeg = fromGtsId.segments[fromGtsId.segments.length - 1];
      const toSeg = toGtsId.segments[toGtsId.segments.length - 1];

      if (fromSeg.verMinor !== undefined && toSeg.verMinor !== undefined) {
        if (toSeg.verMinor > fromSeg.verMinor) {
          return 'up';
        }
        if (toSeg.verMinor < fromSeg.verMinor) {
          return 'down';
        }
        return 'none';
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private checkBackwardCompatibility(
    oldSchema: any,
    newSchema: any
  ): { isBackward: boolean; backwardErrors: string[] } {
    return this.checkSchemaCompatibility(oldSchema, newSchema, true);
  }

  private checkForwardCompatibility(oldSchema: any, newSchema: any): { isForward: boolean; forwardErrors: string[] } {
    return this.checkSchemaCompatibility(oldSchema, newSchema, false);
  }

  private checkSchemaCompatibility(oldSchema: any, newSchema: any, checkBackward: boolean): any {
    const errors: string[] = [];

    // Flatten schemas to handle allOf
    const oldFlat = this.flattenSchema(oldSchema);
    const newFlat = this.flattenSchema(newSchema);

    const oldProps = oldFlat.properties || {};
    const newProps = newFlat.properties || {};
    const oldRequired = new Set(oldFlat.required || []);
    const newRequired = new Set(newFlat.required || []);

    // Check required properties changes
    if (checkBackward) {
      // Backward: cannot add required properties
      const newlyRequired = Array.from(newRequired).filter((p) => !oldRequired.has(p));
      if (newlyRequired.length > 0) {
        errors.push(`Added required properties: ${newlyRequired.join(', ')}`);
      }
    } else {
      // Forward: cannot remove required properties
      const removedRequired = Array.from(oldRequired).filter((p) => !newRequired.has(p));
      if (removedRequired.length > 0) {
        errors.push(`Removed required properties: ${removedRequired.join(', ')}`);
      }
    }

    // Check properties that exist in both schemas
    const commonProps = Object.keys(oldProps).filter((k) => k in newProps);
    for (const prop of commonProps) {
      const oldPropSchema = oldProps[prop] || {};
      const newPropSchema = newProps[prop] || {};

      // Check if type changed
      const oldType = oldPropSchema.type;
      const newType = newPropSchema.type;
      if (oldType && newType && oldType !== newType) {
        errors.push(`Property '${prop}' type changed from ${oldType} to ${newType}`);
      }

      // Check enum constraints
      const oldEnum = oldPropSchema.enum || [];
      const newEnum = newPropSchema.enum || [];
      if (oldEnum.length > 0 && newEnum.length > 0) {
        const oldEnumSet = new Set(oldEnum);
        const newEnumSet = new Set(newEnum);
        if (checkBackward) {
          // Backward: cannot add enum values
          const addedEnumValues = newEnum.filter((v: any) => !oldEnumSet.has(v));
          if (addedEnumValues.length > 0) {
            errors.push(`Property '${prop}' added enum values: ${addedEnumValues.join(', ')}`);
          }
        } else {
          // Forward: cannot remove enum values
          const removedEnumValues = oldEnum.filter((v: any) => !newEnumSet.has(v));
          if (removedEnumValues.length > 0) {
            errors.push(`Property '${prop}' removed enum values: ${removedEnumValues.join(', ')}`);
          }
        }
      }

      // Check constraint compatibility
      errors.push(...this.checkConstraintCompatibility(prop, oldPropSchema, newPropSchema, checkBackward));

      // Recursively check nested object properties
      if (oldType === 'object' && newType === 'object') {
        const nestedResult = this.checkSchemaCompatibility(oldPropSchema, newPropSchema, checkBackward);
        const nestedErrors = checkBackward ? nestedResult.backwardErrors : nestedResult.forwardErrors;
        if (nestedErrors) {
          errors.push(...nestedErrors.map((e: string) => `Property '${prop}': ${e}`));
        }
      }

      // Recursively check array item schemas
      if (oldType === 'array' && newType === 'array' && oldPropSchema.items && newPropSchema.items) {
        const itemsResult = this.checkSchemaCompatibility(oldPropSchema.items, newPropSchema.items, checkBackward);
        const itemsErrors = checkBackward ? itemsResult.backwardErrors : itemsResult.forwardErrors;
        if (itemsErrors) {
          errors.push(...itemsErrors.map((e: string) => `Property '${prop}' array items: ${e}`));
        }
      }
    }

    if (checkBackward) {
      return { isBackward: errors.length === 0, backwardErrors: errors };
    } else {
      return { isForward: errors.length === 0, forwardErrors: errors };
    }
  }

  private checkConstraintCompatibility(
    prop: string,
    oldPropSchema: any,
    newPropSchema: any,
    checkTightening: boolean
  ): string[] {
    const errors: string[] = [];
    const propType = oldPropSchema.type;

    // Numeric constraints
    if (propType === 'number' || propType === 'integer') {
      errors.push(
        ...this.checkMinMaxConstraint(prop, oldPropSchema, newPropSchema, 'minimum', 'maximum', checkTightening)
      );
    }

    // String constraints
    if (propType === 'string') {
      errors.push(
        ...this.checkMinMaxConstraint(prop, oldPropSchema, newPropSchema, 'minLength', 'maxLength', checkTightening)
      );
    }

    // Array constraints
    if (propType === 'array') {
      errors.push(
        ...this.checkMinMaxConstraint(prop, oldPropSchema, newPropSchema, 'minItems', 'maxItems', checkTightening)
      );
    }

    return errors;
  }

  private checkMinMaxConstraint(
    prop: string,
    oldSchema: any,
    newSchema: any,
    minKey: string,
    maxKey: string,
    checkTightening: boolean
  ): string[] {
    const errors: string[] = [];

    const oldMin = oldSchema[minKey];
    const newMin = newSchema[minKey];
    const oldMax = oldSchema[maxKey];
    const newMax = newSchema[maxKey];

    // Check minimum constraint
    if (checkTightening) {
      // Backward: cannot increase minimum (tighten)
      if (oldMin !== undefined && newMin !== undefined && newMin > oldMin) {
        errors.push(`Property '${prop}' ${minKey} increased from ${oldMin} to ${newMin}`);
      } else if (oldMin === undefined && newMin !== undefined) {
        errors.push(`Property '${prop}' added ${minKey} constraint: ${newMin}`);
      }
    } else {
      // Forward: cannot decrease minimum (relax)
      if (oldMin !== undefined && newMin !== undefined && newMin < oldMin) {
        errors.push(`Property '${prop}' ${minKey} decreased from ${oldMin} to ${newMin}`);
      } else if (oldMin !== undefined && newMin === undefined) {
        errors.push(`Property '${prop}' removed ${minKey} constraint`);
      }
    }

    // Check maximum constraint
    if (checkTightening) {
      // Backward: cannot decrease maximum (tighten)
      if (oldMax !== undefined && newMax !== undefined && newMax < oldMax) {
        errors.push(`Property '${prop}' ${maxKey} decreased from ${oldMax} to ${newMax}`);
      } else if (oldMax === undefined && newMax !== undefined) {
        errors.push(`Property '${prop}' added ${maxKey} constraint: ${newMax}`);
      }
    } else {
      // Forward: cannot increase maximum (relax)
      if (oldMax !== undefined && newMax !== undefined && newMax > oldMax) {
        errors.push(`Property '${prop}' ${maxKey} increased from ${oldMax} to ${newMax}`);
      } else if (oldMax !== undefined && newMax === undefined) {
        errors.push(`Property '${prop}' removed ${maxKey} constraint`);
      }
    }

    return errors;
  }

  private flattenSchema(schema: any): any {
    const result: any = {
      properties: {},
      required: [],
    };

    // Merge allOf schemas
    if (schema.allOf && Array.isArray(schema.allOf)) {
      for (const subSchema of schema.allOf) {
        const flattened = this.flattenSchema(subSchema);

        // Merge properties
        Object.assign(result.properties, flattened.properties || {});

        // Merge required
        if (flattened.required && Array.isArray(flattened.required)) {
          result.required.push(...flattened.required);
        }

        // Preserve additionalProperties
        if (flattened.additionalProperties !== undefined) {
          result.additionalProperties = flattened.additionalProperties;
        }
      }
    }

    // Add direct properties
    if (schema.properties) {
      Object.assign(result.properties, schema.properties);
    }

    // Add direct required
    if (schema.required && Array.isArray(schema.required)) {
      result.required.push(...schema.required);
    }

    // Top level additionalProperties overrides
    if (schema.additionalProperties !== undefined) {
      result.additionalProperties = schema.additionalProperties;
    }

    return result;
  }

  castInstance(instanceId: string, toSchemaId: string): any {
    try {
      // Get instance entity
      const instanceEntity = this.get(instanceId);
      if (!instanceEntity) {
        return {
          instance_id: instanceId,
          to_schema_id: toSchemaId,
          ok: false,
          error: `Entity not found: ${instanceId}`,
        };
      }

      // Get target schema
      const toSchema = this.get(toSchemaId);
      if (!toSchema) {
        return {
          instance_id: instanceId,
          to_schema_id: toSchemaId,
          ok: false,
          error: `Schema not found: ${toSchemaId}`,
        };
      }

      // Determine source schema
      let fromSchemaId: string;
      let fromSchema: any;
      if (instanceEntity.isSchema) {
        // Not allowed to cast directly from a schema
        return {
          instance_id: instanceId,
          to_schema_id: toSchemaId,
          ok: false,
          error: 'Source must be an instance, not a schema',
        };
      } else {
        // Casting an instance - need to find its schema
        fromSchemaId = instanceEntity.schemaId!;
        if (!fromSchemaId) {
          return {
            instance_id: instanceId,
            to_schema_id: toSchemaId,
            ok: false,
            error: `Schema not found for instance: ${instanceId}`,
          };
        }
        // Don't try to get a JSON Schema URL as a GTS entity
        if (fromSchemaId.startsWith('http://') || fromSchemaId.startsWith('https://')) {
          return {
            instance_id: instanceId,
            to_schema_id: toSchemaId,
            ok: false,
            error: `Cannot cast instance with schema ${fromSchemaId}`,
          };
        }
        fromSchema = this.get(fromSchemaId);
        if (!fromSchema) {
          return {
            instance_id: instanceId,
            to_schema_id: toSchemaId,
            ok: false,
            error: `Schema not found: ${fromSchemaId}`,
          };
        }
      }

      // Get content
      const instanceContent = instanceEntity.content;
      const fromSchemaContent = fromSchema.content;
      const toSchemaContent = toSchema.content;

      // Perform the cast
      return this.performCast(instanceId, toSchemaId, instanceContent, fromSchemaContent, toSchemaContent);
    } catch (error) {
      return {
        instance_id: instanceId,
        to_schema_id: toSchemaId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private performCast(
    fromInstanceId: string,
    toSchemaId: string,
    fromInstanceContent: any,
    fromSchemaContent: any,
    toSchemaContent: any
  ): any {
    // Flatten target schema to merge allOf
    const targetSchema = this.flattenSchema(toSchemaContent);

    // Determine direction
    const direction = this.inferDirection(fromInstanceId, toSchemaId);

    // Determine which is old/new based on direction
    let oldSchema: any;
    let newSchema: any;
    switch (direction) {
      case 'up':
        oldSchema = fromSchemaContent;
        newSchema = toSchemaContent;
        break;
      case 'down':
        oldSchema = toSchemaContent;
        newSchema = fromSchemaContent;
        break;
      default:
        oldSchema = fromSchemaContent;
        newSchema = toSchemaContent;
        break;
    }

    // Check compatibility
    const { isBackward, backwardErrors } = this.checkBackwardCompatibility(oldSchema, newSchema);
    const { isForward, forwardErrors } = this.checkForwardCompatibility(oldSchema, newSchema);

    // Apply casting rules to transform the instance
    const { casted, added, removed, incompatibilityReasons } = this.castInstanceToSchema(
      this.deepCopy(fromInstanceContent),
      targetSchema,
      ''
    );

    // Validate the casted instance against the target schema
    let isFullyCompatible = false;
    if (casted) {
      try {
        const modifiedSchema = this.removeGtsConstConstraints(toSchemaContent);
        const validate = this.ajv.compile(this.normalizeSchema(modifiedSchema));
        const isValid = validate(casted);
        if (!isValid) {
          const errors =
            validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ') || 'Validation failed';
          incompatibilityReasons.push(errors);
        } else {
          isFullyCompatible = true;
        }
      } catch (err) {
        incompatibilityReasons.push(err instanceof Error ? err.message : String(err));
      }
    }

    return {
      from: fromInstanceId,
      to: toSchemaId,
      old: fromInstanceId,
      new: toSchemaId,
      direction,
      added_properties: this.deduplicate(added),
      removed_properties: this.deduplicate(removed),
      changed_properties: [],
      is_fully_compatible: isFullyCompatible,
      is_backward_compatible: isBackward,
      is_forward_compatible: isForward,
      incompatibility_reasons: incompatibilityReasons,
      backward_errors: backwardErrors,
      forward_errors: forwardErrors,
      casted_entity: casted,
      instance_id: fromInstanceId,
      to_schema_id: toSchemaId,
      ok: isFullyCompatible,
      error: isFullyCompatible ? '' : incompatibilityReasons.join('; '),
    };
  }

  private castInstanceToSchema(
    instance: any,
    schema: any,
    basePath: string
  ): { casted: any; added: string[]; removed: string[]; incompatibilityReasons: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const incompatibilityReasons: string[] = [];

    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      incompatibilityReasons.push('Instance must be an object for casting');
      return { casted: null, added, removed, incompatibilityReasons };
    }

    const targetProps = schema.properties || {};
    const required = new Set<string>(schema.required || []);
    const additional = schema.additionalProperties !== false;

    // Start from current values
    const result = this.deepCopy(instance);

    // 1) Ensure required properties exist (fill defaults if provided)
    for (const reqProp of Array.from(required)) {
      if (!(reqProp in result)) {
        const propSchema = targetProps[reqProp as string];
        if (propSchema && propSchema.default !== undefined) {
          result[reqProp as string] = this.deepCopy(propSchema.default);
          const path = this.buildPath(basePath, reqProp as string);
          added.push(path);
        } else {
          const path = this.buildPath(basePath, reqProp as string);
          incompatibilityReasons.push(`Missing required property '${path}' and no default is defined`);
        }
      }
    }

    // 2) For optional properties with defaults, set if missing
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      if (required.has(prop)) {
        continue;
      }
      if (!(prop in result)) {
        const ps = propSchema as any;
        if (ps.default !== undefined) {
          result[prop] = this.deepCopy(ps.default);
          const path = this.buildPath(basePath, prop);
          added.push(path);
        }
      }
    }

    // 2.5) Update const values to match target schema (for GTS ID fields)
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      const ps = propSchema as any;
      if (ps.const !== undefined) {
        const constVal = ps.const;
        const existingVal = result[prop];
        if (typeof constVal === 'string' && typeof existingVal === 'string') {
          // Only update if both are GTS IDs and they differ
          if (Gts.isValidGtsID(constVal) && Gts.isValidGtsID(existingVal)) {
            if (existingVal !== constVal) {
              result[prop] = constVal;
            }
          }
        }
      }
    }

    // 3) Remove properties not in target schema when additionalProperties is false
    if (!additional) {
      for (const prop of Object.keys(result)) {
        if (!(prop in targetProps)) {
          delete result[prop];
          const path = this.buildPath(basePath, prop);
          removed.push(path);
        }
      }
    }

    // 4) Recurse into nested object properties
    for (const [prop, propSchema] of Object.entries(targetProps)) {
      const val = result[prop];
      if (val === undefined) {
        continue;
      }
      const ps = propSchema as any;
      const propType = ps.type;

      // Handle nested objects
      if (propType === 'object') {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nestedSchema = this.effectiveObjectSchema(ps);
          const nestedResult = this.castInstanceToSchema(val, nestedSchema, this.buildPath(basePath, prop));
          result[prop] = nestedResult.casted;
          added.push(...nestedResult.added);
          removed.push(...nestedResult.removed);
          incompatibilityReasons.push(...nestedResult.incompatibilityReasons);
        }
      }

      // Handle arrays of objects
      if (propType === 'array') {
        if (Array.isArray(val)) {
          const itemsSchema = ps.items;
          if (itemsSchema && itemsSchema.type === 'object') {
            const nestedSchema = this.effectiveObjectSchema(itemsSchema);
            const newList: any[] = [];
            for (let idx = 0; idx < val.length; idx++) {
              const item = val[idx];
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                const nestedResult = this.castInstanceToSchema(
                  item,
                  nestedSchema,
                  this.buildPath(basePath, `${prop}[${idx}]`)
                );
                newList.push(nestedResult.casted);
                added.push(...nestedResult.added);
                removed.push(...nestedResult.removed);
                incompatibilityReasons.push(...nestedResult.incompatibilityReasons);
              } else {
                newList.push(item);
              }
            }
            result[prop] = newList;
          }
        }
      }
    }

    return { casted: result, added, removed, incompatibilityReasons };
  }

  private effectiveObjectSchema(schema: any): any {
    if (!schema) {
      return {};
    }

    // If it has properties or required directly, use it
    if (schema.properties || schema.required) {
      return schema;
    }

    // Check allOf for object schemas
    if (schema.allOf && Array.isArray(schema.allOf)) {
      for (const part of schema.allOf) {
        if (part.properties || part.required) {
          return part;
        }
      }
    }

    return schema;
  }

  private removeGtsConstConstraints(schema: any): any {
    if (schema === null || schema === undefined) {
      return schema;
    }

    if (typeof schema === 'object' && !Array.isArray(schema)) {
      const result: any = {};
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'const') {
          if (typeof value === 'string' && Gts.isValidGtsID(value)) {
            // Replace const with type constraint instead
            result.type = 'string';
            continue;
          }
        }
        result[key] = this.removeGtsConstConstraints(value);
      }
      return result;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.removeGtsConstConstraints(item));
    }

    return schema;
  }

  private buildPath(base: string, prop: string): string {
    if (!base) {
      return prop;
    }
    // Handle array indices that already have brackets
    if (prop.startsWith('[')) {
      return base + prop;
    }
    return base + '.' + prop;
  }

  private deepCopy(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    if (typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepCopy(item));
    }
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.deepCopy(value);
    }
    return result;
  }

  private deduplicate(arr: string[]): string[] {
    const unique = Array.from(new Set(arr));
    return unique.sort();
  }

  getAttribute(gtsId: string, path: string): any {
    const entity = this.get(gtsId);
    if (!entity) {
      return {
        gts_id: gtsId,
        path,
        resolved: false,
        error: `Entity not found: ${gtsId}`,
      };
    }

    const value = this.getNestedValue(entity.content, path);

    return {
      gts_id: gtsId,
      path,
      resolved: value !== undefined,
      value,
    };
  }

  private getNestedValue(obj: any, path: string): any {
    // Split path by dots but handle array notation
    const parts: string[] = [];
    let current = '';
    let inBracket = false;

    for (let i = 0; i < path.length; i++) {
      const char = path[i];
      if (char === '[') {
        if (current) {
          parts.push(current);
          current = '';
        }
        inBracket = true;
      } else if (char === ']') {
        if (current) {
          parts.push(`[${current}]`);
          current = '';
        }
        inBracket = false;
      } else if (char === '.' && !inBracket) {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      parts.push(current);
    }

    let result = obj;
    for (const part of parts) {
      if (result === null || result === undefined) {
        return undefined;
      }

      // Handle array index notation
      if (part.startsWith('[') && part.endsWith(']')) {
        const index = parseInt(part.slice(1, -1), 10);
        if (Array.isArray(result) && !isNaN(index)) {
          result = result[index];
        } else {
          return undefined;
        }
      } else {
        // Regular property access
        if (typeof result === 'object' && part in result) {
          result = result[part];
        } else {
          return undefined;
        }
      }
    }

    return result;
  }
}

export function createJsonEntity(content: any, _config?: Partial<GtsConfig>): JsonEntity {
  const extractResult = GtsExtractor.extractID(content);

  const references = new Set<string>();
  findReferences(content, references);

  return {
    id: extractResult.id,
    schemaId: extractResult.schema_id,
    content,
    isSchema: extractResult.is_schema,
    references,
  };
}

function findReferences(obj: any, refs: Set<string>, visited = new Set()): void {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) {
    return;
  }

  visited.add(obj);

  if ('$ref' in obj && typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    const normalized = ref.startsWith(GTS_URI_PREFIX) ? ref.substring(GTS_URI_PREFIX.length) : ref;
    if (Gts.isValidGtsID(normalized)) {
      refs.add(normalized);
    }
  }

  if ('x-gts-ref' in obj && typeof obj['x-gts-ref'] === 'string') {
    const ref = obj['x-gts-ref'];
    if (Gts.isValidGtsID(ref)) {
      refs.add(ref);
    }
  }

  for (const value of Object.values(obj)) {
    findReferences(value, refs, visited);
  }
}
