/**
 * departamentos.js — mapeo ÚNICO departamento → emails de responsables.
 *
 * Fuente de verdad compartida entre el Explorador de OTs
 * (CargarDatosVentas.jsx), Validación de facturas (facturasCompra.jsx),
 * Recepción (recepcion.jsx) y Control de horas (horas.jsx).
 *
 * Edith, Ana y Maria no van en los departamentos: son Administración
 * y se ponen en copia. Quien envía se quita de esa copia.
 * Dirección (Xavi, Ramon Also, Yuly) no va en el correo automático:
 * se añade a mano en el campo Copia cuando haga falta.
 */
export const EMAILS_DEPARTAMENTO = {
  MAN: ["albert.curto@alsocasals.com", "alex.lopez@alsocasals.com"],
  INS: ["jesus.calvo@alsocasals.com", "gabriel.galvez@alsocasals.com"],
  CON: ["jordi.costea@alsocasals.com", "ramon.castell@alsocasals.com"],
  AMT: ["jordi.costea@alsocasals.com", "ramon.castell@alsocasals.com"],
  AUT: ["josep.altadill@alsocasals.com"],
};

/** Nombre de unidad (grupo de recurso / filtro de Control de horas) → código de email. */
const UNIDAD_A_CODIGO = {
  instalaciones: "INS",
  mantenimiento: "MAN",
  automatizacion: "AUT",
  "servicio de ingenieria": "AUT",
  construccion: "CON",
  amianto: "AMT",
};

function normUnidad(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Convierte «Instalaciones», «MAN», «MAN-P», etc. al código de EMAILS_DEPARTAMENTO. */
export function codigoDepartamentoDesdeUnidad(unidad) {
  const raw = String(unidad || "").trim();
  if (!raw) return null;
  const seg = raw.split("-")[0].trim().toUpperCase();
  if (EMAILS_DEPARTAMENTO[seg]) return seg;
  // Alias cortos del grupo de recurso (manoObra.jsx)
  const alias = { MA: "MAN", MR: "MAN", AU: "AUT", CO: "CON", SI: "AUT" };
  if (alias[seg]) return alias[seg];
  return UNIDAD_A_CODIGO[normUnidad(raw)] || null;
}

export const EMAILS_ADMINISTRACION = [
  "ana.moreno@ferrosca.com",
  "edith.galvez@alsocasals.com",
  "maria.rufi@alsocasals.com",
];

export const EMAILS_DIRECCION = [
  "xavi.also@alsocasals.com",
  "ramon.also@alsocasals.com",
  "yuly.medina@alsocasals.com",
];

function mismoEmail(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/** Copia automática: solo Administración, sin la persona que envía. */
export function copiasAdministracion(emailRemitente) {
  return EMAILS_ADMINISTRACION.filter((e) => !mismoEmail(e, emailRemitente));
}

/** A partir de un código de departamento crudo (p.ej. "MAN", "MAN-P"),
 * devuelve la lista de emails o null si no se reconoce. */
export function emailsPorCodigoDepartamento(codigo) {
  if (!codigo) return null;
  const seg = codigo.toString().split("-")[0].trim().toUpperCase();
  return EMAILS_DEPARTAMENTO[seg] || null;
}

/** Para = equipo del departamento. Copia = Administración.
 *  Sin departamento, el Para es Administración y no hay copia, para no repetir. */
export function listasCorreoDepartamento(codigo) {
  const equipo = emailsPorCodigoDepartamento(codigo);
  if (equipo && equipo.length) {
    return { para: [...equipo], cc: [...EMAILS_ADMINISTRACION] };
  }
  return { para: [...EMAILS_ADMINISTRACION], cc: [] };
}

/** Quita a quien envía de la copia. Si el Para es solo Administración
 *  (no había equipo de departamento), también lo quita de ahí. */
export function aplicarRemitente(para, cc, emailRemitente) {
  const yo = String(emailRemitente || "").trim().toLowerCase();
  const lista = (arr) => (Array.isArray(arr) ? arr : []).map((e) => String(e || "").trim()).filter(Boolean);
  let para2 = lista(para);
  let cc2 = lista(cc);
  if (yo) {
    const paraEsAdmin = para2.length > 0 && para2.every((e) =>
      EMAILS_ADMINISTRACION.some((a) => a.toLowerCase() === e.toLowerCase())
    );
    if (paraEsAdmin) para2 = para2.filter((e) => e.toLowerCase() !== yo);
    cc2 = cc2.filter((e) => e.toLowerCase() !== yo);
  }
  const enPara = new Set(para2.map((e) => e.toLowerCase()));
  const vistos = new Set();
  cc2 = cc2.filter((e) => {
    const k = e.toLowerCase();
    if (enPara.has(k) || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  return { para: para2, cc: cc2 };
}
