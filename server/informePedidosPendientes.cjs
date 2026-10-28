/**
 * Informe diario por correo: pedidos de compra pendientes de recibir
 * cuya fecha de pedido es hoy menos N días (por defecto 10).
 *
 * Cada día, a partir de INFORME_PC_HORA (8 = 08:00, hora Europe/Madrid),
 * se envía a INFORME_PC_DESTINO (si no, el buzón personal). Si el servidor
 * arranca más tarde, lo manda en cuanto puede, una sola vez al día.
 */
const NOMBRES = {
  INS: "Instalaciones",
  MAN: "Mantenimiento",
  AUT: "Automatización",
  CON: "Construcción",
  AMI: "Amianto",
  MEC: "Mecanizado y serrallería",
};
const TIPO_CLIENTE = { P: "Particular", I: "Industrial", A: "Administración pública" };
const ESTRUCTURA = { AC: "Also Casals", FCA: "Ferros", QL: "Quimlab" };

const CLAVE_ESTADO = "informe_pedidos_pendientes";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function eur(n) {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

function partesMadrid(date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

function hoyMadrid(date = new Date()) {
  const p = partesMadrid(date);
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), minuto: Number(p.minute) };
}

function restarDias(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dias);
  return dt.toISOString().slice(0, 10);
}

function etiquetaDepartamento(codigo) {
  const raw = String(codigo || "").trim();
  if (!raw) return "Sin departamento";
  const up = raw.toUpperCase();
  const est = up.match(/^_EST(?:-(AC|FCA|QL))?(?:-([A-Z0-9]+))?$/);
  if (est) {
    const emp = ESTRUCTURA[est[1]] || "";
    const dep = NOMBRES[est[2]] || "";
    return `${["Estructura", emp, dep].filter(Boolean).join(" · ")} (${raw})`;
  }
  const [seg, tipo] = up.split("-");
  const nombre = NOMBRES[seg];
  if (!nombre) return raw;
  const tipoTxt = TIPO_CLIENTE[tipo] || "";
  return tipoTxt ? `${nombre} · ${tipoTxt} (${raw})` : `${nombre} (${raw})`;
}

