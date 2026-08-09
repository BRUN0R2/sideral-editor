import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { WindowChrome } from "./components/WindowChrome";
import { I18nProvider } from "./features/i18n/I18nProvider";
import "@vscode/codicons/dist/codicon.css";
import "./styles/base.css";
import "./styles/workbench.css";
import "./styles/settings.css";
import "./styles/dialogs.css";
import "./styles/extensions.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The application root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <WindowChrome />
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
