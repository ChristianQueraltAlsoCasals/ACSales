/**
 * Informe diario por correo: ventas, facturas de compra y ratios
 * financieros en importes (€), no en porcentajes.
 *
 * Cada día, a partir de INFORME_DIARIO_HORA (por defecto la misma que
 * INFORME_PC_HORA / 8:00, Europe/Madrid), se envía a INFORME_DIARIO_DESTINO
 * (si no, el buzón personal). Si el servidor arranca más tarde, lo manda
 * en cuanto puede, una sola vez al día.
 *
 * Fuentes: movimientos de contabilidad BC (mismas fórmulas que Ratios)
 * y historial de purchaseInvoices (importe sin IVA).
 */
const { hoyMadrid, restarDias } = require("./informePedidosPendientes.cjs");

const CLAVE_ESTADO = "informe_diario_financiero";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function eur(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

function mesEtiqueta(isoDesde, isoHasta) {
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const [y, m] = String(isoDesde || "").split("-").map(Number);
  if (!y || !m) return `${fechaCorta(isoDesde)} – ${fechaCorta(isoHasta)}`;
  if (isoDesde.slice(0, 7) === String(isoHasta || "").slice(0, 7)) return `${meses[m - 1]} ${y}`;
  return `${fechaCorta(isoDesde)} – ${fechaCorta(isoHasta)}`;
}

function horaEnvio() {
  const n = Number(process.env.INFORME_DIARIO_HORA ?? process.env.INFORME_PC_HORA ?? 8);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 8;
}

function destinatario() {
  return String(process.env.INFORME_DIARIO_DESTINO || process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function buzonRemitente() {
  return String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function empresaId() {
  return String(process.env.BC_COMPANY_ID || "").trim();
}

function empresaNombre() {
  return String(process.env.BC_COMPANY_NAME || "Also Casals").trim();
}

function primerDiaMes(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

function ultimoDiaMes(iso) {
  const [y, m] = String(iso).slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function periodosDesdeHoy(fechaHoy) {
  const ayer = restarDias(fechaHoy, 1);
  const mesActualDesde = primerDiaMes(ayer);
  const mesActualHasta = ayer;
  const mesAnteriorRef = restarDias(mesActualDesde, 1);
  const mesAnteriorDesde = primerDiaMes(mesAnteriorRef);
  const mesAnteriorHasta = ultimoDiaMes(mesAnteriorRef);
  return {
    hoy: fechaHoy,
    ayer: { desde: ayer, hasta: ayer, etiqueta: fechaCorta(ayer) },
    mesActual: { desde: mesActualDesde, hasta: mesActualHasta, etiqueta: mesEtiqueta(mesActualDesde, mesActualHasta) },
    mesAnterior: { desde: mesAnteriorDesde, hasta: mesAnteriorHasta, etiqueta: mesEtiqueta(mesAnteriorDesde, mesAnteriorHasta) },
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

function S(mapa, prefijos, excluir = []) {
  let t = 0;
  for (const [cta, v] of mapa) {
    if (prefijos.some((p) => cta.startsWith(p)) && !excluir.some((p) => cta.startsWith(p))) t += v;
  }
  return t;
}

/** Mismas masas que contabilidad.cjs (Ratios). */
function masas(bal, pyg, dias) {
  const AF = S(bal, ["20", "21", "22", "23", "24", "25", "26", "28", "29"]);
  const E = S(bal, ["30", "31", "32", "33", "34", "35", "36", "39"]);
  const clientes = S(bal, ["43", "490"]);
  const otrosDeudores = S(bal, ["44", "460", "470", "471", "472", "473", "53", "54", "480", "59"]);
  const R = clientes + otrosDeudores;
  const T = S(bal, ["57"]);
  const AC = E + R + T;
  const A = AF + AC;
  const K = -S(bal, ["10", "11", "12", "13"]) - S(bal, ["6", "7"]);
  const RA = -S(bal, ["14", "15", "16", "17", "18"]);
  const PC = -S(bal, ["40", "41", "465", "475", "476", "477", "50", "51", "52", "56", "485"]);
  const proveedores = -S(bal, ["400", "401", "403", "404", "405", "406"]);
  const D = RA + PC;
  const FM = AC - PC;
  const CP = K + RA;

  const VN = -S(pyg, ["70"]);
  const otrosIngresos = -S(pyg, ["71", "73", "74", "75"]);
  const compras = S(pyg, ["60"]);
  const consumos = S(pyg, ["60", "61"]);
  const servicios = S(pyg, ["62"]);
  const tributos = S(pyg, ["63"], ["630", "633", "638"]);
  const personal = S(pyg, ["64"]);
  const otrosGastos = S(pyg, ["65"]);
  const cta771 = -S(pyg, ["771"]);
  const MB = VN - consumos;
  const EBITDA = VN + otrosIngresos + cta771 - consumos - servicios - tributos - personal - otrosGastos;
  const amortizaciones = S(pyg, ["68"]);
  const deterioros = S(pyg, ["69", "79"]);
  const EBIT = EBITDA - amortizaciones - deterioros;
  const ingresosFin = -S(pyg, ["76"]);
  const F = S(pyg, ["66"]);
  const BNO = EBIT + ingresosFin - F;
  const extraordinarios = -S(pyg, ["67", "77"], ["771"]);
  const BAI = BNO + extraordinarios;
  const impuesto = S(pyg, ["630", "633", "638"]);
  const BN = BAI - impuesto;

  return {
    dias,
    balance: { AF, E, clientes, R, T, AC, A, K, RA, PC, D, FM, CP, proveedores },
    resultados: { VN, otrosIngresos, compras, consumos, MB, servicios, tributos, personal, otrosGastos, cta771, EBITDA, amortizaciones, EBIT, F, BNO, BAI, BN },
  };
}

function diasEntre(d1, d2) {
  return Math.round((new Date(`${d2}T00:00:00Z`) - new Date(`${d1}T00:00:00Z`)) / 86400000) + 1;
}

function suma(m, k, v) {
  m.set(k, (m.get(k) || 0) + v);
}

/**
 * Una pasada de movs. de contabilidad: ventas/consumos de ayer + masas
 * del mes actual (hasta ayer) y del mes anterior completo.
 */
async function leerContabilidad(periodos) {
  const id = empresaId();
  if (!id) throw new Error("Falta BC_COMPANY_ID para el informe diario financiero");
  const token = await obtenerTokenBC();
  const corte = periodos.mesActual.hasta > periodos.mesAnterior.hasta ? periodos.mesActual.hasta : periodos.mesAnterior.hasta;
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${id})/generalLedgerEntries`;
  let url = `${base}?$select=postingDate,accountNumber,debitAmount,creditAmount,documentNumber&$filter=${encodeURIComponent(`postingDate le ${corte}`)}`;

  const balActual = new Map();
  const balAnterior = new Map();
  const pygAyer = new Map();
  const pygActual = new Map();
  const pygAnterior = new Map();
  const docs3112 = new Map();
  let n = 0;

  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`BC respondió ${r.status} leyendo contabilidad: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    for (const e of j.value || []) {
      n++;
      const cta = String(e.accountNumber || "");
      const f = String(e.postingDate || "").slice(0, 10);
      const v = (Number(e.debitAmount) || 0) - (Number(e.creditAmount) || 0);
      const esPyg = cta.startsWith("6") || cta.startsWith("7");
      if (f <= periodos.mesActual.hasta) suma(balActual, cta, v);
      if (f <= periodos.mesAnterior.hasta) suma(balAnterior, cta, v);
      if (f.endsWith("-12-31")) {
        const k = `${e.documentNumber}|${f}`;
        if (!docs3112.has(k)) docs3112.set(k, { tiene129: false, movs: [] });
        const d = docs3112.get(k);
        if (cta.startsWith("129")) d.tiene129 = true;
        if (esPyg) d.movs.push([cta, v, f]);
      }
      if (!esPyg) continue;
      if (f >= periodos.ayer.desde && f <= periodos.ayer.hasta) suma(pygAyer, cta, v);
      if (f >= periodos.mesActual.desde && f <= periodos.mesActual.hasta) suma(pygActual, cta, v);
      if (f >= periodos.mesAnterior.desde && f <= periodos.mesAnterior.hasta) suma(pygAnterior, cta, v);
    }
    url = j["@odata.nextLink"] || null;
  }

  for (const d of docs3112.values()) {
    if (!d.tiene129) continue;
    for (const [cta, v, f] of d.movs) {
      if (f >= periodos.ayer.desde && f <= periodos.ayer.hasta) suma(pygAyer, cta, -v);
      if (f >= periodos.mesActual.desde && f <= periodos.mesActual.hasta) suma(pygActual, cta, -v);
      if (f >= periodos.mesAnterior.desde && f <= periodos.mesAnterior.hasta) suma(pygAnterior, cta, -v);
    }
  }

  const ventas = (pyg) => -S(pyg, ["70"]);
  const consumos = (pyg) => S(pyg, ["60", "61"]);

  return {
    movimientos: n,
    ventas: {
      ayer: ventas(pygAyer),
      mesActual: ventas(pygActual),
      mesAnterior: ventas(pygAnterior),
    },
    consumos: {
      ayer: consumos(pygAyer),
      mesActual: consumos(pygActual),
      mesAnterior: consumos(pygAnterior),
    },
    ratiosActual: masas(balActual, pygActual, diasEntre(periodos.mesActual.desde, periodos.mesActual.hasta)),
    ratiosAnterior: masas(balAnterior, pygAnterior, diasEntre(periodos.mesAnterior.desde, periodos.mesAnterior.hasta)),
  };
}

async function sumarFacturasCompra(periodos) {
  const id = empresaId();
  const token = await obtenerTokenBC();
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${id})`;
  const desde = periodos.mesAnterior.desde;
  const hasta = periodos.mesActual.hasta;
  const filtro = encodeURIComponent(`invoiceDate ge ${desde} and invoiceDate le ${hasta}`);
  let url = `${raiz}/purchaseInvoices?$select=invoiceDate,totalAmountExcludingTax,status&$filter=${filtro}`;
  const tot = { ayer: 0, mesActual: 0, mesAnterior: 0, nAyer: 0, nMesActual: 0, nMesAnterior: 0 };
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`BC respondió ${r.status} leyendo facturas de compra: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    for (const f of j.value || []) {
      const fecha = String(f.invoiceDate || "").slice(0, 10);
      const imp = Number(f.totalAmountExcludingTax) || 0;
      if (fecha >= periodos.ayer.desde && fecha <= periodos.ayer.hasta) {
        tot.ayer += imp;
        tot.nAyer++;
      }
      if (fecha >= periodos.mesActual.desde && fecha <= periodos.mesActual.hasta) {
        tot.mesActual += imp;
        tot.nMesActual++;
      }
      if (fecha >= periodos.mesAnterior.desde && fecha <= periodos.mesAnterior.hasta) {
        tot.mesAnterior += imp;
        tot.nMesAnterior++;
      }
    }
    url = j["@odata.nextLink"] || null;
  }
  return tot;
}

function filaRatio(nombre, actual, anterior) {
  return `<tr>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(nombre)}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${esc(eur(actual))}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${esc(eur(anterior))}</td>
</tr>`;
}

function htmlInforme({ periodos, contab, facturas, empresa }) {
  const th = "text-align:left;padding:6px 8px;border-bottom:1px solid #cbd5e1;background:#f1f5f9;font-size:12px";
  const td = "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px";
  const tdR = td + ";text-align:right;white-space:nowrap";
  const ra = contab.ratiosActual.resultados;
  const ba = contab.ratiosActual.balance;
  const rb = contab.ratiosAnterior.resultados;
  const bb = contab.ratiosAnterior.balance;

  const filasRatios = [
    filaRatio("Ventas netas", ra.VN, rb.VN),
    filaRatio("Consumos (60/61)", ra.consumos, rb.consumos),
    filaRatio("Otros ingresos", ra.otrosIngresos, rb.otrosIngresos),
    filaRatio("Servicios exteriores", ra.servicios, rb.servicios),
    filaRatio("Gastos de personal", ra.personal, rb.personal),
    filaRatio("EBITDA", ra.EBITDA, rb.EBITDA),
    filaRatio("Beneficio de explotación (EBIT)", ra.EBIT, rb.EBIT),
    filaRatio("Beneficio líquido (BN)", ra.BN, rb.BN),
    filaRatio("Activo total", ba.A, bb.A),
    filaRatio("Patrimonio neto", ba.K, bb.K),
    filaRatio("Activo circulante", ba.AC, bb.AC),
    filaRatio("Pasivo corriente", ba.PC, bb.PC),
    filaRatio("Tesorería", ba.T, bb.T),
    filaRatio("Fondo de maniobra", ba.FM, bb.FM),
    filaRatio("Endeudamiento (deuda total)", ba.D, bb.D),
    filaRatio("Clientes", ba.clientes, bb.clientes),
    filaRatio("Proveedores", ba.proveedores, bb.proveedores),
  ].join("");

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b">
<p>Buenos días,</p>
<p>Diario financiero de <b>${esc(empresa)}</b> a ${esc(fechaCorta(periodos.hoy))}.</p>

<h3 style="margin:18px 0 8px;font-size:15px">1. Ventas netas (contabilidad, cuentas 70)</h3>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Periodo</th>
<th style="${th};text-align:right">Importe</th>
</tr></thead>
<tbody>
<tr><td style="${td}">Ayer (${esc(periodos.ayer.etiqueta)})</td><td style="${tdR}">${esc(eur(contab.ventas.ayer))}</td></tr>
<tr><td style="${td}">Mes actual (${esc(periodos.mesActual.etiqueta)})</td><td style="${tdR}">${esc(eur(contab.ventas.mesActual))}</td></tr>
<tr><td style="${td}">Mes anterior (${esc(periodos.mesAnterior.etiqueta)})</td><td style="${tdR}">${esc(eur(contab.ventas.mesAnterior))}</td></tr>
</tbody></table>

<h3 style="margin:18px 0 8px;font-size:15px">2. Facturas de compra (historial BC, sin IVA)</h3>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Periodo</th>
<th style="${th};text-align:right">Importe</th>
<th style="${th};text-align:right">Nº facturas</th>
</tr></thead>
<tbody>
<tr><td style="${td}">Ayer (${esc(periodos.ayer.etiqueta)})</td><td style="${tdR}">${esc(eur(facturas.ayer))}</td><td style="${tdR}">${facturas.nAyer}</td></tr>
<tr><td style="${td}">Mes actual (${esc(periodos.mesActual.etiqueta)})</td><td style="${tdR}">${esc(eur(facturas.mesActual))}</td><td style="${tdR}">${facturas.nMesActual}</td></tr>
<tr><td style="${td}">Mes anterior (${esc(periodos.mesAnterior.etiqueta)})</td><td style="${tdR}">${esc(eur(facturas.mesAnterior))}</td><td style="${tdR}">${facturas.nMesAnterior}</td></tr>
</tbody></table>

<h3 style="margin:18px 0 8px;font-size:15px">3. Ratios financieros en importes</h3>
<p style="margin:0 0 8px;color:#475569;font-size:13px">Mes actual (${esc(periodos.mesActual.etiqueta)}) frente a mes anterior (${esc(periodos.mesAnterior.etiqueta)}). Cifras en euros, no en %.</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Indicador</th>
<th style="${th};text-align:right">Mes actual</th>
<th style="${th};text-align:right">Mes anterior</th>
</tr></thead>
<tbody>${filasRatios}</tbody>
</table>

<p style="margin-top:18px;color:#64748b;font-size:12px">Ventas y ratios salen de los movimientos de contabilidad de Business Central (mismas fórmulas que la pantalla Ratios). Las facturas de compra son el historial de BC (totalAmountExcludingTax). Asientos de cierre 31/12 excluidos de la cuenta de resultados.</p>
<p>Un saludo,<br>ACSales</p>
</div>`;
}

async function preparar({ fechaHoy } = {}) {
  const hoy = fechaHoy || hoyMadrid().fecha;
  const periodos = periodosDesdeHoy(hoy);
  const [contab, facturas] = await Promise.all([leerContabilidad(periodos), sumarFacturasCompra(periodos)]);
  const empresa = empresaNombre();
  const asunto = `Diario financiero — ${fechaCorta(hoy)} · ${empresa}`;
  return {
    fechaHoy: hoy,
    periodos,
    empresa,
    contab,
    facturas,
    asunto,
    html: htmlInforme({ periodos, contab, facturas, empresa }),
  };
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
    throw new Error(`Graph respondió ${r.status} al enviar el diario financiero: ${detalle}`);
  }
  return { de, para };
}

async function enviar({ db, fechaHoy, marcar = false } = {}) {
  const informe = await preparar({ fechaHoy });
  const para = destinatario();
  const envio = await enviarCorreo({ asunto: informe.asunto, html: informe.html, para });
  if (marcar && db) {
    await db.setDoc(CLAVE_ESTADO, {
      ultimo: informe.fechaHoy,
      para,
      ventasAyer: informe.contab.ventas.ayer,
      comprasAyer: informe.facturas.ayer,
      ts: new Date().toISOString(),
    });
  }
  return {
    ...envio,
    asunto: informe.asunto,
    fechaHoy: informe.fechaHoy,
    ventas: informe.contab.ventas,
    facturas: {
      ayer: informe.facturas.ayer,
      mesActual: informe.facturas.mesActual,
      mesAnterior: informe.facturas.mesAnterior,
    },
  };
}

function programar({ db }) {
  if (String(process.env.INFORME_DIARIO_OFF || "").trim() === "1") {
    console.log("[informe-diario] Desactivado (INFORME_DIARIO_OFF=1)");
    return;
  }
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
      console.log(`[informe-diario] ${r.fechaHoy} ventas ayer ${eur(r.ventas.ayer)} · compras ayer ${eur(r.facturas.ayer)} → ${r.para}`);
    } catch (err) {
      console.error("[informe-diario]", err.message || err);
    }
  };
  setTimeout(tick, 45000);
  setInterval(tick, 60 * 1000);
  console.log(`[informe-diario] Cada día a las ${String(hora).padStart(2, "0")}:00 (Europe/Madrid) → ${destinatario()}`);
}

module.exports = { preparar, enviar, programar, periodosDesdeHoy };
