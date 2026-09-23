import { useEffect, useState } from "react";
import { api, instalarInterceptorSesion } from "./api";
import Login from "./pages/Login";
import CargarDatosVentas from "./CargarDatosVentas";

instalarInterceptorSesion();

export default function App() {
  const [usuario, setUsuario] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let vivo = true;
    api
      .get("/api/auth/me")
      .then((u) => {
        if (vivo) setUsuario(u);
      })
      .catch(() => {
        if (vivo) setUsuario(null);
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });

    const onCaducada = () => setUsuario(null);
    window.addEventListener("sesion-caducada", onCaducada);
    return () => {
      vivo = false;
      window.removeEventListener("sesion-caducada", onCaducada);
    };
  }, []);

  const sortir = async () => {
    try {
      await api.post("/api/auth/logout");
    } catch { /* ignore */ }
    setUsuario(null);
  };

  if (cargando) {
    return <div className="login-fons"><p className="carregant">Comprobando sesión…</p></div>;
  }

  if (!usuario) {
    return <Login alEntrar={setUsuario} />;
  }

  return <CargarDatosVentas usuario={usuario} onLogout={sortir} />;
}
