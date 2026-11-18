/**
 * Correo de revisión de horas a los responsables (Europe/Madrid, 8:00).
 *
 * Se envía cada lunes y también el día 7, para cerrar el mes.
 * Si el 7 cae en lunes, sale un solo correo.
 *
 * Periodo: el mes que sigue abierto hasta el día 7 del mes siguiente,
 * incluyendo esos 7 días.
 *   · El 2 de noviembre → 1 de octubre a 7 de noviembre.
 *   · El 7 de noviembre → 1 de octubre a 7 de noviembre (cierre).
 *   · A partir del 8 de noviembre → 1 de noviembre a 7 de diciembre.
 */
const { hoyMadrid } = require("./informePedidosPendientes.cjs");
const {
  obtenerTokenBC,
  empresasCompra,
  leerMovimientos,
  leerRecursos,
  contextoJornada,
  adivinar,
  claveAjustes,
} = require("./informeHoras.cjs");

const CLAVE_ESTADO = "aviso_horas_lunes";
/** Excepción pedida el 6/11/2026: el cierre del 7 de noviembre no se envía. */
const OMITIR_FECHAS = new Set(["2026-11-07"]);
const URL_CUADRO = "https://acsales.alsocasals.com/#/horas";
const AUSENCIA = new Set(["vacaciones", "baja", "festivo", "permiso"]);
const SIN_DEPTO = "Sin departamento";

const PARA = [
  "albert.curto@alsocasals.com",
  "alex.lopez@alsocasals.com",
  "jesus.calvo@alsocasals.com",
  "gabriel.galvez@alsocasals.com",
  "jordi.costea@alsocasals.com",
  "ramon.castell@alsocasals.com",
  "josep.altadill@alsocasals.com",
];
const CC = [
  "ana.moreno@ferrosca.com",
  "edith.galvez@alsocasals.com",
  "maria.rufi@alsocasals.com",
];

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

function horasTxt(n) {
  const r = Math.round((Number(n) || 0) * 100) / 100;
  return `${r ? r.toLocaleString("es-ES") : "0"} h`;
}