function diasAtras() {
  const n = Number(process.env.INFORME_PC_DIAS ?? 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

function horaEnvio() {
  const n = Number(process.env.INFORME_PC_HORA ?? 8);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 8;
}

function destinatario() {
  return String(process.env.INFORME_PC_DESTINO || process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function buzonRemitente() {
  return String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
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
  if (!r.ok) throw new Error(`Azure respondió ${r.status} al pedir token`);
  return (await r.json()).access_token;
}

let tokenBC = { token: null, expira: 0 };
async function obtenerTokenBC() {
  if (tokenBC.token && Date.now() < tokenBC.expira) return tokenBC.token;
  const token = await tokenAzure(
    process.env.BC_TENANT_ID,
    process.env.BC_CLIENT_ID,
    process.env.BC_CLIENT_SECRET,
    "https://api.businesscentral.dynamics.com/.default"
  );
  tokenBC = { token, expira: Date.now() + 50 * 60 * 1000 };
  return token;
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

async function pedir(url, headers) {
  const r = await fetch(url, { headers });
  const txt = await r.text();
  if (!r.ok) {
    const err = new Error(`BC respondió ${r.status}: ${txt.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return txt ? JSON.parse(txt) : {};
}

async function paginar(url, headers) {
  const out = [];
  let next = url;
  while (next) {
    const pagina = await pedir(next, headers);
    out.push(...(pagina.value || []));
    next = pagina["@odata.nextLink"] || null;
  }
  return out;
}

async function empresasCompra(token) {
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies`;
  const lista = await pedir(raiz, { Authorization: `Bearer ${token}`, Accept: "application/json" });
  const re = new RegExp(process.env.APP_EMPRESAS || "also|ferros|quimlab", "i");
  return (lista.value || [])
    .filter((c) => re.test(`${c.name} ${c.displayName || ""}`))
    .map((c) => ({ nombre: c.name, etiqueta: c.displayName || c.name }));
}

async function pedidosPendientesEmpresa(token, empresa, fecha) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(empresa.nombre)}')`;
  const filtro = encodeURIComponent(`Order_Date eq ${fecha}`);
  const servicioCab = process.env.BC_WS_PEDIDOSCOMPRA || "Pedido_compra_Excel";
  const servicioLin = process.env.BC_WS_LINEASCOMPRA || "Líns_compra_Excel";
  const cabeceras = await paginar(`${raiz}/${encodeURIComponent(servicioCab)}?$filter=${filtro}`, headers);
  const pedidos = cabeceras.filter((c) => {
    const no = String(c.No || "").trim();
    if (!/^PC/i.test(no)) return false;
    if (String(c.On_Hold || "").trim()) return false;
    const tipo = String(c.Document_Type || "").trim();
    return !tipo || /^order$/i.test(tipo);
  });
  if (!pedidos.length) return [];

  const lineas = await paginar(`${raiz}/${encodeURIComponent(servicioLin)}?$filter=${filtro}`, headers);
  const porDoc = {};
  for (const l of lineas) {
    const doc = String(l.Document_No || "").trim().toUpperCase();
    if (!doc) continue;
    const qPend = num(l.Outstanding_Quantity);
    if (qPend <= 0) continue;
    if (!porDoc[doc]) porDoc[doc] = { importe: 0, depto: "" };
    const qty = num(l.Quantity);
    const linea = num(l.Line_Amount);
    // Line_Amount es el importe de la línea sin IVA. La parte pendiente
    // es la proporción que aún no se ha recibido.
    const pendiente = qty > 0 && linea ? linea * (qPend / qty) : qPend * (num(l.Direct_Unit_Cost) || num(l.Unit_Cost));
    porDoc[doc].importe += pendiente;
    if (!porDoc[doc].depto && l.Shortcut_Dimension_1_Code) porDoc[doc].depto = String(l.Shortcut_Dimension_1_Code).trim();
  }

  return pedidos
    .map((c) => {
      const no = String(c.No || "").trim();
      const calc = porDoc[no.toUpperCase()];
      if (!calc) return null;
      const depto = String(c.Shortcut_Dimension_1_Code || "").trim() || calc.depto;
      return {
        pedido: no,
        departamento: etiquetaDepartamento(depto),
        fecha: fechaCorta(c.Order_Date || fecha),
        proveedor: String(c.Buy_from_Vendor_Name || "").trim() || "—",
        importe: calc.importe,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.departamento.localeCompare(b.departamento, "es") || a.proveedor.localeCompare(b.proveedor, "es") || a.pedido.localeCompare(b.pedido));
}

function htmlInforme({ fechaPedido, fechaHoy, empresas }) {
  const th = "text-align:left;padding:6px 8px;border-bottom:1px solid #cbd5e1;background:#f1f5f9;font-size:12px";
  const td = "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px";
  const tdR = td + ";text-align:right;white-space:nowrap";
  const total = empresas.reduce((s, e) => s + e.filas.reduce((a, f) => a + f.importe, 0), 0);
  const n = empresas.reduce((s, e) => s + e.filas.length, 0);
  const bloques = empresas.map((e) => {
    if (!e.filas.length) {
      return `<p style="margin:16px 0 4px"><b>${esc(e.etiqueta)}</b></p><p style="margin:0 0 8px;color:#64748b">No hay pedidos de ese día pendientes de recibir.</p>`;
    }
    const filas = e.filas.map((f) => `<tr><td style="${td}">${esc(f.pedido)}</td><td style="${td}">${esc(f.departamento)}</td><td style="${td}">${esc(f.fecha)}</td><td style="${td}">${esc(f.proveedor)}</td><td style="${tdR}">${esc(eur(f.importe))}</td></tr>`).join("");
    const sub = e.filas.reduce((a, f) => a + f.importe, 0);
    return `<p style="margin:18px 0 6px"><b>${esc(e.etiqueta)}</b> · ${e.filas.length} pedido${e.filas.length === 1 ? "" : "s"} · ${esc(eur(sub))}</p>
<table style="border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif">
<thead><tr><th style="${th}">Pedido</th><th style="${th}">Departamento</th><th style="${th}">Fecha</th><th style="${th}">Proveedor</th><th style="${th};text-align:right">Importe pendiente</th></tr></thead>
<tbody>${filas}</tbody></table>`;
  }).join("");
  const resumen = n
    ? `Hay <b>${n}</b> pedido${n === 1 ? "" : "s"} de compra del <b>${esc(fechaCorta(fechaPedido))}</b> que a día ${esc(fechaCorta(fechaHoy))} siguen pendientes de recibir. Importe pendiente: <b>${esc(eur(total))}</b>.`
    : `No hay pedidos de compra del <b>${esc(fechaCorta(fechaPedido))}</b> pendientes de recibir.`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b">
<p>Buenos días,</p>
<p>${resumen}</p>
${bloques}
<p style="margin-top:18px;color:#64748b;font-size:12px">El importe es lo que aún falta por recibir (cantidad pendiente × coste), sin IVA. No entran los pedidos marcados como Esperar en Business Central.</p>
<p>Un saludo,<br>ACSales</p>
</div>`;
}

async function preparar({ fechaPedido, fechaHoy } = {}) {
  const hoy = fechaHoy || hoyMadrid().fecha;
  const fecha = fechaPedido || restarDias(hoy, diasAtras());
  const token = await obtenerTokenBC();
  const empresas = await empresasCompra(token);
  const bloques = [];
  for (const empresa of empresas) {
    const filas = await pedidosPendientesEmpresa(token, empresa, fecha);
    bloques.push({ etiqueta: empresa.etiqueta, filas });
  }
  const n = bloques.reduce((s, e) => s + e.filas.length, 0);
  const asunto = n
    ? `Pedidos de compra pendientes de recibir — ${fechaCorta(fecha)} (${n})`
    : `Pedidos de compra pendientes de recibir — ${fechaCorta(fecha)} (ninguno)`;
  return { fecha, fechaHoy: hoy, empresas: bloques, n, asunto, html: htmlInforme({ fechaPedido: fecha, fechaHoy: hoy, empresas: bloques }) };
}

async function enviarCorreo({ asunto, html, para }) {
  const token = await obtenerTokenGraph();
  const de = buzonRemitente();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(de)}/sendMail`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: asunto,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: para } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Graph respondió ${r.status} al enviar el informe: ${detalle}`);
  }
  return { de, para };
}

/**
 * Prepara y envía el informe. Con marcar:true guarda el día en Postgres
 * para no repetirlo si el servidor se reinicia.
 */
async function enviar({ db, fechaPedido, fechaHoy, marcar = false } = {}) {
  const informe = await preparar({ fechaPedido, fechaHoy });
  const para = destinatario();
  const envio = await enviarCorreo({ asunto: informe.asunto, html: informe.html, para });
  if (marcar && db) {
    await db.setDoc(CLAVE_ESTADO, {
      ultimo: informe.fechaHoy,
      fechaPedido: informe.fecha,
      n: informe.n,
      para,
      ts: new Date().toISOString(),
    });
  }
  return { ...envio, asunto: informe.asunto, fechaPedido: informe.fecha, fechaHoy: informe.fechaHoy, n: informe.n, empresas: informe.empresas.map((e) => ({ etiqueta: e.etiqueta, n: e.filas.length })) };
}

function programar({ db }) {
  const hora = horaEnvio();
  let ultimoIntento = 0;
  const tick = async () => {
    try {
      const ahora = hoyMadrid();
      if (ahora.hora < hora) return;
      const estado = await db.getDoc(CLAVE_ESTADO, {});
      if (estado.ultimo === ahora.fecha) return;
      if (Date.now() - ultimoIntento < 15 * 60 * 1000) return;
      ultimoIntento = Date.now();
      const r = await enviar({ db, fechaHoy: ahora.fecha, marcar: true });
      console.log(`[informe-pc] ${r.fechaHoy} pedidos del ${r.fechaPedido}: ${r.n} → ${r.para}`);
    } catch (err) {
      console.error("[informe-pc]", err.message || err);
    }
  };
  setTimeout(tick, 20000);
  setInterval(tick, 60 * 1000);
  console.log(`[informe-pc] Cada día a las ${String(hora).padStart(2, "0")}:00 (Europe/Madrid), pedidos de hace ${diasAtras()} días → ${destinatario()}`);
}

module.exports = { preparar, enviar, programar, hoyMadrid, restarDias };
