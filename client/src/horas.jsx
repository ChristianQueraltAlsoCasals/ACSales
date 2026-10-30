/**
 * horas.jsx — Pantalla «Control de horas» (24/09/2026).
 *
 * Horas de los trabajadores desde los Movs. proyecto de BC (backend/horas.cjs):
 *  · Cuadro trabajador × día (o × semana si el periodo es largo) con colores:
 *    sin imputar, por debajo de jornada, completa, con exceso, ausencia.
 *  · Extras y ausencias por trabajador (según el TIPO DE TRABAJO de BC y el
 *    exceso sobre la jornada teórica).
 *  · Detalle de movimientos y clasificación de los tipos de trabajo
 *    (qué código es extra, vacaciones, baja…), jornada y festivos.
 *  · Aviso por correo al responsable del departamento (días incompletos,
 *    laborables sin imputar e incidencias de Configuración).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConfiguracionHoras, TarifasHoras, FestivosLinea, listaFestivos, agruparAmiantoPorDia, normNum, TIPOS_INCIDENCIA } from "./horasExtra.jsx";
import { indiceRecursos } from "./manoObra.jsx";
import { puedeTarifasPago } from "./permisos.js";
import { codigoDepartamentoDesdeUnidad, listasCorreoDepartamento, aplicarRemitente } from "./departamentos.js";

const CATS = {
  normal: { txt: "Normal", color: "" },
  extra: { txt: "Hora extra", color: "text-purple-700" },
  vacaciones: { txt: "Vacaciones", color: "text-sky-700" },
  baja: { txt: "Baja", color: "text-rose-700" },
  festivo: { txt: "Festivo", color: "text-teal-700" },
  permiso: { txt: "Permiso / ausencia", color: "text-amber-700" },
  noHoras: { txt: "No son horas (km, uds…)", color: "text-slate-400" },
};
const AUSENCIAS = ["vacaciones", "baja", "festivo", "permiso"];
const LETRA = { vacaciones: "V", baja: "B", festivo: "F", permiso: "P" };

// Clasificación por defecto según el código de tipo de trabajo
function adivinar(cod) {
  const c = String(cod || "").toUpperCase();
  if (!c) return "normal";
  if (/EXT|^HE|H\.?E\.?$|NOCT|NOCHE|FINDE|SABAD|DOMING/.test(c)) return "extra";
  if (/VAC/.test(c)) return "vacaciones";
  if (/BAJ|^IT$|ENFER|ACCID|MEDIC/.test(c)) return "baja";
  if (/FEST/.test(c)) return "festivo";
  if (/PERM|AUSEN|LICEN|ASUNT|FORMAC/.test(c)) return "permiso";
  return "normal";
}
const esHora = (u) => !u || /^(h|hr|hrs|hora|horas|hour|hours)$/i.test(String(u).trim());

const iso = (d) => d.toISOString().slice(0, 10);
const hoyISO = () => iso(new Date());
const inicioMes = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
function diasEntre(desde, hasta) {
  const out = [];
  const d = new Date(`${desde}T00:00:00Z`), f = new Date(`${hasta}T00:00:00Z`);
  while (d <= f && out.length < 400) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const diaSemana = (s) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 domingo
const lunesDe = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
const h = (v) => (v ? (Math.round(v * 100) / 100).toLocaleString("es-ES") : "");
const fmtF = (s) => (s ? s.split("-").reverse().join("/") : "");
const DIAS = ["D", "L", "M", "X", "J", "V", "S"];
const SIN_DEPTO = "Sin departamento";

function emailsDeCampo(texto) {
  return String(texto || "").split(/[;,\s]+/).map((s) => s.trim()).filter((s) => s.includes("@"));
}

/** Días laborables con faltas de horas o sin imputar, más incidencias de Configuración. */
function revisarAnomalias(r, dias, hastaReal, jornadaDiaFn, incidenciasRec) {
  const sinImputar = [];
  const incompletos = [];
  for (const dia of dias) {
    if (dia > hastaReal) continue;
    const j = jornadaDiaFn(dia, r.recurso);
    if (!(j > 0)) continue;
    const d = r.dias[dia];
    const trab = d ? d.trabajo : 0;
    const aus = d ? Object.values(d.aus).reduce((a, b) => a + b, 0) : 0;
    const total = trab + aus;
    if (!d || total === 0) sinImputar.push(dia);
    else if (total < j - 0.01) incompletos.push({ dia, horas: total, jornada: j });
  }
  const desde = dias[0];
  const hasta = dias[dias.length - 1];
  const incidencias = (incidenciasRec || []).filter((i) => {
    const iHasta = i.hasta || i.desde;
    return i.desde && iHasta && i.desde <= hasta && iHasta >= desde;
  });
  return { sinImputar, incompletos, incidencias };
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textoAHtml(t) {
  return escHtml(t).split(/\r?\n/).join("<br/>");
}

function badgeSituacion(tipo) {
  const estilos = {
    incompleto: "background:#f59e0b;color:#fff",
    sinImputar: "background:#fecaca;color:#7f1d1d",
    incidencia: "background:#e2e8f0;color:#334155",
  };
  const textos = {
    incompleto: "Faltan horas",
    sinImputar: "Sin imputar",
    incidencia: "Incidencia",
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;${estilos[tipo] || estilos.incidencia}">${textos[tipo] || tipo}</span>`;
}

/** Tabla HTML del detalle (Outlook-friendly) + intro/cierre editables. */
function construirAvisoHoras({ deptoNombre, desde, hasta, filas }) {
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e1;background:#f1f5f9;font-size:12px;white-space:nowrap"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;vertical-align:top"';
  const tdR = 'style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums"';

  const filasDetalle = [];
  for (const f of filas) {
    const quien = `${f.nombre}`;
    const cod = f.recurso;
    for (const x of f.incompletos) {
      const falta = Math.round((x.jornada - x.horas) * 100) / 100;
      filasDetalle.push({
        nombre: quien, recurso: cod, tipo: "incompleto",
        fecha: fmtF(x.dia), imputado: `${h(x.horas)} h`, jornada: `${h(x.jornada)} h`,
        obs: `Faltan ${h(falta)} h para completar la jornada`,
      });
    }
    for (const dia of f.sinImputar) {
      filasDetalle.push({
        nombre: quien, recurso: cod, tipo: "sinImputar",
        fecha: fmtF(dia), imputado: "0 h", jornada: "—",
        obs: "Día laborable sin ninguna hora imputada",
      });
    }
    for (const i of f.incidencias) {
      const tipoTxt = TIPOS_INCIDENCIA[i.tipo]?.txt || i.tipo;
      const periodo = i.hasta && i.hasta !== i.desde ? `${fmtF(i.desde)} – ${fmtF(i.hasta)}` : fmtF(i.desde);
      const extras = [
        i.tipo === "reduccion" && i.horas ? `${i.horas} h/día` : "",
        i.motivo || "",
      ].filter(Boolean).join(" · ");
      filasDetalle.push({
        nombre: quien, recurso: cod, tipo: "incidencia",
        fecha: periodo, imputado: "—", jornada: "—",
        obs: extras ? `${tipoTxt} · ${extras}` : tipoTxt,
      });
    }
  }

  const nInc = filas.reduce((t, f) => t + f.incompletos.length, 0);
  const nSin = filas.reduce((t, f) => t + f.sinImputar.length, 0);
  const nCfg = filas.reduce((t, f) => t + f.incidencias.length, 0);

  const resumenFilas = filas.map((f) => {
    const partes = [];
    if (f.incompletos.length) partes.push(`${f.incompletos.length} día(s) incompleto(s)`);
    if (f.sinImputar.length) partes.push(`${f.sinImputar.length} sin imputar`);
    if (f.incidencias.length) partes.push(`${f.incidencias.length} incidencia(s)`);
    return `<tr>
      <td ${td}><b>${escHtml(f.nombre)}</b><div style="color:#64748b;font-size:11px">${escHtml(f.recurso)}</div></td>
      <td ${td}>${escHtml(partes.join(" · "))}</td>
      <td ${tdR}>${f.incompletos.length || "—"}</td>
      <td ${tdR}>${f.sinImputar.length || "—"}</td>
      <td ${tdR}>${f.incidencias.length || "—"}</td>
    </tr>`;
  }).join("");

  const detalleFilas = filasDetalle.map((r) => `<tr>
    <td ${td}><b>${escHtml(r.nombre)}</b><div style="color:#64748b;font-size:11px">${escHtml(r.recurso)}</div></td>
    <td ${td}>${badgeSituacion(r.tipo)}</td>
    <td ${td} style="white-space:nowrap">${escHtml(r.fecha)}</td>
    <td ${tdR}>${escHtml(r.imputado)}</td>
    <td ${tdR}>${escHtml(r.jornada)}</td>
    <td ${td}>${escHtml(r.obs)}</td>
  </tr>`).join("");

  const htmlDetalle = `
<div style="margin:16px 0 8px;font-size:13px;color:#334155">
  <b>Resumen</b> · ${filas.length} trabajador${filas.length === 1 ? "" : "es"} ·
  ${nInc} día(s) con horas incompletas · ${nSin} día(s) sin imputar · ${nCfg} incidencia(s)
</div>
<table style="border-collapse:collapse;width:100%;max-width:720px;font-family:Segoe UI,Arial,sans-serif;margin-bottom:18px">
  <thead><tr>
    <th ${th}>Trabajador</th>
    <th ${th}>Qué revisar</th>
    <th ${th} style="text-align:right">Incompletos</th>
    <th ${th} style="text-align:right">Sin imputar</th>
    <th ${th} style="text-align:right">Incidencias</th>
  </tr></thead>
  <tbody>${resumenFilas}</tbody>
</table>
<div style="margin:8px 0;font-size:13px;color:#334155"><b>Detalle día a día</b></div>
<table style="border-collapse:collapse;width:100%;max-width:900px;font-family:Segoe UI,Arial,sans-serif">
  <thead><tr>
    <th ${th}>Trabajador</th>
    <th ${th}>Situación</th>
    <th ${th}>Fecha</th>
    <th ${th} style="text-align:right">Imputado</th>
    <th ${th} style="text-align:right">Jornada</th>
    <th ${th}>Observación</th>
  </tr></thead>
  <tbody>${detalleFilas}</tbody>
</table>
<p style="margin:14px 0 0;font-size:12px;color:#64748b">
  Leyenda: <span style="color:#b45309">■ Faltan horas</span> (amarillo en el cuadro) ·
  <span style="color:#b91c1c">■ Sin imputar</span> (rojo / laborable vacío) ·
  Incidencia = apunte de Configuración (día libre, reducción…).
</p>`.trim();

  const intro = [
    "Buenos días,",
    "",
    `Os pedimos que reviséis las horas del departamento ${deptoNombre || "—"} en el periodo ${fmtF(desde)} – ${fmtF(hasta)}.`,
    "",
    "Abajo tenéis un resumen por trabajador y el detalle de cada día a revisar (jornada incompleta, laborable sin horas o incidencia).",
  ].join("\n");

  const cierre = [
    "Por favor, revisadlo en Business Central (Movs. proyecto) o en Control de horas de ACSales y completad o corregid lo que corresponda.",
    "",
    "Gracias.",
    "Un saludo,",
  ].join("\n");

  return { intro, cierre, htmlDetalle, nFilasDetalle: filasDetalle.length };
}

function ModalCorreoAvisoHoras({ borrador, onCerrar, onEnviado }) {
  const [para, setPara] = useState((borrador.para || []).join("; "));
  const [cc, setCc] = useState((borrador.cc || []).join("; "));
  const tocadoRef = useRef(false);
  const [asunto, setAsunto] = useState(borrador.asunto || "");
  const [intro, setIntro] = useState(borrador.intro || "");
  const [cierre, setCierre] = useState(borrador.cierre || "");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [de, setDe] = useState("");

  useEffect(() => {
    let vivo = true;
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => {
        if (!vivo || !d.email) return;
        setDe(d.email);
        if (tocadoRef.current) return;
        const aj = aplicarRemitente(borrador.para || [], borrador.cc || [], d.email);
        setPara(aj.para.join("; "));
        setCc(aj.cc.join("; "));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enviar = async () => {
    const destinatarios = emailsDeCampo(para);
    const copias = emailsDeCampo(cc).filter((e) => !destinatarios.some((p) => p.toLowerCase() === e.toLowerCase()));
    if (!destinatarios.length) { setError("Indica al menos un destinatario."); return; }
    if (!asunto.trim()) { setError("Falta el asunto."); return; }
    setEnviando(true);
    setError(null);
    try {
      const cuerpoHtml = `<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.45">
<p style="margin:0 0 12px">${textoAHtml(intro)}</p>
${borrador.htmlDetalle || ""}
<p style="margin:16px 0 0">${textoAHtml(cierre)}</p>
</div>`;
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          cc: copias,
          asunto: asunto.trim(),
          cuerpoHtml,
          incluirFirma: true,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.detalle || json.error || `Error ${r.status}`);
      onEnviado?.({ de: json.de, para: destinatarios, cc: copias, asunto: asunto.trim() });
    } catch (err) {
      setError(err.message || String(err));
      setEnviando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCerrar}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div>
            <div className="text-sm font-semibold text-slate-800">Avisar al responsable · Control de horas</div>
            <div className="text-[11px] text-slate-500">
              {borrador.deptoNombre ? `dpto. ${borrador.deptoNombre}` : "sin departamento"}
              {borrador.nTrabajadores ? ` · ${borrador.nTrabajadores} trabajador${borrador.nTrabajadores === 1 ? "" : "es"}` : ""}
              {borrador.nFilasDetalle ? ` · ${borrador.nFilasDetalle} líneas de detalle` : ""}
              {de ? ` · desde ${de}` : ""}
            </div>
          </div>
          <button type="button" onClick={onCerrar} className="text-slate-400 hover:text-slate-700 text-lg px-2" aria-label="Cerrar">✕</button>
        </div>
        <div className="px-4 py-3 space-y-3 text-sm">
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Para</span>
            <input value={para} onChange={(e) => { tocadoRef.current = true; setPara(e.target.value); }}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px]" placeholder="email1@…; email2@…" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Copia</span>
            <input value={cc} onChange={(e) => { tocadoRef.current = true; setCc(e.target.value); }}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px]" placeholder="administración — se quita quien envía" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Asunto</span>
            <input value={asunto} onChange={(e) => setAsunto(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px]" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Introducción</span>
            <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={5}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] font-sans" />
          </label>
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Tablas del correo (vista previa)</span>
            <div
              className="mt-1 max-h-72 overflow-auto border border-slate-200 rounded-md p-3 bg-slate-50 text-[12px]"
              dangerouslySetInnerHTML={{ __html: borrador.htmlDetalle || "" }}
            />
          </div>
          <label className="block">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Cierre</span>
            <textarea value={cierre} onChange={(e) => setCierre(e.target.value)} rows={4}
              className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-[13px] font-sans" />
          </label>
          {error && <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50 sticky bottom-0">
          <button type="button" onClick={onCerrar} disabled={enviando} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-white">Cancelar</button>
          <button type="button" onClick={enviar} disabled={enviando}
            className="text-sm font-semibold px-4 py-1.5 rounded-md text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50">
            {enviando ? "Enviando…" : "Enviar correo"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ControlHoras({ recursos = [], usuario = null }) {
  const veTarifas = puedeTarifasPago(usuario);
  const [datos, setDatos] = useState(null);
  const [ajustes, setAjustes] = useState({ tipos: {}, jornada: 8, jornadaViernes: null, festivos: [] });
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [pestana, setPestana] = useState("cuadro");
  const [buscar, setBuscar] = useState("");
  const [sel, setSel] = useState(null); // recurso seleccionado para el detalle
  const [soloIncidencias, setSoloIncidencias] = useState(false);
  const [soloPersonas, setSoloPersonas] = useState(true); // fuera máquinas/vehículos (tipo de recurso en BC)
  const [departamento, setDepartamento] = useState("");
  const [guardado, setGuardado] = useState("");
  const [plegados, setPlegados] = useState({}); // recurso -> plegado (por defecto se ven las filas por tipo de línea)
  const [diaDetalle, setDiaDetalle] = useState(null); // { r, dias: [..], titulo }
  const [amianto, setAmianto] = useState(null); // { partes, precioDefecto, error? }
  const [verAmianto, setVerAmianto] = useState(false); // popup con lo que ha traído la API
  const [avisoHoras, setAvisoHoras] = useState(null); // borrador del correo al responsable
  const [elegirDeptoAviso, setElegirDeptoAviso] = useState(null); // { opciones: [{nombre, n}] } si hay varios dptos
  // Paso 2: elegir trabajadores → { deptoNombre, filas, seleccionados: { [recurso]: true } }
  const [elegirTrabajadoresAviso, setElegirTrabajadoresAviso] = useState(null);
  const [avisoEnviado, setAvisoEnviado] = useState("");
  useEffect(() => {
    const esc = (e) => {
      if (e.key !== "Escape") return;
      setDiaDetalle(null);
      setVerAmianto(false);
      setAvisoHoras(null);
      setElegirDeptoAviso(null);
      setElegirTrabajadoresAviso(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    if (!veTarifas && pestana === "tarifas") setPestana("cuadro");
  }, [veTarifas, pestana]);

  useEffect(() => {
    fetch("/api/horas/estado").then((r) => r.json()).then((j) => {
      if (j.datos) { setDatos(j.datos); setDesde(j.datos.desde); setHasta(j.datos.hasta); }
      if (j.ajustes) setAjustes((a) => ({ ...a, ...j.ajustes }));
    }).catch(() => setError({ error: "No se pudo conectar con el backend. ¿Está arrancado (INICIAR.bat)?" }));
  }, []);

  // Partes con amianto (ALSOAPP) del mismo periodo que las horas de BC
  useEffect(() => {
    if (!datos?.desde || !datos?.hasta) return;
    let cancel = false;
    setAmianto((a) => (a ? { ...a, cargando: true } : { partes: [], cargando: true }));
    fetch(`/api/horas/amianto?desde=${encodeURIComponent(datos.desde)}&hasta=${encodeURIComponent(datos.hasta)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
        if (!cancel) setAmianto({ partes: j.partes || [], precioDefecto: j.precioDefecto || 30 });
      })
      .catch((e) => { if (!cancel) setAmianto({ partes: [], error: String(e.message || e) }); });
    return () => { cancel = true; };
  }, [datos?.desde, datos?.hasta]);

  const amiantoMap = useMemo(() => agruparAmiantoPorDia(amianto?.partes), [amianto]);
  const diasAmiantoDe = (recurso) => amiantoMap.get(normNum(recurso))?.dias?.length || 0;

  async function cargar() {
    setCargando(true); setError(null);
    try {
      const r = await fetch("/api/horas/cargar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desde, hasta }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { info: j });
      setDatos(j.datos);
    } catch (e) {
      setError(e.info || { error: String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend." : String(e.message || e) });
    }
    setCargando(false);
  }
  async function guardarAjustes(nuevo) {
    setAjustes(nuevo);
    try {
      await fetch("/api/horas/ajustes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nuevo) });
      setGuardado("Guardado ✓"); setTimeout(() => setGuardado(""), 1500);
    } catch { setGuardado("No se pudo guardar"); }
  }

  // Todos los códigos de tipo de trabajo cuentan (vacaciones, ausencias…), sea cual sea la unidad de medida
  const catDe = (f) => ajustes.tipos?.[f.tipoTrabajo] || adivinar(f.tipoTrabajo);
  // Festivos línea a línea: «Todos» (recurso vacío) = para toda la plantilla; con trabajador = solo para él
  const { festivos, festivosRec } = useMemo(() => {
    const todos = new Set(), porRec = {};
    for (const l of listaFestivos(ajustes)) {
      if (!l.fecha) continue;
      if (l.recurso) (porRec[l.recurso] ||= new Set()).add(l.fecha); else todos.add(l.fecha);
    }
    return { festivos: todos, festivosRec: porRec };
  }, [ajustes.festivosLista, ajustes.festivos]); // eslint-disable-line react-hooks/exhaustive-deps
  // Festivos de cada población e incidencias por trabajador (pestaña Configuración)
  const festPobl = useMemo(() => Object.fromEntries((ajustes.poblaciones || []).map((p) => [p.nombre, new Set(p.festivos || [])])), [ajustes.poblaciones]);
  const incPorRec = useMemo(() => {
    const o = {};
    for (const i of ajustes.incidencias || []) if (i.tipo === "libre" || i.tipo === "reduccion") (o[i.recurso] ||= []).push(i);
    return o;
  }, [ajustes.incidencias]);
  const jornadaDia = (dia, recurso) => {
    const ds = diaSemana(dia);
    if (ds === 0 || ds === 6 || festivos.has(dia)) return 0;
    let base = ds === 5 && ajustes.jornadaViernes ? Number(ajustes.jornadaViernes) : Number(ajustes.jornada) || 8;
    if (recurso) {
      if (festivosRec[recurso]?.has(dia)) return 0; // festivo específico de este trabajador
      const pob = ajustes.asignacion?.[recurso];
      if (pob && festPobl[pob]?.has(dia)) return 0; // festivo local de su población
      for (const i of incPorRec[recurso] || []) {
        if (dia < i.desde || dia > (i.hasta || i.desde)) continue;
        if (i.tipo === "libre") return 0;
        if (i.tipo === "reduccion") base = Math.min(base, Number(i.horas) || base);
      }
    }
    return base;
  };

  // ---------- Cálculo ----------
  const calc = useMemo(() => {
    if (!datos) return null;
    const dias = diasEntre(datos.desde, datos.hasta);
    const hastaReal = datos.hasta > hoyISO() ? hoyISO() : datos.hasta; // no marcar como «sin imputar» los días futuros
    const porRec = {};
    let noHoras = 0;
    for (const f0 of datos.filas) {
      if (soloPersonas && /machin|m[aá]quina/i.test(datos.tipoRecurso?.[f0.recurso] || "")) continue;
      // Líneas en DÍAS (p. ej. vacaciones) → horas según la jornada de ese día
      const enDias = /^(d|dia|día|dias|días|day|days|jornada)$/i.test(String(f0.unidad || "").trim());
      const f = enDias ? { ...f0, horas: f0.horas * (jornadaDia(f0.fecha, f0.recurso) || Number(ajustes.jornada) || 8), cantidadOriginal: f0.horas } : f0;
      const cat = catDe(f);
      if (cat === "noHoras") { noHoras++; continue; }
      const r = (porRec[f.recurso] ||= { recurso: f.recurso, nombre: datos.nombres?.[f.recurso] || f.recurso, dias: {}, movs: [] });
      const d = (r.dias[f.fecha] ||= { trabajo: 0, extra: 0, aus: {}, total: 0 });
      if (cat === "normal") d.trabajo += f.horas;
      else if (cat === "extra") { d.trabajo += f.horas; d.extra += f.horas; }
      else d.aus[cat] = (d.aus[cat] || 0) + f.horas;
      d.total += f.horas;
      r.movs.push({ ...f, cat });
    }
    const lista = Object.values(porRec).map((r) => {
      const t = { trabajadas: 0, extras: 0, exceso: 0, ausencias: 0, teoricas: 0, sinImputar: 0, faltan: 0, porAus: {} };
      for (const dia of dias) {
        const j = jornadaDia(dia, r.recurso);
        const d = r.dias[dia];
        const aus = d ? Object.values(d.aus).reduce((a, b) => a + b, 0) : 0;
        const trab = d ? d.trabajo : 0;
        if (dia <= hastaReal) t.teoricas += j;
        t.trabajadas += trab;
        t.extras += d ? d.extra : 0;
        t.ausencias += aus;
        if (d) for (const [c, v] of Object.entries(d.aus)) t.porAus[c] = (t.porAus[c] || 0) + v;
        const normales = trab - (d ? d.extra : 0);
        if (j > 0) {
          if (normales > j) t.exceso += normales - j; // horas por encima de la jornada no marcadas como extra
          if (dia <= hastaReal) {
            if (!d || trab + aus === 0) t.sinImputar++;
            else if (trab + aus < j) t.faltan += j - (trab + aus);
          }
        } else if (normales > 0) t.exceso += normales; // trabajo en fin de semana / festivo
      }
      t.diferencia = t.trabajadas + t.ausencias - t.teoricas;
      const codigos = [...new Set(r.movs.map((m) => m.tipoTrabajo).filter(Boolean))].sort();
      return { ...r, codigos, t, incidencias: t.sinImputar > 0 || t.faltan > 0.01 || t.exceso > 0.01 || t.extras > 0 };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const tipos = {};
    for (const f of datos.filas) {
      const k = f.tipoTrabajo || "";
      tipos[k] ||= { cod: k, horas: 0, movs: 0, unidades: new Set() };
      tipos[k].horas += f.horas; tipos[k].movs++; tipos[k].unidades.add(f.unidad || "—");
    }
    return { dias, lista, noHoras, tipos: Object.values(tipos).sort((a, b) => b.horas - a.horas), hastaReal };
  }, [datos, ajustes, soloPersonas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Departamento = grupo de recurso de la tabla Recursos (misma lectura que mano de obra).
  const ficha = useMemo(() => indiceRecursos(recursos), [recursos]);
  const deptoListo = ficha.cargada && !!ficha.columna;
  const deptoDe = (recurso) => {
    if (!deptoListo) return "";
    return ficha.mapa.get(String(recurso || "").trim().toUpperCase())?.unidad || SIN_DEPTO;
  };
  const deptoActivo = deptoListo ? departamento : "";
  const opcionesDep = calc && deptoListo
    ? [...new Set(calc.lista.map((r) => deptoDe(r.recurso)).filter(Boolean))].sort((a, b) => {
      if (a === SIN_DEPTO) return 1;
      if (b === SIN_DEPTO) return -1;
      return a.localeCompare(b, "es");
    })
    : [];

  const visibles = calc ? calc.lista.filter((r) =>
    (!buscar || `${r.nombre} ${r.recurso}`.toLowerCase().includes(buscar.toLowerCase()))
    && (!soloIncidencias || r.incidencias)
    && (!deptoActivo || deptoDe(r.recurso) === deptoActivo)) : [];
  const porSemanas = calc && calc.dias.length > 31;
  const columnas = calc ? (porSemanas ? [...new Set(calc.dias.map(lunesDe))] : calc.dias) : [];

  /** Trabajadores visibles con faltas / sin imputar / incidencias de Configuración. */
  const filasAviso = useMemo(() => {
    if (!calc) return [];
    return visibles.map((r) => {
      const a = revisarAnomalias(r, calc.dias, calc.hastaReal, jornadaDia, incPorRec[r.recurso]);
      if (!a.sinImputar.length && !a.incompletos.length && !a.incidencias.length) return null;
      return { recurso: r.recurso, nombre: r.nombre, depto: deptoDe(r.recurso) || SIN_DEPTO, ...a };
    }).filter(Boolean);
  }, [calc, visibles, incPorRec, deptoListo, departamento]); // eslint-disable-line react-hooks/exhaustive-deps

  function resumenCortoTrabajador(f) {
    const partes = [];
    if (f.incompletos.length) partes.push(`${f.incompletos.length} incompleto${f.incompletos.length === 1 ? "" : "s"}`);
    if (f.sinImputar.length) partes.push(`${f.sinImputar.length} sin imputar`);
    if (f.incidencias.length) partes.push(`${f.incidencias.length} incidencia${f.incidencias.length === 1 ? "" : "s"}`);
    return partes.join(" · ") || "—";
  }

  function borradorAvisoParaDepto(deptoNombre, recursosSel = null) {
    let filas = filasAviso.filter((f) => f.depto === deptoNombre);
    if (recursosSel) {
      const ok = new Set(recursosSel);
      filas = filas.filter((f) => ok.has(f.recurso));
    }
    if (!filas.length || !datos) return null;
    const codigo = codigoDepartamentoDesdeUnidad(deptoNombre === SIN_DEPTO ? "" : deptoNombre);
    const { para, cc } = listasCorreoDepartamento(codigo);
    const { intro, cierre, htmlDetalle, nFilasDetalle } = construirAvisoHoras({
      deptoNombre, desde: datos.desde, hasta: datos.hasta, filas,
    });
    return {
      para,
      cc,
      deptoNombre,
      nTrabajadores: filas.length,
      nFilasDetalle,
      asunto: `Revisión horas · ${deptoNombre} · ${fmtF(datos.desde)}–${fmtF(datos.hasta)}`,
      intro,
      cierre,
      htmlDetalle,
    };
  }

  function abrirSeleccionTrabajadores(deptoNombre) {
    const filas = filasAviso
      .filter((f) => f.depto === deptoNombre)
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (!filas.length) return;
    const seleccionados = Object.fromEntries(filas.map((f) => [f.recurso, true]));
    setElegirDeptoAviso(null);
    setElegirTrabajadoresAviso({ deptoNombre, filas, seleccionados });
  }

  function abrirAvisoResponsable() {
    setAvisoEnviado("");
    setElegirTrabajadoresAviso(null);
    setAvisoHoras(null);
    if (!filasAviso.length) return;
    if (deptoActivo) {
      abrirSeleccionTrabajadores(deptoActivo);
      return;
    }
    const porDep = new Map();
    for (const f of filasAviso) porDep.set(f.depto, (porDep.get(f.depto) || 0) + 1);
    const opciones = [...porDep.entries()]
      .map(([nombre, n]) => ({ nombre, n }))
      .sort((a, b) => (a.nombre === SIN_DEPTO ? 1 : b.nombre === SIN_DEPTO ? -1 : a.nombre.localeCompare(b.nombre, "es")));
    if (opciones.length === 1) {
      abrirSeleccionTrabajadores(opciones[0].nombre);
      return;
    }
    setElegirDeptoAviso({ opciones });
  }

  function confirmarTrabajadoresAviso() {
    if (!elegirTrabajadoresAviso) return;
    const recursos = Object.entries(elegirTrabajadoresAviso.seleccionados)
      .filter(([, v]) => v)
      .map(([r]) => r);
    if (!recursos.length) return;
    const b = borradorAvisoParaDepto(elegirTrabajadoresAviso.deptoNombre, recursos);
    if (!b) return;
    setElegirTrabajadoresAviso(null);
    setAvisoHoras(b);
  }

  // Celda del día en la fila del TRABAJADOR (total del día, en color)
  function celda(r, col) {
    const diasCol = porSemanas ? calc.dias.filter((d) => lunesDe(d) === col) : [col];
    let trab = 0, aus = 0, j = 0;
    let futuro = true;
    for (const d of diasCol) {
      const x = r.dias[d];
      if (d <= calc.hastaReal) { j += jornadaDia(d, r.recurso); futuro = false; }
      if (x) { trab += x.trabajo; aus += Object.values(x.aus).reduce((a, b) => a + b, 0); }
    }
    const total = trab + aus;
    let cls;
    if (total > 0) {
      if (j === 0) cls = "bg-violet-500 text-white font-bold";          // trabajo en fin de semana / festivo
      else if (total < j - 0.01) cls = "bg-amber-400 text-white font-bold"; // faltan horas
      else cls = "bg-emerald-500 text-white font-bold";                 // jornada completa (o más)
    } else if (!futuro && j > 0) cls = "bg-red-100";                      // laborable sin imputar
    else cls = "bg-[#dce6f2]";                                            // fin de semana / festivo / futuro
    const abrir = () => total && setDiaDetalle({ r, dias: diasCol, titulo: porSemanas ? `semana del ${fmtF(diasCol[0])}` : fmtF(col) });
    return (
      <td key={col} onClick={abrir}
        className={`min-w-[58px] px-1 py-2 text-center text-[13px] border border-white ${total ? "cursor-pointer hover:brightness-110" : ""} ${cls}`}
        title={`${porSemanas ? `Semana del ${fmtF(col)}` : fmtF(col)} · ${h(total) || 0} h imputadas · jornada ${h(j) || 0} h`}>
        {total ? h(total) : ""}
      </td>
    );
  }

  // Celda del día en la fila de un TIPO DE LÍNEA (H_NORMAL, H_EXTRA, VAC…)
  function celdaCodigo(r, cod, col) {
    const diasCol = porSemanas ? calc.dias.filter((d) => lunesDe(d) === col) : [col];
    const v = r.movs.filter((m) => (m.tipoTrabajo || "(sin tipo)") === cod && diasCol.includes(m.fecha)).reduce((t, m) => t + m.horas, 0);
    const finde = !porSemanas && jornadaDia(col, r.recurso) === 0;
    return (
      <td key={col} onClick={() => v && setDiaDetalle({ r, dias: diasCol, titulo: porSemanas ? `semana del ${fmtF(diasCol[0])}` : fmtF(col) })}
        className={`min-w-[58px] px-1 py-1.5 text-center text-[13px] border border-slate-200 text-slate-700 ${finde ? "bg-slate-50" : "bg-white"} ${v ? "cursor-pointer hover:bg-blue-50" : ""}`}>{h(v)}</td>
    );
  }

  const input = "border rounded px-2 py-1 text-sm";
  return (
    <div className="w-full">
      <h1 className="text-2xl font-bold text-slate-800">⏱️ Control de horas</h1>
      <p className="text-slate-500 text-sm mt-1 max-w-3xl">
        Horas de los trabajadores desde los <b>Movs. proyecto</b> de Business Central{datos?.empresa ? ` (${datos.empresa})` : ""}: lo imputado cada día comparado con la jornada, horas extra y ausencias según el tipo de trabajo.
      </p>

      <div className="flex flex-wrap items-end gap-3 mt-4">
        <label className="text-sm text-slate-600">Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={`block mt-1 ${input}`} /></label>
        <label className="text-sm text-slate-600">Hasta<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={`block mt-1 ${input}`} /></label>
        <button onClick={cargar} disabled={cargando} className="px-4 py-2 rounded bg-blue-700 text-white text-sm disabled:opacity-50">{cargando ? "Cargando de BC…" : "↻ Cargar desde BC"}</button>
        {datos && (
          <span className="text-xs text-slate-400">
            Cargado {new Date(datos.cargado).toLocaleString("es-ES")} · {fmtF(datos.desde)}–{fmtF(datos.hasta)} · {datos.filas.length.toLocaleString("es-ES")} movimientos de recursos · servicio «{datos.servicio}»
            {!datos.servicioRecursos && " · (sin ficha de recursos: nombres desde la descripción)"}
          </span>
        )}
      </div>
      {datos?.aviso && <p className="mt-2 text-xs text-amber-700">{datos.aviso}</p>}
      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          <div className="font-medium">{error.error}</div>
          {error.detalle && <div className="mt-1 text-red-800">{error.detalle}</div>}
          {error.probados?.length > 0 && <div className="mt-1 text-xs text-slate-600">Nombres probados: {error.probados.join(" · ")}</div>}
          {error.servicios?.length > 0 && (
            <details className="mt-1 text-xs text-slate-600"><summary className="cursor-pointer">Servicios web publicados ahora ({error.servicios.length})</summary>{error.servicios.join(" · ")}</details>
          )}
        </div>
      )}
      {!datos && !error && !cargando && <p className="mt-4 text-sm text-slate-500">Elige el periodo y pulsa «Cargar desde BC».</p>}

      {calc && (
        <>
          <div className="flex flex-wrap items-center gap-2 mt-5 border-b">
            <div className="flex gap-1">
              {[
                ["cuadro", "Cuadro de horas"],
                ["extras", "Extras y ausencias"],
                ["detalle", "Detalle"],
                ["tipos", "Tipos de trabajo y jornada"],
                ["config", "Configuración"],
                ...(veTarifas ? [["tarifas", "Tarifas y pago"]] : []),
              ].map(([k, t]) => (
                <button key={k} onClick={() => setPestana(k)} className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === k ? "border-blue-700 text-blue-800 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{t}</button>
              ))}
            </div>
            {(pestana === "extras" || (veTarifas && pestana === "tarifas")) && (
              <button type="button" onClick={() => setVerAmianto(true)}
                className="ml-auto mb-1 px-2 py-1 rounded border text-xs text-amber-800 bg-amber-50 hover:bg-amber-100 border-amber-200">
                Ver partes amianto{amianto?.cargando ? "…" : amianto?.partes ? ` (${amianto.partes.length})` : ""}
              </button>
            )}
          </div>

          {(pestana === "cuadro" || pestana === "extras") && (
            <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
              <input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar trabajador…" className={`${input} w-56`} />
              <label className="flex items-center gap-1 text-slate-600">Departamento
                <select value={deptoActivo} onChange={(e) => setDepartamento(e.target.value)} disabled={!deptoListo} className={`${input} max-w-[220px]`} title="Grupo de recurso de la tabla Recursos, en Cargar datos">
                  <option value="">Todos</option>
                  {opcionesDep.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              {!ficha.cargada && <span className="text-xs text-amber-700">Para filtrar por departamento, carga la tabla Recursos en Cargar datos.</span>}
              {ficha.cargada && !ficha.columna && <span className="text-xs text-amber-700">La tabla Recursos no trae el grupo del recurso, así que no se puede saber el departamento.</span>}
              <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={soloIncidencias} onChange={(e) => setSoloIncidencias(e.target.checked)} /> Solo con incidencias</label>
              {datos.tipoRecurso && Object.keys(datos.tipoRecurso).length > 0 && (
                <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={soloPersonas} onChange={(e) => setSoloPersonas(e.target.checked)} /> Solo personas (sin máquinas)</label>
              )}
              <span className="text-xs text-slate-400">{visibles.length} trabajadores · jornada {ajustes.jornada} h{ajustes.jornadaViernes ? ` (viernes ${ajustes.jornadaViernes} h)` : ""}</span>
              <button
                type="button"
                onClick={abrirAvisoResponsable}
                disabled={!filasAviso.length}
                title={filasAviso.length
                  ? (deptoActivo
                    ? `Enviar al responsable de ${deptoActivo} el listado de días incompletos, sin imputar e incidencias`
                    : "Enviar al responsable del departamento el listado de días incompletos, sin imputar e incidencias")
                  : "No hay días incompletos, sin imputar ni incidencias en la vista actual"}
                className="px-3 py-1.5 rounded bg-amber-600 text-white text-sm disabled:opacity-40 hover:bg-amber-700"
              >
                ✉ Avisar responsable{filasAviso.length ? ` (${filasAviso.length})` : ""}
              </button>
              {avisoEnviado && <span className="text-xs text-emerald-700">{avisoEnviado}</span>}
              {pestana === "cuadro" && (
                <span className="flex gap-2 text-xs">
                  <button onClick={() => setPlegados({})} className="underline text-slate-500">Desplegar todos</button>
                  <button onClick={() => setPlegados(Object.fromEntries(visibles.map((r) => [r.recurso, true])))} className="underline text-slate-500">Plegar todos</button>
                </span>
              )}
            </div>
          )}

          {pestana === "cuadro" && (
            <>
              <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-slate-600">
                {[["bg-emerald-500", "Jornada completa"], ["bg-amber-400", "Faltan horas"], ["bg-red-100", "Sin imputar"], ["bg-violet-500", "Fin de semana / festivo trabajado"], ["bg-[#dce6f2]", "Fin de semana / festivo"]].map(([c, t]) => (
                  <span key={t} className="flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded-sm ${c}`} />{t}</span>
                ))}
              </div>
              <section className="mt-2 w-full bg-white rounded-lg shadow-sm border border-slate-300 overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-[11px] text-slate-600 bg-slate-100">
                      <th className="px-3 py-1.5 text-left sticky left-0 z-10 bg-slate-100 min-w-[280px] border border-slate-200">Trabajador / tipo de línea</th>
                      {columnas.map((c) => (
                        <th key={c} className={`px-1 py-1 font-semibold border border-slate-200 ${!porSemanas && jornadaDia(c) === 0 ? "bg-[#dce6f2] text-slate-400" : ""}`}>
                          {porSemanas ? `S ${fmtF(c).slice(0, 5)}` : <>{DIAS[diaSemana(c)]}<br />{c.slice(8)}</>}
                        </th>
                      ))}
                      <th className="px-2 py-1 text-right border border-slate-200">Total</th>
                      <th className="px-2 py-1 text-right border border-slate-200">Extras</th>
                      <th className="px-2 py-1 text-right border border-slate-200">Ausenc.</th>
                      <th className="px-2 py-1 text-right border border-slate-200" title="Días laborables sin ninguna hora imputada">Sin imp.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((r) => {
                      const abierto = !plegados[r.recurso];
                      const codigosFila = [...new Set(r.movs.map((m) => m.tipoTrabajo || "(sin tipo)"))].sort();
                      return (
                        <React.Fragment key={r.recurso}>
                          <tr className="bg-[#dce6f2]">
                            <td className="px-2 py-1.5 sticky left-0 z-10 bg-[#dce6f2] border border-white">
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => setPlegados((a) => ({ ...a, [r.recurso]: abierto }))} className="text-slate-600 w-4 text-[11px]" title={abierto ? "Plegar" : "Desplegar"}>{abierto ? "▼" : "▶"}</button>
                                <div>
                                  <button onClick={() => { setSel(r.recurso); setPestana("detalle"); }} className="text-left font-bold text-[12.5px] text-slate-800 uppercase hover:underline" title={`Nº recurso ${r.recurso}${deptoDe(r.recurso) ? ` · ${deptoDe(r.recurso)}` : ""}`}>{r.nombre}</button>
                                  {deptoDe(r.recurso) && <div className="text-[10px] font-normal normal-case text-slate-600">{deptoDe(r.recurso)}</div>}
                                </div>
                              </div>
                            </td>
                            {columnas.map((c) => celda(r, c))}
                            <td className="px-2 text-right font-bold text-slate-800 border border-white">{h(r.t.trabajadas + r.t.ausencias)}</td>
                            <td className="px-2 text-right font-semibold text-violet-700 border border-white">{h(r.t.extras)}</td>
                            <td className="px-2 text-right font-semibold text-sky-700 border border-white">{h(r.t.ausencias)}</td>
                            <td className={`px-2 text-right border border-white ${r.t.sinImputar ? "text-red-600 font-bold" : "text-slate-400"}`}>{r.t.sinImputar || ""}</td>
                          </tr>
                          {abierto && codigosFila.map((cod) => (
                            <tr key={cod}>
                              <td className="pl-9 pr-2 py-1 sticky left-0 z-10 bg-white text-[12px] text-slate-600 border border-slate-200">{cod}</td>
                              {columnas.map((c) => celdaCodigo(r, cod, c))}
                              <td className="px-2 text-right text-[12px] text-slate-700 border border-slate-200">{h(r.movs.filter((m) => (m.tipoTrabajo || "(sin tipo)") === cod).reduce((t, m) => t + m.horas, 0))}</td>
                              <td colSpan={3} className="border border-slate-200" />
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </section>
              {diaDetalle && (() => {
                const movs = diaDetalle.r.movs.filter((m) => diaDetalle.dias.includes(m.fecha)).sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
                const varios = diaDetalle.dias.length > 1;
                return (
                  <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-4" onClick={() => setDiaDetalle(null)}>
                    <div className="bg-white rounded-xl shadow-2xl p-6 max-w-3xl w-full max-h-[80vh] overflow-y-auto relative" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setDiaDetalle(null)} className="absolute top-3 right-4 text-slate-400 hover:text-slate-600 text-lg">✕</button>
                      <h2 className="text-lg font-bold text-slate-800 pr-6">{diaDetalle.r.nombre}{deptoDe(diaDetalle.r.recurso) ? ` · ${deptoDe(diaDetalle.r.recurso)}` : ""} — {diaDetalle.titulo}</h2>
                      <table className="w-full text-sm mt-4 border">
                        <thead>
                          <tr className="bg-slate-50 text-slate-600">
                            {varios && <th className="px-3 py-1.5 border text-left">Fecha</th>}
                            <th className="px-3 py-1.5 border text-left">Tipo de hora</th>
                            <th className="px-3 py-1.5 border text-right">Horas</th>
                            <th className="px-3 py-1.5 border text-left">Nº Parte</th>
                            <th className="px-3 py-1.5 border text-left">Nº OT</th>
                            <th className="px-3 py-1.5 border text-left">Cliente</th>
                          </tr>
                        </thead>
                        <tbody>
                          {movs.map((m, k) => (
                            <tr key={k}>
                              {varios && <td className="px-3 py-1 border whitespace-nowrap">{fmtF(m.fecha)}</td>}
                              <td className="px-3 py-1 border font-mono text-xs">{m.tipoTrabajo || "—"}</td>
                              <td className="px-3 py-1 border text-right">{h(m.horas)}{m.cantidadOriginal != null ? <div className="text-[10px] text-slate-400">{h(m.cantidadOriginal)} {m.unidad}</div> : null}</td>
                              <td className="px-3 py-1 border">{m.doc}</td>
                              <td className="px-3 py-1 border">{m.ot}</td>
                              <td className="px-3 py-1 border">{datos.clientes?.[m.ot] || ""}</td>
                            </tr>
                          ))}
                          <tr className="bg-slate-50 font-semibold">
                            <td className="px-3 py-1.5 border" colSpan={varios ? 2 : 1}>Total</td>
                            <td className="px-3 py-1.5 border text-right">{h(movs.reduce((t, m) => t + m.horas, 0))}</td>
                            <td className="border" colSpan={3} />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
              <p className="text-xs text-slate-400 mt-2">Solo movimientos de tipo «Uso». Pulsa ▼ para plegar o desplegar las líneas de un trabajador y pulsa un día para ver su detalle (parte, OT y cliente). Debajo del nombre: Nº de recurso y códigos de tipo de trabajo del periodo. Los festivos (generales y de la población) y las incidencias de «Configuración» se tienen en cuenta. Pulsa un trabajador para ver sus movimientos.</p>
            </>
          )}

          {pestana === "extras" && (
            <section className="mt-3 bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
              {amianto?.error && <p className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-b">Amianto: {amianto.error}</p>}
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 bg-slate-50">
                    <th className="px-3 py-2">Trabajador</th>
                    <th className="px-3 py-2 text-right">Extras declaradas</th>
                    <th className="px-3 py-2 text-right">Exceso sobre jornada</th>
                    {AUSENCIAS.map((a) => <th key={a} className="px-3 py-2 text-right">{CATS[a].txt}</th>)}
                    <th className="px-3 py-2 text-right">Faltan (días incompletos)</th>
                    <th className="px-3 py-2 text-right">Días sin imputar</th>
                    <th className="px-3 py-2 text-right" title="Días distintos con parte esAmiant=1 (app)">Días amianto</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.filter((r) => r.t.extras || r.t.exceso || r.t.ausencias || r.t.faltan || r.t.sinImputar || diasAmiantoDe(r.recurso)).map((r) => (
                    <tr key={r.recurso} className="border-t border-slate-100">
                      <td className="px-3 py-1.5">
                        <button onClick={() => { setSel(r.recurso); setPestana("detalle"); }} className="hover:underline font-medium text-slate-700">{r.nombre}</button>
                        {deptoDe(r.recurso) && <div className="text-[10px] text-slate-500">{deptoDe(r.recurso)}</div>}
                      </td>
                      <td className="px-3 text-right text-purple-700">{h(r.t.extras)}</td>
                      <td className="px-3 text-right text-purple-700">{h(r.t.exceso)}</td>
                      {AUSENCIAS.map((a) => <td key={a} className={`px-3 text-right ${CATS[a].color}`}>{h(r.t.porAus[a])}</td>)}
                      <td className="px-3 text-right text-amber-700">{h(r.t.faltan)}</td>
                      <td className="px-3 text-right text-red-600">{r.t.sinImputar || ""}</td>
                      <td className="px-3 text-right font-medium text-amber-800">{diasAmiantoDe(r.recurso) || ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold text-slate-700">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.extras, 0))}</td>
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.exceso, 0))}</td>
                    {AUSENCIAS.map((a) => <td key={a} className="px-3 text-right">{h(visibles.reduce((t, r) => t + (r.t.porAus[a] || 0), 0))}</td>)}
                    <td className="px-3 text-right">{h(visibles.reduce((t, r) => t + r.t.faltan, 0))}</td>
                    <td className="px-3 text-right">{visibles.reduce((t, r) => t + r.t.sinImputar, 0) || ""}</td>
                    <td className="px-3 text-right">{visibles.reduce((t, r) => t + diasAmiantoDe(r.recurso), 0) || ""}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-xs text-slate-400 px-3 py-2">«Extras declaradas» = horas con un tipo de trabajo clasificado como extra. «Exceso» = horas normales por encima de la jornada o en fin de semana/festivo (posibles extras sin declarar). «Días amianto» = días distintos con parte de la app marcado esAmiant (fecha de creación del parte). La clasificación se cambia en «Tipos de trabajo y jornada».</p>
            </section>
          )}

          {pestana === "detalle" && (
            <div className="mt-3">
              <select value={sel || ""} onChange={(e) => setSel(e.target.value || null)} className={input}>
                <option value="">— Elige un trabajador —</option>
                {calc.lista.map((r) => <option key={r.recurso} value={r.recurso}>{r.nombre} ({r.recurso})</option>)}
              </select>
              {sel && (() => {
                const r = calc.lista.find((x) => x.recurso === sel);
                if (!r) return <p className="text-sm text-slate-500 mt-2">Sin movimientos en el periodo.</p>;
                const movs = [...r.movs].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
                return (
                  <section className="mt-3 bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
                    <div className="px-3 py-2 text-sm text-slate-600 border-b bg-slate-50">
                      <b>{r.nombre}</b>{deptoDe(r.recurso) ? ` · ${deptoDe(r.recurso)}` : ""} · trabajadas {h(r.t.trabajadas) || 0} h de {h(r.t.teoricas) || 0} teóricas · extras {h(r.t.extras) || 0} · exceso {h(r.t.exceso) || 0} · ausencias {h(r.t.ausencias) || 0} · {r.t.sinImputar} días sin imputar
                    </div>
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-xs text-slate-500"><th className="px-3 py-1.5">Fecha</th><th className="px-3">OT</th><th className="px-3">Tarea</th><th className="px-3">Tipo trabajo</th><th className="px-3">Clasificación</th><th className="px-3 text-right">Horas</th><th className="px-3">Descripción</th><th className="px-3">Documento</th></tr></thead>
                      <tbody>
                        {movs.map((m, k) => (
                          <tr key={k} className="border-t border-slate-100">
                            <td className="px-3 py-1 whitespace-nowrap">{DIAS[diaSemana(m.fecha)]} {fmtF(m.fecha)}</td>
                            <td className="px-3 whitespace-nowrap">{m.ot}</td>
                            <td className="px-3">{m.tarea}</td>
                            <td className="px-3">{m.tipoTrabajo || "—"}</td>
                            <td className={`px-3 ${CATS[m.cat].color}`}>{CATS[m.cat].txt}</td>
                            <td className="px-3 text-right font-medium">{h(m.horas)}</td>
                            <td className="px-3 text-slate-500">{m.desc}</td>
                            <td className="px-3 text-slate-400 text-xs">{m.doc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                );
              })()}
            </div>
          )}

          {pestana === "config" && (
            <ConfiguracionHoras ajustes={ajustes} guardarAjustes={guardarAjustes} trabajadores={calc.lista} codigos={calc.tipos.map((t) => t.cod).filter(Boolean)} />
          )}
          {veTarifas && pestana === "tarifas" && (
            <TarifasHoras trabajadores={calc.lista} codigos={calc.tipos.map((t) => t.cod || "(sin tipo)")} ajustes={ajustes} desde={datos.desde} hasta={datos.hasta} amianto={amianto} />
          )}

          {pestana === "tipos" && (
            <div className="grid lg:grid-cols-2 gap-5 mt-3">
              <section className="bg-white rounded-xl shadow-sm border border-slate-200">
                <div className="px-4 py-2 border-b bg-slate-50 font-semibold text-slate-800 text-sm">Tipos de trabajo de BC {guardado && <span className="ml-2 text-xs text-green-700 font-normal">{guardado}</span>}</div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500"><th className="px-4 py-1.5">Código</th><th className="px-4">Unidad</th><th className="px-4 text-right">Horas</th><th className="px-4">Cuenta como</th></tr></thead>
                  <tbody>
                    {calc.tipos.map((t) => (
                      <tr key={t.cod} className="border-t border-slate-100">
                        <td className="px-4 py-1 font-mono">{t.cod || "(sin tipo)"}</td>
                        <td className="px-4 text-slate-500">{[...t.unidades].join(", ")}</td>
                        <td className="px-4 text-right">{h(t.horas)}</td>
                        <td className="px-4">
                          <select value={ajustes.tipos?.[t.cod] || adivinar(t.cod)} onChange={(e) => guardarAjustes({ ...ajustes, tipos: { ...ajustes.tipos, [t.cod]: e.target.value } })} className="border rounded px-1 py-0.5 text-sm">
                            {Object.entries(CATS).filter(([k]) => k !== "noHoras").map(([k, v]) => <option key={k} value={k}>{v.txt}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-slate-400 px-4 py-2">La primera vez se clasifica por el nombre del código (EXTRA, VAC, BAJA, FEST…). Cambia lo que no esté bien; se guarda solo.</p>
              </section>
              <section className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm grid gap-3 content-start">
                <div className="font-semibold text-slate-800">Jornada y festivos</div>
                <label className="flex items-center gap-2">Jornada diaria (lunes a jueves)
                  <input type="number" step="0.25" value={ajustes.jornada} onChange={(e) => setAjustes({ ...ajustes, jornada: e.target.value })} onBlur={() => guardarAjustes(ajustes)} className={`${input} w-20`} /> h
                </label>
                <label className="flex items-center gap-2">Jornada del viernes (vacío = igual)
                  <input type="number" step="0.25" value={ajustes.jornadaViernes || ""} onChange={(e) => setAjustes({ ...ajustes, jornadaViernes: e.target.value || null })} onBlur={() => guardarAjustes(ajustes)} className={`${input} w-20`} /> h
                </label>
                <FestivosLinea ajustes={ajustes} guardarAjustes={guardarAjustes} trabajadores={calc.lista} />
                <p className="text-xs text-slate-400">Los festivos y fines de semana no cuentan como días sin imputar; si alguien trabaja ese día, sale como exceso.</p>
              </section>
            </div>
          )}
        </>
      )}

      {elegirDeptoAviso && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setElegirDeptoAviso(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100">
              <div className="text-sm font-semibold text-slate-800">¿A qué departamento avisar?</div>
              <p className="text-[11px] text-slate-500 mt-1">Hay incidencias en varios departamentos. Elige uno para preparar el correo a sus responsables.</p>
            </div>
            <ul className="px-3 py-3 space-y-2 max-h-80 overflow-y-auto">
              {elegirDeptoAviso.opciones.map((o) => (
                <li key={o.nombre}>
                  <button
                    type="button"
                    className="w-full text-left px-4 py-3 text-sm rounded-xl border border-slate-200 bg-white hover:bg-amber-50 hover:border-amber-200 flex justify-between gap-3 items-center"
                    onClick={() => abrirSeleccionTrabajadores(o.nombre)}
                  >
                    <span className="font-medium text-slate-800">{o.nombre}</span>
                    <span className="text-xs text-slate-500 shrink-0">{o.n} trabajador{o.n === 1 ? "" : "es"}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-5 py-3 border-t border-slate-100 flex justify-end">
              <button type="button" onClick={() => setElegirDeptoAviso(null)} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {elegirTrabajadoresAviso && (() => {
        const { deptoNombre, filas, seleccionados } = elegirTrabajadoresAviso;
        const nSel = Object.values(seleccionados).filter(Boolean).length;
        const todos = nSel === filas.length && filas.length > 0;
        const volverADepto = () => {
          setElegirTrabajadoresAviso(null);
          if (deptoActivo) return;
          const porDep = new Map();
          for (const f of filasAviso) porDep.set(f.depto, (porDep.get(f.depto) || 0) + 1);
          const opciones = [...porDep.entries()]
            .map(([nombre, n]) => ({ nombre, n }))
            .sort((a, b) => (a.nombre === SIN_DEPTO ? 1 : b.nombre === SIN_DEPTO ? -1 : a.nombre.localeCompare(b.nombre, "es")));
          if (opciones.length > 1) setElegirDeptoAviso({ opciones });
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setElegirTrabajadoresAviso(null)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-slate-100">
                <div className="text-sm font-semibold text-slate-800">¿Qué trabajadores incluir en el correo?</div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Departamento <b>{deptoNombre}</b>. Marca solo los que deben aparecer en el aviso al responsable.
                </p>
              </div>
              <div className="px-5 pt-3 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span>{nSel} de {filas.length} seleccionados</span>
                <button
                  type="button"
                  className="underline text-slate-600 hover:text-slate-900"
                  onClick={() => setElegirTrabajadoresAviso((s) => ({
                    ...s,
                    seleccionados: Object.fromEntries(s.filas.map((f) => [f.recurso, !todos])),
                  }))}
                >
                  {todos ? "Quitar todos" : "Seleccionar todos"}
                </button>
              </div>
              <ul className="px-3 py-3 space-y-2 max-h-80 overflow-y-auto">
                {filas.map((f) => {
                  const checked = !!seleccionados[f.recurso];
                  return (
                    <li key={f.recurso}>
                      <label
                        className={`flex items-start gap-3 px-4 py-3 text-sm rounded-xl border cursor-pointer ${
                          checked ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={checked}
                          onChange={(e) => setElegirTrabajadoresAviso((s) => ({
                            ...s,
                            seleccionados: { ...s.seleccionados, [f.recurso]: e.target.checked },
                          }))}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="font-medium text-slate-800 block truncate">{f.nombre}</span>
                          <span className="text-[11px] text-slate-500">{f.recurso} · {resumenCortoTrabajador(f)}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="px-5 py-3 border-t border-slate-100 flex justify-between gap-2">
                <button type="button" onClick={volverADepto} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                  {deptoActivo ? "Cancelar" : "Atrás"}
                </button>
                <div className="flex gap-2">
                  {!deptoActivo && (
                    <button type="button" onClick={() => setElegirTrabajadoresAviso(null)} className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
                  )}
                  <button
                    type="button"
                    disabled={!nSel}
                    onClick={confirmarTrabajadoresAviso}
                    className="text-sm font-semibold px-4 py-1.5 rounded-lg text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-40"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {avisoHoras && (
        <ModalCorreoAvisoHoras
          borrador={avisoHoras}
          onCerrar={() => setAvisoHoras(null)}
          onEnviado={({ para }) => {
            setAvisoHoras(null);
            setAvisoEnviado(`Correo enviado a ${para.join(", ")}`);
            setTimeout(() => setAvisoEnviado(""), 5000);
          }}
        />
      )}

      {verAmianto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setVerAmianto(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white">
              <div>
                <div className="font-semibold text-slate-800">Partes amianto cargados de la app</div>
                <div className="text-xs text-slate-500">
                  Periodo {datos ? `${fmtF(datos.desde)} – ${fmtF(datos.hasta)}` : "—"} ·
                  {amianto?.error ? ` Error: ${amianto.error}` : ` ${amianto?.partes?.length ?? 0} partes con esAmiant = 1`}
                  {amianto?.cargando ? " · cargando…" : ""}
                </div>
              </div>
              <button type="button" onClick={() => setVerAmianto(false)} className="text-slate-400 hover:text-slate-700 text-lg px-2">✕</button>
            </div>
            {!amianto?.partes?.length ? (
              <p className="p-4 text-sm text-slate-500">
                {amianto?.error
                  ? amianto.error
                  : "No hay partes de amianto en este periodo (o aún no se han cargado). Prueba a ampliar las fechas y pulsar «Cargar desde BC»."}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 bg-slate-50">
                    <th className="px-3 py-2">Fecha</th>
                    <th className="px-3 py-2">Cód. trabajador</th>
                    <th className="px-3 py-2">Trabajador</th>
                    <th className="px-3 py-2">OT</th>
                    <th className="px-3 py-2">Nº parte</th>
                    <th className="px-3 py-2">id parte</th>
                  </tr>
                </thead>
                <tbody>
                  {[...amianto.partes].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0)).map((p) => (
                    <tr key={p.id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 whitespace-nowrap">{fmtF(p.fecha)}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{p.codiTreballador}</td>
                      <td className="px-3 py-1.5">{p.treballador}</td>
                      <td className="px-3 py-1.5">{p.idOT || "—"}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{p.codigoParte || "—"}</td>
                      <td className="px-3 py-1.5 text-slate-400 text-xs">{p.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="px-4 py-2 border-t text-xs text-slate-400 sticky bottom-0 bg-white">
              Estos son los datos crudos de ALSOAPP. Se agrupan por trabajador y día (1 día = 1 plus, aunque haya varios partes el mismo día).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
