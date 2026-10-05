/**
 * Cuadro de mando de dirección, encima de las tablas de ratios.
 * No recalcula las fórmulas: lee los mismos grupos, el balance y la serie mensual.
 */
import React, { useEffect, useState } from "react";

const eur = (v) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }));
const eurCorto = (v) => {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  const signo = v < 0 ? "−" : "";
  if (a >= 1e6) return `${signo}${(a / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 2 })} M€`;
  if (a >= 1e3) return `${signo}${Math.round(a).toLocaleString("es-ES")} €`;
  return `${signo}${Math.round(a)} €`;
};
const pct = (v) => (v == null || !isFinite(v) ? "—" : `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`);
const num = (v, d = 2) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("es-ES", { maximumFractionDigits: d }));
const fmtFecha = (s) => (s ? s.split("-").reverse().join("/") : "—");
const diasF = (v) => (v == null || !isFinite(v) ? "—" : `${Math.round(v).toLocaleString("es-ES")} días`);
const div = (a, b) => (b && isFinite(a / b) ? a / b : null);
const buscar = (grupos, nombre) => {
  for (const g of grupos || []) {
    const f = (g.filas || []).find((x) => x[0] === nombre);
    if (f) return f[2];
  }
  return null;
};

function deudaFinanciera(bal) {
  const prefs = ["16", "17", "520", "521", "522", "523", "524", "525", "526", "527", "528", "529"];
  let t = 0;
  for (const [k, v] of Object.entries(bal || {})) {
    if (prefs.some((p) => k.startsWith(p))) t += v;
  }
  return -t;
}

const COLOR = {
  ok: "border-green-200 bg-green-50 text-green-900",
  vig: "border-amber-200 bg-amber-50 text-amber-950",
  mal: "border-red-200 bg-red-50 text-red-900",
  neu: "border-slate-200 bg-white text-slate-800",
};
const PUNTO = { ok: "🟢", vig: "🟠", mal: "🔴", neu: "⚪" };

function estadoDe(id, actual) {
  if (actual == null || !isFinite(actual)) return "neu";
  if (id === "re" || id === "rf" || id === "margen") return actual > 0.02 ? "ok" : actual >= 0 ? "vig" : "mal";
  if (id === "liq") return actual >= 1.5 && actual <= 2 ? "ok" : actual >= 1 ? "vig" : "mal";
  if (id === "tes") return actual >= 0.3 ? "ok" : actual >= 0.15 ? "vig" : "mal";
  if (id === "end") return actual >= 0.5 && actual <= 1.5 ? "ok" : actual <= 1.8 ? "vig" : "mal";
  if (id === "pmf") return actual <= 60 ? "ok" : actual <= 100 ? "vig" : "mal";
  if (id === "cobPm") return actual >= 1.2 ? "ok" : actual >= 1 ? "vig" : "mal";
  if (id === "pme") return actual <= 75 ? "ok" : actual <= 110 ? "vig" : "mal";
  if (id === "pmp") return actual >= 60 ? "ok" : actual >= 30 ? "vig" : "mal";
  if (id === "fm") return actual > 0 ? "ok" : "mal";
  return "neu";
}

function tendencia(actual, prev, mejorSi) {
  if (actual == null || prev == null || !isFinite(actual) || !isFinite(prev)) return null;
  const diff = actual - prev;
  const umbral = Math.max(Math.abs(prev) * 0.01, 1e-6);
  if (Math.abs(diff) < umbral) return { texto: "estable", favorable: null };
  const sube = diff > 0;
  const favorable = mejorSi === "sube" ? sube : !sube;
  return { texto: favorable ? "mejora" : "empeora", favorable, sube };
}

function Tarjeta({ titulo, actual, prev, fmt, mejorSi, estado, periodo, periodoAntes }) {
  const t = tendencia(actual, prev, mejorSi);
  const color = COLOR[estado] || COLOR.neu;
  return (
    <div className={`rounded-xl border p-3 ${color}`}>
      <div className="text-xs font-medium opacity-80">{titulo}</div>
      <div className="text-2xl font-semibold mt-1">{fmt(actual)}</div>
      <div className="text-[11px] opacity-70">{periodo}</div>
      <div className="text-xs mt-1 flex justify-between gap-2">
        <span className="opacity-70">Antes {fmt(prev)} <span className="block text-[10px]">{periodoAntes}</span></span>
        {t && <span className={t.favorable == null ? "" : t.favorable ? "text-green-700" : "text-red-700"}>{t.favorable ? "↑" : t.favorable === false ? "↓" : "→"} {t.texto}</span>}
      </div>
    </div>
  );
}

