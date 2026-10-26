// Permisos ACsales según ACconstelation (`accions` + rol del portal).

const ACCIONES = ["solo_control_horas"];

function bool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

function accionsVacias() {
  return { solo_control_horas: false };
}

/**
 * Acceso completo a la app: la flag restrictiva queda en false.
 * (Admin/super nunca deben quedar bloqueados en solo Control de horas.)
 */
function accionsTodas() {
  return { solo_control_horas: false };
}

/** Normaliza la respuesta del portal. Admin del portal → app completa. */
function normalizarAccions(raw, portalRol) {
  if (String(portalRol || "") === "admin") return accionsTodas();
  const out = accionsVacias();
  if (!raw || typeof raw !== "object") return out;
  if (raw.solo_control_horas !== undefined) {
    out.solo_control_horas = bool(raw.solo_control_horas);
  }
  return out;
}

/**
 * Sin portal configurado: app completa (dev local).
 * Con portal caído: solo admin/super local mantienen acceso completo.
 */
function accionsFallbackLocal(usuario) {
  if (usuario?.rol === "admin" || usuario?.rol === "super" || usuario?.portal_super) {
    return accionsTodas();
  }
  return accionsVacias();
}

function accionsDe(usuario) {
  if (usuario?.accions && typeof usuario.accions === "object") {
    return { ...accionsVacias(), ...usuario.accions };
  }
  return accionsVacias();
}

function esSuperApp(usuario) {
  return !!usuario && (usuario.rol === "super" || !!usuario.portal_super);
}

function esAdminPortal(usuario) {
  return !!usuario && (esSuperApp(usuario) || usuario.portal_rol === "admin");
}

/** Acción concreta del catálogo (true explícito). Admin/super → true salvo flags restrictivas. */
function puede(usuario, clave) {
  if (!usuario || !clave) return false;
  if (clave === "solo_control_horas") {
    return soloControlHoras(usuario);
  }
  if (esAdminPortal(usuario)) return true;
  return Boolean(accionsDe(usuario)[clave]);
}

/**
 * Usuarios con la acción `solo_control_horas` (y sin ser admin/super)
 * solo pueden ver Control de horas.
 */
function soloControlHoras(usuario) {
  if (!usuario) return false;
  if (esAdminPortal(usuario)) return false;
  return Boolean(accionsDe(usuario).solo_control_horas);
}

module.exports = {
  ACCIONES,
  accionsVacias,
  accionsTodas,
  normalizarAccions,
  accionsFallbackLocal,
  accionsDe,
  puede,
  esAdminPortal,
  esSuperApp,
  soloControlHoras,
};
