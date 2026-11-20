/**
 * Comparador de ofertas: lee los PDF de los proveedores y marca
 * el precio unitario neto más bajo de cada concepto.
 */
const pdfParse = require("pdf-parse");
const { cargarMapeo } = require("./mapeoArticulos.cjs");

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim().replace(/\s/g, "").replace(/€/g, "");
  if (!s) return null;
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function sinAcento(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function canonTalla(t) {
  const x = sinAcento(t).replace(/[^a-z0-9]/g, "");
  if (!x) return "";
  if (x === "2xl" || x === "t2xl") return "XXL";
  if (x === "3xl" || x === "t3xl") return "XXXL";
  if (x === "4xl" || x === "t4xl") return "XXXXL";
  if (x === "txl") return "XL";
  if (x === "ts") return "S";
  if (x === "tm") return "M";
  if (x === "tl") return "L";
  if (/^(xxxl|xxl|xl|xs|s|m|l)$/.test(x)) return x.toUpperCase();
  if (/^(3[6-9]|4\d|5[0-2])$/.test(x)) return x;
  return "";
}

function tallaDe(texto) {
  let s = sinAcento(texto);
  s = s.replace(/\bm\s*\/\s*[cl]\b/g, " ");
  s = s.replace(/\bmanga\s+(corta|larga)\b/g, " ");
  s = s.replace(/\bm\s*\/\s*ama?r?\w*/g, " ");
  let m = s.match(/\bt\s*(4xl|3xl|2xl|xxxl|xxl|xl)\b/);
  if (m) return canonTalla(m[1]);
  m = s.match(/\bt\s*([sml])\b/);
  if (m) return canonTalla(m[1]);
  m = s.match(/\(\s*(4xl|3xl|2xl|xxxl|xxl|xl|xs|s|m|l|\d{2})\b/);
  if (m) return canonTalla(m[1]);
  m = s.match(/\b(4xl|3xl|2xl|xxxl|xxl|xl|xs)\b/);
  if (m) return canonTalla(m[1]);
  m = s.match(/\b([sml])\b/);
  if (m) return canonTalla(m[1]);
  m = s.match(/\b(3[6-9]|4\d|5[0-2])\b/);
  if (m) return m[1];
  return "";
}

function tallaFiable(explicita, texto) {
  const calc = tallaDe(texto);
  if (calc) return calc;
  const exp = canonTalla(explicita);
  if (exp === "M" && /\bm\s*\/\s*[cl]\b/.test(sinAcento(texto))) return "";
  return exp;
}

function familiaRopa(texto) {
  const s = sinAcento(texto);
  if (/sudadera|desuadora|\bspica\b/.test(s)) return { id: "sudadera", nombre: "Sudadera" };
  if (/chaqueta|jaqueta|\bpolar\b/.test(s)) return { id: "jaqueta", nombre: "Jaqueta de alta visibilidad" };
  if (/ignif|soldad|arco elec|portwest|\bbz31\b/.test(s)) return { id: "pantalon-ignifugo", nombre: "Pantalón ignífugo" };
  if (/camiseta|\bdogo\b|extrem|estreme|\bjersey\b/.test(s)) {
    const larga = /\bm\s*\/\s*l\b|manga larga|\bextrem|\bestreme\b|\bjersey\b/.test(s);
    const corta = /\bm\s*\/\s*c\b|manga corta|\bdogo\b/.test(s);
    if (larga && !corta) return { id: "jersey", nombre: "Camiseta manga larga" };
    return { id: "polo", nombre: "Camiseta manga corta" };
  }
  if (/pantalon/.test(s)) return { id: "pantalon", nombre: "Pantalones largos" };
  if (/zapato|\bbota\b|\bowens\b/.test(s)) return { id: "zapato", nombre: "Zapatos" };
  return null;
}

const ORDEN_TALLA = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

function ordenTalla(t) {
  const i = ORDEN_TALLA.indexOf(String(t || "").toUpperCase());
  if (i >= 0) return i;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? 100 + n : 1000;
}

function normalizarClave(texto, talla) {
  let s = sinAcento(texto).replace(/[^a-z0-9]+/g, " ").trim();
  const t = sinAcento(talla);
  if (t) s = s.replace(new RegExp(`\\b${t}\\b`, "g"), " ");
  s = s.replace(/\b(ud|uds|unidad|unidades|talla|tallas|color|negro|negra|amarillo|amarilla)\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

const SECCIONES_CABLE = new Set([0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300]);
const MARCAS_ARTICULO = [
  [/exzhellent/, "exzhellent"],
  [/afumex/, "afumex"],
  [/firex/, "firex"],
  [/nexans/, "nexans"],
  [/prysmian/, "prysmian"],
  [/top\s*cable/, "topcable"],
  [/miguelez/, "miguelez"],
];

function normaDe(s) {
  const m = String(s || "").match(/\b(h07z1|h07v|h05vv|h05v|rz1|rv)\s*-?\s*([krf])\b/);
  if (!m) return "";
  return `${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
}

function seccionDe(s) {
  const candidatos = [];
  const reX = /(\d+)\s*[xg]\s*(\d+(?:[.,]\d+)?)/g;
  const reMm = /(\d+(?:[.,]\d+)?)\s*mm/g;
  const reN = /\b(\d+[.,]\d+)\b/g;
  let m;
  while ((m = reX.exec(s))) candidatos.push(num(m[2]));
  while ((m = reMm.exec(s))) candidatos.push(num(m[1]));
  while ((m = reN.exec(s))) candidatos.push(num(m[1]));
  return candidatos.find((n) => n && SECCIONES_CABLE.has(n)) || null;
}

function colorDe(s) {
  if (/amarillo\s*[-/]?\s*verde|am\s*[-/]\s*verde|ama\s*[-/]\s*ver/.test(s)) return "tierra";
  if (/\bnegro/.test(s)) return "negro";
  if (/\bazul/.test(s)) return "azul";
  if (/\bgris/.test(s)) return "gris";
  if (/\bmarron/.test(s)) return "marron";
  if (/\bblanco/.test(s)) return "blanco";
  if (/\brojo/.test(s)) return "rojo";
  if (/\bamarillo/.test(s) || /\bam\b/.test(s)) return "amarillo";
  return "";
}

function firmaDe(texto) {
  const s = sinAcento(texto).toLowerCase();
  const marcas = MARCAS_ARTICULO.filter(([re]) => re.test(s)).map(([, id]) => id);
  let envase = "";
  if (/\bbobina\b/.test(s)) envase = "bobina";
  else if (/\brollo\b/.test(s)) envase = "rollo";
  else if (/\bcaja\b|\bc\s*\d{2,3}\b/.test(s)) envase = "caja";
  return {
    norma: normaDe(s),
    seccion: seccionDe(s),
    color: colorDe(s),
    marcas,
    flexible: /\bflex|\bflexible|\blibre de halogenos|\blha\b/.test(s),
    envase,
  };
}

function filtroArticulos(firma) {
  if (!firma?.norma || !firma?.seccion) return "";
  const sec = Number.isInteger(firma.seccion)
    ? String(firma.seccion)
    : String(firma.seccion).replace(".", ",");
  const norma = firma.norma.replace(/'/g, "''");
  const alt = sec.includes(",") ? sec.replace(",", ".") : "";
  const parteSec = alt
    ? `(contains(displayName,'${sec}') or contains(displayName,'${alt}'))`
    : `contains(displayName,'${sec}')`;
  return `contains(displayName,'${norma}') and ${parteSec}`;
}

function puntuarArticulo(oferta, item) {
  const f = firmaDe(item?.descripcion || "");
  if (!oferta?.seccion || !oferta?.color || !oferta?.norma) return -1;
  if (!f.seccion || !f.color || !f.norma) return -1;
  if (Math.abs(oferta.seccion - f.seccion) > 0.01) return -1;
  if (oferta.norma !== f.norma) return -1;
  if (oferta.color !== f.color) return -1;
  let score = 105;
  if (oferta.marcas.length) {
    if (!f.marcas.some((m) => oferta.marcas.includes(m))) return -1;
    score += 40;
  } else if (f.marcas.length) {
    score -= 25;
  }
  if (oferta.flexible && f.flexible) score += 15;
  if (oferta.envase && f.envase && oferta.envase === f.envase) score += 8;
  if (item.blocked) score -= 8;
  return score;
}

function elegirArticulo(texto, items) {
  const oferta = firmaDe(texto);
  const puntuados = (items || [])
    .map((it) => ({ it, score: puntuarArticulo(oferta, it) }))
    .filter((x) => x.score >= 80);
  if (!puntuados.length) return null;
  const hayVivo = puntuados.some((x) => !x.it.blocked);
  const vivos = (hayVivo ? puntuados.filter((x) => !x.it.blocked) : puntuados)
    .sort((a, b) => b.score - a.score || String(a.it.numero).localeCompare(String(b.it.numero)));
  const primero = vivos[0];
  const cerca = vivos.filter((x) => primero.score - x.score <= 10);
  const distintos = [];
  for (const x of cerca) {
    const desc = sinAcento(x.it.descripcion);
    if (!distintos.some((d) => sinAcento(d.it.descripcion) === desc)) distintos.push(x);
  }
  if (distintos.length > 1) {
    return {
      codigo: null,
      descripcion: null,
      confianza: "varias",
      bloqueado: false,
      alternativas: distintos.slice(0, 3).map((x) => ({
        codigo: x.it.numero,
        descripcion: x.it.descripcion,
      })),
    };
  }
  const ficha = firmaDe(primero.it.descripcion);
  let confianza = "alta";
  let motivo = "";
  if (!oferta.marcas.length && ficha.marcas.length) {
    confianza = "media";
    motivo = "marca";
  } else if (oferta.flexible && !ficha.flexible) {
    confianza = "media";
    motivo = "formato";
  }
  return {
    codigo: primero.it.numero,
    descripcion: primero.it.descripcion,
    confianza,
    motivo,
    bloqueado: !!primero.it.blocked,
    alternativas: [],
  };
}

function mejorArticulo(textos, items) {
  const orden = { alta: 3, media: 2, varias: 1 };
  const resultados = [...new Set(textos.filter(Boolean))]
    .map((t) => elegirArticulo(t, items))
    .filter(Boolean);
  resultados.sort((a, b) => (orden[b.confianza] || 0) - (orden[a.confianza] || 0));
  return resultados[0] || null;
}

function catalogoLocal(ferros) {
  const mapa = cargarMapeo();
  return (mapa.pares || []).map((p) => ({
    numero: ferros ? p.codigo_nuevo : p.codigo_viejo,
    descripcion: p.descripcion,
    blocked: false,
  }));
}

async function cruzarArticulos(filas, { buscarArticulos, ferros } = {}) {
  const cache = new Map();
  let local = null;
  const avisos = [];
  let avisado = false;
  for (const f of filas || []) {
    const textos = [...new Set([f.concepto, ...(f.conceptos || [])].filter(Boolean))];
    const filtros = [...new Set(textos.map((t) => filtroArticulos(firmaDe(t))).filter(Boolean))];
    let items = [];
    let bcOk = false;
    if (buscarArticulos && filtros.length) {
      try {
        for (const filtro of filtros) {
          if (!cache.has(filtro)) cache.set(filtro, await buscarArticulos(filtro));
          items = items.concat(cache.get(filtro) || []);
        }
        bcOk = true;
      } catch (err) {
        if (!avisado) {
          avisos.push("No he podido consultar los artículos en Business Central. He usado el catálogo local.");
          avisado = true;
        }
      }
    }
    if (!bcOk) {
      if (!local) local = catalogoLocal(!!ferros);
      items = local;
    }
    f.articulo = filtros.length ? mejorArticulo(textos, items) : null;
  }
  return avisos;
}

function precioNeto(linea) {
  const precio = num(linea?.precio);
  if (precio == null || precio < 0) return null;
  const dto = num(linea?.dto) || 0;
  const neto = dto > 0 && dto < 100 ? precio * (1 - dto / 100) : precio;
  return Math.round(neto * 10000) / 10000;
}

function compararOfertas(ofertas) {
  const grupos = new Map();
  for (const o of ofertas || []) {
    const proveedor = String(o.proveedor || "Proveedor").trim() || "Proveedor";
    for (const l of o.lineas || []) {
      const neto = precioNeto(l);
      if (neto == null) continue;
      const texto = `${l.concepto || ""} ${l.clave || ""}`;
      const fam = familiaRopa(texto);
      const talla = tallaFiable(l.talla, texto);
      const clave = fam ? fam.id : normalizarClave(l.clave || l.concepto, talla);
      if (!clave) continue;
      if (!grupos.has(clave + "|" + talla)) {
        grupos.set(clave + "|" + talla, {
          clave,
          familia: fam ? fam.id : "",
          concepto: fam ? fam.nombre : String(l.concepto || l.clave || clave).trim(),
          talla,
          conceptos: [],
          precios: [],
        });
      }
      const grupo = grupos.get(clave + "|" + talla);
      const concepto = String(l.concepto || "").trim();
      if (concepto && !grupo.conceptos.includes(concepto)) grupo.conceptos.push(concepto);
      grupo.precios.push({
        proveedor,
        precio: neto,
        cantidad: num(l.cantidad),
      });
    }
  }
  const filas = [...grupos.values()].map((g) => {
    const porProv = new Map();
    for (const p of g.precios) {
      const ya = porProv.get(p.proveedor);
      if (!ya || p.precio < ya.precio) porProv.set(p.proveedor, p);
    }
    const precios = [...porProv.values()];
    const mejor = Math.min(...precios.map((p) => p.precio));
    return {
      ...g,
      precios,
      mejor,
      mejores: precios.filter((p) => Math.abs(p.precio - mejor) < 0.0001).map((p) => p.proveedor),
    };
  });
  filas.sort((a, b) => a.concepto.localeCompare(b.concepto, "es") || ordenTalla(a.talla) - ordenTalla(b.talla) || a.talla.localeCompare(b.talla, "es"));
  return filas;
}

function proveedorDe(nombre, texto) {
  const base = String(nombre || "").replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  const cab = String(texto || "").split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  const sociedad = cab.find((l) => /\b(s\.?\s*l\.?u?|s\.?\s*a\.?|s\.?\s*l\.?)\b/i.test(l) && !/also casals|ferros coll/i.test(l));
  return (sociedad || base || "Proveedor").slice(0, 80);
}

function lecturaSimple(nombre, texto) {
  const lineas = [];
  for (const raw of String(texto || "").split(/\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    const m = l.match(/^(.{4,}?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d{2}))\s*$/);
    if (!m) continue;
    if (/iva|total|base imponible|portes|descuento/i.test(m[1])) continue;
    const cantidad = num(m[2]);
    const precio = num(m[3]);
    const importe = num(m[4]);
    if (precio == null || precio <= 0 || precio > 100000) continue;
    lineas.push({
      concepto: m[1].trim(),
      clave: m[1].trim(),
      talla: tallaDe(m[1]),
      cantidad,
      precio,
      dto: 0,
      importe,
    });
  }
  return { proveedor: proveedorDe(nombre, texto), fecha: null, referencia: null, lineas, origen: "texto" };
}

function parseJson(texto) {
  const limpio = String(texto || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(limpio); } catch { /* sigue */ }
  const i = limpio.indexOf("{");
  const j = limpio.lastIndexOf("}");
  if (i >= 0 && j > i) return JSON.parse(limpio.slice(i, j + 1));
  throw new Error("La lectura no devolvió un JSON válido.");
}

function limpiarOferta(raw, nombre, texto) {
  const lineas = (Array.isArray(raw?.lineas) ? raw.lineas : []).map((l) => ({
    concepto: String(l.concepto || l.detalle || "").trim(),
    clave: String(l.clave || l.concepto || "").trim(),
    talla: String(l.talla || "").trim(),
    cantidad: num(l.cantidad),
    precio: num(l.precio),
    dto: num(l.dto) || 0,
    importe: num(l.importe),
  })).filter((l) => l.concepto && l.precio != null);
  return {
    proveedor: String(raw?.proveedor || proveedorDe(nombre, texto)).trim().slice(0, 80),
    fecha: raw?.fecha ? String(raw.fecha).slice(0, 20) : null,
    referencia: raw?.referencia ? String(raw.referencia).slice(0, 40) : null,
    lineas,
    origen: "ia",
    archivo: nombre,
  };
}

async function leerConIA({ nombre, texto, base64, fetchConReintento }) {
  const prompt = `Lee esta oferta o presupuesto de un proveedor y devuelve SOLO un JSON con esta forma:
{"proveedor":"nombre comercial del proveedor, no el del cliente","fecha":"dd/mm/aaaa o null","referencia":"nº de oferta o null","lineas":[{"concepto":"nombre corto del artículo","clave":"mismo artículo sin talla ni marca, en minúsculas y comparable entre proveedores","talla":"M, XL, 42… o vacío","cantidad":1,"precio":12.5,"dto":0,"importe":12.5}]}
Reglas:
- El cliente (Also Casals, Ferros) no es el proveedor.
- "precio" es el precio UNITARIO sin IVA. Si hay descuento, pon el % en "dto" y deja "precio" como precio de tarifa antes del descuento.
- Una línea por cada artículo y talla. No incluyas portes, IVA, base imponible ni totales.
- "clave" debe coincidir entre proveedores para el mismo artículo, sin marca, modelo ni talla.
- En ropa de trabajo la clave es exactamente una de estas: "sudadera", "camiseta manga corta", "camiseta manga larga", "jaqueta", "pantalones", "pantalon ignifugo", "zapatos".
- "camiseta m/c" y "dogo" son camiseta manga corta. "camiseta m/l", "extrem" y "estreme" son camiseta manga larga. Una sudadera no es camiseta aunque diga m/l.
- "chaqueta polar" y "jaqueta" son jaqueta. "pantalon power" o "stretch" son pantalones. "ignifugo", "soldador" y "arco electrico" son pantalon ignifugo, no el pantalón de trabajo.
- "m/c" y "m/l" no son una talla. TM=M, TL=L, TXL=XL, T2XL=XXL, T3XL=XXXL, T4XL=XXXXL, TS=S.
- Números con punto decimal. Sin texto fuera del JSON.`;
  const porTexto = (texto.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length >= 80;
  const content = porTexto
    ? [{ type: "text", text: `${prompt}\n\nARCHIVO: ${nombre}\n\nTEXTO:\n${texto.slice(0, 50000)}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: `${prompt}\n\nARCHIVO: ${nombre}` },
      ];
  const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    }),
  });
  if (!response.ok) {
    const detalle = await response.text();
    throw new Error(`La lectura respondió ${response.status}: ${detalle.slice(0, 180)}`);
  }
  const data = await response.json();
  const salida = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return limpiarOferta(parseJson(salida), nombre, texto);
}

