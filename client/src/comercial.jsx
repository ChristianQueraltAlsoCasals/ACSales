/**
 * comercial.jsx — Seguimiento comercial.
 *
 * Clientes nuevos, correos que se les envían y presupuestos con la tarifa.
 * Se guarda en Postgres (por empresa) y una copia en el navegador.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Briefcase, Mail, Plus, Search, Send, Tag, Trash2, X } from "lucide-react";
import { htmlPerEnviar } from "./correo.jsx";
import { empresaGuardada, esEmpresaQuimlab } from "./empresa.jsx";
import { adaptarTarifasAPI } from "./agenteInteligente.js";

const LS = "acsales.comercial.v1";

const ESTADOS = [
  { id: "nuevo", label: "Nuevo", cls: "bg-slate-100 text-slate-700" },
  { id: "contactado", label: "Contactado", cls: "bg-sky-100 text-sky-800" },
  { id: "presupuesto", label: "Presupuesto", cls: "bg-amber-100 text-amber-900" },
  { id: "negociacion", label: "Negociación", cls: "bg-violet-100 text-violet-800" },
  { id: "ganado", label: "Ganado", cls: "bg-emerald-100 text-emerald-800" },
  { id: "perdido", label: "Perdido", cls: "bg-rose-100 text-rose-700" },
];

const SECTORES = [
  { id: "hoteles", nombre: "Hoteles y resorts", servicios: "Agua potable, Legionella, piscinas y spas", prioridad: "Muy alta" },
  { id: "residencias", nombre: "Residencias de mayores", servicios: "Agua sanitaria, Legionella y potabilidad", prioridad: "Muy alta" },
  { id: "hospitales", nombre: "Hospitales y clínicas", servicios: "Agua sanitaria, Legionella y controles microbiológicos", prioridad: "Muy alta" },
  { id: "alimentaria", nombre: "Industria alimentaria", servicios: "Agua de proceso, potabilidad y microbiología", prioridad: "Muy alta" },
  { id: "quimica", nombre: "Industria química", servicios: "Aguas de proceso, vertidos y contaminantes", prioridad: "Muy alta" },
  { id: "campings", nombre: "Campings", servicios: "Agua potable, piscinas y Legionella", prioridad: "Muy alta" },
  { id: "ayuntamientos", nombre: "Ayuntamientos", servicios: "Abastecimiento, fuentes y equipamientos municipales", prioridad: "Muy alta" },
  { id: "edar", nombre: "Depuradoras (EDAR)", servicios: "Aguas residuales, DQO, DBO5 y sólidos", prioridad: "Muy alta" },
  { id: "mantenimiento", nombre: "Empresas de mantenimiento", servicios: "Subcontratación de análisis de agua y Legionella", prioridad: "Muy alta" },
  { id: "comunidades", nombre: "Comunidades de propietarios", servicios: "Piscinas y determinadas instalaciones de riesgo", prioridad: "Alta" },
  { id: "gimnasios", nombre: "Gimnasios y centros deportivos", servicios: "Piscinas, duchas, spas y Legionella", prioridad: "Alta" },
  { id: "farmaceutica", nombre: "Industria farmacéutica", servicios: "Agua purificada y controles microbiológicos", prioridad: "Alta" },
  { id: "lavaderos", nombre: "Lavaderos de vehículos", servicios: "Aguas de vertido y sistemas de aerosolización", prioridad: "Alta" },
  { id: "ganaderas", nombre: "Explotaciones ganaderas", servicios: "Agua para animales, pozos y calidad microbiológica", prioridad: "Alta" },
  { id: "agricultura", nombre: "Agricultura y regadío", servicios: "Salinidad, nitratos, pH y calidad del agua de riego", prioridad: "Alta" },
  { id: "bodegas", nombre: "Bodegas y cervecerías", servicios: "Agua de proceso, limpieza y vertidos", prioridad: "Alta" },
  { id: "papelera", nombre: "Industria papelera", servicios: "Agua industrial, circuitos y vertidos", prioridad: "Alta" },
  { id: "comerciales", nombre: "Centros comerciales", servicios: "Agua sanitaria, torres de refrigeración y Legionella", prioridad: "Alta" },
  { id: "golf", nombre: "Campos de golf", servicios: "Riego, balsas y Legionella en instalaciones aplicables", prioridad: "Media-alta" },
  { id: "constructoras", nombre: "Constructoras", servicios: "Caracterización de aguas y controles de obra", prioridad: "Media" },
];

const PRIORIDAD_CLS = {
  "Muy alta": "bg-rose-100 text-rose-800",
  "Alta": "bg-amber-100 text-amber-900",
  "Media-alta": "bg-sky-100 text-sky-800",
  "Media": "bg-slate-100 text-slate-700",
};

function sectorDe(id) {
  return SECTORES.find((s) => s.id === id) || null;
}

function interesAlElegirSector(interesActual, sectorAnterior, sectorNuevo) {
  const prev = sectorDe(sectorAnterior);
  const next = sectorDe(sectorNuevo);
  const vacioOPlantilla = !String(interesActual || "").trim() || (prev && interesActual === prev.servicios);
  if (vacioOPlantilla) return next?.servicios || "";
  return interesActual || "";
}

const ESTADOS_PRES = [
  { id: "borrador", label: "Borrador", cls: "bg-slate-100 text-slate-700" },
  { id: "enviado", label: "Enviado", cls: "bg-sky-100 text-sky-800" },
  { id: "aceptado", label: "Aceptado", cls: "bg-emerald-100 text-emerald-800" },
  { id: "rechazado", label: "Rechazado", cls: "bg-rose-100 text-rose-700" },
];

const VACIO = { contactos: [], tarifa: [], presupuestos: [], actualizado: null };

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sumarDias(iso, n) {
  const base = iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : hoyISO();
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function fmtFecha(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function fmtCuando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const eur = (n) =>
  (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

function numeroInput(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function sanear(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  return {
    contactos: Array.isArray(b.contactos) ? b.contactos : [],
    tarifa: Array.isArray(b.tarifa) ? b.tarifa : [],
    presupuestos: Array.isArray(b.presupuestos) ? b.presupuestos : [],
    actualizado: b.actualizado || null,
  };
}

function claveLocalComercial() {
  const e = empresaGuardada();
  return `${LS}.${e?.id || "quimlab"}`;
}

export function cargarComercial() {
  if (!esEmpresaQuimlab()) return { contactos: [], tarifa: [], presupuestos: [], actualizado: null };
  try {
    const propio = localStorage.getItem(claveLocalComercial());
    const raw = propio || localStorage.getItem(LS);
    return sanear(JSON.parse(raw || "null"));
  } catch { return { contactos: [], tarifa: [], presupuestos: [], actualizado: null }; }
}

function guardarLocal(doc) {
  if (!esEmpresaQuimlab()) return true;
  try { localStorage.setItem(claveLocalComercial(), JSON.stringify(doc)); return true; }
  catch { return false; }
}

function cerrado(c) {
  return c?.estado === "ganado" || c?.estado === "perdido";
}

function nombreEmpresa() {
  const e = empresaGuardada();
  return e?.displayName || e?.nombre || "Also Casals";
}

function etiquetaEstado(id) {
  return ESTADOS.find((e) => e.id === id) || ESTADOS[0];
}

function etiquetaPres(id) {
  return ESTADOS_PRES.find((e) => e.id === id) || ESTADOS_PRES[0];
}

function importeLinea(l) {
  const base = (Number(l.cantidad) || 0) * (Number(l.precio) || 0);
  const dto = Math.min(100, Math.max(0, Number(l.dto) || 0));
  return base * (1 - dto / 100);
}

function totalPresupuesto(p) {
  return (p?.lineas || []).reduce((s, l) => s + importeLinea(l), 0);
}

function siguienteNumero(presupuestos) {
  const year = new Date().getFullYear();
  let max = 0;
  for (const p of presupuestos || []) {
    const m = new RegExp(`^P-${year}-(\\d+)$`).exec(p.numero || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${year}-${String(max + 1).padStart(3, "0")}`;
}

function esGeneral(codigoVenta) {
  const s = String(codigoVenta || "").trim().toUpperCase();
  return !s || s === "ALL" || s === "*" || s === "TODOS";
}

function unidadFila(fila) {
  if (!fila || typeof fila !== "object") return "ud";
  for (const [k, v] of Object.entries(fila)) {
    if (/unit_of_measure/i.test(k) && v != null && String(v).trim()) return String(v).trim();
  }
  return "ud";
}

/** Un precio por artículo. Si hay precio general y de cliente, se queda el general. */
export function articulosDesdeTarifaBc(filas) {
  const adaptadas = adaptarTarifasAPI(filas);
  const mapa = new Map();
  adaptadas.forEach((t, i) => {
    const codigo = String(t.numero || "").trim();
    if (!codigo || !(Number(t.precio) > 0)) return;
    const general = esGeneral(t.codigoVenta);
    const item = {
      codigo,
      descripcion: String(t.descripcion || "").trim() || codigo,
      unidad: unidadFila(filas[i]),
      precio: Number(t.precio),
      familia: general ? "General" : (String(t.codigoVenta || "").trim() || "Cliente"),
      general,
      fecha: String(t.fechaInicio || ""),
    };
    const prev = mapa.get(codigo.toLowerCase());
    const mejor = !prev
      || (item.general && !prev.general)
      || (item.general === prev.general && item.fecha >= prev.fecha);
    if (mejor) mapa.set(codigo.toLowerCase(), item);
  });
  return [...mapa.values()].map(({ general, fecha, ...rest }) => rest);
}

