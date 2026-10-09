/**
 * chatIA.jsx — Pantalla «Asistente IA» del Agente de Ventas (24/09/2026).
 *
 * Chat con Claude conectado a Business Central (backend/iaBC.cjs):
 *  · Consulta cualquier dato de ALSO CASALS, FERROSCA y QUIMLAB.
 *  · Los cambios (modificar campos / crear registros o líneas) llegan
 *    como TARJETAS: solo se aplican al pulsar «Aplicar». No borra ni
 *    registra documentos.
 *  · Historial de cambios aplicados: backend/data/cambios_bc.json.
 * La conversación se guarda en el navegador (localStorage) para no
 * perderla al recargar. Además, TODOS los chats se guardan en el backend
 * (backend/data/chats_ia/) y se pueden volver a abrir desde «Chats guardados».
 */
import React, { useState, useEffect, useRef } from "react";
import { Send, CheckCircle2, X, RefreshCw, Trash2, History, Bot, Paperclip, Eye, ExternalLink, Pin, Pencil, MessageSquare, Plus, ClipboardCopy } from "lucide-react";

function esSeparadorTabla(linea) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(linea);
}

function celdasMarkdown(linea) {
  let s = String(linea || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function trozosMensaje(texto) {
  const lineas = String(texto || "").split(/\r?\n/);
  const bloques = [];
  let buf = [];
  const volcar = () => {
    if (!buf.length) return;
    bloques.push({ tipo: "texto", valor: buf.join("\n") });
    buf = [];
  };
  for (let i = 0; i < lineas.length; i++) {
    const sig = lineas[i + 1] || "";
    if (lineas[i].includes("|") && esSeparadorTabla(sig)) {
      volcar();
      const cabecera = celdasMarkdown(lineas[i]);
      const filas = [];
      i += 2;
      while (i < lineas.length && lineas[i].includes("|") && lineas[i].trim()) {
        filas.push(celdasMarkdown(lineas[i]));
        i++;
      }
      i--;
      bloques.push({ tipo: "tabla", cabecera, filas });
    } else {
      buf.push(lineas[i]);
    }
  }
  volcar();
  return bloques;
}

function TextoConNegrita({ texto }) {
  const partes = String(texto ?? "").split(/(\*\*[^*]+\*\*)/g);
  return partes.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4
      ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  );
}

function celdaNumerica(cab, valor) {
  if (/precio|coste|importe|cantidad|uds|margen|%/i.test(cab || "")) return true;
  return /^[\d.,\s€%+-]+$/.test(String(valor || "").replace(/\*/g, ""));
}

function parseImporte(s) {
  let t = String(s || "").replace(/\*/g, "").replace(/€/g, "").replace(/\s/g, "").trim();
  if (!t || t === "—" || t === "–" || t === "-") return null;
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Columna de precio a aplicar: el sugerido, si la tabla lo trae. */
function indicePrecioPedido(cab) {
  const sugerido = cab.findIndex((c) => /sugerid|propuest/i.test(c));
  if (sugerido >= 0) return sugerido;
  let idx = -1;
  cab.forEach((c, i) => {
    if (/precio|pvp/i.test(c) && !/coste|cost|actual/i.test(c)) idx = i;
  });
  if (idx >= 0) return idx;
  return cab.findIndex((c) => /precio|pvp/i.test(c) && !/coste|cost/i.test(c));
}

/** Artículos con precio de venta que se pueden pegar en el pedido de BC. */
function filasParaPedido(bloques) {
  const out = [];
  const vistos = new Set();
  for (const b of bloques) {
    if (b.tipo !== "tabla") continue;
    const cab = b.cabecera.map((c) => String(c || ""));
    const iNo = cab.findIndex((c) => /art[ií]culo|referencia|^n[ºo.°]|^c[oó]d/i.test(c) && !/descri|almac|negocio|empleado|iva|unid|ot\b/i.test(c));
    const iDesc = cab.findIndex((c) => /descripci/i.test(c));
    const iPrecio = indicePrecioPedido(cab);
    const iCant = cab.findIndex((c) => /cantidad|^uds|^cant/i.test(c));
    for (const celdas of b.filas) {
      let no = iNo >= 0 ? String(celdas[iNo] || "").replace(/\*/g, "").trim() : "";
      if (!/^PR\d{5,}/i.test(no)) {
        const hit = celdas.find((c) => /^PR\d{5,}/i.test(String(c || "").replace(/\*/g, "").trim()));
        no = hit ? String(hit).replace(/\*/g, "").trim() : "";
      }
      if (!no) continue;
      const precio = iPrecio >= 0 ? parseImporte(celdas[iPrecio]) : null;
      if (precio == null) continue;
      const clave = no.toUpperCase();
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.push({
        no: clave,
        descripcion: iDesc >= 0 ? String(celdas[iDesc] || "").replace(/\*/g, "").trim() : "",
        precio,
        cantidad: iCant >= 0 ? parseImporte(celdas[iCant]) : null,
      });
    }
  }
  return out;
}

function copiarAlPortapapeles(tsv, html) {
  const plano = () => {
    const ta = document.createElement("textarea");
    ta.value = tsv;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]).then(() => true).catch(() => plano());
  }
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(tsv).then(() => true).catch(() => plano());
  return Promise.resolve(plano());
}

