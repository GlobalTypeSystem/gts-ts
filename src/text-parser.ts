import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { LineCounter, parseDocument } from 'yaml';
import { createJsonEntity } from './store';
import { GtsTextFormat, GtsTextParseResult, ValidationIssue } from './types';
import { sourceSpanAt } from './source-location';

export class GtsTextParseError extends Error {
  constructor(
    message: string,
    public errors: ValidationIssue[]
  ) {
    super(message);
    this.name = 'GtsTextParseError';
  }
}

function jsoncParseIssue(text: string, error: ParseError): ValidationIssue {
  const message = printParseErrorCode(error.error);
  return {
    instancePath: '/',
    schemaPath: '#',
    keyword: 'parse',
    message,
    params: { error: error.error },
    source: { value: sourceSpanAt(text, error.offset, error.length) },
  };
}

export function parseJSONC(text: string): unknown {
  const errors: ParseError[] = [];
  const content = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: false });
  if (errors.length > 0) {
    const issues = errors.map((error) => jsoncParseIssue(text, error));
    throw new GtsTextParseError(`JSONC parse error: ${issues.map((issue) => issue.message).join(', ')}`, issues);
  }
  return content;
}

export function tryParseJSONC(text: string): unknown | null {
  try {
    return parseJSONC(text);
  } catch {
    return null;
  }
}

export function parseYAML(text: string): unknown {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    const issues = document.errors.map((error) => {
      const offset = error.pos[0];
      const length = Math.max(1, error.pos[1] - offset);
      const issue: ValidationIssue = {
        instancePath: '/',
        schemaPath: '#',
        keyword: 'parse',
        message: error.message,
        params: { code: error.code },
        source: { value: sourceSpanAt(text, offset, length) },
      };
      return issue;
    });
    throw new GtsTextParseError(`YAML parse error: ${issues.map((issue) => issue.message).join(', ')}`, issues);
  }
  return document.toJS();
}

export function tryParseYAML(text: string): unknown | null {
  try {
    return parseYAML(text);
  } catch {
    return null;
  }
}

export function parseGtsTextContent(text: string, format: GtsTextFormat = 'jsonc'): unknown {
  return format === 'yaml' ? parseYAML(text) : parseJSONC(text);
}

export function parseGtsText(text: string, format: GtsTextFormat = 'jsonc'): GtsTextParseResult {
  try {
    const content = parseGtsTextContent(text, format);
    const values = Array.isArray(content) ? content : [content];
    return {
      ok: true,
      content,
      entities: values.map((value) => createJsonEntity(value)),
    };
  } catch (error) {
    return {
      ok: false,
      entities: [],
      error: error instanceof Error ? error.message : String(error),
      errors: error instanceof GtsTextParseError ? error.errors : undefined,
    };
  }
}
