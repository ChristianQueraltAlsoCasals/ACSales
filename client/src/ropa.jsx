/**
 * ropa.jsx — Ropa de trabajo.
 * Maniquí con el uniforme del equipo, colgador (camiseta, pantalones,
 * jaqueta, sudadera y jersey) y stock por talla, guardado en este navegador.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, Search, Shirt, ShoppingCart, User } from "lucide-react";
import { ANOS, FECHA_STOCK, LINEAS, lineasDe, preciosDe, stockExcel, sumaAno, tallasDe } from "./ropaAnalisis";
import { comprasDe, FECHA_LISTADO } from "./ropaTrabajadores";
import ComparadorOfertas from "./comparadorOfertas";

const LS = "acsales_ropa_stock_v2";
const MINIMO_DEFECTO = 2;

const PRENDAS = [
  {
    id: "polo",
    nombre: "Camiseta manga corta",
    detalle: "Negra de manga corta, cuello redondo, dos bandas reflectantes y logos Also Casals y Solidari.",
    donde: "colgador",
    lugar: "Maniquí y colgador",
    img: "/ropa/camiseta-render.jpg",
    tallas: tallasDe("polo"),
  },
  {
    id: "pantalon",
    nombre: "Pantalones largos",
    detalle: "Negros, largos, con bolsillos cargo y el logo de Also Casals.",
    donde: "colgador",
    lugar: "Maniquí y colgador",
    img: "/ropa/pantalones-render.jpg",
    tallas: tallasDe("pantalon"),
  },
  {
    id: "jaqueta",
    nombre: "Jaqueta de alta visibilidad",
    detalle: "Polar amarillo flúor con cremallera, bajo y mangas azul marino y bandas reflectantes.",
    donde: "colgador",
    img: "/ropa/jaqueta-render-negra.jpg",
    tallas: tallasDe("jaqueta"),
  },
  {
    id: "sudadera",
    nombre: "Sudadera de alta visibilidad",
    detalle: "Amarillo flúor con media cremallera, bajo y mangas azul marino y bandas reflectantes.",
    donde: "colgador",
    img: "/ropa/sudadera-render-negra.jpg",
    tallas: tallasDe("sudadera"),
  },
  {
    id: "jersey",
    nombre: "Jersey manga larga",
    detalle: "Negra de manga larga, cuello redondo, dos bandas reflectantes y logos Also Casals y Solidari.",
    donde: "colgador",
    img: "/ropa/jersey-render.jpg",
    tallas: tallasDe("jersey"),
  },
  {
    id: "zapato",
    nombre: "Zapatos",
    detalle: "Zapato de seguridad Owens FO S1P, negro, con puntera, plantilla, talón amarillo y costuras amarillas.",
    donde: "colgador",
    img: "/ropa/zapatos-render.jpg",
    tallas: tallasDe("zapato"),
  },
];

const COLGADOR = PRENDAS.filter((p) => p.donde === "colgador");

const clave = (id, talla) => `${id}|${talla}`;

function cargarGuardado() {
  const unidades = stockExcel();
  const minimos = {};
  for (const p of PRENDAS) minimos[p.id] = MINIMO_DEFECTO;
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || "null");
    if (!raw || typeof raw !== "object") return { unidades, minimos };
    for (const k of Object.keys(unidades)) {
      const n = Number(raw.unidades?.[k]);
      if (Number.isFinite(n)) unidades[k] = Math.max(0, Math.round(n));
    }
    for (const p of PRENDAS) {
      const n = Number(raw.minimos?.[p.id]);
      if (Number.isFinite(n)) minimos[p.id] = Math.max(0, Math.round(n));
    }
  } catch { /* se queda el stock del Excel */ }
  return { unidades, minimos };
}

