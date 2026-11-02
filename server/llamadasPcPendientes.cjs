/**
 * Tras el informe diario de PCs pendientes de recibir: agrupa por
 * departamento → responsable, pregunta por teléfono (o simula) y envía
 * un Excel de seguimiento a INFORME_PC_DESTINO / buzón personal.
 *
 * INFORME_PC_LLAMADAS:
 *   off      → no hace nada (por defecto)
 *   simular  → Excel con el plan de llamadas, sin marcar el teléfono
 *   vapi     → llamada real vía Vapi.ai (hace falta VAPI_API_KEY + número)
 */
const JSZip = require("jszip");

/** Prueba: mismo móvil. Cambiar cuando pasen a producción. */
const RESPONSABLES_LLAMADA = {
  AUT: { nombre: "Josep Altadill", movil: "616019042" },
  CON: { nombre: "Jordi Costea", movil: "616019042" },
  AMT: { nombre: "Jordi Costea", movil: "616019042" },
  INS: { nombre: "Jesús Calvo", movil: "616019042" },
  MAN: { nombre: "Albert Curto", movil: "616019042" },
};

function modoLlamadas() {
  const m = String(process.env.INFORME_PC_LLAMADAS || "off").trim().toLowerCase();
  if (m === "simular" || m === "simulate" || m === "dry" || m === "dry-run") return "simular";
  if (m === "vapi" || m === "on" || m === "true" || m === "1") return "vapi";
  return "off";
}