function BotonPegarPedido({ filas, texto, empresaId }) {
  const [estado, setEstado] = useState("listo");
  const [msg, setMsg] = useState("");
  const copiar = async () => {
    setEstado("cargando");
    setMsg("");
    const ot = (String(texto || "").match(/\b(?:AC|FCA)\d{4,7}\/\d{4}\b/) || [])[0] || "";
    const documento = (String(texto || "").match(/\bP[VF]\d{2}-\d{3,}\b/i) || [])[0] || "";
    try {
      const r = await fetch("/api/ia-bc/copiar-pedido", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empresa: empresaId, articulos: filas, ot, documento }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "No he podido preparar el pedido");
      const ok = await copiarAlPortapapeles(j.tsv || "", j.html || "");
      if (!ok) throw new Error("El navegador no ha dejado copiar. Prueba de nuevo.");
      setEstado("ok");
      setMsg(j.mensaje || "Copiado. En el pedido de BC, selecciona las líneas y pulsa Ctrl+V.");
    } catch (e) {
      setEstado("error");
      setMsg(e.message || "No he podido copiar");
    }
  };
  const titulo = estado === "ok"
    ? (msg || "Copiado. En el pedido, selecciona las líneas y pulsa Ctrl+V.")
    : estado === "error"
      ? (msg || "No he podido copiar")
      : "Copiar todos los precios para pegar en el pedido";
  return (
    <button
      type="button"
      onClick={copiar}
      disabled={estado === "cargando"}
      title={titulo}
      className={`inline-flex items-center justify-center w-5 h-5 rounded shrink-0 ${estado === "ok" ? "bg-emerald-500 text-white" : estado === "error" ? "bg-red-500 text-white" : "bg-white/20 hover:bg-white/35 text-white"} disabled:opacity-60`}
    >
      {estado === "cargando" ? <RefreshCw size={11} className="animate-spin" /> : estado === "ok" ? <CheckCircle2 size={11} /> : <ClipboardCopy size={11} />}
    </button>
  );
}

