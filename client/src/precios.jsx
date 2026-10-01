/**
 * precios.jsx — HISTÓRICO DE PRECIOS "¿se compra bien?" (Anexo F del traspaso).
 *
 * Trabaja SOLO con las líneas de compra (dataset lineas_compra, nombres
 * de columna en INGLÉS crudo de BC). Permite:
 *   · Buscar un artículo (por código o descripción).
 *   · Ver su ficha: último / mínimo / máximo / medio, nº compras y proveedores.
 *   · Precio medio por proveedor (el más barato primero).
 *   · Histórico completo, con mínimo en verde y máximo en rojo.
 *   · Regla del 3%: marca caras las compras > mínimo × 1,03.
 *   · Vista "¿quién compra bien?" por comprador (cruza líneas con pedidos por PC).
 *
 * Precio NETO por línea: Unit_Cost si viene (ya neto) o Direct_Unit_Cost
 * con los 3 descuentos en cascada — idéntico a precioNetoFila (Anexo A.2).
 */
import React, { useState, useMemo, useEffect } from "react";
import { Search, ArrowLeft, TrendingDown, Users, Mail } from "lucide-react";
import { historialVentaArticulo } from "./agenteInteligente.js";
import {
  cargarMapeoArticulos,
  familiaDe,
  etiquetaEmpresaParaCodigo,
} from "./mapeoArticulos.js";

