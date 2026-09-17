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
app.use(express.static(path.join(__dirname, "public"))); // frontend compilado (build)

const PORT = process.env.PORT || 3000;

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
// 0a-bis) RECEPCIÓN — marcas de "revisado" y fechas editadas, COMPARTIDAS
// ---------------------------------------------------------------------
//   { revisados: { "PC26-002305": { ts: "2026-..." }, ... },
//     fechas:    { "PC26-002305": "2026-08-30", ... } }
// ---------------------------------------------------------------------
app.get("/api/recepcion", async (req, res) => {
  try {
    res.json(await db.getDoc("recepcion", { revisados: {}, fechas: {} }));
  } catch (err) {
    console.error("Error leyendo recepción:", err);
    res.status(500).json({ error: "No se pudo leer la recepción." });
  }
});

app.post("/api/recepcion", async (req, res) => {
  try {
    const actual = await db.getDoc("recepcion", { revisados: {}, fechas: {} });
    const body = req.body || {};
    const combinado = {
      revisados: { ...(actual.revisados || {}), ...(body.revisados || {}) },
      fechas: { ...(actual.fechas || {}), ...(body.fechas || {}) },
    };
    for (const k in body.revisados || {}) if (body.revisados[k] === null) delete combinado.revisados[k];
    for (const k in body.fechas || {}) if (body.fechas[k] === null) delete combinado.fechas[k];
    await db.setDoc("recepcion", combinado);
    res.json({ guardado: true });
  } catch (err) {
    console.error("Error guardando recepción:", err);
    res.status(500).json({ error: "No se pudo guardar la recepción." });
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

Retorna NOMÉS el text del correu de resposta (sense assumpte, sense explicacions, sense cometes). Signa com a Maria Rufí.`;
    } else {
      prompt = `Ets l'assistent de redacció de correus de Maria Rufí, de l'empresa ALSO CASALS INSTAL·LACIONS.
Redacta un correu NOU. Escriu en ${idiomaTxt}. To: ${tonoTxt}.
Indicacions de la Maria sobre què vol dir: ${instrucciones || "(cap indicació concreta)"}

Retorna NOMÉS el text del correu (sense assumpte tret que sigui imprescindible, sense explicacions, sense cometes). Signa com a Maria Rufí.`;
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

// ---------------------------------------------------------------------
// 0a-quinquies) BANDEJA DE CORREO (Fase A: leer) — cuenta de Maria
// ---------------------------------------------------------------------
// Lista la bandeja de entrada y devuelve el cuerpo de un correo concreto.
// Usa el mismo token de aplicación de Graph (obtenerTokenGraph).
// Requiere en Azure: Mail.Read o Mail.ReadWrite (Aplicación) + consent.
// Buzón configurable con M365_BUZON_PERSONAL (por defecto Maria).
// ---------------------------------------------------------------------
const BUZON_PERSONAL = () => process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com";

app.get("/api/buzon/mensajes", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  const carpeta = req.query.carpeta === "enviados" ? "sentitems" : "inbox";
  const top = Math.min(Number(req.query.top || 40), 100);
  const buscar = (req.query.q || "").toString().trim();
  try {
    const token = await obtenerTokenGraph();
    const buzon = BUZON_PERSONAL();
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/mailFolders/${carpeta}/messages`;
    const sel = "$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview";
    let url = `${base}?${sel}&$top=${top}&$orderby=receivedDateTime desc`;
    if (buscar) url = `${base}?${sel}&$top=${top}&$search="${encodeURIComponent(buscar)}"`;
    const r = await fetchConReintento(url, {
      headers: { Authorization: `Bearer ${token}`, ...(buscar ? { ConsistencyLevel: "eventual" } : {}) },
    });
    if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${await r.text()}`);
    const mensajes = (await r.json()).value || [];
    res.json({
      buzon, carpeta,
      mensajes: mensajes.map((m) => ({
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
    const token = await obtenerTokenGraph();
    const buzon = BUZON_PERSONAL();
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

// ---------------------------------------------------------------------
// 0a-quater-bis) ENVIAR CORREO (con adjunto opcional) — cuenta de Maria
// ---------------------------------------------------------------------
// Envío REAL vía Graph (no mailto: — un mailto no puede llevar adjunto).
// Se envía "como" el buzón de M365_BUZON_PERSONAL (por defecto Maria).
// Requiere en Azure: permiso de APLICACIÓN "Mail.Send" + consentimiento
// de administrador (además del Mail.Read que ya se usa para leer la
// bandeja) — si no está concedido, Graph responde 403 y este endpoint
// lo devuelve tal cual para poder identificarlo.
// ---------------------------------------------------------------------
app.post("/api/correo/enviar", async (req, res) => {
  if (!process.env.M365_CLIENT_SECRET) {
    return res.status(503).json({ error: "Falta configurar M365_* en .env." });
  }
  const { para, asunto, cuerpoHtml, adjunto } = req.body || {};
  const destinatarios = Array.isArray(para) ? para.filter(Boolean) : [];
  if (!destinatarios.length) return res.status(400).json({ error: "Falta al menos un destinatario en 'para'." });
  if (!asunto) return res.status(400).json({ error: "Falta 'asunto'." });

  try {
    const token = await obtenerTokenGraph();
    const buzon = BUZON_PERSONAL();
    const mensaje = {
      subject: asunto,
      body: { contentType: "HTML", content: cuerpoHtml || "" },
      toRecipients: destinatarios.map((email) => ({ emailAddress: { address: email } })),
    };
    if (adjunto?.base64) {
      mensaje.attachments = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: adjunto.nombre || "factura.pdf",
          contentType: "application/pdf",
          contentBytes: adjunto.base64,
        },
      ];
    }
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/sendMail`;
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
    console.log(`[correo/enviar] "${asunto}" → ${destinatarios.join(", ")}${adjunto?.base64 ? " (con adjunto)" : ""}`);
    res.json({ ok: true, para: destinatarios });
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
    res.json(await db.getDoc("avisos", { enviados: {} }));
  } catch (err) {
    console.error("Error leyendo avisos:", err);
    res.status(500).json({ error: "No se pudo leer los avisos." });
  }
});

