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
app.use("/api/auth", authRouter);
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return requiereSesion(req, res, next);
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
try {
  const undici = require("undici");
  const dispatcherLento = new undici.Agent({
    connectTimeout: 20_000,   // 20 s para conectar
    headersTimeout: 500_000,  // 500 s para que empiece a responder (cabeceras pedido, 90+ cols)
    bodyTimeout: 500_000,     // 500 s para el cuerpo completo
  });
  fetchLento = (url, opciones = {}) => undici.fetch(url, { ...opciones, dispatcher: dispatcherLento });
} catch {
  /* undici no instalado: se usan los tiempos por defecto de Node */
}

async function fetchConReintento(url, opciones = {}, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fetchLento(url, opciones);
    } catch (err) {
      ultimoError = err;
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
const EMPRESA_POR_DEFECTO = () => ({ id: process.env.BC_COMPANY_ID, nombre: process.env.BC_COMPANY_NAME, porDefecto: true });
const EMPRESA_ACTUAL = () => contextoEmpresa.getStore() || EMPRESA_POR_DEFECTO();
function EMPRESA_ID() { return EMPRESA_ACTUAL().id; }
function EMPRESA_NOMBRE() { return EMPRESA_ACTUAL().nombre; }
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
    res.json(await db.getEstado());
  } catch (err) {
    console.error("Error leyendo estado:", err);
    res.status(500).json({ error: "No se pudo leer el estado." });
  }
});

app.post("/api/estado", async (req, res) => {
  try {
    const claves = await db.mergeEstado(req.body || {});
    console.log(`[estado] Guardado en Postgres: ${claves.join(", ")}`);
    res.json({ guardado: claves });
  } catch (err) {
    console.error("Error guardando estado:", err);
    res.status(500).json({ error: "No se pudo guardar el estado." });
  }
});

app.delete("/api/estado", async (req, res) => {
  try {
    await db.deleteEstado();
    res.json({ borrado: true });
  } catch (err) {
    res.status(500).json({ error: "No se pudo borrar el estado." });
  }
});

// ---------------------------------------------------------------------
// 0a-bis) RECEPCIÓN — marcas compartidas (revisados, fechas, reclamados…)
// ---------------------------------------------------------------------
//   { revisados, fechas, reclamados, emailsProveedor, notas, registrados }
// ---------------------------------------------------------------------
const RECEP_DEFAULT = { revisados: {}, fechas: {}, reclamados: {}, emailsProveedor: {}, notas: {}, registrados: {} };
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

// Email del PROVEEDOR desde su ficha en BC (API v2.0 /vendors, solo LECTURA).
app.get("/api/bc/proveedor-email", async (req, res) => {
  const numero = String(req.query.numero || "").trim();
  const nombre = String(req.query.nombre || "").trim();
  if (!numero && !nombre) return res.status(400).json({ error: "Falta 'numero' o 'nombre'." });
  try {
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/vendors`;
    const esc = (v) => v.replace(/'/g, "''");
    const filtros = [];
    if (numero) filtros.push(`number eq '${esc(numero)}'`);
    if (nombre) filtros.push(`displayName eq '${esc(nombre)}'`);
    for (const f of filtros) {
      const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(f)}&$select=number,displayName,email`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const v = ((await r.json()).value || [])[0];
      if (v) return res.json({ email: v.email || "", numero: v.number, nombre: v.displayName });
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
let cacheFichasCorreo = { ts: 0, lista: [] };
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
  if (Date.now() - cacheFichasCorreo.ts < 120000) return cacheFichasCorreo.lista;
  const raw = await db.getDoc("estado.fichas", []);
  const lista = (Array.isArray(raw) ? raw : []).map((par) => (Array.isArray(par) ? par[1] : par)).filter(Boolean);
  cacheFichasCorreo = { ts: Date.now(), lista };
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
    const contexto = {
      remitente: { nombre: cuerpo.deNombre || "", email: cuerpo.de || "" },
      fichaBC: fichaBc,
      otsEnLaApp: coinciden,
      referenciasEnElCorreo: pistas,
      reglasAprendidas: reglas,
    };
    const prompt = `Ets l'assistent de correu d'ALSO CASALS. La ${nombre} ha obert un correu i necessita una recomanació per respondre'l.
Fes servir NOMÉS les dades del context. No inventis preus, dates, estats ni números que no hi surtin. Si falta una dada, digues-ho i proposa preguntar-la.
Respon en l'idioma del correu original.

CORREU
De: ${cuerpo.deNombre || ""} <${cuerpo.de || ""}>
Assumpte: ${cuerpo.asunto || ""}
${plano || "(sense text)"}

CONTEXT DE L'APP (JSON):
${JSON.stringify(contexto).slice(0, 12000)}

A més, descriu la FEINA a fer a Business Central, només si el correu ho demana amb claredat.
queHacer: 2 a 4 frases, en l'idioma del correu, del que ha de fer. Cita el número de factura i el client si surten.
acciones: una entrada per document.
- tipo "abono": cal abonar una factura de venda ja emesa. factura = el número que surt al correu. cliente buit.
- tipo "factura": cal fer una factura de venda nova. Si s'ha de copiar una factura existent, posa el seu número a factura. Si el client és un altre, posa el nom a cliente.
Si no cal cap document, acciones és []. No inventis números ni clients.

Retorna NOMÉS un JSON amb aquesta forma, sense markdown:
{"recomendacion":"2 o 3 frases: què ha de contestar i per què","apoyos":["dada concreta 1"],"queHacer":"què ha de fer a Business Central","acciones":[{"tipo":"abono","factura":"P26001450","cliente":""}],"borrador":"text del correu, sense salutació final, sense nom i sense avís legal: la signatura de ${nombre} s'afegeix sola"}`;

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
    })).filter((a) => a.tipo && (a.factura || a.cliente)).slice(0, 6);
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
app.post("/api/correo/accion-bc", async (req, res) => {
  const tipo = req.body?.tipo === "factura" ? "factura" : req.body?.tipo === "abono" ? "abono" : "";
  const factura = String(req.body?.factura || "").trim();
  const clienteNombre = String(req.body?.cliente || "").trim();
  if (!tipo) return res.status(400).json({ error: "No sé si es un abono o una factura." });
  if (factura && !/^[A-Za-z0-9][A-Za-z0-9./-]{2,24}$/.test(factura)) {
    return res.status(400).json({ error: "El número de factura no es válido." });
  }
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
    if (clienteNombre) {
      const trozo = clienteNombre.replace(/'/g, "''").slice(0, 40);
      const cli = await bcPedir(`${base}/customers?$filter=${encodeURIComponent(`contains(displayName,'${trozo}')`)}&$select=number,displayName&$top=8`, token);
      if (!cli.ok) return res.status(502).json({ error: "No he podido buscar el cliente.", detalle: textoErrorBC(cli) });
      const lista = cli.json?.value || [];
      const exacto = lista.find((c) => String(c.displayName || "").toLowerCase() === clienteNombre.toLowerCase());
      const elegido = exacto || (lista.length === 1 ? lista[0] : null);
      if (!elegido) {
        const nombres = lista.map((c) => c.displayName).filter(Boolean).slice(0, 5).join(", ");
        return res.status(409).json({ error: nombres ? `Hay varios clientes parecidos a «${clienteNombre}»: ${nombres}.` : `No encuentro el cliente «${clienteNombre}» en ${EMPRESA_NOMBRE()}.` });
      }
      customerNumber = elegido.number;
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
    }
    const pagina = tipo === "abono" ? 44 : 43;
    res.json({
      ok: true,
      tipo,
      numero: doc.number || "",
      enlace: doc.number ? urlDocumentoBC(pagina, doc.number) : "",
      avisos: avisos.slice(0, 5),
    });
  } catch (err) {
    console.error("Error preparando documento de venta:", err);
    res.status(500).json({ error: "No he podido preparar el documento.", detalle: String(err.message || err) });
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
  const { para, asunto, cuerpoHtml, adjunto, incluirFirma, respuestaA } = req.body || {};
  const destinatarios = Array.isArray(para) ? para.filter(Boolean) : [];
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
      });
      if (!parche.ok) throw new Error(`Graph respondió ${parche.status} al escribir la respuesta: ${(await parche.text()).slice(0, 300)}`);
      if (firma) {
        const af = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", firma);
        if (!af.ok) console.warn("[correo/enviar] firma no adjuntada", af.status);
      }
      if (adjunto?.base64) {
        const aa = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, "POST", {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: adjunto.nombre || "adjunto.pdf",
          contentType: adjunto.mime || mimeDeNombre(adjunto.nombre) || "application/pdf",
          contentBytes: adjunto.base64,
        });
        if (!aa.ok) throw new Error(`Graph respondió ${aa.status} al adjuntar el fichero: ${(await aa.text()).slice(0, 200)}`);
      }
      const env = await graph(`${base}/messages/${encodeURIComponent(draft.id)}/send`, "POST");
      if (!env.ok) {
        const pista = env.status === 403
          ? " — falta el permiso de aplicación Mail.Send en Azure, con consentimiento de administrador."
          : "";
        throw new Error(`Graph respondió ${env.status} enviando la respuesta${pista}: ${(await env.text()).slice(0, 300)}`);
      }
      console.log(`[correo/enviar] respuesta de=${buzon} "${asunto}" → ${destinatarios.join(", ")}`);
      return res.json({ ok: true, de: buzon, para: destinatarios });
    }

    const mensaje = {
      subject: asunto,
      body: { contentType: "HTML", content: cuerpoHtml || "" },
      toRecipients: destinatarios.map((email) => ({ emailAddress: { address: email } })),
    };
    const adjuntos = [];
    if (firma) adjuntos.push(firma);
    if (adjunto?.base64) {
      adjuntos.push({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: adjunto.nombre || "adjunto.pdf",
        contentType: adjunto.mime || mimeDeNombre(adjunto.nombre) || "application/pdf",
        contentBytes: adjunto.base64,
      });
    }
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
    console.log(`[correo/enviar] de=${buzon} "${asunto}" → ${destinatarios.join(", ")}${adjunto?.base64 ? " (con adjunto)" : ""}`);
    res.json({ ok: true, de: buzon, para: destinatarios });
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
  movs_contabilidad: { entidad: "generalLedgerEntries", campoFecha: "postingDate" },
  // tarifas_venta va por FUENTES_WS: salesPrices NO existe en la API v2.0 estándar
  facturas_venta: { entidad: "salesInvoices", campoFecha: "invoiceDate" },
};

