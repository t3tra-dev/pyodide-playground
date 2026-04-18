import React from "react";
import ReactDOM from "react-dom/client";
import { scan } from "react-scan";
import App from "./App.tsx";
import "./index.css";

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
