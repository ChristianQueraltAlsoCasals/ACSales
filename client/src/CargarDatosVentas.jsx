import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  Database,
  RefreshCw,
  Trash2,
  Eye,
  Check,
  Clock,
  Info,
  Sparkles,
  FileText,
  UploadCloud,
  X,
  AlertTriangle,
  Brain,
  Search,
  Wrench,
  Package,
  Truck,
  TrendingUp,
  Mail,
} from "lucide-react";
import {
  construirFichasOT,
  enriquecerFichasConAtributos,
  sugerirParaOTNueva,
  adaptarFilasJob,
  adaptarLineasVentaAPI,
  adaptarLineasCompraAPI,
  adaptarTarifasAPI,
  tarifaHoraSugerida,
  adaptarFacturasPDF,
  descripcionesDeFacturasPDF,
  materialPropuestoParaOT,
  otsSimilaresPara,
  compararMaterialOT,
  historialCompraArticulo,
  historialVentaArticulo,
  precioVentaSugerido,
  normalizarNumeroOT,
  mapaDeConocimiento,
  clasificarLineaVenta,
  clasificarLineaCompra,
  IA_CONFIG,
} from "./agenteInteligente.js";
import { OTS_DEMO } from "./datosDemo.js";
import { generarBorradorFactura } from "./borradorFactura.js";
import Recepcion from "./recepcion.jsx";
import FacturasCompra from "./facturasCompra.jsx";
import Precios from "./precios.jsx";
import { EMAILS_DEPARTAMENTO } from "./departamentos.js";
import Correo from "./correo.jsx";
import Tareas from "./tareas.jsx";
import Papa from "papaparse";

/**
 * Pantalla "Cargar datos" — Agente de Ventas
 * -------------------------------------------------
 * Mantiene el mismo lenguaje visual que el Agente de Compras
 * (sidebar azul marino, tarjetas blancas por fuente de datos),
 * pero cada fuente se carga vía API de Business Central con
 * un rango de fechas y caché incremental por día.
 *
 * INTEGRACIÓN REAL:
 * Sustituir la función `fetchFromBC(sourceId, fromISO, toISO)` por
 * la llamada real a tu endpoint (por ejemplo /api/bc/[source]?from=...&to=...).
 * Debe devolver { rows: number } o los datos que necesites persistir.
 */

// ---------- Configuración de fuentes ----------
const SOURCES = [
  {
    id: "pedidos_venta",
    name: "Pedidos de Venta",
    desc: "Cabeceras de pedido: cliente, fecha, estado, importe total.",
    origin: {
      page: "Pedidos de venta (Sales Order List)",
      pageNo: "9305",
      table: "Sales Header (36) · Document Type = Order",
      endpoint: "salesOrders",
    },
  },
  {
    id: "lineas_venta",
    name: "Líneas de Venta",
    desc: "Detalle de artículos vendidos: cantidad, precio, descuento, importe.",
    origin: {
      page: "Líneas del pedido de venta (Sales Order Subform)",
      pageNo: "46",
      table: "Sales Line (37)",
      endpoint: "salesOrderLines / salesInvoiceLines",
    },
  },
  {
    id: "lineas_compra",
    name: "Líneas de Compra",
    desc: "Detalle de compras a proveedor: cantidad, coste, artículo.",
    origin: {
      page: "Líneas del pedido de compra (Purchase Order Subform)",
      pageNo: "39",
      table: "Purchase Line (39)",
      endpoint: "purchaseOrderLines / purchaseInvoiceLines",
    },
  },
  {
    id: "lineas_venta_reg",
    name: "Líneas Venta REGISTRADAS",
    desc: "Facturas de venta línea a línea, con Nº de OT: horas y material por trabajo. Usa las facturas en curso (pág. 47); si se publica la 526, pasará al histórico completo automáticamente.",
    origin: {
      page: "Líneas factura venta registrada (Posted Sales Invoice Lines)",
      pageNo: "526",
      table: "Sales Invoice Line (113)",
      endpoint: "Sales_Invoice_Line_Excel (web service)",
    },
  },
  {
    id: "lineas_compra_reg",
    name: "Líneas Compra REGISTRADAS",
    desc: "Histórico de COMPRAS registradas línea a línea (con Nº de OT): coste real por trabajo. Conecta con el servicio ya publicado en vuestro BC (Hist. líns. facturas compra).",
    origin: {
      page: "Líneas factura compra registrada (Posted Purchase Invoice Lines)",
      pageNo: "528",
      table: "Purch. Invoice Line (123)",
      endpoint: "Purchase_Invoice_Line_Excel (web service)",
    },
  },
  {
    id: "pedidos_compra",
    name: "Pedidos de Compra (cabecera)",
    desc: "Cabecera del pedido de compra: proveedor y fecha de pedido. Se cruza con las Líneas de Compra por Nº de documento (el proveedor no existe en la línea, solo en la cabecera).",
    origin: {
      page: "Pedidos de compra (Purchase Order List)",
      pageNo: "9307",
      table: "Purchase Header (38)",
      endpoint: "Pedido_compra_Excel (web service)",
    },
  },
  {
    id: "lineas_pedido_venta",
    name: "Líneas de Pedido de Venta",
    desc: "Líneas de pedidos de venta vivos: cantidad enviada, facturada y pendiente de facturar. Se cruzan con los Pedidos de Venta por Nº de documento para calcular el importe pendiente de facturar.",
    origin: {
      page: "Líneas del pedido de venta (Sales Order Subform)",
      pageNo: "516",
      table: "Sales Line (37) · Document Type = Order",
      endpoint: "Sales_Order_Line_Excel (web service)",
    },
  },
  {
    id: "movs_contabilidad",
    name: "Movs. Contabilidad",
    desc: "Asientos contables: cuenta, importe, fecha, documento origen.",
    origin: {
      page: "Movimientos contables (General Ledger Entries)",
      pageNo: "25",
      table: "G/L Entry (17)",
      endpoint: "generalLedgerEntries",
    },
  },
  {
    id: "movs_contabilidad_excel",
    name: "Movimientos de OT (Job Ledger)",
    desc: "Movimientos de proyecto (Job) con Nº de OT directo: importe de venta (Line_Amount_LCY) y coste, por línea. Fuente publicada en BC: JobLedgerEntries. Se usa para calcular Ingresos por OT en Pedidos de venta.",
    origin: {
      page: "Movimientos de proyecto (Job Ledger Entries)",
      pageNo: "1004",
      table: "Job Ledger Entry (1012)",
      endpoint: "JobLedgerEntries",
    },
  },
  {
    id: "tarifas_venta",
    name: "Tarifas de Venta",
    desc: "Precios de venta por cliente, artículo y periodo de vigencia.",
    origin: {
      page: "Listas de precios de venta (Sales Price Lists)",
      pageNo: "7381",
      table: "Price List Line (7017) · Sales",
      endpoint: "salesPrices",
    },
  },
];

// ---------- Utilidades de fechas ----------
const toISO = (d) => d; // ya usamos <input type="date"> => yyyy-mm-dd
const fmt = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const isBefore = (a, b) => a < b;
const isAfter = (a, b) => a > b;

