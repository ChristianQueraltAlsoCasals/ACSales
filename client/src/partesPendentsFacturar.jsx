/**
 * Pantalla «Parts pendents de facturar».
 * Mismo corte que el correo: importe enviado y no facturado (sin IVA),
 * agrupado por unidad de negocio y por OT. Cada OT se despliega para
 * ver los partes (pedidos de venta) que la componen. Al elegir una
 * unidad se abren todos, como en el correo de esa unidad.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, FileText, Mail, Send, SlidersHorizontal, StickyNote, X } from "lucide-react";
import { normalizarNumeroOT } from "./agenteInteligente.js";

const UNIDADES = [
  { cod: "AMT", nombre: "Treballs amb amiant", color: "#b45309" },
  { cod: "AUT", nombre: "Automatització", color: "#1d4ed8" },
  { cod: "CON", nombre: "Construcció", color: "#0f766e" },
  { cod: "INS", nombre: "Instal·lacions", color: "#6d28d9" },
  { cod: "LLM", nombre: "Clau en mà", color: "#0369a1" },
  { cod: "MAN", nombre: "Manteniments", color: "#be123c" },
  { cod: "OTR", nombre: "Altres (sense unitat)", color: "#64748b" },
];
const ORDEN_UN = UNIDADES.map((u) => u.cod);
const CONOCIDAS = new Set(ORDEN_UN.filter((c) => c !== "OTR"));
const SEGMENTOS = { A: "Administració pública", I: "Industrial", P: "Particular" };

const COLOR_ESTADO = {
  FACTURAT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FINALIZADA: "bg-teal-50 text-teal-700 border-teal-200",
  ENTREGAT: "bg-teal-50 text-teal-700 border-teal-200",
  REVISAT: "bg-sky-50 text-sky-700 border-sky-200",
  ACCEPTAT: "bg-sky-50 text-sky-700 border-sky-200",
  PROCES: "bg-blue-50 text-blue-700 border-blue-200",
  PENDENT: "bg-amber-50 text-amber-800 border-amber-300",
  "FIN/NO FAC": "bg-amber-50 text-amber-800 border-amber-300",
  "PEND DOCUM": "bg-amber-50 text-amber-800 border-amber-300",
  PEN_REVISA: "bg-amber-50 text-amber-800 border-amber-300",
  GARANTIA: "bg-purple-50 text-purple-700 border-purple-200",
  EXTRAS: "bg-purple-50 text-purple-700 border-purple-200",
  ARCHIVADA: "bg-slate-100 text-slate-500 border-slate-200",
  "NO ACEPTAD": "bg-red-50 text-red-700 border-red-200",
  "NO FACTURA": "bg-red-50 text-red-700 border-red-200",
  "NO ENTREGA": "bg-red-50 text-red-700 border-red-200",
};

function BadgeEstado({ estado }) {
  const txt = String(estado || "").trim();
  if (!txt) return <span className="text-slate-300">—</span>;
  const color = COLOR_ESTADO[txt] || "bg-slate-50 text-slate-600 border-slate-200";
  return <span className={`inline-block text-[10px] font-bold rounded border px-1.5 py-0.5 whitespace-nowrap ${color}`}>{txt}</span>;
}

const COLOR_DIAS = {
  d30: "text-emerald-600",
  d90: "text-amber-600",
  d90plus: "text-red-600 font-semibold",
  futura: "text-sky-600",
  sin: "text-slate-400",
};

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null || v === "") return 0;
  let s = String(v).trim().replace(/\s|€/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function eur2(n) {
  return (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function eur0(n) {
  return Math.round(Number(n) || 0).toLocaleString("es-ES") + " €";
}
function fmtPct(parte, total) {
  if (!(total > 0)) return "0,0 %";
  return ((parte / total) * 100).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %";
}
function fechaTxt(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
function fechaValida(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "").trim());
  if (!m || +m[1] < 2000) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}
export function hoyMadridISO(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function diasDesde(iso, hoy) {
  const a = fechaValida(iso);
  const b = fechaValida(hoy);
  if (!a || !b) return null;
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
function claseDias(dias) {
  if (dias == null) return "sin";
  if (dias < 0) return "futura";
  if (dias <= 30) return "d30";
  if (dias <= 90) return "d90";
  return "d90plus";
}
function tipoIva(vat) {
  const g = String(vat || "").toUpperCase();
  if (g.startsWith("IVA10")) return 0.1;
  if (g.startsWith("IVA00") || g.includes("EXEN") || !g) return 0;
  return 0.21;
}
function unidadDe(d1) {
  const raw = String(d1 || "").trim().toUpperCase();
  if (!raw || raw.startsWith("_")) return "OTR";
  const cod = raw.split("-")[0];
  if (CONOCIDAS.has(cod)) return cod;
  if (/^[A-Z]{2,5}$/.test(cod)) return cod;
  return "OTR";
}
function segmentoDe(d1) {
  const s = String(d1 || "").trim().toUpperCase().split("-")[1] || "";
  return s === "A" || s === "I" || s === "P" ? s : "";
}
function infoUnidad(cod) {
  return UNIDADES.find((u) => u.cod === cod) || { cod, nombre: cod, color: "#334155" };
}
function claveNota(ot) {
  return ot.ficha?.numeroOT || ot.codigo;
}

export function construirInformePartes({ fichas, pedidosVenta, lineasPedidoVenta, hoy = hoyMadridISO() } = {}) {
  const indiceFicha = new Map();
  if (fichas) {
    for (const f of fichas.values()) {
      const k = normalizarNumeroOT(f?.numeroOT);
      if (k && !indiceFicha.has(k)) indiceFicha.set(k, f);
    }
  }

  const cabeceras = new Map();
  for (const cab of pedidosVenta || []) {
    const num = String(cab.number || cab.No || cab["No."] || "").trim();
    if (!num) continue;
    cabeceras.set(num, {
      cliente: String(cab.customerName || cab.sellToCustomerName || cab.Sell_to_Customer_Name || "").trim(),
      clienteN: String(cab.customerNumber || cab.sellToCustomerNumber || cab.Sell_to_Customer_No || "").trim(),
      fecha: fechaValida(cab.orderDate || cab.Order_Date),
      externo: String(cab.externalDocumentNumber || cab.External_Document_No || "").trim(),
    });
  }

  const porParte = new Map();
  const textosPorDoc = new Map();
  const RE_PARTE_LIN = /n[ºo°]\.?\s*parte de trabajo[:\s]+(\S+)(?:\s+ot[:\s]+(\S+))?/i;
  for (const l of lineasPedidoVenta || []) {
    const tipo = String(l.Document_Type || l.documentType || "");
    if (tipo && !/order|pedido/i.test(tipo)) continue;
    const doc = String(l.Document_No || l.documentNo || "").trim();
    const descLin = String(l.Description || l.description || "").replace(/\s+/g, " ").trim();
    const mParte = descLin.match(RE_PARTE_LIN);
    if (doc && mParte) {
      const otLin = String(l.Shortcut_Dimension_2_Code || l.shortcutDimension2Code || "").trim();
      const lista = textosPorDoc.get(doc) || [];
      if (!lista.some((x) => x.num === mParte[1])) lista.push({ num: mParte[1], ot: mParte[2] || otLin });
      textosPorDoc.set(doc, lista);
    }
    const qty = num(l.Quantity ?? l.quantity);
    const ship = num(l.Quantity_Shipped ?? l.quantityShipped);
    const inv = num(l.Quantity_Invoiced ?? l.quantityInvoiced);
    if (!(qty > 0.0001) || !(ship > inv + 0.0001)) continue;
    const pend = num(l.Line_Amount ?? l.lineAmount) * (ship - inv) / qty;
    if (!(pend > 0.01)) continue;
    if (!doc) continue;
    const fecha = fechaValida(l.Shipment_Date || l.shipmentDate) || cabeceras.get(doc)?.fecha || "";
    const dias = diasDesde(fecha, hoy);
    const pendIva = pend * (1 + tipoIva(l.VAT_Prod_Posting_Group || l.vatProdPostingGroup));
    const d1 = String(l.Shortcut_Dimension_1_Code || l.shortcutDimension1Code || "").trim();
    const otRaw = String(l.Shortcut_Dimension_2_Code || l.shortcutDimension2Code || "").trim();
    const key = `${otRaw}\t${doc}`;
    let p = porParte.get(key);
    if (!p) {
      const cab = cabeceras.get(doc);
      p = {
        doc,
        otRaw,
        pend: 0,
        pendIva: 0,
        mas90: 0,
        fecha: "",
        externo: cab?.externo || "",
        clienteCab: cab?.cliente || "",
        clienteN: cab?.clienteN || "",
        d1imp: new Map(),
        descripcion: "",
        partesTrabajo: [],
      };
      porParte.set(key, p);
    }
    if (!p.descripcion && descLin && !mParte) p.descripcion = descLin.slice(0, 160);
    p.pend += pend;
    p.pendIva += pendIva;
    if (fecha && (!p.fecha || fecha < p.fecha)) p.fecha = fecha;
    if (dias != null && dias > 90) p.mas90 += pend;
    p.d1imp.set(d1, (p.d1imp.get(d1) || 0) + pend);
  }

  const porOT = new Map();
  for (const p of porParte.values()) {
    let d1 = "";
    let mejor = -1;
    for (const [cod, imp] of p.d1imp) {
      if (imp > mejor) { d1 = cod; mejor = imp; }
    }
    p.d1 = d1;
    p.dias = diasDesde(p.fecha, hoy);
    p.clase = claseDias(p.dias);
    const otNorm = normalizarNumeroOT(p.otRaw);
    const lista = textosPorDoc.get(p.doc) || [];
    const coinciden = lista.filter((x) => !x.ot || !otNorm || normalizarNumeroOT(x.ot) === otNorm);
    p.partesTrabajo = (coinciden.length ? coinciden : lista).map((x) => x.num);
    delete p.d1imp;

    const clave = p.otRaw ? (normalizarNumeroOT(p.otRaw) || p.otRaw) : `sin:${p.doc}`;
    let ot = porOT.get(clave);
    if (!ot) {
      const ficha = p.otRaw ? indiceFicha.get(normalizarNumeroOT(p.otRaw)) || null : null;
      ot = {
        clave,
        codigo: p.otRaw || "Sense OT",
        ficha,
        cliente: ficha?.general?.cliente || p.clienteCab || "",
        clienteN: p.clienteN || "",
        descripcion: String(ficha?.general?.descripcion || "").trim(),
        estado: String(ficha?.general?.estadoApp || "").trim(),
        parts: [],
        pend: 0,
        pendIva: 0,
        mas90: 0,
        unImp: new Map(),
        seg: { A: 0, I: 0, P: 0 },
        crudo: new Map(),
      };
      porOT.set(clave, ot);
    }
    if (!ot.cliente && p.clienteCab) ot.cliente = p.clienteCab;
    if (!ot.clienteN && p.clienteN) ot.clienteN = p.clienteN;
    if (p.otRaw && (ot.codigo === "Sense OT" || p.otRaw.length > ot.codigo.length)) ot.codigo = p.otRaw;
    ot.parts.push(p);
    ot.pend += p.pend;
    ot.pendIva += p.pendIva;
    ot.mas90 += p.mas90;
    const un = unidadDe(p.d1);
    ot.unImp.set(un, (ot.unImp.get(un) || 0) + p.pend);
    const seg = segmentoDe(p.d1);
    if (seg) ot.seg[seg] += p.pend;
    if (p.d1) ot.crudo.set(p.d1, (ot.crudo.get(p.d1) || 0) + p.pend);
  }

  const ots = [];
  for (const ot of porOT.values()) {
    let un = "OTR";
    let mejor = -1;
    for (const [cod, imp] of ot.unImp) {
      if (imp > mejor) { un = cod; mejor = imp; }
    }
    ot.un = un;
    ot.segmento = "";
    let segMejor = 0;
    for (const cod of ["A", "I", "P"]) {
      if (ot.seg[cod] > segMejor) { ot.segmento = cod; segMejor = ot.seg[cod]; }
    }
    ot.crudos = [...ot.crudo.entries()].sort((a, b) => b[1] - a[1]);
    ot.nParts = ot.parts.length;
    ot.parts.sort((a, b) => (a.fecha || "9999").localeCompare(b.fecha || "9999") || a.doc.localeCompare(b.doc, "es"));
    const fechas = ot.parts.map((x) => x.fecha).filter(Boolean).sort();
    ot.fechaMin = fechas[0] || "";
    ot.dias = diasDesde(ot.fechaMin, hoy);
    ot.clase = claseDias(ot.dias);
    const externos = [...new Set(ot.parts.map((x) => x.externo).filter(Boolean))];
    ot.externoComun = externos.length === 1 ? externos[0] : "";
    delete ot.unImp;
    delete ot.crudo;
    ots.push(ot);
  }
  ots.sort((a, b) => b.pend - a.pend);
  return { tall: hoy, ots };
}

function textoSegmentos(seg, total) {
  const trozos = ["A", "I", "P"]
    .filter((k) => seg[k] > 0.01)
    .map((k) => `${k} ${eur0(seg[k])}`);
  if (!trozos.length && total > 0.01) return "—";
  return trozos.join(" · ") || "—";
}

function resumir(ots) {
  const map = new Map();
  for (const ot of ots) {
    const acc = map.get(ot.un) || { nOt: 0, nParts: 0, pend: 0, pendIva: 0, mas90: 0, seg: { A: 0, I: 0, P: 0 }, crudos: new Map() };
    acc.nOt += 1;
    acc.nParts += ot.nParts;
    acc.pend += ot.pend;
    acc.pendIva += ot.pendIva;
    acc.mas90 += ot.mas90;
    for (const k of ["A", "I", "P"]) acc.seg[k] += ot.seg[k] || 0;
    if (ot.un === "OTR") {
      for (const [cod, imp] of ot.crudos || []) acc.crudos.set(cod, (acc.crudos.get(cod) || 0) + imp);
    }
    map.set(ot.un, acc);
  }
  const codigos = [...ORDEN_UN];
  for (const cod of map.keys()) if (!codigos.includes(cod)) codigos.splice(codigos.length - 1, 0, cod);
  return codigos.map((cod) => {
    const acc = map.get(cod) || { nOt: 0, nParts: 0, pend: 0, pendIva: 0, mas90: 0, seg: { A: 0, I: 0, P: 0 }, crudos: new Map() };
    return { ...infoUnidad(cod), ...acc, crudos: [...(acc.crudos?.entries?.() || [])] };
  });
}

function sinAcentos(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fechaNota(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ts || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function parseNotaCorreo(texto) {
  const t = String(texto || "").trim();
  const m = /^(Enviado a |De )(.+?) · «([^»]*)»\s*([\s\S]*)$/.exec(t);
  if (!m) return { enviado: false, quien: "", asunto: "", cuerpo: t };
  const enviado = m[1].startsWith("Enviado");
  let quien = m[2].replace(/<[^>]+>/g, "").replace(/,/g, ", ").replace(/\s+/g, " ").trim();
  if (enviado) quien = "";
  else quien = quien.replace(/^de\s+/i, "").trim();
  return { enviado, quien, asunto: m[3].trim(), cuerpo: (m[4] || "").trim() };
}

function limpiarCuerpo(cuerpo) {
  let t = String(cuerpo || "")
    .replace(/\\n/g, " ")
    .replace(/\[cid:[^\]]+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/\b(saludos|salutacions|best regards|atentamente|cordialment)[\s\S]*$/i, "").trim();
  t = t.replace(/^(buenos d[ií]as|bon dia|hola)[,.]?\s*/i, "");
  return t.trim();
}