app.post("/api/avisos", async (req, res) => {
  try {
    const actual = await db.getDoc("avisos", { enviados: {} });
    const body = req.body || {};
    const combinado = { enviados: { ...(actual.enviados || {}), ...(body.enviados || {}) } };
    for (const k in body.enviados || {}) if (body.enviados[k] === null) delete combinado.enviados[k];
    await db.setDoc("avisos", combinado);
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
  const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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
  tarifas_venta: { entidad: "salesPrices", campoFecha: "startingDate" },
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
};

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
  res.json({ version: "2026-09-02-integra-servicio-registro" });
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
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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
      const urlStd = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${process.env.BC_COMPANY_ID})/projects`;
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
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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

app.get("/api/bc/:fuente", async (req, res) => {
  const { fuente } = req.params;
  const { from, to } = req.query;

  // ¿Va por web service de página? (líneas de venta/compra)
  const ws = FUENTES_WS[fuente];
  if (ws) {
    if (!from || !to) return res.status(400).json({ error: "Faltan parámetros from/to (YYYY-MM-DD)." });
    try {
      const token = await obtenerTokenBC();
      const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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

      // 2) AUTO-DESCUBRIMIENTO: si nada cargó, preguntar a BC el catálogo
      //    de servicios y buscar los que encajen con esta fuente.
      if (!filas && ws.descubrir) {
        try {
          console.log(`[${fuente}] Ningún candidato funcionó: consultando el catálogo de servicios de BC...`);
          const rCat = await fetchConReintento(raiz, cabeceras);
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
    let url = `${base}/companies(${process.env.BC_COMPANY_ID})/${config.entidad}?$filter=${encodeURIComponent(filtro)}`;

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
//     material (descripción + cantidad). Agrupa páginas consecutivas
//     del mismo pedido (una entrega puede ocupar varias páginas). Las
//     páginas donde NO se reconoce ningún pedido se agrupan aparte, al
//     final, para revisión manual.
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
//       1. Actualiza "Nº albarán proveedor" del pedido.
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
  const prompt = `Eres un asistente que lee documentos de proveedores (albaranes de entrega, notas de entrega, confirmaciones de pedido) que llegan escaneados/fotocopiados o exportados a PDF, con MUCHAS páginas y MUCHOS proveedores distintos seguidos.

Te adjunto un PDF con ${numPaginasLote} página(s), en orden.

Para CADA página del PDF adjunto (numeradas del 1 al ${numPaginasLote} dentro de este PDF), identifica:
1. "pagina": el número de página DENTRO DE ESTE PDF (1, 2, 3...).
2. "pedido": NUESTRO número de pedido de compra. SIEMPRE tiene el formato "PCNN-NNNNNN" u "OCNN-NNNNNN" (dos letras, dos dígitos de año, guion, 6 dígitos), por ejemplo "PC26-002262". Puede venir con etiquetas como "Su pedido", "Pedido nº", "Referencia", "PO", "Order", "Nuestra referencia", etc., o sin etiqueta, escrito a mano o impreso. Ignora cualquier otro número que no siga ese formato.
3. "albaran": el número de albarán / nota de entrega / delivery note DEL PROVEEDOR (su propio número, no el nuestro).
4. "lineas": un array con cada artículo/material de la tabla de esa página, con "descripcion" (el texto tal cual aparece) y "cantidad" (número — la cantidad entregada/enviada, NO el precio ni el importe). Si esa página no tiene tabla de artículos, deja "lineas": [].

Si una página es continuación de la anterior (no repite el nº de pedido porque es la misma entrega), pon "pedido": null — se heredará de la página anterior — pero SÍ incluye las "lineas" que veas en esa página de continuación. Si una página no tiene relación con ningún pedido reconocible, pon "pedido": null, "albaran": null y "lineas": [].

Responde ÚNICAMENTE con un array JSON, sin texto adicional, backticks ni explicación, un objeto por página EN EL MISMO ORDEN Y CANTIDAD que las páginas del PDF (${numPaginasLote} objetos):
[{"pagina":1,"pedido":"PC26-002262","albaran":"A-99321","lineas":[{"descripcion":"Tornillo M8 x100","cantidad":100}]}, {"pagina":2,"pedido":null,"albaran":null,"lineas":[]}]`;

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
    pedido: item.pedido ? item.pedido.toString().trim().toUpperCase() : null,
    albaran: item.albaran ? item.albaran.toString().trim() : null,
    lineas: Array.isArray(item.lineas)
      ? item.lineas
          .map((l) => ({ descripcion: (l.descripcion || "").toString().trim(), cantidad: Number(l.cantidad) || 0 }))
          .filter((l) => l.descripcion)
      : [],
  }));
}

// Agrupa páginas consecutivas del mismo pedido (una entrega puede
// ocupar varias páginas; las de continuación no repiten el nº de
// pedido, pero sí pueden traer más líneas de material).
function agruparPorPedido(deteccionesPorPagina) {
  const grupos = [];
  let actual = null;
  for (const d of deteccionesPorPagina) {
    if (d.pedido && (!actual || d.pedido !== actual.pedido)) {
      if (actual) grupos.push(actual);
      actual = { pedido: d.pedido, albaran: d.albaran || null, paginas: [d.pagina], lineas: [...d.lineas] };
    } else if (actual) {
      actual.paginas.push(d.pagina);
      if (!actual.albaran && d.albaran) actual.albaran = d.albaran;
      actual.lineas.push(...d.lineas);
    } else {
      // páginas iniciales sin ningún pedido detectado todavía: grupo "sin identificar"
      if (!grupos.length || grupos[grupos.length - 1].pedido) grupos.push({ pedido: null, albaran: d.albaran || null, paginas: [], lineas: [] });
      const g = grupos[grupos.length - 1];
      g.paginas.push(d.pagina);
      g.lineas.push(...d.lineas);
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
    const urlBusca = `${base}/companies(${process.env.BC_COMPANY_ID})/purchaseOrders?$filter=${encodeURIComponent(`number eq '${pedido.replace(/'/g, "''")}'`)}`;
    const rBusca = await fetchConReintento(urlBusca, { headers: cabeceras });
    if (!rBusca.ok) return { error: `BC respondió ${rBusca.status} buscando el pedido en purchaseOrders.` };
    const datosBusca = await rBusca.json();
    const cabecera = (datosBusca.value || [])[0];
    if (!cabecera) return { error: `Pedido "${pedido}" no encontrado en purchaseOrders (api/v2.0).` };

    const urlLineas = `${base}/companies(${process.env.BC_COMPANY_ID})/purchaseOrderLines?$filter=${encodeURIComponent(`documentId eq ${cabecera.id}`)}`;
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
      if (!g.pedido || !g.paginas.length) {
        gruposFinal.push({ ...g, pdfBase64: null, lineasEmparejadas: [], lineasDisponiblesBC: [], vendorName: null, bcError: null });
        continue;
      }
      const nuevo = await PDFDocument.create();
      const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
      copiadas.forEach((p) => nuevo.addPage(p));
      const bytes = await nuevo.save();
      const pdfBase64 = Buffer.from(bytes).toString("base64");

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

app.post("/api/recepcion/subir-bc", async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  const { pedido, albaran, pdfBase64, nombreArchivo, lineas } = req.body || {};
  if (!pedido) return res.status(400).json({ error: "Falta el Nº de pedido." });

  const resultado = { pedido, version: "subir-bc-v4-con-registro", albaran: { ok: false }, adjunto: { ok: false }, lineas: [] };

  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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
        for (const clave of candidatosClave) {
          const urlRegistro = `${raizWS}/${encodeURIComponent(servicioPedidos)}${clave}`;
          const rGet = await fetchConReintento(urlRegistro, { headers: cabeceras });
          intentos.push(`${clave} → GET ${rGet.status}`);
          if (!rGet.ok) continue;

          const registro = await rGet.json();
          const etag = registro["@odata.etag"] || "*";
          const rPatch = await fetchConReintento(urlRegistro, {
            method: "PATCH",
            headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": etag },
            body: JSON.stringify({ Vendor_Shipment_No: albaran }),
          });
          intentos.push(`${clave} → PATCH ${rPatch.status}`);
          if (rPatch.ok) {
            resultado.albaran.ok = true;
            hecho = true;
          } else {
            resultado.albaran.error = `BC respondió ${rPatch.status} al actualizar el albarán: ${(await rPatch.text().catch(() => "")).slice(0, 300)}`;
          }
          break; // el registro SÍ se encontró con esta clave — no seguir probando otras
        }
        if (!hecho && !resultado.albaran.error) {
          resultado.albaran.error = `Pedido "${pedido}" no encontrado en "${servicioPedidos}" con ninguna de las claves probadas: ${intentos.join(" · ")}`;
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
      const urlBusca = `${base}/companies(${process.env.BC_COMPANY_ID})/purchaseOrders?$filter=${encodeURIComponent(`number eq '${pedido.replace(/'/g, "''")}'`)}`;
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
        const urlColeccion = `${base}/companies(${process.env.BC_COMPANY_ID})/attachments`;
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

    // 3) LÍNEAS — rellenar "Cantidad a recibir" (receiveQuantity) en las
    //    líneas confirmadas. NO se registra/postea nada (a propósito):
    //    queda lista para registrarse desde BC.
    if (Array.isArray(lineas) && lineas.length) {
      if (!purchaseOrderId) {
        for (const l of lineas) resultado.lineas.push({ lineaId: l.lineaId, ok: false, error: "Pedido no localizado en purchaseOrders (api/v2.0)." });
      } else {
        for (const l of lineas) {
          try {
            const urlLinea = `${base}/companies(${process.env.BC_COMPANY_ID})/purchaseOrderLines(${l.lineaId})`;
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

    // 4) REGISTRAR — habla con el servicio local de Python
    //    (bc_automation/servicio_registro.py), que mantiene el navegador
    //    YA ABIERTO y hace clic de verdad en "Registrar" → "Recibir".
    //    Es OPCIONAL: si ese servicio no está arrancado, se avisa
    //    claramente sin romper el resto — el Nº albarán/adjunto/líneas
    //    ya se han subido igualmente por la API.
    resultado.registro = { ok: false };
    try {
      const rRegistro = await fetch(
        (process.env.BC_REGISTRO_URL || "http://localhost:5055").replace(/\/$/, "") + "/registrar",
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ numero_pedido: pedido }),
      });
      const datosRegistro = await rRegistro.json().catch(() => ({}));
      if (rRegistro.ok && datosRegistro.ok) {
        resultado.registro.ok = true;
      } else {
        resultado.registro.error = datosRegistro.error || `El servicio de registro respondió ${rRegistro.status}.`;
      }
    } catch (e) {
      resultado.registro.error = `No se pudo contactar con el servicio de registro — ¿está arrancado 'python servicio_registro.py' en bc_automation? (${String(e.message || e)})`;
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

async function extraerLoteFacturaPDF(bytesLotePdf, numPaginasLote) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env.");
  }
  const base64Lote = Buffer.from(bytesLotePdf).toString("base64");
  const prompt = `Eres un asistente que lee FACTURAS DE PROVEEDOR (compras), escaneadas/fotocopiadas o exportadas a PDF, con posiblemente varias facturas distintas seguidas en el mismo documento.

Te adjunto un PDF con ${numPaginasLote} página(s), en orden.

Para CADA página del PDF adjunto (numeradas del 1 al ${numPaginasLote} dentro de este PDF), identifica:
1. "pagina": el número de página DENTRO DE ESTE PDF (1, 2, 3...).
2. "factura": el número de factura DEL PROVEEDOR (su propio número de factura, no el nuestro). Si la página es continuación de la factura de la página anterior (no repite el número), pon "factura": null — se heredará de la página anterior.
3. "proveedor": el nombre o razón social DEL PROVEEDOR que emite la factura (el que aparece en la cabecera/membrete, no el nuestro — "Also Casals" o similar es el cliente, no el proveedor). Si la página es continuación y no repite el nombre, pon "proveedor": null — se heredará de la página anterior.
4. "fecha": la fecha DE LA FACTURA (la de emisión del proveedor, no la de vencimiento ni la del pedido), en formato "YYYY-MM-DD". Si la página es continuación y no repite la fecha, pon "fecha": null — se heredará de la página anterior. Si no se encuentra ninguna fecha de factura en el documento, pon "fecha": null.
5. "baseImponible": la BASE IMPONIBLE (subtotal antes de IVA/impuestos) que aparezca en el resumen/totales de esa página, como número (sin símbolo de moneda, con punto decimal). Normalmente solo sale en la ÚLTIMA página de la factura, en el resumen final — en las demás páginas pon "baseImponible": null.
6. "importeTotal": el IMPORTE TOTAL de la factura (con IVA/impuestos incluidos) que aparezca en el resumen/totales de esa página, como número. Igual que la base imponible, normalmente solo sale en la ÚLTIMA página — en las demás pon "importeTotal": null.
7. "lineas": un array con cada artículo/concepto facturado en la tabla de esa página, con:
   - "descripcion": el texto tal cual aparece.
   - "cantidad": la cantidad facturada (número).
   - "precioUnitario": el precio unitario de esa línea (número, sin símbolo de moneda, con punto decimal — p.ej. 12.5, no "12,50 €"). Si la tabla trae precio con descuento aparte, usa el precio unitario ANTES de aplicar el descuento de línea (el que multiplicado por la cantidad da el importe bruto de la línea).
   - "pedido": NUESTRO número de pedido de compra al que corresponde ESA línea. SIEMPRE tiene el formato "PCNN-NNNNNN" u "OCNN-NNNNNN" (dos letras, dos dígitos de año, guion, 6 dígitos), por ejemplo "PC26-002262". Puede venir con etiquetas como "Su pedido", "Pedido nº", "Referencia", "PO", "Order", "Nuestra referencia", etc. Una misma factura puede tener líneas de pedidos DISTINTOS — identifica el pedido línea por línea, no asumas que es el mismo para toda la factura. Si una línea no tiene ningún pedido nuestro reconocible, pon "pedido": null en esa línea.
   Si esa página no tiene tabla de artículos, deja "lineas": [].

Responde ÚNICAMENTE con un array JSON, sin texto adicional, backticks ni explicación, un objeto por página EN EL MISMO ORDEN Y CANTIDAD que las páginas del PDF (${numPaginasLote} objetos):
[{"pagina":1,"factura":"F-2026-01234","proveedor":"Movistar-Telefónica de España S.A.U.","fecha":"2026-08-21","baseImponible":null,"importeTotal":null,"lineas":[{"descripcion":"Tornillo M8 x100","cantidad":100,"precioUnitario":0.12,"pedido":"PC26-002262"}]}, {"pagina":2,"factura":null,"proveedor":null,"fecha":null,"baseImponible":72.81,"importeTotal":88.10,"lineas":[]}]`;

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

async function facturaYaEntradaEnBC(vendorInvoiceNumber) {
  if (!vendorInvoiceNumber) return { encontrada: false };
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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

// Transparencia (Maria, 2026-09-04): mismo patrón que "Ver columnas" de
// Pedidos pendientes de facturar — para poder comprobar en pantalla qué
// se ha detectado (columnas usadas + lista de proveedores de gasto con
// su cuenta/OT) antes de fiarse, sin tener que adivinar a ciegas.
app.get("/api/facturas-compra/proveedores-gasto", async (req, res) => {
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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
  const lista = await db.getDoc("registro_facturas_compra", []);
  return Array.isArray(lista) ? lista : [];
}

async function guardarRegistroFacturas(lista) {
  await db.setDoc("registro_facturas_compra", lista.slice(0, REGISTRO_FACTURAS_MAX));
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

app.post("/api/facturas-compra/extraer", async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({ error: "Falta instalar el paquete 'pdf-lib' en el backend. Ejecuta: npm install pdf-lib (y reinicia npm start)." });
  }
  try {
    const { nombre, base64 } = req.body || {};
    if (!base64) return res.status(400).json({ error: "Falta el campo 'base64' con el documento (PDF o foto)." });

    const dataBuffer = Buffer.from(base64, "base64");
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
    for (const g of grupos) {
      if (!g.factura || !g.paginas.length) {
        facturasFinal.push({ ...g, pdfBase64: null, pedidosDetalle: [], veredicto: null, motivos: [] });
        continue;
      }
      const nuevo = await PDFDocument.create();
      const copiadas = await nuevo.copyPages(srcPdf, g.paginas.map((p) => p - 1));
      copiadas.forEach((p) => nuevo.addPage(p));
      const bytes = await nuevo.save();
      const pdfBase64 = Buffer.from(bytes).toString("base64");

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
          const empresa = encodeURIComponent(process.env.BC_COMPANY_NAME || "");
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

      // Comprobación de DUPLICADO: ¿esta factura (por su Nº de proveedor)
      // ya está registrada en BC? Si es así, se avisa igual que cualquier
      // otro motivo de "revisar antes" — no bloquea el resto del chequeo,
      // solo lo añade.
      const chequeoDuplicado = await facturaYaEntradaEnBC(g.factura);
      if (chequeoDuplicado.encontrada) {
        ok = false;
        motivos.unshift(
          `⚠ Esta factura ya está entrada en BC (factura ${chequeoDuplicado.numeroBC || "?"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""}) — revisa antes de volver a entrarla.`
        );
      }

      // "gasto" (Maria, 2026-09-04): ni verde (no hay línea creada
      // todavía, hace falta que Maria la registre) ni rojo (no es un
      // error a corregir — es el funcionamiento normal de este
      // proveedor) — un tercer estado propio, solo cuando no hay ningún
      // otro motivo de revisión aparte de "sin pedido" (p. ej. si además
      // sale duplicada, se queda como "revisar" para no enmascararlo).
      const soloMotivoEsGasto =
        gastoSugerido && !chequeoDuplicado.encontrada && motivos.length === 1;
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
  const { factura, fechaFactura, pdfBase64, nombreArchivo, lineasFactura, forzar } = req.body || {};
  if (!factura) return res.status(400).json({ error: "Falta el nº de factura." });
  if (!Array.isArray(lineasFactura) || !lineasFactura.length) {
    return res.status(400).json({ error: "Falta 'lineasFactura' (descripción/cantidad/precioUnitario/pedido por línea)." });
  }
  const invoiceDate =
    fechaFactura && /^\d{4}-\d{2}-\d{2}$/.test(fechaFactura) ? fechaFactura : new Date().toISOString().slice(0, 10);

  const porPedido = new Map();
  for (const l of lineasFactura) {
    if (!l.pedido) continue;
    if (!porPedido.has(l.pedido)) porPedido.set(l.pedido, []);
    porPedido.get(l.pedido).push(l);
  }
  if (!porPedido.size) return res.status(400).json({ error: "Ninguna línea tiene un pedido asociado — no se puede entrar la factura." });

  // "Entrar en BC de todas formas" (Maria, 2026-09-04): con forzar=true,
  // los motivos de abajo que son decisión de negocio (factura duplicada,
  // línea sin encontrar, pendiente de recibir, precio distinto) dejan de
  // bloquear con 409 — se anotan en `avisos` (ya se enseñan en pantalla)
  // y se sigue creando la factura. Lo que NO se puede saltar nunca:
  // no tener forma de identificar el proveedor en BC (bc.error /
  // vendorNumber ausente) — sin eso no hay a qué proveedor crear la
  // factura, forzar o no.
  const avisos = [];

  // Re-comprobar duplicado EN VIVO también aquí (no solo al subir el
  // PDF) — por si se entró desde otra pestaña/sesión mientras tanto.
  const chequeoDuplicado = await facturaYaEntradaEnBC(factura);
  if (chequeoDuplicado.encontrada) {
    const mensajeDuplicado = `Esta factura ya está entrada en BC (factura ${chequeoDuplicado.numeroBC || "?"}${chequeoDuplicado.proveedor ? " · " + chequeoDuplicado.proveedor : ""})`;
    if (!forzar) {
      return res.status(409).json({ error: `${mensajeDuplicado} — no se ha vuelto a crear.` });
    }
    avisos.push(`⚠ Forzado: ${mensajeDuplicado}, pero se ha creado de nuevo porque se ha pedido entrarla igual.`);
  }

  // Re-validar EN VIVO contra BC (no fiarse del semáforo calculado al
  // subir el PDF) y agrupar por proveedor — BC no permite mezclar
  // proveedores distintos en una misma factura de compra. Las líneas ya
  // emparejadas NO se usan para crear nada en BC — solo para la
  // comprobación de seguridad y para el resumen que se muestra en pantalla.
  const porProveedor = new Map(); // vendorNumber -> { vendorName, pedidos:[], lineas:[] }
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

  if (porProveedor.size > 1) {
    avisos.push(
      `La factura toca proveedores distintos en BC (${[...porProveedor.values()].map((g) => g.vendorName).join(", ")}) — como una factura de compra en BC solo puede tener un proveedor, se ha creado UNA FACTURA POR PROVEEDOR en vez de una sola.`
    );
  }

  const token = await obtenerTokenBC();
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
  const urlBase = `${base}/companies(${process.env.BC_COMPANY_ID})`;

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
            quantity: Number(l.cantidad) || 0,
          };
          if (l.precio !== null && l.precio !== undefined && !Number.isNaN(Number(l.precio))) {
            bodyLinea.directUnitCost = Number(l.precio);
          }
          if (l.unitOfMeasureCode) bodyLinea.unitOfMeasureCode = l.unitOfMeasureCode;
          const rLinea = await fetchConReintento(`${urlBase}/purchaseInvoiceLines`, {
            method: "POST",
            headers: cabeceras,
            body: JSON.stringify(bodyLinea),
          });
          if (rLinea.ok) {
            item.lineasCreadas.push(l.descripcion || l.codigoBC);
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

  res.status(huboError ? 207 : 200).json({ ok: !huboError, facturasCreadas, avisos });
});

// SPA: cualquier ruta que no sea /api → index.html (build de Vite en public/)
app.get(/^\/(?!api).*/, (req, res) => {
  const indexHtml = path.join(__dirname, "public", "index.html");
  if (!fsEstado.existsSync(indexHtml)) {
    return res.status(404).type("text/plain").send(
      "Frontend no compilado. En desarrollo usa Vite (:5173); en Docker el build va en public/."
    );
  }
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
