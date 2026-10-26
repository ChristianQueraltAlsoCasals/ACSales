/**
 * Capas de coste OT: App (ALSOAPP) ↔ Business Central.
 *
 * Secciones: horas · material obra · material taller (parte recogida Preparat).
 * Estados por sección: registrado_bc · validado_app_no_bc · no_validado_app
 *
 * Taller: preparado = parte esMaterial=1 + tipoStock=1;
 *         gastado = mismo artículo en parte de trabajo;
 *         facturable = gastado (capado por preparado); sobra = preparado − gastado.
 *
 *   GET /api/ot/capas?no=AC015317/2026
 *   GET /api/ot/capas/:no   (Dashboard)
 */
const { erpConfigurado, getPool, sql, esErrorConectividadErp } = require("./erp-db");

const TARIFA_MO = Number(process.env.RENTABILIDAD_TARIFA_MO || 21.5);
const RE_PARTE_BC = /n[ºo]\.?\s*parte de trabajo[:\s]+(\S+)\s+ot[:\s]+(\S+)/i;

function empresaAppDesdeBC(nombreEmpresa) {
  const n = String(nombreEmpresa || "").toUpperCase();
  if (/FERROS|FCA/.test(n)) return "0002";
  return process.env.ERP_EMPRESA_DEFECTE || "0001";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function capaVacia() {
  return {
    registrado_bc: { horas: 0, qty: 0, importe_coste: 0, importe_venta: 0, lineas: [] },
    validado_app_no_bc: { horas: 0, qty: 0, importe_coste: 0, importe_venta: 0, lineas: [] },
    no_validado_app: { horas: 0, qty: 0, importe_coste: 0, importe_venta: 0, lineas: [] },
  };
}

function pushLinea(capa, estado, lin) {
  const b = capa[estado];
  if (!b) return;
  b.lineas.push(lin);
  b.horas += num(lin.horas);
  b.qty += num(lin.qty);
  b.importe_coste += num(lin.importe_coste);
  b.importe_venta += num(lin.importe_venta);
}

function normalizarParte(codigo) {
  const t = String(codigo || "").trim();
  if (!t) return "";
  const m = t.match(/^(\d+)/);
  if (m) return String(parseInt(m[1], 10));
  return t.toLowerCase();
}

function normalizarArticulo(codigo) {
  return String(codigo || "").trim().toUpperCase();
}

/** Parsea AC015317/2026 → { serie, codigo, codigoPad, ano2, ano4 } */
function parseCodigoOT(no) {
  const s = String(no || "").trim().toUpperCase();
  const m = s.match(/^([A-Z]{2,4})?\s*0*(\d{3,6})\s*\/?\s*(20)?(\d{2})?/);
  if (!m) {
    const dig = s.replace(/\D/g, "");
    return dig
      ? { serie: "AC", codigo: String(parseInt(dig, 10)), codigoPad: String(parseInt(dig, 10)).padStart(6, "0"), ano2: null, ano4: null }
      : null;
  }
  const codigo = String(parseInt(m[2], 10));
  const ano2 = m[4] || null;
  return {
    serie: m[1] || "AC",
    codigo,
    codigoPad: codigo.padStart(6, "0"),
    ano2,
    ano4: ano2 ? `20${ano2}` : null,
  };
}

/** Números de parte presentes en líneas de venta BC (cabeceras «Nº parte de trabajo»). */
function partesEnVentaBC(ventaRaw) {
  const set = new Set();
  for (const l of ventaRaw || []) {
    const desc = String(l.Description || l.descripcion || l["Descripción"] || "");
    const m = desc.match(RE_PARTE_BC);
    if (m) set.add(normalizarParte(m[1]));
  }
  return set;
}

function esResource(l) {
  return String(l.Type || l.tipo || "").toLowerCase() === "resource";
}

function esItem(l) {
  return String(l.Type || l.tipo || "").toLowerCase() === "item";
}

/**
 * Importe venta BC por nº de parte (suma Line_Amount de líneas del bloque).
 * No es perfecto si hay varios docs; sirve de referencia.
 */
function ventaPorParteBC(ventaRaw) {
  const porParte = new Map();
  let actual = null;
  for (const l of ventaRaw || []) {
    const desc = String(l.Description || l.descripcion || "");
    const m = desc.match(RE_PARTE_BC);
    if (m) {
      actual = normalizarParte(m[1]);
      if (!porParte.has(actual)) porParte.set(actual, { horas: 0, importe: 0, items: [] });
      continue;
    }
    if (!actual) continue;
    const bucket = porParte.get(actual);
    if (!bucket) continue;
    const qty = num(l.Quantity ?? l.cantidad);
    const importe = num(l.Line_Amount ?? l.importe);
    if (esResource(l)) {
      bucket.horas += qty;
      bucket.importe += importe;
    } else if (esItem(l)) {
      bucket.items.push({
        articulo: normalizarArticulo(l.No || l.numero || ""),
        qty,
        importe,
      });
      bucket.importe += importe;
    }
  }
  return porParte;
}

async function resolverIdOT(pool, { serie, codigo, codigoPad, ano2 }, empresa) {
  // Solo match exacto de código (15207 ó 015207). NUNCA quitar ceros del
  // medio/final: REPLACE(...,'0','') hacía que AC015207 coincidiera con
  // otras OTs (p.ej. id 41883 en vez de 41749) y las capas salían a 0.
  const req = pool.request();
  req.input("emp", sql.VarChar(10), empresa);
  req.input("serie", sql.VarChar(10), serie);
  req.input("cod", sql.VarChar(20), codigo);
  req.input("codPad", sql.VarChar(20), codigoPad);
  let q = `
    SELECT TOP 5 id, serie, codigo, ano, descr, empresa
    FROM dbo.ot
    WHERE empresa = @emp
      AND UPPER(LTRIM(RTRIM(CAST(serie AS VARCHAR(10))))) = @serie
      AND (
        LTRIM(RTRIM(CAST(codigo AS VARCHAR(20)))) = @cod
        OR LTRIM(RTRIM(CAST(codigo AS VARCHAR(20)))) = @codPad
        OR RIGHT('000000' + LTRIM(RTRIM(CAST(codigo AS VARCHAR(20)))), 6) = @codPad
      )`;
  if (ano2) {
    req.input("ano2", sql.VarChar(4), ano2);
    req.input("ano4", sql.VarChar(4), `20${ano2}`);
    q += ` AND (LTRIM(RTRIM(CAST(ano AS VARCHAR(10)))) = @ano2 OR LTRIM(RTRIM(CAST(ano AS VARCHAR(10)))) = @ano4)`;
  }
  // Preferir el código ya padded (015207) si hay varias filas del mismo año
  q += `
    ORDER BY
      CASE WHEN LTRIM(RTRIM(CAST(codigo AS VARCHAR(20)))) = @codPad THEN 0
           WHEN LTRIM(RTRIM(CAST(codigo AS VARCHAR(20)))) = @cod THEN 1
           ELSE 2 END,
      id DESC`;
  const { recordset } = await req.query(q);
  return recordset || [];
}

async function leerPartesApp(idOT) {
  const pool = await getPool();
  const req = pool.request();
  req.input("idOT", sql.Int, idOT);

  const partes = await req.query(`
    SELECT p.id, p.codigoParte, p.ano, p.date_created, p.validated, p.rebutjat,
           p.endParte, p.esMaterial, p.tipoStock, p.treballador
    FROM dbo.Parte p
    WHERE p.idOT = @idOT
      AND ISNULL(TRY_CAST(p.rebutjat AS INT), 0) <> 1
    ORDER BY p.date_created, p.id
  `);

  const horas = await pool.request().input("idOT", sql.Int, idOT).query(`
    SELECT p.id AS idParte, p.codigoParte, p.validated, p.esMaterial, p.tipoStock,
           pt.id AS idLin, pt.codi, pt.treballador,
           TRY_CAST(pt.Total AS FLOAT) AS horas,
           TRY_CAST(pt.precioC AS FLOAT) AS precioC,
           TRY_CAST(pt.precioV AS FLOAT) AS precioV
    FROM dbo.Parte p
    JOIN dbo.Parte_Treballadors pt ON pt.idParte = p.id
    WHERE p.idOT = @idOT
      AND ISNULL(TRY_CAST(p.rebutjat AS INT), 0) <> 1
      AND (p.esMaterial = 0 OR p.esMaterial IS NULL)
  `);

  const arts = await pool.request().input("idOT", sql.Int, idOT).query(`
    SELECT p.id AS idParte, p.codigoParte, p.validated, p.esMaterial, p.tipoStock,
           pa.id AS idLin, pa.codi, pa.article, pa.unitat,
           TRY_CAST(pa.qty AS FLOAT) AS qty,
           TRY_CAST(pa.precioC AS FLOAT) AS precioC,
           TRY_CAST(pa.precioV AS FLOAT) AS precioV
    FROM dbo.Parte p
    JOIN dbo.Parte_Articles pa ON pa.idParte = p.id
    WHERE p.idOT = @idOT
      AND ISNULL(TRY_CAST(p.rebutjat AS INT), 0) <> 1
  `);

  return {
    partes: partes.recordset || [],
    horas: horas.recordset || [],
    articulos: arts.recordset || [],
  };
}

function estadoAppLinea(validated, parteEnBC) {
  if (parteEnBC) return "registrado_bc";
  if (Number(validated) === 1) return "validado_app_no_bc";
  return "no_validado_app";
}

function construirCapas({ otMeta, app, ventaRaw }) {
  const partesBC = partesEnVentaBC(ventaRaw);
  const ventaPorParte = ventaPorParteBC(ventaRaw);

  const horas = capaVacia();
  const materialObra = capaVacia();
  const materialTaller = capaVacia();

  // —— Horas (solo partes de trabajo) ——
  for (const h of app.horas || []) {
    const codP = normalizarParte(h.codigoParte);
    const enBC = partesBC.has(codP);
    const estado = estadoAppLinea(h.validated, enBC);
    const horasN = num(h.horas);
    const coste = horasN * TARIFA_MO;
    const vParte = ventaPorParte.get(codP);
    const venta = enBC && vParte && vParte.horas > 0
      ? (horasN / vParte.horas) * vParte.importe
      : 0;
    pushLinea(horas, estado, {
      id_parte: h.idParte,
      codigo_parte: h.codigoParte,
      trabajador: h.treballador,
      codi: h.codi,
      horas: horasN,
      qty: 0,
      importe_coste: coste,
      importe_venta: venta,
      validated: Number(h.validated) === 1,
      origen: "parte_trabajo",
    });
  }

  // —— Material taller: preparado (recogida) vs gastado (faena) ——
  const preparado = new Map(); // articulo → { qty, lineas recogida }
  for (const a of app.articulos || []) {
    if (!(Number(a.esMaterial) === 1 && Number(a.tipoStock) === 1)) continue;
    const art = normalizarArticulo(a.codi);
    if (!art) continue;
    const prev = preparado.get(art) || { qty: 0, lineas: [], desc: a.article };
    prev.qty += num(a.qty);
    prev.lineas.push(a);
    prev.desc = a.article || prev.desc;
    preparado.set(art, prev);
  }

  const gastadoFaena = new Map(); // articulo → { qty, coste, lineas, validated_any, partes }
  for (const a of app.articulos || []) {
    const esFaena = a.esMaterial == null || Number(a.esMaterial) === 0;
    if (!esFaena) continue;
    const art = normalizarArticulo(a.codi);
    if (!art) continue;
    const qty = num(a.qty);
    const coste = qty * num(a.precioC);
    const prev = gastadoFaena.get(art) || {
      qty: 0, coste: 0, lineas: [], validated_any: false, partes: new Set(),
    };
    prev.qty += qty;
    prev.coste += coste;
    prev.lineas.push(a);
    if (Number(a.validated) === 1) prev.validated_any = true;
    prev.partes.add(normalizarParte(a.codigoParte));
    gastadoFaena.set(art, prev);
  }

  const sobraTaller = [];
  const artsTaller = new Set([...preparado.keys()]);

  for (const art of artsTaller) {
    const prep = preparado.get(art);
    const gast = gastadoFaena.get(art) || { qty: 0, coste: 0, lineas: [], validated_any: false, partes: new Set() };
    const qtyFact = Math.min(prep.qty, gast.qty);
    const sobra = Math.max(0, prep.qty - gast.qty);
    const unitCost = gast.qty > 0 ? gast.coste / gast.qty : 0;
    const costeFact = qtyFact * unitCost;

    // Estado: si algún parte de faena que gastó está en BC → registrado; si no, validado o no
    let enBC = false;
    for (const p of gast.partes) if (partesBC.has(p)) enBC = true;
    const estado = qtyFact <= 0
      ? null
      : estadoAppLinea(gast.validated_any ? 1 : 0, enBC);

    if (estado && qtyFact > 0) {
      pushLinea(materialTaller, estado, {
        articulo: art,
        descripcion: prep.desc,
        qty: qtyFact,
        horas: 0,
        importe_coste: costeFact,
        importe_venta: 0,
        preparado: prep.qty,
        gastado: gast.qty,
        sobra,
        origen: "taller_merge",
        partes_faena: [...gast.partes],
        partes_recogida: prep.lineas.map((l) => l.codigoParte),
      });
    }
    if (sobra > 0) {
      sobraTaller.push({
        articulo: art,
        descripcion: prep.desc,
        qty_preparada: prep.qty,
        qty_gastada: gast.qty,
        qty_sobra: sobra,
        importe_coste: 0,
        nota: "Preparado taller no gastado en parte de trabajo — no facturar",
      });
    }
  }

  // —— Material obra: faena que NO es artículo de taller preparado ——
  for (const a of app.articulos || []) {
    const esFaena = a.esMaterial == null || Number(a.esMaterial) === 0;
    if (!esFaena) continue;
    const art = normalizarArticulo(a.codi);
    if (!art) continue;
    if (artsTaller.has(art)) continue; // ya contado en taller (merge)

    const codP = normalizarParte(a.codigoParte);
    const enBC = partesBC.has(codP);
    const estado = estadoAppLinea(a.validated, enBC);
    const qty = num(a.qty);
    const coste = qty * num(a.precioC);
    pushLinea(materialObra, estado, {
      id_parte: a.idParte,
      codigo_parte: a.codigoParte,
      articulo: art,
      descripcion: a.article,
      qty,
      horas: 0,
      importe_coste: coste,
      importe_venta: 0,
      validated: Number(a.validated) === 1,
      origen: "parte_trabajo",
    });
  }

  const sumCapas = (c) =>
    c.registrado_bc.importe_coste + c.validado_app_no_bc.importe_coste + c.no_validado_app.importe_coste;
  const sumHoras = (c) =>
    c.registrado_bc.horas + c.validado_app_no_bc.horas + c.no_validado_app.horas;

  // Detalle crudo App (para Excel de cruce): todas las líneas faena y taller
  const detalle_faena = [];
  for (const a of app.articulos || []) {
    const esFaena = a.esMaterial == null || Number(a.esMaterial) === 0;
    if (!esFaena) continue;
    const art = normalizarArticulo(a.codi);
    if (!art) continue;
    detalle_faena.push({
      parte: a.codigoParte,
      articulo: art,
      descripcion: a.article,
      qty: num(a.qty),
      precio_c: num(a.precioC),
      importe_coste: num(a.qty) * num(a.precioC),
      validated: Number(a.validated) === 1,
      tambien_en_taller_prep: artsTaller.has(art),
    });
  }
  const detalle_taller_prep = [];
  for (const a of app.articulos || []) {
    if (!(Number(a.esMaterial) === 1 && Number(a.tipoStock) === 1)) continue;
    const art = normalizarArticulo(a.codi);
    if (!art) continue;
    const gast = gastadoFaena.get(art);
    detalle_taller_prep.push({
      parte: a.codigoParte,
      articulo: art,
      descripcion: a.article,
      qty_preparada: num(a.qty),
      qty_gastada_faena: gast ? gast.qty : 0,
      precio_c: num(a.precioC),
      validated: Number(a.validated) === 1,
    });
  }

  return {
    ot: otMeta,
    tarifa_mo: TARIFA_MO,
    partes_bc_detectados: [...partesBC],
    secciones: {
      horas,
      material_obra: materialObra,
      material_taller: materialTaller,
    },
    taller_sobra: sobraTaller,
    detalle_app: {
      faena: detalle_faena,
      taller_prep: detalle_taller_prep,
    },
    totales: {
      horas: sumHoras(horas),
      coste_mo: sumHoras(horas) * TARIFA_MO,
      coste_material_obra: sumCapas(materialObra),
      coste_material_taller: sumCapas(materialTaller),
      coste_directo:
        sumHoras(horas) * TARIFA_MO + sumCapas(materialObra) + sumCapas(materialTaller),
    },
    generado_en: new Date().toISOString(),
  };
}

async function traerVentaBC(no, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }) {
  if (!obtenerTokenBC || !process.env.BC_TENANT_ID) return [];
  try {
    const token = await obtenerTokenBC();
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    // Reutilizar nombres típicos del server (pueden fallar: devolvemos [])
    const candidatos = [
      process.env.BC_WS_LINEAS_VENTA,
      "Sales_Order_Line_Excel",
      "salesOrderLines",
    ].filter(Boolean);
    const filtro = encodeURIComponent(`Shortcut_Dimension_2_Code eq '${String(no).replace(/'/g, "''")}'`);
    for (const servicio of candidatos) {
      try {
        let url = `${base}/${encodeURIComponent(servicio)}?$filter=${filtro}`;
        const filas = [];
        while (url) {
          const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) break;
          const pagina = await r.json();
          filas.push(...(pagina.value || []));
          url = pagina["@odata.nextLink"] || null;
        }
        if (filas.length) return filas;
      } catch { /* siguiente servicio */ }
    }
  } catch (e) {
    console.warn("[ot-capas] venta BC:", e.message);
  }
  return [];
}

