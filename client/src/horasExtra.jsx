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
const normNum = (s) => String(s ?? "").trim().replace(/^0+/, "").toUpperCase();
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

export function TarifasHoras({ trabajadores, codigos, ajustes, desde, hasta }) {
  const [t, setT] = useState(null); // {archivo, hoja, subido, columnas, filas, mapeo}
  const [cambios, setCambios] = useState(false);
  const [msg, setMsg] = useState("");
  const [vista, setVista] = useState("pago");

  useEffect(() => { fetch("/api/horas/tarifas").then((r) => r.json()).then((j) => setT(j.tarifas || null)).catch(() => {}); }, []);

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
      // Se conserva la relación de columnas si siguen existiendo
      const m = t?.mapeo || {};
      const mapeo = {
        colRecurso: columnas.includes(m.colRecurso) ? m.colRecurso : columnas.find((c) => /^(n[ºo°.]?\s*)?(recurso|c[oó]d|codigo|n[ºo°]|num)/i.test(c)) || "",
        colNombre: columnas.includes(m.colNombre) ? m.colNombre : columnas.find((c) => /nombre|trabajador|empleado/i.test(c)) || "",
        precios: Object.fromEntries(Object.entries(m.precios || {}).filter(([, c]) => columnas.includes(c))),
      };
      await guardar({ archivo: file.name, hoja, subido: new Date().toISOString(), columnas, filas, mapeo });
      setMsg(`Cargado: ${filas.length} filas`);
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
      return { tr, fila, lineas, total: lineas.reduce((s, l) => s + l.importe, 0) };
    });
    return { cods, filas };
  }, [t, trabajadores, ajustes, desde, hasta]);

  const setMapeo = (m) => guardar({ ...t, mapeo: { ...(t.mapeo || {}), ...m } });
  const nombreCod = (c) => (c === "__exceso" ? "Exceso sobre jornada (no declarado)" : c);

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
                  <div className="flex items-center gap-2 p-2 border-b bg-slate-50 text-xs text-slate-600">
                    Periodo {fmtF(desde)} – {fmtF(hasta)} · horas de BC (solo «Uso») ± incidencias de Configuración
                    <button onClick={() => descargarCSV(`pago_horas_${desde}_${hasta}.csv`, ["Nº recurso", "Trabajador", ...pago.cods.flatMap((c) => [`${nombreCod(c)} horas`, `${nombreCod(c)} precio`, `${nombreCod(c)} importe`]), "Total"],
                      pago.filas.filter((p) => p.total > 0).map((p) => ({ "Nº recurso": p.tr.recurso, Trabajador: p.tr.nombre, ...Object.fromEntries(p.lineas.flatMap((l) => [[`${nombreCod(l.c)} horas`, h(l.horas)], [`${nombreCod(l.c)} precio`, h(l.precio)], [`${nombreCod(l.c)} importe`, h(l.importe)]])), Total: h(p.total) })))}
                      className="ml-auto px-2 py-1 rounded border bg-white">⬇ Descargar CSV</button>
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="text-xs text-slate-500">
                        <th className="px-3 py-1.5 text-left">Trabajador</th>
                        {pago.cods.map((c) => <th key={c} className="px-3 text-right">{nombreCod(c)}<div className="font-normal text-[10px]">horas × precio</div></th>)}
                        <th className="px-3 text-right">Total a pagar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pago.filas.filter((p) => p.lineas.some((l) => l.horas)).map((p) => (
                        <tr key={p.tr.recurso} className="border-t border-slate-100">
                          <td className="px-3 py-1">
                            {p.tr.nombre} <span className="text-[10px] text-slate-400">{p.tr.recurso}</span>
                            {!p.fila && <div className="text-[10px] text-red-600">No está en la tabla de tarifas</div>}
                          </td>
                          {p.lineas.map((l) => (
                            <td key={l.c} className="px-3 text-right whitespace-nowrap">
                              {l.horas ? <>{h(l.horas)} h × {h(l.precio) || 0} € <div className="font-medium">{eur(l.importe)}</div></> : ""}
                              {l.ajuste ? <div className="text-[10px] text-amber-700">{l.ajuste > 0 ? "+" : ""}{h(l.ajuste)} h por incidencia</div> : null}
                            </td>
                          ))}
                          <td className="px-3 text-right font-bold">{eur(p.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="px-3 py-2">Total</td>
                        {pago.cods.map((c) => <td key={c} className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + (p.lineas.find((l) => l.c === c)?.importe || 0), 0))}</td>)}
                        <td className="px-3 text-right">{eur(pago.filas.reduce((s, p) => s + p.total, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </section>
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
