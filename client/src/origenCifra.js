/**
 * origenCifra.js — De dónde sale cada cifra de Ratios.
 * Las fórmulas son las mismas que grupos() en ratios.jsx y las tarjetas
 * de cuadroDireccion.jsx. Si cambia una, hay que cambiarla aquí.
 * No recalcula el balance: lee las masas ya calculadas y el detalle por cuenta.
 */

const div = (a, b) => (b && isFinite(a / b) ? a / b : null);

export function formatoOrigen(v, formato) {
  if (formato === "texto") return v == null || v === "" ? "—" : String(v);
  if (v == null || !isFinite(v)) return "—";
  if (formato === "eur") return v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  if (formato === "eur2") return v.toLocaleString("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (formato === "pct") return `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;
  if (formato === "dias") return `${Math.round(v).toLocaleString("es-ES")} días`;
  if (formato === "pp") return `${v.toLocaleString("es-ES", { maximumFractionDigits: 0 })} %`;
  return v.toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

const eur = (v) => formatoOrigen(v, "eur");
const num = (v) => formatoOrigen(v, "x");

export function deudaFinanciera(bal) {
  const prefs = ["16", "17", "520", "521", "522", "523", "524", "525", "526", "527", "528", "529"];
  let t = 0;
  for (const [k, v] of Object.entries(bal || {})) {
    if (prefs.some((p) => k.startsWith(p))) t += v;
  }
  return -t;
}

function notaAnual(dias) {
  const d = dias || 365;
  const anual = 365 / d;
  if (Math.abs(anual - 1) < 1e-9) return { anual: 1, texto: "" };
  return { anual, texto: ` El periodo tiene ${d} días, así que esta cifra se lleva a un año (se multiplica por 365 / ${d}).` };
}

function sumar(mapa, prefs, excluir, signo, nombres) {
  if (!mapa) return null;
  const excl = excluir || [];
  const cuentas = [];
  for (const [cta, raw] of Object.entries(mapa)) {
    if (!prefs.some((p) => String(cta).startsWith(p))) continue;
    if (excl.some((p) => String(cta).startsWith(p))) continue;
    const n = Number(raw);
    if (!isFinite(n)) continue;
    const importe = signo * n;
    if (Math.abs(importe) < 0.005) continue;
    cuentas.push({ cta: String(cta), nombre: (nombres && nombres[cta]) || "", importe });
  }
  cuentas.sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe) || a.cta.localeCompare(b.cta, "es"));
  return { cuentas, total: cuentas.reduce((s, x) => s + x.importe, 0) };
}

function tolCuentas(n) {
  return (n || 0) * 0.005 + 0.05;
}

const ATOMOS = {
  AF: { nombre: "Activo fijo", que: "Cuentas 20 a 29. Las amortizaciones y los deterioros acumulados restan.", mapa: "bal", prefs: ["20", "21", "22", "23", "24", "25", "26", "28", "29"], signo: 1, campo: ["b", "AF"] },
  E: { nombre: "Existencias", que: "Cuentas 30 a 36 y 39.", mapa: "bal", prefs: ["30", "31", "32", "33", "34", "35", "36", "39"], signo: 1, campo: ["b", "E"] },
  clientes: { nombre: "Clientes", que: "Cuentas 43 y 490.", mapa: "bal", prefs: ["43", "490"], signo: 1, campo: ["b", "clientes"] },
  otrosDeudores: { nombre: "Otros deudores", que: "Cuentas 44, 460, 470 a 473, 53, 54, 480 y 59.", mapa: "bal", prefs: ["44", "460", "470", "471", "472", "473", "53", "54", "480", "59"], signo: 1, campo: ["b", "otrosDeudores"] },
  T: { nombre: "Tesorería", que: "Cuentas 57: bancos y caja.", mapa: "bal", prefs: ["57"], signo: 1, campo: ["b", "T"] },
  Kcap: { nombre: "Capital y reservas", que: "Cuentas 10 a 13, puestas en positivo.", mapa: "bal", prefs: ["10", "11", "12", "13"], signo: -1 },
  Kres: { nombre: "Resultado acumulado en el balance", que: "Grupos 6 y 7 acumulados hasta la fecha del balance. No es solo el resultado del periodo elegido.", mapa: "bal", prefs: ["6", "7"], signo: -1 },
  RA: { nombre: "Pasivo no corriente", que: "Cuentas 14 a 18, puestas en positivo.", mapa: "bal", prefs: ["14", "15", "16", "17", "18"], signo: -1, campo: ["b", "RA"] },
  PC: { nombre: "Pasivo corriente", que: "Cuentas 40, 41, 465, 475, 476, 477, 50 a 52, 56 y 485, puestas en positivo.", mapa: "bal", prefs: ["40", "41", "465", "475", "476", "477", "50", "51", "52", "56", "485"], signo: -1, campo: ["b", "PC"] },
  proveedores: { nombre: "Proveedores", que: "Cuentas 400 a 406, puestas en positivo.", mapa: "bal", prefs: ["400", "401", "403", "404", "405", "406"], signo: -1, campo: ["b", "proveedores"] },
  deuda: { nombre: "Deuda financiera", que: "Cuentas 16, 17 y 520 a 529 (préstamos y pólizas), puestas en positivo.", mapa: "bal", prefs: ["16", "17", "520", "521", "522", "523", "524", "525", "526", "527", "528", "529"], signo: -1, deuda: true },
  VB: { nombre: "Ventas brutas", que: "Cuentas 700 a 705. Sin devoluciones (708) ni descuentos (706 y 709).", mapa: "pyg", prefs: ["70"], excluir: ["706", "708", "709"], signo: -1, campo: ["r", "VB"] },
  devoluciones: { nombre: "Devoluciones", que: "Cuenta 708.", mapa: "pyg", prefs: ["708"], signo: 1, campo: ["r", "devoluciones"] },
  descuentos: { nombre: "Descuentos sobre ventas", que: "Cuentas 706 y 709.", mapa: "pyg", prefs: ["706", "709"], signo: 1, campo: ["r", "descuentos"] },
  VN: { nombre: "Ventas netas", que: "Todas las cuentas 70, con las ventas en positivo.", mapa: "pyg", prefs: ["70"], signo: -1, campo: ["r", "VN"] },
  otrosIngresos: { nombre: "Otros ingresos de explotación", que: "Cuentas 71, 73, 74 y 75.", mapa: "pyg", prefs: ["71", "73", "74", "75"], signo: -1, campo: ["r", "otrosIngresos"] },
  compras: { nombre: "Compras", que: "Cuentas 60.", mapa: "pyg", prefs: ["60"], signo: 1, campo: ["r", "compras"] },
  consumos: { nombre: "Consumos", que: "Cuentas 60 y 61.", mapa: "pyg", prefs: ["60", "61"], signo: 1, campo: ["r", "consumos"] },
  servicios: { nombre: "Servicios exteriores", que: "Cuentas 62.", mapa: "pyg", prefs: ["62"], signo: 1, campo: ["r", "servicios"] },
  tributos: { nombre: "Tributos", que: "Cuentas 63, sin el impuesto de sociedades (630, 633 y 638).", mapa: "pyg", prefs: ["63"], excluir: ["630", "633", "638"], signo: 1, campo: ["r", "tributos"] },
  personal: { nombre: "Gastos de personal", que: "Cuentas 64.", mapa: "pyg", prefs: ["64"], signo: 1, campo: ["r", "personal"] },
  otrosGastos: { nombre: "Otros gastos de explotación", que: "Cuentas 65.", mapa: "pyg", prefs: ["65"], signo: 1, campo: ["r", "otrosGastos"] },
  cta771: { nombre: "Cuenta 771", que: "Beneficios de vender inmovilizado. Entra en el EBITDA.", mapa: "pyg", prefs: ["771"], signo: -1, campo: ["r", "cta771"] },
  amortizaciones: { nombre: "Amortizaciones", que: "Cuentas 68.", mapa: "pyg", prefs: ["68"], signo: 1, campo: ["r", "amortizaciones"] },
  deterioros: { nombre: "Deterioros", que: "Cuentas 69 y 79.", mapa: "pyg", prefs: ["69", "79"], signo: 1, campo: ["r", "deterioros"] },
  ingresosFin: { nombre: "Ingresos financieros", que: "Cuentas 76.", mapa: "pyg", prefs: ["76"], signo: -1, campo: ["r", "ingresosFin"] },
  F: { nombre: "Gastos financieros", que: "Cuentas 66.", mapa: "pyg", prefs: ["66"], signo: 1, campo: ["r", "F"] },
  extraordinarios: { nombre: "Extraordinarios", que: "Cuentas 67 y 77, sin la 771 (esa ya está en el EBITDA).", mapa: "pyg", prefs: ["67", "77"], excluir: ["771"], signo: -1, campo: ["r", "extraordinarios"] },
  impuesto: { nombre: "Impuesto de sociedades", que: "Cuentas 630, 633 y 638.", mapa: "pyg", prefs: ["630", "633", "638"], signo: 1, campo: ["r", "impuesto"] },
};

