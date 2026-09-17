/**
 * pedidosventa.jsx — Pantalla PEDIDOS DE VENTA PENDIENTES DE FACTURAR.
 *
 * Muestra los pedidos de venta (cabeceras salesOrders / pedidos_venta) cuyo
 * "Importe enviado no facturado" (Amount_ship_not_invoice) > 0,01 €.
 * Hermana de Recepción: KPIs, filtros y tabla.
 *
 * Columnas de BC en inglés crudo — detección tolerante (inglés/español).
 */
import React, { useState, useMemo } from "react";
import { RefreshCw, Search } from "lucide-react";

const UMBRAL = 0.01; // pendiente de facturar si supera este importe

const parseNum = (v) => {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/\s|€/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
};
const parseFecha = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
};
const fmtE = (n) => (isNaN(n) || n == null ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €");

// Detección tolerante de columnas de la cabecera de pedido de venta
function cols(headers) {
  const low = headers.map((h) => h.toLowerCase().trim());
  const H = (re) => headers[low.findIndex((h) => re.test(h))] || "";
  return {
    numero: H(/^no$/) || H(/^document_no$/) || H(/^nº$/) || H(/n[º°] pedido/) || headers[0],
    cliente: H(/^sell_to_customer_name$/) || H(/^bill_to_name$/) || H(/nombre.*cliente/) || H(/cliente/),
    fecha: H(/^order_date$/) || H(/fecha pedido/) || H(/^document_date$/) || H(/fecha/),
    ot: H(/^shortcut_dimension_2_code$/) || H(/c[oó]d\.?\s*ot/) || H(/\bot\b/),
    un: H(/^shortcut_dimension_1_code$/) || H(/unidad de negocio|departamento/),
    estado: H(/^status$/) || H(/^estado$/),
    total: H(/^amount_including_vat$/) || H(/^amountincludingvat$/) || H(/^amount$/) || H(/importe total/) || H(/^importe$/),
    pendiente:
      H(/^amountshippednotinvoiced$/) ||
      H(/^amountshippednotinvoicedinclvat$/) ||
      H(/^shippednotinvoiced$/) ||
      H(/^shippednotinvoicedlcy$/) ||
      H(/^amtrcdnotinvoiced$/) ||
      H(/^amountrcdnotinvoiced$/) ||
      H(/^amtrcdnotinvoicedlcy$/) ||
      H(/^outstandingamount$/) ||
      H(/^outstandingamountlcy$/) ||
      H(/^amount_ship_not_invoice$/) ||
      H(/enviado no facturado/) ||
      H(/recibido no facturado/) ||
      H(/pendiente.*facturar/) ||
      H(/shipped.?not.?invoic/) ||
      H(/rcd.?not.?invoic/),
  };
}

export default function PedidosVenta({ pedidos, onActualizarBC, actualizando }) {
  const [q, setQ] = useState("");
  const [fCli, setFCli] = useState("");
  const [fOT, setFOT] = useState("");
  const [fUN, setFUN] = useState("");
  const [fEstado, setFEstado] = useState("");
  const [fDesde, setFDesde] = useState("");
  const [fHasta, setFHasta] = useState("");

  const c = useMemo(() => (pedidos?.headers?.length ? cols(pedidos.headers) : null), [pedidos]);

  const pendientes = useMemo(() => {
    if (!c || !pedidos?.rows?.length) return [];
    const out = [];
    for (const r of pedidos.rows) {
      const pend = c.pendiente ? parseNum(r[c.pendiente]) : NaN;
      if (isNaN(pend) || pend <= UMBRAL) continue; // solo pendientes de facturar
      out.push({
        num: String(r[c.numero] || "").trim(),
        cliente: String(r[c.cliente] || "").trim(),
        fecha: c.fecha ? String(r[c.fecha] || "").trim() : "",
        f: c.fecha ? parseFecha(r[c.fecha]) : null,
        ot: String(r[c.ot] || "").trim(),
        un: c.un ? String(r[c.un] || "").trim() : "",
        estado: c.estado ? String(r[c.estado] || "").trim() : "",
        total: c.total ? parseNum(r[c.total]) : NaN,
        pend,
      });
    }
    out.sort((a, b) => b.pend - a.pend);
    return out;
  }, [c, pedidos]);

  const clientes = useMemo(() => [...new Set(pendientes.map((p) => p.cliente).filter(Boolean))].sort(), [pendientes]);
  const ots = useMemo(() => [...new Set(pendientes.map((p) => p.ot).filter(Boolean))].sort(), [pendientes]);
  const uns = useMemo(() => [...new Set(pendientes.map((p) => p.un).filter(Boolean))].sort(), [pendientes]);
  const estados = useMemo(() => [...new Set(pendientes.map((p) => p.estado).filter(Boolean))].sort(), [pendientes]);

  const filtradas = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const desde = fDesde ? new Date(fDesde) : null;
    const hasta = fHasta ? new Date(fHasta) : null;
    return pendientes.filter((p) => {
      if (qq && ![p.num, p.cliente, p.ot, p.un].some((v) => String(v || "").toLowerCase().includes(qq))) return false;
      if (fCli && p.cliente !== fCli) return false;
      if (fOT && p.ot !== fOT) return false;
      if (fUN && p.un !== fUN) return false;
      if (fEstado && p.estado !== fEstado) return false;
      if (desde && (!p.f || p.f < desde)) return false;
      if (hasta && (!p.f || p.f > hasta)) return false;
      return true;
    });
  }, [pendientes, q, fCli, fOT, fUN, fEstado, fDesde, fHasta]);

  const kpis = useMemo(() => ({
    n: pendientes.length,
    total: pendientes.reduce((a, p) => a + p.pend, 0),
    nFiltradas: filtradas.length,
    totalFiltradas: filtradas.reduce((a, p) => a + p.pend, 0),
  }), [pendientes, filtradas]);

  const limpiar = () => { setQ(""); setFCli(""); setFOT(""); setFUN(""); setFEstado(""); setFDesde(""); setFHasta(""); };

  const sinDatos = !pedidos?.rows?.length;
  const sinCampo = c && !c.pendiente;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pedidos de venta pendientes de facturar</h1>
          <p className="text-slate-500 text-sm mt-1">Pedidos de venta con «Importe enviado no facturado» por encima de {fmtE(UMBRAL)}.{c?.pendiente ? <span className="text-slate-400"> · campo usado: <span className="font-mono">{c.pendiente}</span></span> : null}</p>
        </div>
        {onActualizarBC && (
          <button onClick={onActualizarBC} disabled={actualizando} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
            <RefreshCw size={15} className={actualizando ? "animate-spin" : ""} /> Actualizar desde BC
          </button>
        )}
      </div>

      {sinDatos ? (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          No hay pedidos de venta cargados. Cárgalos en «Cargar datos» → «Pedidos de Venta».
        </div>
      ) : sinCampo ? (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          No encuentro la columna «Importe enviado no facturado» (Amount_ship_not_invoice) en los pedidos de venta. Columnas disponibles: {pedidos.headers.join(", ")}
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-5">
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">Pedidos pendientes</div>
              <div className="text-sm font-bold text-blue-700">{kpis.n}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">Importe total pendiente</div>
              <div className="text-sm font-bold text-blue-700">{fmtE(kpis.total)}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">En pantalla (filtrados)</div>
              <div className="text-sm font-bold text-slate-700">{kpis.nFiltradas}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">Importe filtrado</div>
              <div className="text-sm font-bold text-slate-700">{fmtE(kpis.totalFiltradas)}</div>
            </div>
          </div>

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2 mt-4 text-[13px]">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className="pl-7 pr-2 py-1.5 border border-slate-300 rounded-md w-40" />
            </div>
            <select value={fCli} onChange={(e) => setFCli(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md max-w-[200px]">
              <option value="">Clientes</option>
              {clientes.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={fOT} onChange={(e) => setFOT(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">OT</option>
              {ots.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={fUN} onChange={(e) => setFUN(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Unidad de negocio</option>
              {uns.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            {estados.length > 0 && (
              <select value={fEstado} onChange={(e) => setFEstado(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
                <option value="">Estado</option>
                {estados.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            )}
            <input type="date" value={fDesde} onChange={(e) => setFDesde(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Desde" />
            <input type="date" value={fHasta} onChange={(e) => setFHasta(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Hasta" />
            <button onClick={limpiar} className="text-slate-500 hover:text-slate-700 hover:underline">Limpiar</button>
            <span className="text-slate-400 ml-auto">{filtradas.length} de {pendientes.length}</span>
          </div>

          {/* Tabla */}
          <div className="mt-3 overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-left">
                  {["Pedido", "Cliente", "Fecha", "OT", "Un. negocio", "Estado", "Importe total", "Pendiente facturar"].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtradas.map((p, i) => (
                  <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap">{p.num}</td>
                    <td className="px-2 py-1.5 max-w-[220px] truncate" title={p.cliente}>{p.cliente || "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.fecha || "—"}</td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap">{p.ot || "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.un || "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.estado || "—"}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{isNaN(p.total) ? "—" : fmtE(p.total)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-blue-700">{fmtE(p.pend)}</td>
                  </tr>
                ))}
                {filtradas.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Sin pedidos pendientes de facturar con los filtros actuales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
