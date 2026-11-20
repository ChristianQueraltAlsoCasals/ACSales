/**
 * Recepción de material — preparar un pedido a partir de un albarán.
 * Solo lee Business Central. Crear el pedido es otro endpoint y solo
 * se llama cuando la usuaria confirma en pantalla.
 */

const pdfParse = require("pdf-parse");

const STOP = new Set([
  "para", "con", "sin", "tipo", "modelo", "marca", "unidad", "negro", "blanca", "blanco",
  "articulo", "codigo", "descripcion", "cantidad", "figura", "fig", "diametro",
]);

function sinAcento(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o");
}

function norm(s) {
  return sinAcento(s).replace(/[^a-z0-9]+/g, " ").trim();
}

function contar(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function mismasMedidas(a, b) {
  if (a.length !== b.length) return false;
  const mb = contar(b);
  for (const x of a) {
    if (!mb.get(x)) return false;
    mb.set(x, mb.get(x) - 1);
  }
  return true;
}

function tuercaDe(texto) {
  const t = sinAcento(texto);
  if (/\bc\s*\/\s*tuerca\b/.test(t) || /\bcon tuerca\b/.test(t)) return "con";
  if (/\bs\s*\/\s*tuerca\b/.test(t) || /\bsin tuerca\b/.test(t)) return "sin";
  return null;
}

function analizar(texto) {
  const base = sinAcento(texto);
  const fracciones = [];
  const sinFrac = base.replace(/(\d{1,2})\s*\/\s*(\d{1,2})/g, (_, a, b) => {
    fracciones.push(`${Number(a)}/${Number(b)}`);
    return " ";
  });
  const figs = new Set();
  for (const m of sinFrac.matchAll(/\bfig(?:ura)?\s*(\d{3,4})\b/g)) figs.add(m[1]);
  for (const m of sinFrac.matchAll(/\b(\d{3})\b/g)) figs.add(m[1]);
  const palabras = norm(sinFrac).split(" ").filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return { fracciones, figs: [...figs], palabras, tuerca: tuercaDe(base) };
}

function palabraEncaja(busca, token) {
  if (!busca || !token) return false;
  if (busca === token) return true;
  const corto = busca.length <= token.length ? busca : token;
  const largo = busca.length <= token.length ? token : busca;
  if (corto.length >= 4 && largo.startsWith(corto)) return true;
  if (busca.length < 5 || token.length < 5 || Math.abs(busca.length - token.length) > 1) return false;
  if (busca.length === token.length) {
    let dif = 0;
    for (let i = 0; i < busca.length; i++) if (busca[i] !== token[i]) dif++;
    return dif <= 1;
  }
  const corta = busca.length < token.length ? busca : token;
  const larga = busca.length < token.length ? token : busca;
  let i = 0;
  let j = 0;
  let salto = 0;
  while (i < corta.length && j < larga.length) {
    if (corta[i] === larga[j]) { i++; j++; }
    else { salto++; j++; if (salto > 1) return false; }
  }
  return true;
}

function puntuarArticulo(descPdf, descItem) {
  return encajarArticulo(descPdf, descItem).puntos;
}

function encajarArticulo(descPdf, descItem) {
  const pdf = analizar(descPdf);
  const item = analizar(descItem);
  const tokens = norm(descItem).split(" ").filter(Boolean);
  if (!pdf.palabras.length && !pdf.fracciones.length && !pdf.figs.length) return { puntos: 0, vale: false };
  let aciertos = 0;
  for (const p of pdf.palabras) {
    if (tokens.some((t) => palabraEncaja(p, t))) aciertos++;
  }
  let puntos = pdf.palabras.length ? aciertos / pdf.palabras.length : 0;
  const medidasOk = !pdf.fracciones.length || mismasMedidas(pdf.fracciones, item.fracciones);
  if (pdf.fracciones.length) puntos += medidasOk ? 0.5 : -0.8;
  const figOk = !pdf.figs.length || pdf.figs.some((f) => tokens.includes(f));
  if (pdf.figs.length) puntos += figOk ? 0.3 : -0.4;
  if (pdf.tuerca && item.tuerca && pdf.tuerca !== item.tuerca) puntos -= 0.8;
  const minimo = pdf.palabras.length <= 2 ? pdf.palabras.length : Math.ceil(pdf.palabras.length * 0.6);
  const tuercaOk = !(pdf.tuerca && item.tuerca && pdf.tuerca !== item.tuerca);
  const vale = aciertos >= minimo
    && aciertos >= 1
    && medidasOk
    && figOk
    && tuercaOk;
  return { puntos, vale };
}

function textoJsonClaude(raw) {
  const s = String(raw || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) return s.slice(i, j + 1);
  return s;
}

function numONull(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function prefijoOt(nombreEmpresa) {
  return /ferros/i.test(String(nombreEmpresa || "")) ? "FCA" : "AC";
}

function codigosOt(texto, nombreEmpresa) {
  const t = String(texto || "").trim().toUpperCase();
  if (!t) return [];
  const completo = t.match(/^(AC|FCA)\s*0*(\d{3,6})\s*[/.-]\s*(\d{4})$/);
  if (completo) return [`${completo[1]}${String(completo[2]).padStart(6, "0")}/${completo[3]}`];
  const digitos = t.replace(/\D/g, "");
  if (digitos.length < 3 || digitos.length > 6) return [];
  const n = String(Number(digitos)).padStart(6, "0");
  const anio = new Date().getFullYear();
  const pref = prefijoOt(nombreEmpresa);
  return [`${pref}${n}/${anio}`, `${pref}${n}/${anio - 1}`];
}

async function bcJson(fetchConReintento, url, token) {
  const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { json = null; }
  return { ok: r.ok, status: r.status, json, texto: t.slice(0, 240) };
}

function raizOData(deps) {
  const empresa = encodeURIComponent(deps.empresaNombre() || "");
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
}

function raizApi(deps) {
  return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${deps.empresaId()})`;
}

async function extraerLecturas(bytes, pdfDocument, guardarVistaPdf) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY en .env.");
  // Una página = un posible albarán distinto. Si mandamos el PDF entero,
  // a menudo solo se lee el primero.
  const lotes = [];
  const PDFDocument = pdfDocument && pdfDocument.load ? pdfDocument : null;
  if (PDFDocument) {
    try {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const n = src.getPageCount();
      for (let i = 0; i < n; i++) {
        const doc = await PDFDocument.create();
        const [copiada] = await doc.copyPages(src, [i]);
        doc.addPage(copiada);
        const pageBytes = Buffer.from(await doc.save());
        let pdfVistaPagina = null;
        if (guardarVistaPdf) {
          try { pdfVistaPagina = guardarVistaPdf(pageBytes); } catch { pdfVistaPagina = null; }
        }
        lotes.push({ bytes: pageBytes, pagina: i + 1, pdfVista: pdfVistaPagina });
      }
    } catch { /* se manda el PDF entero */ }
  }
  if (!lotes.length) lotes.push({ bytes, pagina: 1, pdfVista: null });

  const lecturas = [];
  for (const lote of lotes) {
    const parte = await pedirLecturaClaude(lote.bytes);
    for (const l of parte) {
      lecturas.push({
        ...l,
        pagina: lote.pagina,
        pdfVista: lote.pdfVista || null,
      });
    }
  }
  const porClave = new Map();
  for (const l of lecturas) {
    if (!(l.lineas || []).length && !l.albaran) continue;
    const clave = `${norm(l.proveedor)}|${String(l.albaran || "").replace(/\W/g, "")}|${l.pagina || ""}`;
    const ya = porClave.get(clave);
    if (!ya) porClave.set(clave, { ...l, lineas: [...(l.lineas || [])] });
    else ya.lineas.push(...(l.lineas || []));
  }
  return [...porClave.values()];
}

async function pedirLecturaClaude(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const prompt = `Lee este albarán o nota de entrega de un proveedor. Puede estar escaneado. Esta página es UN documento.
Si la página está en blanco o no es un albarán, responde {"documentos":[]}.
Responde SOLO un JSON con esta forma, sin texto alrededor:
{"documentos":[{"proveedor":"nombre del proveedor","albaran":"número de albarán del proveedor","fecha":"AAAA-MM-DD o null","ot":null,"pedido":null,"lineas":[{"descripcion":"texto del artículo","cantidad":1,"codigoProveedor":null,"precio":null,"descuento":null}]}]}

Reglas:
- "pedido" es NUESTRO pedido de compra, formato PC26-004171 o OC26-000123. Si no está impreso, null. El número de pedido del proveedor (S/CDA u otro entero) NO es nuestro pedido.
- "ot" es la obra o OT nuestra (15407, AC015407/2026). Si el papel dice que falta el número, o no hay obra, pon null. No inventes una OT.
- "precio" y "descuento" solo si están impresos en la línea. Si no están, null. El descuento es un porcentaje (10 si es 10%).
- "cantidad" es la cantidad entregada, no el precio.
- Una línea por artículo. No crees líneas de totales, firmas ni textos legales.`;

  // Misma lógica que Validación de facturas: si hay texto, no se sube el PDF
  // como imagen (evita PDF inválido tras partir páginas y ahorra coste).
  let textoPdf = "";
  try {
    const leido = await pdfParse(buf);
    textoPdf = String(leido?.text || "").replace(/\u0000/g, "").trim();
  } catch { /* PDF escaneado o protegido */ }
  const letras = (textoPdf.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const porTexto = letras >= 120;
  const cierre = "Responde ÚNICAMENTE con el JSON. Sin análisis, sin markdown y sin texto antes ni después.";
  const content = porTexto
    ? [{ type: "text", text: `${prompt}\n\nTEXTO DEL PDF (no inventes líneas que no estén aquí):\n${textoPdf.slice(0, 50000)}\n\n${cierre}` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
        { type: "text", text: `${prompt}\n\n${cierre}` },
      ];
  console.log(`[recepcion/preparar] página · ${porTexto ? `texto (${letras} caracteres)` : "imagen"}`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    }),
  });
  if (!response.ok) {
    const t = await response.text().catch(() => "");
    throw new Error(`La lectura del PDF ha fallado (${response.status}). ${t.slice(0, 180)}`);
  }
  const data = await response.json();
  const texto = (data.content || []).map((c) => c.text || "").join("");
  let parsed;
  try { parsed = JSON.parse(textoJsonClaude(texto)); }
  catch { throw new Error("La lectura del PDF no ha devuelto un JSON válido."); }
  const docs = Array.isArray(parsed.documentos) ? parsed.documentos : (parsed.proveedor || parsed.lineas ? [parsed] : []);
  return docs.map(limpiarLectura).filter((d) => d.lineas.length || d.albaran || d.proveedor);
}

function limpiarLectura(d) {
  const lineas = (Array.isArray(d.lineas) ? d.lineas : []).map((l) => ({
    descripcion: String(l.descripcion || "").trim(),
    cantidad: numONull(l.cantidad),
    codigoProveedor: l.codigoProveedor ? String(l.codigoProveedor).trim() : null,
    precio: numONull(l.precio),
    descuento: numONull(l.descuento),
  })).filter((l) => l.descripcion && l.cantidad != null && l.cantidad > 0);
  return {
    proveedor: String(d.proveedor || "").trim(),
    albaran: d.albaran ? String(d.albaran).trim() : "",
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha || "")) ? d.fecha : null,
    ot: d.ot ? String(d.ot).trim() : null,
    pedido: d.pedido ? String(d.pedido).trim() : null,
    pagina: Number(d.pagina) > 0 ? Number(d.pagina) : null,
    pdfVista: d.pdfVista || null,
    lineas,
  };
}

async function buscarOt(deps, token, texto) {
  const codigos = codigosOt(texto, deps.empresaNombre());
  const raiz = raizOData(deps);
  const campos = "No,Description,Status,Global_Dimension_1_Code,Departamento_Responsable,Bill_to_Name";
  for (const no of codigos) {
    const filtro = `No eq '${no.replace(/'/g, "''")}'`;
    const url = `${raiz}/${encodeURIComponent("Job_List")}?$filter=${encodeURIComponent(filtro)}&$select=${campos}&$top=1`;
    const r = await bcJson(deps.fetchConReintento, url, token);
    const fila = r.ok ? (r.json?.value || [])[0] : null;
    if (fila) return filaOt(fila);
  }
  const digitos = String(texto || "").replace(/\D/g, "");
  if (digitos.length >= 3 && digitos.length <= 6) {
    const filtro = `contains(No,'${digitos.replace(/'/g, "''")}')`;
    const url = `${raiz}/${encodeURIComponent("Job_List")}?$filter=${encodeURIComponent(filtro)}&$select=${campos}&$top=8`;
    const r = await bcJson(deps.fetchConReintento, url, token);
    const filas = r.ok ? (r.json?.value || []) : [];
    const pref = prefijoOt(deps.empresaNombre());
    const buena = filas.find((f) => String(f.No || "").startsWith(pref) && String(f.Status || "") === "Open") || filas.find((f) => String(f.No || "").startsWith(pref)) || filas[0];
    if (buena) return filaOt(buena);
  }
  return null;
}

