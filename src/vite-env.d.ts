/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown;
  MonacoEnvironment?: {
    getWorker(moduleId: string, label: string): Worker;
  };
}