function recortarFrase(texto, max = 220) {
  const t = limpiarCuerpo(texto);
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const punto = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "));
  return (punto > 80 ? corte.slice(0, punto + 1) : corte.trim()) + "…";
}

function esListadoPendientes(asunto, cuerpo) {
  const s = sinAcentos(`${asunto} ${cuerpo}`);
  return /pendents de facturar|pendientes de facturar|facturacio pendent/.test(s)
    && /unitat de negoci|unidad de negocio|la teva unitat|vuestra unidad|agrupad/.test(s);
}

function clasificarFacturacion(texto) {
  const s = sinAcentos(texto);
  const no = /no (se puede|es pot) factur|no factur|correg|incidencia|esperar|falta |descont|adelantad|\babono\b|abonar|mal creada|no proceder/.test(s);
  const si = /se puede factur|es pot factur|facturar (ya|ja)|podeu factur|podeis factur|proceder a la factur|listo para factur|llest per factur|ok para factur/.test(s);
  if (no) return "no_facturar";
  if (si) return "se_puede";
  return "";
}

/**
 * De las notas de correo de una OT saca dos cosas: qué se ha dicho
 * (sin repetir el listado general) y cómo está esa OT para facturar.
 */
export function resumenCorreoOT(notas, codigo) {
  const lista = Array.isArray(notas) ? notas : [];
  const correos = lista.filter((n) => n?.correoId || String(n?.autor || "").includes("Correo"));
  const manuales = lista.filter((n) => !correos.includes(n));
  if (!correos.length && !manuales.length) return null;

  const otTxt = codigo || "esta OT";
  const listados = [];
  const dichos = [];
  const vistos = new Set();

  const meterDicho = (ts, quien, texto, origen) => {
    const limpio = recortarFrase(texto, 240);
    if (!limpio) return;
    const clave = sinAcentos(limpio).slice(0, 140);
    if (vistos.has(clave)) return;
    vistos.add(clave);
    dichos.push({
      ts: String(ts || ""),
      fecha: fechaNota(ts),
      quien,
      texto: limpio,
      estado: clasificarFacturacion(`${quien} ${limpio}`),
      origen,
    });
  };

  for (const n of correos) {
    const p = parseNotaCorreo(n.texto);
    if (esListadoPendientes(p.asunto, p.cuerpo)) {
      listados.push({ fecha: fechaNota(n.ts), asunto: p.asunto });
      continue;
    }
    const quien = p.quien || (p.enviado ? "Envío" : String(n.autor || "").replace("📧", "").trim());
    meterDicho(n.ts, quien, p.cuerpo || p.asunto, "correo");
  }
  for (const n of manuales) {
    if (!clasificarFacturacion(n.texto)) continue;
    meterDicho(n.ts, n.autor || "", n.texto, "nota");
  }

  dichos.sort((a, b) => b.ts.localeCompare(a.ts));
  const conEstado = dichos.filter((d) => d.estado);
  const ultimo = conEstado[0] || null;
  let estado = ultimo?.estado || "pendiente";
  let titulo;
  let motivo;
  if (estado === "no_facturar") {
    titulo = `OT ${otTxt}: no facturar todavía`;
    motivo = ultimo.quien
      ? `${ultimo.quien}${ultimo.fecha ? ` (${ultimo.fecha})` : ""}: ${ultimo.texto}`
      : ultimo.texto;
  } else if (estado === "se_puede") {
    titulo = `OT ${otTxt}: se puede facturar`;
    motivo = ultimo.quien
      ? `${ultimo.quien}${ultimo.fecha ? ` (${ultimo.fecha})` : ""}: ${ultimo.texto}`
      : ultimo.texto;
  } else if (dichos.length) {
    titulo = `OT ${otTxt}: pendiente de facturar`;
    const d = dichos[0];
    motivo = `${d.quien ? `${d.quien}: ` : ""}${d.texto}`;
  } else {
    titulo = `OT ${otTxt}: pendiente de facturar`;
    motivo = "No hay respuesta sobre esta OT. El correo solo envía el listado para que la unidad diga qué se puede facturar.";
  }

  const fechasLista = [...new Set(listados.map((l) => l.fecha).filter(Boolean))].sort((a, b) => {
    const iso = (f) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f); return m ? `${m[3]}-${m[2]}-${m[1]}` : f; };
    return iso(a).localeCompare(iso(b));
  });
  const listado = listados.length
    ? `${listados.length} correo${listados.length === 1 ? "" : "s"} de listado${fechasLista.length ? ` (${fechasLista.join(", ")})` : ""}, pidiendo que indiquen qué OT se pueden facturar.`
    : "";

  return {
    estado,
    titulo,
    motivo,
    dichos: dichos.slice(0, 4),
    dichosMas: Math.max(0, dichos.length - 4),
    listado,
    nCorreos: correos.length,
    hayCorreo: correos.length > 0,
  };
}

