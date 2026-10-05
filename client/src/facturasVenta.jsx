/**
 * Historial de facturas de venta emitidas (contabilizadas en BC, salesInvoices).
 * La cabecera sale de la API. Las líneas, si están cargadas en
 * «Líneas Venta REGISTRADAS», se abren al pulsar la factura.
 */
import React, { useEffect, useMemo, useState } from "react";
import { FileText, Mail, RefreshCw, Search, Send, X } from "lucide-react";
import { empresaGuardada } from "./empresa.jsx";

const ESTADOS = {
  open: "Pendiente de cobro",
  paid: "Cobrada",
  draft: "Borrador",
  "in review": "En revisión",
  canceled: "Anulada",
  cancelled: "Anulada",
  corrective: "Rectificativa",
};

function leer(row, nombres) {
  if (!row || typeof row !== "object") return "";
  for (const n of nombres) {
    const v = row[n];
    if (v != null && String(v).trim() !== "") return v;
  }
  const mapa = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const n of nombres) {
    const k = mapa.get(String(n).toLowerCase());
    if (k != null && row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return "";
}

function numBC(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null || v === "") return 0;
  let s = String(v).trim().replace(/\s|€/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function fechaCorta(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function fechaISO(s) {
  const t = String(s || "");
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (iso) return iso[1];
  const es = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (es) return `${es[3]}-${es[2].padStart(2, "0")}-${es[1].padStart(2, "0")}`;
  return "";
}

const eur2 = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

const hoyISO = () => new Date().toISOString().slice(0, 10);
const inicioAnio = () => `${new Date().getFullYear()}-01-01`;

function normalizar(row) {
  const numero = String(leer(row, ["number", "No", "No.", "Document_No"]) || "").trim();
  const fecha = fechaISO(leer(row, ["invoiceDate", "postingDate", "Posting_Date", "Document_Date"]));
  const estadoRaw = String(leer(row, ["status", "Status"]) || "").trim();
  return {
    id: String(row.id || numero),
    numero,
    fecha,
    vencimiento: fechaISO(leer(row, ["dueDate", "Due_Date"])),
    cliente: String(leer(row, ["customerName", "billToName", "Sell_to_Customer_Name", "Bill_to_Name"]) || "").trim(),
    clienteN: String(leer(row, ["customerNumber", "Sell_to_Customer_No"]) || "").trim(),
    pedido: String(leer(row, ["orderNumber", "Order_No"]) || "").trim(),
    ot: String(leer(row, ["noOT", "shortcutDimension2Code", "Shortcut_Dimension_2_Code", "jobNo"]) || "").trim(),
    externo: String(leer(row, ["externalDocumentNumber", "External_Document_No"]) || "").trim(),
    estadoRaw,
    estado: ESTADOS[estadoRaw.toLowerCase()] || estadoRaw || "—",
    email: String(leer(row, ["email", "Email"]) || "").trim(),
    cif: String(leer(row, ["taxRegistrationNumber", "vatRegistrationNumber", "VAT_Registration_No", "Sell_to_VAT_Registration_No"]) || "").trim(),
    base: numBC(leer(row, ["totalAmountExcludingTax", "Amount"])),
    iva: numBC(leer(row, ["totalTaxAmount"])),
    total: numBC(leer(row, ["totalAmountIncludingTax", "Amount_Including_VAT"])),
  };
}

function lineasDeFactura(numero, lineas) {
  if (!numero || !lineas?.length) return [];
  return lineas
    .filter((l) => String(leer(l, ["Document_No", "documentNo", "documentNumber"]) || "").trim() === numero)
    .map((l) => ({
      lineaNo: Number(leer(l, ["Line_No", "sequence"])) || 0,
      numero: String(leer(l, ["No", "No.", "lineObjectNumber"]) || "").trim(),
      descripcion: String(leer(l, ["Description", "description"]) || "").trim(),
      cantidad: numBC(leer(l, ["Quantity", "quantity"])),
      precio: numBC(leer(l, ["Unit_Price", "unitPrice"])),
      importe: numBC(leer(l, ["Line_Amount", "lineAmount", "amount"])),
      ot: String(leer(l, ["Shortcut_Dimension_2_Code", "shortcutDimension2Code", "noOT"]) || "").trim(),
    }))
    .sort((a, b) => a.lineaNo - b.lineaNo);
}

const LS_EMAILS = "facturas_venta_emails_cliente_v1";

function emailRecordado(clave) {
  try {
    const mapa = JSON.parse(localStorage.getItem(LS_EMAILS) || "{}");
    return mapa[clave] || "";
  } catch {
    return "";
  }
}

function recordarEmail(clave, email) {
  if (!clave || !email) return;
  try {
    const mapa = JSON.parse(localStorage.getItem(LS_EMAILS) || "{}");
    mapa[clave] = email;
    localStorage.setItem(LS_EMAILS, JSON.stringify(mapa));
  } catch { /* el navegador puede bloquear el almacén */ }
}

function borradorReclamo(f) {
  const empresa = empresaGuardada()?.displayName || empresaGuardada()?.nombre || "ALSO CASALS";
  const vencida = f.vencimiento && f.vencimiento < hoyISO();
  const cuando = f.vencimiento
    ? (vencida ? `va vèncer el ${fechaCorta(f.vencimiento)}` : `té venciment el ${fechaCorta(f.vencimiento)}`)
    : "està pendent de pagament";
  const cuerpoTexto =
    `Benvolgut/da,\n\n` +
    `Us recordem que la factura ${f.numero}` +
    (f.fecha ? `, de data ${fechaCorta(f.fecha)}` : "") +
    `, per un import de ${eur2(f.total)}, ${cuando}.\n\n` +
    `Us adjuntem la factura en PDF.\n\n` +
    `Us agrairíem que procedíssiu al pagament al més aviat possible. Si ja l'heu fet, feu cas omís d'aquest missatge.\n\n` +
    `Gràcies.\n\n${empresa}`;
  return {
    asunto: asuntoReclamo(f, f.cif),
    cuerpoTexto,
  };
}

function asuntoReclamo(f, cif) {
  return ["RECORDATORIO:", f.cliente, cif, f.numero].filter((p) => String(p || "").trim()).join(" ");
}

function ModalReclamoPago({ factura, onCerrar, onEnviado }) {
  const clave = factura.clienteN || factura.cliente;
  const [para, setPara] = useState(factura.email || emailRecordado(clave));
  const [asunto, setAsunto] = useState(borradorReclamo(factura).asunto);
  const [cuerpo, setCuerpo] = useState(borradorReclamo(factura).cuerpoTexto);
  const [de, setDe] = useState("");
  const [emailBC, setEmailBC] = useState(null);
  const [adjunto, setAdjunto] = useState(null);
  const [estadoPdf, setEstadoPdf] = useState({ cargando: true });
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => { if (d.email) setDe(d.email); })
      .catch(() => {});
    const qs = new URLSearchParams();
    if (factura.clienteN) qs.set("numero", factura.clienteN);
    if (factura.cliente) qs.set("nombre", factura.cliente);
    fetch(`/api/bc/cliente-email?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        const e = (d && d.email) || "";
        const cif = (d && d.cif) || "";
        setEmailBC(e);
        setPara((actual) => actual || e);
        if (cif) {
          setAsunto((actual) => (actual === asuntoReclamo(factura, factura.cif) ? asuntoReclamo(factura, cif) : actual));
        }
      })
      .catch(() => setEmailBC(""));
    const qsPdf = new URLSearchParams();
    if (factura.id) qsPdf.set("id", factura.id);
    if (factura.numero) qsPdf.set("numero", factura.numero);
    fetch(`/api/bc/factura-venta-pdf?${qsPdf}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok || !d.base64) throw new Error(d.detalle || d.error || "No se pudo obtener el PDF.");
        setAdjunto({ nombre: d.nombre, base64: d.base64, mime: d.mime || "application/pdf" });
        setEstadoPdf(null);
      })
      .catch((e) => setEstadoPdf({ error: e.message || String(e) }));
  }, [factura]);

  const enviar = async () => {
    const destinatarios = para.split(/[;,\s]+/).map((e) => e.trim()).filter(Boolean);
    if (!destinatarios.length) { setError("Indica el email del cliente."); return; }
    if (!asunto.trim()) { setError("Falta el asunto."); return; }
    setEnviando(true);
    setError(null);
    try {
      const cuerpoHtml = cuerpo
        .split(/\r?\n/)
        .map((l) => (l ? l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "<br/>"))
        .join("<br/>");
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          asunto: asunto.trim(),
          cuerpoHtml,
          adjunto: adjunto ? { nombre: adjunto.nombre, base64: adjunto.base64, mime: adjunto.mime } : null,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      recordarEmail(clave, destinatarios[0]);
      onEnviado?.();
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCerrar}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div>
            <div className="text-sm font-semibold text-slate-800">Reclamar el pago · factura {factura.numero}</div>
            <div className="text-[11px] text-slate-500">
              {factura.cliente || "Sin cliente"}
              {factura.vencimiento ? ` · vence ${fechaCorta(factura.vencimiento)}` : ""}
              {de ? ` · desde ${de}` : ""}
            </div>
          </div>
          <button type="button" onClick={onCerrar} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 text-sm">
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Para</span>
            <input
              value={para}
              onChange={(e) => setPara(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-purple-400"
              placeholder="email del cliente"
            />
            <span className="block mt-1 text-[11px] text-slate-400">
              {emailBC === null ? "Consultando la ficha del cliente en BC…" : emailBC ? `Ficha BC: ${emailBC}` : "La ficha del cliente en BC no tiene email. Escríbelo y se recordará."}
            </span>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Asunto</span>
            <input value={asunto} onChange={(e) => setAsunto(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-purple-400" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Mensaje</span>
            <textarea value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} rows={10} className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-purple-400" />
          </label>
          <div className="flex items-center gap-2 text-[12px] text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
            <FileText size={14} className="text-purple-600 flex-shrink-0" />
            {adjunto ? (
              <span>Adjunto: <strong>{adjunto.nombre}</strong></span>
            ) : estadoPdf?.cargando ? (
              <span>Preparando el PDF de la factura…</span>
            ) : (
              <span className="text-amber-700">{estadoPdf?.error || "Sin PDF. El correo se enviará sin la factura."}</span>
            )}
          </div>
          {error && <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button type="button" onClick={onCerrar} disabled={enviando} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-white">Cancelar</button>
          <button type="button" onClick={enviar} disabled={enviando || estadoPdf?.cargando} className="text-sm font-semibold px-4 py-1.5 rounded-md text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Send size={14} />
            {enviando ? "Enviando…" : estadoPdf?.cargando ? "Preparando PDF…" : "Enviar correo"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FacturasVenta({ facturas = [], lineas = [], onActualizar, actualizando }) {
  const [desde, setDesde] = useState(inicioAnio);
  const [hasta, setHasta] = useState(hoyISO);
  const [vDesde, setVDesde] = useState("");
  const [vHasta, setVHasta] = useState("");
  const [q, setQ] = useState("");
  const [fCli, setFCli] = useState("");
  const [fEstado, setFEstado] = useState("");
  const [abierta, setAbierta] = useState(null);
  const [reclamo, setReclamo] = useState(null);
  const [enviadas, setEnviadas] = useState({});
  const [error, setError] = useState(null);

  const todas = useMemo(() => {
    const lista = (facturas || []).map(normalizar).filter((f) => f.numero);
    lista.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || b.numero.localeCompare(a.numero, "es"));
    return lista;
  }, [facturas]);

  const clientes = useMemo(() => [...new Set(todas.map((f) => f.cliente).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")), [todas]);
  const estados = useMemo(() => [...new Set(todas.map((f) => f.estado).filter((e) => e && e !== "—"))].sort(), [todas]);

  const visibles = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return todas.filter((f) => {
      if (desde && f.fecha && f.fecha < desde) return false;
      if (hasta && f.fecha && f.fecha > hasta) return false;
      if (vDesde && (!f.vencimiento || f.vencimiento < vDesde)) return false;
      if (vHasta && (!f.vencimiento || f.vencimiento > vHasta)) return false;
      if (fCli && f.cliente !== fCli) return false;
      if (fEstado && f.estado !== fEstado) return false;
      if (qq && ![f.numero, f.cliente, f.ot, f.pedido, f.externo].some((v) => String(v || "").toLowerCase().includes(qq))) return false;
      return true;
    });
  }, [todas, desde, hasta, vDesde, vHasta, q, fCli, fEstado]);

  const total = visibles.reduce((a, f) => a + f.total, 0);
  const cobradas = visibles.filter((f) => f.estadoRaw.toLowerCase() === "paid").length;

  const cargar = async () => {
    if (!onActualizar) return;
    setError(null);
    const res = await onActualizar(desde, hasta);
    if (res?.error) setError([res.error, res.detalle].filter(Boolean).join(" — "));
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-1">Facturas de venta emitidas</h1>
          <p className="text-sm text-slate-500 mb-4">
            Historial de facturas de venta contabilizadas en Business Central. Al actualizar se añaden las de las fechas elegidas, sin borrar las que ya estaban cargadas.
          </p>
        </div>
        <button
          type="button"
          onClick={cargar}
          disabled={actualizando || !onActualizar}
          className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2 shrink-0"
        >
          <RefreshCw size={15} className={actualizando ? "animate-spin" : ""} />
          {actualizando ? "Cargando…" : "Actualizar desde BC"}
        </button>
      </div>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nº, cliente, OT, pedido…" className="pl-7 pr-2 py-1.5 border border-slate-300 rounded-md w-52" />
        </div>
        <select value={fCli} onChange={(e) => setFCli(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md max-w-[220px]">
          <option value="">Clientes</option>
          {clientes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={fEstado} onChange={(e) => setFEstado(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
          <option value="">Estado</option>
          {estados.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <label className="text-slate-500 text-xs">Factura</label>
        <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} title="Fecha de factura, desde" className="py-1.5 px-2 border border-slate-300 rounded-md" />
        <span className="text-slate-400">–</span>
        <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} title="Fecha de factura, hasta" className="py-1.5 px-2 border border-slate-300 rounded-md" />
        <label className="text-slate-500 text-xs">Vencimiento</label>
        <input type="date" value={vDesde} onChange={(e) => setVDesde(e.target.value)} title="Vencimiento, desde" className="py-1.5 px-2 border border-slate-300 rounded-md" />
        <span className="text-slate-400">–</span>
        <input type="date" value={vHasta} onChange={(e) => setVHasta(e.target.value)} title="Vencimiento, hasta" className="py-1.5 px-2 border border-slate-300 rounded-md" />
        <button
          type="button"
          onClick={() => { setVDesde(""); setVHasta(new Date(Date.now() - 86400000).toISOString().slice(0, 10)); }}
          className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 hover:bg-amber-100"
        >
          Solo vencidas
        </button>
        {(q || fCli || fEstado || vDesde || vHasta) && (
          <button type="button" onClick={() => { setQ(""); setFCli(""); setFEstado(""); setVDesde(""); setVHasta(""); }} className="text-slate-500 hover:underline">Limpiar</button>
        )}
        <span className="ml-auto text-slate-600">
          {visibles.length.toLocaleString("es-ES")} factura(s) · <strong>{eur2(total)}</strong>
          {cobradas > 0 && <span className="text-slate-400"> · {cobradas} cobrada(s)</span>}
        </span>
      </div>

      {todas.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          Aún no hay facturas cargadas. Elige las fechas y pulsa «Actualizar desde BC».
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-100 text-slate-600 text-left">
                {["Factura", "Fecha", "Vencimiento", "Cliente", "Pedido", "OT", "Estado", "Base", "Total", ""].map((h) => (
                  <th key={h || "correo"} className={`px-2 py-2 font-semibold whitespace-nowrap ${h === "Base" || h === "Total" ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibles.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">Ninguna factura con estos filtros.</td></tr>
              )}
              {visibles.map((f) => {
                const abiertaEsta = abierta === f.id;
                const det = abiertaEsta ? lineasDeFactura(f.numero, lineas) : [];
                return (
                  <React.Fragment key={f.id}>
                    <tr
                      className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setAbierta(abiertaEsta ? null : f.id)}
                    >
                      <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap">
                        <span className="text-slate-400 mr-1">{abiertaEsta ? "▾" : "▸"}</span>
                        {f.numero}
                        {f.externo ? <div className="text-[10px] font-normal text-slate-400">{f.externo}</div> : null}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fechaCorta(f.fecha) || "—"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fechaCorta(f.vencimiento) || "—"}</td>
                      <td className="px-2 py-1.5 max-w-[220px] truncate" title={f.cliente}>{f.cliente || "—"}</td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">{f.pedido || "—"}</td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">{f.ot || "—"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className={`text-[10px] font-bold rounded border px-1.5 py-0.5 ${f.estadoRaw.toLowerCase() === "paid" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : f.estadoRaw.toLowerCase() === "open" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-600 border-slate-200"}`}>
                          {f.estado}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{eur2(f.base)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-blue-700">{eur2(f.total)}</td>
                      <td className="px-2 py-1.5 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setReclamo(f)}
                          title="Enviar desde la app un correo al cliente para reclamar el pago"
                          className="inline-flex items-center justify-center text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded p-1"
                        >
                          <Mail size={14} />
                        </button>
                        {enviadas[f.id] && <span className="text-[10px] font-semibold text-emerald-600">✓</span>}
                      </td>
                    </tr>
                    {abiertaEsta && (
                      <tr className="bg-slate-50">
                        <td colSpan={10} className="px-4 py-2">
                          {det.length === 0 ? (
                            <p className="text-[11px] text-slate-400">
                              {lineas?.length
                                ? "No hay líneas registradas con este número de factura."
                                : "Para ver las líneas, carga «Líneas Venta REGISTRADAS» en Cargar datos."}
                            </p>
                          ) : (
                            <table className="w-full text-[11px] bg-white border border-slate-200 rounded">
                              <thead>
                                <tr className="text-slate-500 text-left">
                                  <th className="px-2 py-1">Nº</th>
                                  <th className="px-2 py-1">Descripción</th>
                                  <th className="px-2 py-1">OT</th>
                                  <th className="px-2 py-1 text-right">Cantidad</th>
                                  <th className="px-2 py-1 text-right">Precio</th>
                                  <th className="px-2 py-1 text-right">Importe</th>
                                </tr>
                              </thead>
                              <tbody>
                                {det.map((l, i) => (
                                  <tr key={`${l.lineaNo}-${i}`} className="border-t border-slate-100">
                                    <td className="px-2 py-1 font-mono">{l.numero || "—"}</td>
                                    <td className="px-2 py-1">{l.descripcion || "—"}</td>
                                    <td className="px-2 py-1 font-mono">{l.ot || "—"}</td>
                                    <td className="px-2 py-1 text-right">{l.cantidad.toLocaleString("es-ES", { maximumFractionDigits: 2 })}</td>
                                    <td className="px-2 py-1 text-right">{eur2(l.precio)}</td>
                                    <td className="px-2 py-1 text-right font-semibold">{eur2(l.importe)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
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
      {reclamo && (
        <ModalReclamoPago
          factura={reclamo}
          onCerrar={() => setReclamo(null)}
          onEnviado={() => { setEnviadas((prev) => ({ ...prev, [reclamo.id]: true })); setReclamo(null); }}
        />
      )}
    </div>
  );
}
