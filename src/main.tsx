import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { WindowChrome } from "./components/WindowChrome";
import { I18nProvider } from "./features/i18n/I18nProvider";
import { connectExtensionHost } from "./features/sideral-extensions/host/connection";
import { isDesktopRuntime } from "./lib/backend";
import "@vscode/codicons/dist/codicon.css";
import "./styles/base.css";
import "./styles/workbench.css";
import "./styles/settings.css";
import "./styles/dialogs.css";
import "./styles/extensions.css";
import "./styles/markdown-preview.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The application root element is missing.");
}

const extensionHostConnection = isDesktopRuntime() ? connectExtensionHost() : null;
if (extensionHostConnection !== null) {
  void extensionHostConnection.catch((error: unknown) => {
    console.error("The extension host failed to connect.", error);
  });
  window.addEventListener(
    "pagehide",
    () => {
      void extensionHostConnection
        .then((connection) => connection.dispose())
        .catch((error: unknown) => {
          console.error("The extension host failed to shut down cleanly.", error);
        });
    },
    { once: true },
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <WindowChrome />
    <ErrorBoundary>
      <I18nProvider>
        <App extensionHostConnection={extensionHostConnection} />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