module.exports = function montarOtCapas({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE }) {
  async function handler(req, res) {
    const no = String(req.params.no || req.query.no || "").trim();
    if (!no) return res.status(400).json({ error: "Falta no (ej. AC015317/2026)" });

    if (!erpConfigurado()) {
      return res.status(503).json({
        error: "ALSOAPP (ERP_MSSQL_*) no configurado. Revisa .env y Tailscale.",
      });
    }

    const parsed = parseCodigoOT(no);
    if (!parsed) return res.status(400).json({ error: `No se pudo interpretar el código OT: ${no}` });

    const empApp = empresaAppDesdeBC(EMPRESA_NOMBRE ? EMPRESA_NOMBRE() : "");
    try {
      const pool = await getPool();
      const ots = await resolverIdOT(pool, parsed, empApp);
      if (!ots.length) {
        return res.status(404).json({
          error: `OT no encontrada en ALSOAPP (${empApp})`,
          buscado: parsed,
        });
      }
      const otRow = ots[0];
      const appData = await leerPartesApp(otRow.id);

      let ventaRaw = [];
      if (req.body && Array.isArray(req.body.venta)) {
        ventaRaw = req.body.venta;
      } else {
        ventaRaw = await traerVentaBC(no, { obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE });
      }

      const pack = construirCapas({
        otMeta: {
          codigo_bc: no,
          id_ot: otRow.id,
          serie: otRow.serie,
          codigo: otRow.codigo,
          ano: otRow.ano,
          descr: otRow.descr,
          empresa_app: empApp,
        },
        app: appData,
        ventaRaw,
      });
      pack.aviso_bc = ventaRaw.length
        ? null
        : "Sin líneas de venta BC en la respuesta (o servicio no disponible). Capas App igual; cruce BC vacío.";
      pack.n_lineas_venta_bc = ventaRaw.length;
      res.json(pack);
    } catch (err) {
      console.error("[ot-capas]", err);
      const msg = esErrorConectividadErp(err)
        ? "No se pudo conectar a ALSOAPP (¿Tailscale?)."
        : String(err.message || err);
      res.status(502).json({ error: msg });
    }
  }

  app.get("/api/ot/capas", handler);
  app.get("/api/ot/capas/:no", (req, res, next) => {
    req.query.no = decodeURIComponent(req.params.no || "");
    return handler(req, res, next);
  });
  // POST: el cliente puede mandar { venta: ventaRaw } ya cargada desde BC
  app.post("/api/ot/capas", handler);
  app.post("/api/ot/capas/:no", (req, res, next) => {
    req.query.no = decodeURIComponent(req.params.no || "");
    return handler(req, res, next);
  });
};

module.exports._test = {
  parseCodigoOT,
  normalizarParte,
  construirCapas,
  partesEnVentaBC,
  TARIFA_MO,
};
