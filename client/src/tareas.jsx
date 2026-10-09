/**
 * tareas.jsx — CHECKLIST de tareas pendientes.
 *
 * Tareas manuales o creadas desde un correo. Cada tarea: título, prioridad
 * (alta/media/baja), fecha límite, notas y hecho/pendiente. Se guarda en el
 * navegador (localStorage, solo del usuario). Avisa de las vencidas.
 *
 * La función addTareaExterna (expuesta vía prop onRef) permite que la
 * pantalla de Correo cree una tarea desde un email.
 */
import React, { useState, useEffect, useMemo } from "react";
import { Plus, Trash2, Check, Circle, AlertTriangle, ArrowLeft, Mail } from "lucide-react";

const LS_KEY = "agente_ventas_tareas_v1";

const cargar = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
};
const guardar = (t) => { try { localStorage.setItem(LS_KEY, JSON.stringify(t)); } catch {} };

const hoyISO = () => new Date().toISOString().slice(0, 10);
const sello = () => new Date().toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const PRIO = { alta: { l: "Alta", c: "bg-red-100 text-red-700 border-red-200" }, media: { l: "Media", c: "bg-amber-100 text-amber-700 border-amber-200" }, baja: { l: "Baja", c: "bg-slate-100 text-slate-500 border-slate-200" } };
const RANK = { alta: 3, media: 2, baja: 1 };

