/**
 * ratios.jsx — Pantalla «Ratios financieros» (24/09/2026).
 *
 * Fórmulas de los apuntes de ADE (Temas 4 y 6): cuenta de resultados,
 * rentabilidades y Dupont, ratios de situación (CP y LP), rotación,
 * periodos medios de maduración, apalancamientos y punto muerto.
 *
 * Datos: backend /api/contabilidad/ratios (movs. de contabilidad de BC de
 * la empresa seleccionada). Solo lectura.
 */
import React, { useEffect, useState } from "react";
import Indicadores from "./indicadores.jsx";

const hoy = () => new Date().toISOString().slice(0, 10);
const eur = (v) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }));
const div = (a, b) => (b && isFinite(a / b) ? a / b : null);

const FORMATOS = {
  pct: (v) => (v == null ? "—" : `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`),
  x: (v) => (v == null ? "—" : v.toLocaleString("es-ES", { maximumFractionDigits: 2 })),
  dias: (v) => (v == null ? "—" : `${Math.round(v).toLocaleString("es-ES")} días`),
  eur,
};

// Cada ratio: [nombre, fórmula, función(balance, resultados, días), formato, comentario, semáforo opcional]
function grupos(b, r, dias) {
  const anual = 365 / (dias || 365); // para anualizar rotaciones y rentabilidades si el periodo es parcial
  const CFm = r.CF;
  const cvUnit = div(r.CV, r.VN); // coste variable por € vendido
  return [
    {
      titulo: "Cuenta de resultados (Tema 4)",
      filas: [
        ["Ventas brutas (VB)", "Cuentas 700–705", r.VB, "eur"],
        ["Ventas netas (VN)", "VB − devoluciones − descuentos", r.VN, "eur"],
        ["Margen bruto", "VN − costes variables (consumos 60/61)", r.MB, "eur"],
        ["EBITDA", "Ingresos de explotación − gastos de explotación (sin amortizaciones)", r.EBITDA, "eur"],
        ["EBIT = BE (Bº explotación)", "EBITDA − amortizaciones − deterioros", r.EBIT, "eur"],
        ["BNO (Bº neto ordinario)", "EBIT + ingresos financieros − gastos financieros", r.BNO, "eur"],
        ["BAI", "BNO ± extraordinarios", r.BAI, "eur"],
        ["BN (Bº líquido)", "BAI − impuestos", r.BN, "eur"],
        ["Margen bruto %", "Margen bruto / VN", div(r.MB, r.VN), "pct"],
        ["Margen EBITDA", "EBITDA / ventas", div(r.EBITDA, r.VN), "pct"],
      ],
    },
    {
      titulo: "Rentabilidad y Dupont",
      nota: dias < 360 ? `Periodo de ${dias} días: rentabilidades y rotaciones anualizadas (×365/${dias}).` : null,
      filas: [
        ["Rentabilidad económica (RE)", "BE / A", div(r.EBIT * anual, b.A), "pct", "Lo que rinde el activo, sin mirar cómo se financia."],
        ["Rentabilidad financiera (RF)", "BN / K", div(r.BN * anual, b.K), "pct", "Lo que rinde el dinero de los socios."],
        ["Rentabilidad de las ventas (RV)", "BE / V", div(r.EBIT, r.VN), "pct", "Margen de explotación por € vendido."],
        ["Rotación del activo (rT)", "V / A", div(r.VN * anual, b.A), "x", "RE = RV · rT"],
        ["Dupont: rentabilidad total", "BN / A = BN/V · V/A", div(r.BN * anual, b.A), "pct"],
        ["RF descompuesta", "BN/V · V/A · A/K", div(r.BN, r.VN) != null && div(r.VN * anual, b.A) != null && div(b.A, b.K) != null ? div(r.BN, r.VN) * div(r.VN * anual, b.A) * div(b.A, b.K) : null, "pct", "Margen · rotación · apalancamiento"],
      ],
    },
    {
      titulo: "Ratios de situación a corto plazo",
      filas: [
        ["Liquidez general", "AC / PC", div(b.AC, b.PC), "x", "Ideal entre 1,5 y 2.", [1.5, 2]],
        ["Tesorería ordinaria (acid test)", "(T + R) / PC", div(b.T + b.R, b.PC), "x", "Ideal ≈ 1.", [0.8, 1.2]],
        ["Tesorería inmediata (disponibilidad)", "T / PC", div(b.T, b.PC), "x", "Ideal ≈ 0,3.", [0.2, 0.5]],
        ["Fondo de maniobra (FM)", "AC − PC", b.FM, "eur", "Positivo = el AC cubre las deudas a corto."],
        ["Capital propio en circulante", "FM / K", div(b.FM, b.K), "x"],
      ],
    },
    {
      titulo: "Ratios de situación a largo plazo",
      filas: [
        ["Garantía (distancia a la quiebra)", "A / D", div(b.A, b.D), "x", "Ideal > 1,5 (mínimo 1).", [1.5, 99]],
        ["Endeudamiento total", "D / K", div(b.D, b.K), "x", "Ideal entre 0,5 y 1,5.", [0.5, 1.5]],
        ["Endeudamiento a corto", "PC / K", div(b.PC, b.K), "x"],
        ["Endeudamiento a largo", "RA / K", div(b.RA, b.K), "x"],
        ["Apalancamiento (A/K)", "A / K = D/K + 1", div(b.A, b.K), "x"],
        ["Autonomía", "K / D", div(b.K, b.D), "x"],
        ["Financiación del inmovilizado", "CP / AF", div(b.CP, b.AF), "x", "> 1: el inmovilizado está financiado con capitales permanentes.", [1, 99]],
        ["Capital propio inmovilizado", "(AF − RA) / K", div(b.AF - b.RA, b.K), "x"],
      ],
    },
    {
      titulo: "Ratios de rotación",
      filas: [
        ["Rotación del activo", "V / A", div(r.VN * anual, b.A), "x"],
        ["Rotación del activo fijo", "V / AF", div(r.VN * anual, b.AF), "x"],
        ["Rotación del activo circulante", "V / AC", div(r.VN * anual, b.AC), "x"],
        ["Rotación de clientes", "V / clientes", div(r.VN * anual, b.clientes), "x"],
        ["Rotación de existencias", "Consumo / E", div(r.consumos * anual, b.E), "x"],
        ["Rotación de capitales permanentes", "V / CP", div(r.VN * anual, b.CP), "x"],
        ["Rotación del capital propio", "V / K", div(r.VN * anual, b.K), "x"],
      ],
    },
    {
      titulo: "Periodos medios (maduración)",
      nota: "Aproximación con saldos a la fecha: PM = saldo / flujo del periodo × días del periodo.",
      filas: [
        ["PM de almacenamiento (PMa+PMc+PMv)", "E / consumos × días", div(b.E, r.consumos) != null ? div(b.E, r.consumos) * dias : null, "dias"],
        ["PM de cobro (PMe)", "Clientes / ventas × días", div(b.clientes, r.VN * 1.21) != null ? div(b.clientes, r.VN * 1.21) * dias : null, "dias", "Ventas con IVA (21 %), porque el saldo de clientes lleva IVA."],
        ["PM de pago (PMp)", "Proveedores / compras × días", div(b.proveedores, r.compras * 1.21) != null ? div(b.proveedores, r.compras * 1.21) * dias : null, "dias", "Compras con IVA (21 %)."],
        [
          "Cobertura ante impagos (días de caja)",
          "Tesorería / ventas diarias c/IVA",
          (() => {
            const ventasDia = div(r.VN * 1.21, dias);
            return ventasDia ? b.T / ventasDia : null;
          })(),
          "dias",
          "Días que aguantas sin cobrar nada usando solo la tesorería actual. En «Indicadores» puedes simular retrasos de cobro.",
        ],
      ].concat([
        (() => {
          const pma = div(b.E, r.consumos) != null ? div(b.E, r.consumos) * dias : 0;
          const pme = div(b.clientes, r.VN * 1.21) != null ? div(b.clientes, r.VN * 1.21) * dias : 0;
          const pmp = div(b.proveedores, r.compras * 1.21) != null ? div(b.proveedores, r.compras * 1.21) * dias : 0;
          return ["PM financiero (PMF)", "PM económico − PMp", pma + pme - pmp, "dias", "Días que la empresa tiene que financiar el ciclo."];
        })(),
      ]),
    },
    {
      titulo: "Apalancamiento operativo y financiero (Tema 6)",
      nota: "Costes variables ≈ consumos (60/61). Costes fijos ≈ servicios exteriores, tributos, personal, otros gastos y amortizaciones.",
      filas: [
        ["Apalancamiento operativo (Ao)", "(BE + CF) / BE", div(r.EBIT + CFm, r.EBIT), "x", "Si las ventas suben un 1 %, el BE sube Ao %."],
        ["Apalancamiento financiero (Af)", "BE / BN (antes de impuestos: BE / (BE − F))", div(r.EBIT, r.EBIT - r.F), "x"],
        ["Apalancamiento total (At)", "Ao · Af", div(r.EBIT + CFm, r.EBIT) != null && div(r.EBIT, r.EBIT - r.F) != null ? div(r.EBIT + CFm, r.EBIT) * div(r.EBIT, r.EBIT - r.F) : null, "x"],
        ["Punto muerto (en ventas)", "CF / (1 − CV/V)", cvUnit != null && cvUnit < 1 ? CFm / (1 - cvUnit) : null, "eur", "Ventas del periodo necesarias para no perder dinero."],
        ["Cobertura del punto muerto", "VN / punto muerto", cvUnit != null && cvUnit < 1 ? div(r.VN, CFm / (1 - cvUnit)) : null, "x", "> 1: se está por encima del punto muerto."],
      ],
    },
  ];
}

