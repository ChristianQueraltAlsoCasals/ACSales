/**
 * DATOS DE DEMOSTRACIÓN
 * ---------------------------------------------------------------
 * Solo para poder probar el flujo completo (construir memoria +
 * consultar) en local sin datos reales. En producción, estos tres
 * arrays llegan de los Excels y de la API de Business Central.
 *
 * Formatos de Nº de OT mezclados a propósito (Excel "9999",
 * BC "AC00xxxx/2099") para verificar que la unión funciona.
 */

const listadoOTs = [
  { "Nº OT": "1001", Cliente: "Industrias Vila", "Tipo de trabajo": "Reparación", Departamento: "Mantenimiento", Descripción: "Reparar fuga en tubería de agua nave 2", "Unidad de negocio": "Fontanería" },
  { "Nº OT": "1002", Cliente: "Talleres Puig", "Tipo de trabajo": "Reparación", Departamento: "Mantenimiento", Descripción: "Avería en tubería, pérdida de agua vestuarios", "Unidad de negocio": "Fontanería" },
  { "Nº OT": "1003", Cliente: "Bodegas Serra", "Tipo de trabajo": "Instalación", Departamento: "Proyectos", Descripción: "Instalación cuadro eléctrico nueva línea embotellado", "Unidad de negocio": "Electricidad" },
  { "Nº OT": "1004", Cliente: "Hotel Mar Blau", "Tipo de trabajo": "Mantenimiento", Departamento: "Mantenimiento", Descripción: "Revisión y limpieza de climatización planta 3", "Unidad de negocio": "Climatización" },
  { "Nº OT": "1005", Cliente: "Industrias Vila", "Tipo de trabajo": "Reparación", Departamento: "Mantenimiento", Descripción: "Sanear fuga de fontanería en aseos oficinas", "Unidad de negocio": "Fontanería" },
  { "Nº OT": "1006", Cliente: "Logística Camps", "Tipo de trabajo": "Instalación", Departamento: "Proyectos", Descripción: "Montaje de cuadro eléctrico para muelle de carga", "Unidad de negocio": "Electricidad" },
  { "Nº OT": "1007", Cliente: "Hotel Mar Blau", "Tipo de trabajo": "Reparación", Departamento: "Mantenimiento", Descripción: "Fuga de agua en instalación de riego jardín", "Unidad de negocio": "Fontanería" },
];

const lineasVenta = [
  // 1001 — fuga tubería
  { "Nº OT": "AC001001/2099", Tipo: "Recurso", Nº: "MO-01", Descripción: "Horas oficial fontanería", Cantidad: "5", "Precio unitario": "38", "Importe línea": "190" },
  { "Nº OT": "AC001001/2099", Tipo: "Producto", Nº: "TUB-22", Descripción: "Tubo multicapa 22mm", Cantidad: "4", "Precio unitario": "9", "Importe línea": "36" },
  { "Nº OT": "AC001001/2099", Tipo: "Producto", Nº: "RAC-05", Descripción: "Racores prensar", Cantidad: "8", "Precio unitario": "3,5", "Importe línea": "28" },
  { "Nº OT": "AC001001/2099", Tipo: "Cuenta", Nº: "DES-01", Descripción: "Desplazamiento zona 2", Cantidad: "1", "Precio unitario": "25", "Importe línea": "25" },
  // 1002 — avería tubería
  { "Nº OT": "AC001002/2099", Tipo: "Recurso", Nº: "MO-01", Descripción: "Horas oficial fontanería", Cantidad: "4", "Precio unitario": "38", "Importe línea": "152" },
  { "Nº OT": "AC001002/2099", Tipo: "Producto", Nº: "TUB-22", Descripción: "Tubo multicapa 22mm", Cantidad: "3", "Precio unitario": "9", "Importe línea": "27" },
  { "Nº OT": "AC001002/2099", Tipo: "Cuenta", Nº: "DES-01", Descripción: "Desplazamiento zona 1", Cantidad: "1", "Precio unitario": "20", "Importe línea": "20" },
  // 1003 — cuadro eléctrico
  { "Nº OT": "AC001003/2099", Tipo: "Recurso", Nº: "MO-02", Descripción: "Horas oficial electricista", Cantidad: "16", "Precio unitario": "42", "Importe línea": "672" },
  { "Nº OT": "AC001003/2099", Tipo: "Producto", Nº: "CUA-01", Descripción: "Cuadro eléctrico metálico", Cantidad: "1", "Precio unitario": "340", "Importe línea": "340" },
  { "Nº OT": "AC001003/2099", Tipo: "Producto", Nº: "MAG-16", Descripción: "Magnetotérmicos varios", Cantidad: "12", "Precio unitario": "18", "Importe línea": "216" },
  { "Nº OT": "AC001003/2099", Tipo: "Cuenta", Nº: "DES-02", Descripción: "Desplazamiento zona 3", Cantidad: "2", "Precio unitario": "30", "Importe línea": "60" },
  // 1004 — climatización
  { "Nº OT": "AC001004/2099", Tipo: "Recurso", Nº: "MO-03", Descripción: "Horas técnico climatización", Cantidad: "6", "Precio unitario": "40", "Importe línea": "240" },
  { "Nº OT": "AC001004/2099", Tipo: "Producto", Nº: "FIL-09", Descripción: "Filtros de recambio", Cantidad: "8", "Precio unitario": "12", "Importe línea": "96" },
  // 1005 — fuga fontanería aseos
  { "Nº OT": "AC001005/2099", Tipo: "Recurso", Nº: "MO-01", Descripción: "Horas oficial fontanería", Cantidad: "3", "Precio unitario": "38", "Importe línea": "114" },
  { "Nº OT": "AC001005/2099", Tipo: "Producto", Nº: "RAC-05", Descripción: "Racores prensar", Cantidad: "6", "Precio unitario": "3,5", "Importe línea": "21" },
  { "Nº OT": "AC001005/2099", Tipo: "Cuenta", Nº: "DES-01", Descripción: "Desplazamiento zona 2", Cantidad: "1", "Precio unitario": "25", "Importe línea": "25" },
  // 1006 — cuadro eléctrico muelle
  { "Nº OT": "AC001006/2099", Tipo: "Recurso", Nº: "MO-02", Descripción: "Horas oficial electricista", Cantidad: "14", "Precio unitario": "42", "Importe línea": "588" },
  { "Nº OT": "AC001006/2099", Tipo: "Producto", Nº: "CUA-01", Descripción: "Cuadro eléctrico metálico", Cantidad: "1", "Precio unitario": "360", "Importe línea": "360" },
  { "Nº OT": "AC001006/2099", Tipo: "Producto", Nº: "MAG-16", Descripción: "Magnetotérmicos varios", Cantidad: "10", "Precio unitario": "18", "Importe línea": "180" },
  { "Nº OT": "AC001006/2099", Tipo: "Cuenta", Nº: "DES-02", Descripción: "Desplazamiento zona 3", Cantidad: "1", "Precio unitario": "30", "Importe línea": "30" },
  // 1007 — fuga riego
  { "Nº OT": "AC001007/2099", Tipo: "Recurso", Nº: "MO-01", Descripción: "Horas oficial fontanería", Cantidad: "4", "Precio unitario": "38", "Importe línea": "152" },
  { "Nº OT": "AC001007/2099", Tipo: "Producto", Nº: "TUB-16", Descripción: "Tubo riego 16mm", Cantidad: "10", "Precio unitario": "2", "Importe línea": "20" },
  { "Nº OT": "AC001007/2099", Tipo: "Cuenta", Nº: "DES-01", Descripción: "Desplazamiento zona 1", Cantidad: "1", "Precio unitario": "20", "Importe línea": "20" },
];

