import { useEffect, useState } from "react";
import { api, urlPublic } from "../api";

const EMPRESAS = [
  ["0001", "Also Casals"],
  ["0002", "FerrosCA"],
  ["0003", "Quimlab"],
];

export default function Login({ alEntrar }) {
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [empresa, setEmpresa] = useState("0001");
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [portal, setPortal] = useState({ url: null });

  useEffect(() => {
    api
      .get("/api/auth/portal")
      .then((r) => setPortal({ url: r.url || null }))
      .catch(() => {});
  }, []);

  const entrar = async (e) => {
    e.preventDefault();
    setError("");
    setEnviando(true);
    try {
      const dades = await api.post("/api/auth/login", { usuario, password, empresa });
      alEntrar(dades);
    } catch (err) {
      setError(err.esRed ? "Sin conexión con el servidor" : err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login-fons">
      <form className="login-caixa" onSubmit={entrar}>
        <div className="marca-ac">
          AC<span className="sufix">sales</span>
        </div>
        <p className="login-sub">Ventas Also · mismo usuario que ACconstelation / ACapp</p>
        <img
          className="login-logo"
          src={urlPublic("logos/energia-positiva.jpg")}
          alt="Also Casals — Energia Positiva"
        />

        {portal.url && (
          <p className="ajuda" style={{ margin: "0 0 0.75rem" }}>
            Acceso y usuarios se gestionan en{" "}
            <a href={portal.url} target="_blank" rel="noreferrer">
              ACconstelation
            </a>
            {" "}(mismas credenciales). Desde el portal puedes abrir ACsales con SSO.
          </p>
        )}

        <label>
          Empresa
          <select value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            {EMPRESAS.map(([valor, texto]) => (
              <option key={valor} value={valor}>
                {texto}
              </option>
            ))}
          </select>
        </label>
        <label>
          Usuario
          <input
            type="text"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <p className="ajuda" style={{ margin: 0 }}>
          Usuario y contraseña de <strong>ACconstelation</strong> (los mismos que ACapp / averías).
          Hace falta tener acceso a ACsales concedido en el portal.
        </p>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="boto-primari" disabled={enviando}>
          {enviando ? "Entrando…" : "Entrar"}
        </button>
        {portal.url && (
          <a
            href={portal.url}
            className="boto-primari"
            style={{ marginTop: "0.5rem" }}
          >
            Ir a ACconstelation
          </a>
        )}
        <div className="login-empreses">
          <img src={urlPublic("logos/also.png")} alt="Also Casals" />
          <img src={urlPublic("logos/ferrosca.png")} alt="ferrosCA" />
          <img src={urlPublic("logos/quimlab.png")} alt="Quimlab" />
          <img src={urlPublic("logos/amfutur.jpg")} alt="AM Futur Avícola" />
        </div>
      </form>
    </div>
  );
}