function fusionarTarifa(prev, traidas) {
  const tarifa = prev.map((t) => ({ ...t }));
  const idx = new Map(tarifa.map((t, i) => [String(t.codigo || "").toLowerCase(), i]));
  let nuevas = 0;
  let actualizadas = 0;
  for (const t of traidas) {
    const k = t.codigo.toLowerCase();
    const i = idx.get(k);
    if (i != null) {
      actualizadas += 1;
      tarifa[i] = {
        ...tarifa[i],
        descripcion: t.descripcion || tarifa[i].descripcion,
        precio: t.precio,
        unidad: t.unidad || tarifa[i].unidad,
        familia: t.familia || tarifa[i].familia,
        origen: "bc",
      };
    } else {
      nuevas += 1;
      idx.set(k, tarifa.length);
      tarifa.push({ id: uid(), origen: "bc", ...t });
    }
  }
  return { tarifa, nuevas, actualizadas };
}

const ALIAS_EXCEL = {
  codigo: ["codigo", "code", "ref", "referencia", "n", "no", "num"],
  descripcion: ["descripcion", "description", "nombre", "articulo"],
  unidad: ["unidad", "ud", "um", "unit"],
  precio: ["precio", "pvp", "tarifa", "importe", "price"],
  familia: ["familia", "grupo", "family"],
};

function aliasCabeceraExcel(texto) {
  const n = norm(texto).replace(/[º°.#€]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return "";
  const compacto = n.replace(/\s+/g, "");
  const primera = n.split(" ")[0];
  for (const [campo, alias] of Object.entries(ALIAS_EXCEL)) {
    if (alias.includes(compacto) || alias.includes(primera)) return campo;
  }
  return "";
}

function precioExcel(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  return numeroInput(String(v ?? "").replace(/€/g, ""));
}

function celdasFila(fila) {
  if (Array.isArray(fila)) return fila;
  if (fila && typeof fila === "object") return Object.values(fila);
  return [];
}

/** Primera hoja. Con cabecera reconocible usa los nombres; si no, el orden código, descripción, unidad, precio, familia. */
export function filasTarifaDesdeMatriz(matriz) {
  const filas = (matriz || []).map(celdasFila).filter((f) => f.some((c) => String(c ?? "").trim() !== ""));
  if (!filas.length) return [];
  const cabecera = {};
  filas[0].forEach((celda, i) => {
    const campo = aliasCabeceraExcel(celda);
    if (campo && cabecera[campo] == null) cabecera[campo] = i;
  });
  const conCabecera = cabecera.codigo != null || cabecera.descripcion != null || cabecera.precio != null;
  const datos = conCabecera ? filas.slice(1) : filas;
  const col = conCabecera
    ? cabecera
    : { codigo: 0, descripcion: 1, unidad: 2, precio: 3, familia: 4 };
  const leer = (fila, campo) => (col[campo] == null ? "" : fila[col[campo]]);
  const salida = [];
  for (const fila of datos) {
    const codigo = String(leer(fila, "codigo") ?? "").trim();
    const descripcion = String(leer(fila, "descripcion") ?? "").trim();
    const precio = precioExcel(leer(fila, "precio"));
    if ((!codigo && !descripcion) || !(precio > 0)) continue;
    const unidad = String(leer(fila, "unidad") ?? "").trim() || "ud";
    const familia = String(leer(fila, "familia") ?? "").trim() || "General";
    salida.push({ codigo, descripcion: descripcion || codigo, unidad, precio, familia, origen: "excel" });
  }
  return salida;
}

function fusionarExcel(prev, traidas) {
  const tarifa = prev.map((t) => ({ ...t }));
  const idx = new Map();
  tarifa.forEach((t, i) => {
    const k = String(t.codigo || "").trim().toLowerCase();
    if (k) idx.set(k, i);
  });
  let nuevas = 0;
  let actualizadas = 0;
  for (const t of traidas) {
    const k = String(t.codigo || "").trim().toLowerCase();
    const i = k ? idx.get(k) : undefined;
    if (i != null) {
      actualizadas += 1;
      tarifa[i] = {
        ...tarifa[i],
        descripcion: t.descripcion || tarifa[i].descripcion,
        unidad: t.unidad || tarifa[i].unidad || "ud",
        precio: t.precio,
        familia: t.familia || tarifa[i].familia || "General",
        origen: "excel",
      };
    } else {
      nuevas += 1;
      const item = { id: uid(), ...t };
      if (k) idx.set(k, tarifa.length);
      tarifa.push(item);
    }
  }
  return { tarifa, nuevas, actualizadas };
}

async function leerTarifaExcel(file) {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  if (!hoja) return [];
  const matriz = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "", raw: true });
  return filasTarifaDesdeMatriz(matriz);
}

function plantillaPresentacion(c) {
  const saludo = c.contacto ? `Buenos días ${c.contacto},` : "Buenos días,";
  const sec = sectorDe(c.sector);
  const oferta = sec
    ? `Trabajamos con ${sec.nombre.toLowerCase()} y podemos ofrecerle: ${sec.servicios}.`
    : "Quería presentarle nuestros productos y servicios por si podemos ayudarle en algún trabajo.";
  const pista = c.interes && (!sec || c.interes !== sec.servicios)
    ? `\n\nComo punto de partida he apuntado: ${c.interes}.`
    : "";
  return `${saludo}\n\nLe escribo desde ${nombreEmpresa()}. ${oferta}${pista}\n\nSi le encaja, le preparo un presupuesto, sin compromiso.`;
}

function plantillaSeguimiento(c) {
  const saludo = c.contacto ? `Buenos días ${c.contacto},` : "Buenos días,";
  return `${saludo}\n\nLe retomo el contacto para saber si ha podido revisar la información que le envié. Sigo a su disposición para preparar o ajustar un presupuesto.`;
}

function cuerpoPresupuesto(p) {
  const lineas = (p.lineas || []).map((l) => {
    const dto = Number(l.dto) > 0 ? ` (dto ${Number(l.dto)} %)` : "";
    const cod = l.codigo ? `${l.codigo} · ` : "";
    return `${cod}${l.descripcion || "Producto"} — ${Number(l.cantidad) || 0} ${l.unidad || "ud"} × ${eur(l.precio)}${dto} = ${eur(importeLinea(l))}`;
  }).join("\n");
  const quien = p.clienteNombre ? ` para ${p.clienteNombre}` : "";
  return [
    "Buenos días,",
    "",
    `Le envío el presupuesto ${p.numero}${quien}.`,
    "",
    lineas || "(sin líneas)",
    "",
    `Total: ${eur(totalPresupuesto(p))}`,
    p.validez ? `Válido hasta el ${fmtFecha(p.validez)}.` : "",
    p.notas ? "" : null,
    p.notas || null,
    "",
    "Si quiere cambiar cantidades o productos, lo ajusto y se lo reenvío.",
  ].filter((x) => x != null).join("\n");
}

