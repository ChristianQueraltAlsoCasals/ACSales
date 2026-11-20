/**
 * Panel inicial.
 *  · Importe facturado del mes: suma de facturas de venta registradas
 *    (base imponible), menos los abonos del mismo mes si los hay.
 *  · Pedidos de venta para revisar: albarán del mes cuyo parte de trabajo
 *    tiene material que no está en el albarán (o está con menos cantidad).
 *    Misma lectura de PDF que al abrir el albarán desde Partes pendientes.
 */
const fs = require("fs");
const path = require("path");
const { compararParteYAlbaran } = require("./compararParteAlbaran.cjs");

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function rangoMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const mm = String(mo).padStart(2, "0");
  return {
    mes: `${y}-${mm}`,
    nombre: `${MESES[mo - 1]} ${y}`,
    desde: `${y}-${mm}-01`,
    hasta: `${y}-${mm}-${String(ultimo).padStart(2, "0")}`,
  };
}

function codigoParteAlso(externo) {
  const m = /^(\d+)\s*[-/]\s*(\d{2}|\d{4})$/.exec(String(externo || "").trim());
  if (!m) return "";
  const anio = m[2].length === 4 ? m[2].slice(-2) : m[2];
  return `${m[1]}-${anio}`;
}

function numeroAlbaran(number) {
  const m = String(number || "").match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : 0;
}

