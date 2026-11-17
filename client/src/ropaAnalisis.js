/**
 * Pedidos y stock de ropa, hoja STOCK 3/11/26 de Taula roba ALSO.
 * Solo filas de talla. Las celdas de precio de las cabeceras no entran.
 * Los años salen de la fecha de cada columna de pedido.
 */
export const FECHA_STOCK = "3/11/2026";
export const ANOS = [2022, 2023, 2024, 2025, 2026];

export const LINEAS = [
  { id: "pantalon", talla: "S", stock: 39, pedido: 111, anos: { 2023: 46, 2024: 30, 2025: 35 }, ref: "MPVEPPOWERMS" },
  { id: "pantalon", talla: "M", stock: 30, pedido: 240, anos: { 2023: 100, 2024: 60, 2025: 80 }, ref: "MPVEPPOWERMM" },
  { id: "pantalon", talla: "L", stock: 29, pedido: 160, anos: { 2023: 80, 2024: 60, 2025: 20 }, ref: "MPVEPPOWERML" },
  { id: "pantalon", talla: "XL", stock: 6, pedido: 50, anos: { 2023: 30, 2024: 20 }, ref: "MPVEPPOWERMXL" },
  { id: "jaqueta", talla: "M", stock: 2, pedido: 40, anos: { 2023: 10, 2024: 20, 2025: 10 }, ref: "MPVEJHV1772M" },
  { id: "jaqueta", talla: "L", stock: 1, pedido: 65, anos: { 2023: 35, 2024: 30 }, ref: "MPVEJHV1772L" },
  { id: "jaqueta", talla: "XL", stock: 10, pedido: 40, anos: { 2023: 20, 2024: 20 }, ref: "MPVEJHV1772XL" },
  { id: "jaqueta", talla: "XXL", stock: 14, pedido: 20, anos: { 2023: 5, 2024: 15 }, ref: "MPVEJHV1772XXL" },
  { id: "polo", talla: "M", stock: 36, pedido: 175, anos: { 2023: 25, 2024: 40, 2025: 30, 2026: 80 }, ref: "6502DOGOM" },
  { id: "polo", talla: "L", stock: 2, pedido: 167, anos: { 2023: 40, 2024: 57, 2025: 30, 2026: 40 }, ref: "6502DOGOL" },
  { id: "polo", talla: "XL", stock: 23, pedido: 144, anos: { 2023: 40, 2024: 54, 2025: 10, 2026: 40 }, ref: "6502DOGOXL" },
  { id: "polo", talla: "XXL", stock: 17, pedido: 59, anos: { 2023: 15, 2024: 4, 2025: 20, 2026: 20 }, ref: "6502DOGOXXL" },
  { id: "polo", talla: "XXXL", stock: 27, pedido: 40, anos: { 2023: 10, 2025: 10, 2026: 20 }, ref: "6502DOGOXXXL" },
  { id: "jersey", talla: "M", stock: 8, pedido: 105, anos: { 2022: 10, 2023: 35, 2024: 10, 2025: 10, 2026: 40 }, ref: "1217ROLYM" },
  { id: "jersey", talla: "L", stock: 3, pedido: 108, anos: { 2022: 25, 2023: 23, 2024: 10, 2025: 20, 2026: 30 }, ref: "1217ROLYL" },
  { id: "jersey", talla: "XL", stock: 17, pedido: 120, anos: { 2022: 25, 2023: 35, 2024: 10, 2025: 30, 2026: 20 }, ref: "1217ROLYXL" },
  { id: "jersey", talla: "XXL", stock: 14, pedido: 24, anos: { 2023: 4, 2025: 20 }, ref: "1217ROLYXXL" },
  { id: "jersey", talla: "XXXL", stock: 24, pedido: 24, anos: { 2024: 4, 2025: 20 }, ref: "1217ROLYXXXL" },
  { id: "sudadera", talla: "M", stock: 2, pedido: 52, anos: { 2023: 27, 2024: 15, 2026: 10 }, ref: "305701M" },
  { id: "sudadera", talla: "L", stock: 19, pedido: 80, anos: { 2022: 30, 2023: 25, 2024: 15, 2026: 10 }, ref: "305701L" },
  { id: "sudadera", talla: "XL", stock: 10, pedido: 60, anos: { 2022: 30, 2023: 5, 2024: 15, 2026: 10 }, ref: "305701XL" },
  { id: "sudadera", talla: "XXL", stock: 11, pedido: 20, anos: { 2023: 5, 2024: 15 }, ref: "305701XXL" },
  { id: "zapato", talla: "41", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO41" },
  { id: "zapato", talla: "42", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO42" },
  { id: "zapato", talla: "43", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO43" },
  { id: "zapato", talla: "44", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO44" },
  { id: "zapato", talla: "45", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO45" },
  { id: "zapato", talla: "46", stock: 0, pedido: 0, anos: {}, ref: "MPCACOWENSFO46" },
  { id: "zapato", talla: "47", stock: 0, pedido: 0, anos: {}, ref: "" },
  { id: "zapato", talla: "48", stock: 0, pedido: 0, anos: {}, ref: "" },
];

export function lineasDe(id) {
  return LINEAS.filter((l) => l.id === id);
}

export function tallasDe(id) {
  return lineasDe(id).map((l) => l.talla);
}

export function stockExcel() {
  const unidades = {};
  for (const l of LINEAS) unidades[`${l.id}|${l.talla}`] = l.stock;
  return unidades;
}

export function sumaAno(lineas, ano) {
  return lineas.reduce((a, l) => a + (l.anos[ano] || 0), 0);
}