function hoja(ctx, id, papel) {
  const spec = ATOMOS[id];
  const mapa = spec.mapa === "bal" ? ctx.mapaBal : ctx.mapaPyg;
  const det = sumar(mapa, spec.prefs, spec.excluir, spec.signo, ctx.nombres);
  let oficial = null;
  if (spec.deuda && mapa) oficial = deudaFinanciera(mapa);
  else if (spec.campo) oficial = ctx[spec.campo[0]]?.[spec.campo[1]];
  if (oficial == null || !isFinite(oficial)) oficial = det ? det.total : null;
  let aviso = "";
  if (!mapa) {
    aviso = spec.mapa === "bal" && ctx.periodo === "anterior"
      ? "La cifra es la del año anterior. Para ver sus cuentas, pulsa Actualizar otra vez: esta carga todavía no trae el detalle del balance anterior."
      : "Esta carga no trae el detalle de cuentas.";
  } else if (id === "E" && ctx.contableE != null && oficial != null && Math.abs(oficial - ctx.contableE) > 0.5) {
    aviso = `En el ratio se usan ${eur(oficial)} porque has cambiado las existencias. La contabilidad suma ${eur(det ? det.total : ctx.contableE)}.`;
  } else if (det && oficial != null && Math.abs(det.total - oficial) > tolCuentas(det.cuentas.length)) {
    aviso = `⚠️ La suma de las cuentas es ${eur(det.total)} y la cifra usada en el ratio es ${eur(oficial)}.`;
  }
  return {
    nombre: spec.nombre,
    papel: papel || "",
    valor: oficial,
    formato: "eur",
    que: spec.que,
    aviso,
    cuentas: det ? det.cuentas : null,
    bloques: null,
  };
}

function sumarFirmado(bloques) {
  let s = 0;
  for (const b of bloques || []) {
    if (b.valor == null || !isFinite(b.valor)) return null;
    if (b.papel === "Se resta") s -= b.valor;
    else if (b.papel === "Se suma" || b.papel === "") s += b.valor;
    else return null;
  }
  return s;
}

function grupo(nombre, valor, formato, que, bloques, papel, redondeo) {
  let aviso = "";
  const s = sumarFirmado(bloques);
  if (s != null && valor != null && isFinite(valor)) {
    const tol = redondeo ? tolCuentas(bloques.reduce((n, b) => n + (b.cuentas?.length || 0), 0)) : 0.5;
    if (Math.abs(s - valor) > tol) aviso = `⚠️ La suma de las piezas da ${eur(s)} y la cifra usada es ${eur(valor)}.`;
  }
  return { nombre, papel: papel || "", valor, formato, que, aviso, cuentas: null, bloques };
}