function filaOt(f) {
  return {
    codigo: f.No,
    descripcion: f.Description || "",
    estado: f.Status || "",
    departamento: f.Global_Dimension_1_Code || "",
    responsable: f.Departamento_Responsable || "",
    cliente: f.Bill_to_Name || "",
  };
}

async function buscarProveedor(deps, token, nombre) {
  const palabras = norm(nombre).split(" ").filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  palabras.sort((a, b) => b.length - a.length);
  if (!palabras.length) return { proveedor: null, aviso: "El albarán no trae el nombre del proveedor." };
  const vistos = new Map();
  const base = raizApi(deps);
  for (const trozo of palabras) {
    const variantes = [...new Set([trozo.toUpperCase(), trozo.charAt(0).toUpperCase() + trozo.slice(1)])];
    for (const v of variantes) {
      const filtro = `contains(displayName,'${v.replace(/'/g, "''")}')`;
      const url = `${base}/vendors?$filter=${encodeURIComponent(filtro)}&$top=15&$select=number,displayName`;
      const r = await bcJson(deps.fetchConReintento, url, token);
      if (!r.ok) continue;
      for (const it of r.json?.value || []) vistos.set(it.number, { numero: it.number, nombre: it.displayName });
    }
    if (vistos.size) break;
  }
  const lista = [...vistos.values()];
  if (!lista.length) return { proveedor: null, aviso: `No encuentro el proveedor «${nombre}» en Business Central.` };
  const n = norm(nombre);
  const trozo = palabras[0];
  lista.sort((a, b) => {
    const sa = norm(a.nombre).includes(n) ? 2 : (norm(a.nombre).includes(trozo) ? 1 : 0);
    const sb = norm(b.nombre).includes(n) ? 2 : (norm(b.nombre).includes(trozo) ? 1 : 0);
    return sb - sa;
  });
  const aviso = lista.length > 1 ? `Hay ${lista.length} proveedores parecidos a «${nombre}». Se usa ${lista[0].nombre}.` : null;
  return { proveedor: lista[0], aviso };
}

