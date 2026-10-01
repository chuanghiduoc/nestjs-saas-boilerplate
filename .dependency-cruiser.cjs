/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'features-only-public-api',
      severity: 'error',
      from: { path: '(^|/)src/features/' },
      to: { path: '(^|/)src/(modules|core)/[^/]+/(?!index\\.ts$)' },
    },
    {
      name: 'modules-only-index-of-other-modules',
      severity: 'error',
      from: { path: '(^|/)src/modules/([^/]+)/' },
      to: {
        path: '(^|/)src/modules/([^/]+)/(?!index\\.ts$)',
        // A module may use its own internals; $2 is the module name captured by from.path.
        pathNot: '(^|/)src/modules/$2/',
      },
    },
    {
      name: 'core-independent',
      severity: 'error',
      from: { path: '(^|/)src/core/' },
      to: { path: '(^|/)src/(modules|features)/' },
    },
    // R7: generated production migrations and test fixtures legitimately import MikroORM.
    {
      name: 'orm-only-in-infra',
      severity: 'error',
      from: {
        pathNot:
          '(^|/)src/(core/database/|.+/infra/|migrations/)|(^|/)test/fixtures/',
      },
      to: { path: 'node_modules/@mikro-orm/' },
    },
    {
      name: 'bullmq-only-in-core-queue',
      severity: 'error',
      // Queue owns the BullMQ adapter and its instrumentation.
      from: { pathNot: '(^|/)src/core/queue/' },
      to: { path: 'node_modules/(bullmq|bullmq-otel|@nestjs/bullmq)/' },
    },
    // Express resolves to @types/express with pnpm; enforce the same boundary for its types.
    {
      name: 'http-platform-only-in-core-http',
      severity: 'error',
      // Bull Board mount trên express() riêng trong worker (SP2 luật 13).
      from: { pathNot: '(^|/)src/core/(http|queue/dashboard)/' },
      to: {
        path: 'node_modules/(express|@types/express|fastify|@nestjs/platform-express|@nestjs/platform-fastify)/',
      },
    },
    {
      name: 'domain-pure',
      severity: 'error',
      from: { path: '(^|/)src/.+/domain/' },
      to: {
        path: '((^|/)src/.+/(infra|http)/|node_modules/(@mikro-orm|bullmq|express|ioredis)/)',
      },
    },

    {
      name: 'http-libs-only-in-core-http',
      severity: 'error',
      // HTTP owns throttling, idempotency storage adapters and JSON Merge Patch (applyMergePatch).
      from: { pathNot: '(^|/)src/core/http/' },
      to: {
        path: 'node_modules/(@nestjs/throttler|@node-idempotency|tiny-merge-patch)/',
      },
    },
    {
      name: 'outbound-libs-only-in-core-resilience',
      severity: 'error',
      // Resilience owns outbound transport, address validation and circuit breaking.
      from: { pathNot: '(^|/)src/core/resilience/' },
      to: { path: 'node_modules/(undici|ipaddr\\.js|cockatiel)/' },
    },
    {
      name: 'redis-client-only-in-core-redis-or-http',
      severity: 'error',
      // core/redis owns the shared client; core/http needs the ioredis type for rate-limit and idempotency storage.
      from: { pathNot: '(^|/)src/core/(redis|http)/' },
      to: { path: 'node_modules/ioredis/' },
    },
    {
      name: 'http-docs-libs-only-in-core-http',
      severity: 'error',
      // HTTP owns security headers and API documentation integrations.
      from: { pathNot: '(^|/)src/core/http/' },
      to: {
        path: 'node_modules/(helmet|@nestjs/swagger|@scalar/nestjs-api-reference)/',
      },
    },

    {
      name: 'auth-libs-only-in-identity-better-auth',
      severity: 'error',
      comment:
        'SP2 rule 10: Better Auth, its adapters, the Nest integration and Kysely stay behind the AuthProvider port.',
      from: { pathNot: '(^|/)src/modules/identity/infra/better-auth/' },
      to: { path: 'node_modules/(better-auth|@better-auth|kysely)/' },
    },
    {
      name: 'pg-only-in-identity-better-auth-or-core-database',
      severity: 'error',
      comment:
        'SP2 rule 10: raw pg pools exist only for the auth_user pool and core/database.',
      from: {
        pathNot: '(^|/)src/(modules/identity/infra/better-auth|core/database)/',
      },
      to: { path: 'node_modules/pg/' },
    },
    {
      name: 'jose-only-in-identity-jwks',
      severity: 'error',
      comment:
        'SP2 rule 11: token verification for AUTH_MODE=external lives in one adapter.',
      from: { pathNot: '(^|/)src/modules/identity/infra/jwks/' },
      to: { path: 'node_modules/jose/' },
    },
    {
      name: 'mail-libs-only-in-notifications-infra',
      severity: 'error',
      comment:
        'SP2 rule 12: SMTP transport and template engines stay in notifications infra.',
      from: { pathNot: '(^|/)src/modules/notifications/infra/' },
      to: { path: 'node_modules/(nodemailer|mjml|handlebars)/' },
    },
    {
      name: 'bull-board-only-in-core-queue-dashboard',
      severity: 'error',
      comment: 'SP2 rule 13: the queue dashboard is the only Bull Board user.',
      from: { pathNot: '(^|/)src/core/queue/dashboard/' },
      to: { path: 'node_modules/@bull-board/' },
    },
    {
      name: 'rate-limiter-only-in-core-http-or-identity-better-auth',
      severity: 'error',
      comment:
        'SP1 rule 9 + SP2 rule 14: RateLimiterPostgres backs the account lockout of identity.',
      from: {
        pathNot: '(^|/)src/(core/http|modules/identity/infra/better-auth)/',
      },
      to: { path: 'node_modules/rate-limiter-flexible/' },
    },
    {
      name: 'openfeature-only-in-core-flags',
      severity: 'error',
      comment:
        'SP6 rule 22: OpenFeature stays behind core/flags (KillSwitches); modules ask KillSwitches.isKilled, never the SDK.',
      from: { pathNot: '(^|/)src/core/flags/' },
      to: { path: 'node_modules/@openfeature/' },
    },
    {
      name: 'foundation-modules-independent-of-sp6',
      severity: 'error',
      comment:
        'SP6 rule 23: identity, tenancy and notifications never import files, audit, integrations or admin (they talk through events and ports).',
      from: { path: '(^|/)src/modules/(identity|tenancy|notifications)/' },
      to: { path: '(^|/)src/modules/(files|audit|integrations|admin)/' },
    },
    {
      name: 'core-contracts-types-only',
      severity: 'error',
      comment:
        'SP6 rule 27 (R-X16): src/core/contracts holds only types and abstract classes; a runtime import would drag code into every consumer.',
      from: { path: '(^|/)src/core/contracts/' },
      to: { dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'notifications-independent-of-identity',
      severity: 'error',
      comment: 'SP2 rule 15: identity calls notifications, never the reverse.',
      from: { path: '(^|/)src/modules/notifications/' },
      to: { path: '(^|/)src/modules/identity/' },
    },
    {
      name: 'http-no-database-barrel',
      severity: 'error',
      comment:
        'N6: core/http may depend on narrow core/database leaf modules directly (e.g. db-errors.ts, ' +
        'db-infra-error.ts for the idempotency release classifier) but never the barrel/module wiring — the barrel ' +
        're-exports database.module.ts, which (like pool-deadline.ts) imports core/http/http.config.ts for the ' +
        'query deadline, so importing the barrel from core/http makes every core/http consumer register and ' +
        'validate databaseConfig too, and is one file-level import away from a real no-circular violation.',
      from: { path: '(^|/)src/core/http/' },
      to: { path: '(^|/)src/core/database/index\\.ts$' },
    },
    {
      name: 'casl-only-in-tenancy-authz-or-http',
      severity: 'error',
      comment:
        'SP3 rule 17: CASL builds abilities in tenancy application/authz and is checked in tenancy http only.',
      from: { pathNot: '(^|/)src/modules/tenancy/(application/authz|http)/' },
      to: { path: 'node_modules/@casl/' },
    },
    {
      name: 'identity-notifications-independent-of-tenancy',
      severity: 'error',
      comment:
        'SP3 rule 18: tenancy plugs into identity/notifications through their ports, never the reverse.',
      from: { path: '(^|/)src/modules/(identity|notifications)/' },
      to: { path: '(^|/)src/modules/tenancy/' },
    },
    {
      name: 'tenancy-test-hooks-only-in-tenancy',
      severity: 'error',
      comment:
        'SP3 rule 19: the race-test seam is never injected outside modules/tenancy (features use index.ts only).',
      from: { pathNot: '(^|/)src/modules/tenancy/' },
      to: { path: '(^|/)src/modules/tenancy/ports/tenancy-test-hooks\\.ts$' },
    },
    {
      name: 'platform-modules-independent-of-entitlements',
      severity: 'error',
      comment:
        'SP4 rule 20.8-a: tenancy, identity, notifications and files expose ports that entitlements plugs into, never the reverse.',
      from: {
        path: '(^|/)src/modules/(tenancy|identity|notifications|files)/',
      },
      to: { path: '(^|/)src/modules/entitlements/' },
    },
    {
      name: 'plan-catalogues-only-public-api',
      severity: 'error',
      comment:
        'SP4 rule 20.8-c: the plan catalogue (app.plans.ts, template plans.example.ts) imports only the entitlements index and feature indexes.',
      from: { path: '(^|/)src/(app[.]plans|plans[.]example)[.]ts$' },
      to: {
        path: '(^|/)src/',
        pathNot:
          '(^|/)src/(modules/entitlements/index|features/[^/]+/index)[.]ts$',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'This dependency is part of a circular relationship. You might want to revise ' +
        'your solution (i.e. use dependency inversion, make sure the modules have a single responsibility) ',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-orphans',
      comment:
        "This is an orphan module - it's likely not used (anymore?). Either use it or " +
        "remove it. If it's logical this module is an orphan (i.e. it's a config file), " +
        'add an exception for it in your dependency-cruiser configuration. By default ' +
        'this rule does not scrutinize dot-files (e.g. .eslintrc.js), TypeScript declaration ' +
        'files (.d.ts), tsconfig.json and some of the babel and webpack configs.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)src/modules/identity/infra/better-auth/auth[.]cli-config[.]ts$', // SP2 rule 16: loaded only by the auth CLI
          // SP6 plan 6.0: token hợp đồng cho admin (FileUsageReader, WebhookStatsReader), chưa module nào của src cài/inject
          // cho tới 6A/6C; plan đầu tiên import nó (6A hoặc 6C) xoá ngoại lệ này.
          '(^|/)src/core/contracts/admin-readers[.]ts$',
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$', // dot files
          '[.]d[.]ts$', // TypeScript declaration files
          '(^|/)tsconfig[.]json$', // TypeScript config
          '(^|/)(?:babel|webpack)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$', // other configs
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      comment:
        'A module depends on a node core module that has been deprecated. Find an alternative - these are ' +
        "bound to exist - node doesn't deprecate lightly.",
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: [
          '^v8/tools/codemap$',
          '^v8/tools/consarray$',
          '^v8/tools/csvparser$',
          '^v8/tools/logreader$',
          '^v8/tools/profile_view$',
          '^v8/tools/profile$',
          '^v8/tools/SourceMap$',
          '^v8/tools/splaytree$',
          '^v8/tools/tickprocessor-driver$',
          '^v8/tools/tickprocessor$',
          '^node-inspect/lib/_inspect$',
          '^node-inspect/lib/internal/inspect_client$',
          '^node-inspect/lib/internal/inspect_repl$',
          '^punycode$',
          '^domain$',
          '^constants$',
          '^sys$',
          '^_linklist$',
          '^_stream_wrap$',
        ],
      },
    },
    {
      // S2-R65 review M6/N2: `async_hooks` split out of `no-deprecated-core` so the exemption covers ONLY this module.
      // Its low-level hooks API (createHook, executionAsyncId) is discouraged, but AsyncLocalStorage is Stable. The
      // per-request auth scopes and the N4 idempotency owner context below import only AsyncLocalStorage from
      // `node:async_hooks` (the one way the code gets ALS); every other file still gets the warning.
      name: 'no-deprecated-core-async-hooks',
      comment:
        'async_hooks is a deprecated core module apart from AsyncLocalStorage; only the listed AsyncLocalStorage users are exempt.',
      severity: 'warn',
      from: {
        pathNot: [
          '^src/modules/identity/infra/better-auth/auth-db-failures[.]ts$',
          '^src/modules/identity/infra/better-auth/auth-error-capture[.]ts$',
          '^src/core/http/idempotency[.]storage[.]ts$',
        ],
      },
      to: {
        dependencyTypes: ['core'],
        path: ['^async_hooks$'],
      },
    },
    {
      name: 'not-to-deprecated',
      comment:
        'This module uses a (version of an) npm module that has been deprecated. Either upgrade to a later ' +
        'version of that module, or find an alternative. Deprecated modules are a security risk.',
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['deprecated'],
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment:
        "This module depends on an npm package that isn't in the 'dependencies' section of your package.json. " +
        "That's problematic as the package either (1) won't be available on live (2 - worse) will be " +
        'available on live with an non-guaranteed version. Fix it by adding the package to the dependencies ' +
        'in your package.json.',
      from: {},
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
      },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "This module depends on a module that cannot be found ('resolved to disk'). If it's an npm " +
        'module: add it to your package.json. In all other cases you likely already know what to do.',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'no-duplicate-dep-types',
      comment:
        "Likely this module depends on an external ('npm') package that occurs more than once " +
        'in your package.json i.e. bot as a devDependencies and in dependencies. This will cause ' +
        'maintenance problems later on.',
      severity: 'warn',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        // as it's common to use a devDependency for type-only imports: don't
        // consider type-only dependencyTypes for this rule
        dependencyTypesNot: ['type-only'],
      },
    },

    // rules you might want to tweak for your specific situation:
    {
      name: 'not-to-test',
      comment:
        "This module depends on code within a folder that should only contain tests. As tests don't " +
        "implement functionality this is odd. Either you're writing a test outside the test folder " +
        "or there's something in the test folder that isn't a test.",
      severity: 'error',
      from: {
        pathNot: '^(test)',
      },
      to: {
        path: '^(test)',
      },
    },
    {
      name: 'not-to-spec',
      comment:
        'This module depends on a spec (test) file. The responsibility of a spec file is to test code. ' +
        "If there's something in a spec that's of use to other modules, it doesn't have that single " +
        'responsibility anymore. Factor it out into (e.g.) a separate utility/ helper or a mock.',
      severity: 'error',
      from: {},
      to: {
        path: '[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$',
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        "This module depends on an npm package from the 'devDependencies' section of your " +
        'package.json. It looks like something that ships to production, though. To prevent problems ' +
        "with npm packages that aren't there on production declare it (only!) in the 'dependencies'" +
        'section of your package.json. If this module is development only - add it to the ' +
        'from.pathNot re of the not-to-dev-dep rule in the dependency-cruiser configuration',
      from: {
        path: '^(src)',
        pathNot: '[.](?:spec|test)[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$',
      },
      to: {
        dependencyTypes: ['npm-dev'],
        // type only dependencies are not a problem as they don't end up in the
        // production code or are ignored by the runtime.
        dependencyTypesNot: ['type-only'],
        pathNot: ['node_modules/@types/'],
      },
    },
    {
      name: 'optional-deps-used',
      severity: 'info',
      comment:
        'This module depends on an npm package that is declared as an optional dependency ' +
        "in your package.json. As this makes sense in limited situations only, it's flagged here. " +
        'If you use an optional dependency here by design - add an exception to your' +
        'dependency-cruiser configuration.',
      from: {},
      to: {
        dependencyTypes: ['npm-optional'],
      },
    },
    {
      name: 'peer-deps-used',
      comment:
        'This module depends on an npm package that is declared as a peer dependency ' +
        'in your package.json. This makes sense if your package is e.g. a plugin, but in ' +
        'other cases - maybe not so much. If the use of a peer dependency is intentional ' +
        'add an exception to your dependency-cruiser configuration.',
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['npm-peer'],
      },
    },
  ],
  options: {
    // Which modules not to follow further when encountered
    doNotFollow: {
      // path: an array of regular expressions in strings to match against
      path: ['node_modules'],
    },

    // Which modules to exclude
    // exclude : {
    //   // path: an array of regular expressions in strings to match against
    //   path: '',
    // },

    // Which modules to exclusively include (array of regular expressions in strings)
    // dependency-cruiser will skip everything that doesn't match this pattern
    // includeOnly : [''],

    // List of module systems to cruise.
    // When left out dependency-cruiser will fall back to the list of _all_
    // module systems it knows of ('amd', 'cjs', 'es6', 'tsd']). It's the
    // default because it's the safe option. It comes at a performance penalty, though
    // As in practice only commonjs ('cjs') and ecmascript modules ('es6')
    // are in wide use, you can limit the moduleSystems to those.
    // moduleSystems: ['cjs', 'es6'],

    // false: don't look at JSDoc imports (the default)
    // true: detect dependencies in JSDoc-style import statements.
    // Implies parser: 'tsc', which a.o. means the typescript compiler will need
    // to be installed in the same spot you run dependency-cruiser from.
    // detectJSDocImports: true,

    // false: don't look at process.getBuiltinModule calls (the default)
    // true: dependency-cruiser will detect calls to process.getBuiltinModule/
    // globalThis.process.getBuiltinModule as imports.
    detectProcessBuiltinModuleCalls: true,

    // prefix for links in html, d2, mermaid and dot/ svg output (e.g. 'https://github.com/you/yourrepo/blob/main/'
    // to open it on your online repo or `vscode://file/${process.cwd()}/` to
    // open it in visual studio code),
    // prefix: `vscode://file/${process.cwd()}/`,

    // suffix for links in output. E.g. put .html here if you use it to link to
    // your coverage reports.
    // suffix: '.html',

    // false (the default): ignore dependencies that only exist before typescript-to-javascript compilation
    // true: also detect dependencies that only exist before typescript-to-javascript compilation
    // 'specify': for each dependency identify whether it only exists before compilation or also after
    tsPreCompilationDeps: true,

    // list of extensions to scan that aren't javascript or compile-to-javascript.
    // Empty by default. Only put extensions in here that you want to take into
    // account that are _not_ parsable.
    // extraExtensionsToScan: ['.json', '.jpg', '.png', '.svg', '.webp'],

    // if true combines the package.jsons found from the module up to the base
    // folder the cruise is initiated from. Useful for how (some) mono-repos
    // manage dependencies & dependency definitions.
    // combinedDependencies: false,

    // if true leave symlinks untouched, otherwise use the realpath
    // preserveSymlinks: false,

    // TypeScript project file ('tsconfig.json') to use for
    // (1) compilation and
    // (2) resolution (e.g. with the paths property)
    //
    // The (optional) fileName attribute specifies which file to take (relative to
    // dependency-cruiser's current working directory). When not provided
    // defaults to './tsconfig.json'.
    tsConfig: {
      fileName: 'tsconfig.build.json',
    },

    // Webpack configuration to use to get resolve options from.
    //
    // The (optional) fileName attribute specifies which file to take (relative
    // to dependency-cruiser's current working directory. When not provided defaults
    // to './webpack.conf.js'.
    //
    // The (optional) 'env' and 'arguments' attributes contain the parameters
    // to be passed if your webpack config is a function and takes them (see
    //  webpack documentation for details)
    // webpackConfig: {
    //  fileName: 'webpack.config.js',
    //  env: {},
    //  arguments: {}
    // },

    // Babel config ('.babelrc', '.babelrc.json', '.babelrc.json5', ...) to use
    // for compilation
    // babelConfig: {
    //   fileName: '.babelrc',
    // },

    // List of strings you have in use in addition to cjs/ es6 requires
    // & imports to declare module dependencies. Use this e.g. if you've
    // re-declared require, use a require-wrapper or use window.require as
    // a hack.
    // exoticRequireStrings: [],

    // options to pass on to enhanced-resolve, the package dependency-cruiser
    // uses to resolve module references to disk. The values below should be
    // suitable for most situations
    //
    // If you use webpack: you can also set these in webpack.conf.js. The set
    // there will override the ones specified here.
    enhancedResolveOptions: {
      // What to consider as an 'exports' field in package.jsons
      exportsFields: ['exports'],

      // List of conditions to check for in the exports field.
      // Only works when the 'exportsFields' array is non-empty.
      conditionNames: ['import', 'require', 'node', 'default', 'types'],

      // The extensions, by default are the same as the ones dependency-cruiser
      // can access (run `npx dependency-cruiser --info` to see which ones that are in
      // _your_ environment). If that list is larger than you need you can pass
      // the extensions you actually use (e.g. ['.js', '.jsx']). This can speed
      // up module resolution, which is the most expensive step.
      extensions: ['.ts'],

      // What to consider a 'main' field in package.json
      mainFields: ['module', 'main', 'types', 'typings'],

      // A list of alias fields in package.jsons
      // See https://github.com/defunctzombie/package-browser-field-spec and
      // the webpack [resolve.alias](https://webpack.js.org/configuration/resolve/#resolvealiasfields)
      // documentation.
      // Defaults to an empty array (= don't use alias fields).
      // aliasFields: ['browser'],
    },

    // skipAnalysisNotInRules will make dependency-cruiser execute
    // analysis strictly necessary for checking the rule set only.
    // See https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#skipanalysisnotinrules
    skipAnalysisNotInRules: true,

    reporterOptions: {
      dot: {
        // Pattern of modules to consolidate to. The default pattern in this configuration
        // collapses everything in node_modules to one folder deep so you see
        // the external modules, but not their innards.
        collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)',

        // Options to tweak the appearance of your graph. See
        // https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#reporteroptions
        // If you don't specify a theme dependency-cruiser falls back to a built-in one.
        // theme: {
        //   graph: {
        //     // splines: 'ortho' - straight lines; slow on big graphs
        //     // splines: 'true' - bezier curves; fast but not as nice as ortho
        //     splines: 'true'
        //   },
        // },
      },
      archi: {
        // Pattern of modules to consolidate to.
        collapsePattern:
          '^(?:packages|src|lib(s?)|app(s?)|bin|test(s?)|spec(s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',

        // Options to tweak the appearance of your graph. If you don't specify a
        // theme for 'archi' dependency-cruiser will use the one specified in the
        // dot section above and otherwise use the default one.
        // theme: { },
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};

/**
 * Điểm mở rộng của dự án (spec SP7 §6.1, M5): luật kiến trúc riêng nằm ở `.dependency-cruiser.app.cjs` (vùng dự án),
 * export `{ forbidden: [...] }`, được nối sau luật của boilerplate. File này thuộc vùng boilerplate: không sửa ở clone.
 */
const APP_RULES_FILE = require('node:path').join(
  __dirname,
  '.dependency-cruiser.app.cjs',
);
if (require('node:fs').existsSync(APP_RULES_FILE)) {
  const app = require(APP_RULES_FILE);
  if (!Array.isArray(app?.forbidden))
    throw new Error(
      '.dependency-cruiser.app.cjs must export { forbidden: [...] }',
    );
  const known = new Set(config.forbidden.map((r) => r.name));
  for (const rule of app.forbidden)
    if (known.has(rule.name))
      throw new Error(
        `.dependency-cruiser.app.cjs: rule "${rule.name}" already exists in the boilerplate rules`,
      );
  config.forbidden.push(...app.forbidden);
}

module.exports = config;
// generated: dependency-cruiser@18.4.0 on 2026-09-25T07:18:24.782Z