// Mediana de una lista de números (usada para cantidades/costes de material)
const mediana = (arr) => {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Fusiona rangos [{from,to}] solapados o contiguos, devuelve lista ordenada y compacta
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : 1));
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (isBefore(cur.from, addDays(last.to, 2))) {
      // se solapan o son contiguos (día siguiente)
      if (isAfter(cur.to, last.to)) last.to = cur.to;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

// Calcula qué sub-rangos de [from,to] NO están ya cubiertos por `cached`
function missingRanges(cached, from, to) {
  let pending = [{ from, to }];
  for (const c of cached) {
    const next = [];
    for (const p of pending) {
      // Sin solape
      if (isAfter(c.from, p.to) || isAfter(p.from, c.to)) {
        next.push(p);
        continue;
      }
      // Trozo antes del rango cacheado
      if (isBefore(p.from, c.from)) {
        next.push({ from: p.from, to: addDays(c.from, -1) });
      }
      // Trozo después del rango cacheado
      if (isAfter(p.to, c.to)) {
        next.push({ from: addDays(c.to, 1), to: p.to });
      }
    }
    pending = next;
  }
  return pending.filter((r) => !isAfter(r.from, r.to));
}

const daysCount = (from, to) =>
  Math.round((new Date(to) - new Date(from)) / 86400000) + 1;

// Llamada a Business Central A TRAVÉS DEL BACKEND (/api/bc/...).
// Tres desenlaces: datos reales · error de BC (se muestra el motivo) ·
// backend no disponible (solo entonces se simulan datos).
async function fetchFromBC(sourceId, from, to) {
  try {
    const r = await fetch(`/api/bc/${sourceId}?from=${from}&to=${to}`);
    // (respuesta puede indicar sinFecha: la fuente se carga completa)
    const json = await r.json().catch(() => ({}));
    if (r.ok) {
      return { rows: json.rows ?? (json.data || []).length, data: json.data || [], simulado: false, sinFecha: !!json.sinFecha };
    }
    // El backend respondió pero BC dio error: propagar el motivo real
    return { rows: 0, data: [], simulado: false, error: json.error || `Error ${r.status}`, detalle: json.pistas?.join(" · ") || json.detalle || "" };
  } catch {
    /* backend no arrancado */
  }
  return {
    rows: 0,
    data: [],
    simulado: false,
    error: "Backend no disponible. Arranca la aplicación con INICIAR.bat (la ventana negra debe mostrar [api] escuchando en :3000) y reintenta.",
  };
}

const todayISO = () => new Date().toISOString().slice(0, 10);

function InfoTooltip({ origin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        aria-label="Ver origen del dato en Business Central"
        className="text-slate-400 hover:text-blue-600 transition-colors -mb-0.5"
      >
        <Info size={15} />
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          className="absolute z-20 left-0 top-6 w-72 bg-slate-900 text-white text-xs rounded-lg shadow-xl p-3 leading-relaxed"
        >
          <div className="font-semibold text-[13px] mb-1.5">Origen en Business Central</div>
          <div className="grid grid-cols-[70px_1fr] gap-y-1 text-slate-200">
            <span className="text-slate-400">Página</span>
            <span>{origin.page} (Nº {origin.pageNo})</span>
            <span className="text-slate-400">Tabla</span>
            <span>{origin.table}</span>
            <span className="text-slate-400">API</span>
            <span className="font-mono text-[11px]">{origin.endpoint}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceCard({ source, state, onLoad, onClear, onEnriquecerExcel }) {
  const [verDatos, setVerDatos] = useState(false);
  const [from, setFrom] = useState(state.cached[0]?.to ? addDays(state.cached[state.cached.length - 1].to, 1) : todayISO());
  const [to, setTo] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [lastAction, setLastAction] = useState(null);
  const [avisoExcel, setAvisoExcel] = useState(null);
  const fileRef = useRef(null);

  // Importa un Excel exportado de BC y ENRIQUECE los pedidos ya cargados con
  // el "Creado por" (que no viaja por OData). Detecta las columnas por varios
  // nombres posibles (español/inglés) para no depender del nombre exacto.
  const handleExcel = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvisoExcel("Leyendo archivo…");
    try {
      let filas = [];
      const esCSV = /\.csv$/i.test(file.name);
      if (esCSV) {
        // CSV con papaparse (siempre disponible)
        const texto = await file.text();
        const out = Papa.parse(texto, { header: true, skipEmptyLines: true });
        filas = out.data || [];
      } else {
        // Excel con SheetJS (xlsx). Import dinámico: solo se carga al usar el botón.
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const hoja = wb.Sheets[wb.SheetNames[0]];
        filas = XLSX.utils.sheet_to_json(hoja, { defval: "" });
      }
      if (!filas.length) { setAvisoExcel("⚠ El archivo está vacío."); return; }

      const headers = Object.keys(filas[0]);
      const low = headers.map((h) => h.toLowerCase().trim());
      const buscar = (res) => {
        for (const re of res) { const i = low.findIndex((h) => re.test(h)); if (i >= 0) return headers[i]; }
        return "";
      };
      const colNum = buscar([/^n[º°o]\.?$/, /n[º°o]?\.?\s*documento/, /^no$/, /^document_no$/, /pedido/]);
      // "Creado por" tal cual (aunque sea GUID) — decisión de Maria.
      const colCreado = buscar([/^creado por$/, /creado por/, /created.?by/]);

      if (!colNum || !colCreado) {
        setAvisoExcel(`⚠ No encuentro las columnas. Nº: ${colNum || "no hallada"} · Creado por: ${colCreado || "no hallada"}. Columnas: ${headers.join(", ")}`);
        return;
      }

      const mapa = {};
      for (const r of filas) {
        const pc = String(r[colNum] || "").trim().toUpperCase();
        const creador = String(r[colCreado] || "").trim();
        if (pc && creador) mapa[pc] = creador;
      }
      const n = onEnriquecerExcel(mapa);
      setAvisoExcel(`✓ ${Object.keys(mapa).length} creadores leídos · ${n} pedidos enriquecidos (columna «${colCreado}»).`);
    } catch (err) {
      setAvisoExcel("⚠ No se pudo leer el archivo: " + (err.message || err));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const cached = state.cached;
  const totalRows = state.totalRows;

  const handleCargar = async () => {
    if (!from || !to || isAfter(from, to)) return;
    setLoading(true);
    setLastAction(null);
    const pending = missingRanges(cached, from, to);

    if (pending.length === 0) {
      setLastAction({ type: "cache", msg: "Todo el rango ya está en caché — no se ha llamado a la API." });
      setLoading(false);
      return;
    }

    let newRows = 0;
    let newData = [];
    let algunaSimulada = false;
    let errorBC = null;
    let sinFecha = false;
    for (const range of pending) {
      const res = await fetchFromBC(source.id, range.from, range.to);
      if (res.error) { errorBC = res; break; }
      newRows += res.rows;
      if (res.data?.length) newData = newData.concat(res.data);
      if (res.simulado) algunaSimulada = true;
      if (res.sinFecha) { sinFecha = true; break; } // ya viene TODO: no pedir más rangos
    }

    if (errorBC) {
      // No cachear el rango: así se puede reintentar tras corregir
      setLastAction({
        type: "cache",
        msg: `⚠ Business Central respondió con error: ${errorBC.error}${errorBC.detalle ? ` — ${errorBC.detalle}` : ""}`,
      });
      setLoading(false);
      return;
    }

    if (sinFecha) {
      // La entidad no tiene fecha filtrable: llega completa. Reemplazar
      // lo cacheado para no duplicar filas entre recargas.
      onClear(source.id);
    }
    onLoad(source.id, { from, to }, newRows, newData);
    const skipped = daysCount(from, to) - pending.reduce((a, r) => a + daysCount(r.from, r.to), 0);
    const base = sinFecha
      ? `Cargados ${newRows.toLocaleString()} registros (la fuente no tiene fecha a nivel de línea: se carga COMPLETA; recargar reemplaza, no duplica).`
      : skipped > 0
      ? `Cargados ${newRows.toLocaleString()} registros nuevos · ${skipped} día(s) ya estaban en caché.`
      : `Cargados ${newRows.toLocaleString()} registros nuevos.`;
    setLastAction({
      type: algunaSimulada ? "cache" : "ok",
      msg: algunaSimulada
        ? `${base} ⚠ Backend no disponible: datos SIMULADOS (no se usarán en la memoria histórica).`
        : base,
    });
    setLoading(false);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Database size={18} className="text-slate-400" />
          <h3 className="font-semibold text-slate-800 text-[15px]">{source.name}</h3>
          <InfoTooltip origin={source.origin} />
        </div>
        <span className="text-[11px] font-bold tracking-wide text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
          API · BC
        </span>
      </div>

      <p className="text-sm text-slate-500 leading-snug -mt-2">{source.desc}</p>

      {/* Estado de caché */}
      {cached.length > 0 ? (
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <Check size={15} className="text-emerald-600 mt-0.5 shrink-0" />
          <div className="text-xs text-emerald-800 leading-snug">
            <div className="font-medium">
              {totalRows.toLocaleString()} filas en caché
            </div>
            <div className="text-emerald-700/80">
              {cached.map((r, i) => (
                <span key={i}>
                  {fmt(r.from)} – {fmt(r.to)}
                  {i < cached.length - 1 ? " · " : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Clock size={15} className="text-slate-400 shrink-0" />
          <span className="text-xs text-slate-500">Sin datos cargados todavía</span>
        </div>
      )}

      {/* Selector de rango de fechas */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-slate-500 font-medium">Desde</label>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full mt-0.5 text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-[11px] text-slate-500 font-medium">Hasta</label>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="w-full mt-0.5 text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleCargar}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium rounded-md px-3 py-2 transition-colors"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          {loading ? "Cargando..." : "Cargar desde Business Central"}
        </button>
      </div>

      {lastAction && (
        <div
          className={`text-xs rounded-md px-2.5 py-1.5 ${
            lastAction.type === "cache"
              ? "bg-amber-50 text-amber-700 border border-amber-200"
              : "bg-blue-50 text-blue-700 border border-blue-200"
          }`}
        >
          {lastAction.msg}
        </div>
      )}

      {cached.length > 0 && (
        <div className="flex gap-2 -mt-1">
          <button
            onClick={() => setVerDatos(true)}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 font-medium"
          >
            <Eye size={13} /> Ver datos
          </button>
          {verDatos && (
            <VisorDatos
              titulo={source.name}
              filas={state.rows || []}
              onCerrar={() => setVerDatos(false)}
            />
          )}
          <button
            onClick={() => onClear(source.id)}
            className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium ml-auto"
          >
            <Trash2 size={13} /> Eliminar caché
          </button>
        </div>
      )}

      {/* Solo pedidos: añadir "Creado por" desde Excel (no viaja por OData) */}
      {source.id === "pedidos_compra" && cached.length > 0 && (
        <div className="mt-1">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcel} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
            title="Sube el Excel o CSV exportado de BC para añadir la columna «Creado por» a los pedidos"
          >
            <UploadCloud size={13} /> Añadir «Creado por» desde Excel/CSV
          </button>
          {avisoExcel && <div className="text-[11px] text-slate-500 mt-1">{avisoExcel}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- Origen en Business Central de las facturas de venta ----------
const INVOICE_ORIGIN = {
  page: "Facturas de venta contabilizadas (Posted Sales Invoices)",
  pageNo: "143",
  table: "Sales Invoice Header (112) / Sales Invoice Line (113)",
  endpoint: "salesInvoices",
};

// ---------- Campos que aporta el Listado de OT's ----------
const OT_FIELDS = [
  "Cliente",
  "Tipo de trabajo",
  "Departamento",
  "Descripción de la faena",
  "Unidad de negocio",
];

function IntelligentAgentCard({ bcData = {}, estadoInicial = null }) {
  // --- Persistencia: guardar/restaurar en el backend para que recargar
  //     la página no borre lo cargado ---
  const guardarEstado = (obj) => {
    fetch("/api/estado", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    }).catch(() => {});
  };
  const restauradoRef = useRef(false);
  // --- Bloque 1: Facturas de venta en PDF ---
  // Los PDFs se envían al backend, que extrae cada factura con sus
  // LÍNEAS (horas, materiales) y las descripciones de los partes.
  const [pdfFiles, setPdfFiles] = useState([]);
  const [pdfFacturas, setPdfFacturas] = useState([]); // facturas extraídas
  const [pdfProcesando, setPdfProcesando] = useState(false);
  const [pdfError, setPdfError] = useState(null);

  const handlePdfUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setPdfProcesando(true);
    setPdfError(null);
    try {
      const archivos = await Promise.all(
        files.map(
          (f) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({ nombre: f.name, base64: reader.result.split(",")[1] });
              reader.onerror = reject;
              reader.readAsDataURL(f);
            })
        )
      );
      const r = await fetch("/api/facturas/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archivos }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Error ${r.status}`);
      }
      const json = await r.json();
      setPdfFacturas((prev) => {
        // evitar duplicados por Nº de factura
        const vistas = new Set(prev.map((f) => f.numFactura));
        const siguiente = [...prev, ...json.data.filter((f) => !vistas.has(f.numFactura))];
        guardarEstado({ pdfFacturas: siguiente });
        return siguiente;
      });
      setPdfFiles((prev) => [
        ...prev,
        ...files.map((f) => `${f.name} — ${json.facturas} factura(s), ${json.lineas} línea(s)`),
      ]);
      if (json.errores?.length) {
        setPdfError(`${json.errores.length} archivo(s) no se pudieron leer.`);
      }
    } catch (err) {
      setPdfError(
        `No se pudieron procesar (${err.message}). El backend debe estar arrancado (npm start).`
      );
      setPdfFiles((prev) => [...prev, ...files.map((f) => `${f.name} — ⚠ sin procesar`)]);
    }
    setPdfProcesando(false);
  };

  // --- Bloque 2: Facturas de venta desde API Business Central ---
  const [invCache, setInvCache] = useState({ cached: [], totalRows: 0 });
  const [invFrom, setInvFrom] = useState(todayISO());
  const [invTo, setInvTo] = useState(todayISO());
  const [invLoading, setInvLoading] = useState(false);
  const [invMsg, setInvMsg] = useState(null);

  const handleCargarFacturasAPI = async () => {
    if (!invFrom || !invTo || isAfter(invFrom, invTo)) return;
    setInvLoading(true);
    setInvMsg(null);
    const pending = missingRanges(invCache.cached, invFrom, invTo);

    if (pending.length === 0) {
      setInvMsg({ type: "cache", text: "Ese rango ya está en caché — no se ha llamado a la API." });
      setInvLoading(false);
      return;
    }
    let newRows = 0;
    for (const range of pending) {
      const res = await fetchFromBC("facturas_venta", range.from, range.to);
      newRows += res.rows;
    }
    setInvCache((prev) => ({
      cached: mergeRanges([...prev.cached, { from: invFrom, to: invTo }]),
      totalRows: prev.totalRows + newRows,
    }));
    setInvMsg({ type: "ok", text: `${newRows.toLocaleString()} factura(s) nueva(s) cargada(s) desde Business Central.` });
    setInvLoading(false);
  };

  // --- Bloque 3: Listado de OT's (contexto descriptivo) — admite VARIOS archivos ---
  // Regla de conflicto acordada: si una misma OT aparece en varios archivos,
  // se usa el dato del archivo con fecha de modificación MÁS RECIENTE.
  const [otFiles, setOtFiles] = useState([]); // [{id, name, rows, lastModified}]

  // Restauración única al recibir el estado persistido
  useEffect(() => {
    if (!estadoInicial || restauradoRef.current) return;
    restauradoRef.current = true;
    if (estadoInicial.otFiles?.length) setOtFiles(estadoInicial.otFiles);
    if (estadoInicial.pdfFacturas?.length) {
      setPdfFacturas(estadoInicial.pdfFacturas);
      setPdfFiles([`${estadoInicial.pdfFacturas.length} factura(s) restauradas de la sesión anterior`]);
    }
    if (estadoInicial.fichas?.length) {
      setFichas(new Map(estadoInicial.fichas));
      if (estadoInicial.resumen) setResumen(estadoInicial.resumen);
    }
  }, [estadoInicial]);
  const [otWarning, setOtWarning] = useState(null);

  const handleOtUpload = (e) => {
    const incoming = Array.from(e.target.files || []);
    if (incoming.length === 0) return;

    const existingNames = new Set(otFiles.map((f) => f.name));
    const duplicateNames = incoming.filter((f) => existingNames.has(f.name));
    const nuevos = incoming.filter((f) => !existingNames.has(f.name));

    if (duplicateNames.length > 0) {
      setOtWarning(
        `${duplicateNames.length} archivo(s) ya estaban cargados y se han ignorado: ${duplicateNames
          .map((f) => f.name)
          .join(", ")}.`
      );
    } else if (otFiles.length > 0 || nuevos.length > 1) {
      setOtWarning(
        "Si una misma OT aparece en varios archivos, el agente se queda con los datos del archivo modificado más recientemente (orden de prioridad de la lista, de arriba a abajo)."
      );
    } else {
      setOtWarning(null);
    }

    // Leer cada CSV de verdad
    nuevos.forEach((file) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        delimitersToGuess: [";", ",", "\t", "|"],
        transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
        complete: (res) => {
          setOtFiles((prev) => {
            const siguiente = [
              ...prev,
              {
                id: `${file.name}-${file.lastModified}`,
                name: file.name,
                lastModified: file.lastModified,
                rows: res.data.length,
                data: res.data, // filas reales
              },
            ];
            guardarEstado({ otFiles: siguiente });
            return siguiente;
          });
        },
        error: (err) => {
          setOtWarning(`Error leyendo ${file.name}: ${err.message}`);
        },
      });
    });
    e.target.value = "";
  };

  const removeOtFile = (id) => {
    setOtFiles((prev) => {
      const siguiente = prev.filter((f) => f.id !== id);
      guardarEstado({ otFiles: siguiente });
      return siguiente;
    });
  };

  // Cargar el listado de OT's directamente desde la tabla Job de BC
  const [cargandoJob, setCargandoJob] = useState(false);
  const [anyoDesde, setAnyoDesde] = useState("");
  const [anyoHasta, setAnyoHasta] = useState("");
  const cargarDesdeJob = async () => {
    setCargandoJob(true);
    setOtWarning(null);
    try {
      const params = new URLSearchParams();
      if (anyoDesde) params.set("fromYear", anyoDesde);
      if (anyoHasta) params.set("toYear", anyoHasta);
      const r = await fetch(`/api/bc/proyectos${params.toString() ? "?" + params.toString() : ""}`);
      if (!r.ok) throw new Error(`El backend respondió ${r.status}`);
      const json = await r.json();
      const adaptadas = adaptarFilasJob(json.data || []);
      const etiquetaRango =
        anyoDesde || anyoHasta ? ` (${anyoDesde || "…"}–${anyoHasta || "…"})` : "";
      setOtFiles((prev) => {
        const siguiente = [
          ...prev.filter((f) => f.id !== "bc-job"),
          {
            id: "bc-job",
            name: `Business Central · Proyectos${etiquetaRango}`,
            lastModified: Date.now(),
            rows: adaptadas.length,
            data: adaptadas,
          },
        ];
        guardarEstado({ otFiles: siguiente });
        return siguiente;
      });
    } catch (err) {
      setOtWarning(
        `No se pudo cargar desde Business Central (${err.message}). Requiere el backend arrancado y el web service publicado. Mientras tanto puedes usar los CSV.`
      );
    }
    setCargandoJob(false);
  };

  // Orden de prioridad ante OT's duplicadas: el más reciente primero
  const otFilesSorted = [...otFiles].sort((a, b) => b.lastModified - a.lastModified);
  const otTotalRows = otFiles.reduce((a, f) => a + f.rows, 0);
  const lineasVentaDisponibles =
    (bcData["lineas_venta_reg"]?.rows?.length || 0) + (bcData["lineas_venta"]?.rows?.length || 0);
  const readyToCross = (pdfFiles.length > 0 || lineasVentaDisponibles > 0) && otFiles.length > 0;

  // --- Construcción de la memoria histórica ---
  const [fichas, setFichas] = useState(null);
  const [vistaAgente, setVistaAgente] = useState("consulta"); // consulta | explorar
  const [construyendo, setConstruyendo] = useState(false);
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0, fase: "" });
  const [resumen, setResumen] = useState(null);

  const construirMemoria = async () => {
    setConstruyendo(true);
    setResumen(null);
    setProgreso({ hecho: 0, total: 0, fase: "Uniendo datos por Nº de OT..." });

    // Combinar los CSV reales cargados. Regla de conflicto: gana el
    // archivo más reciente, así que procesamos del más ANTIGUO al más
    // reciente y dejamos que el reciente sobrescriba por Nº de OT.
    const conDatos = otFilesSorted.filter((f) => Array.isArray(f.data) && f.data.length > 0);

    let listadoOTs;
    let usandoDemo = false;
    if (conDatos.length > 0) {
      const porOT = new Map();
      // orden ascendente por fecha (antiguo primero) → el reciente pisa
      const ascendente = [...conDatos].sort((a, b) => a.lastModified - b.lastModified);
      for (const f of ascendente) {
        for (const fila of f.data) {
          const idOT = (fila["OT"] ?? "").toString().trim();
          if (!idOT) continue;
          porOT.set(idOT, fila);
        }
      }
      listadoOTs = [...porOT.values()];
    } else {
      listadoOTs = OTS_DEMO.listadoOTs;
      usandoDemo = true;
    }

    // 1) Ficha única por OT. Las líneas de venta/compra llegan de las
    //    tarjetas de la parte superior (API de BC); si no hay, van vacías
    //    y los importes salen del propio CSV de OTs.
    const lineasVentaAPI = bcData["lineas_venta"]?.rows || [];
    const lineasCompraAPI = bcData["lineas_compra"]?.rows || [];
    const lineasVentaReg = bcData["lineas_venta_reg"]?.rows || [];
    const lineasCompraReg = bcData["lineas_compra_reg"]?.rows || [];

    // El PROVEEDOR vive en la CABECERA del pedido de compra (Purchase
    // Header), no en la línea (Purchase Line) — por eso nunca aparecía.
    // Si has cargado la tarjeta "Pedidos de Compra (cabecera)", lo
    // cruzamos aquí por Nº de documento (Document_No de la línea = No
    // de la cabecera) antes de adaptar las líneas. Si no la has cargado,
    // pedidosCompra sale vacío y esto no cambia nada de lo que ya había.
    const pedidosCompra = bcData["pedidos_compra"]?.rows || [];
    const cabeceraPorDocumento = new Map();
    for (const cab of pedidosCompra) {
      const doc = (cab["No"] ?? cab["No."] ?? "").toString().trim();
      if (doc) {
        cabeceraPorDocumento.set(doc, {
          proveedor: cab["Buy_from_Vendor_Name"] ?? null,
          fechaPedido: cab["Order_Date"] ?? null,
        });
      }
    }
    const conProveedorCruzado = (filas) =>
      cabeceraPorDocumento.size === 0
        ? filas
        : filas.map((f) => {
            const doc = (f["Document_No"] ?? "").toString().trim();
            const cab = cabeceraPorDocumento.get(doc);
            if (!cab) return f;
            return {
              ...f,
              Buy_from_Vendor_Name: f["Buy_from_Vendor_Name"] ?? cab.proveedor,
              Order_Date: f["Order_Date"] ?? cab.fechaPedido,
            };
          });

    const lineasVenta = usandoDemo
      ? OTS_DEMO.lineasVenta
      : [
          ...adaptarLineasVentaAPI(lineasVentaAPI),
          ...adaptarLineasVentaAPI(lineasVentaReg), // registradas: histórico facturado
          ...adaptarFacturasPDF(pdfFacturas),
        ];
    const lineasCompra = usandoDemo
      ? OTS_DEMO.lineasCompra
      : [
          ...adaptarLineasCompraAPI(conProveedorCruzado(lineasCompraAPI)),
          ...adaptarLineasCompraAPI(conProveedorCruzado(lineasCompraReg)),
        ];
    const movsCuentaVentas = bcData["movs_contabilidad_excel"]?.rows || [];
    const mapa = construirFichasOT(listadoOTs, lineasVenta, lineasCompra, movsCuentaVentas);

    // Descripciones de los partes de las facturas PDF: describen el
    // trabajo REAL ejecutado (a menudo mejor que la descripción de la
    // OT en BC), así que SIEMPRE se añaden — completan las vacías y
    // enriquecen las existentes para la búsqueda y la IA.
    if (!usandoDemo && pdfFacturas.length > 0) {
      const descPorOT = descripcionesDeFacturasPDF(pdfFacturas);
      for (const [clave, descs] of descPorOT) {
        const ficha = mapa.get(clave);
        if (!ficha) continue;
        const actuales = ficha.general.descripcion || "";
        const nuevas = descs.filter((d) => !actuales.toLowerCase().includes(d.toLowerCase()));
        if (nuevas.length > 0) {
          ficha.general.descripcion = actuales ? `${actuales} · ${nuevas.join(" · ")}` : nuevas.join(" · ");
        }
      }
    }

    // 2) Interpretar descripciones con la IA.
    //    En modo producción, primero se descarga la caché de atributos ya
    //    calculados en sesiones anteriores (persistida en el backend):
    //    solo se clasifican las descripciones NUEVAS. Al acabar, los
    //    nuevos resultados se guardan para la próxima vez.
    setProgreso({ hecho: 0, total: mapa.size, fase: "Interpretando descripciones..." });
    let cacheInicial = {};
    if (IA_CONFIG.modo === "produccion") {
      try {
        const r = await fetch("/api/atributos");
        if (r.ok) cacheInicial = await r.json();
      } catch {
        /* backend sin arrancar: sin caché previa */
      }
    }

    const resultadoIA = await enriquecerFichasConAtributos(mapa, {
      tamanoLote: 8,
      cacheInicial,
      // Guardado INCREMENTAL: cada ~200 clasificaciones se persisten en
      // el backend. Si la sesión se interrumpe, casi nada se pierde.
      onPersistir:
        IA_CONFIG.modo === "produccion"
          ? async (parcial) => {
              await fetch("/api/atributos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(parcial),
              });
            }
          : null,
      onProgreso: (hecho, total) => setProgreso({ hecho, total, fase: "Interpretando descripciones..." }),
    });

    // 3) Resumen
    const fichasArr = [...mapa.values()];
    setFichas(mapa);
    const resumenObj = {
      total: fichasArr.length,
      conAtributos: fichasArr.filter((f) => f.atributos).length,
      sinDescripcion: fichasArr.filter((f) => !f.general.descripcion).length,
      conAvisos: fichasArr.filter((f) => f.avisos.length > 0).length,
      desdeCache: resultadoIA.desdeCache,
      clasificadas: resultadoIA.clasificadas,
      fallidas: resultadoIA.fallidas,
      usandoDemo,
    };
    setResumen(resumenObj);
    // Persistir la memoria completa: recargar la página no la borra y
    // la pantalla de OTs (ventana nueva) la lee de aquí
    guardarEstado({ fichas: [...mapa.entries()], resumen: resumenObj });
    setConstruyendo(false);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 mt-4">
      <div className="grid grid-cols-3 gap-5">
        {/* Bloque 1 — PDF (azul) */}
        <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-blue-900 text-sm">
              <FileText size={16} /> Facturas de venta (PDF)
              <InfoTooltip origin={INVOICE_ORIGIN} />
            </div>
            <span className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
              PDF
            </span>
          </div>
          <p className="text-xs text-blue-900/70 leading-snug">
            Sube las facturas de venta ya emitidas, en PDF. Puedes seleccionar varias a la vez.
          </p>
          <label className="cursor-pointer text-center border border-blue-300 bg-white rounded-md py-2 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors">
            Seleccionar PDF(s)
            <input type="file" accept=".pdf" multiple className="hidden" onChange={handlePdfUpload} />
          </label>
          {pdfProcesando && (
            <div className="flex items-center gap-1.5 text-xs text-blue-900 bg-white/70 border border-blue-200 rounded px-2 py-1.5">
              <RefreshCw size={13} className="animate-spin" /> Extrayendo líneas de las facturas...
            </div>
          )}
          {pdfFacturas.length > 0 && !pdfProcesando && (
            <div className="flex items-center gap-1.5 text-xs text-blue-900 bg-white/70 border border-blue-200 rounded px-2 py-1.5">
              <Check size={13} className="text-emerald-600" />
              {pdfFacturas.length} factura(s) · {pdfFacturas.reduce((a, f) => a + f.lineas.length, 0)} línea(s) extraídas
            </div>
          )}
          {pdfError && (
            <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              ⚠ {pdfError}
            </div>
          )}
        </div>

        {/* Bloque 2 — Líneas de factura de venta (desde Cargar datos) */}
        <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-blue-900 text-sm">
              <Database size={16} /> Líns. factura venta (BC)
            </div>
            <span className="text-[11px] font-bold text-blue-700 bg-blue-100 border border-blue-300 rounded px-2 py-0.5">
              API · BC
            </span>
          </div>
          <p className="text-xs text-blue-900/70 leading-snug">
            Las líneas de factura de venta — con Nº de OT, horas y material — son las que alimentan la memoria.
            Se cargan en la sección «Cargar datos» y aquí se muestran las disponibles.
          </p>

          {(() => {
            const reg = bcData["lineas_venta_reg"]?.rows?.length || 0;
            const vivas = bcData["lineas_venta"]?.rows?.length || 0;
            const total = reg + vivas;
            return total > 0 ? (
              <div className="text-[11px] bg-white/70 border border-blue-200 rounded px-2 py-2 text-blue-900 flex flex-col gap-1">
                <div>
                  ✓ <span className="font-bold">{total.toLocaleString()} líneas</span> listas para la memoria
                </div>
                {reg > 0 && <div className="text-blue-800/80">· {reg.toLocaleString()} registradas (histórico facturado)</div>}
                {vivas > 0 && <div className="text-blue-800/80">· {vivas.toLocaleString()} de pedidos vivos</div>}
              </div>
            ) : (
              <div className="text-[11px] bg-amber-50 border border-amber-200 rounded px-2 py-2 text-amber-800">
                Sin líneas cargadas todavía. Ve a «Cargar datos» → tarjetas «Líneas Venta REGISTRADAS» y «Líneas de Venta».
              </div>
            );
          })()}

          <div className="text-[11px] text-blue-900/60">
            También cuentan las facturas subidas en PDF (bloque de la izquierda) y las líneas de compra para el
            coste real y las diferencias.
          </div>
        </div>

        {/* Bloque 3 — Listado de OT's (clave, resaltado en ámbar) */}
        <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-amber-900 text-sm">
              <UploadCloud size={16} /> Listado de OT's
            </div>
            <span className="text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded px-2 py-0.5">
              CLAVE
            </span>
          </div>
          <p className="text-xs text-amber-900/80 leading-snug">
            Este archivo es el más importante: aporta la parte <strong>descriptiva</strong> de cada OT, sin la cual el agente no puede aprender de qué trataba cada trabajo. Todos los Excels deben tener las mismas columnas.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {OT_FIELDS.map((f) => (
              <span
                key={f}
                className="text-[10px] font-medium text-amber-800 bg-white border border-amber-300 rounded-full px-2 py-0.5"
              >
                {f}
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <label className="flex-1 cursor-pointer text-center border border-amber-400 bg-white rounded-md py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors">
              Seleccionar Excel / CSV
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                multiple
                className="hidden"
                onChange={handleOtUpload}
              />
            </label>
            <button
              onClick={cargarDesdeJob}
              disabled={cargandoJob}
              className="flex items-center justify-center gap-1.5 border border-amber-400 bg-white rounded-md px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 transition-colors"
              title="Trae el listado desde la tabla Job (página 89) de Business Central"
            >
              <RefreshCw size={12} className={cargandoJob ? "animate-spin" : ""} />
              {cargandoJob ? "Cargando..." : "Desde BC"}
            </button>
          </div>

          {/* Filtro por año de OT (el año va en el Nº: AC014340/2026) */}
          <div className="flex items-center gap-1.5 -mt-1">
            <span className="text-[10px] text-amber-800/70">Filtrar años (BC):</span>
            <input
              type="number"
              value={anyoDesde}
              onChange={(e) => setAnyoDesde(e.target.value)}
              placeholder="Desde"
              min="2015"
              max="2099"
              className="w-16 text-[11px] border border-amber-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <span className="text-[10px] text-amber-800/50">–</span>
            <input
              type="number"
              value={anyoHasta}
              onChange={(e) => setAnyoHasta(e.target.value)}
              placeholder="Hasta"
              min="2015"
              max="2099"
              className="w-16 text-[11px] border border-amber-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <span className="text-[10px] text-amber-800/50">vacío = todos</span>
          </div>
          <p className="text-[10px] text-amber-800/60 -mt-2">Puedes seleccionar varios archivos, o añadirlos en tandas.</p>

          {otFilesSorted.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] text-amber-800/70">
                Orden de prioridad si una OT se repite (el 1º gana, por ser el más reciente):
              </div>
              {otFilesSorted.map((f, i) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between gap-1.5 text-xs text-amber-900 bg-white/70 border border-amber-300 rounded px-2 py-1.5"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <span className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full bg-amber-200 text-amber-900 text-[10px] font-bold">
                      {i + 1}
                    </span>
                    <span className="truncate">{f.name}</span>
                    <span className="text-amber-700/70 shrink-0">
                      · {f.rows.toLocaleString()} OT's · modif. {new Date(f.lastModified).toLocaleDateString("es-ES")}
                    </span>
                  </span>
                  <button
                    onClick={() => removeOtFile(f.id)}
                    className="text-amber-500 hover:text-red-600 shrink-0"
                    aria-label={`Quitar ${f.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <div className="text-[11px] font-medium text-amber-900 mt-0.5">
                Total: {otFiles.length} archivo(s) · {otTotalRows.toLocaleString()} OT's combinadas
              </div>
            </div>
          )}

          {otWarning && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-100 border border-amber-300 rounded px-2 py-1.5">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>{otWarning}</span>
            </div>
          )}
        </div>
      </div>

      {/* Estado del cruce */}
      <div
        className={`mt-5 rounded-lg px-4 py-3 text-xs flex items-center gap-2 ${
          readyToCross
            ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
            : "bg-slate-50 border border-slate-200 text-slate-500"
        }`}
      >
        {readyToCross ? <Check size={14} className="text-emerald-600 shrink-0" /> : <Clock size={14} className="shrink-0" />}
        {readyToCross
          ? "Hay facturas y Listado de OT's cargados: el agente puede cruzar importes (materiales / mano de obra) con la descripción de cada OT."
          : "Faltan datos: necesitas al menos una factura de venta (PDF o API) y el Listado de OT's para construir la memoria histórica."}
      </div>

      {/* Botón construir memoria */}
      <div className="mt-4">
        <button
          onClick={construirMemoria}
          disabled={construyendo}
          className="flex items-center justify-center gap-2 w-full bg-purple-700 hover:bg-purple-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg px-4 py-3 transition-colors"
        >
          <Brain size={18} className={construyendo ? "animate-pulse" : ""} />
          {construyendo ? "Construyendo memoria..." : "Construir memoria histórica"}
        </button>
        <p className="text-[11px] text-slate-400 mt-1.5 text-center">
          {otFiles.some((f) => Array.isArray(f.data) && f.data.length > 0)
            ? "Se usarán los CSV de OT's cargados arriba."
            : "Sin CSV cargados: se usarán OTs de ejemplo para la demostración."}
        </p>
      </div>

      {/* Barra de progreso */}
      {construyendo && (
        <div className="mt-3">
          <div className="text-xs text-slate-600 mb-1">{progreso.fase}</div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-600 transition-all duration-300"
              style={{ width: progreso.total ? `${(progreso.hecho / progreso.total) * 100}%` : "10%" }}
            />
          </div>
          {progreso.total > 0 && (
            <div className="text-[11px] text-slate-400 mt-1">
              {progreso.hecho} / {progreso.total} descripciones
            </div>
          )}
        </div>
      )}

      {/* Resumen tras construir */}
      {resumen && !construyendo && (
        <div className="mt-4 grid grid-cols-4 gap-3">
          <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2.5 text-center">
            <div className="text-xl font-bold text-purple-800">{resumen.total}</div>
            <div className="text-[11px] text-purple-700">fichas de OT</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-center">
            <div className="text-xl font-bold text-emerald-700">{resumen.conAtributos}</div>
            <div className="text-[11px] text-emerald-700">con atributos IA</div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-center">
            <div className="text-xl font-bold text-amber-700">{resumen.conAvisos}</div>
            <div className="text-[11px] text-amber-700">con avisos</div>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-center">
            <div className="text-xl font-bold text-slate-600">{resumen.sinDescripcion}</div>
            <div className="text-[11px] text-slate-500">sin descripción</div>
          </div>
        </div>
      )}

      {resumen && !construyendo && (resumen.desdeCache > 0 || resumen.clasificadas > 0 || resumen.fallidas > 0) && (
        <div className="mt-2 text-[11px] text-slate-500 text-center">
          {resumen.desdeCache > 0 && (
            <>♻️ {resumen.desdeCache.toLocaleString()} descripciones reutilizadas de sesiones anteriores (sin coste)</>
          )}
          {resumen.desdeCache > 0 && resumen.clasificadas > 0 && " · "}
          {resumen.clasificadas > 0 && <>🤖 {resumen.clasificadas.toLocaleString()} clasificadas nuevas en esta sesión</>}
          {resumen.fallidas > 0 && (
            <span className="text-amber-600">
              {" · "}⚠ {resumen.fallidas.toLocaleString()} no se pudieron clasificar — vuelve a pulsar «Construir memoria» para reintentarlas (solo se procesarán esas)
            </span>
          )}
        </div>
      )}

      {/* Panel de consulta / explorador de OTs */}
      {fichas && !construyendo && (
        <div className="mt-4">
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setVistaAgente("consulta")}
              className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                vistaAgente === "consulta"
                  ? "bg-purple-600 text-white border-purple-600"
                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
              }`}
            >
              🔍 Consultar OT nueva
            </button>
            <button
              onClick={() => setVistaAgente("explorar")}
              className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                vistaAgente === "explorar"
                  ? "bg-purple-600 text-white border-purple-600"
                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
              }`}
            >
              📋 Explorar OTs ({fichas.size.toLocaleString()})
            </button>
            <button
              onClick={() => setVistaAgente("mapa")}
              className={`text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors ${
                vistaAgente === "mapa"
                  ? "bg-purple-600 text-white border-purple-600"
                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
              }`}
            >
              🕸 Mapa de conocimiento
            </button>
            <button
              onClick={() => window.open(window.location.pathname + "#/ots", "_blank")}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border bg-white text-purple-700 border-purple-300 hover:bg-purple-50 transition-colors"
              title="Abre el explorador de OTs a pantalla completa en una pestaña nueva"
            >
              🗗 Abrir en ventana nueva
            </button>
          </div>
          {vistaAgente === "consulta" && (
            <ConsultaOTNueva
              fichas={fichas}
              tarifaInicial={tarifaHoraSugerida(adaptarTarifasAPI(bcData["tarifas_venta"]?.rows || []))}
            />
          )}
          {vistaAgente === "explorar" && <ExplorarOTs fichas={fichas} />}
          {vistaAgente === "mapa" && <MapaConocimiento fichas={fichas} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// PANEL DE CONSULTA — OT nueva → sugerencia
// ---------------------------------------------------------------------
// =====================================================================
// MAPA DE CONOCIMIENTO — organigrama Oficio → Trabajo → Materiales,
// con panel de "necesito tu ayuda" para lo que no sabe relacionar
// =====================================================================
function MapaConocimiento({ fichas }) {
  const mapa = useMemo(() => mapaDeConocimiento(fichas), [fichas]);
  const [abiertos, setAbiertos] = useState({}); // oficio → bool
  const [trabajoAbierto, setTrabajoAbierto] = useState({}); // oficio·trabajo → bool

  const toggle = (k, setter) => setter((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <div className="text-xs text-slate-500 mb-3">
        Relaciones aprendidas por el agente: <b>{mapa.totalConAtributos.toLocaleString()}</b> OTs con atributos,
        organizadas por Oficio → Tipo de trabajo, con los materiales asociados a cada uno. Haz clic para desplegar.
      </div>

      {/* Árbol */}
      <div className="flex flex-col gap-1.5 mb-5">
        {mapa.arbol.map((of) => (
          <div key={of.oficio} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => toggle(of.oficio, setAbiertos)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
            >
              <span className="text-slate-400 text-xs w-3">{abiertos[of.oficio] ? "▼" : "▶"}</span>
              <span className="text-sm font-bold text-slate-800">{of.oficio}</span>
              <span className="text-[11px] text-slate-500">{of.nOTs.toLocaleString()} OTs · {of.trabajos.length} tipos de trabajo</span>
            </button>
            {abiertos[of.oficio] && (
              <div className="border-t border-slate-100 px-3 py-2 flex flex-col gap-1">
                {of.trabajos.map((t) => {
                  const k = of.oficio + "·" + t.trabajo;
                  return (
                    <div key={k} className="border border-slate-100 rounded-md">
                      <button
                        onClick={() => toggle(k, setTrabajoAbierto)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50"
                      >
                        <span className="text-slate-400 text-[10px] w-3">{trabajoAbierto[k] ? "▼" : "▶"}</span>
                        <span className="text-xs font-semibold text-slate-700">{t.trabajo}</span>
                        <span className="text-[10px] text-slate-500">{t.nOTs} OTs</span>
                        {t.horasMediana != null && (
                          <span className="text-[10px] text-slate-500">· {t.horasMediana.toFixed(1)}h med.</span>
                        )}
                        {t.importeMediana != null && (
                          <span className="text-[10px] text-slate-500">· {eur(t.importeMediana)} med.</span>
                        )}
                        <span className="ml-auto text-[10px] text-sky-700">
                          {t.familias.length > 0 ? `${t.familias.length} familias de material` : "sin material asociado"}
                        </span>
                      </button>
                      {trabajoAbierto[k] && (
                        <div className="border-t border-slate-100 px-3 py-2">
                          <div className="text-[10px] text-slate-400 italic mb-1.5 truncate" title={t.ejemplo}>
                            ej.: {t.ejemplo}
                          </div>
                          {t.familias.length === 0 && (
                            <div className="text-[11px] text-amber-700">
                              Sin líneas de material en estas OTs — sube sus facturas PDF o carga sus líneas de venta.
                            </div>
                          )}
                          {t.familias.map((fam) => (
                            <div key={fam.familia} className="flex items-baseline gap-2 text-[11px] py-0.5">
                              <span className="font-semibold text-sky-900 whitespace-nowrap w-40">
                                {fam.familia} <span className="text-sky-700/60">({fam.nOTs})</span>
                              </span>
                              <span className="text-slate-600 truncate">
                                {fam.articulos.map((a) => `${a.descripcion} ×${a.veces}`).join(" · ")}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Panel de ayuda: lo que el agente no sabe relacionar */}
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
        <div className="text-sm font-bold text-amber-900 mb-1">🙋 Necesito tu ayuda con esto</div>
        <div className="text-[11px] text-amber-800/80 mb-3">
          Cosas que el agente no ha sabido relacionar. Dile a Claude cómo clasificarlas (ej.: «la familia de X es
          Válvula», «las OTs de "revisió electrolisis" son de oficio Piscinas») y se añadirán las reglas.
        </div>

        {mapa.ayuda.materialesSinFamilia.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-amber-900 mb-1">
              Materiales sin familia asignada (caen en «Otros»):
            </div>
            {mapa.ayuda.materialesSinFamilia.map((m) => (
              <div key={m.texto} className="text-[11px] text-slate-700 py-0.5">
                • {m.texto} <span className="text-slate-400">×{m.veces}</span>
              </div>
            ))}
          </div>
        )}

        {mapa.ayuda.oficioDesconocido.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-amber-900 mb-1">
              Trabajos cuyo oficio no está claro:
            </div>
            {mapa.ayuda.oficioDesconocido.map((m) => (
              <div key={m.texto} className="text-[11px] text-slate-700 py-0.5 truncate" title={m.texto}>
                • {m.texto} <span className="text-slate-400">×{m.veces}</span>
              </div>
            ))}
          </div>
        )}

        {mapa.ayuda.gruposSinMaterial.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-semibold text-amber-900 mb-1">
              Tipos de trabajo frecuentes SIN material asociado (faltan sus facturas o líneas):
            </div>
            {mapa.ayuda.gruposSinMaterial.map((g, i) => (
              <div key={i} className="text-[11px] text-slate-700 py-0.5">
                • {g.oficio} → {g.trabajo} <span className="text-slate-400">({g.nOTs} OTs)</span>
              </div>
            ))}
          </div>
        )}

        {mapa.ayuda.nSinAtributos > 0 && (
          <div>
            <div className="text-xs font-semibold text-amber-900 mb-1">
              {mapa.ayuda.nSinAtributos.toLocaleString()} OT(s) sin clasificar por la IA — las más repetidas:
            </div>
            {mapa.ayuda.sinAtributos.map((m) => (
              <div key={m.texto} className="text-[11px] text-slate-700 py-0.5 truncate" title={m.texto}>
                • {m.texto} <span className="text-slate-400">×{m.veces}</span>
              </div>
            ))}
            <div className="text-[10px] text-amber-800/70 mt-1">
              Vuelve a pulsar «Construir memoria histórica» para reintentarlas (solo se procesarán esas).
            </div>
          </div>
        )}

        {mapa.ayuda.materialesSinFamilia.length === 0 &&
          mapa.ayuda.oficioDesconocido.length === 0 &&
          mapa.ayuda.gruposSinMaterial.length === 0 &&
          mapa.ayuda.nSinAtributos === 0 && (
            <div className="text-xs text-emerald-700">✓ Nada pendiente: todo lo cargado está relacionado.</div>
          )}
      </div>
    </div>
  );
}

// =====================================================================
// VISOR DE DATOS — modal con las filas reales cargadas de una fuente
// =====================================================================
function VisorDatos({ titulo, filas, onCerrar }) {
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(0);
  const POR_PAGINA = 50;

  // Columnas: unión de claves de las primeras filas (sin metadatos OData)
  const columnas = useMemo(() => {
    const cols = [];
    const vistas = new Set();
    for (const fila of filas.slice(0, 30)) {
      for (const k of Object.keys(fila || {})) {
        if (k.startsWith("@") || vistas.has(k)) continue;
        vistas.add(k);
        cols.push(k);
      }
    }
    return cols;
  }, [filas]);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter((f) => Object.values(f || {}).some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [filas, busqueda]);

  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA));
  const visibles = filtradas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onCerrar}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-800">{titulo}</h2>
          <span className="text-xs text-slate-500">
            {filtradas.length.toLocaleString()} fila(s){busqueda && ` (de ${filas.length.toLocaleString()})`}
          </span>
          <input
            type="text"
            value={busqueda}
            onChange={(e) => {
              setBusqueda(e.target.value);
              setPagina(0);
            }}
            placeholder="Buscar en todos los campos..."
            className="ml-auto text-xs border border-slate-300 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={onCerrar} className="text-slate-400 hover:text-slate-700 font-bold text-lg leading-none px-1">
            ✕
          </button>
        </div>

        {/* Contenido */}
        {filas.length === 0 ? (
          <div className="p-8 text-sm text-slate-500 text-center">
            No hay filas guardadas para este rango.
            <div className="text-xs text-slate-400 mt-2">
              Puede ser porque se cargó con una versión anterior (que no guardaba las filas) o porque eran datos
              simulados. Pulsa «Eliminar caché» y vuelve a cargar desde Business Central.
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-auto flex-1">
              <table className="text-[11px] min-w-full">
                <thead className="sticky top-0 bg-slate-100">
                  <tr>
                    {columnas.map((c) => (
                      <th key={c} className="px-2 py-1.5 text-left font-semibold text-slate-600 whitespace-nowrap border-b border-slate-200">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((fila, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-blue-50/40">
                      {columnas.map((c) => (
                        <td key={c} className="px-2 py-1 text-slate-700 whitespace-nowrap max-w-[220px] truncate" title={String(fila?.[c] ?? "")}>
                          {String(fila?.[c] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Pie con paginación */}
            <div className="flex items-center gap-2 px-5 py-2.5 border-t border-slate-200 text-xs text-slate-600">
              <span>
                {(pagina * POR_PAGINA + 1).toLocaleString()}–{Math.min((pagina + 1) * POR_PAGINA, filtradas.length).toLocaleString()} de {filtradas.length.toLocaleString()}
              </span>
              <button disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}
                className="border border-slate-300 rounded px-2 py-0.5 bg-white disabled:opacity-40 hover:bg-slate-50">◀</button>
              <button disabled={pagina >= totalPaginas - 1} onClick={() => setPagina((p) => p + 1)}
                className="border border-slate-300 rounded px-2 py-0.5 bg-white disabled:opacity-40 hover:bg-slate-50">▶</button>
              <span className="text-slate-400">página {pagina + 1} de {totalPaginas}</span>
              <span className="ml-auto text-slate-400">{columnas.length} columnas</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// PANTALLA OTs (VENTANA NUEVA, #/ots) — tabla completa con filtros al
// estilo del gestor de órdenes de trabajo
// =====================================================================

// ---------------------------------------------------------------------
// CONSULTA DE FACTURACIÓN POR CORREO — destinatarios por departamento
// ---------------------------------------------------------------------
function departamentoDeFicha(f) {
  // Primero el prefijo del segmento (MAN-P → MAN); si no, el departamento
  const seg = (f.general.segmento || "").split("-")[0].trim().toUpperCase();
  if (EMAILS_DEPARTAMENTO[seg]) return seg;
  const dep = (f.general.departamento || "").trim().toUpperCase();
  return EMAILS_DEPARTAMENTO[dep] ? dep : null;
}

function mailtoFacturacion(f) {
  const dep = departamentoDeFicha(f);
  const para = (dep ? EMAILS_DEPARTAMENTO[dep] : ["edith.galvez@alsocasals.com"]).join(";");
  const num = (f.numeroOT || "").toString().padStart(6, "0");
  const cliente = f.general.cliente || "";
  const descripcion = f.general.descripcion || "";
  const asunto = `Confirmació facturació OT ${num} — ${cliente}`;
  const cuerpo =
    `Bon dia,\r\n\r\n` +
    `Ens podríeu confirmar si podem procedir a la facturació de la següent OT ${num} de ${cliente} o, en cas contrari, quina previsió hi ha per acabar aquestes feines?\r\n\r\n` +
    `Client: ${cliente}\r\n` +
    `Nº OT: ${num}\r\n` +
    `Descripció: ${descripcion}\r\n\r\n` +
    `Quedem a l'espera de la vostra confirmació per poder gestionar la facturació.`;
  return `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}

/** Destinataris i assumpte del correu de revisió de material. */
function destinatariosRevisio(f) {
  const dep = departamentoDeFicha(f);
  const para = (dep ? EMAILS_DEPARTAMENTO[dep] : ["edith.galvez@alsocasals.com"]).join(";");
  const num = (f.numeroOT || "").toString().padStart(6, "0");
  const asunto = `Revisió material OT ${num} — ${f.general.cliente || ""}`;
  return { para, asunto, num };
}

/** Versió VISUAL del correu (taula amb colors, com la maqueta de Maria).
 *  Es copia al porta-retalls en format HTML perquè es pugui enganxar
 *  (Ctrl+V) al cos del correu d'Outlook conservant el format. Tot amb
 *  estils inline perquè els clients de correu els respectin. */
function construirHtmlRevisio(f, dif) {
  const { num } = destinatariosRevisio(f);
  const cliente = f.general.cliente || "";
  const descripcion = f.general.descripcion || "";
  const hoy = new Date().toLocaleDateString("es-ES");
  const E = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const ESTILOS = {
    falta_cobrar: { label: "FALTA COBRAR", color: "#b42318", bg: "#fee4e2", borde: "#fda29b", interpretacion: "S'ha comprat material però no consta venut/facturat.", accion: "Confirmar si s'ha de facturar al client." },
    sin_coste: { label: "SIN COSTE (magatzem/taller)", color: "#c2410c", bg: "#ffedd5", borde: "#fdba74", interpretacion: "Hi ha venda o imputació, però no compra associada.", accion: "Confirmar si s'ha agafat del taller o magatzem." },
    cantidad_distinta: { label: "CANTIDADES ≠", color: "#b45309", bg: "#fef3c7", borde: "#fcd34d", interpretacion: "Comprat i venut amb quantitats diferents.", accion: "Revisar les quantitats." },
    codigo_distinto: { label: "MISMO ARTÍCULO, CÓDIGO ≠?", color: "#6d28d9", bg: "#ede9fe", borde: "#c4b5fd", interpretacion: "Possible mateix article amb referència diferent.", accion: "Revisar les referències." },
    ok: { label: "OK", color: "#15803d", bg: "#dcfce7", borde: "#86efac", interpretacion: "Material correctament comprat i venut.", accion: "Sense acció." },
  };
  const eurTxt = (v) => (Number(v) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

  const filas = (dif.items || [])
    .map((it) => {
      const s = ESTILOS[it.estado] || ESTILOS.ok;
      return `<tr>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;border-left:4px solid ${s.color};"><span style="display:inline-block;padding:5px 9px;border-radius:7px;font-size:12px;font-weight:700;background:${s.bg};color:${s.color};border:1px solid ${s.borde};white-space:nowrap;">${s.label}</span></td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-family:Consolas,monospace;font-size:12px;">${E(it.codigo) || "—"}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:13px;">${E(it.descripcion)}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:13px;text-align:center;white-space:nowrap;">${it.udsCompradas || 0}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:13px;text-align:center;white-space:nowrap;">${it.udsVendidas || 0}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:13px;font-weight:700;color:${it.estado === "falta_cobrar" ? s.color : "#1f2937"};white-space:nowrap;">${eurTxt(it.costeCompra)}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:13px;font-weight:700;color:${it.estado === "sin_coste" || it.estado === "ok" ? s.color : "#1f2937"};white-space:nowrap;">${eurTxt(it.importeVenta)}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:12px;color:#475467;">${s.interpretacion}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;font-size:12px;font-weight:700;color:${s.color};">${s.accion}</td>
        <td style="padding:10px;border-bottom:1px solid #edf0f2;"><span style="display:inline-block;min-width:110px;border:1px dashed #cbd5e1;border-radius:6px;padding:8px;color:#94a3b8;font-size:12px;">Escriu aquí...</span></td>
      </tr>`;
    })
    .join("");

  const tarjeta = (color, bg, borde, titulo, sub, importe, extra) =>
    `<td style="padding:0 6px;"><table cellpadding="0" cellspacing="0" style="width:100%;background:${bg};border:1px solid ${borde};border-radius:10px;"><tr><td style="padding:12px 14px;">
      <div style="font-size:13px;font-weight:800;color:${color};">${titulo}</div>
      <div style="font-size:12px;color:#475467;margin:2px 0 6px 0;">${sub}</div>
      <div style="font-size:22px;font-weight:800;color:${color};">${importe}</div>
      <div style="font-size:11px;color:#475467;margin-top:4px;">${extra}</div>
    </td></tr></table></td>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:1100px;">
    <p style="font-size:14px;">Bon dia,</p>
    <p style="font-size:14px;">Ens podríeu confirmar si podem procedir a la facturació de la següent ordre de treball o, en cas contrari, indicar-nos quina previsió hi ha per finalitzar els treballs pendents?</p>
    <p style="font-size:14px;margin:0 0 14px 0;">Client: <b>${E(cliente)}</b><br/>Núm. OT: <b>${num}</b><br/>Descripció: <b>${E(descripcion)}</b></p>
    <h2 style="font-size:20px;margin:0 0 2px 0;color:#0f2740;">Revisió de material – OT ${num}</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 12px 0;">Resum de diferències entre comprat i venut · Data revisió: ${hoy}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px;"><tr>
      ${dif.costeNoFacturado > 0 ? tarjeta("#b42318", "#fff1f2", "#fecdca", "FALTA COBRAR", "Comprat sense facturar", eurTxt(dif.costeNoFacturado), `${dif.nFaltaCobrar} article/s — revisar si s'ha de cobrar al client`) : ""}
      ${dif.ventaSinCoste > 0 ? tarjeta("#c2410c", "#fff7ed", "#fed7aa", "SIN COSTE (magatzem/taller)", "Venut sense compra associada", eurTxt(dif.ventaSinCoste), `${dif.nSinCoste} article/s — confirmar si s'ha agafat del taller o magatzem`) : ""}
      ${tarjeta("#15803d", "#ecfdf3", "#abefc6", "OK", "Material correcte", `${(dif.items || []).filter((i) => i.estado === "ok").length} article/s`, "Sense acció")}
    </tr></table>
    <table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #d9e1e7;border-radius:8px;border-collapse:collapse;">
      <thead><tr>
        ${["Estat", "Codi", "Descripció", "U. compra", "U. venda", "Compra", "Venda", "Interpretació", "Acció requerida", "Resposta encarregat"].map((h) => `<th style="background:#f9fafb;color:#374151;text-align:left;font-size:12px;font-weight:700;padding:10px;border-bottom:1px solid #e5e7eb;">${h}</th>`).join("")}
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="font-size:13px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-top:12px;color:#475467;"><b style="color:#111827;">Indicacions per als encarregats:</b> si us plau, reviseu les línies marcades com a <b>FALTA COBRAR</b> i <b>SIN COSTE</b> i indiqueu la vostra resposta per poder tancar correctament la facturació.</p>
    <p style="font-size:14px;">Quedem pendents de la vostra confirmació per poder gestionar-ne la facturació.<br/>Gràcies.</p>
  </div>`;
}

/** Correu de REVISIÓ DE MATERIAL d'una OT (Diferències comprat ↔ venut):
 *  redacció aprovada per Maria + detall del material amb diferències
 *  negatives (comprat i no venut) i positives (venut i no comprat).
 *  Versió TEXT PLA: respaldo si el porta-retalls HTML no està disponible. */
function mailtoDiferencias(f, dif) {
  const dep = departamentoDeFicha(f);
  const para = (dep ? EMAILS_DEPARTAMENTO[dep] : ["edith.galvez@alsocasals.com"]).join(";");
  const num = (f.numeroOT || "").toString().padStart(6, "0");
  const cliente = f.general.cliente || "";
  const descripcion = f.general.descripcion || "";

  const faltaCobrar = (dif.items || []).filter((it) => it.estado === "falta_cobrar");
  const sinCoste = (dif.items || []).filter((it) => it.estado === "sin_coste");

  let cuerpo =
    `Bon dia,\r\n\r\n` +
    `Ens podríeu confirmar si podem procedir a la facturació de la següent ordre de treball o, en cas contrari, indicar-nos quina previsió hi ha per finalitzar els treballs pendents?\r\n\r\n` +
    `Client: ${cliente}\r\n` +
    `Núm. OT: ${num}\r\n` +
    `Descripció: ${descripcion}\r\n\r\n` +
    `A més tenim materials amb diferències negatives (s'ha comprat, però no s'ha venut) i diferències positives (s'ha venut, i no s'ha comprat — s'ha agafat del taller?):\r\n`;

  if (faltaCobrar.length > 0) {
    cuerpo += `\r\nFALTA COBRAR — comprat sense facturar (${eur(dif.costeNoFacturado)}):\r\n`;
    for (const it of faltaCobrar) {
      cuerpo += `  · ${it.codigo || "—"} · ${it.descripcion} · compra ${it.udsCompradas || 0} ud (${eur(it.costeCompra)}) · venda ${it.udsVendidas || 0} ud (${eur(it.importeVenta)}) → Confirmar si s'ha de facturar al client.\r\n`;
    }
  }

  if (sinCoste.length > 0) {
    cuerpo += `\r\nSIN COSTE (magatzem/taller) — venut sense compra associada (${eur(dif.ventaSinCoste)}):\r\n`;
    for (const it of sinCoste) {
      cuerpo += `  · ${it.codigo || "—"} · ${it.descripcion} · compra ${it.udsCompradas || 0} ud (${eur(it.costeCompra)}) · venda ${it.udsVendidas || 0} ud (${eur(it.importeVenta)}) → Confirmar si s'ha agafat del taller o magatzem.\r\n`;
    }
  }

  cuerpo += `\r\nQuedem pendents de la vostra confirmació per poder gestionar-ne la facturació.\r\nGràcies.`;

  const asunto = `Revisió material OT ${num} — ${cliente}`;
  return `mailto:${para}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}

const COLOR_ESTADO_APP = {
  FACTURAT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ENTREGAT: "bg-teal-50 text-teal-700 border-teal-200",
  ACCEPTAT: "bg-sky-50 text-sky-700 border-sky-200",
  PROCES: "bg-blue-50 text-blue-700 border-blue-200",
  PENDENT: "bg-amber-50 text-amber-700 border-amber-300",
  GARANTIA: "bg-purple-50 text-purple-700 border-purple-200",
  ARCHIVADA: "bg-slate-100 text-slate-500 border-slate-200",
  "NO ACEPTAD": "bg-red-50 text-red-600 border-red-200",
};

// =====================================================================
// PEDIDOS DE VENTA PENDIENTES DE FACTURAR
// No depende de "Pedidos de Venta"/"Líneas de Pedido de Venta" de BC
// (ese cruce por Nº de documento daba problemas). En vez de eso reusa
// la MISMA memoria de OTs que ya funciona en Explorador de OTs:
//   · Gasto asociado = materiales (compras reales) + mano de obra a coste
//   · Estat App = campo Motivo_cancelación_PR, coloreado igual que allí
// Se listan las OTs con Gasto asociado > 0,01 € y Estat App ≠ FACTURAT.
// =====================================================================
function gastoAsociadoDeFicha(f) {
  const materiales = Number(f.compra?.costeRealOT) || 0;
  const mo = (Number(f.venta?.horas?.cantidad) || 0) * 21.5;
  return materiales + mo;
}

// Réplica EXACTA de la fórmula de "Resultado" del detalle de OT
// (Explorador de OTs → abrir OT), en su variante SIN líneas BC cargadas
// en vivo (la única viable para calcular esto en bloque sobre muchas
// OTs a la vez): Ingresos − (materiales − comprado no vendido) −
// material de taller − mano de obra a coste, menos Estructura (22%).
// Los Ingresos, en esta pantalla, salen de la cuenta contable 70000000
// (ficha.venta.importeCuentaVentas) — el importe REAL contabilizado por
// OT, más fiable que sumar líneas de venta/facturas.
function analisisResultadoFicha(ficha, fichas) {
  const TARIFA_COSTE_MO = 21.5;
  const PCT_ESTRUCTURA = 0.22;
  const ingresos = Number(ficha.venta.importeCuentaVentas) || 0;
  const horas = Number(ficha.venta.horas?.cantidad) || 0;
  const manoObra = horas * TARIFA_COSTE_MO;

  const ventaMaterial = ficha.venta.materiales?.lineas || [];
  const compraRealBase = ficha.compra.comprasReales?.lineas || [];
  const vistas = new Set();
  const compraReal = compraRealBase.filter((l) => {
    const k = [l.numeroDocumento ?? l["Nº documento"], l.numero ?? l["Nº"], l.cantidad ?? l["Cantidad"], l.importe ?? l["Importe línea"]].join("|");
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
  const materiales = compraReal.reduce((a, l) => a + (Number(l.importe ?? l["Importe línea"]) || 0), 0);

  const dif = compararMaterialOT(ventaMaterial, compraReal);
  const compradoNoVendido = Number(dif.costeNoFacturado) || 0;
  const costeTaller = (dif.items || [])
    .filter((it) => it.estado === "sin_coste")
    .reduce((acc, it) => {
      const uds = Number(it.udsVendidas) || 0;
      const pvUnit = uds > 0 ? (Number(it.importeVenta) || 0) / uds : 0;
      const compras = historialCompraArticulo(it.codigo, it.descripcion, fichas).filter((c) => c.costeUnitario > 0);
      const unit = compras.length ? compras[0].costeUnitario : pvUnit / 1.75;
      return acc + unit * uds;
    }, 0);

  const estructura = ingresos * PCT_ESTRUCTURA;
  const margenBruto = ingresos - (materiales - compradoNoVendido) - costeTaller - manoObra;
  const resultado = margenBruto - estructura;
  const pct = ingresos > 0 ? Math.round((resultado / ingresos) * 100) : null;
  return { ingresos, resultado, pct };
}

const ESTADOS_EXCLUIDOS_PENDIENTES = ["FACTURAT", "ARCHIVADA", "GARANTIA"];

function PedidosVentaPendientes() {
  const [fichas, setFichas] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [fCliente, setFCliente] = useState("");
  const [fDepartament, setFDepartament] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/estado");
        if (!r.ok) throw new Error(`backend ${r.status}`);
        const est = await r.json();
        if (est.fichas?.length) setFichas(new Map(est.fichas));
        else setError("Aún no hay memoria construida. Ve a «Cargar datos», carga las fuentes y pulsa «Construir memoria histórica».");
      } catch (err) {
        setError(`No se pudo cargar la memoria (${err.message}). ¿Está el backend arrancado (npm start)?`);
      }
      setCargando(false);
    })();
  }, []);

  const pendientes = useMemo(() => {
    if (!fichas) return [];
    const qC = fCliente.trim().toLowerCase();
    let arr = [...fichas.values()]
      .map((f) => ({ f, gasto: gastoAsociadoDeFicha(f) }))
      .filter(({ f, gasto }) => gasto > 0.01 && !ESTADOS_EXCLUIDOS_PENDIENTES.includes(f.general.estadoApp))
      .filter(({ f }) => !(f.general.cliente || "").toUpperCase().includes("TALLER"));
    if (qC) arr = arr.filter(({ f }) => (f.general.cliente || "").toLowerCase().includes(qC));
    if (fDepartament) arr = arr.filter(({ f }) => f.general.departamento === fDepartament);
    arr.sort((a, b) => b.gasto - a.gasto);
    // El análisis Ingresos/Resultado solo se calcula para las filas
    // visibles tras filtrar (más caro: recorre historial de compra por
    // artículo de taller), no para las 11k+ fichas antes de filtrar.
    return arr.map(({ f, gasto }) => ({ f, gasto, ...analisisResultadoFicha(f, fichas) }));
  }, [fichas, fCliente, fDepartament]);

  const departaments = useMemo(() => {
    if (!fichas) return [];
    const dep = new Set();
    for (const f of fichas.values()) if (f.general.departamento) dep.add(f.general.departamento);
    return [...dep].sort();
  }, [fichas]);

  const totalPendiente = pendientes.reduce((acc, { gasto }) => acc + gasto, 0);

  if (cargando) return <div className="text-sm text-slate-500 p-4">Cargando memoria histórica…</div>;
  if (error) return <div className="text-sm text-amber-700 bg-amber-50 border border-amber-300 rounded-lg p-3">{error}</div>;

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-800 mb-1">Pedidos de venta pendientes de facturar</h1>
      <p className="text-sm text-slate-500 mb-4">
        OTs con Gasto asociado (materiales + mano de obra a coste) por encima de 0,01 € y cuyo Estat App no sea <strong>FACTURAT</strong>, <strong>ARCHIVADA</strong> ni <strong>GARANTIA</strong>.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={fCliente}
          onChange={(e) => setFCliente(e.target.value)}
          placeholder="Filtrar cliente..."
          className="border border-slate-300 rounded-md px-3 py-1.5 text-sm w-56"
        />
        <select
          value={fDepartament}
          onChange={(e) => setFDepartament(e.target.value)}
          className="border border-slate-300 rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">Departaments...</option>
          {departaments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        {(fCliente || fDepartament) && (
          <button
            onClick={() => { setFCliente(""); setFDepartament(""); }}
            className="text-sm text-slate-500 border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50"
          >
            Restablir
          </button>
        )}
        <span className="ml-auto text-sm text-slate-600">
          {pendientes.length.toLocaleString()} OT(s) · <strong>{eur(totalPendiente)}</strong> pendientes de facturar
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-100 text-slate-600 text-left">
              <th className="px-3 py-2 font-semibold">OT</th>
              <th className="px-2 py-2 font-semibold">Estat App</th>
              <th className="px-2 py-2 font-semibold">Client</th>
              <th className="px-2 py-2 font-semibold w-[40%]">Descripció</th>
              <th className="px-2 py-2 font-semibold">Departamento</th>
              <th className="px-2 py-2 font-semibold text-right" title="Materiales (compras PC) + mano de obra a coste 21,50 €/h">Gasto asociado</th>
              <th className="px-2 py-2 font-semibold text-right" title="Suma de la cuenta contable 70000000 (Ventas) para esta OT, según Movs. Contabilidad (detalle OT)">Ingresos</th>
              <th className="px-2 py-2 font-semibold text-right" title="Resultado = margen bruto − estructura (22% de la venta), igual que en el detalle de la OT">Margen</th>
              <th className="px-2 py-2 font-semibold text-center">✉</th>
            </tr>
          </thead>
          <tbody>
            {pendientes.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No hay OTs pendientes de facturar con estos filtros.
                </td>
              </tr>
            )}
            {pendientes.map(({ f, gasto, ingresos, resultado, pct }) => (
              <tr key={f.numeroOT} className="border-t border-slate-100 hover:bg-purple-50/50">
                <td className="px-3 py-1.5 font-bold text-slate-800 whitespace-nowrap">{f.numeroOTOrigenes?.listado || f.numeroOT}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {f.general.estadoApp && (
                    <span className={`text-[10px] font-bold rounded border px-1.5 py-0.5 ${COLOR_ESTADO_APP[f.general.estadoApp] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                      {f.general.estadoApp}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-slate-600 max-w-[200px] truncate">{f.general.cliente}</td>
                <td className="px-2 py-1.5 text-slate-700 max-w-lg truncate" title={f.general.descripcion}>{f.general.descripcion || "—"}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {f.general.segmento && <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">{f.general.segmento}</span>}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-slate-700">{eur(gasto)}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap text-blue-700">{eur(ingresos)}</td>
                <td className={`px-2 py-1.5 text-right whitespace-nowrap font-semibold ${resultado < 0 ? "text-red-600" : "text-emerald-600"}`}>
                  {eur(resultado)}{pct != null && <span className="text-[10px] font-normal ml-1">({pct}%)</span>}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <a
                    href={mailtoFacturacion(f)}
                    title={`Preguntar al responsable (${departamentoDeFicha(f) || "sin dpto. — Edith"}) si se puede facturar esta OT`}
                    className="inline-flex items-center justify-center text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded p-1"
                  >
                    <Mail size={14} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PantallaOTs({ incrustada = false }) {
  const [fichas, setFichas] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [seleccionada, setSeleccionada] = useState(null);

  // Filtros
  const [fCliente, setFCliente] = useState("");
  const [fTexto, setFTexto] = useState("");
  const [fDepartament, setFDepartament] = useState("");
  const [fEstat, setFEstat] = useState("");
  const [fTipus, setFTipus] = useState("");
  const [pagina, setPagina] = useState(0);
  const POR_PAGINA = 100;

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/estado");
        if (!r.ok) throw new Error(`backend ${r.status}`);
        const est = await r.json();
        if (est.fichas?.length) setFichas(new Map(est.fichas));
        else setError("Aún no hay memoria construida. Ve a la pantalla principal, carga los datos y pulsa «Construir memoria histórica».");
      } catch (err) {
        setError(`No se pudo cargar la memoria (${err.message}). ¿Está el backend arrancado (npm start)?`);
      }
      setCargando(false);
    })();
  }, []);

  const opciones = useMemo(() => {
    if (!fichas) return { departaments: [], estats: [], tipus: [] };
    const dep = new Set(), est = new Set(), tip = new Set();
    for (const f of fichas.values()) {
      if (f.general.departamento) dep.add(f.general.departamento);
      if (f.general.estadoApp) est.add(f.general.estadoApp);
      if (f.general.tipoTrabajo) tip.add(f.general.tipoTrabajo);
    }
    return { departaments: [...dep].sort(), estats: [...est].sort(), tipus: [...tip].sort() };
  }, [fichas]);

  const filtradas = useMemo(() => {
    if (!fichas) return [];
    const qC = fCliente.trim().toLowerCase();
    const qT = fTexto.trim().toLowerCase();
    let arr = [...fichas.values()];
    if (qC) arr = arr.filter((f) => (f.general.cliente || "").toLowerCase().includes(qC));
    if (qT)
      arr = arr.filter(
        (f) => f.numeroOT.toLowerCase().includes(qT) || (f.general.descripcion || "").toLowerCase().includes(qT)
      );
    if (fDepartament) arr = arr.filter((f) => f.general.departamento === fDepartament);
    if (fEstat) arr = arr.filter((f) => f.general.estadoApp === fEstat);
    if (fTipus) arr = arr.filter((f) => f.general.tipoTrabajo === fTipus);
    arr.sort((a, b) => (parseInt(b.numeroOT) || 0) - (parseInt(a.numeroOT) || 0));
    return arr;
  }, [fichas, fCliente, fTexto, fDepartament, fEstat, fTipus]);

  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA));
  const visibles = filtradas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);

  if (seleccionada && fichas) {
    const ficha = fichas.get(seleccionada);
    if (ficha) {
      const detalle = <DetalleOT ficha={ficha} fichas={fichas} onVolver={() => setSeleccionada(null)} />;
      return incrustada ? (
        detalle
      ) : (
        <div className="min-h-screen bg-slate-100 p-6">
          <div className="max-w-6xl mx-auto">{detalle}</div>
        </div>
      );
    }
  }

  return (
    <div className={incrustada ? "" : "min-h-screen bg-slate-100 p-6"}>
      <div className={incrustada ? "" : "max-w-[1400px] mx-auto"}>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-xl font-bold text-slate-800">Explorador de OTs</h1>
          {fichas && <span className="text-sm text-slate-500">{filtradas.length.toLocaleString()} de {fichas.size.toLocaleString()} OTs</span>}
          {incrustada ? (
            <button
              onClick={() => window.open(window.location.pathname + "#/ots", "_blank")}
              className="ml-auto text-[11px] text-slate-400 hover:text-slate-600"
              title="Abrir en pestaña nueva (pantalla completa)"
            >
              abrir en pestaña nueva ↗
            </button>
          ) : (
            <span className="ml-auto text-[11px] text-slate-400">ALSO CASALS · Agente de Ventas</span>
          )}
        </div>

        {cargando && <div className="text-sm text-slate-500">Cargando memoria...</div>}
        {error && <div className="text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-md px-4 py-3">{error}</div>}

        {fichas && (
          <>
            {/* Filtros */}
            <div className="flex gap-2 mb-3 flex-wrap">
              <input value={fCliente} onChange={(e) => { setFCliente(e.target.value); setPagina(0); }} placeholder="Filtrar client.."
                className="text-sm border border-slate-300 rounded-md px-3 py-1.5 w-52 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500" />
              <input value={fTexto} onChange={(e) => { setFTexto(e.target.value); setPagina(0); }} placeholder="Filtrar OT / descripció.."
                className="text-sm border border-slate-300 rounded-md px-3 py-1.5 w-64 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500" />
              <select value={fDepartament} onChange={(e) => { setFDepartament(e.target.value); setPagina(0); }}
                className="text-sm border border-slate-300 rounded-md px-2 py-1.5 bg-white">
                <option value="">Departaments...</option>
                {opciones.departaments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={fEstat} onChange={(e) => { setFEstat(e.target.value); setPagina(0); }}
                className="text-sm border border-slate-300 rounded-md px-2 py-1.5 bg-white">
                <option value="">Estat App...</option>
                {opciones.estats.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={fTipus} onChange={(e) => { setFTipus(e.target.value); setPagina(0); }}
                className="text-sm border border-slate-300 rounded-md px-2 py-1.5 bg-white">
                <option value="">Tipus de feina...</option>
                {opciones.tipus.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {(fCliente || fTexto || fDepartament || fEstat || fTipus) && (
                <button onClick={() => { setFCliente(""); setFTexto(""); setFDepartament(""); setFEstat(""); setFTipus(""); setPagina(0); }}
                  className="text-sm text-slate-500 border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50">
                  Restablir
                </button>
              )}
            </div>

            {/* Tabla */}
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 text-left">
                    <th className="px-3 py-2 font-semibold">OT</th>
                    <th className="px-2 py-2 font-semibold">Estat App</th>
                    <th className="px-2 py-2 font-semibold">Client</th>
                    <th className="px-2 py-2 font-semibold w-[40%]">Descripció</th>
                    <th className="px-2 py-2 font-semibold">Departamento</th>
                    <th className="px-2 py-2 font-semibold text-right" title="Materiales (compras PC) + mano de obra a coste 21,50 €/h">Gasto asociado</th>
                    <th className="px-2 py-2 font-semibold text-center">✉</th>
                    <th className="px-2 py-2 font-semibold text-center">Ver Datos</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((f) => (
                    <tr key={f.numeroOT} onClick={() => setSeleccionada(f.numeroOT)}
                      className="border-t border-slate-100 hover:bg-purple-50/50 cursor-pointer">
                      <td className="px-3 py-1.5 font-bold text-slate-800 whitespace-nowrap">{f.numeroOTOrigenes?.listado || f.numeroOT}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {f.general.estadoApp && (
                          <span className={`text-[10px] font-bold rounded border px-1.5 py-0.5 ${COLOR_ESTADO_APP[f.general.estadoApp] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                            {f.general.estadoApp}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-slate-600 max-w-[200px] truncate">{f.general.cliente}</td>
                      <td className="px-2 py-1.5 text-slate-700 max-w-lg truncate" title={f.general.descripcion}>{f.general.descripcion || "—"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {f.general.segmento && <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">{f.general.segmento}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-slate-700">
                        {(() => {
                          // Gasto asociado = materiales (compras reales PC)
                          // + mano de obra a coste (horas × 21,50 €/h)
                          const materiales = Number(f.compra?.costeRealOT) || 0;
                          const mo = (Number(f.venta?.horas?.cantidad) || 0) * 21.5;
                          const gasto = materiales + mo;
                          return gasto > 0 ? eur(gasto) : <span className="text-slate-300 font-normal">—</span>;
                        })()}
                      </td>
                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <a
                          href={mailtoFacturacion(f)}
                          title={`Preguntar al responsable (${departamentoDeFicha(f) || "sin dpto. — Edith"}) si se puede facturar esta OT`}
                          className="inline-flex items-center justify-center text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded p-1"
                        >
                          <Mail size={14} />
                        </a>
                      </td>
                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setSeleccionada(f.numeroOT)}
                          title="Ver todos los datos de esta OT"
                          className="text-[11px] font-semibold text-purple-600 hover:text-purple-800 hover:bg-purple-50 rounded px-2 py-1 border border-purple-200"
                        >
                          Ver Datos
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginación */}
            <div className="flex items-center gap-2 mt-3 text-xs text-slate-600">
              <span>{(pagina * POR_PAGINA + 1).toLocaleString()}–{Math.min((pagina + 1) * POR_PAGINA, filtradas.length).toLocaleString()} de {filtradas.length.toLocaleString()}</span>
              <button disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}
                className="border border-slate-300 rounded px-2 py-1 bg-white disabled:opacity-40 hover:bg-slate-50">◀</button>
              <button disabled={pagina >= totalPaginas - 1} onClick={() => setPagina((p) => p + 1)}
                className="border border-slate-300 rounded px-2 py-1 bg-white disabled:opacity-40 hover:bg-slate-50">▶</button>
              <span className="text-slate-400">página {pagina + 1} de {totalPaginas}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// EXPLORADOR DE OTs — listado con buscador y detalle con material
// propuesto / pedido / vendido y diferencias (control de margen)
// =====================================================================
function ExplorarOTs({ fichas }) {
  const [busqueda, setBusqueda] = useState("");
  const [seleccionada, setSeleccionada] = useState(null);

  const lista = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    let arr = [...fichas.values()];
    if (q) {
      arr = arr.filter(
        (f) =>
          f.numeroOT.toLowerCase().includes(q) ||
          (f.general.cliente || "").toLowerCase().includes(q) ||
          (f.general.descripcion || "").toLowerCase().includes(q)
      );
    }
    // más recientes primero (número de OT descendente)
    arr.sort((a, b) => (parseInt(b.numeroOT) || 0) - (parseInt(a.numeroOT) || 0));
    return arr.slice(0, 50);
  }, [fichas, busqueda]);

  if (seleccionada) {
    const ficha = fichas.get(seleccionada);
    if (ficha) return <DetalleOT ficha={ficha} fichas={fichas} onVolver={() => setSeleccionada(null)} />;
  }

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <input
        type="text"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Buscar por Nº de OT, cliente o descripción..."
        className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-purple-500"
      />
      <div className="flex flex-col gap-1 max-h-96 overflow-y-auto">
        {lista.map((f) => (
          <button
            key={f.numeroOT}
            onClick={() => setSeleccionada(f.numeroOT)}
            className="flex items-center gap-2 text-left text-xs bg-white border border-slate-200 rounded-md px-3 py-2 hover:border-purple-400 hover:bg-purple-50/40 transition-colors"
          >
            <span className="font-bold text-slate-800 whitespace-nowrap">OT {f.numeroOT}</span>
            {f.general.segmento && (
              <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                {f.general.segmento}
              </span>
            )}
            <span className="text-slate-500 whitespace-nowrap max-w-[180px] truncate">{f.general.cliente}</span>
            <span className="text-slate-600 truncate flex-1">{f.general.descripcion || "(sin descripción)"}</span>
            {f.venta.importeTotalFacturado > 0 && (
              <span className="font-semibold text-slate-700 whitespace-nowrap">{eur(f.venta.importeTotalFacturado)}</span>
            )}
          </button>
        ))}
        {lista.length === 0 && <div className="text-xs text-slate-400 text-center py-4">Sin resultados</div>}
      </div>
      <div className="text-[10px] text-slate-400 mt-2">Mostrando {lista.length} OTs (máx. 50 — afina la búsqueda)</div>
    </div>
  );
}

function DetalleOT({ ficha, fichas, onVolver }) {
  const [lineasBC, setLineasBC] = useState(null); // {venta, compra} desde BC bajo demanda
  const [cargandoBC, setCargandoBC] = useState(false);
  const [avisoBC, setAvisoBC] = useState(null);
  const [tabDetalle, setTabDetalle] = useState("material"); // material | factura | partes
  const [uds, setUds] = useState({}); // unidades editables del material propuesto
  const [bloqueados, setBloqueados] = useState([]); // [{tipoTrabajo, clave, descripcion, fecha}]
  const [historial, setHistorial] = useState(null); // {tipo:'compra'|'venta', codigo, descripcion}
  const [avisoCorreo, setAvisoCorreo] = useState(null); // avís "taula copiada" del correu de revisió

  const noBC =
    ficha.numeroOTOrigenes?.listado || ficha.numeroOTOrigenes?.lineasVenta || ficha.numeroOTOrigenes?.lineasCompra || ficha.numeroOT;

  // Artículos que la usuaria ha marcado como "no está bien" para este
  // tipo de trabajo. Se guardan en el navegador (localStorage), NO en
  // /api/estado — ese fichero pesa ~130 MB (toda la memoria de OTs) y
  // volver a pedirlo cada vez que se abre una OT colgaba la aplicación.
  const LS_KEY = "agente_ventas_material_bloqueado_v1";
  useEffect(() => {
    try {
      const guardado = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
      setBloqueados(Array.isArray(guardado) ? guardado : []);
    } catch {
      setBloqueados([]);
    }
  }, []);

  const tipoTrabajoNorm = (ficha.general.tipoTrabajo || "").toString().trim().toLowerCase();

  const guardarBloqueados = (nuevaLista) => {
    setBloqueados(nuevaLista);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(nuevaLista));
    } catch {
      /* si falla el guardado (p.ej. localStorage lleno), se queda solo en memoria de esta sesión */
    }
  };

  const marcarComoMalo = (articulo) => {
    const clave = articulo.codigo || (articulo.descripcion || "").toString().trim().toLowerCase();
    const yaEsta = bloqueados.some((b) => b.tipoTrabajo === tipoTrabajoNorm && b.clave === clave);
    if (yaEsta) return;
    const nuevaLista = [
      ...bloqueados,
      { tipoTrabajo: tipoTrabajoNorm, clave, descripcion: articulo.descripcion, fecha: new Date().toISOString() },
    ];
    guardarBloqueados(nuevaLista);
  };

  // MATERIALES PROPUESTOS A MANO por Maria — aprendizaje inverso al
  // bloqueo: se proponen SIEMPRE para este tipo de trabajo. Guardados en
  // el navegador (localStorage), como los bloqueados.
  const LS_KEY_MANUAL = "agente_ventas_material_propuesto_manual_v1";
  const [manuales, setManuales] = useState([]);
  const [buscadorAbierto, setBuscadorAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  useEffect(() => {
    try {
      const g = JSON.parse(localStorage.getItem(LS_KEY_MANUAL) || "[]");
      setManuales(Array.isArray(g) ? g : []);
    } catch {
      setManuales([]);
    }
  }, []);
  const guardarManuales = (lista) => {
    setManuales(lista);
    try { localStorage.setItem(LS_KEY_MANUAL, JSON.stringify(lista)); } catch {}
  };
  const proponerManual = (articulo) => {
    const clave = articulo.codigo || (articulo.descripcion || "").toString().trim().toLowerCase();
    if (manuales.some((m) => m.tipoTrabajo === tipoTrabajoNorm && m.clave === clave)) return;
    guardarManuales([
      ...manuales,
      { tipoTrabajo: tipoTrabajoNorm, clave, codigo: articulo.codigo || "", descripcion: articulo.descripcion || "", fecha: new Date().toISOString() },
    ]);
    // Si estaba bloqueado para este tipo de trabajo, proponerlo lo desbloquea
    if (bloqueados.some((b) => b.tipoTrabajo === tipoTrabajoNorm && b.clave === clave)) {
      guardarBloqueados(bloqueados.filter((b) => !(b.tipoTrabajo === tipoTrabajoNorm && b.clave === clave)));
    }
    setBusqueda("");
    setBuscadorAbierto(false);
  };
  const quitarManual = (clave) => {
    guardarManuales(manuales.filter((m) => !(m.tipoTrabajo === tipoTrabajoNorm && m.clave === clave)));
  };

  // Catálogo de artículos conocidos (memoria completa) para el buscador.
  // Se construye solo cuando el buscador está abierto.
  const catalogo = useMemo(() => {
    if (!buscadorAbierto || !fichas) return [];
    const mapa = new Map();
    for (const f of fichas.values()) {
      for (const l of [...(f.compra?.comprasReales?.lineas || []), ...(f.venta?.materiales?.lineas || [])]) {
        const codigo = (l.numero || "").toString().trim();
        const descripcion = (l.descripcion || "").toString().trim();
        const clave = codigo || descripcion.toLowerCase();
        if (clave && !mapa.has(clave)) mapa.set(clave, { codigo, descripcion });
      }
    }
    return [...mapa.values()];
  }, [buscadorAbierto, fichas]);

  const resultadosBusqueda = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (q.length < 2) return [];
    return catalogo
      .filter((a) => a.codigo.toLowerCase().includes(q) || a.descripcion.toLowerCase().includes(q))
      .slice(0, 8);
  }, [busqueda, catalogo]);

  // Material propuesto por OTs similares (referencia + unidades por mediana)
  const propuestoBase = useMemo(() => materialPropuestoParaOT(ficha, fichas), [ficha, fichas]);
  const propuesto = useMemo(() => {
    if (!propuestoBase.articulos) return propuestoBase;
    const articulos = propuestoBase.articulos.filter((a) => {
      const clave = a.codigo || (a.descripcion || "").toString().trim().toLowerCase();
      return !bloqueados.some((b) => b.tipoTrabajo === tipoTrabajoNorm && b.clave === clave);
    });
    // Añadir los propuestos A MANO de este tipo de trabajo (si no están ya)
    const claves = new Set(articulos.map((a) => a.codigo || (a.descripcion || "").toString().trim().toLowerCase()));
    for (const m of manuales.filter((m) => m.tipoTrabajo === tipoTrabajoNorm)) {
      if (claves.has(m.clave)) continue;
      const sug = precioVentaSugerido(m.codigo, m.descripcion, fichas);
      articulos.push({
        codigo: m.codigo,
        descripcion: m.descripcion,
        nOTs: 0,
        pct: null,
        unidadesPropuestas: 1,
        precioMediano: sug?.precio || 0,
        esManual: true,
      });
    }
    return { ...propuestoBase, articulos };
  }, [propuestoBase, bloqueados, manuales, tipoTrabajoNorm, fichas]);

  // Coste de COMPRA (última compra registrada en la memoria para OTs
  // similares) por cada artículo propuesto, + margen frente al precio
  // de venta mediano. Usa historialCompraArticulo, que ya combina
  // lineas_compra + lineas_compra_reg tal como el resto de la ficha.
  const propuestoConCompra = useMemo(() => {
    const articulos = (propuesto.articulos || []).map((a) => {
      const compras = historialCompraArticulo(a.codigo, a.descripcion, fichas).filter((c) => c.costeUnitario > 0);
      const costeCompra = compras.length ? compras[0].costeUnitario : null;
      const nComprasHistorico = compras.length;
      const margen = costeCompra != null && a.precioMediano > 0 ? a.precioMediano - costeCompra : null;
      const margenPct = margen != null && costeCompra > 0 ? margen / costeCompra : null;
      return { ...a, costeCompra, nComprasHistorico, margen, margenPct };
    });
    return { ...propuesto, articulos };
  }, [propuesto, fichas]);

  // Artículos COMPRADOS en OTRAS OTs del MISMO tipo de trabajo, que no
  // salen ya propuestos por venta: material que probablemente se usa en
  // esta faena aunque no siempre se facture aparte al cliente (p.ej.
  // Cloro en OTs de "mantenimiento de piscina"). Se agrupa por Nº de
  // artículo/descripción y se cuenta en cuántas OTs de ese tipo aparece.
  // Artículos COMPRADOS en OTRAS OTs SIMILARES a esta (misma noción de
  // "similar" que ya usa el 👤 / Material propuesto — texto + atributos
  // IA, NO depende de que "Tipus feina" esté rellenado, que suele venir
  // vacío cuando el listado se carga "Desde BC"), que no salen ya
  // propuestos por venta: material que probablemente se usa en esta
  // faena aunque no siempre se facture aparte al cliente (p.ej. Cloro
  // en OTs de mantenimiento de piscina). Se agrupa por Nº de
  // artículo/descripción y se cuenta en cuántas OTs similares aparece.
  const compradosParaEsteTrabajo = useMemo(() => {
    if (!fichas) {
      return { articulos: [], diag: { motivo: "sin_fichas", baseOTsCompra: 0, articulosVistos: 0, excluidosPorVenta: 0, excluidosPorBloqueo: 0 } };
    }
    const similares = otsSimilaresPara(ficha, fichas);
    if (similares.length === 0) {
      return { articulos: [], diag: { motivo: "sin_similares", baseOTsCompra: 0, articulosVistos: 0, excluidosPorVenta: 0, excluidosPorBloqueo: 0 } };
    }
    const yaPropuestos = new Set(
      (propuesto.articulos || []).map((a) => a.codigo || (a.descripcion || "").toString().trim().toLowerCase())
    );
    const baseOTsCompra = similares.length;
    const porArticulo = new Map();
    for (const { ficha: f } of similares) {
      const lineas = f.compra?.comprasReales?.lineas || [];
      const vistosEnEstaOT = new Set();
      for (const l of lineas) {
        const codigo = (l.numero || "").toString().trim();
        const descripcion = (l.descripcion || "").toString().trim();
        const clave = codigo || descripcion.toLowerCase();
        if (!clave) continue;
        if (!porArticulo.has(clave)) porArticulo.set(clave, { codigo, descripcion, ots: new Set(), cantidades: [] });
        const e = porArticulo.get(clave);
        if (!vistosEnEstaOT.has(clave)) {
          e.ots.add(f.numeroOT);
          vistosEnEstaOT.add(clave);
        }
        const cant = Number(l.cantidad) || 0;
        if (cant > 0) e.cantidades.push(cant);
      }
    }
    const articulos = [];
    let excluidosPorVenta = 0;
    let excluidosPorBloqueo = 0;
    for (const [clave, e] of porArticulo.entries()) {
      if (yaPropuestos.has(clave)) { excluidosPorVenta++; continue; } // ya sale propuesto por venta, no duplicar
      if (bloqueados.some((b) => b.tipoTrabajo === tipoTrabajoNorm && b.clave === clave)) { excluidosPorBloqueo++; continue; } // descartado por Maria
      const compras = historialCompraArticulo(e.codigo, e.descripcion, fichas).filter((c) => c.costeUnitario > 0);
      // Solo se propone si aparece en más de 1 OT similar (evita ruido de una compra suelta)
      if (e.ots.size < 2 && baseOTsCompra > 3) continue;
      articulos.push({
        codigo: e.codigo,
        descripcion: e.descripcion,
        nOTs: e.ots.size,
        pct: baseOTsCompra > 0 ? e.ots.size / baseOTsCompra : null,
        unidadesPropuestas: mediana(e.cantidades) || 1,
        precioMediano: 0, // no se ha facturado aparte en OTs similares, no hay precio de venta de referencia
        costeCompra: compras.length ? compras[0].costeUnitario : null,
        nComprasHistorico: compras.length,
        margen: null,
        margenPct: null,
        esComprado: true,
      });
    }
    articulos.sort((a, b) => (b.nOTs || 0) - (a.nOTs || 0));
    return {
      articulos,
      diag: { motivo: null, baseOTsCompra, articulosVistos: porArticulo.size, excluidosPorVenta, excluidosPorBloqueo },
    };
  }, [fichas, ficha, propuesto.articulos, bloqueados, tipoTrabajoNorm]);

  // Lista final que se pinta en la tabla: lo propuesto por venta (con su
  // coste de compra ya calculado) + lo comprado-sin-vender para este
  // mismo tipo de trabajo, marcado con el icono 🛒.
  const propuestoFinal = useMemo(() => {
    return {
      ...propuestoConCompra,
      articulos: [...(propuestoConCompra.articulos || []), ...compradosParaEsteTrabajo.articulos],
    };
  }, [propuestoConCompra, compradosParaEsteTrabajo]);

  const cargarLineasBC = async () => {
    setCargandoBC(true);
    setAvisoBC(null);
    try {
      const r = await fetch(`/api/bc/ot/lineas?no=${encodeURIComponent(noBC)}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Error ${r.status}`);
      }
      const json = await r.json();
      setLineasBC({
        venta: adaptarLineasVentaAPI(json.venta || []),
        compra: adaptarLineasCompraAPI(json.compra || []),
        // Líneas de venta CRUDAS (todas las columnas, todas las líneas,
        // incluidas las de texto): alimentan la vista "Factura" de la OT.
        ventaRaw: json.venta || [],
      });
      if (json.avisos?.length) setAvisoBC(json.avisos.join(" · "));
    } catch (err) {
      setAvisoBC(`No se pudieron cargar las líneas desde BC (${err.message}).`);
    }
    setCargandoBC(false);
  };

  // VENDIDO (material): líneas ya en la ficha (facturas PDF / rangos cargados) + BC bajo demanda
  const ventaMaterial = useMemo(() => {
    const base = [...ficha.venta.materiales.lineas];
    if (lineasBC) base.push(...lineasBC.venta.filter((l) => clasificarLineaVenta(l) === "material"));
    return base;
  }, [ficha, lineasBC]);

  // PEDIDO (compras reales, PC/Order — las ofertas OC no cuentan como pedido).
  // Se DEDUPLICAN las líneas: la misma línea puede llegar dos veces (la
  // de la memoria + la recargada con «Cargar líneas desde BC»).
  const compraReal = useMemo(() => {
    const base = [...ficha.compra.comprasReales.lineas];
    if (lineasBC) base.push(...lineasBC.compra.filter((l) => clasificarLineaCompra(l) === "compra_real"));
    const vistas = new Set();
    return base.filter((l) => {
      const k = [l.numeroDocumento ?? l["Nº documento"], l.numero ?? l["Nº"], l.cantidad ?? l["Cantidad"], l.importe ?? l["Importe línea"]].join("|");
      if (vistas.has(k)) return false;
      vistas.add(k);
      return true;
    });
  }, [ficha, lineasBC]);

  const dif = useMemo(() => compararMaterialOT(ventaMaterial, compraReal), [ventaMaterial, compraReal]);

  // MATERIAL DEL TALLER — regla de Maria (15/07/2026): los artículos
  // VENDIDOS SIN COMPRA asociada (SIN COSTE) se han cogido del taller y
  // deben contar como coste real de la OT. Valoración: ÚLTIMA COMPRA del
  // artículo en la memoria; si no hay ninguna, precio de venta ÷ 1,75.
  const materialTaller = useMemo(() => {
    return (dif.items || [])
      .filter((it) => it.estado === "sin_coste")
      .map((it) => {
        const uds = Number(it.udsVendidas) || 0;
        const pvUnit = uds > 0 ? (Number(it.importeVenta) || 0) / uds : 0;
        const compras = historialCompraArticulo(it.codigo, it.descripcion, fichas).filter((c) => c.costeUnitario > 0);
        const unit = compras.length ? compras[0].costeUnitario : pvUnit / 1.75;
        return {
          numero: it.codigo,
          descripcion: it.descripcion,
          cantidad: uds,
          costeUnitario: unit,
          importe: unit * uds,
          _origenCoste: compras.length ? "última compra" : "venta ÷ 1,75",
        };
      });
  }, [dif, fichas]);
  const costeTaller = materialTaller.reduce((a, l) => a + l.importe, 0);

  const ESTADO_UI = {
    falta_cobrar: { label: "FALTA COBRAR", cls: "text-red-700 bg-red-50 border-red-300" },
    sin_coste: { label: "SIN COSTE (¿almacén?)", cls: "text-orange-700 bg-orange-50 border-orange-300" },
    cantidad_distinta: { label: "CANTIDADES ≠", cls: "text-amber-700 bg-amber-50 border-amber-300" },
    codigo_distinto: { label: "¿MISMO ARTÍCULO, CÓDIGO ≠?", cls: "text-purple-700 bg-purple-50 border-purple-300" },
    ok: { label: "OK", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  };

  const totalPropuesto = (propuestoFinal.articulos || []).reduce((acc, a) => {
    const u = uds[a.codigo || a.descripcion] ?? a.unidadesPropuestas;
    return acc + u * (a.precioMediano || 0);
  }, 0);
  const totalCompraPropuesto = (propuestoFinal.articulos || []).reduce((acc, a) => {
    const u = uds[a.codigo || a.descripcion] ?? a.unidadesPropuestas;
    return acc + u * (a.costeCompra || 0);
  }, 0);

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <button onClick={onVolver} className="text-xs text-purple-700 font-semibold mb-3 hover:underline">
        ← Volver al listado
      </button>

      {/* Resumen de la OT */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-3">
        <div className="flex items-center gap-2 flex-wrap mb-1.5">
          <span className="text-base font-bold text-slate-800">OT {noBC}</span>
          {ficha.general.segmento && (
            <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">
              {ficha.general.segmento}
            </span>
          )}
          {ficha.general.departamento && (
            <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
              {ficha.general.departamento}
            </span>
          )}
          {ficha.general.tipoTrabajo && (
            <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
              {ficha.general.tipoTrabajo}
            </span>
          )}
          <span className="ml-auto text-xs text-slate-500">{ficha.general.cliente}</span>
        </div>
        <p className="text-xs text-slate-600 leading-snug">{ficha.general.descripcion || "(sin descripción)"}</p>
        <div className="flex gap-4 mt-2 text-xs text-slate-600">
          <span>Facturado: <b>{eur(ficha.venta.importeTotalFacturado)}</b></span>
          <span>Coste: <b>{eur(ficha.compra.costeRealOT)}</b></span>
          {ficha.venta.horas.cantidad > 0 && <span>Horas: <b>{ficha.venta.horas.cantidad}</b></span>}
          {ficha.resultado.margenPorcentual != null && (
            <span>Margen: <b>{Math.round(ficha.resultado.margenPorcentual * 100)}%</b></span>
          )}
        </div>
      </div>

      {/* ANÁLISIS DE COSTES (compacto) — reglas de Maria (14/07/2026):
          · Ingresos y horas: de las LÍNEAS REALES de BC si están cargadas
            (botón «Cargar líneas desde BC»); si no, de la memoria (parcial).
          · Mano de obra a COSTE = horas vendidas (líneas Recurso) × 21,50 €/h
          · Estructura = 22% sobre el total de la venta
          · Margen bruto = venta − materiales − mano de obra
          · Resultado = margen bruto − estructura */}
      {(() => {
        const TARIFA_COSTE_MO = 21.5;
        const PCT_ESTRUCTURA = 0.22;
        const conBC = !!(lineasBC?.ventaRaw?.length);
        let ingresos, horas;
        if (conBC) {
          ingresos = lineasBC.ventaRaw.reduce((a, l) => a + (Number(l["Line_Amount"]) || 0), 0);
          horas = lineasBC.ventaRaw.reduce(
            (a, l) => a + (((l["Type"] ?? "").toString().toLowerCase() === "resource") ? (Number(l["Quantity"]) || 0) : 0),
            0
          );
        } else {
          ingresos = Number(ficha.venta.importeTotalFacturado) || 0;
          horas = Number(ficha.venta.horas.cantidad) || 0;
        }
        const manoObra = horas * TARIFA_COSTE_MO;
        // Materiales = la MISMA suma que la tabla «Material pedido (compras)»:
        // líneas de compra reales (PC) deduplicadas (memoria + BC).
        const materiales = compraReal.reduce((a, l) => a + (Number(l.importe ?? l["Importe línea"]) || 0), 0);
        // AJUSTES DE MATERIAL (regla de Maria, 15/07/2026):
        // · Comprado NO vendido → queda en stock: se RESTA del coste (a favor).
        // · Material del TALLER (vendido sin compra) → se SUMA como coste.
        const compradoNoVendido = Number(dif.costeNoFacturado) || 0;
        const estructura = ingresos * PCT_ESTRUCTURA;
        const margenBruto = ingresos - (materiales - compradoNoVendido) - costeTaller - manoObra;
        const resultado = margenBruto - estructura;
        const pct = ingresos > 0 ? Math.round((resultado / ingresos) * 100) : null;
        const col = (v) => (v < 0 ? "text-red-600" : "text-emerald-600");
        const Metrica = ({ label, valor, sub, colorClase = "text-slate-800", signo }) => (
          <div className="flex-1 min-w-[105px] px-3 py-2">
            <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">{label}</div>
            <div className={`text-sm font-bold whitespace-nowrap tabular-nums ${colorClase}`}>{signo}{valor}</div>
            {sub && <div className="text-[9px] text-slate-400 whitespace-nowrap mt-0.5">{sub}</div>}
          </div>
        );
        const Sep = ({ simbolo = "−" }) => (
          <div className="self-center text-slate-300 font-bold text-sm select-none">{simbolo}</div>
        );
        return (
          <div className="mb-3">
            <div className="flex items-stretch bg-gradient-to-r from-slate-50 to-white border border-slate-200 rounded-lg divide-x divide-slate-100 overflow-x-auto">
              <Metrica label="Ingresos" valor={eur(ingresos)} sub={conBC ? "líneas de venta BC" : "⚠ memoria (parcial)"} colorClase="text-blue-700" />
              <Metrica label="Materiales" valor={eur(materiales)} sub="compras PC" />
              {compradoNoVendido > 0 && (
                <Metrica label="No vendido (stock)" valor={`− ${eur(compradoNoVendido)}`} sub="comprado sin vender: a favor" colorClase="text-emerald-600" />
              )}
              {costeTaller > 0 && (
                <Metrica label="Material taller" valor={`+ ${eur(costeTaller)}`} sub="vendido sin compra (estimado)" colorClase="text-amber-600" />
              )}
              <Metrica label={`Mano de obra · ${horas} h`} valor={eur(manoObra)} sub="a coste 21,50 €/h" />
              <Metrica label="Margen bruto" valor={eur(margenBruto)} sub="venta − consumido − taller − m.obra" colorClase={col(margenBruto)} />
              <Metrica label="Estructura" valor={eur(estructura)} sub="22% de la venta" />
              <Metrica
                label="Resultado"
                valor={pct != null ? `${eur(resultado)} · ${pct}%` : eur(resultado)}
                sub="margen − estructura"
                colorClase={`${col(resultado)} `}
              />
              <div className={`w-1.5 rounded-r-lg ${resultado < 0 ? "bg-red-400" : "bg-emerald-400"}`} />
            </div>
            {!conBC && (
              <div className="text-[10px] text-amber-600 mt-1">
                ⚠ Cifras de la memoria: pueden faltar líneas. Pulsa «Cargar líneas desde BC» para el cálculo exacto.
              </div>
            )}
          </div>
        );
      })()}

      {/* Cargar líneas frescas desde BC */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={cargarLineasBC}
          disabled={cargandoBC}
          className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-white border border-blue-300 rounded-md px-3 py-1.5 hover:bg-blue-50 disabled:opacity-60"
        >
          <RefreshCw size={12} className={cargandoBC ? "animate-spin" : ""} />
          {cargandoBC ? "Cargando..." : lineasBC ? "Actualizar líneas desde BC" : "Cargar líneas desde BC"}
        </button>
        {lineasBC && (
          <span className="text-[11px] text-slate-500">
            BC: {lineasBC.venta.length} línea(s) venta · {lineasBC.compra.length} de compra
          </span>
        )}
        {avisoBC && <span className="text-[11px] text-amber-700">⚠ {avisoBC}</span>}
      </div>

      {/* Pestañas: Material propuesto / Factura / Partes */}
      <div className="flex items-center gap-1 mb-3 border-b border-slate-200">
        {[
          { id: "material", label: "🧰 Material propuesto" },
          { id: "factura", label: "🧾 Factura" },
          { id: "partes", label: "📋 Partes" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTabDetalle(t.id)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-t-md border border-b-0 -mb-px ${
              tabDetalle === t.id
                ? "bg-white border-slate-200 text-slate-800"
                : "bg-slate-50 border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tabDetalle === "material" && (
        <>
      {/* 1) Material PROPUESTO */}
      <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 mb-3">
        <div className="text-xs font-bold text-sky-900 mb-2 flex items-center justify-between flex-wrap gap-1">
          <span>🧰 Material propuesto (por {propuesto.baseOTs || 0} OTs similares) — unidades editables</span>
          <span className="text-[10px] font-normal text-sky-800/60">👤 facturado en ventas · 🛒 solo visto en compras · 📌 manual</span>
        </div>
        <div className="text-[10px] text-sky-800/40 mb-1.5" title="Diagnóstico del cálculo de material 🛒 comprado-sin-vender para OTs similares">
          🛒 diagn.: {compradosParaEsteTrabajo.diag.motivo === "sin_similares"
            ? "no se han encontrado OTs similares a esta (revisa la descripción de la OT)"
            : compradosParaEsteTrabajo.diag.motivo === "sin_fichas"
            ? "memoria histórica aún no construida"
            : `${compradosParaEsteTrabajo.diag.baseOTsCompra} OT(s) similares · ${compradosParaEsteTrabajo.diag.articulosVistos} artículo(s) de compra distintos vistos · ${compradosParaEsteTrabajo.diag.excluidosPorVenta} ya cubiertos por venta · ${compradosParaEsteTrabajo.diag.excluidosPorBloqueo} descartados por ti`}
        </div>
        {(propuestoFinal.articulos || []).length === 0 && (
          <div className="text-[11px] text-sky-800/60">Sin OTs similares con detalle de material. Carga facturas PDF o líneas de venta para nutrir la memoria.</div>
        )}
        {(propuestoFinal.articulos || []).map((a) => {
          const k = a.codigo || a.descripcion;
          return (
            <div key={k} className="flex items-center gap-2 text-[11px] py-1 border-b border-sky-100 last:border-0">
              <span className="font-mono text-sky-700 whitespace-nowrap w-32 truncate">{a.codigo || "—"}</span>
              <span className="text-sky-900 flex-1 truncate" title={a.descripcion}>{a.descripcion}</span>
              {a.esManual ? (
                <span className="text-[9px] font-bold text-sky-700 bg-sky-100 border border-sky-300 rounded px-1.5 py-0.5 whitespace-nowrap" title="Propuesto por ti para este tipo de trabajo">📌 manual</span>
              ) : a.esComprado ? (
                <span
                  className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5 whitespace-nowrap"
                  title={`Comprado en ${a.nOTs} OT(s) similares a esta, aunque no siempre se facture aparte`}
                >
                  🛒 comprado {a.pct != null ? `${Math.round(a.pct * 100)}%` : ""}
                </span>
              ) : (
                <span className="text-sky-700/70 whitespace-nowrap" title="Facturado en OTs similares (memoria de ventas)">
                  👤 {Math.round(a.pct * 100)}%
                </span>
              )}
              <input
                type="number"
                step="0.5"
                min="0"
                value={uds[k] ?? a.unidadesPropuestas}
                onChange={(e) => setUds((p) => ({ ...p, [k]: parseFloat(e.target.value) || 0 }))}
                className="w-16 text-[11px] border border-sky-300 rounded px-1.5 py-0.5 text-right bg-white focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
              <span className="text-sky-700/70 whitespace-nowrap w-20 text-right">
                {a.precioMediano > 0 ? `× ${eur(a.precioMediano)}` : ""}
              </span>
              <span
                className="whitespace-nowrap w-24 text-right"
                title={
                  a.nComprasHistorico > 0
                    ? `Última compra encontrada en ${a.nComprasHistorico} OT(s) similares`
                    : "Sin historial de compra en la memoria para este artículo"
                }
              >
                {a.costeCompra != null ? (
                  <span className={a.margen != null && a.margen < 0 ? "text-red-600 font-semibold" : "text-slate-500"}>
                    compra {eur(a.costeCompra)}
                    {a.margenPct != null && (
                      <span className="ml-1 text-[10px]">({Math.round(a.margenPct * 100)}%)</span>
                    )}
                  </span>
                ) : (
                  <span className="text-slate-300">sin compra</span>
                )}
              </span>
              <button
                onClick={() => (a.esManual ? quitarManual(a.codigo || (a.descripcion || "").toString().trim().toLowerCase()) : marcarComoMalo(a))}
                title={a.esManual ? "Quitar esta propuesta manual" : "Quitar y no volver a proponer para este tipo de trabajo"}
                className="text-slate-400 hover:text-red-600 hover:bg-red-50 rounded p-0.5 shrink-0"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        {/* PROPONER MATERIAL A MANO: se aprende para este tipo de trabajo */}
        <div className="mt-2 relative">
          {!buscadorAbierto ? (
            <button
              onClick={() => setBuscadorAbierto(true)}
              className="text-[11px] font-semibold text-sky-700 hover:text-sky-900 hover:underline"
            >
              + Proponer material para «{ficha.general.tipoTrabajo || "este tipo de trabajo"}»
            </button>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Busca por referencia o descripción (mín. 2 letras)…"
                  className="flex-1 text-[11px] border border-sky-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
                <button
                  onClick={() => { setBuscadorAbierto(false); setBusqueda(""); }}
                  className="text-slate-400 hover:text-slate-600 p-0.5"
                >
                  <X size={12} />
                </button>
              </div>
              {busqueda.trim().length >= 2 && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-sky-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {resultadosBusqueda.length === 0 && (
                    <div className="text-[11px] text-slate-400 px-2 py-1.5">Sin coincidencias en la memoria.</div>
                  )}
                  {resultadosBusqueda.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => proponerManual(r)}
                      className="w-full flex items-center gap-2 text-[11px] px-2 py-1.5 hover:bg-sky-50 text-left border-b border-slate-100 last:border-0"
                    >
                      <span className="font-mono text-sky-700 whitespace-nowrap w-32 truncate">{r.codigo || "—"}</span>
                      <span className="text-slate-700 flex-1 truncate">{r.descripcion}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {totalPropuesto > 0 && (
          <div className="text-[11px] font-bold text-sky-900 text-right mt-1.5">
            Material propuesto ≈ {eur(totalPropuesto)}
            {totalCompraPropuesto > 0 && (
              <span className="font-normal text-slate-500 ml-2">
                (compra ≈ {eur(totalCompraPropuesto)} · margen ≈ {eur(totalPropuesto - totalCompraPropuesto)})
              </span>
            )}
          </div>
        )}
        {bloqueados.filter((b) => b.tipoTrabajo === tipoTrabajoNorm).length > 0 && (
          <details className="mt-2">
            <summary className="text-[10px] text-sky-800/60 cursor-pointer">
              {bloqueados.filter((b) => b.tipoTrabajo === tipoTrabajoNorm).length} artículo(s) bloqueado(s) para «{ficha.general.tipoTrabajo}»
            </summary>
            <div className="mt-1 space-y-0.5">
              {bloqueados
                .filter((b) => b.tipoTrabajo === tipoTrabajoNorm)
                .map((b, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] text-sky-800/70">
                    <span className="flex-1 truncate">{b.descripcion || b.clave}</span>
                    <button
                      onClick={() => guardarBloqueados(bloqueados.filter((x) => x !== b))}
                      className="text-sky-700 hover:underline shrink-0"
                    >
                      restaurar
                    </button>
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>

      {/* 2) PEDIDO, TALLER y 3) VENDIDO */}
      <div className={`grid gap-3 mb-3 ${materialTaller.length > 0 ? "grid-cols-3" : "grid-cols-2"}`}>
        <TablaLineasMaterial
          titulo={`📦 Material pedido (compras) — ${compraReal.length}`}
          lineas={compraReal}
          agrupar
          onClicArticulo={(codigo, descripcion) => setHistorial({ tipo: "compra", codigo, descripcion })}
        />
        {materialTaller.length > 0 && (
          <TablaLineasMaterial
            titulo={`🏭 Material del taller (coste estimado) — ${materialTaller.length}`}
            lineas={materialTaller}
            onClicArticulo={(codigo, descripcion) => setHistorial({ tipo: "compra", codigo, descripcion })}
          />
        )}
        <TablaLineasMaterial
          titulo={`💶 Material vendido — ${ventaMaterial.length}`}
          lineas={ventaMaterial}
          onClicArticulo={(codigo, descripcion) => setHistorial({ tipo: "venta", codigo, descripcion })}
        />
      </div>

      {/* 4) DIFERENCIAS */}
      <div className="bg-white border border-slate-200 rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-slate-800">⚖️ Diferencias comprado ↔ vendido</div>
          {(dif.nFaltaCobrar > 0 || dif.nSinCoste > 0) && (
            <div className="flex items-center gap-2">
              {avisoCorreo && <span className="text-[11px] text-emerald-700 font-semibold">{avisoCorreo}</span>}
              <button
                onClick={async () => {
                  const { para, asunto } = destinatariosRevisio(ficha);
                  const html = construirHtmlRevisio(ficha, dif);
                  try {
                    // Copia la versió VISUAL (taula amb colors) al porta-retalls
                    await navigator.clipboard.write([
                      new ClipboardItem({
                        "text/html": new Blob([html], { type: "text/html" }),
                        "text/plain": new Blob(["(Enganxa amb Ctrl+V per veure la taula de revisió de material)"], { type: "text/plain" }),
                      }),
                    ]);
                    setAvisoCorreo("Taula copiada — enganxa-la (Ctrl+V) al cos del correu");
                    window.location.href = `mailto:${para}?subject=${encodeURIComponent(asunto)}`;
                  } catch {
                    // Respaldo: correu amb el cos en text pla de sempre
                    setAvisoCorreo(null);
                    window.location.href = mailtoDiferencias(ficha, dif);
                  }
                }}
                title="Copia la taula de revisió (amb colors) i obre el correu al responsable: enganxa-la al cos amb Ctrl+V"
                className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-700 bg-white border border-blue-300 rounded-md px-2.5 py-1 hover:bg-blue-50"
              >
                <Mail size={12} /> Revisió material
              </button>
            </div>
          )}
        </div>
        {dif.items.length === 0 && <div className="text-[11px] text-slate-400">Sin líneas de material para comparar. Usa «Cargar líneas desde BC» o sube las facturas PDF de esta OT.</div>}
        {(dif.costeNoFacturado > 0 || dif.ventaSinCoste > 0 || dif.nCodigoDistinto > 0) && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {dif.costeNoFacturado > 0 && (
              <span className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-300 rounded px-2 py-1">
                🔴 Comprado sin facturar: {eur(dif.costeNoFacturado)} ({dif.nFaltaCobrar} artículo/s) — revisar si hay que cobrarlo
              </span>
            )}
            {dif.ventaSinCoste > 0 && (
              <span className="text-[11px] font-bold text-orange-700 bg-orange-50 border border-orange-300 rounded px-2 py-1">
                🟠 Vendido sin compra asociada: {eur(dif.ventaSinCoste)} ({dif.nSinCoste} artículo/s) — ¿almacén o gasto sin imputar?
              </span>
            )}
            {dif.nCodigoDistinto > 0 && (
              <span className="text-[11px] font-bold text-purple-700 bg-purple-50 border border-purple-300 rounded px-2 py-1">
                🟣 {dif.nCodigoDistinto} posible(s) pareja(s) con códigos distintos — mismo artículo comprado y vendido con referencia diferente
              </span>
            )}
          </div>
        )}
        {dif.items.map((it, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-b border-slate-100 last:border-0">
            <span className={`font-bold border rounded px-1.5 py-0.5 whitespace-nowrap ${ESTADO_UI[it.estado].cls}`}>
              {ESTADO_UI[it.estado].label}
            </span>
            <span className="font-mono text-slate-500 whitespace-nowrap w-28 truncate">{it.codigo || "—"}</span>
            <span className="text-slate-700 flex-1 truncate" title={it.descripcion}>
              {it.descripcion}
              {it.pareja && <span className="text-purple-600"> ↔ {it.pareja.codigo || it.pareja.descripcion}</span>}
            </span>
            <span className="text-slate-500 whitespace-nowrap">compra {it.udsCompradas} ud · {eur(it.costeCompra)}</span>
            <span className="text-slate-500 whitespace-nowrap">venta {it.udsVendidas} ud · {eur(it.importeVenta)}</span>
          </div>
        ))}
      </div>
        </>
      )}

      {/* 5) FACTURA — línies de venda de l'OT tal com estan a BC */}
      {tabDetalle === "factura" && (
        <FacturaOT lineasRaw={lineasBC?.ventaRaw} ficha={ficha} noBC={noBC} />
      )}

      {/* 6) PARTES de trabajo — agrupación por "Nº parte de trabajo" de las líneas de venta */}
      {tabDetalle === "partes" && (
        <PartesTrabajoOT lineasRaw={lineasBC?.ventaRaw} ficha={ficha} fichas={fichas} onClicArticulo={(codigo, descripcion) => setHistorial({ tipo: "venta", codigo, descripcion })} />
      )}

      {historial && (
        <ModalHistorialArticulo
          {...historial}
          fichas={fichas}
          vivas={lineasBC}
          otActual={noBC}
          clienteActual={ficha?.general?.cliente}
          onCerrar={() => setHistorial(null)}
        />
      )}
    </div>
  );
}

/** Construeix les files del BORRADOR a partir de les línies de venda CRUDES
 *  de BC (mateixa lectura i ordre que la secció Factura). Helper compartit
 *  entre el botó "Borrador PDF" i el correu "Revisió material". */
function filasBorradorDesdeRaw(lineasRaw) {
  if (!lineasRaw || lineasRaw.length === 0) return null;
  const leer = (l) => ({
    documento: (l["Document_No"] ?? "").toString(),
    lineaNo: Number(l["Line_No"]) || 0,
    numero: (l["No"] ?? "").toString(),
    descripcion: (l["Description"] ?? "").toString(),
    cantidad: Number(l["Quantity"]) || 0,
    precio: Number(l["Unit_Price"]) || 0,
    importe: Number(l["Line_Amount"]) || 0,
    _raw: l,
  });
  const dtoNum = (raw, l) => {
    const campo = Number(raw?.["Percent_Dto_linea_1"] ?? raw?.["Line_Discount_Percent"] ?? raw?.["Line_Discount_x0025"]) || 0;
    if (campo > 0) return Math.round(campo * 100) / 100;
    const bruto = l.precio * l.cantidad;
    if (bruto > 0 && l.importe >= 0 && l.importe < bruto) {
      const pct = Math.round((1 - l.importe / bruto) * 1000) / 10;
      if (pct >= 0.1) return pct;
    }
    return 0;
  };
  const orden = lineasRaw.map(leer).sort((a, b) => a.documento.localeCompare(b.documento) || a.lineaNo - b.lineaNo);
  return {
    cif: (lineasRaw.find((r) => r["Sell_to_Customer_No"]) || {})["Sell_to_Customer_No"] || "",
    filas: orden.map((l) => ({
      numero: l.numero,
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      precio: l.precio,
      importe: l.importe,
      dtoPct: dtoNum(l._raw, l),
    })),
  };
}

/** «Factura» de l'OT: les línies de venda tal com apareixen a BC
 *  (Líns. venta filtrades per OT), en el seu ordre de document i línia,
 *  incloses les línies de text (Nº parte de trabajo, descripcions...).
 *  Es nodreix de les línies CRUDES que porta «Cargar líneas desde BC».
 *  Les columnes es poden REDIMENSIONAR arrossegant la vora de la capçalera
 *  (l'amplada es guarda al navegador). */
const FACTURA_COLS_LS = "agente_ventas_factura_cols_v1";
const FACTURA_COLS_DEF = { documento: 80, tipo: 48, numero: 96, cantidad: 40, precio: 56, dto: 40, importe: 64 };

function FacturaOT({ lineasRaw, ficha, noBC }) {
  const [anchos, setAnchos] = useState(() => {
    try {
      const g = JSON.parse(localStorage.getItem(FACTURA_COLS_LS) || "null");
      return g && typeof g === "object" ? { ...FACTURA_COLS_DEF, ...g } : { ...FACTURA_COLS_DEF };
    } catch {
      return { ...FACTURA_COLS_DEF };
    }
  });
  const arrastre = useRef(null); // {col, x0, w0}

  const empezarArrastre = (col) => (e) => {
    e.preventDefault();
    arrastre.current = { col, x0: e.clientX, w0: anchos[col] };
    const mover = (ev) => {
      const a = arrastre.current;
      if (!a) return;
      const w = Math.max(28, Math.min(400, a.w0 + (ev.clientX - a.x0)));
      setAnchos((p) => ({ ...p, [a.col]: w }));
    };
    const soltar = () => {
      arrastre.current = null;
      window.removeEventListener("mousemove", mover);
      window.removeEventListener("mouseup", soltar);
      setAnchos((p) => {
        try { localStorage.setItem(FACTURA_COLS_LS, JSON.stringify(p)); } catch {}
        return p;
      });
    };
    window.addEventListener("mousemove", mover);
    window.addEventListener("mouseup", soltar);
  };

  const restablecer = () => {
    setAnchos({ ...FACTURA_COLS_DEF });
    try { localStorage.removeItem(FACTURA_COLS_LS); } catch {}
  };

  // Capçalera amb nansa d'arrossegament a la vora dreta de cada columna
  const Th = ({ col, children, right }) => (
    <span
      className={`relative whitespace-nowrap shrink-0 ${right ? "text-right" : ""}`}
      style={{ width: anchos[col] }}
    >
      {children}
      <span
        onMouseDown={empezarArrastre(col)}
        title="Arrastra para cambiar el ancho"
        className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-col-resize hover:bg-blue-200/60 rounded"
      />
    </span>
  );

  const filas = useMemo(() => {
    if (!lineasRaw || lineasRaw.length === 0) return [];
    const leer = (l) => ({
      documento: (l["Document_No"] ?? "").toString(),
      lineaNo: Number(l["Line_No"]) || 0,
      tipo: (l["Type"] ?? "").toString(),
      numero: (l["No"] ?? "").toString(),
      descripcion: (l["Description"] ?? "").toString(),
      cantidad: Number(l["Quantity"]) || 0,
      precio: Number(l["Unit_Price"]) || 0,
      importe: Number(l["Line_Amount"]) || 0,
      _raw: l,
    });
    return lineasRaw
      .map(leer)
      .sort((a, b) => a.documento.localeCompare(b.documento) || a.lineaNo - b.lineaNo);
  }, [lineasRaw]);

  const total = filas.reduce((a, l) => a + l.importe, 0);
  const TIPO_ES = { item: "Artículo", resource: "Recurso", "g/l account": "Cuenta", account: "Cuenta" };

  // % de descompte per línia: camp de BC si existeix; si no, calculat
  // 1 − importe/(precio×cantidad) — mateix criteri que als historials.
  const pctDto = (raw, l) => {
    const campo = Number(raw?.["Percent_Dto_linea_1"] ?? raw?.["Line_Discount_Percent"] ?? raw?.["Line_Discount_x0025"]) || 0;
    if (campo > 0) return campo + "%";
    const bruto = l.precio * l.cantidad;
    if (bruto > 0 && l.importe >= 0 && l.importe < bruto) {
      const pct = Math.round((1 - l.importe / bruto) * 1000) / 10;
      if (pct >= 0.1) return pct + "%";
    }
    return "";
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-slate-800">🧾 Factura — línies de venda de l'OT</div>
        {filas.length > 0 && (
          <button
            onClick={() => {
              // % dto numèric per línia (camp BC o calculat), pel PDF
              const dtoNum = (raw, l) => {
                const campo = Number(raw?.["Percent_Dto_linea_1"] ?? raw?.["Line_Discount_Percent"] ?? raw?.["Line_Discount_x0025"]) || 0;
                if (campo > 0) return Math.round(campo * 100) / 100;
                const bruto = l.precio * l.cantidad;
                if (bruto > 0 && l.importe >= 0 && l.importe < bruto) {
                  const pct = Math.round((1 - l.importe / bruto) * 1000) / 10;
                  if (pct >= 0.1) return pct;
                }
                return 0;
              };
              const cif = (lineasRaw.find((r) => r["Sell_to_Customer_No"]) || {})["Sell_to_Customer_No"] || "";
              generarBorradorFactura({
                numeroOT: ficha?.numeroOT || noBC,
                cliente: ficha?.general?.cliente || "",
                cifCliente: cif,
                filas: filas.map((l) => ({
                  numero: l.numero,
                  descripcion: l.descripcion,
                  cantidad: l.cantidad,
                  precio: l.precio,
                  importe: l.importe,
                  dtoPct: dtoNum(l._raw, l),
                })),
              });
            }}
            title="Genera el borrador de factura en PDF con la plantilla oficial ALSO CASALS"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-700 bg-white border border-blue-300 rounded-md px-2.5 py-1 hover:bg-blue-50"
          >
            <FileText size={12} /> Borrador PDF
          </button>
        )}
      </div>
      {filas.length === 0 && (
        <div className="text-[11px] text-slate-400">
          Pulsa «Cargar líneas desde BC» (arriba) para traer las líneas de venta de esta OT y montar aquí la factura.
        </div>
      )}
      {filas.length > 0 && (
        <>
          <div className="flex items-center justify-end mb-1">
            <button onClick={restablecer} className="text-[10px] text-slate-400 hover:text-slate-600 hover:underline">
              ↺ Restablecer anchos
            </button>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-200 select-none">
            <Th col="documento">Nº doc.</Th>
            <Th col="tipo">Tipo</Th>
            <Th col="numero">Nº</Th>
            <span className="flex-1">Descripción</span>
            <Th col="cantidad" right>Cant.</Th>
            <Th col="precio" right>P. unit.</Th>
            <Th col="dto" right>% Dto.</Th>
            <Th col="importe" right>Importe</Th>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {filas.map((l, i) => {
              const esTexto = !l.numero && l.importe === 0 && l.cantidad === 0;
              return (
                <div key={i} className={`flex items-center gap-2 text-[11px] py-1 border-b border-slate-100 last:border-0 ${esTexto ? "text-slate-500 italic" : ""}`}>
                  <span className="font-mono text-slate-500 whitespace-nowrap truncate shrink-0" style={{ width: anchos.documento }} title={l.documento}>{l.documento}</span>
                  <span className="text-slate-500 whitespace-nowrap truncate shrink-0" style={{ width: anchos.tipo }}>{TIPO_ES[l.tipo.toLowerCase()] ?? l.tipo}</span>
                  <span className="font-mono text-slate-500 whitespace-nowrap truncate shrink-0" style={{ width: anchos.numero }} title={l.numero}>{l.numero}</span>
                  <span className="flex-1 truncate" title={l.descripcion}>{l.descripcion}</span>
                  <span className="whitespace-nowrap text-right shrink-0" style={{ width: anchos.cantidad }}>{esTexto ? "" : l.cantidad}</span>
                  <span className="whitespace-nowrap text-right shrink-0" style={{ width: anchos.precio }}>{esTexto ? "" : eurUnit(l.precio)}</span>
                  <span className="whitespace-nowrap text-right shrink-0" style={{ width: anchos.dto }}>{esTexto ? "" : pctDto(l._raw, l)}</span>
                  <span className="font-semibold whitespace-nowrap text-right shrink-0" style={{ width: anchos.importe }}>{esTexto ? "" : eur(l.importe)}</span>
                </div>
              );
            })}
          </div>
          <div className="text-[11px] font-bold text-slate-800 text-right mt-1.5">Total (base): {eur(total)}</div>
        </>
      )}
    </div>
  );
}

// Detecta, dentro de las líneas de venta de la OT, las líneas de texto
// tipo "Nº parte de trabajo: XXXXX-YYYY OT: ZZZZZ Fecha: DD/MM/YYYY" y
// agrupa debajo de cada una el importe de las líneas de cargo (mano de
// obra, artículos...) hasta el siguiente "parte" o el fin del documento.
const RE_PARTE_TRABAJO = /n[ºo]\.?\s*parte de trabajo[:\s]+(\S+)\s+ot[:\s]+(\S+)\s+fecha[:\s]+(\d{2}\/\d{2}\/\d{4})/i;

function PartesTrabajoOT({ lineasRaw, ficha, fichas, onClicArticulo }) {
  const [abierto, setAbierto] = useState(null); // Nº documento expandido, o null
  const UMBRAL_DISCREPANCIA = 5; // €

  const { partes, porDocumento, documentosConDiscrepancia } = useMemo(() => {
    if (!lineasRaw || lineasRaw.length === 0) return { partes: [], porDocumento: new Map(), documentosConDiscrepancia: new Set() };
    const cliente = ficha?.general?.cliente;
    const leer = (l) => ({
      documento: (l["Document_No"] ?? "").toString(),
      lineaNo: Number(l["Line_No"]) || 0,
      tipo: (l["Type"] ?? "").toString(),
      numero: (l["No"] ?? "").toString(),
      descripcion: (l["Description"] ?? "").toString(),
      cantidad: Number(l["Quantity"]) || 0,
      precio: Number(l["Unit_Price"]) || 0,
      importe: Number(l["Line_Amount"]) || 0,
    });
    const filas = lineasRaw
      .map(leer)
      .sort((a, b) => a.documento.localeCompare(b.documento) || a.lineaNo - b.lineaNo);

    // Para cada línea de tipo Artículo, comparamos su precio unitario real
    // contra el precio sugerido (misma normativa que el popup de
    // historial: cliente > otro cliente > compra). Si la diferencia
    // supera el umbral, se marca la línea Y el parte al que pertenece.
    const documentosConDiscrepancia = new Set();
    for (const l of filas) {
      const esArticulo = l.tipo.toLowerCase() === "item" && (l.numero || l.descripcion);
      if (!esArticulo || !fichas) continue;
      const sug = calcularPrecioSugerido(
        historialVentaArticulo(l.numero, l.descripcion, fichas),
        historialCompraArticulo(l.numero, l.descripcion, fichas),
        cliente
      );
      l.precioSugerido = sug.precio;
      l.discrepancia = sug.precio != null && Math.abs(l.precio - sug.precio) > UMBRAL_DISCREPANCIA;
      if (l.discrepancia) documentosConDiscrepancia.add(l.documento);
    }

    const porDocumento = new Map();
    for (const l of filas) {
      if (!porDocumento.has(l.documento)) porDocumento.set(l.documento, []);
      porDocumento.get(l.documento).push(l);
    }

    const grupos = [];
    let actual = null;
    for (const l of filas) {
      const m = l.descripcion.match(RE_PARTE_TRABAJO);
      if (m) {
        actual = { documento: l.documento, parte: m[1], ot: m[2], fecha: m[3], importe: 0 };
        grupos.push(actual);
        continue;
      }
      if (actual && l.documento === actual.documento) actual.importe += l.importe;
    }
    return { partes: grupos, porDocumento, documentosConDiscrepancia };
  }, [lineasRaw, ficha, fichas]);

  const total = partes.reduce((a, p) => a + p.importe, 0);
  const TIPO_ES_PARTES = { item: "Artículo", resource: "Recurso", "g/l account": "Cuenta", account: "Cuenta" };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 mt-3">
      <div className="text-xs font-bold text-slate-800 mb-2">📋 Partes de trabajo de la OT</div>
      <div className="text-[10px] text-slate-400 mb-2">
        Clic en un parte para ver sus líneas de venta, con la columna <span className="text-emerald-700 font-semibold">P. sugerido</span> indicando a qué precio vender cada artículo · los <span className="text-blue-700 font-semibold">artículos en azul</span> abren su historial de precios de venta · en <span className="text-red-600 font-semibold">rojo</span>, precio con más de {UMBRAL_DISCREPANCIA}€ de diferencia sobre el sugerido.
      </div>
      {(!lineasRaw || lineasRaw.length === 0) && (
        <div className="text-[11px] text-slate-400">
          Pulsa «Cargar líneas desde BC» (arriba) para traer las líneas de venta y detectar aquí los partes de trabajo.
        </div>
      )}
      {lineasRaw && lineasRaw.length > 0 && partes.length === 0 && (
        <div className="text-[11px] text-slate-400">
          No se ha encontrado ninguna línea con el formato «Nº parte de trabajo: ... OT: ... Fecha: ...» en las líneas de venta de esta OT.
        </div>
      )}
      {partes.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-200">
            <span className="w-4" />
            <span className="w-32">Nº OT</span>
            <span className="w-32">Nº Parte</span>
            <span className="flex-1">Cliente</span>
            <span className="w-24">Fecha</span>
            <span className="w-24 text-right">Importe</span>
          </div>
          {partes.map((p, i) => {
            const lineasDoc = porDocumento.get(p.documento) || [];
            const abiertoAqui = abierto === p.documento;
            const conDiscrepancia = documentosConDiscrepancia.has(p.documento);
            return (
              <div key={i} className={`border-b last:border-0 ${conDiscrepancia ? "border-red-100 bg-red-50/60" : "border-slate-100"}`}>
                <div
                  className={`flex items-center gap-2 text-[11px] py-1.5 cursor-pointer ${conDiscrepancia ? "hover:bg-red-100/60" : "hover:bg-slate-50"}`}
                  onClick={() => setAbierto(abiertoAqui ? null : p.documento)}
                  title={conDiscrepancia ? `Este parte tiene algún artículo con más de ${UMBRAL_DISCREPANCIA}€ de diferencia sobre el precio sugerido` : undefined}
                >
                  <span className="text-slate-400 w-4">{abiertoAqui ? "▾" : "▸"}</span>
                  <span className={`font-mono w-32 truncate ${conDiscrepancia ? "text-red-700 font-semibold" : "text-slate-700"}`}>
                    {conDiscrepancia && "⚠ "}{p.ot}
                  </span>
                  <span className="font-mono text-slate-700 w-32 truncate">{p.parte}</span>
                  <span className="text-slate-600 flex-1 truncate">{ficha?.general?.cliente || "—"}</span>
                  <span className="text-slate-500 w-24">{p.fecha}</span>
                  <span className={`w-24 text-right ${conDiscrepancia ? "text-red-700 font-bold" : "font-semibold text-slate-800"}`}>{eur(p.importe)}</span>
                </div>
                {abiertoAqui && (
                  <div className="pl-6 pb-2">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-200">
                      <span className="w-20">Tipo</span>
                      <span className="w-24">Nº</span>
                      <span className="flex-1">Descripción</span>
                      <span className="w-14 text-right">Cant.</span>
                      <span className="w-16 text-right">P. unit.</span>
                      <span className="w-16 text-right">P. sugerido</span>
                      <span className="w-16 text-right">Importe</span>
                    </div>
                    {lineasDoc.map((l, j) => {
                      const esTexto = !l.numero && l.importe === 0 && l.cantidad === 0;
                      const esArticulo = l.tipo.toLowerCase() === "item" && (l.numero || l.descripcion);
                      return (
                        <div
                          key={j}
                          className={`flex items-center gap-2 text-[11px] py-1 border-b last:border-0 ${
                            esTexto ? "text-slate-400 italic border-slate-50" : l.discrepancia ? "bg-red-50 border-red-100" : "border-slate-50"
                          }`}
                          title={l.discrepancia ? `Precio sugerido: ${eurUnit(l.precioSugerido)} — diferencia de más de ${UMBRAL_DISCREPANCIA}€` : undefined}
                        >
                          <span className="text-slate-500 w-20 truncate">{esTexto ? "" : (TIPO_ES_PARTES[l.tipo.toLowerCase()] ?? l.tipo)}</span>
                          <span className="font-mono text-slate-500 w-24 truncate">{l.numero}</span>
                          {esArticulo ? (
                            <button
                              onClick={() => onClicArticulo && onClicArticulo(l.numero, l.descripcion)}
                              className={`flex-1 text-left truncate font-medium hover:underline ${l.discrepancia ? "text-red-700" : "text-blue-700"}`}
                              title="Ver último precio y el histórico de precios de venta de este artículo a otros clientes"
                            >
                              {l.discrepancia && "⚠ "}{l.descripcion}
                            </button>
                          ) : (
                            <span className="flex-1 truncate">{l.descripcion}</span>
                          )}
                          <span className="w-14 text-right text-slate-500">{esTexto ? "" : l.cantidad}</span>
                          <span className={`w-16 text-right ${l.discrepancia ? "text-red-700 font-bold" : "text-slate-500"}`}>{esTexto ? "" : eurUnit(l.precio)}</span>
                          <span className={`w-16 text-right font-semibold ${esArticulo && l.precioSugerido != null ? "text-emerald-700" : "text-slate-300"}`} title={esArticulo && l.precioSugerido != null ? "Precio de venta sugerido según la normativa del proyecto" : undefined}>
                            {esArticulo && l.precioSugerido != null ? eurUnit(l.precioSugerido) : "—"}
                          </span>
                          <span className={`w-16 text-right font-semibold ${l.discrepancia ? "text-red-700" : "text-slate-700"}`}>{esTexto ? "" : eur(l.importe)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-[11px] font-bold text-slate-800 text-right mt-1.5">Total: {eur(total)}</div>
        </>
      )}
    </div>
  );
}

function TablaLineasMaterial({ titulo, lineas, onClicArticulo, agrupar = false }) {
  const leer = (l) => {
    const cantidad = Number(l.cantidad ?? l["Cantidad"]) || 0;
    const unitario = Number(l.costeUnitario ?? l.precioUnitario ?? l["Coste unitario"] ?? l["Precio unitario"]) || 0;
    const importe = Number(l.importe ?? l["Importe línea"]) || 0;
    // % dto del campo BC si viene (compra: dtos[] o "% Dto. 1/2/3")
    const dtosCampo = Array.isArray(l.dtos)
      ? l.dtos
      : [Number(l["% Dto. 1"]) || 0, Number(l["% Dto. 2"]) || 0, Number(l["% Dto. 3"]) || 0];
    return {
      codigo: (l.numero ?? l["Nº"] ?? "").toString().trim(),
      descripcion: l.descripcion ?? l["Descripción"] ?? "",
      cantidad,
      unitario,
      bruto: unitario * cantidad,
      importe,
      dtosCampo,
    };
  };
  let filas = lineas.map(leer);
  // Agrupación por referencia: una sola fila por artículo, sumando
  // unidades, importes y bruto (para el PVP unitario medio y el % dto).
  if (agrupar) {
    const porRef = new Map();
    for (const l of filas) {
      const clave = l.codigo || l.descripcion.trim().toLowerCase();
      if (!clave) continue;
      const acc = porRef.get(clave);
      if (acc) {
        acc.cantidad += l.cantidad;
        acc.importe += l.importe;
        acc.bruto += l.bruto;
        acc.dtosCampo = [0, 0, 0]; // agrupado: el % se calcula del bruto
      } else {
        porRef.set(clave, { ...l });
      }
    }
    filas = [...porRef.values()].map((l) => ({
      ...l,
      unitario: l.cantidad > 0 ? l.bruto / l.cantidad : l.unitario,
    }));
  }
  // % de descuento: campo BC si viene; si no, calculado 1 − importe/bruto
  const pctDto = (l) => {
    const campo = (l.dtosCampo || []).filter((d) => d > 0);
    if (campo.length) return campo.join("+") + "%";
    if (l.bruto > 0 && l.importe >= 0 && l.importe < l.bruto) {
      const pct = Math.round((1 - l.importe / l.bruto) * 1000) / 10;
      if (pct >= 0.1) return pct + "%";
    }
    return "—";
  };
  const total = filas.reduce((a, l) => a + l.importe, 0);
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-xs font-bold text-slate-800 mb-2">{titulo}</div>
      {filas.length === 0 && <div className="text-[11px] text-slate-400">Sin líneas</div>}
      {filas.length > 0 && (
        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-200">
          <span className="whitespace-nowrap w-24">Ref.</span>
          <span className="flex-1">Descripción</span>
          <span className="whitespace-nowrap w-12 text-right">Cant.</span>
          <span className="whitespace-nowrap w-16 text-right">PVP unit.</span>
          <span className="whitespace-nowrap w-12 text-right">% Dto.</span>
          <span className="whitespace-nowrap w-16 text-right">Importe total</span>
        </div>
      )}
      <div className="max-h-48 overflow-y-auto">
        {filas.map((l, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-b border-slate-100 last:border-0">
            {onClicArticulo && (l.codigo || l.descripcion) ? (
              <button
                onClick={() => onClicArticulo(l.codigo, l.descripcion)}
                title="Ver historial de este artículo"
                className="font-mono text-blue-600 hover:underline whitespace-nowrap w-24 truncate text-left"
              >
                {l.codigo || "—"}
              </button>
            ) : (
              <span className="font-mono text-slate-500 whitespace-nowrap w-24 truncate">{l.codigo || "—"}</span>
            )}
            <span className="text-slate-700 flex-1 truncate" title={l.descripcion}>{l.descripcion}</span>
            <span className="text-slate-500 whitespace-nowrap w-12 text-right">{l.cantidad} ud</span>
            <span className="text-slate-500 whitespace-nowrap w-16 text-right">{eurUnit(l.unitario)}</span>
            <span className="text-slate-500 whitespace-nowrap w-12 text-right">{pctDto(l)}</span>
            <span className="font-semibold text-slate-700 whitespace-nowrap w-16 text-right">{eurUnit(l.importe)}</span>
          </div>
        ))}
      </div>
      {total > 0 && <div className="text-[11px] font-bold text-slate-800 text-right mt-1.5">Total: {eur(total)}</div>}
    </div>
  );
}

/** Modal con el historial de un artículo (compra u oferta / venta) en
 *  TODAS las OTs de la memoria, y el precio de venta sugerido. */
// Precio de venta sugerido, con esta normativa (de más a menos específico):
//  1) Último precio vendido A ESTE CLIENTE (da igual la antigüedad; si
//     hace más de 1 año se avisa para que se revise si sigue vigente).
//  2) Si no se le ha vendido nunca a este cliente, último precio vendido
//     a CUALQUIER otro cliente.
//  3) Si no hay NINGÚN historial de venta (a nadie), último precio de
//     COMPRA del artículo.
//  4) Si tampoco hay compra, no hay nada que sugerir.
// Función reutilizable: la usa tanto el modal de historial como la tabla
// de "Partes de trabajo" (para marcar discrepancias de precio).
function calcularPrecioSugerido(ventasHistorial, comprasHistorial, clienteActual) {
  const AÑO_MS = 365 * 24 * 60 * 60 * 1000;
  const clienteNorm = (clienteActual || "").toString().trim().toLowerCase();

  const ventas = (ventasHistorial || []).filter((v) => Number(v.precioUnitario) > 0);
  const ventasCliente = clienteNorm ? ventas.filter((v) => (v.cliente || "").toString().trim().toLowerCase() === clienteNorm) : [];

  if (ventasCliente.length > 0) {
    const ultima = ventasCliente[0]; // ya viene ordenado por reciencia
    const fecha = ultima.fechaPedido ? new Date(ultima.fechaPedido) : null;
    const antiguo = fecha && !isNaN(fecha.getTime()) ? Date.now() - fecha.getTime() > AÑO_MS : false;
    return {
      precio: ultima.precioUnitario,
      regla: `último precio vendido a este cliente${antiguo ? " — hace más de 1 año, revisa si sigue vigente" : ""}`,
      fuente: "venta_cliente",
    };
  }

  if (ventas.length > 0) {
    const ultima = ventas[0];
    return {
      precio: ultima.precioUnitario,
      regla: `este cliente no lo ha comprado antes — último precio vendido a ${ultima.cliente || "otro cliente"}`,
      fuente: "venta_otro",
    };
  }

  const compras = (comprasHistorial || []).filter((c) => Number(c.costeUnitario) > 0);
  if (compras.length > 0) {
    const ultima = compras[0];
    return {
      precio: ultima.costeUnitario,
      regla: "sin historial de venta a nadie — último precio de COMPRA (sin margen aplicado)",
      fuente: "compra",
    };
  }

  return { precio: null, regla: null, fuente: "ninguno" };
}

function ModalHistorialArticulo({ tipo, codigo, descripcion, fichas, vivas, otActual, clienteActual, onCerrar }) {
  // Filtro Pedido (PC) | Oferta (OC) del historial de compra.
  // Por defecto: Pedido.
  const [filtroDoc, setFiltroDoc] = useState("PC");

  const todas = useMemo(() => {
    const memoria =
      tipo === "compra"
        ? historialCompraArticulo(codigo, descripcion, fichas)
        : historialVentaArticulo(codigo, descripcion, fichas);

    // LÍNEAS VIVAS de la OT actual (botón «Cargar líneas desde BC»):
    // se fusionan con la memoria para que el historial NUNCA contradiga
    // a las tablas del detalle aunque la memoria esté desactualizada.
    const cod = (codigo || "").toString().trim();
    const descN = (descripcion || "").toString().trim().toLowerCase();
    const coincide = (c, d) => (cod ? (c || "").toString().trim() === cod : (d || "").toString().trim().toLowerCase() === descN);

    let extra = [];
    if (vivas && tipo === "compra") {
      extra = (vivas.compra || [])
        .filter((l) => coincide(l["Nº"], l["Descripción"]))
        .map((l) => ({
          ot: otActual,
          proveedor: l["Nombre de proveedor de compra"] || "",
          numeroDocumento: l["Nº documento"] || null,
          descripcion: l["Descripción"] || "",
          cantidad: Number(l["Cantidad"]) || 0,
          costeUnitario: Number(l["Coste unitario"]) || 0,
          importe: Number(l["Importe línea"]) || 0,
          fechaPedido: l["Fecha pedido"] || null,
          dtos: [Number(l["% Dto. 1"]) || 0, Number(l["% Dto. 2"]) || 0, Number(l["% Dto. 3"]) || 0],
        }));
    } else if (vivas && tipo === "venta") {
      extra = (vivas.venta || [])
        .filter((l) => coincide(l["Nº"], l["Descripción"]))
        .map((l) => ({
          ot: otActual,
          cliente: "",
          numeroDocumento: l["Nº documento"] || null,
          descripcion: l["Descripción"] || "",
          cantidad: Number(l["Cantidad"]) || 0,
          precioUnitario: Number(l["Precio unitario"]) || 0,
          importe: Number(l["Importe línea"]) || 0,
          fechaPedido: l["Fecha pedido"] || null,
          dtos: [Number(l["% Dto. 1"]) || 0, Number(l["% Dto. 2"]) || 0, Number(l["% Dto. 3"]) || 0],
        }));
    }

    // Deduplicado: una línea puede estar a la vez en memoria y en vivo
    const clave = (f) =>
      [normalizarNumeroOT(f.ot), f.numeroDocumento || "", f.descripcion, f.cantidad, f.importe].join("|");
    const enMemoria = new Set(memoria.map(clave));
    const nuevas = extra.filter((f) => !enMemoria.has(clave(f)));
    return [...nuevas, ...memoria];
  }, [tipo, codigo, descripcion, fichas, vivas, otActual]);

  const filas = useMemo(() => {
    if (tipo !== "compra") return todas;
    return todas.filter((f) =>
      (f.numeroDocumento || "").toString().trim().toUpperCase().startsWith(filtroDoc)
    );
  }, [todas, tipo, filtroDoc]);

  const nPedidos = useMemo(
    () => (tipo === "compra" ? todas.filter((f) => (f.numeroDocumento || "").toString().trim().toUpperCase().startsWith("PC")).length : 0),
    [todas, tipo]
  );
  const nOfertas = useMemo(
    () => (tipo === "compra" ? todas.filter((f) => (f.numeroDocumento || "").toString().trim().toUpperCase().startsWith("OC")).length : 0),
    [todas, tipo]
  );

  // Precio de venta sugerido: ver normativa en calcularPrecioSugerido().
  const sugerido = useMemo(() => {
    if (tipo !== "venta") return null;
    return calcularPrecioSugerido(todas, historialCompraArticulo(codigo, descripcion, fichas), clienteActual);
  }, [tipo, todas, clienteActual, codigo, descripcion, fichas]);

  // Última COMPRA del artículo, como referencia rápida debajo de la
  // descripción (visible en el historial de VENTA, para comparar contra
  // lo que se está cobrando). Importe = Precio Unitario neto de descuento
  // (sin cantidad, es una referencia unitaria).
  const ultimaCompraRef = useMemo(() => {
    if (tipo !== "venta") return null;
    const compras = historialCompraArticulo(codigo, descripcion, fichas).filter((c) => Number(c.costeUnitario) > 0);
    if (compras.length === 0) return null;
    const c = compras[0]; // ya viene ordenado por reciencia
    const dtos = (Array.isArray(c.dtos) ? c.dtos : []).map((d) => Number(d) || 0).filter((d) => d > 0);
    const factorNeto = dtos.reduce((f, d) => f * (1 - d / 100), 1);
    const fecha = c.fechaPedido ? new Date(c.fechaPedido) : null;
    return {
      proveedor: c.proveedor || "—",
      fecha: fecha && !isNaN(fecha.getTime()) ? fecha.toLocaleDateString("es-ES") : "—",
      precioUnitario: c.costeUnitario,
      dtoLabel: dtos.length ? dtos.join("+") + "%" : "—",
      importe: c.costeUnitario * factorNeto,
    };
  }, [tipo, codigo, descripcion, fichas]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-3 border-b border-slate-200">
          <div>
            <div className="text-sm font-bold text-slate-800">
              {tipo === "compra" ? "📦 Historial de compra" : "💶 Historial de venta"} — {codigo || descripcion}
            </div>
            <div className="text-[11px] text-slate-500 truncate">{descripcion}</div>
            {ultimaCompraRef && (
              <div className="mt-1.5">
                <div className="flex items-center gap-3 text-[9px] font-bold text-slate-400 uppercase tracking-wide">
                  <span className="w-28">Proveedor</span>
                  <span className="w-20">Fecha</span>
                  <span className="w-20 text-right">P. Unit.</span>
                  <span className="w-14 text-right">% Dto.</span>
                  <span className="w-20 text-right">Importe</span>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-700">
                  <span className="w-28 truncate" title={ultimaCompraRef.proveedor}>{ultimaCompraRef.proveedor}</span>
                  <span className="w-20">{ultimaCompraRef.fecha}</span>
                  <span className="w-20 text-right">{eurUnit(ultimaCompraRef.precioUnitario)}</span>
                  <span className="w-14 text-right">{ultimaCompraRef.dtoLabel}</span>
                  <span className="w-20 text-right font-semibold">{eurUnit(ultimaCompraRef.importe)}</span>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {tipo === "compra" && (
              <div className="flex rounded-md border border-slate-300 overflow-hidden text-[11px] font-semibold">
                <button
                  onClick={() => setFiltroDoc("PC")}
                  className={filtroDoc === "PC" ? "bg-blue-600 text-white px-3 py-1" : "bg-white text-slate-600 px-3 py-1 hover:bg-slate-50"}
                >
                  Pedido ({nPedidos})
                </button>
                <button
                  onClick={() => setFiltroDoc("OC")}
                  className={filtroDoc === "OC" ? "bg-blue-600 text-white px-3 py-1" : "bg-white text-slate-600 px-3 py-1 hover:bg-slate-50"}
                >
                  Oferta ({nOfertas})
                </button>
              </div>
            )}
            <button onClick={onCerrar} className="text-slate-400 hover:text-slate-700 p-1">
              <X size={16} />
            </button>
          </div>
        </div>

        {sugerido && sugerido.precio != null && (
          <div
            className={`border-b px-3 py-2 text-[11px] ${
              sugerido.fuente === "compra"
                ? "bg-amber-50 border-amber-200 text-amber-900"
                : "bg-emerald-50 border-emerald-200 text-emerald-900"
            }`}
          >
            <b>Precio de venta sugerido: {eurUnit(sugerido.precio)}</b>
            {" · "}
            {sugerido.regla}
          </div>
        )}
        {sugerido && sugerido.precio == null && (
          <div className="bg-slate-50 border-b border-slate-200 px-3 py-2 text-[11px] text-slate-600 flex items-center gap-2 flex-wrap">
            <span>No hay registros de venta ni de compra para este artículo. ¿Quieres que lo busque en internet?</span>
            <a
              href={`https://www.google.com/search?q=${encodeURIComponent([codigo, descripcion].filter(Boolean).join(" "))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 font-semibold hover:underline"
            >
              Buscar «{codigo || descripcion}» en Google ↗
            </a>
          </div>
        )}

        <div className="overflow-y-auto p-3">
          {filas.length === 0 && (
            <div className="text-[11px] text-slate-400">
              {tipo === "compra"
                ? `Sin ${filtroDoc === "PC" ? "pedidos (PC)" : "ofertas (OC)"} históricos para este artículo.`
                : "Sin líneas históricas para este artículo."}
            </div>
          )}
          {filas.length > 0 && (
            <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-200">
              <span className="whitespace-nowrap w-24">Nº Documento</span>
              <span className="whitespace-nowrap w-28">Nº de OT</span>
              <span className="whitespace-nowrap w-28">{tipo === "compra" ? "Proveedor" : "Cliente"}</span>
              <span className="whitespace-nowrap w-20">Fecha pedido</span>
              <span className="whitespace-nowrap w-12">Cant.</span>
              <span className="whitespace-nowrap w-16 text-right">{tipo === "compra" ? "PVP unit." : "Precio unit."}</span>
              <span className="whitespace-nowrap w-14 text-right">% Dto.</span>
              <span className="whitespace-nowrap w-16 text-right">Importe total</span>
            </div>
          )}
          {filas.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-b border-slate-100 last:border-0">
              <span className="font-mono text-blue-700 whitespace-nowrap w-24 truncate" title={f.numeroDocumento}>
                {f.numeroDocumento || "—"}
              </span>
              <span className="font-mono text-slate-500 whitespace-nowrap w-28 truncate">{f.ot}</span>
              <span className="text-slate-600 whitespace-nowrap w-28 truncate" title={tipo === "compra" ? f.proveedor : f.cliente}>
                {(tipo === "compra" ? f.proveedor : f.cliente) || "—"}
              </span>
              <span className="text-slate-400 whitespace-nowrap w-20 truncate">
                {f.fechaPedido ? new Date(f.fechaPedido).toLocaleDateString("es-ES") : "—"}
              </span>
              <span className="text-slate-500 whitespace-nowrap w-12">{f.cantidad} ud</span>
              <span className="text-slate-500 whitespace-nowrap w-16 text-right">
                {tipo === "compra" ? eurUnit(f.costeUnitario) : eurUnit(f.precioUnitario)}
              </span>
              <span className="text-slate-500 whitespace-nowrap w-14 text-right">
                {(() => {
                  // 1º el campo de BC si viene informado (compra i venda);
                  // 2º cálculo implícito: 1 − importe / (unitario × cantidad).
                  if ((f.dtos || []).some((d) => d > 0)) return f.dtos.filter((d) => d > 0).join("+") + "%";
                  const unitario = Number(tipo === "compra" ? f.costeUnitario : f.precioUnitario) || 0;
                  const bruto = unitario * (Number(f.cantidad) || 0);
                  if (bruto > 0 && f.importe >= 0 && f.importe < bruto) {
                    const pct = Math.round((1 - f.importe / bruto) * 1000) / 10;
                    if (pct >= 0.1) return pct + "%";
                  }
                  return "—";
                })()}
              </span>
              <span className="font-semibold text-slate-700 whitespace-nowrap w-16 text-right">{eurUnit(f.importe)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConsultaOTNueva({ fichas, tarifaInicial = null }) {
  const [descripcion, setDescripcion] = useState("");
  const [tipoCliente, setTipoCliente] = useState(""); // "" = cualquiera
  const [tarifa, setTarifa] = useState(tarifaInicial ? String(tarifaInicial) : "");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState(null);

  const consultar = async () => {
    if (!descripcion.trim()) return;
    setBuscando(true);
    setResultado(null);
    const r = await sugerirParaOTNueva(descripcion, fichas, {
      minimoSimilitud: 0.35,
      maxReferencias: 5,
      tipoCliente: tipoCliente || null,
      tarifaHora: parseFloat(tarifa.replace(",", ".")) || null,
    });
    setResultado(r);
    setBuscando(false);
  };

  return (
    <div className="mt-6 border-t border-slate-200 pt-5">
      <div className="flex items-center gap-2 mb-2">
        <Search size={16} className="text-purple-600" />
        <h4 className="font-semibold text-slate-800 text-sm">Consultar una OT nueva</h4>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Escribe la descripción del trabajo que entra. El agente buscará OTs parecidas y sugerirá qué cobrar.
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && consultar()}
          placeholder="Ej: Reparar pérdida de agua en tubería del almacén"
          className="flex-1 text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <select
          value={tipoCliente}
          onChange={(e) => setTipoCliente(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
          title="Tipo de cliente: los precios varían según el segmento"
        >
          <option value="">Cliente: cualquiera</option>
          <option value="P">Particular (P)</option>
          <option value="I">Industrial (I)</option>
          <option value="A">Admón. pública (A)</option>
        </select>
        <input
          type="text"
          value={tarifa}
          onChange={(e) => setTarifa(e.target.value)}
          placeholder="Tarifa €/h"
          className="w-24 text-sm border border-slate-300 rounded-md px-2 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
          title="Tarifa horaria ACTUAL. Con ella el agente calcula la recomendación combinada (horas × tarifa + material) y la contrasta con el histórico."
        />
        <button
          onClick={consultar}
          disabled={buscando || !descripcion.trim()}
          className="flex items-center gap-2 bg-purple-700 hover:bg-purple-800 disabled:opacity-60 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
        >
          <Search size={14} className={buscando ? "animate-pulse" : ""} />
          {buscando ? "Buscando..." : "Consultar"}
        </button>
      </div>

      {resultado && (
        <div className="mt-4">
          {resultado.error ? (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {resultado.error}
            </div>
          ) : resultado.referencias.length === 0 ? (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              {resultado.mensaje}
            </div>
          ) : (
            <>
              {/* Atributos detectados + confianza */}
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                {resultado.atributos &&
                  [
                    resultado.atributos.tipoTrabajo,
                    resultado.atributos.oficio,
                    resultado.atributos.problema,
                    resultado.atributos.instalacionAfectada,
                  ]
                    .filter(Boolean)
                    .map((a) => (
                      <span key={a} className="text-[11px] font-medium text-purple-800 bg-purple-50 border border-purple-200 rounded-full px-2 py-0.5">
                        {a}
                      </span>
                    ))}
                {resultado.confianza && (
                  <span
                    className={`ml-auto text-[11px] font-bold rounded-full px-2 py-0.5 border ${
                      resultado.confianza === "alta"
                        ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                        : resultado.confianza === "media"
                        ? "text-amber-700 bg-amber-50 border-amber-200"
                        : "text-red-600 bg-red-50 border-red-200"
                    }`}
                  >
                    Confianza: {resultado.confianza}
                  </span>
                )}
              </div>

              {/* Sugerencia en rangos */}
              <div className="grid grid-cols-4 gap-3 mb-3">
                <SugCard
                  icon={<Clock size={15} />}
                  label="Horas"
                  valor={
                    resultado.estadisticas?.horas?.conDato > 0
                      ? resultado.sugerencia.rangoHoras && resultado.sugerencia.rangoHoras[1] > 0
                        ? `${resultado.sugerencia.rangoHoras[0].toFixed(1)} – ${resultado.sugerencia.rangoHoras[1].toFixed(1)} h`
                        : `${resultado.sugerencia.horasEstimadas.toFixed(1)} h`
                      : "Sin datos"
                  }
                  sub={
                    resultado.estadisticas?.horas?.conDato > 0
                      ? `mediana ${resultado.sugerencia.horasEstimadas.toFixed(1)} h`
                      : "requiere líneas o facturas"
                  }
                />
                <SugCard
                  icon={<Package size={15} />}
                  label="Materiales"
                  valor={
                    resultado.estadisticas?.materiales?.conDato > 0
                      ? eur(resultado.sugerencia.importeMateriales)
                      : "Sin datos"
                  }
                />
                <SugCard
                  icon={<Truck size={15} />}
                  label="Desplazam."
                  valor={
                    resultado.sugerencia.cobrarDesplazamiento == null
                      ? "Sin datos"
                      : resultado.sugerencia.cobrarDesplazamiento
                      ? "Sí"
                      : "No"
                  }
                  sub={
                    resultado.estadisticas?.pctDesplazamiento != null
                      ? `${Math.round(resultado.estadisticas.pctDesplazamiento * 100)}% de casos similares`
                      : "requiere líneas de venta (API)"
                  }
                />
                <SugCard
                  icon={<TrendingUp size={15} />}
                  label="Importe recomendado"
                  valor={
                    resultado.estadisticas?.importeTotal?.conDato > 0
                      ? resultado.sugerencia.rangoImporteTotal
                        ? `${eur(resultado.sugerencia.rangoImporteTotal[0])} – ${eur(resultado.sugerencia.rangoImporteTotal[1])}`
                        : eur(resultado.sugerencia.importeTotalOrientativo)
                      : "Sin importes"
                  }
                  sub={
                    resultado.estadisticas?.importeTotal?.conDato > 0
                      ? `mediana ${eur(resultado.sugerencia.importeTotalOrientativo)}`
                      : "carga CSV con P venta / facturas"
                  }
                  destacado
                />
              </div>

              {/* Explicación del motivo */}
              {resultado.explicacion && (
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 mb-3">
                  <span className="font-semibold text-slate-700">Motivo: </span>
                  {resultado.explicacion}
                </div>
              )}

              {/* Recomendación combinada con tarifa actual */}
              {resultado.recomendacionCombinada && (
                <div
                  className={`text-xs rounded-md px-3 py-2.5 mb-3 border ${
                    resultado.recomendacionCombinada.contraste === "coherente"
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-amber-50 border-amber-300 text-amber-900"
                  }`}
                >
                  <div className="font-semibold mb-1">
                    Recomendación a tarifa actual ({resultado.recomendacionCombinada.tarifaHora}€/h):{" "}
                    {eur(resultado.recomendacionCombinada.rangoTotal[0])} – {eur(resultado.recomendacionCombinada.rangoTotal[1])}
                  </div>
                  <div className="opacity-90">
                    Mano de obra {eur(resultado.recomendacionCombinada.rangoManoObra[0])}–{eur(resultado.recomendacionCombinada.rangoManoObra[1])}
                    {resultado.recomendacionCombinada.rangoMaterial[1] > 0 && (
                      <> + material {eur(resultado.recomendacionCombinada.rangoMaterial[0])}–{eur(resultado.recomendacionCombinada.rangoMaterial[1])}</>
                    )}
                    {resultado.recomendacionCombinada.desplazamiento > 0 && (
                      <> + desplazamiento {eur(resultado.recomendacionCombinada.desplazamiento)}</>
                    )}
                  </div>
                  <div className="mt-1">{resultado.recomendacionCombinada.textoContraste}</div>
                </div>
              )}

              {/* Material habitual en trabajos similares (lógica 10) */}
              {resultado.estadisticas?.materialesFrecuentes?.familias?.length > 0 && (
                <div className="text-xs bg-sky-50 border border-sky-200 rounded-md px-3 py-2.5 mb-3">
                  <div className="font-semibold text-sky-900 mb-1.5">
                    🧰 Material habitual en trabajos similares
                    <span className="font-normal text-sky-700/70">
                      {" "}(según {resultado.estadisticas.materialesFrecuentes.baseOTs} OTs con detalle de líneas)
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {resultado.estadisticas.materialesFrecuentes.familias.map((f) => (
                      <div key={f.familia} className="flex items-baseline gap-2">
                        <span className="font-semibold text-sky-900 whitespace-nowrap">
                          {f.familia} — {Math.round(f.pct * 100)}%
                        </span>
                        {f.ejemplos.length > 0 && (
                          <span className="text-sky-800/70 truncate">ej.: {f.ejemplos.join(" · ")}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Avisos */}
              {resultado.avisos?.length > 0 && (
                <div className="flex flex-col gap-1.5 mb-3">
                  {resultado.avisos.map((a, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Referencias */}
              <div className="text-xs text-slate-500 mb-1">Basado en estas OTs históricas:</div>
              <div className="flex flex-col gap-1">
                {resultado.referencias.map((ref) => (
                  <div key={ref.numeroOT} className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5">
                    <span className="truncate">
                      <span className="font-semibold text-slate-700">OT {ref.numeroOT}</span>
                      {ref.segmento && (
                        <span className="ml-1 text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 py-0.5">
                          {ref.segmento}
                        </span>
                      )}
                      <span className="text-slate-400"> · {ref.cliente} · </span>
                      <span className="text-slate-600">{ref.descripcion}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-slate-500">{eur(ref.facturado)}</span>
                      <span className="text-[10px] font-bold text-purple-700 bg-purple-100 rounded-full px-1.5 py-0.5">
                        {Math.round(ref.similitud * 100)}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-slate-400 mt-2">{resultado.mensaje}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SugCard({ icon, label, valor, sub, destacado }) {
  return (
    <div className={`rounded-lg px-3 py-2.5 border ${destacado ? "bg-purple-600 border-purple-600 text-white" : "bg-white border-slate-200"}`}>
      <div className={`flex items-center gap-1 text-[11px] ${destacado ? "text-purple-100" : "text-slate-500"}`}>
        {icon} {label}
      </div>
      <div className={`text-base font-bold mt-0.5 ${destacado ? "text-white" : "text-slate-800"}`}>{valor}</div>
      {sub && <div className={`text-[11px] ${destacado ? "text-purple-100" : "text-slate-400"}`}>{sub}</div>}
    </div>
  );
}

// Formato de euros compartido por todas las pantallas
const eur = (n) => (n == null ? "—" : `${Math.round(n).toLocaleString("es-ES")} €`);
// Precios UNITARIOS: con decimales (hasta 3 si hacen falta, p.ej. cable a
// 0,775 €/m), para que cantidad × precio cuadre con el importe mostrado.
const eurUnit = (n) =>
  n == null
    ? "—"
    : `${Number(n).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: Math.abs(n) < 10 ? 3 : 2 })} €`;

// Red de seguridad: si algo falla al renderizar, se muestra el error en
// pantalla (nunca más una página en blanco sin explicación)
class CapturaErrores extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-red-50 p-8">
          <div className="max-w-2xl mx-auto bg-white border border-red-300 rounded-lg p-6">
            <h1 className="text-lg font-bold text-red-700 mb-2">⚠ Error en la aplicación</h1>
            <p className="text-sm text-slate-700 mb-3">
              Copia este mensaje y pásaselo a Claude. Causa probable: versiones mezcladas de archivos
              (reemplaza <b>src/ completo</b> + backend/server.cjs + package.json del mismo zip, luego npm install).
            </p>
            <pre className="text-xs bg-slate-100 border border-slate-200 rounded p-3 overflow-auto whitespace-pre-wrap">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CargarDatosVentas({ usuario = null, onLogout = null }) {
  // Ventana nueva de OTs (pestaña propia): #/ots
  const esVentanaOTs = typeof window !== "undefined" && window.location.hash === "#/ots";
  return (
    <CapturaErrores>
      {esVentanaOTs ? <PantallaOTs /> : <PantallaPrincipal usuario={usuario} onLogout={onLogout} />}
    </CapturaErrores>
  );
}


// ---------------------------------------------------------------------
// CACHÉ DE FILAS DE BC: se guardan TODAS las columnas tal cual llegan
// (sin recorte). Antes se recortaba a una lista fija de campos y eso
// hacía "desaparecer" columnas (proveedor, descuentos...) cuando se
// necesitaban. Pedidos de venta y Contabilidad no alimentan la memoria:
// de esas solo se guarda una vista previa limitada en FILAS (no en
// columnas) para no inflar el estado con datos que no se usan.
// ---------------------------------------------------------------------
const RECORTE_POR_FUENTE = {
  movs_contabilidad: "PREVIA",
};
const MAX_FILAS_PREVIA = 1000;

function recortarFilas(sourceId, filas) {
  const regla = RECORTE_POR_FUENTE[sourceId];
  if (regla === "PREVIA") return filas.slice(0, MAX_FILAS_PREVIA);
  return filas; // TODAS las columnas, TODAS las filas
}

function PantallaPrincipal({ usuario = null, onLogout = null }) {
  const [data, setData] = useState(() =>
    Object.fromEntries(SOURCES.map((s) => [s.id, { cached: [], totalRows: 0, rows: [] }]))
  );
  const [estadoInicial, setEstadoInicial] = useState(null);

  // Restaurar el estado persistido (una vez, al montar)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/estado");
        if (!r.ok) return;
        const est = await r.json();
        if (est.bcData) {
          setData((prev) => {
            const next = { ...prev };
            for (const id of Object.keys(next)) {
              if (est.bcData[id]) next[id] = { rows: [], cached: [], totalRows: 0, ...est.bcData[id] };
            }
            return next;
          });
        }
        setEstadoInicial(est);
      } catch {
        /* backend apagado: sin restauración */
      }
    })();
  }, []);

  const persistirBcData = (next) => {
    fetch("/api/estado", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bcData: next }),
    }).catch(() => {});
  };

  const handleLoad = (sourceId, range, newRows, newData) => {
    setData((prev) => {
      const cur = prev[sourceId];
      const merged = mergeRanges([...cur.cached, range]);
      const nuevas = newData?.length ? recortarFilas(sourceId, newData) : [];
      let rows = nuevas.length ? [...cur.rows, ...nuevas] : cur.rows;
      if (RECORTE_POR_FUENTE[sourceId] === "PREVIA" && rows.length > MAX_FILAS_PREVIA) {
        rows = rows.slice(0, MAX_FILAS_PREVIA); // vista previa acotada
      }
      const next = {
        ...prev,
        [sourceId]: {
          cached: merged,
          totalRows: cur.totalRows + newRows,
          rows,
        },
      };
      persistirBcData(next);
      return next;
    });
  };

  const handleClear = (sourceId) => {
    setData((prev) => {
      const next = { ...prev, [sourceId]: { cached: [], totalRows: 0, rows: [] } };
      persistirBcData(next);
      return next;
    });
  };

  // Añade la columna "Created_By_User_Name" a los pedidos ya cargados,
  // a partir de un mapa {NºPedido → creador} leído de un Excel de BC.
  // Devuelve cuántos pedidos se han enriquecido.
  const enriquecerPedidosConExcel = (mapaCreador) => {
    let tocados = 0;
    setData((prev) => {
      const ped = prev["pedidos_compra"];
      if (!ped?.rows?.length) return prev;
      // localizar la columna de Nº en las filas de BC
      const h = Object.keys(ped.rows[0] || {});
      const low = h.map((x) => x.toLowerCase());
      const colNo = h[low.findIndex((x) => /^no$/.test(x) || /^nº$/.test(x) || /document_no/.test(x))] || h[0];
      const rows = ped.rows.map((r) => {
        const pc = String(r[colNo] || "").trim().toUpperCase();
        const creador = mapaCreador[pc];
        if (creador) { tocados++; return { ...r, Created_By_User_Name: creador }; }
        return r;
      });
      const next = { ...prev, pedidos_compra: { ...ped, rows } };
      persistirBcData(next);
      return next;
    });
    return tocados;
  };

  const summary = useMemo(() => {
    const loaded = SOURCES.filter((s) => data[s.id].cached.length > 0).length;
    const totalRows = SOURCES.reduce((a, s) => a + data[s.id].totalRows, 0);
    return { loaded, totalRows };
  }, [data]);

  const [seccion, setSeccion] = useState("cargar"); // cargar | memoria | explorador | recepcion
  const [actualizandoRecep, setActualizandoRecep] = useState(false);
  const [tareaPendiente, setTareaPendiente] = useState(null); // tarea creada desde Correo

  // El Correo llama a esto para crear una tarea; cambia a la pantalla Tareas.
  const crearTareaDesdeCorreo = (tarea) => {
    setTareaPendiente({ ...tarea, _extId: tarea._extId || ("mail-" + Date.now()) });
    setSeccion("tareas");
  };

  // Refresca desde BC las dos fuentes que alimentan Recepción: líneas de
  // compra (importes/pendientes) y cabeceras de pedido (proveedor, fechas…).
  const actualizarRecepcionBC = async () => {
    setActualizandoRecep(true);
    try {
      const hoy = todayISO();
      const desde = "2020-01-01"; // recepción mira histórico amplio de pedidos vivos
      for (const fuente of ["lineas_compra", "pedidos_compra"]) {
        const res = await fetchFromBC(fuente, desde, hoy);
        if (!res.error && res.data?.length) {
          setData((prev) => {
            const next = {
              ...prev,
              [fuente]: { cached: [{ from: desde, to: hoy }], totalRows: res.data.length, rows: res.data },
            };
            persistirBcData(next);
            return next;
          });
        }
      }
    } finally {
      setActualizandoRecep(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-100 font-sans">
      {/* Sidebar */}
      <aside className="w-60 min-h-screen bg-[#0f2947] text-white flex flex-col shrink-0">
        <div className="px-5 py-5 border-b border-white/10">
          <div className="font-bold tracking-wide text-sm">ALSO CASALS</div>
          <div className="text-[11px] text-blue-200 tracking-wider mt-0.5">AGENTE DE VENTAS</div>
          {(usuario || onLogout) && (
            <div className="mt-3 space-y-2">
              {usuario && (
                <div
                  className="text-xs text-blue-100/90 truncate"
                  title={usuario.email || usuario.username || ""}
                >
                  {usuario.nom_treballador || usuario.nombre || usuario.username || "Usuario"}
                </div>
              )}
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="w-full rounded-md border border-white/30 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20 transition-colors"
                >
                  Cerrar sesión
                </button>
              )}
            </div>
          )}
        </div>
        <nav className="flex-1 py-2 text-sm overflow-y-auto">
          <div
            onClick={() => setSeccion("cargar")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "cargar" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Cargar datos
          </div>
          <div
            onClick={() => setSeccion("memoria")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "memoria" ? "bg-purple-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            ✦ Memoria histórica
          </div>
          <div
            onClick={() => setSeccion("explorador")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "explorador" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Explorador de OTs
          </div>
          <div
            onClick={() => setSeccion("recepcion")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "recepcion" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Recepción de material
          </div>
          <div
            onClick={() => setSeccion("facturascompra")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "facturascompra" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Validación de facturas
          </div>
          <div
            onClick={() => setSeccion("precios")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "precios" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Precios de artículos
          </div>
          <div
            onClick={() => setSeccion("pedidosventa")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "pedidosventa" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Pedidos de venta
          </div>
          <div
            onClick={() => setSeccion("correo")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "correo" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Correo
          </div>
          <div
            onClick={() => setSeccion("tareas")}
            className={`px-5 py-2.5 cursor-pointer ${
              seccion === "tareas" ? "bg-blue-700 font-medium" : "text-blue-100/80 hover:bg-white/5"
            }`}
          >
            Mis tareas
          </div>

          <div className="px-5 pt-4 pb-1 text-[10px] tracking-widest text-blue-300/50 font-bold">
            HOJA DE RUTA
          </div>
          {[
            "Explorar datos",
            "Pedidos de venta",
            "Análisis de rentabilidad",
            "Precios de artículos",
            "Análisis por cliente",
            "Comparar periodos",
          ].map((item) => (
            <div
              key={item}
              className="px-5 py-2 text-blue-100/30 cursor-not-allowed select-none"
              title="Pendiente de construir — hoja de ruta"
            >
              {item}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8">
        {seccion === "explorador" ? (
          <PantallaOTs incrustada />
        ) : seccion === "recepcion" ? (
          <Recepcion
            pedidos={{ headers: Object.keys(data["pedidos_compra"]?.rows?.[0] || {}), rows: data["pedidos_compra"]?.rows || [] }}
            lineas={{ headers: Object.keys(data["lineas_compra"]?.rows?.[0] || {}), rows: data["lineas_compra"]?.rows || [] }}
            onActualizarBC={actualizarRecepcionBC}
            actualizando={actualizandoRecep}
          />
        ) : seccion === "facturascompra" ? (
          <FacturasCompra
            pedidos={{ headers: Object.keys(data["pedidos_compra"]?.rows?.[0] || {}), rows: data["pedidos_compra"]?.rows || [] }}
            usuario={usuario}
          />
        ) : seccion === "precios" ? (
          <Precios
            lineas={{ headers: Object.keys(data["lineas_compra"]?.rows?.[0] || {}), rows: data["lineas_compra"]?.rows || [] }}
            pedidos={{ headers: Object.keys(data["pedidos_compra"]?.rows?.[0] || {}), rows: data["pedidos_compra"]?.rows || [] }}
          />
        ) : seccion === "pedidosventa" ? (
          <PedidosVentaPendientes />
        ) : seccion === "correo" ? (
          <Correo onCrearTarea={crearTareaDesdeCorreo} usuario={usuario} />
        ) : seccion === "tareas" ? (
          <Tareas pendienteAlta={tareaPendiente} />
        ) : seccion === "memoria" ? (
          <>
            <div className="flex items-center gap-2">
              <Sparkles size={22} className="text-purple-600" />
              <h1 className="text-2xl font-bold text-slate-800">Memoria histórica</h1>
            </div>
            <p className="text-slate-500 text-sm mt-1 max-w-3xl">
              Cruza las facturas de venta, las líneas de BC y el listado descriptivo de OT's para aprender qué se
              cobró en cada trabajo. Cuando entre una OT nueva, el agente sugiere qué cobrar basándose en trabajos
              parecidos. Los datos de Business Central se cargan en la sección «Cargar datos».
            </p>
            <section className="mt-6">
              <IntelligentAgentCard bcData={data} estadoInicial={estadoInicial} />
            </section>
          </>
        ) : (
          <>
        <h1 className="text-2xl font-bold text-slate-800">Cargar datos</h1>
        <p className="text-slate-500 text-sm mt-1">
          Conecta con Business Central para traer los datos del departamento de ventas. Se guardan en caché por rango de fechas.
        </p>

        {/* Resumen */}
        <div className="grid grid-cols-4 gap-4 mt-6">
          <div className="bg-white rounded-xl border border-slate-200 px-5 py-4">
            <div className="text-2xl font-bold text-slate-800">
              {summary.loaded}/{SOURCES.length}
            </div>
            <div className="text-xs text-slate-500 mt-1">Fuentes cargadas</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 px-5 py-4">
            <div className="text-2xl font-bold text-slate-800">{summary.totalRows.toLocaleString()}</div>
            <div className="text-xs text-slate-500 mt-1">Filas totales</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 px-5 py-4 col-span-2 flex items-center">
            <div className="text-xs text-slate-500">
              Origen: <span className="font-medium text-slate-700">API Business Central</span>
              <br />
              La carga es incremental: si un rango ya está en caché, no se vuelve a pedir a la API.
            </div>
          </div>
        </div>

        {/* Tarjetas de fuentes */}
        <div className="grid grid-cols-3 gap-5 mt-6">
          {SOURCES.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              state={data[s.id]}
              onLoad={handleLoad}
              onClear={handleClear}
              onEnriquecerExcel={enriquecerPedidosConExcel}
            />
          ))}
        </div>

        {/* Acceso directo a la memoria */}
        <button
          onClick={() => setSeccion("memoria")}
          className="mt-8 w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-xl py-3 transition-colors"
        >
          <Sparkles size={16} /> Ir a Memoria histórica → construir y consultar
        </button>
          </>
        )}
      </main>
    </div>
  );
}

        {/* La memoria histórica vive ahora en su propia sección del menú */}