function destinatarioInforme() {
  return String(process.env.INFORME_PC_DESTINO || process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function buzonRemitente() {
  return String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function codigoDepto(raw) {
  const up = String(raw || "").trim().toUpperCase();
  if (!up) return null;
  const est = up.match(/^_EST(?:-(?:AC|FCA|QL))?(?:-([A-Z0-9]+))?$/);
  if (est) return est[1] || null;
  const seg = up.split("-")[0].trim();
  return RESPONSABLES_LLAMADA[seg] ? seg : null;
}

function e164Es(movil) {
  const dig = String(movil || "").replace(/\D/g, "");
  if (!dig) return null;
  if (dig.startsWith("34") && dig.length >= 11) return `+${dig}`;
  if (dig.length === 9) return `+34${dig}`;
  return dig.startsWith("+") ? String(movil).trim() : `+${dig}`;
}

function eur(n) {
  return (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/**
 * Aplana el informe (empresas → filas) y agrupa por responsable/móvil.
 * Pedidos sin mapa de departamento quedan en "sinResponsable".
 */
function planificarLlamadas(informe) {
  const grupos = new Map();
  const sinResponsable = [];
  for (const emp of informe.empresas || []) {
    for (const f of emp.filas || []) {
      const codigo = codigoDepto(f.deptoCodigo) || codigoDepto(f.departamento);
      const resp = codigo ? RESPONSABLES_LLAMADA[codigo] : null;
      const fila = {
        empresa: emp.etiqueta,
        pedido: f.pedido,
        deptoCodigo: codigo || "",
        departamento: f.departamento,
        fecha: f.fecha,
        proveedor: f.proveedor,
        importe: f.importe,
      };
      if (!resp) {
        sinResponsable.push(fila);
        continue;
      }
      // Misma clave = mismo móvil (en prueba varios dptos comparten número → 1 llamada).
      const clave = e164Es(resp.movil) || resp.movil;
      if (!grupos.has(clave)) {
        grupos.set(clave, {
          nombres: new Set([resp.nombre]),
          movil: resp.movil,
          telefono: e164Es(resp.movil),
          departamentos: new Set(),
          pedidos: [],
        });
      }
      const g = grupos.get(clave);
      g.nombres.add(resp.nombre);
      if (codigo) g.departamentos.add(codigo);
      g.pedidos.push(fila);
    }
  }
  const llamadas = [...grupos.values()].map((g) => ({
    nombre: [...g.nombres].sort().join(" / "),
    movil: g.movil,
    telefono: g.telefono,
    departamentos: [...g.departamentos].sort(),
    pedidos: g.pedidos,
  }));
  return { llamadas, sinResponsable };
}

function guionLlamada(grupo, { fechaPedido, fechaHoy }) {
  const lista = grupo.pedidos
    .map((p, i) => `${i + 1}) ${p.pedido}, proveedor ${p.proveedor}, importe pendiente ${eur(p.importe)}, departamento ${p.departamento}`)
    .join(". ");
  return [
    `Hola ${grupo.nombre}, soy el asistente de administración de Also Casals, llamo en nombre de Maria Rufí.`,
    `Te llamo por los pedidos de compra del ${fechaPedido} que a día ${fechaHoy} siguen pendientes de recibir en tu departamento.`,
    `Son ${grupo.pedidos.length} pedido${grupo.pedidos.length === 1 ? "" : "s"}: ${lista}.`,
    "Por cada pedido necesito saber: si el material ha llegado completo, si ha llegado solo en parte, o si aún no ha llegado.",
    "Si ha llegado completo, lo anoto como recibido. Si es parcial, dime qué falta y cuándo esperáis el resto. Si no ha llegado, una fecha aproximada de recepción.",
    "Cuando acabemos te resumo lo anotado. Gracias.",
  ].join(" ");
}

function xmlEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function celda(v, tipo = "inlineStr") {
  if (v == null || v === "") return `<c><v></v></c>`;
  if (tipo === "n" && Number.isFinite(Number(v))) return `<c t="n"><v>${Number(v)}</v></c>`;
  return `<c t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
}

async function excelSeguimiento({ informe, plan, resultados, modo }) {
  const cab = [
    "Empresa",
    "Pedido",
    "Departamento",
    "Código dpto",
    "Fecha pedido",
    "Proveedor",
    "Importe pendiente",
    "Responsable",
    "Móvil",
    "Estado recepción",
    "Fecha prevista",
    "Notas",
    "Modo",
    "Id llamada",
  ];
  const filas = [];
  for (const g of plan.llamadas) {
    for (const p of g.pedidos) {
      const r = (resultados && resultados[p.pedido]) || {};
      filas.push([
        p.empresa,
        p.pedido,
        p.departamento,
        p.deptoCodigo,
        p.fecha,
        p.proveedor,
        Number(p.importe) || 0,
        g.nombre,
        g.movil,
        r.estado || (modo === "simular" ? "pendiente (simulación)" : "pendiente"),
        r.fechaPrevista || "",
        r.notas || "",
        modo,
        r.callId || "",
      ]);
    }
  }
  for (const p of plan.sinResponsable) {
    filas.push([
      p.empresa,
      p.pedido,
      p.departamento,
      p.deptoCodigo,
      p.fecha,
      p.proveedor,
      Number(p.importe) || 0,
      "",
      "",
      "sin responsable mapeado",
      "",
      "Falta móvil/responsable para este departamento",
      modo,
      "",
    ]);
  }

  const sheetRows = [
    `<row r="1">${cab.map((h) => celda(h)).join("")}</row>`,
    ...filas.map((cols, i) => {
      const r = i + 2;
      const celdas = cols.map((v, j) => (j === 6 ? celda(v, "n") : celda(v)));
      return `<row r="${r}">${celdas.join("")}</row>`;
    }),
  ].join("");

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Seguimiento PC" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels").file(".rels", rels);
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbook);
  xl.folder("_rels").file("workbook.xml.rels", wbRels);
  xl.folder("worksheets").file("sheet1.xml", sheet);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const fecha = String(informe.fecha || "").replace(/-/g, "");
  return {
    nombre: `seguimiento-pc-pendientes-${fecha || "hoy"}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: buf.toString("base64"),
  };
}

async function tokenAzure(tenant, clientId, secret, scope) {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: secret,
    scope,
  });
  const r = await fetch(url, { method: "POST", body });
  if (!r.ok) throw new Error(`Azure respondió ${r.status} al pedir token Graph`);
  return (await r.json()).access_token;
}

let tokenGraph = { token: null, expira: 0 };
async function obtenerTokenGraph() {
  if (tokenGraph.token && Date.now() < tokenGraph.expira) return tokenGraph.token;
  const token = await tokenAzure(
    process.env.M365_TENANT_ID,
    process.env.M365_CLIENT_ID,
    process.env.M365_CLIENT_SECRET,
    "https://graph.microsoft.com/.default"
  );
  tokenGraph = { token, expira: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function enviarExcel({ asunto, html, para, adjunto }) {
  const token = await obtenerTokenGraph();
  const de = buzonRemitente();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(de)}/sendMail`;
  const message = {
    subject: asunto,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: para } }],
    attachments: [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: adjunto.nombre,
        contentType: adjunto.contentType,
        contentBytes: adjunto.base64,
      },
    ],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Graph respondió ${r.status} al enviar el Excel de seguimiento: ${detalle}`);
  }
  return { de, para };
}

function htmlResumen({ modo, plan, fechaPedido, fechaHoy }) {
  const n = plan.llamadas.reduce((s, g) => s + g.pedidos.length, 0);
  const bloques = plan.llamadas
    .map((g) => {
      const pcs = g.pedidos.map((p) => `<li><b>${xmlEsc(p.pedido)}</b> · ${xmlEsc(p.proveedor)} · ${xmlEsc(eur(p.importe))}</li>`).join("");
      return `<p style="margin:14px 0 4px"><b>${xmlEsc(g.nombre)}</b> · ${xmlEsc(g.movil)} · dpto. ${xmlEsc(g.departamentos.join(", "))}</p><ul style="margin:0 0 8px;padding-left:18px">${pcs}</ul>`;
    })
    .join("");
  const sin = plan.sinResponsable.length
    ? `<p style="margin-top:12px;color:#b45309">${plan.sinResponsable.length} pedido(s) sin responsable de llamada mapeado.</p>`
    : "";
  const modoTxt =
    modo === "simular"
      ? "Modo <b>simulación</b>: no se ha marcado el teléfono; el Excel es el plan de llamadas."
      : modo === "vapi"
        ? "Modo <b>llamada Vapi</b>: se ha intentado llamar a cada responsable."
        : "";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b">
<p>Buenos días,</p>
<p>Seguimiento de recepción de <b>${n}</b> PC pendientes del <b>${xmlEsc(fechaPedido)}</b> (informe del ${xmlEsc(fechaHoy)}).</p>
<p>${modoTxt}</p>
${bloques}
${sin}
<p style="margin-top:16px">Adjunto el Excel de seguimiento.</p>
<p>Un saludo,<br>ACSales</p>
</div>`;
}

function parsearRespuestaVapi(call) {
  const out = {};
  const analysis = call?.analysis || {};
  const structured = analysis.structuredData || analysis.structuredOutputs || {};
  const pedidos = Array.isArray(structured.pedidos) ? structured.pedidos : [];
  for (const p of pedidos) {
    const no = String(p.pedido || p.pc || "").trim().toUpperCase();
    if (!no) continue;
    out[no] = {
      estado: String(p.estado || p.status || "").trim() || "desconocido",
      fechaPrevista: String(p.fechaPrevista || p.fecha_prevista || "").trim(),
      notas: String(p.notas || p.nota || analysis.summary || "").trim(),
      callId: call.id || "",
    };
  }
  if (!pedidos.length && call?.id) {
    // Sin estructura: deja la nota global en el primer pedido al rellenar fuera.
    out.__summary__ = {
      estado: call.status === "ended" ? "sin estructura" : String(call.status || ""),
      fechaPrevista: "",
      notas: String(analysis.summary || "").trim(),
      callId: call.id,
    };
  }
  return out;
}

async function vapiCrearLlamada(grupo, { fechaPedido, fechaHoy }) {
  const apiKey = String(process.env.VAPI_API_KEY || "").trim();
  if (!apiKey) throw new Error("Falta VAPI_API_KEY para modo vapi");
  const phoneNumberId = String(process.env.VAPI_PHONE_NUMBER_ID || "").trim();
  if (!phoneNumberId) throw new Error("Falta VAPI_PHONE_NUMBER_ID (número saliente en Vapi)");

  const pedidosSchema = grupo.pedidos.map((p) => p.pedido).join(", ");
  const body = {
    phoneNumberId,
    customer: { number: grupo.telefono, name: grupo.nombre },
    assistant: {
      name: "ACSales recepción PC",
      firstMessage: `Hola ${grupo.nombre}, soy el asistente de administración de Also Casals, llamo en nombre de Maria Rufí. ¿Tienes un momento para revisar ${grupo.pedidos.length} pedido${grupo.pedidos.length === 1 ? "" : "s"} de compra pendiente${grupo.pedidos.length === 1 ? "" : "s"} de recibir?`,
      model: {
        provider: "openai",
        model: process.env.VAPI_MODEL || "gpt-4o",
        messages: [
          {
            role: "system",
            content: `Eres un asistente de administración de Also Casals. Hablas en castellano, breve y claro. Llamas a ${grupo.nombre} para comprobar la recepción de pedidos de compra.
Fecha de los pedidos: ${fechaPedido}. Hoy: ${fechaHoy}.
Pedidos a revisar (${pedidosSchema}):
${grupo.pedidos.map((p) => `- ${p.pedido} | ${p.proveedor} | ${eur(p.importe)} | ${p.departamento}`).join("\n")}
Por cada pedido pregunta: ¿ha llegado completo, parcialmente o no ha llegado?
- Si completo: estado "recibido".
- Si parcial: estado "parcial", anota qué falta y fecha prevista del resto.
- Si no: estado "no_recibido" y fecha aproximada de recepción.
Al final resume. No inventes datos. Si no saben la fecha, anota "desconocida".
Cuando tengas respuesta de todos, despídete cordialmente.`,
          },
        ],
      },
      voice: {
        provider: process.env.VAPI_VOICE_PROVIDER || "vapi",
        voiceId: process.env.VAPI_VOICE_ID || "Clara",
      },
      // Sin language=es el STT de Vapi suele ir en inglés y el agente responde en inglés.
      transcriber: {
        provider: process.env.VAPI_TRANSCRIBER_PROVIDER || "deepgram",
        model: process.env.VAPI_TRANSCRIBER_MODEL || "nova-2",
        language: process.env.VAPI_TRANSCRIBER_LANGUAGE || "es",
      },
      analysisPlan: {
        summaryPrompt: "Resume en español el estado de cada pedido de compra mencionado.",
        structuredDataSchema: {
          type: "object",
          properties: {
            pedidos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  pedido: { type: "string" },
                  estado: { type: "string", enum: ["recibido", "parcial", "no_recibido", "desconocido"] },
                  fechaPrevista: { type: "string" },
                  notas: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };

  const r = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Vapi ${r.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}

async function vapiEsperar(callId, { timeoutMs = 8 * 60 * 1000 } = {}) {
  const apiKey = String(process.env.VAPI_API_KEY || "").trim();
  const hasta = Date.now() + timeoutMs;
  while (Date.now() < hasta) {
    const r = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Vapi GET call ${r.status}: ${txt.slice(0, 300)}`);
    const call = txt ? JSON.parse(txt) : {};
    const st = String(call.status || "");
    if (["ended", "forwarding", "completed"].includes(st) || call.endedReason) return call;
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(`Timeout esperando la llamada Vapi ${callId}`);
}

