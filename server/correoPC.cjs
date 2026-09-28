/**
 * correoPC.cjs — Correos de los pedidos de compra → NOTAS de Recepción
 * de material (25/09/2026).
 *
 * POST /api/recepcion/correos  { pedidos: ["PC26-000123", …], dias: 60 }
 *   · Lee el buzón de Maria (M365_BUZON_PERSONAL), TODAS las carpetas
 *     (recibidos, enviados y demás) de los últimos N días, con Graph.
 *   · Busca menciones de pedidos «PCxx-xxxxxx» en asunto y texto. Si un
 *     mensaje de un HILO menciona el pedido, todo el hilo se asocia a él.
 *   · Añade a las notas del pedido (recepcion.json → notas) un resumen:
 *     fecha, de/para, asunto, primeras líneas y enlace a Outlook.
 *     Autor «📧 Correo». No duplica (guarda el id del correo).
 *   · Solo LECTURA del correo: no marca nada como leído ni mueve nada.
 */
module.exports = function montarCorreoPC({ app, obtenerTokenGraph, fetchConReintento, leerRecep, escribirRecep, BUZON_PERSONAL }) {
  // PC24-000003, PC23-00013, «PC 24-3», «pc24/000003»… → clave «24-3» para cruzar con los pedidos reales
  const RE_PC = /\bPC\s?(\d{2})\s?[-/]\s?0*(\d{1,7})\b/gi;
  const clavePC = (yy, n) => `${yy}-${Number(n)}`;

  const textoPlano = (html) => String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

  app.post("/api/recepcion/correos", async (req, res) => {
    if (!process.env.M365_CLIENT_SECRET) return res.status(503).json({ error: "Falta configurar M365_* en backend/.env." });
    const lista = Array.isArray(req.body?.pedidos) ? req.body.pedidos.map(String) : [];
    const dias = Math.min(Math.max(Number(req.body?.dias) || 60, 1), 365);
    // Pedidos conocidos: clave «yy-número» → Nº tal cual está en BC
    const conocidos = {};
    for (const p of lista) {
      const m = /^PC(\d{2})-0*(\d+)$/i.exec(p.trim());
      if (m) conocidos[clavePC(m[1], m[2])] = p.trim();
    }
    if (!Object.keys(conocidos).length) return res.status(400).json({ error: "No hay pedidos PC cargados en la pantalla." });

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

      // 1) Pedidos mencionados en cada mensaje y, por hilo, la unión de todos
      const porHilo = {};
      const pcsDe = new Map();
      for (const m of mensajes) {
        const texto = `${m.subject || ""}\n${textoPlano(m.body?.content || m.bodyPreview || "")}`;
        const pcs = new Set();
        for (const x of texto.matchAll(RE_PC)) {
          const p = conocidos[clavePC(x[1], x[2])];
          if (p) pcs.add(p);
        }
        pcsDe.set(m.id, pcs);
        if (pcs.size && m.conversationId) {
          const s = (porHilo[m.conversationId] ||= new Set());
          pcs.forEach((p) => s.add(p));
        }
      }

      // 2) Notas nuevas (sin duplicar por id de correo)
      const d = await leerRecep();
      d.notas = d.notas || {};
      const yo = String(buzon).toLowerCase();
      let añadidas = 0;
      const tocados = new Set();
      for (const m of mensajes) {
        const pcs = new Set([...(pcsDe.get(m.id) || []), ...(porHilo[m.conversationId] || [])]);
        if (!pcs.size) continue;
        const de = m.from?.emailAddress?.address || "";
        const enviado = de.toLowerCase() === yo;
        const para = (m.toRecipients || []).map((t) => t.emailAddress?.address).filter(Boolean).join(", ");
        const fecha = enviado ? (m.sentDateTime || m.receivedDateTime) : m.receivedDateTime;
        const resumen = textoPlano(m.body?.content || m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 300);
        const texto = `${enviado ? `Enviado a ${para || "—"}` : `De ${m.from?.emailAddress?.name || de}${de && m.from?.emailAddress?.name ? ` <${de}>` : ""}`} · «${m.subject || "(sin asunto)"}»\n${resumen}${resumen.length >= 300 ? "…" : ""}`;
        for (const p of pcs) {
          const actuales = d.notas[p] || [];
          if (actuales.some((n) => n.correoId === m.id)) continue;
          actuales.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: fecha || new Date().toISOString(), autor: "📧 Correo", texto: texto.slice(0, 2000), correoId: m.id, enlace: m.webLink || "" });
          actuales.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
          d.notas[p] = actuales;
          añadidas++;
          tocados.add(p);
        }
      }
      if (añadidas) await escribirRecep(d);
      console.log(`[recepcion/correos] ${buzon}: ${mensajes.length} correos de ${dias} días · ${añadidas} notas nuevas en ${tocados.size} pedidos`);
      res.json({ leidos: mensajes.length, añadidas, pedidos: [...tocados], notas: d.notas });
    } catch (err) {
      console.error("Error /api/recepcion/correos:", err);
      res.status(500).json({ error: "No se pudieron leer los correos.", detalle: String(err.message || err) });
    }
  });
};
