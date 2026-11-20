/**
 * Comparador de ofertas. Maria adjunta los PDF de los proveedores
 * y la tabla marca el precio unitario más bajo de cada concepto.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Scale, Upload, X } from "lucide-react";
import { urlPublic } from "./api";

const LOGOS_PROVEEDOR = [
  { re: /sinele[ck]/i, src: "logos/proveedores/sinelec.png?v=2" },
  { re: /sonepar/i, src: "logos/proveedores/sonepar.png" },
  { re: /araiz/i, src: "logos/proveedores/araiz.png" },
  { re: /saltoki/i, src: "logos/proveedores/saltoki.png" },
  { re: /serigraf|luna azara/i, src: "logos/proveedores/serigrafix.png" },
  { re: /herraiz/i, src: "logos/proveedores/herraiz.png" },
  { re: /chopo|vestim de treball|\bvdt\b/i, src: "logos/proveedores/vdt.png" },
  { re: /also\s*casals|alsocasals/i, src: "logos/also.png" },
  { re: /ferros/i, src: "logos/ferrosca.png" },
];

function logoProveedor(nombre) {
  return LOGOS_PROVEEDOR.find((l) => l.re.test(nombre || "")) || null;
}

function LogoProveedor({ nombre, alto = 28 }) {
  const logo = logoProveedor(nombre);
  if (!logo) {
    const ini = String(nombre || "?")
      .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase() || "?";
    return (
      <span
        className="inline-flex items-center justify-center rounded-md bg-slate-100 text-slate-600 font-bold shrink-0"
        style={{ height: alto, minWidth: alto, padding: "0 6px", fontSize: 11 }}
      >
        {ini}
      </span>
    );
  }
  return (
    <img
      src={urlPublic(logo.src)}
      alt=""
      style={{ height: alto }}
      className="w-auto max-w-[128px] object-contain object-left shrink-0"
    />
  );
}

function BuscadorPr({ onElegir, onCancelar }) {
  const campo = useRef(null);
  const [q, setQ] = useState("");
  const [res, setRes] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [caja, setCaja] = useState(null);
  const colocar = () => {
    const r = campo.current?.getBoundingClientRect();
    if (r) setCaja({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 336) });
  };
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const d = await (await fetch(`/api/bc/articulos?q=${encodeURIComponent(q.trim())}`)).json();
        setRes(d.articulos || []);
      } catch { setRes([]); }
      setBuscando(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { colocar(); }, [q, res, buscando]);
  return (
    <div className="min-w-[11rem]">
      <input
        ref={campo}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="PR o descripción"
        className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
      />
      <button type="button" onClick={onCancelar} className="mt-1 text-[11px] text-slate-500 hover:text-slate-800">Cancelar</button>
      {caja && (buscando || q.trim().length >= 2) && (
        <div className="fixed z-[70] w-80 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg" style={{ top: caja.top, left: caja.left }}>
          {buscando && <div className="px-2 py-1.5 text-xs text-slate-400">Buscando…</div>}
          {!buscando && res.length === 0 && <div className="px-2 py-1.5 text-xs text-slate-400">Sin resultados</div>}
          {res.map((a) => (
            <button
              key={a.numero}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onElegir(a)}
              className="block w-full text-left px-2 py-1.5 hover:bg-slate-50"
            >
              <span className="font-mono text-xs text-slate-800">{a.numero}</span>
              <span className="block text-[11px] text-slate-500">{a.descripcion}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CeldaArticulo({ articulo, onAsignar }) {
  const [editando, setEditando] = useState(false);
  const elegir = (a) => {
    setEditando(false);
    onAsignar({ codigo: a.numero, descripcion: a.descripcion || "", confianza: "manual" });
  };
  return (
    <div className="min-w-[9.5rem] max-w-[16rem]">
      {articulo?.codigo && (
        <>
          <div className="font-mono text-xs font-semibold text-slate-900">{articulo.codigo}</div>
          {articulo.descripcion && (
            <div className="text-[11px] text-slate-500 leading-snug" title={articulo.descripcion}>{articulo.descripcion}</div>
          )}
          {articulo.confianza === "manual" && <div className="text-[10px] text-slate-500 mt-0.5">Puesto a mano</div>}
          {articulo.confianza === "media" && (
            <div className="text-[10px] text-amber-700 mt-0.5">
              {articulo.motivo === "formato" ? "Parecido: el formato no coincide" : "Parecido: no es la misma marca"}
            </div>
          )}
          {articulo.bloqueado && <div className="text-[10px] text-slate-500 mt-0.5">Bloqueado en Business Central</div>}
        </>
      )}
      {!articulo?.codigo && articulo?.alternativas?.length > 0 && !editando && (
        <div className="mb-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Varios posibles</div>
          {articulo.alternativas.map((a) => (
            <button key={a.codigo} type="button" onClick={() => onAsignar({ codigo: a.codigo, descripcion: a.descripcion || "", confianza: "manual" })} className="block text-left mt-1">
              <span className="font-mono text-[11px] font-semibold text-slate-800">{a.codigo}</span>
              <span className="block text-[11px] text-slate-500">{a.descripcion}</span>
            </button>
          ))}
        </div>
      )}
      {!articulo?.codigo && !editando && (
        <button type="button" onClick={() => setEditando(true)} className="text-xs font-semibold text-[#1e3358] hover:underline">
          Añadir PR
        </button>
      )}
      {articulo?.codigo && !editando && (
        <button type="button" onClick={() => setEditando(true)} className="mt-1 text-[11px] text-[#1e3358] hover:underline">
          Cambiar
        </button>
      )}
      {editando && <BuscadorPr onElegir={elegir} onCancelar={() => setEditando(false)} />}
    </div>
  );
}

const eur = (n) => (n == null || !Number.isFinite(n)
  ? "—"
  : n.toLocaleString("es-ES", { style: "currency", currency: "EUR" }));

function fechaDe(s) {
  const t = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fechaCorta(s) {
  const d = fechaDe(s);
  return d ? d.toLocaleDateString("es-ES") : (s || "—");
}

function hace(s) {
  const d = fechaDe(s);
  if (!d) return "";
  const dias = Math.round((Date.now() - d.getTime()) / 86400000);
  if (dias < 0) return fechaCorta(s);
  if (dias < 1) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 45) return `hace ${dias} días`;
  const meses = Math.max(1, Math.round(dias / 30.44));
  if (meses < 18) return `hace ${meses} ${meses === 1 ? "mes" : "meses"}`;
  const anos = Math.max(1, Math.round(meses / 12));
  return `hace ${anos} ${anos === 1 ? "año" : "años"}`;
}

function nombreCorto(p) {
  const s = String(p || "");
  if (/sinele[ck]/i.test(s)) return "Sinelec";
  if (/sonepar/i.test(s)) return "Sonepar";
  if (/araiz/i.test(s)) return "Araiz";
  if (/saltoki/i.test(s)) return "Saltoki";
  return s;
}

function listaPrecios(items) {
  const map = new Map();
  for (const l of items || []) {
    const n = nombreCorto(l.proveedor);
    const ya = map.get(n);
    if (!ya || l.precio < ya.precio) map.set(n, { ...l, nombre: n });
  }
  return [...map.values()];
}

function fraseLista(items) {
  const lista = listaPrecios(items);
  if (!lista.length) return "";
  const trozos = lista.map((l) => `${eur(l.precio)} a ${l.nombre}`);
  if (trozos.length === 1) return trozos[0];
  return `${trozos.slice(0, -1).join(", ")} y ${trozos[trozos.length - 1]}`;
}

function comprasDeFila(fila, comprasPorCodigo) {
  if (!fila?.articulo?.codigo) return [];
  const vistos = new Map();
  for (const x of comprasPorCodigo?.[fila.articulo.codigo] || []) {
    const k = `${x.documento}|${x.fecha}|${x.precio}|${x.proveedor}`;
    if (!vistos.has(k)) vistos.set(k, x);
  }
  return [...vistos.values()].sort((a, b) => (fechaDe(b.fecha)?.getTime() || 0) - (fechaDe(a.fecha)?.getTime() || 0));
}

function mejorCompra(compras) {
  return (compras || []).reduce((m, x) => (!m || x.precio < m.precio ? x : m), null);
}

function ultimaTanda(recuerdo) {
  if (!recuerdo?.length) return [];
  const ultimo = recuerdo.reduce((a, b) => (String(a.ts) > String(b.ts) ? a : b)).ts;
  const dia = String(ultimo || "").slice(0, 10);
  return recuerdo.filter((r) => String(r.ts || "").slice(0, 10) === dia);
}

function fraseRecuerdo(fila, compra) {
  const precios = fila?.precios || [];
  const tanda = ultimaTanda(fila?.recuerdo);
  if (!precios.length || (!compra && !tanda.length)) return "";
  const mejor = precios.reduce((m, p) => (!m || p.precio < m.precio ? p : m));
  const quienes = precios.filter((p) => Math.abs(p.precio - mejor.precio) < 0.0001).map((p) => nombreCorto(p.proveedor));
  const partes = [`Ahora te lo ofrecen a ${eur(mejor.precio)}${quienes.length ? ` (${quienes.join(", ")})` : ""}.`];
  if (compra) {
    const cuando = hace(compra.fecha);
    partes.push(`Lo más barato que lo compraste fue ${cuando ? `${cuando}: ` : ""}${eur(compra.precio)}${compra.proveedor ? ` a ${nombreCorto(compra.proveedor)}` : ""}.`);
  }
  if (tanda.length) {
    const cuando = hace(tanda[0].ts || tanda[0].fechaOferta);
    partes.push(`La última vez que pediste oferta${cuando ? `, ${cuando},` : ""} te hicieron precio de ${fraseLista(tanda)}.`);
  }
  return partes.join(" ");
}

function archivoABase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("No se pudo leer el archivo"));
    r.readAsDataURL(file);
  });
}

function PopupHistorico({ fila, compras, onCerrar }) {
  const mejor = mejorCompra(compras);
  const recuerdo = fila.recuerdo || [];
  const porDia = new Map();
  for (const r of recuerdo) {
    const dia = fechaCorta(r.fechaOferta || r.ts);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(r);
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Histórico de compra"
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-200">
          <div className="min-w-0">
            <div className="font-mono text-sm font-semibold text-slate-900">{fila.articulo?.codigo}</div>
            <div className="text-sm text-slate-600">{fila.articulo?.descripcion || fila.concepto}</div>
          </div>
          <button type="button" onClick={onCerrar} className="text-slate-400 hover:text-slate-700" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-5">
          <p className="text-sm text-slate-700">{fraseRecuerdo(fila, mejor)}</p>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Compras</h3>
            {compras.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">No hay pedidos de compra de este artículo en las líneas cargadas.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-2">Fecha</th>
                    <th className="py-1 pr-2">Proveedor</th>
                    <th className="py-1 pr-2">Pedido</th>
                    <th className="py-1 pr-2 text-right">Cant.</th>
                    <th className="py-1 text-right">Precio</th>
                  </tr>
                </thead>
                <tbody>
                  {compras.map((x, i) => {
                    const esMejor = mejor && x.precio === mejor.precio && x.documento === mejor.documento && x.fecha === mejor.fecha;
                    return (
                      <tr key={`${x.documento}-${x.fecha}-${i}`} className="border-t border-slate-100">
                        <td className="py-1.5 pr-2 whitespace-nowrap">{fechaCorta(x.fecha)}</td>
                        <td className="py-1.5 pr-2">{x.proveedor || "—"}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs">{x.documento || "—"}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{Number.isFinite(x.cantidad) ? x.cantidad.toLocaleString("es-ES") : "—"}</td>
                        <td className={`py-1.5 text-right tabular-nums font-semibold ${esMejor ? "text-emerald-700" : "text-slate-800"}`}>{eur(x.precio)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Ofertas que pediste</h3>
            {recuerdo.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Todavía no hay una oferta anterior guardada de este artículo. Esta comparación queda registrada.</p>
            ) : (
              [...porDia.entries()].map(([dia, lineas]) => (
                <div key={dia} className="mt-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{dia}</div>
                  <ul className="mt-1 space-y-1">
                    {listaPrecios(lineas).map((l) => (
                      <li key={l.nombre} className="text-sm text-slate-700 flex justify-between gap-3">
                        <span>{l.nombre}{l.archivo ? ` · ${l.archivo}` : ""}</span>
                        <span className="tabular-nums font-semibold">{eur(l.precio)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function VisorPdf({ titulo, url, onCerrar }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={onCerrar}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={titulo}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
          <div className="min-w-0">
            <div className="font-semibold text-slate-800 truncate">{titulo}</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {url && <a href={url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-[#1e3358]">Abrir</a>}
            <button type="button" onClick={onCerrar} className="text-slate-400 hover:text-slate-700" aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>
        {url ? (
          <iframe src={url} title={titulo} className="flex-1 w-full bg-slate-100" />
        ) : (
          <p className="p-6 text-sm text-slate-600">No tengo el PDF de este proveedor en esta comparación. Vuelve a adjuntarlo y pulsa Comparar.</p>
        )}
      </div>
    </div>
  );
}

export function ResultadoOfertas({ resultado, comprasPorCodigo = {}, pdfUrls = {} }) {
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

  const [popup, setPopup] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [manual, setManual] = useState({});
  const hayArticulos = filas.some((f) => f.articulo?.codigo || f.articulo?.alternativas?.length) || Object.keys(manual).length > 0;
  const hayCompras = Object.keys(comprasPorCodigo).length > 0;
  const columnas = 5 + proveedores.length;

  const verPdf = (proveedor) => {
    const oferta = ofertas.find((o) => o.proveedor === proveedor);
    setPdf({ titulo: `${proveedor}${oferta?.archivo ? ` · ${oferta.archivo}` : ""}`, url: oferta?.archivo ? pdfUrls[oferta.archivo] || "" : "" });
  };

  const asignar = async (f, articulo) => {
    const key = `${f.clave}|${f.talla}`;
    const siguiente = { ...f, articulo, recuerdo: f.recuerdo || [] };
    setManual((prev) => ({ ...prev, [key]: siguiente }));
    try {
      const r = await fetch("/api/ofertas/asignar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigo: articulo.codigo,
          descripcion: articulo.descripcion,
          concepto: f.concepto,
          precios: f.precios,
          ofertas: ofertas.map((o) => ({ proveedor: o.proveedor, fecha: o.fecha, referencia: o.referencia, archivo: o.archivo })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      setManual((prev) => ({ ...prev, [key]: { ...siguiente, recuerdo: j.recuerdo || [] } }));
    } catch (e) {
      setManual((prev) => ({ ...prev, [key]: { ...siguiente, aviso: String(e.message || e) } }));
    }
  };

  if (!ofertas.length) return null;

  return (
    <div className="mt-5 space-y-4">
      {(resultado.avisos || []).length > 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {resultado.avisos.map((a) => <div key={a}>{a}</div>)}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {ofertas.map((o) => (
          <button
            key={o.archivo || o.proveedor}
            type="button"
            onClick={() => verPdf(o.proveedor)}
            title="Ver el PDF de esta oferta"
            className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm text-left hover:border-[#1e3358]"
          >
            <div className="flex items-center gap-3">
              <LogoProveedor nombre={o.proveedor} alto={42} />
              <div className="min-w-0">
                <div className="text-[11px] font-bold tracking-[0.14em] uppercase text-slate-400">Proveedor</div>
                <div className="font-semibold text-slate-800 truncate">{o.proveedor}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {o.lineas?.length || 0} líneas
                  {o.referencia ? ` · ${o.referencia}` : ""}
                  {o.fecha ? ` · ${o.fecha}` : ""}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {resumen.comparables > 0 && (
        <p className="text-sm text-slate-700">
          {resumen.ganador
            ? `${resumen.ganador[0]} tiene el precio más bajo en ${resumen.ganador[1]} de ${resumen.comparables} conceptos comparables.`
            : `${resumen.comparables} conceptos se pueden comparar. En varios hay empate.`}
          {" "}El verde es el precio unitario sin IVA, ya con el descuento de la oferta.
          {hayArticulos ? " El artículo es el PR de la empresa que tienes abierta." : ""}
        </p>
      )}
      {filas.length > 0 && resumen.comparables === 0 && (
        <p className="text-sm text-slate-600">
          Cada concepto sale en una sola oferta. Adjunta el PDF de otro proveedor para ver quién es más barato.
          {hayArticulos ? " El artículo es el PR de la empresa que tienes abierta." : ""}
        </p>
      )}

      {filas.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="px-4 py-2 font-semibold">Concepto</th>
                <th className="px-3 py-2 font-semibold">Artículo</th>
                <th className="px-3 py-2 font-semibold">Lo compraste</th>
                <th className="px-3 py-2 font-semibold">Talla</th>
                {proveedores.map((p) => (
                  <th key={p} className="px-3 py-2 font-semibold text-right align-bottom">
                    <button type="button" onClick={() => verPdf(p)} title="Ver el PDF de esta oferta" className="inline-flex flex-col items-end gap-1 hover:opacity-80">
                      <LogoProveedor nombre={p} alto={34} />
                      <span className="underline decoration-slate-300">{p}</span>
                    </button>
                  </th>
                ))}
                <th className="px-4 py-2 font-semibold">Mejor precio</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const vista = manual[`${f.clave}|${f.talla}`] || f;
                const banda = f.familia && filas.findIndex((x) => x.familia === f.familia) === i;
                const textos = banda
                  ? [...new Set(filas.filter((x) => x.familia === f.familia).flatMap((x) => x.conceptos || []).filter((c) => c && c !== f.concepto))]
                  : [];
                const compras = comprasDeFila(vista, comprasPorCodigo);
                const mejor = mejorCompra(compras);
                const frase = vista.articulo?.codigo ? fraseRecuerdo(vista, mejor) : "";
                const abrir = () => setPopup({ fila: vista, compras });
                return (
                <React.Fragment key={`${f.clave}|${f.talla}`}>
                {banda && (
                  <tr className="bg-slate-100">
                    <td colSpan={columnas} className="px-4 py-2">
                      <div className="font-semibold text-slate-800">{f.concepto}</div>
                      {textos.length > 0 && (
                        <div className="text-[11px] text-slate-500 leading-snug">{textos.join(" · ")}</div>
                      )}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-800">{f.concepto}</td>
                  <td className="px-3 py-2 align-top">
                    <CeldaArticulo articulo={vista.articulo} onAsignar={(articulo) => asignar(f, articulo)} />
                    {vista.aviso && <div className="text-[11px] text-red-700 mt-1">{vista.aviso}</div>}
                  </td>
                  <td className="px-3 py-2 align-top">
                      {mejor ? (
                        <button type="button" onClick={abrir} className="text-left hover:bg-slate-50 rounded-md px-1 -mx-1">
                          <div className="font-semibold tabular-nums text-slate-900 underline decoration-slate-300">{eur(mejor.precio)}</div>
                          <div className="text-[11px] text-slate-500">{[hace(mejor.fecha), nombreCorto(mejor.proveedor)].filter(Boolean).join(" · ")}</div>
                        </button>
                      ) : vista.articulo?.codigo ? (
                        <span className="text-slate-400">Sin compras</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  <td className="px-3 py-2 text-slate-600">{f.talla || "—"}</td>
                  {proveedores.map((p) => {
                    const precio = f.precios.find((x) => x.proveedor === p);
                    const gana = precio && f.mejores.includes(p) && f.precios.length > 1;
                    return (
                      <td
                        key={p}
                        onClick={precio && vista.articulo?.codigo ? abrir : undefined}
                        className={`px-3 py-2 text-right tabular-nums ${gana ? "bg-emerald-100 font-semibold text-emerald-900" : "text-slate-700"} ${precio && vista.articulo?.codigo ? "cursor-pointer" : ""}`}
                      >
                        {precio ? eur(precio.precio) : "—"}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-slate-800">
                    {f.precios.length > 1 ? f.mejores.join(" · ") : "Solo una oferta"}
                  </td>
                </tr>
                {frase && (
                  <tr className="border-t border-slate-50">
                    <td colSpan={columnas} className="px-4 pb-3 pt-0">
                      <button type="button" onClick={abrir} className="text-left text-xs text-slate-600 hover:text-slate-900">
                        {frase}
                      </button>
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filas.length > 0 && hayArticulos && !hayCompras && (
        <p className="text-sm text-slate-600">Carga las líneas de compra para ver a qué precio lo compraste. Las ofertas de estos PDF sí quedan guardadas.</p>
      )}

      {filas.length === 0 && (
        <p className="text-sm text-slate-600">No he encontrado precios unitarios en esos PDF. Prueba con el presupuesto donde se vea la tabla de artículos.</p>
      )}
      {popup && <PopupHistorico fila={popup.fila} compras={popup.compras} onCerrar={() => setPopup(null)} />}
      {pdf && <VisorPdf titulo={pdf.titulo} url={pdf.url} onCerrar={() => setPdf(null)} />}
    </div>
  );
}

export default function ComparadorOfertas({ comprasPorCodigo = {} }) {
  const [archivos, setArchivos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const pdfUrls = useMemo(() => {
    const map = {};
    for (const f of archivos) map[f.name] = URL.createObjectURL(f);
    return map;
  }, [archivos]);
  useEffect(() => () => {
    for (const url of Object.values(pdfUrls)) URL.revokeObjectURL(url);
  }, [pdfUrls]);

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
    <section className="mt-8 pt-6 border-t border-slate-200">
      <div className="flex items-center gap-2">
        <Scale size={18} className="text-[#1e3358]" />
        <h2 className="text-lg font-bold text-slate-800">Comparador de ofertas</h2>
      </div>
      <p className="text-xs text-slate-500 mt-0.5 max-w-xl">
        Adjunta el PDF de cada proveedor. La misma prenda se junta aunque la llamen distinto: sudadera, camiseta manga corta, camiseta manga larga, jaqueta y pantalón. La talla sigue en su fila.
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

      <ResultadoOfertas resultado={resultado} comprasPorCodigo={comprasPorCodigo} pdfUrls={pdfUrls} />
    </section>
  );
}
