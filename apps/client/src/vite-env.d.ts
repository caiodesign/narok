/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `'true'` turns the sale controls on (ruling R185); anything else, or unset, leaves them out. */
  readonly VITE_FEATURE_SHOP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
