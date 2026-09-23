/**
 * Cliente AChuman: resuelve email_empresa del colaborador (buzón de envío).
 */
function baseUrl() {
  return String(process.env.ACHUMAN_URL || "").trim().replace(/\/$/, "");
}

function secret() {
  return String(
    process.env.ACHUMAN_SERVICE_SECRET
      || process.env.SSO_SERVICE_SECRET
      || ""
  ).trim();
}

function configurat() {
  return baseUrl().length > 0 && secret().length >= 8;
}

async function consultarContacto({ codi_treballador, empresa, username } = {}) {
  if (!configurat()) {
    return { ok: false, omitit: true, email_envio: null };
  }
  const url = `${baseUrl()}/api/intern/colaborador-contacto`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.ACHUMAN_TIMEOUT_MS || 8000));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AC-Service": secret(),
      },
      body: JSON.stringify({
        codi_treballador: codi_treballador || null,
        empresa: empresa || null,
        username: username || null,
      }),
      signal: ctrl.signal,
    });
    const cos = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: cos.error || `AChuman respondió ${res.status}`,
        email_envio: null,
      };
    }
    return {
      ok: true,
      trobat: !!cos.trobat,
      email_empresa: cos.email_empresa || null,
      email: cos.email || null,
      email_envio: cos.email_envio || cos.email_empresa || cos.email || null,
      nombre: cos.nombre || null,
    };
  } catch (e) {
    console.error("[achuman] contacto:", e.message);
    return {
      ok: false,
      status: 503,
      error: "No se ha podido consultar AChuman",
      email_envio: null,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Preferir email_empresa AChuman; si no, email @alsocasals del usuario local/ERP.
 */
function emailEnvioFallback(usuario) {
  const candidatos = [
    usuario?.email_empresa,
    usuario?.email,
  ];
  for (const e of candidatos) {
    const v = String(e || "").trim().toLowerCase();
    if (v.includes("@") && !v.endsWith(".local") && !v.includes("@erp.") && !v.includes("@sso.")) {
      return v;
    }
  }
  return null;
}

async function resolverEmailEnvio(usuario) {
  if (!usuario) return { email: null, origen: null };
  const cached = String(usuario.email_empresa || "").trim().toLowerCase();
  if (cached.includes("@")) {
    return { email: cached, origen: "cache" };
  }

  const r = await consultarContacto({
    codi_treballador: usuario.codi_treballador,
    empresa: usuario.empresa_treballador || usuario.empresa,
    username: usuario.username,
  });

  if (r.ok && r.email_envio) {
    return { email: String(r.email_envio).trim().toLowerCase(), origen: "achuman" };
  }

  const fb = emailEnvioFallback(usuario);
  if (fb) return { email: fb, origen: "local" };
  return { email: null, origen: null, error: r.error || "Sin email de empresa en AChuman" };
}

module.exports = {
  configurat,
  consultarContacto,
  resolverEmailEnvio,
  emailEnvioFallback,
};
