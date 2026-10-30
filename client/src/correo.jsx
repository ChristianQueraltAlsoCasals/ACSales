/**
 * correo.jsx — Pantalla de CORREO.
 *
 * Bandeja del usuario logueado (email_empresa de AChuman), no un buzón fijo.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, Search, Mail, Paperclip, ArrowLeft, ChevronLeft, ChevronRight, Sparkles, CheckSquare, X } from "lucide-react";

const EXTENSIONES_ADJUNTO = new Set(["pdf", "png", "jpg", "jpeg", "doc", "docx", "xls", "xlsx"]);
const TOPE_FICHERO = 3 * 1024 * 1024;
const TOPE_TOTAL = 10 * 1024 * 1024;
const MAX_ADJUNTOS = 10;

function extensionFichero(nombre) {
  const s = String(nombre || "");
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1).toLowerCase() : "";
}

function leerFicheroAdjunto(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      const raw = String(lector.result || "");
      const coma = raw.indexOf(",");
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nombre: file.name,
        mime: file.type || "",
        base64: coma >= 0 ? raw.slice(coma + 1) : "",
        bytes: file.size,
      });
    };
    lector.onerror = () => reject(new Error(`No s'ha pogut llegir ${file.name}`));
    lector.readAsDataURL(file);
  });
}

const FIRMA_SALUDO = "Salutacions / Saludos / Best Regards.";
const FIRMA_LEGAL = "D'acord amb el que estableix la Llei Orgànica 15/1999, de 13 de desembre, de Protecció de Dades de Caràcter Personal, els informem que les dades que figuren en aquesta comunicació estan incloses en un fitxer propietat de ALSOCASALS INSTAL·LACIONS, S.L..\n\nPer poder exercir els drets d'accés, rectificació, cancel·lació o oposició podran dirigir-se, en qualsevol moment a l'empresa, a la següent adreça: C/ BARCELONA, 74 43500, TORTOSA o mitjançant correu electrònic a xavi.also@alsocasals.com. Aquest missatge, i en el seu cas els fitxers adjunts, són confidencials, especialment en el que respecta a les dades personals, i es dirigeixen exclusivament al destinatari referenciat. Si vostè no és el destinatari i l'ha rebut per error o té coneixement del mateix per qualsevol motiu, li preguem que ens ho comuniqui per aquest mitjà i procedeixi a esborrar-lo, i que en tot cas, s'abstingui d'utilitzar, reproduir, alterar, arxivar o comunicar a tercers el present missatge i fitxers adjunts, podent incórrer en responsabilitats legals.";

const CACHE_REC = "acsales.recomendaciones";

function leerRecomendacionLocal(id) {
  try {
    const mapa = JSON.parse(localStorage.getItem(CACHE_REC) || "{}");
    return mapa[id]?.rec || null;
  } catch {
    return null;
  }
}

function guardarRecomendacionLocal(id, rec) {
  try {
    const mapa = JSON.parse(localStorage.getItem(CACHE_REC) || "{}");
    mapa[id] = { ts: Date.now(), rec };
    const claves = Object.keys(mapa).sort((a, b) => (mapa[a]?.ts || 0) - (mapa[b]?.ts || 0));
    while (claves.length > 80) delete mapa[claves.shift()];
    localStorage.setItem(CACHE_REC, JSON.stringify(mapa));
  } catch { /* el navegador puede rechazar el guardado; el servidor también la tiene */ }
}

function cuerpoSinFirma(texto) {
  return String(texto || "").trim().replace(/\n*Salutacions\s*\/\s*Saludos\s*\/\s*Best Regards\.?\s*$/i, "").trim();
}

function textoConFirma(texto) {
  return cuerpoSinFirma(texto) + "\n\n" + FIRMA_SALUDO + "\n\n" + FIRMA_LEGAL;
}

function escaparHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function copiarConFirma(texto) {
  const cuerpo = cuerpoSinFirma(texto);
  const plano = textoConFirma(cuerpo);
  const parrafos = escaparHtml(cuerpo).split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
  let img = "";
  try {
    const r = await fetch("/firma-correo.png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    img = '<p><img src="data:image/png;base64,' + btoa(bin) + '" alt="Firma" style="max-width:640px;height:auto"></p>';
  } catch { /* si la imatge no carrega, es copia igualment el text */ }
  const legal = escaparHtml(FIRMA_LEGAL).replace(/\n/g, "<br>");
  const html = '<div style="font-family:Calibri,sans-serif;font-size:11pt">' + parrafos + "<p>" + FIRMA_SALUDO + "</p>" + img + '<p style="font-size:8pt;color:#666666">' + legal + "</p></div>";
  if (navigator.clipboard?.write && window.ClipboardItem) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plano], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } else {
    await navigator.clipboard?.writeText(plano);
  }
}