/** Pinta el texto de la IA y convierte las tablas markdown en una tabla. */
export function MensajeConTablas({ texto, empresaId }) {
  const bloques = trozosMensaje(texto);
  const propuesta = filasParaPedido(bloques);
  return (
    <div className="space-y-2">
      {bloques.map((b, i) => b.tipo === "texto" ? (
        <div key={i} className="whitespace-pre-wrap"><TextoConNegrita texto={b.valor} /></div>
      ) : (
        <div key={i} className="space-y-2">
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="bg-slate-800 text-white">
                {b.cabecera.map((c, j) => (
                  <th key={j} className={`px-2 py-1.5 font-semibold whitespace-nowrap ${celdaNumerica(c, "") ? "text-right" : "text-left"}`}>
                    <span className={`inline-flex items-center gap-1 ${celdaNumerica(c, "") ? "justify-end w-full" : ""}`}>
                      <TextoConNegrita texto={c} />
                      {propuesta.length > 0 && i === bloques.findIndex((x) => x.tipo === "tabla") && j === indicePrecioPedido(b.cabecera) && (
                        <BotonPegarPedido filas={propuesta} texto={texto} empresaId={empresaId} />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.filas.map((fila, r) => (
                <tr key={r} className={r % 2 ? "bg-slate-50" : "bg-white"}>
                  {b.cabecera.map((cab, j) => (
                    <td key={j} className={`px-2 py-1 border-t border-slate-100 align-top text-slate-800 ${celdaNumerica(cab, fila[j]) ? "text-right tabular-nums whitespace-nowrap" : "text-left"} ${j === 0 ? "font-mono text-[11px] text-slate-600" : ""}`}>
                      <TextoConNegrita texto={fila[j] || ""} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      ))}
    </div>
  );
}

// Una conversación SEPARADA por empresa (24/09/2026)
const LS_CHAT = "agente_ventas_chat_ia_v1";
const LS_EMPRESA = "agente_ventas_chat_ia_empresa_v1";
const leerLS = (empresaId) => {
  try { return JSON.parse(localStorage.getItem(`${LS_CHAT}_${empresaId}`) || "null"); } catch { return null; }
};
const guardarLS = (empresaId, v) => { try { localStorage.setItem(`${LS_CHAT}_${empresaId}`, JSON.stringify(v)); } catch {} };
// Chat abierto ahora en cada empresa (id del chat guardado en el backend)
const LS_CHAT_ACTUAL = "agente_ventas_chat_ia_actual_v1";
const leerChatActual = (empresaId) => { try { return localStorage.getItem(`${LS_CHAT_ACTUAL}_${empresaId}`) || ""; } catch { return ""; } };
const guardarChatActual = (empresaId, id) => { try { if (id) localStorage.setItem(`${LS_CHAT_ACTUAL}_${empresaId}`, id); else localStorage.removeItem(`${LS_CHAT_ACTUAL}_${empresaId}`); } catch {} };
const leerEmpresaLS = () => { try { return localStorage.getItem(LS_EMPRESA) || ""; } catch { return ""; } };

// Color de cada empresa en los botones
const colorEmpresa = (nombre) => {
  const n = String(nombre || "").toLowerCase();
  if (n.includes("quimlab")) return { activo: "bg-emerald-600 text-white border-emerald-600", suave: "text-emerald-700 border-emerald-300 hover:bg-emerald-50", chip: "bg-emerald-100 text-emerald-800" };
  if (n.includes("ferros")) return { activo: "bg-orange-600 text-white border-orange-600", suave: "text-orange-700 border-orange-300 hover:bg-orange-50", chip: "bg-orange-100 text-orange-800" };
  return { activo: "bg-blue-600 text-white border-blue-600", suave: "text-blue-700 border-blue-300 hover:bg-blue-50", chip: "bg-blue-100 text-blue-800" };
};

const bienvenida = (empresa) => ({
  rol: "ia",
  texto:
    `Hola Maria 👋 Estás en ${empresa || "la empresa seleccionada"}: aquí solo consulto y modifico datos de esta empresa. Para otra, cambia con los botones de abajo.\n\n` +
    "Puedo consultar cualquier dato y prepararte cambios (modificar campos o crear líneas/registros). " +
    "Los cambios nunca se aplican solos: te saldrá una tarjeta y tú decides si pulsas «Aplicar».\n\n" +
    "Ejemplos:\n· ¿Qué líneas tiene pendientes de recibir el PC26-003403?\n· Pon el Nº de albarán 1.557.681 al pedido PC26-003403\n· Cambia la fecha de recepción esperada de la línea 20000 del PC26-003390 al 30/09/2026\n· Añade al PC26-003477 una línea del artículo PR000001587118, 1 ud a 12,08 € con 25 % de dto.",
});

// Imagen pegada/adjuntada → { media_type, data (base64), miniatura (dataURL pequeña) }.
// Se reduce si es muy grande (la IA admite hasta ~5 MB por imagen).
export function cargarImagen(fuente) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = reject;
    lector.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const dibujar = (maxLado, tipo, calidad) => {
          const k = Math.min(1, maxLado / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL(tipo, calidad);
        };
        let url = lector.result;
        let tipo = (fuente.type || "image/png").toLowerCase();
        if (!/^image\/(png|jpeg|gif|webp)$/.test(tipo) || fuente.size > 3.5 * 1024 * 1024 || Math.max(img.width, img.height) > 2400) {
          tipo = "image/jpeg";
          url = dibujar(2000, tipo, 0.9);
        }
        resolve({ media_type: tipo, data: url.split(",")[1], miniatura: dibujar(260, "image/jpeg", 0.7) });
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(fuente);
  });
}

const fmtValor = (v) => (v === null || v === undefined || v === "" ? "(vacío)" : typeof v === "object" ? JSON.stringify(v) : String(v));

// Lee cómo ha quedado el registro en BC y el enlace para abrirlo (24/09/2026)
async function verCambio(id) {
  const r = await fetch("/api/ia-bc/ver", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
  return j; // { registro, enlace, etiqueta }
}
const CAMPOS_OCULTOS = /^(@odata|id$|.*Id$|systemVersion|lastModifiedDateTime|SystemId|SystemModifiedAt|SystemCreatedAt|SystemCreatedBy|SystemModifiedBy|ETag)/i;

export function PanelResultado({ cambio, info }) {
  const reg = info?.registro || {};
  const cambiados = new Set(Object.keys(cambio.datos || {}));
  const campos = Object.keys(reg).filter((k) => !CAMPOS_OCULTOS.test(k) && reg[k] !== "" && reg[k] !== null && reg[k] !== undefined && typeof reg[k] !== "object");
  // primero los campos que ha tocado el cambio, luego el resto (máx. 30)
  campos.sort((a, b) => (cambiados.has(b) ? 1 : 0) - (cambiados.has(a) ? 1 : 0));
  return (
    <table className="w-full text-[11px] bg-white border border-emerald-200 rounded mt-2">
      <tbody>
        {campos.slice(0, 30).map((k) => (
          <tr key={k} className={`border-t border-slate-100 ${cambiados.has(k) ? "bg-emerald-50" : ""}`}>
            <td className="px-2 py-0.5 font-mono text-slate-500 w-1/3">{k}</td>
            <td className={`px-2 py-0.5 ${cambiados.has(k) ? "font-semibold text-emerald-800" : "text-slate-700"}`}>{fmtValor(reg[k])}</td>
          </tr>
        ))}
        {campos.length > 30 && <tr><td colSpan={2} className="px-2 py-0.5 text-slate-400">… y {campos.length - 30} campo(s) más</td></tr>}
      </tbody>
    </table>
  );
}

export function TarjetaCambio({ cambio, onAplicado, empresaId }) {
  const [estado, setEstado] = useState(cambio.estado || "pendiente");
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null); // resultado leído de BC tras aplicar
  const [verTabla, setVerTabla] = useState(false);
  const [errorVer, setErrorVer] = useState(null);
  const cargarInfo = async () => {
    try { setErrorVer(null); const j = await verCambio(cambio.id); setInfo(j); return j; }
    catch (e) { setErrorVer(e.message || String(e)); return null; }
  };

  const aplicar = async () => {
    setTrabajando(true); setError(null);
    try {
      const r = await fetch("/api/ia-bc/aplicar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cambio.id, empresa: empresaId }) });
      const texto = await r.text();
      let j = {};
      try { j = texto ? JSON.parse(texto) : {}; }
      catch { j = { error: texto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) }; }
      const plano = (v) => (v && typeof v === "object" ? (v.message || JSON.stringify(v)) : v);
      if (!r.ok) throw new Error(plano(j.error) || plano(j.detalle) || `Error ${r.status}`);
      setEstado("aplicado");
      onAplicado?.(cambio, true, j.cambio?.resultado);
      cargarInfo(); // para tener ya el enlace «Abrir en BC»
    } catch (e) {
      setError(e.message || String(e));
      setEstado("error");
      onAplicado?.(cambio, false, e.message);
    }
    setTrabajando(false);
  };
  const descartar = async () => {
    await fetch("/api/ia-bc/descartar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cambio.id }) }).catch(() => {});
    setEstado("descartado");
  };

  const color =
    estado === "aplicado" ? "border-emerald-300 bg-emerald-50" : estado === "descartado" ? "border-slate-200 bg-slate-50 opacity-70" : estado === "error" ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50";
  const campos = Object.keys(cambio.datos || {});
  return (
    <div className={`border rounded-lg p-3 text-[12px] ${color}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="font-semibold text-slate-800">
          {cambio.operacion === "crear" ? "➕ Crear registro" : "✏️ Modificar"} · {cambio.recurso}
        </div>
        <div className="text-[10px] text-slate-500">{cambio.empresa}</div>
      </div>
      <div className="text-slate-700 mb-2">{cambio.descripcion}</div>
      {cambio.clave && <div className="text-[10px] font-mono text-slate-500 mb-1">Registro: {cambio.clave}</div>}
      {cambio.contexto && Object.keys(cambio.contexto).length > 0 && (
        <div className="text-[10px] text-slate-500 mb-1">{Object.entries(cambio.contexto).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>
      )}
      <table className="w-full text-[11px] bg-white border border-slate-200 rounded mb-2">
        <thead>
          <tr className="bg-slate-50 text-slate-500 text-left">
            <th className="px-2 py-1">Campo</th>
            {cambio.operacion === "modificar" && <th className="px-2 py-1">Ahora</th>}
            <th className="px-2 py-1">{cambio.operacion === "modificar" ? "Pasará a" : "Valor"}</th>
          </tr>
        </thead>
        <tbody>
          {campos.map((k) => (
            <tr key={k} className="border-t border-slate-100">
              <td className="px-2 py-1 font-mono">{k}</td>
              {cambio.operacion === "modificar" && <td className="px-2 py-1 text-slate-500">{fmtValor(cambio.antes?.[k])}</td>}
              <td className="px-2 py-1 font-semibold text-slate-800" title={cambio.legible?.[k] ? `Id en BC: ${cambio.datos[k]}` : undefined}>
                {cambio.legible?.[k] || fmtValor(cambio.datos[k])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {estado === "pendiente" && (
        <div className="flex gap-2">
          <button onClick={aplicar} disabled={trabajando} className="flex items-center gap-1 text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded px-3 py-1.5">
            {trabajando ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Aplicar en BC
          </button>
          <button onClick={descartar} disabled={trabajando} className="flex items-center gap-1 text-[12px] text-slate-600 border border-slate-300 bg-white hover:bg-slate-50 rounded px-3 py-1.5">
            <X size={13} /> Descartar
          </button>
        </div>
      )}
      {estado === "aplicado" && (
        <div>
          <div className="text-emerald-700 font-semibold">✓ Aplicado en BC</div>
          <div className="mt-2 bg-white border border-emerald-200 rounded p-2">
            <div className="text-slate-700 mb-1.5">¿Desea ver los cambios?</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={async () => { if (!info) await cargarInfo(); setVerTabla((v) => !v); }}
                className="flex items-center gap-1 text-[12px] font-semibold text-emerald-700 border border-emerald-300 bg-white hover:bg-emerald-50 rounded px-3 py-1"
              >
                <Eye size={13} /> {verTabla ? "Ocultar" : "Ver aquí cómo ha quedado"}
              </button>
              {info?.enlace && (
                <a href={info.enlace} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded px-3 py-1">
                  <ExternalLink size={13} /> {info.etiqueta || "Abrir en BC"}
                </a>
              )}
            </div>
            {errorVer && <div className="text-[11px] text-red-600 mt-1">✗ {errorVer}</div>}
            {verTabla && info && <PanelResultado cambio={cambio} info={info} />}
          </div>
        </div>
      )}
      {estado === "descartado" && <div className="text-slate-500">Descartado — no se ha tocado BC</div>}
      {estado === "error" && <div className="text-red-700 break-words">✗ {error || "BC rechazó el cambio"}</div>}
    </div>
  );
}

// REGLAS APRENDIDAS: lo que Maria le enseña a la IA para que lo haga siempre igual
function PanelReglas({ reglas, empresa, onCambio }) {
  const [texto, setTexto] = useState("");
  const [ambito, setAmbito] = useState("esta");
  const [editando, setEditando] = useState(null); // {id, texto, ambito}
  const guardar = async (r) => {
    await fetch("/api/ia-bc/reglas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) }).catch(() => {});
    onCambio();
  };
  const borrar = async (id) => {
    if (!window.confirm("¿Borrar esta regla? La IA dejará de aplicarla.")) return;
    await fetch("/api/ia-bc/reglas/borrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
    onCambio();
  };
  const visibles = reglas.filter((r) => r.ambito === "todas" || r.ambito === empresa?.nombre);
  const otras = reglas.length - visibles.length;
  return (
    <div className="mb-3 bg-white border border-amber-200 rounded-lg p-3 max-h-80 overflow-y-auto text-[12px]">
      <div className="font-semibold text-slate-700 mb-1">📌 Reglas que la IA aplica siempre{empresa ? ` en ${empresa.nombre}` : ""}</div>
      <div className="text-[11px] text-slate-500 mb-2">
        Se aprenden solas cuando le dices en el chat «a partir de ahora siempre…» o «recuerda que…». También puedes escribirlas o corregirlas aquí.
        {otras > 0 && ` (${otras} regla(s) más de otras empresas.)`}
      </div>
      {visibles.length === 0 && <div className="text-slate-400 mb-2">Todavía no hay reglas.</div>}
      {visibles.map((r) =>
        editando?.id === r.id ? (
          <div key={r.id} className="flex gap-2 items-start border-t border-slate-100 py-1.5">
            <textarea value={editando.texto} onChange={(e) => setEditando({ ...editando, texto: e.target.value })} rows={2} className="flex-1 border border-slate-300 rounded px-2 py-1" />
            <button onClick={async () => { await guardar(editando); setEditando(null); }} className="text-[11px] font-semibold text-white bg-emerald-600 rounded px-2 py-1">Guardar</button>
            <button onClick={() => setEditando(null)} className="text-[11px] text-slate-500 px-1">Cancelar</button>
          </div>
        ) : (
          <div key={r.id} className="group flex gap-2 items-start border-t border-slate-100 py-1.5">
            <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 whitespace-nowrap ${r.ambito === "todas" ? "bg-purple-100 text-purple-800" : colorEmpresa(r.ambito).chip}`}>
              {r.ambito === "todas" ? "Todas" : r.ambito}
            </span>
            <span className="flex-1 text-slate-700">{r.texto}</span>
            <button onClick={() => setEditando({ id: r.id, texto: r.texto, ambito: r.ambito })} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-blue-600" title="Editar"><Pencil size={12} /></button>
            <button onClick={() => borrar(r.id)} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" title="Borrar"><Trash2 size={12} /></button>
          </div>
        )
      )}
      <div className="flex gap-2 items-center border-t border-slate-200 pt-2 mt-1">
        <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Nueva regla… p.ej. «Al crear clientes, pon siempre forma de pago Recibo 60 días»" className="flex-1 border border-slate-300 rounded px-2 py-1" />
        <select value={ambito} onChange={(e) => setAmbito(e.target.value)} className="border border-slate-300 rounded px-1 py-1">
          <option value="esta">Solo {empresa?.nombre || "esta empresa"}</option>
          <option value="todas">Las 3 empresas</option>
        </select>
        <button
          onClick={async () => { if (!texto.trim()) return; await guardar({ texto: texto.trim(), ambito: ambito === "todas" ? "todas" : empresa?.nombre || "todas" }); setTexto(""); }}
          className="text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded px-3 py-1"
        >
          Añadir
        </button>
      </div>
    </div>
  );
}

export default function ChatIA() {
  const [empresas, setEmpresas] = useState([]); // [{id, nombre}] permitidas (ALSO CASALS, FERROSCA, QUIMLAB)
  const [empresaId, setEmpresaId] = useState(leerEmpresaLS());
  const [errorEmpresas, setErrorEmpresas] = useState(null);
  const empresa = empresas.find((e) => e.id === empresaId) || null;
  const [mensajes, setMensajes] = useState([]);
  const [historial, setHistorial] = useState([]); // formato Anthropic (para la IA)
  const cargadoRef = useRef(""); // empresa cuya conversación está cargada
  const [chatId, setChatId] = useState(""); // id del chat guardado en el backend ("" = aún sin guardar)
  const chatIdRef = useRef("");
  const saltarGuardadoRef = useRef(false); // al ABRIR un chat no se re-guarda (no cambia su fecha)
  const [verChats, setVerChats] = useState(false);
  const [chats, setChats] = useState([]);
  const [buscarChat, setBuscarChat] = useState("");
  const cargarListaChats = (empId = empresa?.id) =>
    empId && fetch(`/api/ia-bc/chats?empresa=${encodeURIComponent(empId)}`).then((r) => r.json()).then((d) => setChats(d.chats || [])).catch(() => {});
  const fijarChatId = (id) => { chatIdRef.current = id || ""; setChatId(id || ""); if (empresa) guardarChatActual(empresa.id, id); };
  const [entrada, setEntrada] = useState("");
  const [imagenes, setImagenes] = useState([]); // imágenes pegadas/adjuntadas pendientes de enviar
  const inputImgRef = useRef(null);
  const añadirImagenes = async (ficheros) => {
    const lista = [...ficheros].filter((f) => f && /^image\//.test(f.type));
    for (const f of lista.slice(0, 10)) {
      try { const im = await cargarImagen(f); setImagenes((prev) => [...prev, im].slice(0, 10)); } catch {}
    }
  };
  const onPegar = (e) => {
    const fich = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile());
    if (fich.length) { e.preventDefault(); añadirImagenes(fich); }
  };
  const [ocupado, setOcupado] = useState(false);
  const [verCambios, setVerCambios] = useState(false);
  const [verReglas, setVerReglas] = useState(false);
  const [reglas, setReglas] = useState([]);
  const cargarReglas = () => fetch("/api/ia-bc/reglas").then((r) => r.json()).then((d) => setReglas(d.reglas || [])).catch(() => {});
  useEffect(() => { cargarReglas(); }, []);
  const [cambiosLog, setCambiosLog] = useState([]);
  const finRef = useRef(null);

  // Empresas disponibles para los botones
  useEffect(() => {
    fetch("/api/ia-bc/empresas")
      .then((r) => r.json())
      .then((d) => {
        const lista = d.empresas || [];
        setEmpresas(lista);
        if (!lista.length) setErrorEmpresas(d.error || "No se han encontrado empresas permitidas en BC.");
        setEmpresaId((act) => (lista.some((e) => e.id === act) ? act : (lista.find((e) => /also/i.test(e.nombre)) || lista[0])?.id || ""));
      })
      .catch((e) => setErrorEmpresas(`No se pudieron cargar las empresas (${e.message}). ¿Está el backend arrancado?`));
  }, []);

  // Al cambiar de empresa: se carga SU conversación (cada empresa tiene la suya)
  useEffect(() => {
    if (!empresa) return;
    try { localStorage.setItem(LS_EMPRESA, empresa.id); } catch {}
    cargadoRef.current = "";
    const idActual = leerChatActual(empresa.id);
    const g = leerLS(empresa.id); // copia local (respaldo / chats de antes de guardarlos en el backend)
    const aplicar = (c, id) => {
      setMensajes(c?.mensajes?.length ? c.mensajes : [bienvenida(empresa.nombre)]);
      setHistorial(c?.historial || []);
      chatIdRef.current = id || ""; setChatId(id || "");
      saltarGuardadoRef.current = true;
      cargadoRef.current = empresa.id;
    };
    if (idActual) {
      fetch(`/api/ia-bc/chats/${idActual}`).then((r) => (r.ok ? r.json() : null)).then((c) => aplicar(c || g, c ? idActual : "")).catch(() => aplicar(g, ""));
    } else aplicar(g, "");
    cargarListaChats(empresa.id);
  }, [empresa?.id]);

  useEffect(() => {
    if (empresa && cargadoRef.current === empresa.id && mensajes.length) guardarLS(empresa.id, { mensajes, historial });
  }, [mensajes, historial]);

  // Guardado automático del chat en el backend (en cuanto hay algo escrito por Maria)
  useEffect(() => {
    if (saltarGuardadoRef.current) { saltarGuardadoRef.current = false; return; }
    if (!empresa || cargadoRef.current !== empresa.id || !mensajes.some((m) => m.rol === "yo")) return;
    const empId = empresa.id;
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/ia-bc/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: chatIdRef.current || undefined, empresa: empId, empresaNombre: empresa.nombre, mensajes, historial }),
        });
        const j = await r.json();
        if (j.id && cargadoRef.current === empId && !chatIdRef.current) { chatIdRef.current = j.id; setChatId(j.id); guardarChatActual(empId, j.id); }
        if (verChats) cargarListaChats(empId);
      } catch {}
    }, 800);
    return () => clearTimeout(t);
  }, [mensajes, historial]);
  useEffect(() => { finRef.current?.scrollIntoView({ block: "nearest" }); }, [mensajes, ocupado]);

  const enviarTexto = async (texto, mostrar = true, imgs = []) => {
    if ((!texto && !imgs.length) || ocupado || !empresa) return;
    if (mostrar) setMensajes((m) => [...m, { rol: "yo", texto: texto || "(imágenes)", miniaturas: imgs.map((i) => i.miniatura) }]);
    setOcupado(true);
    try {
      const r = await fetch("/api/ia-bc/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje: texto, historial, empresa: empresa.id, imagenes: imgs.map((i) => ({ media_type: i.media_type, data: i.data })) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      setHistorial(j.historial || []);
      if ((j.pasos || []).some((p) => /regla/.test(p.herramienta) && p.ok)) cargarReglas();
      setMensajes((m) => [
        ...m,
        { rol: "ia", texto: j.texto || (j.cambios?.length ? "Te he preparado el cambio: revísalo y pulsa «Aplicar en BC»." : "(sin respuesta)"), pasos: j.pasos || [], cambios: j.cambios || [] },
      ]);
    } catch (e) {
      setMensajes((m) => [...m, { rol: "ia", texto: `✗ ${e.message || e}`, error: true }]);
    }
    setOcupado(false);
  };

  const enviar = () => {
    const t = entrada.trim();
    if (!t && !imagenes.length) return;
    const imgs = imagenes;
    setEntrada("");
    setImagenes([]);
    enviarTexto(t, true, imgs);
  };

  // Tras aplicar un cambio, se le cuenta a la IA para que lo sepa en la conversación
  const onAplicado = (cambio, ok, detalle) => {
    const nota = ok
      ? `[Aviso del sistema] Maria ha pulsado «Aplicar»: el cambio ${cambio.id} (${cambio.descripcion}) se ha APLICADO en BC correctamente.${detalle && typeof detalle === "object" ? ` Respuesta de BC: ${JSON.stringify(detalle).slice(0, 600)}` : ""}`
      : `[Aviso del sistema] Maria ha pulsado «Aplicar» pero BC RECHAZÓ el cambio ${cambio.id} (${cambio.descripcion}): ${detalle}. Explícale el motivo en palabras sencillas y, si se puede, propone una corrección.`;
    const nuevoNum = ok && detalle && typeof detalle === "object" ? detalle.number || detalle.No || detalle.documentNumber || "" : "";
    setMensajes((m) => [...m, { rol: "sistema", texto: ok ? `✓ Aplicado: ${cambio.descripcion}${nuevoNum ? ` (Nº en BC: ${nuevoNum})` : ""}` : `✗ BC rechazó: ${cambio.descripcion}` }]);
    if (!ok) enviarTexto(nota, false);
    else setHistorial((h) => [...h, { role: "user", content: nota }, { role: "assistant", content: [{ type: "text", text: "Entendido, cambio aplicado." }] }]);
  };

  // Nueva conversación: la actual ya está guardada (se puede reabrir en «Chats guardados»)
  const nueva = () => {
    if (ocupado) return;
    fijarChatId("");
    setMensajes([bienvenida(empresa?.nombre)]);
    setHistorial([]);
    cargarListaChats();
  };
  const abrirChat = async (id) => {
    if (ocupado) return;
    try {
      const c = await (await fetch(`/api/ia-bc/chats/${id}`)).json();
      if (!c?.id) throw new Error("no encontrado");
      saltarGuardadoRef.current = true;
      setMensajes(c.mensajes?.length ? c.mensajes : [bienvenida(empresa?.nombre)]);
      setHistorial(c.historial || []);
      fijarChatId(c.id);
      setVerChats(false);
    } catch { alert("No se pudo abrir ese chat."); }
  };
  const borrarChat = async (id) => {
    if (!window.confirm("¿Borrar este chat guardado? (Los cambios hechos en BC no se tocan.)")) return;
    await fetch("/api/ia-bc/chats/borrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
    if (id === chatIdRef.current) nueva();
    cargarListaChats();
  };

  const abrirCambios = async () => {
    setVerCambios((v) => !v);
    try { setCambiosLog((await (await fetch("/api/ia-bc/historial-cambios")).json()).cambios || []); } catch {}
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] max-w-5xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Bot size={24} /> Asistente IA</h1>
          <p className="text-slate-500 text-sm mt-1">
            Conectado a Business Central · los cambios solo se aplican cuando pulsas «Aplicar en BC».
            {empresa && <span className={`ml-2 text-[11px] font-semibold rounded px-2 py-0.5 ${colorEmpresa(empresa.nombre).chip}`}>Trabajando en: {empresa.nombre}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setVerReglas((v) => !v)} className="flex items-center gap-1 text-[12px] text-amber-700 border border-amber-300 bg-white hover:bg-amber-50 rounded-md px-3 py-1.5">
            <Pin size={13} /> Reglas aprendidas ({reglas.filter((r) => r.ambito === "todas" || r.ambito === empresa?.nombre).length})
          </button>
          <button onClick={abrirCambios} className="flex items-center gap-1 text-[12px] text-slate-600 border border-slate-300 bg-white hover:bg-slate-50 rounded-md px-3 py-1.5">
            <History size={13} /> Cambios aplicados
          </button>
          <button onClick={() => { setVerChats((v) => !v); cargarListaChats(); }} className="flex items-center gap-1 text-[12px] text-blue-700 border border-blue-300 bg-white hover:bg-blue-50 rounded-md px-3 py-1.5">
            <MessageSquare size={13} /> Chats guardados ({chats.length})
          </button>
          <button onClick={nueva} className="flex items-center gap-1 text-[12px] text-slate-600 border border-slate-300 bg-white hover:bg-slate-50 rounded-md px-3 py-1.5">
            <Plus size={13} /> Nueva conversación
          </button>
        </div>
      </div>

      {verChats && (
        <div className="mb-3 bg-white border border-blue-200 rounded-lg p-3 max-h-72 overflow-y-auto text-[12px]">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold text-slate-700">💬 Chats guardados{empresa ? ` de ${empresa.nombre}` : ""}</div>
            <input value={buscarChat} onChange={(e) => setBuscarChat(e.target.value)} placeholder="Buscar…" className="border border-slate-300 rounded px-2 py-0.5 text-[11px] w-44" />
          </div>
          {chats.length === 0 && <div className="text-slate-400">Todavía no hay chats guardados. Se guardan solos en cuanto escribes.</div>}
          {chats
            .filter((c) => !buscarChat.trim() || String(c.titulo || "").toLowerCase().includes(buscarChat.trim().toLowerCase()))
            .map((c) => (
              <div key={c.id} className={`group flex items-center gap-2 border-t border-slate-100 py-1.5 ${c.id === chatId ? "bg-blue-50" : ""}`}>
                <button onClick={() => abrirChat(c.id)} className="flex-1 text-left hover:text-blue-700 truncate" title={c.titulo}>
                  {c.id === chatId && <span className="text-blue-600 font-semibold">▸ </span>}
                  {c.titulo || "Conversación"}
                </button>
                <span className="text-[10px] text-slate-400 whitespace-nowrap">{c.nMensajes} msj · {new Date(c.actualizado).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <button onClick={() => borrarChat(c.id)} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" title="Borrar chat"><Trash2 size={12} /></button>
              </div>
            ))}
        </div>
      )}

      {verReglas && <PanelReglas reglas={reglas} empresa={empresa} onCambio={cargarReglas} />}

      {verCambios && (
        <div className="mb-3 bg-white border border-slate-200 rounded-lg p-3 max-h-60 overflow-y-auto text-[11px]">
          <div className="font-semibold text-slate-700 mb-1">Últimos cambios hechos en BC desde el asistente</div>
          {cambiosLog.length === 0 && <div className="text-slate-400">Todavía no hay ninguno.</div>}
          {cambiosLog.map((c, i) => (
            <div key={i} className="border-t border-slate-100 py-1">
              <span className={c.estado === "aplicado" ? "text-emerald-700" : "text-red-600"}>{c.estado === "aplicado" ? "✓" : "✗"}</span>{" "}
              <span className="text-slate-400">{new Date(c.aplicadoTs || c.ts).toLocaleString("es-ES")}</span> · {c.empresa} · {c.descripcion}{" "}
              <span className="font-mono text-slate-400">{c.recurso}{c.clave || ""}</span>{" "}
              {c.estado === "aplicado" && (
                <button
                  onClick={async () => { try { const j = await verCambio(c.id); if (j.enlace) window.open(j.enlace, "_blank"); else alert("No hay enlace directo para este tipo de registro."); } catch (e) { alert(e.message); } }}
                  className="text-blue-600 hover:underline"
                >
                  ↗ abrir en BC
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        {mensajes.map((m, i) =>
          m.rol === "sistema" ? (
            <div key={i} className="text-center text-[11px] text-slate-500">{m.texto}</div>
          ) : (
            <div key={i} className={`flex ${m.rol === "yo" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] space-y-2`}>
                {(m.miniaturas || []).length > 0 && (
                  <div className="flex flex-wrap gap-1 justify-end">
                    {m.miniaturas.map((src, k) => <img key={k} src={src} alt="" className="h-20 rounded border border-slate-200" />)}
                  </div>
                )}
                <div className={`text-[13px] rounded-lg px-3 py-2 ${m.rol === "yo" ? "bg-blue-600 text-white whitespace-pre-wrap" : m.error ? "bg-red-50 text-red-700 border border-red-200" : "bg-slate-100 text-slate-800"}`}>
                  {m.rol === "yo" ? m.texto : <MensajeConTablas texto={m.texto} empresaId={empresa?.id || empresaId} />}
                </div>
                {(m.pasos || []).filter((p) => p.herramienta === "guardar_regla" && p.ok).map((p, k) => (
                  <div key={`r${k}`} className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    📌 Regla guardada{p.entrada?.ambito === "todas" ? " (las 3 empresas)" : ""}: {p.entrada?.texto}
                  </div>
                ))}
                {(m.pasos || []).length > 0 && (
                  <details className="text-[10px] text-slate-400">
                    <summary className="cursor-pointer">{m.pasos.length} consulta(s) a BC</summary>
                    {m.pasos.map((p, k) => (
                      <div key={k} className={p.ok ? "" : "text-red-500"}>
                        {p.ok ? "·" : "✗"} {p.herramienta} {p.entrada?.recurso ? `· ${p.entrada.empresa || ""} · ${p.entrada.recurso}` : ""}{p.entrada?.filtro ? ` · ${p.entrada.filtro}` : ""}{p.error ? ` — ${p.error}` : ""}
                      </div>
                    ))}
                  </details>
                )}
                {(m.cambios || []).map((c) => <TarjetaCambio key={c.id} cambio={c} onAplicado={onAplicado} empresaId={empresa?.id} />)}
              </div>
            </div>
          )
        )}
        {ocupado && <div className="text-[12px] text-slate-400 flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Pensando y consultando BC…</div>}
        <div ref={finRef} />
      </div>

      {imagenes.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {imagenes.map((im, k) => (
            <div key={k} className="relative">
              <img src={im.miniatura} alt="" className="h-16 rounded border border-slate-300" />
              <button onClick={() => setImagenes((p) => p.filter((_, j) => j !== k))} className="absolute -top-1.5 -right-1.5 bg-white border border-slate-300 rounded-full p-0.5 text-slate-500 hover:text-red-600" title="Quitar">
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end mt-3">
        <input ref={inputImgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { añadirImagenes(e.target.files || []); e.target.value = ""; }} />
        <button onClick={() => inputImgRef.current?.click()} disabled={ocupado} title="Adjuntar imágenes (también puedes pegarlas con Ctrl+V)" className="text-slate-500 border border-slate-300 bg-white hover:bg-slate-50 rounded-md p-2.5">
          <Paperclip size={15} />
        </button>
        <textarea
          value={entrada}
          onPaste={onPegar}
          onChange={(e) => setEntrada(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
          rows={3}
          placeholder="Escribe aquí… Puedes pegar capturas con Ctrl+V (Enter para enviar, Mayús+Enter para salto de línea)"
          className="flex-1 text-[13px] border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
        />
        <button onClick={enviar} disabled={ocupado || (!entrada.trim() && !imagenes.length) || !empresa} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md px-4 py-2.5">
          <Send size={15} /> Enviar
        </button>
      </div>

      {/* Selector de EMPRESA (24/09/2026): cada una con su conversación.
          La IA solo puede consultar y modificar la empresa seleccionada. */}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] text-slate-500">Empresa:</span>
        {empresas.map((e) => {
          const c = colorEmpresa(e.nombre);
          const activa = e.id === empresaId;
          return (
            <button
              key={e.id}
              onClick={() => !ocupado && setEmpresaId(e.id)}
              disabled={ocupado}
              className={`text-[12px] font-semibold border rounded-md px-4 py-1.5 transition-colors ${activa ? c.activo : `bg-white ${c.suave}`}`}
              title={activa ? `Estás trabajando en ${e.nombre}` : `Cambiar a ${e.nombre} (su propia conversación)`}
            >
              {e.displayName || e.nombre}
            </button>
          );
        })}
        {errorEmpresas && <span className="text-[11px] text-red-600">{errorEmpresas}</span>}
      </div>
    </div>
  );
}
