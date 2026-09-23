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
import React, { useState, useRef, useMemo, useEffect } from "react";
import { Upload, X, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Mail, Loader2, FileCheck2, RefreshCw, History, Search, Wallet } from "lucide-react";
import { emailsPorCodigoDepartamento, EMAIL_POR_DEFECTO } from "./departamentos.js";

const fmtEur = (n) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

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
  const E = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const filasMotivos = (motivos || []).map((m) => `<li style="margin-bottom:4px;">${E(m)}</li>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;">
    <p>Hola,</p>
    <p>Ha llegado la factura <b>${E(factura)}</b> (adjunta en PDF) y todavía no se puede entrar en Business Central:</p>
    <ul style="padding-left:18px;">${filasMotivos}</ul>
    <p>¿Podéis confirmar/recibir el pedido en BC (o revisar el precio) para poder entrar la factura?</p>
    <p style="color:#94a3b8;font-size:12px;margin-top:18px;">Aviso automático — Validación de facturas.</p>
  </div>`;
}

// Línea de la factura, ya cruzada con BC. Cuando no se ha encontrado
// (o el emparejamiento automático se ha equivocado) se puede elegir a
// mano la línea real del pedido en BC — igual que ya permite hacer
// Recepción de material con "lineasDisponiblesBC".
function LineaFactura({ linea, disponibles, onElegir, onEditar }) {
  const problema = linea.coincidencia === "sin_match" || linea.pendienteRecepcion || linea.diferenciaPrecio;
  return (
    <div className={`text-xs px-3 py-2 rounded border ${problema ? "bg-red-50 border-red-200" : "bg-emerald-50 border-emerald-200"}`}>
      <input
        value={linea.descripcionFactura}
        onChange={(e) => onEditar("descripcionFactura", e.target.value)}
        title="Descripción tal como la ha leído la IA — corrígela si hace falta"
        className="w-full font-medium text-slate-700 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none focus:bg-white"
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
        <span className="flex items-center gap-1">
          Facturado:
          <input
            type="number"
            step="0.01"
            value={linea.cantidadFacturada}
            onChange={(e) => onEditar("cantidadFacturada", e.target.value === "" ? 0 : Number(e.target.value))}
            className="w-16 border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700"
          />
          ·
          <input
            type="number"
            step="0.01"
            value={linea.precioFacturado ?? ""}
            onChange={(e) => onEditar("precioFacturado", e.target.value === "" ? null : Number(e.target.value))}
            className="w-20 border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700"
          />
          €
        </span>
        {linea.lineaBC ? (
          <span>
            BC: pedido {linea.lineaBC.cantidadPedida}, recibido {linea.lineaBC.cantidadRecibida} · {fmtEur(linea.lineaBC.precioBC)}
            {linea.coincidencia === "manual" && <span className="text-blue-600 font-medium"> (elegida a mano)</span>}
          </span>
        ) : (
          <span className="text-red-600 font-medium">No encontrada en el pedido en BC</span>
        )}
      </div>
      {(!linea.lineaBC || linea.coincidencia === "media") && disponibles && disponibles.length > 0 && (
        <div className="mt-1.5">
          <select
            value={linea.coincidencia === "manual" ? linea.lineaBC?.id || "" : ""}
            onChange={(e) => e.target.value && onElegir(e.target.value)}
            className="w-full text-[11px] border border-amber-300 rounded px-1.5 py-1 bg-white text-slate-600"
          >
            <option value="">
              {linea.lineaBC ? "— no es esta línea, elegir otra a mano —" : "— sin coincidencia — elegir a mano —"}
            </option>
            {disponibles.map((lb) => (
              <option key={lb.id} value={lb.id}>
                {lb.codigo ? `${lb.codigo} — ` : ""}{lb.descripcion} (pedido {lb.cantidadPedida}, recibido {lb.cantidadRecibida})
              </option>
            ))}
          </select>
        </div>
      )}
      {linea.pendienteRecepcion && linea.lineaBC && (
        <div className="mt-1 text-red-700">⚠ Pendiente de recibir/registrar en BC.</div>
      )}
      {linea.diferenciaPrecio && (
        <div className="mt-1 text-red-700">⚠ El precio no coincide con BC.</div>
      )}
    </div>
  );
}