async function ejecutarLlamadasVapi(plan, meta) {
  const resultados = {};
  for (const g of plan.llamadas) {
    try {
      console.log(`[llamadas-pc] Vapi → ${g.nombre} ${g.telefono} (${g.pedidos.length} PC)`);
      const created = await vapiCrearLlamada(g, meta);
      const callId = created.id || created.call?.id;
      if (!callId) throw new Error("Vapi no devolvió id de llamada");
      const ended = await vapiEsperar(callId);
      const parsed = parsearRespuestaVapi(ended);
      const summary = parsed.__summary__;
      delete parsed.__summary__;
      for (const p of g.pedidos) {
        const key = p.pedido.toUpperCase();
        resultados[p.pedido] = parsed[key] || parsed[p.pedido] || {
          estado: summary?.estado || "sin respuesta estructurada",
          fechaPrevista: summary?.fechaPrevista || "",
          notas: summary?.notas || "",
          callId,
        };
      }
    } catch (err) {
      console.error(`[llamadas-pc] Error con ${g.nombre}:`, err.message || err);
      for (const p of g.pedidos) {
        resultados[p.pedido] = {
          estado: "error_llamada",
          fechaPrevista: "",
          notas: String(err.message || err),
          callId: "",
        };
      }
    }
  }
  return resultados;
}

