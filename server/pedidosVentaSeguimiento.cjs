/**
 * Notas y registro de correos de Pedidos de venta (por OT).
 * Mismo criterio que Recepción de material: nota interna con autor y fecha,
 * registro al enviar desde la app, y lectura del buzón (solo lectura) para
 * añadir a las notas los correos que mencionan la OT.
 *
 *   { notas: { [ot]: Nota[] }, enviados: { [ot]: { ts, veces, para } } }
 */
module.exports = function montarPedidosVentaSeguimiento({ app, db, claveEmpresa, obtenerTokenGraph, fetchConReintento, BUZON_PERSONAL, buzonDelUsuario }) {
  const DEF = { notas: {}, enviados: {} };
  const leer = async () => db.getDoc(claveEmpresa("pedidos_venta_seguimiento"), { ...DEF, notas: {}, enviados: {} });
  const escribir = async (d) => db.setDoc(claveEmpresa("pedidos_venta_seguimiento"), d);

  const textoPlano = (html) => String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

  app.get("/api/pedidos-venta/seguimiento", async (req, res) => {
    try {
      const d = await leer();
      res.json({ notas: d.notas || {}, enviados: d.enviados || {} });
    } catch (err) {
      res.status(500).json({ error: "No se pudo leer el seguimiento.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/pedidos-venta/nota", async (req, res) => {
    const ot = String(req.body?.ot || "").trim();
    const texto = String(req.body?.texto || "").trim();
    const autor = String(req.body?.autor || "").trim() || "—";
    if (!ot || !texto) return res.status(400).json({ error: "Falta 'ot' o 'texto'." });
    try {
      const d = await leer();
      d.notas = d.notas || {};
      const nota = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toISOString(), autor, texto: texto.slice(0, 2000) };
      d.notas[ot] = [...(d.notas[ot] || []), nota];
      await escribir(d);
      res.json({ ok: true, notas: d.notas[ot] });
    } catch (err) {
      res.status(500).json({ error: "No se pudo guardar la nota.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/pedidos-venta/nota/borrar", async (req, res) => {
    const ot = String(req.body?.ot || "").trim();
    const id = String(req.body?.id || "").trim();
    if (!ot || !id) return res.status(400).json({ error: "Falta 'ot' o 'id'." });
    try {
      const d = await leer();
      d.notas = d.notas || {};
      d.notas[ot] = (d.notas[ot] || []).filter((n) => n.id !== id);
      if (!d.notas[ot].length) delete d.notas[ot];
      await escribir(d);
      res.json({ ok: true, notas: d.notas[ot] || [] });
    } catch (err) {
      res.status(500).json({ error: "No se pudo borrar la nota.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/pedidos-venta/enviado", async (req, res) => {
    const ot = String(req.body?.ot || "").trim();
    const para = String(req.body?.para || "").trim();
    if (!ot) return res.status(400).json({ error: "Falta 'ot'." });
    try {
      const d = await leer();
      d.enviados = d.enviados || {};
      const prev = d.enviados[ot] || {};
      const enviado = { ts: new Date().toISOString(), veces: (Number(prev.veces) || 0) + 1, para: para || prev.para || "" };
      d.enviados[ot] = enviado;
      await escribir(d);
      res.json({ ok: true, enviado });
    } catch (err) {
      res.status(500).json({ error: "No se pudo registrar el correo.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/pedidos-venta/correos", async (req, res) => {
    if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en .env." });
    const lista = Array.isArray(req.body?.ots) ? req.body.ots : [];
    const dias = Math.min(Math.max(Number(req.body?.dias) || 60, 1), 365);
    const ots = [];
    for (const item of lista) {
      const clave = String(item?.clave || "").trim();
      const patrones = [...new Set((item?.patrones || []).map((p) => String(p || "").trim()).filter((p) => p.length >= 4))];
      if (clave && patrones.length) ots.push({ clave, patrones });
    }
    if (!ots.length) return res.status(400).json({ error: "No hay OTs para buscar en el correo." });

    const menciona = (texto, patrones) => {
      const t = String(texto || "");
      return patrones.some((p) => {
        const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(t);
      });
    };

    try {
      const token = await obtenerTokenGraph();
      const buzon = BUZON_PERSONAL();
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 19) + "Z";
      const sel = "$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,conversationId,webLink,bodyPreview,body";
      let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}/messages?${sel}&$filter=receivedDateTime ge ${desde}&$top=100`;
      const mensajes = [];
      while (url && mensajes.length < 3000) {
        const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
        if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = await r.json();
        mensajes.push(...(j.value || []));
        url = j["@odata.nextLink"] || null;
      }

      const porHilo = {};
      const otsDe = new Map();
      for (const m of mensajes) {
        const texto = `${m.subject || ""}\n${textoPlano(m.body?.content || m.bodyPreview || "")}`;
        const claves = new Set();
        for (const ot of ots) if (menciona(texto, ot.patrones)) claves.add(ot.clave);
        otsDe.set(m.id, claves);
        if (claves.size && m.conversationId) {
          const s = (porHilo[m.conversationId] ||= new Set());
          claves.forEach((c) => s.add(c));
        }
      }

      const d = await leer();
      d.notas = d.notas || {};
      const yo = String(buzon).toLowerCase();
      let añadidas = 0;
      const tocados = new Set();
      for (const m of mensajes) {
        const claves = new Set([...(otsDe.get(m.id) || []), ...(porHilo[m.conversationId] || [])]);
        if (!claves.size) continue;
        const de = m.from?.emailAddress?.address || "";
        const enviado = de.toLowerCase() === yo;
        const para = (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean).join(", ");
        const fecha = enviado ? (m.sentDateTime || m.receivedDateTime) : m.receivedDateTime;
        const resumen = textoPlano(m.body?.content || m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300);
        const texto = `${enviado ? `Enviado a ${para || "—"}` : `De ${m.from?.emailAddress?.name || de}${de && m.from?.emailAddress?.name ? ` <${de}>` : ""}`} · «${m.subject || "(sin asunto)"}»\n${resumen}${resumen.length >= 300 ? "…" : ""}`;
        for (const clave of claves) {
          const actuales = d.notas[clave] || [];
          if (actuales.some((n) => n.correoId === m.id)) continue;
          actuales.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            ts: fecha || new Date().toISOString(),
            autor: "📧 Correo",
            texto: texto.slice(0, 2000),
            correoId: m.id,
            enlace: m.webLink || "",
          });
          actuales.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
          d.notas[clave] = actuales;
          añadidas++;
          tocados.add(clave);
        }
      }
      if (añadidas) await escribir(d);
      res.json({ leidos: mensajes.length, añadidas, ots: [...tocados], notas: d.notas });
    } catch (err) {
      console.error("Error /api/pedidos-venta/correos:", err);
      res.status(500).json({ error: "No se pudieron leer los correos.", detalle: String(err.message || err) });
    }
  });

  // Doc. extern (101026A-2026) → número de parte que va en el PDF (PR101026-26.pdf / PR101026-26M.pdf).
  const claveExterno = (externo) => {
    const m = /^(\d{4,7})([A-Za-z])?\s*[-/]\s*(\d{2}|\d{4})$/.exec(String(externo || "").trim());
    if (!m) return null;
    return { raw: String(externo).trim(), numero: m[1], letra: (m[2] || "").toUpperCase() };
  };
  const claveAdjunto = (nombre) => {
    const base = String(nombre || "").replace(/\.[^.]+$/, "");
    const m = /^PR(\d{4,7})([A-Za-z])?(?:-(\d{2})([A-Za-z])?)?$/i.exec(base);
    if (!m) return null;
    return { numero: m[1], marca: ((m[2] || "") + (m[4] || "")).toUpperCase() };
  };

  const cachePdf = new Map();

  app.post("/api/pedidos-venta/enviados-pdf", async (req, res) => {
    if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en .env." });
    const claves = [];
    const vistos = new Set();
    for (const item of Array.isArray(req.body?.externos) ? req.body.externos : []) {
      const c = claveExterno(item);
      if (!c || vistos.has(c.raw)) continue;
      vistos.add(c.raw);
      claves.push(c);
      if (claves.length >= 80) break;
    }
    if (!claves.length) return res.json({ enviados: {} });

    let buzon = "";
    try {
      buzon = buzonDelUsuario ? await buzonDelUsuario(req, res) : BUZON_PERSONAL();
    } catch (err) {
      return res.status(500).json({ error: "No se pudo saber el buzón.", detalle: String(err.message || err) });
    }
    if (!buzon) return;

    const firma = `${String(buzon).toLowerCase()}|${claves.map((c) => c.raw).sort().join(",")}`;
    const guardado = cachePdf.get(firma);
    if (guardado && guardado.exp > Date.now()) return res.json({ enviados: guardado.enviados, buzon });

    const porNumero = new Map();
    for (const c of claves) {
      const lista = porNumero.get(c.numero) || [];
      lista.push(c);
      porNumero.set(c.numero, lista);
    }

    try {
      const token = await obtenerTokenGraph();
      const headers = { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" };
      const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(buzon)}`;
      const numeros = [...porNumero.keys()];
      const mensajes = [];
      const ids = new Set();
      for (let i = 0; i < numeros.length; i += 12) {
        const trozo = numeros.slice(i, i + 12);
        const q = `"${trozo.map((n) => `PR${n}`).join(" OR ")}"`;
        let url = `${base}/mailFolders/sentitems/messages?$search=${encodeURIComponent(q)}&$select=id,subject,sentDateTime,toRecipients,ccRecipients,hasAttachments&$top=25`;
        let paginas = 0;
        while (url && paginas < 3 && mensajes.length < 60) {
          const r = await fetchConReintento(url, { headers });
          if (!r.ok) throw new Error(`Graph respondió ${r.status}: ${(await r.text()).slice(0, 250)}`);
          const j = await r.json();
          for (const m of j.value || []) {
            if (ids.has(m.id)) continue;
            ids.add(m.id);
            mensajes.push(m);
          }
          url = j["@odata.nextLink"] || "";
          paginas += 1;
        }
      }

      const conAdjunto = mensajes.filter((m) => m.hasAttachments);
      const nombres = new Map();
      const lote = 4;
      for (let i = 0; i < conAdjunto.length; i += lote) {
        const grupo = conAdjunto.slice(i, i + lote);
        const listas = await Promise.all(grupo.map(async (m) => {
          const r = await fetchConReintento(`${base}/messages/${m.id}/attachments?$select=name,isInline`, { headers });
          if (!r.ok) return [];
          const j = await r.json();
          return (j.value || []).filter((a) => !a.isInline).map((a) => String(a.name || ""));
        }));
        grupo.forEach((m, idx) => nombres.set(m.id, listas[idx]));
      }

      const enviados = {};
      for (const m of conAdjunto) {
        const para = (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean);
        const cc = (m.ccRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean);
        for (const nombre of nombres.get(m.id) || []) {
          const adj = claveAdjunto(nombre);
          if (!adj) continue;
          const candidatos = porNumero.get(adj.numero) || [];
          if (!candidatos.length) continue;
          const conLetra = candidatos.filter((c) => c.letra);
          const sinLetra = candidatos.filter((c) => !c.letra);
          const elegidos = conLetra.length && sinLetra.length
            ? (adj.marca ? conLetra : sinLetra)
            : candidatos;
          for (const c of elegidos) {
            const prev = enviados[c.raw];
            if (prev && String(prev.fecha) >= String(m.sentDateTime || "")) continue;
            enviados[c.raw] = {
              fecha: m.sentDateTime || "",
              para,
              cc,
              asunto: m.subject || "",
              adjunto: nombre,
            };
          }
        }
      }
      for (const c of claves) if (!(c.raw in enviados)) enviados[c.raw] = null;
      cachePdf.set(firma, { exp: Date.now() + 10 * 60 * 1000, enviados });
      res.json({ enviados, buzon });
    } catch (err) {
      console.error("Error /api/pedidos-venta/enviados-pdf:", err);
      res.status(500).json({ error: "No se pudo revisar el correo enviado.", detalle: String(err.message || err) });
    }
  });
};
