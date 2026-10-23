import { createHash as nodeCreateHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shim = require('./sha256-shim.js') as { createHash: (algorithm: string) => any };

const samples: Array<[string, string]> = [
  ['empty string', ''],
  ['abc', 'abc'],
  ['multi-block string', 'The quick brown fox jumps over the lazy dog. '.repeat(30)],
  ['non-ASCII text', 'Привет, мир! é中文 🚀'],
];

describe('sha256 shim', () => {
  test.each(samples)('matches node crypto for %s', (_name, text) => {
    expect(shim.createHash('sha256').update(text).digest('hex')).toBe(
      nodeCreateHash('sha256').update(text).digest('hex')
    );
  });

  test('supports chunked updates and Uint8Array input', () => {
    const bytes = new TextEncoder().encode('chunked input');
    expect(shim.createHash('sha256').update('chunked ').update(bytes.slice(8)).digest('hex')).toBe(
      nodeCreateHash('sha256').update('chunked input').digest('hex')
    );
  });

  test('rejects other algorithms', () => {
    expect(() => shim.createHash('md5')).toThrow();
  });
});
