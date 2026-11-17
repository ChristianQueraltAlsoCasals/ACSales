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
import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Search, CheckCircle2, Mail, X, Upload, ChevronRight, ChevronDown, Send, StickyNote, Trash2, Paperclip, Plus, User } from "lucide-react";
import { emailsPorCodigoDepartamento, copiasAdministracion, codigoDepartamentoDesdeUnidad, listasCorreoDepartamento, aplicarRemitente } from "./departamentos.js";
import { empresaGuardada } from "./empresa.jsx";

// Un mismo PDF pedido desde Validación de facturas: si React remonta
// la pantalla a mitad de la lectura, la segunda montura espera esta promesa.
const extraccionDesdeFactura = { id: null, promesa: null, pdf: null };

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
const fechaCorta = (s) => {
  const d = parseFecha(s);
  if (!d || d.getFullYear() < 1900) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
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
    tipo: H(/^document_type$/) || H(/tipo de documento/),
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

  // Índice de líneas por nº de pedido.
  // El refresco horario puede haber guardado la MISMA línea (mismo tipo +
  // documento + nº de línea) muchas veces. Se deja la última copia. Dos
  // líneas distintas del mismo artículo (nº de línea distinto) se mantienen.
  const idxLineas = {};
  if (lineas?.headers?.length) {
    const lc = colsLineas(lineas.headers);
    if (lc.doc) {
      const filasLinea = [];
      const porClave = new Map();
      lineas.rows.forEach((r) => {
        const pc = String(r[lc.doc] || "").trim().toUpperCase();
        if (!pc) return;
        const lineNo = lc.lineNo ? Number(r[lc.lineNo]) || 0 : 0;
        if (lineNo > 0) {
          const tipo = lc.tipo ? String(r[lc.tipo] || "").trim() : "";
          const clave = `${pc}|${tipo}|${lineNo}`;
          const ya = porClave.get(clave);
          if (ya != null) { filasLinea[ya] = r; return; }
          porClave.set(clave, filasLinea.length);
        }
        filasLinea.push(r);
      });
      filasLinea.forEach((r) => {
        const pc = String(r[lc.doc] || "").trim().toUpperCase();
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
const RANK_PRIORIDAD = { Urgente: 4, Reclamar: 3, Revisar: 2, Normal: 1 };

function valorOrdenRecepcion(p, col, recep) {
  switch (col) {
    case "Pedido": return p.num || "";
    case "Tipo": return p.tipoDoc || "";
    case "Fecha": return parseFecha(p.fecha)?.getTime() ?? null;
    case "Recepción prevista": return parseFecha(p.recepPrev)?.getTime() ?? null;
    case "Días": return p.dias == null || Number.isNaN(Number(p.dias)) ? null : Number(p.dias);
    case "Proveedor": return p.prov || "";
    case "Comprador": return p.comprador || "";
    case "Un. negocio": return p.depto || "";
    case "OT": return p.ot || "";
    case "Alianza": return p.alianza ? "Sí" : "";
    case "Importe": return Number(p.imp) || 0;
    case "Imp. pendiente": return Number(p.impPend) || 0;
    case "Prioridad": return RANK_PRIORIDAD[p.prioridad] || 0;
    case "Alertas": return (p.alertas || []).join(" ");
    case "Revisado": return recep.revisados?.[p.num]?.ts ? new Date(recep.revisados[p.num].ts).getTime() : null;
    case "Notas": return (recep.notas?.[p.num] || []).length;
    case "Reclamado": return recep.reclamados?.[p.num]?.ts ? new Date(recep.reclamados[p.num].ts).getTime() : null;
    default: return "";
  }
}

function compararOrden(a, b, dir) {
  const vacio = (v) => v == null || v === "";
  if (vacio(a) && vacio(b)) return 0;
  if (vacio(a)) return 1;
  if (vacio(b)) return -1;
  const r = typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
  return dir === "desc" ? -r : r;
}

// ---------------------------------------------------------------------
// RECLAMACIÓN AL PROVEEDOR — borrador de correo con las líneas pendientes
// ---------------------------------------------------------------------
// Recibe TODOS los pedidos pendientes del proveedor y marca de inicio el
// pedido desde el que se ha pulsado ✉ (o todos, si se pulsa «Reclamar
// todo a este proveedor»). Para = email de la ficha del proveedor en BC
// (o el recordado), CC = responsables del departamento de cada OT.
// Se envía vía Graph desde el buzón personal (/api/correo/enviar).
const NOMBRE_DEPTO = {
  INS: "Instalaciones",
  MAN: "Mantenimiento",
  AUT: "Automatización",
  CON: "Construcción",
  AMT: "Amianto",
};

const DEPTOS_RESPONSABLE = [
  { codigo: "INS", nombre: "Instalaciones" },
  { codigo: "MAN", nombre: "Mantenimiento" },
  { codigo: "CON", nombre: "Construcción" },
  { codigo: "AMT", nombre: "Amianto" },
  { codigo: "AUT", nombre: "Automatización" },
];

function etiquetaDepartamento(codigo) {
  const raw = String(codigo || "").trim();
  if (!raw) return "";
  const seg = raw.split("-")[0].trim().toUpperCase();
  const nombre = NOMBRE_DEPTO[seg];
  if (!nombre) return raw;
  return raw.toUpperCase() === seg ? `${nombre} (${seg})` : `${nombre} (${raw})`;
}

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
    const depto = etiquetaDepartamento(p.depto);
    return `<p style="margin:14px 0 4px;font-size:13px"><b>Pedido ${escHtml(p.num)}</b>${p.fecha ? ` · fecha pedido ${escHtml(fmtFecha(p.fecha) || p.fecha)}` : ""}${p.ot ? ` · Ref. obra ${escHtml(p.ot)}` : ""}${depto ? ` · Departamento ${escHtml(depto)}` : ""}</p>
<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif"><thead><tr><th ${th}>Código</th><th ${th}>Descripción</th><th ${th}>Cant. pedida</th><th ${th}>Pendiente</th><th ${th}>Ud.</th><th ${th}>Fecha prevista</th></tr></thead><tbody>${filas}</tbody></table>`;
  }).join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1e293b"><p>${parrafos(intro)}</p>${bloques}<p style="margin-top:16px">${parrafos(cierre)}</p></div>`;
}

const TEXTO_PROVEEDOR =
  "Buenos días,\n\nOs escribimos para preguntar si el material pendiente de entrega de los pedidos que detallamos a continuación ya se ha enviado. Si todavía no, os agradeceríamos que nos confirmarais la fecha prevista de entrega o, si hay alguna incidencia, que nos la indicarais lo antes posible.\n\nEn caso de que el material ya se haya entregado, os rogamos que nos enviéis el albarán de entrega firmado.";

function razonEmpresaFirma() {
  const e = empresaGuardada();
  const n = `${e?.nombre || ""} ${e?.displayName || ""}`.toLowerCase();
  if (n.includes("ferros")) return "Ferros Coll de l'Alba, S.L.";
  if (n.includes("quimlab")) return e?.displayName || e?.nombre || "QUIMLAB";
  return "ALSO CASALS INSTAL·LACIONS, S.L.";
}

function textoCierre(nombre) {
  const quien = String(nombre || "").trim();
  return "Gracias de antemano.\n\nUn saludo," + (quien ? "\n" + quien : "") + "\n" + razonEmpresaFirma();
}

const TEXTO_INTERNO =
  "Buenos días,\n\nOs escribimos para confirmar si el material correspondiente al pedido que detallamos ha sido recibido en nuestras instalaciones.\n\nEsto es, porque figura como pendiente y no hemos recibido el albarán del proveedor y, por tanto, tampoco se ha facturado.\n\nSi todavía no ha sido recibido, agradeceríamos que nos confirmaseis la fecha prevista de recepción o nos informarais de cualquier incidencia.\n\nAsimismo, os rogamos que nos indiquéis si el pedido ha sido cancelado o si el material ya no es necesario.";

const EXTENSIONES_ADJUNTO = new Set(["pdf", "png", "jpg", "jpeg", "doc", "docx", "xls", "xlsx"]);
const TOPE_FICHERO = 3 * 1024 * 1024;
const TOPE_TOTAL = 10 * 1024 * 1024;

function extensionFichero(nombre) {
  const s = String(nombre || "");
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1).toLowerCase() : "";
}

function leerFicheroAdjunto(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      const raw = String(lector.result || "");
      const coma = raw.indexOf(",");
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nombre: file.name,
        mime: file.type || "",
        base64: coma >= 0 ? raw.slice(coma + 1) : "",
        bytes: file.size,
      });
    };
    lector.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
    lector.readAsDataURL(file);
  });
}