function codigosDeArticulo(articulo) {
  if (!articulo?.codigo) return [];
  const por = cargarMapeo().porCodigo || {};
  const meta = por[articulo.codigo];
  return [...new Set([articulo.codigo, meta?.codigo_viejo, meta?.codigo_nuevo].filter(Boolean))];
}

function claveOfertaGuardada(l) {
  return [
    l.codigo,
    sinAcento(l.proveedor),
    l.precio,
    l.fechaOferta || "",
    l.referencia || "",
    l.archivo || "",
  ].join("|");
}

function lineasParaGuardar(ofertas, filas) {
  const porProveedor = new Map((ofertas || []).map((o) => [o.proveedor, o]));
  const lineas = [];
  for (const f of filas || []) {
    if (!f.articulo?.codigo || f.articulo.confianza === "varias") continue;
    const codigos = codigosDeArticulo(f.articulo);
    for (const p of f.precios || []) {
      const oferta = porProveedor.get(p.proveedor);
      lineas.push({
        codigo: f.articulo.codigo,
        codigos,
        descripcion: String(f.articulo.descripcion || f.concepto || "").slice(0, 180),
        confianza: f.articulo.confianza || "",
        proveedor: p.proveedor,
        precio: p.precio,
        concepto: String(f.concepto || "").slice(0, 180),
        fechaOferta: oferta?.fecha || null,
        referencia: oferta?.referencia || null,
        archivo: oferta?.archivo || null,
      });
    }
  }
  return lineas;
}

