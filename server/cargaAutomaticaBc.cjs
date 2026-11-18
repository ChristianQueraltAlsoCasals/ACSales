/**
 * Carga automática de Business Central — refresco del día en curso.
 *
 * Cada hora pide a BC el tramo que falta hasta hoy (Europe/Madrid) de las
 * fuentes ya cargadas, y sustituye esas filas en Postgres. Si la caché
 * se quedó atrás varios días, recupera el hueco (hasta CARGA_AUTO_MAX_DIAS).
 *
 * Desactivar: CARGA_AUTO_OFF=1
 * Intervalo: CARGA_AUTO_MS (por defecto 3600000 = 1 h)
 * Fuentes: CARGA_AUTO_FUENTES (lista separada por comas; vacío = las de abajo)
 */

const CLAVE_META = "carga_automatica_bc";

const FUENTES_DEFECTO = [
  "pedidos_venta",
  "facturas_venta",
  "abonos_venta",
  "lineas_venta",
  "lineas_compra",
  "lineas_pedido_venta",
  "pedidos_compra",
  "lineas_venta_reg",
  "lineas_compra_reg",
  "movs_contabilidad",
  "movs_contabilidad_excel",
];

/** Máximo de días a recuperar por tick si la caché se quedó atrás. */
function maxDiasCatchUp() {
  const n = Number(process.env.CARGA_AUTO_MAX_DIAS ?? 31);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 90) : 31;
}

const CAMPOS_FECHA_FILA = [
  "orderDate",
  "invoiceDate",
  "creditMemoDate",
  "postingDate",
  "Posting_Date",
  "Order_Date",
  "Document_Date",
  "Shipment_Date",
  "Expected_Receipt_Date",
  "Planned_Shipment_Date",
  "Starting_Date",
  "Fecha_registro",
];

function fuentesEnv() {
  const crudo = String(process.env.CARGA_AUTO_FUENTES || "").trim();
  if (!crudo) return FUENTES_DEFECTO;
  return crudo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function intervaloMs() {
  const n = Number(process.env.CARGA_AUTO_MS ?? 3_600_000);
  return Number.isFinite(n) && n >= 60_000 ? n : 3_600_000;
}

function hoyMadrid() {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date()); // YYYY-MM-DD
}

