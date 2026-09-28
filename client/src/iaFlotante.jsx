/**
 * iaFlotante.jsx — Botón flotante 🤖 con la IA en TODAS las pantallas del
 * Agente de Ventas (24/09/2026).
 *
 * Usa el mismo motor que la pantalla «Asistente IA» (backend/iaBC.cjs):
 * consulta BC, prepara altas/modificaciones que solo se aplican al pulsar
 * «Aplicar en BC», aprende reglas y trabaja SOLO en la empresa seleccionada
 * en el panel de la izquierda. Además envía a la IA la pantalla en la que
 * estás y el texto que tienes a la vista, para que entienda «este pedido»,
 * «esta OT», «estos datos»…
 *
 * Cada pantalla tiene su propia conversación mientras la app está abierta;
 * las conversaciones se guardan también en «Chats guardados» del Asistente IA.
 */
import React, { useEffect, useRef, useState } from "react";
import { Bot, Send, X, Paperclip, Plus, Minimize2 } from "lucide-react";
import { TarjetaCambio, cargarImagen } from "./chatIA.jsx";
import { empresaGuardada } from "./empresa.jsx";

const NOMBRES = {
  cargar: "Cargar datos",
  memoria: "Memoria histórica",
  explorador: "Explorador de OTs",
  recepcion: "Recepción de material",
  facturascompra: "Validación de facturas",
  precios: "Precios de artículos",
  pedidosventa: "Pedidos de venta",
  correo: "Correo",
  tareas: "Mis tareas",
  ratios: "Ratios financieros",
  horas: "Control de horas",
};

// Preguntas rápidas según la pantalla
const SUGERENCIAS = {
  cargar: ["¿Qué datos tengo cargados y de qué fecha?", "¿Qué me falta por actualizar?"],
  memoria: ["¿Qué suele cobrarse en trabajos parecidos?", "Resume lo que ves"],
  explorador: ["¿Qué OTs de la pantalla están pendientes de facturar?", "Resume esta OT"],
  recepcion: ["¿Qué pedidos llevan más retraso?", "¿Qué proveedores tienen más pedidos pendientes?"],
  facturascompra: ["¿Esta factura cuadra con el pedido?", "¿Qué facturas tengo pendientes de validar?"],
  precios: ["¿Qué artículos han subido más de precio?", "Compara los precios de este artículo entre proveedores"],
  pedidosventa: ["¿Qué pedidos de venta llevan más tiempo pendientes?", "Resume los pendientes por cliente"],
  correo: ["Resume los correos importantes", "¿Qué correos necesitan respuesta?"],
  tareas: ["¿Qué tareas son más urgentes?", "Organízame las tareas de hoy"],
  ratios: ["Explícame los ratios en fácil", "¿Qué ratio debería preocuparme más?"],
  horas: ["¿Quién tiene más días sin imputar?", "¿Quién acumula más horas extra?"],
};

// Texto visible de la pantalla (lo que Maria tiene delante), recortado
function textoPantalla() {
  const main = document.querySelector("main");
  if (!main) return "";
  return (main.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 9000);
}

