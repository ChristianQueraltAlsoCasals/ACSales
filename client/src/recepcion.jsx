/**
 * recepcion.jsx — Pantalla de RECEPCIÓN portada del Agente de Compras (5005).
 *
 * Muestra los pedidos con material PENDIENTE DE RECIBIR, cruzando las
 * CABECERAS de pedido (dataset "pedidos" = pedidos_compra de BC) con sus
 * LÍNEAS (dataset "solicitudes" = lineas_compra de BC) por Nº de documento.
 *
 * La lógica (getRecepData, precioNetoFila, recepMapFor, prioridades,
 * alertas, KPIs) es IDÉNTICA a la del traspaso (Anexo A) — solo adaptada
 * a React y a las columnas de BC ya renombradas en este proyecto.
 *
 * Datos: se alimentan de lo que ya carga «Cargar datos» (bcData), más un
 * botón propio «Actualizar desde BC» que refresca líneas y cabeceras.
 *
 * Marcas de revisado y fechas editadas: COMPARTIDAS entre equipos, vía
 * el backend (/api/recepcion), no en el navegador.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { RefreshCw, Search, CheckCircle2, Mail, X, Upload } from "lucide-react";

// --- utilidades de formato (es-ES) ---
const parseNum = (v) => {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/\s|€/g, "");
  // formato español: 1.234,56 → 1234.56
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
};
const fmtEur = (n) =>
  isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const parseFecha = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
};
const selloHora = (iso) =>
  new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

// --- detección tolerante de columnas de pedidos (Anexo A.3) ---
function recepMapFor(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (res) => {
    for (const re of res) {
      const i = lower.findIndex((h) => re.test(h));
      if (i >= 0) return headers[i];
    }
    return "";
  };
  return {
    // Se reconocen nombres en ESPAÑOL (tras mapeo) e INGLÉS (crudo de BC).
    numero: find([/^no$/, /^document_no$/, /^nº$/, /^n[º°o]\.?$/, /n[º°] pedido/, /pedido/]) || headers[0],
    fecha: find([/^order_date$/, /fecha registro/, /fecha emisi/, /^fecha$/, /fecha/]),
    fechaRecepPrev: find([/^posting_date$/, /fecha recepci[oó]n prevista/, /recepci[oó]n prevista/]),
    proveedor: find([/^buy_from_vendor_name$/, /^pay_to_name$/, /compra a-nombre/, /nombre.*proveedor/, /prove(?!.*autoriz)/]),
    esperar: find([/^on_hold$/, /^esperar$/, /esperar/]),
    departamento: find([/^shortcut_dimension_1_code$/, /departamento/, /unidad de negocio/]),
    ot: find([/^shortcut_dimension_2_code$/, /c[oó]d\.? ot/, /\bot\b/]),
    comprador: find([/^cdcpurchasercode$/, /^purchaser_code$/, /c[oó]d\.? comprador/, /comprador/]),
    alianza: find([/^compra_con_alianza$/, /compra con alianza/, /alianza/]),
    estado: find([/^status$/, /^estado$/]),
  };
}

// --- precio neto de una línea (Anexo A.2) ---
function precioNetoFila(r, cols) {
  // 1º: "Coste unitario" de BC (ya neto)
  if (cols.costeUnit) {
    const cu = parseNum(r[cols.costeUnit]);
    if (!isNaN(cu) && cu > 0) return cu;
  }
  // 2º: desde el directo y los 3 descuentos en cascada
  let base = parseNum(r[cols.directo]);
  if (isNaN(base) || base <= 0) return NaN;
  [cols.d1, cols.d2, cols.d3].forEach((c) => {
    if (!c) return;
    const d = parseNum(r[c]);
    if (!isNaN(d) && d > 0) base = base * (1 - d / 100);
  });
  return base;
}

function colsLineas(headers) {
  const low = headers.map((h) => h.toLowerCase());
  const H = (re) => headers[low.findIndex((h) => re.test(h))] || "";
  return {
    // Español (tras mapeo) e inglés (crudo de BC).
    doc: H(/^document_no$/) || H(/n[º°o]?\.?\s*documento/),
    importe: H(/^line_amount$/) || H(/importe l[ií]nea/),
    pend: H(/^outstanding_quantity$/) || H(/cantidad pendiente/),
    ot: H(/^shortcut_dimension_2_code$/) || H(/c[oó]d\.?\s*ot/),
    un: H(/^shortcut_dimension_1_code$/) || H(/unidad de negocio|departamento/),
    costeUnit: H(/^unit_cost$/) || H(/^coste unitario$/),
    directo: H(/^direct_unit_cost$/) || H(/coste unit\.? directo/),
    d1: H(/^percent_dto_linea_1$/) || H(/%\s*dto\.?\s*1/),
    d2: H(/^percent_dto_linea_2$/) || H(/%\s*dto\.?\s*2/),
    d3: H(/^percent_dto_linea_3$/) || H(/%\s*dto\.?\s*3/),
  };
}

// --- EL NÚCLEO: cruce pedidos↔líneas (Anexo A.4) ---
function getRecepData(pedidos, lineas, recepFechas) {
  if (!pedidos?.headers?.length) return null;
  const m = recepMapFor(pedidos.headers);
  const hoy = new Date();
  const pendientes = [], excluidos = [];

  // Índice de líneas por nº de pedido
  const idxLineas = {};
  if (lineas?.headers?.length) {
    const lc = colsLineas(lineas.headers);
    if (lc.doc) {
      lineas.rows.forEach((r) => {
        const pc = String(r[lc.doc] || "").trim().toUpperCase();
        if (!pc) return;
        if (!idxLineas[pc]) idxLineas[pc] = { importe: 0, pendiente: 0, ot: "", un: "" };
        const o = idxLineas[pc];
        const impL = parseNum(r[lc.importe]);
        if (!isNaN(impL)) o.importe += impL;
        const qPend = lc.pend ? parseNum(r[lc.pend]) : NaN;
        if (!isNaN(qPend) && qPend > 0) {
          const neto = precioNetoFila(r, lc);
          if (!isNaN(neto)) o.pendiente += qPend * neto;
        }
        if (!o.ot && lc.ot) { const v = String(r[lc.ot] || "").trim(); if (v) o.ot = v; }
        if (!o.un && lc.un) { const v = String(r[lc.un] || "").trim(); if (v) o.un = v; }
      });
    }
  }

  pedidos.rows.forEach((r) => {
    const num = String(r[m.numero] || "").trim();
    const calc = idxLineas[num.toUpperCase()] || { importe: 0, pendiente: 0, ot: "", un: "" };
    const imp = calc.importe;
    const impPend = calc.pendiente;
    const ot = (String(r[m.ot] || "").trim()) || calc.ot;
    const un = (m.departamento ? String(r[m.departamento] || "").trim() : "") || calc.un;
    const esperar = m.esperar ? String(r[m.esperar] || "").trim() : "";
    const fStr = String(r[m.fecha] || "").trim();
    const f = parseFecha(fStr);
    const dias = f ? Math.floor((hoy - f) / 86400000) : null;
    const tipoDoc = /^oc/i.test(num) ? "Oferta" : /^pc/i.test(num) ? "Pedido" : "";
    const alianzaRaw = m.alianza ? r[m.alianza] : "";
    const alianza = alianzaRaw === true || /^(s[ií]|true|1|verdadero)$/i.test(String(alianzaRaw).trim());
    const item = {
      num, tipoDoc, fecha: fStr, dias, imp, impPend, esperar,
      recepPrev: (recepFechas && recepFechas[num]) || (m.fechaRecepPrev ? String(r[m.fechaRecepPrev] || "").trim() : ""),
      prov: String(r[m.proveedor] || "").trim(),
      depto: un, ot,
      comprador: m.comprador ? String(r[m.comprador] || "").trim() : "",
      alianza,
    };
    if (esperar) { excluidos.push(item); return; }
    item.prioridad = dias === null ? "Normal" : dias > 60 ? "Urgente" : dias >= 30 ? "Reclamar" : dias >= 15 ? "Revisar" : "Normal";
    item.alertas = [];
    if (impPend < 0) item.alertas.push("➖ importe negativo");
    if (impPend > 1000) item.alertas.push("💶 importe alto");
    if (!item.ot) item.alertas.push("❓ falta OT");
    pendientes.push(item);
  });

  const rank = { Urgente: 4, Reclamar: 3, Revisar: 2, Normal: 1 };
  pendientes.sort((a, b) => rank[b.prioridad] - rank[a.prioridad] || Math.abs(b.impPend) - Math.abs(a.impPend));
  return { map: m, pendientes, excluidos, tieneLineas: !!lineas?.headers?.length };
}

const COLOR_PRIORIDAD = {
  Urgente: "bg-red-100 text-red-700 border-red-200",
  Reclamar: "bg-orange-100 text-orange-700 border-orange-200",
  Revisar: "bg-amber-100 text-amber-700 border-amber-200",
  Normal: "bg-slate-100 text-slate-500 border-slate-200",
};

export default function Recepcion({ pedidos, lineas, onActualizarBC, actualizando }) {
  const [recep, setRecep] = useState({ revisados: {}, fechas: {} });
  const [q, setQ] = useState("");
  const [fProv, setFProv] = useState("");
  const [fOT, setFOT] = useState("");
  const [fPrio, setFPrio] = useState("");
  const [fTipo, setFTipo] = useState(""); // OC / PC
  const [fAlianza, setFAlianza] = useState(""); // si / no
  const [fDesde, setFDesde] = useState("");
  const [fHasta, setFHasta] = useState("");
  const [ocultarRevisados, setOcultarRevisados] = useState(false);

  // "Subir Documento" — PDF con muchas páginas y muchos pedidos/proveedores.
  // Se lee, se agrupa por Nº de pedido y se cruzan las líneas de material
  // con BC en el backend (/api/recepcion/extraer, solo lectura). Aquí se
  // revisa "como un libro" — un pedido a la vez, con el PDF al lado — y al
  // confirmar CADA pedido se sube a BC (/api/recepcion/subir-bc): Nº
  // albarán, PDF adjunto en Archivos de documento entrante, y Cantidad a
  // recibir en las líneas de material que coincidan (sin registrar/postear).
  const inputDocRef = useRef(null);
  const [subiendoDoc, setSubiendoDoc] = useState(false);
  const [errorDoc, setErrorDoc] = useState(null);
  const [panelDoc, setPanelDoc] = useState(null); // { archivo, paginasTotal, gruposId: [...], gruposSinId: [...] } | null
  const [indiceActual, setIndiceActual] = useState(0);
  const [subidaBC, setSubidaBC] = useState({}); // id de grupo → { subiendo, resultado, error }

  const numerosPedidoConocidos = useMemo(() => {
    if (!pedidos?.headers?.length) return new Set();
    const m = recepMapFor(pedidos.headers);
    return new Set((pedidos.rows || []).map((r) => String(r[m.numero] || "").trim().toUpperCase()).filter(Boolean));
  }, [pedidos]);

  const onSeleccionArchivo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSubiendoDoc(true);
    setErrorDoc(null);
    setPanelDoc(null);
    setSubidaBC({});
    setIndiceActual(0);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch("/api/recepcion/extraer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: file.name, base64 }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      const grupos = (json.grupos || []).map((g, i) => ({
        id: `${i}-${g.pedido || "sin-pedido"}`,
        pedido: g.pedido || "",
        albaran: g.albaran || "",
        paginas: g.paginas || [],
        pdfBase64: g.pdfBase64 || null,
        vendorName: g.vendorName || null,
        bcError: g.bcError || null,
        incluir: !!g.pedido,
        lineasDisponiblesBC: g.lineasDisponiblesBC || [],
        lineas: (g.lineasEmparejadas || []).map((l, j) => ({
          id: `${i}-${j}`,
          descripcionAlbaran: l.descripcionAlbaran,
          cantidadAlbaran: l.cantidadAlbaran,
          lineaBC: l.lineaBC,
          coincidencia: l.coincidencia,
          cantidadARegistrar: l.cantidadARegistrar,
          incluir: l.coincidencia !== "sin_match",
        })),
      }));
      setPanelDoc({
        archivo: file.name,
        paginasTotal: json.paginas,
        gruposId: grupos.filter((g) => g.pedido),
        gruposSinId: grupos.filter((g) => !g.pedido),
      });
    } catch (err) {
      setErrorDoc(err.message || String(err));
    }
    setSubiendoDoc(false);
  };

  const editarGrupo = (idx, campo, valor) => {
    setPanelDoc((prev) => ({ ...prev, gruposId: prev.gruposId.map((g, i) => (i === idx ? { ...g, [campo]: valor } : g)) }));
  };

  const editarLinea = (idxGrupo, idxLinea, campo, valor) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) =>
        i !== idxGrupo ? g : { ...g, lineas: g.lineas.map((l, j) => (j === idxLinea ? { ...l, [campo]: valor } : l)) }
      ),
    }));
  };

  // Elegir A MANO la línea del pedido en BC a la que corresponde una
  // línea leída del PDF — para cuando el emparejamiento automático no
  // encuentra nada, o se equivoca. lineaBcId === "" vacía la selección
  // (vuelve a "sin coincidencia").
  const elegirLineaBC = (idxGrupo, idxLinea, lineaBcId) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) => {
        if (i !== idxGrupo) return g;
        const elegida = lineaBcId ? (g.lineasDisponiblesBC || []).find((lb) => lb.id === lineaBcId) : null;
        return {
          ...g,
          lineas: g.lineas.map((l, j) => {
            if (j !== idxLinea) return l;
            const cantidadARegistrar = elegida ? Math.min(Number(l.cantidadAlbaran) || 0, elegida.cantidadPendiente) : 0;
            return { ...l, lineaBC: elegida || null, coincidencia: elegida ? "manual" : "sin_match", incluir: !!elegida, cantidadARegistrar };
          }),
        };
      }),
    }));
  };

  const confirmarGrupo = async (idx) => {
    const g = panelDoc.gruposId[idx];
    if (!g) return;
    setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: true } }));
    try {
      const lineasConfirmadas = g.lineas
        .filter((l) => l.incluir && l.lineaBC && Number(l.cantidadARegistrar) > 0)
        .map((l) => ({ lineaId: l.lineaBC.id, cantidad: l.cantidadARegistrar }));
      const r = await fetch("/api/recepcion/subir-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido: g.pedido,
          albaran: g.albaran || null,
          pdfBase64: g.pdfBase64,
          nombreArchivo: `${g.pedido}.pdf`,
          lineas: lineasConfirmadas,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, resultado: json } }));
    } catch (err) {
      setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, error: err.message || String(err) } }));
    }
  };

  // Cargar marcas compartidas del backend
  useEffect(() => {
    fetch("/api/recepcion").then((r) => r.json()).then((d) => setRecep({ revisados: d.revisados || {}, fechas: d.fechas || {} })).catch(() => {});
  }, []);

  const guardar = useCallback((parche) => {
    setRecep((prev) => {
      const nuevo = {
        revisados: { ...prev.revisados, ...(parche.revisados || {}) },
        fechas: { ...prev.fechas, ...(parche.fechas || {}) },
      };
      for (const k in parche.revisados || {}) if (parche.revisados[k] === null) delete nuevo.revisados[k];
      for (const k in parche.fechas || {}) if (parche.fechas[k] === null) delete nuevo.fechas[k];
      return nuevo;
    });
    fetch("/api/recepcion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parche),
    }).catch(() => {});
  }, []);

  const datos = useMemo(() => getRecepData(pedidos, lineas, recep.fechas), [pedidos, lineas, recep.fechas]);

  const proveedores = useMemo(() => {
    if (!datos) return [];
    return [...new Set(datos.pendientes.map((p) => p.prov).filter(Boolean))].sort();
  }, [datos]);
  const ots = useMemo(() => {
    if (!datos) return [];
    return [...new Set(datos.pendientes.map((p) => p.ot).filter(Boolean))].sort();
  }, [datos]);

  const filtradas = useMemo(() => {
    if (!datos) return [];
    const qq = q.trim().toLowerCase();
    const desde = fDesde ? new Date(fDesde) : null;
    const hasta = fHasta ? new Date(fHasta) : null;
    return datos.pendientes.filter((p) => {
      if (p.impPend <= 0) return false; // filtro por defecto: solo con pendiente
      if (qq && ![p.num, p.prov, p.ot, p.depto, p.comprador].some((v) => String(v || "").toLowerCase().includes(qq))) return false;
      if (fProv && p.prov !== fProv) return false;
      if (fOT && p.ot !== fOT) return false;
      if (fPrio && p.prioridad !== fPrio) return false;
      if (fTipo === "PC" && p.tipoDoc !== "Pedido") return false;
      if (fTipo === "OC" && p.tipoDoc !== "Oferta") return false;
      if (fAlianza === "si" && !p.alianza) return false;
      if (fAlianza === "no" && p.alianza) return false;
      if (desde || hasta) {
        const f = parseFecha(p.fecha);
        if (desde && (!f || f < desde)) return false;
        if (hasta && (!f || f > hasta)) return false;
      }
      if (ocultarRevisados && recep.revisados[p.num]) return false;
      return true;
    });
  }, [datos, q, fProv, fOT, fPrio, fTipo, fAlianza, fDesde, fHasta, ocultarRevisados, recep.revisados]);

  const kpis = useMemo(() => {
    if (!datos) return null;
    const conPend = datos.pendientes.filter((p) => p.impPend > 0);
    return {
      nPend: conPend.length,
      impPend: conPend.reduce((a, p) => a + p.impPend, 0),
      nExcl: datos.excluidos.length,
      impExcl: datos.excluidos.reduce((a, p) => a + (p.impPend > 0 ? p.impPend : 0), 0),
      mas60: conPend.filter((p) => p.dias > 60).length,
      d3060: conPend.filter((p) => p.dias >= 30 && p.dias <= 60).length,
      d1529: conPend.filter((p) => p.dias >= 15 && p.dias <= 29).length,
    };
  }, [datos]);

  const limpiar = () => { setQ(""); setFProv(""); setFOT(""); setFPrio(""); setFTipo(""); setFAlianza(""); setFDesde(""); setFHasta(""); setOcultarRevisados(false); };

  const sinDatos = !pedidos?.rows?.length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Recepción de material</h1>
          <p className="text-slate-500 text-sm mt-1">
            Pedidos con material pendiente de recibir. Cruza cabeceras de pedido con sus líneas por Nº de documento.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onActualizarBC}
            disabled={actualizando}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <RefreshCw size={15} className={actualizando ? "animate-spin" : ""} /> Actualizar desde BC
          </button>
          <button
            onClick={() => inputDocRef.current?.click()}
            disabled={subiendoDoc}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <Upload size={15} className={subiendoDoc ? "animate-pulse" : ""} /> {subiendoDoc ? "Leyendo documento…" : "Subir Documento"}
          </button>
          <input ref={inputDocRef} type="file" accept="application/pdf" className="hidden" onChange={onSeleccionArchivo} />
        </div>
      </div>

      {errorDoc && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          Error leyendo el documento: {errorDoc}
        </div>
      )}

      {panelDoc && (
        <div className="mt-4 bg-white border border-purple-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-700">
              «{panelDoc.archivo}» · {panelDoc.paginasTotal} página(s) · {panelDoc.gruposId.length} pedido(s) identificado(s)
              {panelDoc.gruposSinId.length > 0 && ` · ${panelDoc.gruposSinId.reduce((a, g) => a + g.paginas.length, 0)} página(s) sin identificar`}
            </div>
            <button onClick={() => { setPanelDoc(null); setSubidaBC({}); }} className="text-slate-400 hover:text-slate-600">
              <X size={16} />
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mb-3">
            Revisa un pedido a la vez: el PDF a la izquierda, lo detectado a la derecha. Corrige lo que haga falta y confirma pedido por pedido.
            Primer uso: prueba con uno solo y comprueba en BC que el albarán, el adjunto y las cantidades han llegado bien antes de seguir con el resto.
          </p>

          {panelDoc.gruposId.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">No se ha identificado ningún pedido en el documento.</div>
          ) : (
            <>
              {/* Navegador "libro": un pedido a la vez */}
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => setIndiceActual((i) => Math.max(0, i - 1))}
                  disabled={indiceActual === 0}
                  className="text-sm border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-40"
                >
                  ◀ Anterior
                </button>
                <span className="text-sm font-medium text-slate-600">Pedido {indiceActual + 1} de {panelDoc.gruposId.length}</span>
                <button
                  onClick={() => setIndiceActual((i) => Math.min(panelDoc.gruposId.length - 1, i + 1))}
                  disabled={indiceActual === panelDoc.gruposId.length - 1}
                  className="text-sm border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-40"
                >
                  Siguiente ▶
                </button>
              </div>

              {(() => {
                const g = panelDoc.gruposId[indiceActual];
                const estado = subidaBC[g.id];
                const existe = g.pedido && numerosPedidoConocidos.has(g.pedido.toUpperCase());
                return (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Vista previa del PDF de ESTE pedido (solo sus páginas) */}
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">
                        Páginas {g.paginas.join(", ")} del documento{g.vendorName ? ` · proveedor en BC: ${g.vendorName}` : ""}
                      </div>
                      {g.pdfBase64 ? (
                        <iframe
                          src={`data:application/pdf;base64,${g.pdfBase64}`}
                          title={`pedido-${g.pedido}`}
                          className="w-full border border-slate-200 rounded-md"
                          style={{ height: 440 }}
                        />
                      ) : (
                        <div className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-md p-6 text-center">Sin vista previa</div>
                      )}
                    </div>

                    {/* Datos detectados + cruce de líneas */}
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-xs font-semibold text-slate-500 w-20">Pedido</label>
                        <input
                          value={g.pedido}
                          onChange={(e) => editarGrupo(indiceActual, "pedido", e.target.value.toUpperCase())}
                          className="border border-slate-300 rounded px-2 py-1 text-sm font-mono w-40"
                        />
                        {!existe && <span title="No aparece en la lista de pedidos cargada — revisar" className="text-amber-600 text-[11px]">⚠ no está en la lista</span>}
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <label className="text-xs font-semibold text-slate-500 w-20">Nº albarán</label>
                        <input
                          value={g.albaran}
                          onChange={(e) => editarGrupo(indiceActual, "albaran", e.target.value)}
                          placeholder="—"
                          className="border border-slate-300 rounded px-2 py-1 text-sm w-40"
                        />
                      </div>

                      {g.bcError && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
                          No se han podido cruzar las líneas de material con BC: {g.bcError}. Puedes subir igualmente el albarán y el adjunto; las cantidades las registrarás a mano.
                        </div>
                      )}

                      {g.lineas.length > 0 && (
                        <div className="mb-3">
                          <div className="text-xs font-semibold text-slate-500 mb-1">Líneas de material leídas en el PDF, cruzadas con las del pedido en BC:</div>
                          <table className="w-full text-[11px] border border-slate-200 rounded overflow-hidden">
                            <thead>
                              <tr className="bg-slate-50 text-slate-600 text-left">
                                <th className="px-1.5 py-1">Inc.</th>
                                <th className="px-1.5 py-1">Leído en el albarán</th>
                                <th className="px-1.5 py-1">Línea del pedido en BC</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad del pedido original en Business Central">Cant. pedido (BC)</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad tal como la ha leído la IA en el PDF — revisa que coincida con el papel">Cant. leída (PDF)</th>
                                <th className="px-1.5 py-1">Cant. a registrar</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.lineas.map((l, li) => {
                                const discrepancia = l.lineaBC && Number(l.cantidadAlbaran) !== Number(l.lineaBC.cantidadPedida);
                                return (
                                <tr key={l.id} className="border-t border-slate-100">
                                  <td className="px-1.5 py-1 text-center">
                                    <input
                                      type="checkbox"
                                      checked={l.incluir}
                                      disabled={!l.lineaBC}
                                      onChange={(e) => editarLinea(indiceActual, li, "incluir", e.target.checked)}
                                    />
                                  </td>
                                  <td className="px-1.5 py-1">{l.descripcionAlbaran}</td>
                                  <td className="px-1.5 py-1">
                                    <select
                                      value={l.lineaBC?.id || ""}
                                      onChange={(e) => elegirLineaBC(indiceActual, li, e.target.value)}
                                      className={`w-full border rounded px-1 py-0.5 bg-white ${
                                        !l.lineaBC ? "border-slate-300 text-slate-400" : l.coincidencia === "manual" ? "border-blue-300 text-blue-700" : l.coincidencia === "alta" ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"
                                      }`}
                                    >
                                      <option value="">— sin coincidencia — elegir a mano —</option>
                                      {(g.lineasDisponiblesBC || []).map((lb) => (
                                        <option key={lb.id} value={lb.id}>
                                          {lb.codigo ? `${lb.codigo} — ` : ""}{lb.descripcion} (pedido {lb.cantidadPedida}, pendiente {lb.cantidadPendiente})
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="px-1.5 py-1 text-right whitespace-nowrap">
                                    {l.lineaBC ? (
                                      <>
                                        {l.lineaBC.cantidadPedida}
                                        <span className="text-slate-400"> (pendiente {l.lineaBC.cantidadPendiente})</span>
                                      </>
                                    ) : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className={`px-1.5 py-1 text-right font-semibold ${discrepancia ? "text-red-600" : "text-slate-700"}`} title={discrepancia ? "No coincide con la cantidad del pedido en BC — revisa el papel" : ""}>
                                    {l.cantidadAlbaran}{discrepancia && " ⚠"}
                                  </td>
                                  <td className="px-1.5 py-1">
                                    <input
                                      type="number"
                                      value={l.cantidadARegistrar}
                                      disabled={!l.lineaBC}
                                      onChange={(e) => editarLinea(indiceActual, li, "cantidadARegistrar", Number(e.target.value))}
                                      className="border border-slate-300 rounded w-16 px-1 py-0.5"
                                    />
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <button
                        onClick={() => confirmarGrupo(indiceActual)}
                        disabled={estado?.subiendo}
                        className="flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-4 py-2"
                      >
                        {estado?.subiendo ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                        Confirmar y subir este pedido a BC
                      </button>

                      {estado?.resultado && (
                        <div className="mt-2 text-[11px] space-y-0.5">
                          <div className="text-slate-400">[{estado.resultado.version || "sin versión — server.cjs antiguo"}]</div>
                          <div className={estado.resultado.albaran.ok ? "text-emerald-700" : "text-amber-700"}>
                            {estado.resultado.albaran.ok ? "✓ Nº albarán actualizado" : `✗ Nº albarán: ${estado.resultado.albaran.error || "error"}`}
                          </div>
                          <div className={estado.resultado.adjunto.ok ? "text-emerald-700" : "text-amber-700"}>
                            {estado.resultado.adjunto.ok ? "✓ PDF adjuntado en Archivos de documento entrante" : `✗ Adjunto: ${estado.resultado.adjunto.error || "error"}`}
                          </div>
                          {(estado.resultado.lineas || []).map((l, li) => (
                            <div key={li} className={l.ok ? "text-emerald-700" : "text-amber-700"}>
                              {l.ok ? `✓ Cantidad a recibir rellenada (línea ${l.lineaId.slice(0, 8)}…)` : `✗ Línea ${l.lineaId.slice(0, 8)}…: ${l.error || "error"}`}
                            </div>
                          ))}
                          {estado.resultado.registro && (
                            <div className={estado.resultado.registro.ok ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>
                              {estado.resultado.registro.ok
                                ? "✓ Pedido REGISTRADO en BC (Recibir)"
                                : `✗ No se registró: ${estado.resultado.registro.error || "error"}`}
                            </div>
                          )}
                        </div>
                      )}
                      {estado?.error && <div className="mt-2 text-[11px] text-red-600">✗ {estado.error}</div>}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {panelDoc.gruposSinId.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-200">
              <div className="text-xs font-semibold text-slate-500 mb-2">
                Páginas sin pedido identificable — revisar a mano al final:
              </div>
              {panelDoc.gruposSinId.map((g, i) => (
                <div key={i} className="text-[11px] text-slate-500 mb-1">
                  Páginas {g.paginas.join(", ")}{g.albaran ? ` · posible Nº albarán leído: ${g.albaran}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sinDatos ? (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          No hay pedidos cargados. Pulsa «Actualizar desde BC» o carga las tarjetas «Pedidos de Compra» y «Líneas de Compra» en «Cargar datos».
        </div>
      ) : (
        <>
          {!datos?.tieneLineas && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-[13px] text-amber-800">
              ⚠ Faltan las líneas de compra: los importes pendientes se calculan desde ellas. Carga «Líneas de Compra».
            </div>
          )}

          {/* KPIs */}
          {kpis && (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mt-5">
              {[
                { l: "Pendientes", v: kpis.nPend, c: "text-blue-700" },
                { l: "Importe pendiente", v: fmtEur(kpis.impPend), c: "text-blue-700" },
                { l: "Excluidos (Esperar)", v: kpis.nExcl, c: "text-slate-500" },
                { l: "Importe excluido", v: fmtEur(kpis.impExcl), c: "text-slate-500" },
                { l: "Más de 60 días", v: kpis.mas60, c: "text-red-600" },
                { l: "30–60 días", v: kpis.d3060, c: "text-orange-600" },
                { l: "15–29 días", v: kpis.d1529, c: "text-amber-600" },
              ].map((k) => (
                <div key={k.l} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
                  <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{k.l}</div>
                  <div className={`text-sm font-bold ${k.c}`}>{k.v}</div>
                </div>
              ))}
            </div>
          )}

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2 mt-4 text-[13px]">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className="pl-7 pr-2 py-1.5 border border-slate-300 rounded-md w-40" />
            </div>
            <select value={fProv} onChange={(e) => setFProv(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md max-w-[180px]">
              <option value="">Proveedores</option>
              {proveedores.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fOT} onChange={(e) => setFOT(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">OT</option>
              {ots.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={fPrio} onChange={(e) => setFPrio(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Prioridad</option>
              {["Urgente", "Reclamar", "Revisar", "Normal"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fTipo} onChange={(e) => setFTipo(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Oferta/Pedido</option>
              <option value="PC">Pedido (PC)</option>
              <option value="OC">Oferta (OC)</option>
            </select>
            <select value={fAlianza} onChange={(e) => setFAlianza(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Alianza</option>
              <option value="si">Con alianza</option>
              <option value="no">Sin alianza</option>
            </select>
            <input type="date" value={fDesde} onChange={(e) => setFDesde(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Desde" />
            <input type="date" value={fHasta} onChange={(e) => setFHasta(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Hasta" />
            <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
              <input type="checkbox" checked={ocultarRevisados} onChange={(e) => setOcultarRevisados(e.target.checked)} /> Ocultar revisados
            </label>
            <button onClick={limpiar} className="text-slate-500 hover:text-slate-700 hover:underline">Limpiar</button>
            <span className="text-slate-400 ml-auto">{filtradas.length} de {datos?.pendientes.filter((p) => p.impPend > 0).length || 0}</span>
          </div>

          {/* Tabla */}
          <div className="mt-3 overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-left">
                  {["✓", "Pedido", "Tipo", "Fecha", "Recepción prevista", "Días", "Proveedor", "Comprador", "Un. negocio", "OT", "Alianza", "Importe", "Imp. pendiente", "Prioridad", "Alertas", "Revisado"].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtradas.map((p) => {
                  const rev = recep.revisados[p.num];
                  return (
                    <tr key={p.num} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={!!rev}
                          onChange={(e) => guardar({ revisados: { [p.num]: e.target.checked ? { ts: new Date().toISOString() } : null } })}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap">{p.num}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.tipoDoc}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.fecha}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <input
                          type="date"
                          value={p.recepPrev && parseFecha(p.recepPrev) ? parseFecha(p.recepPrev).toISOString().slice(0, 10) : ""}
                          onChange={(e) => guardar({ fechas: { [p.num]: e.target.value || null } })}
                          className="border border-slate-200 rounded px-1 py-0.5 text-[11px]"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{p.dias ?? "—"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap max-w-[160px] truncate" title={p.prov}>{p.prov}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.comprador}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.depto}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap font-mono">{p.ot || "—"}</td>
                      <td className="px-2 py-1.5 text-center">{p.alianza ? "✓" : ""}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtEur(p.imp)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold">{fmtEur(p.impPend)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-[10px] font-bold border rounded px-1.5 py-0.5 ${COLOR_PRIORIDAD[p.prioridad]}`}>{p.prioridad}</span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[10px]">{(p.alertas || []).join(" ")}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[10px] text-emerald-700">
                        {rev ? `✓ Revisat OK · ${selloHora(rev.ts)}` : ""}
                      </td>
                    </tr>
                  );
                })}
                {filtradas.length === 0 && (
                  <tr><td colSpan={16} className="px-3 py-6 text-center text-slate-400">Sin pedidos pendientes con los filtros actuales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
