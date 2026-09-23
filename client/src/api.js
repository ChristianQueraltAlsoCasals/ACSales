const BASE_PATH = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

export function urlPublic(ruta) {
  const rel = ruta.startsWith("/") ? ruta.slice(1) : ruta;
  return `${import.meta.env.BASE_URL || "/"}${rel}`;
}

export function urlApi(ruta) {
  if (/^https?:\/\//.test(ruta)) return ruta;
  if (!ruta.startsWith("/")) return `${BASE_PATH}/${ruta}`;
  return `${BASE_PATH}${ruta}`;
}

async function peticion(ruta, opciones = {}) {
  const url = urlApi(ruta);
  const headers = {};
  let body;
  if (opciones.cuerpo) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opciones.cuerpo);
  }
  let res;
  try {
    res = await fetch(url, {
      method: opciones.metodo || "GET",
      headers,
      body,
      credentials: "same-origin",
    });
  } catch {
    const err = new Error("Sin conexión");
    err.esRed = true;
    throw err;
  }
  if (res.status === 401 && !url.includes("/api/auth/")) {
    window.dispatchEvent(new Event("sesion-caducada"));
  }
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(datos.error || "Error del servidor");
    err.estado = res.status;
    throw err;
  }
  return datos;
}

export const api = {
  get: (ruta) => peticion(ruta),
  post: (ruta, cuerpo) => peticion(ruta, { metodo: "POST", cuerpo }),
};

/** Si cualquier fetch a /api (excepto auth) responde 401 → vuelve al login. */
export function instalarInterceptorSesion() {
  if (typeof window === "undefined" || window.__acsalesFetchAuth) return;
  window.__acsalesFetchAuth = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await original(...args);
    try {
      const raw = args[0];
      const url = typeof raw === "string" ? raw : raw?.url || "";
      if (res.status === 401 && url.includes("/api/") && !url.includes("/api/auth/")) {
        window.dispatchEvent(new Event("sesion-caducada"));
      }
    } catch { /* ignore */ }
    return res;
  };
}
