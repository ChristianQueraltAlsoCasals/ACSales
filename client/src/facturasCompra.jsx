/**
 * facturasCompra.jsx — Validación de facturas de proveedor contra BC.
 *
 * Sube el PDF de una (o varias) facturas de proveedor, la IA identifica
 * el/los número(s) de factura y, línea a línea, a qué pedido nuestro
 * (PCxx-xxxxxx) corresponde cada artículo facturado. Por cada pedido
 * referenciado se consulta Business Central (solo lectura) para saber:
 *
 *   1) si ya se ha recibido/registrado en BC la cantidad que se factura
 *      (si no, la factura no se puede entrar todavía), y
 *   2) si el precio facturado coincide con el precio del pedido en BC
 *      (con un margen pequeño para redondeos).
 *
 * Con eso se pinta un semáforo por factura: verde "se puede entrar" o
 * rojo "revisar antes", con el motivo concreto de cada aviso.
 *
 * Botón "Enviar aviso": manda un correo REAL (vía Graph, con la factura
 * en PDF adjunta — un mailto: no puede llevar adjuntos) al responsable
 * del departamento del pedido, con Administración en copia
 * (departamentos.js). El departamento se lee del propio pedido de compra
 * (columna "Cód. UN"/Shortcut Dimension 1, la misma que ya usa Recepción).
 *
 * Botón verde: crea el borrador en BC (proveedor, nº de factura y fecha)
 * y trae las líneas con «Traer albaranes de compra», para que quede el
 * Nº albarán. Alguien lo registra después en BC. Adjunta el PDF.
 * ⚠️ Primera vez que esta app ESCRIBE un documento nuevo en BC — ver
 * los comentarios de /api/facturas-compra/entrar-bc en server.cjs.
 *
 * No modifica nada en BC salvo al pulsar "Entrar en BC" — hasta entonces
 * es solo un chequeo antes de entrar la factura.
 */
import React, { Fragment, useState, useRef, useMemo, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Upload, X, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Mail, Loader2, FileCheck2, RefreshCw, History, Search, Wallet, Inbox, Send, StickyNote } from "lucide-react";
import { emailsPorCodigoDepartamento, listasCorreoDepartamento, aplicarRemitente, copiasAdministracion } from "./departamentos.js";
import { empresaGuardada } from "./empresa.jsx";
import { htmlPerEnviar } from "./correo.jsx";

/** Buzón Continia Document Capture — facturas OK validadas se reenvían aquí. */
const EMAIL_CONTINIA = "compras.alsoprod.8020885@cdc.continiaonline.com";

const fmtEur = (n) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

function selloCorreo(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function datosPedidoCargado(pedidos, numero) {
  const rows = pedidos?.rows || [];
  if (!rows.length || !numero) return {};
  const headers = pedidos.headers?.length ? pedidos.headers : Object.keys(rows[0]);
  const cols = columnasPedidos(headers);
  const row = rows.find((r) => String(r[cols.numero] || "").trim().toUpperCase() === String(numero).trim().toUpperCase());
  if (!row) return {};
  const col = (re) => headers.find((h) => re.test(h)) || "";
  const otCol = col(/shortcut_dimension_2_code|c[oó]d\.?\s*ot|\bot\b/i);
  const compCol = col(/purchaser_code|cdcpurchasercode|comprador/i);
  return {
    proveedor: cols.proveedor ? String(row[cols.proveedor] || "").trim() : "",
    fecha: cols.fecha ? String(row[cols.fecha] || "").trim().slice(0, 10) : "",
    ot: otCol ? String(row[otCol] || "").trim() : "",
    comprador: compCol ? String(row[compCol] || "").trim() : "",
  };
}

// Misma tolerancia que usa el backend (server.cjs) para decidir si un
// precio facturado "difiere" del precio en BC — se repite aquí para
// poder recalcular el semáforo al vuelo cuando el usuario corrige a mano
// la línea de BC de una factura, sin tener que volver a llamar al backend.
const TOLERANCIA_PRECIO_PCT = 0.02;
const TOLERANCIA_PRECIO_ABS = 0.02;
function precioDifiereCliente(precioFactura, precioBC) {
  if (precioFactura === null || precioFactura === undefined) return null;
  if (precioBC === null || precioBC === undefined) return null;
  const diff = Math.abs(precioFactura - precioBC);
  const tolerancia = Math.max(TOLERANCIA_PRECIO_ABS, Math.abs(precioBC) * TOLERANCIA_PRECIO_PCT);
  return diff > tolerancia;
}

// Igual que recepMapFor de recepcion.jsx: reconoce columnas en español
// (mapeadas) o crudas de BC, para no depender del nombre exacto.
function columnasPedidos(headers) {
  const lower = (headers || []).map((h) => h.toLowerCase());
  const find = (res) => {
    for (const re of res) {
      const i = lower.findIndex((h) => re.test(h));
      if (i >= 0) return headers[i];
    }
    return "";
  };
  return {
    numero: find([/^no$/, /^document_no$/, /^nº$/, /^n[º°o]\.?$/, /n[º°] pedido/, /pedido/]) || headers[0],
    departamento: find([/^shortcut_dimension_1_code$/, /departamento/, /unidad de negocio/]),
    // Añadidos para "Pedidos de compra pendientes de facturar" (ver más
    // abajo) — no se tocan las claves de arriba, que ya usa el resto del
    // archivo (departamentoDePedido).
    proveedor: find([/^buy_from_vendor_name$/, /^pay_to_name$/, /compra a-nombre/, /nombre.*proveedor/, /prove(?!.*autoriz)/]),
    descripcion: find([/^description$/, /^descripci[oó]n$/, /descripci[oó]n/]),
    cantidad: find([/^quantity$/, /^cantidad$/, /^cant\.?$/]),
    fecha: find([/^order_date$/, /fecha registro/, /fecha emisi[oó]n/, /^fecha$/, /fecha/]),
    estado: find([/^status$/, /^estado$/]),
    // Confirmado por Maria (2026-09-04): en las líneas de
    // "Pedido_compra_Excel" ya cargadas hay una columna que dice si esa
    // línea ya está facturada (si tiene algo escrito) o pendiente de
    // facturar (si está vacía). En su BC esa columna sale traducida al
    // español como "Incluido en Nº Factura" (no "Vendor_Invoice_No",
    // que era la suposición inicial y no encajaba con sus datos reales
    // — ver el 3er intento en el doc del proyecto).
    vendorInvoiceNo: find([
      /^vendor_invoice_no$/,
      /vendor.*invoice.*no/,
      /factura.*proveedor/,
      /inclu.*n.*factura/,
      /n.*factura.*inclu/,
    ]),
    // Importe de la línea, solo para mostrarlo en la tabla de pendientes
    // (informativo) — nombre sin confirmar, se muestra "—" si no se
    // encuentra ninguna columna de importe.
    importe: find([/^amount$/, /^line_amount$/, /^net_amount$/, /^amount_including_tax$/, /importe/]),
    // Lógica alternativa a probar (Maria, 2026-09-04): campos estándar
    // de cantidad de BC. Si existen los dos, tienen prioridad sobre
    // "Incluido en Nº Factura"/Vendor_Invoice_No para decidir
    // facturado/pendiente (ver PedidosPendientesFacturar).
    qtyToInvoice: find([/^qty_to_invoice$/, /qty.*to.*invoice/, /cantidad.*a.*facturar/]),
    quantityInvoiced: find([/^quantity_invoiced$/, /quantity.*invoiced/, /qty.*invoiced/, /cantidad.*facturada/]),
  };
}

/** Qué método usar para decidir "¿facturado?" según qué columnas hay
 * disponibles (compartido entre la lista filtrada por proveedor y el
 * buscador de "elegir pedido a mano" — ver PedidosPendientesFacturar). */
function metodoFacturado(cols) {
  return cols.qtyToInvoice && cols.quantityInvoiced && cols.cantidad ? "cantidades" : cols.vendorInvoiceNo ? "texto" : null;
}

/** ¿Esta fila de pedido ya está facturada? Misma lógica en los dos
 * sitios que la necesitan, para no duplicarla ni desincronizarla. */
function filaYaFacturada(fila, cols, metodo) {
  if (metodo === "cantidades") {
    const qtyPorFacturar = Number(fila[cols.qtyToInvoice]);
    const qtyFacturada = Number(fila[cols.quantityInvoiced]);
    const qtyPedida = Number(fila[cols.cantidad]);
    return qtyPorFacturar === 0 && qtyFacturada >= qtyPedida;
  }
  return String(fila[cols.vendorInvoiceNo] ?? "").trim() !== "";
}

function pedidoCuadra(p) {
  if (!p?.pedido || p.bcError) return false;
  const lineas = p.lineas || [];
  if (!lineas.length) return false;
  return lineas.every((l) => l.coincidencia !== "sin_match" && l.lineaBC && !l.pendienteRecepcion && !l.diferenciaPrecio);
}

/** Importe de línea BC: amountExcludingTax / importeLinea; si no, qty×precio×(1−dto).
 * Nunca qty×precio bruto sin dto (eso inventaba 59,44 en vez de 28,53). */
function dtoPctLineaBc(l) {
  if (!l) return null;
  const raw = l.descuentoPct ?? l.discountPercent ?? l.lineDiscountPercent;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function importeLineaPedidoBc(l) {
  if (!l) return null;
  const fromBc =
    l.importeLinea ?? l.amountExcludingTax ?? l.netAmount ?? l.Line_Amount ?? l.lineAmount;
  if (fromBc != null && fromBc !== "" && Number.isFinite(Number(fromBc))) {
    return Number(fromBc);
  }
  const precio = l.precioBC ?? l.precio ?? l.directUnitCost;
  if (precio == null || precio === "") return null;
  const qty = Number(l.cantidadPedida ?? l.quantity) || 0;
  const dto = dtoPctLineaBc(l);
  if (dto == null) return null; // sin importe ni % dto de BC → no inventar bruto
  return Math.round(qty * Number(precio) * (1 - dto / 100) * 100) / 100;
}

/** Total pedido = cabecera BC o suma de importes BC (con dto). Nunca bruto PDF / qty×precio. */
function totalPedidoPropuesta(grupo, lineasBc = []) {
  const bc = (Array.isArray(lineasBc) && lineasBc.length ? lineasBc : (grupo?.lineasDisponiblesBC || []));
  let sumImporteBc = 0;
  let hayImporteBc = false;
  let sumCalcDto = 0;
  let hayCalcDto = false;
  for (const l of bc) {
    const raw = l?.importeLinea ?? l?.amountExcludingTax ?? l?.netAmount;
    if (raw != null && raw !== "" && Number.isFinite(Number(raw))) {
      hayImporteBc = true;
      sumImporteBc += Number(raw);
      continue;
    }
    const imp = importeLineaPedidoBc(l);
    if (imp == null) continue;
    hayCalcDto = true;
    sumCalcDto += imp;
  }
  if (hayImporteBc) return Math.round(sumImporteBc * 100) / 100;
  if (grupo?.importe != null && grupo.importe !== "" && Number.isFinite(Number(grupo.importe))) {
    return Number(grupo.importe);
  }
  if (hayCalcDto) return Math.round(sumCalcDto * 100) / 100;
  return null;
}

function fmtDtoPct(n) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const txt = Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9
    ? String(Math.round(v))
    : v.toLocaleString("es-ES", { maximumFractionDigits: 2 });
  return `${txt} %`;
}

/** Importe para una qty parcial: proporción del importe neto del PC, o unit×(1−dto)×qty. */
function importeParaCantidadDesdePedido(lineaPedido, cantidad) {
  const qty = Number(cantidad) || 0;
  if (!lineaPedido || qty <= 0) return null;
  const pedida = Number(lineaPedido.cantidadPedida) || 0;
  const importePo = lineaPedido.importeLinea ?? lineaPedido.amountExcludingTax ?? lineaPedido.netAmount;
  if (importePo != null && importePo !== "" && Number.isFinite(Number(importePo)) && pedida > 0.0001) {
    return Math.round((qty / pedida) * Number(importePo) * 100) / 100;
  }
  const precio = lineaPedido.precioBC ?? lineaPedido.precio ?? lineaPedido.directUnitCost;
  if (precio == null || precio === "") return null;
  const dto = dtoPctLineaBc(lineaPedido);
  const factor = dto != null ? (1 - dto / 100) : 1;
  return Math.round(qty * Number(precio) * factor * 100) / 100;
}

function claveLineaChooser(item) {
  return item?.key || `${item?.albaran || "PO"}|${item?.id || item?.lineaPedidoId || item?.descripcion || ""}|${item?.cantidad ?? ""}`;
}

function sumaImportesElegidos(sel) {
  if (!sel?.items?.length) return 0;
  return Math.round(sel.items.reduce((s, it) => s + (Number(it.importe) || 0), 0) * 100) / 100;
}

function enlaceOtroPedido(enlace, numero) {
  if (!enlace || !numero) return null;
  try {
    const u = new URL(enlace);
    const filtro = u.searchParams.get("filter") || "";
    const nuevo = filtro.replace(/IS '[^']*'$/, `IS '${numero}'`);
    if (nuevo === filtro) return null;
    u.searchParams.set("filter", nuevo);
    return u.toString();
  } catch {
    return null;
  }
}

function sugerirPedidos({ pedidos, proveedor, fecha, importe, yaUsados }) {
  const cols = columnasPedidos(pedidos?.headers || []);
  const metodo = metodoFacturado(cols);
  if (!pedidos?.rows?.length || !cols.numero) return { porProveedor: [], porFecha: [], porImporte: [] };
  const vistos = new Set();
  const filas = [];
  for (const fila of pedidos.rows) {
    if (metodo && filaYaFacturada(fila, cols, metodo)) continue;
    const numero = String(fila[cols.numero] || "").trim();
    if (!numero || vistos.has(numero.toUpperCase()) || yaUsados.has(numero.toUpperCase())) continue;
    vistos.add(numero.toUpperCase());
    const bruto = (() => {
      const v = cols.importe ? fila[cols.importe] : null;
      if (typeof v === "number") return v;
      const s = String(v ?? "").trim();
      if (!s) return NaN;
      return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
    })();
    filas.push({
      pedido: numero,
      proveedor: cols.proveedor ? String(fila[cols.proveedor] || "").trim() : "",
      fecha: cols.fecha ? String(fila[cols.fecha] || "").slice(0, 10) : "",
      importe: Number.isFinite(bruto) ? bruto : null,
    });
  }
  const prov = normalizarProveedor(proveedor);
  const delProveedor = prov
    ? filas.filter((f) => {
        const n = normalizarProveedor(f.proveedor);
        return n && (n.includes(prov) || prov.includes(n));
      })
    : [];
  const porProveedor = delProveedor.slice(0, 6);
  const tFact = fecha ? new Date(fecha).getTime() : NaN;
  const porFecha = Number.isNaN(tFact)
    ? []
    : delProveedor
        .map((f) => ({ ...f, dist: Math.abs(new Date(f.fecha).getTime() - tFact) }))
        .filter((f) => Number.isFinite(f.dist) && f.dist <= 45 * 86400000)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 6);
  const imp = Number(importe);
  const porImporte = !imp
    ? []
    : delProveedor
        .filter((f) => f.importe && Math.abs(f.importe - imp) <= Math.max(1, Math.abs(imp) * 0.05))
        .sort((a, b) => Math.abs(a.importe - imp) - Math.abs(b.importe - imp))
        .slice(0, 6);
  const porProveedorTodos = delProveedor;
  return { porProveedor, porFecha, porImporte, porProveedorTodos };
}

function unirSugerencias(grupos) {
  const map = new Map();
  for (const [titulo, lista] of grupos || []) {
    for (const c of lista || []) {
      const prev = map.get(c.pedido);
      if (!prev) map.set(c.pedido, { ...c, motivos: [titulo] });
      else if (!prev.motivos.includes(titulo)) prev.motivos.push(titulo);
    }
  }
  return [...map.values()];
}

function ListaSugerenciaPedidos({ filas, onUsar, ejemploEnlace }) {
  const [abierto, setAbierto] = useState({});
  const [lineasPorPedido, setLineasPorPedido] = useState({});

  const toggle = async (pedido) => {
    const ya = abierto[pedido];
    setAbierto((a) => ({ ...a, [pedido]: !ya }));
    if (ya || lineasPorPedido[pedido]) return;
    setLineasPorPedido((m) => ({ ...m, [pedido]: { cargando: true, error: null, lineas: [] } }));
    try {
      const r = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setLineasPorPedido((m) => ({
        ...m,
        [pedido]: { cargando: false, error: json.bcError || null, lineas: json.lineasDisponiblesBC || [] },
      }));
    } catch (e) {
      setLineasPorPedido((m) => ({ ...m, [pedido]: { cargando: false, error: e.message || String(e), lineas: [] } }));
    }
  };

  if (!filas?.length) return null;
  return (
    <div className="border border-slate-200 rounded bg-white overflow-hidden">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[11px] text-slate-500 bg-slate-50 border-b border-slate-200">
            <th className="w-8 px-1 py-1"></th>
            <th className="px-2 py-1 font-semibold">Pedido</th>
            <th className="px-2 py-1 font-semibold">Proveedor</th>
            <th className="px-2 py-1 font-semibold">Fecha</th>
            <th className="px-2 py-1 font-semibold text-right">Importe</th>
            <th className="px-2 py-1 font-semibold">Por qué</th>
            <th className="px-2 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {filas.map((c) => {
            const info = lineasPorPedido[c.pedido];
            return (
              <Fragment key={c.pedido}>
                <tr className="border-t border-slate-100">
                  <td className="px-1 py-1">
                    <button type="button" onClick={() => toggle(c.pedido)} className="text-slate-500 hover:text-slate-800" title="Ver las líneas del pedido">
                      {abierto[c.pedido] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-2 py-1 font-mono font-semibold text-slate-800">
                    {ejemploEnlace ? (
                      <a href={enlaceOtroPedido(ejemploEnlace, c.pedido)} target="_blank" rel="noopener noreferrer" className="text-sky-700 hover:underline">{c.pedido}</a>
                    ) : c.pedido}
                  </td>
                  <td className="px-2 py-1 text-slate-700">{c.proveedor || "—"}</td>
                  <td className="px-2 py-1 text-slate-600 whitespace-nowrap">{c.fecha || "—"}</td>
                  <td className="px-2 py-1 text-right text-slate-700 whitespace-nowrap">{c.importe ? fmtEur(c.importe) : "—"}</td>
                  <td className="px-2 py-1 text-slate-500">{(c.motivos || []).join(" · ") || "Pendiente de facturar"}</td>
                  <td className="px-2 py-1 text-right">
                    <button type="button" onClick={() => onUsar(c.pedido)} className="text-blue-700 font-semibold hover:underline">Usar</button>
                  </td>
                </tr>
                {abierto[c.pedido] && (
                  <tr className="bg-slate-50">
                    <td colSpan={7} className="px-3 py-2">
                      {info?.cargando && (
                        <div className="flex items-center gap-2 text-slate-400 text-[12px]">
                          <Loader2 size={13} className="animate-spin" /> Leyendo las líneas del pedido…
                        </div>
                      )}
                      {info?.error && <div className="text-[12px] text-red-600">{info.error}</div>}
                      {info && !info.cargando && !info.error && (
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="text-slate-400">
                              <th className="text-left font-normal py-1">Código</th>
                              <th className="text-left font-normal py-1">Descripción</th>
                              <th className="text-right font-normal py-1">Pedido</th>
                              <th className="text-right font-normal py-1">Recibido</th>
                              <th className="text-right font-normal py-1">Precio</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(info.lineas || []).map((l, i) => (
                              <tr key={l.id || i} className="border-t border-slate-200">
                                <td className="py-1 font-mono">{l.codigo || "—"}</td>
                                <td className="py-1">{l.descripcion || "—"}</td>
                                <td className="py-1 text-right">{l.cantidadPedida ?? "—"}</td>
                                <td className="py-1 text-right">{l.cantidadRecibida ?? "—"}</td>
                                <td className="py-1 text-right">{l.precioBC === null || l.precioBC === undefined ? "—" : fmtEur(l.precioBC)}</td>
                              </tr>
                            ))}
                            {!(info.lineas || []).length && (
                              <tr><td colSpan={5} className="py-1 text-slate-400">Este pedido no tiene líneas en BC.</td></tr>
                            )}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Dado un nº de pedido, busca su fila en `pedidos` y devuelve el
 * código de departamento crudo (o null si no se encuentra la fila o la
 * columna). */
function departamentoDePedido(pedidos, numeroPedido) {
  if (!pedidos?.headers?.length || !numeroPedido) return null;
  const cols = columnasPedidos(pedidos.headers);
  if (!cols.numero || !cols.departamento) return null;
  const fila = (pedidos.rows || []).find(
    (r) => String(r[cols.numero] || "").trim().toUpperCase() === numeroPedido.trim().toUpperCase()
  );
  return fila ? String(fila[cols.departamento] || "").trim() || null : null;
}

/** Destinatarios para una factura: unión de los emails de los
 * departamentos de TODOS los pedidos que referencia (sin duplicados). */
function destinatariosFactura(pedidosDetalle, pedidos, emailRemitente) {
  const deps = new Set();
  let alguno = false;
  for (const p of pedidosDetalle || []) {
    alguno = true;
    const dep = departamentoDePedido(pedidos, p.pedido);
    const seg = dep ? dep.toString().split("-")[0].trim().toUpperCase() : "";
    if (seg) deps.add(seg);
  }
  if (!alguno || !deps.size) {
    const listas = listasCorreoDepartamento(null);
    return aplicarRemitente(listas.para, listas.cc, emailRemitente);
  }
  const para = [];
  const vistos = new Set();
  for (const seg of deps) {
    for (const e of emailsPorCodigoDepartamento(seg) || []) {
      const k = e.toLowerCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      para.push(e);
    }
  }
  if (!para.length) {
    const listas = listasCorreoDepartamento(null);
    return aplicarRemitente(listas.para, listas.cc, emailRemitente);
  }
  const cc = [];
  const ccVistos = new Set();
  for (const seg of deps) {
    for (const e of listasCorreoDepartamento(seg).cc) {
      const k = e.toLowerCase();
      if (ccVistos.has(k)) continue;
      ccVistos.add(k);
      cc.push(e);
    }
  }
  return aplicarRemitente(para, cc, emailRemitente);
}

function construirCuerpoHtml(factura, motivos) {
  return textoPlanoAHtml(cuerpoIncidenciaTexto(factura, motivos));
}

function cuerpoIncidenciaTexto(factura, motivos) {
  const lista = (motivos || []).map((m) => `· ${m}`).join("\n");
  return `Hola,\n\nHa llegado la factura ${factura || ""} (adjunta en PDF) y no cuadra con el pedido de compra en Business Central:\n\n${lista}\n\n¿Podéis revisar/recibir el pedido en BC (o corregir el precio) para poder validar la factura?`;
}

function escHtml(s) {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function filasIncidenciaPedido(pedido) {
  const filas = [];
  if (!pedido) return filas;
  if (pedido.bcError) {
    filas.push({
      tipo: "Pedido",
      articulo: pedido.pedido || "—",
      factura: "—",
      pedido: "—",
      diferencia: pedido.bcError,
    });
  }
  for (const l of pedido.lineas || []) {
    if (descripcionEsSoloPedido(l.descripcionFactura, pedido.pedido)) continue;
    const articulo = l.lineaBC?.descripcion || l.descripcionFactura || "—";
    if (l.pendienteRecepcion) {
      const pide = Number(l.cantidadFacturada) || 0;
      const recibido = Number(l.lineaBC?.cantidadRecibida) || 0;
      const falta = Math.max(0, pide - recibido);
      filas.push({
        tipo: "Pendiente de recibir",
        articulo,
        factura: String(pide),
        pedido: `${recibido} recibidas`,
        diferencia: `Faltan ${falta}`,
      });
    }
    if (l.diferenciaPrecio) {
      filas.push({
        tipo: "Precio distinto",
        articulo,
        factura: fmtEur(l.precioFacturado),
        pedido: fmtEur(l.lineaBC?.precioBC),
        diferencia: "El precio no coincide",
      });
    }
    if ((l.coincidencia === "sin_match" || !l.lineaBC) && !l.pendienteRecepcion && !l.diferenciaPrecio) {
      filas.push({
        tipo: "Línea sin cuadrar",
        articulo,
        factura: l.cantidadFacturada ?? "—",
        pedido: "—",
        diferencia: "No está en el pedido",
      });
    }
  }
  return filas;
}

function htmlIncidenciaPedido({ factura, fecha, proveedor, pedido, filas }) {
  const td = "border:1px solid #e2e8f0;padding:6px 8px;text-align:left;vertical-align:top;";
  const th = `${td}background:#fff7ed;font-weight:600;`;
  const cuerpo = (filas || []).map((f) => `<tr>
    <td style="${td}">${escHtml(f.tipo)}</td>
    <td style="${td}">${escHtml(f.articulo)}</td>
    <td style="${td}">${escHtml(f.factura)}</td>
    <td style="${td}">${escHtml(f.pedido)}</td>
    <td style="${td}">${escHtml(f.diferencia)}</td>
  </tr>`).join("");
  const cuando = fecha ? ` del ${escHtml(fmtFechaFactura(fecha))}` : "";
  const deQuien = proveedor ? ` de <b>${escHtml(proveedor)}</b>` : "";
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1f2937;">
    <p>Hola,</p>
    <p>La factura <b>${escHtml(factura || "")}</b>${cuando}${deQuien} no se puede registrar. La incidencia es solo del pedido <b>${escHtml(pedido || "")}</b>. El PDF va adjunto.</p>
    <table style="border-collapse:collapse;width:100%;font-size:10.5pt;margin:12px 0;">
      <thead><tr>
        <th style="${th}">Incidencia</th>
        <th style="${th}">Artículo</th>
        <th style="${th}">En la factura</th>
        <th style="${th}">En el pedido</th>
        <th style="${th}">Qué falta</th>
      </tr></thead>
      <tbody>${cuerpo || `<tr><td style="${td}" colspan="5">Sin detalle de líneas.</td></tr>`}</tbody>
    </table>
    <p>Hasta que esto se reciba o se corrija en ese pedido, esta parte de la factura no se puede entrar.</p>
  </div>`;
}

function textoPlanoAHtml(texto) {
  const E = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bloques = String(texto || "")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${E(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;">${bloques}<p style="color:#94a3b8;font-size:12px;margin-top:18px;">Incidencia — Validación de facturas · ACsales.</p></div>`;
}

function construirCuerpoContinia({ factura, fecha, pedidosDetalle, vendorName }) {
  const E = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pcs = (pedidosDetalle || [])
    .filter((p) => p.pedido)
    .map((p) => {
      const nLineas = (p.lineas || []).length;
      return `<li><b>${E(p.pedido)}</b>${p.vendorName ? ` · ${E(p.vendorName)}` : ""} · ${nLineas} línea${nLineas === 1 ? "" : "s"}</li>`;
    })
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;">
    <p>Factura de proveedor validada en ACsales — lista para Document Capture.</p>
    <ul style="padding-left:18px;">
      <li><b>Nº factura:</b> ${E(factura)}</li>
      ${fecha ? `<li><b>Fecha:</b> ${E(fecha)}</li>` : ""}
      ${vendorName ? `<li><b>Proveedor:</b> ${E(vendorName)}</li>` : ""}
    </ul>
    <p><b>Esta factura está formada por los pedidos de compra:</b></p>
    <ul style="padding-left:18px;">${pcs || "<li>(sin pedido identificado)</li>"}</ul>
    <p style="color:#94a3b8;font-size:12px;margin-top:18px;">Envío automático tras validación OK · ACsales.</p>
  </div>`;
}

// Línea de la factura, ya cruzada con BC. Vista lado a lado:
// izquierda = lo leído de la factura; derecha = línea del pedido en BC.
// Cuando no se ha encontrado (o el emparejamiento se equivoca) se puede
// elegir a mano la línea real del pedido — igual que Recepción de material.
function badgeCoincidencia(coincidencia) {
  if (coincidencia === "alta") return { texto: "Coincidencia alta", cls: "bg-emerald-100 text-emerald-800" };
  if (coincidencia === "media") return { texto: "Coincidencia media", cls: "bg-amber-100 text-amber-800" };
  if (coincidencia === "manual") return { texto: "Elegida a mano", cls: "bg-blue-100 text-blue-800" };
  return { texto: "Sin match", cls: "bg-red-100 text-red-800" };
}

function LineaFactura({ linea, disponibles, onElegir, onEditar }) {
  const problema = linea.coincidencia === "sin_match" || linea.pendienteRecepcion || linea.diferenciaPrecio;
  const badge = badgeCoincidencia(linea.coincidencia);
  const importeFactura =
    linea.cantidadFacturada != null && linea.precioFacturado != null
      ? Number(linea.cantidadFacturada) * Number(linea.precioFacturado)
      : null;
  const mostrarSelector = disponibles && disponibles.length > 0;

  return (
    <div className={`rounded-md border overflow-hidden ${problema ? "border-red-200" : "border-emerald-200"}`}>
      <div className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-semibold ${problema ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>
        <span className={`px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.texto}</span>
        {linea.pendienteRecepcion && linea.lineaBC && (
          <span className="text-red-700 font-medium">⚠ Pendiente de recibir/registrar</span>
        )}
        {linea.diferenciaPrecio && (
          <span className="text-red-700 font-medium">⚠ Precio distinto</span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200 bg-white">
        {/* Columna factura */}
        <div className="px-3 py-2.5 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Factura (PDF)</div>
          <input
            value={linea.descripcionFactura}
            onChange={(e) => onEditar("descripcionFactura", e.target.value)}
            title="Descripción tal como la ha leído la IA — corrígela si hace falta"
            className="w-full text-xs font-medium text-slate-800 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none focus:bg-white"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
            <label className="flex items-center gap-1">
              Cant.
              <input
                type="number"
                step="0.01"
                value={linea.cantidadFacturada}
                onChange={(e) => onEditar("cantidadFacturada", e.target.value === "" ? 0 : Number(e.target.value))}
                className="w-16 border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700"
              />
            </label>
            <label className="flex items-center gap-1">
              P.u.
              <input
                type="number"
                step="0.01"
                value={linea.precioFacturado ?? ""}
                onChange={(e) => onEditar("precioFacturado", e.target.value === "" ? null : Number(e.target.value))}
                className="w-20 border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700"
              />
              €
            </label>
            {importeFactura != null && !Number.isNaN(importeFactura) && (
              <span className="text-slate-500">= {fmtEur(importeFactura)}</span>
            )}
          </div>
        </div>

        {/* Columna pedido BC */}
        <div className="px-3 py-2.5 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Pedido compra (BC)</div>
          {linea.lineaBC ? (
            <>
              <div className="text-xs font-medium text-slate-800">
                {linea.lineaBC.codigo ? (
                  <span className="font-mono text-[11px] text-blue-700 mr-1.5">{linea.lineaBC.codigo}</span>
                ) : null}
                {linea.lineaBC.descripcion || "—"}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                <span>Pedido: <b>{linea.lineaBC.cantidadPedida}</b></span>
                <span className={linea.pendienteRecepcion ? "text-red-700 font-semibold" : ""}>
                  Recibido: <b>{linea.lineaBC.cantidadRecibida}</b>
                </span>
                <span className={linea.diferenciaPrecio ? "text-red-700 font-semibold" : ""}>
                  P.u.: <b>{fmtEur(linea.lineaBC.precioBC)}</b>
                </span>
                {linea.lineaBC.lineType && linea.lineaBC.lineType !== "Item" && (
                  <span className="text-slate-400">({linea.lineaBC.lineType})</span>
                )}
              </div>
              {(linea.pendienteRecepcion || linea.diferenciaPrecio) && (
                <div className="text-[11px] text-red-700 space-y-0.5">
                  {linea.pendienteRecepcion && (
                    <div>
                      Facturado {linea.cantidadFacturada} &gt; recibido {linea.lineaBC.cantidadRecibida} — falta recibir/registrar en BC.
                    </div>
                  )}
                  {linea.diferenciaPrecio && (
                    <div>
                      Precio factura {fmtEur(linea.precioFacturado)} vs BC {fmtEur(linea.lineaBC.precioBC)}.
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-red-600 font-medium">
              No encontrada en el pedido en BC — elige una línea abajo o corrige el pedido.
            </div>
          )}
          {mostrarSelector && (
            <select
              value={linea.coincidencia === "manual" ? linea.lineaBC?.id || "" : ""}
              onChange={(e) => e.target.value && onElegir(e.target.value)}
              className="w-full text-[11px] border border-amber-300 rounded px-1.5 py-1 bg-amber-50 text-slate-700"
            >
              <option value="">
                {linea.lineaBC
                  ? linea.coincidencia === "alta"
                    ? "— cambiar emparejamiento a mano —"
                    : "— no es esta línea, elegir otra a mano —"
                  : "— sin coincidencia — elegir a mano —"}
              </option>
              {disponibles.map((lb) => (
                <option key={lb.id} value={lb.id}>
                  {lb.codigo ? `${lb.codigo} — ` : ""}{lb.descripcion} · ped. {lb.cantidadPedida} · rec. {lb.cantidadRecibida} · {fmtEur(lb.precioBC)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

function normalizarNumeroPedido(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "").replace(/\//g, "-");
  const full = s.match(/^(PC|OC)(\d{2})-(\d{3,7})$/);
  if (full) return `${full[1]}${full[2]}-${full[3].padStart(6, "0")}`;
  const corto = s.match(/^(PC|OC)-(\d{3,7})$/);
  if (corto) return `${corto[1]}-${corto[2]}`;
  return s;
}

function colaPedido(s) {
  const m = String(s || "").toUpperCase().replace(/\s+/g, "").match(/^(PC|OC)(?:\d{2})?-?(\d+)$/);
  if (!m) return "";
  return m[1] + String(Number(m[2]));
}

function mismoPedidoFactura(a, b) {
  const ca = colaPedido(a);
  const cb = colaPedido(b);
  return !!ca && ca === cb;
}

function gruposDesdeFactura(f) {
  const esGasto = f.veredicto === "gasto" && !!f.gastoSugerido;
  const grupos = (f.pedidosDetalle || []).map((p) => ({ ...p, lineas: (p.lineas || []).map((l) => ({ ...l })) }));
  if (!esGasto && f.lineasSinPedido?.length) {
    grupos.push({
      pedido: null,
      vendorName: f.proveedor || null,
      bcError: "Sin pedido identificado en la factura — elige uno manualmente.",
      enlaceBC: null,
      lineas: f.lineasSinPedido.map((l) => ({
        ...l,
        lineaBC: null,
        coincidencia: "sin_match",
        pendienteRecepcion: false,
        diferenciaPrecio: false,
      })),
    });
  }
  return grupos;
}

function claveTarjeta(f, i) {
  if (f.origen?.msg) return `${f.origen.msg}|${f.origen.att || ""}`;
  return `${f.factura || "sin"}|${(f.paginas || []).join(".")}|${i}`;
}

function claveNombreProveedor(s) {
  return String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function coincideNombreProveedor(escrito, candidato) {
  const q = claveNombreProveedor(escrito);
  const c = claveNombreProveedor(candidato);
  if (!q || !c) return false;
  if (c === q) return true;
  if (q.length < 4) return c.startsWith(q);
  return c.includes(q) || (q.includes(c) && c.length >= 4);
}

function normalizarCifProveedor(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^ES/, "");
}

function pareceCifProveedor(s) {
  const t = normalizarCifProveedor(s);
  if (!t || t.length < 8 || t.length > 10) return false;
  return /^[A-Z]\d{7}[A-Z0-9]$/.test(t) || /^\d{8}[A-Z]$/.test(t);
}

function buscarProveedorBc(escrito, proveedoresBc) {
  const texto = String(escrito || "").trim();
  if (!texto || !Array.isArray(proveedoresBc) || !proveedoresBc.length) return null;
  const porNombre = proveedoresBc.find((p) => p.nombre && p.nombre.toUpperCase() === texto.toUpperCase());
  if (porNombre) return porNombre;
  const cifN = normalizarCifProveedor(texto);
  if (cifN && (pareceCifProveedor(texto) || cifN.length >= 8)) {
    const porCif = proveedoresBc.find(
      (p) => normalizarCifProveedor(p.cif) === cifN || normalizarCifProveedor(p.numero) === cifN
    );
    if (porCif) return porCif;
  }
  return null;
}

function nombrePdfDocumento(numero, esAlbaran) {
  const limpio = String(numero || "documento").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "documento";
  return `${esAlbaran ? "Albaran" : "Factura"}_${limpio}.pdf`;
}

function blobDesdeBase64(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "application/pdf" });
}

function guardarBlob(blob, nombre) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

function cantidadPendienteLinea(l) {
  const pedida = Number(l?.cantidadPedida) || 0;
  const recibida = Number(l?.cantidadRecibida) || 0;
  return Math.max(0, pedida - recibida);
}

function pendienteFacturarDeLinea(l) {
  if (!l) return 0;
  if (l.cantidadPendienteFacturar != null && l.cantidadPendienteFacturar !== "") {
    return Math.max(0, Number(l.cantidadPendienteFacturar) || 0);
  }
  return Math.max(0, (Number(l.cantidadRecibida) || 0) - (Number(l.cantidadFacturada) || 0));
}

function lineaPedidoYaFacturada(l) {
  const pedida = Number(l?.cantidadPedida) || 0;
  if (pedida <= 0.0001) return true;
  const facturada = Number(l?.cantidadFacturada) || 0;
  return facturada + 0.0001 >= pedida && pendienteFacturarDeLinea(l) <= 0.0001;
}

/** Pedido completo ya facturado en BC: no se puede volver a incluir en la factura. */
function pedidoYaFacturado(lineas) {
  const lista = (lineas || []).filter((l) => (Number(l?.cantidadPedida) || 0) > 0.0001);
  if (!lista.length) return false;
  return lista.every(lineaPedidoYaFacturada);
}

function pedidoTienePendienteRecibir(lineas) {
  return (lineas || []).some((l) => cantidadPendienteLinea(l) > 0.001);
}

/**
 * Motivo único para el aviso en pantalla y el correo al proveedor.
 * Así no puede decir una cosa el comentario y otra el email.
 */
function motivoBloqueoPedidoProveedor(lineas, { tieneLineasBc = false, hayFilasChooser = false } = {}) {
  if (!tieneLineasBc || hayFilasChooser) return null;
  if (pedidoYaFacturado(lineas)) return "ya_facturado";
  if (pedidoTienePendienteRecibir(lineas)) return "sin_recibir";
  const algunaFacturada = (lineas || []).some((l) => (Number(l?.cantidadFacturada) || 0) > 0.0001);
  if (algunaFacturada) return "ya_facturado";
  return "sin_recibir";
}

const AVISO_PEDIDO_YA_FACTURADO = "ESTE PEDIDO ya se encuentra facturado";
const AVISO_PEDIDO_SIN_RECIBIR = "No hay líneas recibidas / pendientes de facturar en BC para elegir.";

function textoAvisoMotivoPedido(motivo) {
  if (motivo === "ya_facturado") return AVISO_PEDIDO_YA_FACTURADO;
  if (motivo === "sin_recibir") return AVISO_PEDIDO_SIN_RECIBIR;
  return "";
}

function parrafoCorreoMotivoPedido(motivo, pedidoTxt) {
  if (motivo === "ya_facturado") {
    return `En la factura figura el pedido ${pedidoTxt}. Ese pedido ya está facturado y no corresponde al material de esta factura, así que no podemos tramitarla.\n\nPara poder tramitarla necesitamos el albarán firmado de la entrega.`;
  }
  if (motivo === "sin_recibir") {
    return `En la factura figura el pedido ${pedidoTxt}, pero desgraciadamente en nuestro sistema nos aparece pendiente de recibir. Serían tan amables de enviarnos los albaranes valorados, así que no podemos tramitarla.`;
  }
  if (motivo === "albaran_firmado") {
    return `En la factura figura el pedido ${pedidoTxt}. Para poder tramitarla necesitamos el albarán firmado de la entrega.`;
  }
  return `En la factura figura el pedido ${pedidoTxt}. No podemos tramitarla todavía.\n\nPara poder tramitarla necesitamos el albarán firmado de la entrega.`;
}

function asuntoCorreoMotivoPedido(factura, motivo) {
  if (motivo === "ya_facturado") return `Factura ${factura || ""} — pedido ya facturado`;
  if (motivo === "sin_recibir") return `Factura ${factura || ""} — necesitamos los albaranes valorados`;
  if (motivo === "albaran_firmado") return `Factura ${factura || ""} — necesitamos el albarán firmado`;
  return `Factura ${factura || ""} — necesitamos el albarán firmado`;
}

function cierreCorreoMotivoPedido(motivo) {
  if (motivo === "sin_recibir" || motivo === "albaran_firmado") return "Quedamos a la espera de una respuesta";
  return "Quedamos a la espera.\n\nGracias.";
}

function emailRemitenteFactura(origen) {
  const cand = origen?.de || origen?.from || origen?.email || origen?.remitente || "";
  const email = String(cand || "").trim();
  return email.includes("@") ? email : "";
}

function normTextoLinea(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function puntuarTextoLinea(a, b) {
  const na = normTextoLinea(a);
  const nb = normTextoLinea(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const raiz = (w) => w.slice(0, 6);
  const palabrasA = new Set(na.split(" ").filter((w) => w.length > 2).map(raiz));
  const palabrasB = new Set(nb.split(" ").filter((w) => w.length > 2).map(raiz));
  if (!palabrasA.size || !palabrasB.size) return 0;
  let comunes = 0;
  for (const w of palabrasA) if (palabrasB.has(w)) comunes++;
  return comunes / Math.max(palabrasA.size, palabrasB.size);
}

function raicesLinea(texto) {
  return [...new Set(
    normTextoLinea(texto).split(" ").filter((w) => w.length >= 5).map((w) => w.slice(0, 6))
  )];
}

function mismaLineaDocumento(a, b) {
  if (puntuarTextoLinea(a, b) >= 0.35) return true;
  const ra = raicesLinea(a);
  const rb = new Set(raicesLinea(b));
  return ra.some((w) => rb.has(w));
}

function matchPorRaizUnica(desc, pendientes, usadas) {
  for (const raiz of raicesLinea(desc)) {
    const hits = pendientes.filter((l) => !usadas.has(l.id) && raicesLinea(`${l.descripcion || ""} ${l.codigo || ""}`).includes(raiz));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// Lo leído del PDF completa las líneas que la factura no trajo.
// Si el PDF tiene cantidad, esa manda (lejía 3, no las 4 pedidas).
function lineasDocumentoParaRecepcion(lineasFactura, lineasPdf) {
  const base = (lineasFactura || []).map((l) => ({
    descripcionFactura: l.descripcionFactura || "",
    cantidadFacturada: l.cantidadFacturada,
    precioFacturado: l.precioFacturado,
    lineaBC: l.lineaBC || null,
    codigo: l.codigo || l.lineaBC?.codigo || "",
  }));
  for (const p of lineasPdf || []) {
    const desc = String(p?.descripcion || "").trim();
    const qty = Number(p?.cantidad);
    if (!desc || !(qty > 0)) continue;
    const ya = base.find((l) => mismaLineaDocumento(l.descripcionFactura, desc));
    if (ya) {
      if (!(Number(ya.cantidadFacturada) > 0)) ya.cantidadFacturada = qty;
      if (!ya.codigo && p.codigo) ya.codigo = String(p.codigo);
      continue;
    }
    base.push({
      descripcionFactura: desc,
      cantidadFacturada: qty,
      precioFacturado: null,
      lineaBC: null,
      codigo: p.codigo ? String(p.codigo) : "",
    });
  }
  return base;
}

// Solo las líneas del pedido que casan con el documento.
// La cantidad es la del documento, nunca la pedida entera si el documento trae menos.
// Una línea de BC sin pareja no se recibe.
function lineasParaRegistrarRecepcion(lineasBC, lineasFactura) {
  const pendientes = (lineasBC || [])
    .map((l) => ({ ...l, pendiente: cantidadPendienteLinea(l) }))
    .filter((l) => l.id && l.pendiente > 0.001);
  if (!pendientes.length) return [];

  const elegidas = [];
  const usadas = new Set();
  const libre = (l) => l && !usadas.has(l.id);
  const tomar = (bc, lf) => {
    if (!libre(bc)) return;
    const qtyDoc = Number(lf?.cantidadFacturada);
    if (!(qtyDoc > 0)) return;
    const cantidad = Math.min(bc.pendiente, qtyDoc);
    if (!(cantidad > 0.001)) return;
    usadas.add(bc.id);
    elegidas.push({ lineaId: bc.id, cantidad });
  };

  for (const lf of lineasFactura || []) {
    const id = lf.lineaBC?.id;
    let bc = id ? pendientes.find((l) => l.id === id && libre(l)) : null;
    const codDoc = String(lf.codigo || lf.lineaBC?.codigo || "").trim().toUpperCase();
    if (!bc && codDoc) {
      bc = pendientes.find((l) => libre(l) && String(l.codigo || "").trim().toUpperCase() === codDoc) || null;
    }
    if (!bc && codDoc) {
      bc = pendientes.find((l) => libre(l) && normTextoLinea(l.descripcion).includes(normTextoLinea(codDoc))) || null;
    }
    if (!bc) {
      const desc = String(lf.descripcionFactura || "");
      let mejor = null;
      let mejorPunt = 0;
      for (const l of pendientes) {
        if (!libre(l)) continue;
        const punt = Math.max(puntuarTextoLinea(desc, l.descripcion), puntuarTextoLinea(desc, l.codigo));
        if (punt > mejorPunt) { mejorPunt = punt; mejor = l; }
      }
      if (mejor && mejorPunt >= 0.35) bc = mejor;
    }
    if (!bc) bc = matchPorRaizUnica(lf.descripcionFactura, pendientes, usadas);
    if (!bc && lf.precioFacturado != null && lf.precioFacturado !== "") {
      const precio = Number(lf.precioFacturado);
      if (Number.isFinite(precio)) {
        bc = pendientes.find((l) => libre(l) && l.precioBC != null && Math.abs(Number(l.precioBC) - precio) <= Math.max(0.02, Math.abs(precio) * 0.02)) || null;
      }
    }
    if (!bc) {
      const importe = (Number(lf.cantidadFacturada) || 0) * (Number(lf.precioFacturado) || 0);
      if (importe > 0) {
        bc = pendientes.find((l) => {
          if (!libre(l)) return false;
          const imp = l.pendiente * (Number(l.precioBC) || 0);
          return imp > 0 && Math.abs(imp - importe) <= Math.max(0.05, Math.abs(importe) * 0.02);
        }) || null;
      }
    }
    tomar(bc, lf);
  }

  return elegidas;
}

/** Misma búsqueda de artículos BC que Recepción (Validación → añadir al PC). */
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
              type="button"
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

const CARGOS_PROD_RESPALDO_FC = [
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

/** Líneas del PDF sin pareja en BC para el PC de la propuesta (+ las sin pedido). */
function candidatosAnadirAlPedido(grupo, pedidosDetalle, pedidoActual) {
  const out = [];
  const visto = new Set();
  const push = (l, id, origen) => {
    if (descripcionEsSoloPedido(l.descripcionFactura, pedidoActual)) return;
    if (l.lineaBC && l.coincidencia !== "sin_match") return;
    if (l.lineaBC) return;
    const desc = String(l.descripcionFactura || "").trim();
    const qty = Number(l.cantidadFacturada);
    const precio = l.precioFacturado;
    const firma = `${desc}|${qty}|${precio ?? ""}`;
    if (visto.has(firma)) return;
    visto.add(firma);
    out.push({
      id,
      origen,
      tipo: "Item",
      codigo: "",
      descripcion: desc,
      busqueda: desc.split(/\s+/).filter(Boolean).slice(0, 3).join(" "),
      cantidad: Number.isFinite(qty) && qty > 0 ? qty : 1,
      coste: precio != null && precio !== "" ? Number(precio) : "",
      marcada: true,
    });
  };
  (grupo?.lineas || []).forEach((l, idx) => {
    if (l.coincidencia === "sin_match" || !l.lineaBC) {
      push(l, `sm-${colaPedido(pedidoActual) || "pc"}-${idx}`, "pedido");
    }
  });
  (pedidosDetalle || []).forEach((pg, gi) => {
    if (String(pg.pedido || "").trim()) return;
    (pg.lineas || []).forEach((l, idx) => {
      push(l, `sp-${gi}-${idx}`, "sin_pedido");
    });
  });
  return out;
}

/** Tras crear líneas en BC, reengancha las del PDF que seguían sin_match. */
function rematchLineasTrasAnadir(lineasFactura, lineasBc) {
  const usadas = new Set();
  for (const l of lineasFactura || []) {
    if (l.lineaBC?.id && l.coincidencia !== "sin_match") usadas.add(l.lineaBC.id);
  }
  return (lineasFactura || []).map((l) => {
    if (l.lineaBC && l.coincidencia !== "sin_match") {
      const actual = (lineasBc || []).find((x) => x.id === l.lineaBC.id);
      if (!actual) return l;
      const pendienteRecepcion = (Number(actual.cantidadRecibida) || 0) + 0.001 < (Number(l.cantidadFacturada) || 0);
      const diferenciaPrecio = precioDifiereCliente(l.precioFacturado, actual.precioBC ?? actual.precio);
      return { ...l, lineaBC: { ...l.lineaBC, ...actual }, pendienteRecepcion, diferenciaPrecio };
    }
    let mejor = null;
    let mejorPunt = 0;
    for (const lb of lineasBc || []) {
      if (usadas.has(lb.id)) continue;
      const punt = Math.max(
        puntuarTextoLinea(l.descripcionFactura, lb.descripcion),
        puntuarTextoLinea(l.descripcionFactura, lb.codigo)
      );
      if (punt > mejorPunt) { mejorPunt = punt; mejor = lb; }
    }
    if ((!mejor || mejorPunt < 0.35) && l.precioFacturado != null && l.precioFacturado !== "") {
      const precio = Number(l.precioFacturado);
      if (Number.isFinite(precio)) {
        const porPrecio = (lineasBc || []).find((lb) => {
          if (usadas.has(lb.id)) return false;
          const pBc = lb.precioBC ?? lb.precio;
          if (pBc == null) return false;
          if (Math.abs(Number(pBc) - precio) > Math.max(0.02, Math.abs(precio) * 0.02)) return false;
          const qtyBc = Number(lb.cantidadPedida) || 0;
          const qtyF = Number(l.cantidadFacturada) || 0;
          return Math.abs(qtyBc - qtyF) < 0.001 || qtyF <= 0;
        });
        if (porPrecio) { mejor = porPrecio; mejorPunt = 0.5; }
      }
    }
    if (!mejor || mejorPunt < 0.35) {
      return { ...l, lineaBC: null, coincidencia: "sin_match", pendienteRecepcion: false, diferenciaPrecio: false };
    }
    usadas.add(mejor.id);
    const pendienteRecepcion = (Number(mejor.cantidadRecibida) || 0) + 0.001 < (Number(l.cantidadFacturada) || 0);
    const diferenciaPrecio = precioDifiereCliente(l.precioFacturado, mejor.precioBC ?? mejor.precio);
    return { ...l, lineaBC: mejor, coincidencia: "manual", pendienteRecepcion, diferenciaPrecio };
  });
}

function TarjetaFactura({ f, pedidos, proveedoresBc = null, seleccionActiva, onIniciarSeleccion, onCancelarSeleccion, registrarAplicador, remitenteEmail = null, empezarAbierta = false, onIncidencia, onMinimizar, onEntrada, modoDiario = false, onDescartar = null }) {
  const [abierta, setAbierta] = useState(empezarAbierta);
  const [buscaPedido, setBuscaPedido] = useState("");
  const [verTodosProv, setVerTodosProv] = useState(false);
  const [envio, setEnvio] = useState({ estado: "idle" }); // idle | enviando | ok | error  (incidencia)
  const [vistaCorreo, setVistaCorreo] = useState(null);
  const [vistaPedido, setVistaPedido] = useState(null);
  const [continia, setContinia] = useState({ estado: "idle" }); // idle | enviando | ok | error
  const [entrada, setEntrada] = useState({ estado: "idle" }); // idle | entrando | ok | error
  const [lineasBcPorPedido, setLineasBcPorPedido] = useState({});
  const [albaranesPorPedido, setAlbaranesPorPedido] = useState({});
  const [lineasElegidasPorPedido, setLineasElegidasPorPedido] = useState({});
  const lineasElegidasRef = useRef(lineasElegidasPorPedido);
  lineasElegidasRef.current = lineasElegidasPorPedido;
  // Borrador siempre visible en el listado unificado (checks + qty a facturar).
  const [borradorChooser, setBorradorChooser] = useState(null); // { keys: {}, qtys: {} }
  const [registroRecepcion, setRegistroRecepcion] = useState({ estado: "idle" });
  const [nuevasLineasPorPedido, setNuevasLineasPorPedido] = useState({}); // cola PC → borrador a añadir
  const [anadirLineasBc, setAnadirLineasBc] = useState({ estado: "idle" }); // idle | subiendo | ok | error
  const [nuevasLineasPanelAbierto, setNuevasLineasPanelAbierto] = useState(false);
  const [cargosProd, setCargosProd] = useState(CARGOS_PROD_RESPALDO_FC);
  const [recargaLineas, setRecargaLineas] = useState(0);
  useEffect(() => {
    fetch("/api/bc/cargos").then((r) => r.json()).then((d) => { if (d?.cargos?.length) setCargosProd(d.cargos); }).catch(() => {});
  }, []);
  const [pedidoNuevo, setPedidoNuevo] = useState(() => (
    f.pedidoCreado?.numero ? { estado: "ok", ...f.pedidoCreado } : { estado: "idle" }
  ));
  useEffect(() => {
    const numero = pedidoNuevo.numero;
    if (!numero || pedidoNuevo.resumenListo || pedidoNuevo.estado === "entrando") return;
    let vivo = true;
    fetch("/api/facturas-compra/resumen-pedido", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pedido: numero }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!vivo || !ok) return;
        setPedidoNuevo((prev) => (
          prev.numero === numero
            ? { ...prev, fecha: j.fecha || null, albaran: j.albaran || null, importe: j.importe ?? null, resumenListo: true }
            : prev
        ));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [pedidoNuevo.numero, pedidoNuevo.resumenListo, pedidoNuevo.estado]);
  const [forzarEntrada, setForzarEntrada] = useState(false);
  const [recepPedido, setRecepPedido] = useState(null);
  const [buscandoCorreos, setBuscandoCorreos] = useState(false);
  const [pdfManual, setPdfManual] = useState(f.pdfBase64 || null);
  const [verDetalle, setVerDetalle] = useState(() => !f.factura);
  const pdfB64 = f.pdfBase64 || pdfManual || "";
  const [pdfUrl, setPdfUrl] = useState(null);
  useEffect(() => {
    if (!pdfB64) { setPdfUrl(null); return; }
    let url;
    try {
      const bin = atob(pdfB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setPdfUrl(url);
    } catch { setPdfUrl(null); }
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [pdfB64]);
  useEffect(() => {
    if (seleccionActiva != null) setVerDetalle(true);
  }, [seleccionActiva]);
  useEffect(() => {
    if (f.pdfBase64 || pdfManual || !f.origen?.msg) return;
    let vivo = true;
    const q = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att || "")}`;
    fetch(`/api/facturas-compra/bandeja/pdf?${q}`)
      .then((r) => r.json())
      .then((j) => { if (vivo && j.base64) setPdfManual(j.base64); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [f.pdfBase64, f.origen?.msg, f.origen?.att, pdfManual]);

  // Proveedor de gasto (Maria, 2026-09-04): "hay proveedores que son de
  // gasto y estos se entran sin pedido [...] añadas el Nº de OT, porque
  // siempre es la misma". Detectado en el backend a partir del
  // histórico de líneas de factura de compra en BC (no de una lista a
  // mano) — ver detalle en `gastoSugerido`. No cambia con ediciones de
  // línea (no hay líneas de pedido que editar en este caso), así que se
  // toma directamente de `f`, sin recalcular.
  const esGasto = f.veredicto === "gasto" && !!f.gastoSugerido;
  const ultimaRaw = f.ultimaEntrada || null;
  const nombreProvTarjeta = `${f.proveedor || ""} ${ultimaRaw?.proveedorBC || ""} ${ultimaRaw?.proveedorFactura || ""}`;
  const esFerrosGrupo = ultimaRaw?.regla === "ferros-grupo"
    || (/ferros/i.test(nombreProvTarjeta) && (/coll/i.test(nombreProvTarjeta) || /alba/i.test(nombreProvTarjeta) || /ferrosca/i.test(nombreProvTarjeta)));
  const otFerros = ultimaRaw?.ot || f.otDetectada || "";
  // Ferros: siempre se puede crear el pedido con cuenta 60700004, aunque
  // la factura se hubiera leído antes de existir esta regla.
  const ultima = esFerrosGrupo
    ? {
        ...(ultimaRaw || {}),
        regla: "ferros-grupo",
        cuenta: "60700004",
        descripcionFija: "TRABAJOS ENTRE EMPRESAS DEL GRUPO",
        lineType: "Account",
        puedeCrear: true,
        ot: otFerros || null,
        proveedorBC: ultimaRaw?.proveedorBC || f.proveedor,
        proveedorFactura: ultimaRaw?.proveedorFactura || f.proveedor,
        resumen: ultimaRaw?.regla === "ferros-grupo"
          ? ultimaRaw.resumen
          : (otFerros
            ? `Ferros Coll de l'Alba: pedido con cuenta 60700004, «TRABAJOS ENTRE EMPRESAS DEL GRUPO», OT ${otFerros}.`
            : "Ferros Coll de l'Alba: pedido con cuenta 60700004 y «TRABAJOS ENTRE EMPRESAS DEL GRUPO». Indica la OT antes de crear."),
      }
    : ultimaRaw;

  // Copia local editable de los pedidos/líneas detectados — permite
  // corregir a mano una línea cuando el emparejamiento automático por
  // texto no la encuentra (o se equivoca), sin perder lo ya leído del PDF.
  //
  // Líneas SIN ningún pedido reconocido (Maria, 2026-09-04): hasta
  // ahora no había ninguna forma de asociarlas a mano — solo salía el
  // aviso de texto "No he podido identificar a qué pedido...". Se
  // añaden aquí como un grupo más (pedido: null), con el mismo
  // "bcError" (de mentira, pero con el mismo formato) que ya hace
  // aparecer el botón "Elegir pedido manualmente" para un pedido no
  // encontrado en BC — así se reutiliza TODO el mecanismo existente
  // (búsqueda, "Usar este pedido", aplicarPedidoElegido) sin duplicar
  // nada. No se añade si la factura es "de gasto" (esGasto): ahí no
  // llevar pedido es lo normal, no algo que corregir.
  const [pedidosDetalle, setPedidosDetalle] = useState(() => gruposDesdeFactura(f));

  // Cabecera editable — lo que ha leído la IA del PDF (nº de factura,
  // fecha, base imponible, importe total) puede corregirse a mano por si
  // hay algo mal antes de pasarlo a BC o de mandar el aviso.
  const [cabecera, setCabecera] = useState(() => ({
    factura: f.factura || "",
    fecha: f.fecha || "",
    baseImponible: f.baseImponible ?? null,
    importeTotal: f.importeTotal ?? null,
    proveedor: f.proveedor || "",
  }));
  const firmaLectura = `${f.origen?.msg || ""}|${f.origen?.att || ""}|${f.pdfBase64?.length || 0}`;
  const proveedorTocado = useRef(false);
  const docProveedor = useRef(`${f.origen?.msg || ""}|${f.origen?.att || ""}`);
  useEffect(() => {
    const doc = `${f.origen?.msg || ""}|${f.origen?.att || ""}`;
    const nuevoDoc = docProveedor.current !== doc;
    docProveedor.current = doc;
    if (nuevoDoc) proveedorTocado.current = false;
    setCabecera((prev) => ({
      factura: f.factura || "",
      fecha: f.fecha || "",
      baseImponible: f.baseImponible ?? null,
      importeTotal: f.importeTotal ?? null,
      proveedor: !nuevoDoc && proveedorTocado.current ? prev.proveedor : (f.proveedor || ""),
    }));
    setPedidosDetalle(gruposDesdeFactura(f));
    setPasoPedido(0);
    setIncluidosPedido({});
    setCorreccionPedido({});
    setLineasElegidasPorPedido({});
    setAlbaranesPorPedido({});
    setBorradorChooser(null);
    setNuevasLineasPorPedido({});
    setAnadirLineasBc({ estado: "idle" });
  }, [firmaLectura]);
  const [pedidosLeidos, setPedidosLeidos] = useState(null);
  const [esAlbaranDoc, setEsAlbaranDoc] = useState(false);
  const [albaranDoc, setAlbaranDoc] = useState("");
  const [lineasDocPdf, setLineasDocPdf] = useState([]);
  const [docAccion, setDocAccion] = useState(null);
  const [docAccionError, setDocAccionError] = useState("");
  const [pasoPedido, setPasoPedido] = useState(0);
  const [incluidosPedido, setIncluidosPedido] = useState({});
  const [verOtrosPedidos, setVerOtrosPedidos] = useState(false);
  const [correccionPedido, setCorreccionPedido] = useState({});
  const [textoPedido, setTextoPedido] = useState("");
  const [leyendoPedidoCorr, setLeyendoPedidoCorr] = useState(false);
  useEffect(() => {
    if (!modoDiario || !f.origen?.msg) {
      setPedidosLeidos([]);
      setEsAlbaranDoc(false);
      setAlbaranDoc("");
      setLineasDocPdf([]);
      return;
    }
    let vivo = true;
    setPedidosLeidos(null);
    setEsAlbaranDoc(false);
    setAlbaranDoc("");
    setLineasDocPdf([]);
    const q = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att ?? "")}`;
    fetch(`/api/facturas-compra/pedidos-factura?${q}`)
      .then((r) => r.json())
      .then((j) => {
        if (!vivo) return;
        const leidos = Array.isArray(j.pedidos) ? j.pedidos : [];
        setPedidosLeidos(leidos);
        setEsAlbaranDoc(!!j.esAlbaran);
        setAlbaranDoc(j.albaran || "");
        setLineasDocPdf(Array.isArray(j.lineas) ? j.lineas : []);
        // Reordenar grupos BC según el orden de lectura del PDF.
        if (leidos.length) {
          setPedidosDetalle((prev) => {
            const rank = new Map();
            leidos.forEach((n, i) => {
              const c = colaPedido(n);
              if (c && !rank.has(c)) rank.set(c, i);
            });
            if (!rank.size) return prev;
            const scored = prev.map((p, i) => ({
              p,
              i,
              r: rank.has(colaPedido(p.pedido)) ? rank.get(colaPedido(p.pedido)) : 10000 + i,
            }));
            scored.sort((a, b) => a.r - b.r || a.i - b.i);
            const next = scored.map((x) => x.p);
            if (next.length === prev.length && next.every((p, i) => p === prev[i])) return prev;
            return next;
          });
          setPasoPedido(0);
        }
      })
      .catch(() => { if (vivo) setPedidosLeidos([]); });
    return () => { vivo = false; };
  }, [modoDiario, f.origen?.msg, f.origen?.att]);
  const urlPdfBandeja = (ruta) => {
    if (!f.origen?.msg) return "";
    const q = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att || "")}`;
    return `/api/facturas-compra/bandeja/${ruta}?${q}`;
  };
  const descargarDocumento = async () => {
    setDocAccion("descarga");
    setDocAccionError("");
    try {
      const nombre = nombrePdfDocumento(cabecera.factura, esAlbaranDoc);
      const url = urlPdfBandeja("archivo.pdf");
      if (url) {
        const r = await fetch(url);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.detalle || j.error || "No se ha podido descargar el PDF.");
        }
        guardarBlob(await r.blob(), nombre);
      } else if (pdfB64) {
        guardarBlob(blobDesdeBase64(pdfB64), nombre);
      } else {
        throw new Error("Este documento no tiene PDF.");
      }
    } catch (err) {
      setDocAccionError(err.message || "No se ha podido descargar el documento.");
    }
    setDocAccion(null);
  };
  const descartarDocumento = async () => {
    if (!onDescartar) {
      setDocAccionError("No se puede descartar este documento.");
      return;
    }
    setDocAccion("descartar");
    setDocAccionError("");
    try {
      await onDescartar();
    } catch (err) {
      setDocAccionError(err.message || "No se ha podido descartar el documento.");
      setDocAccion(null);
    }
  };
  const editarCabecera = (campo, valor) => setCabecera((prev) => ({ ...prev, [campo]: valor }));
  const [proveedorFoco, setProveedorFoco] = useState(false);
  const proveedoresLista = useMemo(() => {
    const vistos = new Set();
    const lista = [];
    const anadir = (nombre) => {
      const n = String(nombre || "").trim();
      const clave = n.toUpperCase();
      if (!n || vistos.has(clave)) return;
      vistos.add(clave);
      lista.push(n);
    };
    for (const p of proveedoresBc || []) anadir(p.nombre);
    if (!lista.length) {
      const cols = columnasPedidos(pedidos?.headers || []);
      if (cols.proveedor) {
        for (const fila of pedidos?.rows || []) anadir(fila[cols.proveedor]);
      }
    }
    lista.sort((a, b) => a.localeCompare(b, "es"));
    return lista;
  }, [proveedoresBc, pedidos]);
  const indicarProveedor = (nombre) => {
    proveedorTocado.current = true;
    const hit = buscarProveedorBc(nombre, proveedoresBc);
    const exacto = hit?.nombre
      || proveedoresLista.find((n) => n.toUpperCase() === String(nombre || "").trim().toUpperCase())
      || "";
    setCabecera((prev) => ({ ...prev, proveedor: exacto || nombre }));
    if (!exacto) return;
    setPedidosDetalle((prev) => {
      const marcados = prev.map((p) => (p.pedido && !p.bcError ? p : { ...p, vendorName: exacto }));
      if (marcados.length) return marcados;
      return [{
        pedido: null,
        vendorName: exacto,
        bcError: "Sin pedido identificado — elige uno de este proveedor.",
        enlaceBC: null,
        lineas: [],
      }];
    });
  };
  // Si la IA dejó un CIF (p. ej. A28011864), lo sustituimos por el nombre de BC.
  useEffect(() => {
    const escrito = String(cabecera.proveedor || "").trim();
    if (!escrito || !proveedoresBc?.length) return;
    const hit = buscarProveedorBc(escrito, proveedoresBc);
    if (!hit?.nombre) return;
    if (hit.nombre.toUpperCase() === escrito.toUpperCase()) return;
    if (!pareceCifProveedor(escrito) && normalizarCifProveedor(escrito) !== normalizarCifProveedor(hit.cif)
        && normalizarCifProveedor(escrito) !== normalizarCifProveedor(hit.numero)) {
      return;
    }
    indicarProveedor(hit.nombre);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cabecera.proveedor, proveedoresBc]);
  const proveedorExacto = (() => {
    const escrito = String(cabecera.proveedor || "").trim();
    if (!escrito) return "";
    const hit = buscarProveedorBc(escrito, proveedoresBc);
    if (hit?.nombre) return hit.nombre;
    return proveedoresLista.find((n) => n.toUpperCase() === escrito.toUpperCase()) || "";
  })();
  const sugerenciasProveedor = useMemo(() => {
    const escrito = String(cabecera.proveedor || "").trim();
    if (!escrito || proveedorExacto) return [];
    const cifN = normalizarCifProveedor(escrito);
    const porCif = (proveedoresBc || [])
      .filter((p) => cifN && (normalizarCifProveedor(p.cif).includes(cifN) || normalizarCifProveedor(p.numero).includes(cifN)))
      .map((p) => p.nombre);
    const porNombre = proveedoresLista.filter((n) => coincideNombreProveedor(escrito, n));
    const vistos = new Set();
    const out = [];
    for (const n of [...porCif, ...porNombre]) {
      const k = n.toUpperCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(n);
      if (out.length >= 8) break;
    }
    return out;
  }, [cabecera.proveedor, proveedoresLista, proveedoresBc, proveedorExacto]);
  const nombresProveedorElegido = proveedorExacto
    ? [proveedorExacto]
    : (sugerenciasProveedor.length === 1 ? sugerenciasProveedor : [cabecera.proveedor || f.proveedor].map((n) => String(n || "").trim()).filter(Boolean));
  const listaProveedorId = `prov-${f.origen?.msg || "doc"}-${f.origen?.att || (f.paginas || []).join("-") || "0"}`;

  // Igual que elegirLineaBC pero para corregir a mano lo que ha leído la
  // IA de la propia línea facturada (descripción/cantidad/precio) — si
  // cambia la cantidad o el precio, se recalculan al momento "pendiente
  // de recibir"/"precio distinto" contra la línea de BC ya identificada.
  const editarLinea = (pIdx, lIdx, campo, valor) => {
    setPedidosDetalle((prev) =>
      prev.map((p, pi) => {
        if (pi !== pIdx) return p;
        return {
          ...p,
          lineas: p.lineas.map((l, li) => {
            if (li !== lIdx) return l;
            const actualizada = { ...l, [campo]: valor };
            if (l.lineaBC && (campo === "cantidadFacturada" || campo === "precioFacturado")) {
              const cantidad = campo === "cantidadFacturada" ? valor : l.cantidadFacturada;
              const precio = campo === "precioFacturado" ? valor : l.precioFacturado;
              actualizada.pendienteRecepcion = l.lineaBC.cantidadRecibida < (Number(cantidad) || 0) - 0.001;
              actualizada.diferenciaPrecio = precioDifiereCliente(precio, l.lineaBC.precioBC);
            }
            return actualizada;
          }),
        };
      })
    );
  };

  // Botón "Actualizar desde BC" en un pedido: vuelve a consultarlo en
  // vivo sin tener que resubir el PDF entero — por ejemplo si el pedido
  // se acaba de recibir en BC, o si antes faltaba una línea (como un
  // cargo de transporte) por un motivo ya corregido.
  const [refrescando, setRefrescando] = useState({}); // índice de pedido -> boolean

  const refrescarPedido = async (pIdx) => {
    const p = pedidosDetalle[pIdx];
    if (!p) return;
    setRefrescando((prev) => ({ ...prev, [pIdx]: true }));
    try {
      const r = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: p.pedido }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setPedidosDetalle((prev) =>
        prev.map((pp, i) => {
          if (i !== pIdx) return pp;
          const nuevasDisponibles = json.lineasDisponiblesBC || [];
          // Las líneas ya identificadas (automática o a mano) se
          // refrescan con los datos actuales de su misma línea de BC —
          // por si ya se ha recibido o ha cambiado el precio. Las que
          // seguían sin encontrarse mantienen su estado, ahora con el
          // desplegable ya actualizado para poder elegirlas a mano.
          const lineas = pp.lineas.map((l) => {
            if (!l.lineaBC) return l;
            const actualizada = nuevasDisponibles.find((lb) => lb.id === l.lineaBC.id);
            if (!actualizada) return l;
            const pendienteRecepcion = actualizada.cantidadRecibida < (Number(l.cantidadFacturada) || 0) - 0.001;
            const diferenciaPrecio = precioDifiereCliente(l.precioFacturado, actualizada.precioBC);
            return { ...l, lineaBC: actualizada, pendienteRecepcion, diferenciaPrecio };
          });
          return {
            ...pp,
            vendorName: json.vendorName ?? pp.vendorName,
            bcError: json.bcError,
            enlaceBC: json.enlaceBC ?? pp.enlaceBC,
            lineasDisponiblesBC: nuevasDisponibles,
            importe: json.importe != null ? json.importe : pp.importe,
            lineas,
          };
        })
      );
    } catch (err) {
      setPedidosDetalle((prev) => prev.map((pp, i) => (i === pIdx ? { ...pp, bcError: err.message || String(err) } : pp)));
    }
    setRefrescando((prev) => ({ ...prev, [pIdx]: false }));
  };

  // "Elegir pedido a mano" (Maria, 2026-09-04): cuando el pedido que ha
  // leído la IA del PDF no se encuentra en BC (p.bcError, p.ej. "Pedido
  // ... no encontrado en purchaseOrders"), permite sustituirlo por el
  // pedido real elegido en la lista de "Pedidos de compra pendientes de
  // facturar" de más abajo. Vuelve a consultar ESE pedido en BC (mismo
  // endpoint que "Actualizar desde BC") y limpia el emparejamiento de
  // las líneas ya leídas del PDF, para que Maria las reasocie a mano
  // contra las líneas del pedido nuevo.
  const aplicarPedidoElegido = async (pIdx, numeroPedido) => {
    if (!numeroPedido) return;
    setRefrescando((prev) => ({ ...prev, [pIdx]: true }));
    try {
      const r = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: numeroPedido }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setPedidosDetalle((prev) =>
        prev.map((pp, i) => {
          if (i !== pIdx) return pp;
          const nuevasDisponibles = json.lineasDisponiblesBC || [];
          const lineas = pp.lineas.map((l) => ({
            ...l,
            lineaBC: null,
            coincidencia: "sin_match",
            pendienteRecepcion: false,
            diferenciaPrecio: false,
          }));
          return {
            ...pp,
            pedido: numeroPedido,
            pedidoElegidoAMano: true,
            vendorName: json.vendorName ?? null,
            bcError: json.bcError,
            enlaceBC: json.enlaceBC ?? null,
            lineasDisponiblesBC: nuevasDisponibles,
            importe: json.importe != null ? json.importe : null,
            lineas,
          };
        })
      );
    } catch (err) {
      setPedidosDetalle((prev) =>
        prev.map((pp, i) => (i === pIdx ? { ...pp, pedido: numeroPedido, pedidoElegidoAMano: true, bcError: err.message || String(err) } : pp))
      );
    }
    setRefrescando((prev) => ({ ...prev, [pIdx]: false }));
    onCancelarSeleccion?.();
  };

  // Deja disponible aplicarPedidoElegido para el buscador de "Pedidos
  // de compra pendientes de facturar" (componente hermano, no hijo) —
  // se registra en cada render porque la función cierra sobre el estado
  // actual de esta tarjeta.
  useEffect(() => {
    registrarAplicador?.(aplicarPedidoElegido);
  });

  const elegirLineaBC = (pIdx, lIdx, lineaBcId) => {
    setPedidosDetalle((prev) =>
      prev.map((p, pi) => {
        if (pi !== pIdx) return p;
        const elegida = (p.lineasDisponiblesBC || []).find((lb) => lb.id === lineaBcId) || null;
        if (!elegida) return p;
        return {
          ...p,
          lineas: p.lineas.map((l, li) => {
            if (li !== lIdx) return l;
            const pendienteRecepcion = elegida.cantidadRecibida < (Number(l.cantidadFacturada) || 0) - 0.001;
            const diferenciaPrecio = precioDifiereCliente(l.precioFacturado, elegida.precioBC);
            return { ...l, lineaBC: elegida, coincidencia: "manual", pendienteRecepcion, diferenciaPrecio };
          }),
        };
      })
    );
  };

  // Motivos que no dependen de ninguna línea concreta y que NO se
  // pueden corregir a mano — solo queda "ya está entrada en BC" (un
  // duplicado no se arregla eligiendo un pedido). "No he podido
  // identificar a qué pedido..." se ha quitado de aquí (Maria,
  // 2026-09-04): ahora esas líneas sí se pueden corregir con "Elegir
  // pedido manualmente" (ver el grupo sintético en pedidosDetalle más
  // abajo), así que ese motivo debe recalcularse con el resto — si se
  // deja aquí fijo, seguiría en rojo para siempre aunque ya se hubiera
  // asociado el pedido correcto.
  const motivosFijos = useMemo(() => (f.motivos || []).filter((m) => m.startsWith("⚠ Esta factura ya está entrada")), [f.motivos]);

  // Semáforo y motivos recalculados a partir del estado local — así una
  // corrección manual de línea actualiza al momento si la factura ya se
  // puede entrar o no, sin tener que volver a subir el PDF.
  const { ok, motivos } = useMemo(() => {
    const motivosCalc = [];
    let algunProblema = false;
    for (const p of pedidosDetalle) {
      if (p.bcError) {
        algunProblema = true;
        motivosCalc.push(p.pedido ? `Pedido ${p.pedido}: ${p.bcError}` : p.bcError);
        continue;
      }
      for (const l of p.lineas || []) {
        if (l.coincidencia === "sin_match") {
          if (descripcionEsSoloPedido(l.descripcionFactura, p.pedido)) continue;
          algunProblema = true;
          motivosCalc.push(`Pedido ${p.pedido}: no encuentro en BC la línea "${l.descripcionFactura}" — revísala a mano.`);
          continue;
        }
        if (l.pendienteRecepcion) {
          algunProblema = true;
          const recibido = l.lineaBC?.cantidadRecibida ?? 0;
          const falta = Math.max(0, (Number(l.cantidadFacturada) || 0) - (Number(recibido) || 0));
          motivosCalc.push(
            `No se puede entrar: el pedido ${p.pedido} está pendiente de recibir. La factura pide ${l.cantidadFacturada} de «${l.lineaBC?.descripcion || l.descripcionFactura}» y en el pedido constan recibidas ${recibido}. Faltan ${falta}.`
          );
        }
        if (l.diferenciaPrecio) {
          algunProblema = true;
          motivosCalc.push(
            `Pedido ${p.pedido}: "${l.lineaBC?.descripcion || l.descripcionFactura}" — precio facturado ${l.precioFacturado} € vs precio en BC ${l.lineaBC?.precioBC} €.`
          );
        }
      }
    }
    const okCalc = pedidosDetalle.length > 0 && motivosFijos.length === 0 && !algunProblema;
    return { ok: okCalc, motivos: [...motivosFijos, ...motivosCalc] };
  }, [pedidosDetalle, motivosFijos]);

  // "Para" editable (Maria, 2026-09-04): los destinatarios se siguen
  // calculando solos por el departamento del pedido (como hasta ahora),
  // pero ahora se pueden corregir a mano antes de enviar — por si el
  // departamento detectado no es el correcto, o hace falta añadir/quitar
  // a alguien para un caso concreto. Mientras Maria no toque el campo,
  // se sigue sincronizando solo si cambia el cálculo automático (p. ej.
  // al elegir un pedido a mano); en cuanto lo edita, deja de
  // sobrescribirse — con un enlace para volver al cálculo automático.
  const listasAuto = useMemo(
    () => destinatariosFactura(pedidosDetalle, pedidos, remitenteEmail),
    [pedidosDetalle, pedidos, remitenteEmail]
  );
  const paraAutoTxt = listasAuto.para.join(", ");
  const ccAutoTxt = listasAuto.cc.join(", ");
  const [destinatariosTexto, setDestinatariosTexto] = useState(() => paraAutoTxt);
  const [destinatariosEditados, setDestinatariosEditados] = useState(false);
  const [ccTexto, setCcTexto] = useState(() => ccAutoTxt);
  const [ccEditado, setCcEditado] = useState(false);
  useEffect(() => {
    if (!destinatariosEditados) setDestinatariosTexto(paraAutoTxt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paraAutoTxt]);
  useEffect(() => {
    if (!ccEditado) setCcTexto(ccAutoTxt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccAutoTxt]);
  const emailsDeCampo = (texto) =>
    [...new Set(String(texto || "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@")))];
  const destinatarios = useMemo(() => emailsDeCampo(destinatariosTexto), [destinatariosTexto]);
  const copias = useMemo(
    () => emailsDeCampo(ccTexto).filter((e) => !destinatarios.some((p) => p.toLowerCase() === e.toLowerCase())),
    [ccTexto, destinatarios]
  );

  // "Entrar en BC de todas formas" (Maria, 2026-09-04): aunque el
  // semáforo esté en rojo (pedido no encontrado ya resuelto a mano,
  // línea sin encontrar, pendiente de recibir, precio distinto, o
  // factura que el backend cree duplicada), puede querer entrarla en
  // BC igualmente — es su decisión, no la de la validación automática.
  // Se manda `forzar: true`; el backend deja de bloquear esos motivos
  // con 409 y en vez de eso los apunta como avisos en la respuesta
  // (mismo sitio donde ya se enseñan los avisos de "varios
  // proveedores"), para que quede constancia de qué se ha pasado por
  // alto. Lo único que sigue bloqueando SIEMPRE, forzando o no: no
  // tener forma de identificar el proveedor en BC (pedido no
  // encontrado sin haberlo corregido a mano) — sin eso no hay a qué
  // proveedor crear la factura.
  const entrarEnBC = async (e, forzar = false) => {
    e.stopPropagation();
    setEntrada({ estado: "entrando" });
    try {
      // Reconstruimos las líneas "en crudo" (como las leyó la IA, más la
      // línea de BC ya elegida —automática o a mano— en pantalla) — el
      // backend vuelve a comprobarlo TODO contra BC en el momento de
      // crear la factura, no se fía de este semáforo calculado al subir
      // el PDF. Enviamos el id de la línea de BC ya identificada
      // (lineaBcId) para que el backend no tenga que re-adivinarla por
      // texto: así una corrección manual también se respeta al crear la
      // factura en BC.
      const lineasFactura = pedidosDetalle.flatMap((p) =>
        (p.lineas || []).map((l) => ({
          descripcion: l.descripcionFactura,
          cantidad: l.cantidadFacturada,
          precioUnitario: l.precioFacturado,
          pedido: p.pedido,
          lineaBcId: l.lineaBC?.id || undefined,
        }))
      );
      const sinPedido = !lineasFactura.some((l) => l.pedido);
      const r = await fetch("/api/facturas-compra/entrar-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factura: cabecera.factura,
          fechaFactura: cabecera.fecha || null,
          pdfBase64: f.pdfBase64 || pdfManual,
          msg: f.origen?.msg || null,
          att: f.origen?.att || null,
          nombreArchivo: `Factura_${cabecera.factura}.pdf`,
          lineasFactura,
          proveedor: cabecera.proveedor || f.proveedor || ultima?.proveedorBC || ultima?.proveedorFactura || null,
          baseImponible: cabecera.baseImponible,
          forzar,
          comoUltima: forzar && sinPedido ? {
            proveedor: cabecera.proveedor || f.proveedor || ultima?.proveedorBC || ultima?.proveedorFactura || null,
            factura: cabecera.factura,
            baseImponible: cabecera.baseImponible,
            lineas: lineasFactura.map((l) => ({
              descripcion: l.descripcion,
              cantidad: l.cantidad,
              precioUnitario: l.precioUnitario,
            })),
          } : undefined,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 207) throw new Error(json.error || `Error ${r.status}`);
      const huboProblema = json.facturasCreadas?.some((fc) => fc.error || !fc.ok);
      setEntrada({ estado: huboProblema ? "error" : "ok", resultado: json });
      if (!huboProblema) onEntrada?.({ msg: f.origen?.msg, att: f.origen?.att, factura: cabecera.factura });
    } catch (err) {
      setEntrada({ estado: "error", error: err.message || String(err) });
    }
  };

  const lineasParaPedido = () => {
    const dePedidos = pedidosDetalle
      .filter((p) => !p.pedido || p.bcError)
      .flatMap((p) => p.lineas || []);
    const crudas = dePedidos.length ? dePedidos : (f.lineasSinPedido || []);
    return crudas.map((l) => ({
      descripcion: l.descripcionFactura,
      cantidad: l.cantidadFacturada,
      precioUnitario: l.precioFacturado,
    }));
  };

  const abrirVistaPedido = async (e) => {
    e?.stopPropagation?.();
    const proveedorPedido = cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor;
    if (!proveedorPedido) return;
    if (pedidoNuevo.estado === "entrando" || (pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok)) return;
    if (pedidoNuevo.numero) return crearPedidoComoUltima(e);
    setVistaPedido({
      ot: otFerros || ultima?.ot || "",
      cargando: !ultima?.puedeCrear,
      error: null,
      propuesta: ultima?.puedeCrear ? ultima : null,
    });
    if (ultima?.puedeCrear) return;
    try {
      const r = await fetch("/api/facturas-compra/ultima-entrada", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor: proveedorPedido, ot: otFerros || null, factura: cabecera.factura }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      if (!j.ultimaEntrada?.puedeCrear) throw new Error(j.ultimaEntrada?.resumen || "No hay una factura anterior de este proveedor para copiar el pedido.");
      setVistaPedido({ ot: j.ultimaEntrada.ot || otFerros || "", cargando: false, error: null, propuesta: j.ultimaEntrada });
    } catch (err) {
      setVistaPedido((prev) => ({ ...(prev || { ot: "" }), cargando: false, error: err.message || String(err) }));
    }
  };

  const crearPedidoComoUltima = async (e, otElegida) => {
    e?.stopPropagation?.();
    const proveedorPedido = cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor;
    if (!proveedorPedido) return;
    if (pedidoNuevo.estado === "entrando" || (pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok)) return;
    const otFinal = otElegida !== undefined ? String(otElegida ?? "").trim() : (otFerros || "");
    if ((esFerrosGrupo || ultima?.regla === "ferros-grupo") && !otFinal) {
      setVistaPedido({
        ot: "",
        cargando: false,
        error: null,
        propuesta: ultima?.puedeCrear ? ultima : {
          regla: "ferros-grupo",
          cuenta: "60700004",
          descripcionFija: "TRABAJOS ENTRE EMPRESAS DEL GRUPO",
          lineType: "Account",
          proveedorBC: proveedorPedido,
          puedeCrear: true,
        },
      });
      return;
    }
    setVistaPedido(null);
    setPedidoNuevo((prev) => ({ ...prev, estado: "entrando", error: undefined }));
    const lineas = lineasParaPedido();
    try {
      const r = await fetch("/api/facturas-compra/crear-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor: proveedorPedido,
          fecha: cabecera.fecha || null,
          factura: cabecera.factura,
          msg: f.origen?.msg || null,
          att: f.origen?.att || null,
          baseImponible: cabecera.baseImponible,
          ...(otFinal ? { ot: otFinal } : {}),
          ...(esFerrosGrupo || ultima?.regla === "ferros-grupo" ? { regla: "ferros-grupo" } : {}),
          lineas,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setPedidoNuevo({ estado: "ok", ...json });
    } catch (err) {
      const error = err.message || String(err);
      setPedidoNuevo((prev) => prev.numero
        ? { ...prev, estado: "ok", registro: { ok: false, error } }
        : { estado: "error", error });
    }
  };

  const asuntoIncidencia = `Incidencia factura ${cabecera.factura}${pedidosDetalle?.[0]?.pedido ? ` — Pedido ${pedidosDetalle[0].pedido}` : ""}`;
  const [pedidosAvisados, setPedidosAvisados] = useState(() => new Set());

  // Misma fuente de verdad que el aviso de la propuesta: primero el pedido en foco.
  const motivoCorreoProveedorActual = () => {
    const pedidos = (listaPedidosFactura.length ? listaPedidosFactura : pedidosDetalle.map((p) => p.pedido).filter(Boolean))
      .map((n) => correccionPedido[n] || n)
      .filter(Boolean);
    const foco = numeroPropuesta || pedidos[0] || null;
    const nums = foco ? [foco, ...pedidos.filter((n) => !mismoPedidoFactura(n, foco))] : pedidos;
    for (const num of nums) {
      const lineas = Array.isArray(lineasBcPorPedido[num])
        ? lineasBcPorPedido[num]
        : (pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num))?.lineasDisponiblesBC || []);
      const tiene = Array.isArray(lineasBcPorPedido[num])
        || Array.isArray(pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num))?.lineasDisponiblesBC);
      if (!tiene) continue;
      const restante = (lineas || []).some((l) => Math.max(0, (Number(l.cantidadRecibida) || 0) - (Number(l.cantidadFacturada) || 0)) > 0.0001);
      const motivo = motivoBloqueoPedidoProveedor(lineas, { tieneLineasBc: true, hayFilasChooser: restante });
      if (motivo) return motivo;
    }
    return null;
  };

  const textoCorreoProveedor = (motivo = null, pedidoFoco = null) => {
    const pedidos = (listaPedidosFactura.length ? listaPedidosFactura : pedidosDetalle.map((p) => p.pedido).filter(Boolean));
    const foco = pedidoFoco || numeroPropuesta || null;
    const pedidoTxt = foco
      ? (correccionPedido[foco] || foco)
      : (pedidos.length ? pedidos.join(", ") : "el que figura en la factura");
    const mats = pedidosDetalle.flatMap((p) => (p.lineas || []).map((l) => ({
      descripcion: l.descripcionFactura,
      cantidad: l.cantidadFacturada,
    }))).filter((l) => l.descripcion).slice(0, 8);
    const bloque = mats.length
      ? `\n\nMaterial de la factura:\n${mats.map((l) => `· ${l.descripcion}${l.cantidad != null && l.cantidad !== "" ? ` — cantidad ${l.cantidad}` : ""}`).join("\n")}`
      : "";
    const fechaTxt = cabecera.fecha ? fmtFechaFactura(cabecera.fecha) : "";
    const motivoFinal = motivo || motivoCorreoProveedorActual() || "sin_recibir";
    return `Buenos días,\n\nHemos recibido la factura ${cabecera.factura || ""}${fechaTxt && fechaTxt !== "—" ? ` de fecha ${fechaTxt}` : ""}${cabecera.proveedor || f.proveedor ? ` de ${cabecera.proveedor || f.proveedor}` : ""}.\n\n${parrafoCorreoMotivoPedido(motivoFinal, pedidoTxt)}${bloque}\n\n${cierreCorreoMotivoPedido(motivoFinal)}`;
  };

  const textoCorreoInternoFactura = (motivo = null, pedidoFoco = null) => {
    const pedidos = (listaPedidosFactura.length ? listaPedidosFactura : pedidosDetalle.map((p) => p.pedido).filter(Boolean));
    const foco = pedidoFoco || numeroPropuesta || null;
    const pedidoTxt = foco
      ? (correccionPedido[foco] || foco)
      : (pedidos.length ? pedidos.join(", ") : "el de la factura");
    const fechaTxt = cabecera.fecha ? fmtFechaFactura(cabecera.fecha) : "";
    const motivoFinal = motivo || motivoCorreoProveedorActual() || "sin_recibir";
    return `Buenos días,\n\nOs escribimos por la factura ${cabecera.factura || ""}${fechaTxt && fechaTxt !== "—" ? ` de fecha ${fechaTxt}` : ""}${cabecera.proveedor || f.proveedor ? ` de ${cabecera.proveedor || f.proveedor}` : ""}.\n\nEl pedido ${pedidoTxt} figura pendiente de recibir o sin albarán firmado, y por eso no podemos registrar la factura.\n\n${parrafoCorreoMotivoPedido(motivoFinal, pedidoTxt)}\n\n¿Podéis confirmar si el material ya se ha recibido, si falta el albarán firmado o si hay alguna incidencia?`;
  };

  const destinosInternosFactura = (pedidoFoco = null) => {
    const foco = pedidoFoco || numeroPropuesta || null;
    const grupos = foco
      ? [{ pedido: foco }]
      : (pedidosDetalle || []).filter((p) => p.pedido).map((p) => ({ pedido: p.pedido }));
    const listas = destinatariosFactura(grupos.length ? grupos : pedidosDetalle, pedidos, remitenteEmail);
    const admin = copiasAdministracion(remitenteEmail);
    const vistos = new Set();
    const para = [];
    for (const e of [...(listas.para || []), ...admin]) {
      const k = String(e || "").trim().toLowerCase();
      if (!k || vistos.has(k)) continue;
      vistos.add(k);
      para.push(String(e).trim());
    }
    return para;
  };

  const elegirTipoCorreoProveedor = (tipo) => {
    setVistaCorreo((v) => {
      if (!v?.alProveedor) return v;
      const motivo = v.motivo || "sin_recibir";
      if (tipo === "interno") {
        return {
          ...v,
          tipoMensaje: "interno",
          paraTexto: (v.paraInterno || destinosInternosFactura(v.pedido)).join("; "),
          ccTexto: "",
          cuerpo: textoCorreoInternoFactura(motivo, v.pedido),
        };
      }
      return {
        ...v,
        tipoMensaje: "proveedor",
        paraTexto: v.paraProveedor || "",
        ccTexto: (v.ccProveedor || destinosInternosFactura(v.pedido)).join("; "),
        cuerpo: textoCorreoProveedor(motivo, v.pedido),
      };
    });
  };

  const abrirCorreoProveedor = (e, motivoOverride = null, pedidoFoco = null) => {
    e?.stopPropagation?.();
    if (envio.estado === "enviando") return;
    if (envio.estado === "error") setEnvio({ estado: "idle" });
    // Mismo motivo que el aviso UI de la propuesta (o el del pedido en foco).
    const motivo = motivoOverride || motivoCorreoProveedorActual() || "sin_recibir";
    const pedidoCorreo = pedidoFoco || numeroPropuesta || null;
    const paraRemitente = emailRemitenteFactura(f.origen);
    const internos = destinosInternosFactura(pedidoCorreo);
    setVistaCorreo({
      alProveedor: true,
      tipoMensaje: "proveedor",
      motivo,
      pedido: pedidoCorreo,
      asunto: asuntoCorreoMotivoPedido(cabecera.factura, motivo),
      cuerpo: textoCorreoProveedor(motivo, pedidoCorreo),
      // Para = quien nos envió la factura (remitente bandeja), no vacío.
      paraTexto: paraRemitente,
      paraProveedor: paraRemitente,
      paraInterno: internos,
      ccTexto: internos.join("; "),
      ccProveedor: internos,
    });
    if (!pdfB64 && f.origen?.msg) {
      const q = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att ?? "")}`;
      fetch(`/api/facturas-compra/bandeja/pdf?${q}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d?.base64) return;
          setVistaCorreo((v) => (v?.alProveedor ? { ...v, pdfBase64: d.base64 } : v));
        })
        .catch(() => {});
    }
    // Si el origen aún no trae el remitente, se completa desde BC solo como respaldo.
    if (paraRemitente) return;
    const nombre = String(cabecera.proveedor || f.proveedor || "").trim();
    if (!nombre) return;
    fetch(`/api/bc/proveedor-email?nombre=${encodeURIComponent(nombre)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.email) return;
        setVistaCorreo((v) => {
          if (!v?.alProveedor || String(v.paraProveedor || "").trim()) return v;
          const next = { ...v, paraProveedor: d.email };
          if (v.tipoMensaje !== "interno") next.paraTexto = d.email;
          return next;
        });
      })
      .catch(() => {});
  };

  const abrirCorreoPendiente = (lista) => {
    const grupos = (lista || []).map((p) => ({ pedido: p.pedido }));
    let listas = destinatariosFactura(grupos.length ? grupos : pedidosDetalle, pedidos, remitenteEmail);
    const codigos = [...new Set((lista || []).map((p) => String(p.departamento || "").trim()).filter(Boolean))];
    const porCodigo = [...new Set(codigos.flatMap((c) => emailsPorCodigoDepartamento(c) || []))];
    if (porCodigo.length) {
      listas = aplicarRemitente(porCodigo, listasCorreoDepartamento(codigos[0]).cc, remitenteEmail);
    }
    const proveedorTxt = cabecera.proveedor || f.proveedor || "";
    const pedidosTxt = (lista || []).map((p) => p.pedido).filter(Boolean);
    const frasePedido = pedidosTxt.length > 1
      ? `Però els pedidos ${pedidosTxt.join(", ")}, els tenim pendents de rebre o no tenim l'albarà firmat`
      : `Però el pedido ${pedidosTxt[0] || "de la factura"}, el tenim pendent de rebre o no tenim l'albarà firmat`;
    setVistaCorreo({
      alResponsable: true,
      pedido: lista?.[0]?.pedido || null,
      asunto: `Factura ${cabecera.factura || ""} — sabeu si l'hem rebut?`,
      cuerpo: `Bones!\n\nEns ha arribat la factura ${cabecera.factura || ""}${proveedorTxt ? ` de ${proveedorTxt}` : ""}.\n\n${frasePedido}, sabeu alguna coseta si ho hem rebut o no, o si teniu l'albarà firmat porfa.\n\nQuedo a l'espera d'una resposta.`,
      paraTexto: listas.para.join(", "),
      ccTexto: listas.cc.join(", "),
    });
  };

  const crearYRegistrar = async (e) => {
    e?.stopPropagation?.();
    const nums = listaVisible.filter((n) => incluidosPedido[colaPedido(n)]);
    if (!nums.length || entrada.estado === "entrando") return;
    // Los checks del pedido abierto mandan: si se cambió la selección después
    // de «Incluir», no se arrastran albaranes antiguos al borrador de BC.
    let elegidas = { ...lineasElegidasPorPedido };
    if (numeroPropuesta && incluidosPedido[colaPedido(numeroPropuesta)] && borradorChooser) {
      const itemsVivos = itemsDesdeBorrador();
      if (itemsVivos.length) {
        const clave = colaPedido(numeroPropuesta);
        const modoVivo = itemsVivos.some((it) => it.albaran) ? "albaran" : "pedido";
        elegidas = { ...elegidas, [clave]: { modo: modoVivo, items: itemsVivos } };
        setLineasElegidasPorPedido(elegidas);
      }
    }
    for (const num of nums) {
      const sel = elegidas[colaPedido(num)] || elegidas[num];
      if (!sel?.items?.length) {
        setEntrada({
          estado: "error",
          error: `Marca las líneas (o el albarán) de ${num} e Incluir en la factura antes de crear el borrador.`,
        });
        return;
      }
      const albs = [...new Set((sel.items || []).map((it) => it.albaran).filter(Boolean))];
      if ((sel.modo || "").toLowerCase() === "albaran" && !albs.length) {
        setEntrada({
          estado: "error",
          error: `El pedido ${num} tiene varios albaranes: marca solo el/los de esta factura e Incluir antes de crear el borrador.`,
        });
        return;
      }
    }
    // Si ya hay albaranes incluidos, se puede crear el borrador aunque el
    // pedido tenga cantidades pendientes de recibir. Solo se bloquea cuando
    // no hay albarán marcado (entonces hace falta Registrar antes).
    if (pedidoIncluidoSinRecibir) {
      const sinAlbaran = nums.some((num) => {
        const sel = elegidas[colaPedido(num)] || elegidas[num];
        return !(sel?.items || []).some((it) => it.albaran);
      });
      if (sinAlbaran) {
        setEntrada({
          estado: "error",
          error: "El pedido todavía no está recibido. Pulsa Registrar: solo recibe el pedido. No se crea la factura.",
        });
        return;
      }
    }
    setEntrada({ estado: "entrando" });
    try {
      let pdfBase64 = pdfB64 || null;
      if (!pdfBase64 && f.origen?.msg) {
        try {
          const q = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att ?? "")}`;
          const rPdf = await fetch(`/api/facturas-compra/bandeja/pdf?${q}`);
          const jPdf = await rPdf.json().catch(() => ({}));
          if (rPdf.ok && jPdf.base64) pdfBase64 = jPdf.base64;
        } catch { /* el servidor busca el PDF por el correo */ }
      }
      const seleccionPorPedido = {};
      for (const num of nums) {
        const sel = elegidas[colaPedido(num)] || elegidas[num];
        if (!sel?.items?.length) continue;
        const albaranes = [...new Set((sel.items || []).map((it) => it.albaran).filter(Boolean))];
        seleccionPorPedido[num] = {
          modo: sel.modo || (albaranes.length ? "albaran" : "pedido"),
          albaranes,
          lineas: (sel.items || []).map((it) => ({
            id: it.id || null,
            lineaPedidoId: it.lineaPedidoId || null,
            codigo: it.codigo || null,
            descripcion: it.descripcion || null,
            cantidad: it.cantidad,
            albaran: it.albaran || null,
            importe: it.importe,
          })),
        };
      }
      const r = await fetch("/api/facturas-compra/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factura: cabecera.factura,
          fechaFactura: cabecera.fecha || null,
          proveedor: cabecera.proveedor || f.proveedor || null,
          pedidos: nums,
          seleccionPorPedido,
          msg: f.origen?.msg || null,
          att: f.origen?.att ?? null,
          pdfBase64,
          nombreArchivo: `Factura_${cabecera.factura || "proveedor"}.pdf`,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      const avisoOk = j.aviso || (j.yaExistia
        ? `La factura ya está en BC (${j.numero || "sin nº"}). No se ha creado otra.`
        : `Borrador ${j.numero || "sin nº"} creado en BC. Puedes registrarlo en Business Central, donde tu usuario tiene permiso.`);
      setEntrada({ estado: "ok", resultado: j, aviso: avisoOk });
    } catch (err) {
      setEntrada({ estado: "error", error: err.message || String(err) });
    }
  };

  const abrirVistaCorreo = (e, pedidoNumero) => {
    e?.stopPropagation?.();
    if (envio.estado === "enviando") return;
    if (envio.estado === "error") setEnvio({ estado: "idle" });
    const pedido = pedidoNumero
      ? pedidosDetalle.find((p) => String(p.pedido || "").toUpperCase() === String(pedidoNumero).toUpperCase())
      : null;
    if (pedido) {
      const listas = destinatariosFactura([pedido], pedidos, remitenteEmail);
      const filas = filasIncidenciaPedido(pedido);
      setVistaCorreo({
        pedido: pedido.pedido,
        asunto: `Incidencia factura ${cabecera.factura} — Pedido ${pedido.pedido}`,
        cuerpoHtml: htmlIncidenciaPedido({
          factura: cabecera.factura,
          fecha: cabecera.fecha,
          proveedor: cabecera.proveedor || f.proveedor || pedido.vendorName || "",
          pedido: pedido.pedido,
          filas,
        }),
        paraTexto: listas.para.join(", "),
        ccTexto: listas.cc.join(", "),
      });
      return;
    }
    if (!destinatarios.length) return;
    setVistaCorreo({
      pedido: null,
      asunto: asuntoIncidencia,
      cuerpo: cuerpoIncidenciaTexto(cabecera.factura, motivos),
      paraTexto: destinatariosTexto,
      ccTexto,
    });
  };

  const enviarAviso = async (e) => {
    e?.stopPropagation?.();
    if (!vistaCorreo) return;
    const paraEnvio = emailsDeCampo(vistaCorreo.paraTexto);
    const ccEnvio = emailsDeCampo(vistaCorreo.ccTexto).filter((x) => !paraEnvio.some((p) => p.toLowerCase() === x.toLowerCase()));
    if (!paraEnvio.length) return;
    setEnvio({ estado: "enviando" });
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: paraEnvio,
          cc: ccEnvio,
          asunto: (vistaCorreo.asunto || asuntoIncidencia).trim(),
          cuerpoHtml: vistaCorreo.cuerpoHtml || textoPlanoAHtml(vistaCorreo.cuerpo),
          adjunto: (vistaCorreo.pdfBase64 || pdfB64) ? { nombre: `Factura_${cabecera.factura}.pdf`, base64: vistaCorreo.pdfBase64 || pdfB64 } : null,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      if (vistaCorreo.alProveedor) {
        setVistaCorreo(null);
        setEnvio({ estado: "idle" });
        return;
      }
      const nums = vistaCorreo.pedido
        ? [vistaCorreo.pedido]
        : [...new Set(pedidosDetalle.filter((p) => p.pedido && (p.lineas || []).some((l) => l.pendienteRecepcion)).map((p) => p.pedido))];
      const texto = vistaCorreo.alResponsable
        ? `Preguntado al responsable si el trabajo del pedido ${vistaCorreo.pedido || ""} está hecho, para poder registrar la factura ${cabecera.factura}. Enviado a ${paraEnvio.join(", ")}`
        : `Incidencia de la factura ${cabecera.factura}${vistaCorreo.pedido ? ` · ${vistaCorreo.pedido}` : ""} enviada a ${paraEnvio.join(", ")}${ccEnvio.length ? ` (copia: ${ccEnvio.join(", ")})` : ""}`;
      for (const pedido of nums) {
        await fetch("/api/recepcion/nota", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pedido, texto, autor: "📧 Correo" }),
        }).catch(() => {});
      }
      if (nums.length) {
        const d = await fetch("/api/recepcion").then((x) => x.json()).catch(() => null);
        if (d) setRecepPedido(d);
      }
      if (vistaCorreo.pedido) {
        setPedidosAvisados((prev) => new Set([...prev, String(vistaCorreo.pedido).toUpperCase()]));
      }
      setVistaCorreo(null);
      setEnvio({ estado: "idle" });
    } catch (err) {
      setEnvio({ estado: "error", error: err.message || String(err) });
    }
  };

  // Factura OK → reenviar el PDF al buzón Continia Document Capture
  // (no crea borrador en BC: Continia lo entra).
  const enviarAContinia = async (e) => {
    e.stopPropagation();
    if (!f.pdfBase64) {
      setContinia({ estado: "error", error: "No hay PDF de la factura para adjuntar." });
      return;
    }
    setContinia({ estado: "enviando" });
    try {
      const vendorName =
        pedidosDetalle.find((p) => p.vendorName)?.vendorName ||
        f.proveedor ||
        "";
      const pcs = pedidosDetalle.map((p) => p.pedido).filter(Boolean).join(", ");
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: [EMAIL_CONTINIA],
          asunto: `Factura ${cabecera.factura}${pcs ? ` · ${pcs}` : ""}${vendorName ? ` · ${vendorName}` : ""}`,
          cuerpoHtml: construirCuerpoContinia({
            factura: cabecera.factura,
            fecha: cabecera.fecha,
            pedidosDetalle,
            vendorName,
          }),
          adjunto: {
            nombre: `Factura_${cabecera.factura}.pdf`,
            base64: f.pdfBase64,
            mime: "application/pdf",
          },
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      setContinia({ estado: "ok", de: json.de });
    } catch (err) {
      setContinia({ estado: "error", error: err.message || String(err) });
    }
  };

  const pcsFormanFactura = pedidosDetalle.filter((p) => p.pedido);
  const sinPedidoUtil = !esGasto && !pedidosDetalle.some((p) => p.pedido && !p.bcError);
  // Chips / «Propuesta N de M»: orden del PDF (pedidosLeidos), no BC ni alpha.
  const listaPedidosFactura = [];
  const colasVistas = new Set();
  const fuenteOrden = (pedidosLeidos && pedidosLeidos.length)
    ? [...pedidosLeidos, ...pedidosDetalle.map((p) => p.pedido).filter(Boolean)]
    : pedidosDetalle.map((p) => p.pedido).filter(Boolean);
  for (const num of fuenteOrden) {
    const cola = colaPedido(num);
    if (!cola) continue;
    const ya = listaPedidosFactura.findIndex((n) => colaPedido(n) === cola);
    if (ya >= 0) {
      if (String(num).length > String(listaPedidosFactura[ya]).length) listaPedidosFactura[ya] = num;
      continue;
    }
    if (colasVistas.has(cola)) continue;
    colasVistas.add(cola);
    listaPedidosFactura.push(num);
  }
  const listaVisible = listaPedidosFactura.map((n) => correccionPedido[n] || n);
  const pasoSeguro = Math.min(pasoPedido, Math.max(0, listaVisible.length - 1));
  const origenPropuesta = listaPedidosFactura[pasoSeguro] || null;
  const numeroPropuesta = listaVisible[pasoSeguro] || null;
  useEffect(() => {
    setTextoPedido(numeroPropuesta || "");
    setAnadirLineasBc({ estado: "idle" });
  }, [pasoSeguro, origenPropuesta, numeroPropuesta]);
  const corregirPedido = async (escrito) => {
    const numero = normalizarNumeroPedido(escrito);
    if (!origenPropuesta || !numero || numero === numeroPropuesta) return;
    setCorreccionPedido((prev) => ({ ...prev, [origenPropuesta]: numero }));
    setTextoPedido(numero);
    setLineasElegidasPorPedido((prev) => {
      const next = { ...prev };
      delete next[colaPedido(origenPropuesta)];
      delete next[colaPedido(numero)];
      return next;
    });
    setBorradorChooser(null);
    setLeyendoPedidoCorr(true);
    try {
      const r = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: numero }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setPedidosDetalle((prev) => {
        const idx = prev.findIndex((p) => mismoPedidoFactura(p.pedido, origenPropuesta) || mismoPedidoFactura(p.pedido, numero) || p.pedido === origenPropuesta);
        const base = idx >= 0 ? prev[idx] : { lineas: [] };
        const grupo = {
          ...base,
          pedido: numero,
          pedidoElegidoAMano: true,
          vendorName: json.vendorName ?? base.vendorName ?? null,
          bcError: json.bcError || null,
          enlaceBC: json.enlaceBC ?? null,
          lineasDisponiblesBC: json.lineasDisponiblesBC || [],
          importe: json.importe != null ? json.importe : null,
          lineas: (base.lineas || []).map((l) => ({ ...l, lineaBC: null, coincidencia: "sin_match", pendienteRecepcion: false, diferenciaPrecio: false })),
        };
        if (idx >= 0) return prev.map((p, i) => (i === idx ? grupo : p));
        return [...prev, grupo];
      });
    } catch (err) {
      setPedidosDetalle((prev) => {
        const idx = prev.findIndex((p) => mismoPedidoFactura(p.pedido, origenPropuesta) || p.pedido === origenPropuesta);
        const grupo = { pedido: numero, pedidoElegidoAMano: true, bcError: err.message || String(err), lineas: [], lineasDisponiblesBC: [] };
        if (idx >= 0) return prev.map((p, i) => (i === idx ? { ...p, ...grupo } : p));
        return [...prev, grupo];
      });
    }
    setLeyendoPedidoCorr(false);
  };
  // El PDF no trae nº de pedido: la fila de "Pedidos pendientes de facturar"
  // incorpora ese PC al conjunto, igual que "Incluir en la factura" del stepper.
  const incluirPedidoEnFactura = (numeroRaw, proveedorNombre) => {
    const num = normalizarNumeroPedido(numeroRaw);
    const cola = colaPedido(num);
    if (!num || !cola) return;
    setPedidosDetalle((prev) => {
      if (prev.some((p) => mismoPedidoFactura(p.pedido, num))) return prev;
      const vacio = prev.findIndex((p) => !String(p.pedido || "").trim());
      if (vacio >= 0) {
        return prev.map((p, i) => (i === vacio ? {
          ...p,
          pedido: num,
          pedidoElegidoAMano: true,
          incluidoDesdePendientes: true,
          vendorName: p.vendorName || proveedorNombre || null,
          bcError: null,
        } : p));
      }
      return [...prev, {
        pedido: num,
        pedidoElegidoAMano: true,
        incluidoDesdePendientes: true,
        vendorName: proveedorNombre || null,
        bcError: null,
        enlaceBC: null,
        lineas: [],
        lineasDisponiblesBC: [],
      }];
    });
    setIncluidosPedido((prev) => ({ ...prev, [cola]: true }));
  };
  const pedidoVieneDeLaFactura = (num) => {
    if ((pedidosLeidos || []).some((x) => mismoPedidoFactura(x, num))) return true;
    const g = pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num));
    return !!g && !g.incluidoDesdePendientes;
  };
  const hayPedidosEnElPdf = listaPedidosFactura.some(pedidoVieneDeLaFactura);
  const numerosConjunto = listaVisible.filter((n) => incluidosPedido[colaPedido(n)]);
  const claveConjunto = numerosConjunto.join("|");
  // Cada propuesta (y cada PC del conjunto) se relee en vivo de BC: % dto +
  // importe línea excl. IVA. No reutilizar extract viejo sin descuentoPct.
  useEffect(() => {
    const pedido = numeroPropuesta;
    if (!pedido) return;
    let vivo = true;
    (async () => {
      try {
        const r = await fetch("/api/facturas-compra/refrescar-pedido", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pedido }),
        });
        const json = await r.json().catch(() => ({}));
        if (!vivo || !r.ok) return;
        const lineas = json.lineasDisponiblesBC || [];
        const albs = Array.isArray(json.albaranes) ? json.albaranes : [];
        setLineasBcPorPedido((prev) => ({ ...prev, [pedido]: lineas }));
        setAlbaranesPorPedido((prev) => ({ ...prev, [pedido]: albs }));
        setPedidosDetalle((prev) => prev.map((p) => {
          if (!mismoPedidoFactura(p.pedido, pedido)) return p;
          return {
            ...p,
            lineasDisponiblesBC: lineas,
            albaranes: albs,
            importe: json.importe != null ? json.importe : p.importe,
            vendorName: json.vendorName ?? p.vendorName,
            bcError: json.bcError || null,
            enlaceBC: json.enlaceBC ?? p.enlaceBC,
          };
        }));
      } catch { /* se muestra lo que haya hasta el siguiente paso */ }
    })();
    return () => { vivo = false; };
  }, [numeroPropuesta]);
  useEffect(() => {
    const nums = claveConjunto ? claveConjunto.split("|") : [];
    if (!nums.length) return;
    let vivo = true;
    (async () => {
      for (const num of nums) {
        if (num === numeroPropuesta) continue; // ya lo pide el efecto de propuesta
        try {
          const r = await fetch("/api/facturas-compra/refrescar-pedido", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido: num }),
          });
          const json = await r.json().catch(() => ({}));
          if (!vivo || !r.ok) continue;
          const lineas = json.lineasDisponiblesBC || [];
          const albs = Array.isArray(json.albaranes) ? json.albaranes : [];
          setLineasBcPorPedido((prev) => ({ ...prev, [num]: lineas }));
          setAlbaranesPorPedido((prev) => ({ ...prev, [num]: albs }));
          setPedidosDetalle((prev) => prev.map((p) => (
            mismoPedidoFactura(p.pedido, num)
              ? {
                  ...p,
                  lineasDisponiblesBC: lineas,
                  albaranes: albs,
                  importe: json.importe != null ? json.importe : p.importe,
                  vendorName: json.vendorName ?? p.vendorName,
                  bcError: json.bcError || null,
                  enlaceBC: json.enlaceBC ?? p.enlaceBC,
                }
              : p
          )));
        } catch { /* el botón se decide con lo que ya haya */ }
      }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveConjunto]);
  const pedidoIncluidoSinRecibir = numerosConjunto.some((num) => {
    const cargadas = lineasBcPorPedido[num];
    if (Array.isArray(cargadas)) return pedidoTienePendienteRecibir(cargadas);
    const g = pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num));
    if ((g?.lineasDisponiblesBC || []).length) return pedidoTienePendienteRecibir(g.lineasDisponiblesBC);
    if ((g?.lineas || []).some((l) => l.pendienteRecepcion)) return true;
    return true;
  });
  const registrarPedidoEnBc = async (e, pedidosObjetivo) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const objetivos = (Array.isArray(pedidosObjetivo) && pedidosObjetivo.length ? pedidosObjetivo : numerosConjunto)
      .map((n) => String(n || "").trim())
      .filter(Boolean);
    if (registroRecepcion.estado === "registrando" || !objetivos.length) return;
    setRegistroRecepcion({ estado: "registrando" });
    try {
      let pdfBase64 = pdfB64;
      if (!pdfBase64) {
        const url = urlPdfBandeja("pdf");
        if (!url) throw new Error("Este documento no tiene PDF.");
        const rPdf = await fetch(url);
        const jPdf = await rPdf.json().catch(() => ({}));
        if (!rPdf.ok || !jPdf.base64) throw new Error(jPdf.detalle || jPdf.error || "No se ha podido leer el PDF.");
        pdfBase64 = jPdf.base64;
        setPdfManual(pdfBase64);
      }
      let albaranLeido = String(albaranDoc || "").trim();
      let lineasPdf = lineasDocPdf;
      if ((!albaranLeido || !lineasPdf.length) && f.origen?.msg) {
        const qDoc = `msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att ?? "")}`;
        const rDoc = await fetch(`/api/facturas-compra/pedidos-factura?${qDoc}`);
        const jDoc = await rDoc.json().catch(() => ({}));
        if (rDoc.ok) {
          if (!albaranLeido && jDoc.albaran) albaranLeido = String(jDoc.albaran).trim();
          if (Array.isArray(jDoc.lineas) && jDoc.lineas.length) lineasPdf = jDoc.lineas;
          setAlbaranDoc(albaranLeido);
          if (lineasPdf.length) setLineasDocPdf(lineasPdf);
        }
      }
      const albaran = String(albaranLeido || cabecera.factura || f.factura || "").trim();
      if (!albaran) throw new Error("Falta el nº de albarán del documento.");
      let alguno = false;
      for (const pedido of objetivos) {
        let lineas = lineasBcPorPedido[pedido] || pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, pedido))?.lineasDisponiblesBC || [];
        if (!lineas.length) {
          const rLin = await fetch("/api/facturas-compra/refrescar-pedido", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido }),
          });
          const jLin = await rLin.json().catch(() => ({}));
          if (!rLin.ok) throw new Error(jLin.error || `No se han podido leer las líneas de ${pedido}.`);
          lineas = jLin.lineasDisponiblesBC || [];
        }
        const grupo = pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, pedido));
        const lineasEnvio = lineasParaRegistrarRecepcion(lineas, lineasDocumentoParaRecepcion(grupo?.lineas || [], lineasPdf));
        if (!lineasEnvio.length) {
          if (!pedidoTienePendienteRecibir(lineas)) continue;
          throw new Error(`No encuentro qué línea de ${pedido} corresponde a esta factura.`);
        }
        const r = await fetch("/api/recepcion/subir-bc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pedido,
            registrar: true,
            albaran,
            pdfBase64,
            nombreArchivo: `${pedido}.pdf`,
            ajustesPedido: [],
            lineas: lineasEnvio,
            nuevasLineas: [],
          }),
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([json.error || `Error ${r.status}`, json.detalle].filter(Boolean).join(" — "));
        if (!json.registro?.ok) throw new Error(json.registro?.error || `No se ha registrado ${pedido}.`);
        alguno = true;
        const rRef = await fetch("/api/facturas-compra/refrescar-pedido", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pedido }),
        });
        const jRef = await rRef.json().catch(() => ({}));
        const deBc = rRef.ok ? (jRef.lineasDisponiblesBC || []) : [];
        const frescas = (deBc.length ? deBc : lineas).map((l) => {
          const previa = lineas.find((x) => x.id === l.id) || l;
          const envio = lineasEnvio.find((x) => x.lineaId === l.id);
          const optimista = (Number(previa.cantidadRecibida) || 0) + (envio ? Number(envio.cantidad) || 0 : 0);
          return { ...l, cantidadRecibida: Math.max(Number(l.cantidadRecibida) || 0, optimista) };
        });
        setLineasBcPorPedido((prev) => ({ ...prev, [pedido]: frescas }));
        setPedidosDetalle((prev) => prev.map((p) => {
          if (!mismoPedidoFactura(p.pedido, pedido)) return p;
          const lineasFact = (p.lineas || []).map((l) => {
            const actual = (l.lineaBC?.id && frescas.find((x) => x.id === l.lineaBC.id))
              || (l.lineaBC?.codigo && frescas.find((x) => String(x.codigo) === String(l.lineaBC.codigo)))
              || null;
            if (!actual) return l;
            const pendienteRecepcion = (Number(actual.cantidadRecibida) || 0) + 0.001 < (Number(l.cantidadFacturada) || 0);
            return { ...l, lineaBC: { ...l.lineaBC, ...actual }, pendienteRecepcion };
          });
          return { ...p, lineasDisponiblesBC: frescas, lineas: lineasFact };
        }));
      }
      if (!alguno) throw new Error("El pedido ya está recibido.");
      setRecargaLineas((n) => n + 1);
      setRegistroRecepcion({ estado: "ok" });
    } catch (err) {
      setRegistroRecepcion({ estado: "error", error: err.message || String(err) });
    }
  };
  const botonRegistrar = pedidoIncluidoSinRecibir ? (
    <button
      type="button"
      onClick={registrarPedidoEnBc}
      disabled={registroRecepcion.estado === "registrando"}
      className="text-[11px] font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded px-2 py-1"
    >
      {registroRecepcion.estado === "registrando" ? "Registrando…" : "Registrar"}
    </button>
  ) : null;
  const ocupadoBc = entrada.estado === "entrando" || registroRecepcion.estado === "registrando" || anadirLineasBc.estado === "subiendo";
  const textoBotonBc = entrada.estado === "entrando" ? "Trayendo albaranes…" : "Crear borrador en BC";
  const pulsarBotonBc = (e) => {
    crearYRegistrar(e);
  };
  const avisoRegistroRecepcion = registroRecepcion.estado === "ok" ? (
    <div className="mt-2 text-[12px] text-emerald-800">Pedido registrado</div>
  ) : registroRecepcion.estado === "error" ? (
    <div className="mt-2 text-[12px] text-red-700">{registroRecepcion.error}</div>
  ) : null;
  const grupoPropuesta = numeroPropuesta ? pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, numeroPropuesta)) : null;
  const actualPropuesta = numeroPropuesta ? { numero: numeroPropuesta, grupo: grupoPropuesta } : null;
  const lineasBcPropuesta = !numeroPropuesta
    ? []
    : (Array.isArray(lineasBcPorPedido[numeroPropuesta])
      ? lineasBcPorPedido[numeroPropuesta]
      : (grupoPropuesta?.lineasDisponiblesBC || []));
  const propuestaTieneLineasBc = Array.isArray(lineasBcPorPedido[numeroPropuesta]) || Array.isArray(grupoPropuesta?.lineasDisponiblesBC);
  const propuestaSinRecibir = !!numeroPropuesta && (
    propuestaTieneLineasBc
      ? pedidoTienePendienteRecibir(lineasBcPropuesta)
      : true
  );
  const propuestaYaFacturada = !!numeroPropuesta && propuestaTieneLineasBc && pedidoYaFacturado(lineasBcPropuesta);
  const totalPropuesta = totalPedidoPropuesta(grupoPropuesta, lineasBcPropuesta);
  const albaranesPropuesta = !numeroPropuesta
    ? []
    : (Array.isArray(albaranesPorPedido[numeroPropuesta])
      ? albaranesPorPedido[numeroPropuesta]
      : (grupoPropuesta?.albaranes || []));
  const opcionesChooserPropuesta = useMemo(() => {
    if (!numeroPropuesta) return { modo: "pedido", filas: [] };
    // Pedido ya facturado: no ofrecer líneas ni albaranes para incluir.
    if (propuestaYaFacturada) return { modo: "pedido", filas: [] };
    if (albaranesPropuesta.length) {
      const filas = [];
      for (const alb of albaranesPropuesta) {
        for (const l of alb.lineas || []) {
          const key = `ALB|${alb.numero}|${l.id || l.codigo || l.descripcion}`;
          filas.push({
            key,
            modo: "albaran",
            albaran: alb.numero,
            fechaAlbaran: alb.fecha || "",
            id: l.id,
            lineaPedidoId: l.lineaPedidoId || null,
            codigo: l.codigo || l.codigoPedido || "",
            descripcion: l.descripcion || "",
            cantidad: Number(l.cantidad) || 0,
            cantidadMax: Number(l.cantidad) || 0,
            precio: l.precioBC ?? l.precio,
            descuentoPct: l.descuentoPct ?? l.discountPercent,
            importe: l.importeLinea ?? l.amountExcludingTax,
            preciosDesdePedido: !!l.preciosDesdePedido,
          });
        }
      }
      return { modo: "albaran", filas };
    }
    // Solo lo recibido y aún no facturado. Si el pedido ya está facturado,
    // filas queda vacío y la UI muestra el aviso (no se puede incluir).
    const filas = (lineasBcPropuesta || []).map((l) => {
      const restante = Math.max(0, (Number(l.cantidadRecibida) || 0) - (Number(l.cantidadFacturada) || 0));
      if (restante <= 0.0001) return null;
      const staged = pendienteFacturarDeLinea(l);
      const qty = staged > 0.0001 ? Math.min(staged, restante) : restante;
      return {
        key: `PO|${l.id || l.codigo || l.descripcion}`,
        modo: "pedido",
        albaran: null,
        id: l.id,
        lineaPedidoId: l.id,
        codigo: l.codigo || "",
        descripcion: l.descripcion || "",
        cantidad: qty,
        cantidadMax: qty,
        cantidadPedida: l.cantidadPedida,
        cantidadRecibida: l.cantidadRecibida,
        cantidadPendienteFacturar: qty,
        precio: l.precioBC ?? l.precio ?? l.directUnitCost,
        descuentoPct: dtoPctLineaBc(l),
        importe: importeParaCantidadDesdePedido(l, qty) ?? importeLineaPedidoBc(l),
        preciosDesdePedido: true,
        lineaPedido: l,
      };
    }).filter(Boolean);
    return { modo: "pedido", filas };
  }, [numeroPropuesta, albaranesPropuesta, lineasBcPropuesta, propuestaYaFacturada]);

  // Mismo motivo para el aviso en pantalla y el correo al proveedor.
  const motivoPropuesta = motivoBloqueoPedidoProveedor(lineasBcPropuesta, {
    tieneLineasBc: propuestaTieneLineasBc,
    hayFilasChooser: (opcionesChooserPropuesta.filas || []).length > 0,
  });
  const avisoPropuesta = textoAvisoMotivoPedido(motivoPropuesta);

  const firmaSinMatchPropuesta = useMemo(() => {
    if (!numeroPropuesta) return "";
    return candidatosAnadirAlPedido(grupoPropuesta, pedidosDetalle, numeroPropuesta)
      .map((c) => `${c.id}|${c.descripcion}|${c.cantidad}|${c.coste}`)
      .join("||");
  }, [numeroPropuesta, grupoPropuesta, pedidosDetalle]);

  useEffect(() => {
    if (!numeroPropuesta || propuestaYaFacturada) return;
    const cola = colaPedido(numeroPropuesta);
    if (!cola) return;
    const cands = candidatosAnadirAlPedido(grupoPropuesta, pedidosDetalle, numeroPropuesta);
    setNuevasLineasPorPedido((prev) => {
      const prevArr = prev[cola] || [];
      const byId = Object.fromEntries(prevArr.map((n) => [n.id, n]));
      const next = cands.map((c) => {
        const old = byId[c.id];
        if (!old) return c;
        if (old.creadaId) return { ...c, ...old, creadaId: old.creadaId };
        return {
          ...c,
          tipo: old.tipo || c.tipo,
          codigo: old.codigo ?? c.codigo,
          descripcion: old.descripcion ?? c.descripcion,
          cantidad: old.cantidad ?? c.cantidad,
          coste: old.coste ?? c.coste,
          marcada: old.marcada !== false,
          busqueda: old.busqueda || c.busqueda,
        };
      });
      // Conservar líneas manuales o ya creadas que no vienen del PDF detectado
      const extras = prevArr.filter((n) =>
        !next.some((x) => x.id === n.id) && (n.creadaId || n.origen === "manual" || String(n.id || "").startsWith("manual-"))
      );
      const merged = [...next, ...extras];
      const misma = prevArr.length === merged.length
        && merged.every((n, i) => prevArr[i]?.id === n.id && prevArr[i]?.codigo === n.codigo
          && prevArr[i]?.tipo === n.tipo && prevArr[i]?.marcada === n.marcada
          && String(prevArr[i]?.cantidad) === String(n.cantidad)
          && String(prevArr[i]?.coste) === String(n.coste)
          && prevArr[i]?.descripcion === n.descripcion
          && prevArr[i]?.creadaId === n.creadaId);
      if (misma) return prev;
      return { ...prev, [cola]: merged };
    });
  }, [numeroPropuesta, firmaSinMatchPropuesta, propuestaYaFacturada, grupoPropuesta, pedidosDetalle]);

  useEffect(() => {
    setNuevasLineasPanelAbierto(false);
  }, [numeroPropuesta]);

  const colaPropuesta = colaPedido(numeroPropuesta);
  const borradorNuevasPropuesta = (colaPropuesta && nuevasLineasPorPedido[colaPropuesta]) || [];
  const editarNuevaLineaPropuesta = (id, campo, valor) => {
    if (!colaPropuesta) return;
    setNuevasLineasPorPedido((prev) => ({
      ...prev,
      [colaPropuesta]: (prev[colaPropuesta] || []).map((n) => (n.id === id ? { ...n, [campo]: valor } : n)),
    }));
  };
  const pendientesNuevasMarcadas = () => {
    if (!numeroPropuesta) return [];
    const cola = colaPedido(numeroPropuesta);
    return (nuevasLineasPorPedido[cola] || []).filter((n) => n.marcada && !n.creadaId);
  };

  const abrirVistaPedidoLineasMarcadas = async () => {
    if (!numeroPropuesta || anadirLineasBc.estado === "subiendo" || pedidoNuevo.estado === "entrando") return;
    const pendientes = pendientesNuevasMarcadas();
    if (!pendientes.length) {
      setAnadirLineasBc({ estado: "error", error: "Marca al menos una línea para crear el pedido." });
      return;
    }
    const sinCodigo = pendientes.filter((n) => !String(n.codigo || "").trim());
    if (sinCodigo.length) {
      setAnadirLineasBc({
        estado: "error",
        error: "Falta el código de artículo (o cargo) en BC. Búscalo y elígelo antes de crear el pedido.",
      });
      return;
    }
    setAnadirLineasBc({ estado: "idle" });
    const proveedorPedido = cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor;
    const lineasVista = pendientes.map((n) => ({
      id: n.id,
      tipo: n.tipo === "Charge" ? "Charge" : "Item",
      codigo: String(n.codigo).trim(),
      descripcion: n.descripcion || "",
      cantidad: Number(n.cantidad) || 0,
      coste: n.coste === "" || n.coste == null ? null : Number(n.coste),
    }));
    setVistaPedido({
      modo: "lineasMarcadas",
      ot: otFerros || ultima?.ot || "",
      cargando: !ultima?.puedeCrear,
      error: null,
      propuesta: ultima?.puedeCrear
        ? { ...ultima, lineasMarcadas: lineasVista }
        : { puedeCrear: true, proveedorBC: proveedorPedido, lineasMarcadas: lineasVista },
    });
    if (ultima?.puedeCrear) return;
    if (!proveedorPedido) {
      setVistaPedido((prev) => ({
        ...(prev || { ot: "", modo: "lineasMarcadas" }),
        cargando: false,
        error: null,
        propuesta: { puedeCrear: true, proveedorBC: "", lineasMarcadas: lineasVista },
      }));
      return;
    }
    try {
      const r = await fetch("/api/facturas-compra/ultima-entrada", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proveedor: proveedorPedido, ot: otFerros || null, factura: cabecera.factura }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ultimaEntrada?.puedeCrear) {
        setVistaPedido({
          modo: "lineasMarcadas",
          ot: j.ultimaEntrada.ot || otFerros || "",
          cargando: false,
          error: null,
          propuesta: { ...j.ultimaEntrada, lineasMarcadas: lineasVista },
        });
      } else {
        setVistaPedido({
          modo: "lineasMarcadas",
          ot: otFerros || "",
          cargando: false,
          error: null,
          propuesta: { puedeCrear: true, proveedorBC: proveedorPedido, lineasMarcadas: lineasVista },
        });
      }
    } catch {
      setVistaPedido({
        modo: "lineasMarcadas",
        ot: otFerros || "",
        cargando: false,
        error: null,
        propuesta: { puedeCrear: true, proveedorBC: proveedorPedido, lineasMarcadas: lineasVista },
      });
    }
  };

  const crearPedidoDesdeLineasMarcadas = async (otElegida) => {
    const pendientes = pendientesNuevasMarcadas();
    if (!pendientes.length) {
      setAnadirLineasBc({ estado: "error", error: "Marca al menos una línea para crear el pedido." });
      return;
    }
    const proveedorPedido = cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor
      || vistaPedido?.propuesta?.proveedorBC;
    if (!proveedorPedido) {
      setAnadirLineasBc({ estado: "error", error: "Falta el proveedor para crear el pedido." });
      return;
    }
    const otFinal = String(otElegida ?? vistaPedido?.ot ?? "").trim();
    setVistaPedido(null);
    setAnadirLineasBc({ estado: "subiendo" });
    setPedidoNuevo((prev) => ({ ...prev, estado: "entrando", error: undefined }));
    const cola = colaPedido(numeroPropuesta);
    try {
      const r = await fetch("/api/facturas-compra/crear-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor: proveedorPedido,
          fecha: cabecera.fecha || null,
          factura: cabecera.factura,
          msg: f.origen?.msg || null,
          att: f.origen?.att || null,
          ...(otFinal ? { ot: otFinal } : {}),
          ...(numeroPropuesta ? { pedidoOrigen: numeroPropuesta } : {}),
          lineasBC: pendientes.map((n) => ({
            tipo: n.tipo === "Charge" ? "Charge" : "Item",
            codigo: String(n.codigo).trim(),
            descripcion: n.descripcion || "",
            cantidad: Number(n.cantidad) || 0,
            coste: n.coste === "" || n.coste == null ? null : Number(n.coste),
          })),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setPedidoNuevo({ estado: "ok", ...json });
      if (!json.registro?.ok) {
        throw new Error(json.registro?.error || "El pedido se creó pero no se registró la recepción.");
      }
      const creadasIds = {};
      for (const n of pendientes) creadasIds[n.id] = json.numero || "ok";
      setNuevasLineasPorPedido((prev) => ({
        ...prev,
        [cola]: (prev[cola] || []).map((n) => (creadasIds[n.id] ? { ...n, creadaId: creadasIds[n.id], marcada: false } : n)),
      }));

      const rRef = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido: json.numero }),
      });
      const jRef = await rRef.json().catch(() => ({}));
      if (!rRef.ok) throw new Error(jRef.error || "No se ha podido refrescar el pedido nuevo.");
      const frescas = jRef.lineasDisponiblesBC || [];
      const albs = Array.isArray(jRef.albaranes) ? jRef.albaranes : [];
      setLineasBcPorPedido((prev) => ({ ...prev, [json.numero]: frescas }));
      setAlbaranesPorPedido((prev) => ({ ...prev, [json.numero]: albs }));
      setPedidosDetalle((prev) => {
        const ya = prev.some((p) => mismoPedidoFactura(p.pedido, json.numero));
        if (ya) {
          return prev.map((p) => (mismoPedidoFactura(p.pedido, json.numero)
            ? {
              ...p,
              lineasDisponiblesBC: frescas,
              albaranes: albs,
              importe: jRef.importe != null ? jRef.importe : p.importe,
              vendorName: jRef.vendorName ?? p.vendorName,
              bcError: jRef.bcError || null,
              enlaceBC: jRef.enlaceBC ?? p.enlaceBC ?? json.enlace,
            }
            : p));
        }
        return [
          ...prev,
          {
            pedido: json.numero,
            lineas: [],
            lineasDisponiblesBC: frescas,
            albaranes: albs,
            importe: jRef.importe != null ? jRef.importe : json.importe,
            vendorName: jRef.vendorName ?? json.vendorName,
            bcError: jRef.bcError || null,
            enlaceBC: jRef.enlaceBC ?? json.enlace,
          },
        ];
      });
      setRecargaLineas((n) => n + 1);
      setAnadirLineasBc({ estado: "ok", pedido: json.numero });
    } catch (err) {
      const error = err.message || String(err);
      setAnadirLineasBc({ estado: "error", error });
      setPedidoNuevo((prev) => (prev.numero
        ? { ...prev, estado: "ok", registro: { ok: false, error } }
        : { estado: "error", error }));
    }
  };

  // Mantener el borrador de checks alineado con el pedido de la propuesta.
  // Si ya se pulsó «Incluir», se restaura esa selección.
  // Si no: con varios albaranes no se marca nada (hay que elegir); con uno solo, sí.
  useEffect(() => {
    if (!numeroPropuesta) {
      setBorradorChooser(null);
      return;
    }
    const cola = colaPedido(numeroPropuesta);
    const prev = lineasElegidasRef.current[cola] || lineasElegidasRef.current[numeroPropuesta];
    const filas = opcionesChooserPropuesta.filas || [];
    const keys = {};
    const qtys = {};
    if (prev?.items?.length) {
      for (const it of prev.items) {
        const k = claveLineaChooser(it);
        keys[k] = true;
        qtys[k] = Number(it.cantidad) || 0;
      }
      for (const fila of filas) {
        if (qtys[fila.key] == null) qtys[fila.key] = fila.cantidad;
      }
    } else {
      const albaranesDistintos = new Set(filas.map((f) => f.albaran).filter(Boolean));
      const marcarTodas = albaranesDistintos.size <= 1;
      for (const fila of filas) {
        if (marcarTodas) keys[fila.key] = true;
        qtys[fila.key] = fila.cantidad;
      }
    }
    setBorradorChooser({ keys, qtys });
  }, [numeroPropuesta, opcionesChooserPropuesta]);

  // Si el pedido ya está en el conjunto y se cambian los checks, actualizar
  // lo guardado: «Crear borrador» debe llevar solo lo marcado ahora.
  useEffect(() => {
    if (!numeroPropuesta || !borradorChooser) return;
    const clave = colaPedido(numeroPropuesta);
    if (!clave || !incluidosPedido[clave]) return;
    const items = [];
    for (const fila of opcionesChooserPropuesta.filas || []) {
      if (!borradorChooser.keys?.[fila.key]) continue;
      const qtyRaw = borradorChooser.qtys?.[fila.key];
      const qty = Math.min(
        Number(fila.cantidadMax) || 0,
        Math.max(0, qtyRaw != null && qtyRaw !== "" ? Number(qtyRaw) : Number(fila.cantidad) || 0)
      );
      if (qty <= 0.0001) continue;
      items.push({
        key: fila.key,
        modo: fila.modo,
        albaran: fila.albaran || null,
        id: fila.id,
        lineaPedidoId: fila.lineaPedidoId,
        codigo: fila.codigo,
        descripcion: fila.descripcion,
        cantidad: qty,
        precio: fila.precio,
        descuentoPct: fila.descuentoPct,
        importe: fila.importe,
      });
    }
    setLineasElegidasPorPedido((prev) => {
      const actual = prev[clave];
      const misma = actual?.items?.length === items.length
        && items.every((it, i) => actual.items[i]?.key === it.key && Number(actual.items[i]?.cantidad) === Number(it.cantidad));
      if (misma) return prev;
      if (!items.length) {
        const next = { ...prev };
        delete next[clave];
        return next;
      }
      const modo = items.some((it) => it.albaran) ? "albaran" : "pedido";
      return { ...prev, [clave]: { modo, items } };
    });
    if (!items.length) {
      setIncluidosPedido((prev) => {
        if (!prev[clave]) return prev;
        const next = { ...prev };
        delete next[clave];
        return next;
      });
    }
  }, [borradorChooser, numeroPropuesta, incluidosPedido, opcionesChooserPropuesta]);

  const itemsDesdeBorrador = () => {
    if (!borradorChooser) return [];
    const opts = opcionesChooserPropuesta.filas || [];
    const items = [];
    for (const fila of opts) {
      if (!borradorChooser.keys?.[fila.key]) continue;
      const qtyRaw = borradorChooser.qtys?.[fila.key];
      const qty = Math.min(
        Number(fila.cantidadMax) || 0,
        Math.max(0, qtyRaw != null && qtyRaw !== "" ? Number(qtyRaw) : Number(fila.cantidad) || 0)
      );
      if (qty <= 0.0001) continue;
      const importe = fila.modo === "pedido" && fila.lineaPedido
        ? (importeParaCantidadDesdePedido(fila.lineaPedido, qty) ?? fila.importe)
        : (fila.importe != null && Math.abs(qty - Number(fila.cantidad)) < 0.0001
          ? fila.importe
          : (fila.precio != null
            ? Math.round(qty * Number(fila.precio) * (1 - (Number(fila.descuentoPct) || 0) / 100) * 100) / 100
            : fila.importe));
      items.push({
        key: fila.key,
        modo: fila.modo,
        albaran: fila.albaran || null,
        id: fila.id,
        lineaPedidoId: fila.lineaPedidoId,
        codigo: fila.codigo,
        descripcion: fila.descripcion,
        cantidad: qty,
        precio: fila.precio,
        descuentoPct: fila.descuentoPct,
        importe,
      });
    }
    return items;
  };

  const marcarTodasLineas = () => {
    setBorradorChooser((prev) => {
      const keys = {};
      const qtys = { ...(prev?.qtys || {}) };
      for (const fila of opcionesChooserPropuesta.filas || []) {
        keys[fila.key] = true;
        if (qtys[fila.key] == null) qtys[fila.key] = fila.cantidad;
      }
      return { keys, qtys };
    });
  };

  const desmarcarTodasLineas = () => {
    setBorradorChooser((prev) => ({ keys: {}, qtys: { ...(prev?.qtys || {}) } }));
  };

  const incluirPropuestaEnFactura = () => {
    if (propuestaYaFacturada) return;
    const claveInc = colaPedido(actualPropuesta?.numero);
    if (!claveInc) return;
    const items = itemsDesdeBorrador();
    if (!items.length) return;
    const modo = items.some((it) => it.albaran) ? "albaran" : "pedido";
    setLineasElegidasPorPedido((prev) => ({ ...prev, [claveInc]: { modo, items } }));
    setIncluidosPedido((prev) => ({ ...prev, [claveInc]: true }));
    setPasoPedido((p) => Math.min(listaVisible.length - 1, p + 1));
  };

  // Si BC confirma que el pedido de la propuesta ya está facturado, no puede
  // quedar en el conjunto ni con líneas elegidas.
  useEffect(() => {
    if (!propuestaYaFacturada || !numeroPropuesta) return;
    const clave = colaPedido(numeroPropuesta);
    if (!clave) return;
    setIncluidosPedido((prev) => {
      if (!prev[clave] && !prev[numeroPropuesta]) return prev;
      const next = { ...prev };
      delete next[clave];
      delete next[numeroPropuesta];
      return next;
    });
    setLineasElegidasPorPedido((prev) => {
      if (!prev[clave] && !prev[numeroPropuesta]) return prev;
      const next = { ...prev };
      delete next[clave];
      delete next[numeroPropuesta];
      return next;
    });
    setBorradorChooser(null);
  }, [propuestaYaFacturada, numeroPropuesta]);

  const importeConjunto = listaVisible.reduce((sum, num) => {
    if (!incluidosPedido[colaPedido(num)]) return sum;
    const sel = lineasElegidasPorPedido[colaPedido(num)] || lineasElegidasPorPedido[num];
    if (sel?.items?.length) return sum + sumaImportesElegidos(sel);
    const g = pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num));
    return sum + (g?.lineas || []).reduce((s, l) => s + (Number(l.cantidadFacturada) || 0) * (Number(l.precioFacturado) || 0), 0);
  }, 0);
  const pedidosPendRecibir = useMemo(() => {
    const vistos = new Set();
    const lista = [];
    for (const p of pedidosDetalle) {
      const lineasPend = (p.lineas || []).filter((l) => l.pendienteRecepcion);
      if (!p.pedido || !lineasPend.length || vistos.has(p.pedido)) continue;
      vistos.add(p.pedido);
      lista.push({ pedido: p.pedido, vendorName: p.vendorName, enlaceBC: p.enlaceBC, lineasPend });
    }
    return lista;
  }, [pedidosDetalle]);
  const clavePendRecibir = pedidosPendRecibir.map((p) => p.pedido).join("|");

  const trabajoRef = useRef(null);
  trabajoRef.current = f.yaEntrada || !f.origen?.msg ? null : {
    msg: f.origen.msg,
    att: f.origen.att ?? "",
    facturaOriginal: f.factura || "",
    factura: cabecera.factura || f.factura || "",
    proveedor: cabecera.proveedor || f.proveedor || "",
    fecha: cabecera.fecha || "",
    baseImponible: cabecera.baseImponible,
    importeTotal: cabecera.importeTotal,
    veredicto: ok ? "ok" : (f.veredicto || "revisar"),
    motivos,
    pedidosDetalle,
    lineasSinPedido: [],
    incidencia: textoIncidencia({ pedidosDetalle, veredicto: ok ? "ok" : f.veredicto }, motivos),
  };

  const enviarTrabajo = (cuerpo) => {
    if (!cuerpo?.msg) return;
    onIncidencia?.(cuerpo);
    fetch("/api/facturas-compra/incidencia", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      keepalive: true,
    }).catch(() => {});
  };

  useEffect(() => {
    if (!trabajoRef.current) return;
    const t = setTimeout(() => enviarTrabajo(trabajoRef.current), 400);
    return () => clearTimeout(t);
  }, [f.yaEntrada, f.origen?.msg, f.origen?.att, cabecera.factura, cabecera.proveedor, cabecera.fecha, cabecera.baseImponible, cabecera.importeTotal, ok, motivos.join("|"), pedidosDetalle]);

  useEffect(() => () => {
    if (trabajoRef.current) enviarTrabajo(trabajoRef.current);
  }, []);

  useEffect(() => {
    if (!abierta || !clavePendRecibir) return;
    let vivo = true;
    fetch("/api/recepcion")
      .then((r) => r.json())
      .then((d) => { if (vivo) setRecepPedido(d); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [abierta, clavePendRecibir]);

  const recargarRecepcion = async () => {
    const d = await fetch("/api/recepcion").then((r) => r.json()).catch(() => null);
    if (d) setRecepPedido(d);
  };

  const buscarCorreosPedido = async (e) => {
    e?.stopPropagation?.();
    const nums = pedidosPendRecibir.map((p) => p.pedido);
    if (!nums.length) return;
    setBuscandoCorreos(true);
    try {
      await fetch("/api/recepcion/correos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedidos: nums, dias: 60 }),
      });
      await recargarRecepcion();
    } catch { /* la lista sigue con lo ya guardado */ }
    setBuscandoCorreos(false);
  };

  const sinNumero = !f.factura;
  const marcaCampo = (bien) => bien ? "text-emerald-700" : "text-red-700";
  // Registrada (FC*) o borrador (PFC*): no se vuelve a entrar. Aviso antes
  // de cualquier formulario / botón de incluir.
  const bloqueadaPorDuplicado = estaEntrada(f) || estaBorradorBC(f);
  return (
    <div className={modoDiario ? "bg-white" : `border rounded-lg overflow-hidden ${bloqueadaPorDuplicado ? (estaEntrada(f) ? "border-amber-400" : "border-sky-400") : esGasto ? "border-blue-300" : ok ? "border-emerald-300" : "border-red-300"}`}>
      {!modoDiario && <div
        className={`flex items-center justify-between px-3 py-2 cursor-pointer ${bloqueadaPorDuplicado ? (estaEntrada(f) ? "bg-amber-50" : "bg-sky-50") : esGasto ? "bg-blue-50" : ok ? "bg-emerald-50" : "bg-red-50"}`}
        onClick={() => {
          if (modoDiario) return;
          if (onMinimizar && abierta) onMinimizar();
          else setAbierta((v) => !v);
        }}
      >
        <div className="flex items-center gap-2">
          {esGasto ? (
            <Wallet size={18} className="text-blue-600" />
          ) : ok ? (
            <CheckCircle2 size={18} className="text-emerald-600" />
          ) : (
            <AlertTriangle size={18} className="text-red-600" />
          )}
          <div>
            {modoDiario ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px]">
                <div><span className="text-slate-500">Nº factura </span><span className="font-medium text-slate-800">{cabecera.factura || "—"}</span></div>
                <div><span className="text-slate-500">Fecha </span><span className="text-slate-800">{fmtFechaFactura(cabecera.fecha)}</span></div>
                <div className="col-span-2 truncate"><span className="text-slate-500">Proveedor </span><span className="text-slate-800">{cabecera.proveedor || f.proveedor || "—"}</span></div>
                <div><span className="text-slate-500">Base </span>{moneyFactura(cabecera.baseImponible)}</div>
                <div><span className="text-slate-500">Total </span><span className="font-semibold">{moneyFactura(cabecera.importeTotal)}</span></div>
                <div className="col-span-2">
                  <span className="text-slate-500">Pedidos </span>
                  {pedidosDetalle.length ? pedidosDetalle.map((p, i) => (
                    <span key={i} className={`mr-2 font-semibold ${marcaCampo(pedidoCuadra(p))}`}>{p.pedido || "Sin pedido"}</span>
                  )) : <span className="text-slate-400">—</span>}
                </div>
              </div>
            ) : (
              <>
            <div className="font-semibold text-slate-800 text-sm">
              {cabecera.factura ? `Factura ${cabecera.factura}` : "Documento sin nº de factura"}
              {cabecera.fecha && <span className="text-slate-400 font-normal"> · {cabecera.fecha}</span>}
            </div>
            <div className="text-xs text-slate-500">
              {f.yaEntrada ? "ya está registrada en BC — no se sigue" : (f.yaBorrador || f.veredicto === "ya_borrador") ? "ya tiene borrador en BC — no se crea otro" : pedidosPendRecibir.length > 0 ? "no está entrada — el pedido sigue pendiente de recibir" : esGasto ? "sin pedido — proveedor de gasto" : esFerrosGrupo ? "sin pedido — Ferros · cuenta 60700004 · trabajos grupo" : ultima ? "sin pedido — proponer pedido como la última factura" : `${pedidosDetalle.length} pedido(s) en la factura`}
              {" "}· páginas {f.paginas.join(", ")}
              {cabecera.importeTotal !== null && cabecera.importeTotal !== undefined && ` · total ${fmtEur(cabecera.importeTotal)}`}
            </div>
            {!esGasto && pedidosDetalle.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
                {pedidosDetalle.map((p, i) => {
                  const bien = pedidoCuadra(p);
                  return (
                    <span key={i} className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded px-1.5 py-0.5 ${bien ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
                      {p.pedido || "Sin pedido"}
                      {p.enlaceBC && (
                        <a href={p.enlaceBC} target="_blank" rel="noopener noreferrer" className="underline font-normal" onClick={(e) => e.stopPropagation()}>Abrir</a>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {abierta && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (onMinimizar) onMinimizar();
                else setAbierta(false);
              }}
              className="text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded px-2.5 py-1"
            >
              Minimizar
            </button>
          )}
          {ultima?.puedeCrear && !bloqueadaPorDuplicado && pedidosPendRecibir.length === 0 && !esGasto ? (
            <button
              type="button"
              onClick={abrirVistaPedido}
              disabled={pedidoNuevo.estado === "entrando" || (pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok) || !(cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor)}
              className="text-xs font-semibold px-2 py-1 rounded-full bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-60"
            >
              {pedidoNuevo.estado === "entrando"
                ? (pedidoNuevo.numero ? "Registrando…" : "Creando…")
                : pedidoNuevo.numero && !pedidoNuevo.registro?.ok
                  ? "Registrar pedido"
                  : pedidoNuevo.registro?.ok
                    ? "Pedido registrado"
                    : esFerrosGrupo
                      ? "Crear pedido Ferros"
                      : "Crear pedido como la última"}
            </button>
          ) : (
            <span
              className={`text-xs font-semibold px-2 py-1 rounded-full ${
                f.yaEntrada ? "bg-amber-500 text-white" : (f.yaBorrador || f.veredicto === "ya_borrador") ? "bg-sky-600 text-white" : pedidosPendRecibir.length > 0 ? "bg-orange-600 text-white" : esGasto ? "bg-blue-600 text-white" : ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
              }`}
            >
              {f.yaEntrada ? "Ya registrada en BC" : (f.yaBorrador || f.veredicto === "ya_borrador") ? "Borrador en BC" : pedidosPendRecibir.length > 0 ? "Pendiente de recibir" : esGasto ? "Proveedor de gasto" : ok ? "OK · lista para BC" : "No cuadra — revisar"}
            </span>
          )}
          {abierta ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
        </div>
      </div>}

      {abierta && bloqueadaPorDuplicado && (
        <div className={`px-4 py-3 border-t text-sm ${estaEntrada(f) ? "bg-amber-50 border-amber-300 text-amber-950" : "bg-sky-50 border-sky-300 text-sky-950"}`}>
          <div className="font-semibold text-[15px]">
            {estaEntrada(f)
              ? "Esta factura YA ESTÁ ENTRADA — no se puede volver a entrar"
              : "Esta factura YA TIENE BORRADOR EN BC — no se puede volver a entrar"}
          </div>
          <div className="mt-1.5 text-[13px]">
            {f.entradaInfo?.numeroBC ? <>Documento BC: <span className="font-semibold">{f.entradaInfo.numeroBC}</span>. </> : null}
            {f.entradaInfo?.proveedor || cabecera.proveedor || f.proveedor
              ? <>Proveedor: <span className="font-semibold">{f.entradaInfo?.proveedor || cabecera.proveedor || f.proveedor}</span>. </>
              : null}
            Nº factura proveedor: <span className="font-semibold">{cabecera.factura || f.factura || "—"}</span>.
          </div>
          <div className="mt-1 text-[12px]">
            {estaEntrada(f)
              ? "Sale de Pendientes. No se analizan pedidos ni se crea otro documento."
              : "No se crea otro borrador. Cuando esté registrada en el histórico, saldrá de Pendientes."}
          </div>
        </div>
      )}

      {modoDiario && abierta && !bloqueadaPorDuplicado && (
        <div className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <label className="text-[11px] text-slate-500 block">
              Proveedor
              <input
                list={listaProveedorId}
                value={cabecera.proveedor}
                onChange={(e) => indicarProveedor(e.target.value)}
                onFocus={() => setProveedorFoco(true)}
                onBlur={() => setTimeout(() => setProveedorFoco(false), 180)}
                placeholder="Escribe o elige el proveedor"
                className="mt-0.5 w-full bg-white border border-slate-300 rounded px-1.5 py-1 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
              />
              <datalist id={listaProveedorId}>
                {proveedoresLista.map((nombre) => <option key={nombre} value={nombre} />)}
              </datalist>
            </label>
            {proveedorFoco && sugerenciasProveedor.length > 0 && (
              <div className="col-span-2 -mt-1 border border-slate-200 rounded bg-white shadow-sm max-h-40 overflow-auto">
                {sugerenciasProveedor.map((nombre) => (
                  <button
                    key={nombre}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      indicarProveedor(nombre);
                      setProveedorFoco(false);
                    }}
                    className="block w-full text-left text-[12px] text-slate-800 px-2 py-1 hover:bg-sky-50"
                  >
                    {nombre}
                  </button>
                ))}
              </div>
            )}
            {!proveedorExacto && String(cabecera.proveedor || "").trim() && !sugerenciasProveedor.length && (
              <div className="col-span-2 text-[11px] text-amber-800">Este nombre no está en Business Central. Escribe el proveedor, por ejemplo Pronto Servis, y elígelo de la lista.</div>
            )}
            <label className="text-[11px] text-slate-500 block">
              Nº factura
              <input
                value={cabecera.factura}
                onChange={(e) => editarCabecera("factura", e.target.value)}
                className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
              />
            </label>
            <label className="text-[11px] text-slate-500 block">
              Fecha
              <input
                type="date"
                value={cabecera.fecha || ""}
                onChange={(e) => editarCabecera("fecha", e.target.value)}
                className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
              />
            </label>
            <label className="text-[11px] text-slate-500 block">
              Base
              <input
                type="number"
                step="0.01"
                value={cabecera.baseImponible ?? ""}
                onChange={(e) => editarCabecera("baseImponible", e.target.value === "" ? null : Number(e.target.value))}
                className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 text-right focus:outline-none focus:border-sky-600"
              />
            </label>
            <div className="text-[11px] text-slate-500">
              IVA
              <div className="mt-0.5 text-[13px] text-slate-800 text-right border-b border-slate-300 pb-0.5">
                {cabecera.importeTotal != null && cabecera.baseImponible != null
                  ? fmtEur(Number(cabecera.importeTotal) - Number(cabecera.baseImponible))
                  : "—"}
              </div>
            </div>
            <label className="text-[11px] text-slate-500 block">
              Total
              <input
                type="number"
                step="0.01"
                value={cabecera.importeTotal ?? ""}
                onChange={(e) => editarCabecera("importeTotal", e.target.value === "" ? null : Number(e.target.value))}
                className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 text-right focus:outline-none focus:border-sky-600"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {sinPedidoUtil && (
              <button
                type="button"
                onClick={abrirVistaPedido}
                disabled={pedidoNuevo.estado === "entrando" || !(cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor)}
                className="text-[11px] font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded px-2 py-1"
              >
                {pedidoNuevo.estado === "entrando" ? "Creando…" : pedidoNuevo.numero ? `Pedido ${pedidoNuevo.numero}` : "Crear pedido"}
              </button>
            )}
            <button type="button" onClick={() => setVerDetalle((v) => !v)} className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded px-2 py-1">
              {verDetalle ? "Ocultar líneas" : "Líneas"}
            </button>
            <button type="button" onClick={(e) => abrirCorreoProveedor(e, motivoPropuesta)} className="text-[11px] font-semibold text-white bg-slate-700 hover:bg-slate-800 rounded px-2 py-1">
              Correo al proveedor
            </button>
            <button
              type="button"
              onClick={descargarDocumento}
              disabled={!!docAccion}
              className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded px-2 py-1"
            >
              {docAccion === "descarga" ? "Descargando…" : "Descargar documento"}
            </button>
            {onDescartar && (
              <button
                type="button"
                onClick={descartarDocumento}
                disabled={!!docAccion}
                className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded px-2 py-1"
                title="Sale de Pendientes; la lectura y el PDF se quedan guardados (Ver descartadas)"
              >
                {docAccion === "descartar" ? "Descartando…" : "Descartar documento"}
              </button>
            )}
          </div>
          {esAlbaranDoc && <div className="mt-1 text-[12px] font-semibold text-amber-800">Este documento es un albarán</div>}
          {docAccionError && <div className="mt-1 text-[12px] text-red-700">{docAccionError}</div>}
          {pedidoNuevo.estado === "error" && <div className="mt-1 text-[12px] text-red-700">{pedidoNuevo.error || "No se ha podido crear el pedido."}</div>}
          <LineaPedidoCreado pedido={pedidoNuevo} className={`mt-1 text-[12px] ${pedidoNuevo.registro?.ok ? "text-emerald-800" : "text-amber-900"}`} />
          {pedidosLeidos === null ? (
            <div className="mt-3 text-[12px] text-slate-500">Leyendo los pedidos de la factura…</div>
          ) : hayPedidosEnElPdf ? (
            <div className="mt-3 border-t border-slate-200 pt-2" onClick={(e) => e.stopPropagation()}>
              <div className="text-[13px] font-semibold text-slate-800">Pedidos de la factura, en su orden</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {listaVisible.map((num, i) => {
                  const lineasChip = Array.isArray(lineasBcPorPedido[num])
                    ? lineasBcPorPedido[num]
                    : (pedidosDetalle.find((p) => mismoPedidoFactura(p.pedido, num))?.lineasDisponiblesBC || null);
                  const chipYaFacturado = Array.isArray(lineasChip) && pedidoYaFacturado(lineasChip);
                  return (
                  <button
                    key={listaPedidosFactura[i] || num}
                    type="button"
                    onClick={() => setPasoPedido(i)}
                    title={chipYaFacturado ? "ESTE PEDIDO ya se encuentra facturado" : undefined}
                    className={`text-[11px] rounded px-2 py-0.5 border ${i === pasoSeguro ? (chipYaFacturado ? "bg-amber-800 text-white border-amber-800" : "bg-sky-700 text-white border-sky-700") : chipYaFacturado ? "bg-amber-50 text-amber-900 border-amber-400" : incluidosPedido[colaPedido(num)] ? "bg-emerald-50 text-emerald-800 border-emerald-300" : "bg-white text-slate-700 border-slate-300"}`}
                  >
                    {i + 1}. {num}{chipYaFacturado ? " · facturado" : incluidosPedido[colaPedido(num)] ? " ✓" : ""}
                  </button>
                  );
                })}
              </div>
              {actualPropuesta && (
                <div className="mt-2 border border-slate-200 rounded p-2">
                  <div className="text-[12px] text-slate-500">Propuesta {pasoSeguro + 1} de {listaVisible.length}</div>
                  <div className="mt-1 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
                    <label className="block text-[11px] text-slate-500 min-w-0">
                      Nº de pedido
                      <input
                        value={textoPedido}
                        onChange={(e) => setTextoPedido(e.target.value)}
                        onBlur={() => corregirPedido(textoPedido)}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        className="mt-0.5 w-full bg-white border border-slate-300 rounded px-1.5 py-1 text-[14px] font-semibold text-slate-800 focus:outline-none focus:border-sky-600"
                      />
                    </label>
                    <div className="text-[11px] text-slate-500 sm:text-right">
                      Total pedido
                      <div className="mt-0.5 bg-white border border-slate-300 rounded px-1.5 py-1 text-[14px] font-semibold text-slate-800 whitespace-nowrap">
                        {totalPropuesta != null ? fmtEur(totalPropuesta) : "—"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">Si no es este, cámbialo y se vuelve a leer en Business Central. Total = pedido BC (tras descuentos).</div>
                  {leyendoPedidoCorr && <div className="mt-1 text-[12px] text-slate-500">Leyendo el pedido…</div>}
                  {actualPropuesta.grupo?.bcError && <div className="text-[12px] text-amber-800">{actualPropuesta.grupo.bcError}</div>}
                  {avisoPropuesta && (
                    <div className={`mt-2 rounded px-2 py-1.5 border ${motivoPropuesta === "ya_facturado" ? "text-[13px] font-bold text-amber-950 bg-amber-100 border-amber-400" : "text-[12px] font-semibold text-amber-900 bg-amber-50 border-amber-300"}`}>
                      {avisoPropuesta}
                    </div>
                  )}
                  <div className="mt-1">
                    {motivoPropuesta === "ya_facturado" ? (
                      <div className="text-[12px] text-amber-900 py-1">No se puede incluir en esta factura: en Business Central ya está facturado.</div>
                    ) : motivoPropuesta === "sin_recibir" ? null : (opcionesChooserPropuesta.filas?.length > 0 && borradorChooser) ? (
                      <div>
                        <div className="text-[11px] text-slate-500 mb-0.5">
                          {opcionesChooserPropuesta.modo === "albaran"
                            ? "Líneas por albarán (marca las de esta factura · qty albarán · precios del pedido)"
                            : "Líneas del pedido (marca las de esta factura)"}
                        </div>
                        <div className="mt-0.5 mb-1 text-[11px] text-slate-500">
                          Si el pedido llega en varios albaranes, elige solo las líneas/cantidades de los albaranes de esta factura (no todo el PC).
                          Cantidad del albarán + precio y % dto del pedido.
                        </div>
                        <div className="max-h-72 overflow-y-auto">
                          {opcionesChooserPropuesta.modo === "albaran" ? (
                            [...new Set(opcionesChooserPropuesta.filas.map((f) => f.albaran))].map((albNum) => {
                              const filasAlb = opcionesChooserPropuesta.filas.filter((f) => f.albaran === albNum);
                              const fecha = filasAlb[0]?.fechaAlbaran || "";
                              return (
                                <div key={albNum} className="mb-2 last:mb-0">
                                  <div className="text-[11px] font-semibold text-sky-900 bg-sky-50 rounded px-1.5 py-0.5 mb-0.5">
                                    {albNum}{fecha ? ` · ${fecha}` : ""}
                                  </div>
                                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] gap-x-2 text-[10px] text-slate-500 border-b border-slate-100 pb-0.5">
                                    <span></span>
                                    <span>Descripción</span>
                                    <span className="text-right">Cant.</span>
                                    <span className="text-right">P. unit.</span>
                                    <span className="text-right">% Dto.</span>
                                    <span className="text-right">Importe</span>
                                  </div>
                                  {filasAlb.map((fila) => (
                                    <label key={fila.key} className="py-1 grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] gap-x-2 items-center text-[12px] cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={!!borradorChooser.keys?.[fila.key]}
                                        onChange={(e) => {
                                          const on = e.target.checked;
                                          setBorradorChooser((prev) => ({
                                            ...prev,
                                            keys: { ...prev.keys, [fila.key]: on },
                                            qtys: { ...prev.qtys, [fila.key]: prev.qtys?.[fila.key] ?? fila.cantidad },
                                          }));
                                        }}
                                      />
                                      <span className="min-w-0 text-slate-800 truncate" title={fila.descripcion}>{fila.descripcion || fila.codigo || "—"}</span>
                                      <span className="text-right tabular-nums text-slate-700">{fila.cantidad}</span>
                                      <span className="text-right tabular-nums text-slate-700 whitespace-nowrap">{fila.precio != null ? Number(fila.precio).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : "—"}</span>
                                      <span className="text-right tabular-nums text-slate-700 whitespace-nowrap">{fmtDtoPct(fila.descuentoPct)}</span>
                                      <span className="text-right tabular-nums font-medium text-slate-800 whitespace-nowrap">{fila.importe != null ? fmtEur(fila.importe) : "—"}</span>
                                    </label>
                                  ))}
                                </div>
                              );
                            })
                          ) : (
                            <>
                              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto_auto] gap-x-2 text-[10px] text-slate-500 border-b border-slate-100 pb-0.5">
                                <span></span>
                                <span>Descripción</span>
                                <span className="text-right">Pedida</span>
                                <span className="text-right">A facturar</span>
                                <span className="text-right">P. unit.</span>
                                <span className="text-right">% Dto.</span>
                                <span className="text-right">Importe</span>
                              </div>
                              {opcionesChooserPropuesta.filas.map((fila) => {
                                const marcada = !!borradorChooser.keys?.[fila.key];
                                const qty = borradorChooser.qtys?.[fila.key] ?? fila.cantidad;
                                const imp = fila.lineaPedido
                                  ? importeParaCantidadDesdePedido(fila.lineaPedido, qty)
                                  : fila.importe;
                                return (
                                  <div key={fila.key} className="py-1 grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto_auto] gap-x-2 items-center text-[12px]">
                                    <input
                                      type="checkbox"
                                      checked={marcada}
                                      onChange={(e) => {
                                        const on = e.target.checked;
                                        setBorradorChooser((prev) => ({
                                          ...prev,
                                          keys: { ...prev.keys, [fila.key]: on },
                                          qtys: { ...prev.qtys, [fila.key]: prev.qtys?.[fila.key] ?? fila.cantidad },
                                        }));
                                      }}
                                    />
                                    <span className="min-w-0 text-slate-800 truncate" title={fila.descripcion}>{fila.descripcion || fila.codigo || "—"}</span>
                                    <span className="text-right tabular-nums text-slate-500">{fila.cantidadPedida ?? "—"}</span>
                                    <input
                                      type="number"
                                      step="any"
                                      min={0}
                                      max={fila.cantidadMax}
                                      disabled={!marcada}
                                      value={marcada ? qty : ""}
                                      onChange={(e) => {
                                        const v = e.target.value === "" ? "" : Number(e.target.value);
                                        setBorradorChooser((prev) => ({
                                          ...prev,
                                          qtys: { ...prev.qtys, [fila.key]: v },
                                        }));
                                      }}
                                      className="w-16 text-right border border-slate-300 rounded px-1 py-0.5 text-[12px] disabled:opacity-40"
                                    />
                                    <span className="text-right tabular-nums text-slate-700 whitespace-nowrap">{fila.precio != null ? Number(fila.precio).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : "—"}</span>
                                    <span className="text-right tabular-nums text-slate-700 whitespace-nowrap">{fmtDtoPct(fila.descuentoPct)}</span>
                                    <span className="text-right tabular-nums font-medium text-slate-800 whitespace-nowrap">{imp != null ? fmtEur(imp) : "—"}</span>
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </div>
                      </div>
                    ) : (actualPropuesta.grupo?.lineas || []).length > 0 ? (
                      <div className="divide-y divide-slate-100">
                        <div className="text-[11px] text-slate-500 mb-0.5">Líneas leídas de la factura (sin cruce BC aún)</div>
                        {(actualPropuesta.grupo?.lineas || []).map((l, i) => (
                          <div key={i} className="py-1 flex items-baseline gap-2 text-[12px]">
                            <span className="flex-1 text-slate-800">{l.descripcionFactura || "—"}</span>
                            <span className="text-slate-500">{l.cantidadFacturada ?? ""}</span>
                            <span className="text-slate-800">{l.precioFacturado != null ? fmtEur(Number(l.cantidadFacturada || 0) * Number(l.precioFacturado || 0)) : ""}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="py-1 text-[12px] text-slate-500">Este pedido está en la factura. Las líneas se ven en el PDF.</div>
                    )}
                  </div>
                  {!propuestaYaFacturada && (() => {
                    const viva = itemsDesdeBorrador();
                    if (!viva.length) return null;
                    const modo = viva.some((it) => it.albaran) ? "albaran" : "pedido";
                    return (
                      <div className="mt-1.5 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-1">
                        Marcadas para esta factura: {viva.length} línea(s)
                        {modo === "albaran"
                          ? ` · albarán ${[...new Set(viva.map((it) => it.albaran).filter(Boolean))].join(", ")}`
                          : ""}
                        {" · "}{fmtEur(sumaImportesElegidos({ items: viva }))}
                      </div>
                    );
                  })()}
                  {!propuestaYaFacturada && !borradorNuevasPropuesta.some((n) => !n.creadaId) && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!colaPropuesta) return;
                          const id = `manual-${Date.now()}`;
                          setNuevasLineasPorPedido((prev) => ({
                            ...prev,
                            [colaPropuesta]: [
                              ...(prev[colaPropuesta] || []),
                              {
                                id,
                                origen: "manual",
                                tipo: "Item",
                                codigo: "",
                                descripcion: "",
                                busqueda: "",
                                cantidad: 1,
                                coste: "",
                                marcada: true,
                              },
                            ],
                          }));
                          setNuevasLineasPanelAbierto(true);
                        }}
                        className="text-[11px] font-semibold text-amber-900 border border-amber-300 bg-amber-50 hover:bg-amber-100 rounded px-2 py-1"
                      >
                        Añadir al pedido una línea que no está en BC
                      </button>
                    </div>
                  )}
                  {!propuestaYaFacturada && borradorNuevasPropuesta.some((n) => !n.creadaId) && (
                    <div className="mt-2 border border-amber-200 bg-amber-50/60 rounded p-2">
                      <button
                        type="button"
                        onClick={() => setNuevasLineasPanelAbierto((v) => !v)}
                        className="w-full flex items-center gap-2 text-left"
                        aria-expanded={nuevasLineasPanelAbierto}
                      >
                        <span className="text-[11px] text-amber-800 w-3 shrink-0" aria-hidden="true">
                          {nuevasLineasPanelAbierto ? "▾" : "▸"}
                        </span>
                        <span className="text-[11px] font-semibold text-amber-900 flex-1 min-w-0">
                          Líneas de la factura que no están en este pedido — se añaden a {numeroPropuesta}
                          <span className="font-normal text-amber-800">
                            {" · "}{borradorNuevasPropuesta.filter((n) => !n.creadaId).length} línea(s)
                          </span>
                        </span>
                      </button>
                      {anadirLineasBc.estado === "error" && !nuevasLineasPanelAbierto && (
                        <div className="mt-1 text-[12px] text-red-700">{anadirLineasBc.error}</div>
                      )}
                      {anadirLineasBc.estado === "ok" && !nuevasLineasPanelAbierto && (
                        <div className="mt-1 text-[12px] text-emerald-800">
                          Pedido {anadirLineasBc.pedido || pedidoNuevo.numero || ""} creado y registrado. Inclúyelo en la factura.
                        </div>
                      )}
                      {nuevasLineasPanelAbierto && (
                        <>
                          <div className="text-[10px] text-amber-800 mb-1.5 mt-1.5">
                            Elige el código de artículo en BC (por defecto Artículo). Se crea un pedido nuevo solo con las líneas marcadas (OT a mano), se registra y luego puedes Incluirlas.
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-slate-500 text-left">
                                  <th className="px-1 py-0.5 w-6"></th>
                                  <th className="px-1 py-0.5">Tipo</th>
                                  <th className="px-1 py-0.5">Nº BC</th>
                                  <th className="px-1 py-0.5">Descripción</th>
                                  <th className="px-1 py-0.5 text-right">Cant.</th>
                                  <th className="px-1 py-0.5 text-right">Coste</th>
                                  <th className="px-1 py-0.5 text-right">Importe</th>
                                </tr>
                              </thead>
                              <tbody>
                                {borradorNuevasPropuesta.filter((n) => !n.creadaId).map((n) => (
                                  <tr key={n.id} className="border-t border-amber-100 align-top">
                                    <td className="px-1 py-0.5">
                                      <input
                                        type="checkbox"
                                        checked={n.marcada !== false}
                                        onChange={(e) => editarNuevaLineaPropuesta(n.id, "marcada", e.target.checked)}
                                      />
                                    </td>
                                    <td className="px-1 py-0.5 whitespace-nowrap">
                                      <select
                                        value={n.tipo || "Item"}
                                        onChange={(e) => {
                                          const t = e.target.value;
                                          editarNuevaLineaPropuesta(n.id, "tipo", t);
                                          editarNuevaLineaPropuesta(n.id, "codigo", t === "Item" ? "" : (n.codigo || "TRANSPORTE"));
                                        }}
                                        className="border border-slate-300 rounded px-1 py-0.5 bg-white"
                                      >
                                        <option value="Item">Artículo</option>
                                        <option value="Charge">Cargo</option>
                                      </select>
                                    </td>
                                    <td className="px-1 py-0.5">
                                      {(n.tipo || "Item") === "Item" ? (
                                        <BuscadorArticulo
                                          valor={n.codigo}
                                          inicial={n.busqueda}
                                          onElegir={(a) => {
                                            editarNuevaLineaPropuesta(n.id, "codigo", a.numero);
                                            if (a.descripcion) editarNuevaLineaPropuesta(n.id, "descripcion", a.descripcion);
                                          }}
                                        />
                                      ) : (
                                        <select
                                          value={n.codigo || ""}
                                          onChange={(e) => {
                                            const c = cargosProd.find((x) => x.numero === e.target.value);
                                            editarNuevaLineaPropuesta(n.id, "codigo", e.target.value);
                                            if (c) editarNuevaLineaPropuesta(n.id, "descripcion", c.descripcion);
                                          }}
                                          className="border border-slate-300 rounded px-1 py-0.5 w-40 font-mono bg-white"
                                        >
                                          <option value="">— elegir —</option>
                                          {!cargosProd.some((c) => c.numero === n.codigo) && n.codigo && (
                                            <option value={n.codigo}>{n.codigo}</option>
                                          )}
                                          {cargosProd.map((c) => (
                                            <option key={c.numero} value={c.numero}>{c.numero} — {c.descripcion}</option>
                                          ))}
                                        </select>
                                      )}
                                    </td>
                                    <td className="px-1 py-0.5">
                                      <input
                                        value={n.descripcion || ""}
                                        onChange={(e) => editarNuevaLineaPropuesta(n.id, "descripcion", e.target.value)}
                                        className="border border-slate-300 rounded px-1 py-0.5 w-full min-w-[8rem] bg-white"
                                      />
                                      {n.origen === "sin_pedido" && (
                                        <div className="text-[10px] text-slate-400">venía sin nº de pedido en el PDF</div>
                                      )}
                                    </td>
                                    <td className="px-1 py-0.5 text-right">
                                      <input
                                        type="number"
                                        value={n.cantidad}
                                        onChange={(e) => editarNuevaLineaPropuesta(n.id, "cantidad", e.target.value)}
                                        className="border border-slate-300 rounded px-1 py-0.5 w-14 text-right bg-white"
                                      />
                                    </td>
                                    <td className="px-1 py-0.5 text-right">
                                      <input
                                        type="number"
                                        step="0.01"
                                        value={n.coste}
                                        onChange={(e) => editarNuevaLineaPropuesta(n.id, "coste", e.target.value)}
                                        className="border border-slate-300 rounded px-1 py-0.5 w-20 text-right bg-white"
                                      />
                                    </td>
                                    <td className="px-1 py-0.5 text-right whitespace-nowrap text-slate-600">
                                      {n.coste !== "" && n.coste != null
                                        ? fmtEur((Number(n.cantidad) || 0) * Number(n.coste))
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={abrirVistaPedidoLineasMarcadas}
                              disabled={anadirLineasBc.estado === "subiendo" || pedidoNuevo.estado === "entrando" || !borradorNuevasPropuesta.some((n) => n.marcada && !n.creadaId)}
                              className="text-[11px] font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-60 rounded px-2 py-1"
                            >
                              {anadirLineasBc.estado === "subiendo" || pedidoNuevo.estado === "entrando" ? "Creando pedido…" : "Crear pedido"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!colaPropuesta) return;
                                const id = `manual-${Date.now()}`;
                                setNuevasLineasPorPedido((prev) => ({
                                  ...prev,
                                  [colaPropuesta]: [
                                    ...(prev[colaPropuesta] || []),
                                    {
                                      id,
                                      origen: "manual",
                                      tipo: "Item",
                                      codigo: "",
                                      descripcion: "",
                                      busqueda: "",
                                      cantidad: 1,
                                      coste: "",
                                      marcada: true,
                                    },
                                  ],
                                }));
                              }}
                              className="text-[11px] font-semibold text-amber-900 border border-amber-400 bg-white hover:bg-amber-50 rounded px-2 py-1"
                            >
                              + Otra línea
                            </button>
                            <span className="text-[10px] text-slate-500">
                              Crea un pedido nuevo con estas líneas, lo registra y refresca el listado para Incluir.
                            </span>
                          </div>
                          {anadirLineasBc.estado === "error" && (
                            <div className="mt-1 text-[12px] text-red-700">{anadirLineasBc.error}</div>
                          )}
                          {anadirLineasBc.estado === "ok" && (
                            <div className="mt-1 text-[12px] text-emerald-800">
                              Pedido {anadirLineasBc.pedido || pedidoNuevo.numero || ""} creado y registrado. Inclúyelo en la factura.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {!propuestaYaFacturada && borradorNuevasPropuesta.some((n) => n.creadaId) && anadirLineasBc.estado !== "ok" && (
                    <div className="mt-1 text-[11px] text-emerald-800">
                      Ya se creó pedido para {borradorNuevasPropuesta.filter((n) => n.creadaId).length} línea(s) sueltas.
                    </div>
                  )}
                  <div className="mt-2 flex gap-2 flex-wrap items-center">
                    {!propuestaYaFacturada && opcionesChooserPropuesta.filas?.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const todas = (opcionesChooserPropuesta.filas || []).every((f) => borradorChooser?.keys?.[f.key]);
                          if (todas) desmarcarTodasLineas();
                          else marcarTodasLineas();
                        }}
                        className="text-[11px] font-semibold text-slate-800 bg-white border border-slate-400 hover:bg-slate-50 rounded px-2 py-1"
                      >
                        {(opcionesChooserPropuesta.filas || []).every((f) => borradorChooser?.keys?.[f.key])
                          ? "Desmarcar todas"
                          : "Marcar todas"}
                      </button>
                    )}
                    {!propuestaYaFacturada && (
                      <button
                        type="button"
                        onClick={incluirPropuestaEnFactura}
                        disabled={!itemsDesdeBorrador().length}
                        className="text-[11px] font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 rounded px-2 py-1"
                      >
                        Incluir en la factura
                      </button>
                    )}
                    {!propuestaYaFacturada && propuestaSinRecibir && (
                      <button
                        type="button"
                        onClick={(e) => registrarPedidoEnBc(e, [numeroPropuesta])}
                        disabled={registroRecepcion.estado === "registrando"}
                        className="text-[11px] font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded px-2 py-1"
                      >
                        {registroRecepcion.estado === "registrando" ? "Registrando…" : "Registrar"}
                      </button>
                    )}
                    <button type="button" onClick={() => setPasoPedido((p) => Math.max(0, p - 1))} disabled={pasoSeguro === 0} className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded px-2 py-1 disabled:opacity-40">Anterior</button>
                    <button type="button" onClick={() => setPasoPedido((p) => Math.min(listaVisible.length - 1, p + 1))} disabled={pasoSeguro >= listaVisible.length - 1} className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded px-2 py-1 disabled:opacity-40">Siguiente</button>
                    {numerosConjunto.length > 0 && (
                      <button
                        type="button"
                        onClick={pulsarBotonBc}
                        disabled={ocupadoBc}
                        className="text-[11px] font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 rounded px-2 py-1"
                      >
                        {textoBotonBc}
                      </button>
                    )}
                  </div>
                  {avisoRegistroRecepcion}
                  {entrada.aviso && <div className={`mt-2 text-[12px] ${entrada.resultado?.registroOk === false ? "text-amber-800" : "text-slate-700"}`}>{entrada.aviso}</div>}
                  {entrada.estado === "error" && <div className="mt-2 text-[12px] text-red-700">{entrada.error || "No se ha podido crear la factura."}</div>}
                </div>
              )}
              <div className="mt-2 text-[12px] text-slate-700">
                Conjunto: {numerosConjunto.join(", ") || "aún ninguno"}.
                {importeConjunto > 0 ? ` ${fmtEur(importeConjunto)}` : ""}
                {cabecera.baseImponible != null ? ` · base factura ${fmtEur(cabecera.baseImponible)}` : ""}
              </div>
              <button type="button" onClick={() => setVerOtrosPedidos((v) => !v)} className="mt-2 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded px-2 py-1">
                {verOtrosPedidos ? "Ocultar otros pedidos" : "Otros pedidos del proveedor"}
              </button>
              {verOtrosPedidos && (
                <PedidosPendientesFacturar
                  compacto
                  pedidos={pedidos}
                  proveedores={nombresProveedorElegido}
                  onIncluirPedido={incluirPedidoEnFactura}
                  pedidosIncluidos={numerosConjunto}
                  marcaRecarga={recargaLineas}
                />
              )}
            </div>
          ) : (
            <>
              {numerosConjunto.length > 0 && (
                <div className="mt-3 border-t border-slate-200 pt-2">
                  <div className="text-[13px] font-semibold text-slate-800">
                    Conjunto: {numerosConjunto.join(", ")}
                    {importeConjunto > 0 ? <span className="font-normal"> {fmtEur(importeConjunto)}</span> : null}
                    {cabecera.baseImponible != null ? <span className="font-normal"> · base factura {fmtEur(cabecera.baseImponible)}</span> : null}
                  </div>
                  <div className="mt-2 flex gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={pulsarBotonBc}
                      disabled={ocupadoBc}
                      className="text-[11px] font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 rounded px-2 py-1"
                    >
                      {textoBotonBc}
                    </button>
                    {botonRegistrar}
                  </div>
                  {avisoRegistroRecepcion}
                  {entrada.aviso && <div className={`mt-2 text-[12px] ${entrada.resultado?.registroOk === false ? "text-amber-800" : "text-slate-700"}`}>{entrada.aviso}</div>}
                  {entrada.estado === "error" && <div className="mt-2 text-[12px] text-red-700">{entrada.error || "No se ha podido crear la factura."}</div>}
                </div>
              )}
              <PedidosPendientesFacturar
                compacto
                pedidos={pedidos}
                proveedores={nombresProveedorElegido}
                onIncluirPedido={incluirPedidoEnFactura}
                pedidosIncluidos={numerosConjunto}
                marcaRecarga={recargaLineas}
              />
            </>
          )}
        </div>
      )}

      <div className={abierta ? "flex flex-col xl:flex-row xl:items-start" : "hidden"}>
      <div className="min-w-0 flex-1">
      {/* Proveedor de gasto (Maria, 2026-09-04): panel propio, en vez del
          bloque rojo de motivos — no es un error a corregir, es el
          funcionamiento normal de este proveedor. Muestra la cuenta y el
          Nº de OT sugeridos (los más usados históricamente con este
          proveedor en BC), con transparencia de qué más se ha visto por
          si el detectado no es el correcto esta vez. */}
      {abierta && esGasto && !ultima && !bloqueadaPorDuplicado && (
        <div className="px-4 py-3 bg-blue-50/60 border-t border-blue-100 text-sm">
          <div className="text-blue-900">
            <span className="font-semibold">{f.gastoSugerido.proveedorBC || f.gastoSugerido.proveedorFactura}</span> no lleva
            pedido — se entra con línea de tipo <b>Cuenta</b>.
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-blue-800">
            <div>
              Cuenta contable: <span className="font-semibold">{f.gastoSugerido.cuenta}</span>
            </div>
            {f.gastoSugerido.ot && (
              <div>
                Nº de OT: <span className="font-semibold">{f.gastoSugerido.ot}</span>
              </div>
            )}
          </div>
          <div className="mt-1 text-xs text-blue-600">
            Sugerido a partir de {f.gastoSugerido.vecesVisto} línea(s) anteriores de este proveedor en BC.
            {(f.gastoSugerido.cuentasVistas?.length > 1 || f.gastoSugerido.otsVistas?.length > 1) && (
              <>
                {" "}
                <button onClick={() => setVerOtrosGasto((v) => !v)} className="underline hover:text-blue-800">
                  {verOtrosGasto ? "Ocultar" : "Ver"} otros valores vistos
                </button>
              </>
            )}
          </div>
          {verOtrosGasto && (
            <div className="mt-1.5 text-xs text-blue-700 space-y-1">
              {f.gastoSugerido.cuentasVistas?.length > 1 && (
                <div>Cuentas vistas: {f.gastoSugerido.cuentasVistas.map((c) => `${c.valor} (${c.veces})`).join(", ")}</div>
              )}
              {f.gastoSugerido.otsVistas?.length > 1 && (
                <div>Nº OT vistos: {f.gastoSugerido.otsVistas.map((o) => `${o.valor} (${o.veces})`).join(", ")}</div>
              )}
            </div>
          )}
          <div className="mt-2 text-xs text-blue-500">
            Esta pantalla todavía no crea la línea en BC — regístrala tú con estos datos ya identificados.
          </div>
        </div>
      )}

      {abierta && !modoDiario && !bloqueadaPorDuplicado && sinPedidoUtil && (
        <div className="px-4 py-3 bg-sky-50 border-t border-sky-200 text-sm" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="text-sky-950 min-w-[240px] flex-1">
              <div className="font-semibold">Esta factura no trae pedido de compra.</div>
              <div className="mt-1 text-sky-900">
                {esFerrosGrupo ? (
                  <>
                    Ferros Coll de l'Alba: se crea un pedido con cuenta <span className="font-semibold">60700004</span>,
                    descripción <span className="font-semibold">TRABAJOS ENTRE EMPRESAS DEL GRUPO</span>
                    {otFerros ? <> y OT <span className="font-semibold">{otFerros}</span></> : <> — indica la OT (en la factura suele ser AC00…/AAAA o OT …)</>}
                    . Importe de este PDF. Después se factura como el resto.
                  </>
                ) : ultima?.puedeCrear ? (
                  <>
                    Se crea igual que la última factura de {ultima.proveedorBC || ultima.proveedorFactura}
                    {ultima.numeroBC ? <> ({ultima.numeroBC})</> : null}
                    : {ultima.lineType === "Account" ? "Cuenta" : ultima.lineType || "línea"} {ultima.cuenta}
                    {ultima.ot ? `, OT ${ultima.ot}` : ""}
                    {ultima.departamento ? `, dimensión ${ultima.departamento}` : ""}.
                    La cantidad y el precio son los de este PDF. Al crearlo también se registra.
                  </>
                ) : ultima ? (
                  ultima.resumen
                ) : (
                  <>Al pulsar el botón se copia la última factura de {f.proveedor || "este proveedor"}: cuenta, OT y dimensión.</>
                )}
              </div>
              {pedidoNuevo.estado === "entrando" && <div className="mt-1.5 text-sky-800">{pedidoNuevo.numero ? "Registrando el pedido de compra…" : "Creando y registrando el pedido de compra…"}</div>}
              {pedidoNuevo.estado === "error" && <div className="mt-1.5 text-red-700">{pedidoNuevo.error || "No se ha podido crear el pedido."}</div>}
              <LineaPedidoCreado pedido={pedidoNuevo} className={`mt-1.5 ${pedidoNuevo.registro?.ok ? "text-emerald-800" : "text-amber-900"}`} />
              {pedidoNuevo.numero && pedidoNuevo.estado !== "entrando" && !pedidoNuevo.registro?.ok && pedidoNuevo.registro?.error && <div className="mt-1 text-red-700">{pedidoNuevo.registro.error}</div>}
              {pedidoNuevo.numero && pedidoNuevo.avisos?.length > 0 && <div className="mt-1 text-amber-800">{pedidoNuevo.avisos.join(" · ")}</div>}
            </div>
            {!(pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok) && (
              <button
                onClick={abrirVistaPedido}
                disabled={pedidoNuevo.estado === "entrando" || !(cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor)}
                className="flex items-center gap-1.5 text-sm font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded-md px-4 py-2"
              >
                {pedidoNuevo.estado === "entrando" ? <Loader2 size={15} className="animate-spin" /> : <FileCheck2 size={15} />}
                {pedidoNuevo.estado === "entrando"
                  ? (pedidoNuevo.numero ? "Registrando…" : "Creando y registrando…")
                  : pedidoNuevo.numero
                    ? "Registrar pedido"
                    : pedidoNuevo.estado === "error"
                      ? "Reintentar pedido"
                      : esFerrosGrupo
                        ? "Crear pedido Ferros"
                        : "Crear pedido de compra"}
              </button>
            )}
          </div>
        </div>
      )}

      {abierta && !modoDiario && !ok && !esGasto && !bloqueadaPorDuplicado && !ultima?.puedeCrear && motivos.filter((m) => !m.startsWith("No se puede entrar: el pedido")).length > 0 && (
        <div className="px-4 py-3 bg-red-50/60 border-t border-red-100">
          <div className="text-xs font-semibold text-red-800 mb-1.5">Por qué no cuadra esta factura</div>
          <div className="text-xs text-red-700 space-y-1">
            {motivos.filter((m) => !m.startsWith("No se puede entrar: el pedido")).map((m, i) => (
              <div key={i}>• {m}</div>
            ))}
          </div>
        </div>
      )}

      {abierta && !bloqueadaPorDuplicado && pedidosPendRecibir.length > 0 && (
        <div className="px-4 py-3 bg-orange-50/70 border-t border-orange-200" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <div>
              <div className="text-sm font-semibold text-orange-950">Pendiente de recibir</div>
              <div className="text-[12px] text-orange-900 mt-0.5">Cada pedido se avisa aparte. El botón es solo de ese PC.</div>
            </div>
            <button
              type="button"
              onClick={buscarCorreosPedido}
              disabled={buscandoCorreos}
              className="text-[11px] font-semibold text-orange-900 border border-orange-300 bg-white hover:bg-orange-100 disabled:opacity-60 rounded px-2 py-1"
            >
              {buscandoCorreos ? "Buscando correos…" : "Buscar correos"}
            </button>
          </div>
          <div className="space-y-2">
            {pedidosPendRecibir.map((p) => {
              const ficha = datosPedidoCargado(pedidos, p.pedido);
              const rc = recepPedido?.reclamados?.[p.pedido];
              const notas = recepPedido?.notas?.[p.pedido] || [];
              const correos = notas.filter((n) => n.correoId || /correo/i.test(n.autor || ""));
              return (
                <div key={p.pedido} className="bg-white border border-orange-200 rounded-md overflow-hidden">
                  <div className="flex items-center gap-3 flex-wrap px-2 py-1.5 text-[12px]">
                    <span className="font-mono font-semibold text-slate-800">
                      {p.enlaceBC ? <a href={p.enlaceBC} target="_blank" rel="noopener noreferrer" className="text-sky-700 hover:underline">{p.pedido}</a> : p.pedido}
                    </span>
                    <span className="text-slate-500">Pedido</span>
                    <span className="text-slate-600">{ficha.fecha || "—"}</span>
                    <span className="text-slate-800 truncate max-w-[220px]" title={ficha.proveedor || p.vendorName || ""}>{ficha.proveedor || p.vendorName || "—"}</span>
                    {ficha.comprador ? <span className="text-slate-600">{ficha.comprador}</span> : null}
                    <span className="font-mono text-slate-700">{ficha.ot || "—"}</span>
                    <span className="ml-auto text-[11px] text-blue-700 whitespace-nowrap" title={rc?.para || ""}>
                      {rc ? `✉ ${rc.veces || 1}× · ${selloCorreo(rc.ts)}` : "Sin reclamación"}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => abrirVistaCorreo(e, p.pedido)}
                      disabled={envio.estado === "enviando" || pedidosAvisados.has(String(p.pedido).toUpperCase())}
                      className="flex items-center gap-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded px-2 py-1"
                      title={`Solo la incidencia de ${p.pedido}`}
                    >
                      {envio.estado === "enviando" ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                      {pedidosAvisados.has(String(p.pedido).toUpperCase()) ? "Enviada" : "Enviar al responsable"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => abrirCorreoProveedor(e, "albaran_firmado", p.pedido)}
                      disabled={envio.estado === "enviando"}
                      className="flex items-center gap-1 text-[11px] font-semibold text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-60 rounded px-2 py-1"
                      title={`Pedir al proveedor el albarán firmado de ${p.pedido}`}
                    >
                      <Mail size={12} />
                      Pedir albarán firmado
                    </button>
                  </div>
                  <table className="w-full text-[12px] border-t border-orange-100">
                    <thead>
                      <tr className="text-left text-[11px] text-orange-900 bg-orange-50">
                        <th className="px-2 py-1 font-semibold">Artículo</th>
                        <th className="px-2 py-1 font-semibold text-right">La factura pide</th>
                        <th className="px-2 py-1 font-semibold text-right">Recibido en el pedido</th>
                        <th className="px-2 py-1 font-semibold text-right">Falta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.lineasPend.map((l, i) => {
                        const pide = Number(l.cantidadFacturada) || 0;
                        const recibido = Number(l.lineaBC?.cantidadRecibida) || 0;
                        return (
                          <tr key={i} className="border-t border-orange-100">
                            <td className="px-2 py-1.5 text-slate-800">{l.lineaBC?.descripcion || l.descripcionFactura}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{pide}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-orange-800">{recibido}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap font-semibold text-orange-900">{Math.max(0, pide - recibido)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="px-2 py-1.5 text-[12px] text-orange-950 bg-orange-50 border-t border-orange-100">
                    Hasta que esto se reciba en Recepción de material, la factura no se registra. El formulario de abajo es la lectura del PDF, no una factura creada en BC.
                  </div>
                  <div className="px-2 py-1.5 border-t border-orange-100 bg-slate-50">
                    {correos.length === 0 && <div className="text-[11px] text-slate-400">No hay correos guardados de este pedido. Pulsa Buscar correos.</div>}
                    {correos.map((n) => (
                      <div key={n.id} className="text-[11px] text-slate-700 py-0.5">
                        <span className="text-slate-400">{selloCorreo(n.ts)}</span>{" "}
                        <span className="font-semibold">{n.autor}:</span> {n.texto}
                        {n.enlace ? <> <a href={n.enlace} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline">Abrir en Outlook</a></> : null}
                      </div>
                    ))}
                    {envio.estado === "error" && envio.error && <div className="text-[11px] text-red-700 mt-1">{envio.error}</div>}
                    {envio.estado === "ok" && <div className="text-[11px] text-emerald-700 mt-1">Correo enviado a {destinatarios.join(", ")}{copias.length ? ` · copia: ${copias.join(", ")}` : ""}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {abierta && ok && !esGasto && !bloqueadaPorDuplicado && pcsFormanFactura.length > 0 && (
        <div className="px-4 py-2.5 bg-emerald-50/70 border-t border-emerald-100 text-xs text-emerald-900">
          <span className="font-semibold">Esta factura está formada por:</span>{" "}
          {pcsFormanFactura.map((p, i) => (
            <span key={p.pedido || i}>
              {i > 0 && " · "}
              {p.enlaceBC ? (
                <a href={p.enlaceBC} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-700 hover:underline" onClick={(e) => e.stopPropagation()}>
                  {p.pedido}
                </a>
              ) : (
                <b>{p.pedido}</b>
              )}
              <span className="text-emerald-700/80"> ({(p.lineas || []).length} línea{(p.lineas || []).length === 1 ? "" : "s"})</span>
            </span>
          ))}
        </div>
      )}

      {abierta && !(modoDiario && pedidosPendRecibir.length > 0) && !ok && !esGasto && !bloqueadaPorDuplicado && !ultima?.puedeCrear && (
        <div className="px-4 py-2 border-t border-red-100 bg-white flex items-center justify-between gap-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-1 min-w-[220px]">
            Responsable (dpto. del pedido):
            <input
              value={destinatariosTexto}
              onChange={(e) => {
                setDestinatariosTexto(e.target.value);
                setDestinatariosEditados(true);
              }}
              placeholder="correo1@also-casals.com, correo2@also-casals.com…"
              title="Destinatarios de la incidencia — sepáralos por comas. Se calculan solos por el departamento del pedido."
              className="flex-1 min-w-[180px] text-slate-700 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none focus:bg-white px-0.5"
            />
            {(destinatariosEditados || ccEditado) && (
              <button
                onClick={() => {
                  setDestinatariosEditados(false);
                  setCcEditado(false);
                  setDestinatariosTexto(paraAutoTxt);
                  setCcTexto(ccAutoTxt);
                }}
                title="Volver a los destinatarios calculados automáticamente"
                className="text-blue-600 hover:text-blue-800 underline shrink-0"
              >
                Restablecer
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-1 min-w-[220px]">
            Copia (administración):
            <input
              value={ccTexto}
              onChange={(e) => {
                setCcTexto(e.target.value);
                setCcEditado(true);
              }}
              placeholder="ana@…, edith@…, maria@…"
              title="Copia de Administración. Quien envía no se incluye. Dirección se añade a mano."
              className="flex-1 min-w-[180px] text-slate-700 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none focus:bg-white px-0.5"
            />
          </div>
          <div className="flex items-center gap-2">
            {remitenteEmail && (
              <span className="text-[11px] text-slate-500" title="Se envía desde tu correo de empresa (AChuman)">
                De: <span className="font-medium text-slate-700">{remitenteEmail}</span>
              </span>
            )}
            {envio.estado === "ok" && <span className="text-xs text-emerald-600 font-medium">✓ Incidencia enviada</span>}
            {envio.estado === "error" && <span className="text-xs text-red-600" title={envio.error}>Error al enviar</span>}
            {!destinatarios.length && <span className="text-xs text-amber-600">Sin destinatarios válidos</span>}
            <button
              onClick={abrirVistaCorreo}
              disabled={envio.estado === "enviando" || envio.estado === "ok" || !destinatarios.length}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {envio.estado === "enviando" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
              {envio.estado === "enviando" ? "Enviando…" : envio.estado === "ok" ? "Enviada" : "Enviar incidencia al responsable"}
            </button>
          </div>
        </div>
      )}
      {/* Entrada forzada en BC: también cuando no hay pedido, copiando la última factura */}
      {abierta && !ok && !esGasto && !bloqueadaPorDuplicado && (
        <div
          className="px-4 py-2 border-t border-amber-100 bg-amber-50/40 flex items-center justify-between gap-3 flex-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          <label className="flex items-center gap-1.5 text-xs text-amber-800 cursor-pointer">
            <input
              type="checkbox"
              checked={forzarEntrada}
              onChange={(e) => setForzarEntrada(e.target.checked)}
              disabled={entrada.estado === "entrando" || entrada.estado === "ok"}
            />
            Entrar igual en BC como borrador (salta avisos)
          </label>
          <button
            onClick={(e) => entrarEnBC(e, true)}
            disabled={!forzarEntrada || entrada.estado === "entrando" || entrada.estado === "ok"}
            title={!forzarEntrada ? "Marca la casilla para poder forzar la entrada" : ""}
            className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 disabled:opacity-50 rounded-md px-3 py-1.5"
          >
            {entrada.estado === "entrando" ? <Loader2 size={13} className="animate-spin" /> : <FileCheck2 size={13} />}
            {entrada.estado === "entrando" ? "Entrando…" : entrada.estado === "ok" ? "Entrada" : "Forzar entrada BC"}
          </button>
        </div>
      )}
      {abierta && ok && !bloqueadaPorDuplicado && (
        <div className="px-4 py-2.5 border-t border-emerald-100 bg-white flex items-center justify-between gap-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
          <div className="text-xs text-slate-600">
            Toda la factura cuadra. Pulsa el botón para crear el <b>borrador</b> en BC con el proveedor, el nº de factura y la fecha, y traer las líneas desde los albaranes de compra.
          </div>
          <div className="flex items-center gap-2">
            {entrada.estado === "ok" && <span className="text-xs text-emerald-600 font-medium">✓ Borrador creado</span>}
            {entrada.estado === "error" && <span className="text-xs text-red-600">No se pudo crear el borrador</span>}
            <button
              onClick={(e) => entrarEnBC(e, false)}
              disabled={entrada.estado === "entrando" || entrada.estado === "ok"}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {entrada.estado === "entrando" ? <Loader2 size={13} className="animate-spin" /> : <FileCheck2 size={13} />}
              {entrada.estado === "entrando" ? "Creando borrador…" : entrada.estado === "ok" ? "Borrador creado" : "Crear borrador en BC"}
            </button>
            <button
              onClick={enviarAContinia}
              disabled={continia.estado === "enviando" || continia.estado === "ok" || !f.pdfBase64}
              className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {continia.estado === "enviando" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {continia.estado === "ok" ? "Enviada a Continia" : "Enviar a Continia"}
            </button>
          </div>
        </div>
      )}
      {continia.estado === "error" && continia.error && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-t border-red-100">{continia.error}</div>
      )}
      {(entrada.estado === "ok" || entrada.estado === "error") && entrada.resultado && (
        <div className="px-4 py-2 text-xs bg-slate-50 border-t border-slate-100 space-y-1">
          {entrada.resultado.avisos?.map((a, i) => (
            <div key={`av${i}`} className="text-amber-700">⚠ {a}</div>
          ))}
          {entrada.resultado.facturasCreadas?.map((fc, i) => (
            <div key={i} className={fc.error || !fc.ok ? "text-red-700" : "text-emerald-700"}>
              {fc.error ? (
                <>✗ {fc.vendorName || fc.vendorNumber}: {fc.error}</>
              ) : (
                <>
                  {fc.ok ? "✓" : "⚠"} {fc.vendorName || fc.vendorNumber} — factura BC {fc.numero || fc.purchaseInvoiceId}
                  {fc.adjunto && !fc.adjunto.ok && ` · adjunto no se pudo enlazar: ${fc.adjunto.error}`}
                  {fc.traerAlbaranes?.length > 0 && (
                    <div className="pl-4 text-emerald-700 mt-0.5">
                      Albaranes: {fc.traerAlbaranes.map((t) => (t.ok ? (t.albaranes || []).join(", ") || t.pedido : `${t.pedido}: ${t.error || "sin enlace"}`)).join(" · ")}
                    </div>
                  )}
                  {!fc.traerAlbaranes && fc.lineasCreadas?.length > 0 && (
                    <div className="pl-4 text-emerald-700 mt-0.5">
                      Líneas de cuenta en BC ({fc.lineasCreadas.length}): {fc.lineasCreadas.join(", ")}
                    </div>
                  )}
                  {fc.lineasSinCrear?.length > 0 && (
                    <div className="pl-4 text-amber-700 mt-0.5">
                      Falta traer a mano en BC ({fc.lineasSinCrear.length} línea{fc.lineasSinCrear.length === 1 ? "" : "s"}):{" "}
                      {fc.lineasSinCrear.join(" · ")}
                    </div>
                  )}
                  {!fc.lineasCreadas && !fc.lineasSinCrear && fc.lineas?.length > 0 && (
                    <div className="pl-4 text-slate-500 mt-0.5">
                      Recuerda traer en BC ({fc.lineas.length} línea{fc.lineas.length === 1 ? "" : "s"} de esta factura):{" "}
                      {fc.lineas.map((l) => l.descripcion).join(", ")}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {entrada.estado === "error" && entrada.error && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-t border-red-100">{entrada.error}</div>
      )}
      {envio.estado === "error" && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-t border-red-100">{envio.error}</div>
      )}

      {abierta && !modoDiario && !bloqueadaPorDuplicado && (
        <div className="px-4 py-2 border-t border-slate-200 bg-white flex justify-end" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setVerDetalle((v) => !v)}
            className="text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded px-3 py-1.5"
          >
            {verDetalle ? "Ocultar líneas" : (sinNumero || pedidosDetalle.some((p) => p.bcError) ? "Ver líneas y pedidos" : "Ver líneas")}
          </button>
        </div>
      )}

      {abierta && !bloqueadaPorDuplicado && verDetalle && (
        <div className="border-t border-slate-200 bg-[#f4f6f8]" onClick={(e) => e.stopPropagation()}>
          <div>
            <div className="min-w-0 bg-white">
              {pedidosPendRecibir.length > 0 && (
                <div className="px-4 py-2 text-[12px] text-orange-950 bg-orange-50 border-b border-orange-200">
                  Lectura del PDF. Esta factura todavía no está en BC porque el pedido no se ha recibido.
                </div>
              )}
              {sinNumero && (
                <div className="px-4 py-2 text-[12px] text-amber-950 bg-amber-50 border-b border-amber-200">
                  {(f.paginas || []).length} página(s) sin número de factura reconocido. Indica el proveedor y te propongo solo sus pedidos de compra.
                </div>
              )}
              <div className="px-4 pt-3 pb-2 border-b border-slate-200">
                <div className="text-[12px] font-semibold text-slate-700 mb-2">General</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <label className="text-[11px] text-slate-500 block">
                    Nombre del proveedor
                    <input
                      list={listaProveedorId}
                      value={cabecera.proveedor}
                      onChange={(e) => indicarProveedor(e.target.value)}
                      placeholder="Escribe o elige el proveedor"
                      className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
                    />
                    <datalist id={listaProveedorId}>
                      {proveedoresLista.map((nombre) => <option key={nombre} value={nombre} />)}
                    </datalist>
                    {sinNumero && String(cabecera.proveedor || "").trim() && !proveedorExacto && (
                      <div className="mt-1 text-[11px] text-amber-800">Elige el nombre tal como está en la lista.</div>
                    )}
                  </label>
                  <label className="text-[11px] text-slate-500 block">
                    Nº factura proveedor
                    <input
                      value={cabecera.factura}
                      onChange={(e) => editarCabecera("factura", e.target.value)}
                      className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
                    />
                  </label>
                  <label className="text-[11px] text-slate-500 block">
                    Fecha factura
                    <input
                      type="date"
                      value={cabecera.fecha || ""}
                      onChange={(e) => editarCabecera("fecha", e.target.value)}
                      className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 focus:outline-none focus:border-sky-600"
                    />
                  </label>
                  <label className="text-[11px] text-slate-500 block">
                    Importe IVA excl.
                    <input
                      type="number"
                      step="0.01"
                      value={cabecera.baseImponible ?? ""}
                      onChange={(e) => editarCabecera("baseImponible", e.target.value === "" ? null : Number(e.target.value))}
                      className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 text-right focus:outline-none focus:border-sky-600"
                    />
                  </label>
                  <label className="text-[11px] text-slate-500 block">
                    Importe IVA
                    <div className="mt-0.5 text-[13px] text-slate-800 text-right border-b border-slate-300 pb-0.5">
                      {cabecera.importeTotal != null && cabecera.baseImponible != null
                        ? fmtEur(Number(cabecera.importeTotal) - Number(cabecera.baseImponible))
                        : "—"}
                    </div>
                  </label>
                  <label className="text-[11px] text-slate-500 block">
                    Total IVA incl.
                    <input
                      type="number"
                      step="0.01"
                      value={cabecera.importeTotal ?? ""}
                      onChange={(e) => editarCabecera("importeTotal", e.target.value === "" ? null : Number(e.target.value))}
                      className="mt-0.5 w-full bg-transparent border-0 border-b border-slate-300 pb-0.5 text-[13px] text-slate-800 text-right focus:outline-none focus:border-sky-600"
                    />
                  </label>
                  <div className="text-[11px] text-slate-500">
                    Pedido
                    <div className="mt-0.5 text-[13px] text-slate-800 border-b border-slate-300 pb-0.5">
                      {pedidosDetalle.map((p) => p.pedido).filter(Boolean).join(", ") || "Sin pedido"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-2 py-2">
                <div className="flex items-center justify-between px-2 mb-1">
                  <div className="text-[12px] font-semibold text-slate-700">Líneas</div>
                </div>
                <div className="overflow-x-auto border border-slate-200">
                  <table className="w-full text-[12px] min-w-[760px]">
                    <thead>
                      <tr className="text-left text-[11px] text-slate-500 bg-slate-50 border-b border-slate-200">
                        <th className="px-2 py-1.5 font-semibold w-[88px]">Tipo</th>
                        <th className="px-2 py-1.5 font-semibold w-[110px]">Nº</th>
                        <th className="px-2 py-1.5 font-semibold">Descripción</th>
                        <th className="px-2 py-1.5 font-semibold text-right w-[72px]">Cantidad</th>
                        <th className="px-2 py-1.5 font-semibold text-right w-[96px]">Coste unit.</th>
                        <th className="px-2 py-1.5 font-semibold text-right w-[96px]">Importe</th>
                        <th className="px-2 py-1.5 font-semibold w-[88px]">OT</th>
                        <th className="px-2 py-1.5 font-semibold w-[110px]">Cód. dim.</th>
                        <th className="px-2 py-1.5 font-semibold w-[120px]">Pedido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pedidosDetalle.map((p, i) => (
                        <Fragment key={i}>
                          {(p.bcError || p.lineas?.length > 0) && (
                            <tr className="bg-slate-50/80 border-b border-slate-100">
                              <td colSpan={9} className="px-2 py-1 text-[11px]">
                                <span className="font-semibold text-slate-700">
                                  {pedidoNuevo.estado === "ok" && !p.pedido && pedidoNuevo.numero ? (
                                    pedidoNuevo.enlace
                                      ? <a href={pedidoNuevo.enlace} target="_blank" rel="noopener noreferrer" className="text-sky-700 hover:underline" onClick={(e) => e.stopPropagation()}>{pedidoNuevo.numero}</a>
                                      : pedidoNuevo.numero
                                  ) : p.pedido ? (
                                    p.enlaceBC ? <a href={p.enlaceBC} target="_blank" rel="noopener noreferrer" className="text-sky-700 hover:underline" onClick={(e) => e.stopPropagation()}>{p.pedido}</a> : p.pedido
                                  ) : ultima?.puedeCrear ? "Pedido nuevo" : "Sin pedido"}
                                </span>
                                {p.vendorName ? <span className="text-slate-500"> · {p.vendorName}</span> : null}
                                {p.bcError && !(ultima?.puedeCrear && !p.pedido) ? <span className="text-red-700"> · {p.bcError}</span> : null}
                                {ultima?.puedeCrear && !p.pedido && pedidoNuevo.estado === "entrando" ? <span className="text-sky-800"> · Creando el pedido…</span> : null}
                                <span className="float-right">
                                  {p.pedido && (
                                    <button onClick={() => refrescarPedido(i)} disabled={refrescando[i]} className="text-sky-700 hover:underline disabled:opacity-50 mr-3">
                                      {refrescando[i] ? "Actualizando…" : "Actualizar"}
                                    </button>
                                  )}
                                  {p.bcError && !(ultima?.puedeCrear && !p.pedido) && (
                                    <button onClick={() => (seleccionActiva === i ? onCancelarSeleccion?.() : onIniciarSeleccion?.(i))} className="text-amber-800 hover:underline">
                                      {seleccionActiva === i ? "Cancelar" : "Elegir pedido"}
                                    </button>
                                  )}
                                </span>
                              </td>
                            </tr>
                          )}
                          {(p.lineas || []).map((l, j) => {
                            if (descripcionEsSoloPedido(l.descripcionFactura, p.pedido) && !l.lineaBC) {
                              return (
                                <tr key={`${i}-${j}`} className="border-b border-slate-100 bg-slate-50">
                                  <td colSpan={9} className="px-2 py-1 text-[11px] text-slate-500">
                                    El PDF repite el número de pedido {p.pedido}. No es un artículo de la factura.
                                  </td>
                                </tr>
                              );
                            }
                            const problema = l.coincidencia === "sin_match" || l.diferenciaPrecio || !l.lineaBC;
                            const pide = Number(l.cantidadFacturada) || 0;
                            const recibido = Number(l.lineaBC?.cantidadRecibida) || 0;
                            const importe = l.cantidadFacturada != null && l.precioFacturado != null ? Number(l.cantidadFacturada) * Number(l.precioFacturado) : null;
                            const plantilla = !l.lineaBC && ultima?.lineas?.length
                              ? (ultima.lineas[j] || (ultima.lineas.length === 1 ? ultima.lineas[0] : null))
                              : null;
                            const tipoBruto = l.lineaBC?.lineType || plantilla?.tipo || plantilla?.tipoApi || "";
                            const tipo = /account|cuenta|g\/?l/i.test(tipoBruto) ? "Cuenta"
                              : /charge|cargo/i.test(tipoBruto) ? "Cargo"
                              : /resource|recurso/i.test(tipoBruto) ? "Recurso"
                              : /item|art/i.test(tipoBruto) ? "Artículo"
                              : tipoBruto;
                            return (
                              <tr key={`${i}-${j}`} className={`border-b border-slate-100 ${l.pendienteRecepcion ? "bg-orange-50" : problema ? "bg-red-50/70" : ""}`}>
                                <td className="px-2 py-1 text-slate-700">{tipo || "—"}</td>
                                <td className="px-2 py-1 font-mono text-[11px] text-sky-800">{l.lineaBC?.codigo || plantilla?.cuenta || "—"}</td>
                                <td className="px-2 py-1">
                                  <input
                                    value={l.descripcionFactura || ""}
                                    onChange={(e) => editarLinea(i, j, "descripcionFactura", e.target.value)}
                                    className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-sky-600 focus:outline-none text-[12px]"
                                  />
                                  {p.lineasDisponiblesBC?.length > 0 && (
                                    <select
                                      value={l.coincidencia === "manual" ? l.lineaBC?.id || "" : ""}
                                      onChange={(e) => e.target.value && elegirLineaBC(i, j, e.target.value)}
                                      className="mt-0.5 w-full text-[10px] border border-slate-200 bg-white text-slate-600"
                                    >
                                      <option value="">{l.lineaBC ? "Cambiar línea de BC" : "Elegir línea de BC"}</option>
                                      {p.lineasDisponiblesBC.map((lb) => (
                                        <option key={lb.id} value={lb.id}>{lb.codigo ? `${lb.codigo} — ` : ""}{lb.descripcion}</option>
                                      ))}
                                    </select>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-right">
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={l.cantidadFacturada ?? ""}
                                    onChange={(e) => editarLinea(i, j, "cantidadFacturada", e.target.value === "" ? 0 : Number(e.target.value))}
                                    className="w-16 text-right bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-sky-600 focus:outline-none"
                                  />
                                  {l.pendienteRecepcion && (
                                    <div className="mt-0.5 text-[10px] leading-tight text-orange-900">
                                      <div>Pide {pide}</div>
                                      <div className="font-semibold">Recibido {recibido}</div>
                                      <div className="font-semibold">Faltan {Math.max(0, pide - recibido)}</div>
                                    </div>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-right">
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={l.precioFacturado ?? ""}
                                    onChange={(e) => editarLinea(i, j, "precioFacturado", e.target.value === "" ? null : Number(e.target.value))}
                                    className={`w-20 text-right bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-sky-600 focus:outline-none ${l.diferenciaPrecio ? "text-red-700 font-semibold" : ""}`}
                                  />
                                </td>
                                <td className="px-2 py-1 text-right text-slate-700">{importe != null && !Number.isNaN(importe) ? fmtEur(importe) : "—"}</td>
                                <td className="px-2 py-1 text-[11px] text-slate-700">{plantilla?.ot || "—"}</td>
                                <td className="px-2 py-1 text-[11px] text-slate-700">{plantilla?.departamento || "—"}</td>
                                <td className="px-2 py-1 text-[11px]">
                                  {p.pedido ? <span className="text-slate-700">{p.pedido}</span> : <span className="text-amber-800">Sin pedido</span>}
                                  {l.pendienteRecepcion && <div className="text-orange-800 font-semibold">Aún no recibido</div>}
                                  {l.diferenciaPrecio && <div className="text-red-700">Precio distinto</div>}
                                  {!l.lineaBC && <div className="text-red-700">Sin línea en BC</div>}
                                </td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      ))}
                      {pedidosDetalle.every((p) => !(p.lineas || []).length) && (
                        <tr><td colSpan={9} className="px-2 py-4 text-center text-slate-400">No hay líneas en esta factura.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {pedidosDetalle.map((p, i) => {
                  if (p.pedido && !p.bcError) return null;
                  const escrito = String(cabecera.proveedor || "").trim();
                  const esElDeLaLectura = escrito.toUpperCase() === String(f.proveedor || "").trim().toUpperCase();
                  const proveedorFactura = proveedorExacto || (esElDeLaLectura || !escrito ? (p.vendorName || f.proveedor || "") : "");
                  const importeLineas = (p.lineas || []).reduce((s, l) => s + (Number(l.cantidadFacturada) || 0) * (Number(l.precioFacturado) || 0), 0);
                  const yaUsados = new Set(pedidosDetalle.map((x) => String(x.pedido || "").toUpperCase()).filter(Boolean));
                  const sugerencias = sugerirPedidos({
                    pedidos,
                    proveedor: proveedorFactura,
                    fecha: cabecera.fecha,
                    importe: cabecera.importeTotal || importeLineas || null,
                    yaUsados,
                  });
                  const ejemploEnlace = p.enlaceBC || pedidosDetalle.find((x) => x.enlaceBC)?.enlaceBC;
                  const gruposSug = [
                    ["Por proveedor", sugerencias.porProveedor],
                    ["Por fecha", sugerencias.porFecha],
                    ["Por importe", sugerencias.porImporte],
                  ].filter(([, lista]) => lista.length);
                  const propuestos = unirSugerencias(gruposSug);
                  const todos = sugerencias.porProveedorTodos || [];
                  const q = buscaPedido.trim().toUpperCase();
                  const resto = todos.filter((c) => !propuestos.some((x) => x.pedido === c.pedido));
                  const filtrados = (q ? resto.filter((c) => `${c.pedido} ${c.proveedor}`.toUpperCase().includes(q)) : resto).slice(0, 40);
                  return (
                    <div key={`sug-${i}`} className="mt-3">
                      <div className="text-[12px] font-semibold text-slate-800 mb-1">
                        No sé a qué pedido va {p.pedido ? `el pedido leído ${p.pedido}` : "esta factura"}. Abre la flecha para ver las líneas y pulsa Usar si es el correcto.
                      </div>
                      {!(pedidos?.rows || []).length && (
                        <div className="text-[12px] text-slate-500">Carga los pedidos de compra para proponer coincidencias.</div>
                      )}
                      {!!escrito && !proveedorExacto && !esElDeLaLectura && (
                        <div className="text-[12px] text-amber-800">Elige el proveedor de la lista, con el nombre tal como está en Business Central.</div>
                      )}
                      {!!(pedidos?.rows || []).length && !!proveedorFactura && !propuestos.length && !todos.length && (
                        <div className="text-[12px] text-slate-500">No hay pedidos pendientes de facturar de {proveedorFactura} en la lista cargada.</div>
                      )}
                      {propuestos.length > 0 && (
                        <ListaSugerenciaPedidos filas={propuestos} onUsar={(numero) => aplicarPedidoElegido(i, numero)} ejemploEnlace={ejemploEnlace} />
                      )}
                      {todos.length > propuestos.length && (
                        <div className="mt-2">
                          {!verTodosProv && propuestos.length > 0 ? (
                            <button type="button" onClick={() => setVerTodosProv(true)} className="text-[12px] font-semibold text-blue-700 hover:underline">
                              Si no es ninguno, ver los {resto.length} pedidos pendientes de {proveedorFactura || "este proveedor"}
                            </button>
                          ) : (
                            <>
                              <div className="text-[12px] text-slate-600 mb-1">Pedidos pendientes de facturar de {proveedorFactura || "este proveedor"} ({resto.length})</div>
                              <input
                                value={buscaPedido}
                                onChange={(e) => setBuscaPedido(e.target.value)}
                                placeholder="Buscar nº de pedido o proveedor"
                                className="mb-1 w-full max-w-xs border border-slate-300 rounded px-2 py-1 text-[12px]"
                              />
                              <ListaSugerenciaPedidos
                                filas={filtrados.map((c) => ({ ...c, motivos: ["Pendiente de facturar"] }))}
                                onUsar={(numero) => aplicarPedidoElegido(i, numero)}
                                ejemploEnlace={ejemploEnlace}
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 px-3 py-2 text-[12px] text-slate-600 border border-t-0 border-slate-200">
                  <div>Importe IVA excl. <span className="ml-3 font-semibold text-slate-800">{cabecera.baseImponible != null ? fmtEur(Number(cabecera.baseImponible)) : "—"}</span></div>
                  <div>Total IVA incl. <span className="ml-3 font-semibold text-slate-800">{cabecera.importeTotal != null ? fmtEur(Number(cabecera.importeTotal)) : "—"}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {abierta && !bloqueadaPorDuplicado && !esGasto && !ultima?.puedeCrear && verDetalle && (
        <div className="px-4 py-3 border-t border-slate-100" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
                Pedidos que conforman la factura · {pedidosDetalle.filter(pedidoCuadra).length} en verde · {pedidosDetalle.filter((p) => !pedidoCuadra(p)).length} en rojo
              </div>
              <div className="space-y-2">
                {pedidosDetalle.map((p, i) => {
                  const bien = pedidoCuadra(p);
                  const soloRecepcion = !bien && !p.bcError && (p.lineas || []).some((l) => l.pendienteRecepcion) && (p.lineas || []).every((l) => l.pendienteRecepcion || descripcionEsSoloPedido(l.descripcionFactura, p.pedido) || (l.lineaBC && l.coincidencia !== "sin_match" && !l.diferenciaPrecio));
                  const ejemploEnlace = p.enlaceBC || pedidosDetalle.find((x) => x.enlaceBC)?.enlaceBC;
                  return (
                    <div key={i} className={`rounded-lg border px-3 py-2 ${bien ? "bg-emerald-50 border-emerald-300" : soloRecepcion ? "bg-orange-50 border-orange-300" : "bg-red-50 border-red-300"}`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className={`text-sm font-semibold ${bien ? "text-emerald-800" : soloRecepcion ? "text-orange-900" : "text-red-800"}`}>
                          {bien ? "OK · cuadra con la factura" : soloRecepcion ? "Pendiente de recibir · la factura no está entrada" : "No cuadra"}
                          {" · "}
                          {p.pedido ? `Pedido ${p.pedido}` : "Pedido no reconocido"}
                          {p.vendorName ? <span className="font-normal"> · {p.vendorName}</span> : ""}
                        </div>
                        {(p.enlaceBC || (p.pedido && ejemploEnlace)) && (
                          <a
                            href={p.enlaceBC || enlaceOtroPedido(ejemploEnlace, p.pedido)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-white bg-slate-700 hover:bg-slate-800 rounded px-2.5 py-1"
                          >
                            Abrir pedido
                          </a>
                        )}
                      </div>
                      {!bien && p.bcError && <div className="text-[11px] text-red-700 mt-1">{p.bcError}</div>}
                      {!bien && (
                        <div className="text-[11px] text-slate-500 mt-1">Los pedidos sugeridos están junto a las líneas de la factura. Abre la flecha de cada uno para ver sus líneas.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
        </div>
      )}
      {vistaPedido && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => { if (pedidoNuevo.estado !== "entrando") setVistaPedido(null); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">
              {vistaPedido.propuesta?.regla === "ferros-grupo"
                ? "Pedido Ferros · trabajos entre empresas"
                : vistaPedido.modo === "lineasMarcadas"
                  ? "Vista previa del pedido de compra"
                  : "Vista previa del pedido de compra"}
            </div>
            <div className="px-4 py-3 space-y-3 text-sm">
              {vistaPedido.cargando && <div className="text-slate-500">{vistaPedido.propuesta?.regla === "ferros-grupo" ? "Preparando el pedido de Ferros…" : "Buscando la última factura de este proveedor…"}</div>}
              {vistaPedido.error && <div className="text-red-700">{vistaPedido.error}</div>}
              {vistaPedido.propuesta && (
                <>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                    <div className="text-slate-500">Proveedor</div>
                    <div className="text-slate-800">{vistaPedido.propuesta.proveedorBC || cabecera.proveedor || f.proveedor}</div>
                    {vistaPedido.propuesta.regla === "ferros-grupo" ? (
                      <>
                        <div className="text-slate-500">Cuenta</div>
                        <div className="text-slate-800 font-semibold">{vistaPedido.propuesta.cuenta || "60700004"}</div>
                        <div className="text-slate-500">Descripción</div>
                        <div className="text-slate-800">{vistaPedido.propuesta.descripcionFija || "TRABAJOS ENTRE EMPRESAS DEL GRUPO"}</div>
                        <div className="text-slate-500">Importe</div>
                        <div className="text-slate-800">{cabecera.baseImponible != null ? fmtEur(cabecera.baseImponible) : "—"}</div>
                      </>
                    ) : vistaPedido.modo === "lineasMarcadas" ? (
                      <>
                        {vistaPedido.propuesta.numeroBC && (
                          <>
                            <div className="text-slate-500">Como la factura</div>
                            <div className="text-slate-800">{vistaPedido.propuesta.numeroBC}{vistaPedido.propuesta.fecha ? ` · ${vistaPedido.propuesta.fecha}` : ""}</div>
                          </>
                        )}
                        <div className="text-slate-500">Artículo / cargo</div>
                        <div className="text-slate-800">{(vistaPedido.propuesta.lineasMarcadas || []).map((l) => l.codigo).filter(Boolean).join(", ") || "—"}</div>
                        <div className="text-slate-500">Dimensión</div>
                        <div className="text-slate-800">{vistaPedido.propuesta.departamento || "—"}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-slate-500">Como la factura</div>
                        <div className="text-slate-800">{vistaPedido.propuesta.numeroBC || "—"}{vistaPedido.propuesta.fecha ? ` · ${vistaPedido.propuesta.fecha}` : ""}</div>
                        <div className="text-slate-500">Cuenta</div>
                        <div className="text-slate-800">{vistaPedido.propuesta.cuenta || "—"}</div>
                        <div className="text-slate-500">Dimensión</div>
                        <div className="text-slate-800">{vistaPedido.propuesta.departamento || "—"}</div>
                      </>
                    )}
                  </div>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-slate-700">Nº de OT</span>
                    <input
                      autoFocus
                      value={vistaPedido.ot}
                      onChange={(e) => setVistaPedido((v) => ({ ...v, ot: e.target.value }))}
                      placeholder={vistaPedido.propuesta.regla === "ferros-grupo" ? "AC00XXXXX/2026 o OT XXXXX" : "La de la última factura. Cámbiala si esta obra es otra."}
                      className="mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
                    />
                    {vistaPedido.propuesta.regla === "ferros-grupo" && !String(vistaPedido.ot || "").trim() && (
                      <div className="mt-1 text-[11px] text-amber-800">Obligatoria para Ferros. Si no está en el PDF, escríbela tú.</div>
                    )}
                  </label>
                  {vistaPedido.modo === "lineasMarcadas" ? (
                  <div>
                    <div className="text-[11px] text-slate-500 mb-1">Líneas del pedido nuevo</div>
                    <div className="border border-slate-200 rounded divide-y divide-slate-100">
                      {(vistaPedido.propuesta.lineasMarcadas || []).map((l, i) => (
                        <div key={l.id || i} className="px-2 py-1.5 flex items-baseline gap-2 text-[12px]">
                          <span className="flex-1 text-slate-800 truncate">{l.codigo ? `${l.codigo} · ${l.descripcion || ""}` : (l.descripcion || "—")}</span>
                          <span className="text-slate-500 shrink-0">{l.cantidad ?? 1}</span>
                          <span className="text-slate-800 shrink-0">{l.coste != null ? fmtEur(l.coste) : "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  ) : vistaPedido.propuesta.regla !== "ferros-grupo" && (
                  <div>
                    <div className="text-[11px] text-slate-500 mb-1">Líneas de esta factura</div>
                    <div className="border border-slate-200 rounded divide-y divide-slate-100">
                      {(lineasParaPedido().length ? lineasParaPedido() : [{ descripcion: `Factura ${cabecera.factura || ""}`, cantidad: 1, precioUnitario: cabecera.baseImponible }]).map((l, i) => (
                        <div key={i} className="px-2 py-1.5 flex items-baseline gap-2 text-[12px]">
                          <span className="flex-1 text-slate-800 truncate">{l.descripcion || "—"}</span>
                          <span className="text-slate-500 shrink-0">{l.cantidad ?? 1}</span>
                          <span className="text-slate-800 shrink-0">{l.precioUnitario != null ? fmtEur(l.precioUnitario) : "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  )}
                </>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setVistaPedido(null)} className="text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md px-3 py-1.5">Cancelar</button>
              <button
                type="button"
                disabled={vistaPedido.cargando || !!vistaPedido.error || !vistaPedido.propuesta || pedidoNuevo.estado === "entrando" || (vistaPedido.propuesta?.regla === "ferros-grupo" && !String(vistaPedido.ot || "").trim())}
                onClick={() => (vistaPedido.modo === "lineasMarcadas"
                  ? crearPedidoDesdeLineasMarcadas(vistaPedido.ot)
                  : crearPedidoComoUltima(null, vistaPedido.ot))}
                className="text-sm font-semibold text-white bg-sky-700 hover:bg-sky-800 disabled:opacity-60 rounded-md px-3 py-1.5"
              >
                Crear pedido
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {vistaCorreo && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => { if (envio.estado !== "enviando") setVistaCorreo(null); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">
              {vistaCorreo.alProveedor ? "Correo al proveedor" : vistaCorreo.alResponsable ? "Preguntar al responsable de la OT" : `Revisa el correo antes de enviarlo${vistaCorreo.pedido ? ` · ${vistaCorreo.pedido}` : ""}`}
            </div>
            <div className="px-4 py-3 space-y-3 text-sm">
              {vistaCorreo.alProveedor && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-500">Mensaje</span>
                  <button
                    type="button"
                    onClick={() => elegirTipoCorreoProveedor("proveedor")}
                    className={`text-sm rounded-md px-3 py-1.5 border ${(vistaCorreo.tipoMensaje || "proveedor") === "proveedor" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                  >
                    Proveedor
                  </button>
                  <button
                    type="button"
                    onClick={() => elegirTipoCorreoProveedor("interno")}
                    className={`text-sm rounded-md px-3 py-1.5 border ${vistaCorreo.tipoMensaje === "interno" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                  >
                    Interno
                  </button>
                </div>
              )}
              <div>
                <div className="text-[11px] text-slate-500">De</div>
                <div className="text-slate-800">{remitenteEmail || "Tu correo de empresa"}</div>
              </div>
              <label className="block">
                <span className="text-[11px] text-slate-500">
                  {vistaCorreo.alProveedor
                    ? (vistaCorreo.tipoMensaje === "interno" ? "Para · responsables internos" : "Para · proveedor")
                    : `Para${vistaCorreo.pedido ? ` · responsables de ${vistaCorreo.pedido}` : ""}`}
                </span>
                <input
                  value={vistaCorreo.paraTexto || ""}
                  onChange={(e) => setVistaCorreo((v) => {
                    const next = { ...v, paraTexto: e.target.value };
                    if (v?.alProveedor && v.tipoMensaje !== "interno") next.paraProveedor = e.target.value;
                    return next;
                  })}
                  className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
                />
                {vistaCorreo.alProveedor && vistaCorreo.tipoMensaje === "interno" && (
                  <div className="text-[10px] text-slate-400 mt-0.5">Mensaje interno: el correo del proveedor no se incluye.</div>
                )}
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-500">Copia</span>
                <input
                  value={vistaCorreo.ccTexto || ""}
                  onChange={(e) => setVistaCorreo((v) => {
                    const next = { ...v, ccTexto: e.target.value };
                    if (v?.alProveedor && v.tipoMensaje !== "interno") {
                      next.ccProveedor = emailsDeCampo(e.target.value);
                    }
                    return next;
                  })}
                  className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-500">Asunto</span>
                <input
                  value={vistaCorreo.asunto}
                  onChange={(e) => setVistaCorreo((v) => ({ ...v, asunto: e.target.value }))}
                  className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
                />
              </label>
              {vistaCorreo.cuerpoHtml ? (
                <div>
                  <div className="text-[11px] text-slate-500 mb-1">Mensaje</div>
                  <div className="border border-slate-200 rounded p-3 bg-slate-50 overflow-x-auto" dangerouslySetInnerHTML={{ __html: vistaCorreo.cuerpoHtml }} />
                </div>
              ) : (
                <label className="block">
                  <span className="text-[11px] text-slate-500">Mensaje</span>
                  <textarea
                    value={vistaCorreo.cuerpo || ""}
                    onChange={(e) => setVistaCorreo((v) => ({ ...v, cuerpo: e.target.value }))}
                    rows={12}
                    className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px] leading-relaxed"
                  />
                </label>
              )}
              <div className="text-[12px] text-slate-600">
                Adjunto: {(vistaCorreo.pdfBase64 || pdfB64) ? `Factura_${cabecera.factura}.pdf` : "esta factura no tiene PDF adjunto"}
              </div>
              {envio.estado === "error" && <div className="text-[12px] text-red-700">{envio.error || "No se ha podido enviar."}</div>}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setVistaCorreo(null)}
                disabled={envio.estado === "enviando"}
                className="text-sm text-slate-600 hover:text-slate-800 px-3 py-1.5 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={enviarAviso}
                disabled={envio.estado === "enviando" || !emailsDeCampo(vistaCorreo.paraTexto).length || !(vistaCorreo.asunto || "").trim()}
                className="flex items-center gap-1.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-md px-3 py-1.5"
              >
                {envio.estado === "enviando" ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                {envio.estado === "enviando" ? "Enviando…" : "Enviar"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      </div>
      {abierta && !modoDiario && (
        <aside className="order-first xl:order-none xl:w-[min(520px,46%)] xl:shrink-0 border-t xl:border-t-0 xl:border-l border-slate-200 bg-white" onClick={(e) => e.stopPropagation()}>
          <div className="px-3 py-2 text-[12px] font-semibold text-slate-700 border-b border-slate-200 flex items-center justify-between gap-2">
            <span>Vista previa · {f.paginas?.length || 0} pág.</span>
            {(f.origen?.msg || pdfUrl) && (
              <a
                href={f.origen?.msg
                  ? `/api/facturas-compra/bandeja/archivo.pdf?msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att || "")}`
                  : pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-purple-700 hover:underline"
              >
                Abrir PDF
              </a>
            )}
          </div>
          {(f.origen?.msg || pdfUrl) ? (
            <iframe
              src={f.origen?.msg
                ? `/api/facturas-compra/bandeja/archivo.pdf?msg=${encodeURIComponent(f.origen.msg)}&att=${encodeURIComponent(f.origen.att || "")}`
                : pdfUrl}
              title={`factura-${cabecera.factura || "pdf"}`}
              className="w-full bg-slate-100"
              style={{ height: "min(78vh, 820px)" }}
            />
          ) : (
            <div className="p-6 text-sm text-slate-400 text-center">{f.origen?.msg ? "Cargando el PDF…" : "Sin vista previa"}</div>
          )}
        </aside>
      )}
      </div>
    </div>
  );
}

const normalizarProveedor = (s) => (s || "").toString().trim().toUpperCase();

/**
 * PedidosPendientesFacturar — lista, debajo de la validación de
 * facturas, los pedidos de compra pendientes de facturar en BC (aunque
 * la factura del proveedor no haya llegado todavía) — a petición de
 * Maria.
 *
 * `proveedores`: nombres de proveedor (tal como los devuelve BC) de la
 * factura que se acaba de validar arriba — a petición de Maria
 * (2026-09-04), la lista SOLO enseña los pedidos de ese/esos
 * proveedores, no los de todos. Vienen de `pedidosDetalle[].vendorName`
 * en el resultado de `/api/facturas-compra/extraer` (ya se pedía a BC
 * para cruzar las líneas; no es ninguna llamada nueva). Sin factura
 * subida (o sin proveedor identificado todavía), la sección no enseña
 * ningún pedido y lo explica en pantalla, en vez de enseñar los de
 * todos los proveedores por defecto.
 *
 * Los pedidos en sí (`pedidos` prop) vienen de "Pedido_compra_Excel",
 * que la app YA carga — no hay ninguna llamada nueva al backend para
 * eso. Es la CABECERA del pedido (proveedor, direcciones, fechas...),
 * UNA FILA POR PEDIDO, sin columnas de línea (ni descripción, ni
 * cantidad) — ver el historial completo de intentos en el doc del
 * proyecto.
 *
 * Dos criterios para decidir "¿facturado?", por orden de preferencia:
 *  1) POR CANTIDADES: FACTURADO si Qty_to_Invoice = 0 y
 *     Quantity_Invoiced ≥ Quantity (normalmente no disponible en esta
 *     fuente de cabecera).
 *  2) POR TEXTO (el que realmente se usa con esta fuente): FACTURADO
 *     si la columna "Incluido en Nº Factura" (técnicamente
 *     "Vendor_Invoice_No") tiene algo escrito.
 *
 * Desplegable de líneas (nuevo, 2026-09-04, a petición de Maria): como
 * esta fuente no trae líneas, al desplegar un pedido se pide LIVE a BC
 * con el mismo endpoint que ya usa el botón "Actualizar desde BC" de
 * arriba (`POST /api/facturas-compra/refrescar-pedido` — sin backend
 * nuevo), y se cachea en memoria para no repetir la llamada si se
 * vuelve a abrir el mismo pedido.
 */
function PedidosPendientesFacturar({ pedidos, proveedores, modoSeleccion, onElegirPedido, onCancelarSeleccion, compacto = false, onIncluirPedido, pedidosIncluidos, marcaRecarga = 0 }) {
  const [verColumnas, setVerColumnas] = useState(false);
  const [verFacturados, setVerFacturados] = useState(false);
  const [abierto, setAbierto] = useState({});
  const [lineasPorPedido, setLineasPorPedido] = useState({}); // { [pedido]: {cargando, error, lineas} }
  const [busquedaSeleccion, setBusquedaSeleccion] = useState("");
  // Buscador de pedidos (Maria, 2026-09-04): con un proveedor con muchos
  // pedidos pendientes (p. ej. "1860 pedido(s) pendiente(s)" de Saltoki),
  // busca por nº de pedido dentro de la lista ya filtrada por proveedor
  // — no reemplaza ese filtro, solo lo estrecha más.
  const [busquedaPedido, setBusquedaPedido] = useState("");

  const cols = useMemo(() => columnasPedidos(pedidos?.headers || []), [pedidos]);

  const proveedoresNormalizados = useMemo(
    () => new Set((proveedores || []).map(normalizarProveedor).filter(Boolean)),
    [proveedores]
  );

  // Dos formas de decidir "¿facturado?", por orden de preferencia:
  //  1) Por cantidades (Maria, 2026-09-04): Qty_to_Invoice = 0 y
  //     Quantity_Invoiced >= Quantity → FACTURADO. Necesita las 3
  //     columnas de cantidad (de línea — normalmente no están en esta
  //     fuente de cabecera, ver comentario de arriba).
  //  2) Si esas columnas no existen: por texto — "Incluido en Nº
  //     Factura" (o Vendor_Invoice_No) con algo escrito → FACTURADO.
  const metodo = useMemo(() => metodoFacturado(cols), [cols]);

  const { pendientes, facturados, columnaNoEncontrada } = useMemo(() => {
    const vacio = { pendientes: [], facturados: [], columnaNoEncontrada: false };
    if (!pedidos?.headers?.length || !pedidos?.rows?.length) return vacio;
    if (!metodo) return { ...vacio, columnaNoEncontrada: true };
    if (!proveedoresNormalizados.size) return vacio;
    const vistos = new Set();
    const lista = [];
    const ya = [];
    for (const fila of pedidos.rows) {
      const numero = String(fila[cols.numero] || "").trim();
      if (!numero || vistos.has(numero)) continue;
      const proveedor = cols.proveedor ? fila[cols.proveedor] : null;
      if (!proveedoresNormalizados.has(normalizarProveedor(proveedor))) continue;
      vistos.add(numero);
      const item = {
        pedido: numero,
        proveedor,
        fecha: cols.fecha ? fila[cols.fecha] : null,
        estado: cols.estado ? fila[cols.estado] : null,
        importe: cols.importe ? fila[cols.importe] : null,
      };
      if (filaYaFacturada(fila, cols, metodo)) ya.push(item);
      else lista.push(item);
    }
    lista.sort((a, b) => a.pedido.localeCompare(b.pedido));
    ya.sort((a, b) => a.pedido.localeCompare(b.pedido));
    return { pendientes: lista, facturados: ya, columnaNoEncontrada: false };
  }, [pedidos, cols, metodo, proveedoresNormalizados]);

  const pendientesFiltrados = useMemo(() => {
    const q = normalizarProveedor(busquedaPedido);
    const base = verFacturados ? facturados : pendientes;
    if (!q) return base;
    return base.filter((p) => normalizarProveedor(p.pedido).includes(q));
  }, [pendientes, facturados, verFacturados, busquedaPedido]);

  // Modo "elegir pedido a mano" (Maria, 2026-09-04): cuando el pedido
  // que ha leído la IA del PDF no se encuentra en BC, el proveedor real
  // tampoco se conoce (justo porque BC no ha podido confirmarlo), así
  // que aquí NO se filtra por proveedor — se busca por texto (nº de
  // pedido o proveedor) sobre TODOS los pedidos pendientes, limitando a
  // 200 resultados para no pintar miles de filas.
  const todosParaElegir = useMemo(() => {
    if (!modoSeleccion || !metodo || !pedidos?.headers?.length || !pedidos?.rows?.length) return [];
    const q = normalizarProveedor(busquedaSeleccion);
    if (!q) return [];
    const vistos = new Set();
    const lista = [];
    for (const fila of pedidos.rows) {
      if (filaYaFacturada(fila, cols, metodo)) continue;
      const numero = String(fila[cols.numero] || "").trim();
      if (!numero || vistos.has(numero)) continue;
      const proveedor = cols.proveedor ? fila[cols.proveedor] : null;
      const texto = normalizarProveedor(`${numero} ${proveedor || ""}`);
      if (!texto.includes(q)) continue;
      vistos.add(numero);
      lista.push({
        pedido: numero,
        proveedor,
        fecha: cols.fecha ? fila[cols.fecha] : null,
        estado: cols.estado ? fila[cols.estado] : null,
        importe: cols.importe ? fila[cols.importe] : null,
      });
      if (lista.length >= 200) break;
    }
    lista.sort((a, b) => a.pedido.localeCompare(b.pedido));
    return lista;
  }, [modoSeleccion, busquedaSeleccion, pedidos, cols, metodo]);

  const toggleLineas = async (pedido) => {
    const yaAbierto = abierto[pedido];
    setAbierto((a) => ({ ...a, [pedido]: !yaAbierto }));
    if (yaAbierto || lineasPorPedido[pedido]) return; // se cierra, o ya está en caché
    setLineasPorPedido((m) => ({ ...m, [pedido]: { cargando: true, error: null, lineas: [] } }));
    try {
      const r = await fetch("/api/facturas-compra/refrescar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setLineasPorPedido((m) => ({
        ...m,
        [pedido]: { cargando: false, error: json.bcError || null, lineas: json.lineasDisponiblesBC || [] },
      }));
    } catch (e) {
      setLineasPorPedido((m) => ({ ...m, [pedido]: { cargando: false, error: e.message || String(e), lineas: [] } }));
    }
  };

  useEffect(() => {
    if (!marcaRecarga) return;
    const nums = [...new Set([
      ...Object.keys(abierto).filter((k) => abierto[k]),
      ...Object.keys(lineasPorPedido),
    ])];
    if (!nums.length) return;
    let vivo = true;
    (async () => {
      for (const pedido of nums) {
        setLineasPorPedido((m) => ({ ...m, [pedido]: { ...(m[pedido] || {}), cargando: true, error: null, lineas: m[pedido]?.lineas || [] } }));
        try {
          const r = await fetch("/api/facturas-compra/refrescar-pedido", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido }),
          });
          const json = await r.json().catch(() => ({}));
          if (!vivo) return;
          if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
          setLineasPorPedido((m) => ({
            ...m,
            [pedido]: { cargando: false, error: json.bcError || null, lineas: json.lineasDisponiblesBC || [] },
          }));
        } catch (e) {
          if (!vivo) return;
          setLineasPorPedido((m) => ({ ...m, [pedido]: { cargando: false, error: e.message || String(e), lineas: m[pedido]?.lineas || [] } }));
        }
      }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marcaRecarga]);

  if (!pedidos?.headers?.length) {
    return (
      <div className="mt-8 pt-6 border-t border-slate-200">
        <h2 className="text-lg font-bold text-slate-800">Pedidos de compra pendientes de facturar</h2>
        <p className="text-sm text-slate-400 mt-1">
          Carga primero los pedidos de compra (pantalla de carga de datos) para ver aquí los pendientes de facturar.
        </p>
      </div>
    );
  }

  const numColumnas = 4 + (cols.estado ? 1 : 0) + (cols.importe ? 1 : 0); // desplegable + Pedido + Proveedor + Fecha (+ Estado) (+ Importe)

  const tituloLista = verFacturados ? "Pedidos ya facturados" : "Pedidos pendientes de facturar";
  const totalLista = verFacturados ? facturados.length : pendientes.length;
  return (
    <div className={compacto ? "mt-3 border-t border-slate-200 pt-2" : "mt-8 pt-6 border-t border-slate-200"}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className={compacto ? "text-[13px] font-semibold text-slate-800" : "text-lg font-bold text-slate-800"}>{tituloLista}</h2>
          {!compacto && (
            <p className="text-slate-500 text-sm mt-1">
              {proveedoresNormalizados.size
                ? `Pedidos de ${(proveedores || []).filter(Boolean).join(", ")} pendientes de facturar en BC, haya llegado ya esta factura o no.`
                : "Sube una factura arriba para ver aquí los pedidos pendientes de facturar de ese mismo proveedor."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!columnaNoEncontrada && totalLista > 0 && (
            <div className="text-[12px] font-semibold text-slate-700">
              {busquedaPedido.trim() ? `${pendientesFiltrados.length} de ${totalLista}` : totalLista}
            </div>
          )}
          <button
            type="button"
            onClick={() => setVerFacturados((v) => !v)}
            className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded px-2 py-1"
          >
            {verFacturados ? "Ver pendientes" : "Ya facturados"}
          </button>
        </div>
      </div>

      {/* Buscador de pedidos (Maria, 2026-09-04): con proveedores con
          muchos pedidos pendientes (p. ej. 1860 de Saltoki), poder
          buscar por nº de pedido dentro de esa lista ya filtrada por
          proveedor, sin tener que desplazarse a mano por todos. */}
      {!columnaNoEncontrada && totalLista > 0 && (
        <div className="mt-3 relative max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={busquedaPedido}
            onChange={(e) => setBusquedaPedido(e.target.value)}
            placeholder="Buscar por nº de pedido…"
            className="w-full border border-slate-300 rounded px-2 py-1.5 pl-8 text-sm"
          />
        </div>
      )}

      {/* Elegir pedido a mano (Maria, 2026-09-04): cuando el pedido que
          ha leído la IA del PDF no aparece en BC, el proveedor tampoco
          se conoce con certeza, así que aquí se busca por texto entre
          TODOS los pedidos pendientes en vez de depender del filtro de
          proveedor de arriba — para poder asociar la factura al pedido
          correcto sin tener que adivinar el número exacto. */}
      {modoSeleccion && (
        <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-semibold text-blue-800">
              Eligiendo pedido para esta factura — busca por nº de pedido o proveedor:
            </div>
            <button onClick={onCancelarSeleccion} className="text-xs text-blue-600 hover:text-blue-800 underline shrink-0">
              Cancelar
            </button>
          </div>
          <input
            autoFocus
            value={busquedaSeleccion}
            onChange={(e) => setBusquedaSeleccion(e.target.value)}
            placeholder="Ej: METALCO, o 5.064.839…"
            className="mt-2 w-full border border-blue-300 rounded px-2 py-1.5 text-sm bg-white"
          />
          {!busquedaSeleccion && (
            <div className="mt-2 text-xs text-blue-700">Escribe para buscar entre todos los pedidos de compra pendientes.</div>
          )}
          {!!busquedaSeleccion && !todosParaElegir.length && (
            <div className="mt-2 text-xs text-blue-700">Ningún pedido pendiente coincide con "{busquedaSeleccion}".</div>
          )}
          {!!todosParaElegir.length && (
            <div className="mt-2 border border-blue-100 rounded-lg overflow-x-auto bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 bg-slate-50">
                    <th className="text-left font-normal py-2 px-3">Pedido</th>
                    <th className="text-left font-normal py-2 px-3">Proveedor</th>
                    <th className="text-left font-normal py-2 px-3">Fecha</th>
                    {cols.importe && <th className="text-right font-normal py-2 px-3">Importe</th>}
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {todosParaElegir.map((p) => (
                    <tr key={p.pedido} className="border-t border-slate-100">
                      <td className="py-1.5 px-3 font-semibold text-slate-800">{p.pedido}</td>
                      <td className="py-1.5 px-3">{p.proveedor || "—"}</td>
                      <td className="py-1.5 px-3">{p.fecha || "—"}</td>
                      {cols.importe && <td className="py-1.5 px-3 text-right">{fmtEur(p.importe)}</td>}
                      <td className="py-1.5 px-3 text-right">
                        <button
                          onClick={() => onElegirPedido(p.pedido)}
                          className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
                        >
                          Usar este pedido
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {todosParaElegir.length >= 200 && (
                <div className="px-3 py-1.5 text-[11px] text-slate-400">
                  Mostrando los primeros 200 resultados — afina la búsqueda si no está aquí.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Transparencia: qué columna se está usando de verdad para decidir
          "facturado"/"pendiente", y acceso siempre visible (no solo si
          falla) a TODAS las columnas que trae el pedido cargado — para
          que Maria pueda comprobar en cualquier momento qué datos hay
          disponibles, sin depender de que la detección automática acierte. */}
      <button
        onClick={() => setVerColumnas((v) => !v)}
        className="mt-2 text-xs text-slate-400 hover:text-slate-600 underline"
      >
        {verColumnas ? "Ocultar" : "Ver"} qué columna estoy usando y qué otras columnas hay disponibles
      </button>
      {verColumnas && (
        <div className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
          <div>
            Método usado para "¿facturado?":{" "}
            {metodo === "cantidades" && (
              <span className="font-semibold text-slate-800">
                por cantidades — "{cols.qtyToInvoice}" = 0 y "{cols.quantityInvoiced}" ≥ "{cols.cantidad}"
              </span>
            )}
            {metodo === "texto" && (
              <span className="font-semibold text-slate-800">por texto — "{cols.vendorInvoiceNo}" con algo escrito</span>
            )}
            {!metodo && <span className="text-amber-700">ninguno disponible</span>}
          </div>
          <div className="mt-2">
            Columna de importe:{" "}
            {cols.importe ? (
              <span className="font-semibold text-slate-800">"{cols.importe}"</span>
            ) : (
              <span className="text-amber-700">ninguna encontrada — no se muestra la columna Importe</span>
            )}
          </div>
          <div className="mt-2">
            Filtro de proveedor activo:{" "}
            {proveedoresNormalizados.size ? (
              <span className="font-semibold text-slate-800">{(proveedores || []).filter(Boolean).join(", ")}</span>
            ) : (
              <span className="text-amber-700">ninguno (sube una factura arriba)</span>
            )}
          </div>
          <div className="mt-2">
            Todas las columnas que trae cada pedido ya cargado ({(pedidos.headers || []).length}) — es la CABECERA
            del pedido, una fila por pedido, sin columnas de línea (descripción/cantidad):
          </div>
          <div className="mt-1 text-slate-500">{(pedidos.headers || []).join(", ")}</div>
        </div>
      )}

      {columnaNoEncontrada && (
        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          No encuentro, entre las columnas de los pedidos de compra ya cargados, ninguna que encaje con "¿facturado?"
          (ni las de cantidad, ni la de texto).
          <div className="mt-2 text-xs text-amber-700">
            Columnas disponibles: {(pedidos.headers || []).join(", ")}
          </div>
          <div className="mt-2 text-xs text-amber-700">
            Dime el nombre exacto de la columna en tu Pedido_compra_Excel y lo ajusto.
          </div>
        </div>
      )}

      {!columnaNoEncontrada && !proveedoresNormalizados.size && (
        <div className="mt-3 text-sm text-slate-400">Sube una factura para ver aquí los pedidos pendientes de su proveedor.</div>
      )}

      {!columnaNoEncontrada && !!proveedoresNormalizados.size && !totalLista && (
        <div className="mt-3 text-sm text-slate-400">{verFacturados ? "No hay pedidos ya facturados de este proveedor." : "No hay pedidos pendientes de facturar de este proveedor."}</div>
      )}

      {!columnaNoEncontrada && totalLista > 0 && !pendientesFiltrados.length && (
        <div className="mt-3 text-sm text-slate-400">Ningún pedido pendiente coincide con "{busquedaPedido}".</div>
      )}

      {!columnaNoEncontrada && !!pendientesFiltrados.length && (
        <div className="mt-3 border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 bg-slate-50">
                <th className="w-6"></th>
                <th className="text-left font-normal py-2 px-3">Pedido</th>
                <th className="text-left font-normal py-2 px-3">Proveedor</th>
                <th className="text-left font-normal py-2 px-3">Fecha</th>
                {cols.estado && <th className="text-left font-normal py-2 px-3">Estado</th>}
                {cols.importe && <th className="text-right font-normal py-2 px-3">Importe</th>}
              </tr>
            </thead>
            <tbody>
              {pendientesFiltrados.map((p) => {
                const estaAbierto = !!abierto[p.pedido];
                const infoLineas = lineasPorPedido[p.pedido];
                const incluido = (pedidosIncluidos || []).some((n) => mismoPedidoFactura(n, p.pedido) || String(n).toUpperCase() === String(p.pedido).toUpperCase());
                return (
                  <React.Fragment key={p.pedido}>
                    <tr className={`border-t border-slate-100 ${incluido ? "bg-emerald-50" : ""}`}>
                      <td className="pl-3">
                        <button
                          onClick={() => toggleLineas(p.pedido)}
                          className="text-slate-400 hover:text-slate-600"
                          title="Ver líneas del pedido"
                        >
                          {estaAbierto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="py-1.5 px-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-slate-800">{p.pedido}</span>
                          {verFacturados ? (
                            <span className="text-[11px] font-bold text-amber-950 bg-amber-100 border border-amber-400 rounded px-2 py-0.5">
                              ESTE PEDIDO ya se encuentra facturado
                            </span>
                          ) : typeof onIncluirPedido === "function" && (
                            incluido ? (
                              <span className="text-xs font-semibold text-emerald-800 bg-white border border-emerald-400 rounded px-2.5 py-1">Incluido</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onIncluirPedido(p.pedido, p.proveedor)}
                                className="text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded px-2.5 py-1"
                              >
                                Incluir en la factura
                              </button>
                            )
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 px-3">{p.proveedor || "—"}</td>
                      <td className="py-1.5 px-3">{p.fecha || "—"}</td>
                      {cols.estado && <td className="py-1.5 px-3">{p.estado || "—"}</td>}
                      {cols.importe && <td className="py-1.5 px-3 text-right">{fmtEur(p.importe)}</td>}
                    </tr>
                    {estaAbierto && (
                      <tr className="border-t border-slate-50 bg-slate-50/50">
                        <td colSpan={numColumnas} className="px-3 py-2">
                          {infoLineas?.cargando && (
                            <div className="flex items-center gap-2 text-slate-400">
                              <Loader2 size={13} className="animate-spin" /> Consultando las líneas en BC…
                            </div>
                          )}
                          {infoLineas?.error && <div className="text-red-600">{infoLineas.error}</div>}
                          {!infoLineas?.cargando && !infoLineas?.error && (
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-slate-400">
                                  <th className="text-left font-normal py-1">Código</th>
                                  <th className="text-left font-normal py-1">Descripción</th>
                                  <th className="text-right font-normal py-1">Pedido</th>
                                  <th className="text-right font-normal py-1">Recibido</th>
                                  <th className="text-right font-normal py-1">Precio</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(infoLineas?.lineas || []).map((l, i) => (
                                  <tr key={l.id || i} className="border-t border-slate-100">
                                    <td className="py-1">{l.codigo || "—"}</td>
                                    <td className="py-1">{l.descripcion || "—"}</td>
                                    <td className="py-1 text-right">{l.cantidadPedida ?? "—"}</td>
                                    <td className="py-1 text-right">{l.cantidadRecibida ?? "—"}</td>
                                    <td className="py-1 text-right">{l.precioBC === null || l.precioBC === undefined ? "—" : fmtEur(l.precioBC)}</td>
                                  </tr>
                                ))}
                                {!(infoLineas?.lineas || []).length && (
                                  <tr>
                                    <td colSpan={5} className="py-1 text-slate-400">
                                      Sin líneas en BC para este pedido.
                                    </td>
                                  </tr>
                                )}
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
    </div>
  );
}

/**
 * RegistroFacturas — panel con el histórico de TODAS las facturas de
 * proveedor subidas por "Validación de facturas" (Maria, 2026-09-04):
 * proveedor, nº de factura e incidencia con la que se validó, aunque se
 * recargue la página o pase el tiempo — antes esto no quedaba guardado
 * en ningún sitio ("sin persistencia" era justo un pendiente apuntado
 * en el proyecto). Se guarda en el backend (`backend/data/
 * registro_facturas_compra.json`, mismo patrón que estado.json/
 * recepcion.json) cada vez que se sube un PDF, y se actualiza si esa
 * factura se llega a entrar en BC (incluido si se ha forzado, v8).
 */
function RegistroFacturas({ abierto, onCerrar }) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [registro, setRegistro] = useState([]);
  const [busqueda, setBusqueda] = useState("");

  const cargar = async () => {
    setCargando(true);
    setError(null);
    try {
      const r = await fetch("/api/facturas-compra/registro");
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setRegistro(json.registro || []);
    } catch (err) {
      setError(err.message || String(err));
    }
    setCargando(false);
  };

  useEffect(() => {
    if (abierto) cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto]);

  const filtrado = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return registro;
    return registro.filter((r) => {
      const texto = `${r.factura || ""} ${(r.proveedores || []).join(" ")} ${(r.pedidos || []).join(" ")} ${r.incidencia || ""}`.toLowerCase();
      return texto.includes(q);
    });
  }, [registro, busqueda]);

  if (!abierto) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 overflow-y-auto" onClick={onCerrar}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-5xl mt-8 mb-8 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Registro de facturas subidas</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Todas las facturas de proveedor validadas por esta pantalla, más recientes primero.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={cargar}
              disabled={cargando}
              title="Recargar"
              className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
            >
              <RefreshCw size={13} className={cargando ? "animate-spin" : ""} /> Recargar
            </button>
            <button onClick={onCerrar} className="text-slate-400 hover:text-slate-600">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-slate-100">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por proveedor, nº de factura o pedido…"
              className="w-full border border-slate-300 rounded px-2 py-1.5 pl-8 text-sm"
            />
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {error && <div className="p-4 text-sm text-red-600">Error cargando el registro: {error}</div>}
          {cargando && !registro.length && (
            <div className="p-4 flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 size={14} className="animate-spin" /> Cargando…
            </div>
          )}
          {!cargando && !error && !registro.length && (
            <div className="p-4 text-sm text-slate-400">
              Todavía no hay ninguna factura subida — en cuanto subas la primera, aparecerá aquí.
            </div>
          )}
          {!!filtrado.length && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-slate-400">
                  <th className="text-left font-normal py-2 px-3">Subida</th>
                  <th className="text-left font-normal py-2 px-3">Proveedor</th>
                  <th className="text-left font-normal py-2 px-3">Nº factura</th>
                  <th className="text-left font-normal py-2 px-3">Incidencia</th>
                  <th className="text-left font-normal py-2 px-3">Entrada en BC</th>
                </tr>
              </thead>
              <tbody>
                {filtrado.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 px-3 whitespace-nowrap text-slate-500">
                      {r.fechaRegistro ? new Date(r.fechaRegistro).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </td>
                    <td className="py-1.5 px-3">{(r.proveedores || []).join(", ") || "—"}</td>
                    <td className="py-1.5 px-3 font-semibold text-slate-800">{r.factura || "—"}</td>
                    <td className={`py-1.5 px-3 ${r.veredicto === "ok" ? "text-emerald-700" : "text-red-700"}`}>
                      {r.incidencia}
                    </td>
                    <td className="py-1.5 px-3">
                      {!r.entradaBC && <span className="text-slate-400">—</span>}
                      {r.entradaBC && r.entradaBC.ok && (
                        <span className="text-emerald-700 font-medium">
                          ✓ Entrada{r.entradaBC.forzado ? " (forzada)" : ""}
                        </span>
                      )}
                      {r.entradaBC && !r.entradaBC.ok && <span className="text-red-700 font-medium">✗ Con errores</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!registro.length && !filtrado.length && (
            <div className="p-4 text-sm text-slate-400">Ninguna coincide con "{busqueda}".</div>
          )}
        </div>
      </div>
    </div>
  );
}

function itemsEnVentana(items, dias) {
  const corte = new Date();
  corte.setHours(0, 0, 0, 0);
  corte.setDate(corte.getDate() - (Math.max(1, dias) - 1));
  return (items || []).filter((it) => {
    const t = new Date(it.fecha);
    return !Number.isNaN(t.getTime()) && t >= corte;
  });
}

/** YYYY-MM a partir de la fecha de emisión leída del PDF. */
function claveMesEmision(fecha) {
  const m = String(fecha || "").match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Últimos N meses para el desplegable Emisión (mes actual primero). */
function opcionesMesEmision(n = 12) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const clave = `${y}-${String(m).padStart(2, "0")}`;
    const etiqueta = d.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    out.push({ clave, etiqueta: etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1) });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/** Días de correo a cubrir desde el día 1 del mes YYYY-MM hasta hoy. */
function diasParaMesEmision(ym) {
  const m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return 7;
  const inicio = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  inicio.setHours(0, 0, 0, 0);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((hoy - inicio) / 86400000) + 1);
}

function facturasDeFila(facturas, it) {
  return (facturas || []).filter((f) => f.origen?.msg === it.msg && String(f.origen?.att ?? "") === String(it.att ?? ""));
}

function descripcionEsSoloPedido(texto, pedido) {
  const t = String(texto || "").replace(/[\s.\-]/g, "").toUpperCase();
  const p = String(pedido || "").replace(/[\s.\-]/g, "").toUpperCase();
  return !!p && t === p;
}

function pendientesRecibirDe(f) {
  const out = [];
  for (const p of f.pedidosDetalle || []) {
    for (const l of p.lineas || []) {
      if (!l.pendienteRecepcion) continue;
      const facturado = Number(l.cantidadFacturada) || 0;
      const recibido = Number(l.lineaBC?.cantidadRecibida) || 0;
      out.push({
        pedido: p.pedido,
        desc: l.lineaBC?.descripcion || l.descripcionFactura || "",
        facturado,
        recibido,
        falta: Math.max(0, facturado - recibido),
      });
    }
  }
  return out;
}

function textoIncidencia(f, motivos) {
  const porPedido = new Map();
  const anotar = (pedido, razon) => {
    const pc = String(pedido || "").trim() || "Sin pedido";
    if (!porPedido.has(pc)) porPedido.set(pc, new Set());
    if (razon) porPedido.get(pc).add(razon);
  };
  for (const p of f?.pedidosDetalle || []) {
    if (p.bcError) anotar(p.pedido, "pedido no encontrado");
    let alguna = false;
    for (const l of p.lineas || []) {
      if (descripcionEsSoloPedido(l.descripcionFactura, p.pedido)) continue;
      if (l.pendienteRecepcion) { anotar(p.pedido, "pendiente de recibir"); alguna = true; }
      if (l.diferenciaPrecio) { anotar(p.pedido, "precio distinto"); alguna = true; }
      if ((l.coincidencia === "sin_match" || !l.lineaBC) && !l.pendienteRecepcion && !l.diferenciaPrecio) {
        anotar(p.pedido, p.pedido ? "línea sin cuadrar" : "sin pedido");
        alguna = true;
      }
    }
    if (!alguna && !p.pedido) anotar("", "sin pedido");
  }
  if (porPedido.size) {
    return [...porPedido.entries()].map(([pc, razones]) => (
      razones.size ? `${pc} · ${[...razones].join(" · ")}` : pc
    )).join(" · ");
  }
  const pcs = new Set();
  const razones = new Set();
  for (const m of motivos || f?.motivos || []) {
    for (const n of String(m).match(/PC\d{2}-\d+/gi) || []) pcs.add(n.toUpperCase());
    if (/pendiente de recibir|falta recibir/i.test(m)) razones.add("pendiente de recibir");
    else if (/precio/i.test(m)) razones.add("precio distinto");
    else if (/no encuentro|sin línea|sin linea/i.test(m)) razones.add("línea sin cuadrar");
    else if (/sin pedido|no he podido identificar/i.test(m)) razones.add("sin pedido");
  }
  if (pcs.size || razones.size) {
    const pc = pcs.size ? [...pcs].join(", ") : "Sin pedido";
    return razones.size ? `${pc} · ${[...razones].join(" · ")}` : pc;
  }
  if (f?.veredicto === "ok") return "Sin incidencias";
  return "";
}

function resumenLectura(f) {
  const pedidos = [...new Set(
    [
      ...(Array.isArray(f.pedidos) ? f.pedidos : []),
      ...(f.pedidosDetalle || []).map((p) => p.pedido).filter(Boolean),
    ].map((p) => String(p).toUpperCase())
  )];
  const completa = Array.isArray(f.pedidosDetalle);
  return {
    factura: f.factura || "",
    fecha: f.fecha || "",
    proveedor: f.proveedor || (f.pedidosDetalle || []).map((p) => p.vendorName).find(Boolean) || "",
    baseImponible: f.baseImponible ?? null,
    importeTotal: f.importeTotal ?? null,
    veredicto: f.veredicto || "",
    motivos: f.motivos || [],
    pdfGuardado: !!(f.pdfBase64 || f.pdfGuardado),
    yaEntrada: !!f.yaEntrada,
    yaBorrador: !!(f.yaBorrador || f.veredicto === "ya_borrador"),
    entradaInfo: f.entradaInfo || null,
    pendientesRecibir: completa ? pendientesRecibirDe(f) : (f.pendientesRecibir || []),
    incidencia: completa ? textoIncidencia(f) : (f.incidencia || textoIncidencia(f)),
    pedidos,
  };
}

function LineaPedidoCreado({ pedido, className }) {
  if (!pedido?.numero || pedido.estado === "entrando") return null;
  return (
    <div className={className}>
      <span>{fmtFechaFactura(pedido.fecha)}</span>
      {" · "}<span className="font-semibold">Pedido {pedido.numero}</span>
      {" · Albarán "}{pedido.albaran || "—"}
      {" · "}{pedido.importe != null && pedido.importe !== "" ? fmtEur(pedido.importe) : "—"}
      {pedido.registro?.ok ? " · registrado." : " · sin registrar."}
      {pedido.enlace ? <> <a href={pedido.enlace} target="_blank" rel="noopener noreferrer" className="underline">Abrir</a></> : null}
    </div>
  );
}

function fmtFechaFactura(v) {
  if (!v) return "—";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(v);
}

function moneyFactura(v) {
  if (v === null || v === undefined || v === "") return "—";
  return fmtEur(Number(v));
}

function ivaFactura(f) {
  if (f?.importeTotal === null || f?.importeTotal === undefined || f?.importeTotal === "") return null;
  if (f?.baseImponible === null || f?.baseImponible === undefined || f?.baseImponible === "") return null;
  const n = Number(f.importeTotal) - Number(f.baseImponible);
  return Number.isFinite(n) ? n : null;
}

function estaEntrada(f) {
  return !!(f?.yaEntrada || f?.veredicto === "ya_entrada");
}

function estaBorradorBC(f) {
  return !!(f?.yaBorrador || f?.veredicto === "ya_borrador" || f?.entradaInfo?.estado === "borrador" || f?.entradaInfo?.borrador);
}

function estadoCorto(f) {
  if (!f) return { texto: "Sin leer", clase: "bg-slate-100 text-slate-600", detalle: "" };
  if (estaEntrada(f)) return { texto: "Entrada", clase: "bg-emerald-100 text-emerald-800", detalle: "" };
  if (estaBorradorBC(f)) return { texto: "Borrador BC", clase: "bg-sky-100 text-sky-800", detalle: "" };
  if (f.veredicto === "gasto") return { texto: "Gasto", clase: "bg-blue-100 text-blue-800", detalle: "" };
  if (f.veredicto === "ok") return { texto: "Lista", clase: "bg-emerald-100 text-emerald-800", detalle: "" };
  const err = String(f.incidencia || "").trim();
  return { texto: "Revisar", clase: "bg-red-100 text-red-800", detalle: err || "Hay diferencias con el pedido" };
}

function PanelCorreoFila({ it }) {
  const recibido = it?.fecha
    ? new Date(it.fecha).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
      <div><span className="text-slate-500">De </span><span className="text-slate-800">{it.deNombre || "—"}</span>{it.de ? <span className="text-slate-500"> · {it.de}</span> : null}</div>
      <div><span className="text-slate-500">Recibido </span><span className="text-slate-800">{recibido}</span></div>
      <div className="sm:col-span-2"><span className="text-slate-500">Asunto </span><span className="text-slate-800">{it.asunto || "—"}</span></div>
      <div className="sm:col-span-2"><span className="text-slate-500">Archivo </span><span className="text-slate-800">{it.nombre || "—"}</span></div>
    </div>
  );
}

function PanelNotasFila({ pedidos, notasMap, onGuardada }) {
  const [pedido, setPedido] = useState(pedidos[0] || "");
  const [texto, setTexto] = useState("");
  const [autor, setAutor] = useState(() => { try { return localStorage.getItem("recepcion_autor_v1") || ""; } catch { return ""; } });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);
  const notas = (notasMap && pedido && notasMap[pedido]) || [];

  const guardar = async () => {
    const t = texto.trim();
    if (!pedido || !t) return;
    setGuardando(true);
    setError(null);
    try {
      if (autor.trim()) localStorage.setItem("recepcion_autor_v1", autor.trim());
      const r = await fetch("/api/recepcion/nota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido, texto: t, autor: autor.trim() }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      onGuardada(pedido, json.notas || []);
      setTexto("");
    } catch (err) {
      setError(err.message || String(err));
    }
    setGuardando(false);
  };

  if (!pedidos.length) {
    return <div className="text-[12px] text-slate-500">Esta factura no tiene pedido. Las notas se guardan en el pedido de compra.</div>;
  }
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-slate-500">Pedido</span>
        {pedidos.length === 1 ? (
          <span className="font-semibold text-slate-800">{pedidos[0]}</span>
        ) : (
          <select value={pedido} onChange={(e) => setPedido(e.target.value)} className="border border-slate-300 rounded px-1 py-0.5 bg-white">
            {pedidos.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>
      {notas.length === 0 && <div className="text-slate-400 mb-1">Sin notas en este pedido.</div>}
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {notas.map((n) => (
          <div key={n.id} className="text-slate-700">
            <span className="text-slate-400">{selloCorreo(n.ts)}</span>{" "}
            <span className="font-semibold">{n.autor}:</span> {n.texto}
            {n.enlace ? <> <a href={n.enlace} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline">Abrir en Outlook</a></> : null}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input value={autor} onChange={(e) => setAutor(e.target.value)} placeholder="Tu nombre" className="border border-slate-300 rounded px-2 py-1 w-28 bg-white" />
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") guardar(); }}
          placeholder="Añadir nota… (Enter para guardar)"
          className="flex-1 border border-slate-300 rounded px-2 py-1 bg-white"
        />
        <button type="button" onClick={guardar} disabled={guardando || !texto.trim()} className="text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded px-2 py-1">
          {guardando ? "Guardando…" : "Añadir"}
        </button>
      </div>
      {error && <div className="text-red-700 mt-1">{error}</div>}
    </div>
  );
}

function BandejaFacturas({ onAbrir, onVolver, leyendoMap = {}, filaAbierta, errorFila, erroresLectura = {}, facturas = [], lecturas = {}, renderFactura, onPorLeer }) {
  const [abierta, setAbierta] = useState(true);
  const [dias, setDias] = useState(7);
  const [mesEmision, setMesEmision] = useState(null); // null = todas | "YYYY-MM"
  const [cargando, setCargando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [error, setError] = useState(null);
  const [datos, setDatos] = useState(null);
  const [verOtras, setVerOtras] = useState(false);
  const [verProcesadas, setVerProcesadas] = useState(false);
  const [vista, setVista] = useState("pendientes");
  const [busca, setBusca] = useState("");
  const mesesEmision = useMemo(() => opcionesMesEmision(12), []);
  const empresa = empresaGuardada();
  const datosRef = useRef(null);
  const arranque = useRef(false);
  const ocupadaRef = useRef(false);
  const cargarRef = useRef(async () => {});
  const cajaRef = useRef(null);
  const filaRef = useRef(null);
  const [extra, setExtra] = useState(null);
  const [notasMap, setNotasMap] = useState(null);
  const [notasCargando, setNotasCargando] = useState(false);
  const [notasFallo, setNotasFallo] = useState(null);
  const [leyendoServidor, setLeyendoServidor] = useState([]);

  useEffect(() => {
    if (!filaAbierta) return;
    filaRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [filaAbierta]);

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/facturas-compra/bandeja/leyendo");
        const j = await r.json().catch(() => ({}));
        if (!vivo || !r.ok || !Array.isArray(j.leyendo)) return;
        setLeyendoServidor(j.leyendo);
      } catch { /* la copia de la lista sigue en pantalla */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (extra?.tipo !== "notas" || notasMap) return;
    let vivo = true;
    setNotasCargando(true);
    setNotasFallo(null);
    fetch("/api/recepcion")
      .then((r) => { if (!r.ok) throw new Error("Error"); return r.json(); })
      .then((d) => { if (vivo) setNotasMap(d.notas || {}); })
      .catch(() => { if (vivo) { setNotasFallo("No se han podido cargar las notas."); setNotasMap({}); } })
      .finally(() => { if (vivo) setNotasCargando(false); });
    return () => { vivo = false; };
  }, [extra, notasMap]);

  const abrirExtra = (e, clave, tipo) => {
    e.stopPropagation();
    setExtra((prev) => (prev?.clave === clave && prev.tipo === tipo ? null : { clave, tipo }));
  };

  const pintar = (j) => {
    datosRef.current = j;
    setDatos(j);
  };

  // Primero la copia guardada (la pantalla sale al momento). Después solo
  // los correos llegados desde la última actualización. Se repite sola.
  const cargar = async ({ aviso = true } = {}) => {
    if (ocupadaRef.current) return;
    ocupadaRef.current = true;
    if (aviso) setError(null);
    let base = datosRef.current;
    try {
      if (!base?.actualizadoEn) {
        setCargando(true);
        const r = await fetch("/api/facturas-compra/bandeja?cache=1");
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
        if (j.actualizadoEn || j.items?.length) {
          base = j;
          pintar(j);
        }
      }
      if (aviso) setSincronizando(true);
      const desde = base?.actualizadoEn;
      const url = desde
        ? `/api/facturas-compra/bandeja?desde=${encodeURIComponent(desde)}`
        : `/api/facturas-compra/bandeja?dias=${dias}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      pintar(j);
    } catch (e) {
      if (aviso || !datosRef.current) setError(e.message || String(e));
    } finally {
      setCargando(false);
      setSincronizando(false);
      ocupadaRef.current = false;
    }
  };
  cargarRef.current = cargar;

  const ampliarVentana = async (d) => {
    setDias(d);
    const base = datosRef.current;
    const items = base?.items || [];
    if (!items.length || ocupadaRef.current) return;
    const corte = new Date();
    corte.setHours(0, 0, 0, 0);
    corte.setDate(corte.getDate() - (d - 1));
    const oldest = items.reduce((m, it) => (!m || String(it.fecha) < m ? String(it.fecha) : m), "");
    if (!oldest || new Date(oldest) <= corte) return;
    ocupadaRef.current = true;
    setSincronizando(true); setError(null);
    try {
      const r = await fetch(`/api/facturas-compra/bandeja?desde=${encodeURIComponent(corte.toISOString())}&hasta=${encodeURIComponent(oldest)}&dias=${d}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      pintar(j);
    } catch (e) { setError(e.message || String(e)); }
    finally {
      setSincronizando(false);
      ocupadaRef.current = false;
    }
  };

  const elegirMesEmision = async (ym) => {
    setMesEmision(ym || null);
    if (!ym) return;
    const necesarios = diasParaMesEmision(ym);
    if (necesarios > dias) await ampliarVentana(necesarios);
  };

  useEffect(() => {
    let vivo = true;
    const pintarCache = async () => {
      try {
        const r = await fetch("/api/facturas-compra/bandeja?cache=1");
        const j = await r.json().catch(() => ({}));
        if (!vivo || !r.ok) return;
        if (j.actualizadoEn || j.items?.length) pintar(j);
      } catch { /* la copia anterior sigue en pantalla */ }
    };
    pintarCache();
    const id = setInterval(pintarCache, 30000);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  const marcar = async (it, quitar = false) => {
    await fetch("/api/facturas-compra/bandeja/procesada", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg: it.msg, att: it.att, quitar }) }).catch(() => {});
    setDatos((d) => d && { ...d, items: d.items.map((x) => (x.msg === it.msg && x.att === it.att ? { ...x, procesada: quitar ? null : { ts: new Date().toISOString() } } : x)) });
  };

  const itemsTodos = datos?.items || [];
  const items = itemsEnVentana(itemsTodos, dias);
  const actualId = datos?.empresaActual;
  const horaActualizacion = datos?.actualizadoEn
    ? new Date(datos.actualizadoEn).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;
  const deEsta = items.filter((it) => it.empresaId === actualId);
  const sinAsignar = items.filter((it) => !it.empresaId);
  const deOtras = items.filter((it) => it.empresaId && it.empresaId !== actualId);
  const clasificarEntrada = (it) => {
    if (it.entrada) return "si";
    const clave = `${it.msg}|${it.att}`;
    const deFila = facturasDeFila(facturas, it);
    const leidas = (deFila.length ? deFila : (lecturas[clave] || [])).map(resumenLectura);
    if (!leidas.length) return "sin";
    const n = leidas.filter(estaEntrada).length;
    if (n === 0) return "no";
    if (n === leidas.length) return "si";
    return "mixta";
  };
  const leidasDe = (it) => {
    const clave = `${it.msg}|${it.att}`;
    const deFila = facturasDeFila(facturas, it);
    return (deFila.length ? deFila : (lecturas[clave] || [])).map(resumenLectura);
  };
  const qBusca = busca.trim().toLowerCase();
  const coincideBusca = (it) => {
    if (!qBusca) return true;
    const blob = [it.asunto, it.de, it.deNombre, it.nombre, ...leidasDe(it).flatMap((f) => [f.factura, f.proveedor])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return blob.includes(qBusca);
  };
  // Con mes de emisión: se quedan las que ya tienen ese mes y las aún sin leer
  // (la cola las lee poco a poco; al salir la fecha entran o salen solas).
  const coincideMesEmision = (it) => {
    if (!mesEmision) return true;
    const leidas = leidasDe(it);
    if (!leidas.length) return true;
    return leidas.some((f) => claveMesEmision(f.fecha) === mesEmision);
  };
  const esPendiente = (it) => {
    const c = clasificarEntrada(it);
    return c === "sin" || c === "no" || c === "mixta";
  };
  const esEntrada = (it) => {
    const c = clasificarEntrada(it);
    return c === "si" || c === "mixta";
  };
  const candidatos = [...deEsta, ...sinAsignar, ...(verOtras ? deOtras : [])]
    .filter((it) => verProcesadas || !it.procesada);
  const nPend = candidatos.filter(esPendiente).length;
  const nEnt = candidatos.filter(esEntrada).length;
  const visibles = candidatos
    .filter((it) => (vista === "todas" ? true : vista === "entradas" ? esEntrada(it) : esPendiente(it)))
    .filter(coincideBusca)
    .filter(coincideMesEmision)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const diasOpciones = [1, 3, 7, 15, 30, 60].includes(dias)
    ? [1, 3, 7, 15, 30, 60]
    : [...[1, 3, 7, 15, 30, 60], dias].sort((a, b) => a - b);
  const nPorLeer = [...deEsta, ...sinAsignar].filter((it) => !it.procesada && !it.entrada && clasificarEntrada(it) === "sin" && !erroresLectura[`${it.msg}|${it.att}`]).length;
  const leyendoVista = { ...leyendoMap };
  for (const it of leyendoServidor) {
    if (!it?.msg) continue;
    const clave = `${it.msg}|${it.att ?? ""}`;
    if (!leyendoVista[clave]) leyendoVista[clave] = `Leyendo ${it.nombre || "factura"}`;
  }
  const leyendoTxt = Object.values(leyendoVista)[0] || "";
  const pill = (id) => `rounded-full px-2.5 py-0.5 font-semibold border ${vista === id ? "bg-purple-600 text-white border-purple-600" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`;

  const porLeer = useMemo(() => (
    [...deEsta, ...sinAsignar]
      .filter((it) => !it.procesada && !it.entrada && clasificarEntrada(it) === "sin" && !erroresLectura[`${it.msg}|${it.att}`])
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
  ), [datos, dias, facturas, lecturas, erroresLectura, verOtras]);
  useEffect(() => { onPorLeer?.(porLeer); }, [porLeer, onPorLeer]);
  const docAbierto = visibles.find((it) => `${it.msg}|${it.att}` === filaAbierta) || null;
  const docClave = docAbierto ? `${docAbierto.msg}|${docAbierto.att}` : "";
  const docFila = docAbierto ? facturasDeFila(facturas, docAbierto) : [];
  const docError = docAbierto ? (erroresLectura[docClave] || (errorFila?.clave === docClave ? errorFila.texto : null)) : null;
  const claveLeyendo = Object.keys(leyendoVista)[0] || "";
  const itLeyendo = !docAbierto && claveLeyendo
    ? (visibles.find((it) => `${it.msg}|${it.att}` === claveLeyendo) || itemsTodos.find((it) => `${it.msg}|${it.att}` === claveLeyendo) || null)
    : null;
  const sepLeyendo = !docAbierto && !itLeyendo ? claveLeyendo.indexOf("|") : -1;
  const origenPdf = docAbierto
    ? { msg: docAbierto.msg, att: docAbierto.att || "" }
    : itLeyendo
      ? { msg: itLeyendo.msg, att: itLeyendo.att || "" }
      : sepLeyendo > 0
        ? { msg: claveLeyendo.slice(0, sepLeyendo), att: claveLeyendo.slice(sepLeyendo + 1) }
        : null;
  const pdfDoc = origenPdf?.msg
    ? `/api/facturas-compra/bandeja/archivo.pdf?msg=${encodeURIComponent(origenPdf.msg)}&att=${encodeURIComponent(origenPdf.att || "")}`
    : "";

  return (
    <div ref={cajaRef} className="mt-4 bg-white border border-slate-200 rounded-lg">
      <button onClick={() => setAbierta((v) => !v)} className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-slate-700">
        <span className="flex items-center gap-2"><Inbox size={16} className="text-purple-600" /> Bandeja de facturas · {datos?.buzon || "facturacio@alsocasals.com"}
          {datos && <span className="text-[11px] font-normal text-slate-500">· {nPend} por entrar</span>}
        </span>
        <span className="text-[11px] text-slate-400">{abierta ? "ocultar ▲" : "mostrar ▼"}</span>
      </button>
      {abierta && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(440px,48%)_1fr] xl:h-[calc(100vh-132px)]">
          <div className="flex flex-col min-h-0 border-slate-200 xl:border-r">
          {!docAbierto && <>
          <div className="px-3 py-2 flex flex-wrap items-center gap-2 text-[12px] border-b border-slate-100">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Proveedor, nº de factura o asunto"
                className="border border-slate-300 rounded pl-7 pr-2 py-1 w-64 max-w-full"
              />
            </div>
            <button type="button" onClick={() => setVista("pendientes")} className={pill("pendientes")}>Pendientes {nPend}</button>
            <button type="button" onClick={() => setVista("entradas")} className={pill("entradas")}>Entradas {nEnt}</button>
            <button type="button" onClick={() => setVista("todas")} className={pill("todas")}>Todas</button>
            <button
              type="button"
              onClick={() => setVerOtras((v) => !v)}
              className={`rounded-full px-2.5 py-0.5 font-semibold border ${verOtras ? "bg-slate-700 text-white border-slate-700" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
            >
              Otras empresas {deOtras.length}
            </button>
            <label className="flex items-center gap-1 text-slate-500">Últimos
              <select value={dias} onChange={(e) => ampliarVentana(Number(e.target.value))} className="border border-slate-300 rounded px-1 py-0.5 bg-white">
                {diasOpciones.map((d) => <option key={d} value={d}>{d} día{d > 1 ? "s" : ""}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1 text-slate-500">Emisión
              <select value={mesEmision || ""} onChange={(e) => elegirMesEmision(e.target.value || null)} className="border border-slate-300 rounded px-1 py-0.5 bg-white">
                <option value="">Todas</option>
                {mesesEmision.map((m) => <option key={m.clave} value={m.clave}>{m.etiqueta}</option>)}
              </select>
            </label>
            <button onClick={() => cargar()} disabled={sincronizando} className="flex items-center gap-1 text-purple-700 hover:underline disabled:opacity-50">
              <RefreshCw size={12} className={sincronizando ? "animate-spin" : ""} /> {sincronizando ? "Buscando nuevos…" : "Buscar nuevos"}
            </button>
            <button type="button" onClick={() => setVerProcesadas((v) => !v)} className={`hover:underline ${verProcesadas ? "text-purple-700 font-semibold" : "text-slate-400"}`}>
              {verProcesadas ? "Ocultar descartadas" : "Ver descartadas"}
            </button>
            <span className="text-slate-400">La lista se actualiza sola. Pulsa una fila para abrirla.</span>
          </div>
          {error && <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{error}</div>}
          {cargando && !datos && <div className="text-[12px] text-slate-400">Leyendo el buzón por primera vez…</div>}
          {sincronizando && datos && <div className="text-[12px] text-purple-700 mb-1">Buscando correos nuevos{horaActualizacion ? ` desde las ${horaActualizacion}` : ""}… La lista guardada sigue visible.</div>}
          {(nPorLeer > 0 || leyendoTxt) && (
            <div className="text-[12px] text-purple-700 mb-1">
              {leyendoTxt ? `${leyendoTxt}. ` : ""}
              {nPorLeer > 0 ? `${nPorLeer} por comprobar. Las nuevas se añaden solas y, si ya está entrada, sale de Pendientes.` : "Las nuevas se añaden solas y, si ya está entrada, sale de Pendientes."}
            </div>
          )}
          {datos && visibles.length === 0 && (
            <div className="text-[12px] text-slate-400">
              {qBusca
                ? "Ninguna factura coincide con la búsqueda."
                : mesEmision
                  ? (nPorLeer > 0
                    ? `Ninguna factura leída de ese mes todavía. Quedan ${nPorLeer} por leer; irán apareciendo solas.`
                    : "Ninguna factura con fecha de emisión de ese mes en este periodo.")
                  : vista === "entradas"
                    ? "Ninguna factura entrada en este periodo."
                    : vista === "todas"
                      ? "No hay facturas en este periodo."
                      : `No hay facturas pendientes de ${empresa?.displayName || "esta empresa"} en este periodo.`}
            </div>
          )}
          {visibles.length > 0 && (
            <div className="text-[12px] divide-y divide-slate-100 overflow-auto min-h-[140px] xl:flex-1 xl:min-h-0">
              {visibles.map((it) => {
                const otra = it.empresaId && it.empresaId !== actualId;
                const clave = `${it.msg}|${it.att}`;
                const leyendoEsta = leyendoVista[clave];
                const estaAbierta = filaAbierta === clave;
                const deFila = facturasDeFila(facturas, it);
                const errorEsta = erroresLectura[clave] || (errorFila?.clave === clave ? errorFila.texto : null);
                const panel = estaAbierta && (deFila.length > 0 || errorEsta);
                const leidas = leidasDe(it);
                const leidasFiltro = vista === "entradas"
                  ? leidas.filter(estaEntrada)
                  : vista === "pendientes"
                    ? leidas.filter((f) => !estaEntrada(f))
                    : leidas;
                const tieneLectura = leidasFiltro.length > 0;
                const lineas = leidasFiltro.length ? leidasFiltro : (leidas.length ? [] : [null]);
                const pedidosNotas = [...new Set(leidas.flatMap((f) => f.pedidos || []))];
                const cuentaNotas = notasMap ? pedidosNotas.reduce((n, p) => n + ((notasMap[p] || []).length), 0) : 0;
                const extraEsta = extra?.clave === clave ? extra.tipo : null;
                const btnExtra = (activo) => `inline-flex items-center gap-1 text-[11px] font-semibold rounded px-2 py-1 border disabled:opacity-40 ${activo ? "bg-purple-600 text-white border-purple-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`;
                const abrir = () => { if (!otra && !it.procesada) onAbrir?.(it); };
                const marca = estaAbierta || leyendoEsta ? "border-l-4 border-purple-500 pl-2" : "";
                return (
                  <div key={clave} className={`${it.procesada ? "opacity-60" : ""} ${estaAbierta ? "bg-sky-100" : leyendoEsta ? "bg-purple-50" : "hover:bg-slate-50"}`}>
                    <div className="flex items-start gap-2 py-1.5">
                      <div className={`flex-1 min-w-0 ${marca}`}>
                        {lineas.map((f, idx) => {
                          if (!f) {
                            return (
                              <div key={`${clave}-sin`} onClick={abrir} className={otra || it.procesada ? "" : "cursor-pointer"}>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                  <span className={`inline-flex text-[11px] font-semibold rounded px-1.5 py-0.5 ${it.entrada ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{it.entrada ? "Entrada" : "Sin leer"}</span>
                                  <span className="text-slate-500 whitespace-nowrap">{new Date(it.fecha).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                                  <span className="truncate max-w-[220px]" title={it.de}>{it.deNombre || it.de}</span>
                                  <span className="min-w-0 truncate" title={it.asunto}>{it.asunto}</span>
                                  <span className="text-[10px] text-slate-400 truncate max-w-[180px]">{it.nombre}</span>
                                  {it.empresaId ? (
                                    <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${otra ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-800"}`}>{it.empresaNombre}</span>
                                  ) : (
                                    <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-800" title={it.sinTexto ? "PDF escaneado: no se puede leer el CIF automáticamente" : "No aparece ningún CIF de las empresas"}>
                                      {it.variosCif ? `Varios CIF · revisar` : it.sinTexto ? "Escaneado · revisar CIF" : "CIF no encontrado"}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          const estado = estadoCorto(f);
                          return (
                            <div key={`${clave}-${idx}-${f.factura || "fac"}`} onClick={abrir} className={`py-0.5 ${otra || it.procesada ? "" : "cursor-pointer"}`}>
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                <span className={`inline-flex text-[11px] font-semibold rounded px-1.5 py-0.5 ${estado.clase}`}>{estado.texto}</span>
                                <span className="whitespace-nowrap text-slate-700">{fmtFechaFactura(f.fecha)}</span>
                                <span className="font-medium text-slate-800" title={f.factura || ""}>{f.factura || "—"}</span>
                                <span className="text-slate-800 truncate max-w-[280px]" title={f.proveedor || ""}>{f.proveedor || "—"}</span>
                                <span className="ml-auto font-semibold text-slate-800 whitespace-nowrap">{moneyFactura(f.importeTotal)}</span>
                              </div>
                            </div>
                          );
                        })}
                        {leyendoEsta && (
                          <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-purple-800">
                            <Loader2 size={12} className="animate-spin" /> {leyendoEsta} · sigue en segundo plano
                          </div>
                        )}
                        {!leyendoEsta && errorEsta && !estaAbierta && (
                          <div className="mt-0.5 text-[11px] text-red-700">No se ha podido leer: {errorEsta}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button type="button" onClick={(e) => abrirExtra(e, clave, "correo")} className={btnExtra(extraEsta === "correo")}>
                          <Mail size={12} /> Correo
                        </button>
                        <button type="button" onClick={(e) => abrirExtra(e, clave, "notas")} disabled={!tieneLectura} title={tieneLectura ? "Notas del pedido" : "Las notas aparecen cuando la factura está leída"} className={btnExtra(extraEsta === "notas")}>
                          <StickyNote size={12} /> Notas{cuentaNotas > 0 ? ` ${cuentaNotas}` : ""}
                        </button>
                        {it.procesada ? (
                          <button onClick={(e) => { e.stopPropagation(); marcar(it, true); }} className="text-[11px] text-slate-500 hover:underline" title="Volver a mostrarla">mostrar</button>
                        ) : otra ? (
                          <span className="text-[11px] text-slate-400 max-w-[120px] text-right">Cambia a {it.empresaNombre}</span>
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); marcar(it); }} className="text-[11px] text-slate-500 hover:underline" title="No mostrar esta factura">descartar</button>
                        )}
                      </div>
                    </div>
                    {extraEsta && (
                      <div className="px-3 py-2 mb-1 bg-slate-50 border-l-4 border-purple-200" onClick={(e) => e.stopPropagation()}>
                        {extraEsta === "correo" && <PanelCorreoFila it={it} />}
                        {extraEsta === "notas" && (
                          <>
                            {notasFallo && <div className="text-[12px] text-red-700 mb-1">{notasFallo}</div>}
                            {notasCargando && !notasMap ? (
                              <div className="text-[12px] text-slate-400">Cargando notas…</div>
                            ) : (
                              <PanelNotasFila
                                pedidos={pedidosNotas}
                                notasMap={notasMap || {}}
                                onGuardada={(pedido, lista) => setNotasMap((prev) => ({ ...(prev || {}), [pedido]: lista }))}
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </>}
          {docAbierto && (
          <div className="flex-1 min-h-0 overflow-auto">
            <button type="button" onClick={onVolver} className="sticky top-0 z-10 w-full text-left px-3 py-2 text-[12px] font-semibold text-sky-800 bg-white border-b border-slate-200 hover:bg-slate-50">
              ← Volver a los correos
            </button>
            {docError && !docFila.length && (
              <div className="p-3 text-[13px] text-red-700">Error leyendo el documento: {docError}</div>
            )}
            {(() => {
              const claveDoc = docAbierto ? `${docAbierto.msg}|${docAbierto.att ?? ""}` : "";
              const comprobando = !!(claveDoc && leyendoVista[claveDoc]);
              if (comprobando) {
                return (
                  <div className="p-4 text-sm text-amber-900 bg-amber-50 border-b border-amber-200 font-semibold">
                    {leyendoVista[claveDoc]}
                  </div>
                );
              }
              if (docFila.length > 0) {
                return (
                  <div className="divide-y divide-slate-100">
                    {docFila.map((f, i) => renderFactura({
                      ...f,
                      origen: {
                        ...(f.origen || {}),
                        msg: f.origen?.msg || docAbierto.msg,
                        att: f.origen?.att ?? docAbierto.att,
                        // Remitente del correo de la bandeja (Para del correo al proveedor).
                        de: f.origen?.de || docAbierto.de || "",
                        deNombre: f.origen?.deNombre || docAbierto.deNombre || "",
                      },
                    }, i, {
                      onDescartar: async () => {
                        await marcar(docAbierto);
                        onVolver?.();
                      },
                    }))}
                  </div>
                );
              }
              if (!docError) {
                return (
                  <div className="p-4 text-sm text-slate-500">Leyendo la factura. El PDF ya se puede ver a la derecha.</div>
                );
              }
              return null;
            })()}
          </div>
          )}
          </div>
          <div className="bg-slate-200 min-h-[55vh] xl:min-h-0">
            {pdfDoc ? (
              <iframe key={pdfDoc} title="Factura" src={pdfDoc} className="w-full h-full min-h-[55vh] xl:min-h-full bg-slate-200" />
            ) : (
              <div className="h-full min-h-[40vh] flex items-center justify-center text-sm text-slate-500">El PDF de la factura aparece aquí.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const ASUNTO_EXTRACTO_2026 = "Solicitud de extracto de facturación 2026 — ALSO CASALS INSTAL·LACIONS, S.L.";
const MESES_EXTRACTO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function fechaLimiteLarga(iso) {
  if (!iso) return "[fecha límite]";
  const partes = String(iso).split("-");
  const y = Number(partes[0]);
  const m = Number(partes[1]);
  const d = Number(partes[2]);
  if (!y || !m || !d || !MESES_EXTRACTO[m - 1]) return "[fecha límite]";
  return `${d} de ${MESES_EXTRACTO[m - 1]} de ${y}`;
}

function cuerpoExtractoFacturacion(fechaTexto) {
  return "Buenos días,\n\n"
    + "Con el fin de conciliar nuestra contabilidad, les agradeceríamos que nos enviaran el diario (o extracto) de facturación emitida a ALSO CASALS INSTAL·LACIONS, S.L. (CIF B43831593) correspondiente al ejercicio 2026, desde el 1 de enero hasta la fecha.\n\n"
    + "Para facilitar la comprobación, les rogamos que el listado incluya, para cada documento:\n"
    + "- Fecha de factura\n"
    + "- Número de factura\n"
    + "- Base imponible, IVA y total\n"
    + "- Abonos o rectificativas emitidos, si los hubiera\n\n"
    + `Si es posible, les agradeceríamos recibirlo en formato Excel antes del ${fechaTexto}.\n\n`
    + "Una vez lo recibamos, lo cotejaremos con nuestro diario de compras y, en caso de detectar alguna diferencia, nos pondremos en contacto con ustedes para aclararla.\n\n"
    + "Muchas gracias de antemano por su colaboración.";
}

function emailsDeTexto(texto) {
  return String(texto || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function nombresProveedorPedidos(pedidos) {
  const cols = columnasPedidos(pedidos?.headers || []);
  if (!cols.proveedor) return [];
  const vistos = new Set();
  const lista = [];
  for (const fila of pedidos?.rows || []) {
    const nombre = String(fila[cols.proveedor] || "").trim();
    const clave = nombre.toUpperCase();
    if (!nombre || vistos.has(clave)) continue;
    vistos.add(clave);
    lista.push(nombre);
  }
  lista.sort((a, b) => a.localeCompare(b, "es"));
  return lista;
}

function SolicitudExtracto({ abierto, onCerrar, pedidos, remitenteEmail }) {
  const proveedores = useMemo(() => nombresProveedorPedidos(pedidos), [pedidos]);
  const [proveedor, setProveedor] = useState("");
  const [para, setPara] = useState("");
  const [fecha, setFecha] = useState("");
  const [asuntoTocado, setAsuntoTocado] = useState(false);
  const [asuntoManual, setAsuntoManual] = useState(ASUNTO_EXTRACTO_2026);
  const [cuerpo, setCuerpo] = useState(() => cuerpoExtractoFacturacion("[fecha límite]"));
  const fechaEnCuerpo = useRef("[fecha límite]");
  const [envio, setEnvio] = useState({ estado: "idle" });

  useEffect(() => {
    if (!abierto) return;
    setProveedor("");
    setPara("");
    setFecha("");
    setAsuntoTocado(false);
    setAsuntoManual(ASUNTO_EXTRACTO_2026);
    fechaEnCuerpo.current = "[fecha límite]";
    setCuerpo(cuerpoExtractoFacturacion("[fecha límite]"));
    setEnvio({ estado: "idle" });
  }, [abierto]);

  const asunto = asuntoTocado
    ? asuntoManual
    : (proveedor.trim() ? `${ASUNTO_EXTRACTO_2026} · ${proveedor.trim()}` : ASUNTO_EXTRACTO_2026);

  const cambiarFecha = (iso) => {
    setFecha(iso);
    const nueva = fechaLimiteLarga(iso);
    const vieja = fechaEnCuerpo.current;
    setCuerpo((prev) => {
      const marca = `antes del ${vieja}.`;
      if (!prev.includes(marca)) return prev;
      fechaEnCuerpo.current = nueva;
      return prev.replace(marca, `antes del ${nueva}.`);
    });
  };

  const destinatarios = emailsDeTexto(para);
  const puedeEnviar = envio.estado !== "enviando"
    && envio.estado !== "ok"
    && proveedor.trim()
    && destinatarios.length > 0
    && fecha
    && asunto.trim()
    && !String(cuerpo).includes("[fecha límite]");

  const enviar = async () => {
    if (!puedeEnviar) return;
    setEnvio({ estado: "enviando" });
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          asunto: asunto.trim(),
          cuerpoHtml: htmlPerEnviar(cuerpo),
          incluirFirma: true,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      setEnvio({ estado: "ok", de: json.de });
    } catch (err) {
      setEnvio({ estado: "error", error: err.message || String(err) });
    }
  };

  if (!abierto) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4"
      onClick={() => { if (envio.estado !== "enviando") onCerrar(); }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">
          Solicitud de extracto de facturación 2026
        </div>
        <div className="px-4 py-3 space-y-3 text-sm">
          <div>
            <div className="text-[11px] text-slate-500">De</div>
            <div className="text-slate-800">{remitenteEmail || "Tu correo de empresa"}</div>
          </div>
          <label className="block">
            <span className="text-[11px] text-slate-500">Proveedor</span>
            <input
              value={proveedor}
              onChange={(e) => setProveedor(e.target.value)}
              list="extracto-proveedores-2026"
              placeholder="Escribe o elige el proveedor"
              disabled={envio.estado === "enviando" || envio.estado === "ok"}
              className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
            />
            <datalist id="extracto-proveedores-2026">
              {proveedores.map((nombre) => <option key={nombre} value={nombre} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">Correo del proveedor</span>
            <input
              value={para}
              onChange={(e) => setPara(e.target.value)}
              placeholder="proveedor@empresa.com"
              disabled={envio.estado === "enviando" || envio.estado === "ok"}
              className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">Fecha límite</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => cambiarFecha(e.target.value)}
              disabled={envio.estado === "enviando" || envio.estado === "ok"}
              className="mt-0.5 border border-slate-300 rounded px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">Asunto</span>
            <input
              value={asunto}
              onChange={(e) => { setAsuntoTocado(true); setAsuntoManual(e.target.value); }}
              disabled={envio.estado === "enviando" || envio.estado === "ok"}
              className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">Mensaje</span>
            <textarea
              value={cuerpo}
              onChange={(e) => setCuerpo(e.target.value)}
              rows={14}
              disabled={envio.estado === "enviando" || envio.estado === "ok"}
              className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px] leading-relaxed"
            />
          </label>
          <div className="border-t border-slate-200 pt-2">
            <div className="text-[11px] text-slate-500 mb-1">Firma (se añade al enviar, sin adjunto)</div>
            <div className="text-[12px] text-slate-700">Salutacions / Saludos / Best Regards.</div>
            <img src="/firma-correo.png" alt="Firma" className="max-w-full h-auto max-h-28 object-contain object-left" />
          </div>
          {envio.estado === "error" && <div className="text-[12px] text-red-700">{envio.error || "No se ha podido enviar."}</div>}
          {envio.estado === "ok" && (
            <div className="text-[12px] text-emerald-700">
              Enviado{envio.de ? ` desde ${envio.de}` : ""} a {destinatarios.join(", ")}.
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCerrar}
            disabled={envio.estado === "enviando"}
            className="text-sm text-slate-600 hover:text-slate-800 px-3 py-1.5 disabled:opacity-50"
          >
            {envio.estado === "ok" ? "Cerrar" : "Cancelar"}
          </button>
          {envio.estado !== "ok" && (
            <button
              type="button"
              onClick={enviar}
              disabled={!puedeEnviar}
              className="flex items-center gap-1.5 text-sm font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {envio.estado === "enviando" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {envio.estado === "enviando" ? "Enviando…" : "Enviar"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function FacturasCompra({ pedidos, usuario = null, onCargarRecepcion = null }) {
  const inputRef = useRef(null);
  const [subiendo, setSubiendo] = useState(false);
  const [extractoAbierto, setExtractoAbierto] = useState(false);
  const [leyendoMap, setLeyendoMap] = useState({});
  const [filaAbierta, setFilaAbierta] = useState(null);
  const [errorFila, setErrorFila] = useState(null);
  const [error, setError] = useState(null);
  const leyendoAhora = useRef(new Set());
  const ultimoError = useRef(null);
  const pantallaRef = useRef(null);
  const porLeerRef = useRef([]);
  const porFilaRef = useRef({});
  const lecturasListasRef = useRef(false);
  const fallosLectura = useRef(new Set());
  const leerSinAbrirRef = useRef(null);
  const [erroresLectura, setErroresLectura] = useState({});
  const [resultado, setResultado] = useState(null); // { archivo, paginas, facturas: [...] }
  const [remitenteEmail, setRemitenteEmail] = useState(
    usuario?.email_envio || usuario?.email_empresa || null
  );
  const [proveedoresBc, setProveedoresBc] = useState(null);

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => { if (d.email) setRemitenteEmail(d.email); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let vivo = true;
    fetch("/api/bc/proveedores")
      .then((r) => r.json())
      .then((d) => {
        if (!vivo) return;
        if (Array.isArray(d.proveedores)) setProveedoresBc(d.proveedores);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // Lecturas ya hechas, por correo. No se pintan solas: solo al pulsar la fila.
  const guardadasRef = useRef(new Map());
  const [porFila, setPorFila] = useState({});
  const origenesHechas = useRef(new Set());
  const aplicarLecturasGuardadas = (lista) => {
    for (const f of lista || []) {
      if (!f.origen?.msg) continue;
      const clave = `${f.origen.msg}|${f.origen.att ?? ""}`;
      origenesHechas.current.add(clave);
      const previas = guardadasRef.current.get(clave) || [];
      const resto = previas.filter((p) => (f.factura ? p.factura !== f.factura : p !== f));
      const anterior = previas.find((p) => f.factura && p.factura === f.factura);
      guardadasRef.current.set(clave, [...resto, { ...f, pdfBase64: f.pdfBase64 || anterior?.pdfBase64 }]);
    }
    const mapa = {};
    for (const [clave, listaClave] of guardadasRef.current) mapa[clave] = listaClave.map(resumenLectura);
    setPorFila((prev) => ({ ...mapa, ...prev }));
  };

  useEffect(() => {
    let vivo = true;
    const traer = () => {
      fetch("/api/facturas-compra/pendientes?resumen=1")
        .then((r) => r.json())
        .then((j) => {
          if (!vivo) return;
          aplicarLecturasGuardadas(j.facturas || []);
          lecturasListasRef.current = true;
        })
        .catch(() => { lecturasListasRef.current = true; });
    };
    traer();
    const id = setInterval(traer, 20000);
    return () => { vivo = false; clearInterval(id); };
  }, []);

  // "Elegir pedido a mano" (Maria, 2026-09-04): cuando el pedido leído
  // del PDF no se encuentra en BC, Maria puede buscarlo y elegirlo en
  // la lista de "Pedidos de compra pendientes de facturar" (más abajo,
  // componente hermano de las tarjetas de factura). objetivoSeleccion
  // dice qué tarjeta/pedido está esperando esa elección; aplicadoresRef
  // guarda, por tarjeta, la función que aplica el pedido elegido (cada
  // TarjetaFactura se registra sola porque es quien tiene el estado del
  // pedido a actualizar).
  const [objetivoSeleccion, setObjetivoSeleccion] = useState(null); // { facturaKey, pedidoIdx } | null
  const aplicadoresRef = useRef({}); // facturaKey -> (pedidoIdx, numeroPedido) => void

  // Registro de facturas subidas (Maria, 2026-09-04) — botón junto al
  // título que abre el histórico persistente (ver RegistroFacturas).
  const [registroAbierto, setRegistroAbierto] = useState(false);

  const onSeleccionArchivo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }).catch(() => null);
    if (base64) await procesarFactura(file.name, base64);
  };

  const validarDesdeBandeja = async (it) => {
    try {
      return await procesarFactura(it.nombre, null, {
        msg: it.msg,
        att: it.att,
        // Remitente del correo de la bandeja → Para del «Correo al proveedor».
        de: it.de || "",
        deNombre: it.deNombre || "",
      });
    } catch (err) {
      ultimoError.current = err.message || String(err);
      return false;
    }
  };

  const esperarVisible = () => {
    if (typeof document === "undefined" || !document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const despertar = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", despertar);
        window.removeEventListener("focus", despertar);
        resolve();
      };
      document.addEventListener("visibilitychange", despertar);
      window.addEventListener("focus", despertar);
    });
  };

  const leerEnFondo = async (nombreArchivo, origen) => {
    const clave = `${origen.msg}|${origen.att ?? ""}`;
    const q = `msg=${encodeURIComponent(origen.msg)}&att=${encodeURIComponent(origen.att ?? "")}`;
    const inicioLectura = Date.now();
    const r = await fetch("/api/facturas-compra/extraer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: nombreArchivo, base64: null, origen, fondo: true }),
    });
    let json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const base = json.error || `Error ${r.status}`;
      throw new Error(json.detalle && json.detalle !== base ? `${base} — ${json.detalle}` : base);
    }
    while (json.estado === "leyendo" || json.estado === "ninguna") {
      if (Date.now() - inicioLectura > 9 * 60 * 1000) throw new Error("La lectura ha tardado demasiado.");
      await esperarVisible();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!leyendoAhora.current.has(clave)) throw new Error("Lectura cancelada");
      const s = await fetch(`/api/facturas-compra/lectura?${q}`);
      json = await s.json().catch(() => ({ estado: "leyendo" }));
    }
    if (json.estado === "error") throw new Error(json.error || "No se ha podido leer la factura");
    return json;
  };

  const procesarFactura = async (nombreArchivo, base64, origen = null) => {
    setSubiendo(!origen?.msg);
    setError(null);
    let ok = false;
    try {
      let json;
      if (origen?.msg) {
        json = await leerEnFondo(nombreArchivo, origen);
      } else {
        const r = await fetch("/api/facturas-compra/extraer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nombre: nombreArchivo, base64, origen }),
        });
        json = await r.json().catch(() => ({}));
        if (!r.ok) {
          const base = json.error || `Error ${r.status}`;
          throw new Error(json.detalle && json.detalle !== base ? `${base} — ${json.detalle}` : base);
        }
      }
      setResultado((prev) => {
        const nuevas = (json.facturas || []).map((fac) => ({
          ...fac,
          origen: origen || fac.origen || null,
        }));
        const previas = (prev?.facturas || []).filter((anterior) => !nuevas.some((n) => {
          if (n.origen?.msg && anterior.origen?.msg) {
            return n.origen.msg === anterior.origen.msg && String(n.origen.att || "") === String(anterior.origen.att || "");
          }
          if (n.origen?.msg || anterior.origen?.msg) return false;
          return n.factura && anterior.factura === n.factura;
        }));
        return {
          archivo: nombreArchivo,
          paginas: (json.paginas || 0) + previas.reduce((n, f) => n + (f.paginas?.length || 0), 0),
          facturas: [...nuevas, ...previas],
          guardadas: true,
        };
      });
      if (origen?.msg) {
        const clave = `${origen.msg}|${origen.att}`;
        origenesHechas.current.add(clave);
        guardadasRef.current.set(clave, (json.facturas || []).map((fac) => ({ ...fac, origen })));
      }
      ok = true;
    } catch (err) {
      ultimoError.current = err.message || String(err);
      if (!origen?.msg) setError(ultimoError.current);
    }
    setSubiendo(false);
    return ok;
  };

  const faltaHistorial = (fac) => {
    if (!fac || fac.yaEntrada || estaBorradorBC(fac) || !fac.proveedor) return false;
    return !(fac.pedidosDetalle || []).some((p) => p.pedido && !p.bcError);
  };

  const completarUltimaEntrada = async (facturas, clave) => {
    const nombres = [...new Set((facturas || []).filter(faltaHistorial).map((f) => f.proveedor))];
    for (const proveedor of nombres) {
      try {
        const r = await fetch("/api/facturas-compra/ultima-entrada", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proveedor }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ultimaEntrada) continue;
        const aplicar = (f) => {
          if (f.proveedor !== proveedor || !faltaHistorial(f)) return f;
          const resumen = j.ultimaEntrada.resumen;
          const motivos = (f.motivos || []).filter((m) => m !== f.ultimaEntrada?.resumen && m !== resumen);
          return { ...f, ultimaEntrada: j.ultimaEntrada, motivos: resumen ? [...motivos, resumen] : motivos };
        };
        setResultado((prev) => prev && ({ ...prev, facturas: (prev.facturas || []).map(aplicar) }));
        guardadasRef.current.set(clave, (guardadasRef.current.get(clave) || []).map(aplicar));
      } catch { /* la fila sigue abierta aunque el historial no responda */ }
    }
  };

  const marcarSiYaEntrada = async (facturas) => {
    const salida = [];
    for (const fac of facturas || []) {
      if (!fac?.factura || fac.yaEntrada) {
        salida.push(fac);
        continue;
      }
      try {
        const qs = new URLSearchParams({ factura: fac.factura });
        if (fac.proveedor) qs.set("proveedor", fac.proveedor);
        if (fac.origen?.msg) qs.set("msg", fac.origen.msg);
        if (fac.origen?.att != null && fac.origen?.att !== "") qs.set("att", String(fac.origen.att));
        const r = await fetch(`/api/facturas-compra/ya-entrada?${qs}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.encontrada) {
          const esBorrador = !!(j.borrador || j.estado === "borrador");
          const revisada = {
            ...fac,
            yaEntrada: !esBorrador,
            yaBorrador: esBorrador,
            entradaInfo: j,
            veredicto: esBorrador ? "ya_borrador" : "ya_entrada",
            ultimaEntrada: null,
            motivos: [
              esBorrador
                ? `⚠ Esta factura ya tiene un borrador en BC (${j.numeroBC || "PFC…"}${j.proveedor ? " · " + j.proveedor : ""}). No se crea otro.`
                : `⚠ Esta factura ya está registrada en BC: ${j.numeroBC || "?"}${j.proveedor ? " · " + j.proveedor : ""}. No se analiza ni se crea borrador.`,
            ],
          };
          salida.push(revisada);
          if (!esBorrador && fac.origen?.msg) {
            marcarEntradaEnListado({ msg: fac.origen.msg, att: fac.origen.att, factura: fac.factura });
          }
          continue;
        }
      } catch { /* si BC no responde, se enseña la lectura */ }
      salida.push(fac);
    }
    return salida;
  };

  const limpiarFalloLectura = (clave) => {
    fallosLectura.current.delete(clave);
    setErroresLectura((prev) => {
      if (!prev[clave]) return prev;
      const siguiente = { ...prev };
      delete siguiente[clave];
      return siguiente;
    });
  };

  const anotarFalloLectura = (clave, texto) => {
    fallosLectura.current.add(clave);
    setErroresLectura((prev) => ({ ...prev, [clave]: texto || "No se ha podido leer la factura" }));
  };

  const leerSinAbrir = async (it) => {
    const clave = `${it.msg}|${it.att}`;
    if (fallosLectura.current.has(clave) || origenesHechas.current.has(clave) || leyendoAhora.current.has(clave)) return;
    if (guardadasRef.current.get(clave)?.length) {
      origenesHechas.current.add(clave);
      return;
    }
    leyendoAhora.current.add(clave);
    setLeyendoMap((prev) => ({ ...prev, [clave]: `Leyendo ${it.nombre || it.asunto || "factura"}` }));
    const ok = await validarDesdeBandeja(it);
    leyendoAhora.current.delete(clave);
    setLeyendoMap((prev) => {
      const siguiente = { ...prev };
      delete siguiente[clave];
      return siguiente;
    });
    if (ok === true) limpiarFalloLectura(clave);
    else anotarFalloLectura(clave, ultimoError.current);
  };
  leerSinAbrirRef.current = leerSinAbrir;

  // Lee las facturas pendientes una a una en segundo plano (fecha de emisión,
  // proveedor, etc.) para poder filtrar por mes sin abrirlas a mano.
  useEffect(() => {
    let vivo = true;
    let ocupada = false;
    const tick = async () => {
      if (!vivo || ocupada) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (leyendoAhora.current.size > 0) return;
      if (!lecturasListasRef.current) return;
      const siguiente = (porLeerRef.current || []).find((it) => {
        if (!it?.msg) return false;
        const clave = `${it.msg}|${it.att}`;
        if (fallosLectura.current.has(clave)) return false;
        if (origenesHechas.current.has(clave)) return false;
        if (leyendoAhora.current.has(clave)) return false;
        if (guardadasRef.current.get(clave)?.length) return false;
        return true;
      });
      if (!siguiente) return;
      ocupada = true;
      try {
        await leerSinAbrirRef.current?.(siguiente);
      } finally {
        ocupada = false;
      }
    };
    const id = setInterval(tick, 2500);
    tick();
    return () => { vivo = false; clearInterval(id); };
  }, []);

  const publicarLectura = (clave, it, lista) => {
    const conRemitente = (lista || []).map((f) => ({
      ...f,
      origen: {
        ...(f.origen || {}),
        msg: f.origen?.msg || it.msg,
        att: f.origen?.att ?? it.att,
        de: f.origen?.de || it.de || "",
        deNombre: f.origen?.deNombre || it.deNombre || "",
      },
    }));
    guardadasRef.current.set(clave, conRemitente);
    origenesHechas.current.add(clave);
    setFilaAbierta(clave);
    setErrorFila(null);
    setResultado((prev) => {
      const ya = (prev?.facturas || []).some((f) => f.origen?.msg === it.msg && String(f.origen?.att || "") === String(it.att || ""));
      const base = ya ? (prev?.facturas || []) : [...conRemitente, ...(prev?.facturas || [])];
      const facturas = base.map((f) => {
        const nueva = conRemitente.find((r) => r.origen?.msg === f.origen?.msg && String(r.origen?.att || "") === String(f.origen?.att || "") && r.factura === f.factura);
        if (nueva) return nueva;
        if (f.origen?.msg === it.msg && String(f.origen?.att || "") === String(it.att || "")) {
          return {
            ...f,
            origen: {
              ...(f.origen || {}),
              de: f.origen?.de || it.de || "",
              deNombre: f.origen?.deNombre || it.deNombre || "",
            },
          };
        }
        return f;
      });
      const paginas = facturas.reduce((n, f) => n + (f.paginas?.length || 0), 0);
      return { archivo: it.nombre || it.asunto || "Factura", paginas, facturas, guardadas: true };
    });
  };

  const abrirDesdeBandeja = async (it) => {
    const clave = `${it.msg}|${it.att}`;
    limpiarFalloLectura(clave);
    setFilaAbierta(clave);
    setErrorFila(null);
    let guardadas = guardadasRef.current.get(clave);
    if (!guardadas?.length) {
      try {
        const r = await fetch(`/api/facturas-compra/pendientes?resumen=1&msg=${encodeURIComponent(it.msg)}&att=${encodeURIComponent(it.att ?? "")}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok) aplicarLecturasGuardadas(j.facturas || []);
        guardadas = guardadasRef.current.get(clave);
      } catch { /* si no hay lectura guardada, se lee el PDF */ }
    }
    if (guardadas?.length) {
      // Primero comprobar duplicado en BC; solo después enseñar el formulario.
      setLeyendoMap((prev) => ({ ...prev, [clave]: "Comprobando si ya está entrada…" }));
      const revisadas = await marcarSiYaEntrada(guardadas);
      setLeyendoMap((prev) => {
        const siguiente = { ...prev };
        delete siguiente[clave];
        return siguiente;
      });
      publicarLectura(clave, it, revisadas);
      if (!revisadas.some((f) => estaEntrada(f) || estaBorradorBC(f))) completarUltimaEntrada(revisadas, clave);
      return;
    }
    if (leyendoAhora.current.has(clave)) {
      setFilaAbierta(clave);
      return;
    }
    leyendoAhora.current.add(clave);
    setFilaAbierta(clave);
    setLeyendoMap((prev) => ({ ...prev, [clave]: `Leyendo ${it.nombre || it.asunto || "factura"}` }));
    const ok = await validarDesdeBandeja(it);
    leyendoAhora.current.delete(clave);
    setLeyendoMap((prev) => {
      const siguiente = { ...prev };
      delete siguiente[clave];
      return siguiente;
    });
    if (ok !== true) {
      const texto = ultimoError.current || "No se ha podido leer la factura";
      setErrorFila({ clave, texto });
      anotarFalloLectura(clave, texto);
    }
  };

  const onPorLeer = useCallback((lista) => { porLeerRef.current = lista || []; }, []);

  const facturasSueltas = (resultado?.facturas || []).filter((f) => !f.origen?.msg);

  useEffect(() => {
    const map = {};
    for (const f of resultado?.facturas || []) {
      if (!f.origen?.msg) continue;
      const k = `${f.origen.msg}|${f.origen.att ?? ""}`;
      if (!map[k]) map[k] = [];
      map[k].push(resumenLectura(f));
    }
    if (!Object.keys(map).length) return;
    setPorFila((prev) => ({ ...prev, ...map }));
  }, [resultado]);
  porFilaRef.current = porFila;

  const marcarEntradaEnListado = ({ msg, att, factura }) => {
    if (!msg) return;
    const clave = `${msg}|${att ?? ""}`;
    const aplicar = (x) => {
      if (factura && x.factura && x.factura !== factura) return x;
      return { ...x, yaEntrada: true, veredicto: "ya_entrada" };
    };
    const full = guardadasRef.current.get(clave);
    const lista = full?.length ? full.map(aplicar) : (porFilaRef.current[clave] || []).map(aplicar);
    if (full?.length) guardadasRef.current.set(clave, lista);
    const resumenes = lista.map(resumenLectura);
    setPorFila((prev) => ({ ...prev, [clave]: resumenes }));
    setResultado((prev) => prev && ({
      ...prev,
      facturas: (prev.facturas || []).map((x) => (
        x.origen?.msg === msg && String(x.origen?.att ?? "") === String(att ?? "") ? aplicar(x) : x
      )),
    }));
    if (resumenes.length > 0 && resumenes.every(estaEntrada)) {
      fetch("/api/facturas-compra/bandeja/entrada", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg, att }),
      }).catch(() => {});
      setFilaAbierta((abiertaAhora) => (abiertaAhora === clave ? null : abiertaAhora));
    }
  };
  const facturasIdentificadas = facturasSueltas.filter((f) => f.factura);
  const sinIdentificar = facturasSueltas.filter((f) => !f.factura);
  const listas = facturasIdentificadas.filter((f) => f.veredicto === "ok").length;
  // Proveedor de gasto (Maria, 2026-09-04): ni "para entrar" ni "a
  // revisar" — es un tercer estado propio (ver TarjetaFactura).
  const deGasto = facturasIdentificadas.filter((f) => f.veredicto === "gasto").length;
  const paraRevisar = facturasIdentificadas.length - listas - deGasto;

  // Proveedor(es) de la factura recién validada — a petición de Maria
  // (2026-09-04), "Pedidos de compra pendientes de facturar" (más abajo)
  // solo enseña pedidos de este/estos proveedores, no de todos. Viene de
  // pedidosDetalle[].vendorName, que ya se pide a BC al validar la
  // factura (no es ninguna llamada nueva).
  const proveedoresFactura = useMemo(() => {
    const vistos = new Set();
    const lista = [];
    for (const f of resultado?.facturas || []) {
      for (const p of f.pedidosDetalle || []) {
        if (p.vendorName && !vistos.has(p.vendorName)) {
          vistos.add(p.vendorName);
          lista.push(p.vendorName);
        }
      }
    }
    return lista;
  }, [resultado]);

  const anotarIncidencia = (cuerpo) => {
    const { msg, att, factura, facturaOriginal, incidencia, motivos, veredicto, pedidosDetalle, fecha, baseImponible, importeTotal, proveedor } = cuerpo || {};
    if (!msg) return;
    const clave = `${msg}|${att ?? ""}`;
    const misma = (x) => !facturaOriginal || x.factura === facturaOriginal || x.factura === factura || !x.factura;
    const aplicar = (x) => misma(x) ? {
      ...x,
      factura: factura || x.factura,
      proveedor: proveedor || x.proveedor,
      fecha: fecha ?? x.fecha,
      baseImponible: baseImponible ?? x.baseImponible,
      importeTotal: importeTotal ?? x.importeTotal,
      pedidosDetalle: pedidosDetalle || x.pedidosDetalle,
      lineasSinPedido: [],
      incidencia,
      motivos,
      veredicto,
      yaEntrada: false,
      pdfGuardado: x.pdfGuardado || !!x.pdfBase64,
    } : x;
    setPorFila((prev) => {
      const lista = prev[clave] || [];
      const siguiente = lista.length ? lista.map(aplicar) : [aplicar({ factura, incidencia, motivos, veredicto, yaEntrada: false, pdfGuardado: true, pendientesRecibir: [] })];
      return { ...prev, [clave]: siguiente.map(resumenLectura) };
    });
    const previas = guardadasRef.current.get(clave) || [];
    if (previas.length) guardadasRef.current.set(clave, previas.map(aplicar));
    setResultado((prev) => prev && ({
      ...prev,
      facturas: (prev.facturas || []).map((x) => (
        x.origen?.msg === msg && String(x.origen?.att ?? "") === String(att ?? "") ? aplicar(x) : x
      )),
    }));
  };

  const pintarTarjeta = (f, i, empezarAbierta = false, opts = {}) => {
    const facturaKey = `${f.factura ? "" : "sin-"}${claveTarjeta(f, i)}#${i}`;
    return (
      <TarjetaFactura
        key={facturaKey}
        f={f}
        pedidos={pedidos}
        proveedoresBc={proveedoresBc}
        remitenteEmail={remitenteEmail}
        empezarAbierta={empezarAbierta}
        seleccionActiva={objetivoSeleccion?.facturaKey === facturaKey ? objetivoSeleccion.pedidoIdx : null}
        onIniciarSeleccion={(pedidoIdx) => setObjetivoSeleccion({ facturaKey, pedidoIdx })}
        onCancelarSeleccion={() => setObjetivoSeleccion(null)}
        registrarAplicador={(fn) => {
          aplicadoresRef.current[facturaKey] = fn;
        }}
        onIncidencia={anotarIncidencia}
        onEntrada={marcarEntradaEnListado}
        onMinimizar={empezarAbierta ? () => setFilaAbierta(null) : undefined}
        modoDiario={empezarAbierta}
        onDescartar={opts.onDescartar || null}
      />
    );
  };

  return (
    <div ref={pantallaRef}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Validación de facturas</h1>
          <p className="text-slate-500 text-sm mt-1">
            Elige una factura. El resto de correos se oculta hasta que vuelvas atrás.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setExtractoAbierto(true)}
            className="flex items-center gap-2 text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md px-4 py-2"
          >
            <Mail size={15} /> Solicitud de extracto de facturación 2026
          </button>
          <button
            onClick={() => setRegistroAbierto(true)}
            className="flex items-center gap-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 rounded-md px-4 py-2"
          >
            <History size={15} /> Registro
          </button>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={subiendo}
            className="flex items-center gap-2 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-60 rounded-md px-4 py-2"
          >
            <Upload size={15} className={subiendo ? "animate-pulse" : ""} /> {subiendo ? "Leyendo y comprobando en BC…" : "Subir factura (PDF o foto)"}
          </button>
          {/* Foto en vez de PDF (Maria, 2026-09-04): además del PDF, se
              puede subir directamente una foto JPG/PNG de la factura — el
              backend la envuelve en un PDF de una página y sigue el mismo
              camino de siempre (misma IA, mismo cruce con BC). */}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
            className="hidden"
            onChange={onSeleccionArchivo}
          />
        </div>
      </div>

      <RegistroFacturas abierto={registroAbierto} onCerrar={() => setRegistroAbierto(false)} />
      <SolicitudExtracto
        abierto={extractoAbierto}
        onCerrar={() => setExtractoAbierto(false)}
        pedidos={pedidos}
        remitenteEmail={remitenteEmail}
      />

      <BandejaFacturas
        onAbrir={abrirDesdeBandeja}
        onVolver={() => setFilaAbierta(null)}
        leyendoMap={leyendoMap}
        filaAbierta={filaAbierta}
        errorFila={errorFila}
        erroresLectura={erroresLectura}
        facturas={resultado?.facturas || []}
        lecturas={porFila}
        onPorLeer={onPorLeer}
        renderFactura={(f, i, opts) => pintarTarjeta(f, i, true, opts)}
      />

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          Error leyendo el documento: {error}
        </div>
      )}

      {facturasSueltas.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-slate-700">
              «{resultado.archivo}» · {resultado.paginas} página(s) · {facturasIdentificadas.length} factura(s) identificada(s)
              {resultado.guardadas && <span className="font-normal text-slate-500"> · PDF guardado hasta que se registre en BC</span>}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1 text-emerald-700 font-semibold">
                <CheckCircle2 size={14} /> {listas} para entrar
              </span>
              {deGasto > 0 && (
                <span className="flex items-center gap-1 text-blue-700 font-semibold">
                  <Wallet size={14} /> {deGasto} de gasto
                </span>
              )}
              <span className="flex items-center gap-1 text-red-700 font-semibold">
                <AlertTriangle size={14} /> {paraRevisar} a revisar
              </span>
              <button onClick={() => setResultado((prev) => {
                const facturas = (prev?.facturas || []).filter((f) => f.origen?.msg);
                return facturas.length ? { ...prev, facturas } : null;
              })} title="Ocultar de la pantalla. El PDF sigue guardado hasta que la factura se registre en BC" className="text-slate-400 hover:text-slate-600">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {facturasIdentificadas.map((f, i) => pintarTarjeta(f, i))}
            {sinIdentificar.map((f, i) => pintarTarjeta(f, i))}
            {!facturasIdentificadas.length && !sinIdentificar.length && (
              <div className="text-sm text-slate-400">No se ha identificado ninguna factura en el documento.</div>
            )}
          </div>
        </div>
      )}

      {!filaAbierta && <PedidosPendientesFacturar
        pedidos={pedidos}
        proveedores={proveedoresFactura}
        modoSeleccion={!!objetivoSeleccion}
        onCancelarSeleccion={() => setObjetivoSeleccion(null)}
        onElegirPedido={
          objetivoSeleccion
            ? (numeroPedido) => aplicadoresRef.current[objetivoSeleccion.facturaKey]?.(objetivoSeleccion.pedidoIdx, numeroPedido)
            : undefined
        }
      />}
    </div>
  );
}