/**
 * Punto de entrada tras generar/enviar el informe diario.
 * No lanza hacia fuera: registra errores y sigue.
 */
async function trasInforme(informe) {
  const modo = modoLlamadas();
  if (modo === "off") return { modo, omitido: true };
  if (!informe || !informe.n) {
    console.log("[llamadas-pc] Sin pedidos pendientes; no hay llamadas.");
    return { modo, omitido: true, motivo: "sin_pedidos" };
  }

  const plan = planificarLlamadas(informe);
  if (!plan.llamadas.length && !plan.sinResponsable.length) {
    return { modo, omitido: true, motivo: "vacio" };
  }

  const aCorta = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
  };
  const meta = {
    fechaPedido: aCorta(informe.fecha),
    fechaHoy: aCorta(informe.fechaHoy),
  };

  for (const g of plan.llamadas) {
    console.log(`[llamadas-pc] Plan ${g.nombre} (${g.movil}): ${g.pedidos.map((p) => p.pedido).join(", ")}`);
    console.log(`[llamadas-pc] Guion: ${guionLlamada(g, meta).slice(0, 180)}…`);
  }

  let resultados = {};
  if (modo === "vapi") {
    resultados = await ejecutarLlamadasVapi(plan, meta);
  }

  const adjunto = await excelSeguimiento({ informe, plan, resultados, modo });
  const para = destinatarioInforme();
  const asunto =
    modo === "simular"
      ? `Simulación llamadas PC pendientes — ${meta.fechaPedido}`
      : `Seguimiento llamadas PC pendientes — ${meta.fechaPedido}`;
  const envio = await enviarExcel({
    asunto,
    html: htmlResumen({ modo, plan, fechaPedido: meta.fechaPedido, fechaHoy: meta.fechaHoy }),
    para,
    adjunto,
  });
  console.log(`[llamadas-pc] Excel → ${envio.para} (${modo}, ${plan.llamadas.length} llamada(s))`);
  return {
    modo,
    para: envio.para,
    llamadas: plan.llamadas.map((g) => ({ nombre: g.nombre, movil: g.movil, n: g.pedidos.length })),
    sinResponsable: plan.sinResponsable.length,
    fichero: adjunto.nombre,
  };
}

module.exports = {
  RESPONSABLES_LLAMADA,
  modoLlamadas,
  planificarLlamadas,
  guionLlamada,
  trasInforme,
  excelSeguimiento,
};