function abrirPdfBase64(base64, ventana, nombre, urlServidor) {
  if (urlServidor) {
    if (ventana) ventana.location = urlServidor;
    else window.open(urlServidor, "_blank", "noopener");
    return;
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const archivo = String(nombre || "albaran.pdf").replace(/[^\w.-]+/g, "_");
  const url = URL.createObjectURL(new File([bytes], archivo, { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = archivo;
  a.click();
  if (ventana) ventana.close();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function BotonPdfAlbaran({ externo, pedido }) {
  const [estado, setEstado] = useState(null);
  const doc = String(externo || "").trim();
  const ped = String(pedido || "").trim();
  const abrir = async (numero) => {
    if (!doc && !ped) return;
    const ventana = window.open("", "_blank");
    setEstado("cargando");
    try {
      const q = new URLSearchParams();
      if (doc) q.set("externo", doc);
      if (ped) q.set("pedido", ped);
      if (numero) q.set("numero", numero);
      const r = await fetch(`/api/bc/albaran-venta-pdf?${q}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
      if (d.varios?.length) {
        if (ventana) ventana.close();
        setEstado({ varios: d.varios });
        return;
      }
      if (!d.base64) throw new Error("Business Central no ha devuelto el PDF del albarán.");
      abrirPdfBase64(d.base64, ventana, d.nombre, d.url);
      setEstado({
        aviso: d.aviso || null,
        material: d.material || null,
      });
    } catch (err) {
      if (ventana) ventana.close();
      setEstado({ error: err.message || String(err) });
    }
  };
  if (!doc && !ped) return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={() => abrir()}
        disabled={estado === "cargando"}
        title={`Albarán de venta y parte de trabajo${doc ? ` del documento ${doc}` : ""}${ped ? ` del pedido ${ped}` : ""}`}
        className="text-[10px] font-semibold text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 bg-white hover:bg-blue-50 disabled:opacity-50 whitespace-nowrap"
      >
        {estado === "cargando" ? "…" : "PDF"}
      </button>
      {estado?.error && <span className="text-[10px] text-red-600 max-w-[260px]">{estado.error}</span>}
      {estado?.aviso && <span className="text-[10px] text-amber-700 max-w-[260px]">{estado.aviso}</span>}
      {estado?.material?.texto && (
        <span className={`text-[10px] max-w-[260px] ${estado.material.cuadra ? (estado.material.deMas?.length ? "text-amber-800" : "text-emerald-700") : "text-red-700"}`}>
          {estado.material.texto}
        </span>
      )}
      {estado?.varios?.length > 0 && (
        <span className="flex flex-col items-start">
          {estado.varios.map((a) => (
            <button
              key={a.numero}
              type="button"
              onClick={() => abrir(a.numero)}
              className="text-[10px] text-blue-700 hover:underline font-mono"
              title={a.fecha ? `Registrado ${a.fecha}` : ""}
            >
              {a.numero}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function externoDeParte(p, refs) {
  return String(p.externo || "").trim() || String(refs?.[p.doc]?.externo || "").trim();
}

function fechaEnvio(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function TextoEnvio({ externo, envios }) {
  const clave = String(externo || "").trim();
  if (!clave || !envios || !(clave in envios)) return null;
  const info = envios[clave];
  if (!info) return <div className="text-[10px] text-slate-400">No enviado</div>;
  const cuando = fechaEnvio(info.fecha);
  const para = [...(info.para || []), ...(info.cc || [])].filter(Boolean);
  const title = [
    cuando ? `Enviado el ${cuando}` : "Enviado",
    para.length ? `a ${para.join(", ")}` : "",
    info.asunto ? `«${info.asunto}»` : "",
    info.adjunto || "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="text-[10px] font-semibold text-emerald-700" title={title}>
      Enviado{cuando ? ` ${cuando}` : ""}
    </div>
  );
}

function ResumenEnvios({ parts, envios, visible, buscando, refsAlb }) {
  if (!visible) return null;
  const docs = (parts || []).map((p) => externoDeParte(p, refsAlb)).filter(Boolean);
  if (!docs.length) return null;
  const vistos = docs.filter((e) => e in (envios || {}));
  if (!vistos.length) {
    return buscando ? <div className="text-[10px] text-slate-400">Correo…</div> : null;
  }
  const n = vistos.filter((e) => envios[e]).length;
  return (
    <div className={`text-[10px] ${n ? "text-emerald-700 font-semibold" : "text-slate-400"}`} title="Partes de esta OT ya enviados por correo, según los PDF del buzón de enviados">
      {n} de {docs.length} enviados
    </div>
  );
}

function DetallePartes({ parts, envios, refsAlb }) {
  const hayParte = parts.some((p) => p.partesTrabajo?.length);
  return (
    <div className="ml-6 my-1 border border-slate-200 rounded-md bg-white overflow-hidden">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-slate-50 text-slate-500 text-left">
            <th className="px-2 py-1 font-semibold">Comanda</th>
            {hayParte && <th className="px-2 py-1 font-semibold">Part de treball</th>}
            <th className="px-2 py-1 font-semibold">Doc. extern</th>
            <th className="px-2 py-1 font-semibold">Data</th>
            <th className="px-2 py-1 font-semibold text-right">Pendent</th>
            <th className="px-2 py-1 font-semibold">Albarán</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={`${p.otRaw}\t${p.doc}`} className="border-t border-slate-100 align-top">
              <td className="px-2 py-1 font-mono text-slate-800 whitespace-nowrap">
                {p.doc}
                {!hayParte && p.descripcion ? (
                  <div className="font-sans text-[10px] text-slate-500 max-w-sm truncate" title={p.descripcion}>{p.descripcion}</div>
                ) : null}
              </td>
              {hayParte && (
                <td className="px-2 py-1 text-slate-700">{p.partesTrabajo.length ? p.partesTrabajo.join(", ") : "—"}</td>
              )}
              <td className="px-2 py-1 text-slate-500">{externoDeParte(p, refsAlb) || "—"}</td>
              <td className="px-2 py-1 whitespace-nowrap">
                <TextoFecha fecha={p.fecha} dias={p.dias} clase={p.clase} />
              </td>
              <td className="px-2 py-1 text-right whitespace-nowrap font-semibold text-slate-800">{eur2(p.pend)}</td>
              <td className="px-2 py-1">
                <BotonPdfAlbaran externo={externoDeParte(p, refsAlb)} pedido={p.doc} />
                <TextoEnvio externo={externoDeParte(p, refsAlb)} envios={envios} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LS_EMAILS_CLIENTE = "pedidos_venta_emails_cliente_v1";

function emailClienteRecordado(clave) {
  try {
    const mapa = JSON.parse(localStorage.getItem(LS_EMAILS_CLIENTE) || "{}");
    return mapa[clave] || "";
  } catch {
    return "";
  }
}

function recordarEmailCliente(clave, email) {
  if (!clave || !email) return;
  try {
    const mapa = JSON.parse(localStorage.getItem(LS_EMAILS_CLIENTE) || "{}");
    mapa[clave] = email;
    localStorage.setItem(LS_EMAILS_CLIENTE, JSON.stringify(mapa));
  } catch { /* el navegador puede bloquear el almacén */ }
}

function emailsDeCampo(texto) {
  return String(texto || "").split(/[;,\s]+/).map((e) => e.trim()).filter((e) => /.+@.+\..+/.test(e));
}

function nombreAdjuntoUnico(nombre, usados) {
  let n = String(nombre || "albaran.pdf").replace(/[\\/]/g, "_");
  if (!/\.pdf$/i.test(n)) n += ".pdf";
  if (!usados.has(n.toLowerCase())) {
    usados.add(n.toLowerCase());
    return n;
  }
  const punto = n.lastIndexOf(".");
  const base = punto > 0 ? n.slice(0, punto) : n;
  const ext = punto > 0 ? n.slice(punto) : ".pdf";
  let i = 2;
  while (usados.has(`${base}_${i}${ext}`.toLowerCase())) i += 1;
  const out = `${base}_${i}${ext}`;
  usados.add(out.toLowerCase());
  return out;
}

function recortarAdjuntosCorreo(adjuntos) {
  const topeFichero = 3 * 1024 * 1024;
  const topeTotal = 10 * 1024 * 1024;
  const ok = [];
  const fuera = [];
  let suma = 0;
  for (const a of adjuntos) {
    const bytes = Math.floor(String(a.base64 || "").replace(/\s/g, "").length * 3 / 4);
    const cabe = ok.length < 10 && bytes > 0 && bytes <= topeFichero && suma + bytes <= topeTotal;
    if (!cabe) {
      fuera.push(a.nombre);
      continue;
    }
    suma += bytes;
    ok.push(a);
  }
  return { ok, fuera };
}

function borradorPedirPedido(ot) {
  const lineas = (ot.parts || []).map((p) => {
    const refs = [p.externo, ...(p.partesTrabajo || [])].filter(Boolean);
    return `· ${p.doc}${refs.length ? ` (${refs.join(" · ")})` : ""} — ${eur2(p.pend)}`;
  });
  const otTxt = ot.codigo || "—";
  const desc = String(ot.descripcion || "").trim();
  const cuerpo =
    `Benvolgut/da,\n\n` +
    `Us adjuntem els albarans i els parts de treball de l'OT ${otTxt}.\n` +
    `Descripció: ${desc || "—"}\n\n` +
    `Per poder facturar els pedidos de venda següents, necessitem que ens indiqueu el número de pedido:\n\n` +
    `${lineas.join("\n") || "· (sense pedidos)"}` +
    `\n\nQuedem a l'espera de la vostra resposta.\n\nGràcies.`;
  const cliente = String(ot.cliente || "").trim();
  return {
    asunto: [`Número de pedido`, `OT ${otTxt}`, desc, cliente].filter(Boolean).join(" · ").slice(0, 180),
    cuerpo,
  };
}

async function pdfDeAlbaran(externo, pedido, numero) {
  const q = new URLSearchParams();
  if (externo) q.set("externo", externo);
  if (pedido) q.set("pedido", pedido);
  if (numero) q.set("numero", numero);
  const r = await fetch(`/api/bc/albaran-venta-pdf?${q}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.detalle || `Error ${r.status}`);
  return d;
}

async function descargarPdfsDeOT(ot, onProgreso) {
  const adjuntos = [];
  const avisos = [];
  const usados = new Set();
  const parts = ot.parts || [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    onProgreso?.(`${i + 1} de ${parts.length} · ${p.doc}`);
    const externo = String(p.externo || "").trim();
    if (!externo && !p.doc) {
      avisos.push(`${p.doc || "PV"}: sin documento externo ni número de pedido, no hay PDF.`);
      continue;
    }
    try {
      const d = await pdfDeAlbaran(externo, p.doc);
      const piezas = [];
      if (d.varios?.length) {
        for (const a of d.varios) {
          try {
            const uno = await pdfDeAlbaran(externo, p.doc, a.numero);
            if (!uno.base64) throw new Error("Business Central no ha devuelto el PDF.");
            piezas.push(uno);
          } catch (err) {
            avisos.push(`${p.doc} · ${a.numero}: ${err.message || err}`);
          }
        }
      } else if (d.base64) {
        piezas.push(d);
      } else {
        avisos.push(`${p.doc}: Business Central no ha devuelto el PDF.`);
      }
      for (const pieza of piezas) {
        if (pieza.aviso) avisos.push(`${p.doc}: ${pieza.aviso}`);
        adjuntos.push({
          nombre: nombreAdjuntoUnico(pieza.nombre || `Albaran_${p.doc}.pdf`, usados),
          base64: pieza.base64,
          mime: pieza.mime || "application/pdf",
        });
      }
    } catch (err) {
      avisos.push(`${p.doc}: ${err.message || err}`);
    }
  }
  const recorte = recortarAdjuntosCorreo(adjuntos);
  if (recorte.fuera.length) {
    avisos.push(`No caben en el correo (máximo 10 PDF o 10 MB): ${recorte.fuera.join(", ")}`);
  }
  return { adjuntos: recorte.ok, avisos };
}

function htmlDeTexto(texto) {
  return String(texto || "")
    .split(/\r?\n/)
    .map((l) => (l ? l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "<br/>"))
    .join("<br/>");
}

function ModalPedirPedido({ ot, onCerrar, onEnviado }) {
  const borrador = borradorPedirPedido(ot);
  const claveEmail = ot.clienteN || ot.cliente || "";
  const [para, setPara] = useState(emailClienteRecordado(claveEmail));
  const [cc, setCc] = useState("");
  const [asunto, setAsunto] = useState(borrador.asunto);
  const [cuerpo, setCuerpo] = useState(borrador.cuerpo);
  const [de, setDe] = useState("");
  const [emailBC, setEmailBC] = useState(null);
  const [adjuntos, setAdjuntos] = useState([]);
  const [avisos, setAvisos] = useState([]);
  const [progreso, setProgreso] = useState("Preparant els PDF…");
  const [cargando, setCargando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let vivo = true;
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => { if (vivo && d.email) setDe(d.email); })
      .catch(() => {});
    const qs = new URLSearchParams();
    if (ot.clienteN) qs.set("numero", ot.clienteN);
    if (ot.cliente) qs.set("nombre", ot.cliente);
    if (qs.toString()) {
      fetch(`/api/bc/cliente-email?${qs}`)
        .then((r) => r.json())
        .then((d) => {
          if (!vivo) return;
          const e = (d && d.email) || "";
          setEmailBC(e);
          setPara((actual) => actual || e);
        })
        .catch(() => { if (vivo) setEmailBC(""); });
    } else {
      setEmailBC("");
    }
    descargarPdfsDeOT(ot, (txt) => { if (vivo) setProgreso(txt); })
      .then((res) => {
        if (!vivo) return;
        setAdjuntos(res.adjuntos);
        setAvisos(res.avisos);
        setCargando(false);
      })
      .catch((err) => {
        if (!vivo) return;
        setAvisos([err.message || String(err)]);
        setCargando(false);
      });
    const prevBody = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      vivo = false;
      document.body.style.overflow = prevBody;
    };
  }, [ot]);

  const enviar = async () => {
    const destinatarios = emailsDeCampo(para);
    const copias = emailsDeCampo(cc).filter((e) => !destinatarios.some((p) => p.toLowerCase() === e.toLowerCase()));
    if (!destinatarios.length) { setError("Indica el email del cliente."); return; }
    if (!asunto.trim()) { setError("Falta el asunto."); return; }
    setEnviando(true);
    setError(null);
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          cc: copias,
          asunto: asunto.trim(),
          cuerpoHtml: htmlDeTexto(cuerpo),
          ...(adjuntos.length ? { adjuntos } : {}),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      recordarEmailCliente(claveEmail, destinatarios[0]);
      onEnviado?.({ de: json.de, para: destinatarios, cc: copias, asunto: asunto.trim() });
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 2147483000, background: "rgba(15, 23, 42, 0.55)" }}
      onClick={onCerrar}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 flex-shrink-0">
          <div>
            <div className="text-sm font-semibold text-slate-800">Pedir número de pedido · OT {ot.codigo}</div>
            <div className="text-[11px] text-slate-500">
              {ot.cliente || "Sin cliente"}
              {` · ${(ot.parts || []).length} PV`}
              {de ? ` · desde ${de}` : ""}
            </div>
          </div>
          <button type="button" onClick={onCerrar} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 text-sm overflow-y-auto flex-1 min-h-0">
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Para</span>
            <input
              value={para}
              onChange={(e) => setPara(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="email del cliente"
            />
            <span className="block mt-1 text-[11px] text-slate-400">
              {emailBC === null
                ? "Consultando la ficha del cliente en BC…"
                : emailBC
                  ? `Ficha BC: ${emailBC}`
                  : "La ficha del cliente en BC no tiene email. Escríbelo y se recordará."}
            </span>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Copia</span>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="opcional"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Asunto</span>
            <input
              value={asunto}
              onChange={(e) => setAsunto(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Mensaje</span>
            <textarea
              value={cuerpo}
              onChange={(e) => setCuerpo(e.target.value)}
              rows={10}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </label>
          <div className="text-[12px] text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 space-y-1">
            <div className="flex items-start gap-2">
              <FileText size={14} className="text-blue-700 flex-shrink-0 mt-0.5" />
              <div>
                {cargando ? (
                  <span>Preparando los PDF… {progreso}</span>
                ) : adjuntos.length ? (
                  adjuntos.map((a) => <div key={a.nombre}>Adjunto: <strong>{a.nombre}</strong></div>)
                ) : (
                  <span className="text-amber-700">Sin PDF. El correo se puede enviar igual, pero el cliente no verá los albaranes.</span>
                )}
              </div>
            </div>
            {avisos.map((a) => <div key={a} className="text-[11px] text-amber-700">{a}</div>)}
          </div>
          {error && <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50 flex-shrink-0">
          <button type="button" onClick={onCerrar} disabled={enviando} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-white">
            Cancelar
          </button>
          <button
            type="button"
            onClick={enviar}
            disabled={enviando || cargando}
            className="text-sm font-semibold px-4 py-1.5 rounded-md text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Send size={14} />
            {enviando ? "Enviando…" : cargando ? "Preparando PDF…" : "Enviar al cliente"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function BotonPedirPedido({ ot, onRegistrado, refsAlb }) {
  const [abierto, setAbierto] = useState(false);
  const otCorreo = {
    ...ot,
    parts: (ot.parts || []).map((p) => ({ ...p, externo: externoDeParte(p, refsAlb) })),
  };
  const nPdf = (otCorreo.parts || []).filter((p) => String(p.externo || "").trim() || p.doc).length;
  return (
    <span className="inline-flex items-center justify-center">
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Enviar al cliente los PDF de esta OT (${nPdf}) y pedirle el número de pedido para facturar los PV`}
        className="inline-flex items-center justify-center text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded p-1"
      >
        <Mail size={14} />
      </button>
      {abierto && (
        <ModalPedirPedido
          ot={otCorreo}
          onCerrar={() => setAbierto(false)}
          onEnviado={(info) => { setAbierto(false); onRegistrado?.(info); }}
        />
      )}
    </span>
  );
}

function TextoFecha({ fecha, dias, clase, prefijo }) {
  if (!fecha) return <span className="text-slate-400">—</span>;
  const etiqueta = clase === "futura" ? "data futura" : dias != null ? `${dias} d` : "";
  return (
    <span className={COLOR_DIAS[clase] || COLOR_DIAS.sin}>
      {prefijo ? `${prefijo} ` : ""}{fechaTxt(fecha)}{etiqueta ? ` · ${etiqueta}` : ""}
    </span>
  );
}

export default function VistaPartesPendents({
  informe,
  sinLineas,
  fichasError,
  notas,
  enviados,
  notasAbiertas,
  onToggleNotas,
  onCambioNotas,
  onRegistrarEnvio,
  onBuscarCorreos,
  buscandoCorreos,
  estadoCorreo,
  NotasOT,
}) {
  const [fUnidad, setFUnidad] = useState("");
  const [fOt, setFOt] = useState("");
  const [fCliente, setFCliente] = useState("");
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);
  const [otsAbiertas, setOtsAbiertas] = useState(() => new Set());
  const [envios, setEnvios] = useState({});
  const [buscandoEnvios, setBuscandoEnvios] = useState(false);
  const enviosRef = useRef({});
  const [refsAlb, setRefsAlb] = useState({});
  const refsAlbRef = useRef({});
  const anclaDetalle = useRef(null);
  const cajaFiltro = useRef(null);
  const otsTodas = informe?.ots || [];

  useEffect(() => {
    if (!fUnidad) return;
    anclaDetalle.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [fUnidad]);

  useEffect(() => {
    if (!filtrosAbiertos) return;
    const cerrar = (ev) => {
      if (cajaFiltro.current && !cajaFiltro.current.contains(ev.target)) setFiltrosAbiertos(false);
    };
    document.addEventListener("mousedown", cerrar);
    return () => document.removeEventListener("mousedown", cerrar);
  }, [filtrosAbiertos]);

  const opciones = useMemo(() => {
    const deptos = resumir(otsTodas).filter((u) => u.nOt > 0);
    const paraOt = otsTodas.filter((ot) => (!fUnidad || ot.un === fUnidad) && (!fCliente || ot.cliente === fCliente));
    const paraCli = otsTodas.filter((ot) => (!fUnidad || ot.un === fUnidad) && (!fOt || ot.codigo === fOt));
    const clientes = [...new Set(paraCli.map((ot) => ot.cliente).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
    const ots = [...paraOt].sort((a, b) => a.codigo.localeCompare(b.codigo, "es"));
    return { deptos, ots, clientes };
  }, [otsTodas, fUnidad, fOt, fCliente]);

  const buscadas = useMemo(() => otsTodas.filter((ot) => {
    if (fUnidad && ot.un !== fUnidad) return false;
    if (fOt && ot.codigo !== fOt) return false;
    if (fCliente && ot.cliente !== fCliente) return false;
    return true;
  }), [otsTodas, fUnidad, fOt, fCliente]);

  const unidades = useMemo(() => {
    const base = resumir(buscadas);
    if (fUnidad || fOt || fCliente) return base.filter((u) => u.nOt > 0);
    return base;
  }, [buscadas, fUnidad, fOt, fCliente]);

  const nFiltros = [fUnidad, fOt, fCliente].filter(Boolean).length;

  const cambiarDepto = (cod) => {
    setFUnidad(cod);
    setFOt((otCod) => {
      if (!otCod || !cod) return otCod;
      const ot = otsTodas.find((o) => o.codigo === otCod);
      return ot && ot.un !== cod ? "" : otCod;
    });
    setFCliente((cli) => {
      if (!cli || !cod) return cli;
      return otsTodas.some((o) => o.un === cod && o.cliente === cli) ? cli : "";
    });
  };

  const cambiarOt = (cod) => {
    setFOt(cod);
    if (!cod) return;
    const ot = otsTodas.find((o) => o.codigo === cod);
    if (!ot) return;
    if (fUnidad && ot.un !== fUnidad) setFUnidad(ot.un);
    if (fCliente && ot.cliente !== fCliente) setFCliente(ot.cliente || "");
  };

  const cambiarCliente = (cli) => {
    setFCliente(cli);
    if (!cli) return;
    setFOt((otCod) => {
      if (!otCod) return otCod;
      const ot = otsTodas.find((o) => o.codigo === otCod);
      return ot && ot.cliente !== cli ? "" : otCod;
    });
  };

  const limpiarFiltros = () => {
    setFUnidad("");
    setFOt("");
    setFCliente("");
  };

  const detalle = useMemo(
    () => (fUnidad ? buscadas.filter((ot) => ot.un === fUnidad) : buscadas),
    [buscadas, fUnidad]
  );
  const bloques = useMemo(() => {
    const por = new Map();
    for (const ot of detalle) {
      if (!por.has(ot.un)) por.set(ot.un, []);
      por.get(ot.un).push(ot);
    }
    const orden = unidades.map((u) => u.cod).filter((cod) => por.has(cod));
    for (const cod of por.keys()) if (!orden.includes(cod)) orden.push(cod);
    return orden
      .filter((cod) => !fUnidad || cod === fUnidad)
      .map((cod) => ({ ...infoUnidad(cod), ots: por.get(cod) || [] }))
      .filter((b) => b.ots.length);
  }, [detalle, unidades, fUnidad]);

  const externosVisibles = useMemo(() => {
    const set = new Set();
    for (const b of bloques) {
      for (const ot of b.ots) {
        if (!fUnidad && !otsAbiertas.has(ot.clave)) continue;
        for (const p of ot.parts || []) {
          const e = String(p.externo || "").trim() || String(refsAlb[p.doc]?.externo || "").trim();
          if (e) set.add(e);
        }
      }
    }
    return [...set].sort();
  }, [bloques, fUnidad, otsAbiertas, refsAlb]);

  const pedidosSinExterno = useMemo(() => {
    const set = new Set();
    for (const b of bloques) {
      for (const ot of b.ots) {
        if (!fUnidad && !otsAbiertas.has(ot.clave)) continue;
        for (const p of ot.parts || []) {
          if (!String(p.externo || "").trim() && p.doc && !(p.doc in refsAlbRef.current)) set.add(p.doc);
        }
      }
    }
    return [...set].sort();
  }, [bloques, fUnidad, otsAbiertas, refsAlb]);

  useEffect(() => {
    const faltan = externosVisibles.filter((e) => !(e in enviosRef.current));
    if (!faltan.length) return undefined;
    let vivo = true;
    setBuscandoEnvios(true);
    fetch("/api/pedidos-venta/enviados-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externos: faltan }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo || !ok || !d?.enviados) return;
        const next = { ...enviosRef.current };
        for (const e of faltan) next[e] = d.enviados[e] ?? null;
        enviosRef.current = next;
        setEnvios(next);
      })
      .catch(() => {})
      .finally(() => { if (vivo) setBuscandoEnvios(false); });
    return () => { vivo = false; };
  }, [externosVisibles]);

  useEffect(() => {
    if (!pedidosSinExterno.length) return undefined;
    let vivo = true;
    fetch("/api/bc/albaranes-por-pedido", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pedidos: pedidosSinExterno }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo || !ok || !d?.albaranes) return;
        const next = { ...refsAlbRef.current };
        for (const ped of pedidosSinExterno) next[ped] = d.albaranes[ped] || null;
        refsAlbRef.current = next;
        setRefsAlb(next);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [pedidosSinExterno]);

  const tot = detalle.reduce((a, ot) => ({
    pend: a.pend + ot.pend,
    pendIva: a.pendIva + ot.pendIva,
    mas90: a.mas90 + ot.mas90,
    nOt: a.nOt + 1,
    nParts: a.nParts + ot.nParts,
  }), { pend: 0, pendIva: 0, mas90: 0, nOt: 0, nParts: 0 });
  const totalResumen = unidades.reduce((a, u) => a + u.pend, 0);
  const unidadActiva = fUnidad ? infoUnidad(fUnidad) : null;
  const tallTxt = fechaTxt(informe?.tall);

  const abrirUnidad = (cod) => cambiarDepto(fUnidad === cod ? "" : cod);

  const togglePartes = (clave) => {
    setOtsAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(clave)) next.delete(clave);
      else next.add(clave);
      return next;
    });
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-blue-700">Facturació · Tall {tallTxt}</div>
          <h1 className="text-xl font-bold text-slate-900 mt-0.5">
            Parts pendents de facturar{unidadActiva ? ` · ${unidadActiva.nombre}` : ""}
          </h1>
          <p className="text-[12px] text-slate-500 mt-1 max-w-3xl">
            Import de les línies enviades i encara no facturades, sense IVA. El color de la data és l'antiguitat: verd fins a 30 dies, ambre de 31 a 90, vermell a partir de 90.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {nFiltros > 0 && (
            <button type="button" onClick={limpiarFiltros} className="text-sm text-slate-600 border border-slate-300 rounded-md px-3 py-2 bg-white hover:bg-slate-50">
              Quitar filtros
            </button>
          )}
          <button
            type="button"
            onClick={onBuscarCorreos}
            disabled={buscandoCorreos}
            title="Busca en el correo (recibidos y enviados, últimos 60 días) los mensajes que mencionan una OT y los añade a las notas"
            className="flex items-center gap-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-60 rounded-md px-3 py-2"
          >
            {buscandoCorreos ? "Buscando correos…" : "Buscar correos"}
          </button>
        </div>
      </div>
      {estadoCorreo && <div className={`text-[11px] mt-1 ${estadoCorreo.startsWith("✗") ? "text-red-600" : "text-slate-400"}`}>{estadoCorreo}</div>}
      {fichasError && <div className="mt-3 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">{fichasError}</div>}

      {sinLineas ? (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          No hay líneas de pedido de venta cargadas. Cárgalas en «Cargar datos» → «Líneas de Pedido de Venta».
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 mt-4 bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-r border-slate-200">
              <div className="text-[11px] text-slate-500">Pendent sense IVA</div>
              <div className="text-2xl font-bold text-slate-900 mt-0.5">{eur0(tot.pend)}</div>
            </div>
            <div className="px-4 py-3 border-r border-slate-200">
              <div className="text-[11px] text-slate-500">Amb IVA</div>
              <div className="text-2xl font-bold text-slate-900 mt-0.5">{eur0(tot.pendIva)}</div>
            </div>
            <div className="px-4 py-3 border-r border-slate-200">
              <div className="text-[11px] text-slate-500">OT / parts</div>
              <div className="text-2xl font-bold text-slate-900 mt-0.5">{tot.nOt.toLocaleString("es-ES")} / {tot.nParts.toLocaleString("es-ES")}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[11px] text-slate-500">Més de 90 dies</div>
              <div className="text-2xl font-bold text-red-600 mt-0.5">{eur0(tot.mas90)}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <div className="relative" ref={cajaFiltro}>
              <button
                type="button"
                onClick={() => setFiltrosAbiertos((v) => !v)}
                className={`flex items-center gap-2 text-sm font-semibold rounded-md px-3 py-1.5 border ${nFiltros ? "bg-blue-50 text-blue-800 border-blue-300" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
              >
                <SlidersHorizontal size={14} />
                Filtrar
                {nFiltros > 0 && <span className="text-[11px] bg-blue-600 text-white rounded-full px-1.5">{nFiltros}</span>}
              </button>
              {filtrosAbiertos && (
                <div className="absolute z-30 mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg p-3 space-y-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold text-slate-500">Departamento</span>
                    <select
                      value={fUnidad}
                      onChange={(e) => cambiarDepto(e.target.value)}
                      className="mt-0.5 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white"
                    >
                      <option value="">Todos</option>
                      {opciones.deptos.map((u) => (
                        <option key={u.cod} value={u.cod}>{u.cod} · {u.nombre}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-slate-500">OT</span>
                    <select
                      value={fOt}
                      onChange={(e) => cambiarOt(e.target.value)}
                      className="mt-0.5 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white"
                    >
                      <option value="">Todas</option>
                      {opciones.ots.map((ot) => (
                        <option key={ot.clave} value={ot.codigo}>{ot.codigo}{ot.cliente ? ` · ${ot.cliente}` : ""}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-slate-500">Cliente</span>
                    <select
                      value={fCliente}
                      onChange={(e) => cambiarCliente(e.target.value)}
                      className="mt-0.5 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-white"
                    >
                      <option value="">Todos</option>
                      {opciones.clientes.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  {nFiltros > 0 && (
                    <button type="button" onClick={limpiarFiltros} className="text-sm text-slate-500 hover:underline">
                      Quitar filtros
                    </button>
                  )}
                </div>
              )}
            </div>
            {fUnidad && (
              <button type="button" onClick={() => cambiarDepto("")} className="text-[12px] bg-white border border-slate-300 rounded-full px-2 py-1 text-slate-700 hover:bg-slate-50">
                {fUnidad} ✕
              </button>
            )}
            {fOt && (
              <button type="button" onClick={() => setFOt("")} className="text-[12px] bg-white border border-slate-300 rounded-full px-2 py-1 text-slate-700 hover:bg-slate-50 font-mono">
                {fOt} ✕
              </button>
            )}
            {fCliente && (
              <button type="button" onClick={() => cambiarCliente("")} className="text-[12px] bg-white border border-slate-300 rounded-full px-2 py-1 text-slate-700 hover:bg-slate-50 max-w-[240px] truncate">
                {fCliente} ✕
              </button>
            )}
            <span className="ml-auto text-[12px] text-slate-500">
              {nFiltros ? "Filtrado" : "Todas las unidades"}
            </span>
          </div>

          <h2 className="text-sm font-bold text-slate-800 mt-5 mb-2">Resum per unitat de negoci</h2>
          <div className="bg-white border border-slate-200 rounded-md overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-left">
                  <th className="px-3 py-2 font-semibold">Unitat</th>
                  <th className="px-2 py-2 font-semibold">Segments (A/I/P)</th>
                  <th className="px-2 py-2 font-semibold text-right">OT</th>
                  <th className="px-2 py-2 font-semibold text-right">Parts</th>
                  <th className="px-2 py-2 font-semibold text-right">Pendent</th>
                  <th className="px-2 py-2 font-semibold text-right">%</th>
                  <th className="px-3 py-2 font-semibold text-right">&gt; 90 dies</th>
                </tr>
              </thead>
              <tbody>
                {unidades.map((u) => {
                  const activa = fUnidad === u.cod;
                  const segTxt = u.cod === "OTR" && u.crudos?.length
                    ? u.crudos.map(([cod]) => cod).join(" · ")
                    : textoSegmentos(u.seg, u.pend);
                  return (
                    <tr
                      key={u.cod}
                      onClick={() => abrirUnidad(u.cod)}
                      className={`border-t border-slate-100 cursor-pointer ${activa ? "bg-slate-100" : "hover:bg-slate-50"}`}
                      title={activa ? "Tornar a totes les unitats" : `Veure el detall de ${u.nombre}`}
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className="font-bold" style={{ color: u.color }}>{u.cod}</span>
                        <span className="text-slate-600 ml-2">{u.nombre}</span>
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">{u.pend > 0.01 ? segTxt : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{u.nOt || "—"}</td>
                      <td className="px-2 py-1.5 text-right">{u.nParts || "—"}</td>
                      <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">{u.pend > 0.01 ? eur2(u.pend) : "0,00 €"}</td>
                      <td className="px-2 py-1.5 text-right text-slate-500 whitespace-nowrap">{fmtPct(u.pend, totalResumen)}</td>
                      <td className={`px-3 py-1.5 text-right whitespace-nowrap ${u.mas90 > 0.01 ? "text-red-600 font-semibold" : "text-slate-400"}`}>
                        {u.mas90 > 0.01 ? eur2(u.mas90) : "—"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  <td />
                  <td className="px-2 py-2 text-right">{unidades.reduce((a, u) => a + u.nOt, 0)}</td>
                  <td className="px-2 py-2 text-right">{unidades.reduce((a, u) => a + u.nParts, 0)}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">{eur2(totalResumen)}</td>
                  <td className="px-2 py-2 text-right">100 %</td>
                  <td className="px-3 py-2 text-right text-red-600 whitespace-nowrap">{eur2(unidades.reduce((a, u) => a + u.mas90, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-slate-500 mt-1.5">
            Antiguitat: <span className="text-emerald-600">≤ 30 d</span>
            {" · "}<span className="text-amber-600">31–90 d</span>
            {" · "}<span className="text-red-600">&gt; 90 d</span>
            {" · "}<span className="text-sky-600">data futura</span>
            {"  ·  Segments: A Administració pública · I Industrial · P Particular. Prem una unitat per obrir-la, o la fletxa d'una OT per veure els seus partes."}
          </div>

          <div ref={anclaDetalle} />
          {bloques.length === 0 && (
            <div className="mt-6 text-sm text-slate-400 text-center py-8">Cap parte pendent amb aquest filtre.</div>
          )}

          {bloques.map((b) => {
            const pend = b.ots.reduce((a, ot) => a + ot.pend, 0);
            const mas90 = b.ots.reduce((a, ot) => a + ot.mas90, 0);
            const nParts = b.ots.reduce((a, ot) => a + ot.nParts, 0);
            const abierto = !!fUnidad;
            return (
              <section key={b.cod} className="mt-8">
                <div className="pl-3 border-l-4 flex items-end justify-between gap-3" style={{ borderColor: b.color }}>
                  <div>
                    <div className="text-[15px]">
                      <span className="font-bold" style={{ color: b.color }}>{b.cod}</span>
                      <span className="font-semibold text-slate-800 ml-2">{b.nombre}</span>
                    </div>
                    <div className="text-[12px] text-slate-500">
                      {b.ots.length} OT · {nParts} parts
                      {mas90 > 0.01 && <span className="text-red-600"> · {eur2(mas90)} amb més de 90 dies</span>}
                    </div>
                  </div>
                  <div className="text-lg font-bold text-slate-900 whitespace-nowrap">{eur2(pend)}</div>
                </div>
                <div className="mt-2 bg-white border border-slate-200 rounded-md overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-left">
                        <th className="px-3 py-2 font-semibold">{abierto ? "OT / Comanda" : "OT"}</th>
                        <th className="px-2 py-2 font-semibold">Estat</th>
                        <th className="px-2 py-2 font-semibold">{abierto ? "Client / Doc. extern" : "Client"}</th>
                        <th className="px-2 py-2 font-semibold text-right">Parts</th>
                        <th className="px-2 py-2 font-semibold">{abierto ? "Data antig." : "Més antic"}</th>
                        <th className="px-2 py-2 font-semibold text-right">Pendent</th>
                        <th className="px-2 py-2 font-semibold">Comentari</th>
                        <th className="px-2 py-2 font-semibold text-center w-10" title="Correo al cliente: PDF de la OT y número de pedido"><Mail size={12} className="inline" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.ots.map((ot) => {
                        const claveN = claveNota(ot);
                        const listaNotas = notas?.[claveN] || [];
                        const resumen = resumenCorreoOT(listaNotas, ot.codigo);
                        const ult = listaNotas[listaNotas.length - 1];
                        const colorResumen = resumen?.estado === "no_facturar" ? "text-red-700" : resumen?.estado === "se_puede" ? "text-emerald-700" : "text-amber-800";
                        const abierta = notasAbiertas?.has(claveN);
                        const partesVisibles = abierto || otsAbiertas.has(ot.clave);
                        const rc = enviados?.[claveN];
                        const segTxt = ot.segmento ? `${ot.segmento} · ${SEGMENTOS[ot.segmento]}` : (ot.crudos?.[0]?.[0] || "");
                        return (
                          <React.Fragment key={ot.clave}>
                            <tr className="border-t border-slate-200 align-top">
                              <td className="px-3 py-2 whitespace-nowrap">
                                {abierto ? (
                                  <span className="inline-flex items-center gap-1 font-mono font-semibold text-slate-900">
                                    <ChevronDown size={14} className="text-slate-400" />
                                    {ot.codigo}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => togglePartes(ot.clave)}
                                    className="inline-flex items-center gap-1 font-mono font-semibold text-slate-900 hover:text-blue-800"
                                    title={partesVisibles ? "Amagar els partes" : `Veure els ${ot.nParts} partes`}
                                    aria-expanded={partesVisibles}
                                  >
                                    {partesVisibles ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                                    {ot.codigo}
                                  </button>
                                )}
                              </td>
                              <td className="px-2 py-2 whitespace-nowrap"><BadgeEstado estado={ot.estado} /></td>
                              <td className="px-2 py-2 max-w-md">
                                <div className="font-medium text-slate-800">{ot.cliente || "—"}</div>
                                <div className="text-[11px] text-slate-500 line-clamp-2" title={ot.descripcion || ""}>
                                  {ot.descripcion || "Sense descripció al llistat d'OT"}
                                </div>
                                <div className="text-[11px] text-slate-400">
                                  {segTxt}
                                  {ot.externoComun ? ` · client ${ot.externoComun}` : ""}
                                </div>
                              </td>
                              <td className="px-2 py-2 text-right">
                                {abierto ? (
                                  <span className="tabular-nums">{ot.nParts}</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => togglePartes(ot.clave)}
                                    className="font-semibold text-blue-800 hover:underline tabular-nums"
                                    title={partesVisibles ? "Amagar els partes" : `Veure els ${ot.nParts} partes`}
                                  >
                                    {ot.nParts}
                                  </button>
                                )}
                              </td>
                              <td className="px-2 py-2 whitespace-nowrap">
                                <TextoFecha fecha={ot.fechaMin} dias={ot.dias} clase={ot.clase} prefijo={abierto ? "" : "des del"} />
                              </td>
                              <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{eur2(ot.pend)}</td>
                              <td className="px-2 py-2 max-w-xs">
                                <button type="button" onClick={() => onToggleNotas(claveN)} className="text-left w-full" title={resumen ? `${resumen.titulo}\n${resumen.motivo}` : (ult?.texto || "")}>
                                  {resumen?.hayCorreo ? (
                                    <>
                                      <span className={`block text-[11px] font-semibold ${colorResumen}`}>{resumen.titulo}</span>
                                      <span className="block text-[11px] text-slate-600 line-clamp-2">{resumen.motivo}</span>
                                    </>
                                  ) : ult ? (
                                    <span className="text-[11px] text-slate-700 line-clamp-2">{ult.texto}</span>
                                  ) : (
                                    <span className="text-[11px] text-slate-300 inline-flex items-center gap-1"><StickyNote size={12} /> Afegir</span>
                                  )}
                                </button>
                              </td>
                              <td className="px-2 py-2 text-center whitespace-nowrap">
                                <BotonPedirPedido ot={ot} refsAlb={refsAlb} onRegistrado={(info) => onRegistrarEnvio(claveN, info?.para)} />
                                {rc ? <div className="text-[10px] text-blue-700" title={rc.para || ""}>✉ {rc.veces || 1}×</div> : null}
                                <ResumenEnvios parts={ot.parts} envios={envios} refsAlb={refsAlb} visible={abierto || otsAbiertas.has(ot.clave)} buscando={buscandoEnvios} />
                              </td>
                            </tr>
                            {abierta && (
                              <tr className="bg-amber-50/40">
                                <td colSpan={8} className="px-3 pb-2">
                                  <NotasOT ot={claveN} codigo={ot.codigo} notas={listaNotas} onCambio={onCambioNotas} />
                                </td>
                              </tr>
                            )}
                            {partesVisibles && !abierto && (
                              <tr className="bg-slate-50/80">
                                <td colSpan={8} className="px-3 pb-2 pt-0">
                                  <DetallePartes parts={ot.parts} envios={envios} refsAlb={refsAlb} />
                                </td>
                              </tr>
                            )}
                            {abierto && ot.parts.map((p) => (
                              <tr key={p.doc} className="border-t border-slate-100 bg-slate-50/60">
                                <td className="px-3 py-1 pl-6 whitespace-nowrap">
                                  <div className="font-mono text-slate-700">{p.doc}</div>
                                  {p.partesTrabajo?.length > 0 && (
                                    <div className="text-[10px] text-slate-500">{p.partesTrabajo.join(" · ")}</div>
                                  )}
                                </td>
                                <td />
                                <td className="px-2 py-1 text-slate-500">
                                  {externoDeParte(p, refsAlb) || ""}
                                  {!p.partesTrabajo?.length && p.descripcion ? (
                                    <div className="text-[10px] text-slate-400 truncate max-w-md" title={p.descripcion}>{p.descripcion}</div>
                                  ) : null}
                                </td>
                                <td />
                                <td className="px-2 py-1 whitespace-nowrap">
                                  <TextoFecha fecha={p.fecha} dias={p.dias} clase={p.clase} />
                                </td>
                                <td className="px-2 py-1 text-right whitespace-nowrap text-slate-700">{eur2(p.pend)}</td>
                                <td className="px-2 py-1">
                                  <BotonPdfAlbaran externo={externoDeParte(p, refsAlb)} pedido={p.doc} />
                                  <TextoEnvio externo={externoDeParte(p, refsAlb)} envios={envios} />
                                </td>
                                <td />
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
