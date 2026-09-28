/**
 * indicadores.jsx — «Indicadores económicos y escenarios» dentro de la
 * pantalla Ratios financieros (24/09/2026).
 *
 * Tabla con los 20 indicadores (valor actual, fecha y fuente; editables y
 * actualizables desde el BCE o con la IA + búsqueda web) y una columna de
 * ESCENARIO: escribes cuánto sube o baja cada indicador y calcula el efecto
 * en € sobre tu empresa con los gastos/ventas reales de los movimientos de
 * contabilidad (mismas cifras que los ratios).
 *
 * Los escenarios y los ajustes de cada fila se guardan en este navegador,
 * por empresa.
 */
import React, { useEffect, useMemo, useState } from "react";
import { empresaGuardada } from "./empresa.jsx";

const eur = (v) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }));
const num = (v, d = 1) => Number(v).toLocaleString("es-ES", { maximumFractionDigits: d });

// Cómo afecta cada indicador a la empresa (valores por defecto, editables en ⚙)
//  coste:   % de cambio del precio × gasto de las cuentas × peso × (1 − repercusión a clientes)
//  tipo:    puntos de subida del tipo × deuda bancaria (cuentas) × peso
//  demanda: % de cambio × elasticidad → cambio de ventas × margen de contribución
const CONFIG = {
  ipc: { tipo: "coste", cuentas: "621,622,623,625,626,627,629", peso: 100, rep: 0, etiqueta: "servicios exteriores (alquileres, reparaciones, seguros…)" },
  ipri: { tipo: "coste", cuentas: "60", peso: 30, rep: 0, etiqueta: "compras de material" },
  gasoleo: { tipo: "coste", buscar: "combust|gasoil|gasóleo|gasoleo|carburant", cuentas: "628", peso: 40, rep: 0, etiqueta: "combustible" },
  electricidad: { tipo: "coste", buscar: "electric|luz|energia el", cuentas: "628", peso: 40, rep: 0, etiqueta: "electricidad" },
  gas: { tipo: "coste", buscar: "\\bgas\\b", cuentas: "628", peso: 10, rep: 0, etiqueta: "gas" },
  cobre: { tipo: "coste", cuentas: "60", peso: 15, rep: 0, etiqueta: "compras con cobre (cable)" },
  acero: { tipo: "coste", cuentas: "60", peso: 10, rep: 0, etiqueta: "compras de acero" },
  aluminio: { tipo: "coste", cuentas: "60", peso: 5, rep: 0, etiqueta: "compras de aluminio" },
  salarios: { tipo: "coste", cuentas: "640,641,642", peso: 100, rep: 0, etiqueta: "gastos de personal" },
  convenio: { tipo: "coste", cuentas: "640", peso: 100, rep: 0, etiqueta: "sueldos y salarios" },
  ss: { tipo: "coste", cuentas: "642", peso: 100, rep: 0, etiqueta: "Seguridad Social a cargo de la empresa" },
  bce: { tipo: "tipo", cuentas: "170,520", peso: 100, etiqueta: "deuda con bancos a tipo variable" },
  euribor: { tipo: "tipo", cuentas: "170,520", peso: 100, etiqueta: "deuda con bancos a tipo variable" },
  eurusd: { tipo: "coste", inverso: true, cuentas: "60", peso: 0, rep: 0, etiqueta: "compras pagadas en dólares" },
  transporte: { tipo: "coste", cuentas: "624", peso: 100, rep: 0, etiqueta: "transportes y portes" },
  pib: { tipo: "demanda", elast: 1, etiqueta: "ventas" },
  ipi: { tipo: "demanda", elast: 0.5, etiqueta: "ventas a clientes industriales" },
  construccion: { tipo: "demanda", elast: 0.8, etiqueta: "ventas ligadas a obra" },
  confianza: { tipo: "demanda", elast: 0.3, etiqueta: "ventas (inversión de clientes)" },
  paro: { tipo: "demanda", puntos: true, elast: -1, etiqueta: "ventas" },
  // Retraso de cobro: el escenario es en DÍAS extra de PM de cobro.
  // No toca el EBITDA directamente: atasca caja (necesidad de tesorería /
  // financiación). Opcionalmente estima el coste financiero de esa caja.
  impagos: { tipo: "cobro", etiqueta: "cobros de clientes", tipoInteres: 4 },
};
const CASOS = { coste: [-10, -5, 5, 10, 20], tipo: [-0.5, -0.25, 0.25, 0.5, 1], demanda: [-10, -5, -2, 2, 5], cobro: [15, 30, 45, 60, 90] };

