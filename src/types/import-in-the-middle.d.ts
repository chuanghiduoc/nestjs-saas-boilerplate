// import-in-the-middle 3.5.1 ships `register-hooks.d.ts` next to `register-hooks.mjs`. With
// `moduleResolution: nodenext` an `.mjs` import only picks up a sibling `.d.mts`, so TypeScript
// finds no types for the real specifier. Re-export the package's own declarations (the `.js`
// specifier resolves to `register-hooks.d.ts`; types only, nothing is loaded at runtime).
declare module 'import-in-the-middle/register-hooks.mjs' {
  export {
    register,
    supportsSyncHooks,
    type RegisterHooksOptions,
  } from 'import-in-the-middle/register-hooks.js';
}
