/**
 * Informe diario por correo del control de horas.
 *
 * Cada día, a la misma hora que el de pedidos (INFORME_HORAS_HORA, por
 * defecto las 8:00, Europe/Madrid), mira el día de hace INFORME_HORAS_DIAS
 * (por defecto 10) y avisa de los trabajadores que superan la jornada en
 * horas normales o no llegan.
 * La jornada por defecto es 8 h (la de Control de horas). Vacaciones, baja,
 * permiso y festivo cuentan como día cubierto. Las máquinas no entran.
 */
const { hoyMadrid, restarDias } = require("./informePedidosPendientes.cjs");
const { llistarUnitats } = require("./constellation");

const CLAVE_ESTADO = "informe_horas";
const DIAS_ACTIVOS = 21;
const AUSENCIA = new Set(["vacaciones", "baja", "festivo", "permiso"]);

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
}

function horasTxt(n) {
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " h";
}

const GRUPO_RECURSO = { ALQ: "Alquiler", MAQ: "Maquinaria", PRAC: "Prácticas" };
const DEPARTAMENTO_GRUPO = {
  AU: "Automatización",
  CO: "Construcción",
  INS: "Instalaciones",
  MA: "Mantenimiento",
  MR: "Mantenimiento",
  SI: "Servicio de ingeniería",
};

function departamentoDeGrupo(codigo) {
  const c = String(codigo || "").trim().toUpperCase();
  if (!c) return "Sin departamento";
  if (GRUPO_RECURSO[c]) return GRUPO_RECURSO[c];
  const m = c.match(/^MO([A-Z]+?)(\d{2})$/);
  if (!m) return c;
  return DEPARTAMENTO_GRUPO[m[1]] || m[1];
}

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