function campoFila(row, claves) {
  for (const k of claves) {
    if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  }
  const keys = Object.keys(row);
  for (const want of claves) {
    const hit = keys.find((k) => k.toLowerCase() === want.toLowerCase());
    if (hit && row[hit] != null && String(row[hit]).trim()) return String(row[hit]).trim();
  }
  return "";
}

function grupoFila(row) {
  const directo = campoFila(row, ["Resource_Group_No", "ResourceGroupNo", "Grupo_recurso", "grupo"]);
  if (directo) return directo;
  const k = Object.keys(row).find((x) => /resource_group/i.test(x));
  return k ? String(row[k] || "").trim() : "";
}

function esMaquina(tipo, grupo) {
  if (/machin|m[aá]quina|veh[ií]culo/i.test(String(tipo || ""))) return true;
  const g = String(grupo || "").trim().toUpperCase();
  return g === "ALQ" || g === "MAQ" || g.startsWith("ALQ") || g.startsWith("MAQ");
}

/** Personas de la tabla de recursos (ficha Resource de BC). Sin máquinas ni vehículos. */
export function trabajadoresDe(filas) {
  const vistos = new Set();
  const out = [];
  for (const row of filas || []) {
    if (!row || typeof row !== "object") continue;
    const no = campoFila(row, ["No", "No_", "Nº", "no", "number"]);
    const nombre = campoFila(row, ["Name", "Nombre", "nombre", "displayName"]);
    if (!no || !nombre) continue;
    if (esMaquina(campoFila(row, ["Type", "Tipo", "tipo"]), grupoFila(row))) continue;
    const id = no.toUpperCase();
    if (vistos.has(id)) continue;
    vistos.add(id);
    out.push({ no, nombre });
  }
  out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return out;
}

function estadoTalla(uds, minimo) {
  if (uds <= 0) return { txt: "Sin stock", cls: "text-slate-500 bg-slate-100" };
  if (uds <= minimo) return { txt: "Bajo mínimo", cls: "text-amber-800 bg-amber-100" };
  return { txt: "En stock", cls: "text-emerald-800 bg-emerald-100" };
}

