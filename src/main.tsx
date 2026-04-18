import React from "react";
import ReactDOM from "react-dom/client";
import { scan } from "react-scan";
import App from "./App.tsx";
import "./index.css";

function installCrossOriginIsolationServiceWorker() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  if (document.querySelector('script[data-coi-service-worker="true"]')) {
    return;
  }

  const script = document.createElement("script");
  script.src = `${import.meta.env.BASE_URL}coi-serviceworker.min.js`;
  script.async = false;
  script.dataset.coiServiceWorker = "true";
  document.head.appendChild(script);
}

installCrossOriginIsolationServiceWorker();

if (import.meta.env.DEV) {
  scan({
    enabled: true,
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
