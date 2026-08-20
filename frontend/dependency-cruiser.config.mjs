/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'Cycles make module initialization and refactoring unpredictable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable-imports',
      severity: 'error',
      comment: 'Every import must resolve to a module on disk.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-packages',
      severity: 'error',
      comment: 'Runtime and tooling dependencies must be declared in package.json.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'production-does-not-import-tests',
      severity: 'error',
      comment: 'Test modules are consumers, never production dependencies.',
      from: { pathNot: '[.](?:spec|test)[.](?:ts|tsx)$' },
      to: { path: '[.](?:spec|test)[.](?:ts|tsx)$' },
    },
    {
      name: 'components-do-not-import-app-shell',
      severity: 'error',
      comment: 'Reusable components must not depend on the application entry point or shell.',
      from: { path: '^src/components/' },
      to: { path: '^src/(?:main|App)[.](?:ts|tsx)$' },
    },
    {
      name: 'core-does-not-import-ui',
      severity: 'error',
      comment: 'API, defaults, import logic, and surge math stay independent from React UI modules.',
      from: { path: '^src/(?:api|defaults|importers|surge)[.]ts$' },
      to: { path: '^src/(?:components/|main[.]tsx$|App[.]tsx$)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(?:dist|coverage|node_modules)/' },
    tsConfig: { fileName: 'tsconfig.app.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'browser', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    },
    skipAnalysisNotInRules: true,
  },
}
