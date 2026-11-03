/**
 * Integración S2S — ficha / coste OT para Dashboard, ACTDrive y otras apps.
 *
 * Auth: X-Service-Key o Authorization: Bearer <INTEGRACIO_SERVICE_KEY>
 *
 *   GET /api/integracio/health
 *   GET /api/integracio/ots/ficha?codigo=AC015255/2026   (también ?no=)
 *   GET /api/integracio/ots/coste?codigo=…              (contrato ACTDrive acsales-client)
 *
 * Fuera de sesión de usuario (middleware salta /api/integracio).
 */
const otCapas = require("./ot-capas.cjs");

const TARIFA_MO = Number(process.env.RENTABILIDAD_TARIFA_MO || otCapas.TARIFA_MO || 21.5);
const COEF_DIRECTO = Number(process.env.PREVISION_COEF_MAT || 1.68);
const COEF_KRONOSPAN = Number(process.env.PREVISION_COEF_KRONOSPAN || 1.87);
const MARGEN_OBJ = Number(process.env.MARGEN_OBJETIVO_VENTA || 0.12);
const PCT_ESTRUCTURA_FALLBACK = 0.22;

function serviceKeyEsperada() {
  return String(process.env.INTEGRACIO_SERVICE_KEY || "").trim();
}

function extraerClave(req) {
  const hdr = req.get("x-service-key");
  if (hdr) return String(hdr).trim();
  const auth = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? String(m[1]).trim() : "";
}

