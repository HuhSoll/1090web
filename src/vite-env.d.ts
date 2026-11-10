/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATASET_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
