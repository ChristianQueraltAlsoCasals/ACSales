/**
 * Informe diario por correo: ventas, facturas de compra y ratios
 * financieros en importes (€), no en porcentajes.
 *
 * Punto muerto (gráfico de líneas al inicio) — previsión del cierre:
 * - Fórmula: CF / (1 − CV/VN), igual que Ratios.
 * - Día 1: media de los PM de los 12 meses anteriores.
 * - Durante el mes: previsión de cómo terminaremos (ritmo de CF + margen MTD);
 *   puede subir o bajar según el momento.
 * - Tras el 30/31: converge al PM real; si los gastos contabilizados (CV+CF)
 *   ya superan ese PM teórico, el listón sube a esos gastos (realidad).
 * - Ventana: día 1 del mes observado → día 15 del mes siguiente.
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
const macro = require("./macro.cjs");

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
  const v = Object.is(n, -0) || Math.abs(n) < 0.0005 ? 0 : n;
  return v.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
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

function sumarDias(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

function minFecha(a, b) {
  return a <= b ? a : b;
}

function maxFecha(a, b) {
  return a >= b ? a : b;
}

/** 12 meses calendario cerrados hasta isoHasta (incluido). */
function mesesCerradosHasta(isoHasta, n = 12) {
  const out = [];
  let d = primerDiaMes(isoHasta);
  for (let i = 0; i < n; i++) {
    const hasta = ultimoDiaMes(d);
    out.unshift({ key: d.slice(0, 7), desde: d, hasta, dias: diasEntre(d, hasta) });
    d = primerDiaMes(restarDias(d, 1));
  }
  return out;
}

/**
 * Ventana del punto muerto: gastos del mes calendario anterior a «hoy»;
 * seguimiento de ventas acumuladas hasta el día 15 del mes en curso.
 * Base al día 1 = media de los 12 meses anteriores al observado.
 */
function ventanaObservacionPuntoMuerto(fechaHoy) {
  const mesCalDesde = primerDiaMes(fechaHoy);
  const mesObsRef = restarDias(mesCalDesde, 1);
  const desde = primerDiaMes(mesObsRef);
  const finMesObs = ultimoDiaMes(mesObsRef);
  const hasta = `${fechaHoy.slice(0, 7)}-15`; // día 15 del mes de «hoy» = mes siguiente al observado
  const ayer = restarDias(fechaHoy, 1);
  const cerrado = fechaHoy > hasta;
  const corteDatos = minFecha(ayer, hasta);
  // Mes anterior al observado (referencia) + 12 meses para la media base.
  const prevRef = restarDias(desde, 1);
  const prevDesde = primerDiaMes(prevRef);
  const prevHasta = ultimoDiaMes(prevRef);
  const mesesBase = mesesCerradosHasta(prevHasta, 12);
  const baseDesde = mesesBase[0].desde;
  const baseHasta = prevHasta;
  return {
    desde,
    hasta,
    finMesObs,
    corteDatos,
    cerrado,
    prevDesde,
    prevHasta,
    baseDesde,
    baseHasta,
    mesesBase,
    etiquetaMes: mesEtiqueta(desde, finMesObs),
    etiquetaMesPrev: mesEtiqueta(prevDesde, prevHasta),
    etiquetaBase: `media 12 m (${fechaCorta(baseDesde)} – ${fechaCorta(baseHasta)})`,
    etiquetaVentana: `${fechaCorta(desde)} → ${fechaCorta(hasta)}`,
    diasMesObs: diasEntre(desde, finMesObs),
    diasMesPrev: diasEntre(prevDesde, prevHasta),
  };
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
    puntoMuerto: ventanaObservacionPuntoMuerto(fechaHoy),
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
  // Costes variables ≈ consumos; costes fijos ≈ resto de gastos de explotación (igual que Ratios).
  const CV = consumos;
  const CF = servicios + tributos + personal + otrosGastos + amortizaciones;

  return {
    dias,
    balance: { AF, E, clientes, R, T, AC, A, K, RA, PC, D, FM, CP, proveedores },
    resultados: { VN, otrosIngresos, compras, consumos, MB, servicios, tributos, personal, otrosGastos, cta771, EBITDA, amortizaciones, EBIT, F, BNO, BAI, BN, CV, CF },
  };
}

/** Punto muerto operativo (break-even): CF / (1 − CV/VN). Misma fórmula que Ratios. */
function puntoMuerto(r) {
  const vn = Number(r?.VN) || 0;
  const cv = Number(r?.CV ?? r?.consumos) || 0;
  const cf = Number(r?.CF) || 0;
  if (!(vn > 0) || !(cf > 0)) return { pm: null, cobertura: null, margen: null, cf, cv, vn, holgura: null };
  const cvUnit = cv / vn;
  if (!(cvUnit < 1)) return { pm: null, cobertura: null, margen: null, cf, cv, vn, holgura: null };
  const margen = 1 - cvUnit;
  const pm = cf / margen;
  const cobertura = pm > 0 ? vn / pm : null;
  return { pm, cobertura, margen, cf, cv, vn, holgura: vn - pm };
}