function diaSemana(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function sumarDias(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

function isoDia(anio, mes, dia) {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Mes abierto: hasta el día 7 del mes siguiente, con esos 7 días incluidos. */
function periodoRevision(fecha) {
  const [y, m, d] = String(fecha).split("-").map(Number);
  let mes = m;
  let anio = y;
  if (d <= 7) {
    mes -= 1;
    if (mes < 1) {
      mes = 12;
      anio -= 1;
    }
  }
  let mesFin = mes + 1;
  let anioFin = anio;
  if (mesFin > 12) {
    mesFin = 1;
    anioFin += 1;
  }
  return { desde: isoDia(anio, mes, 1), hasta: isoDia(anioFin, mesFin, 7) };
}

function diasEntre(desde, hasta) {
  const out = [];
  let cursor = desde;
  while (cursor <= hasta && out.length < 400) {
    out.push(cursor);
    cursor = sumarDias(cursor, 1);
  }
  return out;
}

function horaEnvio() {
  const n = Number(process.env.AVISO_HORAS_LUNES_HORA ?? process.env.INFORME_HORAS_HORA ?? 8);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 8;
}

function destinatarios() {
  const de = String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim().toLowerCase();
  const cc = CC.filter((e) => e.toLowerCase() !== de);
  return { para: [...PARA], cc };
}

function introHtml(desde, hasta) {
  const p = "margin:0 0 12px";
  return `<p style="${p}">Estimados Responsables y Técnicos de UN.</p>
<p style="${p}">Les solicitamos revisar, modificar y validar las horas registradas de los operarios del <b>${esc(fechaCorta(desde))} al ${esc(fechaCorta(hasta))}</b>, asegurándose de que cada trabajador tenga registradas sus 8 horas diarias y que cada hora esté correctamente asignada al código de trabajo correspondiente: Horas Normales, Horas Extras, Festivo 1, Festivo 2, Nocturnas, Guardia o Urgencias.</p>
<p style="${p}">Recordar que lo que esta en naranja no se debe validar.</p>
<p style="${p}">Adjunto link para que puedan ver que días y horas se deben revisar, dichas horas se encuentran marcadas en color rojo en la tabla que aparece en la pestaña horas o directamente en el botón de power Bi del de chat de teams que tienen conmigo. <a href="${esc(URL_CUADRO)}" style="color:#1d4ed8;font-weight:700;text-decoration:underline">Haz clic</a></p>
<p style="${p}">Es importante que esta revisión se realice a la brevedad posible, con el fin de garantizar la correcta imputación en el sistema y evitar inconsistencias en los reportes.<br>Agradeceré confirmar una vez finalizada la validación o informarnos si existe alguna observación.<br>Quedo atento(a) a sus comentarios.</p>`;
}

function detalleDias(f) {
  const dias = [
    ...(f.sinImputar || []).map((dia) => ({ dia, horas: 0 })),
    ...(f.incompletos || []).map((x) => ({ dia: x.dia, horas: x.horas })),
  ].sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
  return dias.map((d) => {
    const movs = (f.movs || []).filter((m) => m.fecha === d.dia);
    const porTipo = new Map();
    for (const m of movs) {
      const k = m.tipoTrabajo || "(sin tipo)";
      porTipo.set(k, (porTipo.get(k) || 0) + (Number(m.horas) || 0));
    }
    const lineas = [...porTipo.entries()].map(([tipo, horas]) => ({ tipo, horas }));
    const total = movs.length ? lineas.reduce((t, l) => t + l.horas, 0) : d.horas;
    return { dia: d.dia, lineas, total };
  });
}

function htmlTabla(filas) {
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:1px solid #cbd5e1;background:#f8fafc;font-size:12px;color:#475569"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top"';
  const tdSub = 'style="padding:4px 10px 4px 22px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#334155"';
  const tdNum = 'style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;white-space:nowrap;color:#334155"';
  const tdTotal = 'style="padding:4px 10px 8px 22px;border-bottom:1px solid #cbd5e1;font-size:12px;font-weight:700;color:#0f172a"';
  const tdNumBold = 'style="padding:4px 10px 8px;border-bottom:1px solid #cbd5e1;font-size:12px;font-weight:700;text-align:right;white-space:nowrap;color:#0f172a"';
  if (!filas.length) {
    return `<p style="margin:16px 0;font-size:13px;color:#334155">No hay días en rojo ni en naranja en este periodo.</p>`;
  }
  const porDepto = new Map();
  for (const f of filas) {
    const depto = f.depto || SIN_DEPTO;
    if (!porDepto.has(depto)) porDepto.set(depto, []);
    porDepto.get(depto).push(f);
  }
  const departamentos = [...porDepto.keys()].sort((a, b) => {
    if (a === SIN_DEPTO) return 1;
    if (b === SIN_DEPTO) return -1;
    return a.localeCompare(b, "es");
  });
  const bloques = departamentos.map((depto) => {
    const lista = porDepto.get(depto).slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    const etiqueta = `${lista.length} incidencia${lista.length === 1 ? "" : "s"}`;
    const cuerpo = lista.map((f) => {
      const dias = detalleDias(f);
      const filasDia = dias.map((d) => {
        const lineas = d.lineas.length
          ? d.lineas.map((l) => `<tr><td ${tdSub}>${esc(fechaCorta(d.dia))} · ${esc(l.tipo)}</td><td ${tdNum}>${esc(horasTxt(l.horas))}</td></tr>`).join("")
          : `<tr><td ${tdSub}>${esc(fechaCorta(d.dia))} · sin línea</td><td ${tdNum}>0 h</td></tr>`;
        return `${lineas}<tr><td ${tdTotal}>${esc(fechaCorta(d.dia))} · Horas totales</td><td ${tdNumBold}>${esc(horasTxt(d.total))}</td></tr>`;
      }).join("");
      return `<tr><td colspan="2" ${td}><b>${esc(f.nombre)}</b> <span style="color:#64748b;font-weight:400;font-size:11px">${esc(f.recurso)}</span></td></tr>${filasDia}`;
    }).join("");
    return `<table style="border-collapse:collapse;width:100%;max-width:720px;font-family:Segoe UI,Arial,sans-serif;margin:16px 0 0">
<tr><td style="background:#0f3a5f;color:#ffffff;padding:8px 12px;font-size:14px;font-weight:700">${esc(depto)}</td>
<td style="background:#0f3a5f;color:#ffffff;padding:8px 12px;font-size:14px;font-weight:700;text-align:right;white-space:nowrap">${etiqueta}</td></tr></table>
<table style="border-collapse:collapse;width:100%;max-width:720px;font-family:Segoe UI,Arial,sans-serif;margin:0 0 8px">
<thead><tr><th ${th}>Día y línea</th><th ${th} style="text-align:right">Horas</th></tr></thead>
<tbody>${cuerpo}</tbody></table>`;
  }).join("");
  return `<div style="margin:16px 0 4px;font-size:13px;color:#334155"><b>${departamentos.length} departamento${departamentos.length === 1 ? "" : "s"}</b> · ${filas.length} trabajador${filas.length === 1 ? "" : "es"} con horas a revisar</div>
${bloques}
<p style="margin:14px 0 0;font-size:12px;color:#64748b">En rojo: día laborable sin imputar. En naranja: faltan horas (no validar).</p>`;
}

function revisar({ filas, nombres, maquina, departamentos, ajustes, desde, hasta, hastaReal, alta }) {
  const { jornadaDia } = contextoJornada(ajustes || {}, alta);
  const catDe = (tipo) => (ajustes?.tipos && ajustes.tipos[tipo]) || adivinar(tipo);
  const inactivos = new Set((ajustes && ajustes.inactivos) || []);
  const porRec = {};
  for (const f0 of filas) {
    if (!f0.recurso || maquina.has(f0.recurso) || inactivos.has(f0.recurso)) continue;
    const cat = catDe(f0.tipoTrabajo);
    if (cat === "noHoras") continue;
    const enDias = /^(d|dia|día|dias|días|day|days|jornada)$/i.test(String(f0.unidad || ""));
    const horas = enDias ? f0.horas * (jornadaDia(f0.fecha, f0.recurso) || Number(ajustes?.jornada) || 8) : f0.horas;
    const r = (porRec[f0.recurso] ||= {
      nombre: nombres[f0.recurso] || f0.desc || f0.recurso,
      dias: {},
      movs: [],
    });
    const celda = (r.dias[f0.fecha] ||= { trabajo: 0, aus: 0 });
    if (AUSENCIA.has(cat)) celda.aus += horas;
    else celda.trabajo += horas;
    r.movs.push({ fecha: f0.fecha, tipoTrabajo: f0.tipoTrabajo || "(sin tipo)", horas });
  }
  for (const recurso of (ajustes && ajustes.activosForzados) || []) {
    if (!recurso || inactivos.has(recurso) || maquina.has(recurso) || porRec[recurso]) continue;
    porRec[recurso] = { nombre: nombres[recurso] || recurso, dias: {}, movs: [] };
  }
  const dias = diasEntre(desde, hasta).filter((dia) => dia <= hastaReal);
  const avisos = [];
  for (const [recurso, r] of Object.entries(porRec)) {
    if (inactivos.has(recurso)) continue;
    const sinImputar = [];
    const incompletos = [];
    for (const dia of dias) {
      const j = jornadaDia(dia, recurso);
      if (!(j > 0)) continue;
      const x = r.dias[dia];
      const total = x ? x.trabajo + x.aus : 0;
      if (!x || total === 0) sinImputar.push(dia);
      else if (total < j - 0.01) incompletos.push({ dia, horas: total, jornada: j });
    }
    if (!sinImputar.length && !incompletos.length) continue;
    avisos.push({
      recurso,
      nombre: r.nombre,
      depto: departamentos[recurso] || SIN_DEPTO,
      sinImputar,
      incompletos,
      movs: r.movs,
    });
  }
  avisos.sort((a, b) => a.depto.localeCompare(b.depto, "es") || a.nombre.localeCompare(b.nombre, "es"));
  return avisos;
}

async function preparar({ db, fechaHoy } = {}) {
  const hoy = fechaHoy || hoyMadrid().fecha;
  const { desde, hasta } = periodoRevision(hoy);
  const hastaReal = sumarDias(hoy, -1);
  const token = await obtenerTokenBC();
  const empresas = await empresasCompra(token);
  const empresa = empresas.find((e) => /also/i.test(`${e.nombre} ${e.etiqueta}`) && !/ferros|quim/i.test(`${e.nombre} ${e.etiqueta}`));
  if (!empresa) throw new Error("No encuentro la empresa Also Casals en Business Central.");
  const ajustes = db
    ? await db.getDoc(claveAjustes(empresa), { tipos: {}, jornada: 8, festivos: [] })
    : { tipos: {}, jornada: 8, festivos: [] };
  const finLectura = hasta < hastaReal ? hasta : hastaReal;
  // 21 días antes del periodo: quien imputó entonces sigue en activo aunque
  // el periodo no tenga ninguna línea suya (ese laborable sale sin imputar).
  const desdeLectura = sumarDias(desde, -21);
  const [movs, rec] = await Promise.all([
    finLectura < desde ? [] : leerMovimientos(token, empresa, desdeLectura, finLectura),
    leerRecursos(token, empresa),
  ]);
  const filas = revisar({
    filas: movs,
    nombres: rec.nombres,
    maquina: rec.maquina,
    departamentos: rec.departamentos,
    ajustes,
    desde,
    hasta,
    hastaReal: hastaReal < desde ? desde : hastaReal,
    alta: rec.alta,
  });
  const asunto = `Revisión de horas · ${fechaCorta(desde)}–${fechaCorta(hasta)}`;
  const html = `<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.45">
${introHtml(desde, hasta)}
${htmlTabla(filas)}
</div>`;
  return { hoy, desde, hasta, hastaReal, n: filas.length, asunto, html, empresa: empresa.etiqueta };
}

async function tokenGraph() {
  const url = `https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.M365_CLIENT_ID,
    client_secret: process.env.M365_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch(url, { method: "POST", body });
  if (!r.ok) throw new Error(`Azure respondió ${r.status} al pedir token`);
  return (await r.json()).access_token;
}

async function enviarCorreo({ asunto, html, para, cc }) {
  const access = await tokenGraph();
  const de = String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(de)}/sendMail`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: asunto,
        body: { contentType: "HTML", content: html },
        toRecipients: para.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (cc || []).map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Graph respondió ${r.status} al enviar la revisión de horas: ${detalle}`);
  }
  return { de, para, cc };
}

async function enviar({ db, fechaHoy, marcar = false } = {}) {
  const informe = await preparar({ db, fechaHoy });
  const { para, cc } = destinatarios();
  const envio = await enviarCorreo({ asunto: informe.asunto, html: informe.html, para, cc });
  if (marcar && db) {
    await db.setDoc(CLAVE_ESTADO, {
      ultimo: informe.hoy,
      desde: informe.desde,
      hasta: informe.hasta,
      n: informe.n,
      para,
      cc,
      ts: new Date().toISOString(),
    });
  }
  return { ...envio, ...informe };
}

function programar({ db }) {
  if (process.env.AVISO_HORAS_LUNES_OFF === "1") {
    console.log("[aviso-horas] Desactivado (AVISO_HORAS_LUNES_OFF=1).");
    return;
  }
  const hora = horaEnvio();
  let ultimoIntento = 0;
  const tick = async () => {
    try {
      const ahora = hoyMadrid();
      const esLunes = diaSemana(ahora.fecha) === 1;
      const esCierre = Number(ahora.fecha.slice(8, 10)) === 7;
      if (!esLunes && !esCierre) return;
      if (ahora.hora < hora) return;
      const estado = await db.getDoc(CLAVE_ESTADO, {});
      if (OMITIR_FECHAS.has(ahora.fecha)) {
        if (estado.ultimo !== ahora.fecha) {
          await db.setDoc(CLAVE_ESTADO, {
            ultimo: ahora.fecha,
            omitido: true,
            motivo: "Excepción: no enviar el cierre del 7 de noviembre de 2026.",
            ts: new Date().toISOString(),
          });
          console.log("[aviso-horas] 2026-11-07 omitido por excepción. No se envía el cierre de octubre.");
        }
        return;
      }
      if (estado.ultimo === ahora.fecha) return;
      if (Date.now() - ultimoIntento < 15 * 60 * 1000) return;
      ultimoIntento = Date.now();
      const r = await enviar({ db, fechaHoy: ahora.fecha, marcar: true });
      console.log(`[aviso-horas] ${r.hoy} periodo ${r.desde}–${r.hasta}: ${r.n} trabajadores → ${r.para.join(", ")}`);
    } catch (err) {
      console.error("[aviso-horas]", err.message || err);
    }
  };
  setTimeout(tick, 30000);
  setInterval(tick, 60 * 1000);
  console.log(`[aviso-horas] Cada lunes y el día 7 a las ${String(hora).padStart(2, "0")}:00 (Europe/Madrid) → responsables. Periodo: mes abierto hasta el día 7 del mes siguiente. Excepción: no se envía el 2026-11-07.`);
}

module.exports = { periodoRevision, preparar, enviar, programar, diaSemana };