function ModalReclamacion({ proveedor, provNum, pedidosProv, inicial, emailGuardado, reclamados, onClose, onEnviado }) {
  const [sel, setSel] = useState(() => new Set(inicial));
  const [para, setPara] = useState(emailGuardado || "");
  const [emailBC, setEmailBC] = useState(null); // null = consultando, "" = la ficha no tiene
  const emailProveedorRef = useRef(emailGuardado || "");
  const tipoRef = useRef("proveedor");
  const [tipoMensaje, setTipoMensaje] = useState("proveedor");
  const [remitente, setRemitente] = useState("");
  const cierreTocado = useRef(false);
  const [cierre, setCierre] = useState(() => textoCierre(""));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [adjuntos, setAdjuntos] = useState([]);
  const inputAdjuntoRef = useRef(null);
  const elegidos = pedidosProv.filter((p) => sel.has(p.num));

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => {
        if (d.email) setRemitente(d.email);
        if (!cierreTocado.current) setCierre(textoCierre(d.nombre));
      })
      .catch(() => {});
  }, []);

  // CC = responsables del departamento + Administración, sin quien envía.
  // Al marcar/desmarcar pedidos se recalcula, conservando lo escrito a mano.
  const ccAutoDe = (nums, emailRemitente) => {
    const set = new Set();
    pedidosProv.filter((p) => nums.has(p.num)).forEach((p) => (emailsPorCodigoDepartamento(p.depto) || []).forEach((e) => set.add(e)));
    copiasAdministracion(emailRemitente).forEach((e) => set.add(e));
    return [...set];
  };
  const autoPrevRef = useRef(ccAutoDe(new Set(inicial), ""));
  const [cc, setCc] = useState(() => autoPrevRef.current.join("; "));
  const sinCorreoProveedor = (lista) => {
    const prov = (emailProveedorRef.current || "").trim().toLowerCase();
    return lista.filter((e) => e.toLowerCase() !== prov);
  };
  useEffect(() => {
    const internos = sinCorreoProveedor(ccAutoDe(sel, remitente));
    if (tipoMensaje === "interno") {
      setPara(internos.join("; "));
      setCc("");
      autoPrevRef.current = [];
      return;
    }
    const nuevoAuto = internos;
    setCc((actual) => {
      const previos = new Set(autoPrevRef.current.map((e) => e.toLowerCase()));
      const aMano = partirEmails(actual).filter((e) => !previos.has(e.toLowerCase()));
      const vistos = new Set();
      return [...nuevoAuto, ...aMano].filter((e) => { const k = e.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; }).join("; ");
    });
    autoPrevRef.current = nuevoAuto;
  }, [sel, remitente, tipoMensaje]); // eslint-disable-line react-hooks/exhaustive-deps
  const asuntoAuto = elegidos.length === 1
    ? `Reclamación pedido ${elegidos[0].num} – ALSO CASALS`
    : `Reclamación de material pendiente (${elegidos.length} pedidos) – ALSO CASALS`;
  const [asunto, setAsunto] = useState(null); // null = automático
  const [intro, setIntro] = useState(TEXTO_PROVEEDOR);
  const elegirTipo = (tipo) => {
    tipoRef.current = tipo;
    setTipoMensaje(tipo);
    setIntro(tipo === "interno" ? TEXTO_INTERNO : TEXTO_PROVEEDOR);
    if (tipo === "proveedor") setPara(emailProveedorRef.current || "");
  };

  // Email desde la ficha del proveedor en BC
  useEffect(() => {
    const qs = new URLSearchParams({ numero: provNum || "", nombre: proveedor || "" });
    fetch(`/api/bc/proveedor-email?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        const e = (d && d.email) || "";
        setEmailBC(e);
        emailProveedorRef.current = e || emailGuardado || "";
        if (tipoRef.current === "proveedor") setPara(emailProveedorRef.current);
      })
      .catch(() => setEmailBC(""));
  }, [proveedor, provNum]);

  const html = useMemo(() => htmlReclamacion(elegidos, intro, cierre), [elegidos, intro, cierre]);

  const anadirAdjuntos = async (lista) => {
    const files = Array.from(lista || []);
    if (!files.length) return;
    const rechazados = [];
    const aceptados = [];
    let suma = adjuntos.reduce((n, a) => n + (a.bytes || 0), 0);
    const avisoTope = "Los adjuntos juntos no pueden pasar de 10 MB.";
    for (const f of files) {
      if (!EXTENSIONES_ADJUNTO.has(extensionFichero(f.name))) {
        rechazados.push(`«${f.name}» no es PDF, foto, Excel ni Word.`);
        continue;
      }
      if (!f.size) {
        rechazados.push(`«${f.name}» está vacío.`);
        continue;
      }
      if (f.size > TOPE_FICHERO) {
        rechazados.push(`«${f.name}» pesa más de 3 MB.`);
        continue;
      }
      if (suma + f.size > TOPE_TOTAL) {
        if (!rechazados.includes(avisoTope)) rechazados.push(avisoTope);
        continue;
      }
      suma += f.size;
      aceptados.push(f);
    }
    try {
      const leidos = [];
      for (const f of aceptados) leidos.push(await leerFicheroAdjunto(f));
      if (leidos.length) setAdjuntos((prev) => [...prev, ...leidos]);
      setError(rechazados.length ? rechazados.join(" ") : null);
    } catch (err) {
      setError(err.message || String(err));
    }
    if (inputAdjuntoRef.current) inputAdjuntoRef.current.value = "";
  };

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
        body: JSON.stringify({
          para: dest,
          cc: ccEnvio,
          asunto: asunto ?? asuntoAuto,
          cuerpoHtml: html,
          adjuntos: adjuntos.map(({ nombre, base64, mime }) => ({ nombre, base64, mime })),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      onEnviado({ pedidos: elegidos.map((p) => p.num), para: sinProveedor ? `${dest.join("; ")} (sin email del proveedor)` : dest.join("; "), recordarEmail: tipoMensaje === "proveedor" && !sinProveedor && dest.join("; ") !== (emailBC || "") ? dest.join("; ") : null });
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

        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-semibold text-slate-500">Mensaje</span>
          <button
            type="button"
            onClick={() => elegirTipo("proveedor")}
            className={`text-sm rounded-md px-3 py-1.5 border ${tipoMensaje === "proveedor" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
          >
            Proveedor
          </button>
          <button
            type="button"
            onClick={() => elegirTipo("interno")}
            className={`text-sm rounded-md px-3 py-1.5 border ${tipoMensaje === "interno" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
          >
            Interno
          </button>
        </div>

        <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-2 items-center text-[13px] mb-3">
          <label className="text-xs font-semibold text-slate-500">Para</label>
          <div>
            <input value={para} onChange={(e) => setPara(e.target.value)} placeholder="email del proveedor (si lo dejas vacío, se envía solo a las personas de CC)" className="w-full border border-slate-300 rounded px-2 py-1" />
            <div className="text-[10px] text-slate-400 mt-0.5">
              {tipoMensaje === "interno"
                ? "Mensaje interno: el correo del proveedor no se incluye."
                : (emailBC === null ? "Consultando la ficha del proveedor en BC…" : emailBC ? `Ficha BC: ${emailBC}` : "La ficha del proveedor en BC no tiene email — escríbelo y se recordará para la próxima vez.")}
              {tipoMensaje === "proveedor" && emailGuardado && emailGuardado !== emailBC ? ` · Recordado: ${emailGuardado}` : ""}
            </div>
          </div>
          <label className="text-xs font-semibold text-slate-500">CC</label>
          <input value={cc} onChange={(e) => setCc(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500">Asunto</label>
          <input value={asunto ?? asuntoAuto} onChange={(e) => setAsunto(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Texto inicial</label>
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={8} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Despedida</label>
          <textarea value={cierre} onChange={(e) => { cierreTocado.current = true; setCierre(e.target.value); }} rows={4} className="w-full border border-slate-300 rounded px-2 py-1" />
        </div>

        <div className="mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">Adjuntos</span>
            <button
              type="button"
              onClick={() => inputAdjuntoRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-sm rounded-md px-3 py-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            >
              <Paperclip size={14} /> Adjuntar
            </button>
            <span className="text-[10px] text-slate-400">PDF, foto (JPG o PNG), Excel o Word. Cada uno hasta 3 MB.</span>
            <input
              ref={inputAdjuntoRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx"
              className="hidden"
              onChange={(e) => anadirAdjuntos(e.target.files)}
            />
          </div>
          {adjuntos.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 mt-2">
              {adjuntos.map((a) => (
                <li key={a.id} className="inline-flex items-center gap-1 text-[12px] bg-slate-50 border border-slate-200 rounded px-2 py-1">
                  <span className="max-w-[260px] truncate" title={a.nombre}>{a.nombre}</span>
                  <button type="button" onClick={() => setAdjuntos((prev) => prev.filter((x) => x.id !== a.id))} className="text-slate-400 hover:text-red-600" aria-label={`Quitar ${a.nombre}`}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
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
function emailRecordadoProveedor(map, nombre) {
  const n = String(nombre || "").trim().toLowerCase();
  if (!n || !map) return "";
  const exacta = Object.keys(map).find((k) => String(k).trim().toLowerCase() === n);
  if (exacta) return map[exacta] || "";
  if (n.length < 4) return "";
  const parcial = Object.keys(map).filter((k) => {
    const kl = String(k).trim().toLowerCase();
    return kl.includes(n) || n.includes(kl);
  });
  return parcial.length === 1 ? (map[parcial[0]] || "") : "";
}

function lineasParaConsulta(g) {
  const dePdf = (g?.lineasPdf || []).filter((l) => l && l.descripcion);
  if (dePdf.length) return dePdf.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad }));
  return (g?.lineas || [])
    .filter((l) => l && l.descripcionAlbaran)
    .map((l) => ({ descripcion: l.descripcionAlbaran, cantidad: l.cantidadAlbaran }));
}

function textoConsultaPc({ proveedor, albaran, archivo, pedido, lineas }) {
  const alb = albaran ? albaran : "(sin número)";
  const deQuien = proveedor ? ` de ${proveedor}` : "";
  const doc = archivo ? ` Documento: ${archivo}.` : "";
  const filas = (lineas || [])
    .filter((l) => l.descripcion)
    .map((l) => `· ${l.descripcion}${l.cantidad != null && l.cantidad !== "" ? ` — cantidad ${l.cantidad}` : ""}`);
  const bloque = filas.length ? `\n\nMaterial leído en el albarán:\n${filas.join("\n")}` : "";
  if (pedido) {
    return `Buenos días,\n\nHemos recibido el albarán ${alb}${deQuien}.${doc}\n\nEn el documento figura el pedido de compra ${pedido}. ¿Nos podéis confirmar a qué OT corresponde esta entrega?${bloque}`;
  }
  return `Buenos días,\n\nHemos recibido el albarán ${alb}${deQuien}.${doc}\n\nEn el documento no aparece nuestro número de pedido de compra (PC).\n\n¿Nos podéis indicar a qué pedido de compra (PC) o a qué OT corresponde esta entrega?${bloque}`;
}

function asuntoConsultaPc({ albaran, pedido }) {
  const alb = albaran || "sin número";
  const empresa = razonEmpresaFirma();
  if (!pedido) return `Albarán ${alb} — ¿a qué pedido de compra (PC) u OT corresponde? – ${empresa}`;
  return `Albarán ${alb} — pedido ${pedido}: ¿a qué OT corresponde? – ${empresa}`;
}

function htmlConsultaPc(intro, cierre) {
  const cuerpo = [intro, cierre].filter(Boolean).map((t) => escHtml(t).split(/\n/).join("<br>")).join("<br><br>");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1e293b">${cuerpo}</div>`;
}

function bytesDeBase64(b64) {
  const limpio = String(b64 || "").replace(/\s/g, "");
  if (!limpio) return 0;
  const pad = limpio.endsWith("==") ? 2 : limpio.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(limpio.length * 3 / 4) - pad);
}

function nombrePdfConsulta(albaran, pedido) {
  const base = String(albaran || pedido || "albaran").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  return `Albaran_${base}.pdf`;
}

// Pregunta, sin enviar al primer clic, a qué PC u OT pertenece un albarán.
// Mismo envío que la reclamación: /api/correo/enviar, desde el buzón de quien está logueado.
function ModalConsultaPc({ grupo, emailsProveedor, onClose, onEnviado }) {
  const [proveedor, setProveedor] = useState(grupo.proveedor || "");
  const [para, setPara] = useState(() => emailRecordadoProveedor(emailsProveedor, grupo.proveedor));
  const paraTocado = useRef(false);
  const [emailBC, setEmailBC] = useState(null);
  const [remitente, setRemitente] = useState("");
  const ccTocado = useRef(false);
  const [cc, setCc] = useState("");
  const cierreTocado = useRef(false);
  const [cierre, setCierre] = useState(() => textoCierre(""));
  const introTocado = useRef(false);
  const [intro, setIntro] = useState(() => textoConsultaPc(grupo));
  const [asunto, setAsunto] = useState(() => asuntoConsultaPc(grupo));
  const pdfBytes = bytesDeBase64(grupo.pdfBase64);
  const pdfOk = pdfBytes > 0 && pdfBytes <= TOPE_FICHERO;
  const [adjuntarPdf, setAdjuntarPdf] = useState(pdfOk);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => {
        if (d.email) setRemitente(d.email);
        if (!cierreTocado.current) setCierre(textoCierre(d.nombre));
        if (!ccTocado.current) setCc(copiasAdministracion(d.email).join("; "));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const nombre = proveedor.trim();
    if (!nombre) { setEmailBC(""); return; }
    let vivo = true;
    setEmailBC(null);
    const qs = new URLSearchParams({ nombre });
    fetch(`/api/bc/proveedor-email?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (!vivo) return;
        const e = (d && d.email) || "";
        setEmailBC(e);
        if (!paraTocado.current) setPara(e || emailRecordadoProveedor(emailsProveedor, nombre));
      })
      .catch(() => { if (vivo) setEmailBC(""); });
    return () => { vivo = false; };
  }, [proveedor, emailsProveedor]);

  useEffect(() => {
    if (introTocado.current) return;
    setIntro(textoConsultaPc({ ...grupo, proveedor: proveedor.trim() }));
  }, [proveedor, grupo]);

  const html = useMemo(() => htmlConsultaPc(intro, cierre), [intro, cierre]);

  const enviar = async () => {
    const dest = partirEmails(para);
    if (!dest.length) { setError("Escribe al menos un destinatario en Para. No se envía nada hasta que lo confirmes."); return; }
    if (!(asunto || "").trim()) { setError("El asunto está vacío."); return; }
    setEnviando(true);
    setError(null);
    try {
      const adjuntos = adjuntarPdf && pdfOk
        ? [{ nombre: nombrePdfConsulta(grupo.albaran, grupo.pedido), base64: grupo.pdfBase64, mime: "application/pdf" }]
        : [];
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: dest,
          cc: partirEmails(cc),
          asunto: asunto.trim(),
          cuerpoHtml: html,
          adjuntos,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      const escrito = dest.join("; ");
      onEnviado({
        proveedor: proveedor.trim(),
        para: escrito,
        recordarEmail: proveedor.trim() && escrito !== (emailBC || "") ? escrito : null,
      });
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Mail size={18} /> Preguntar a qué PC u OT corresponde</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <p className="text-[12px] text-slate-500 mb-3">
          Revisa destinatario, asunto y texto. No se envía hasta que pulses Enviar.
          {grupo.pedido ? ` Pedido leído: ${grupo.pedido}.` : " Este albarán no trae número de pedido de compra."}
          {grupo.albaran ? ` Albarán ${grupo.albaran}.` : ""}
        </p>

        <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-2 items-center text-[13px] mb-3">
          <label className="text-xs font-semibold text-slate-500">Proveedor</label>
          <div>
            <input value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="Nombre tal como está en la ficha de BC, si lo conoces" className="w-full border border-slate-300 rounded px-2 py-1" />
            <div className="text-[10px] text-slate-400 mt-0.5">Solo sirve para buscar el email. No crea el pedido.</div>
          </div>
          <label className="text-xs font-semibold text-slate-500">Para</label>
          <div>
            <input value={para} onChange={(e) => { paraTocado.current = true; setPara(e.target.value); }} placeholder="email del proveedor o de quien deba decir el PC o la OT" className="w-full border border-slate-300 rounded px-2 py-1" />
            <div className="text-[10px] text-slate-400 mt-0.5">
              {!proveedor.trim()
                ? "Sin nombre de proveedor no se puede buscar el email. Escríbelo en Para."
                : emailBC === null
                  ? "Consultando la ficha del proveedor en BC…"
                  : emailBC
                    ? `Ficha BC: ${emailBC}`
                    : "La ficha del proveedor en BC no tiene email con ese nombre exacto. Escríbelo y se recordará."}
            </div>
          </div>
          <label className="text-xs font-semibold text-slate-500">CC</label>
          <input value={cc} onChange={(e) => { ccTocado.current = true; setCc(e.target.value); }} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500">Asunto</label>
          <input value={asunto} onChange={(e) => setAsunto(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Texto</label>
          <textarea value={intro} onChange={(e) => { introTocado.current = true; setIntro(e.target.value); }} rows={9} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Despedida</label>
          <textarea value={cierre} onChange={(e) => { cierreTocado.current = true; setCierre(e.target.value); }} rows={4} className="w-full border border-slate-300 rounded px-2 py-1" />
        </div>

        <label className="flex items-center gap-2 text-[12px] text-slate-600 mb-3">
          <input type="checkbox" checked={adjuntarPdf && pdfOk} disabled={!pdfOk} onChange={(e) => setAdjuntarPdf(e.target.checked)} />
          {pdfOk
            ? `Adjuntar el PDF de este albarán (${nombrePdfConsulta(grupo.albaran, grupo.pedido)})`
            : grupo.pdfBase64
              ? "El PDF pesa más de 3 MB y no se puede adjuntar a este correo."
              : "Este albarán no tiene PDF para adjuntar."}
        </label>

        <div className="text-xs font-semibold text-slate-500 mb-1">Vista previa del correo</div>
        <div className="border border-slate-200 rounded-md p-3 bg-slate-50 max-h-52 overflow-y-auto text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />
        {remitente && <div className="text-[10px] text-slate-400 mt-1">Se enviará desde {remitente}.</div>}

        {error && <div className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2">✗ {error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-sm border border-slate-300 rounded-md px-4 py-2 hover:bg-slate-50">Cancelar</button>
          <button onClick={enviar} disabled={enviando} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
            {enviando ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />} Enviar consulta
          </button>
        </div>
      </div>
    </div>
  );
}

function lineasParaConsulta(grupo) {
  return (grupo?.lineas || [])
    .filter((l) => l && !l.soloPedido && (l.descripcion || l.descripcionAlbaran))
    .map((l) => ({
      descripcion: l.descripcion || l.descripcionAlbaran,
      cantidad: l.cantidad != null && l.cantidad !== "" ? l.cantidad : l.cantidadAlbaran,
    }));
}

function textoConsultaResponsable({ proveedor, albaran, pedido, ot, lineas }) {
  const alb = albaran ? `el albarán ${albaran}` : "un albarán";
  const deQuien = proveedor ? ` de ${proveedor}` : "";
  const otTxt = ot
    ? `En el pedido figura la OT ${ot}.`
    : "En el pedido no figura ninguna OT.";
  const filas = (lineas || [])
    .filter((l) => l.descripcion)
    .map((l) => `· ${l.descripcion}${l.cantidad != null && l.cantidad !== "" ? ` — cantidad ${l.cantidad}` : ""}`);
  const bloque = filas.length ? `\n\nMaterial leído en el albarán:\n${filas.join("\n")}` : "";
  return `Buenos días,\n\nHemos recibido ${alb}${deQuien}. En el documento figura el pedido de compra ${pedido || "(sin número)"}.\n\n${otTxt}\n\n¿Nos podéis confirmar si este pedido es correcto y a qué OT corresponde?${bloque}`;
}

function asuntoConsultaResponsable({ pedido, albaran }) {
  const cual = pedido ? `Pedido ${pedido}` : `Albarán ${albaran || "sin número"}`;
  return `${cual} — ¿es correcto y a qué OT corresponde? – ${razonEmpresaFirma()}`;
}

function destinosResponsable(codigo, emailRemitente) {
  const depto = codigoDepartamentoDesdeUnidad(codigo);
  if (!depto) return { para: [], cc: copiasAdministracion(emailRemitente) };
  const listas = listasCorreoDepartamento(depto);
  return aplicarRemitente(listas.para, listas.cc, emailRemitente);
}

// Pregunta al responsable del departamento, sin enviar al primer clic,
// si el pedido de esta recepción es correcto y a qué OT corresponde.
function ModalConsultaResponsable({ grupo, onClose, onEnviado }) {
  const deptoInicial = codigoDepartamentoDesdeUnidad(grupo.departamento) || "";
  const [depto, setDepto] = useState(deptoInicial);
  const [para, setPara] = useState("");
  const paraTocado = useRef(false);
  const [remitente, setRemitente] = useState("");
  const ccTocado = useRef(false);
  const [cc, setCc] = useState("");
  const cierreTocado = useRef(false);
  const [cierre, setCierre] = useState(() => textoCierre(""));
  const [intro, setIntro] = useState(() => textoConsultaResponsable(grupo));
  const [asunto, setAsunto] = useState(() => asuntoConsultaResponsable(grupo));
  const pdfBytes = bytesDeBase64(grupo.pdfBase64);
  const pdfOk = pdfBytes > 0 && pdfBytes <= TOPE_FICHERO;
  const [adjuntarPdf, setAdjuntarPdf] = useState(pdfOk);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const deptoRef = useRef(deptoInicial);

  const aplicarDestinos = (codigo, emailRemitente, forzarPara, forzarCc) => {
    const d = destinosResponsable(codigo, emailRemitente);
    if (forzarPara || !paraTocado.current) setPara(d.para.join("; "));
    if (forzarCc || !ccTocado.current) setCc(d.cc.join("; "));
  };

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => {
        if (d.email) setRemitente(d.email);
        if (!cierreTocado.current) setCierre(textoCierre(d.nombre));
        aplicarDestinos(deptoRef.current, d.email, false, false);
      })
      .catch(() => {});
  }, []);

  const elegirDepto = (codigo) => {
    deptoRef.current = codigo;
    setDepto(codigo);
    aplicarDestinos(codigo, remitente, !paraTocado.current, !ccTocado.current);
  };

  const html = useMemo(() => htmlConsultaPc(intro, cierre), [intro, cierre]);
  const etiqueta = etiquetaDepartamento(depto);

  const enviar = async () => {
    const dest = partirEmails(para);
    if (!dest.length) {
      setError(depto ? "Escribe al menos un destinatario en Para." : "Elige el departamento del responsable, o escribe el correo en Para.");
      return;
    }
    if (!(asunto || "").trim()) { setError("El asunto está vacío."); return; }
    setEnviando(true);
    setError(null);
    try {
      const adjuntos = adjuntarPdf && pdfOk
        ? [{ nombre: nombrePdfConsulta(grupo.albaran, grupo.pedido), base64: grupo.pdfBase64, mime: "application/pdf" }]
        : [];
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: dest,
          cc: partirEmails(cc),
          asunto: asunto.trim(),
          cuerpoHtml: html,
          adjuntos,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      onEnviado({ pedido: grupo.pedido, para: dest.join("; "), depto: etiqueta });
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Mail size={18} /> Preguntar al responsable</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <p className="text-[12px] text-slate-500 mb-3">
          Pregunta si el pedido {grupo.pedido || "de este albarán"} es correcto y a qué OT corresponde.
          Revisa destinatario y texto. No se envía hasta que pulses Enviar.
          {grupo.ot ? ` OT en el pedido: ${grupo.ot}.` : " Este pedido no tiene OT en BC."}
        </p>

        <div className="mb-3">
          <div className="text-xs font-semibold text-slate-500 mb-1">Responsable del departamento</div>
          <div className="flex flex-wrap gap-1.5">
            {DEPTOS_RESPONSABLE.map((d) => (
              <button
                key={d.codigo}
                type="button"
                onClick={() => elegirDepto(d.codigo)}
                className={`text-[12px] font-semibold rounded-full px-3 py-1 border ${
                  depto === d.codigo
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {d.nombre}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">
            {depto
              ? `Responsables: ${(emailsPorCodigoDepartamento(depto) || []).join(", ") || "sin correos de este departamento"}`
              : "El pedido no tiene departamento en BC. Elige a quién preguntar."}
          </div>
        </div>

        <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-2 items-center text-[13px] mb-3">
          <label className="text-xs font-semibold text-slate-500">Para</label>
          <input value={para} onChange={(e) => { paraTocado.current = true; setPara(e.target.value); }} placeholder="correo del responsable" className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500">CC</label>
          <input value={cc} onChange={(e) => { ccTocado.current = true; setCc(e.target.value); }} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500">Asunto</label>
          <input value={asunto} onChange={(e) => setAsunto(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Texto</label>
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={9} className="w-full border border-slate-300 rounded px-2 py-1" />
          <label className="text-xs font-semibold text-slate-500 self-start pt-1">Despedida</label>
          <textarea value={cierre} onChange={(e) => { cierreTocado.current = true; setCierre(e.target.value); }} rows={4} className="w-full border border-slate-300 rounded px-2 py-1" />
        </div>

        <label className="flex items-center gap-2 text-[12px] text-slate-600 mb-3">
          <input type="checkbox" checked={adjuntarPdf && pdfOk} disabled={!pdfOk} onChange={(e) => setAdjuntarPdf(e.target.checked)} />
          {pdfOk
            ? `Adjuntar el PDF de este albarán (${nombrePdfConsulta(grupo.albaran, grupo.pedido)})`
            : grupo.pdfBase64
              ? "El PDF pesa más de 3 MB y no se puede adjuntar a este correo."
              : "Este albarán no tiene PDF para adjuntar."}
        </label>

        <div className="text-xs font-semibold text-slate-500 mb-1">Vista previa del correo</div>
        <div className="border border-slate-200 rounded-md p-3 bg-slate-50 max-h-52 overflow-y-auto text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />
        {remitente && <div className="text-[10px] text-slate-400 mt-1">Se enviará desde {remitente}.</div>}

        {error && <div className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2">✗ {error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-sm border border-slate-300 rounded-md px-4 py-2 hover:bg-slate-50">Cancelar</button>
          <button onClick={enviar} disabled={enviando} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
            {enviando ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />} Enviar al responsable
          </button>
        </div>
      </div>
    </div>
  );
}

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

// Nota de correo: la primera línea es destinatario/asunto; el resto es el mensaje.
function partesNotaCorreo(texto) {
  const t = String(texto || "");
  const nl = t.indexOf("\n");
  if (nl !== -1) return { cabecera: t.slice(0, nl), mensaje: t.slice(nl + 1) };
  const finAsunto = t.indexOf("»");
  if (finAsunto !== -1) return { cabecera: t.slice(0, finAsunto + 1), mensaje: t.slice(finAsunto + 1).replace(/^\s+/, "") };
  return null;
}

function CuerpoNota({ nota }) {
  const partes = String(nota.autor || "").includes("Correo") ? partesNotaCorreo(nota.texto) : null;
  if (!partes?.mensaje) return nota.texto;
  return (
    <>
      {partes.cabecera}
      {"\n"}
      <span className="font-bold text-slate-900">{partes.mensaje}</span>
    </>
  );
}

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
          <span className="text-slate-700 whitespace-pre-wrap flex-1"><CuerpoNota nota={n} />{n.enlace ? <> <a href={n.enlace} target="_blank" rel="noreferrer" className="text-blue-600 underline font-normal whitespace-nowrap">Abrir en Outlook</a></> : null}</span>
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

function ajustesPedidoDe(g) {
  const porId = new Map();
  const errores = [];
  for (const l of g.lineas || []) {
    if (!l.lineaBC?.id) continue;
    const cantTxt = l.cantidadPedidoEdit !== undefined ? l.cantidadPedidoEdit : l.lineaBC.cantidadPedida;
    const precioTxt = l.precioEdit !== undefined ? l.precioEdit : (l.lineaBC.precio ?? "");
    if (cantTxt === "" || cantTxt == null) {
      errores.push("La cantidad del pedido no puede quedar vacía.");
      continue;
    }
    const cantNueva = Number(cantTxt);
    const cantOrig = Number(l.lineaBC.cantidadPedida) || 0;
    const recibida = Number(l.lineaBC.cantidadRecibida) || 0;
    if (!Number.isFinite(cantNueva) || cantNueva < 0) {
      errores.push("La cantidad del pedido no es un número válido.");
      continue;
    }
    if (cantNueva + 1e-9 < recibida) {
      errores.push(`No se puede dejar la cantidad del pedido en ${cantNueva}: en esta línea ya hay ${recibida} recibida.`);
      continue;
    }
    const cambiaCant = Math.abs(cantNueva - cantOrig) > 1e-6;
    let precioNueva = null;
    let cambiaPrecio = false;
    if (precioTxt !== "" && precioTxt != null) {
      precioNueva = Number(precioTxt);
      if (!Number.isFinite(precioNueva) || precioNueva < 0) {
        errores.push("El coste directo no es un número válido.");
        continue;
      }
      const precioOrig = l.lineaBC.precio == null || l.lineaBC.precio === "" ? null : Number(l.lineaBC.precio);
      cambiaPrecio = precioOrig == null || Math.abs(precioNueva - precioOrig) > 0.0001;
    }
    if (!cambiaCant && !cambiaPrecio) continue;
    const item = { lineaId: l.lineaBC.id };
    if (cambiaCant) item.cantidad = cantNueva;
    if (cambiaPrecio) item.precio = precioNueva;
    const prev = porId.get(item.lineaId);
    if (prev) {
      if (prev.cantidad != null && item.cantidad != null && Math.abs(prev.cantidad - item.cantidad) > 1e-6) {
        errores.push("Dos líneas del albarán cambian la cantidad de la misma línea del pedido de forma distinta.");
      }
      if (prev.precio != null && item.precio != null && Math.abs(prev.precio - item.precio) > 0.0001) {
        errores.push("Dos líneas del albarán cambian el precio de la misma línea del pedido de forma distinta.");
      }
      porId.set(item.lineaId, { ...prev, ...item });
    } else {
      porId.set(item.lineaId, item);
    }
  }
  return { ajustes: [...porId.values()], errores: [...new Set(errores)] };
}

function normDoc(v) {
  return String(v || "").replace(/\W/g, "").toLowerCase();
}

/** Control opcional y discreto: quién ha recogido el material (firma). */
function QuienHaRecogido({ albaran, pedido, proveedor, pdfVista }) {
  const [abierto, setAbierto] = useState(false);
  const [asignado, setAsignado] = useState(null);
  const [sugerido, setSugerido] = useState(null);
  const [recursos, setRecursos] = useState([]);
  const [filtro, setFiltro] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState("");
  const claveUi = `${albaran || ""}|${pedido || ""}|${proveedor || ""}`;

  useEffect(() => {
    setAsignado(null);
    setSugerido(null);
    setDescripcion("");
    setAviso("");
    setAbierto(false);
    if (!albaran && !pedido) return;
    let cancel = false;
    const q = new URLSearchParams();
    if (albaran) q.set("albaran", albaran);
    if (pedido) q.set("pedido", pedido);
    if (proveedor) q.set("proveedor", proveedor);
    fetch(`/api/recepcion/firmas?${q}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancel) return;
        if (j.asignado) setAsignado(j.asignado);
        if (j.sugerido) setSugerido(j.sugerido);
      })
      .catch(() => {});
    return () => { cancel = true; };
  }, [claveUi]);

  const abrir = async () => {
    setAbierto(true);
    setAviso("");
    setCargando(true);
    try {
      const rRec = await fetch("/api/recepcion/recursos");
      const jRec = await rRec.json();
      if (!rRec.ok) throw new Error(jRec.error || "No se han podido cargar los trabajadores.");
      setRecursos(jRec.recursos || []);

      if (pdfVista) {
        const rDesc = await fetch("/api/recepcion/firmas/describir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfVista, albaran, pedido, proveedor }),
        });
        const jDesc = await rDesc.json();
        if (rDesc.ok) {
          if (jDesc.firmaDescripcion) setDescripcion(jDesc.firmaDescripcion);
          if (jDesc.asignado) setAsignado(jDesc.asignado);
          if (jDesc.sugerido) setSugerido(jDesc.sugerido);
          if (!jDesc.firmaVisible) setAviso("No se ve una firma clara en el PDF; puedes asignar la persona igual.");
        }
      }
    } catch (e) {
      setAviso(String(e.message || e));
    } finally {
      setCargando(false);
    }
  };

  const guardar = async (recurso) => {
    if (!recurso?.no) return;
    setGuardando(true);
    setAviso("");
    try {
      const r = await fetch("/api/recepcion/firmas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          albaran,
          pedido,
          proveedor,
          recursoNo: recurso.no,
          nombre: recurso.nombre,
          descripcion,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se ha podido guardar.");
      setAsignado(j.asignado || { recursoNo: recurso.no, nombre: recurso.nombre });
      setSugerido(null);
      setAbierto(false);
    } catch (e) {
      setAviso(String(e.message || e));
    } finally {
      setGuardando(false);
    }
  };

  const quitar = async () => {
    setGuardando(true);
    setAviso("");
    try {
      const r = await fetch("/api/recepcion/firmas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ albaran, pedido, proveedor, borrar: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se ha podido quitar.");
      setAsignado(null);
      setAbierto(false);
    } catch (e) {
      setAviso(String(e.message || e));
    } finally {
      setGuardando(false);
    }
  };

  const lista = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    if (!f) return recursos;
    return recursos.filter((x) =>
      String(x.nombre || "").toLowerCase().includes(f) || String(x.no || "").toLowerCase().includes(f)
    );
  }, [recursos, filtro]);

  if (!albaran && !pedido) return null;

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={abrir}
        title="Opcional: anotar quién ha recogido el material según la firma"
        className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 underline decoration-dotted"
      >
        <User size={10} className="opacity-70" />
        {asignado?.nombre ? `Recogido: ${asignado.nombre}` : "Quién ha recogido"}
      </button>
    );
  }

  return (
    <div className="mt-1 max-w-sm rounded border border-slate-200 bg-slate-50/80 px-2 py-1.5 text-[11px] text-slate-600">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-semibold text-slate-500">Quién ha recogido (opcional)</span>
        <button type="button" onClick={() => setAbierto(false)} className="text-slate-400 hover:text-slate-600" title="Cerrar">
          <X size={12} />
        </button>
      </div>
      {cargando ? (
        <div className="text-slate-400">Mirando la firma…</div>
      ) : (
        <>
          {sugerido && !asignado && (
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-slate-500">¿Es {sugerido.nombre}?</span>
              <button
                type="button"
                disabled={guardando}
                onClick={() => guardar({ no: sugerido.recursoNo, nombre: sugerido.nombre })}
                className="font-semibold text-indigo-700 hover:underline disabled:opacity-50"
              >
                Sí
              </button>
            </div>
          )}
          {asignado && (
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span>Guardado: <span className="font-semibold text-slate-800">{asignado.nombre}</span></span>
              <button type="button" disabled={guardando} onClick={quitar} className="text-slate-500 hover:text-red-600 hover:underline disabled:opacity-50">
                Quitar
              </button>
            </div>
          )}
          <input
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Buscar trabajador…"
            className="w-full border border-slate-300 rounded px-1.5 py-0.5 mb-1 bg-white"
          />
          <div className="max-h-36 overflow-y-auto border border-slate-200 rounded bg-white">
            {lista.length === 0 ? (
              <div className="px-2 py-1.5 text-slate-400">Sin coincidencias</div>
            ) : (
              lista.slice(0, 80).map((r) => (
                <button
                  key={r.no}
                  type="button"
                  disabled={guardando}
                  onClick={() => guardar(r)}
                  className={`block w-full text-left px-2 py-1 hover:bg-indigo-50 disabled:opacity-50 ${asignado?.recursoNo === r.no ? "bg-indigo-50 text-indigo-800" : ""}`}
                >
                  <span className="font-medium">{r.nombre}</span>
                  <span className="text-slate-400 ml-1 font-mono text-[10px]">{r.no}</span>
                </button>
              ))
            )}
          </div>
          {aviso ? <div className="mt-1 text-amber-700">{aviso}</div> : null}
        </>
      )}
    </div>
  );
}

function DatoLeido({ etiqueta, valor, aviso, editable, onChange, tipo = "text", extra, placeholder, children, className = "" }) {
  return (
    <div className={`rounded border px-2 py-1.5 min-w-0 ${aviso ? "border-amber-300 bg-amber-50" : editable || children ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50"} ${className}`}>
      <div className="text-[10px] text-slate-500">{etiqueta}</div>
      {children || (editable ? (
        <input
          type={tipo}
          value={valor ?? ""}
          placeholder={placeholder || ""}
          onChange={(e) => onChange(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          className={`mt-0.5 w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none ${aviso ? "text-amber-900" : ""}`}
        />
      ) : (
        <div className={`text-[12px] break-words ${aviso ? "text-amber-900" : "text-slate-800"}`}>{valor ? String(valor) : "—"}</div>
      ))}
      {extra || null}
    </div>
  );
}

function DesplegableProveedor({ numero, nombre, onElegir }) {
  const [lista, setLista] = useState(null);
  const [error, setError] = useState(null);
  const [texto, setTexto] = useState(nombre || "");
  const [abierto, setAbierto] = useState(false);
  const cajaRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => { setTexto(nombre || ""); }, [nombre, numero]);
  useEffect(() => {
    let vivo = true;
    fetch("/api/bc/proveedores")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
        return j;
      })
      .then((j) => {
        if (!vivo) return;
        setLista(Array.isArray(j.proveedores) ? j.proveedores : []);
      })
      .catch((e) => { if (vivo) { setError(e.message || String(e)); setLista([]); } });
    return () => { vivo = false; };
  }, []);
  useLayoutEffect(() => {
    if (!abierto || !cajaRef.current) { setPos(null); return undefined; }
    const colocar = () => {
      if (!cajaRef.current) return;
      const r = cajaRef.current.getBoundingClientRect();
      const ancho = Math.max(r.width, 320);
      let left = r.left;
      if (left + ancho > window.innerWidth - 8) left = Math.max(8, window.innerWidth - ancho - 8);
      setPos({ top: r.bottom + 4, left, width: ancho });
    };
    colocar();
    window.addEventListener("scroll", colocar, true);
    window.addEventListener("resize", colocar);
    return () => {
      window.removeEventListener("scroll", colocar, true);
      window.removeEventListener("resize", colocar);
    };
  }, [abierto, texto]);
  const q = texto.trim().toLowerCase();
  const sugeridos = useMemo(() => {
    if (!lista) return [];
    if (!q) return lista.slice(0, 120);
    const palabras = q.split(/\s+/).filter(Boolean);
    const fil = lista.filter((p) => {
      const n = String(p.nombre || "").toLowerCase();
      const c = String(p.cif || "").toLowerCase();
      const num = String(p.numero || "").toLowerCase();
      const hay = `${n} ${c} ${num}`;
      if (hay.includes(q)) return true;
      return palabras.every((w) => hay.includes(w));
    });
    // Con filtro no cortamos: si escribes SALTO deben salir todos los Saltoki.
    return fil.length ? fil : lista.filter((p) => String(p.nombre || "").toLowerCase().includes(palabras[0] || q));
  }, [lista, q]);
  const elegir = (p) => {
    onElegir(p);
    setTexto(p.nombre || "");
    setAbierto(false);
  };
  const listaUi = abierto && pos ? createPortal(
    <div
      style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
      className="max-h-72 overflow-y-auto bg-white border border-indigo-300 rounded-md shadow-xl"
      onMouseDown={(e) => e.preventDefault()}
    >
      {!lista && <div className="px-2 py-2 text-[11px] text-slate-400">Cargando proveedores…</div>}
      {lista && sugeridos.length === 0 && (
        <div className="px-2 py-2 text-[11px] text-slate-400">Ningún proveedor con «{texto}»</div>
      )}
      {sugeridos.map((p) => (
        <button
          key={p.numero}
          type="button"
          onClick={() => elegir(p)}
          className={`block w-full text-left px-2 py-1.5 text-[12px] hover:bg-indigo-50 border-b border-slate-100 last:border-0 ${p.numero === numero ? "bg-indigo-50 font-semibold" : "text-slate-800"}`}
        >
          {p.nombre}
          <span className="text-slate-500"> · {p.cif || p.numero}</span>
        </button>
      ))}
    </div>,
    document.body
  ) : null;
  return (
    <div ref={cajaRef} className="relative">
      <div className="mt-0.5 flex items-center gap-1">
        <input
          value={texto}
          placeholder={lista ? "Escribe para filtrar…" : "Cargando proveedores…"}
          onChange={(e) => { setTexto(e.target.value); setAbierto(true); }}
          onFocus={() => setAbierto(true)}
          onBlur={() => setTimeout(() => setAbierto(false), 200)}
          onMouseDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
        />
        <button
          type="button"
          title="Ver proveedores"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAbierto((v) => !v)}
          className="shrink-0 rounded border border-slate-200 bg-white p-1 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {listaUi}
      {error ? <div className="text-[10px] text-red-600 mt-0.5">{error}</div> : null}
      {lista && !error ? <div className="text-[10px] text-slate-400 mt-0.5">{lista.length} proveedores</div> : null}
    </div>
  );
}

function leerImagenProducto(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || "")) {
      reject(new Error("Pega una foto del producto (imagen)."));
      return;
    }
    const lector = new FileReader();
    lector.onerror = () => reject(new Error("No se pudo leer la imagen."));
    lector.onload = () => {
      const original = String(lector.result || "");
      const img = new Image();
      img.onload = () => {
        const lado = Math.max(img.width, img.height);
        if (lado <= 1600 && file.size <= 1.5 * 1024 * 1024 && /^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type || "")) {
          resolve(original);
          return;
        }
        const k = Math.min(1, 1600 / lado);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("No se pudo leer la imagen."));
      img.src = original;
    };
    lector.readAsDataURL(file);
  });
}

function useFamiliasAlta(nivel, padre, abuelo, activo) {
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!activo || (nivel > 1 && !padre)) {
      setItems([]);
      setError("");
      setCargando(false);
      return;
    }
    let vivo = true;
    setCargando(true);
    const q = new URLSearchParams({ nivel: String(nivel) });
    if (padre) q.set("padre", padre);
    if (abuelo) q.set("abuelo", abuelo);
    fetch(`/api/recepcion/preparar/familias?${q}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!vivo) return;
        if (!ok) throw new Error(j.error || "No se han podido cargar las familias.");
        const lista = [...(j.items || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
        setItems(lista);
        setError("");
      })
      .catch((e) => { if (vivo) { setItems([]); setError(e.message || String(e)); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [nivel, padre, abuelo, activo]);
  return { items, cargando, error };
}

function FormAltaArticulo({ descripcionInicial, ocupado, onCancelar, onCrear }) {
  const [descripcion, setDescripcion] = useState(descripcionInicial || "");
  const [cat1, setCat1] = useState("");
  const [cat2, setCat2] = useState("");
  const [cat3, setCat3] = useState("");
  const [imagen, setImagen] = useState("");
  const [aviso, setAviso] = useState("");
  const f1 = useFamiliasAlta(1, "", "", true);
  const f2 = useFamiliasAlta(2, cat1, "", !!cat1);
  const f3 = useFamiliasAlta(3, cat2, cat1, !!cat1 && !!cat2);
  const errorFamilias = f1.error || f2.error || f3.error;
  const onPegar = async (e) => {
    const file = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .find((f) => f && /^image\//.test(f.type || ""));
    if (!file) return;
    e.preventDefault();
    try {
      setImagen(await leerImagenProducto(file));
      setAviso("");
    } catch (err) {
      setAviso(err.message || String(err));
    }
  };
  const crear = async () => {
    if (!descripcion.trim()) { setAviso("Falta la descripción."); return; }
    if (!cat1 || !cat2 || !cat3) { setAviso("Elige las tres familias."); return; }
    setAviso("");
    try {
      await onCrear({ descripcion: descripcion.trim(), cat1, cat2, cat3, imagen: imagen || null });
    } catch (err) {
      setAviso(err.message || String(err));
    }
  };
  const selectClase = "mt-0.5 w-full border border-slate-300 rounded px-1.5 py-1 text-[12px] bg-white";
  return (
    <div className="mt-2 p-2 border border-indigo-200 bg-indigo-50/40 rounded" onPaste={onPegar}>
      <label className="block text-[11px] text-slate-600">
        Descripción
        <input
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          className="mt-0.5 w-full border border-slate-300 rounded px-1.5 py-1 text-[12px] bg-white"
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
        <label className="block text-[11px] text-slate-600">
          Familia 1
          <select value={cat1} onChange={(e) => { setCat1(e.target.value); setCat2(""); setCat3(""); }} className={selectClase} disabled={f1.cargando}>
            <option value="">{f1.cargando ? "Cargando…" : "Elige…"}</option>
            {f1.items.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </label>
        <label className="block text-[11px] text-slate-600">
          Familia 2
          <select value={cat2} onChange={(e) => { setCat2(e.target.value); setCat3(""); }} className={selectClase} disabled={!cat1 || f2.cargando}>
            <option value="">{!cat1 ? "Primero la 1" : f2.cargando ? "Cargando…" : "Elige…"}</option>
            {f2.items.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </label>
        <label className="block text-[11px] text-slate-600">
          Familia 3
          <select value={cat3} onChange={(e) => setCat3(e.target.value)} className={selectClase} disabled={!cat2 || f3.cargando}>
            <option value="">{!cat2 ? "Primero la 2" : f3.cargando ? "Cargando…" : "Elige…"}</option>
            {f3.items.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </label>
      </div>
      <div
        tabIndex={0}
        className="mt-2 border border-dashed border-slate-300 bg-white rounded px-2 py-2 text-[11px] text-slate-500 outline-none focus:border-indigo-400"
      >
        {imagen ? (
          <div className="flex items-center gap-2">
            <img src={imagen} alt="" className="h-12 rounded border border-slate-200" />
            <button type="button" onClick={() => setImagen("")} className="text-slate-500 hover:text-red-600">Quitar foto</button>
          </div>
        ) : (
          "Pega aquí la foto del producto con Ctrl+V. Si no hay foto, se puede crear igual."
        )}
      </div>
      {(aviso || errorFamilias) && <div className="mt-1 text-[11px] text-red-700">{aviso || errorFamilias}</div>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={crear}
          disabled={ocupado}
          className="text-[12px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded px-2.5 py-1"
        >
          {ocupado ? "Creando…" : "Crear artículo"}
        </button>
        <button type="button" onClick={onCancelar} disabled={ocupado} className="text-[12px] text-slate-600 hover:underline disabled:opacity-50">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function textoPrecioPreparar(p) {
  if (p.precio == null) return "sin precio";
  const origen = p.origenPrecio ? ` (${p.origenPrecio})` : "";
  const dto = p.descuento != null && Number(p.descuento) > 0 ? ` · dto. ${p.descuento} %` : " · dto. 0 %";
  return `${fmtEur(Number(p.precio))}${dto}${origen}`;
}

function PanelPrepararPedido({ panel, ot, onOt, onBuscar, buscando, onCrear, creando, onCerrar, onElegir, onCrearArticulo, creandoArticulo, onCambiarDato, docActivo, onDocActivo }) {
  const [busca, setBusca] = useState(null);
  const [altaClave, setAltaClave] = useState(null);
  const docs = panel.documentos || [];
  const idx = Math.min(Math.max(0, docActivo || 0), Math.max(0, docs.length - 1));
  const doc = docs[idx];
  const pdfId = doc?.pdfVista || panel.pdfVista || null;
  const pendientes = docs.filter((d) => !d.resultado || (d.accion !== "ninguna" && (d.propuestas || []).some((p) => p.articulo && !p.enPedido))).length;
  useEffect(() => { setAltaClave(null); }, [idx, panel.archivo]);
  return (
    <div className="mt-4 bg-white border border-indigo-200 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">Preparar pedido · {panel.archivo}</div>
          <p className="text-[11px] text-slate-500 mt-1">
            {docs.length > 1
              ? `Hay ${docs.length} albaranes en este PDF. Trabaja uno y pasa al siguiente.`
              : "Busca si el pedido de este proveedor y esta OT ya existe. Si no, deja las líneas preparadas. No se escribe nada hasta que confirmes."}
          </p>
        </div>
        <button onClick={onCerrar} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>
      {docs.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {docs.map((d, i) => {
            const hecho = !!d.resultado && d.accion === "ninguna";
            return (
              <button
                key={i}
                type="button"
                onClick={() => onDocActivo(i)}
                className={`text-[11px] font-semibold rounded px-2.5 py-1 border ${i === idx ? "bg-indigo-600 text-white border-indigo-600" : hecho ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
              >
                Albarán {i + 1}{d.lectura?.pagina ? ` · pág. ${d.lectura.pagina}` : ""}{hecho ? " · hecho" : ""}
              </button>
            );
          })}
          <span className="text-[11px] text-slate-500">{pendientes} pendiente(s)</span>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-[11px] text-slate-600">
          OT
          <input
            value={ot}
            onChange={(e) => onOt(e.target.value)}
            placeholder="15407"
            className="mt-1 block border border-slate-300 rounded px-2 py-1 text-sm w-40"
          />
        </label>
        <button
          onClick={onBuscar}
          disabled={buscando || creando}
          className="text-sm font-semibold text-indigo-700 border border-indigo-300 bg-white hover:bg-indigo-50 disabled:opacity-50 rounded px-3 py-1.5"
        >
          {buscando ? "Buscando…" : "Buscar con esta OT"}
        </button>
      </div>
      {!doc ? (
        <div className="text-sm text-slate-500">No hay albaranes leídos.</div>
      ) : (
      <div className={`grid grid-cols-1 ${pdfId ? "lg:grid-cols-2" : ""} gap-4`}>
      {pdfId && (
        <div>
          <div className="text-[11px] text-slate-500 mb-1 flex justify-between gap-2">
            <span>{docs.length > 1 ? `Vista previa · albarán ${idx + 1}${doc.lectura?.pagina ? ` (pág. ${doc.lectura.pagina})` : ""}` : "Vista previa"}</span>
            <a href={`/api/recepcion/vista.pdf?id=${encodeURIComponent(pdfId)}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-700 hover:underline">Abrir PDF</a>
          </div>
          <iframe
            key={pdfId}
            src={`/api/recepcion/vista.pdf?id=${encodeURIComponent(pdfId)}`}
            title="Albarán"
            className="w-full border border-slate-200 rounded-md bg-white"
            style={{ height: 640 }}
          />
        </div>
      )}
      <div>
      {(() => {
        const i = idx;
        const falta = (doc.propuestas || []).filter((p) => p.articulo && !p.enPedido);
        return (
          <div key={i} className="border border-slate-200 rounded-md p-3 mb-3">
            <div className="text-[11px] font-semibold text-slate-500 mb-1">
              Datos leídos · puedes corregirlos
              {docs.length > 1 ? ` · albarán ${idx + 1} de ${docs.length}` : ""}
            </div>
            <div className="mb-2">
              <QuienHaRecogido
                albaran={doc.lectura?.albaran || ""}
                pedido={doc.pedido?.numero || doc.lectura?.pedido || ""}
                proveedor={doc.proveedor?.nombre || doc.lectura?.proveedor || ""}
                pdfVista={pdfId}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <DatoLeido etiqueta="Proveedor">
                <DesplegableProveedor
                  numero={doc.proveedor?.numero ?? doc.pedido?.vendorNumber ?? ""}
                  nombre={doc.proveedor?.nombre ?? doc.lectura?.proveedor ?? ""}
                  onElegir={(p) => onCambiarDato(i, "proveedorElegido", p)}
                />
              </DatoLeido>
              <DatoLeido
                etiqueta="Nº proveedor / CIF"
                valor={doc.proveedor?.cif || doc.proveedor?.numero || doc.pedido?.vendorNumber || ""}
                editable
                onChange={(v) => onCambiarDato(i, "proveedorNumero", v)}
              />
              <DatoLeido etiqueta="Albarán" valor={doc.lectura?.albaran ?? ""} editable onChange={(v) => onCambiarDato(i, "albaran", v)} />
              <DatoLeido etiqueta="Fecha" valor={doc.lectura?.fecha ?? ""} editable tipo="date" onChange={(v) => onCambiarDato(i, "fecha", v)} />
              <DatoLeido etiqueta="OT" valor={doc.ot?.codigo ?? doc.lectura?.ot ?? ""} editable onChange={(v) => onCambiarDato(i, "ot", v)} />
              <DatoLeido etiqueta="Departamento" valor={doc.ot?.departamento ?? doc.pedido?.departamento ?? ""} editable onChange={(v) => onCambiarDato(i, "departamento", v)} />
              <DatoLeido etiqueta="Cliente" valor={doc.ot?.cliente ?? ""} editable onChange={(v) => onCambiarDato(i, "cliente", v)} />
              <DatoLeido
                etiqueta="Pedido"
                valor={doc.pedido?.numero ?? ""}
                editable
                placeholder="Vacío = crear pedido nuevo"
                onChange={(v) => onCambiarDato(i, "pedido", v)}
                extra={(
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {doc.pedido?.estado ? <span className="text-[10px] text-slate-500">({doc.pedido.estado})</span> : null}
                    {doc.pedido?.numero ? (
                      <button
                        type="button"
                        onClick={() => onCambiarDato(i, "pedido", "")}
                        className="text-[10px] font-semibold text-indigo-700 hover:underline"
                      >
                        Vaciar y crear pedido nuevo
                      </button>
                    ) : (
                      <span className="text-[10px] text-emerald-700">Se creará un pedido nuevo</span>
                    )}
                  </div>
                )}
              />
              <DatoLeido etiqueta="Fecha pedido" valor={doc.pedido?.fecha ? fmtFecha(doc.pedido.fecha) : ""} />
              <DatoLeido
                etiqueta="Albarán en el pedido"
                valor={doc.pedido?.albaran || ""}
                aviso={!!(doc.lectura?.albaran && doc.pedido?.albaran && normDoc(doc.lectura.albaran) !== normDoc(doc.pedido.albaran))}
              />
            </div>
            {(doc.avisos || []).map((a, ai) => (
              <div key={ai} className="mt-1 text-[11px] text-amber-800">{a}</div>
            ))}
            <table className="w-full text-[11px] mt-2">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-2">Albarán</th>
                  <th className="py-1 pr-2">Artículo propuesto</th>
                  <th className="py-1 pr-2 text-right">Cant.</th>
                  <th className="py-1">Precio</th>
                </tr>
              </thead>
              <tbody>
                {(doc.propuestas || []).map((p, pi) => (
                  <tr key={pi} className="border-t border-slate-100 align-top">
                    <td className="py-1 pr-2">
                      {p.descripcion}
                      {p.codigoProveedor ? <div className="text-slate-400">cód. proveedor {p.codigoProveedor}</div> : null}
                    </td>
                    <td className="py-1 pr-2">
                      {p.articulo ? (
                        <>
                          <span className="font-mono">{p.articulo.numero}</span> {p.articulo.descripcion}
                          {p.elegido ? (
                            <div className="flex items-center gap-1 text-indigo-700">
                              <span>Elegido por ti</span>
                              <button
                                type="button"
                                title="Buscar otro artículo"
                                onClick={() => setBusca(busca === `${i}-${pi}` ? null : `${i}-${pi}`)}
                                className="text-slate-500 hover:text-indigo-700"
                              >
                                <Search size={13} />
                              </button>
                            </div>
                          ) : null}
                          {p.elegido && busca === `${i}-${pi}` && (
                            <div className="mt-1">
                              <BuscadorArticulo
                                onElegir={(a) => {
                                  onElegir(i, pi, a);
                                  setBusca(null);
                                }}
                              />
                            </div>
                          )}
                          {p.enPedido ? <div className="text-emerald-700">Ya está en el pedido{p.enPedido.recibida > 0 ? ` · recibida ${fmtCant(p.enPedido.recibida)}` : ""}{p.enPedido.precio != null ? ` · ${fmtEur(p.enPedido.precio)}` : ""}</div> : null}
                        </>
                      ) : (
                        <div>
                          <div className="flex items-center gap-1 text-amber-700">
                            <span>No encuentro un artículo claro</span>
                            <button
                              type="button"
                              title="Buscar artículo"
                              onClick={() => setBusca(busca === `${i}-${pi}` ? null : `${i}-${pi}`)}
                              className="text-slate-500 hover:text-indigo-700"
                            >
                              <Search size={13} />
                            </button>
                            <button
                              type="button"
                              title="Crear artículo"
                              disabled={creandoArticulo === `${i}-${pi}`}
                              onClick={() => setAltaClave((c) => (c === `${i}-${pi}` ? null : `${i}-${pi}`))}
                              className="text-slate-500 hover:text-indigo-700 disabled:opacity-40"
                            >
                              <Plus size={13} />
                            </button>
                          </div>
                          {altaClave === `${i}-${pi}` && (
                            <FormAltaArticulo
                              descripcionInicial={p.descripcion || ""}
                              ocupado={creandoArticulo === `${i}-${pi}`}
                              onCancelar={() => setAltaClave(null)}
                              onCrear={(datos) => onCrearArticulo(i, pi, datos)}
                            />
                          )}
                          {busca === `${i}-${pi}` && (
                            <div className="mt-1">
                              <BuscadorArticulo
                                onElegir={(a) => {
                                  onElegir(i, pi, a);
                                  setBusca(null);
                                }}
                              />
                            </div>
                          )}
                          {(p.alternativas || []).map((a) => (
                            <div key={a.numero} className="mt-1.5 border-t border-slate-100 pt-1">
                              <div><span className="font-mono">{a.numero}</span> {a.descripcion}</div>
                              <button
                                type="button"
                                onClick={() => onElegir(i, pi, a)}
                                className="text-indigo-700 font-semibold hover:underline"
                              >
                                Usar este
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {p.articulo && (p.alternativas || []).length > 0 && (
                        <div className="text-slate-400">Otras: {p.alternativas.map((a) => a.numero).join(", ")}</div>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right">{fmtCant(p.cantidad)}</td>
                    <td className="py-1">{textoPrecioPreparar(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {doc.resultado ? (
              <div className="mt-2 text-[12px] text-emerald-800">
                {doc.resultado.numero ? `Pedido ${doc.resultado.numero}. ` : ""}
                {(doc.resultado.avisos || []).join(" ")}
                {(doc.resultado.lineas || []).map((l, li) => (
                  <div key={li} className={l.ok ? "text-emerald-700" : "text-red-600"}>
                    {l.ok ? `Línea ${l.codigo} creada` : `${l.codigo}: ${l.error}`}
                    {l.aviso ? ` · ${l.aviso}` : ""}
                  </div>
                ))}
                {doc.resultado.adjunto ? (
                  <div className={doc.resultado.adjunto.ok ? "text-emerald-700" : "text-amber-700"}>
                    {doc.resultado.adjunto.ok
                      ? "PDF adjuntado al pedido en Business Central."
                      : `PDF no adjuntado: ${doc.resultado.adjunto.error || "error"}`}
                  </div>
                ) : null}
                {doc.resultado.numero ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <a
                      href={doc.resultado.enlace || `/api/recepcion/enlace-pedido?n=${encodeURIComponent(doc.resultado.numero)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-3 py-1.5"
                    >
                      Abrir pedido creado
                    </a>
                    {docs.length > 1 && idx < docs.length - 1 && (
                      <button
                        type="button"
                        onClick={() => onDocActivo(idx + 1)}
                        className="inline-flex items-center gap-1 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded px-3 py-1.5"
                      >
                        Seguir con el siguiente albarán
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            {doc.accion === "crear" && (
              <button
                onClick={() => onCrear(i)}
                disabled={creando || !doc.ot || !doc.proveedor || !falta.length}
                className="mt-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded px-3 py-1.5"
              >
                {creando ? "Creando…" : "Crear este pedido"}
              </button>
            )}
            {doc.accion === "anadir" && (
              <button
                onClick={() => onCrear(i)}
                disabled={creando || !doc.ot || !falta.length}
                className="mt-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded px-3 py-1.5"
              >
                {creando ? "Añadiendo…" : `Añadir ${falta.length} línea(s) al pedido`}
              </button>
            )}
            {doc.accion === "ninguna" && doc.pedido && !doc.resultado && (
              <div className="mt-2 text-[12px] text-emerald-700">No se crea otro pedido: las líneas del albarán ya están en {doc.pedido.numero}.</div>
            )}
            {docs.length > 1 && idx < docs.length - 1 && (doc.resultado || doc.accion === "ninguna") && (
              <button
                type="button"
                onClick={() => onDocActivo(idx + 1)}
                className="mt-2 text-sm font-semibold text-indigo-700 border border-indigo-300 bg-white hover:bg-indigo-50 rounded px-3 py-1.5"
              >
                Seguir con el albarán {idx + 2}
              </button>
            )}
          </div>
        );
      })()}
      </div>
      </div>
      )}
    </div>
  );
}

export default function Recepcion({ pedidos, lineas, onActualizarBC, actualizando, documentoEntrante = null }) {
  const [recep, setRecep] = useState({ revisados: {}, fechas: {}, reclamados: {}, emailsProveedor: {}, notas: {} });
  const [abiertos, setAbiertos] = useState(() => new Set()); // pedidos con el detalle de líneas desplegado
  const [verTodasLineas, setVerTodasLineas] = useState(false); // detalle: también las líneas ya recibidas
  const [reclamo, setReclamo] = useState(null); // { proveedor, provNum, inicial: [nums] } | null
  const [fReclamo, setFReclamo] = useState(""); // "" | "si" | "no"
  const [avisoEnvio, setAvisoEnvio] = useState(null);
  const [consultaResp, setConsultaResp] = useState(null);
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
  const [ordenTabla, setOrdenTabla] = useState(null); // { col, dir: "asc"|"desc" } | null = prioridad + importe
  const [cantReg, setCantReg] = useState({}); // "pedido|lineNo" → cantidad a recibir escrita a mano
  const [registroUi, setRegistroUi] = useState(null); // { num, fase: "confirmar"|"registrando"|"error", error }
  const [recibidoLocal, setRecibidoLocal] = useState({}); // pedido → { lineNo → ud ya recibidas en esta sesión }

  // "Subir Documento" — PDF con muchas páginas y muchos pedidos/proveedores.
  // Se lee, se agrupa por entrega (Nº de pedido + Nº de albarán; el mismo
  // proveedor con varios albaranes no se junta) y se cruzan las líneas de material
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
  const inputPrepararRef = useRef(null);
  const [preparando, setPreparando] = useState(false);
  const [panelPreparar, setPanelPreparar] = useState(null);
  const [otPreparar, setOtPreparar] = useState("");
  const [docActivoPreparar, setDocActivoPreparar] = useState(0);
  const [creandoPreparar, setCreandoPreparar] = useState(false);
  const [creandoArticulo, setCreandoArticulo] = useState(null);

  const numerosPedidoConocidos = useMemo(() => {
    if (!pedidos?.headers?.length) return new Set();
    const m = recepMapFor(pedidos.headers);
    return new Set((pedidos.rows || []).map((r) => String(r[m.numero] || "").trim().toUpperCase()).filter(Boolean));
  }, [pedidos]);

  // Líneas devueltas por /api/recepcion/extraer → estado de revisión
  const mapearLineas = (lineasEmparejadas, prefijo, disponibles) => {
    const leidas = (lineasEmparejadas || []).map((l, j) => ({
      id: `${prefijo}-${j}`,
      descripcionAlbaran: l.descripcionAlbaran,
      cantidadAlbaran: l.cantidadAlbaran,
      precioAlbaran: l.precioAlbaran ?? null,
      descuentoAlbaran: l.descuentoAlbaran ?? null,
      lineaBC: l.lineaBC,
      coincidencia: l.coincidencia,
      cantidadARegistrar: l.cantidadARegistrar,
      cantidadPedidoEdit: l.lineaBC ? l.lineaBC.cantidadPedida : "",
      precioEdit: l.lineaBC && l.lineaBC.precio != null ? l.lineaBC.precio : "",
      incluir: l.coincidencia !== "sin_match",
    }));
    const usadas = new Set(leidas.map((l) => l.lineaBC?.id).filter(Boolean));
    const resto = (disponibles || [])
      .filter((lb) => lb?.id && !usadas.has(lb.id) && Number(lb.cantidadPedida) > 0)
      .map((lb, j) => ({
        id: `${prefijo}-bc-${j}`,
        descripcionAlbaran: "",
        cantidadAlbaran: "",
        precioAlbaran: null,
        descuentoAlbaran: null,
        lineaBC: lb,
        coincidencia: "pedido",
        cantidadARegistrar: 0,
        cantidadPedidoEdit: lb.cantidadPedida,
        precioEdit: lb.precio != null ? lb.precio : "",
        incluir: false,
        soloPedido: true,
      }));
    return [...leidas, ...resto];
  };

  const [cargosProd, setCargosProd] = useState(CARGOS_PROD_RESPALDO);
  useEffect(() => {
    fetch("/api/bc/cargos").then((r) => r.json()).then((d) => { if (d?.cargos?.length) setCargosProd(d.cargos); }).catch(() => {});
  }, []);
  const ultimoArchivoRef = useRef(null); // el PDF completo, para «Volver a cargar documento»
  const ultimoPdfRef = useRef(null); // { nombre, base64 } cuando el PDF llega desde Validación de facturas
  const procesarPdfRef = useRef(null);
  const genPdfRef = useRef(0);
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
    const pdf = ultimoPdfRef.current;
    if (!file && !pdf?.base64) return;
    const nombre = file?.name || pdf?.nombre || "documento.pdf";
    if (!window.confirm(`¿Volver a leer «${nombre}» entero? Se perderá lo que hayas corregido en los pedidos aún sin confirmar (los ya subidos a BC no se tocan).`)) return;
    if (file) await procesarArchivo(file);
    else await procesarPdf(pdf);
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
      const claveAlb = (a) => String(a || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const mismoPedido = (x) => (x.pedido || "").toUpperCase() === (g.pedido || "").toUpperCase();
      const n = gs.find((x) => mismoPedido(x) && claveAlb(x.albaran) === claveAlb(g.albaran))
        || gs.find((x) => mismoPedido(x))
        || gs[0];
      if (!n) throw new Error("La IA no ha devuelto nada al releer estas páginas.");
      setPanelDoc((prev) => {
        const ya = new Set(prev.gruposId.map((x) => `${(x.pedido || "").toUpperCase()}|${claveAlb(x.albaran)}`));
        const nuevos = gs
          .filter((x) => x !== n && !ya.has(`${(x.pedido || "").toUpperCase()}|${claveAlb(x.albaran)}`))
          .map((x, k) => grupoDesdeExtraccion(x, `r${Date.now()}-${k}`));
        const gruposId = prev.gruposId.map((x, i) => (
          i !== idx
            ? x
            : {
                ...x,
                pedido: n.pedido || "",
                oferta: n.oferta || null,
                ofertaAviso: n.ofertaAviso || null,
                albaran: n.albaran || "",
                vendorName: n.vendorName || x.vendorName,
                departamento: n.departamento || x.departamento || "",
                ot: n.ot || x.ot || "",
                bcError: n.bcError || null,
                lineasDisponiblesBC: n.lineasDisponiblesBC || [],
                lineas: mapearLineas(n.lineasEmparejadas, `${x.id}-r${Date.now()}`, n.lineasDisponiblesBC),
                lineasPdf: n.lineas || [],
              }
        ));
        if (nuevos.length) gruposId.splice(idx + 1, 0, ...nuevos);
        return { ...prev, gruposId };
      });
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
                pedido: json.pedido || (json.oferta ? "" : x.pedido),
                oferta: json.oferta ?? x.oferta ?? null,
                ofertaAviso: json.ofertaAviso || null,
                vendorName: json.pedido ? (json.vendorName || null) : x.vendorName,
                departamento: json.pedido ? (json.departamento || "") : x.departamento,
                ot: json.pedido ? (json.ot || "") : x.ot,
                bcError: json.bcError || null,
                lineasDisponiblesBC: json.pedido ? (json.lineasDisponiblesBC || []) : x.lineasDisponiblesBC,
                lineasPdf,
                lineas: json.pedido ? mapearLineas(json.lineasEmparejadas, `${x.id}-m${Date.now()}`, json.lineasDisponiblesBC) : x.lineas,
              }
        ),
      }));
    } catch (err) {
      setErrorDoc(`Al cargar el pedido: ${err.message || String(err)}`);
    }
    setCruzando(null);
  };

  const grupoDesdeExtraccion = (g, id) => ({
    id,
    pedido: g.pedido || "",
    oferta: g.oferta || null,
    ofertaAviso: g.ofertaAviso || null,
    albaran: g.albaran || "",
    paginas: g.paginas || [],
    pdfBase64: g.pdfBase64 || null,
    pdfVista: g.pdfVista || null,
    vendorName: g.vendorName || null,
    departamento: g.departamento || "",
    ot: g.ot || "",
    bcError: g.bcError || null,
    incluir: !!g.pedido,
    lineasDisponiblesBC: g.lineasDisponiblesBC || [],
    nuevasLineas: [],
    lineas: mapearLineas(g.lineasEmparejadas, id, g.lineasDisponiblesBC),
    lineasPdf: g.lineas || [],
    albaranPartido: !!g.albaranPartido,
  });

  const procesarPdf = async ({ nombre, base64 }) => {
    const gen = ++genPdfRef.current;
    ultimoPdfRef.current = { nombre, base64 };
    setSubiendoDoc(true);
    setErrorDoc(null);
    setPanelDoc(null);
    setSubidaBC({});
    setIndiceActual(0);
    try {
      const r = await fetch("/api/recepcion/extraer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre, base64 }),
      });
      // Registros hechos desde la app (compartidos) — frescos, por si otro equipo ha registrado
      let registrados = {};
      try { registrados = (await (await fetch("/api/recepcion")).json()).registrados || {}; } catch {}
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      const grupos = (json.grupos || []).map((g, i) => grupoDesdeExtraccion(g, `${i}-${g.pedido || "sin-pedido"}`));
      const esRevision = (g) => !!(g.pedido || g.albaran || (g.lineasPdf && g.lineasPdf.length));
      const panel = {
        archivo: nombre,
        paginasTotal: json.paginas,
        // Los ya recibidos/registrados se apartan (se pueden volver a mostrar).
        // Un albarán separado sin Nº de pedido también se revisa: el pedido
        // se escribe a mano, no se hereda del proveedor anterior.
        gruposId: grupos.filter((g) => esRevision(g) && !motivoYaRecibido(g, registrados)),
        gruposYaRecibidos: grupos.filter((g) => g.pedido && motivoYaRecibido(g, registrados)).map((g) => ({ ...g, motivo: motivoYaRecibido(g, registrados) })),
        gruposSinId: grupos.filter((g) => !esRevision(g)),
        avisos: json.avisos || [], // páginas que la IA no pudo leer (el resto sí)
      };
      if (gen !== genPdfRef.current) return panel;
      setPanelDoc(panel);
      return panel;
    } catch (err) {
      if (gen === genPdfRef.current) setErrorDoc(err.message || String(err));
      return null;
    } finally {
      if (gen === genPdfRef.current) setSubiendoDoc(false);
    }
  };
  procesarPdfRef.current = procesarPdf;

  const procesarArchivo = async (file) => {
    ultimoArchivoRef.current = file;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await procesarPdf({ nombre: file.name, base64 });
  };

  const leerPreparar = async (file) => {
    setPreparando(true);
    setErrorDoc(null);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "").split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch("/api/recepcion/preparar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: file.name, base64, ot: otPreparar || undefined }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      const docs = json.documentos || [];
      const otLeida = docs[0]?.ot?.codigo || docs[0]?.lectura?.ot || "";
      if (otLeida && !otPreparar) setOtPreparar(otLeida);
      setDocActivoPreparar(0);
      setPanelPreparar({ archivo: file.name, documentos: docs, pdfVista: json.pdfVista || null });
    } catch (err) {
      setErrorDoc(err.message || String(err));
    } finally {
      setPreparando(false);
    }
  };

  const buscarPrepararConOt = async () => {
    if (!panelPreparar?.documentos?.length) return;
    setPreparando(true);
    setErrorDoc(null);
    try {
      const r = await fetch("/api/recepcion/preparar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecturas: panelPreparar.documentos.map((d) => d.lectura), ot: otPreparar }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
      setPanelPreparar((prev) => ({ ...prev, pdfVista: prev.pdfVista, documentos: json.documentos || [] }));
    } catch (err) {
      setErrorDoc(err.message || String(err));
    } finally {
      setPreparando(false);
    }
  };

  const accionPrepararDoc = (d, propuestas) => {
    const conArticulo = (propuestas || d.propuestas || []).filter((p) => p.articulo);
    if (!conArticulo.length) return "ninguna";
    if (d.pedido?.numero) return conArticulo.some((p) => !p.enPedido) ? "anadir" : "ninguna";
    return d.proveedor?.numero ? "crear" : "ninguna";
  };

  const cambiarDatoPreparar = (indice, campo, valor) => {
    if (campo === "ot") setOtPreparar(String(valor ?? "").trim());
    setPanelPreparar((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        documentos: (prev.documentos || []).map((d, i) => {
          if (i !== indice) return d;
          const lectura = { ...(d.lectura || {}) };
          const proveedor = { ...(d.proveedor || {}) };
          const otObj = { ...(d.ot || {}) };
          let pedido = d.pedido ? { ...d.pedido } : null;
          let propuestas = d.propuestas;
          if (campo === "proveedorElegido") {
            const p = valor && typeof valor === "object" ? valor : null;
            if (p) {
              proveedor.nombre = String(p.nombre || "").trim();
              proveedor.numero = String(p.numero || "").trim();
              proveedor.cif = String(p.cif || p.numero || "").trim();
              lectura.proveedor = proveedor.nombre;
              if (pedido) pedido.vendorNumber = proveedor.numero;
            }
          } else {
            const v = String(valor ?? "");
            if (campo === "proveedorNombre") {
              proveedor.nombre = v;
              lectura.proveedor = v;
            } else if (campo === "proveedorNumero") {
              proveedor.numero = v.trim();
              proveedor.cif = v.trim();
              if (pedido) pedido.vendorNumber = v.trim();
            } else if (campo === "albaran") {
              lectura.albaran = v.trim();
            } else if (campo === "fecha") {
              lectura.fecha = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : (v ? lectura.fecha : null);
            } else if (campo === "ot") {
              const codigo = v.trim();
              otObj.codigo = codigo;
              lectura.ot = codigo || null;
            } else if (campo === "departamento") {
              otObj.departamento = v.trim();
              if (pedido) pedido.departamento = v.trim();
            } else if (campo === "cliente") {
              otObj.cliente = v;
            } else if (campo === "pedido") {
              const numero = v.trim().toUpperCase();
              if (!numero) {
                pedido = null;
                propuestas = (d.propuestas || []).map((p) => ({ ...p, enPedido: null }));
              } else if (pedido) pedido = { ...pedido, numero, estado: pedido.numero === numero ? pedido.estado : "" };
              else pedido = { numero, estado: "", vendorNumber: proveedor.numero || "", fecha: null, albaran: "", departamento: otObj.departamento || "" };
            }
          }
          const next = {
            ...d,
            lectura,
            proveedor: (proveedor.numero != null || proveedor.nombre) ? proveedor : d.proveedor,
            ot: (otObj.codigo || otObj.departamento || otObj.cliente) ? otObj : (campo === "ot" && !String(valor ?? "").trim() ? null : d.ot),
            pedido,
            propuestas,
          };
          next.accion = accionPrepararDoc(next);
          return next;
        }),
      };
    });
  };

  const elegirArticuloPreparar = (indice, linea, articulo) => {
    if (!articulo?.numero) return;
    setPanelPreparar((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        documentos: (prev.documentos || []).map((d, i) => {
          if (i !== indice) return d;
          const propuestas = (d.propuestas || []).map((p, pi) => (
            pi === linea
              ? { ...p, articulo: { numero: articulo.numero, descripcion: articulo.descripcion || "" }, elegido: true, enPedido: null }
              : p
          ));
          return { ...d, propuestas, accion: accionPrepararDoc({ ...d, propuestas }, propuestas) };
        }),
      };
    });
  };

  const crearArticuloPreparar = async (indice, linea, datos) => {
    const doc = panelPreparar?.documentos?.[indice];
    const p = doc?.propuestas?.[linea];
    if (!p || p.articulo || !datos) return;
    const texto = String(datos.descripcion || "").trim();
    if (!texto || !datos.cat1 || !datos.cat2 || !datos.cat3) {
      throw new Error("Faltan la descripción o las tres familias.");
    }
    if (!window.confirm(`¿Crear el artículo «${texto}»? Unidad UD. La línea del pedido no se escribe hasta que pulses Añadir.`)) return;
    setCreandoArticulo(`${indice}-${linea}`);
    setErrorDoc(null);
    try {
      const r = await fetch("/api/recepcion/preparar/articulo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descripcion: texto,
          codigoProveedor: p.codigoProveedor || null,
          cat1: datos.cat1,
          cat2: datos.cat2,
          cat3: datos.cat3,
          imagenBase64: datos.imagen || null,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      elegirArticuloPreparar(indice, linea, { numero: json.numero, descripcion: json.descripcion || texto });
    } catch (err) {
      setErrorDoc(err.message || String(err));
      throw err;
    } finally {
      setCreandoArticulo(null);
    }
  };

  const crearPreparar = async (indice) => {
    const doc = panelPreparar?.documentos?.[indice];
    if (!doc) return;
    const lineas = (doc.propuestas || []).filter((p) => p.articulo && !p.enPedido).map((p) => ({
      codigo: p.articulo.numero,
      descripcion: p.articulo.descripcion,
      cantidad: p.cantidad,
      precio: p.precio,
      descuento: p.descuento,
    }));
    if (!lineas.length) return;
    const verbo = doc.accion === "anadir" ? `añadir ${lineas.length} línea(s) al pedido ${doc.pedido?.numero}` : "crear el pedido de compra";
    if (!window.confirm(`¿${verbo.charAt(0).toUpperCase()}${verbo.slice(1)} en Business Central para ${doc.proveedor?.nombre || "el proveedor"}, OT ${doc.ot?.codigo}?`)) return;
    setCreandoPreparar(true);
    setErrorDoc(null);
    try {
      const r = await fetch("/api/recepcion/preparar/crear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorNumber: doc.proveedor?.numero || doc.pedido?.vendorNumber,
          ot: doc.ot?.codigo,
          departamento: doc.ot?.departamento || null,
          fecha: doc.lectura?.fecha,
          albaran: doc.accion === "crear" ? doc.lectura?.albaran : null,
          pedidoExistente: doc.accion === "anadir" ? doc.pedido?.numero : null,
          pdfVista: doc.pdfVista || panelPreparar.pdfVista || null,
          nombreArchivo: panelPreparar.archivo || (doc.lectura?.albaran ? `Albaran_${doc.lectura.albaran}.pdf` : "albaran.pdf"),
          lineas,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      const todasOk = !json.lineas?.length || json.lineas.every((l) => l.ok);
      setPanelPreparar((prev) => {
        const documentos = prev.documentos.map((d, i) => (i === indice ? { ...d, resultado: json, accion: todasOk ? "ninguna" : d.accion } : d));
        if (todasOk) {
          const siguiente = documentos.findIndex((d, i) => i > indice && !(d.resultado && d.accion === "ninguna"));
          if (siguiente >= 0) setDocActivoPreparar(siguiente);
        }
        return { ...prev, documentos };
      });
    } catch (err) {
      setErrorDoc(err.message || String(err));
    } finally {
      setCreandoPreparar(false);
    }
  };

  useEffect(() => {
    const doc = documentoEntrante;
    if (!doc?.id || !doc.base64) return;
    let vivo = true;
    ultimoArchivoRef.current = null;
    const pdf = { nombre: doc.nombre || "documento.pdf", base64: doc.base64 };
    ultimoPdfRef.current = pdf;
    if (extraccionDesdeFactura.id !== doc.id || !extraccionDesdeFactura.promesa) {
      extraccionDesdeFactura.id = doc.id;
      extraccionDesdeFactura.pdf = pdf;
      extraccionDesdeFactura.promesa = procesarPdfRef.current(pdf);
    } else {
      setSubiendoDoc(true);
      setErrorDoc(null);
      extraccionDesdeFactura.promesa.then((panel) => {
        if (!vivo) return;
        if (panel) setPanelDoc(panel);
        setSubiendoDoc(false);
      });
    }
    return () => { vivo = false; };
  }, [documentoEntrante]);

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
            return {
              ...l,
              lineaBC: elegida || null,
              coincidencia: elegida ? "manual" : "sin_match",
              incluir: !!elegida,
              cantidadARegistrar,
              cantidadPedidoEdit: elegida ? elegida.cantidadPedida : "",
              precioEdit: elegida && elegida.precio != null ? elegida.precio : "",
            };
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
      const { ajustes, errores } = ajustesPedidoDe(g);
      if (errores.length) {
        setSubidaBC((prev) => ({ ...prev, [g.id]: { subiendo: false, error: errores[0] } }));
        return;
      }
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
          ajustesPedido: ajustes,
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
      const okAjustes = new Map((json.ajustesPedido || []).filter((a) => a.ok && !a.sinCambio).map((a) => [a.lineaId, a]));
      if (Object.keys(creadas).length || okAjustes.size) {
        setPanelDoc((prev) => ({
          ...prev,
          gruposId: prev.gruposId.map((x, i) => {
            if (i !== idx) return x;
            const aplicar = (lb) => {
              const a = lb && okAjustes.get(lb.id);
              if (!a) return lb;
              const cantidadPedida = a.cantidad != null ? a.cantidad : lb.cantidadPedida;
              const precio = a.precio != null ? a.precio : lb.precio;
              const cantidadRecibida = Number(lb.cantidadRecibida) || 0;
              return { ...lb, cantidadPedida, precio, cantidadPendiente: Math.max(0, cantidadPedida - cantidadRecibida) };
            };
            return {
              ...x,
              lineasDisponiblesBC: (x.lineasDisponiblesBC || []).map(aplicar),
              nuevasLineas: x.nuevasLineas.map((n) => (creadas[n.id] ? { ...n, creadaId: creadas[n.id] } : n)),
              lineas: x.lineas.map((l) => {
                const lb = aplicar(l.lineaBC);
                if (!lb || lb === l.lineaBC) return l;
                return { ...l, lineaBC: lb, cantidadPedidoEdit: lb.cantidadPedida, precioEdit: lb.precio ?? "" };
              }),
            };
          }),
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

  const lineasParaDatos = useMemo(() => {
    if (!lineas?.headers?.length || !Object.keys(recibidoLocal).length) return lineas;
    const lc = colsLineas(lineas.headers);
    if (!lc.doc || !lc.pend) return lineas;
    const rows = lineas.rows.map((r) => {
      const doc = String(r[lc.doc] || "").trim().toUpperCase();
      const extra = recibidoLocal[doc];
      if (!extra) return r;
      const ln = lc.lineNo ? String(Number(r[lc.lineNo]) || 0) : "";
      const qty = Number(extra[ln]);
      if (!(qty > 0)) return r;
      const pend = parseNum(r[lc.pend]);
      const next = { ...r, [lc.pend]: Math.max(0, (Number.isFinite(pend) ? pend : 0) - qty) };
      if (lc.recib) {
        const rec = parseNum(r[lc.recib]);
        next[lc.recib] = (Number.isFinite(rec) ? rec : 0) + qty;
      }
      return next;
    });
    return { ...lineas, rows };
  }, [lineas, recibidoLocal]);

  const datos = useMemo(() => getRecepData(pedidos, lineasParaDatos, recep.fechas), [pedidos, lineasParaDatos, recep.fechas]);

  const fichaPedido = (num) => {
    const n = String(num || "").trim().toUpperCase();
    if (!n || !datos) return null;
    return [...(datos.pendientes || []), ...(datos.excluidos || [])].find((p) => String(p.num || "").toUpperCase() === n) || null;
  };

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

  const pulsarOrden = (col) => {
    setOrdenTabla((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  };

  const cantARegistrar = (num, l) => {
    const k = `${num}|${l.lineNo}`;
    if (Object.prototype.hasOwnProperty.call(cantReg, k)) return cantReg[k];
    return l.pend > 0 ? String(l.pend) : "";
  };

  const registrarPedidoTabla = async (p) => {
    const lineasEnvio = (p.lineas || [])
      .filter((l) => l.pend > 0 && l.lineNo)
      .map((l) => ({ lineNo: l.lineNo, cantidad: Number(String(cantARegistrar(p.num, l)).replace(",", ".")) }))
      .filter((l) => l.cantidad > 0);
    if (!lineasEnvio.length) {
      setRegistroUi({ num: p.num, fase: "error", error: "Indica una cantidad mayor que 0 en alguna línea pendiente." });
      return;
    }
    setRegistroUi({ num: p.num, fase: "registrando" });
    try {
      const r = await fetch("/api/recepcion/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: p.num, lineas: lineasEnvio }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || j.detalle || `Error ${r.status}`);
      const doc = p.num.toUpperCase();
      setRecibidoLocal((prev) => {
        const actual = { ...(prev[doc] || {}) };
        for (const l of j.lineas || lineasEnvio) {
          const k = String(Number(l.lineNo) || 0);
          actual[k] = (Number(actual[k]) || 0) + Number(l.cantidad);
        }
        return { ...prev, [doc]: actual };
      });
      setCantReg((prev) => {
        const next = { ...prev };
        for (const l of p.lineas || []) delete next[`${p.num}|${l.lineNo}`];
        return next;
      });
      const uds = (j.lineas || lineasEnvio).reduce((a, l) => a + (Number(l.cantidad) || 0), 0);
      setRegistroUi(null);
      setAvisoEnvio(`✓ Recepción registrada en BC: ${p.num} · ${fmtCant(uds)} ud. No se ha creado la factura.`);
    } catch (e) {
      setRegistroUi({ num: p.num, fase: "error", error: e.message || String(e) });
    }
  };

  const filasTabla = useMemo(() => {
    if (!ordenTabla) return filtradas;
    const { col, dir } = ordenTabla;
    return [...filtradas].sort((a, b) => {
      return compararOrden(valorOrdenRecepcion(a, col, recep), valorOrdenRecepcion(b, col, recep), dir);
    });
  }, [filtradas, ordenTabla, recep]);

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

  const abrirConsultaResponsable = (g) => {
    const ficha = fichaPedido(g.pedido);
    setConsultaResp({
      pedido: g.pedido || "",
      albaran: g.albaran || "",
      proveedor: g.vendorName || ficha?.prov || "",
      departamento: g.departamento || ficha?.depto || "",
      ot: g.ot || ficha?.ot || "",
      pdfBase64: g.pdfBase64 || "",
      lineas: lineasParaConsulta(g),
    });
  };

  const onConsultaResponsableEnviada = async ({ pedido, para, depto }) => {
    setConsultaResp(null);
    const quien = depto ? `${depto}: ${para}` : para;
    setAvisoEnvio(`✓ Pregunta enviada al responsable (${quien})`);
    if (!pedido) return;
    const texto = `Preguntado al responsable${depto ? ` de ${depto}` : ""} si el pedido ${pedido} es correcto y a qué OT corresponde. Enviado a ${para}`;
    await fetch("/api/recepcion/nota", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pedido, texto, autor: "📧 Correo" }),
    }).catch(() => {});
    const d = await fetch("/api/recepcion").then((x) => x.json()).catch(() => null);
    if (d?.notas) setRecep((prev) => ({ ...prev, notas: d.notas }));
  };

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
        <div className="flex flex-wrap items-center justify-end gap-2">
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
          <button
            onClick={() => inputPrepararRef.current?.click()}
            disabled={preparando}
            title="Lee el albarán, busca el pedido de ese proveedor y esa OT, y propone artículos, cantidades, precios y descuentos. No escribe nada hasta que confirmes."
            className="flex items-center gap-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <Search size={15} className={preparando ? "animate-pulse" : ""} /> {preparando ? "Preparando…" : "Preparar pedido"}
          </button>
          <input
            ref={inputPrepararRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) leerPreparar(file);
            }}
          />
        </div>
      </div>

      {errorDoc && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          Error leyendo el documento: {errorDoc}
        </div>
      )}

      {panelPreparar && (
        <PanelPrepararPedido
          panel={panelPreparar}
          ot={otPreparar}
          onOt={setOtPreparar}
          onBuscar={buscarPrepararConOt}
          buscando={preparando}
          onCrear={crearPreparar}
          creando={creandoPreparar}
          onElegir={elegirArticuloPreparar}
          onCrearArticulo={crearArticuloPreparar}
          creandoArticulo={creandoArticulo}
          onCambiarDato={cambiarDatoPreparar}
          docActivo={docActivoPreparar}
          onDocActivo={setDocActivoPreparar}
          onCerrar={() => { setPanelPreparar(null); setDocActivoPreparar(0); }}
        />
      )}

      {panelDoc && (
        <div className="mt-4 bg-white border border-purple-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-700">
              «{panelDoc.archivo}» · {panelDoc.paginasTotal} página(s) · {panelDoc.gruposId.length} documento(s) por revisar
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
                      <div className="text-[11px] text-slate-500 mb-1 flex items-center justify-between gap-2">
                        <span>Páginas {g.paginas.join(", ")} del documento{g.vendorName ? ` · proveedor en BC: ${g.vendorName}` : ""}</span>
                        {g.pdfVista && (
                          <a
                            href={`/api/recepcion/vista.pdf?id=${encodeURIComponent(g.pdfVista)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-blue-700 hover:underline shrink-0"
                          >
                            Abrir PDF
                          </a>
                        )}
                      </div>
                      {g.pdfVista ? (
                        <iframe
                          key={g.pdfVista}
                          src={`/api/recepcion/vista.pdf?id=${encodeURIComponent(g.pdfVista)}`}
                          title={`pedido-${g.pedido || "albaran"}`}
                          className="w-full border border-slate-200 rounded-md bg-white"
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
                          title="Carga el pedido de BC y vuelve a cruzar las líneas. Acepta un PC (PC26-004152) o un Nº de oferta (OCAC26-004443)"
                        >
                          <RefreshCw size={12} className={cruzando === g.id ? "animate-spin" : ""} />
                          {cruzando === g.id ? "Cargando…" : "Cargar pedido"}
                        </button>
                        {g.pedido && !existe && <span title="No aparece en la lista de pedidos cargada — revisar" className="text-amber-600 text-[11px]">⚠ no está en la lista</span>}
                        {!g.pedido && !g.oferta && <span className="text-amber-700 text-[11px]">Albarán aparte: escribe su Nº de pedido o de oferta (OCAC…) y pulsa Cargar pedido</span>}
                      </div>
                      {(() => {
                        const claveAlb = (a) => String(a || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                        const hermanos = g.albaran
                          ? panelDoc.gruposId.filter((x) => claveAlb(x.albaran) && claveAlb(x.albaran) === claveAlb(g.albaran))
                          : [];
                        if (hermanos.length < 2) return null;
                        const cual = g.pedido ? `las de ${g.pedido}` : "las que no tienen Nº de pedido";
                        return (
                          <div className="text-[11px] text-slate-600 mb-2 pl-[5.5rem]">
                            Este albarán {g.albaran} está repartido en {hermanos.length} pedidos. Aquí solo van {cual}. Cada pedido se confirma y se sube a BC por separado.
                            {!g.pedido && " Estas líneas no traían PC: escríbelo y pulsa Cargar pedido."}
                          </div>
                        );
                      })()}
                      {(g.oferta || g.ofertaAviso) && (
                        <div className="text-[11px] mb-2 pl-[5.5rem]">
                          {g.oferta && (
                            <div className={g.pedido ? "text-slate-600" : "text-amber-800"}>
                              Nº oferta {g.oferta}{g.pedido ? ` · pedido ${g.pedido}` : ""}
                            </div>
                          )}
                          {g.ofertaAviso && <div className="text-amber-700">{g.ofertaAviso}</div>}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mb-1">
                        <label className="text-xs font-semibold text-slate-500 w-20">Nº albarán</label>
                        <input
                          value={g.albaran}
                          onChange={(e) => editarGrupo(indiceActual, "albaran", e.target.value)}
                          placeholder="—"
                          className="border border-slate-300 rounded px-2 py-1 text-sm w-40"
                        />
                      </div>
                      <div className="mb-3 pl-[5.5rem]">
                        <QuienHaRecogido
                          albaran={g.albaran || ""}
                          pedido={g.pedido || ""}
                          proveedor={g.vendorName || ""}
                          pdfVista={g.pdfVista || null}
                        />
                      </div>

                      {g.bcError && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
                          No se han podido cruzar las líneas de material con BC: {g.bcError}. Puedes subir igualmente el albarán y el adjunto; las cantidades las registrarás a mano.
                        </div>
                      )}

                      {g.lineas.length > 0 && (
                        <div className="mb-3">
                          <div className="text-xs font-semibold text-slate-500 mb-1">Líneas del pedido en BC, con lo leído en este albarán:</div>
                          <p className="text-[10px] text-slate-500 mb-1">
                            Salen todas las líneas del pedido. Las que este albarán no trae quedan con cantidad a registrar 0 y sin marcar. Puedes corregir la cantidad y el coste directo antes de confirmar: se guardan en BC al pulsar Confirmar, antes de recibir.
                          </p>
                          <table className="w-full text-[11px] border border-slate-200 rounded overflow-hidden">
                            <thead>
                              <tr className="bg-slate-50 text-slate-600 text-left">
                                <th className="px-1.5 py-1">Inc.</th>
                                <th className="px-1.5 py-1">Leído en el albarán</th>
                                <th className="px-1.5 py-1">Línea del pedido en BC</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad del pedido en Business Central. Si la cambias, se escribe en el pedido al confirmar, antes de recibir.">Cant. pedido (BC)</th>
                                <th className="px-1.5 py-1 text-right" title="Coste directo de la línea en BC (directUnitCost), antes del descuento. Si lo cambias, se escribe en el pedido al confirmar.">Coste directo</th>
                                <th className="px-1.5 py-1 text-right" title="Cantidad tal como la ha leído la IA en el PDF — revisa que coincida con el papel">Cant. leída (PDF)</th>
                                <th className="px-1.5 py-1">Cant. a registrar</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.lineas.map((l, li) => {
                                const discrepancia = !l.soloPedido && l.lineaBC && l.cantidadAlbaran !== "" && Number(l.cantidadAlbaran) !== Number(l.lineaBC.cantidadPedida);
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
                                  <td className="px-1.5 py-1">{l.soloPedido ? <span className="text-slate-400">— no está en este albarán —</span> : l.descripcionAlbaran}</td>
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
                                  <td className="px-1.5 py-1 text-right">
                                    {l.lineaBC ? (() => {
                                      const cantTxt = l.cantidadPedidoEdit !== undefined ? l.cantidadPedidoEdit : l.lineaBC.cantidadPedida;
                                      const cantNueva = Number(cantTxt);
                                      const cambiada = cantTxt !== "" && Number.isFinite(cantNueva) && Math.abs(cantNueva - (Number(l.lineaBC.cantidadPedida) || 0)) > 1e-6;
                                      const recibida = Number(l.lineaBC.cantidadRecibida) || 0;
                                      const pendiente = Number.isFinite(cantNueva) ? Math.max(0, cantNueva - recibida) : l.lineaBC.cantidadPendiente;
                                      return (
                                        <div>
                                          <input
                                            type="number"
                                            step="any"
                                            min={recibida || 0}
                                            value={cantTxt}
                                            onChange={(e) => editarLinea(indiceActual, li, "cantidadPedidoEdit", e.target.value)}
                                            title="Cantidad del pedido en BC. Se guarda al confirmar, antes de recibir."
                                            className={`border rounded w-20 px-1 py-0.5 text-right ${cambiada ? "border-amber-400 bg-amber-50" : "border-slate-300 bg-white"}`}
                                          />
                                          <div className="text-[10px] text-slate-400 mt-0.5">
                                            {recibida > 0 ? `recibida ${recibida} · ` : ""}
                                            pendiente {Number.isFinite(pendiente) ? pendiente : "—"}
                                            {cambiada ? " · se guarda al confirmar" : ""}
                                          </div>
                                        </div>
                                      );
                                    })() : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className="px-1.5 py-1 text-right">
                                    {l.lineaBC ? (() => {
                                      const precioTxt = l.precioEdit !== undefined ? l.precioEdit : (l.lineaBC.precio ?? "");
                                      const precioNueva = precioTxt === "" || precioTxt == null ? null : Number(precioTxt);
                                      const precioOrig = l.lineaBC.precio == null || l.lineaBC.precio === "" ? null : Number(l.lineaBC.precio);
                                      const cambiada = precioNueva != null && Number.isFinite(precioNueva) && (precioOrig == null || Math.abs(precioNueva - precioOrig) > 0.0001);
                                      return (
                                        <div>
                                          <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={precioTxt}
                                            onChange={(e) => editarLinea(indiceActual, li, "precioEdit", e.target.value)}
                                            placeholder="—"
                                            title="Coste directo de la línea en BC. Se guarda al confirmar, antes de recibir."
                                            className={`border rounded w-20 px-1 py-0.5 text-right ${cambiada ? "border-amber-400 bg-amber-50" : "border-slate-300 bg-white"}`}
                                          />
                                          {cambiada && <div className="text-[10px] text-amber-700 mt-0.5">se guarda al confirmar</div>}
                                        </div>
                                      );
                                    })() : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className={`px-1.5 py-1 text-right font-semibold ${discrepancia ? "text-red-600" : "text-slate-700"}`} title={discrepancia ? "No coincide con la cantidad del pedido en BC — revisa el papel" : ""}>
                                    {l.soloPedido || l.cantidadAlbaran === "" ? "—" : l.cantidadAlbaran}{discrepancia && " ⚠"}
                                  </td>
                                  <td className="px-1.5 py-1">
                                    <input
                                      type="number"
                                      value={l.cantidadARegistrar}
                                      disabled={!l.lineaBC}
                                      onChange={(e) => editarLinea(indiceActual, li, "cantidadARegistrar", Number(e.target.value))}
                                      className="border border-slate-300 rounded w-16 px-1 py-0.5"
                                    />
                                    {l.lineaBC && Number(l.cantidadARegistrar) > Number(l.cantidadPedidoEdit !== undefined ? l.cantidadPedidoEdit : l.lineaBC.cantidadPedida) + 1e-6 && (
                                      <div className="text-[10px] text-amber-700 mt-0.5 max-w-[9rem]">Supera la cantidad del pedido. Súbela o BC puede rechazar el exceso.</div>
                                    )}
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

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => confirmarGrupo(indiceActual)}
                          disabled={estado?.subiendo || !g.pedido}
                          className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-4 py-2"
                        >
                          {estado?.subiendo ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                          Confirmar y subir este pedido a BC
                        </button>
                        <button
                          onClick={() => confirmarGrupo(indiceActual, { registrar: false })}
                          disabled={estado?.subiendo || !g.pedido}
                          title="Sube el Nº de albarán, lo copia en Su/Ntra. ref., adjunta el PDF y rellena las cantidades a recibir, pero NO registra: lo registras tú después desde BC"
                          className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-4 py-2"
                        >
                          {estado?.subiendo ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
                          Subir este pedido en BC
                        </button>
                        <button
                          onClick={() => abrirConsultaResponsable(g)}
                          disabled={!g.pedido}
                          title="Abre un correo al responsable del departamento para preguntar si este pedido es correcto y a qué OT corresponde. No se envía hasta que lo confirmes."
                          className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700 border border-blue-300 bg-white hover:bg-blue-50 disabled:opacity-50 rounded-md px-4 py-2"
                        >
                          <Mail size={14} />
                          Preguntar al responsable
                        </button>
                      </div>

                      {estado?.resultado && (
                        <div className="mt-2 text-[11px] space-y-0.5">
                          <div className="text-slate-400">[{estado.resultado.version || "sin versión — server.cjs antiguo"}]</div>
                          <div className={estado.resultado.albaran.ok ? "text-emerald-700" : "text-amber-700"}>
                            {estado.resultado.albaran.ok ? "✓ Nº albarán actualizado" : `✗ Nº albarán: ${estado.resultado.albaran.error || "error"}`}
                          </div>
                          {estado.resultado.referencia && (
                            <div className={estado.resultado.referencia.ok ? "text-emerald-700" : "text-amber-700"}>
                              {estado.resultado.referencia.ok ? "✓ Su/Ntra. ref. actualizada con el Nº de albarán" : `✗ Su/Ntra. ref.: ${estado.resultado.referencia.error || "error"}`}
                            </div>
                          )}
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
                          {estado.resultado.reabierto && (
                            <div className={estado.resultado.relanzado === false ? "text-amber-700" : "text-slate-600"}>
                              {estado.resultado.relanzado === false
                                ? "El pedido estaba lanzado y se ha reabierto para guardar la cantidad. No se ha podido volver a lanzar."
                                : "El pedido estaba lanzado: se ha reabierto para guardar la cantidad y el coste, y se ha vuelto a lanzar."}
                            </div>
                          )}
                          {estado.resultado.avisoLanzado && estado.resultado.relanzado === false && (
                            <div className="text-amber-700">{estado.resultado.avisoLanzado}</div>
                          )}
                          {(estado.resultado.ajustesPedido || []).map((a, ai) => (
                            <div key={`aj${ai}`} className={a.ok ? "text-emerald-700" : "text-red-600"}>
                              {a.ok
                                ? `✓ Pedido actualizado antes de recibir${a.cantidad != null ? ` · cantidad ${a.cantidad}` : ""}${a.precio != null ? ` · coste directo ${a.precio}` : ""}${a.sinCambio ? " (ya estaba así)" : ""}`
                                : `✗ Cantidad o precio del pedido: ${a.error || "error"}`}
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

          {/* Tabla: anchos fijos para que quepan todas las columnas en la página */}
          <div className="mt-3 bg-white border border-slate-200 rounded-lg">
            <table className="w-full table-fixed text-[11px]">
              <colgroup>
                <col className="w-[2.2%]" />
                <col className="w-[8.2%]" />
                <col className="w-[4.2%]" />
                <col className="w-[5.6%]" />
                <col className="w-[6.6%]" />
                <col className="w-[3.2%]" />
                <col className="w-[12%]" />
                <col className="w-[5%]" />
                <col className="w-[5.4%]" />
                <col className="w-[8.4%]" />
                <col className="w-[3.2%]" />
                <col className="w-[6.6%]" />
                <col className="w-[6.6%]" />
                <col className="w-[5.6%]" />
                <col className="w-[5%]" />
                <col className="w-[3.4%]" />
                <col className="w-[3.4%]" />
                <col className="w-[3.4%]" />
                <col className="w-[2.6%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-left">
                  {[
                    ["✓", ""],
                    ["Pedido", "Pedido"],
                    ["Tipo", "Tipo"],
                    ["Fecha", "Fecha"],
                    ["Recepción prevista", "Recep. prev."],
                    ["Días", "Días"],
                    ["Proveedor", "Proveedor"],
                    ["Comprador", "Compr."],
                    ["Un. negocio", "Un. neg."],
                    ["OT", "OT"],
                    ["Alianza", "Alz."],
                    ["Importe", "Importe"],
                    ["Imp. pendiente", "Imp. pend."],
                    ["Prioridad", "Prio."],
                    ["Alertas", "Alertas"],
                    ["Revisado", "Rev."],
                    ["Notas", "Notas"],
                    ["Reclamado", "Recl."],
                    ["", ""],
                  ].map(([id, etiqueta]) => (
                    <th key={id || "accion"} className="px-1 py-1.5 font-semibold overflow-hidden">
                      {id && id !== "✓" ? (
                        <button
                          type="button"
                          onClick={() => pulsarOrden(id)}
                          title={`${etiqueta === id ? id : id}${ordenTabla?.col === id ? (ordenTabla.dir === "asc" ? " · ascendente, pulsa para invertir" : " · descendente, pulsa para el orden inicial") : " · ordenar"}`}
                          className="inline-flex max-w-full items-center gap-0.5 font-semibold hover:text-slate-900"
                        >
                          <span className="truncate">{etiqueta}</span>
                          {ordenTabla?.col === id && <span className="text-[9px] text-slate-400 shrink-0">{ordenTabla.dir === "asc" ? "▲" : "▼"}</span>}
                        </button>
                      ) : etiqueta}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filasTabla.map((p) => {
                  const rev = recep.revisados[p.num];
                  const rc = recep.reclamados[p.num];
                  const notasP = recep.notas[p.num] || [];
                  const ultNota = notasP[notasP.length - 1];
                  const abierto = abiertos.has(p.num);
                  const lineasVer = p.lineas.filter((l) => verTodasLineas || l.pend > 0);
                  return (
                    <React.Fragment key={`${p.num}|${p.tipoDoc}`}>
                    <tr className={`border-t border-slate-100 hover:bg-slate-50/60 ${abierto ? "bg-blue-50/40" : ""}`}>
                      <td className="px-0.5 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={!!rev}
                          onChange={(e) => guardar({ revisados: { [p.num]: e.target.checked ? { ts: new Date().toISOString() } : null } })}
                        />
                      </td>
                      <td className="px-1 py-1 font-mono font-semibold overflow-hidden">
                        <button onClick={() => toggleAbierto(p.num)} className="flex max-w-full items-center gap-0.5 hover:text-blue-700" title={p.num}>
                          {abierto ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                          <span className="truncate">{p.num}</span>
                        </button>
                      </td>
                      <td className="px-1 py-1 truncate" title={p.tipoDoc}>{p.tipoDoc === "Pedido" ? "Ped." : p.tipoDoc === "Oferta" ? "Ofe." : p.tipoDoc}</td>
                      <td className="px-1 py-1 whitespace-nowrap" title={fmtFecha(p.fecha) || p.fecha}>{fechaCorta(p.fecha) || "—"}</td>
                      <td className="px-0.5 py-1 overflow-hidden">
                        <input
                          type="date"
                          value={p.recepPrev && parseFecha(p.recepPrev) ? parseFecha(p.recepPrev).toISOString().slice(0, 10) : ""}
                          onChange={(e) => guardar({ fechas: { [p.num]: e.target.value || null } })}
                          title={fmtFecha(p.recepPrev) || "Recepción prevista"}
                          className="w-full min-w-0 border border-slate-200 rounded px-0 py-0 text-[10px]"
                        />
                      </td>
                      <td className="px-1 py-1 text-right whitespace-nowrap">{p.dias ?? "—"}</td>
                      <td className="px-1 py-1 overflow-hidden" title={p.prov}><div className="truncate">{p.prov}</div></td>
                      <td className="px-1 py-1 overflow-hidden" title={p.comprador}><div className="truncate">{p.comprador}</div></td>
                      <td className="px-1 py-1 overflow-hidden" title={p.depto}><div className="truncate">{p.depto}</div></td>
                      <td className="px-1 py-1 overflow-hidden font-mono" title={p.ot || ""}><div className="truncate">{p.ot || "—"}</div></td>
                      <td className="px-0.5 py-1 text-center" title={p.alianza ? "Con alianza" : "Sin alianza"}>{p.alianza ? "✓" : ""}</td>
                      <td className="px-1 py-1 text-right whitespace-nowrap" title={fmtEur(p.imp)}>{fmtEur(p.imp)}</td>
                      <td className="px-1 py-1 text-right whitespace-nowrap font-semibold" title={fmtEur(p.impPend)}>{fmtEur(p.impPend)}</td>
                      <td className="px-0.5 py-1 overflow-hidden">
                        <span className={`inline-block max-w-full truncate text-[10px] font-bold border rounded px-1 py-0 ${COLOR_PRIORIDAD[p.prioridad]}`} title={p.prioridad}>{p.prioridad}</span>
                      </td>
                      <td className="px-1 py-1 overflow-hidden text-[10px]" title={(p.alertas || []).join(" ") || "Sin alertas"}>
                        <div className="truncate">{(p.alertas || []).join(" ")}</div>
                      </td>
                      <td className="px-0.5 py-1 text-center text-[10px] text-emerald-700" title={rev ? `Revisado · ${selloHora(rev.ts)}` : "Sin revisar"}>
                        {rev ? "✓" : ""}
                      </td>
                      <td className="px-0.5 py-1 text-center">
                        <button
                          onClick={() => toggleAbierto(p.num)}
                          className={`inline-flex items-center text-[10px] ${notasP.length ? "text-amber-700 font-semibold" : "text-slate-300 hover:text-amber-600"}`}
                          title={ultNota ? `${ultNota.autor} · ${selloHora(ultNota.ts)}\n${ultNota.texto}` : "Añadir nota interna"}
                        >
                          <StickyNote size={12} />{notasP.length || ""}
                        </button>
                      </td>
                      <td className="px-0.5 py-1 text-center text-[10px] text-blue-700" title={rc ? `Reclamado ${rc.veces || 1}× · ${selloHora(rc.ts)}${rc.para ? ` · ${rc.para}` : ""}` : "Sin reclamar"}>
                        {rc ? `✉${rc.veces || 1}` : ""}
                      </td>
                      <td className="px-0.5 py-1 text-center">
                        <button
                          onClick={() => setReclamo({ proveedor: p.prov, provNum: p.provNum, inicial: [p.num] })}
                          className="text-slate-400 hover:text-blue-600"
                          title="Reclamar al proveedor"
                        >
                          <Mail size={14} />
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
                                  <th className="px-2 py-1 text-right" title="Cantidad que se recibirá en Business Central al registrar">A registrar</th>
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
                                    <td className="px-2 py-1 text-right">
                                      {l.pend > 0 ? (
                                        <input
                                          type="number"
                                          min="0"
                                          step="any"
                                          max={l.pend}
                                          value={cantARegistrar(p.num, l)}
                                          onChange={(e) => setCantReg((prev) => ({ ...prev, [`${p.num}|${l.lineNo}`]: e.target.value }))}
                                          className="w-16 border border-slate-300 rounded px-1 py-0.5 text-right bg-white"
                                          title="Cantidad a recibir. Por defecto, lo pendiente."
                                        />
                                      ) : ""}
                                    </td>
                                    <td className="px-2 py-1">{l.ud}</td>
                                    <td className="px-2 py-1 text-right whitespace-nowrap">{fmtEur(l.neto)}</td>
                                    <td className="px-2 py-1 text-right whitespace-nowrap">{l.impPend ? fmtEur(l.impPend) : ""}</td>
                                    <td className="px-2 py-1 whitespace-nowrap">{fmtFecha(l.fechaEsp)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {p.tipoDoc === "Pedido" && (p.lineas || []).some((l) => l.pend > 0) && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {registroUi?.num === p.num && registroUi.fase === "confirmar" ? (
                                <>
                                  <span className="text-[11px] text-slate-700">Se recibirá este pedido en Business Central, sin crear la factura.</span>
                                  <button
                                    type="button"
                                    onClick={() => registrarPedidoTabla(p)}
                                    className="text-[11px] font-semibold text-white bg-sky-700 hover:bg-sky-800 rounded px-2 py-1"
                                  >
                                    Confirmar registro
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setRegistroUi(null)}
                                    className="text-[11px] text-slate-500 hover:text-slate-800"
                                  >
                                    Cancelar
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={registroUi?.num === p.num && registroUi.fase === "registrando"}
                                  onClick={() => setRegistroUi({ num: p.num, fase: "confirmar" })}
                                  className="text-[11px] font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded px-2 py-1"
                                  title="Registra la recepción en Business Central (Recibir). No crea la factura de compra."
                                >
                                  {registroUi?.num === p.num && registroUi.fase === "registrando" ? "Registrando…" : "Registrar recepción"}
                                </button>
                              )}
                              {registroUi?.num === p.num && registroUi.fase === "error" && (
                                <span className="text-[11px] text-red-700">{registroUi.error}</span>
                              )}
                            </div>
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

      {consultaResp && (
        <ModalConsultaResponsable
          grupo={consultaResp}
          onClose={() => setConsultaResp(null)}
          onEnviado={onConsultaResponsableEnviada}
        />
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
