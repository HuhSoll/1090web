/** Build stamp of this copy of the app (Phase 9I): recorded with saved research results. */
export const APP_BUILD: { version: string; commit: string | null; builtAt: string } =
  typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : { version: 'test', commit: null, builtAt: '' };
