// Runs only inside tests/csp/no-codegen-environment.js (which sets the marker).
// Proves the environment really forbids code generation from strings.
const active = (globalThis as { __GTS_NO_CODEGEN__?: boolean }).__GTS_NO_CODEGEN__ === true;

(active ? describe : describe.skip)('no-codegen environment canary', () => {
  test('new Function throws', () => {
    expect(() => new Function('return 1')).toThrow();
  });

  test('direct eval throws', () => {
    // eslint-disable-next-line no-eval
    expect(() => eval('1')).toThrow();
  });

  test('indirect eval throws', () => {
    expect(() => (0, eval)('1')).toThrow();
  });
});