export default function Ropa({ recursos = [] }) {
  const [guardado, setGuardado] = useState(cargarGuardado);
  const [filtro, setFiltro] = useState("");
  const [busca, setBusca] = useState("");
  const [tallaElegida, setTallaElegida] = useState({});
  const [avisoTalla, setAvisoTalla] = useState({});
  const [carrito, setCarrito] = useState([]);
  const [verPreparacion, setVerPreparacion] = useState(false);
  const [remotos, setRemotos] = useState([]);
  const [cargandoTrab, setCargandoTrab] = useState(false);
  const [trabajador, setTrabajador] = useState("");
  const [avisoTrabajador, setAvisoTrabajador] = useState(false);
  const [stockAbierto, setStockAbierto] = useState(true);
  const [puesto, setPuesto] = useState({ polo: false, pantalon: false });
  const stockRef = useRef(null);
  const trabajadorRef = useRef(null);
  const deTabla = useMemo(() => trabajadoresDe(recursos), [recursos]);

  useEffect(() => {
    if (deTabla.length) return undefined;
    let vivo = true;
    setCargandoTrab(true);
    fetch("/api/recepcion/recursos")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "recursos");
        if (vivo) setRemotos(Array.isArray(j.recursos) ? j.recursos : []);
      })
      .catch(() => { if (vivo) setRemotos([]); })
      .finally(() => { if (vivo) setCargandoTrab(false); });
    return () => { vivo = false; };
  }, [deTabla.length]);

  const trabajadores = deTabla.length ? deTabla : trabajadoresDe(remotos);
  const elegido = trabajadores.find((t) => t.no === trabajador) || null;

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(guardado)); } catch { /* el listado sigue en pantalla */ }
  }, [guardado]);

  const poner = (id, talla, valor) => {
    const n = Math.max(0, Math.round(Number(valor) || 0));
    setGuardado((g) => ({ ...g, unidades: { ...g.unidades, [clave(id, talla)]: n } }));
  };

  const ponerMinimo = (id, valor) => {
    const n = Math.max(0, Math.round(Number(valor) || 0));
    setGuardado((g) => ({ ...g, minimos: { ...g.minimos, [id]: n } }));
  };

  const anadirAlCarrito = (p) => {
    const talla = tallaElegida[p.id];
    if (!elegido) {
      setAvisoTrabajador(true);
      trabajadorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!talla) {
      setAvisoTalla((a) => ({ ...a, [p.id]: true }));
      return;
    }
    setAvisoTrabajador(false);
    setAvisoTalla((a) => ({ ...a, [p.id]: false }));
    setCarrito((prev) => {
      const i = prev.findIndex((l) => l.id === p.id && l.talla === talla && l.recurso === elegido.no);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], uds: next[i].uds + 1 };
        return next;
      }
      return [...prev, { id: p.id, nombre: p.nombre, talla, uds: 1, recurso: elegido.no, trabajador: elegido.nombre }];
    });
  };

  const quitarDelCarrito = (id, talla, recurso) => {
    setCarrito((prev) => {
      const next = prev.filter((l) => !(l.id === id && l.talla === talla && l.recurso === recurso));
      if (!next.length) setVerPreparacion(false);
      return next;
    });
  };

  const elegir = (id) => {
    setFiltro((actual) => (actual === id ? "" : id));
    setBusca("");
    setStockAbierto(true);
    requestAnimationFrame(() => {
      stockRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const resumen = useMemo(() => {
    let unidades = 0;
    let sinStock = 0;
    let bajo = 0;
    for (const p of PRENDAS) {
      const min = guardado.minimos[p.id] ?? MINIMO_DEFECTO;
      for (const t of p.tallas) {
        const u = guardado.unidades[clave(p.id, t)] || 0;
        unidades += u;
        if (u <= 0) sinStock += 1;
        else if (u <= min) bajo += 1;
      }
    }
    return { unidades, sinStock, bajo, prendas: PRENDAS.length };
  }, [guardado]);

  const q = busca.trim().toLowerCase();
  const visibles = PRENDAS.filter((p) => {
    if (filtro && p.id !== filtro) return false;
    if (!q) return true;
    return `${p.nombre} ${p.detalle}`.toLowerCase().includes(q);
  });

  const totalPrenda = (p) => p.tallas.reduce((a, t) => a + (guardado.unidades[clave(p.id, t)] || 0), 0);

  const vestir = (id) => {
    setPuesto((p) => ({ ...p, [id]: !p[id] }));
  };

  const figura = puesto.polo && puesto.pantalon
    ? { src: "/ropa/maniqui-render.jpg", alt: "Maniquí vestido con la camiseta y los pantalones", titulo: "Uniforme de trabajo" }
    : puesto.polo
      ? { src: "/ropa/maniqui-camiseta.jpg", alt: "Maniquí con la camiseta de manga corta", titulo: "Camiseta manga corta" }
      : puesto.pantalon
        ? { src: "/ropa/maniqui-pantalones.jpg", alt: "Maniquí con los pantalones largos", titulo: "Pantalones largos" }
        : { src: "/ropa/maniqui-desnudo.jpg", alt: "Maniquí sin vestir", titulo: "Sin vestir" };

  const chip = (id, nombre) => {
    const activo = puesto[id];
    return (
      <button
        key={id}
        type="button"
        onClick={() => vestir(id)}
        aria-pressed={activo}
        className={`text-left rounded-lg border px-3 py-2 text-sm transition-colors ${activo ? "border-[#1e3358] bg-[#1e3358] text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
      >
        <span className="block font-semibold leading-tight">{nombre}</span>
        <span className={`block text-xs mt-0.5 ${activo ? "text-white/80" : "text-slate-500"}`}>
          {activo ? "Puesto" : "Poner"} · {totalPrenda(PRENDAS.find((p) => p.id === id))} uds
        </span>
      </button>
    );
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Shirt size={22} className="text-[#1e3358]" />
        <h1 className="bc-page-title">Ropa</h1>
      </div>
      <p className="bc-page-sub">
        Uniforme de trabajo de Also Casals. El maniquí empieza sin ropa: pulsa una prenda para vestirlo.
        El stock parte del recuento del {FECHA_STOCK}. Al elegir un trabajador verás la ropa que ha recogido.
      </p>

      <div ref={trabajadorRef} className="mt-4 bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm max-w-xl scroll-mt-4">
        <label htmlFor="trabajador-ropa" className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] uppercase text-slate-400">
          <User size={14} /> Trabajador
        </label>
        <select
          id="trabajador-ropa"
          value={trabajador}
          onChange={(e) => {
            setTrabajador(e.target.value);
            if (e.target.value) setAvisoTrabajador(false);
          }}
          className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white"
        >
          <option value="">{cargandoTrab && trabajadores.length === 0 ? "Cargando trabajadores…" : "Elige un trabajador"}</option>
          {trabajadores.map((t) => (
            <option key={t.no} value={t.no}>{t.nombre}</option>
          ))}
        </select>
        <p className="text-xs text-slate-500 mt-1">De la tabla de recursos.</p>
        {avisoTrabajador && <div className="text-xs text-amber-700 mt-1">Elige un trabajador.</div>}
        {!cargandoTrab && trabajadores.length === 0 && (
          <div className="text-xs text-amber-700 mt-1">No hay trabajadores en la tabla de recursos.</div>
        )}
      </div>

      {elegido && <RopaDelTrabajador nombre={elegido.nombre} />}

      <div className="bc-cue-row">
        <div className="bc-cue">
          <div className="bc-cue-valor">{resumen.prendas}</div>
          <div className="bc-cue-label">Prendas</div>
        </div>
        <div className="bc-cue">
          <div className="bc-cue-valor">{resumen.unidades}</div>
          <div className="bc-cue-label">Unidades en stock</div>
        </div>
        <div className="bc-cue">
          <div className="bc-cue-valor">{resumen.sinStock}</div>
          <div className="bc-cue-label">Tallas sin stock</div>
        </div>
        <div className="bc-cue">
          <div className="bc-cue-valor">{resumen.bajo}</div>
          <div className="bc-cue-label">Tallas bajo mínimo</div>
        </div>
      </div>

      <section className="mt-5 grid grid-cols-1 xl:grid-cols-[minmax(280px,400px)_1fr] gap-4 items-start">
        <article className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-slate-400">Maniquí</div>
            <div className="font-semibold text-slate-800">{figura.titulo}</div>
          </div>
          <div className="bg-[#e8e8ea]">
            <img
              src={figura.src}
              alt={figura.alt}
              className="w-full h-[540px] object-contain object-bottom"
            />
          </div>
          <div className="p-3 grid grid-cols-2 gap-2">
            {chip("polo", "Camiseta manga corta")}
            {chip("pantalon", "Pantalones largos")}
          </div>
        </article>

        <article className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-slate-400">Colgador</div>
            <div className="font-semibold text-slate-800">Camiseta, pantalones, alta visibilidad y zapatos</div>
          </div>
          <div className="relative bg-[#e8e8ea] px-3 pt-7 pb-4">
            <div
              className="pointer-events-none absolute left-8 right-8 top-4 h-2 rounded-full"
              style={{ background: "linear-gradient(#f4f5f7, #9aa0a8 42%, #f8fafc 58%, #6b7280)", boxShadow: "0 2px 3px rgba(15,23,42,.18)" }}
              aria-hidden
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {COLGADOR.map((p) => {
                const activo = filtro === p.id;
                const talla = tallaElegida[p.id] || "";
                return (
                  <div
                    key={p.id}
                    className={`text-left rounded-xl bg-[#e8e8ea] overflow-hidden border-2 transition-colors ${activo ? "border-[#1e3358]" : "border-transparent"}`}
                  >
                    <button type="button" onClick={() => elegir(p.id)} className="block w-full">
                      <img src={p.img} alt={p.nombre} className="w-full h-[340px] object-contain object-top" />
                    </button>
                    <div className="px-3 py-2 bg-white text-slate-800">
                      <div className="text-sm font-semibold leading-tight">{p.nombre}</div>
                      <div className="text-xs mt-0.5 text-slate-500">{totalPrenda(p)} uds en stock</div>
                      <div className="mt-2 flex border border-slate-900">
                        <label className="sr-only" htmlFor={`talla-${p.id}`}>Talla de {p.nombre}</label>
                        <select
                          id={`talla-${p.id}`}
                          value={talla}
                          onChange={(e) => {
                            const v = e.target.value;
                            setTallaElegida((t) => ({ ...t, [p.id]: v }));
                            if (v) setAvisoTalla((a) => ({ ...a, [p.id]: false }));
                          }}
                          className="flex-1 min-w-0 bg-white text-sm px-2 py-1.5 outline-none"
                        >
                          <option value="">Talla</option>
                          {p.tallas.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => anadirAlCarrito(p)}
                          className="shrink-0 bg-slate-900 text-white text-sm font-semibold px-3 py-1.5 inline-flex items-center gap-1.5"
                        >
                          <ShoppingCart size={14} /> Añadir
                        </button>
                      </div>
                      {avisoTalla[p.id] && (
                        <div className="text-xs text-amber-700 mt-1">Elige una talla.</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {carrito.length > 0 && (
            <div className="border-t border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <ShoppingCart size={16} /> Carrito
                  <span className="text-slate-500 font-normal">{carrito.reduce((a, l) => a + l.uds, 0)} uds</span>
                </div>
                <button
                  type="button"
                  onClick={() => setVerPreparacion(true)}
                  className="text-sm font-semibold text-white bg-[#1e3358] rounded-md px-3 py-1.5"
                >
                  Preparar ropa
                </button>
              </div>
              <ul className="mt-2 space-y-1">
                {carrito.map((l) => (
                  <li key={`${l.recurso}-${l.id}-${l.talla}`} className="flex items-center justify-between gap-3 text-sm">
                    <span>{l.trabajador} · {l.nombre} · talla {l.talla} · {l.uds}</span>
                    <button type="button" onClick={() => quitarDelCarrito(l.id, l.talla, l.recurso)} className="text-xs font-semibold text-slate-500 hover:text-slate-800">Quitar</button>
                  </li>
                ))}
              </ul>
              {verPreparacion && <Preparacion lineas={carrito} stock={guardado.unidades} minimos={guardado.minimos} />}
            </div>
          )}
        </article>
      </section>

      <PedidosAno ids={visibles.map((p) => p.id)} />

      <section ref={stockRef} className="mt-6 scroll-mt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <button
            type="button"
            onClick={() => setStockAbierto((v) => !v)}
            aria-expanded={stockAbierto}
            className="flex items-start gap-2 text-left"
          >
            <ChevronDown size={18} className={`mt-1 shrink-0 text-slate-500 transition-transform ${stockAbierto ? "" : "-rotate-90"}`} />
            <span>
              <h2 className="text-lg font-bold text-slate-800">Stock de ropa</h2>
              <p className="text-xs text-slate-500 mt-0.5 max-w-xl">
                Unidades a {FECHA_STOCK}, por talla. Si cambias una cifra, se guarda en este navegador. El mínimo avisa cuando queda poca ropa de esa prenda.
              </p>
            </span>
          </button>
          {stockAbierto && <div className="flex items-center gap-2">
            {filtro && (
              <button type="button" onClick={() => setFiltro("")} className="text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md px-3 py-1.5">
                Ver todas
              </button>
            )}
            <label className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={busca}
                onChange={(e) => { setBusca(e.target.value); setFiltro(""); }}
                placeholder="Buscar prenda"
                className="border border-slate-300 rounded-md pl-8 pr-3 py-1.5 text-sm w-52"
              />
            </label>
          </div>}
        </div>

        {stockAbierto && <div className="mt-3 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-4 py-2 font-semibold w-[42%]">Prenda</th>
                <th className="px-3 py-2 font-semibold">Talla</th>
                <th className="px-3 py-2 font-semibold">Unidades</th>
                <th className="px-4 py-2 font-semibold">Estado</th>
              </tr>
            </thead>
            {visibles.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-slate-500">Ninguna prenda coincide con la búsqueda.</td>
                </tr>
              </tbody>
            )}
            {visibles.map((p) => {
              const min = guardado.minimos[p.id] ?? MINIMO_DEFECTO;
              return (
                <tbody key={p.id}>
                  <tr className="bg-slate-50 border-t border-slate-200">
                    <td className="px-4 py-3" colSpan={2}>
                      <div className="font-semibold text-slate-800">{p.nombre}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{p.detalle}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="font-semibold tabular-nums text-slate-800">{totalPrenda(p)} uds</div>
                      <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                        Mínimo
                        <input
                          type="number"
                          min="0"
                          value={min}
                          onChange={(e) => ponerMinimo(p.id, e.target.value)}
                          className="w-14 border border-slate-300 rounded px-1.5 py-0.5 text-sm text-slate-800"
                          aria-label={`Mínimo de ${p.nombre}`}
                        />
                      </label>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 align-top">
                      {p.lugar || "En el colgador"}
                    </td>
                  </tr>
                  {p.tallas.map((t) => {
                    const u = guardado.unidades[clave(p.id, t)] || 0;
                    const est = estadoTalla(u, min);
                    return (
                      <tr key={t} className="border-t border-slate-100">
                        <td className="px-4 py-1.5 text-slate-400">{p.nombre}</td>
                        <td className="px-3 py-1.5 font-medium text-slate-700">{t}</td>
                        <td className="px-3 py-1.5">
                          <div className="inline-flex items-center border border-slate-300 rounded-md overflow-hidden">
                            <button type="button" onClick={() => poner(p.id, t, u - 1)} className="px-2 py-1 text-slate-600 hover:bg-slate-100" aria-label={`Quitar una unidad de ${p.nombre} talla ${t}`}>
                              <Minus size={14} />
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={u}
                              onChange={(e) => poner(p.id, t, e.target.value)}
                              className="w-14 text-center py-1 text-sm tabular-nums border-x border-slate-300 outline-none"
                              aria-label={`Unidades de ${p.nombre} talla ${t}`}
                            />
                            <button type="button" onClick={() => poner(p.id, t, u + 1)} className="px-2 py-1 text-slate-600 hover:bg-slate-100" aria-label={`Añadir una unidad de ${p.nombre} talla ${t}`}>
                              <Plus size={14} />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-1.5">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${est.cls}`}>{est.txt}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>}
      </section>

      <ComparadorOfertas />
    </div>
  );
}

function Preparacion({ lineas, stock, minimos }) {
  const grupos = [];
  for (const l of lineas) {
    let g = grupos.find((x) => x.recurso === l.recurso);
    if (!g) {
      g = { recurso: l.recurso, nombre: l.trabajador, historial: comprasDe(l.trabajador), filas: [] };
      grupos.push(g);
    }
    const u = stock[clave(l.id, l.talla)] || 0;
    const min = minimos[l.id] ?? MINIMO_DEFECTO;
    const previas = g.historial.filter((h) => h.prenda === l.nombre);
    g.filas.push({ ...l, stock: u, min, previas });
  }

  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <h3 className="text-sm font-bold text-slate-800">Preparación</h3>
      <p className="text-xs text-slate-500 mt-0.5">
        Cruza el carrito con el recurso, el stock de esta pantalla y la ropa que ya consta de esa persona, hasta el {FECHA_LISTADO}. No resta stock ni crea un pedido.
      </p>
      <div className="mt-2 space-y-3">
        {grupos.map((g) => (
          <div key={g.recurso} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-sm font-semibold text-slate-800">{g.nombre}</div>
            <div className="text-xs text-slate-500">Recurso {g.recurso}</div>
            <ul className="mt-2 space-y-2">
              {g.filas.map((f) => {
                const misma = f.previas.filter((h) => h.talla === f.talla);
                const alcanza = f.stock >= f.uds;
                return (
                  <li key={`${f.id}-${f.talla}`} className="text-sm text-slate-700">
                    <div className="font-medium">{f.nombre} · talla {f.talla} · {f.uds}</div>
                    <div className={`text-xs mt-0.5 ${alcanza ? "text-emerald-800" : "text-red-700"}`}>
                      {alcanza ? `Hay stock: ${f.stock}` : `No alcanza: hay ${f.stock} y pides ${f.uds}`}
                      {f.stock <= f.min ? ` · en el mínimo (${f.min})` : ""}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {f.previas.length === 0
                        ? "No consta esta prenda para este trabajador."
                        : misma.length
                          ? `Ya tiene ${f.nombre} talla ${f.talla}: ${misma.map((h) => `${fechaCorta(h.fecha)}, ${h.uds} ${h.estado === "Recollida" ? "recogida" : h.estado === "Pendent" ? "pendiente" : "rechazada"}`).join("; ")}.`
                          : `Ya tiene ${f.nombre}, en otra talla: ${f.previas.map((h) => `${h.talla || "sin talla"} el ${fechaCorta(h.fecha)}`).join("; ")}.`}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function fechaCorta(iso) {
  if (!iso) return "Sin fecha";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const ESTADO_ROPA = {
  Recollida: { txt: "Recogida", cls: "text-emerald-800 bg-emerald-100" },
  Pendent: { txt: "Pendiente", cls: "text-amber-800 bg-amber-100" },
  Refusada: { txt: "Rechazada", cls: "text-slate-600 bg-slate-100" },
};

function RopaDelTrabajador({ nombre }) {
  const lineas = [...comprasDe(nombre)].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  const recogidas = lineas.filter((l) => l.estado === "Recollida").reduce((a, l) => a + l.uds, 0);

  return (
    <section className="mt-4">
      <h2 className="text-lg font-bold text-slate-800">Ropa de {nombre}</h2>
      <p className="text-xs text-slate-500 mt-0.5">
        Lo que consta como comprado para este trabajador, hasta el {FECHA_LISTADO}.
      </p>
      {lineas.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No hay ropa registrada para {nombre}.</p>
      ) : (
        <div className="mt-3 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-2 text-sm text-slate-600 border-b border-slate-100">
            {recogidas} unidades recogidas
          </div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="px-4 py-2 font-semibold">Fecha</th>
                  <th className="px-3 py-2 font-semibold">Ropa</th>
                  <th className="px-3 py-2 font-semibold">Talla</th>
                  <th className="px-3 py-2 font-semibold text-right">Uds</th>
                  <th className="px-4 py-2 font-semibold">Estado</th>
                </tr>
              </thead>
              <tbody>
                {lineas.map((l, i) => {
                  const est = ESTADO_ROPA[l.estado] || { txt: l.estado || "—", cls: "text-slate-600 bg-slate-100" };
                  return (
                    <tr key={`${l.fecha}-${l.codigo}-${i}`} className="border-t border-slate-100">
                      <td className="px-4 py-1.5 whitespace-nowrap text-slate-600">{fechaCorta(l.fecha)}</td>
                      <td className="px-3 py-1.5 text-slate-800">{l.prenda}</td>
                      <td className="px-3 py-1.5 text-slate-700">{l.talla || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">{l.uds}</td>
                      <td className="px-4 py-1.5">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${est.cls}`}>{est.txt}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function celda(n) {
  return n > 0 ? n : "—";
}

function euros(n) {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function PrecioAno({ id, ano }) {
  const lista = preciosDe(id, ano);
  if (!lista.length) return null;
  return (
    <div className="mt-0.5 font-normal text-[11px] leading-tight text-slate-500">
      {lista.map((p, i) => (
        <div key={i}>
          {euros(p.total)}
          {p.detalle ? <span className="block text-[10px]">{p.detalle}</span> : null}
        </div>
      ))}
    </div>
  );
}

function PedidosAno({ ids }) {
  const [abierto, setAbierto] = useState(true);
  const prendas = PRENDAS.filter((p) => ids.includes(p.id));
  const lineas = LINEAS.filter((l) => ids.includes(l.id));
  if (prendas.length === 0) return null;
  const totalPedido = lineas.reduce((a, l) => a + l.pedido, 0);
  const totalStock = lineas.reduce((a, l) => a + l.stock, 0);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex items-start gap-2 text-left"
      >
        <ChevronDown size={18} className={`mt-1 shrink-0 text-slate-500 transition-transform ${abierto ? "" : "-rotate-90"}`} />
        <span>
          <h2 className="text-lg font-bold text-slate-800">Pedidos año a año</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            Unidades pedidas a Fervalls, Herraiz y Serigrafix, de 2022 a 2026. Debajo, el precio unitario de ese año. Si hay dos cifras, la segunda es el logo. El stock es el recuento del {FECHA_STOCK}.
          </p>
        </span>
      </button>
      {abierto && <div className="mt-3 bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-2 font-semibold">Prenda</th>
              <th className="px-3 py-2 font-semibold">Talla</th>
              {ANOS.map((a) => (
                <th key={a} className="px-3 py-2 font-semibold text-right">{a}</th>
              ))}
              <th className="px-3 py-2 font-semibold text-right">Pedido</th>
              <th className="px-4 py-2 font-semibold text-right">Stock {FECHA_STOCK}</th>
            </tr>
          </thead>
          {prendas.map((p) => {
            const ls = lineasDe(p.id);
            return (
              <tbody key={p.id}>
                <tr className="bg-slate-50 border-t border-slate-200">
                  <td className="px-4 py-2 font-semibold text-slate-800" colSpan={2}>{p.nombre}</td>
                  {ANOS.map((a) => (
                    <td key={a} className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800 align-top">
                      {celda(sumaAno(ls, a))}
                      <PrecioAno id={p.id} ano={a} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">{ls.reduce((n, l) => n + l.pedido, 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">{ls.reduce((n, l) => n + l.stock, 0)}</td>
                </tr>
                {ls.map((l) => (
                  <tr key={l.talla} className="border-t border-slate-100">
                    <td className="px-4 py-1.5 text-slate-400">
                      {p.nombre}
                      {l.ref ? <span className="block text-[11px]">{l.ref}</span> : null}
                    </td>
                    <td className="px-3 py-1.5 font-medium text-slate-700">{l.talla}</td>
                    {ANOS.map((a) => (
                      <td key={a} className="px-3 py-1.5 text-right tabular-nums text-slate-700">{celda(l.anos[a] || 0)}</td>
                    ))}
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">{l.pedido}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">{l.stock}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-white">
              <td className="px-4 py-2 font-semibold text-slate-800" colSpan={2}>Total</td>
              {ANOS.map((a) => (
                <td key={a} className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{sumaAno(lineas, a)}</td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{totalPedido}</td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-900">{totalStock}</td>
            </tr>
          </tfoot>
        </table>
      </div>}
    </section>
  );
}
