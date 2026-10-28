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
 * para comparar. El último resultado se guarda en disco por empresa:
 * al abrir la pantalla se enseña ese resultado. Solo «Actualizar» vuelve a leer BC.
 */
const fs = require("fs");
const path = require("path");

module.exports = function montarContabilidad({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, EMPRESA_NOMBRE, db, claveEmpresa }) {
  const cache = new Map();
  const cacheNombres = new Map(); // empresa -> {ts, mapa}
  const dirGuardado = path.join(__dirname, "data", "ratios");

  function rutaGuardado() {
    const seguro = String(EMPRESA_ID() || "defecto").replace(/[^\w.-]/g, "_");
    return path.join(dirGuardado, seguro + ".json");
  }

  function leerGuardado() {
    try {
      return JSON.parse(fs.readFileSync(rutaGuardado(), "utf8"));
    } catch {
      return null;
    }
  }

  function escribirGuardado(datos) {
    fs.mkdirSync(dirGuardado, { recursive: true });
    const copia = { ...datos, guardado: true };
    delete copia.deCache;
    fs.writeFileSync(rutaGuardado(), JSON.stringify(copia));
    return copia;
  }

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

  // Recorre los movimientos una sola vez y acumula el periodo a analizar y el de comparación.
  async function calcular(hasta, desde, hastaPrev, desdePrev) {
    hastaPrev = hastaPrev || menosUnAño(hasta);
    desdePrev = desdePrev || menosUnAño(desde);
    const corte = hastaPrev > hasta ? hastaPrev : hasta;
    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})/generalLedgerEntries`;
    let url = `${base}?$select=postingDate,accountNumber,debitAmount,creditAmount,documentNumber&$filter=${encodeURIComponent(`postingDate le ${corte}`)}`;

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
        if (f <= hasta) suma(bal, cta, v);
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
          if (f >= desde && f <= hasta) suma(pyg, cta, v);
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
        if (f >= desde && f <= hasta) suma(pyg, cta, -v);
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
      cuentas: { pyg: r2(pyg), pygPrev: r2(pygPrev), bal: r2(bal), balPrev: r2(balPrev), nombres },
      calculado: new Date().toISOString(),
    };
  }

  app.get("/api/contabilidad/ratios/ultimo", (req, res) => {
    const guardado = leerGuardado();
    if (!guardado) return res.status(404).json({ error: "No hay cifras guardadas." });
    res.json(guardado);
  });

  app.get("/api/contabilidad/ratios", async (req, res) => {
    const fechaOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
    const hasta = fechaOk(req.query.hasta) ? req.query.hasta : new Date().toISOString().slice(0, 10);
    const desde = fechaOk(req.query.desde) ? req.query.desde : `${hasta.slice(0, 4)}-01-01`;
    const hastaPrev = fechaOk(req.query.hastaPrev) ? req.query.hastaPrev : menosUnAño(hasta);
    const desdePrev = fechaOk(req.query.desdePrev) ? req.query.desdePrev : menosUnAño(desde);
    if (desde > hasta) return res.status(400).json({ error: "En el periodo a analizar, la fecha inicial no puede ser posterior a la final." });
    if (desdePrev > hastaPrev) return res.status(400).json({ error: "En la comparación, la fecha inicial no puede ser posterior a la final." });
    const clave = `${EMPRESA_ID()}|${desde}|${hasta}|${desdePrev}|${hastaPrev}|ctas`;
    const c = cache.get(clave);
    if (c && !req.query.refrescar && Date.now() - c.ts < 30 * 60 * 1000) return res.json({ ...c.datos, deCache: true });
    try {
      const datos = escribirGuardado(await calcular(hasta, desde, hastaPrev, desdePrev));
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
    if (c && c.datos?.conFacturas && Date.now() - c.ts < 30 * 60 * 1000 && req.query.refrescar !== "1") return res.json(c.datos);
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
          const g = map.get(nombre) || { nombre, pendiente: 0, antP: 0, plazoP: 0, conAnt: 0, conPlazo: 0, facturas: [] };
          g.pendiente += imp;
          if (ant != null) { g.antP += ant * imp; g.conAnt += imp; }
          if (plazo != null) { g.plazoP += plazo * imp; g.conPlazo += imp; }
          g.facturas.push({
            numero: String(f.number || ""),
            fecha: inv,
            vencimiento: due,
            importe: imp,
            dias: ant,
            plazo,
          });
          map.set(nombre, g);
        }
        const total = [...map.values()].reduce((s, g) => s + g.pendiente, 0);
        return [...map.values()].map((g) => {
          const todas = g.facturas.slice().sort((a, b) => b.importe - a.importe);
          return {
            nombre: g.nombre,
            pendiente: Math.round(g.pendiente),
            dias: g.conAnt ? Math.round(g.antP / g.conAnt) : null,
            plazo: g.conPlazo ? Math.round(g.plazoP / g.conPlazo) : null,
            peso: total ? g.pendiente / total : null,
            facturas: todas.slice(0, 40).map((x) => ({
              numero: x.numero,
              fecha: x.fecha,
              vencimiento: x.vencimiento,
              importe: Math.round(x.importe * 100) / 100,
              dias: x.dias,
              plazo: x.plazo,
            })),
            facturasTotal: todas.length,
          };
        }).sort((a, b) => b.pendiente - a.pendiente).slice(0, 8);
      };
      const [ventas, compras] = await Promise.all([
        leer("salesInvoices", "number,customerName,customerNumber,invoiceDate,dueDate,status,totalAmountIncludingTax"),
        leer("purchaseInvoices", "number,vendorName,vendorNumber,invoiceDate,dueDate,status,totalAmountIncludingTax"),
      ]);
      const datos = {
        clientes: agrupar(ventas, (f) => f.customerName || f.customerNumber),
        proveedores: agrupar(compras, (f) => f.vendorName || f.vendorNumber),
        conFacturas: true,
        calculado: new Date().toISOString(),
      };
      cacheTerceros.set(clave, { ts: Date.now(), datos });
      res.json(datos);
    } catch (err) {
      console.error("Error /api/contabilidad/circulante-terceros:", err);
      res.status(500).json({ error: "No se pudieron leer las facturas abiertas.", detalle: String(err.message || err) });
    }
  });

  // ------------------------------------------------------------------
  // Deuda abierta por cliente (Anàlisi per client · bloc C).
  // Facturas / abonos Open + límit de crèdit si BC el exposa.
  // ------------------------------------------------------------------
  const cacheDeudaCli = new Map();
  app.get("/api/analisis-cliente/deuda", async (req, res) => {
    const numero = String(req.query.numero || "").trim();
    const nombre = String(req.query.nombre || "").trim();
    if (!numero && !nombre) {
      return res.status(400).json({ error: "Falta 'numero' o 'nombre' de client." });
    }
    const claveCache = `${EMPRESA_ID()}|open`;
    try {
      const token = await obtenerTokenBC();
      const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
      const hoy = new Date().toISOString().slice(0, 10);

      const leerOpen = async (entidad, campos) => {
        let cached = cacheDeudaCli.get(`${claveCache}|${entidad}`);
        if (cached && Date.now() - cached.ts < 15 * 60 * 1000 && req.query.refrescar !== "1") {
          return cached.rows;
        }
        const filtro = encodeURIComponent(`status eq 'Open'`);
        let url = `${raiz}/${entidad}?$select=${campos}&$filter=${filtro}`;
        const out = [];
        while (url && out.length < 10000) {
          const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`BC ${entidad} ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const j = await r.json();
          out.push(...(j.value || []));
          url = j["@odata.nextLink"] || null;
        }
        cacheDeudaCli.set(`${claveCache}|${entidad}`, { ts: Date.now(), rows: out });
        return out;
      };

      const diasEntre = (a, b) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
        return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
      };

      const coincide = (f) => {
        const n = String(f.customerNumber || "").trim();
        const nom = String(f.customerName || "").trim();
        if (numero && n && n.toLowerCase() === numero.toLowerCase()) return true;
        if (nombre && nom && nom.toLowerCase() === nombre.toLowerCase()) return true;
        if (numero && !n && nombre && nom && nom.toLowerCase() === nombre.toLowerCase()) return true;
        return false;
      };

      const [ventas, abonos] = await Promise.all([
        leerOpen("salesInvoices", "number,customerName,customerNumber,invoiceDate,dueDate,status,totalAmountIncludingTax,totalAmountExcludingTax"),
        leerOpen("salesCreditMemos", "number,customerName,customerNumber,creditMemoDate,dueDate,status,totalAmountIncludingTax,totalAmountExcludingTax"),
      ]);

      const mapFactura = (f, tipo) => {
        const fecha = String(f.invoiceDate || f.creditMemoDate || "").slice(0, 10);
        const vencimiento = String(f.dueDate || "").slice(0, 10);
        const importe = Number(f.totalAmountIncludingTax) || 0;
        const base = Number(f.totalAmountExcludingTax) || 0;
        const diasVencido = vencimiento ? diasEntre(vencimiento, hoy) : null;
        let aging = "senseVenc";
        if (diasVencido == null) aging = "senseVenc";
        else if (diasVencido <= 0) aging = "noVenc";
        else if (diasVencido <= 30) aging = "d1_30";
        else if (diasVencido <= 60) aging = "d31_60";
        else if (diasVencido <= 90) aging = "d61_90";
        else aging = "d90";
        return {
          tipo,
          numero: String(f.number || ""),
          fecha,
          vencimiento,
          importe,
          base,
          status: String(f.status || "Open"),
          diasVencido,
          aging,
          vencida: diasVencido != null && diasVencido > 0,
        };
      };

      const facturas = ventas.filter(coincide).map((f) => mapFactura(f, "factura"));
      const creditos = abonos.filter(coincide).map((f) => mapFactura(f, "abono"));

      let creditLimit = null;
      let balance = null;
      let overdueAmount = null;
      let creditLimitDisponible = false;
      try {
        const esc = (v) => String(v || "").replace(/'/g, "''");
        const filtros = [];
        if (numero) filtros.push(`number eq '${esc(numero)}'`);
        if (nombre) filtros.push(`displayName eq '${esc(nombre)}'`);
        for (const f of filtros) {
          const r = await fetchConReintento(
            `${raiz}/customers?$filter=${encodeURIComponent(f)}&$select=number,displayName,creditLimit,balance,overdueAmount&$top=1`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!r.ok) {
            // Alguns tenants no exposen balance/overdueAmount; reintenta només creditLimit.
            const r2 = await fetchConReintento(
              `${raiz}/customers?$filter=${encodeURIComponent(f)}&$select=number,displayName,creditLimit&$top=1`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!r2.ok) continue;
            const v2 = ((await r2.json()).value || [])[0];
            if (v2) {
              creditLimit = v2.creditLimit != null ? Number(v2.creditLimit) : null;
              creditLimitDisponible = creditLimit != null && Number.isFinite(creditLimit);
              break;
            }
            continue;
          }
          const v = ((await r.json()).value || [])[0];
          if (v) {
            creditLimit = v.creditLimit != null ? Number(v.creditLimit) : null;
            balance = v.balance != null ? Number(v.balance) : null;
            overdueAmount = v.overdueAmount != null ? Number(v.overdueAmount) : null;
            creditLimitDisponible = creditLimit != null && Number.isFinite(creditLimit);
            break;
          }
        }
      } catch { /* sense fitxa client */ }

      const pendiente = facturas.reduce((s, x) => s + x.importe, 0);
      const vencido = facturas.filter((x) => x.vencida).reduce((s, x) => s + x.importe, 0);
      const noVencido = pendiente - vencido;
      const abonosPend = creditos.reduce((s, x) => s + x.importe, 0);
      const exposicion = Math.max(0, pendiente - abonosPend);
      const aging = {
        noVenc: facturas.filter((x) => x.aging === "noVenc").reduce((s, x) => s + x.importe, 0),
        d1_30: facturas.filter((x) => x.aging === "d1_30").reduce((s, x) => s + x.importe, 0),
        d31_60: facturas.filter((x) => x.aging === "d31_60").reduce((s, x) => s + x.importe, 0),
        d61_90: facturas.filter((x) => x.aging === "d61_90").reduce((s, x) => s + x.importe, 0),
        d90: facturas.filter((x) => x.aging === "d90").reduce((s, x) => s + x.importe, 0),
        senseVenc: facturas.filter((x) => x.aging === "senseVenc").reduce((s, x) => s + x.importe, 0),
      };

      res.json({
        calculado: new Date().toISOString(),
        hoy,
        cliente: { numero: numero || null, nombre: nombre || null },
        pendiente,
        vencido,
        noVencido,
        abonosPendientes: abonosPend,
        exposicion,
        creditLimit,
        creditLimitDisponible,
        balance,
        overdueAmount,
        aging,
        facturas: facturas.sort((a, b) => String(b.vencimiento || b.fecha).localeCompare(String(a.vencimiento || a.fecha))),
        abonos: creditos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))),
        // Camps del document A–G que la font actual no cobreix:
        parcialmenteCobradas: null,
        retencionesGarantia: null,
        facturasReclamadas: null,
        avisos: [
          "Import = total amb IVA de documents amb estat Open (mateixa regla que Circulant).",
          "No es distingeixen cobraments parcials (la API estàndard no porta Remaining Amount).",
          "Retencions de garantia i reclamacions: no disponibles a la font actual.",
        ],
      });
    } catch (err) {
      console.error("Error /api/analisis-cliente/deuda:", err);
      res.status(500).json({ error: "No s'ha pogut llegir la deute del client.", detalle: String(err.message || err) });
    }
  });

  // ------------------------------------------------------------------
  // Comportament de pagament (Anàlisi per client · bloc D).
  // Històric: factures Paid del període (data cobrament ≈ lastModifiedDateTime).
  // Previsió: factures Open per venciment.
  // ------------------------------------------------------------------
  app.get("/api/analisis-cliente/comportamiento", async (req, res) => {
    const numero = String(req.query.numero || "").trim();
    const nombre = String(req.query.nombre || "").trim();
    const desde = String(req.query.desde || "").slice(0, 10);
    const hasta = String(req.query.hasta || "").slice(0, 10);
    if (!numero && !nombre) {
      return res.status(400).json({ error: "Falta 'numero' o 'nombre' de client." });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return res.status(400).json({ error: "Cal 'desde' i 'hasta' (YYYY-MM-DD)." });
    }
    try {
      const token = await obtenerTokenBC();
      const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
      const hoy = new Date().toISOString().slice(0, 10);
      const esc = (v) => String(v || "").replace(/'/g, "''");

      const diasEntre = (a, b) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
        return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
      };

      const coincide = (f) => {
        const n = String(f.customerNumber || "").trim();
        const nom = String(f.customerName || "").trim();
        if (numero && n && n.toLowerCase() === numero.toLowerCase()) return true;
        if (nombre && nom && nom.toLowerCase() === nombre.toLowerCase()) return true;
        return false;
      };

      const leerFiltrado = async (filtroExtra, campos) => {
        const partes = [];
        if (numero) partes.push(`customerNumber eq '${esc(numero)}'`);
        else if (nombre) partes.push(`customerName eq '${esc(nombre)}'`);
        if (filtroExtra) partes.push(filtroExtra);
        const filtro = encodeURIComponent(partes.join(" and "));
        let url = `${raiz}/salesInvoices?$select=${campos}&$filter=${filtro}`;
        const out = [];
        while (url && out.length < 8000) {
          const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`BC salesInvoices ${r.status}: ${(await r.text()).slice(0, 220)}`);
          const j = await r.json();
          out.push(...(j.value || []));
          url = j["@odata.nextLink"] || null;
        }
        return out;
      };

      const campos =
        "number,customerName,customerNumber,invoiceDate,dueDate,status,totalAmountIncludingTax,totalAmountExcludingTax,lastModifiedDateTime";

      // Històric del període (totes les factures amb data factura al rang) + obertes (previsió)
      const [delPeriodo, abiertas] = await Promise.all([
        leerFiltrado(`invoiceDate ge ${desde} and invoiceDate le ${hasta}`, campos),
        (async () => {
          // Reutilitza la mateixa cache d'Open que el bloc C si existeix
          const claveCache = `${EMPRESA_ID()}|open|salesInvoices`;
          let cached = cacheDeudaCli.get(claveCache);
          if (cached && Date.now() - cached.ts < 15 * 60 * 1000 && req.query.refrescar !== "1") {
            return (cached.rows || []).filter(coincide);
          }
          return leerFiltrado(`status eq 'Open'`, campos);
        })(),
      ]);

      const facturasPeriodo = (numero || nombre ? delPeriodo.filter(coincide) : delPeriodo).map((f) => {
        const fecha = String(f.invoiceDate || "").slice(0, 10);
        const vencimiento = String(f.dueDate || "").slice(0, 10);
        const status = String(f.status || "").trim();
        const importe = Number(f.totalAmountIncludingTax) || 0;
        const base = Number(f.totalAmountExcludingTax) || 0;
        const cobroAprox = status.toLowerCase() === "paid" ? String(f.lastModifiedDateTime || "").slice(0, 10) : "";
        const plazoPactado = diasEntre(fecha, vencimiento);
        const plazoReal = cobroAprox ? diasEntre(fecha, cobroAprox) : null;
        const retraso = cobroAprox && vencimiento ? diasEntre(vencimiento, cobroAprox) : null;
        return {
          numero: String(f.number || ""),
          fecha,
          vencimiento,
          status,
          importe,
          base,
          cobroAprox: cobroAprox || null,
          plazoPactado,
          plazoReal,
          retraso,
          puntual: retraso != null ? retraso <= 0 : null,
        };
      });

      const cobradas = facturasPeriodo.filter((f) => String(f.status).toLowerCase() === "paid" && f.cobroAprox);
      const openList = abiertas.filter(coincide).map((f) => {
        const fecha = String(f.invoiceDate || "").slice(0, 10);
        const vencimiento = String(f.dueDate || "").slice(0, 10);
        const importe = Number(f.totalAmountIncludingTax) || 0;
        const diasVencido = vencimiento ? diasEntre(vencimiento, hoy) : null;
        return {
          numero: String(f.number || ""),
          fecha,
          vencimiento,
          importe,
          diasVencido,
          vencida: diasVencido != null && diasVencido > 0,
        };
      });

      const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

      const plazosReales = cobradas.map((f) => f.plazoReal).filter((n) => n != null);
      const retrasos = cobradas.map((f) => f.retraso).filter((n) => n != null);
      const retrasosPos = retrasos.filter((n) => n > 0);
      const plazosPactados = facturasPeriodo.map((f) => f.plazoPactado).filter((n) => n != null && n >= 0);
      const nPuntual = cobradas.filter((f) => f.puntual === true).length;
      const pctPuntual = cobradas.length ? nPuntual / cobradas.length : null;
      const importeMedio =
        facturasPeriodo.length > 0
          ? facturasPeriodo.reduce((s, f) => s + f.importe, 0) / facturasPeriodo.length
          : null;
      const mayorRetrasoHist = retrasos.length ? Math.max(...retrasos) : null;
      const mayorRetrasoOpen = openList.reduce((m, f) => Math.max(m, f.diasVencido != null && f.diasVencido > 0 ? f.diasVencido : 0), 0);
      const mayorRetraso =
        mayorRetrasoHist != null || mayorRetrasoOpen > 0
          ? Math.max(mayorRetrasoHist != null ? mayorRetrasoHist : 0, mayorRetrasoOpen)
          : null;
      const incidencias = retrasosPos.length + openList.filter((f) => f.vencida).length;

      // Evolució mensual (per data de cobrament aproximada)
      const porMes = new Map();
      for (const f of cobradas) {
        const mes = (f.cobroAprox || "").slice(0, 7);
        if (!mes) continue;
        const g = porMes.get(mes) || { mes, n: 0, retrasoSum: 0, puntual: 0, importe: 0 };
        g.n += 1;
        g.retrasoSum += f.retraso || 0;
        if (f.puntual) g.puntual += 1;
        g.importe += f.importe;
        porMes.set(mes, g);
      }
      const evolucion = [...porMes.values()]
        .sort((a, b) => a.mes.localeCompare(b.mes))
        .map((g) => ({
          mes: g.mes,
          n: g.n,
          retrasoMedio: g.n ? g.retrasoSum / g.n : null,
          pctPuntual: g.n ? g.puntual / g.n : null,
          importe: g.importe,
        }));

      // Previsió per setmana / mes (venciments Open futurs o ja vençuts)
      const isoSemana = (iso) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
        const d = new Date(`${iso}T00:00:00Z`);
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
      };
      const porSemana = new Map();
      const porMesPrev = new Map();
      for (const f of openList) {
        const v = f.vencimiento || f.fecha;
        if (!v) continue;
        const sem = isoSemana(v);
        const mes = v.slice(0, 7);
        if (sem) {
          const g = porSemana.get(sem) || { clave: sem, importe: 0, n: 0, vencidas: 0 };
          g.importe += f.importe;
          g.n += 1;
          if (f.vencida) g.vencidas += 1;
          porSemana.set(sem, g);
        }
        if (mes) {
          const g = porMesPrev.get(mes) || { clave: mes, importe: 0, n: 0, vencidas: 0 };
          g.importe += f.importe;
          g.n += 1;
          if (f.vencida) g.vencidas += 1;
          porMesPrev.set(mes, g);
        }
      }
      const previsionSemana = [...porSemana.values()].sort((a, b) => a.clave.localeCompare(b.clave));
      const previsionMes = [...porMesPrev.values()].sort((a, b) => a.clave.localeCompare(b.clave));

      res.json({
        calculado: new Date().toISOString(),
        hoy,
        desde,
        hasta,
        cliente: { numero: numero || null, nombre: nombre || null },
        nFacturasPeriodo: facturasPeriodo.length,
        nCobradasConFecha: cobradas.length,
        nOpen: openList.length,
        plazoMedioReal: avg(plazosReales),
        plazoMedioPactado: avg(plazosPactados),
        retrasoMedio: avg(retrasos),
        retrasoMedioPositivo: avg(retrasosPos),
        pctPuntual,
        importeMedio,
        mayorRetraso,
        mayorRetrasoHist,
        mayorRetrasoOpen: mayorRetrasoOpen || null,
        incidencias,
        incidenciasHist: retrasosPos.length,
        incidenciasOpen: openList.filter((f) => f.vencida).length,
        evolucion,
        previsionSemana,
        previsionMes,
        cobradas: cobradas
          .slice()
          .sort((a, b) => String(b.cobroAprox).localeCompare(String(a.cobroAprox)))
          .slice(0, 80),
        open: openList.sort((a, b) => String(a.vencimiento || "").localeCompare(String(b.vencimiento || ""))),
        metodoCobro: "lastModifiedDateTime",
        avisos: [
          "La data de cobrament és aproximada: lastModifiedDateTime de la factura quan l'estat és Paid (la API estàndard no exposa el moviment de liquidació).",
          "Puntual = cobrament aproximat ≤ venciment.",
          "Incidències = factures cobrades amb retard + factures Open ja vençudes.",
          "Previsió = import de factures Open agrupades per data de venciment.",
        ],
      });
    } catch (err) {
      console.error("Error /api/analisis-cliente/comportamiento:", err);
      res.status(500).json({ error: "No s'ha pogut calcular el comportament de pagament.", detalle: String(err.message || err) });
    }
  });

  // ------------------------------------------------------------------
  // Fitxa BC del client (bloc G) + notes administratives locals.
  // ------------------------------------------------------------------
  app.get("/api/analisis-cliente/ficha", async (req, res) => {
    const numero = String(req.query.numero || "").trim();
    const nombre = String(req.query.nombre || "").trim();
    if (!numero && !nombre) return res.status(400).json({ error: "Falta 'numero' o 'nombre'." });
    try {
      const token = await obtenerTokenBC();
      const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
      const esc = (v) => String(v || "").replace(/'/g, "''");
      const filtros = [];
      if (numero) filtros.push(`number eq '${esc(numero)}'`);
      if (nombre) filtros.push(`displayName eq '${esc(nombre)}'`);

      let cli = null;
      const camposBase =
        "number,displayName,email,phoneNumber,taxRegistrationNumber,addressLine1,addressLine2,city,postalCode,country,creditLimit,blocked";
      const camposExtra = `${camposBase},balance,paymentTermsId,paymentMethodId`;
      for (const f of filtros) {
        let r = await fetchConReintento(`${raiz}/customers?$filter=${encodeURIComponent(f)}&$select=${camposExtra}&$top=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          r = await fetchConReintento(`${raiz}/customers?$filter=${encodeURIComponent(f)}&$select=${camposBase}&$top=1`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        }
        if (!r.ok) continue;
        cli = ((await r.json()).value || [])[0] || null;
        if (cli) break;
      }
      if (!cli) return res.status(404).json({ error: "Client no trobat a la fitxa del sistema." });

      const resolverCatalogo = async (entidad, id) => {
        if (!id) return null;
        try {
          const r = await fetchConReintento(`${raiz}/${entidad}(${id})?$select=code,displayName`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) return null;
          const j = await r.json();
          return { code: j.code || "", displayName: j.displayName || "" };
        } catch {
          return null;
        }
      };

      const [terms, method] = await Promise.all([
        resolverCatalogo("paymentTerms", cli.paymentTermsId),
        resolverCatalogo("paymentMethods", cli.paymentMethodId),
      ]);

      res.json({
        numero: cli.number || "",
        nombre: cli.displayName || "",
        email: cli.email || "",
        telefono: cli.phoneNumber || "",
        cif: cli.taxRegistrationNumber || "",
        direccion: [cli.addressLine1, cli.addressLine2].filter(Boolean).join(", "),
        ciudad: cli.city || "",
        cp: cli.postalCode || "",
        pais: cli.country || "",
        creditLimit: cli.creditLimit != null ? Number(cli.creditLimit) : null,
        balance: cli.balance != null ? Number(cli.balance) : null,
        blocked: cli.blocked || "",
        paymentTerms: terms,
        paymentMethod: method,
        avisos: [
          "Dades de la fitxa de client del sistema de gestió (API customers).",
          "Termes / forma de pagament: si el tenant no exposa paymentTermsId, es mostren buits.",
          "PO client, albarà valorat, FACE, periodicitat i retencions: notes internes ACSales (no són camps BC).",
        ],
      });
    } catch (err) {
      console.error("Error /api/analisis-cliente/ficha:", err);
      res.status(500).json({ error: "No s'ha pogut llegir la fitxa del client.", detalle: String(err.message || err) });
    }
  });

  // ------------------------------------------------------------------
  // Tarifas MO (Excel): general (todos) + override opcional por client.
  // ------------------------------------------------------------------
  function leerTarifaDefectoDisco() {
    try {
      const candidatos = [
        path.join(__dirname, "data", "tarifas_mo_defecto.json"),
        path.join(__dirname, "..", "data", "tarifas_mo_defecto.json"),
      ];
      const p = candidatos.find((x) => fs.existsSync(x));
      if (!p) return null;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!j || !Array.isArray(j.filas)) return null;
      return {
        origen: j.origen || "tarifas_mo_defecto.json",
        actualizado: j.actualizado || null,
        filas: j.filas,
        ambito: "general",
      };
    } catch {
      return null;
    }
  }

  function normalizarFilasTarifa(filas) {
    return (filas || [])
      .map((r) => ({
        tipoProducto: String(r.tipoProducto || r["Tipo de producto"] || "").trim(),
        producto: String(r.producto || r["N.º de producto"] || r["No. de producto"] || r.No || "").trim(),
        descripcion: String(r.descripcion || r["Descripción"] || r.Description || "").trim(),
        tipoTrabajo: String(r.tipoTrabajo || r["Cód. tipo trabajo"] || r["Cod. tipo trabajo"] || "").trim(),
        unidad: String(r.unidad || r["Cód. unidad medida"] || "HORA").trim(),
        cantidadMin: Number(r.cantidadMin ?? r["Cantidad mínima"] ?? 0) || 0,
        precio: Number(r.precio ?? r["Precio venta"] ?? r.Unit_Price ?? 0) || 0,
      }))
      .filter((r) => r.producto || r.descripcion);
  }

  app.get("/api/analisis-cliente/tarifas", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const cliente = String(req.query.cliente || "").trim();
    try {
      const doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas"), {});
      let general = doc.general || null;
      if (!general || !Array.isArray(general.filas) || !general.filas.length) {
        general = leerTarifaDefectoDisco();
      }
      const especial = cliente && doc.clientes && doc.clientes[cliente] ? doc.clientes[cliente] : null;
      const activa = especial && especial.filas?.length ? especial : general;
      res.json({
        general,
        especial: especial || null,
        activa,
        usaEspecial: !!(especial && especial.filas?.length),
      });
    } catch (err) {
      console.error("Error GET tarifas:", err);
      res.status(500).json({ error: "No s'han pogut llegir les tarifes." });
    }
  });

  app.post("/api/analisis-cliente/tarifas", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const body = req.body || {};
    const ambito = body.ambito === "cliente" ? "cliente" : "general";
    const cliente = String(body.cliente || "").trim();
    const filas = normalizarFilasTarifa(body.filas);
    if (!filas.length) return res.status(400).json({ error: "No hi ha línies de tarifa vàlides." });
    if (ambito === "cliente" && !cliente) return res.status(400).json({ error: "Falta 'cliente' per a tarifa especial." });
    try {
      const doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas"), {});
      const bloque = {
        origen: String(body.origen || body.nombreArchivo || "excel").trim() || "excel",
        actualizado: new Date().toISOString(),
        filas,
        ambito,
      };
      if (ambito === "general") {
        doc.general = bloque;
      } else {
        if (!doc.clientes || typeof doc.clientes !== "object") doc.clientes = {};
        doc.clientes[cliente] = { ...bloque, cliente };
      }
      await db.setDoc(claveEmpresa("analisis_cliente_tarifas"), doc);
      res.json({ guardado: true, bloque });
    } catch (err) {
      console.error("Error POST tarifas:", err);
      res.status(500).json({ error: "No s'han pogut desar les tarifes." });
    }
  });

  app.delete("/api/analisis-cliente/tarifas", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const cliente = String(req.query.cliente || "").trim();
    if (!cliente) return res.status(400).json({ error: "Falta 'cliente'." });
    try {
      const doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas"), {});
      if (doc.clientes && doc.clientes[cliente]) {
        delete doc.clientes[cliente];
        await db.setDoc(claveEmpresa("analisis_cliente_tarifas"), doc);
      }
      res.json({ borrado: true });
    } catch (err) {
      console.error("Error DELETE tarifas:", err);
      res.status(500).json({ error: "No s'ha pogut treure la tarifa especial." });
    }
  });

  // ------------------------------------------------------------------
  // Esborrany tarifes 2027 (simulador). NO pisa la tarifa 2026.
  // ------------------------------------------------------------------
  app.get("/api/analisis-cliente/tarifas-2027", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const cliente = String(req.query.cliente || "").trim();
    if (!cliente) return res.status(400).json({ error: "Falta 'cliente'." });
    try {
      const doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas_2027"), {});
      res.json(doc[cliente] || null);
    } catch (err) {
      console.error("Error GET tarifas-2027:", err);
      res.status(500).json({ error: "No s'ha pogut llegir l'esborrany 2027." });
    }
  });

  app.post("/api/analisis-cliente/tarifas-2027", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const body = req.body || {};
    const cliente = String(body.cliente || "").trim();
    if (!cliente) return res.status(400).json({ error: "Falta 'cliente'." });
    try {
      const doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas_2027"), {});
      const filasAprobadas = Array.isArray(body.filasAprobadas)
        ? body.filasAprobadas
            .map((r) => ({
              producto: String(r.producto || "").trim(),
              tipoTrabajo: String(r.tipoTrabajo || "").trim(),
              descripcion: String(r.descripcion || "").trim(),
              precio: Number(r.precio) || 0,
            }))
            .filter((r) => r.producto || r.tipoTrabajo)
        : [];
      const bloque = {
        costePrevisto: Number(body.costePrevisto) || 0,
        margenObjetivo: Number(body.margenObjetivo) || 0,
        pctEstructura: Number(body.pctEstructura) >= 0 ? Number(body.pctEstructura) : 0.22,
        filasAprobadas,
        actualizado: new Date().toISOString(),
      };
      doc[cliente] = bloque;
      await db.setDoc(claveEmpresa("analisis_cliente_tarifas_2027"), doc);
      res.json({ guardado: true, borrador: bloque });
    } catch (err) {
      console.error("Error POST tarifas-2027:", err);
      res.status(500).json({ error: "No s'ha pogut desar l'esborrany 2027." });
    }
  });

  app.get("/api/analisis-cliente/condiciones", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const cliente = String(req.query.cliente || "").trim();
    if (!cliente) return res.status(400).json({ error: "Falta 'cliente'." });
    try {
      const mapa = await db.getDoc(claveEmpresa("analisis_cliente_condiciones"), {});
      res.json(mapa[cliente] || {});
    } catch (err) {
      console.error("Error GET condiciones:", err);
      res.status(500).json({ error: "No s'han pogut llegir les condicions." });
    }
  });

  app.post("/api/analisis-cliente/condiciones", async (req, res) => {
    if (!db || !claveEmpresa) return res.status(500).json({ error: "Persistència no disponible." });
    const body = req.body || {};
    const cliente = String(body.cliente || "").trim();
    if (!cliente) return res.status(400).json({ error: "Falta 'cliente'." });
    try {
      const mapa = await db.getDoc(claveEmpresa("analisis_cliente_condiciones"), {});
      const prev = mapa[cliente] || {};
      const next = {
        ...prev,
        necesitaPO: body.necesitaPO === true || body.necesitaPO === "si" || body.necesitaPO === "Sí",
        albaranValorado: body.albaranValorado === true || body.albaranValorado === "si" || body.albaranValorado === "Sí",
        periodicidad: String(body.periodicidad || "").trim(),
        facePortal: String(body.facePortal || "").trim(),
        retenciones: String(body.retenciones || "").trim(),
        incidenciasAdmin: String(body.incidenciasAdmin || "").trim(),
        contactosExtra: String(body.contactosExtra || "").trim(),
        notas: String(body.notas || "").trim(),
        actualizado: new Date().toISOString(),
      };
      // Normalitza booleans si venen com a string buit
      if (body.necesitaPO === false || body.necesitaPO === "no" || body.necesitaPO === "No") next.necesitaPO = false;
      if (body.albaranValorado === false || body.albaranValorado === "no" || body.albaranValorado === "No") next.albaranValorado = false;
      mapa[cliente] = next;
      await db.setDoc(claveEmpresa("analisis_cliente_condiciones"), mapa);
      res.json({ guardado: true, condiciones: next });
    } catch (err) {
      console.error("Error POST condiciones:", err);
      res.status(500).json({ error: "No s'han pogut guardar les condicions." });
    }
  });

  // ------------------------------------------------------------------
  // Tasas de estructura (propia por UN + general empresa) — venta objetivo.
  // Misma lógica que venta_objetivo_ot.py (info_estructura_por_un +
  // pct_general_empresa + tasas del año en curso / último con ventas).
  // Solo LECTURA. Caché 30 min por empresa + año.
  // ------------------------------------------------------------------
  const cacheTasas = new Map();

  function codigosEstructuraEmpresa() {
    const nom = String(EMPRESA_NOMBRE() || "").toUpperCase();
    if (/FERROS|FCA/.test(nom)) {
      return { general: "_EST-FCA", prefijoPropia: "_EST-FCA-", intragrupo: ["_EST-AC", "_EST-QL"], sinReparto: ["_TIE", "_I+D"], actechs: "ACTECHS" };
    }
    if (/QUIMLAB|QL/.test(nom)) {
      return { general: "_EST-QL", prefijoPropia: "_EST-QL-", intragrupo: ["_EST-AC", "_EST-FCA"], sinReparto: ["_TIE", "_I+D"], actechs: "ACTECHS" };
    }
    return { general: "_EST-AC", prefijoPropia: "_EST-AC-", intragrupo: ["_EST-FCA", "_EST-QL"], sinReparto: ["_TIE", "_I+D"], actechs: "ACTECHS" };
  }

  function extraerActividad(codigo) {
    if (!codigo) return "";
    const c = String(codigo).trim();
    if (!c) return "";
    if (c.startsWith("_") || c === "ACTECHS") return c;
    return c.includes("-") ? c.split("-")[0] : c;
  }

  function leerCampo(f, nombres) {
    for (const n of nombres) {
      if (f[n] != null && String(f[n]).trim() !== "") return f[n];
    }
    const keys = Object.keys(f || {});
    for (const n of nombres) {
      const hit = keys.find((k) => k.toLowerCase() === n.toLowerCase());
      if (hit && f[hit] != null && String(f[hit]).trim() !== "") return f[hit];
    }
    return "";
  }

  function importeNatural(f) {
    const directo = Number(leerCampo(f, ["Importe_natural", "Amount", "Importe", "amount"]));
    if (Number.isFinite(directo) && directo !== 0) return directo;
    const debe = Number(leerCampo(f, ["Debit_Amount", "DebitAmount", "debitAmount"])) || 0;
    const haber = Number(leerCampo(f, ["Credit_Amount", "CreditAmount", "creditAmount"])) || 0;
    return debe - haber;
  }

  function normalizarOt(ot) {
    if (ot == null) return "";
    const s = String(ot).trim();
    if (!s || s.startsWith("_")) return "";
    const m = s.match(/(\d{3,})/);
    return m ? m[1].replace(/^0+/, "") || "0" : "";
  }

  function clasificarLN(ln, cfg) {
    if (!ln || ln === "nan" || ln === "NaN" || ln === "None") return "otro";
    if (cfg.intragrupo.includes(ln)) return "intragrupo";
    if (ln === cfg.general || ln === "_EST") return "estructura_general";
    if (ln.startsWith(cfg.prefijoPropia)) return "estructura_propia";
    if (cfg.sinReparto.includes(ln)) return "sin_reparto";
    if (ln === cfg.actechs || !ln.startsWith("_")) return "comercial";
    return "otro";
  }

  // Debe−haber → Importe_natural (gastos +, ingresos +)
  function importePy(f, g) {
    const raw = importeNatural(f);
    return g === "7" ? -raw : raw;
  }

  function infoEstructuraPorUn(filas, cfg) {
    const ingCom = new Map();
    const gasCom = new Map();
    const ep6 = new Map();
    const ep7 = new Map();
    let estGen6 = 0;
    let estGen7 = 0;
    for (const f of filas) {
      const cta = String(leerCampo(f, ["G_L_Account_No", "No", "accountNumber", "Nº cuenta", "Account_No"]) || "");
      const g = cta.startsWith("6") ? "6" : cta.startsWith("7") ? "7" : "";
      if (g !== "6" && g !== "7") continue;
      const ln = String(leerCampo(f, ["Shortcut_Dimension_1_Code", "Global_Dimension_1_Code", "Cód_Línea_de_negocio", "Cod_Linea_de_negocio", "Business_Unit_Code"]) || "").trim();
      const tipo = clasificarLN(ln, cfg);
      const imp = importePy(f, g);
      const act = extraerActividad(ln);
      if (tipo === "comercial") {
        if (g === "7") ingCom.set(act, (ingCom.get(act) || 0) + imp);
        else gasCom.set(act, (gasCom.get(act) || 0) + imp);
      } else if (tipo === "estructura_propia") {
        const un = ln.replace(cfg.prefijoPropia, "").trim();
        if (g === "6") ep6.set(un, (ep6.get(un) || 0) + imp);
        else ep7.set(un, (ep7.get(un) || 0) + imp);
      } else if (tipo === "estructura_general") {
        if (g === "6") estGen6 += imp;
        else estGen7 += imp;
      }
    }
    const estGenTotal = estGen6 - estGen7;
    const unes = [...new Set([...ingCom.keys(), ...gasCom.keys()])].filter(Boolean).sort();
    const totalIng = unes.reduce((a, u) => a + (ingCom.get(u) || 0), 0);
    const info = {};
    for (const un of unes) {
      const ing = ingCom.get(un) || 0;
      const estP = (ep6.get(un) || 0) - (ep7.get(un) || 0);
      const estG = (un === cfg.actechs && ing === 0) ? 0 : (totalIng ? estGenTotal * (ing / totalIng) : 0);
      info[un] = {
        ventas: ing,
        total_propia: estP,
        total_general: estG,
        ratio_propia: ing ? estP / ing : 0,
        ratio_general: ing ? estG / ing : 0,
      };
    }
    return info;
  }

  function pctGeneralEmpresa(filas, cfg) {
    let gastoGeneral = 0;
    let ventas = 0;
    for (const f of filas) {
      const ln = String(leerCampo(f, ["Shortcut_Dimension_1_Code", "Global_Dimension_1_Code", "Cód_Línea_de_negocio", "Cod_Linea_de_negocio", "Business_Unit_Code"]) || "").trim();
      if (cfg.intragrupo.includes(ln)) continue;
      const cta = String(leerCampo(f, ["G_L_Account_No", "No", "accountNumber", "Nº cuenta", "Account_No"]) || "");
      const g = cta.startsWith("6") ? "6" : cta.startsWith("7") ? "7" : "";
      if (!g) continue;
      const esGeneral = ln === cfg.general || ln === "_EST";
      const esEstructura = esGeneral || ln.startsWith(cfg.prefijoPropia);
      const cta2 = cta.slice(0, 2);
      const cta3 = cta.slice(0, 3);
      const cta4 = cta.slice(0, 4);
      const esImpSoc = g === "6" && ["6300", "6301", "6330", "6380"].includes(cta4);
      const imp = importePy(f, g);
      if (g === "6" && esGeneral && ["60", "62", "63", "64"].includes(cta2) && !esImpSoc) gastoGeneral += imp;
      if (g === "7" && cta2 !== "71" && cta3 !== "778") {
        if (!esEstructura || esGeneral) ventas += imp;
      }
    }
    return ventas ? gastoGeneral / ventas : 0;
  }

  // api_expand (default) = API + dimensiones LN/OT · ws = comportamiento anterior (revertir)
  function modoMovsDim() {
    const m = String(process.env.BC_MOVS_DIM_MODE || "api_expand").trim().toLowerCase();
    return m === "ws" ? "ws" : "api_expand";
  }

  function muestraTieneLNRellena(filas) {
    const n = Math.min(filas.length, 80);
    let con = 0;
    for (let i = 0; i < n; i++) {
      const ln = String(leerCampo(filas[i], [
        "Global_Dimension_1_Code", "Shortcut_Dimension_1_Code",
        "Cód_Línea_de_negocio", "Cod_Linea_de_negocio", "Business_Unit_Code",
      ]) || "").trim();
      if (ln) con++;
    }
    return con > 0;
  }

  function aplanarGleConDims(e) {
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
    return {
      Posting_Date: e.postingDate,
      G_L_Account_No: e.accountNumber,
      Amount: debe - haber,
      Debit_Amount: debe,
      Credit_Amount: haber,
      Global_Dimension_1_Code: ln,
      Global_Dimension_2_Code: ot,
      Shortcut_Dimension_1_Code: ln,
      Shortcut_Dimension_2_Code: ot,
      Job_No: ot,
    };
  }

  async function traerMovsApiExpandAno(token, year, intentos) {
    const cab = { headers: { Authorization: `Bearer ${token}` } };
    const ini = `${year}-01-01`;
    const fin = `${year}-12-31`;
    const apiBase = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
    const filtro = `postingDate ge ${ini} and postingDate le ${fin}`;
    let urlApi = `${apiBase}/companies(${EMPRESA_ID()})/generalLedgerEntries?$filter=${encodeURIComponent(filtro)}&$expand=dimensionSetLines`;
    const out = [];
    while (urlApi) {
      const r = await fetchConReintento(urlApi, cab);
      if (!r.ok) {
        intentos.push(`API+expand → ${r.status}`);
        return null;
      }
      const j = await r.json();
      for (const e of j.value || []) out.push(aplanarGleConDims(e));
      urlApi = j["@odata.nextLink"] || null;
      if (out.length > 250000) break;
    }
    if (!out.length) {
      intentos.push("API+expand → 0 filas");
      return null;
    }
    if (!muestraTieneLNRellena(out)) {
      intentos.push("API+expand → LN vacía en muestra");
      return null;
    }
    intentos.push(`API+expand → ${out.length} filas`);
    return { filas: out, servicio: "generalLedgerEntries+$expand", campoFecha: "postingDate", intentos };
  }

  async function traerMovsODataAno(token, year) {
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const candidatos = [...new Set([
      process.env.BC_WS_MOVSCONTAB,
      "Movs_contabilidad_Excel",
      "Movs_contabilidad",
      "G_LEntries",
      "G_L_Entries",
      "General_Ledger_Entries",
      "GLEntries",
    ].filter(Boolean))];
    const camposFecha = ["Posting_Date", "Fecha_registro", "postingDate", "Document_Date"];
    const cab = { headers: { Authorization: `Bearer ${token}` } };
    const ini = `${year}-01-01`;
    const fin = `${year}-12-31`;
    const intentos = [];
    const modo = modoMovsDim();
    intentos.push(`modo=${modo}`);

    const paginar = async (url) => {
      const out = [];
      let next = url;
      while (next) {
        const r = await fetchConReintento(next, cab);
        if (!r.ok) return { error: r.status, detalle: (await r.text()).slice(0, 200), filas: out };
        const j = await r.json();
        out.push(...(j.value || []));
        next = j["@odata.nextLink"] || null;
        if (out.length > 250000) break;
      }
      return { filas: out };
    };

    const traerWs = async () => {
      for (const servicio of candidatos) {
        for (const campo of camposFecha) {
          const filtro = `${campo} ge ${ini} and ${campo} le ${fin}`;
          const url = `${raiz}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}`;
          const r = await fetchConReintento(url, cab);
          intentos.push(`${servicio} · ${campo} → ${r.status}`);
          if (r.status === 404) break;
          if (r.status === 400) continue;
          if (!r.ok) continue;
          const primera = await r.json();
          const filas = [...(primera.value || [])];
          if (primera["@odata.nextLink"]) {
            const resto = await paginar(primera["@odata.nextLink"]);
            if (resto.error) {
              intentos.push(`${servicio} paginación → ${resto.error}`);
              continue;
            }
            filas.push(...resto.filas);
          }
          if (!filas.length) continue;
          if (!muestraTieneLNRellena(filas)) {
            intentos.push(`${servicio} · LN vacía en muestra (rechazado)`);
            break;
          }
          return { filas, servicio, campoFecha: campo, intentos };
        }
      }
      return null;
    };

    // api_expand primero (recomendado). ws = orden anterior (WS → API).
    if (modo === "api_expand") {
      try {
        const pack = await traerMovsApiExpandAno(token, year, intentos);
        if (pack) return pack;
      } catch (e) {
        intentos.push(`API+expand → error ${String(e.message || e)}`);
      }
      const ws = await traerWs();
      if (ws) return ws;
    } else {
      const ws = await traerWs();
      if (ws) return ws;
      try {
        const pack = await traerMovsApiExpandAno(token, year, intentos);
        if (pack) return pack;
      } catch (e) {
        intentos.push(`API+expand → error ${String(e.message || e)}`);
      }
    }

    return { filas: null, intentos };
  }

  app.get("/api/contabilidad/tasas-estructura", async (req, res) => {
    try {
      const hoy = new Date();
      const yearReq = parseInt(req.query.year, 10);
      const yearPreferido = Number.isFinite(yearReq) ? yearReq : hoy.getFullYear();
      const clave = `${EMPRESA_ID()}|tasas|${yearPreferido}|${modoMovsDim()}`;
      const c = cacheTasas.get(clave);
      if (c && !req.query.refrescar && Date.now() - c.ts < 30 * 60 * 1000) {
        return res.json({ ...c.datos, deCache: true });
      }

      const token = await obtenerTokenBC();
      const cfg = codigosEstructuraEmpresa();
      let year = yearPreferido;
      let pack = await traerMovsODataAno(token, year);
      if (!pack.filas || !pack.filas.length) {
        // Último año con datos: probar year-1
        const prev = await traerMovsODataAno(token, year - 1);
        if (prev.filas && prev.filas.length) {
          year = year - 1;
          pack = prev;
        }
      }
      if (!pack.filas) {
        return res.status(502).json({
          error: "No se pudo leer el web service de movimientos de contabilidad con línea de negocio.",
          intentos: pack.intentos,
          pistas: [
            "Publica en BC un servicio web de la página de movimientos de contabilidad (con Cód. Línea de negocio / dimensión 1).",
            "O indica el nombre en BC_WS_MOVSCONTAB del .env.",
          ],
        });
      }

      // Quedarse con años que tengan ventas en OTs reales (como el .py)
      const porAno = new Map();
      for (const f of pack.filas) {
        const fecha = String(leerCampo(f, ["Posting_Date", "Fecha_registro", "postingDate", "Document_Date"]) || "").slice(0, 10);
        const y = parseInt(fecha.slice(0, 4), 10);
        if (!y || y > hoy.getFullYear()) continue;
        const cta = String(leerCampo(f, ["G_L_Account_No", "No", "accountNumber", "Nº cuenta", "Account_No"]) || "");
        if (!cta.startsWith("7")) continue;
        if (!normalizarOt(leerCampo(f, ["Shortcut_Dimension_2_Code", "Global_Dimension_2_Code", "Cód_OT", "Cod_OT", "Job_No"]))) continue;
        porAno.set(y, (porAno.get(y) || 0) + 1);
      }
      const anios = [...porAno.keys()].sort((a, b) => a - b);
      if (anios.length) {
        year = anios.includes(yearPreferido) ? yearPreferido : Math.max(...anios);
      }

      const filasAno = pack.filas.filter((f) => {
        const fecha = String(leerCampo(f, ["Posting_Date", "Fecha_registro", "postingDate", "Document_Date"]) || "").slice(0, 10);
        return fecha.startsWith(String(year));
      });

      const porUn = infoEstructuraPorUn(filasAno, cfg);
      const pctGeneral = pctGeneralEmpresa(filasAno, cfg);
      const datos = {
        empresa: EMPRESA_NOMBRE(),
        year,
        pctGeneral,
        porUn,
        codigos: cfg,
        servicio: pack.servicio,
        movimientos: filasAno.length,
        calculado: new Date().toISOString(),
      };
      cacheTasas.set(clave, { ts: Date.now(), datos });
      console.log(`[contabilidad/tasas-estructura] ${datos.empresa} ${year}: general=${(pctGeneral * 100).toFixed(1)}% · UNs=${Object.keys(porUn).length} · movs=${filasAno.length}`);
      res.json(datos);
    } catch (err) {
      console.error("Error /api/contabilidad/tasas-estructura:", err);
      res.status(500).json({ error: "No se pudieron calcular las tasas de estructura.", detalle: String(err.message || err) });
    }
  });
};
