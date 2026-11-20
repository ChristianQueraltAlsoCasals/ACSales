/**
 * Firmas / quién ha recogido el material — opcional y local a ACSales.
 * Lista recursos BC (misma ficha que Horas), guarda asignaciones y aprende
 * de muestras de firma cuando la usuaria confirma una persona.
 */
module.exports = function montarRecepcionFirmas({
  app,
  obtenerTokenBC,
  fetchConReintento,
  EMPRESA_NOMBRE,
  db,
  claveEmpresa,
  leerRecep,
  escribirRecep,
  leerVistaPdf,
}) {
  const cacheRecursos = new Map(); // empresa → { ts, recursos }
  const TTL_MS = 30 * 60 * 1000;

  function claveAlbaran(v) {
    return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function claveRecogedor({ albaran, pedido, proveedor }) {
    const alb = claveAlbaran(albaran);
    if (alb) return alb;
    const ped = String(pedido || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const prov = String(proveedor || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
    if (ped) return `P:${ped}`;
    if (prov) return `V:${prov}`;
    return "";
  }

  function campo(fila, nombres) {
    for (const n of nombres) {
      if (fila[n] != null && String(fila[n]).trim() !== "") return fila[n];
    }
    return "";
  }

  function normalizarTexto(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function palabras(s) {
    return new Set(normalizarTexto(s).split(" ").filter((w) => w.length > 2));
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
  }

  function parecidoNombre(a, b) {
    const na = normalizarTexto(a);
    const nb = normalizarTexto(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.85;
    return jaccard(palabras(na), palabras(nb));
  }

  async function paginarOData(url, token) {
    const filas = [];
    let next = url;
    let guard = 0;
    while (next && guard < 40) {
      guard += 1;
      const r = await fetchConReintento(next, {
        headers: { Authorization: `Bearer ${token}`, Prefer: "odata.maxpagesize=500", Accept: "application/json" },
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const e = new Error(`BC ${r.status}: ${t.slice(0, 200)}`);
        e.status = r.status;
        throw e;
      }
      const j = await r.json();
      filas.push(...(j.value || []));
      next = j["@odata.nextLink"] || null;
    }
    return filas;
  }

  async function listarRecursosDesdeHoras() {
    if (!db || !claveEmpresa) return [];
    const horas = await db.getDoc(claveEmpresa("horas"), null);
    const nombres = horas?.nombres || {};
    const tipoRecurso = horas?.tipoRecurso || {};
    const out = [];
    for (const [no, nombre] of Object.entries(nombres)) {
      const tipo = String(tipoRecurso[no] || "");
      if (/machin|m[aá]quina/i.test(tipo)) continue;
      out.push({ no, nombre: String(nombre || no).trim(), grupo: String(horas?.grupos?.[no] || ""), tipo });
    }
    out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    return out;
  }

  async function listarRecursosBc() {
    const empresaNom = EMPRESA_NOMBRE() || "";
    const cached = cacheRecursos.get(empresaNom);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.recursos;

    const token = await obtenerTokenBC();
    const base = `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(empresaNom)}')`;
    const candidatos = [...new Set([
      process.env.BC_WS_RECURSOS,
      "Ficha_recurso_Excel",
      "Resource_List",
      "Lista_recursos",
      "Recursos",
      "Resources",
    ].filter(Boolean))];

    let filas = null;
    let ultimoError = null;
    for (const nombre of candidatos) {
      try {
        filas = await paginarOData(`${base}/${encodeURIComponent(nombre)}?$select=No,Name,Type,Resource_Group_No`, token);
        break;
      } catch (e) {
        ultimoError = e;
        if (e.status === 400) {
          try {
            filas = await paginarOData(`${base}/${encodeURIComponent(nombre)}`, token);
            break;
          } catch (e2) {
            ultimoError = e2;
          }
        }
      }
    }
    if (!filas) throw ultimoError || new Error("No se pudo listar los recursos de BC.");

    const out = [];
    for (const r of filas) {
      const no = String(campo(r, ["No", "No_", "Nº", "number"])).trim();
      const nombre = String(campo(r, ["Name", "Nombre", "displayName"]) || no).trim();
      if (!no || !nombre) continue;
      const tipo = String(campo(r, ["Type", "Tipo"]) || "");
      if (/machin|m[aá]quina/i.test(tipo)) continue;
      const grupo = String(campo(r, ["Resource_Group_No", "ResourceGroupNo", "Grupo_recurso"]) || "").trim();
      out.push({ no, nombre, grupo, tipo });
    }
    out.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    cacheRecursos.set(empresaNom, { ts: Date.now(), recursos: out });
    return out;
  }

  async function listarRecursos() {
    try {
      return { recursos: await listarRecursosBc(), origen: "bc" };
    } catch (err) {
      const respaldo = await listarRecursosDesdeHoras();
      if (respaldo.length) return { recursos: respaldo, origen: "horas", aviso: String(err.message || err) };
      throw err;
    }
  }

  function sugerir({ descripcion, nombreLegible, aprendidas, recursos }) {
    if (nombreLegible) {
      let best = null;
      let score = 0;
      for (const r of recursos || []) {
        const s = parecidoNombre(nombreLegible, r.nombre);
        if (s > score) {
          score = s;
          best = r;
        }
      }
      if (best && score >= 0.7) {
        return { recursoNo: best.no, nombre: best.nombre, motivo: "nombre_legible", confianza: score };
      }
    }
    const descWords = palabras(descripcion);
    if (!descWords.size) return null;
    let best = null;
    let score = 0;
    for (const [no, info] of Object.entries(aprendidas || {})) {
      for (const m of info.muestras || []) {
        const s = jaccard(descWords, palabras(m));
        if (s > score) {
          score = s;
          best = { recursoNo: no, nombre: info.nombre || no, motivo: "firma_aprendida", confianza: s };
        }
      }
    }
    if (best && score >= 0.28) return best;
    return null;
  }

  async function describirFirmaDesdePdf(bytes) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { firmaVisible: false, firmaDescripcion: null, firmaNombreLegible: null };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const prompt = `Mira este albarán o nota de entrega. Busca una firma manuscrita (rúbrica, garabato, firma del receptor).
Responde SOLO un JSON, sin texto alrededor:
{"firmaVisible":true|false,"firmaDescripcion":"descripción visual breve en español (color, forma, iniciales aparentes) o null","firmaNombreLegible":"nombre de persona escrito junto a la firma si se lee claramente, o null"}
Reglas:
- No inventes una persona si la firma no se lee.
- Si no hay firma manuscrita, firmaVisible false y el resto null.
- firmaDescripcion: 5 a 20 palabras, útil para reconocer la misma firma otro día.`;

    const response = await fetchConReintento("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      throw new Error(`No se pudo describir la firma (${response.status}). ${t.slice(0, 160)}`);
    }
    const data = await response.json();
    const texto = (data.content || []).map((c) => c.text || "").join("");
    const limpio = texto.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(limpio);
    } catch {
      return { firmaVisible: false, firmaDescripcion: null, firmaNombreLegible: null };
    }
    return {
      firmaVisible: !!parsed.firmaVisible,
      firmaDescripcion: parsed.firmaDescripcion ? String(parsed.firmaDescripcion).trim().slice(0, 240) : null,
      firmaNombreLegible: parsed.firmaNombreLegible ? String(parsed.firmaNombreLegible).trim().slice(0, 120) : null,
    };
  }

  app.get("/api/recepcion/recursos", async (req, res) => {
    try {
      const { recursos, origen, aviso } = await listarRecursos();
      res.json({ ok: true, n: recursos.length, recursos, origen, aviso: aviso || null });
    } catch (err) {
      console.error("Error /api/recepcion/recursos:", err);
      res.status(500).json({ error: "No se pudieron cargar los trabajadores de BC.", detalle: String(err.message || err) });
    }
  });

  app.get("/api/recepcion/firmas", async (req, res) => {
    try {
      const albaran = String(req.query.albaran || "").trim();
      const pedido = String(req.query.pedido || "").trim();
      const proveedor = String(req.query.proveedor || "").trim();
      const descripcion = String(req.query.descripcion || "").trim();
      const nombreLegible = String(req.query.nombreLegible || "").trim();
      const doc = await leerRecep();
      const aprendidas = doc.firmasAprendidas || {};
      const recogedores = doc.recogedores || {};
      const clave = claveRecogedor({ albaran, pedido, proveedor });
      const asignado = clave && recogedores[clave] ? recogedores[clave] : null;
      let recursos = [];
      try {
        recursos = (await listarRecursos()).recursos;
      } catch {
        recursos = Object.entries(aprendidas).map(([no, info]) => ({ no, nombre: info.nombre || no, grupo: "", tipo: "" }));
      }
      const sugerido = asignado
        ? null
        : sugerir({ descripcion, nombreLegible, aprendidas, recursos });
      res.json({
        ok: true,
        clave: clave || null,
        asignado,
        sugerido,
        aprendidasN: Object.keys(aprendidas).length,
      });
    } catch (err) {
      console.error("Error /api/recepcion/firmas:", err);
      res.status(500).json({ error: "No se pudo leer el banco de firmas.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/recepcion/firmas/describir", async (req, res) => {
    try {
      const pdfVista = String(req.body?.pdfVista || "").trim();
      const albaran = String(req.body?.albaran || "").trim();
      const pedido = String(req.body?.pedido || "").trim();
      const proveedor = String(req.body?.proveedor || "").trim();
      if (!pdfVista) return res.status(400).json({ error: "Falta la vista del PDF." });
      const bytes = leerVistaPdf(pdfVista);
      if (!bytes) return res.status(404).json({ error: "La vista previa del PDF ha caducado. Vuelve a abrir el documento." });
      const desc = await describirFirmaDesdePdf(bytes);
      const doc = await leerRecep();
      let recursos = [];
      try {
        recursos = (await listarRecursos()).recursos;
      } catch {
        recursos = Object.entries(doc.firmasAprendidas || {}).map(([no, info]) => ({ no, nombre: info.nombre || no }));
      }
      const sugerido = sugerir({
        descripcion: desc.firmaDescripcion || "",
        nombreLegible: desc.firmaNombreLegible || "",
        aprendidas: doc.firmasAprendidas || {},
        recursos,
      });
      const clave = claveRecogedor({ albaran, pedido, proveedor });
      const asignado = clave && doc.recogedores?.[clave] ? doc.recogedores[clave] : null;
      res.json({ ok: true, ...desc, sugerido, asignado });
    } catch (err) {
      console.error("Error /api/recepcion/firmas/describir:", err);
      res.status(500).json({ error: "No se pudo analizar la firma.", detalle: String(err.message || err) });
    }
  });

  app.post("/api/recepcion/firmas", async (req, res) => {
    try {
      const body = req.body || {};
      const albaran = String(body.albaran || "").trim();
      const pedido = String(body.pedido || "").trim();
      const proveedor = String(body.proveedor || "").trim();
      const recursoNo = String(body.recursoNo || "").trim();
      const nombre = String(body.nombre || "").trim();
      const descripcion = body.descripcion != null ? String(body.descripcion).trim().slice(0, 240) : "";
      const borrar = body.borrar === true;
      const clave = claveRecogedor({ albaran, pedido, proveedor });
      if (!clave) return res.status(400).json({ error: "Hace falta el nº de albarán (o el pedido) para guardar quién ha recogido." });

      const doc = await leerRecep();
      const firmasAprendidas = { ...(doc.firmasAprendidas || {}) };
      const recogedores = { ...(doc.recogedores || {}) };

      if (borrar || !recursoNo) {
        delete recogedores[clave];
        await escribirRecep({ ...doc, firmasAprendidas, recogedores });
        return res.json({ ok: true, borrado: true, clave });
      }

      const nombreFinal = nombre || firmasAprendidas[recursoNo]?.nombre || recursoNo;
      const ahora = new Date().toISOString();
      recogedores[clave] = {
        recursoNo,
        nombre: nombreFinal,
        albaran: albaran || null,
        pedido: pedido || null,
        proveedor: proveedor || null,
        descripcion: descripcion || null,
        ts: ahora,
      };

      if (descripcion) {
        const prev = firmasAprendidas[recursoNo] || { nombre: nombreFinal, muestras: [], veces: 0 };
        const muestras = [...(prev.muestras || [])];
        if (!muestras.some((m) => normalizarTexto(m) === normalizarTexto(descripcion))) {
          muestras.unshift(descripcion);
        }
        firmasAprendidas[recursoNo] = {
          nombre: nombreFinal,
          muestras: muestras.slice(0, 8),
          veces: (prev.veces || 0) + 1,
          ultimaVez: ahora,
        };
      } else {
        const prev = firmasAprendidas[recursoNo] || { nombre: nombreFinal, muestras: [], veces: 0 };
        firmasAprendidas[recursoNo] = {
          ...prev,
          nombre: nombreFinal,
          veces: (prev.veces || 0) + 1,
          ultimaVez: ahora,
        };
      }

      await escribirRecep({ ...doc, firmasAprendidas, recogedores });
      res.json({ ok: true, clave, asignado: recogedores[clave] });
    } catch (err) {
      console.error("Error /api/recepcion/firmas:", err);
      res.status(500).json({ error: "No se pudo guardar quién ha recogido.", detalle: String(err.message || err) });
    }
  });
};