function fechaFila(r) {
  for (const c of CAMPOS_FECHA_FILA) {
    const v = r?.[c];
    if (v == null || v === "") continue;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  return null;
}

function cubreHoy(cached, hoy) {
  return (cached || []).some((r) => r && r.from && r.to && r.from <= hoy && hoy <= r.to);
}

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ultimoToCache(cached) {
  return (cached || []).map((c) => c?.to).filter(Boolean).sort().pop() || null;
}

/**
 * Rango a pedir: siempre refresca hoy si ya está cubierto; si la caché
 * acaba antes de hoy, recupera desde el día siguiente (acotado).
 * Devuelve null si no hay nada que pedir.
 */
function rangoARefrescar(cached, hoy) {
  if (!cached?.length) return null;
  if (cubreHoy(cached, hoy)) return { from: hoy, to: hoy, motivo: "refresco-hoy" };
  const ultimoTo = ultimoToCache(cached);
  if (!ultimoTo) return null;
  if (ultimoTo >= hoy) return { from: hoy, to: hoy, motivo: "refresco-hoy" };
  let desde = addDaysISO(ultimoTo, 1);
  const minDesde = addDaysISO(hoy, -maxDiasCatchUp());
  if (desde < minDesde) desde = minDesde;
  if (desde > hoy) return null;
  return { from: desde, to: hoy, motivo: desde === hoy ? "refresco-hoy" : "catch-up" };
}

function ampliarCacheConRango(cached, from, to) {
  const lista = Array.isArray(cached) ? cached.map((c) => ({ ...c })) : [];
  if (!lista.length) return [{ from, to }];
  lista.push({ from, to });
  lista.sort((a, b) => (a.from < b.from ? -1 : 1));
  const out = [lista[0]];
  for (let i = 1; i < lista.length; i++) {
    const last = out[out.length - 1];
    const cur = lista[i];
    const next = addDaysISO(last.to, 1);
    if (cur.from <= next) {
      if (cur.to > last.to) last.to = cur.to;
    } else {
      out.push(cur);
    }
  }
  return out;
}

// Clave de una línea de documento BC (pedido, factura…). Varias líneas del
// mismo artículo se distinguen por el nº de línea; no se usa el código de artículo.
function claveFilaBc(r) {
  if (!r || typeof r !== "object") return null;
  const doc = r.Document_No ?? r.documentNo;
  const linea = r.Line_No ?? r.lineNo;
  if (doc != null && String(doc) !== "" && linea != null && String(linea) !== "") {
    const tipo = r.Document_Type ?? r.documentType ?? "";
    return `lin|${tipo}|${doc}|${linea}`;
  }
  if (r.id) return `id|${r.id}`;
  return null;
}

// La última lectura gana. Las filas sin clave (cabeceras, etc.) se conservan todas.
function dedupeFilasBc(filas) {
  const sinClave = [];
  const porClave = new Map();
  const orden = [];
  for (const r of filas || []) {
    const k = claveFilaBc(r);
    if (!k) {
      sinClave.push(r);
      continue;
    }
    if (!porClave.has(k)) orden.push(k);
    porClave.set(k, r);
  }
  return [...sinClave, ...orden.map((k) => porClave.get(k))];
}

function fusionarRango(rowsPrevias, filasNuevas, from, to) {
  // El refresco filtra por una fecha (p. ej. recepción prevista) y fechaFila
  // lee otra (p. ej. fecha del pedido). Si solo se quitan las filas cuya
  // primera fecha cae en el tramo, la línea antigua se queda Y se vuelve a
  // añadir: cada hora una copia más del mismo Document_No + Line_No.
  const previas = dedupeFilasBc(rowsPrevias);
  const nuevas = dedupeFilasBc(filasNuevas);
  const clavesNuevas = new Set();
  for (const r of nuevas) {
    const k = claveFilaBc(r);
    if (k) clavesNuevas.add(k);
  }
  const sinRango = previas.filter((r) => {
    const k = claveFilaBc(r);
    if (k && clavesNuevas.has(k)) return false;
    const f = fechaFila(r);
    return !f || f < from || f > to;
  });
  return [...sinRango, ...nuevas];
}

async function paginar(fetchConReintento, url, cabeceras) {
  const out = [];
  let next = url;
  while (next) {
    const rp = await fetchConReintento(next, cabeceras);
    if (!rp.ok) {
      const detalle = (await rp.text().catch(() => "")).slice(0, 300);
      return { error: { status: rp.status, detalle }, filas: out };
    }
    const pagina = await rp.json();
    out.push(...(pagina.value || []));
    next = pagina["@odata.nextLink"] || null;
  }
  return { filas: out };
}

/**
 * Carga un rango [from,to] de una fuente (API v2 o web service), sin pasar
 * por Express. Réplica reducida de /api/bc/:fuente.
 * Si no hay campo de fecha y permitirCargaCompleta, baja la tabla entera
 * (igual que la carga manual de Hist. líneas / movs).
 */
async function consultarFuente({
  fuente,
  from,
  to,
  token,
  fetchConReintento,
  EMPRESA_ID,
  EMPRESA_NOMBRE,
  FUENTES_BC,
  FUENTES_WS,
  permitirCargaCompleta = false,
}) {
  const cabeceras = { headers: { Authorization: `Bearer ${token}` } };
  const ws = FUENTES_WS[fuente];

  if (ws) {
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || "");
    const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
    // Env primero suele ser un alias corto (p.ej. "Maria") que existe pero
    // no filtra por fecha: lo dejamos para el final y priorizamos Hist_/Excel.
    const brutos = (ws.servicios || [ws.servicio]).filter(Boolean);
    const servicios = [...brutos].sort((a, b) => {
      const score = (n) => (/hist|excel|line|mov|ledger|invoice|purch|sales/i.test(n) ? 0 : 1);
      return score(a) - score(b);
    });
    let ultimoError = null;
    const candidatosFull = [];

    for (const servicio of servicios) {
      const base = `${raiz}/${encodeURIComponent(servicio)}`;
      let servicioExiste = false;
      for (const campoFecha of ws.camposFecha || []) {
        const filtro = `${campoFecha} ge ${from} and ${campoFecha} le ${to}`;
        const url = `${base}?$filter=${encodeURIComponent(filtro)}`;
        const r = await fetchConReintento(url, cabeceras);
        // 404: servicio no publicado → probar el siguiente de la lista
        if (r.status === 404) break;
        servicioExiste = true;
        if (r.status === 400) continue; // campo fecha inexistente
        if (!r.ok) {
          ultimoError = { status: r.status, detalle: (await r.text().catch(() => "")).slice(0, 200) };
          continue;
        }
        const filas = [];
        let pagina = await r.json();
        filas.push(...(pagina.value || []));
        if (pagina["@odata.nextLink"]) {
          const resto = await paginar(fetchConReintento, pagina["@odata.nextLink"], cabeceras);
          if (resto.error) {
            ultimoError = resto.error;
            break;
          }
          filas.push(...resto.filas);
        }
        return { data: filas, sinFecha: false, servicio, campoFecha };
      }
      if (servicioExiste) candidatosFull.push(servicio);
    }

    // Sin filtro de fecha (Hist. líneas, etc.): solo si vamos atrasados,
    // para no bajar 50k–300k filas cada hora.
    if (ws.permitirSinFecha && permitirCargaCompleta && candidatosFull.length) {
      for (const servicio of candidatosFull) {
        const base = `${raiz}/${encodeURIComponent(servicio)}`;
        const r = await paginar(fetchConReintento, base, cabeceras);
        if (r.error) {
          ultimoError = r.error;
          continue;
        }
        console.log(`[carga-auto] ${fuente}: carga completa «${servicio}» → ${r.filas.length} filas`);
        return { data: r.filas, sinFecha: true, servicio };
      }
    }
    if (ws.permitirSinFecha && !permitirCargaCompleta) {
      return { omitida: true, motivo: "sinFecha-al-dia" };
    }
    if (ws.permitirSinFecha) {
      return { omitida: true, motivo: "sinFecha" };
    }
    return { error: ultimoError || { status: 0, detalle: "Ningún servicio WS respondió" } };
  }

  const config = FUENTES_BC[fuente];
  if (!config) return { omitida: true, motivo: "desconocida" };

  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;
  const filtro = `${config.campoFecha} ge ${from} and ${config.campoFecha} le ${to}`;
  const url = `${base}/companies(${EMPRESA_ID()})/${config.entidad}?$filter=${encodeURIComponent(filtro)}`;
  const r = await paginar(fetchConReintento, url, cabeceras);
  if (r.error) return { error: r.error };
  return { data: r.filas, sinFecha: false, campoFecha: config.campoFecha };
}

