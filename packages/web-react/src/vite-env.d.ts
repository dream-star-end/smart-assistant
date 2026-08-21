/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TASKBOARD_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