function diaSemana(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function listaFestivos(ajustes) {
  if (Array.isArray(ajustes.festivosLista)) return ajustes.festivosLista;
  return (ajustes.festivos || []).map((f) => ({ recurso: "", fecha: f }));
}

function contextoJornada(ajustes) {
  const festivos = new Set();
  const festivosRec = {};
  for (const l of listaFestivos(ajustes)) {
    if (!l.fecha) continue;
    if (l.recurso) (festivosRec[l.recurso] ||= new Set()).add(l.fecha);
    else festivos.add(l.fecha);
  }
  const festPobl = Object.fromEntries((ajustes.poblaciones || []).map((p) => [p.nombre, new Set(p.festivos || [])]));
  const incPorRec = {};
  for (const i of ajustes.incidencias || []) {
    if (i.tipo === "libre" || i.tipo === "reduccion") (incPorRec[i.recurso] ||= []).push(i);
  }
  const jornadaDia = (dia, recurso) => {
    const ds = diaSemana(dia);
    if (ds === 0 || ds === 6 || festivos.has(dia)) return 0;
    let base = ds === 5 && ajustes.jornadaViernes ? Number(ajustes.jornadaViernes) : Number(ajustes.jornada) || 8;
    if (recurso) {
      if (festivosRec[recurso]?.has(dia)) return 0;
      const pob = ajustes.asignacion?.[recurso];
      if (pob && festPobl[pob]?.has(dia)) return 0;
      for (const i of incPorRec[recurso] || []) {
        if (dia < i.desde || dia > (i.hasta || i.desde)) continue;
        if (i.tipo === "libre") return 0;
        if (i.tipo === "reduccion") base = Math.min(base, Number(i.horas) || base);
      }
    }
    return base;
  };
  return { jornadaDia };
}

function diasAtras() {
  const n = Number(process.env.INFORME_HORAS_DIAS ?? 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

function horaEnvio() {
  const n = Number(process.env.INFORME_HORAS_HORA ?? process.env.INFORME_PC_HORA ?? 8);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 8;
}

function destinatarios() {
  const crudo = String(process.env.INFORME_HORAS_DESTINO || "").trim();
  const lista = crudo
    ? crudo.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    : [process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com", "edith.galvez@alsocasals.com"];
  const vistos = new Set();
  return lista.filter((e) => {
    const k = e.toLowerCase();
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

function buzonRemitente() {
  return String(process.env.M365_BUZON_PERSONAL || "maria.rufi@alsocasals.com").trim();
}

function claveAjustes(empresa) {
  if (!empresa.id || empresa.id === process.env.BC_COMPANY_ID) return "horas_ajustes";
  const slug = String(empresa.nombre || empresa.id)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `horas_ajustes_${slug}`;
}

async function tokenAzure(tenant, clientId, secret, scope) {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: secret,
    scope,
  });
  const r = await fetch(url, { method: "POST", body });
  if (!r.ok) throw new Error(`Azure respondió ${r.status} al pedir token`);
  return (await r.json()).access_token;
}

let tokenBC = { token: null, expira: 0 };
async function obtenerTokenBC() {
  if (tokenBC.token && Date.now() < tokenBC.expira) return tokenBC.token;
  const token = await tokenAzure(
    process.env.BC_TENANT_ID,
    process.env.BC_CLIENT_ID,
    process.env.BC_CLIENT_SECRET,
    "https://api.businesscentral.dynamics.com/.default"
  );
  tokenBC = { token, expira: Date.now() + 50 * 60 * 1000 };
  return token;
}

let tokenGraph = { token: null, expira: 0 };
async function obtenerTokenGraph() {
  if (tokenGraph.token && Date.now() < tokenGraph.expira) return tokenGraph.token;
  const token = await tokenAzure(
    process.env.M365_TENANT_ID,
    process.env.M365_CLIENT_ID,
    process.env.M365_CLIENT_SECRET,
    "https://graph.microsoft.com/.default"
  );
  tokenGraph = { token, expira: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function pedir(url, headers) {
  const r = await fetch(url, { headers });
  const txt = await r.text();
  if (!r.ok) {
    const err = new Error(`BC respondió ${r.status}: ${txt.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return txt ? JSON.parse(txt) : {};
}

async function paginar(url, headers) {
  const out = [];
  let next = url;
  while (next) {
    const pagina = await pedir(next, headers);
    out.push(...(pagina.value || []));
    next = pagina["@odata.nextLink"] || null;
  }
  return out;
}

async function empresasCompra(token) {
  const raiz = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies`;
  const lista = await pedir(raiz, { Authorization: `Bearer ${token}`, Accept: "application/json" });
  const re = new RegExp(process.env.APP_EMPRESAS || "also|ferros|quimlab", "i");
  return (lista.value || [])
    .filter((c) => re.test(`${c.name} ${c.displayName || ""}`))
    .map((c) => ({ id: c.id, nombre: c.name, etiqueta: c.displayName || c.name }));
}

function campo(fila, nombres) {
  for (const n of nombres) if (fila[n] != null && fila[n] !== "") return fila[n];
  return "";
}

async function leerMovimientos(token, empresa, desde, hasta) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(empresa.nombre)}')`;
  const servicio = process.env.BC_WS_MOVSPROYECTO || "Movs_proyecto_Excel";
  const filtro = encodeURIComponent(`Posting_Date ge ${desde} and Posting_Date le ${hasta}`);
  const sel = "&$select=Entry_No,Posting_Date,Entry_Type,Type,No,Description,Work_Type_Code,Unit_of_Measure_Code,Quantity,Document_No,Job_No";
  let brutas;
  try {
    brutas = await paginar(`${base}/${encodeURIComponent(servicio)}?$filter=${filtro}${sel}`, headers);
  } catch (e) {
    if (e.status !== 400) throw e;
    brutas = await paginar(`${base}/${encodeURIComponent(servicio)}?$filter=${filtro}`, headers);
  }
  const filas = [];
  for (const f of brutas) {
    const fecha = String(campo(f, ["Posting_Date", "Fecha_registro", "PostingDate"])).slice(0, 10);
    if (!fecha || fecha < desde || fecha > hasta) continue;
    const tipo = String(campo(f, ["Type", "Tipo"]));
    if (tipo && !/resour|recurs/i.test(tipo)) continue;
    const tipoMov = String(campo(f, ["Entry_Type", "Tipo_movimiento", "EntryType"]));
    if (tipoMov && !/usage|uso|consumo/i.test(tipoMov)) continue;
    filas.push({
      fecha,
      recurso: String(campo(f, ["No", "No_", "Nº"])).trim(),
      desc: String(campo(f, ["Description", "Descripción", "Descripcion"])).trim(),
      tipoTrabajo: String(campo(f, ["Work_Type_Code", "Cod_tipo_trabajo", "WorkTypeCode"])).trim(),
      unidad: String(campo(f, ["Unit_of_Measure_Code", "Cod_unidad_medida", "UnitOfMeasureCode"])).trim(),
      horas: Number(campo(f, ["Quantity", "Cantidad"])) || 0,
      doc: String(campo(f, ["Document_No", "No_documento", "DocumentNo"])).trim(),
      ot: String(campo(f, ["Job_No", "No_proyecto", "JobNo"])).trim(),
    });
  }
  return filas;
}

async function leerRecursos(token, empresa) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(empresa.nombre)}')`;
  const servicio = process.env.BC_WS_RECURSOS || "Ficha_recurso_Excel";
  let filas;
  try {
    filas = await paginar(`${base}/${encodeURIComponent(servicio)}?$select=No,Name,Type,Resource_Group_No`, headers);
  } catch (e) {
    if (e.status !== 400 && e.status !== 404) throw e;
    return { nombres: {}, maquina: new Set(), departamentos: {} };
  }
  const nombres = {};
  const maquina = new Set();
  const departamentos = {};
  for (const r of filas) {
    const no = String(campo(r, ["No", "No_", "Nº"])).trim();
    if (!no) continue;
    nombres[no] = String(campo(r, ["Name", "Nombre"]) || no).trim();
    const tipo = String(campo(r, ["Type", "Tipo"]) || "");
    if (/machin|m[aá]quina/i.test(tipo)) maquina.add(no);
    departamentos[no] = departamentoDeGrupo(campo(r, ["Resource_Group_No", "ResourceGroupNo"]));
  }
  return { nombres, maquina, departamentos };
}

async function leerClientes(token, empresa, ots) {
  const unicos = [...new Set((ots || []).map((o) => String(o || "").trim()).filter(Boolean))];
  if (!unicos.length) return {};
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(empresa.nombre)}')`;
  const servicio = process.env.BC_WS_JOBLIST || "Job_List";
  const clientes = {};
  for (let i = 0; i < unicos.length; i += 15) {
    const filtro = unicos.slice(i, i + 15).map((ot) => `No eq '${ot.replace(/'/g, "''")}'`).join(" or ");
    let filas;
    try {
      filas = await paginar(`${base}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}&$select=No,Bill_to_Name`, headers);
    } catch (e) {
      if (e.status === 404) return clientes;
      if (e.status !== 400) throw e;
      filas = await paginar(`${base}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}`, headers);
    }
    for (const j of filas) {
      const no = String(j.No || "").trim();
      if (no) clientes[no] = String(j.Bill_to_Name || j.Description || "").trim();
    }
  }
  return clientes;
}

function desviaciones({ filas, nombres, maquina, departamentos, clientes, ajustes, fecha }) {
  const { jornadaDia } = contextoJornada(ajustes);
  const catDe = (tipo) => ajustes.tipos?.[tipo] || adivinar(tipo);
  const porRec = {};
  for (const f0 of filas) {
    if (!f0.recurso || maquina.has(f0.recurso)) continue;
    const cat = catDe(f0.tipoTrabajo);
    if (cat === "noHoras") continue;
    const enDias = /^(d|dia|día|dias|días|day|days|jornada)$/i.test(f0.unidad);
    const horas = enDias ? f0.horas * (jornadaDia(f0.fecha, f0.recurso) || Number(ajustes.jornada) || 8) : f0.horas;
    const r = (porRec[f0.recurso] ||= { activo: false, trabajo: 0, extra: 0, aus: 0, lineas: [] });
    r.activo = true;
    if (f0.fecha !== fecha) continue;
    r.lineas.push({
      tipo: f0.tipoTrabajo || "—",
      horas,
      parte: f0.doc || "",
      ot: f0.ot || "",
      cliente: (clientes && f0.ot && clientes[f0.ot]) || "",
    });
    if (cat === "normal") r.trabajo += horas;
    else if (cat === "extra") { r.trabajo += horas; r.extra += horas; }
    else if (AUSENCIA.has(cat)) r.aus += horas;
    else r.trabajo += horas;
  }

  const avisos = [];
  for (const [recurso, r] of Object.entries(porRec)) {
    if (!r.activo) continue;
    const jornada = jornadaDia(fecha, recurso);
    if (!(jornada > 0)) continue;
    const normales = r.trabajo - r.extra;
    const cubierto = r.trabajo + r.aus;
    let situacion = "";
    let orden = 0;
    if (normales > jornada + 0.01) {
      situacion = `Supera ${horasTxt(normales - jornada)}`;
      orden = 0;
    } else if (cubierto < jornada - 0.01) {
      situacion = `Faltan ${horasTxt(jornada - cubierto)}`;
      orden = 1;
    } else continue;
    avisos.push({
      nombre: nombres[recurso] || recurso,
      departamento: (departamentos && departamentos[recurso]) || "Sin departamento",
      recurso,
      normales,
      ausencias: r.aus,
      jornada,
      imputadas: cubierto,
      situacion,
      orden,
      gap: orden === 0 ? normales - jornada : jornada - cubierto,
      lineas: [...r.lineas].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.ot.localeCompare(b.ot) || a.parte.localeCompare(b.parte)),
    });
  }
  avisos.sort((a, b) => a.orden - b.orden || b.gap - a.gap || a.nombre.localeCompare(b.nombre, "es"));
  return avisos;
}

function detalleHtml(f) {
  const thd = "text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-size:11px;color:#64748b;font-weight:600";
  const tdd = "padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b";
  const cuerpo = f.lineas.map((l) => `<tr><td style="${tdd};font-family:Consolas,monospace">${esc(l.tipo)}</td><td style="${tdd};text-align:right">${esc(horasTxt(l.horas))}</td><td style="${tdd}">${esc(l.parte || "—")}</td><td style="${tdd}">${esc(l.ot || "—")}</td><td style="${tdd}">${esc(l.cliente || "—")}</td></tr>`).join("");
  const total = f.lineas.reduce((s, l) => s + l.horas, 0);
  return `<table style="border-collapse:collapse;width:100%;margin-top:8px">
<thead><tr><th style="${thd}">Tipo de hora</th><th style="${thd};text-align:right">Horas</th><th style="${thd}">Nº parte</th><th style="${thd}">Nº OT</th><th style="${thd}">Cliente</th></tr></thead>
<tbody>${cuerpo}<tr><td style="${tdd};font-weight:700;border-bottom:none">Total imputado</td><td style="${tdd};text-align:right;font-weight:700;border-bottom:none">${esc(horasTxt(total))}</td><td style="${tdd};border-bottom:none" colspan="3"></td></tr></tbody></table>`;
}

function normNombre(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function empresaCodigo(etiqueta) {
  const e = String(etiqueta || "").toLowerCase();
  if (e.includes("ferros")) return "0002";
  if (e.includes("quim")) return "0003";
  if (e.includes("also")) return "0001";
  return null;
}

function encajaNombre(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 2;
  const ta = a.split(" ");
  const tb = b.split(" ");
  if (ta.length < 2 || tb.length < 2) return 0;
  const corto = ta.length <= tb.length ? ta : tb;
  const largo = ta.length <= tb.length ? tb : ta;
  return corto.every((t, i) => largo[i] === t) ? 1 : 0;
}

function indiceUnidades(portal) {
  const porId = new Map((portal.unitats || []).map((u) => [u.id, u.nom]));
  const porEmpresa = new Map();
  for (const u of portal.usuaris || []) {
    const emp = String(u.empresa || "");
    if (!emp) continue;
    if (!porEmpresa.has(emp)) porEmpresa.set(emp, []);
    porEmpresa.get(emp).push(u);
  }
  return { porId, porEmpresa };
}

function dondeDePersona(nombre, empresa, indice) {
  const lista = indice.porEmpresa.get(empresa) || [];
  const buscado = normNombre(nombre);
  let mejor = 0;
  let elegidos = [];
  for (const u of lista) {
    const p = encajaNombre(buscado, normNombre(u.nom));
    if (p > mejor) {
      mejor = p;
      elegidos = [u];
    } else if (p === mejor && p > 0) elegidos.push(u);
  }
  if (mejor === 0 || elegidos.length !== 1) return "Sin ficha en ACconstelation";
  const nom = indice.porId.get(elegidos[0].un_id);
  return nom ? String(nom) : "Sin unidad en ACconstelation";
}

function asignarDonde(empresas, portal) {
  if (!portal?.ok) return false;
  const indice = indiceUnidades(portal);
  for (const e of empresas) {
    const cod = empresaCodigo(e.etiqueta);
    for (const f of e.filas) f.donde = cod ? dondeDePersona(f.nombre, cod, indice) : "Sin ficha en ACconstelation";
  }
  const tot = empresas.reduce((s, e) => s + e.filas.length, 0);
  const sin = empresas.reduce((s, e) => s + e.filas.filter((f) => String(f.donde || "").startsWith("Sin ")).length, 0);
  console.log(`[informe-horas] ACconstelation: ${tot - sin} de ${tot} con unidad`);
  return true;
}

function frasePersona(f) {
  if (!f.lineas?.length) return `No ha imputado horas. La jornada es ${horasTxt(f.jornada)}.`;
  if (f.orden === 0) return `Horas normales ${horasTxt(f.normales)}, jornada ${horasTxt(f.jornada)}.`;
  return `Ha imputado ${horasTxt(f.imputadas ?? 0)} de ${horasTxt(f.jornada)}.`;
}

function lineaDonde(f) {
  if (!f.donde) return "";
  if (f.donde.startsWith("Sin ")) {
    return `<div style="margin-top:2px;font-size:13px;color:#64748b">${esc(f.donde)}</div>`;
  }
  return `<div style="margin-top:2px;font-size:13px;color:#1e3a5f">Debería estar en <b>${esc(f.donde)}</b></div>`;
}

function tarjeta(f) {
  const supera = f.orden === 0;
  const vacio = !f.lineas?.length;
  const bg = vacio ? "#fef2f2" : supera ? "#fff7ed" : "#fffbeb";
  const fg = vacio ? "#991b1b" : supera ? "#9a3412" : "#92400e";
  const borde = vacio ? "#fecaca" : supera ? "#fed7aa" : "#fde68a";
  return `<table style="border-collapse:collapse;width:100%;margin:0 0 12px;border:1px solid ${borde}">
<tr><td style="padding:10px 12px;background:${bg}">
<div style="font-size:15px;font-weight:700;color:#0f172a">${esc(f.nombre)}</div>
${lineaDonde(f)}
<div style="margin-top:6px;font-size:13px;line-height:1.4">
<span style="display:inline-block;background:${fg};color:#fff;padding:2px 8px;font-weight:700">${esc(f.situacion)}</span>
<span style="color:#334155"> ${esc(frasePersona(f))}</span>
</div>
${vacio ? "" : detalleHtml(f)}
</td></tr></table>`;
}

function bloquePersonas(lista) {
  const vacios = lista.filter((f) => !f.lineas?.length);
  const con = lista.filter((f) => f.lineas?.length);
  let html = "";
  if (vacios.length) {
    html += `<p style="margin:10px 0 4px;font-size:13px;font-weight:700;color:#991b1b">Sin horas imputadas · ${vacios.length}</p>
<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#1e293b">${vacios.map((f) => esc(f.nombre)).join(" · ")}</p>`;
  }
  if (con.length) {
    html += `<p style="margin:10px 0 8px;font-size:13px;font-weight:700;color:#334155">Con horas, fuera de la jornada · ${con.length}</p>`;
    html += con.map(tarjeta).join("");
  }
  return html;
}

function tituloBloque(texto) {
  return `<table style="border-collapse:collapse;width:100%;margin:16px 0 8px"><tr><td style="background:#1e3a5f;color:#ffffff;padding:8px 12px;font-size:14px;font-weight:700">${texto}</td></tr></table>`;
}

function htmlInforme({ fecha, empresas }) {
  const n = empresas.reduce((s, e) => s + e.filas.length, 0);
  const superan = empresas.reduce((s, e) => s + e.filas.filter((f) => f.orden === 0).length, 0);
  const faltan = n - superan;
  const finde = diaSemana(fecha) === 0 || diaSemana(fecha) === 6;
  const nombreDia = diaSemana(fecha) === 0 ? "domingo" : "sábado";
  const bloques = empresas.map((e) => {
    if (!e.filas.length) {
      return `${tituloBloque(esc(e.etiqueta))}<p style="margin:0 0 8px;color:#64748b">Nadie se sale de la jornada.</p>`;
    }
    const cabecera = tituloBloque(`${esc(e.etiqueta)} · ${e.filas.length} fuera de jornada`);
    const conPortal = e.filas.some((f) => f.donde);
    if (!conPortal && !/also/i.test(e.etiqueta)) return cabecera + bloquePersonas(e.filas);
    const grupos = new Map();
    for (const f of e.filas) {
      const dep = conPortal ? f.donde : (f.departamento || "Sin departamento");
      if (!grupos.has(dep)) grupos.set(dep, []);
      grupos.get(dep).push(f);
    }
    const alFinal = (a) => a.startsWith("Sin ficha") || a.startsWith("Sin unidad") || a === "Sin departamento";
    const orden = [...grupos.keys()].sort((a, b) => {
      if (alFinal(a) !== alFinal(b)) return alFinal(a) ? 1 : -1;
      return a.localeCompare(b, "es");
    });
    const partes = orden.map((dep) => {
      const lista = grupos.get(dep);
      return `<p style="margin:14px 0 2px;font-size:15px;font-weight:700;color:#1e3a5f">${esc(dep)} · ${lista.length}</p>${bloquePersonas(lista)}`;
    }).join("");
    return cabecera + partes;
  }).join("");
  const resumen = finde && !n
    ? `El <b>${esc(fechaCorta(fecha))}</b> es ${nombreDia}. No hay jornada de 8 h ese día, así que no se marca a quien no imputó horas.`
    : n
    ? `Día <b>${esc(fechaCorta(fecha))}</b>. <b>${faltan}</b> no llegan a la jornada y <b>${superan}</b> se pasan en horas normales. Cada bloque es la unidad de ACconstelation: ahí es donde debería estar. Quien imputó horas lleva debajo el parte, la OT y el cliente.`
    : `El <b>${esc(fechaCorta(fecha))}</b> nadie se sale de la jornada.`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.4">
<p style="margin:0 0 8px">Buenos días,</p>
<p style="margin:0 0 4px">${resumen}</p>
${bloques}
<p style="margin-top:18px;color:#64748b;font-size:12px">Jornada de Control de horas: 8 h, salvo viernes, festivo o reducción. Vacaciones, baja, permiso y festivo cuentan como día cubierto. Las horas extra declaradas no cuentan como pasarse de las 8 h normales.</p>
<p style="margin:12px 0 0">Un saludo,<br>ACSales</p>
</div>`;
}

async function preparar({ db, fecha, fechaHoy } = {}) {
  const hoy = fechaHoy || hoyMadrid().fecha;
  const dia = fecha || restarDias(hoy, diasAtras());
  const desde = restarDias(dia, DIAS_ACTIVOS);
  const token = await obtenerTokenBC();
  const empresas = await empresasCompra(token);
  const bloques = [];
  let leidas = 0;
  for (const empresa of empresas) {
    try {
      const ajustes = db ? await db.getDoc(claveAjustes(empresa), { tipos: {}, jornada: 8, festivos: [] }) : { tipos: {}, jornada: 8, festivos: [] };
      const [filas, rec] = await Promise.all([
        leerMovimientos(token, empresa, desde, dia),
        leerRecursos(token, empresa),
      ]);
      if (!filas.length) {
        leidas++;
        continue;
      }
      const clientes = await leerClientes(token, empresa, filas.filter((f) => f.fecha === dia).map((f) => f.ot));
      const avisos = desviaciones({ filas, nombres: rec.nombres, maquina: rec.maquina, departamentos: rec.departamentos, clientes, ajustes, fecha: dia });
      bloques.push({ etiqueta: empresa.etiqueta, filas: avisos });
      leidas++;
    } catch (e) {
      if (e.status === 404) {
        console.warn(`[informe-horas] ${empresa.etiqueta}: sin movimientos de proyecto`);
        continue;
      }
      throw e;
    }
  }
  if (!leidas) throw new Error("No se pudieron leer las horas de ninguna empresa.");
  try {
    const portal = await llistarUnitats();
    if (!asignarDonde(bloques, portal)) {
      console.warn("[informe-horas] sin unidades de ACconstelation:", portal?.error || "no configurado");
    }
  } catch (e) {
    console.warn("[informe-horas] ACconstelation:", e.message);
  }
  const n = bloques.reduce((s, e) => s + e.filas.length, 0);
  const asunto = n
    ? `Control de horas — ${fechaCorta(dia)} (${n} fuera de jornada)`
    : `Control de horas — ${fechaCorta(dia)} (nadie fuera de jornada)`;
  return { fecha: dia, fechaHoy: hoy, empresas: bloques, n, asunto, html: htmlInforme({ fecha: dia, empresas: bloques }) };
}

async function enviarCorreo({ asunto, html, para }) {
  const token = await obtenerTokenGraph();
  const de = buzonRemitente();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(de)}/sendMail`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: asunto,
        body: { contentType: "HTML", content: html },
        toRecipients: para.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Graph respondió ${r.status} al enviar el control de horas: ${detalle}`);
  }
  return { de, para };
}

async function enviar({ db, fecha, fechaHoy, marcar = false, para } = {}) {
  const informe = await preparar({ db, fecha, fechaHoy });
  const destino = Array.isArray(para) && para.length ? para : destinatarios();
  const envio = await enviarCorreo({ asunto: informe.asunto, html: informe.html, para: destino });
  if (marcar && db) {
    await db.setDoc(CLAVE_ESTADO, {
      ultimo: informe.fechaHoy,
      fecha: informe.fecha,
      n: informe.n,
      para: destino,
      ts: new Date().toISOString(),
    });
  }
  return {
    ...envio,
    asunto: informe.asunto,
    fecha: informe.fecha,
    fechaHoy: informe.fechaHoy,
    n: informe.n,
    empresas: informe.empresas.map((e) => ({ etiqueta: e.etiqueta, n: e.filas.length })),
  };
}

function programar({ db }) {
  const hora = horaEnvio();
  let ultimoIntento = 0;
  const tick = async () => {
    try {
      const ahora = hoyMadrid();
      if (ahora.hora < hora) return;
      const estado = await db.getDoc(CLAVE_ESTADO, {});
      if (estado.ultimo === ahora.fecha) return;
      if (Date.now() - ultimoIntento < 15 * 60 * 1000) return;
      ultimoIntento = Date.now();
      const r = await enviar({ db, fechaHoy: ahora.fecha, marcar: true });
      console.log(`[informe-horas] ${r.fechaHoy} horas del ${r.fecha}: ${r.n} → ${[].concat(r.para).join(", ")}`);
    } catch (err) {
      console.error("[informe-horas]", err.message || err);
    }
  };
  setTimeout(tick, 25000);
  setInterval(tick, 60 * 1000);
  console.log(`[informe-horas] Cada día a las ${String(hora).padStart(2, "0")}:00 (Europe/Madrid), jornada de hace ${diasAtras()} días → ${destinatarios().join(", ")}`);
}

module.exports = { preparar, enviar, programar };