function recuerdoDe(fila, sesiones) {
  const codigos = new Set(codigosDeArticulo(fila?.articulo));
  if (!codigos.size) return [];
  const hoy = new Date().toISOString().slice(0, 10);
  const actuales = new Set((fila.precios || []).map((p) => `${sinAcento(p.proveedor)}|${p.precio}`));
  const out = [];
  for (const s of sesiones || []) {
    const dia = String(s.ts || "").slice(0, 10);
    for (const l of s.lineas || []) {
      const familiares = l.codigos || [l.codigo];
      if (!familiares.some((c) => codigos.has(c))) continue;
      const mismaDeHoy = dia === hoy && actuales.has(`${sinAcento(l.proveedor)}|${l.precio}`);
      if (mismaDeHoy) continue;
      out.push({
        ts: s.ts,
        proveedor: l.proveedor,
        precio: l.precio,
        fechaOferta: l.fechaOferta || null,
        referencia: l.referencia || null,
        archivo: l.archivo || null,
        concepto: l.concepto || "",
      });
    }
  }
  return out;
}

async function guardarYRecordar(filas, ofertas, { db, claveEmpresa }) {
  if (!db || typeof claveEmpresa !== "function") return;
  const clave = claveEmpresa("ofertas_guardadas");
  const doc = await db.getDoc(clave, { sesiones: [] });
  const sesiones = Array.isArray(doc?.sesiones) ? doc.sesiones : [];
  for (const f of filas || []) f.recuerdo = recuerdoDe(f, sesiones);
  const nuevas = lineasParaGuardar(ofertas, filas);
  const ya = new Set();
  for (const s of sesiones) for (const l of s.lineas || []) ya.add(claveOfertaGuardada(l));
  const frescas = nuevas.filter((l) => !ya.has(claveOfertaGuardada(l)));
  if (!frescas.length) return;
  sesiones.unshift({ id: Date.now().toString(36), ts: new Date().toISOString(), lineas: frescas });
  await db.setDoc(clave, { sesiones: sesiones.slice(0, 120) });
}

