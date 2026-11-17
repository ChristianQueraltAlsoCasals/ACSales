/**
 * Comparador de ofertas. Maria adjunta los PDF de los proveedores
 * y la tabla marca el precio unitario más bajo de cada concepto.
 */
import React, { useMemo, useRef, useState } from "react";
import { FileText, Scale, Upload, X } from "lucide-react";

const eur = (n) => (n == null || !Number.isFinite(n)
  ? "—"
  : n.toLocaleString("es-ES", { style: "currency", currency: "EUR" }));

function archivoABase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("No se pudo leer el archivo"));
    r.readAsDataURL(file);
  });
}

export function ResultadoOfertas({ resultado }) {
  const ofertas = resultado?.ofertas || [];
  const filas = resultado?.filas || [];
  const proveedores = useMemo(() => {
    const vistos = [];
    for (const o of ofertas) if (o.proveedor && !vistos.includes(o.proveedor)) vistos.push(o.proveedor);
    for (const f of filas) for (const p of f.precios) if (!vistos.includes(p.proveedor)) vistos.push(p.proveedor);
    return vistos;
  }, [ofertas, filas]);

  const resumen = useMemo(() => {
    const comparables = filas.filter((f) => new Set(f.precios.map((p) => p.proveedor)).size >= 2);
    const victorias = {};
    for (const f of comparables) {
      if (f.mejores.length !== 1) continue;
      victorias[f.mejores[0]] = (victorias[f.mejores[0]] || 0) + 1;
    }
    const ganador = Object.entries(victorias).sort((a, b) => b[1] - a[1])[0];
    return { comparables: comparables.length, ganador };
  }, [filas]);

  if (!ofertas.length) return null;

  return (
    <div className="mt-5 space-y-4">
      {(resultado.avisos || []).length > 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {resultado.avisos.map((a) => <div key={a}>{a}</div>)}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {ofertas.map((o) => (
          <div key={o.archivo || o.proveedor} className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
            <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-slate-400">Proveedor</div>
            <div className="font-semibold text-slate-800">{o.proveedor}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {o.lineas?.length || 0} líneas
              {o.referencia ? ` · ${o.referencia}` : ""}
              {o.fecha ? ` · ${o.fecha}` : ""}
            </div>
          </div>
        ))}
      </div>

      {resumen.comparables > 0 && (
        <p className="text-sm text-slate-700">
          {resumen.ganador
            ? `${resumen.ganador[0]} tiene el precio más bajo en ${resumen.ganador[1]} de ${resumen.comparables} conceptos comparables.`
            : `${resumen.comparables} conceptos se pueden comparar. En varios hay empate.`}
          {" "}El verde es el precio unitario sin IVA, ya con el descuento de la oferta.
        </p>
      )}
      {filas.length > 0 && resumen.comparables === 0 && (
        <p className="text-sm text-slate-600">Cada concepto sale en una sola oferta. Adjunta el PDF de otro proveedor para ver quién es más barato.</p>
      )}

      {filas.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-4 py-2 font-semibold">Concepto</th>
                <th className="px-3 py-2 font-semibold">Talla</th>
                {proveedores.map((p) => (
                  <th key={p} className="px-3 py-2 font-semibold text-right">{p}</th>
                ))}
                <th className="px-4 py-2 font-semibold">Mejor precio</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={`${f.clave}|${f.talla}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-800">{f.concepto}</td>
                  <td className="px-3 py-2 text-slate-600">{f.talla || "—"}</td>
                  {proveedores.map((p) => {
                    const precio = f.precios.find((x) => x.proveedor === p);
                    const gana = precio && f.mejores.includes(p) && f.precios.length > 1;
                    return (
                      <td key={p} className={`px-3 py-2 text-right tabular-nums ${gana ? "bg-emerald-100 font-semibold text-emerald-900" : "text-slate-700"}`}>
                        {precio ? eur(precio.precio) : "—"}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-slate-800">
                    {f.precios.length > 1 ? f.mejores.join(" · ") : "Solo una oferta"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filas.length === 0 && (
        <p className="text-sm text-slate-600">No he encontrado precios unitarios en esos PDF. Prueba con el presupuesto donde se vea la tabla de artículos.</p>
      )}
    </div>
  );
}

export default function ComparadorOfertas() {
  const [archivos, setArchivos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const anadir = (lista) => {
    const pdfs = [...lista].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) {
      setError("Adjunta archivos PDF.");
      return;
    }
    setError("");
    setResultado(null);
    setArchivos((prev) => {
      const nombres = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...pdfs.filter((f) => !nombres.has(f.name + f.size))].slice(0, 12);
    });
  };

  const comparar = async () => {
    if (!archivos.length || cargando) return;
    setCargando(true);
    setError("");
    setResultado(null);
    try {
      const payload = [];
      for (const f of archivos) payload.push({ nombre: f.name, base64: await archivoABase64(f) });
      const r = await fetch("/api/ofertas/comparar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archivos: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      setResultado(j);
    } catch (e) {
      setError(String(e.message || e));
    }
    setCargando(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Scale size={22} className="text-[#1e3358]" />
        <h1 className="bc-page-title">Comparador de ofertas</h1>
      </div>
      <p className="bc-page-sub">
        Adjunta el PDF de cada proveedor. Se comparan los precios unitarios sin IVA y se marca el más bajo de cada concepto.
      </p>

      <div
        className="mt-4 border-2 border-dashed border-slate-300 rounded-xl bg-white px-4 py-8 text-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); anadir(e.dataTransfer.files); }}
      >
        <Upload size={22} className="mx-auto text-slate-400" />
        <p className="mt-2 text-sm text-slate-700">Suelta aquí los PDF de las ofertas</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 text-sm font-semibold text-white bg-[#1e3358] rounded-md px-3 py-1.5"
        >
          Elegir PDF
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => { anadir(e.target.files); e.target.value = ""; }}
        />
      </div>

      {archivos.length > 0 && (
        <ul className="mt-3 space-y-1">
          {archivos.map((f) => (
            <li key={f.name + f.size} className="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-2 min-w-0">
                <FileText size={14} className="text-slate-400 shrink-0" />
                <span className="truncate">{f.name}</span>
              </span>
              <button
                type="button"
                onClick={() => { setArchivos((prev) => prev.filter((x) => x !== f)); setResultado(null); }}
                className="text-slate-400 hover:text-slate-700"
                aria-label={`Quitar ${f.name}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={!archivos.length || cargando}
          onClick={comparar}
          className="text-sm font-semibold text-white bg-slate-900 rounded-md px-4 py-2 disabled:opacity-40"
        >
          {cargando ? "Leyendo las ofertas…" : "Comparar"}
        </button>
        {error && <span className="text-sm text-red-700">{error}</span>}
      </div>

      <ResultadoOfertas resultado={resultado} />
    </div>
  );
}