async function lineasPedidoOData(deps, token, numero) {
  const raiz = raizOData(deps);
  const filtro = `Document_Type eq 'Order' and Document_No eq '${String(numero).replace(/'/g, "''")}'`;
  const url = `${raiz}/${encodeURIComponent("Purchase_Order_Line_Excel")}?$filter=${encodeURIComponent(filtro)}&$top=40`;
  const r = await bcJson(deps.fetchConReintento, url, token);
  if (!r.ok) return [];
  return r.json?.value || [];
}

async function buscarPedidoExistente(deps, token, { pedidoTexto, vendorNumber, otCodigo }) {
  const raiz = raizOData(deps);
  const servicio = encodeURIComponent(deps.servicioPedidos || "Pedido_compra_Excel");
  const select = "No,Buy_from_Vendor_No,Buy_from_Vendor_Name,Order_Date,Status,Vendor_Shipment_No,Shortcut_Dimension_1_Code,Shortcut_Dimension_2_Code";
  let filas = [];
  if (pedidoTexto && /^PC|^OC/i.test(pedidoTexto)) {
    const no = pedidoTexto.replace(/'/g, "''").toUpperCase();
    const filtro = `Document_Type eq 'Order' and No eq '${no}'`;
    const r = await bcJson(deps.fetchConReintento, `${raiz}/${servicio}?$filter=${encodeURIComponent(filtro)}&$select=${select}&$top=1`, token);
    filas = r.ok ? (r.json?.value || []) : [];
  } else if (vendorNumber && otCodigo) {
    const filtro = `Document_Type eq 'Order' and Buy_from_Vendor_No eq '${vendorNumber.replace(/'/g, "''")}' and Shortcut_Dimension_2_Code eq '${otCodigo.replace(/'/g, "''")}'`;
    const r = await bcJson(deps.fetchConReintento, `${raiz}/${servicio}?$filter=${encodeURIComponent(filtro)}&$select=${select}&$top=8`, token);
    filas = r.ok ? (r.json?.value || []) : [];
  }
  if (!filas.length) return null;
  filas.sort((a, b) => String(b.Order_Date || "").localeCompare(String(a.Order_Date || "")));
  const cab = filas[0];
  const lineas = await lineasPedidoOData(deps, token, cab.No);
  return {
    numero: cab.No,
    proveedor: cab.Buy_from_Vendor_Name || "",
    vendorNumber: cab.Buy_from_Vendor_No || vendorNumber || "",
    fecha: cab.Order_Date || null,
    estado: cab.Status || "",
    albaran: cab.Vendor_Shipment_No || "",
    ot: cab.Shortcut_Dimension_2_Code || "",
    departamento: cab.Shortcut_Dimension_1_Code || "",
    otros: filas.slice(1).map((f) => f.No),
    lineas: lineas.map((l) => ({
      linea: l.Line_No,
      codigo: String(l.No || "").trim(),
      descripcion: l.Description || "",
      cantidad: numONull(l.Quantity) || 0,
      precio: numONull(l.Direct_Unit_Cost),
      descuento: numONull(l.Line_Discount_Percent) || 0,
      recibida: numONull(l.Quantity_Received) || 0,
      facturada: numONull(l.Quantity_Invoiced) || 0,
    })),
  };
}

async function buscarArticulos(deps, token, descripcion) {
  const info = analizar(descripcion);
  const consultas = [];
  const ya = new Set();
  const add = (a, b) => {
    const x = String(a || "").trim().toLowerCase();
    const y = String(b || "").trim().toLowerCase();
    if (x.length < 2 || y.length < 2 || x === y) return;
    const clave = [x, y].sort().join("|");
    if (ya.has(clave)) return;
    ya.add(clave);
    consultas.push([x, y]);
  };
  const fracs = [...new Set(info.fracciones)];
  for (const fig of info.figs) for (const fr of fracs) add(fig, fr);
  for (const w of info.palabras.slice(0, 3)) for (const fr of fracs.slice(0, 2)) add(w, fr);
  if (info.palabras.length >= 2) add(info.palabras[0], info.palabras[1]);
  if (!consultas.length && info.palabras[0]) consultas.push([info.palabras[0], null]);

  const base = raizApi(deps);
  const vistos = new Map();
  for (const [a, b] of consultas.slice(0, 5)) {
    const filtro = b
      ? `contains(displayName,'${a.replace(/'/g, "''")}') and contains(displayName,'${b.replace(/'/g, "''")}')`
      : `contains(displayName,'${a.replace(/'/g, "''")}')`;
    const url = `${base}/items?$filter=${encodeURIComponent(filtro)}&$top=20&$select=number,displayName,blocked`;
    const r = await bcJson(deps.fetchConReintento, url, token);
    if (!r.ok) continue;
    for (const it of r.json?.value || []) {
      if (it.blocked || vistos.has(it.number)) continue;
      const enc = encajarArticulo(descripcion, it.displayName);
      vistos.set(it.number, { numero: it.number, descripcion: it.displayName, puntos: enc.puntos, vale: enc.vale });
    }
  }
  return [...vistos.values()].sort((a, b) => b.puntos - a.puntos);
}

async function ultimaCompra(deps, token, codigo, vendorNumber) {
  if (!codigo || !vendorNumber) return null;
  const raiz = raizOData(deps);
  const filtro = `No eq '${codigo.replace(/'/g, "''")}' and Buy_from_Vendor_No eq '${vendorNumber.replace(/'/g, "''")}'`;
  const url = `${raiz}/${encodeURIComponent("Hist_líns_facturas_compra_Excel")}?$filter=${encodeURIComponent(filtro)}&$top=30`;
  const r = await bcJson(deps.fetchConReintento, url, token);
  if (!r.ok) return null;
  const filas = r.json?.value || [];
  if (!filas.length) return null;
  filas.sort((a, b) => String(b.Document_No || "").localeCompare(String(a.Document_No || "")));
  const f = filas[0];
  const dto = [f.Line_Discount_Percent, f.Percent_Dto_linea_1, f.Percent_Dto_linea_2, f.Percent_Dto_linea_3]
    .map(numONull)
    .find((n) => n != null && n > 0) ?? 0;
  return {
    factura: f.Document_No || "",
    precio: numONull(f.Direct_Unit_Cost),
    descuento: dto,
  };
}

async function proponerLineas(deps, token, lectura, vendorNumber, pedido) {
  const usadas = new Set();
  const propuestas = [];
  for (const l of lectura.lineas || []) {
    const candidatos = await buscarArticulos(deps, token, l.descripcion);
    const mejor = candidatos.find((c) => c.vale) || null;
    const alternativas = candidatos.filter((c) => c !== mejor && c.puntos >= 0.4).slice(0, 3);
    const enPedido = mejor
      ? (pedido?.lineas || []).find((pl) => pl.codigo && pl.codigo === mejor.numero && !usadas.has(pl.linea))
      : null;
    if (enPedido) usadas.add(enPedido.linea);
    let precio = l.precio;
    let descuento = l.descuento;
    let origenPrecio = l.precio != null ? "albarán" : null;
    let origenDescuento = l.descuento != null ? "albarán" : null;
    let compra = null;
    if ((precio == null || descuento == null) && mejor && vendorNumber) {
      compra = await ultimaCompra(deps, token, mejor.numero, vendorNumber);
      if (precio == null && compra?.precio != null) {
        precio = compra.precio;
        origenPrecio = `última compra ${compra.factura}`;
      }
      if (descuento == null && compra) {
        descuento = compra.descuento;
        origenDescuento = `última compra ${compra.factura}`;
      }
    }
    propuestas.push({
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      codigoProveedor: l.codigoProveedor,
      articulo: mejor ? { numero: mejor.numero, descripcion: mejor.descripcion } : null,
      alternativas: alternativas.map((a) => ({ numero: a.numero, descripcion: a.descripcion })),
      precio,
      descuento: descuento == null ? 0 : descuento,
      origenPrecio,
      origenDescuento,
      enPedido: enPedido ? {
        cantidad: enPedido.cantidad,
        precio: enPedido.precio,
        descuento: enPedido.descuento,
        recibida: enPedido.recibida,
        facturada: enPedido.facturada,
      } : null,
    });
  }
  return propuestas;
}

function accionDe(pedido, propuestas) {
  const conArticulo = propuestas.filter((p) => p.articulo);
  if (!conArticulo.length) return "ninguna";
  if (!pedido) return "crear";
  if (conArticulo.some((p) => !p.enPedido)) return "anadir";
  return "ninguna";
}

async function resolverLectura(deps, token, lectura, otForzada) {
  const avisos = [];
  const otTexto = String(otForzada || lectura.ot || "").trim();
  let ot = null;
  if (otTexto) {
    ot = await buscarOt(deps, token, otTexto);
    if (!ot) avisos.push(`No encuentro la OT ${otTexto}.`);
  } else {
    avisos.push("El albarán no trae la OT. Escríbela para buscar el pedido.");
  }
  const busquedaProv = await buscarProveedor(deps, token, lectura.proveedor);
  if (busquedaProv.aviso) avisos.push(busquedaProv.aviso);
  const proveedor = busquedaProv.proveedor;
  const pedido = await buscarPedidoExistente(deps, token, {
    pedidoTexto: lectura.pedido,
    vendorNumber: proveedor?.numero || null,
    otCodigo: ot?.codigo || null,
  });
  if (!pedido && ot && proveedor) avisos.push("No hay un pedido de este proveedor con esta OT. Al confirmar se creará uno nuevo.");
  if (!pedido && ot && !proveedor) avisos.push("Sin el proveedor de Business Central no se puede crear el pedido.");
  const propuestas = await proponerLineas(deps, token, lectura, proveedor?.numero || pedido?.vendorNumber || null, pedido);
  if (pedido && lectura.albaran && pedido.albaran && norm(pedido.albaran) !== norm(lectura.albaran)) {
    avisos.push(`El albarán del PDF es ${lectura.albaran} y el pedido ${pedido.numero} tiene el ${pedido.albaran}.`);
  }
  const sinArticulo = propuestas.filter((p) => !p.articulo).length;
  if (sinArticulo) avisos.push(`${sinArticulo} línea(s) sin un artículo claro. Revísalas antes de crear nada.`);
  return {
    lectura,
    ot,
    proveedor,
    pedido,
    propuestas,
    accion: accionDe(pedido, propuestas),
    avisos,
  };
}

async function prepararRecepcionAlbaran(deps, body) {
  const token = await deps.obtenerTokenBC();
  let lecturas = Array.isArray(body.lecturas) ? body.lecturas.map(limpiarLectura) : null;
  if (!lecturas) {
    if (!body.base64) {
      const err = new Error("Falta el PDF.");
      err.status = 400;
      throw err;
    }
    const bytes = Buffer.from(body.base64, "base64");
    lecturas = await extraerLecturas(bytes, deps.pdfDocument || null, deps.guardarVistaPdf || null);
  }
  if (!lecturas.length) {
    const err = new Error("No he podido leer líneas de material en el PDF.");
    err.status = 400;
    throw err;
  }
  const documentos = [];
  for (const lectura of lecturas) {
    const doc = await resolverLectura(deps, token, lectura, body.ot);
    doc.pdfVista = lectura.pdfVista || null;
    documentos.push(doc);
  }
  let pdfVista = null;
  if (body.base64 && deps.guardarVistaPdf) {
    try { pdfVista = deps.guardarVistaPdf(Buffer.from(body.base64, "base64")); } catch { pdfVista = null; }
  }
  return { documentos, pdfVista };
}

async function crearPedidoPreparado(deps, body) {
  const lineas = (Array.isArray(body.lineas) ? body.lineas : []).filter((l) => l.codigo && Number(l.cantidad) > 0);
  if (!lineas.length) throw Object.assign(new Error("No hay líneas de artículo para crear."), { status: 400 });
  const ot = String(body.ot || "").trim();
  if (!ot) throw Object.assign(new Error("Falta la OT."), { status: 400 });
  const token = await deps.obtenerTokenBC();
  const cabeceras = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
  const base = raizApi(deps);
  const avisos = [];
  let numero = String(body.pedidoExistente || "").trim();
  let idPedido = null;
  let reabierto = false;

  if (numero) {
    const ya = await buscarPedidoExistente(deps, token, { pedidoTexto: numero });
    const codigos = new Set((ya?.lineas || []).map((l) => l.codigo).filter(Boolean));
    const nuevas = lineas.filter((l) => !codigos.has(String(l.codigo).trim()));
    if (!nuevas.length) {
      return { numero, creado: false, lineas: [], avisos: ["Esas líneas ya están en el pedido. No se ha creado nada."] };
    }
    lineas.length = 0;
    lineas.push(...nuevas);
    const rBusca = await bcJson(deps.fetchConReintento, `${base}/purchaseOrders?$filter=${encodeURIComponent(`number eq '${numero.replace(/'/g, "''")}'`)}&$select=id,number,status&$top=1`, token);
    idPedido = rBusca.json?.value?.[0]?.id || null;
    if (!idPedido) throw new Error(`No encuentro el pedido ${numero}.`);
    if (deps.reabrirPedidoCompraSiLanzado) {
      const prep = await deps.reabrirPedidoCompraSiLanzado(idPedido, token);
      if (!prep.ok) throw new Error(prep.error || "No se ha podido reabrir el pedido.");
      reabierto = !!prep.reabierto;
      if (reabierto) avisos.push("El pedido estaba lanzado y se ha reabierto para añadir las líneas.");
    }
  } else {
    const vendorNumber = String(body.vendorNumber || "").trim();
    if (!vendorNumber) throw Object.assign(new Error("Falta el proveedor."), { status: 400 });
    const repetido = await buscarPedidoExistente(deps, token, { vendorNumber, otCodigo: ot });
    if (repetido) {
      const codigos = new Set(repetido.lineas.map((l) => l.codigo).filter(Boolean));
      if (lineas.every((l) => codigos.has(String(l.codigo).trim()))) {
        return { numero: repetido.numero, creado: false, lineas: [], avisos: [`Ya existe el pedido ${repetido.numero} con estas líneas. No se ha creado otro.`] };
      }
    }
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha || "")) ? body.fecha : new Date().toISOString().slice(0, 10);
    const rCab = await deps.fetchConReintento(`${base}/purchaseOrders`, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({ vendorNumber, orderDate: fecha }),
    });
    if (!rCab.ok) throw new Error(`Business Central ha respondido ${rCab.status} al crear el pedido: ${(await rCab.text().catch(() => "")).slice(0, 220)}`);
    const cab = await rCab.json();
    numero = cab.number;
    idPedido = cab.id;
    if (deps.escribirOtPedidoCompra) {
      const mal = await deps.escribirOtPedidoCompra(numero, ot, token);
      if (mal) avisos.push(mal);
    }
    if (body.departamento) {
      const raiz = raizOData(deps);
      const servicio = encodeURIComponent(deps.servicioPedidos || "Pedido_compra_Excel");
      const clave = `(Document_Type='Order',No='${String(numero).replace(/'/g, "''")}')`;
      const rDim = await deps.fetchConReintento(`${raiz}/${servicio}${clave}`, {
        method: "PATCH",
        headers: { ...cabeceras, "If-Match": "*" },
        body: JSON.stringify({ Shortcut_Dimension_1_Code: body.departamento }),
      });
      if (!rDim.ok) avisos.push(`No se ha podido poner el departamento ${body.departamento} en la cabecera.`);
    }
    if (body.albaran && deps.escribirAlbaranPedido) {
      const malAlb = await deps.escribirAlbaranPedido(numero, body.albaran, token);
      if (malAlb) avisos.push(malAlb);
    }
  }

  const creadas = [];
  for (const l of lineas) {
    const info = { codigo: l.codigo, ok: false };
    try {
      const cuerpo = {
        documentId: idPedido,
        lineType: "Item",
        lineObjectNumber: String(l.codigo).trim(),
        quantity: Number(l.cantidad),
      };
      if (l.precio != null && l.precio !== "" && Number.isFinite(Number(l.precio))) cuerpo.directUnitCost = Number(l.precio);
      if (l.descripcion) cuerpo.description = String(l.descripcion).slice(0, 100);
      const r = await deps.fetchConReintento(`${base}/purchaseOrderLines`, {
        method: "POST",
        headers: cabeceras,
        body: JSON.stringify(cuerpo),
      });
      if (!r.ok) throw new Error((await r.text().catch(() => "")).slice(0, 220) || `BC ${r.status}`);
      const creada = await r.json();
      info.ok = true;
      const dto = Number(l.descuento);
      if (Number.isFinite(dto) && dto > 0) {
        const rDto = await deps.fetchConReintento(`${base}/purchaseOrderLines(${creada.id})`, {
          method: "PATCH",
          headers: { ...cabeceras, "If-Match": "*" },
          body: JSON.stringify({ discountPercent: dto }),
        });
        if (!rDto.ok) info.aviso = "La línea se ha creado, pero el descuento no se ha guardado.";
      }
      if (deps.ponerOtEnLineaApi) {
        const mal = await deps.ponerOtEnLineaApi(creada.id, { ot, depto: body.departamento || null }, token);
        if (mal) info.aviso = [info.aviso, mal].filter(Boolean).join(" ");
      }
    } catch (e) {
      info.error = String(e.message || e);
    }
    creadas.push(info);
  }

  if (reabierto && deps.lanzarPedidoCompra && idPedido) {
    const rel = await deps.lanzarPedidoCompra(idPedido, token);
    if (!rel.ok) avisos.push(rel.error || "No se ha podido volver a lanzar el pedido.");
  }

  let adjunto = null;
  const pdfBytes = await bytesPdfParaAdjuntar(deps, body);
  if (pdfBytes && idPedido) {
    adjunto = await adjuntarPdfPedidoCompra(deps, token, idPedido, numero, pdfBytes, body.nombreArchivo);
    if (!adjunto.ok) avisos.push(adjunto.error || "No se ha podido adjuntar el PDF al pedido.");
  } else if (body.pdfVista || body.pdfBase64) {
    avisos.push("No se ha podido adjuntar el PDF: falta el pedido o la vista del documento ha caducado. Vuelve a subir el PDF.");
  }

  return { numero, creado: !body.pedidoExistente, lineas: creadas, avisos, adjunto };
}

