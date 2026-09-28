/**
 * horas.jsx — Pantalla «Control de horas» (24/09/2026).
 *
 * Horas de los trabajadores desde los Movs. proyecto de BC (backend/horas.cjs):
 *  · Cuadro trabajador × día (o × semana si el periodo es largo) con colores:
 *    sin imputar, por debajo de jornada, completa, con exceso, ausencia.
 *  · Extras y ausencias por trabajador (según el TIPO DE TRABAJO de BC y el
 *    exceso sobre la jornada teórica).
 *  · Detalle de movimientos y clasificación de los tipos de trabajo
 *    (qué código es extra, vacaciones, baja…), jornada y festivos.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ConfiguracionHoras, TarifasHoras, FestivosLinea, listaFestivos } from "./horasExtra.jsx";

const CATS = {
  normal: { txt: "Normal", color: "" },
  extra: { txt: "Hora extra", color: "text-purple-700" },
  vacaciones: { txt: "Vacaciones", color: "text-sky-700" },
  baja: { txt: "Baja", color: "text-rose-700" },
  festivo: { txt: "Festivo", color: "text-teal-700" },
  permiso: { txt: "Permiso / ausencia", color: "text-amber-700" },
  noHoras: { txt: "No son horas (km, uds…)", color: "text-slate-400" },
};
const AUSENCIAS = ["vacaciones", "baja", "festivo", "permiso"];
const LETRA = { vacaciones: "V", baja: "B", festivo: "F", permiso: "P" };

// Clasificación por defecto según el código de tipo de trabajo
function adivinar(cod) {
  const c = String(cod || "").toUpperCase();
  if (!c) return "normal";
  if (/EXT|^HE|H\.?E\.?$|NOCT|NOCHE|FINDE|SABAD|DOMING/.test(c)) return "extra";
  if (/VAC/.test(c)) return "vacaciones";
  if (/BAJ|^IT$|ENFER|ACCID|MEDIC/.test(c)) return "baja";
  if (/FEST/.test(c)) return "festivo";
  if (/PERM|AUSEN|LICEN|ASUNT|FORMAC/.test(c)) return "permiso";
  return "normal";
}
const esHora = (u) => !u || /^(h|hr|hrs|hora|horas|hour|hours)$/i.test(String(u).trim());

const iso = (d) => d.toISOString().slice(0, 10);
const hoyISO = () => iso(new Date());
const inicioMes = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
function diasEntre(desde, hasta) {
  const out = [];
  const d = new Date(`${desde}T00:00:00Z`), f = new Date(`${hasta}T00:00:00Z`);
  while (d <= f && out.length < 400) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const diaSemana = (s) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 domingo
const lunesDe = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
const h = (v) => (v ? (Math.round(v * 100) / 100).toLocaleString("es-ES") : "");
const fmtF = (s) => (s ? s.split("-").reverse().join("/") : "");
const DIAS = ["D", "L", "M", "X", "J", "V", "S"];

export default function ControlHoras() {
  const [datos, setDatos] = useState(null);
  const [ajustes, setAjustes] = useState({ tipos: {}, jornada: 8, jornadaViernes: null, festivos: [] });
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [pestana, setPestana] = useState("cuadro");
  const [buscar, setBuscar] = useState("");
  const [sel, setSel] = useState(null); // recurso seleccionado para el detalle
  const [soloIncidencias, setSoloIncidencias] = useState(false);
  const [soloPersonas, setSoloPersonas] = useState(true); // fuera máquinas/vehículos (tipo de recurso en BC)
  const [guardado, setGuardado] = useState("");
  const [plegados, setPlegados] = useState({}); // recurso -> plegado (por defecto se ven las filas por tipo de línea)
  const [diaDetalle, setDiaDetalle] = useState(null); // { r, dias: [..], titulo }
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && setDiaDetalle(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    fetch("/api/horas/estado").then((r) => r.json()).then((j) => {
      if (j.datos) { setDatos(j.datos); setDesde(j.datos.desde); setHasta(j.datos.hasta); }
      if (j.ajustes) setAjustes((a) => ({ ...a, ...j.ajustes }));
    }).catch(() => setError({ error: "No se pudo conectar con el backend. ¿Está arrancado (INICIAR.bat)?" }));
  }, []);

  async function cargar() {
    setCargando(true); setError(null);
    try {
      const r = await fetch("/api/horas/cargar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desde, hasta }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { info: j });
      setDatos(j.datos);
    } catch (e) {
      setError(e.info || { error: String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend." : String(e.message || e) });
    }
    setCargando(false);
  }
  async function guardarAjustes(nuevo) {
    setAjustes(nuevo);
    try {
      await fetch("/api/horas/ajustes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nuevo) });
      setGuardado("Guardado ✓"); setTimeout(() => setGuardado(""), 1500);
    } catch { setGuardado("No se pudo guardar"); }
  }

  // Todos los códigos de tipo de trabajo cuentan (vacaciones, ausencias…), sea cual sea la unidad de medida
  const catDe = (f) => ajustes.tipos?.[f.tipoTrabajo] || adivinar(f.tipoTrabajo);
  // Festivos línea a línea: «Todos» (recurso vacío) = para toda la plantilla; con trabajador = solo para él
  const { festivos, festivosRec } = useMemo(() => {
    const todos = new Set(), porRec = {};
    for (const l of listaFestivos(ajustes)) {
      if (!l.fecha) continue;
      if (l.recurso) (porRec[l.recurso] ||= new Set()).add(l.fecha); else todos.add(l.fecha);
    }
    return { festivos: todos, festivosRec: porRec };
  }, [ajustes.festivosLista, ajustes.festivos]); // eslint-disable-line react-hooks/exhaustive-deps
  // Festivos de cada población e incidencias por trabajador (pestaña Configuración)
  const festPobl = useMemo(() => Object.fromEntries((ajustes.poblaciones || []).map((p) => [p.nombre, new Set(p.festivos || [])])), [ajustes.poblaciones]);
  const incPorRec = useMemo(() => {
    const o = {};
    for (const i of ajustes.incidencias || []) if (i.tipo === "libre" || i.tipo === "reduccion") (o[i.recurso] ||= []).push(i);
    return o;
  }, [ajustes.incidencias]);
  const jornadaDia = (dia, recurso) => {
    const ds = diaSemana(dia);
    if (ds === 0 || ds === 6 || festivos.has(dia)) return 0;
    let base = ds === 5 && ajustes.jornadaViernes ? Number(ajustes.jornadaViernes) : Number(ajustes.jornada) || 8;
    if (recurso) {
      if (festivosRec[recurso]?.has(dia)) return 0; // festivo específico de este trabajador
      const pob = ajustes.asignacion?.[recurso];
      if (pob && festPobl[pob]?.has(dia)) return 0; // festivo local de su población
      for (const i of incPorRec[recurso] || []) {
        if (dia < i.desde || dia > (i.hasta || i.desde)) continue;
        if (i.tipo === "libre") return 0;
        if (i.tipo === "reduccion") base = Math.min(base, Number(i.horas) || base);
      }
    }
    return base;
  };

  // ---------- Cálculo ----------
  const calc = useMemo(() => {
    if (!datos) return null;
    const dias = diasEntre(datos.desde, datos.hasta);
    const hastaReal = datos.hasta > hoyISO() ? hoyISO() : datos.hasta; // no marcar como «sin imputar» los días futuros
    const porRec = {};
    let noHoras = 0;
    for (const f0 of datos.filas) {
      if (soloPersonas && /machin|m[aá]quina/i.test(datos.tipoRecurso?.[f0.recurso] || "")) continue;
      // Líneas en DÍAS (p. ej. vacaciones) → horas según la jornada de ese día
      const enDias = /^(d|dia|día|dias|días|day|days|jornada)$/i.test(String(f0.unidad || "").trim());
      const f = enDias ? { ...f0, horas: f0.horas * (jornadaDia(f0.fecha, f0.recurso) || Number(ajustes.jornada) || 8), cantidadOriginal: f0.horas } : f0;
      const cat = catDe(f);
      if (cat === "noHoras") { noHoras++; continue; }
      const r = (porRec[f.recurso] ||= { recurso: f.recurso, nombre: datos.nombres?.[f.recurso] || f.recurso, dias: {}, movs: [] });
      const d = (r.dias[f.fecha] ||= { trabajo: 0, extra: 0, aus: {}, total: 0 });
      if (cat === "normal") d.trabajo += f.horas;
      else if (cat === "extra") { d.trabajo += f.horas; d.extra += f.horas; }
      else d.aus[cat] = (d.aus[cat] || 0) + f.horas;
      d.total += f.horas;
      r.movs.push({ ...f, cat });
    }
    const lista = Object.values(porRec).map((r) => {
      const t = { trabajadas: 0, extras: 0, exceso: 0, ausencias: 0, teoricas: 0, sinImputar: 0, faltan: 0, porAus: {} };
      for (const dia of dias) {
        const j = jornadaDia(dia, r.recurso);
        const d = r.dias[dia];
        const aus = d ? Object.values(d.aus).reduce((a, b) => a + b, 0) : 0;
        const trab = d ? d.trabajo : 0;
        if (dia <= hastaReal) t.teoricas += j;
        t.trabajadas += trab;
        t.extras += d ? d.extra : 0;
        t.ausencias += aus;
        if (d) for (const [c, v] of Object.entries(d.aus)) t.porAus[c] = (t.porAus[c] || 0) + v;
        const normales = trab - (d ? d.extra : 0);
        if (j > 0) {
          if (normales > j) t.exceso += normales - j; // horas por encima de la jornada no marcadas como extra
          if (dia <= hastaReal) {
            if (!d || trab + aus === 0) t.sinImputar++;
            else if (trab + aus < j) t.faltan += j - (trab + aus);
          }
        } else if (normales > 0) t.exceso += normales; // trabajo en fin de semana / festivo
      }
      t.diferencia = t.trabajadas + t.ausencias - t.teoricas;
      const codigos = [...new Set(r.movs.map((m) => m.tipoTrabajo).filter(Boolean))].sort();
      return { ...r, codigos, t, incidencias: t.sinImputar > 0 || t.faltan > 0.01 || t.exceso > 0.01 || t.extras > 0 };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const tipos = {};
    for (const f of datos.filas) {
      const k = f.tipoTrabajo || "";
      tipos[k] ||= { cod: k, horas: 0, movs: 0, unidades: new Set() };
      tipos[k].horas += f.horas; tipos[k].movs++; tipos[k].unidades.add(f.unidad || "—");
    }
    return { dias, lista, noHoras, tipos: Object.values(tipos).sort((a, b) => b.horas - a.horas), hastaReal };
  }, [datos, ajustes, soloPersonas]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibles = calc ? calc.lista.filter((r) =>
    (!buscar || `${r.nombre} ${r.recurso}`.toLowerCase().includes(buscar.toLowerCase())) && (!soloIncidencias || r.incidencias)) : [];
  const porSemanas = calc && calc.dias.length > 31;
  const columnas = calc ? (porSemanas ? [...new Set(calc.dias.map(lunesDe))] : calc.dias) : [];

  // Celda del día en la fila del TRABAJADOR (total del día, en color)
  function celda(r, col) {
    const diasCol = porSemanas ? calc.dias.filter((d) => lunesDe(d) === col) : [col];
    let trab = 0, aus = 0, j = 0;
    let futuro = true;
    for (const d of diasCol) {
      const x = r.dias[d];
      if (d <= calc.hastaReal) { j += jornadaDia(d, r.recurso); futuro = false; }
      if (x) { trab += x.trabajo; aus += Object.values(x.aus).reduce((a, b) => a + b, 0); }
    }
    const total = trab + aus;
    let cls;
    if (total > 0) {
      if (j === 0) cls = "bg-violet-500 text-white font-bold";          // trabajo en fin de semana / festivo
      else if (total < j - 0.01) cls = "bg-amber-400 text-white font-bold"; // faltan horas
      else cls = "bg-emerald-500 text-white font-bold";                 // jornada completa (o más)
    } else if (!futuro && j > 0) cls = "bg-red-100";                      // laborable sin imputar
    else cls = "bg-[#dce6f2]";                                            // fin de semana / festivo / futuro
    const abrir = () => total && setDiaDetalle({ r, dias: diasCol, titulo: porSemanas ? `semana del ${fmtF(diasCol[0])}` : fmtF(col) });
    return (
      <td key={col} onClick={abrir}
        className={`min-w-[58px] px-1 py-2 text-center text-[13px] border border-white ${total ? "cursor-pointer hover:brightness-110" : ""} ${cls}`}
        title={`${porSemanas ? `Semana del ${fmtF(col)}` : fmtF(col)} · ${h(total) || 0} h imputadas · jornada ${h(j) || 0} h`}>
        {total ? h(total) : ""}
      </td>
    );
  }

  // Celda del día en la fila de un TIPO DE LÍNEA (H_NORMAL, H_EXTRA, VAC…)
  function celdaCodigo(r, cod, col) {
    const diasCol = porSemanas ? calc.dias.filter((d) => lunesDe(d) === col) : [col];
    const v = r.movs.filter((m) => (m.tipoTrabajo || "(sin tipo)") === cod && diasCol.includes(m.fecha)).reduce((t, m) => t + m.horas, 0);
    const finde = !porSemanas && jornadaDia(col, r.recurso) === 0;
    return (
      <td key={col} onClick={() => v && setDiaDetalle({ r, dias: diasCol, titulo: porSemanas ? `semana del ${fmtF(diasCol[0])}` : fmtF(col) })}
        className={`min-w-[58px] px-1 py-1.5 text-center text-[13px] border border-slate-200 text-slate-700 ${finde ? "bg-slate-50" : "bg-white"} ${v ? "cursor-pointer hover:bg-blue-50" : ""}`}>{h(v)}</td>
    );
  }

  const input = "border rounded px-2 py-1 text-sm";
  return (
    <div className="w-full">
      <h1 className="text-2xl font-bold text-slate-800">⏱️ Control de horas</h1>
      <p className="text-slate-500 text-sm mt-1 max-w-3xl">
        Horas de los trabajadores desde los <b>Movs. proyecto</b> de Business Central{datos?.empresa ? ` (${datos.empresa})` : ""}: lo imputado cada día comparado con la jornada, horas extra y ausencias según el tipo de trabajo.
      </p>

      <div className="flex flex-wrap items-end gap-3 mt-4">
        <label className="text-sm text-slate-600">Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={`block mt-1 ${input}`} /></label>
        <label className="text-sm text-slate-600">Hasta<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={`block mt-1 ${input}`} /></label>
        <button onClick={cargar} disabled={cargando} className="px-4 py-2 rounded bg-blue-700 text-white text-sm disabled:opacity-50">{cargando ? "Cargando de BC…" : "↻ Cargar desde BC"}</button>
        {datos && (
          <span className="text-xs text-slate-400">
            Cargado {new Date(datos.cargado).toLocaleString("es-ES")} · {fmtF(datos.desde)}–{fmtF(datos.hasta)} · {datos.filas.length.toLocaleString("es-ES")} movimientos de recursos · servicio «{datos.servicio}»
            {!datos.servicioRecursos && " · (sin ficha de recursos: nombres desde la descripción)"}
          </span>
        )}
      </div>
      {datos?.aviso && <p className="mt-2 text-xs text-amber-700">{datos.aviso}</p>}
      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          <div className="font-medium">{error.error}</div>
          {error.detalle && <div className="mt-1 text-red-800">{error.detalle}</div>}
          {error.probados?.length > 0 && <div className="mt-1 text-xs text-slate-600">Nombres probados: {error.probados.join(" · ")}</div>}
          {error.servicios?.length > 0 && (
            <details className="mt-1 text-xs text-slate-600"><summary className="cursor-pointer">Servicios web publicados ahora ({error.servicios.length})</summary>{error.servicios.join(" · ")}</details>
          )}
        </div>
      )}
      {!datos && !error && !cargando && <p className="mt-4 text-sm text-slate-500">Elige el periodo y pulsa «Cargar desde BC».</p>}

      {calc && (
        <>
          <div className="flex gap-1 mt-5 border-b">
            {[["cuadro", "Cuadro de horas"], ["extras", "Extras y ausencias"], ["detalle", "Detalle"], ["tipos", "Tipos de trabajo y jornada"], ["config", "Configuración"], ["tarifas", "Tarifas y pago"]].map(([k, t]) => (
              <button key={k} onClick={() => setPestana(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === k ? "border-blue-700 text-blue-800 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{t}</button>
            ))}
          </div>

          {(pestana === "cuadro" || pestana === "extras") && (
            <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
              <input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar trabajador…" className={`${input} w-56`} />
              <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={soloIncidencias} onChange={(e) => setSoloIncidencias(e.target.checked)} /> Solo con incidencias</label>
              {datos.tipoRecurso && Object.keys(datos.tipoRecurso).length > 0 && (
                <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={soloPersonas} onChange={(e) => setSoloPersonas(e.target.checked)} /> Solo personas (sin máquinas)</label>
              )}
              <span className="text-xs text-slate-400">{visibles.length} trabajadores · jornada {ajustes.jornada} h{ajustes.jornadaViernes ? ` (viernes ${ajustes.jornadaViernes} h)` : ""}</span>
              {pestana === "cuadro" && (
                <span className="flex gap-2 text-xs">
                  <button onClick={() => setPlegados({})} className="underline text-slate-500">Desplegar todos</button>
                  <button onClick={() => setPlegados(Object.fromEntries(visibles.map((r) => [r.recurso, true])))} className="underline text-slate-500">Plegar todos</button>
                </span>
              )}
            </div>
          )}

          {pestana === "cuadro" && (
            <>
              <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-slate-600">
                {[["bg-emerald-500", "Jornada completa"], ["bg-amber-400", "Faltan horas"], ["bg-red-100", "Sin imputar"], ["bg-violet-500", "Fin de semana / festivo trabajado"], ["bg-[#dce6f2]", "Fin de semana / festivo"]].map(([c, t]) => (
                  <span key={t} className="flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded-sm ${c}`} />{t}</span>
                ))}
              </div>
              <section className="mt-2 w-full bg-white rounded-lg shadow-sm border border-slate-300 overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-[11px] text-slate-600 bg-slate-100">
                      <th className="px-3 py-1.5 text-left sticky left-0 z-10 bg-slate-100 min-w-[280px] border border-slate-200">Trabajador / tipo de línea</th>
                      {columnas.map((c) => (
                        <th key={c} className={`px-1 py-1 font-semibold border border-slate-200 ${!porSemanas && jornadaDia(c) === 0 ? "bg-[#dce6f2] text-slate-400" : ""}`}>
                          {porSemanas ? `S ${fmtF(c).slice(0, 5)}` : <>{DIAS[diaSemana(c)]}<br />{c.slice(8)}</>}
                        </th>
                      ))}
                      <th className="px-2 py-1 text-right border border-slate-200">Total</th>
                      <th className="px-2 py-1 text-right border border-slate-200">Extras</th>
                      <th className="px-2 py-1 text-right border border-slate-200">Ausenc.</th>
                      <th className="px-2 py-1 text-right border border-slate-200" title="Días laborables sin ninguna hora imputada">Sin imp.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((r) => {
                      const abierto = !plegados[r.recurso];
                      const codigosFila = [...new Set(r.movs.map((m) => m.tipoTrabajo || "(sin tipo)"))].sort();
                      return (
                        <React.Fragment key={r.recurso}>
                          <tr className="bg-[#dce6f2]">
                            <td className="px-2 py-1.5 sticky left-0 z-10 bg-[#dce6f2] border border-white">
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => setPlegados((a) => ({ ...a, [r.recurso]: abierto }))} className="text-slate-600 w-4 text-[11px]" title={abierto ? "Plegar" : "Desplegar"}>{abierto ? "▼" : "▶"}</button>
                                <button onClick={() => { setSel(r.recurso); setPestana("detalle"); }} className="text-left font-bold text-[12.5px] text-slate-800 uppercase hover:underline" title={`Nº recurso ${r.recurso}`}>{r.nombre}</button>
                              </div>
                            </td>
                            {columnas.map((c) => celda(r, c))}
                            <td className="px-2 text-right font-bold text-slate-800 border border-white">{h(r.t.trabajadas + r.t.ausencias)}</td>
                            <td className="px-2 text-right font-semibold text-violet-700 border border-white">{h(r.t.extras)}</td>
                            <td className="px-2 text-right font-semibold text-sky-700 border border-white">{h(r.t.ausencias)}</td>
                            <td className={`px-2 text-right border border-white ${r.t.sinImputar ? "text-red-600 font-bold" : "text-slate-400"}`}>{r.t.sinImputar || ""}</td>
                          </tr>
                          {abierto && codigosFila.map((cod) => (
                            <tr key={cod}>
                              <td className="pl-9 pr-2 py-1 sticky left-0 z-10 bg-white text-[12px] text-slate-600 border border-slate-200">{cod}</td>
                              {columnas.map((c) => celdaCodigo(r, cod, c))}
                              <td className="px-2 text-right text-[12px] text-slate-700 border border-slate-200">{h(r.movs.filter((m) => (m.tipoTrabajo || "(sin tipo)") === cod).reduce((t, m) => t + m.horas, 0))}</td>
                              <td colSpan={3} className="border border-slate-200" />
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </section>
              {diaDetalle && (() => {
                const movs = diaDetalle.r.movs.filter((m) => diaDetalle.dias.includes(m.fecha)).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
                const varios = diaDetalle.dias.length > 1;
                return (
                  <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4" onClick={() => setDiaDetalle(null)}>
                    <div className="bg-white rounded-xl shadow-2xl p-6 max-w-3xl w-full max-h-[80vh] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setDiaDetalle(null)} className="absolute top-3 right-4 text-slate-400 hover:text-slate-600 text-lg">✕</button>
                      <h2 className="text-lg font-bold text-slate-800 pr-6">{diaDetalle.r.nombre} — {diaDetalle.titulo}</h2>
                      <table className="w-full text-sm mt-4 border">
                        <thead>
                          <tr className="bg-slate-50 text-slate-600">
                            {varios && <th className="px-3 py-1.5 border text-left">Fecha</th>}
                            <th className="px-3 py-1.5 border text-left">Tipo de hora</th>
                            <th className="px-3 py-1.5 border text-right">Horas</th>
                            <th className="px-3 py-1.5 border text-left">Nº Parte</th>
                            <th className="px-3 py-1.5 border text-left">Nº OT</th>
                            <th className="px-3 py-1.5 border text-left">Cliente</th>
                          </tr>
                        </thead>
                        <tbody>
                          {movs.map((m, k) => (
                            <tr key={k}>
                              {varios && <td className="px-3 py-1 border whitespace-nowrap">{fmtF(m.fecha)}</td>}
                              <td className="px-3 py-1 border font-mono text-xs">{m.tipoTrabajo || "—"}</td>
                              <td className="px-3 py-1 border text-right">{h(m.horas)}{m.cantidadOriginal != null ? <div className="text-[10px] text-slate-400">{h(m.cantidadOriginal)} {m.unidad}</div> : null}</td>
                              <td className="px-3 py-1 border">{m.doc}</td>
                              <td className="px-3 py-1 border">{m.ot}</td>
                              <td className="px-3 py-1 border">{datos.clientes?.[m.ot] || ""}</td>
                            </tr>
                          ))}
                          <tr className="bg-slate-50 font-semibold">
                            <td className="px-3 py-1.5 border" colSpan={varios ? 2 : 1}>Total</td>
                            <td className="px-3 py-1.5 border text-right">{h(movs.reduce((t, m) => t + m.horas, 0))}</td>
                            <td className="border" colSpan={3} />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
              <p className="text-xs text-slate-400 mt-2">Solo movimientos de tipo «Uso». Pulsa ▼ para plegar o desplegar las líneas de un trabajador y pulsa un día para ver su detalle (parte, OT y cliente). Debajo del nombre: Nº de recurso y códigos de tipo de trabajo del periodo. Los festivos (generales y de la población) y las incidencias de «Configuración» se tienen en cuenta. Pulsa un trabajador para ver sus movimientos.</p>
            </>
          )}

          {pestana === "extras" && (
            <section className="mt-3 bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 bg-slate-50">
                    <th className="px-3 py-2">Trabajador</th>
                    <th className="px-3 py-2 text-right">Extras declaradas</th>
                    <th className="px-3 py-2 text-right">Exceso sobre jornada</th>
                    {AUSENCIAS.map((a) => <th key={a} className="px-3 py-2 text-right">{CATS[a].txt}</th>)}
                    <th className="px-3 py-2 text-right">Faltan (días incompletos)</th>
                    <th className="px-3 py-2 text-right">Días sin imputar</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.filter((r) => r.t.extras || r.t.exceso || r.t.ausencias || r.t.faltan || r.t.sinImputar).map((r) => (
                    <tr key={r.recurso} className="border-t border-slate-100">
                      <td className="px-3 py-1.5"><button onClick={() => { setSel(r.recurso); setPestana("detalle"); }} className="hover:underline font-medium text-slate-700">{r.nombre}</button></td>
                      <td className="px-3 text-right text-purple-700">{h(r.t.extras)}</td>
                      <td className="px-3 text-right text-purple-700">{h(r.t.exceso)}</td>
                      {AUSENCIAS.map((a) => <td key={a} className={`px-3 text-right ${CATS[a].color}`}>{h(r.t.porAus[a])}</td>)}
                      <td className="px-3 text-right text-amber-700">{h(r.t.faltan)}</td>
                      <td className="px-3 text-right text-red-600">{r.t.sinImputar || ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold text-slate-700">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.extras, 0))}</td>
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.exceso, 0))}</td>
                    {AUSENCIAS.map((a) => <td key={a} className="px-3 text-right">{h(visibles.reduce((t, r) => t + (r.t.porAus[a] || 0), 0))}</td>)}
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.faltan, 0))}</td>
                    <td className="px-3 text-right">{visibles.reduce((t, r) => t + r.t.sinImputar, 0) || ""}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-xs text-slate-400 px-3 py-2">«Extras declaradas» = horas con un tipo de trabajo clasificado como extra. «Exceso» = horas normales por encima de la jornada o en fin de semana/festivo (posibles extras sin declarar). La clasificación se cambia en «Tipos de trabajo y jornada».</p>
            </section>
          )}

          {pestana === "detalle" && (
            <div className="mt-3">
              <select value={sel || ""} onChange={(e) => setSel(e.target.value || null)} className={input}>
                <option value="">— Elige un trabajador —</option>
                {calc.lista.map((r) => <option key={r.recurso} value={r.recurso}>{r.nombre} ({r.recurso})</option>)}
              </select>
              {sel && (() => {
                const r = calc.lista.find((x) => x.recurso === sel);
                if (!r) return <p className="text-sm text-slate-500 mt-2">Sin movimientos en el periodo.</p>;
                const movs = [...r.movs].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
                return (
                  <section className="mt-3 bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
                    <div className="px-3 py-2 text-sm text-slate-600 border-b bg-slate-50">
                      <b>{r.nombre}</b> · trabajadas {h(r.t.trabajadas) || 0} h de {h(r.t.teoricas) || 0} teóricas · extras {h(r.t.extras) || 0} · exceso {h(r.t.exceso) || 0} · ausencias {h(r.t.ausencias) || 0} · {r.t.sinImputar} días sin imputar
                    </div>
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-xs text-slate-500"><th className="px-3 py-1.5">Fecha</th><th className="px-3">OT</th><th className="px-3">Tarea</th><th className="px-3">Tipo trabajo</th><th className="px-3">Clasificación</th><th className="px-3 text-right">Horas</th><th className="px-3">Descripción</th><th className="px-3">Documento</th></tr></thead>
                      <tbody>
                        {movs.map((m, k) => (
                          <tr key={k} className="border-t border-slate-100">
                            <td className="px-3 py-1 whitespace-nowrap">{DIAS[diaSemana(m.fecha)]} {fmtF(m.fecha)}</td>
                            <td className="px-3 whitespace-nowrap">{m.ot}</td>
                            <td className="px-3">{m.tarea}</td>
                            <td className="px-3">{m.tipoTrabajo || "—"}</td>
                            <td className={`px-3 ${CATS[m.cat].color}`}>{CATS[m.cat].txt}</td>
                            <td className="px-3 text-right font-medium">{h(m.horas)}</td>
                            <td className="px-3 text-slate-500">{m.desc}</td>
                            <td className="px-3 text-slate-400 text-xs">{m.doc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                );
              })()}
            </div>
          )}

          {pestana === "config" && (
            <ConfiguracionHoras ajustes={ajustes} guardarAjustes={guardarAjustes} trabajadores={calc.lista} codigos={calc.tipos.map((t) => t.cod).filter(Boolean)} />
          )}
          {pestana === "tarifas" && (
            <TarifasHoras trabajadores={calc.lista} codigos={calc.tipos.map((t) => t.cod || "(sin tipo)")} ajustes={ajustes} desde={datos.desde} hasta={datos.hasta} />
          )}

          {pestana === "tipos" && (
            <div className="grid lg:grid-cols-2 gap-5 mt-3">
              <section className="bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="px-4 py-2 border-b bg-slate-50 font-semibold text-slate-800 text-sm">Tipos de trabajo de BC {guardado && <span className="ml-2 text-xs text-green-700 font-normal">{guardado}</span>}</div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500"><th className="px-4 py-1.5">Código</th><th className="px-4">Unidad</th><th className="px-4 text-right">Horas</th><th className="px-4">Cuenta como</th></tr></thead>
                  <tbody>
                    {calc.tipos.map((t) => (
                      <tr key={t.cod} className="border-t border-slate-100">
                        <td className="px-4 py-1 font-mono">{t.cod || "(sin tipo)"}</td>
                        <td className="px-4 text-slate-500">{[...t.unidades].join(", ")}</td>
                        <td className="px-4 text-right">{h(t.horas)}</td>
                        <td className="px-4">
                          <select value={ajustes.tipos?.[t.cod] || adivinar(t.cod)} onChange={(e) => guardarAjustes({ ...ajustes, tipos: { ...ajustes.tipos, [t.cod]: e.target.value } })} className="border rounded px-1 py-0.5 text-sm">
                            {Object.entries(CATS).filter(([k]) => k !== "noHoras").map(([k, v]) => <option key={k} value={k}>{v.txt}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-slate-400 px-4 py-2">La primera vez se clasifica por el nombre del código (EXTRA, VAC, BAJA, FEST…). Cambia lo que no esté bien; se guarda solo.</p>
              </section>
              <section className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm grid gap-3 content-start">
                <div className="font-semibold text-slate-800">Jornada y festivos</div>
                <label className="flex items-center gap-2">Jornada diaria (lunes a jueves)
                  <input type="number" step="0.25" value={ajustes.jornada} onChange={(e) => setAjustes({ ...ajustes, jornada: e.target.value })} onBlur={() => guardarAjustes(ajustes)} className={`${input} w-20`} /> h
                </label>
                <label className="flex items-center gap-2">Jornada del viernes (vacío = igual)
                  <input type="number" step="0.25" value={ajustes.jornadaViernes || ""} onChange={(e) => setAjustes({ ...ajustes, jornadaViernes: e.target.value || null })} onBlur={() => guardarAjustes(ajustes)} className={`${input} w-20`} /> h
                </label>
                <FestivosLinea ajustes={ajustes} guardarAjustes={guardarAjustes} trabajadores={calc.lista} />
                <p className="text-xs text-slate-400">Los festivos y fines de semana no cuentan como días sin imputar; si alguien trabaja ese día, sale como exceso.</p>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
