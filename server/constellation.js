// Cliente del portal ACconstelation (consulta de acceso + consumo de tickets SSO).
const APP_CLAU = "acsales";

function baseUrl() {
  return String(process.env.CONSTELLATION_URL || "").trim().replace(/\/$/, "");
}

function secret() {
  return String(process.env.SSO_SERVICE_SECRET || "").trim();
}

function configurat() {
  return baseUrl().length > 0 && secret().length >= 16;
}

async function crida(ruta, { method = "GET", body } = {}) {
  const url = `${baseUrl()}${ruta.startsWith("/") ? ruta : `/${ruta}`}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.CONSTELLATION_TIMEOUT_MS || 8000));
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-AC-Service": secret(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const cos = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, cos };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Candidatos de username para encajar ERP ↔ portal.
 * Ej.: «xavi.also» (ERP) → también prueba «xavi» (portal).
 */
function candidatsUsername(username) {
  const raw = String(username || "").trim();
  if (!raw) return [];
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (!s) return;
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  add(raw);
  if (raw.includes("@")) {
    const local = raw.split("@")[0];
    add(local);
    if (local.includes(".")) add(local.split(".")[0]);
  } else {
    if (raw.includes(".")) add(raw.split(".")[0]);
    if (/\s/.test(raw)) add(raw.split(/\s+/)[0]);
  }
  return out;
}

async function consultarAccesUn(username) {
  const { ok, status, cos } = await crida("/api/intern/acces", {
    method: "POST",
    body: { username, app: APP_CLAU },
  });
  if (!ok) {
    return {
      ok: false,
      status,
      error: cos.error || `El portal ha respondido ${status}`,
    };
  }
  return {
    ok: true,
    acces: !!cos.acces && !!cos.actiu,
    nivell: cos.nivell || "cap",
    rol: cos.rol || null,
    portal_super: !!cos.portal_super || !!cos.usuari?.portal_super
      || !!cos.perfil?.editar_usuaris,
    permisos: cos.permisos || null,
    accions: cos.accions || null,
    trobat: !!cos.trobat,
    actiu: !!cos.actiu,
    usuari: cos.usuari || null,
    treballador: cos.treballador || cos.usuari?.treballador || null,
    usernamePortal: username,
  };
}

async function consultarAcces(username) {
  if (!configurat()) {
    return {
      ok: true, omitit: true, acces: true, nivell: null, rol: null,
      portal_super: false, permisos: null, accions: null,
      trobat: true, actiu: true,
      usuari: null,
      treballador: null,
    };
  }
  try {
    let darrerNoTrobat = null;
    for (const cand of candidatsUsername(username)) {
      const r = await consultarAccesUn(cand);
      if (!r.ok) return r;
      if (r.trobat) return r;
      darrerNoTrobat = r;
    }
    return darrerNoTrobat || {
      ok: true,
      acces: false,
      nivell: "cap",
      trobat: false,
      actiu: false,
      usuari: null,
      treballador: null,
    };
  } catch (e) {
    console.error("Error consultando acceso a ACconstelation:", e.message);
    return {
      ok: false,
      status: 503,
      error: "No se ha podido verificar el acceso con el portal. Inténtalo de nuevo.",
    };
  }
}

async function consumirTicket(ticket) {
  if (!configurat()) {
    return { ok: false, status: 503, error: "SSO no configurado en esta aplicación" };
  }
  try {
    const { ok, status, cos } = await crida("/api/intern/sso/consumir", {
      method: "POST",
      body: { ticket },
    });
    if (!ok) {
      return {
        ok: false,
        status: status === 410 ? 410 : status,
        error: cos.error || "Ticket SSO no válido",
      };
    }
    if (cos.app && cos.app !== APP_CLAU) {
      return { ok: false, status: 403, error: "Este ticket no es para ACsales" };
    }
    return {
      ok: true,
      nivell: cos.nivell || "us",
      usuari: cos.usuari,
    };
  } catch (e) {
    console.error("Error consumiendo ticket SSO:", e.message);
    return {
      ok: false,
      status: 503,
      error: "No se ha podido validar el ticket con el portal",
    };
  }
}

/** Nivel portal → rol local (solo en altas nuevas). */
function rolDesDeNivell(nivell) {
  if (nivell === "admin" || nivell === "gestio") return "admin";
  return "usuari";
}

module.exports = {
  APP_CLAU,
  configurat,
  consultarAcces,
  consumirTicket,
  rolDesDeNivell,
  candidatsUsername,
};