const DESV_OK = 3; // % de tolerancia sobre el mínimo antes de marcar "caro"

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
const fmtP = (v) => (isNaN(v) || v == null ? "—" : v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + " €");
const fmtE = (v) => (isNaN(v) || v == null ? "—" : v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €");
const fmtN = (v) => { const n = parseNum(v); return isNaN(n) ? String(v ?? "").trim() || "—" : n.toLocaleString("es-ES", { maximumFractionDigits: 2 }); };
const fmtD = (d) => (d ? d.toLocaleDateString("es-ES") : "—");
const sinAcentos = (s) => (s ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Columnas de las líneas de compra (inglés crudo + español por si acaso)
function cols(headers) {
  const low = headers.map((h) => h.toLowerCase());
  const H = (re) => headers[low.findIndex((h) => re.test(h))] || "";
  return {
    cod: H(/^no$/) || H(/^n[º°o]\.?$/),
    desc: H(/^description$/) || H(/descripci/),
    doc: H(/^document_no$/) || H(/n[º°o]?\.?\s*documento/),
    prov: H(/^buy_from_vendor_name$/) || H(/proveedor/),
    cant: H(/^quantity$/) || H(/cantidad/),
    costeUnit: H(/^unit_cost$/) || H(/^coste unitario$/),
    directo: H(/^direct_unit_cost$/) || H(/coste unit\.? directo/),
    d1: H(/^percent_dto_linea_1$/) || H(/%\s*dto\.?\s*1/),
    d2: H(/^percent_dto_linea_2$/) || H(/%\s*dto\.?\s*2/),
    d3: H(/^percent_dto_linea_3$/) || H(/%\s*dto\.?\s*3/),
    importe: H(/^line_amount$/) || H(/importe l[ií]nea/),
    fecha: H(/^order_date$/) || H(/fecha pedido|fecha registro/),
    ot: H(/^shortcut_dimension_2_code$/) || H(/c[oó]d\.?\s*ot/),
  };
}
function colsPedidos(headers) {
  const low = headers.map((h) => h.toLowerCase());
  const H = (re) => headers[low.findIndex((h) => re.test(h))] || "";
  return {
    num: H(/^no$/) || H(/^nº$/),
    comprador: H(/^cdcpurchasercode$/) || H(/comprador/),
    // "Creado por" (usuario que creó el pedido). Preferimos el NOMBRE legible;
    // se evita el GUID (SystemCreatedBy suele traerlo). Reconoce inglés/español.
    creadoPor:
      H(/^created_by_user_name$/) ||
      H(/^systemcreatedby_?name$/) ||
      H(/creado por/) ||
      H(/created.?by.*name/) ||
      H(/^created_by$/) ||
      H(/^systemcreatedby$/),
  };
}

function precioNeto(r, c) {
  if (c.costeUnit) {
    const cu = parseNum(r[c.costeUnit]);
    if (!isNaN(cu) && cu > 0) return cu;
  }
  let base = parseNum(r[c.directo]);
  if (isNaN(base) || base <= 0) return NaN;
  [c.d1, c.d2, c.d3].forEach((col) => {
    if (!col) return;
    const d = parseNum(r[col]);
    if (!isNaN(d) && d > 0) base = base * (1 - d / 100);
  });
  return base;
}

export default function Precios({ lineas, pedidos }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null); // {codigo, desc}
  const [modo, setModo] = useState("articulo"); // articulo | compradores
  const [compradorSel, setCompradorSel] = useState(null);
  const [ofertas, setOfertas] = useState(null); // {codigo, desc, ot, pcNeto, pcProv, lista:[...]}

  // Memoria histórica (fichas por OT), para el histórico de VENTA del
  // artículo seleccionado — esta pantalla solo tenía datos de compra.
  const [fichas, setFichas] = useState(null);
  const [indicesExtra, setIndicesExtra] = useState([]);
  const [mapeoOk, setMapeoOk] = useState(false);
  useEffect(() => {
    (async () => {
      await cargarMapeoArticulos();
      setMapeoOk(true);
      try {
        const est = await fetch("/api/estado").then((r) => r.json());
        if (est.fichas?.length) setFichas(new Map(est.fichas));
        setIndicesExtra(
          [est.indice_hist_also, est.indice_hist_ferros].filter((x) => x && (x.compra || x.venta))
        );
      } catch {}
    })();
  }, []);

  const optsHist = useMemo(() => {
    if (!sel?.codigo || !mapeoOk) return { aliases: [], indicesExtra, etiquetaEmpresa: etiquetaEmpresaParaCodigo };
    const fam = familiaDe(sel.codigo);
    return {
      aliases: fam.codigos,
      metaMapeo: fam.meta,
      indicesExtra,
      etiquetaEmpresa: etiquetaEmpresaParaCodigo,
    };
  }, [sel, mapeoOk, indicesExtra]);

  // Histórico de venta del artículo seleccionado (más reciente primero)
  const historialVenta = useMemo(() => {
    if (!fichas || !sel) return [];
    return historialVentaArticulo(sel.codigo, sel.desc, fichas, optsHist).filter((v) => v.precioUnitario > 0);
  }, [fichas, sel, optsHist]);

  const resumenVenta = useMemo(() => {
    if (!historialVenta.length) return null;
    const precios = historialVenta.map((v) => v.precioUnitario);
    const ultimo = historialVenta[0]; // ya viene ordenado por reciencia
    const min = historialVenta.reduce((a, b) => (b.precioUnitario < a.precioUnitario ? b : a));
    const max = historialVenta.reduce((a, b) => (b.precioUnitario > a.precioUnitario ? b : a));
    const media = precios.reduce((s, p) => s + p, 0) / precios.length;
    const clientes = new Set(historialVenta.map((v) => v.cliente).filter(Boolean));
    return { ultimo, min, max, media, nClientes: clientes.size };
  }, [historialVenta]);

  const c = useMemo(() => (lineas?.headers?.length ? cols(lineas.headers) : null), [lineas]);
  const cp = useMemo(() => (pedidos?.headers?.length ? colsPedidos(pedidos.headers) : null), [pedidos]);

  // comprador por nº de pedido (PC)
  const compradorPorPC = useMemo(() => {
    const map = {};
    if (!cp?.num || !pedidos?.rows) return map;
    pedidos.rows.forEach((r) => {
      const pc = String(r[cp.num] || "").trim().toUpperCase();
      if (!pc) return;
      map[pc] = {
        comprador: cp.comprador ? String(r[cp.comprador] || "").trim() : "",
        creadoPor: cp.creadoPor ? String(r[cp.creadoPor] || "").trim() : "",
      };
    });
    return map;
  }, [pedidos, cp]);

  // Buscador: lista de artículos únicos que coinciden
  const resultados = useMemo(() => {
    if (!c || q.trim().length < 2) return [];
    const qq = sinAcentos(q.trim().toLowerCase());
    const vistos = new Map();
    for (const r of lineas.rows) {
      const codigo = String(r[c.cod] || "").trim();
      const desc = String(r[c.desc] || "").trim();
      if (!codigo && !desc) continue;
      const hay = sinAcentos((codigo + " " + desc).toLowerCase());
      if (!hay.includes(qq)) continue;
      const clave = codigo || desc.toLowerCase();
      if (!vistos.has(clave)) vistos.set(clave, { codigo, desc });
      if (vistos.size >= 30) break;
    }
    return [...vistos.values()];
  }, [q, c, lineas]);

  // Detalle de un artículo: todas sus compras (Also + Ferros si hay mapeo)
  const detalle = useMemo(() => {
    if (!c || !sel) return null;
    const fam = sel.codigo && mapeoOk ? familiaDe(sel.codigo) : { codigos: sel.codigo ? [sel.codigo] : [] };
    const aliasSet = new Set((fam.codigos || []).map((x) => String(x).trim()).filter(Boolean));
    if (sel.codigo) aliasSet.add(String(sel.codigo).trim());
    const compras = [];
    for (const r of lineas.rows) {
      const cod = String(r[c.cod] || "").trim();
      const desc = String(r[c.desc] || "").trim();
      const match = aliasSet.size ? aliasSet.has(cod) : desc === sel.desc;
      if (!match) continue;
      const neto = precioNeto(r, c);
      if (isNaN(neto) || neto <= 0) continue;
      const ds = [c.d1, c.d2, c.d3].map((col) => (col ? parseNum(r[col]) : NaN)).filter((v) => !isNaN(v) && v > 0);
      compras.push({
        f: c.fecha ? parseFecha(r[c.fecha]) : null,
        fStr: c.fecha ? String(r[c.fecha] || "").trim() : "",
        pc: String(r[c.doc] || "").trim(),
        prov: String(r[c.prov] || "").trim(),
        cant: r[c.cant],
        precio: neto,
        dto: ds.length ? ds.map((v) => fmtN(v)).join("+") + " %" : "—",
        importe: r[c.importe],
        ot: String(r[c.ot] || "").trim(),
        codigo: cod,
        empresa: etiquetaEmpresaParaCodigo(cod, fam.meta, String(r[c.ot] || "")),
      });
    }
    if (!compras.length) return { compras: [], meta: fam.meta || null };
    compras.sort((a, b) => (b.f ? b.f.getTime() : 0) - (a.f ? a.f.getTime() : 0));
    const precios = compras.map((x) => x.precio);
    const min = compras.reduce((a, b) => (b.precio < a.precio ? b : a));
    const max = compras.reduce((a, b) => (b.precio > a.precio ? b : a));
    const media = precios.reduce((s, p) => s + p, 0) / precios.length;
    const provs = [...new Set(compras.map((x) => x.prov).filter(Boolean))];
    const porProv = {};
    compras.forEach((x) => { if (x.prov) (porProv[x.prov] = porProv[x.prov] || []).push(x.precio); });
    const rankProv = Object.entries(porProv)
      .map(([p, arr]) => ({ p, media: arr.reduce((s, v) => s + v, 0) / arr.length, n: arr.length, min: Math.min(...arr) }))
      .sort((a, b) => a.media - b.media);
    return { compras, ultimo: compras[0], min, max, media, provs, rankProv, meta: fam.meta || null };
  }, [c, sel, lineas, mapeoOk]);

  // Vista compradores: histórico global de un artículo (mín 2 años) para el veredicto
  const histGlobalArticulo = useMemo(() => {
    return (codigo, desc) => {
      if (!c) return null;
      const hoy = new Date();
      const desde = new Date(hoy); desde.setFullYear(desde.getFullYear() - 2);
      let n = 0, min = null, ult = null, ultF = null;
      for (const r of lineas.rows) {
        const cod = String(r[c.cod] || "").trim();
        const d = String(r[c.desc] || "").trim();
        const match = (() => {
          if (!codigo) return d === desc;
          const fam = mapeoOk ? familiaDe(codigo) : { codigos: [codigo] };
          const set = new Set((fam.codigos || []).concat(codigo).map((x) => String(x).trim()));
          return set.has(cod);
        })();
        if (!match) continue;
        const neto = precioNeto(r, c);
        if (isNaN(neto) || neto <= 0) continue;
        const f = c.fecha ? parseFecha(r[c.fecha]) : null;
        if (f && (f < desde || f > hoy)) continue;
        n++;
        if (min === null || neto < min) min = neto;
        if (f && (!ultF || f > ultF)) { ultF = f; ult = neto; }
      }
      return n ? { n, min, ult, ultF } : null;
    };
  }, [c, lineas, mapeoOk]);

  // Lista de compradores (del cruce PC → comprador)
  const compradores = useMemo(() => {
    const set = new Set(Object.values(compradorPorPC).map((v) => v.comprador).filter(Boolean));
    return [...set].sort();
  }, [compradorPorPC]);

  const detalleComprador = useMemo(() => {
    if (!c || !compradorSel) return null;
    const porArt = {};
    let totImp = 0;
    for (const r of lineas.rows) {
      const pc = String(r[c.doc] || "").trim().toUpperCase();
      if (compradorPorPC[pc]?.comprador !== compradorSel) continue;
      const cod = String(r[c.cod] || "").trim();
      const desc = String(r[c.desc] || "").trim();
      if (!desc && !cod) continue;
      const imp = parseNum(r[c.importe]); const impv = isNaN(imp) ? 0 : imp;
      const cant = parseNum(r[c.cant]); const cantv = isNaN(cant) ? 0 : cant;
      totImp += impv;
      const key = cod || desc;
      if (!porArt[key]) porArt[key] = { codigo: cod, desc, n: 0, cant: 0, importe: 0, neto: null, ultF: null };
      const a = porArt[key];
      a.n++; a.cant += cantv; a.importe += impv;
      const neto = precioNeto(r, c);
      const f = c.fecha ? parseFecha(r[c.fecha]) : null;
      if (!isNaN(neto) && (!a.ultF || (f && f > a.ultF))) { a.ultF = f; a.neto = neto; }
    }
    const lista = Object.values(porArt).sort((a, b) => b.importe - a.importe).map((a) => {
      const h = histGlobalArticulo(a.codigo, a.desc);
      let veredicto = "—", malo = false;
      if (h && h.min != null && a.neto != null) {
        const sobre = ((a.neto - h.min) / h.min) * 100;
        if (sobre <= DESV_OK) veredicto = "✓ Compra al mejor precio";
        else { veredicto = `⚠ +${sobre.toFixed(1).replace(".", ",")}% sobre el mínimo`; malo = true; }
      }
      return { ...a, h, veredicto, malo };
    });
    return { lista, totImp, malas: lista.filter((x) => x.malo).length };
  }, [c, compradorSel, compradorPorPC, lineas, histGlobalArticulo]);

  // ÚLTIMAS COMPRAS (líneas sueltas, más reciente arriba) con veredicto de
  // precio: se compara el neto de cada línea con el mínimo histórico (2 años)
  // de ese artículo. Marca ⚠ + % de más si superó el mínimo × (1 + 3%).
  const recientes = useMemo(() => {
    if (!c) return [];
    const hoy = new Date();
    const desde = new Date(hoy); desde.setFullYear(desde.getFullYear() - 2);
    const minPorArt = new Map();
    const netoDe = [];
    for (const r of lineas.rows) {
      const neto = precioNeto(r, c);
      if (isNaN(neto) || neto <= 0) { netoDe.push(NaN); continue; }
      netoDe.push(neto);
      const cod = String(r[c.cod] || "").trim();
      const desc = String(r[c.desc] || "").trim();
      const clave = cod || desc.toLowerCase();
      const f = c.fecha ? parseFecha(r[c.fecha]) : null;
      if (f && (f < desde || f > hoy)) continue;
      const prev = minPorArt.get(clave);
      if (prev == null || neto < prev) minPorArt.set(clave, neto);
    }
    const filas = [];
    lineas.rows.forEach((r, i) => {
      const neto = netoDe[i];
      if (isNaN(neto)) return;
      const cod = String(r[c.cod] || "").trim();
      const desc = String(r[c.desc] || "").trim();
      if (!cod && !desc) return;
      const doc = String(r[c.doc] || "").trim();
      // Solo PEDIDOS reales (PC), no ofertas (OC)
      if (!/^pc/i.test(doc)) return;
      const f = c.fecha ? parseFecha(r[c.fecha]) : null;
      const clave = cod || desc.toLowerCase();
      const min = minPorArt.get(clave);
      const sobre = min != null && min > 0 ? ((neto - min) / min) * 100 : null;
      filas.push({
        codigo: cod, desc, f,
        fStr: c.fecha ? String(r[c.fecha] || "").trim() : "",
        pc: doc,
        prov: String(r[c.prov] || "").trim(),
        cant: r[c.cant],
        neto, min,
        caro: sobre != null && sobre > DESV_OK,
        sobre,
        ot: String(r[c.ot] || "").trim(),
      });
    });
    filas.sort((a, b) => (b.f ? b.f.getTime() : 0) - (a.f ? a.f.getTime() : 0));
    return filas.slice(0, 50);
  }, [c, lineas]);

  // Reúne las OFERTAS de compra (OC) del mismo artículo + OT que un pedido
  // PC dado, para verificar si se pidió al mejor precio ofertado.
  const verOfertas = (fila) => {
    if (!c) return;
    const codObj = (fila.codigo || "").trim();
    const otObj = (fila.ot || "").trim();
    const lista = [];
    for (const r of lineas.rows) {
      const doc = String(r[c.doc] || "").trim();
      if (!/^oc/i.test(doc)) continue; // solo ofertas
      const cod = String(r[c.cod] || "").trim();
      const ot = String(r[c.ot] || "").trim();
      if (codObj ? cod !== codObj : String(r[c.desc] || "").trim() !== fila.desc) continue;
      if (ot !== otObj) continue;
      const neto = precioNeto(r, c);
      lista.push({
        doc,
        prov: String(r[c.prov] || "").trim(),
        cant: r[c.cant],
        neto: isNaN(neto) ? null : neto,
        dtos: [c.d1, c.d2, c.d3].map((col) => (col ? parseNum(r[col]) : NaN)).filter((v) => !isNaN(v) && v > 0),
      });
    }
    lista.sort((a, b) => {
      if (a.neto == null && b.neto == null) return 0;
      if (a.neto == null) return 1;
      if (b.neto == null) return -1;
      return a.neto - b.neto;
    });
    const mejor = lista.find((x) => x.neto != null && x.neto > 0);

    // HISTÓRICO de compras del artículo (todas las PC, cualquier OT), para
    // ver dentro del mismo pop-up si se ha comprado bien otras veces.
    const hist = [];
    for (const r of lineas.rows) {
      const doc = String(r[c.doc] || "").trim();
      if (!/^pc/i.test(doc)) continue; // solo pedidos reales
      const cod = String(r[c.cod] || "").trim();
      const match = codObj ? cod === codObj : String(r[c.desc] || "").trim() === fila.desc;
      if (!match) continue;
      const neto = precioNeto(r, c);
      if (isNaN(neto) || neto <= 0) continue;
      hist.push({
        f: c.fecha ? parseFecha(r[c.fecha]) : null,
        fStr: c.fecha ? String(r[c.fecha] || "").trim() : "",
        pc: doc,
        prov: String(r[c.prov] || "").trim(),
        cant: r[c.cant],
        neto,
        ot: String(r[c.ot] || "").trim(),
        comprador: (compradorPorPC[doc.toUpperCase()]?.creadoPor) || (compradorPorPC[doc.toUpperCase()]?.comprador) || "",
      });
    }
    hist.sort((a, b) => (b.f ? b.f.getTime() : 0) - (a.f ? a.f.getTime() : 0));
    const netosH = hist.map((x) => x.neto);
    const minH = netosH.length ? Math.min(...netosH) : null;
    const maxH = netosH.length ? Math.max(...netosH) : null;

    setOfertas({
      codigo: codObj, desc: fila.desc, ot: otObj,
      pc: fila.pc, pcNeto: fila.neto, pcProv: fila.prov, pcCant: fila.cant,
      lista, mejorNeto: mejor ? mejor.neto : null, mejorProv: mejor ? mejor.prov : null,
      hist, minH, maxH,
    });
  };

  // Correo de AVISO DE SOBRECOSTE al comprador (filas rojas): explica el
  // artículo, OT, precio pagado, mínimo de referencia y % de más, y copia
  // al portapapeles la tabla visual de ofertas de ese artículo+OT para
  // pegarla (Ctrl+V) en el correo, igual que el correo de revisión material.
  // El destinatario se resuelve por el "Creado por" del pedido (mapa EMAILS).
  // Si el creador es un GUID o no está en el mapa → NO se envía (sin botón).
  const EMAILS_CREADOR = {
    "RAMON.ALSO": "ramon.also@alsocasals.com",
    "CARLOS.PERES": "carlos.peres@alsocasals.com",
    "RAMON.CASTELL": "ramon.castell@alsocasals.com",
    "ANA.MORENO": "ana.moreno@ferrosca.com",
    "ADRIA.BAUTISTA": "adria.bautista@alsocasals.com",
    "ALEX.LOPEZ": "alex.lopez@alsocasals.com",
    "GABRIEL.GALVEZ": "gabriel.galvez@alsocasals.com",
    "MARIA.RUFI": "maria.rufi@alsocasals.com",
    "EDITH.GALVEZ": "edith.galvez@alsocasals.com",
    "CHRISTIAN QUERALT": "christian.queralt@alsocasals.com",
    "MARC.LLAMBRICH": "marc.llambrich@alsocasals.com",
    "YULY MEDINA": "yuly.medina@alsocasals.com",
    "JORDI.COSTEA": "jordi.coste@alsocasals.com",
    "MAR.SORO": "mar.soro@ferrosca.com",
    "XAVI ALSO CASALS": "xavi.also@alsocasals.com",
    "CINTA.CASALS": "cinta.casals@alsocasals.com",
    "JESUS.CALVO": "jesus.calvo@alsocasals.com",
  };
  // Email del creador de un pedido PC (o null si GUID/desconocido)
  const emailDelPedido = (pc) => {
    const info = compradorPorPC[String(pc || "").trim().toUpperCase()];
    const creador = info?.creadoPor ? info.creadoPor.trim().toUpperCase() : "";
    return EMAILS_CREADOR[creador] || null;
  };
  const [avisoCorreo, setAvisoCorreo] = useState(null);
  // Avisos ya enviados (marca azul), COMPARTIDOS entre equipos vía backend
  // (/api/avisos). Clave "pc|codigo". Se cargan al abrir la pantalla.
  const [enviados, setEnviados] = useState(new Set());
  useEffect(() => {
    fetch("/api/avisos")
      .then((r) => r.json())
      .then((d) => setEnviados(new Set(Object.keys(d.enviados || {}))))
      .catch(() => {});
  }, []);
  const marcarEnviado = (clave) => {
    setEnviados((prev) => {
      const s = new Set(prev); s.add(clave); return s;
    });
    fetch("/api/avisos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enviados: { [clave]: { ts: new Date().toISOString() } } }),
    }).catch(() => {});
  };

  const construirHtmlSobrecoste = (fila, ofs, histInfo) => {
    const E = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const pct = fila.sobre != null ? fila.sobre.toFixed(1).replace(".", ",") : "?";
    const filasOf = (ofs || [])
      .map((o) => {
        const esMejor = o.neto != null && o.neto > 0 && ofs.mejorNeto != null && o.neto === ofs.mejorNeto;
        return `<tr${esMejor ? ' style="background:#ecfdf3;"' : ""}>
          <td style="padding:10px 14px;border-bottom:1px solid #edf0f2;font-family:Consolas,monospace;font-size:12px;color:#475467;">${E(o.doc)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #edf0f2;font-size:13px;">${E(o.prov) || "—"}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #edf0f2;font-size:13px;text-align:right;font-weight:${esMejor ? "700" : "400"};color:${esMejor ? "#15803d" : "#1f2937"};white-space:nowrap;">${o.neto == null || o.neto === 0 ? "sin valorar" : fmtP(o.neto)}${esMejor ? " ✅" : ""}</td>
        </tr>`;
      })
      .join("");
    const lineaHist = histInfo && histInfo.minNeto != null
      ? `<table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px 0;background:#ecfdf3;border:1px solid #abefc6;border-radius:10px;">
           <tr><td style="padding:14px 18px;">
             <div style="font-size:12px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px;">💚 Millor preu de compra històric</div>
             <div style="font-size:20px;font-weight:800;color:#15803d;">${fmtP(histInfo.minNeto)}</div>
             <div style="font-size:13px;color:#475467;margin-top:4px;">${E(histInfo.minProv) || "—"}${histInfo.minFecha ? ` · 🗓️ ${E(histInfo.minFecha)}` : ""}${histInfo.minPC ? ` · comanda ${E(histInfo.minPC)}` : ""}</div>
           </td></tr>
         </table>`
      : "";
    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:720px;line-height:1.5;">
      <p style="font-size:15px;margin:0 0 16px 0;">Bon dia,</p>
      <p style="font-size:15px;margin:0 0 22px 0;">⚠️ Hem detectat que en la següent compra <b>el preu pagat està per sobre del mínim històric</b> d'aquest article. Us ho comuniquem per revisar-ho:</p>

      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
        <tr><td style="padding:18px 20px;">
          <div style="font-size:16px;font-weight:800;color:#0f2740;margin-bottom:2px;">📦 ${E(fila.desc)}</div>
          <div style="font-family:Consolas,monospace;font-size:12px;color:#64748b;margin-bottom:14px;">${E(fila.codigo)}</div>

          <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;">
            <tr>
              <td style="padding:4px 0;color:#64748b;width:130px;">🔧 OT</td>
              <td style="padding:4px 0;font-weight:600;">${E(fila.ot) || "—"}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#64748b;">📄 Comanda</td>
              <td style="padding:4px 0;font-weight:600;">${E(fila.pc)}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#64748b;">🏭 Proveïdor</td>
              <td style="padding:4px 0;font-weight:600;">${E(fila.prov) || "—"}</td>
            </tr>
          </table>
        </td></tr>
      </table>

      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px 0;">
        <tr>
          <td style="padding:0 6px 0 0;width:33%;">
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#fff1f2;border:1px solid #fecdca;border-radius:10px;"><tr><td style="padding:14px 16px;">
              <div style="font-size:11px;font-weight:700;color:#b42318;text-transform:uppercase;">Preu pagat</div>
              <div style="font-size:22px;font-weight:800;color:#b42318;margin-top:2px;">${fmtP(fila.neto)}</div>
            </td></tr></table>
          </td>
          <td style="padding:0 6px;width:33%;">
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#ecfdf3;border:1px solid #abefc6;border-radius:10px;"><tr><td style="padding:14px 16px;">
              <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;">Mínim (2 anys)</div>
              <div style="font-size:22px;font-weight:800;color:#15803d;margin-top:2px;">${fila.min != null ? fmtP(fila.min) : "—"}</div>
            </td></tr></table>
          </td>
          <td style="padding:0 0 0 6px;width:33%;">
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;"><tr><td style="padding:14px 16px;">
              <div style="font-size:11px;font-weight:700;color:#b45309;text-transform:uppercase;">Desviació</div>
              <div style="font-size:22px;font-weight:800;color:#b45309;margin-top:2px;">+${pct}%</div>
              ${fila.difUnit != null ? `<div style="font-size:12px;color:#b45309;margin-top:2px;">+${fmtP(fila.difUnit)}/ud</div>` : ""}
            </td></tr></table>
          </td>
        </tr>
      </table>

      ${fila.sobreTotal != null ? `<table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px 0;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;"><tr><td style="padding:16px 18px;text-align:center;">
        <div style="font-size:12px;font-weight:700;color:#b42318;text-transform:uppercase;letter-spacing:.3px;">💸 Sobrecost estimat d'aquesta compra</div>
        <div style="font-size:26px;font-weight:800;color:#b42318;margin-top:4px;">${fmtE(fila.sobreTotal)}</div>
        <div style="font-size:12px;color:#991b1b;margin-top:2px;">${fmtN(fila.cant)} ud × +${fmtP(fila.difUnit)}/ud respecte al mínim</div>
      </td></tr></table>` : ""}

      ${lineaHist}

      <div style="font-size:15px;font-weight:700;color:#0f2740;margin:0 0 10px 0;">📋 Ofertes de compra d'aquest article i OT</div>
      <table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #d9e1e7;border-radius:10px;border-collapse:collapse;overflow:hidden;">
        <thead><tr>
          ${["Nº oferta", "Proveïdor", "Preu net"].map((h) => `<th style="background:#f9fafb;color:#374151;text-align:${h === "Preu net" ? "right" : "left"};font-size:12px;font-weight:700;padding:12px 14px;border-bottom:1px solid #e5e7eb;">${h}</th>`).join("")}
        </tr></thead>
        <tbody>${filasOf || `<tr><td colspan="3" style="padding:14px;color:#94a3b8;font-size:13px;">No hi ha ofertes registrades per a aquest article i OT.</td></tr>`}</tbody>
      </table>

      <p style="font-size:15px;margin:22px 0 8px 0;">Podríeu revisar si aquesta compra es podia haver fet a un preu millor?</p>
      <p style="font-size:15px;margin:0;">Gràcies! 🙏</p>
    </div>`;
  };

  const avisarSobrecoste = async (fila) => {
    // reunir ofertas del artículo+OT (mismo cálculo que verOfertas)
    const codObj = (fila.codigo || "").trim();
    const otObj = (fila.ot || "").trim();
    const ofs = [];
    for (const r of lineas.rows) {
      const doc = String(r[c.doc] || "").trim();
      if (!/^oc/i.test(doc)) continue;
      const cod = String(r[c.cod] || "").trim();
      const ot = String(r[c.ot] || "").trim();
      if (codObj ? cod !== codObj : String(r[c.desc] || "").trim() !== fila.desc) continue;
      if (ot !== otObj) continue;
      const neto = precioNeto(r, c);
      ofs.push({ doc, prov: String(r[c.prov] || "").trim(), neto: isNaN(neto) ? null : neto });
    }
    ofs.sort((a, b) => (a.neto == null ? 1 : b.neto == null ? -1 : a.neto - b.neto));
    const mejor = ofs.find((x) => x.neto != null && x.neto > 0);
    ofs.mejorNeto = mejor ? mejor.neto : null;

    // Mejor precio histórico (compras PC del artículo, cualquier OT)
    let histInfo = { minNeto: null, minProv: "", minFecha: "", minPC: "" };
    for (const r of lineas.rows) {
      const doc = String(r[c.doc] || "").trim();
      if (!/^pc/i.test(doc)) continue;
      const cod = String(r[c.cod] || "").trim();
      const match = codObj ? cod === codObj : String(r[c.desc] || "").trim() === fila.desc;
      if (!match) continue;
      const neto = precioNeto(r, c);
      if (isNaN(neto) || neto <= 0) continue;
      if (histInfo.minNeto == null || neto < histInfo.minNeto) {
        histInfo = {
          minNeto: neto,
          minProv: String(r[c.prov] || "").trim(),
          minFecha: c.fecha ? String(r[c.fecha] || "").trim() : "",
          minPC: doc,
        };
      }
    }

    const pct = fila.sobre != null ? fila.sobre.toFixed(1).replace(".", ",") : "?";
    // Sobrecoste respecto al mínimo de referencia: por unidad y total
    const cantN = parseNum(fila.cant);
    const difUnit = fila.min != null ? fila.neto - fila.min : null;
    const sobreTotal = difUnit != null && !isNaN(cantN) && cantN > 0 ? difUnit * cantN : null;
    const filaExt = { ...fila, difUnit, sobreTotal };
    const destino = emailDelPedido(fila.pc);
    if (!destino) { setAvisoCorreo("sin-email"); return; }
    const asunto = `Revisió preu compra ${fila.pc} — ${fila.codigo} (+${pct}% sobre mínim)`;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([construirHtmlSobrecoste(filaExt, ofs, histInfo)], { type: "text/html" }),
          "text/plain": new Blob(["(Enganxa amb Ctrl+V per veure el detall i les ofertes)"], { type: "text/plain" }),
        }),
      ]);
      setAvisoCorreo(fila.pc + "|" + fila.codigo);
      marcarEnviado(fila.pc + "|" + fila.codigo);
      window.location.href = `mailto:${destino}?subject=${encodeURIComponent(asunto)}`;
    } catch {
      const millor = histInfo.minNeto != null ? `\r\nMillor preu històric: ${fmtP(histInfo.minNeto)}${histInfo.minProv ? " · " + histInfo.minProv : ""}${histInfo.minFecha ? " · " + histInfo.minFecha : ""}` : "";
      const sobre = sobreTotal != null ? `\r\nSobrecost estimat: ${fmtE(sobreTotal)} (${fmtN(fila.cant)} ud × +${fmtP(difUnit)}/ud)` : "";
      const cuerpo =
        `Bon dia,\r\n\r\nHem detectat que en la comanda ${fila.pc} el preu pagat de l'article ${fila.codigo} (${fila.desc}) està per sobre del mínim històric.\r\n\r\n` +
        `OT: ${fila.ot}\r\nProveïdor: ${fila.prov}\r\nPreu pagat: ${fmtP(fila.neto)}\r\nMínim de referència: ${fila.min != null ? fmtP(fila.min) : "—"}\r\nDesviació: +${pct}% sobre el mínim${sobre}${millor}\r\n\r\n` +
        `Podríeu revisar si es podia comprar més barat? Gràcies.`;
      marcarEnviado(fila.pc + "|" + fila.codigo);
      window.location.href = `mailto:${destino}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
    }
  };

  if (!lineas?.rows?.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Precios de artículos</h1>
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          Carga las «Líneas de Compra» en «Cargar datos» para analizar el histórico de precios.
        </div>
      </div>
    );
  }

  // === VISTA: DETALLE DE COMPRADOR ===
  if (modo === "compradores" && compradorSel && detalleComprador) {
    const d = detalleComprador;
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setCompradorSel(null)} className="flex items-center gap-1 text-sm text-blue-700 hover:underline">
            <ArrowLeft size={15} /> Volver
          </button>
          <h1 className="text-xl font-bold text-slate-800">🧑‍💼 {compradorSel}</h1>
          <span className="text-sm text-slate-500">
            {d.lista.length} artículos · {fmtE(d.totImp)}
            {d.malas ? <span className="text-red-600 font-semibold"> · ⚠ {d.malas} por encima del mínimo</span> : <span className="text-emerald-600"> · todo a buen precio</span>}
          </span>
        </div>
        <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-left">
                {["Nº artículo", "Descripción", "Cant.", "Importe", "Su último neto", "¿Compra bien?", "Histórico BC"].map((h) => (
                  <th key={h} className="px-2 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.lista.map((a, i) => (
                <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
                  <td className="px-2 py-1.5 font-mono text-[11px]">{a.codigo || "—"}</td>
                  <td className="px-2 py-1.5">{a.desc}</td>
                  <td className="px-2 py-1.5 text-right">{fmtN(a.cant)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{fmtE(a.importe)}</td>
                  <td className="px-2 py-1.5 text-right">{a.neto != null ? fmtP(a.neto) : "—"}</td>
                  <td className={`px-2 py-1.5 whitespace-nowrap ${a.malo ? "text-red-600 font-semibold" : "text-emerald-700"}`}>{a.veredicto}</td>
                  <td className="px-2 py-1.5 text-[11px] text-slate-500">
                    {a.h && a.h.min != null ? `Mín. 2a: ${fmtP(a.h.min)} · ${a.h.n} compra${a.h.n > 1 ? "s" : ""}` : "sin histórico"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          «¿Compra bien?» compara el último precio neto pagado con el mínimo de los últimos 2 años del mismo artículo. ⚠ si paga más del {DESV_OK}% por encima.
        </p>
      </div>
    );
  }

  // === VISTA: LISTA DE COMPRADORES ===
  if (modo === "compradores") {
    return (
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-800">¿Quién compra bien?</h1>
          <button onClick={() => setModo("articulo")} className="flex items-center gap-1.5 text-sm font-semibold text-blue-700 hover:underline">
            <Search size={14} /> Buscar artículo
          </button>
        </div>
        <p className="text-slate-500 text-sm mt-1">Elige un comprador para revisar si compra al mejor precio (cruce pedidos↔líneas por Nº de pedido).</p>
        {!cp?.comprador ? (
          <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
            Falta el dataset «Pedidos de Compra» (con el comprador) para esta vista. Cárgalo en «Cargar datos».
          </div>
        ) : compradores.length === 0 ? (
          <div className="mt-6 text-slate-400 text-sm">No se han encontrado compradores en los pedidos cargados.</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-5">
            {compradores.map((comp) => (
              <button key={comp} onClick={() => setCompradorSel(comp)} className="bg-white border border-slate-200 rounded-lg px-3 py-3 text-left hover:border-blue-400 hover:bg-blue-50/40">
                <div className="font-semibold text-slate-700 text-sm">{comp}</div>
                <div className="text-[11px] text-blue-600 mt-0.5">Ver qué compra →</div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // === VISTA: DETALLE DE ARTÍCULO ===
  if (sel && detalle) {
    const d = detalle;
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setSel(null)} className="flex items-center gap-1 text-sm text-blue-700 hover:underline">
            <ArrowLeft size={15} /> Volver a la búsqueda
          </button>
        </div>
        {d.compras.length === 0 ? (
          <div className="text-slate-400 text-sm">Sin compras registradas de este artículo.</div>
        ) : (
          <>
            <h2 className="text-lg font-bold text-slate-800">{sel.desc}</h2>
            <div className="font-mono text-[11px] text-slate-400 mb-1">{sel.codigo || "(sin código)"}</div>
            {detalle?.meta && (
              <div className="text-[10px] text-slate-600 mb-3 flex flex-wrap items-center gap-1.5">
                <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{detalle.meta.codigo_viejo}</span>
                <span>→</span>
                <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{detalle.meta.codigo_nuevo}</span>
                <span className={`px-1.5 py-0.5 rounded font-semibold ${detalle.meta.pendienteSync ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                  {detalle.meta.estado}{detalle.meta.pendienteSync ? " · sync pendiente" : ""}
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
              <Ficha l="Último precio" v={fmtP(d.ultimo.precio)} sub={`${fmtD(d.ultimo.f)} · ${d.ultimo.prov}`} />
              <Ficha l="Precio mínimo" v={fmtP(d.min.precio)} sub={`${fmtD(d.min.f)} · ${d.min.prov}`} color="text-emerald-600" />
              <Ficha l="Precio máximo" v={fmtP(d.max.precio)} sub={`${fmtD(d.max.f)} · ${d.max.prov}`} color="text-red-600" />
              <Ficha l="Precio medio" v={fmtP(d.media)} />
              <Ficha l="Compras" v={d.compras.length} />
              <Ficha l="Proveedores" v={d.provs.length} />
            </div>

            {d.rankProv.length > 1 && (
              <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4">
                <div className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5"><TrendingDown size={14} /> Precio medio por proveedor (más barato primero)</div>
                <table className="w-full text-[12px]">
                  <thead><tr className="text-slate-500 text-left"><th className="py-1">Proveedor</th><th className="py-1 text-right">Medio</th><th className="py-1 text-right">Mínimo</th><th className="py-1 text-right">Compras</th></tr></thead>
                  <tbody>
                    {d.rankProv.map((x, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1">{x.p}</td>
                        <td className={`py-1 text-right ${i === 0 ? "text-emerald-700 font-bold" : ""}`}>{fmtP(x.media)}{i === 0 ? " ✓" : ""}</td>
                        <td className="py-1 text-right">{fmtP(x.min)}</td>
                        <td className="py-1 text-right">{x.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-xs font-bold text-slate-800 mb-2">🕓 Histórico de compras (más reciente primero)</div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-slate-500 text-left">
                      {["Fecha", "Pedido", "Proveedor", "Cant.", "Precio neto", "Dto", "Importe", "OT"].map((h) => <th key={h} className="py-1 px-1">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.compras.map((x, i) => {
                      const esMin = x.precio === d.min.precio;
                      const esMax = x.precio === d.max.precio;
                      const caro = x.precio > d.min.precio * (1 + DESV_OK / 100);
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1 px-1 whitespace-nowrap">{x.fStr || "—"}</td>
                          <td className="py-1 px-1 font-mono">{x.pc || "—"}</td>
                          <td className="py-1 px-1">{x.prov || "—"}</td>
                          <td className="py-1 px-1 text-right">{fmtN(x.cant)}</td>
                          <td className={`py-1 px-1 text-right font-semibold ${esMin ? "text-emerald-600" : esMax ? "text-red-600" : caro ? "text-orange-600" : ""}`}>
                            {fmtP(x.precio)}{caro && !esMax ? " ⚠" : ""}
                          </td>
                          <td className="py-1 px-1">{x.dto}</td>
                          <td className="py-1 px-1 text-right">{fmtN(x.importe)} €</td>
                          <td className="py-1 px-1 font-mono">{x.ot || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Precio neto (con descuentos aplicados). <span className="text-emerald-600">Verde</span> el mínimo, <span className="text-red-600">rojo</span> el máximo, <span className="text-orange-600">⚠</span> más del {DESV_OK}% sobre el mínimo.
              </p>
            </div>

            {/* HISTÓRICO DE VENTA — de la memoria histórica (fichas por OT),
                no de las líneas de compra que alimentan el resto de esta
                pantalla. Se carga aparte desde /api/estado. */}
            <div className="bg-white border border-slate-200 rounded-lg p-3 mt-4">
              <div className="text-xs font-bold text-slate-800 mb-2">💶 Histórico de venta (más reciente primero)</div>
              {fichas == null ? (
                <div className="text-slate-400 text-sm py-2">Cargando memoria histórica…</div>
              ) : historialVenta.length === 0 ? (
                <div className="text-slate-400 text-sm py-2">Sin ventas registradas de este artículo en la memoria histórica.</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
                    <Ficha l="Último precio" v={fmtP(resumenVenta.ultimo.precioUnitario)} sub={`${fmtD(resumenVenta.ultimo.fechaPedido ? new Date(resumenVenta.ultimo.fechaPedido) : null)} · ${resumenVenta.ultimo.cliente || "—"}`} color="text-blue-700" />
                    <Ficha l="Precio mínimo" v={fmtP(resumenVenta.min.precioUnitario)} sub={resumenVenta.min.cliente || "—"} color="text-emerald-600" />
                    <Ficha l="Precio máximo" v={fmtP(resumenVenta.max.precioUnitario)} sub={resumenVenta.max.cliente || "—"} color="text-red-600" />
                    <Ficha l="Precio medio" v={fmtP(resumenVenta.media)} />
                    <Ficha l="Clientes" v={resumenVenta.nClientes} />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-slate-500 text-left">
                          {["Fecha", "Documento", "Nº OT", "Cliente", "Cant.", "Precio unit.", "% Dto.", "Importe"].map((h) => (
                            <th key={h} className="py-1 px-1">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {historialVenta.map((v, i) => {
                          const esMin = v.precioUnitario === resumenVenta.min.precioUnitario;
                          const esMax = v.precioUnitario === resumenVenta.max.precioUnitario && resumenVenta.min.precioUnitario !== resumenVenta.max.precioUnitario;
                          const dtos = (v.dtos || []).filter((d) => d > 0);
                          const fecha = v.fechaPedido ? new Date(v.fechaPedido) : null;
                          return (
                            <tr key={i} className="border-t border-slate-100">
                              <td className="py-1 px-1 whitespace-nowrap">{fmtD(fecha)}</td>
                              <td className="py-1 px-1 font-mono">{v.numeroDocumento || "—"}</td>
                              <td className="py-1 px-1 font-mono">{v.ot || "—"}</td>
                              <td className="py-1 px-1 max-w-[180px] truncate" title={v.cliente}>{v.cliente || "—"}</td>
                              <td className="py-1 px-1 text-right">{fmtN(v.cantidad)}</td>
                              <td className={`py-1 px-1 text-right font-semibold ${esMin ? "text-emerald-600" : esMax ? "text-red-600" : ""}`}>{fmtP(v.precioUnitario)}</td>
                              <td className="py-1 px-1">{dtos.length ? dtos.map((d) => fmtN(d)).join("+") + " %" : "—"}</td>
                              <td className="py-1 px-1 text-right">{fmtE(v.importe)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2">
                    <span className="text-emerald-600">Verde</span> el precio de venta más bajo, <span className="text-red-600">rojo</span> el más alto cobrado.
                  </p>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // === VISTA: BUSCADOR ===
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Precios de artículos</h1>
          <p className="text-slate-500 text-sm mt-1">Histórico de compras de un artículo: mínimo, medio, último, por proveedor y si se ha comprado bien.</p>
        </div>
        <button onClick={() => { setModo("compradores"); setCompradorSel(null); }} className="flex items-center gap-1.5 text-sm font-semibold text-blue-700 bg-white border border-blue-300 rounded-md px-3 py-1.5 hover:bg-blue-50">
          <Users size={14} /> ¿Quién compra bien?
        </button>
      </div>
      <div className="relative mt-5 max-w-lg">
        <Search size={16} className="absolute left-3 top-3 text-slate-400" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busca por código o descripción (mín. 2 letras)…" className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg text-sm" />
      </div>
      {q.trim().length >= 2 && (
        <div className="mt-3 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100 max-w-2xl">
          {resultados.length === 0 && <div className="px-3 py-3 text-slate-400 text-sm">Sin coincidencias.</div>}
          {resultados.map((r, i) => (
            <button key={i} onClick={() => setSel(r)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-blue-50/50 text-[13px]">
              <span className="font-mono text-blue-700 w-32 truncate shrink-0">{r.codigo || "—"}</span>
              <span className="text-slate-700 flex-1 truncate">{r.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* ÚLTIMAS COMPRAS — solo cuando no se está buscando */}
      {q.trim().length < 2 && recientes.length > 0 && (
        <div className="mt-6">
          <div className="text-sm font-bold text-slate-700 mb-2">🕓 Últimas compras — ¿al mejor precio?</div>
          <div className="overflow-x-auto bg-white border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-left">
                  {["Fecha", "Pedido", "Artículo", "Proveedor", "Cant.", "Precio neto", "Mínimo ref.", "¿Bien comprado?", "OT", ""].map((h) => (
                    <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recientes.map((x, i) => (
                  <tr
                    key={i}
                    onClick={() => verOfertas(x)}
                    className={`border-t border-slate-100 cursor-pointer hover:bg-blue-50/40 ${x.caro ? "bg-red-50/40" : ""}`}
                    title="Ver ofertas de compra pedidas para esta OT y artículo"
                  >
                    <td className="px-2 py-1.5 whitespace-nowrap">{x.fStr || "—"}</td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap">{x.pc || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[280px] truncate" title={`${x.codigo} · ${x.desc}`}>
                      <span className="font-mono text-blue-700">{x.codigo || "—"}</span> <span className="text-slate-600">{x.desc}</span>
                    </td>
                    <td className="px-2 py-1.5 max-w-[150px] truncate" title={x.prov}>{x.prov || "—"}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">{fmtN(x.cant)}</td>
                    <td className={`px-2 py-1.5 text-right whitespace-nowrap font-semibold ${x.caro ? "text-red-600" : "text-slate-700"}`}>{fmtP(x.neto)}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap text-emerald-700">{x.min != null ? fmtP(x.min) : "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {x.sobre == null ? (
                        <span className="text-slate-400">—</span>
                      ) : x.caro ? (
                        <span className="text-red-600 font-semibold">
                          ⚠ +{x.sobre.toFixed(1).replace(".", ",")}% sobre mín.
                          {(() => {
                            const cn = parseNum(x.cant);
                            const tot = x.min != null && !isNaN(cn) && cn > 0 ? (x.neto - x.min) * cn : null;
                            return tot != null ? <span className="text-red-500 font-normal"> · {fmtE(tot)} de más</span> : null;
                          })()}
                        </span>
                      ) : (
                        <span className="text-emerald-600">✓ al mejor precio</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap">{x.ot || "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      {x.caro && emailDelPedido(x.pc) && (() => {
                        const clave = x.pc + "|" + x.codigo;
                        const yaEnviado = enviados.has(clave);
                        return (
                          <button
                            onClick={(e) => { e.stopPropagation(); avisarSobrecoste(x); }}
                            title={yaEnviado ? `Avís enviat a ${emailDelPedido(x.pc)} (clica per reenviar)` : `Avisar a ${emailDelPedido(x.pc)}: preu per sobre del mínim`}
                            className={`rounded p-1 ${yaEnviado ? "text-white bg-blue-600 hover:bg-blue-700" : "text-blue-600 hover:text-blue-800 hover:bg-blue-50"}`}
                          >
                            <Mail size={14} fill={yaEnviado ? "currentColor" : "none"} />
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Las {recientes.length} compras (PC) más recientes. <span className="text-red-600">⚠</span> marca cuando el precio neto pagado supera en más del {DESV_OK}% el mínimo de los últimos 2 años. Clic en una fila para ver las ofertas de compra pedidas para esa OT y artículo.
          </p>
        </div>
      )}

      {/* POP-UP: ofertas de compra (OC) del mismo artículo + OT */}
      {ofertas && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setOfertas(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[92vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between p-4 border-b border-slate-200">
              <div>
                <div className="text-sm font-bold text-slate-800">Ofertas de compra pedidas</div>
                <div className="text-[12px] text-slate-500 mt-0.5">
                  <span className="font-mono text-blue-700">{ofertas.codigo || "—"}</span> · {ofertas.desc}
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">OT {ofertas.ot || "—"} · Pedido {ofertas.pc}</div>
              </div>
              <button onClick={() => setOfertas(null)} className="text-slate-400 hover:text-slate-600 p-1">✕</button>
            </div>

            <div className="p-4 overflow-y-auto">
              {/* Resumen: qué se pidió vs mejor oferta */}
              <div className="flex flex-wrap gap-2 mb-3">
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <div className="text-[9px] font-bold text-slate-400 uppercase">Se pidió (PC)</div>
                  <div className="text-sm font-bold text-slate-800">{fmtP(ofertas.pcNeto)}</div>
                  <div className="text-[10px] text-slate-400 truncate max-w-[180px]" title={ofertas.pcProv}>{ofertas.pcProv || "—"}</div>
                </div>
                {ofertas.mejorNeto != null && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <div className="text-[9px] font-bold text-emerald-600 uppercase">Mejor oferta</div>
                    <div className="text-sm font-bold text-emerald-700">{fmtP(ofertas.mejorNeto)}</div>
                    <div className="text-[10px] text-slate-400 truncate max-w-[180px]" title={ofertas.mejorProv}>{ofertas.mejorProv || "—"}</div>
                  </div>
                )}
                {ofertas.mejorNeto != null && ofertas.pcNeto != null && (
                  (() => {
                    const dif = ofertas.pcNeto - ofertas.mejorNeto;
                    const pct = ofertas.mejorNeto > 0 ? (dif / ofertas.mejorNeto) * 100 : 0;
                    const ok = dif <= ofertas.mejorNeto * (DESV_OK / 100) + 1e-9;
                    const cantPC = parseNum(ofertas.pcCant);
                    const sobreTotal = !isNaN(cantPC) && cantPC > 0 ? dif * cantPC : null;
                    return (
                      <div className={`border rounded-lg px-3 py-2 ${ok ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
                        <div className={`text-[9px] font-bold uppercase ${ok ? "text-emerald-600" : "text-red-600"}`}>Veredicto</div>
                        <div className={`text-sm font-bold ${ok ? "text-emerald-700" : "text-red-600"}`}>
                          {ok ? "✓ Se pidió al mejor precio" : `⚠ +${pct.toFixed(1).replace(".", ",")}% sobre la mejor`}
                        </div>
                        {!ok && (
                          <div className="text-[11px] text-red-600 mt-0.5">
                            +{fmtP(dif)}/ud{sobreTotal != null ? ` · ${fmtE(sobreTotal)} de más (${fmtN(ofertas.pcCant)} ud)` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>

              {ofertas.lista.length === 0 ? (
                <div className="text-slate-400 text-sm py-4 text-center">
                  No se han encontrado ofertas de compra (OC) para esta OT y artículo.
                </div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 text-left">
                      {["Nº oferta", "Proveedor", "Cant.", "% Dto.", "Precio neto"].map((h) => (
                        <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ofertas.lista.map((o, i) => {
                      const esMejor = ofertas.mejorNeto != null && o.neto === ofertas.mejorNeto;
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${esMejor ? "bg-emerald-50/50" : ""}`}>
                          <td className="px-2 py-1.5 font-mono whitespace-nowrap">{o.doc}</td>
                          <td className="px-2 py-1.5 max-w-[200px] truncate" title={o.prov}>{o.prov || "—"}</td>
                          <td className="px-2 py-1.5 text-right">{fmtN(o.cant)}</td>
                          <td className="px-2 py-1.5 text-right">{o.dtos.length ? o.dtos.map((v) => fmtN(v)).join("+") + " %" : "—"}</td>
                          <td className={`px-2 py-1.5 text-right font-semibold ${o.neto == null || o.neto === 0 ? "text-slate-400" : esMejor ? "text-emerald-700" : ""}`}>
                            {o.neto == null || o.neto === 0 ? "sin valorar" : fmtP(o.neto)}{esMejor ? " ✓" : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* HISTÓRICO de compras del artículo */}
              <div className="mt-5">
                <div className="text-xs font-bold text-slate-800 mb-2">🕓 Histórico de compras de este artículo (pedidos PC)</div>
                {ofertas.hist.length === 0 ? (
                  <div className="text-slate-400 text-sm py-2">Sin compras anteriores registradas.</div>
                ) : (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-slate-50 text-slate-600 text-left">
                        {["Fecha", "Pedido", "Proveedor", "Creado por", "Cant.", "Precio neto", "OT"].map((h) => (
                          <th key={h} className="px-2 py-2 font-semibold whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ofertas.hist.map((x, i) => {
                        const esMin = x.neto === ofertas.minH;
                        const esMax = x.neto === ofertas.maxH && ofertas.minH !== ofertas.maxH;
                        return (
                          <tr key={i} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 whitespace-nowrap">{x.fStr || "—"}</td>
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{x.pc}</td>
                            <td className="px-2 py-1.5 max-w-[180px] truncate" title={x.prov}>{x.prov || "—"}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" title={x.comprador}>{x.comprador || "—"}</td>
                            <td className="px-2 py-1.5 text-right">{fmtN(x.cant)}</td>
                            <td className={`px-2 py-1.5 text-right font-semibold ${esMin ? "text-emerald-600" : esMax ? "text-red-600" : ""}`}>{fmtP(x.neto)}</td>
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{x.ot || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {ofertas.hist.length > 0 && (
                  <p className="text-[11px] text-slate-400 mt-2">
                    <span className="text-emerald-600">Verde</span> el precio más bajo, <span className="text-red-600">rojo</span> el más alto pagado en pedidos anteriores.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Ficha({ l, v, sub, color = "text-slate-800" }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
      <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">{l}</div>
      <div className={`text-sm font-bold ${color}`}>{v}</div>
      {sub && <div className="text-[10px] text-slate-400 truncate mt-0.5" title={sub}>{sub}</div>}
    </div>
  );
}
