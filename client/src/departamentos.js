/**
 * departamentos.js — mapeo ÚNICO departamento → emails de responsables.
 *
 * Fuente de verdad compartida entre el Explorador de OTs
 * (CargarDatosVentas.jsx) y Validación de facturas (facturasCompra.jsx),
 * para no tener dos listas que puedan desincronizarse.
 */
export const EMAILS_DEPARTAMENTO = {
  MAN: ["albert.curto@alsocasals.com", "alex.lopez@alsocasals.com", "edith.galvez@alsocasals.com"],
  INS: ["jesus.calvo@alsocasals.com", "gabriel.galvez@alsocasals.com", "edith.galvez@alsocasals.com"],
  CON: ["jordi.costea@alsocasals.com", "ramon.castell@alsocasals.com", "edith.galvez@alsocasals.com"],
  AMT: ["jordi.costea@alsocasals.com", "ramon.castell@alsocasals.com", "edith.galvez@alsocasals.com"],
  AUT: ["josep.altadill@alsocasals.com", "edith.galvez@alsocasals.com"],
};

export const EMAIL_POR_DEFECTO = "edith.galvez@alsocasals.com";

/** A partir de un código de departamento crudo (p.ej. "MAN", "MAN-P"),
 * devuelve la lista de emails o null si no se reconoce. */
export function emailsPorCodigoDepartamento(codigo) {
  if (!codigo) return null;
  const seg = codigo.toString().split("-")[0].trim().toUpperCase();
  return EMAILS_DEPARTAMENTO[seg] || null;
}
