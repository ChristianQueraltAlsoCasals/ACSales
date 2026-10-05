/**
 * Notas y registro de correos de Pedidos de venta (por OT).
 * Mismo criterio que Recepción de material: nota interna con autor y fecha,
 * registro al enviar desde la app, y lectura del buzón (solo lectura) para
 * añadir a las notas los correos que mencionan la OT.
 *
 *   { notas: { [ot]: Nota[] }, enviados: { [ot]: { ts, veces, para } } }
 */
module.exports = function montarPedidosVentaSeguimiento({ app, db, claveEmpresa, obtenerTokenGraph, fetchConReintento, BUZON_PERSONAL }) {
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
};