function redondo(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function anulada(doc) {
  const s = String(doc?.status || "").toLowerCase();
  return s === "canceled" || s === "cancelled" || s === "draft";
}

module.exports = function montarPanelInicial({ app, obtenerTokenBC, fetchConReintento, EMPRESA_ID, leerPdfBC, fetchParteAlso }) {
  const cacheFacturado = new Map();
  const cacheComparacion = new Map();
  const erroresSesion = new Map();
  const listasMes = new Map();
  const enCurso = new Map();

  const dirCache = path.join(__dirname, "data", "panel-inicial");

  function rutaCache() {
    const seguro = String(EMPRESA_ID() || "defecto").replace(/[^\w.-]/g, "_");
    return path.join(dirCache, `${seguro}.json`);
  }

  function cargarDisco() {
    const id = String(EMPRESA_ID() || "");
    if ([...cacheComparacion.keys()].some((k) => k.startsWith(`${id}|`))) return;
    try {
      const guardado = JSON.parse(fs.readFileSync(rutaCache(), "utf8"));
      for (const [k, v] of Object.entries(guardado || {})) {
        cacheComparacion.set(`${id}|${k}`, v);
      }
    } catch { /* aún no hay comparaciones guardadas */ }
  }

  function guardarDisco() {
    const id = String(EMPRESA_ID() || "");
    const pref = `${id}|`;
    const out = {};
    for (const [k, v] of cacheComparacion) {
      if (k.startsWith(pref) && v && !v.error) out[k.slice(pref.length)] = v;
    }
    try {
      fs.mkdirSync(dirCache, { recursive: true });
      fs.writeFileSync(rutaCache(), JSON.stringify(out));
    } catch (err) {
      console.warn("[panel] no se ha podido guardar la comparación:", err.message);
    }
  }

  function baseBC() {
    return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  }

  async function odataTodo(url, token, tope) {
    const out = [];
    let siguiente = url;
    while (siguiente && out.length < tope) {
      const r = await fetchConReintento(siguiente, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const detalle = await r.text().catch(() => "");
        const err = new Error(`BC respondió ${r.status}`);
        err.status = r.status;
        err.detalle = detalle.slice(0, 400);
        throw err;
      }
      const j = await r.json();
      out.push(...(j.value || []));
      siguiente = j["@odata.nextLink"] || "";
    }
    return out;
  }

  async function leerColeccion(token, entidad, campoFecha, desde, hasta, campos) {
    const filtro = encodeURIComponent(`${campoFecha} ge ${desde} and ${campoFecha} le ${hasta}`);
    const select = encodeURIComponent(campos);
    const url = `${baseBC()}/${entidad}?$select=${select}&$filter=${filtro}`;
    return odataTodo(url, token, 8000);
  }

  app.get("/api/panel/facturado", async (req, res) => {
    const rango = rangoMes(req.query.mes);
    if (!rango) return res.status(400).json({ error: "Indica el mes como YYYY-MM." });
    const clave = `${EMPRESA_ID()}|${rango.mes}`;
    const fresco = req.query.refrescar === "1";
    const hit = cacheFacturado.get(clave);
    if (!fresco && hit && Date.now() - hit.ts < 10 * 60 * 1000) return res.json(hit.dato);
    try {
      const token = await obtenerTokenBC();
      const campos = "number,invoiceDate,status,totalAmountExcludingTax,totalAmountIncludingTax";
      const camposAbono = "number,creditMemoDate,status,totalAmountExcludingTax,totalAmountIncludingTax";
      const [facturas, abonos] = await Promise.all([
        leerColeccion(token, "salesInvoices", "invoiceDate", rango.desde, rango.hasta, campos),
        leerColeccion(token, "salesCreditMemos", "creditMemoDate", rango.desde, rango.hasta, camposAbono).catch((err) => {
          console.warn("[panel] abonos:", err.message);
          return [];
        }),
      ]);
      const fac = facturas.filter((f) => !anulada(f));
      const abo = abonos.filter((f) => !anulada(f));
      const base = redondo(fac.reduce((a, f) => a + (Number(f.totalAmountExcludingTax) || 0), 0));
      const conIva = redondo(fac.reduce((a, f) => a + (Number(f.totalAmountIncludingTax) || 0), 0));
      const abonosBase = redondo(abo.reduce((a, f) => a + (Number(f.totalAmountExcludingTax) || 0), 0));
      const abonosConIva = redondo(abo.reduce((a, f) => a + (Number(f.totalAmountIncludingTax) || 0), 0));
      const dato = {
        mes: rango.mes,
        nombre: rango.nombre,
        desde: rango.desde,
        hasta: rango.hasta,
        nFacturas: fac.length,
        base,
        conIva,
        nAbonos: abo.length,
        abonosBase,
        abonosConIva,
        neto: redondo(base - abonosBase),
      };
      cacheFacturado.set(clave, { ts: Date.now(), dato });
      res.json(dato);
    } catch (err) {
      res.status(502).json({
        error: "No se ha podido leer el importe facturado en Business Central.",
        detalle: err.detalle || String(err.message || err),
      });
    }
  });

  function agruparPedidos(shipments) {
    const porPedido = new Map();
    for (const s of shipments) {
      const ped = String(s.orderNumber || "").trim() || `alb:${s.number || s.id}`;
      const lista = porPedido.get(ped) || [];
      lista.push(s);
      porPedido.set(ped, lista);
    }
    const conParte = [];
    let sinParte = 0;
    for (const [pedido, lista] of porPedido) {
      let principal = lista[0];
      for (const s of lista) {
        if (numeroAlbaran(s.number) >= numeroAlbaran(principal.number)) principal = s;
      }
      const externos = [principal, ...lista.filter((s) => s !== principal)]
        .map((s) => String(s.externalDocumentNumber || "").trim())
        .filter(Boolean);
      const externo = externos.find((e) => codigoParteAlso(e)) || externos[0] || "";
      const parte = codigoParteAlso(externo);
      if (!parte) {
        sinParte += 1;
        continue;
      }
      conParte.push({
        pedido: pedido.startsWith("alb:") ? "" : pedido,
        cliente: String(principal.customerName || "").trim(),
        fecha: String(principal.postingDate || "").slice(0, 10),
        albaran: String(principal.number || ""),
        albaranId: principal.id,
        externo,
        parte,
        otros: lista.filter((s) => s !== principal).map((s) => s.number).filter(Boolean),
      });
    }
    conParte.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(a.pedido).localeCompare(String(b.pedido)));
    return { conParte, sinParte };
  }

  async function candidatosDelMes(token, rango, fresco) {
    const clave = `${EMPRESA_ID()}|${rango.mes}`;
    const hit = listasMes.get(clave);
    if (!fresco && hit && Date.now() - hit.ts < 15 * 60 * 1000) return hit;
    const campos = "id,number,externalDocumentNumber,orderNumber,postingDate,customerName";
    const filtro = encodeURIComponent(`postingDate ge ${rango.desde} and postingDate le ${rango.hasta}`);
    let shipments;
    try {
      shipments = await odataTodo(
        `${baseBC()}/salesShipments?$select=${encodeURIComponent(campos)}&$filter=${filtro}`,
        token,
        4000
      );
    } catch (err) {
      if (err.status !== 400) throw err;
      shipments = await odataTodo(
        `${baseBC()}/salesShipments?$select=${encodeURIComponent("id,number,externalDocumentNumber,orderNumber,postingDate")}&$filter=${filtro}`,
        token,
        4000
      );
    }
    const agrupado = agruparPedidos(shipments);
    const dato = { ts: Date.now(), nAlbaranes: shipments.length, ...agrupado };
    listasMes.set(clave, dato);
    return dato;
  }

  function claveCmp(item) {
    return `${EMPRESA_ID()}|${item.albaran}|${item.parte}`;
  }

  async function pdfAlbaran(token, id) {
    const raiz = `${baseBC()}/salesShipments(${id})/pdfDocument/pdfDocumentContent`;
    const auth = { Authorization: `Bearer ${token}` };
    let ultimo = "Business Central no ha devuelto el PDF del albarán.";
    for (const accept of ["application/pdf", "application/octet-stream"]) {
      const got = await leerPdfBC(raiz, { ...auth, Accept: accept });
      if (got.ok) return Buffer.from(got.base64, "base64");
      ultimo = got.error || got.detalle || ultimo;
    }
    throw new Error(ultimo);
  }

  async function pdfParte(externo) {
    const codigo = codigoParteAlso(externo);
    const url = `https://app.alsocasals.com/ALSO/generarPartePDF.php?parte=${encodeURIComponent(codigo)}&noFeina=1`;
    const r = await fetchParteAlso(url);
    if (!r.ok) throw new Error(`No se ha podido descargar el parte ${codigo} (respuesta ${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error(`El parte ${codigo} no ha llegado como PDF.`);
    }
    return buf;
  }

  async function compararUno(token, item) {
    const k = claveCmp(item);
    try {
      const [albaranBuf, parteBuf] = await Promise.all([
        pdfAlbaran(token, item.albaranId),
        pdfParte(item.externo),
      ]);
      const cmp = await compararParteYAlbaran(albaranBuf, parteBuf);
      const guardado = {
        pedido: item.pedido,
        cliente: item.cliente,
        fecha: item.fecha,
        albaran: item.albaran,
        externo: item.externo,
        parte: item.parte,
        otros: item.otros,
        falta: cmp.falta || [],
        texto: cmp.texto || "",
        cuadra: !!cmp.cuadra,
      };
      cacheComparacion.set(k, guardado);
      erroresSesion.delete(k);
      return guardado;
    } catch (err) {
      const aviso = {
        pedido: item.pedido,
        cliente: item.cliente,
        fecha: item.fecha,
        albaran: item.albaran,
        parte: item.parte,
        texto: String(err.message || err),
      };
      erroresSesion.set(k, aviso);
      return null;
    }
  }

  function foto(lista, sinParte, nAlbaranes) {
    const pedidos = [];
    const avisos = [];
    let revisados = 0;
    let cuadran = 0;
    for (const item of lista) {
      const k = claveCmp(item);
      const ok = cacheComparacion.get(k);
      const mal = erroresSesion.get(k);
      if (ok) {
        revisados += 1;
        if (ok.falta?.length) pedidos.push(ok);
        else cuadran += 1;
      } else if (mal) {
        revisados += 1;
        avisos.push(mal);
      }
    }
    pedidos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(a.pedido).localeCompare(String(b.pedido)));
    return {
      total: lista.length,
      sinParte,
      nAlbaranes,
      revisados,
      cuadran,
      terminado: revisados >= lista.length,
      pedidos,
      avisos,
    };
  }

  async function avanzar(rango, lote, fresco) {
    const clave = `${EMPRESA_ID()}|${rango.mes}`;
    if (enCurso.has(clave)) return enCurso.get(clave);
    const trabajo = (async () => {
      cargarDisco();
      const token = await obtenerTokenBC();
      const { conParte, sinParte, nAlbaranes } = await candidatosDelMes(token, rango, fresco);
      if (fresco) {
        for (const item of conParte) {
          const k = claveCmp(item);
          cacheComparacion.delete(k);
          erroresSesion.delete(k);
        }
      }
      const pendientes = conParte.filter((item) => {
        const k = claveCmp(item);
        return !cacheComparacion.has(k) && !erroresSesion.has(k);
      });
      const trozo = pendientes.slice(0, lote);
      if (trozo.length) {
        await Promise.all(trozo.map((item) => compararUno(token, item)));
        guardarDisco();
      }
      return foto(conParte, sinParte, nAlbaranes);
    })();
    enCurso.set(clave, trabajo);
    try {
      return await trabajo;
    } finally {
      enCurso.delete(clave);
    }
  }

  app.get("/api/panel/pedidos-revisar", async (req, res) => {
    const rango = rangoMes(req.query.mes);
    if (!rango) return res.status(400).json({ error: "Indica el mes como YYYY-MM." });
    const lote = Math.min(4, Math.max(1, parseInt(req.query.lote, 10) || 2));
    const fresco = req.query.refrescar === "1";
    try {
      const dato = await avanzar(rango, lote, fresco);
      res.json({ mes: rango.mes, nombre: rango.nombre, ...dato });
    } catch (err) {
      console.error("[panel] pedidos-revisar:", err);
      res.status(502).json({
        error: "No se han podido revisar los pedidos de venta.",
        detalle: err.detalle || String(err.message || err),
      });
    }
  });
};