// Fuentes que van por WEB SERVICE de página (no por la API estándar).
// En este BC ya existen publicados:
//   · "SalesInvLines"  → Página 516 (Sales Lines — líneas de documentos vivos)
//   · "PurchaseLines"  → Página 518 (Purchase Lines — líneas de compra vivas)
// Nota: son líneas de documentos SIN registrar (ofertas/pedidos en curso).
// El histórico facturado vive en las páginas de registrados (526/528),
// que se pueden añadir después con el mismo mecanismo.
// El campo de fecha se detecta automáticamente entre los candidatos.
const FUENTES_WS = {
  lineas_venta: {
    servicio: process.env.BC_WS_LINEASVENTA || "SalesInvLines",
    camposFecha: [process.env.BC_WS_LINEASVENTA_FECHA, "Posting_Date", "Document_Date", "Shipment_Date", "Order_Date"].filter(Boolean),
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
      "Movs_contabilidad_Excel",
    ].filter(Boolean),
    camposFecha: [
      process.env.BC_WS_MOVSPROYECTO_FECHA,
      process.env.BC_WS_JOBLEDGER_FECHA,
      "Posting_Date",
      "Document_Date",
    ].filter(Boolean),
    permitirSinFecha: true,
    descubrir: [/job.?ledger/i, /mov.*(proyecto|ot|contab)/i],
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
        for (const campoFecha of ws.camposFecha) {
          const filtro = `${campoFecha} ge ${from} and ${campoFecha} le ${to}`;
          const url = `${base}?$filter=${encodeURIComponent(filtro)}`;
          console.log(`[${fuente}] Probando "${servicio}" · campo fecha "${campoFecha}"`);
          const r = await fetchConReintento(url, cabeceras);
          intentos.push(`${servicio} · ${campoFecha} → ${r.status}`);

          if (r.status === 404) {
            // Puede ser "servicio no publicado" O un huérfano a mitad de
            // consulta: si el mensaje delata cabecera perdida, pasamos a
            // carga completa (que sabe excluir huérfanos)
            const det = (await r.text().catch(() => "")) || "";
            if (/does not exist|Internal_RecordNotFound/i.test(det) && ws.permitirSinFecha) break;
            return "no-existe";
          }
          if (r.status === 400) continue; // el campo no existe: siguiente
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

      if (!filas && ultimoError) {
        const pistas = [];
        if (ultimoError.status === 401 || ultimoError.status === 403) pistas.push(`${ultimoError.status}: permisos insuficientes de la App en BC`);
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
//     lotes de páginas y se los pasa a Claude DIRECTAMENTE COMO PDF
//     (no como texto extraído): así funciona igual con PDFs digitales
//     que con documentos escaneados/fotocopiados, porque Claude "ve"
//     cada página como imagen además de leer el texto si lo hay.
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

// Manda un LOTE de páginas (como PDF de verdad, no texto) a Claude y
// pide un JSON con lo detectado en cada una. Funciona igual con PDFs
// digitales que escaneados, porque Claude lee el documento como imagen.
async function extraerLotePDF(bytesLotePdf, numPaginasLote) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env.");
  }
  const base64Lote = Buffer.from(bytesLotePdf).toString("base64");
  const prompt = `Eres un asistente que lee documentos de proveedores (albaranes de entrega, notas de entrega, confirmaciones de pedido) que llegan escaneados/fotocopiados o exportados a PDF, con MUCHAS páginas seguidas.

Te adjunto un PDF con ${numPaginasLote} página(s), en orden. Lee CADA página por separado. No des por hecho que dos páginas son el mismo documento.

REGLA IMPORTANTE: el mismo proveedor (mismo membrete, mismo logo, mismo nombre) envía a menudo VARIOS albaranes y VARIOS pedidos distintos, uno detrás de otro. Que el proveedor sea el mismo NO significa que sea la misma entrega. No los juntes. No copies el Nº de pedido ni el Nº de albarán de la página anterior si no están impresos en ESTA página.

Para CADA página (numeradas del 1 al ${numPaginasLote} dentro de este PDF), identifica:
1. "pagina": el número de página DENTRO DE ESTE PDF (1, 2, 3...).
2. "pedido": NUESTRO número de pedido de compra, el que esté escrito EN ESTA PÁGINA. Formato "PCNN-NNNNNN" u "OCNN-NNNNNN" (dos letras, dos dígitos de año, guion, 6 dígitos), por ejemplo "PC26-002262". Puede venir como "Su pedido", "Pedido nº", "Referencia", "PO", "Order", "Nuestra referencia", a mano o impreso. Ignora cualquier otro número que no siga ese formato. Si en esta página no aparece, pon null. NUNCA rellenes aquí el pedido de la página anterior.
3. "albaran": el número de albarán / nota de entrega / delivery note DEL PROVEEDOR escrito EN ESTA PÁGINA (su número, no el nuestro). Si esta página tiene cabecera de albarán, este campo es obligatorio: lee el número de ESTA página, aunque el proveedor sea el mismo que el anterior. Si de verdad no hay número, pon null.
4. "esContinuacion": true SOLO si esta página no tiene cabecera propia y es claramente el resto de la tabla de la página anterior (pone "continúa" o "página 2", y no hay un albarán nuevo ni un pedido nuevo). false si la página tiene su propia cabecera, su fecha, su Nº de albarán o su Nº de pedido — aunque el proveedor sea idéntico al de la página anterior. Ante la duda, pon false.
5. "lineas": cada artículo/material de la tabla de ESA página, con "descripcion" (el texto tal cual) y "cantidad" (la cantidad entregada/enviada, NO el precio ni el importe). Si no hay tabla, "lineas": [].

Responde ÚNICAMENTE con un array JSON, sin texto adicional, backticks ni explicación, un objeto por página EN EL MISMO ORDEN Y CANTIDAD que las páginas del PDF (${numPaginasLote} objetos).

Ejemplo: la página 1 y la 3 son del MISMO proveedor, pero son albaranes y pedidos distintos, así que NO se heredan. La página 2 sí es continuación de la 1:
[{"pagina":1,"pedido":"PC26-002262","albaran":"A-99321","esContinuacion":false,"lineas":[{"descripcion":"Tornillo M8 x100","cantidad":100}]},{"pagina":2,"pedido":null,"albaran":null,"esContinuacion":true,"lineas":[{"descripcion":"Tuerca M8","cantidad":100}]},{"pagina":3,"pedido":"PC26-003401","albaran":"A-99402","esContinuacion":false,"lineas":[{"descripcion":"Arandela","cantidad":50}]}]`;

  const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Lote } },
            { type: "text", text: prompt },
          ],
        },
      ],
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
    pedido: normalizarNumPedido(item.pedido),
    albaran: item.albaran ? item.albaran.toString().trim() : null,
    // false = esta página es otro documento (aunque sea el mismo proveedor).
    // null = la IA no lo ha dicho; solo entonces se puede heredar el pedido.
    esContinuacion: item.esContinuacion === true || item.esContinuacion === "true" ? true : item.esContinuacion === false || item.esContinuacion === "false" ? false : null,
    lineas: Array.isArray(item.lineas)
      ? item.lineas
          .map((l) => ({ descripcion: (l.descripcion || "").toString().trim(), cantidad: Number(l.cantidad) || 0 }))
          .filter((l) => l.descripcion)
      : [],
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
  if (albaranDistinto(d.albaran, actual.albaran)) return false;
  if (d.pedido && actual.pedido && d.pedido === actual.pedido) return true;
  if (claveAlbaran(d.albaran) && claveAlbaran(actual.albaran)) return true;
  // Sin números que confirmen que es la misma entrega: solo se hereda
  // el pedido si la página es continuación (sin cabecera propia).
  if (d.esContinuacion === true) return true;
  if (d.esContinuacion === false) return false;
  return !d.pedido && !claveAlbaran(d.albaran);
}

