/**
 * Cliente HTTP hacia ACFactory (/api/intern/*) para alta de productos desde la IA.
 */
function baseUrl() {
  return String(process.env.ACFACTORY_URL || "").replace(/\/+$/, "");
}

function secret() {
  return String(
    process.env.ACFACTORY_SERVICE_SECRET || process.env.SSO_SERVICE_SECRET || ""
  ).trim();
}

function configurado() {
  return baseUrl().length > 0 && secret().length >= 16;
}

async function pedir(path, { method = "GET", body, fetchImpl } = {}) {
  if (!configurado()) {
    const err = new Error(
      "ACFactory no configurado: falta ACFACTORY_URL o ACFACTORY_SERVICE_SECRET/SSO_SERVICE_SECRET en .env"
    );
    err.status = 503;
    throw err;
  }
  const fetchFn = fetchImpl || fetch;
  const url = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "X-AC-Service": secret(),
    Accept: "application/json",
  };
  const opts = { method, headers };
  if (body != null) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetchFn(url, opts);
  const texto = await r.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return {
    ok: r.ok,
    status: r.status,
    json,
    texto: texto.slice(0, 2000),
  };
}

async function resolverGoCatalog({ cat1, cat2, cat3 }, fetchImpl) {
  const r = await pedir("/api/intern/gocatalog/resolver", {
    method: "POST",
    body: { cat1, cat2, cat3 },
    fetchImpl,
  });
  if (!r.ok) {
    const err = new Error(r.json?.error || `ACFactory ${r.status}: ${r.texto.slice(0, 300)}`);
    err.status = r.status;
    err.candidatos = r.json?.candidatos;
    throw err;
  }
  return r.json;
}

async function buscarGoCatalog(query, fetchImpl) {
  const qs = new URLSearchParams();
  if (query.nivel != null) qs.set("nivel", String(query.nivel));
  if (query.padre) qs.set("padre", query.padre);
  if (query.abuelo) qs.set("abuelo", query.abuelo);
  if (query.q) qs.set("q", query.q);
  if (query.top) qs.set("top", String(query.top));
  const r = await pedir(`/api/intern/gocatalog?${qs}`, { fetchImpl });
  if (!r.ok) {
    const err = new Error(r.json?.error || `ACFactory ${r.status}: ${r.texto.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return r.json?.items || [];
}

async function crearProducto(body, fetchImpl) {
  const r = await pedir("/api/intern/productos", {
    method: "POST",
    body,
    fetchImpl,
  });
  if (!r.ok) {
    const err = new Error(r.json?.error || `ACFactory ${r.status}: ${r.texto.slice(0, 400)}`);
    err.status = r.status;
    err.detalle = r.json;
    throw err;
  }
  return r.json;
}

module.exports = {
  configurado,
  baseUrl,
  resolverGoCatalog,
  buscarGoCatalog,
  crearProducto,
};
