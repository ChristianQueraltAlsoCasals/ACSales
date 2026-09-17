/**
 * correo.jsx — Pantalla de CORREO (Fase A: leer).
 *
 * Muestra la bandeja de entrada de la cuenta de Maria (vía backend /api/buzon)
 * y permite abrir un correo y leer su cuerpo. Fases siguientes: redactar con
 * Claude (B) y enviar (C).
 */
import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, Search, Mail, Paperclip, ArrowLeft, Sparkles, CheckSquare } from "lucide-react";

const fmtFecha = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  return mismoDia
    ? d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

export default function Correo({ onCrearTarea }) {
  const [carpeta, setCarpeta] = useState("inbox"); // inbox | enviados
  const [mensajes, setMensajes] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState(null); // mensaje completo
  const [cargandoMsg, setCargandoMsg] = useState(false);
  // Compositor (Fase B: redactar con Claude)
  const [compo, setCompo] = useState(null); // null | {modo:"nuevo"|"responder", original, para, asunto}
  const [instrucciones, setInstrucciones] = useState("");
  const [tono, setTono] = useState("cercano");
  const [idioma, setIdioma] = useState("auto");
  const [borrador, setBorrador] = useState("");
  const [redactando, setRedactando] = useState(false);
  const [errCompo, setErrCompo] = useState(null);

  const abrirCompositor = (modo, msg) => {
    setCompo({
      modo,
      original: msg ? `De: ${msg.deNombre || msg.de}\nAssumpte: ${msg.asunto}\n\n${(msg.tipoCuerpo === "html" ? msg.cuerpo.replace(/<[^>]+>/g, " ") : msg.cuerpo) || msg.preview || ""}` : "",
      para: msg ? msg.de : "",
      asunto: msg ? (msg.asunto?.startsWith("RE:") ? msg.asunto : `RE: ${msg.asunto}`) : "",
    });
    setInstrucciones(""); setBorrador(""); setErrCompo(null);
    setTono("cercano"); setIdioma("auto");
  };

  const redactarConClaude = async () => {
    setRedactando(true); setErrCompo(null);
    try {
      const r = await fetch("/api/redactar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modo: compo.modo === "responder" ? "responder" : "nuevo", instrucciones, tono, idioma, original: compo.original }),
      });
      const d = await r.json();
      if (!r.ok) setErrCompo(d.error || "No s'ha pogut redactar.");
      else setBorrador(d.texto || "");
    } catch {
      setErrCompo("No s'ha pogut connectar amb el servidor.");
    } finally {
      setRedactando(false);
    }
  };

  const cargar = useCallback(async (car = carpeta, busca = "") => {
    setCargando(true); setError(null);
    try {
      const params = new URLSearchParams({ carpeta: car });
      if (busca) params.set("q", busca);
      const r = await fetch(`/api/buzon/mensajes?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) { setError(d.error || "No s'ha pogut carregar la bústia."); setMensajes([]); }
      else setMensajes(d.mensajes || []);
    } catch (e) {
      setError("No s'ha pogut connectar amb el servidor.");
    } finally {
      setCargando(false);
    }
  }, [carpeta]);

  useEffect(() => { cargar(carpeta, ""); }, [carpeta, cargar]);

  const abrir = async (id) => {
    setCargandoMsg(true);
    try {
      const r = await fetch(`/api/buzon/mensaje/${encodeURIComponent(id)}`);
      const d = await r.json();
      if (r.ok) setAbierto(d);
      else setError(d.error || "No s'ha pogut obrir el correu.");
    } catch {
      setError("No s'ha pogut obrir el correu.");
    } finally {
      setCargandoMsg(false);
    }
  };

  // ---- Vista de un correo abierto ----
  if (abierto) {
    return (
      <div>
        <button onClick={() => setAbierto(null)} className="flex items-center gap-1 text-sm text-blue-700 hover:underline mb-4">
          <ArrowLeft size={15} /> Tornar a la safata
        </button>
        <div className="mb-3 flex gap-2">
          <button onClick={() => abrirCompositor("responder", abierto)} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-4 py-2">
            <Sparkles size={15} /> Respondre amb ajuda de Claude
          </button>
          {onCrearTarea && (
            <button
              onClick={() => onCrearTarea({
                titulo: abierto.asunto,
                notas: "",
                prioridad: "media",
                _extId: "mail-" + abierto.id,
                correo: {
                  de: abierto.de, deNombre: abierto.deNombre,
                  para: abierto.para, fecha: abierto.fecha,
                  asunto: abierto.asunto,
                  cuerpo: abierto.tipoCuerpo === "html" ? abierto.cuerpo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : abierto.cuerpo,
                  id: abierto.id,
                },
              })}
              className="flex items-center gap-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md px-4 py-2"
            >
              <CheckSquare size={15} /> Crear tasca d'aquest correu
            </button>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5 max-w-4xl">
          <h1 className="text-lg font-bold text-slate-800">{abierto.asunto}</h1>
          <div className="text-[13px] text-slate-500 mt-1">
            <span className="font-medium text-slate-700">{abierto.deNombre || abierto.de}</span>
            {abierto.deNombre && <span className="text-slate-400"> · {abierto.de}</span>}
          </div>
          <div className="text-[12px] text-slate-400 mt-0.5">
            Per a: {abierto.para?.join(", ") || "—"}{abierto.cc?.length ? ` · CC: ${abierto.cc.join(", ")}` : ""}
          </div>
          <div className="text-[12px] text-slate-400 mt-0.5">{new Date(abierto.fecha).toLocaleString("es-ES")}</div>
          <hr className="my-4 border-slate-100" />
          {abierto.tipoCuerpo === "html" ? (
            <div className="text-[14px] leading-relaxed text-slate-700 prose-sm" dangerouslySetInnerHTML={{ __html: abierto.cuerpo }} />
          ) : (
            <pre className="text-[14px] leading-relaxed text-slate-700 whitespace-pre-wrap font-sans">{abierto.cuerpo}</pre>
          )}
        </div>
      </div>
    );
  }

  // ---- Bandeja ----
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Correu</h1>
          <p className="text-slate-500 text-sm mt-1">Safata de {carpeta === "inbox" ? "entrada" : "enviats"} · maria.rufi@alsocasals.com</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => abrirCompositor("nuevo", null)} className="flex items-center gap-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md px-4 py-2">
            <Sparkles size={15} /> Redactar amb Claude
          </button>
          <button onClick={() => cargar(carpeta, q)} disabled={cargando} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
            <RefreshCw size={15} className={cargando ? "animate-spin" : ""} /> Actualitzar
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-4 text-[13px]">
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          <button onClick={() => setCarpeta("inbox")} className={`px-3 py-1.5 ${carpeta === "inbox" ? "bg-blue-600 text-white" : "bg-white text-slate-600"}`}>Rebuts</button>
          <button onClick={() => setCarpeta("enviados")} className={`px-3 py-1.5 ${carpeta === "enviados" ? "bg-blue-600 text-white" : "bg-white text-slate-600"}`}>Enviats</button>
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search size={13} className="absolute left-2 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && cargar(carpeta, q)}
            placeholder="Cercar (prem Enter)…"
            className="w-full pl-7 pr-2 py-1.5 border border-slate-300 rounded-md"
          />
        </div>
      </div>

      {error && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          {error}
          <div className="text-[12px] text-amber-700 mt-1">Recorda: cal el permís Mail.ReadWrite (Aplicació) a Azure amb consentiment d'administrador.</div>
        </div>
      )}

      <div className="mt-3 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {cargando && <div className="px-4 py-6 text-center text-slate-400 text-sm">Carregant…</div>}
        {!cargando && mensajes.length === 0 && !error && (
          <div className="px-4 py-6 text-center text-slate-400 text-sm">No hi ha correus.</div>
        )}
        {mensajes.map((m) => (
          <button
            key={m.id}
            onClick={() => abrir(m.id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-blue-50/50 ${!m.leido ? "bg-blue-50/30" : ""}`}
          >
            <Mail size={15} className={m.leido ? "text-slate-300 shrink-0" : "text-blue-500 shrink-0"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`text-[13px] truncate ${!m.leido ? "font-bold text-slate-800" : "text-slate-600"}`}>
                  {carpeta === "inbox" ? (m.deNombre || m.de) : (m.para?.[0] || "—")}
                </span>
                {m.adjuntos && <Paperclip size={12} className="text-slate-400 shrink-0" />}
              </div>
              <div className={`text-[13px] truncate ${!m.leido ? "font-semibold text-slate-700" : "text-slate-500"}`}>{m.asunto}</div>
              <div className="text-[12px] text-slate-400 truncate">{m.preview}</div>
            </div>
            <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">{fmtFecha(m.fecha)}</span>
          </button>
        ))}
      </div>
      {cargandoMsg && <div className="text-center text-slate-400 text-sm mt-3">Obrint correu…</div>}

      {/* COMPOSITOR con Claude (Fase B) */}
      {compo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setCompo(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Sparkles size={16} className="text-blue-600" /> {compo.modo === "responder" ? "Respondre amb Claude" : "Redactar amb Claude"}
              </div>
              <button onClick={() => setCompo(null)} className="text-slate-400 hover:text-slate-600 p-1">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {compo.modo === "responder" && (
                <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded-md p-2">
                  Responent a: <b>{compo.para}</b> · {compo.asunto}
                </div>
              )}
              <div>
                <label className="text-[12px] font-semibold text-slate-600">Què vols dir? (indicacions per a Claude)</label>
                <textarea
                  value={instrucciones}
                  onChange={(e) => setInstrucciones(e.target.value)}
                  rows={3}
                  placeholder={compo.modo === "responder" ? "Ex.: confirma-li que la comanda arribarà dimarts i disculpa't pel retard" : "Ex.: demana pressupost de 100 m de tub PVC 63 al proveïdor"}
                  className="w-full mt-1 p-2 border border-slate-300 rounded-md text-[13px]"
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <div>
                  <label className="text-[12px] font-semibold text-slate-600">To</label>
                  <select value={tono} onChange={(e) => setTono(e.target.value)} className="block mt-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]">
                    <option value="formal">Formal</option>
                    <option value="cercano">Proper</option>
                    <option value="breve">Breu</option>
                  </select>
                </div>
                <div>
                  <label className="text-[12px] font-semibold text-slate-600">Idioma</label>
                  <select value={idioma} onChange={(e) => setIdioma(e.target.value)} className="block mt-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]">
                    <option value="auto">Automàtic{compo.modo === "responder" ? " (com l'original)" : ""}</option>
                    <option value="ca">Català</option>
                    <option value="es">Castellà</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <button onClick={redactarConClaude} disabled={redactando} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-md px-4 py-2">
                    <Sparkles size={14} className={redactando ? "animate-pulse" : ""} /> {redactando ? "Redactant…" : "Redactar amb Claude"}
                  </button>
                </div>
              </div>
              {errCompo && <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{errCompo}</div>}
              <div>
                <label className="text-[12px] font-semibold text-slate-600">Esborrany (pots editar-lo)</label>
                <textarea
                  value={borrador}
                  onChange={(e) => setBorrador(e.target.value)}
                  rows={12}
                  placeholder="Aquí apareixerà el text que redacti Claude. El pots editar abans d'enviar."
                  className="w-full mt-1 p-3 border border-slate-300 rounded-md text-[13px] font-sans leading-relaxed"
                />
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => { navigator.clipboard?.writeText(borrador); }}
                  disabled={!borrador}
                  className="text-sm font-semibold text-slate-600 border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
                >
                  Copiar text
                </button>
                <span className="text-[11px] text-slate-400">L'enviament arribarà a la Fase C</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