const LS = () => `agente_ventas_escenarios_v1_${empresaGuardada()?.id || "defecto"}`;
const leerLS = () => { try { return JSON.parse(localStorage.getItem(LS()) || "{}"); } catch { return {}; } };
const guardarLS = (v) => { try { localStorage.setItem(LS(), JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

function listaCuentas(texto) {
  return String(texto || "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

// Panel con la explicación de la IA: fácil, ejemplo y soluciones
function PanelExplicacion({ e, onCerrar, onRepetir }) {
  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-3 text-sm text-slate-700 relative">
      <button onClick={onCerrar} className="absolute top-1 right-2 text-slate-400 hover:text-slate-600" title="Cerrar">✕</button>
      {e.cargando && <p className="text-purple-700">🤖 Pensando la explicación…</p>}
      {e.error && <p className="text-red-700">{e.error}</p>}
      {e.datos && (
        <div className="grid gap-2 pr-4">
          <div><span className="font-semibold text-purple-800">¿Qué pasa? </span>{e.datos.explicacion}</div>
          {e.datos.ejemplo && <div><span className="font-semibold text-purple-800">Ejemplo: </span>{e.datos.ejemplo}</div>}
          {e.datos.soluciones?.length > 0 && (
            <div>
              <span className="font-semibold text-purple-800">Posibles soluciones:</span>
              <ul className="list-disc ml-5 mt-1 space-y-0.5">{e.datos.soluciones.map((x, k) => <li key={k}>{x}</li>)}</ul>
            </div>
          )}
          {e.datos.prioridad && <div className="bg-white/70 rounded px-2 py-1 border border-purple-100"><span className="font-semibold">👉 Lo primero: </span>{e.datos.prioridad}</div>}
          <button onClick={onRepetir} className="justify-self-start text-xs underline text-purple-700">Otra explicación</button>
        </div>
      )}
    </div>
  );
}

export default function Indicadores({ datos }) {
  const [ind, setInd] = useState(null);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState("");
  const [aviso, setAviso] = useState("");
  const [esc, setEsc] = useState(leerLS); // { id: { x, cuentas, peso, rep, elast } }
  const [abierto, setAbierto] = useState(null);
  const [editando, setEditando] = useState(null);
  const [explic, setExplic] = useState({}); // id | "todo" -> { cargando, error, datos }

  useEffect(() => { guardarLS(esc); }, [esc]);
  useEffect(() => {
    fetch("/api/macro/indicadores")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(j?.indicadores)) {
          throw new Error(j.error || j.detalle || `Error ${r.status || "de red"}`);
        }
        setInd({
          ...j,
          actualizado: j.actualizado || new Date().toISOString().slice(0, 10),
          origen: j.origen || "Indicadores",
        });
      })
      .catch((e) => setError(String(e.message || e).includes("Failed to fetch")
        ? "No se pudieron leer los indicadores. ¿Está arrancado el backend?"
        : String(e.message || e)));
  }, []);

  const pyg = datos?.cuentas?.pyg || {};
  const bal = datos?.cuentas?.bal || {};
  const nombres = datos?.cuentas?.nombres || {};
  const dias = datos?.actual?.dias || 365;
  const anual = 365 / dias;
  const res = datos?.actual?.resultados;
  const margenContrib = res && res.VN ? 1 - res.CV / res.VN : 0;

  // Cuentas por defecto: si hay cuentas de gasto cuyo nombre coincide (p. ej. «Combustibles»), se usan esas
  const cuentasDefecto = useMemo(() => {
    const out = {};
    for (const [id, c] of Object.entries(CONFIG)) {
      if (!c.buscar) continue;
      const re = new RegExp(c.buscar, "i");
      const hall = Object.keys(pyg).filter((cta) => cta.startsWith("6") && re.test(nombres[cta] || ""));
      if (hall.length) out[id] = hall.join(",");
    }
    return out;
  }, [pyg, nombres]);

  const ajuste = (id) => {
    const c = CONFIG[id];
    if (!c) return { tipo: "coste", x: "", cuentas: "", peso: 0, rep: 0 };
    const e = esc[id] || {};
    return {
      ...c,
      x: e.x ?? "",
      cuentas: e.cuentas ?? cuentasDefecto[id] ?? c.cuentas,
      peso: e.peso ?? (cuentasDefecto[id] && !e.cuentas ? 100 : c.peso), // cuenta propia encontrada por nombre = 100 %
      rep: e.rep ?? c.rep ?? 0,
      elast: e.elast ?? c.elast,
      tipoInteres: e.tipoInteres ?? c.tipoInteres ?? 4,
    };
  };
  const cambiar = (id, campo, valor) => setEsc((s) => ({ ...s, [id]: { ...(s[id] || {}), [campo]: valor } }));

  const sumaCuentas = (mapa, lista) => Object.entries(mapa).reduce((t, [cta, v]) => (lista.some((p) => cta.startsWith(p)) ? t + v : t), 0);

  // Métricas de cobro / liquidez a partir de la contabilidad real (mismas
  // que el PM de cobro de la pestaña Ratios).
  const metricasCobro = useMemo(() => {
    if (!datos || !res) return null;
    const clientes = bal.clientes || 0;
    const tesoreria = bal.T || 0;
    const ventasConIva = (res.VN || 0) * 1.21;
    // Misma base que el PM de cobro / cobertura de la pestaña Ratios:
    // ventas del periodo (con IVA) ÷ días del periodo.
    const ventasDia = dias > 0 ? ventasConIva / dias : 0;
    const pmCobro = ventasConIva > 0 ? (clientes / ventasConIva) * dias : null;
    const diasCaja = ventasDia > 0 ? tesoreria / ventasDia : null;
    return { clientes, tesoreria, ventasDia, pmCobro, diasCaja };
  }, [datos, bal, res, dias]);

  // Impacto de un indicador en € (periodo del año hasta la fecha y anualizado)
  function impacto(id) {
    const a = ajuste(id);
    const x = parseFloat(String(a.x).replace(",", "."));
    if (!datos || !isFinite(x) || x === 0) return null;
    if (a.tipo === "cobro") {
      if (!metricasCobro?.ventasDia) return null;
      // Retraso de +X días → caja adicional atrapada en clientes
      // (ventas diarias con IVA × días). Coste financiero opcional si
      // esa caja se financia con póliza / crédito.
      const caja = metricasCobro.ventasDia * x;
      const tipo = Number(a.tipoInteres) || 0;
      const costeFinAnual = -caja * tipo / 100;
      const diasCajaTras = metricasCobro.ventasDia > 0
        ? (metricasCobro.tesoreria - caja) / metricasCobro.ventasDia
        : null;
      return {
        periodo: costeFinAnual / anual,
        anual: costeFinAnual,
        caja,
        diasCaja: metricasCobro.diasCaja,
        diasCajaTras,
        pmCobro: metricasCobro.pmCobro,
        pmCobroTras: metricasCobro.pmCobro != null ? metricasCobro.pmCobro + x : null,
        base: metricasCobro.tesoreria,
        expuesto: caja,
        afecta: "CAJA",
      };
    }
    if (a.tipo === "coste") {
      const base = sumaCuentas(pyg, listaCuentas(a.cuentas));
      const expuesto = base * (Number(a.peso) || 0) / 100;
      const signo = a.inverso ? 1 : -1; // euro más fuerte = compras en USD más baratas
      const periodo = signo * expuesto * (x / 100) * (1 - (Number(a.rep) || 0) / 100);
      return { periodo, anual: periodo * anual, base, expuesto, afecta: "EBITDA" };
    }
    if (a.tipo === "tipo") {
      const deuda = -sumaCuentas(bal, listaCuentas(a.cuentas)) * (Number(a.peso) || 0) / 100;
      const anualI = -deuda * x / 100;
      return { periodo: anualI / anual, anual: anualI, base: deuda, expuesto: deuda, afecta: "BN" };
    }
    const dV = (res?.VN || 0) * (Number(a.elast) || 0) * x / 100;
    const periodo = dV * margenContrib;
    return { periodo, anual: periodo * anual, base: res?.VN || 0, dV, afecta: "EBITDA" };
  }

  function explicacion(id, im) {
    const a = ajuste(id);
    const nombre = ind?.indicadores.find((i) => i.id === id)?.nombre || id;
    const x = parseFloat(String(a.x).replace(",", "."));
    const sube = x > 0 ? "sube" : "baja";
    if (!im) return null;
    if (a.tipo === "cobro") {
      const aguante = im.diasCaja != null ? `${Math.round(im.diasCaja)} días` : "—";
      const tras = im.diasCajaTras != null ? `${Math.round(im.diasCajaTras)} días` : "—";
      return `Si los clientes retrasan el cobro ${num(Math.abs(x), 0)} días, se te quedan atrapados ${eur(im.caja)} en clientes (ventas diarias × días). ` +
        `Con la tesorería actual aguantas ~${aguante} sin cobrar; tras este retraso te quedarían ~${tras} de colchón` +
        (im.anual ? ` · coste financiero estimado ${eur(Math.abs(im.anual))}/año al ${num(a.tipoInteres, 1)} %` : "") +
        `.`;
    }
    if (a.tipo === "coste") {
      return `Si ${nombre.toLowerCase()} ${sube} un ${num(Math.abs(x))} %, sobre ${eur(im.expuesto * anual)}/año de ${a.etiqueta}` +
        `${a.rep ? ` (repercutes el ${a.rep} % al cliente)` : ""} → ${im.anual < 0 ? "pierdes" : "ganas"} ${eur(Math.abs(im.anual))}/año de EBITDA.`;
    }
    if (a.tipo === "tipo") {
      return `Si ${nombre.toLowerCase()} ${sube} ${num(Math.abs(x), 2)} puntos, sobre ${eur(im.base)} de ${a.etiqueta} → ${im.anual < 0 ? "pagas" : "ahorras"} ${eur(Math.abs(im.anual))}/año en intereses.`;
    }
    return `Si ${nombre.toLowerCase()} ${a.puntos ? `${sube} ${num(Math.abs(x))} puntos` : `${sube} un ${num(Math.abs(x))} %`}, con elasticidad ${num(a.elast, 2)} tus ventas cambian ${eur(im.dV * anual)}/año; con un margen de contribución del ${num(margenContrib * 100)} % → ${eur(im.anual)}/año de EBITDA.`;
  }

  const impactos = useMemo(() => {
    const o = {};
    for (const id of Object.keys(CONFIG)) o[id] = impacto(id);
    return o;
  }, [esc, datos, cuentasDefecto, metricasCobro]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = Object.values(impactos).filter(Boolean);
  const totEbitda = total.filter((i) => i.afecta === "EBITDA").reduce((t, i) => t + i.anual, 0);
  const totFin = total.filter((i) => i.afecta === "BN" || i.afecta === "CAJA").reduce((t, i) => t + i.anual, 0);
  const totCaja = total.filter((i) => i.afecta === "CAJA").reduce((t, i) => t + (i.caja || 0), 0);
  const solapes = [["salarios", "convenio"], ["salarios", "ss"], ["bce", "euribor"], ["ipri", "cobre"], ["ipri", "acero"], ["ipri", "aluminio"]]
    .filter(([a, b]) => impactos[a] && impactos[b]);

  async function accion(ruta, etiqueta) {
    setOcupado(etiqueta); setError(""); setAviso("");
    try {
      const r = await fetch(ruta, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — "));
      setInd(j);
      setAviso(`${etiqueta}: ${j.actualizados?.length || 0} indicadores actualizados${j.errores?.length ? ` · sin respuesta: ${j.errores.join("; ")}` : ""}.`);
    } catch (e) {
      setError(String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend." : String(e.message || e));
    } finally { setOcupado(""); }
  }
  async function guardarEdicion() {
    const r = await fetch("/api/macro/indicadores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cambios: { [editando.id]: editando } }) });
    if (r.ok) { setInd(await r.json()); setEditando(null); } else setError("No se pudo guardar el indicador.");
  }

  function filaParaIA(i) {
    const a = ajuste(i.id);
    const im = impactos[i.id];
    const x = parseFloat(String(a.x).replace(",", "."));
    return {
      nombre: i.nombre, valor: i.id === "impagos" && metricasCobro ? datoActualImpagos() : i.valor, fecha: i.fecha, que: i.que, afecta: i.afecta,
      escenario: im && isFinite(x) ? x : "", unidad: a.tipo === "tipo" || a.puntos ? "puntos" : a.tipo === "cobro" ? "días" : "%",
      efectoAnual: im?.anual ?? null,
      base: im
        ? (a.tipo === "tipo" ? im.base : a.tipo === "coste" ? im.expuesto * anual : a.tipo === "cobro" ? im.caja : im.base * anual)
        : null,
      etiqueta: a.tipo === "cobro" ? `caja atrapada · aguantas ${im?.diasCaja != null ? Math.round(im.diasCaja) : "—"} días con la tesorería actual` : a.etiqueta,
      texto: im ? explicacion(i.id, im) : "",
    };
  }
  function datoActualImpagos() {
    if (!metricasCobro) return "Calcula primero los ratios para ver tu PM de cobro y días de caja";
    const pm = metricasCobro.pmCobro != null ? `${Math.round(metricasCobro.pmCobro)} días de cobro` : "—";
    const caja = metricasCobro.diasCaja != null ? `${Math.round(metricasCobro.diasCaja)} días de caja` : "—";
    return `${pm} · aguantas ~${caja} sin cobrar · clientes ${eur(metricasCobro.clientes)} · tesorería ${eur(metricasCobro.tesoreria)}`;
  }
  async function explicar(clave) {
    const filas = clave === "todo"
      ? ind.indicadores.filter((i) => impactos[i.id]).map(filaParaIA)
      : [filaParaIA(ind.indicadores.find((i) => i.id === clave))];
    setExplic((s) => ({ ...s, [clave]: { cargando: true } }));
    try {
      const resumen = res ? {
        ventas: res.VN * anual, ebitda: res.EBITDA * anual, margen: res.VN ? res.EBITDA / res.VN : null,
        personal: res.personal * anual, consumos: res.consumos * anual,
        deuda: -sumaCuentas(bal, ["170", "520"]),
        ...(clave === "todo" ? { totalEbitda: totEbitda, totalFin: totFin } : {}),
      } : {};
      const r = await fetch("/api/macro/explicar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa: datos?.empresa || empresaGuardada()?.nombre || "ALSO CASALS", modo: clave === "todo" ? "todo" : "uno", filas, resumen }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      setExplic((s) => ({ ...s, [clave]: { datos: j } }));
    } catch (e) {
      setExplic((s) => ({ ...s, [clave]: { error: String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend." : String(e.message || e) } }));
    }
  }
  const cerrarExplic = (clave) => setExplic((s) => { const n = { ...s }; delete n[clave]; return n; });

  if (error && !ind) return <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</p>;
  if (!ind) return <p className="text-sm text-slate-500 mt-4">Cargando indicadores…</p>;

  const input = "border rounded px-1.5 py-0.5 text-sm";
  return (
    <div className="mt-6 grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => accion("/api/macro/actualizar-bce", "BCE")} disabled={!!ocupado} className="px-3 py-1.5 rounded border text-sm disabled:opacity-50" title="EUR/USD, tipo del BCE y Euríbor desde la API del Banco Central Europeo">
          {ocupado === "BCE" ? "Actualizando…" : "↻ Actualizar BCE (EUR/USD, tipos, Euríbor)"}
        </button>
        <button onClick={() => accion("/api/macro/actualizar-ia", "IA")} disabled={!!ocupado} className="px-3 py-1.5 rounded bg-blue-700 text-white text-sm disabled:opacity-50" title="Claude busca en la web el último dato de cada indicador">
          {ocupado === "IA" ? "Buscando datos en la web… (1–2 min)" : "🤖 Actualizar todos con IA"}
        </button>
        <span className="text-xs text-slate-400">
          Datos a {(ind.actualizado || "").split("-").reverse().join("/") || "—"} · {ind.origen || "—"}
        </span>
        {Object.keys(esc).length > 0 && (
          <button onClick={() => setEsc({})} className="ml-auto text-xs text-slate-500 underline">Borrar escenario</button>
        )}
      </div>
      {aviso && <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded p-2">{aviso}</p>}
      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</p>}
      {!datos && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">Calcula primero los ratios (pestaña «Ratios») para poder simular el efecto en tu empresa.</p>}

      <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 bg-slate-50">
              <th className="px-3 py-2 font-medium">Indicador</th>
              <th className="px-3 py-2 font-medium">Qué te dice</th>
              <th className="px-3 py-2 font-medium">Cómo puede afectar a la empresa</th>
              <th className="px-3 py-2 font-medium">Dato actual</th>
              <th className="px-3 py-2 font-medium">Posibles casos (escenario)</th>
              <th className="px-3 py-2 font-medium text-right">Efecto en tu empresa</th>
            </tr>
          </thead>
          <tbody>
            {ind.indicadores.map((i) => {
              const a = ajuste(i.id) || { tipo: "coste" };
              const im = impactos[i.id];
              const unidad = a.tipo === "tipo" || a.puntos ? "pp" : a.tipo === "cobro" ? "días" : "%";
              const casos = CASOS[a.tipo] || CASOS.coste;
              return (
                <React.Fragment key={i.id}>
                  <tr className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">{i.nombre}</td>
                    <td className="px-3 py-2 text-slate-600">{i.que}</td>
                    <td className="px-3 py-2 text-slate-600">{i.afecta}</td>
                    <td className="px-3 py-2 min-w-[190px]">
                      {i.id === "impagos" ? (
                        <>
                          <div className="font-medium text-slate-800 text-[13px] leading-snug">
                            {metricasCobro ? datoActualImpagos() : "Calcula primero los ratios (pestaña «Ratios»)"}
                          </div>
                          {metricasCobro && (
                            <div className="text-xs text-slate-400 mt-0.5">
                              En vivo desde tu BC · ventas/día ≈ {eur(metricasCobro.ventasDia)}
                            </div>
                          )}
                        </>
                      ) : editando?.id === i.id ? (
                        <div className="grid gap-1">
                          <input className={input} value={editando.valor} onChange={(e) => setEditando({ ...editando, valor: e.target.value })} placeholder="Valor" />
                          <input className={input} value={editando.fecha} onChange={(e) => setEditando({ ...editando, fecha: e.target.value })} placeholder="Fecha" />
                          <input className={input} value={editando.fuente} onChange={(e) => setEditando({ ...editando, fuente: e.target.value })} placeholder="Fuente" />
                          <div className="flex gap-2">
                            <button onClick={guardarEdicion} className="text-xs px-2 py-0.5 rounded bg-blue-700 text-white">Guardar</button>
                            <button onClick={() => setEditando(null)} className="text-xs underline text-slate-500">Cancelar</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="font-medium text-slate-800">{i.valor}</div>
                          <div className="text-xs text-slate-400">
                            {i.fecha} · {i.url ? <a href={i.url} target="_blank" rel="noreferrer" className="underline">{i.fuente}</a> : i.fuente}
                            <button onClick={() => setEditando({ id: i.id, valor: i.valor, fecha: i.fecha, fuente: i.fuente, url: i.url })} className="ml-1" title="Editar dato">✏️</button>
                          </div>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-[210px]">
                      <div className="flex items-center gap-1">
                        <input
                          className={`${input} w-20 text-right`}
                          value={a.x}
                          onChange={(e) => cambiar(i.id, "x", e.target.value)}
                          placeholder="0"
                          inputMode="decimal"
                        />
                        <span className="text-xs text-slate-500">{unidad}</span>
                        <button onClick={() => setAbierto(abierto === i.id ? null : i.id)} className="ml-1 text-xs text-slate-500" title="Ajustar cómo afecta a la empresa">⚙</button>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {casos.map((c) => (
                          <button key={c} onClick={() => cambiar(i.id, "x", String(c))} className={`text-[11px] px-1.5 rounded border ${String(a.x) === String(c) ? "bg-blue-700 text-white border-blue-700" : c > 0 ? "text-red-700 border-red-200" : "text-green-700 border-green-200"}`}>
                            {a.tipo === "cobro" ? `+${num(c, 0)}` : `${c > 0 ? "+" : ""}${num(c, 2)}`}
                          </button>
                        ))}
                      </div>
                      {a.tipo === "cobro" && (
                        <div className="text-[10px] text-slate-400 mt-1">Retraso extra del cobro (días)</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right min-w-[220px]">
                      {im ? (
                        a.tipo === "cobro" ? (
                          <>
                            <div className="font-semibold text-red-600">Caja atrapada {eur(im.caja)}</div>
                            <div className="text-xs text-slate-600 mt-0.5">
                              Aguantas <b>{im.diasCaja != null ? Math.round(im.diasCaja) : "—"} días</b> sin cobrar
                              {im.diasCajaTras != null && (
                                <> · tras el retraso: <b className={im.diasCajaTras < 0 ? "text-red-700" : ""}>{Math.round(im.diasCajaTras)} días</b></>
                              )}
                            </div>
                            {im.anual !== 0 && (
                              <div className="text-xs text-amber-700 mt-0.5">Coste fin. ≈ {eur(Math.abs(im.anual))}/año</div>
                            )}
                            <div className="text-xs text-slate-500 text-left mt-0.5">{explicacion(i.id, im)}</div>
                          </>
                        ) : (
                          <>
                            <div className={`font-semibold ${im.anual < 0 ? "text-red-600" : "text-green-700"}`}>{im.anual > 0 ? "+" : ""}{eur(im.anual)}/año</div>
                            <div className="text-xs text-slate-500 text-left mt-0.5">{explicacion(i.id, im)}</div>
                          </>
                        )
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                      <button onClick={() => explicar(i.id)} disabled={explic[i.id]?.cargando} className="mt-1 text-[11px] px-2 py-0.5 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 disabled:opacity-50" title="La IA te explica cómo afecta, con un ejemplo y posibles soluciones">
                        🤖 Explícame
                      </button>
                    </td>
                  </tr>
                  {explic[i.id] && (
                    <tr>
                      <td colSpan={6} className="px-3 pb-3">
                        <PanelExplicacion e={explic[i.id]} onCerrar={() => cerrarExplic(i.id)} onRepetir={() => explicar(i.id)} />
                      </td>
                    </tr>
                  )}
                  {abierto === i.id && (
                    <tr className="bg-slate-50 text-xs">
                      <td colSpan={6} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          {a.tipo === "cobro" ? (
                            <>
                              <label>Tipo interés estimado <input className={`${input} w-14 text-right`} value={a.tipoInteres} onChange={(e) => cambiar(i.id, "tipoInteres", e.target.value)} /> %</label>
                              <span className="text-slate-500">
                                {metricasCobro
                                  ? `Clientes ${eur(metricasCobro.clientes)} · tesorería ${eur(metricasCobro.tesoreria)} · PM cobro ${metricasCobro.pmCobro != null ? Math.round(metricasCobro.pmCobro) : "—"} días · ventas/día ${eur(metricasCobro.ventasDia)}`
                                  : "Calcula primero los ratios para usar tus cifras reales."}
                              </span>
                            </>
                          ) : a.tipo !== "demanda" ? (
                            <>
                              <label>Cuentas <input className={`${input} w-56`} value={a.cuentas} onChange={(e) => cambiar(i.id, "cuentas", e.target.value)} /></label>
                              <label>Peso <input className={`${input} w-14 text-right`} value={a.peso} onChange={(e) => cambiar(i.id, "peso", e.target.value)} /> %</label>
                              {a.tipo === "coste" && <label>Repercutes al cliente <input className={`${input} w-14 text-right`} value={a.rep} onChange={(e) => cambiar(i.id, "rep", e.target.value)} /> %</label>}
                              <span className="text-slate-500">
                                Base: {eur((a.tipo === "tipo" ? -sumaCuentas(bal, listaCuentas(a.cuentas)) : sumaCuentas(pyg, listaCuentas(a.cuentas)) * anual))}
                                {a.tipo === "tipo" ? " de deuda" : "/año"} ·{" "}
                                {listaCuentas(a.cuentas).map((p) => Object.keys(a.tipo === "tipo" ? bal : pyg).filter((c) => c.startsWith(p)).slice(0, 6).map((c) => `${c} ${nombres[c] || ""}`).join(", ")).filter(Boolean).join(" | ") || "sin movimientos en esas cuentas"}
                              </span>
                            </>
                          ) : (
                            <>
                              <label>Elasticidad de tus ventas <input className={`${input} w-16 text-right`} value={a.elast} onChange={(e) => cambiar(i.id, "elast", e.target.value)} /></label>
                              <span className="text-slate-500">Cuánto se mueven tus ventas por cada {a.puntos ? "punto" : "1 %"} que cambia el indicador. Margen de contribución actual: {num(margenContrib * 100)} %.</span>
                            </>
                          )}
                          <button onClick={() => setEsc((s) => { const n = { ...s }; delete n[i.id]; return n; })} className="underline text-slate-500">Valores por defecto</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      {datos && total.length > 0 && (
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800">Resultado del escenario (anualizado)</h2>
          <div className="grid sm:grid-cols-3 gap-3 mt-3 text-sm">
            {[
              ["EBITDA", res.EBITDA * anual, res.EBITDA * anual + totEbitda],
              ["Beneficio antes de impuestos", res.BAI * anual, res.BAI * anual + totEbitda + totFin],
              ["Margen EBITDA", res.VN ? res.EBITDA / res.VN : null, null],
            ].map(([n, antes, despues], k) => (
              <div key={n} className="rounded-lg border p-3">
                <div className="text-xs text-slate-500">{n}</div>
                {k < 2 ? (
                  <>
                    <div className="text-slate-400 line-through">{eur(antes)}</div>
                    <div className={`text-lg font-bold ${despues < antes ? "text-red-600" : "text-green-700"}`}>{eur(despues)}</div>
                    <div className="text-xs text-slate-500">{despues - antes > 0 ? "+" : ""}{eur(despues - antes)} ({antes ? num(((despues - antes) / Math.abs(antes)) * 100) : "—"} %)</div>
                  </>
                ) : (() => {
                  const vn = (res.VN * anual) + total.filter((i) => i.dV).reduce((t, i) => t + i.dV * anual, 0);
                  const nuevo = vn ? (res.EBITDA * anual + totEbitda) / vn : null;
                  return (
                    <>
                      <div className="text-slate-400 line-through">{antes == null ? "—" : `${num(antes * 100)} %`}</div>
                      <div className={`text-lg font-bold ${nuevo < antes ? "text-red-600" : "text-green-700"}`}>{nuevo == null ? "—" : `${num(nuevo * 100)} %`}</div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
          {totCaja > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-sm">
              <div className="text-xs text-amber-800 font-semibold uppercase tracking-wide">Caja atrapada por retraso de cobro</div>
              <div className="text-lg font-bold text-amber-900 mt-0.5">{eur(totCaja)}</div>
              <div className="text-xs text-amber-800 mt-1">
                Es dinero que sigue en clientes: no baja el EBITDA, pero sí la liquidez. Si lo financias con póliza, el coste ya está en el beneficio antes de impuestos.
                {metricasCobro?.diasCaja != null && (
                  <> Hoy aguantas ~<b>{Math.round(metricasCobro.diasCaja)} días</b> sin cobrar usando solo la tesorería.</>
                )}
              </div>
            </div>
          )}
          <div className="mt-3">
            <button onClick={() => explicar("todo")} disabled={explic.todo?.cargando} className="px-3 py-1.5 rounded bg-purple-700 text-white text-sm disabled:opacity-50">
              {explic.todo?.cargando ? "🤖 Pensando…" : "🤖 Explícame el escenario completo y qué hacer"}
            </button>
            {explic.todo && <div className="mt-2"><PanelExplicacion e={explic.todo} onCerrar={() => cerrarExplic("todo")} onRepetir={() => explicar("todo")} /></div>}
          </div>
          {solapes.length > 0 && (
            <p className="text-xs text-amber-700 mt-3">⚠ Estás simulando a la vez indicadores que tocan las mismas cuentas ({solapes.map((s) => s.join(" + ")).join(", ")}): el efecto puede estar contado dos veces.</p>
          )}
          <p className="text-xs text-slate-400 mt-2">
            Anualizado con la cuenta de resultados de {(datos.desde || "").split("-").reverse().join("/") || "—"} a {(datos.hasta || "").split("-").reverse().join("/") || "—"} (×365/{dias}). Los impuestos no se recalculan.
            Materias primas: el «peso» es la parte de tus compras que depende de ese material (ajústalo con ⚙).
          </p>
        </section>
      )}
    </div>
  );
}
