'use strict';
// Jest environment whose vm context forbids code generation from strings and wasm.
// Jest itself cannot run under `--disallow-code-generation-from-strings` (its startup
// calls `new Function`), so the restriction is applied to the test context only.
// Negative control: GTS_CSP_ENV_UNRESTRICTED=1 keeps the marker but skips the restriction.

const vm = require('vm');
const { TestEnvironment } = require('jest-environment-node');

const unrestricted = process.env.GTS_CSP_ENV_UNRESTRICTED === '1';
const originalCreateContext = vm.createContext;

class NoCodegenEnvironment extends TestEnvironment {
  constructor(config, context) {
    if (unrestricted) {
      super(config, context);
    } else {
      // jest-environment-node creates its context with a bare `vm.createContext()`;
      // intercept exactly that one call while the base constructor runs.
      vm.createContext = (contextObject, options) => {
        vm.createContext = originalCreateContext;
        return originalCreateContext(contextObject, {
          ...options,
          codeGeneration: { strings: false, wasm: false },
        });
      };
      try {
        super(config, context);
      } finally {
        vm.createContext = originalCreateContext;
      }
    }
    this.global.__GTS_NO_CODEGEN__ = true;
  }
}

module.exports = NoCodegenEnvironment;