export function resumenComercialParaIA() {
  if (!esEmpresaQuimlab()) return "";
  const { contactos, presupuestos } = cargarComercial();
  const hoy = hoyISO();
  const revisar = contactos.filter((c) => !cerrado(c) && c.proximo && c.proximo <= hoy);
  const lineas = revisar.slice(0, 12).map((c) =>
    `- ${c.empresa || c.contacto || "Sin nombre"} · ${etiquetaEstado(c.estado).label} · seguimiento ${c.proximo}${c.email ? " · " + c.email : ""}`);
  const abiertos = (presupuestos || []).filter((p) => p.estado === "borrador" || p.estado === "enviado");
  const pres = abiertos.slice(0, 8).map((p) =>
    `- ${p.numero} ${p.clienteNombre || ""} · ${etiquetaPres(p.estado).label} · ${eur(totalPresupuesto(p))}`);
  const sinCliente = SECTORES.filter((s) => s.prioridad === "Muy alta" && !contactos.some((c) => c.sector === s.id));
  return [
    `Comercial: ${contactos.length} clientes, ${revisar.length} seguimientos para hoy o atrasados.`,
    lineas.length ? lineas.join("\n") : "(sin seguimientos pendientes)",
    "Presupuestos abiertos:",
    pres.length ? pres.join("\n") : "(ninguno)",
    `Sectores de prioridad muy alta todavía sin cliente (${sinCliente.length}): ${sinCliente.map((s) => s.nombre).join(", ") || "ninguno"}.`,
  ].join("\n");
}

