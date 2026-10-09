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
 * del departamento del pedido, igual que ya hace el Explorador de OTs
 * (misma lista EMAILS_DEPARTAMENTO, departamentos.js). El departamento
 * se lee del propio pedido de compra (columna "Cód. UN"/Shortcut
 * Dimension 1, la misma que ya usa Recepción de material).
 *
 * Botón "Entrar en BC" (solo en facturas con semáforo verde): crea la
 * factura de compra en BC como BORRADOR (sin contabilizar — alguien la
 * revisa y registra desde BC), con las líneas copiadas de los datos ya
 * validados del pedido/recepción, y adjunta el PDF de la factura.
 * ⚠️ Primera vez que esta app ESCRIBE un documento nuevo en BC — ver
 * los comentarios de /api/facturas-compra/entrar-bc en server.cjs.
 *
 * No modifica nada en BC salvo al pulsar "Entrar en BC" — hasta entonces
 * es solo un chequeo antes de entrar la factura.
 */
import React, { Fragment, useState, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Upload, X, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Mail, Loader2, FileCheck2, RefreshCw, History, Search, Wallet, Inbox, Send } from "lucide-react";
import { emailsPorCodigoDepartamento, EMAIL_POR_DEFECTO } from "./departamentos.js";
import { empresaGuardada } from "./empresa.jsx";

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
function destinatariosFactura(pedidosDetalle, pedidos) {
  const set = new Set();
  for (const p of pedidosDetalle || []) {
    const dep = departamentoDePedido(pedidos, p.pedido);
    const emails = emailsPorCodigoDepartamento(dep);
    (emails || [EMAIL_POR_DEFECTO]).forEach((e) => set.add(e));
  }
  if (!set.size) set.add(EMAIL_POR_DEFECTO);
  return [...set];
}

function construirCuerpoHtml(factura, motivos) {
  return textoPlanoAHtml(cuerpoIncidenciaTexto(factura, motivos));
}