const lineasCompra = [
  // 1001
  { "Nº OT": "AC001001/2099", "Nº documento": "PC-5540", Nº: "TUB-22", Descripción: "Tubo multicapa 22mm", Cantidad: "4", "Coste unitario": "5", "Importe línea": "20" },
  { "Nº OT": "AC001001/2099", "Nº documento": "PC-5540", Nº: "RAC-05", Descripción: "Racores prensar", Cantidad: "8", "Coste unitario": "2", "Importe línea": "16" },
  { "Nº OT": "AC001001/2099", "Nº documento": "OC-2210", Nº: "AIS-09", Descripción: "Coquilla aislante", Cantidad: "2", "Coste unitario": "4", "Importe línea": "8" },
  // 1002
  { "Nº OT": "AC001002/2099", "Nº documento": "PC-5541", Nº: "TUB-22", Descripción: "Tubo multicapa 22mm", Cantidad: "3", "Coste unitario": "5", "Importe línea": "15" },
  // 1003
  { "Nº OT": "AC001003/2099", "Nº documento": "PC-5550", Nº: "CUA-01", Descripción: "Cuadro eléctrico metálico", Cantidad: "1", "Coste unitario": "210", "Importe línea": "210" },
  { "Nº OT": "AC001003/2099", "Nº documento": "PC-5550", Nº: "MAG-16", Descripción: "Magnetotérmicos varios", Cantidad: "12", "Coste unitario": "11", "Importe línea": "132" },
  // 1004
  { "Nº OT": "AC001004/2099", "Nº documento": "PC-5560", Nº: "FIL-09", Descripción: "Filtros de recambio", Cantidad: "8", "Coste unitario": "6", "Importe línea": "48" },
  // 1005
  { "Nº OT": "AC001005/2099", "Nº documento": "PC-5570", Nº: "RAC-05", Descripción: "Racores prensar", Cantidad: "6", "Coste unitario": "2", "Importe línea": "12" },
  // 1006
  { "Nº OT": "AC001006/2099", "Nº documento": "PC-5580", Nº: "CUA-01", Descripción: "Cuadro eléctrico metálico", Cantidad: "1", "Coste unitario": "225", "Importe línea": "225" },
  { "Nº OT": "AC001006/2099", "Nº documento": "PC-5580", Nº: "MAG-16", Descripción: "Magnetotérmicos varios", Cantidad: "10", "Coste unitario": "11", "Importe línea": "110" },
  // 1007
  { "Nº OT": "AC001007/2099", "Nº documento": "PC-5590", Nº: "TUB-16", Descripción: "Tubo riego 16mm", Cantidad: "10", "Coste unitario": "1", "Importe línea": "10" },
];

export const OTS_DEMO = { listadoOTs, lineasVenta, lineasCompra };
