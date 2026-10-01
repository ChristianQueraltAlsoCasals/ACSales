/**
 * =====================================================================
 *  AGENTE INTELIGENTE — Lógica de memoria histórica de OT's
 * =====================================================================
 *
 *  Pipeline completo:
 *
 *   [Listado OT's] ──┐
 *   [Líneas venta] ──┼──► LÓGICA 1: construir FICHA ÚNICA por Nº de OT
 *   [Líneas compra] ─┘              (horas, materiales, desplazamiento,
 *                                    coste real, margen...)
 *                          │
 *                          ▼
 *                    LÓGICA 2: convertir la DESCRIPCIÓN de cada OT
 *                    en ATRIBUTOS estructurados (vía Claude API)
 *                          │
 *                          ▼
 *                    LÓGICA 3: cuando entra una OT NUEVA,
 *                    buscar OTs históricas con atributos parecidos
 *                    y sugerir qué cobrar (materiales + mano de obra)
 *
 *  CLAVE DE UNIÓN: el Nº de OT.
 *
 *  ⚠️ CAMPOS A CONFIRMAR: los nombres de columna usados aquí
 *  (CONFIG.campos) son los estándar de Business Central. Ajústalos
 *  a los nombres reales de vuestros datos exportados.
 * =====================================================================
 */

// ---------------------------------------------------------------------
// CONFIGURACIÓN — nombres de columnas y reglas del negocio
// ---------------------------------------------------------------------
export const CONFIG = {
  campos: {
    // Comunes — CLAVE DE UNIÓN.
    // El nombre de la columna difiere según el origen:
    //   · CSV Listado de OT's   → "OT"
    //   · API Business Central  → el campo custom (ej. "noOT")
    // La función normalizarNumeroOT() unifica el VALOR (formato), pero
    // el NOMBRE de la columna debe existir en cada fila.
    numeroOT: "OT",

    // Listado de OT's (parte descriptiva) — nombres reales del CSV (catalán)
    ot: {
      cliente: "Client",
      tipoTrabajo: "Tipus feina",
      departamento: "Departament",
      descripcion: "Descripció",
      unidadNegocio: "Serie",
      // Línea de negocio (ej. "INS-P"): la trae la tabla Job de BC.
      // Si está presente, es la FUENTE AUTORITATIVA del segmento a nivel
      // de OT (por encima de la heurística por nombre de cliente).
      lineaNegocio: "Línia negoci",
      // El CSV de OTs ya trae importes; los aprovechamos directamente
      // sin necesidad de líneas de venta/compra cuando no las haya.
      pVenta: "P venta",
      pDespesa: "P despessa",
      beneficioNet: "Benefici net",
      maObra: "Ma obra",
      numeroHoras: "NH",
    },

    // Líneas de venta
    venta: {
      tipo: "Tipo", // Producto / Recurso / Cuenta
      numero: "Nº", // código del artículo o recurso
      descripcion: "Descripción",
      cantidad: "Cantidad",
      precioUnitario: "Precio unitario",
      importe: "Importe línea",
      // Dimensión 1 de BC: el segmento (ej. "INS-I", "MAN-A").
      // FUENTE AUTORITATIVA del tipo de cliente.
      segmento: "shortcut_Dimension_1_Code",
      // AÑADIDO: para el historial de venta (mismas columnas que compra)
      numeroDocumento: "Nº documento",
      fechaPedido: "Fecha pedido",
      dto1: "% Dto. 1",
      dto2: "% Dto. 2",
      dto3: "% Dto. 3",
    },

    // Líneas de compra
    compra: {
      numeroDocumento: "Nº documento", // OC-xxx = oferta, PC-xxx = pedido real
      numero: "Nº",
      descripcion: "Descripción",
      cantidad: "Cantidad",
      costeUnitario: "Coste unitario",
      importe: "Importe línea",
      // Dimensión 1 de BC: el segmento (ej. "INS-I", "MAN-A").
      segmento: "shortcut_Dimension_1_Code",
      // AÑADIDO: nombre real de columna confirmado en el Excel "Líns. compra"
      proveedor: "Nombre de proveedor de compra",
      fechaPedido: "Fecha pedido",
      // Descuentos por línea (hasta 3 en vuestro BC)
      dto1: "% Dto. 1",
      dto2: "% Dto. 2",
      dto3: "% Dto. 3",
    },
  },

  // Cómo distinguir qué es cada línea de venta.
  // En BC, "Tipo = Recurso" suele ser mano de obra; lo reforzamos
  // con palabras clave por si se facturan horas como concepto.
  clasificacionLineaVenta: {
    tiposManoObra: ["Recurso"],
    palabrasHoras: ["hora", "horas", "mano de obra", "m.o.", "operario", "oficial", "trabajo"],
    palabrasDesplazamiento: ["desplazamiento", "desplaz", "km", "kilometraje", "dieta", "salida"],
  },

  // Prefijos de documento en líneas de compra
  prefijos: {
    oferta: "OC", // material al que solo se pidió oferta
    pedido: "PC", // material que se compró realmente
  },

  // -------------------------------------------------------------------
  // SEGMENTACIÓN: unidad de negocio + tipo de cliente (ej. "INS-I").
  //
  // Tipos de cliente:  P = Particular · I = Industrial · A = Admón. pública
  //
  // Fuente preferente: el código de centro de coste (columna CC), si el
  // mapa de abajo está relleno. Fuente de respaldo: heurística por el
  // nombre del cliente (AJUNTAMENT→A, S.A./S.L.→I, resto→P).
  // -------------------------------------------------------------------
  segmentacion: {
    campoCC: "CC",
    // ⚠️ PENDIENTE DE CONFIRMAR: mapeo código CC → tipo de cliente.
    // Códigos observados en los datos: 00011, 00021, 00022, 00041,
    // 00042, 00051, 00052... Rellenar cuando se conozca su significado:
    // mapaCC: { "00041": "I", "00042": "P", ... }
    mapaCC: {},
    // Unidad de negocio a partir del Departament (a confirmar los códigos)
    mapaDepartamento: {
      "INSTAL·LACIONS": "INS",
      "MANTENIMENT": "MAN",
      "AUTOMATITZACIÓ": "AUT",
      "CONSTRUCCIÓ": "CON",
      "AMIANT": "AMI",
      "MECANITZAT I SERRALLERIA": "MEC",
    },
  },
};

/**
 * Parsea un código de segmento de BC: "INS-P" → { unidad: "INS", tipo: "P" }.
 * Formato: [unidad de negocio]-[tipo de cliente], donde el tipo es
 * P (particular), I (industrial) o A (administración pública).
 */
export function parsearSegmento(codigo) {
  if (!codigo) return null;
  const s = codigo.toString().trim().toUpperCase();
  const m = s.match(/^([A-Z]+)-([PIA])$/);
  if (m) return { codigo: s, unidad: m[1], tipo: m[2] };
  return { codigo: s, unidad: s, tipo: null }; // código sin sufijo reconocible
}

/**
 * Deduce el tipo de cliente (P/I/A) de una fila de OT.
 * 1º intenta el mapa de códigos CC; 2º heurística por nombre de cliente.
 */
export function derivarTipoCliente(fila, cfg = CONFIG) {
  const seg = cfg.segmentacion;
  const cc = (fila[seg.campoCC] ?? "").toString().trim();
  if (cc && seg.mapaCC[cc]) return seg.mapaCC[cc];

  const nombre = (fila[cfg.campos.ot.cliente] ?? "").toString();
  if (/AJUNTAMENT|AYUNTAMIENTO|CONSELL|DIPUTACI|GENERALITAT|MINISTERI|CONSORCI|INSTITUT\b|E\.?M\.?D\.?|ESCOLA|CEIP\b|COMARCAL|MUNICIPAL/i.test(nombre)) return "A";
  if (/\bS\.?A\.?\b|\bS\.?L\.?U?\.?\b|\bSCCL\b|\bCOOP\b|INDUSTRI|LOGISTIC/i.test(nombre)) return "I";
  if (nombre.trim()) return "P";
  return null;
}

/** Deduce el código de segmento completo, ej. "INS-I" */
export function derivarSegmento(fila, cfg = CONFIG) {
  const dep = (fila[cfg.campos.ot.departamento] ?? "").toString().trim().toUpperCase();
  const unidad = cfg.segmentacion.mapaDepartamento[dep] || null;
  const tipo = derivarTipoCliente(fila, cfg);
  if (unidad && tipo) return `${unidad}-${tipo}`;
  return unidad || tipo || null;
}

// ---------------------------------------------------------------------
// TABLA JOB (167) DE BUSINESS CENTRAL — página Job List (89)
// ---------------------------------------------------------------------
// Fuente PREFERIDA del listado de OT's: por API, sin Excels, y con el
// código de línea de negocio (INS-P/INS-I/INS-A...) a nivel de OT.
// Nombres de campo CONFIRMADOS con el JSON real del web service
// "Job_List" (así expone BC la página 89 publicada como "Job List").
// ---------------------------------------------------------------------
export const JOB_CAMPOS = {
  numeroOT: "No",                            // "AC000185/2019"
  descripcion: "Description",
  descripcionAlt: "Search_Description",
  cliente: "Bill_to_Name",
  clienteNo: "Bill_to_Customer_No",
  lineaNegocio: "Global_Dimension_1_Code",   // "INS-P", "MAN-A"... (confirmado)
  departamento: "Departamento_Responsable",  // "INS", "MAN", "AUT", "CON", "AMT"
  estado: "Status",                          // "Open" / "Planning"
};

/** Convierte filas de la tabla Job (API) al formato del listado de OT's.
 *  Solo la serie AC (OTs reales, numeración continua). La serie PR son
 *  PRESUPUESTOS y su numeración se reinicia cada año, así que no pueden
 *  compartir clave con las OTs ni forman parte de la memoria histórica. */
export function adaptarFilasJob(filasJob, campos = JOB_CAMPOS, seriePrefijo = "AC") {
  return (filasJob || [])
    .filter((f) => {
      const no = (f[campos.numeroOT] ?? "").toString().trim().toUpperCase();
      const dim = (f[campos.lineaNegocio] ?? "").toString().trim();
      // solo la serie de OTs reales; fuera internas (_AUS, _EST) y presupuestos (PR)
      return no.startsWith(seriePrefijo) && !dim.startsWith("_");
    })
    .map((f) => ({
      OT: f[campos.numeroOT],
      Client: f[campos.cliente] ?? null,
      "Descripció": f[campos.descripcion] || f[campos.descripcionAlt] || null,
      "Línia negoci": f[campos.lineaNegocio] ?? null,
      Departament: f[campos.departamento] ?? null,
      Estat: f[campos.estado] ?? null,
      "Estat App":
        f["Motivo_cancelación_PR"] ?? f["Motivo_cancelacion_PR"] ?? f["Motivo_de_cancelación_PR"] ?? null, // FACTURAT / PENDENT / PROCES...
      "Tipus feina": null,
      // Los importes llegan por líneas de venta/compra o por facturas:
      "P venta": 0,
      "P despessa": 0,
      "Ma obra": 0,
      NH: 0,
    }));
}

