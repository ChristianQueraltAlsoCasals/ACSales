/**
 * Panel inicial: importe facturado del mes y pedidos de venta cuyo
 * parte de trabajo tiene material que no está en el albarán.
 */
import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, RefreshCw } from "lucide-react";

const eur = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

const cant = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { maximumFractionDigits: 2 });

function mesActual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function moverMes(ym, delta) {
  const [y, m] = String(ym).split("-").map(Number);
  const d = new Date(y, (m || 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function nombreMes(ym) {
  const [y, m] = String(ym || "").split("-").map(Number);
  if (!y || !m) return ym || "";
  const n = new Date(y, m - 1, 1).toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function BotonPdf({ externo, pedido }) {
  const [estado, setEstado] = useState(null);
  const abrir = async () => {
    const ventana = window.open("", "_blank");
    setEstado("cargando");
    try {
      const q = new URLSearchParams();
      if (externo) q.set("externo", externo);
      if (pedido) q.set("pedido", pedido);
      const r = await fetch(`/api/bc/albaran-venta-pdf?${q}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) throw new Error(d.error || d.detalle || "No se ha podido abrir el PDF.");
      if (ventana) ventana.location = d.url;
      else window.open(d.url, "_blank", "noopener");
      setEstado(null);
    } catch (err) {
      if (ventana) ventana.close();
      setEstado(err.message || String(err));
    }
  };
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={abrir}
        disabled={estado === "cargando"}
        className="text-[11px] font-semibold text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 bg-white hover:bg-blue-50 disabled:opacity-50"
      >
        {estado === "cargando" ? "…" : "PDF"}
      </button>
      {estado && estado !== "cargando" && <span className="text-[10px] text-red-600 max-w-[180px]">{estado}</span>}
    </span>
  );
}

export default function PanelInicial() {
  const [mes, setMes] = useState(mesActual);
  const [facturado, setFacturado] = useState(null);
  const [errorFac, setErrorFac] = useState("");
  const [cargandoFac, setCargandoFac] = useState(true);
  const [revision, setRevision] = useState(null);
  const [errorRev, setErrorRev] = useState("");
  const [abierto, setAbierto] = useState(null);
  const [refresco, setRefresco] = useState(0);

  const tope = mesActual();
  const tituloMes = nombreMes(mes);

  useEffect(() => {
    let vivo = true;
    setFacturado(null);
    setCargandoFac(true);
    setErrorFac("");
    const q = new URLSearchParams({ mes });
    if (refresco) q.set("refrescar", "1");
    fetch(`/api/panel/facturado?${q}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || d.detalle || "No se ha podido leer el importe.");
        return d;
      })
      .then((d) => { if (vivo) setFacturado(d); })
      .catch((err) => { if (vivo) { setFacturado(null); setErrorFac(err.message || String(err)); } })
      .finally(() => { if (vivo) setCargandoFac(false); });
    return () => { vivo = false; };
  }, [mes, refresco]);

  useEffect(() => {
    let vivo = true;
    setRevision(null);
    setErrorRev("");
    setAbierto(null);
    (async () => {
      let primera = true;
      for (let i = 0; i < 400 && vivo; i += 1) {
        const q = new URLSearchParams({ mes, lote: "2" });
        if (primera && refresco) q.set("refrescar", "1");
        primera = false;
        let d;
        try {
          const r = await fetch(`/api/panel/pedidos-revisar?${q}`);
          d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || d.detalle || "No se han podido revisar los pedidos.");
        } catch (err) {
          if (vivo) setErrorRev(err.message || String(err));
          return;
        }
        if (!vivo) return;
        setRevision(d);
        if (d.terminado) return;
      }
    })();
    return () => { vivo = false; };
  }, [mes, refresco]);

  const enCurso = revision && !revision.terminado;
  const pct = revision?.total
    ? Math.min(100, Math.round((revision.revisados / revision.total) * 100))
    : (revision?.terminado ? 100 : 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Panel inicial</h1>
          <p className="text-slate-500 text-sm mt-1">Facturación del mes y pedidos de venta con material en el parte que no está en el albarán.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMes((m) => moverMes(m, -1))}
            className="p-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50"
            title="Mes anterior"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="month"
            aria-label="Mes"
            value={mes}
            max={tope}
            onChange={(e) => e.target.value && setMes(e.target.value)}
            className="border border-slate-300 rounded-md px-2 py-1.5 bg-white text-sm"
          />
          <button
            type="button"
            onClick={() => setMes((m) => (m >= tope ? m : moverMes(m, 1)))}
            disabled={mes >= tope}
            className="p-1.5 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
            title="Mes siguiente"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={() => setRefresco((n) => n + 1)}
            className="flex items-center gap-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3 py-1.5"
          >
            <RefreshCw size={14} className={cargandoFac || enCurso ? "animate-spin" : ""} />
            Actualizar
          </button>
        </div>
      </div>

      <section className="mt-5 bg-white border border-slate-200 rounded-lg px-5 py-4">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Importe facturado en {tituloMes}</div>
        {cargandoFac && !facturado ? (
          <div className="text-slate-400 text-sm mt-3">Leyendo facturas de venta en Business Central…</div>
        ) : errorFac ? (
          <div className="text-red-700 text-sm mt-3">{errorFac}</div>
        ) : (
          <>
            <div className="text-3xl font-bold text-blue-800 mt-1">{eur(facturado?.base)}</div>
            <div className="text-sm text-slate-500 mt-1">
              Base imponible, sin IVA
              {facturado ? ` · ${facturado.nFacturas} factura${facturado.nFacturas === 1 ? "" : "s"}` : ""}
              {facturado ? ` · con IVA ${eur(facturado.conIva)}` : ""}
            </div>
            {facturado?.nAbonos > 0 && (
              <div className="text-sm text-slate-600 mt-1">
                Abonos del mes: {eur(facturado.abonosBase)} ({facturado.nAbonos}). Neto {eur(facturado.neto)}.
              </div>
            )}
          </>
        )}
      </section>

      <section className="mt-5">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-slate-500" />
          <h2 className="text-lg font-bold text-slate-800">Pedidos de venta para revisar</h2>
          {revision?.pedidos?.length > 0 && (
            <span className="text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
              {revision.pedidos.length}
            </span>
          )}
        </div>
        <p className="text-slate-500 text-sm mt-1">
          Pedidos con albarán registrado en {tituloMes} en los que el parte de trabajo tiene material que no está en el albarán
          (o está con menos cantidad). Si el pedido tiene varios albaranes, se usa el de número más alto.
        </p>

        {errorRev && <div className="mt-3 text-sm text-red-700">{errorRev}</div>}

        {!revision && !errorRev && (
          <div className="mt-3 text-sm text-slate-400">Buscando albaranes de {tituloMes}…</div>
        )}

        {revision && !revision.terminado && (
          <div className="mt-3">
            <div className="text-sm text-slate-600">
              Comparando parte y albarán · {revision.revisados} de {revision.total}
              {revision.pedidos?.length ? ` · ${revision.pedidos.length} para revisar` : ""}
            </div>
            <div className="mt-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {revision?.terminado && revision.total === 0 && (
          <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-600">
            {revision.sinParte > 0
              ? `Hay ${revision.nAlbaranes} albarán${revision.nAlbaranes === 1 ? "" : "es"} en ${tituloMes}, pero ninguno lleva un parte de trabajo (documento externo tipo 12345-2026).`
              : `No hay albaranes de venta registrados en ${tituloMes}.`}
          </div>
        )}

        {revision?.terminado && revision.cuadran > 0 && revision.pedidos.length === 0 && (
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-800">
            Los {revision.cuadran} pedidos con parte en {tituloMes} tienen el material del parte en el albarán.
          </div>
        )}

        {revision?.pedidos?.length > 0 && (
          <div className="mt-3 border border-slate-200 rounded-lg bg-white overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-left">
                  <th className="px-3 py-2 font-semibold">Pedido</th>
                  <th className="px-3 py-2 font-semibold">Cliente</th>
                  <th className="px-3 py-2 font-semibold">Fecha</th>
                  <th className="px-3 py-2 font-semibold">Albarán</th>
                  <th className="px-3 py-2 font-semibold">Parte</th>
                  <th className="px-3 py-2 font-semibold">Material que falta en el albarán</th>
                  <th className="px-3 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {revision.pedidos.map((p) => {
                  const clave = `${p.albaran}|${p.parte}`;
                  const abiertoEste = abierto === clave;
                  return (
                    <React.Fragment key={clave}>
                      <tr
                        className="border-t border-slate-100 align-top cursor-pointer hover:bg-slate-50"
                        onClick={() => setAbierto(abiertoEste ? null : clave)}
                      >
                        <td className="px-3 py-2 font-mono text-slate-800 whitespace-nowrap">{p.pedido || "—"}</td>
                        <td className="px-3 py-2 text-slate-700">{p.cliente || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{fechaCorta(p.fecha) || "—"}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {p.albaran || "—"}
                          {p.otros?.length > 0 && (
                            <div className="font-sans text-[10px] text-slate-400" title={`También ${p.otros.join(", ")}`}>
                              hay {p.otros.length} más
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{p.parte}</td>
                        <td className="px-3 py-2 text-red-800">
                          {(p.falta || []).map((f) => `${f.descripcion || f.codigo} × ${cant(f.falta)}`).join("; ")}
                        </td>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <BotonPdf externo={p.externo} pedido={p.pedido} />
                        </td>
                      </tr>
                      {abiertoEste && (
                        <tr className="border-t border-slate-100 bg-red-50/40">
                          <td colSpan={7} className="px-3 py-2">
                            <table className="w-full text-[12px]">
                              <thead>
                                <tr className="text-slate-500 text-left">
                                  <th className="py-1 pr-2 font-semibold">Código</th>
                                  <th className="py-1 pr-2 font-semibold">Descripción</th>
                                  <th className="py-1 pr-2 font-semibold text-right">En el parte</th>
                                  <th className="py-1 pr-2 font-semibold text-right">En el albarán</th>
                                  <th className="py-1 font-semibold text-right">Falta</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(p.falta || []).map((f) => (
                                  <tr key={f.codigo}>
                                    <td className="py-0.5 pr-2 font-mono">{f.codigo}</td>
                                    <td className="py-0.5 pr-2">{f.descripcion}</td>
                                    <td className="py-0.5 pr-2 text-right">{cant(f.enParte)}</td>
                                    <td className="py-0.5 pr-2 text-right">{cant(f.enAlbaran)}</td>
                                    <td className="py-0.5 text-right font-semibold text-red-800">{cant(f.falta)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
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

        {revision?.avisos?.length > 0 && (
          <div className="mt-3 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="font-semibold">No se ha podido comparar {revision.avisos.length} pedido{revision.avisos.length === 1 ? "" : "s"}.</div>
            <ul className="mt-1 space-y-0.5">
              {revision.avisos.slice(0, 8).map((a) => (
                <li key={`${a.albaran}|${a.parte}`}>{a.pedido || a.albaran} · parte {a.parte}: {a.texto}</li>
              ))}
            </ul>
          </div>
        )}

        {revision?.terminado && revision.sinParte > 0 && revision.total > 0 && (
          <p className="mt-2 text-[11px] text-slate-400">
            {revision.sinParte} albarán{revision.sinParte === 1 ? "" : "es"} del mes sin parte de trabajo: no entran en esta lista.
          </p>
        )}
      </section>
    </div>
  );
}
