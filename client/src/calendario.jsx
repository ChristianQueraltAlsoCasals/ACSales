/**
 * calendario.jsx — Vista mensual de tareas (fecha límite) + eventos propios.
 * Tareas: misma clave localStorage que tareas.jsx.
 * Eventos: agente_ventas_calendario_v1 (solo este navegador).
 */
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Check,
  Circle,
  Pencil,
  X,
  Calendar as CalendarIcon,
} from "lucide-react";
import { cargarTareas, guardarTareas } from "./tareas.jsx";
import { cargarEventos, guardarEventos, EVT_TAREAS, EVT_EVENTOS } from "./accionesAppIA.js";

const hoyISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const aISO = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const DIAS_SEM = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

const RANK = { alta: 3, media: 2, baja: 1 };

const chipTarea = (t, hoy) => {
  if (t.hecha) return "bg-slate-100 text-slate-400 line-through";
  if (t.fecha && t.fecha < hoy) return "bg-red-100 text-red-700";
  if (t.prioridad === "alta") return "bg-red-50 text-red-700";
  if (t.prioridad === "baja") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-800";
};

export default function Calendario({ activo = true }) {
  const hoy = hoyISO();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [sel, setSel] = useState(hoy);
  const [tareas, setTareas] = useState(cargarTareas);
  const [eventos, setEventos] = useState(cargarEventos);
  const [skipSaveTareas, setSkipSaveTareas] = useState(true);

  const [form, setForm] = useState(null); // null | { id?, titulo, fecha, hora, notas }
  const [editId, setEditId] = useState(null);
  const omitirEcoRef = useRef(false);

  useEffect(() => { guardarEventos(eventos); }, [eventos]);
  useEffect(() => {
    if (skipSaveTareas) {
      setSkipSaveTareas(false);
      return;
    }
    guardarTareas(tareas);
    omitirEcoRef.current = true;
    try { window.dispatchEvent(new CustomEvent(EVT_TAREAS)); } catch { /* ok */ }
    queueMicrotask(() => { omitirEcoRef.current = false; });
  }, [tareas, skipSaveTareas]);

  // Releer tareas al entrar en la sección / al cambiar de mes
  useEffect(() => {
    if (!activo) return;
    setSkipSaveTareas(true);
    setTareas(cargarTareas());
    setEventos(cargarEventos());
  }, [activo, cursor.y, cursor.m]);

  useEffect(() => {
    const recargarTareas = () => {
      if (omitirEcoRef.current) return;
      setSkipSaveTareas(true);
      setTareas(cargarTareas());
    };
    const recargarEventos = () => setEventos(cargarEventos());
    window.addEventListener(EVT_TAREAS, recargarTareas);
    window.addEventListener(EVT_EVENTOS, recargarEventos);
    return () => {
      window.removeEventListener(EVT_TAREAS, recargarTareas);
      window.removeEventListener(EVT_EVENTOS, recargarEventos);
    };
  }, []);

  const celdas = useMemo(() => {
    const primero = new Date(cursor.y, cursor.m, 1);
    // Lunes = 0 … Domingo = 6
    let inicio = (primero.getDay() + 6) % 7;
    const diasMes = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < inicio; i++) out.push(null);
    for (let d = 1; d <= diasMes; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const porDia = useMemo(() => {
    const map = {};
    const add = (fecha, item) => {
      if (!fecha) return;
      if (!map[fecha]) map[fecha] = [];
      map[fecha].push(item);
    };
    for (const t of tareas) {
      if (!t.fecha) continue;
      add(t.fecha, { tipo: "tarea", ...t });
    }
    for (const e of eventos) {
      if (!e.fecha) continue;
      add(e.fecha, { tipo: "evento", ...e });
    }
    return map;
  }, [tareas, eventos]);

  const itemsDia = useMemo(() => {
    const list = porDia[sel] || [];
    return [...list].sort((a, b) => {
      if (a.tipo === "evento" && b.tipo !== "evento") return -1;
      if (b.tipo === "evento" && a.tipo !== "evento") return 1;
      if (a.tipo === "evento" && b.tipo === "evento") {
        return (a.hora || "99:99").localeCompare(b.hora || "99:99");
      }
      const r = (RANK[b.prioridad] || 0) - (RANK[a.prioridad] || 0);
      if (r) return r;
      return String(a.titulo || "").localeCompare(String(b.titulo || ""));
    });
  }, [porDia, sel]);

  const mesAnt = () =>
    setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const mesSig = () =>
    setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  const irHoy = () => {
    const d = new Date();
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setSel(hoyISO());
  };

  const abrirNuevo = () => {
    setEditId(null);
    setForm({ titulo: "", fecha: sel, hora: "", notas: "" });
  };

  const abrirEditar = (e) => {
    setEditId(e.id);
    setForm({
      titulo: e.titulo || "",
      fecha: e.fecha || sel,
      hora: e.hora || "",
      notas: e.notas || "",
    });
  };

  const guardarForm = () => {
    if (!form?.titulo?.trim()) return;
    const payload = {
      titulo: form.titulo.trim(),
      fecha: form.fecha || sel,
      hora: form.hora || "",
      notas: form.notas || "",
    };
    if (editId != null) {
      setEventos((prev) =>
        prev.map((e) => (e.id === editId ? { ...e, ...payload } : e))
      );
    } else {
      setEventos((prev) => [
        {
          id: Date.now() + Math.random(),
          ...payload,
          creado: new Date().toISOString(),
        },
        ...prev,
      ]);
    }
    setForm(null);
    setEditId(null);
    if (payload.fecha) setSel(payload.fecha);
  };

  const borrarEvento = (id) => {
    setEventos((prev) => prev.filter((e) => e.id !== id));
    if (editId === id) {
      setForm(null);
      setEditId(null);
    }
  };

  const toggleTarea = (id) =>
    setTareas((prev) => prev.map((t) => (t.id === id ? { ...t, hecha: !t.hecha } : t)));

  const selLabel = useMemo(() => {
    try {
      const [y, m, d] = sel.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch {
      return sel;
    }
  }, [sel]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <CalendarIcon size={22} className="text-cyan-700" />
        <h1 className="text-2xl font-bold text-slate-800">Calendario</h1>
      </div>
      <p className="text-slate-500 text-sm mt-1">
        Fechas límite de tus tareas y eventos propios. Se guardan en este navegador.
      </p>

      <div className="mt-5 flex flex-col xl:flex-row gap-5 items-start">
        {/* Rejilla mes */}
        <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-100">
            <button
              type="button"
              onClick={mesAnt}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"
              title="Mes anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="flex-1 text-center text-[15px] font-semibold text-slate-800">
              {MESES[cursor.m]} {cursor.y}
            </div>
            <button
              type="button"
              onClick={irHoy}
              className="text-[12px] font-semibold text-cyan-700 hover:bg-cyan-50 rounded-md px-2 py-1"
            >
              Hoy
            </button>
            <button
              type="button"
              onClick={mesSig}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"
              title="Mes siguiente"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50/80">
            {DIAS_SEM.map((d) => (
              <div
                key={d}
                className="text-[11px] font-bold text-slate-400 uppercase text-center py-1.5"
              >
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {celdas.map((dia, i) => {
              if (dia == null) {
                return <div key={`e-${i}`} className="min-h-[88px] bg-slate-50/40 border-b border-r border-slate-50" />;
              }
              const iso = aISO(cursor.y, cursor.m, dia);
              const items = porDia[iso] || [];
              const esHoy = iso === hoy;
              const esSel = iso === sel;
              const visibles = items.slice(0, 3);
              const extra = items.length - visibles.length;

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => {
                    setSel(iso);
                    setForm(null);
                    setEditId(null);
                  }}
                  className={`min-h-[88px] text-left align-top p-1.5 border-b border-r border-slate-100 hover:bg-cyan-50/40 transition-colors ${
                    esSel ? "bg-cyan-50 ring-1 ring-inset ring-cyan-400" : ""
                  } ${esHoy && !esSel ? "bg-white" : ""}`}
                >
                  <div
                    className={`inline-flex items-center justify-center w-6 h-6 text-[12px] font-semibold rounded-full mb-0.5 ${
                      esHoy
                        ? "bg-cyan-700 text-white"
                        : esSel
                          ? "text-cyan-800"
                          : "text-slate-700"
                    }`}
                  >
                    {dia}
                  </div>
                  <div className="space-y-0.5">
                    {visibles.map((it) =>
                      it.tipo === "evento" ? (
                        <div
                          key={`ev-${it.id}`}
                          className="truncate text-[10px] font-medium px-1 py-0.5 rounded bg-teal-100 text-teal-800"
                          title={it.titulo}
                        >
                          {it.hora ? `${it.hora} ` : ""}
                          {it.titulo}
                        </div>
                      ) : (
                        <div
                          key={`ta-${it.id}`}
                          className={`truncate text-[10px] font-medium px-1 py-0.5 rounded ${chipTarea(it, hoy)}`}
                          title={it.titulo}
                        >
                          {it.titulo}
                        </div>
                      )
                    )}
                    {extra > 0 && (
                      <div className="text-[10px] text-slate-400 px-1">+{extra}</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-3 px-3 py-2 border-t border-slate-100 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-teal-400" /> Evento
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-amber-400" /> Tarea
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded bg-red-400" /> Vencida / alta
            </span>
          </div>
        </div>

        {/* Panel del día */}
        <aside className="w-full xl:w-[380px] shrink-0 xl:sticky xl:top-4 space-y-3">
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] font-bold text-slate-400 uppercase">Día</div>
                <div className="text-[15px] font-semibold text-slate-800 capitalize">{selLabel}</div>
              </div>
              <button
                type="button"
                onClick={abrirNuevo}
                className="flex items-center gap-1 text-sm font-semibold text-white bg-cyan-700 hover:bg-cyan-800 rounded-md px-3 py-1.5 shrink-0"
              >
                <Plus size={15} /> Evento
              </button>
            </div>

            {form && (
              <div className="mt-3 border border-cyan-200 bg-cyan-50/40 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[12px] font-bold text-cyan-800">
                    {editId != null ? "Editar evento" : "Nuevo evento"}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setForm(null); setEditId(null); }}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X size={15} />
                  </button>
                </div>
                <input
                  value={form.titulo}
                  onChange={(e) => setForm({ ...form, titulo: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && guardarForm()}
                  placeholder="Título"
                  className="w-full py-1.5 px-2 border border-slate-300 rounded-md text-[13px] bg-white"
                  autoFocus
                />
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={form.fecha}
                    onChange={(e) => setForm({ ...form, fecha: e.target.value })}
                    className="flex-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px] bg-white"
                  />
                  <input
                    type="time"
                    value={form.hora}
                    onChange={(e) => setForm({ ...form, hora: e.target.value })}
                    className="w-[110px] py-1.5 px-2 border border-slate-300 rounded-md text-[13px] bg-white"
                  />
                </div>
                <textarea
                  value={form.notas}
                  onChange={(e) => setForm({ ...form, notas: e.target.value })}
                  placeholder="Notas (opcional)"
                  rows={2}
                  className="w-full py-1.5 px-2 border border-slate-300 rounded-md text-[12px] bg-white resize-none"
                />
                <button
                  type="button"
                  onClick={guardarForm}
                  disabled={!form.titulo.trim()}
                  className="w-full text-sm font-semibold text-white bg-cyan-700 hover:bg-cyan-800 disabled:opacity-40 rounded-md py-1.5"
                >
                  Guardar
                </button>
              </div>
            )}

            <div className="mt-3 space-y-2 max-h-[28rem] overflow-y-auto">
              {itemsDia.length === 0 && !form && (
                <div className="text-[13px] text-slate-400 py-4 text-center">
                  Nada en este día.
                </div>
              )}
              {itemsDia.map((it) =>
                it.tipo === "evento" ? (
                  <div
                    key={`p-ev-${it.id}`}
                    className="border border-teal-200 bg-teal-50/40 rounded-lg p-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-slate-800">
                          {it.hora ? (
                            <span className="text-teal-700 font-bold mr-1.5">{it.hora}</span>
                          ) : null}
                          {it.titulo}
                        </div>
                        {it.notas ? (
                          <div className="text-[12px] text-slate-500 mt-0.5 whitespace-pre-wrap">
                            {it.notas}
                          </div>
                        ) : null}
                        <div className="text-[10px] font-bold text-teal-600 uppercase mt-1">
                          Evento
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => abrirEditar(it)}
                        className="text-slate-300 hover:text-cyan-700 shrink-0"
                        title="Editar"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => borrarEvento(it.id)}
                        className="text-slate-300 hover:text-red-500 shrink-0"
                        title="Borrar"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={`p-ta-${it.id}`}
                    className={`border rounded-lg p-2.5 ${
                      !it.hecha && it.fecha && it.fecha < hoy
                        ? "border-red-200 bg-red-50/30"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => toggleTarea(it.id)}
                        className="mt-0.5 shrink-0"
                        title={it.hecha ? "Marcar pendiente" : "Marcar hecha"}
                      >
                        {it.hecha ? (
                          <Check size={16} className="text-emerald-600" />
                        ) : (
                          <Circle size={16} className="text-slate-300 hover:text-blue-500" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-[13px] font-medium ${
                            it.hecha ? "line-through text-slate-400" : "text-slate-800"
                          }`}
                        >
                          {it.titulo}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] font-bold text-slate-400 uppercase">
                            Tarea
                          </span>
                          {it.prioridad && (
                            <span
                              className={`text-[10px] font-bold border rounded px-1.5 py-0.5 ${
                                it.prioridad === "alta"
                                  ? "bg-red-100 text-red-700 border-red-200"
                                  : it.prioridad === "baja"
                                    ? "bg-slate-100 text-slate-500 border-slate-200"
                                    : "bg-amber-100 text-amber-700 border-amber-200"
                              }`}
                            >
                              {it.prioridad === "alta"
                                ? "Alta"
                                : it.prioridad === "baja"
                                  ? "Baja"
                                  : "Media"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
