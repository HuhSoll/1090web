/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATASET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** package version, git commit and build time (vite.config.ts) */
declare const __APP_BUILD__: { version: string; commit: string | null; builtAt: string };
