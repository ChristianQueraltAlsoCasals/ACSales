/**
 * horasExtra.jsx — Pestañas «Configuración» y «Tarifas y pago» de la
 * pantalla Control de horas (24/09/2026).
 *
 *  · Configuración: festivos por población, población de cada trabajador e
 *    incidencias (días libres, reducción de jornada, descontar/sumar horas,
 *    notas). Se guarda en backend/data/horas_ajustes.json.
 *  · Tarifas y pago: Maria sube su Excel con los trabajadores y los precios
 *    (extras, etc.), se ve y se edita aquí, se relaciona cada código de tipo
 *    de trabajo con su columna de precio y se calcula lo que hay que pagar.
 *    Se guarda en backend/data/horas_tarifas.json.
 */
import React, { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";

const TIPOS_INC = {
  libre: { txt: "Día libre / festivo personal", ayuda: "Esos días no cuentan como laborables (no salen como «sin imputar»)." },
  reduccion: { txt: "Reducción de jornada", ayuda: "Horas por día que le tocan en esas fechas (p. ej. 6)." },
  descontar: { txt: "Descontar horas", ayuda: "Horas que se restan del pago del tipo de trabajo indicado." },
  sumar: { txt: "Sumar horas", ayuda: "Horas que se añaden al pago del tipo de trabajo indicado." },
  nota: { txt: "Otro (solo nota)", ayuda: "Queda apuntado; no cambia los cálculos." },
};
export const TIPOS_INCIDENCIA = TIPOS_INC;
const fmtF = (s) => (s ? s.split("-").reverse().join("/") : "");
const h = (v) => (v ? (Math.round(v * 100) / 100).toLocaleString("es-ES") : "");
const eur = (v) => (v ? v.toLocaleString("es-ES", { style: "currency", currency: "EUR" }) : "");
const input = "border rounded px-2 py-1 text-sm";
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
export const normNum = (s) => String(s ?? "").trim().replace(/^0+/, "").toUpperCase();
export const PRECIO_AMIANTO_DEFECTO = 30;
const PLUS_FESTIVO_EUR = 50;
const esFestivoPlus = (cod) => /^h[_\s.-]*fest(ivo)?[_\s.-]*[12]$/i.test(String(cod || "").trim());
/** Días distintos con H_FESTIVO1 o H_FESTIVO2. El mismo día con los dos códigos cuenta una vez. */
function plusFestivoDe(tr) {
  const fechas = new Set();
  for (const mv of tr?.movs || []) {
    if (!esFestivoPlus(mv.tipoTrabajo) || !(Number(mv.horas) > 0) || !mv.fecha) continue;
    fechas.add(mv.fecha);
  }
  return { dias: fechas.size, importe: fechas.size * PLUS_FESTIVO_EUR };
}
/** Clave de precio editable por trabajador+día (plus amianto). */
export const claveAmianto = (recurso, fecha) => `${normNum(recurso)}|${fecha}`;
/**
 * Agrupa partes esAmiant=1: 1 día = 1 fila (aunque haya varios partes ese día).
 * Devuelve Map normNum(codi) → { nombre, dias: [fecha…], porDia: { fecha: { ots, partes, nombre } } }.
 */
export function agruparAmiantoPorDia(partes) {
  const out = new Map();
  for (const p of partes || []) {
    const rec = normNum(p.codiTreballador);
    if (!rec || !p.fecha) continue;
    let g = out.get(rec);
    if (!g) { g = { nombre: p.treballador || "", dias: [], porDia: {} }; out.set(rec, g); }
    if (!g.porDia[p.fecha]) {
      g.porDia[p.fecha] = { ots: [], partes: [], nombre: p.treballador || g.nombre };
      g.dias.push(p.fecha);
    }
    const d = g.porDia[p.fecha];
    if (p.idOT && !d.ots.includes(p.idOT)) d.ots.push(p.idOT);
    if (p.codigoParte && !d.partes.includes(p.codigoParte)) d.partes.push(p.codigoParte);
    if (p.treballador) d.nombre = p.treballador;
  }
  for (const g of out.values()) g.dias.sort();
  return out;
}
export function precio(v) {
  if (typeof v === "number") return v;
  let t = String(v ?? "").replace(/[€\s]/g, "");
  if (/,\d{1,4}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}

// =================== CONFIGURACIÓN ===================
export function ConfiguracionHoras({ ajustes, guardarAjustes, trabajadores, codigos }) {
  const pobl = ajustes.poblaciones || [];
  const asig = ajustes.asignacion || {};
  const inc = ajustes.incidencias || [];
  const [nueva, setNueva] = useState({ recurso: "", tipo: "descontar", desde: "", hasta: "", horas: "", codigo: "", motivo: "" });
  const [nombrePobl, setNombrePobl] = useState("");
  const nombreDe = (rec) => trabajadores.find((t) => t.recurso === rec)?.nombre || rec;

  const addPobl = () => {
    const n = nombrePobl.trim();
    if (!n || pobl.some((p) => p.nombre.toLowerCase() === n.toLowerCase())) return;
    guardarAjustes({ ...ajustes, poblaciones: [...pobl, { nombre: n, festivos: [] }] });
    setNombrePobl("");
  };
  const addInc = () => {
    if (!nueva.recurso || !nueva.tipo) return;
    if (["libre", "reduccion"].includes(nueva.tipo) && !nueva.desde) return alert("Indica la fecha desde.");
    if (["reduccion", "descontar", "sumar"].includes(nueva.tipo) && !(Number(String(nueva.horas).replace(",", ".")) > 0)) return alert("Indica las horas.");
    const i = { ...nueva, id: `${Date.now()}`, horas: Number(String(nueva.horas).replace(",", ".")) || 0, hasta: nueva.hasta || nueva.desde };
    guardarAjustes({ ...ajustes, incidencias: [...inc, i] });
    setNueva({ ...nueva, horas: "", motivo: "" });
  };

  return (
    <div className="grid gap-5 mt-3">
      <div className="grid lg:grid-cols-2 gap-5">
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm">
          <div className="font-semibold text-slate-800">Festivos por población</div>
          <p className="text-xs text-slate-400 mb-2">Festivos locales de cada población (una fecha por línea, AAAA-MM-DD). A cada trabajador se le aplican los de su población, además de los festivos generales.</p>
          {pobl.map((p, k) => (
            <div key={p.nombre} className="border rounded-lg p-2 mb-2">
              <div className="flex items-center justify-between">
                <b>{p.nombre}</b>
                <button onClick={() => window.confirm(`¿Quitar la población ${p.nombre}?`) && guardarAjustes({ ...ajustes, poblaciones: pobl.filter((_, j) => j !== k) })} className="text-xs text-red-600 underline">Quitar</button>
              </div>
              <textarea key={p.festivos.join()} rows={3} defaultValue={p.festivos.join("\n")} className={`${input} w-full font-mono mt-1`}
                onBlur={(e) => guardarAjustes({ ...ajustes, poblaciones: pobl.map((x, j) => (j === k ? { ...x, festivos: e.target.value.split(/[\s,;]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } : x)) })} />
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <input value={nombrePobl} onChange={(e) => setNombrePobl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPobl()} placeholder="Nueva población (p. ej. Tortosa)" className={`${input} flex-1`} />
            <button onClick={addPobl} className="px-3 py-1 rounded bg-blue-700 text-white">Añadir</button>
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm">
          <div className="font-semibold text-slate-800">Población de cada trabajador</div>
          <p className="text-xs text-slate-400 mb-2">{pobl.length ? "Elige la población para aplicarle sus festivos locales." : "Añade primero una población a la izquierda."}</p>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full">
              <tbody>
                {trabajadores.map((t) => (
                  <tr key={t.recurso} className="border-t border-slate-100">
                    <td className="py-1 pr-2">{t.nombre} <span className="text-[10px] text-slate-400">{t.recurso}</span></td>
                    <td className="py-1 text-right">
                      <select value={asig[t.recurso] || ""} onChange={(e) => guardarAjustes({ ...ajustes, asignacion: { ...asig, [t.recurso]: e.target.value } })} className="border rounded px-1 py-0.5 text-sm" disabled={!pobl.length}>
                        <option value="">—</option>
                        {pobl.map((p) => <option key={p.nombre} value={p.nombre}>{p.nombre}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm">
        <div className="font-semibold text-slate-800">Incidencias de trabajadores</div>
        <p className="text-xs text-slate-400 mb-2">Todo lo que no es normal: días libres, reducciones de jornada, horas a descontar o sumar, o una simple nota.</p>
        <div className="flex flex-wrap items-end gap-2 bg-slate-50 rounded-lg p-2">
          <label className="grid text-xs text-slate-500">Trabajador
            <select value={nueva.recurso} onChange={(e) => setNueva({ ...nueva, recurso: e.target.value })} className={input}>
              <option value="">— elige —</option>
              {trabajadores.map((t) => <option key={t.recurso} value={t.recurso}>{t.nombre}</option>)}
            </select>
          </label>
          <label className="grid text-xs text-slate-500">Tipo
            <select value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })} className={input}>
              {Object.entries(TIPOS_INC).map(([k, v]) => <option key={k} value={k}>{v.txt}</option>)}
            </select>
          </label>
          <label className="grid text-xs text-slate-500">Desde<input type="date" value={nueva.desde} onChange={(e) => setNueva({ ...nueva, desde: e.target.value })} className={input} /></label>
          <label className="grid text-xs text-slate-500">Hasta<input type="date" value={nueva.hasta} onChange={(e) => setNueva({ ...nueva, hasta: e.target.value })} className={input} /></label>
          {nueva.tipo !== "libre" && nueva.tipo !== "nota" && (
            <label className="grid text-xs text-slate-500">{nueva.tipo === "reduccion" ? "Horas/día" : "Horas"}<input value={nueva.horas} onChange={(e) => setNueva({ ...nueva, horas: e.target.value })} className={`${input} w-20`} inputMode="decimal" /></label>
          )}
          {(nueva.tipo === "descontar" || nueva.tipo === "sumar") && (
            <label className="grid text-xs text-slate-500">Tipo de trabajo
              <select value={nueva.codigo} onChange={(e) => setNueva({ ...nueva, codigo: e.target.value })} className={input}>
                <option value="">— todas / sin tipo —</option>
                {codigos.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label className="grid text-xs text-slate-500 flex-1 min-w-[180px]">Motivo<input value={nueva.motivo} onChange={(e) => setNueva({ ...nueva, motivo: e.target.value })} className={input} /></label>
          <button onClick={addInc} className="px-3 py-1.5 rounded bg-blue-700 text-white">Añadir</button>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">{TIPOS_INC[nueva.tipo]?.ayuda}</p>
        <table className="w-full mt-2">
          <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Trabajador</th><th>Tipo</th><th>Fechas</th><th className="text-right">Horas</th><th>Tipo trabajo</th><th>Motivo</th><th /></tr></thead>
          <tbody>
            {inc.length === 0 && <tr><td colSpan={7} className="py-2 text-slate-400">Sin incidencias.</td></tr>}
            {[...inc].sort((a, b) => (a.desde < b.desde ? 1 : -1)).map((i) => (
              <tr key={i.id} className="border-t border-slate-100">
                <td className="py-1">{nombreDe(i.recurso)}</td>
                <td>{TIPOS_INC[i.tipo]?.txt || i.tipo}</td>
                <td className="whitespace-nowrap">{i.desde ? `${fmtF(i.desde)}${i.hasta && i.hasta !== i.desde ? ` – ${fmtF(i.hasta)}` : ""}` : "—"}</td>
                <td className="text-right">{h(i.horas)}</td>
                <td>{i.codigo}</td>
                <td className="text-slate-500">{i.motivo}</td>
                <td className="text-right"><button onClick={() => guardarAjustes({ ...ajustes, incidencias: inc.filter((x) => x.id !== i.id) })} className="text-xs text-red-600 underline">Quitar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// =================== TARIFAS Y PAGO ===================
async function leerFichero(file) {
  const nombre = file.name;
  if (/\.csv$/i.test(nombre)) {
    const texto = await file.text();
    const r = Papa.parse(texto, { skipEmptyLines: true });
    return { hoja: "", matriz: r.data };
  }
  // Excel: SheetJS (se carga solo cuando hace falta)
  const XLSX = await import(/* @vite-ignore */ "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const hoja = wb.SheetNames[0];
  const matriz = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: "", raw: false });
  return { hoja, matriz, hojas: wb.SheetNames, wb, XLSX };
}
function matrizATabla(matriz) {
  const iCab = matriz.findIndex((f) => f.filter((c) => String(c).trim() !== "").length >= 2);
  if (iCab < 0) return { columnas: [], filas: [] };
  const vistos = {};
  const columnas = matriz[iCab].map((c, k) => {
    let n = String(c).trim() || `Columna ${k + 1}`;
    if (vistos[n]) n = `${n} (${++vistos[n]})`; else vistos[n] = 1;
    return n;
  });
  const filas = matriz.slice(iCab + 1).filter((f) => f.some((c) => String(c).trim() !== "")).map((f) => Object.fromEntries(columnas.map((c, k) => [c, f[k] ?? ""])));
  return { columnas, filas };
}

// Mapeo automático Excel «Precio por mano de obra» ↔ códigos BC (Also Casals).
// Solo columnas de precio (h_…); se ignoran h_guar sin número, PLUS FEST/NOCT y los 50/20/25.
const MAPEO_PRECIOS_BC = [
  { cod: "H_EXTRA", re: /^h[_\s.-]*extra$/i },
  { cod: "H_FESTIVO1", re: /^h[_\s.-]*fest(ivo)?[_\s.-]*1$/i },
  { cod: "H_FESTIVO2", re: /^h[_\s.-]*fest(ivo)?[_\s.-]*2$/i },
  { cod: "H_GUARDIA1", re: /^h[_\s.-]*guar(dia)?[_\s.-]*1$/i },
  { cod: "H_GUARDIA2", re: /^h[_\s.-]*guar(dia)?[_\s.-]*2$/i },
];
function sugerirPreciosExcel(columnas) {
  const out = {};
  for (const { cod, re } of MAPEO_PRECIOS_BC) {
    const col = columnas.find((c) => re.test(String(c).trim()));
    if (col) out[cod] = col;
  }
  return out;
}

export function TarifasHoras({ trabajadores, codigos, ajustes, desde, hasta, amianto }) {
  const [t, setT] = useState(null); // {archivo, hoja, subido, columnas, filas, mapeo}
  const [cambios, setCambios] = useState(false);
  const [msg, setMsg] = useState("");
  const [vista, setVista] = useState("pago");
  const [popupAmianto, setPopupAmianto] = useState(null); // { recurso, nombre, filasLocales: [{fecha, ots, partes, precio}] }
  const [precioDefAmianto, setPrecioDefAmianto] = useState(PRECIO_AMIANTO_DEFECTO);

  useEffect(() => { fetch("/api/horas/tarifas").then((r) => r.json()).then((j) => {
    setT(j.tarifas || null);
    const def = Number(j.tarifas?.mapeo?.amiantoPrecioDefecto);
    if (def > 0) setPrecioDefAmianto(def);
  }).catch(() => {}); }, []);

  const amiantoMap = useMemo(() => agruparAmiantoPorDia(amianto?.partes), [amianto]);
  const precioDiaAmianto = (recurso, fecha) => {
    const overrides = t?.mapeo?.amiantoPrecios || {};
    const k = claveAmianto(recurso, fecha);
    const o = overrides[k];
    if (o != null && o !== "" && isFinite(Number(o))) return Number(o);
    return Number(t?.mapeo?.amiantoPrecioDefecto) > 0 ? Number(t.mapeo.amiantoPrecioDefecto) : precioDefAmianto;
  };
  const plusAmiantoDe = (recurso) => {
    const g = amiantoMap.get(normNum(recurso));
    if (!g?.dias?.length) return { dias: 0, importe: 0, detalle: [] };
    const detalle = g.dias.map((fecha) => {
      const d = g.porDia[fecha];
      const p = precioDiaAmianto(recurso, fecha);
      return { fecha, ots: d.ots, partes: d.partes, nombre: d.nombre || g.nombre, precio: p, total: p };
    });
    return { dias: detalle.length, importe: detalle.reduce((s, x) => s + x.total, 0), detalle };
  };

  async function guardar(nuevo) {
    setT(nuevo);
    try {
      const r = await fetch("/api/horas/tarifas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nuevo) });
      if (!r.ok) throw new Error();
      setCambios(false); setMsg("Guardado ✓"); setTimeout(() => setMsg(""), 1500);
    } catch { setMsg("No se pudo guardar"); }
  }
  async function subir(file) {
    if (!file) return;
    setMsg("Leyendo…");
    try {
      const { hoja, matriz } = await leerFichero(file);
      const { columnas, filas } = matrizATabla(matriz);
      if (!columnas.length) throw new Error("No se ha encontrado una fila de títulos en la primera hoja.");
      // Se conserva la relación de columnas si siguen existiendo; si falta, se sugiere el mapeo BC ↔ Excel
      const m = t?.mapeo || {};
      const preciosPrevios = Object.fromEntries(Object.entries(m.precios || {}).filter(([, c]) => columnas.includes(c)));
      const mapeo = {
        colRecurso: columnas.includes(m.colRecurso) ? m.colRecurso : columnas.find((c) => /^(n[ºo°.]?\s*)?(recurso|c[oó]d|codigo|codi|n[ºo°]|num)/i.test(c)) || "",
        colNombre: columnas.includes(m.colNombre) ? m.colNombre : columnas.find((c) => /nombre|trabajador|treballador|empleado/i.test(c)) || "",
        precios: { ...sugerirPreciosExcel(columnas), ...preciosPrevios },
      };
      await guardar({ archivo: file.name, hoja, subido: new Date().toISOString(), columnas, filas, mapeo });
      const nSug = Object.keys(mapeo.precios).length;
      setMsg(`Cargado: ${filas.length} filas${nSug ? ` · ${nSug} precios relacionados con BC` : ""}`);
    } catch (e) {
      setMsg(`✗ ${String(e.message || e).includes("fetch") || String(e.message || e).includes("import") ? "No se pudo leer el Excel (hace falta internet para abrir .xlsx). Guárdalo como CSV y súbelo." : e.message || e}`);
    }
  }
  function descargarCSV(nombre, columnas, filas) {
    const csv = Papa.unparse({ fields: columnas, data: filas.map((f) => columnas.map((c) => f[c])) }, { delimiter: ";" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = nombre;
    a.click();
  }
  // ----- Cálculo del pago -----
  const pago = useMemo(() => {
    if (!t?.columnas?.length) return null;
    const m = t.mapeo || {};
    const precios = m.precios || {};
    const cods = Object.keys(precios).filter((c) => precios[c]);
    const filaDe = (tr) => t.filas.find((f) => (m.colRecurso && normNum(f[m.colRecurso]) && normNum(f[m.colRecurso]) === normNum(tr.recurso)))
      || t.filas.find((f) => m.colNombre && norm(f[m.colNombre]) && norm(f[m.colNombre]) === norm(tr.nombre));
    const inc = ajustes.incidencias || [];
    const enPeriodo = (i) => !i.desde || ((i.hasta || i.desde) >= desde && i.desde <= hasta);
    const filas = trabajadores.map((tr) => {
      const horas = {};
      for (const mv of tr.movs) {
        const k = mv.tipoTrabajo || "(sin tipo)";
        horas[k] = (horas[k] || 0) + mv.horas;
      }
      horas["__exceso"] = tr.t.exceso;
      const ajustesH = {};
      for (const i of inc) {
        if (i.recurso !== tr.recurso || !enPeriodo(i) || !["descontar", "sumar"].includes(i.tipo)) continue;
        const k = i.codigo || "(sin tipo)";
        ajustesH[k] = (ajustesH[k] || 0) + (i.tipo === "descontar" ? -i.horas : i.horas);
      }
      const fila = filaDe(tr);
      const lineas = cods.map((c) => {
        const hh = Math.max(0, (horas[c] || 0) + (ajustesH[c] || 0));
        const p = fila ? precio(fila[precios[c]]) : 0;
        return { c, horas: hh, ajuste: ajustesH[c] || 0, precio: p, importe: hh * p };
      });
      const ami = plusAmiantoDe(tr.recurso);
      const festivo = plusFestivoDe(tr);
      const totalHoras = lineas.reduce((s, l) => s + l.importe, 0);
      return { tr, fila, lineas, amianto: ami, festivo, total: totalHoras + ami.importe + festivo.importe };
    });
    const i2 = cods.findIndex((c) => /^h[_\s.-]*fest(ivo)?[_\s.-]*2$/i.test(String(c).trim()));
    const i1 = cods.findIndex((c) => /^h[_\s.-]*fest(ivo)?[_\s.-]*1$/i.test(String(c).trim()));
    const corte = i2 >= 0 ? i2 + 1 : (i1 >= 0 ? i1 + 1 : cods.length);
    return { cods, filas, corte };
  }, [t, trabajadores, ajustes, desde, hasta, amiantoMap, precioDefAmianto]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMapeo = (m) => guardar({ ...t, mapeo: { ...(t.mapeo || {}), ...m } });
  const nombreCod = (c) => (c === "__exceso" ? "Exceso sobre jornada (no declarado)" : c);
  const tieneImporte = (p) => p.lineas.some((l) => l.horas) || p.amianto?.dias || p.festivo?.dias;

  function abrirPopupAmianto(p) {
    const ami = p.amianto || plusAmiantoDe(p.tr.recurso);
    if (!ami.dias) return;
    setPopupAmianto({
      recurso: p.tr.recurso,
      nombre: p.tr.nombre,
      filasLocales: ami.detalle.map((d) => ({ ...d, precio: String(d.precio) })),
    });
  }
  async function guardarPopupAmianto() {
    if (!popupAmianto || !t) return;
    const precios = { ...(t.mapeo?.amiantoPrecios || {}) };
    for (const f of popupAmianto.filasLocales) {
      const n = Number(String(f.precio).replace(",", "."));
      precios[claveAmianto(popupAmianto.recurso, f.fecha)] = isFinite(n) && n >= 0 ? n : precioDefAmianto;
    }
    await guardar({ ...t, mapeo: { ...(t.mapeo || {}), amiantoPrecios: precios, amiantoPrecioDefecto: precioDefAmianto } });
    setPopupAmianto(null);
  }

  /** Excel .xlsx de la tabla «A pagar» (misma info que en pantalla). */
  async function descargarExcelPago() {
    if (!pago) return;
    setMsg("Preparando Excel…");
    try {
      const XLSX = await import(/* @vite-ignore */ "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
      const visibles = pago.filas.filter(tieneImporte);
      const antes = pago.cods.slice(0, pago.corte);
      const despues = pago.cods.slice(pago.corte);
      const colsTipo = (codigos) => codigos.flatMap((c) => [`${nombreCod(c)} horas`, `${nombreCod(c)} precio €`, `${nombreCod(c)} importe €`]);
      const valsTipo = (lineas) => lineas.flatMap((l) => [l.horas || "", l.horas ? l.precio : "", l.horas ? Math.round(l.importe * 100) / 100 : ""]);
      const totTipo = (codigos) => codigos.flatMap((c) => {
        const imp = Math.round(pago.filas.reduce((s, p) => s + (p.lineas.find((l) => l.c === c)?.importe || 0), 0) * 100) / 100;
        const hh = Math.round(pago.filas.reduce((s, p) => s + (p.lineas.find((l) => l.c === c)?.horas || 0), 0) * 100) / 100;
        return [hh || "", "", imp || ""];
      });
      const diasFest = pago.filas.reduce((s, p) => s + (p.festivo?.dias || 0), 0);
      const impFest = Math.round(pago.filas.reduce((s, p) => s + (p.festivo?.importe || 0), 0) * 100) / 100;
      const cab = ["Trabajador", "Nº recurso", ...colsTipo(antes), "Días plus festivo", "Plus festivo €", ...colsTipo(despues), "Días amianto", "Plus amianto €", "Total a pagar €"];
      const filasX = visibles.map((p) => [
        p.tr.nombre,
        p.tr.recurso,
        ...valsTipo(p.lineas.slice(0, pago.corte)),
        p.festivo?.dias || "",
        p.festivo?.importe ? Math.round(p.festivo.importe * 100) / 100 : "",
        ...valsTipo(p.lineas.slice(pago.corte)),
        p.amianto?.dias || "",
        p.amianto?.importe ? Math.round(p.amianto.importe * 100) / 100 : "",
        Math.round(p.total * 100) / 100,
      ]);
      const totales = [
        "Total",
        "",
        ...totTipo(antes),
        diasFest || "",
        impFest || "",
        ...totTipo(despues),
        pago.filas.reduce((s, p) => s + (p.amianto?.dias || 0), 0) || "",
        Math.round(pago.filas.reduce((s, p) => s + (p.amianto?.importe || 0), 0) * 100) / 100 || "",
        Math.round(pago.filas.reduce((s, p) => s + p.total, 0) * 100) / 100,
      ];
      const ws = XLSX.utils.aoa_to_sheet([
        [`A pagar · Periodo ${fmtF(desde)} – ${fmtF(hasta)} · horas BC ± incidencias · plus festivo · plus amianto`],
        cab,
        ...filasX,
        totales,
      ]);
      ws["!cols"] = cab.map((_, i) => ({ wch: i === 0 ? 32 : i === 1 ? 12 : 14 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "A pagar");
      XLSX.writeFile(wb, `pago_horas_${desde}_${hasta}.xlsx`);
      setMsg("Excel descargado ✓");
      setTimeout(() => setMsg(""), 1500);
    } catch (e) {
      setMsg(`✗ No se pudo crear el Excel${String(e.message || e).includes("import") || String(e.message || e).includes("fetch") ? " (hace falta internet). Usa «Descargar CSV»." : `: ${e.message || e}`}`);
    }
  }

  return (
    <div className="grid gap-4 mt-3 text-sm">
      <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="px-3 py-1.5 rounded bg-blue-700 text-white cursor-pointer">
            📤 {t ? "Sustituir tabla (Excel o CSV)" : "Subir tabla de tarifas (Excel o CSV)"}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { subir(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {t && <span className="text-xs text-slate-500">{t.archivo}{t.hoja ? ` · hoja «${t.hoja}»` : ""} · {t.filas.length} filas · subido {new Date(t.subido).toLocaleString("es-ES")}</span>}
          {msg && <span className="text-xs text-green-700">{msg}</span>}
        </div>
        {!t && <p className="text-xs text-slate-400 mt-2">Sube el Excel con los trabajadores y sus precios (hora extra, festiva, etc.). La primera fila con títulos se usa como cabecera. Después podrás añadir trabajadores nuevos aquí mismo o volver a subir el Excel.</p>}
      </section>

      {t && (
        <>
          <div className="flex gap-1 border-b">
            {[["pago", "💶 A pagar"], ["tabla", "📋 Tabla de tarifas"], ["relacion", "🔗 Relacionar columnas"]].map(([k, txt]) => (
              <button key={k} onClick={() => setVista(k)} className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${vista === k ? "border-blue-700 text-blue-800 font-medium" : "border-transparent text-slate-500"}`}>{txt}</button>
            ))}
          </div>

          {vista === "relacion" && (
            <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 grid gap-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="grid gap-1">Columna con el Nº de recurso (código BC)
                  <select value={t.mapeo?.colRecurso || ""} onChange={(e) => setMapeo({ colRecurso: e.target.value })} className={input}>
                    <option value="">—</option>{t.columnas.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <label className="grid gap-1">Columna con el nombre (si no hay código)
                  <select value={t.mapeo?.colNombre || ""} onChange={(e) => setMapeo({ colNombre: e.target.value })} className={input}>
                    <option value="">—</option>{t.columnas.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              <div>
                <div className="font-medium text-slate-700">Precio de cada tipo de trabajo</div>
                <p className="text-xs text-slate-400">Para cada código de tipo de trabajo de BC, elige la columna del Excel con su precio por hora. Deja «no se paga» los que van en el sueldo (p. ej. H_NORMAL).</p>
                <table className="mt-2">
                  <tbody>
                    {[...codigos, "__exceso"].map((c) => (
                      <tr key={c}>
                        <td className="pr-3 py-1 font-mono text-xs">{nombreCod(c)}</td>
                        <td>
                          <select value={t.mapeo?.precios?.[c] || ""} onChange={(e) => setMapeo({ precios: { ...(t.mapeo?.precios || {}), [c]: e.target.value } })} className="border rounded px-1 py-0.5 text-sm">
                            <option value="">— no se paga —</option>{t.columnas.map((col) => <option key={col}>{col}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {vista === "tabla" && (
            <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
              <div className="flex items-center gap-2 p-2 border-b bg-slate-50">
                <button onClick={() => { setT({ ...t, filas: [...t.filas, Object.fromEntries(t.columnas.map((c) => [c, ""]))] }); setCambios(true); }} className="px-2 py-1 rounded border text-xs">＋ Añadir trabajador</button>
                <button onClick={() => guardar(t)} disabled={!cambios} className="px-2 py-1 rounded bg-blue-700 text-white text-xs disabled:opacity-40">Guardar cambios</button>
                <button onClick={() => descargarCSV(`tarifas_${new Date().toISOString().slice(0, 10)}.csv`, t.columnas, t.filas)} className="px-2 py-1 rounded border text-xs">⬇ Descargar (CSV para Excel)</button>
                {cambios && <span className="text-xs text-amber-700">Hay cambios sin guardar</span>}
              </div>
              <table className="text-xs">
                <thead><tr className="bg-slate-50">{t.columnas.map((c) => <th key={c} className="px-2 py-1 text-left font-medium text-slate-600 whitespace-nowrap">{c}</th>)}<th /></tr></thead>
                <tbody>
                  {t.filas.map((f, k) => (
                    <tr key={k} className="border-t border-slate-100">
                      {t.columnas.map((c) => (
                        <td key={c} className="px-1 py-0.5">
                          <input value={f[c] ?? ""} onChange={(e) => { const filas = t.filas.map((x, j) => (j === k ? { ...x, [c]: e.target.value } : x)); setT({ ...t, filas }); setCambios(true); }} className="w-full min-w-[80px] border border-transparent hover:border-slate-200 focus:border-blue-300 rounded px-1 py-0.5" />
                        </td>
                      ))}
                      <td><button onClick={() => { if (window.confirm("¿Quitar esta fila?")) { setT({ ...t, filas: t.filas.filter((_, j) => j !== k) }); setCambios(true); } }} className="text-red-500 px-1">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {vista === "pago" && pago && (
            <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
              {!pago.cods.length ? (
                <p className="p-4 text-slate-500">Primero, en «🔗 Relacionar columnas», indica qué columna del Excel es el precio de cada tipo de trabajo.</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 p-2 border-b bg-slate-50 text-xs text-slate-600">
                    Periodo {fmtF(desde)} – {fmtF(hasta)} · horas BC ± incidencias · plus festivo (días × 50 €) · plus amianto (días × €)
                    <label className="flex items-center gap-1 ml-2">
                      Precio amianto por defecto
                      <input type="number" min={0} step={1} value={precioDefAmianto}
                        onChange={(e) => setPrecioDefAmianto(Number(e.target.value) || 0)}
                        onBlur={() => t && guardar({ ...t, mapeo: { ...(t.mapeo || {}), amiantoPrecioDefecto: precioDefAmianto } })}
                        className="border rounded px-1 py-0.5 w-16 text-right" />
                      €/día
                    </label>
                    {amianto?.error && <span className="text-amber-700">{amianto.error}</span>}
                    <div className="ml-auto flex gap-1">
                      <button onClick={descargarExcelPago} className="px-2 py-1 rounded border bg-white hover:bg-slate-50">⬇ Descargar Excel</button>
                      <button onClick={() => {
                        const antes = pago.cods.slice(0, pago.corte);
                        const despues = pago.cods.slice(pago.corte);
                        const colsTipo = (codigos) => codigos.flatMap((c) => [`${nombreCod(c)} horas`, `${nombreCod(c)} precio`, `${nombreCod(c)} importe`]);
                        const valsTipo = (lineas) => Object.fromEntries(lineas.flatMap((l) => [[`${nombreCod(l.c)} horas`, h(l.horas)], [`${nombreCod(l.c)} precio`, h(l.precio)], [`${nombreCod(l.c)} importe`, h(l.importe)]]));
                        descargarCSV(`pago_horas_${desde}_${hasta}.csv`, ["Nº recurso", "Trabajador", ...colsTipo(antes), "Días plus festivo", "Plus festivo", ...colsTipo(despues), "Días amianto", "Plus amianto", "Total"],
                          pago.filas.filter(tieneImporte).map((p) => ({ "Nº recurso": p.tr.recurso, Trabajador: p.tr.nombre, ...valsTipo(p.lineas.slice(0, pago.corte)), "Días plus festivo": p.festivo?.dias || "", "Plus festivo": h(p.festivo?.importe), ...valsTipo(p.lineas.slice(pago.corte)), "Días amianto": p.amianto?.dias || "", "Plus amianto": h(p.amianto?.importe), Total: h(p.total) })));
                      }}
                        className="px-2 py-1 rounded border bg-white hover:bg-slate-50">⬇ CSV</button>
                    </div>
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-xs text-slate-500">
                        <th className="px-3 py-1.5 text-left">Trabajador</th>
                        {pago.cods.slice(0, pago.corte).map((c) => <th key={c} className="px-3 text-right">{nombreCod(c)}<div className="font-normal text-[10px]">horas × precio</div></th>)}
                        <th className="px-3 text-right">Plus festivo<div className="font-normal text-[10px]">días × 50 €</div></th>
                        {pago.cods.slice(pago.corte).map((c) => <th key={c} className="px-3 text-right">{nombreCod(c)}<div className="font-normal text-[10px]">horas × precio</div></th>)}
                        <th className="px-3 text-right">Plus amianto<div className="font-normal text-[10px]">días × €/día · clic para detalle</div></th>
                        <th className="px-3 text-right">Total a pagar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pago.filas.filter(tieneImporte).map((p) => (
                        <tr key={p.tr.recurso} className="border-t border-slate-100">
                          <td className="px-3 py-1">
                            {p.tr.nombre} <span className="text-[10px] text-slate-400">{p.tr.recurso}</span>
                            {!p.fila && <div className="text-[10px] text-red-600">No está en la tabla de tarifas</div>}
                          </td>
                          {p.lineas.slice(0, pago.corte).map((l) => (
                            <td key={l.c} className="px-3 text-right whitespace-nowrap">
                              {l.horas ? <>{h(l.horas)} h × {h(l.precio) || 0} € <div className="font-medium">{eur(l.importe)}</div></> : ""}
                              {l.ajuste ? <div className="text-[10px] text-amber-700">{l.ajuste > 0 ? "+" : ""}{h(l.ajuste)} h por incidencia</div> : null}
                            </td>
                          ))}
                          <td className="px-3 text-right whitespace-nowrap">
                            {p.festivo?.dias ? <>{p.festivo.dias} {p.festivo.dias === 1 ? "día" : "días"}<div className="font-medium">{eur(p.festivo.importe)}</div></> : ""}
                          </td>
                          {p.lineas.slice(pago.corte).map((l) => (
                            <td key={l.c} className="px-3 text-right whitespace-nowrap">
                              {l.horas ? <>{h(l.horas)} h × {h(l.precio) || 0} € <div className="font-medium">{eur(l.importe)}</div></> : ""}
                              {l.ajuste ? <div className="text-[10px] text-amber-700">{l.ajuste > 0 ? "+" : ""}{h(l.ajuste)} h por incidencia</div> : null}
                            </td>
                          ))}
                          <td className="px-3 text-right whitespace-nowrap">
                            {p.amianto?.dias ? (
                              <button type="button" onClick={() => abrirPopupAmianto(p)} className="hover:bg-amber-50 rounded px-1 -mx-1 text-right w-full" title="Clic para ver OT / partes y cambiar precio">
                                {p.amianto.dias} {p.amianto.dias === 1 ? "día" : "días"}
                                <div className="font-medium text-amber-800">{eur(p.amianto.importe)}</div>
                              </button>
                            ) : ""}
                          </td>
                          <td className="px-3 text-right font-bold">{eur(p.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="px-3 py-2">Total</td>
                        {pago.cods.slice(0, pago.corte).map((c) => <td key={c} className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + (p.lineas.find((l) => l.c === c)?.importe || 0), 0))}</td>)}
                        <td className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + (p.festivo?.importe || 0), 0))}</td>
                        {pago.cods.slice(pago.corte).map((c) => <td key={c} className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + (p.lineas.find((l) => l.c === c)?.importe || 0), 0))}</td>)}
                        <td className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + (p.amianto?.importe || 0), 0))}</td>
                        <td className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + p.total, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </section>
          )}

          {popupAmianto && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPopupAmianto(null)}>
              <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
                <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white">
                  <div>
                    <div className="font-semibold text-slate-800">Plus amianto · {popupAmianto.nombre}</div>
                    <div className="text-xs text-slate-500">Una fila por día (fecha de creación del parte). Precio por defecto {precioDefAmianto} €/día; cámbialo si esa OT son 50 €.</div>
                  </div>
                  <button type="button" onClick={() => setPopupAmianto(null)} className="text-slate-400 hover:text-slate-700 text-lg px-2">✕</button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 bg-slate-50">
                      <th className="px-3 py-2">Fecha</th>
                      <th className="px-3 py-2">OT</th>
                      <th className="px-3 py-2">Nº parte</th>
                      <th className="px-3 py-2">Trabajador</th>
                      <th className="px-3 py-2 text-right">Precio €/día</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {popupAmianto.filasLocales.map((f, i) => {
                      const pNum = Number(String(f.precio).replace(",", ".")) || 0;
                      return (
                        <tr key={f.fecha} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 whitespace-nowrap">{fmtF(f.fecha)}</td>
                          <td className="px-3 py-1.5">{(f.ots || []).join(", ") || "—"}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{(f.partes || []).join(", ") || "—"}</td>
                          <td className="px-3 py-1.5">{f.nombre || popupAmianto.nombre}</td>
                          <td className="px-3 py-1.5 text-right">
                            <input value={f.precio} inputMode="decimal"
                              onChange={(e) => setPopupAmianto({
                                ...popupAmianto,
                                filasLocales: popupAmianto.filasLocales.map((x, j) => (j === i ? { ...x, precio: e.target.value } : x)),
                              })}
                              className="border rounded px-2 py-1 w-20 text-right text-sm" />
                          </td>
                          <td className="px-3 py-1.5 text-right font-medium">{eur(pNum)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="px-3 py-2" colSpan={5}>Total plus amianto</td>
                      <td className="px-3 py-2 text-right">{eur(popupAmianto.filasLocales.reduce((s, f) => s + (Number(String(f.precio).replace(",", ".")) || 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
                <div className="px-4 py-3 border-t flex justify-end gap-2 sticky bottom-0 bg-white">
                  <button type="button" onClick={() => setPopupAmianto(null)} className="px-3 py-1.5 rounded border text-sm">Cancelar</button>
                  <button type="button" onClick={guardarPopupAmianto} className="px-3 py-1.5 rounded bg-blue-700 text-white text-sm">Guardar precios</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =================== FESTIVOS LÍNEA A LÍNEA ===================
// Cada línea: trabajador («Todos» o uno concreto) · tipo de festivo · fecha · descripción.
// Se editan en pantalla y se guardan con el botón «Guardar»; también se pueden
// cargar desde un Excel/CSV con columnas Trabajador · Tipo · Fecha (· Descripción).
export const TIPOS_FESTIVO = ["Festivo nacional", "Festivo autonómico", "Festivo local", "Festivo específico"];

function fechaISO(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v > 20000 && v < 80000) { // número de serie de Excel
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // dd/mm/aaaa
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}
export function listaFestivos(ajustes) {
  // Compatibilidad: los festivos antiguos (solo fechas) pasan a «Todos · Festivo»
  if (Array.isArray(ajustes.festivosLista)) return ajustes.festivosLista;
  return (ajustes.festivos || []).map((f, k) => ({ id: `old${k}`, recurso: "", tipo: "Festivo local", fecha: f, desc: "" }));
}

export function FestivosLinea({ ajustes, guardarAjustes, trabajadores }) {
  const [lineas, setLineas] = useState(() => listaFestivos(ajustes));
  const [sucio, setSucio] = useState(false);
  const [msg, setMsg] = useState("");
  const [nueva, setNueva] = useState({ recurso: "", tipo: "Festivo local", fecha: "", desc: "" });
  useEffect(() => { if (!sucio) setLineas(listaFestivos(ajustes)); }, [ajustes]); // eslint-disable-line react-hooks/exhaustive-deps
  const nombreDe = (rec) => (rec ? trabajadores.find((t) => t.recurso === rec)?.nombre || rec : "Todos");
  const cambiar = (l) => { setLineas(l); setSucio(true); setMsg(""); };

  const añadir = () => {
    if (!nueva.fecha) return alert("Indica la fecha.");
    cambiar([...lineas, { ...nueva, id: `${Date.now()}` }].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)));
    setNueva({ ...nueva, fecha: "", desc: "" });
  };
  async function guardar() {
    await guardarAjustes({ ...ajustes, festivosLista: lineas, festivos: lineas.filter((l) => !l.recurso).map((l) => l.fecha) });
    setSucio(false); setMsg("Guardado ✓");
  }
  async function cargar(file) {
    if (!file) return;
    try {
      let matriz;
      if (/\.csv$/i.test(file.name)) matriz = Papa.parse(await file.text(), { skipEmptyLines: true }).data;
      else {
        const XLSX = await import(/* @vite-ignore */ "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        matriz = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
      }
      const iCab = matriz.findIndex((f) => f.some((c) => /fecha/i.test(String(c))));
      const cab = iCab >= 0 ? matriz[iCab].map((c) => String(c)) : ["Trabajador", "Tipo", "Fecha", "Descripción"];
      const col = (re, def) => { const i = cab.findIndex((c) => re.test(c)); return i >= 0 ? i : def; };
      const cT = col(/trabaj|emplead|nombre|recurso/i, 0), cTi = col(/tipo/i, 1), cF = col(/fecha/i, 2), cD = col(/desc|motivo|concepto/i, 3);
      const nuevas = [], errores = [];
      for (const f of matriz.slice(iCab + 1)) {
        if (!f.some((c) => String(c).trim())) continue;
        const fecha = fechaISO(f[cF]);
        if (!fecha) { errores.push(`fecha «${f[cF]}»`); continue; }
        const quien = String(f[cT] ?? "").trim();
        let recurso = "";
        if (quien && !/^tod[oa]s?$/i.test(quien)) {
          const t = trabajadores.find((x) => normNum(x.recurso) === normNum(quien) || norm(x.nombre) === norm(quien))
            || trabajadores.find((x) => norm(x.nombre).includes(norm(quien)) || norm(quien).includes(norm(x.nombre)));
          if (!t) { errores.push(`trabajador «${quien}»`); continue; }
          recurso = t.recurso;
        }
        const tipoTxt = String(f[cTi] ?? "").trim();
        const tipo = TIPOS_FESTIVO.find((x) => norm(x).includes(norm(tipoTxt)) || norm(tipoTxt).includes(norm(x).replace("festivo", ""))) || (tipoTxt ? `Festivo ${tipoTxt.replace(/^festivo\s*/i, "").toLowerCase()}` : "Festivo local");
        nuevas.push({ id: `${Date.now()}${nuevas.length}`, recurso, tipo, fecha, desc: String(f[cD] ?? "").trim() });
      }
      // Se añaden a las existentes sin duplicar (mismo trabajador + fecha)
      const clave = (l) => `${l.recurso}|${l.fecha}`;
      const existentes = new Set(lineas.map(clave));
      const añadidas = nuevas.filter((l) => !existentes.has(clave(l)));
      cambiar([...lineas, ...añadidas].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)));
      setMsg(`Cargadas ${añadidas.length} líneas${nuevas.length - añadidas.length ? ` (${nuevas.length - añadidas.length} ya existían)` : ""}${errores.length ? ` · No reconocidas: ${errores.slice(0, 5).join(", ")}${errores.length > 5 ? "…" : ""}` : ""}. Pulsa «Guardar».`);
    } catch (e) {
      setMsg(`✗ No se pudo leer el fichero${String(e.message || e).includes("import") || String(e.message || e).includes("fetch") ? " (para .xlsx hace falta internet; prueba con CSV)" : `: ${e.message || e}`}`);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">Festivos</span>
        <label className="px-2 py-1 rounded border text-xs cursor-pointer hover:bg-slate-50">📥 Cargar (Excel / CSV)
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { cargar(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <button onClick={guardar} disabled={!sucio} className="px-3 py-1 rounded bg-blue-700 text-white text-xs disabled:opacity-40">💾 Guardar</button>
        {sucio && <span className="text-xs text-amber-700">Cambios sin guardar</span>}
        {msg && <span className="text-xs text-green-700">{msg}</span>}
      </div>
      <table className="w-full text-sm border">
        <thead>
          <tr className="bg-slate-50 text-xs text-slate-600 text-left">
            <th className="px-2 py-1 border">Trabajador</th><th className="px-2 py-1 border">Tipo</th><th className="px-2 py-1 border">Fecha</th><th className="px-2 py-1 border">Descripción</th><th className="border w-8" />
          </tr>
        </thead>
        <tbody>
          {lineas.length === 0 && <tr><td colSpan={5} className="px-2 py-2 text-slate-400">Sin festivos. Añade líneas abajo o cárgalas desde un Excel.</td></tr>}
          {lineas.map((l) => (
            <tr key={l.id}>
              <td className="px-2 py-1 border">{nombreDe(l.recurso)}</td>
              <td className="px-2 py-1 border">{l.tipo}</td>
              <td className="px-2 py-1 border whitespace-nowrap">{fmtF(l.fecha)}</td>
              <td className="px-2 py-1 border text-slate-500">{l.desc}</td>
              <td className="border text-center"><button onClick={() => cambiar(lineas.filter((x) => x.id !== l.id))} className="text-red-500" title="Quitar">✕</button></td>
            </tr>
          ))}
          <tr className="bg-blue-50/40">
            <td className="px-1 py-1 border">
              <select value={nueva.recurso} onChange={(e) => setNueva({ ...nueva, recurso: e.target.value })} className="border rounded px-1 py-0.5 text-sm w-full">
                <option value="">Todos</option>
                {trabajadores.map((t) => <option key={t.recurso} value={t.recurso}>{t.nombre}</option>)}
              </select>
            </td>
            <td className="px-1 py-1 border">
              <select value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value })} className="border rounded px-1 py-0.5 text-sm w-full">
                {TIPOS_FESTIVO.map((t) => <option key={t}>{t}</option>)}
              </select>
            </td>
            <td className="px-1 py-1 border"><input type="date" value={nueva.fecha} onChange={(e) => setNueva({ ...nueva, fecha: e.target.value })} className="border rounded px-1 py-0.5 text-sm" /></td>
            <td className="px-1 py-1 border"><input value={nueva.desc} onChange={(e) => setNueva({ ...nueva, desc: e.target.value })} onKeyDown={(e) => e.key === "Enter" && añadir()} placeholder="(opcional)" className="border rounded px-1 py-0.5 text-sm w-full" /></td>
            <td className="border text-center"><button onClick={añadir} className="text-blue-700 font-bold" title="Añadir línea">＋</button></td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-slate-400">«Todos» = festivo para toda la plantilla. Si eliges un trabajador, solo cuenta para él. Para cargar desde Excel: columnas Trabajador (nombre, Nº recurso o «Todos») · Tipo · Fecha · Descripción.</p>
    </div>
  );
}