function TarjetaFactura({ f, pedidos, seleccionActiva, onIniciarSeleccion, onCancelarSeleccion, registrarAplicador, remitenteEmail = null }) {
  const [abierta, setAbierta] = useState(true);
  const [envio, setEnvio] = useState({ estado: "idle" }); // idle | enviando | ok | error
  const [entrada, setEntrada] = useState({ estado: "idle" }); // idle | entrando | ok | error
  const [forzarEntrada, setForzarEntrada] = useState(false);
  const [verOtrosGasto, setVerOtrosGasto] = useState(false);

  // Proveedor de gasto (Maria, 2026-09-04): "hay proveedores que son de
  // gasto y estos se entran sin pedido [...] añadas el Nº de OT, porque
  // siempre es la misma". Detectado en el backend a partir del
  // histórico de líneas de factura de compra en BC (no de una lista a
  // mano) — ver detalle en `gastoSugerido`. No cambia con ediciones de
  // línea (no hay líneas de pedido que editar en este caso), así que se
  // toma directamente de `f`, sin recalcular.
  const esGasto = f.veredicto === "gasto" && !!f.gastoSugerido;

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
  const [pedidosDetalle, setPedidosDetalle] = useState(() => {
    const grupos = (f.pedidosDetalle || []).map((p) => ({ ...p, lineas: (p.lineas || []).map((l) => ({ ...l })) }));
    if (!esGasto && f.lineasSinPedido?.length) {
      grupos.push({
        pedido: null,
        vendorName: null,
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
  });

  // Cabecera editable — lo que ha leído la IA del PDF (nº de factura,
  // fecha, base imponible, importe total) puede corregirse a mano por si
  // hay algo mal antes de pasarlo a BC o de mandar el aviso.
  const [cabecera, setCabecera] = useState(() => ({
    factura: f.factura || "",
    fecha: f.fecha || "",
    baseImponible: f.baseImponible ?? null,
    importeTotal: f.importeTotal ?? null,
  }));
  const editarCabecera = (campo, valor) => setCabecera((prev) => ({ ...prev, [campo]: valor }));

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
          algunProblema = true;
          motivosCalc.push(`Pedido ${p.pedido}: no encuentro en BC la línea "${l.descripcionFactura}" — revísala a mano.`);
          continue;
        }
        if (l.pendienteRecepcion) {
          algunProblema = true;
          motivosCalc.push(
            `Pedido ${p.pedido}: "${l.lineaBC?.descripcion || l.descripcionFactura}" — facturado ${l.cantidadFacturada}, recibido en BC solo ${l.lineaBC?.cantidadRecibida}. Falta recibir/registrar antes de entrar la factura.`
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
      const r = await fetch("/api/facturas-compra/entrar-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factura: cabecera.factura,
          fechaFactura: cabecera.fecha || null,
          pdfBase64: f.pdfBase64,
          nombreArchivo: `Factura_${cabecera.factura}.pdf`,
          lineasFactura,
          forzar,
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

  const enviarAviso = async (e) => {
    e.stopPropagation();
    setEnvio({ estado: "enviando" });
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          asunto: `Factura ${cabecera.factura} pendiente de validar${pedidosDetalle?.[0]?.pedido ? ` — Pedido ${pedidosDetalle[0].pedido}` : ""}`,
          cuerpoHtml: construirCuerpoHtml(cabecera.factura, motivos),
          adjunto: f.pdfBase64 ? { nombre: `Factura_${cabecera.factura}.pdf`, base64: f.pdfBase64 } : null,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `Error ${r.status}`);
      setEnvio({ estado: "ok" });
    } catch (err) {
      setEnvio({ estado: "error", error: err.message || String(err) });
    }
  };

  if (!f.factura) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 text-sm text-amber-700">
        {f.paginas.length} página(s) sin número de factura reconocido — revisa el documento a mano.
      </div>
    );
  }
  return (
    <div className={`border rounded-lg overflow-hidden ${esGasto ? "border-blue-300" : ok ? "border-emerald-300" : "border-red-300"}`}>
      <div
        className={`flex items-center justify-between px-4 py-3 cursor-pointer ${esGasto ? "bg-blue-50" : ok ? "bg-emerald-50" : "bg-red-50"}`}
        onClick={() => setAbierta((v) => !v)}
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
              Factura {cabecera.factura}
              {cabecera.fecha && <span className="text-slate-400 font-normal"> · {cabecera.fecha}</span>}
            </div>
            <div className="text-xs text-slate-500">
              {esGasto
                ? "sin pedido — proveedor de gasto"
                : `${pedidosDetalle.filter((p) => p.pedido).length} pedido(s)${
                    pedidosDetalle.some((p) => !p.pedido) ? " · líneas sin pedido" : ""
                  }`}{" "}
              · páginas {f.paginas.join(", ")}
              {cabecera.importeTotal !== null && cabecera.importeTotal !== undefined && ` · total ${fmtEur(cabecera.importeTotal)}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {f.yaEntrada && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-500 text-white" title="Esta factura ya está entrada en BC">
              Ya entrada en BC
            </span>
          )}
          <span
            className={`text-xs font-semibold px-2 py-1 rounded-full ${
              esGasto ? "bg-blue-600 text-white" : ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
            }`}
          >
            {esGasto ? "Proveedor de gasto" : ok ? "Se puede entrar" : "Revisar antes de entrar"}
          </span>
          {abierta ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
        </div>
      </div>

      {/* Proveedor de gasto (Maria, 2026-09-04): panel propio, en vez del
          bloque rojo de motivos — no es un error a corregir, es el
          funcionamiento normal de este proveedor. Muestra la cuenta y el
          Nº de OT sugeridos (los más usados históricamente con este
          proveedor en BC), con transparencia de qué más se ha visto por
          si el detectado no es el correcto esta vez. */}
      {esGasto && (
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

      {!ok && !esGasto && motivos.length > 0 && (
        <div className="px-4 py-2 bg-red-50/60 border-t border-red-100 text-xs text-red-700 space-y-1">
          {motivos.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
        </div>
      )}

      {!ok && !esGasto && (
        <div className="px-4 py-2 border-t border-red-100 bg-white flex items-center justify-between gap-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-1 min-w-[220px]">
            Para:
            <input
              value={destinatariosTexto}
              onChange={(e) => {
                setDestinatariosTexto(e.target.value);
                setDestinatariosEditados(true);
              }}
              placeholder="correo1@also-casals.com, correo2@also-casals.com…"
              title="Destinatarios del aviso — sepáralos por comas. Se calculan solos por el departamento del pedido, pero puedes corregirlos."
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
            {envio.estado === "ok" && <span className="text-xs text-emerald-600 font-medium">✓ Enviado</span>}
            {envio.estado === "error" && <span className="text-xs text-red-600" title={envio.error}>Error al enviar</span>}
            {!destinatarios.length && <span className="text-xs text-amber-600">Sin destinatarios válidos</span>}
            <button
              onClick={enviarAviso}
              disabled={envio.estado === "enviando" || envio.estado === "ok" || !destinatarios.length}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {envio.estado === "enviando" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
              {envio.estado === "enviando" ? "Enviando…" : envio.estado === "ok" ? "Enviado" : "Enviar aviso"}
            </button>
          </div>
        </div>
      )}
      {/* "Entrar en BC de todas formas" (Maria, 2026-09-04): deja
          saltarse el semáforo rojo — a petición explícita, no todos los
          avisos tienen que bloquear la entrada en BC. Requiere marcar
          la casilla a propósito para no entrarla sin querer, y el
          backend vuelve a comprobar en vivo qué se está pasando por
          alto (queda anotado en "avisos" del resultado). */}
      {!ok && !esGasto && (
        <div
          className="px-4 py-2 border-t border-amber-100 bg-amber-50/60 flex items-center justify-between gap-3 flex-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          <label className="flex items-center gap-1.5 text-xs text-amber-800 cursor-pointer">
            <input
              type="checkbox"
              checked={forzarEntrada}
              onChange={(e) => setForzarEntrada(e.target.checked)}
              disabled={entrada.estado === "entrando" || entrada.estado === "ok"}
            />
            Sé que hay avisos pendientes, quiero entrarla igual en BC
          </label>
          <div className="flex items-center gap-2">
            {entrada.estado === "ok" && <span className="text-xs text-emerald-600 font-medium">✓ Entrada en BC</span>}
            {entrada.estado === "error" && <span className="text-xs text-red-600">Con avisos — mira el detalle</span>}
            <button
              onClick={(e) => entrarEnBC(e, true)}
              disabled={!forzarEntrada || entrada.estado === "entrando" || entrada.estado === "ok"}
              title={!forzarEntrada ? "Marca la casilla para poder forzar la entrada" : ""}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-md px-3 py-1.5"
            >
              {entrada.estado === "entrando" ? <Loader2 size={13} className="animate-spin" /> : <FileCheck2 size={13} />}
              {entrada.estado === "entrando" ? "Entrando en BC…" : entrada.estado === "ok" ? "Entrada" : "Entrar en BC de todas formas"}
            </button>
          </div>
        </div>
      )}
      {ok && (
        <div className="px-4 py-2 border-t border-emerald-100 bg-white flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Se abrirá como <b>borrador</b> en BC (proveedor, nº de factura y fecha) — las líneas las traes tú en BC con
            "Obtener albaranes de compra".
          </div>
          <div className="flex items-center gap-2">
            {entrada.estado === "ok" && <span className="text-xs text-emerald-600 font-medium">✓ Entrada en BC</span>}
            {entrada.estado === "error" && <span className="text-xs text-red-600">Con avisos — mira el detalle</span>}
            <button
              onClick={entrarEnBC}
              disabled={entrada.estado === "entrando" || entrada.estado === "ok"}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-md px-3 py-1.5"
            >
              {entrada.estado === "entrando" ? <Loader2 size={13} className="animate-spin" /> : <FileCheck2 size={13} />}
              {entrada.estado === "entrando" ? "Entrando en BC…" : entrada.estado === "ok" ? "Entrada" : "Entrar en BC"}
            </button>
          </div>
        </div>
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

      {abierta && (
        <div className="px-4 py-3 border-t border-slate-100" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Vista previa del PDF de la factura */}
            <div>
              <div className="text-[11px] text-slate-500 mb-1">Vista previa · páginas {f.paginas.join(", ")}</div>
              {f.pdfBase64 ? (
                <iframe
                  src={`data:application/pdf;base64,${f.pdfBase64}`}
                  title={`factura-${cabecera.factura}`}
                  className="w-full border border-slate-200 rounded-md"
                  style={{ height: 480 }}
                />
              ) : (
                <div className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-md p-6 text-center">Sin vista previa</div>
              )}
            </div>

            {/* Datos leídos del PDF — todos editables, por si la IA se ha equivocado en algo */}
            <div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <label className="text-xs block">
                  <span className="block text-[11px] font-semibold text-slate-500 mb-0.5">Nº factura</span>
                  <input
                    value={cabecera.factura}
                    onChange={(e) => editarCabecera("factura", e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                  />
                </label>
                <label className="text-xs block">
                  <span className="block text-[11px] font-semibold text-slate-500 mb-0.5">Fecha factura</span>
                  <input
                    type="date"
                    value={cabecera.fecha || ""}
                    onChange={(e) => editarCabecera("fecha", e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs block">
                  <span className="block text-[11px] font-semibold text-slate-500 mb-0.5">Base imponible</span>
                  <input
                    type="number"
                    step="0.01"
                    value={cabecera.baseImponible ?? ""}
                    onChange={(e) => editarCabecera("baseImponible", e.target.value === "" ? null : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs block">
                  <span className="block text-[11px] font-semibold text-slate-500 mb-0.5">Importe total</span>
                  <input
                    type="number"
                    step="0.01"
                    value={cabecera.importeTotal ?? ""}
                    onChange={(e) => editarCabecera("importeTotal", e.target.value === "" ? null : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                </label>
              </div>

              <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: 380 }}>
                {pedidosDetalle.map((p, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="text-xs font-semibold text-slate-600">
                        {/* Enlace directo al pedido en BC (Maria,
                            2026-09-04) — abre en pestaña nueva la ficha
                            del pedido de compra en el cliente web. */}
                        {p.pedido ? (
                          p.enlaceBC ? (
                            <a
                              href={p.enlaceBC}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Abrir este pedido de compra en Business Central"
                              className="text-blue-700 hover:text-blue-900 hover:underline"
                            >
                              Pedido {p.pedido}
                            </a>
                          ) : (
                            <>Pedido {p.pedido}</>
                          )
                        ) : (
                          <span className="text-amber-700">Sin pedido</span>
                        )}{" "}
                        {p.vendorName ? `· ${p.vendorName}` : ""}
                        {p.pedidoElegidoAMano && <span className="text-blue-600 font-medium"> (elegido a mano)</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {p.pedido && (
                          <button
                            onClick={() => refrescarPedido(i)}
                            disabled={refrescando[i]}
                            title="Volver a consultar este pedido en BC (líneas, recibido, precio)"
                            className="flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                          >
                            <RefreshCw size={11} className={refrescando[i] ? "animate-spin" : ""} />
                            {refrescando[i] ? "Actualizando…" : "Actualizar desde BC"}
                          </button>
                        )}
                        {p.bcError && (
                          <button
                            onClick={() => (seleccionActiva === i ? onCancelarSeleccion?.() : onIniciarSeleccion?.(i))}
                            title="Buscar el pedido correcto en la lista de 'Pedidos de compra pendientes de facturar' de más abajo"
                            className="text-[11px] font-medium text-amber-700 hover:text-amber-900"
                          >
                            {seleccionActiva === i ? "Cancelar" : "Elegir pedido manualmente"}
                          </button>
                        )}
                      </div>
                    </div>
                    {seleccionActiva === i && (
                      <div className="text-xs text-blue-700 mb-1">
                        ☝ Busca y elige el pedido correcto en "Pedidos de compra pendientes de facturar", más abajo.
                      </div>
                    )}
                    {p.bcError ? (
                      <div className="text-xs text-red-600">{p.bcError}</div>
                    ) : (
                      <div className="space-y-1.5">
                        {p.lineas.map((l, j) => (
                          <LineaFactura
                            key={j}
                            linea={l}
                            disponibles={p.lineasDisponiblesBC}
                            onElegir={(lineaBcId) => elegirLineaBC(i, j, lineaBcId)}
                            onEditar={(campo, valor) => editarLinea(i, j, campo, valor)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
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

export default function FacturasCompra({ pedidos, usuario = null }) {
  const inputRef = useRef(null);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState(null);
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
    setSubiendo(true);
    setError(null);
    setResultado(null);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch("/api/facturas-compra/extraer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: file.name, base64 }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Antes se perdía "detalle" (el mensaje real del error en el
        // backend) y solo se enseñaba el texto genérico — a petición de
        // Maria (2026-09-04, error genérico sin pista de la causa), se
        // añade aquí para poder diagnosticar sin tener que mirar la
        // consola del backend.
        const base = json.error || `Error ${r.status}`;
        throw new Error(json.detalle && json.detalle !== base ? `${base} — ${json.detalle}` : base);
      }
      setResultado({ archivo: file.name, paginas: json.paginas, facturas: json.facturas || [] });
    } catch (err) {
      setError(err.message || String(err));
    }
    setSubiendo(false);
  };

  const facturasIdentificadas = (resultado?.facturas || []).filter((f) => f.factura);
  const sinIdentificar = (resultado?.facturas || []).filter((f) => !f.factura);
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

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Validación de facturas</h1>
          <p className="text-slate-500 text-sm mt-1">
            Sube la factura de proveedor y te digo, pedido a pedido, si ya está recibida/registrada en BC y si el precio coincide.
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

      {error && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          Error leyendo el documento: {error}
        </div>
      )}

      {resultado && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-slate-700">
              «{resultado.archivo}» · {resultado.paginas} página(s) · {facturasIdentificadas.length} factura(s) identificada(s)
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
              <button onClick={() => setResultado(null)} className="text-slate-400 hover:text-slate-600">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {facturasIdentificadas.map((f, i) => {
              const facturaKey = `f${i}`;
              return (
                <TarjetaFactura
                  key={facturaKey}
                  f={f}
                  pedidos={pedidos}
                  remitenteEmail={remitenteEmail}
                  seleccionActiva={objetivoSeleccion?.facturaKey === facturaKey ? objetivoSeleccion.pedidoIdx : null}
                  onIniciarSeleccion={(pedidoIdx) => setObjetivoSeleccion({ facturaKey, pedidoIdx })}
                  onCancelarSeleccion={() => setObjetivoSeleccion(null)}
                  registrarAplicador={(fn) => {
                    aplicadoresRef.current[facturaKey] = fn;
                  }}
                />
              );
            })}
            {sinIdentificar.map((f, i) => {
              const facturaKey = `s${i}`;
              return (
                <TarjetaFactura
                  key={facturaKey}
                  f={f}
                  pedidos={pedidos}
                  remitenteEmail={remitenteEmail}
                  seleccionActiva={objetivoSeleccion?.facturaKey === facturaKey ? objetivoSeleccion.pedidoIdx : null}
                  onIniciarSeleccion={(pedidoIdx) => setObjetivoSeleccion({ facturaKey, pedidoIdx })}
                  onCancelarSeleccion={() => setObjetivoSeleccion(null)}
                  registrarAplicador={(fn) => {
                    aplicadoresRef.current[facturaKey] = fn;
                  }}
                />
              );
            })}
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