async function refrescarEmpresa({
  empresa,
  hoy,
  fuentes,
  db,
  claveEmpresa,
  contextoEmpresa,
  obtenerTokenBC,
  fetchConReintento,
  FUENTES_BC,
  FUENTES_WS,
  EMPRESA_ID,
  EMPRESA_NOMBRE,
}) {
  const store = {
    id: empresa.id,
    nombre: empresa.nombre,
    porDefecto: !!empresa.porDefecto || empresa.id === process.env.BC_COMPANY_ID,
  };

  return contextoEmpresa.run(store, async () => {
    const pref = claveEmpresa("estado");
    const estado = await db.getEstado(pref);
    const bcData = estado.bcData || {};
    const token = await obtenerTokenBC();
    const tocadas = []; // [{ fuente, filasHoy }]
    const patchBc = {};

    for (const fuente of fuentes) {
      const actual = bcData[fuente];
      if (!actual || !(actual.rows || []).length) continue;
      const rango = rangoARefrescar(actual.cached, hoy);
      if (!rango) continue;
      // Carga completa solo si la caché no llega a hoy (evitar 50k–300k filas/hora).
      const permitirCargaCompleta = rango.motivo === "catch-up" || !cubreHoy(actual.cached, hoy);

      try {
        const r = await consultarFuente({
          fuente,
          from: rango.from,
          to: rango.to,
          token,
          fetchConReintento,
          EMPRESA_ID,
          EMPRESA_NOMBRE,
          FUENTES_BC,
          FUENTES_WS,
          permitirCargaCompleta,
        });
        if (r.omitida) {
          if (r.motivo !== "sinFecha-al-dia") {
            console.warn(`[carga-auto] ${empresa.nombre || empresa.id} · ${fuente}: omitida (${r.motivo})`);
          }
          continue;
        }
        if (r.error) {
          console.warn(`[carga-auto] ${empresa.nombre || empresa.id} · ${fuente}: BC ${r.error.status} ${r.error.detalle || ""}`);
          continue;
        }
        const rows = r.sinFecha
          ? (r.data || [])
          : fusionarRango(actual.rows, r.data || [], rango.from, rango.to);
        // Tras carga completa, el tramo queda cubierto hasta hoy.
        const cached = r.sinFecha
          ? ampliarCacheConRango(actual.cached, actual.cached?.[0]?.from || rango.from, hoy)
          : ampliarCacheConRango(actual.cached, rango.from, rango.to);
        patchBc[fuente] = {
          ...actual,
          rows,
          totalRows: rows.length,
          cached,
        };
        tocadas.push({
          fuente,
          filasHoy: (r.data || []).length,
          from: r.sinFecha ? (actual.cached?.[0]?.from || rango.from) : rango.from,
          to: hoy,
          motivo: r.sinFecha ? "full" : rango.motivo,
        });
      } catch (err) {
        console.warn(`[carga-auto] ${empresa.nombre || empresa.id} · ${fuente}:`, err.message || err);
      }
    }

    // Solo las fuentes tocadas: no reescribir el resto (evita pisar una
    // carga manual concurrente con una copia antigua del getEstado).
    if (tocadas.length) {
      await db.mergeEstado({ bcData: patchBc }, pref);
    }
    return tocadas;
  });
}

