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
    // Cuenta 771 completa (77100000–771999999). Es ingreso (haber): el mapa
    // guarda debe − haber, así que el importe a sumar en el EBITDA es −S.
    const cta771 = -S(pyg, ["771"]);
    const MB = VN - consumos;
    const EBITDA = VN + otrosIngresos + cta771 - consumos - servicios - tributos - personal - otrosGastos;
    const amortizaciones = S(pyg, ["68"]);
    const deterioros = S(pyg, ["69", "79"]);
    const EBIT = EBITDA - amortizaciones - deterioros; // BE: beneficio de explotación
    const ingresosFin = -S(pyg, ["76"]);
    const F = S(pyg, ["66"]); // gastos financieros (intereses de las deudas)
    const BNO = EBIT + ingresosFin - F; // beneficio neto ordinario
    // La 771 ya va sumada en el EBITDA; se excluye aquí para no contarla otra vez.
    const extraordinarios = -S(pyg, ["67", "77"], ["771"]);
    const BAI = BNO + extraordinarios;
    const impuesto = S(pyg, ["630", "633", "638"]);
    const BN = BAI - impuesto; // beneficio neto / líquido

    // Costes variables ≈ consumos; costes fijos ≈ resto de gastos de explotación (aproximación)
    const CV = consumos;
    const CF = servicios + tributos + personal + otrosGastos + amortizaciones;

    return {
      dias,
      balance: { AF, E, clientes, otrosDeudores, R, T, AC, A, K, RA, PC, D, FM, CP, proveedores, descuadre: A - (K + RA + PC) },
      resultados: { VB, devoluciones, descuentos, VN, cta771, otrosIngresos, compras, consumos, MB, servicios, tributos, personal, otrosGastos, EBITDA, amortizaciones, deterioros, EBIT, ingresosFin, F, BNO, extraordinarios, BAI, impuesto, BN, CV, CF },
    };
  }

  // Serie de los últimos 24 meses para el cuadro de mando. No cambia el cálculo actual/anterior.
  function serieMensual(deltaBal, deltaPyg, hasta, masasFn) {
    const nDias = (d1, d2) => Math.round((new Date(`${d2}T00:00:00Z`) - new Date(`${d1}T00:00:00Z`)) / 86400000) + 1;
    const finMes = (mes) => {
      const [y, m] = mes.split("-").map(Number);
      return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    };
    const fusion = (dest, src) => { if (src) for (const [k, v] of src) dest.set(k, (dest.get(k) || 0) + v); };
    const ratio = (a, b) => (b && isFinite(a / b) ? a / b : null);
    const meses = [...new Set([...deltaBal.keys(), ...deltaPyg.keys()])].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
    const acumB = new Map();
    let acumP = new Map();
    let anio = "";
    const limite = new Date(`${hasta}T00:00:00Z`);
    limite.setUTCMonth(limite.getUTCMonth() - 23);
    const desdeSerie = limite.toISOString().slice(0, 7);
    const puntos = [];
    for (const mes of meses) {
      if (mes.slice(0, 4) !== anio) { acumP = new Map(); anio = mes.slice(0, 4); }
      fusion(acumB, deltaBal.get(mes));
      fusion(acumP, deltaPyg.get(mes));
      if (mes < desdeSerie || mes > hasta.slice(0, 7)) continue;
      const corte = finMes(mes) > hasta ? hasta : finMes(mes);
      const desdeY = `${anio}-01-01`;
      if (corte < desdeY) continue;
      const m = masasFn(acumB, acumP, nDias(desdeY, corte));
      const b = m.balance, r = m.resultados, d = m.dias || 1;
      const anual = 365 / d;
      puntos.push({
        mes,
        re: ratio(r.EBIT * anual, b.A),
        rf: ratio(r.BN * anual, b.K),
        margen: ratio(r.EBIT, r.VN),
        tesoreria: b.T,
        endeudamiento: ratio(b.D, b.K),
        fm: b.FM,
        clientes: b.clientes,
        proveedores: b.proveedores,
        pme: ratio(b.clientes, r.VN * 1.21) != null ? ratio(b.clientes, r.VN * 1.21) * d : null,
        pmp: ratio(b.proveedores, r.compras * 1.21) != null ? ratio(b.proveedores, r.compras * 1.21) * d : null,
      });
    }
    return puntos;
  }

  // Recorre los movimientos una sola vez y acumula para el año actual y el anterior
  async function calcular(hasta, desde) {
    const hastaPrev = menosUnAño(hasta);
    const desdePrev = menosUnAño(desde);
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/generalLedgerEntries`;
    let url = `${base}?$select=postingDate,accountNumber,debitAmount,creditAmount,documentNumber&$filter=${encodeURIComponent(`postingDate le ${hasta}`)}`;

    const bal = new Map(), balPrev = new Map(), pyg = new Map(), pygPrev = new Map();
    // Deltas mensuales solo para la serie del cuadro de mando. No alteran bal/pyg.
    const deltaBal = new Map(), deltaPyg = new Map();
    const addMes = (mapa, mes, cta, v) => {
      if (!mapa.has(mes)) mapa.set(mes, new Map());
      suma(mapa.get(mes), cta, v);
    };
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
        const esPyg = cta.startsWith("6") || cta.startsWith("7");
        suma(bal, cta, v);
        if (f <= hastaPrev) suma(balPrev, cta, v);
        const mes = f.slice(0, 7);
        if (mes.length === 7) {
          addMes(deltaBal, mes, cta, v);
          if (esPyg) addMes(deltaPyg, mes, cta, v);
        }
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
        const mes = String(f).slice(0, 7);
        if (deltaPyg.has(mes)) suma(deltaPyg.get(mes), cta, -v);
      }
    }
    let serie = [];
    try { serie = serieMensual(deltaBal, deltaPyg, hasta, masas); } catch (e) { console.error("serie mensual:", e); }
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
      serie,
      cuentas: { pyg: r2(pyg), pygPrev: r2(pygPrev), bal: r2(bal), nombres },
      calculado: new Date().toISOString(),
    };
  }

  app.get("/api/contabilidad/ratios", async (req, res) => {
    const fechaOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
    const hasta = fechaOk(req.query.hasta) ? req.query.hasta : new Date().toISOString().slice(0, 10);
    const desde = fechaOk(req.query.desde) ? req.query.desde : `${hasta.slice(0, 4)}-01-01`;
    if (desde > hasta) return res.status(400).json({ error: "La fecha inicial no puede ser posterior a la fecha final." });
    const clave = `${EMPRESA_ID()}|${desde}|${hasta}`;
    const c = cache.get(clave);
    if (c && !req.query.refrescar && Date.now() - c.ts < 30 * 60 * 1000) return res.json({ ...c.datos, deCache: true });
    try {
      const datos = await calcular(hasta, desde);
      cache.set(clave, { ts: Date.now(), datos });
      console.log(`[contabilidad/ratios] ${datos.empresa} hasta ${hasta}: ${datos.movimientos} movimientos (${datos.movsCierreExcluidos} de cierre excluidos)`);
      res.json(datos);
    } catch (err) {
      console.error("Error /api/contabilidad/ratios:", err);
      res.status(500).json({ error: "No se pudieron calcular los ratios.", detalle: String(err.message || err) });
    }
  });

  // Facturas abiertas de venta y de compra, agrupadas por cliente y proveedor.
  const cacheTerceros = new Map();
  app.get("/api/contabilidad/circulante-terceros", async (req, res) => {
    const clave = EMPRESA_ID();
    const c = cacheTerceros.get(clave);
    if (c && Date.now() - c.ts < 30 * 60 * 1000 && req.query.refrescar !== "1") return res.json(c.datos);
    try {
      const token = await obtenerTokenBC();
      const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
      const hoy = new Date().toISOString().slice(0, 10);
      const leer = async (entidad, campos) => {
        const filtro = encodeURIComponent(`status eq 'Open'`);
        let url = `${raiz}/${entidad}?$select=${campos}&$filter=${filtro}`;
        const out = [];
        while (url && out.length < 8000) {
          const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`BC ${entidad} ${r.status}: ${(await r.text()).slice(0, 180)}`);
          const j = await r.json();
          out.push(...(j.value || []));
          url = j["@odata.nextLink"] || null;
        }
        return out;
      };
      const diasEntre = (a, b) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
        return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
      };
      const agrupar = (facturas, nombreDe) => {
        const map = new Map();
        for (const f of facturas) {
          if (f.status && f.status !== "Open") continue;
          const nombre = nombreDe(f) || "Sin nombre";
          const imp = Number(f.totalAmountIncludingTax) || 0;
          if (!(imp > 0)) continue;
          const inv = String(f.invoiceDate || "").slice(0, 10);
          const due = String(f.dueDate || "").slice(0, 10);
          const ant = diasEntre(inv, hoy);
          const plazo = diasEntre(inv, due);
          const g = map.get(nombre) || { nombre, pendiente: 0, antP: 0, plazoP: 0, conAnt: 0, conPlazo: 0 };
          g.pendiente += imp;
          if (ant != null) { g.antP += ant * imp; g.conAnt += imp; }
          if (plazo != null) { g.plazoP += plazo * imp; g.conPlazo += imp; }
          map.set(nombre, g);
        }
        const total = [...map.values()].reduce((s, g) => s + g.pendiente, 0);
        return [...map.values()].map((g) => ({
          nombre: g.nombre,
          pendiente: Math.round(g.pendiente),
          dias: g.conAnt ? Math.round(g.antP / g.conAnt) : null,
          plazo: g.conPlazo ? Math.round(g.plazoP / g.conPlazo) : null,
          peso: total ? g.pendiente / total : null,
        })).sort((a, b) => b.pendiente - a.pendiente).slice(0, 8);
      };
      const [ventas, compras] = await Promise.all([
        leer("salesInvoices", "customerName,customerNumber,invoiceDate,dueDate,status,totalAmountIncludingTax"),
        leer("purchaseInvoices", "vendorName,vendorNumber,invoiceDate,dueDate,status,totalAmountIncludingTax"),
      ]);
      const datos = {
        clientes: agrupar(ventas, (f) => f.customerName || f.customerNumber),
        proveedores: agrupar(compras, (f) => f.vendorName || f.vendorNumber),
        calculado: new Date().toISOString(),
      };
      cacheTerceros.set(clave, { ts: Date.now(), datos });
      res.json(datos);
    } catch (err) {
      console.error("Error /api/contabilidad/circulante-terceros:", err);
      res.status(500).json({ error: "No se pudieron leer las facturas abiertas.", detalle: String(err.message || err) });
    }
  });
};