function agruparPorPedido(deteccionesPorPagina) {
  const grupos = [];
  let actual = null;
  for (const d of deteccionesPorPagina) {
    if (!esMismoDocumento(actual, d)) {
      if (actual) grupos.push(actual);
      actual = { pedido: d.pedido || null, albaran: d.albaran || null, paginas: [d.pagina], lineas: [...(d.lineas || [])] };
    } else {
      actual.paginas.push(d.pagina);
      if (!actual.albaran && d.albaran) actual.albaran = d.albaran;
      if (!actual.pedido && d.pedido) actual.pedido = d.pedido;
      actual.lineas.push(...(d.lineas || []));
    }
  }
  if (actual) grupos.push(actual);
  return grupos;
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
    const pendiente = mejor ? Math.max(0, (Number(mejor.quantity) || 0) - (Number(mejor.receivedQuantity) || 0)) : 0;
    return {
      descripcionAlbaran: la.descripcion,
      cantidadAlbaran: la.cantidad,
      lineaBC: mejor
        ? {
            id: mejor.id,
            codigo: mejor.lineObjectNumber || "",
            descripcion: mejor.description || "",
            cantidadPedida: Number(mejor.quantity) || 0,
            cantidadRecibida: Number(mejor.receivedQuantity) || 0,
            cantidadPendiente: pendiente,
          }
        : null,
      coincidencia: !mejor ? "sin_match" : mejorPunt >= 0.7 ? "alta" : "media",
      cantidadARegistrar: mejor ? Math.min(Number(la.cantidad) || 0, pendiente) : 0,
    };
  });
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
    const rLineas = await fetchConReintento(urlLineas, { headers: cabeceras });
    // vendorNumber: sin $select, así que si el campo existe en el
    // pedido ya viene en "cabecera" — nombre estándar de la API v2.0,
    // sin confirmar todavía contra este BC en concreto (a diferencia de
    // vendorName, que sí se usa ya en producción).
    const vendorNumber = cabecera.vendorNumber || cabecera.buyFromVendorNumber || null;
    if (!rLineas.ok) return { error: `BC respondió ${rLineas.status} obteniendo las líneas del pedido.`, purchaseOrderId: cabecera.id, vendorName: cabecera.vendorName || null, vendorNumber };
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
    return { purchaseOrderId: cabecera.id, vendorName: cabecera.vendorName || null, vendorNumber, lineasBC: lineas };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

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

    const grupos = agruparPorPedido(detecciones);

    // Por cada grupo CON pedido identificado: PDF independiente (solo
    // sus páginas del documento ORIGINAL, para previsualizar) + cruce
    // de líneas con BC.
    const gruposFinal = [];
    for (const g of grupos) {
      // Vista previa también si el albarán se ha separado pero aún no
      // tiene Nº de pedido: así se puede escribir a mano, sin haberlo
      // juntado con el pedido anterior del mismo proveedor.
      let pdfBase64 = null;
      if (g.paginas.length) {
        const nuevo = await PDFDocument.create();
        const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
        copiadas.forEach((p) => nuevo.addPage(p));
        const bytes = await nuevo.save();
        pdfBase64 = Buffer.from(bytes).toString("base64");
      }
      if (!g.pedido) {
        gruposFinal.push({ ...g, pdfBase64, lineasEmparejadas: [], lineasDisponiblesBC: [], vendorName: null, bcError: null });
        continue;
      }

      const bc = await buscarPedidoYLineasBC(g.pedido);
      const lineasEmparejadas = bc.lineasBC ? emparejarLineas(g.lineas, bc.lineasBC) : [];
      // AÑADIDO: lista de TODAS las líneas del pedido en BC (no solo la
      // emparejada), para que en pantalla se pueda elegir a mano la
      // línea correcta cuando el emparejamiento automático falla o se
      // equivoca — no depende ya de que el texto encaje solo.
      const lineasDisponiblesBC = (bc.lineasBC || []).map((lb) => ({
        id: lb.id,
        codigo: lb.lineObjectNumber || "",
        descripcion: lb.description || "",
        cantidadPedida: Number(lb.quantity) || 0,
        cantidadRecibida: Number(lb.receivedQuantity) || 0,
        cantidadPendiente: Math.max(0, (Number(lb.quantity) || 0) - (Number(lb.receivedQuantity) || 0)),
      }));

      gruposFinal.push({
        ...g,
        pdfBase64,
        vendorName: bc.vendorName || null,
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

function normalizarNumPedido(v) {
  const s = String(v || "").trim().toUpperCase();
  const m = s.match(/^(PC|OC)\s*(\d{2})\s*[-/]?\s*(\d{1,7})$/i);
  if (m) return `${m[1].toUpperCase()}${m[2]}-${String(m[3]).padStart(6, "0")}`;
  return s || null;
}

app.post("/api/recepcion/cruzar", async (req, res) => {
  const pedido = normalizarNumPedido(req.body?.pedido);
  const lineasPdf = Array.isArray(req.body?.lineasPdf) ? req.body.lineasPdf : [];
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });
  try {
    const bc = await buscarPedidoYLineasBC(pedido);
    const lineasEmparejadas = bc.lineasBC ? emparejarLineas(lineasPdf, bc.lineasBC) : [];
    const lineasDisponiblesBC = (bc.lineasBC || []).map((lb) => ({
      id: lb.id,
      codigo: lb.lineObjectNumber || "",
      descripcion: lb.description || "",
      cantidadPedida: Number(lb.quantity) || 0,
      cantidadRecibida: Number(lb.receivedQuantity) || 0,
      cantidadPendiente: Math.max(0, (Number(lb.quantity) || 0) - (Number(lb.receivedQuantity) || 0)),
    }));
    res.json({ pedido, vendorName: bc.vendorName || null, bcError: bc.error || null, lineasEmparejadas, lineasDisponiblesBC });
  } catch (err) {
    res.status(500).json({ error: "No se pudo cruzar el pedido con BC.", detalle: String(err.message || err) });
  }
});

app.post("/api/recepcion/subir-bc", async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  const { pedido, albaran, pdfBase64, nombreArchivo, lineas, nuevasLineas } = req.body || {};
  const registrar = req.body?.registrar !== false; // «Subir este pedido en BC» = subir sin registrar
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });

  const resultado = { pedido, version: "subir-bc-v6-referencia", albaran: { ok: false }, referencia: null, adjunto: { ok: false }, lineas: [] };

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

    // 2b) LÍNEAS NUEVAS (cargos/material) — se crean ANTES de registrar
    resultado.nuevasLineas = [];
    let fallaNuevaLinea = false;
    if (Array.isArray(nuevasLineas) && nuevasLineas.length) {
      if (!purchaseOrderId) {
        for (const nl of nuevasLineas) resultado.nuevasLineas.push({ codigo: nl.codigo, ok: false, error: "Pedido no localizado en purchaseOrders (api/v2.0)." });
        fallaNuevaLinea = true;
      } else {
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
              const r = await fetchConReintento(urlLineasApi, { method: "POST", headers: { ...cabeceras, "Content-Type": "application/json" }, body: JSON.stringify(body) });
              if (r.ok) { creada = await r.json(); break; }
              const txt = (await r.text().catch(() => "")).slice(0, 300);
              if (!ultimoErr) ultimoErr = `BC respondió ${r.status}: ${txt}`;
              if (!/InvalidOptionEnumValue|is not an option/i.test(txt)) break;
            }
            if (!creada) throw new Error(ultimoErr);
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

    if (!registrar) {
      resultado.registro = { ok: false, noRegistrar: true };
      return res.json(resultado);
    }

    // 4) REGISTRAR — servicio Playwright (BC_REGISTRO_URL)
    resultado.registro = { ok: false };
    if (fallaNuevaLinea) {
      resultado.registro.error = "No se ha registrado: alguna línea nueva (cargo) no se pudo crear. Corrígelo y vuelve a confirmar, o regístralo desde BC.";
      return res.json(resultado);
    }
    try {
      const rRegistro = await fetch(
        (process.env.BC_REGISTRO_URL || "http://localhost:5055").replace(/\/$/, "") + "/registrar",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(90000),
          body: JSON.stringify({ numero_pedido: pedido, empresa: EMPRESA_NOMBRE() }),
        }
      );
      const datosRegistro = await rRegistro.json().catch(() => ({}));
      if (rRegistro.ok && datosRegistro.ok) {
        resultado.registro.ok = true;
        try {
          const d = await leerRecep();
          d.registrados = d.registrados || {};
          const clave = `${pedido.toUpperCase()}|${String(albaran || "").trim().toUpperCase()}`;
          d.registrados[clave] = { ts: new Date().toISOString(), archivo: nombreArchivo || null };
          await escribirRecep(d);
        } catch (e) {
          console.warn("[subir-bc] No se pudo anotar el registro:", e.message);
        }
      } else {
        resultado.registro.error = datosRegistro.error || `El servicio de registro respondió ${rRegistro.status}.`;
      }
    } catch (e) {
      resultado.registro.error = `No se pudo contactar con el servicio de registro — ¿está arrancado 'python servicio_registro.py'? (${String(e.message || e)})`;
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
   - "pedido": NUESTRO pedido de compra SOLO si está impreso como "PCNN-NNNNNN" u "OCNN-NNNNNN" (ejemplo "PC26-002262"). Si no, null. No lo inventes.
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
        max_tokens: 4096,
        messages,
      }),
    });
    if (!response.ok) {
      const detalle = await response.text();
      throw new Error(`Anthropic respondió ${response.status}: ${detalle.slice(0, 300)}`);
    }
    const data = await response.json();
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  };

  let texto = await pedir([{ role: "user", content }]);
  let parseado = jsonDeRespuestaIA(texto);
  if (!parseado) {
    console.warn(`[facturas-compra/extraer] la IA respondió en texto, se pide el JSON otra vez: ${texto.slice(0, 180)}`);
    texto = await pedir([
      { role: "user", content },
      { role: "assistant", content: texto.slice(0, 12000) },
      { role: "user", content: "Eso no vale. Devuelve solo el array JSON con pagina, factura, proveedor, fecha, baseImponible, importeTotal y lineas. Sin explicación." },
    ]);
    parseado = jsonDeRespuestaIA(texto);
  }
  if (!parseado) {
    throw new Error(`No se pudo interpretar la respuesta de la IA para este lote: ${String(texto).replace(/```json|```/g, "").trim().slice(0, 200)}`);
  }
  return (Array.isArray(parseado) ? parseado : []).map((item) => ({
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
  return (lineasBC || []).map((lb) => ({
    id: lb.id,
    codigo: lb.lineObjectNumber || "",
    descripcion: lb.description || "",
    cantidadPedida: Number(lb.quantity) || 0,
    cantidadRecibida: Number(lb.receivedQuantity) || 0,
    precioBC: lb.directUnitCost !== undefined && lb.directUnitCost !== null ? Number(lb.directUnitCost) : null,
  }));
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
    const precioBC = mejor && mejor.directUnitCost !== undefined && mejor.directUnitCost !== null ? Number(mejor.directUnitCost) : null;
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

async function obtenerHistoricoFacturasCompra(raiz, cabeceras) {
  if (historicoFacturasCompraCache && Date.now() - historicoFacturasCompraCache.cargadoEn < HISTORICO_FACTURAS_COMPRA_TTL_MS) {
    return historicoFacturasCompraCache;
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

  return null;
}

async function facturaYaEntradaRapida(vendorInvoiceNumber) {
  const seguro = String(vendorInvoiceNumber || "").trim().replace(/'/g, "''");
  if (!seguro) return { encontrada: false };
  const token = await obtenerTokenBC();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const api = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  try {
    const r = await fetchConReintento(`${api}/purchaseInvoices?$filter=vendorInvoiceNumber eq '${seguro}'&$top=1&$select=number,vendorName,vendorInvoiceNumber`, { headers });
    if (r.ok) {
      const fila = ((await r.json()).value || [])[0];
      if (fila) return { encontrada: true, numeroBC: fila.number || null, proveedor: fila.vendorName || null };
    }
  } catch { /* se prueba el histórico publicado */ }
  const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  const servicios = ["Hist_facturas_compra_Excel", "Purchase_Invoice_Header_Excel", "Purch_Inv_Header_Excel"];
  let algunaLista = false;
  for (const servicio of servicios) {
    for (const campo of ["Vendor_Invoice_No", "Vendor_Invoice_No_"]) {
      try {
        const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${campo} eq '${seguro}'&$top=1`;
        const r = await fetchConReintento(url, { headers });
        if (!r.ok) continue;
        algunaLista = true;
        const fila = ((await r.json()).value || [])[0];
        if (fila) {
          return {
            encontrada: true,
            numeroBC: fila.No || fila.Document_No || null,
            proveedor: fila.Buy_from_Vendor_Name || fila.Vendor_Name || null,
          };
        }
      } catch { /* siguiente columna */ }
    }
  }
  return algunaLista ? { encontrada: false } : null;
}

async function facturaYaEntradaEnBC(vendorInvoiceNumber) {
  if (!vendorInvoiceNumber) return { encontrada: false };
  try {
    try {
      const rapida = await facturaYaEntradaRapida(vendorInvoiceNumber);
      if (rapida) return rapida;
    } catch (e) {
      console.warn("[facturas-compra/duplicados] Consulta directa falló, se mira el histórico:", String(e.message || e));
    }

    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const cabeceras = { headers: { Authorization: `Bearer ${token}` } };

    const historico = await obtenerHistoricoFacturasCompra(raiz, cabeceras);
    if (!historico) return { encontrada: false };

    const objetivo = vendorInvoiceNumber.toString().trim().toUpperCase();
    const fila = historico.filas.find((f) => (f[historico.campoFactura] || "").toString().trim().toUpperCase() === objetivo);
    if (!fila) return { encontrada: false };

    return {
      encontrada: true,
      numeroBC: historico.campoNumero ? fila[historico.campoNumero] : null,
      proveedor: historico.campoProveedor ? fila[historico.campoProveedor] : null,
    };
  } catch (e) {
    console.warn("[facturas-compra/duplicados] Error comprobando duplicado:", String(e.message || e));
    return { encontrada: false };
  }
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
  const r = await fetchConReintento(`${urlBase}/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${pedido.id}`)}`, { headers });
  if (!r.ok) {
    avisos.push(`No se pudieron leer las líneas para poner la OT: BC ${r.status}`);
    return { ...pedido, avisos, otEnLinea: false };
  }
  const lineas = ((await r.json()).value || []).filter((l) => l.lineType && !/comment/i.test(l.lineType));
  if (!lineas.length) {
    avisos.push("El pedido no tiene líneas donde poner la OT.");
    return { ...pedido, avisos, otEnLinea: false };
  }
  let puestas = 0;
  for (const l of lineas) {
    const aviso = await ponerOtEnLineaApi(l.id, { ot, depto }, token);
    if (aviso) avisos.push(aviso);
    else puestas += 1;
  }
  return { ...pedido, avisos, otEnLinea: puestas === lineas.length };
}

async function crearPedidoComoUltima(datos) {
  const proveedor = String(datos?.proveedor || "").trim();
  if (!proveedor) throw new Error("Falta el proveedor.");
  const propuesta = await proponerUltimaEntrada(proveedor);
  if (!propuesta?.puedeCrear) throw new Error(propuesta?.resumen || "No hay una factura anterior de este proveedor para copiar el pedido.");
  const vendorNumber = propuesta.vendorNumber || await buscarNumeroProveedor(propuesta.proveedorBC || proveedor);
  if (!vendorNumber) throw new Error(`No encuentro el nº de proveedor de ${propuesta.proveedorBC || proveedor} en BC.`);
  const lineas = lineasPedidoComoUltima(datos, propuesta);
  if (!lineas.length) throw new Error("No hay líneas para crear el pedido.");
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
  for (const l of lineas) {
    const body = {
      documentId: cab.id,
      lineType: l.lineType,
      lineObjectNumber: l.codigoBC,
      quantity: Number(l.cantidad) || 1,
      description: l.descripcion || undefined,
    };
    if (l.precio != null && !Number.isNaN(Number(l.precio))) body.directUnitCost = Number(l.precio);
    const rLinea = await fetchConReintento(`${urlBase}/purchaseOrderLines`, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify(body),
    });
    if (!rLinea.ok) {
      avisos.push(`Línea ${l.codigoBC}: BC ${rLinea.status} ${(await rLinea.text().catch(() => "")).slice(0, 180)}`);
      continue;
    }
    const creada = await rLinea.json();
    lineasCreadas.push(l.descripcion || l.codigoBC);
    if (l.ot || l.depto) {
      const avisoDim = await ponerOtEnLineaApi(creada.id, l, token);
      if (avisoDim) avisos.push(avisoDim);
    }
  }
  return {
    numero: cab.number,
    id: cab.id,
    enlace: enlacePedidoCompraBC(cab.number),
    vendorName: propuesta.proveedorBC,
    lineasCreadas,
    avisos,
    plantilla: {
      numeroBC: propuesta.numeroBC,
      facturaProveedor: propuesta.facturaProveedor,
      fecha: propuesta.fecha,
      cuenta: propuesta.cuenta,
      ot: propuesta.ot,
      departamento: propuesta.departamento,
      lineType: propuesta.lineType,
    },
  };
}

function urlApiComprasBC() {
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
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

async function accionPedidoCompra(idPedido, accion, token) {
  const r = await fetchConReintento(`${urlApiComprasBC()}/purchaseOrders(${idPedido})/Microsoft.NAV.${accion}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": "*" },
    body: "{}",
  });
  const texto = r.ok ? "" : (await r.text().catch(() => "")).slice(0, 400);
  return { ok: r.ok, status: r.status, texto };
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
  let recibo = await accionPedidoCompra(id, "receive", token);
  if (!recibo.ok && /release|liberar|lanzad/i.test(recibo.texto)) {
    await accionPedidoCompra(id, "release", token);
    recibo = await accionPedidoCompra(id, "receive", token);
  }
  if (recibo.ok) return { ok: true };
  const accionNoExiste = recibo.status === 404 || /No HTTP resource|does not support|Resource not found|BadRequest_ResourceNotFound/i.test(recibo.texto);
  if (accionNoExiste) return registrarPedidoPorServicio(pedido.numero);
  return { ok: false, error: `BC no registró el pedido: ${recibo.status} ${recibo.texto}`.trim() };
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

// Si la factura no trae pedido, se crea uno igual que la última factura
// de ese proveedor. Una sola vez: si ya se anotó, se devuelve el mismo.
app.post("/api/facturas-compra/crear-pedido", async (req, res) => {
  const datos = req.body || {};
  const clave = `${String(datos.proveedor || "").trim()}|${String(datos.factura || "").trim()}|${datos.msg || ""}|${datos.att || ""}`;
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
    const ya = await pedidoYaAnotado(datos);
    let pedido = ya || await crearPedidoComoUltima(datos);
    if (!ya) await anotarPedidoCreado(datos, pedido);
    if (pedido.plantilla?.ot || pedido.plantilla?.departamento) {
      pedido = await aplicarOtAlPedido(pedido);
      await anotarPedidoCreado(datos, pedido);
    }
    if (!pedido.registro?.ok) {
      pedido = {
        ...pedido,
        registro: pedido.lineasCreadas?.length
          ? await registrarPedidoCompra(pedido)
          : { ok: false, error: "No se registra: no se creó ninguna línea del pedido." },
      };
      await anotarPedidoCreado(datos, pedido);
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
    const chequeo = await facturaYaEntradaEnBC(factura);
    res.json(chequeo);
  } catch (err) {
    res.status(500).json({ error: "No se ha podido comprobar si la factura ya está entrada.", detalle: String(err.message || err) });
  }
});

app.post("/api/facturas-compra/ultima-entrada", async (req, res) => {
  try {
    const proveedor = String(req.body?.proveedor || "").trim();
    if (!proveedor) return res.status(400).json({ error: "Falta el proveedor." });
    const ultimaEntrada = await proponerUltimaEntrada(proveedor);
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

async function extraerFacturaHttp(req, res) {
  if (req.body?.fondo && req.body?.origen?.msg) {
    const clave = `${req.body.origen.msg}|${req.body.origen.att ?? ""}`;
    const actual = lecturasFondo.get(clave);
    if (actual?.estado === "leyendo") return res.json({ estado: "leyendo" });
    if (actual?.estado === "lista") return res.json({ estado: "lista", paginas: actual.paginas, facturas: actual.facturas });
    lecturasFondo.set(clave, { estado: "leyendo" });
    const cuerpo = { ...req.body, fondo: false };
    extraerFacturaHttp({ body: cuerpo }, {
      _code: 200,
      status(code) { this._code = code; return this; },
      json(obj) {
        if ((this._code || 200) >= 400) lecturasFondo.set(clave, { estado: "error", error: obj.detalle || obj.error || "No se ha podido leer la factura" });
        else lecturasFondo.set(clave, { estado: "lista", paginas: obj.paginas, facturas: obj.facturas });
      },
    }).catch((err) => {
      lecturasFondo.set(clave, { estado: "error", error: String(err.message || err) });
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

    const LOTE = 8;
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
      if (!g.factura || !g.paginas.length) {
        let pdfBase64 = null;
        if (g.paginas?.length) {
          const nuevo = await PDFDocument.create();
          const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
          copiadas.forEach((p) => nuevo.addPage(p));
          pdfBase64 = Buffer.from(await nuevo.save()).toString("base64");
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
      const bytes = await nuevo.save();
      const pdfBase64 = Buffer.from(bytes).toString("base64");

      // Antes de analizar pedidos o proponer cómo entrarla: si este nº de
      // factura ya está registrado en BC, se para aquí.
      const chequeoDuplicado = await facturaYaEntradaEnBC(g.factura);
      if (chequeoDuplicado.encontrada) {
        const motivosDup = [
          `⚠ Esta factura ya está entrada en BC (factura ${chequeoDuplicado.numeroBC || "?"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""}). No se analiza ni se crea borrador.`,
        ];
        facturasFinal.push({
          ...g,
          pdfBase64,
          pedidosDetalle: [],
          lineasSinPedido: [],
          veredicto: "ya_entrada",
          motivos: motivosDup,
          gastoSugerido: null,
          ultimaEntrada: null,
          yaEntrada: true,
          entradaInfo: chequeoDuplicado,
        });
        await registrarFacturaValidada({
          factura: g.factura,
          fechaFactura: g.fecha || null,
          proveedores: g.proveedor ? [g.proveedor] : [],
          pedidos: [],
          veredicto: "ya_entrada",
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
        pedidosDetalle.push({
          pedido,
          vendorName: bc.vendorName || null,
          bcError: null,
          lineas: lineasEmparejadas,
          lineasDisponiblesBC,
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

      const hayPedidoUtil = pedidosDetalle.some((p) => p.pedido && !p.bcError);
      let ultimaEntrada = null;
      if (!hayPedidoUtil && g.proveedor) {
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
  if (bc.error) return res.json({ pedido, bcError: bc.error, vendorName: null, lineasDisponiblesBC: [], enlaceBC: enlacePedidoCompraBC(pedido) });
  res.json({
    pedido,
    bcError: null,
    vendorName: bc.vendorName || null,
    lineasDisponiblesBC: lineasDisponiblesDesdeBC(bc.lineasBC),
    enlaceBC: enlacePedidoCompraBC(pedido),
  });
});

// -----------------------------------------------------------------------
// ENTRAR FACTURA EN BC (borrador, SIN contabilizar) — un clic desde
// "Validación de facturas" cuando el semáforo ya salió verde.
//
// A propósito, esto SOLO crea la CABECERA de la factura de compra en BC
// (proveedor, nº de factura del proveedor, fecha de la factura) — NO crea
// líneas. Al probarlo contra el BC real, crear las líneas a mano (sin
// usar el botón nativo de BC "Obtener albaranes de compra") daba
// problemas (tipos de línea, "Item does not exist"...) y quedaba una
// factura con datos que no venían realmente de vincular el pedido. Así
// que ahora se deja la cabecera lista y es la propia persona quien, ya
// en BC, usa "Obtener albaranes de compra"/"Obtener líneas de pedido"
// para traer las líneas del pedido de la forma nativa y correcta.
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
    // "lineas" es el resumen de lo ya validado (para mostrar en pantalla)
    // Y ADEMÁS (Maria, 2026-09-04: "podrias intentar traer los albaranes
    // tu automaticamente?") se usa más abajo para crear directamente las
    // líneas de la factura en BC, en vez de dejarlas vacías para que
    // Maria las traiga a mano con "Línea → Acciones → Traer albaranes de
    // Compra". OJO: esto NO es exactamente lo mismo que "Traer albaranes"
    // — esa acción de BC enlaza con el ALBARÁN recibido (nº de
    // recepción), mientras que aquí se crea la línea directamente desde
    // los datos ya emparejados del PEDIDO (mismo artículo/cargo,
    // cantidad y precio facturados). Para lo que hace falta aquí — dejar
    // el borrador listo para que Maria solo revise y registre — el
    // resultado en pantalla es el mismo; la diferencia de trazabilidad
    // interna de BC no afecta porque nunca se contabiliza (post) desde
    // aquí. Se ha buscado también si la API estándar expone una acción
    // equivalente a "Traer albaranes de Compra" (bound action, vía
    // /api/bc/diag/metadata-api?entidad=purchaseInvoice) — si aparece
    // una en el futuro, sería preferible a esto por mantener el enlace
    // con el albarán.
    const item = { vendorNumber, vendorName: grupo.vendorName, pedidos: grupo.pedidos, ok: false, lineas: grupo.lineas };
    try {
      const rCab = await fetchConReintento(`${urlBase}/purchaseInvoices`, {
        method: "POST",
        headers: cabeceras,
        body: JSON.stringify({
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

      // "Traer albaranes automáticamente" (Maria, 2026-09-04): crear ya
      // las líneas de la factura a partir de las líneas del PEDIDO ya
      // emparejadas, en vez de dejarlas vacías. Solo para líneas con un
      // match de confianza (alta/media/manual) y con el código+tipo de
      // BC identificados — las "sin_match" se dejan para que Maria las
      // añada a mano, igual que hoy. Por línea, con try/catch propio,
      // para que si una falla no se pierdan las demás ni se marque toda
      // la factura como error (ya hay "ok" a nivel de cabecera para eso).
      item.lineasCreadas = [];
      item.lineasSinCrear = [];
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
            bodyLinea.directUnitCost = Number(l.precio);
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
          `Factura ${item.vendorName || vendorNumber}: ${item.lineasCreadas.length} línea(s) creada(s) automáticamente en BC, pero ${item.lineasSinCrear.length} no se pudieron crear solas — añádelas a mano en BC (Línea → Acciones → Traer albaranes de Compra, o directamente): ${item.lineasSinCrear.join(" · ")}`
        );
      }

      // Adjuntar el PDF de la factura — mismo mecanismo YA confirmado
      // funcionando para pedidos de compra (attachments, parentType),
      // ahora con parentType "Purchase Invoice". Igual que allí, se
      // prueban los dos órdenes posibles (contenido primero / metadatos
      // primero): en la primera prueba real, el orden "contenido
      // primero" falló con el error de BC "Read called with an open
      // stream or text reader" — el mismo motivo por el que el código de
      // pedidos ya tenía este mismo resguardo con dos intentos.
      if (pdfBase64) {
        const contenidoBinario = Buffer.from(pdfBase64, "base64");
        const urlColeccion = `${urlBase}/attachments`;
        const intentosAdjunto = [];
        item.adjunto = { ok: false };

        // --- Intento A: contenido primero, enlazar después ---
        try {
          const rCrearA = await fetchConReintento(urlColeccion, {
            method: "POST",
            headers: cabeceras,
            body: JSON.stringify({
              fileName: nombreArchivo || `${factura}.pdf`,
              byteSize: contenidoBinario.length,
              attachmentContent: pdfBase64,
            }),
          });
          if (rCrearA.ok) {
            const creadoA = await rCrearA.json();
            const etagA = creadoA["@odata.etag"] || "*";
            const rEnlazarA = await fetchConReintento(`${urlColeccion}(${creadoA.id})`, {
              method: "PATCH",
              headers: { ...cabeceras, "If-Match": etagA },
              body: JSON.stringify({ parentType: "Purchase Invoice", parentId: cab.id }),
            });
            if (rEnlazarA.ok) item.adjunto.ok = true;
            else intentosAdjunto.push(`A (enlazar) → ${rEnlazarA.status}: ${(await rEnlazarA.text().catch(() => "")).slice(0, 200)}`);
          } else {
            intentosAdjunto.push(`A (crear con contenido) → ${rCrearA.status}: ${(await rCrearA.text().catch(() => "")).slice(0, 200)}`);
          }
        } catch (e) {
          intentosAdjunto.push(`A → excepción: ${String(e.message || e)}`);
        }

        // --- Intento B: metadatos primero, contenido después ---
        if (!item.adjunto.ok) {
          try {
            const rCrearB = await fetchConReintento(urlColeccion, {
              method: "POST",
              headers: cabeceras,
              body: JSON.stringify({
                fileName: nombreArchivo || `${factura}.pdf`,
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
              if (rContenidoB.ok) item.adjunto.ok = true;
              else intentosAdjunto.push(`B (contenido) → ${rContenidoB.status}: ${(await rContenidoB.text().catch(() => "")).slice(0, 200)}`);
            } else {
              intentosAdjunto.push(`B (crear con enlace) → ${rCrearB.status}: ${(await rCrearB.text().catch(() => "")).slice(0, 200)}`);
            }
          } catch (e) {
            intentosAdjunto.push(`B → excepción: ${String(e.message || e)}`);
          }
        }

        if (!item.adjunto.ok) {
          item.adjunto.error = `Ningún orden funcionó. Detalle de los intentos: ${intentosAdjunto.join(" · ")}`;
        }
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
  for (const it of d.items) {
    const vinculadas = it.facturas || [];
    const esLaFactura = it.factura === num;
    const estabaVinculada = vinculadas.includes(num);
    if (esLaFactura) {
      try { fsEstado.unlinkSync(path.join(dirPdfPendientes(), it.archivo)); } catch {}
      if (!(d.registradas || []).includes(`fac:${num}`)) d.registradas = [`fac:${num}`, ...(d.registradas || [])];
      continue;
    }
    if (estabaVinculada) {
      const facturas = vinculadas.filter((f) => f !== num);
      if (!facturas.length) {
        try { fsEstado.unlinkSync(path.join(dirPdfPendientes(), it.archivo)); } catch {}
        if (it.msg && it.att) {
          const clave = `mail:${it.msg}|${it.att}`;
          if (!(d.registradas || []).includes(clave)) d.registradas = [clave, ...(d.registradas || [])];
        }
        continue;
      }
      quedan.push({ ...it, facturas });
      continue;
    }
    quedan.push(it);
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

function decorarItemsBandeja(items, procesadas) {
  return items.map((it) => ({
    ...it,
    procesada: procesadas[`${it.msg}|${it.att}`] || null,
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

app.get("/api/facturas-compra/bandeja", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  const buzon = M365_BUZONES.facturas;
  const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90);
  try {
    const vista = await leerVistaBandeja();
    const procesadas = await leerBandejaProc();
    // cache=1: la pantalla pinta al momento lo ya leído, sin tocar Outlook.
    if (req.query.cache === "1") {
      return res.json({
        buzon, dias, empresaActual: EMPRESA_ID(),
        actualizadoEn: vista.actualizadoEn,
        desdeCache: true, nuevos: 0,
        items: decorarItemsBandeja(vista.items, procesadas),
      });
    }

    const empresas = await empresasApp().catch(() => [{ id: process.env.BC_COMPANY_ID, nombre: process.env.BC_COMPANY_NAME, cif: "B43831593", porDefecto: true }]);
    const token = await obtenerTokenGraph();
    const headers = { Authorization: `Bearer ${token}` };
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/inbox/messages`;
    // desde = última actualización: solo correos nuevos. Sin desde, la
    // primera vez trae la ventana de días. hasta = relleno hacia atrás.
    let desdeFiltro;
    if (req.query.desde) {
      const t = new Date(req.query.desde);
      if (Number.isNaN(t.getTime())) return res.status(400).json({ error: "Fecha 'desde' no válida." });
      t.setTime(t.getTime() - 2 * 60 * 1000);
      desdeFiltro = t.toISOString().slice(0, 19) + "Z";
    } else {
      desdeFiltro = inicioVentanaMadrid(dias).toISOString().slice(0, 19) + "Z";
    }
    let filtro = `receivedDateTime ge ${desdeFiltro}`;
    const hasta = req.query.hasta ? new Date(req.query.hasta) : null;
    if (hasta && !Number.isNaN(hasta.getTime())) filtro += ` and receivedDateTime lt ${hasta.toISOString().slice(0, 19)}Z`;
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
      .map(({ procesada, pdfGuardado, ...rest }) => rest);
    const esAtras = !!(hasta && !Number.isNaN(hasta.getTime()));
    const actualizadoEn = esAtras ? (vista.actualizadoEn || new Date().toISOString()) : new Date().toISOString();
    await db.setDoc(CLAVE_VISTA_BANDEJA, { actualizadoEn, items: fusion });
    try {
      if (aGuardar.length) await guardarPdfsPendientes(aGuardar);
    } catch (e) {
      console.warn("[facturas-pdf] No se pudieron guardar los PDF de la bandeja:", String(e.message || e));
    }
    res.json({
      buzon, dias, empresaActual: EMPRESA_ID(),
      actualizadoEn, desdeCache: false, nuevos: nuevos.length,
      items: decorarItemsBandeja(fusion, procesadas),
    });
  } catch (err) {
    console.error("Error /api/facturas-compra/bandeja:", err);
    res.status(500).json({ error: "No se pudo leer el buzón de facturas.", detalle: String(err.message || err) });
  }
});

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
    for (const it of indice.items) {
      if (!it.extraida) continue;
      // Las lecturas guardadas con el nombre cortado repetían el primer PDF.
      if (!/-[a-f0-9]{32}$/.test(String(it.id || ""))) continue;
      if (it.empresaId && it.empresaId !== empresa) continue;
      const bytes = leerBytesPdfPendiente(it);
      if (!bytes) continue;
      facturas.push({
        ...it.extraida,
        pdfBase64: bytes.toString("base64"),
        pdfGuardado: true,
        origen: it.msg ? { msg: it.msg, att: it.att } : null,
      });
    }
    facturas.sort((a, b) => String(b.factura || "").localeCompare(String(a.factura || "")));
    res.json({ facturas });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron leer las facturas guardadas.", detalle: String(err.message || err) });
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
require("./contabilidad.cjs")({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, EMPRESA_NOMBRE });
require("./macro.cjs")({ app, fetchConReintento, db });
const BUZON_PERSONAL = () => process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com";
require("./correoPC.cjs")({ app, obtenerTokenGraph, fetchConReintento, leerRecep, escribirRecep, BUZON_PERSONAL });
require("./pedidosVentaSeguimiento.cjs")({ app, db, claveEmpresa, obtenerTokenGraph, fetchConReintento, BUZON_PERSONAL });
require("./horas.cjs")({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE, db, claveEmpresa });

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
