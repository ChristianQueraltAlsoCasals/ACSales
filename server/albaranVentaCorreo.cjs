/**
 * Albarán de venta desde correo (caso Kronospan / OC cliente).
 *
 * Flujo Also Casals (Maria):
 *  1) Leer adjuntos del correo (sobre todo la OC del cliente).
 *  2) Crear pedido de venta: comentarios (OC + texto presupuesto) +
 *     líneas Cuenta 70000000 (cant. 1 × importe de cada partida de la OC),
 *     vendedor MRC, Nº documento externo = nº OC (no el PV).
 *  3) Registrar SOLO envío (invoiceQuantity=0 + shipAndInvoice).
 *  4) Descargar el PDF del albarán (salesShipments/pdfDocument).
 */

const CUENTA_VENTA = "70000000";
const VENDEDOR = "MRC";

function registrarRutas({
  app,
  obtenerTokenBC,
  obtenerTokenGraph,
  fetchConReintento,
  EMPRESA_ID,
  EMPRESA_NOMBRE,
  buzonDelUsuario,
}) {
  function urlApiVenta() {
    return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0/companies(${EMPRESA_ID()})`;
  }

  function urlODataEmpresa() {
    const empresa = encodeURIComponent(EMPRESA_NOMBRE() || process.env.BC_COMPANY_NAME || "Also Casals");
    return `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${empresa}')`;
  }

  async function adjuntosDelMensaje(buzon, messageId, token) {
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/messages/${encodeURIComponent(messageId)}`;
    const r = await fetchConReintento(`${base}/attachments?$select=id,name,contentType,size,isInline`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Graph ${r.status} listando adjuntos: ${(await r.text()).slice(0, 250)}`);
    const lista = (await r.json()).value || [];
    const out = [];
    for (const a of lista) {
      if (a.isInline) continue;
      const nombre = String(a.name || "adjunto");
      if (!/\.pdf$/i.test(nombre) && !/pdf/i.test(a.contentType || "")) continue;
      const rc = await fetchConReintento(`${base}/attachments/${encodeURIComponent(a.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!rc.ok) continue;
      const j = await rc.json();
      if (!j.contentBytes) continue;
      out.push({
        id: a.id,
        nombre,
        mime: a.contentType || "application/pdf",
        base64: String(j.contentBytes).replace(/\s/g, ""),
        bytes: Number(a.size) || 0,
      });
    }
    return out;
  }

  async function buscarCliente(token, { cif, nombre }) {
    const base = `${urlApiVenta()}/customers`;
    const h = { Authorization: `Bearer ${token}` };
    const esc = (v) => String(v || "").replace(/'/g, "''");
    if (cif) {
      const cifLimpio = String(cif).replace(/[\s.-]/g, "").toUpperCase().replace(/^ES/, "");
      const filtros = [
        `number eq '${esc(cifLimpio)}'`,
        `number eq '${esc("ES" + cifLimpio)}'`,
        `taxRegistrationNumber eq '${esc(cifLimpio)}'`,
        `taxRegistrationNumber eq '${esc("ES" + cifLimpio)}'`,
      ];
      for (const f of filtros) {
        const r = await fetchConReintento(`${base}?$filter=${encodeURIComponent(f)}&$top=1`, { headers: h });
        if (!r.ok) continue;
        const v = ((await r.json()).value || [])[0];
        if (v) return { number: v.number, name: v.displayName, id: v.id };
      }
    }
    if (nombre) {
      const r = await fetchConReintento(
        `${base}?$filter=${encodeURIComponent(`contains(displayName,'${esc(String(nombre).slice(0, 40))}')`)}&$top=5`,
        { headers: h }
      );
      if (r.ok) {
        const vals = (await r.json()).value || [];
        if (vals.length === 1) return { number: vals[0].number, name: vals[0].displayName, id: vals[0].id };
        const exacto = vals.find((v) => String(v.displayName || "").toUpperCase() === String(nombre).toUpperCase());
        if (exacto) return { number: exacto.number, name: exacto.displayName, id: exacto.id };
        if (vals[0]) return { number: vals[0].number, name: vals[0].displayName, id: vals[0].id, aviso: "Cliente elegido por coincidencia parcial de nombre." };
      }
    }
    return null;
  }

  async function proponerDesdePdfs({ adjuntos, asunto, cuerpo }) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY en .env.");
    const docs = (adjuntos || []).filter((a) => a?.base64).slice(0, 4);
    if (!docs.length) throw new Error("No hay PDFs adjuntos en el correo para leer la orden de compra.");

    const content = [
      {
        type: "text",
        text:
          "Eres un asistente de Also Casals. La cliente pide un ALBARÁN de venta. Debes leer los PDFs " +
          "(prioridad: la ORDEN DE COMPRA / purchase order del cliente; la oferta Also Casals sirve de apoyo) " +
          "y devolver SOLO un JSON con este esquema:\n" +
          "{\n" +
          '  "ocCliente": "número OC del cliente (ej. 430039, sin PO)",\n' +
          '  "oferta": "nº oferta Also si aparece (ej. 526/2026) o null",\n' +
          '  "clienteNombre": "razón social del cliente",\n' +
          '  "clienteCif": "CIF/NIF sin espacios",\n' +
          '  "comentarioOc": "Orden de comp. {ocCliente}",\n' +
          '  "comentarioTrabajo": "frase tipo: Factura del presupuesto {oferta} correspondiente a …",\n' +
          '  "lineas": [\n' +
          '    { "descripcion": "texto de la partida en la OC (ej. M.O. REPARACIÓN)", "importe": 150.75 }\n' +
          "  ],\n" +
          '  "total": 183.33\n' +
          "}\n\n" +
          "REGLAS Also Casals (imprescindibles):\n" +
          "- Cada partida de la OC → UNA línea con cantidad implícita 1 e importe = TOTAL de esa partida en la OC (NO desglosar horas × tarifa).\n" +
          "- descripcion = SOLO el título corto de la partida en la OC (ej. «M.O. REPARACIÓN», «MATERIALES VARIOS MANTENIMIENTO»). " +
          "NO añadas guiones ni el detalle de debajo (no pongas «- Mano de obra…» ni «- 1 ud. Entroque…»).\n" +
          "- comentarioOc exactamente «Orden de comp. » + número OC.\n" +
          "- comentarioTrabajo estilo: «Factura del presupuesto {oferta} correspondiente a {trabajo}».\n" +
          "- total = suma exacta de los importes de lineas (ej. 150.75+32.58=183.33). No uses el «valor total» neto si difiere.\n" +
          "- Ignora protocolos T002 / firmas si no aportan partidas.\n" +
          "- Importes sin IVA, con punto decimal.\n" +
          "- Si hay varias OC, elige la que cita el correo.\n\n" +
          `Asunto del correo: ${asunto || ""}\n` +
          `Cuerpo (recortado): ${String(cuerpo || "").replace(/<[^>]+>/g, " ").slice(0, 1500)}\n`,
      },
    ];
    for (const d of docs) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: d.base64 },
      });
      content.push({ type: "text", text: `(PDF adjunto: ${d.nombre})` });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Claude no ha devuelto un JSON usable.");
    let propuesta;
    try {
      propuesta = JSON.parse(m[0]);
    } catch {
      throw new Error("JSON de Claude ilegible.");
    }
    const oc = String(propuesta.ocCliente || "").replace(/^PO/i, "").trim();
    const lineas = (Array.isArray(propuesta.lineas) ? propuesta.lineas : [])
      .map((l) => {
        let descripcion = String(l.descripcion || "").trim();
        // Also Casals: título corto de la OC, sin el detalle tras " - "
        const guion = descripcion.search(/\s[–-]\s/);
        if (guion > 0) descripcion = descripcion.slice(0, guion).trim();
        return {
          descripcion,
          importe: Math.round(Number(l.importe) * 100) / 100,
        };
      })
      .filter((l) => l.descripcion && l.importe > 0);
    if (!oc) throw new Error("No se ha podido leer el nº de OC del cliente.");
    if (!lineas.length) throw new Error("No se han encontrado partidas con importe en la OC.");
    return {
      ocCliente: oc,
      oferta: propuesta.oferta || null,
      clienteNombre: String(propuesta.clienteNombre || "").trim(),
      clienteCif: String(propuesta.clienteCif || "").replace(/[\s.-]/g, "").toUpperCase().replace(/^ES/, ""),
      comentarioOc: String(propuesta.comentarioOc || `Orden de comp. ${oc}`).trim(),
      comentarioTrabajo: String(propuesta.comentarioTrabajo || "").trim(),
      lineas,
      total: Math.round(lineas.reduce((s, l) => s + l.importe, 0) * 100) / 100,
      cuenta: CUENTA_VENTA,
      vendedor: VENDEDOR,
      pdfsLeidos: docs.map((d) => d.nombre),
    };
  }

  async function ponerSuNtraRef(numeroPv, ocCliente, token) {
    const raiz = urlODataEmpresa();
    const esc = String(numeroPv).replace(/'/g, "''");
    const url = `${raiz}/Pedido_venta_Excel('${esc}')`;
    const r = await fetchConReintento(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": "*",
      },
      body: JSON.stringify({ Your_Reference: String(ocCliente), External_Document_No: String(ocCliente) }),
    });
    if (!r.ok) {
      return `No se pudo escribir Su/Ntra. ref. ${ocCliente} en Pedido_venta_Excel: ${r.status}`;
    }
    return null;
  }

  async function crearYRegistrar(propuesta) {
    const token = await obtenerTokenBC();
    const base = urlApiVenta();
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const cliente = await buscarCliente(token, { cif: propuesta.clienteCif, nombre: propuesta.clienteNombre });
    if (!cliente?.number) throw new Error(`No encuentro el cliente «${propuesta.clienteNombre || propuesta.clienteCif}» en BC.`);

    const rCab = await fetchConReintento(`${base}/salesOrders`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        customerNumber: cliente.number,
        externalDocumentNumber: String(propuesta.ocCliente),
        salesperson: VENDEDOR,
      }),
    });
    if (!rCab.ok) throw new Error(`BC ${rCab.status} creando el PV: ${(await rCab.text()).slice(0, 300)}`);
    const cab = await rCab.json();
    const avisos = [];
    if (cliente.aviso) avisos.push(cliente.aviso);

    const avisoRef = await ponerSuNtraRef(cab.number, propuesta.ocCliente, token);
    if (avisoRef) avisos.push(avisoRef);

    const comentarios = [propuesta.comentarioOc, propuesta.comentarioTrabajo].filter(Boolean);
    for (const texto of comentarios) {
      const r = await fetchConReintento(`${base}/salesOrderLines`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ documentId: cab.id, lineType: "Comment", description: texto.slice(0, 100) }),
      });
      if (!r.ok) avisos.push(`Comentario «${texto.slice(0, 40)}…»: BC ${r.status}`);
    }
    for (const l of propuesta.lineas) {
      const r = await fetchConReintento(`${base}/salesOrderLines`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          documentId: cab.id,
          lineType: "Account",
          lineObjectNumber: CUENTA_VENTA,
          description: l.descripcion.slice(0, 100),
          quantity: 1,
          unitPrice: Number(l.importe),
        }),
      });
      if (!r.ok) throw new Error(`BC ${r.status} creando línea «${l.descripcion}»: ${(await r.text()).slice(0, 250)}`);
    }

    // Solo envío (albarán), sin factura
    const rLines = await fetchConReintento(`${base}/salesOrders(${cab.id})/salesOrderLines`, { headers: h });
    if (!rLines.ok) throw new Error(`BC ${rLines.status} leyendo líneas del PV.`);
    const lineasBc = (await rLines.json()).value || [];
    for (const l of lineasBc) {
      if (l.lineType !== "Account") continue;
      const rp = await fetchConReintento(`${base}/salesOrderLines(${l.id})`, {
        method: "PATCH",
        headers: { ...h, "If-Match": "*" },
        body: JSON.stringify({ shipQuantity: Number(l.quantity) || 1, invoiceQuantity: 0 }),
      });
      if (!rp.ok) throw new Error(`BC ${rp.status} poniendo qty a enviar/facturar: ${(await rp.text()).slice(0, 250)}`);
    }

    const rShip = await fetchConReintento(`${base}/salesOrders(${cab.id})/Microsoft.NAV.shipAndInvoice`, {
      method: "POST",
      headers: h,
      body: "{}",
    });
    if (!rShip.ok) {
      throw new Error(`BC ${rShip.status} registrando el envío: ${(await rShip.text()).slice(0, 350)}`);
    }

    // Buscar albarán por orderNumber
    const filtro = encodeURIComponent(`orderNumber eq '${String(cab.number).replace(/'/g, "''")}'`);
    let shipment = null;
    for (let i = 0; i < 8 && !shipment; i++) {
      if (i) await new Promise((ok) => setTimeout(ok, 800));
      const rs = await fetchConReintento(`${base}/salesShipments?$filter=${filtro}&$top=3&$orderby=postingDate desc`, { headers: h });
      if (!rs.ok) continue;
      shipment = ((await rs.json()).value || [])[0] || null;
    }
    if (!shipment) throw new Error(`Pedido ${cab.number} registrado, pero no aparece aún el albarán en BC.`);

    const rPdf = await fetchConReintento(`${base}/salesShipments(${shipment.id})/pdfDocument/pdfDocumentContent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rPdf.ok) throw new Error(`BC ${rPdf.status} bajando el PDF del albarán: ${(await rPdf.text()).slice(0, 250)}`);
    const pdfBuf = Buffer.from(await rPdf.arrayBuffer());
    if (pdfBuf.slice(0, 4).toString() !== "%PDF") throw new Error("BC no ha devuelto un PDF de albarán.");

    return {
      ok: true,
      pedido: cab.number,
      pedidoId: cab.id,
      albaran: shipment.number,
      albaranId: shipment.id,
      cliente: { number: cliente.number, name: cliente.name },
      ocCliente: propuesta.ocCliente,
      total: propuesta.total,
      avisos,
      pdf: {
        nombre: `Albaran_${cab.number}.pdf`,
        mime: "application/pdf",
        base64: pdfBuf.toString("base64"),
        bytes: pdfBuf.length,
      },
    };
  }

  app.get("/api/buzon/mensaje/:id/adjuntos", async (req, res) => {
    if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en .env." });
    try {
      const buzon = await buzonDelUsuario(req, res);
      if (!buzon) return;
      const token = await obtenerTokenGraph();
      const adjuntos = await adjuntosDelMensaje(buzon, req.params.id, token);
      res.json({
        adjuntos: adjuntos.map(({ id, nombre, mime, bytes, base64 }) => ({
          id, nombre, mime, bytes, base64,
        })),
      });
    } catch (err) {
      console.error("[albaran-venta] adjuntos:", err);
      res.status(500).json({ error: "No se han podido leer los adjuntos.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/correo/albaran-venta/proponer", async (req, res) => {
    try {
      const buzon = await buzonDelUsuario(req, res);
      if (!buzon) return;
      const messageId = String(req.body?.messageId || "").trim();
      const asunto = String(req.body?.asunto || "");
      const cuerpo = String(req.body?.cuerpo || "");
      let adjuntos = Array.isArray(req.body?.adjuntos) ? req.body.adjuntos : [];
      if (messageId && !adjuntos.length) {
        const token = await obtenerTokenGraph();
        adjuntos = await adjuntosDelMensaje(buzon, messageId, token);
      }
      const propuesta = await proponerDesdePdfs({ adjuntos, asunto, cuerpo });
      const tokenBc = await obtenerTokenBC();
      const cliente = await buscarCliente(tokenBc, { cif: propuesta.clienteCif, nombre: propuesta.clienteNombre });
      res.json({
        ok: true,
        propuesta: {
          ...propuesta,
          clienteBc: cliente,
        },
      });
    } catch (err) {
      console.error("[albaran-venta] proponer:", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/correo/albaran-venta/crear", async (req, res) => {
    try {
      const p = req.body?.propuesta || req.body || {};
      if (!p.ocCliente || !Array.isArray(p.lineas) || !p.lineas.length) {
        return res.status(400).json({ error: "Falta la propuesta (ocCliente + lineas)." });
      }
      const resultado = await crearYRegistrar({
        ocCliente: String(p.ocCliente).replace(/^PO/i, "").trim(),
        oferta: p.oferta || null,
        clienteNombre: p.clienteNombre || p.clienteBc?.name || "",
        clienteCif: p.clienteCif || p.clienteBc?.number || "",
        comentarioOc: p.comentarioOc || `Orden de comp. ${p.ocCliente}`,
        comentarioTrabajo: p.comentarioTrabajo || "",
        lineas: p.lineas,
        total: p.total,
      });
      res.json(resultado);
    } catch (err) {
      console.error("[albaran-venta] crear:", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });
}

module.exports = { registrarRutas, CUENTA_VENTA, VENDEDOR };
