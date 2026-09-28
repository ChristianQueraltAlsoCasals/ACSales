import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./styles.css";
import { instalarEmpresaEnFetch } from "./empresa.jsx";

// Multiempresa: cada llamada a /api lleva la empresa elegida (X-Empresa)
instalarEmpresaEnFetch();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
