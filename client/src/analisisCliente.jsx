/**
 * Anàlisi per client — blocs A–D, F (risc) i G (condicions).
 * E (treballs pendents) queda per més endavant. Només lectura + notes G. UI en català.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Search, Upload, Users } from "lucide-react";
import { normalizarNumeroOT } from "./agenteInteligente.js";

const UNIDADES = [
  { cod: "CON", etiqueta: "Construcció" },
  { cod: "MAN", etiqueta: "Manteniment" },
  { cod: "INS", etiqueta: "Instal·lacions" },
  { cod: "AUT", etiqueta: "Automatització" },
  { cod: "AMI", etiqueta: "Amiant" },
];

const ETIQUETA_UNIDAD = Object.fromEntries(UNIDADES.map((u) => [u.cod, u.etiqueta]));

const TARIFA_COSTE_MO = 21.5;
const PCT_ESTRUCTURA = 0.22;
const UMBRAL_MARGEN_BRUT = 0.12;

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

function fechaCorta(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function inicioAnioISO() {
  return `${new Date().getFullYear()}-01-01`;
}

function rangoAnyAnterior(desde, hasta) {
  const shift = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "";
    return `${Number(m[1]) - 1}-${m[2]}-${m[3]}`;
  };
  return { desde: shift(desde), hasta: shift(hasta) };
}

const eur = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const pct = (n) =>
  n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;

/** Clau OT igual que a la memòria (només dígits: AC015202/2026 → 15202). */
function claveOt(s) {
  return normalizarNumeroOT(s);
}

function unidadDeCodigo(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  const pref = (s.match(/^([A-Z]+)/) || [])[1] || s;
  if (pref === "CON" || pref === "AMT") return "CON";
  if (pref === "MAN") return "MAN";
  if (pref === "INS") return "INS";
  if (pref === "AUT") return "AUT";
  if (pref === "AMI" || pref === "AMIANT") return "AMI";
  if (/AMIANT/.test(s)) return "AMI";
  if (/CONSTRUCCI/.test(s)) return "CON";
  if (/MANTENIM/.test(s)) return "MAN";
  if (/INSTAL/.test(s)) return "INS";
  if (/AUTOMATITZ/.test(s)) return "AUT";
  return null;
}

function normalizarFactura(row) {
  const numero = String(leer(row, ["number", "No", "No.", "Document_No"]) || "").trim();
  return {
    id: String(row.id || numero),
    numero,
    fecha: fechaISO(leer(row, ["invoiceDate", "postingDate", "Posting_Date", "Document_Date"])),
    cliente: String(leer(row, ["customerName", "billToName", "Sell_to_Customer_Name", "Bill_to_Name"]) || "").trim(),
    clienteN: String(leer(row, ["customerNumber", "Sell_to_Customer_No", "Bill_to_Customer_No"]) || "").trim(),
    ot: String(leer(row, ["noOT", "shortcutDimension2Code", "Shortcut_Dimension_2_Code", "jobNo", "Job_No"]) || "").trim(),
    unidadRaw: String(leer(row, ["shortcutDimension1Code", "Shortcut_Dimension_1_Code", "Global_Dimension_1_Code"]) || "").trim(),
    base: numBC(leer(row, ["totalAmountExcludingTax", "Amount"])),
    total: numBC(leer(row, ["totalAmountIncludingTax", "Amount_Including_VAT"])),
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
    ot: String(leer(row, ["noOT", "shortcutDimension2Code", "Shortcut_Dimension_2_Code", "jobNo"]) || "").trim(),
    base: Math.abs(numBC(leer(row, ["totalAmountExcludingTax", "Amount"]))),
    motivo: String(leer(row, ["reasonCode", "Reason_Code", "Description", "Your_Reference"]) || "").trim(),
  };
}

function construirMapaOtUnidad(fichas, lineas) {
  const mapa = new Map();
  const put = (ot, cod) => {
    const k = claveOt(ot);
    const u = unidadDeCodigo(cod);
    if (k && u && !mapa.has(k)) mapa.set(k, u);
  };
  for (const f of fichas || []) {
    const g = f.general || f;
    put(g.numeroOT || g.ot || f.numeroOT, g.segmento || g.departamento || g.Departament);
  }
  for (const l of lineas || []) {
    const ot = leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT", "Job_No", "jobNo"]);
    const ln = leer(l, ["Shortcut_Dimension_1_Code", "shortcutDimension1Code", "Global_Dimension_1_Code"]);
    put(ot, ln);
  }
  return mapa;
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

/** OT → { material, horas } des de línies BC + movs. projecte (recanvi si la fitxa no té cost). */
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
  // 1) Moviments de projecte (Job Ledger): Type Resource + Usage = hores reals
  for (const l of movsProyecto || []) {
    const tipo = String(leer(l, ["Type", "Ledger_Entry_Type", "type"]) || "").toLowerCase();
    if (!/resour|recurs/.test(tipo)) continue;
    const entry = String(leer(l, ["Entry_Type", "Entry Type"]) || "").toLowerCase();
    if (entry && entry !== "usage" && entry !== "uso" && entry !== "0") continue;
    const row = get(leer(l, ["Job_No", "Global_Dimension_2_Code", "Shortcut_Dimension_2_Code", "jobNo", "noOT"]));
    if (!row) continue;
    row.horas += numBC(leer(l, ["Quantity", "Quantity_Base", "quantity"]));
  }
  // 2) Control de hores — només OTs sense hores encara (evita doblar)
  for (const f of horasControl || []) {
    const row = get(f.ot);
    if (!row || row.horas > 0) continue;
    row.horas += Number(f.horas) || 0;
  }
  // 3) Línies de venda tipus Recurs (només si encara 0)
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

/** Factura nº → [{ ot, importe }] des de línies de venda registrades. */
function otsPerFacturaDesDeLineas(lineasVenta) {
  const mapa = new Map();
  for (const l of lineasVenta || []) {
    const doc = String(leer(l, ["Document_No", "documentNo", "documentNumber", "No"]) || "").trim();
    const otRaw = leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT", "Job_No", "jobNo"]);
    const ot = claveOt(otRaw);
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
      [...porOt.entries()].map(([ot, importe]) => ({ ot, otLabel: ot, importe }))
    );
  }
  return out;
}