function cuerpoIncidenciaTexto(factura, motivos) {
  const lista = (motivos || []).map((m) => `· ${m}`).join("\n");
  return `Hola,\n\nHa llegado la factura ${factura || ""} (adjunta en PDF) y no cuadra con el pedido de compra en Business Central:\n\n${lista}\n\n¿Podéis revisar/recibir el pedido en BC (o corregir el precio) para poder validar la factura?`;
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

function TarjetaFactura({ f, pedidos, seleccionActiva, onIniciarSeleccion, onCancelarSeleccion, registrarAplicador, remitenteEmail = null, empezarAbierta = false, onIncidencia, onMinimizar }) {
  const [abierta, setAbierta] = useState(empezarAbierta);
  const [buscaPedido, setBuscaPedido] = useState("");
  const [verTodosProv, setVerTodosProv] = useState(false);
  const [envio, setEnvio] = useState({ estado: "idle" }); // idle | enviando | ok | error  (incidencia)
  const [vistaCorreo, setVistaCorreo] = useState(null);
  const [continia, setContinia] = useState({ estado: "idle" }); // idle | enviando | ok | error
  const [entrada, setEntrada] = useState({ estado: "idle" }); // idle | entrando | ok | error
  const [pedidoNuevo, setPedidoNuevo] = useState(() => (
    f.pedidoCreado?.numero ? { estado: "ok", ...f.pedidoCreado } : { estado: "idle" }
  ));
  const [forzarEntrada, setForzarEntrada] = useState(false);
  const [recepPedido, setRecepPedido] = useState(null);
  const [buscandoCorreos, setBuscandoCorreos] = useState(false);
  const [pdfManual, setPdfManual] = useState(f.pdfBase64 || null);
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
  const ultima = f.ultimaEntrada || null;

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
  useEffect(() => {
    setCabecera({
      factura: f.factura || "",
      fecha: f.fecha || "",
      baseImponible: f.baseImponible ?? null,
      importeTotal: f.importeTotal ?? null,
      proveedor: f.proveedor || "",
    });
    setPedidosDetalle(gruposDesdeFactura(f));
  }, [firmaLectura]);
  const editarCabecera = (campo, valor) => setCabecera((prev) => ({ ...prev, [campo]: valor }));
  const indicarProveedor = (nombre) => {
    setCabecera((prev) => ({ ...prev, proveedor: nombre }));
    const exacto = proveedoresLista.find((n) => n.toUpperCase() === nombre.trim().toUpperCase());
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
  const proveedoresLista = useMemo(() => {
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
  }, [pedidos]);
  const proveedorExacto = proveedoresLista.find((n) => n.toUpperCase() === String(cabecera.proveedor || "").trim().toUpperCase()) || "";
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
  const destinatariosAuto = useMemo(() => destinatariosFactura(pedidosDetalle, pedidos), [pedidosDetalle, pedidos]);
  const [destinatariosTexto, setDestinatariosTexto] = useState(() => destinatariosAuto.join(", "));
  const [destinatariosEditados, setDestinatariosEditados] = useState(false);
  useEffect(() => {
    if (!destinatariosEditados) setDestinatariosTexto(destinatariosAuto.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinatariosAuto.join(",")]);
  const destinatarios = useMemo(
    () =>
      [...new Set(destinatariosTexto.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@")))],
    [destinatariosTexto]
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
          pdfBase64: f.pdfBase64,
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
    } catch (err) {
      setEntrada({ estado: "error", error: err.message || String(err) });
    }
  };

  const crearPedidoComoUltima = async (e) => {
    e?.stopPropagation?.();
    const proveedorPedido = cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor;
    if (!proveedorPedido) return;
    if (pedidoNuevo.estado === "entrando" || (pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok)) return;
    setPedidoNuevo((prev) => ({ ...prev, estado: "entrando", error: undefined }));
    const dePedidos = pedidosDetalle
      .filter((p) => !p.pedido || p.bcError)
      .flatMap((p) => p.lineas || []);
    const crudas = dePedidos.length ? dePedidos : (f.lineasSinPedido || []);
    try {
      const r = await fetch("/api/facturas-compra/crear-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor: cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor,
          fecha: cabecera.fecha || null,
          factura: cabecera.factura,
          msg: f.origen?.msg || null,
          att: f.origen?.att || null,
          baseImponible: cabecera.baseImponible,
          lineas: crudas.map((l) => ({
            descripcion: l.descripcionFactura,
            cantidad: l.cantidadFacturada,
            precioUnitario: l.precioFacturado,
          })),
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

  const abrirVistaCorreo = (e) => {
    e?.stopPropagation?.();
    if (envio.estado === "enviando" || envio.estado === "ok" || !destinatarios.length) return;
    if (envio.estado === "error") setEnvio({ estado: "idle" });
    setVistaCorreo({
      asunto: asuntoIncidencia,
      cuerpo: cuerpoIncidenciaTexto(cabecera.factura, motivos),
    });
  };

  const enviarAviso = async (e) => {
    e?.stopPropagation?.();
    if (!vistaCorreo) return;
    setEnvio({ estado: "enviando" });
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          asunto: (vistaCorreo.asunto || asuntoIncidencia).trim(),
          cuerpoHtml: textoPlanoAHtml(vistaCorreo.cuerpo),
          adjunto: f.pdfBase64 ? { nombre: `Factura_${cabecera.factura}.pdf`, base64: f.pdfBase64 } : null,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      const nums = [...new Set(pedidosDetalle.filter((p) => p.pedido && (p.lineas || []).some((l) => l.pendienteRecepcion)).map((p) => p.pedido))];
      const texto = `Incidencia de la factura ${cabecera.factura} enviada a ${destinatarios.join(", ")}`;
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
      setVistaCorreo(null);
      setEnvio({ estado: "ok" });
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
  return (
    <div className={`border rounded-lg overflow-hidden ${esGasto ? "border-blue-300" : ok ? "border-emerald-300" : "border-red-300"}`}>
      <div
        className={`flex items-center justify-between px-4 py-3 cursor-pointer ${esGasto ? "bg-blue-50" : ok ? "bg-emerald-50" : "bg-red-50"}`}
        onClick={() => {
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
            <div className="font-semibold text-slate-800 text-sm">
              {cabecera.factura ? `Factura ${cabecera.factura}` : "Documento sin nº de factura"}
              {cabecera.fecha && <span className="text-slate-400 font-normal"> · {cabecera.fecha}</span>}
            </div>
            <div className="text-xs text-slate-500">
              {f.yaEntrada ? "ya está entrada en BC — no se sigue" : pedidosPendRecibir.length > 0 ? "no está entrada — el pedido sigue pendiente de recibir" : esGasto ? "sin pedido — proveedor de gasto" : ultima ? "sin pedido — proponer pedido como la última factura" : `${pedidosDetalle.length} pedido(s) en la factura`}
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
          {ultima?.puedeCrear && !f.yaEntrada && pedidosPendRecibir.length === 0 && !esGasto ? (
            <button
              type="button"
              onClick={crearPedidoComoUltima}
              disabled={pedidoNuevo.estado === "entrando" || (pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok) || !(cabecera.proveedor || ultima?.proveedorFactura || ultima?.proveedorBC || f.proveedor)}
              className="text-xs font-semibold px-2 py-1 rounded-full bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-60"
            >
              {pedidoNuevo.estado === "entrando"
                ? (pedidoNuevo.numero ? "Registrando…" : "Creando…")
                : pedidoNuevo.numero && !pedidoNuevo.registro?.ok
                  ? "Registrar pedido"
                  : pedidoNuevo.registro?.ok
                    ? "Pedido registrado"
                    : "Crear pedido como la última"}
            </button>
          ) : (
            <span
              className={`text-xs font-semibold px-2 py-1 rounded-full ${
                f.yaEntrada ? "bg-amber-500 text-white" : pedidosPendRecibir.length > 0 ? "bg-orange-600 text-white" : esGasto ? "bg-blue-600 text-white" : ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
              }`}
            >
              {f.yaEntrada ? "Ya entrada en BC" : pedidosPendRecibir.length > 0 ? "Pendiente de recibir" : esGasto ? "Proveedor de gasto" : ok ? "OK · lista para BC" : "No cuadra — revisar"}
            </span>
          )}
          {abierta ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
        </div>
      </div>

      {/* Proveedor de gasto (Maria, 2026-09-04): panel propio, en vez del
          bloque rojo de motivos — no es un error a corregir, es el
          funcionamiento normal de este proveedor. Muestra la cuenta y el
          Nº de OT sugeridos (los más usados históricamente con este
          proveedor en BC), con transparencia de qué más se ha visto por
          si el detectado no es el correcto esta vez. */}
      {abierta && esGasto && !ultima && (
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

      {abierta && f.yaEntrada && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-300 text-sm text-amber-950">
          <div className="font-semibold">Esta factura ya está entrada en BC. No sigo.</div>
          <div className="mt-1">
            {f.entradaInfo?.numeroBC ? <>Factura BC {f.entradaInfo.numeroBC}</> : "Ya consta en el historial de facturas de compra"}
            {f.entradaInfo?.proveedor ? <> · {f.entradaInfo.proveedor}</> : null}.
            No se analizan pedidos ni se crea un borrador.
          </div>
        </div>
      )}

      {abierta && !f.yaEntrada && sinPedidoUtil && (
        <div className="px-4 py-3 bg-sky-50 border-t border-sky-200 text-sm" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="text-sky-950 min-w-[240px] flex-1">
              <div className="font-semibold">Esta factura no trae pedido de compra.</div>
              <div className="mt-1 text-sky-900">
                {ultima?.puedeCrear ? (
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
              {pedidoNuevo.numero && pedidoNuevo.estado !== "entrando" && (
                <div className={`mt-1.5 ${pedidoNuevo.registro?.ok ? "text-emerald-800" : "text-amber-900"}`}>
                  Pedido <span className="font-semibold">{pedidoNuevo.numero}</span>
                  {pedidoNuevo.registro?.ok ? " creado y registrado." : " creado, pero no se ha registrado."}
                  {pedidoNuevo.enlace && (
                    <> <a href={pedidoNuevo.enlace} target="_blank" rel="noopener noreferrer" className="underline font-semibold">Abrir pedido</a>.</>
                  )}
                  {!pedidoNuevo.registro?.ok && pedidoNuevo.registro?.error && <div className="mt-1 text-red-700">{pedidoNuevo.registro.error}</div>}
                  {pedidoNuevo.avisos?.length > 0 && <div className="mt-1 text-amber-800">{pedidoNuevo.avisos.join(" · ")}</div>}
                </div>
              )}
            </div>
            {!(pedidoNuevo.estado === "ok" && pedidoNuevo.registro?.ok) && (
              <button
                onClick={crearPedidoComoUltima}
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
                      : "Crear pedido de compra"}
              </button>
            )}
          </div>
        </div>
      )}

      {abierta && !ok && !esGasto && !f.yaEntrada && !ultima?.puedeCrear && motivos.filter((m) => !m.startsWith("No se puede entrar: el pedido")).length > 0 && (
        <div className="px-4 py-3 bg-red-50/60 border-t border-red-100">
          <div className="text-xs font-semibold text-red-800 mb-1.5">Por qué no cuadra esta factura</div>
          <div className="text-xs text-red-700 space-y-1">
            {motivos.filter((m) => !m.startsWith("No se puede entrar: el pedido")).map((m, i) => (
              <div key={i}>• {m}</div>
            ))}
          </div>
        </div>
      )}

      {abierta && !f.yaEntrada && pedidosPendRecibir.length > 0 && (
        <div className="px-4 py-3 bg-orange-50/70 border-t border-orange-200" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <div>
              <div className="text-sm font-semibold text-orange-950">Esta factura no está entrada. No se puede registrar todavía.</div>
              <div className="text-[13px] text-orange-900 mt-0.5">El pedido sigue pendiente de recibir. La factura pide material que en el pedido aún no consta como recibido.</div>
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
                      onClick={abrirVistaCorreo}
                      disabled={envio.estado === "enviando" || envio.estado === "ok" || !destinatarios.length}
                      className="flex items-center gap-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded px-2 py-1"
                      title={destinatarios.join(", ")}
                    >
                      {envio.estado === "enviando" ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                      {envio.estado === "ok" ? "Enviada" : "Enviar a los responsables"}
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
                    {envio.estado === "ok" && <div className="text-[11px] text-emerald-700 mt-1">Correo enviado a {destinatarios.join(", ")}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {abierta && ok && !esGasto && !f.yaEntrada && pcsFormanFactura.length > 0 && (
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

      {abierta && !ok && !esGasto && !f.yaEntrada && !ultima?.puedeCrear && (
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
            {destinatariosEditados && (
              <button
                onClick={() => {
                  setDestinatariosEditados(false);
                  setDestinatariosTexto(destinatariosAuto.join(", "));
                }}
                title="Volver a los destinatarios calculados automáticamente"
                className="text-blue-600 hover:text-blue-800 underline shrink-0"
              >
                Restablecer
              </button>
            )}
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
      {abierta && !ok && !esGasto && !f.yaEntrada && (
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
      {abierta && ok && !f.yaEntrada && (
        <div className="px-4 py-2.5 border-t border-emerald-100 bg-white flex items-center justify-between gap-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
          <div className="text-xs text-slate-600">
            Toda la factura cuadra. Pulsa el botón para crear el <b>borrador de factura de compra</b> en BC con el nº, la fecha, las líneas y el PDF leídos del documento.
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
                  {fc.lineasCreadas?.length > 0 && (
                    <div className="pl-4 text-emerald-700 mt-0.5">
                      Líneas creadas automáticamente en BC ({fc.lineasCreadas.length}): {fc.lineasCreadas.join(", ")}
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

      {abierta && !f.yaEntrada && (
        <div className="border-t border-slate-200 bg-[#f4f6f8]" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col xl:flex-row xl:items-start">
            <div className="xl:w-[min(680px,48%)] xl:shrink-0 min-w-0 bg-white">
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

            <aside className="xl:flex-1 xl:min-w-[520px] xl:sticky xl:top-0 shrink-0 border-t xl:border-t-0 xl:border-l border-slate-200 bg-white">
              <div className="px-3 py-2 text-[12px] font-semibold text-slate-700 border-b border-slate-200">Documento · {f.paginas?.length || 0} pág.</div>
              {(f.pdfBase64 || pdfManual) ? (
                <iframe
                  src={`data:application/pdf;base64,${f.pdfBase64 || pdfManual}`}
                  title={`factura-${cabecera.factura}`}
                  className="w-full bg-slate-100"
                  style={{ height: "min(78vh, 820px)" }}
                />
              ) : (
                <div className="p-6 text-sm text-slate-400 text-center">Sin vista previa</div>
              )}
            </aside>
          </div>
        </div>
      )}

      {abierta && !f.yaEntrada && !esGasto && !ultima?.puedeCrear && (
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
      {vistaCorreo && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => { if (envio.estado !== "enviando") setVistaCorreo(null); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">Revisa el correo antes de enviarlo</div>
            <div className="px-4 py-3 space-y-3 text-sm">
              <div>
                <div className="text-[11px] text-slate-500">De</div>
                <div className="text-slate-800">{remitenteEmail || "Tu correo de empresa"}</div>
              </div>
              <label className="block">
                <span className="text-[11px] text-slate-500">Para</span>
                <input
                  value={destinatariosTexto}
                  onChange={(e) => {
                    setDestinatariosTexto(e.target.value);
                    setDestinatariosEditados(true);
                  }}
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
              <label className="block">
                <span className="text-[11px] text-slate-500">Mensaje</span>
                <textarea
                  value={vistaCorreo.cuerpo}
                  onChange={(e) => setVistaCorreo((v) => ({ ...v, cuerpo: e.target.value }))}
                  rows={12}
                  className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1.5 text-[13px] leading-relaxed"
                />
              </label>
              <div className="text-[12px] text-slate-600">
                Adjunto: {f.pdfBase64 ? `Factura_${cabecera.factura}.pdf` : "esta factura no tiene PDF adjunto"}
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
                disabled={envio.estado === "enviando" || !destinatarios.length || !(vistaCorreo.asunto || "").trim()}
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
function PedidosPendientesFacturar({ pedidos, proveedores, modoSeleccion, onElegirPedido, onCancelarSeleccion }) {
  const [verColumnas, setVerColumnas] = useState(false);
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

  const { pendientes, columnaNoEncontrada } = useMemo(() => {
    if (!pedidos?.headers?.length || !pedidos?.rows?.length) {
      return { pendientes: [], columnaNoEncontrada: false };
    }
    if (!metodo) {
      return { pendientes: [], columnaNoEncontrada: true };
    }
    // Sin proveedor identificado (ninguna factura subida todavía) no hay
    // nada que enseñar — antes, al no filtrar por proveedor, esto
    // enseñaba TODOS los pedidos pendientes (miles) aunque el mensaje de
    // arriba dijera lo contrario. Bug reportado por Maria (2026-09-04).
    if (!proveedoresNormalizados.size) {
      return { pendientes: [], columnaNoEncontrada: false };
    }
    const vistos = new Set();
    const lista = [];
    for (const fila of pedidos.rows) {
      if (filaYaFacturada(fila, cols, metodo)) continue; // ya facturado → no se muestra
      const numero = String(fila[cols.numero] || "").trim();
      if (!numero || vistos.has(numero)) continue; // un pedido = una fila
      const proveedor = cols.proveedor ? fila[cols.proveedor] : null;
      if (!proveedoresNormalizados.has(normalizarProveedor(proveedor))) continue;
      vistos.add(numero);
      lista.push({
        pedido: numero,
        proveedor,
        fecha: cols.fecha ? fila[cols.fecha] : null,
        estado: cols.estado ? fila[cols.estado] : null,
        importe: cols.importe ? fila[cols.importe] : null,
      });
    }
    lista.sort((a, b) => a.pedido.localeCompare(b.pedido));
    return { pendientes: lista, columnaNoEncontrada: false };
  }, [pedidos, cols, metodo, proveedoresNormalizados]);

  const pendientesFiltrados = useMemo(() => {
    const q = normalizarProveedor(busquedaPedido);
    if (!q) return pendientes;
    return pendientes.filter((p) => normalizarProveedor(p.pedido).includes(q));
  }, [pendientes, busquedaPedido]);

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

  return (
    <div className="mt-8 pt-6 border-t border-slate-200">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Pedidos de compra pendientes de facturar</h2>
          <p className="text-slate-500 text-sm mt-1">
            {proveedoresNormalizados.size
              ? `Pedidos de ${(proveedores || []).filter(Boolean).join(", ")} pendientes de facturar en BC, haya llegado ya esta factura o no.`
              : "Sube una factura arriba para ver aquí los pedidos pendientes de facturar de ese mismo proveedor."}
          </p>
        </div>
        {!columnaNoEncontrada && !!pendientes.length && (
          <div className="text-sm font-semibold text-slate-700">
            {busquedaPedido.trim() ? `${pendientesFiltrados.length} de ${pendientes.length}` : pendientes.length} pedido(s) pendiente(s)
          </div>
        )}
      </div>

      {/* Buscador de pedidos (Maria, 2026-09-04): con proveedores con
          muchos pedidos pendientes (p. ej. 1860 de Saltoki), poder
          buscar por nº de pedido dentro de esa lista ya filtrada por
          proveedor, sin tener que desplazarse a mano por todos. */}
      {!columnaNoEncontrada && !!pendientes.length && (
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

      {!columnaNoEncontrada && !!proveedoresNormalizados.size && !pendientes.length && (
        <div className="mt-3 text-sm text-slate-400">No hay pedidos pendientes de facturar de este proveedor.</div>
      )}

      {!columnaNoEncontrada && !!pendientes.length && !pendientesFiltrados.length && (
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
                return (
                  <React.Fragment key={p.pedido}>
                    <tr className="border-t border-slate-100">
                      <td className="pl-3">
                        <button
                          onClick={() => toggleLineas(p.pedido)}
                          className="text-slate-400 hover:text-slate-600"
                          title="Ver líneas del pedido"
                        >
                          {estaAbierto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="py-1.5 px-3 font-semibold text-slate-800">{p.pedido}</td>
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
  return {
    factura: f.factura || "",
    fecha: f.fecha || "",
    veredicto: f.veredicto || "",
    motivos: f.motivos || [],
    pdfGuardado: !!(f.pdfBase64 || f.pdfGuardado),
    yaEntrada: !!f.yaEntrada,
    pendientesRecibir: pendientesRecibirDe(f),
    incidencia: textoIncidencia(f),
  };
}

function BandejaFacturas({ onAbrir, leyendoMap = {}, filaAbierta, errorFila, facturas = [], lecturas = {}, renderFactura }) {
  const [abierta, setAbierta] = useState(true);
  const [dias, setDias] = useState(7);
  const [cargando, setCargando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [error, setError] = useState(null);
  const [datos, setDatos] = useState(null);
  const [verOtras, setVerOtras] = useState(false);
  const [verProcesadas, setVerProcesadas] = useState(false);
  const empresa = empresaGuardada();
  const datosRef = useRef(null);
  const arranque = useRef(false);
  const filaRef = useRef(null);

  useEffect(() => {
    if (!filaAbierta) return;
    filaRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [filaAbierta]);

  const pintar = (j) => {
    datosRef.current = j;
    setDatos(j);
  };

  // Primero la copia guardada (la pantalla sale al momento). Después solo
  // los correos llegados desde la última actualización.
  const cargar = async () => {
    setError(null);
    let base = datosRef.current;
    if (!base?.actualizadoEn) {
      setCargando(true);
      try {
        const r = await fetch("/api/facturas-compra/bandeja?cache=1");
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
        if (j.actualizadoEn || j.items?.length) {
          base = j;
          pintar(j);
        }
      } catch (e) { setError(e.message || String(e)); }
      setCargando(false);
    }
    setSincronizando(true);
    try {
      const desde = base?.actualizadoEn;
      const url = desde
        ? `/api/facturas-compra/bandeja?desde=${encodeURIComponent(desde)}`
        : `/api/facturas-compra/bandeja?dias=${dias}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      pintar(j);
    } catch (e) { setError(e.message || String(e)); }
    setSincronizando(false);
  };

  const ampliarVentana = async (d) => {
    setDias(d);
    const base = datosRef.current;
    const items = base?.items || [];
    if (!items.length) return;
    const corte = new Date();
    corte.setHours(0, 0, 0, 0);
    corte.setDate(corte.getDate() - (d - 1));
    const oldest = items.reduce((m, it) => (!m || String(it.fecha) < m ? String(it.fecha) : m), "");
    if (!oldest || new Date(oldest) <= corte) return;
    setSincronizando(true); setError(null);
    try {
      const r = await fetch(`/api/facturas-compra/bandeja?desde=${encodeURIComponent(corte.toISOString())}&hasta=${encodeURIComponent(oldest)}&dias=${d}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      pintar(j);
    } catch (e) { setError(e.message || String(e)); }
    setSincronizando(false);
  };

  useEffect(() => {
    if (!abierta || arranque.current) return;
    arranque.current = true;
    cargar();
  }, [abierta]);

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
  const visibles = [...deEsta, ...sinAsignar, ...(verOtras ? deOtras : [])]
    .filter((it) => verProcesadas || !it.procesada)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const pendientesEsta = deEsta.filter((it) => !it.procesada).length;

  return (
    <div className="mt-4 bg-white border border-slate-200 rounded-lg">
      <button onClick={() => setAbierta((v) => !v)} className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-slate-700">
        <span className="flex items-center gap-2"><Inbox size={16} className="text-purple-600" /> Bandeja de facturas · {datos?.buzon || "facturacio@alsocasals.com"}
          {datos && <span className="text-[11px] font-normal text-slate-500">· {pendientesEsta} pendiente(s) de {empresa?.displayName || "esta empresa"}</span>}
        </span>
        <span className="text-[11px] text-slate-400">{abierta ? "ocultar ▲" : "mostrar ▼"}</span>
      </button>
      {abierta && (
        <div className="px-4 pb-3">
          <div className="flex flex-wrap items-center gap-3 text-[12px] mb-2">
            <label className="flex items-center gap-1">Últimos
              <select value={dias} onChange={(e) => ampliarVentana(Number(e.target.value))} className="border border-slate-300 rounded px-1 py-0.5">
                {[1, 3, 7, 15, 30, 60].map((d) => <option key={d} value={d}>{d} día{d > 1 ? "s" : ""}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={verOtras} onChange={(e) => setVerOtras(e.target.checked)} /> Ver también las de otras empresas ({deOtras.length})</label>
            <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={verProcesadas} onChange={(e) => setVerProcesadas(e.target.checked)} /> Ver ocultadas</label>
            <button onClick={() => cargar()} disabled={sincronizando} className="flex items-center gap-1 text-purple-700 hover:underline disabled:opacity-50">
              <RefreshCw size={12} className={sincronizando ? "animate-spin" : ""} /> {sincronizando ? "Buscando nuevos…" : "Buscar nuevos"}
            </button>
            <span className="text-slate-400 ml-auto">Pulsa una fila sin leer: se lee minimizada, en segundo plano. Cuando termine, pulsa otra vez para abrirla.</span>
          </div>
          {error && <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{error}</div>}
          {cargando && !datos && <div className="text-[12px] text-slate-400">Leyendo el buzón por primera vez…</div>}
          {sincronizando && datos && <div className="text-[12px] text-purple-700 mb-1">Buscando correos nuevos{horaActualizacion ? ` desde las ${horaActualizacion}` : ""}… La lista guardada sigue visible.</div>}
          {datos && visibles.length === 0 && <div className="text-[12px] text-slate-400">No hay facturas pendientes de {empresa?.displayName || "esta empresa"} en este periodo.</div>}
          {visibles.length > 0 && (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-1 pr-2">Recibido</th><th className="py-1 pr-2">De</th><th className="py-1 pr-2">Asunto / archivo</th><th className="py-1 pr-2">Empresa (por CIF)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((it) => {
                  const otra = it.empresaId && it.empresaId !== actualId;
                  const clave = `${it.msg}|${it.att}`;
                  const leyendoEsta = leyendoMap[clave];
                  const abierta = filaAbierta === clave;
                  const deEsta = facturasDeFila(facturas, it);
                  const errorEsta = errorFila?.clave === clave ? errorFila.texto : null;
                  const panel = abierta && (deEsta.length > 0 || errorEsta);
                  return (
                    <Fragment key={clave}>
                      <tr
                        onClick={() => { if (!otra && !it.procesada) onAbrir?.(it); }}
                        className={`${panel ? "" : "border-b border-slate-100"} ${it.procesada ? "opacity-60" : ""} ${abierta || leyendoEsta ? "bg-purple-50" : ""} ${otra || it.procesada ? "" : "cursor-pointer hover:bg-purple-50"}`}
                      >
                        <td className={`py-1 pr-2 whitespace-nowrap text-slate-500 ${abierta || leyendoEsta ? "border-l-4 border-purple-500 pl-2" : ""}`}>{new Date(it.fecha).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                        <td className="py-1 pr-2 truncate max-w-[180px]" title={it.de}>{it.deNombre || it.de}</td>
                        <td className="py-1 pr-2">
                          <div className="truncate max-w-[320px]" title={it.asunto}>{it.asunto}</div>
                          <div className="text-[10px] text-slate-400 truncate max-w-[320px]">{it.nombre}</div>
                          {(lecturas[clave] || []).some((f) => !f.yaEntrada && f.incidencia) && !leyendoEsta && (
                            <div className="mt-0.5 max-w-[480px] space-y-0.5">
                              {(lecturas[clave] || []).filter((f) => !f.yaEntrada && f.incidencia).map((f, i) => (
                                <div key={`${f.factura}-${i}`} className="text-[11px] text-orange-900">
                                  <span className="font-semibold">Pendiente de entrar</span>
                                  {f.incidencia ? <span> · {f.incidencia}</span> : null}
                                </div>
                              ))}
                            </div>
                          )}
                          {leyendoEsta && (
                            <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-purple-800">
                              <Loader2 size={12} className="animate-spin" /> {leyendoEsta} · sigue en segundo plano
                            </div>
                          )}
                          {!leyendoEsta && errorEsta && !abierta && (
                            <div className="mt-0.5 text-[11px] text-red-700">No se ha podido leer: {errorEsta}</div>
                          )}
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {it.empresaId ? (
                            <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${otra ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-800"}`}>{it.empresaNombre} · {it.cif}</span>
                          ) : (
                            <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-amber-100 text-amber-800" title={it.sinTexto ? "PDF escaneado: no se puede leer el CIF automáticamente" : "No aparece ningún CIF de las empresas"}>
                              {it.variosCif ? `Varios CIF (${it.cif}) · revisar` : it.sinTexto ? "Escaneado · revisar CIF" : "CIF no encontrado"}
                            </span>
                          )}
                        </td>
                        <td className="py-1 text-right whitespace-nowrap">
                          {it.procesada ? (
                            <button onClick={(e) => { e.stopPropagation(); marcar(it, true); }} className="text-[11px] text-slate-500 hover:underline" title="Volver a mostrarla">ocultada · mostrar</button>
                          ) : otra ? (
                            <span className="text-[11px] text-slate-400">Cambia a {it.empresaNombre} para verla</span>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); marcar(it); }} className="text-[11px] text-slate-500 hover:underline" title="No mostrar esta factura">descartar</button>
                          )}
                        </td>
                      </tr>
                      {panel && (
                        <tr ref={abierta ? filaRef : null} className="bg-purple-50">
                          <td colSpan={5} className="p-0 border-l-4 border-purple-500">
                            <div className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                              {errorEsta && (
                                <div className="text-[13px] text-red-700">Error leyendo el documento: {errorEsta}</div>
                              )}
                              {deEsta.length > 0 && (
                                <div className="space-y-3">
                                  {deEsta.map((f, i) => renderFactura(f, i))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function FacturasCompra({ pedidos, usuario = null }) {
  const inputRef = useRef(null);
  const [subiendo, setSubiendo] = useState(false);
  const [leyendoMap, setLeyendoMap] = useState({});
  const [filaAbierta, setFilaAbierta] = useState(null);
  const [errorFila, setErrorFila] = useState(null);
  const [error, setError] = useState(null);
  const leyendoAhora = useRef(new Set());
  const ultimoError = useRef(null);
  const [resultado, setResultado] = useState(null); // { archivo, paginas, facturas: [...] }
  const [remitenteEmail, setRemitenteEmail] = useState(
    usuario?.email_envio || usuario?.email_empresa || null
  );

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => { if (d.email) setRemitenteEmail(d.email); })
      .catch(() => {});
  }, []);

  // Lecturas ya hechas, por correo. No se pintan solas: solo al pulsar la fila.
  const guardadasRef = useRef(new Map());
  const [porFila, setPorFila] = useState({});
  const origenesHechas = useRef(new Set());
  useEffect(() => {
    let vivo = true;
    fetch("/api/facturas-compra/pendientes")
      .then((r) => r.json())
      .then((j) => {
        if (!vivo) return;
        for (const f of j.facturas || []) {
          if (!f.origen?.msg) continue;
          const clave = `${f.origen.msg}|${f.origen.att}`;
          origenesHechas.current.add(clave);
          const previas = guardadasRef.current.get(clave) || [];
          guardadasRef.current.set(clave, [...previas, f]);
        }
        const mapa = {};
        for (const [clave, lista] of guardadasRef.current) mapa[clave] = lista.map(resumenLectura);
        setPorFila((prev) => ({ ...mapa, ...prev }));
      })
      .catch(() => {});
    return () => { vivo = false; };
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
      return await procesarFactura(it.nombre, null, { msg: it.msg, att: it.att });
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
    if (!fac || fac.yaEntrada || !fac.proveedor) return false;
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
        const r = await fetch(`/api/facturas-compra/ya-entrada?factura=${encodeURIComponent(fac.factura)}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.encontrada) {
          salida.push({
            ...fac,
            yaEntrada: true,
            entradaInfo: j,
            veredicto: "ya_entrada",
            ultimaEntrada: null,
            motivos: [`⚠ Esta factura ya está entrada en BC (factura ${j.numeroBC || "?"}${j.proveedor ? " · " + j.proveedor : ""}). No se analiza ni se crea borrador.`],
          });
          continue;
        }
      } catch { /* si BC no responde, se enseña la lectura */ }
      salida.push(fac);
    }
    return salida;
  };

  const abrirDesdeBandeja = async (it) => {
    const clave = `${it.msg}|${it.att}`;
    const guardadas = guardadasRef.current.get(clave);
    if (guardadas?.length) {
      setFilaAbierta(clave);
      setErrorFila(null);
      const revisadas = await marcarSiYaEntrada(guardadas);
      guardadasRef.current.set(clave, revisadas);
      setResultado((prev) => {
        const ya = (prev?.facturas || []).some((f) => f.origen?.msg === it.msg && String(f.origen?.att || "") === String(it.att || ""));
        const base = ya ? (prev?.facturas || []) : [...revisadas, ...(prev?.facturas || [])];
        const facturas = base.map((f) => {
          const nueva = revisadas.find((r) => r.origen?.msg === f.origen?.msg && String(r.origen?.att || "") === String(f.origen?.att || "") && r.factura === f.factura);
          return nueva || f;
        });
        const paginas = facturas.reduce((n, f) => n + (f.paginas?.length || 0), 0);
        return { archivo: it.nombre || it.asunto || "Factura", paginas, facturas, guardadas: true };
      });
      if (!revisadas.some((f) => f.yaEntrada)) completarUltimaEntrada(revisadas, clave);
      return;
    }
    if (leyendoAhora.current.has(clave)) return;
    leyendoAhora.current.add(clave);
    setFilaAbierta(null);
    setLeyendoMap((prev) => ({ ...prev, [clave]: `Leyendo ${it.nombre || it.asunto || "factura"}` }));
    const ok = await validarDesdeBandeja(it);
    leyendoAhora.current.delete(clave);
    setLeyendoMap((prev) => {
      const siguiente = { ...prev };
      delete siguiente[clave];
      return siguiente;
    });
    if (ok !== true) setErrorFila({ clave, texto: ultimoError.current || "No se ha podido leer la factura" });
  };

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

  const pintarTarjeta = (f, i, empezarAbierta = false) => {
    const facturaKey = `${f.factura ? "" : "sin-"}${claveTarjeta(f, i)}#${i}`;
    return (
      <TarjetaFactura
        key={facturaKey}
        f={f}
        pedidos={pedidos}
        remitenteEmail={remitenteEmail}
        empezarAbierta={empezarAbierta}
        seleccionActiva={objetivoSeleccion?.facturaKey === facturaKey ? objetivoSeleccion.pedidoIdx : null}
        onIniciarSeleccion={(pedidoIdx) => setObjetivoSeleccion({ facturaKey, pedidoIdx })}
        onCancelarSeleccion={() => setObjetivoSeleccion(null)}
        registrarAplicador={(fn) => {
          aplicadoresRef.current[facturaKey] = fn;
        }}
        onIncidencia={anotarIncidencia}
        onMinimizar={empezarAbierta ? () => setFilaAbierta(null) : undefined}
      />
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Validación de facturas</h1>
          <p className="text-slate-500 text-sm mt-1">
            El listado sale solo. Pulsa una fila para leer ese PDF. Si trae pedido, se coteja. Si no trae pedido, se crea uno igual que la última factura de ese proveedor.
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <BandejaFacturas
        onAbrir={abrirDesdeBandeja}
        leyendoMap={leyendoMap}
        filaAbierta={filaAbierta}
        errorFila={errorFila}
        facturas={resultado?.facturas || []}
        lecturas={porFila}
        renderFactura={(f, i) => pintarTarjeta(f, i, true)}
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

      <PedidosPendientesFacturar
        pedidos={pedidos}
        proveedores={proveedoresFactura}
        modoSeleccion={!!objetivoSeleccion}
        onCancelarSeleccion={() => setObjetivoSeleccion(null)}
        onElegirPedido={
          objetivoSeleccion
            ? (numeroPedido) => aplicadoresRef.current[objetivoSeleccion.facturaKey]?.(objetivoSeleccion.pedidoIdx, numeroPedido)
            : undefined
        }
      />
    </div>
  );
}
