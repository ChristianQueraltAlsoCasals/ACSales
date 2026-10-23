import React, { useEffect, useRef, useState } from "react";
import { formatoOrigen } from "./origenCifra.js";

function juntarCuentas(cuentas, otras) {
  const mapa = new Map();
  for (const c of cuentas || []) mapa.set(c.cta, { cta: c.cta, nombre: c.nombre, importe: c.importe, otro: null });
  for (const c of otras || []) {
    const ya = mapa.get(c.cta);
    if (ya) ya.otro = c.importe;
    else mapa.set(c.cta, { cta: c.cta, nombre: c.nombre, importe: null, otro: c.importe });
  }
  return [...mapa.values()];
}

function TablaCuentas({ cuentas, otras }) {
  const filas = otras ? juntarCuentas(cuentas, otras) : (cuentas || []).map((c) => ({ ...c, otro: undefined }));
  const total = filas.reduce((s, c) => s + (c.importe || 0), 0);
  const totalOtro = otras ? filas.reduce((s, c) => s + (c.otro || 0), 0) : null;
  return (
    <div className="max-h-64 overflow-auto border-t border-slate-200 bg-white">
      <table className="w-full text-xs">
        <tbody>
          {filas.map((c) => (
            <tr key={c.cta} className="border-t border-slate-100">
              <td className="px-2 py-0.5 whitespace-nowrap text-slate-700">{c.cta}</td>
              <td className="px-2 py-0.5 text-slate-600">{c.nombre || "—"}</td>
              <td className="px-2 py-0.5 text-right whitespace-nowrap tabular-nums">{c.importe == null ? "—" : formatoOrigen(c.importe, "eur2")}</td>
              {otras && <td className="px-2 py-0.5 text-right whitespace-nowrap tabular-nums text-slate-500">{c.otro == null ? "—" : formatoOrigen(c.otro, "eur2")}</td>}
            </tr>
          ))}
          <tr className="border-t border-slate-200 font-semibold">
            <td className="px-2 py-0.5" colSpan={2}>Suma de las cuentas</td>
            <td className="px-2 py-0.5 text-right whitespace-nowrap tabular-nums">{formatoOrigen(total, "eur2")}</td>
            {otras && <td className="px-2 py-0.5 text-right whitespace-nowrap tabular-nums text-slate-500">{formatoOrigen(totalOtro, "eur2")}</td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function signo(papel) {
  if (papel === "Se suma") return "+";
  if (papel === "Se resta") return "−";
  return papel || "";
}

function nota(que) {
  if (!que) return null;
  let t = String(que).trim().replace(/\.\s*$/, "");
  if (/^Todas las cuentas\b/i.test(t) || /^Cuentas\b/.test(t)) {
    t = t.replace(/^Todas las /i, "");
    t = t.charAt(0).toLowerCase() + t.slice(1);
    return { paren: true, texto: t };
  }
  return { paren: false, texto: t };
}

function Fila({ pieza, cabecera, cebra, nivel }) {
  const [ver, setVer] = useState(false);
  const n = pieza.cuentas?.length || 0;
  const sig = signo(pieza.papel);
  const explic = nota(pieza.que);
  const color = sig === "+" ? "text-emerald-600" : sig === "−" ? "text-red-700" : "text-slate-500";
  const abrir = n > 0 ? () => setVer((v) => !v) : undefined;
  return (
    <>
      <div
        className={`flex items-baseline gap-3 px-2 pr-6 py-1 ${cabecera ? "border-b border-slate-200" : ""} ${cebra ? "bg-sky-50" : "bg-white"} ${abrir ? "cursor-pointer" : ""}`}
        onClick={abrir}
        title={n > 0 ? (ver ? "Ocultar cuentas" : "Pulsa para ver las cuentas") : undefined}
      >
        <div className="min-w-0 flex-1 leading-snug" style={{ paddingLeft: `${nivel * 16}px` }}>
          {sig && !(cabecera && nivel === 0) && <span className={`font-semibold mr-1 ${color}`}>{sig}</span>}
          <span className="font-semibold text-slate-800">{pieza.nombre}</span>
          {explic && explic.paren && <span className="font-normal text-slate-600"> ({explic.texto})</span>}
          {explic && !explic.paren && <span className="font-normal text-slate-700">: {explic.texto}</span>}
          {pieza.aviso && <span className="font-normal text-amber-800"> {pieza.aviso}</span>}
          {pieza.cuentas && n === 0 && <span className="font-normal text-slate-500"> No hay importes en estas cuentas.</span>}
        </div>
        <div className={`w-36 shrink-0 text-right whitespace-nowrap tabular-nums ${cabecera ? "font-semibold" : ""}`}>
          {formatoOrigen(pieza.valor, pieza.formato)}
        </div>
        {pieza.valorOtro !== undefined && (
          <div className={`w-36 shrink-0 text-right whitespace-nowrap tabular-nums text-slate-500 ${cabecera ? "font-semibold" : ""}`}>
            {formatoOrigen(pieza.valorOtro, pieza.formato)}
          </div>
        )}
      </div>
      {ver && <TablaCuentas cuentas={pieza.cuentas} otras={pieza.cuentasOtro} />}
    </>
  );
}

function valorDe(nodo) {
  if (!nodo) return null;
  if (nodo.formato === "texto") return nodo.texto || nodo.valor || "—";
  return nodo.valor;
}

function conOtro(nodo, otro) {
  if (!nodo) return null;
  const hijos = nodo.bloques || [];
  const hijosOtro = otro?.bloques || [];
  return {
    ...nodo,
    valorOtro: otro ? valorDe(otro) : null,
    cuentasOtro: otro?.cuentas || null,
    bloques: hijos.map((h, i) => conOtro(h, hijosOtro[i])),
  };
}

function fechasDe(cuando) {
  if (!cuando) return "";
  const i = cuando.indexOf("·");
  return (i >= 0 ? cuando.slice(i + 1) : cuando).trim();
}

function bloquePlano(bloques, nivel, salida) {
  (bloques || []).forEach((b, i) => {
    const hijos = b.bloques?.length > 0;
    salida.push(
      <Fila key={`${nivel}-${b.nombre}-${i}`} pieza={b} cabecera={hijos} cebra={!hijos && salida.length % 2 === 1} nivel={nivel} />
    );
    if (hijos) bloquePlano(b.bloques, nivel + 1, salida);
  });
  return salida;
}

export default function PanelOrigen({ arbol, otro, onCerrar }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [arbol?.titulo, arbol?.cuando]);
  if (!arbol) return null;
  const comparado = otro ? conOtro(arbol, otro) : arbol;
  const cabeza = {
    nombre: arbol.titulo,
    papel: "",
    que: arbol.frase || "",
    valor: arbol.formato === "texto" ? (arbol.texto || "—") : arbol.valor,
    valorOtro: otro ? valorDe(otro) : undefined,
    formato: arbol.formato || "eur",
    aviso: arbol.aviso || "",
    cuentas: arbol.cuentas || null,
    cuentasOtro: otro?.cuentas || null,
    bloques: null,
  };
  const filas = bloquePlano(comparado.bloques, 1, []);
  return (
    <div ref={ref} className="mt-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 relative overflow-hidden">
      <button type="button" onClick={onCerrar} className="absolute top-1 right-2 z-10 text-slate-400 hover:text-slate-600" title="Cerrar">✕</button>
      <div className="flex items-end gap-3 px-2 pt-1 pr-6">
        <div className="min-w-0 flex-1 text-[11px] font-semibold text-sky-800">De dónde sale</div>
        <div className="w-36 shrink-0 text-right text-[10px] leading-tight text-slate-500">{fechasDe(arbol.cuando)}</div>
        {otro && <div className="w-36 shrink-0 text-right text-[10px] leading-tight text-slate-500">{fechasDe(otro.cuando)}</div>}
      </div>
      <Fila pieza={cabeza} cabecera cebra={false} nivel={0} />
      {filas}
    </div>
  );
}
