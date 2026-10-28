/**
 * teamsChatbot.cjs — Bandeja d'OK de tasques detectades a Teams.
 *
 * Regles (Maria / Also Casals Group):
 *  · Només tasques de feina (no conversa, no personal).
 *  · Exclou 1:1 amb Ramon Also, Yuly Medina, Xavi Also, Edith Galvez.
 *  · Equips/grups: sí. Si el xat/equip és Ferros → empresa FerrosCA; altrament Also Casals.
 *  · Mai executa canvis a BC sol: deixa pendent d'OK a ACsales.
 *  · Després de l'OK intenta avisar a Teams: «Soc el chatbot de Maria…».
 *
 * Permisos Azure (aplicació) necessaris per al sync/enviament:
 *  Chat.Read.All (i Chat.ReadWrite.All o ChatMessage.Send per respondre).
 * Si no hi ha permís, la bandeja i l'import manual continuen funcionant.
 */
module.exports = function montarTeamsChatbot({ app, db, obtenerTokenGraph, fetchConReintento }) {
  const DOC = "teams_chatbot_pendents";
  const USUARI =
    process.env.M365_USUARIO_TEAMS ||
    process.env.M365_BUZON_PERSONAL ||
    "maria.rufi@alsocasals.com";

  const EXCLOSOS_1A1 = [
    "ramon also",
    "yuly medina",
    "xavi also",
    "edith galvez",
  ];

  const RE_TASCA =
    /\b(s['’]?ha\s+de|hay\s+que|cal\s+|feu|poseu|entreu|entra[- ]?ho|bloquej|crear\s+client|aviseu|reviseu|digueu|m['’]?ha\s+dit|pujar|enviar|factur|abonament|OT\b|pedido|comanda|valoraci[oó]|alta\s+de|modific)\w*/i;

  const RE_NO_TASCA =
    /^(oki?|vale|ya|si|sí|no|gracias|gr[aà]cies|merci|eiii+|jaj+|tranquila|yes|👍|❤️)?[.!\s]*$/i;

  function norm(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function textPla(html) {
    return String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
  }

  function esExclos1a1(chat) {
    if (String(chat.chatType || "") !== "oneOnOne") return false;
    const membres = (chat.members || []).map((m) => norm(m.displayName || m.email || ""));
    return membres.some((n) => EXCLOSOS_1A1.some((ex) => n.includes(ex)));
  }

  function empresaDeChat(chat) {
    const nom = norm(chat.topic || chat.displayName || "");
    if (/ferros/.test(nom)) return "ferros";
    return "also";
  }

  function etiquetaEmpresa(emp) {
    return emp === "ferros" ? "Ferros Coll de l'Alba, S.L." : "Also Casals Instal·lacions, S.L.";
  }

  function semblaTasca(text) {
    const t = String(text || "").trim();
    if (t.length < 12) return false;
    if (RE_NO_TASCA.test(t)) return false;
    return RE_TASCA.test(t);
  }

  async function llegir() {
    const d = await db.getDoc(DOC, { items: [], vistos: {} });
    if (!Array.isArray(d.items)) d.items = [];
    if (!d.vistos || typeof d.vistos !== "object") d.vistos = {};
    return d;
  }

  async function desar(d) {
    await db.setDoc(DOC, d);
  }

  function respostaChatbot(item) {
    const empres = etiquetaEmpresa(item.empresa);
    return (
      "Soc el chatbot de Maria. Adjunt / aquí tens la informació sol·licitada.\n\n" +
      "Tasca: " + (item.resum || item.text || "").slice(0, 500) + "\n" +
      "Empresa: " + empres + "\n" +
      "(Pendent d'execució manual a ACsales / BC segons el teu OK.)"
    );
  }

  async function graphGet(token, url) {
    const r = await fetchConReintento(url, { headers: { Authorization: "Bearer " + token } });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* raw */ }
    if (!r.ok) {
      const err = new Error((j && (j.error?.message || j.error)) || txt.slice(0, 400) || ("Graph " + r.status));
      err.status = r.status;
      err.body = j || txt;
      throw err;
    }
    return j;
  }

  async function enviarMissatgeChat(token, chatId, html) {
    const url =
      "https://graph.microsoft.com/v1.0/users/" +
      encodeURIComponent(USUARI) +
      "/chats/" +
      encodeURIComponent(chatId) +
      "/messages";
    const r = await fetchConReintento(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: { contentType: "html", content: "<p>" + String(html).replace(/\n/g, "<br>") + "</p>" },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("No s'ha pogut enviar a Teams (" + r.status + "): " + t.slice(0, 300));
    }
    return r.json();
  }

  function upsertItem(store, nou) {
    const id = nou.id;
    const i = store.items.findIndex((x) => x.id === id);
    if (i >= 0) {
      if (store.items[i].estat === "pendent") {
        store.items[i] = { ...store.items[i], ...nou, estat: "pendent" };
      }
      return false;
    }
    store.items.unshift(nou);
    return true;
  }

  // ---- API ----

  app.get("/api/teams-bot/pendents", async (req, res) => {
    try {
      const d = await llegir();
      const estat = String(req.query.estat || "pendent");
      let items = d.items;
      if (estat !== "tots") items = items.filter((x) => x.estat === estat);
      const pendents = d.items.filter((x) => x.estat === "pendent").length;
      res.json({
        items,
        pendents,
        usuariTeams: USUARI,
        actualitzat: d.actualitzat || null,
      });
    } catch (err) {
      console.error("[teams-bot] pendents:", err);
      res.status(500).json({ error: "No s'han pogut llegir els pendents." });
    }
  });

  /** Import manual / des de Cursor (mateix format que el sync). */
  app.post("/api/teams-bot/import", async (req, res) => {
    try {
      const llista = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!llista.length) return res.status(400).json({ error: "Cal items[]." });
      const d = await llegir();
      let nous = 0;
      for (const raw of llista) {
        const chatId = String(raw.chatId || "").trim();
        const messageId = String(raw.messageId || raw.id || "").trim();
        if (!chatId || !messageId) continue;
        const text = textPla(raw.text || raw.body || "");
        if (!semblaTasca(text) && !raw.forcar) continue;
        const topic = raw.topic || raw.chatTopic || "";
        const empresa = raw.empresa === "ferros" || /ferros/i.test(topic) ? "ferros" : "also";
        const id = chatId + "|" + messageId;
        if (upsertItem(d, {
          id,
          chatId,
          messageId,
          topic: topic || "(xat)",
          chatType: raw.chatType || "group",
          de: raw.de || raw.from || "?",
          text,
          resum: (raw.resum || text).slice(0, 280),
          empresa,
          empresaEtiqueta: etiquetaEmpresa(empresa),
          webUrl: raw.webUrl || null,
          creat: raw.creat || new Date().toISOString(),
          detectat: new Date().toISOString(),
          estat: "pendent",
          respostaProposada: null,
        })) nous++;
      }
      d.actualitzat = new Date().toISOString();
      await desar(d);
      res.json({ ok: true, nous, pendents: d.items.filter((x) => x.estat === "pendent").length });
    } catch (err) {
      console.error("[teams-bot] import:", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/teams-bot/sync", async (req, res) => {
    if (!process.env.M365_CLIENT_SECRET) {
      return res.status(503).json({
        error: "Falta M365_* a .env.",
        pista: "També pots fer POST /api/teams-bot/import amb els missatges.",
      });
    }
    const topXats = Math.min(Math.max(Number(req.body?.topChats) || 25, 5), 50);
    const topMsg = Math.min(Math.max(Number(req.body?.topMessages) || 15, 5), 40);
    try {
      const token = await obtenerTokenGraph();
      const base = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(USUARI);
      let chats;
      try {
        chats = await graphGet(
          token,
          base + "/chats?$top=" + topXats + "&$expand=members"
        );
      } catch (err) {
        return res.status(err.status === 403 ? 403 : 502).json({
          error: "Graph no pot llegir els xats de Teams amb el compte d'aplicació.",
          detall: String(err.message || err).slice(0, 400),
          pista:
            "A Azure cal Chat.Read.All (aplicació) amb consentiment admin, o bé importa amb POST /api/teams-bot/import des de Cursor.",
        });
      }

      const d = await llegir();
      let revisats = 0;
      let nous = 0;
      const errors = [];

      for (const chat of chats.value || []) {
        if (esExclos1a1(chat)) continue;
        if (String(chat.chatType || "") === "meeting") continue;
        revisats++;
        const empresa = empresaDeChat(chat);
        try {
          const msgs = await graphGet(
            token,
            base +
              "/chats/" +
              encodeURIComponent(chat.id) +
              "/messages?$top=" +
              topMsg
          );
          for (const m of msgs.value || []) {
            if (m.messageType && m.messageType !== "message") continue;
            if (m.deletedDateTime) continue;
            const deNom = m.from?.user?.displayName || m.from?.application?.displayName || "";
            if (norm(deNom).includes("maria rufi")) continue;
            const text = textPla(m.body?.content);
            if (!semblaTasca(text)) continue;
            const id = chat.id + "|" + m.id;
            if (d.vistos[id] && d.vistos[id] !== "pendent") continue;
            if (upsertItem(d, {
              id,
              chatId: chat.id,
              messageId: m.id,
              topic: chat.topic || (chat.chatType === "oneOnOne" ? "Xat 1:1" : "(grup)"),
              chatType: chat.chatType || "unknown",
              de: deNom || "?",
              text,
              resum: text.slice(0, 280),
              empresa,
              empresaEtiqueta: etiquetaEmpresa(empresa),
              webUrl: m.webUrl || null,
              creat: m.createdDateTime || null,
              detectat: new Date().toISOString(),
              estat: "pendent",
              respostaProposada: null,
            })) {
              nous++;
              d.vistos[id] = "pendent";
            }
          }
        } catch (err) {
          errors.push({ chatId: chat.id, error: String(err.message || err).slice(0, 200) });
        }
      }

      d.actualitzat = new Date().toISOString();
      await desar(d);
      res.json({
        ok: true,
        revisats,
        nous,
        pendents: d.items.filter((x) => x.estat === "pendent").length,
        errors: errors.slice(0, 5),
        actualitzat: d.actualitzat,
      });
    } catch (err) {
      console.error("[teams-bot] sync:", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/teams-bot/decidir", async (req, res) => {
    try {
      const id = String(req.body?.id || "").trim();
      const decisio = String(req.body?.decisio || "").toLowerCase();
      if (!id || (decisio !== "ok" && decisio !== "no")) {
        return res.status(400).json({ error: "Cal id i decisio ok|no." });
      }
      const d = await llegir();
      const item = d.items.find((x) => x.id === id);
      if (!item) return res.status(404).json({ error: "No trobat." });
      if (item.estat !== "pendent") {
        return res.status(409).json({ error: "Aquesta tasca ja està " + item.estat + "." });
      }

      if (decisio === "no") {
        item.estat = "rebutjat";
        item.decidit = new Date().toISOString();
        d.vistos[id] = "rebutjat";
        await desar(d);
        return res.json({ ok: true, item });
      }

      item.estat = "aprovat";
      item.decidit = new Date().toISOString();
      item.respostaProposada = respostaChatbot(item);
      d.vistos[id] = "aprovat";

      let enviatTeams = false;
      let errorEnviament = null;
      if (process.env.M365_CLIENT_SECRET && item.chatId) {
        try {
          const token = await obtenerTokenGraph();
          await enviarMissatgeChat(token, item.chatId, item.respostaProposada);
          enviatTeams = true;
          item.enviatTeams = new Date().toISOString();
        } catch (err) {
          errorEnviament = String(err.message || err).slice(0, 400);
          item.errorEnviament = errorEnviament;
        }
      } else {
        errorEnviament = "Sense credencials M365 o sense chatId: copia la resposta proposada.";
      }

      await desar(d);
      res.json({
        ok: true,
        item,
        enviatTeams,
        errorEnviament,
        avís:
          "L'OK només autoritza l'avís a Teams. Els canvis a BC / ACsales els fas tu (o demanes a l'agent amb confirmació).",
      });
    } catch (err) {
      console.error("[teams-bot] decidir:", err);
      res.status(500).json({ error: String(err.message || err) });
    }
  });
};