function colorSemaforo(v, rango) {
  if (!rango || v == null) return "";
  const [min, max] = rango;
  if (v >= min && v <= max) return "text-green-700";
  if (v >= min * 0.7 && v <= max * 1.3) return "text-amber-600";
  return "text-red-600";
}

function Tabla({ titulo, nota, filas, filasPrev, etiqActual, etiqPrev }) {
  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h2 className="font-semibold text-slate-800">{titulo}</h2>
        {nota && <p className="text-xs text-slate-500 mt-0.5">{nota}</p>}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="px-4 py-2 font-medium">Ratio</th>
            <th className="px-4 py-2 font-medium">Fórmula</th>
            <th className="px-4 py-2 font-medium text-right">{etiqActual}</th>
            <th className="px-4 py-2 font-medium text-right">{etiqPrev}</th>
          </tr>
        </thead>
        <tbody>
          {filas.map(([nombre, formula, v, fmt, comentario, rango], i) => {
            const vp = filasPrev[i]?.[2];
            return (
              <tr key={nombre} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2">
                  <div className="font-medium text-slate-700">{nombre}</div>
                  {comentario && <div className="text-xs text-slate-400">{comentario}</div>}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-slate-500">{formula}</td>
                <td className={`px-4 py-2 text-right font-semibold whitespace-nowrap ${colorSemaforo(v, rango)}`}>{FORMATOS[fmt](v)}</td>
                <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">{FORMATOS[fmt](vp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Masas({ b, bp }) {
  const filas = [
    ["Activo fijo (AF)", b.AF, bp.AF],
    ["Existencias (E)", b.E, bp.E],
    ["Realizable (R)", b.R, bp.R],
    ["  · de ello clientes", b.clientes, bp.clientes],
    ["Tesorería (T)", b.T, bp.T],
    ["Activo circulante (AC)", b.AC, bp.AC],
    ["ACTIVO (A)", b.A, bp.A],
    ["Patrimonio neto (K)", b.K, bp.K],
    ["Pasivo no corriente (RA)", b.RA, bp.RA],
    ["Pasivo corriente (PC)", b.PC, bp.PC],
    ["  · de ello proveedores", b.proveedores, bp.proveedores],
    ["Deudas totales (D)", b.D, bp.D],
  ];
  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h2 className="font-semibold text-slate-800">Masas patrimoniales (desde movs. de contabilidad)</h2>
        <p className="text-xs text-slate-500 mt-0.5">Agrupación por cuentas del Plan General Contable.</p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {filas.map(([n, v, vp]) => (
            <tr key={n} className={`border-t border-slate-100 ${["Activo circulante (AC)", "ACTIVO (A)", "Patrimonio neto (K)", "Deudas totales (D)"].includes(n) ? "font-bold" : ""}`}>
              <td className="px-4 py-1.5 whitespace-pre text-slate-700">{n}</td>
              <td className="px-4 py-1.5 text-right">{eur(v)}</td>
              <td className="px-4 py-1.5 text-right text-slate-400">{eur(vp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Math.abs(b.descuadre) > 1 && (
        <p className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-t">
          ⚠ Activo − (K + RA + PC) = {eur(b.descuadre)}. Hay cuentas fuera de la agrupación estándar (p. ej. IVA, cuentas puente o 4xx no clasificadas); los ratios son aproximados.
        </p>
      )}
    </section>
  );
}

export default function Ratios() {
  const [hasta, setHasta] = useState(hoy());
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [pestana, setPestana] = useState("ratios");

  const cargar = async (refrescar = false) => {
    setCargando(true);
    setError("");
    try {
      const r = await fetch(`/api/contabilidad/ratios?hasta=${hasta}${refrescar ? "&refrescar=1" : ""}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      setDatos(j);
    } catch (e) {
      setError(String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend. ¿Está arrancado (INICIAR.bat)?" : String(e.message || e));
    } finally {
      setCargando(false);
    }
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtF = (s) => (s ? s.split("-").reverse().join("/") : "");
  const g = datos ? grupos(datos.actual.balance, datos.actual.resultados, datos.actual.dias) : [];
  const gp = datos ? grupos(datos.anterior.balance, datos.anterior.resultados, datos.anterior.dias) : [];
  const etiqActual = datos ? `${fmtF(datos.desde)} – ${fmtF(datos.hasta)}` : "Actual";
  const etiqPrev = datos ? `${fmtF(datos.desdePrev)} – ${fmtF(datos.hastaPrev)}` : "Año anterior";

  return (
    <div className={pestana === "ratios" ? "max-w-6xl" : "max-w-[1400px]"}>
      <h1 className="text-2xl font-bold text-slate-800">📊 Ratios financieros</h1>
      <p className="text-slate-500 text-sm mt-1 max-w-3xl">
        Fórmulas de los apuntes (cuenta de resultados, rentabilidades, Dupont, situación, rotación, periodos medios y
        apalancamientos) calculadas con los movimientos de contabilidad de Business Central{datos?.empresa ? ` de ${datos.empresa}` : ""}.
        Balance a la fecha indicada; cuenta de resultados desde el 1 de enero hasta esa fecha, comparada con el mismo periodo del año anterior.
      </p>

      <div className="flex items-end gap-3 mt-4">
        <label className="text-sm text-slate-600">
          Hasta fecha
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="block border rounded px-2 py-1 mt-1" />
        </label>
        <button onClick={() => cargar(false)} disabled={cargando} className="px-4 py-2 rounded bg-blue-700 text-white text-sm disabled:opacity-50">
          {cargando ? "Calculando…" : "Calcular"}
        </button>
        <button onClick={() => cargar(true)} disabled={cargando} className="px-3 py-2 rounded border text-sm disabled:opacity-50" title="Vuelve a leer los movimientos de BC (sin caché)">
          ↻ Releer BC
        </button>
        {datos && (
          <span className="text-xs text-slate-400 ml-2">
            {datos.movimientos.toLocaleString("es-ES")} movimientos leídos
            {datos.movsCierreExcluidos ? ` · ${datos.movsCierreExcluidos} de regularización/cierre excluidos de la cuenta de resultados` : ""}
            {datos.deCache ? " · (caché)" : ""}
          </span>
        )}
      </div>
      {cargando && !datos && <p className="text-sm text-slate-500 mt-4">Leyendo los movimientos de contabilidad de BC… la primera vez puede tardar un par de minutos.</p>}
      {error && <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</p>}

      <div className="flex gap-1 mt-5 border-b">
        {[["ratios", "Ratios"], ["indicadores", "Indicadores económicos y escenarios"]].map(([k, t]) => (
          <button key={k} onClick={() => setPestana(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === k ? "border-blue-700 text-blue-800 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {t}
          </button>
        ))}
      </div>
      {pestana === "indicadores" && <Indicadores datos={datos} />}

      {pestana === "ratios" && datos && (
        <div className="grid gap-5 mt-6">
          {g.map((grupo, i) => (
            <Tabla key={grupo.titulo} {...grupo} filasPrev={gp[i].filas} etiqActual={etiqActual} etiqPrev={etiqPrev} />
          ))}
          <Masas b={datos.actual.balance} bp={datos.anterior.balance} />
          <p className="text-xs text-slate-400">
            Criterios: activo en positivo, pasivo y patrimonio neto en positivo. El patrimonio neto incluye el resultado del ejercicio aunque no esté cerrado.
            Colores (verde/ámbar/rojo) solo en los ratios que tienen valor ideal en los apuntes.
          </p>
        </div>
      )}
    </div>
  );
}