function Campo({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Insignia({ cls, children }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function Aviso({ tipo, texto, onCerrar }) {
  if (!texto) return null;
  const rojo = tipo === "error";
  return (
    <div className={`mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-[13px] ${rojo ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
      <span>{texto}</span>
      {onCerrar && (
        <button type="button" onClick={onCerrar} className="shrink-0 px-1 py-0" aria-label="Cerrar aviso">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export default function Comercial({ tarifasBc = [] }) {
  const [datos, setDatos] = useState(cargarComercial);
  const [listo, setListo] = useState(false);
  const [sync, setSync] = useState("cargando");
  const [tab, setTab] = useState("seguimiento");
  const [filtro, setFiltro] = useState("activos");
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState(null);
  const [alta, setAlta] = useState(null);
  const [correo, setCorreo] = useState(null);
  const [borrarId, setBorrarId] = useState(null);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const [presId, setPresId] = useState(null);

  useEffect(() => {
    if (!esEmpresaQuimlab()) { setListo(true); return; }
    let vivo = true;
    (async () => {
      const local = cargarComercial();
      try {
        const r = await fetch("/api/comercial");
        if (!r.ok) throw new Error("sin-api");
        const remoto = sanear(await r.json());
        if (!vivo) return;
        if ((local.actualizado || "") > (remoto.actualizado || "")) {
          setDatos(local);
          const guarda = await fetch("/api/comercial", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(local),
          });
          if (vivo) setSync(guarda.ok ? "guardado" : "local");
        } else {
          setDatos(remoto);
          guardarLocal(remoto);
          if (vivo) setSync("guardado");
        }
      } catch {
        if (vivo) {
          setDatos(local);
          setSync("local");
        }
      } finally {
        if (vivo) setListo(true);
      }
    })();
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (!listo || !esEmpresaQuimlab()) return;
    const doc = { ...datos, actualizado: new Date().toISOString() };
    if (!guardarLocal(doc)) setError("No cabe en este navegador. Borra productos de la tarifa que no uses.");
    const t = setTimeout(() => {
      fetch("/api/comercial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      })
        .then((r) => setSync(r.ok ? "guardado" : "local"))
        .catch(() => setSync("local"));
    }, 600);
    return () => clearTimeout(t);
  }, [datos, listo]);

  const hoy = hoyISO();
  const contactos = datos.contactos || [];
  const tarifa = datos.tarifa || [];
  const presupuestos = datos.presupuestos || [];

  const activos = contactos.filter((c) => !cerrado(c));
  const revisar = activos.filter((c) => c.proximo && c.proximo <= hoy);
  const presAbiertos = presupuestos.filter((p) => p.estado === "borrador" || p.estado === "enviado");
  const importeAbierto = presAbiertos.reduce((s, p) => s + totalPresupuesto(p), 0);

  const lista = useMemo(() => {
    const nq = norm(q);
    return contactos
      .filter((c) => {
        if (filtro === "activos" && cerrado(c)) return false;
        if (filtro === "revisar" && !(!cerrado(c) && c.proximo && c.proximo <= hoy)) return false;
        if (ESTADOS.some((e) => e.id === filtro) && c.estado !== filtro) return false;
        if (!nq) return true;
        return norm([c.empresa, c.contacto, c.email, c.telefono, c.interes, c.notas, sectorDe(c.sector)?.nombre].join(" ")).includes(nq);
      })
      .sort((a, b) => {
        const rank = (c) => {
          if (!cerrado(c) && c.proximo && c.proximo < hoy) return 0;
          if (!cerrado(c) && c.proximo === hoy) return 1;
          if (!cerrado(c) && c.proximo) return 2;
          if (!cerrado(c)) return 3;
          return 4;
        };
        const d = rank(a) - rank(b);
        if (d) return d;
        if ((a.proximo || "9999") !== (b.proximo || "9999")) return (a.proximo || "9999") < (b.proximo || "9999") ? -1 : 1;
        return (a.empresa || a.contacto || "").localeCompare(b.empresa || b.contacto || "", "es");
      });
  }, [contactos, filtro, q, hoy]);

  const seleccionado = contactos.find((c) => c.id === selId) || null;

  const patchContacto = (id, campos) => {
    setDatos((prev) => ({
      ...prev,
      contactos: prev.contactos.map((c) => (c.id === id ? { ...c, ...campos } : c)),
    }));
  };

  const crearContacto = () => {
    const empresa = String(alta?.empresa || "").trim();
    const contacto = String(alta?.contacto || "").trim();
    if (!empresa && !contacto) {
      setError("Escribe al menos la empresa o la persona.");
      return;
    }
    const nuevo = {
      id: uid(),
      empresa,
      contacto,
      email: String(alta?.email || "").trim(),
      telefono: String(alta?.telefono || "").trim(),
      interes: String(alta?.interes || "").trim(),
      sector: String(alta?.sector || "").trim(),
      estado: "nuevo",
      proximo: sumarDias(hoy, 1),
      notas: "",
      correos: [],
      creado: new Date().toISOString(),
    };
    setDatos((prev) => ({ ...prev, contactos: [nuevo, ...prev.contactos] }));
    setSelId(nuevo.id);
    setAlta(null);
    setError("");
    setAviso(`Cliente añadido. El próximo seguimiento queda para el ${fmtFecha(nuevo.proximo)}.`);
  };

  const borrarContacto = (id) => {
    setDatos((prev) => ({ ...prev, contactos: prev.contactos.filter((c) => c.id !== id) }));
    if (selId === id) setSelId(null);
    setBorrarId(null);
    setCorreo(null);
  };

  const registrarEnvio = ({ contactoId, presupuestoId, para, asunto, cuerpo, proximo }) => {
    const entrada = {
      id: uid(),
      fecha: new Date().toISOString(),
      para,
      asunto,
      cuerpo,
      presupuestoNumero: "",
    };
    setDatos((prev) => {
      const pres = prev.presupuestos.map((p) => {
        if (p.id !== presupuestoId) return p;
        entrada.presupuestoNumero = p.numero || "";
        return { ...p, estado: p.estado === "borrador" ? "enviado" : p.estado };
      });
      const contactosNext = prev.contactos.map((c) => {
        if (c.id !== contactoId) return c;
        let estado = c.estado;
        if (estado !== "ganado" && estado !== "perdido") {
          if (presupuestoId) estado = "presupuesto";
          else if (estado === "nuevo") estado = "contactado";
        }
        return {
          ...c,
          estado,
          proximo: proximo || c.proximo,
          correos: [entrada, ...(c.correos || [])],
        };
      });
      return { ...prev, contactos: contactosNext, presupuestos: pres };
    });
    setCorreo(null);
    setAviso(`Correo enviado a ${para}.`);
    setError("");
  };

  const abrirPresupuesto = (contacto) => {
    const hoyLocal = hoyISO();
    const nuevo = {
      id: uid(),
      numero: siguienteNumero(presupuestos),
      contactoId: contacto?.id || "",
      clienteNombre: contacto?.empresa || contacto?.contacto || "",
      email: contacto?.email || "",
      fecha: hoyLocal,
      validez: sumarDias(hoyLocal, 30),
      estado: "borrador",
      notas: "",
      lineas: [],
      creado: new Date().toISOString(),
    };
    setDatos((prev) => ({ ...prev, presupuestos: [nuevo, ...prev.presupuestos] }));
    setPresId(nuevo.id);
    setTab("presupuestos");
    setCorreo(null);
  };

  const ultimoPresupuesto = (contactoId) =>
    presupuestos.find((p) => p.contactoId === contactoId && p.estado !== "rechazado") || null;

  if (!esEmpresaQuimlab()) return null;

  if (!listo) {
    return (
      <div>
        <h1 className="bc-page-title">Comercial</h1>
        <p className="bc-page-sub">Cargando el seguimiento…</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="bc-page-title flex items-center gap-2">
            <Briefcase size={22} className="text-cyan-700" />
            Comercial
          </h1>
          <p className="bc-page-sub">
            Clientes nuevos, correos comerciales y presupuestos con tu tarifa. El seguimiento se guarda en ACSales
            {sync === "local" ? " (ahora solo en este navegador: no hay conexión con el servidor)." : "."}
          </p>
        </div>
      </div>

      <Aviso tipo="ok" texto={aviso} onCerrar={() => setAviso("")} />
      <Aviso tipo="error" texto={error} onCerrar={() => setError("")} />

      <div className="bc-cue-row">
        <div role="button" tabIndex={0} className="bc-cue cursor-pointer text-left" onClick={() => { setTab("seguimiento"); setFiltro("activos"); }} onKeyDown={(e) => { if (e.key === "Enter") { setTab("seguimiento"); setFiltro("activos"); } }}>
          <div className="bc-cue-valor">{activos.length}</div>
          <div className="bc-cue-label">En seguimiento</div>
        </div>
        <div role="button" tabIndex={0} className="bc-cue cursor-pointer text-left" onClick={() => { setTab("seguimiento"); setFiltro("revisar"); }} onKeyDown={(e) => { if (e.key === "Enter") { setTab("seguimiento"); setFiltro("revisar"); } }}>
          <div className="bc-cue-valor">{revisar.length}</div>
          <div className="bc-cue-label">A revisar hoy</div>
        </div>
        <div role="button" tabIndex={0} className="bc-cue cursor-pointer text-left" onClick={() => { setTab("presupuestos"); setPresId(null); }} onKeyDown={(e) => { if (e.key === "Enter") { setTab("presupuestos"); setPresId(null); } }}>
          <div className="bc-cue-valor">{presAbiertos.length}</div>
          <div className="bc-cue-label">Presupuestos abiertos</div>
        </div>
        <div className="bc-cue">
          <div className="bc-cue-valor">{eur(importeAbierto)}</div>
          <div className="bc-cue-label">Importe abierto</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        {[
          ["seguimiento", "Seguimiento"],
          ["sectores", "Sectores"],
          ["tarifa", "Tarifa"],
          ["presupuestos", "Presupuestos"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => { setTab(id); if (id !== "presupuestos") setPresId(null); }}
            className={tab === id ? "boto-primari" : ""}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "seguimiento" && correo && correo.contactoId !== seleccionado?.id && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
          <Compositor
            key={`${correo.presupuestoId || ""}|${correo.asunto}`}
            inicial={correo}
            onCerrar={() => setCorreo(null)}
            onEnviado={registrarEnvio}
          />
        </div>
      )}

      {tab === "seguimiento" && (
        <div className="com-layout mt-4">
          <div className="rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar cliente, correo…"
                  className="w-full pl-8"
                />
              </div>
              <button type="button" className="boto-primari shrink-0" onClick={() => { setAlta({ empresa: "", contacto: "", email: "", telefono: "", interes: "", sector: "" }); setError(""); }}>
                <Plus size={16} className="inline" /> Nuevo
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {[
                ["activos", "En curso"],
                ["revisar", `A revisar${revisar.length ? ` (${revisar.length})` : ""}`],
                ["todos", "Todos"],
                ...ESTADOS.map((e) => [e.id, e.label]),
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFiltro(id)}
                  className={`px-2 py-1 text-[12px] ${filtro === id ? "boto-primari" : ""}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {alta && (
              <div className="mt-3 space-y-2 rounded-lg border border-cyan-200 bg-cyan-50/50 p-3">
                <Campo label="Empresa">
                  <input className="w-full" value={alta.empresa} onChange={(e) => setAlta({ ...alta, empresa: e.target.value })} />
                </Campo>
                <Campo label="Persona">
                  <input className="w-full" value={alta.contacto} onChange={(e) => setAlta({ ...alta, contacto: e.target.value })} />
                </Campo>
                <Campo label="Correo">
                  <input className="w-full" value={alta.email} onChange={(e) => setAlta({ ...alta, email: e.target.value })} placeholder="cliente@empresa.com" />
                </Campo>
                <Campo label="Teléfono">
                  <input className="w-full" value={alta.telefono} onChange={(e) => setAlta({ ...alta, telefono: e.target.value })} />
                </Campo>
                <Campo label="Sector">
                  <select
                    className="w-full"
                    value={alta.sector || ""}
                    onChange={(e) => {
                      const sector = e.target.value;
                      setAlta({
                        ...alta,
                        sector,
                        interes: interesAlElegirSector(alta.interes, alta.sector, sector),
                      });
                    }}
                  >
                    <option value="">Sin sector</option>
                    {SECTORES.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                  </select>
                </Campo>
                <Campo label="Qué necesita">
                  <input className="w-full" value={alta.interes} onChange={(e) => setAlta({ ...alta, interes: e.target.value })} />
                </Campo>
                <div className="flex gap-2 pt-1">
                  <button type="button" className="boto-primari" onClick={crearContacto}>Crear cliente</button>
                  <button type="button" onClick={() => setAlta(null)}>Cancelar</button>
                </div>
              </div>
            )}

            <div className="mt-3 max-h-[640px] space-y-1.5 overflow-auto">
              {!lista.length && (
                <p className="px-1 py-6 text-[13px] text-slate-500">
                  {contactos.length
                    ? "Ningún cliente coincide con este filtro."
                    : "Todavía no hay clientes. Añade el primero: empresa, persona y correo. Desde su ficha le escribes y le preparas el presupuesto."}
                </p>
              )}
              {lista.map((c) => {
                const est = etiquetaEstado(c.estado);
                const atrasado = !cerrado(c) && c.proximo && c.proximo < hoy;
                const esHoy = !cerrado(c) && c.proximo === hoy;
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setSelId(c.id); setCorreo(null); setBorrarId(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setSelId(c.id); setCorreo(null); } }}
                    className={`cursor-pointer rounded-lg border px-3 py-2 ${selId === c.id ? "border-cyan-600 bg-cyan-50/70" : "border-slate-200 bg-white hover:border-cyan-300"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-slate-800">{c.empresa || c.contacto || "Sin nombre"}</div>
                        {c.empresa && c.contacto && <div className="truncate text-[12px] text-slate-500">{c.contacto}</div>}
                        {sectorDe(c.sector) && <div className="truncate text-[11px] text-cyan-800">{sectorDe(c.sector).nombre}</div>}
                      </div>
                      <Insignia cls={est.cls}>{est.label}</Insignia>
                    </div>
                    <div className={`mt-1 text-[12px] ${atrasado ? "font-semibold text-red-700" : esHoy ? "font-semibold text-amber-700" : "text-slate-500"}`}>
                      {c.proximo ? `Seguimiento ${fmtFecha(c.proximo)}` : "Sin fecha de seguimiento"}
                      {(c.correos || []).length ? ` · ${c.correos.length} correo${c.correos.length === 1 ? "" : "s"}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
            {!seleccionado && (
              <p className="py-10 text-center text-[13px] text-slate-500">
                Elige un cliente o crea uno nuevo. Desde su ficha envías el correo y montas el presupuesto con la tarifa.
              </p>
            )}
            {seleccionado && (
              <Ficha
                contacto={seleccionado}
                presupuesto={ultimoPresupuesto(seleccionado.id)}
                correo={correo}
                borrarId={borrarId}
                onPatch={(campos) => patchContacto(seleccionado.id, campos)}
                onCorreo={setCorreo}
                onEnviado={registrarEnvio}
                onPresupuesto={() => abrirPresupuesto(seleccionado)}
                onPedirBorrar={() => setBorrarId(seleccionado.id)}
                onCancelarBorrar={() => setBorrarId(null)}
                onBorrar={() => borrarContacto(seleccionado.id)}
                onError={setError}
              />
            )}
          </div>
        </div>
      )}

      {tab === "sectores" && (
        <Sectores
          contactos={contactos}
          onAbrir={(id) => { setSelId(id); setTab("seguimiento"); setCorreo(null); }}
          onNuevo={(sectorId) => {
            const sec = sectorDe(sectorId);
            setAlta({ empresa: "", contacto: "", email: "", telefono: "", interes: sec?.servicios || "", sector: sectorId || "" });
            setSelId(null);
            setTab("seguimiento");
            setError("");
          }}
        />
      )}

      {tab === "tarifa" && (
        <Tarifa
          tarifa={tarifa}
          tarifasBc={tarifasBc}
          onChange={(next, mensaje) => {
            setDatos((prev) => ({ ...prev, tarifa: next }));
            if (mensaje) { setAviso(mensaje); setError(""); }
          }}
          onError={setError}
        />
      )}

      {tab === "presupuestos" && (
        <Presupuestos
          presupuestos={presupuestos}
          tarifa={tarifa}
          contactos={contactos}
          presId={presId}
          onElegir={setPresId}
          onChange={(next) => setDatos((prev) => ({ ...prev, presupuestos: next }))}
          onContacto={(contactoId, campos) => { if (contactoId) patchContacto(contactoId, campos); }}
          onEnviar={(contacto, presupuesto) => {
            if (contacto) setSelId(contacto.id);
            setCorreo({
              contactoId: contacto?.id || presupuesto.contactoId || "",
              presupuestoId: presupuesto.id,
              para: presupuesto.email || contacto?.email || "",
              asunto: `Presupuesto ${presupuesto.numero}${presupuesto.clienteNombre ? " · " + presupuesto.clienteNombre : ""}`,
              cuerpo: cuerpoPresupuesto(presupuesto),
              proximo: sumarDias(hoy, 5),
            });
            setTab("seguimiento");
            setAviso("Revisa el correo del presupuesto y confírmalo para enviarlo.");
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function Ficha({ contacto, presupuesto, correo, borrarId, onPatch, onCorreo, onEnviado, onPresupuesto, onPedirBorrar, onCancelarBorrar, onBorrar, onError }) {
  const hoy = hoyISO();
  const est = etiquetaEstado(contacto.estado);
  const atrasado = !cerrado(contacto) && contacto.proximo && contacto.proximo < hoy;

  const aplazar = (dias) => {
    onPatch({
      proximo: sumarDias(hoy, dias),
      estado: contacto.estado === "nuevo" ? "contactado" : contacto.estado,
    });
  };

  const abrirCorreo = (modo) => {
    if (modo === "presupuesto" && !presupuesto) {
      onError("Primero crea un presupuesto para este cliente.");
      return;
    }
    if (modo === "presupuesto" && !(presupuesto.lineas || []).length) {
      onError("Este presupuesto no tiene productos. Ábrelo en Presupuestos y añade líneas de la tarifa.");
      return;
    }
    const cuerpo = modo === "presentacion"
      ? plantillaPresentacion(contacto)
      : modo === "seguimiento"
        ? plantillaSeguimiento(contacto)
        : cuerpoPresupuesto(presupuesto);
    const asunto = modo === "presupuesto"
      ? `Presupuesto ${presupuesto.numero}${contacto.empresa ? " · " + contacto.empresa : ""}`
      : modo === "seguimiento"
        ? `Seguimiento${contacto.empresa ? " · " + contacto.empresa : ""}`
        : `Presentación de ${nombreEmpresa()}`;
    onCorreo({
      contactoId: contacto.id,
      presupuestoId: modo === "presupuesto" ? presupuesto.id : "",
      para: contacto.email || "",
      asunto,
      cuerpo,
      proximo: sumarDias(hoy, modo === "presupuesto" ? 5 : 7),
    });
    onError("");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold text-slate-900">{contacto.empresa || contacto.contacto}</div>
          <div className="mt-1"><Insignia cls={est.cls}>{est.label}</Insignia></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="boto-primari" onClick={() => abrirCorreo("presentacion")}>
            <Mail size={15} className="mr-1 inline" /> Escribir correo
          </button>
          <button type="button" onClick={onPresupuesto}>
            <Tag size={15} className="mr-1 inline" /> Presupuesto
          </button>
        </div>
      </div>

      {correo?.contactoId === contacto.id && (
        <Compositor
          key={`${correo.presupuestoId || ""}|${correo.asunto}`}
          inicial={correo}
          onCerrar={() => onCorreo(null)}
          onEnviado={onEnviado}
        />
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Campo label="Empresa">
          <input className="w-full" value={contacto.empresa || ""} onChange={(e) => onPatch({ empresa: e.target.value })} />
        </Campo>
        <Campo label="Persona">
          <input className="w-full" value={contacto.contacto || ""} onChange={(e) => onPatch({ contacto: e.target.value })} />
        </Campo>
        <Campo label="Correo">
          <input className="w-full" value={contacto.email || ""} onChange={(e) => onPatch({ email: e.target.value })} />
        </Campo>
        <Campo label="Teléfono">
          <input className="w-full" value={contacto.telefono || ""} onChange={(e) => onPatch({ telefono: e.target.value })} />
        </Campo>
        <Campo label="Estado">
          <select className="w-full" value={contacto.estado || "nuevo"} onChange={(e) => onPatch({ estado: e.target.value })}>
            {ESTADOS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </Campo>
        <Campo label="Próximo seguimiento">
          <input type="date" className="w-full" value={(contacto.proximo || "").slice(0, 10)} onChange={(e) => onPatch({ proximo: e.target.value })} />
        </Campo>
        <div className="md:col-span-2">
          <Campo label="Sector">
            <select
              className="w-full"
              value={contacto.sector || ""}
              onChange={(e) => {
                const sector = e.target.value;
                onPatch({
                  sector,
                  interes: interesAlElegirSector(contacto.interes, contacto.sector, sector),
                });
              }}
            >
              <option value="">Sin sector</option>
              {SECTORES.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </Campo>
          {sectorDe(contacto.sector) && (
            <p className="mt-1 text-[12px] text-slate-500">Puedes ofrecer: {sectorDe(contacto.sector).servicios}</p>
          )}
        </div>
        <div className="md:col-span-2">
          <Campo label="Qué necesita">
            <input className="w-full" value={contacto.interes || ""} onChange={(e) => onPatch({ interes: e.target.value })} />
          </Campo>
        </div>
        <div className="md:col-span-2">
          <Campo label="Notas">
            <textarea className="w-full" rows={3} value={contacto.notas || ""} onChange={(e) => onPatch({ notas: e.target.value })} />
          </Campo>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Avisarme otra vez</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {[3, 7, 15, 30].map((d) => (
            <button key={d} type="button" onClick={() => aplazar(d)}>En {d} días</button>
          ))}
          {atrasado && <span className="self-center text-[12px] font-semibold text-red-700">Este seguimiento está atrasado.</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => abrirCorreo("seguimiento")}>Plantilla de seguimiento</button>
        <button type="button" onClick={() => abrirCorreo("presupuesto")} disabled={!presupuesto}>
          Enviar presupuesto {presupuesto ? presupuesto.numero : ""}
        </button>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Correos enviados</div>
        {!(contacto.correos || []).length && (
          <p className="mt-1 text-[13px] text-slate-500">Todavía no le has escrito desde aquí.</p>
        )}
        <div className="mt-2 space-y-2">
          {(contacto.correos || []).map((m) => (
            <details key={m.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <summary className="cursor-pointer text-[13px]">
                <span className="font-semibold text-slate-800">{m.asunto || "(sin asunto)"}</span>
                <span className="text-slate-500"> · {fmtCuando(m.fecha)} · {m.para}</span>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] text-slate-700">{m.cuerpo}</pre>
            </details>
          ))}
        </div>
      </div>

      {borrarId === contacto.id ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800">
          ¿Borrar este cliente del seguimiento? Los presupuestos ya hechos se quedan en la pestaña Presupuestos.
          <button type="button" className="boto-perill" onClick={onBorrar}>Borrar</button>
          <button type="button" onClick={onCancelarBorrar}>Cancelar</button>
        </div>
      ) : (
        <button type="button" className="boto-perill" onClick={onPedirBorrar}>
          <Trash2 size={14} className="mr-1 inline" /> Borrar cliente
        </button>
      )}
    </div>
  );
}

function Compositor({ inicial, onCerrar, onEnviado }) {
  const [para, setPara] = useState(inicial.para || "");
  const [asunto, setAsunto] = useState(inicial.asunto || "");
  const [cuerpo, setCuerpo] = useState(inicial.cuerpo || "");
  const [proximo, setProximo] = useState(inicial.proximo || sumarDias(hoyISO(), 7));
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState("");

  const destinatarios = String(para || "").split(/[;,]+/).map((s) => s.trim()).filter(Boolean);

  const enviar = async () => {
    if (!destinatarios.length || destinatarios.some((e) => !e.includes("@"))) {
      setErr("Falta un correo válido del destinatario.");
      setConfirmar(false);
      return;
    }
    if (!asunto.trim() || !cuerpo.trim()) {
      setErr("Faltan el asunto o el texto.");
      setConfirmar(false);
      return;
    }
    if (!confirmar) { setConfirmar(true); setErr(""); return; }
    setEnviando(true);
    setErr("");
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
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.detalle || d.error || "No se ha podido enviar.");
        setConfirmar(false);
        return;
      }
      onEnviado({
        contactoId: inicial.contactoId,
        presupuestoId: inicial.presupuestoId || "",
        para: destinatarios.join(", "),
        asunto: asunto.trim(),
        cuerpo,
        proximo,
      });
    } catch {
      setErr("No se ha podido conectar con el servidor.");
      setConfirmar(false);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-cyan-200 bg-cyan-50/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-cyan-800">Correo comercial</div>
        <button type="button" onClick={onCerrar} className="px-2 py-1">Cerrar</button>
      </div>
      <Campo label="Para">
        <input className="w-full" value={para} onChange={(e) => { setPara(e.target.value); setConfirmar(false); }} />
      </Campo>
      <Campo label="Asunto">
        <input className="w-full" value={asunto} onChange={(e) => { setAsunto(e.target.value); setConfirmar(false); }} />
      </Campo>
      <Campo label="Texto">
        <textarea className="w-full" rows={8} value={cuerpo} onChange={(e) => { setCuerpo(e.target.value); setConfirmar(false); }} />
      </Campo>
      <p className="text-[12px] text-slate-500">Se envía desde tu buzón, con la firma de siempre. El texto de arriba es lo que puedes cambiar.</p>
      <Campo label="Próximo seguimiento al enviar">
        <input type="date" value={proximo} onChange={(e) => setProximo(e.target.value)} />
      </Campo>
      {err && <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[12px] text-red-800">{err}</div>}
      <button type="button" className="boto-primari" disabled={enviando} onClick={enviar}>
        <Send size={14} className="mr-1 inline" />
        {enviando ? "Enviando…" : confirmar ? "Confirmar envío" : "Enviar"}
      </button>
    </div>
  );
}

function Sectores({ contactos, onAbrir, onNuevo }) {
  const [prioridad, setPrioridad] = useState("todas");
  const prioridades = ["todas", ...new Set(SECTORES.map((s) => s.prioridad))];
  const lista = SECTORES.filter((s) => prioridad === "todas" || s.prioridad === prioridad);
  const cubiertos = SECTORES.filter((s) => contactos.some((c) => c.sector === s.id)).length;

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Sectores a los que quieres llegar</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-500">
            {cubiertos} de {SECTORES.length} sectores ya tienen algún cliente en seguimiento. En cada fila está el servicio que puedes ofrecer.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {prioridades.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPrioridad(p)}
            className={`px-2 py-1 text-[12px] ${prioridad === p ? "boto-primari" : ""}`}
          >
            {p === "todas" ? "Todos" : p}
          </button>
        ))}
      </div>
      <div className="mt-3 overflow-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-2">Sector</th>
              <th className="py-2 pr-2">Qué puedes ofrecer</th>
              <th className="py-2 pr-2">Prioridad</th>
              <th className="py-2 pr-2">Clientes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lista.map((s) => {
              const delSector = contactos.filter((c) => c.sector === s.id);
              return (
                <tr key={s.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-semibold text-slate-800">{s.nombre}</td>
                  <td className="py-2 pr-3 text-slate-600">{s.servicios}</td>
                  <td className="py-2 pr-3">
                    <Insignia cls={PRIORIDAD_CLS[s.prioridad] || PRIORIDAD_CLS.Media}>{s.prioridad}</Insignia>
                  </td>
                  <td className="py-2 pr-3">
                    {delSector.length ? (
                      <div className="space-y-1">
                        {delSector.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="block border-0 bg-transparent px-0 py-0 text-left text-[13px] text-cyan-800 shadow-none"
                            onClick={() => onAbrir(c.id)}
                          >
                            {c.empresa || c.contacto || "Sin nombre"}
                            <span className="text-slate-400"> · {etiquetaEstado(c.estado).label}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-400">Nadie todavía</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" onClick={() => onNuevo(s.id)}>
                      <Plus size={14} className="inline" /> Cliente
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tarifa({ tarifa, tarifasBc, onChange, onError }) {
  const [q, setQ] = useState("");
  const [alta, setAlta] = useState({ codigo: "", descripcion: "", unidad: "ud", precio: "", familia: "" });
  const [confirmarBc, setConfirmarBc] = useState(false);
  const [confirmarExcel, setConfirmarExcel] = useState(false);
  const inputExcel = useRef(null);
  const nq = norm(q);
  const visibles = tarifa
    .filter((t) => !nq || norm([t.codigo, t.descripcion, t.familia].join(" ")).includes(nq))
    .slice()
    .sort((a, b) => String(a.codigo || "").localeCompare(String(b.codigo || ""), "es", { numeric: true }));
  const mostrados = visibles.slice(0, 150);

  const anadir = () => {
    const codigo = alta.codigo.trim();
    const descripcion = alta.descripcion.trim();
    if (!codigo && !descripcion) { onError("Escribe el código o la descripción del producto."); return; }
    if (codigo && tarifa.some((t) => String(t.codigo).toLowerCase() === codigo.toLowerCase())) {
      onError("Ese código ya está en la tarifa. Cámbiale el precio en la lista.");
      return;
    }
    onChange([
      { id: uid(), codigo, descripcion: descripcion || codigo, unidad: alta.unidad.trim() || "ud", precio: numeroInput(alta.precio), familia: alta.familia.trim() || "General", origen: "manual" },
      ...tarifa,
    ], "Producto añadido a la tarifa.");
    setAlta({ codigo: "", descripcion: "", unidad: "ud", precio: "", familia: "" });
  };

  const traerBc = () => {
    const traidas = articulosDesdeTarifaBc(tarifasBc);
    if (!traidas.length) {
      onError("No hay precios de venta en los datos cargados. En Cargar datos, trae «Tarifas de Venta».");
      setConfirmarBc(false);
      return;
    }
    if (!confirmarBc) { setConfirmarBc(true); return; }
    const { tarifa: next, nuevas, actualizadas } = fusionarTarifa(tarifa, traidas);
    onChange(next, `Tarifa actualizada: ${nuevas} productos nuevos y ${actualizadas} precios puestos al día. Business Central no se modifica.`);
    setConfirmarBc(false);
  };

  const pedirExcel = () => {
    if (tarifa.length && !confirmarExcel) { setConfirmarExcel(true); return; }
    inputExcel.current?.click();
  };

  const alElegirExcel = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setConfirmarExcel(false);
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      onError("El fichero tiene que ser un Excel (.xlsx o .xls).");
      return;
    }
    try {
      const traidas = await leerTarifaExcel(file);
      if (!traidas.length) {
        onError("No hay filas válidas. Cada fila necesita código o descripción y un precio mayor que 0.");
        return;
      }
      const { tarifa: next, nuevas, actualizadas } = fusionarExcel(tarifa, traidas);
      onChange(next, `Excel importado: ${nuevas} productos nuevos y ${actualizadas} actualizados. Business Central no se modifica.`);
    } catch {
      onError("No he podido leer el Excel. Comprueba que es un .xlsx o .xls válido.");
    }
  };

  const patch = (id, campos) => {
    onChange(tarifa.map((t) => (t.id === id ? { ...t, ...campos } : t)));
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Tarifa para presupuestos</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-500">
            Estos precios son los que salen en el presupuesto. Puedes escribirlos a mano, traerlos de Business Central o importar un Excel.
            Cambiarlos aquí no cambia la tarifa de BC.
            {tarifasBc.length ? ` Hay ${tarifasBc.length.toLocaleString("es-ES")} líneas de tarifa cargadas.` : " Todavía no hay tarifas cargadas desde BC."}
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={traerBc} disabled={!tarifasBc.length}>
              {confirmarBc ? "Confirmar: traer precios de BC" : "Traer de Business Central"}
            </button>
            {confirmarBc && (
              <span className="max-w-xs text-right text-[12px] text-slate-500">
                Se actualizan los artículos que ya existen y se añaden los que faltan. Si hay precio general y de cliente, se queda el general.
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={pedirExcel}>
              {confirmarExcel ? "Confirmar: importar Excel" : "Importar tarifa Excel"}
            </button>
            <input
              ref={inputExcel}
              type="file"
              accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={alElegirExcel}
            />
            {confirmarExcel && (
              <span className="max-w-xs text-right text-[12px] text-slate-500">
                Se actualizan los artículos cuyo código ya está y se añaden los nuevos. Los que no vengan en el Excel se quedan.
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-6">
        <input placeholder="Código" value={alta.codigo} onChange={(e) => setAlta({ ...alta, codigo: e.target.value })} />
        <input className="md:col-span-2" placeholder="Descripción" value={alta.descripcion} onChange={(e) => setAlta({ ...alta, descripcion: e.target.value })} />
        <input placeholder="Unidad" value={alta.unidad} onChange={(e) => setAlta({ ...alta, unidad: e.target.value })} />
        <input placeholder="Precio" value={alta.precio} onChange={(e) => setAlta({ ...alta, precio: e.target.value })} />
        <button type="button" className="boto-primari" onClick={anadir}>Añadir</button>
      </div>

      <div className="relative mt-4 max-w-md">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
        <input className="w-full pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en la tarifa" />
      </div>

      {!tarifa.length && (
        <p className="mt-4 text-[13px] text-slate-500">La tarifa está vacía. Añade un producto, importa un Excel o tráelos de Business Central.</p>
      )}

      {!!mostrados.length && (
        <div className="mt-3 overflow-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-2">Código</th>
                <th className="py-2 pr-2">Descripción</th>
                <th className="py-2 pr-2">Unidad</th>
                <th className="py-2 pr-2 text-right">Precio</th>
                <th className="py-2 pr-2">Familia</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mostrados.map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2">
                    <input className="w-28" value={t.codigo || ""} onChange={(e) => patch(t.id, { codigo: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <input className="w-full min-w-[180px]" value={t.descripcion || ""} onChange={(e) => patch(t.id, { descripcion: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2">
                    <input className="w-16" value={t.unidad || ""} onChange={(e) => patch(t.id, { unidad: e.target.value })} />
                  </td>
                  <td className="py-1 pr-2 text-right">
                    <input
                      className="w-24 text-right"
                      defaultValue={(Number(t.precio) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      key={`${t.id}-${t.precio}`}
                      onBlur={(e) => patch(t.id, { precio: numeroInput(e.target.value) })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input className="w-28" value={t.familia || ""} onChange={(e) => patch(t.id, { familia: e.target.value })} />
                  </td>
                  <td className="py-1 text-right">
                    <button type="button" className="boto-perill px-2 py-1" onClick={() => onChange(tarifa.filter((x) => x.id !== t.id))} aria-label="Quitar producto">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibles.length > mostrados.length && (
            <p className="mt-2 text-[12px] text-slate-500">Se ven {mostrados.length} de {visibles.length}. Afina la búsqueda para el resto.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Presupuestos({ presupuestos, tarifa, contactos, presId, onElegir, onChange, onContacto, onEnviar, onError }) {
  const actual = presupuestos.find((p) => p.id === presId) || null;
  if (!actual) {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">Presupuestos</h2>
          <button
            type="button"
            className="boto-primari"
            onClick={() => {
              const hoy = hoyISO();
              const nuevo = {
                id: uid(),
                numero: siguienteNumero(presupuestos),
                contactoId: "",
                clienteNombre: "",
                email: "",
                fecha: hoy,
                validez: sumarDias(hoy, 30),
                estado: "borrador",
                notas: "",
                lineas: [],
                creado: new Date().toISOString(),
              };
              onChange([nuevo, ...presupuestos]);
              onElegir(nuevo.id);
            }}
          >
            <Plus size={15} className="inline" /> Nuevo presupuesto
          </button>
        </div>
        {!presupuestos.length && (
          <p className="mt-4 text-[13px] text-slate-500">
            Cuando un cliente pida precio, crea el presupuesto, añade productos de la tarifa y envíaselo por correo.
          </p>
        )}
        <div className="mt-3 overflow-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-2">Número</th>
                <th className="py-2 pr-2">Cliente</th>
                <th className="py-2 pr-2">Fecha</th>
                <th className="py-2 pr-2">Estado</th>
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {presupuestos.map((p) => {
                const est = etiquetaPres(p.estado);
                return (
                  <tr key={p.id} className="cursor-pointer border-b border-slate-100 hover:bg-cyan-50/50" onClick={() => onElegir(p.id)}>
                    <td className="py-2 pr-2 font-semibold">{p.numero}</td>
                    <td className="py-2 pr-2">{p.clienteNombre || "—"}</td>
                    <td className="py-2 pr-2">{fmtFecha(p.fecha)}</td>
                    <td className="py-2 pr-2"><Insignia cls={est.cls}>{est.label}</Insignia></td>
                    <td className="py-2 text-right tabular-nums">{eur(totalPresupuesto(p))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const patch = (campos) => {
    onChange(presupuestos.map((p) => (p.id === actual.id ? { ...p, ...campos } : p)));
  };
  const patchLinea = (id, campos) => {
    patch({ lineas: (actual.lineas || []).map((l) => (l.id === id ? { ...l, ...campos } : l)) });
  };

  const cambiarEstado = (estado) => {
    patch({ estado });
    if (!actual.contactoId) return;
    if (estado === "aceptado") onContacto(actual.contactoId, { estado: "ganado" });
    if (estado === "enviado") onContacto(actual.contactoId, { estado: "presupuesto" });
  };

  const asignarCliente = (contactoId) => {
    const c = contactos.find((x) => x.id === contactoId);
    patch({
      contactoId,
      clienteNombre: c ? (c.empresa || c.contacto || "") : actual.clienteNombre,
      email: c?.email || actual.email || "",
    });
  };

  return (
    <EditorPresupuesto
      actual={actual}
      tarifa={tarifa}
      contactos={contactos}
      onVolver={() => onElegir(null)}
      onPatch={patch}
      onPatchLinea={patchLinea}
      onEstado={cambiarEstado}
      onCliente={asignarCliente}
      onBorrar={() => {
        onChange(presupuestos.filter((p) => p.id !== actual.id));
        onElegir(null);
      }}
      onEnviar={() => {
        if (!(actual.lineas || []).length) { onError("Añade al menos un producto al presupuesto."); return; }
        const email = actual.email || contactos.find((c) => c.id === actual.contactoId)?.email || "";
        if (!email.includes("@")) { onError("Falta el correo del cliente para poder enviarle el presupuesto."); return; }
        const contacto = contactos.find((c) => c.id === actual.contactoId) || null;
        onEnviar(contacto, { ...actual, email });
      }}
    />
  );
}

function EditorPresupuesto({ actual, tarifa, contactos, onVolver, onPatch, onPatchLinea, onEstado, onCliente, onBorrar, onEnviar }) {
  const [q, setQ] = useState("");
  const [pedirBorrar, setPedirBorrar] = useState(false);
  const nq = norm(q);
  const sugeridos = nq
    ? tarifa.filter((t) => norm([t.codigo, t.descripcion].join(" ")).includes(nq)).slice(0, 8)
    : [];

  const anadir = (t) => {
    onPatch({
      lineas: [...(actual.lineas || []), {
        id: uid(),
        codigo: t?.codigo || "",
        descripcion: t?.descripcion || "",
        unidad: t?.unidad || "ud",
        cantidad: 1,
        precio: Number(t?.precio) || 0,
        dto: 0,
      }],
    });
    setQ("");
  };

  const est = etiquetaPres(actual.estado);

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onVolver}>← Presupuestos</button>
        <Insignia cls={est.cls}>{est.label}</Insignia>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Campo label="Número">
          <input className="w-full" value={actual.numero || ""} onChange={(e) => onPatch({ numero: e.target.value })} />
        </Campo>
        <Campo label="Cliente del seguimiento">
          <select className="w-full" value={actual.contactoId || ""} onChange={(e) => onCliente(e.target.value)}>
            <option value="">Sin ficha</option>
            {contactos.map((c) => (
              <option key={c.id} value={c.id}>{c.empresa || c.contacto || c.email}</option>
            ))}
          </select>
        </Campo>
        <Campo label="Nombre en el presupuesto">
          <input className="w-full" value={actual.clienteNombre || ""} onChange={(e) => onPatch({ clienteNombre: e.target.value })} />
        </Campo>
        <Campo label="Correo">
          <input className="w-full" value={actual.email || ""} onChange={(e) => onPatch({ email: e.target.value })} />
        </Campo>
        <Campo label="Fecha">
          <input type="date" className="w-full" value={(actual.fecha || "").slice(0, 10)} onChange={(e) => onPatch({ fecha: e.target.value })} />
        </Campo>
        <Campo label="Válido hasta">
          <input type="date" className="w-full" value={(actual.validez || "").slice(0, 10)} onChange={(e) => onPatch({ validez: e.target.value })} />
        </Campo>
        <Campo label="Estado">
          <select className="w-full" value={actual.estado || "borrador"} onChange={(e) => onEstado(e.target.value)}>
            {ESTADOS_PRES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </Campo>
      </div>

      <div className="relative">
        <Campo label="Añadir de la tarifa">
          <input
            className="w-full"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tarifa.length ? "Escribe código o descripción" : "La tarifa está vacía: añade el producto a mano"}
          />
        </Campo>
        {!!sugeridos.length && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {sugeridos.map((t) => (
              <button
                key={t.id}
                type="button"
                className="block w-full rounded-none border-0 border-b border-slate-100 bg-white px-3 py-2 text-left text-[13px] shadow-none"
                onClick={() => anadir(t)}
              >
                <span className="font-semibold">{t.codigo}</span> {t.descripcion}
                <span className="float-right tabular-nums text-slate-600">{eur(t.precio)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={() => anadir(null)}>Línea libre</button>

      <div className="overflow-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-2">Código</th>
              <th className="py-2 pr-2">Descripción</th>
              <th className="py-2 pr-2 text-right">Cant.</th>
              <th className="py-2 pr-2">Ud</th>
              <th className="py-2 pr-2 text-right">Precio</th>
              <th className="py-2 pr-2 text-right">Dto %</th>
              <th className="py-2 pr-2 text-right">Importe</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(actual.lineas || []).map((l) => (
              <tr key={l.id} className="border-b border-slate-100">
                <td className="py-1 pr-2"><input className="w-24" value={l.codigo || ""} onChange={(e) => onPatchLinea(l.id, { codigo: e.target.value })} /></td>
                <td className="py-1 pr-2"><input className="w-full min-w-[160px]" value={l.descripcion || ""} onChange={(e) => onPatchLinea(l.id, { descripcion: e.target.value })} /></td>
                <td className="py-1 pr-2"><input type="number" step="any" className="w-20 text-right" value={l.cantidad} onChange={(e) => onPatchLinea(l.id, { cantidad: numeroInput(e.target.value) })} /></td>
                <td className="py-1 pr-2"><input className="w-14" value={l.unidad || ""} onChange={(e) => onPatchLinea(l.id, { unidad: e.target.value })} /></td>
                <td className="py-1 pr-2">
                  <input
                    className="w-24 text-right"
                    key={`${l.id}-${l.precio}`}
                    defaultValue={l.precio ?? ""}
                    onBlur={(e) => onPatchLinea(l.id, { precio: numeroInput(e.target.value) })}
                  />
                </td>
                <td className="py-1 pr-2"><input type="number" step="any" className="w-16 text-right" value={l.dto || 0} onChange={(e) => onPatchLinea(l.id, { dto: numeroInput(e.target.value) })} /></td>
                <td className="py-1 pr-2 text-right tabular-nums">{eur(importeLinea(l))}</td>
                <td className="py-1 text-right">
                  <button type="button" className="boto-perill px-2 py-1" onClick={() => onPatch({ lineas: actual.lineas.filter((x) => x.id !== l.id) })} aria-label="Quitar línea">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-right text-base font-semibold tabular-nums">Total {eur(totalPresupuesto(actual))}</div>

      <Campo label="Nota para el cliente">
        <textarea className="w-full" rows={2} value={actual.notas || ""} onChange={(e) => onPatch({ notas: e.target.value })} />
      </Campo>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="boto-primari" onClick={onEnviar}>
          <Send size={14} className="mr-1 inline" /> Preparar correo con el presupuesto
        </button>
        {pedirBorrar ? (
          <>
            <button type="button" className="boto-perill" onClick={onBorrar}>Confirmar borrado</button>
            <button type="button" onClick={() => setPedirBorrar(false)}>Cancelar</button>
          </>
        ) : (
          <button type="button" className="boto-perill" onClick={() => setPedirBorrar(true)}>Borrar presupuesto</button>
        )}
      </div>
    </div>
  );
}
