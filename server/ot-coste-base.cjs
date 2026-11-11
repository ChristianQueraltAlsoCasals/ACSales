/**
 * Criterio v2 — costes base OT para Dashboard.
 *
 * Material oficial = App precioC (partes). Compras PC = control.
 * Sobra taller: pendiente (default) | se_cobra | devuelto
 *   Coste Confirmado = horas + obra + taller gastado + sobra se_cobra
 *   Coste Total      = Confirmado + sobra pendiente
 *
 * Fecha corte (env OT_CRITERIO_V2_FECHA_CORTE=YYYY-MM-DD):
 *   vacía → solo pendientes/en proceso (ninguna facturada)
 *   con fecha → + facturadas con fecha_factura >= corte
 *
 * Persistencia estados sobra: app_state clave taller_sobra:{codigoOT}
 */
const ESTADOS_SOBRA = new Set(["pendiente", "se_cobra", "devuelto"]);
const CLAVE_PREFIX = "taller_sobra:";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fechaCorteConfig() {
  const raw = String(process.env.OT_CRITERIO_V2_FECHA_CORTE || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function claveSobra(codigoOt) {
  return CLAVE_PREFIX + String(codigoOt || "").trim().toUpperCase();
}

async function leerEstadosSobra(db, codigoOt) {
  if (!db || typeof db.getDoc !== "function") return {};
  const doc = await db.getDoc(claveSobra(codigoOt), { articulos: {} });
  const art = doc && typeof doc.articulos === "object" ? doc.articulos : {};
  const out = {};
  for (const [k, v] of Object.entries(art)) {
    const estado = typeof v === "string" ? v : v && v.estado;
    if (ESTADOS_SOBRA.has(estado)) {
      out[String(k).trim().toUpperCase()] = {
        estado,
        confirmado_por: (v && v.confirmado_por) || null,
        confirmado_en: (v && v.confirmado_en) || null,
      };
    }
  }
  return out;
}

async function guardarEstadoSobra(db, codigoOt, articulo, estado, usuario) {
  if (!db || typeof db.getDoc !== "function" || typeof db.setDoc !== "function") {
    throw new Error("Base de datos no disponible para persistir sobra taller");
  }
  const art = String(articulo || "").trim().toUpperCase();
  if (!art) throw Object.assign(new Error("Falta articulo"), { status: 400 });
  if (!ESTADOS_SOBRA.has(estado)) {
    throw Object.assign(new Error("estado debe ser pendiente | se_cobra | devuelto"), { status: 400 });
  }
  const clave = claveSobra(codigoOt);
  const doc = await db.getDoc(clave, { articulos: {} });
  const articulos = doc && typeof doc.articulos === "object" ? { ...doc.articulos } : {};
  articulos[art] = {
    estado,
    confirmado_por: usuario || null,
    confirmado_en: new Date().toISOString(),
  };
  await db.setDoc(clave, { articulos, actualizado_en: new Date().toISOString() });
  return articulos[art];
}

/** Detecta facturación BC por líneas Invoice / Credit Memo. */
function detectarFacturacion(ventaRaw) {
  let fechaMin = null;
  let nFactura = 0;
  let importeFactura = 0;
  for (const l of ventaRaw || []) {
    const tipo = String(l.Document_Type ?? l.documentType ?? "").trim().toLowerCase();
    const esFact =
      tipo === "invoice" ||
      tipo === "factura" ||
      tipo === "2" ||
      tipo === "credit memo" ||
      tipo === "creditmemo" ||
      tipo === "3";
    if (!esFact) continue;
    nFactura += 1;
    importeFactura += num(l.Line_Amount);
    const f = String(l.Posting_Date || l.Document_Date || l.Order_Date || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
      if (!fechaMin || f < fechaMin) fechaMin = f;
    }
  }
  return {
    facturada: nFactura > 0,
    fecha_factura: fechaMin,
    n_lineas_factura: nFactura,
    importe_factura: round2(importeFactura),
  };
}

function aplicarCriterioV2({ facturada, fechaFactura, fechaCorte }) {
  if (!facturada) {
    return {
      aplica_criterio_v2: true,
      motivo_exclusion: null,
      estado_ot: "en_proceso_o_pendiente",
    };
  }
  if (!fechaCorte) {
    return {
      aplica_criterio_v2: false,
      motivo_exclusion: "facturada_sin_fecha_corte_config",
      estado_ot: "facturada",
    };
  }
  if (fechaFactura && fechaFactura >= fechaCorte) {
    return {
      aplica_criterio_v2: true,
      motivo_exclusion: null,
      estado_ot: "facturada",
    };
  }
  return {
    aplica_criterio_v2: false,
    motivo_exclusion: fechaFactura
      ? "facturada_anterior_a_fecha_corte"
      : "facturada_sin_fecha_factura_detectada",
    estado_ot: "facturada",
  };
}

/**
 * Construye coste_base v2 a partir del pack de capas + estados persistidos.
 * Horas admin: preferir App (pack.totales); si PR, movs/proyecto ya van en pack o horasOverride.
 */
function construirCosteBase({
  pack,
  estadosSobra = {},
  horasOverride = null,
  fuenteHoras = null,
  tarifaMo = 21.5,
}) {
  const tarifa = num(tarifaMo) || 21.5;
  const tot = pack?.totales || {};
  const horasCant =
    horasOverride != null && Number.isFinite(Number(horasOverride))
      ? num(horasOverride)
      : num(tot.horas);
  const costeMo = round2(horasCant * tarifa);
  const materialObra = round2(tot.coste_material_obra);
  const materialTallerGastado = round2(tot.coste_material_taller);

  const buckets = {
    pendiente: { importe: 0, n_lineas: 0 },
    se_cobra: { importe: 0, n_lineas: 0 },
    devuelto: { importe: 0, n_lineas: 0 },
  };
  const lineas = [];
  for (const r of pack?.taller_sobra || []) {
    const art = String(r.articulo || "").trim().toUpperCase();
    if (!art) continue;
    const guardado = estadosSobra[art];
    const estado = guardado?.estado && ESTADOS_SOBRA.has(guardado.estado)
      ? guardado.estado
      : "pendiente";
    const importe = round2(num(r.importe_coste));
    const precioC = num(r.precio_c);
    buckets[estado].importe = round2(buckets[estado].importe + importe);
    buckets[estado].n_lineas += 1;
    lineas.push({
      articulo: art,
      descripcion: r.descripcion || "",
      qty_preparada: num(r.qty_preparada),
      qty_gastada: num(r.qty_gastada),
      qty_sobra: num(r.qty_sobra),
      precio_c: precioC,
      importe,
      estado,
      confirmado_por: guardado?.confirmado_por || null,
      confirmado_en: guardado?.confirmado_en || null,
    });
  }

  const costeConfirmado = round2(
    costeMo + materialObra + materialTallerGastado + buckets.se_cobra.importe
  );
  const costeTotal = round2(costeConfirmado + buckets.pendiente.importe);

  return {
    tarifa_mo: tarifa,
    horas: {
      cantidad: round2(horasCant),
      fuente: fuenteHoras || (pack?.es_presupuesto ? "movs_proyecto" : "partes_app"),
      importe: costeMo,
    },
    material_obra: {
      importe: materialObra,
      fuente: "app_precioC",
      n_lineas: null,
    },
    material_taller_gastado: {
      importe: materialTallerGastado,
      fuente: "app_precioC",
      n_lineas: null,
    },
    taller_sobra: {
      pendiente: buckets.pendiente,
      se_cobra: buckets.se_cobra,
      devuelto: buckets.devuelto,
      lineas,
    },
    coste_confirmado: costeConfirmado,
    coste_total: costeTotal,
    formula: {
      confirmado: "horas + material_obra + material_taller_gastado + taller_sobra.se_cobra",
      total: "coste_confirmado + taller_sobra.pendiente",
    },
  };
}

function montarControlPc(comprasPcImporte, nLineas, alertas = []) {
  return {
    compras_pc: {
      importe: round2(comprasPcImporte),
      n_lineas: nLineas || 0,
      nota: "No entra en coste_base; solo alerta/auditoria",
    },
    alertas,
  };
}

module.exports = {
  ESTADOS_SOBRA,
  fechaCorteConfig,
  leerEstadosSobra,
  guardarEstadoSobra,
  detectarFacturacion,
  aplicarCriterioV2,
  construirCosteBase,
  montarControlPc,
  claveSobra,
};
