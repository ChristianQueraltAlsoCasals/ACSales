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
import CuadroDireccion from "./cuadroDireccion.jsx";

const hoy = () => new Date().toISOString().slice(0, 10);
const inicioAnio = (iso) => `${String(iso || hoy()).slice(0, 4)}-01-01`;
const eur = (v) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }));
const div = (a, b) => (b && isFinite(a / b) ? a / b : null);
const plano = (v) => (v == null || !isFinite(v) ? "" : v.toLocaleString("es-ES", { maximumFractionDigits: 2 }));

// Acepta 150000, 150.000 y 150.000,50 (punto de miles, coma decimal).
function parseImporte(texto) {
  if (texto == null) return null;
  let s = String(texto).trim().replace(/\s/g, "").replace(/€/g, "");
  if (!s || s === "-") return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  if (!s) return null;
  let n;
  if (s.includes(",")) n = Number(s.replace(/\./g, "").replace(",", "."));
  else if ((s.match(/\./g) || []).length > 1 || /^\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ""));
  else n = Number(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// Sustituye existencias y arrastra activo circulante, activo total, fondo de maniobra y descuadre.
function conExistencias(b, valor) {
  if (!b || valor == null || !isFinite(valor)) return b;
  const delta = valor - b.E;
  if (Math.abs(delta) < 0.005) return b;
  return { ...b, E: valor, AC: b.AC + delta, A: b.A + delta, FM: b.FM + delta };
}

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
  // Vencimiento medio de cobro y de pago (los mismos plazos que los periodos medios).
  const pme = div(b.clientes, r.VN * 1.21) != null ? div(b.clientes, r.VN * 1.21) * dias : 0;
  const pmp = div(b.proveedores, r.compras * 1.21) != null ? div(b.proveedores, r.compras * 1.21) * dias : 0;
  const fAnual = (r.F || 0) * (365 / (dias || 365));
  const baseFin = Math.max(b.clientes + b.E - b.proveedores, b.RA || 0);
  let iAnual = 0.04;
  if (fAnual > 0 && baseFin > 1000) {
    const impl = fAnual / baseFin;
    if (impl > 0 && impl < 0.25) iAnual = impl;
  }
  // Cada euro vendido cuesta el interés de los días que cobras más tarde de lo que pagas.
  const kDesfase = iAnual * (pme - pmp) / 365;
  const denomFin = cvUnit != null ? (1 - cvUnit) - kDesfase : null;
  const pmFin = denomFin != null && denomFin > 0.02 ? (CFm + (r.F || 0)) / denomFin : null;
  const cajaDesfase = pmFin != null && dias ? (pmFin * 1.21 / dias) * (pme - (cvUnit || 0) * pmp) : null;
  const tipoTxt = `${(iAnual * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;
  const explicaPmFin = `Ventas del periodo para cubrir costes fijos e intereses, descontando lo que cuesta el desfase entre cobros y pagos. Cobras a los clientes a los ${Math.round(pme)} días y pagas el material a los ${Math.round(pmp)} días; el coste del dinero usado es el ${tipoTxt}. ${cajaDesfase == null ? "" : cajaDesfase >= 0 ? `A ese nivel de ventas, adelantas unos ${eur(cajaDesfase)} (cobras más tarde de lo que pagas).` : `A ese nivel de ventas, los proveedores te financian unos ${eur(-cajaDesfase)} porque pagas más tarde de lo que cobras.`}`;
  return [
    {
      titulo: "Cuenta de resultados (Tema 4)",
      filas: [
        ["Ventas brutas (VB)", "Cuentas 700–705", r.VB, "eur", "Todo lo facturado a clientes, antes de quitar devoluciones y descuentos. Ejemplo: si las facturas del año suman 100.000 €, las ventas brutas son 100.000 €."],
        ["Ventas netas (VN)", "VB − devoluciones − descuentos", r.VN, "eur", "Lo que se queda de verdad de las ventas. Ejemplo: 100.000 € facturados − 3.000 € devueltos − 2.000 € de descuentos = 95.000 €."],
        ["Margen bruto", "VN − costes variables (consumos 60/61)", r.MB, "eur", "Lo que queda de las ventas después de pagar el material y los consumos. Ejemplo: vendes 95.000 € y el material cuesta 40.000 € → quedan 55.000 €."],
        ["EBITDA", "Ingresos de explotación − gastos de explotación (sin amortizaciones) + cuenta 771", r.EBITDA, "eur", "El beneficio de la actividad diaria, antes de desgastar máquinas, pagar intereses o impuestos. También suma la cuenta 771 (el beneficio si vendes una máquina o un vehículo). Ejemplo: ingresas 100.000 € y gastas 70.000 € en material, personal y servicios → EBITDA 30.000 €, aunque la furgoneta se deprecie."],
        ["EBIT = BE (Bº explotación)", "EBITDA − amortizaciones − deterioros", r.EBIT, "eur", "El beneficio de la explotación, ya restando el desgaste de máquinas y vehículos y las pérdidas de valor. Ejemplo: EBITDA 30.000 € − amortización de la furgoneta 8.000 € = 22.000 €."],
        ["BNO (Bº neto ordinario)", "EBIT + ingresos financieros − gastos financieros", r.BNO, "eur", "El beneficio habitual, sumando lo que te pagan los bancos y restando los intereses de préstamos y pólizas. Ejemplo: EBIT 22.000 € + 200 € cobrados − 3.000 € de intereses = 19.200 €."],
        ["BAI", "BNO ± extraordinarios", r.BAI, "eur", "El beneficio antes del impuesto de sociedades, ya con lo extraordinario (una indemnización, una multa, vender un local). Ejemplo: BNO 19.200 € + 5.000 € por vender una máquina = 24.200 €."],
        ["BN (Bº líquido)", "BAI − impuestos", r.BN, "eur", "Lo que queda para la empresa después de impuestos. Ejemplo: BAI 24.200 € − impuesto 6.000 € = 18.200 €."],
        ["Margen bruto %", "Margen bruto / VN", div(r.MB, r.VN), "pct", "De cada euro vendido, cuánto queda después del material. Ejemplo: margen 55.000 € / ventas 95.000 € = 58 %: de cada euro, 58 céntimos cubren el resto de gastos y el beneficio."],
        ["Margen EBITDA", "EBITDA / ventas", div(r.EBITDA, r.VN), "pct", "De cada euro vendido, cuánto queda después de los gastos de la actividad (sin contar amortizaciones). Ejemplo: EBITDA 20.000 € / ventas 95.000 € = 21 %."],
      ],
    },
    {
      titulo: "Rentabilidad y Dupont",
      nota: dias < 360 ? `Periodo de ${dias} días: rentabilidades y rotaciones anualizadas (×365/${dias}).` : null,
      filas: [
        ["Rentabilidad económica (RE)", "BE / A", div(r.EBIT * anual, b.A), "pct", "Cuánto gana el negocio por cada euro invertido en activos (naves, stock, clientes, caja), sin mirar si el dinero es propio o del banco. Ejemplo: beneficio de explotación 22.000 € y activo 200.000 € → un 11 %."],
        ["Rentabilidad financiera (RF)", "BN / K", div(r.BN * anual, b.K), "pct", "Cuánto ganan los socios por cada euro que han puesto en la empresa. Ejemplo: beneficio líquido 18.000 € y patrimonio 120.000 € → un 15 %."],
        ["Rentabilidad de las ventas (RV)", "BE / V", div(r.EBIT, r.VN), "pct", "De cada euro vendido, cuánto es beneficio de explotación. Ejemplo: BE 22.000 € / ventas 95.000 € = 23 %."],
        ["Rotación del activo (rT)", "V / A", div(r.VN * anual, b.A), "x", "Cuántas veces las ventas cubren el valor de todo lo que tiene la empresa. Junto con el margen, explica la rentabilidad económica (RE = RV × rT). Ejemplo: vendes 200.000 € y el activo vale 100.000 € → rota 2 veces: cada euro de activo genera 2 € de venta."],
        ["Dupont: rentabilidad total", "BN / A = BN/V · V/A", div(r.BN * anual, b.A), "pct", "El beneficio líquido respecto a todo el activo. Sale de multiplicar el margen por la rotación. Ejemplo: ganas 10 céntimos por euro vendido y vendes 2 € por cada euro de activo → un 20 %."],
        ["RF descompuesta", "BN/V · V/A · A/K", div(r.BN, r.VN) != null && div(r.VN * anual, b.A) != null && div(b.A, b.K) != null ? div(r.BN, r.VN) * div(r.VN * anual, b.A) * div(b.A, b.K) : null, "pct", "La rentabilidad de los socios sale de tres palancas: margen, rotación y cuánta deuda usas. Ejemplo: margen 10 % × rotación 2 × apalancamiento 1,5 = 30 % para el socio."],
      ],
    },
    {
      titulo: "Ratios de situación a corto plazo",
      filas: [
        ["Liquidez general", "AC / PC", div(b.AC, b.PC), "x", "Si con el stock, los clientes y la caja cubres las deudas que vencen este año. Ideal entre 1,5 y 2. Ejemplo: circulante 150.000 € y deudas a corto 100.000 € → 1,5: por cada euro que debes a corto, tienes 1,50 €.", [1.5, 2]],
        ["Tesorería ordinaria (acid test)", "(T + R) / PC", div(b.T + b.R, b.PC), "x", "La misma idea, pero sin contar el stock, que tarda más en convertirse en dinero. Ideal cerca de 1. Ejemplo: caja + clientes 100.000 € / deudas a corto 100.000 € = 1.", [0.8, 1.2]],
        ["Tesorería inmediata (disponibilidad)", "T / PC", div(b.T, b.PC), "x", "Solo el dinero que ya está en el banco, frente a las deudas a corto. Ideal cerca de 0,3. Ejemplo: 30.000 € en el banco / 100.000 € de deudas = 0,30.", [0.2, 0.5]],
        ["Fondo de maniobra (FM)", "AC − PC", b.FM, "eur", "El colchón que sobra del circulante después de pagar las deudas a corto. Si es positivo, el corto plazo está cubierto. Ejemplo: circulante 150.000 € − deudas a corto 100.000 € = 50.000 € de colchón."],
        ["Capital propio en circulante", "FM / K", div(b.FM, b.K), "x", "Qué parte del dinero de los socios está financiando ese colchón. Ejemplo: fondo de maniobra 50.000 € / patrimonio 200.000 € = 0,25: una cuarta parte del capital propio está en el circulante."],
      ],
    },
    {
      titulo: "Ratios de situación a largo plazo",
      filas: [
        ["Garantía (distancia a la quiebra)", "A / D", div(b.A, b.D), "x", "Cuántos euros de activo hay por cada euro de deuda. Por debajo de 1, lo que tienes no cubre lo que debes. Ideal por encima de 1,5. Ejemplo: activo 300.000 € / deudas 200.000 € = 1,5.", [1.5, 99]],
        ["Endeudamiento total", "D / K", div(b.D, b.K), "x", "Cuánta deuda hay por cada euro de los socios. Ideal entre 0,5 y 1,5. Ejemplo: deudas 150.000 € / patrimonio 100.000 € = 1,5: debes 1,50 € por cada euro propio.", [0.5, 1.5]],
        ["Endeudamiento a corto", "PC / K", div(b.PC, b.K), "x", "La parte de esa deuda que vence dentro del año (proveedores, Hacienda, la cuota del préstamo de este año). Ejemplo: deudas a corto 60.000 € / patrimonio 100.000 € = 0,60."],
        ["Endeudamiento a largo", "RA / K", div(b.RA, b.K), "x", "La deuda que vence a más de un año, como un préstamo o un leasing. Ejemplo: deuda a largo 90.000 € / patrimonio 100.000 € = 0,90."],
        ["Apalancamiento (A/K)", "A / K = D/K + 1", div(b.A, b.K), "x", "Cuántos euros de activo manejas por cada euro de los socios. Ejemplo: activo 200.000 € / patrimonio 100.000 € = 2: la mitad la ponen los socios y la otra mitad, la deuda."],
        ["Autonomía", "K / D", div(b.K, b.D), "x", "Euros propios por cada euro de deuda: lo contrario del endeudamiento. Ejemplo: patrimonio 100.000 € / deudas 150.000 € = 0,67."],
        ["Financiación del inmovilizado", "CP / AF", div(b.CP, b.AF), "x", "Si naves, máquinas y vehículos están pagados con dinero estable (socios + deuda a largo), y no con deudas que vencen ya. Por encima de 1, sí está cubierto. Ejemplo: capitales permanentes 180.000 € / inmovilizado 150.000 € = 1,2.", [1, 99]],
        ["Capital propio inmovilizado", "(AF − RA) / K", div(b.AF - b.RA, b.K), "x", "Qué parte del dinero de los socios está atrapada en el inmovilizado que no cubre la deuda a largo. Ejemplo: inmovilizado 150.000 € − deuda a largo 40.000 € = 110.000 €; entre un patrimonio de 200.000 € sale 0,55."],
      ],
    },
    {
      titulo: "Ratios de rotación",
      filas: [
        ["Rotación del activo", "V / A", div(r.VN * anual, b.A), "x", "Cuántas veces al año las ventas cubren todo el activo. Un número alto significa que sacas muchas ventas con lo que tienes. Ejemplo: ventas 200.000 € / activo 100.000 € = 2."],
        ["Rotación del activo fijo", "V / AF", div(r.VN * anual, b.AF), "x", "Cuántas ventas generas con naves, máquinas y vehículos. Ejemplo: ventas 300.000 € / inmovilizado 100.000 € = 3."],
        ["Rotación del activo circulante", "V / AC", div(r.VN * anual, b.AC), "x", "Cuántas ventas generas con el stock, los clientes y la caja. Ejemplo: ventas 300.000 € / circulante 150.000 € = 2."],
        ["Rotación de clientes", "V / clientes", div(r.VN * anual, b.clientes), "x", "Cuántas veces al año cobras el saldo que te deben los clientes. Ejemplo: ventas 365.000 € y clientes 36.500 € → rota 10 veces."],
        ["Rotación de existencias", "Consumo / E", div(r.consumos * anual, b.E), "x", "Cuántas veces al año se renueva el almacén. Ejemplo: consumes 120.000 € de material y el stock vale 30.000 € → rota 4 veces."],
        ["Rotación de capitales permanentes", "V / CP", div(r.VN * anual, b.CP), "x", "Ventas por cada euro de financiación estable (dinero de los socios más deuda a largo). Ejemplo: ventas 200.000 € / capitales permanentes 100.000 € = 2."],
        ["Rotación del capital propio", "V / K", div(r.VN * anual, b.K), "x", "Ventas por cada euro que han puesto los socios. Ejemplo: ventas 300.000 € / patrimonio 100.000 € = 3."],
      ],
    },
    {
      titulo: "Periodos medios (maduración)",
      nota: "Aproximación con saldos a la fecha: PM = saldo / flujo del periodo × días del periodo.",
      filas: [
        ["PM de almacenamiento (PMa+PMc+PMv)", "E / consumos × días", div(b.E, r.consumos) != null ? div(b.E, r.consumos) * dias : null, "dias", "Días que el material pasa en el almacén antes de usarse. Ejemplo: stock de 30.000 € y un consumo de 1.000 € al día → 30 días."],
        ["PM de cobro (PMe)", "Clientes / ventas × días", div(b.clientes, r.VN * 1.21) != null ? div(b.clientes, r.VN * 1.21) * dias : null, "dias", "Días que tardas en cobrar a los clientes. Las ventas se cuentan con IVA (21 %) porque la factura pendiente también lo lleva. Ejemplo: te deben 60.000 € y facturas 2.000 € al día → 30 días."],
        ["PM de pago (PMp)", "Proveedores / compras × días", div(b.proveedores, r.compras * 1.21) != null ? div(b.proveedores, r.compras * 1.21) * dias : null, "dias", "Días que tardas en pagar a los proveedores. Las compras van con IVA (21 %) por el mismo motivo. Ejemplo: debes 45.000 € y compras 1.500 € al día → 30 días."],
        [
          "Cobertura ante impagos (días de caja)",
          "Tesorería / ventas diarias c/IVA",
          (() => {
            const ventasDia = div(r.VN * 1.21, dias);
            return ventasDia ? b.T / ventasDia : null;
          })(),
          "dias",
          "Días que aguantas sin cobrar nada usando solo el dinero del banco. Ejemplo: tienes 20.000 € en tesorería y vendes 1.000 € al día → aguantas 20 días. En «Indicadores» puedes simular retrasos de cobro.",
        ],
      ].concat([
        (() => {
          const pma = div(b.E, r.consumos) != null ? div(b.E, r.consumos) * dias : 0;
          const pme = div(b.clientes, r.VN * 1.21) != null ? div(b.clientes, r.VN * 1.21) * dias : 0;
          const pmp = div(b.proveedores, r.compras * 1.21) != null ? div(b.proveedores, r.compras * 1.21) * dias : 0;
          return ["PM financiero (PMF)", "PM económico − PMp", pma + pme - pmp, "dias", "Días del ciclo que adelantas de tu bolsillo: almacén + espera de cobro, menos los días que te fían los proveedores. Ejemplo: 30 días de stock + 45 de cobro − 30 de pago = 45 días a financiar."];
        })(),
      ]),
    },
    {
      titulo: "Apalancamiento operativo y financiero (Tema 6)",
      nota: "Costes variables ≈ consumos (60/61). Costes fijos ≈ servicios exteriores, tributos, personal, otros gastos y amortizaciones. El punto muerto financiero suma los intereses y el vencimiento medio de cobro y de pago.",
      filas: [
        ["Apalancamiento operativo (Ao)", "(BE + CF) / BE", div(r.EBIT + CFm, r.EBIT), "x", "Cómo se multiplica el beneficio de explotación si suben las ventas, por los costes fijos (alquiler, personal, amortizaciones). Ejemplo: Ao = 2 quiere decir que si las ventas suben un 10 %, el beneficio de explotación sube un 20 %."],
        ["Apalancamiento financiero (Af)", "BE / BN (antes de impuestos: BE / (BE − F))", div(r.EBIT, r.EBIT - r.F), "x", "Cómo se multiplica ese beneficio hacia el socio por culpa de los intereses. Ejemplo: Af = 1,5 y el beneficio de explotación sube un 10 % → el beneficio del socio sube un 15 %."],
        ["Apalancamiento total (At)", "Ao · Af", div(r.EBIT + CFm, r.EBIT) != null && div(r.EBIT, r.EBIT - r.F) != null ? div(r.EBIT + CFm, r.EBIT) * div(r.EBIT, r.EBIT - r.F) : null, "x", "El efecto conjunto de los costes fijos y de los intereses. Ejemplo: Ao 2 × Af 1,5 = 3: si las ventas suben un 10 %, el beneficio del socio sube un 30 %."],
        ["Punto muerto (en ventas)", "CF / (1 − CV/V)", cvUnit != null && cvUnit < 1 ? CFm / (1 - cvUnit) : null, "eur", "Las ventas mínimas del periodo para cubrir costes y quedar a cero, como si cobrases y pagases al momento. Ejemplo: costes fijos 50.000 € y, de cada euro vendido, quedan 0,40 € después del material → hay que vender 125.000 € para no perder."],
        ["Cobertura del punto muerto", "VN / punto muerto", cvUnit != null && cvUnit < 1 ? div(r.VN, CFm / (1 - cvUnit)) : null, "x", "Cuántas veces superas esas ventas mínimas. Por encima de 1 ya estás ganando. Ejemplo: vendes 200.000 € y el punto muerto es 125.000 € → 1,6: un 60 % por encima."],
        ["Punto muerto financiero", "(CF + intereses) / (margen − coste del desfase cobro−pago)", pmFin, "eur", explicaPmFin],
        ["Cobertura del punto muerto financiero", "VN / punto muerto financiero", div(r.VN, pmFin), "x", "Cuántas veces las ventas del periodo superan el punto muerto financiero. Por encima de 1, la caja del ciclo y los intereses quedan cubiertos."],
      ],
    },
  ];
}

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

function BotonExplicame({ cargando, onClick }) {
  return (
    <button type="button" onClick={onClick} disabled={cargando} className="mt-1 text-[11px] px-2 py-0.5 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 disabled:opacity-50 whitespace-normal font-normal" title="La IA te explica este dato con las cifras de la empresa, un ejemplo y qué hacer">
      {cargando ? "🤖 Pensando…" : "🤖 Explícame"}
    </button>
  );
}

function colorSemaforo(v, rango) {
  if (!rango || v == null) return "";
  const [min, max] = rango;
  if (v >= min && v <= max) return "text-green-700";
  if (v >= min * 0.7 && v <= max * 1.3) return "text-amber-600";
  return "text-red-600";
}

function Tabla({ titulo, nota, filas, filasPrev, etiqActual, etiqPrev, explic, onExplicar, onCerrar }) {
  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h2 className="font-semibold text-slate-800">{titulo}</h2>
        {nota && <p className="text-xs text-slate-500 mt-0.5">{nota}</p>}
      </div>
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[48%]" />
          <col className="w-[24%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
        </colgroup>
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
            const clave = `${titulo}|${nombre}`;
            const filaIA = { nombre, grupo: titulo, formula, valor: FORMATOS[fmt](v), anterior: FORMATOS[fmt](vp), que: comentario || "", etiqActual, etiqPrev };
            return (
              <React.Fragment key={nombre}>
                <tr className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-700">{nombre}</div>
                    {comentario && <div className="text-xs text-slate-500 mt-1 leading-relaxed">{comentario}</div>}
                    <BotonExplicame cargando={explic[clave]?.cargando} onClick={() => onExplicar(clave, filaIA)} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500">{formula}</td>
                  <td className={`px-4 py-2 text-right font-semibold whitespace-nowrap ${colorSemaforo(v, rango)}`}>{FORMATOS[fmt](v)}</td>
                  <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">{FORMATOS[fmt](vp)}</td>
                </tr>
                {explic[clave] && (
                  <tr>
                    <td colSpan={4} className="px-4 pb-3">
                      <PanelExplicacion e={explic[clave]} onCerrar={() => onCerrar(clave)} onRepetir={() => onExplicar(clave, filaIA)} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function CeldaExistencias({ texto, contable, onChange, onBlur, onRestaurar, suave }) {
  const manual = parseImporte(texto);
  const cambiada = texto != null && manual != null && Math.abs(manual - contable) > 0.5;
  return (
    <div className="inline-flex flex-col items-end">
      <input
        type="text"
        inputMode="decimal"
        title="Importe manual de existencias. Vacío = saldo de contabilidad."
        className={`w-36 border rounded px-2 py-1 text-right ${suave ? "text-slate-500" : "font-semibold text-slate-800"} ${cambiada ? "border-amber-400 bg-amber-50" : "border-slate-300"}`}
        value={texto ?? plano(contable)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {cambiada && (
        <div className="font-normal text-[11px] text-slate-400 mt-1 whitespace-normal text-right">
          Contable: {eur(contable)}
          <button type="button" onClick={onRestaurar} className="ml-1 underline text-slate-500">Restaurar</button>
        </div>
      )}
    </div>
  );
}

function Masas({ b, bp, eContable, eContablePrev, descuadre, stockTxt, onStock, explic, onExplicar, onCerrar, etiqActual, etiqPrev }) {
  const filas = [
    ["Activo fijo (AF)", "Naves, máquinas, vehículos y equipos que duran más de un año. Ejemplo: la furgoneta y la maquinaria del taller.", b.AF, bp.AF],
    ["Existencias (E)", "Material en el almacén que todavía no se ha usado. Ejemplo: tubos y racores en stock.", b.E, bp.E],
    ["Realizable (R)", "Dinero que te deben y que esperas cobrar: clientes y otros deudores. Ejemplo: facturas emitidas y aún no cobradas.", b.R, bp.R],
    ["  · de ello clientes", "La parte del realizable que son facturas a clientes. Ejemplo: una obra facturada que el cliente todavía no ha pagado.", b.clientes, bp.clientes],
    ["Tesorería (T)", "Dinero disponible ya: bancos y caja. Ejemplo: el saldo de la cuenta del banco hoy.", b.T, bp.T],
    ["Activo circulante (AC)", "Stock + lo que te deben + el banco. Es lo que se mueve dentro del año. Ejemplo: almacén 20.000 € + clientes 40.000 € + banco 10.000 € = 70.000 €.", b.AC, bp.AC],
    ["ACTIVO (A)", "Todo lo que tiene la empresa: el activo fijo más el circulante. Ejemplo: inmovilizado 150.000 € + circulante 70.000 € = 220.000 €.", b.A, bp.A],
    ["Patrimonio neto (K)", "El dinero de los socios: capital, reservas y el beneficio acumulado, aunque el año no esté cerrado. Ejemplo: capital 50.000 € + reservas 30.000 € + beneficio 10.000 € = 90.000 €.", b.K, bp.K],
    ["Pasivo no corriente (RA)", "Deudas que vencen a más de un año. Ejemplo: un préstamo del banco a 5 años.", b.RA, bp.RA],
    ["Pasivo corriente (PC)", "Deudas que vencen dentro del año. Ejemplo: proveedores, Hacienda y la cuota del préstamo que toca este año.", b.PC, bp.PC],
    ["  · de ello proveedores", "Lo que debes a quien te vende material. Ejemplo: la factura del almacén de tubos, todavía sin pagar.", b.proveedores, bp.proveedores],
    ["Deudas totales (D)", "Todas las deudas, las de este año y las de más adelante. Ejemplo: préstamo 80.000 € + proveedores 20.000 € = 100.000 €.", b.D, bp.D],
  ];
  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h2 className="font-semibold text-slate-800">Masas patrimoniales (desde movs. de contabilidad)</h2>
        <p className="text-xs text-slate-500 mt-0.5">Agrupación por cuentas del Plan General Contable. El importe de existencias se puede cambiar; el activo, el fondo de maniobra y los ratios que usan el stock se recalculan.</p>
      </div>
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-[70%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
        </colgroup>
        <tbody>
          {filas.map(([n, explica, v, vp]) => {
            const clave = `masas|${n}`;
            const filaIA = { nombre: n.trim(), grupo: "Masas patrimoniales", formula: "Saldo contable a la fecha", valor: eur(v), anterior: eur(vp), que: explica, etiqActual, etiqPrev };
            const destacado = ["Activo circulante (AC)", "ACTIVO (A)", "Patrimonio neto (K)", "Deudas totales (D)"].includes(n);
            return (
              <React.Fragment key={n}>
                <tr className={`border-t border-slate-100 align-top ${destacado ? "font-bold" : ""}`}>
                  <td className="px-4 py-2 whitespace-pre text-slate-700">
                    {n}
                    <div className="font-normal text-xs text-slate-500 mt-1 leading-relaxed whitespace-normal">{explica}</div>
                    <BotonExplicame cargando={explic[clave]?.cargando} onClick={() => onExplicar(clave, filaIA)} />
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {n === "Existencias (E)" ? (
                      <CeldaExistencias texto={stockTxt.actual} contable={eContable} suave={false} onChange={(t) => onStock("actual", t)} onBlur={() => onStock("actual", "blur")} onRestaurar={() => onStock("actual", null)} />
                    ) : eur(v)}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">
                    {n === "Existencias (E)" ? (
                      <CeldaExistencias texto={stockTxt.anterior} contable={eContablePrev} suave onChange={(t) => onStock("anterior", t)} onBlur={() => onStock("anterior", "blur")} onRestaurar={() => onStock("anterior", null)} />
                    ) : eur(vp)}
                  </td>
                </tr>
                {explic[clave] && (
                  <tr>
                    <td colSpan={3} className="px-4 pb-3">
                      <PanelExplicacion e={explic[clave]} onCerrar={() => onCerrar(clave)} onRepetir={() => onExplicar(clave, filaIA)} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {Math.abs(descuadre) > 1 && (
        <p className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-t">
          ⚠ Activo contable − (K + RA + PC) = {eur(descuadre)}. Hay cuentas fuera de la agrupación estándar (p. ej. IVA, cuentas puente o 4xx no clasificadas); los ratios son aproximados.
        </p>
      )}
    </section>
  );
}

export default function Ratios() {
  const [hasta, setHasta] = useState(hoy());
  const [desde, setDesde] = useState(inicioAnio(hoy()));
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [pestana, setPestana] = useState("ratios");
  const [vista, setVista] = useState("direccion");
  const [explic, setExplic] = useState({});
  const [stockTxt, setStockTxt] = useState({ actual: null, anterior: null });

  const fijarStock = (lado, valor) => {
    setStockTxt((s) => {
      if (valor === null) return { ...s, [lado]: null };
      if (valor === "blur") {
        const n = parseImporte(s[lado]);
        return { ...s, [lado]: n == null ? null : plano(n) };
      }
      return { ...s, [lado]: valor };
    });
  };

  const explicarRatio = async (clave, fila) => {
    setExplic((s) => ({ ...s, [clave]: { cargando: true } }));
    try {
      const b = conExistencias(datos?.actual?.balance, parseImporte(stockTxt.actual)) || {};
      const resu = datos?.actual?.resultados || {};
      const bp = conExistencias(datos?.anterior?.balance, parseImporte(stockTxt.anterior)) || {};
      const rp = datos?.anterior?.resultados || {};
      const resumen = {
        periodo: etiqActual, periodoPrev: etiqPrev,
        ventas: resu.VN, ventasPrev: rp.VN, ebitda: resu.EBITDA, ebitdaPrev: rp.EBITDA,
        ebit: resu.EBIT, bn: resu.BN, margen: resu.VN ? resu.EBITDA / resu.VN : null,
        tesoreria: b.T, clientes: b.clientes, proveedores: b.proveedores,
        fondoManiobra: b.FM, activo: b.A, patrimonio: b.K, deudas: b.D,
        tesoreriaPrev: bp.T,
      };
      const resp = await fetch("/api/macro/explicar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa: datos?.empresa || "ALSO CASALS", modo: "ratio", filas: [fila], resumen }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${resp.status}`);
      setExplic((s) => ({ ...s, [clave]: { datos: j } }));
    } catch (e) {
      setExplic((s) => ({ ...s, [clave]: { error: String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend." : String(e.message || e) } }));
    }
  };
  const cerrarExplic = (clave) => setExplic((s) => { const n = { ...s }; delete n[clave]; return n; });

  const cargar = async (refrescar = false) => {
    setCargando(true);
    setError("");
    try {
      if (desde > hasta) throw new Error("La fecha inicial no puede ser posterior a la fecha final.");
      const r = await fetch(`/api/contabilidad/ratios?desde=${desde}&hasta=${hasta}${refrescar ? "&refrescar=1" : ""}`);
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
  const bVista = datos ? conExistencias(datos.actual.balance, parseImporte(stockTxt.actual)) : null;
  const bpVista = datos ? conExistencias(datos.anterior.balance, parseImporte(stockTxt.anterior)) : null;
  const g = datos ? grupos(bVista, datos.actual.resultados, datos.actual.dias) : [];
  const gp = datos ? grupos(bpVista, datos.anterior.resultados, datos.anterior.dias) : [];
  const etiqActual = datos ? `${fmtF(datos.desde)} – ${fmtF(datos.hasta)}` : "Actual";
  const etiqPrev = datos ? `${fmtF(datos.desdePrev)} – ${fmtF(datos.hastaPrev)}` : "Año anterior";

  return (
    <div className={pestana === "ratios" ? "w-full" : "max-w-[1400px]"}>
      <h1 className="text-2xl font-bold text-slate-800">📊 Ratios financieros</h1>
      <p className="text-slate-500 text-sm mt-1 max-w-5xl">
        Fórmulas de los apuntes (cuenta de resultados, rentabilidades, Dupont, situación, rotación, periodos medios y
        apalancamientos) calculadas con los movimientos de contabilidad de Business Central{datos?.empresa ? ` de ${datos.empresa}` : ""}.
        Balance a la fecha final; cuenta de resultados entre las dos fechas, comparada con el mismo periodo del año anterior.
      </p>

      <div className="flex items-end gap-3 mt-4">
        <label className="text-sm text-slate-600">
          Desde fecha
          <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} className="block border rounded px-2 py-1 mt-1" />
        </label>
        <label className="text-sm text-slate-600">
          Hasta fecha
          <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} className="block border rounded px-2 py-1 mt-1" />
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
        <>
          <div className="flex gap-1 mt-4 border-b">
            {[["direccion", "Dirección"], ["analisis", "Análisis financiero"], ["circulante", "Circulante y tesorería"]].map(([k, t]) => (
              <button key={k} type="button" onClick={() => setVista(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 ${vista === k ? "border-blue-700 text-blue-800 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {t}
              </button>
            ))}
          </div>
          {vista !== "analisis" && (
            <CuadroDireccion modo={vista} datos={datos} b={bVista} bp={bpVista} g={g} gp={gp} />
          )}
          {vista === "analisis" && (
        <div className="grid gap-5 mt-6">
          {g.map((grupo, i) => (
            <Tabla key={grupo.titulo} {...grupo} filasPrev={gp[i].filas} etiqActual={etiqActual} etiqPrev={etiqPrev} explic={explic} onExplicar={explicarRatio} onCerrar={cerrarExplic} />
          ))}
          <Masas b={bVista} bp={bpVista} eContable={datos.actual.balance.E} eContablePrev={datos.anterior.balance.E} descuadre={datos.actual.balance.descuadre} stockTxt={stockTxt} onStock={fijarStock} explic={explic} onExplicar={explicarRatio} onCerrar={cerrarExplic} etiqActual={etiqActual} etiqPrev={etiqPrev} />
          <p className="text-xs text-slate-400">
            Criterios: activo en positivo, pasivo y patrimonio neto en positivo. El patrimonio neto incluye el resultado del ejercicio aunque no esté cerrado.
            Colores (verde/ámbar/rojo) solo en los ratios que tienen valor ideal en los apuntes.
          </p>
        </div>
          )}
        </>
      )}
    </div>
  );
}