function piezaR(ctx) {
  return grupo("Realizable", ctx.b.R, "eur", "Clientes más el resto de deudores.", [
    hoja(ctx, "clientes", "Se suma"),
    hoja(ctx, "otrosDeudores", "Se suma"),
  ], "");
}
function piezaAC(ctx) {
  return grupo("Activo circulante", ctx.b.AC, "eur", "Existencias + realizable + tesorería.", [
    hoja(ctx, "E", "Se suma"),
    piezaR(ctx),
    hoja(ctx, "T", "Se suma"),
  ].map((b, i) => ({ ...b, papel: i === 0 || b.papel ? (b.papel || "Se suma") : "Se suma" })), "");
}
function piezaA(ctx) {
  const ac = piezaAC(ctx);
  ac.papel = "Se suma";
  return grupo("Activo", ctx.b.A, "eur", "Activo fijo más activo circulante.", [
    hoja(ctx, "AF", "Se suma"),
    ac,
  ], "");
}
function piezaK(ctx) {
  return grupo("Patrimonio neto", ctx.b.K, "eur", "Capital y reservas, más el resultado acumulado de los grupos 6 y 7 del balance.", [
    hoja(ctx, "Kcap", "Se suma"),
    hoja(ctx, "Kres", "Se suma"),
  ], "", true);
}
function piezaD(ctx) {
  return grupo("Deudas totales", ctx.b.D, "eur", "Deuda a largo más deuda a corto.", [
    hoja(ctx, "RA", "Se suma"),
    hoja(ctx, "PC", "Se suma"),
  ], "");
}
function piezaCP(ctx) {
  const k = piezaK(ctx);
  k.papel = "Se suma";
  return grupo("Capitales permanentes", ctx.b.CP, "eur", "Patrimonio neto más deuda a largo.", [
    k,
    hoja(ctx, "RA", "Se suma"),
  ], "");
}
function piezaFM(ctx) {
  const ac = piezaAC(ctx);
  ac.papel = "Se suma";
  return grupo("Fondo de maniobra", ctx.b.FM, "eur", "Activo circulante menos pasivo corriente.", [
    ac,
    hoja(ctx, "PC", "Se resta"),
  ], "");
}
function piezaEBITDA(ctx) {
  const r = ctx.r;
  return grupo("EBITDA", r.EBITDA, "eur", "Ventas netas, más otros ingresos y la cuenta 771, menos los gastos de la actividad. Sin amortizaciones.", [
    hoja(ctx, "VN", "Se suma"),
    hoja(ctx, "otrosIngresos", "Se suma"),
    hoja(ctx, "cta771", "Se suma"),
    hoja(ctx, "consumos", "Se resta"),
    hoja(ctx, "servicios", "Se resta"),
    hoja(ctx, "tributos", "Se resta"),
    hoja(ctx, "personal", "Se resta"),
    hoja(ctx, "otrosGastos", "Se resta"),
  ], "");
}
function piezaEBIT(ctx) {
  const ebitda = piezaEBITDA(ctx);
  ebitda.papel = "Se suma";
  return grupo("Beneficio de explotación", ctx.r.EBIT, "eur", "EBITDA menos amortizaciones y deterioros.", [
    ebitda,
    hoja(ctx, "amortizaciones", "Se resta"),
    hoja(ctx, "deterioros", "Se resta"),
  ], "");
}
function piezaBNO(ctx) {
  const ebit = piezaEBIT(ctx);
  ebit.papel = "Se suma";
  return grupo("Beneficio neto ordinario", ctx.r.BNO, "eur", "Beneficio de explotación, más ingresos financieros, menos gastos financieros.", [
    ebit,
    hoja(ctx, "ingresosFin", "Se suma"),
    hoja(ctx, "F", "Se resta"),
  ], "");
}
function piezaBAI(ctx) {
  const bno = piezaBNO(ctx);
  bno.papel = "Se suma";
  return grupo("Beneficio antes de impuestos", ctx.r.BAI, "eur", "Beneficio ordinario más extraordinarios.", [
    bno,
    hoja(ctx, "extraordinarios", "Se suma"),
  ], "");
}
function piezaBN(ctx) {
  const bai = piezaBAI(ctx);
  bai.papel = "Se suma";
  return grupo("Beneficio líquido", ctx.r.BN, "eur", "Beneficio antes de impuestos menos el impuesto de sociedades.", [
    bai,
    hoja(ctx, "impuesto", "Se resta"),
  ], "");
}
function piezaCF(ctx) {
  return grupo("Costes fijos", ctx.r.CF, "eur", "Servicios exteriores, tributos, personal, otros gastos y amortizaciones.", [
    hoja(ctx, "servicios", "Se suma"),
    hoja(ctx, "tributos", "Se suma"),
    hoja(ctx, "personal", "Se suma"),
    hoja(ctx, "otrosGastos", "Se suma"),
    hoja(ctx, "amortizaciones", "Se suma"),
  ], "");
}
function piezaMB(ctx) {
  return grupo("Margen bruto", ctx.r.MB, "eur", "Ventas netas menos consumos.", [
    hoja(ctx, "VN", "Se suma"),
    hoja(ctx, "consumos", "Se resta"),
  ], "");
}
function pmaRaw(ctx) {
  const v = div(ctx.b.E, ctx.r.consumos);
  return v == null ? null : v * ctx.dias;
}
function pmeRaw(ctx) {
  const v = div(ctx.b.clientes, ctx.r.VN * 1.21);
  return v == null ? null : v * ctx.dias;
}
function pmpRaw(ctx) {
  const v = div(ctx.b.proveedores, ctx.r.compras * 1.21);
  return v == null ? null : v * ctx.dias;
}
function pmfValor(ctx) {
  return (pmaRaw(ctx) || 0) + (pmeRaw(ctx) || 0) - (pmpRaw(ctx) || 0);
}
function aoValor(ctx) {
  return div(ctx.r.EBIT + ctx.r.CF, ctx.r.EBIT);
}
function afValor(ctx) {
  return div(ctx.r.EBIT, ctx.r.EBIT - ctx.r.F);
}
function pmCoste(ctx) {
  const cvUnit = div(ctx.r.CV, ctx.r.VN);
  if (cvUnit == null || cvUnit >= 1) return { cvUnit, pm: null };
  return { cvUnit, pm: ctx.r.CF / (1 - cvUnit) };
}
function pmFinDatos(ctx) {
  const b = ctx.b;
  const r = ctx.r;
  const dias = ctx.dias || 365;
  const CFm = r.CF;
  const cvUnit = div(r.CV, r.VN);
  const pme = pmeRaw(ctx) != null ? pmeRaw(ctx) : 0;
  const pmp = pmpRaw(ctx) != null ? pmpRaw(ctx) : 0;
  const fAnual = (r.F || 0) * (365 / dias);
  const baseFin = Math.max(b.clientes + b.E - b.proveedores, b.RA || 0);
  let iAnual = 0.04;
  if (fAnual > 0 && baseFin > 1000) {
    const impl = fAnual / baseFin;
    if (impl > 0 && impl < 0.25) iAnual = impl;
  }
  const kDesfase = iAnual * (pme - pmp) / 365;
  const denomFin = cvUnit != null ? (1 - cvUnit) - kDesfase : null;
  const pmFin = denomFin != null && denomFin > 0.02 ? (CFm + (r.F || 0)) / denomFin : null;
  const cajaDesfase = pmFin != null && dias ? (pmFin * 1.21 / dias) * (pme - (cvUnit || 0) * pmp) : null;
  return { CFm, cvUnit, pme, pmp, fAnual, baseFin, iAnual, kDesfase, denomFin, pmFin, cajaDesfase };
}

function bloqueDias(nombre, valor, que, papel) {
  return { nombre, papel: papel || "", valor, formato: "dias", que, aviso: "", cuentas: null, bloques: null };
}
function bloqueNum(nombre, valor, formato, que, papel, bloques) {
  return { nombre, papel: papel || "", valor, formato, que, aviso: "", cuentas: null, bloques: bloques || null };
}

function sinDato(frase, titulo, formato) {
  return { titulo, formato, frase, valor: null, aviso: "", cuentas: null, bloques: [] };
}