// ---------------------------------------------------------------------
// ADAPTADORES DE LÍNEAS (web services de BC → formato interno)
// ---------------------------------------------------------------------
// Nombres CONFIRMADOS con los JSON reales de los web services
// "Sales_Order_Line_Excel" (pág. 516) y "Purchase_Order_Line_Excel"
// (pág. 518):
//   · Nº de OT      → Shortcut_Dimension_2_Code ("AC014340/2026")
//   · Segmento      → Shortcut_Dimension_1_Code ("INS-I", "MAN-P"...)
//   · Tipo de línea → Type: Resource=mano de obra · Item=material ·
//                     G/L Account=cuenta (desplazamientos, etc.)
//   · Documento     → Document_No ("PV26-001765" / "PC26-001608") y
//                     Document_Type (Quote=oferta · Order=pedido)
// ---------------------------------------------------------------------
export const API_LINEA_CAMPOS = {
  venta: {
    numeroOT: "Shortcut_Dimension_2_Code",
    tipo: "Type",
    numero: "No",
    descripcion: "Description",
    cantidad: "Quantity",
    precioUnitario: "Unit_Price",
    importe: "Line_Amount",
    segmento: "Shortcut_Dimension_1_Code",
    numeroDocumento: "Document_No",
  },
  compra: {
    numeroOT: "Shortcut_Dimension_2_Code",
    numeroDocumento: "Document_No",
    tipoDocumento: "Document_Type", // Quote = oferta · Order = pedido
    numero: "No",
    descripcion: "Description",
    cantidad: "Quantity",
    costeUnitario: "Direct_Unit_Cost",
    importe: "Line_Amount",
    segmento: "Shortcut_Dimension_1_Code",
    // AÑADIDO: nombre del proveedor y fecha de pedido. Nombres de campo
    // BC "razonables" (Buy_from_Vendor_Name / Order_Date) — a confirmar
    // contra la página OData real (si no existen, quedan en null, no rompen nada).
    proveedor: "Buy_from_Vendor_Name",
    fechaPedido: "Order_Date",
  },
};

const TIPO_LINEA_API = {
  item: "Producto",
  resource: "Recurso",
  account: "Cuenta",
  "g/l account": "Cuenta",
  "charge (item)": "Cuenta", // cargos (portes, etc.)
};

export function adaptarLineasVentaAPI(filas, campos = API_LINEA_CAMPOS.venta) {
  return (filas || []).map((f) => {
    // DESCUENTOS: mismo criterio que en compra (Percent_Dto_linea_1/2/3
    // en vivas; Line_Discount* en registradas; patrón como respaldo).
    let dtos;
    if (f["Percent_Dto_linea_1"] !== undefined) {
      dtos = [Number(f["Percent_Dto_linea_1"]) || 0, Number(f["Percent_Dto_linea_2"]) || 0, Number(f["Percent_Dto_linea_3"]) || 0];
    } else if (f["Line_Discount_Percent"] !== undefined || f["Line_Discount_x0025"] !== undefined || f["Line_Discount"] !== undefined) {
      dtos = [Number(f["Line_Discount_Percent"] ?? f["Line_Discount_x0025"] ?? f["Line_Discount"]) || 0, 0, 0];
    } else {
      const clavesDto = Object.keys(f)
        .filter((k) => /dto|discount/i.test(k) && !/amount|importe/i.test(k))
        .sort();
      dtos = clavesDto.map((k) => Number(f[k]) || 0);
    }
    return {
      OT: f[campos.numeroOT] ?? null,
      Tipo: TIPO_LINEA_API[norm(f[campos.tipo])] ?? f[campos.tipo] ?? null,
      "Nº": f[campos.numero] ?? null,
      "Descripción": f[campos.descripcion] ?? null,
      Cantidad: f[campos.cantidad] ?? 0,
      "Precio unitario": f[campos.precioUnitario] ?? 0,
      "Importe línea": f[campos.importe] ?? 0,
      shortcut_Dimension_1_Code: f[campos.segmento] ?? null,
      "Nº documento": f[campos.numeroDocumento] ?? null,
      "Fecha pedido": f["Posting_Date"] ?? f["Shipment_Date"] ?? f["Order_Date"] ?? f["Document_Date"] ?? null,
      "% Dto. 1": dtos[0] ?? 0,
      "% Dto. 2": dtos[1] ?? 0,
      "% Dto. 3": dtos[2] ?? 0,
    };
  });
}

export function adaptarLineasCompraAPI(filas, campos = API_LINEA_CAMPOS.compra) {
  return (filas || []).map((f) => {
    // DESCUENTOS: nombres CONFIRMADOS en su BC según la fuente:
    //   · Líneas vivas:       Percent_Dto_linea_1/2/3
    //   · Registradas (hist): Line_Discount (variantes _Percent / _x0025)
    // Si no existiera ninguno, se busca por patrón como respaldo.
    let dtos;
    if (f["Percent_Dto_linea_1"] !== undefined) {
      dtos = [Number(f["Percent_Dto_linea_1"]) || 0, Number(f["Percent_Dto_linea_2"]) || 0, Number(f["Percent_Dto_linea_3"]) || 0];
    } else if (f["Line_Discount_Percent"] !== undefined || f["Line_Discount_x0025"] !== undefined || f["Line_Discount"] !== undefined) {
      dtos = [Number(f["Line_Discount_Percent"] ?? f["Line_Discount_x0025"] ?? f["Line_Discount"]) || 0, 0, 0];
    } else {
      const clavesDto = Object.keys(f)
        .filter((k) => /dto|discount/i.test(k) && !/amount|importe/i.test(k))
        .sort(); // orden estable: Dto_1, Dto_2, Dto_3
      dtos = clavesDto.map((k) => Number(f[k]) || 0);
    }
    return {
      OT: f[campos.numeroOT] ?? null,
      "Nº documento": f[campos.numeroDocumento] ?? null,
      "Tipo documento": f[campos.tipoDocumento] ?? null, // Quote / Order
      "Nº": f[campos.numero] ?? null,
      "Descripción": f[campos.descripcion] ?? null,
      Cantidad: f[campos.cantidad] ?? 0,
      "Coste unitario": f[campos.costeUnitario] ?? 0,
      "Importe línea": f[campos.importe] ?? 0,
      shortcut_Dimension_1_Code: f[campos.segmento] ?? null,
      // Mismos nombres de columna que en el Excel "Líns. compra", así el
      // resto del código (cC.proveedor / cC.fechaPedido) lee igual venga de donde venga.
      // Se aceptan varias variantes de nombre de campo BC: la que exista gana.
      "Nombre de proveedor de compra":
        f["Buy_from_Vendor_Name"] ?? f["Nombre_de_proveedor_de_compra"] ?? f["Nombre_proveedor_compra"] ?? f["Pay_to_Name"] ?? null,
      "Fecha pedido": f["Order_Date"] ?? f["Fecha_pedido"] ?? null,
      "% Dto. 1": dtos[0] ?? 0,
      "% Dto. 2": dtos[1] ?? 0,
      "% Dto. 3": dtos[2] ?? 0,
    };
  });
}

// ---------------------------------------------------------------------
// TARIFAS DE VENTA
// ---------------------------------------------------------------------
export const API_TARIFA_CAMPOS = {
  numero: "itemNo",
  descripcion: "description",
  precio: "unitPrice",
  fechaInicio: "startingDate",
  codigoVenta: "salesCode", // cliente/grupo al que aplica
};

/** Campos alternativos del web service OData (Sales Prices / Price List Lines) */
const WS_TARIFA_CAMPOS = {
  numero: ["Product_No", "Asset_No", "Item_No", "Item No.", "No"],
  descripcion: ["Description", "Descripción", "Product_Description"],
  precio: ["Unit_Price", "Unit Price", "unitPrice"],
  fechaInicio: ["StartingDate", "Starting_Date", "Starting Date", "startingDate"],
  codigoVenta: ["AssignToNo", "SourceNo", "Sales_Code", "Sales Code", "salesCode"],
};

function primerCampo(fila, claves) {
  for (const k of claves) {
    if (fila[k] != null && fila[k] !== "") return fila[k];
  }
  return null;
}

const PALABRAS_TARIFA_HORA = ["hora", "hores", "ma obra", "mà obra", "mano de obra", "oficial", "operari", "tecnic", "técnico"];

export function adaptarTarifasAPI(filas, campos = API_TARIFA_CAMPOS) {
  return (filas || []).map((f) => {
    const descripcion =
      f[campos.descripcion] ?? primerCampo(f, WS_TARIFA_CAMPOS.descripcion) ?? null;
    // Price List Line: Unit_Price; descuentos no sirven como tarifa horaria
    const precioRaw =
      f[campos.precio] ?? primerCampo(f, ["Unit_Price", "Unit Price", "unitPrice"]);
    return {
      numero: f[campos.numero] ?? primerCampo(f, WS_TARIFA_CAMPOS.numero) ?? null,
      descripcion,
      precio: Number(precioRaw) || 0,
      fechaInicio: f[campos.fechaInicio] ?? primerCampo(f, WS_TARIFA_CAMPOS.fechaInicio) ?? null,
      codigoVenta: f[campos.codigoVenta] ?? primerCampo(f, WS_TARIFA_CAMPOS.codigoVenta) ?? null,
      esManoObra: contieneAlguna(descripcion, PALABRAS_TARIFA_HORA),
    };
  });
}

