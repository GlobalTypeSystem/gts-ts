import { findNodeAtLocation, Node as JsonNode, parseTree } from 'jsonc-parser';
import { isMap, isSeq, LineCounter, Node as YamlNode, parseDocument } from 'yaml';
import { GtsTextFormat, SourceSpan, ValidationIssue, ValidationIssueSource } from './types';

function positionAt(text: string, offset: number): Omit<SourceSpan, 'length'> {
  const boundedOffset = Math.max(0, Math.min(offset, text.length));
  const lineOffset = text.lastIndexOf('\n', Math.max(0, boundedOffset - 1)) + 1;
  let line = 0;
  for (let index = 0; index < lineOffset; index++) {
    if (text.charCodeAt(index) === 10) line++;
  }
  return { offset: boundedOffset, line, column: boundedOffset - lineOffset, lineOffset };
}

export function sourceSpanAt(text: string, offset: number, length: number): SourceSpan {
  return { ...positionAt(text, offset), length: Math.max(0, length) };
}

function pointerParts(instancePath: string): Array<string | number> {
  if (!instancePath || instancePath === '/') return [];
  return instancePath
    .replace(/^\//, '')
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part));
}

function issuePath(issue: ValidationIssue): Array<string | number> {
  const parts = pointerParts(issue.instancePath);
  if (issue.keyword === 'additionalProperties' && typeof issue.params.additionalProperty === 'string') {
    parts.push(issue.params.additionalProperty);
  }
  return parts;
}

function jsonNodeSource(text: string, node: JsonNode): ValidationIssueSource {
  const property = node.parent?.type === 'property' ? node.parent : undefined;
  const keyNode = property?.children?.[0];
  return {
    value: sourceSpanAt(text, node.offset, node.length),
    key: keyNode ? sourceSpanAt(text, keyNode.offset, keyNode.length) : undefined,
  };
}

function jsonSource(
  text: string,
  root: JsonNode,
  entityIndex: number,
  path: Array<string | number>
): ValidationIssueSource | undefined {
  const fullPath = root.type === 'array' ? [entityIndex, ...path] : path;
  const node =
    findNodeAtLocation(root, fullPath) || findNodeAtLocation(root, root.type === 'array' ? [entityIndex] : []);
  return node ? jsonNodeSource(text, node) : undefined;
}

interface YamlLocatedNode {
  value: YamlNode;
  key?: YamlNode;
}

function yamlLocatedNode(root: YamlNode, path: Array<string | number>): YamlLocatedNode | undefined {
  let current: YamlNode | null = root;
  let key: YamlNode | undefined;
  for (const part of path) {
    if (isMap(current)) {
      const pair = current.items.find((item) => String(item.key) === String(part));
      if (!pair?.value) return undefined;
      key = pair.key as YamlNode;
      current = pair.value as YamlNode;
    } else if (isSeq(current) && typeof part === 'number') {
      const item = current.items[part];
      if (!item) return undefined;
      key = undefined;
      current = item as YamlNode;
    } else {
      return undefined;
    }
  }
  return current ? { value: current, key } : undefined;
}

function yamlSpan(lineCounter: LineCounter, node: YamlNode): SourceSpan | undefined {
  if (!node.range) return undefined;
  const offset = node.range[0];
  const position = lineCounter.linePos(offset);
  return {
    offset,
    length: node.range[1] - offset,
    line: position.line - 1,
    column: position.col - 1,
    lineOffset: offset - (position.col - 1),
  };
}

function yamlSource(
  root: YamlNode,
  lineCounter: LineCounter,
  entityIndex: number,
  path: Array<string | number>
): ValidationIssueSource | undefined {
  const fullPath = isSeq(root) ? [entityIndex, ...path] : path;
  const located = yamlLocatedNode(root, fullPath) || yamlLocatedNode(root, isSeq(root) ? [entityIndex] : []);
  if (!located) return undefined;
  const value = yamlSpan(lineCounter, located.value);
  if (!value) return undefined;
  const key = located.key ? yamlSpan(lineCounter, located.key) : undefined;
  return { value, key };
}

/**
 * Parses the document once and resolves in-text spans for many issues/entities.
 * Reuse a single instance across all entities of a document to avoid re-parsing
 * the whole text per entity.
 */
export class SourceLocator {
  private jsonRoot?: JsonNode;
  private yamlRoot?: YamlNode;
  private lineCounter?: LineCounter;

  constructor(
    format: GtsTextFormat,
    private text: string
  ) {
    if (format === 'yaml') {
      this.lineCounter = new LineCounter();
      const document = parseDocument(text, { lineCounter: this.lineCounter, prettyErrors: false });
      this.yamlRoot = document.contents as YamlNode | undefined;
    } else {
      this.jsonRoot = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: false });
    }
  }

  locate(entityIndex: number, issue: ValidationIssue): ValidationIssueSource | undefined {
    const path = issuePath(issue);
    if (this.yamlRoot && this.lineCounter) {
      return yamlSource(this.yamlRoot, this.lineCounter, entityIndex, path);
    }
    return this.jsonRoot ? jsonSource(this.text, this.jsonRoot, entityIndex, path) : undefined;
  }

  attach(entityIndex: number, issues: ValidationIssue[]): ValidationIssue[] {
    return issues.map((issue) => ({ ...issue, entityIndex, source: this.locate(entityIndex, issue) }));
  }
}

export function attachSourceLocations(
  format: GtsTextFormat,
  text: string,
  entityIndex: number,
  issues: ValidationIssue[]
): ValidationIssue[] {
  return new SourceLocator(format, text).attach(entityIndex, issues);
}