function construir(id, ctx) {
  const b = ctx.b;
  const r = ctx.r;
  const { anual, texto } = notaAnual(ctx.dias);
  const noAnual = texto ? " Esta cifra no se lleva a un año: usa los importes del periodo tal cual." : "";

  if (id === "VB") {
    const h = hoja(ctx, "VB");
    return { titulo: "Ventas brutas", formato: "eur", frase: `Cuentas 700 a 705. Las devoluciones son ${eur(r.devoluciones)} y los descuentos ${eur(r.descuentos)}. Las ventas netas, ya restadas, son ${eur(r.VN)}.`, valor: r.VB, aviso: h.aviso, cuentas: h.cuentas, bloques: [hoja(ctx, "devoluciones"), hoja(ctx, "descuentos")] };
  }
  if (id === "VN") return desdeHoja(hoja(ctx, "VN"), "Ventas netas del periodo, cuentas 70.");
  if (id === "MB") return desdeGrupo(piezaMB(ctx));
  if (id === "EBITDA") return desdeGrupo(piezaEBITDA(ctx));
  if (id === "EBIT") return desdeGrupo(piezaEBIT(ctx));
  if (id === "BNO") return desdeGrupo(piezaBNO(ctx));
  if (id === "BAI") return desdeGrupo(piezaBAI(ctx));
  if (id === "BN") return desdeGrupo(piezaBN(ctx));
  if (id === "AF") return desdeHoja(hoja(ctx, "AF"));
  if (id === "E") return desdeHoja(hoja(ctx, "E"));
  if (id === "R") return desdeGrupo(piezaR(ctx));
  if (id === "clientes") return desdeHoja(hoja(ctx, "clientes"));
  if (id === "T") return desdeHoja(hoja(ctx, "T"));
  if (id === "AC") return desdeGrupo(piezaAC(ctx));
  if (id === "A") return desdeGrupo(piezaA(ctx));
  if (id === "K") return desdeGrupo(piezaK(ctx));
  if (id === "RA") return desdeHoja(hoja(ctx, "RA"));
  if (id === "PC") return desdeHoja(hoja(ctx, "PC"));
  if (id === "proveedores") return desdeHoja(hoja(ctx, "proveedores"));
  if (id === "D") return desdeGrupo(piezaD(ctx));
  if (id === "FM" || id === "fm") return desdeGrupo(piezaFM(ctx));
  if (id === "deuda") return desdeHoja(hoja(ctx, "deuda"));

  if (id === "margenBrutoPct") {
    const v = div(r.MB, r.VN);
    return { titulo: "Margen bruto %", formato: "pct", frase: `Margen bruto ${eur(r.MB)} dividido entre ventas netas ${eur(r.VN)}.${noAnual}`, valor: v, aviso: "", cuentas: null, bloques: [piezaMB(ctx), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "margenEbitda") {
    const v = div(r.EBITDA, r.VN);
    return { titulo: "Margen EBITDA", formato: "pct", frase: `EBITDA ${eur(r.EBITDA)} dividido entre ventas netas ${eur(r.VN)}.${noAnual}`, valor: v, aviso: "", cuentas: null, bloques: [piezaEBITDA(ctx), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "rv") {
    const v = div(r.EBIT, r.VN);
    return { titulo: "Margen de explotación", formato: "pct", frase: `Beneficio de explotación ${eur(r.EBIT)} dividido entre ventas netas ${eur(r.VN)}.${noAnual}`, valor: v, aviso: "", cuentas: null, bloques: [piezaEBIT(ctx), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "margenNeto") {
    const v = div(r.BN, r.VN);
    return { titulo: "Margen neto", formato: "pct", frase: `Beneficio líquido ${eur(r.BN)} dividido entre ventas netas ${eur(r.VN)}.${noAnual}`, valor: v, aviso: "", cuentas: null, bloques: [piezaBN(ctx), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "re") {
    const beA = r.EBIT * anual;
    const v = div(beA, b.A);
    const frase = texto
      ? `Beneficio de explotación del periodo ${eur(r.EBIT)}. Llevado a un año: ${eur(beA)}.${texto} Se divide entre el activo ${eur(b.A)}.`
      : `Beneficio de explotación ${eur(r.EBIT)} dividido entre el activo ${eur(b.A)}.`;
    return { titulo: "Rentabilidad económica", formato: "pct", frase, valor: v, aviso: "", cuentas: null, bloques: [piezaEBIT(ctx), piezaA(ctx)] };
  }
  if (id === "rf") {
    const bnA = r.BN * anual;
    const v = div(bnA, b.K);
    const frase = texto
      ? `Beneficio líquido del periodo ${eur(r.BN)}. Llevado a un año: ${eur(bnA)}.${texto} Se divide entre el patrimonio neto ${eur(b.K)}.`
      : `Beneficio líquido ${eur(r.BN)} dividido entre el patrimonio neto ${eur(b.K)}.`;
    return { titulo: "Rentabilidad financiera", formato: "pct", frase, valor: v, aviso: "", cuentas: null, bloques: [piezaBN(ctx), piezaK(ctx)] };
  }
  if (id === "dupont") {
    const bnA = r.BN * anual;
    const v = div(bnA, b.A);
    const frase = texto
      ? `Beneficio líquido del periodo ${eur(r.BN)}. Llevado a un año: ${eur(bnA)}.${texto} Se divide entre el activo ${eur(b.A)}. Es el margen por la rotación.`
      : `Beneficio líquido ${eur(r.BN)} dividido entre el activo ${eur(b.A)}.`;
    return { titulo: "Dupont: rentabilidad total", formato: "pct", frase, valor: v, aviso: "", cuentas: null, bloques: [piezaBN(ctx), piezaA(ctx)] };
  }
  if (id === "rfDesc") {
    const m = div(r.BN, r.VN);
    const rot = div(r.VN * anual, b.A);
    const ap = div(b.A, b.K);
    const v = m != null && rot != null && ap != null ? m * rot * ap : null;
    const frase = `Sale de multiplicar tres palancas: margen neto ${formatoOrigen(m, "pct")}, rotación del activo ${num(rot)} y apalancamiento ${num(ap)}.${texto}`;
    return {
      titulo: "Rentabilidad financiera descompuesta", formato: "pct", frase, valor: v, aviso: "", cuentas: null,
      bloques: [
        bloqueNum("Margen neto (beneficio líquido / ventas)", m, "pct", "No se anualiza.", "Factor", [piezaBN(ctx), hoja(ctx, "VN", "Divisor")]),
        bloqueNum("Rotación del activo", rot, "x", texto || "Ventas del periodo entre el activo.", "Factor", [hoja(ctx, "VN"), piezaA(ctx)]),
        bloqueNum("Apalancamiento (activo / patrimonio)", ap, "x", "Activo entre patrimonio neto.", "Factor", [piezaA(ctx), piezaK(ctx)]),
      ],
    };
  }
  if (id === "rotacionActivo") {
    const v = div(r.VN * anual, b.A);
    return { titulo: "Rotación del activo", formato: "x", frase: `Ventas netas ${eur(r.VN * anual)} (del periodo, llevadas a un año si hace falta) divididas entre el activo ${eur(b.A)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), piezaA(ctx)] };
  }
  if (id === "rotAF") {
    const v = div(r.VN * anual, b.AF);
    return { titulo: "Rotación del activo fijo", formato: "x", frase: `Ventas netas llevadas a un año ${eur(r.VN * anual)} entre el activo fijo ${eur(b.AF)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), hoja(ctx, "AF")] };
  }
  if (id === "rotAC") {
    const v = div(r.VN * anual, b.AC);
    return { titulo: "Rotación del activo circulante", formato: "x", frase: `Ventas netas llevadas a un año ${eur(r.VN * anual)} entre el activo circulante ${eur(b.AC)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), piezaAC(ctx)] };
  }
  if (id === "rotClientes") {
    const v = div(r.VN * anual, b.clientes);
    return { titulo: "Rotación de clientes", formato: "x", frase: `Ventas netas llevadas a un año ${eur(r.VN * anual)} entre el saldo de clientes ${eur(b.clientes)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), hoja(ctx, "clientes")] };
  }
  if (id === "rotE") {
    const v = div(r.consumos * anual, b.E);
    return { titulo: "Rotación de existencias", formato: "x", frase: `Consumos llevados a un año ${eur(r.consumos * anual)} entre existencias ${eur(b.E)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "consumos"), hoja(ctx, "E")] };
  }
  if (id === "rotCP") {
    const v = div(r.VN * anual, b.CP);
    return { titulo: "Rotación de capitales permanentes", formato: "x", frase: `Ventas netas llevadas a un año ${eur(r.VN * anual)} entre capitales permanentes ${eur(b.CP)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), piezaCP(ctx)] };
  }
  if (id === "rotK") {
    const v = div(r.VN * anual, b.K);
    return { titulo: "Rotación del capital propio", formato: "x", frase: `Ventas netas llevadas a un año ${eur(r.VN * anual)} entre patrimonio neto ${eur(b.K)}.${texto}`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), piezaK(ctx)] };
  }
  if (id === "liq") {
    const v = div(b.AC, b.PC);
    return { titulo: "Liquidez general", formato: "x", frase: `Activo circulante ${eur(b.AC)} dividido entre pasivo corriente ${eur(b.PC)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaAC(ctx), hoja(ctx, "PC", "Divisor")] };
  }
  if (id === "acid") {
    const v = div(b.T + b.R, b.PC);
    return { titulo: "Tesorería ordinaria", formato: "x", frase: `Tesorería ${eur(b.T)} más realizable ${eur(b.R)} = ${eur(b.T + b.R)}. Se divide entre el pasivo corriente ${eur(b.PC)}. El stock no entra.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "T"), piezaR(ctx), hoja(ctx, "PC", "Divisor")] };
  }
  if (id === "tes") {
    const v = div(b.T, b.PC);
    return { titulo: "Tesorería inmediata", formato: "x", frase: `Dinero en bancos y caja ${eur(b.T)} dividido entre el pasivo corriente ${eur(b.PC)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "T"), hoja(ctx, "PC", "Divisor")] };
  }
  if (id === "fmK") {
    const v = div(b.FM, b.K);
    return { titulo: "Capital propio en circulante", formato: "x", frase: `Fondo de maniobra ${eur(b.FM)} dividido entre patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaFM(ctx), piezaK(ctx)] };
  }
  if (id === "garantia") {
    const v = div(b.A, b.D);
    return { titulo: "Garantía", formato: "x", frase: `Activo ${eur(b.A)} dividido entre deudas totales ${eur(b.D)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaA(ctx), piezaD(ctx)] };
  }
  if (id === "end") {
    const v = div(b.D, b.K);
    return { titulo: "Endeudamiento total", formato: "x", frase: `Deudas totales ${eur(b.D)} divididas entre patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaD(ctx), piezaK(ctx)] };
  }
  if (id === "endCorto") {
    const v = div(b.PC, b.K);
    return { titulo: "Endeudamiento a corto", formato: "x", frase: `Pasivo corriente ${eur(b.PC)} dividido entre patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "PC"), piezaK(ctx)] };
  }
  if (id === "endLargo") {
    const v = div(b.RA, b.K);
    return { titulo: "Endeudamiento a largo", formato: "x", frase: `Pasivo no corriente ${eur(b.RA)} dividido entre patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "RA"), piezaK(ctx)] };
  }
  if (id === "apal") {
    const v = div(b.A, b.K);
    return { titulo: "Apalancamiento", formato: "x", frase: `Activo ${eur(b.A)} dividido entre patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaA(ctx), piezaK(ctx)] };
  }
  if (id === "autonomia") {
    const v = div(b.K, b.D);
    return { titulo: "Autonomía", formato: "x", frase: `Patrimonio neto ${eur(b.K)} dividido entre deudas totales ${eur(b.D)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaK(ctx), piezaD(ctx)] };
  }
  if (id === "finAF") {
    const v = div(b.CP, b.AF);
    return { titulo: "Financiación del inmovilizado", formato: "x", frase: `Capitales permanentes ${eur(b.CP)} divididos entre activo fijo ${eur(b.AF)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaCP(ctx), hoja(ctx, "AF", "Divisor")] };
  }
  if (id === "kInmov") {
    const v = div(b.AF - b.RA, b.K);
    return { titulo: "Capital propio inmovilizado", formato: "x", frase: `Activo fijo ${eur(b.AF)} menos deuda a largo ${eur(b.RA)} = ${eur(b.AF - b.RA)}. Se divide entre el patrimonio neto ${eur(b.K)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "AF"), hoja(ctx, "RA", "Se resta"), piezaK(ctx)] };
  }
  if (id === "roce") {
    const base = b.K + b.RA;
    const v = div(r.EBIT, base);
    return { titulo: "ROCE", formato: "pct", frase: `Beneficio de explotación del periodo ${eur(r.EBIT)} dividido entre patrimonio ${eur(b.K)} más deuda a largo ${eur(b.RA)} (${eur(base)}).${noAnual}`, valor: v, aviso: "", cuentas: null, bloques: [piezaEBIT(ctx), piezaK(ctx), hoja(ctx, "RA")] };
  }
  if (id === "pma") {
    const v = pmaRaw(ctx);
    return { titulo: "Periodo medio de almacenamiento", formato: "dias", frase: `Existencias ${eur(b.E)} divididas entre consumos del periodo ${eur(r.consumos)}, y el resultado por ${ctx.dias} días.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "E"), hoja(ctx, "consumos", "Divisor")] };
  }
  if (id === "pme") {
    const v = pmeRaw(ctx);
    return { titulo: "Periodo medio de cobro", formato: "dias", frase: `Clientes ${eur(b.clientes)} divididos entre las ventas con IVA ${eur(r.VN * 1.21)} (ventas netas ${eur(r.VN)} × 1,21). El resultado, por ${ctx.dias} días. El IVA entra porque la factura pendiente también lo lleva.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "clientes"), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "pmp") {
    const v = pmpRaw(ctx);
    return { titulo: "Periodo medio de pago", formato: "dias", frase: `Proveedores ${eur(b.proveedores)} divididos entre las compras con IVA ${eur(r.compras * 1.21)} (compras ${eur(r.compras)} × 1,21). El resultado, por ${ctx.dias} días.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "proveedores"), hoja(ctx, "compras", "Divisor")] };
  }
  if (id === "pmf") {
    const pma = pmaRaw(ctx);
    const pme = pmeRaw(ctx);
    const pmp = pmpRaw(ctx);
    const v = (pma || 0) + (pme || 0) - (pmp || 0);
    return {
      titulo: "PM financiero", formato: "dias",
      frase: `Días de almacén ${pma == null ? "0 (sin dato)" : formatoOrigen(pma, "dias")} + días de cobro ${pme == null ? "0 (sin dato)" : formatoOrigen(pme, "dias")} − días de pago ${pmp == null ? "0 (sin dato)" : formatoOrigen(pmp, "dias")}. Si una pieza no se puede calcular, entra como cero, igual que en la tarjeta.`,
      valor: v, aviso: "", cuentas: null,
      bloques: [
        bloqueDias("Almacén", pma || 0, "Existencias / consumos × días.", "Se suma"),
        bloqueDias("Cobro", pme || 0, "Clientes / ventas con IVA × días.", "Se suma"),
        bloqueDias("Pago a proveedores", pmp || 0, "Proveedores / compras con IVA × días.", "Se resta"),
        hoja(ctx, "E"), hoja(ctx, "consumos"), hoja(ctx, "clientes"), hoja(ctx, "VN"), hoja(ctx, "proveedores"), hoja(ctx, "compras"),
      ],
    };
  }
  if (id === "diasCaja") {
    const ventasDia = div(r.VN * 1.21, ctx.dias);
    const v = ventasDia ? b.T / ventasDia : null;
    return { titulo: "Cobertura ante impagos", formato: "dias", frase: `Tesorería ${eur(b.T)} dividida entre la venta diaria con IVA ${eur(ventasDia)} (ventas con IVA ${eur(r.VN * 1.21)} / ${ctx.dias} días).`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "T"), hoja(ctx, "VN")] };
  }
  if (id === "ciclo") {
    const pma = pmaRaw(ctx) || 0;
    const pme = pmeRaw(ctx) || 0;
    return { titulo: "Ciclo económico", formato: "dias", frase: `Días de almacén ${formatoOrigen(pma, "dias")} más días de cobro ${formatoOrigen(pme, "dias")}.`, valor: pma + pme, aviso: "", cuentas: null, bloques: [bloqueDias("Almacén", pma, "", "Se suma"), bloqueDias("Cobro", pme, "", "Se suma"), hoja(ctx, "E"), hoja(ctx, "clientes")] };
  }
  if (id === "ao") {
    const v = aoValor(ctx);
    return { titulo: "Apalancamiento operativo", formato: "x", frase: `Beneficio de explotación ${eur(r.EBIT)} más costes fijos ${eur(r.CF)} = ${eur(r.EBIT + r.CF)}. Se divide entre el beneficio de explotación ${eur(r.EBIT)}.`, valor: v, aviso: "", cuentas: null, bloques: [piezaEBIT(ctx), piezaCF(ctx)] };
  }
  if (id === "af") {
    const v = afValor(ctx);
    return { titulo: "Apalancamiento financiero", formato: "x", frase: `Beneficio de explotación ${eur(r.EBIT)} dividido entre ese beneficio menos los gastos financieros ${eur(r.F)} (${eur(r.EBIT - r.F)}).`, valor: v, aviso: "", cuentas: null, bloques: [piezaEBIT(ctx), hoja(ctx, "F", "Se resta")] };
  }
  if (id === "at") {
    const ao = aoValor(ctx);
    const af = afValor(ctx);
    const v = ao != null && af != null ? ao * af : null;
    return { titulo: "Apalancamiento total", formato: "x", frase: `Apalancamiento operativo ${num(ao)} multiplicado por el financiero ${num(af)}.`, valor: v, aviso: "", cuentas: null, bloques: [bloqueNum("Apalancamiento operativo", ao, "x", "", "Factor"), bloqueNum("Apalancamiento financiero", af, "x", "", "Factor")] };
  }
  if (id === "pm") {
    const { cvUnit, pm } = pmCoste(ctx);
    const queda = cvUnit == null ? null : 1 - cvUnit;
    return { titulo: "Punto muerto", formato: "eur", frase: `Costes fijos ${eur(r.CF)} divididos entre lo que queda de cada euro vendido después del material (${queda == null ? "—" : formatoOrigen(queda, "pct")}). Los consumos son ${eur(r.CV)} y las ventas ${eur(r.VN)}. Es el punto muerto de costes, sin el desfase de cobro y pago.`, valor: pm, aviso: "", cuentas: null, bloques: [piezaCF(ctx), hoja(ctx, "consumos"), hoja(ctx, "VN")] };
  }
  if (id === "cobPm") {
    const { pm } = pmCoste(ctx);
    const v = div(r.VN, pm);
    return { titulo: "Cobertura del punto muerto", formato: "x", frase: `Ventas netas ${eur(r.VN)} divididas entre el punto muerto ${eur(pm)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), bloqueNum("Punto muerto", pm, "eur", "Costes fijos / margen después del material.", "Divisor")] };
  }
  if (id === "seguridad") {
    const { pm } = pmCoste(ctx);
    const v = pm != null ? r.VN - pm : null;
    return { titulo: "Margen de seguridad", formato: "eur", frase: `Ventas netas ${eur(r.VN)} menos el punto muerto ${eur(pm)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN", "Se suma"), bloqueNum("Punto muerto", pm, "eur", "", "Se resta")] };
  }
  if (id === "segPct") {
    const { pm } = pmCoste(ctx);
    const seg = pm != null ? r.VN - pm : null;
    const v = div(seg, r.VN);
    return { titulo: "Margen de seguridad sobre ventas", formato: "pct", frase: `Margen de seguridad ${eur(seg)} dividido entre ventas netas ${eur(r.VN)}.`, valor: v, aviso: "", cuentas: null, bloques: [bloqueNum("Margen de seguridad", seg, "eur", "", ""), hoja(ctx, "VN", "Divisor")] };
  }
  if (id === "pmFin") {
    const d = pmFinDatos(ctx);
    const tipoTxt = `${(d.iAnual * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;
    const caja = d.cajaDesfase == null ? "" : d.cajaDesfase >= 0
      ? ` A ese nivel de ventas, adelantas unos ${eur(d.cajaDesfase)}.`
      : ` A ese nivel de ventas, los proveedores financian unos ${eur(-d.cajaDesfase)}.`;
    return {
      titulo: "Punto muerto financiero", formato: "eur",
      frase: `Costes fijos ${eur(d.CFm)} más intereses del periodo ${eur(r.F)}. Se dividen entre el margen después del material menos el coste del desfase entre cobro (${Math.round(d.pme)} días) y pago (${Math.round(d.pmp)} días). El tipo usado es el ${tipoTxt}.${caja}`,
      valor: d.pmFin, aviso: "", cuentas: null,
      bloques: [piezaCF(ctx), hoja(ctx, "F"), hoja(ctx, "VN"), hoja(ctx, "consumos"), hoja(ctx, "clientes"), hoja(ctx, "proveedores"), hoja(ctx, "E"), hoja(ctx, "RA")],
    };
  }
  if (id === "cobPmFin") {
    const d = pmFinDatos(ctx);
    const v = div(r.VN, d.pmFin);
    return { titulo: "Cobertura del punto muerto financiero", formato: "x", frase: `Ventas netas ${eur(r.VN)} divididas entre el punto muerto financiero ${eur(d.pmFin)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), bloqueNum("Punto muerto financiero", d.pmFin, "eur", "", "Divisor")] };
  }
  if (id === "deudaEbitda") {
    const deuda = ctx.mapaBal ? deudaFinanciera(ctx.mapaBal) : null;
    const v = r.EBITDA > 0 ? div(deuda, r.EBITDA) : null;
    const frase = r.EBITDA > 0
      ? `Deuda financiera ${eur(deuda)} dividida entre el EBITDA ${eur(r.EBITDA)}.`
      : `No se divide porque el EBITDA del periodo es ${eur(r.EBITDA)}. La deuda financiera es ${eur(deuda)}.`;
    return { titulo: "Deuda financiera / EBITDA", formato: "x", frase, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "deuda"), piezaEBITDA(ctx)] };
  }
  if (id === "nof") {
    const v = b.E + b.clientes - b.proveedores;
    return { titulo: "Dinero en el ciclo operativo", formato: "eur", frase: `Existencias ${eur(b.E)} + clientes ${eur(b.clientes)} − proveedores ${eur(b.proveedores)}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "E", "Se suma"), hoja(ctx, "clientes", "Se suma"), hoja(ctx, "proveedores", "Se resta")] };
  }
  if (id === "cajaCobro") {
    const objetivo = ctx.sim?.objetivoCobro;
    const pme = pmeRaw(ctx);
    const ventaDia = div(r.VN * 1.21, ctx.dias);
    const v = objetivo != null && ventaDia != null && pme != null ? ventaDia * (pme - objetivo) : null;
    return { titulo: "Efecto en caja si cambia el cobro", formato: "eur", frase: `No es un apunte. Ventas con IVA ${eur(r.VN * 1.21)} / ${ctx.dias} días = ${eur(ventaDia)} al día. Días de cobro actuales ${formatoOrigen(pme, "dias")}. Objetivo ${objetivo == null ? "—" : objetivo + " días"}. La diferencia de días, por la venta diaria, es el efecto en caja. Si sale negativo, la tarjeta dice «se inmovilizaría» y enseña el importe sin signo.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "VN"), hoja(ctx, "clientes")] };
  }
  if (id === "cajaPago") {
    const objetivo = ctx.sim?.objetivoPago;
    const pmp = pmpRaw(ctx);
    const compraDia = div(r.compras * 1.21, ctx.dias);
    const v = objetivo != null && compraDia != null && pmp != null ? compraDia * (objetivo - pmp) : null;
    return { titulo: "Efecto en caja si cambia el pago", formato: "eur", frase: `No es un apunte. Compras con IVA ${eur(r.compras * 1.21)} / ${ctx.dias} días = ${eur(compraDia)} al día. Días de pago actuales ${formatoOrigen(pmp, "dias")}. Objetivo ${objetivo == null ? "—" : objetivo + " días"}.`, valor: v, aviso: "", cuentas: null, bloques: [hoja(ctx, "compras"), hoja(ctx, "proveedores")] };
  }
  if (id === "sensi") {
    const p = ctx.sim?.variacion;
    const ao = aoValor(ctx);
    const v = ao == null || p == null ? null : p * ao;
    return { titulo: "Cambio estimado del beneficio de explotación", formato: "pp", frase: `No sale de una cuenta. El cambio de ventas es ${p} % y el apalancamiento operativo es ${num(ao)}. ${p} × ${num(ao)} es el cambio estimado del beneficio. Es una aproximación.`, valor: v, aviso: "", cuentas: null, bloques: [bloqueNum("Apalancamiento operativo", ao, "x", "", "Factor", [piezaEBIT(ctx), piezaCF(ctx)])] };
  }
  if (id === "tension") {
    const tes = div(b.T, b.PC);
    const pme = pmeRaw(ctx);
    const pmf = pmfValor(ctx);
    const liq = div(b.AC, b.PC);
    const end = div(b.D, b.K);
    const puntos =
      (tes != null && tes < 0.15 ? 2 : tes != null && tes < 0.3 ? 1 : 0) +
      (pme != null && pme > 120 ? 2 : pme != null && pme > 90 ? 1 : 0) +
      (pmf != null && pmf > 120 ? 2 : pmf != null && pmf > 80 ? 1 : 0) +
      (b.FM != null && b.FM < 0 ? 2 : 0) +
      (liq != null && liq < 1 ? 2 : liq != null && liq < 1.5 ? 1 : 0) +
      (end != null && end > 1.8 ? 2 : end != null && end > 1.5 ? 1 : 0);
    const txt = puntos >= 5 ? "Alta" : puntos >= 2 ? "Media" : "Baja";
    return {
      titulo: "Tensión de tesorería", formato: "texto", texto: txt,
      frase: `No es una cuenta. Junta seis señales y suma puntos: tesorería inmediata por debajo de 0,30, cobro por encima de 90 días, ciclo por encima de 80 días, fondo de maniobra negativo, liquidez por debajo de 1,5 y deuda/patrimonio por encima de 1,5. Con 5 o más puntos es alta; con 2 o más, media. Puntos de esta lectura: ${puntos}. Las cuentas de cada señal se abren pulsando su cifra.`,
      valor: null, aviso: "", cuentas: null,
      bloques: [
        bloqueNum("Tesorería inmediata", tes, "x", "Por debajo de 0,15 suma 2. Por debajo de 0,30 suma 1.", ""),
        bloqueDias("Cobro", pme, "Por encima de 120 días suma 2. Por encima de 90 suma 1.", ""),
        bloqueDias("PM financiero", pmf, "Por encima de 120 días suma 2. Por encima de 80 suma 1.", ""),
        bloqueNum("Fondo de maniobra", b.FM, "eur", "Si es negativo, suma 2.", ""),
        bloqueNum("Liquidez", liq, "x", "Por debajo de 1 suma 2. Por debajo de 1,5 suma 1.", ""),
        bloqueNum("Deuda / patrimonio", end, "x", "Por encima de 1,8 suma 2. Por encima de 1,5 suma 1.", ""),
      ],
    };
  }
  return null;
}

function desdeHoja(h, frase) {
  return { titulo: h.nombre, formato: h.formato, frase: frase || h.que, valor: h.valor, aviso: h.aviso, cuentas: h.cuentas, bloques: [] };
}
function desdeGrupo(g) {
  return { titulo: g.nombre, formato: g.formato, frase: g.que, valor: g.valor, aviso: g.aviso, cuentas: null, bloques: g.bloques || [] };
}

function distinto(calculado, mostrado, formato) {
  if (calculado == null || mostrado == null || !isFinite(calculado) || !isFinite(mostrado)) return "";
  const tol = formato === "eur" ? 1 : formato === "dias" ? 0.6 : formato === "pct" ? 0.0005 : formato === "pp" ? 0.5 : 0.02;
  if (Math.abs(calculado - mostrado) <= tol) return "";
  return `⚠️ La operación de las piezas da ${formatoOrigen(calculado, formato)} y en la pantalla sale ${formatoOrigen(mostrado, formato)}.`;
}

export function explicarOrigen(id, ctx, mostrado) {
  if (!ctx || !id) return null;
  const base = construir(id, ctx);
  if (!base) {
    return {
      titulo: "Esta cifra",
      cuando: etiqueta(ctx),
      frase: "No tengo el desglose de cuentas de esta cifra.",
      valor: typeof mostrado === "number" ? mostrado : null,
      texto: typeof mostrado === "string" ? mostrado : "",
      formato: typeof mostrado === "string" ? "texto" : "eur",
      aviso: "",
      cuentas: null,
      bloques: [],
    };
  }
  if (ctx.notaGrafico) {
    base.frase = `El gráfico es el cierre de cada mes, con la cuenta de resultados desde enero. Las cuentas de aquí son del periodo elegido en las fechas de arriba, no de una barra concreta. ${base.frase || ""}`;
  }
  if (base.formato === "texto") {
    if (typeof mostrado === "string" && mostrado && mostrado !== base.texto) {
      base.aviso = [base.aviso, `⚠️ El cálculo da «${base.texto}» y en la pantalla sale «${mostrado}».`].filter(Boolean).join(" ");
      base.texto = mostrado;
    }
  } else if (typeof mostrado === "number" && isFinite(mostrado)) {
    const aviso = distinto(base.valor, mostrado, base.formato);
    if (aviso) {
      base.aviso = [base.aviso, aviso].filter(Boolean).join(" ");
      base.valor = mostrado;
    }
  }
  base.cuando = etiqueta(ctx);
  return base;
}

function etiqueta(ctx) {
  const cual = ctx.periodo === "anterior" ? "Periodo anterior" : "Periodo elegido";
  return ctx.etiqueta ? `${cual} · ${ctx.etiqueta}` : cual;
}

export function contextoOrigen({ datos, b, bp, periodo, etiqueta: etiq, notaGrafico, sim }) {
  const anterior = periodo === "anterior";
  const lado = anterior ? datos?.anterior : datos?.actual;
  return {
    periodo: anterior ? "anterior" : "actual",
    etiqueta: etiq || "",
    dias: lado?.dias || 365,
    b: (anterior ? bp : b) || lado?.balance || {},
    r: lado?.resultados || {},
    mapaBal: anterior ? datos?.cuentas?.balPrev : datos?.cuentas?.bal,
    mapaPyg: anterior ? datos?.cuentas?.pygPrev : datos?.cuentas?.pyg,
    nombres: datos?.cuentas?.nombres || {},
    contableE: lado?.balance?.E,
    notaGrafico: !!notaGrafico,
    sim: sim || {},
  };
}

const ID_POR_FILA = {
  "Ventas brutas (VB)": "VB",
  "Ventas netas (VN)": "VN",
  "Margen bruto": "MB",
  EBITDA: "EBITDA",
  "EBIT = BE (Bº explotación)": "EBIT",
  "BNO (Bº neto ordinario)": "BNO",
  BAI: "BAI",
  "BN (Bº líquido)": "BN",
  "Margen bruto %": "margenBrutoPct",
  "Margen EBITDA": "margenEbitda",
  "Rentabilidad económica (RE)": "re",
  "Rentabilidad financiera (RF)": "rf",
  "Rentabilidad de las ventas (RV)": "rv",
  "Rotación del activo (rT)": "rotacionActivo",
  "Dupont: rentabilidad total": "dupont",
  "RF descompuesta": "rfDesc",
  "Liquidez general": "liq",
  "Tesorería ordinaria (acid test)": "acid",
  "Tesorería inmediata (disponibilidad)": "tes",
  "Fondo de maniobra (FM)": "fm",
  "Capital propio en circulante": "fmK",
  "Garantía (distancia a la quiebra)": "garantia",
  "Endeudamiento total": "end",
  "Endeudamiento a corto": "endCorto",
  "Endeudamiento a largo": "endLargo",
  "Apalancamiento (A/K)": "apal",
  Autonomía: "autonomia",
  "Financiación del inmovilizado": "finAF",
  "Capital propio inmovilizado": "kInmov",
  "Rotación del activo": "rotacionActivo",
  "Rotación del activo fijo": "rotAF",
  "Rotación del activo circulante": "rotAC",
  "Rotación de clientes": "rotClientes",
  "Rotación de existencias": "rotE",
  "Rotación de capitales permanentes": "rotCP",
  "Rotación del capital propio": "rotK",
  "PM de almacenamiento (PMa+PMc+PMv)": "pma",
  "PM de cobro (PMe)": "pme",
  "PM de pago (PMp)": "pmp",
  "Cobertura ante impagos (días de caja)": "diasCaja",
  "PM financiero (PMF)": "pmf",
  "Apalancamiento operativo (Ao)": "ao",
  "Apalancamiento financiero (Af)": "af",
  "Apalancamiento total (At)": "at",
  "Punto muerto (en ventas)": "pm",
  "Cobertura del punto muerto": "cobPm",
  "Punto muerto financiero": "pmFin",
  "Cobertura del punto muerto financiero": "cobPmFin",
  "Activo fijo (AF)": "AF",
  "Existencias (E)": "E",
  "Realizable (R)": "R",
  "  · de ello clientes": "clientes",
  "Tesorería (T)": "T",
  "Activo circulante (AC)": "AC",
  "ACTIVO (A)": "A",
  "Patrimonio neto (K)": "K",
  "Pasivo no corriente (RA)": "RA",
  "Pasivo corriente (PC)": "PC",
  "  · de ello proveedores": "proveedores",
  "Deudas totales (D)": "D",
};

export function idDeFila(nombre) {
  return ID_POR_FILA[nombre] || null;
}