function registrar({ app, fetchConReintento, buscarArticulos, empresaNombre, db, claveEmpresa }) {
  app.post("/api/ofertas/comparar", async (req, res) => {
    try {
      const archivos = Array.isArray(req.body?.archivos) ? req.body.archivos.slice(0, 12) : [];
      if (!archivos.length) return res.status(400).json({ error: "Adjunta al menos un PDF." });
      const ofertas = [];
      const avisos = [];
      for (const a of archivos) {
        const nombre = String(a?.nombre || "oferta.pdf");
        const base64 = String(a?.base64 || "");
        if (!base64) {
          avisos.push(`${nombre}: el archivo llega vacío.`);
          continue;
        }
        let texto = "";
        try {
          const leido = await pdfParse(Buffer.from(base64, "base64"));
          texto = String(leido?.text || "").replace(/\u0000/g, "");
        } catch (err) {
          avisos.push(`${nombre}: no se pudo abrir el PDF (${err.message || err}).`);
          continue;
        }
        try {
          if (process.env.ANTHROPIC_API_KEY) {
            ofertas.push(await leerConIA({ nombre, texto, base64, fetchConReintento }));
          } else {
            const simple = lecturaSimple(nombre, texto);
            simple.archivo = nombre;
            ofertas.push(simple);
            avisos.push("Sin clave de lectura automática: se han tomado las líneas con cantidad, precio e importe.");
          }
        } catch (err) {
          const simple = lecturaSimple(nombre, texto);
          simple.archivo = nombre;
          if (simple.lineas.length) {
            ofertas.push(simple);
            avisos.push(`${nombre}: la lectura detallada falló y se usó la tabla del texto.`);
          } else {
            avisos.push(`${nombre}: ${err.message || err}`);
          }
        }
      }
      const filas = compararOfertas(ofertas);
      const nombreEmpresa = typeof empresaNombre === "function" ? empresaNombre() : "";
      const avisosArticulo = await cruzarArticulos(filas, {
        buscarArticulos,
        ferros: /ferros/i.test(String(nombreEmpresa || "")),
      });
      avisos.push(...avisosArticulo);
      try {
        await guardarYRecordar(filas, ofertas, { db, claveEmpresa });
      } catch (err) {
        console.error("No se pudo guardar el recuerdo de ofertas:", err);
        avisos.push("No he podido guardar estas ofertas para la próxima vez.");
      }
      res.json({ ok: true, ofertas, filas, avisos: [...new Set(avisos)] });
    } catch (err) {
      console.error("Error /api/ofertas/comparar:", err);
      res.status(500).json({ error: "No se pudieron comparar las ofertas.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/ofertas/asignar", async (req, res) => {
    try {
      const codigo = String(req.body?.codigo || "").trim();
      const precios = (Array.isArray(req.body?.precios) ? req.body.precios : [])
        .map((p) => ({ proveedor: String(p?.proveedor || "").trim(), precio: Number(p?.precio) }))
        .filter((p) => p.proveedor && Number.isFinite(p.precio));
      if (!codigo || !precios.length) return res.status(400).json({ error: "Falta el artículo o el precio." });
      const metas = Array.isArray(req.body?.ofertas) ? req.body.ofertas : [];
      const ofertas = precios.map((p) => {
        const meta = metas.find((m) => m.proveedor === p.proveedor) || {};
        return {
          proveedor: p.proveedor,
          fecha: meta.fecha || null,
          referencia: meta.referencia || null,
          archivo: meta.archivo || null,
        };
      });
      const fila = {
        concepto: String(req.body?.concepto || "").slice(0, 180),
        articulo: {
          codigo,
          descripcion: String(req.body?.descripcion || "").slice(0, 180),
          confianza: "manual",
        },
        precios,
      };
      await guardarYRecordar([fila], ofertas, { db, claveEmpresa });
      res.json({ ok: true, recuerdo: fila.recuerdo || [] });
    } catch (err) {
      console.error("Error /api/ofertas/asignar:", err);
      res.status(500).json({ error: "No se pudo guardar el artículo.", detalle: String(err.message || err) });
    }
  });
}

module.exports = {
  registrar, compararOfertas, lecturaSimple, precioNeto, elegirArticulo, firmaDe, cruzarArticulos,
  recuerdoDe, lineasParaGuardar, claveOfertaGuardada,
};
