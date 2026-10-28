/**
 * Simulador de tarifas 2027 — revisió per client sense tocar la tarifa 2026.
 * Fórmula: tarifaObjetivo = (costePrevisto × (1 + % estructura)) / (1 - margenObjetivo).
 */
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, RotateCcw, Save, Search, SlidersHorizontal } from "lucide-react";
import { normalizarNumeroOT } from "./agenteInteligente.js";

const TARIFA_COSTE_MO = 21.5;
const DEF_COSTE_2027 = 26;
const DEF_MARGEN_OBJ = 0.3;
const DEF_ESTRUCTURA = 0.22; // mateix criteri que Anàlisi / pedits de venda
const TOLERANCIA_MARGEN = 0.02;

function leer(row, nombres) {
  if (!row || typeof row !== "object") return "";
  for (const n of nombres) {
    const v = row[n];
    if (v != null && String(v).trim() !== "") return v;
  }
  const mapa = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const n of nombres) {
    const k = mapa.get(String(n).toLowerCase());
    if (k != null && row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return "";
}

function numBC(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null || v === "") return 0;
  let s = String(v).trim().replace(/\s|€/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function fechaISO(s) {
  const t = String(s || "");
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (iso) return iso[1];
  const es = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (es) return `${es[3]}-${es[2].padStart(2, "0")}-${es[1].padStart(2, "0")}`;
  return "";
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function inicioAnioISO() {
  return `${new Date().getFullYear()}-01-01`;
}

function enPeriodo(fecha, desde, hasta) {
  if (!fecha) return false;
  if (desde && fecha < desde) return false;
  if (hasta && fecha > hasta) return false;
  return true;
}

function claveOt(s) {
  return normalizarNumeroOT(s);
}

function claveCliente(doc) {
  return doc.clienteN || doc.cliente || "";
}

const eur2 = (n) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : `${Number(n).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;
const pctSigned = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n * 100;
  const s = v.toLocaleString("es-ES", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  return `${s} %`;
};

function normalizarFactura(row) {
  const numero = String(leer(row, ["number", "No", "No.", "Document_No"]) || "").trim();
  return {
    id: String(row.id || numero),
    numero,
    fecha: fechaISO(leer(row, ["invoiceDate", "postingDate", "Posting_Date", "Document_Date"])),
    cliente: String(leer(row, ["customerName", "billToName", "Sell_to_Customer_Name", "Bill_to_Name"]) || "").trim(),
    clienteN: String(leer(row, ["customerNumber", "Sell_to_Customer_No", "Bill_to_Customer_No"]) || "").trim(),
    ot: String(leer(row, ["noOT", "shortcutDimension2Code", "Shortcut_Dimension_2_Code", "jobNo", "Job_No"]) || "").trim(),
    base: numBC(leer(row, ["totalAmountExcludingTax", "Amount"])),
  };
}

function normalizarAbono(row) {
  const numero = String(leer(row, ["number", "No", "No.", "Document_No"]) || "").trim();
  return {
    id: String(row.id || numero),
    numero,
    fecha: fechaISO(leer(row, ["creditMemoDate", "invoiceDate", "postingDate", "Posting_Date", "Document_Date"])),
    cliente: String(leer(row, ["customerName", "billToName", "Sell_to_Customer_Name", "Bill_to_Name"]) || "").trim(),
    clienteN: String(leer(row, ["customerNumber", "Sell_to_Customer_No", "Bill_to_Customer_No"]) || "").trim(),
    base: Math.abs(numBC(leer(row, ["totalAmountExcludingTax", "Amount"]))),
  };
}

function indiceFichasPorOt(fichas) {
  const mapa = new Map();
  for (const f of fichas || []) {
    const g = f.general || f;
    const ot = claveOt(g.numeroOT || f.numeroOT || g.numeroOTOrigenes?.listado || "");
    if (ot) mapa.set(ot, f);
  }
  return mapa;
}

function costesDesDeLineas(lineasVenta, lineasCompra, movsProyecto, horasControl) {
  const mapa = new Map();
  const get = (ot) => {
    const k = claveOt(ot);
    if (!k) return null;
    if (!mapa.has(k)) mapa.set(k, { material: 0, horas: 0 });
    return mapa.get(k);
  };
  for (const l of lineasCompra || []) {
    const row = get(leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT", "Job_No", "jobNo"]));
    if (!row) continue;
    const importe = numBC(leer(l, ["Line_Amount", "lineAmount", "Amount", "Importe línea", "importe"]));
    if (importe) row.material += importe;
    else {
      const qty = numBC(leer(l, ["Quantity", "quantity", "Cantidad"]));
      const cost = numBC(leer(l, ["Direct_Unit_Cost", "directUnitCost", "Unit_Cost", "Coste unitario"]));
      row.material += qty * cost;
    }
  }
  for (const l of movsProyecto || []) {
    const tipo = String(leer(l, ["Type", "Ledger_Entry_Type", "type"]) || "").toLowerCase();
    if (!/resour|recurs/.test(tipo)) continue;
    const entry = String(leer(l, ["Entry_Type", "Entry Type"]) || "").toLowerCase();
    if (entry && entry !== "usage" && entry !== "uso" && entry !== "0") continue;
    const row = get(leer(l, ["Job_No", "Global_Dimension_2_Code", "Shortcut_Dimension_2_Code", "jobNo", "noOT"]));
    if (!row) continue;
    row.horas += numBC(leer(l, ["Quantity", "Quantity_Base", "quantity"]));
  }
  for (const f of horasControl || []) {
    const row = get(f.ot);
    if (!row || row.horas > 0) continue;
    row.horas += Number(f.horas) || 0;
  }
  for (const l of lineasVenta || []) {
    const row = get(leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT", "Job_No", "jobNo"]));
    if (!row || row.horas > 0) continue;
    const tipo = String(leer(l, ["Type", "type", "Tipo"]) || "").toLowerCase();
    const desc = String(leer(l, ["Description", "description"]) || "").toLowerCase();
    const esHoras =
      tipo.includes("resource") ||
      tipo.includes("recurso") ||
      /\bhora|\bm\.?o\.?\b|mano de obra|mà d'obra|ma d'obra/.test(desc);
    if (esHoras) row.horas += numBC(leer(l, ["Quantity", "quantity", "Cantidad"]));
  }
  return mapa;
}

function otsPerFacturaDesDeLineas(lineasVenta) {
  const mapa = new Map();
  for (const l of lineasVenta || []) {
    const doc = String(leer(l, ["Document_No", "documentNo", "documentNumber", "No"]) || "").trim();
    const ot = claveOt(leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT", "Job_No", "jobNo"]));
    if (!doc || !ot) continue;
    const importe = numBC(leer(l, ["Line_Amount", "lineAmount", "Amount", "Importe línea"]));
    if (!mapa.has(doc)) mapa.set(doc, new Map());
    const porOt = mapa.get(doc);
    porOt.set(ot, (porOt.get(ot) || 0) + importe);
  }
  const out = new Map();
  for (const [doc, porOt] of mapa) {
    out.set(
      doc,
      [...porOt.entries()].map(([ot, importe]) => ({ ot, importe }))
    );
  }
  return out;
}

function costesDeFicha(ficha, fallbackLineas) {
  let material = Number(ficha?.compra?.costeRealOT) || 0;
  if (!material) material = Number(ficha?.compra?.comprasReales?.importe) || 0;
  let horas = 0;
  if (fallbackLineas?.horas > 0) horas = fallbackLineas.horas;
  if (!horas) horas = Number(ficha?.venta?.horas?.cantidad) || 0;
  if (!horas) horas = Number(ficha?.resumenOT?.numeroHoras) || 0;
  if (!material && fallbackLineas) material = fallbackLineas.material || 0;
  const mo = horas * TARIFA_COSTE_MO;
  const ingresosHist =
    Number(ficha?.venta?.importeCuentaVentas) ||
    Number(ficha?.venta?.importeTotalFacturado) ||
    Number(ficha?.resumenOT?.pVenta) ||
    0;
  const tiene = !!(ficha || (fallbackLineas && (fallbackLineas.material || fallbackLineas.horas)));
  return { material, horas, mo, ingresosHist, tiene };
}

function costesPeriodoOt(ficha, ingresosOt, fallbackLineas) {
  const c = costesDeFicha(ficha, fallbackLineas);
  if (!c.tiene) return { material: 0, mo: 0, horas: 0, sinFicha: !ficha };
  const baseIng = c.ingresosHist > 0 ? c.ingresosHist : ingresosOt;
  const factor = baseIng > 0 ? Math.min(1, Math.max(0, ingresosOt / baseIng)) : 1;
  return {
    material: c.material * factor,
    mo: c.mo * factor,
    horas: c.horas * factor,
    sinFicha: !ficha,
  };
}

function fechaCorta(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

/** Panel «d'on surt» el marge 2026 d'un client del llistat. */
function PanelOrigenMarge({ cliente, desde, hasta, onTancar }) {
  if (!cliente) return null;
  const ots = cliente.ots || [];
  return (
    <div className="xr-origen mt-3">
      <div className="xr-origen-cap">
        <div>
          <div className="eyebrow">Origen de la dada</div>
          <h3>Marge 2026 · {cliente.nombre}</h3>
        </div>
        <button type="button" onClick={onTancar} className="xr-btn-ghost">
          Tancar
        </button>
      </div>
      <p className="text-sm mb-1">
        <span className="font-semibold">Valor: </span>
        {eur2(cliente.margen)} ({pct(cliente.margenPct)})
      </p>
      <p className="text-xs text-slate-500 mb-1">
        Període: {fechaCorta(desde)} – {fechaCorta(hasta)}
      </p>
      <p className="text-sm mb-1">Fórmula: (venda neta − material − mà d&apos;obra) ÷ venda neta.</p>
      <p className="text-xs text-slate-500 mb-3">
        MO = hores × {TARIFA_COSTE_MO} €/h, escalades a la facturació del període vs ingressos històrics de cada OT.
      </p>
      <ul className="text-sm mb-3 list-disc pl-5 space-y-0.5 text-slate-700">
        <li>Venda neta (factures − abonaments): {eur2(cliente.neta)}</li>
        <li>− Material: {eur2(cliente.material)}</li>
        <li>− Mà d&apos;obra: {eur2(cliente.mo)}</li>
        <li>= Marge: {eur2(cliente.margen)} ({pct(cliente.margenPct)})</li>
        <li>
          {cliente.nFacturas} factura(s) · {ots.length} OT(s) amb ingressos al període
        </li>
      </ul>
      {ots.length > 0 ? (
        <div className="tabla-wrap">
          <table>
            <thead>
              <tr>
                <th>OT</th>
                <th className="text-right">Ingressos</th>
                <th className="text-right">Material</th>
                <th className="text-right">Hores</th>
                <th className="text-right">MO €</th>
                <th className="text-right">Marge OT</th>
                <th>Estat</th>
              </tr>
            </thead>
            <tbody>
              {ots.map((o) => (
                <tr key={o.ot}>
                  <td className="font-mono text-xs">{o.ot}</td>
                  <td className="text-right tabular-nums">{eur2(o.ingresos)}</td>
                  <td className="text-right tabular-nums">{eur2(o.material)}</td>
                  <td className="text-right tabular-nums">
                    {(o.horas || 0).toLocaleString("es-ES", { maximumFractionDigits: 1 })} h
                  </td>
                  <td className="text-right tabular-nums">{eur2(o.mo)}</td>
                  <td className={`text-right tabular-nums ${o.margen < 0 ? "text-red-700" : ""}`}>
                    {eur2(o.margen)}
                  </td>
                  <td className="text-xs text-slate-500">{o.sinFicha ? "sense fitxa / línies" : "ok"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-amber-800">
          No s&apos;han pogut repartir ingressos per OT (falten línies o dimensió OT a les factures). El marge usa
          venda neta sense cost associat per OT.
        </p>
      )}
    </div>
  );
}

/** Coste MO amb estructura: coste × (1 + pctEstructura). */
export function costeConEstructura(coste, pctEstructura) {
  const c = Number(coste);
  const e = Number(pctEstructura);
  if (!(c > 0)) return null;
  if (!Number.isFinite(e) || e < 0) return c;
  return c * (1 + e);
}

/** tarifaObj = costeConEstructura / (1 - margen) */
export function tarifaObjetivo(coste, margen, pctEstructura = 0) {
  const c = costeConEstructura(coste, pctEstructura);
  const m = Number(margen);
  if (c == null || !(c > 0) || !(m < 1) || m < 0) return null;
  if (m >= 0.99) return null;
  return c / (1 - m);
}

function mediaHNormal(filas) {
  const vals = (filas || [])
    .filter((f) => String(f.tipoTrabajo || "").toUpperCase() === "H_NORMAL" && Number(f.precio) > 0)
    .map((f) => Number(f.precio));
  if (!vals.length) {
    const cualquier = (filas || []).map((f) => Number(f.precio)).filter((p) => p > 0);
    if (!cualquier.length) return null;
    return cualquier.reduce((a, b) => a + b, 0) / cualquier.length;
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function recomendar(margen2026, objetivo) {
  if (margen2026 == null || !Number.isFinite(margen2026)) {
    return { clave: "nd", etiqueta: "Sense dades", to: "muted" };
  }
  if (margen2026 < 0) return { clave: "urgente", etiqueta: "Revisión urgente", to: "mal" };
  if (margen2026 < objetivo - TOLERANCIA_MARGEN) return { clave: "subir", etiqueta: "Subir tarifas", to: "mal" };
  if (Math.abs(margen2026 - objetivo) <= TOLERANCIA_MARGEN) return { clave: "mantener", etiqueta: "Mantener", to: "ok" };
  return { clave: "estudiar", etiqueta: "Estudiar condiciones", to: "neutro" };
}

function SeccioXR({ titol, sub, children, className = "" }) {
  return (
    <section className={`xr-panel ${className}`.trim()}>
      {titol ? <h2>{titol}</h2> : null}
      {sub ? <p className="xr-panel-sub">{sub}</p> : null}
      {children}
    </section>
  );
}

function badgeCls(tono) {
  if (tono === "mal") return "text-red-700 bg-red-50 border-red-200";
  if (tono === "ok") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (tono === "neutro") return "text-slate-700 bg-slate-50 border-slate-200";
  return "text-slate-500 bg-slate-50 border-slate-200";
}

function NumClicable({ children, activa, className = "", title = "Clic per veure l'origen", onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`tabular-nums underline decoration-dotted underline-offset-2 ${activa ? "bg-cyan-100 rounded px-1" : ""} ${className}`.trim()}
    >
      {children}
    </button>
  );
}

/** Explica d'on surt un número d'una línia de tarifa. */
function PanelOrigenLinea({ linea, campo, ctx, onTancar }) {
  if (!linea || !campo || !ctx) return null;
  const tipus = String(linea.tipoTrabajo || "").replace(/^H_/, "") || "—";
  const titolLinia = `${linea.producto} · ${tipus}`;

  const blocs = {
    actual: {
      titol: "Precio actual",
      valor: eur2(linea.actual),
      formula: "Preu de venda de la línia al Excel de tarifes 2026 (ACSales).",
      font: `Origen fitxer: ${ctx.origenExcel || "—"}${ctx.usaEspecial ? " · tarifa especial del client" : " · tarifa general"}.`,
      linies: [
        `Producte: ${linea.producto}`,
        `Descripció: ${linea.descripcion || "—"}`,
        `Tipus d'hora: ${linea.tipoTrabajo || "—"}`,
        `Precio venta (Excel) = ${eur2(linea.actual)}`,
      ],
    },
    coste: {
      titol: "Coste + estructura",
      valor: eur2(linea.costeLin),
      formula:
        "Coste de la línia = precio actual × (coste MO amb estructura ÷ tarifa de referència H_NORMAL).",
      font: "El % d'estructura s'aplica al coste previst abans de repartir-lo a cada línia.",
      linies: [
        `Precio actual línia: ${eur2(linea.actual)}`,
        `Coste MO previst: ${eur2(ctx.costePrevisto)}/h`,
        `% estructura: ${pct(ctx.pctEstructura)}`,
        `Coste MO + estructura: ${eur2(ctx.costePrevisto)} × (1 + ${pct(ctx.pctEstructura)}) = ${eur2(ctx.costeTotal)}/h`,
        `Tarifa referència (mitjana H_NORMAL): ${eur2(ctx.tarifaRef)}/h`,
        `Ratio = ${eur2(ctx.costeTotal)} ÷ ${eur2(ctx.tarifaRef)} = ${
          ctx.tarifaRef > 0 ? (ctx.costeTotal / ctx.tarifaRef).toLocaleString("es-ES", { maximumFractionDigits: 4 }) : "—"
        }`,
        `Coste línia = ${eur2(linea.actual)} × ratio = ${eur2(linea.costeLin)}`,
      ],
    },
    recomendada: {
      titol: "Tarifa recomendada",
      valor: eur2(linea.recomendada),
      formula:
        "Recomendada = precio actual × (1 + ajuste %). L'ajust surt de comparar la tarifa objectiu amb la tarifa actual de referència.",
      font: "Tarifa objectiu = (coste MO + estructura) ÷ (1 − margen objectiu).",
      linies: [
        `Coste MO + estructura: ${eur2(ctx.costeTotal)}/h`,
        `Margen objectiu: ${pct(ctx.margenObjetivo)}`,
        `Tarifa objectiu = ${eur2(ctx.costeTotal)} ÷ (1 − ${pct(ctx.margenObjetivo)}) = ${eur2(ctx.tarifaObj)}`,
        `Tarifa actual de referència (simulador): ${eur2(ctx.tarifaActual)}`,
        `Ajuste = ${eur2(ctx.tarifaObj)} ÷ ${eur2(ctx.tarifaActual)} − 1 = ${pctSigned(ctx.ajuste)}`,
        `Recomendada línia = ${eur2(linea.actual)} × (1 + ${pctSigned(ctx.ajuste)}) = ${eur2(linea.recomendada)}`,
      ],
    },
    variacion: {
      titol: "% variación",
      valor: pctSigned(linea.variacion),
      formula: "% variación = tarifa recomendada ÷ precio actual − 1.",
      font: "Mateix % per a totes les línies si s'aplica l'ajust global; aquí es mostra el de la línia.",
      linies: [
        `Precio actual: ${eur2(linea.actual)}`,
        `Tarifa recomendada: ${eur2(linea.recomendada)}`,
        `Variación = ${eur2(linea.recomendada)} ÷ ${eur2(linea.actual)} − 1 = ${pctSigned(linea.variacion)}`,
        `Ajuste global del simulador: ${pctSigned(ctx.ajuste)}`,
      ],
    },
    aprobada: {
      titol: "Tarifa 2027 aprobada",
      valor: eur2(linea.aprobada),
      formula: "Valor editable de l'esborrany 2027. Per defecte copia la recomendada; es pot canviar a mà i desar sense tocar la 2026.",
      font: "Es desa a ACSales (tarifas-2027). No s'escriu a Business Central ni a la tarifa Excel 2026.",
      linies: [
        `Recomendada: ${eur2(linea.recomendada)}`,
        `Aprobada actual: ${eur2(linea.aprobada)}`,
        linea.aprobada != null && linea.recomendada != null && Math.abs(linea.aprobada - linea.recomendada) > 0.005
          ? "Aquest valor s'ha modificat respecte a la recomendada."
          : "Coincideix amb la recomendada (o encara no s'ha editat).",
      ],
    },
  };

  const b = blocs[campo];
  if (!b) return null;

  return (
    <div className="xr-origen mt-3">
      <div className="xr-origen-cap">
        <div>
          <div className="eyebrow">Origen de la dada</div>
          <h3>
            {b.titol} · {titolLinia}
          </h3>
        </div>
        <button type="button" onClick={onTancar} className="xr-btn-ghost">
          Tancar
        </button>
      </div>
      <p className="text-sm mb-1">
        <span className="font-semibold">Valor: </span>
        {b.valor}
      </p>
      <p className="text-sm mb-1">{b.formula}</p>
      <p className="text-xs text-slate-500 mb-3">{b.font}</p>
      <ul className="text-sm mb-1 list-disc pl-5 space-y-0.5 text-slate-700">
        {b.linies.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export default function SimuladorTarifas2027({
  facturas = [],
  abonos = [],
  lineas = [],
  lineasCompra = [],
  movsProyecto = [],
  fichas: fichasProp = [],
  onActualizar,
  actualizando = false,
}) {
  const [desde, setDesde] = useState(inicioAnioISO);
  const [hasta, setHasta] = useState(hoyISO);
  const [busqueda, setBusqueda] = useState("");
  const [clienteSel, setClienteSel] = useState(null);
  const [origenMargeClave, setOrigenMargeClave] = useState(null);
  const [fichasApi, setFichasApi] = useState([]);
  const [horasControl, setHorasControl] = useState([]);

  const [costePrevisto, setCostePrevisto] = useState(DEF_COSTE_2027);
  const [margenObjetivo, setMargenObjetivo] = useState(DEF_MARGEN_OBJ);
  const [pctEstructura, setPctEstructura] = useState(DEF_ESTRUCTURA);
  const [tarifaActualManual, setTarifaActualManual] = useState(null);
  const [tarifasInfo, setTarifasInfo] = useState(null);
  const [aprobadas, setAprobadas] = useState({}); // key producto|tipo → precio
  const [origenLinea, setOrigenLinea] = useState(null); // { key, campo }
  const [borradorMsg, setBorradorMsg] = useState(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const [rEst, rHor] = await Promise.all([fetch("/api/estado"), fetch("/api/horas/estado")]);
        const dEst = await rEst.json().catch(() => ({}));
        const dHor = await rHor.json().catch(() => ({}));
        if (!vivo) return;
        const fichas = (dEst.fichas || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter(Boolean);
        if (fichas.length) setFichasApi(fichas);
        const filasH = dHor?.datos?.filas || dHor?.filas || [];
        if (Array.isArray(filasH) && filasH.length) {
          setHorasControl(
            filasH.map((f) => ({
              ot: claveOt(f.ot || f.Job_No || f.noOT),
              horas: Number(f.horas || f.cantidad || f.Quantity) || 0,
            }))
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  const fichas = useMemo(() => {
    if (fichasApi.length) return fichasApi;
    return (fichasProp || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter(Boolean);
  }, [fichasApi, fichasProp]);

  const fichasPorOt = useMemo(() => indiceFichasPorOt(fichas), [fichas]);
  const costesLineas = useMemo(
    () => costesDesDeLineas(lineas, lineasCompra, movsProyecto, horasControl),
    [lineas, lineasCompra, movsProyecto, horasControl]
  );
  const otsPerDoc = useMemo(() => otsPerFacturaDesDeLineas(lineas), [lineas]);

  const docsFactura = useMemo(
    () => (facturas || []).map(normalizarFactura).filter((f) => f.numero || f.id),
    [facturas]
  );
  const docsAbono = useMemo(
    () => (abonos || []).map(normalizarAbono).filter((a) => a.numero || a.id),
    [abonos]
  );
  const facturasPeriodo = useMemo(
    () => docsFactura.filter((f) => enPeriodo(f.fecha, desde, hasta)),
    [docsFactura, desde, hasta]
  );
  const abonosPeriodo = useMemo(
    () => docsAbono.filter((a) => enPeriodo(a.fecha, desde, hasta)),
    [docsAbono, desde, hasta]
  );

  const listado = useMemo(() => {
    const por = new Map();
    for (const f of facturasPeriodo) {
      const k = claveCliente(f);
      if (!k) continue;
      let c = por.get(k);
      if (!c) {
        c = {
          clave: k,
          nombre: f.cliente || k,
          codigo: f.clienteN || "",
          neta: 0,
          nFacturas: 0,
          porOtIng: new Map(),
        };
        por.set(k, c);
      }
      c.neta += f.base;
      c.nFacturas += 1;
      if (f.cliente && (!c.nombre || c.nombre === c.codigo)) c.nombre = f.cliente;
      if (f.clienteN) c.codigo = f.clienteN;

      const otCap = claveOt(f.ot);
      if (otCap) {
        c.porOtIng.set(otCap, (c.porOtIng.get(otCap) || 0) + f.base);
      } else {
        const parts = otsPerDoc.get(f.numero) || otsPerDoc.get(String(f.numero || "").trim());
        if (parts?.length) {
          const sumaLin = parts.reduce((s, p) => s + Math.abs(p.importe), 0);
          for (const p of parts) {
            const quota = sumaLin > 0 ? f.base * (Math.abs(p.importe) / sumaLin) : f.base / parts.length;
            c.porOtIng.set(p.ot, (c.porOtIng.get(p.ot) || 0) + quota);
          }
        }
      }
    }
    for (const a of abonosPeriodo) {
      const k = claveCliente(a);
      if (!k || !por.has(k)) continue;
      por.get(k).neta -= a.base;
    }

    let arr = [...por.values()].map((c) => {
      let material = 0;
      let mo = 0;
      const ots = [];
      for (const [otKey, ingresos] of c.porOtIng) {
        const cost = costesPeriodoOt(fichasPorOt.get(otKey), ingresos, costesLineas.get(otKey));
        material += cost.material;
        mo += cost.mo;
        ots.push({
          ot: otKey,
          ingresos,
          material: cost.material,
          mo: cost.mo,
          horas: cost.horas || 0,
          margen: ingresos - cost.material - cost.mo,
          sinFicha: !!cost.sinFicha,
        });
      }
      ots.sort((a, b) => b.ingresos - a.ingresos);
      const margen = c.neta - material - mo;
      const margenPct = c.neta > 0 ? margen / c.neta : null;
      const rec = recomendar(margenPct, margenObjetivo);
      return {
        clave: c.clave,
        nombre: c.nombre,
        codigo: c.codigo,
        neta: c.neta,
        nFacturas: c.nFacturas,
        material,
        mo,
        ots,
        margen,
        margenPct,
        recomendacion: rec,
      };
    });
    arr.sort((a, b) => b.neta - a.neta);
    const q = busqueda.trim().toLowerCase();
    if (q) {
      arr = arr.filter(
        (c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.codigo.toLowerCase().includes(q) ||
          c.clave.toLowerCase().includes(q)
      );
    }
    return arr;
  }, [facturasPeriodo, abonosPeriodo, otsPerDoc, fichasPorOt, costesLineas, busqueda, margenObjetivo]);

  // Carrega tarifa + esborrany quan s'obre un client
  useEffect(() => {
    if (!clienteSel) {
      setTarifasInfo(null);
      setAprobadas({});
      setTarifaActualManual(null);
      setBorradorMsg(null);
      return;
    }
    let vivo = true;
    const clave = clienteSel.codigo || clienteSel.clave;
    (async () => {
      try {
        const qs = encodeURIComponent(clave);
        const [rt, rb] = await Promise.all([
          fetch(`/api/analisis-cliente/tarifas?cliente=${qs}`),
          fetch(`/api/analisis-cliente/tarifas-2027?cliente=${qs}`),
        ]);
        const dt = await rt.json().catch(() => ({}));
        const db = await rb.json().catch(() => null);
        if (!vivo) return;
        if (rt.ok) setTarifasInfo(dt);
        if (rb.ok && db) {
          if (db.costePrevisto > 0) setCostePrevisto(db.costePrevisto);
          if (db.margenObjetivo > 0) setMargenObjetivo(db.margenObjetivo);
          if (db.pctEstructura != null && Number(db.pctEstructura) >= 0) setPctEstructura(Number(db.pctEstructura));
          const map = {};
          for (const f of db.filasAprobadas || []) {
            map[`${f.producto}|${f.tipoTrabajo}`] = Number(f.precio);
          }
          setAprobadas(map);
        } else {
          setAprobadas({});
        }
        setTarifaActualManual(null);
        setOrigenLinea(null);
      } catch {
        if (vivo) setTarifasInfo(null);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [clienteSel]);

  const filasTarifa = tarifasInfo?.activa?.filas || [];
  const tarifaRef = useMemo(() => mediaHNormal(filasTarifa), [filasTarifa]);
  const tarifaActual = tarifaActualManual != null ? tarifaActualManual : tarifaRef;

  const sim = useMemo(() => {
    const costeTotal = costeConEstructura(costePrevisto, pctEstructura);
    const obj = tarifaObjetivo(costePrevisto, margenObjetivo, pctEstructura);
    const margenActual =
      tarifaActual != null && tarifaActual > 0 && costeTotal != null
        ? (tarifaActual - costeTotal) / tarifaActual
        : null;
    const ajuste =
      obj != null && tarifaActual != null && tarifaActual > 0 ? obj / tarifaActual - 1 : null;
    return { obj, margenActual, ajuste, costeTotal };
  }, [costePrevisto, margenObjetivo, pctEstructura, tarifaActual]);

  const lineasSim = useMemo(() => {
    const costeBase = sim.costeTotal != null ? sim.costeTotal : costePrevisto;
    const ratioCoste = tarifaRef > 0 ? costeBase / tarifaRef : null;
    const factor = sim.ajuste != null ? 1 + sim.ajuste : null;
    return (filasTarifa || []).map((f) => {
      const key = `${f.producto}|${f.tipoTrabajo}`;
      const actual = Number(f.precio) || 0;
      const costeLin = ratioCoste != null ? actual * ratioCoste : null;
      const recomendada = factor != null ? actual * factor : null;
      const variacion = actual > 0 && recomendada != null ? recomendada / actual - 1 : null;
      const aprobada = aprobadas[key] != null ? aprobadas[key] : recomendada;
      return {
        key,
        producto: f.producto,
        descripcion: f.descripcion,
        tipoTrabajo: f.tipoTrabajo,
        actual,
        costeLin,
        recomendada,
        variacion,
        aprobada,
      };
    });
  }, [filasTarifa, tarifaRef, costePrevisto, sim.costeTotal, sim.ajuste, aprobadas]);

  const restablecerEjemplo = () => {
    setCostePrevisto(DEF_COSTE_2027);
    setMargenObjetivo(DEF_MARGEN_OBJ);
    setPctEstructura(DEF_ESTRUCTURA);
    setTarifaActualManual(tarifaRef != null ? Math.round(tarifaRef * 100) / 100 : 31);
  };

  const aplicarRecomendadas = () => {
    const map = {};
    for (const l of lineasSim) {
      if (l.recomendada != null) map[l.key] = Math.round(l.recomendada * 100) / 100;
    }
    setAprobadas(map);
  };

  const guardarBorrador = async () => {
    if (!clienteSel) return;
    setGuardando(true);
    setBorradorMsg(null);
    try {
      const clave = clienteSel.codigo || clienteSel.clave;
      const filasAprobadas = lineasSim.map((l) => ({
        producto: l.producto,
        tipoTrabajo: l.tipoTrabajo,
        descripcion: l.descripcion,
        precio: Number(l.aprobada) || 0,
      }));
      const r = await fetch("/api/analisis-cliente/tarifas-2027", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente: clave,
          costePrevisto,
          margenObjetivo,
          pctEstructura,
          filasAprobadas,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setBorradorMsg("Esborrany 2027 desat (no modifica la tarifa 2026).");
    } catch (e) {
      setBorradorMsg(e.message || String(e));
    } finally {
      setGuardando(false);
    }
  };

  const margenCliente = clienteSel
    ? listado.find((c) => c.clave === clienteSel.clave)?.margenPct
    : null;
  const recCliente = recomendar(margenCliente, margenObjetivo);

  if (clienteSel) {
    return (
      <div className="xr-analisi">
        <div className="xr-hero">
          <button type="button" className="xr-btn-ghost inline-flex items-center gap-1 mb-2" onClick={() => setClienteSel(null)}>
            <ArrowLeft size={14} /> Tornar al llistat
          </button>
          <div className="xr-badge">Revisión de tarifas 2027</div>
          <h1>{clienteSel.nombre}</h1>
          <p className="xr-sub">
            {clienteSel.codigo ? `Codi ${clienteSel.codigo} · ` : ""}
            Marge 2026 {pct(margenCliente)} · Objectiu {pct(margenObjetivo)} ·{" "}
            <span className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${badgeCls(recCliente.tono)}`}>
              {recCliente.etiqueta}
            </span>
          </p>
        </div>

        <SeccioXR titol="Flux de revisió" sub="No s'aplica un +5 % a tothom: es calcula l'ajust que cada client necessita.">
          <ol className="space-y-3 text-sm">
            {[
              ["Tarifa actual del client", "Precios de 2026 por tipo de trabajo y hora"],
              ["Análisis económico real de 2026", "Ventas, horas, materiales, costes, rentabilidad"],
              ["Cálculo de la rentabilidad objetivo", "¿Qué tarifa necesitamos para el margen deseado en 2027?"],
              ["Tarifa recomendada para 2027", "Subir, mantener o estudiar, con justificación económica"],
            ].map(([t, s], i) => (
              <li key={t} className="flex gap-3 items-start">
                <span className="shrink-0 w-6 h-6 rounded-full bg-cyan-800 text-white text-xs flex items-center justify-center font-bold">
                  {i + 1}
                </span>
                <div>
                  <div className="font-semibold text-slate-800">{t}</div>
                  <div className="text-slate-500 text-xs">{s}</div>
                </div>
              </li>
            ))}
          </ol>
        </SeccioXR>

        <SeccioXR
          titol="Simulador de tarifas 2027"
          sub="Tarifa objetivo = (coste MO × (1 + % estructura)) ÷ (1 − margen objetivo)."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
            <label className="text-sm">
              <span className="text-slate-500 text-xs font-semibold uppercase">Tarifa actual (€/h)</span>
              <div className="font-bold text-lg tabular-nums">{eur2(tarifaActual)}</div>
              <input
                type="range"
                min={20}
                max={60}
                step={0.5}
                value={tarifaActual ?? 31}
                onChange={(e) => setTarifaActualManual(Number(e.target.value))}
                className="w-full mt-1"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-500 text-xs font-semibold uppercase">Coste previsto 2027 (€/h)</span>
              <div className="font-bold text-lg tabular-nums">{eur2(costePrevisto)}</div>
              <input
                type="range"
                min={18}
                max={40}
                step={0.5}
                value={costePrevisto}
                onChange={(e) => setCostePrevisto(Number(e.target.value))}
                className="w-full mt-1"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-500 text-xs font-semibold uppercase">% estructura</span>
              <div className="font-bold text-lg tabular-nums">{pct(pctEstructura)}</div>
              <input
                type="range"
                min={0}
                max={0.4}
                step={0.01}
                value={pctEstructura}
                onChange={(e) => setPctEstructura(Number(e.target.value))}
                className="w-full mt-1"
              />
              <div className="text-[10px] text-slate-500 mt-0.5">
                Coste + estructura: {eur2(sim.costeTotal)}/h
              </div>
            </label>
            <label className="text-sm">
              <span className="text-slate-500 text-xs font-semibold uppercase">Margen objetivo sobre ventas</span>
              <div className="font-bold text-lg tabular-nums">{pct(margenObjetivo)}</div>
              <input
                type="range"
                min={0.1}
                max={0.5}
                step={0.01}
                value={margenObjetivo}
                onChange={(e) => setMargenObjetivo(Number(e.target.value))}
                className="w-full mt-1"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-sm">
            <div className="xr-note sky">
              <div className="text-[10px] uppercase text-slate-500 font-semibold">Coste MO + estructura</div>
              <div className="font-bold text-lg">{eur2(sim.costeTotal)}</div>
            </div>
            <div className="xr-note sky">
              <div className="text-[10px] uppercase text-slate-500 font-semibold">Margen actual</div>
              <div className="font-bold text-lg">{pct(sim.margenActual)}</div>
            </div>
            <div className="xr-note sky">
              <div className="text-[10px] uppercase text-slate-500 font-semibold">Tarifa objetivo 2027</div>
              <div className="font-bold text-lg">{eur2(sim.obj)}</div>
            </div>
            <div className={`xr-note ${sim.ajuste != null && sim.ajuste > 0.01 ? "amber" : "sky"}`}>
              <div className="text-[10px] uppercase text-slate-500 font-semibold">Ajuste calculado</div>
              <div className={`font-bold text-lg ${sim.ajuste != null && sim.ajuste > 0 ? "text-red-700" : "text-emerald-700"}`}>
                {pctSigned(sim.ajuste)}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                {sim.ajuste != null && sim.ajuste > 0.01
                  ? "La tarifa actual no alcanza el margen objetivo"
                  : sim.ajuste != null && sim.ajuste < -0.01
                    ? "La tarifa actual supera el margen objetivo"
                    : "La tarifa actual está alineada con el objetivo"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="xr-btn-ghost inline-flex items-center gap-1" onClick={restablecerEjemplo}>
              <RotateCcw size={14} /> Restablecer ejemplo
            </button>
            <button type="button" className="xr-btn-ghost" onClick={aplicarRecomendadas}>
              Aplicar recomendadas a «aprobada»
            </button>
            <button type="button" className="xr-btn inline-flex items-center gap-1" disabled={guardando} onClick={guardarBorrador}>
              <Save size={14} /> Desar esborrany 2027
            </button>
          </div>
          {borradorMsg && <p className="text-xs text-slate-600 mt-2">{borradorMsg}</p>}
        </SeccioXR>

        <SeccioXR
          titol={`Línies de tarifa (${lineasSim.length})`}
          sub={`Origen: ${tarifasInfo?.activa?.origen || "—"} · ${tarifasInfo?.usaEspecial ? "tarifa especial" : "tarifa general"}. Clic a qualsevol número per veure d'on surt. No es modifica la 2026.`}
        >
          {!lineasSim.length ? (
            <p className="text-sm text-slate-500">Cap tarifa carregada. Puja l&apos;Excel a Anàlisi per client (G).</p>
          ) : (
            <>
              <div className="overflow-x-auto max-h-[28rem]">
                <table>
                  <thead>
                    <tr>
                      <th>Producte</th>
                      <th>Descripció</th>
                      <th>Tipus</th>
                      <th className="text-right">Precio actual</th>
                      <th className="text-right">Coste + estructura</th>
                      <th className="text-right">Tarifa recomendada</th>
                      <th className="text-right">% variación</th>
                      <th className="text-right">Tarifa 2027 aprobada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineasSim.map((l) => {
                      const activa = (campo) => origenLinea?.key === l.key && origenLinea?.campo === campo;
                      const obrir = (campo) =>
                        setOrigenLinea((prev) =>
                          prev?.key === l.key && prev?.campo === campo ? null : { key: l.key, campo }
                        );
                      return (
                        <tr key={l.key} className={origenLinea?.key === l.key ? "bg-cyan-50/50" : undefined}>
                          <td className="font-mono text-xs">{l.producto}</td>
                          <td className="text-xs">{l.descripcion}</td>
                          <td className="text-xs">{String(l.tipoTrabajo || "").replace(/^H_/, "")}</td>
                          <td className="text-right">
                            <NumClicable activa={activa("actual")} onClick={() => obrir("actual")}>
                              {eur2(l.actual)}
                            </NumClicable>
                          </td>
                          <td className="text-right">
                            <NumClicable activa={activa("coste")} onClick={() => obrir("coste")}>
                              {eur2(l.costeLin)}
                            </NumClicable>
                          </td>
                          <td className="text-right font-semibold">
                            <NumClicable activa={activa("recomendada")} className="font-semibold" onClick={() => obrir("recomendada")}>
                              {eur2(l.recomendada)}
                            </NumClicable>
                          </td>
                          <td className="text-right">
                            <NumClicable
                              activa={activa("variacion")}
                              className={
                                l.variacion != null && l.variacion > 0.01
                                  ? "text-red-700"
                                  : l.variacion != null && l.variacion < -0.01
                                    ? "text-emerald-700"
                                    : ""
                              }
                              onClick={() => obrir("variacion")}
                            >
                              {pctSigned(l.variacion)}
                            </NumClicable>
                          </td>
                          <td className="text-right">
                            <div className="inline-flex items-center gap-1 justify-end">
                              <input
                                type="number"
                                step="0.01"
                                className="w-24 text-right tabular-nums"
                                value={l.aprobada != null ? Math.round(l.aprobada * 100) / 100 : ""}
                                onChange={(e) => {
                                  const v = e.target.value === "" ? null : Number(e.target.value);
                                  setAprobadas((prev) => {
                                    const next = { ...prev };
                                    if (v == null || !Number.isFinite(v)) delete next[l.key];
                                    else next[l.key] = v;
                                    return next;
                                  });
                                }}
                              />
                              <NumClicable
                                activa={activa("aprobada")}
                                className="text-[10px] text-slate-500 no-underline"
                                title="Veure origen de l'aprovada"
                                onClick={() => obrir("aprobada")}
                              >
                                ?
                              </NumClicable>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {origenLinea && (
                <PanelOrigenLinea
                  linea={lineasSim.find((x) => x.key === origenLinea.key)}
                  campo={origenLinea.campo}
                  ctx={{
                    origenExcel: tarifasInfo?.activa?.origen,
                    usaEspecial: !!tarifasInfo?.usaEspecial,
                    costePrevisto,
                    pctEstructura,
                    costeTotal: sim.costeTotal,
                    tarifaRef,
                    tarifaActual,
                    margenObjetivo,
                    tarifaObj: sim.obj,
                    ajuste: sim.ajuste,
                  }}
                  onTancar={() => setOrigenLinea(null)}
                />
              )}
            </>
          )}
        </SeccioXR>
      </div>
    );
  }

  return (
    <div className="xr-analisi">
      <div className="xr-hero">
        <div className="xr-badge">Revisión de tarifas 2027</div>
        <h1 className="flex items-center gap-2">
          <SlidersHorizontal size={22} className="text-cyan-800" /> Simulador de tarifas 2027
        </h1>
        <p className="xr-sub">
          No s&apos;apuja un % fix a tots els clients: es calcula l&apos;ajust perquè cadascun arribi a un marge raonable.
        </p>
      </div>

      <div className="xr-filters flex flex-wrap items-end gap-3 mb-4">
        <label>
          Des de
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label>
          Fins
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        <label className="flex-1 min-w-[12rem]">
          Cercar
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="pl-7 w-full"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Client o codi…"
            />
          </div>
        </label>
        <label>
          Objectiu marge 2027
          <input
            type="number"
            min={5}
            max={60}
            step={1}
            value={Math.round(margenObjetivo * 100)}
            onChange={(e) => setMargenObjetivo((Number(e.target.value) || 30) / 100)}
          />
        </label>
        {onActualizar && (
          <button
            type="button"
            className="xr-btn inline-flex items-center gap-1"
            disabled={actualizando}
            onClick={() => onActualizar(desde, hasta)}
          >
            <RefreshCw size={14} className={actualizando ? "animate-spin" : ""} /> Actualitzar BC
          </button>
        )}
      </div>

      <SeccioXR
        titol={`Clients (${listado.length})`}
        sub="Marge 2026 = (venda − material − MO 21,50 €/h) / venda del període. Clic al % per veure l'origen · clic a la fila per simular."
      >
        {!listado.length ? (
          <p className="text-sm text-slate-500">No hi ha factures en aquest període. Carrega dades o amplia el rang.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th className="text-right">Venda període</th>
                    <th className="text-right">Margen 2026</th>
                    <th className="text-right">Objetivo 2027</th>
                    <th>Ajuste sugerido</th>
                  </tr>
                </thead>
                <tbody>
                  {listado.map((c) => (
                    <tr
                      key={c.clave}
                      className={`cursor-pointer hover:bg-cyan-50/60 ${origenMargeClave === c.clave ? "bg-cyan-50/40" : ""}`}
                      onClick={() => setClienteSel(c)}
                    >
                      <td>
                        <div className="font-medium">{c.nombre}</div>
                        {c.codigo ? <div className="text-xs text-slate-400 font-mono">{c.codigo}</div> : null}
                      </td>
                      <td className="text-right tabular-nums">{eur2(c.neta)}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          title="Veure d'on surt aquest marge"
                          className={`tabular-nums font-semibold underline decoration-dotted underline-offset-2 ${
                            c.margenPct != null && c.margenPct < 0
                              ? "text-red-700"
                              : c.margenPct != null && c.margenPct < margenObjetivo
                                ? "text-amber-800"
                                : "text-slate-800"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOrigenMargeClave((prev) => (prev === c.clave ? null : c.clave));
                          }}
                        >
                          {pct(c.margenPct)}
                        </button>
                      </td>
                      <td className="text-right tabular-nums">{pct(margenObjetivo)}</td>
                      <td>
                        <span className={`inline-block px-2 py-0.5 rounded border text-xs font-semibold ${badgeCls(c.recomendacion.tono)}`}>
                          {c.recomendacion.etiqueta}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {origenMargeClave && (
              <PanelOrigenMarge
                cliente={listado.find((x) => x.clave === origenMargeClave)}
                desde={desde}
                hasta={hasta}
                onTancar={() => setOrigenMargeClave(null)}
              />
            )}
          </>
        )}
      </SeccioXR>
    </div>
  );
}
