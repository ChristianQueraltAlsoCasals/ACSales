/**
 * manoObra.jsx — Pestaña «Control y análisis de mano de obra» en Ratios.
 * Horas reales de Movs. proyecto, solo tipo de movimiento Uso.
 * La unidad de negocio es el departamento del grupo de recurso.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

const horasTxt = (n) => (n == null || !isFinite(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const eurTxt = (n) => (n == null || !isFinite(n) ? "—" : n.toLocaleString("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const COSTE_HORA = 21.5;
// Preu de venda mitjà. El cost d'oportunitat és aquest preu menys COSTE_HORA.
// Manteniment es valora com Instalaciones; Servicio de ingeniería, com Automatización.
// Alquiler, Maquinaria i Prácticas no entren: no tenen preu de venda.
const PRECIO_VENTA = {
  Construcción: 27.5,
  Instalaciones: 28,
  Mantenimiento: 28,
  Automatización: 39,
  "Servicio de ingeniería": 39,
};

const COLOR_UNIDAD = {
  Automatización: "bg-sky-600",
  "Servicio de ingeniería": "bg-indigo-500",
  Instalaciones: "bg-teal-600",
  Mantenimiento: "bg-amber-500",
  Construcción: "bg-orange-500",
};

const vacío = { trabajador: "", unidad: "", ot: "", cliente: "", dimension: "" };

function claveFila(f) {
  return [f.recurso, f.ot, f.cliente, f.dimension].join("|");
}

function incluye(valor, filtro) {
  const q = String(filtro || "").trim().toLowerCase();
  if (!q) return true;
  return String(valor || "").toLowerCase().includes(q);
}

const GRUPO = { ALQ: "Alquiler", MAQ: "Maquinaria", PRAC: "Prácticas" };
const DEPARTAMENTO = {
  AU: "Automatización",
  CO: "Construcción",
  INS: "Instalaciones",
  MA: "Mantenimiento",
  MR: "Mantenimiento",
  SI: "Servicio de ingeniería",
};

function unidadDeGrupo(codigo) {
  const c = String(codigo || "").trim().toUpperCase();
  if (!c || c === "Nº" || c === "NO") return "";
  if (GRUPO[c]) return GRUPO[c];
  const m = c.match(/^MO([A-Z]+?)(\d{2})$/);
  if (!m) return c;
  return DEPARTAMENTO[m[1]] || m[1];
}

function indiceRecursos(filas) {
  const lista = filas || [];
  let columna = "";
  for (const row of lista) {
    if (!row || typeof row !== "object") continue;
    columna = Object.keys(row).find((k) => /resource_group_no/i.test(k)) || "";
    if (columna) break;
  }
  const mapa = new Map();
  for (const row of lista) {
    if (!row || typeof row !== "object") continue;
    const no = String(row.No ?? row.No_ ?? row["Nº"] ?? "").trim();
    if (!no) continue;
    const bruto = columna ? String(row[columna] || "").trim() : "";
    mapa.set(no.toUpperCase(), {
      nombre: String(row.Name || row.Nombre || "").trim(),
      unidad: columna ? unidadDeGrupo(bruto) : "",
    });
  }
  return { mapa, columna, cargada: mapa.size > 0 };
}

function agrupar(filas, campo, vacio) {
  const mapa = new Map();
  for (const f of filas) {
    const nombre = String(f[campo] || "").trim() || vacio;
    mapa.set(nombre, (mapa.get(nombre) || 0) + (Number(f.horas) || 0));
  }
  return [...mapa.entries()]
    .map(([nombre, horas]) => ({ nombre, horas }))
    .sort((a, b) => b.horas - a.horas || a.nombre.localeCompare(b.nombre, "es"));
}

function topClientes(filas) {
  const todos = agrupar(filas, "cliente", "Sense client");
  if (todos.length <= 8) return todos;
  const resto = todos.slice(8).reduce((s, p) => s + p.horas, 0);
  const cabeza = todos.slice(0, 8);
  if (resto > 0) cabeza.push({ nombre: "Altres", horas: resto });
  return cabeza;
}

function costeOportunidad(filas) {
  const porUnidad = new Map();
  let total = 0;
  let horasFuera = 0;
  for (const f of filas) {
    const unidad = String(f.unidad || "").trim();
    const horas = Number(f.horas) || 0;
    const precio = PRECIO_VENTA[unidad];
    if (precio == null) {
      horasFuera += horas;
      continue;
    }
    const importe = horas * (precio - COSTE_HORA);
    total += importe;
    const prev = porUnidad.get(unidad) || { horas: 0, importe: 0, margen: precio - COSTE_HORA };
    prev.horas += horas;
    prev.importe += importe;
    porUnidad.set(unidad, prev);
  }
  const detalle = [...porUnidad.entries()]
    .map(([nombre, v]) => ({ nombre, ...v }))
    .sort((a, b) => b.importe - a.importe);
  return { total, horasFuera, detalle };
}

function Barras({ titulo, partes }) {
  const max = partes.reduce((m, p) => Math.max(m, p.horas), 0);
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-medium text-slate-700">{titulo}</p>
      {!partes.length ? (
        <p className="mt-3 text-sm text-slate-400">No hi ha hores amb aquests filtres.</p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {partes.map((p) => (
            <div key={p.nombre}>
              <div className="flex justify-between gap-3 text-xs text-slate-600 mb-1">
                <span className="truncate">{p.nombre}</span>
                <span className="whitespace-nowrap tabular-nums">{horasTxt(p.horas)} h</span>
              </div>
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${COLOR_UNIDAD[p.nombre] || "bg-sky-600"}`}
                  style={{ width: max > 0 ? `${(p.horas / max) * 100}%` : "0%" }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ManoObra({ desde, hasta, recursos = [] }) {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [filtros, setFiltros] = useState(vacío);
  const [excluidas, setExcluidas] = useState([]);

  useEffect(() => {
    if (!desde || !hasta || desde > hasta) return;
    let vivo = true;
    setCargando(true);
    setError("");
    fetch(`/api/horas/mano-obra?desde=${desde}&hasta=${hasta}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
        if (vivo) setDatos(j);
      })
      .catch((e) => {
        if (!vivo) return;
        setDatos(null);
        setError(String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el servidor." : String(e.message || e));
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [desde, hasta]);

  useEffect(() => { setExcluidas([]); }, [desde, hasta]);

  const ficha = useMemo(() => indiceRecursos(recursos), [recursos]);
  const filas = useMemo(() => (datos?.filas || []).map((f) => {
    const rec = ficha.mapa.get(String(f.recurso || "").trim().toUpperCase());
    if (!rec) return f;
    return { ...f, nombre: rec.nombre || f.nombre, unidad: rec.unidad || "" };
  }), [datos, ficha]);
  const visibles = useMemo(() => filas.filter((f) =>
    incluye(`${f.nombre} ${f.recurso}`, filtros.trabajador)
    && incluye(f.unidad, filtros.unidad)
    && incluye(f.ot, filtros.ot)
    && incluye(f.cliente, filtros.cliente)
    && incluye(f.dimension, filtros.dimension)
  ), [filas, filtros]);
  const quitadas = useMemo(() => new Set(excluidas), [excluidas]);
  const activas = useMemo(() => visibles.filter((f) => !quitadas.has(claveFila(f))), [visibles, quitadas]);
  const fuera = useMemo(() => filas.filter((f) => quitadas.has(claveFila(f))), [filas, quitadas]);
  const total = activas.reduce((s, f) => s + (Number(f.horas) || 0), 0);
  const coste = total * COSTE_HORA;
  const porUnidad = useMemo(() => agrupar(activas, "unidad", "Sense unitat"), [activas]);
  const porCliente = useMemo(() => topClientes(activas), [activas]);
  const oportunidad = useMemo(() => costeOportunidad(activas), [activas]);
  const poner = (campo) => (e) => setFiltros((prev) => ({ ...prev, [campo]: e.target.value }));
  const excluir = (f) => setExcluidas((prev) => (prev.includes(claveFila(f)) ? prev : [...prev, claveFila(f)]));
  const restaurar = (clave) => setExcluidas((prev) => prev.filter((k) => k !== clave));

  return (
    <div className="mt-5">
      <h2 className="text-lg font-semibold text-slate-800">Control y análisis de mano de obra</h2>
      <p className="text-sm text-slate-500 mt-1 max-w-5xl">
        Horas de uso de Movimientos de proyecto, en el periodo de arriba. El cliente y la dimensión son los de la OT.
        La unidad de negocio es el departamento del grupo de recurso, en Cargar datos.
      </p>
      {cargando && <p className="mt-3 text-sm text-slate-500">Leyendo las horas… puede tardar un poco.</p>}
      {error && <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</p>}
      {datos?.aviso && <p className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">{datos.aviso}</p>}
      {!ficha.cargada && <p className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">Para ver la unidad de negocio, carga la tabla Recursos en Cargar datos.</p>}
      {ficha.cargada && !ficha.columna && <p className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">La tabla Recursos está cargada, pero no trae el grupo del recurso. Sin ese código no se puede saber el departamento.</p>}
      {datos && !cargando && (
        <>
          <div className="mt-4 p-3 border border-slate-200 rounded-lg bg-white">
            <p className="text-xs font-medium text-slate-500 mb-2">Filtros</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {[
                ["trabajador", "Trabajador", "Nombre o número"],
                ["unidad", "Unidad de negocio", "Departamento"],
                ["ot", "OT", "OT"],
                ["cliente", "Cliente", "Cliente"],
                ["dimension", "Dimensión OT", "Dimensión"],
              ].map(([campo, etiqueta, ph]) => (
                <label key={campo} className="text-xs text-slate-600">{etiqueta}
                  <input value={filtros[campo]} onChange={poner(campo)} placeholder={ph} className="mt-1 block w-full border rounded px-2 py-1 text-sm text-slate-800" />
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setFiltros(vacío)} className="mt-2 text-xs text-blue-700 underline">Quitar filtros</button>
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs font-medium text-slate-500">Hores</p>
              <p className="mt-1 text-2xl font-semibold text-slate-800 tabular-nums">{horasTxt(total)} h</p>
              <p className="mt-1 text-xs text-slate-400">
                {activas.length.toLocaleString("es-ES")} línies
                {activas.length !== filas.length ? ` de ${filas.length.toLocaleString("es-ES")}` : ""}
                {fuera.length > 0 ? ` · ${fuera.length.toLocaleString("es-ES")} excloses` : ""}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs font-medium text-slate-500">Cost de la mà d'obra</p>
              <p className="mt-1 text-2xl font-semibold text-slate-800 tabular-nums">{eurTxt(coste)}</p>
              <p className="mt-1 text-xs text-slate-400">hores × 21,50 €/h</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs font-medium text-slate-500">Cost d'oportunitat</p>
              <p className="mt-1 text-2xl font-semibold text-slate-800 tabular-nums">{eurTxt(oportunidad.total)}</p>
              <p className="mt-1 text-xs text-slate-400">preu de venda − 21,50 €/h</p>
              {oportunidad.detalle.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-slate-600">
                  {oportunidad.detalle.map((d) => (
                    <li key={d.nombre} className="flex justify-between gap-2">
                      <span className="truncate">{d.nombre}</span>
                      <span className="whitespace-nowrap tabular-nums">{eurTxt(d.importe)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {oportunidad.horasFuera > 0 && (
                <p className="mt-2 text-[11px] leading-snug text-slate-400">
                  {horasTxt(oportunidad.horasFuera)} h sense preu de venda (lloguer, maquinària, pràctiques o sense unitat).
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Barras titulo="Hores per unitat de negoci" partes={porUnidad} />
            <Barras titulo="Clients amb més hores" partes={porCliente} />
          </div>
          {fuera.length > 0 && (
            <div className="mt-3 p-3 border border-amber-200 rounded-lg bg-amber-50">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-amber-900">Excloses d'aquest anàlisi</p>
                <button type="button" onClick={() => setExcluidas([])} className="text-xs text-blue-700 underline">Tornar-les totes</button>
              </div>
              <ul className="mt-2 max-h-36 overflow-auto space-y-1">
                {fuera.map((f) => (
                  <li key={claveFila(f)} className="flex items-center justify-between gap-2 text-xs text-slate-700">
                    <span className="truncate">{f.nombre} · {f.ot || "—"} · {horasTxt(f.horas)} h</span>
                    <button type="button" onClick={() => restaurar(claveFila(f))} className="shrink-0 text-blue-700 underline">Tornar a incloure</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 overflow-auto max-h-[70vh] border border-slate-200 rounded-lg bg-white">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Trabajador</th>
                  <th className="px-3 py-2 font-medium">Unidad de negocio</th>
                  <th className="px-3 py-2 font-medium">OT</th>
                  <th className="px-3 py-2 font-medium">Cliente</th>
                  <th className="px-3 py-2 font-medium">Dimensión OT</th>
                  <th className="px-3 py-2 font-medium text-right">Horas</th>
                  <th className="px-2 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {activas.map((f) => (
                  <tr key={claveFila(f)} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-slate-800">{f.nombre} <span className="text-[10px] text-slate-400">{f.recurso}</span></td>
                    <td className="px-3 py-1.5 text-slate-700">{f.unidad || "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-800">{f.ot || "—"}</td>
                    <td className="px-3 py-1.5 text-slate-700">{f.cliente || "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-slate-700">{f.dimension || "—"}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-slate-800">{horasTxt(f.horas)}</td>
                    <td className="px-2 py-1.5">
                      <button type="button" onClick={() => excluir(f)} title="Excloure aquesta fila de l'anàlisi" aria-label="Excloure aquesta fila de l'anàlisi" className="text-slate-400 hover:text-red-600">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!activas.length && (
                  <tr><td colSpan={7} className="px-3 py-4 text-slate-400">No hay horas con estos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
