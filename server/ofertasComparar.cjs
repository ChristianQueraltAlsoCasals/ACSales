/**
 * Comparador de ofertas: lee los PDF de los proveedores y marca
 * el precio unitario neto más bajo de cada concepto.
 */
const pdfParse = require("pdf-parse");

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

function tallaDe(texto) {
  const m = sinAcento(texto).match(/\b(xxxl|xxl|xl|[sml]|\d{2})\b/);
  if (!m) return "";
  const t = m[1];
  if (/^\d{2}$/.test(t)) return t;
  return t.toUpperCase();
}

function normalizarClave(texto, talla) {
  let s = sinAcento(texto).replace(/[^a-z0-9]+/g, " ").trim();
  const t = sinAcento(talla);
  if (t) s = s.replace(new RegExp(`\\b${t}\\b`, "g"), " ");
  s = s.replace(/\b(ud|uds|unidad|unidades|talla|tallas|color|negro|negra|amarillo|amarilla)\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
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
      const talla = String(l.talla || tallaDe(l.concepto || "") || "").trim();
      const clave = normalizarClave(l.clave || l.concepto, talla);
      if (!clave) continue;
      if (!grupos.has(clave + "|" + talla)) {
        grupos.set(clave + "|" + talla, {
          clave,
          concepto: String(l.concepto || l.clave || clave).trim(),
          talla,
          precios: [],
        });
      }
      grupos.get(clave + "|" + talla).precios.push({
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
  filas.sort((a, b) => a.concepto.localeCompare(b.concepto, "es") || a.talla.localeCompare(b.talla, "es", { numeric: true }));
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
- "clave" debe coincidir entre proveedores para el mismo artículo (ejemplo: "camiseta manga corta", "pantalon cargo", "zapato seguridad owens").
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

function registrar({ app, fetchConReintento }) {
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
      res.json({ ok: true, ofertas, filas, avisos: [...new Set(avisos)] });
    } catch (err) {
      console.error("Error /api/ofertas/comparar:", err);
      res.status(500).json({ error: "No se pudieron comparar las ofertas.", detalle: String(err.message || err) });
    }
  });
}

module.exports = { registrar, compararOfertas, lecturaSimple, precioNeto };
