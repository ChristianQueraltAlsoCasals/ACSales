/**
 * =====================================================================
 *  BACKEND — Agente de Ventas (ALSO CASALS)
 * =====================================================================
 *  Servidor intermedio entre el navegador y las APIs externas.
 *  Su razón de existir: las CLAVES (Anthropic y Business Central)
 *  viven aquí, en el servidor, NUNCA en el código del navegador.
 *
 *      Navegador ──► este backend ──► API Anthropic (Claude)
 *                                 └─► API Business Central
 *
 *  Endpoints:
 *    POST /api/clasificar        → clasifica una descripción de OT con Claude
 *    GET  /api/bc/:fuente        → trae datos de BC por rango de fechas
 *                                  ?from=2026-07-01&to=2026-07-06
 *
 *  Puesta en marcha:
 *    1. npm install express dotenv
 *    2. Copiar .env.example a .env y rellenar las claves
 *    3. node server.js
 * =====================================================================
 */

// Cargar variables de entorno: un solo .env en la raíz del repo (como ACTDrive).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config(); // cwd por si se arranca desde la raíz
const express = require("express");
const cookieParser = require("cookie-parser");

// pdf-lib: solo hace falta para "Subir Documento" en Recepción de material
// (recorta el PDF grande en un PDF por pedido). Si no está instalado, NO
// tumbamos todo el servidor — esa función concreta avisará con un error
// claro (ver /api/recepcion/extraer) en vez de romper el resto de la app.
let PDFDocument = null;
try {
  ({ PDFDocument } = require("pdf-lib"));
} catch {
  console.warn("⚠️  'pdf-lib' no está instalado — 'Subir Documento' (Recepción) no funcionará hasta ejecutar: npm install pdf-lib");
}

// El visor de Business Central no abre los PDF que pdf-lib escribe con
// object streams. El navegador sí. Solo se usa al guardar el PDF que se
// adjunta a un pedido o a una factura. Los lotes que se mandan a leer
// siguen con save() normal.
function guardarPdfParaBc(doc) {
  return doc.save({ useObjectStreams: false });
}

// Vista previa de Recepción de material. El visor de Chrome ya no pinta un
// PDF metido en un iframe como data:...;base64 (antes sí). Hace falta una
// URL normal, igual que en facturas de compra. El id es aleatorio y caduca.
const vistasPdfRecepcion = new Map();
function guardarVistaPdfRecepcion(bytes) {
  const id = require("crypto").randomBytes(18).toString("hex");
  const ahora = Date.now();
  for (const [k, v] of vistasPdfRecepcion) {
    if (v.expira < ahora) vistasPdfRecepcion.delete(k);
  }
  while (vistasPdfRecepcion.size >= 60) {
    vistasPdfRecepcion.delete(vistasPdfRecepcion.keys().next().value);
  }
  vistasPdfRecepcion.set(id, { bytes: Buffer.from(bytes), expira: ahora + 2 * 60 * 60 * 1000 });
  return id;
}
function leerVistaPdfRecepcion(id) {
  const v = vistasPdfRecepcion.get(String(id || ""));
  if (!v || v.expira < Date.now()) return null;
  return v.bytes;
}

const app = express();
app.use(express.json({ limit: "500mb" })); // fichas + líneas con TODAS las columnas: el estado puede ser grande
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
  },
})); // frontend compilado (build)

const PORT = process.env.PORT || 3000;

// Auth ERP + ACconstelation (mismo patrón que achuman / aclogistics)
const { router: authRouter, requiereSesion } = require("./auth");
const { prepararRecepcionAlbaran, crearPedidoPreparado } = require("./recepcionPreparar.cjs");
const acfactory = require("./acfactory-client.cjs");
const { soloControlHoras } = require("./permisos");
const { prepararLogoCorreo } = require("./logoCliente.cjs");
app.use("/api/auth", authRouter);
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return requiereSesion(req, res, next);
});
/** Usuarios con solo_control_horas: únicamente endpoints de Control de horas. */
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  if (!req.usuario || !soloControlHoras(req.usuario)) return next();
  if (req.path.startsWith("/horas")) return next();
  return res.status(403).json({
    error: "Solo tienes permiso para Control de horas en ACsales.",
  });
});

// ---------------------------------------------------------------------
// RED ROBUSTA: BC a veces tarda en responder (llamadas grandes) y la
// conexión puede fallar puntualmente. Todas las llamadas salientes usan
// tiempos de espera generosos y reintento automático (3 intentos).
// IMPORTANTE: se usa el fetch DE LA PROPIA librería undici (no el
// global de Node) porque el Agent y el fetch deben ser de la misma
// versión — mezclarlos produce UND_ERR_INVALID_ARG.
// ---------------------------------------------------------------------
let fetchLento = fetch; // respaldo: fetch global con tiempos por defecto
let fetchParteAlso = fetch;
try {
  const undici = require("undici");
  const dispatcherLento = new undici.Agent({
    connectTimeout: 20_000,   // 20 s para conectar
    headersTimeout: 500_000,  // 500 s para que empiece a responder (cabeceras pedido, 90+ cols)
    bodyTimeout: 500_000,     // 500 s para el cuerpo completo
  });
  fetchLento = (url, opciones = {}) => undici.fetch(url, { ...opciones, dispatcher: dispatcherLento });
  // app.alsocasals.com firma el parte con un certificado que el contenedor
  // no tiene en su almacén. Solo esta URL se descarga sin comprobar la cadena.
  const dispatcherParte = new undici.Agent({
    connect: { rejectUnauthorized: false },
    connectTimeout: 20_000,
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });
  fetchParteAlso = (url, opciones = {}) => undici.fetch(url, { ...opciones, dispatcher: dispatcherParte });
} catch {
  /* undici no instalado: se usan los tiempos por defecto de Node */
}

// Señal de la lectura de factura en curso (timeout). Solo existe dentro de
// conLecturaLimitada; el resto de llamadas no la ven.
let senalLecturaAls = null;
function senalDeLectura() {
  return senalLecturaAls ? senalLecturaAls.getStore() : null;
}
function peticionCortada(err, extra) {
  if (extra?.aborted) return true;
  const nombre = String(err?.name || err?.cause?.name || "");
  if (nombre === "AbortError" || nombre === "TimeoutError") return true;
  const codigo = String(err?.code || err?.cause?.code || "");
  return codigo === "ABORT_ERR" || codigo === "UND_ERR_ABORTED";
}

async function fetchConReintento(url, opciones = {}, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    const extra = senalDeLectura();
    if (extra?.aborted) throw extra.reason || new Error("Lectura cancelada");
    const signal = extra
      ? (opciones.signal ? AbortSignal.any([opciones.signal, extra]) : extra)
      : opciones.signal;
    const opts = signal ? { ...opciones, signal } : opciones;
    try {
      return await fetchLento(url, opts);
    } catch (err) {
      ultimoError = err;
      if (peticionCortada(err, extra)) throw err;
      const causa = err.cause?.code || err.code || err.message;
      console.warn(`[red] Fallo (intento ${i + 1}/${intentos}): ${causa} — ${url.slice(0, 80)}...`);
      if (i < intentos - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw ultimoError;
}

// Caché del token de Azure (dura ~1h; lo renovamos 5 min antes)
let tokenCache = { token: null, expira: 0 };

async function obtenerTokenBC() {
  if (tokenCache.token && Date.now() < tokenCache.expira) return tokenCache.token;

  const url = `https://login.microsoftonline.com/${process.env.BC_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.BC_CLIENT_ID,
    client_secret: process.env.BC_CLIENT_SECRET,
    scope: "https://api.businesscentral.dynamics.com/.default",
  });

  const response = await fetchConReintento(url, { method: "POST", body });
  if (!response.ok) throw new Error(`Azure AD respondió ${response.status}: ${await response.text()}`);

  const data = await response.json();
  tokenCache = {
    token: data.access_token,
    expira: Date.now() + (data.expires_in - 300) * 1000,
  };
  return tokenCache.token;
}

// =======================================================================
// MULTIEMPRESA — Alsocasals / Ferros / Quimlab (AsyncLocalStorage + X-Empresa)
// Postgres: claveEmpresa("recepcion") → "recepcion" o "recepcion_ferros"
// =======================================================================
const { AsyncLocalStorage } = require("async_hooks");
const contextoEmpresa = new AsyncLocalStorage();
senalLecturaAls = new AsyncLocalStorage();
const EMPRESA_POR_DEFECTO = () => ({ id: process.env.BC_COMPANY_ID, nombre: process.env.BC_COMPANY_NAME, porDefecto: true });
const EMPRESA_ACTUAL = () => contextoEmpresa.getStore() || EMPRESA_POR_DEFECTO();
function EMPRESA_ID() { return EMPRESA_ACTUAL().id; }
function EMPRESA_NOMBRE() { return EMPRESA_ACTUAL().nombre; }
/** Dominio del remitente → empresa del grupo (correo / recomendaciones). */
function empresaGrupoDesdeEmail(email) {
  const dom = String(email || "").toLowerCase().split("@")[1] || "";
  if (!dom) return "";
  if (dom === "ferrosca.com" || dom.endsWith(".ferrosca.com")) return "FerrosCA";
  if (dom === "alsocasals.com" || dom.endsWith(".alsocasals.com")) return "Also Casals";
  if (dom.includes("quimlab")) return "Quimlab";
  return "";
}
/** Resuelve nombre corto de acción BC («FerrosCA», «Also Casals»…) a la empresa de la app. */
async function resolverEmpresaAccion(texto) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  if (!t) return null;
  const lista = await empresasApp();
  const score = (e) => {
    const n = `${e.nombre || ""} ${e.displayName || ""}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    if (t === "ferrosca" || t === "ferros") return n.includes("ferros") ? 2 : 0;
    if (t === "alsocasals" || t === "also") return n.includes("also") || n.includes("alsocasals") ? 2 : 0;
    if (t === "quimlab") return n.includes("quimlab") ? 2 : 0;
    if (n === t) return 3;
    if (n.includes(t) || t.includes(n)) return 1;
    return 0;
  };
  let mejor = null;
  let pts = 0;
  for (const e of lista) {
    const p = score(e);
    if (p > pts) { pts = p; mejor = e; }
  }
  return mejor || null;
}
const RE_EMPRESAS_APP = () => new RegExp(process.env.APP_EMPRESAS || "also|ferros|quimlab", "i");
let cacheEmpresasApp = null;
async function empresasApp() {
  if (cacheEmpresasApp && Date.now() - cacheEmpresasApp.ts < 10 * 60 * 1000) return cacheEmpresasApp.lista;
  const token = await obtenerTokenBC();
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
  const r = await fetchConReintento(`${raiz}/companies`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`BC respondió ${r.status} al listar empresas`);
  const lista = [];
  for (const c of (await r.json()).value || []) {
    if (!RE_EMPRESAS_APP().test(`${c.name} ${c.displayName || ""}`) && c.id !== process.env.BC_COMPANY_ID) continue;
    let cif = "";
    try {
      const ri = await fetchConReintento(`${raiz}/companies(${c.id})/companyInformation`, { headers: { Authorization: `Bearer ${token}` } });
      if (ri.ok) cif = (((await ri.json()).value || [])[0] || {}).taxRegistrationNumber || "";
    } catch {}
    lista.push({ id: c.id, nombre: c.name, displayName: c.displayName || c.name, cif, porDefecto: c.id === process.env.BC_COMPANY_ID });
  }
  cacheEmpresasApp = { ts: Date.now(), lista };
  return lista;
}
/** Clave Postgres por empresa: ALSO CASALS → base; otra → base_slug (p.ej. recepcion_ferros). */
function claveEmpresa(nombreBase) {
  const e = EMPRESA_ACTUAL();
  if (e.porDefecto || e.id === process.env.BC_COMPANY_ID) return nombreBase;
  const slug = String(e.nombre || e.id).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${nombreBase}_${slug}`;
}
app.use(async (req, res, next) => {
  const id = req.get("X-Empresa");
  if (!id || id === process.env.BC_COMPANY_ID) return next();
  try {
    const e = (await empresasApp()).find((c) => c.id === id);
    if (!e) return res.status(400).json({ error: `Empresa no permitida o no encontrada: ${id}` });
    contextoEmpresa.run({ id: e.id, nombre: e.nombre, porDefecto: false }, next);
  } catch (err) {
    res.status(500).json({ error: "No se pudo comprobar la empresa seleccionada.", detalle: String(err.message || err) });
  }
});
app.get("/api/empresas-app", async (req, res) => {
  try {
    if (req.query.refrescar === "1" || req.query.refrescar === "true") cacheEmpresasApp = null;
    const lista = await empresasApp();
    res.json({ empresas: lista, porDefecto: process.env.BC_COMPANY_ID });
  } catch (err) {
    res.json({ empresas: [{ id: process.env.BC_COMPANY_ID, nombre: process.env.BC_COMPANY_NAME, displayName: process.env.BC_COMPANY_NAME, cif: "B43831593", porDefecto: true }], porDefecto: process.env.BC_COMPANY_ID, aviso: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 0a) ESTADO DE LA APLICACIÓN — Postgres (app_state, claves estado.*)
// ---------------------------------------------------------------------
// Todo lo cargado (filas de BC, memoria de fichas…) se guarda por clave
// top-level (bcData, fichas, resumen, otFiles) para no reescribir ~400 MB
// cuando solo cambia una parte. API igual: merge superficial en POST.
// ---------------------------------------------------------------------
const db = require("./db");
const fsEstado = require("fs"); // aún usado en otros sitios del archivo

app.get("/api/estado", async (req, res) => {
  try {
    // Also Casals → prefijo "estado" (claves actuales). Otras → estado_<slug>.
    res.json(await db.getEstado(claveEmpresa("estado")));
  } catch (err) {
    console.error("Error leyendo estado:", err);
    res.status(500).json({ error: "No se pudo leer el estado." });
  }
});

app.post("/api/estado", async (req, res) => {
  try {
    const pref = claveEmpresa("estado");
    const claves = await db.mergeEstado(req.body || {}, pref);
    console.log(`[estado] Guardado en Postgres (${pref}): ${claves.join(", ")}`);
    res.json({ guardado: claves });
  } catch (err) {
    console.error("Error guardando estado:", err);
    res.status(500).json({ error: "No se pudo guardar el estado." });
  }
});

app.delete("/api/estado", async (req, res) => {
  try {
    await db.deleteEstado(claveEmpresa("estado"));
    res.json({ borrado: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo borrar el estado." });
  }
});

// ---------------------------------------------------------------------
// 0a-bis) RECEPCIÓN — marcas compartidas (revisados, fechas, reclamados…)
// ---------------------------------------------------------------------
//   { revisados, fechas, reclamados, emailsProveedor, notas, registrados,
//     firmasAprendidas, recogedores }
// ---------------------------------------------------------------------
const RECEP_DEFAULT = {
  revisados: {},
  fechas: {},
  reclamados: {},
  emailsProveedor: {},
  notas: {},
  registrados: {},
  firmasAprendidas: {},
  recogedores: {},
};
const leerRecep = async () => db.getDoc(claveEmpresa("recepcion"), { ...RECEP_DEFAULT });
const escribirRecep = async (d) => db.setDoc(claveEmpresa("recepcion"), d);

app.get("/api/recepcion", async (req, res) => {
  try {
    res.json(await leerRecep());
  } catch (err) {
    console.error("Error leyendo recepción:", err);
    res.status(500).json({ error: "No se pudo leer la recepción." });
  }
});

// Ficha de proveedores de BC (API v2.0 /vendors, solo LECTURA).
// Cache corta por empresa: Validación de facturas lo usa para el desplegable
// (nombre + CIF), no solo los que tienen pedido de compra cargado.
const cacheProveedoresBc = new Map(); // empresaId → { ts, proveedores }
const TTL_PROVEEDORES_BC_MS = 15 * 60 * 1000;

function normalizarCifProveedor(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^ES/, "");
}

async function listarProveedoresBc() {
  const empresa = EMPRESA_ID();
  const cached = cacheProveedoresBc.get(empresa);
  if (cached && Date.now() - cached.ts < TTL_PROVEEDORES_BC_MS) return cached.proveedores;

  const token = await obtenerTokenBC();
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${empresa})/vendors`;
  // Sin $top: si se pone, BC no devuelve @odata.nextLink y se cortan
  // cientos de proveedores (p. ej. solo salía 1 Saltoki de 7).
  const headers = { Authorization: `Bearer ${token}`, Prefer: "odata.maxpagesize=200" };
  let url = `${base}?$select=number,displayName,email,taxRegistrationNumber,blocked`;
  const out = [];
  let guard = 0;
  while (url && guard < 80) {
    guard += 1;
    const r = await fetchConReintento(url, { headers });
    if (!r.ok) {
      const detalle = (await r.text().catch(() => "")).slice(0, 300);
      throw new Error(`BC respondió ${r.status} al listar proveedores. ${detalle}`);
    }
    const j = await r.json();
    for (const v of j.value || []) {
      // Solo excluimos bloqueo total; "Payment" sigue siendo útil para facturas.
      if (String(v.blocked || "").toUpperCase() === "ALL") continue;
      const nombre = String(v.displayName || "").trim();
      if (!nombre) continue;
      out.push({
        numero: String(v.number || "").trim(),
        nombre,
        cif: String(v.taxRegistrationNumber || "").trim(),
        email: String(v.email || "").trim(),
      });
    }
    url = j["@odata.nextLink"] || null;
  }
  out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  cacheProveedoresBc.set(empresa, { ts: Date.now(), proveedores: out });
  return out;
}

app.get("/api/bc/proveedores", async (req, res) => {
  try {
    const proveedores = await listarProveedoresBc();
    res.json({ ok: true, n: proveedores.length, proveedores });
  } catch (err) {
    res.status(500).json({ error: "No se pudo listar los proveedores de BC.", detalle: String(err.message || err) });
  }
});

// Email del PROVEEDOR desde su ficha en BC (API v2.0 /vendors, solo LECTURA).
app.get("/api/bc/proveedor-email", async (req, res) => {
  const numero = String(req.query.numero || "").trim();
  const nombre = String(req.query.nombre || "").trim();
  const cif = String(req.query.cif || "").trim();
  if (!numero && !nombre && !cif) return res.status(400).json({ error: "Falta 'numero', 'nombre' o 'cif'." });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/vendors`;
    const esc = (v) => v.replace(/'/g, "''");
    const filtros = [];
    if (numero) filtros.push(`number eq '${esc(numero)}'`);
    if (nombre) filtros.push(`displayName eq '${esc(nombre)}'`);
    if (cif) {
      const cifN = normalizarCifProveedor(cif);
      if (cifN) {
        filtros.push(`number eq '${esc(cifN)}'`);
        filtros.push(`taxRegistrationNumber eq '${esc(cifN)}'`);
        if (cifN !== cif.toUpperCase().replace(/[^A-Z0-9]/g, "")) {
          filtros.push(`taxRegistrationNumber eq '${esc("ES" + cifN)}'`);
        }
      }
    }
    for (const f of filtros) {
      const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(f)}&$select=number,displayName,email,taxRegistrationNumber`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const v = ((await r.json()).value || [])[0];
      if (v) return res.json({ email: v.email || "", numero: v.number, nombre: v.displayName, cif: v.taxRegistrationNumber || "" });
    }
    if (nombre || cif) {
      try {
        const lista = await listarProveedoresBc();
        const cifN = normalizarCifProveedor(cif || nombre);
        const porCif = cifN
          ? lista.find((v) => normalizarCifProveedor(v.cif) === cifN || normalizarCifProveedor(v.numero) === cifN)
          : null;
        if (porCif) return res.json({ email: porCif.email || "", numero: porCif.numero, nombre: porCif.nombre, cif: porCif.cif || "" });
        if (nombre) {
          const hit = lista.find((v) => v.nombre && proveedoresParecidos(nombre, v.nombre));
          if (hit) return res.json({ email: hit.email || "", numero: hit.numero, nombre: hit.nombre, cif: hit.cif || "" });
        }
      } catch { /* cae al vacío */ }
    }
    res.json({ email: "" });
  } catch (err) {
    res.status(500).json({ error: "No se pudo consultar el proveedor en BC.", detalle: String(err.message || err) });
  }
});

// Email del CLIENTE desde su ficha en BC (API v2.0 /customers, solo LECTURA).
app.get("/api/bc/cliente-email", async (req, res) => {
  const numero = String(req.query.numero || "").trim();
  const nombre = String(req.query.nombre || "").trim();
  if (!numero && !nombre) return res.status(400).json({ error: "Falta 'numero' o 'nombre'." });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/customers`;
    const esc = (v) => v.replace(/'/g, "''");
    const filtros = [];
    if (numero) filtros.push(`number eq '${esc(numero)}'`);
    if (nombre) filtros.push(`displayName eq '${esc(nombre)}'`);
    for (const f of filtros) {
      const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(f)}&$select=number,displayName,email,taxRegistrationNumber`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const v = ((await r.json()).value || [])[0];
      if (v) return res.json({ email: v.email || "", cif: v.taxRegistrationNumber || "", numero: v.number, nombre: v.displayName });
    }
    res.json({ email: "" });
  } catch (err) {
    res.status(500).json({ error: "No se pudo consultar el cliente en BC.", detalle: String(err.message || err) });
  }
});

// Logo de la ficha del cliente (imagen de BC), recortado y pequeño, para el
// correo a los encargados. Si el cliente no tiene imagen, logo = null.
app.get("/api/bc/cliente-logo", async (req, res) => {
  const numero = String(req.query.numero || "").trim();
  const nombre = String(req.query.nombre || "").trim();
  if (!numero && !nombre) return res.json({ logo: null });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/customers`;
    const auth = { Authorization: `Bearer ${token}` };
    const esc = (v) => v.replace(/'/g, "''");
    const buscar = async (filtro) => {
      const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(filtro)}&$select=id,number,displayName&$top=5`, { headers: auth });
      if (!r.ok) return [];
      return ((await r.json()).value) || [];
    };
    let cli = null;
    if (numero) cli = (await buscar(`number eq '${esc(numero)}'`))[0] || null;
    if (!cli && nombre) cli = (await buscar(`displayName eq '${esc(nombre)}'`))[0] || null;
    if (!cli) return res.json({ logo: null });
    const metaR = await fetchConReintento(`${base}(${cli.id})/picture`, { headers: { ...auth, Accept: "application/json" } });
    if (!metaR.ok) return res.json({ logo: null });
    const meta = await metaR.json();
    if (!(meta.width > 0) || !(meta.height > 0)) return res.json({ logo: null });
    const cr = await fetchConReintento(`${base}(${cli.id})/picture/pictureContent`, { headers: auth });
    if (!cr.ok) return res.json({ logo: null });
    const bytes = Buffer.from(await cr.arrayBuffer());
    const logo = prepararLogoCorreo(bytes, meta.contentType || "");
    res.json(logo ? { ...logo, cliente: cli.displayName || nombre } : { logo: null });
  } catch (err) {
    console.warn("[cliente-logo]", err.message);
    res.json({ logo: null });
  }
});

// PDF oficial de una factura de venta registrada (API v2.0, pdfDocument).
async function leerPdfBC(url, headers) {
  const r = await fetchConReintento(url, { headers });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    return { ok: false, status: r.status, error: `BC respondió ${r.status} al descargar el PDF.`, detalle: detalle.slice(0, 400) };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, error: "Business Central no ha devuelto un PDF.", detalle: buf.subarray(0, 240).toString("utf8") };
  }
  return { ok: true, base64: buf.toString("base64") };
}

app.get("/api/bc/factura-venta-pdf", async (req, res) => {
  const numero = String(req.query.numero || "").trim();
  let id = String(req.query.id || "").trim();
  const esGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const auth = { Authorization: `Bearer ${token}` };
    if (!esGuid) {
      if (!numero) return res.status(400).json({ error: "Falta el número de factura." });
      const esc = numero.replace(/'/g, "''");
      const busca = await fetchConReintento(`${base}/salesInvoices?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$select=id,number&$top=1`, { headers: auth });
      if (!busca.ok) {
        const detalle = await busca.text();
        return res.status(502).json({ error: `BC respondió ${busca.status} buscando la factura.`, detalle: detalle.slice(0, 400) });
      }
      const v = ((await busca.json()).value || [])[0];
      if (!v?.id) return res.status(404).json({ error: `No está la factura ${numero} en Business Central.` });
      id = v.id;
    }

    const raiz = `${base}/salesInvoices(${id})/pdfDocument`;
    let ultimo = null;
    for (const accept of ["application/pdf", "application/octet-stream"]) {
      const got = await leerPdfBC(`${raiz}/pdfDocumentContent`, { ...auth, Accept: accept });
      if (got.ok) {
        const nombre = `Factura_${(numero || "venta").replace(/[^\w.-]+/g, "_")}.pdf`;
        return res.json({ nombre, base64: got.base64, mime: "application/pdf" });
      }
      ultimo = got;
    }

    const meta = await fetchConReintento(raiz, { headers: { ...auth, Accept: "application/json" } });
    if (meta.ok) {
      const j = await meta.json();
      const link = j["pdfDocumentContent@odata.mediaReadLink"] || (j.id ? `${raiz}(${j.id})/pdfDocumentContent` : "");
      if (link) {
        const got = await leerPdfBC(link, { ...auth, Accept: "application/pdf" });
        if (got.ok) {
          const nombre = `Factura_${(numero || "venta").replace(/[^\w.-]+/g, "_")}.pdf`;
          return res.json({ nombre, base64: got.base64, mime: "application/pdf" });
        }
        ultimo = got;
      }
    } else {
      const detalle = await meta.text().catch(() => "");
      ultimo = { error: `BC respondió ${meta.status} al pedir el PDF de la factura.`, detalle: detalle.slice(0, 400) };
    }
    return res.status(502).json({ error: ultimo?.error || "Business Central no ha devuelto el PDF de la factura.", detalle: ultimo?.detalle || "" });
  } catch (err) {
    res.status(500).json({ error: "No se pudo obtener el PDF de la factura.", detalle: String(err.message || err) });
  }
});

// Doc. extern de BC (93746-2026) → código del parte en Also (93746-26).
function codigoParteAlso(externo) {
  const m = /^(\d+)\s*[-/]\s*(\d{2}|\d{4})$/.exec(String(externo || "").trim());
  if (!m) return "";
  const anio = m[2].length === 4 ? m[2].slice(-2) : m[2];
  return `${m[1]}-${anio}`;
}

async function descargarParteAlso(externo) {
  const codigo = codigoParteAlso(externo);
  if (!codigo) return { ok: false, aviso: "" };
  const url = `https://app.alsocasals.com/ALSO/generarPartePDF.php?parte=${encodeURIComponent(codigo)}&noFeina=1`;
  const r = await fetchParteAlso(url);
  if (!r.ok) return { ok: false, codigo, aviso: `No se ha podido descargar el parte ${codigo} (respuesta ${r.status}). El PDF solo lleva el albarán.` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, codigo, aviso: `El parte ${codigo} no ha llegado como PDF. El documento solo lleva el albarán.` };
  }
  return { ok: true, codigo, buf };
}

async function unirAlbaranYParte(albaranBuf, parteBuf) {
  const out = await PDFDocument.create();
  const alb = await PDFDocument.load(albaranBuf, { ignoreEncryption: true });
  const par = await PDFDocument.load(parteBuf, { ignoreEncryption: true });
  for (const p of await out.copyPages(alb, alb.getPageIndices())) out.addPage(p);
  for (const p of await out.copyPages(par, par.getPageIndices())) out.addPage(p);
  return { buf: Buffer.from(await out.save()), paginas: out.getPageCount() };
}

// PDF del albarán de venta registrado (histórico), no del pedido.
// En BC se localiza por Nº documento externo, que en la app es Doc. extern
// (p. ej. PV26-001682 → 93746-2026 → ALBV26-002117). Si el pedido se
// registró con otro externo (el del albarán no coincide con el del PV),
// se busca también por número de pedido. Detrás se añade el parte de
// trabajo de app.alsocasals.com (93746-26).
function numeroAlbaran(number) {
  const m = String(number || "").match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : 0;
}

function albaranMasAlto(lista) {
  let mejor = null;
  for (const s of lista || []) {
    if (!mejor) { mejor = s; continue; }
    const a = numeroAlbaran(s.number);
    const b = numeroAlbaran(mejor.number);
    if (a > b || (a === b && String(s.number || "") > String(mejor.number || ""))) mejor = s;
  }
  return mejor;
}

// Del mismo pedido puede haber dos albaranes (ALBV26-003705 y ALBV26-003827).
// El bueno es el de número más alto.
function quedarAlbaranMasAltoPorPedido(lista) {
  const porPedido = new Map();
  const sinPedido = [];
  for (const s of lista || []) {
    const ped = String(s.orderNumber || "").trim();
    if (!ped) { sinPedido.push(s); continue; }
    const prev = porPedido.get(ped);
    porPedido.set(ped, prev ? albaranMasAlto([prev, s]) : s);
  }
  return [...porPedido.values(), ...sinPedido];
}

async function listarAlbaranesVenta(base, auth, filtro) {
  const busca = await fetchConReintento(
    `${base}/salesShipments?$filter=${encodeURIComponent(filtro)}&$select=id,number,externalDocumentNumber,orderNumber,postingDate&$top=50`,
    { headers: auth }
  );
  if (!busca.ok) {
    const detalle = await busca.text();
    return { ok: false, status: busca.status, detalle: detalle.slice(0, 400), lista: [] };
  }
  return { ok: true, lista: (await busca.json()).value || [] };
}

// PDF ya generado, unos minutos, para abrirlo con el nombre del albarán (101412-2026M.pdf).
const pdfAlbaranTemporal = new Map();
function guardarPdfAlbaranTemporal(nombre, base64) {
  const ahora = Date.now();
  for (const [id, item] of pdfAlbaranTemporal) {
    if (item.exp < ahora) pdfAlbaranTemporal.delete(id);
  }
  const id = require("crypto").randomBytes(12).toString("hex");
  const archivo = String(nombre || "albaran.pdf").replace(/[^\w.-]+/g, "_");
  pdfAlbaranTemporal.set(id, { buf: Buffer.from(base64, "base64"), nombre: archivo, exp: ahora + 5 * 60 * 1000 });
  return `/api/bc/albaran-venta-pdf/archivo/${id}/${encodeURIComponent(archivo)}`;
}

app.get("/api/bc/albaran-venta-pdf/archivo/:id/:nombre", (req, res) => {
  const item = pdfAlbaranTemporal.get(String(req.params.id || ""));
  if (!item || item.exp < Date.now()) {
    pdfAlbaranTemporal.delete(String(req.params.id || ""));
    return res.status(404).type("text/plain").send("El PDF ya no está disponible. Vuelve a abrirlo desde el pedido.");
  }
  const nombre = item.nombre || "albaran.pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${nombre}"; filename*=UTF-8''${encodeURIComponent(nombre)}`);
  res.send(item.buf);
});

app.get("/api/bc/albaran-venta-pdf", async (req, res) => {
  const externo = String(req.query.externo || "").trim();
  const pedido = String(req.query.pedido || "").trim();
  const numero = String(req.query.numero || "").trim();
  if (!externo && !pedido) return res.status(400).json({ error: "Falta el nº de documento externo o el pedido." });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const auth = { Authorization: `Bearer ${token}` };
    const mapa = new Map();
    const meter = (lista) => {
      for (const s of lista || []) if (s?.id && !mapa.has(s.id)) mapa.set(s.id, s);
    };
    if (externo) {
      const porExterno = await listarAlbaranesVenta(base, auth, `externalDocumentNumber eq '${externo.replace(/'/g, "''")}'`);
      if (!porExterno.ok && !pedido) {
        return res.status(502).json({ error: `BC respondió ${porExterno.status} buscando el albarán.`, detalle: porExterno.detalle });
      }
      if (porExterno.ok) meter(porExterno.lista);
    }
    if (pedido) {
      const porPedido = await listarAlbaranesVenta(base, auth, `orderNumber eq '${pedido.replace(/'/g, "''")}'`);
      if (!porPedido.ok && mapa.size === 0) {
        return res.status(502).json({ error: `BC respondió ${porPedido.status} buscando el albarán del pedido.`, detalle: porPedido.detalle });
      }
      if (porPedido.ok) meter(porPedido.lista);
    }
    let lista = [...mapa.values()];
    lista.sort((a, b) => String(b.postingDate || "").localeCompare(String(a.postingDate || "")));
    if (pedido) {
      const delPedido = lista.filter((s) => String(s.orderNumber || "") === pedido);
      if (delPedido.length) lista = delPedido;
    }
    if (numero) lista = lista.filter((s) => String(s.number || "") === numero);
    let avisoElegido = "";
    if (!numero && lista.length > 1) {
      const antes = lista.slice();
      lista = quedarAlbaranMasAltoPorPedido(lista);
      const quedan = new Set(lista.map((s) => s.id));
      const fuera = antes.filter((s) => !quedan.has(s.id)).map((s) => s.number).filter(Boolean);
      if (fuera.length === antes.length - lista.length && lista.length === 1) {
        const todos = [lista[0].number, ...fuera].filter(Boolean).sort();
        avisoElegido = `De este pedido había varios albaranes (${todos.join(", ")}). Se usa ${lista[0].number}, el de número más alto.`;
      }
    }
    if (!lista.length) {
      return res.status(404).json({
        error: `No hay albarán de venta con documento externo ${externo}${pedido ? ` del pedido ${pedido}` : ""} en el histórico de Business Central.`,
      });
    }
    if (lista.length > 1 && !numero) {
      return res.json({
        varios: lista.map((s) => ({
          numero: s.number,
          pedido: s.orderNumber || "",
          externo: s.externalDocumentNumber || externo,
          fecha: s.postingDate || "",
        })),
      });
    }
    const shipment = lista[0];
    const raiz = `${base}/salesShipments(${shipment.id})/pdfDocument`;
    let ultimo = null;
    for (const accept of ["application/pdf", "application/octet-stream"]) {
      const got = await leerPdfBC(`${raiz}/pdfDocumentContent`, { ...auth, Accept: accept });
      if (got.ok) {
        const docAlbaran = String(shipment.externalDocumentNumber || "").trim();
        const candidatosParte = [];
        for (const c of [externo, docAlbaran]) {
          const t = String(c || "").trim();
          if (t && !candidatosParte.includes(t)) candidatosParte.push(t);
        }
        const docExterno = docAlbaran || externo;
        let base64 = got.base64;
        let parte = "";
        let aviso = [
          avisoElegido,
          docAlbaran && externo && docAlbaran !== externo
            ? `El albarán ${shipment.number} figura en BC con el documento externo ${docAlbaran}. El pedido tiene ${externo}.`
            : "",
        ].filter(Boolean).join(" ");
        let paginas = null;
        let material = null;
        try {
          let bajado = { ok: false, aviso: "" };
          for (const c of candidatosParte) {
            bajado = await descargarParteAlso(c);
            if (bajado.ok) break;
          }
          if (bajado.ok && PDFDocument) {
            const unido = await unirAlbaranYParte(Buffer.from(got.base64, "base64"), bajado.buf);
            base64 = unido.buf.toString("base64");
            parte = bajado.codigo;
            paginas = unido.paginas;
            try {
              material = await require("./compararParteAlbaran.cjs").compararParteYAlbaran(Buffer.from(got.base64, "base64"), bajado.buf);
            } catch (errCmp) {
              aviso = aviso || `No se ha podido comparar el material. ${errCmp.message || ""}`.trim();
            }
          } else if (bajado.aviso) {
            aviso = [aviso, bajado.aviso].filter(Boolean).join(" ");
          } else if (bajado.ok && !PDFDocument) {
            aviso = [aviso, "No se ha podido unir el parte: falta pdf-lib. El PDF solo lleva el albarán."].filter(Boolean).join(" ");
          }
        } catch (errParte) {
          aviso = [aviso, `No se ha podido añadir el parte de trabajo. El PDF solo lleva el albarán. ${errParte.message || ""}`.trim()].filter(Boolean).join(" ");
        }
        const nombreBase = String(docExterno || shipment.number || externo || "albaran").trim().replace(/[^\w.-]+/g, "_");
        const nombre = `${nombreBase || "albaran"}.pdf`;
        const url = guardarPdfAlbaranTemporal(nombre, base64);
        return res.json({
          nombre,
          url,
          base64,
          mime: "application/pdf",
          albaran: shipment.number,
          pedido: shipment.orderNumber || pedido,
          externo: docExterno,
          parte: parte || null,
          paginas,
          aviso: aviso || null,
          material,
        });
      }
      ultimo = got;
    }
    return res.status(502).json({ error: ultimo?.error || "Business Central no ha devuelto el PDF del albarán.", detalle: ultimo?.detalle || "" });
  } catch (err) {
    res.status(500).json({ error: "No se pudo obtener el PDF del albarán.", detalle: String(err.message || err) });
  }
});

app.post("/api/bc/albaranes-por-pedido", async (req, res) => {
  const pedidos = [];
  const vistos = new Set();
  for (const item of Array.isArray(req.body?.pedidos) ? req.body.pedidos : []) {
    const n = String(item || "").trim();
    if (!n || vistos.has(n)) continue;
    vistos.add(n);
    pedidos.push(n);
    if (pedidos.length >= 40) break;
  }
  if (!pedidos.length) return res.json({ albaranes: {} });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const auth = { Authorization: `Bearer ${token}` };
    const albaranes = {};
    const lote = 5;
    for (let i = 0; i < pedidos.length; i += lote) {
      const grupo = pedidos.slice(i, i + lote);
      const listas = await Promise.all(grupo.map(async (pedido) => {
        const r = await listarAlbaranesVenta(base, auth, `orderNumber eq '${pedido.replace(/'/g, "''")}'`);
        if (!r.ok) return { pedido, error: r.detalle || `BC ${r.status}` };
        const s = albaranMasAlto(r.lista || []);
        return {
          pedido,
          ref: s ? {
            externo: String(s.externalDocumentNumber || "").trim(),
            albaran: s.number || "",
            fecha: s.postingDate || "",
          } : null,
        };
      }));
      for (const item of listas) albaranes[item.pedido] = item.ref === undefined ? null : item.ref;
    }
    res.json({ albaranes });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron localizar los albaranes.", detalle: String(err.message || err) });
  }
});

app.post("/api/recepcion", async (req, res) => {
  try {
    const actual = await leerRecep();
    const body = req.body || {};
    const combinado = {
      revisados: { ...(actual.revisados || {}), ...(body.revisados || {}) },
      fechas: { ...(actual.fechas || {}), ...(body.fechas || {}) },
      reclamados: { ...(actual.reclamados || {}), ...(body.reclamados || {}) },
      emailsProveedor: { ...(actual.emailsProveedor || {}), ...(body.emailsProveedor || {}) },
      notas: actual.notas || {},
      registrados: actual.registrados || {},
      firmasAprendidas: actual.firmasAprendidas || {},
      recogedores: actual.recogedores || {},
    };
    for (const campo of ["revisados", "fechas", "reclamados", "emailsProveedor"]) {
      for (const k in body[campo] || {}) if (body[campo][k] === null) delete combinado[campo][k];
    }
    await escribirRecep(combinado);
    res.json({ guardado: true });
  } catch (err) {
    console.error("Error guardando recepción:", err);
    res.status(500).json({ error: "No se pudo guardar la recepción." });
  }
});

// BUSCADOR DE ARTÍCULOS en BC (API v2.0 /items, solo LECTURA)
app.get("/api/bc/articulos", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ articulos: [] });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/items`;
    const esc = (v) => v.replace(/'/g, "''");
    const cap = q.charAt(0).toUpperCase() + q.slice(1).toLowerCase();
    const variantes = [...new Set([q, q.toUpperCase(), q.toLowerCase(), cap])];
    const filtros = [`startswith(number,'${esc(q.toUpperCase())}')`, ...variantes.map((v) => `contains(displayName,'${esc(v)}')`)];
    const vistos = new Map();
    for (const f of filtros) {
      const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(f)}&$top=15&$select=id,number,displayName,baseUnitOfMeasureCode,unitCost,blocked`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      for (const it of (await r.json()).value || []) {
        if (!it.blocked && !vistos.has(it.number)) vistos.set(it.number, { numero: it.number, descripcion: it.displayName, ud: it.baseUnitOfMeasureCode || "", coste: it.unitCost ?? null });
      }
      if (vistos.size >= 25) break;
    }
    res.json({ articulos: [...vistos.values()].slice(0, 25) });
  } catch (err) {
    res.status(500).json({ error: "No se pudo buscar artículos en BC.", detalle: String(err.message || err) });
  }
});

const CARGOS_PROD_FIJOS = [
  { numero: "COMB", descripcion: "COMBUSTIBLE" },
  { numero: "CORTE", descripcion: "CORTE" },
  { numero: "DES", descripcion: "DESCUENTO" },
  { numero: "ELEC", descripcion: "CARGA ELECTRICA" },
  { numero: "MANIPULACION", descripcion: "MANIPULACION" },
  { numero: "REPARACIÓN", descripcion: "REPARACIÓN VEHÍCULO" },
  { numero: "REPFONDO", descripcion: "REPERCUSIÓN FONDO ECONÓMICO" },
  { numero: "SEGURO", descripcion: "SEGUROS" },
  { numero: "TASARES", descripcion: "TASA RESIDUOS" },
  { numero: "TRANSPORTE", descripcion: "TRANSPORTE" },
];
app.get("/api/bc/cargos", async (req, res) => {
  try {
    const token = await obtenerTokenBC();
    const h = { headers: { Authorization: `Bearer ${token}` } };
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}`;
    const candidatos = [
      `${raiz}/api/v2.0/companies(${EMPRESA_ID()})/itemCharges`,
      ...["Cargos_prod", "ItemCharges", "Item_Charges", "Cargos_producto"].map((n) => `${raiz}/ODataV4/Company('${empresa}')/${encodeURIComponent(n)}`),
    ];
    for (const url of candidatos) {
      try {
        const r = await fetchConReintento(url, h);
        if (!r.ok) continue;
        const v = (await r.json()).value || [];
        const lista = v
          .map((x) => ({ numero: x.number || x.No || x.no || "", descripcion: x.displayName || x.description || x.Description || "" }))
          .filter((x) => x.numero);
        if (lista.length) return res.json({ cargos: lista, origen: "bc" });
      } catch {}
    }
  } catch {}
  res.json({ cargos: CARGOS_PROD_FIJOS, origen: "fija" });
});

app.post("/api/recepcion/nota", async (req, res) => {
  const pedido = String(req.body?.pedido || "").trim();
  const texto = String(req.body?.texto || "").trim();
  const autor = String(req.body?.autor || "").trim() || "—";
  if (!pedido || !texto) return res.status(400).json({ error: "Falta 'pedido' o 'texto'." });
  try {
    const d = await leerRecep();
    d.notas = d.notas || {};
    const nota = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toISOString(), autor, texto: texto.slice(0, 2000) };
    d.notas[pedido] = [...(d.notas[pedido] || []), nota];
    await escribirRecep(d);
    res.json({ ok: true, notas: d.notas[pedido] });
  } catch (err) {
    console.error("Error guardando nota:", err);
    res.status(500).json({ error: "No se pudo guardar la nota." });
  }
});

app.post("/api/recepcion/nota/borrar", async (req, res) => {
  const pedido = String(req.body?.pedido || "").trim();
  const id = String(req.body?.id || "").trim();
  if (!pedido || !id) return res.status(400).json({ error: "Falta 'pedido' o 'id'." });
  try {
    const d = await leerRecep();
    d.notas = d.notas || {};
    d.notas[pedido] = (d.notas[pedido] || []).filter((n) => n.id !== id);
    if (!d.notas[pedido].length) delete d.notas[pedido];
    await escribirRecep(d);
    res.json({ ok: true, notas: d.notas[pedido] || [] });
  } catch (err) {
    res.status(500).json({ error: "No se pudo borrar la nota." });
  }
});

// ---------------------------------------------------------------------
// CHAT IA del EXPLORADOR DE OTs
// ---------------------------------------------------------------------
const HERRAMIENTAS_CHAT_OT = [
  {
    name: "preparar_borradores_pdf",
    description:
      "Genera el BORRADOR DE FACTURA / VALORACIÓN en PDF (plantilla oficial ALSO CASALS) de una o varias OTs: actualiza sus líneas de venta desde Business Central y descarga un PDF por OT. Úsala cuando pidan facturas, valoraciones, borradores o PDFs de OTs.",
    input_schema: {
      type: "object",
      properties: {
        ots: {
          type: "array",
          items: { type: "string" },
          description: "Números de OT tal como los ha escrito la usuaria (p.ej. \"15103\", \"AC015129/2026\"). Uno por OT, sin repetir.",
        },
      },
      required: ["ots"],
    },
  },
  {
    name: "preparar_correo_responsable",
    description:
      "Prepara un correo para el responsable de una OT (departamento de la OT) adjuntando la valoración / documento que la usuaria ha subido al chat. Úsala cuando pidan enviar, mandar o reenviar la valoración (u otro adjunto del chat) al responsable, jefe de obra, departamento, etc. Abre un borrador editable; no envía sola.",
    input_schema: {
      type: "object",
      properties: {
        ot: {
          type: "string",
          description: "Número de OT tal como lo ha escrito la usuaria (p.ej. \"15129\" o \"AC015129/2026\").",
        },
        instrucciones: {
          type: "string",
          description: "Notas opcionales de la usuaria para el cuerpo del correo (tono, qué pedir, etc.).",
        },
      },
      required: ["ot"],
    },
  },
];

app.post("/api/chat-ot", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en .env." });
  const mensajes = Array.isArray(req.body?.mensajes) ? req.body.mensajes : [];
  if (!mensajes.length) return res.status(400).json({ error: "Falta el mensaje." });
  const tieneAdjunto = !!req.body?.tieneAdjunto;
  const nombreAdjunto = req.body?.nombreAdjunto ? String(req.body.nombreAdjunto) : null;
  try {
    const r = await fetchConReintento("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 1500,
        system:
          "Eres el asistente del Explorador de OTs (órdenes de trabajo) de ALSO CASALS INSTAL·LACIONS, en Business Central. Respondes en castellano, breve y claro. " +
          "Si la usuaria pide facturas, valoraciones, borradores o PDFs de OTs (generarlos), llama a la herramienta preparar_borradores_pdf con TODOS los números de OT que haya escrito (aunque vengan uno por línea). " +
          "Si pide enviar / mandar / reenviar la valoración (u otro documento del chat) al responsable de la OT, llama a preparar_correo_responsable con esa OT. " +
          (tieneAdjunto
            ? `La usuaria ha adjuntado un fichero al chat${nombreAdjunto ? ` («${nombreAdjunto}»)` : ""}; úsalo como adjunto del correo cuando prepare el mensaje al responsable. `
            : "Si pide enviar un correo con valoración y no hay adjunto en el chat, dilo y pídele que adjunte el fichero (clip) antes de preparar el correo. ") +
          "No inventes datos de OTs: si te preguntan algo que no puedes hacer con tus herramientas, dilo y explica qué sí puedes hacer.",
        tools: HERRAMIENTAS_CHAT_OT,
        messages: mensajes.map((m) => ({ role: m.rol === "ia" ? "assistant" : "user", content: String(m.texto || "") })),
      }),
    });
    if (!r.ok) throw new Error(`API Claude respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const acciones = (data.content || []).filter((b) => b.type === "tool_use").map((b) => ({ tipo: b.name, datos: b.input || {} }));
    res.json({ texto, acciones });
  } catch (err) {
    console.error("Error /api/chat-ot:", err);
    res.status(500).json({ error: "Error hablando con la IA.", detalle: String(err.message || err) });
  }
});

function binarioChromium() {
  const fs = require("fs");
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const { execFileSync } = require("child_process");
  const which = process.platform === "win32" ? "where" : "which";
  for (const n of ["chromium", "chromium-browser", "google-chrome", "msedge"]) {
    try {
      const out = execFileSync(which, [n], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }
  return null;
}

function pdfsConChromium(bin, lista, salida) {
  const fs = require("fs");
  const { spawn } = require("child_process");
  fs.mkdirSync(salida, { recursive: true });
  const uno = (doc, headless) => new Promise((resolve) => {
    const destino = path.join(salida, doc.nombre);
    const archivo = doc.html.replace(/\\/g, "/");
    const args = [
      headless,
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--print-to-pdf=${destino}`,
      "--no-pdf-header-footer",
      `file://${archivo}`,
    ];
    let err = "";
    let proc;
    try { proc = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ ok: false, err: String(e) }); }
    proc.stderr.on("data", (b) => { err += b; });
    proc.on("error", (e) => resolve({ ok: false, err: String(e) }));
    proc.on("close", (code) => {
      const vale = code === 0 && fs.existsSync(destino) && fs.statSync(destino).size > 0;
      resolve({ ok: vale, err: vale ? "" : (err || `código ${code}`).slice(-400) });
    });
  });
  return (async () => {
    const resultado = { ok: [], errores: {} };
    for (const doc of lista) {
      let r = await uno(doc, "--headless=new");
      if (!r.ok) r = await uno(doc, "--headless");
      if (r.ok) resultado.ok.push(doc.nombre);
      else resultado.errores[doc.nombre] = r.err || "Chromium no generó el PDF.";
    }
    return resultado;
  })();
}

app.post("/api/borradores/pdf", async (req, res) => {
  const docs = Array.isArray(req.body?.docs) ? req.body.docs : [];
  if (!docs.length) return res.status(400).json({ error: "No hay borradores que convertir." });
  const fs = require("fs");
  const os = require("os");
  const { spawn } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "borradores-"));
  const hoy = new Date();
  const sello = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}_${String(hoy.getHours()).padStart(2, "0")}${String(hoy.getMinutes()).padStart(2, "0")}`;
  const salida = path.join(__dirname, "..", "borradores", sello);
  try {
    const lista = docs.map((d, i) => {
      const nombre = String(d.nombre || `borrador_${i + 1}`).replace(/[\\/:*?"<>|]+/g, "_").replace(/\.pdf$/i, "") + ".pdf";
      const rutaHtml = path.join(tmp, `${i}.html`);
      fs.writeFileSync(rutaHtml, String(d.html || ""), "utf8");
      return { nombre, html: rutaHtml };
    });
    const rutaTrabajo = path.join(tmp, "trabajo.json");
    fs.writeFileSync(rutaTrabajo, JSON.stringify({ salida, docs: lista }), "utf8");
    const binCromo = binarioChromium();
    let resultado;
    if (binCromo) {
      resultado = await pdfsConChromium(binCromo, lista, salida);
      if (!resultado.ok.length) {
        const detalle = Object.values(resultado.errores)[0] || "Chromium no generó el PDF.";
        throw new Error(detalle);
      }
    } else {
    const script = path.join(__dirname, "..", "bc_automation", "html_a_pdf.py");

    const candidatos = [process.env.PYTHON_CMD, "py", "python", "python3"].filter(Boolean);
    let salidaPy = null, ultimoErr = "";
    for (const cmd of candidatos) {
      const r = await new Promise((resolve) => {
        let out = "", err = "";
        let proc;
        try { proc = spawn(cmd, [script, rutaTrabajo], { windowsHide: true }); } catch (e) { return resolve({ code: -1, err: String(e) }); }
        proc.stdout.on("data", (b) => (out += b));
        proc.stderr.on("data", (b) => (err += b));
        proc.on("error", (e) => resolve({ code: -1, err: String(e) }));
        proc.on("close", (code) => resolve({ code, out, err }));
      });
      if (r.code === 0) { salidaPy = r.out; break; }
      ultimoErr = `${cmd}: ${(r.err || "").slice(-400)}`;
    }
    if (salidaPy === null) throw new Error(`No se pudo ejecutar html_a_pdf.py con Python (${ultimoErr}).`);
    resultado = JSON.parse(salidaPy.trim().split(/\r?\n/).pop());
    }
    const errores = resultado.errores || {};
    if (req.body?.formato === "base64") {
      const nombre = (resultado.ok || [])[0];
      if (!nombre) {
        const detalle = Object.entries(errores).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No se generó el PDF.";
        return res.status(500).json({ error: "No se pudo generar el borrador.", detalle });
      }
      const base64 = fs.readFileSync(path.join(salida, nombre)).toString("base64");
      return res.json({ nombre, base64, mime: "application/pdf" });
    }

    const JSZip = require("jszip");
    const zip = new JSZip();
    for (const n of resultado.ok || []) zip.file(n, fs.readFileSync(path.join(salida, n)));
    if (Object.keys(errores).length) zip.file("ERRORES.txt", Object.entries(errores).map(([k, v]) => `${k}: ${v}`).join("\r\n"));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    console.log(`[borradores/pdf] ${resultado.ok.length} PDF(s) → ${salida}${Object.keys(errores).length ? ` · ${Object.keys(errores).length} error(es)` : ""}`);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="borradores_${sello}.zip"`);
    res.setHeader("X-Borradores-Ok", String(resultado.ok.length));
    res.setHeader("X-Borradores-Errores", encodeURIComponent(JSON.stringify(errores)));
    res.setHeader("X-Borradores-Carpeta", encodeURIComponent(salida));
    res.send(buf);
  } catch (err) {
    console.error("Error /api/borradores/pdf:", err);
    res.status(500).json({ error: "No se pudieron generar los PDF.", detalle: String(err.message || err) });
  } finally {
    try { require("fs").rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------
// 0a-sexies) REDACTAR CORREO CON CLAUDE (Fase B) — puente a la API
// ---------------------------------------------------------------------
// El navegador NUNCA ve la API key: va en .env (ANTHROPIC_API_KEY).
// Recibe {modo, instrucciones, tono, idioma, original} y devuelve el texto.
// ---------------------------------------------------------------------
app.post("/api/redactar", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en .env." });
  }
  const { modo, instrucciones, tono, idioma, original } = req.body || {};
  try {
    const tonos = {
      formal: "formal i professional",
      cercano: "proper i cordial, però professional",
      breve: "molt breu i directe, al gra",
    };
    const tonoTxt = tonos[tono] || "professional i cordial";
    const idiomaTxt = idioma === "auto"
      ? "el MATEIX idioma del correu original (detecta'l tu)"
      : idioma === "ca" ? "català" : "castellà";

    let prompt;
    if (modo === "responder") {
      prompt = `Ets l'assistent de redacció de correus de Maria Rufí, de l'empresa ALSO CASALS INSTAL·LACIONS.
Redacta una RESPOSTA al següent correu. Escriu en ${idiomaTxt}. To: ${tonoTxt}.
${instrucciones ? `Indicacions de la Maria sobre què vol dir: ${instrucciones}` : "Respon de manera raonable segons el contingut del correu."}

CORREU ORIGINAL:
${original || "(sense contingut)"}

Retorna NOMÉS el text del correu de resposta (sense assumpte, sense explicacions, sense cometes). No afegeixis salutació final, nom ni avís legal: la signatura oficial s'afegeix sola.`;
    } else {
      prompt = `Ets l'assistent de redacció de correus de Maria Rufí, de l'empresa ALSO CASALS INSTAL·LACIONS.
Redacta un correu NOU. Escriu en ${idiomaTxt}. To: ${tonoTxt}.
Indicacions de la Maria sobre què vol dir: ${instrucciones || "(cap indicació concreta)"}

Retorna NOMÉS el text del correu (sense assumpte tret que sigui imprescindible, sense explicacions, sense cometes). No afegeixis salutació final, nom ni avís legal: la signatura oficial s'afegeix sola.`;
    }

    const r = await fetchConReintento("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`API Claude respondió ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ texto });
  } catch (err) {
    console.error("Error redactando con Claude:", err);
    res.status(500).json({ error: "Error redactant el correu.", detalle: String(err.message || err) });
  }
});

// Recomendación de respuesta al abrir un correo. Usa las fichas de OT de la
// app y, si responde a tiempo, la ficha de cliente o proveedor en BC.
let cacheFichasCorreo = { ts: 0, lista: [], pref: null };
function pistasDeCorreo(texto) {
  const t = String(texto || "");
  const unicos = (arr) => [...new Set(arr)];
  return {
    ots: unicos([...t.matchAll(/\b(?:AC|FCA)\d{4,7}\/\d{4}\b/gi)].map((m) => m[0].toUpperCase())),
    otsCortas: unicos([...t.matchAll(/\bOT\s*0*(\d{3,6})\b/gi)].map((m) => String(parseInt(m[1], 10)))),
    docs: unicos([...t.matchAll(/\b(?:PV|PC|PFV|OC|FV)\d{2}-\d{3,}\b/gi)].map((m) => m[0].toUpperCase())),
    arts: unicos([...t.matchAll(/\bPR\d{6,}\b/gi)].map((m) => m[0].toUpperCase())).slice(0, 12),
  };
}
function textoPlanoCorreo(cuerpo, tipo) {
  const s = tipo === "html" ? String(cuerpo || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ") : String(cuerpo || "");
  return s.replace(/\s+/g, " ").trim().slice(0, 6000);
}
function resumenFichaCorreo(f) {
  const origen = f?.numeroOTOrigenes || {};
  const linea = (l) => ({
    codigo: l?.numero || l?.codigo || "",
    descripcion: String(l?.descripcion || "").slice(0, 80),
    cantidad: l?.cantidad ?? null,
    importe: l?.importe ?? null,
  });
  return {
    ot: origen.listadoOTs || origen.listado || f?.numeroOT || "",
    numero: f?.numeroOT || "",
    cliente: f?.general?.cliente || "",
    descripcion: f?.general?.descripcion || "",
    departamento: f?.general?.departamento || "",
    estado: f?.general?.estadoApp || f?.general?.estado || "",
    venta: f?.resumenOT?.pVenta ?? f?.venta?.importeTotalFacturado ?? null,
    coste: f?.resumenOT?.pDespesa ?? f?.compra?.costeRealOT ?? null,
    horas: f?.resumenOT?.numeroHoras ?? null,
    materiales: (f?.venta?.materiales?.lineas || []).slice(0, 6).map(linea),
    compras: (f?.compra?.comprasReales?.lineas || []).slice(0, 6).map(linea),
  };
}
async function fichasParaCorreo() {
  const pref = claveEmpresa("estado");
  if (cacheFichasCorreo.pref === pref && Date.now() - cacheFichasCorreo.ts < 120000) {
    return cacheFichasCorreo.lista;
  }
  const raw = await db.getDoc(`${pref}.fichas`, []);
  const lista = (Array.isArray(raw) ? raw : []).map((par) => (Array.isArray(par) ? par[1] : par)).filter(Boolean);
  cacheFichasCorreo = { ts: Date.now(), lista, pref };
  return lista;
}
async function bcPorEmail(email) {
  const limpio = String(email || "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(limpio)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const token = await obtenerTokenBC();
    const esc = limpio.replace(/'/g, "''");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const pedir = async (entidad) => {
      const r = await fetch(`${raiz}/${entidad}?$select=number,displayName,email,city,phoneNumber&$filter=${encodeURIComponent(`email eq '${esc}'`)}&$top=1`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!r.ok) return null;
      return ((await r.json()).value || [])[0] || null;
    };
    const cliente = await pedir("customers");
    if (cliente) return { tipo: "cliente", numero: cliente.number, nombre: cliente.displayName, email: cliente.email, ciudad: cliente.city || "", telefono: cliente.phoneNumber || "" };
    const proveedor = await pedir("vendors");
    if (proveedor) return { tipo: "proveedor", numero: proveedor.number, nombre: proveedor.displayName, email: proveedor.email, ciudad: proveedor.city || "", telefono: proveedor.phoneNumber || "" };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function claveRecomendaciones(req) {
  const quien = String(req.usuario?.id || req.usuario?.username || "anon").replace(/[^\w.-]/g, "_");
  return "correo.recomendaciones." + quien;
}
async function recomendacionGuardada(req, idMsg) {
  if (!idMsg) return null;
  const mapa = await db.getDoc(claveRecomendaciones(req), {});
  const item = mapa && typeof mapa === "object" ? mapa[idMsg] : null;
  return item && item.recomendacion ? item : null;
}
async function guardarRecomendacion(req, idMsg, item) {
  if (!idMsg) return;
  const mapa = await db.getDoc(claveRecomendaciones(req), {});
  const base = mapa && typeof mapa === "object" && !Array.isArray(mapa) ? mapa : {};
  base[idMsg] = { ...item, ts: Date.now() };
  const claves = Object.keys(base).sort((a, b) => (base[a]?.ts || 0) - (base[b]?.ts || 0));
  while (claves.length > 200) delete base[claves.shift()];
  await db.setDoc(claveRecomendaciones(req), base);
}
app.post("/api/correo/recomendacion", async (req, res) => {
  const cuerpo = req.body || {};
  const idMsg = String(cuerpo.id || "").slice(0, 400);
  try {
    const previa = await recomendacionGuardada(req, idMsg);
    if (previa && typeof previa.queHacer === "string") return res.json(previa);
  } catch (err) {
    console.error("Error leyendo recomendación guardada:", err);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en .env." });
  }
  const plano = textoPlanoCorreo(cuerpo.cuerpo, cuerpo.tipoCuerpo);
  const pistas = pistasDeCorreo(`${cuerpo.asunto || ""}\n${plano}\n${cuerpo.deNombre || ""} ${cuerpo.de || ""}`);
  try {
    const fichas = await fichasParaCorreo();
    const deNombre = String(cuerpo.deNombre || "").toLowerCase();
    const coinciden = [];
    for (const f of fichas) {
      if (coinciden.length >= 4) break;
      const otTxt = String(f?.numeroOTOrigenes?.listadoOTs || f?.numeroOTOrigenes?.listado || f?.numeroOT || "").toUpperCase();
      const num = String(f?.numeroOT || "");
      const cli = String(f?.general?.cliente || "").toLowerCase();
      const porOt = pistas.ots.some((x) => otTxt.includes(x)) || pistas.otsCortas.some((n) => num === n || otTxt.includes(`/${n}`) || otTxt.includes(n));
      const porCliente = cli.length > 5 && deNombre.includes(cli.slice(0, Math.min(cli.length, 18)));
      if (porOt || porCliente) coinciden.push(resumenFichaCorreo(f));
    }
    const fichaBc = await bcPorEmail(cuerpo.de);
    let reglas = [];
    try {
      const lista = await db.getDoc("reglas_ia", []);
      reglas = (Array.isArray(lista) ? lista : []).slice(-8).map((r) => String(r.texto || "").slice(0, 240)).filter(Boolean);
    } catch { /* las reglas son un extra */ }
    const nombre = req.usuario?.nom_treballador || req.usuario?.nombre || "Maria Rufí";
    const empresaRemitente = empresaGrupoDesdeEmail(cuerpo.de);
    const contexto = {
      remitente: { nombre: cuerpo.deNombre || "", email: cuerpo.de || "", empresaGrupo: empresaRemitente || null },
      fichaBC: fichaBc,
      otsEnLaApp: coinciden,
      referenciasEnElCorreo: pistas,
      reglasAprendidas: reglas,
    };
    const prompt = `Ets l'assistent de correu d'ALSO CASALS. La ${nombre} ha obert un correu i necessita una recomanació per respondre'l.
Fes servir NOMÉS les dades del context. No inventis preus, dates, estats ni números que no hi surtin. Si falta una dada, digues-ho i proposa preguntar-la.
Respon en l'idioma del correu original.

EMPRESES DEL GRUP (imprescindible):
- Qualsevol correu de @ferrosca.com (p.ex. sergio.subirats@ferrosca.com) és de l'empresa FerrosCA a Business Central.
- @alsocasals.com → Also Casals. Dominis Quimlab → Quimlab.
- Si el remitent és FerrosCA i diu que cal abonar i facturar a Also (OT mal creada / empresa equivocada): l'abonament de venda va a l'empresa FerrosCA i la factura nova va a l'empresa Also Casals. No confonguis «facturar a Also» amb posar Also Casals només com a client si el que cal és obrir el document a l'empresa Also Casals de BC.
- Cada acció ha de portar "empresa": "FerrosCA" | "Also Casals" | "Quimlab" (l'empresa de BC on s'obre el document).

CORREU
De: ${cuerpo.deNombre || ""} <${cuerpo.de || ""}>
Assumpte: ${cuerpo.asunto || ""}
${plano || "(sense text)"}

CONTEXT DE L'APP (JSON):
${JSON.stringify(contexto).slice(0, 12000)}

A més, descriu la FEINA a fer a Business Central, només si el correu ho demana amb claredat.
queHacer: 2 a 4 frases, en l'idioma del correu, del que ha de fer. Cita el número de factura, el client i l'empresa de BC si surten.
acciones: una entrada per document.
- tipo "abono": cal abonar una factura de venda ja emesa. factura = el número que surt al correu. cliente buit si és el mateix. empresa = empresa BC on hi ha la factura a abonar.
- tipo "factura": cal fer una factura de venda nova. Si s'ha de copiar una factura existent, posa el seu número a factura. Si el client és un altre, posa el nom a cliente. empresa = empresa BC on s'ha de crear la factura.
Si no cal cap document, acciones és []. No inventis números ni clients.

Retorna NOMÉS un JSON amb aquesta forma, sense markdown:
{"recomendacion":"2 o 3 frases: què ha de contestar i per què","apoyos":["dada concreta 1"],"queHacer":"què ha de fer a Business Central","acciones":[{"tipo":"abono","factura":"P26001450","cliente":"","empresa":"FerrosCA"},{"tipo":"factura","factura":"P26001450","cliente":"","empresa":"Also Casals"}],"borrador":"text del correu, sense salutació final, sense nom i sense avís legal: la signatura de ${nombre} s'afegeix sola"}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`API Claude respondió ${r.status}`);
    const data = await r.json();
    let texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    texto = texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(texto); }
    catch {
      const i = texto.indexOf("{");
      const j = texto.lastIndexOf("}");
      try { parsed = i >= 0 && j > i ? JSON.parse(texto.slice(i, j + 1)) : null; }
      catch { parsed = null; }
      if (!parsed) parsed = { recomendacion: texto, apoyos: [], borrador: "", queHacer: "", acciones: [] };
    }
    const acciones = (Array.isArray(parsed.acciones) ? parsed.acciones : []).map((a) => ({
      tipo: a?.tipo === "factura" ? "factura" : a?.tipo === "abono" ? "abono" : "",
      factura: String(a?.factura || "").trim().slice(0, 30),
      cliente: String(a?.cliente || "").trim().slice(0, 120),
      empresa: String(a?.empresa || "").trim().slice(0, 60),
    })).filter((a) => a.tipo && (a.factura || a.cliente || a.empresa)).slice(0, 6);
    const salida = {
      recomendacion: String(parsed.recomendacion || "").trim(),
      apoyos: Array.isArray(parsed.apoyos) ? parsed.apoyos.map((x) => String(x)).slice(0, 6) : [],
      queHacer: String(parsed.queHacer || "").trim(),
      acciones,
      borrador: String(parsed.borrador || "").trim(),
      fichas: coinciden.length,
      fichaBC: fichaBc ? `${fichaBc.tipo}: ${fichaBc.nombre}` : "",
    };
    try { await guardarRecomendacion(req, idMsg, salida); } catch (err) {
      console.error("Error guardando recomendación:", err);
    }
    res.json(salida);
  } catch (err) {
    console.error("Error recomendando respuesta:", err);
    res.status(500).json({ error: "No he podido preparar la recomendación.", detalle: String(err.message || err) });
  }
});

// Prepara un borrador de abono o de factura de venta y devuelve el enlace
// para abrirlo en BC. No lo registra: no se llama a Microsoft.NAV.post.
function urlDocumentoBC(pagina, numero) {
  const empresa = EMPRESA_NOMBRE();
  const filtro = `'No.' IS '${String(numero).replace(/'/g, "''")}'`;
  return `https://businesscentral.dynamics.com/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/?company=${encodeURIComponent(empresa)}&page=${pagina}&filter=${encodeURIComponent(filtro)}`;
}
async function bcPedir(url, token, method, body) {
  const r = await fetchConReintento(url, {
    method: method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 1);
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
  return { ok: r.ok, status: r.status, json, texto };
}
function textoErrorBC(r) {
  return r.json?.error?.message || String(r.texto || "").slice(0, 300) || `BC respondió ${r.status}`;
}
function eurosEs(n) {
  const [entero, dec] = Number(n).toFixed(2).split(".");
  return entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + dec + " €";
}
// En Also Casals el código del cliente es el NIF, sin guiones. taxRegistrationNumber no se puede filtrar.
function codigosClienteEnTexto(texto) {
  const tokens = String(texto || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const candidatos = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const siguiente = tokens[i + 1] || "";
    if (/^(?:[0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z]|[A-Z][0-9]{7}[0-9A-Z])$/.test(t)) candidatos.push(t);
    else if (/^[0-9]{8}$/.test(t) && /^[A-Z]$/.test(siguiente)) candidatos.push(t + siguiente);
    else if (/^[XYZ][0-9]{7}$/.test(t) && /^[A-Z]$/.test(siguiente)) candidatos.push(t + siguiente);
    else if (/^[A-Z][0-9]{7}$/.test(t) && /^[0-9A-Z]$/.test(siguiente)) candidatos.push(t + siguiente);
  }
  return [...new Set(candidatos)];
}
async function elegirClienteBC(base, token, clienteNombre, pista) {
  const nombre = String(clienteNombre || "").trim();
  const pistaTxt = String(pista || "").trim().slice(0, 160);
  const codigos = codigosClienteEnTexto(pistaTxt);
  for (const codigo of codigos) {
    const esc = codigo.replace(/'/g, "''");
    const r = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$select=number,displayName&$top=1`, token);
    if (!r.ok) return { error: "No he podido buscar el cliente.", detalle: textoErrorBC(r), status: 502 };
    const uno = (r.json?.value || [])[0];
    if (uno) return { elegido: uno };
  }
  const pistaCodigo = pistaTxt && !/\s/.test(pistaTxt) ? pistaTxt.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (pistaCodigo && pistaCodigo.length >= 3 && pistaCodigo.length <= 20 && !codigos.includes(pistaCodigo)) {
    const esc = pistaCodigo.replace(/'/g, "''");
    const r = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$select=number,displayName&$top=1`, token);
    if (!r.ok) return { error: "No he podido buscar el cliente.", detalle: textoErrorBC(r), status: 502 };
    const uno = (r.json?.value || [])[0];
    if (uno) return { elegido: uno };
    return { error: `No encuentro ningún cliente con el código ${pistaCodigo} en ${EMPRESA_NOMBRE()}.`, status: 409 };
  }
  if (codigos.length) {
    return { error: `No encuentro ningún cliente con el DNI ${codigos[0]} en ${EMPRESA_NOMBRE()}.`, status: 409 };
  }
  const nombreBusqueda = pistaTxt || nombre;
  if (!nombreBusqueda) return { elegido: null };
  const trozo = nombreBusqueda.replace(/'/g, "''").slice(0, 40);
  const cli = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`contains(displayName,'${trozo}')`)}&$select=number,displayName&$top=8`, token);
  if (!cli.ok) return { error: "No he podido buscar el cliente.", detalle: textoErrorBC(cli), status: 502 };
  const lista = cli.json?.value || [];
  const exacto = lista.find((c) => String(c.displayName || "").toLowerCase() === nombreBusqueda.toLowerCase());
  const elegido = exacto || (lista.length === 1 ? lista[0] : null);
  if (!elegido) {
    const nombres = lista.map((c) => c.displayName).filter(Boolean).slice(0, 5).join(", ");
    return {
      error: nombres ? `Hay varios clientes parecidos a «${nombreBusqueda}»: ${nombres}.` : `No encuentro el cliente «${nombreBusqueda}» en ${EMPRESA_NOMBRE()}.`,
      status: 409,
    };
  }
  return { elegido };
}
app.post("/api/correo/chat-rec", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en .env." });
  }
  const cuerpo = req.body || {};
  const mensaje = String(cuerpo.mensaje || "").trim().slice(0, 1200);
  if (!mensaje) return res.status(400).json({ error: "Falta el missatge." });
  const correo = cuerpo.correo || {};
  const rec = cuerpo.recomendacion || {};
  const historial = Array.isArray(cuerpo.historial) ? cuerpo.historial.slice(-8) : [];
  const nombre = req.usuario?.nom_treballador || req.usuario?.nombre || "Maria Rufí";
  const plano = textoPlanoCorreo(correo.cuerpo, correo.tipoCuerpo);
  try {
    const historialTxt = historial.map((m) => {
      const qui = m?.rol === "yo" ? nombre : "Assistent";
      return `${qui}: ${String(m?.texto || "").slice(0, 600)}`;
    }).join("\n");
    const prompt = `Ets l'assistent de correu d'ALSO CASALS dins la pantalla «Recomanació de resposta».
La ${nombre} et parla sobre el correu obert. Pots:
- Explicar què pots fer (respondre, millorar borrador, preparar albarà de venda, crear tasca, obrir abonament/factura a BC si escau).
- Millorar o reescriure el borrador de resposta.
- Ajustar queHacer / acciones de Business Central si el correu ho demana amb claredat.
No inventis números, clients ni empreses. Respon en l'idioma del missatge de la Maria (o del correu si no queda clar).

CORREU
De: ${correo.deNombre || ""} <${correo.de || ""}>
Assumpte: ${correo.asunto || ""}
${plano || "(sense text)"}

RECOMANACIÓ ACTUAL (JSON):
${JSON.stringify({
  recomendacion: rec.recomendacion || "",
  queHacer: rec.queHacer || "",
  acciones: rec.acciones || [],
  apoyos: rec.apoyos || [],
  borrador: rec.borrador || "",
}).slice(0, 8000)}

HISTORIAL RECENT:
${historialTxt || "(buit)"}

MISSATGE NOU DE ${nombre}:
${mensaje}

Retorna NOMÉS un JSON, sense markdown:
{"respuesta":"resposta curta al xat (1-4 frases)","recomendacion":null,"queHacer":null,"acciones":null,"apoyos":null,"borrador":null}
- respuesta: sempre.
- borrador: només si cal actualitzar el text de resposta (sense salutació final ni avís legal).
- recomendacion / queHacer / acciones / apoyos: només si cal actualitzar-los; si no, null.
- acciones: mateix format que la recomanació (tipo abono|factura, factura, cliente, empresa).`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 1800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`API Claude respondió ${r.status}`);
    const data = await r.json();
    let texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    texto = texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(texto); }
    catch {
      const i = texto.indexOf("{");
      const j = texto.lastIndexOf("}");
      try { parsed = i >= 0 && j > i ? JSON.parse(texto.slice(i, j + 1)) : null; }
      catch { parsed = null; }
      if (!parsed) parsed = { respuesta: texto };
    }
    const acciones = Array.isArray(parsed.acciones)
      ? parsed.acciones.map((a) => ({
          tipo: a?.tipo === "factura" ? "factura" : a?.tipo === "abono" ? "abono" : "",
          factura: String(a?.factura || "").trim().slice(0, 30),
          cliente: String(a?.cliente || "").trim().slice(0, 120),
          empresa: String(a?.empresa || "").trim().slice(0, 60),
        })).filter((a) => a.tipo && (a.factura || a.cliente || a.empresa)).slice(0, 6)
      : null;
    res.json({
      respuesta: String(parsed.respuesta || "").trim() || "D'acord.",
      recomendacion: parsed.recomendacion != null ? String(parsed.recomendacion).trim() : null,
      queHacer: parsed.queHacer != null ? String(parsed.queHacer).trim() : null,
      apoyos: Array.isArray(parsed.apoyos) ? parsed.apoyos.map((x) => String(x)).slice(0, 8) : null,
      acciones,
      borrador: parsed.borrador != null ? String(parsed.borrador).trim() : null,
    });
  } catch (err) {
    console.error("Error chat-rec correo:", err);
    res.status(500).json({ error: "No he podido responder al chat.", detalle: String(err.message || err) });
  }
});

app.post("/api/correo/accion-bc", async (req, res) => {
  const tipo = req.body?.tipo === "factura" ? "factura" : req.body?.tipo === "abono" ? "abono" : "";
  const factura = String(req.body?.factura || "").trim();
  const clienteNombre = String(req.body?.cliente || "").trim();
  const pista = String(req.body?.pista || "").trim();
  const empresaTxt = String(req.body?.empresa || "").trim();
  if (!tipo) return res.status(400).json({ error: "No sé si es un abono o una factura." });
  if (factura && !/^[A-Za-z0-9][A-Za-z0-9./-]{2,24}$/.test(factura)) {
    return res.status(400).json({ error: "El número de factura no es válido." });
  }
  let empCtx = null;
  if (empresaTxt) {
    const hallada = await resolverEmpresaAccion(empresaTxt);
    if (!hallada) return res.status(400).json({ error: `No reconozco la empresa «${empresaTxt}».` });
    empCtx = { id: hallada.id, nombre: hallada.nombre, porDefecto: !!hallada.porDefecto };
  }
  const ejecutar = async () => {
    try {
      const token = await obtenerTokenBC();
      const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
      let origen = null;
      if (factura) {
        const esc = factura.replace(/'/g, "''");
        const busca = await bcPedir(`${base}/salesInvoices?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$top=1`, token);
        if (!busca.ok) return res.status(502).json({ error: "No he podido buscar la factura.", detalle: textoErrorBC(busca) });
        origen = (busca.json?.value || [])[0] || null;
        if (!origen) return res.status(404).json({ error: `No encuentro la factura ${factura} en ${EMPRESA_NOMBRE()}.` });
      }
      let customerNumber = origen?.customerNumber || "";
      let clienteElegido = null;
      if (clienteNombre || (pista && !customerNumber)) {
        const hallado = await elegirClienteBC(base, token, clienteNombre, pista);
        if (hallado.error) return res.status(hallado.status || 409).json({ error: hallado.error, detalle: hallado.detalle });
        if (hallado.elegido) {
          clienteElegido = hallado.elegido;
          customerNumber = hallado.elegido.number;
        }
      }
      if (!customerNumber) return res.status(400).json({ error: "Falta el cliente del documento." });

      const coleccion = tipo === "abono" ? "salesCreditMemos" : "salesInvoices";
      const alta = await bcPedir(`${base}/${coleccion}`, token, "POST", {
        customerNumber,
        ...(factura ? { externalDocumentNumber: factura } : {}),
      });
      if (!alta.ok) return res.status(502).json({ error: tipo === "abono" ? "No he podido crear el abono." : "No he podido crear la factura.", detalle: textoErrorBC(alta) });
      const doc = alta.json || {};
      const avisos = [];
      if (origen?.id) {
        const lin = await bcPedir(`${base}/salesInvoices(${origen.id})/salesInvoiceLines`, token);
        const lineas = lin.ok ? (lin.json?.value || []) : [];
        if (!lin.ok) avisos.push("No he podido leer las líneas de la factura original.");
        const destino = tipo === "abono" ? "salesCreditMemoLines" : "salesInvoiceLines";
        for (const l of lineas.slice(0, 40)) {
          const tipoLinea = String(l.lineType || "");
          if (!tipoLinea || tipoLinea === " ") continue;
          const cuerpoLinea = { lineType: tipoLinea, description: String(l.description || "").slice(0, 100) };
          if (tipoLinea !== "Comment") {
            if (!l.lineObjectNumber) continue;
            cuerpoLinea.lineObjectNumber = l.lineObjectNumber;
            if (l.quantity) cuerpoLinea.quantity = l.quantity;
            if (l.unitPrice != null) cuerpoLinea.unitPrice = l.unitPrice;
            if (l.discountPercent) cuerpoLinea.discountPercent = l.discountPercent;
          }
          const creada = await bcPedir(`${base}/${coleccion}(${doc.id})/${destino}`, token, "POST", cuerpoLinea);
          if (!creada.ok) avisos.push(`${l.lineObjectNumber || l.description || "línea"}: ${textoErrorBC(creada)}`);
        }
        const ots = await otsDeFacturaRegistrada(base, token, origen.id);
        if (!ots.ot) avisos.push("La factura original no tiene nº de OT, así que el documento nuevo tampoco.");
        else if (doc.number) {
          const malOt = await escribirOtDocumentoVenta(token, tipo, doc.number, ots.ot, ots.porLinea);
          if (malOt) avisos.push(malOt);
        }
      }
      let avisoImporte = "";
      let importeOk = false;
      const nombreDoc = tipo === "abono" ? "La nota de abono" : "La factura nueva";
      if (origen && doc.id) {
        const recien = await bcPedir(`${base}/${coleccion}(${doc.id})?$select=totalAmountExcludingTax`, token);
        const nuevo = Number(recien.json?.totalAmountExcludingTax);
        const original = Number(origen.totalAmountExcludingTax);
        if (recien.ok && Number.isFinite(nuevo) && Number.isFinite(original)) {
          if (Math.abs(nuevo - original) > 0.009) {
            avisoImporte = `${nombreDoc} tiene un importe distinto al de la factura ${origen.number || factura}: ${eurosEs(nuevo)} sin IVA frente a ${eurosEs(original)}.`;
          } else {
            importeOk = true;
            avisoImporte = `${nombreDoc} está hecha. El importe coincide con la factura ${origen.number || factura}: ${eurosEs(original)} sin IVA.`;
          }
        }
      }
      if (!avisoImporte && doc.number) {
        importeOk = true;
        avisoImporte = `${nombreDoc} ${doc.number} está hecha. La registras tú.`;
      }
      const pagina = tipo === "abono" ? 44 : 43;
      res.json({
        ok: true,
        tipo,
        empresa: EMPRESA_NOMBRE(),
        numero: doc.number || "",
        enlace: doc.number ? urlDocumentoBC(pagina, doc.number) : "",
        cliente: clienteElegido?.displayName || "",
        clienteNumero: clienteElegido?.number || customerNumber || "",
        avisoImporte,
        importeOk,
        avisos: avisos.slice(0, 5),
      });
    } catch (err) {
      console.error("Error preparando documento de venta:", err);
      res.status(500).json({ error: "No he podido preparar el documento.", detalle: String(err.message || err) });
    }
  };
  if (empCtx) await contextoEmpresa.run(empCtx, ejecutar);
  else await ejecutar();
});

// Borrador de factura de venta VACÍO, desde la ficha de la OT.
// No copia líneas y no se registra: Maria trae las del albarán en BC
// («Traer líneas alb. venta») y registra ella.
app.post("/api/bc/factura-venta-borrador", async (req, res) => {
  const clienteNumero = String(req.body?.clienteNumero || "").trim();
  const clienteNombre = String(req.body?.cliente || "").trim();
  const ot = String(req.body?.ot || "").trim();
  if (!clienteNumero && !clienteNombre) return res.status(400).json({ error: "Falta el cliente de la OT." });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    let customerNumber = clienteNumero;
    let clienteElegido = null;
    if (customerNumber) {
      const esc = customerNumber.replace(/'/g, "''");
      const busca = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$select=number,displayName&$top=1`, token);
      if (!busca.ok) return res.status(502).json({ error: "No he podido buscar el cliente.", detalle: textoErrorBC(busca) });
      const uno = (busca.json?.value || [])[0];
      if (!uno) return res.status(409).json({ error: `No encuentro el cliente ${customerNumber} en ${EMPRESA_NOMBRE()}.` });
      clienteElegido = uno;
      customerNumber = uno.number;
    } else {
      const hallado = await elegirClienteBC(base, token, clienteNombre, "");
      if (hallado.error) return res.status(hallado.status || 409).json({ error: hallado.error, detalle: hallado.detalle });
      if (!hallado.elegido) return res.status(400).json({ error: "Falta el cliente de la OT." });
      clienteElegido = hallado.elegido;
      customerNumber = hallado.elegido.number;
    }
    const alta = await bcPedir(`${base}/salesInvoices`, token, "POST", { customerNumber });
    if (!alta.ok) return res.status(502).json({ error: "No he podido crear la factura.", detalle: textoErrorBC(alta) });
    const doc = alta.json || {};
    const avisos = [];
    if (ot && doc.number) {
      const malOt = await escribirOtDocumentoVenta(token, "factura", doc.number, ot, []);
      if (malOt) avisos.push(malOt);
    } else if (!ot) {
      avisos.push("La OT no tiene código, así que la factura queda sin Cód. OT.");
    }
    res.json({
      ok: true,
      numero: doc.number || "",
      enlace: doc.number ? urlDocumentoBC(43, doc.number) : "",
      cliente: clienteElegido?.displayName || "",
      clienteNumero: customerNumber,
      avisos: avisos.slice(0, 5),
    });
  } catch (err) {
    console.error("Error creando borrador de factura de venta:", err);
    res.status(500).json({ error: "No he podido crear la factura.", detalle: String(err.message || err) });
  }
});

// Vista previa, solo lectura: no crea ni registra nada en BC.
app.post("/api/correo/vista-previa", async (req, res) => {
  const acciones = (Array.isArray(req.body?.acciones) ? req.body.acciones : []).slice(0, 6);
  if (!acciones.length) return res.json({ documentos: [] });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const documentos = [];
    for (const a of acciones) {
      const tipo = a?.tipo === "factura" ? "factura" : a?.tipo === "abono" ? "abono" : "";
      const factura = String(a?.factura || "").trim();
      const clienteNombre = String(a?.cliente || "").trim();
      if (!tipo) continue;
      const doc = {
        tipo,
        titulo: tipo === "abono" ? "Abonament de venda" : "Factura de venda",
        origen: factura,
        cliente: clienteNombre,
        clienteNumero: "",
        lineas: [],
        total: 0,
        aviso: "",
      };
      if (factura && !/^[A-Za-z0-9][A-Za-z0-9./-]{2,24}$/.test(factura)) {
        doc.aviso = "El número de factura no es válido.";
        documentos.push(doc);
        continue;
      }
      let origen = null;
      if (factura) {
        const esc = factura.replace(/'/g, "''");
        const busca = await bcPedir(`${base}/salesInvoices?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$select=id,number,customerNumber,customerName,totalAmountExcludingTax&$top=1`, token);
        if (!busca.ok) { doc.aviso = "No he podido leer la factura."; documentos.push(doc); continue; }
        origen = (busca.json?.value || [])[0] || null;
        if (!origen) { doc.aviso = `No encuentro la factura ${factura} en ${EMPRESA_NOMBRE()}.`; documentos.push(doc); continue; }
        if (!clienteNombre) { doc.cliente = origen.customerName || ""; doc.clienteNumero = origen.customerNumber || ""; }
      }
      if (clienteNombre) {
        const trozo = clienteNombre.replace(/'/g, "''").slice(0, 40);
        const cli = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`contains(displayName,'${trozo}')`)}&$select=number,displayName&$top=8`, token);
        const lista = cli.ok ? (cli.json?.value || []) : [];
        const exacto = lista.find((c) => String(c.displayName || "").toLowerCase() === clienteNombre.toLowerCase());
        const elegido = exacto || (lista.length === 1 ? lista[0] : null);
        if (elegido) { doc.cliente = elegido.displayName; doc.clienteNumero = elegido.number; }
        else doc.aviso = lista.length ? `Hay varios clientes parecidos a «${clienteNombre}».` : `No encuentro el cliente «${clienteNombre}».`;
      }
      if (origen?.id) {
        let lin = await bcPedir(`${base}/salesInvoices(${origen.id})/salesInvoiceLines?$select=lineType,description,quantity,unitPrice,netAmount`, token);
        if (!lin.ok) lin = await bcPedir(`${base}/salesInvoices(${origen.id})/salesInvoiceLines`, token);
        const lineas = lin.ok ? (lin.json?.value || []) : [];
        doc.lineas = lineas.slice(0, 40).filter((l) => l.description || l.quantity).map((l) => {
          const importe = Number(l.netAmount);
          const cantidad = Number(l.quantity) || 0;
          const precio = Number(l.unitPrice) || 0;
          return {
            descripcion: String(l.description || "").slice(0, 120),
            cantidad,
            precio,
            importe: Number.isFinite(importe) && importe !== 0 ? importe : Math.round(cantidad * precio * 100) / 100,
            comentario: String(l.lineType || "") === "Comment",
          };
        });
        doc.total = Math.round(doc.lineas.reduce((s, l) => s + (l.comentario ? 0 : Number(l.importe) || 0), 0) * 100) / 100;
      }
      documentos.push(doc);
    }
    res.json({ documentos });
  } catch (err) {
    console.error("Error en la vista previa:", err);
    res.status(500).json({ error: "No he podido preparar la vista previa.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 0a-quinquies) BANDEJA + ENVÍO — buzón del usuario logueado (AChuman)
// ---------------------------------------------------------------------
// Remitente = email_empresa del colaborador en AChuman (sesión).
// Ya no se usa un buzón fijo (Maria). Fallback: email local/ERP @alsocasals.
// ---------------------------------------------------------------------
const { resolverEmailEnvio } = require("./achuman-client");

async function buzonDelUsuario(req, res) {
  const r = await resolverEmailEnvio(req.usuario || {});
  const buzon = r.email || null;
  if (!buzon) {
    res.status(400).json({
      error: r.error
        || "No tienes correo de empresa en AChuman. Configúralo en achuman.alsocasals.com (email empresa) para poder usar el correo.",
    });
    return null;
  }
  return buzon;
}

app.get("/api/correo/remitente", async (req, res) => {
  try {
    const r = await resolverEmailEnvio(req.usuario || {});
    res.json({
      email: r.email || null,
      origen: r.origen || null,
      username: req.usuario?.username || null,
      nombre: req.usuario?.nom_treballador || req.usuario?.nombre || null,
      error: r.email ? null : (r.error || "Sin email de empresa en AChuman"),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/buzon/mensajes", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  const carpeta = req.query.carpeta === "enviados" ? "sentitems" : "inbox";
  const buscar = (req.query.q || "").toString().trim();
  const desde = "2025-10-09T00:00:00Z";
  try {
    const buzon = await buzonDelUsuario(req, res);
    if (!buzon) return;
    const token = await obtenerTokenGraph();
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/${carpeta}/messages`;
    const sel = "$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview";
    const filtro = encodeURIComponent(`receivedDateTime ge ${desde}`);
    let url = `${base}?${sel}&$top=100&$orderby=receivedDateTime desc&$filter=${filtro}&$count=true`;
    if (buscar) url = `${base}?${sel}&$top=50&$search="${encodeURIComponent(buscar)}"`;
    const mensajes = [];
    const vistos = new Set();
    let hayMas = false;
    while (url && mensajes.length < 4000 && !vistos.has(url)) {
      vistos.add(url);
      const r = await fetchConReintento(url, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
      });
      if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json();
      mensajes.push(...(data.value || []));
      url = data["@odata.nextLink"] || "";
      if (url && mensajes.length >= 4000) hayMas = true;
    }
    const desdeMs = Date.parse(desde);
    const visibles = mensajes.filter((m) => {
      const t = Date.parse(m.receivedDateTime || m.sentDateTime || "");
      return !Number.isNaN(t) && t >= desdeMs;
    });
    res.json({
      buzon, carpeta, desde: "2025-10-09", hayMas,
      mensajes: visibles.map((m) => ({
        id: m.id,
        asunto: m.subject || "(sense assumpte)",
        de: m.from?.emailAddress?.address || "",
        deNombre: m.from?.emailAddress?.name || "",
        para: (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean),
        fecha: m.receivedDateTime || m.sentDateTime || "",
        leido: !!m.isRead,
        adjuntos: !!m.hasAttachments,
        preview: m.bodyPreview || "",
      })),
    });
  } catch (err) {
    console.error("Error leyendo bandeja:", err);
    res.status(500).json({ error: "Error leyendo la bandeja.", detalle: String(err.message || err) });
  }
});

app.get("/api/buzon/mensaje/:id", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  try {
    const buzon = await buzonDelUsuario(req, res);
    if (!buzon) return;
    const token = await obtenerTokenGraph();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/messages/${req.params.id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`;
    const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${await r.text()}`);
    const m = await r.json();
    res.json({
      id: m.id,
      asunto: m.subject || "(sense assumpte)",
      de: m.from?.emailAddress?.address || "",
      deNombre: m.from?.emailAddress?.name || "",
      para: (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean),
      cc: (m.ccRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean),
      fecha: m.receivedDateTime || "",
      tipoCuerpo: m.body?.contentType || "text",
      cuerpo: m.body?.content || "",
    });
  } catch (err) {
    console.error("Error leyendo mensaje:", err);
    res.status(500).json({ error: "Error leyendo el mensaje.", detalle: String(err.message || err) });
  }
});

// Correos ENVIADOS desde el buzón de quien está logueado que mencionan una OT.
// Busca en Enviados (asunto y cuerpo) y completa con el resto de enviados del mismo hilo.
function patronesCorreoOT(codigo, numero) {
  const cod = String(codigo || "").trim().toUpperCase();
  const deNumero = String(numero || "").replace(/\D/g, "");
  const deCodigo = (cod.match(/(\d{3,6})(?=\/\d{4}$)/) || cod.match(/(\d{3,6})/) || [])[1] || "";
  const n = parseInt(deNumero || deCodigo, 10);
  const pad = n ? String(n).padStart(6, "0") : "";
  const pref = (cod.match(/^([A-Z]{2,4})/) || [])[1] || "";
  const anio = (cod.match(/\/(\d{4})$/) || [])[1] || "";
  const frases = new Set();
  if (cod.length >= 4) frases.add(cod);
  if (pref && pad) {
    frases.add(`${pref}${pad}`);
    if (anio) frases.add(`${pref}${pad}/${anio}`);
  }
  if (pref && n && String(n) !== pad) frases.add(`${pref}${n}`);
  if (n) {
    frases.add(`OT ${n}`);
    if (pad && pad !== String(n)) frases.add(`OT ${pad}`);
    frases.add(`OT: ${pad || n}`);
  }
  return [...frases].filter((p) => p.length >= 4);
}

function mencionaCorreoOT(texto, patrones) {
  const t = String(texto || "");
  return patrones.some((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(t);
  });
}

function seQuedaCorreoOT(m, patrones) {
  const texto = `${m.subject || ""}\n${m.bodyPreview || ""}`;
  if (mencionaCorreoOT(texto, patrones)) return true;
  const codigos = texto.match(/\b[A-Z]{2,4}\d{5,6}\/\d{4}\b/gi) || [];
  if (!codigos.length) return true;
  return codigos.some((c) => mencionaCorreoOT(c, patrones));
}

function kqlCorreoOT(patrones) {
  const partes = patrones.map((p) => {
    const limpio = String(p).replace(/"/g, "");
    return /[\s/:.]/.test(limpio) ? `"${limpio}"` : limpio;
  });
  return `"${partes.join(" OR ").replace(/"/g, '\\"')}"`;
}

function resumirEnviadoOT(m) {
  return {
    id: m.id,
    asunto: m.subject || "(sin asunto)",
    para: (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean),
    cc: (m.ccRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean),
    fecha: m.sentDateTime || m.receivedDateTime || "",
    adjuntos: !!m.hasAttachments,
    preview: String(m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 280),
    enlace: m.webLink || "",
  };
}

async function buscarEnviadosOT(token, buzon, expresion) {
  const headers = { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" };
  const sel = "id,subject,toRecipients,ccRecipients,sentDateTime,receivedDateTime,hasAttachments,bodyPreview,webLink,conversationId";
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/sentitems/messages?$search=${encodeURIComponent(expresion)}&$select=${sel}&$top=25`;
  const mensajes = [];
  const ids = new Set();
  let paginas = 0;
  let hayMas = false;
  while (url && paginas < 8 && mensajes.length < 200) {
    const r = await fetchConReintento(url, { headers });
    if (!r.ok) {
      const detalle = (await r.text()).slice(0, 400);
      const err = new Error(`Graph respondió ${r.status}: ${detalle}`);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    for (const m of j.value || []) {
      if (ids.has(m.id)) continue;
      ids.add(m.id);
      mensajes.push(m);
    }
    url = j["@odata.nextLink"] || "";
    paginas += 1;
    if (url && (paginas >= 8 || mensajes.length >= 200)) hayMas = true;
  }
  return { mensajes, hayMas };
}

async function enviadosDelHiloOT(token, buzon, conversationId) {
  const headers = { Authorization: `Bearer ${token}` };
  const sel = "id,subject,toRecipients,ccRecipients,sentDateTime,receivedDateTime,hasAttachments,bodyPreview,webLink,conversationId";
  const filtro = `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`;
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filtro)}&$select=${sel}&$top=30`;
  const r = await fetchConReintento(url, { headers });
  if (!r.ok) return [];
  const j = await r.json();
  return j.value || [];
}

app.get("/api/correo/ot-enviados", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  const codigo = String(req.query.codigo || "").trim();
  const numero = String(req.query.numero || "").trim();
  const patrones = patronesCorreoOT(codigo, numero);
  if (!patrones.length) return res.status(400).json({ error: "Falta el código de la OT." });
  try {
    const buzon = await buzonDelUsuario(req, res);
    if (!buzon) return;
    const token = await obtenerTokenGraph();
    const tokenSimple = patrones.find((p) => /^[A-Z]{2,4}\d{6}$/.test(p)) || patrones.find((p) => /^[A-Z0-9]+$/.test(p));
    let encontrados;
    try {
      encontrados = await buscarEnviadosOT(token, buzon, kqlCorreoOT(patrones));
    } catch (err) {
      if (!tokenSimple || err.status !== 400) throw err;
      console.warn("[correo/ot-enviados] búsqueda amplia rechazada, reintento con", tokenSimple);
      encontrados = await buscarEnviadosOT(token, buzon, `"${tokenSimple}"`);
    }
    const semillas = encontrados.mensajes.filter((m) => seQuedaCorreoOT(m, patrones));
    const porId = new Map(semillas.map((m) => [m.id, m]));
    const hilos = [...new Set(semillas.map((m) => m.conversationId).filter(Boolean))].slice(0, 25);
    for (let i = 0; i < hilos.length; i += 4) {
      const grupo = hilos.slice(i, i + 4);
      const listas = await Promise.all(grupo.map((id) => enviadosDelHiloOT(token, buzon, id).catch(() => [])));
      for (const lista of listas) {
        for (const m of lista) if (!porId.has(m.id)) porId.set(m.id, m);
      }
    }
    const mensajes = [...porId.values()].map(resumirEnviadoOT).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    console.log(`[correo/ot-enviados] ${buzon} ${codigo || numero}: ${mensajes.length} enviados`);
    res.json({ buzon, mensajes, hayMas: encontrados.hayMas });
  } catch (err) {
    console.error("Error /api/correo/ot-enviados:", err);
    res.status(500).json({ error: "No se pudieron leer los correos enviados.", detalle: String(err.message || err) });
  }
});

function adjuntoLogoCliente(logo) {
  if (!logo?.base64) return null;
  let bytes;
  try {
    bytes = Buffer.from(String(logo.base64).replace(/\s/g, ""), "base64");
  } catch {
    return null;
  }
  const listo = prepararLogoCorreo(bytes, logo.mime);
  if (!listo) return null;
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: listo.mime === "image/jpeg" ? "logo-cliente.jpg" : "logo-cliente.png",
    contentType: listo.mime,
    contentBytes: listo.base64,
    contentId: "logo-cliente",
    isInline: true,
  };
}

function adjuntoFirmaCorreo() {
  try {
    const bytes = require("fs").readFileSync(path.join(__dirname, "public", "firma-correo.png"));
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "firma.png",
      contentType: "image/png",
      contentBytes: bytes.toString("base64"),
      contentId: "firma-correo",
      isInline: true,
    };
  } catch (err) {
    console.warn("[correo/enviar] sin imagen de firma:", err.message);
    return null;
  }
}

// Envío REAL vía Graph como el usuario logueado (email_empresa AChuman).
// respuestaA: id del mensaje original, para que la respuesta siga en el hilo.
// incluirFirma: adjunta la imagen de firma y el HTML debe referenciar cid:firma-correo.
app.post("/api/correo/enviar", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  const { para, cc, asunto, cuerpoHtml, adjunto, adjuntos: adjuntosPedido, incluirFirma, respuestaA, logoCliente } = req.body || {};
  const destinatarios = Array.isArray(para) ? para.filter(Boolean) : [];
  const enPara = new Set(destinatarios.map((e) => String(e).trim().toLowerCase()));
  const copiasVistas = new Set();
  const copias = (Array.isArray(cc) ? cc : [])
    .map((e) => String(e || "").trim())
    .filter((e) => {
      const k = e.toLowerCase();
      if (!e || enPara.has(k) || copiasVistas.has(k)) return false;
      copiasVistas.add(k);
      return true;
    });
  const ccRecipients = copias.map((email) => ({ emailAddress: { address: email } }));
  if (!destinatarios.length) return res.status(400).json({ error: "Falta al menos un destinatario en 'para'." });
  if (!asunto) return res.status(400).json({ error: "Falta 'asunto'." });

  const mimeDeNombre = (nombre) => {
    const n = String(nombre || "").toLowerCase();
    if (n.endsWith(".pdf")) return "application/pdf";
    if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (n.endsWith(".doc")) return "application/msword";
    if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (n.endsWith(".xls")) return "application/vnd.ms-excel";
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
    return "application/octet-stream";
  };

  // Lista nueva (reclamación): varios ficheros de oficina, 3 MB cada uno y 10 MB en total.
  // El campo antiguo `adjunto` (un solo PDF de facturas) se deja igual.
  const ficheros = [];
  if (Array.isArray(adjuntosPedido)) {
    if (adjuntosPedido.length > 10) return res.status(400).json({ error: "Máximo 10 adjuntos por correo." });
    const permitidas = new Set(["pdf", "png", "jpg", "jpeg", "doc", "docx", "xls", "xlsx"]);
    const topeFichero = 3 * 1024 * 1024;
    const topeTotal = 10 * 1024 * 1024;
    let suma = 0;
    for (const a of adjuntosPedido) {
      if (!a || !a.base64) continue;
      const nombre = String(a.nombre || "adjunto").replace(/[\\/]/g, "_").slice(0, 180);
      const punto = nombre.lastIndexOf(".");
      const ext = punto >= 0 ? nombre.slice(punto + 1).toLowerCase() : "";
      if (!permitidas.has(ext)) return res.status(400).json({ error: `«${nombre}» no es PDF, foto, Excel ni Word.` });
      const limpio = String(a.base64).replace(/\s/g, "");
      const bytes = Buffer.from(limpio, "base64");
      if (!bytes.length) return res.status(400).json({ error: `«${nombre}» está vacío.` });
      if (bytes.length > topeFichero) return res.status(400).json({ error: `«${nombre}» pesa más de 3 MB.` });
      if (suma + bytes.length > topeTotal) return res.status(400).json({ error: "Los adjuntos juntos no pueden pasar de 10 MB." });
      suma += bytes.length;
      ficheros.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: nombre,
        contentType: a.mime || mimeDeNombre(nombre) || "application/octet-stream",
        contentBytes: limpio,
      });
    }
  } else if (adjunto?.base64) {
    ficheros.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: adjunto.nombre || "adjunto.pdf",
      contentType: adjunto.mime || mimeDeNombre(adjunto.nombre) || "application/pdf",
      contentBytes: adjunto.base64,
    });
  }

  try {
    const buzon = await buzonDelUsuario(req, res);
    if (!buzon) return;
    const token = await obtenerTokenGraph();
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const graph = (url, method, body) => fetchConReintento(url, {
      method,
      headers: body === undefined ? { Authorization: `Bearer ${token}` } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, 1);
    const firma = incluirFirma ? adjuntoFirmaCorreo() : null;
    const logoAdj = adjuntoLogoCliente(logoCliente);

    if (respuestaA) {
      const creado = await graph(`${base}/messages/${encodeURIComponent(respuestaA)}/createReply`, "POST", {});
      if (!creado.ok) throw new Error(`Graph respondió ${creado.status} al preparar la respuesta: ${(await creado.text()).slice(0, 300)}`);
      const draft = await creado.json();
      const citado = String(draft.body?.contentType || "").toLowerCase() === "html"
        ? (draft.body?.content || "")
        : `<pre>${String(draft.body?.content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
      const parche = await graph(`${base}/messages/${encodeURIComponent(draft.id)}`, "PATCH", {
        subject: asunto,
        body: { contentType: "HTML", content: (cuerpoHtml || "") + citado },
        toRecipients: destinatarios.map((email) => ({ emailAddress: { address: email } })),
        ...(ccRecipients.length ? { ccRecipients } : {}),
      });
      if (!parche.ok) throw new Error(`Graph respondió ${parche.status} al escribir la respuesta: ${(await parche.text()).slice(0, 300)}`);
      if (firma) {
        const af = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", firma);
        if (!af.ok) console.warn("[correo/enviar] firma no adjuntada", af.status);
      }
      if (logoAdj) {
        const al = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", logoAdj);
        if (!al.ok) console.warn("[correo/enviar] logo no adjuntado", al.status);
      }
      for (const f of ficheros) {
        const aa = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", f);
        if (!aa.ok) throw new Error(`Graph respondió ${aa.status} al adjuntar el fichero: ${(await aa.text()).slice(0, 200)}`);
      }
      const env = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/send`, "POST");
      if (!env.ok) {
        const pista = env.status === 403
          ? " — falta el permiso de aplicación Mail.Send en Azure, con consentimiento de administrador."
          : "";
        throw new Error(`Graph respondió ${env.status} enviando la respuesta${pista}: ${(await env.text()).slice(0, 300)}`);
      }
      console.log(`[correo/enviar] respuesta de=${buzon} "${asunto}" → ${destinatarios.join(", ")}${copias.length ? ` cc=${copias.join(", ")}` : ""}`);
      return res.json({ ok: true, de: buzon, para: destinatarios, cc: copias });
    }

    const mensaje = {
      subject: asunto,
      body: { contentType: "HTML", content: cuerpoHtml || "" },
      toRecipients: destinatarios.map((email) => ({ emailAddress: { address: email } })),
      ...(ccRecipients.length ? { ccRecipients } : {}),
    };
    // Varios adjuntos van en un borrador y se añaden de uno en uno:
    // Outlook no acepta varios ficheros metidos en el mismo envío.
    if (Array.isArray(adjuntosPedido) && ficheros.length) {
      const creado = await graph(`${base}/messages`, "POST", mensaje);
      if (!creado.ok) {
        const pista = creado.status === 403 ? " — falta el permiso Mail.ReadWrite para adjuntar ficheros." : "";
        throw new Error(`Graph respondió ${creado.status} al preparar el correo${pista}: ${(await creado.text()).slice(0, 300)}`);
      }
      const draft = await creado.json();
      const borrarBorrador = () => graph(`${base}/messages/${encodeURIComponent(draft.id)}`, "DELETE").catch(() => {});
      if (firma) {
        const af = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", firma);
        if (!af.ok) console.warn("[correo/enviar] firma no adjuntada", af.status);
      }
      if (logoAdj) {
        const al = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", logoAdj);
        if (!al.ok) console.warn("[correo/enviar] logo no adjuntado", al.status);
      }
      for (const f of ficheros) {
        const aa = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", f);
        if (!aa.ok) {
          await borrarBorrador();
          throw new Error(`Graph respondió ${aa.status} al adjuntar «${f.name}»: ${(await aa.text()).slice(0, 200)}`);
        }
      }
      const envioBorrador = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/send`, "POST");
      if (!envioBorrador.ok) {
        await borrarBorrador();
        const pista = envioBorrador.status === 403
          ? " — falta el permiso de aplicación Mail.Send en Azure, con consentimiento de administrador."
          : "";
        throw new Error(`Graph respondió ${envioBorrador.status} enviando el correo${pista}: ${(await envioBorrador.text()).slice(0, 300)}`);
      }
      console.log(`[correo/enviar] de=${buzon} "${asunto}" → ${destinatarios.join(", ")}${copias.length ? ` cc=${copias.join(", ")}` : ""} (${ficheros.length} adjunto${ficheros.length > 1 ? "s" : ""})`);
      return res.json({ ok: true, de: buzon, para: destinatarios, cc: copias });
    }
    const adjuntos = [];
    if (firma) adjuntos.push(firma);
    if (logoAdj) adjuntos.push(logoAdj);
    for (const f of ficheros) adjuntos.push(f);
    if (adjuntos.length) mensaje.attachments = adjuntos;
    const url = `${base}/sendMail`;
    const r = await fetchConReintento(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: mensaje, saveToSentItems: true }),
    });
    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      const pista = r.status === 403
        ? " — probablemente falta conceder el permiso de APLICACIÓN 'Mail.Send' (con consentimiento de administrador) en el registro de la App en Azure, además del Mail.Read que ya usa la bandeja."
        : "";
      throw new Error(`Graph respondió ${r.status} enviando el correo${pista}: ${detalle.slice(0, 300)}`);
    }
    console.log(`[correo/enviar] de=${buzon} "${asunto}" → ${destinatarios.join(", ")}${copias.length ? ` cc=${copias.join(", ")}` : ""}${ficheros.length ? ` (${ficheros.length} adjunto${ficheros.length > 1 ? "s" : ""})` : ""}`);
    res.json({ ok: true, de: buzon, para: destinatarios, cc: copias });
  } catch (err) {
    console.error("Error enviando correo:", err);
    res.status(500).json({ error: "Error enviando el correo.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 0a-quater) AVISOS DE SOBRECOSTE enviados (checks ✉), COMPARTIDOS
// ---------------------------------------------------------------------
// Marca qué avisos de precio se han enviado, para que TODOS los equipos
// vean el ✉ azul y no se pierda al recargar o cambiar de PC.
// Formato: { enviados: { "PC26-002648|PR000000007783": { ts: "..." } } }
// ---------------------------------------------------------------------
app.get("/api/avisos", async (req, res) => {
  try {
    res.json(await db.getDoc(claveEmpresa("avisos"), { enviados: {} }));
  } catch (err) {
    console.error("Error leyendo avisos:", err);
    res.status(500).json({ error: "No se pudo leer los avisos." });
  }
});

app.post("/api/avisos", async (req, res) => {
  try {
    const actual = await db.getDoc(claveEmpresa("avisos"), { enviados: {} });
    const body = req.body || {};
    const combinado = { enviados: { ...(actual.enviados || {}), ...(body.enviados || {}) } };
    for (const k in body.enviados || {}) if (body.enviados[k] === null) delete combinado.enviados[k];
    await db.setDoc(claveEmpresa("avisos"), combinado);
    res.json({ guardado: true });
  } catch (err) {
    console.error("Error guardando avisos:", err);
    res.status(500).json({ error: "No se pudo guardar los avisos." });
  }
});

// ---------------------------------------------------------------------
// Comercial: clientes en seguimiento, tarifa de presupuesto y correos.
// Un documento por empresa (Also Casals → "comercial"; otra → comercial_slug).
// ---------------------------------------------------------------------
const COMERCIAL_VACIO = { contactos: [], tarifa: [], presupuestos: [], actualizado: null };

function documentoComercial(body) {
  const b = body && typeof body === "object" ? body : {};
  const lista = (v, tope) => (Array.isArray(v) ? v.slice(0, tope) : []);
  return {
    contactos: lista(b.contactos, 5000),
    tarifa: lista(b.tarifa, 20000),
    presupuestos: lista(b.presupuestos, 5000),
    actualizado: new Date().toISOString(),
  };
}

app.get("/api/comercial", async (req, res) => {
  try {
    const doc = await db.getDoc(claveEmpresa("comercial"), COMERCIAL_VACIO);
    res.json({
      contactos: Array.isArray(doc.contactos) ? doc.contactos : [],
      tarifa: Array.isArray(doc.tarifa) ? doc.tarifa : [],
      presupuestos: Array.isArray(doc.presupuestos) ? doc.presupuestos : [],
      actualizado: doc.actualizado || null,
    });
  } catch (err) {
    console.error("Error leyendo comercial:", err);
    res.status(500).json({ error: "No se pudo leer el seguimiento comercial." });
  }
});

app.post("/api/comercial", async (req, res) => {
  try {
    const doc = documentoComercial(req.body);
    await db.setDoc(claveEmpresa("comercial"), doc);
    res.json(doc);
  } catch (err) {
    console.error("Error guardando comercial:", err);
    res.status(500).json({ error: "No se pudo guardar el seguimiento comercial." });
  }
});

// ---------------------------------------------------------------------
// 0a-ter) CORREO Microsoft 365 (Graph) — PDFs adjuntos de dos buzones
// ---------------------------------------------------------------------
// Replica la lógica ya depurada del Agente de Compras (Anexo B del
// traspaso). Trae los PDF adjuntos de la BANDEJA DE ENTRADA de un buzón,
// filtrando por fecha (UTC) y marcando como leído lo que trae.
// Credenciales en .env: M365_TENANT_ID / M365_CLIENT_ID /
// M365_CLIENT_SECRET (secreto ROTADO, nunca el que se expuso).
// Permiso requerido en Azure: Mail.Read (Aplicación) con consentimiento admin.
// ---------------------------------------------------------------------
const M365_BUZONES = {
  albaranes: process.env.M365_BUZON_ALBARANES || "albarans@alsocasals.com", // ¡sin "e": albarans!
  facturas: process.env.M365_BUZON_FACTURAS || "facturacio@alsocasals.com",
};
let tokenGraph = { token: null, expira: 0 };

async function obtenerTokenGraph() {
  if (tokenGraph.token && Date.now() < tokenGraph.expira) return tokenGraph.token;
  const tenant = process.env.M365_TENANT_ID;
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.M365_CLIENT_ID,
    client_secret: process.env.M365_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetchConReintento(url, { method: "POST", body });
  if (!r.ok) throw new Error(`Azure AD (Graph) respondió ${r.status}: ${await r.text()}`);
  const data = await r.json();
  tokenGraph = { token: data.access_token, expira: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenGraph.token;
}

app.get("/api/correo/:buzon", async (req, res) => {
  const clave = req.params.buzon;
  const buzon = M365_BUZONES[clave];
  if (!buzon) return res.status(400).json({ error: `Buzón desconocido: ${clave}. Usa 'albaranes' o 'facturas'.` });
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env (tenant, client y secret rotado)." });
  }
  const dias = Number(req.query.dias ?? process.env.M365_DIAS ?? 1); // 0 = sin filtro fecha; 1 = hoy
  const marcarLeido = (process.env.M365_MARCAR_LEIDO ?? "true") !== "false";

  try {
    const token = await obtenerTokenGraph();
    const headers = { Authorization: `Bearer ${token}` };
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/inbox/messages`;
    const sel = "$select=id,subject,from,receivedDateTime,hasAttachments&$top=50";

    // OJO Graph: con $filter NO se usa $orderby (da error sin cabecera especial).
    let url;
    if (dias && dias > 0) {
      const hoy = new Date();
      const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - (dias - 1)));
      const desdeIso = desde.toISOString().slice(0, 19) + "Z";
      url = `${base}?${sel}&$filter=receivedDateTime ge ${desdeIso}`;
    } else {
      url = `${base}?${sel}&$orderby=receivedDateTime desc`;
    }

    const r = await fetchConReintento(url, { headers });
    if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${await r.text()}`);
    const mensajes = (await r.json()).value || [];

    const salida = [];
    for (const msg of mensajes) {
      if (!msg.hasAttachments) continue;
      const ar = await fetchConReintento(`${base}/${msg.id}/attachments`, { headers });
      if (!ar.ok) continue;
      let encontrados = 0;
      for (const att of (await ar.json()).value || []) {
        const nombre = (att.name || "").toString();
        const ctype = (att.contentType || "").toLowerCase();
        const esPdf =
          ctype === "application/pdf" ||
          (ctype === "application/octet-stream" && nombre.toLowerCase().endsWith(".pdf")) ||
          nombre.toLowerCase().endsWith(".pdf");
        const esFichero = (att["@odata.type"] || "").endsWith("fileAttachment");
        if (esFichero && esPdf && att.contentBytes) {
          salida.push({
            nombre,
            datab64: att.contentBytes,
            asunto: msg.subject || "",
            de: msg.from?.emailAddress?.address || "",
            fecha: msg.receivedDateTime || "",
          });
          encontrados++;
        }
      }
      if (encontrados && marcarLeido) {
        await fetchConReintento(`${base}/${msg.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        }).catch(() => {});
      }
    }
    res.json({ buzon, pdfs: salida });
  } catch (err) {
    console.error("Error correo M365:", err);
    res.status(500).json({ error: "Error leyendo el correo.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 0) PERSISTENCIA DE ATRIBUTOS IA (Postgres · clave "atributos")
// ---------------------------------------------------------------------
const fs = require("fs");

app.get("/api/atributos", async (req, res) => {
  try {
    res.json(await db.getDoc("atributos", {}));
  } catch (err) {
    console.error("Error leyendo atributos:", err);
    res.status(500).json({ error: "No se pudieron leer los atributos." });
  }
});

// ---------------------------------------------------------------------
// 0b) EXTRACCIÓN DE FACTURAS PDF — POST /api/facturas/pdf
// ---------------------------------------------------------------------
// Recibe PDFs de facturas de venta (formato ALSO CASALS) en base64 y
// devuelve las facturas con sus LÍNEAS: mano de obra (horas), material
// (código PR + descripción), y las descripciones de cada parte de
// trabajo. Funciona tanto con facturas sueltas como con el PDF anual
// (muchas facturas concatenadas, con páginas repetidas por factura).
// ---------------------------------------------------------------------
const pdfParse = require("pdf-parse");

function parsearFacturasDeTexto(texto) {
  // Separar por cabecera de factura (se repite en cada página)
  const bloques = texto.split(/(?=FACTURA\s+FECHA FACTURA)/);
  const porNumero = new Map(); // numFactura → factura acumulada

  const RE_CABECERA = /^(P[\dA-Z]{5,10})\s{2,}(\d{1,2} de \w+ de \d{4})\s{2,}(.+?)\s*$/m;
  const RE_OBRA = /Nº Obra:\s*(\S+)/;
  const RE_PARTE = /Nº parte de trabajo:\s*(\S+)\s+OT:\s*(\S+)/;
  const RE_FECHA_PARTE = /Fecha:\s*([\d/]+)/;
  const RE_ITEM_INICIO = /^(PR\d{6,}|\d{3,4})\s+(.*)$/;
  const RE_ITEM_FIN = /\s(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(?:(-\s*\d+\s*%|-)\s+)?(\d+(?:[.,]\d+)?)\s+(\d{1,2})\s*$/;

  const num = (s) => parseFloat((s || "0").replace(/\./g, "").replace(",", ".")) || 0;

  for (const bloque of bloques) {
    const cab = bloque.match(RE_CABECERA);
    if (!cab) continue;
    const numFactura = cab[1];
    const obra = bloque.match(RE_OBRA)?.[1] || null;

    if (!porNumero.has(numFactura)) {
      porNumero.set(numFactura, {
        numFactura,
        fecha: cab[2],
        cliente: cab[3].trim(),
        numObra: obra,
        partes: [],
        lineas: [],
      });
    }
    const fac = porNumero.get(numFactura);
    if (!fac.numObra && obra) fac.numObra = obra;

    // Recorrer líneas del bloque manteniendo el "parte" actual
    const lineasTxt = bloque.split("\n");
    let otActual = fac.numObra;
    let parteActual = null;
    let itemBuffer = null; // { codigo, texto }
    let esperandoDescParte = false;

    const cerrarItem = () => {
      if (!itemBuffer) return;
      const m = itemBuffer.texto.match(RE_ITEM_FIN);
      if (m) {
        const descripcion = itemBuffer.texto.slice(0, m.index).replace(/\s+/g, " ").trim();
        fac.lineas.push({
          codigo: itemBuffer.codigo,
          descripcion,
          cantidad: num(m[1]),
          precio: num(m[2]),
          dto: m[3] ? m[3].replace(/\s/g, "") : null,
          importe: num(m[4]),
          ot: otActual,
          parte: parteActual,
        });
      }
      itemBuffer = null;
    };

    for (const raw of lineasTxt) {
      const l = raw.trim();
      if (!l) continue;

      const parte = l.match(RE_PARTE);
      if (parte) {
        cerrarItem();
        parteActual = parte[1];
        otActual = parte[2] || fac.numObra;
        esperandoDescParte = true;
        continue;
      }
      if (esperandoDescParte) {
        if (RE_FECHA_PARTE.test(l)) continue; // línea "Fecha: ..."
        const desc = l.replace(/^[^A-Za-zÀ-ÿ0-9(]+/, "").trim();
        if (desc && !RE_ITEM_INICIO.test(l) && !l.startsWith("Nº albarán")) {
          fac.partes.push({ parte: parteActual, ot: otActual, descripcion: desc });
          esperandoDescParte = false;
          continue;
        }
        esperandoDescParte = false;
      }

      const ini = l.match(RE_ITEM_INICIO);
      if (ini) {
        cerrarItem();
        itemBuffer = { codigo: ini[1], texto: ini[2] };
        // ¿la línea ya está completa (números al final)?
        if (RE_ITEM_FIN.test(itemBuffer.texto)) cerrarItem();
        continue;
      }
      if (itemBuffer) {
        if (l.startsWith("FORMA DE PAGO") || l.startsWith("Nº albarán") || l.startsWith("BASE IMPONIBLE")) {
          cerrarItem();
        } else {
          itemBuffer.texto += " " + l;
          if (RE_ITEM_FIN.test(itemBuffer.texto)) cerrarItem();
        }
      }
    }
    cerrarItem();
  }

  return [...porNumero.values()];
}

app.post("/api/facturas/pdf", async (req, res) => {
  try {
    const archivos = req.body?.archivos || [];
    if (!archivos.length) return res.status(400).json({ error: "Sin archivos. Enviar {archivos:[{nombre, base64}]}" });

    const facturas = [];
    const errores = [];
    for (const a of archivos) {
      try {
        const data = await pdfParse(Buffer.from(a.base64, "base64"));
        const fs2 = parsearFacturasDeTexto(data.text);
        fs2.forEach((f) => (f.archivo = a.nombre));
        facturas.push(...fs2);
      } catch (err) {
        errores.push({ archivo: a.nombre, error: String(err.message || err) });
      }
    }
    const lineas = facturas.reduce((acc, f) => acc + f.lineas.length, 0);
    console.log(`[facturas/pdf] ${facturas.length} facturas · ${lineas} líneas · ${errores.length} errores`);
    res.json({ facturas: facturas.length, lineas, errores, data: facturas });
  } catch (err) {
    console.error("Error /api/facturas/pdf:", err);
    res.status(500).json({ error: "Error extrayendo las facturas.", detalle: String(err.message || err) });
  }
});

app.post("/api/atributos", async (req, res) => {
  try {
    const actuales = await db.getDoc("atributos", {});
    const nuevos = req.body || {};
    const combinados = { ...actuales, ...nuevos };
    await db.setDoc("atributos", combinados);
    console.log(`[atributos] Guardados ${Object.keys(nuevos).length} nuevos · total ${Object.keys(combinados).length}`);
    res.json({ guardados: Object.keys(nuevos).length, total: Object.keys(combinados).length });
  } catch (err) {
    console.error("Error guardando atributos:", err);
    res.status(500).json({ error: "No se pudieron guardar los atributos." });
  }
});

// ---------------------------------------------------------------------
// 1) CLAUDE — POST /api/clasificar
// ---------------------------------------------------------------------
// Recibe { prompt } y devuelve { texto } con la respuesta del modelo.
// La clave ANTHROPIC_API_KEY se obtiene en console.anthropic.com
// ---------------------------------------------------------------------
app.post("/api/clasificar", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Falta el campo 'prompt'." });

  try {
    const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const detalle = await response.text();
      console.error("Anthropic error:", response.status, detalle);
      return res.status(502).json({ error: "Error llamando a la IA.", detalle });
    }

    const data = await response.json();
    const texto = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({ texto });
  } catch (err) {
    console.error("Error /api/clasificar:", err);
    res.status(500).json({ error: "Error interno clasificando la descripción." });
  }
});

// ---------------------------------------------------------------------
// 2) BUSINESS CENTRAL — GET /api/bc/:fuente?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------
// Autenticación OAuth2 "client credentials" contra Azure AD (Entra ID).
// El partner de BC debe registrar una App en Azure con permiso
// API.ReadWrite.All (o Financials.ReadWrite.All) sobre Business Central
// y facilitaros: TENANT_ID, CLIENT_ID y CLIENT_SECRET.
// ---------------------------------------------------------------------

// Nombre del campo custom de Nº de OT en las entidades de la API.
// Opción B (API estándar extendida): las entidades siguen siendo las
// estándar pero incluyen este campo añadido por vuestra extensión.
// ⚠️ CONFIRMAR con el partner el nombre EXACTO tal como aparece en el
// JSON de la API (camelCase). Ejemplos posibles: "noOT", "otNo",
// "workOrderNo", "jobNo". Debe ser idéntico en todas las entidades.
const CAMPO_OT_BC = process.env.BC_CAMPO_OT || "noOT";

// Campo de segmento (Dimensión 1 de BC): códigos como "INS-P", "INS-I",
// "INS-A" (unidad de negocio + tipo de cliente P/I/A). En las líneas de
// venta y compra el campo es shortcut_Dimension_1_Code (confirmar el
// nombre exacto en el JSON de vuestra API; en páginas expuestas como
// web service suele ser "Shortcut_Dimension_1_Code").
const CAMPO_SEGMENTO_BC = process.env.BC_CAMPO_SEGMENTO || "shortcut_Dimension_1_Code";

// Enlace directo al pedido de compra en el cliente web de BC (Maria,
// 2026-09-04): "quiero dar clic aquí y poder abrir el pedido de
// compra" — se abre en pestaña nueva, filtrando la ficha de "Pedido de
// compra" por su número. Nº de página estándar de BC (ajustable con
// BC_PAGE_PEDIDO_COMPRA si en este BC fuera distinto): 9307 = "Pedido
// de compra" (ficha). El dominio del cliente web ES DISTINTO del de la
// API (sin "api." ni "/v2.0/.../ODataV4/...").
const BC_PAGE_PEDIDO_COMPRA = process.env.BC_PAGE_PEDIDO_COMPRA || "9307";
function enlacePedidoCompraBC(numeroPedido) {
  if (!numeroPedido || !process.env.BC_TENANT_ID || !process.env.BC_ENVIRONMENT) return null;
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const filtro = encodeURIComponent(`'No.' IS '${numeroPedido}'`);
  return `https://businesscentral.dynamics.com/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}?company=${empresa}&page=${BC_PAGE_PEDIDO_COMPRA}&filter=${filtro}`;
}

// Mapa fuente → entidad de la API de BC y campo de fecha para filtrar.
// Todas las entidades son las estándar de la API v2.0; la extensión
// añade CAMPO_OT_BC a cada una.
const FUENTES_BC = {
  pedidos_venta: { entidad: "salesOrders", campoFecha: "orderDate" },
  lineas_venta: { entidad: "salesInvoiceLines", campoFecha: "postingDate" },
  lineas_compra: { entidad: "purchaseInvoiceLines", campoFecha: "postingDate" },
  // movs_contabilidad va por FUENTES_WS (página 25): la API v2.0 generalLedgerEntries
  // no expone OT ni línea de negocio; el web service sí (Global/Shortcut Dimension 2).
  // tarifas_venta va por FUENTES_WS: salesPrices NO existe en la API v2.0 estándar
  facturas_venta: { entidad: "salesInvoices", campoFecha: "invoiceDate" },
  abonos_venta: { entidad: "salesCreditMemos", campoFecha: "creditMemoDate" },
};

// Fuentes que van por WEB SERVICE de página (no por la API estándar).
// En este BC ya existen publicados:
//   · "SalesInvLines"  → Página 516 (Sales Lines — líneas de documentos vivos)
//   · "PurchaseLines"  → Página 518 (Purchase Lines — líneas de compra vivas)
// Nota: son líneas de documentos SIN registrar (ofertas/pedidos en curso).
// El histórico facturado vive en las páginas de registrados (526/528),
// que se pueden añadir después con el mismo mecanismo.
// El campo de fecha se detecta automáticamente entre los candidatos.
// Campo de fecha que ya respondió 200, y campos que BC rechazó (400).
// Así no se repite el sondeo: cada 400 cuenta como "error request" y BC
// acaba respondiendo 429 Too many error requests.
const campoFechaOk = new Map();
const campoFechaMal = new Set();

const FUENTES_WS = {
  lineas_venta: {
    servicio: process.env.BC_WS_LINEASVENTA || "SalesInvLines",
    // Shipment_Date es el que existe en Sales_Order_Line_Excel. Posting_Date
    // y Document_Date devuelven 400: no van primero.
    camposFecha: [process.env.BC_WS_LINEASVENTA_FECHA, "Shipment_Date", "Order_Date", "Posting_Date", "Document_Date"].filter((c, i, arr) => c && arr.indexOf(c) === i),
  },
  lineas_compra: {
    servicio: process.env.BC_WS_LINEASCOMPRA || "PurchaseLines",
    camposFecha: [process.env.BC_WS_LINEASCOMPRA_FECHA, "Posting_Date", "Document_Date", "Expected_Receipt_Date", "Order_Date"].filter(Boolean),
  },
  // Líneas REGISTRADAS (histórico facturado). Requieren publicar como
  // web service las páginas 526 (Sales Invoice Line) y 528 (Purchase
  // Invoice Line) — mismas columnas estilo Excel que las 516/518.
  lineas_venta_reg: {
    // Histórico de venta registrada. La página 47 (Sales_InvoiceSales
    // Lines_Excel) quedó DESCARTADA: en su BC recorre PREFACTURAS (PFV),
    // no facturas. Falta publicar la página 526; se probarán estos
    // nombres cuando exista:
    servicios: [
      process.env.BC_WS_LINEASVENTA_REG,
      "Hist_líns_facturas_venta", // ← el publicado por Maria (pág. 526, "Hist. líns. facturas venta")
      "Hist_lins_facturas_venta",
      "Hist_líns_facturas_venta_Excel",
      "Sales_Invoice_Line_Excel",
    ].filter(Boolean),
    camposFecha: [process.env.BC_WS_LINEASVENTA_REG_FECHA, "Posting_Date", "Document_Date", "Shipment_Date"].filter(Boolean),
    permitirSinFecha: true,
    // Auto-descubrimiento: si ningún candidato existe, se busca en el
    // catálogo de BC un servicio cuyo nombre encaje con estos patrones
    descubrir: [/l[ií]n/i, /(hist|factur|invoice)/i, /venta|sales/i],
  },
  lineas_compra_reg: {
    // Hist_líns_facturas_compra_Excel = el histórico REAL registrado,
    // ya publicado en su BC (verificado en el metadata) — primero.
    // Purchase_QuotePurchLines_Excel (pág. 97) son OFERTAS de compra:
    // último recurso si el histórico no estuviera.
    servicios: [
      process.env.BC_WS_LINEASCOMPRA_REG,
      "Hist_líns_facturas_compra_Excel",
      "Purchase_Invoice_Line_Excel",
      "Purchase_QuotePurchLines_Excel",
    ].filter(Boolean),
    camposFecha: [process.env.BC_WS_LINEASCOMPRA_REG_FECHA, "Posting_Date", "Document_Date", "Expected_Receipt_Date"].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/l[ií]n/i, /(hist|factur|invoice)/i, /compra|purch/i],
  },
  // CABECERA del pedido de compra (Purchase Header): trae el proveedor,
  // que NO existe en la línea (Purchase Line). Se cruza con las líneas
  // de compra por Nº de documento. Servicio publicado: "Pedido_compra_Excel".
  // NOTA: Maria decidió traer TODAS las columnas (sin $select), pese al
  // riesgo de timeout de BC con 90+ columnas → por eso los timeouts de
  // red están subidos a 500 s y se pagina con $skip. Si BC cortara, el
  // handler /api/bc devuelve el motivo y se decidiría entonces.
  pedidos_compra: {
    servicio: process.env.BC_WS_PEDIDOSCOMPRA || "Pedido_compra_Excel",
    camposFecha: [process.env.BC_WS_PEDIDOSCOMPRA_FECHA, "Order_Date", "Document_Date", "Posting_Date"].filter(Boolean),
    permitirSinFecha: true,
  },
  // LÍNEAS de pedido de venta VIVAS (Sales Order Line, pág. 516/Excel).
  // Tienen Qty_to_Invoice, Quantity_Shipped, Quantity_Invoiced, Unit_Price…
  // → permiten calcular el importe pendiente de facturar por pedido.
  lineas_pedido_venta: {
    servicios: [
      process.env.BC_WS_LINEASPEDIDOVENTA,
      "Sales_Order_Line_Excel",
      "SalesOrderLines",
    ].filter(Boolean),
    camposFecha: [process.env.BC_WS_LINEASPEDIDOVENTA_FECHA, "Shipment_Date", "Planned_Shipment_Date", "Order_Date", "Document_Date"].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/sales.?order.?line/i, /l[ií]n.*venda|l[ií]n.*venta/i],
  },
  // Movimientos CONTABILIDAD (G/L Entry, pág. 20 → Movs_contabilidad_Excel).
  // Metadata: Global_Dimension_2_Code = OT · Global_Dimension_1_Code = LN.
  movs_contabilidad: {
    servicios: [
      process.env.BC_WS_MOVSCONTAB,
      "Movs_contabilidad_Excel",
      "Movs_contabilidad",
      "G_LEntries",
      "G_L_Entries",
      "General_Ledger_Entries",
      "GLEntries",
    ].filter(Boolean),
    camposFecha: [
      process.env.BC_WS_MOVSCONTAB_FECHA,
      "Posting_Date",
      "Fecha_registro",
      "Document_Date",
    ].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/g.?l.?entr/i, /mov.*(contab|contabilidad)/i, /general.?ledger/i],
  },
  // Movimientos de OT / proyecto. Preferir Movs_proyecto_Excel (pág. 92)
  // como en horas.cjs (BC_WS_MOVSPROYECTO). JobLedgerEntries (consulta 268)
  // también sirve para ingresos por OT (Job_No + Line_Amount_LCY).
  movs_contabilidad_excel: {
    servicios: [
      process.env.BC_WS_MOVSPROYECTO,
      process.env.BC_WS_JOBLEDGER,
      "Movs_proyecto_Excel",
      "Movs_proyecto",
      "Movimientos_proyecto",
      "JobLedgerEntries",
      "Job_Ledger_Entries",
      "Job_Ledger_Entries_Excel",
    ].filter(Boolean),
    camposFecha: [
      process.env.BC_WS_MOVSPROYECTO_FECHA,
      process.env.BC_WS_JOBLEDGER_FECHA,
      "Posting_Date",
      "Document_Date",
    ].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/job.?ledger/i, /mov.*(proyecto|ot)/i],
  },
  // Tarifas de venta: listas de precios publicadas como Excel en este BC.
  // Servicio real verificado: Price_List_Lines_Excel (NO SalesPrices / API v2.0).
  tarifas_venta: {
    servicios: [
      process.env.BC_WS_TARIFASVENTA,
      "Price_List_Lines_Excel",
      "Price_List_Lines_Part_Excel",
      "SalesPrices",
      "Sales_Prices",
      "Sales_Price",
      "Price_List_Lines",
      "PriceListLines",
    ].filter(Boolean),
    camposFecha: [
      process.env.BC_WS_TARIFASVENTA_FECHA,
      "StartingDate",
      "Starting_Date",
      "startingDate",
    ].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/price.?list.?line/i, /sales.?price/i, /tarif|precio/i],
  },
  // Ficha / lista de recursos. No tiene fecha de movimiento: se carga
  // entera. La unidad de negocio del trabajador es Global_Dimension_1_Code
  // si ese campo está en la página publicada.
  recursos: {
    servicios: [
      process.env.BC_WS_RECURSOS,
      "Resource_List",
      "Lista_recursos",
      "Recursos",
      "Ficha_recurso_Excel",
    ].filter(Boolean),
    camposFecha: [],
    permitirSinFecha: true,
  },
};

// ---------------------------------------------------------------------
// 2a) EMPRESAS — GET /api/bc/empresas
// ---------------------------------------------------------------------
// Utilidad de diagnóstico: lista las empresas del entorno con su nombre
// exacto y su ID. Sirve para rellenar BC_COMPANY_NAME y BC_COMPANY_ID
// sin adivinar. Solo requiere que la autenticación de Azure funcione.
// ---------------------------------------------------------------------
// Comprobación MÁS simple posible de qué versión del archivo está
// corriendo de verdad — sin BC, sin tokens, sin nada que pueda fallar
// por otro motivo. Solo texto fijo. Súbelo a esta dirección cualquier
// vez que haya dudas de si el server.cjs nuevo se ha cargado.
app.get("/api/version", (req, res) => {
  res.json({ version: "2026-10-01-mapeo-historial-articulos" });
});

/** Mapeo Also→Ferros (CSV del bot Bot_Sustituir_Productes). */
app.get("/api/mapeo-articulos", (req, res) => {
  try {
    const { cargarMapeo } = require("./mapeoArticulos.cjs");
    const data = cargarMapeo();
    if (!data.ok && !data.pares?.length) {
      return res.status(404).json(data);
    }
    res.json({
      ok: true,
      n: data.n,
      ruta: data.ruta,
      porCodigo: data.porCodigo,
    });
  } catch (err) {
    console.error("Error /api/mapeo-articulos:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/bc/empresas", async (req, res) => {
  try {
    const token = await obtenerTokenBC();
    const url = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies`;
    const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const detalle = await r.text();
      return res.status(502).json({ error: `BC respondió ${r.status} al listar empresas.`, detalle });
    }
    const data = await r.json();
    res.json({
      empresas: (data.value || []).map((c) => ({ id: c.id, nombre: c.name, displayName: c.displayName })),
      nota: "Copia 'nombre' en BC_COMPANY_NAME y 'id' en BC_COMPANY_ID del .env",
    });
  } catch (err) {
    console.error("Error /api/bc/empresas:", err);
    res.status(500).json({ error: "Error de autenticación o de red al listar empresas.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 2a-bis) METADATA de un web service — GET /api/bc/diag/metadata?servicio=Pedido_compra_Excel
// ---------------------------------------------------------------------
// Utilidad de diagnóstico: lee el documento oficial $metadata que BC
// publica para CADA web service OData v4, y saca de ahí los NOMBRES DE
// CAMPO reales y — lo importante para el caso del Nº de albarán — la
// CLAVE declarada (puede ser un solo campo o varios, ej. Document_Type +
// No). Así no hace falta adivinar ni capturar tráfico del navegador: es
// el propio BC diciendo, con autoridad, cómo hay que dirigirse a un
// registro por clave. Solo requiere que la autenticación ya funcione
// (la misma que usan las tarjetas de "Cargar datos").
// ---------------------------------------------------------------------
app.get("/api/bc/diag/metadata", async (req, res) => {
  const servicio = (req.query.servicio || "").toString().trim();
  if (!servicio) {
    return res.status(400).json({ error: "Falta ?servicio=NombreDelWebService (ej. Pedido_compra_Excel)." });
  }
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    // El documento $metadata describe el ESQUEMA del servicio entero (no
    // datos), así que en OData v4 normalmente se pide en la RAÍZ, sin la
    // empresa en medio. Por si en este entorno hiciera falta con empresa
    // igualmente, se prueban las dos formas.
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4`;
    const candidatosUrl = [`${raiz}/$metadata`, `${raiz}/Company('${empresa}')/$metadata`];
    let r = null;
    const intentosMeta = [];
    for (const urlIntento of candidatosUrl) {
      r = await fetchConReintento(urlIntento, { headers: { Authorization: `Bearer ${token}` } });
      intentosMeta.push(`${urlIntento} → ${r.status}`);
      if (r.ok) break;
    }
    if (!r.ok) {
      const detalle = await r.text();
      return res.status(502).json({ error: `BC respondió ${r.status} al leer $metadata.`, intentos: intentosMeta, detalle: detalle.slice(0, 500) });
    }
    const xml = await r.text();

    // El XML define el EntityType (los campos) y el EntitySet (que
    // apunta al EntityType). El nombre del servicio en la URL es el del
    // EntitySet; a veces coincide con el EntityType y a veces no —
    // buscamos primero el EntitySet para encontrar su EntityType real.
    const reEntitySet = new RegExp(`<EntitySet Name="${servicio}"[^>]*EntityType="[^"]*\\.([^".]+)"`, "i");
    const mSet = xml.match(reEntitySet);
    const nombreEntityType = mSet ? mSet[1] : servicio;

    const reEntityType = new RegExp(`<EntityType Name="${nombreEntityType}"[\\s\\S]*?</EntityType>`, "i");
    const mType = xml.match(reEntityType);
    if (!mType) {
      return res.status(404).json({
        error: `No se encontró el EntityType para el servicio "${servicio}" en $metadata.`,
        pista: "Revisa que el nombre coincide EXACTAMENTE (mayúsculas/minúsculas) con el publicado en BC → Servicios web.",
        entityTypeBuscado: nombreEntityType,
      });
    }
    const bloque = mType[0];

    // Clave declarada: <Key><PropertyRef Name="Campo1"/><PropertyRef Name="Campo2"/></Key>
    const claves = [...bloque.matchAll(/<PropertyRef Name="([^"]+)"/g)].map((m) => m[1]);

    // Todos los campos con su tipo, en orden.
    const campos = [...bloque.matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/g)].map((m) => ({
      nombre: m[1],
      tipo: m[2],
    }));

    res.json({
      servicio,
      entityType: nombreEntityType,
      claveDeclarada: claves,
      ejemploUrlPorClave:
        claves.length > 0
          ? `${servicio}(${claves.map((c) => `${c}='...'`).join(",")})`
          : "Este servicio no declara una clave de un solo/varios campos simples — puede ser de solo lectura (tipo Query) o usar otro mecanismo.",
      totalCampos: campos.length,
      campos,
    });
  } catch (err) {
    console.error("Error /api/bc/diag/metadata:", err);
    res.status(500).json({ error: "Error leyendo $metadata.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 2a-ter) METADATA de la API ESTÁNDAR v2.0 — GET /api/bc/diag/metadata-api?entidad=documentAttachment
// ---------------------------------------------------------------------
// Igual que el diagnóstico anterior pero sobre el OTRO documento
// $metadata: el de la API estándar (api/v2.0), no el de los web
// services de página. Aquí viven entidades como "documentAttachment" y
// "attachment". Además de campos y clave, esta versión también resuelve
// los tipos "enum" (como el de parentType) y lista sus VALORES VÁLIDOS
// reales — así se sabe con certeza si "Purchase Order" existe como
// opción, en vez de suponerlo por analogía con otros documentos.
// ---------------------------------------------------------------------
app.get("/api/bc/diag/metadata-api", async (req, res) => {
  const entidad = (req.query.entidad || "").toString().trim();
  if (!entidad) {
    return res.status(400).json({ error: "Falta ?entidad=NombreDeLaEntidad (ej. documentAttachment)." });
  }
  try {
    const token = await obtenerTokenBC();
    const url = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/$metadata`;
    const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const detalle = await r.text();
      return res.status(502).json({ error: `BC respondió ${r.status} al leer $metadata de la API estándar.`, detalle: detalle.slice(0, 500) });
    }
    const xml = await r.text();

    const reEntitySet = new RegExp(`<EntitySet Name="${entidad}[a-zA-Z]*"[^>]*EntityType="[^"]*\\.([^".]+)"`, "i");
    const mSet = xml.match(reEntitySet);
    const nombreEntityType = mSet ? mSet[1] : entidad;

    const reEntityType = new RegExp(`<EntityType Name="${nombreEntityType}"[\\s\\S]*?</EntityType>`, "i");
    const mType = xml.match(reEntityType);
    if (!mType) {
      return res.status(404).json({
        error: `No se encontró el EntityType "${nombreEntityType}" en el $metadata de la API estándar.`,
        pista: "Prueba con el nombre EN SINGULAR tal como aparece en la documentación de Microsoft (ej. 'documentAttachment', no 'documentAttachments').",
      });
    }
    const bloque = mType[0];

    const claves = [...bloque.matchAll(/<PropertyRef Name="([^"]+)"/g)].map((m) => m[1]);
    const campos = [...bloque.matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/g)].map((m) => ({
      nombre: m[1],
      tipo: m[2],
    }));

    // Para cada campo cuyo tipo NO sea un primitivo Edm.* (o sea, sea un
    // enum propio de BC, como el de parentType), buscamos su definición
    // <EnumType Name="..."> y sacamos los <Member Name="..."/> — esos
    // son los valores de texto REALMENTE aceptados.
    const enumsResueltos = {};
    for (const campo of campos) {
      if (campo.tipo.startsWith("Edm.") || campo.tipo.includes("Collection(")) continue;
      const nombreEnum = campo.tipo.split(".").pop();
      if (enumsResueltos[nombreEnum]) continue;
      const reEnum = new RegExp(`<EnumType Name="${nombreEnum}"[\\s\\S]*?</EnumType>`, "i");
      const mEnum = xml.match(reEnum);
      if (mEnum) {
        const miembros = [...mEnum[0].matchAll(/<Member Name="([^"]+)"/g)].map((m) => m[1]);
        enumsResueltos[nombreEnum] = miembros;
      }
    }

    // Acciones vinculadas a esta entidad (ej. una acción de "Registrar"/
    // "Post" si BC la expone en la API) — se buscan los <Action> cuyo
    // primer parámetro sea del tipo de esta entidad.
    const reAcciones = new RegExp(`<Action Name="([^"]+)" IsBound="true"[^>]*>[\\s\\S]*?Type="[^"]*\\.${nombreEntityType}"[\\s\\S]*?</Action>`, "gi");
    const acciones = [...xml.matchAll(reAcciones)].map((m) => m[1]);

    res.json({
      entidad,
      entityType: nombreEntityType,
      claveDeclarada: claves,
      totalCampos: campos.length,
      campos,
      accionesDisponibles: acciones,
      valoresValidosDeEnums: enumsResueltos,
    });
  } catch (err) {
    console.error("Error /api/bc/diag/metadata-api:", err);
    res.status(500).json({ error: "Error leyendo $metadata de la API estándar.", detalle: String(err.message || err) });
  }
});

// La lista de OTs (página 89) no trae el presupuesto de origen. Ese campo
// («Cód. PR del que procede») está en la ficha de proyecto, ya publicada
// como Ficha_proyecto_Excel. Solo se piden el Nº y ese código.
async function leerPresupuestosProyecto(baseOData, token) {
  const nombre = process.env.BC_WS_FICHA_PROYECTO || "Ficha_proyecto_Excel";
  const campo = "Cód_PR_del_que_procede";
  const select = encodeURIComponent(`No,${campo}`);
  let url = `${baseOData}/${encodeURIComponent(nombre)}?$select=${select}`;
  const mapa = new Map();
  let paginas = 0;
  while (url) {
    const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.warn(`[proyectos] Presupuesto (${nombre}) → ${r.status} ${detalle.slice(0, 180)}`);
      return null;
    }
    const pagina = await r.json();
    paginas += 1;
    for (const f of pagina.value || []) {
      const no = (f.No ?? "").toString().trim();
      const cod = (f[campo] ?? "").toString().trim();
      if (no && cod) mapa.set(no, cod);
    }
    url = pagina["@odata.nextLink"] || "";
  }
  console.log(`[proyectos] Presupuestos leídos: ${mapa.size} (páginas ${paginas})`);
  return mapa;
}

// ---------------------------------------------------------------------
// 2b) PROYECTOS (tabla Job 167, página Job List 89)
//     GET /api/bc/proyectos
// ---------------------------------------------------------------------
// Fuente preferida del listado de OT's: sin Excels. Trae Nº de OT,
// descripción, cliente y el código de línea de negocio (INS-P/I/A).
//
// Se consulta como WEB SERVICE OData de la página 89, porque así se
// exponen TODOS los campos visibles de la página (incluidos los custom
// como "Cód. Línea de negocio"), cosa que la API v2.0 estándar no hace.
//
// REQUISITO (una vez, lo hace el partner o un admin de BC):
//   Buscar "Servicios web" en BC → Nuevo → Tipo de objeto: Página,
//   Id.: 89, Nombre de servicio: JobList → Publicar.
// ---------------------------------------------------------------------
app.get("/api/bc/proyectos", async (req, res) => {
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const baseOData = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;

    // Variantes del nombre del servicio: BC a veces expone "Job List"
    // como "Job_List" en la URL. Probamos todas hasta que una responda.
    const candidatos = [...new Set([
      process.env.BC_WS_JOBLIST,
      "JobList",
      "Job_List",
      "Job List",
    ].filter(Boolean))];

    let filas = null;
    let servicioUsado = null;
    const intentos = [];

    for (const nombre of candidatos) {
      let url = `${baseOData}/${encodeURIComponent(nombre)}`;
      console.log("[proyectos] Probando:", url.replace(process.env.BC_TENANT_ID, "{tenant}"));
      const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
      intentos.push(`${nombre} → ${r.status}`);
      if (!r.ok) continue;

      // Funciona: paginar completo con este nombre
      filas = [];
      let pagina = await r.json();
      filas.push(...(pagina.value || []));
      let next = pagina["@odata.nextLink"];
      while (next) {
        const rp = await fetchConReintento(next, { headers: { Authorization: `Bearer ${token}` } });
        if (!rp.ok) break;
        pagina = await rp.json();
        filas.push(...(pagina.value || []));
        next = pagina["@odata.nextLink"];
      }
      servicioUsado = nombre;
      break;
    }

    // Respaldo: API estándar de proyectos (sin web service). Trae menos
    // campos (sin línea de negocio) pero confirma la conectividad.
    if (!filas) {
      const urlStd = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/projects`;
      console.log("[proyectos] Web service no disponible; probando API estándar /projects");
      const r = await fetchConReintento(urlStd, { headers: { Authorization: `Bearer ${token}` } });
      intentos.push(`api v2.0 projects → ${r.status}`);
      if (r.ok) {
        filas = [];
        let pagina = await r.json();
        filas.push(...(pagina.value || []));
        let next = pagina["@odata.nextLink"];
        while (next) {
          const rp = await fetchConReintento(next, { headers: { Authorization: `Bearer ${token}` } });
          if (!rp.ok) break;
          pagina = await rp.json();
          filas.push(...(pagina.value || []));
          next = pagina["@odata.nextLink"];
        }
        servicioUsado = "api_v2_projects";
      }
    }

    if (!filas) {
      return res.status(502).json({
        error: "Ningún endpoint de proyectos respondió.",
        intentos,
        pistas: [
          "Verificar en BC → Servicios web que la fila (Página, 89) tiene la casilla 'Publicado' realmente marcada",
          "Copiar la columna 'URL de OData V4' de esa fila y compararla con los intentos de arriba",
        ],
      });
    }

    console.log(`[proyectos] OK con "${servicioUsado}" · ${filas.length} filas`);

    // Presupuesto de origen (Cód. PR del que procede). Si la ficha no
    // responde, el listado de OTs sigue saliendo igual, sin ese código.
    try {
      const mapaPR = await leerPresupuestosProyecto(baseOData, token);
      if (mapaPR) {
        let conPresupuesto = 0;
        for (const f of filas) {
          const cod = mapaPR.get((f.No ?? "").toString().trim());
          if (!cod) continue;
          f["Cód_PR_del_que_procede"] = cod;
          conPresupuesto += 1;
        }
        console.log(`[proyectos] Presupuesto asignado a ${conPresupuesto} de ${filas.length} proyectos`);
      }
    } catch (e) {
      console.warn("[proyectos] No se pudieron leer los presupuestos:", String(e.message || e));
    }

    // Filtro opcional por rango de años (el año va en el Nº: "AC014340/2026")
    const { fromYear, toYear } = req.query;
    let filtradas = filas;
    if (fromYear || toYear) {
      const y0 = parseInt(fromYear) || 0;
      const y1 = parseInt(toYear) || 9999;
      filtradas = filas.filter((f) => {
        const no = (f.No ?? "").toString();
        const m = no.match(/\/(\d{4})$/);
        if (!m) return true; // sin año en el Nº: no filtrar
        const y = parseInt(m[1]);
        return y >= y0 && y <= y1;
      });
      console.log(`[proyectos] Filtro años ${y0}-${y1}: ${filtradas.length} de ${filas.length}`);
    }

    res.json({ fuente: "proyectos", servicio: servicioUsado, rows: filtradas.length, totalSinFiltro: filas.length, intentos, data: filtradas });
  } catch (err) {
    console.error("Error /api/bc/proyectos:", err);
    res.status(500).json({ error: "Error interno consultando proyectos.", detalle: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// 2c) LÍNEAS DE UNA OT CONCRETA — GET /api/bc/ot/lineas?no=AC014126/2026
// ---------------------------------------------------------------------
// Trae bajo demanda las líneas de venta y de compra de UNA OT (filtro
// por la dimensión 2). Lo usa la pantalla de detalle de OT para estar
// siempre al día sin precargar rangos enteros.
// ---------------------------------------------------------------------
app.get("/api/bc/ot/lineas", async (req, res) => {
  const { no } = req.query;
  if (!no) return res.status(400).json({ error: "Falta el parámetro no (ej. AC014126/2026)" });
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const filtro = encodeURIComponent(`Shortcut_Dimension_2_Code eq '${no.replace(/'/g, "''")}'`);

    const traer = async (servicio) => {
      let url = `${base}/${encodeURIComponent(servicio)}?$filter=${filtro}`;
      const filas = [];
      while (url) {
        const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) {
          const detalle = await r.text();
          console.error(`[ot/lineas] ${servicio} error:`, r.status, detalle.slice(0, 150));
          return { error: `${servicio} respondió ${r.status}`, filas: [] };
        }
        const pagina = await r.json();
        filas.push(...(pagina.value || []));
        url = pagina["@odata.nextLink"] || null;
      }
      return { filas };
    };

    const [venta, compra] = await Promise.all([
      traer(FUENTES_WS.lineas_venta.servicio),
      traer(FUENTES_WS.lineas_compra.servicio),
    ]);
    console.log(`[ot/lineas] ${no} → venta ${venta.filas.length} · compra ${compra.filas.length}`);
    res.json({
      no,
      venta: venta.filas,
      compra: compra.filas,
      avisos: [venta.error, compra.error].filter(Boolean),
    });
  } catch (err) {
    console.error("Error /api/bc/ot/lineas:", err);
    res.status(500).json({ error: "Error consultando las líneas de la OT.", detalle: String(err.message || err) });
  }
});

// DIAGNÓSTICO de líneas de una OT: qué servicios de BC hay y cuántas líneas
app.get("/api/bc/ot/diagnostico", async (req, res) => {
  const no = String(req.query.no || "").trim();
  if (!no) return res.status(400).json({ error: "Falta no" });
  try {
    const token = await obtenerTokenBC();
    const h = { headers: { Authorization: `Bearer ${token}` } };
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const rc = await fetchConReintento(base, h);
    const catalogo = rc.ok ? ((await rc.json()).value || []).map((x) => x.name) : [];
    const numero = (no.match(/(\d{4,6})\//) || [])[1] || no;
    const candidatos = [...new Set([
      FUENTES_WS.lineas_venta.servicio, FUENTES_WS.lineas_compra.servicio,
      process.env.BC_WS_LINEASVENTA_PFV, "Sales_InvoiceSalesLines_Excel", "SalesInvLines", ...(FUENTES_WS.lineas_venta_reg.servicios || []),
      ...catalogo.filter((n) => /(line|lin)/i.test(n) && /(sales|venta|invoice|factur|pedido|order)/i.test(n)),
    ].filter(Boolean))];
    const salida = [];
    for (const n of candidatos) {
      const fila = { servicio: n, publicado: !catalogo.length || catalogo.includes(n) };
      if (!fila.publicado) { salida.push(fila); continue; }
      try {
        const r1 = await fetchConReintento(`${base}/${encodeURIComponent(n)}?$filter=${encodeURIComponent(`Shortcut_Dimension_2_Code eq '${no.replace(/'/g, "''")}'`)}&$top=500`, h);
        if (r1.ok) fila.conOT = ((await r1.json()).value || []).length; else fila.errorFiltro = `${r1.status}: ${(await r1.text()).slice(0, 160)}`;
        const r2 = await fetchConReintento(`${base}/${encodeURIComponent(n)}?$top=1`, h);
        if (r2.ok) {
          const ej = ((await r2.json()).value || [])[0] || {};
          fila.camposOT = Object.keys(ej).filter((k) => /dimension_2|ot|job|proyecto|obra/i.test(k)).slice(0, 8);
          fila.tieneShortcut2 = "Shortcut_Dimension_2_Code" in ej;
        }
        const r3 = await fetchConReintento(`${base}/${encodeURIComponent(n)}?$filter=${encodeURIComponent(`contains(Description,'${numero}')`)}&$top=50`, h);
        if (r3.ok) fila.enDescripcion = ((await r3.json()).value || []).length;
      } catch (e) { fila.error = String(e.message || e); }
      salida.push(fila);
    }
    res.json({ no, empresa: EMPRESA_NOMBRE(), servicios: salida, totalCatalogo: catalogo.length });
  } catch (err) {
    res.status(500).json({ error: "Error en el diagnóstico.", detalle: String(err.message || err) });
  }
});

app.get("/api/bc/:fuente", async (req, res) => {
  const { fuente } = req.params;
  const { from, to } = req.query;

  // ¿Va por web service de página? (líneas de venta/compra)
  const ws = FUENTES_WS[fuente];
  if (ws) {
    if (!from || !to) return res.status(400).json({ error: "Faltan parámetros from/to (YYYY-MM-DD)." });
    try {
      const token = await obtenerTokenBC();
      const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
      const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
      const cabeceras = { headers: { Authorization: `Bearer ${token}` } };

      const intentos = [];
      let filas = null;
      let campoUsado = null;
      let servicioUsado = null;
      let ultimoError = null;
      let huerfanosOmitidos = [];
      // api_expand (default) = LN/OT reales · ws = revertir al orden anterior
      const modoDim = String(process.env.BC_MOVS_DIM_MODE || "api_expand").trim().toLowerCase() === "ws" ? "ws" : "api_expand";

      const cargarMovsApiExpand = async () => {
        console.log(`[${fuente}] API generalLedgerEntries + dimensionSetLines (modo=${modoDim})`);
        const apiBase = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
        const filtro = `postingDate ge ${from} and postingDate le ${to}`;
        let urlApi = `${apiBase}/companies(${EMPRESA_ID()})/generalLedgerEntries?$filter=${encodeURIComponent(filtro)}&$expand=dimensionSetLines`;
        const out = [];
        while (urlApi) {
          const rp = await fetchConReintento(urlApi, cabeceras);
          if (!rp.ok) {
            intentos.push(`API+expand → ${rp.status}`);
            ultimoError = { status: rp.status, detalle: (await rp.text().catch(() => "")).slice(0, 300), servicio: "generalLedgerEntries+$expand" };
            return false;
          }
          const pagina = await rp.json();
          for (const e of pagina.value || []) {
            const dims = e.dimensionSetLines || [];
            let ln = "";
            let ot = "";
            for (const d of dims) {
              const code = String(d.code || d.dimensionCode || "").trim().toUpperCase();
              const val = String(d.valueCode || d.dimensionValueCode || "").trim();
              if (!val) continue;
              if (code === "OT" || code === "JOB") ot = val;
              else if (code === "LINEA" || code === "LN" || code === "DEPARTMENT") ln = val;
            }
            const debe = Number(e.debitAmount) || 0;
            const haber = Number(e.creditAmount) || 0;
            out.push({
              Entry_No: e.entryNumber,
              Posting_Date: e.postingDate,
              Document_No: e.documentNumber,
              Document_Type: e.documentType,
              G_L_Account_No: e.accountNumber,
              Description: e.description,
              Debit_Amount: debe,
              Credit_Amount: haber,
              Amount: debe - haber,
              Global_Dimension_1_Code: ln,
              Global_Dimension_2_Code: ot,
              Shortcut_Dimension_1_Code: ln,
              Shortcut_Dimension_2_Code: ot,
              Job_No: ot,
            });
          }
          urlApi = pagina["@odata.nextLink"] || null;
        }
        if (!out.length) {
          intentos.push("API+expand → 0 filas");
          return false;
        }
        filas = out;
        servicioUsado = "generalLedgerEntries+$expand=dimensionSetLines";
        campoUsado = "postingDate";
        intentos.push(`API+expand → ${out.length} filas`);
        return true;
      };

      // Movs contabilidad en modo api_expand: API primero (evita G_LEntries sin LN).
      if (fuente === "movs_contabilidad" && modoDim === "api_expand") {
        intentos.push(`modo=${modoDim}`);
        try {
          if (await cargarMovsApiExpand()) {
            console.log(`[${fuente}] OK con "${servicioUsado}" · ${filas.length} filas`);
            return res.json({
              fuente, from, to, rows: filas.length, servicio: servicioUsado,
              campoFecha: campoUsado, sinFecha: false, huerfanosOmitidos, intentos, data: filas,
            });
          }
        } catch (e) {
          intentos.push(`API+expand → error ${String(e.message || e)}`);
          console.warn(`[${fuente}] API+expand falló, se prueba WS:`, String(e.message || e));
        }
      }

      const paginar = async (url) => {
        const out = [];
        let next = url;
        while (next) {
          const rp = await fetchConReintento(next, cabeceras);
          if (!rp.ok) return { error: rp, filas: out };
          const pagina = await rp.json();
          out.push(...(pagina.value || []));
          next = pagina["@odata.nextLink"] || null;
        }
        return { filas: out };
      };

      // Carga completa (sin filtro de fecha) con exclusión automática de
      // documentos HUÉRFANOS: si BC aborta porque una línea perdió su
      // cabecera, se detecta el documento, se excluye y se reintenta.
      const cargaCompleta = async (base) => {
        const excluidos = [];
        for (let i = 0; i <= 12; i++) {
          const filtroExcl = excluidos.map((no) => `Document_No ne '${no.replace(/'/g, "''")}'`).join(" and ");
          const url = base + (filtroExcl ? `?$filter=${encodeURIComponent(filtroExcl)}` : "");
          const r = await paginar(url);
          if (!r.error) return { filas: r.filas, excluidos };
          const st = r.error.status || 0;
          const det = (await r.error.text().catch(() => "")) || "";
          const huerfano = st === 404 && det.match(/No\.\s*=\s*'([^']+)'/);
          if (huerfano) {
            excluidos.push(huerfano[1]);
            console.warn(`[${fuente}] Documento huérfano detectado y excluido: ${huerfano[1]} (reintentando)`);
            continue;
          }
          return { errorStatus: st, errorDetalle: det.slice(0, 300) };
        }
        return { errorStatus: 0, errorDetalle: "Demasiados documentos huérfanos (>12)." };
      };

      // Probar UN servicio: primero con filtro de fecha; si ningún campo
      // de fecha existe y la fuente lo permite, carga completa.
      // Devuelve true si cargó, "no-existe" si 404, false si error.
      const probarServicio = async (servicio) => {
        const base = `${raiz}/${encodeURIComponent(servicio)}`;
        const claveSrv = `${fuente}|${servicio}`;
        const preferido = campoFechaOk.get(claveSrv);
        let campos = preferido
          ? [preferido]
          : ws.camposFecha.filter((c) => !campoFechaMal.has(`${claveSrv}|${c}`));
        if (!campos.length) campos = ws.camposFecha.slice();
        for (const campoFecha of campos) {
          const filtro = `${campoFecha} ge ${from} and ${campoFecha} le ${to}`;
          const url = `${base}?$filter=${encodeURIComponent(filtro)}`;
          console.log(`[${fuente}] Probando "${servicio}" · campo fecha "${campoFecha}"`);
          let r = await fetchConReintento(url, cabeceras);
          for (let n429 = 0; r.status === 429 && n429 < 4; n429++) {
            await r.text().catch(() => "");
            const espera = Math.min(90, Number(r.headers.get("retry-after")) || 15 * (n429 + 1));
            console.warn(`[${fuente}] 429 en "${campoFecha}", espera ${espera}s (${n429 + 1}/4)`);
            intentos.push(`${servicio} · ${campoFecha} → 429, espera ${espera}s`);
            await new Promise((resuelta) => setTimeout(resuelta, espera * 1000));
            r = await fetchConReintento(url, cabeceras);
          }
          intentos.push(`${servicio} · ${campoFecha} → ${r.status}`);

          if (r.status === 404) {
            // Puede ser "servicio no publicado" O un huérfano a mitad de
            // consulta: si el mensaje delata cabecera perdida, pasamos a
            // carga completa (que sabe excluir huérfanos)
            const det = (await r.text().catch(() => "")) || "";
            if (/does not exist|Internal_RecordNotFound/i.test(det) && ws.permitirSinFecha) break;
            return "no-existe";
          }
          if (r.status === 400) {
            campoFechaMal.add(`${claveSrv}|${campoFecha}`);
            if (campoFechaOk.get(claveSrv) === campoFecha) campoFechaOk.delete(claveSrv);
            continue; // el campo no existe: siguiente
          }
          if (!r.ok) {
            ultimoError = { status: r.status, detalle: (await r.text().catch(() => "")).slice(0, 300), servicio };
            return false;
          }

          filas = [];
          let pagina = await r.json();
          filas.push(...(pagina.value || []));
          if (pagina["@odata.nextLink"]) {
            const resto = await paginar(pagina["@odata.nextLink"]);
            filas.push(...resto.filas);
          }
          campoUsado = campoFecha;
          servicioUsado = servicio;
          campoFechaOk.set(claveSrv, campoFecha);
          return true;
        }

        if (ws.permitirSinFecha) {
          console.log(`[${fuente}] "${servicio}" sin campo de fecha filtrable: cargando completo`);
          const r = await cargaCompleta(base);
          if (r.filas) {
            filas = r.filas;
            campoUsado = null;
            servicioUsado = servicio;
            huerfanosOmitidos = r.excluidos;
            intentos.push(`${servicio} · SIN FILTRO → ${filas.length} filas${r.excluidos.length ? ` (${r.excluidos.length} doc. huérfanos omitidos: ${r.excluidos.join(", ")})` : ""}`);
            if (r.excluidos.length) console.warn(`[${fuente}] ⚠ Omitidos huérfanos: ${r.excluidos.join(", ")} — revisar en BC`);
            return true;
          }
          intentos.push(`${servicio} · SIN FILTRO → ${r.errorStatus}`);
          ultimoError = { status: r.errorStatus, detalle: r.errorDetalle, servicio };
          return false;
        }
        return false;
      };

      // 1) Candidatos configurados
      const servicios = ws.servicios || [ws.servicio];
      for (const servicio of servicios) {
        const res = await probarServicio(servicio);
        if (res === true) break;
      }

      // 2) AUTO-DESCUBRIMIENTO: el GET a Company('…') NO lista servicios
      //    (devuelve la entidad empresa). El catálogo está en ODataV4 root.
      if (!filas && ws.descubrir) {
        try {
          console.log(`[${fuente}] Ningún candidato funcionó: consultando el catálogo de servicios de BC...`);
          const raizCatalogo = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4`;
          const rCat = await fetchConReintento(raizCatalogo, cabeceras);
          if (rCat.ok) {
            const cat = await rCat.json();
            const nombres = (cat.value || []).map((v) => v.name || v.url).filter(Boolean);
            const yaProbados = new Set(servicios);
            const coincidentes = nombres.filter((n) => !yaProbados.has(n) && ws.descubrir.every((re) => re.test(n)));
            intentos.push(`descubrimiento → ${coincidentes.length ? coincidentes.join(", ") : "sin coincidencias"}`);
            console.log(`[${fuente}] Catálogo: ${nombres.length} servicios · coinciden: ${coincidentes.join(", ") || "ninguno"}`);
            for (const servicio of coincidentes) {
              const res = await probarServicio(servicio);
              if (res === true) break;
            }
          } else {
            intentos.push(`descubrimiento → catálogo HTTP ${rCat.status}`);
          }
        } catch (e) {
          console.warn(`[${fuente}] Descubrimiento falló:`, String(e.message || e));
        }
      }

      // Fallback API si el WS no dio filas (modo ws, o api_expand que ya falló antes).
      if (!filas && fuente === "movs_contabilidad") {
        intentos.push(`modo=${modoDim}`);
        try { await cargarMovsApiExpand(); } catch (e) {
          intentos.push(`API+expand → error ${String(e.message || e)}`);
          console.warn(`[${fuente}] API+expand falló:`, String(e.message || e));
        }
      }

      if (!filas && ultimoError) {
        const pistas = [];
        if (ultimoError.status === 401 || ultimoError.status === 403) pistas.push(`${ultimoError.status}: permisos insuficientes de la App en BC`);
        if (fuente === "movs_contabilidad") {
          pistas.push("Si el WS da User Setup: revisar ficha de usuario de la App en BC, o se usará el plan B API+dimensiones.");
        }
        return res.status(502).json({ error: `BC respondió ${ultimoError.status} consultando ${ultimoError.servicio}.`, intentos, pistas, detalle: ultimoError.detalle });
      }
      if (!filas) {
        return res.status(502).json({
          error: `Ningún servicio compatible encontrado (probados: ${servicios.join(", ")}${ws.descubrir ? " + catálogo de BC" : ""}).`,
          intentos,
          pistas: [`Ver la lista de intentos (servicio · campo → código). Si el servicio existe con otro nombre, indicarlo en el .env`],
        });
      }

      console.log(`[${fuente}] OK con "${servicioUsado}"${campoUsado ? ` · campo "${campoUsado}"` : " · SIN filtro de fecha (carga completa)"} · ${filas.length} filas`);
      return res.json({
        fuente,
        from,
        to,
        rows: filas.length,
        servicio: servicioUsado,
        campoFecha: campoUsado,
        sinFecha: campoUsado === null,
        huerfanosOmitidos,
        intentos,
        data: filas,
      });
    } catch (err) {
      console.error(`Error /api/bc/${fuente} (WS):`, err);
      return res.status(500).json({ error: "Error interno consultando el web service.", detalle: String(err.message || err) });
    }
  }



  const config = FUENTES_BC[fuente];
  if (!config) return res.status(404).json({ error: `Fuente desconocida: ${fuente}` });
  if (!from || !to) return res.status(400).json({ error: "Faltan parámetros from/to (YYYY-MM-DD)." });

  try {
    const token = await obtenerTokenBC();

    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
    const filtro = `${config.campoFecha} ge ${from} and ${config.campoFecha} le ${to}`;
    let url = `${base}/companies(${EMPRESA_ID()})/${config.entidad}?$filter=${encodeURIComponent(filtro)}`;

    // Paginación OData: BC devuelve @odata.nextLink si hay más páginas
    const filas = [];
    while (url) {
      const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const detalle = await r.text();
        console.error("BC error:", r.status, detalle);
        const pistas = [];
        if (r.status === 404) pistas.push("404: entidad no encontrada — revisar BC_COMPANY_ID (debe ser el de Also Casals) o el nombre de la entidad en FUENTES_BC");
        if (r.status === 400) pistas.push("400: filtro de fecha no válido para esta entidad — revisar campoFecha en FUENTES_BC");
        if (r.status === 401 || r.status === 403) pistas.push(`${r.status}: la App no tiene permisos dentro de BC`);
        return res.status(502).json({ error: `BC respondió ${r.status} consultando ${config.entidad}.`, pistas, detalle: detalle.slice(0, 300) });
      }
      const pagina = await r.json();
      filas.push(...(pagina.value || []));
      url = pagina["@odata.nextLink"] || null;
    }

    // Verificación: confirmar que la extensión expone el campo de OT.
    // Si falta, la unión por OT fallará; avisamos en la respuesta.
    let avisoCampoOT = null;
    const entidadesConOT = ["lineas_venta", "lineas_compra", "movs_contabilidad", "facturas_venta"];
    if (filas.length > 0 && entidadesConOT.includes(fuente) && !(CAMPO_OT_BC in filas[0])) {
      avisoCampoOT = `La entidad "${config.entidad}" no devuelve el campo "${CAMPO_OT_BC}". Revisar el nombre del campo (BC_CAMPO_OT) con el partner.`;
      console.warn("⚠️ ", avisoCampoOT);
    }

    res.json({ fuente, from, to, rows: filas.length, campoOT: CAMPO_OT_BC, avisoCampoOT, data: filas });
  } catch (err) {
    console.error(`Error /api/bc/${fuente}:`, err);
    res.status(500).json({ error: "Error interno consultando Business Central." });
  }
});

// ---------------------------------------------------------------------
// 0c) RECEPCIÓN — SUBIR DOCUMENTO DE PROVEEDOR
// ---------------------------------------------------------------------
// Un único PDF con MUCHAS páginas, de MUCHOS pedidos/proveedores
// seguidos (albaranes de entrega, confirmaciones de pedido...). Flujo
// pensado para revisar "como un libro" — un pedido a la vez, con el
// PDF al lado — antes de tocar BC:
//
//   POST /api/recepcion/extraer  { nombre, base64 }
//     Solo LECTURA en BC (consulta, no escribe). Recorta el PDF en
//     lotes de páginas. Si el lote tiene texto legible, Claude recibe
//     solo el texto; si es un escaneo sin texto, se manda el PDF como
//     documento/imagen.
//     Identifica, por página: NUESTRO Nº de pedido (PCNN-NNNNNN /
//     OCNN-NNNNNN), el Nº de albarán DEL PROVEEDOR y las líneas de
//     material (descripción + cantidad). Agrupa solo las páginas
//     consecutivas de la MISMA entrega: mismo Nº de pedido y mismo Nº
//     de albarán. El mismo proveedor manda a menudo varios albaranes y
//     varios pedidos seguidos; eso NO se junta. Una página sin pedido
//     solo hereda el anterior si es continuación de verdad (sin cabecera
//     nueva). Si trae otro albarán, queda como documento aparte.
//     Por cada grupo CON pedido: genera un PDF independiente (solo esas
//     páginas, en base64, para previsualizar) y, si logra localizar el
//     pedido en BC, trae sus líneas reales y propone el CRUCE con las
//     líneas leídas del documento (cantidad a registrar propuesta =
//     mínimo entre lo leído en el albarán y lo pendiente de recibir).
//     Si ese cruce con BC falla (pedido no encontrado, permisos, etc.)
//     no rompe la respuesta: el grupo se devuelve igual, sin líneas
//     emparejadas, y con el motivo en "bcError" para que se vea.
//
//   POST /api/recepcion/subir-bc
//     { pedido, albaran, pdfBase64, nombreArchivo, lineas: [{lineaId, cantidad}] }
//     Este SÍ escribe en BC, y solo para lo que se le mande confirmado:
//       1. Actualiza "Nº albarán proveedor" y "Su/Ntra. ref." del pedido
//          (los dos con el mismo Nº de albarán).
//       2. Sube el PDF (solo esas páginas) como adjunto en "Archivos de
//          documento entrante" del pedido (Incoming Document).
//       3. Por cada línea confirmada, rellena la "Cantidad a recibir"
//          (receiveQuantity) de esa línea del pedido — NO se registra
//          (postea) nada: la API estándar de BC no ofrece una acción de
//          "solo recibir", solo "Recibir Y facturar" juntas en una, y
//          esta función deja la cantidad puesta, lista para que se
//          registre desde BC.
//     Se llama una vez POR PEDIDO confirmado (no en bloque), para que
//     un fallo en uno no afecte a los demás y quede claro cuál fue.
//
//     ⚠️ SIN CONFIRMAR contra el BC real de Also Casals — probar primero
//     con UN pedido y revisarlo en BC antes de usarlo con un lote grande:
//       · Campo del albarán: se asume "Vendor_Shipment_No" (nombre
//         estándar de BC). Si el PATCH da "property does not exist",
//         hay que mirar el metadata real de "Pedido_compra_Excel".
//       · Adjunto: usa el mecanismo documentado de "Incoming Document"
//         de la API v2.0 (POST .../attachments con parentType
//         "Purchase Order", luego PATCH del contenido binario). Requiere
//         que esa API esté habilitada para la App de Azure.
//       · Líneas: usa purchaseOrderLines (API v2.0), cruzando por
//         documentId. El emparejamiento con lo leído del PDF es por
//         similitud de texto — revisar SIEMPRE en pantalla antes de
//         confirmar, el match puede equivocarse con descripciones parecidas.
// ---------------------------------------------------------------------

// Manda un LOTE de páginas a Claude. Si el PDF tiene texto legible, solo
// se envía el texto (como en Validación de facturas). Si es un escaneo
// sin texto, se manda el PDF como documento/imagen.
async function extraerLotePDF(bytesLotePdf, numPaginasLote) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env.");
  }
  const prompt = `Eres un asistente que lee documentos de proveedores (albaranes de entrega, notas de entrega, confirmaciones de pedido) que llegan escaneados/fotocopiados o exportados a PDF, con MUCHAS páginas seguidas.

Te adjunto un PDF con ${numPaginasLote} página(s), en orden. Lee CADA página por separado. No des por hecho que dos páginas son el mismo documento.

REGLA IMPORTANTE: el mismo proveedor (mismo membrete, mismo logo, mismo nombre) envía a menudo VARIOS albaranes y VARIOS pedidos distintos, uno detrás de otro. Que el proveedor sea el mismo NO significa que sea la misma entrega. No los juntes. No copies el Nº de pedido ni el Nº de albarán de la página anterior si no están impresos en ESTA página.

Para CADA página (numeradas del 1 al ${numPaginasLote} dentro de este PDF), identifica:
1. "pagina": el número de página DENTRO DE ESTE PDF (1, 2, 3...).
2. "pedido": NUESTRO número de pedido de compra, el que esté escrito EN ESTA PÁGINA. Formato "PCNN-NNNNNN" u "OCNN-NNNNNN" (dos letras, dos dígitos de año, guion, 6 dígitos), por ejemplo "PC26-002262". Puede venir como "Su pedido", "Pedido nº", "Referencia", "PO", "Order", "Nuestra referencia", a mano o impreso. Ignora el número de pedido DEL PROVEEDOR (un entero suyo, sin PC ni OCAC). Si en esta página no aparece, pon null. NUNCA rellenes aquí el pedido de la página anterior.
2b. "oferta": NUESTRO número de oferta si está escrito EN ESTA PÁGINA. Empieza por OCAC, por ejemplo "OCAC26-004443". Los proveedores a veces lo ponen donde iría el pedido. Va SOLO aquí, nunca en "pedido". Si no está, pon null.
3. "albaran": el número de albarán / nota de entrega / delivery note DEL PROVEEDOR escrito EN ESTA PÁGINA (su número, no el nuestro). Si esta página tiene cabecera de albarán, este campo es obligatorio: lee el número de ESTA página, aunque el proveedor sea el mismo que el anterior. Si de verdad no hay número, pon null.
4. "esContinuacion": true SOLO si esta página no tiene cabecera propia y es claramente el resto de la tabla de la página anterior (pone "continúa" o "página 2", y no hay un albarán nuevo ni un pedido nuevo). false si la página tiene su propia cabecera, su fecha, su Nº de albarán o su Nº de pedido — aunque el proveedor sea idéntico al de la página anterior. Ante la duda, pon false.
5. "lineas": cada artículo/material de la tabla de ESA página. Cada línea lleva:
   - "descripcion": el texto del artículo, tal cual.
   - "cantidad": la cantidad entregada/enviada, NO el precio ni el importe.
   - "pedido": NUESTRO PC u OC escrito JUNTO A ESA LÍNEA (a mano en el margen o en la descripción, o impreso en la fila). Ejemplos: "PC 26-3776", "PC26-3676". null si esa línea no tiene uno propio.
   - "oferta": NUESTRO número OCAC escrito JUNTO A ESA LÍNEA, si lo hay. null si no.
   Un mismo albarán puede mezclar VARIOS pedidos: una línea con "PC 26-3776" y la siguiente con "PC 26-3938". Pon cada número en SU línea. No copies el PC de una línea a las demás. No inventes un PC. Ignora el número de pedido DEL PROVEEDOR (un entero suyo, sin PC ni OCAC).
   Si el PC o el OCAC está solo en la fila de debajo del artículo (fila en blanco, solo el número manuscrito), es de ESE artículo: ponlo en "pedido" u "oferta" de la línea del artículo y NO crees una línea que sea únicamente el número.
   Si la página tiene UN solo pedido en la cabecera y las líneas no lo repiten, déjalo en el "pedido" de la página y pon null en las líneas.
   Si no hay tabla, "lineas": [].

Responde ÚNICAMENTE con un array JSON, sin texto adicional, backticks ni explicación, un objeto por página EN EL MISMO ORDEN Y CANTIDAD que las páginas del PDF (${numPaginasLote} objetos).

Ejemplo: la página 1 y la 3 son del MISMO proveedor, pero son albaranes y pedidos distintos, así que NO se heredan. La página 2 sí es continuación de la 1. La página 4 es UN albarán con varios PC manuscritos, uno por línea:
[{"pagina":1,"pedido":"PC26-002262","oferta":null,"albaran":"A-99321","esContinuacion":false,"lineas":[{"descripcion":"Tornillo M8 x100","cantidad":100,"pedido":null,"oferta":null}]},{"pagina":2,"pedido":null,"oferta":null,"albaran":null,"esContinuacion":true,"lineas":[{"descripcion":"Tuerca M8","cantidad":100,"pedido":null,"oferta":null}]},{"pagina":3,"pedido":null,"oferta":"OCAC26-004443","albaran":"A-99402","esContinuacion":false,"lineas":[{"descripcion":"Arandela","cantidad":50,"pedido":null,"oferta":null}]},{"pagina":4,"pedido":null,"oferta":null,"albaran":"A/261701","esContinuacion":false,"lineas":[{"descripcion":"ENVASES","cantidad":3,"pedido":"PC 26-3776","oferta":null},{"descripcion":"AEROSOLES","cantidad":27,"pedido":null,"oferta":null},{"descripcion":"BROSSA","cantidad":17,"pedido":"PC26-3676","oferta":null}]}]`;

  let textoPdf = "";
  try {
    const leido = await pdfParse(Buffer.from(bytesLotePdf));
    textoPdf = String(leido?.text || "").replace(/\u0000/g, "").trim();
  } catch { /* PDF escaneado o protegido: se lee como imagen */ }
  const letras = (textoPdf.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const porTexto = letras >= Math.max(120, numPaginasLote * 40);
  console.log(`[recepcion/extraer] lote de ${numPaginasLote} pág. · ${porTexto ? `texto (${letras} caracteres)` : "imagen"}`);

  const cierre = "Responde ÚNICAMENTE con el array JSON. Sin análisis, sin markdown y sin texto antes ni después.";
  const content = porTexto
    ? [{ type: "text", text: `${prompt}\n\nTEXTO DEL PDF (no inventes líneas que no estén aquí):\n${textoPdf.slice(0, 50000)}\n\n${cierre}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytesLotePdf).toString("base64") } },
        { type: "text", text: `${prompt}\n\n${cierre}` },
      ];

  const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const detalle = await response.text();
    throw new Error(`Anthropic respondió ${response.status}: ${detalle.slice(0, 300)}`);
  }
  const data = await response.json();
  const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const limpio = texto.replace(/```json|```/g, "").trim();
  let parseado;
  try {
    parseado = JSON.parse(limpio);
  } catch {
    throw new Error(`No se pudo interpretar la respuesta de la IA para este lote: ${limpio.slice(0, 200)}`);
  }
  return (Array.isArray(parseado) ? parseado : []).map((item) => ({
    pagina: item.pagina,
    pedido: pedidoSiNoEsOferta(item.pedido),
    oferta: normalizarNumOferta(item.oferta) || normalizarNumOferta(item.pedido),
    albaran: item.albaran ? item.albaran.toString().trim() : null,
    // false = esta página es otro documento (aunque sea el mismo proveedor).
    // null = la IA no lo ha dicho; solo entonces se puede heredar el pedido.
    esContinuacion: item.esContinuacion === true || item.esContinuacion === "true" ? true : item.esContinuacion === false || item.esContinuacion === "false" ? false : null,
    lineas: pegarPedidosSueltos(
      (Array.isArray(item.lineas) ? item.lineas : [])
        .map(leerLineaAlbaran)
        .filter((l) => l.descripcion)
    ),
  }));
}

// Clave para comparar albaranes sin que un guion o un espacio los
// haga parecer distintos ("A-100" y "A 100" son el mismo).
function claveAlbaran(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function albaranDistinto(a, b) {
  const na = claveAlbaran(a);
  const nb = claveAlbaran(b);
  if (!na || !nb) return false;
  return na !== nb;
}

// ¿Esta página sigue siendo la misma entrega que el grupo abierto?
// Una entrega puede ocupar varias páginas. Un albarán o un pedido
// distinto —aunque el proveedor sea el mismo— abre otro grupo, y NO
// hereda el Nº de pedido anterior.
function esMismoDocumento(actual, d) {
  if (!actual) return false;
  if (d.pedido && actual.pedido && d.pedido !== actual.pedido) return false;
  if (d.oferta && actual.oferta && d.oferta !== actual.oferta) return false;
  if (albaranDistinto(d.albaran, actual.albaran)) return false;
  if (d.pedido && actual.pedido && d.pedido === actual.pedido) return true;
  if (claveAlbaran(d.albaran) && claveAlbaran(actual.albaran)) return true;
  // Sin números que confirmen que es la misma entrega: solo se hereda
  // el pedido si la página es continuación (sin cabecera propia).
  if (d.esContinuacion === true) return true;
  if (d.esContinuacion === false) return false;
  return !d.pedido && !claveAlbaran(d.albaran);
}

function pedidoConForma(v) {
  const n = normalizarNumPedido(v);
  return /^(PC|OC)\d{2}-\d{6}$/.test(n || "") ? n : null;
}

function tokensPedidoEnTexto(texto) {
  const s = String(texto || "");
  const of = s.match(/OCAC\s*(\d{2})\s*[-/]?\s*(\d{1,7})/i);
  const oferta = of ? normalizarNumOferta(`OCAC${of[1]}-${of[2]}`) : null;
  const sinOferta = of ? s.replace(of[0], " ") : s;
  const pc = sinOferta.match(/(?:^|[^A-Z0-9])(PC|OC)\s*(\d{2})\s*[-/]?\s*(\d{1,7})/i);
  const pedido = pc ? pedidoConForma(`${pc[1]}${pc[2]}-${pc[3]}`) : null;
  return { pedido, oferta };
}

function descripcionSinReferencia(texto) {
  return String(texto || "")
    .replace(/OCAC\s*\d{2}\s*[-/]?\s*\d{1,7}/ig, " ")
    .replace(/(?:^|[^A-Z0-9])(?:PC|OC)\s*\d{2}\s*[-/]?\s*\d{1,7}/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leerLineaAlbaran(l) {
  const descripcion = (l?.descripcion || "").toString().trim();
  const nota = (l?.nota || l?.anotacion || "").toString().trim();
  const tok = tokensPedidoEnTexto(`${descripcion} ${nota} ${l?.pedido || ""} ${l?.oferta || ""}`);
  const pedido = pedidoConForma(l?.pedido) || tokensPedidoEnTexto(l?.pedido).pedido || tok.pedido || null;
  const oferta = normalizarNumOferta(l?.oferta) || normalizarNumOferta(l?.pedido) || tok.oferta || null;
  return { descripcion, cantidad: Number(l?.cantidad) || 0, pedido, oferta };
}

// Una fila que solo contiene el PC manuscrito (debajo del artículo) es de la línea anterior.
function pegarPedidosSueltos(lineas) {
  const out = [];
  for (const l of lineas || []) {
    const tok = tokensPedidoEnTexto(l.descripcion);
    const resto = descripcionSinReferencia(l.descripcion);
    const soloRef = (tok.pedido || tok.oferta) && resto.length < 3;
    if (soloRef && out.length) {
      const prev = out[out.length - 1];
      if (!prev.pedido && (l.pedido || tok.pedido)) prev.pedido = l.pedido || tok.pedido;
      if (!prev.oferta && (l.oferta || tok.oferta)) prev.oferta = l.oferta || tok.oferta;
      continue;
    }
    out.push(l);
  }
  return out;
}

function agruparPorPedido(deteccionesPorPagina) {
  const grupos = [];
  let actual = null;
  for (const d of deteccionesPorPagina) {
    if (!esMismoDocumento(actual, d)) {
      if (actual) grupos.push(actual);
      actual = { pedido: d.pedido || null, oferta: d.oferta || null, ofertaAviso: d.ofertaAviso || null, albaran: d.albaran || null, paginas: [d.pagina], lineas: [...(d.lineas || [])] };
    } else {
      actual.paginas.push(d.pagina);
      if (!actual.albaran && d.albaran) actual.albaran = d.albaran;
      if (!actual.pedido && d.pedido) actual.pedido = d.pedido;
      if (!actual.oferta && d.oferta) actual.oferta = d.oferta;
      if (!actual.ofertaAviso && d.ofertaAviso) actual.ofertaAviso = d.ofertaAviso;
      actual.lineas.push(...(d.lineas || []));
    }
  }
  if (actual) grupos.push(actual);
  return grupos;
}

// Si en la página hay varios PC de línea, el de la cabecera suele ser
// uno de ellos copiado arriba. No debe heredarse al resto.
function olvidarPedidoCabeceraSiLineasDiscrepan(d) {
  const propios = [...new Set((d.lineas || []).map((l) => l.pedido).filter(Boolean))];
  if (propios.length >= 2) return { ...d, pedido: null };
  return d;
}

// Un albarán con varios PC manuscritos se parte en un grupo por pedido.
// Las líneas sin PC no heredan uno: quedan en un grupo para escribirlo a mano.
function partirPorPedidoDeLinea(grupos) {
  const salida = [];
  for (const g of grupos || []) {
    const lineas = g.lineas || [];
    const propios = [...new Set(lineas.map((l) => l.pedido).filter(Boolean))];
    const header = g.pedido || null;
    if (!propios.length) {
      salida.push(g);
      continue;
    }
    const haySinPedido = lineas.some((l) => !l.pedido);
    const varios = propios.length >= 2
      || (propios.length === 1 && header && header !== propios[0])
      || (propios.length === 1 && !header && haySinPedido);
    if (!varios) {
      const pedido = header || propios[0];
      const oferta = g.oferta || lineas.find((l) => l.oferta)?.oferta || null;
      const ofertaAviso = g.ofertaAviso || lineas.find((l) => l.ofertaAviso)?.ofertaAviso || null;
      salida.push({ ...g, pedido, oferta, ofertaAviso });
      continue;
    }
    const cubetas = new Map();
    for (const l of lineas) {
      const clave = l.pedido || (propios.length < 2 && header ? header : "");
      if (!cubetas.has(clave)) cubetas.set(clave, []);
      cubetas.get(clave).push(l);
    }
    if (cubetas.size <= 1) {
      const [clave, ls] = [...cubetas.entries()][0];
      salida.push({ ...g, pedido: clave || null, lineas: ls });
      continue;
    }
    for (const [clave, ls] of cubetas) {
      const oferta = ls.map((l) => l.oferta).find(Boolean) || null;
      const avisos = [...new Set(ls.map((l) => l.ofertaAviso).filter(Boolean))];
      salida.push({
        ...g,
        pedido: clave || null,
        oferta,
        ofertaAviso: avisos.join(" ") || null,
        lineas: ls,
        albaranPartido: true,
      });
    }
  }
  return salida;
}

// --- Emparejar líneas leídas del PDF con las líneas reales del pedido en BC ---
function normTexto(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar acentos
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function puntuarCoincidencia(a, b) {
  const na = normTexto(a), nb = normTexto(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // Comparamos por RAÍZ de palabra (primeros 6 caracteres), no por
  // palabra exacta: absorbe variaciones de género/número típicas del
  // castellano/catalán entre cómo lo escribe el proveedor en el
  // albarán y cómo está la descripción del artículo en BC — p. ej.
  // "intermedia" (como pone el proveedor) vs "intermedio" (como está
  // en BC) para la misma pieza, o singular/plural.
  const raiz = (w) => w.slice(0, 6);
  const palabrasA = new Set(na.split(" ").filter((w) => w.length > 2).map(raiz));
  const palabrasB = new Set(nb.split(" ").filter((w) => w.length > 2).map(raiz));
  if (!palabrasA.size || !palabrasB.size) return 0;
  let comunes = 0;
  for (const w of palabrasA) if (palabrasB.has(w)) comunes++;
  return comunes / Math.max(palabrasA.size, palabrasB.size);
}

// Línea de pedido tal como la pinta Recepción. El precio editable es el
// coste directo (directUnitCost): es el campo que la API v2.0 acepta al
// modificar la línea. unitCost sale calculado y no se escribe.
function numCampoBC(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Campos de precio/descuento de purchaseOrderLines (API v2.0) o OData Pedido_compra_ExcelPurchLines.
 * BC v2.0 reales (PC26-004202): discountPercent, amountExcludingTax, netAmount, directUnitCost.
 * OData: Line_Discount_Percent / Percent_Dto_linea_1 / Line_Amount / Direct_Unit_Cost. */
function preciosLineaPedidoBC(lb) {
  if (!lb) return { precio: null, descuentoPct: null, importeLinea: null, precioNeto: null };
  const precio = numCampoBC(lb.directUnitCost) ?? numCampoBC(lb.Direct_Unit_Cost);
  const descuentoPct =
    numCampoBC(lb.discountPercent) ??
    numCampoBC(lb.lineDiscountPercent) ??
    numCampoBC(lb.Line_Discount_Percent) ??
    numCampoBC(lb.Percent_Dto_linea_1);
  const qty = Number(lb.quantity ?? lb.Quantity) || 0;
  // Importe línea excl. IVA ya neto en BC — no recalcular si BC lo manda.
  let importeLinea =
    numCampoBC(lb.amountExcludingTax) ??
    numCampoBC(lb.netAmount) ??
    numCampoBC(lb.Line_Amount) ??
    numCampoBC(lb.lineAmount);
  if (importeLinea == null && precio != null && qty && descuentoPct != null) {
    importeLinea = Math.round(qty * precio * (1 - descuentoPct / 100) * 100) / 100;
  }
  const precioNeto = (precio != null && descuentoPct != null)
    ? Math.round(precio * (1 - descuentoPct / 100) * 1000) / 1000
    : null;
  return { precio, descuentoPct, importeLinea, precioNeto };
}

function pendienteFacturarLineaBC(lb, recibida, facturada) {
  if (numCampoBC(lb?.invoiceQuantity) != null) return Math.max(0, Number(lb.invoiceQuantity) || 0);
  if (numCampoBC(lb?.Qty_to_Invoice) != null) return Math.max(0, Number(lb.Qty_to_Invoice) || 0);
  return Math.max(0, (Number(recibida) || 0) - (Number(facturada) || 0));
}

function resumenLineaPedidoBC(lb) {
  const pedida = Number(lb.quantity) || 0;
  const recibida = Number(lb.receivedQuantity) || 0;
  const facturada = Number(lb.invoicedQuantity ?? lb.Quantity_Invoiced) || 0;
  const pendienteFacturar = pendienteFacturarLineaBC(lb, recibida, facturada);
  const { precio, descuentoPct, importeLinea, precioNeto } = preciosLineaPedidoBC(lb);
  return {
    id: lb.id,
    codigo: lb.lineObjectNumber || lb.No || "",
    descripcion: lb.description || lb.Description || "",
    cantidadPedida: pedida,
    cantidadRecibida: recibida,
    cantidadFacturada: facturada,
    cantidadPendienteFacturar: pendienteFacturar,
    cantidadPendiente: Math.max(0, pedida - recibida),
    precio,
    precioBC: precio,
    directUnitCost: precio,
    descuentoPct,
    discountPercent: descuentoPct,
    importeLinea,
    amountExcludingTax: importeLinea,
    netAmount: importeLinea,
    precioNeto,
  };
}

// Devuelve, por cada línea leída del PDF, la línea de BC más parecida
// (si la hay) y una cantidad a registrar propuesta (mínimo entre lo
// leído y lo que quede pendiente de recibir en esa línea de BC).
function emparejarLineas(lineasAlbaran, lineasBC) {
  const usadas = new Set();
  return (lineasAlbaran || []).map((la) => {
    let mejor = null, mejorPunt = 0;
    for (const lb of lineasBC || []) {
      if (usadas.has(lb.id)) continue;
      const punt = Math.max(
        puntuarCoincidencia(la.descripcion, lb.description),
        puntuarCoincidencia(la.descripcion, lb.lineObjectNumber)
      );
      if (punt > mejorPunt) { mejorPunt = punt; mejor = lb; }
    }
    if (mejor && mejorPunt >= 0.35) usadas.add(mejor.id);
    const lineaBC = mejor ? resumenLineaPedidoBC(mejor) : null;
    return {
      descripcionAlbaran: la.descripcion,
      cantidadAlbaran: la.cantidad,
      lineaBC,
      coincidencia: !mejor ? "sin_match" : mejorPunt >= 0.7 ? "alta" : "media",
      cantidadARegistrar: lineaBC ? Math.min(Number(la.cantidad) || 0, lineaBC.cantidadPendiente) : 0,
    };
  });
}

// Departamento (dimensión 1) y OT (dimensión 2) de la cabecera del pedido.
// La API v2.0 no trae Shortcut_Dimension_*; están en Pedido_compra_Excel.
async function dimensionesCabeceraPedido(numero, token) {
  try {
    const raiz = raizODataBC();
    const servicio = FUENTES_WS.pedidos_compra.servicio;
    const esc = String(numero || "").replace(/'/g, "''");
    const filtro = `Document_Type eq 'Order' and No eq '${esc}'`;
    const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}&$select=Shortcut_Dimension_1_Code,Shortcut_Dimension_2_Code&$top=1`;
    const r = await fetchConReintento(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) return { departamento: "", ot: "" };
    const cab = ((await r.json()).value || [])[0] || {};
    return {
      departamento: String(cab.Shortcut_Dimension_1_Code || "").trim(),
      ot: String(cab.Shortcut_Dimension_2_Code || "").trim(),
    };
  } catch {
    return { departamento: "", ot: "" };
  }
}

// Busca el pedido en la API estándar v2.0 y trae sus líneas de tipo
// artículo. Solo LECTURA. Si algo falla, no lanza — devuelve {error}.
async function buscarPedidoYLineasBC(pedido) {
  try {
    const token = await obtenerTokenBC();
    const cabeceras = { Authorization: `Bearer ${token}` };
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
    const urlBusca = `${base}/companies(${EMPRESA_ID()})/purchaseOrders?$filter=${encodeURIComponent(`number eq '${pedido.replace(/'/g, "''")}'`)}`;
    const rBusca = await fetchConReintento(urlBusca, { headers: cabeceras });
    if (!rBusca.ok) return { error: `BC respondió ${rBusca.status} buscando el pedido en purchaseOrders.` };
    const datosBusca = await rBusca.json();
    const cabecera = (datosBusca.value || [])[0];
    if (!cabecera) return { error: `Pedido "${pedido}" no encontrado en purchaseOrders (api/v2.0).` };

    const urlLineas = `${base}/companies(${EMPRESA_ID()})/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${cabecera.id}`)}`;
    const [rLineas, dims] = await Promise.all([
      fetchConReintento(urlLineas, { headers: cabeceras }),
      dimensionesCabeceraPedido(cabecera.number || pedido, token),
    ]);
    // vendorNumber: sin $select, así que si el campo existe en el
    // pedido ya viene en "cabecera" — nombre estándar de la API v2.0,
    // sin confirmar todavía contra este BC en concreto (a diferencia de
    // vendorName, que sí se usa ya en producción).
    const vendorNumber = cabecera.vendorNumber || cabecera.buyFromVendorNumber || null;
    if (!rLineas.ok) return { error: `BC respondió ${rLineas.status} obteniendo las líneas del pedido.`, purchaseOrderId: cabecera.id, vendorName: cabecera.vendorName || null, vendorNumber, departamento: dims.departamento, ot: dims.ot };
    const datosLineas = await rLineas.json();
    // TODAS las líneas del pedido, del tipo que sean (Artículo, Cargo
    // (Prod.), Cuenta contable, etc.) — antes solo se cogían las de tipo
    // "Item" y luego solo se añadió "Charge (Item)", así que cualquier
    // otro tipo (como el cargo de "TRANSPORTE" de la factura
    // SI2613448_SOL) podía seguir sin aparecer nunca como línea
    // disponible para cruzar/elegir, aunque sí existiera en el pedido.
    // Solo se descarta la fila en blanco que la API v2.0 suele añadir al
    // final de purchaseOrderLines (sin tipo ni descripción ni cantidad).
    const lineas = (datosLineas.value || []).filter(
      (l) => l.lineType || l.description || Number(l.quantity) || l.lineObjectNumber
    );
    const totalPedido = numCampoBC(cabecera.totalAmountExcludingTax);
    return {
      purchaseOrderId: cabecera.id,
      vendorName: cabecera.vendorName || null,
      vendorNumber,
      departamento: dims.departamento,
      ot: dims.ot,
      lineasBC: lineas,
      // Base imponible del pedido en BC (tras descuentos de línea).
      totalAmountExcludingTax: totalPedido,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function importePedidoDesdeLineasBC(lineasBC) {
  if (!Array.isArray(lineasBC) || !lineasBC.length) return null;
  let sum = 0;
  let hay = false;
  for (const l of lineasBC) {
    const { importeLinea } = preciosLineaPedidoBC(l);
    if (importeLinea == null) continue;
    hay = true;
    sum += importeLinea;
  }
  return hay ? Math.round(sum * 100) / 100 : null;
}

app.get("/api/recepcion/vista.pdf", (req, res) => {
  const item = vistasPdfRecepcion.get(String(req.query.id || ""));
  if (!item || item.expira < Date.now()) {
    res.status(404).type("text/plain").send("La vista previa ha caducado. Vuelve a cargar el documento.");
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=\"albaran.pdf\"");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(item.bytes);
});

app.post("/api/recepcion/extraer", async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  try {
    const { nombre, base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: "Falta el campo 'base64' con el PDF." });

    const dataBuffer = Buffer.from(base64, "base64");
    // ignoreEncryption: true (Maria, 2026-09-04) — algunas facturas de
    // proveedor llegan como PDF con protección/encriptación (aunque sin
    // contraseña para abrirlas a la vista), y pdf-lib por defecto
    // rechaza cargarlas con "Input document to `PDFDocument.load` is
    // encrypted" — no es un PDF corrupto, solo protegido.
    const srcPdf = await PDFDocument.load(dataBuffer, { ignoreEncryption: true });
    const totalPaginas = srcPdf.getPageCount();
    if (!totalPaginas) {
      return res.status(400).json({ error: "El PDF no tiene páginas." });
    }

    console.log(`[recepcion/extraer] "${nombre || "documento"}" · ${totalPaginas} páginas · pidiendo a la IA por lotes...`);

    // Lotes de páginas: se manda cada lote COMO PDF (no como texto) para
    // que Claude lea también documentos escaneados/fotocopiados.
    const LOTE = 8;
    const detecciones = [];
    for (let inicio = 0; inicio < totalPaginas; inicio += LOTE) {
      const indices = [];
      for (let p = inicio; p < Math.min(inicio + LOTE, totalPaginas); p++) indices.push(p);
      const lotePdf = await PDFDocument.create();
      const copiadas = await lotePdf.copyPages(srcPdf, indices);
      copiadas.forEach((p) => lotePdf.addPage(p));
      const bytesLote = await lotePdf.save();

      const resultadoLote = await extraerLotePDF(bytesLote, indices.length);
      resultadoLote.forEach((item, i) => {
        detecciones.push({ ...item, pagina: inicio + i + 1 }); // número de página REAL en el documento completo
      });
    }

    const deteccionesResueltas = (await resolverOfertasEnDetecciones(detecciones)).map(olvidarPedidoCabeceraSiLineasDiscrepan);
    const grupos = partirPorPedidoDeLinea(agruparPorPedido(deteccionesResueltas));

    // Por cada grupo CON pedido identificado: PDF independiente (solo
    // sus páginas del documento ORIGINAL, para previsualizar) + cruce
    // de líneas con BC.
    const gruposFinal = [];
    for (const g of grupos) {
      // Vista previa también si el albarán se ha separado pero aún no
      // tiene Nº de pedido: así se puede escribir a mano, sin haberlo
      // juntado con el pedido anterior del mismo proveedor.
      let pdfBase64 = null;
      let pdfVista = null;
      if (g.paginas.length) {
        const nuevo = await PDFDocument.create();
        const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
        copiadas.forEach((p) => nuevo.addPage(p));
        const bytes = await guardarPdfParaBc(nuevo);
        pdfBase64 = Buffer.from(bytes).toString("base64");
        pdfVista = guardarVistaPdfRecepcion(bytes);
      }
      if (!g.pedido) {
        gruposFinal.push({ ...g, pdfBase64, pdfVista, lineasEmparejadas: [], lineasDisponiblesBC: [], vendorName: null, bcError: null });
        continue;
      }

      const bc = await buscarPedidoYLineasBC(g.pedido);
      const lineasEmparejadas = bc.lineasBC ? emparejarLineas(g.lineas, bc.lineasBC) : [];
      // AÑADIDO: lista de TODAS las líneas del pedido en BC (no solo la
      // emparejada), para que en pantalla se pueda elegir a mano la
      // línea correcta cuando el emparejamiento automático falla o se
      // equivoca — no depende ya de que el texto encaje solo.
      const lineasDisponiblesBC = (bc.lineasBC || []).map(resumenLineaPedidoBC);

      gruposFinal.push({
        ...g,
        pdfBase64,
        pdfVista,
        vendorName: bc.vendorName || null,
        departamento: bc.departamento || "",
        ot: bc.ot || "",
        bcError: bc.error || null,
        lineasEmparejadas,
        lineasDisponiblesBC,
      });
    }

    const identificados = gruposFinal.filter((g) => g.pedido).length;
    console.log(`[recepcion/extraer] ${identificados} pedido(s) identificado(s) de ${totalPaginas} páginas`);
    res.json({ paginas: totalPaginas, grupos: gruposFinal });
  } catch (err) {
    console.error("Error /api/recepcion/extraer:", err);
    res.status(500).json({ error: "Error extrayendo los pedidos del documento.", detalle: String(err.message || err) });
  }
});

function depsPrepararRecepcion() {
  return {
    obtenerTokenBC,
    fetchConReintento,
    empresaId: EMPRESA_ID,
    empresaNombre: EMPRESA_NOMBRE,
    pdfDocument: PDFDocument,
    guardarVistaPdf: guardarVistaPdfRecepcion,
    leerVistaPdf: leerVistaPdfRecepcion,
    servicioPedidos: FUENTES_WS.pedidos_compra.servicio,
    ponerOtEnLineaApi,
    escribirOtPedidoCompra,
    reabrirPedidoCompraSiLanzado,
    lanzarPedidoCompra,
    escribirAlbaranPedido: async (numero, albaran, token) => {
      const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
      const raizWS = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
      const clave = `(Document_Type='Order',No='${String(numero).replace(/'/g, "''")}')`;
      const r = await fetchConReintento(`${raizWS}/${encodeURIComponent(FUENTES_WS.pedidos_compra.servicio)}${clave}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "If-Match": "*" },
        body: JSON.stringify({ Vendor_Shipment_No: String(albaran) }),
      });
      if (r.ok) return null;
      return `No se ha podido guardar el nº de albarán: ${(await r.text().catch(() => "")).slice(0, 160)}`;
    },
  };
}

// Lee un albarán, busca si el pedido de ese proveedor y esa OT ya existe
// y propone artículo, cantidad, precio y descuento. No escribe en BC.
app.post("/api/recepcion/preparar", async (req, res) => {
  try {
    const out = await prepararRecepcionAlbaran(depsPrepararRecepcion(), req.body || {});
    res.json(out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("Error /api/recepcion/preparar:", err);
    res.status(status).json({ error: err.message || "No se ha podido preparar el pedido.", detalle: status >= 500 ? String(err.message || err) : undefined });
  }
});

// Familias del alta (GoCatalog): nivel 1, y 2/3 según la elegida arriba.
app.get("/api/recepcion/preparar/familias", async (req, res) => {
  try {
    if (!acfactory.configurado()) return res.status(503).json({ error: "No puedo cargar las familias desde aquí." });
    const nivel = Math.min(Math.max(Number(req.query.nivel) || 1, 1), 3);
    const items = await acfactory.buscarGoCatalog({
      nivel,
      padre: String(req.query.padre || "").trim() || undefined,
      abuelo: String(req.query.abuelo || "").trim() || undefined,
      q: String(req.query.q || "").trim() || undefined,
      top: 300,
    }, fetchConReintento);
    res.json({
      items: (items || []).map((x) => ({
        code: String(x.code || x.name || x.label || "").trim(),
        name: String(x.name || x.label || x.code || "").trim(),
      })).filter((x) => x.code && x.name),
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("Error /api/recepcion/preparar/familias:", err);
    res.status(status).json({ error: err.message || "No se han podido cargar las familias." });
  }
});

// Alta de un artículo que no está en el catálogo. La línea del pedido no se escribe aquí.
app.post("/api/recepcion/preparar/articulo", async (req, res) => {
  try {
    const descripcion = String(req.body?.descripcion || "").trim();
    if (!descripcion) return res.status(400).json({ error: "Falta la descripción del artículo." });
    const cat1 = String(req.body?.cat1 || "").trim();
    const cat2 = String(req.body?.cat2 || "").trim();
    const cat3 = String(req.body?.cat3 || "").trim();
    if (!cat1 || !cat2 || !cat3) return res.status(400).json({ error: "Elige las tres familias del artículo." });
    if (!acfactory.configurado()) return res.status(503).json({ error: "No puedo crear artículos desde aquí." });
    const resolved = await acfactory.resolverGoCatalog({ cat1, cat2, cat3 }, fetchConReintento);
    const u = req.usuario || {};
    const datos = {
      displayName: descripcion.slice(0, 100),
      type: "Inventory",
      baseUnitOfMeasureCode: "UD",
      cat1: resolved.cat1,
      cat2: resolved.cat2,
      cat3: resolved.cat3,
      usuario: {
        id: u.id,
        username: u.username,
        nombre: u.nom_treballador || u.nombre || u.username || "desconocido",
      },
    };
    const ref = String(req.body?.codigoProveedor || "").trim();
    if (ref) datos.refFabricant = ref;
    const imagen = String(req.body?.imagenBase64 || "");
    if (imagen) {
      if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(imagen)) {
        return res.status(400).json({ error: "La imagen del producto no es válida." });
      }
      if (imagen.length > 6 * 1024 * 1024) {
        return res.status(400).json({ error: "La imagen pesa demasiado. Pega una foto más pequeña." });
      }
      datos.imagenBase64 = imagen;
    }
    const data = await acfactory.crearProducto(datos, fetchConReintento);
    const numero = data?.number || data?.also?.number || data?.producto?.number || data?.bc?.number || "";
    if (!numero) return res.status(502).json({ error: "El alta no ha devuelto el número del artículo." });
    res.json({ numero, descripcion: data?.also?.displayName || data?.displayName || descripcion });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("Error /api/recepcion/preparar/articulo:", err);
    res.status(status).json({ error: err.message || "No se ha podido crear el artículo." });
  }
});

// Crea el pedido, o añade las líneas que faltan, solo si la usuaria confirma.
app.post("/api/recepcion/preparar/crear", async (req, res) => {
  try {
    const out = await crearPedidoPreparado(depsPrepararRecepcion(), req.body || {});
    if (out?.numero) out.enlace = enlacePedidoCompraBC(out.numero);
    res.json(out);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("Error /api/recepcion/preparar/crear:", err);
    res.status(status).json({ error: err.message || "No se ha podido crear el pedido." });
  }
});

// Abre la ficha del pedido de compra en el cliente web de BC.
app.get("/api/recepcion/enlace-pedido", (req, res) => {
  const n = String(req.query.n || "").trim();
  const enlace = enlacePedidoCompraBC(n);
  if (!enlace) return res.status(400).json({ error: "Falta el número de pedido." });
  res.redirect(enlace);
});

function normalizarNumOferta(v) {
  const s = String(v || "").trim().toUpperCase();
  const m = s.match(/^OCAC\s*(\d{2})\s*[-/]?\s*(\d{1,7})$/);
  if (!m) return null;
  return `OCAC${m[1]}-${String(m[2]).padStart(6, "0")}`;
}

function pedidoSiNoEsOferta(v) {
  if (normalizarNumOferta(v)) return null;
  return normalizarNumPedido(v);
}

function normalizarNumPedido(v) {
  const s = String(v || "").trim().toUpperCase();
  const m = s.match(/^(PC|OC)\s*(\d{2})\s*[-/]?\s*(\d{1,7})$/i);
  if (m) return `${m[1].toUpperCase()}${m[2]}-${String(m[3]).padStart(6, "0")}`;
  return s || null;
}

// Nº oferta de la cabecera de pedido de compra. En Pedido_compra_Excel
// el campo es Quote_No (columna «Nº oferta» de Pedidos de compra). No es
// el Nº de oferta del proveedor ni el Nº del pedido.
async function buscarPedidoPorOferta(oferta) {
  const numero = normalizarNumOferta(oferta);
  if (!numero) return { aviso: "El número no tiene formato de Nº de oferta (OCAC…)." };
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const servicio = FUENTES_WS.pedidos_compra.servicio;
    const filtro = `Document_Type eq 'Order' and Quote_No eq '${numero.replace(/'/g, "''")}'`;
    const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}&$select=No,Quote_No`;
    const r = await fetchConReintento(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) {
      const txt = (await r.text().catch(() => "")).slice(0, 180);
      return { aviso: `No se ha podido buscar el Nº de oferta ${numero} en pedidos de compra (BC ${r.status}). ${txt}` };
    }
    const pedidos = [...new Set(((await r.json()).value || []).map((x) => String(x.No || "").trim()).filter(Boolean))];
    if (!pedidos.length) return { aviso: `Ningún pedido de compra tiene el Nº de oferta ${numero}.` };
    if (pedidos.length > 1) return { aviso: `Varios pedidos tienen el Nº de oferta ${numero}: ${pedidos.join(", ")}. No se elige uno solo; escribe el PC.` };
    return { pedido: pedidos[0], oferta: numero };
  } catch (e) {
    return { aviso: `No se ha podido buscar el Nº de oferta ${numero}: ${String(e.message || e)}` };
  }
}

function aplicarOfertaResuelta(pedido, oferta, mapa) {
  if (!oferta) return { pedido: pedido || null, oferta: null, ofertaAviso: null };
  const r = mapa.get(oferta);
  if (r?.pedido && !pedido) return { pedido: r.pedido, oferta, ofertaAviso: null };
  if (r?.pedido && pedido && r.pedido !== pedido) {
    return { pedido, oferta, ofertaAviso: `El Nº de oferta ${oferta} corresponde al pedido ${r.pedido}, pero el documento también pone ${pedido}. Se usa ${pedido}.` };
  }
  if (!r?.pedido) return { pedido: pedido || null, oferta, ofertaAviso: r?.aviso || `Ningún pedido de compra tiene el Nº de oferta ${oferta}.` };
  return { pedido, oferta, ofertaAviso: null };
}

async function resolverOfertasEnDetecciones(detecciones) {
  const ofertas = new Set();
  for (const d of detecciones) {
    if (d.oferta) ofertas.add(d.oferta);
    for (const l of d.lineas || []) if (l.oferta) ofertas.add(l.oferta);
  }
  const mapa = new Map();
  for (const ofe of ofertas) mapa.set(ofe, await buscarPedidoPorOferta(ofe));
  return detecciones.map((d) => {
    const cab = aplicarOfertaResuelta(d.pedido, d.oferta, mapa);
    const lineas = (d.lineas || []).map((l) => ({ ...l, ...aplicarOfertaResuelta(l.pedido, l.oferta, mapa) }));
    return { ...d, ...cab, lineas };
  });
}

app.post("/api/recepcion/cruzar", async (req, res) => {
  const escrito = String(req.body?.pedido || "").trim();
  const oferta = normalizarNumOferta(escrito);
  let pedido = oferta ? null : normalizarNumPedido(escrito);
  let ofertaAviso = null;
  if (oferta) {
    const hallado = await buscarPedidoPorOferta(oferta);
    if (!hallado.pedido) {
      return res.json({
        pedido: "",
        oferta,
        ofertaAviso: hallado.aviso,
        vendorName: null,
        bcError: hallado.aviso,
        lineasEmparejadas: [],
        lineasDisponiblesBC: [],
      });
    }
    pedido = hallado.pedido;
  }
  const lineasPdf = Array.isArray(req.body?.lineasPdf) ? req.body.lineasPdf : [];
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });
  try {
    const bc = await buscarPedidoYLineasBC(pedido);
    const lineasEmparejadas = bc.lineasBC ? emparejarLineas(lineasPdf, bc.lineasBC) : [];
    const lineasDisponiblesBC = (bc.lineasBC || []).map(resumenLineaPedidoBC);
    res.json({ pedido, oferta, ofertaAviso, vendorName: bc.vendorName || null, departamento: bc.departamento || "", ot: bc.ot || "", bcError: bc.error || null, lineasEmparejadas, lineasDisponiblesBC });
  } catch (err) {
    res.status(500).json({ error: "No se pudo cruzar el pedido con BC.", detalle: String(err.message || err) });
  }
});

// Registrar la recepción desde la tabla (sin albarán ni PDF).
// Marca la cantidad a recibir de las líneas indicadas y ejecuta «Recibir».
// No contabiliza la factura de compra.
app.post("/api/recepcion/registrar", async (req, res) => {
  const pedido = String(req.body?.pedido || "").trim();
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });
  const pedidas = Array.isArray(req.body?.lineas) ? req.body.lineas : null;
  try {
    const token = await obtenerTokenBC();
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const esc = pedido.replace(/'/g, "''");
    const busca = await fetchConReintento(
      `${urlApiComprasBC()}/purchaseOrders?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$top=1&$select=id,number,status,fullyReceived`,
      { headers }
    );
    if (!busca.ok) {
      const detalle = (await busca.text().catch(() => "")).slice(0, 300);
      return res.status(502).json({ error: `BC respondió ${busca.status} al buscar el pedido.`, detalle });
    }
    const cab = ((await busca.json()).value || [])[0];
    if (!cab?.id) return res.status(404).json({ error: `Pedido ${pedido} no encontrado en Business Central.` });
    if (cab.fullyReceived) return res.status(409).json({ error: "El pedido ya está recibido entero." });

    // En API v2 a veces sale "Draft" aunque en Pedido_compra_Excel el Status
    // sea Released. La acción Microsoft.NAV.release no está publicada (404).
    // Si la ficha ya está lanzada, o si release no existe, se continúa.
    const estado = String(cab.status || "");
    let estadoFicha = "";
    try {
      const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
      const raizWS = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
      const clave = `(Document_Type='Order',No='${pedido.replace(/'/g, "''")}')`;
      const rSt = await fetchConReintento(`${raizWS}/${encodeURIComponent(FUENTES_WS.pedidos_compra.servicio)}${clave}?$select=Status`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (rSt.ok) estadoFicha = String((await rSt.json()).Status || "");
    } catch { /* se usa solo el de la API */ }
    const yaLanzado = /^released$/i.test(estado) || /^released$/i.test(estadoFicha);
    if (!yaLanzado && /^draft$|^in review$/i.test(estado)) {
      const rel = await accionPedidoEnCualquierApi(cab.id, "release", token);
      if (!rel.ok && !/already|ya.*lanzad|released/i.test(String(rel.texto || ""))) {
        if (!esAccionAusente(rel.status, rel.texto)) {
          return res.status(502).json({ error: `El pedido está abierto y no se ha podido lanzar antes de recibir. ${textoErrorBC(rel.texto)}` });
        }
        console.warn(`[recepcion/registrar] ${pedido}: release no disponible (API ${rel.status}, ficha=${estadoFicha || "—"}); se continúa.`);
      }
    }

    const rLin = await fetchConReintento(
      `${urlApiComprasBC()}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${cab.id}`)}&$select=id,sequence,lineType,lineObjectNumber,description,quantity,receivedQuantity,receiveQuantity`,
      { headers }
    );
    if (!rLin.ok) {
      const detalle = (await rLin.text().catch(() => "")).slice(0, 300);
      return res.status(502).json({ error: `BC respondió ${rLin.status} al leer las líneas.`, detalle });
    }
    const bcLineas = (await rLin.json()).value || [];
    const porSeq = new Map();
    if (pedidas) {
      for (const l of pedidas) {
        const seq = Number(l.lineNo);
        const cant = Number(l.cantidad);
        if (!Number.isFinite(seq) || !(cant > 0)) continue;
        porSeq.set(seq, (porSeq.get(seq) || 0) + cant);
      }
    }

    const patchHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" };
    let reabierto = false;
    const aplicadas = [];
    for (const l of bcLineas) {
      const qty = Number(l.quantity) || 0;
      const rec = Number(l.receivedQuantity) || 0;
      const pend = Math.max(0, Math.round((qty - rec) * 1000) / 1000);
      const esMaterial = /item|charge/i.test(String(l.lineType || ""));
      let querer = 0;
      if (pedidas) {
        if (porSeq.has(Number(l.sequence))) querer = Math.min(porSeq.get(Number(l.sequence)), pend);
      } else if (pend > 0 && esMaterial) {
        querer = pend;
      }
      if (Number(l.receiveQuantity) !== querer) {
        const urlLinea = `${urlApiComprasBC()}/purchaseOrderLines(${l.id})`;
        const cuerpo = JSON.stringify({ receiveQuantity: querer });
        let rP = await fetchConReintento(urlLinea, { method: "PATCH", headers: patchHeaders, body: cuerpo });
        let detalleFallo = rP.ok ? "" : await rP.text().catch(() => "");
        if (!rP.ok && /Status must be equal to 'Open'/i.test(detalleFallo) && !reabierto) {
          const re = await reabrirPedidoCompra(cab.id, token);
          if (!re.ok) return res.status(502).json({ error: re.error });
          reabierto = true;
          rP = await fetchConReintento(urlLinea, { method: "PATCH", headers: patchHeaders, body: cuerpo });
          detalleFallo = rP.ok ? "" : await rP.text().catch(() => "");
        }
        if (!rP.ok) {
          return res.status(502).json({ error: `No se ha podido marcar la cantidad a recibir de la línea ${l.sequence}. ${textoErrorBC(detalleFallo)}` });
        }
      }
      if (querer > 0) {
        aplicadas.push({
          lineNo: l.sequence,
          articulo: l.lineObjectNumber || "",
          descripcion: l.description || "",
          cantidad: querer,
        });
      }
    }
    if (!aplicadas.length) return res.status(400).json({ error: "No hay cantidad pendiente que registrar en este pedido." });

    if (reabierto) {
      const rel = await lanzarPedidoCompra(cab.id, token);
      if (!rel.ok) return res.status(502).json({ error: rel.error });
    }

    const recibo = await registrarRecepcionPorApi(cab.id, token, pedido);
    if (!recibo.ok) {
      const fb = await registrarPedidoPorServicio(pedido);
      if (!fb.ok) {
        return res.status(502).json({
          error: `No se ha registrado la recepción. ${textoErrorBC(recibo.texto) || recibo.hint || ""} ${fb.error || ""}`.trim(),
        });
      }
    }
    console.log(`[recepcion/registrar] OK ${pedido} · ${aplicadas.map((l) => `${l.articulo || l.lineNo}:${l.cantidad}`).join(", ")}`);
    res.json({ ok: true, pedido, lineas: aplicadas, via: recibo.ok ? (recibo.viaApi || "api") : "playwright" });
  } catch (err) {
    console.error("Error /api/recepcion/registrar:", err);
    res.status(500).json({ error: "No se pudo registrar la recepción.", detalle: String(err.message || err) });
  }
});

app.post("/api/recepcion/subir-bc", async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  const { pedido, albaran, pdfBase64, nombreArchivo, lineas, nuevasLineas } = req.body || {};
  const registrar = req.body?.registrar !== false; // «Subir este pedido en BC» = subir sin registrar
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });

  const resultado = { pedido, version: "subir-bc-v9-reabrir", albaran: { ok: false }, referencia: null, adjunto: { ok: false }, lineas: [] };

  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const cabeceras = { Authorization: `Bearer ${token}` };
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;

    // ✅ CONFIRMADO FUNCIONANDO contra el BC real de Also Casals (31/08/2026)
    // — la clave es (Document_Type='Order', No='...'), NO cambiar sin
    // volver a probar. Clave declarada verificada con $metadata real.
    // 1) Nº ALBARÁN PROVEEDOR — mismo web service de página que ya usa
    //    la tarjeta "Pedidos de Compra (cabecera)" (Pedido_compra_Excel).
    //    La tabla de cabecera de pedido de compra en BC tiene CLAVE
    //    COMPUESTA (Tipo de documento + Nº), no solo el Nº — así que se
    //    prueban las dos formas de dirección por clave, la simple primero
    //    (por si esta página la expone solo por Nº) y si falla, con
    //    Document_Type='Order' añadido. Si ninguna funciona, se avisa
    //    con las dos respuestas para poder revisarlo con el partner de BC.
    if (albaran) {
      try {
        const servicioPedidos = FUENTES_WS.pedidos_compra.servicio;
        const raizWS = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
        const pedidoEscapado = pedido.replace(/'/g, "''");
        const candidatosClave = [
          `(No='${pedidoEscapado}')`,
          `(Document_Type='Order',No='${pedidoEscapado}')`,
        ];

        let hecho = false;
        const intentos = [];
        resultado.referencia = { ok: false };
        for (const clave of candidatosClave) {
          const urlRegistro = `${raizWS}/${encodeURIComponent(servicioPedidos)}${clave}`;
          const rGet = await fetchConReintento(urlRegistro, { headers: cabeceras });
          intentos.push(`${clave} → GET ${rGet.status}`);
          if (!rGet.ok) continue;

          const registro = await rGet.json();
          const etag = registro["@odata.etag"] || "*";
          // "Su/Ntra. ref." de la cabecera del pedido = Your Reference.
          // Se toma el nombre real que devuelve la página; si no viene,
          // se prueba el estándar de BC.
          const campoRef = ["Your_Reference", "YourReference", "yourReference"].find((k) => k in registro)
            || Object.keys(registro).find((k) => /your.?reference|su.?ntra|ntra.?ref/i.test(k))
            || "Your_Reference";
          const parchear = async (cuerpo, etagActual) => {
            const r = await fetchConReintento(urlRegistro, {
              method: "PATCH",
              headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": etagActual || "*" },
              body: JSON.stringify(cuerpo),
            });
            const texto = r.ok ? "" : (await r.text().catch(() => "")).slice(0, 300);
            return { ok: r.ok, status: r.status, texto };
          };
          const ambos = await parchear({ Vendor_Shipment_No: albaran, [campoRef]: albaran }, etag);
          intentos.push(`${clave} → PATCH albarán+Su/Ntra. ref. ${ambos.status}`);
          if (ambos.ok) {
            resultado.albaran.ok = true;
            resultado.referencia.ok = true;
            hecho = true;
          } else {
            const soloAlb = await parchear({ Vendor_Shipment_No: albaran }, "*");
            intentos.push(`${clave} → PATCH albarán ${soloAlb.status}`);
            if (soloAlb.ok) {
              resultado.albaran.ok = true;
              hecho = true;
            } else {
              resultado.albaran.error = `BC respondió ${soloAlb.status} al actualizar el albarán: ${soloAlb.texto}`;
            }
            const rRef = await parchear({ [campoRef]: albaran }, "*");
            intentos.push(`${clave} → PATCH ${campoRef} ${rRef.status}`);
            if (rRef.ok) resultado.referencia.ok = true;
            else resultado.referencia.error = `BC respondió ${rRef.status} al escribir Su/Ntra. ref.: ${rRef.texto}`;
          }
          break; // el registro SÍ se encontró con esta clave — no seguir probando otras
        }
        if (!hecho && !resultado.albaran.error) {
          resultado.albaran.error = `Pedido "${pedido}" no encontrado en "${servicioPedidos}" con ninguna de las claves probadas: ${intentos.join(" · ")}`;
        }
        if (resultado.referencia && !resultado.referencia.ok && !resultado.referencia.error) {
          resultado.referencia.error = resultado.albaran.error || "No se ha escrito Su/Ntra. ref.";
        }
      } catch (e) {
        resultado.albaran.error = String(e.message || e);
      }
    } else {
      resultado.albaran.error = "Sin Nº de albarán detectado — no se ha intentado actualizar.";
    }

    // Localizar el pedido en la API estándar v2.0 (hace falta su GUID
    // tanto para el adjunto como para las líneas).
    let purchaseOrderId = null;
    try {
      const urlBusca = `${base}/companies(${EMPRESA_ID()})/purchaseOrders?$filter=${encodeURIComponent(`number eq '${pedido.replace(/'/g, "''")}'`)}`;
      const rBusca = await fetchConReintento(urlBusca, { headers: cabeceras });
      if (rBusca.ok) {
        const datosBusca = await rBusca.json();
        purchaseOrderId = (datosBusca.value || [])[0]?.id || null;
      }
    } catch { /* se maneja abajo, por sección, si falta */ }

    // ✅ CONFIRMADO FUNCIONANDO contra el BC real de Also Casals (31/08/2026)
    // — NO CAMBIAR el recurso, la clave ni el parentType sin volver a
    // probar contra BC primero. Si hace falta tocar esta sección, hacer
    // una copia de este bloque antes.
    // 2) ADJUNTO — recurso "attachments" de la API v2.0 (confirmado con
    //    el $metadata real de tu BC, no adivinado):
    //      · Clave: un único campo "id" (Guid) — nada de clave compuesta.
    //      · "Purchase Order" SÍ es un valor válido de parentType
    //        (confirmado en la lista real de valores del enum).
    //      · "attachmentContent" es tipo stream → va en dos pasos.
    //    Se prueban los dos órdenes posibles (contenido primero / metadatos
    //    primero) por si el negocio de BC exige uno u otro, igual que se
    //    hizo con documentAttachments — pero ahora con el recurso y la
    //    clave correctos, así que debería bastar con uno de los dos.
    if (pdfBase64) {
      if (!purchaseOrderId) {
        resultado.adjunto.error = `Pedido "${pedido}" no encontrado en purchaseOrders (api/v2.0) — no se puede adjuntar.`;
      } else {
        const contenidoBinario = Buffer.from(pdfBase64, "base64");
        const urlColeccion = `${base}/companies(${EMPRESA_ID()})/attachments`;
        const intentosAdjunto = [];

        // --- Intento A: contenido primero, enlazar después ---
        try {
          const rCrearA = await fetchConReintento(urlColeccion, {
            method: "POST",
            headers: { ...cabeceras, "Content-Type": "application/json" },
            body: JSON.stringify({
              fileName: nombreArchivo || `${pedido}.pdf`,
              byteSize: contenidoBinario.length,
              attachmentContent: pdfBase64,
            }),
          });
          if (rCrearA.ok) {
            const creadoA = await rCrearA.json();
            const etagA = creadoA["@odata.etag"] || "*";
            const rEnlazar = await fetchConReintento(`${urlColeccion}(${creadoA.id})`, {
              method: "PATCH",
              headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": etagA },
              body: JSON.stringify({ parentType: "Purchase Order", parentId: purchaseOrderId }),
            });
            if (rEnlazar.ok) resultado.adjunto.ok = true;
            else intentosAdjunto.push(`A (enlazar) → ${rEnlazar.status}: ${(await rEnlazar.text().catch(() => "")).slice(0, 200)}`);
          } else {
            intentosAdjunto.push(`A (crear con contenido) → ${rCrearA.status}: ${(await rCrearA.text().catch(() => "")).slice(0, 200)}`);
          }
        } catch (e) {
          intentosAdjunto.push(`A → excepción: ${String(e.message || e)}`);
        }

        // --- Intento B: metadatos primero (con clave "id" correcta), contenido después ---
        if (!resultado.adjunto.ok) {
          try {
            const rCrearB = await fetchConReintento(urlColeccion, {
              method: "POST",
              headers: { ...cabeceras, "Content-Type": "application/json" },
              body: JSON.stringify({
                fileName: nombreArchivo || `${pedido}.pdf`,
                parentType: "Purchase Order",
                parentId: purchaseOrderId,
              }),
            });
            if (rCrearB.ok) {
              const creadoB = await rCrearB.json();
              const etagB = creadoB["@odata.etag"] || "*";
              const rContenido = await fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
                method: "PATCH",
                headers: { ...cabeceras, "Content-Type": "application/pdf", "If-Match": etagB },
                body: contenidoBinario,
              });
              if (rContenido.ok) resultado.adjunto.ok = true;
              else intentosAdjunto.push(`B (contenido) → ${rContenido.status}: ${(await rContenido.text().catch(() => "")).slice(0, 200)}`);
            } else {
              intentosAdjunto.push(`B (crear con enlace) → ${rCrearB.status}: ${(await rCrearB.text().catch(() => "")).slice(0, 200)}`);
            }
          } catch (e) {
            intentosAdjunto.push(`B → excepción: ${String(e.message || e)}`);
          }
        }

        if (!resultado.adjunto.ok) {
          resultado.adjunto.error = `Ningún orden funcionó. Detalle de los intentos: ${intentosAdjunto.join(" · ")}`;
        }
      }
    } else {
      resultado.adjunto.error = "Sin PDF que adjuntar.";
    }

    // 2b) LÍNEAS NUEVAS (cargos/material) — se crean ANTES de registrar.
    // Si el PC está Released, se reabre (Open) igual que en ajustes / recepcionPreparar.
    resultado.nuevasLineas = [];
    let fallaNuevaLinea = false;
    let pedidoReabierto = false;
    if (Array.isArray(nuevasLineas) && nuevasLineas.length) {
      if (!purchaseOrderId) {
        for (const nl of nuevasLineas) resultado.nuevasLineas.push({ codigo: nl.codigo, ok: false, error: "Pedido no localizado en purchaseOrders (api/v2.0)." });
        fallaNuevaLinea = true;
      } else {
        const prepNl = await reabrirPedidoCompraSiLanzado(purchaseOrderId, token);
        if (!prepNl.ok) {
          fallaNuevaLinea = true;
          for (const nl of nuevasLineas) {
            resultado.nuevasLineas.push({
              codigo: nl.codigo,
              descripcion: nl.descripcion,
              ok: false,
              error: prepNl.error || "El pedido está lanzado y no se ha podido reabrir para añadir líneas.",
            });
          }
        } else {
          if (prepNl.reabierto) {
            pedidoReabierto = true;
            resultado.reabierto = true;
          }
        const urlLineasApi = `${base}/companies(${EMPRESA_ID()})/purchaseOrderLines`;
        let ref = null;
        try {
          const rRef = await fetchConReintento(`${urlLineasApi}?$filter=${encodeURIComponent(`documentId eq ${purchaseOrderId}`)}`, { headers: cabeceras });
          if (rRef.ok) {
            const ls = (await rRef.json()).value || [];
            ref = ls.find((l) => /item/i.test(l.lineType || "") && !/charge/i.test(l.lineType || "") && l.lineObjectNumber) || ls.find((l) => l.lineObjectNumber) || null;
          }
        } catch {}
        const raizWS = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
        const servicioLineas = FUENTES_WS.lineas_compra.servicio;
        const pedidoEsc = pedido.replace(/'/g, "''");
        const leerFilasWS = async () => {
          const r = await fetchConReintento(`${raizWS}/${encodeURIComponent(servicioLineas)}?$filter=${encodeURIComponent(`Document_No eq '${pedidoEsc}'`)}`, { headers: cabeceras });
          if (!r.ok) throw new Error(`web service ${servicioLineas} respondió ${r.status}`);
          return (await r.json()).value || [];
        };
        for (const nl of nuevasLineas) {
          const info = { codigo: nl.codigo, descripcion: nl.descripcion, ok: false, avisos: [] };
          try {
            const cantidad = Number(nl.cantidad) || 0;
            const coste = Number(nl.coste);
            if (!nl.codigo || cantidad <= 0) throw new Error("Falta el Nº (artículo o cargo) o la cantidad.");
            let creada = null, ultimoErr = "";
            const tipos = nl.tipo === "Item" ? ["Item"] : ["Charge", "Charge (Item)"];
            for (const tipo of tipos) {
              const body = { documentId: purchaseOrderId, lineType: tipo, lineObjectNumber: String(nl.codigo).trim(), quantity: cantidad };
              if (!Number.isNaN(coste) && nl.coste !== null && nl.coste !== "") body.directUnitCost = coste;
              let r = await fetchConReintento(urlLineasApi, { method: "POST", headers: { ...cabeceras, "Content-Type": "application/json" }, body: JSON.stringify(body) });
              let txt = "";
              if (r.ok) { creada = await r.json(); break; }
              txt = (await r.text().catch(() => "")).slice(0, 300);
              if (/Status must be equal to 'Open'/i.test(txt) && !pedidoReabierto) {
                const re = await reabrirPedidoCompra(purchaseOrderId, token);
                if (!re.ok) throw new Error(re.error);
                pedidoReabierto = true;
                resultado.reabierto = true;
                r = await fetchConReintento(urlLineasApi, { method: "POST", headers: { ...cabeceras, "Content-Type": "application/json" }, body: JSON.stringify(body) });
                if (r.ok) { creada = await r.json(); break; }
                txt = (await r.text().catch(() => "")).slice(0, 300);
              }
              if (!ultimoErr) ultimoErr = `BC respondió ${r.status}: ${txt}`;
              if (!/InvalidOptionEnumValue|is not an option/i.test(txt)) break;
            }
            if (!creada) throw new Error(mensajeSiPedidoLanzado(ultimoErr));
            info.lineaId = creada.id;
            const parche = { receiveQuantity: cantidad };
            const dto = Number(nl.dto);
            if (nl.dto !== null && nl.dto !== undefined && nl.dto !== "" && !Number.isNaN(dto) && dto > 0) parche.discountPercent = dto;
            if (nl.descripcion && nl.descripcion !== creada.description) parche.description = String(nl.descripcion).slice(0, 100);
            const rP = await fetchConReintento(`${urlLineasApi}(${creada.id})`, {
              method: "PATCH", headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": "*" }, body: JSON.stringify(parche),
            });
            if (!rP.ok) info.avisos.push(`No se pudo marcar la cantidad a recibir/descripción/descuento: BC ${rP.status}`);
            info.ok = true;
            if (creada.sequence != null) {
              try {
                const filas = await leerFilasWS();
                const fNueva = filas.find((f) => Number(f.Line_No) === Number(creada.sequence));
                let fRef = ref && ref.sequence != null ? filas.find((f) => Number(f.Line_No) === Number(ref.sequence)) : null;
                if (!fRef) {
                  const servicioPedidos = FUENTES_WS.pedidos_compra.servicio;
                  const rCab = await fetchConReintento(`${raizWS}/${encodeURIComponent(servicioPedidos)}(Document_Type='Order',No='${pedidoEsc}')`, { headers: cabeceras });
                  if (rCab.ok) fRef = await rCab.json();
                }
                if (fRef && fNueva) {
                  const campos = Object.keys(fRef).filter((k) =>
                    k in fNueva && (/^(Shortcut_Dimension_[12]_Code|Location_Code)$/i.test(k) || /l[ií]n(ea)?.*negocio|business.?line/i.test(k))
                  );
                  const cambios = {};
                  for (const k of campos) {
                    const v = fRef[k];
                    if (v !== null && v !== undefined && v !== "" && fNueva[k] !== v) cambios[k] = v;
                  }
                  if (Object.keys(cambios).length) {
                    const clave = `(Document_Type='Order',Document_No='${pedidoEsc}',Line_No=${Number(creada.sequence)})`;
                    const rC = await fetchConReintento(`${raizWS}/${encodeURIComponent(servicioLineas)}${clave}`, {
                      method: "PATCH",
                      headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": fNueva["@odata.etag"] || "*" },
                      body: JSON.stringify(cambios),
                    });
                    if (rC.ok) info.copiado = cambios;
                    else info.avisos.push(`No se pudieron copiar dimensiones: BC ${rC.status}`);
                  }
                }
              } catch (e) {
                info.avisos.push(`No se pudo comprobar OT/línea de negocio/almacén (${String(e.message || e)})`);
              }
            }
          } catch (e) {
            info.error = String(e.message || e);
            fallaNuevaLinea = true;
          }
          resultado.nuevasLineas.push(info);
        }
        }
      }
    }

    // 2c) Cantidad y coste directo del PEDIDO, solo en las líneas que la
    // pantalla ha marcado como cambiadas. Va ANTES de la cantidad a
    // recibir: si el albarán trae 450 y el pedido tiene 9, primero se
    // corrige el pedido y después se intenta recibir. No toca el resto
    // de líneas, ni el artículo, ni borra nada.
    const ajustes = Array.isArray(req.body?.ajustesPedido) ? req.body.ajustesPedido : [];
    resultado.ajustesPedido = [];
    let fallaAjuste = false;
    if (ajustes.length && !purchaseOrderId) {
      fallaAjuste = true;
      for (const a of ajustes) resultado.ajustesPedido.push({ lineaId: a?.lineaId || null, ok: false, error: "Pedido no localizado en purchaseOrders (api/v2.0)." });
    } else if (ajustes.length) {
      const prep = await reabrirPedidoCompraSiLanzado(purchaseOrderId, token);
      if (!prep.ok) {
        fallaAjuste = true;
        for (const a of ajustes) resultado.ajustesPedido.push({ lineaId: a?.lineaId || null, ok: false, error: prep.error });
      } else {
        if (prep.reabierto) {
          pedidoReabierto = true;
          resultado.reabierto = true;
        }
      for (const a of ajustes) {
        const lineaId = String(a?.lineaId || "").trim();
        const info = { lineaId, ok: false };
        try {
          if (!lineaId) throw new Error("Falta la línea del pedido.");
          const urlLinea = `${base}/companies(${EMPRESA_ID()})/purchaseOrderLines(${lineaId})`;
          const rGet = await fetchConReintento(urlLinea, { headers: cabeceras });
          if (!rGet.ok) throw new Error(`BC respondió ${rGet.status} al leer la línea.`);
          const actual = await rGet.json();
          if (purchaseOrderId && actual.documentId && actual.documentId !== purchaseOrderId) {
            throw new Error("La línea no pertenece a este pedido. No se ha modificado.");
          }
          const recibida = Number(actual.receivedQuantity) || 0;
          const cuerpo = {};
          if (a.cantidad != null && a.cantidad !== "") {
            const q = Number(a.cantidad);
            if (!Number.isFinite(q) || q < 0) throw new Error("La cantidad del pedido no es un número válido.");
            if (q + 1e-9 < recibida) {
              throw new Error(`No se puede dejar la cantidad del pedido en ${q}: en esta línea ya hay ${recibida} recibida.`);
            }
            if (Math.abs(q - (Number(actual.quantity) || 0)) > 1e-6) {
              cuerpo.quantity = q;
              info.cantidad = q;
            }
          }
          if (a.precio != null && a.precio !== "") {
            const p = Number(a.precio);
            if (!Number.isFinite(p) || p < 0) throw new Error("El coste directo no es un número válido.");
            const actualPrecio = actual.directUnitCost == null || actual.directUnitCost === "" ? null : Number(actual.directUnitCost);
            if (actualPrecio == null || Math.abs(p - actualPrecio) > 0.0001) {
              cuerpo.directUnitCost = p;
              info.precio = p;
            }
          }
          if (!Object.keys(cuerpo).length) {
            info.ok = true;
            info.sinCambio = true;
            resultado.ajustesPedido.push(info);
            continue;
          }
          let rPatch = await fetchConReintento(urlLinea, {
            method: "PATCH",
            headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": actual["@odata.etag"] || "*" },
            body: JSON.stringify(cuerpo),
          });
          let txtFallo = "";
          if (!rPatch.ok) {
            txtFallo = (await rPatch.text().catch(() => "")).slice(0, 350);
            if (/Status must be equal to 'Open'/i.test(txtFallo) && !pedidoReabierto) {
              const re = await reabrirPedidoCompra(purchaseOrderId, token);
              if (!re.ok) throw new Error(re.error);
              pedidoReabierto = true;
              resultado.reabierto = true;
              rPatch = await fetchConReintento(urlLinea, {
                method: "PATCH",
                headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": "*" },
                body: JSON.stringify(cuerpo),
              });
              txtFallo = rPatch.ok ? "" : (await rPatch.text().catch(() => "")).slice(0, 350);
            }
          }
          if (!rPatch.ok) {
            throw new Error(`BC no ha guardado el cambio (${rPatch.status}): ${mensajeSiPedidoLanzado(txtFallo)}`);
          }
          info.ok = true;
        } catch (e) {
          info.error = String(e.message || e);
          fallaAjuste = true;
        }
        resultado.ajustesPedido.push(info);
      }
      }
    }
    if (pedidoReabierto && purchaseOrderId) {
      const rel = await lanzarPedidoCompra(purchaseOrderId, token);
      resultado.relanzado = !!rel.ok;
      if (!rel.ok) {
        resultado.avisoLanzado = rel.error;
      }
    }
    if (fallaAjuste) {
      const detalle = resultado.ajustesPedido.filter((a) => !a.ok).map((a) => a.error).filter(Boolean).join(" ");
      const aviso = resultado.avisoLanzado ? ` ${resultado.avisoLanzado}` : "";
      resultado.registro = { ok: false, error: `No se ha recibido: primero hay que guardar la cantidad o el precio del pedido. ${detalle}${aviso}`.trim() };
      return res.json(resultado);
    }

    // 3) LÍNEAS — rellenar "Cantidad a recibir" (receiveQuantity)
    if (Array.isArray(lineas) && lineas.length) {
      if (!purchaseOrderId) {
        for (const l of lineas) resultado.lineas.push({ lineaId: l.lineaId, ok: false, error: "Pedido no localizado en purchaseOrders (api/v2.0)." });
      } else {
        for (const l of lineas) {
          try {
            const urlLinea = `${base}/companies(${EMPRESA_ID()})/purchaseOrderLines(${l.lineaId})`;
            const rPatchLinea = await fetchConReintento(urlLinea, {
              method: "PATCH",
              headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": "*" },
              body: JSON.stringify({ receiveQuantity: Number(l.cantidad) || 0 }),
            });
            if (rPatchLinea.ok) resultado.lineas.push({ lineaId: l.lineaId, ok: true });
            else resultado.lineas.push({ lineaId: l.lineaId, ok: false, error: `BC respondió ${rPatchLinea.status}: ${(await rPatchLinea.text().catch(() => "")).slice(0, 200)}` });
          } catch (e) {
            resultado.lineas.push({ lineaId: l.lineaId, ok: false, error: String(e.message || e) });
          }
        }
      }
    }

    // 3-bis) Poner a 0 la cantidad a recibir del resto de líneas
    let fallaCeros = false;
    resultado.lineasACero = [];
    if (purchaseOrderId) {
      try {
        const confirmadas = new Set([
          ...(Array.isArray(lineas) ? lineas.map((l) => String(l.lineaId)) : []),
          ...(resultado.nuevasLineas || []).filter((n) => n.lineaId).map((n) => String(n.lineaId)),
        ]);
        const urlTodas = `${base}/companies(${EMPRESA_ID()})/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${purchaseOrderId}`)}`;
        const rTodas = await fetchConReintento(urlTodas, { headers: cabeceras });
        if (!rTodas.ok) throw new Error(`BC respondió ${rTodas.status} al leer las líneas del pedido`);
        for (const l of (await rTodas.json()).value || []) {
          if (confirmadas.has(String(l.id))) continue;
          if (!(Number(l.receiveQuantity) > 0)) continue;
          const r0 = await fetchConReintento(`${base}/companies(${EMPRESA_ID()})/purchaseOrderLines(${l.id})`, {
            method: "PATCH",
            headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": "*" },
            body: JSON.stringify({ receiveQuantity: 0 }),
          });
          const info = { linea: l.sequence, articulo: l.lineObjectNumber, descripcion: l.description, antes: l.receiveQuantity, ok: r0.ok };
          if (!r0.ok) { info.error = `BC ${r0.status}`; fallaCeros = true; }
          resultado.lineasACero.push(info);
        }
      } catch (e) {
        fallaCeros = true;
        resultado.lineasACero.push({ ok: false, error: String(e.message || e) });
      }
    } else {
      fallaCeros = true;
    }
    if (fallaCeros) {
      resultado.registro = { ok: false, error: "No se ha registrado: no se pudo poner a 0 la cantidad a recibir de las demás líneas del pedido (se recibiría de más). Revísalo en BC antes de registrar." };
      return res.json(resultado);
    }

    const lineasRechazadas = (resultado.lineas || []).filter((l) => l && l.ok === false);
    if (lineasRechazadas.length) {
      resultado.registro = {
        ok: false,
        error: "No se ha registrado la recepción: BC no ha aceptado la cantidad a recibir. " + lineasRechazadas.map((l) => l.error).filter(Boolean).join(" "),
      };
      return res.json(resultado);
    }

    if (!registrar) {
      resultado.registro = { ok: false, noRegistrar: true };
      return res.json(resultado);
    }

    // 4) REGISTRAR — API v2 Microsoft.NAV.receive (= «Recibir», no facturar).
    // Las cantidades a recibir ya están fijadas en los pasos 3 / 3-bis;
    // NO se vuelve a marcar todo el pedido a recibir (eso rompería el parcial).
    // Si la acción API no existe o falla, respaldo opcional Playwright (BC_REGISTRO_URL).
    resultado.registro = { ok: false };
    if (fallaNuevaLinea) {
      resultado.registro.error = "No se ha registrado: alguna línea nueva (cargo) no se pudo crear. Corrígelo y vuelve a confirmar, o regístralo desde BC.";
      return res.json(resultado);
    }
    if (!purchaseOrderId) {
      resultado.registro.error = "No se ha registrado: pedido no localizado en purchaseOrders (api/v2.0).";
      return res.json(resultado);
    }

    const anotarRegistrado = async () => {
      try {
        const d = await leerRecep();
        d.registrados = d.registrados || {};
        const clave = `${pedido.toUpperCase()}|${String(albaran || "").trim().toUpperCase()}`;
        d.registrados[clave] = { ts: new Date().toISOString(), archivo: nombreArchivo || null, via: resultado.registro.via || "api" };
        await escribirRecep(d);
      } catch (e) {
        console.warn("[subir-bc] No se pudo anotar el registro:", e.message);
      }
    };

    try {
      const recibo = await registrarRecepcionPorApi(purchaseOrderId, token, pedido);
      if (recibo.ok) {
        resultado.registro = { ok: true, via: "api", accion: recibo.accion, viaApi: recibo.viaApi };
        console.log(`[subir-bc] Registro OK via ${recibo.viaApi}.${recibo.accion} · pedido ${pedido}`);
        await anotarRegistrado();
      } else {
        console.warn(
          `[subir-bc] Registro API falló (${recibo.accion} ${recibo.status}): ${(recibo.texto || "").slice(0, 200)} — intento Playwright`
        );
        const fb = await registrarPedidoPorServicio(pedido);
        if (fb.ok) {
          resultado.registro = {
            ok: true,
            via: "playwright",
            avisoApi: `API ${recibo.accion} ${recibo.status}: ${(recibo.texto || "").slice(0, 180)}`,
          };
          await anotarRegistrado();
        } else {
          resultado.registro = {
            ok: false,
            via: "ninguna",
            error: [
              `API ${recibo.accion} (${recibo.status}): ${(recibo.texto || "sin detalle").slice(0, 280)}`,
              recibo.hint || "",
              fb.error || "Playwright no disponible (BC_REGISTRO_URL)",
            ]
              .filter(Boolean)
              .join(" · "),
          };
        }
      }
    } catch (e) {
      resultado.registro.error = `Error al registrar por API: ${String(e.message || e)}`;
    }

    res.json(resultado);
  } catch (err) {
    console.error("Error /api/recepcion/subir-bc:", err);
    res.status(500).json({ error: "Error interno subiendo a Business Central.", detalle: String(err.message || err) });
  }
});

// =======================================================================
// VALIDACIÓN DE FACTURAS DE COMPRA (proveedor) contra Business Central
// -----------------------------------------------------------------------
// Objetivo: al llegar una factura de proveedor, avisar de un vistazo si
// se puede entrar tal cual o si hay que revisarla antes, por dos motivos
// posibles: (a) el pedido de compra todavía no está recibido/registrado
// en BC para la cantidad que factura el proveedor, o (b) el precio que
// factura no coincide con el precio del pedido en BC. Solo LECTURA — no
// modifica nada en BC, es un semáforo antes de que alguien entre la
// factura a mano (o, más adelante, se automatice la entrada).
// =======================================================================

const TOLERANCIA_PRECIO_PCT = 0.02; // 2% de diferencia relativa
const TOLERANCIA_PRECIO_ABS = 0.02; // o 2 céntimos absolutos, lo que sea mayor

function jsonDeRespuestaIA(texto) {
  const limpio = String(texto || "").replace(/```json|```/g, "").trim();
  const candidatos = [limpio];
  const inicio = limpio.indexOf("[");
  const fin = limpio.lastIndexOf("]");
  if (inicio >= 0 && fin > inicio) candidatos.push(limpio.slice(inicio, fin + 1));
  for (const candidato of candidatos) {
    try {
      const valor = JSON.parse(candidato);
      if (Array.isArray(valor)) return valor;
    } catch { /* el siguiente candidato */ }
  }
  return null;
}

// Facturas densas (p. ej. Saltoki) generan JSON muy largo: si un lote
// no cabe en la respuesta de la IA, se parte en dos mitades y se reintenta.
async function extraerLoteFacturaPartido(bytesLotePdf, numPaginasLote) {
  if (!PDFDocument || numPaginasLote < 2) {
    throw new Error("No se pudo partir el lote de factura para releerlo.");
  }
  const src = await PDFDocument.load(bytesLotePdf, { ignoreEncryption: true });
  const mitad = Math.ceil(numPaginasLote / 2);
  const gruposIndices = [
    Array.from({ length: mitad }, (_, i) => i),
    Array.from({ length: numPaginasLote - mitad }, (_, i) => i + mitad),
  ];
  const out = [];
  for (const indices of gruposIndices) {
    if (!indices.length) continue;
    const lotePdf = await PDFDocument.create();
    const copiadas = await lotePdf.copyPages(src, indices);
    copiadas.forEach((p) => lotePdf.addPage(p));
    const bytes = await lotePdf.save();
    out.push(...(await extraerLoteFacturaPDF(bytes, indices.length)));
  }
  return out;
}

async function extraerLoteFacturaPDF(bytesLotePdf, numPaginasLote) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env.");
  }
  const prompt = `Eres un asistente que lee FACTURAS DE PROVEEDOR (compras).

El documento tiene ${numPaginasLote} página(s), en orden.

Para CADA página (numeradas del 1 al ${numPaginasLote}), identifica:
1. "pagina": el número de página (1, 2, 3...).
2. "factura": el número de factura DEL PROVEEDOR (su propio número, no el nuestro). Si la página es continuación y no repite el número, pon "factura": null.
3. "proveedor": la razón social DEL PROVEEDOR que emite la factura (el membrete, no "Also Casals", que es el cliente). Si es continuación y no lo repite, pon "proveedor": null.
4. "fecha": la fecha DE EMISIÓN de la factura, "YYYY-MM-DD". No uses la de vencimiento ni la del pedido. Si no está, pon "fecha": null.
5. "baseImponible": la base imponible (antes de IVA) del resumen, como número. Si no está en esa página, null.
6. "importeTotal": el total con IVA del resumen, como número. Si no está en esa página, null.
7. "lineas": cada artículo de la tabla de esa página:
   - "descripcion": el texto tal cual.
   - "cantidad": número.
   - "precioUnitario": precio unitario antes del descuento de línea, con punto decimal.
   - "pedido": NUESTRO pedido de compra si está impreso en esa línea o en su columna Pedido. Vale "PC26-003602", "PC26-3602" o "PC-2314". Cópialo tal cual está escrito. Si esa línea no trae pedido, null. No lo inventes. Las líneas van en el orden de la tabla, de arriba abajo.
   Si no hay tabla, "lineas": [].

El resultado es un array JSON de ${numPaginasLote} objetos, en orden. Aunque el documento no sea una factura (albarán, confirmación de pedido, presupuesto), responde igual con ese array y rellena solo lo que esté escrito. Nunca expliques ni analices en prosa.
[{"pagina":1,"factura":"F-2026-01234","proveedor":"Proveedor S.L.","fecha":"2026-08-21","baseImponible":null,"importeTotal":null,"lineas":[{"descripcion":"Tornillo M8","cantidad":100,"precioUnitario":0.12,"pedido":"PC26-002262"}]}]`;

  let textoPdf = "";
  try {
    const leido = await pdfParse(Buffer.from(bytesLotePdf));
    textoPdf = String(leido?.text || "").replace(/\u0000/g, "").trim();
  } catch { /* PDF escaneado o protegido: se lee como imagen */ }
  const letras = (textoPdf.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const porTexto = letras >= Math.max(120, numPaginasLote * 40);
  console.log(`[facturas-compra/extraer] lote de ${numPaginasLote} pág. · ${porTexto ? `texto (${letras} caracteres)` : "imagen"}`);

  const cierre = "Responde ÚNICAMENTE con el array JSON. Sin análisis, sin markdown y sin texto antes ni después.";
  const content = porTexto
    ? [{ type: "text", text: `${prompt}\n\nTEXTO DEL PDF (no inventes líneas que no estén aquí):\n${textoPdf.slice(0, 50000)}\n\n${cierre}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytesLotePdf).toString("base64") } },
        { type: "text", text: `${prompt}\n\n${cierre}` },
      ];

  const pedir = async (messages) => {
    const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        // Facturas densas (Saltoki): hace falta mucho espacio de salida.
        max_tokens: 32000,
        messages,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const detalle = await response.text();
      throw new Error(`Anthropic respondió ${response.status}: ${detalle.slice(0, 300)}`);
    }
    const data = await response.json();
    return {
      texto: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      stopReason: data.stop_reason || null,
    };
  };

  const pareceJsonCortado = (t) => {
    const s = String(t || "").replace(/```json|```/g, "").trim();
    return s.startsWith("[") && !s.endsWith("]");
  };

  const normalizarPaginasFactura = (parseado) => (Array.isArray(parseado) ? parseado : []).map((item) => ({
    pagina: item.pagina,
    factura: item.factura ? item.factura.toString().trim() : null,
    proveedor: item.proveedor ? item.proveedor.toString().trim() : null,
    fecha: item.fecha && /^\d{4}-\d{2}-\d{2}$/.test(item.fecha.toString().trim()) ? item.fecha.toString().trim() : null,
    baseImponible: item.baseImponible === null || item.baseImponible === undefined || item.baseImponible === "" ? null : Number(item.baseImponible),
    importeTotal: item.importeTotal === null || item.importeTotal === undefined || item.importeTotal === "" ? null : Number(item.importeTotal),
    lineas: Array.isArray(item.lineas)
      ? item.lineas
          .map((l) => ({
            descripcion: (l.descripcion || "").toString().trim(),
            cantidad: Number(l.cantidad) || 0,
            precioUnitario: l.precioUnitario === null || l.precioUnitario === undefined || l.precioUnitario === "" ? null : Number(l.precioUnitario),
            pedido: l.pedido ? l.pedido.toString().trim().toUpperCase() : null,
          }))
          .filter((l) => l.descripcion)
      : [],
  }));

  const pedirCompacto = async () => {
    console.warn(`[facturas-compra/extraer] página densa: reintento con descripciones cortas (${numPaginasLote} pág.)`);
    const contentCompacto = [
      ...content,
      {
        type: "text",
        text: "IMPORTANTE: en cada línea, \"descripcion\" máximo 60 caracteres. No omitas líneas. Solo el array JSON.",
      },
    ];
    const r = await pedir([{ role: "user", content: contentCompacto }]);
    return jsonDeRespuestaIA(r.texto);
  };

  const partirSiSePuede = async (motivo, texto) => {
    if (numPaginasLote > 1) {
      console.warn(`[facturas-compra/extraer] ${motivo}; se parte el lote de ${numPaginasLote} pág. en dos`);
      return extraerLoteFacturaPartido(bytesLotePdf, numPaginasLote);
    }
    const compacto = await pedirCompacto();
    if (compacto) return normalizarPaginasFactura(compacto);
    throw new Error(`No se pudo interpretar la respuesta de la IA para este lote: ${String(texto).replace(/```json|```/g, "").trim().slice(0, 200)}`);
  };

  let { texto, stopReason } = await pedir([{ role: "user", content }]);
  console.log(`[facturas-compra/extraer] lote ${numPaginasLote} pág. · stop_reason=${stopReason || "?"} · chars=${String(texto || "").length}`);
  let parseado = jsonDeRespuestaIA(texto);
  // JSON a medias (típico Saltoki): partir ya, sin gastar otro intento en prosa.
  if (!parseado && (stopReason === "max_tokens" || pareceJsonCortado(texto))) {
    return partirSiSePuede(
      stopReason === "max_tokens" ? "respuesta cortada por límite de tokens" : "JSON cortado a medias",
      texto
    );
  }
  if (!parseado) {
    console.warn(`[facturas-compra/extraer] la IA respondió en texto, se pide el JSON otra vez: ${texto.slice(0, 180)}`);
    ({ texto, stopReason } = await pedir([
      { role: "user", content },
      { role: "assistant", content: texto.slice(0, 12000) },
      { role: "user", content: "Eso no vale. Devuelve solo el array JSON con pagina, factura, proveedor, fecha, baseImponible, importeTotal y lineas. Sin explicación." },
    ]));
    parseado = jsonDeRespuestaIA(texto);
  }
  if (!parseado) {
    return partirSiSePuede(
      stopReason === "max_tokens" || pareceJsonCortado(texto) ? "respuesta cortada por límite de tokens" : "JSON no interpretable",
      texto
    );
  }
  return normalizarPaginasFactura(parseado);
}

// Agrupa páginas consecutivas de la MISMA factura (una factura puede
// ocupar varias páginas; las de continuación no repiten el nº de
// factura, pero sí traen más líneas). Cada línea lleva su propio
// "pedido" — una factura puede referenciar varios pedidos distintos.
function agruparPorFactura(deteccionesPorPagina) {
  const grupos = [];
  let actual = null;
  for (const d of deteccionesPorPagina) {
    if (d.factura && (!actual || d.factura !== actual.factura)) {
      if (actual) grupos.push(actual);
      actual = {
        factura: d.factura,
        proveedor: d.proveedor || null,
        fecha: d.fecha || null,
        baseImponible: d.baseImponible ?? null,
        importeTotal: d.importeTotal ?? null,
        paginas: [d.pagina],
        lineas: [...d.lineas],
      };
    } else if (actual) {
      if (!actual.proveedor && d.proveedor) actual.proveedor = d.proveedor; // hereda de una página de continuación si la primera no lo traía
      if (!actual.fecha && d.fecha) actual.fecha = d.fecha; // hereda de una página de continuación si la primera no la traía
      // Los totales normalmente solo salen en la ÚLTIMA página (el
      // resumen) — se queda con el último valor no nulo que aparezca.
      if (d.baseImponible !== null && d.baseImponible !== undefined) actual.baseImponible = d.baseImponible;
      if (d.importeTotal !== null && d.importeTotal !== undefined) actual.importeTotal = d.importeTotal;
      actual.paginas.push(d.pagina);
      actual.lineas.push(...d.lineas);
    } else {
      if (!grupos.length || grupos[grupos.length - 1].factura)
        grupos.push({ factura: null, proveedor: null, fecha: null, baseImponible: null, importeTotal: null, paginas: [], lineas: [] });
      const g = grupos[grupos.length - 1];
      if (!g.proveedor && d.proveedor) g.proveedor = d.proveedor;
      if (!g.fecha && d.fecha) g.fecha = d.fecha;
      if (d.baseImponible !== null && d.baseImponible !== undefined) g.baseImponible = d.baseImponible;
      if (d.importeTotal !== null && d.importeTotal !== undefined) g.importeTotal = d.importeTotal;
      g.paginas.push(d.pagina);
      g.lineas.push(...d.lineas);
    }
  }
  if (actual) grupos.push(actual);
  return grupos;
}

// Compara el precio unitario facturado contra el de BC (directUnitCost),
// con tolerancia para redondeos.
function precioDifiere(precioFactura, precioBC) {
  if (precioFactura === null || precioFactura === undefined) return null; // no leído, no se puede comparar
  if (precioBC === null || precioBC === undefined) return null; // BC no tiene precio para comparar
  const diff = Math.abs(precioFactura - precioBC);
  const tolerancia = Math.max(TOLERANCIA_PRECIO_ABS, Math.abs(precioBC) * TOLERANCIA_PRECIO_PCT);
  return diff > tolerancia;
}

// Empareja las líneas facturadas de UN pedido con las líneas reales del
// pedido en BC (misma heurística de coincidencia por descripción que ya
// usa Recepción), y añade la comprobación de recepción pendiente y de
// precio para cada una.
// Formatea las líneas de un pedido en BC como opciones para elegir a
// mano en pantalla (desplegable de "Validación de facturas"). Compartido
// entre /extraer y /refrescar-pedido para no tener el mapeo duplicado.
function lineasDisponiblesDesdeBC(lineasBC) {
  return (lineasBC || []).map((lb) => {
    const pedida = Number(lb.quantity ?? lb.Quantity) || 0;
    const recibida = Number(lb.receivedQuantity ?? lb.Quantity_Received) || 0;
    const facturada = Number(lb.invoicedQuantity ?? lb.Quantity_Invoiced) || 0;
    const pendienteFacturar = pendienteFacturarLineaBC(lb, recibida, facturada);
    const { precio, descuentoPct, importeLinea, precioNeto } = preciosLineaPedidoBC(lb);
    return {
      id: lb.id,
      codigo: lb.lineObjectNumber || lb.No || "",
      descripcion: lb.description || lb.Description || "",
      cantidadPedida: pedida,
      cantidadRecibida: recibida,
      cantidadFacturada: facturada,
      cantidadPendienteFacturar: pendienteFacturar,
      precioBC: precio,
      precio: precio,
      directUnitCost: precio,
      // Exactos de BC (0 es válido; no omitir).
      descuentoPct,
      discountPercent: descuentoPct,
      importeLinea,
      amountExcludingTax: importeLinea,
      netAmount: importeLinea,
      precioNeto,
    };
  });
}

/**
 * Fusiona línea de albarán (qty) con línea del PC (precio / % dto / importe).
 * Los purchaseReceiptLines suelen traer unitCost 0 o incompleto; el pedido sí tiene
 * directUnitCost, discountPercent y amountExcludingTax.
 */
function fusionarLineaAlbaranConPedido(lineaAlb, lineasPedido) {
  const codigo = String(lineaAlb?.codigo || "").trim().toUpperCase();
  const desc = String(lineaAlb?.descripcion || "").trim().toUpperCase();
  const lista = Array.isArray(lineasPedido) ? lineasPedido : [];
  let po = null;
  if (codigo) po = lista.find((p) => String(p.codigo || "").trim().toUpperCase() === codigo) || null;
  if (!po && desc) {
    po = lista.find((p) => String(p.descripcion || "").trim().toUpperCase() === desc) || null;
  }
  if (!po && desc) {
    let mejor = null;
    let mejorPunt = 0;
    for (const p of lista) {
      const punt = Math.max(
        puntuarCoincidencia(lineaAlb.descripcion, p.descripcion),
        puntuarCoincidencia(lineaAlb.descripcion, p.codigo)
      );
      if (punt > mejorPunt) {
        mejorPunt = punt;
        mejor = p;
      }
    }
    if (mejor && mejorPunt >= 0.35) po = mejor;
  }

  const qty = Number(lineaAlb.cantidad) || 0;
  const precioAlb = numCampoBC(lineaAlb.precioBC) ?? numCampoBC(lineaAlb.precio);
  const precioPo = po ? (numCampoBC(po.precioBC) ?? numCampoBC(po.precio) ?? numCampoBC(po.directUnitCost)) : null;
  const precio = (precioPo != null && precioPo !== 0) || precioAlb == null || precioAlb === 0
    ? (precioPo ?? precioAlb)
    : precioAlb;
  const descuentoPct = po && po.descuentoPct != null && po.descuentoPct !== ""
    ? Number(po.descuentoPct)
    : (numCampoBC(lineaAlb.descuentoPct) ?? numCampoBC(lineaAlb.discountPercent));

  const pedidaPo = po ? (Number(po.cantidadPedida) || 0) : 0;
  const importePo = po
    ? (numCampoBC(po.importeLinea) ?? numCampoBC(po.amountExcludingTax) ?? numCampoBC(po.netAmount))
    : null;
  let importeLinea = null;
  if (importePo != null && pedidaPo > 0.0001 && qty > 0) {
    // Proporcional al importe neto del pedido (respeta dto de BC).
    importeLinea = Math.round((qty / pedidaPo) * Number(importePo) * 100) / 100;
  } else if (precio != null && qty > 0) {
    const factor = descuentoPct != null && Number.isFinite(Number(descuentoPct))
      ? (1 - Number(descuentoPct) / 100)
      : 1;
    importeLinea = Math.round(qty * Number(precio) * factor * 100) / 100;
  } else {
    importeLinea = numCampoBC(lineaAlb.importeLinea) ?? numCampoBC(lineaAlb.amountExcludingTax);
  }

  return {
    ...lineaAlb,
    cantidad: qty,
    precioBC: precio,
    precio,
    descuentoPct: descuentoPct != null && Number.isFinite(Number(descuentoPct)) ? Number(descuentoPct) : null,
    discountPercent: descuentoPct != null && Number.isFinite(Number(descuentoPct)) ? Number(descuentoPct) : null,
    importeLinea,
    amountExcludingTax: importeLinea,
    lineaPedidoId: po?.id || null,
    codigoPedido: po?.codigo || lineaAlb.codigo || "",
    preciosDesdePedido: !!po,
  };
}

/** Albaranes ya registrados + líneas con qty > 0, precios fusionados del PC. */
async function albaranesConLineasDePedido(pedido, lineasPedido = []) {
  const numero = String(pedido || "").trim();
  if (!numero) return [];
  try {
    const token = await obtenerTokenBC();
    const cabeceras = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const esc = numero.replace(/'/g, "''");
    const rRec = await fetchConReintento(
      `${base}/purchaseReceipts?$filter=${encodeURIComponent(`orderNumber eq '${esc}'`)}&$select=id,number,postingDate,orderNumber`,
      { headers: cabeceras }
    );
    if (!rRec.ok) return [];
    const recs = (await rRec.json()).value || [];
    const out = [];
    for (const rec of recs) {
      if (!rec?.id) continue;
      const rLin = await fetchConReintento(
        `${base}/purchaseReceiptLines?$filter=${encodeURIComponent(`documentId eq ${rec.id}`)}`,
        { headers: cabeceras }
      );
      const raw = rLin.ok ? ((await rLin.json()).value || []) : [];
      const lineas = raw
        .map((l) => {
          const qty = Number(l.quantity) || 0;
          if (qty <= 0.0001) return null;
          const bruto = {
            id: l.id,
            codigo: l.lineObjectNumber || "",
            descripcion: l.description || "",
            cantidad: qty,
            precioBC: numCampoBC(l.unitCost) ?? numCampoBC(l.directUnitCost),
            precio: numCampoBC(l.unitCost) ?? numCampoBC(l.directUnitCost),
            descuentoPct: numCampoBC(l.discountPercent),
            discountPercent: numCampoBC(l.discountPercent),
            importeLinea: numCampoBC(l.amountExcludingTax) ?? numCampoBC(l.netAmount),
            lineType: l.lineType || "Item",
            unitOfMeasureCode: l.unitOfMeasureCode || null,
          };
          return fusionarLineaAlbaranConPedido(bruto, lineasPedido);
        })
        .filter(Boolean);
      if (!lineas.length) continue;
      out.push({
        numero: rec.number || "",
        fecha: rec.postingDate || "",
        id: rec.id,
        lineas,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function emparejarLineasFactura(lineasFactura, lineasBC) {
  const usadas = new Set();
  return (lineasFactura || []).map((lf) => {
    let mejor = null, mejorPunt = 0, manual = false;

    if (lf.lineaBcId) {
      // Elegida a mano en pantalla (el emparejamiento automático por texto
      // no la encontró, o se equivocó) — se usa directamente esa línea de
      // BC en vez de repetir la búsqueda por texto.
      mejor = (lineasBC || []).find((lb) => lb.id === lf.lineaBcId) || null;
      manual = !!mejor;
    } else {
      for (const lb of lineasBC || []) {
        if (usadas.has(lb.id)) continue;
        const punt = Math.max(
          puntuarCoincidencia(lf.descripcion, lb.description),
          puntuarCoincidencia(lf.descripcion, lb.lineObjectNumber)
        );
        if (punt > mejorPunt) { mejorPunt = punt; mejor = lb; }
      }
    }
    if (mejor && (manual || mejorPunt >= 0.35)) usadas.add(mejor.id);

    const cantidadRecibida = mejor ? Number(mejor.receivedQuantity) || 0 : 0;
    const precios = mejor ? preciosLineaPedidoBC(mejor) : null;
    const precioBC = precios ? precios.precio : null;
    const pendienteRecepcion = mejor ? cantidadRecibida < (Number(lf.cantidad) || 0) - 0.001 : true;
    const diferenciaPrecio = mejor ? precioDifiere(lf.precioUnitario, precioBC) : null;

    return {
      descripcionFactura: lf.descripcion,
      cantidadFacturada: lf.cantidad,
      precioFacturado: lf.precioUnitario,
      lineaBC: mejor
        ? {
            id: mejor.id,
            codigo: mejor.lineObjectNumber || "",
            descripcion: mejor.description || "",
            cantidadPedida: Number(mejor.quantity) || 0,
            cantidadRecibida,
            precioBC,
            directUnitCost: precioBC,
            descuentoPct: precios.descuentoPct,
            discountPercent: precios.descuentoPct,
            importeLinea: precios.importeLinea,
            amountExcludingTax: precios.importeLinea,
            netAmount: precios.importeLinea,
            precioNeto: precios.precioNeto,
            // Tipo real de la línea en BC ("Item", "Charge (Item)"...) —
            // hace falta para crear la línea de factura con el MISMO tipo;
            // si se fuerza siempre a "Item" (como se hacía antes), BC
            // rechaza con "Item does not exist" una línea que en realidad
            // es un cargo como "TRANSPORTE".
            lineType: mejor.lineType || "Item",
            // Unidad de medida de la línea del PEDIDO (Maria, 2026-09-04)
            // — se manda también al crear la línea de factura para que
            // cantidad/precio se interpreten con la misma unidad que en
            // el pedido (si no se manda, BC usa la del artículo, que no
            // siempre coincide).
            unitOfMeasureCode: mejor.unitOfMeasureCode || null,
          }
        : null,
      coincidencia: !mejor ? "sin_match" : manual ? "manual" : mejorPunt >= 0.7 ? "alta" : "media",
      pendienteRecepcion,
      diferenciaPrecio, // true=difiere, false=coincide, null=no se pudo comparar
    };
  });
}

// -----------------------------------------------------------------------
// DETECCIÓN DE FACTURA DUPLICADA: comprueba si un Nº de factura de
// proveedor ya está registrado en BC, para avisar ANTES de entrarla otra
// vez.
//
// ⚠️ A PROPÓSITO, esta función es COMPLETAMENTE INDEPENDIENTE del
// mecanismo de carga de datos (FUENTES_WS/FUENTES_BC y el endpoint
// /api/bc/:fuente) — no lo toca ni reutiliza su código, para no arriesgar
// nada de lo que ya está en producción. Es una consulta nueva y aparte,
// solo para "Validación de facturas".
//
// 2026-09-04, 2º intento: el primer intento (un $filter puntual sobre
// "Hist_líns_facturas_compra_Excel") NO detectó una factura que Maria
// confirmó que sí estaba entrada en BC. Puede deberse a que ese servicio
// de LÍNEAS no exponga la columna "Vendor Invoice No." en su publicación,
// a que el $filter no sea compatible con esa columna, o a que el nombre
// exacto del servicio en su BC sea otro. Para no depender de una única
// suposición, ahora: (a) se prueban varios nombres de servicio candidatos
// (línea Y cabecera), con auto-descubrimiento en el catálogo de BC si
// ninguno funciona (igual que ya hace "lineas_compra_reg" en la carga de
// datos, pero con código propio y separado); (b) en vez de un $filter
// puntual, se CARGA la tabla completa (paginada) y se busca en memoria
// con comparación tolerante (recorta espacios, ignora mayúsculas), tal
// como pidió Maria — evita problemas de compatibilidad de $filter con
// ese campo. El resultado se cachea unos minutos para no repetir la
// carga completa en cada factura de un mismo lote.
//
// Si algo falla (servicio no encontrado, columna no detectada...), NO
// bloquea la validación — se limita a no avisar de duplicado y queda
// registrado en consola (prefijo "[facturas-compra/duplicados]") para
// poder ajustarlo.
// -----------------------------------------------------------------------
const CANDIDATOS_HISTORICO_FACTURAS_COMPRA = [
  process.env.BC_WS_HISTFACTURASCOMPRA,
  "Hist_líns_facturas_compra_Excel",
  "Hist_lins_facturas_compra_Excel",
  "Hist_facturas_compra_Excel",
  "Hist_fras_compra_Excel",
  "Historico_facturas_compra_Excel",
  "Purch_Inv_Header_Excel",
  "Purchase_Invoice_Header_Excel",
].filter(Boolean);

const HISTORICO_FACTURAS_COMPRA_TTL_MS = 3 * 60 * 1000; // 3 min
let historicoFacturasCompraCache = null; // { servicio, campoFactura, campoNumero, campoProveedor, filas, cargadoEn }
let historicoFacturasCompraFallidoHasta = 0; // no reintentar servicios OData muertos en bucle
const odataServiciosFacturaMuertos = new Set(); // "servicio|campo" o "servicio" con 404 reciente
const PURCHASE_INVOICES_IDX_TTL_MS = 3 * 60 * 1000;
let purchaseInvoicesIdxCache = null; // { cargadoEn, porVendorInvoice: Map }

async function cargarTodasLasFilas(url, cabeceras) {
  const filas = [];
  let next = url;
  while (next) {
    const r = await fetchConReintento(next, cabeceras);
    if (!r.ok) return { error: r };
    const pagina = await r.json();
    filas.push(...(pagina.value || []));
    next = pagina["@odata.nextLink"] || null;
  }
  return { filas };
}

async function obtenerIndicePurchaseInvoices() {
  if (purchaseInvoicesIdxCache && Date.now() - purchaseInvoicesIdxCache.cargadoEn < PURCHASE_INVOICES_IDX_TTL_MS) {
    return purchaseInvoicesIdxCache;
  }
  const token = await obtenerTokenBC();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const api = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const porVendorInvoice = new Map();
  let next = `${api}/purchaseInvoices?$select=number,vendorName,vendorInvoiceNumber,status&$top=200`;
  let paginas = 0;
  while (next && paginas < 50) {
    const r = await fetchConReintento(next, { headers });
    if (!r.ok) {
      console.warn(`[facturas-compra/duplicados] purchaseInvoices índice HTTP ${r.status}`);
      break;
    }
    const pagina = await r.json();
    for (const fila of pagina.value || []) {
      const key = String(fila.vendorInvoiceNumber || "").trim().toUpperCase();
      if (!key) continue;
      const hit = resultadoFacturaYaEntrada({
        numeroBC: fila.number,
        proveedor: fila.vendorName,
        status: fila.status,
        fuente: "api",
      });
      const prev = porVendorInvoice.get(key);
      if (!prev || (prev.estado !== "registrada" && hit.estado === "registrada")) {
        porVendorInvoice.set(key, hit);
      }
    }
    next = pagina["@odata.nextLink"] || null;
    paginas += 1;
  }
  purchaseInvoicesIdxCache = { cargadoEn: Date.now(), porVendorInvoice, filas: porVendorInvoice.size };
  console.log(`[facturas-compra/duplicados] Índice purchaseInvoices: ${porVendorInvoice.size} nº proveedor (Open/Draft/Paid en API)`);
  return purchaseInvoicesIdxCache;
}

async function obtenerHistoricoFacturasCompra(raiz, cabeceras) {
  if (historicoFacturasCompraCache && Date.now() - historicoFacturasCompraCache.cargadoEn < HISTORICO_FACTURAS_COMPRA_TTL_MS) {
    return historicoFacturasCompraCache;
  }
  if (Date.now() < historicoFacturasCompraFallidoHasta) {
    return null;
  }

  const probar = async (servicio) => {
    const url = `${raiz}/${encodeURIComponent(servicio)}`;
    console.log(`[facturas-compra/duplicados] Probando "${servicio}"...`);
    const { filas, error } = await cargarTodasLasFilas(url, cabeceras);
    if (error) {
      const detalle = await error.text().catch(() => "");
      console.warn(`[facturas-compra/duplicados] "${servicio}" respondió ${error.status}: ${detalle.slice(0, 200)}`);
      return null;
    }
    if (!filas.length) {
      console.warn(`[facturas-compra/duplicados] "${servicio}" existe pero no devolvió ninguna fila.`);
      return null;
    }
    const claves = Object.keys(filas[0]);
    const campoFactura = claves.find((k) => /vendor.*invoice.*no|factura.*proveedor/i.test(k));
    if (!campoFactura) {
      console.warn(`[facturas-compra/duplicados] "${servicio}" no tiene ninguna columna de "Vendor Invoice No.". Columnas disponibles: ${claves.join(", ")}`);
      return null;
    }
    const campoNumero = claves.find((k) => /^No_?$|Document_No/i.test(k)) || null;
    const campoProveedor = claves.find((k) => /Buy.?from.?Vendor.?Name|Vendor_Name/i.test(k)) || null;
    console.log(`[facturas-compra/duplicados] Usando "${servicio}" · columna factura proveedor "${campoFactura}" · ${filas.length} filas cargadas`);
    return { servicio, campoFactura, campoNumero, campoProveedor, filas };
  };

  for (const servicio of CANDIDATOS_HISTORICO_FACTURAS_COMPRA) {
    const resultado = await probar(servicio);
    if (resultado) {
      historicoFacturasCompraCache = { ...resultado, cargadoEn: Date.now() };
      return historicoFacturasCompraCache;
    }
  }

  // Auto-descubrimiento: si ningún candidato funcionó, preguntar a BC el
  // catálogo de servicios publicados y buscar uno que encaje.
  try {
    console.log("[facturas-compra/duplicados] Ningún candidato funcionó: consultando el catálogo de servicios de BC...");
    const rCat = await fetchConReintento(raiz, cabeceras);
    if (rCat.ok) {
      const cat = await rCat.json();
      const nombres = (cat.value || []).map((v) => v.name || v.url).filter(Boolean);
      const yaProbados = new Set(CANDIDATOS_HISTORICO_FACTURAS_COMPRA);
      const coincidentes = nombres.filter(
        (n) => !yaProbados.has(n) && /hist/i.test(n) && /factur|invoice/i.test(n) && /compra|purch/i.test(n)
      );
      console.log(`[facturas-compra/duplicados] Catálogo: ${nombres.length} servicios · coinciden: ${coincidentes.join(", ") || "ninguno"}`);
      for (const servicio of coincidentes) {
        const resultado = await probar(servicio);
        if (resultado) {
          historicoFacturasCompraCache = { ...resultado, cargadoEn: Date.now() };
          return historicoFacturasCompraCache;
        }
      }
    }
  } catch (e) {
    console.warn("[facturas-compra/duplicados] Descubrimiento en el catálogo falló:", String(e.message || e));
  }

  // Sin servicio usable (p. ej. solo líneas sin Vendor Invoice No.): no
  // martillar OData en cada factura del lote — reintentar en 15 min.
  historicoFacturasCompraFallidoHasta = Date.now() + 15 * 60 * 1000;
  console.warn("[facturas-compra/duplicados] Histórico OData no usable; se omite 15 min (API purchaseInvoices sigue activa).");
  return null;
}

// API v2 BC: Draft/In Review = borrador; Open/Paid = ya registrada
// (Open = contabilizada pendiente de pago). Serie PFC* = borrador; FC* =
// histórico aunque status sea Open.
function estadoDocumentoCompraBC({ numeroBC, status, fuente }) {
  const n = String(numeroBC || "").trim().toUpperCase();
  const st = String(status || "").trim().toLowerCase();
  if (/^PFC\b/.test(n)) return "borrador";
  if (/^FC\b/.test(n)) return "registrada";
  if (facturaCompraEnBorrador(status) || /^(draft|in review)$/.test(st) || /borrador|en revisi[oó]n/.test(st)) {
    return "borrador";
  }
  if (fuente === "historico") return "registrada";
  if (/^(open|paid|canceled|cancelled|corrective)$/.test(st)) return "registrada";
  if (/pagad|cancel|correctiv/.test(st)) return "registrada";
  return fuente === "api" ? "borrador" : "registrada";
}

function resultadoFacturaYaEntrada({ numeroBC, proveedor, status, fuente }) {
  const estado = estadoDocumentoCompraBC({ numeroBC, status, fuente });
  return {
    encontrada: true,
    numeroBC: numeroBC || null,
    proveedor: proveedor || null,
    status: status || null,
    estado,
    borrador: estado === "borrador",
  };
}

function elegirMejorMatchFactura(candidatos, proveedorHint) {
  const lista = (candidatos || []).filter((c) => c?.encontrada);
  if (!lista.length) return null;
  if (proveedorHint) {
    const conProv = lista.filter((c) => c.proveedor && proveedoresParecidos(proveedorHint, c.proveedor));
    if (conProv.length) {
      const reg = conProv.find((c) => c.estado === "registrada");
      return reg || conProv[0];
    }
  }
  return lista.find((c) => c.estado === "registrada") || lista[0];
}

// Devuelve el match o null. Prioriza API v2 purchaseInvoices (FC* Open =
// ya registrada; PFC* = borrador). OData histórico solo si hay servicio
// vivo — los 404 se cachean para no bloquear el lote de la bandeja.
async function facturaYaEntradaRapida(vendorInvoiceNumber) {
  const original = String(vendorInvoiceNumber || "").trim();
  const seguro = original.replace(/'/g, "''");
  if (!seguro) return null;
  const token = await obtenerTokenBC();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const api = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const hits = [];
  try {
    const idx = await obtenerIndicePurchaseInvoices();
    const delIdx = idx?.porVendorInvoice?.get(original.toUpperCase());
    if (delIdx?.encontrada) hits.push(delIdx);
  } catch { /* filtro puntual abajo */ }
  if (!hits.length) {
    try {
      const filtro = encodeURIComponent(`vendorInvoiceNumber eq '${seguro}'`);
      const r = await fetchConReintento(
        `${api}/purchaseInvoices?$filter=${filtro}&$top=5&$select=number,vendorName,vendorInvoiceNumber,status`,
        { headers }
      );
      if (r.ok) {
        for (const fila of (await r.json()).value || []) {
          if (String(fila.vendorInvoiceNumber || "").trim().toUpperCase() !== original.toUpperCase()) continue;
          hits.push(resultadoFacturaYaEntrada({
            numeroBC: fila.number,
            proveedor: fila.vendorName,
            status: fila.status,
            fuente: "api",
          }));
        }
      }
    } catch { /* se prueba el histórico publicado */ }
  }
  if (hits.some((h) => h.estado === "registrada")) return elegirMejorMatchFactura(hits);
  if (Date.now() < historicoFacturasCompraFallidoHasta) return elegirMejorMatchFactura(hits);

  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  const servicios = [
    "Hist_facturas_compra_Excel",
    "Hist_fras_compra_Excel",
    "Purch_Inv_Header_Excel",
    "Purchase_Invoice_Header_Excel",
  ];
  const camposFactura = ["Vendor_Invoice_No", "Vendor_Invoice_No_", "VendorInvoiceNo", "Vendor_Invoice_Number"];
  for (const servicio of servicios) {
    if (odataServiciosFacturaMuertos.has(servicio)) continue;
    for (const campo of camposFactura) {
      const clave = `${servicio}|${campo}`;
      if (odataServiciosFacturaMuertos.has(clave)) continue;
      try {
        const filtro = encodeURIComponent(`${campo} eq '${seguro}'`);
        const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${filtro}&$top=5`;
        const r = await fetchConReintento(url, { headers });
        if (!r.ok) {
          if (r.status === 404) odataServiciosFacturaMuertos.add(servicio);
          else odataServiciosFacturaMuertos.add(clave);
          continue;
        }
        for (const fila of (await r.json()).value || []) {
          const numProv = fila[campo] || fila.Vendor_Invoice_No || fila.Vendor_Invoice_No_;
          if (String(numProv || "").trim().toUpperCase() !== original.toUpperCase()) continue;
          hits.push(resultadoFacturaYaEntrada({
            numeroBC: fila.No || fila.No_ || fila.Document_No || fila.Document_No_ || null,
            proveedor: fila.Buy_from_Vendor_Name || fila.Vendor_Name || fila.Buy_from_Vendor_Name_ || null,
            fuente: "historico",
          }));
        }
        if (hits.some((h) => h.estado === "registrada")) return elegirMejorMatchFactura(hits);
      } catch { /* siguiente columna / servicio */ }
    }
  }
  return elegirMejorMatchFactura(hits);
}

async function facturaYaEntradaEnBC(vendorInvoiceNumber, opts = {}) {
  if (!vendorInvoiceNumber) return { encontrada: false };
  const proveedorHint = String(opts.proveedor || "").trim();
  try {
    try {
      const rapida = await facturaYaEntradaRapida(vendorInvoiceNumber);
      if (rapida?.encontrada) {
        const mejor = elegirMejorMatchFactura([rapida], proveedorHint) || rapida;
        if (!proveedorHint || !mejor.proveedor || proveedoresParecidos(proveedorHint, mejor.proveedor) || mejor.estado === "registrada") {
          return mejor;
        }
      }
    } catch (e) {
      console.warn("[facturas-compra/duplicados] Consulta directa falló, se mira el histórico:", String(e.message || e));
    }

    if (Date.now() < historicoFacturasCompraFallidoHasta) return { encontrada: false };

    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const cabeceras = { headers: { Authorization: `Bearer ${token}` } };

    const historico = await obtenerHistoricoFacturasCompra(raiz, cabeceras);
    if (!historico) return { encontrada: false };

    const objetivo = vendorInvoiceNumber.toString().trim().toUpperCase();
    const filas = historico.filas.filter((f) => (f[historico.campoFactura] || "").toString().trim().toUpperCase() === objetivo);
    if (!filas.length) return { encontrada: false };

    const candidatos = filas.map((fila) => resultadoFacturaYaEntrada({
      numeroBC: historico.campoNumero ? fila[historico.campoNumero] : null,
      proveedor: historico.campoProveedor ? fila[historico.campoProveedor] : null,
      fuente: "historico",
    }));
    return elegirMejorMatchFactura(candidatos, proveedorHint) || candidatos[0];
  } catch (e) {
    console.warn("[facturas-compra/duplicados] Error comprobando duplicado:", String(e.message || e));
    return { encontrada: false };
  }
}

async function marcarFacturaDetectadaEnBandeja({ factura, msg, att, chequeo }) {
  if (!chequeo?.encontrada || chequeo.borrador || chequeo.estado === "borrador") return { marcada: false };
  const num = String(factura || "").trim();
  const motivo = `⚠ Esta factura ya está registrada en BC: ${chequeo.numeroBC || "?"}${chequeo.proveedor ? " · " + chequeo.proveedor : ""}. No se analiza ni se crea borrador.`;
  try {
    const d = await leerIndicePdfPendientes();
    let tocado = false;
    for (const it of d.items || []) {
      const mismaFac = num && (it.factura === num || it.extraida?.factura === num || (it.facturas || []).includes(num));
      const mismoMail = msg && it.msg === msg && String(it.att ?? "") === String(att ?? "");
      if (!mismaFac && !mismoMail) continue;
      const previa = it.extraida || {};
      it.extraida = {
        ...previa,
        yaEntrada: true,
        veredicto: "ya_entrada",
        entradaInfo: chequeo,
        motivos: [motivo],
      };
      if (num) it.factura = num;
      tocado = true;
      if (it.msg && it.att != null && it.att !== "") {
        const mailClave = `mail:${it.msg}|${it.att}`;
        if (!(d.registradas || []).includes(mailClave)) d.registradas = [mailClave, ...(d.registradas || [])];
      }
    }
    if (num && !(d.registradas || []).includes(`fac:${num}`)) {
      d.registradas = [`fac:${num}`, ...(d.registradas || [])];
      tocado = true;
    }
    if (msg && att != null && att !== "") {
      const mailClave = `mail:${msg}|${att}`;
      if (!(d.registradas || []).includes(mailClave)) {
        d.registradas = [mailClave, ...(d.registradas || [])];
        tocado = true;
      }
    }
    if (tocado) await escribirIndicePdfPendientes(d);
  } catch (e) {
    console.warn("[facturas-pdf] No se pudo marcar la factura ya entrada en bandeja:", String(e.message || e));
    return { marcada: false };
  }
  return { marcada: true };
}

// Regla permanente (Maria): TODAS las facturas de la bandeja cuyo nº de
// proveedor ya esté registrado en BC (histórico FC* / Open/Paid) salen de
// Pendientes → Entradas. PFC* solo avisa «ya hay borrador». Sin tope: el
// bucle de 5 min y el POST deben recorrer el conjunto pendiente completo
// (antes el limite 25/40 re-chequeaba siempre las mismas y las de más
// abajo nunca salían).
async function reconciliarFacturasYaEntradasEnBC({ soloFactura = null, limite = null } = {}) {
  const d = await leerIndicePdfPendientes();
  const reg = new Set(d.registradas || []);
  // Reparar índices a medias: fac:/mail: en registradas pero sin
  // yaEntrada / sin mail: → que salgan de Pendientes sin reconsultar BC.
  let reparadas = 0;
  for (const it of d.items || []) {
    const fac = String(it.extraida?.factura || it.factura || "").trim();
    if (soloFactura && fac && fac.toUpperCase() !== String(soloFactura).trim().toUpperCase()) continue;
    const mailClave = it.msg && it.att != null && it.att !== "" ? `mail:${it.msg}|${it.att}` : null;
    const yaReg = (fac && reg.has(`fac:${fac}`)) || (mailClave && reg.has(mailClave));
    if (!yaReg) continue;
    const previa = it.extraida || {};
    const faltaFlag = !(previa.yaEntrada || previa.veredicto === "ya_entrada");
    const faltaMail = mailClave && !reg.has(mailClave);
    if (!faltaFlag && !faltaMail) continue;
    const chequeo = previa.entradaInfo && previa.entradaInfo.encontrada
      ? previa.entradaInfo
      : { encontrada: true, estado: "registrada", numeroBC: previa.entradaInfo?.numeroBC || null, proveedor: previa.proveedor || null, borrador: false };
    if (chequeo.borrador || chequeo.estado === "borrador") continue;
    await marcarFacturaDetectadaEnBandeja({ factura: fac || previa.factura, msg: it.msg, att: it.att, chequeo });
    if (mailClave) reg.add(mailClave);
    if (fac) reg.add(`fac:${fac}`);
    reparadas += 1;
  }

  const dFresh = reparadas ? await leerIndicePdfPendientes() : d;
  const regFresh = new Set(dFresh.registradas || []);
  const pendientes = [];
  for (const it of dFresh.items || []) {
    const fac = String(it.extraida?.factura || it.factura || "").trim();
    if (!fac) continue;
    if (soloFactura && fac.toUpperCase() !== String(soloFactura).trim().toUpperCase()) continue;
    if (it.extraida?.yaEntrada || it.extraida?.veredicto === "ya_entrada") continue;
    if (regFresh.has(`fac:${fac}`)) continue;
    if (it.msg && it.att != null && regFresh.has(`mail:${it.msg}|${it.att}`)) continue;
    pendientes.push(it);
  }
  const vistos = new Set();
  const unicos = [];
  const tope = limite == null || !Number.isFinite(Number(limite)) || Number(limite) <= 0
    ? null
    : Math.floor(Number(limite));
  for (const it of pendientes) {
    const fac = String(it.extraida?.factura || it.factura || "").trim().toUpperCase();
    if (vistos.has(fac)) continue;
    vistos.add(fac);
    unicos.push(it);
    if (tope != null && unicos.length >= tope) break;
  }
  // Una sola carga de purchaseInvoices (Open/Draft/Paid) para emparejar
  // todo el lote por vendorInvoiceNumber — evita N idas a BC y el martilleo
  // OData cuando el histórico publicado no trae Vendor Invoice No.
  if (unicos.length) {
    try {
      await obtenerIndicePurchaseInvoices();
    } catch (e) {
      console.warn("[bandeja] Precarga purchaseInvoices para reconciliar:", String(e.message || e));
    }
  }
  const resultados = [];
  let marcadas = 0;
  let borradores = 0;
  for (const it of unicos) {
    const fac = String(it.extraida?.factura || it.factura || "").trim();
    const proveedor = it.extraida?.proveedor || "";
    try {
      const chequeo = await facturaYaEntradaEnBC(fac, { proveedor });
      if (!chequeo.encontrada) {
        resultados.push({ factura: fac, encontrada: false });
        continue;
      }
      if (chequeo.borrador || chequeo.estado === "borrador") {
        const d2 = await leerIndicePdfPendientes();
        const facUp = fac.toUpperCase();
        for (const x of d2.items || []) {
          const xFac = String(x.extraida?.factura || x.factura || "").trim();
          const mismaFac = xFac && xFac.toUpperCase() === facUp;
          const mismoMail = x.msg === it.msg && String(x.att ?? "") === String(it.att ?? "");
          if (!mismaFac && !mismoMail) continue;
          const previa = x.extraida || {};
          if (previa.yaEntrada || previa.veredicto === "ya_entrada") continue;
          x.extraida = {
            ...previa,
            yaBorrador: true,
            veredicto: "ya_borrador",
            entradaInfo: chequeo,
            motivos: [
              `⚠ Esta factura ya tiene un borrador en BC (${chequeo.numeroBC || "PFC…"}). No se crea otro.`,
              ...(previa.motivos || []).filter((m) => !String(m).includes("borrador en BC")),
            ],
          };
        }
        await escribirIndicePdfPendientes(d2);
        borradores += 1;
        resultados.push({ factura: fac, encontrada: true, estado: "borrador", numeroBC: chequeo.numeroBC });
        continue;
      }
      await marcarFacturaDetectadaEnBandeja({ factura: fac, msg: it.msg, att: it.att, chequeo });
      marcadas += 1;
      resultados.push({ factura: fac, encontrada: true, estado: "registrada", numeroBC: chequeo.numeroBC, marcada: true });
    } catch (e) {
      resultados.push({ factura: fac, error: String(e.message || e) });
    }
  }
  return {
    revisadas: resultados.length,
    pendientesConNumero: pendientes.length,
    unicasRevisadas: unicos.length,
    marcadas: marcadas + reparadas,
    marcadasBc: marcadas,
    reparadas,
    borradores,
    resultados,
  };
}

// -----------------------------------------------------------------------
// PROVEEDORES DE GASTO (Maria, 2026-09-04): "hay proveedores que son de
// gasto y estos se entran sin pedido, se entran con tipo cuenta y la
// cuenta de gasto que le corresponda [...] añadas el Nº de OT, porque
// siempre es la misma". En vez de mantener una lista a mano (que Maria
// no tiene), se detectan solos mirando el HISTÓRICO de líneas de
// factura de compra ya entradas en BC — el mismo servicio
// "Hist_líns_facturas_compra_Excel" que ya se carga para el aviso de
// duplicados (cero llamadas nuevas): de las líneas que NO son de tipo
// Artículo/Item, se agrupa por proveedor y se calcula la cuenta y el
// Nº de OT MÁS FRECUENTES con los que se ha entrado siempre.
//
// De momento (2026-09-04) esto es SOLO DE LECTURA — se detecta y se
// sugiere en pantalla (cuenta + OT), pero "Entrar en BC" sigue creando
// solo la cabecera, como con cualquier otra factura; la línea de tipo
// Cuenta la crea Maria a mano en BC con el dato ya identificado. No se
// ha adivinado el nombre de campo de la API de escritura para esa
// línea — mismo criterio que el resto de este archivo: no arriesgarse
// a escribir en BC con un campo sin confirmar.
function normalizarTextoBC(s) {
  return (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function claveProveedor(s) {
  return String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(S\.?\s*L\.?\s*U?\.?|S\.?\s*A\.?|S\.?\s*C\.?|COOP\.?|SOCIEDAD|LIMITADA)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

// El pedido de BC solo vale si su proveedor es el de la factura.
// SECURITYPLA no puede quedar ligado a un pedido de LADISLAO MESTRE.
function proveedoresParecidos(factura, pedido) {
  const a = claveProveedor(factura);
  const b = claveProveedor(pedido);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const corta = a.length < b.length ? a : b;
  const larga = a.length < b.length ? b : a;
  return corta.length >= 6 && larga.includes(corta.slice(0, 6));
}

function columnasHistLineas(headers) {
  const find = (res) => {
    for (const re of res) {
      const i = headers.findIndex((h) => re.test(h));
      if (i >= 0) return headers[i];
    }
    return "";
  };
  return {
    // Tipo de línea (Item/Artículo vs Cuenta/G-L Account/Recurso...).
    tipo: find([/^type$/i, /^tipo$/i, /tipo.*l.?nea/i, /line.?type/i]),
    // Nº de cuenta contable (en una línea de tipo Cuenta, el mismo campo
    // que en una de tipo Item traería el código de artículo).
    cuenta: find([/^g.?l.?account.?no.?_?$/i, /^account.?no.?_?$/i, /^no_?$/i, /n.?\s*cuenta/i, /cuenta.?contable/i]),
    // Nº de OT — mismo campo custom que ya usa el resto de la app
    // (CAMPO_OT_BC) si está expuesto en esta fuente, o alternativas
    // habituales (dimensión, "Obra").
    ot: find([
      new RegExp(`^${CAMPO_OT_BC}$`, "i"),
      /n.?\s*ot\b/i,
      /^obra$/i,
      /shortcut.?dimension.?2.?code/i,
      /dimension.*2.*code/i,
    ]),
  };
}

const GASTO_PROVEEDORES_TTL_MS = 10 * 60 * 1000; // 10 min — cambia poco, más margen que el de duplicados
let gastoProveedoresCache = null; // { mapa, columnas, columnasDisponibles, servicio, totalFilasAnalizadas, totalProveedores, calculadoEn }

function calcularProveedoresDeGasto(historico) {
  const headers = Object.keys(historico.filas[0] || {});
  const cols = columnasHistLineas(headers);
  const porProveedor = new Map(); // clave normalizada -> { proveedorOriginal, cuentas: Map, ots: Map, vecesVisto }

  if (cols.tipo && cols.cuenta && historico.campoProveedor) {
    for (const fila of historico.filas) {
      const tipoValor = normalizarTextoBC(fila[cols.tipo]);
      // Tipo "Item"/"Artículo" → esa línea SÍ va con pedido, no cuenta
      // aquí. Cualquier otro tipo con algo escrito en "cuenta" se toma
      // como línea de cuenta contable (lo habitual: "G/L Account"/"Cuenta").
      if (!tipoValor || /item|art.?culo/.test(tipoValor)) continue;
      const cuenta = (fila[cols.cuenta] || "").toString().trim();
      if (!cuenta) continue;
      const proveedorOriginal = (fila[historico.campoProveedor] || "").toString().trim();
      if (!proveedorOriginal) continue;
      const key = normalizarTextoBC(proveedorOriginal);
      if (!porProveedor.has(key)) {
        porProveedor.set(key, { proveedorOriginal, cuentas: new Map(), ots: new Map(), vecesVisto: 0 });
      }
      const entry = porProveedor.get(key);
      entry.vecesVisto++;
      entry.cuentas.set(cuenta, (entry.cuentas.get(cuenta) || 0) + 1);
      if (cols.ot) {
        const ot = (fila[cols.ot] || "").toString().trim();
        if (ot) entry.ots.set(ot, (entry.ots.get(ot) || 0) + 1);
      }
    }
  }

  const masFrecuente = (mapaValores) => {
    let mejor = null;
    let mejorN = 0;
    for (const [v, n] of mapaValores) {
      if (n > mejorN) { mejor = v; mejorN = n; }
    }
    return mejor;
  };

  const mapa = {};
  for (const [key, entry] of porProveedor) {
    mapa[key] = {
      proveedor: entry.proveedorOriginal,
      cuenta: masFrecuente(entry.cuentas),
      ot: cols.ot ? masFrecuente(entry.ots) : null,
      vecesVisto: entry.vecesVisto,
      cuentasVistas: [...entry.cuentas.entries()].sort((a, b) => b[1] - a[1]).map(([valor, veces]) => ({ valor, veces })),
      otsVistas: cols.ot
        ? [...entry.ots.entries()].sort((a, b) => b[1] - a[1]).map(([valor, veces]) => ({ valor, veces }))
        : [],
    };
  }

  return {
    mapa,
    columnas: cols,
    columnasDisponibles: headers,
    servicio: historico.servicio,
    totalFilasAnalizadas: historico.filas.length,
    totalProveedores: Object.keys(mapa).length,
  };
}

async function obtenerProveedoresDeGasto(raiz, cabeceras) {
  if (gastoProveedoresCache && Date.now() - gastoProveedoresCache.calculadoEn < GASTO_PROVEEDORES_TTL_MS) {
    return gastoProveedoresCache;
  }
  const historico = await obtenerHistoricoFacturasCompra(raiz, cabeceras);
  if (!historico || !historico.filas.length) return null;
  gastoProveedoresCache = { ...calcularProveedoresDeGasto(historico), calculadoEn: Date.now() };
  return gastoProveedoresCache;
}

// Cuando la factura llega sin pedido de compra, se mira la ÚLTIMA factura
// de compra ya entrada de ese proveedor (no la cuenta más frecuente) y se
// propone entrar esta igual: mismo tipo de línea, misma cuenta, misma OT
// y mismo departamento. Los importes salen del PDF de ahora.
function columnasUltimaEntrada(headers) {
  const base = columnasHistLineas(headers);
  const find = (res) => {
    for (const re of res) {
      const i = headers.findIndex((h) => re.test(h));
      if (i >= 0) return headers[i];
    }
    return "";
  };
  return {
    ...base,
    fecha: find([/^Posting_Date$/i, /^Document_Date$/i, /fecha.*regist/i]),
    documento: find([/^Document_No_?$/i]),
    pedido: find([/^Order_No_?$/i, /^Pedido_No/i]),
    proveedorNo: find([/Buy.?from.?Vendor.?No/i, /^Vendor_No_?$/i, /Pay.?to.?Vendor.?No/i]),
    descripcion: find([/^Description$/i, /^Descripci[oó]n$/i]),
    importe: find([/^Line_Amount$/i, /^Amount$/i, /^Importe$/i]),
    cantidad: find([/^Quantity$/i, /^Cantidad$/i]),
    precio: find([/^Direct_Unit_Cost$/i, /^Unit_Cost$/i, /coste.*unit/i]),
    departamento: find([/Shortcut_Dimension_1_Code/i, /Global_Dimension_1_Code/i]),
  };
}

function fechaFilaHistorico(valor) {
  const s = (valor || "").toString().trim();
  if (!s) return "";
  const d = Date.parse(s);
  return Number.isNaN(d) ? "" : new Date(d).toISOString();
}

function tipoLineaApi(tipoValor) {
  const t = normalizarTextoBC(tipoValor);
  if (/item|art/.test(t)) return "Item";
  if (/recurso|resource/.test(t)) return "Resource";
  if (/cargo|charge/.test(t)) return "Charge";
  if (!t || /cuenta|g\/?l|account/.test(t)) return "Account";
  return null;
}

async function buscarNumeroProveedor(nombre) {
  if (!nombre) return "";
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
    const headers = { Authorization: `Bearer ${token}` };
    const filtro = encodeURIComponent(`displayName eq '${String(nombre).replace(/'/g, "''")}'`);
    const r = await fetchConReintento(`${base}/vendors?$filter=${filtro}&$select=number,displayName&$top=5`, { headers });
    if (r.ok) {
      const j = await r.json();
      if (j.value?.[0]?.number) return String(j.value[0].number);
    }
    const r2 = await fetchConReintento(`${base}/vendors?$select=number,displayName&$top=400`, { headers });
    if (!r2.ok) return "";
    const j2 = await r2.json();
    const hit = (j2.value || []).find((v) => v.displayName && proveedoresParecidos(nombre, v.displayName));
    return hit?.number ? String(hit.number) : "";
  } catch (e) {
    console.warn("[facturas-compra/ultima] No se pudo buscar el proveedor:", String(e.message || e));
    return "";
  }
}

async function lineasHistoricoDelProveedor(raiz, cabeceras, nombreProveedor) {
  const palabra = String(nombreProveedor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .match(/[A-Z]{4,}/);
  const trozo = (palabra ? palabra[0] : "").slice(0, 12);
  if (trozo.length < 4) return null;
  const filtro = encodeURIComponent(`contains(Buy_from_Vendor_Name,'${trozo.replace(/'/g, "''")}')`);
  const servicio = "Hist_líns_facturas_compra_Excel";
  const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${filtro}&$orderby=Document_No desc&$top=80`;
  const r = await fetchConReintento(url, cabeceras);
  if (!r.ok) return null;
  const filas = ((await r.json()).value || []).filter((fila) => proveedoresParecidos(nombreProveedor, fila.Buy_from_Vendor_Name || ""));
  return filas.length ? filas : null;
}

function otUtil(valor) {
  const s = String(valor || "").trim();
  if (!s || /^_?sin[_\s-]*ot$/i.test(s)) return "";
  return s;
}

/** Ferros Coll de l'Alba como proveedor: pedido con cuenta 60700004 (trabajos grupo). */
const REGLA_FERROS_GRUPO = {
  id: "ferros-grupo",
  cuenta: "60700004",
  descripcion: "TRABAJOS ENTRE EMPRESAS DEL GRUPO",
  lineType: "Account",
};

function esProveedorFerrosGrupo(nombre) {
  const n = normalizarTextoBC(nombre || "");
  if (!n || !/FERROS/.test(n)) return false;
  return /COLL/.test(n) || /ALBA/.test(n) || /FERROSCA/.test(n);
}

/** OT en factura Ferros: AC00XXXXX/2026 o OT XXXXX → formato BC AC######/AAAA. */
function normalizarOtFactura(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  const ac = s.match(/\bAC0?(\d{4,6})\/(\d{4})\b/);
  if (ac) return `AC${String(parseInt(ac[1], 10)).padStart(6, "0")}/${ac[2]}`;
  const ot = s.match(/\bOT\s*0*(\d{3,6})\b/);
  if (ot) return `AC${String(parseInt(ot[1], 10)).padStart(6, "0")}/${new Date().getFullYear()}`;
  return otUtil(s);
}

function extraerOtDeTextoFactura(texto) {
  const t = String(texto || "");
  const ac = t.match(/\bAC0?\d{4,6}\/\d{4}\b/i);
  if (ac) return normalizarOtFactura(ac[0]);
  const ot = t.match(/\bOT\s*0*\d{3,6}\b/i);
  if (ot) return normalizarOtFactura(ot[0]);
  return "";
}

function importeDesdeDatosPedido(datos) {
  const base = Number(datos?.baseImponible);
  if (base && !Number.isNaN(base)) return base;
  const lineas = Array.isArray(datos?.lineas) ? datos.lineas : [];
  let sum = 0;
  let hay = false;
  for (const l of lineas) {
    const c = Number(l.cantidad) > 0 ? Number(l.cantidad) : 1;
    const p = Number(l.precioUnitario);
    if (p != null && !Number.isNaN(p)) {
      sum += c * p;
      hay = true;
    }
  }
  return hay ? Math.round(sum * 100) / 100 : null;
}

async function propuestaPedidoFerrosGrupo(datos = {}) {
  const proveedor = String(datos?.proveedor || "").trim();
  const ot = normalizarOtFactura(datos?.ot) || null;
  const vendorNumber = await buscarNumeroProveedor(proveedor);
  return {
    proveedorFactura: proveedor,
    proveedorBC: proveedor || "Ferros Coll de l'Alba, S.L.",
    vendorNumber: vendorNumber || null,
    numeroBC: null,
    facturaProveedor: datos?.factura || null,
    fecha: null,
    cuenta: REGLA_FERROS_GRUPO.cuenta,
    ot,
    departamento: null,
    lineType: REGLA_FERROS_GRUPO.lineType,
    puedeCrear: true,
    regla: REGLA_FERROS_GRUPO.id,
    descripcionFija: REGLA_FERROS_GRUPO.descripcion,
    lineas: [{
      tipo: "Cuenta",
      tipoApi: REGLA_FERROS_GRUPO.lineType,
      cuenta: REGLA_FERROS_GRUPO.cuenta,
      ot: ot || "",
      departamento: "",
      descripcion: REGLA_FERROS_GRUPO.descripcion,
      importe: null,
      cantidad: 1,
      precio: null,
      pedido: "",
    }],
    resumen: ot
      ? `Ferros Coll de l'Alba: pedido con cuenta ${REGLA_FERROS_GRUPO.cuenta}, «${REGLA_FERROS_GRUPO.descripcion}», OT ${ot}. Luego se factura como el resto.`
      : `Ferros Coll de l'Alba: pedido con cuenta ${REGLA_FERROS_GRUPO.cuenta} y «${REGLA_FERROS_GRUPO.descripcion}». Indica la OT (en la factura suele ser AC00…/AAAA o OT …) antes de crear el pedido.`,
  };
}

async function proponerUltimaEntrada(nombreProveedor) {
  if (!nombreProveedor) return null;
  const token = await obtenerTokenBC();
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  const cabeceras = { headers: { Authorization: `Bearer ${token}` } };

  // El histórico de líneas no tiene "Vendor Invoice No.", así que el
  // cargador de duplicados lo descarta y la propuesta salía vacía.
  // Aquí se filtra por el nombre del proveedor y se ordena por nº de factura BC.
  let filasProveedor = await lineasHistoricoDelProveedor(raiz, cabeceras, nombreProveedor);
  let campoProveedor = "Buy_from_Vendor_Name";
  if (!filasProveedor) {
    const historico = await obtenerHistoricoFacturasCompra(raiz, cabeceras);
    if (!historico?.filas?.length || !historico.campoProveedor) return null;
    campoProveedor = historico.campoProveedor;
    filasProveedor = historico.filas.filter((fila) => {
      const nombre = (fila[campoProveedor] || "").toString().trim();
      return nombre && proveedoresParecidos(nombreProveedor, nombre);
    });
  }
  if (!filasProveedor.length) return null;

  const headers = Object.keys(filasProveedor[0]);
  const cols = columnasUltimaEntrada(headers);
  const delProveedor = filasProveedor;
  if (!delProveedor.length) return null;

  const grupos = new Map();
  for (const fila of delProveedor) {
    const doc = (cols.documento ? fila[cols.documento] : "") || "";
    const claveDoc = String(doc || "").trim();
    if (!claveDoc) continue;
    if (!grupos.has(claveDoc)) {
      grupos.set(claveDoc, {
        clave: claveDoc,
        fecha: "",
        filas: [],
        proveedor: (fila[campoProveedor] || "").toString().trim(),
        vendorNumber: cols.proveedorNo ? String(fila[cols.proveedorNo] || "").trim() : "",
      });
    }
    const gdoc = grupos.get(claveDoc);
    gdoc.filas.push(fila);
    const fch = cols.fecha ? fechaFilaHistorico(fila[cols.fecha]) : "";
    if (fch && fch > gdoc.fecha) gdoc.fecha = fch;
    if (!gdoc.vendorNumber && cols.proveedorNo) gdoc.vendorNumber = String(fila[cols.proveedorNo] || "").trim();
  }
  const lista = [...grupos.values()];
  if (!lista.length) return null;
  lista.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(b.clave).localeCompare(String(a.clave)));

  // La factura más nueva de este proveedor, tal como se entró (cuenta o artículo).
  const elegido = lista[0];
  const lineaDe = (fila) => ({
    tipo: cols.tipo ? String(fila[cols.tipo] || "").trim() : "",
    tipoApi: tipoLineaApi(cols.tipo ? fila[cols.tipo] : ""),
    cuenta: cols.cuenta ? String(fila[cols.cuenta] || "").trim() : "",
    ot: cols.ot ? otUtil(fila[cols.ot]) : "",
    departamento: cols.departamento ? String(fila[cols.departamento] || "").trim() : "",
    descripcion: cols.descripcion ? String(fila[cols.descripcion] || "").trim() : "",
    importe: cols.importe && fila[cols.importe] != null && fila[cols.importe] !== "" ? Number(fila[cols.importe]) : null,
    cantidad: cols.cantidad && fila[cols.cantidad] != null && fila[cols.cantidad] !== "" ? Number(fila[cols.cantidad]) : null,
    precio: cols.precio && fila[cols.precio] != null && fila[cols.precio] !== "" ? Number(fila[cols.precio]) : null,
    pedido: cols.pedido ? String(fila[cols.pedido] || "").trim() : "",
  });
  const lineas = elegido.filas.map(lineaDe).filter((l) => l.cuenta || l.descripcion).slice(0, 12);
  const principal = lineas.find((l) => l.cuenta && l.tipoApi) || lineas.find((l) => l.cuenta) || null;
  const facturaProveedor = "";
  const numeroBC = cols.documento ? elegido.clave : elegido.clave;
  const fechaCorta = elegido.fecha ? elegido.fecha.slice(0, 10) : null;
  const puedeCrear = !!(principal?.cuenta && principal?.tipoApi);
  let vendorNumber = elegido.vendorNumber || "";
  if (puedeCrear && !vendorNumber) vendorNumber = await buscarNumeroProveedor(elegido.proveedor || nombreProveedor);

  const ref = `${numeroBC || facturaProveedor || "sin número"}${fechaCorta ? ` del ${fechaCorta}` : ""}`;
  const nombre = elegido.proveedor || nombreProveedor;
  const tipoTxt = principal?.tipo || principal?.tipoApi || "línea";
  const otTxt = principal?.ot ? `, OT ${principal.ot}` : "";
  const deptoTxt = principal?.departamento ? `, dimensión ${principal.departamento}` : "";
  const resumen = puedeCrear
    ? `No hay pedido de compra. La factura más nueva de ${nombre} es ${ref}. Se propone crear un pedido igual: ${tipoTxt} ${principal.cuenta}${otTxt}${deptoTxt}. La cantidad y el precio salen de este PDF.`
    : `No hay pedido de compra y no se ha podido leer cómo se entró la factura más nueva de ${nombre}.`;

  return {
    proveedorFactura: nombreProveedor,
    proveedorBC: nombre,
    vendorNumber: vendorNumber || null,
    numeroBC: numeroBC || null,
    facturaProveedor: facturaProveedor || null,
    fecha: fechaCorta,
    cuenta: principal?.cuenta || null,
    ot: principal?.ot || null,
    departamento: principal?.departamento || null,
    lineType: principal?.tipoApi || null,
    puedeCrear,
    lineas,
    resumen,
  };
}

function lineasBorradorComoUltima(comoUltima, propuesta) {
  const crudas = Array.isArray(comoUltima?.lineas) ? comoUltima.lineas : [];
  const utiles = crudas.filter((l) => l && (l.descripcion || l.precioUnitario != null || l.cantidad != null));
  const tipo = propuesta.lineType || "Account";
  const cuenta = propuesta.cuenta;
  const base = (l) => ({
    codigoBC: cuenta,
    lineType: tipo,
    ot: propuesta.ot || null,
    depto: propuesta.departamento || null,
    coincidencia: "manual",
  });
  if (utiles.length) {
    return utiles.map((l) => ({
      ...base(l),
      descripcion: String(l.descripcion || `Factura ${comoUltima.factura || ""}`).trim().slice(0, 100),
      cantidad: Number(l.cantidad) > 0 ? Number(l.cantidad) : 1,
      precio: l.precioUnitario != null && l.precioUnitario !== "" && !Number.isNaN(Number(l.precioUnitario)) ? Number(l.precioUnitario) : null,
    }));
  }
  const importe = Number(comoUltima?.baseImponible);
  if (!importe) return [];
  return [{
    ...base(),
    descripcion: `Factura ${comoUltima.factura || ""}`.trim().slice(0, 100),
    cantidad: 1,
    precio: importe,
  }];
}

function lineasPedidoComoUltima(datos, propuesta) {
  if (propuesta?.regla === REGLA_FERROS_GRUPO.id) {
    const importe = importeDesdeDatosPedido(datos);
    if (importe == null || !propuesta.cuenta) return [];
    const ot = normalizarOtFactura(datos?.ot) || otUtil(propuesta.ot) || null;
    return [{
      codigoBC: REGLA_FERROS_GRUPO.cuenta,
      lineType: REGLA_FERROS_GRUPO.lineType,
      ot,
      depto: null,
      descripcion: REGLA_FERROS_GRUPO.descripcion,
      cantidad: 1,
      precio: importe,
    }];
  }
  const plantillas = (propuesta.lineas || []).filter((l) => l.cuenta && l.tipoApi);
  const pdf = (Array.isArray(datos?.lineas) ? datos.lineas : []).filter((l) => l && (l.descripcion || l.precioUnitario != null || l.cantidad != null));
  const mezclar = (plantilla, actual) => ({
    codigoBC: plantilla.cuenta,
    lineType: plantilla.tipoApi,
    ot: plantilla.ot || null,
    depto: plantilla.departamento || null,
    descripcion: String((actual?.descripcion || plantilla.descripcion || `Factura ${datos?.factura || ""}`)).trim().slice(0, 100),
    cantidad: Number(actual?.cantidad) > 0 ? Number(actual.cantidad) : (Number(plantilla.cantidad) > 0 ? Number(plantilla.cantidad) : 1),
    precio: actual?.precioUnitario != null && actual.precioUnitario !== "" && !Number.isNaN(Number(actual.precioUnitario))
      ? Number(actual.precioUnitario)
      : (plantilla.precio != null && !Number.isNaN(Number(plantilla.precio)) ? Number(plantilla.precio) : null),
  });
  if (pdf.length && plantillas.length === pdf.length) return pdf.map((l, i) => mezclar(plantillas[i], l));
  if (pdf.length && plantillas[0]) return pdf.map((l) => mezclar(plantillas[0], l));
  if (plantillas.length) return plantillas.map((p) => mezclar(p, null));
  const importe = Number(datos?.baseImponible);
  if (!importe || !propuesta.cuenta) return [];
  return [mezclar({ cuenta: propuesta.cuenta, tipoApi: propuesta.lineType || "Account", ot: propuesta.ot, departamento: propuesta.departamento, descripcion: "" }, { cantidad: 1, precioUnitario: importe, descripcion: `Factura ${datos?.factura || ""}` })];
}

let cacheDimGlobal = null;

async function dimensionesGlobales(token) {
  if (cacheDimGlobal) return cacheDimGlobal;
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  for (const servicio of ["General_Ledger_Setup", "GeneralLedgerSetup"]) {
    const r = await fetchConReintento(`${raiz}/${encodeURIComponent(servicio)}?$top=1`, { headers });
    if (!r.ok) continue;
    const fila = ((await r.json()).value || [])[0] || {};
    const d1 = fila.Global_Dimension_1_Code || null;
    const d2 = fila.Global_Dimension_2_Code || null;
    if (d1 || d2) {
      cacheDimGlobal = { d1, d2 };
      return cacheDimGlobal;
    }
  }
  cacheDimGlobal = { d1: null, d2: null };
  return cacheDimGlobal;
}

async function ponerValorDimension(urlColeccion, code, valueCode, token) {
  if (!code || !valueCode) return "Falta el código de la dimensión en BC.";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" };
  const rLista = await fetchConReintento(urlColeccion, { headers });
  if (!rLista.ok) {
    const txt = (await rLista.text().catch(() => "")).slice(0, 180);
    return `BC ${rLista.status} ${txt}`.trim();
  }
  const existentes = ((await rLista.json()).value || []);
  const ya = existentes.find((d) => String(d.code || "").toUpperCase() === String(code).toUpperCase());
  if (ya && ya.valueCode === valueCode) return null;
  const r = ya?.id
    ? await fetchConReintento(`${urlColeccion}(${ya.id})`, { method: "PATCH", headers, body: JSON.stringify({ valueCode }) })
    : await fetchConReintento(urlColeccion, { method: "POST", headers, body: JSON.stringify({ code, valueCode }) });
  if (r.ok) return null;
  const txt = (await r.text().catch(() => "")).slice(0, 200);
  return `BC ${r.status} ${txt}`.trim();
}

async function ponerOtEnLineaApi(lineaId, linea, token) {
  if (!lineaId || (!linea?.depto && !linea?.ot)) return null;
  const dims = await dimensionesGlobales(token);
  const urlBase = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const url = `${urlBase}/purchaseOrderLines(${lineaId})/dimensionSetLines`;
  const avisos = [];
  if (linea.depto) {
    if (!dims.d1) avisos.push("No encuentro en BC el código de la dimensión de departamento.");
    else {
      const mal = await ponerValorDimension(url, dims.d1, linea.depto, token);
      if (mal) avisos.push(`No se pudo poner la dimensión ${linea.depto}: ${mal}`);
    }
  }
  if (linea.ot) {
    if (!dims.d2) avisos.push("No encuentro en BC el código de la dimensión de la OT.");
    else {
      const mal = await ponerValorDimension(url, dims.d2, linea.ot, token);
      if (mal) avisos.push(`No se pudo poner la OT ${linea.ot}: ${mal}`);
    }
  }
  return avisos.length ? avisos.join(" ") : null;
}

function raizODataBC() {
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
}

async function parcheOData(url, cuerpo, token) {
  const r = await fetchConReintento(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "If-Match": "*",
    },
    body: JSON.stringify(cuerpo),
  });
  if (r.ok) return null;
  const txt = (await r.text().catch(() => "")).slice(0, 220);
  return `BC ${r.status} ${txt}`.trim();
}

// «Cód. OT» de la pantalla es Shortcut_Dimension_2_Code. Las dimensiones
// de la API no rellenan esa casilla.
async function escribirOtPedidoCompra(numero, ot, token) {
  if (!numero || !ot) return null;
  const raiz = raizODataBC();
  const esc = String(numero).replace(/'/g, "''");
  const servicio = FUENTES_WS.pedidos_compra.servicio;
  const cabeceras = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const malCab = await parcheOData(
    `${raiz}/${encodeURIComponent(servicio)}(Document_Type='Order',No='${esc}')`,
    { Shortcut_Dimension_2_Code: ot },
    token
  );
  const avisos = [];
  if (malCab) avisos.push(`No se pudo poner la OT en la cabecera del pedido: ${malCab}`);
  const servicioLineas = servicio + "PurchLines";
  let r = await fetchConReintento(
    `${raiz}/${encodeURIComponent(servicioLineas)}?$filter=${encodeURIComponent(`Document_No eq '${esc}'`)}&$select=Line_No,Type,Shortcut_Dimension_2_Code`,
    { headers: cabeceras }
  );
  if (!r.ok) {
    r = await fetchConReintento(
      `${raiz}/${encodeURIComponent(servicioLineas)}?$filter=${encodeURIComponent(`Document_No eq '${esc}'`)}&$select=Line_No,Shortcut_Dimension_2_Code`,
      { headers: cabeceras }
    );
  }
  if (!r.ok) {
    avisos.push(`No se pudieron leer las líneas para el Cód. OT: BC ${r.status}`);
    return avisos.join(" ") || null;
  }
  for (const f of (await r.json()).value || []) {
    if (!f.Line_No || /comment/i.test(String(f.Type || ""))) continue;
    if (String(f.Shortcut_Dimension_2_Code || "") === ot) continue;
    const clave = `(Document_Type='Order',Document_No='${esc}',Line_No=${Number(f.Line_No)})`;
    const mal = await parcheOData(
      `${raiz}/${encodeURIComponent(servicioLineas)}${clave}`,
      { Shortcut_Dimension_2_Code: ot },
      token
    );
    if (mal) avisos.push(`Línea ${f.Line_No}: ${mal}`);
  }
  return avisos.length ? avisos.join(" ") : null;
}

async function otsDeFacturaRegistrada(base, token, facturaId) {
  const dims = await dimensionesGlobales(token);
  const codigoOt = String(dims.d2 || "OT").toUpperCase();
  const valor = (lista) => {
    const hit = (lista || []).find((d) => String(d.code || "").toUpperCase() === codigoOt);
    return hit?.valueCode ? String(hit.valueCode) : "";
  };
  const cab = await bcPedir(`${base}/salesInvoices(${facturaId})/dimensionSetLines`, token);
  const otCab = cab.ok ? valor(cab.json?.value) : "";
  let lin = await bcPedir(`${base}/salesInvoices(${facturaId})/salesInvoiceLines?$select=id,sequence,lineType,lineObjectNumber`, token);
  if (!lin.ok) lin = await bcPedir(`${base}/salesInvoices(${facturaId})/salesInvoiceLines`, token);
  const porLinea = [];
  if (lin.ok) {
    for (const l of (lin.json?.value || []).slice(0, 40)) {
      if (!l.id || String(l.lineType || "") === "Comment") continue;
      const d = await bcPedir(`${base}/salesInvoices(${facturaId})/salesInvoiceLines(${l.id})/dimensionSetLines`, token);
      const ot = d.ok ? valor(d.json?.value) : "";
      if (ot) porLinea.push({ lineNumber: Number(l.sequence) || 0, numero: String(l.lineObjectNumber || ""), ot });
    }
  }
  return { ot: otCab || porLinea[0]?.ot || "", porLinea };
}

async function escribirOtDocumentoVenta(token, tipo, numero, ot, porLinea) {
  if (!numero || !ot) return null;
  const documentType = tipo === "abono" ? "Credit Memo" : "Invoice";
  const raiz = raizODataBC();
  const esc = String(numero).replace(/'/g, "''");
  const cabeceras = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const filtro = encodeURIComponent(`number eq '${esc}' and documentType eq '${documentType}'`);
  const r = await fetchConReintento(
    `${raiz}/salesDocuments?$filter=${filtro}&$select=id,number&$top=2`,
    { headers: cabeceras }
  );
  if (!r.ok) return `No he podido abrir el documento para poner la OT: BC ${r.status}`;
  const doc = ((await r.json()).value || [])[0];
  if (!doc?.id) return `No encuentro ${numero} para poner el Cód. OT.`;
  const avisos = [];
  const malCab = await parcheOData(`${raiz}/salesDocuments(${doc.id})`, { shortcutDimension2Code: ot }, token);
  if (malCab) avisos.push(`No se pudo poner la OT en la cabecera: ${malCab}`);
  const filtroL = encodeURIComponent(`documentNumber eq '${esc}' and documentType eq '${documentType}'`);
  const rl = await fetchConReintento(
    `${raiz}/salesDocumentLines?$filter=${filtroL}&$select=lineNumber,type,number,shortcutDimension2Code`,
    { headers: cabeceras }
  );
  if (!rl.ok) {
    avisos.push(`No se pudieron leer las líneas para el Cód. OT: BC ${rl.status}`);
    return avisos.join(" ") || null;
  }
  for (const f of (await rl.json()).value || []) {
    if (!f.lineNumber || /comment/i.test(String(f.type || ""))) continue;
    const especifica = (porLinea || []).find((p) => p.lineNumber && p.lineNumber === Number(f.lineNumber))
      || (porLinea || []).find((p) => p.numero && p.numero === String(f.number || ""));
    const valor = especifica?.ot || ot;
    if (String(f.shortcutDimension2Code || "") === valor) continue;
    const clave = `(documentType='${documentType}',documentNumber='${esc}',lineNumber=${Number(f.lineNumber)})`;
    const mal = await parcheOData(`${raiz}/salesDocumentLines${clave}`, { shortcutDimension2Code: valor }, token);
    if (mal) avisos.push(`Línea ${f.lineNumber}: ${mal}`);
  }
  return avisos.length ? avisos.join(" ") : null;
}

async function aplicarOtAlPedido(pedido) {
  const ot = pedido?.plantilla?.ot || null;
  const depto = pedido?.plantilla?.departamento || null;
  if (!pedido?.id || (!ot && !depto)) return pedido;
  const token = await obtenerTokenBC();
  const urlBase = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" };
  const avisos = (pedido.avisos || []).filter((a) => !/poner la OT|dimensión/i.test(a));
  const dims = await dimensionesGlobales(token);
  const urlCab = `${urlBase}/purchaseOrders(${pedido.id})/dimensionSetLines`;
  if (depto && dims.d1) {
    const mal = await ponerValorDimension(urlCab, dims.d1, depto, token);
    if (mal) avisos.push(`No se pudo poner la dimensión en el pedido: ${mal}`);
  }
  if (ot && dims.d2) {
    const mal = await ponerValorDimension(urlCab, dims.d2, ot, token);
    if (mal) avisos.push(`No se pudo poner la OT en el pedido: ${mal}`);
  }
  if ((depto && !dims.d1) || (ot && !dims.d2)) avisos.push("No encuentro en BC el código de la dimensión global para copiar la OT.");
  const cerrar = async (otEnLinea) => {
    if (ot && pedido.numero) {
      const malPagina = await escribirOtPedidoCompra(pedido.numero, ot, token);
      if (malPagina) avisos.push(malPagina);
    }
    return { ...pedido, avisos, otEnLinea };
  };
  const r = await fetchConReintento(`${urlBase}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${pedido.id}`)}`, { headers });
  if (!r.ok) {
    avisos.push(`No se pudieron leer las líneas para poner la OT: BC ${r.status}`);
    return cerrar(false);
  }
  const lineas = ((await r.json()).value || []).filter((l) => l.lineType && !/comment/i.test(l.lineType));
  if (!lineas.length) {
    avisos.push("El pedido no tiene líneas donde poner la OT.");
    return cerrar(false);
  }
  let puestas = 0;
  for (const l of lineas) {
    const aviso = await ponerOtEnLineaApi(l.id, { ot, depto }, token);
    if (aviso) avisos.push(aviso);
    else puestas += 1;
  }
  return cerrar(puestas === lineas.length);
}

function lineasPedidoDesdeLineasBC(datos, extras = {}) {
  const ot = otUtil(datos?.ot) || null;
  const depto = extras.departamento || null;
  return (Array.isArray(datos?.lineasBC) ? datos.lineasBC : [])
    .map((l) => {
      const codigo = String(l?.codigo || l?.codigoBC || "").trim();
      const cantidad = Number(l?.cantidad);
      if (!codigo || !(cantidad > 0)) return null;
      const tipo = String(l?.tipo || l?.lineType || "Item");
      const lineType = /charge/i.test(tipo) ? "Charge" : (/account|cuenta/i.test(tipo) ? "Account" : "Item");
      const precioRaw = l?.coste ?? l?.precio ?? l?.precioUnitario;
      const precio = precioRaw === "" || precioRaw == null || Number.isNaN(Number(precioRaw)) ? null : Number(precioRaw);
      return {
        codigoBC: codigo,
        lineType,
        ot,
        depto,
        descripcion: String(l?.descripcion || "").trim().slice(0, 100) || undefined,
        cantidad,
        precio,
      };
    })
    .filter(Boolean);
}

/** Cód. almacén de la primera línea de artículo del pedido (OData página líneas). */
async function almacenDePedidoCompra(numeroPedido, token) {
  const pedido = String(numeroPedido || "").trim();
  if (!pedido) return null;
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  const servicio = FUENTES_WS.lineas_compra.servicio;
  const esc = pedido.replace(/'/g, "''");
  const r = await fetchConReintento(
    `${raiz}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(`Document_No eq '${esc}'`)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return null;
  const filas = (await r.json()).value || [];
  const conAlmacen = filas.find((f) => String(f.Location_Code || "").trim() && /item|artículo|articulo/i.test(String(f.Type || "")));
  const cualquiera = filas.find((f) => String(f.Location_Code || "").trim());
  const codigo = String((conAlmacen || cualquiera)?.Location_Code || "").trim();
  return codigo || null;
}

async function idAlmacenPorCodigo(codigo, token) {
  const code = String(codigo || "").trim();
  if (!code) return null;
  const r = await fetchConReintento(
    `${urlApiComprasBC()}/locations?$filter=${encodeURIComponent(`code eq '${code.replace(/'/g, "''")}'`)}&$select=id,code&$top=1`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return null;
  return ((await r.json()).value || [])[0]?.id || null;
}

/** Pone almacén en líneas de artículo: locationId por API v2 (el WS de líneas suele ser solo lectura). */
async function ponerAlmacenEnPedidoCompra(pedido, locationCode, token, lineasApi = []) {
  const codigo = String(locationCode || "").trim();
  if (!codigo) return "Falta el Cód. almacén.";
  const locationId = await idAlmacenPorCodigo(codigo, token);
  if (!locationId) return `No encuentro el almacén ${codigo} en BC.`;
  const avisos = [];
  let ok = 0;
  const candidatas = (lineasApi || []).filter((l) => l?.id && /item/i.test(String(l.lineType || "")));
  let lista = candidatas;
  if (!lista.length && pedido?.id) {
    const r = await fetchConReintento(
      `${urlApiComprasBC()}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${pedido.id}`)}&$select=id,sequence,lineType`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    if (r.ok) lista = ((await r.json()).value || []).filter((l) => /item/i.test(String(l.lineType || "")));
  }
  for (const l of lista) {
    const r = await fetchConReintento(`${urlApiComprasBC()}/purchaseOrderLines(${l.id})`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" },
      body: JSON.stringify({ locationId }),
    });
    if (r.ok) ok += 1;
    else avisos.push(`Línea ${l.sequence || l.id}: no se pudo poner el almacén (BC ${r.status})`);
  }
  if (ok > 0 && !avisos.length) return null;
  if (ok > 0) return avisos.join(" ");
  return avisos.join(" ") || `No se pudo poner el almacén ${codigo} en las líneas.`;
}
async function crearPedidoCompraConLineas(datos, lineas, meta = {}) {
  const proveedor = String(datos?.proveedor || meta.proveedorBC || "").trim();
  if (!proveedor) throw new Error("Falta el proveedor.");
  if (!lineas.length) throw new Error("No hay líneas para crear el pedido.");
  let vendorNumber = meta.vendorNumber || null;
  if (!vendorNumber) vendorNumber = await buscarNumeroProveedor(proveedor);
  if (!vendorNumber) throw new Error(`No encuentro el nº de proveedor de ${proveedor} en BC.`);
  const token = await obtenerTokenBC();
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const urlBase = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const orderDate = datos?.fecha && /^\d{4}-\d{2}-\d{2}$/.test(datos.fecha) ? datos.fecha : new Date().toISOString().slice(0, 10);
  const rCab = await fetchConReintento(`${urlBase}/purchaseOrders`, {
    method: "POST",
    headers: cabeceras,
    body: JSON.stringify({ vendorNumber, orderDate }),
  });
  if (!rCab.ok) throw new Error(`BC respondió ${rCab.status} creando el pedido: ${(await rCab.text().catch(() => "")).slice(0, 300)}`);
  const cab = await rCab.json();
  const avisos = [];
  const lineasCreadas = [];
  const lineasApi = [];
  const pedidoOrigen = String(datos?.pedidoOrigen || "").trim();
  let locationCode = String(datos?.locationCode || meta.locationCode || "").trim() || null;
  if (!locationCode && pedidoOrigen) {
    locationCode = await almacenDePedidoCompra(pedidoOrigen, token);
  }
  let locationId = locationCode ? await idAlmacenPorCodigo(locationCode, token) : null;
  for (const l of lineas) {
    const body = {
      documentId: cab.id,
      lineType: l.lineType,
      lineObjectNumber: l.codigoBC,
      quantity: Number(l.cantidad) || 1,
      description: l.descripcion || undefined,
    };
    if (l.precio != null && !Number.isNaN(Number(l.precio))) body.directUnitCost = Number(l.precio);
    if (locationId && /item/i.test(String(l.lineType || ""))) body.locationId = locationId;
    let rLinea = await fetchConReintento(`${urlBase}/purchaseOrderLines`, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify(body),
    });
    // Algunos entornos esperan "Charge (Item)" en lugar de "Charge".
    if (!rLinea.ok && l.lineType === "Charge") {
      const txt = (await rLinea.text().catch(() => "")).slice(0, 180);
      if (/InvalidOptionEnumValue|is not an option/i.test(txt)) {
        rLinea = await fetchConReintento(`${urlBase}/purchaseOrderLines`, {
          method: "POST",
          headers: cabeceras,
          body: JSON.stringify({ ...body, lineType: "Charge (Item)" }),
        });
      } else {
        avisos.push(`Línea ${l.codigoBC}: BC ${rLinea.status} ${txt}`);
        continue;
      }
    }
    if (!rLinea.ok) {
      avisos.push(`Línea ${l.codigoBC}: BC ${rLinea.status} ${(await rLinea.text().catch(() => "")).slice(0, 180)}`);
      continue;
    }
    const creada = await rLinea.json();
    lineasApi.push(creada);
    lineasCreadas.push(l.descripcion || l.codigoBC);
    if (l.ot || l.depto) {
      const avisoDim = await ponerOtEnLineaApi(creada.id, l, token);
      if (avisoDim) avisos.push(avisoDim);
    }
  }
  if (locationCode) {
    const malAlm = await ponerAlmacenEnPedidoCompra(
      { numero: cab.number, id: cab.id },
      locationCode,
      token,
      lineasApi
    );
    if (malAlm) avisos.push(malAlm);
  } else if (lineas.some((l) => /item/i.test(String(l.lineType || "")))) {
    avisos.push("No se ha podido copiar el Cód. almacén (falta en el pedido de origen). Revísalo antes de registrar.");
  }
  return {
    numero: cab.number,
    id: cab.id,
    enlace: enlacePedidoCompraBC(cab.number),
    vendorName: meta.proveedorBC || proveedor,
    lineasCreadas,
    avisos,
    locationCode: locationCode || null,
    plantilla: {
      numeroBC: meta.numeroBC || null,
      facturaProveedor: meta.facturaProveedor || null,
      fecha: meta.fecha || null,
      cuenta: lineas[0]?.codigoBC || meta.cuenta || null,
      ot: lineas[0]?.ot || otUtil(datos?.ot) || null,
      departamento: lineas[0]?.depto || meta.departamento || null,
      lineType: lineas[0]?.lineType || meta.lineType || null,
      locationCode: locationCode || null,
    },
  };
}

async function crearPedidoComoUltima(datos) {
  const proveedor = String(datos?.proveedor || "").trim();
  if (!proveedor) throw new Error("Falta el proveedor.");

  // Pedido nuevo con artículos/cargos ya elegidos en pantalla (p. ej. líneas
  // de factura que no caben en un PC lanzado). No copia la cuenta de la última factura.
  const lineasBC = lineasPedidoDesdeLineasBC(datos);
  if (lineasBC.length) {
    let meta = { proveedorBC: proveedor, vendorNumber: null, departamento: null };
    try {
      const prop = await proponerUltimaEntrada(proveedor);
      if (prop) {
        meta = {
          proveedorBC: prop.proveedorBC || proveedor,
          vendorNumber: prop.vendorNumber || null,
          departamento: prop.departamento || null,
          numeroBC: prop.numeroBC || null,
          facturaProveedor: prop.facturaProveedor || null,
          fecha: prop.fecha || null,
          cuenta: prop.cuenta || null,
          lineType: prop.lineType || null,
        };
        if (meta.departamento) {
          for (const l of lineasBC) if (!l.depto) l.depto = meta.departamento;
        }
      }
    } catch { /* basta con el nº de proveedor */ }
    return crearPedidoCompraConLineas(datos, lineasBC, meta);
  }

  const esFerros = datos?.regla === REGLA_FERROS_GRUPO.id || esProveedorFerrosGrupo(proveedor);
  const propuesta = esFerros
    ? await propuestaPedidoFerrosGrupo(datos)
    : await proponerUltimaEntrada(proveedor);
  if (!propuesta?.puedeCrear) throw new Error(propuesta?.resumen || "No hay una factura anterior de este proveedor para copiar el pedido.");
  if (esFerros && !normalizarOtFactura(datos?.ot) && !otUtil(propuesta.ot)) {
    throw new Error("Ferros Coll de l'Alba: falta la OT (en la factura suele ser AC00…/AAAA o OT …). Indícala antes de crear el pedido.");
  }
  if (typeof datos?.ot === "string") {
    const ot = esFerros ? normalizarOtFactura(datos.ot) : otUtil(datos.ot);
    propuesta.ot = ot || null;
    propuesta.lineas = (propuesta.lineas || []).map((l) => ({ ...l, ot }));
  }
  const lineas = lineasPedidoComoUltima(datos, propuesta);
  return crearPedidoCompraConLineas(datos, lineas, {
    proveedorBC: propuesta.proveedorBC,
    vendorNumber: propuesta.vendorNumber,
    numeroBC: propuesta.numeroBC,
    facturaProveedor: propuesta.facturaProveedor,
    fecha: propuesta.fecha,
    cuenta: propuesta.cuenta,
    departamento: propuesta.departamento,
    lineType: propuesta.lineType,
  });
}

function urlApiComprasBC() {
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
}

/** Extensión AlsoCasals Purchasing API: purchaseOrders + receive / receiveByNumber. */
function urlApiPurchasingBC() {
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/alsocasals/purchasing/v1.0/companies(${EMPRESA_ID()})`;
}

async function marcarCantidadARecibir(idPedido, token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" };
  const r = await fetchConReintento(`${urlApiComprasBC()}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${idPedido}`)}`, { headers });
  if (!r.ok) return;
  const lineas = ((await r.json()).value || []);
  for (const l of lineas) {
    const qty = Number(l.quantity) || 0;
    if (!(qty > 0) || Number(l.receiveQuantity) === qty) continue;
    await fetchConReintento(`${urlApiComprasBC()}/purchaseOrderLines(${l.id})`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ receiveQuantity: qty }),
    });
  }
}

async function postAccionPedido(base, pathSuffix, token, bodyObj) {
  const r = await fetchConReintento(`${base}${pathSuffix}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" },
    body: JSON.stringify(bodyObj != null ? bodyObj : {}),
  });
  const texto = r.ok ? "" : (await r.text().catch(() => "")).slice(0, 400);
  return { ok: r.ok, status: r.status, texto };
}

/** Acciones bound en API v2 o purchasing (mismo id de pedido). */
async function accionPedidoCompra(idPedido, accion, token, origen = "v2") {
  const base = origen === "purchasing" ? urlApiPurchasingBC() : urlApiComprasBC();
  const r = await postAccionPedido(base, `/purchaseOrders(${idPedido})/Microsoft.NAV.${accion}`, token, {});
  return { ...r, accion, origen };
}

function textoErrorBC(texto) {
  const t = String(texto || "").trim();
  try {
    const j = JSON.parse(t);
    const m = j?.error?.message;
    if (typeof m === "string") return m;
    if (m && typeof m === "object" && m.value) return String(m.value);
  } catch { /* el cuerpo no es JSON */ }
  return t.replace(/\s+/g, " ").slice(0, 280);
}

function mensajeSiPedidoLanzado(txt) {
  const limpio = textoErrorBC(txt);
  if (/Status must be equal to 'Open'/i.test(limpio)) {
    return `El pedido está lanzado (Released). Business Central solo deja añadir líneas o cambiar cantidad/coste si está abierto (Open). ${limpio}`;
  }
  return limpio;
}

async function accionPedidoEnCualquierApi(idPedido, accion, token) {
  const v2 = await accionPedidoCompra(idPedido, accion, token, "v2");
  if (v2.ok) return v2;
  const pur = await accionPedidoCompra(idPedido, accion, token, "purchasing");
  if (pur.ok) return pur;
  return { ok: false, status: pur.status || v2.status, texto: [v2.texto, pur.texto].filter(Boolean).join(" · ") };
}

// El pedido lanzado no admite cambiar cantidad ni coste directo. Se usa
// la misma acción bound que el registro (Microsoft.NAV.release / receive).
async function reabrirPedidoCompra(idPedido, token) {
  const re = await accionPedidoEnCualquierApi(idPedido, "reopen", token);
  if (!re.ok) {
    return {
      ok: false,
      error: `El pedido está lanzado y no se ha podido reabrir para añadir líneas o cambiar cantidad/coste (BC ${re.status}). ${mensajeSiPedidoLanzado(re.texto)}`,
    };
  }
  return { ok: true, reabierto: true };
}

async function reabrirPedidoCompraSiLanzado(idPedido, token) {
  const r = await fetchConReintento(
    `${urlApiComprasBC()}/purchaseOrders(${idPedido})?$select=id,number,status`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return { ok: true, reabierto: false };
  let estado = "";
  try { estado = String((await r.json()).status || ""); } catch { estado = ""; }
  if (!/^released$/i.test(estado)) return { ok: true, estado, reabierto: false };
  return reabrirPedidoCompra(idPedido, token);
}

async function lanzarPedidoCompra(idPedido, token) {
  const rel = await accionPedidoEnCualquierApi(idPedido, "release", token);
  if (!rel.ok && !/already|ya.*lanzad|released/i.test(String(rel.texto || ""))) {
    return {
      ok: false,
      error: `No se ha podido volver a lanzar el pedido después del cambio (BC ${rel.status}). ${textoErrorBC(rel.texto)}`,
    };
  }
  return { ok: true };
}

function esAccionAusente(status, texto) {
  return (
    status === 404 ||
    /No HTTP resource|does not support|Resource not found|BadRequest_ResourceNotFound|UnknownAction/i.test(
      String(texto || "")
    )
  );
}

/**
 * Registrar recepción por API (= «Recibir», no facturar).
 * Orden: purchasing receive → purchasing receiveByNumber (orderNo) → v2 receive.
 * No llama a receiveAndInvoice: eso contabiliza la factura de compra.
 * API: alsocasals/purchasing/v1.0 (extensión AlsoCasals Purchasing).
 */
async function registrarRecepcionPorApi(idPedido, token, numeroPedido) {
  const num = String(numeroPedido || "").trim();
  const intentos = [];

  // 1) Extensión purchasing — bound receive por id
  if (idPedido) {
    let recibo = await accionPedidoCompra(idPedido, "receive", token, "purchasing");
    intentos.push(`purchasing.receive(${recibo.status})`);
    if (recibo.ok) return { ...recibo, accion: "receive", viaApi: "purchasing" };

    if (!esAccionAusente(recibo.status, recibo.texto) && /release|liberar|lanzad|open/i.test(recibo.texto || "")) {
      const lanzar = await accionPedidoCompra(idPedido, "release", token, "purchasing");
      intentos.push(`purchasing.release(${lanzar.status})`);
      if (lanzar.ok || /already|ya.*lanzad|released/i.test(lanzar.texto || "")) {
        recibo = await accionPedidoCompra(idPedido, "receive", token, "purchasing");
        intentos.push(`purchasing.receive2(${recibo.status})`);
        if (recibo.ok) return { ...recibo, accion: "receive", viaApi: "purchasing" };
      }
    }
  }

  // 2) Extensión purchasing — receiveByNumber (campo oficial: orderNo)
  if (num) {
    const cuerpos = [{ orderNo: num }];
    for (const cuerpo of cuerpos) {
      const r = await postAccionPedido(
        urlApiPurchasingBC(),
        "/purchaseOrders/Microsoft.NAV.receiveByNumber",
        token,
        cuerpo
      );
      intentos.push(`purchasing.receiveByNumber(${Object.keys(cuerpo)[0]}:${r.status})`);
      if (r.ok) return { ...r, accion: "receiveByNumber", viaApi: "purchasing" };
      if (esAccionAusente(r.status, r.texto)) break;
      if (r.status !== 400 && r.status !== 422) break;
    }
  }

  // 3) API v2 estándar (por si Microsoft o otra capa lo expone)
  if (idPedido) {
    let recibo = await accionPedidoCompra(idPedido, "receive", token, "v2");
    intentos.push(`v2.receive(${recibo.status})`);
    if (recibo.ok) return { ...recibo, accion: "receive", viaApi: "v2" };

    if (!esAccionAusente(recibo.status, recibo.texto) && /release|liberar|lanzad|open/i.test(recibo.texto || "")) {
      const lanzar = await accionPedidoCompra(idPedido, "release", token, "v2");
      intentos.push(`v2.release(${lanzar.status})`);
      if (lanzar.ok || /already|ya.*lanzad|released/i.test(lanzar.texto || "")) {
        recibo = await accionPedidoCompra(idPedido, "receive", token, "v2");
        intentos.push(`v2.receive2(${recibo.status})`);
        if (recibo.ok) return { ...recibo, accion: "receive", viaApi: "v2" };
      }
    }
  }

  return {
    ok: false,
    status: 502,
    accion: "receive",
    texto: intentos.join(" → "),
    hint: "No se pudo recibir por API (alsocasals/purchasing receive / receiveByNumber ni v2).",
  };
}

async function registrarPedidoPorServicio(numero) {
  try {
    const r = await fetch(
      (process.env.BC_REGISTRO_URL || "http://localhost:5055").replace(/\/$/, "") + "/registrar",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ numero_pedido: numero, empresa: EMPRESA_NOMBRE() }),
      }
    );
    const datos = await r.json().catch(() => ({}));
    if (r.ok && datos.ok) return { ok: true };
    return { ok: false, error: datos.error || `El servicio de registro respondió ${r.status}.` };
  } catch (e) {
    return { ok: false, error: `No se pudo contactar con el registro del pedido (${String(e.message || e)}).` };
  }
}

// Crea el pedido y, en el mismo paso, lo registra (recibir). Si la API
// no tiene la acción de recibir, se usa el mismo registro de pantalla
// que Recepción de material.
async function registrarPedidoCompra(pedido) {
  if (!pedido?.numero && !pedido?.id) return { ok: false, error: "Falta el pedido para registrarlo." };
  const token = await obtenerTokenBC();
  let id = pedido.id;
  if (id) {
    const cabR = await fetchConReintento(`${urlApiComprasBC()}/purchaseOrders(${id})?$select=id,fullyReceived`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (cabR.ok && (await cabR.json()).fullyReceived) return { ok: true };
  } else if (pedido.numero) {
    const r = await fetchConReintento(`${urlApiComprasBC()}/purchaseOrders?$filter=${encodeURIComponent(`number eq '${String(pedido.numero).replace(/'/g, "''")}'`)}&$top=1&$select=id,fullyReceived`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const cab = ((await r.json()).value || [])[0];
      if (cab?.fullyReceived) return { ok: true };
      id = cab?.id || null;
    }
  }
  if (!id) return registrarPedidoPorServicio(pedido.numero);
  await marcarCantidadARecibir(id, token);
  const recibo = await registrarRecepcionPorApi(id, token, pedido.numero);
  if (recibo.ok) return { ok: true, via: "api", accion: recibo.accion, viaApi: recibo.viaApi };
  const fb = await registrarPedidoPorServicio(pedido.numero);
  if (fb.ok) return { ok: true, via: "playwright", avisoApi: `${recibo.accion} ${recibo.status}` };
  return {
    ok: false,
    error: `BC no registró el pedido: ${recibo.status} ${recibo.texto}${recibo.hint ? ` — ${recibo.hint}` : ""} · ${fb.error || ""}`.trim(),
  };
}

const pedidosCreandose = new Map();

function itemDeFacturaGuardada(d, { factura, msg, att }) {
  const num = String(factura || "").trim();
  if (!num) return null;
  return (d.items || []).find((it) => {
    const suya = it.extraida?.factura || it.factura;
    if (String(suya || "").trim() !== num) return false;
    if (msg && it.msg && it.msg !== msg) return false;
    if (msg && att != null && it.att != null && String(it.att) !== String(att)) return false;
    return !!it.extraida;
  }) || null;
}

async function pedidoYaAnotado(datos) {
  const d = await leerIndicePdfPendientes();
  const it = itemDeFacturaGuardada(d, datos || {});
  return it?.extraida?.pedidoCreado?.numero ? it.extraida.pedidoCreado : null;
}

async function anotarPedidoCreado(datos, pedido) {
  if (!pedido?.numero) return;
  const d = await leerIndicePdfPendientes();
  const it = itemDeFacturaGuardada(d, datos || {});
  if (!it) return;
  it.extraida = { ...it.extraida, pedidoCreado: pedido };
  await escribirIndicePdfPendientes(d);
}

async function resumenPedidoCompra(numero) {
  const pedido = normalizarNumPedido(numero) || String(numero || "").trim();
  if (!pedido) return { fecha: null, albaran: null, importe: null };
  const bc = await buscarPedidoYLineasBC(pedido);
  let fecha = null;
  let albaran = null;
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const servicio = FUENTES_WS.pedidos_compra.servicio;
    const esc = pedido.replace(/'/g, "''");
    for (const clave of [`(No='${esc}')`, `(Document_Type='Order',No='${esc}')`]) {
      const r = await fetchConReintento(`${raiz}/${encodeURIComponent(servicio)}${clave}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const reg = await r.json();
      const f = reg.Order_Date || reg.Document_Date || reg.Posting_Date;
      if (f) fecha = String(f).slice(0, 10);
      const kAlb = Object.keys(reg).find((k) => /vendor.?shipment|albar[aá]n|shipment_no/i.test(k));
      if (kAlb && String(reg[kAlb] || "").trim()) albaran = String(reg[kAlb]).trim();
      break;
    }
  } catch (_) {}
  // Preferir total del pedido en cabecera BC; si no, suma de líneas con dto.
  let importe = bc.totalAmountExcludingTax != null ? Number(bc.totalAmountExcludingTax) : null;
  if (importe == null || Number.isNaN(importe)) {
    importe = importePedidoDesdeLineasBC(bc.lineasBC);
  }
  return { fecha, albaran: albaran || null, importe };
}

// Si la factura no trae pedido, se crea uno igual que la última factura
// de ese proveedor. Una sola vez: si ya se anotó, se devuelve el mismo.
app.post("/api/facturas-compra/resumen-pedido", async (req, res) => {
  try {
    const pedido = String(req.body?.pedido || "").trim();
    if (!pedido) return res.status(400).json({ error: "Falta el nº de pedido." });
    res.json({ pedido, ...(await resumenPedidoCompra(pedido)) });
  } catch (err) {
    res.status(500).json({ error: "No se ha podido leer el pedido.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/crear-pedido", async (req, res) => {
  const datos = req.body || {};
  const firmaLineasBC = Array.isArray(datos.lineasBC) && datos.lineasBC.length
    ? datos.lineasBC.map((l) => `${l.tipo || "Item"}:${l.codigo}:${l.cantidad}:${l.coste ?? l.precio ?? ""}`).join("|")
    : "";
  const esLineasBC = !!firmaLineasBC;
  const clave = `${String(datos.proveedor || "").trim()}|${String(datos.factura || "").trim()}|${datos.msg || ""}|${datos.att || ""}${esLineasBC ? `|bc:${firmaLineasBC}` : ""}`;
  if (pedidosCreandose.has(clave)) {
    try {
      return res.json(await pedidosCreandose.get(clave));
    } catch (err) {
      return res.status(409).json({ error: err.message || "No se ha podido crear el pedido de compra." });
    }
  }
  let resolver;
  let rechazar;
  const espera = new Promise((ok, mal) => { resolver = ok; rechazar = mal; });
  pedidosCreandose.set(clave, espera);
  try {
    // Las líneas explícitas (artículo/cargo) son un pedido adicional: no
    // reutilizar el pedidoCreado de «factura sin PC».
    const ya = esLineasBC ? null : await pedidoYaAnotado(datos);
    let pedido = ya || await crearPedidoComoUltima(datos);
    if (!ya && !esLineasBC) await anotarPedidoCreado(datos, pedido);
    if (pedido.plantilla?.ot || pedido.plantilla?.departamento) {
      pedido = await aplicarOtAlPedido(pedido);
      if (!esLineasBC) await anotarPedidoCreado(datos, pedido);
    }
    if (!pedido.registro?.ok) {
      pedido = {
        ...pedido,
        registro: pedido.lineasCreadas?.length
          ? await registrarPedidoCompra(pedido)
          : { ok: false, error: "No se registra: no se creó ninguna línea del pedido." },
      };
      if (!esLineasBC) await anotarPedidoCreado(datos, pedido);
    }
    if (pedido.numero) {
      try {
        pedido = { ...pedido, ...(await resumenPedidoCompra(pedido.numero)), resumenListo: true };
        if (!esLineasBC) await anotarPedidoCreado(datos, pedido);
      } catch (_) {}
    }
    resolver(pedido);
    res.json(pedido);
  } catch (err) {
    rechazar(err);
    res.status(409).json({ error: err.message || "No se ha podido crear el pedido de compra." });
  } finally {
    pedidosCreandose.delete(clave);
  }
});

app.get("/api/facturas-compra/proveedores-gasto", async (req, res) => {
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const cabeceras = { headers: { Authorization: `Bearer ${token}` } };
    const datos = await obtenerProveedoresDeGasto(raiz, cabeceras);
    if (!datos) {
      return res.status(404).json({ error: "No se ha podido cargar el histórico de líneas de factura de compra (mismo servicio que el aviso de duplicados)." });
    }
    res.json(datos);
  } catch (err) {
    res.status(500).json({ error: "Error detectando proveedores de gasto.", detalle: String(err.message || err) });
  }
});

app.get("/api/facturas-compra/ya-entrada", async (req, res) => {
  try {
    const factura = String(req.query.factura || "").trim();
    if (!factura) return res.status(400).json({ error: "Falta el nº de factura." });
    const chequeo = await facturaYaEntradaEnBC(factura, { proveedor: String(req.query.proveedor || "").trim() });
    if (chequeo.encontrada && !(chequeo.borrador || chequeo.estado === "borrador")) {
      const msg = String(req.query.msg || "").trim();
      const att = req.query.att != null && req.query.att !== "" ? String(req.query.att) : "";
      if (msg || factura) {
        await marcarFacturaDetectadaEnBandeja({
          factura,
          msg: msg || null,
          att: att || null,
          chequeo,
        });
      }
    }
    res.json(chequeo);
  } catch (err) {
    res.status(500).json({ error: "No se ha podido comprobar si la factura ya está entrada.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/bandeja/reconciliar-bc", async (req, res) => {
  try {
    const soloFactura = String(req.body?.factura || req.query?.factura || "").trim() || null;
    // Por defecto SIN tope: regla para todas las repetidas de la bandeja.
    // limite explícito solo si el body/query lo pide (>0).
    const rawLim = req.body?.limite ?? req.query?.limite;
    const limite = rawLim === undefined || rawLim === null || rawLim === "" || rawLim === "all"
      ? null
      : Math.max(1, Math.floor(Number(rawLim)) || 0) || null;
    const out = await reconciliarFacturasYaEntradasEnBC({ soloFactura, limite });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: "No se ha podido reconciliar con BC.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/ultima-entrada", async (req, res) => {
  try {
    const proveedor = String(req.body?.proveedor || "").trim();
    if (!proveedor) return res.status(400).json({ error: "Falta el proveedor." });
    const ultimaEntrada = esProveedorFerrosGrupo(proveedor)
      ? await propuestaPedidoFerrosGrupo({ proveedor, ot: req.body?.ot, factura: req.body?.factura })
      : await proponerUltimaEntrada(proveedor);
    res.json({ ultimaEntrada });
  } catch (err) {
    res.status(500).json({ error: "No se ha podido mirar el historial de facturas de compra.", detalle: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------
// REGISTRO DE FACTURAS SUBIDAS (Maria, 2026-09-04): un histórico de todas
// las facturas de proveedor que se van subiendo por "Validación de
// facturas" — proveedor(es), nº de factura y la incidencia con la que
// se validó — para que quede constancia aunque se recargue la página o
// se cierre la sesión (hasta ahora, "sin persistencia" era justo un
// pendiente apuntado en el proyecto). Igual patrón que el resto de
// Persistencia en Postgres (app_state · clave registro_facturas_compra).
// -----------------------------------------------------------------------
const REGISTRO_FACTURAS_MAX = 2000; // recorta las más antiguas por encima de esto

async function leerRegistroFacturas() {
  const lista = await db.getDoc(claveEmpresa("registro_facturas_compra"), []);
  return Array.isArray(lista) ? lista : [];
}

async function guardarRegistroFacturas(lista) {
  await db.setDoc(claveEmpresa("registro_facturas_compra"), lista.slice(0, REGISTRO_FACTURAS_MAX));
}

// Se llama una vez por cada factura identificada al subir el PDF
// (POST /extraer) — antes de que Maria haga nada más con ella, para que
// quede constancia de TODAS las que se suben, se entren luego en BC o
// no. `incidencia` es el resumen legible de los motivos de "revisar
// antes de entrar" (o "Sin incidencias — lista para entrar" si el
// semáforo salió verde).
async function registrarFacturaValidada({ factura, fechaFactura, proveedores, pedidos, veredicto, motivos }) {
  try {
    const lista = await leerRegistroFacturas();
    lista.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fechaRegistro: new Date().toISOString(),
      factura: factura || "",
      fechaFactura: fechaFactura || null,
      proveedores: proveedores || [],
      pedidos: pedidos || [],
      veredicto: veredicto || "revisar",
      incidencia: motivos && motivos.length ? motivos.join(" · ") : "Sin incidencias — lista para entrar",
      entradaBC: null,
    });
    await guardarRegistroFacturas(lista);
  } catch (err) {
    console.warn("[facturas-compra/registro] No se pudo guardar el registro:", String(err.message || err));
  }
}

async function actualizarRegistroEntradaBC(factura, entradaBC) {
  try {
    const lista = await leerRegistroFacturas();
    const i = lista.findIndex((r) => r.factura === factura);
    if (i === -1) return;
    lista[i] = { ...lista[i], entradaBC };
    await guardarRegistroFacturas(lista);
  } catch (err) {
    console.warn("[facturas-compra/registro] No se pudo actualizar el registro:", String(err.message || err));
  }
}

app.get("/api/facturas-compra/registro", async (req, res) => {
  try {
    res.json({ registro: await leerRegistroFacturas() });
  } catch (err) {
    res.status(500).json({ error: "No se pudo leer el registro.", detalle: String(err.message || err) });
  }
});

// Foto en vez de PDF (Maria, 2026-09-04): "Subir factura (PDF)" ahora
// también acepta una foto JPG/PNG de la factura (p. ej. si el PDF
// original no se lee bien, o directamente se hace una foto en papel).
// Se detecta por los primeros bytes del archivo (no por el nombre ni
// por un campo aparte que el frontend tendría que mandar), y se
// envuelve en un PDF de una sola página con la imagen a tamaño
// completo — así el resto del pipeline (lotes a la IA, recorte por
// factura, vista previa, adjunto de email...) sigue funcionando EXACTO
// igual que con un PDF, sin duplicar ninguna lógica.
function esCabeceraImagen(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  return null;
}
async function pdfDesdeImagen(dataBuffer, tipo) {
  const pdfDoc = await PDFDocument.create();
  const img = tipo === "png" ? await pdfDoc.embedPng(dataBuffer) : await pdfDoc.embedJpg(dataBuffer);
  const { width, height } = img;
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });
  return pdfDoc;
}

const lecturasFondo = new Map();
const TIMEOUT_LECTURA_MS = 8 * 60 * 1000;

function conLecturaLimitada(trabajo) {
  const ac = new AbortController();
  let timer;
  const limitado = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("La lectura ha superado el tiempo máximo.");
      ac.abort(err);
      reject(err);
    }, TIMEOUT_LECTURA_MS);
  });
  const tarea = senalLecturaAls.run(ac.signal, () => Promise.resolve().then(trabajo));
  return Promise.race([tarea, limitado]).finally(() => clearTimeout(timer));
}

function resumenLeyendoBandeja() {
  const salida = [];
  for (const [clave, trabajo] of lecturasFondo) {
    if (trabajo?.estado !== "leyendo") continue;
    const sep = clave.indexOf("|");
    salida.push({
      msg: sep >= 0 ? clave.slice(0, sep) : clave,
      att: sep >= 0 ? clave.slice(sep + 1) : "",
      nombre: trabajo.nombre || "",
    });
  }
  return salida.slice(0, 3);
}

async function extraerFacturaHttp(req, res) {
  if (req.body?.fondo && req.body?.origen?.msg) {
    const clave = `${req.body.origen.msg}|${req.body.origen.att ?? ""}`;
    const actual = lecturasFondo.get(clave);
    if (actual?.estado === "leyendo") return res.json({ estado: "leyendo" });
    if (actual?.estado === "lista") return res.json({ estado: "lista", paginas: actual.paginas, facturas: actual.facturas });
    lecturasFondo.set(clave, { estado: "leyendo", nombre: req.body.nombre || "" });
    const cuerpo = { ...req.body, fondo: false };
    conLecturaLimitada(() => extraerFacturaHttp({ body: cuerpo }, {
      _code: 200,
      status(code) { this._code = code; return this; },
      json(obj) {
        if (lecturasFondo.get(clave)?.estado !== "leyendo") return;
        if ((this._code || 200) >= 400) lecturasFondo.set(clave, { estado: "error", error: obj.detalle || obj.error || "No se ha podido leer la factura" });
        else lecturasFondo.set(clave, { estado: "lista", paginas: obj.paginas, facturas: obj.facturas });
      },
    })).catch((err) => {
      if (lecturasFondo.get(clave)?.estado === "leyendo") {
        lecturasFondo.set(clave, { estado: "error", error: String(err.message || err) });
      }
    });
    return res.json({ estado: "leyendo" });
  }
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  try {
    const { nombre, base64, origen } = req.body || {};
    let dataBuffer = base64 ? Buffer.from(base64, "base64") : null;
    if (!dataBuffer && origen?.msg) {
      const indice = await leerIndicePdfPendientes();
      const sid = idPdfPendiente(`mail-${origen.msg}-${origen.att || ""}`);
      const guardado = indice.items.find((x) => x.id === sid);
      dataBuffer = guardado ? leerBytesPdfPendiente(guardado) : null;
      if (!dataBuffer) {
        const token = await obtenerTokenGraph();
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(M365_BUZONES.facturas)}/messages/${encodeURIComponent(origen.msg)}/attachments/${encodeURIComponent(origen.att || "")}`;
        const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return res.status(502).json({ error: "No se ha podido bajar el PDF del buzón." });
        const a = await r.json();
        if (!a.contentBytes) return res.status(404).json({ error: "El correo no trae el PDF." });
        dataBuffer = Buffer.from(a.contentBytes, "base64");
      }
    }
    if (!dataBuffer) return res.status(400).json({ error: "Falta el documento (PDF o foto)." });
    const tipoImagen = esCabeceraImagen(dataBuffer);
    // ignoreEncryption: true (Maria, 2026-09-04) — algunas facturas de
    // proveedor llegan como PDF con protección/encriptación (aunque sin
    // contraseña para abrirlas a la vista), y pdf-lib por defecto
    // rechaza cargarlas con "Input document to `PDFDocument.load` is
    // encrypted" — no es un PDF corrupto, solo protegido.
    const srcPdf = tipoImagen
      ? await pdfDesdeImagen(dataBuffer, tipoImagen)
      : await PDFDocument.load(dataBuffer, { ignoreEncryption: true });
    const totalPaginas = srcPdf.getPageCount();
    if (!totalPaginas) {
      return res.status(400).json({ error: "El PDF no tiene páginas." });
    }

    console.log(`[facturas-compra/extraer] "${nombre || "documento"}" · ${totalPaginas} páginas · pidiendo a la IA por lotes...`);

    // 1 página por lote: Saltoki y similares saturan la respuesta si se
    // agrupan. Si aún falla un lote >1 (por reintentos internos), se parte.
    const LOTE = 1;
    const detecciones = [];
    for (let inicio = 0; inicio < totalPaginas; inicio += LOTE) {
      const indices = [];
      for (let p = inicio; p < Math.min(inicio + LOTE, totalPaginas); p++) indices.push(p);
      const lotePdf = await PDFDocument.create();
      const copiadas = await lotePdf.copyPages(srcPdf, indices);
      copiadas.forEach((p) => lotePdf.addPage(p));
      const bytesLote = await lotePdf.save();

      const resultadoLote = await extraerLoteFacturaPDF(bytesLote, indices.length);
      resultadoLote.forEach((item, i) => {
        detecciones.push({ ...item, pagina: inicio + i + 1 });
      });
    }

    const grupos = agruparPorFactura(detecciones);

    let textoDocumento = "";
    try {
      const leidoDoc = await pdfParse(dataBuffer);
      textoDocumento = String(leidoDoc?.text || "").replace(/\u0000/g, " ");
    } catch { /* escaneado o protegido: la OT se pedirá a mano */ }

    // Caché de pedidos ya consultados a BC dentro de esta misma petición
    // (una factura puede repetir el mismo pedido en varias líneas).
    const cacheBC = new Map();
    async function pedidoBC(pedido) {
      if (!cacheBC.has(pedido)) cacheBC.set(pedido, await buscarPedidoYLineasBC(pedido));
      return cacheBC.get(pedido);
    }

    const facturasFinal = [];
    const aGuardarFacturas = [];
    for (const g of grupos) {
      if (esProveedorFerrosGrupo(g.proveedor)) {
        const trozos = [
          textoDocumento,
          g.factura,
          ...(g.lineas || []).map((l) => l.descripcion),
        ].filter(Boolean).join("\n");
        g.otDetectada = extraerOtDeTextoFactura(trozos) || null;
      }
      if (!g.factura || !g.paginas.length) {
        let pdfBase64 = null;
        if (g.paginas?.length) {
          const nuevo = await PDFDocument.create();
          const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
          copiadas.forEach((p) => nuevo.addPage(p));
          pdfBase64 = Buffer.from(await guardarPdfParaBc(nuevo)).toString("base64");
        }
        facturasFinal.push({
          ...g,
          pdfBase64,
          pedidosDetalle: [],
          lineasSinPedido: g.lineas || [],
          veredicto: "revisar",
          motivos: ["Sin número de factura reconocido."],
        });
        continue;
      }
      const nuevo = await PDFDocument.create();
      const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
      copiadas.forEach((p) => nuevo.addPage(p));
      const bytes = await guardarPdfParaBc(nuevo);
      const pdfBase64 = Buffer.from(bytes).toString("base64");

      // Antes de analizar pedidos o proponer cómo entrarla: si este nº de
      // factura ya está registrado en BC, se para aquí.
      const chequeoDuplicado = await facturaYaEntradaEnBC(g.factura, { proveedor: g.proveedor || "" });
      if (chequeoDuplicado.encontrada) {
        const esBorrador = !!(chequeoDuplicado.borrador || chequeoDuplicado.estado === "borrador");
        const motivosDup = [
          esBorrador
            ? `⚠ Esta factura ya tiene un borrador en BC (${chequeoDuplicado.numeroBC || "PFC…"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""}). No se crea otro.`
            : `⚠ Esta factura ya está registrada en BC: ${chequeoDuplicado.numeroBC || "?"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""}. No se analiza ni se crea borrador.`,
        ];
        facturasFinal.push({
          ...g,
          pdfBase64,
          pedidosDetalle: [],
          lineasSinPedido: [],
          veredicto: esBorrador ? "ya_borrador" : "ya_entrada",
          motivos: motivosDup,
          gastoSugerido: null,
          ultimaEntrada: null,
          yaEntrada: !esBorrador,
          yaBorrador: esBorrador,
          entradaInfo: chequeoDuplicado,
        });
        await registrarFacturaValidada({
          factura: g.factura,
          fechaFactura: g.fecha || null,
          proveedores: g.proveedor ? [g.proveedor] : [],
          pedidos: [],
          veredicto: esBorrador ? "ya_borrador" : "ya_entrada",
          motivos: motivosDup,
        });
        const { pdfBase64: _pdfDup, ...sinPdfDup } = facturasFinal[facturasFinal.length - 1];
        aGuardarFacturas.push({
          id: origen?.msg ? `fac-${origen.msg}-${origen.att || ""}` : `fac-${g.factura}`,
          empresaId: EMPRESA_ID(),
          nombre: `Factura_${g.factura}.pdf`,
          factura: g.factura,
          msg: origen?.msg || null,
          att: origen?.att || null,
          bytes: Buffer.from(pdfBase64, "base64"),
          sobrescribir: true,
          extraida: sinPdfDup,
        });
        continue;
      }

      // Agrupar las líneas de ESTA factura por el pedido al que
      // pertenecen (una factura puede tocar varios pedidos).
      const porPedido = new Map();
      const sinPedido = [];
      for (const linea of g.lineas) {
        if (!linea.pedido) { sinPedido.push(linea); continue; }
        if (!porPedido.has(linea.pedido)) porPedido.set(linea.pedido, []);
        porPedido.get(linea.pedido).push(linea);
      }

      const pedidosDetalle = [];
      const motivos = [];
      let ok = porPedido.size > 0; // sin ningún pedido detectado, no podemos dar el visto bueno
      let gastoSugerido = null;

      // Proveedor de gasto (Maria, 2026-09-04): "hay proveedores que son
      // de gasto y estos se entran sin pedido, con tipo cuenta y la
      // cuenta de gasto que le corresponda". Si NINGUNA línea de esta
      // factura trae pedido nuestro (no es un caso mixto — es que este
      // proveedor sencillamente no va con pedido), se comprueba si es un
      // proveedor YA CONOCIDO como "de gasto" mirando el histórico de
      // líneas de factura de compra en BC (mismo servicio que el aviso
      // de duplicados, cero llamadas nuevas). Si lo es, no se trata como
      // error — se sugiere la cuenta contable y el Nº de OT con los que
      // se ha entrado siempre este proveedor, para que Maria solo tenga
      // que revisarlo y crear la línea de tipo Cuenta en BC.
      if (porPedido.size === 0 && sinPedido.length && g.proveedor) {
        try {
          const token = await obtenerTokenBC();
          const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
          const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
          const cabecerasBC = { headers: { Authorization: `Bearer ${token}` } };
          const datosGasto = await obtenerProveedoresDeGasto(raiz, cabecerasBC);
          if (datosGasto) {
            const claveFactura = normalizarTextoBC(g.proveedor);
            let entrada = datosGasto.mapa[claveFactura];
            if (!entrada) {
              // Nombre no idéntico al de BC (p. ej. la IA lee "Movistar" y
              // en BC está como "Movistar-Telefónica...") — mismo criterio
              // permisivo de coincidencia por texto que ya usa el resto de
              // la pantalla para proveedores.
              const candidato = Object.entries(datosGasto.mapa).find(
                ([key]) => key && claveFactura && (key.includes(claveFactura) || claveFactura.includes(key))
              );
              if (candidato) entrada = candidato[1];
            }
            if (entrada && entrada.cuenta) {
              gastoSugerido = {
                proveedorFactura: g.proveedor,
                proveedorBC: entrada.proveedor,
                cuenta: entrada.cuenta,
                ot: entrada.ot,
                vecesVisto: entrada.vecesVisto,
                cuentasVistas: entrada.cuentasVistas,
                otsVistas: entrada.otsVistas,
              };
            }
          }
        } catch (e) {
          console.warn("[facturas-compra/gasto] Error detectando proveedor de gasto:", String(e.message || e));
        }
      }

      await Promise.all([...porPedido.keys()].map((pedido) => pedidoBC(pedido)));

      for (const [pedido, lineasDePedido] of porPedido) {
        const bc = await pedidoBC(pedido);
        if (bc.error) {
          ok = false;
          motivos.push(`Pedido ${pedido}: ${bc.error}`);
          // Bug (Maria, 2026-09-04): aquí se descartaban las líneas
          // REALES de la factura (descripción/cantidad/precio, ya
          // leídas del PDF) solo porque el pedido no se encontró en BC
          // — así que si luego se corregía con "Elegir pedido
          // manualmente", no quedaba ninguna línea que mandar a
          // "Entrar en BC" (error "Falta 'lineasFactura'"). Se
          // conservan aquí, sin match de BC todavía (se resuelve al
          // elegir el pedido correcto o al pulsar "Actualizar desde BC").
          pedidosDetalle.push({
            pedido,
            vendorName: null,
            bcError: bc.error,
            lineas: (lineasDePedido || []).map((lf) => ({
              descripcionFactura: lf.descripcion,
              cantidadFacturada: lf.cantidad,
              precioFacturado: lf.precioUnitario,
              lineaBC: null,
              coincidencia: "sin_match",
              pendienteRecepcion: false,
              diferenciaPrecio: false,
            })),
            enlaceBC: enlacePedidoCompraBC(pedido),
          });
          continue;
        }
        const lineasEmparejadas = emparejarLineasFactura(lineasDePedido, bc.lineasBC);
        if (g.proveedor && bc.vendorName && !proveedoresParecidos(g.proveedor, bc.vendorName)) {
          ok = false;
          motivos.push(`Pedido ${pedido} es de ${bc.vendorName}, y la factura es de ${g.proveedor}. No se relaciona.`);
          pedidosDetalle.push({
            pedido: null,
            pedidoDescartado: pedido,
            vendorName: g.proveedor,
            bcError: `El pedido ${pedido} es de ${bc.vendorName}, no de ${g.proveedor}. Elige un pedido de ${g.proveedor}.`,
            lineas: (lineasDePedido || []).map((lf) => ({
              descripcionFactura: lf.descripcion,
              cantidadFacturada: lf.cantidad,
              precioFacturado: lf.precioUnitario,
              lineaBC: null,
              coincidencia: "sin_match",
              pendienteRecepcion: false,
              diferenciaPrecio: false,
            })),
            enlaceBC: null,
          });
          continue;
        }
        // TODAS las líneas del pedido en BC (no solo la emparejada), para
        // poder elegir a mano en pantalla cuando el emparejamiento
        // automático no encuentra nada o se equivoca — igual que ya hace
        // Recepción de material con "lineasDisponiblesBC".
        const lineasDisponiblesBC = lineasDisponiblesDesdeBC(bc.lineasBC);
        const importePedido = bc.totalAmountExcludingTax != null
          ? Number(bc.totalAmountExcludingTax)
          : importePedidoDesdeLineasBC(bc.lineasBC);
        pedidosDetalle.push({
          pedido,
          vendorName: bc.vendorName || null,
          bcError: null,
          lineas: lineasEmparejadas,
          lineasDisponiblesBC,
          importe: importePedido,
          enlaceBC: enlacePedidoCompraBC(pedido),
        });

        for (const l of lineasEmparejadas) {
          if (l.coincidencia === "sin_match") {
            ok = false;
            motivos.push(`Pedido ${pedido}: no encuentro en BC la línea "${l.descripcionFactura}" — revísala a mano.`);
            continue;
          }
          if (l.pendienteRecepcion) {
            ok = false;
            motivos.push(
              `Pedido ${pedido}: "${l.lineaBC.descripcion || l.descripcionFactura}" — facturado ${l.cantidadFacturada}, recibido en BC solo ${l.lineaBC.cantidadRecibida}. Falta recibir/registrar antes de entrar la factura.`
            );
          }
          if (l.diferenciaPrecio) {
            ok = false;
            motivos.push(
              `Pedido ${pedido}: "${l.lineaBC.descripcion || l.descripcionFactura}" — precio facturado ${l.precioFacturado} € vs precio en BC ${l.lineaBC.precioBC} €.`
            );
          }
        }
      }

      if (sinPedido.length) {
        ok = false;
        if (gastoSugerido) {
          motivos.push(
            `Proveedor de gasto (sin pedido) — sugerido: cuenta ${gastoSugerido.cuenta}${gastoSugerido.ot ? " · OT " + gastoSugerido.ot : ""} (visto en ${gastoSugerido.vecesVisto} línea(s) anteriores de este proveedor en BC). Revisa y crea la línea de tipo Cuenta al registrarla.`
          );
        } else {
          sinPedido.forEach((l) => motivos.push(`No he podido identificar a qué pedido nuestro corresponde la línea "${l.descripcion}" — revísala a mano.`));
        }
      }

      // Chips / propuestas = orden de lectura del PDF (bloques Su referencia /
      // Pedido), no el orden en que la IA agrupó las líneas ni el de BC.
      const pedidosDetalleOrden = ordenarPedidosDetallePorTexto(pedidosDetalle, textoDocumento);
      pedidosDetalle.length = 0;
      pedidosDetalle.push(...pedidosDetalleOrden);

      const hayPedidoUtil = pedidosDetalle.some((p) => p.pedido && !p.bcError);
      let ultimaEntrada = null;
      // Ferros Coll de l'Alba: siempre pedido nuevo con cuenta 60700004
      // (trabajos entre empresas del grupo), no se copia la última ni se
      // trata como proveedor de gasto genérico.
      if (!hayPedidoUtil && esProveedorFerrosGrupo(g.proveedor)) {
        try {
          ultimaEntrada = await propuestaPedidoFerrosGrupo({
            proveedor: g.proveedor,
            ot: g.otDetectada,
            factura: g.factura,
            baseImponible: g.baseImponible,
          });
          gastoSugerido = null;
        } catch (e) {
          console.warn("[facturas-compra/ferros] Error preparando la regla Ferros:", String(e.message || e));
        }
        if (ultimaEntrada?.resumen) motivos.push(ultimaEntrada.resumen);
      } else if (!hayPedidoUtil && g.proveedor) {
        try {
          ultimaEntrada = await proponerUltimaEntrada(g.proveedor);
        } catch (e) {
          console.warn("[facturas-compra/ultima] Error buscando la última entrada:", String(e.message || e));
        }
        if (ultimaEntrada?.resumen) motivos.push(ultimaEntrada.resumen);
      }

      // "gasto" (Maria, 2026-09-04): ni verde (no hay línea creada
      // todavía, hace falta que Maria la registre) ni rojo (no es un
      // error a corregir — es el funcionamiento normal de este
      // proveedor). Si la factura ya estaba entrada, no se llega aquí.
      const soloMotivoEsGasto = gastoSugerido && motivos.length === 1;
      const veredicto = soloMotivoEsGasto ? "gasto" : ok ? "ok" : "revisar";

      facturasFinal.push({
        ...g,
        pdfBase64,
        pedidosDetalle,
        // Líneas sin ningún pedido reconocido por la IA (Maria,
        // 2026-09-04): a diferencia de un pedido "no encontrado en BC"
        // (que sí tiene número y aparece en pedidosDetalle con
        // bcError), estas líneas nunca tenían ningún sitio donde
        // aparecer un botón de "Elegir pedido manualmente" — se quedaba
        // solo el aviso de texto, sin forma de asociarlas. Se exponen
        // aquí en el mismo formato que una línea normal para que el
        // frontend pueda ofrecer el mismo mecanismo de selección manual
        // que ya existe para pedidos no encontrados.
        lineasSinPedido: sinPedido.map((lf) => ({
          descripcionFactura: lf.descripcion,
          cantidadFacturada: lf.cantidad,
          precioFacturado: lf.precioUnitario,
        })),
        veredicto,
        motivos,
        gastoSugerido,
        ultimaEntrada,
        otDetectada: g.otDetectada || null,
        yaEntrada: chequeoDuplicado.encontrada,
        entradaInfo: chequeoDuplicado.encontrada ? chequeoDuplicado : null,
      });

      // Registro (Maria, 2026-09-04): deja constancia de toda factura
      // identificada que se sube, se entre luego en BC o no.
      if (g.factura) {
        await registrarFacturaValidada({
          factura: g.factura,
          fechaFactura: g.fecha || null,
          proveedores: [...new Set(pedidosDetalle.map((p) => p.vendorName).filter(Boolean))],
          pedidos: pedidosDetalle.map((p) => p.pedido).filter(Boolean),
          veredicto,
          motivos,
        });
        const { pdfBase64: _pdf, ...sinPdf } = facturasFinal[facturasFinal.length - 1];
        aGuardarFacturas.push({
          id: origen?.msg ? `fac-${origen.msg}-${origen.att || ""}` : `fac-${g.factura}`,
          empresaId: EMPRESA_ID(),
          nombre: `Factura_${g.factura}.pdf`,
          factura: g.factura,
          msg: origen?.msg || null,
          att: origen?.att || null,
          bytes: Buffer.from(pdfBase64, "base64"),
          sobrescribir: true,
          extraida: sinPdf,
        });
      }
    }
    if (aGuardarFacturas.length) {
      try {
        await guardarPdfsPendientes(aGuardarFacturas);
        if (origen?.msg && origen?.att) {
          await guardarPdfsPendientes([{
            id: `mail-${origen.msg}-${origen.att}`,
            facturas: aGuardarFacturas.map((f) => f.factura),
          }]);
        }
      } catch (e) {
        console.warn("[facturas-pdf] No se pudo guardar el PDF de la factura validada:", String(e.message || e));
      }
    }

    const identificadas = facturasFinal.filter((f) => f.factura).length;
    const paraEntrar = facturasFinal.filter((f) => f.veredicto === "ok").length;
    console.log(`[facturas-compra/extraer] ${identificadas} factura(s) identificada(s) de ${totalPaginas} páginas · ${paraEntrar} lista(s) para entrar`);
    const conNumero = facturasFinal.filter((f) => f.factura);
    if (origen?.msg && origen?.att != null && conNumero.length && conNumero.every((f) => f.yaEntrada)) {
      try {
        for (const f of conNumero) {
          await marcarFacturaDetectadaEnBandeja({
            factura: f.factura,
            msg: origen.msg,
            att: origen.att,
            chequeo: f.entradaInfo || { encontrada: true, estado: "registrada", numeroBC: null },
          });
        }
      } catch (e) { console.warn("[facturas-pdf] No se pudo marcar el correo como entrada:", String(e.message || e)); }
    }
    res.json({ paginas: totalPaginas, facturas: facturasFinal });
  } catch (err) {
    console.error("Error /api/facturas-compra/extraer:", err);
    res.status(500).json({ error: "Error extrayendo/validando las facturas del documento.", detalle: String(err.message || err) });
  }
}

app.post("/api/facturas-compra/extraer", extraerFacturaHttp);

app.get("/api/facturas-compra/lectura", (req, res) => {
  const clave = `${req.query.msg || ""}|${req.query.att ?? ""}`;
  const trabajo = lecturasFondo.get(clave);
  if (!trabajo) return res.json({ estado: "ninguna" });
  res.json({ estado: trabajo.estado, paginas: trabajo.paginas, facturas: trabajo.facturas, error: trabajo.error });
});

app.get("/api/facturas-compra/bandeja/leyendo", (req, res) => {
  res.json({ leyendo: resumenLeyendoBandeja() });
});

// Botón "Actualizar desde BC" en una tarjeta de factura, por pedido: sin
// volver a subir el PDF, vuelve a consultar en vivo ese pedido (líneas,
// cantidades recibidas, precios) y devuelve las líneas disponibles ya
// actualizadas — por ejemplo cuando el pedido se acaba de recibir en BC
// después de haber subido la factura, o cuando la línea que faltaba
// (como un cargo de transporte) no salía por un filtro que ya se ha
// corregido en el backend.
app.post("/api/facturas-compra/refrescar-pedido", async (req, res) => {
  const { pedido } = req.body || {};
  if (!pedido) return res.status(400).json({ error: "Falta el nº de pedido." });
  const bc = await buscarPedidoYLineasBC(pedido);
  if (bc.error) {
    return res.json({
      pedido,
      bcError: bc.error,
      vendorName: null,
      lineasDisponiblesBC: [],
      albaranes: [],
      importe: null,
      enlaceBC: enlacePedidoCompraBC(pedido),
    });
  }
  const lineasDisponiblesBC = lineasDisponiblesDesdeBC(bc.lineasBC);
  // Qty del albarán + precio/% dto/importe del PC (los receipt lines casi nunca traen precio útil).
  const albaranes = await albaranesConLineasDePedido(pedido, lineasDisponiblesBC);
  const importe = bc.totalAmountExcludingTax != null
    ? Number(bc.totalAmountExcludingTax)
    : importePedidoDesdeLineasBC(bc.lineasBC);
  res.json({
    pedido,
    bcError: null,
    vendorName: bc.vendorName || null,
    lineasDisponiblesBC,
    albaranes,
    importe,
    enlaceBC: enlacePedidoCompraBC(pedido),
  });
});

// Albaranes de compra ya registrados de un pedido. "Traer albaranes de
// compra" en BC solo enseña estos. Si no hay ninguno, el pedido sigue
// abierto y la factura no se puede registrar.
async function albaranesCompraDePedido(pedido) {
  const numero = String(pedido || "").trim();
  const vacio = { pedido: numero, encontrado: false, albaranes: [], departamento: "", ot: "", vendorNumber: "", vendorName: "", fullyReceived: false, status: "" };
  if (!numero) return vacio;
  const token = await obtenerTokenBC();
  const cabeceras = { Authorization: `Bearer ${token}` };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  const esc = numero.replace(/'/g, "''");
  const rPo = await fetchConReintento(`${base}/purchaseOrders?$filter=${encodeURIComponent(`number eq '${esc}'`)}`, { headers: cabeceras });
  if (!rPo.ok) return { ...vacio, error: `BC respondió ${rPo.status} buscando el pedido.` };
  const cab = ((await rPo.json()).value || [])[0];
  if (!cab) return { ...vacio, error: `Pedido ${numero} no encontrado.` };
  const rRec = await fetchConReintento(`${base}/purchaseReceipts?$filter=${encodeURIComponent(`orderNumber eq '${esc}'`)}&$select=number,postingDate,orderNumber`, { headers: cabeceras });
  const albaranes = rRec.ok ? ((await rRec.json()).value || []).map((a) => ({ numero: a.number, fecha: a.postingDate || "" })) : [];
  return {
    pedido: cab.number || numero,
    encontrado: true,
    status: cab.status || "",
    fullyReceived: !!cab.fullyReceived,
    vendorNumber: cab.vendorNumber || "",
    vendorName: cab.vendorName || "",
    departamento: cab.shortcutDimension1Code || "",
    ot: cab.shortcutDimension2Code || "",
    albaranes,
  };
}

function fechaIsoFactura(fechaFactura) {
  const s = String(fechaFactura || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return new Date().toISOString().slice(0, 10);
}

function facturaCompraEnBorrador(status) {
  return /draft|in review|borrador/i.test(String(status || ""));
}

// Abierto en BC (Open) es el borrador sin registrar. Paid / Canceled no se tocan.
function facturaCompraAbiertaParaLineas(status) {
  const s = String(status || "").trim();
  if (!s) return true;
  return /^(draft|open|in review)$/i.test(s) || /borrador|abierto|en revisi[oó]n/i.test(s);
}

// La fila en blanco de tipo Item que BC deja en la rejilla no cuenta.
function lineaFacturaCompraReal(l) {
  if (!l) return false;
  if (String(l.lineObjectNumber || "").trim()) return true;
  if (Math.abs(Number(l.quantity) || 0) > 0.0001) return true;
  if (String(l.description || "").trim() && !/^item$/i.test(String(l.lineType || "").trim())) return true;
  return false;
}

async function lineasDeFacturaCompra(idFactura, token) {
  if (!idFactura) return null;
  const r = await fetchConReintento(
    `${urlApiComprasBC()}/purchaseInvoiceLines?$filter=${encodeURIComponent(`documentId eq ${idFactura}`)}&$select=id,lineType,lineObjectNumber,description,quantity,unitCost`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return null;
  return (await r.json()).value || [];
}

// El PDF del proveedor se manda como bytes. BC no abre un PDF si el
// contenido va en base64 dentro del JSON.
async function adjuntarPdfFacturaCompra({ urlBase, token, invoiceId, bytes, nombreArchivo }) {
  if (!invoiceId) return { ok: false, error: "No hay factura a la que adjuntar el PDF." };
  if (!bytes || bytes.slice(0, 5).toString() !== "%PDF-") {
    return { ok: false, error: "El archivo no es un PDF y BC no puede mostrarlo." };
  }
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const nombrePdf = String(nombreArchivo || "factura.pdf").replace(/[\\/]/g, "_");
  const fileName = nombrePdf.toLowerCase().endsWith(".pdf") ? nombrePdf : `${nombrePdf}.pdf`;
  const urlColeccion = `${urlBase}/attachments`;
  const intentos = [];
  try {
    const rCrearB = await fetchConReintento(urlColeccion, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({
        fileName,
        parentType: "Purchase Invoice",
        parentId: invoiceId,
      }),
    });
    if (rCrearB.ok) {
      const creadoB = await rCrearB.json();
      const etagB = creadoB["@odata.etag"] || "*";
      const rContenidoB = await fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
        method: "PATCH",
        headers: { ...cabeceras, "Content-Type": "application/pdf", "If-Match": etagB },
        body: bytes,
      });
      if (rContenidoB.ok) {
        const rLeer = await fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
          headers: { Authorization: cabeceras.Authorization },
        });
        const guardado = rLeer.ok ? Buffer.from(await rLeer.arrayBuffer()) : Buffer.alloc(0);
        if (guardado.slice(0, 5).toString() === "%PDF-") return { ok: true };
        intentos.push(`BC guardó ${guardado.length} bytes que no son un PDF`);
      } else intentos.push(`contenido → ${rContenidoB.status}: ${(await rContenidoB.text().catch(() => "")).slice(0, 200)}`);
    } else {
      intentos.push(`crear → ${rCrearB.status}: ${(await rCrearB.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (e) {
    intentos.push(String(e.message || e));
  }
  return { ok: false, error: intentos.join(" · ") || "No se pudo adjuntar el PDF." };
}

async function bytesPdfParaFactura({ msg, att, pdfBase64 }) {
  let bytes = null;
  if (msg) bytes = await bytesPdfDeCorreo(msg, att);
  if ((!bytes || !bytes.length) && pdfBase64) {
    try { bytes = Buffer.from(pdfBase64, "base64"); } catch { bytes = null; }
  }
  return bytes && bytes.length ? bytes : null;
}

async function idPedidoCompra(numero, token) {
  const esc = String(numero).replace(/'/g, "''");
  const r = await fetchConReintento(
    `${urlApiComprasBC()}/purchaseOrders?$filter=${encodeURIComponent(`number eq '${esc}'`)}&$top=1&$select=id,number,status`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return null;
  return ((await r.json()).value || [])[0]?.id || null;
}

async function lineasPedidoParaFacturar(idPedido, token) {
  const r = await fetchConReintento(
    `${urlApiComprasBC()}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${idPedido}`)}&$select=id,quantity,receivedQuantity,invoicedQuantity,receiveQuantity,invoiceQuantity`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  if (!r.ok) return [];
  return (await r.json()).value || [];
}

function quedaCantidadPorFacturar(lineas) {
  return (lineas || []).some((l) => {
    const qty = Number(l.quantity) || 0;
    return qty > 0 && qty - (Number(l.invoicedQuantity) || 0) > 0.0001;
  });
}

async function buscarFacturaCompraRegistrada(factura, pedido, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const select = "id,number,status,vendorInvoiceNumber,orderNumber,invoiceDate,postingDate,lastModifiedDateTime";
  const fac = String(factura || "").trim();
  const ped = String(pedido || "").trim();
  const filtros = [];
  if (fac) filtros.push(`vendorInvoiceNumber eq '${fac.replace(/'/g, "''")}'`);
  if (ped) filtros.push(`orderNumber eq '${ped.replace(/'/g, "''")}'`);
  let candidatas = [];
  for (const filtro of filtros) {
    const r = await fetchConReintento(
      `${urlApiComprasBC()}/purchaseInvoices?$filter=${encodeURIComponent(filtro)}&$top=8&$select=${select}`,
      { headers }
    );
    if (!r.ok) continue;
    candidatas = candidatas.concat((await r.json()).value || []);
  }
  const vistas = new Set();
  candidatas = candidatas.filter((f) => {
    if (!f?.id || vistas.has(f.id)) return false;
    vistas.add(f.id);
    return true;
  });
  const misma = candidatas.find((f) => String(f.vendorInvoiceNumber || "").trim().toUpperCase() === fac.toUpperCase());
  if (misma) return misma;
  const delPedido = candidatas
    .filter((f) => String(f.orderNumber || "").trim().toUpperCase() === ped.toUpperCase())
    .sort((a, b) => String(b.lastModifiedDateTime || "").localeCompare(String(a.lastModifiedDateTime || "")));
  return delPedido[0] || null;
}

function pedidoPendienteDeRecibir(lineas) {
  const conQty = (lineas || []).filter((l) => (Number(l.quantity) || 0) > 0.0001);
  if (!conQty.length) return true;
  return conQty.some((l) => (Number(l.quantity) || 0) - (Number(l.receivedQuantity) || 0) > 0.0001);
}

function comandoTraerAlbaranes(factura, pedido) {
  return `python bc_automation/traer_albaranes_compra.py ${factura} ${pedido}`;
}

function formatearTotalEs(total) {
  const n = Number(total);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function avisoTraerAlbaranesOk({ numero, factura, pedidos, traidos }) {
  const albaranes = [...new Set(traidos.flatMap((t) => t.albaranes || []))];
  const total = traidos.map((t) => t.total).find((v) => v != null && Number.isFinite(Number(v)));
  const totalTxt = total != null ? ` · total ≈ ${formatearTotalEs(total)}` : "";
  const albTxt = albaranes.length ? albaranes.join(", ") : "los albaranes";
  return (
    `Borrador ${numero || "sin nº"} listo: ${albTxt} del pedido ${(pedidos || []).join(", ")}` +
    `${totalTxt} (factura proveedor ${factura}). Queda Open — no se ha registrado.`
  );
}

function jsonUltimaLinea(texto) {
  const lineas = String(texto || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lineas.length - 1; i >= 0; i--) {
    if (!lineas[i].startsWith("{")) continue;
    try { return JSON.parse(lineas[i]); } catch { /* la línea no es el resultado */ }
  }
  return null;
}

// El perfil de Edge está en el PC. Desde Docker se llama al servicio
// de bc_automation (puerto 5055). Si no responde, se lanza el script
// cuando el archivo está en este equipo.
async function lanzarScriptTraerAlbaranes(factura, pedido, albaranes = []) {
  const script = path.join(__dirname, "..", "bc_automation", "traer_albaranes_compra.py");
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      factura,
      pedido,
      error: `El borrador está en BC. Para traer los albaranes, en este PC: ${comandoTraerAlbaranes(factura, pedido)}`,
    };
  }
  const { spawn } = require("child_process");
  const candidatos = [process.env.PYTHON_CMD, "py", "python", "python3"].filter(Boolean);
  const args = [script, factura, pedido];
  const alb = (Array.isArray(albaranes) ? albaranes : []).map((a) => String(a || "").trim()).filter(Boolean);
  if (alb.length) args.push(`--albaranes=${alb.join(",")}`);
  let ultimo = "";
  for (const cmd of candidatos) {
    const r = await new Promise((resolve) => {
      let out = "";
      let err = "";
      let proc;
      try {
        proc = spawn(cmd, args, { windowsHide: false, cwd: path.join(__dirname, "..") });
      } catch (e) {
        return resolve({ code: -1, err: String(e), out: "" });
      }
      proc.stdout.on("data", (b) => { out += b; });
      proc.stderr.on("data", (b) => { err += b; });
      proc.on("error", (e) => resolve({ code: -1, err: String(e), out }));
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ya cerrado */ }
        resolve({ code: -1, err: "tiempo agotado", out });
      }, 90000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
    const json = jsonUltimaLinea(r.out);
    if (json?.ok) return { ...json, via: "script" };
    ultimo = json?.error || `${cmd}: ${(r.err || r.out || "").slice(-300)}`;
    if (json || !/ENOENT|not found|no se reconoce/i.test(String(r.err || ""))) break;
  }
  return {
    ok: false,
    factura,
    pedido,
    error: ultimo || "No se han traído los albaranes. Arranca python bc_automation/servicio_registro.py y pulsa otra vez.",
  };
}

async function traerAlbaranesCompraUi(numeroFactura, numeroPedido, albaranesElegidos = null) {
  const factura = String(numeroFactura || "").trim();
  const pedido = String(numeroPedido || "").trim();
  const albaranes = [...new Set((Array.isArray(albaranesElegidos) ? albaranesElegidos : [])
    .map((a) => String(a || "").trim().toUpperCase())
    .filter(Boolean))];
  if (!factura || !pedido) return { ok: false, error: "Faltan el nº de factura de BC o el pedido." };
  const base = (process.env.BC_REGISTRO_URL || "http://localhost:5055").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/traer-albaranes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        numero_factura: factura,
        numero_pedido: pedido,
        ...(albaranes.length ? { albaranes } : {}),
      }),
    });
    const datos = await r.json().catch(() => ({}));
    if (datos?.ok) return { ...datos, via: datos.via || "servicio" };
    if (r.status === 404) {
      return {
        ok: false,
        factura,
        pedido,
        error: "Hay que arrancar el servicio de Business Central (python bc_automation/servicio_registro.py) y pulsar otra vez. No hace falta lanzar el script a mano.",
      };
    }
    if (r.status) {
      return { ok: false, factura, pedido, via: "servicio", error: datos.error || `El servicio de Business Central respondió ${r.status}.` };
    }
  } catch {
    // El servicio no está arrancado: el script abre Edge en este equipo (misma ruta rápida).
  }
  return lanzarScriptTraerAlbaranes(factura, pedido, albaranes);
}

// Borrador de factura de compra: solo cabecera (vendorNumber,
// vendorInvoiceNumber, invoiceDate). Las líneas salen de
// Líneas > Línea > Acciones > Traer albaranes de compra, en la pantalla
// de BC. No se llama a purchaseInvoiceLines, ni a Microsoft.NAV.post,
// ni a receiveAndInvoice. No se envían paymentTermsId ni orderNumber.
// Si ya hay un borrador abierto de esa factura de proveedor, no se crea
// otro: se le traen los albaranes.
app.post("/api/facturas-compra/registrar", async (req, res) => {
  const { factura, fechaFactura, pedidos, msg, att, pdfBase64, nombreArchivo, seleccionPorPedido } = req.body || {};
  const nums = [...new Set((Array.isArray(pedidos) ? pedidos : []).map((p) => String(p || "").trim()).filter(Boolean))];
  if (!factura) return res.status(400).json({ error: "Falta el nº de factura." });
  if (!nums.length) return res.status(400).json({ error: "Falta el pedido incluido en la factura." });
  const selecciones = seleccionPorPedido && typeof seleccionPorPedido === "object" ? seleccionPorPedido : {};
  try {
    const invoiceDate = fechaIsoFactura(fechaFactura);
    const token = await obtenerTokenBC();
    const urlBase = urlApiComprasBC();
    const mismaFactura = (f) => String(f?.vendorInvoiceNumber || "").trim().toUpperCase() === String(factura).trim().toUpperCase();
    const avisoYaExiste = (numero) => `La factura ya está en BC (${numero || "sin nº"}). No se ha creado otra.`;
    const yaEnApi = await buscarFacturaCompraRegistrada(factura, "", token);
    let reutilizar = null;
    if (yaEnApi?.id && mismaFactura(yaEnApi)) {
      if (!facturaCompraAbiertaParaLineas(yaEnApi.status)) {
        return res.json({ ok: true, yaExistia: true, numero: yaEnApi.number, aviso: avisoYaExiste(yaEnApi.number) });
      }
      const lineasYa = await lineasDeFacturaCompra(yaEnApi.id, token);
      if (lineasYa == null) {
        return res.status(409).json({
          error: `La factura ${yaEnApi.number || factura} ya está en BC y no he podido leer sus líneas. No se ha creado otra.`,
        });
      }
      // Aunque el borrador ya tenga líneas copiadas, se reutiliza: el
      // script quita las que no tienen Nº albarán y trae los albaranes.
      reutilizar = yaEnApi;
    } else {
      const ya = await facturaYaEntradaEnBC(factura);
      if (ya.encontrada) {
        return res.json({ ok: true, yaExistia: true, numero: ya.numeroBC, aviso: avisoYaExiste(ya.numeroBC) });
      }
    }
    let pdfBytes = null;
    try { pdfBytes = await bytesPdfParaFactura({ msg, att, pdfBase64 }); }
    catch (e) { console.warn("[facturas-compra/registrar] PDF:", String(e.message || e)); }

    const listos = [];
    for (const pedido of nums) {
      const idPedido = await idPedidoCompra(pedido, token);
      if (!idPedido) return res.status(409).json({ error: `Pedido ${pedido} no encontrado en BC. No se ha creado un borrador.` });
      const lineas = await lineasPedidoParaFacturar(idPedido, token);
      if (lineas.length && !quedaCantidadPorFacturar(lineas)) {
        const previa = await buscarFacturaCompraRegistrada(factura, pedido, token);
        if (previa?.number && String(previa.vendorInvoiceNumber || "").trim().toUpperCase() === String(factura).trim().toUpperCase()) {
          return res.json({
            ok: true,
            yaExistia: true,
            numero: previa.number,
            aviso: `La factura ya está en BC (${previa.number}). No se ha creado otra.`,
          });
        }
        if (previa?.number) {
          return res.status(409).json({ error: `El pedido ${pedido} ya está facturado en BC (${previa.number}). No se ha creado otra factura.` });
        }
        return res.status(409).json({ error: `El pedido ${pedido} no tiene cantidad pendiente de facturar. No se ha creado un borrador.` });
      }
      // Con albaranes ya elegidos se crea el borrador igual (traer esos ALBC).
      // Solo se bloquea si el pedido sigue sin recibir y no hay albarán marcado.
      const selPedido = selecciones[pedido] || selecciones[String(pedido || "").trim()] || {};
      const albaranesSel = Array.isArray(selPedido.albaranes)
        ? selPedido.albaranes.map((a) => String(a || "").trim()).filter(Boolean)
        : [];
      const lineasSelConAlbaran = Array.isArray(selPedido.lineas)
        && selPedido.lineas.some((l) => String(l?.albaran || "").trim());
      const hayAlbaranesElegidos = albaranesSel.length > 0 || lineasSelConAlbaran;
      if (pedidoPendienteDeRecibir(lineas) && !hayAlbaranesElegidos) {
        return res.status(409).json({
          error: `El pedido ${pedido} todavía no está recibido. Pulsa Registrar: solo recibe el pedido de compra. No se ha creado una factura.`,
        });
      }
      const bc = await buscarPedidoYLineasBC(pedido);
      if (!bc.vendorNumber) {
        return res.status(409).json({ error: `Pedido ${pedido}: no he podido leer el proveedor del pedido en BC. No se ha creado un borrador.` });
      }
      listos.push({ pedido, vendorNumber: bc.vendorNumber, lineas: bc.lineasBC || [] });
    }

    const proveedores = [...new Set(listos.map((x) => x.vendorNumber))];
    if (proveedores.length !== 1) {
      return res.status(409).json({
        error: "Los pedidos son de proveedores distintos. Una factura de compra lleva un solo proveedor. No se ha creado un borrador.",
      });
    }

    const vendorNumber = proveedores[0];
    let inv;
    let numero;
    if (reutilizar?.id) {
      inv = { id: reutilizar.id, number: reutilizar.number || null };
      numero = inv.number;
      console.log(`[facturas-compra/registrar] reutilizo borrador ${numero || "sin nº"} de ${factura}: no creo otra factura`);
    } else {
      const cuerpo = {
        vendorNumber,
        vendorInvoiceNumber: String(factura).slice(0, 35),
        invoiceDate,
      };
      const rCab = await fetchConReintento(`${urlBase}/purchaseInvoices`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      if (!rCab.ok) {
        const bc = textoErrorBC((await rCab.text().catch(() => "")).slice(0, 500)) || `BC respondió ${rCab.status}.`;
        return res.status(409).json({ error: `No se ha podido crear el borrador: ${bc}` });
      }
      inv = await rCab.json();
      numero = inv?.number || null;
      console.log(`[facturas-compra/registrar] borrador ${factura} → ${numero || "sin nº"} vendor ${vendorNumber} fecha ${invoiceDate}`);
    }

    const avisos = [];
    const traer = [];
    // Todos los ALBC de la factura (varios pedidos) en UNA sola pasada:
    // filtro BC «ALBC1|ALBC2». Si se hacía pedido a pedido, el 2.º borraba el 1.º.
    const todosAlbaranes = [];
    let algunModoAlbaran = false;
    for (const item of listos) {
      const sel = selecciones[item.pedido]
        || selecciones[String(item.pedido).toUpperCase()]
        || Object.entries(selecciones).find(([k]) => String(k).toUpperCase().replace(/\s+/g, "") === String(item.pedido).toUpperCase().replace(/\s+/g, ""))?.[1]
        || null;
      const albaranesSel = Array.isArray(sel?.albaranes)
        ? [...new Set(sel.albaranes.map((a) => String(a || "").trim().toUpperCase()).filter(Boolean))]
        : [];
      const modoSel = String(sel?.modo || "").toLowerCase();
      if (modoSel === "albaran") {
        algunModoAlbaran = true;
        if (!albaranesSel.length) {
          return res.status(409).json({
            error: `El pedido ${item.pedido} tiene varios albaranes: indica cuál(es) incluir. No se han traído todos para no mezclar facturas.`,
          });
        }
      }
      for (const a of albaranesSel) {
        if (!todosAlbaranes.includes(a)) todosAlbaranes.push(a);
      }
    }
    const pedidoRef = listos.map((x) => x.pedido).join(",");
    const filtroAlb = todosAlbaranes.length ? todosAlbaranes : (algunModoAlbaran ? [] : null);
    console.log(
      `[facturas-compra/registrar] traer ${pedidoRef}`
      + (filtroAlb?.length ? ` · ALBC ${filtroAlb.join("|")}` : " · todos los albaranes del/los pedido(s)")
    );
    const resultado = await traerAlbaranesCompraUi(numero, listos[0].pedido, filtroAlb);
    const entradaTraer = { pedido: pedidoRef, ...resultado };
    if (resultado.ok && filtroAlb?.length) {
      const traidosAlb = (resultado.albaranes || []).map((a) => String(a).toUpperCase());
      const deMas = traidosAlb.filter((a) => !filtroAlb.includes(a));
      const faltan = filtroAlb.filter((a) => !traidosAlb.includes(a));
      if (deMas.length || faltan.length) {
        entradaTraer.ok = false;
        entradaTraer.error = [
          deMas.length ? `han entrado de más ${deMas.join(", ")}` : "",
          faltan.length ? `faltan ${faltan.join(", ")}` : "",
        ].filter(Boolean).join("; ") + ". Revisa el borrador en BC.";
      }
    }
    traer.push(entradaTraer);
    if (!entradaTraer.ok) {
      avisos.push(`Pedidos ${pedidoRef}: ${entradaTraer.error || "no se han traído los albaranes."}`);
    }

    let adjunto = null;
    if (!reutilizar?.id && pdfBytes && pdfBytes.slice(0, 5).toString() === "%PDF-" && inv?.id) {
      adjunto = await adjuntarPdfFacturaCompra({
        urlBase,
        token,
        invoiceId: inv.id,
        bytes: pdfBytes,
        nombreArchivo: nombreArchivo || `Factura_${factura}.pdf`,
      });
      if (!adjunto.ok) avisos.push(`No se ha podido adjuntar el PDF a ${numero || "la factura"}: ${adjunto.error}`);
    } else if (!reutilizar?.id && (msg || pdfBase64)) {
      avisos.push("No se ha adjuntado el PDF: el archivo no es un PDF.");
    }

    const traidos = traer.filter((t) => t.ok);
    const errorTraer = traer.map((t) => t.error).filter(Boolean).join(" ");
    const avisoBase = traidos.length
      ? (traidos.find((t) => t.mensaje)?.mensaje || avisoTraerAlbaranesOk({ numero, factura, pedidos: nums, traidos }))
      : (
        `Borrador ${numero || "sin nº"} creado (proveedor, nº factura y fecha) para el pedido ${nums.join(", ")}. `
        + (errorTraer
          ? `No se han traído los albaranes: ${errorTraer}`
          : "No se han traído los albaranes: arranca python bc_automation/servicio_registro.py y pulsa otra vez.")
      );
    const payload = {
      ok: true,
      borrador: true,
      numero,
      numeros: numero ? [numero] : [],
      yaExistia: !!reutilizar?.id,
      aviso: [avisoBase, ...avisos].filter(Boolean).join(" "),
      adjunto,
      traerAlbaranes: traer,
      lineasCopiadas: false,
    };
    if (!traidos.length) payload.registroOk = false;
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: "No se pudo crear el borrador de la factura en BC.", detalle: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------
// ENTRAR FACTURA EN BC (borrador, SIN contabilizar) — un clic desde
// "Validación de facturas" cuando el semáforo ya salió verde.
//
// Crea la cabecera (proveedor, nº de factura del proveedor, fecha).
// Si hay pedido, las líneas las trae el script de pantalla
// (Líneas > Línea > Acciones > Traer albaranes de compra). No se
// copian con purchaseInvoiceLines: eso no enlaza el Nº albarán.
// Sin pedido (gasto), la línea de cuenta se sigue creando por la API.
//
// Por seguridad, se sigue re-validando TODO contra BC en el momento de
// pulsar el botón (no se fía del semáforo calculado al subir el PDF, que
// puede haberse quedado desactualizado) — si algo no cuadra, se rechaza
// con un error claro en vez de abrir una factura que no tocaría entrar
// todavía. Si la factura toca varios proveedores, se abre una cabecera
// por proveedor (BC no permite mezclarlos en una misma factura).
// -----------------------------------------------------------------------
app.post("/api/facturas-compra/entrar-bc", async (req, res) => {
  const { factura, fechaFactura, pdfBase64, nombreArchivo, lineasFactura, forzar, comoUltima } = req.body || {};
  if (!factura) return res.status(400).json({ error: "Falta el nº de factura." });
  const invoiceDate =
    fechaFactura && /^\d{4}-\d{2}-\d{2}$/.test(fechaFactura) ? fechaFactura : new Date().toISOString().slice(0, 10);

  const avisos = [];
  const chequeoDuplicado = await facturaYaEntradaEnBC(factura);
  if (chequeoDuplicado.encontrada) {
    const mensajeDuplicado = `Esta factura ya está entrada en BC (factura ${chequeoDuplicado.numeroBC || "?"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""})`;
    if (!forzar) {
      return res.status(409).json({ error: `${mensajeDuplicado} — no se ha vuelto a crear.` });
    }
    avisos.push(`⚠ Forzado: ${mensajeDuplicado}, pero se ha creado de nuevo porque se ha pedido entrarla igual.`);
  }

  let porProveedor = new Map();
  if (comoUltima?.proveedor) {
    const propuesta = await proponerUltimaEntrada(comoUltima.proveedor);
    if (!propuesta?.puedeCrear) {
      return res.status(409).json({ error: propuesta?.resumen || "No hay una última factura sin pedido de este proveedor para copiar la cuenta." });
    }
    const vendorNumber = propuesta.vendorNumber || await buscarNumeroProveedor(propuesta.proveedorBC || comoUltima.proveedor);
    if (!vendorNumber) {
      return res.status(409).json({ error: `No encuentro el nº de proveedor de ${propuesta.proveedorBC || comoUltima.proveedor} en BC — no se puede crear el borrador.` });
    }
    const lineas = lineasBorradorComoUltima({ ...comoUltima, factura }, propuesta);
    if (!lineas.length) {
      return res.status(400).json({ error: "La factura no trae importe para crear la línea como la última entrada." });
    }
    porProveedor.set(vendorNumber, { vendorName: propuesta.proveedorBC, pedidos: [], lineas });
  } else {
  if (!Array.isArray(lineasFactura) || !lineasFactura.length) {
    return res.status(400).json({ error: "Falta 'lineasFactura' (descripción/cantidad/precioUnitario/pedido por línea)." });
  }

  const porPedido = new Map();
  for (const l of lineasFactura) {
    if (!l.pedido) continue;
    if (!porPedido.has(l.pedido)) porPedido.set(l.pedido, []);
    porPedido.get(l.pedido).push(l);
  }
  if (!porPedido.size) {
    if (!forzar) return res.status(400).json({ error: "Ninguna línea tiene un pedido asociado — no se puede entrar la factura." });
    const proveedorForzado = String(req.body?.proveedor || "").trim();
    if (!proveedorForzado) {
      return res.status(400).json({ error: "No hay pedido y falta el proveedor para crear el borrador como la última factura." });
    }
    const propuestaForzada = await proponerUltimaEntrada(proveedorForzado);
    if (!propuestaForzada?.puedeCrear) {
      return res.status(409).json({ error: propuestaForzada?.resumen || `No hay una factura anterior de ${proveedorForzado} para copiar la cuenta y crear el borrador.` });
    }
    const vendorForzado = propuestaForzada.vendorNumber || await buscarNumeroProveedor(propuestaForzada.proveedorBC || proveedorForzado);
    if (!vendorForzado) {
      return res.status(409).json({ error: `No encuentro el nº de proveedor de ${propuestaForzada.proveedorBC || proveedorForzado} en BC — no se puede crear el borrador.` });
    }
    const lineasForzadas = lineasBorradorComoUltima({
      proveedor: proveedorForzado,
      factura,
      baseImponible: req.body?.baseImponible,
      lineas: lineasFactura,
    }, propuestaForzada);
    if (!lineasForzadas.length) {
      return res.status(400).json({ error: "La factura no trae importe para crear la línea como la última entrada." });
    }
    avisos.push(`Forzado sin pedido: borrador copiado de la factura ${propuestaForzada.numeroBC || propuestaForzada.facturaProveedor || "anterior"} de ${propuestaForzada.proveedorBC || proveedorForzado}.`);
    porProveedor.set(vendorForzado, { vendorName: propuestaForzada.proveedorBC, pedidos: [], lineas: lineasForzadas });
  } else {

  // "Entrar en BC de todas formas" (Maria, 2026-09-04): con forzar=true,
  // los motivos de abajo que son decisión de negocio (factura duplicada,
  // línea sin encontrar, pendiente de recibir, precio distinto) dejan de
  // bloquear con 409 — se anotan en `avisos` (ya se enseñan en pantalla)
  // y se sigue creando la factura. Lo que NO se puede saltar nunca:
  // no tener forma de identificar el proveedor en BC (bc.error /
  // vendorNumber ausente) — sin eso no hay a qué proveedor crear la
  // factura, forzar o no.

  // Re-comprobar duplicado EN VIVO también aquí (no solo al subir el
  // PDF) — por si se entró desde otra pestaña/sesión mientras tanto.
  // (el chequeo ya se ha hecho arriba, antes de elegir el camino)

  // Re-validar EN VIVO contra BC (no fiarse del semáforo calculado al
  // subir el PDF) y agrupar por proveedor — BC no permite mezclar
  // proveedores distintos en una misma factura de compra. Las líneas ya
  // emparejadas NO se usan para crear nada en BC — solo para la
  // comprobación de seguridad y para el resumen que se muestra en pantalla.
  for (const [pedido, lineasDePedido] of porPedido) {
    const bc = await buscarPedidoYLineasBC(pedido);
    if (bc.error) return res.status(409).json({ error: `Pedido ${pedido}: ${bc.error}` });
    if (!bc.vendorNumber) return res.status(409).json({ error: `Pedido ${pedido}: no he podido determinar el nº de proveedor en BC (vendorNumber) — no se puede crear la factura.` });

    const emparejadas = emparejarLineasFactura(lineasDePedido, bc.lineasBC);
    for (const l of emparejadas) {
      if (l.coincidencia === "sin_match") {
        const msg = `Pedido ${pedido}: la línea "${l.descripcionFactura}" ya no se encuentra en el pedido en BC.`;
        if (!forzar) return res.status(409).json({ error: `${msg} — revísalo antes de entrar la factura.` });
        avisos.push(`⚠ Forzado: ${msg}`);
      }
      if (l.pendienteRecepcion) {
        const msg = `Pedido ${pedido}: "${l.lineaBC?.descripcion || l.descripcionFactura}" sigue pendiente de recibir/registrar en BC.`;
        if (!forzar) return res.status(409).json({ error: `${msg} — no se puede entrar la factura todavía.` });
        avisos.push(`⚠ Forzado: ${msg}`);
      }
      if (l.diferenciaPrecio) {
        const msg = `Pedido ${pedido}: el precio de "${l.lineaBC?.descripcion || l.descripcionFactura}" ya no coincide con BC.`;
        if (!forzar) return res.status(409).json({ error: `${msg} — revísalo antes de entrar la factura.` });
        avisos.push(`⚠ Forzado: ${msg}`);
      }
    }

    if (!porProveedor.has(bc.vendorNumber)) porProveedor.set(bc.vendorNumber, { vendorName: bc.vendorName, pedidos: [], lineas: [] });
    const grupo = porProveedor.get(bc.vendorNumber);
    grupo.pedidos.push(pedido);
    for (const l of emparejadas) {
      grupo.lineas.push({
        descripcion: l.lineaBC?.descripcion || l.descripcionFactura,
        cantidad: l.cantidadFacturada,
        precio: l.precioFacturado,
        // Datos de la línea del PEDIDO en BC (Maria, 2026-09-04) — se
        // guardan aquí para poder crear la línea de factura equivalente
        // más abajo ("Traer albaranes automáticamente"), sin repetir el
        // emparejamiento.
        codigoBC: l.lineaBC?.codigo || null,
        lineType: l.lineaBC?.lineType || null,
        unitOfMeasureCode: l.lineaBC?.unitOfMeasureCode || null,
        coincidencia: l.coincidencia,
      });
    }
  }
  }
  }

  if (porProveedor.size > 1) {
    avisos.push(
      `La factura toca proveedores distintos en BC (${[...porProveedor.values()].map((g) => g.vendorName).join(", ")}) — como una factura de compra en BC solo puede tener un proveedor, se ha creado UNA FACTURA POR PROVEEDOR en vez de una sola.`
    );
  }

  const token = await obtenerTokenBC();
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
  const urlBase = `${base}/companies(${EMPRESA_ID()})`;

  const facturasCreadas = [];
  for (const [vendorNumber, grupo] of porProveedor) {
    const item = { vendorNumber, vendorName: grupo.vendorName, pedidos: grupo.pedidos, ok: false, lineas: grupo.lineas };
    try {
      const rCab = await fetchConReintento(`${urlBase}/purchaseInvoices`, {
        method: "POST",
        headers: cabeceras,
        body: JSON.stringify({
          // orderNumber y orderId no se envían: en la factura de compra son de solo lectura.
          vendorNumber,
          vendorInvoiceNumber: factura,
          invoiceDate,
          // "postingDate" se manda también con la MISMA fecha, por si el
          // campo que BC muestra como "Fecha factura" en pantalla es en
          // realidad este y no "invoiceDate" — no confirmado todavía cuál
          // de los dos es el que se ve en el cliente de BC de Also Casals.
          postingDate: invoiceDate,
        }),
      });
      if (!rCab.ok) {
        item.error = `BC respondió ${rCab.status} creando la factura: ${(await rCab.text().catch(() => "")).slice(0, 300)}`;
        facturasCreadas.push(item);
        continue;
      }
      const cab = await rCab.json();
      item.purchaseInvoiceId = cab.id;
      item.numero = cab.number;
      item.ok = true;
      console.log(
        `[facturas-compra/entrar-bc] factura ${factura} → fecha leída del PDF: ${fechaFactura || "(ninguna — se ha usado la fecha de hoy)"} · invoiceDate/postingDate enviados a BC: ${invoiceDate}`
      );

      const pedidosGrupo = [...new Set((grupo.pedidos || []).map((p) => String(p || "").trim()).filter(Boolean))];
      item.lineasCreadas = [];
      item.lineasSinCrear = [];
      if (pedidosGrupo.length) {
        item.traerAlbaranes = [];
        for (const pedido of pedidosGrupo) {
          const resultado = await traerAlbaranesCompraUi(item.numero, pedido);
          item.traerAlbaranes.push({ pedido, ...resultado });
          if (resultado.ok && resultado.albaranes?.length) {
            item.lineasCreadas.push(...resultado.albaranes);
            if (resultado.mensaje) avisos.push(resultado.mensaje);
            else if (resultado.total != null) {
              avisos.push(
                `Borrador ${item.numero}: ${resultado.albaranes.join(", ")} · total ≈ ${formatearTotalEs(resultado.total)}. Queda Open.`
              );
            } else {
              avisos.push(
                `Borrador ${item.numero}: ${resultado.albaranes.join(", ")} del pedido ${pedido}. Queda Open.`
              );
            }
          } else if (!resultado.ok) {
            item.lineasSinCrear.push(pedido);
            avisos.push(`Pedido ${pedido}: ${resultado.error || "no se han traído los albaranes."}`);
          }
        }
      } else {
      for (const l of grupo.lineas) {
        if (l.coincidencia === "sin_match" || !l.codigoBC || !l.lineType) {
          item.lineasSinCrear.push(l.descripcion || "(línea sin descripción)");
          continue;
        }
        try {
          const bodyLinea = {
            documentId: cab.id,
            lineType: l.lineType,
            lineObjectNumber: l.codigoBC,
            description: l.descripcion ? String(l.descripcion).slice(0, 100) : undefined,
            quantity: Number(l.cantidad) || 0,
          };
          if (l.precio !== null && l.precio !== undefined && !Number.isNaN(Number(l.precio))) {
            bodyLinea.unitCost = Number(l.precio);
          }
          if (l.unitOfMeasureCode) bodyLinea.unitOfMeasureCode = l.unitOfMeasureCode;
          if (l.depto) bodyLinea.shortcutDimension1Code = l.depto;
          if (l.ot) bodyLinea.shortcutDimension2Code = l.ot;
          let rLinea = await fetchConReintento(`${urlBase}/purchaseInvoiceLines`, {
            method: "POST",
            headers: cabeceras,
            body: JSON.stringify(bodyLinea),
          });
          let sinDimension = false;
          if (!rLinea.ok && (bodyLinea.shortcutDimension1Code || bodyLinea.shortcutDimension2Code)) {
            sinDimension = true;
            delete bodyLinea.shortcutDimension1Code;
            delete bodyLinea.shortcutDimension2Code;
            rLinea = await fetchConReintento(`${urlBase}/purchaseInvoiceLines`, {
              method: "POST",
              headers: cabeceras,
              body: JSON.stringify(bodyLinea),
            });
          }
          if (rLinea.ok) {
            item.lineasCreadas.push(l.descripcion || l.codigoBC);
            if (sinDimension) {
              avisos.push(`Línea ${l.codigoBC} creada. La OT ${l.ot || "—"} y el departamento ${l.depto || "—"} hay que apuntarlos en el borrador: BC no los ha aceptado por la API.`);
            }
          } else {
            const detalleLinea = (await rLinea.text().catch(() => "")).slice(0, 200);
            item.lineasSinCrear.push(`${l.descripcion || l.codigoBC} (BC respondió ${rLinea.status}: ${detalleLinea})`);
          }
        } catch (e) {
          item.lineasSinCrear.push(`${l.descripcion || l.codigoBC} (error: ${String(e.message || e)})`);
        }
      }
      if (item.lineasSinCrear.length) {
        avisos.push(
          `Factura ${item.vendorName || vendorNumber}: ${item.lineasCreadas.length} línea(s) de cuenta en BC, y ${item.lineasSinCrear.length} pendientes: ${item.lineasSinCrear.join(" · ")}`
        );
      }
      }

      // Adjuntar el PDF original del proveedor. El visor de BC no abre el PDF
      // reescrito por pdf-lib (sale el documento en blanco o con error),
      // aunque el navegador sí. Y el contenido tiene que ir como bytes,
      // no como base64 dentro del JSON: si no, BC guarda un archivo que
      // no es un PDF y el visor falla al abrirlo.
      let contenidoBinario = null;
      if (req.body?.msg) contenidoBinario = await bytesPdfDeCorreo(req.body.msg, req.body.att);
      if (!contenidoBinario && pdfBase64) contenidoBinario = Buffer.from(pdfBase64, "base64");
      if (contenidoBinario && contenidoBinario.slice(0, 5).toString() === "%PDF-") {
        const nombrePdf = String(nombreArchivo || `${factura}.pdf`).replace(/[\\/]/g, "_");
        const fileName = nombrePdf.toLowerCase().endsWith(".pdf") ? nombrePdf : `${nombrePdf}.pdf`;
        const urlColeccion = `${urlBase}/attachments`;
        const intentosAdjunto = [];
        item.adjunto = { ok: false };
        try {
          const rCrearB = await fetchConReintento(urlColeccion, {
            method: "POST",
            headers: cabeceras,
            body: JSON.stringify({
              fileName,
              parentType: "Purchase Invoice",
              parentId: cab.id,
            }),
          });
          if (rCrearB.ok) {
            const creadoB = await rCrearB.json();
            const etagB = creadoB["@odata.etag"] || "*";
            const rContenidoB = await fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
              method: "PATCH",
              headers: { ...cabeceras, "Content-Type": "application/pdf", "If-Match": etagB },
              body: contenidoBinario,
            });
            if (rContenidoB.ok) {
              const rLeer = await fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
                headers: { Authorization: cabeceras.Authorization },
              });
              const guardado = rLeer.ok ? Buffer.from(await rLeer.arrayBuffer()) : Buffer.alloc(0);
              if (guardado.slice(0, 5).toString() === "%PDF-") item.adjunto.ok = true;
              else intentosAdjunto.push(`BC guardó ${guardado.length} bytes que no son un PDF`);
            } else intentosAdjunto.push(`contenido → ${rContenidoB.status}: ${(await rContenidoB.text().catch(() => "")).slice(0, 200)}`);
          } else {
            intentosAdjunto.push(`crear → ${rCrearB.status}: ${(await rCrearB.text().catch(() => "")).slice(0, 200)}`);
          }
        } catch (e) {
          intentosAdjunto.push(String(e.message || e));
        }
        if (!item.adjunto.ok) {
          item.adjunto.error = intentosAdjunto.join(" · ") || "No se pudo adjuntar el PDF.";
        }
      } else if (pdfBase64 || req.body?.msg) {
        item.adjunto = { ok: false, error: "El archivo no es un PDF y BC no puede mostrarlo." };
      }

      facturasCreadas.push(item);
    } catch (e) {
      item.error = String(e.message || e);
      facturasCreadas.push(item);
    }
  }

  const huboError = facturasCreadas.some((f) => f.error || !f.ok);
  console.log(`[facturas-compra/entrar-bc] factura ${factura} → ${facturasCreadas.length} factura(s) de compra creada(s) en BC (borrador) · ${huboError ? "con avisos/errores" : "OK"}`);

  // Registro (Maria, 2026-09-04): apunta en la fila de esta factura si
  // se ha llegado a entrar en BC (y si ha sido forzando avisos).
  await actualizarRegistroEntradaBC(factura, {
    fecha: new Date().toISOString(),
    ok: !huboError,
    forzado: !!forzar,
    facturasCreadas: facturasCreadas.map((f) => ({ vendorName: f.vendorName, numero: f.numero, error: f.error || null })),
    avisos,
  });

  if (!huboError) {
    try {
      await borrarPdfPendienteFactura(factura);
    } catch (e) {
      console.warn("[facturas-pdf] No se pudo borrar el PDF ya registrado en BC:", String(e.message || e));
    }
  }

  res.status(huboError ? 207 : 200).json({ ok: !huboError, facturasCreadas, avisos });
});

// -----------------------------------------------------------------------
// PDF DE FACTURAS PENDIENTES — se guarda al cargar la bandeja (y al
// validar) y se borra solo cuando la factura se registra en BC.
// El archivo va a server/data/facturas_pdf/ (no se versiona). El índice
// va a Postgres (app_state · facturas_pdf_pendientes).
// -----------------------------------------------------------------------
const CLAVE_PDF_PENDIENTES = "facturas_pdf_pendientes";

function dirPdfPendientes() {
  const dir = path.join(__dirname, "data", "facturas_pdf");
  fsEstado.mkdirSync(dir, { recursive: true });
  return dir;
}

const crypto = require("crypto");

function idPdfPendiente(s) {
  const texto = String(s || "pdf");
  const hash = crypto.createHash("sha256").update(texto).digest("hex").slice(0, 32);
  const corto = texto.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  return `${corto}-${hash}`;
}

async function leerIndicePdfPendientes() {
  const d = await db.getDoc(CLAVE_PDF_PENDIENTES, { items: [], registradas: [] });
  return {
    items: Array.isArray(d?.items) ? d.items : [],
    registradas: Array.isArray(d?.registradas) ? d.registradas : [],
  };
}

async function escribirIndicePdfPendientes(d) {
  await db.setDoc(CLAVE_PDF_PENDIENTES, { items: d.items || [], registradas: (d.registradas || []).slice(0, 2000) });
}

async function marcarCorreoEntrada(msg, att) {
  if (!msg || att == null || att === "") return;
  const d = await leerIndicePdfPendientes();
  const clave = `mail:${msg}|${att}`;
  if ((d.registradas || []).includes(clave)) return;
  d.registradas = [clave, ...(d.registradas || [])];
  await escribirIndicePdfPendientes(d);
}

function yaRegistradaPdf(d, p) {
  const reg = d.registradas || [];
  if (p.factura && reg.includes(`fac:${p.factura}`)) return true;
  if (p.msg && p.att && reg.includes(`mail:${p.msg}|${p.att}`)) return true;
  return false;
}

async function guardarPdfsPendientes(lista) {
  if (!lista?.length) return;
  const d = await leerIndicePdfPendientes();
  for (const p of lista) {
    if (yaRegistradaPdf(d, p)) continue;
    const sid = idPdfPendiente(p.id);
    const archivo = `${sid}.pdf`;
    const ruta = path.join(dirPdfPendientes(), archivo);
    if (p.bytes && (p.sobrescribir || !fsEstado.existsSync(ruta))) {
      fsEstado.writeFileSync(ruta, p.bytes);
    }
    if (!fsEstado.existsSync(ruta)) continue;
    const prev = d.items.find((x) => x.id === sid) || {};
    const item = {
      ...prev,
      id: sid,
      empresaId: p.empresaId !== undefined ? p.empresaId : prev.empresaId || null,
      nombre: p.nombre || prev.nombre || archivo,
      factura: p.factura !== undefined ? p.factura : prev.factura || null,
      facturas: p.facturas || prev.facturas || [],
      asunto: p.asunto !== undefined ? p.asunto : prev.asunto || "",
      de: p.de !== undefined ? p.de : prev.de || "",
      fecha: p.fecha || prev.fecha || new Date().toISOString(),
      msg: p.msg !== undefined ? p.msg : prev.msg || null,
      att: p.att !== undefined ? p.att : prev.att || null,
      archivo,
      ts: new Date().toISOString(),
      extraida: p.extraida !== undefined ? p.extraida : prev.extraida || null,
    };
    d.items = [item, ...d.items.filter((x) => x.id !== sid)];
  }
  await escribirIndicePdfPendientes(d);
}

async function borrarPdfPendienteFactura(factura) {
  const num = String(factura || "").trim();
  if (!num) return;
  const d = await leerIndicePdfPendientes();
  const quedan = [];
  const correos = new Set();
  for (const it of d.items) {
    const vinculadas = it.facturas || [];
    const esLaFactura = it.factura === num;
    const estabaVinculada = vinculadas.includes(num);
    if ((esLaFactura || estabaVinculada) && it.msg && it.att != null) correos.add(`${it.msg}|${it.att}`);
    if (esLaFactura) {
      try { fsEstado.unlinkSync(path.join(dirPdfPendientes(), it.archivo)); } catch {}
      if (!(d.registradas || []).includes(`fac:${num}`)) d.registradas = [`fac:${num}`, ...(d.registradas || [])];
      continue;
    }
    if (estabaVinculada) {
      const facturas = vinculadas.filter((f) => f !== num);
      if (!facturas.length) {
        try { fsEstado.unlinkSync(path.join(dirPdfPendientes(), it.archivo)); } catch {}
        continue;
      }
      quedan.push({ ...it, facturas });
      continue;
    }
    quedan.push(it);
  }
  for (const clave of correos) {
    const sep = clave.indexOf("|");
    const msg = clave.slice(0, sep);
    const att = clave.slice(sep + 1);
    const sigue = quedan.some((it) => it.msg === msg && String(it.att) === att && (
      (it.factura && it.factura !== num) ||
      (it.facturas || []).some((f) => f && f !== num)
    ));
    if (!sigue) {
      const mailClave = `mail:${msg}|${att}`;
      if (!(d.registradas || []).includes(mailClave)) d.registradas = [mailClave, ...(d.registradas || [])];
    }
  }
  d.items = quedan;
  await escribirIndicePdfPendientes(d);
}

function leerBytesPdfPendiente(item) {
  try {
    return fsEstado.readFileSync(path.join(dirPdfPendientes(), item.archivo));
  } catch {
    return null;
  }
}

// Si el fichero local se perdió (el contenedor se recrea y no había volumen),
// se vuelve a bajar del correo, que es donde Maria sí lo ve.
async function descargarAdjuntoFactura(msg, att) {
  if (!msg || att == null || att === "") return null;
  const token = await obtenerTokenGraph();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(M365_BUZONES.facturas)}/messages/${encodeURIComponent(msg)}/attachments/${encodeURIComponent(att)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const r = await fetchConReintento(url, { headers });
  if (!r.ok) return null;
  const a = await r.json();
  let bytes = a.contentBytes ? Buffer.from(a.contentBytes, "base64") : null;
  if (!bytes?.length) {
    const rv = await fetchConReintento(`${url}/$value`, { headers });
    if (rv.ok) bytes = Buffer.from(await rv.arrayBuffer());
  }
  if (!bytes?.length || bytes.subarray(0, 5).toString() !== "%PDF-") return null;
  try {
    await guardarPdfsPendientes([{
      id: `mail-${msg}-${att}`,
      nombre: a.name || "factura.pdf",
      msg,
      att,
      bytes,
      sobrescribir: true,
    }]);
  } catch (e) {
    console.warn("[facturas-pdf] No se pudo guardar el PDF bajado del correo:", String(e.message || e));
  }
  return bytes;
}

// El PDF del proveedor, tal cual llegó. El que reescribe pdf-lib lo abre el
// navegador, pero el visor de Business Central da error al mostrarlo.
async function bytesPdfDeCorreo(msg, att) {
  if (!msg) return null;
  const indice = await leerIndicePdfPendientes();
  const mismos = indice.items.filter((x) => x.msg === msg && String(x.att ?? "") === String(att ?? ""));
  const candidatos = [mismos.find((x) => !x.extraida && !x.factura), ...mismos].filter(Boolean);
  for (const it of candidatos) {
    const bytes = leerBytesPdfPendiente(it);
    if (bytes?.length) return bytes;
  }
  return descargarAdjuntoFactura(msg, att);
}

// -----------------------------------------------------------------------
// BANDEJA DE FACTURAS (facturacio@) — CIF → empresa; Postgres bandeja_facturas
// -----------------------------------------------------------------------
const leerBandejaProc = async () => db.getDoc("bandeja_facturas", {});
const CLAVE_VISTA_BANDEJA = "bandeja_facturas_vista";

async function leerVistaBandeja() {
  const d = await db.getDoc(CLAVE_VISTA_BANDEJA, { actualizadoEn: null, items: [] });
  return {
    actualizadoEn: d?.actualizadoEn || null,
    items: Array.isArray(d?.items) ? d.items : [],
  };
}

function decorarItemsBandeja(items, procesadas, registradas) {
  const reg = new Set(registradas || []);
  return items.map((it) => ({
    ...it,
    procesada: procesadas[`${it.msg}|${it.att}`] || null,
    entrada: reg.has(`mail:${it.msg}|${it.att}`),
    pdfGuardado: true,
  }));
}
const normCif = (v) => String(v || "").toUpperCase().replace(/^ES/, "").replace(/[^A-Z0-9]/g, "");
const cacheCifPdf = new Map();

async function detectarEmpresaPdf(attId, base64, empresas) {
  if (cacheCifPdf.has(attId)) return cacheCifPdf.get(attId);
  let resultado = { cif: null, empresaId: null, sinTexto: false };
  try {
    const data = await pdfParse(Buffer.from(base64, "base64"));
    const texto = String(data.text || "");
    if (texto.replace(/\s/g, "").length < 30) resultado.sinTexto = true;
    const plano = texto.toUpperCase().replace(/[\s.\-\/]/g, "");
    const coinciden = empresas.filter((e) => normCif(e.cif) && plano.includes(normCif(e.cif)));
    if (coinciden.length === 1) resultado = { cif: normCif(coinciden[0].cif), empresaId: coinciden[0].id, sinTexto: false };
    else if (coinciden.length > 1) resultado = { cif: coinciden.map((e) => normCif(e.cif)).join(" / "), empresaId: null, sinTexto: false, varios: true };
  } catch {
    resultado.sinTexto = true;
  }
  cacheCifPdf.set(attId, resultado);
  return resultado;
}

function offsetMinutosZona(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hora = p.hour === "24" ? 0 : Number(p.hour);
  const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hora, Number(p.minute), Number(p.second));
  return Math.round((comoUtc - date.getTime()) / 60000);
}

// Medianoche de Madrid de hace (dias-1) días. "1 día" = desde las 00:00 de hoy aquí, no las 00:00 UTC.
function inicioVentanaMadrid(dias) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const utcMedianoche = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - (dias - 1), 0, 0, 0);
  const offset = offsetMinutosZona("Europe/Madrid", new Date(utcMedianoche));
  return new Date(utcMedianoche - offset * 60 * 1000);
}

let bandejaSyncEnCurso = null;
async function actualizarBandejaFacturas({ dias = 7, desde = null, hasta = null } = {}) {
  if (bandejaSyncEnCurso) return bandejaSyncEnCurso;
  bandejaSyncEnCurso = actualizarBandejaFacturasAhora({ dias, desde, hasta }).finally(() => { bandejaSyncEnCurso = null; });
  return bandejaSyncEnCurso;
}
async function actualizarBandejaFacturasAhora({ dias = 7, desde = null, hasta = null } = {}) {
  const buzon = M365_BUZONES.facturas;
  const vista = await leerVistaBandeja();
  const procesadas = await leerBandejaProc();
  const registradas = (await leerIndicePdfPendientes()).registradas || [];
  const empresas = await empresasApp().catch(() => [{ id: process.env.BC_COMPANY_ID, nombre: process.env.BC_COMPANY_NAME, cif: "B43831593", porDefecto: true }]);
    const token = await obtenerTokenGraph();
    const headers = { Authorization: `Bearer ${token}` };
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/inbox/messages`;
    // desde = última actualización: solo correos nuevos. Sin desde, la
    // primera vez trae la ventana de días. hasta = relleno hacia atrás.
    let desdeFiltro;
    if (desde) {
      const t = new Date(desde);
      if (Number.isNaN(t.getTime())) throw new Error("Fecha 'desde' no válida.");
      t.setTime(t.getTime() - 2 * 60 * 1000);
      desdeFiltro = t.toISOString().slice(0, 19) + "Z";
    } else {
      desdeFiltro = inicioVentanaMadrid(dias).toISOString().slice(0, 19) + "Z";
    }
    let filtro = `receivedDateTime ge ${desdeFiltro}`;
    const hastaFecha = hasta ? new Date(hasta) : null;
    if (hastaFecha && !Number.isNaN(hastaFecha.getTime())) filtro += ` and receivedDateTime lt ${hastaFecha.toISOString().slice(0, 19)}Z`;
    let url = `${base}?$select=id,subject,from,receivedDateTime,hasAttachments&$top=100&$filter=${filtro}`;
    const mensajes = [];
    while (url && mensajes.length < 300) {
      const r = await fetchConReintento(url, { headers });
      if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      mensajes.push(...(j.value || []));
      url = j["@odata.nextLink"] || null;
    }
    const conocidos = new Set(vista.items.map((it) => it.msg));
    const nuevos = [];
    const aGuardar = [];
    for (const msg of mensajes) {
      if (!msg.hasAttachments || conocidos.has(msg.id)) continue;
      const ar = await fetchConReintento(`${base}/${msg.id}/attachments`, { headers });
      if (!ar.ok) continue;
      for (const att of (await ar.json()).value || []) {
        const nombre = String(att.name || "");
        const esPdf = (att.contentType || "").toLowerCase() === "application/pdf" || nombre.toLowerCase().endsWith(".pdf");
        if (!esPdf || !(att["@odata.type"] || "").endsWith("fileAttachment") || !att.contentBytes) continue;
        const det = await detectarEmpresaPdf(att.id, att.contentBytes, empresas);
        const emp = empresas.find((e) => e.id === det.empresaId);
        aGuardar.push({
          id: `mail-${msg.id}-${att.id}`,
          empresaId: det.empresaId || null,
          nombre,
          asunto: msg.subject || "",
          de: msg.from?.emailAddress?.address || "",
          fecha: msg.receivedDateTime || "",
          msg: msg.id,
          att: att.id,
          bytes: Buffer.from(att.contentBytes, "base64"),
        });
        nuevos.push({
          msg: msg.id, att: att.id, nombre,
          asunto: msg.subject || "", de: msg.from?.emailAddress?.address || "", deNombre: msg.from?.emailAddress?.name || "",
          fecha: msg.receivedDateTime || "",
          empresaId: det.empresaId, empresaNombre: emp ? emp.displayName || emp.nombre : null, cif: det.cif, sinTexto: det.sinTexto, variosCif: !!det.varios,
        });
      }
    }
    const mapa = new Map(vista.items.map((it) => [`${it.msg}|${it.att}`, it]));
    for (const it of nuevos) mapa.set(`${it.msg}|${it.att}`, it);
    const fusion = [...mapa.values()]
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
      .slice(0, 800)
      .map(({ procesada, pdfGuardado, entrada, ...rest }) => rest);
    const esAtras = !!(hastaFecha && !Number.isNaN(hastaFecha.getTime()));
    const actualizadoEn = esAtras ? (vista.actualizadoEn || new Date().toISOString()) : new Date().toISOString();
    await db.setDoc(CLAVE_VISTA_BANDEJA, { actualizadoEn, items: fusion });
    try {
      if (aGuardar.length) await guardarPdfsPendientes(aGuardar);
    } catch (e) {
      console.warn("[facturas-pdf] No se pudieron guardar los PDF de la bandeja:", String(e.message || e));
    }
    return {
      buzon, dias, empresaActual: EMPRESA_ID(),
      actualizadoEn, desdeCache: false, nuevos: nuevos.length,
      items: decorarItemsBandeja(fusion, procesadas, registradas),
    };
}

app.get("/api/facturas-compra/bandeja", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90);
  try {
    const vista = await leerVistaBandeja();
    const procesadas = await leerBandejaProc();
    const registradas = (await leerIndicePdfPendientes()).registradas || [];
    if (req.query.cache === "1") {
      return res.json({
        buzon: M365_BUZONES.facturas, dias, empresaActual: EMPRESA_ID(),
        actualizadoEn: vista.actualizadoEn,
        desdeCache: true, nuevos: 0,
        items: decorarItemsBandeja(vista.items, procesadas, registradas),
      });
    }
    const out = await actualizarBandejaFacturas({
      dias,
      desde: req.query.desde || null,
      hasta: req.query.hasta || null,
    });
    res.json(out);
  } catch (err) {
    console.error("Error /api/facturas-compra/bandeja:", err);
    const codigo = /no válida/.test(String(err.message || "")) ? 400 : 500;
    res.status(codigo).json({ error: "No se pudo leer el buzón de facturas.", detalle: String(err.message || err) });
  }
});

const pausaBandeja = new Map();
const PARALELO_BANDEJA = 3;

function programarBandejaFacturas() {
  const claveDe = (it) => `${it.msg}|${it.att ?? ""}`;
  const enCurso = new Set();
  const sincronizar = async () => {
    if (!process.env.M365_CLIENT_SECRET) return;
    const vista = await leerVistaBandeja();
    await actualizarBandejaFacturas(vista.actualizadoEn ? { desde: vista.actualizadoEn, dias: 7 } : { dias: 7 });
  };
  const siguientesSinLeer = async (max) => {
    const vista = await leerVistaBandeja();
    const procesadas = await leerBandejaProc();
    const indice = await leerIndicePdfPendientes();
    const leidas = new Set(indice.registradas || []);
    for (const it of indice.items) {
      if (!it.msg) continue;
      if (it.extraida || (Array.isArray(it.facturas) && it.facturas.length)) leidas.add(`${it.msg}|${it.att ?? ""}`);
    }
    const ahora = Date.now();
    const salida = [];
    for (const it of vista.items || []) {
      if (salida.length >= max) break;
      const clave = claveDe(it);
      if (enCurso.has(clave)) continue;
      if (procesadas[clave]) continue;
      if (leidas.has(clave) || leidas.has(`mail:${clave}`)) continue;
      const trabajo = lecturasFondo.get(clave);
      if (trabajo?.estado === "leyendo" || trabajo?.estado === "lista") continue;
      const hasta = pausaBandeja.get(clave) || 0;
      if (hasta > ahora) continue;
      salida.push(it);
    }
    return salida;
  };
  const leerUna = async (it) => {
    const clave = claveDe(it);
    const actual = lecturasFondo.get(clave);
    if (actual?.estado === "leyendo" || actual?.estado === "lista") return { omitida: true };
    lecturasFondo.set(clave, { estado: "leyendo", nombre: it.nombre || it.asunto || "" });
    const empresas = await empresasApp().catch(() => []);
    const emp = empresas.find((e) => e.id === it.empresaId) || EMPRESA_POR_DEFECTO();
    await contextoEmpresa.run({ id: emp.id, nombre: emp.nombre, porDefecto: !!emp.porDefecto }, () => new Promise((resolve, reject) => {
      let cerrado = false;
      const fin = (fn, val) => { if (!cerrado) { cerrado = true; fn(val); } };
      extraerFacturaHttp({
        body: { nombre: it.nombre || it.asunto || "factura.pdf", origen: { msg: it.msg, att: it.att }, fondo: false },
      }, {
        _code: 200,
        status(code) { this._code = code; return this; },
        json(obj) {
          if (lecturasFondo.get(clave)?.estado === "error") {
            fin(reject, new Error(obj.detalle || obj.error || "lectura detenida"));
            return;
          }
          if ((this._code || 200) >= 400) fin(reject, new Error(obj.detalle || obj.error || "No se ha podido leer la factura"));
          else {
            lecturasFondo.set(clave, { estado: "lista", paginas: obj.paginas, facturas: obj.facturas });
            fin(resolve, obj);
          }
        },
      }).catch((err) => fin(reject, err));
    }));
    return { omitida: false };
  };
  const lanzar = (it) => {
    const clave = claveDe(it);
    enCurso.add(clave);
    console.log(`[bandeja] Leyendo en segundo plano ${it.nombre || it.asunto || clave}`);
    conLecturaLimitada(() => leerUna(it))
      .then((r) => {
        if (r?.omitida) return;
        pausaBandeja.set(clave, Date.now() + 6 * 60 * 60 * 1000);
      })
      .catch((e) => {
        console.warn("[bandeja] Lectura:", e.message || e);
        if (lecturasFondo.get(clave)?.estado === "leyendo") {
          lecturasFondo.set(clave, { estado: "error", error: String(e.message || e) });
        }
        pausaBandeja.set(clave, Date.now() + 30 * 60 * 1000);
      })
      .finally(() => enCurso.delete(clave));
  };
  const bucleSync = async () => {
    try { await sincronizar(); }
    catch (e) { console.warn("[bandeja] No se pudo actualizar el buzón:", e.message || e); }
    setTimeout(bucleSync, 60 * 1000);
  };
  const bucleLeer = async () => {
    let espera = 20000;
    try {
      const huecos = PARALELO_BANDEJA - enCurso.size;
      if (huecos > 0) {
        const lote = await siguientesSinLeer(huecos);
        if (lote.length) {
          espera = 2000;
          for (const it of lote) lanzar(it);
        }
      } else {
        espera = 2000;
      }
    } catch (e) {
      console.warn("[bandeja] Cola de lectura:", e.message || e);
    }
    setTimeout(bucleLeer, espera);
  };
  // Cada 5 min: TODAS las pendientes con nº de proveedor vs BC (registradas
  // → Entradas; PFC* solo aviso borrador). Sin limite: si no, las de más
  // abajo del índice nunca se tocaban.
  const bucleReconciliar = async () => {
    try {
      const out = await reconciliarFacturasYaEntradasEnBC({ limite: null });
      const marcadas = (out.resultados || []).filter((r) => r.marcada || r.estado === "registrada");
      if (marcadas.length) {
        console.log(`[bandeja] Reconciliación BC: ${marcadas.length} factura(s) ya registradas sacadas de Pendientes → ${marcadas.map((m) => `${m.factura}=${m.numeroBC}`).join(", ")}`);
      } else if (out.unicasRevisadas) {
        console.log(`[bandeja] Reconciliación BC: 0 nuevas entradas · ${out.unicasRevisadas} nº revisados · ${out.borradores || 0} borrador(es)`);
      }
    } catch (e) {
      console.warn("[bandeja] Reconciliación BC:", e.message || e);
    }
    setTimeout(bucleReconciliar, 5 * 60 * 1000);
  };
  setTimeout(bucleSync, 4000);
  setTimeout(bucleLeer, 8000);
  setTimeout(bucleReconciliar, 15000);
  console.log(`[bandeja] El buzón de facturas se actualiza y se lee en segundo plano (${PARALELO_BANDEJA} a la vez). Reconciliación BC de repetidas cada 5 min (todas las pendientes).`);
}

app.get("/api/facturas-compra/bandeja/pdf", async (req, res) => {
  try {
    const indice = await leerIndicePdfPendientes();
    const sid = idPdfPendiente(`mail-${req.query.msg}-${req.query.att}`);
    const guardado = indice.items.find((x) => x.id === sid);
    if (guardado) {
      const bytes = leerBytesPdfPendiente(guardado);
      if (bytes) return res.json({ nombre: guardado.nombre, base64: bytes.toString("base64"), guardado: true });
    }
    const token = await obtenerTokenGraph();
    const buzon = M365_BUZONES.facturas;
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/messages/${encodeURIComponent(req.query.msg)}/attachments/${encodeURIComponent(req.query.att)}`;
    const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Graph respondió ${r.status}`);
    const a = await r.json();
    if (a.contentBytes) {
      try {
        await guardarPdfsPendientes([{
          id: `mail-${req.query.msg}-${req.query.att}`,
          nombre: a.name,
          msg: req.query.msg,
          att: req.query.att,
          bytes: Buffer.from(a.contentBytes, "base64"),
        }]);
      } catch (e) {
        console.warn("[facturas-pdf] No se pudo guardar el PDF al descargarlo:", String(e.message || e));
      }
    }
    res.json({ nombre: a.name, base64: a.contentBytes });
  } catch (err) {
    res.status(500).json({ error: "No se pudo descargar la factura.", detalle: String(err.message || err) });
  }
});

// El visor del navegador abre este PDF por URL (un blob: dentro de un
// iframe sale "Error" y no pinta el documento).
function normalizarPedidoEscrito(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  const full = s.match(/^(PC|OC)(\d{2})-(\d{3,7})$/);
  if (full) return `${full[1]}${full[2]}-${full[3].padStart(6, "0")}`;
  const corto = s.match(/^(PC|OC)-(\d{3,7})$/);
  if (corto) return `${corto[1]}-${corto[2]}`;
  return null;
}

// Nº de albarán impreso en el PDF ("Albarán: 2026/5807", "ALBARAN Nº 1.627.059").
// Si no hay ninguno, el cliente usa el nº del documento.
function albaranEscritoEnTexto(texto) {
  const s = String(texto || "");
  const re = /albar[aáà]n(?:es)?\s*(?:n[ºo°.]*)?\s*[:.\-]?\s*([0-9][0-9A-Za-z/.\-]{2,})/gi;
  let m;
  while ((m = re.exec(s))) {
    const num = m[1].replace(/\s+/g, "").replace(/[.,;]+$/, "");
    if (/\d/.test(num) && num.length >= 3) return num;
  }
  return null;
}

// Líneas de material del PDF. pdf-parse a veces lee la tabla por columnas
// y junta el total con la descripción: "6,38Lejia 5 L. Ari" / cantidad / precio / código.
function lineasEscritasEnTexto(texto) {
  const s = String(texto || "").replace(/\r/g, "");
  const out = [];
  const vistos = new Set();
  const push = (descripcion, cantidad, codigo) => {
    const desc = String(descripcion || "").replace(/\s+/g, " ").trim();
    const qty = Number(String(cantidad || "").replace(",", "."));
    if (!desc || !(qty > 0)) return;
    if (/^(PC|OC)\s*\d{2}\s*-\s*\d+$/i.test(desc.replace(/\s+/g, ""))) return;
    if (/^albar[aáà]n\b/i.test(desc)) return;
    const clave = `${desc.toLowerCase()}|${qty}|${codigo || ""}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    out.push({ descripcion: desc, cantidad: qty, codigo: codigo ? String(codigo) : "" });
  };
  const reCol = /(\d{1,6}[.,]\d{2})([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][^\n]*)\n\s*(\d{1,6}(?:[.,]\d+)?)\n\s*\d+[.,]\d+\n\s*(\d{1,8})\b/g;
  let m;
  while ((m = reCol.exec(s))) push(m[2], m[3], m[4]);
  if (!out.length) {
    const reFila = /(?:^|\n)\s*(\d{4,8})\s+(\d{1,6}(?:[.,]\d+)?)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][^\n]{2,}?)\s+\d{1,6}[.,]\d{2,4}\s+\d{1,3}\s+\d{1,3}\s+\d{1,6}[.,]\d{2}/g;
    while ((m = reFila.exec(s))) push(m[3], m[2], m[1]);
  }
  return out;
}

// Misma cola que el frontend (PC26-003946 ≡ PC3946) para no duplicar.
function colaPedidoEscrito(raw) {
  const m = String(raw || "").toUpperCase().replace(/\s+/g, "").match(/^(PC|OC)(?:\d{2})?-?(\d+)$/);
  if (!m) return "";
  return m[1] + String(Number(m[2]));
}

// PC/OC tolerante a saltos de línea (cabeceras Herraiz: "PC26-\n004079")
// y a texto duplicado de pdf-parse ("PC26-003963PC26-003963") — sin \b final.
const RE_PC_OC_NUM = /((?:PC|OC)\s*(?:\d{2}\s*[-/]\s*\d{3,7}|-\s*\d{3,7}))(?![0-9])/gi;

// Grupos del cuerpo, de arriba abajo (Herraiz): "Pedido: S94046 ( PC26-003963 )"
// También aguanta "Pedido:Pedido:" / "S94046S94046" / "(( PC…PC… ))".
const RE_PEDIDO_GRUPO_CUERPO =
  /pedido\s*(?:n[ºo°.]*)?\s*[:.\-]?\s*(?:pedido\s*(?:n[ºo°.]*)?\s*[:.\-]?\s*)?[^\n]{0,60}?\(\s*((?:PC|OC)\s*\d{2}\s*[-/]\s*\d{3,7})/gi;

// "Su referencia: PC…" / "Nuestra referencia: PC…" (un PC por etiqueta).
// NO usar "Referencia:" suelta: en Herraiz es un listado de cabecera.
const RE_SU_REFERENCIA =
  /(?:su|nuestra)\s+refer[eè]ncia\s*[:.\-]?\s*((?:PC|OC)\s*(?:\d{2}\s*[-/]\s*\d{3,7}|-\s*\d{3,7}))/gi;

function mencionesPedidoEnTexto(texto, re) {
  const s = String(texto || "");
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s))) {
    const num = normalizarPedidoEscrito(String(m[1] || "").replace(/\//g, "-"));
    if (!num) continue;
    out.push({ num, cola: colaPedidoEscrito(num), index: m.index });
  }
  return out;
}

// Orden de chips = aparición de grupos de líneas en el cuerpo (Pedido:…(PC…)
// / Su referencia), no el listado de PCs de la esquina de cabecera.
// Los PC que solo salen en cabecera van al final, para no perderlos.
function pedidosEscritosEnTexto(texto) {
  const s = String(texto || "");
  const out = [];
  const vistos = new Set();
  const push = (num) => {
    const cola = colaPedidoEscrito(num);
    if (!cola || vistos.has(cola)) return;
    vistos.add(cola);
    out.push(num);
  };

  const cuerpo = [
    ...mencionesPedidoEnTexto(s, RE_PEDIDO_GRUPO_CUERPO),
    ...mencionesPedidoEnTexto(s, RE_SU_REFERENCIA),
  ].sort((a, b) => a.index - b.index || a.cola.localeCompare(b.cola));
  for (const hit of cuerpo) push(hit.num);

  const inicioCuerpo = cuerpo.length ? cuerpo[0].index : -1;
  const todos = mencionesPedidoEnTexto(s, RE_PC_OC_NUM);
  // Primero el resto que aparece desde el primer bloque de cuerpo (o todo
  // el documento si no hay bloques reconocibles).
  for (const hit of todos) {
    if (inicioCuerpo >= 0 && hit.index < inicioCuerpo) continue;
    push(hit.num);
  }
  // Cabecera / resumen: solo al final.
  if (inicioCuerpo >= 0) {
    for (const hit of todos) {
      if (hit.index >= inicioCuerpo) continue;
      push(hit.num);
    }
  }
  return out;
}

function indicePedidoEnTexto(texto, pedido) {
  const cola = colaPedidoEscrito(normalizarPedidoEscrito(pedido) || pedido);
  if (!cola || !texto) return Number.POSITIVE_INFINITY;
  const s = String(texto);
  const cuerpo = [
    ...mencionesPedidoEnTexto(s, RE_PEDIDO_GRUPO_CUERPO),
    ...mencionesPedidoEnTexto(s, RE_SU_REFERENCIA),
  ].filter((h) => h.cola === cola);
  if (cuerpo.length) return Math.min(...cuerpo.map((h) => h.index));

  const inicioCuerpo = (() => {
    const todosCuerpo = [
      ...mencionesPedidoEnTexto(s, RE_PEDIDO_GRUPO_CUERPO),
      ...mencionesPedidoEnTexto(s, RE_SU_REFERENCIA),
    ];
    if (!todosCuerpo.length) return -1;
    return Math.min(...todosCuerpo.map((h) => h.index));
  })();
  const todos = mencionesPedidoEnTexto(s, RE_PC_OC_NUM).filter((h) => h.cola === cola);
  if (!todos.length) return Number.POSITIVE_INFINITY;
  if (inicioCuerpo < 0) return Math.min(...todos.map((h) => h.index));
  const enCuerpo = todos.filter((h) => h.index >= inicioCuerpo);
  if (enCuerpo.length) return Math.min(...enCuerpo.map((h) => h.index));
  // Solo en cabecera → después de cualquier PC del cuerpo.
  return 1e12 + Math.min(...todos.map((h) => h.index));
}

function ordenarPedidosDetallePorTexto(pedidosDetalle, texto) {
  if (!Array.isArray(pedidosDetalle) || pedidosDetalle.length < 2 || !texto) return pedidosDetalle;
  return [...pedidosDetalle]
    .map((p, i) => ({ p, i, idx: p?.pedido ? indicePedidoEnTexto(texto, p.pedido) : Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.idx - b.idx) || (a.i - b.i))
    .map((x) => x.p);
}

app.get("/api/facturas-compra/pedidos-factura", async (req, res) => {
  try {
    const bytes = await bytesPdfDeCorreo(req.query.msg, req.query.att);
    if (!bytes) return res.json({ pedidos: [], esAlbaran: false, albaran: null, lineas: [] });
    let texto = "";
    try { texto = String((await pdfParse(bytes))?.text || ""); } catch { /* se queda sin pedidos leídos */ }
    res.json({
      pedidos: pedidosEscritosEnTexto(texto),
      esAlbaran: /albar[aàá]n/i.test(texto),
      albaran: albaranEscritoEnTexto(texto),
      lineas: lineasEscritasEnTexto(texto),
    });
  } catch (err) {
    res.status(500).json({ error: "No se han podido leer los pedidos de la factura.", detalle: String(err.message || err) });
  }
});

app.get("/api/facturas-compra/bandeja/archivo.pdf", async (req, res) => {
  try {
    const bytes = await bytesPdfDeCorreo(req.query.msg, req.query.att);
    if (!bytes) return res.status(404).json({ error: "No hay PDF guardado de esta factura." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=\"factura.pdf\"");
    res.send(bytes);
  } catch (err) {
    res.status(500).json({ error: "No se pudo abrir el PDF.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/incidencia", async (req, res) => {
  try {
    const { msg, att, factura, facturaOriginal, incidencia, motivos, veredicto, pedidosDetalle, fecha, baseImponible, importeTotal, lineasSinPedido, proveedor } = req.body || {};
    if (!msg && !factura) return res.status(400).json({ error: "Falta la factura." });
    const d = await leerIndicePdfPendientes();
    let coinciden = d.items.filter((x) =>
      (msg && x.msg === msg && String(x.att ?? "") === String(att ?? "")) ||
      ((factura || facturaOriginal) && (x.factura === factura || x.factura === facturaOriginal || x.extraida?.factura === factura || x.extraida?.factura === facturaOriginal))
    );
    if (!coinciden.length) return res.status(404).json({ error: "No hay PDF guardado de esta factura." });
    const deEsta = coinciden.filter((x) => !x.extraida?.factura || x.extraida.factura === factura || x.extraida.factura === facturaOriginal || x.factura === factura || x.factura === facturaOriginal);
    if (deEsta.length) coinciden = deEsta;
    for (const it of coinciden) {
      const previa = it.extraida || {};
      it.factura = factura || it.factura || previa.factura || null;
      it.extraida = {
        ...previa,
        factura: factura || previa.factura || it.factura || null,
        proveedor: proveedor !== undefined ? (String(proveedor || "").trim() || null) : (previa.proveedor || null),
        fecha: fecha !== undefined ? fecha : previa.fecha,
        baseImponible: baseImponible !== undefined ? baseImponible : previa.baseImponible,
        importeTotal: importeTotal !== undefined ? importeTotal : previa.importeTotal,
        pedidosDetalle: Array.isArray(pedidosDetalle) ? pedidosDetalle : previa.pedidosDetalle,
        lineasSinPedido: Array.isArray(lineasSinPedido) ? lineasSinPedido : previa.lineasSinPedido,
        incidencia: incidencia !== undefined ? String(incidencia || "") : (previa.incidencia || ""),
        motivos: Array.isArray(motivos) ? motivos : (previa.motivos || []),
        veredicto: veredicto || previa.veredicto,
      };
      it.ts = new Date().toISOString();
    }
    await escribirIndicePdfPendientes(d);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "No se ha podido guardar la incidencia.", detalle: String(err.message || err) });
  }
});

app.get("/api/facturas-compra/pendientes", async (req, res) => {
  try {
    const empresa = EMPRESA_ID();
    const indice = await leerIndicePdfPendientes();
    const facturas = [];
    const resumen = req.query.resumen === "1";
    const msgFiltro = String(req.query.msg || "");
    const attFiltro = req.query.att != null ? String(req.query.att) : "";
    for (const it of indice.items) {
      if (!it.extraida) continue;
      // Las lecturas guardadas con el nombre cortado repetían el primer PDF.
      if (!/-[a-f0-9]{32}$/.test(String(it.id || ""))) continue;
      if (it.empresaId && it.empresaId !== empresa) continue;
      if (msgFiltro && (it.msg !== msgFiltro || String(it.att ?? "") !== attFiltro)) continue;
      const bytes = leerBytesPdfPendiente(it);
      // El resumen no necesita el fichero: si el contenedor se recreó, los datos
      // siguen en Postgres y el PDF se baja del correo al abrirlo.
      if (!bytes && !resumen) continue;
      facturas.push({
        ...it.extraida,
        pdfBase64: resumen || !bytes ? undefined : bytes.toString("base64"),
        pdfGuardado: !!bytes,
        origen: it.msg ? { msg: it.msg, att: it.att } : null,
      });
    }
    facturas.sort((a, b) => String(b.factura || "").localeCompare(String(a.factura || "")));
    res.json({ facturas });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron leer las facturas guardadas.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/bandeja/entrada", async (req, res) => {
  try {
    const { msg, att } = req.body || {};
    if (!msg || att == null || att === "") return res.status(400).json({ error: "Falta msg/att." });
    await marcarCorreoEntrada(msg, att);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/bandeja/procesada", async (req, res) => {
  try {
    const { msg, att, quitar } = req.body || {};
    if (!msg || !att) return res.status(400).json({ error: "Falta msg/att." });
    const d = await leerBandejaProc();
    const clave = `${msg}|${att}`;
    if (quitar) delete d[clave];
    else d[clave] = { ts: new Date().toISOString(), empresa: EMPRESA_NOMBRE() };
    await db.setDoc("bandeja_facturas", d);
    res.json({ ok: true, procesada: d[clave] || null });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------
// Módulos Proves (IA, ratios, macro, horas, correos PC → notas recepción)
// ---------------------------------------------------------------------
require("./iaBC.cjs")({ app, obtenerTokenBC, fetchConReintento, db });
require("./contabilidad.cjs")({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, EMPRESA_NOMBRE, db, claveEmpresa });
require("./panelInicial.cjs")({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, leerPdfBC, fetchParteAlso });
require("./macro.cjs")({ app, fetchConReintento, db });
const BUZON_PERSONAL = () => process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com";
require("./correoPC.cjs")({ app, obtenerTokenGraph, fetchConReintento, leerRecep, escribirRecep, BUZON_PERSONAL });
require("./pedidosVentaSeguimiento.cjs")({ app, db, claveEmpresa, obtenerTokenGraph, fetchConReintento, BUZON_PERSONAL, buzonDelUsuario });
require("./teamsChatbot.cjs")({ app, db, obtenerTokenGraph, fetchConReintento });
require("./horas.cjs")({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE, EMPRESA_ID, db, claveEmpresa });
require("./recepcionFirmas.cjs")({
  app,
  obtenerTokenBC,
  fetchConReintento,
  EMPRESA_NOMBRE,
  db,
  claveEmpresa,
  leerRecep,
  escribirRecep,
  leerVistaPdf: leerVistaPdfRecepcion,
});
async function buscarArticulosOferta(filtro) {
  const token = await obtenerTokenBC();
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/items`;
  const r = await fetchConReintento(
    `${base}?$filter=${encodeURIComponent(filtro)}&$top=80&$select=number,displayName,blocked`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`BC respondió ${r.status} al buscar artículos.`);
  return ((await r.json()).value || []).map((it) => ({
    numero: it.number,
    descripcion: it.displayName || "",
    blocked: !!it.blocked,
  }));
}
require("./ofertasComparar.cjs").registrar({
  app,
  fetchConReintento,
  buscarArticulos: buscarArticulosOferta,
  empresaNombre: EMPRESA_NOMBRE,
  db,
  claveEmpresa,
});
require("./albaranVentaCorreo.cjs").registrarRutas({
  app,
  obtenerTokenBC,
  obtenerTokenGraph,
  fetchConReintento,
  EMPRESA_ID,
  EMPRESA_NOMBRE,
  buzonDelUsuario,
});
const informePedidosPendientes = require("./informePedidosPendientes.cjs");
const informeHoras = require("./informeHoras.cjs");
const avisoHorasLunes = require("./avisoHorasLunes.cjs");
const informeDiarioFinanciero = require("./informeDiarioFinanciero.cjs");
const llamadasPcPendientes = require("./llamadasPcPendientes.cjs");
const cargaAutomaticaBc = require("./cargaAutomaticaBc.cjs");

/** Estado del refresco automático de BC (cada hora, día en curso). */
app.get("/api/carga-auto", async (req, res) => {
  try {
    const meta = await db.getDoc("carga_automatica_bc", null);
    res.json({
      ok: true,
      activo: String(process.env.CARGA_AUTO_OFF || "").trim() !== "1",
      intervaloMs: Number(process.env.CARGA_AUTO_MS ?? 3_600_000) || 3_600_000,
      ...(meta || {}),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/** Una sola fuente de bcData (para refrescar la pantalla tras el auto). */
app.get("/api/estado/bc/:fuente", async (req, res) => {
  try {
    const pref = claveEmpresa("estado");
    const fuente = String(req.params.fuente || "").trim();
    if (!fuente) return res.status(400).json({ error: "Falta fuente." });
    const valor = await db.getDoc(`${pref}.bcData.${fuente}`, null);
    if (!valor) return res.status(404).json({ error: `Sin datos para ${fuente}.` });
    res.json({ fuente, data: valor });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/** Vista previa del diario financiero (sin enviar). */
app.get("/api/informe-diario-financiero/preparar", async (req, res) => {
  try {
    const informe = await informeDiarioFinanciero.preparar({ db, fechaHoy: req.query.fechaHoy || undefined });
    const pm = informe.contab.puntoMuerto;
    res.json({
      ok: true,
      asunto: informe.asunto,
      fechaHoy: informe.fechaHoy,
      empresa: informe.empresa,
      periodos: informe.periodos,
      ventas: informe.contab.ventas,
      consumos: informe.contab.consumos,
      facturas: informe.facturas,
      tesoreria: informe.tesoreria,
      macro: informe.macroEmail,
      puntoMuerto: pm
        ? {
            pm: pm.pm,
            pmInicio: pm.pmInicio,
            pmMesObs: pm.pmMesObs,
            tendencia: pm.tendencia,
            fase: pm.fase,
            cf: pm.cf,
            ventasAcum: pm.ventasAcum,
            cobertura: pm.cobertura,
            holgura: pm.holgura,
            etiquetaMes: pm.etiquetaMes,
            etiquetaMesPrev: pm.etiquetaMesPrev,
          }
        : null,
      html: informe.html,
    });
  } catch (err) {
    console.error("[informe-diario/preparar]", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/** Envía ya el diario financiero (prueba manual). */
app.post("/api/informe-diario-financiero/enviar", async (req, res) => {
  try {
    const r = await informeDiarioFinanciero.enviar({
      db,
      fechaHoy: req.body?.fechaHoy || undefined,
      marcar: !!req.body?.marcar,
    });
    res.json({ ok: true, asunto: r.asunto, para: r.para, fechaHoy: r.fechaHoy, ventas: r.ventas, facturas: r.facturas });
  } catch (err) {
    console.error("[informe-diario/enviar]", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/** Prueba manual: prepara el informe de PCs y lanza el seguimiento (simular/vapi según .env). */
app.post("/api/informe-pc/llamadas-prueba", async (req, res) => {
  try {
    const fechaPedido = req.body?.fechaPedido || undefined;
    const fechaHoy = req.body?.fechaHoy || undefined;
    const forzarModo = req.body?.modo; // "simular" | "vapi" | omitir → .env
    const prev = process.env.INFORME_PC_LLAMADAS;
    if (forzarModo) process.env.INFORME_PC_LLAMADAS = String(forzarModo);
    try {
      const informe = await informePedidosPendientes.preparar({ fechaPedido, fechaHoy });
      const r = await llamadasPcPendientes.trasInforme(informe);
      res.json({ ok: true, n: informe.n, asunto: informe.asunto, fechaPedido: informe.fecha, seguimiento: r });
    } finally {
      if (forzarModo) {
        if (prev == null) delete process.env.INFORME_PC_LLAMADAS;
        else process.env.INFORME_PC_LLAMADAS = prev;
      }
    }
  } catch (err) {
    console.error("[informe-pc/llamadas-prueba]", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// SPA: cualquier ruta que no sea /api → index.html (build de Vite en public/)
app.get(/^\/(?!api).*/, (req, res) => {
  const indexHtml = path.join(__dirname, "public", "index.html");
  if (!fsEstado.existsSync(indexHtml)) {
    return res.status(404).type("text/plain").send(
      "Frontend no compilado. En desarrollo usa Vite (:5173); en Docker el build va en public/."
    );
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(indexHtml);
});

// ---------------------------------------------------------------------
async function arrancar() {
  try {
    await db.init();
  } catch (err) {
    console.error("[db] No se pudo conectar a Postgres. ¿Está `docker compose up -d db`?");
    console.error(err.message || err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Agente de Ventas — backend escuchando en http://localhost:${PORT}`);
    informePedidosPendientes.programar({ db });
    informeHoras.programar({ db });
    avisoHorasLunes.programar({ db });
    informeDiarioFinanciero.programar({ db });
    programarBandejaFacturas();
    cargaAutomaticaBc.programar({
      db,
      claveEmpresa,
      contextoEmpresa,
      empresasApp,
      obtenerTokenBC,
      fetchConReintento,
      FUENTES_BC,
      FUENTES_WS,
      EMPRESA_ID,
      EMPRESA_NOMBRE,
      EMPRESA_POR_DEFECTO,
    });
    console.log(`[recepcion] Subir Documento: emparejamiento manual + coincidencia por raíz de palabra — ${PDFDocument ? "activo (pdf-lib OK)" : "INACTIVO — falta 'npm install pdf-lib'"}`);
    console.log("[facturas-compra] Entrar en BC 2026-09-04: SOLO cabecera (sin líneas) + fecha leída del PDF + adjunto con 2 intentos (A/B)");
    console.log("[facturas-compra] Duplicados 2026-09-04 (v2): carga completa + varios candidatos de servicio + auto-descubrimiento en catálogo BC");
    console.log("[facturas-compra] Forzar entrada 2026-09-04: con forzar=true se salta duplicado/sin_match/pendiente recepción/precio distinto (queda anotado en avisos) — sigue bloqueado si no hay vendorNumber");
    console.log("[facturas-compra] Registro: Postgres app_state.registro_facturas_compra — GET /api/facturas-compra/registro");
    console.log("[facturas-compra] Proveedores de gasto 2026-09-04: detección automática (histórico de líneas de factura de compra) de proveedores sin pedido — sugiere cuenta contable + Nº OT en pantalla, no crea la línea en BC todavía — GET /api/facturas-compra/proveedores-gasto");
    const faltan = ["ANTHROPIC_API_KEY", "BC_TENANT_ID", "BC_CLIENT_ID", "BC_CLIENT_SECRET", "BC_ENVIRONMENT", "BC_COMPANY_ID", "BC_COMPANY_NAME", "DATABASE_URL"].filter(
      (k) => !process.env[k]
    );
    if (faltan.length) console.warn("⚠️  Variables de entorno sin configurar:", faltan.join(", "));
  });
}

arrancar();