/** Tarifa horaria sugerida a partir de las tarifas cargadas (mediana de las de mano de obra) */
export function tarifaHoraSugerida(tarifas) {
  const precios = (tarifas || []).filter((t) => t.esManoObra && t.precio > 0).map((t) => t.precio);
  if (precios.length === 0) return null;
  const v = [...precios].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------------------------------------------------------------------
// FACTURAS PDF (extraídas por el backend) → líneas de venta
// ---------------------------------------------------------------------
/** Convierte las facturas extraídas de PDF al formato de líneas de
 *  venta interno. Cada línea lleva su OT (la del parte, o la de la
 *  cabecera de la factura como respaldo). */
export function adaptarFacturasPDF(facturas) {
  const filas = [];
  for (const f of facturas || []) {
    for (const l of f.lineas || []) {
      filas.push({
        OT: l.ot || f.numObra || null,
        Tipo: (l.codigo || "").startsWith("PR") ? "Producto" : null,
        "Nº": l.codigo ?? null,
        "Descripción": l.descripcion ?? null,
        Cantidad: l.cantidad ?? 0,
        "Precio unitario": l.precio ?? 0,
        "Importe línea": l.importe ?? 0,
      });
    }
  }
  return filas;
}

/** Descripciones de los partes de trabajo por OT normalizada — suelen
 *  describir el trabajo real mejor que la descripción de la propia OT. */
export function descripcionesDeFacturasPDF(facturas) {
  const porOT = new Map();
  for (const f of facturas || []) {
    for (const p of f.partes || []) {
      const clave = normalizarNumeroOT(p.ot || f.numObra);
      if (!clave) continue;
      if (!porOT.has(clave)) porOT.set(clave, new Set());
      porOT.get(clave).add(p.descripcion);
    }
  }
  return new Map([...porOT.entries()].map(([k, v]) => [k, [...v]]));
}

// ---------------------------------------------------------------------
// FAMILIAS DE MATERIAL (nivel genérico sobre el artículo exacto)
// ---------------------------------------------------------------------
// Orden IMPORTANTE: de más específica a más genérica — "Unión Gibault
// tubo PVC" debe caer en Unión/racor, no en Tubo.
const FAMILIAS_MATERIAL = [
  ["Unión / racor", ["union", "unión", "gibault", "racor", "enlace"]],
  ["Codo", ["codo"]],
  ["Manguito", ["manguito"]],
  ["Válvula", ["valvula", "válvula", "llave de paso"]],
  ["Ventosa", ["ventosa"]],
  ["Adhesivo / cola", ["bote cola", "adhesiv", "teflon", "teflón", "sellador", "silicona"]],
  ["Protección eléctrica", ["magnetotermico", "magnetotérmico", "diferencial", "fusible"]],
  ["Contactor / relé", ["contactor", "rele", "relé"]],
  ["Bomba", ["bomba"]],
  ["Motor", ["motor"]],
  ["Luminaria / lámpara", ["luminaria", "lampara", "lámpara", "led", "pantalla"]],
  ["Filtro", ["filtro"]],
  ["Termostato / sonda", ["termostato", "sonda"]],
  ["Cable", ["cable", "manguera electrica"]],
  ["Pequeño material", ["pequeño material", "petit material", "tornilleria", "tornillería", "brida"]],
  ["Tubo", ["tubo", "tuberia", "tubería"]],
];

/** Devuelve la familia genérica de un material a partir de su descripción */
export function familiaDeMaterial(descripcion) {
  const d = norm(descripcion);
  if (!d) return "Otros";
  for (const [familia, palabras] of FAMILIAS_MATERIAL) {
    if (palabras.some((p) => d.includes(norm(p)))) return familia;
  }
  return "Otros";
}

// ---------------------------------------------------------------------
// MAPA DE CONOCIMIENTO — relaciones atributos ↔ artículos
// ---------------------------------------------------------------------
/** Organigrama del conocimiento del agente: agrupa las OTs por
 *  Oficio → Tipo de trabajo/Problema, y para cada grupo resume nº de
 *  OTs, horas e importes medianos y los materiales asociados (familia
 *  + artículos concretos). Devuelve también `ayuda`: lo que el agente
 *  NO sabe relacionar, con sugerencias para que el usuario pueda
 *  enseñárselo. */
export function mapaDeConocimiento(fichas) {
  const grupos = new Map(); // oficio → Map(trabajo → info)
  const ayuda = {
    sinAtributos: new Map(), // descripción → nº OTs (la IA no las clasificó)
    materialesSinFamilia: new Map(), // descripción material "Otros" → apariciones
    oficioDesconocido: new Map(), // descripciones con oficio vacío/Otro
    gruposSinMaterial: [], // combinaciones sin ningún material asociado
  };

  let totalConAtributos = 0;
  for (const f of fichas.values()) {
    const desc = f.general.descripcion;
    if (!desc) continue;

    if (!f.atributos) {
      ayuda.sinAtributos.set(desc, (ayuda.sinAtributos.get(desc) || 0) + 1);
      continue;
    }
    totalConAtributos++;

    const oficio = f.atributos.oficio || "(sin oficio)";
    const trabajo =
      [f.atributos.tipoTrabajo, f.atributos.problema].filter(Boolean).join(" · ") || "(sin tipo)";
    if (oficio === "(sin oficio)" || oficio === "Otro") {
      ayuda.oficioDesconocido.set(desc, (ayuda.oficioDesconocido.get(desc) || 0) + 1);
    }

    if (!grupos.has(oficio)) grupos.set(oficio, new Map());
    const porTrabajo = grupos.get(oficio);
    if (!porTrabajo.has(trabajo)) {
      porTrabajo.set(trabajo, {
        nOTs: 0,
        horas: [],
        importes: [],
        familias: new Map(), // familia → { ots:Set, articulos:Map(desc→count) }
        ejemplosDescripcion: new Map(),
      });
    }
    const g = porTrabajo.get(trabajo);
    g.nOTs++;
    g.ejemplosDescripcion.set(desc, (g.ejemplosDescripcion.get(desc) || 0) + 1);
    if (f.venta.horas.cantidad > 0) g.horas.push(f.venta.horas.cantidad);
    if (f.venta.importeTotalFacturado >= 30) g.importes.push(f.venta.importeTotalFacturado);

    const familiasDeEstaOT = new Set();
    for (const lin of f.venta.materiales.lineas) {
      const dLin = lin.descripcion ?? lin["Descripción"] ?? "";
      if (!dLin) continue;
      const fam = familiaDeMaterial(dLin);
      if (fam === "Otros") {
        ayuda.materialesSinFamilia.set(dLin, (ayuda.materialesSinFamilia.get(dLin) || 0) + 1);
      }
      familiasDeEstaOT.add(fam);
      if (!g.familias.has(fam)) g.familias.set(fam, { ots: new Set(), articulos: new Map() });
      const info = g.familias.get(fam);
      info.articulos.set(dLin, (info.articulos.get(dLin) || 0) + 1);
    }
    familiasDeEstaOT.forEach((fam) => g.familias.get(fam).ots.add(f.numeroOT));
  }

  // Serializar el árbol ordenado por tamaño
  const arbol = [...grupos.entries()]
    .map(([oficio, porTrabajo]) => {
      const trabajos = [...porTrabajo.entries()]
        .map(([trabajo, g]) => {
          const familias = [...g.familias.entries()]
            .map(([familia, info]) => ({
              familia,
              nOTs: info.ots.size,
              articulos: [...info.articulos.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([d, c]) => ({ descripcion: d, veces: c })),
            }))
            .sort((a, b) => b.nOTs - a.nOTs)
            .slice(0, 10);
          const item = {
            trabajo,
            nOTs: g.nOTs,
            horasMediana: g.horas.length ? mediana(g.horas) : null,
            importeMediana: g.importes.length ? mediana(g.importes) : null,
            conImportes: g.importes.length,
            familias,
            ejemplo: [...g.ejemplosDescripcion.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "",
          };
          if (familias.length === 0 && g.nOTs >= 3) {
            ayuda.gruposSinMaterial.push({ oficio, trabajo, nOTs: g.nOTs });
          }
          return item;
        })
        .sort((a, b) => b.nOTs - a.nOTs);
      return {
        oficio,
        nOTs: trabajos.reduce((a, t) => a + t.nOTs, 0),
        trabajos,
      };
    })
    .sort((a, b) => b.nOTs - a.nOTs);

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([texto, veces]) => ({ texto, veces }));

  return {
    totalConAtributos,
    arbol,
    ayuda: {
      sinAtributos: top(ayuda.sinAtributos, 10),
      nSinAtributos: [...ayuda.sinAtributos.values()].reduce((a, b) => a + b, 0),
      materialesSinFamilia: top(ayuda.materialesSinFamilia, 12),
      oficioDesconocido: top(ayuda.oficioDesconocido, 8),
      gruposSinMaterial: ayuda.gruposSinMaterial.sort((a, b) => b.nOTs - a.nOTs).slice(0, 8),
    },
  };
}

// ---------------------------------------------------------------------
// MATERIAL PROPUESTO PARA UNA OT CONCRETA
// ---------------------------------------------------------------------
// Las líneas pueden venir en formato interno de ficha ({numero,
// descripcion, cantidad...}) o crudo de adaptador ({"Nº", "Descripción"...}).
// Este lector unifica ambos.
function leerLinea(lin) {
  return {
    codigo: (lin.numero ?? lin["Nº"] ?? "").toString().trim(),
    descripcion: lin.descripcion ?? lin["Descripción"] ?? "",
    cantidad: Number(lin.cantidad ?? lin["Cantidad"]) || 0,
    precio: Number(lin.precioUnitario ?? lin["Precio unitario"] ?? lin["Coste unitario"]) || 0,
    importe: Number(lin.importe ?? lin["Importe línea"]) || 0,
  };
}

/** Calcula la lista de OTs similares a una ficha dada, con el mismo
 *  criterio (texto de descripción + atributos IA + tipo de trabajo +
 *  tipo de cliente) que usa materialPropuestoParaOT. Se extrae aparte
 *  para poder reutilizar la MISMA noción de "OTs parecidas" desde otras
 *  funciones (p.ej. para proponer material visto solo en compras) sin
 *  duplicar la lógica de similitud ni cambiar su comportamiento. */
export function otsSimilaresPara(
  ficha,
  fichasHistoricas,
  { minimoSimilitud = 0.35, maxSimilares = 30, importeMinimoReferencia = 30 } = {}
) {
  const descripcion = ficha.general.descripcion || "";
  if (!descripcion) return [];
  return [...fichasHistoricas.values()]
    .filter((f) => f.numeroOT !== ficha.numeroOT)
    .filter((f) => f.venta.importeTotalFacturado >= importeMinimoReferencia || f.venta.materiales.lineas.length > 0)
    .map((f) => {
      const sTexto = Math.max(
        similitudTexto(descripcion, f.general.descripcion),
        similitudTexto(descripcion, f.general.tipoTrabajo)
      );
      const sAtrib = ficha.atributos && f.atributos ? similitudAtributos(ficha.atributos, f.atributos) : 0;
      const sTipus = similitudTexto(descripcion, f.general.tipoTrabajo);
      let similitud = 0.45 * sTexto + 0.35 * sAtrib + 0.2 * sTipus;
      if (ficha.general.tipoCliente && f.general.tipoCliente) {
        similitud += f.general.tipoCliente === ficha.general.tipoCliente ? 0.1 : -0.15;
      }
      return { ficha: f, similitud: Math.max(0, Math.min(1, similitud)) };
    })
    .filter((c) => c.similitud >= minimoSimilitud)
    .sort((a, b) => b.similitud - a.similitud)
    .slice(0, maxSimilares);
}

/** A partir de una ficha de OT (con sus atributos ya calculados),
 *  busca OTs similares en la memoria y propone el material a nivel de
 *  ARTÍCULO: referencia, descripción, % de OTs similares que lo usaron,
 *  unidades propuestas (MEDIANA de las cantidades usadas) y precio
 *  mediano de venta. */
export function materialPropuestoParaOT(
  ficha,
  fichasHistoricas,
  opts = {}
) {
  const descripcion = ficha.general.descripcion || "";
  if (!descripcion) return { error: "La OT no tiene descripción: no se puede buscar material similar." };

  const candidatas = otsSimilaresPara(ficha, fichasHistoricas, opts);

  const conMaterial = candidatas.filter((c) => c.ficha.venta.materiales.lineas.length > 0);
  if (conMaterial.length === 0) {
    return { similares: candidatas.length, baseOTs: 0, articulos: [] };
  }

  // Agregar por artículo (referencia); si no hay código, por descripción
  const porArticulo = new Map();
  for (const c of conMaterial) {
    const cantidadesEstaOT = new Map(); // clave → uds sumadas en esta OT
    for (const lin of c.ficha.venta.materiales.lineas) {
      const { codigo, descripcion: desc, cantidad, precio } = leerLinea(lin);
      const clave = codigo || norm(desc);
      if (!clave) continue;
      if (!porArticulo.has(clave)) {
        porArticulo.set(clave, { codigo: codigo || null, descripciones: new Map(), ots: new Set(), cantidadesPorOT: [], precios: [] });
      }
      const art = porArticulo.get(clave);
      art.descripciones.set(desc, (art.descripciones.get(desc) || 0) + 1);
      if (precio > 0) art.precios.push(precio);
      cantidadesEstaOT.set(clave, (cantidadesEstaOT.get(clave) || 0) + cantidad);
    }
    for (const [clave, uds] of cantidadesEstaOT) {
      const art = porArticulo.get(clave);
      art.ots.add(c.ficha.numeroOT);
      if (uds > 0) art.cantidadesPorOT.push(uds);
    }
  }

  const articulos = [...porArticulo.values()]
    .map((a) => {
      const descripcion = [...a.descripciones.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || "";
      return {
        codigo: a.codigo,
        descripcion,
        familia: familiaDeMaterial(descripcion),
        pct: a.ots.size / conMaterial.length,
        nOTs: a.ots.size,
        unidadesPropuestas: Math.round(mediana(a.cantidadesPorOT) * 100) / 100 || 1,
        precioMediano: Math.round(mediana(a.precios) * 100) / 100,
      };
    })
    .filter((a) => a.nOTs >= 2 || conMaterial.length <= 3)
    .sort((x, y) => y.pct - x.pct)
    .slice(0, 15);

  return { similares: candidatas.length, baseOTs: conMaterial.length, articulos };
}

// ---------------------------------------------------------------------
// HISTORIAL DE UN ARTÍCULO (compra / venta) EN TODA LA MEMORIA
// ---------------------------------------------------------------------
const normArt = (s) => (s ?? "").toString().trim().toLowerCase();
const claveArticulo = (codigo, descripcion) => (codigo || "").toString().trim() || normArt(descripcion);

/** Aproxima el orden cronológico de dos OTs por su número/año, para
 *  cuando no hay fecha real disponible. Formato esperado: "AC014663/2026".
 *  Devuelve negativo si `a` es más reciente que `b`. */
function compararRecienciaOT(a, b) {
  const parse = (s) => {
    const m = /(\d+)\s*\/\s*(\d{2,4})\s*$/.exec(s || "");
    if (!m) return [0, 0];
    let anyo = parseInt(m[2], 10);
    if (anyo < 100) anyo += 2000;
    return [anyo, parseInt(m[1], 10)];
  };
  const [ay, an] = parse(a);
  const [by, bn] = parse(b);
  if (ay !== by) return by - ay;
  return bn - an;
}

const aFecha = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/** Ordena filas de más reciente a más antigua: usa la fecha real de
 *  pedido si existe en la línea; si no, aproxima por el número de OT. */
function ordenarPorReciencia(filas) {
  return [...filas].sort((a, b) => {
    const fa = aFecha(a.fechaPedido);
    const fb = aFecha(b.fechaPedido);
    if (fa && fb) return fb - fa;
    if (fa && !fb) return -1; // la que tiene fecha real gana
    if (!fa && fb) return 1;
    return compararRecienciaOT(a.ot, b.ot);
  });
}

/** Historial de COMPRA de un artículo (código, o descripción si no hay
 *  código) en TODAS las OTs de la memoria. Incluye compras reales (PC)
 *  y también ofertas (OC), marcando el origen de cada línea.
 *  opts.aliases: códigos equivalentes Also↔Ferros.
 *  opts.indicesExtra: [{ compra: { COD: [filas] } }, ...] de otras empresas. */
export function historialCompraArticulo(codigo, descripcionFallback, fichasHistoricas, opts = {}) {
  const aliases = (opts.aliases || []).map((c) => String(c || "").trim()).filter(Boolean);
  const claves = new Set(
    [claveArticulo(codigo, descripcionFallback), ...aliases.map((a) => claveArticulo(a, ""))].filter(Boolean)
  );
  const metaMapeo = opts.metaMapeo || null;
  const etiquetaFn = opts.etiquetaEmpresa || null;
  const filas = [];
  const pushFila = (base) => {
    const codLin = String(base.codigoLinea || base.numero || codigo || "").trim();
    filas.push({
      ...base,
      codigoLinea: codLin,
      empresa:
        base.empresa ||
        (etiquetaFn ? etiquetaFn(codLin, metaMapeo, base.ot) : "") ||
        "",
    });
  };

  if (fichasHistoricas) {
    for (const f of fichasHistoricas.values()) {
      const reales = (f.compra?.comprasReales?.lineas || []).map((l) => ({ ...l, origen: "PC · compra real" }));
      const ofertas = (f.compra?.soloOfertas?.lineas || []).map((l) => ({ ...l, origen: "OC · oferta" }));
      for (const l of [...reales, ...ofertas]) {
        const k = claveArticulo(l.numero, l.descripcion);
        if (!claves.has(k)) continue;
        pushFila({
          ot: f.numeroOT,
          proveedor: l.proveedor || "",
          origen: l.origen,
          numeroDocumento: l.numeroDocumento || null,
          descripcion: l.descripcion || "",
          cantidad: Number(l.cantidad) || 0,
          costeUnitario: Number(l.costeUnitario) || 0,
          importe: Number(l.importe) || 0,
          fechaPedido: l.fechaPedido || null,
          dtos: Array.isArray(l.dtos) ? l.dtos : [0, 0, 0],
          codigoLinea: String(l.numero || "").trim(),
        });
      }
    }
  }

  for (const ind of opts.indicesExtra || []) {
    if (!ind?.compra) continue;
    for (const cod of claves) {
      for (const l of ind.compra[cod] || []) {
        pushFila({ ...l, codigoLinea: l.codigoLinea || cod });
      }
    }
  }

  return ordenarPorReciencia(_dedupHistorial(filas));
}

/** Historial de VENTA de un artículo en TODAS les OTs de la memoria. */
export function historialVentaArticulo(codigo, descripcionFallback, fichasHistoricas, opts = {}) {
  const aliases = (opts.aliases || []).map((c) => String(c || "").trim()).filter(Boolean);
  const claves = new Set(
    [claveArticulo(codigo, descripcionFallback), ...aliases.map((a) => claveArticulo(a, ""))].filter(Boolean)
  );
  const metaMapeo = opts.metaMapeo || null;
  const etiquetaFn = opts.etiquetaEmpresa || null;
  const filas = [];
  const pushFila = (base) => {
    const codLin = String(base.codigoLinea || base.numero || codigo || "").trim();
    filas.push({
      ...base,
      codigoLinea: codLin,
      empresa:
        base.empresa ||
        (etiquetaFn ? etiquetaFn(codLin, metaMapeo, base.ot) : "") ||
        "",
    });
  };

  if (fichasHistoricas) {
    for (const f of fichasHistoricas.values()) {
      for (const l of f.venta?.materiales?.lineas || []) {
        const k = claveArticulo(l.numero, l.descripcion);
        if (!claves.has(k)) continue;
        pushFila({
          ot: f.numeroOT,
          cliente: f.general?.cliente || "",
          numeroDocumento: l.numeroDocumento || null,
          descripcion: l.descripcion || "",
          cantidad: Number(l.cantidad) || 0,
          precioUnitario: Number(l.precioUnitario) || 0,
          importe: Number(l.importe) || 0,
          fechaPedido: l.fechaPedido || null,
          dtos: Array.isArray(l.dtos) ? l.dtos : [0, 0, 0],
          codigoLinea: String(l.numero || "").trim(),
        });
      }
    }
  }

  for (const ind of opts.indicesExtra || []) {
    if (!ind?.venta) continue;
    for (const cod of claves) {
      for (const l of ind.venta[cod] || []) {
        pushFila({ ...l, codigoLinea: l.codigoLinea || cod });
      }
    }
  }

  return ordenarPorReciencia(_dedupHistorial(filas));
}

function _dedupHistorial(filas) {
  const seen = new Set();
  const out = [];
  for (const f of filas) {
    const k = [
      f.ot,
      f.numeroDocumento || "",
      f.codigoLinea || "",
      f.cantidad,
      f.importe,
      f.costeUnitario ?? f.precioUnitario ?? "",
      f.origen || "",
    ].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Precio de venta sugerido para un artículo, según la memoria:
 *   1) Si un precio se repite 3 veces o más entre las ventas históricas → ese precio (el más repetido).
 *   2) Si no, precio de la COMPRA MÁS RECIENTE de ese artículo × 1.75.
 *  "Más reciente" usa la fecha real de pedido cuando está disponible;
 *  si no, se aproxima por el número/año de la OT. */
export function precioVentaSugerido(codigo, descripcionFallback, fichasHistoricas, opts = {}) {
  const ventas = historialVentaArticulo(codigo, descripcionFallback, fichasHistoricas, opts);
  const conteo = new Map();
  for (const v of ventas) {
    if (v.precioUnitario > 0) {
      const key = Math.round(v.precioUnitario * 100) / 100;
      conteo.set(key, (conteo.get(key) || 0) + 1);
    }
  }
  let mejor = null;
  for (const [precio, n] of conteo) {
    if (n >= 3 && (!mejor || n > mejor.n)) mejor = { precio, n };
  }
  if (mejor) return { precio: mejor.precio, regla: `repetido (${mejor.n} veces en el histórico)` };

  const compras = historialCompraArticulo(codigo, descripcionFallback, fichasHistoricas, opts).filter((c) => c.costeUnitario > 0);
  if (compras.length > 0) {
    const masReciente = compras[0]; // ya viene ordenado por recencia
    const fecha = aFecha(masReciente.fechaPedido);
    const cuando = fecha ? fecha.toLocaleDateString("es-ES") : `OT ${masReciente.ot}`;
    const ref = masReciente.codigoLinea ? ` [${masReciente.codigoLinea}]` : "";
    return {
      precio: Math.round(masReciente.costeUnitario * 1.75 * 100) / 100,
      regla: `compra más reciente (${cuando}, ${masReciente.costeUnitario.toFixed(2)} €)${ref} × 1.75`,
    };
  }
  return { precio: null, regla: "sin histórico de venta ni compra suficiente" };
}

// ---------------------------------------------------------------------
// COMPARACIÓN COMPRADO ↔ VENDIDO DE UNA OT (control de margen, lógica 12)
// ---------------------------------------------------------------------
/** Compara el material COMPRADO (líneas de compra reales) con el
 *  material VENDIDO (líneas de venta tipo material) de una misma OT,
 *  emparejando por código de artículo (o descripción si no hay código).
 *  Estados: falta_cobrar (comprado sin vender), sin_coste (vendido sin
 *  compra — incluye material de almacén, marcado para revisar),
 *  cantidad_distinta, ok. */
export function compararMaterialOT(lineasVentaMaterial, lineasCompraReal) {
  const porClave = new Map();

  for (const lin of lineasVentaMaterial || []) {
    const { codigo, descripcion, cantidad, importe } = leerLinea(lin);
    const clave = codigo || norm(descripcion);
    if (!clave) continue;
    if (!porClave.has(clave)) porClave.set(clave, { codigo: codigo || null, descripcion, udsVendidas: 0, importeVenta: 0, udsCompradas: 0, costeCompra: 0 });
    const it = porClave.get(clave);
    it.udsVendidas += cantidad;
    it.importeVenta += importe;
  }
  for (const lin of lineasCompraReal || []) {
    const { codigo, descripcion, cantidad, importe } = leerLinea(lin);
    const clave = codigo || norm(descripcion);
    if (!clave) continue;
    if (!porClave.has(clave)) porClave.set(clave, { codigo: codigo || null, descripcion, udsVendidas: 0, importeVenta: 0, udsCompradas: 0, costeCompra: 0 });
    const it = porClave.get(clave);
    it.udsCompradas += cantidad;
    it.costeCompra += importe;
    if (!it.descripcion) it.descripcion = descripcion;
  }

  const items = [...porClave.values()].map((it) => {
    let estado;
    if (it.udsCompradas > 0 && it.udsVendidas === 0) estado = "falta_cobrar";
    else if (it.udsVendidas > 0 && it.udsCompradas === 0) estado = "sin_coste";
    else if (Math.abs(it.udsVendidas - it.udsCompradas) > 0.001) estado = "cantidad_distinta";
    else estado = "ok";
    return { ...it, estado, pareja: null };
  });

  // ---- DETECTOR DE CÓDIGOS DISTINTOS ----
  // En teoría se compra y se vende con el mismo código; en la práctica
  // puede diferir. Segundo pase: un "comprado sin vender" y un "vendido
  // sin comprar" de la MISMA familia y con descripción muy parecida
  // probablemente son el mismo artículo con códigos distintos.
  const comprados = items.filter((i) => i.estado === "falta_cobrar");
  const vendidos = items.filter((i) => i.estado === "sin_coste");
  for (const c of comprados) {
    if (c.pareja) continue;
    const famC = familiaDeMaterial(c.descripcion);
    let mejor = null;
    let mejorSim = 0;
    for (const v of vendidos) {
      if (v.pareja) continue;
      if (familiaDeMaterial(v.descripcion) !== famC) continue;
      const sim = Math.max(similitudTexto(c.descripcion, v.descripcion), similitudTexto(v.descripcion, c.descripcion));
      if (sim > mejorSim) {
        mejorSim = sim;
        mejor = v;
      }
    }
    // familia coincidente + texto suficientemente parecido (o familia
    // específica coincidente aunque el texto varíe algo más)
    const umbral = famC === "Otros" ? 0.6 : 0.45;
    if (mejor && mejorSim >= umbral) {
      c.estado = "codigo_distinto";
      mejor.estado = "codigo_distinto";
      c.pareja = { codigo: mejor.codigo, descripcion: mejor.descripcion };
      mejor.pareja = { codigo: c.codigo, descripcion: c.descripcion };
    }
  }

  const costeNoFacturado = items.filter((i) => i.estado === "falta_cobrar").reduce((a, i) => a + i.costeCompra, 0);
  const ventaSinCoste = items.filter((i) => i.estado === "sin_coste").reduce((a, i) => a + i.importeVenta, 0);
  const nCodigoDistinto = items.filter((i) => i.estado === "codigo_distinto").length / 2;

  return {
    items: items.sort((a, b) => {
      const orden = { falta_cobrar: 0, cantidad_distinta: 1, codigo_distinto: 2, sin_coste: 3, ok: 4 };
      return orden[a.estado] - orden[b.estado];
    }),
    costeNoFacturado,
    ventaSinCoste,
    nFaltaCobrar: items.filter((i) => i.estado === "falta_cobrar").length,
    nSinCoste: items.filter((i) => i.estado === "sin_coste").length,
    nCodigoDistinto,
  };
}

// ---------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------
const norm = (s) => (s ?? "").toString().trim().toLowerCase();

/**
 * NORMALIZACIÓN DEL Nº DE OT — pieza crítica de la unión.
 *
 * El mismo Nº de OT llega con formato distinto según el origen:
 *   · Business Central (líneas venta/compra): "AC009999/2099"
 *   · Excel del Listado de OT's:              "9999"
 *   · PDFs de facturas:                        "P009999"
 *
 * Todos deben acabar en la MISMA clave canónica: "9999".
 *
 * Regla: quitar el sufijo de año ("/20xx"), quedarse solo con los
 * dígitos (elimina prefijos AC0, P0...) y quitar ceros a la izquierda.
 */
export function normalizarNumeroOT(valor) {
  if (valor == null) return "";
  let s = valor.toString().trim().toUpperCase();
  if (!s) return "";
  s = s.split("/")[0]; // "AC009999/2099" → "AC009999"
  const digitos = s.replace(/\D/g, ""); // "AC009999" → "009999" · "P009999" → "009999"
  if (!digitos) return ""; // sin dígitos no hay OT identificable
  return digitos.replace(/^0+/, "") || "0"; // "009999" → "9999"
}

const num = (v) => {
  if (typeof v === "number") return v;
  if (v == null || v === "") return 0;
  // admite "1.234,56" y "1234.56"
  const cleaned = v.toString().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

const contieneAlguna = (texto, palabras) => {
  const t = norm(texto);
  return palabras.some((p) => t.includes(p));
};

// ---------------------------------------------------------------------
// LÓGICA 1 — FICHA ÚNICA POR OT
// ---------------------------------------------------------------------

/** Clasifica una línea de venta en: horas | desplazamiento | material | otro */
export function clasificarLineaVenta(linea, cfg = CONFIG) {
  const c = cfg.campos.venta;
  const r = cfg.clasificacionLineaVenta;
  const desc = linea[c.descripcion];
  const tipo = norm(linea[c.tipo]);

  if (contieneAlguna(desc, r.palabrasDesplazamiento)) return "desplazamiento";
  if (r.tiposManoObra.map(norm).includes(tipo)) return "horas";
  if (contieneAlguna(desc, r.palabrasHoras)) return "horas";
  if (tipo === "producto") return "material";
  return "otro";
}

/** Clasifica una línea de compra: por Tipo documento (Quote=oferta,
 *  Order/Invoice=compra real) si existe; si no, por el prefijo OC/PC. */
export function clasificarLineaCompra(linea, cfg = CONFIG) {
  const tipoDoc = norm(linea["Tipo documento"]);
  if (tipoDoc === "quote") return "solo_oferta";
  if (tipoDoc === "order" || tipoDoc === "invoice") return "compra_real";

  const doc = (linea[cfg.campos.compra.numeroDocumento] ?? "").toString().trim().toUpperCase();
  if (doc.startsWith(cfg.prefijos.pedido)) return "compra_real"; // PC → se compró
  if (doc.startsWith(cfg.prefijos.oferta)) return "solo_oferta"; // OC → solo oferta
  return "desconocido";
}

/**
 * Construye la ficha única de cada OT.
 *
 * @param {Array<Object>} listadoOTs      filas del/los Excels de OT's (ya combinados,
 *                                        con la regla "gana el archivo más reciente")
 * @param {Array<Object>} lineasVenta     filas de Líneas de Venta
 * @param {Array<Object>} lineasCompra    filas de Líneas de Compra
 * @returns {Map<string, Object>}         mapa Nº OT → ficha
 */
export function construirFichasOT(listadoOTs, lineasVenta, lineasCompra, movsCuentaVentas = [], cfg = CONFIG) {
  const kOT = cfg.campos.numeroOT;
  const cO = cfg.campos.ot;
  const cV = cfg.campos.venta;
  const cC = cfg.campos.compra;

  const fichas = new Map();

  // 1) Datos generales desde el Listado de OT's
  for (const fila of listadoOTs) {
    const id = normalizarNumeroOT(fila[kOT]);
    if (!id) continue;

    // El CSV de OTs ya trae importes agregados. Los guardamos como
    // "resumen de la propia OT" — sirven aunque no haya líneas detalladas.
    const pVenta = num(fila[cO.pVenta]);
    const maObra = num(fila[cO.maObra]);
    const nHoras = num(fila[cO.numeroHoras]);

    // Segmento: la línea de negocio de la propia OT (tabla Job) es la
    // fuente autoritativa. Si no viene, se deduce con la heurística.
    const segJob = parsearSegmento(fila[cO.lineaNegocio]);
    const tipoClienteFila = segJob?.tipo ?? derivarTipoCliente(fila, cfg);
    const segmentoFila = segJob?.codigo ?? derivarSegmento(fila, cfg);

    fichas.set(id, {
      numeroOT: id, // clave canónica (ej. "9999")
      numeroOTOrigenes: { listadoOTs: fila[kOT] }, // formatos originales por fuente
      general: {
        cliente: fila[cO.cliente] ?? null,
        tipoTrabajo: fila[cO.tipoTrabajo] ?? null,
        departamento: fila[cO.departamento] ?? null,
        descripcion: fila[cO.descripcion] ?? null,
        unidadNegocio: fila[cO.unidadNegocio] ?? null,
        tipoCliente: tipoClienteFila, // P / I / A
        segmento: segmentoFila, // ej. "INS-I"
        estado: fila["Estat"] ?? null, // Open / Planning (de la tabla Job)
        estadoApp: fila["Estat App"] ?? null, // FACTURAT / PENDENT / PROCES... (Motivo_cancelación_PR)
      },
      // Resumen tal cual viene del CSV (nivel OT, no de línea)
      resumenOT: {
        pVenta,
        pDespesa: num(fila[cO.pDespesa]),
        beneficioNet: num(fila[cO.beneficioNet]),
        maObra,
        numeroHoras: nHoras,
      },
      venta: {
        horas: { cantidad: nHoras, importe: maObra, lineas: [] },
        desplazamiento: { importe: 0, lineas: [], seCobro: false },
        materiales: { importe: Math.max(0, pVenta - maObra), lineas: [] },
        otros: { importe: 0, lineas: [] },
        conceptos: [],
        importeTotalFacturado: pVenta,
      },
      compra: {
        comprasReales: { importe: num(fila[cO.pDespesa]), lineas: [] }, // PC
        soloOfertas: { importe: 0, lineas: [] }, // OC
        costeRealOT: num(fila[cO.pDespesa]), // coste según el CSV
        materialCompradoNoFacturado: [],
      },
      resultado: {
        margenAbsoluto: pVenta - num(fila[cO.pDespesa]),
        margenPorcentual: pVenta > 0 ? (pVenta - num(fila[cO.pDespesa])) / pVenta : null,
      },
      atributos: null, // ← lo rellena la LÓGICA 2
      avisos: [],
    });
  }

  // 2) Líneas de venta → qué se le facturó al cliente
  for (const linea of lineasVenta) {
    const id = normalizarNumeroOT(linea[kOT]);
    if (!id) continue;
    let ficha = fichas.get(id);
    if (!ficha) {
      // Hay venta pero la OT no está en el listado descriptivo: la creamos igualmente
      ficha = crearFichaHuerfana(id);
      ficha.avisos.push("OT con líneas de venta pero sin fila en el Listado de OT's (sin descripción).");
      fichas.set(id, ficha);
    }
    if (!ficha.numeroOTOrigenes.lineasVenta) ficha.numeroOTOrigenes.lineasVenta = linea[kOT];

    // Si la ficha venía inicializada con los TOTALES agregados del CSV,
    // al llegar líneas reales de venta esas líneas MANDAN: reseteamos la
    // parte de venta para no sumar dos veces (total CSV + líneas).
    if (!ficha._ventaDesdeLineas) {
      ficha._ventaDesdeLineas = true;
      ficha.venta = {
        horas: { cantidad: 0, importe: 0, lineas: [] },
        desplazamiento: { importe: 0, lineas: [], seCobro: false },
        materiales: { importe: 0, lineas: [] },
        otros: { importe: 0, lineas: [] },
        conceptos: [],
        importeTotalFacturado: 0,
      };
    }

    // Segmento desde la dimensión de BC (fuente autoritativa: pisa la heurística)
    const segLinea = parsearSegmento(linea[cV.segmento]);
    if (segLinea) {
      ficha.general.segmento = segLinea.codigo;
      ficha.general.segmentoDeVenta = true; // prioridad sobre el de compra
      if (segLinea.tipo) ficha.general.tipoCliente = segLinea.tipo;
    }

    const clase = clasificarLineaVenta(linea, cfg);
    const importe = num(linea[cV.importe]);
    const cantidad = num(linea[cV.cantidad]);
    const resumen = {
      numero: linea[cV.numero] ?? null,
      descripcion: linea[cV.descripcion] ?? null,
      cantidad,
      precioUnitario: num(linea[cV.precioUnitario]),
      importe,
      numeroDocumento: linea[cV.numeroDocumento] ?? null,
      fechaPedido: linea[cV.fechaPedido] ?? null,
      dtos: [num(linea[cV.dto1]), num(linea[cV.dto2]), num(linea[cV.dto3])],
    };

    if (clase === "horas") {
      ficha.venta.horas.cantidad += cantidad;
      ficha.venta.horas.importe += importe;
      ficha.venta.horas.lineas.push(resumen);
    } else if (clase === "desplazamiento") {
      ficha.venta.desplazamiento.importe += importe;
      ficha.venta.desplazamiento.seCobro = true;
      ficha.venta.desplazamiento.lineas.push(resumen);
    } else if (clase === "material") {
      ficha.venta.materiales.importe += importe;
      ficha.venta.materiales.lineas.push(resumen);
    } else {
      ficha.venta.otros.importe += importe;
      ficha.venta.otros.lineas.push(resumen);
    }

    ficha.venta.importeTotalFacturado += importe;
    const concepto = (linea[cV.descripcion] ?? "").toString().trim();
    if (concepto && !ficha.venta.conceptos.includes(concepto)) {
      ficha.venta.conceptos.push(concepto);
    }
  }

  // 3) Líneas de compra → coste real de la OT (OC = oferta, PC = compra)
  for (const linea of lineasCompra) {
    const id = normalizarNumeroOT(linea[kOT]);
    if (!id) continue;
    let ficha = fichas.get(id);
    if (!ficha) {
      ficha = crearFichaHuerfana(id);
      ficha.avisos.push("OT con líneas de compra pero sin fila en el Listado de OT's (sin descripción).");
      fichas.set(id, ficha);
    }
    if (!ficha.numeroOTOrigenes.lineasCompra) ficha.numeroOTOrigenes.lineasCompra = linea[kOT];

    // Igual que en venta: las líneas reales de compra mandan sobre el
    // total agregado del CSV.
    if (!ficha._compraDesdeLineas) {
      ficha._compraDesdeLineas = true;
      ficha.compra = {
        comprasReales: { importe: 0, lineas: [] },
        soloOfertas: { importe: 0, lineas: [] },
        costeRealOT: 0,
        materialCompradoNoFacturado: [],
      };
    }

    // Segmento desde la dimensión de BC. Las líneas de VENTA tienen
    // prioridad; la de compra solo rellena si aún no hay segmento de venta.
    if (!ficha.general.segmentoDeVenta) {
      const segLinea = parsearSegmento(linea[cC.segmento]);
      if (segLinea) {
        ficha.general.segmento = segLinea.codigo;
        if (segLinea.tipo) ficha.general.tipoCliente = segLinea.tipo;
      }
    }

    const clase = clasificarLineaCompra(linea, cfg);
    const importe = num(linea[cC.importe]);
    const resumen = {
      numeroDocumento: linea[cC.numeroDocumento] ?? null,
      numero: linea[cC.numero] ?? null,
      descripcion: linea[cC.descripcion] ?? null,
      cantidad: num(linea[cC.cantidad]),
      costeUnitario: num(linea[cC.costeUnitario]),
      importe,
      proveedor: linea[cC.proveedor] ?? null,
      fechaPedido: linea[cC.fechaPedido] ?? null,
      dtos: [num(linea[cC.dto1]), num(linea[cC.dto2]), num(linea[cC.dto3])],
    };

    if (clase === "compra_real") {
      ficha.compra.comprasReales.importe += importe;
      ficha.compra.comprasReales.lineas.push(resumen);
      ficha.compra.costeRealOT += importe;
    } else if (clase === "solo_oferta") {
      ficha.compra.soloOfertas.importe += importe;
      ficha.compra.soloOfertas.lineas.push(resumen);
    } else {
      ficha.avisos.push(
        `Línea de compra con Nº documento no reconocido (ni OC ni PC): "${resumen.numeroDocumento}"`
      );
    }
  }

  // 3.5) Ingresos por OT desde movs_contabilidad_excel.
  // Dos formas admitidas (misma fuente en la UI):
  //   a) Job Ledger (pág. 1004): Entry_Type = Sale → Line_Amount_LCY + Job_No
  //   b) Movs. contabilidad Excel: cuenta 70000000 + Amount + Job_No/OT
  // Los importes de cuenta de ingresos llegan en negativo (debe−haber),
  // así que se acumulan en valor absoluto. Line_Amount_LCY de Job Ledger
  // ya viene como importe de venta.
  const CUENTA_VENTAS_OT = "70000000";
  for (const linea of movsCuentaVentas) {
    const id = normalizarNumeroOT(
      linea["Job_No"] ?? linea["Job No."] ?? linea["Cód. OT"] ?? linea[kOT]
    );
    if (!id) continue;

    const cuenta = (linea["G_L_Account_No"] ?? linea["Nº cuenta"] ?? "").toString().trim();
    const entryType = (linea["Entry_Type"] ?? linea["Entry Type"] ?? "").toString().trim().toLowerCase();
    const esVentaJob =
      entryType === "sale" ||
      entryType === "venta" ||
      // Algunas publicaciones OData usan el valor numérico del enum (1 = Sale)
      entryType === "1";
    const esCuentaVentas = cuenta === CUENTA_VENTAS_OT;

    if (!esVentaJob && !esCuentaVentas) continue;

    let ficha = fichas.get(id);
    if (!ficha) {
      ficha = crearFichaHuerfana(id);
      ficha.avisos.push(
        esVentaJob
          ? "OT con movimiento Job Ledger (venta) pero sin fila en el Listado de OT's (sin descripción)."
          : "OT con apunte de cuenta 70000000 pero sin fila en el Listado de OT's (sin descripción)."
      );
      fichas.set(id, ficha);
    }
    if (ficha.venta.importeCuentaVentas == null) ficha.venta.importeCuentaVentas = 0;
    const importe = Math.abs(
      num(
        linea["Line_Amount_LCY"] ??
          linea["Line Amount (LCY)"] ??
          linea["Amount"] ??
          linea["Importe"] ??
          linea["Importe (DL)"]
      )
    );
    ficha.venta.importeCuentaVentas += importe;
  }

  // 4) Post-proceso por ficha: margen y material comprado no facturado
  for (const ficha of fichas.values()) {
    if (ficha.venta.importeCuentaVentas == null) ficha.venta.importeCuentaVentas = 0;
    const facturado = ficha.venta.importeTotalFacturado;
    const coste = ficha.compra.costeRealOT;

    ficha.resultado.margenAbsoluto = facturado - coste;
    ficha.resultado.margenPorcentual = facturado > 0 ? (facturado - coste) / facturado : null;

    // Material comprado (PC) cuya descripción no aparece en ninguna línea de venta.
    // Comparación aproximada por texto: es una PISTA, no una certeza contable.
    const descsVenta = ficha.venta.materiales.lineas.map((l) => norm(l.descripcion));
    for (const compra of ficha.compra.comprasReales.lineas) {
      const d = norm(compra.descripcion);
      if (!d) continue;
      const aparece = descsVenta.some((v) => v.includes(d) || d.includes(v));
      if (!aparece) ficha.compra.materialCompradoNoFacturado.push(compra);
    }
    if (ficha.compra.materialCompradoNoFacturado.length > 0) {
      ficha.avisos.push(
        `${ficha.compra.materialCompradoNoFacturado.length} línea(s) de material comprado que no se localizan en la facturación (revisar).`
      );
    }
  }

  return fichas;
}

function crearFichaHuerfana(numeroOT) {
  return {
    numeroOT,
    numeroOTOrigenes: {},
    general: { cliente: null, tipoTrabajo: null, departamento: null, descripcion: null, unidadNegocio: null },
    venta: {
      horas: { cantidad: 0, importe: 0, lineas: [] },
      desplazamiento: { importe: 0, lineas: [], seCobro: false },
      materiales: { importe: 0, lineas: [] },
      otros: { importe: 0, lineas: [] },
      conceptos: [],
      importeTotalFacturado: 0,
    },
    compra: {
      comprasReales: { importe: 0, lineas: [] },
      soloOfertas: { importe: 0, lineas: [] },
      costeRealOT: 0,
      materialCompradoNoFacturado: [],
    },
    resultado: { margenAbsoluto: null, margenPorcentual: null },
    atributos: null,
    avisos: [],
  };
}

// ---------------------------------------------------------------------
// LÓGICA 2 — ENTENDER LA DESCRIPCIÓN (la más importante)
// ---------------------------------------------------------------------
// La descripción libre ("Reparar fuga en tubería de agua", "Avería
// tubería nave", "Pérdida de agua en instalación"...) se convierte en
// atributos estructurados usando la API de Claude. Un diccionario de
// palabras clave NO basta aquí: la gracia es que frases distintas con
// el mismo significado acaben en los MISMOS atributos.
// ---------------------------------------------------------------------

const ATRIBUTOS_SCHEMA = `{
  "tipoTrabajo": "Reparación | Instalación | Mantenimiento | Sustitución | Revisión | Fabricación | Otro",
  "oficio": "Fontanería | Electricidad | Climatización | Cerrajería | Albañilería | Mecánica | Soldadura | Otro",
  "problema": "texto corto, ej: Fuga | Avería | Desgaste | Obra nueva | null si no aplica",
  "instalacionAfectada": "texto corto, ej: Tubería de agua | Cuadro eléctrico | null si no se deduce",
  "materialProbable": ["lista", "de", "materiales", "probables"],
  "departamentoSugerido": "texto corto o null",
  "confianza": "alta | media | baja"
}`;

/**
 * DESTINO DE LA LLAMADA A LA IA — cambiar aquí al pasar a producción.
 *
 *  · "artifact":   llama directo a api.anthropic.com. Solo funciona
 *                  dentro de Claude.ai (la autenticación es automática).
 *  · "produccion": llama a VUESTRO backend (/api/clasificar), que es
 *                  quien guarda la clave API. Es el modo correcto para
 *                  la aplicación interna desplegada en vuestro servidor.
 */
export const IA_CONFIG = {
  modo: "demo", // "demo" (local, sin IA) · "artifact" (Claude.ai) · "produccion" (backend propio)
  urlBackend: "/api/clasificar",
};

/**
 * Clasificador LOCAL por palabras clave — solo para el modo "demo".
 * Permite ver el flujo funcionando en local sin backend ni clave API.
 * NO sustituye a la IA: es una aproximación tosca para la demostración.
 */
function clasificarLocalDemo(descripcion) {
  const t = (descripcion || "").toLowerCase();
  const tiene = (...ws) => ws.some((w) => t.includes(w));

  let oficio = "Otro";
  if (tiene("fuga", "agua", "tubería", "tuberia", "fontaner", "riego", "grifo", "desagüe")) oficio = "Fontanería";
  else if (tiene("eléctric", "electric", "cuadro", "magnetotérmic", "cable", "enchufe", "luz")) oficio = "Electricidad";
  else if (tiene("climatiz", "aire", "frío", "calor", "split", "filtro", "ventil")) oficio = "Climatización";
  else if (tiene("puerta", "cerradura", "cerrajer", "candado")) oficio = "Cerrajería";
  else if (tiene("soldadura", "soldar")) oficio = "Soldadura";

  let tipoTrabajo = "Otro";
  if (tiene("reparar", "reparación", "avería", "averia", "arreglar", "sanear", "fuga", "pérdida", "perdida")) tipoTrabajo = "Reparación";
  else if (tiene("instalar", "instalación", "instalacion", "montaje", "montar", "nueva")) tipoTrabajo = "Instalación";
  else if (tiene("revisión", "revision", "mantenimiento", "limpieza", "revisar")) tipoTrabajo = "Mantenimiento";
  else if (tiene("sustituir", "sustitución", "cambiar", "reemplazar")) tipoTrabajo = "Sustitución";

  let problema = null;
  if (tiene("fuga", "pérdida", "perdida", "agua")) problema = "Fuga";
  else if (tiene("avería", "averia")) problema = "Avería";
  else if (tiene("nueva", "montaje", "instalación", "instalacion")) problema = "Obra nueva";

  let instalacionAfectada = null;
  if (tiene("tubería", "tuberia")) instalacionAfectada = "Tubería de agua";
  else if (tiene("cuadro")) instalacionAfectada = "Cuadro eléctrico";
  else if (tiene("climatiz", "aire")) instalacionAfectada = "Climatización";
  else if (tiene("riego")) instalacionAfectada = "Instalación de riego";

  const materialProbable = [];
  if (oficio === "Fontanería") materialProbable.push("tubo", "racores");
  if (oficio === "Electricidad") materialProbable.push("cable", "magnetotérmicos", "cuadro");
  if (oficio === "Climatización") materialProbable.push("filtros");

  return { tipoTrabajo, oficio, problema, instalacionAfectada, materialProbable, departamentoSugerido: null, confianza: "baja" };
}

/**
 * Extrae atributos de UNA descripción llamando a la API de Claude.
 * Devuelve el objeto de atributos o null si falla.
 */
export async function extraerAtributos(descripcion, contexto = {}) {
  if (!descripcion || !descripcion.toString().trim()) return null;

  // Modo demo: clasificación local instantánea, sin llamar a ninguna API.
  if (IA_CONFIG.modo === "demo") {
    return clasificarLocalDemo(descripcion);
  }

  const prompt = `Eres un clasificador de órdenes de trabajo (OTs) de una empresa industrial de mantenimiento e instalaciones.

Convierte esta descripción de OT en atributos estructurados. Descripciones escritas de forma distinta pero con el mismo significado deben producir los MISMOS atributos (usa siempre los valores canónicos de la lista, no sinónimos).

Descripción: "${descripcion}"
${contexto.tipoTrabajo ? `Tipo de trabajo según el ERP: "${contexto.tipoTrabajo}"` : ""}
${contexto.departamento ? `Departamento según el ERP: "${contexto.departamento}"` : ""}

Responde SOLO con un JSON válido con esta estructura exacta, sin markdown ni explicaciones:
${ATRIBUTOS_SCHEMA}`;

  try {
    let texto;

    if (IA_CONFIG.modo === "produccion") {
      // Producción: la clave API vive en VUESTRO backend, nunca en el navegador.
      const response = await fetch(IA_CONFIG.urlBackend, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json();
      texto = data.texto;
    } else {
      // Artifact (Claude.ai): llamada directa, autenticación automática.
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await response.json();
      texto = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    return JSON.parse(texto.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("extraerAtributos: error clasificando descripción", descripcion, err);
    return null;
  }
}

/**
 * Enriquece TODAS las fichas con atributos, en lotes para no saturar
 * la API. Cachea por descripción normalizada: dos OTs con exactamente
 * la misma descripción solo generan UNA llamada.
 *
 * `cacheInicial`: diccionario {descripciónNormalizada: atributos} con
 * resultados de sesiones anteriores (persistidos en el backend). Lo que
 * ya esté ahí NO se vuelve a clasificar.
 *
 * Devuelve { fichas, nuevos, desdeCache, clasificadas } — `nuevos` es
 * el diccionario de atributos calculados en ESTA sesión, listo para
 * enviarse al backend y persistirse.
 */
export async function enriquecerFichasConAtributos(
  fichas,
  { tamanoLote = 5, onProgreso, cacheInicial = null, onPersistir = null, guardarCada = 200 } = {}
) {
  const cache = new Map(Object.entries(cacheInicial || {}));
  const nuevos = {};
  let desdeCache = 0;
  let clasificadas = 0;
  let fallidas = 0;

  // Buffer de guardado incremental: si la sesión se interrumpe, lo ya
  // clasificado no se pierde (se persiste cada `guardarCada` textos).
  let buffer = {};
  let enBuffer = 0;
  const persistirBuffer = async () => {
    if (onPersistir && enBuffer > 0) {
      try {
        await onPersistir(buffer);
      } catch {
        /* si falla el guardado parcial, el final lo recogerá */
      }
      buffer = {};
      enBuffer = 0;
    }
  };

  // Reintento: un fallo puntual (red, 429) no condena la descripción
  const clasificarConReintento = async (descripcion, contexto, intentos = 2) => {
    for (let n = 0; n < intentos; n++) {
      const r = await extraerAtributos(descripcion, contexto);
      if (r) return r;
      if (n < intentos - 1) await new Promise((res) => setTimeout(res, 1500));
    }
    return null;
  };

  const pendientes = [...fichas.values()].filter((f) => f.general.descripcion && !f.atributos);

  // Agrupar por descripción normalizada: cada texto ÚNICO se clasifica
  // una sola vez y el resultado se reparte a todas sus OTs.
  const grupos = new Map(); // clave → { fichas: [], contexto }
  for (const ficha of pendientes) {
    const clave = norm(ficha.general.descripcion);
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        descripcion: ficha.general.descripcion,
        contexto: { tipoTrabajo: ficha.general.tipoTrabajo, departamento: ficha.general.departamento },
        fichas: [],
      });
    }
    grupos.get(clave).fichas.push(ficha);
  }

  // Resolver primero lo que ya está en la caché persistida
  const porClasificar = [];
  for (const [clave, grupo] of grupos) {
    if (cache.has(clave)) {
      const atributos = cache.get(clave);
      grupo.fichas.forEach((f) => (f.atributos = atributos));
      desdeCache += grupo.fichas.length;
    } else {
      porClasificar.push([clave, grupo]);
    }
  }

  // Clasificar solo los textos únicos nuevos, en lotes paralelos
  for (let i = 0; i < porClasificar.length; i += tamanoLote) {
    const lote = porClasificar.slice(i, i + tamanoLote);
    await Promise.all(
      lote.map(async ([clave, grupo]) => {
        const atributos = await clasificarConReintento(grupo.descripcion, grupo.contexto);
        cache.set(clave, atributos);
        if (atributos) {
          nuevos[clave] = atributos;
          buffer[clave] = atributos;
          enBuffer++;
          clasificadas++;
        } else {
          fallidas++; // no se persiste: se reintentará en la próxima construcción
        }
        grupo.fichas.forEach((f) => (f.atributos = atributos));
      })
    );
    if (enBuffer >= guardarCada) await persistirBuffer();
    onProgreso?.(Math.min(i + tamanoLote, porClasificar.length), porClasificar.length);
  }

  await persistirBuffer(); // resto final

  return { fichas, nuevos, desdeCache, clasificadas, fallidas };
}

// ---------------------------------------------------------------------
// LÓGICA 3 — OT NUEVA: buscar parecidas y sugerir qué cobrar
// ---------------------------------------------------------------------

/** Puntúa el parecido entre los atributos de dos OTs (0 a 1) */
export function similitudAtributos(a, b) {
  if (!a || !b) return 0;
  let puntos = 0;
  let total = 0;

  // "Otro" o null significan "no lo sé": que dos OTs coincidan en
  // "no lo sé" NO es información, así que no puntúa (pero sí penaliza
  // en el denominador, para que la similitud global baje).
  const esVago = (v) => !v || norm(v) === "otro";
  const comparar = (x, y, peso) => {
    total += peso;
    if (!esVago(x) && !esVago(y) && norm(x) === norm(y)) puntos += peso;
  };

  comparar(a.tipoTrabajo, b.tipoTrabajo, 3);
  comparar(a.oficio, b.oficio, 3);
  comparar(a.problema, b.problema, 2);
  comparar(a.instalacionAfectada, b.instalacionAfectada, 2);

  // materiales probables: solape de listas
  total += 2;
  const matA = (a.materialProbable || []).map(norm);
  const matB = (b.materialProbable || []).map(norm);
  if (matA.length && matB.length) {
    const solape = matA.filter((m) => matB.includes(m)).length;
    puntos += 2 * (solape / Math.max(matA.length, matB.length));
  }

  return total > 0 ? puntos / total : 0;
}

/**
 * Similitud de TEXTO entre dos descripciones (0 a 1).
 * Compara por raíces de palabra (primeros 6 caracteres, sin acentos),
 * lo que hace que coincidan variantes catalán/castellano:
 *   "mantenimiento" ~ "manteniment" (raíz "manten")
 *   "piscina" ~ "piscines" (raíz "piscin")
 */
const STOPWORDS = new Set([
  "de", "del", "la", "el", "les", "los", "las", "en", "i", "y", "a", "al",
  "per", "para", "por", "con", "amb", "un", "una", "que", "es", "segons",
  "segun", "según", "mes", "més", "d", "l",
]);

function raices(texto) {
  const limpio = (texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar acentos
    .replace(/[^a-z0-9\s]/g, " ");
  return new Set(
    limpio
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map((w) => w.slice(0, 6))
  );
}

export function similitudTexto(textoConsulta, textoCandidato) {
  const rQ = raices(textoConsulta);
  const rC = raices(textoCandidato);
  if (rQ.size === 0 || rC.size === 0) return 0;
  // Cobertura de la CONSULTA: qué fracción de sus palabras aparece en
  // el candidato. Así "Manteniment Piscina" (cubre "manten"+"piscin")
  // gana a "Manteniment BT" (solo cubre "manten") ante la consulta
  // "mantenimiento piscina".
  let solape = 0;
  for (const r of rQ) if (rC.has(r)) solape++;
  return solape / rQ.size;
}

/** Mediana simple — resistente a OTs con importes extremos */
function mediana(valores) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Percentil (0-100) con interpolación lineal */
function percentil(valores, p) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** Media aritmética simple */
function media(valores) {
  const v = valores.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

/**
 * Dada una OT nueva (solo su descripción), devuelve una sugerencia de
 * qué cobrar basada en las OTs históricas más parecidas.
 *
 * Similitud combinada (0 a 1):
 *   45% texto de la descripción  (lo más fiable con descripciones libres)
 *   35% atributos IA             (tipo de trabajo, oficio, problema...)
 *   20% "Tipus feina" del ERP    (campo estructurado del propio CSV)
 */
export async function sugerirParaOTNueva(
  descripcionNueva,
  fichasHistoricas,
  { minimoSimilitud = 0.35, maxReferencias = 5, importeMinimoReferencia = 30, tipoCliente = null, tarifaHora = null } = {}
) {
  const atributosNuevos = await extraerAtributos(descripcionNueva);
  if (!atributosNuevos) {
    return { error: "No se pudo interpretar la descripción de la OT nueva." };
  }

  const candidatas = [...fichasHistoricas.values()]
    // La similitud se calcula sobre TODAS las OTs con descripción.
    // Los importes se exigen después, solo para las estadísticas de
    // precio (así una memoria sin importes sigue encontrando similares).
    .filter((f) => f.general.descripcion)
    .map((f) => {
      const sTexto = Math.max(
        similitudTexto(descripcionNueva, f.general.descripcion),
        similitudTexto(descripcionNueva, f.general.tipoTrabajo) // "Manteniment Piscina" cuenta como texto también
      );
      const sAtrib = f.atributos ? similitudAtributos(atributosNuevos, f.atributos) : 0;
      const sTipus = similitudTexto(descripcionNueva, f.general.tipoTrabajo);
      let similitud = 0.45 * sTexto + 0.35 * sAtrib + 0.2 * sTipus;

      // Tipo de cliente (P/I/A): mismo segmento suma, distinto resta.
      // Los precios varían según sea particular, industrial o admón.
      if (tipoCliente && f.general.tipoCliente) {
        similitud += f.general.tipoCliente === tipoCliente ? 0.1 : -0.15;
      }
      similitud = Math.max(0, Math.min(1, similitud));

      return { ficha: f, similitud, sTexto, sAtrib };
    })
    .filter((c) => c.similitud >= minimoSimilitud)
    .sort((a, b) => b.similitud - a.similitud);

  // Estadísticas sobre un grupo más amplio (hasta 30 OTs similares).
  // grupoSimilares: por parecido (contexto, atributos, referencias).
  // grupoStats: las 30 MÁS similares DE ENTRE las que tienen importes
  // reales — si las mejores por texto no tienen datos, se baja en la
  // lista hasta encontrar las que sí (siguen superando el umbral).
  // Importes simbólicos (1€, 0,50€...) no son precios reales: fuera.
  const grupoSimilares = candidatas.slice(0, 30);
  const grupoStats = candidatas
    .filter((c) => c.ficha.venta.importeTotalFacturado >= importeMinimoReferencia)
    .slice(0, 30);
  // Para el material habitual: las más similares con LÍNEAS de material
  const grupoMaterial = candidatas
    .filter((c) => c.ficha.venta.materiales.lineas.length > 0)
    .slice(0, 30);
  // Referencias mostradas: primero las que tienen importes
  const referencias = [
    ...candidatas.filter((c) => c.ficha.venta.importeTotalFacturado >= importeMinimoReferencia),
    ...candidatas.filter((c) => c.ficha.venta.importeTotalFacturado < importeMinimoReferencia),
  ].slice(0, maxReferencias);

  if (candidatas.length === 0) {
    return {
      atributos: atributosNuevos,
      referencias: [],
      sugerencia: null,
      mensaje: "No hay OTs históricas suficientemente parecidas. La sugerencia debe hacerse manualmente.",
    };
  }

  const valores = (fn) => grupoStats.map((c) => fn(c.ficha));
  const n = grupoStats.length;

  // ---- Estadísticas (media, mediana, rango habitual p25–p75) ----
  const horasV = valores((f) => f.venta.horas.cantidad).filter((h) => h > 0);
  const totalV = valores((f) => f.venta.importeTotalFacturado);
  const margenV = valores((f) => f.resultado.margenPorcentual).filter((m) => m != null);

  // El desplazamiento solo se conoce si hay LÍNEAS de venta (el CSV
  // agregado no lo desglosa). Sin líneas → desconocido, no cero.
  const hayLineasVenta = [...grupoStats, ...grupoMaterial].some(
    (c) =>
      c.ficha.venta.horas.lineas.length +
        c.ficha.venta.desplazamiento.lineas.length +
        c.ficha.venta.materiales.lineas.length >
      0
  );
  const conDespl = grupoStats.filter((c) => c.ficha.venta.desplazamiento.seCobro).length;
  const pctDesplazamiento = hayLineasVenta && n > 0 ? conDespl / n : null;

  const stats = {
    nSimilares: n, // con importes (base de las estadísticas de precio)
    nSimilaresTexto: grupoSimilares.length, // por parecido (total)
    similitudMedia: media(grupoSimilares.map((c) => c.similitud)),
    horas: {
      media: media(horasV),
      mediana: mediana(horasV),
      rango: [percentil(horasV, 25), percentil(horasV, 75)],
      conDato: horasV.length,
    },
    importeTotal: {
      media: media(totalV),
      mediana: mediana(totalV),
      rango: [percentil(totalV, 25), percentil(totalV, 75)],
      minHabitual: percentil(totalV, 10),
      maxHabitual: percentil(totalV, 90),
      conDato: totalV.length,
    },
    materiales: (() => {
      const matV = valores((f) => f.venta.materiales.importe).filter((m) => m > 0);
      return {
        mediana: mediana(matV),
        rango: [percentil(matV, 25), percentil(matV, 75)],
        conDato: matV.length,
      };
    })(),
    margen: {
      mediana: mediana(margenV),
      conDato: margenV.length,
    },
    pctDesplazamiento,
    // Material habitual (lógica 10): frecuencia por FAMILIA entre las
    // OTs similares que tienen detalle de líneas, con ejemplos del
    // artículo exacto más repetido de cada familia.
    materialesFrecuentes: (() => {
      const otsConMaterial = grupoMaterial;
      if (otsConMaterial.length < 2) return null;
      const porFamilia = new Map(); // familia → { ots:Set, ejemplos:Map(desc→count) }
      for (const c of otsConMaterial) {
        const familiasDeEstaOT = new Set();
        for (const lin of c.ficha.venta.materiales.lineas) {
          const desc = lin["Descripción"] ?? lin.descripcion ?? "";
          const fam = familiaDeMaterial(desc);
          familiasDeEstaOT.add(fam);
          if (!porFamilia.has(fam)) porFamilia.set(fam, { ots: new Set(), ejemplos: new Map() });
          const e = porFamilia.get(fam).ejemplos;
          e.set(desc, (e.get(desc) || 0) + 1);
        }
        familiasDeEstaOT.forEach((fam) => porFamilia.get(fam).ots.add(c.ficha.numeroOT));
      }
      const familias = [...porFamilia.entries()]
        .map(([familia, info]) => ({
          familia,
          pct: info.ots.size / otsConMaterial.length,
          nOTs: info.ots.size,
          ejemplos: [...info.ejemplos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d),
        }))
        .filter((f) => f.nOTs >= 2 || otsConMaterial.length <= 3)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 8);
      return { baseOTs: otsConMaterial.length, familias };
    })(),
  };

  // ---- Confianza (refleja tamaño de muestra y calidad del parecido) ----
  const simTop = candidatas[0]?.similitud ?? 0;
  let confianza = "baja";
  if (n >= 8 && simTop >= 0.6) confianza = "alta";
  else if (n >= 4 && simTop >= 0.45) confianza = "media";

  // ---- Avisos (control de margen y de olvidos) ----
  const avisos = [];
  const refsConCompraSinFacturar = grupoStats.filter(
    (c) => c.ficha.compra.materialCompradoNoFacturado.length > 0
  ).length;
  if (refsConCompraSinFacturar > 0) {
    avisos.push(
      `En ${refsConCompraSinFacturar} OT(s) similares hubo compras asociadas sin material facturado. Revisar que el material se facture.`
    );
  }
  if (pctDesplazamiento != null && pctDesplazamiento >= 0.6) {
    avisos.push(
      `El ${Math.round(pctDesplazamiento * 100)}% de los trabajos similares cobró desplazamiento: no olvidarlo en la propuesta.`
    );
  }
  if (stats.margen.conDato > 0 && stats.margen.mediana < 0.2) {
    avisos.push(
      `El margen histórico en estos trabajos es bajo (mediana ${Math.round(stats.margen.mediana * 100)}%). Valorar si el precio histórico era correcto antes de repetirlo.`
    );
  }
  if (n === 0 && grupoSimilares.length > 0) {
    avisos.push(
      `Se han encontrado ${grupoSimilares.length} OT(s) similares por descripción, pero NINGUNA tiene importes cargados (el listado de la tabla Job no trae importes). Para obtener rangos de precio: carga los CSV de OT's con P venta, las facturas PDF o las líneas de venta de esos años.`
    );
  } else if (n < 4) {
    avisos.push("Pocas OTs similares con importes: la recomendación tiene baja fiabilidad estadística.");
  }

  // ---- Explicación del motivo ----
  const eurTxt = (x) => `${Math.round(x).toLocaleString("es-ES")}€`;
  const partes = [];
  partes.push(
    `Se han encontrado ${stats.nSimilaresTexto} OT(s) similares (similitud media ${Math.round(stats.similitudMedia * 100)}%)` +
      (n < stats.nSimilaresTexto ? `, de las cuales ${n} con importes cargados.` : `.`)
  );
  if (stats.horas.conDato > 0) {
    partes.push(
      `La mediana de horas cobradas es ${stats.horas.mediana.toFixed(1)}h (rango habitual ${stats.horas.rango[0].toFixed(1)}–${stats.horas.rango[1].toFixed(1)}h).`
    );
  }
  if (stats.importeTotal.conDato > 0) {
    partes.push(
      `El importe facturado habitual estuvo entre ${eurTxt(stats.importeTotal.rango[0])} y ${eurTxt(stats.importeTotal.rango[1])} (mediana ${eurTxt(stats.importeTotal.mediana)}).`
    );
  } else {
    partes.push(`Ninguna de las similares tiene importes cargados: sin rango de precio histórico.`);
  }
  if (pctDesplazamiento != null) {
    partes.push(`El ${Math.round(pctDesplazamiento * 100)}% cobró desplazamiento.`);
  }
  const explicacion = partes.join(" ");

  // ---- RECOMENDACIÓN COMBINADA (lógica 11 del diseño) ----
  // No fiarse solo del histórico: si históricamente se cobró poco, el
  // agente repetiría el error. Combina horas recomendadas × TARIFA
  // ACTUAL + material histórico (+ desplazamiento) y lo CONTRASTA con
  // lo que se facturó en trabajos similares.
  let recomendacionCombinada = null;
  if (tarifaHora > 0 && stats.horas.conDato > 0) {
    const rangoMO = [stats.horas.rango[0] * tarifaHora, stats.horas.rango[1] * tarifaHora];
    const rangoMat = stats.materiales.conDato > 0 ? stats.materiales.rango : [0, 0];
    const despl =
      pctDesplazamiento != null && pctDesplazamiento > 0.5
        ? mediana(grupoStats.map((c) => c.ficha.venta.desplazamiento.importe).filter((x) => x > 0))
        : 0;
    const rangoTotal = [rangoMO[0] + rangoMat[0] + despl, rangoMO[1] + rangoMat[1] + despl];

    // Contraste con el histórico (¿se solapan los rangos?)
    const h = stats.importeTotal.rango;
    let contraste, textoContraste;
    if (stats.importeTotal.conDato === 0) {
      contraste = "sin_historico";
      textoContraste = `No hay importes históricos para contrastar: el rango sale de horas × tarifa actual + material. Carga importes (CSV con P venta, facturas o líneas) para poder contrastar.`;
    } else if (rangoTotal[0] > h[1]) {
      contraste = "historico_bajo";
      textoContraste = `A tarifa actual (${tarifaHora}€/h) el trabajo vale ${eurTxt(rangoTotal[0])}–${eurTxt(rangoTotal[1])}, por ENCIMA de lo facturado históricamente (${eurTxt(h[0])}–${eurTxt(h[1])}). El histórico probablemente se cobró por debajo de tarifa: usar la recomendación combinada, no el histórico.`;
    } else if (rangoTotal[1] < h[0]) {
      contraste = "tarifa_baja";
      textoContraste = `A tarifa actual el resultado (${eurTxt(rangoTotal[0])}–${eurTxt(rangoTotal[1])}) queda por DEBAJO del histórico (${eurTxt(h[0])}–${eurTxt(h[1])}). Revisar si la tarifa introducida es correcta o si estos trabajos incluían más conceptos.`;
    } else {
      contraste = "coherente";
      textoContraste = `La recomendación a tarifa actual (${eurTxt(rangoTotal[0])}–${eurTxt(rangoTotal[1])}) es coherente con el histórico (${eurTxt(h[0])}–${eurTxt(h[1])}).`;
    }

    recomendacionCombinada = {
      tarifaHora,
      rangoManoObra: rangoMO,
      rangoMaterial: rangoMat,
      desplazamiento: despl,
      rangoTotal,
      contraste,
      textoContraste,
    };

    if (contraste === "historico_bajo") {
      avisos.push("El histórico está por debajo de la tarifa actual: no repetir precios antiguos sin revisarlos.");
    }
  }

  // MEDIANA en importes puntuales (compatibilidad con la interfaz actual)
  const med = (fn) => mediana(referencias.map((c) => fn(c.ficha)));

  const sugerencia = {
    horasEstimadas: stats.horas.mediana,
    rangoHoras: stats.horas.rango,
    importeHoras: med((f) => f.venta.horas.importe),
    importeMateriales: med((f) => f.venta.materiales.importe),
    cobrarDesplazamiento: pctDesplazamiento == null ? null : pctDesplazamiento > 0.5,
    importeDesplazamiento: med((f) => f.venta.desplazamiento.importe),
    importeTotalOrientativo: stats.importeTotal.mediana,
    rangoImporteTotal: stats.importeTotal.rango,
    margenMedioHistorico: stats.margen.mediana,
    conceptosHabituales: [...new Set(referencias.flatMap((c) => c.ficha.venta.conceptos))].slice(0, 15),
  };

  return {
    atributos: atributosNuevos,
    estadisticas: stats,
    confianza,
    explicacion,
    avisos,
    recomendacionCombinada,
    referencias: referencias.map((c) => ({
      numeroOT: c.ficha.numeroOT,
      similitud: Math.round(c.similitud * 100) / 100,
      descripcion: c.ficha.general.descripcion,
      cliente: c.ficha.general.cliente,
      tipusFeina: c.ficha.general.tipoTrabajo,
      tipoCliente: c.ficha.general.tipoCliente,
      segmento: c.ficha.general.segmento,
      facturado: c.ficha.venta.importeTotalFacturado,
      coste: c.ficha.compra.costeRealOT,
      margen: c.ficha.resultado.margenPorcentual,
    })),
    sugerencia,
    mensaje: `Sugerencia basada en ${n} OT(s) parecida(s). Revisa siempre las referencias antes de presupuestar.`,
  };
}