/** ¿La cuenta entra en costes fijos del punto muerto? (igual que Ratios: 62–65, 68). */
function esCosteFijoPm(cta) {
  if (cta.startsWith("62") || cta.startsWith("64") || cta.startsWith("65") || cta.startsWith("68")) return true;
  if (cta.startsWith("63") && !cta.startsWith("630") && !cta.startsWith("633") && !cta.startsWith("638")) return true;
  return false;
}

function diasEntre(d1, d2) {
  return Math.round((new Date(`${d2}T00:00:00Z`) - new Date(`${d1}T00:00:00Z`)) / 86400000) + 1;
}

function suma(m, k, v) {
  m.set(k, (m.get(k) || 0) + v);
}

/**
 * Una pasada de movs. de contabilidad: ventas/consumos de ayer + masas
 * del mes actual / anterior + serie diaria de la ventana del punto muerto.
 */
async function leerContabilidad(periodos) {
  const id = empresaId();
  if (!id) throw new Error("Falta BC_COMPANY_ID para el informe diario financiero");
  const token = await obtenerTokenBC();
  const ven = periodos.puntoMuerto;
  const corte = maxFecha(periodos.mesActual.hasta, ven.corteDatos);
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${id})/generalLedgerEntries`;
  let url = `${base}?$select=postingDate,accountNumber,debitAmount,creditAmount,documentNumber,documentType&$filter=${encodeURIComponent(`postingDate le ${corte}`)}`;

  const balActual = new Map();
  const balAnterior = new Map();
  const balObs = new Map();
  const balPrev = new Map(); // mes anterior al observado (referencia)
  const pygAyer = new Map();
  const pygActual = new Map();
  const pygAnterior = new Map();
  const pygObs = new Map(); // gastos/ingresos del mes observado
  const pygPrev = new Map(); // mes anterior al observado
  const pygPorMes = new Map(); // YYYY-MM → PyG (12 meses base del PM)
  const ventasDia = new Map(); // ventas netas (cta 70) por día en la ventana
  const cvDia = new Map(); // consumos (60/61) por día — margen MTD
  const cfDia = new Map(); // costes fijos del PM por día (solo mes observado)

  function pygMes(clave) {
    if (!pygPorMes.has(clave)) pygPorMes.set(clave, new Map());
    return pygPorMes.get(clave);
  }
  const cobros = vacioCobrosPagos();
  const pagos = vacioCobrosPagos();
  const docsCobro = { ayer: new Set(), mesActual: new Set(), mesAnterior: new Set() };
  const docsPago = { ayer: new Set(), mesActual: new Set(), mesAnterior: new Set() };
  const docs3112 = new Map();
  let n = 0;

  function registrarMovCartera(tot, docs, periodos, fecha, doc, importe) {
    if (!(importe > 0) || !fecha) return;
    if (fecha >= periodos.ayer.desde && fecha <= periodos.ayer.hasta) {
      tot.ayer += importe;
      if (doc) docs.ayer.add(doc);
    }
    if (fecha >= periodos.mesActual.desde && fecha <= periodos.mesActual.hasta) {
      tot.mesActual += importe;
      if (doc) docs.mesActual.add(doc);
    }
    if (fecha >= periodos.mesAnterior.desde && fecha <= periodos.mesAnterior.hasta) {
      tot.mesAnterior += importe;
      if (doc) docs.mesAnterior.add(doc);
    }
  }

  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`BC respondió ${r.status} leyendo contabilidad: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    for (const e of j.value || []) {
      n++;
      const cta = String(e.accountNumber || "");
      const f = String(e.postingDate || "").slice(0, 10);
      const debe = Number(e.debitAmount) || 0;
      const haber = Number(e.creditAmount) || 0;
      const v = debe - haber;
      const esPyg = cta.startsWith("6") || cta.startsWith("7");
      const docTipo = String(e.documentType || "").trim();
      const docNo = String(e.documentNumber || "").trim();
      if (f <= periodos.mesActual.hasta) suma(balActual, cta, v);
      if (f <= periodos.mesAnterior.hasta) suma(balAnterior, cta, v);
      if (f <= ven.finMesObs) suma(balObs, cta, v);
      if (f <= ven.prevHasta) suma(balPrev, cta, v);
      // Cobros: Payment que abona clientes (43*). Pagos: Payment que carga proveedores/acreedores (40*/41*).
      if (/^payment$/i.test(docTipo) && f >= periodos.mesAnterior.desde && f <= periodos.mesActual.hasta) {
        if (cta.startsWith("43")) {
          const cobro = haber - debe;
          if (cobro > 0) registrarMovCartera(cobros, docsCobro, periodos, f, docNo, cobro);
        } else if (cta.startsWith("40") || cta.startsWith("41")) {
          const pago = debe - haber;
          if (pago > 0) registrarMovCartera(pagos, docsPago, periodos, f, docNo, pago);
        }
      }
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
      if (f >= ven.desde && f <= ven.finMesObs) suma(pygObs, cta, v);
      if (f >= ven.prevDesde && f <= ven.prevHasta) suma(pygPrev, cta, v);
      if (f >= ven.baseDesde && f <= ven.baseHasta) suma(pygMes(f.slice(0, 7)), cta, v);
      if (f >= ven.desde && f <= ven.corteDatos) {
        if (cta.startsWith("70")) suma(ventasDia, f, -v); // venta del día = −(debe−haber)
        if ((cta.startsWith("60") || cta.startsWith("61")) && f <= ven.finMesObs) suma(cvDia, f, v);
        // CF del mes observado (nóminas/gastos); no mezclar días del mes siguiente
        if (esCosteFijoPm(cta) && f <= ven.finMesObs) suma(cfDia, f, v);
      }
    }
    url = j["@odata.nextLink"] || null;
  }
  cobros.nAyer = docsCobro.ayer.size;
  cobros.nMesActual = docsCobro.mesActual.size;
  cobros.nMesAnterior = docsCobro.mesAnterior.size;
  pagos.nAyer = docsPago.ayer.size;
  pagos.nMesActual = docsPago.mesActual.size;
  pagos.nMesAnterior = docsPago.mesAnterior.size;

  for (const d of docs3112.values()) {
    if (!d.tiene129) continue;
    for (const [cta, v, f] of d.movs) {
      if (f >= periodos.ayer.desde && f <= periodos.ayer.hasta) suma(pygAyer, cta, -v);
      if (f >= periodos.mesActual.desde && f <= periodos.mesActual.hasta) suma(pygActual, cta, -v);
      if (f >= periodos.mesAnterior.desde && f <= periodos.mesAnterior.hasta) suma(pygAnterior, cta, -v);
      if (f >= ven.desde && f <= ven.finMesObs) suma(pygObs, cta, -v);
      if (f >= ven.prevDesde && f <= ven.prevHasta) suma(pygPrev, cta, -v);
      if (f >= ven.baseDesde && f <= ven.baseHasta) suma(pygMes(f.slice(0, 7)), cta, -v);
      if (f >= ven.desde && f <= ven.corteDatos) {
        if (cta.startsWith("70")) suma(ventasDia, f, v);
        if ((cta.startsWith("60") || cta.startsWith("61")) && f <= ven.finMesObs) suma(cvDia, f, -v);
        if (esCosteFijoPm(cta) && f <= ven.finMesObs) suma(cfDia, f, -v);
      }
    }
  }

  const ventas = (pyg) => -S(pyg, ["70"]);
  const consumos = (pyg) => S(pyg, ["60", "61"]);
  const masasObs = masas(balObs, pygObs, ven.diasMesObs || diasEntre(ven.desde, ven.finMesObs));
  const masasPrev = masas(balPrev, pygPrev, ven.diasMesPrev || diasEntre(ven.prevDesde, ven.prevHasta));
  const pmObs = puntoMuerto(masasObs.resultados);
  const pmPrev = puntoMuerto(masasPrev.resultados);

  // Media de PM (CF/margen) de los 12 meses anteriores = base / referencia.
  const pmsAnio = [];
  const cfsAnio = [];
  const margenesAnio = [];
  let sumaRitmoCf = 0;
  let nRitmo = 0;
  for (const m of ven.mesesBase || []) {
    const r = masas(new Map(), pygPorMes.get(m.key) || new Map(), m.dias).resultados;
    const pmM = puntoMuerto(r);
    if (pmM.pm != null && pmM.pm > 0) pmsAnio.push(pmM.pm);
    if (pmM.cf > 0) {
      cfsAnio.push(pmM.cf);
      sumaRitmoCf += pmM.cf / m.dias;
      nRitmo++;
    }
    if (pmM.margen != null && pmM.margen > 0) margenesAnio.push(pmM.margen);
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const pmMediaAnio = avg(pmsAnio);
  const cfMediaAnio = avg(cfsAnio);
  const margenMediaAnio = avg(margenesAnio);
  const ritmoCfRef = nRitmo > 0 ? sumaRitmoCf / nRitmo : null;

  const pmInicio = pmMediaAnio != null ? pmMediaAnio : pmPrev.pm;
  const margenRef =
    margenMediaAnio != null && margenMediaAnio > 0
      ? margenMediaAnio
      : pmPrev.margen != null && pmPrev.margen > 0
        ? pmPrev.margen
        : pmObs.margen;
  const margenReal = pmObs.margen != null && pmObs.margen > 0 ? pmObs.margen : margenRef;
  const diasMes = ven.diasMesObs || 30;
  const diasConvergencia = Math.min(5, Math.max(1, diasEntre(sumarDias(ven.finMesObs, 1), ven.hasta)));
  const margenMin = Math.max(0.18, (margenRef || 0.35) * 0.55);

  // Serie: previsión del PM al cierre (puede subir y bajar).
  const labels = [];
  const acumVentas = [];
  const lineaPm = [];
  let acumV = 0;
  let acumCvMes = 0;
  let acumCfMes = 0;
  let pmPrevDia = pmInicio;
  let pmUltimoEnMes = pmInicio;
  let pmActual = null;
  let tendenciaActual = null;
  let fase = "inicio";

  for (let d = ven.desde; d <= ven.hasta; d = sumarDias(d, 1)) {
    const dia = Number(d.slice(8, 10));
    labels.push(dia === 1 || dia === 15 || d === ven.corteDatos || d === ven.hasta || d === ven.finMesObs ? fechaCorta(d) : "");
    if (d <= ven.corteDatos) {
      acumV += ventasDia.get(d) || 0;
      if (d <= ven.finMesObs) {
        acumCfMes += cfDia.get(d) || 0;
        acumCvMes += cvDia.get(d) || 0;
      }
      acumVentas.push(Math.round(acumV));

      let pmDia = null;
      if (d <= ven.finMesObs) {
        const diasTrans = Math.max(1, diasEntre(ven.desde, d));
        const ritmoCf =
          ritmoCfRef != null && ritmoCfRef > 0 && acumCfMes > 0
            ? acumCfMes / diasTrans / ritmoCfRef
            : null;
        tendenciaActual = ritmoCf != null ? ritmoCf - 1 : null;

        // Margen MTD solo si es creíble; si no, media anual / mes anterior.
        let margenMtd = margenRef;
        if (acumV > 0 && acumCvMes >= 0 && acumCvMes < acumV) {
          const m = 1 - acumCvMes / acumV;
          if (m >= margenMin) margenMtd = m;
        }

        // Previsión a fin de mes: CF proyectado / margen del momento.
        let pmProy = null;
        if (margenMtd != null && margenMtd > 0 && acumCfMes > 0 && diasTrans >= 3) {
          const cfProy = (acumCfMes / diasTrans) * diasMes;
          pmProy = cfProy / margenMtd;
        }

        // Peso de la previsión vs la base: al inicio confía más en la media anual.
        const pesoProy = Math.min(1, Math.max(0, (diasTrans - 2) / Math.max(1, diasMes - 2)));

        const acumGastos = acumCvMes + acumCfMes; // realidad ya contabilizada

        if (pmInicio != null && pmInicio > 0) {
          if (pmProy != null) {
            pmDia = pmInicio * (1 - pesoProy) + pmProy * pesoProy;
            // Bandas suaves (±25 %) frente a la media anual; la realidad de gastos puede superarlas.
            pmDia = Math.max(pmInicio * 0.75, Math.min(pmInicio * 1.25, pmDia));
            fase = "tendencia";
          } else {
            pmDia = pmInicio;
            fase = diasTrans < 3 ? "inicio" : "tendencia";
          }
        } else if (pmProy != null) {
          pmDia = pmProy;
          fase = "tendencia";
        }

        // Si los gastos ya superan la previsión, el PM sube a esa realidad.
        if (pmDia != null && acumGastos > pmDia) pmDia = acumGastos;
        else if (pmDia == null && acumGastos > 0) pmDia = acumGastos;

        // Suavizado leve (deja ver subidas y bajadas, sin dientes de sierra).
        if (pmDia != null && pmPrevDia != null && diasTrans >= 3) {
          pmDia = 0.55 * pmPrevDia + 0.45 * pmDia;
          if (acumGastos > pmDia) pmDia = acumGastos; // no suavizar por debajo de lo ya gastado
        }
        if (pmDia != null) {
          pmPrevDia = pmDia;
          pmUltimoEnMes = pmDia;
        }
      } else {
        // Tras el cierre: PM teórico (CF/margen), pero nunca por debajo de los gastos reales.
        const acumGastos = acumCvMes + acumCfMes;
        const cfReal = acumCfMes > 0 ? acumCfMes : pmObs.cf;
        const pmTeorico =
          margenReal != null && margenReal > 0 && cfReal > 0 ? cfReal / margenReal : pmObs.pm;
        const gastosReal =
          acumGastos > 0 ? acumGastos : (pmObs.cv || 0) + (pmObs.cf || 0);
        const pmReal =
          pmTeorico != null && gastosReal > 0
            ? Math.max(pmTeorico, gastosReal)
            : pmTeorico != null
              ? pmTeorico
              : gastosReal > 0
                ? gastosReal
                : null;
        const baseCierre = pmUltimoEnMes != null ? pmUltimoEnMes : pmInicio;
        const diasPost = diasEntre(sumarDias(ven.finMesObs, 1), d);
        const alpha = Math.min(1, Math.max(0, diasPost / diasConvergencia));
        if (baseCierre != null && pmReal != null) {
          pmDia = (1 - alpha) * baseCierre + alpha * pmReal;
        } else {
          pmDia = pmReal != null ? pmReal : baseCierre;
        }
        // Tras el cierre, no quedar por debajo de lo ya gastado.
        if (pmDia != null && gastosReal > pmDia) pmDia = gastosReal;
        if (ritmoCfRef != null && ritmoCfRef > 0 && acumCfMes > 0) {
          tendenciaActual = acumCfMes / diasMes / ritmoCfRef - 1;
        } else if (pmInicio != null && pmInicio > 0 && pmReal != null) {
          tendenciaActual = pmReal / pmInicio - 1;
        }
        fase = "convergencia";
        if (pmDia != null) pmPrevDia = pmDia;
      }

      pmActual = pmDia;
      lineaPm.push(pmDia != null ? Math.round(pmDia) : null);
    } else {
      acumVentas.push(null);
      lineaPm.push(pmActual != null ? Math.round(pmActual) : null);
    }
  }

  const ventasAcum = ven.corteDatos >= ven.desde ? acumV : 0;
  const gastosMes = acumCvMes + acumCfMes > 0 ? acumCvMes + acumCfMes : (pmObs.cv || 0) + (pmObs.cf || 0);
  const pmTeoricoMes = pmObs.pm;
  // Realidad: si los gastos del mes superan el PM teórico, el listón es ese gasto.
  const pmMesObs =
    pmTeoricoMes != null && gastosMes > 0
      ? Math.max(pmTeoricoMes, gastosMes)
      : pmTeoricoMes != null
        ? pmTeoricoMes
        : gastosMes > 0
          ? gastosMes
          : null;
  if (pmActual == null) pmActual = pmMesObs != null ? pmMesObs : pmInicio;
  if (pmActual != null && gastosMes > pmActual) pmActual = gastosMes;
  const cobertura = pmActual != null && pmActual > 0 ? ventasAcum / pmActual : null;

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
    puntoMuerto: {
      ...ven,
      pm: pmActual,
      pmInicio,
      pmMesObs,
      pmTeorico: pmTeoricoMes,
      gastos: gastosMes,
      pmPrev: pmPrev.pm,
      pmMediaAnio,
      nMesesBase: pmsAnio.length,
      cf: acumCfMes > 0 ? acumCfMes : pmObs.cf,
      cfMesObs: pmObs.cf,
      cfMediaAnio,
      cv: pmObs.cv,
      vnMes: pmObs.vn,
      margen: margenReal != null ? margenReal : margenRef,
      margenRef,
      ventasAcum,
      cobertura,
      holgura: pmActual != null ? ventasAcum - pmActual : null,
      tendencia: tendenciaActual,
      fase,
      serie: { labels, acumVentas, lineaPm },
    },
    tesoreria: { cobros, pagos, aviso: "" },
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

function vacioCobrosPagos() {
  return { ayer: 0, mesActual: 0, mesAnterior: 0, nAyer: 0, nMesActual: 0, nMesAnterior: 0 };
}

function filaRatio(nombre, actual, anterior) {
  return `<tr>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(nombre)}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${esc(eur(actual))}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${esc(eur(anterior))}</td>
</tr>`;
}

function indPorId(lista, id) {
  return (lista || []).find((i) => i.id === id) || null;
}

function filaMacro(nombre, valor, periodo, fuente) {
  return `<tr>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(nombre)}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">${esc(valor || "—")}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap;color:#64748b;font-size:12px">${esc(periodo || "")}</td>
<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${esc(fuente || "")}</td>
</tr>`;
}

async function prepararMacroEmail({ db }) {
  let lista = [];
  let actualizado = "";
  try {
    const datos = await macro.leerIndicadores(db);
    lista = datos.indicadores || [];
    actualizado = datos.actualizado || "";
  } catch (err) {
    console.warn("[informe-diario] macro:", err.message || err);
    lista = macro.INDICADORES_INICIALES || [];
  }
  const pick = (id) => indPorId(lista, id);
  return {
    actualizado,
    paroMes: pick("paro_mes"),
    paroMesAnt: pick("paro_mes_ant"),
    pib: pick("pib"),
    bce: pick("bce"),
    deficit: pick("deficit"),
    deuda: pick("deuda"),
  };
}

function htmlMacroYNoticia({ macroEmail }) {
  const th = "text-align:left;padding:6px 8px;border-bottom:1px solid #cbd5e1;background:#f1f5f9;font-size:12px";
  const m = macroEmail || {};
  const filas = [
    filaMacro(
      "Desempleo — mes en curso (paro registrado)",
      m.paroMes?.valor,
      m.paroMes?.fecha,
      m.paroMes?.fuente
    ),
    filaMacro(
      "Desempleo — mes anterior (paro registrado)",
      m.paroMesAnt?.valor,
      m.paroMesAnt?.fecha,
      m.paroMesAnt?.fuente
    ),
    filaMacro("PIB España", m.pib?.valor, m.pib?.fecha, m.pib?.fuente),
    filaMacro("Tipo de interés (BCE)", m.bce?.valor, m.bce?.fecha, m.bce?.fuente),
    filaMacro("Déficit público", m.deficit?.valor, m.deficit?.fecha, m.deficit?.fuente),
    filaMacro("Deuda pública", m.deuda?.valor, m.deuda?.fecha, m.deuda?.fuente),
  ].join("");

  return `
<h3 style="margin:18px 0 8px;font-size:15px">5. Indicadores macroeconómicos (España)</h3>
<p style="margin:0 0 8px;color:#475569;font-size:13px">Datos de referencia del cuadro macro de ACSales${m.actualizado ? ` · actualizado ${esc(m.actualizado)}` : ""}.</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Indicador</th>
<th style="${th}">Dato</th>
<th style="${th}">Periodo</th>
<th style="${th}">Fuente</th>
</tr></thead>
<tbody>${filas}</tbody>
</table>`;
}

/** URL de gráfico de líneas (QuickChart) — ventas acumuladas vs punto muerto. */
function urlGraficoLineasPuntoMuerto(pm) {
  if (!pm?.serie || pm.pm == null) return null;
  const config = {
    type: "line",
    data: {
      labels: pm.serie.labels,
      datasets: [
        {
          label: "Ventas acumuladas",
          data: pm.serie.acumVentas,
          borderColor: "#0f766e",
          backgroundColor: "rgba(15,118,110,0.12)",
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2.5,
          spanGaps: false,
        },
        {
          label: "Punto muerto (previsión)",
          data: pm.serie.lineaPm,
          borderColor: "#b45309",
          backgroundColor: "transparent",
          fill: false,
          borderDash: [7, 5],
          tension: 0.15,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      legend: { position: "bottom", labels: { fontSize: 11, fontColor: "#475569" } },
      title: {
        display: true,
        text: `Punto muerto · ${pm.etiquetaMes} → ${fechaCorta(pm.hasta)}`,
        fontSize: 14,
        fontColor: "#0f172a",
        padding: 8,
      },
      scales: {
        xAxes: [{ ticks: { fontSize: 9, fontColor: "#64748b", maxRotation: 0, autoSkip: false } }],
        yAxes: [
          {
            ticks: {
              fontSize: 10,
              fontColor: "#64748b",
              callback: (v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v),
            },
            gridLines: { color: "rgba(148,163,184,0.35)" },
          },
        ],
      },
    },
  };
  return `https://quickchart.io/chart?w=640&h=300&devicePixelRatio=2&c=${encodeURIComponent(JSON.stringify(config))}`;
}

/**
 * Bloque inicial: gráfico de líneas del punto muerto (gastos del mes
 * observado; seguimiento hasta el día 15 del mes siguiente).
 */
function htmlGraficoPuntoMuerto(pm) {
  if (!pm) {
    return `<p style="margin:0 0 16px;color:#64748b;font-size:13px">No hay datos de punto muerto.</p>`;
  }
  if (pm.pm == null) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 18px 0">
<tr><td style="padding:14px 16px">
<p style="margin:0 0 4px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.02em">Punto muerto · ${esc(pm.etiquetaMes)}</p>
<p style="margin:0;color:#64748b;font-size:13px">Aún no se puede fijar el punto muerto de ese mes (hacen falta ventas y margen sobre consumos en los gastos del mes).</p>
</td></tr></table>`;
  }

  const porEncima = pm.holgura != null && pm.holgura >= 0;
  const coberturaTxt =
    pm.cobertura != null
      ? pm.cobertura.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ×"
      : "—";
  const holguraTxt =
    pm.holgura == null ? "—" : (porEncima ? "Por encima " : "Faltan ") + eur(Math.abs(pm.holgura));
  const estadoTxt = pm.cerrado ? "Ventana cerrada" : `En curso hasta el ${fechaCorta(pm.hasta)}`;
  const tend = pm.tendencia;
  const tendTxt =
    tend == null || !Number.isFinite(tend)
      ? ""
      : ` · Tendencia ${tend >= 0 ? "+" : ""}${(tend * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} % vs media 12 m`;
  const faseTxt =
    pm.fase === "convergencia"
      ? "PM real del mes"
      : pm.fase === "tendencia"
        ? "Previsión a cierre"
        : "Inicio = media 12 meses";
  const chartUrl = urlGraficoLineasPuntoMuerto(pm);
  const img = chartUrl
    ? `<img src="${esc(chartUrl)}" width="640" alt="Gráfico punto muerto" style="display:block;width:100%;max-width:640px;height:auto;border:0;margin:10px 0 4px 0" />`
    : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 18px 0">
<tr><td style="padding:16px 18px">
<p style="margin:0 0 2px;font-size:12px;color:#64748b;letter-spacing:0.02em;text-transform:uppercase">Punto muerto · ${esc(pm.etiquetaMes)} · ${esc(faseTxt)}</p>
<p style="margin:0 0 2px;font-size:22px;font-weight:700;color:#0f172a">${esc(eur(pm.pm))}</p>
<p style="margin:0 0 8px;font-size:12px;color:#64748b">Ventana ${esc(pm.etiquetaVentana)} · ${esc(estadoTxt)}${pm.pmInicio != null ? ` · Base ${esc(pm.etiquetaBase || "media 12 m")} ${esc(eur(pm.pmInicio))}${pm.nMesesBase != null ? ` (${pm.nMesesBase} meses)` : ""}` : ""}${esc(tendTxt)}</p>
${img}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">
<tr>
<td style="width:25%;padding:8px 6px 0 0;vertical-align:top;border-top:1px solid #e2e8f0">
<div style="font-size:11px;color:#64748b">Ventas acum.</div>
<div style="font-size:15px;font-weight:700;color:#0f766e">${esc(eur(pm.ventasAcum))}</div>
</td>
<td style="width:25%;padding:8px 6px 0 6px;vertical-align:top;border-top:1px solid #e2e8f0">
<div style="font-size:11px;color:#64748b">Cobertura</div>
<div style="font-size:15px;font-weight:700;color:${porEncima ? "#0f766e" : "#b45309"}">${esc(coberturaTxt)}</div>
</td>
<td style="width:25%;padding:8px 6px 0 6px;vertical-align:top;border-top:1px solid #e2e8f0">
<div style="font-size:11px;color:#64748b">Holgura</div>
<div style="font-size:14px;font-weight:600;color:#0f172a">${esc(holguraTxt)}</div>
</td>
<td style="width:25%;padding:8px 0 0 6px;vertical-align:top;border-top:1px solid #e2e8f0">
<div style="font-size:11px;color:#64748b">Gastos mes</div>
<div style="font-size:14px;font-weight:600;color:#0f172a">${esc(eur(pm.gastos != null ? pm.gastos : pm.cf))}</div>
</td>
</tr>
</table>
<p style="margin:10px 0 0;font-size:11px;color:#94a3b8;line-height:1.45">La naranja es la previsión del punto muerto (CF ÷ margen): parte de la media de 12 meses y se adapta al ritmo del mes. Si los gastos ya contabilizados (consumos + costes fijos) superan esa previsión, el listón sube a esa realidad. Tras el 30/31 converge al cierre. La verde son las ventas acumuladas (cierre el día 15).</p>
</td></tr>
</table>`;
}

function htmlInforme({ periodos, contab, facturas, tesoreria, empresa, macroEmail }) {
  const th = "text-align:left;padding:6px 8px;border-bottom:1px solid #cbd5e1;background:#f1f5f9;font-size:12px";
  const td = "padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px";
  const tdR = td + ";text-align:right;white-space:nowrap";
  const ra = contab.ratiosActual.resultados;
  const rb = contab.ratiosAnterior.resultados;
  const cobros = tesoreria?.cobros || vacioCobrosPagos();
  const pagos = tesoreria?.pagos || vacioCobrosPagos();

  const filasRatios = [
    filaRatio("Ventas netas", ra.VN, rb.VN),
    filaRatio("Consumos (60/61)", ra.consumos, rb.consumos),
    filaRatio("Otros ingresos", ra.otrosIngresos, rb.otrosIngresos),
    filaRatio("Servicios exteriores", ra.servicios, rb.servicios),
    filaRatio("Gastos de personal", ra.personal, rb.personal),
    filaRatio("EBITDA", ra.EBITDA, rb.EBITDA),
    filaRatio("Beneficio de explotación (EBIT)", ra.EBIT, rb.EBIT),
    filaRatio("Beneficio líquido (BN)", ra.BN, rb.BN),
  ].join("");

  const bloquePm = htmlGraficoPuntoMuerto(contab.puntoMuerto);
  const netoMes = (cobros.mesActual || 0) - (pagos.mesActual || 0);
  const netoAnt = (cobros.mesAnterior || 0) - (pagos.mesAnterior || 0);

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b">
<p>Buenos días,</p>
<p>Diario financiero de <b>${esc(empresa)}</b> a ${esc(fechaCorta(periodos.hoy))}.</p>

${bloquePm}

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

<h3 style="margin:18px 0 8px;font-size:15px">3. Cobros de clientes y pagos a proveedores</h3>
<p style="margin:0 0 8px;color:#475569;font-size:13px">Contabilidad BC: documentos tipo Payment. Cobros = abonos en clientes (43*). Pagos = cargos en proveedores/acreedores (40*/41*).</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Concepto</th>
<th style="${th};text-align:right">Mes actual (${esc(periodos.mesActual.etiqueta)})</th>
<th style="${th};text-align:right">Mes anterior (${esc(periodos.mesAnterior.etiqueta)})</th>
</tr></thead>
<tbody>
<tr>
<td style="${td}">Cobros de clientes</td>
<td style="${tdR}">${esc(eur(cobros.mesActual))}<div style="font-size:11px;color:#94a3b8">${cobros.nMesActual} mov.</div></td>
<td style="${tdR}">${esc(eur(cobros.mesAnterior))}<div style="font-size:11px;color:#94a3b8">${cobros.nMesAnterior} mov.</div></td>
</tr>
<tr>
<td style="${td}">Pagos a proveedores</td>
<td style="${tdR}">${esc(eur(pagos.mesActual))}<div style="font-size:11px;color:#94a3b8">${pagos.nMesActual} mov.</div></td>
<td style="${tdR}">${esc(eur(pagos.mesAnterior))}<div style="font-size:11px;color:#94a3b8">${pagos.nMesAnterior} mov.</div></td>
</tr>
<tr>
<td style="${td}"><b>Neto (cobros − pagos)</b></td>
<td style="${tdR}"><b>${esc(eur(netoMes))}</b></td>
<td style="${tdR}"><b>${esc(eur(netoAnt))}</b></td>
</tr>
</tbody></table>
${tesoreria?.aviso ? `<p style="margin:6px 0 0;font-size:11px;color:#b45309">${esc(tesoreria.aviso)}</p>` : ""}

<h3 style="margin:18px 0 8px;font-size:15px">4. Ratios financieros en importes</h3>
<p style="margin:0 0 8px;color:#475569;font-size:13px">Mes actual (${esc(periodos.mesActual.etiqueta)}) frente a mes anterior (${esc(periodos.mesAnterior.etiqueta)}). Cifras en euros, no en %.</p>
<table style="border-collapse:collapse;width:100%">
<thead><tr>
<th style="${th}">Indicador</th>
<th style="${th};text-align:right">Mes actual</th>
<th style="${th};text-align:right">Mes anterior</th>
</tr></thead>
<tbody>${filasRatios}</tbody>
</table>

${htmlMacroYNoticia({ macroEmail })}

<p style="margin-top:18px;color:#64748b;font-size:12px">Ventas, ratios, cobros y pagos: movimientos de contabilidad BC (mismas fórmulas que Ratios). Facturas de compra: historial BC sin IVA. Macro: indicadores de ACSales (editables / actualizables desde Ratios). Asientos de cierre 31/12 excluidos de la cuenta de resultados.</p>
<p>Un saludo,<br>ACSales</p>
</div>`;
}

async function preparar({ fechaHoy, db } = {}) {
  const hoy = fechaHoy || hoyMadrid().fecha;
  const periodos = periodosDesdeHoy(hoy);
  const [contab, facturas, macroEmail] = await Promise.all([
    leerContabilidad(periodos),
    sumarFacturasCompra(periodos),
    db ? prepararMacroEmail({ db }) : prepararMacroEmail({ db: { getDoc: async () => ({}) } }),
  ]);
  const tesoreria = contab.tesoreria || { cobros: vacioCobrosPagos(), pagos: vacioCobrosPagos(), aviso: "" };
  const empresa = empresaNombre();
  const asunto = `Diario financiero — ${fechaCorta(hoy)} · ${empresa}`;
  return {
    fechaHoy: hoy,
    periodos,
    empresa,
    contab,
    facturas,
    tesoreria,
    macroEmail,
    asunto,
    html: htmlInforme({ periodos, contab, facturas, tesoreria, empresa, macroEmail }),
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
  const informe = await preparar({ fechaHoy, db });
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

module.exports = { preparar, enviar, programar, periodosDesdeHoy, ventanaObservacionPuntoMuerto };
