/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SELLERSPRITE_MCP_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