function requiereServiceKey(req, res, next) {
  const esperada = serviceKeyEsperada();
  if (!esperada) {
    return res.status(503).json({
      ok: false,
      error: "Integración no configurada: falta INTEGRACIO_SERVICE_KEY en .env de ACSales",
      codigo: "integracio_no_configurada",
    });
  }
  const recibida = extraerClave(req);
  if (!recibida || recibida !== esperada) {
    return res.status(401).json({ ok: false, error: "Clave de servicio no válida", codigo: "service_key" });
  }
  next();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function codigoQuery(req) {
  return String(req.query.codigo || req.query.no || req.query.ot || req.params.codigo || "").trim();
}

function esCompraReal(lin) {
  const tipoDoc = String(lin.Document_Type || lin.documentType || "").trim().toLowerCase();
  if (tipoDoc === "quote") return false;
  if (tipoDoc === "order" || tipoDoc === "invoice") return true;
  const doc = String(lin.Document_No || lin.documentNo || "").trim().toUpperCase();
  if (doc.startsWith("PC")) return true;
  if (doc.startsWith("OC")) return false;
  return tipoDoc !== "quote";
}

function esItem(lin) {
  return String(lin.Type || lin.tipo || "").toLowerCase() === "item";
}

function esResource(lin) {
  return String(lin.Type || lin.tipo || "").toLowerCase() === "resource";
}

function claveArticulo(lin) {
  const cod = String(lin.No || lin.numero || "").trim().toUpperCase();
  if (cod) return cod;
  return String(lin.Description || lin.descripcion || "").trim().toLowerCase();
}

/** Cruce compra PC ↔ venta material (misma idea que compararMaterialOT del cliente). */
function cruceMaterial(ventaRaw, compraRaw) {
  const porClave = new Map();
  for (const lin of ventaRaw || []) {
    if (!esItem(lin)) continue;
    const clave = claveArticulo(lin);
    if (!clave) continue;
    if (!porClave.has(clave)) {
      porClave.set(clave, {
        codigo: String(lin.No || "").trim() || null,
        descripcion: String(lin.Description || ""),
        udsVendidas: 0,
        importeVenta: 0,
        udsCompradas: 0,
        costeCompra: 0,
      });
    }
    const it = porClave.get(clave);
    it.udsVendidas += num(lin.Quantity);
    it.importeVenta += num(lin.Line_Amount);
  }
  for (const lin of compraRaw || []) {
    if (!esCompraReal(lin)) continue;
    const clave = claveArticulo(lin);
    if (!clave) continue;
    if (!porClave.has(clave)) {
      porClave.set(clave, {
        codigo: String(lin.No || "").trim() || null,
        descripcion: String(lin.Description || ""),
        udsVendidas: 0,
        importeVenta: 0,
        udsCompradas: 0,
        costeCompra: 0,
      });
    }
    const it = porClave.get(clave);
    it.udsCompradas += num(lin.Quantity);
    it.costeCompra += num(lin.Line_Amount);
  }
  const items = [...porClave.values()].map((it) => {
    let estado = "ok";
    if (it.udsCompradas > 0 && it.udsVendidas === 0) estado = "falta_cobrar";
    else if (it.udsVendidas > 0 && it.udsCompradas === 0) estado = "sin_coste";
    else if (Math.abs(it.udsVendidas - it.udsCompradas) > 0.001) estado = "cantidad_distinta";
    return { ...it, estado };
  });
  const costeNoFacturado = items
    .filter((i) => i.estado === "falta_cobrar")
    .reduce((a, i) => a + i.costeCompra, 0);
  const ventaSinCoste = items
    .filter((i) => i.estado === "sin_coste")
    .reduce((a, i) => a + i.importeVenta, 0);
  return {
    items,
    coste_no_facturado: round2(costeNoFacturado),
    venta_sin_coste: round2(ventaSinCoste),
    n_falta_cobrar: items.filter((i) => i.estado === "falta_cobrar").length,
    n_sin_coste: items.filter((i) => i.estado === "sin_coste").length,
  };
}

function coefCliente(nombre) {
  return String(nombre || "").toUpperCase().includes("KRONOSPAN") ? COEF_KRONOSPAN : COEF_DIRECTO;
}

function ventaObjetivoLocal(costeDirecto, ratioPropia, pctGeneral, margen, coef) {
  const r = {
    coste_directo: costeDirecto > 0 ? round2(costeDirecto) : null,
    venta_objetivo: null,
    venta_coef: null,
    fiable: true,
    ratio_propia: Number(ratioPropia) || 0,
    ratio_general: Number(pctGeneral) || 0,
    margen: margen,
    coef,
    divisor: null,
    nota: "Cálculo ACSales (mismo criterio que DetalleOT). Dashboard puede sustituirlo por FinanceHub.",
  };
  if (!(costeDirecto > 0)) return r;
  r.venta_coef = round2(costeDirecto * coef);
  r.divisor = 1 - r.ratio_propia - r.ratio_general - margen;
  if (r.divisor > 0) r.venta_objetivo = round2(costeDirecto / r.divisor);
  else r.fiable = false;
  return r;
}

async function traerLineasBC(no, servicio, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }) {
  if (!obtenerTokenBC || !process.env.BC_TENANT_ID || !servicio) return [];
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const filtro = encodeURIComponent(`Shortcut_Dimension_2_Code eq '${String(no).replace(/'/g, "''")}'`);
    let url = `${base}/${encodeURIComponent(servicio)}?$filter=${filtro}`;
    const filas = [];
    while (url) {
      const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const pagina = await r.json();
      filas.push(...(pagina.value || []));
      url = pagina["@odata.nextLink"] || null;
    }
    return filas;
  } catch (e) {
    console.warn("[integracio/ot-ficha] BC líneas:", e.message);
    return [];
  }
}