function costesDeFicha(ficha, fallbackLineas) {
  let material = Number(ficha?.compra?.costeRealOT) || 0;
  if (!material) material = Number(ficha?.compra?.comprasReales?.importe) || 0;
  // Hores: prioritat Job Ledger / Control de hores (fallback), després fitxa
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

/** Costos de l'OT escalats a la facturació del període vs ingressos històrics. */
function costesPeriodoOt(ficha, ingresosOt, fallbackLineas) {
  const c = costesDeFicha(ficha, fallbackLineas);
  if (!c.tiene) return { material: 0, mo: 0, horas: 0, factor: null, sinFicha: !ficha };
  const baseIng = c.ingresosHist > 0 ? c.ingresosHist : ingresosOt;
  const factor = baseIng > 0 ? Math.min(1, Math.max(0, ingresosOt / baseIng)) : 1;
  return {
    material: c.material * factor,
    mo: c.mo * factor,
    horas: c.horas * factor,
    factor,
    sinFicha: !ficha,
  };
}

function unidadDeDoc(doc, mapaOt) {
  const directa = unidadDeCodigo(doc.unidadRaw);
  if (directa) return directa;
  const porOt = mapaOt.get(claveOt(doc.ot));
  if (porOt) return porOt;
  return null;
}

function enPeriodo(fecha, desde, hasta) {
  if (!fecha) return false;
  if (desde && fecha < desde) return false;
  if (hasta && fecha > hasta) return false;
  return true;
}

function claveCliente(doc) {
  return doc.clienteN || doc.cliente || "";
}

function Tarjeta({ id, titol, valor, sub, alerta, activa, onElegir }) {
  const alertaCls = alerta === "mal" ? "alerta-mal" : alerta === "vig" ? "alerta-vig" : "";
  return (
    <button
      type="button"
      onClick={() => onElegir?.(activa ? null : id)}
      title="Pulsa per veure d'on surt aquesta xifra"
      className={`xr-kpi ${alertaCls}${activa ? " activa" : ""}`}
    >
      <div className="xr-kpi-titol">{titol}</div>
      <div className="xr-kpi-valor">{valor}</div>
      {sub ? <div className="xr-kpi-sub">{sub}</div> : null}
      <div className="xr-kpi-hint">Origen · clic</div>
    </button>
  );
}

function TarjetaND({ titol, valor = "No disponible", sub }) {
  return (
    <div className="xr-kpi-nd">
      <div className="xr-kpi-titol">{titol}</div>
      <div className="xr-kpi-valor">{valor}</div>
      {sub ? <div className="xr-kpi-sub">{sub}</div> : null}
    </div>
  );
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

/** Llegeix Excel de línies de tarifa MO (format BC Price List Lines / export «Líneas»). */
async function parsearExcelTarifas(file) {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(hoja, { defval: "" });
  const filas = raw
    .map((r) => ({
      tipoProducto: String(r["Tipo de producto"] || r.tipoProducto || "").trim(),
      producto: String(r["N.º de producto"] || r["No. de producto"] || r.producto || r.No || "").trim(),
      descripcion: String(r["Descripción"] || r.Descripcion || r.descripcion || "").trim(),
      tipoTrabajo: String(r["Cód. tipo trabajo"] || r["Cod. tipo trabajo"] || r.tipoTrabajo || "").trim(),
      unidad: String(r["Cód. unidad medida"] || r.unidad || "HORA").trim(),
      cantidadMin: Number(r["Cantidad mínima"] || r.cantidadMin || 0) || 0,
      precio: Number(r["Precio venta"] || r.precio || r.Unit_Price || 0) || 0,
    }))
    .filter((r) => r.producto || r.descripcion);
  return filas;
}

function TablaTarifasMO({ filas }) {
  const tipos = useMemo(() => {
    const s = new Set();
    for (const f of filas || []) if (f.tipoTrabajo) s.add(f.tipoTrabajo);
    const prefer = ["H_NORMAL", "H_EXTRA", "H_FESTIVO1", "H_FESTIVO2", "H_GUARDIA", "H_GUARDIA1", "H_GUARDIA2"];
    const ord = [...s].sort((a, b) => {
      const ia = prefer.indexOf(a);
      const ib = prefer.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.localeCompare(b);
    });
    return ord;
  }, [filas]);

  const productos = useMemo(() => {
    const map = new Map();
    for (const f of filas || []) {
      const k = f.producto || f.descripcion;
      if (!k) continue;
      if (!map.has(k)) map.set(k, { producto: f.producto, descripcion: f.descripcion, precios: {} });
      map.get(k).precios[f.tipoTrabajo] = f.precio;
    }
    return [...map.values()].sort((a, b) => String(a.producto).localeCompare(String(b.producto)));
  }, [filas]);

  if (!filas?.length) {
    return <p className="text-sm text-slate-500">Cap tarifa carregada. Puja un Excel de línies de preus.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Producte</th>
            <th>Descripció</th>
            {tipos.map((t) => (
              <th key={t} className="text-right">
                {t.replace(/^H_/, "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {productos.map((p) => (
            <tr key={p.producto || p.descripcion}>
              <td className="font-mono text-xs">{p.producto}</td>
              <td className="text-xs">{p.descripcion}</td>
              {tipos.map((t) => (
                <td key={t} className={`text-right tabular-nums ${t === "H_NORMAL" ? "font-semibold" : ""}`}>
                  {p.precios[t] != null ? eur2(p.precios[t]) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Scoring intern de risc (bloc F). No és un rating oficial. */
function calcularRisc({ deuda, comp, rent, mensual, neta, nAbonos }) {
  const motivos = [];
  let pts = 0;

  const retraso = comp?.retrasoMedio;
  if (retraso != null && retraso > 30) {
    pts += 2;
    motivos.push({ grav: "mal", text: `Retard mitjà de cobrament ${Math.round(retraso)} dies (>30).` });
  } else if (retraso != null && retraso > 15) {
    pts += 1;
    motivos.push({ grav: "vig", text: `Retard mitjà de cobrament ${Math.round(retraso)} dies (>15).` });
  }

  const puntual = comp?.pctPuntual;
  if (puntual != null && puntual < 0.5) {
    pts += 2;
    motivos.push({ grav: "mal", text: `Puntualitat baixa (${pct(puntual)}).` });
  } else if (puntual != null && puntual < 0.7) {
    pts += 1;
    motivos.push({ grav: "vig", text: `Puntualitat moderada (${pct(puntual)}).` });
  }

  const d90 = deuda?.aging?.d90 || 0;
  const vencido = deuda?.vencido || 0;
  if (d90 > 0) {
    pts += 3;
    motivos.push({ grav: "mal", text: `Impagats >90 dies: ${eur2(d90)}.` });
  } else if (vencido > 0) {
    pts += 2;
    motivos.push({ grav: "vig", text: `Saldo vençut: ${eur2(vencido)}.` });
  }

  const lim = deuda?.creditLimit;
  const exp = deuda?.exposicion || 0;
  if (deuda?.creditLimitDisponible && lim > 0) {
    const uso = exp / lim;
    if (uso > 1) {
      pts += 3;
      motivos.push({ grav: "mal", text: `Exposició per sobre del límit de crèdit (${pct(uso)}).` });
    } else if (uso > 0.8) {
      pts += 2;
      motivos.push({ grav: "vig", text: `Ús del límit de crèdit ${pct(uso)}.` });
    } else if (uso > 0.5) {
      pts += 1;
      motivos.push({ grav: "vig", text: `Ús del límit de crèdit ${pct(uso)}.` });
    }
  } else if (exp > 0 && !deuda?.creditLimitDisponible) {
    pts += 1;
    motivos.push({ grav: "vig", text: "Sense límit de crèdit informat i hi ha exposició oberta." });
  }

  // Evolució de compres (facturació): compara mitjana 1a meitat vs 2a meitat del període
  const meses = (mensual || []).filter((m) => m.neta > 0);
  if (meses.length >= 4) {
    const mid = Math.floor(meses.length / 2);
    const a = meses.slice(0, mid).reduce((s, m) => s + m.neta, 0) / mid;
    const b = meses.slice(mid).reduce((s, m) => s + m.neta, 0) / (meses.length - mid);
    if (a > 0 && b < a * 0.7) {
      pts += 1;
      motivos.push({ grav: "vig", text: "Caiguda de facturació a la 2a meitat del període (>30 %)." });
    }
  }

  const margePct = rent?.margenBrutPct;
  const resultat = rent?.resultado;
  if (resultat != null && resultat < 0) {
    pts += 2;
    motivos.push({ grav: "mal", text: `Resultat negatiu al període (${eur2(resultat)}).` });
  } else if (margePct != null && margePct < UMBRAL_MARGEN_BRUT) {
    pts += 1;
    motivos.push({ grav: "vig", text: `Marge brut per sota de l'objectiu (${pct(margePct)}).` });
  }

  const inc = comp?.incidencias || 0;
  if (inc > 3) {
    pts += 2;
    motivos.push({ grav: "mal", text: `${inc} incidències de cobrament (històric + open).` });
  } else if (inc > 0) {
    pts += 1;
    motivos.push({ grav: "vig", text: `${inc} incidència(es) de cobrament.` });
  }

  if ((nAbonos || 0) >= 3 && neta > 0) {
    pts += 1;
    motivos.push({ grav: "vig", text: `${nAbonos} abonaments al període (possible fricció administrativa).` });
  }

  let nivel = "baix";
  let etiqueta = "Baix";
  if (pts >= 6) {
    nivel = "alt";
    etiqueta = "Alt";
  } else if (pts >= 3) {
    nivel = "mitja";
    etiqueta = "Mitjà";
  }

  if (motivos.length === 0) {
    motivos.push({ grav: "ok", text: "Sense senyals de risc destacables amb les dades disponibles." });
  }

  return {
    pts,
    nivel,
    etiqueta,
    motivos,
    avis: "Valoració interna ACSales. No és un rating oficial de solvència ni substitueix una avaluació externa.",
  };
}

function PanelOrigenClienta({ id, fitxa, desde, hasta, onTancar }) {
  if (!id || !fitxa) return null;
  const r = fitxa.rent;
  const facts = (fitxa.detall || []).filter((d) => d.tipo === "factura");
  const abs = (fitxa.detall || []).filter((d) => d.tipo === "abono");
  const ant = rangoAnyAnterior(desde, hasta);

  const blocs = {
    neta: {
      titol: "Facturació neta / Ingressos nets",
      formula: "Factures de venda (base sense IVA) − abonaments del període.",
      font: "Font: factures i notes d'abonament de venda carregades des del sistema de gestió.",
      periode: `${fechaCorta(desde)} – ${fechaCorta(hasta)}`,
      valor: eur2(fitxa.neta),
      linies: [
        `Factures (brutes): ${eur2(fitxa.facturasBruto ?? fitxa.neta + (fitxa.abonoImp || 0))}`,
        `− Abonaments: ${eur2(fitxa.abonoImp)}`,
        `= Neta: ${eur2(fitxa.neta)}`,
      ],
      taula: [
        ...facts.map((d) => ({ a: d.numero, b: fechaCorta(d.fecha), c: "factura", d: eur2(d.base) })),
        ...abs.map((d) => ({ a: d.numero, b: fechaCorta(d.fecha), c: "abonament", d: eur2(-Math.abs(d.base)) })),
      ],
      caps: ["Document", "Data", "Tipus", "Base"],
    },
    vsAny: {
      titol: "Vs any anterior",
      formula: `Diferència = facturació període actual − mateix rang de dies de l'any anterior (${fechaCorta(ant.desde)} – ${fechaCorta(ant.hasta)}).`,
      font: "Mateixa font de factures; si no hi ha dades de l'any anterior, es mostra «Sense dades».",
      periode: `Actual ${fechaCorta(desde)}–${fechaCorta(hasta)} · Abans ${fechaCorta(ant.desde)}–${fechaCorta(ant.hasta)}`,
      valor: fitxa.hayAnt ? `${eur2(fitxa.delta)} (${pct(fitxa.deltaPct)})` : "—",
      linies: [
        `Facturació actual: ${eur2(fitxa.neta)}`,
        `Facturació any anterior (mateix rang): ${fitxa.hayAnt ? eur2(fitxa.netaAnt) : "sense dades"}`,
      ],
    },
    nFactures: {
      titol: "Nº factures",
      formula: "Recompte de factures de venda del client amb data dins del període (no compta abonaments).",
      font: "Font: cabeceres de factures de venda.",
      periode: `${fechaCorta(desde)} – ${fechaCorta(hasta)}`,
      valor: String(fitxa.nFacturas),
      taula: facts.map((d) => ({ a: d.numero, b: fechaCorta(d.fecha), c: d.ot || "—", d: eur2(d.base) })),
      caps: ["Factura", "Data", "OT", "Base"],
    },
    ticket: {
      titol: "Ticket mitjà",
      formula: "Facturació neta (factures − abonaments) ÷ número de factures.",
      font: "Calculat a partir de la neta i el recompte de factures (els abonaments no sumen al denominador).",
      valor: eur2(fitxa.ticket),
      linies: [`${eur2(fitxa.neta)} ÷ ${fitxa.nFacturas} factures`],
    },
    pes: {
      titol: "Pes sobre l'empresa",
      formula: "Facturació neta del client ÷ facturació neta total de l'empresa activa en el mateix període.",
      font: "Numerador: client. Denominador: suma de totes les factures carregades de l'empresa al període.",
      valor: pct(fitxa.pes),
      linies: [`Client ${eur2(fitxa.neta)} · Pes ${pct(fitxa.pes)}`],
    },
    primera: {
      titol: "Primera factura",
      formula: "Data més antiga de factura d'aquest client a l'històric disponible (no només el període filtrat).",
      font: "Font: totes les factures de venda carregades per a aquest client.",
      valor: fechaCorta(fitxa.primera),
    },
    darrera: {
      titol: "Darrera factura",
      formula: "Data més recent de factura d'aquest client a l'històric disponible.",
      font: "Font: totes les factures de venda carregades per a aquest client.",
      valor: fechaCorta(fitxa.ultima),
    },
    abonaments: {
      titol: "Abonaments",
      formula: "Suma de bases (sense IVA) de notes d'abonament de venda del client en el període.",
      font: "Font: notes d'abonament de venda.",
      periode: `${fechaCorta(desde)} – ${fechaCorta(hasta)}`,
      valor: eur2(fitxa.abonoImp),
      taula: abs.map((d) => ({ a: d.numero, b: fechaCorta(d.fecha), c: d.motivo || "—", d: eur2(Math.abs(d.base)) })),
      caps: ["Abonament", "Data", "Motiu", "Base"],
    },
    material: {
      titol: "Material",
      formula: "Suma del cost de material de cada OT facturada al període (compres de la memòria / línies de compra), escalat a la facturació del període vs ingressos històrics de l'OT.",
      font: "Font: memòria històrica (costeRealOT) o línies de compra per OT.",
      valor: eur2(r?.material),
      taula: (r?.ots || []).map((o) => ({ a: o.ot, b: eur2(o.ingresos), c: eur2(o.material), d: o.sinFicha ? "sense fitxa" : "ok" })),
      caps: ["OT", "Ingressos període", "Material", "Estat"],
    },
    mo: {
      titol: "Mà d'obra",
      formula: `Hores de recurs (moviments de projecte Usage) × ${TARIFA_COSTE_MO} €/h, escalades a la facturació del període.`,
      font: "Font preferent: Moviments d'OT (Job Ledger). Si falten, Control de hores o línies de venda tipus recurs.",
      valor: eur2(r?.mo),
      taula: (r?.ots || []).map((o) => ({
        a: o.ot,
        b: (o.mo / TARIFA_COSTE_MO).toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " h",
        c: eur2(o.mo),
        d: eur2(o.ingresos),
      })),
      caps: ["OT", "Hores (escalades)", "MO €", "Ingressos"],
    },
    marge: {
      titol: "Marge brut",
      formula: "Ingressos nets − Material − Mà d'obra.",
      font: "Càlcul intern a partir de les tres targetes anteriors.",
      valor: `${eur2(r?.margenBrut)} (${pct(r?.margenBrutPct)})`,
      linies: [
        `Ingressos ${eur2(fitxa.neta)}`,
        `− Material ${eur2(r?.material)}`,
        `− MO ${eur2(r?.mo)}`,
        `= Marge ${eur2(r?.margenBrut)}`,
        `Objectiu alerta: marge brut ≥ ${pct(UMBRAL_MARGEN_BRUT)}`,
      ],
    },
    estructura: {
      titol: "Estructura 22 %",
      formula: `Ingressos nets × ${pct(PCT_ESTRUCTURA)} (mateixa regla que a Pedidos de venta / detall OT).`,
      font: "Percentatge fix de l'aplicació; no és un extracte comptable de comptes 6x.",
      valor: eur2(r?.estructura),
      linies: [`${eur2(fitxa.neta)} × ${pct(PCT_ESTRUCTURA)} = ${eur2(r?.estructura)}`],
    },
    resultat: {
      titol: "Resultat",
      formula: "Marge brut − Estructura 22 %.",
      font: "Càlcul intern.",
      valor: eur2(r?.resultado),
      linies: [
        `Marge ${eur2(r?.margenBrut)}`,
        `− Estructura ${eur2(r?.estructura)}`,
        `= Resultat ${eur2(r?.resultado)}`,
      ],
    },
    pendCobro: {
      titol: "Saldo pendent de cobrament",
      formula: "Suma del total amb IVA de les factures de venda amb estat Open d'aquest client (foto actual, no el filtre de període).",
      font: "API del sistema de gestió · salesInvoices status = Open (mateixa regla que Circulant).",
      valor: eur2(fitxa.deuda?.pendiente),
      taula: (fitxa.deuda?.facturas || []).map((d) => ({
        a: d.numero,
        b: fechaCorta(d.fecha),
        c: fechaCorta(d.vencimiento),
        d: eur2(d.importe),
      })),
      caps: ["Factura", "Data", "Venciment", "Import"],
    },
    vencido: {
      titol: "Saldo vençut",
      formula: "Factures Open amb data de venciment anterior a avui.",
      font: "Mateixa font Open; venciment = dueDate.",
      valor: eur2(fitxa.deuda?.vencido),
      taula: (fitxa.deuda?.facturas || [])
        .filter((d) => d.vencida)
        .map((d) => ({ a: d.numero, b: fechaCorta(d.vencimiento), c: `${d.diasVencido} d`, d: eur2(d.importe) })),
      caps: ["Factura", "Venciment", "Dies", "Import"],
    },
    noVencido: {
      titol: "Saldo encara no vençut",
      formula: "Factures Open amb venciment ≥ avui (o sense venciment comptat a pendent − vençut).",
      font: "Mateixa font Open.",
      valor: eur2(fitxa.deuda?.noVencido),
      taula: (fitxa.deuda?.facturas || [])
        .filter((d) => !d.vencida)
        .map((d) => ({ a: d.numero, b: fechaCorta(d.vencimiento) || "—", c: d.aging === "senseVenc" ? "sense data" : "al dia", d: eur2(d.importe) })),
      caps: ["Factura", "Venciment", "Estat", "Import"],
    },
    aging: {
      titol: "Antiguitat dels saldos",
      formula: "Dies de retard = avui − venciment. Trams: no vençut · 1–30 · 31–60 · 61–90 · >90.",
      font: "Calculat sobre factures Open.",
      valor: eur2(fitxa.deuda?.pendiente),
      linies: [
        `No vençut: ${eur2(fitxa.deuda?.aging?.noVenc)}`,
        `1–30 dies: ${eur2(fitxa.deuda?.aging?.d1_30)}`,
        `31–60 dies: ${eur2(fitxa.deuda?.aging?.d31_60)}`,
        `61–90 dies: ${eur2(fitxa.deuda?.aging?.d61_90)}`,
        `>90 dies: ${eur2(fitxa.deuda?.aging?.d90)}`,
        fitxa.deuda?.aging?.senseVenc
          ? `Sense venciment: ${eur2(fitxa.deuda.aging.senseVenc)}`
          : null,
      ].filter(Boolean),
    },
    abonosPend: {
      titol: "Abonaments pendents d'aplicar",
      formula: "Notes d'abonament de venda amb estat Open (encara no liquidades / aplicades).",
      font: "salesCreditMemos status = Open.",
      valor: eur2(fitxa.deuda?.abonosPendientes),
      taula: (fitxa.deuda?.abonos || []).map((d) => ({
        a: d.numero,
        b: fechaCorta(d.fecha),
        c: fechaCorta(d.vencimiento) || "—",
        d: eur2(d.importe),
      })),
      caps: ["Abonament", "Data", "Venciment", "Import"],
    },
    exposicio: {
      titol: "Exposició financera",
      formula: "Pendent de cobrament − abonaments Open (no pot ser negatiu).",
      font: "Càlcul intern sobre les dues fonts anteriors.",
      valor: eur2(fitxa.deuda?.exposicion),
      linies: [
        `Pendent ${eur2(fitxa.deuda?.pendiente)}`,
        `− Abonaments Open ${eur2(fitxa.deuda?.abonosPendientes)}`,
        `= Exposició ${eur2(fitxa.deuda?.exposicion)}`,
        fitxa.deuda?.creditLimitDisponible
          ? `Límit de crèdit: ${eur2(fitxa.deuda.creditLimit)} · Ús ${pct(
              fitxa.deuda.creditLimit > 0 ? fitxa.deuda.exposicion / fitxa.deuda.creditLimit : null
            )}`
          : "Límit de crèdit: no informat a la fitxa del client (o 0 / buit).",
      ],
    },
    plazoReal: {
      titol: "Termini mitjà real de cobrament",
      formula: "Mitjana de (data cobrament aproximada − data factura) de les factures Paid del període.",
      font: "Cobrament ≈ lastModifiedDateTime de la factura Paid (aproximació; la API no exposa la liquidació).",
      periode: `${fechaCorta(desde)} – ${fechaCorta(hasta)}`,
      valor: fitxa.comp?.plazoMedioReal != null ? `${Math.round(fitxa.comp.plazoMedioReal)} dies` : "—",
      linies: [
        `Nº factures cobrades amb data: ${fitxa.comp?.nCobradasConFecha ?? 0}`,
        `Termini mitjà pactat (factura→venciment): ${
          fitxa.comp?.plazoMedioPactado != null ? `${Math.round(fitxa.comp.plazoMedioPactado)} dies` : "—"
        }`,
      ],
    },
    retrasoMedio: {
      titol: "Dies mitjans de retard",
      formula: "Mitjana de (data cobrament aproximada − venciment). Negatiu = paga abans.",
      font: "Mateixa aproximació de cobrament sobre factures Paid del període.",
      valor: fitxa.comp?.retrasoMedio != null ? `${Math.round(fitxa.comp.retrasoMedio)} dies` : "—",
      linies: [
        `Només retards (>0): ${
          fitxa.comp?.retrasoMedioPositivo != null ? `${Math.round(fitxa.comp.retrasoMedioPositivo)} dies` : "—"
        }`,
      ],
    },
    pctPuntual: {
      titol: "% cobrades puntualment",
      formula: "Factures Paid amb cobrament aproximat ≤ venciment ÷ total Paid amb data al període.",
      font: "Càlcul intern.",
      valor: pct(fitxa.comp?.pctPuntual),
      linies: [`${fitxa.comp?.nCobradasConFecha ?? 0} factura(es) Paid amb data de cobrament aproximada`],
    },
    importeMedioD: {
      titol: "Import mitjà de les factures",
      formula: "Mitjana del total amb IVA de totes les factures del client al període (qualsevol estat).",
      font: "salesInvoices del període.",
      valor: eur2(fitxa.comp?.importeMedio),
      linies: [`${fitxa.comp?.nFacturasPeriodo ?? 0} factura(es) al període`],
    },
    mayorRetraso: {
      titol: "Major retard registrat",
      formula: "Màxim entre: retard històric (Paid) i dies vençuts actuals (Open).",
      font: "Històric aproximat + factures Open.",
      valor: fitxa.comp?.mayorRetraso != null ? `${Math.round(fitxa.comp.mayorRetraso)} dies` : "—",
      linies: [
        `Històric Paid: ${fitxa.comp?.mayorRetrasoHist != null ? `${Math.round(fitxa.comp.mayorRetrasoHist)} dies` : "—"}`,
        `Open actual: ${fitxa.comp?.mayorRetrasoOpen != null ? `${Math.round(fitxa.comp.mayorRetrasoOpen)} dies` : "—"}`,
      ],
    },
    incidencias: {
      titol: "Incidències de cobrament",
      formula: "Factures Paid amb retard (>0 dies) + factures Open ja vençudes.",
      font: "No hi ha registre de reclamacions; s'usa el retard com a incidència.",
      valor: String(fitxa.comp?.incidencias ?? "—"),
      linies: [
        `Amb retard històric: ${fitxa.comp?.incidenciasHist ?? 0}`,
        `Open vençudes: ${fitxa.comp?.incidenciasOpen ?? 0}`,
      ],
    },
    evolPago: {
      titol: "Evolució del comportament",
      formula: "Per mes de cobrament aproximat: nº factures, retard mitjà i % puntual.",
      font: "Agrupació de factures Paid del període.",
      valor: `${fitxa.comp?.evolucion?.length || 0} mes(os)`,
      taula: (fitxa.comp?.evolucion || []).map((m) => ({
        a: m.mes,
        b: String(m.n),
        c: m.retrasoMedio != null ? `${Math.round(m.retrasoMedio)} d` : "—",
        d: pct(m.pctPuntual),
      })),
      caps: ["Mes", "Nº", "Retard mitjà", "% puntual"],
    },
    prevision: {
      titol: "Previsió de cobraments",
      formula: "Import de factures Open agrupades per setmana / mes de venciment.",
      font: "Foto actual Open (no depèn del filtre de període per a la llista Open).",
      valor: eur2((fitxa.comp?.previsionMes || []).reduce((s, x) => s + x.importe, 0)),
      taula: (fitxa.comp?.previsionMes || []).map((m) => ({
        a: m.clave,
        b: String(m.n),
        c: m.vencidas ? `${m.vencidas} venç.` : "—",
        d: eur2(m.importe),
      })),
      caps: ["Mes venciment", "Nº", "Vençudes", "Import"],
    },
    riscNivel: {
      titol: "Nivell de risc",
      formula: "Suma de punts per retards, impagats, límit de crèdit, evolució, marge i incidències. Baix 0–2 · Mitjà 3–5 · Alt ≥6.",
      font: "Càlcul intern a partir dels blocs C, D i B. No és un rating oficial.",
      valor: fitxa.risc?.etiqueta || "—",
      linies: [
        `Punts: ${fitxa.risc?.pts ?? "—"}`,
        ...(fitxa.risc?.motivos || []).map((m) => m.text),
      ],
    },
    riscMotius: {
      titol: "Motius del risc",
      formula: "Llista dels senyals que han sumat punts (o el missatge d'absència de senyals).",
      font: "Mateix scoring intern.",
      valor: `${fitxa.risc?.motivos?.length || 0} motiu(s)`,
      linies: (fitxa.risc?.motivos || []).map((m) => m.text),
    },
  };

  const b = blocs[id] || blocs.neta;
  return (
    <div className="xr-origen">
      <div className="xr-origen-cap">
        <div>
          <div className="eyebrow">Origen de la dada</div>
          <h3>{b.titol}</h3>
        </div>
        <button type="button" onClick={onTancar} className="xr-btn-ghost">
          Tancar
        </button>
      </div>
      <p className="text-sm mb-1">
        <span className="font-semibold">Valor: </span>
        {b.valor}
      </p>
      {b.periode && <p className="text-xs text-slate-500 mb-1">Període: {b.periode}</p>}
      <p className="text-sm mb-1">{b.formula}</p>
      <p className="text-xs text-slate-500 mb-3">{b.font}</p>
      {b.linies?.length > 0 && (
        <ul className="text-sm mb-3 list-disc pl-5 space-y-0.5 text-slate-700">
          {b.linies.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      {b.taula?.length > 0 && (
        <div className="tabla-wrap">
          <table>
            <thead>
              <tr>
                {b.caps.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.taula.map((f, i) => (
                <tr key={i}>
                  <td className="font-mono">{f.a}</td>
                  <td>{f.b}</td>
                  <td>{f.c}</td>
                  <td className="text-right">{f.d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AnalisisCliente({
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
  const [pestana, setPestana] = useState("a"); // a | b | c | d | f | g
  const [origenId, setOrigenId] = useState(null);
  const [fichasApi, setFichasApi] = useState([]);
  const [horasControl, setHorasControl] = useState([]);
  const [deuda, setDeuda] = useState(null);
  const [deudaCargando, setDeudaCargando] = useState(false);
  const [deudaError, setDeudaError] = useState(null);
  const [comp, setComp] = useState(null);
  const [compCargando, setCompCargando] = useState(false);
  const [compError, setCompError] = useState(null);
  const [fichaG, setFichaG] = useState(null);
  const [fichaGError, setFichaGError] = useState(null);
  const [condG, setCondG] = useState({
    necesitaPO: false,
    albaranValorado: false,
    periodicidad: "",
    facePortal: "",
    retenciones: "",
    incidenciasAdmin: "",
    contactosExtra: "",
    notas: "",
  });
  const [condGuardando, setCondGuardando] = useState(false);
  const [condMsg, setCondMsg] = useState(null);
  const [tarifasInfo, setTarifasInfo] = useState(null);
  const [tarifasMsg, setTarifasMsg] = useState(null);
  const [tarifasSubiendo, setTarifasSubiendo] = useState(false);
  const fileTarifaGenRef = useRef(null);
  const fileTarifaCliRef = useRef(null);

  // Memòria OT + hores de Control de hores (si n'hi ha de carregades)
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const [rEst, rHor] = await Promise.all([fetch("/api/estado"), fetch("/api/horas/estado")]);
        if (rEst.ok) {
          const est = await rEst.json();
          if (vivo && est.fichas?.length) {
            setFichasApi(est.fichas.map((x) => (Array.isArray(x) ? x[1] : x)).filter(Boolean));
          }
        }
        if (rHor.ok) {
          const h = await rHor.json();
          const filas = h?.datos?.filas || [];
          if (vivo && filas.length) setHorasControl(filas);
        }
      } catch { /* sense backend */ }
    })();
    return () => { vivo = false; };
  }, []);

  // Bloc C: deute oberta (foto actual, independent del filtre de període A/B)
  useEffect(() => {
    if (!clienteSel) {
      setDeuda(null);
      setDeudaError(null);
      return;
    }
    let vivo = true;
    (async () => {
      setDeudaCargando(true);
      setDeudaError(null);
      try {
        const qs = new URLSearchParams();
        if (clienteSel.codigo) qs.set("numero", clienteSel.codigo);
        if (clienteSel.nombre) qs.set("nombre", clienteSel.nombre);
        const r = await fetch(`/api/analisis-cliente/deuda?${qs}`);
        const d = await r.json().catch(() => ({}));
        if (!vivo) return;
        if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
        setDeuda(d);
      } catch (e) {
        if (vivo) {
          setDeuda(null);
          setDeudaError(e.message || String(e));
        }
      } finally {
        if (vivo) setDeudaCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [clienteSel]);

  // Bloc D: comportament de pagament (històric del període + previsió Open)
  useEffect(() => {
    if (!clienteSel) {
      setComp(null);
      setCompError(null);
      return;
    }
    let vivo = true;
    (async () => {
      setCompCargando(true);
      setCompError(null);
      try {
        const qs = new URLSearchParams();
        if (clienteSel.codigo) qs.set("numero", clienteSel.codigo);
        if (clienteSel.nombre) qs.set("nombre", clienteSel.nombre);
        qs.set("desde", desde);
        qs.set("hasta", hasta);
        const r = await fetch(`/api/analisis-cliente/comportamiento?${qs}`);
        const d = await r.json().catch(() => ({}));
        if (!vivo) return;
        if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
        setComp(d);
      } catch (e) {
        if (vivo) {
          setComp(null);
          setCompError(e.message || String(e));
        }
      } finally {
        if (vivo) setCompCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [clienteSel, desde, hasta]);

  // Bloc G: fitxa BC + notes administratives
  useEffect(() => {
    if (!clienteSel) {
      setFichaG(null);
      setFichaGError(null);
      setCondG({
        necesitaPO: false,
        albaranValorado: false,
        periodicidad: "",
        facePortal: "",
        retenciones: "",
        incidenciasAdmin: "",
        contactosExtra: "",
        notas: "",
      });
      setTarifasInfo(null);
      return;
    }
    let vivo = true;
    const clave = clienteSel.codigo || clienteSel.clave || clienteSel.nombre;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (clienteSel.codigo) qs.set("numero", clienteSel.codigo);
        if (clienteSel.nombre) qs.set("nombre", clienteSel.nombre);
        const [rf, rc, rt] = await Promise.all([
          fetch(`/api/analisis-cliente/ficha?${qs}`),
          fetch(`/api/analisis-cliente/condiciones?cliente=${encodeURIComponent(clave)}`),
          fetch(`/api/analisis-cliente/tarifas?cliente=${encodeURIComponent(clave)}`),
        ]);
        const df = await rf.json().catch(() => ({}));
        const dc = await rc.json().catch(() => ({}));
        const dt = await rt.json().catch(() => ({}));
        if (!vivo) return;
        if (!rf.ok) {
          setFichaG(null);
          setFichaGError(df.error || df.detalle || `Error ${rf.status}`);
        } else {
          setFichaG(df);
          setFichaGError(null);
        }
        if (rc.ok && dc) {
          setCondG({
            necesitaPO: !!dc.necesitaPO,
            albaranValorado: !!dc.albaranValorado,
            periodicidad: dc.periodicidad || "",
            facePortal: dc.facePortal || "",
            retenciones: dc.retenciones || "",
            incidenciasAdmin: dc.incidenciasAdmin || "",
            contactosExtra: dc.contactosExtra || "",
            notas: dc.notas || "",
          });
        }
        if (rt.ok) setTarifasInfo(dt);
      } catch (e) {
        if (vivo) setFichaGError(e.message || String(e));
      }
    })();
    return () => { vivo = false; };
  }, [clienteSel]);

  const fichas = useMemo(() => {
    if (fichasApi.length) return fichasApi;
    return (fichasProp || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter(Boolean);
  }, [fichasApi, fichasProp]);

  const mapaOt = useMemo(() => construirMapaOtUnidad(fichas, lineas), [fichas, lineas]);
  const fichasPorOt = useMemo(() => indiceFichasPorOt(fichas), [fichas]);
  const costesLineas = useMemo(
    () => costesDesDeLineas(lineas, lineasCompra, movsProyecto, horasControl),
    [lineas, lineasCompra, movsProyecto, horasControl]
  );
  const otsPerDoc = useMemo(() => otsPerFacturaDesDeLineas(lineas), [lineas]);
  const hayMemoria = fichas.length > 0 || costesLineas.size > 0;

  const docsFactura = useMemo(() => (facturas || []).map(normalizarFactura).filter((f) => f.numero || f.id), [facturas]);
  const docsAbono = useMemo(() => (abonos || []).map(normalizarAbono).filter((a) => a.numero || a.id), [abonos]);

  const facturasPeriodo = useMemo(
    () => docsFactura.filter((f) => enPeriodo(f.fecha, desde, hasta)),
    [docsFactura, desde, hasta]
  );
  const abonosPeriodo = useMemo(
    () => docsAbono.filter((a) => enPeriodo(a.fecha, desde, hasta)),
    [docsAbono, desde, hasta]
  );

  const totalEmpresa = useMemo(() => {
    const fac = facturasPeriodo.reduce((s, f) => s + f.base, 0);
    const abo = abonosPeriodo.reduce((s, a) => s + a.base, 0);
    return fac - abo;
  }, [facturasPeriodo, abonosPeriodo]);

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
          primera: f.fecha || "",
          ultima: f.fecha || "",
        };
        por.set(k, c);
      }
      c.neta += f.base;
      c.nFacturas += 1;
      if (f.cliente && (!c.nombre || c.nombre === c.codigo)) c.nombre = f.cliente;
      if (f.clienteN) c.codigo = f.clienteN;
      if (f.fecha && (!c.primera || f.fecha < c.primera)) c.primera = f.fecha;
      if (f.fecha && (!c.ultima || f.fecha > c.ultima)) c.ultima = f.fecha;
    }
    for (const a of abonosPeriodo) {
      const k = claveCliente(a);
      if (!k) continue;
      let c = por.get(k);
      if (!c) {
        c = {
          clave: k,
          nombre: a.cliente || k,
          codigo: a.clienteN || "",
          neta: 0,
          nFacturas: 0,
          primera: a.fecha || "",
          ultima: a.fecha || "",
        };
        por.set(k, c);
      }
      c.neta -= a.base;
      if (a.cliente && (!c.nombre || c.nombre === c.codigo)) c.nombre = a.cliente;
      if (a.clienteN) c.codigo = a.clienteN;
    }
    let arr = [...por.values()].map((c) => ({
      ...c,
      ticket: c.nFacturas ? c.neta / c.nFacturas : 0,
      pes: totalEmpresa > 0 ? c.neta / totalEmpresa : null,
    }));
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
  }, [facturasPeriodo, abonosPeriodo, totalEmpresa, busqueda]);

  const fitxa = useMemo(() => {
    if (!clienteSel) return null;
    const k = clienteSel.clave;
    const facts = facturasPeriodo.filter((f) => claveCliente(f) === k);
    const abs = abonosPeriodo.filter((a) => claveCliente(a) === k);

    const facturasBruto = facts.reduce((s, f) => s + f.base, 0);
    const abonoImp = abs.reduce((s, a) => s + a.base, 0);
    const neta = facturasBruto - abonoImp;
    const nFacturas = facts.length;
    const ticket = nFacturas ? neta / nFacturas : 0;
    const pes = totalEmpresa > 0 ? neta / totalEmpresa : null;

    let primera = "";
    let ultima = "";
    for (const f of docsFactura.filter((x) => claveCliente(x) === k)) {
      if (f.fecha && (!primera || f.fecha < primera)) primera = f.fecha;
      if (f.fecha && (!ultima || f.fecha > ultima)) ultima = f.fecha;
    }

    const ant = rangoAnyAnterior(desde, hasta);
    const facAnt = docsFactura
      .filter((f) => claveCliente(f) === k && enPeriodo(f.fecha, ant.desde, ant.hasta))
      .reduce((s, f) => s + f.base, 0);
    const aboAnt = docsAbono
      .filter((a) => claveCliente(a) === k && enPeriodo(a.fecha, ant.desde, ant.hasta))
      .reduce((s, a) => s + a.base, 0);
    const netaAnt = facAnt - aboAnt;
    const hayAnt =
      docsFactura.some((f) => claveCliente(f) === k && enPeriodo(f.fecha, ant.desde, ant.hasta)) ||
      docsAbono.some((a) => claveCliente(a) === k && enPeriodo(a.fecha, ant.desde, ant.hasta));
    const delta = hayAnt ? neta - netaAnt : null;
    const deltaPct = hayAnt && netaAnt !== 0 ? (neta - netaAnt) / Math.abs(netaAnt) : hayAnt && netaAnt === 0 && neta !== 0 ? null : hayAnt ? 0 : null;

    const porMes = new Map();
    for (const f of facts) {
      const mes = (f.fecha || "").slice(0, 7);
      if (!mes) continue;
      const m = porMes.get(mes) || { mes, neta: 0, n: 0 };
      m.neta += f.base;
      m.n += 1;
      porMes.set(mes, m);
    }
    for (const a of abs) {
      const mes = (a.fecha || "").slice(0, 7);
      if (!mes) continue;
      const m = porMes.get(mes) || { mes, neta: 0, n: 0 };
      m.neta -= a.base;
      porMes.set(mes, m);
    }
    const mensual = [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes));

    const porUnidad = Object.fromEntries(UNIDADES.map((u) => [u.cod, 0]));
    let sense = 0;
    for (const f of facts) {
      const u = unidadDeDoc(f, mapaOt);
      if (u && porUnidad[u] != null) porUnidad[u] += f.base;
      else sense += f.base;
    }
    // Abonaments sense OT/unitat: resten del total «sense»
    sense -= abonoImp;
    const motivos = [...new Set(abs.map((a) => a.motivo).filter(Boolean))];

    const detall = [
      ...facts.map((f) => ({
        tipo: "factura",
        numero: f.numero,
        fecha: f.fecha,
        base: f.base,
        total: f.total,
        ot: f.ot,
        unidad: unidadDeDoc(f, mapaOt),
      })),
      ...abs.map((a) => ({
        tipo: "abono",
        numero: a.numero,
        fecha: a.fecha,
        base: -a.base,
        total: -a.base,
        ot: a.ot,
        unidad: null,
        motivo: a.motivo,
      })),
    ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    // ——— Bloc B: rentabilitat ———
    // Reparteix cada factura per OT (capçalera o línies registrades).
    const porOtIng = new Map(); // ot → { ot, ingresos, porMes }
    let ingresosSenseOt = 0;
    const afegirIng = (otKey, otLabel, importe, fecha) => {
      if (!otKey) {
        ingresosSenseOt += importe;
        return;
      }
      const row = porOtIng.get(otKey) || { ot: otLabel || otKey, ingresos: 0, porMes: new Map() };
      row.ingresos += importe;
      const mes = (fecha || "").slice(0, 7);
      if (mes) row.porMes.set(mes, (row.porMes.get(mes) || 0) + importe);
      porOtIng.set(otKey, row);
    };
    for (const f of facts) {
      const otCap = claveOt(f.ot);
      if (otCap) {
        afegirIng(otCap, f.ot, f.base, f.fecha);
        continue;
      }
      const parts = otsPerDoc.get(f.numero) || otsPerDoc.get(String(f.numero || "").trim());
      if (parts?.length) {
        const sumaLin = parts.reduce((s, p) => s + Math.abs(p.importe), 0);
        for (const p of parts) {
          const quota = sumaLin > 0 ? f.base * (Math.abs(p.importe) / sumaLin) : f.base / parts.length;
          afegirIng(p.ot, p.ot, quota, f.fecha);
        }
      } else {
        ingresosSenseOt += f.base;
      }
    }
    // Abonaments: resten ingressos (per OT si en tenen; si no, sense OT)
    for (const a of abs) {
      const otCap = claveOt(a.ot);
      if (otCap) afegirIng(otCap, a.ot, -a.base, a.fecha);
      else ingresosSenseOt -= a.base;
    }

    const ots = [];
    let materialTot = 0;
    let moTot = 0;
    let otsSenseFicha = 0;
    const rentUnidad = Object.fromEntries(UNIDADES.map((u) => [u.cod, { ingresos: 0, material: 0, mo: 0 }]));
    let rentSense = { ingresos: ingresosSenseOt, material: 0, mo: 0 };

    for (const [otKey, row] of porOtIng) {
      const fichaOt = fichasPorOt.get(otKey);
      const cost = costesPeriodoOt(fichaOt, row.ingresos, costesLineas.get(otKey));
      if (cost.sinFicha && !(costesLineas.get(otKey)?.material || costesLineas.get(otKey)?.horas)) otsSenseFicha += 1;
      const margen = row.ingresos - cost.material - cost.mo;
      const margenPct = row.ingresos > 0 ? margen / row.ingresos : null;
      const estructura = row.ingresos * PCT_ESTRUCTURA;
      const resultado = margen - estructura;
      const unidad = mapaOt.get(otKey) || unidadDeCodigo(fichaOt?.general?.segmento || fichaOt?.general?.departamento) || null;
      const alerta = resultado < 0 ? "mal" : margenPct != null && margenPct < UMBRAL_MARGEN_BRUT ? "vig" : "ok";
      ots.push({
        ot: row.ot || otKey,
        unidad,
        ingresos: row.ingresos,
        material: cost.material,
        mo: cost.mo,
        margen,
        margenPct,
        estructura,
        resultado,
        alerta,
        sinFicha: cost.sinFicha,
        porMes: row.porMes,
      });
      materialTot += cost.material;
      moTot += cost.mo;
      if (unidad && rentUnidad[unidad]) {
        rentUnidad[unidad].ingresos += row.ingresos;
        rentUnidad[unidad].material += cost.material;
        rentUnidad[unidad].mo += cost.mo;
      } else {
        rentSense.ingresos += row.ingresos;
        rentSense.material += cost.material;
        rentSense.mo += cost.mo;
      }
    }
    ots.sort((a, b) => b.ingresos - a.ingresos);

    const margenBrut = neta - materialTot - moTot;
    const margenBrutPct = neta > 0 ? margenBrut / neta : null;
    const estructuraTot = neta * PCT_ESTRUCTURA;
    const resultadoTot = margenBrut - estructuraTot;
    const alertaCli =
      resultadoTot < 0 ? "mal" : margenBrutPct != null && margenBrutPct < UMBRAL_MARGEN_BRUT ? "vig" : "ok";

    // Evolució mensual marge %: ingressos del mes; costos OT prorratejats pel pes del mes a l'OT
    const mensualRent = new Map();
    for (const m of mensual) mensualRent.set(m.mes, { mes: m.mes, ingresos: m.neta, material: 0, mo: 0 });
    for (const ot of ots) {
      const ingOt = ot.ingresos || 0;
      if (ingOt <= 0) continue;
      for (const [mes, ingMes] of ot.porMes || []) {
        const r = mensualRent.get(mes) || { mes, ingresos: 0, material: 0, mo: 0 };
        const fr = ingMes / ingOt;
        r.material += ot.material * fr;
        r.mo += ot.mo * fr;
        mensualRent.set(mes, r);
      }
    }
    const evolMarge = [...mensualRent.values()]
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map((m) => {
        const margen = m.ingresos - m.material - m.mo;
        return {
          mes: m.mes,
          ingresos: m.ingresos,
          margen,
          margenPct: m.ingresos > 0 ? margen / m.ingresos : null,
        };
      });

    const porUnidadRent = UNIDADES.map((u) => {
      const x = rentUnidad[u.cod];
      const margen = x.ingresos - x.material - x.mo;
      return {
        cod: u.cod,
        etiqueta: u.etiqueta,
        ingresos: x.ingresos,
        material: x.material,
        mo: x.mo,
        margen,
        margenPct: x.ingresos > 0 ? margen / x.ingresos : null,
      };
    });
    const senseRent = {
      etiqueta: "Sense classificar",
      ingresos: rentSense.ingresos,
      material: rentSense.material,
      mo: rentSense.mo,
      margen: rentSense.ingresos - rentSense.material - rentSense.mo,
      margenPct:
        rentSense.ingresos > 0
          ? (rentSense.ingresos - rentSense.material - rentSense.mo) / rentSense.ingresos
          : null,
    };

    return {
      neta,
      facturasBruto,
      nFacturas,
      ticket,
      pes,
      primera,
      ultima,
      hayAnt,
      netaAnt,
      delta,
      deltaPct,
      mensual,
      porUnidad,
      sense,
      abonoImp,
      nAbonos: abs.length,
      motivos,
      detall,
      deuda,
      comp,
      rent: {
        material: materialTot,
        mo: moTot,
        margenBrut,
        margenBrutPct,
        estructura: estructuraTot,
        resultado: resultadoTot,
        alerta: alertaCli,
        ots,
        otsSenseFicha,
        ingresosSenseOt,
        evolMarge,
        porUnidadRent,
        senseRent,
      },
      risc: null, // s'omple després (depèn de rent ja calculat)
    };
  }, [clienteSel, facturasPeriodo, abonosPeriodo, docsFactura, totalEmpresa, desde, hasta, mapaOt, fichasPorOt, costesLineas, otsPerDoc, deuda, comp]);

  const fitxaAmbRisc = useMemo(() => {
    if (!fitxa) return null;
    const risc = calcularRisc({
      deuda: fitxa.deuda,
      comp: fitxa.comp,
      rent: fitxa.rent,
      mensual: fitxa.mensual,
      neta: fitxa.neta,
      nAbonos: fitxa.nAbonos,
    });
    return { ...fitxa, risc, fichaG, condG };
  }, [fitxa, fichaG, condG]);

  const refrescarDeuda = async () => {
    if (!clienteSel) return;
    setDeudaCargando(true);
    setDeudaError(null);
    try {
      const qs = new URLSearchParams();
      if (clienteSel.codigo) qs.set("numero", clienteSel.codigo);
      if (clienteSel.nombre) qs.set("nombre", clienteSel.nombre);
      qs.set("refrescar", "1");
      const r = await fetch(`/api/analisis-cliente/deuda?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
      setDeuda(d);
    } catch (e) {
      setDeuda(null);
      setDeudaError(e.message || String(e));
    } finally {
      setDeudaCargando(false);
    }
  };

  const refrescarComp = async () => {
    if (!clienteSel) return;
    setCompCargando(true);
    setCompError(null);
    try {
      const qs = new URLSearchParams();
      if (clienteSel.codigo) qs.set("numero", clienteSel.codigo);
      if (clienteSel.nombre) qs.set("nombre", clienteSel.nombre);
      qs.set("desde", desde);
      qs.set("hasta", hasta);
      qs.set("refrescar", "1");
      const r = await fetch(`/api/analisis-cliente/comportamiento?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
      setComp(d);
    } catch (e) {
      setComp(null);
      setCompError(e.message || String(e));
    } finally {
      setCompCargando(false);
    }
  };

  const guardarCondiciones = async () => {
    if (!clienteSel) return;
    const clave = clienteSel.codigo || clienteSel.clave || clienteSel.nombre;
    setCondGuardando(true);
    setCondMsg(null);
    try {
      const r = await fetch("/api/analisis-cliente/condiciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cliente: clave, ...condG }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setCondMsg("Condicions desades.");
      if (d.condiciones) setCondG((prev) => ({ ...prev, ...d.condiciones }));
    } catch (e) {
      setCondMsg(e.message || String(e));
    } finally {
      setCondGuardando(false);
    }
  };

  const refrescarTarifas = async () => {
    if (!clienteSel) return;
    const clave = clienteSel.codigo || clienteSel.clave || clienteSel.nombre;
    const r = await fetch(`/api/analisis-cliente/tarifas?cliente=${encodeURIComponent(clave)}`);
    const d = await r.json().catch(() => ({}));
    if (r.ok) setTarifasInfo(d);
  };

  const subirExcelTarifas = async (file, ambito) => {
    if (!file || !clienteSel) return;
    setTarifasSubiendo(true);
    setTarifasMsg(null);
    try {
      const filas = await parsearExcelTarifas(file);
      if (!filas.length) throw new Error("L'Excel no conté línies de tarifa reconeixibles.");
      const clave = clienteSel.codigo || clienteSel.clave || clienteSel.nombre;
      const r = await fetch("/api/analisis-cliente/tarifas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ambito,
          cliente: ambito === "cliente" ? clave : undefined,
          origen: file.name,
          filas,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setTarifasMsg(
        ambito === "cliente"
          ? `Tarifa especial del client carregada (${filas.length} línies).`
          : `Tarifa general actualitzada (${filas.length} línies).`
      );
      await refrescarTarifas();
    } catch (e) {
      setTarifasMsg(e.message || String(e));
    } finally {
      setTarifasSubiendo(false);
    }
  };

  const treureTarifaEspecial = async () => {
    if (!clienteSel) return;
    const clave = clienteSel.codigo || clienteSel.clave || clienteSel.nombre;
    setTarifasSubiendo(true);
    setTarifasMsg(null);
    try {
      const r = await fetch(`/api/analisis-cliente/tarifas?cliente=${encodeURIComponent(clave)}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setTarifasMsg("S'ha tornat a la tarifa general.");
      await refrescarTarifas();
    } catch (e) {
      setTarifasMsg(e.message || String(e));
    } finally {
      setTarifasSubiendo(false);
    }
  };

  const actualizar = async () => {
    if (onActualizar) await onActualizar(desde, hasta);
    if (clienteSel) {
      await Promise.all([refrescarDeuda(), refrescarComp()]);
    }
  };

  const Filtros = (
    <div className="xr-filters">
      <label>
        Des de
        <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>
      <label>
        Fins a
        <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
      </label>
      <button type="button" onClick={actualizar} disabled={actualizando || !onActualizar} className="xr-btn">
        <RefreshCw size={14} className={actualizando ? "animate-spin" : ""} />
        {actualizando ? "Actualitzant…" : "Actualitzar"}
      </button>
    </div>
  );

  if (clienteSel && fitxaAmbRisc) {
    const fitxa = fitxaAmbRisc;
    const maxUnidad = Math.max(fitxa.sense, ...UNIDADES.map((u) => fitxa.porUnidad[u.cod] || 0), 1);
    const r = fitxa.rent;
    const risc = fitxa.risc;
    return (
      <div className="xr-analisi">
        <button
          type="button"
          onClick={() => {
            setClienteSel(null);
            setPestana("a");
            setOrigenId(null);
          }}
          className="xr-btn-ghost mb-3 inline-flex items-center gap-1"
        >
          <ArrowLeft size={16} /> Tornar al llistat
        </button>
        <div className="xr-hero">
          <div>
            <div className="xr-badge">Fitxa client</div>
            <h1>{clienteSel.nombre}</h1>
            <p className="xr-sub">{clienteSel.codigo ? `Codi ${clienteSel.codigo}` : "Sense codi"}</p>
          </div>
          {Filtros}
        </div>

        <div className="xr-tabs">
          {[
            ["a", "A · Comercial"],
            ["b", "B · Rentabilitat"],
            ["c", "C · Deute"],
            ["d", "D · Pagament"],
            ["f", "F · Risc"],
            ["g", "G · Condicions"],
          ].map(([id, titol]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setPestana(id);
                setOrigenId(null);
              }}
              className={`xr-tab${pestana === id ? " activa" : ""}`}
            >
              {titol}
            </button>
          ))}
        </div>

        {pestana === "a" && (
          <>
            <div className="xr-kpi-grid">
              <Tarjeta id="neta" activa={origenId === "neta"} onElegir={setOrigenId} titol="Facturació neta" valor={eur(fitxa.neta)} sub="Factures − abonaments" />
              <Tarjeta
                id="vsAny"
                activa={origenId === "vsAny"}
                onElegir={setOrigenId}
                titol="vs any anterior"
                valor={fitxa.hayAnt ? eur(fitxa.delta) : "—"}
                sub={
                  fitxa.hayAnt
                    ? `${fitxa.deltaPct == null ? "—" : pct(fitxa.deltaPct)} · abans ${eur(fitxa.netaAnt)}`
                    : "Sense dades any anterior"
                }
              />
              <Tarjeta id="nFactures" activa={origenId === "nFactures"} onElegir={setOrigenId} titol="Nº factures" valor={String(fitxa.nFacturas)} />
              <Tarjeta id="ticket" activa={origenId === "ticket"} onElegir={setOrigenId} titol="Ticket mitjà" valor={eur2(fitxa.ticket)} />
              <Tarjeta id="pes" activa={origenId === "pes"} onElegir={setOrigenId} titol="Pes sobre l'empresa" valor={pct(fitxa.pes)} />
              <Tarjeta id="primera" activa={origenId === "primera"} onElegir={setOrigenId} titol="Primera factura" valor={fechaCorta(fitxa.primera)} sub="Històric disponible" />
              <Tarjeta id="darrera" activa={origenId === "darrera"} onElegir={setOrigenId} titol="Darrera factura" valor={fechaCorta(fitxa.ultima)} sub="Històric disponible" />
              <Tarjeta id="abonaments" activa={origenId === "abonaments"} onElegir={setOrigenId} titol="Abonaments" valor={eur(fitxa.abonoImp)} sub={`${fitxa.nAbonos} document(s)`} />
            </div>
            <PanelOrigenClienta id={origenId} fitxa={fitxa} desde={desde} hasta={hasta} onTancar={() => setOrigenId(null)} />

            <SeccioXR titol="Evolució mensual">
              {fitxa.mensual.length === 0 ? (
                <p className="text-sm text-slate-500">Cap factura en aquest període.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Mes</th>
                      <th className="text-right">Facturació neta</th>
                      <th className="text-right">Nº factures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fitxa.mensual.map((m) => (
                      <tr key={m.mes}>
                        <td>{m.mes}</td>
                        <td className="text-right font-medium">{eur2(m.neta)}</td>
                        <td className="text-right">{m.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SeccioXR>

            <SeccioXR titol="Facturació per unitat" sub="Segons departament / línia de negoci de l'OT.">
              <div className="space-y-2.5">
                {UNIDADES.map((u) => {
                  const v = fitxa.porUnidad[u.cod] || 0;
                  const w = Math.max(2, (Math.abs(v) / maxUnidad) * 100);
                  return (
                    <div key={u.cod} className="grid grid-cols-[9rem_1fr_7rem] items-center gap-2 text-sm">
                      <span className="text-slate-600">{u.etiqueta}</span>
                      <div className="xr-bar">
                        <span style={{ width: `${w}%` }} />
                      </div>
                      <span className="text-right font-medium">{eur2(v)}</span>
                    </div>
                  );
                })}
                <div className="grid grid-cols-[9rem_1fr_7rem] items-center gap-2 text-sm">
                  <span className="text-slate-600">Sense classificar</span>
                  <div className="xr-bar">
                    <span className="slate" style={{ width: `${Math.max(2, (Math.abs(fitxa.sense) / maxUnidad) * 100)}%` }} />
                  </div>
                  <span className="text-right font-medium">{eur2(fitxa.sense)}</span>
                </div>
              </div>
            </SeccioXR>

            <SeccioXR titol="Abonaments">
              <p className="text-sm">
                {fitxa.nAbonos} abonament(s) · import net {eur2(fitxa.abonoImp)}
              </p>
              {fitxa.motivos.length > 0 ? (
                <p className="text-xs text-slate-500 mt-1">Motius: {fitxa.motivos.join(" · ")}</p>
              ) : (
                <p className="text-xs text-amber-800 mt-1">Motius no disponibles a la font actual</p>
              )}
            </SeccioXR>

            <SeccioXR titol="Detall de documents" className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Tipus</th>
                    <th>Núm.</th>
                    <th>Data</th>
                    <th>OT</th>
                    <th>Unitat</th>
                    <th className="text-right">Base</th>
                  </tr>
                </thead>
                <tbody>
                  {fitxa.detall.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-slate-500">
                        Cap document en el període.
                      </td>
                    </tr>
                  ) : (
                    fitxa.detall.map((d) => (
                      <tr key={`${d.tipo}-${d.numero}`}>
                        <td>{d.tipo === "abono" ? "Abonament" : "Factura"}</td>
                        <td className="font-mono text-xs">{d.numero}</td>
                        <td>{fechaCorta(d.fecha)}</td>
                        <td className="text-xs">{d.ot || "—"}</td>
                        <td className="text-xs">{d.unidad ? ETIQUETA_UNIDAD[d.unidad] : "—"}</td>
                        <td className={`text-right font-medium ${d.base < 0 ? "text-red-700" : ""}`}>{eur2(d.base)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </SeccioXR>
          </>
        )}

        {pestana === "b" && (
          <>
            {!hayMemoria && (
              <div className="xr-note amber">
                Per veure costos (material i mà d&apos;obra) cal la <strong>Memòria històrica</strong> construïda. Els ingressos sí surten de les factures del període.
              </div>
            )}
            <p className="text-xs text-slate-500 mb-3">
              Ingressos = factures − abonaments del període (sense IVA). Material = compres de l&apos;OT. Mà d&apos;obra = hores × {TARIFA_COSTE_MO.toLocaleString("es-ES", { minimumFractionDigits: 2 })} €/h.
              Estructura {pct(PCT_ESTRUCTURA)} · Alerta si marge brut &lt; {pct(UMBRAL_MARGEN_BRUT)}.
            </p>

            {(r.alerta === "mal" || r.alerta === "vig") && (
              <div className={`xr-note ${r.alerta === "mal" ? "red" : "amber"}`}>
                {r.alerta === "mal"
                  ? "Resultat negatiu en el període (pèrdua després d'estructura)."
                  : `Marge brut per sota de l'objectiu (${pct(UMBRAL_MARGEN_BRUT)}).`}
              </div>
            )}

            <div className="xr-kpi-grid cols-3">
              <Tarjeta id="neta" activa={origenId === "neta"} onElegir={setOrigenId} titol="Ingressos nets" valor={eur(fitxa.neta)} sub="Factures − abonaments" />
              <Tarjeta id="material" activa={origenId === "material"} onElegir={setOrigenId} titol="Material" valor={eur2(r.material)} />
              <Tarjeta id="mo" activa={origenId === "mo"} onElegir={setOrigenId} titol="Mà d'obra" valor={eur2(r.mo)} sub={`${TARIFA_COSTE_MO} €/h`} />
              <Tarjeta
                id="marge"
                activa={origenId === "marge"}
                onElegir={setOrigenId}
                titol="Marge brut"
                valor={eur2(r.margenBrut)}
                sub={pct(r.margenBrutPct)}
                alerta={r.margenBrutPct != null && r.margenBrutPct < UMBRAL_MARGEN_BRUT ? "vig" : undefined}
              />
              <Tarjeta id="estructura" activa={origenId === "estructura"} onElegir={setOrigenId} titol="Estructura 22 %" valor={eur2(r.estructura)} />
              <Tarjeta
                id="resultat"
                activa={origenId === "resultat"}
                onElegir={setOrigenId}
                titol="Resultat"
                valor={eur2(r.resultado)}
                sub={fitxa.neta > 0 ? pct(r.resultado / fitxa.neta) : "—"}
                alerta={r.resultado < 0 ? "mal" : undefined}
              />
            </div>
            <PanelOrigenClienta id={origenId} fitxa={fitxa} desde={desde} hasta={hasta} onTancar={() => setOrigenId(null)} />

            {r.ingresosSenseOt > 0 && (
              <p className="text-xs text-amber-800 mb-3">
                {eur2(r.ingresosSenseOt)} d&apos;ingressos sense OT a la factura (sense cost assignat per OT).
              </p>
            )}
            {r.otsSenseFicha > 0 && (
              <p className="text-xs text-amber-800 mb-3">
                {r.otsSenseFicha} OT sense fitxa a la memòria (cost = 0 fins a reconstruir memòria).
              </p>
            )}

            <SeccioXR titol="Per unitat de negoci">
              <table>
                <thead>
                  <tr>
                    <th>Unitat</th>
                    <th className="text-right">Ingressos</th>
                    <th className="text-right">Material</th>
                    <th className="text-right">MO</th>
                    <th className="text-right">Marge</th>
                    <th className="text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.porUnidadRent, r.senseRent].map((u) => (
                    <tr key={u.etiqueta}>
                      <td>{u.etiqueta}</td>
                      <td className="text-right">{eur2(u.ingresos)}</td>
                      <td className="text-right">{eur2(u.material)}</td>
                      <td className="text-right">{eur2(u.mo)}</td>
                      <td className={`text-right font-medium ${u.margen < 0 ? "text-red-700" : ""}`}>{eur2(u.margen)}</td>
                      <td className="text-right">{pct(u.margenPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SeccioXR>

            <SeccioXR titol="Evolució mensual del marge brut">
              {r.evolMarge.length === 0 ? (
                <p className="text-sm text-slate-500">Sense dades.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Mes</th>
                      <th className="text-right">Ingressos</th>
                      <th className="text-right">Marge brut</th>
                      <th className="text-right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.evolMarge.map((m) => (
                      <tr key={m.mes}>
                        <td>{m.mes}</td>
                        <td className="text-right">{eur2(m.ingresos)}</td>
                        <td className={`text-right ${m.margen < 0 ? "text-red-700" : ""}`}>{eur2(m.margen)}</td>
                        <td className={`text-right ${m.margenPct != null && m.margenPct < UMBRAL_MARGEN_BRUT ? "text-amber-800" : ""}`}>
                          {pct(m.margenPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SeccioXR>

            <SeccioXR titol="Per OT" className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>OT</th>
                    <th>Unitat</th>
                    <th className="text-right">Ingressos</th>
                    <th className="text-right">Material</th>
                    <th className="text-right">MO</th>
                    <th className="text-right">Marge</th>
                    <th className="text-right">Estructura</th>
                    <th className="text-right">Resultat</th>
                  </tr>
                </thead>
                <tbody>
                  {r.ots.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-slate-500">
                        Cap OT a les factures del període.
                      </td>
                    </tr>
                  ) : (
                    r.ots.map((o) => (
                      <tr key={o.ot} className={o.alerta === "mal" ? "bg-red-50/60" : o.alerta === "vig" ? "bg-amber-50/50" : ""}>
                        <td className="font-mono text-xs">
                          {o.ot}
                          {o.sinFicha ? <span className="ml-1 text-amber-700">*</span> : null}
                        </td>
                        <td className="text-xs">{o.unidad ? ETIQUETA_UNIDAD[o.unidad] : "—"}</td>
                        <td className="text-right">{eur2(o.ingresos)}</td>
                        <td className="text-right">{eur2(o.material)}</td>
                        <td className="text-right">{eur2(o.mo)}</td>
                        <td className={`text-right ${o.margen < 0 ? "text-red-700" : ""}`}>{eur2(o.margen)}</td>
                        <td className="text-right">{eur2(o.estructura)}</td>
                        <td className={`text-right font-medium ${o.resultado < 0 ? "text-red-700" : ""}`}>{eur2(o.resultado)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </SeccioXR>
          </>
        )}

        {pestana === "c" && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              Foto actual del deute (factures i abonaments Open). No depèn del filtre de període d&apos;A/B.
            </p>

            {deudaCargando && <div className="xr-note muted">Carregant deute oberta…</div>}
            {deudaError && <div className="xr-note red">No s&apos;ha pogut carregar la deute: {deudaError}</div>}

            {fitxa.deuda && (
              <>
                {(fitxa.deuda.vencido > 0 || fitxa.deuda.aging?.d90 > 0) && (
                  <div className={`xr-note ${fitxa.deuda.aging?.d90 > 0 ? "red" : "amber"}`}>
                    {fitxa.deuda.aging?.d90 > 0
                      ? `Hi ha ${eur2(fitxa.deuda.aging.d90)} amb més de 90 dies de retard.`
                      : `Hi ha ${eur2(fitxa.deuda.vencido)} vençut pendent de cobrament.`}
                  </div>
                )}

                <div className="xr-kpi-grid">
                  <Tarjeta
                    id="pendCobro"
                    activa={origenId === "pendCobro"}
                    onElegir={setOrigenId}
                    titol="Pendent de cobrament"
                    valor={eur(fitxa.deuda.pendiente)}
                    sub={`${fitxa.deuda.facturas?.length || 0} factura(es) Open`}
                    alerta={fitxa.deuda.pendiente > 0 && fitxa.deuda.vencido > 0 ? "vig" : undefined}
                  />
                  <Tarjeta
                    id="vencido"
                    activa={origenId === "vencido"}
                    onElegir={setOrigenId}
                    titol="Vençut"
                    valor={eur(fitxa.deuda.vencido)}
                    sub={fitxa.deuda.pendiente > 0 ? pct(fitxa.deuda.vencido / fitxa.deuda.pendiente) + " del pendent" : undefined}
                    alerta={fitxa.deuda.vencido > 0 ? (fitxa.deuda.aging?.d90 > 0 ? "mal" : "vig") : undefined}
                  />
                  <Tarjeta
                    id="noVencido"
                    activa={origenId === "noVencido"}
                    onElegir={setOrigenId}
                    titol="Encara no vençut"
                    valor={eur(fitxa.deuda.noVencido)}
                  />
                  <Tarjeta
                    id="abonosPend"
                    activa={origenId === "abonosPend"}
                    onElegir={setOrigenId}
                    titol="Abonaments pendents"
                    valor={eur(fitxa.deuda.abonosPendientes)}
                    sub={`${fitxa.deuda.abonos?.length || 0} document(s) Open`}
                  />
                  <Tarjeta
                    id="exposicio"
                    activa={origenId === "exposicio"}
                    onElegir={setOrigenId}
                    titol="Exposició neta"
                    valor={eur(fitxa.deuda.exposicion)}
                    sub={
                      fitxa.deuda.creditLimitDisponible && fitxa.deuda.creditLimit > 0
                        ? `Límit ${eur(fitxa.deuda.creditLimit)} · ús ${pct(fitxa.deuda.exposicion / fitxa.deuda.creditLimit)}`
                        : "Sense límit de crèdit informat"
                    }
                    alerta={
                      fitxa.deuda.creditLimitDisponible && fitxa.deuda.creditLimit > 0 && fitxa.deuda.exposicion > fitxa.deuda.creditLimit
                        ? "mal"
                        : undefined
                    }
                  />
                  <Tarjeta
                    id="aging"
                    activa={origenId === "aging"}
                    onElegir={setOrigenId}
                    titol="Antiguitat >90 d"
                    valor={eur(fitxa.deuda.aging?.d90 || 0)}
                    sub="Clic per veure tots els trams"
                    alerta={(fitxa.deuda.aging?.d90 || 0) > 0 ? "mal" : undefined}
                  />
                  <TarjetaND titol="Parcialment cobrades" sub="La font no porta Remaining Amount" />
                  <TarjetaND titol="Retencions / reclamacions" sub="Sense camp a la font actual" />
                </div>
                <PanelOrigenClienta id={origenId} fitxa={fitxa} desde={desde} hasta={hasta} onTancar={() => setOrigenId(null)} />

                <SeccioXR titol="Antiguitat dels saldos" sub="Dies de retard respecte al venciment.">
                  {(() => {
                    const a = fitxa.deuda.aging || {};
                    const filas = [
                      ["No vençut", a.noVenc || 0, ""],
                      ["1–30 dies", a.d1_30 || 0, "amber"],
                      ["31–60 dies", a.d31_60 || 0, "amber"],
                      ["61–90 dies", a.d61_90 || 0, "amber"],
                      [">90 dies", a.d90 || 0, "red"],
                    ];
                    if (a.senseVenc) filas.push(["Sense venciment", a.senseVenc, "slate"]);
                    const maxA = Math.max(1, ...filas.map(([, v]) => v));
                    return (
                      <div className="space-y-2.5">
                        {filas.map(([eti, v, tono]) => (
                          <div key={eti} className="grid grid-cols-[8rem_1fr_7rem] items-center gap-2 text-sm">
                            <span className="text-slate-600">{eti}</span>
                            <div className="xr-bar">
                              <span className={tono} style={{ width: `${Math.max(v > 0 ? 2 : 0, (v / maxA) * 100)}%` }} />
                            </div>
                            <span className={`text-right font-medium ${eti === ">90 dies" && v > 0 ? "text-red-700" : ""}`}>{eur2(v)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </SeccioXR>

                <SeccioXR titol="Detall de factures obertes" className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>Factura</th>
                        <th>Data</th>
                        <th>Venciment</th>
                        <th>Tram</th>
                        <th className="text-right">Dies</th>
                        <th className="text-right">Import</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(fitxa.deuda.facturas || []).length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-slate-500">
                            Cap factura Open per a aquest client.
                          </td>
                        </tr>
                      ) : (
                        fitxa.deuda.facturas.map((d) => {
                          const tram =
                            d.aging === "noVenc"
                              ? "No vençut"
                              : d.aging === "d1_30"
                                ? "1–30"
                                : d.aging === "d31_60"
                                  ? "31–60"
                                  : d.aging === "d61_90"
                                    ? "61–90"
                                    : d.aging === "d90"
                                      ? ">90"
                                      : "Sense venc.";
                          return (
                            <tr key={d.numero} className={d.aging === "d90" ? "bg-red-50/60" : d.vencida ? "bg-amber-50/40" : ""}>
                              <td className="font-mono text-xs">{d.numero}</td>
                              <td>{fechaCorta(d.fecha)}</td>
                              <td>{fechaCorta(d.vencimiento) || "—"}</td>
                              <td className="text-xs">{tram}</td>
                              <td className={`text-right ${d.vencida ? "text-red-700 font-medium" : ""}`}>
                                {d.diasVencido != null && d.diasVencido > 0 ? d.diasVencido : "—"}
                              </td>
                              <td className="text-right font-medium">{eur2(d.importe)}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                  {(fitxa.deuda.abonos || []).length > 0 && (
                    <>
                      <h3 className="text-sm font-semibold mt-5 mb-2">Abonaments Open</h3>
                      <table>
                        <thead>
                          <tr>
                            <th>Abonament</th>
                            <th>Data</th>
                            <th className="text-right">Import</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fitxa.deuda.abonos.map((d) => (
                            <tr key={d.numero}>
                              <td className="font-mono text-xs">{d.numero}</td>
                              <td>{fechaCorta(d.fecha)}</td>
                              <td className="text-right font-medium">{eur2(d.importe)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </SeccioXR>
              </>
            )}
          </>
        )}

        {pestana === "d" && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              Històric del període + previsió Open. Data de cobrament <strong>aproximada</strong> (darrera modificació Paid).
            </p>

            {compCargando && <div className="xr-note muted">Calculant comportament de pagament…</div>}
            {compError && <div className="xr-note red">No s&apos;ha pogut carregar: {compError}</div>}

            {fitxa.comp && (
              <>
                <div className="xr-note sky">
                  {fitxa.comp.avisos?.[0] ||
                    "Cobrament aproximat amb lastModifiedDateTime quan l'estat és Paid."}
                </div>

                {(fitxa.comp.pctPuntual != null && fitxa.comp.pctPuntual < 0.7) ||
                (fitxa.comp.retrasoMedio != null && fitxa.comp.retrasoMedio > 15) ? (
                  <div className="xr-note amber">
                    Comportament de pagament a vigilar
                    {fitxa.comp.pctPuntual != null ? ` · puntualitat ${pct(fitxa.comp.pctPuntual)}` : ""}
                    {fitxa.comp.retrasoMedio != null ? ` · retard mitjà ${Math.round(fitxa.comp.retrasoMedio)} dies` : ""}.
                  </div>
                ) : null}

                <div className="xr-kpi-grid">
                  <Tarjeta
                    id="plazoReal"
                    activa={origenId === "plazoReal"}
                    onElegir={setOrigenId}
                    titol="Termini mitjà real"
                    valor={fitxa.comp.plazoMedioReal != null ? `${Math.round(fitxa.comp.plazoMedioReal)} d` : "—"}
                    sub={
                      fitxa.comp.plazoMedioPactado != null
                        ? `Pactat ${Math.round(fitxa.comp.plazoMedioPactado)} d`
                        : undefined
                    }
                  />
                  <Tarjeta
                    id="retrasoMedio"
                    activa={origenId === "retrasoMedio"}
                    onElegir={setOrigenId}
                    titol="Retard mitjà"
                    valor={fitxa.comp.retrasoMedio != null ? `${Math.round(fitxa.comp.retrasoMedio)} d` : "—"}
                    sub="vs venciment"
                    alerta={fitxa.comp.retrasoMedio != null && fitxa.comp.retrasoMedio > 15 ? "vig" : undefined}
                  />
                  <Tarjeta
                    id="pctPuntual"
                    activa={origenId === "pctPuntual"}
                    onElegir={setOrigenId}
                    titol="% puntual"
                    valor={pct(fitxa.comp.pctPuntual)}
                    sub={`${fitxa.comp.nCobradasConFecha || 0} cobrades`}
                    alerta={fitxa.comp.pctPuntual != null && fitxa.comp.pctPuntual < 0.7 ? "vig" : undefined}
                  />
                  <Tarjeta
                    id="importeMedioD"
                    activa={origenId === "importeMedioD"}
                    onElegir={setOrigenId}
                    titol="Import mitjà factura"
                    valor={eur2(fitxa.comp.importeMedio)}
                    sub={`${fitxa.comp.nFacturasPeriodo || 0} al període`}
                  />
                  <Tarjeta
                    id="mayorRetraso"
                    activa={origenId === "mayorRetraso"}
                    onElegir={setOrigenId}
                    titol="Major retard"
                    valor={fitxa.comp.mayorRetraso != null ? `${Math.round(fitxa.comp.mayorRetraso)} d` : "—"}
                    alerta={fitxa.comp.mayorRetraso != null && fitxa.comp.mayorRetraso > 60 ? "mal" : undefined}
                  />
                  <Tarjeta
                    id="incidencias"
                    activa={origenId === "incidencias"}
                    onElegir={setOrigenId}
                    titol="Incidències cobrament"
                    valor={String(fitxa.comp.incidencias ?? 0)}
                    sub={`${fitxa.comp.incidenciasHist || 0} hist. + ${fitxa.comp.incidenciasOpen || 0} open`}
                    alerta={(fitxa.comp.incidencias || 0) > 0 ? "vig" : undefined}
                  />
                  <Tarjeta
                    id="evolPago"
                    activa={origenId === "evolPago"}
                    onElegir={setOrigenId}
                    titol="Evolució"
                    valor={`${fitxa.comp.evolucion?.length || 0} mesos`}
                    sub="Clic · detall mensual"
                  />
                  <Tarjeta
                    id="prevision"
                    activa={origenId === "prevision"}
                    onElegir={setOrigenId}
                    titol="Previsió cobraments"
                    valor={eur((fitxa.comp.previsionMes || []).reduce((s, x) => s + x.importe, 0))}
                    sub={`${fitxa.comp.nOpen || 0} Open per venciment`}
                  />
                </div>
                <PanelOrigenClienta id={origenId} fitxa={fitxa} desde={desde} hasta={hasta} onTancar={() => setOrigenId(null)} />

                <SeccioXR titol="Evolució del comportament">
                  {(fitxa.comp.evolucion || []).length === 0 ? (
                    <p className="text-sm text-slate-500">Sense factures Paid amb data aproximada en aquest període.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Mes cobrament</th>
                          <th className="text-right">Nº</th>
                          <th className="text-right">Retard mitjà</th>
                          <th className="text-right">% puntual</th>
                          <th className="text-right">Import</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fitxa.comp.evolucion.map((m) => (
                          <tr key={m.mes}>
                            <td>{m.mes}</td>
                            <td className="text-right">{m.n}</td>
                            <td className={`text-right ${m.retrasoMedio != null && m.retrasoMedio > 15 ? "text-amber-800" : ""}`}>
                              {m.retrasoMedio != null ? `${Math.round(m.retrasoMedio)} d` : "—"}
                            </td>
                            <td className="text-right">{pct(m.pctPuntual)}</td>
                            <td className="text-right">{eur2(m.importe)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </SeccioXR>

                <SeccioXR titol="Previsió de cobraments per mes" sub="Factures Open agrupades per venciment.">
                  {(fitxa.comp.previsionMes || []).length === 0 ? (
                    <p className="text-sm text-slate-500">Cap factura Open.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Mes</th>
                          <th className="text-right">Factures</th>
                          <th className="text-right">Ja vençudes</th>
                          <th className="text-right">Import</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fitxa.comp.previsionMes.map((m) => (
                          <tr key={m.clave}>
                            <td>{m.clave}</td>
                            <td className="text-right">{m.n}</td>
                            <td className={`text-right ${m.vencidas ? "text-red-700" : ""}`}>{m.vencidas || "—"}</td>
                            <td className="text-right font-medium">{eur2(m.importe)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {(fitxa.comp.previsionSemana || []).length > 0 && (
                    <>
                      <h3 className="text-sm font-semibold mt-5 mb-2">Per setmana (ISO)</h3>
                      <div className="max-h-48 overflow-auto">
                        <table>
                          <thead>
                            <tr>
                              <th>Setmana</th>
                              <th className="text-right">Nº</th>
                              <th className="text-right">Import</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fitxa.comp.previsionSemana.map((s) => (
                              <tr key={s.clave}>
                                <td className="font-mono text-xs">{s.clave}</td>
                                <td className="text-right">{s.n}</td>
                                <td className="text-right">{eur2(s.importe)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </SeccioXR>

                <SeccioXR titol="Detall cobraments del període (Paid)" className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>Factura</th>
                        <th>Data</th>
                        <th>Venciment</th>
                        <th>Cobrament≈</th>
                        <th className="text-right">Termini</th>
                        <th className="text-right">Retard</th>
                        <th className="text-right">Import</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(fitxa.comp.cobradas || []).length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-slate-500">
                            Cap factura Paid amb data aproximada en el període.
                          </td>
                        </tr>
                      ) : (
                        fitxa.comp.cobradas.map((d) => (
                          <tr key={d.numero} className={d.retraso > 0 ? "bg-amber-50/40" : ""}>
                            <td className="font-mono text-xs">{d.numero}</td>
                            <td>{fechaCorta(d.fecha)}</td>
                            <td>{fechaCorta(d.vencimiento)}</td>
                            <td>{fechaCorta(d.cobroAprox)}</td>
                            <td className="text-right">{d.plazoReal != null ? `${d.plazoReal} d` : "—"}</td>
                            <td className={`text-right ${d.retraso > 0 ? "text-red-700 font-medium" : ""}`}>
                              {d.retraso != null ? `${d.retraso} d` : "—"}
                            </td>
                            <td className="text-right font-medium">{eur2(d.importe)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </SeccioXR>
              </>
            )}
          </>
        )}

        {pestana === "f" && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              Valoració interna a partir de deute (C), comportament (D) i rentabilitat (B). No és un rating oficial.
            </p>
            <div className={`xr-note ${risc.nivel === "alt" ? "red" : risc.nivel === "mitja" ? "amber" : "sky"}`}>
              {risc.avis}
            </div>

            <div className="xr-kpi-grid">
              <Tarjeta
                id="riscNivel"
                activa={origenId === "riscNivel"}
                onElegir={setOrigenId}
                titol="Nivell de risc"
                valor={risc.etiqueta}
                sub={`${risc.pts} punts`}
                alerta={risc.nivel === "alt" ? "mal" : risc.nivel === "mitja" ? "vig" : undefined}
              />
              <Tarjeta
                id="riscMotius"
                activa={origenId === "riscMotius"}
                onElegir={setOrigenId}
                titol="Motius"
                valor={String(risc.motivos.length)}
                sub="Clic · detall"
              />
              <Tarjeta
                id="vencido"
                activa={origenId === "vencido"}
                onElegir={setOrigenId}
                titol="Impagat / vençut"
                valor={eur(fitxa.deuda?.vencido || 0)}
                sub={fitxa.deuda?.aging?.d90 ? `>90 d ${eur(fitxa.deuda.aging.d90)}` : "Sense >90 d"}
                alerta={(fitxa.deuda?.aging?.d90 || 0) > 0 ? "mal" : (fitxa.deuda?.vencido || 0) > 0 ? "vig" : undefined}
              />
              <Tarjeta
                id="exposicio"
                activa={origenId === "exposicio"}
                onElegir={setOrigenId}
                titol="Ús límit crèdit"
                valor={
                  fitxa.deuda?.creditLimitDisponible && fitxa.deuda.creditLimit > 0
                    ? pct(fitxa.deuda.exposicion / fitxa.deuda.creditLimit)
                    : "—"
                }
                sub={
                  fitxa.deuda?.creditLimitDisponible && fitxa.deuda.creditLimit > 0
                    ? `Límit ${eur(fitxa.deuda.creditLimit)}`
                    : "Sense límit informat"
                }
              />
              <Tarjeta
                id="pctPuntual"
                activa={origenId === "pctPuntual"}
                onElegir={setOrigenId}
                titol="Puntualitat"
                valor={pct(fitxa.comp?.pctPuntual)}
                sub={fitxa.comp?.retrasoMedio != null ? `Retard mitjà ${Math.round(fitxa.comp.retrasoMedio)} d` : undefined}
              />
              <Tarjeta
                id="marge"
                activa={origenId === "marge"}
                onElegir={setOrigenId}
                titol="Marge brut"
                valor={pct(r?.margenBrutPct)}
                sub={r?.resultado != null ? `Resultat ${eur2(r.resultado)}` : undefined}
                alerta={r?.resultado < 0 ? "mal" : r?.margenBrutPct != null && r.margenBrutPct < UMBRAL_MARGEN_BRUT ? "vig" : undefined}
              />
            </div>
            <PanelOrigenClienta id={origenId} fitxa={fitxa} desde={desde} hasta={hasta} onTancar={() => setOrigenId(null)} />

            <SeccioXR titol="Motius visibles">
              <ul className="space-y-2">
                {risc.motivos.map((m, i) => (
                  <li
                    key={i}
                    className={`text-sm rounded-lg px-3 py-2 border ${
                      m.grav === "mal"
                        ? "border-red-200 bg-red-50/80 text-red-900"
                        : m.grav === "vig"
                          ? "border-amber-200 bg-amber-50/80 text-amber-950"
                          : "border-slate-200 bg-white/70 text-slate-700"
                    }`}
                  >
                    {m.text}
                  </li>
                ))}
              </ul>
            </SeccioXR>
          </>
        )}

        {pestana === "g" && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              Fitxa del sistema + notes internes (PO, FACE, periodicitat…) que sovint provoquen retards de facturació.
            </p>

            {fichaGError && <div className="xr-note amber">Fitxa BC: {fichaGError}</div>}

            <SeccioXR titol="Fitxa del client (sistema)">
              {fichaG ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div>
                    <span className="text-slate-500">Codi / CIF</span>
                    <div className="font-medium">
                      {fichaG.numero || "—"} {fichaG.cif ? `· ${fichaG.cif}` : ""}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Bloquejat</span>
                    <div className="font-medium">{fichaG.blocked || "No"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">Email</span>
                    <div className="font-medium">{fichaG.email || "—"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">Telèfon</span>
                    <div className="font-medium">{fichaG.telefono || "—"}</div>
                  </div>
                  <div className="md:col-span-2">
                    <span className="text-slate-500">Adreça</span>
                    <div className="font-medium">
                      {[fichaG.direccion, fichaG.cp, fichaG.ciudad, fichaG.pais].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Condicions de pagament</span>
                    <div className="font-medium">
                      {fichaG.paymentTerms
                        ? `${fichaG.paymentTerms.code || ""} ${fichaG.paymentTerms.displayName || ""}`.trim()
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Forma de pagament</span>
                    <div className="font-medium">
                      {fichaG.paymentMethod
                        ? `${fichaG.paymentMethod.code || ""} ${fichaG.paymentMethod.displayName || ""}`.trim()
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Límit de crèdit</span>
                    <div className="font-medium">
                      {fichaG.creditLimit != null ? eur2(fichaG.creditLimit) : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Saldo (fitxa)</span>
                    <div className="font-medium">{fichaG.balance != null ? eur2(fichaG.balance) : "—"}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Carregant fitxa…</p>
              )}
            </SeccioXR>

            <SeccioXR
              titol="Tarifes de mà d'obra"
              sub="Per defecte tots els clients comparteixen la tarifa general (Excel de línies). Si aquest client varia, puja el seu Excel especial."
            >
              <div className={`xr-note ${tarifasInfo?.usaEspecial ? "amber" : "sky"} mb-3`}>
                {tarifasInfo?.usaEspecial
                  ? `Aquest client té tarifa especial (${tarifasInfo.especial?.origen || "excel"} · ${tarifasInfo.especial?.filas?.length || 0} línies).`
                  : `Tarifa general (${tarifasInfo?.general?.origen || "defecte"} · ${tarifasInfo?.activa?.filas?.length || 0} línies).`}
              </div>

              <TablaTarifasMO filas={tarifasInfo?.activa?.filas || []} />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  ref={fileTarifaGenRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) subirExcelTarifas(f, "general");
                  }}
                />
                <input
                  ref={fileTarifaCliRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) subirExcelTarifas(f, "cliente");
                  }}
                />
                <button
                  type="button"
                  className="xr-btn-ghost inline-flex items-center gap-1"
                  disabled={tarifasSubiendo}
                  onClick={() => fileTarifaGenRef.current?.click()}
                >
                  <Upload size={14} /> Actualitzar tarifa general
                </button>
                <button
                  type="button"
                  className="xr-btn inline-flex items-center gap-1"
                  disabled={tarifasSubiendo}
                  onClick={() => fileTarifaCliRef.current?.click()}
                >
                  <Upload size={14} /> Pujar tarifa especial d&apos;aquest client
                </button>
                {tarifasInfo?.usaEspecial && (
                  <button type="button" className="xr-btn-ghost" disabled={tarifasSubiendo} onClick={treureTarifaEspecial}>
                    Tornar a la general
                  </button>
                )}
              </div>
              {tarifasMsg && <p className="text-xs text-slate-600 mt-2">{tarifasMsg}</p>}
            </SeccioXR>

            <SeccioXR
              titol="Condicions administratives (notes ACSales)"
              sub="Editable. No escriu al sistema de gestió: només memòria interna per empresa."
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="xr-po"
                    checked={!!condG.necesitaPO}
                    onChange={(e) => setCondG((p) => ({ ...p, necesitaPO: e.target.checked }))}
                  />
                  <label htmlFor="xr-po" style={{ display: "inline", margin: 0 }}>
                    Necessita PO / comanda del client
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="xr-alb"
                    checked={!!condG.albaranValorado}
                    onChange={(e) => setCondG((p) => ({ ...p, albaranValorado: e.target.checked }))}
                  />
                  <label htmlFor="xr-alb" style={{ display: "inline", margin: 0 }}>
                    Albarà valorat abans de facturar
                  </label>
                </div>
                <label>
                  Periodicitat de facturació
                  <select
                    value={condG.periodicidad}
                    onChange={(e) => setCondG((p) => ({ ...p, periodicidad: e.target.value }))}
                  >
                    <option value="">—</option>
                    <option value="mensual">Mensual</option>
                    <option value="quinzenal">Quinzenal</option>
                    <option value="per_treball">Per treball / OT</option>
                    <option value="altra">Altra</option>
                  </select>
                </label>
                <label>
                  Plataforma / FACE / portal
                  <input
                    value={condG.facePortal}
                    onChange={(e) => setCondG((p) => ({ ...p, facePortal: e.target.value }))}
                    placeholder="Ex. FACE, portal client…"
                  />
                </label>
                <label className="md:col-span-2">
                  Retencions / condicions especials
                  <textarea
                    rows={2}
                    value={condG.retenciones}
                    onChange={(e) => setCondG((p) => ({ ...p, retenciones: e.target.value }))}
                  />
                </label>
                <label className="md:col-span-2">
                  Contactes facturació / reclamacions (extra)
                  <textarea
                    rows={2}
                    value={condG.contactosExtra}
                    onChange={(e) => setCondG((p) => ({ ...p, contactosExtra: e.target.value }))}
                    placeholder="Nom, email, telèfon…"
                  />
                </label>
                <label className="md:col-span-2">
                  Incidències administratives recurrents
                  <textarea
                    rows={2}
                    value={condG.incidenciasAdmin}
                    onChange={(e) => setCondG((p) => ({ ...p, incidenciasAdmin: e.target.value }))}
                  />
                </label>
                <label className="md:col-span-2">
                  Notes
                  <textarea rows={2} value={condG.notas} onChange={(e) => setCondG((p) => ({ ...p, notas: e.target.value }))} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="xr-btn" disabled={condGuardando} onClick={guardarCondiciones}>
                  {condGuardando ? "Desant…" : "Desar condicions"}
                </button>
                {condMsg && <span className="text-xs text-slate-600">{condMsg}</span>}
              </div>
            </SeccioXR>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="xr-analisi">
      <div className="xr-hero">
        <div>
          <div className="xr-badge">Vista espacial</div>
          <h1 className="flex items-center gap-2">
            <Users size={22} className="text-cyan-800" /> Anàlisi per client
          </h1>
          <p className="xr-sub">Blocs A–D · F · G (E pendent). A/B/D usen el període; C és foto actual.</p>
        </div>
        {Filtros}
      </div>

      <div className="xr-search">
        <Search size={16} />
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Cerca per nom o codi de client…"
        />
      </div>

      {!docsFactura.length ? (
        <div className="xr-note amber">
          Carrega les factures de venda (i abonaments si cal) a «Carregar dades» o prem «Actualitzar».
        </div>
      ) : listado.length === 0 ? (
        <div className="xr-note muted">
          Cap client amb facturació en aquest període{busqueda ? " amb aquest filtre" : ""}.
        </div>
      ) : (
        <div className="xr-list overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Codi</th>
                <th className="text-right">Facturació neta</th>
                <th className="text-right">Factures</th>
                <th className="text-right">Ticket mitjà</th>
                <th className="text-right">Pes</th>
                <th>Primera</th>
                <th>Darrera</th>
              </tr>
            </thead>
            <tbody>
              {listado.map((c) => (
                <tr
                  key={c.clave}
                  onClick={() => {
                    setClienteSel({ clave: c.clave, nombre: c.nombre, codigo: c.codigo });
                    setPestana("a");
                  }}
                >
                  <td className="font-medium">{c.nombre}</td>
                  <td className="text-xs text-slate-500">{c.codigo || "—"}</td>
                  <td className="text-right">{eur2(c.neta)}</td>
                  <td className="text-right">{c.nFacturas}</td>
                  <td className="text-right">{eur2(c.ticket)}</td>
                  <td className="text-right">{pct(c.pes)}</td>
                  <td className="text-xs">{fechaCorta(c.primera)}</td>
                  <td className="text-xs">{fechaCorta(c.ultima)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="xr-list-foot">
            {listado.length} client(s) · total empresa període {eur2(totalEmpresa)}
          </div>
        </div>
      )}
    </div>
  );
}