export default function IAFlotante({ seccion }) {
  const [abierto, setAbierto] = useState(false);
  const [conv, setConv] = useState({}); // seccion -> { mensajes, historial, chatId }
  const [entrada, setEntrada] = useState("");
  const [imagenes, setImagenes] = useState([]);
  const [ocupado, setOcupado] = useState(false);
  const [usarPantalla, setUsarPantalla] = useState(true);
  const finRef = useRef(null);
  const inputImgRef = useRef(null);
  const chatIds = useRef({}); // seccion -> id del chat guardado

  const empresa = empresaGuardada();
  const empresaId = empresa?.id || "Also";
  const empresaNombre = empresa?.nombre || "ALSO CASALS";
  const pantalla = NOMBRES[seccion] || seccion;
  const actual = conv[seccion] || { mensajes: [], historial: [], chatId: "" };
  const fijar = (f) => setConv((c) => ({ ...c, [seccion]: { ...(c[seccion] || { mensajes: [], historial: [], chatId: "" }), ...f(c[seccion] || { mensajes: [], historial: [], chatId: "" }) } }));

  useEffect(() => { finRef.current?.scrollIntoView({ block: "nearest" }); }, [actual.mensajes.length, ocupado, abierto]);

  // Guardar la conversación en «Chats guardados» del Asistente IA
  const guardar = async (sec, datos) => {
    if (!datos.mensajes.some((m) => m.rol === "yo")) return;
    try {
      const r = await fetch("/api/ia-bc/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: chatIds.current[sec] || undefined, empresa: empresaId, empresaNombre, mensajes: [{ rol: "sistema", texto: `Chat desde «${NOMBRES[sec] || sec}»` }, ...datos.mensajes], historial: datos.historial }),
      });
      const j = await r.json();
      if (j.id) chatIds.current[sec] = j.id;
    } catch { /* guardar es opcional */ }
  };

  async function enviar(textoDirecto, mostrar = true, imgsDirectas) {
    const texto = (textoDirecto ?? entrada).trim();
    const imgs = imgsDirectas ?? imagenes;
    if ((!texto && !imgs.length) || ocupado) return;
    const sec = seccion;
    const previo = conv[sec] || { mensajes: [], historial: [], chatId: "" };
    const mensajesYo = mostrar ? [...previo.mensajes, { rol: "yo", texto: texto || "(imágenes)", miniaturas: imgs.map((i) => i.miniatura) }] : previo.mensajes;
    setConv((c) => ({ ...c, [sec]: { ...previo, mensajes: mensajesYo } }));
    if (textoDirecto == null) { setEntrada(""); setImagenes([]); }
    setOcupado(true);
    try {
      const r = await fetch("/api/ia-bc/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mensaje: texto,
          historial: previo.historial,
          empresa: empresaId,
          imagenes: imgs.map((i) => ({ media_type: i.media_type, data: i.data })),
          contexto: usarPantalla ? { pantalla, texto: textoPantalla() } : { pantalla, texto: "(Maria ha desactivado enviar el contenido de la pantalla)" },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error([j.error, j.detalle].filter(Boolean).join(" — ") || `Error ${r.status}`);
      const nuevo = {
        ...previo,
        historial: j.historial || [],
        mensajes: [...mensajesYo, { rol: "ia", texto: j.texto || (j.cambios?.length ? "Te he preparado el cambio: revísalo y pulsa «Aplicar en BC»." : "(sin respuesta)"), pasos: j.pasos || [], cambios: j.cambios || [] }],
      };
      setConv((c) => ({ ...c, [sec]: nuevo }));
      guardar(sec, nuevo);
    } catch (e) {
      const msg = String(e.message || e).includes("Failed to fetch") ? "No se pudo conectar con el backend. ¿Está arrancado (INICIAR.bat)?" : String(e.message || e);
      setConv((c) => ({ ...c, [sec]: { ...previo, mensajes: [...mensajesYo, { rol: "ia", texto: `✗ ${msg}`, error: true }] } }));
    }
    setOcupado(false);
  }

  const onAplicado = (cambio, ok, detalle) => {
    const nota = ok
      ? `[Aviso del sistema] Maria ha pulsado «Aplicar»: el cambio ${cambio.id} (${cambio.descripcion}) se ha APLICADO en BC correctamente.`
      : `[Aviso del sistema] Maria ha pulsado «Aplicar» pero BC RECHAZÓ el cambio ${cambio.id} (${cambio.descripcion}): ${detalle}. Explícale el motivo en palabras sencillas y, si se puede, propone una corrección.`;
    fijar((a) => ({ mensajes: [...a.mensajes, { rol: "sistema", texto: ok ? `✓ Aplicado: ${cambio.descripcion}` : `✗ BC rechazó: ${cambio.descripcion}` }] }));
    if (!ok) enviar(nota, false, []);
    else fijar((a) => ({ historial: [...a.historial, { role: "user", content: nota }, { role: "assistant", content: [{ type: "text", text: "Entendido, cambio aplicado." }] }] }));
  };

  const añadirImagenes = async (ficheros) => {
    for (const f of [...ficheros].filter((x) => x && /^image\//.test(x.type)).slice(0, 10)) {
      try { const im = await cargarImagen(f); setImagenes((p) => [...p, im].slice(0, 10)); } catch { /* imagen no válida */ }
    }
  };
  const onPegar = (e) => {
    const fich = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile());
    if (fich.length) { e.preventDefault(); añadirImagenes(fich); }
  };

  if (seccion === "ia") return null; // la pantalla «Asistente IA» ya es el chat completo

  if (!abierto) {
    return (
      <button
        onClick={() => setAbierto(true)}
        className={`fixed ${seccion === "recepcion" ? "bottom-20" : "bottom-5"} right-5 z-50 flex items-center gap-2 rounded-full bg-blue-700 hover:bg-blue-800 text-white shadow-lg px-4 py-3`}
        title={`Pregunta a la IA sobre «${pantalla}»`}
      >
        <Bot size={20} /> <span className="text-sm font-medium">IA</span>
        {actual.mensajes.length > 0 && <span className="w-2 h-2 rounded-full bg-green-300" />}
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[440px] max-w-[calc(100vw-2rem)] h-[72vh] flex flex-col rounded-xl shadow-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-blue-700 text-white rounded-t-xl">
        <Bot size={18} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">IA · {pantalla}</div>
          <div className="text-[10px] text-blue-100 truncate">Trabajando en {empresaNombre} · los cambios solo se aplican con «Aplicar en BC»</div>
        </div>
        <button onClick={() => { delete chatIds.current[seccion]; setConv((c) => ({ ...c, [seccion]: { mensajes: [], historial: [], chatId: "" } })); }} title="Nueva conversación" className="p-1 hover:bg-white/10 rounded"><Plus size={16} /></button>
        <button onClick={() => setAbierto(false)} title="Minimizar" className="p-1 hover:bg-white/10 rounded"><Minimize2 size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
        {actual.mensajes.length === 0 && (
          <div className="text-slate-500">
            <p>Hola 👋 Estoy viendo la pantalla <b>{pantalla}</b>. Pregúntame lo que quieras sobre lo que tienes delante o sobre BC.</p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {[...(SUGERENCIAS[seccion] || []), "Resume lo que veo en pantalla"].map((s) => (
                <button key={s} onClick={() => enviar(s, true, [])} className="text-[12px] px-2 py-1 rounded-full border border-blue-200 text-blue-700 hover:bg-blue-50">{s}</button>
              ))}
            </div>
          </div>
        )}
        {actual.mensajes.map((m, k) => (
          <div key={k} className={m.rol === "yo" ? "flex justify-end" : ""}>
            {m.rol === "sistema" ? (
              <div className="text-[11px] text-center text-slate-500">{m.texto}</div>
            ) : (
              <div className={`max-w-[92%] rounded-lg px-3 py-2 whitespace-pre-wrap ${m.rol === "yo" ? "bg-blue-700 text-white" : m.error ? "bg-red-50 text-red-700 border border-red-200" : "bg-slate-100 text-slate-800"}`}>
                {m.miniaturas?.length > 0 && (
                  <div className="flex gap-1 mb-1">{m.miniaturas.map((src, i) => <img key={i} src={src} alt="" className="h-12 rounded" />)}</div>
                )}
                {m.texto}
                {(m.pasos || []).filter((p) => p.herramienta === "guardar_regla" && p.ok).map((p, i) => (
                  <div key={i} className="mt-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">📌 Regla guardada: {p.entrada?.texto}</div>
                ))}
                {(m.pasos || []).length > 0 && <div className="mt-1 text-[10px] text-slate-400">{m.pasos.length} consulta(s) a BC</div>}
                {(m.cambios || []).map((c) => (
                  <div key={c.id} className="mt-2 whitespace-normal"><TarjetaCambio cambio={c} onAplicado={onAplicado} empresaId={empresa?.id} /></div>
                ))}
              </div>
            )}
          </div>
        ))}
        {ocupado && <div className="text-slate-400 text-xs">🤖 Pensando…</div>}
        <div ref={finRef} />
      </div>

      <div className="border-t p-2">
        {imagenes.length > 0 && (
          <div className="flex gap-1 mb-1">
            {imagenes.map((im, i) => (
              <div key={i} className="relative">
                <img src={im.miniatura} alt="" className="h-10 rounded border" />
                <button onClick={() => setImagenes((p) => p.filter((_, j) => j !== i))} className="absolute -top-1 -right-1 bg-white rounded-full border"><X size={10} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          <button onClick={() => inputImgRef.current?.click()} className="p-2 text-slate-500 hover:text-slate-700" title="Adjuntar imagen (también puedes pegarla con Ctrl+V)"><Paperclip size={16} /></button>
          <input ref={inputImgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { añadirImagenes(e.target.files); e.target.value = ""; }} />
          <textarea
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
            onPaste={onPegar}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
            rows={2}
            placeholder="Pregunta sobre esta pantalla… (Enter para enviar)"
            className="flex-1 resize-none border rounded-md px-2 py-1 text-sm"
          />
          <button onClick={() => enviar()} disabled={ocupado || (!entrada.trim() && !imagenes.length)} className="p-2 rounded-md bg-blue-700 text-white disabled:opacity-40"><Send size={16} /></button>
        </div>
        <label className="flex items-center gap-1 mt-1 text-[10px] text-slate-400">
          <input type="checkbox" checked={usarPantalla} onChange={(e) => setUsarPantalla(e.target.checked)} /> Enviar a la IA lo que se ve en pantalla
        </label>
      </div>
    </div>
  );
}