async function traerMovsUso(no, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }) {
  if (!obtenerTokenBC || !process.env.BC_TENANT_ID) return { horas: 0, filas: [], servicio: null };
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    const candidatos = [
      process.env.BC_WS_MOVSPROYECTO,
      "Movs_proyecto_Excel",
      "Job_Ledger_Entries",
      "JobLedgerEntries",
    ].filter(Boolean);
    const noSafe = String(no).replace(/'/g, "''");
    const camposJob = ["Job_No", "No_proyecto", "JobNo"];
    let brutas = null;
    let servicio = null;
    for (const nombre of candidatos) {
      for (const campo of camposJob) {
        try {
          const url = `${raiz}/${encodeURIComponent(nombre)}?$filter=${encodeURIComponent(`${campo} eq '${noSafe}'`)}`;
          const filas = [];
          let next = url;
          while (next) {
            const r = await fetchConReintento(next, { headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) {
              if (r.status === 404) break;
              throw Object.assign(new Error(`BC ${r.status}`), { status: r.status });
            }
            const pagina = await r.json();
            filas.push(...(pagina.value || []));
            next = pagina["@odata.nextLink"] || null;
          }
          brutas = filas;
          servicio = nombre;
          break;
        } catch (e) {
          if (e.status === 404) break;
        }
      }
      if (brutas) break;
    }
    if (!brutas) return { horas: 0, filas: [], servicio: null };
    const filas = [];
    for (const f of brutas) {
      const tipo = String(f.Type || f.Tipo || "").trim();
      if (!/resour|recurs/i.test(tipo)) continue;
      const tipoMov = String(f.Entry_Type || f.Tipo_movimiento || f.EntryType || "").trim();
      if (!/^(usage|uso)$/i.test(tipoMov)) continue;
      filas.push({
        fecha: String(f.Posting_Date || f.Fecha_registro || "").slice(0, 10),
        documento: String(f.Document_No || f.No_documento || ""),
        recurso: String(f.No || f.No_ || ""),
        descripcion: String(f.Description || f.Descripcion || ""),
        tipoTrabajo: String(f.Work_Type_Code || f.Cod_tipo_trabajo || ""),
        cantidad: num(f.Quantity || f.Cantidad),
      });
    }
    const horas = round2(filas.reduce((a, f) => a + f.cantidad, 0));
    return { horas, filas, servicio };
  } catch (e) {
    console.warn("[integracio/ot-ficha] movs uso:", e.message);
    return { horas: 0, filas: [], servicio: null, error: String(e.message || e) };
  }
}

function resumenCapas(pack) {
  const sec = pack.secciones || {};
  const pick = (s, key) => {
    const b = (s && s[key]) || {};
    return {
      horas: round2(b.horas),
      qty: round2(b.qty),
      importe_coste: round2(b.importe_coste),
      importe_venta: round2(b.importe_venta),
      n_lineas: (b.lineas || []).length,
      na: !!b.na,
    };
  };
  const out = {};
  for (const nombre of ["horas", "material_obra", "material_taller"]) {
    const s = sec[nombre] || {};
    out[nombre] = {
      registrado_bc: pick(s, "registrado_bc"),
      pedido_venta: pick(s, "pedido_venta"),
      validado_app_no_bc: pick(s, "validado_app_no_bc"),
      no_validado_app: pick(s, "no_validado_app"),
    };
  }
  return {
    secciones: out,
    totales: pack.totales || null,
    taller_sobra: pack.taller_sobra || [],
    aviso_bc: pack.aviso_bc || null,
    tarifa_mo: pack.tarifa_mo || TARIFA_MO,
  };
}

module.exports = function montarIntegracioOtFicha({
  app,
  obtenerTokenBC,
  fetchConReintento,
  EMPRESA_NOMBRE,
  FUENTES_WS,
}) {
  const servicioVenta = (FUENTES_WS && FUENTES_WS.lineas_venta && FUENTES_WS.lineas_venta.servicio)
    || process.env.BC_WS_LINEASVENTA
    || "SalesInvLines";
  const servicioCompra = (FUENTES_WS && FUENTES_WS.lineas_compra && FUENTES_WS.lineas_compra.servicio)
    || process.env.BC_WS_LINEASCOMPRA
    || "PurchaseLines";

  app.get("/api/integracio/health", requiereServiceKey, (req, res) => {
    res.json({
      ok: true,
      service: "acsales",
      endpoints: [
        "GET /api/integracio/health",
        "GET /api/integracio/ots/ficha?codigo=",
        "GET /api/integracio/ots/coste?codigo=",
      ],
      ts: new Date().toISOString(),
    });
  });

  async function construirFicha(codigo) {
    const movs = await traerMovsUso(codigo, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE });
    const [ventaRaw, compraRaw] = await Promise.all([
      traerLineasBC(codigo, servicioVenta, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }),
      traerLineasBC(codigo, servicioCompra, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }),
    ]);

    // 1ª pasada ligera: resolver OT App (presupuesto?). 2ª: capas con flags correctos.
    let otRow = null;
    let pack = null;
    let empApp = null;
    let esPresupuesto = false;
    let presupuesto = "";
    try {
      const preview = await otCapas.obtenerPackCapas(codigo, {
        obtenerTokenBC,
        fetchConReintento,
        EMPRESA_NOMBRE,
        ventaRaw,
        esPresupuesto: false,
        movsUso: null,
      });
      otRow = preview.otRow;
      empApp = preview.empApp;
      pack = preview.pack;
      presupuesto = String(otRow?.codigoPTO || otRow?.presupuesto || "").trim();
      esPresupuesto = presupuesto !== "";
      if (esPresupuesto) {
        const full = await otCapas.obtenerPackCapas(codigo, {
          obtenerTokenBC,
          fetchConReintento,
          EMPRESA_NOMBRE,
          ventaRaw,
          esPresupuesto: true,
          movsUso: movs,
        });
        pack = full.pack;
        otRow = full.otRow || otRow;
        empApp = full.empApp || empApp;
      }
    } catch (e) {
      if (e.status === 404) throw e;
      console.warn("[integracio/ot-ficha] capas:", e.message);
    }

    const comprasReales = (compraRaw || []).filter(esCompraReal);
    const costeComprasPc = round2(comprasReales.reduce((a, l) => a + num(l.Line_Amount), 0));
    const ingresosVenta = round2((ventaRaw || []).reduce((a, l) => a + num(l.Line_Amount), 0));
    const horasVenta = round2(
      (ventaRaw || []).filter(esResource).reduce((a, l) => a + num(l.Quantity), 0)
    );
    const horas = esPresupuesto ? (movs.horas || 0) : horasVenta;
    const costeMo = round2(horas * TARIFA_MO);

    const cruce = cruceMaterial(ventaRaw, compraRaw);
    const costeMatApp = round2(
      (pack?.totales?.coste_material_obra || 0) + (pack?.totales?.coste_material_taller || 0)
    );
    // Coste material de referencia operativa: compras PC (como valoración presupuesto)
    const materialEur = costeComprasPc;
    const costeDirecto = round2(Math.max(0, materialEur - (cruce.coste_no_facturado || 0)) + costeMo);

    const cliente = String(otRow?.cliente || pack?.ot?.descr || "").trim(); // descr is OT desc; cliente may be missing
    const coef = coefCliente(cliente);
    const economico = {
      ingresos_venta_lineas: ingresosVenta,
      horas,
      horas_fuente: esPresupuesto ? "movs_proyecto" : "lineas_venta_resource",
      coste_mo: costeMo,
      tarifa_mo: TARIFA_MO,
      coste_compras_pc: costeComprasPc,
      coste_material_app: costeMatApp,
      coste_no_facturado: cruce.coste_no_facturado,
      coste_directo: costeDirecto,
      coef_venta_posible: coef,
      venta_posible: round2(costeDirecto * coef),
      venta_objetivo_acsales: ventaObjetivoLocal(
        costeDirecto,
        0,
        PCT_ESTRUCTURA_FALLBACK,
        MARGEN_OBJ,
        coef
      ),
      nota_venta_objetivo:
        "venta_objetivo_acsales usa fallback estructura 22% sin tasas UN. Preferir el endpoint FinanceHub/Dashboard cuando exista.",
    };

    const comprasLineas = comprasReales.map((l) => ({
      documento: String(l.Document_No || ""),
      codigo: String(l.No || ""),
      descripcion: String(l.Description || ""),
      cantidad: num(l.Quantity),
      importe: round2(num(l.Line_Amount)),
      coste_unitario: num(l.Direct_Unit_Cost),
      proveedor: String(l.Buy_from_Vendor_Name || ""),
      fecha: String(l.Order_Date || l.Posting_Date || l.Document_Date || "").slice(0, 10),
    }));

    return {
      ok: true,
      servicio: "acsales",
      contrato: "integracio/ots/ficha",
      version: 1,
      generado_en: new Date().toISOString(),
      codigo: codigo,
      meta: {
        codigo_bc: codigo,
        id_ot_app: otRow?.id || null,
        serie: otRow?.serie || null,
        codigo_corto: otRow?.codigo || null,
        ano: otRow?.ano || null,
        descripcion: otRow?.descr || null,
        segmento: otRow?.cCostPir || null,
        presupuesto: presupuesto || null,
        es_presupuesto: esPresupuesto,
        empresa_app: empApp,
        p_venta_app: otRow ? num(otRow.preuVenta) : null,
        p_despesa_app: otRow ? num(otRow.preuDespessa) : null,
        benefici_net_app: otRow ? num(otRow.beneficiNet) : null,
      },
      bc_lineas: {
        n_venta: (ventaRaw || []).length,
        n_compra: (compraRaw || []).length,
        n_compra_real_pc: comprasReales.length,
        servicio_venta: servicioVenta,
        servicio_compra: servicioCompra,
      },
      horas_uso: {
        horas: movs.horas,
        n_filas: (movs.filas || []).length,
        servicio: movs.servicio,
        error: movs.error || null,
        filas: movs.filas || [],
      },
      compras_pc: {
        total: costeComprasPc,
        n: comprasLineas.length,
        lineas: comprasLineas,
      },
      cruce_material: cruce,
      capas: pack ? resumenCapas(pack) : null,
      economico,
      coste: {
        // Compat ACTDrive mapCosteBody
        ot_codigo: codigo,
        horas,
        material_eur: materialEur,
        coste_mat: materialEur,
        materiales: materialEur,
        consultado_en: new Date().toISOString(),
      },
      fuentes: {
        app: "ALSOAPP dbo.ot + Parte_*",
        venta_bc: servicioVenta,
        compra_bc: servicioCompra,
        horas: esPresupuesto ? "Movs. proyecto Uso/Recurso" : "líneas venta Type=Resource",
        capas: "/api/ot/capas (misma lógica)",
      },
    };
  }

  app.get("/api/integracio/ots/ficha", requiereServiceKey, async (req, res) => {
    const codigo = codigoQuery(req);
    if (!codigo) {
      return res.status(400).json({ ok: false, error: "Falta codigo (ej. AC015255/2026)", codigo: "sin_codigo" });
    }
    try {
      const ficha = await construirFicha(codigo);
      res.json(ficha);
    } catch (err) {
      console.error("[integracio/ots/ficha]", err);
      const status = err.status || 500;
      res.status(status).json({
        ok: false,
        error: String(err.message || err),
        codigo: status === 404 ? "ot_no_encontrada" : "error",
        buscado: err.buscado,
      });
    }
  });

  /** Contrato ACTDrive: GET /api/integracio/ots/coste?codigo= */
  app.get("/api/integracio/ots/coste", requiereServiceKey, async (req, res) => {
    const codigo = codigoQuery(req);
    if (!codigo) {
      return res.status(400).json({ ok: false, error: "Falta codigo", codigo: "sin_codigo" });
    }
    try {
      const ficha = await construirFicha(codigo);
      res.json({
        ok: true,
        codigo: ficha.codigo,
        coste: ficha.coste,
        horas: ficha.coste.horas,
        material_eur: ficha.coste.material_eur,
        consultado_en: ficha.coste.consultado_en,
        es_presupuesto: ficha.meta.es_presupuesto,
        // extras útiles sin romper el cliente ACTDrive
        coste_mo: ficha.economico.coste_mo,
        coste_compras_pc: ficha.economico.coste_compras_pc,
        coste_no_facturado: ficha.economico.coste_no_facturado,
      });
    } catch (err) {
      console.error("[integracio/ots/coste]", err);
      const status = err.status || 500;
      res.status(status).json({
        ok: false,
        error: String(err.message || err),
        codigo: status === 404 ? "ot_no_encontrada" : "error",
      });
    }
  });
};

module.exports.requiereServiceKey = requiereServiceKey;
module.exports.serviceKeyEsperada = serviceKeyEsperada;
