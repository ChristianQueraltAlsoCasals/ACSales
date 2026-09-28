/**
 * contabilidad.cjs — RATIOS FINANCIEROS desde los MOVIMIENTOS DE
 * CONTABILIDAD de BC (24/09/2026).
 *
 * Lee los movs. de contabilidad (API v2.0 generalLedgerEntries) de la
 * empresa seleccionada hasta una fecha, los suma por cuenta y monta el
 * balance y la cuenta de resultados según el Plan General Contable
 * español (grupos de cuentas). Con eso calcula los ratios de las fórmulas
 * de los apuntes de Maria (rentabilidades, Dupont, ratios de situación,
 * rotación, periodos medios, apalancamientos, punto muerto).
 *
 * Solo LECTURA. Se calcula también el mismo periodo del año anterior
 * para comparar. Resultado en caché 30 min por empresa + fecha.
 */
module.exports = function montarContabilidad({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, EMPRESA_NOMBRE }) {
  const cache = new Map();
  const cacheNombres = new Map(); // empresa -> {ts, mapa}

  // Nombres de las cuentas (API v2.0 accounts) para el simulador de escenarios
  async function nombresCuentas(token) {
    const c = cacheNombres.get(EMPRESA_ID());
    if (c && Date.now() - c.ts < 6 * 3600 * 1000) return c.mapa;
    const mapa = {};
    try {
      let url = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/accounts?$select=number,displayName`;
      while (url) {
        const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) break;
        const j = await r.json();
        for (const a of j.value || []) mapa[a.number] = a.displayName;
        url = j["@odata.nextLink"] || null;
      }
    } catch { /* sin nombres: el simulador sigue funcionando con los números */ }
    cacheNombres.set(EMPRESA_ID(), { ts: Date.now(), mapa });
    return mapa;
  }

  const iso = (d) => d.toISOString().slice(0, 10);
  const menosUnAño = (s) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return iso(d);
  };

  // Suma de saldos (debe - haber) de las cuentas que empiezan por alguno de los prefijos
  const S = (mapa, prefijos, excluir = []) => {
    let t = 0;
    for (const [cta, v] of mapa) {
      if (prefijos.some((p) => cta.startsWith(p)) && !excluir.some((p) => cta.startsWith(p))) t += v;
    }
    return t;
  };

  // Balance (saldos acumulados) + cuenta de resultados (movimiento del periodo)
  function masas(bal, pyg, dias) {
    // ---------- BALANCE (activo en positivo, pasivo/PN en positivo) ----------
    const AF = S(bal, ["20", "21", "22", "23", "24", "25", "26", "28", "29"]); // inmovilizado neto (amortizaciones restan)
    const E = S(bal, ["30", "31", "32", "33", "34", "35", "36", "39"]); // existencias
    const clientes = S(bal, ["43", "490"]); // clientes y efectos a cobrar (neto de deterioro)
    const otrosDeudores = S(bal, ["44", "460", "470", "471", "472", "473", "53", "54", "480", "59"]);
    const R = clientes + otrosDeudores; // realizable
    const T = S(bal, ["57"]); // tesorería
    const AC = E + R + T;
    const A = AF + AC;
    const K = -S(bal, ["10", "11", "12", "13"]) - S(bal, ["6", "7"]); // PN = capital + reservas + resultado (aunque no esté cerrado)
    const RA = -S(bal, ["14", "15", "16", "17", "18"]); // pasivo no corriente (deuda a largo)
    const PC = -S(bal, ["40", "41", "465", "475", "476", "477", "50", "51", "52", "56", "485"]); // pasivo corriente
    const proveedores = -S(bal, ["400", "401", "403", "404", "405", "406"]);
    const D = RA + PC;
    const FM = AC - PC;
    const CP = K + RA;

    // ---------- CUENTA DE RESULTADOS del periodo (ingresos en positivo) ----------
    const VB = -S(pyg, ["70"], ["706", "708", "709"]);
    const devoluciones = S(pyg, ["708"]);
    const descuentos = S(pyg, ["706", "709"]);
    const VN = -S(pyg, ["70"]);
    const otrosIngresos = -S(pyg, ["71", "73", "74", "75"]);
    const compras = S(pyg, ["60"]);
    const consumos = S(pyg, ["60", "61"]);
    const servicios = S(pyg, ["62"]);
    const tributos = S(pyg, ["63"], ["630", "633", "638"]);
    const personal = S(pyg, ["64"]);
    const otrosGastos = S(pyg, ["65"]);
    const MB = VN - consumos;
    const EBITDA = VN + otrosIngresos - consumos - servicios - tributos - personal - otrosGastos;
    const amortizaciones = S(pyg, ["68"]);
    const deterioros = S(pyg, ["69", "79"]);
    const EBIT = EBITDA - amortizaciones - deterioros; // BE: beneficio de explotación
    const ingresosFin = -S(pyg, ["76"]);
    const F = S(pyg, ["66"]); // gastos financieros (intereses de las deudas)
    const BNO = EBIT + ingresosFin - F; // beneficio neto ordinario
    const extraordinarios = -S(pyg, ["67", "77"]);
    const BAI = BNO + extraordinarios;
    const impuesto = S(pyg, ["630", "633", "638"]);
    const BN = BAI - impuesto; // beneficio neto / líquido

    // Costes variables ≈ consumos; costes fijos ≈ resto de gastos de explotación (aproximación)
    const CV = consumos;
    const CF = servicios + tributos + personal + otrosGastos + amortizaciones;

    return {
      dias,
      balance: { AF, E, clientes, otrosDeudores, R, T, AC, A, K, RA, PC, D, FM, CP, proveedores, descuadre: A - (K + RA + PC) },
      resultados: { VB, devoluciones, descuentos, VN, otrosIngresos, compras, consumos, MB, servicios, tributos, personal, otrosGastos, EBITDA, amortizaciones, deterioros, EBIT, ingresosFin, F, BNO, extraordinarios, BAI, impuesto, BN, CV, CF },
    };
  }

  // Recorre los movimientos una sola vez y acumula para el año actual y el anterior
  async function calcular(hasta) {
    const hastaPrev = menosUnAño(hasta);
    const desde = `${hasta.slice(0, 4)}-01-01`;
    const desdePrev = `${hastaPrev.slice(0, 4)}-01-01`;
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/generalLedgerEntries`;
    let url = `${base}?$select=postingDate,accountNumber,debitAmount,creditAmount,documentNumber&$filter=${encodeURIComponent(`postingDate le ${hasta}`)}`;

    const bal = new Map(), balPrev = new Map(), pyg = new Map(), pygPrev = new Map();
    // Asientos del 31/12 que tocan la 129 = asientos de REGULARIZACIÓN/CIERRE:
    // se quitan de la cuenta de resultados del periodo (si no, gastos e ingresos saldrían a 0).
    const docs3112 = new Map(); // doc|fecha -> {tiene129, pyg: Map}
    const suma = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    let n = 0;
    while (url) {
      const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`BC respondió ${r.status} leyendo los movimientos de contabilidad: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      for (const e of j.value || []) {
        n++;
        const cta = String(e.accountNumber || "");
        const f = String(e.postingDate || "").slice(0, 10);
        const v = (Number(e.debitAmount) || 0) - (Number(e.creditAmount) || 0);
        suma(bal, cta, v);
        if (f <= hastaPrev) suma(balPrev, cta, v);
        const esPyg = cta.startsWith("6") || cta.startsWith("7");
        if (f.endsWith("-12-31")) {
          const k = `${e.documentNumber}|${f}`;
          if (!docs3112.has(k)) docs3112.set(k, { tiene129: false, movs: [] });
          const d = docs3112.get(k);
          if (cta.startsWith("129")) d.tiene129 = true;
          if (esPyg) d.movs.push([cta, v, f]);
        }
        if (esPyg) {
          if (f >= desde) suma(pyg, cta, v);
          if (f >= desdePrev && f <= hastaPrev) suma(pygPrev, cta, v);
        }
      }
      url = j["@odata.nextLink"] || null;
    }
    // Quitar los asientos de cierre de la cuenta de resultados
    let movsCierre = 0;
    for (const d of docs3112.values()) {
      if (!d.tiene129) continue;
      for (const [cta, v, f] of d.movs) {
        movsCierre++;
        if (f >= desde) suma(pyg, cta, -v);
        if (f >= desdePrev && f <= hastaPrev) suma(pygPrev, cta, -v);
      }
    }
    // Detalle por cuenta (gastos/ingresos del periodo y saldos) para el simulador de escenarios
    const nombres = await nombresCuentas(token);
    const r2 = (m) => Object.fromEntries([...m].filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    const dias = (d1, d2) => Math.round((new Date(`${d2}T00:00:00Z`) - new Date(`${d1}T00:00:00Z`)) / 86400000) + 1;
    return {
      empresa: EMPRESA_NOMBRE(),
      hasta,
      desde,
      hastaPrev,
      desdePrev,
      movimientos: n,
      movsCierreExcluidos: movsCierre,
      actual: masas(bal, pyg, dias(desde, hasta)),
      anterior: masas(balPrev, pygPrev, dias(desdePrev, hastaPrev)),
      cuentas: { pyg: r2(pyg), pygPrev: r2(pygPrev), bal: r2(bal), nombres },
      calculado: new Date().toISOString(),
    };
  }

  app.get("/api/contabilidad/ratios", async (req, res) => {
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hasta || "")) ? req.query.hasta : new Date().toISOString().slice(0, 10);
    const clave = `${EMPRESA_ID()}|${hasta}`;
    const c = cache.get(clave);
    if (c && !req.query.refrescar && Date.now() - c.ts < 30 * 60 * 1000) return res.json({ ...c.datos, deCache: true });
    try {
      const datos = await calcular(hasta);
      cache.set(clave, { ts: Date.now(), datos });
      console.log(`[contabilidad/ratios] ${datos.empresa} hasta ${hasta}: ${datos.movimientos} movimientos (${datos.movsCierreExcluidos} de cierre excluidos)`);
      res.json(datos);
    } catch (err) {
      console.error("Error /api/contabilidad/ratios:", err);
      res.status(500).json({ error: "No se pudieron calcular los ratios.", detalle: String(err.message || err) });
    }
  });
};
