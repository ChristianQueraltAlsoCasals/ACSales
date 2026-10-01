/**
 * mapeoArticulos.js — Alias Also↔Ferros para historial / precios ACSales.
 * Fuente: GET /api/mapeo-articulos (CSV del bot de sustitución).
 */

let _cache = null;
let _promise = null;

export async function cargarMapeoArticulos({ force = false } = {}) {
  if (_cache && !force) return _cache;
  if (_promise && !force) return _promise;
  _promise = (async () => {
    try {
      const r = await fetch("/api/mapeo-articulos");
      if (!r.ok) {
        _cache = { ok: false, porCodigo: {}, n: 0 };
        return _cache;
      }
      const data = await r.json();
      _cache = {
        ok: true,
        porCodigo: data.porCodigo || {},
        n: data.n || 0,
        ruta: data.ruta || "",
      };
      return _cache;
    } catch {
      _cache = { ok: false, porCodigo: {}, n: 0 };
      return _cache;
    } finally {
      _promise = null;
    }
  })();
  return _promise;
}

export function mapeoCache() {
  return _cache;
}

/**
 * Familia de códigos equivalentes para un PR…
 * @returns {{ codigos: string[], meta: object|null }}
 */
export function familiaDe(codigo) {
  const c = String(codigo || "").trim();
  if (!c) return { codigos: [], meta: null };
  const meta = _cache?.porCodigo?.[c] || null;
  if (!meta) return { codigos: [c], meta: null };
  const set = new Set(
    [meta.codigo_viejo, meta.codigo_nuevo, c].filter(Boolean).map((x) => String(x).trim())
  );
  return { codigos: [...set], meta };
}

/** Also | Ferros según código en el mapeo; si no, heurística por prefijo OT. */
export function etiquetaEmpresaParaCodigo(codigo, meta = null, ot = "") {
  const c = String(codigo || "").trim();
  const m = meta || _cache?.porCodigo?.[c] || null;
  if (m) {
    if (c === m.codigo_viejo) return "Also";
    if (c === m.codigo_nuevo) return "Ferros";
  }
  const otS = String(ot || "").toUpperCase();
  if (otS.startsWith("FCA") || otS.includes("FCA")) return "Ferros";
  if (otS.startsWith("AC") || otS.startsWith("PR")) return "Also";
  // Códigos Ferros del bot suelen ser PR00000159…
  if (/^PR00000159/.test(c)) return "Ferros";
  if (/^PR000000/.test(c)) return "Also";
  return "";
}

/**
 * Índice compacto compra/venta por código a partir de un Map de fichas.
 * Se guarda por empresa para poder concatenar históricos Also+Ferros.
 */
export function construirIndiceHistorialArticulos(fichasMap) {
  const compra = {};
  const venta = {};
  if (!fichasMap) return { compra, venta };

  for (const f of fichasMap.values()) {
    const ot = f.numeroOT || "";
    const reales = (f.compra?.comprasReales?.lineas || []).map((l) => ({
      ...l,
      origen: "PC · compra real",
    }));
    const ofertas = (f.compra?.soloOfertas?.lineas || []).map((l) => ({
      ...l,
      origen: "OC · oferta",
    }));
    for (const l of [...reales, ...ofertas]) {
      const cod = String(l.numero || "").trim();
      if (!cod) continue;
      (compra[cod] ||= []).push({
        ot,
        proveedor: l.proveedor || "",
        origen: l.origen,
        numeroDocumento: l.numeroDocumento || null,
        descripcion: l.descripcion || "",
        cantidad: Number(l.cantidad) || 0,
        costeUnitario: Number(l.costeUnitario) || 0,
        importe: Number(l.importe) || 0,
        fechaPedido: l.fechaPedido || null,
        dtos: Array.isArray(l.dtos) ? l.dtos : [0, 0, 0],
        codigoLinea: cod,
      });
    }
    for (const l of f.venta?.materiales?.lineas || []) {
      const cod = String(l.numero || "").trim();
      if (!cod) continue;
      (venta[cod] ||= []).push({
        ot,
        cliente: f.general?.cliente || "",
        numeroDocumento: l.numeroDocumento || null,
        descripcion: l.descripcion || "",
        cantidad: Number(l.cantidad) || 0,
        precioUnitario: Number(l.precioUnitario) || 0,
        importe: Number(l.importe) || 0,
        fechaPedido: l.fechaPedido || null,
        dtos: Array.isArray(l.dtos) ? l.dtos : [0, 0, 0],
        codigoLinea: cod,
      });
    }
  }
  return { compra, venta };
}

export function slugEmpresaIndice() {
  try {
    const e = JSON.parse(localStorage.getItem("agente_ventas_empresa_v1") || "null");
    if (e && e.id && !e.porDefecto && /ferros/i.test(`${e.nombre || ""} ${e.displayName || ""}`)) {
      return "ferros";
    }
  } catch {}
  return "also";
}
