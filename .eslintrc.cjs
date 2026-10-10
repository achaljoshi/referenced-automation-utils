module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // Playwright fixtures are destructured as `({}, use) => ...` when a
    // fixture doesn't depend on any other fixture - this is the documented
    // pattern, not a mistake.
    'no-empty-pattern': 'off',
    // A missing `await` turns an assertion into something that cannot fail, and a Promise handed to a callback that
    // ignores it loses the error. Both need type information, hence `parserOptions.project` above.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    // ADR 0005: no hard waits and no `networkidle`. Wait for the condition the test needs (a web-first assertion,
    // locator.waitFor, expect.poll) - a fixed sleep is slow when it is long enough and flaky when it is not.
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.property.name='waitForTimeout']",
        message: 'No hard waits (ADR 0005): wait for a condition - expect(locator), locator.waitFor() or expect.poll().',
      },
      {
        selector: "Literal[value='networkidle']",
        message: "No 'networkidle' (ADR 0005): it is discouraged by Playwright and flaky - wait for the element or response the test needs.",
      },
    ],
  },
};
