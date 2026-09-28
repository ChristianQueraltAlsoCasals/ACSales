/**
 * recepcion.jsx — Pantalla de RECEPCIÓN portada del Agente de Compras (5005).
 *
 * Muestra los pedidos con material PENDIENTE DE RECIBIR, cruzando las
 * CABECERAS de pedido (dataset "pedidos" = pedidos_compra de BC) con sus
 * LÍNEAS (dataset "solicitudes" = lineas_compra de BC) por Nº de documento.
 *
 * La lógica (getRecepData, precioNetoFila, recepMapFor, prioridades,
 * alertas, KPIs) es IDÉNTICA a la del traspaso (Anexo A) — solo adaptada
 * a React y a las columnas de BC ya renombradas en este proyecto.
 *
 * Datos: se alimentan de lo que ya carga «Cargar datos» (bcData), más un
 * botón propio «Actualizar desde BC» que refresca líneas y cabeceras.
 *
 * Marcas de revisado y fechas editadas: COMPARTIDAS entre equipos, vía
 * el backend (/api/recepcion), no en el navegador.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { RefreshCw, Search, CheckCircle2, Mail, X, Upload, ChevronRight, ChevronDown, Send, StickyNote, Trash2 } from "lucide-react";
import { emailsPorCodigoDepartamento, EMAIL_POR_DEFECTO } from "./departamentos.js";

// --- utilidades de formato (es-ES) ---
const parseNum = (v) => {
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/\s|€/g, "");
  // formato español: 1.234,56 → 1234.56
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
};
const fmtEur = (n) =>
  isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
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
// Fecha de BC → "dd/mm/aaaa" (las fechas vacías de BC llegan como 0001-01-01)
const fmtFecha = (s) => {
  const d = parseFecha(s);
  if (!d || d.getFullYear() < 1900) return "";
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const fmtCant = (n) => (isNaN(n) ? "—" : n.toLocaleString("es-ES", { maximumFractionDigits: 3 }));
const escHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const partirEmails = (t) => String(t || "").split(/[;,\s]+/).map((x) => x.trim()).filter((x) => /.+@.+\..+/.test(x));

const selloHora = (iso) =>
  new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

// --- detección tolerante de columnas de pedidos (Anexo A.3) ---
function recepMapFor(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (res) => {
    for (const re of res) {
      const i = lower.findIndex((h) => re.test(h));
      if (i >= 0) return headers[i];
    }
    return "";
  };
  return {
    // Se reconocen nombres en ESPAÑOL (tras mapeo) e INGLÉS (crudo de BC).
    numero: find([/^no$/, /^document_no$/, /^nº$/, /^n[º°o]\.?$/, /n[º°] pedido/, /pedido/]) || headers[0],
    fecha: find([/^order_date$/, /fecha registro/, /fecha emisi/, /^fecha$/, /fecha/]),
    fechaRecepPrev: find([/^posting_date$/, /fecha recepci[oó]n prevista/, /recepci[oó]n prevista/]),
    provNum: find([/^buy_from_vendor_no$/, /^pay_to_vendor_no$/, /compra a-n[º°o]/, /n[º°o]\.? proveedor/]),
    proveedor: find([/^buy_from_vendor_name$/, /^pay_to_name$/, /compra a-nombre/, /nombre.*proveedor/, /prove(?!.*autoriz)/]),
    esperar: find([/^on_hold$/, /^esperar$/, /esperar/]),
    departamento: find([/^shortcut_dimension_1_code$/, /departamento/, /unidad de negocio/]),
    ot: find([/^shortcut_dimension_2_code$/, /c[oó]d\.? ot/, /\bot\b/]),
    comprador: find([/^cdcpurchasercode$/, /^purchaser_code$/, /c[oó]d\.? comprador/, /comprador/]),
    alianza: find([/^compra_con_alianza$/, /compra con alianza/, /alianza/]),
    estado: find([/^status$/, /^estado$/]),
  };
}

// --- precio neto de una línea (Anexo A.2) ---
function precioNetoFila(r, cols) {
  // 1º: "Coste unitario" de BC (ya neto)
  if (cols.costeUnit) {
    const cu = parseNum(r[cols.costeUnit]);
    if (!isNaN(cu) && cu > 0) return cu;
  }
  // 2º: desde el directo y los 3 descuentos en cascada
  let base = parseNum(r[cols.directo]);
  if (isNaN(base) || base <= 0) return NaN;
  [cols.d1, cols.d2, cols.d3].forEach((c) => {
    if (!c) return;
    const d = parseNum(r[c]);
    if (!isNaN(d) && d > 0) base = base * (1 - d / 100);
  });
  return base;
}

function colsLineas(headers) {
  const low = headers.map((h) => h.toLowerCase());
  const H = (re) => headers[low.findIndex((h) => re.test(h))] || "";
  return {
    // Español (tras mapeo) e inglés (crudo de BC).
    doc: H(/^document_no$/) || H(/n[º°o]?\.?\s*documento/),
    importe: H(/^line_amount$/) || H(/importe l[ií]nea/),
    pend: H(/^outstanding_quantity$/) || H(/cantidad pendiente/),
    ot: H(/^shortcut_dimension_2_code$/) || H(/c[oó]d\.?\s*ot/),
    un: H(/^shortcut_dimension_1_code$/) || H(/unidad de negocio|departamento/),
    costeUnit: H(/^unit_cost$/) || H(/^coste unitario$/),
    directo: H(/^direct_unit_cost$/) || H(/coste unit\.? directo/),
    d1: H(/^percent_dto_linea_1$/) || H(/%\s*dto\.?\s*1/),
    d2: H(/^percent_dto_linea_2$/) || H(/%\s*dto\.?\s*2/),
    d3: H(/^percent_dto_linea_3$/) || H(/%\s*dto\.?\s*3/),
    // Para el DETALLE de líneas y la reclamación al proveedor
    lineNo: H(/^line_no$/) || H(/n[º°o]\.?\s*l[ií]nea/),
    art: H(/^no$/) || H(/^n[º°o]\.?$/),
    desc: H(/^description$/) || H(/^descripci[oó]n$/),
    cant: H(/^quantity$/) || H(/^cantidad$/),
    recib: H(/^quantity_received$/) || H(/cantidad recibida/),
    ud: H(/^unit_of_measure_code$/) || H(/unidad.*medida/),
    fechaEsp: H(/^expected_receipt_date$/) || H(/fecha recepci[oó]n esperada/),
  };
}

// --- EL NÚCLEO: cruce pedidos↔líneas (Anexo A.4) ---
function getRecepData(pedidos, lineas, recepFechas) {
  if (!pedidos?.headers?.length) return null;
  const m = recepMapFor(pedidos.headers);
  const hoy = new Date();
  const pendientes = [], excluidos = [];

  // Índice de líneas por nº de pedido
  const idxLineas = {};
  if (lineas?.headers?.length) {
    const lc = colsLineas(lineas.headers);
    if (lc.doc) {
      lineas.rows.forEach((r) => {
        const pc = String(r[lc.doc] || "").trim().toUpperCase();
        if (!pc) return;
        if (!idxLineas[pc]) idxLineas[pc] = { importe: 0, pendiente: 0, ot: "", un: "", lineas: [] };
        const o = idxLineas[pc];
        const impL = parseNum(r[lc.importe]);
        if (!isNaN(impL)) o.importe += impL;
        const qPend = lc.pend ? parseNum(r[lc.pend]) : NaN;
        const neto = precioNetoFila(r, lc);
        if (!isNaN(qPend) && qPend > 0) {
          if (!isNaN(neto)) o.pendiente += qPend * neto;
        }
        // Detalle de la línea (se omiten las líneas de solo texto: sin Nº y sin cantidad)
        const art = lc.art ? String(r[lc.art] || "").trim() : "";
        const cant = lc.cant ? parseNum(r[lc.cant]) : NaN;
        if (art || (!isNaN(cant) && cant !== 0)) {
          o.lineas.push({
            lineNo: lc.lineNo ? Number(r[lc.lineNo]) || 0 : o.lineas.length,
            art,
            desc: lc.desc ? String(r[lc.desc] || "").trim() : "",
            cant,
            recib: lc.recib ? parseNum(r[lc.recib]) : NaN,
            pend: qPend,
            ud: lc.ud ? String(r[lc.ud] || "").trim() : "",
            neto,
            impPend: !isNaN(qPend) && qPend > 0 && !isNaN(neto) ? qPend * neto : 0,
            fechaEsp: lc.fechaEsp ? String(r[lc.fechaEsp] || "").trim() : "",
          });
        }
        if (!o.ot && lc.ot) { const v = String(r[lc.ot] || "").trim(); if (v) o.ot = v; }
        if (!o.un && lc.un) { const v = String(r[lc.un] || "").trim(); if (v) o.un = v; }
      });
    }
  }

  // BC a veces devuelve la MISMA cabecera dos veces al paginar (p. ej. si el pedido pasa de Abierto a
  // Lanzado mientras se descarga). Se deja una sola fila por Nº (la última leída) para que no salga
  // repetido ni se descoloque el detalle de otro pedido.
  const filasUnicas = [...new Map(pedidos.rows.map((r) => [String(r[m.numero] || "").trim().toUpperCase(), r])).values()];
  filasUnicas.forEach((r) => {
    const num = String(r[m.numero] || "").trim();
    const calc = idxLineas[num.toUpperCase()] || { importe: 0, pendiente: 0, ot: "", un: "", lineas: [] };
    const imp = calc.importe;
    const impPend = calc.pendiente;
    const ot = (String(r[m.ot] || "").trim()) || calc.ot;
    const un = (m.departamento ? String(r[m.departamento] || "").trim() : "") || calc.un;
    const esperar = m.esperar ? String(r[m.esperar] || "").trim() : "";
    const fStr = String(r[m.fecha] || "").trim();
    const f = parseFecha(fStr);
    const dias = f ? Math.floor((hoy - f) / 86400000) : null;
    const tipoDoc = /^oc/i.test(num) ? "Oferta" : /^pc/i.test(num) ? "Pedido" : "";
    const alianzaRaw = m.alianza ? r[m.alianza] : "";
    const alianza = alianzaRaw === true || /^(s[ií]|true|1|verdadero)$/i.test(String(alianzaRaw).trim());
    const item = {
      num, tipoDoc, fecha: fStr, dias, imp, impPend, esperar,
      recepPrev: (recepFechas && recepFechas[num]) || (m.fechaRecepPrev ? String(r[m.fechaRecepPrev] || "").trim() : ""),
      prov: String(r[m.proveedor] || "").trim(),
      provNum: m.provNum ? String(r[m.provNum] || "").trim() : "",
      lineas: [...calc.lineas].sort((a, b) => a.lineNo - b.lineNo),
      depto: un, ot,
      comprador: m.comprador ? String(r[m.comprador] || "").trim() : "",
      alianza,
    };
    if (esperar) { excluidos.push(item); return; }
    item.prioridad = dias === null ? "Normal" : dias > 60 ? "Urgente" : dias >= 30 ? "Reclamar" : dias >= 15 ? "Revisar" : "Normal";
    item.alertas = [];
    if (impPend < 0) item.alertas.push("➖ importe negativo");
    if (impPend > 1000) item.alertas.push("💶 importe alto");
    if (!item.ot) item.alertas.push("❓ falta OT");
    pendientes.push(item);
  });

  const rank = { Urgente: 4, Reclamar: 3, Revisar: 2, Normal: 1 };
  pendientes.sort((a, b) => rank[b.prioridad] - rank[a.prioridad] || Math.abs(b.impPend) - Math.abs(a.impPend));
  return { map: m, pendientes, excluidos, tieneLineas: !!lineas?.headers?.length };
}

const COLOR_PRIORIDAD = {
  Urgente: "bg-red-100 text-red-700 border-red-200",
  Reclamar: "bg-orange-100 text-orange-700 border-orange-200",
  Revisar: "bg-amber-100 text-amber-700 border-amber-200",
  Normal: "bg-slate-100 text-slate-500 border-slate-200",
};

// ---------------------------------------------------------------------
// RECLAMACIÓN AL PROVEEDOR — borrador de correo con las líneas pendientes
// ---------------------------------------------------------------------
// Recibe TODOS los pedidos pendientes del proveedor y marca de inicio el
// pedido desde el que se ha pulsado ✉ (o todos, si se pulsa «Reclamar
// todo a este proveedor»). Para = email de la ficha del proveedor en BC
// (o el recordado), CC = responsables del departamento de cada OT.
// Se envía vía Graph desde el buzón personal (/api/correo/enviar).
function htmlReclamacion(pedidosSel, intro, cierre) {
  const parrafos = (t) => escHtml(t).split(/\n/).join("<br>");
  const th = 'style="text-align:left;padding:4px 8px;border-bottom:1px solid #cbd5e1;background:#f1f5f9;font-size:12px"';
  const td = 'style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:12px"';
  const tdR = 'style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right"';
  const bloques = pedidosSel.map((p) => {
    const pend = p.lineas.filter((l) => l.pend > 0);
    const filas = pend.length
      ? pend.map((l) => `<tr><td ${td}>${escHtml(l.art)}</td><td ${td}>${escHtml(l.desc)}</td><td ${tdR}>${fmtCant(l.cant)}</td><td ${tdR}><b>${fmtCant(l.pend)}</b></td><td ${td}>${escHtml(l.ud)}</td><td ${td}>${escHtml(fmtFecha(l.fechaEsp))}</td></tr>`).join("")
      : `<tr><td ${td} colspan="6">(ver pedido)</td></tr>`;
    return `<p style="margin:14px 0 4px;font-size:13px"><b>Pedido ${escHtml(p.num)}</b>${p.fecha ? ` · fecha pedido ${escHtml(fmtFecha(p.fecha) || p.fecha)}` : ""}${p.ot ? ` · Ref. obra ${escHtml(p.ot)}` : ""}</p>
<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif"><thead><tr><th ${th}>Código</th><th ${th}>Descripción</th><th ${th}>Cant. pedida</th><th ${th}>Pendiente</th><th ${th}>Ud.</th><th ${th}>Fecha prevista</th></tr></thead><tbody>${filas}</tbody></table>`;
  }).join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1e293b"><p>${parrafos(intro)}</p>${bloques}<p style="margin-top:16px">${parrafos(cierre)}</p></div>`;
}

// Personas que van SIEMPRE en copia de las reclamaciones a proveedores (25/09/2026)
const CC_SIEMPRE = ["ana.moreno@ferrosca.com"];

function ModalReclamacion({ proveedor, provNum, pedidosProv, inicial, emailGuardado, reclamados, onClose, onEnviado }) {
  const [sel, setSel] = useState(() => new Set(inicial));
  const [para, setPara] = useState(emailGuardado || "");
  const [emailBC, setEmailBC] = useState(null); // null = consultando, "" = la ficha no tiene
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const elegidos = pedidosProv.filter((p) => sel.has(p.num));

  // CC automático = responsables del departamento de CADA pedido marcado + los que van siempre.
  // Al marcar/desmarcar pedidos se recalcula, conservando lo que Maria haya escrito a mano.
  const ccAutoDe = (nums) => {
    const set = new Set();
    pedidosProv.filter((p) => nums.has(p.num)).forEach((p) => (emailsPorCodigoDepartamento(p.depto) || [EMAIL_POR_DEFECTO]).forEach((e) => set.add(e)));
    CC_SIEMPRE.forEach((e) => set.add(e)); // en copia en TODAS las reclamaciones
    return [...set];
  };
  const autoPrevRef = useRef(ccAutoDe(new Set(inicial)));
  const [cc, setCc] = useState(() => autoPrevRef.current.join("; "));
  useEffect(() => {
    const nuevoAuto = ccAutoDe(sel);
    setCc((actual) => {
      const previos = new Set(autoPrevRef.current.map((e) => e.toLowerCase()));
      const aMano = partirEmails(actual).filter((e) => !previos.has(e.toLowerCase()));
      const vistos = new Set();
      return [...nuevoAuto, ...aMano].filter((e) => { const k = e.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; }).join("; ");
    });
    autoPrevRef.current = nuevoAuto;
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const asuntoAuto = elegidos.length === 1
    ? `Reclamación pedido ${elegidos[0].num} – ALSO CASALS`
    : `Reclamación de material pendiente (${elegidos.length} pedidos) – ALSO CASALS`;
  const [asunto, setAsunto] = useState(null); // null = automático
  const [intro, setIntro] = useState(
    "Buenos días,\n\nOs escribimos para preguntar si el material pendiente de entrega de los pedidos que detallamos a continuación ya se ha enviado. Si todavía no, os agradeceríamos que nos confirmarais la fecha prevista de entrega o, si hay alguna incidencia, que nos la indicarais lo antes posible.\n\nEn caso de que el material ya se haya entregado, os rogamos que nos enviéis el albarán de entrega firmado."
  );
  const [cierre, setCierre] = useState("Gracias de antemano.\n\nUn saludo,\nMaria Rufí\nALSO CASALS INSTAL·LACIONS, S.L.");

  // Email desde la ficha del proveedor en BC
  useEffect(() => {
    const qs = new URLSearchParams({ numero: provNum || "", nombre: proveedor || "" });
    fetch(`/api/bc/proveedor-email?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        const e = (d && d.email) || "";
        setEmailBC(e);
        if (e && !emailGuardado) setPara(e);
      })
      .catch(() => setEmailBC(""));
  }, [proveedor, provNum]);

  const html = useMemo(() => htmlReclamacion(elegidos, intro, cierre), [elegidos, intro, cierre]);

  const enviar = async () => {
    const destProv = partirEmails(para);
    // Sin email del proveedor se envía igual: a las personas de CC (o, si tampoco hay, a Maria)
    const sinProveedor = !destProv.length;
    const copias = partirEmails(cc);
    const dest = sinProveedor ? (copias.length ? copias : ["maria.rufi@alsocasals.com"]) : destProv;
    const ccEnvio = sinProveedor ? [] : copias;
    if (!elegidos.length) { setError("Marca al menos un pedido."); return; }
    setEnviando(true); setError(null);
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ para: dest, cc: ccEnvio, asunto: asunto ?? asuntoAuto, cuerpoHtml: html }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      onEnviado({ pedidos: elegidos.map((p) => p.num), para: sinProveedor ? `${dest.join("; ")} (sin email del proveedor)` : dest.join("; "), recordarEmail: !sinProveedor && dest.join("; ") !== (emailBC || "") ? dest.join("; ") : null });
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Mail size={18} /> Reclamar a {proveedor || "proveedor"}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="text-xs font-semibold text-slate-500 mb-1">Pedidos a incluir ({elegidos.length} de {pedidosProv.length} pendientes de este proveedor)</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-[12px]">
          {pedidosProv.map((p) => {
            const rc = reclamados[p.num];
            return (
              <label key={p.num} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={sel.has(p.num)} onChange={(e) => setSel((prev) => { const n = new Set(prev); e.target.checked ? n.add(p.num) : n.delete(p.num); return n; })} />
                <span className="font-mono font-semibold">{p.num}</span>
                <span className="text-slate-400">{p.dias != null ? `${p.dias} d` : ""} · {fmtEur(p.impPend)}{rc ? ` · ✉ ${rc.veces || 1}×` : ""}</span>
              </label>
            );
          })}
          {pedidosProv.length > 1 && (
            <button onClick={() => setSel(new Set(pedidosProv.map((p) => p.num)))} className="text-blue-600 hover:underline">Marcar todos</button>
          )}
        </div>

        <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-2 items-center text-[13px] mb-3">
          <label className="text-xs font-semibold text-slate-500">Para</label>
          <div>
            <input value={para} onChange={(e) => setPara(e.target.value)} placeholder="email del proveedor (si lo dejas vacío, se envía solo a las personas de CC)" className="w-full border border-slate-300 rounded px-2 py-1" />
            <div className="text-[10px] text-slate-400 mt-0.5">
              {emailBC === null ? "Consultando la ficha del proveedor en BC…" : emailBC ? `Ficha BC: ${emailBC}` : "La ficha del proveedor en BC no tiene email — escríbelo y se recordará para la próxima vez."}
              {emailGuardado && emailGuardado !== emailBC ? ` · Recordado: ${emailGuardado}` : ""}
            </div>
          </div>
          <label className="text-xs font-semibold text-slate-500">CC</label>
          <input value={cc} onChange={(e) => setCc(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500">Asunto</label>
          <input value={asunto ?? asuntoAuto} onChange={(e) => setAsunto(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Texto inicial</label>
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={4} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Despedida</label>
          <textarea value={cierre} onChange={(e) => setCierre(e.target.value)} rows={4} className="w-full border border-slate-300 rounded px-2 py-1" />
        </div>

        <div className="text-xs font-semibold text-slate-500 mb-1">Vista previa del correo</div>
        <div className="border border-slate-200 rounded-md p-3 bg-slate-50 max-h-72 overflow-y-auto" dangerouslySetInnerHTML={{ __html: html }} />

        {error && <div className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2">✗ {error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-sm border border-slate-300 rounded-md px-4 py-2 hover:bg-slate-50">Cancelar</button>
          <button onClick={enviar} disabled={enviando || !elegidos.length} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
            {enviando ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />} Enviar reclamación
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// CARGOS DE PRODUCTO de BC (se cargan de /api/bc/cargos; esta es la lista
// de respaldo, la misma que tiene hoy BC) y sugerencia según el texto del albarán
// ---------------------------------------------------------------------
const CARGOS_PROD_RESPALDO = [
  { numero: "COMB", descripcion: "COMBUSTIBLE" },
  { numero: "CORTE", descripcion: "CORTE" },
  { numero: "DES", descripcion: "DESCUENTO" },
  { numero: "ELEC", descripcion: "CARGA ELECTRICA" },
  { numero: "MANIPULACION", descripcion: "MANIPULACION" },
  { numero: "REPARACIÓN", descripcion: "REPARACIÓN VEHÍCULO" },
  { numero: "REPFONDO", descripcion: "REPERCUSIÓN FONDO ECONÓMICO" },
  { numero: "SEGURO", descripcion: "SEGUROS" },
  { numero: "TASARES", descripcion: "TASA RESIDUOS" },
  { numero: "TRANSPORTE", descripcion: "TRANSPORTE" },
];
function sugerirCargo(texto) {
  const t = String(texto || "").toUpperCase();
  if (/TASA|RESIDU|ECOTASA|RAEE|ECO-?RAEE/.test(t)) return "TASARES";
  if (/COMBUST|GASOIL|GASOLIN/.test(t)) return "COMB";
  if (/SEGUR/.test(t)) return "SEGURO";
  if (/MANIPUL/.test(t)) return "MANIPULACION";
  if (/CORTE/.test(t)) return "CORTE";
  if (/DESCUENT|DTO/.test(t)) return "DES";
  if (/FONDO/.test(t)) return "REPFONDO";
  if (/CARGA EL|ELECTRIC/.test(t)) return "ELEC";
  return "TRANSPORTE"; // portes, envío, delivery, desplazamiento…
}

// ---------------------------------------------------------------------
// BUSCADOR DE ARTÍCULOS de BC (para añadir líneas de material al pedido)
// ---------------------------------------------------------------------
function BuscadorArticulo({ valor, inicial, disabled, onElegir }) {
  const [q, setQ] = useState(inicial || "");
  const [res, setRes] = useState([]);
  const [abierto, setAbierto] = useState(false);
  const [buscando, setBuscando] = useState(false);
  useEffect(() => {
    if (disabled || q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const d = await (await fetch(`/api/bc/articulos?q=${encodeURIComponent(q.trim())}`)).json();
        setRes(d.articulos || []);
      } catch { setRes([]); }
      setBuscando(false);
    }, 350);
    return () => clearTimeout(t);
  }, [q, disabled]);
  if (disabled) return <span className="font-mono">{valor}</span>;
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setAbierto(true); }}
        onFocus={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 200)}
        placeholder="Buscar artículo (nº o texto)…"
        className={`border rounded px-1 py-0.5 w-44 bg-white ${valor ? "border-emerald-300" : "border-amber-400"}`}
      />
      {valor && <div className="text-[10px] font-mono text-emerald-700">✓ {valor}</div>}
      {abierto && (buscando || res.length > 0 || q.trim().length >= 2) && (
        <div className="absolute z-20 mt-0.5 w-96 max-h-60 overflow-y-auto bg-white border border-slate-300 rounded shadow-lg">
          {buscando && <div className="px-2 py-1 text-slate-400">Buscando en BC…</div>}
          {!buscando && res.length === 0 && <div className="px-2 py-1 text-slate-400">Sin resultados — prueba con otra palabra.</div>}
          {res.map((a) => (
            <button
              key={a.numero}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onElegir(a); setQ(a.numero); setAbierto(false); }}
              className="block w-full text-left px-2 py-1 hover:bg-blue-50"
            >
              <span className="font-mono text-slate-500">{a.numero}</span> — {a.descripcion}
              {a.ud ? <span className="text-slate-400"> · {a.ud}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// ¿Este pedido del PDF ya está recibido/registrado? → se oculta al subir.
// Devuelve el motivo (texto) o null.
//  1) Registrado desde esta app con el MISMO Nº de albarán.
//  2) Registrado desde esta app en los últimos 3 días (aunque la IA haya
//     leído el albarán distinto esta vez).
//  3) En BC, las líneas del pedido que coinciden con el albarán ya no
//     tienen nada pendiente de recibir (o el pedido entero está recibido).
// ---------------------------------------------------------------------
function motivoYaRecibido(g, registrados) {
  const ped = String(g.pedido || "").toUpperCase();
  if (!ped) return null;
  const alb = String(g.albaran || "").trim().toUpperCase();
  const reg = registrados || {};
  if (reg[`${ped}|${alb}`]) return `Registrado desde la app el ${selloHora(reg[`${ped}|${alb}`].ts)} (mismo albarán)`;
  const recientes = Object.entries(reg).filter(([k, v]) => k.split("|")[0] === ped && Date.now() - new Date(v.ts).getTime() < 3 * 86400000);
  if (recientes.length) return `Registrado desde la app el ${selloHora(recientes[0][1].ts)} (albarán ${recientes[0][0].split("|")[1] || "—"})`;
  const disp = (g.lineasDisponiblesBC || []).filter((lb) => Number(lb.cantidadPedida) > 0);
  if (disp.length && disp.every((lb) => Number(lb.cantidadPendiente) <= 0)) return "En BC el pedido ya está recibido entero";
  const emparejadas = (g.lineas || []).filter((l) => l.lineaBC);
  if (emparejadas.length && emparejadas.every((l) => Number(l.lineaBC.cantidadPendiente) <= 0)) return "En BC las líneas de este albarán ya están recibidas";
  return null;
}

// ---------------------------------------------------------------------
// NOTAS INTERNAS de un pedido — historial compartido (autor + fecha)
// ---------------------------------------------------------------------
const CLAVE_AUTOR = "recepcion_autor_v1"; // nombre de quien escribe, por navegador
const leerAutor = () => { try { return localStorage.getItem(CLAVE_AUTOR) || ""; } catch { return ""; } };

function NotasPedido({ pedido, notas, onCambio }) {
  const [texto, setTexto] = useState("");
  const [autor, setAutor] = useState(leerAutor);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  const añadir = async () => {
    const t = texto.trim();
    if (!t) return;
    if (!autor.trim()) { setError("Escribe tu nombre (solo la primera vez)."); return; }
    setGuardando(true); setError(null);
    try { localStorage.setItem(CLAVE_AUTOR, autor.trim()); } catch {}
    try {
      const r = await fetch("/api/recepcion/nota", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido, texto: t, autor: autor.trim() }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      onCambio(pedido, json.notas || []);
      setTexto("");
    } catch (err) { setError(err.message || String(err)); }
    setGuardando(false);
  };

  const borrar = async (id) => {
    try {
      const r = await fetch("/api/recepcion/nota/borrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido, id }),
      });
      const json = await r.json().catch(() => ({}));
      if (r.ok) onCambio(pedido, json.notas || []);
    } catch {}
  };

  return (
    <div className="mt-2 bg-amber-50/60 border border-amber-200 rounded p-2">
      <div className="text-[11px] font-semibold text-amber-800 mb-1 flex items-center gap-1"><StickyNote size={12} /> Notas internas</div>
      {(notas || []).length === 0 && <div className="text-[11px] text-slate-400 mb-1">Sin notas todavía.</div>}
      {(notas || []).map((n) => (
        <div key={n.id} className="group flex items-start gap-2 text-[11px] py-0.5">
          <span className="text-slate-400 whitespace-nowrap">{selloHora(n.ts)}</span>
          <span className="font-semibold text-slate-600 whitespace-nowrap">{n.autor}:</span>
          <span className="text-slate-700 whitespace-pre-wrap flex-1">{n.texto}{n.enlace ? <> <a href={n.enlace} target="_blank" rel="noreferrer" className="text-blue-600 underline whitespace-nowrap">Abrir en Outlook</a></> : null}</span>
          <button onClick={() => borrar(n.id)} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" title="Borrar nota"><Trash2 size={12} /></button>
        </div>
      ))}
      <div className="flex items-center gap-2 mt-1.5">
        {!leerAutor() && (
          <input value={autor} onChange={(e) => setAutor(e.target.value)} placeholder="Tu nombre" className="border border-slate-300 rounded px-2 py-1 text-[11px] w-28 bg-white" />
        )}
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") añadir(); }}
          placeholder="Añadir nota interna… (Enter para guardar)"
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-[11px] bg-white"
        />
        <button onClick={añadir} disabled={guardando || !texto.trim()} className="text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded px-3 py-1">
          {guardando ? "Guardando…" : "Añadir"}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-600 mt-1">✗ {error}</div>}
    </div>
  );
}

export default function Recepcion({ pedidos, lineas, onActualizarBC, actualizando }) {
  const [recep, setRecep] = useState({ revisados: {}, fechas: {}, reclamados: {}, emailsProveedor: {}, notas: {} });
  const [abiertos, setAbiertos] = useState(() => new Set()); // pedidos con el detalle de líneas desplegado
  const [verTodasLineas, setVerTodasLineas] = useState(false); // detalle: también las líneas ya recibidas
  const [reclamo, setReclamo] = useState(null); // { proveedor, provNum, inicial: [nums] } | null
  const [fReclamo, setFReclamo] = useState(""); // "" | "si" | "no"
  const [avisoEnvio, setAvisoEnvio] = useState(null);
  const [buscandoCorreos, setBuscandoCorreos] = useState(false);
  const [verYaRecibidos, setVerYaRecibidos] = useState(false); // lista de «ya recibidos» del documento subido
  const [q, setQ] = useState("");
  const [fProv, setFProv] = useState("");
  const [fOT, setFOT] = useState("");
  const [fPrio, setFPrio] = useState("");
  const [fTipo, setFTipo] = useState(""); // OC / PC
  const [fAlianza, setFAlianza] = useState(""); // si / no
  const [fDesde, setFDesde] = useState("");
  const [fHasta, setFHasta] = useState("");
  const [ocultarRevisados, setOcultarRevisados] = useState(false);

  // "Subir Documento" — PDF con muchas páginas y muchos pedidos/proveedores.
  // Se lee, se agrupa por Nº de pedido y se cruzan las líneas de material
  // con BC en el backend (/api/recepcion/extraer, solo lectura). Aquí se
  // revisa "como un libro" — un pedido a la vez, con el PDF al lado — y al
  // confirmar CADA pedido se sube a BC (/api/recepcion/subir-bc): Nº
  // albarán, PDF adjunto en Archivos de documento entrante, y Cantidad a
  // recibir en las líneas de material que coincidan (sin registrar/postear).
  const inputDocRef = useRef(null);
  const [subiendoDoc, setSubiendoDoc] = useState(false);
  const [errorDoc, setErrorDoc] = useState(null);
  const [panelDoc, setPanelDoc] = useState(null); // { archivo, paginasTotal, gruposId: [...], gruposSinId: [...] } | null
  const [indiceActual, setIndiceActual] = useState(0);
  const [subidaBC, setSubidaBC] = useState({}); // id de grupo → { subiendo, resultado, error }

  const numerosPedidoConocidos = useMemo(() => {
    if (!pedidos?.headers?.length) return new Set();
    const m = recepMapFor(pedidos.headers);
    return new Set((pedidos.rows || []).map((r) => String(r[m.numero] || "").trim().toUpperCase()).filter(Boolean));
  }, [pedidos]);

  // Líneas devueltas por /api/recepcion/extraer → estado de revisión
  const mapearLineas = (lineasEmparejadas, prefijo) =>
    (lineasEmparejadas || []).map((l, j) => ({
      id: `${prefijo}-${j}`,
      descripcionAlbaran: l.descripcionAlbaran,
      cantidadAlbaran: l.cantidadAlbaran,
      precioAlbaran: l.precioAlbaran ?? null,
      descuentoAlbaran: l.descuentoAlbaran ?? null,
      lineaBC: l.lineaBC,
      coincidencia: l.coincidencia,
      cantidadARegistrar: l.cantidadARegistrar,
      incluir: l.coincidencia !== "sin_match",
    }));

  const [cargosProd, setCargosProd] = useState(CARGOS_PROD_RESPALDO);
  useEffect(() => {
    fetch("/api/bc/cargos").then((r) => r.json()).then((d) => { if (d?.cargos?.length) setCargosProd(d.cargos); }).catch(() => {});
  }, []);
  const ultimoArchivoRef = useRef(null); // el PDF completo, para «Volver a cargar documento»
  const [releyendo, setReleyendo] = useState(null); // id del grupo que se está releyendo

  const onSeleccionArchivo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    ultimoArchivoRef.current = file;
    await procesarArchivo(file);
  };

  // «Volver a cargar documento»: vuelve a leer TODO el PDF desde el principio
  const recargarDocumento = async () => {
    const file = ultimoArchivoRef.current;
    if (!file) return;
    if (!window.confirm(`¿Volver a leer «${file.name}» entero? Se perderá lo que hayas corregido en los pedidos aún sin confirmar (los ya subidos a BC no se tocan).`)) return;
    await procesarArchivo(file);
  };

  // «Volver a leer este pedido»: vuelve a leer SOLO sus páginas con la IA
  // y vuelve a cruzar con BC (cantidades pendientes actualizadas). Se
  // conservan las páginas originales, el PDF y las líneas nuevas (cargos).
  const releerPedido = async (idx) => {
    const g = panelDoc?.gruposId?.[idx];
    if (!g?.pdfBase64) return;
    setReleyendo(g.id);
    setErrorDoc(null);
    try {
      const r = await fetch("/api/recepcion/extraer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: `${g.pedido || "pedido"}.pdf`, base64: g.pdfBase64 }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      const gs = json.grupos || [];
      const n = gs.find((x) => x.pedido && x.pedido.toUpperCase() === (g.pedido || "").toUpperCase()) || gs.find((x) => x.pedido) || gs[0];
      if (!n) throw new Error("La IA no ha devuelto nada al releer estas páginas.");
      setPanelDoc((prev) => ({
        ...prev,
        gruposId: prev.gruposId.map((x, i) =>
          i !== idx
            ? x
            : {
                ...x,
                pedido: n.pedido || x.pedido,
                albaran: n.albaran || "",
                vendorName: n.vendorName || x.vendorName,
                bcError: n.bcError || null,
                lineasDisponiblesBC: n.lineasDisponiblesBC || [],
                lineas: mapearLineas(n.lineasEmparejadas, `${x.id}-r${Date.now()}`),
                lineasPdf: n.lineas || x.lineasPdf || [],
              }
        ),
      }));
    } catch (err) {
      setErrorDoc(`Al releer el pedido: ${err.message || String(err)}`);
    }
    setReleyendo(null);
  };

  // «Cargar pedido»: vuelve a cruzar con BC el Nº de pedido escrito A MANO
  // (cuando la IA lo ha leído mal), sin volver a leer el PDF.
  const [cruzando, setCruzando] = useState(null);
  const cargarPedidoManual = async (idx) => {
    const g = panelDoc?.gruposId?.[idx];
    if (!g?.pedido) return;
    setCruzando(g.id);
    setErrorDoc(null);
    try {
      const lineasPdf = (g.lineasPdf && g.lineasPdf.length)
        ? g.lineasPdf
        : (g.lineas || []).map((l) => ({ descripcion: l.descripcionAlbaran, cantidad: l.cantidadAlbaran, precioUnitario: l.precioAlbaran, descuento: l.descuentoAlbaran }));
      const r = await fetch("/api/recepcion/cruzar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: g.pedido, lineasPdf }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      setPanelDoc((prev) => ({
        ...prev,
        gruposId: prev.gruposId.map((x, i) =>
          i !== idx
            ? x
            : {
                ...x,
                pedido: json.pedido || x.pedido,
                vendorName: json.vendorName || null,
                bcError: json.bcError || null,
                lineasDisponiblesBC: json.lineasDisponiblesBC || [],
                lineasPdf,
                lineas: mapearLineas(json.lineasEmparejadas, `${x.id}-m${Date.now()}`),
              }
        ),
      }));
    } catch (err) {
      setErrorDoc(`Al cargar el pedido: ${err.message || String(err)}`);
    }
    setCruzando(null);
  };

  const procesarArchivo = async (file) => {
    setSubiendoDoc(true);
    setErrorDoc(null);
    setPanelDoc(null);
    setSubidaBC({});
    setIndiceActual(0);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch("/api/recepcion/extraer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: file.name, base64 }),
      });
      // Registros hechos desde la app (compartidos) — frescos, por si otro equipo ha registrado
      let registrados = {};
      try { registrados = (await (await fetch("/api/recepcion")).json()).registrados || {}; } catch {}
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      const grupos = (json.grupos || []).map((g, i) => ({
        id: `${i}-${g.pedido || "sin-pedido"}`,
        pedido: g.pedido || "",
        albaran: g.albaran || "",
        paginas: g.paginas || [],
        pdfBase64: g.pdfBase64 || null,
        vendorName: g.vendorName || null,
        bcError: g.bcError || null,
        incluir: !!g.pedido,
        lineasDisponiblesBC: g.lineasDisponiblesBC || [],
        nuevasLineas: [], // cargos a AÑADIR al pedido en BC (p.ej. TRANSPORTE)
        lineas: mapearLineas(g.lineasEmparejadas, i),
        lineasPdf: g.lineas || [], // líneas tal cual leídas del albarán (para volver a cruzar con otro pedido)
      }));
      setPanelDoc({
        archivo: file.name,
        paginasTotal: json.paginas,
        // Los ya recibidos/registrados se apartan (se pueden volver a mostrar)
        gruposId: grupos.filter((g) => g.pedido && !motivoYaRecibido(g, registrados)),
        gruposYaRecibidos: grupos.filter((g) => g.pedido && motivoYaRecibido(g, registrados)).map((g) => ({ ...g, motivo: motivoYaRecibido(g, registrados) })),
        gruposSinId: grupos.filter((g) => !g.pedido),
        avisos: json.avisos || [], // páginas que la IA no pudo leer (el resto sí)
      });
    } catch (err) {
      setErrorDoc(err.message || String(err));
    }
    setSubiendoDoc(false);
  };

  const mostrarIgualmente = (id) => {
    setPanelDoc((prev) => {
      const g = (prev.gruposYaRecibidos || []).find((x) => x.id === id);
      if (!g) return prev;
      return { ...prev, gruposId: [...prev.gruposId, g], gruposYaRecibidos: prev.gruposYaRecibidos.filter((x) => x.id !== id) };
    });
  };

  const editarGrupo = (idx, campo, valor) => {
    setPanelDoc((prev) => ({ ...prev, gruposId: prev.gruposId.map((g, i) => (i === idx ? { ...g, [campo]: valor } : g)) }));
  };

  const editarLinea = (idxGrupo, idxLinea, campo, valor) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) =>
        i !== idxGrupo ? g : { ...g, lineas: g.lineas.map((l, j) => (j === idxLinea ? { ...l, [campo]: valor } : l)) }
      ),
    }));
  };

  // Elegir A MANO la línea del pedido en BC a la que corresponde una
  // línea leída del PDF — para cuando el emparejamiento automático no
  // encuentra nada, o se equivoca. lineaBcId === "" vacía la selección
  // (vuelve a "sin coincidencia").
  const elegirLineaBC = (idxGrupo, idxLinea, lineaBcId) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) => {
        if (i !== idxGrupo) return g;
        const elegida = lineaBcId ? (g.lineasDisponiblesBC || []).find((lb) => lb.id === lineaBcId) : null;
        return {
          ...g,
          lineas: g.lineas.map((l, j) => {
            if (j !== idxLinea) return l;
            const cantidadARegistrar = elegida ? Math.min(Number(l.cantidadAlbaran) || 0, elegida.cantidadPendiente) : 0;
            return { ...l, lineaBC: elegida || null, coincidencia: elegida ? "manual" : "sin_match", incluir: !!elegida, cantidadARegistrar };
          }),
        };
      }),
    }));
  };

  // --- LÍNEAS NUEVAS (cargos que el proveedor cobra y no están en el pedido) ---
  const añadirNuevaLinea = (idxGrupo, desdeLineaPdf = null, tipo = "Charge") => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) => {
        if (i !== idxGrupo) return g;
        const l = desdeLineaPdf != null ? g.lineas[desdeLineaPdf] : null;
        const esItem = tipo === "Item";
        const nueva = {
          id: `n${Date.now()}`,
          tipo,
          codigo: esItem ? "" : sugerirCargo(l?.descripcionAlbaran),
          descripcion: esItem
            ? (l ? l.descripcionAlbaran : "")
            : ((cargosProd.find((c) => c.numero === sugerirCargo(l?.descripcionAlbaran)) || {}).descripcion || sugerirCargo(l?.descripcionAlbaran)),
          busqueda: esItem && l ? l.descripcionAlbaran.split(/\s+/).slice(0, 2).join(" ") : "",
          cantidad: l ? Number(l.cantidadAlbaran) || 1 : 1,
          coste: l && l.precioAlbaran != null ? l.precioAlbaran : "",
          dto: l && l.descuentoAlbaran != null ? l.descuentoAlbaran : "",
          origen: l ? l.descripcionAlbaran : null,
        };
        const lineas = l ? g.lineas.map((x, j) => (j === desdeLineaPdf ? { ...x, incluir: false, pasadaACargo: true } : x)) : g.lineas;
        return { ...g, lineas, nuevasLineas: [...(g.nuevasLineas || []), nueva] };
      }),
    }));
  };
  const editarNuevaLinea = (idxGrupo, id, campo, valor) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) => (i !== idxGrupo ? g : { ...g, nuevasLineas: g.nuevasLineas.map((n) => (n.id === id ? { ...n, [campo]: valor } : n)) })),
    }));
  };
  const quitarNuevaLinea = (idxGrupo, id) => {
    setPanelDoc((prev) => ({
      ...prev,
      gruposId: prev.gruposId.map((g, i) => {
        if (i !== idxGrupo) return g;
        const n = g.nuevasLineas.find((x) => x.id === id);
        const lineas = n?.origen ? g.lineas.map((x) => (x.pasadaACargo && x.descripcionAlbaran === n.origen ? { ...x, pasadaACargo: false } : x)) : g.lineas;
        return { ...g, lineas, nuevasLineas: g.nuevasLineas.filter((x) => x.id !== id) };
      }),
    }));
  };

  // registrar=false → «Subir este pedido en BC»: sube albarán, PDF y cantidades a recibir, pero NO registra
  const confirmarGrupo = async (idx, { registrar = true } = {}) => {
    const g = panelDoc.gruposId[idx];
    if (!g) return;
    const sinArticulo = (g.nuevasLineas || []).filter((n) => !n.creadaId && !String(n.codigo || "").trim());
    if (sinArticulo.length) {
      setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, error: "Hay líneas nuevas sin artículo/Nº elegido — búscalo en BC o quita la línea." } }));
      return;
    }
    setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: true } }));
    try {
      const lineasConfirmadas = g.lineas
        .filter((l) => l.incluir && l.lineaBC && Number(l.cantidadARegistrar) > 0)
        .map((l) => ({ lineaId: l.lineaBC.id, cantidad: l.cantidadARegistrar }));
      const r = await fetch("/api/recepcion/subir-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido: g.pedido,
          registrar,
          albaran: g.albaran || null,
          pdfBase64: g.pdfBase64,
          nombreArchivo: `${g.pedido}.pdf`,
          lineas: lineasConfirmadas,
          // Solo las que aún no se han creado en BC (evita duplicarlas si se vuelve a confirmar)
          nuevasLineas: (g.nuevasLineas || [])
            .filter((n) => !n.creadaId)
            .map((n) => ({ tipo: n.tipo || "Charge", codigo: n.codigo, descripcion: n.descripcion, cantidad: Number(n.cantidad) || 0, coste: n.coste === "" ? null : Number(n.coste), dto: n.dto === "" || n.dto == null ? null : Number(n.dto) })),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      // Marcar como creadas las líneas nuevas que BC ha aceptado
      const pendientes = (g.nuevasLineas || []).filter((n) => !n.creadaId);
      const creadas = {};
      (json.nuevasLineas || []).forEach((res, k) => { if (res.ok && pendientes[k]) creadas[pendientes[k].id] = res.lineaId || "ok"; });
      if (Object.keys(creadas).length) {
        setPanelDoc((prev) => ({
          ...prev,
          gruposId: prev.gruposId.map((x, i) => (i !== idx ? x : { ...x, nuevasLineas: x.nuevasLineas.map((n) => (creadas[n.id] ? { ...n, creadaId: creadas[n.id] } : n)) })),
        }));
      }
      setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, resultado: json } }));
    } catch (err) {
      setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, error: err.message || String(err) } }));
    }
  };

  // Cargar marcas compartidas del backend
  useEffect(() => {
    fetch("/api/recepcion").then((r) => r.json()).then((d) => setRecep({ revisados: d.revisados || {}, fechas: d.fechas || {}, reclamados: d.reclamados || {}, emailsProveedor: d.emailsProveedor || {}, notas: d.notas || {} })).catch(() => {});
  }, []);

  const guardar = useCallback((parche) => {
    setRecep((prev) => {
      const nuevo = { ...prev }; // conserva notas (van por su propio endpoint)
      for (const campo of ["revisados", "fechas", "reclamados", "emailsProveedor"]) {
        nuevo[campo] = { ...(prev[campo] || {}), ...(parche[campo] || {}) };
        for (const k in parche[campo] || {}) if (parche[campo][k] === null) delete nuevo[campo][k];
      }
      return nuevo;
    });
    fetch("/api/recepcion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parche),
    }).catch(() => {});
  }, []);

  const datos = useMemo(() => getRecepData(pedidos, lineas, recep.fechas), [pedidos, lineas, recep.fechas]);

  const proveedores = useMemo(() => {
    if (!datos) return [];
    return [...new Set(datos.pendientes.map((p) => p.prov).filter(Boolean))].sort();
  }, [datos]);
  const ots = useMemo(() => {
    if (!datos) return [];
    return [...new Set(datos.pendientes.map((p) => p.ot).filter(Boolean))].sort();
  }, [datos]);

  const filtradas = useMemo(() => {
    if (!datos) return [];
    const qq = q.trim().toLowerCase();
    const desde = fDesde ? new Date(fDesde) : null;
    const hasta = fHasta ? new Date(fHasta) : null;
    return datos.pendientes.filter((p) => {
      if (p.impPend <= 0) return false; // filtro por defecto: solo con pendiente
      if (qq && ![p.num, p.prov, p.ot, p.depto, p.comprador, ...((recep.notas[p.num] || []).map((n) => n.texto))].some((v) => String(v || "").toLowerCase().includes(qq))) return false;
      if (fProv && p.prov !== fProv) return false;
      if (fOT && p.ot !== fOT) return false;
      if (fPrio && p.prioridad !== fPrio) return false;
      if (fTipo === "PC" && p.tipoDoc !== "Pedido") return false;
      if (fTipo === "OC" && p.tipoDoc !== "Oferta") return false;
      if (fAlianza === "si" && !p.alianza) return false;
      if (fAlianza === "no" && p.alianza) return false;
      if (desde || hasta) {
        const f = parseFecha(p.fecha);
        if (desde && (!f || f < desde)) return false;
        if (hasta && (!f || f > hasta)) return false;
      }
      if (ocultarRevisados && recep.revisados[p.num]) return false;
      if (fReclamo === "si" && !recep.reclamados[p.num]) return false;
      if (fReclamo === "no" && recep.reclamados[p.num]) return false;
      return true;
    });
  }, [datos, q, fProv, fOT, fPrio, fTipo, fAlianza, fDesde, fHasta, ocultarRevisados, recep.revisados, fReclamo, recep.reclamados, recep.notas]);

  // Correos de tu buzón (recibidos y enviados) que mencionan un PC → notas del pedido (25/09/2026)
  // Se lanza con el botón, al abrir la pantalla, cada 10 minutos y ~30 s después de enviar una reclamación.
  // En modo silencioso solo avisa si hay correos nuevos o un error.
  const buscandoRef = useRef(false);
  const [estadoCorreo, setEstadoCorreo] = useState("");
  const buscarCorreos = async ({ silencioso = false } = {}) => {
    if (buscandoRef.current) return;
    const nums = [...new Set([...(datos?.pendientes || []), ...(datos?.excluidos || [])].map((p) => p.num).filter(Boolean))];
    if (!nums.length) { if (!silencioso) setAvisoEnvio("No hay pedidos cargados para buscar en el correo."); return; }
    buscandoRef.current = true;
    setBuscandoCorreos(true);
    try {
      const r = await fetch("/api/recepcion/correos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pedidos: nums, dias: 60 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error || `Error ${r.status}`, j.detalle].filter(Boolean).join(" — "));
      setRecep((prev) => ({ ...prev, notas: j.notas || prev.notas }));
      setEstadoCorreo(`Correo revisado a las ${new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}${j.añadidas ? ` · ${j.añadidas} nuevo(s)` : ""}`);
      if (j.añadidas || !silencioso) setAvisoEnvio(j.añadidas ? `📧 ${j.añadidas} correo(s) añadidos a las notas de ${j.pedidos.length} pedido(s): ${j.pedidos.slice(0, 6).join(", ")}${j.pedidos.length > 6 ? "…" : ""}` : `📧 Revisados ${j.leidos} correos de los últimos 60 días: no hay correos nuevos de estos pedidos.`);
    } catch (e) {
      const msg = String(e.message || e).includes("Failed to fetch") ? "no se pudo conectar con el backend" : e.message || e;
      setEstadoCorreo(`✗ Error revisando el correo`);
      setAvisoEnvio(`✗ Correo: ${msg}`);
    }
    buscandoRef.current = false;
    setBuscandoCorreos(false);
  };
  // Automático: al abrir la pantalla (cuando ya hay pedidos) y luego cada 10 minutos mientras está abierta
  const buscarRef = useRef(buscarCorreos);
  buscarRef.current = buscarCorreos;
  const hayPedidos = !!(datos?.pendientes?.length || datos?.excluidos?.length);
  useEffect(() => {
    if (!hayPedidos) return;
    const t0 = setTimeout(() => buscarRef.current({ silencioso: true }), 1500);
    const t = setInterval(() => buscarRef.current({ silencioso: true }), 10 * 60 * 1000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [hayPedidos]);

  const onCambioNotas = (pedido, lista) =>
    setRecep((prev) => {
      const notas = { ...(prev.notas || {}) };
      if (lista.length) notas[pedido] = lista; else delete notas[pedido];
      return { ...prev, notas };
    });

  const toggleAbierto = (num) => setAbiertos((prev) => { const n = new Set(prev); n.has(num) ? n.delete(num) : n.add(num); return n; });

  // Pedidos pendientes (con importe > 0) de un proveedor — para la reclamación
  const pendientesDe = (prov) => (datos?.pendientes || []).filter((p) => p.prov === prov && p.impPend > 0);

  const onReclamacionEnviada = ({ pedidos: nums, para, recordarEmail }) => {
    const ts = new Date().toISOString();
    const reclamados = {};
    nums.forEach((n) => { reclamados[n] = { ts, veces: ((recep.reclamados[n] && recep.reclamados[n].veces) || 0) + 1, para }; });
    const parche = { reclamados };
    if (recordarEmail && reclamo?.proveedor) parche.emailsProveedor = { [reclamo.proveedor]: recordarEmail };
    guardar(parche);
    setAvisoEnvio(`✓ Reclamación enviada a ${para} (${nums.join(", ")})`);
    setReclamo(null);
    // El correo enviado tarda unos segundos en aparecer en «Enviados»: se busca a los 30 s para añadirlo a las notas
    setTimeout(() => buscarRef.current({ silencioso: true }), 30000);
  };

  const kpis = useMemo(() => {
    if (!datos) return null;
    const conPend = datos.pendientes.filter((p) => p.impPend > 0);
    return {
      nPend: conPend.length,
      impPend: conPend.reduce((a, p) => a + p.impPend, 0),
      nExcl: datos.excluidos.length,
      impExcl: datos.excluidos.reduce((a, p) => a + (p.impPend > 0 ? p.impPend : 0), 0),
      mas60: conPend.filter((p) => p.dias > 60).length,
      d3060: conPend.filter((p) => p.dias >= 30 && p.dias <= 60).length,
      d1529: conPend.filter((p) => p.dias >= 15 && p.dias <= 29).length,
    };
  }, [datos]);

  const limpiar = () => { setQ(""); setFProv(""); setFOT(""); setFPrio(""); setFTipo(""); setFAlianza(""); setFDesde(""); setFHasta(""); setOcultarRevisados(false); setFReclamo(""); };

  const sinDatos = !pedidos?.rows?.length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Recepción de material</h1>
          <p className="text-slate-500 text-sm mt-1">
            Pedidos con material pendiente de recibir. Cruza cabeceras de pedido con sus líneas por Nº de documento.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onActualizarBC}
            disabled={actualizando}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <RefreshCw size={15} className={actualizando ? "animate-spin" : ""} /> Actualizar desde BC
          </button>
          <button
            onClick={() => buscarCorreos()}
            disabled={buscandoCorreos}
            title="Busca en tu correo (recibidos y enviados, últimos 60 días) los mensajes que mencionan un pedido PC y los añade a sus notas"
            className="flex items-center gap-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            {buscandoCorreos ? "Buscando correos…" : "📧 Buscar correos"}
          </button>
          {estadoCorreo && <span className={`text-[11px] ${estadoCorreo.startsWith("✗") ? "text-red-600" : "text-slate-400"}`}>{estadoCorreo}</span>}
          <button
            onClick={() => inputDocRef.current?.click()}
            disabled={subiendoDoc}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <Upload size={15} className={subiendoDoc ? "animate-pulse" : ""} /> {subiendoDoc ? "Leyendo documento…" : "Subir Documento"}
          </button>
          <input ref={inputDocRef} type="file" accept="application/pdf" className="hidden" onChange={onSeleccionArchivo} />
        </div>
      </div>

      {errorDoc && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          Error leyendo el documento: {errorDoc}
        </div>
      )}

      {panelDoc && (
        <div className="mt-4 bg-white border border-purple-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-700">
              «{panelDoc.archivo}» · {panelDoc.paginasTotal} página(s) · {panelDoc.gruposId.length} pedido(s) por revisar
              {(panelDoc.gruposYaRecibidos || []).length > 0 && (
                <> · <button onClick={() => setVerYaRecibidos((v) => !v)} className="text-emerald-700 underline decoration-dotted hover:text-emerald-800" title="Ver qué pedidos son">
                  {panelDoc.gruposYaRecibidos.length} ya recibido(s) (ocultos) {verYaRecibidos ? "▴" : "▾"}
                </button></>
              )}
              {panelDoc.gruposSinId.length > 0 && ` · ${panelDoc.gruposSinId.reduce((a, g) => a + g.paginas.length, 0)} página(s) sin identificar`}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={recargarDocumento}
                disabled={subiendoDoc}
                className="flex items-center gap-1 text-[11px] font-semibold text-purple-700 border border-purple-200 bg-white hover:bg-purple-50 disabled:opacity-50 rounded px-2 py-1"
                title="Vuelve a leer el PDF entero desde el principio"
              >
                <RefreshCw size={12} className={subiendoDoc ? "animate-spin" : ""} /> {subiendoDoc ? "Leyendo…" : "Volver a cargar documento"}
              </button>
              <button onClick={() => { setPanelDoc(null); setSubidaBC({}); }} className="text-slate-400 hover:text-slate-600">
                <X size={16} />
              </button>
            </div>
          </div>
          {verYaRecibidos && (panelDoc.gruposYaRecibidos || []).length > 0 && (
            <div className="mb-3 text-[11px] bg-emerald-50 border border-emerald-200 rounded p-2">
              <div className="font-semibold text-emerald-800 mb-1">Pedidos del documento que ya están recibidos en BC:</div>
              {panelDoc.gruposYaRecibidos.map((g) => (
                <div key={g.id} className="flex flex-wrap items-center gap-3 text-slate-600 py-0.5">
                  <span className="font-mono font-semibold text-slate-800">{g.pedido}</span>
                  <span className="text-slate-400">pág. {g.paginas.join(", ")}{g.albaran ? ` · albarán ${g.albaran}` : ""}</span>
                  <span className="text-emerald-700">{g.motivo}</span>
                  <button onClick={() => mostrarIgualmente(g.id)} className="text-blue-600 hover:underline">Mostrar igualmente</button>
                </div>
              ))}
            </div>
          )}
          {(panelDoc.avisos || []).length > 0 && (
            <div className="mb-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              ⚠ Algunas páginas no se han podido leer (el resto del documento sí). Revísalas a mano o pulsa «Volver a cargar documento»:
              {panelDoc.avisos.map((a, i) => <div key={i} className="pl-3">· {a}</div>)}
            </div>
          )}
          <p className="text-[11px] text-slate-500 mb-3">
            Revisa un pedido a la vez: el PDF a la izquierda, lo detectado a la derecha. Corrige lo que haga falta y confirma pedido por pedido.
            Primer uso: prueba con uno solo y comprueba en BC que el albarán, el adjunto y las cantidades han llegado bien antes de seguir con el resto.
          </p>

          {panelDoc.gruposId.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">
              {(panelDoc.gruposYaRecibidos || []).length > 0
                ? "✓ Todos los pedidos de este documento ya están recibidos en BC. Nada pendiente."
                : "No se ha identificado ningún pedido en el documento."}
            </div>
          ) : (
            <>
              {/* Navegador "libro": un pedido a la vez */}
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => setIndiceActual((i) => Math.max(0, i - 1))}
                  disabled={indiceActual === 0}
                  className="text-sm border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-40"
                >
                  ◀ Anterior
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-slate-600">Pedido {indiceActual + 1} de {panelDoc.gruposId.length}</span>
                  <button
                    onClick={() => releerPedido(indiceActual)}
                    disabled={!!releyendo || !panelDoc.gruposId[indiceActual]?.pdfBase64}
                    className="flex items-center gap-1 text-[11px] font-semibold text-purple-700 border border-purple-200 bg-white hover:bg-purple-50 disabled:opacity-50 rounded px-2 py-1"
                    title="Vuelve a leer solo las páginas de este pedido (albarán, líneas) y a cruzarlas con BC"
                  >
                    <RefreshCw size={12} className={releyendo === panelDoc.gruposId[indiceActual]?.id ? "animate-spin" : ""} />
                    {releyendo === panelDoc.gruposId[indiceActual]?.id ? "Releyendo…" : "Volver a leer este pedido"}
                  </button>
                </div>
                <button
                  onClick={() => setIndiceActual((i) => Math.min(panelDoc.gruposId.length - 1, i + 1))}
                  disabled={indiceActual === panelDoc.gruposId.length - 1}
                  className="text-sm border border-slate-300 rounded-md px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-40"
                >
                  Siguiente ▶
                </button>
              </div>

              {(() => {
                const g = panelDoc.gruposId[indiceActual];
                const estado = subidaBC[g.id];
                const existe = g.pedido && numerosPedidoConocidos.has(g.pedido.toUpperCase());
                return (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Vista previa del PDF de ESTE pedido (solo sus páginas) */}
                    <div>
                      <div className="text-[11px] text-slate-500 mb-1">
                        Páginas {g.paginas.join(", ")} del documento{g.vendorName ? ` · proveedor en BC: ${g.vendorName}` : ""}
                      </div>
                      {g.pdfBase64 ? (
                        <iframe
                          src={`data:application/pdf;base64,${g.pdfBase64}`}
                          title={`pedido-${g.pedido}`}
                          className="w-full border border-slate-200 rounded-md"
                          style={{ height: 440 }}
                        />
                      ) : (
                        <div className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-md p-6 text-center">Sin vista previa</div>
                      )}
                    </div>

                    {/* Datos detectados + cruce de líneas */}
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-xs font-semibold text-slate-500 w-20">Pedido</label>
                        <input
                          value={g.pedido}
                          onChange={(e) => editarGrupo(indiceActual, "pedido", e.target.value.toUpperCase())}
                          onKeyDown={(e) => { if (e.key === "Enter") cargarPedidoManual(indiceActual); }}
                          className="border border-slate-300 rounded px-2 py-1 text-sm font-mono w-40"
                        />
                        <button
                          onClick={() => cargarPedidoManual(indiceActual)}
                          disabled={cruzando === g.id || !g.pedido}
                          className="flex items-center gap-1 text-[11px] font-semibold text-blue-700 border border-blue-300 bg-white hover:bg-blue-50 disabled:opacity-50 rounded px-2 py-1"
                          title="Carga de BC el pedido escrito a mano y vuelve a cruzar las líneas del albarán (acepta PC26-3403, PC-3403 o 3403)"
                        >
                          <RefreshCw size={12} className={cruzando === g.id ? "animate-spin" : ""} />
                          {cruzando === g.id ? "Cargando…" : "Cargar pedido"}
                        </button>
                        {!existe && <span title="No aparece en la lista de pedidos cargada — revisar" className="text-amber-600 text-[11px]">⚠ no está en la lista</span>}
                      </div>
                      <div className="flex items-center gap-2 mb-3">
                        <label className="text-xs font-semibold text-slate-500 w-20">Nº albarán</label>
                        <input
                          value={g.albaran}
                          onChange={(e) => editarGrupo(indiceActual, "albaran", e.target.value)}
                          placeholder="—"
                          className="border border-slate-300 rounded px-2 py-1 text-sm w-40"
                        />
                      </div>

                      {g.bcError && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
                          No se han podido cruzar las líneas de material con BC: {g.bcError}. Puedes subir igualmente el albarán y el adjunto; las cantidades las registrarás a mano.
                        </div>
                      )}

                      {g.lineas.length > 0 && (
                        <div className="mb-3">
                          <div className="text-xs font-semibold text-slate-500 mb-1">Líneas de material leídas en el PDF, cruzadas con las del pedido en BC:</div>
                          <table className="w-full text-[11px] border border-slate-200 rounded overflow-hidden">
                            <thead>
                              <tr className="bg-slate-50 text-slate-600 text-left">
                                <th className="px-1.5 py-1">Inc.</th>
                                <th className="px-1.5 py-1">Leído en el albarán</th>
                                <th className="px-1.5 py-1">Línea del pedido en BC</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad del pedido original en Business Central">Cant. pedido (BC)</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad tal como la ha leído la IA en el PDF — revisa que coincida con el papel">Cant. leída (PDF)</th>
                                <th className="px-1.5 py-1">Cant. a registrar</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.lineas.map((l, li) => {
                                const discrepancia = l.lineaBC && Number(l.cantidadAlbaran) !== Number(l.lineaBC.cantidadPedida);
                                return (
                                <tr key={l.id} className="border-t border-slate-100">
                                  <td className="px-1.5 py-1 text-center">
                                    <input
                                      type="checkbox"
                                      checked={l.incluir}
                                      disabled={!l.lineaBC}
                                      onChange={(e) => editarLinea(indiceActual, li, "incluir", e.target.checked)}
                                    />
                                  </td>
                                  <td className="px-1.5 py-1">{l.descripcionAlbaran}</td>
                                  <td className="px-1.5 py-1">
                                    <select
                                      value={l.lineaBC?.id || ""}
                                      onChange={(e) => elegirLineaBC(indiceActual, li, e.target.value)}
                                      className={`w-full border rounded px-1 py-0.5 bg-white ${
                                        !l.lineaBC ? "border-slate-300 text-slate-400" : l.coincidencia === "manual" ? "border-blue-300 text-blue-700" : l.coincidencia === "alta" ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"
                                      }`}
                                    >
                                      <option value="">— sin coincidencia — elegir a mano —</option>
                                      {(g.lineasDisponiblesBC || []).map((lb) => (
                                        <option key={lb.id} value={lb.id}>
                                          {lb.codigo ? `${lb.codigo} — ` : ""}{lb.descripcion} (pedido {lb.cantidadPedida}, pendiente {lb.cantidadPendiente})
                                        </option>
                                      ))}
                                    </select>
                                    {!l.lineaBC && !l.pasadaACargo && (
                                      <div className="mt-1 flex gap-3">
                                        <button
                                          onClick={() => añadirNuevaLinea(indiceActual, li, "Item")}
                                          className="text-[10px] font-semibold text-blue-700 hover:underline"
                                          title="Material que ha llegado y no está en el pedido: se añadirá al pedido en BC como línea de Artículo"
                                        >
                                          ➕ Añadir como material
                                        </button>
                                        <button
                                          onClick={() => añadirNuevaLinea(indiceActual, li, "Charge")}
                                          className="text-[10px] font-semibold text-amber-700 hover:underline"
                                          title="El proveedor cobra este concepto y no está en el pedido: se añadirá al pedido en BC como Cargo (Prod.)"
                                        >
                                          ➕ Añadir como cargo (transporte…)
                                        </button>
                                      </div>
                                    )}
                                    {l.pasadaACargo && <div className="mt-1 text-[10px] text-amber-700">→ se añade al pedido (abajo)</div>}
                                  </td>
                                  <td className="px-1.5 py-1 text-right whitespace-nowrap">
                                    {l.lineaBC ? (
                                      <>
                                        {l.lineaBC.cantidadPedida}
                                        <span className="text-slate-400"> (pendiente {l.lineaBC.cantidadPendiente})</span>
                                      </>
                                    ) : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className={`px-1.5 py-1 text-right font-semibold ${discrepancia ? "text-red-600" : "text-slate-700"}`} title={discrepancia ? "No coincide con la cantidad del pedido en BC — revisa el papel" : ""}>
                                    {l.cantidadAlbaran}{discrepancia && " ⚠"}
                                  </td>
                                  <td className="px-1.5 py-1">
                                    <input
                                      type="number"
                                      value={l.cantidadARegistrar}
                                      disabled={!l.lineaBC}
                                      onChange={(e) => editarLinea(indiceActual, li, "cantidadARegistrar", Number(e.target.value))}
                                      className="border border-slate-300 rounded w-16 px-1 py-0.5"
                                    />
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* LÍNEAS NUEVAS a añadir al pedido en BC */}
                      <div className="mb-3">
                        {(g.nuevasLineas || []).length > 0 && (
                          <div className="border border-amber-200 bg-amber-50/50 rounded p-2 mb-2">
                            <div className="text-xs font-semibold text-amber-800 mb-1">Líneas nuevas (material o cargos) que se añadirán al pedido en BC antes de registrar</div>
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-slate-500 text-left">
                                  <th className="px-1 py-0.5">Tipo</th>
                                  <th className="px-1 py-0.5">Nº</th>
                                  <th className="px-1 py-0.5">Descripción</th>
                                  <th className="px-1 py-0.5 text-right">Cantidad</th>
                                  <th className="px-1 py-0.5 text-right">Coste unit. (€)</th>
                                  <th className="px-1 py-0.5 text-right">% Dto.</th>
                                  <th className="px-1 py-0.5 text-right">Importe</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.nuevasLineas.map((n) => (
                                  <tr key={n.id} className="border-t border-amber-100">
                                    <td className="px-1 py-0.5 whitespace-nowrap">
                                      <select
                                        value={n.tipo || "Charge"}
                                        disabled={!!n.creadaId}
                                        onChange={(e) => {
                                          const t = e.target.value;
                                          editarNuevaLinea(indiceActual, n.id, "tipo", t);
                                          editarNuevaLinea(indiceActual, n.id, "codigo", t === "Item" ? "" : "TRANSPORTE");
                                        }}
                                        className="border border-slate-300 rounded px-1 py-0.5 bg-white"
                                      >
                                        <option value="Item">Artículo</option>
                                        <option value="Charge">Cargo (Prod.)</option>
                                      </select>
                                    </td>
                                    <td className="px-1 py-0.5 align-top">
                                      {(n.tipo || "Charge") === "Item" ? (
                                        <BuscadorArticulo
                                          valor={n.codigo}
                                          inicial={n.busqueda}
                                          disabled={!!n.creadaId}
                                          onElegir={(a) => {
                                            editarNuevaLinea(indiceActual, n.id, "codigo", a.numero);
                                            editarNuevaLinea(indiceActual, n.id, "descripcion", a.descripcion);
                                          }}
                                        />
                                      ) : (
                                        <select
                                          value={n.codigo}
                                          disabled={!!n.creadaId}
                                          onChange={(e) => {
                                            const c = cargosProd.find((x) => x.numero === e.target.value);
                                            editarNuevaLinea(indiceActual, n.id, "codigo", e.target.value);
                                            if (c) editarNuevaLinea(indiceActual, n.id, "descripcion", c.descripcion);
                                          }}
                                          className="border border-slate-300 rounded px-1 py-0.5 w-44 font-mono bg-white"
                                        >
                                          {!cargosProd.some((c) => c.numero === n.codigo) && <option value={n.codigo}>{n.codigo || "— elegir —"}</option>}
                                          {cargosProd.map((c) => (
                                            <option key={c.numero} value={c.numero}>{c.numero} — {c.descripcion}</option>
                                          ))}
                                        </select>
                                      )}
                                    </td>
                                    <td className="px-1 py-0.5">
                                      <input value={n.descripcion} disabled={!!n.creadaId} onChange={(e) => editarNuevaLinea(indiceActual, n.id, "descripcion", e.target.value)} className="border border-slate-300 rounded px-1 py-0.5 w-full bg-white" />
                                      {n.origen && <div className="text-[10px] text-slate-400">del albarán: {n.origen}</div>}
                                    </td>
                                    <td className="px-1 py-0.5 text-right">
                                      <input type="number" value={n.cantidad} disabled={!!n.creadaId} onChange={(e) => editarNuevaLinea(indiceActual, n.id, "cantidad", e.target.value)} className="border border-slate-300 rounded px-1 py-0.5 w-16 text-right bg-white" />
                                    </td>
                                    <td className="px-1 py-0.5 text-right">
                                      <input type="number" step="0.01" value={n.coste} disabled={!!n.creadaId} onChange={(e) => editarNuevaLinea(indiceActual, n.id, "coste", e.target.value)} placeholder="0,00" className="border border-slate-300 rounded px-1 py-0.5 w-20 text-right bg-white" />
                                    </td>
                                    <td className="px-1 py-0.5 text-right">
                                      <input type="number" step="0.01" value={n.dto ?? ""} disabled={!!n.creadaId} onChange={(e) => editarNuevaLinea(indiceActual, n.id, "dto", e.target.value)} placeholder="0" className="border border-slate-300 rounded px-1 py-0.5 w-14 text-right bg-white" />
                                    </td>
                                    <td className="px-1 py-0.5 text-right whitespace-nowrap text-slate-600">
                                      {n.coste !== "" && n.coste != null
                                        ? fmtEur((Number(n.cantidad) || 0) * Number(n.coste) * (1 - (Number(n.dto) || 0) / 100))
                                        : "—"}
                                    </td>
                                    <td className="px-1 py-0.5 text-center whitespace-nowrap">
                                      {n.creadaId ? (
                                        <span className="text-emerald-700 text-[10px]">✓ creada en BC</span>
                                      ) : (
                                        <button onClick={() => quitarNuevaLinea(indiceActual, n.id)} className="text-slate-400 hover:text-red-600" title="Quitar"><X size={13} /></button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="text-[10px] text-slate-500 mt-1">
                              Se crea con la misma OT, departamento, línea de negocio y almacén que las líneas de artículo del pedido, y se marca para recibir.
                            </div>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => añadirNuevaLinea(indiceActual, null, "Item")} className="text-[11px] font-semibold text-blue-700 border border-blue-300 bg-white hover:bg-blue-50 rounded px-2 py-1">
                            ➕ Añadir línea de material
                          </button>
                          <button onClick={() => añadirNuevaLinea(indiceActual, null, "Charge")} className="text-[11px] font-semibold text-amber-700 border border-amber-300 bg-white hover:bg-amber-50 rounded px-2 py-1">
                            ➕ Añadir cargo (transporte / desplazamiento)
                          </button>
                        </div>
                      </div>

                      <button
                        onClick={() => confirmarGrupo(indiceActual)}
                        disabled={estado?.subiendo}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-4 py-2"
                      >
                        {estado?.subiendo ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                        Confirmar y subir este pedido a BC
                      </button>
                      <button
                        onClick={() => confirmarGrupo(indiceActual, { registrar: false })}
                        disabled={estado?.subiendo}
                        title="Sube el Nº de albarán, el PDF y las cantidades a recibir, pero NO registra: lo registras tú después desde BC"
                        className="ml-2 inline-flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-4 py-2"
                      >
                        {estado?.subiendo ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
                        Subir este pedido en BC
                      </button>

                      {estado?.resultado && (
                        <div className="mt-2 text-[11px] space-y-0.5">
                          <div className="text-slate-400">[{estado.resultado.version || "sin versión — server.cjs antiguo"}]</div>
                          <div className={estado.resultado.albaran.ok ? "text-emerald-700" : "text-amber-700"}>
                            {estado.resultado.albaran.ok ? "✓ Nº albarán actualizado" : `✗ Nº albarán: ${estado.resultado.albaran.error || "error"}`}
                          </div>
                          <div className={estado.resultado.adjunto.ok ? "text-emerald-700" : "text-amber-700"}>
                            {estado.resultado.adjunto.ok ? "✓ PDF adjuntado en Archivos de documento entrante" : `✗ Adjunto: ${estado.resultado.adjunto.error || "error"}`}
                          </div>
                          {(estado.resultado.nuevasLineas || []).map((n, ni) => (
                            <div key={`n${ni}`} className={n.ok ? "text-emerald-700" : "text-red-600"}>
                              {n.ok ? `✓ Línea nueva ${n.codigo} creada y marcada para recibir` : `✗ Línea nueva ${n.codigo}: ${n.error || "error"}`}
                              {n.ok && n.copiado && Object.keys(n.copiado).length > 0 && <span className="text-slate-500"> · copiado: {Object.entries(n.copiado).map(([k, v]) => `${k}=${v}`).join(", ")}</span>}
                              {(n.avisos || []).map((a, ai) => <div key={ai} className="text-amber-700 pl-3">⚠ {a}</div>)}
                            </div>
                          ))}
                          {(estado.resultado.lineas || []).map((l, li) => (
                            <div key={li} className={l.ok ? "text-emerald-700" : "text-amber-700"}>
                              {l.ok ? `✓ Cantidad a recibir rellenada (línea ${l.lineaId.slice(0, 8)}…)` : `✗ Línea ${l.lineaId.slice(0, 8)}…: ${l.error || "error"}`}
                            </div>
                          ))}
                          {estado.resultado.registro && (
                            <div className={estado.resultado.registro.ok ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>
                              {estado.resultado.registro.noRegistrar
                                ? "ℹ Subido sin registrar: regístralo desde BC cuando quieras (las demás líneas quedan con cantidad a recibir 0)."
                                : estado.resultado.registro.ok
                                ? "✓ Pedido REGISTRADO en BC (Recibir)"
                                : `✗ No se registró: ${estado.resultado.registro.error || "error"}`}
                            </div>
                          )}
                        </div>
                      )}
                      {estado?.error && <div className="mt-2 text-[11px] text-red-600">✗ {estado.error}</div>}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {(panelDoc.gruposYaRecibidos || []).length > 0 && (
            <details className="mt-5 pt-4 border-t border-slate-200">
              <summary className="text-xs font-semibold text-emerald-700 cursor-pointer">
                ✓ {panelDoc.gruposYaRecibidos.length} pedido(s) ya recibido(s) en BC — ocultos (pulsa para verlos)
              </summary>
              <div className="mt-2 space-y-1">
                {panelDoc.gruposYaRecibidos.map((g) => (
                  <div key={g.id} className="flex items-center gap-3 text-[11px] text-slate-600">
                    <span className="font-mono font-semibold">{g.pedido}</span>
                    <span className="text-slate-400">pág. {g.paginas.join(", ")}{g.albaran ? ` · albarán ${g.albaran}` : ""}</span>
                    <span className="text-emerald-700">{g.motivo}</span>
                    <button onClick={() => mostrarIgualmente(g.id)} className="text-blue-600 hover:underline">Mostrar igualmente</button>
                  </div>
                ))}
              </div>
            </details>
          )}

          {panelDoc.gruposSinId.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-200">
              <div className="text-xs font-semibold text-slate-500 mb-2">
                Páginas sin pedido identificable — revisar a mano al final:
              </div>
              {panelDoc.gruposSinId.map((g, i) => (
                <div key={i} className="text-[11px] text-slate-500 mb-1">
                  Páginas {g.paginas.join(", ")}{g.albaran ? ` · posible Nº albarán leído: ${g.albaran}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sinDatos ? (
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          No hay pedidos cargados. Pulsa «Actualizar desde BC» o carga las tarjetas «Pedidos de Compra» y «Líneas de Compra» en «Cargar datos».
        </div>
      ) : (
        <>
          {!datos?.tieneLineas && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3 text-[13px] text-amber-800">
              ⚠ Faltan las líneas de compra: los importes pendientes se calculan desde ellas. Carga «Líneas de Compra».
            </div>
          )}

          {/* KPIs */}
          {kpis && (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mt-5">
              {[
                { l: "Pendientes", v: kpis.nPend, c: "text-blue-700" },
                { l: "Importe pendiente", v: fmtEur(kpis.impPend), c: "text-blue-700" },
                { l: "Excluidos (Esperar)", v: kpis.nExcl, c: "text-slate-500" },
                { l: "Importe excluido", v: fmtEur(kpis.impExcl), c: "text-slate-500" },
                { l: "Más de 60 días", v: kpis.mas60, c: "text-red-600" },
                { l: "30–60 días", v: kpis.d3060, c: "text-orange-600" },
                { l: "15–29 días", v: kpis.d1529, c: "text-amber-600" },
              ].map((k) => (
                <div key={k.l} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
                  <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{k.l}</div>
                  <div className={`text-sm font-bold ${k.c}`}>{k.v}</div>
                </div>
              ))}
            </div>
          )}

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2 mt-4 text-[13px]">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" className="pl-7 pr-2 py-1.5 border border-slate-300 rounded-md w-40" />
            </div>
            <select value={fProv} onChange={(e) => setFProv(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md max-w-[180px]">
              <option value="">Proveedores</option>
              {proveedores.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fOT} onChange={(e) => setFOT(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">OT</option>
              {ots.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={fPrio} onChange={(e) => setFPrio(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Prioridad</option>
              {["Urgente", "Reclamar", "Revisar", "Normal"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={fTipo} onChange={(e) => setFTipo(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Oferta/Pedido</option>
              <option value="PC">Pedido (PC)</option>
              <option value="OC">Oferta (OC)</option>
            </select>
            <select value={fAlianza} onChange={(e) => setFAlianza(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Alianza</option>
              <option value="si">Con alianza</option>
              <option value="no">Sin alianza</option>
            </select>
            <input type="date" value={fDesde} onChange={(e) => setFDesde(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Desde" />
            <input type="date" value={fHasta} onChange={(e) => setFHasta(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md" title="Hasta" />
            <select value={fReclamo} onChange={(e) => setFReclamo(e.target.value)} className="py-1.5 px-2 border border-slate-300 rounded-md">
              <option value="">Reclamación</option>
              <option value="si">Reclamados</option>
              <option value="no">Sin reclamar</option>
            </select>
            {fProv && pendientesDe(fProv).length > 0 && (
              <button
                onClick={() => setReclamo({ proveedor: fProv, provNum: pendientesDe(fProv)[0].provNum, inicial: pendientesDe(fProv).map((p) => p.num) })}
                className="flex items-center gap-1 text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded-md px-2 py-1.5"
              >
                <Mail size={13} /> Reclamar todo a este proveedor ({pendientesDe(fProv).length})
              </button>
            )}
            <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
              <input type="checkbox" checked={verTodasLineas} onChange={(e) => setVerTodasLineas(e.target.checked)} /> Detalle: ver también líneas recibidas
            </label>
            <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
              <input type="checkbox" checked={ocultarRevisados} onChange={(e) => setOcultarRevisados(e.target.checked)} /> Ocultar revisados
            </label>
            <button onClick={limpiar} className="text-slate-500 hover:text-slate-700 hover:underline">Limpiar</button>
            <span className="text-slate-400 ml-auto">{filtradas.length} de {datos?.pendientes.filter((p) => p.impPend > 0).length || 0}</span>
          </div>

          {/* Tabla */}
          <div className="mt-3 overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-left">
                  {["✓", "Pedido", "Tipo", "Fecha", "Recepción prevista", "Días", "Proveedor", "Comprador", "Un. negocio", "OT", "Alianza", "Importe", "Imp. pendiente", "Prioridad", "Alertas", "Revisado", "Notas", "Reclamado", ""].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtradas.map((p) => {
                  const rev = recep.revisados[p.num];
                  const rc = recep.reclamados[p.num];
                  const notasP = recep.notas[p.num] || [];
                  const ultNota = notasP[notasP.length - 1];
                  const abierto = abiertos.has(p.num);
                  const lineasVer = p.lineas.filter((l) => verTodasLineas || l.pend > 0);
                  return (
                    <React.Fragment key={`${p.num}|${p.tipoDoc}`}>
                    <tr className={`border-t border-slate-100 hover:bg-slate-50/60 ${abierto ? "bg-blue-50/40" : ""}`}>
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={!!rev}
                          onChange={(e) => guardar({ revisados: { [p.num]: e.target.checked ? { ts: new Date().toISOString() } : null } })}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap">
                        <button onClick={() => toggleAbierto(p.num)} className="flex items-center gap-0.5 hover:text-blue-700" title="Ver líneas del pedido">
                          {abierto ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{p.num}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.tipoDoc}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.fecha}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <input
                          type="date"
                          value={p.recepPrev && parseFecha(p.recepPrev) ? parseFecha(p.recepPrev).toISOString().slice(0, 10) : ""}
                          onChange={(e) => guardar({ fechas: { [p.num]: e.target.value || null } })}
                          className="border border-slate-200 rounded px-1 py-0.5 text-[11px]"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{p.dias ?? "—"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap max-w-[160px] truncate" title={p.prov}>{p.prov}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.comprador}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{p.depto}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap font-mono">{p.ot || "—"}</td>
                      <td className="px-2 py-1.5 text-center">{p.alianza ? "✓" : ""}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtEur(p.imp)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold">{fmtEur(p.impPend)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-[10px] font-bold border rounded px-1.5 py-0.5 ${COLOR_PRIORIDAD[p.prioridad]}`}>{p.prioridad}</span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[10px]">{(p.alertas || []).join(" ")}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[10px] text-emerald-700">
                        {rev ? `✓ Revisat OK · ${selloHora(rev.ts)}` : ""}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <button
                          onClick={() => toggleAbierto(p.num)}
                          className={`flex items-center gap-0.5 text-[10px] ${notasP.length ? "text-amber-700 font-semibold" : "text-slate-300 hover:text-amber-600"}`}
                          title={ultNota ? `${ultNota.autor} · ${selloHora(ultNota.ts)}
${ultNota.texto}` : "Añadir nota interna"}
                        >
                          <StickyNote size={14} />{notasP.length || ""}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[10px] text-blue-700" title={rc ? `Enviado a ${rc.para || ""}` : ""}>
                        {rc ? `✉ ${rc.veces || 1}× · ${selloHora(rc.ts)}` : ""}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <button
                          onClick={() => setReclamo({ proveedor: p.prov, provNum: p.provNum, inicial: [p.num] })}
                          className="text-slate-400 hover:text-blue-600"
                          title="Reclamar al proveedor"
                        >
                          <Mail size={15} />
                        </button>
                      </td>
                    </tr>
                    {abierto && (
                      <tr className="bg-blue-50/40">
                        <td colSpan={19} className="px-8 pb-3 pt-1">
                          {lineasVer.length === 0 ? (
                            <div className="text-[11px] text-slate-400 py-2">
                              {p.lineas.length === 0 ? "No hay líneas cargadas para este pedido (carga «Líneas de Compra»)." : "Todas las líneas están recibidas."}
                            </div>
                          ) : (
                            <table className="w-full text-[11px] bg-white border border-slate-200 rounded">
                              <thead>
                                <tr className="bg-slate-50 text-slate-500 text-left">
                                  <th className="px-2 py-1">Nº</th>
                                  <th className="px-2 py-1">Descripción</th>
                                  <th className="px-2 py-1 text-right">Pedida</th>
                                  <th className="px-2 py-1 text-right">Recibida</th>
                                  <th className="px-2 py-1 text-right">Pendiente</th>
                                  <th className="px-2 py-1">Ud.</th>
                                  <th className="px-2 py-1 text-right">Precio neto</th>
                                  <th className="px-2 py-1 text-right">Imp. pendiente</th>
                                  <th className="px-2 py-1">Recep. esperada</th>
                                </tr>
                              </thead>
                              <tbody>
                                {lineasVer.map((l, i) => (
                                  <tr key={i} className={`border-t border-slate-100 ${l.pend > 0 ? "" : "text-slate-400"}`}>
                                    <td className="px-2 py-1 font-mono whitespace-nowrap">{l.art}</td>
                                    <td className="px-2 py-1">{l.desc}</td>
                                    <td className="px-2 py-1 text-right">{fmtCant(l.cant)}</td>
                                    <td className="px-2 py-1 text-right">{fmtCant(l.recib)}</td>
                                    <td className={`px-2 py-1 text-right font-semibold ${l.pend > 0 ? "text-orange-700" : ""}`}>{fmtCant(l.pend)}</td>
                                    <td className="px-2 py-1">{l.ud}</td>
                                    <td className="px-2 py-1 text-right whitespace-nowrap">{fmtEur(l.neto)}</td>
                                    <td className="px-2 py-1 text-right whitespace-nowrap">{l.impPend ? fmtEur(l.impPend) : ""}</td>
                                    <td className="px-2 py-1 whitespace-nowrap">{fmtFecha(l.fechaEsp)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <NotasPedido pedido={p.num} notas={notasP} onCambio={onCambioNotas} />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
                {filtradas.length === 0 && (
                  <tr><td colSpan={19} className="px-3 py-6 text-center text-slate-400">Sin pedidos pendientes con los filtros actuales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {avisoEnvio && (
        <div className="fixed bottom-4 right-4 z-40 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg shadow px-4 py-2 flex items-center gap-3">
          {avisoEnvio}
          <button onClick={() => setAvisoEnvio(null)} className="text-emerald-500 hover:text-emerald-700"><X size={14} /></button>
        </div>
      )}

      {reclamo && (
        <ModalReclamacion
          proveedor={reclamo.proveedor}
          provNum={reclamo.provNum}
          pedidosProv={pendientesDe(reclamo.proveedor)}
          inicial={reclamo.inicial}
          emailGuardado={recep.emailsProveedor[reclamo.proveedor] || ""}
          reclamados={recep.reclamados}
          onClose={() => setReclamo(null)}
          onEnviado={onReclamacionEnviada}
        />
      )}
    </div>
  );
}