function MiniSerie({ puntos, campo, fmt }) {
  const vals = (puntos || []).map((p) => p[campo]).filter((x) => x != null && isFinite(x));
  if (vals.length < 2) return <p className="text-xs text-slate-400">Sin serie mensual. Pulsa Releer BC.</p>;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const ultimo = puntos[puntos.length - 1];
  return (
    <div>
      <div className="flex items-end gap-px h-14">
        {puntos.map((p) => {
          const val = p[campo];
          const h = val == null || !isFinite(val) ? 2 : 6 + ((val - min) / span) * 48;
          return <div key={p.mes} title={`${p.mes}: ${fmt(val)}`} className="flex-1 bg-blue-700/80 rounded-sm min-w-0" style={{ height: h }} />;
        })}
      </div>
      <div className="flex justify-between text-[10px] text-slate-400 mt-1">
        <span>{puntos[0].mes}</span>
        <span>{fmt(ultimo[campo])}</span>
        <span>{ultimo.mes}</span>
      </div>
    </div>
  );
}

function Barra({ etiqueta, valor, max, color }) {
  const w = max > 0 && valor != null ? Math.max(2, Math.min(100, (Math.abs(valor) / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[9rem_1fr_6rem] items-center gap-2 text-sm">
      <span className="text-slate-600">{etiqueta}</span>
      <div className="h-3 bg-slate-100 rounded overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${w}%` }} /></div>
      <span className="text-right font-medium">{eurCorto(valor)}</span>
    </div>
  );
}

export default function CuadroDireccion({ modo, datos, b, bp, g, gp }) {
  const r = datos.actual.resultados;
  const rp = datos.anterior.resultados;
  const dias = datos.actual.dias || 365;
  const anual = 365 / dias;
  const va = (n) => buscar(g, n);
  const vp = (n) => buscar(gp, n);
  const re = va("Rentabilidad económica (RE)");
  const rf = va("Rentabilidad financiera (RF)");
  const margen = va("Rentabilidad de las ventas (RV)");
  const liq = va("Liquidez general");
  const tes = va("Tesorería inmediata (disponibilidad)");
  const end = va("Endeudamiento total");
  const pmf = va("PM financiero (PMF)");
  const cobPm = va("Cobertura del punto muerto");
  const pme = va("PM de cobro (PMe)");
  const pmp = va("PM de pago (PMp)");
  const pma = va("PM de almacenamiento (PMa+PMc+PMv)");
  const fm = va("Fondo de maniobra (FM)");
  const ao = va("Apalancamiento operativo (Ao)");
  const pm = va("Punto muerto (en ventas)");
  const mEbitda = va("Margen EBITDA");
  const reP = vp("Rentabilidad económica (RE)");
  const rfP = vp("Rentabilidad financiera (RF)");
  const margenP = vp("Rentabilidad de las ventas (RV)");
  const liqP = vp("Liquidez general");
  const tesP = vp("Tesorería inmediata (disponibilidad)");
  const endP = vp("Endeudamiento total");
  const pmfP = vp("PM financiero (PMF)");
  const cobPmP = vp("Cobertura del punto muerto");
  const pmeP = vp("PM de cobro (PMe)");
  const pmpP = vp("PM de pago (PMp)");
  const fmP = vp("Fondo de maniobra (FM)");
  const pmP = vp("Punto muerto (en ventas)");
  const rot = div(r.VN * anual, b.A);
  const rotP = div(rp.VN * anual, bp.A);
  const margenNeto = div(r.BN, r.VN);
  const margenNetoP = div(rp.BN, rp.VN);
  const apal = div(b.A, b.K);
  const roce = div(r.EBIT, b.K + b.RA);
  const deuda = deudaFinanciera(datos.cuentas?.bal);
  const deudaEbitda = r.EBITDA > 0 ? div(deuda, r.EBITDA) : null;
  const nof = b.E + b.clientes - b.proveedores;
  const nofP = bp.E + bp.clientes - bp.proveedores;
  const cicloEco = (pma || 0) + (pme || 0);
  const seguridad = pm != null ? r.VN - pm : null;
  const segPct = div(seguridad, r.VN);

  const tension =
    (tes != null && tes < 0.15 ? 2 : tes != null && tes < 0.3 ? 1 : 0) +
    (pme != null && pme > 120 ? 2 : pme != null && pme > 90 ? 1 : 0) +
    (pmf != null && pmf > 120 ? 2 : pmf != null && pmf > 80 ? 1 : 0) +
    (fm != null && fm < 0 ? 2 : 0) +
    (liq != null && liq < 1 ? 2 : liq != null && liq < 1.5 ? 1 : 0) +
    (end != null && end > 1.8 ? 2 : end != null && end > 1.5 ? 1 : 0);
  const tensionEst = tension >= 5 ? "mal" : tension >= 2 ? "vig" : "ok";
  const tensionTxt = tensionEst === "mal" ? "Alta" : tensionEst === "vig" ? "Media" : "Baja";

  const [objetivoCobro, setObjetivoCobro] = useState(null);
  const [objetivoPago, setObjetivoPago] = useState(null);
  const [terceros, setTerceros] = useState(null);
  const [errTerceros, setErrTerceros] = useState("");
  useEffect(() => {
    if (modo !== "circulante") return;
    let vivo = true;
    setErrTerceros("");
    fetch("/api/contabilidad/circulante-terceros")
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.detalle || j.error || `Error ${res.status}`);
        if (vivo) setTerceros(j);
      })
      .catch((e) => { if (vivo) setErrTerceros(String(e.message || e)); });
    return () => { vivo = false; };
  }, [modo, datos.calculado]);

  const ventaDiaIva = div(r.VN * 1.21, dias);
  const compraDiaIva = div(r.compras * 1.21, dias);
  const cajaCobro = objetivoCobro != null && ventaDiaIva != null && pme != null ? ventaDiaIva * (pme - objetivoCobro) : null;
  const cajaPago = objetivoPago != null && compraDiaIva != null && pmp != null ? compraDiaIva * (objetivoPago - pmp) : null;

  const serie = datos.serie || [];
  const tramo = `${fmtFecha(datos.desde)} – ${fmtFecha(datos.hasta)}`;
  const tramoAntes = `${fmtFecha(datos.desdePrev)} – ${fmtFecha(datos.hastaPrev)}`;
  const cambios = [
    ["Rentabilidad económica", reP, re, pct, "sube"],
    ["Rentabilidad financiera", rfP, rf, pct, "sube"],
    ["Tesorería", bp.T, b.T, eur, "sube"],
    ["PM financiero", pmfP, pmf, diasF, "baja"],
    ["Punto muerto", pmP, pm, eur, "baja"],
    ["Clientes", bp.clientes, b.clientes, eur, "baja"],
    ["PM de cobro", pmeP, pme, diasF, "baja"],
    ["Endeudamiento", endP, end, (v) => num(v, 2), "baja"],
    ["Rotación del activo", rotP, rot, (v) => num(v, 2), "sube"],
  ].map(([nombre, antes, ahora, fmt, mejorSi]) => ({ nombre, antes, ahora, fmt, t: tendencia(ahora, antes, mejorSi) }))
    .filter((c) => c.t && c.t.favorable != null);

  const semaforo = [
    ["Rentabilidad", estadoDe("re", re), re != null && reP != null ? `${re > reP ? "Mejora" : "Empeora"}: de ${pct(reP)} (${tramoAntes}) a ${pct(re)} (${tramo})` : pct(re)],
    ["Liquidez", estadoDe("liq", liq), liq != null && liq >= 1.5 && liq <= 2 ? `Nivel adecuado: ${num(liq)}` : `Fuera de 1,5–2: ${num(liq)}`],
    ["Tesorería", estadoDe("tes", tes), `Disponibilidad ${num(tes)}. Objetivo ≥ 0,30`],
    ["Endeudamiento", estadoDe("end", end), end != null && end <= 1.5 ? `Dentro de 0,5–1,5: ${num(end)}` : `Por encima de 1,5: ${num(end)}`],
    ["Clientes", estadoDe("pme", pme), `Cobro ${diasF(pme)}`],
    ["Proveedores", estadoDe("pmp", pmp), `Pago ${diasF(pmp)}`],
    ["Punto muerto", estadoDe("cobPm", cobPm), cobPm != null ? (cobPm >= 1 ? `${pct(cobPm - 1)} por encima del umbral` : "Por debajo del umbral") : "—"],
    ["Fondo de maniobra", estadoDe("fm", fm), fm > 0 ? `Positivo: ${eur(fm)}` : `Negativo: ${eur(fm)}`],
  ];

  const tarjetas = [
    ["Rentabilidad económica", re, reP, pct, "sube", "re"],
    ["Rentabilidad financiera", rf, rfP, pct, "sube", "rf"],
    ["Margen explotación", margen, margenP, pct, "sube", "margen"],
    ["Liquidez", liq, liqP, (v) => num(v), "sube", "liq"],
    ["Tesorería inmediata", tes, tesP, (v) => num(v), "sube", "tes"],
    ["Endeudamiento", end, endP, (v) => num(v), "baja", "end"],
    ["PM financiero", pmf, pmfP, diasF, "baja", "pmf"],
    ["Cobertura punto muerto", cobPm, cobPmP, (v) => num(v), "sube", "cobPm"],
  ];

  return (
    <div className="grid gap-5 mt-4">
      {modo === "direccion" && (
        <>
          <section>
            <h2 className="font-semibold text-slate-800">Cuadro de mando</h2>
            <p className="text-xs text-slate-500 mt-0.5">La cifra grande es {tramo}. «Antes» es {tramoAntes}, con los movimientos de contabilidad. La flecha indica si la situación mejora o empeora, no si el número sube. En endeudamiento o en días de cobro, bajar es mejor.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              {tarjetas.map(([titulo, actual, prev, fmt, mejorSi, id]) => (
                <Tarjeta key={titulo} titulo={titulo} actual={actual} prev={prev} fmt={fmt} mejorSi={mejorSi} estado={estadoDe(id, actual)} periodo={tramo} periodoAntes={tramoAntes} />
              ))}
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800">Diagnóstico automático</h2>
            <p className="text-xs text-slate-500 mt-0.5">Cifras de {tramo}. Cuando dice «antes», es {tramoAntes}.</p>
            <div className="text-sm text-slate-700 mt-2 grid gap-2 leading-relaxed">
              <p>La rentabilidad económica es {pct(re)} (antes, {tramoAntes}: {pct(reP)}) y la financiera {pct(rf)} (antes, {tramoAntes}: {pct(rfP)}). {re != null && reP != null && re > reP ? `La rentabilidad ha mejorado respecto a ${tramoAntes}.` : `La rentabilidad no mejora respecto a ${tramoAntes}.`}</p>
              <p>La tesorería inmediata es {num(tes)}: por cada euro de deuda a corto hay {num(tes)} € en el banco. {tes != null && tes < 0.3 ? "Está por debajo del objetivo de 0,30." : "Está en el objetivo de 0,30 o por encima."} La liquidez general es {num(liq)}.</p>
              <p>El cobro medio es de {diasF(pme)} y el pago a proveedores de {diasF(pmp)}. El ciclo, restando lo que financian los proveedores, pide unos {diasF(pmf)} de financiación.</p>
              <p>La cobertura del punto muerto es {num(cobPm)}. {cobPm != null && cobPm >= 1 ? `Las ventas superan el umbral, con un margen de seguridad de ${eur(seguridad)} (${pct(segPct)} de las ventas).` : "Las ventas no llegan al umbral de rentabilidad."} {r.EBIT > 0 && b.T < b.clientes ? "El negocio puede ganar dinero y, a la vez, tener poca caja: el beneficio está en clientes y en existencias." : ""}</p>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b bg-slate-50 font-semibold text-slate-800">Semáforo financiero</div>
            <table className="w-full text-sm">
              <tbody>
                {semaforo.map(([area, est, comentario]) => (
                  <tr key={area} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium w-40">{area}</td>
                    <td className="px-4 py-2 w-16">{PUNTO[est]}</td>
                    <td className="px-4 py-2 text-slate-600">{comentario}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <p className="md:col-span-2 text-xs text-slate-500 -mb-2">
              Comparación con los movimientos de contabilidad. La cifra de la izquierda es {tramoAntes}. La de la derecha es {tramo}.
            </p>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">Qué ha mejorado</h2>
              <p className="text-[11px] text-slate-400 mt-0.5">{tramoAntes} → {tramo}</p>
              <ul className="mt-2 text-sm grid gap-1">
                {cambios.filter((c) => c.t.favorable).map((c) => (
                  <li key={c.nombre} className="text-green-800">{c.nombre}: {c.fmt(c.antes)} → {c.fmt(c.ahora)}</li>
                ))}
                {!cambios.some((c) => c.t.favorable) && <li className="text-slate-400">Ningún cambio claro a mejor.</li>}
              </ul>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">A vigilar</h2>
              <p className="text-[11px] text-slate-400 mt-0.5">{tramoAntes} → {tramo}</p>
              <ul className="mt-2 text-sm grid gap-1">
                {cambios.filter((c) => c.t.favorable === false).map((c) => (
                  <li key={c.nombre} className="text-amber-900">{c.nombre}: {c.fmt(c.antes)} → {c.fmt(c.ahora)}</li>
                ))}
                {!cambios.some((c) => c.t.favorable === false) && <li className="text-slate-400">Ningún cambio claro a peor.</li>}
              </ul>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800">Rentabilidad financiera {pct(rf)}</h2>
            <p className="text-xs text-slate-500 mt-1">Se descompone en margen neto × rotación del activo × apalancamiento. Así se ve si la rentabilidad viene del margen, de vender mucho con el activo, o de la deuda.</p>
            <div className="grid grid-cols-3 gap-3 mt-3 text-center">
              {[["Margen neto", pct(margenNeto), "Beneficio líquido / ventas"], ["Rotación", num(rot), "Ventas / activo"], ["Apalancamiento", num(apal), "Activo / patrimonio"]].map(([t, n, s]) => (
                <div key={t} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">{t}</div>
                  <div className="text-xl font-semibold">{n}</div>
                  <div className="text-[11px] text-slate-400">{s}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">Margen de seguridad del punto muerto</h2>
              <div className="grid gap-2 mt-3">
                <Barra etiqueta="Ventas" valor={r.VN} max={Math.max(r.VN || 0, pm || 0)} color="bg-blue-600" />
                <Barra etiqueta="Punto muerto" valor={pm} max={Math.max(r.VN || 0, pm || 0)} color="bg-slate-500" />
                <Barra etiqueta="Margen" valor={seguridad} max={Math.max(r.VN || 0, pm || 0)} color={seguridad >= 0 ? "bg-green-600" : "bg-red-600"} />
              </div>
              <p className="text-xs text-slate-500 mt-2">Margen de seguridad: {eur(seguridad)} ({pct(segPct)} de las ventas). Es el punto muerto contable, el de costes, sin el desfase de cobro y pago.</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">Sensibilidad del beneficio · apalancamiento {num(ao)}</h2>
              <p className="text-xs text-slate-500 mt-1">Aproximación: si las ventas cambian un 1 %, el beneficio de explotación cambia cerca de un {num(ao, 1)} %. No es una previsión exacta.</p>
              <table className="w-full text-sm mt-2">
                <thead><tr className="text-xs text-slate-500 text-left"><th className="py-1">Cambio ventas</th><th className="py-1 text-right">Cambio estimado del BE</th></tr></thead>
                <tbody>
                  {[-10, -5, -2, 2, 5, 10].map((p) => (
                    <tr key={p} className="border-t border-slate-100">
                      <td className="py-1">{p > 0 ? "+" : ""}{p} %</td>
                      <td className={`py-1 text-right ${ao != null && p * ao < 0 ? "text-red-700" : "text-green-800"}`}>{ao == null ? "—" : `${(p * ao) > 0 ? "+" : ""}${(p * ao).toLocaleString("es-ES", { maximumFractionDigits: 0 })} %`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid md:grid-cols-4 gap-3">
            {[
              ["EBITDA", eur(r.EBITDA), `Antes (${tramoAntes}): ${eur(rp.EBITDA)}`],
              ["Margen EBITDA", pct(mEbitda), `EBITDA / ventas de ${tramo}`],
              ["Margen neto", pct(margenNeto), `Antes (${tramoAntes}): ${pct(margenNetoP)}`],
              ["ROCE", pct(roce), "EBIT / (patrimonio + deuda a largo)"],
              ["Deuda financiera / EBITDA", deudaEbitda == null ? "—" : num(deudaEbitda), `Deuda bancaria aprox. ${eur(deuda)}`],
              ["DSO (días de cobro)", diasF(pme), "Es el periodo medio de cobro, no el vencimiento de cada factura"],
              ["Tensión de tesorería", tensionTxt, "Junta disponibilidad, cobro, ciclo, fondo de maniobra, liquidez y deuda"],
            ].map(([t, n, s]) => (
              <div key={t} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs text-slate-500">{t}</div>
                <div className="text-lg font-semibold mt-1">{n}</div>
                <div className="text-[11px] text-slate-400 mt-1">{s}</div>
              </div>
            ))}
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800">Evolución de los últimos meses</h2>
            <p className="text-xs text-slate-500 mt-1">Cada punto es el cierre de ese mes, con la cuenta de resultados desde enero. Rentabilidad económica y financiera van anualizadas, igual que en las tablas.</p>
            <div className="grid md:grid-cols-2 gap-4 mt-3">
              {[
                ["Rentabilidad económica", "re", pct],
                ["Rentabilidad financiera", "rf", pct],
                ["Margen explotación", "margen", pct],
                ["Tesorería", "tesoreria", eur],
                ["Endeudamiento", "endeudamiento", (v) => num(v)],
                ["Fondo de maniobra", "fm", eur],
                ["Clientes", "clientes", eur],
                ["Proveedores", "proveedores", eur],
                ["PM cobro", "pme", diasF],
                ["PM pago", "pmp", diasF],
              ].map(([titulo, campo, fmt]) => (
                <div key={campo}>
                  <div className="text-sm font-medium text-slate-700 mb-1">{titulo}</div>
                  <MiniSerie puntos={serie} campo={campo} fmt={fmt} />
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {modo === "circulante" && (
        <>
          <section className={`rounded-xl border p-4 ${COLOR[tensionEst]}`}>
            <h2 className="font-semibold">Tensión de tesorería: {tensionTxt}</h2>
            <p className="text-sm mt-1">Disponibilidad {num(tes)} · cobro {diasF(pme)} · pago {diasF(pmp)} · ciclo {diasF(pmf)} · fondo de maniobra {eur(fm)} · liquidez {num(liq)} · deuda/patrimonio {num(end)}</p>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800">Ciclo de caja (cash conversion cycle)</h2>
            <div className="grid gap-2 mt-3 text-sm">
              <div className="flex items-center gap-2"><span className="w-28 text-slate-500">Almacén</span><div className="h-4 bg-amber-400 rounded" style={{ width: `${Math.min(100, (pma || 0) / Math.max(cicloEco, 1) * 70)}%` }} /><span>{diasF(pma)}</span></div>
              <div className="flex items-center gap-2"><span className="w-28 text-slate-500">Hasta cobrar</span><div className="h-4 bg-blue-500 rounded" style={{ width: `${Math.min(100, (pme || 0) / Math.max(cicloEco, 1) * 70)}%` }} /><span>{diasF(pme)}</span></div>
              <div className="text-slate-700">Ciclo económico: <b>{diasF(cicloEco)}</b></div>
              <div className="flex items-center gap-2"><span className="w-28 text-slate-500">Proveedores</span><div className="h-4 bg-green-500 rounded" style={{ width: `${Math.min(100, (pmp || 0) / Math.max(cicloEco, 1) * 70)}%` }} /><span>− {diasF(pmp)}</span></div>
              <div className={pmf > 90 ? "text-red-700 font-semibold" : "font-semibold"}>Necesidad de financiación: {diasF(pmf)}</div>
            </div>
            <p className="text-xs text-slate-500 mt-2">Los días salen del saldo de clientes, existencias y proveedores. No son la fecha de vencimiento escrita en cada factura.</p>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800">Dinero en el ciclo operativo</h2>
            <p className="text-sm text-slate-700 mt-2">Existencias {eur(b.E)} + clientes {eur(b.clientes)} − proveedores {eur(b.proveedores)}</p>
            <p className="text-xl font-semibold mt-1">{eur(nof)}</p>
            <p className="text-xs text-slate-500">En {tramoAntes}: {eur(nofP)}. La cifra de arriba es {tramo}. Si has cambiado las existencias a mano, esta cifra usa ese importe.</p>
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">Si cobráramos antes</h2>
              <p className="text-xs text-slate-500 mt-1">PM de cobro actual: {diasF(pme)}. La caja que se liberaría es ventas con IVA / días del periodo × días que adelantas el cobro.</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {[60, 75, 90, 100, 120].map((d) => (
                  <button key={d} type="button" onClick={() => setObjetivoCobro(d)} className={`px-2 py-1 rounded border text-sm ${objetivoCobro === d ? "bg-blue-700 text-white border-blue-700" : "border-slate-300"}`}>{d} días</button>
                ))}
              </div>
              {cajaCobro != null && <p className={`mt-3 font-semibold ${cajaCobro >= 0 ? "text-green-800" : "text-red-700"}`}>{cajaCobro >= 0 ? "Caja que se liberaría" : "Caja que se inmovilizaría"}: {eur(Math.abs(cajaCobro))}</p>}
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-semibold text-slate-800">Si cambiara el plazo de pago</h2>
              <p className="text-xs text-slate-500 mt-1">PM de pago actual: {diasF(pmp)}. Pagar más tarde libera caja; que te exijan pagar antes, la consume.</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {[30, 60, 90, 100, 120].map((d) => (
                  <button key={d} type="button" onClick={() => setObjetivoPago(d)} className={`px-2 py-1 rounded border text-sm ${objetivoPago === d ? "bg-blue-700 text-white border-blue-700" : "border-slate-300"}`}>{d} días</button>
                ))}
              </div>
              {cajaPago != null && <p className={`mt-3 font-semibold ${cajaPago >= 0 ? "text-green-800" : "text-red-700"}`}>Impacto en tesorería: {cajaPago >= 0 ? "+" : "−"}{eur(Math.abs(cajaPago))}</p>}
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-4">
            <Ranking titulo="Clientes que más dinero inmovilizan" filas={terceros?.clientes} error={errTerceros} columna="Días desde la factura" />
            <Ranking titulo="Proveedores con facturas abiertas" filas={terceros?.proveedores} error={errTerceros} columna="Días desde la factura" proveedores />
          </section>
          <p className="text-xs text-slate-400">El ranking usa las facturas abiertas de Business Central, con su fecha de factura y su fecha de vencimiento. El plazo pactado es vencimiento menos fecha de factura. El periodo medio de cobro y de pago de las tablas sigue siendo una media de saldos, no este ranking.</p>
        </>
      )}
    </div>
  );
}

function Ranking({ titulo, filas, error, proveedores }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50 font-semibold text-slate-800">{titulo}</div>
      {error && <p className="px-4 py-3 text-sm text-red-700">{error}</p>}
      {!error && !filas && <p className="px-4 py-3 text-sm text-slate-500">Leyendo facturas abiertas…</p>}
      {filas && filas.length === 0 && <p className="px-4 py-3 text-sm text-slate-500">No hay facturas abiertas.</p>}
      {filas && filas.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 text-left">
              <th className="px-3 py-2">{proveedores ? "Proveedor" : "Cliente"}</th>
              <th className="px-3 py-2 text-right">Pendiente</th>
              <th className="px-3 py-2 text-right">Antigüedad</th>
              <th className="px-3 py-2 text-right">Plazo pactado</th>
              <th className="px-3 py-2 text-right">Peso</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.nombre} className="border-t border-slate-100">
                <td className="px-3 py-2">{f.nombre}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{eur(f.pendiente)}</td>
                <td className="px-3 py-2 text-right">{diasF(f.dias)}</td>
                <td className="px-3 py-2 text-right">{diasF(f.plazo)}</td>
                <td className="px-3 py-2 text-right">{pct(f.peso)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
