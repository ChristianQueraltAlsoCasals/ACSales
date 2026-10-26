/** Acciones del catálogo ACconstelation (deben coincidir con el servidor). */
export const ACCIONES = ["solo_control_horas"];

function bool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Super del portal (Nivell 0). */
export const esSuper = (u) => u && !!u.portal_super;

/** Admin del portal o super (gestión de permisos desde ACconstelation). */
export const esAdminPortal = (u) =>
  u && (esSuper(u) || u.portal_rol === "admin");

/**
 * Usuarios con la acción `solo_control_horas` (sin ser admin/super del portal)
 * solo ven Control de horas en ACsales.
 */
export const soloControlHoras = (u) => {
  if (!u || esAdminPortal(u)) return false;
  if (!u.accions || typeof u.accions !== "object") return false;
  return bool(u.accions.solo_control_horas);
};