async function bytesPdfParaAdjuntar(deps, body) {
  if (body.pdfBase64) {
    try { return Buffer.from(String(body.pdfBase64), "base64"); } catch { return null; }
  }
  const id = String(body.pdfVista || "").trim();
  if (id && deps.leerVistaPdf) {
    try { return deps.leerVistaPdf(id); } catch { return null; }
  }
  return null;
}

async function adjuntarPdfPedidoCompra(deps, token, idPedido, numero, bytes, nombreArchivo) {
  const cabeceras = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const base = raizApi(deps);
  const urlColeccion = `${base}/attachments`;
  const nombre = String(nombreArchivo || `${numero || "albaran"}.pdf`).replace(/[\\/]/g, "_").slice(0, 180);
  const bin = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const intentos = [];

  try {
    const rCrearA = await deps.fetchConReintento(urlColeccion, {
      method: "POST",
      headers: { ...cabeceras, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: nombre,
        byteSize: bin.length,
        attachmentContent: bin.toString("base64"),
      }),
    });
    if (rCrearA.ok) {
      const creadoA = await rCrearA.json();
      const rEnlazar = await deps.fetchConReintento(`${urlColeccion}(${creadoA.id})`, {
        method: "PATCH",
        headers: { ...cabeceras, "Content-Type": "application/json", "If-Match": creadoA["@odata.etag"] || "*" },
        body: JSON.stringify({ parentType: "Purchase Order", parentId: idPedido }),
      });
      if (rEnlazar.ok) return { ok: true, via: "A" };
      intentos.push(`A: ${(await rEnlazar.text().catch(() => "")).slice(0, 160)}`);
    } else {
      intentos.push(`A: ${(await rCrearA.text().catch(() => "")).slice(0, 160)}`);
    }
  } catch (e) {
    intentos.push(`A: ${String(e.message || e)}`);
  }

  try {
    const rCrearB = await deps.fetchConReintento(urlColeccion, {
      method: "POST",
      headers: { ...cabeceras, "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: nombre,
        parentType: "Purchase Order",
        parentId: idPedido,
      }),
    });
    if (rCrearB.ok) {
      const creadoB = await rCrearB.json();
      const rContenido = await deps.fetchConReintento(`${urlColeccion}(${creadoB.id})/attachmentContent`, {
        method: "PATCH",
        headers: { ...cabeceras, "Content-Type": "application/pdf", "If-Match": creadoB["@odata.etag"] || "*" },
        body: bin,
      });
      if (rContenido.ok) return { ok: true, via: "B" };
      intentos.push(`B: ${(await rContenido.text().catch(() => "")).slice(0, 160)}`);
    } else {
      intentos.push(`B: ${(await rCrearB.text().catch(() => "")).slice(0, 160)}`);
    }
  } catch (e) {
    intentos.push(`B: ${String(e.message || e)}`);
  }

  return { ok: false, error: `No se ha podido adjuntar el PDF al pedido ${numero || ""}. ${intentos.join(" · ")}`.trim() };
}

function familiaArticuloNuevo(descripcion) {
  const t = String(descripcion || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\blaton\b/.test(t)) return { cat1: "Fontaneria", cat2: "Tuberia y accesorios", cat3: "Accesorios y racorería - Latón" };
  if (/\bcobre\b/.test(t)) return { cat1: "Fontaneria", cat2: "Tuberia y accesorios", cat3: "Accesorios y racorería - Cobre" };
  if (/\bbronce\b/.test(t)) return { cat1: "Fontaneria", cat2: "Tuberia y accesorios", cat3: "Accesorios y racoreria - Bronce" };
  return null;
}

module.exports = {
  prepararRecepcionAlbaran,
  crearPedidoPreparado,
  puntuarArticulo,
  encajarArticulo,
  familiaArticuloNuevo,
};