const euros = (n) => Number(n || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function VistaPrevia({ acciones, esperando }) {
  const [docs, setDocs] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const clave = (acciones || []).map((a) => [a.tipo, a.factura, a.cliente].join("~")).join("|");

  useEffect(() => {
    if (!acciones?.length) { setDocs([]); setError(null); setCargando(false); return; }
    let vivo = true;
    setCargando(true); setError(null);
    fetch("/api/correo/vista-previa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acciones }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo) return;
        if (!ok) setError(d.error || "No he pogut preparar la vista prèvia.");
        else setDocs(d.documentos || []);
      })
      .catch(() => { if (vivo) setError("No he pogut connectar amb el servidor."); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [clave]);

  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold text-slate-400 uppercase">Vista prèvia</div>
      {(esperando || cargando) && <div className="text-[13px] text-slate-400">Preparant la vista prèvia…</div>}
      {error && <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {!esperando && !cargando && !docs.length && !error && (
        <div className="text-[13px] text-slate-400">Aquest correu no demana cap abonament ni factura.</div>
      )}
      {docs.map((d, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className={"px-4 py-2 text-[12px] font-bold text-white " + (d.tipo === "abono" ? "bg-slate-700" : "bg-blue-700")}>
            {d.titulo}{d.origen ? " · còpia de " + d.origen : ""}
          </div>
          <div className="p-4">
            <div className="text-[11px] text-slate-400 uppercase">Client</div>
            <div className="text-[13px] font-semibold text-slate-800">{d.cliente || "—"}{d.clienteNumero ? " · " + d.clienteNumero : ""}</div>
            {d.aviso && <div className="mt-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">{d.aviso}</div>}
            {d.lineas?.length > 0 && (
              <table className="w-full mt-3 text-[12px]">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-100">
                    <th className="font-semibold py-1">Descripció</th>
                    <th className="font-semibold py-1 text-right">Cant.</th>
                    <th className="font-semibold py-1 text-right">Import</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lineas.map((l, j) => (
                    <tr key={j} className="border-b border-slate-50">
                      <td className="py-1 pr-2 text-slate-700">{l.descripcion}</td>
                      <td className="py-1 text-right text-slate-500 whitespace-nowrap">{l.comentario ? "" : euros(l.cantidad)}</td>
                      <td className="py-1 text-right text-slate-800 whitespace-nowrap">{l.comentario ? "" : euros(l.importe) + " €"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-2 text-right text-[13px] font-bold text-slate-800">Total {euros(d.total)} €</div>
            <div className="mt-2 text-[11px] text-slate-400">Encara no està creat. El botó de sota el prepara i l'obre a BC.</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FeinaCorreu({ correo, onRec }) {
  const [rec, setRec] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [ocupada, setOcupada] = useState("");
  const [aviso, setAviso] = useState(null);

  useEffect(() => {
    if (!correo?.id && !correo?.cuerpo) return;
    let vivo = true;
    setCargando(true); setError(null); setRec(null); setAviso(null);
    fetch("/api/correo/recomendacion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: correo.id || "",
        de: correo.de || "",
        deNombre: correo.deNombre || "",
        asunto: correo.asunto || "",
        cuerpo: correo.cuerpo || "",
        tipoCuerpo: correo.tipoCuerpo || "text",
      }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo) return;
        if (!ok) { setError(d.error || "No he pogut preparar la feina."); if (onRec) onRec(null); }
        else { setRec(d); if (onRec) onRec(d); }
      })
      .catch(() => { if (vivo) setError("No he pogut connectar amb el servidor."); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [correo?.id]);

  const preparar = async (accion, clave) => {
    setOcupada(clave); setError(null);
    try {
      const r = await fetch("/api/correo/accion-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tipo: accion.tipo, factura: accion.factura || "", cliente: accion.cliente || "" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || "No he pogut preparar el document."); return; }
      const que = accion.tipo === "abono" ? "Abonament" : "Factura";
      const extra = (d.avisos || []).length ? " Revisa les línies: " + d.avisos[0] : " El registres tu a BC.";
      setAviso(que + (d.numero ? " " + d.numero : "") + " preparat." + extra);
      if (d.enlace) window.open(d.enlace, "_blank", "noopener");
    } catch {
      setError("No he pogut connectar amb el servidor.");
    } finally {
      setOcupada("");
    }
  };

  if (cargando) return <div className="mt-4 text-[13px] text-slate-400">Mirant què cal fer…</div>;
  if (!rec?.queHacer && !(rec?.acciones || []).length && !error) return null;
  return (
    <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
      <div className="text-[11px] font-bold text-amber-800 uppercase">Què has de fer</div>
      {rec?.queHacer && <p className="text-[13px] text-slate-800 leading-relaxed">{rec.queHacer}</p>}
      {(rec?.acciones || []).map((a, i) => {
        const clave = a.tipo + "|" + (a.factura || "") + "|" + (a.cliente || "");
        const texto = a.tipo === "abono"
          ? "Vols obrir a BC l'abonament de venda" + (a.factura ? " " + a.factura : "") + "?"
          : "Vols obrir a BC la factura de venda" + (a.cliente ? " per a " + a.cliente : "") + "?";
        return (
          <button
            key={clave + i}
            type="button"
            disabled={ocupada === clave}
            onClick={() => preparar(a, clave)}
            className="block w-full text-left text-[13px] font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-60 rounded-md px-3 py-2"
          >
            {ocupada === clave ? "Preparant el document…" : texto}
          </button>
        );
      })}
      {aviso && <div className="text-[12px] text-green-800">{aviso}</div>}
      {error && <div className="text-[12px] text-red-700">{error}</div>}
    </div>
  );
}

function CuerpoCorreo({ correo }) {
  const [html, setHtml] = useState(String(correo?.tipoCuerpo || "").toLowerCase() === "html" ? (correo?.cuerpo || "") : "");
  const [texto, setTexto] = useState(String(correo?.tipoCuerpo || "").toLowerCase() === "html" ? "" : (correo?.cuerpo || ""));
  const [cargando, setCargando] = useState(Boolean(correo?.id));

  useEffect(() => {
    if (!correo?.id) return;
    let vivo = true;
    setCargando(true);
    fetch("/api/buzon/mensaje/" + encodeURIComponent(correo.id))
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo || !ok) return;
        if (String(d.tipoCuerpo || "").toLowerCase() === "html") {
          setHtml(d.cuerpo || "");
          setTexto("");
        } else {
          setHtml("");
          setTexto(d.cuerpo || "");
        }
      })
      .catch(() => {})
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [correo?.id]);

  if (cargando && !html) return <div className="text-[13px] text-slate-400 mt-2">Obrint el correu…</div>;
  if (html) {
    return <div className="text-[14px] leading-relaxed text-slate-700 mt-3 max-h-[32rem] overflow-y-auto" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className="text-[13px] text-slate-600 mt-2 whitespace-pre-wrap max-h-[32rem] overflow-y-auto">{texto}</div>;
}

export default function Tareas({ pendienteAlta }) {
  const [tareas, setTareas] = useState(cargar);
  const [titulo, setTitulo] = useState("");
  const [prioridad, setPrioridad] = useState("media");
  const [fecha, setFecha] = useState("");
  const [notas, setNotas] = useState("");
  const [verHechas, setVerHechas] = useState(false);
  const [abiertaId, setAbiertaId] = useState(null); // ficha de tarea
  const [feina, setFeina] = useState(null);
  const [nuevaNota, setNuevaNota] = useState("");
  const [nuevoHist, setNuevoHist] = useState("");

  useEffect(() => { guardar(tareas); }, [tareas]);
  useEffect(() => { setFeina(null); }, [abiertaId]);

  // Si llega una tarea pendiente desde el Correo (por prop), la añade una vez
  useEffect(() => {
    if (!pendienteAlta) return;
    setTareas((prev) => {
      if (prev.some((t) => t._extId && t._extId === pendienteAlta._extId)) return prev; // evitar duplicado
      return [{
        id: Date.now() + Math.random(),
        titulo: pendienteAlta.titulo,
        prioridad: pendienteAlta.prioridad || "media",
        fecha: pendienteAlta.fecha || "",
        hecha: false,
        creada: new Date().toISOString(),
        _extId: pendienteAlta._extId,
        correo: pendienteAlta.correo || null,   // correo original guardado
        notasDiario: [],                          // notas con fecha
        historial: pendienteAlta.correo ? [{ ts: sello(), tipo: "correu", txt: `Tasca creada des del correu de ${pendienteAlta.correo.deNombre || pendienteAlta.correo.de}` }] : [],
      }, ...prev];
    });
  }, [pendienteAlta]);

  const añadir = () => {
    if (!titulo.trim()) return;
    setTareas((prev) => [{ id: Date.now() + Math.random(), titulo: titulo.trim(), prioridad, fecha, hecha: false, creada: new Date().toISOString(), correo: null, notasDiario: notas.trim() ? [{ ts: sello(), txt: notas.trim() }] : [], historial: [] }, ...prev]);
    setTitulo(""); setPrioridad("media"); setFecha(""); setNotas("");
  };

  const toggle = (id) => setTareas((prev) => prev.map((t) => (t.id === id ? { ...t, hecha: !t.hecha } : t)));
  const borrar = (id) => { setTareas((prev) => prev.filter((t) => t.id !== id)); if (abiertaId === id) setAbiertaId(null); };

  const addNota = (id, txt) => {
    if (!txt.trim()) return;
    setTareas((prev) => prev.map((t) => (t.id === id ? { ...t, notasDiario: [{ ts: sello(), txt: txt.trim() }, ...(t.notasDiario || [])] } : t)));
  };
  const addHist = (id, txt, tipo = "acció") => {
    if (!txt.trim()) return;
    setTareas((prev) => prev.map((t) => (t.id === id ? { ...t, historial: [...(t.historial || []), { ts: sello(), tipo, txt: txt.trim() }] } : t)));
  };
  const cambiarCampo = (id, campo, valor) => setTareas((prev) => prev.map((t) => (t.id === id ? { ...t, [campo]: valor } : t)));

  const lista = useMemo(() => {
    const hoy = hoyISO();
    return tareas
      .filter((t) => verHechas || !t.hecha)
      .map((t) => ({ ...t, vencida: !t.hecha && t.fecha && t.fecha < hoy }))
      .sort((a, b) => {
        if (a.hecha !== b.hecha) return a.hecha ? 1 : -1;
        if (a.vencida !== b.vencida) return a.vencida ? -1 : 1;
        const r = RANK[b.prioridad] - RANK[a.prioridad];
        if (r) return r;
        return (a.fecha || "9999").localeCompare(b.fecha || "9999");
      });
  }, [tareas, verHechas]);

  const kpis = useMemo(() => {
    const hoy = hoyISO();
    const pend = tareas.filter((t) => !t.hecha);
    return {
      pendientes: pend.length,
      vencidas: pend.filter((t) => t.fecha && t.fecha < hoy).length,
      alta: pend.filter((t) => t.prioridad === "alta").length,
    };
  }, [tareas]);

  const abierta = useMemo(() => tareas.find((t) => t.id === abiertaId) || null, [tareas, abiertaId]);

  // ---- FICHA de una tarea ----
  if (abierta) {
    return (
      <div>
        <button onClick={() => setAbiertaId(null)} className="flex items-center gap-1 text-sm text-blue-700 hover:underline mb-4">
          <ArrowLeft size={15} /> Tornar a les tasques
        </button>
        <div className="flex flex-col xl:flex-row gap-5 items-start">
        <div className="flex-1 min-w-0 max-w-3xl">
          <div className="flex items-start gap-3">
            <button onClick={() => toggle(abierta.id)} className="mt-1 shrink-0">
              {abierta.hecha ? <Check size={20} className="text-emerald-600" /> : <Circle size={20} className="text-slate-300 hover:text-blue-500" />}
            </button>
            <div className="flex-1">
              <h1 className={`text-xl font-bold ${abierta.hecha ? "line-through text-slate-400" : "text-slate-800"}`}>{abierta.titulo}</h1>
              <div className="flex items-center gap-2 mt-2">
                <select value={abierta.prioridad} onChange={(e) => cambiarCampo(abierta.id, "prioridad", e.target.value)} className="py-1 px-2 border border-slate-300 rounded-md text-[12px]">
                  <option value="alta">Prioritat alta</option>
                  <option value="media">Prioritat mitjana</option>
                  <option value="baja">Prioritat baixa</option>
                </select>
                <input type="date" value={abierta.fecha || ""} onChange={(e) => cambiarCampo(abierta.id, "fecha", e.target.value)} className="py-1 px-2 border border-slate-300 rounded-md text-[12px]" />
              </div>
            </div>
            <button onClick={() => borrar(abierta.id)} className="text-slate-300 hover:text-red-500 shrink-0" title="Esborrar"><Trash2 size={16} /></button>
          </div>

          {abierta.correo && (
            <div className="mt-5 bg-slate-50 border border-slate-200 rounded-lg p-4">
              <div className="text-[11px] font-bold text-slate-400 uppercase flex items-center gap-1.5 mb-2"><Mail size={13} /> Correu original</div>
              <div className="text-[13px] font-semibold text-slate-700">{abierta.correo.asunto}</div>
              <div className="text-[12px] text-slate-500">
                <span className="font-medium text-slate-700">{abierta.correo.deNombre || abierta.correo.de}</span>
                {abierta.correo.deNombre && abierta.correo.de ? <span className="text-slate-400"> · {abierta.correo.de}</span> : null}
                {abierta.correo.fecha ? <span> · {new Date(abierta.correo.fecha).toLocaleString("es-ES")}</span> : null}
              </div>
              <CuerpoCorreo correo={abierta.correo} />
              <FeinaCorreu correo={abierta.correo} onRec={setFeina} />
            </div>
          )}

          <div className="mt-5">
            <div className="text-[13px] font-bold text-slate-700 mb-2">📋 Històric de la tasca</div>
            <div className="flex gap-2 mb-2">
              <input value={nuevoHist} onChange={(e) => setNuevoHist(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addHist(abierta.id, nuevoHist); setNuevoHist(""); } }} placeholder="Ex.: He trucat, no contesta. Torno a provar demà." className="flex-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]" />
              <button onClick={() => { addHist(abierta.id, nuevoHist); setNuevoHist(""); }} className="text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3 py-1.5">Afegir</button>
            </div>
            <div className="space-y-1.5">
              {(abierta.historial || []).length === 0 && <div className="text-[12px] text-slate-400">Encara no hi ha res al històric.</div>}
              {(abierta.historial || []).slice().reverse().map((h, i) => (
                <div key={i} className="flex gap-2 text-[13px] bg-white border border-slate-100 rounded-md px-3 py-1.5">
                  <span className="text-[11px] text-slate-400 shrink-0 w-32">{h.ts}</span>
                  <span className="text-slate-700">{h.tipo === "correu" ? "✉ " : h.tipo === "resposta" ? "↩ " : "• "}{h.txt}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <div className="text-[13px] font-bold text-slate-700 mb-2">📝 Notes</div>
            <div className="flex gap-2 mb-2">
              <input value={nuevaNota} onChange={(e) => setNuevaNota(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { addNota(abierta.id, nuevaNota); setNuevaNota(""); } }} placeholder="Escriu una nota i prem Enter…" className="flex-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]" />
              <button onClick={() => { addNota(abierta.id, nuevaNota); setNuevaNota(""); }} className="text-sm font-semibold text-white bg-slate-600 hover:bg-slate-700 rounded-md px-3 py-1.5">Desar</button>
            </div>
            <div className="space-y-1.5">
              {(abierta.notasDiario || []).length === 0 && <div className="text-[12px] text-slate-400">Cap nota encara.</div>}
              {(abierta.notasDiario || []).map((n, i) => (
                <div key={i} className="text-[13px] bg-amber-50/50 border border-amber-100 rounded-md px-3 py-1.5">
                  <div className="text-[11px] text-slate-400">{n.ts}</div>
                  <div className="text-slate-700 whitespace-pre-wrap">{n.txt}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <aside className="w-full xl:w-[440px] shrink-0 xl:sticky xl:top-4">
          <VistaPrevia acciones={feina?.acciones || []} esperando={Boolean(abierta.correo) && !feina} />
        </aside>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-800">Les meves tasques</h1>
      <p className="text-slate-500 text-sm mt-1">Coses pendents de fer. Es guarden al teu navegador.</p>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-2 mt-5 max-w-md">
        <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
          <div className="text-[9px] font-bold text-slate-400 uppercase">Pendents</div>
          <div className="text-sm font-bold text-blue-700">{kpis.pendientes}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
          <div className="text-[9px] font-bold text-slate-400 uppercase">Vençudes</div>
          <div className="text-sm font-bold text-red-600">{kpis.vencidas}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg px-3 py-2">
          <div className="text-[9px] font-bold text-slate-400 uppercase">Prioritat alta</div>
          <div className="text-sm font-bold text-amber-600">{kpis.alta}</div>
        </div>
      </div>

      {/* Alta de tarea */}
      <div className="mt-5 bg-white border border-slate-200 rounded-lg p-3 max-w-3xl">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="text-[11px] font-semibold text-slate-500">Tasca</label>
            <input value={titulo} onChange={(e) => setTitulo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && añadir()} placeholder="Ex.: Trucar a la clienta Melero pel deute" className="w-full mt-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]" />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-500">Prioritat</label>
            <select value={prioridad} onChange={(e) => setPrioridad(e.target.value)} className="block mt-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]">
              <option value="alta">Alta</option>
              <option value="media">Mitjana</option>
              <option value="baja">Baixa</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-500">Data límit</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="block mt-1 py-1.5 px-2 border border-slate-300 rounded-md text-[13px]" />
          </div>
          <button onClick={añadir} className="flex items-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-4 py-2">
            <Plus size={15} /> Afegir
          </button>
        </div>
        <input value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Notes (opcional)" className="w-full mt-2 py-1.5 px-2 border border-slate-200 rounded-md text-[12px]" />
      </div>

      {/* Lista */}
      <div className="flex items-center gap-3 mt-5 mb-2">
        <label className="flex items-center gap-1.5 text-[13px] text-slate-600 cursor-pointer">
          <input type="checkbox" checked={verHechas} onChange={(e) => setVerHechas(e.target.checked)} /> Veure fetes
        </label>
        <span className="text-[12px] text-slate-400 ml-auto">{lista.length} tasca(s)</span>
      </div>

      <div className="space-y-2 max-w-3xl">
        {lista.length === 0 && <div className="text-slate-400 text-sm py-6 text-center bg-white border border-slate-200 rounded-lg">No tens tasques pendents. 🎉</div>}
        {lista.map((t) => (
          <div key={t.id} className={`flex items-start gap-3 bg-white border rounded-lg p-3 ${t.vencida ? "border-red-200 bg-red-50/30" : "border-slate-200"}`}>
            <button onClick={() => toggle(t.id)} className="mt-0.5 shrink-0">
              {t.hecha ? <Check size={18} className="text-emerald-600" /> : <Circle size={18} className="text-slate-300 hover:text-blue-500" />}
            </button>
            <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setAbiertaId(t.id)}>
              <div className={`text-[14px] ${t.hecha ? "line-through text-slate-400" : "text-slate-800 font-medium"}`}>{t.titulo}</div>
              {t.correo && <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1"><Mail size={11} /> {t.correo.deNombre || t.correo.de}</div>}
              {(t.notasDiario?.length > 0 || t.historial?.length > 0) && (
                <div className="text-[11px] text-slate-400 mt-0.5">{(t.historial?.length || 0)} al històric · {(t.notasDiario?.length || 0)} nota(es)</div>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <span className={`text-[10px] font-bold border rounded px-1.5 py-0.5 ${PRIO[t.prioridad]?.c}`}>{PRIO[t.prioridad]?.l}</span>
                {t.fecha && (
                  <span className={`text-[11px] flex items-center gap-1 ${t.vencida ? "text-red-600 font-semibold" : "text-slate-400"}`}>
                    {t.vencida && <AlertTriangle size={11} />}
                    {new Date(t.fecha).toLocaleDateString("es-ES")}
                    {t.vencida && " · vençuda"}
                  </span>
                )}
              </div>
            </div>
            <button onClick={() => borrar(t.id)} className="text-slate-300 hover:text-red-500 shrink-0" title="Esborrar">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