export function htmlPerEnviar(texto) {
  const cuerpo = cuerpoSinFirma(texto);
  const parrafos = escaparHtml(cuerpo).split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
  const legal = escaparHtml(FIRMA_LEGAL).replace(/\n/g, "<br>");
  return '<div style="font-family:Calibri,sans-serif;font-size:11pt">' + parrafos
    + "<p>" + escaparHtml(FIRMA_SALUDO) + "</p>"
    + '<p><img src="cid:firma-correo" alt="Firma" style="max-width:640px;height:auto"></p>'
    + '<p style="font-size:8pt;color:#666666">' + legal + "</p></div>";
}

function BloqueFirma() {
  return (
    <div className="border-t border-slate-200 pt-3 space-y-2">
      <div className="text-[12px] text-slate-700">{FIRMA_SALUDO}</div>
      <img src="/firma-correo.png" alt="Firma de Maria Rufí" className="max-w-full h-auto" />
      <p className="text-[10px] leading-snug text-slate-400 whitespace-pre-wrap">{FIRMA_LEGAL}</p>
    </div>
  );
}

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

export default function Correo({ onCrearTarea, usuario = null }) {
  const [carpeta, setCarpeta] = useState("inbox"); // inbox | enviados
  const [mensajes, setMensajes] = useState([]);
  const [buzon, setBuzon] = useState(usuario?.email_envio || usuario?.email_empresa || null);
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
  const [recomendacion, setRecomendacion] = useState(null);
  const [cargandoRec, setCargandoRec] = useState(false);
  const [errorRec, setErrorRec] = useState(null);
  const [recDescartada, setRecDescartada] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [confirmarEnvio, setConfirmarEnvio] = useState(false);
  const [adjuntos, setAdjuntos] = useState([]);
  const inputAdjuntoRef = useRef(null);
  const [albaran, setAlbaran] = useState(null); // null | { fase, propuesta, resultado, error }
  const [aviso, setAviso] = useState(null);
  const [accionBc, setAccionBc] = useState("");
  const [errorAccion, setErrorAccion] = useState(null);
  const [accionFallida, setAccionFallida] = useState(null);
  const [pistaCliente, setPistaCliente] = useState("");
  const [avisoImporte, setAvisoImporte] = useState("");
  const [importeOk, setImporteOk] = useState(false);

  useEffect(() => {
    fetch("/api/correo/remitente")
      .then((r) => r.json())
      .then((d) => { if (d.email) setBuzon(d.email); })
      .catch(() => {});
  }, []);

  const abrirCompositor = (modo, msg, textoInicial = "", adjuntosIniciales = []) => {
    setCompo({
      modo,
      original: msg ? `De: ${msg.deNombre || msg.de}\nAssumpte: ${msg.asunto}\n\n${(msg.tipoCuerpo === "html" ? msg.cuerpo.replace(/<[^>]+>/g, " ") : msg.cuerpo) || msg.preview || ""}` : "",
      para: msg ? msg.de : "",
      asunto: msg ? (msg.asunto?.startsWith("RE:") ? msg.asunto : `RE: ${msg.asunto}`) : "",
      respuestaA: msg?.id || "",
    });
    setInstrucciones(""); setBorrador(textoInicial || ""); setErrCompo(null);
    setTono("cercano"); setIdioma("auto");
    setConfirmarEnvio(false); setEnviando(false); setAdjuntos(adjuntosIniciales || []);
  };

  const anadirAdjuntos = async (lista) => {
    const files = Array.from(lista || []);
    if (!files.length) return;
    const rechazados = [];
    const aceptados = [];
    let suma = adjuntos.reduce((n, a) => n + (a.bytes || 0), 0);
    let cuenta = adjuntos.length;
    const avisoTope = "Els adjunts junts no poden passar de 10 MB.";
    for (const f of files) {
      if (cuenta >= MAX_ADJUNTOS) {
        rechazados.push("Màxim 10 adjunts per correu.");
        break;
      }
      if (!EXTENSIONES_ADJUNTO.has(extensionFichero(f.name))) {
        rechazados.push(`«${f.name}» no és PDF, foto, Excel ni Word.`);
        continue;
      }
      if (!f.size) {
        rechazados.push(`«${f.name}» està buit.`);
        continue;
      }
      if (f.size > TOPE_FICHERO) {
        rechazados.push(`«${f.name}» pesa més de 3 MB.`);
        continue;
      }
      if (suma + f.size > TOPE_TOTAL) {
        if (!rechazados.includes(avisoTope)) rechazados.push(avisoTope);
        continue;
      }
      suma += f.size;
      cuenta += 1;
      aceptados.push(f);
    }
    try {
      const leidos = [];
      for (const f of aceptados) leidos.push(await leerFicheroAdjunto(f));
      if (leidos.length) {
        setAdjuntos((prev) => [...prev, ...leidos]);
        setConfirmarEnvio(false);
      }
      setErrCompo(rechazados.length ? rechazados.join(" ") : null);
    } catch (err) {
      setErrCompo(err.message || String(err));
    }
    if (inputAdjuntoRef.current) inputAdjuntoRef.current.value = "";
  };

  const enviarCorreu = async () => {
    const destinatarios = String(compo?.para || "").split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!destinatarios.length) { setErrCompo("Falta el destinatari."); setConfirmarEnvio(false); return; }
    if (!String(compo?.asunto || "").trim()) { setErrCompo("Falta l'assumpte."); setConfirmarEnvio(false); return; }
    if (!String(borrador || "").trim()) { setErrCompo("L'esborrany és buit."); setConfirmarEnvio(false); return; }
    if (!confirmarEnvio) { setConfirmarEnvio(true); setErrCompo(null); return; }
    setEnviando(true); setErrCompo(null);
    try {
      const r = await fetch("/api/correo/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          para: destinatarios,
          asunto: String(compo.asunto).trim(),
          cuerpoHtml: htmlPerEnviar(borrador),
          incluirFirma: true,
          respuestaA: compo.modo === "responder" ? (compo.respuestaA || "") : "",
          ...(adjuntos.length
            ? { adjuntos: adjuntos.map(({ nombre, base64, mime }) => ({ nombre, base64, mime })) }
            : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErrCompo(d.detalle || d.error || "No s'ha pogut enviar.");
        setConfirmarEnvio(false);
        return;
      }
      setCompo(null);
      setAviso("Correu enviat a " + destinatarios.join(", "));
    } catch {
      setErrCompo("No s'ha pogut connectar amb el servidor.");
      setConfirmarEnvio(false);
    } finally {
      setEnviando(false);
    }
  };

  const proponerAlbaranVenta = async () => {
    if (!abierto?.id) return;
    setAlbaran({ fase: "leyendo", propuesta: null, resultado: null, error: null });
    try {
      const r = await fetch("/api/correo/albaran-venta/proponer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: abierto.id,
          asunto: abierto.asunto || "",
          cuerpo: abierto.cuerpo || "",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "No s'ha pogut llegir la OC.");
      setAlbaran({ fase: "propuesta", propuesta: d.propuesta, resultado: null, error: null });
    } catch (err) {
      setAlbaran({ fase: "error", propuesta: null, resultado: null, error: err.message || String(err) });
    }
  };

  const crearAlbaranVenta = async () => {
    if (!albaran?.propuesta) return;
    setAlbaran((prev) => ({ ...prev, fase: "creando", error: null }));
    try {
      const r = await fetch("/api/correo/albaran-venta/crear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propuesta: albaran.propuesta }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "No s'ha pogut crear el pedido / albarà.");
      setAlbaran({ fase: "hecho", propuesta: albaran.propuesta, resultado: d, error: null });
    } catch (err) {
      setAlbaran((prev) => ({ ...prev, fase: "propuesta", error: err.message || String(err) }));
    }
  };

  const responderAmbAlbaran = () => {
    const res = albaran?.resultado;
    if (!res?.pdf?.base64 || !abierto) return;
    const oc = res.ocCliente || albaran.propuesta?.ocCliente || "";
    const texto =
      `Bon dia,\n\n` +
      `Us adjuntem l'albarà corresponent a la vostra ordre de compra ${oc}` +
      (albaran.propuesta?.oferta ? ` (oferta ${albaran.propuesta.oferta})` : "") +
      `.\n\nQualsevol dubte, no dubteu en contactar-nos.`;
    abrirCompositor("responder", abierto, texto, [{
      id: `alb-${Date.now()}`,
      nombre: res.pdf.nombre || `Albaran_${res.pedido}.pdf`,
      mime: res.pdf.mime || "application/pdf",
      base64: res.pdf.base64,
      bytes: res.pdf.bytes || 0,
    }]);
    setAlbaran(null);
    setAviso(`Albarà ${res.pedido} preparat. Revisa el correu i envia'l.`);
  };

  const prepararDocumentBc = async (accion, clave, pista) => {
    setAccionBc(clave); setErrorAccion(null); setAvisoImporte(""); setImporteOk(false);
    try {
      const r = await fetch("/api/correo/accion-bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo: accion.tipo,
          factura: accion.factura || "",
          cliente: accion.cliente || "",
          pista: pista || "",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAccionFallida({ accion, clave });
        setErrorAccion(d.error || "No he pogut preparar el document.");
        return;
      }
      setAccionFallida(null);
      setPistaCliente("");
      setAvisoImporte(d.avisoImporte || "");
      setImporteOk(!!d.importeOk);
      const que = accion.tipo === "abono" ? "Abonament" : "Factura";
      const quien = d.cliente ? " Client: " + d.cliente + "." : "";
      const extra = (d.avisos || []).length ? " Revisa les línies: " + d.avisos[0] : " El registres tu a BC.";
      setAviso(que + (d.numero ? " " + d.numero : "") + " preparat." + quien + extra);
      if (d.enlace) window.open(d.enlace, "_blank", "noopener");
    } catch {
      setAccionFallida({ accion, clave });
      setErrorAccion("No he pogut connectar amb el servidor.");
    } finally {
      setAccionBc("");
    }
  };

  useEffect(() => {
    if (!abierto?.id) { setRecomendacion(null); setErrorRec(null); setRecDescartada(false); setErrorAccion(null); setAccionFallida(null); setPistaCliente(""); setAvisoImporte(""); setImporteOk(false); return; }
    setErrorAccion(null); setAccionFallida(null); setPistaCliente(""); setAvisoImporte(""); setImporteOk(false);
    const guardada = leerRecomendacionLocal(abierto.id);
    if (guardada && typeof guardada.queHacer === "string") {
      setRecDescartada(false); setErrorRec(null); setCargandoRec(false); setRecomendacion(guardada);
      return;
    }
    let vivo = true;
    setRecDescartada(false);
    setCargandoRec(true); setErrorRec(null); setRecomendacion(null);
    fetch("/api/correo/recomendacion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: abierto.id,
        de: abierto.de, deNombre: abierto.deNombre, asunto: abierto.asunto,
        cuerpo: abierto.cuerpo, tipoCuerpo: abierto.tipoCuerpo,
      }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!vivo) return;
        if (!ok) setErrorRec(d.error || "No he podido preparar la recomendación.");
        else { guardarRecomendacionLocal(abierto.id, d); setRecomendacion(d); }
      })
      .catch(() => { if (vivo) setErrorRec("No he podido conectar con el servidor."); })
      .finally(() => { if (vivo) setCargandoRec(false); });
    return () => { vivo = false; };
  }, [abierto?.id]);

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
      else {
        setMensajes(d.mensajes || []);
        if (d.buzon) setBuzon(d.buzon);
      }
    } catch (e) {
      setError("No s'ha pogut connectar amb el servidor.");
    } finally {
      setCargando(false);
    }
  }, [carpeta]);

  useEffect(() => { cargar(carpeta, ""); }, [carpeta, cargar]);

  const abrir = async (id) => {
    setCompo(null);
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

  const modalAlbaran = albaran && (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => { if (albaran.fase !== "creando" && albaran.fase !== "leyendo") setAlbaran(null); }}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div className="text-sm font-bold text-slate-800">Albarà de venda des del correu</div>
          <button type="button" disabled={albaran.fase === "creando" || albaran.fase === "leyendo"} onClick={() => setAlbaran(null)} className="text-slate-400 hover:text-slate-600 p-1 disabled:opacity-40">✕</button>
        </div>
        <div className="p-4 space-y-3 text-[13px]">
          {(albaran.fase === "leyendo" || albaran.fase === "creando") && (
            <p className="text-slate-500">
              {albaran.fase === "leyendo" ? "Llegint els PDFs adjunts i preparant el pedido de venta…" : "Creant el PV a BC, registrant l'enviament i baixant el PDF de l'albarà…"}
            </p>
          )}
          {albaran.error && <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md p-2">{albaran.error}</div>}
          {albaran.propuesta && (albaran.fase === "propuesta" || albaran.fase === "creando") && (
            <>
              <div className="grid grid-cols-[120px_1fr] gap-x-2 gap-y-1">
                <span className="text-slate-500">OC client</span>
                <input
                  value={albaran.propuesta.ocCliente || ""}
                  disabled={albaran.fase === "creando"}
                  onChange={(e) => setAlbaran((p) => ({ ...p, propuesta: { ...p.propuesta, ocCliente: e.target.value, comentarioOc: `Orden de comp. ${e.target.value}` } }))}
                  className="border border-slate-300 rounded px-2 py-1"
                />
                <span className="text-slate-500">Oferta</span>
                <input
                  value={albaran.propuesta.oferta || ""}
                  disabled={albaran.fase === "creando"}
                  onChange={(e) => setAlbaran((p) => ({ ...p, propuesta: { ...p.propuesta, oferta: e.target.value } }))}
                  className="border border-slate-300 rounded px-2 py-1"
                />
                <span className="text-slate-500">Client BC</span>
                <span className="font-medium text-slate-800">
                  {albaran.propuesta.clienteBc
                    ? `${albaran.propuesta.clienteBc.number} · ${albaran.propuesta.clienteBc.name}`
                    : `${albaran.propuesta.clienteNombre || "—"} (${albaran.propuesta.clienteCif || "sense CIF"})`}
                </span>
                <span className="text-slate-500">Compte / venedor</span>
                <span>70000000 · MRC</span>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-500 mb-1">Comentaris</div>
                <input
                  value={albaran.propuesta.comentarioOc || ""}
                  disabled={albaran.fase === "creando"}
                  onChange={(e) => setAlbaran((p) => ({ ...p, propuesta: { ...p.propuesta, comentarioOc: e.target.value } }))}
                  className="w-full border border-slate-300 rounded px-2 py-1 mb-1"
                />
                <input
                  value={albaran.propuesta.comentarioTrabajo || ""}
                  disabled={albaran.fase === "creando"}
                  onChange={(e) => setAlbaran((p) => ({ ...p, propuesta: { ...p.propuesta, comentarioTrabajo: e.target.value } }))}
                  className="w-full border border-slate-300 rounded px-2 py-1"
                />
              </div>
              <div>
                <div className="text-[11px] font-semibold text-slate-500 mb-1">Línies (compte 70000000 · cant. 1)</div>
                <ul className="border border-slate-200 rounded-md divide-y divide-slate-100">
                  {(albaran.propuesta.lineas || []).map((l, i) => (
                    <li key={i} className="flex gap-2 items-center px-2 py-1.5">
                      <input
                        value={l.descripcion}
                        disabled={albaran.fase === "creando"}
                        onChange={(e) => setAlbaran((p) => {
                          const lineas = [...p.propuesta.lineas];
                          lineas[i] = { ...lineas[i], descripcion: e.target.value };
                          return { ...p, propuesta: { ...p.propuesta, lineas } };
                        })}
                        className="flex-1 border border-slate-200 rounded px-2 py-1"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={l.importe}
                        disabled={albaran.fase === "creando"}
                        onChange={(e) => setAlbaran((p) => {
                          const lineas = [...p.propuesta.lineas];
                          lineas[i] = { ...lineas[i], importe: Number(e.target.value) };
                          const total = Math.round(lineas.reduce((s, x) => s + (Number(x.importe) || 0), 0) * 100) / 100;
                          return { ...p, propuesta: { ...p.propuesta, lineas, total } };
                        })}
                        className="w-24 border border-slate-200 rounded px-2 py-1 text-right"
                      />
                    </li>
                  ))}
                </ul>
                <div className="text-right font-semibold mt-1">Total {Number(albaran.propuesta.total || 0).toLocaleString("es-ES", { minimumFractionDigits: 2 })} €</div>
              </div>
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
                En confirmar se crearà el pedido de venta a BC, es registrarà només l'enviament (sense factura) i es baixarà el PDF de l'albarà.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={albaran.fase === "creando"} onClick={() => setAlbaran(null)} className="text-sm border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50 disabled:opacity-50">Cancel·lar</button>
                <button type="button" disabled={albaran.fase === "creando" || !albaran.propuesta.clienteBc} onClick={crearAlbaranVenta} className="text-sm font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50 rounded-md px-4 py-2">
                  {albaran.fase === "creando" ? "Creant a BC…" : "Crear i registrar a BC"}
                </button>
              </div>
            </>
          )}
          {albaran.fase === "hecho" && albaran.resultado && (
            <>
              <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md p-3 space-y-1">
                <div>✓ Pedido <strong>{albaran.resultado.pedido}</strong> · Albarà <strong>{albaran.resultado.albaran}</strong></div>
                <div>Client: {albaran.resultado.cliente?.number} · {albaran.resultado.cliente?.name}</div>
                <div>OC: {albaran.resultado.ocCliente} · PDF: {albaran.resultado.pdf?.nombre}</div>
                {(albaran.resultado.avisos || []).length > 0 && (
                  <div className="text-amber-800 text-[12px]">{albaran.resultado.avisos.join(" · ")}</div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setAlbaran(null)} className="text-sm border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50">Tancar</button>
                <button type="button" onClick={responderAmbAlbaran} className="text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-4 py-2">
                  Respondre amb l'albarà adjunt
                </button>
              </div>
            </>
          )}
          {albaran.fase === "error" && !albaran.propuesta && (
            <div className="flex justify-end">
              <button type="button" onClick={() => setAlbaran(null)} className="text-sm border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50">Tancar</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const modalCompositor = compo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setCompo(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Sparkles size={16} className="text-blue-600" /> {compo.modo === "responder" ? "Respondre amb Claude" : "Redactar amb Claude"}
              </div>
              <button onClick={() => setCompo(null)} className="text-slate-400 hover:text-slate-600 p-1">✕</button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-[12px] font-semibold text-slate-600">Per a</label>
                <input
                  value={compo.para}
                  onChange={(e) => { setCompo({ ...compo, para: e.target.value }); setConfirmarEnvio(false); }}
                  placeholder="nom@empresa.com"
                  className="w-full mt-1 p-2 border border-slate-300 rounded-md text-[13px]"
                />
              </div>
              <div>
                <label className="text-[12px] font-semibold text-slate-600">Assumpte</label>
                <input
                  value={compo.asunto}
                  onChange={(e) => { setCompo({ ...compo, asunto: e.target.value }); setConfirmarEnvio(false); }}
                  className="w-full mt-1 p-2 border border-slate-300 rounded-md text-[13px]"
                />
              </div>
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
                  onChange={(e) => { setBorrador(e.target.value); setConfirmarEnvio(false); }}
                  rows={12}
                  placeholder="Aquí apareixerà el text que redacti Claude. El pots editar abans d'enviar."
                  className="w-full mt-1 p-3 border border-slate-300 rounded-md text-[13px] font-sans leading-relaxed"
                />
                <div className="mt-3"><BloqueFirma /></div>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold text-slate-600">Adjunts</span>
                  <button
                    type="button"
                    onClick={() => inputAdjuntoRef.current?.click()}
                    className="inline-flex items-center gap-1.5 text-sm rounded-md px-3 py-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  >
                    <Paperclip size={14} /> Adjuntar
                  </button>
                  <span className="text-[10px] text-slate-400">PDF, foto (JPG o PNG), Excel o Word. Cadascun fins a 3 MB.</span>
                  <input
                    ref={inputAdjuntoRef}
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx"
                    className="hidden"
                    onChange={(e) => anadirAdjuntos(e.target.files)}
                  />
                </div>
                {adjuntos.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5 mt-2">
                    {adjuntos.map((a) => (
                      <li key={a.id} className="inline-flex items-center gap-1 text-[12px] bg-slate-50 border border-slate-200 rounded px-2 py-1">
                        <Paperclip size={12} className="text-slate-400 shrink-0" />
                        <span className="max-w-[260px] truncate" title={a.nombre}>{a.nombre}</span>
                        <button
                          type="button"
                          onClick={() => { setAdjuntos((prev) => prev.filter((x) => x.id !== a.id)); setConfirmarEnvio(false); }}
                          className="text-slate-400 hover:text-red-600"
                          aria-label={`Treure ${a.nombre}`}
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => { copiarConFirma(borrador); }}
                  disabled={!borrador}
                  className="text-sm font-semibold text-slate-600 border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
                >
                  Copiar text
                </button>
                <button
                  type="button"
                  onClick={enviarCorreu}
                  disabled={enviando || !borrador}
                  className="text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md px-4 py-2"
                >
                  {enviando ? "Enviant…" : confirmarEnvio ? "Confirmar enviament" : "Enviar"}
                </button>
              </div>
              {confirmarEnvio && !enviando && (
                <p className="text-[12px] text-amber-700 text-right">
                  S'enviarà{buzon ? ` des de ${buzon}` : ""} a {compo.para}{adjuntos.length ? `, amb ${adjuntos.length} adjunt${adjuntos.length > 1 ? "s" : ""}` : ""}. Torna a prémer per confirmar.
                </p>
              )}
            </div>
          </div>
        </div>
  );

  // ---- Vista de un correo abierto ----
  if (abierto) {
    const indiceAbierto = mensajes.findIndex((m) => m.id === abierto.id);
    const anterior = indiceAbierto > 0 ? mensajes[indiceAbierto - 1] : null;
    const siguiente = indiceAbierto >= 0 && indiceAbierto < mensajes.length - 1 ? mensajes[indiceAbierto + 1] : null;
    return (
      <div>
        {modalCompositor}
        {modalAlbaran}
        {aviso && <div className="mb-3 text-[13px] text-green-800 bg-green-50 border border-green-200 rounded-md px-3 py-2">{aviso}</div>}
        <div className="flex items-center justify-between gap-3 mb-4">
          <button onClick={() => setAbierto(null)} className="flex items-center gap-1 text-sm text-blue-700 hover:underline">
            <ArrowLeft size={15} /> Tornar a la safata
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!anterior || cargandoMsg}
              onClick={() => anterior && abrir(anterior.id)}
              title="Correu anterior"
              className="flex items-center gap-1 text-sm font-semibold text-slate-600 border border-slate-300 rounded-md px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft size={16} /> Anterior
            </button>
            <button
              type="button"
              disabled={!siguiente || cargandoMsg}
              onClick={() => siguiente && abrir(siguiente.id)}
              title="Correu següent"
              className="flex items-center gap-1 text-sm font-semibold text-slate-600 border border-slate-300 rounded-md px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-40"
            >
              Següent <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={() => abrirCompositor("responder", abierto)} className="flex items-center gap-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md px-4 py-2">
            <Sparkles size={15} /> Respondre amb ajuda de Claude
          </button>
          <button
            type="button"
            onClick={proponerAlbaranVenta}
            disabled={albaran?.fase === "leyendo" || albaran?.fase === "creando"}
            className="flex items-center gap-2 text-sm font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md px-4 py-2"
            title="Llegeix l'OC adjunta, crea el pedido de venta a BC, el registra i treu el PDF de l'albarà"
          >
            <Paperclip size={15} /> Preparar albarà de venda
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
                  cuerpo: abierto.cuerpo || "",
                  tipoCuerpo: abierto.tipoCuerpo || "text",
                  id: abierto.id,
                },
              })}
              className="flex items-center gap-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md px-4 py-2"
            >
              <CheckSquare size={15} /> Crear tasca d'aquest correu
            </button>
          )}
        </div>
        <div className="flex flex-col xl:flex-row gap-4 items-start">
        <div className="bg-white border border-slate-200 rounded-lg p-5 flex-1 min-w-0">
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
        {!recDescartada && (
        <aside className="w-full xl:w-[380px] xl:sticky xl:top-4 shrink-0 bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Sparkles size={15} className="text-blue-600" /> Recomanació de resposta
            </div>
            <button
              type="button"
              onClick={() => setRecDescartada(true)}
              className="text-[12px] font-semibold text-slate-500 hover:text-slate-800 shrink-0"
            >
              Descartar recomanació
            </button>
          </div>
          {cargandoRec && <div className="mt-3 text-[13px] text-slate-400">Mirant el correu i les dades de l'app…</div>}
          {errorRec && <div className="mt-3 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{errorRec}</div>}
          {recomendacion && (
            <div className="mt-3 space-y-3">
              {(recomendacion.queHacer || (recomendacion.acciones || []).length > 0) && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
                  <div className="text-[11px] font-bold text-amber-800 uppercase">Què has de fer</div>
                  <p className="text-[13px] text-slate-800 leading-relaxed">{recomendacion.queHacer}</p>
                  {(recomendacion.acciones || []).map((a, i) => {
                    const clave = a.tipo + "|" + (a.factura || "") + "|" + (a.cliente || "");
                    const texto = a.tipo === "abono"
                      ? "Vols obrir a BC l'abonament de venda" + (a.factura ? " " + a.factura : "") + "?"
                      : "Vols obrir a BC la factura de venda" + (a.cliente ? " per a " + a.cliente : "") + "?";
                    return (
                      <button
                        key={clave + i}
                        type="button"
                        disabled={accionBc === clave}
                        onClick={() => prepararDocumentBc(a, clave)}
                        className="block w-full text-left text-[12px] font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-60 rounded-md px-3 py-2"
                      >
                        {accionBc === clave ? "Preparant el document…" : texto}
                      </button>
                    );
                  })}
                  {avisoImporte && <div className={"text-[12px] font-semibold rounded px-2 py-1 border " + (importeOk ? "text-green-800 bg-green-50 border-green-200" : "text-red-800 bg-red-50 border-red-200")}>{avisoImporte}</div>}
                  {errorAccion && (
                    <div className="space-y-2">
                      <div className="text-[12px] text-red-700">{errorAccion}</div>
                      {accionFallida && (
                        <form
                          className="flex gap-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const texto = pistaCliente.trim();
                            if (!texto || accionBc) return;
                            prepararDocumentBc(accionFallida.accion, accionFallida.clave, texto);
                          }}
                        >
                          <input
                            value={pistaCliente}
                            onChange={(e) => setPistaCliente(e.target.value)}
                            placeholder="DNI, número de client o nom"
                            className="flex-1 min-w-0 text-[12px] border border-red-200 rounded px-2 py-1"
                          />
                          <button
                            type="submit"
                            disabled={!pistaCliente.trim() || !!accionBc}
                            className="text-[12px] font-semibold text-white bg-slate-800 rounded px-2 py-1 disabled:opacity-50"
                          >
                            Buscar
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}
              <p className="text-[13px] text-slate-700 leading-relaxed">{recomendacion.recomendacion}</p>
              {(recomendacion.apoyos || []).length > 0 && (
                <ul className="text-[12px] text-slate-600 space-y-1">
                  {recomendacion.apoyos.map((a, i) => <li key={i} className="bg-slate-50 border border-slate-100 rounded px-2 py-1">{a}</li>)}
                </ul>
              )}
              {(recomendacion.fichaBC || recomendacion.fichas > 0) && (
                <div className="text-[11px] text-slate-400">
                  {recomendacion.fichaBC ? recomendacion.fichaBC : ""}{recomendacion.fichas > 0 ? ` · ${recomendacion.fichas} OT a l'app` : ""}
                </div>
              )}
              {recomendacion.borrador && (
                <div className="bg-blue-50/60 border border-blue-100 rounded-md p-3 max-h-80 overflow-y-auto space-y-3">
                  <pre className="text-[12px] leading-relaxed text-slate-800 whitespace-pre-wrap font-sans">{recomendacion.borrador}</pre>
                  <BloqueFirma />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!recomendacion.borrador}
                  onClick={() => abrirCompositor("responder", abierto, recomendacion.borrador)}
                  className="text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md px-3 py-1.5"
                >
                  Usar aquest text
                </button>
                <button
                  type="button"
                  disabled={!recomendacion.borrador}
                  onClick={() => { copiarConFirma(recomendacion.borrador || ""); }}
                  className="text-[12px] font-semibold text-slate-600 border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
                >
                  Copiar
                </button>
              </div>
            </div>
          )}
        </aside>
        )}
        </div>
        {modalCompositor}
      </div>
    );
  }

  // ---- Bandeja ----
  return (
    <div>
      {aviso && <div className="mb-3 text-[13px] text-green-800 bg-green-50 border border-green-200 rounded-md px-3 py-2">{aviso}</div>}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Correu</h1>
          <p className="text-slate-500 text-sm mt-1">
            Safata de {carpeta === "inbox" ? "entrada" : "enviats"}
            {buzon ? <> · <span className="font-medium text-slate-700">{buzon}</span></> : " · resolviendo buzón…"}
            {!cargando && <> · {mensajes.length} correus des del 09/10/2025</>}
          </p>
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

      {modalCompositor}
    </div>
  );
}