function programar({
  db,
  claveEmpresa,
  contextoEmpresa,
  empresasApp,
  obtenerTokenBC,
  fetchConReintento,
  FUENTES_BC,
  FUENTES_WS,
  EMPRESA_ID,
  EMPRESA_NOMBRE,
  EMPRESA_POR_DEFECTO,
}) {
  if (String(process.env.CARGA_AUTO_OFF || "").trim() === "1") {
    console.log("[carga-auto] Desactivada (CARGA_AUTO_OFF=1)");
    return;
  }

  const ms = intervaloMs();
  const fuentes = fuentesEnv();
  let enCurso = false;

  const tick = async () => {
    if (enCurso) return;
    enCurso = true;
    const hoy = hoyMadrid();
    const t0 = Date.now();
    try {
      let empresas = [];
      try {
        empresas = await empresasApp();
      } catch (err) {
        console.warn("[carga-auto] No se pudieron listar empresas:", err.message || err);
        const def = EMPRESA_POR_DEFECTO();
        if (def?.id) empresas = [{ ...def, porDefecto: true }];
      }
      if (!empresas.length) {
        const def = EMPRESA_POR_DEFECTO();
        if (def?.id) empresas = [{ ...def, porDefecto: true }];
      }

      const porEmpresa = [];
      for (const empresa of empresas) {
        const tocadas = await refrescarEmpresa({
          empresa,
          hoy,
          fuentes,
          db,
          claveEmpresa,
          contextoEmpresa,
          obtenerTokenBC,
          fetchConReintento,
          FUENTES_BC,
          FUENTES_WS,
          EMPRESA_ID,
          EMPRESA_NOMBRE,
        });
        if (tocadas.length) {
          porEmpresa.push({
            id: empresa.id,
            nombre: empresa.nombre,
            porDefecto: !!empresa.porDefecto || empresa.id === process.env.BC_COMPANY_ID,
            fuentes: tocadas.map((t) => t.fuente),
            detalle: tocadas,
          });
        }
      }

      await db.setDoc(CLAVE_META, {
        ultimo: new Date().toISOString(),
        dia: hoy,
        ms: Date.now() - t0,
        porEmpresa,
        intervaloMs: ms,
      });
      if (porEmpresa.length) {
        const txt = porEmpresa
          .map((e) => `${e.nombre}[${e.detalle.map((t) => `${t.fuente}:${t.filasHoy}`).join(", ")}]`)
          .join(" · ");
        console.log(`[carga-auto] ${hoy} · ${Date.now() - t0} ms · ${txt}`);
      }
    } catch (err) {
      console.error("[carga-auto]", err.message || err);
    } finally {
      enCurso = false;
    }
  };

  // Primera pasada a los ~20 s (dejar que el servidor acabe de arrancar).
  setTimeout(tick, 20_000);
  setInterval(tick, ms);
  console.log(`[carga-auto] Cada ${Math.round(ms / 1000)} s · día en curso (Europe/Madrid) · fuentes: ${fuentes.join(", ")}`);
}

module.exports = { programar, hoyMadrid, fusionarRango, cubreHoy, rangoARefrescar };
