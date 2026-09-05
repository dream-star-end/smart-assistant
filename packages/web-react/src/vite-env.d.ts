/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TASKBOARD_ENABLED?: string;
  readonly VITE_OC_FILECARD_SNIFF?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
