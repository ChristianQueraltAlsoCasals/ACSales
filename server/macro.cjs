/**
 * macro.cjs — INDICADORES ECONÓMICOS para la pantalla «Ratios financieros»
 * (24/09/2026).
 *
 * Guarda en Postgres (clave indicadores_macro) el valor actual de cada indicador
 * (IPC, gasóleo, cobre, Euríbor…), con fecha y fuente. Se puede:
 *   · editar a mano desde la pantalla (POST /api/macro/indicadores)
 *   · actualizar automáticamente EUR/USD, tipo del BCE y Euríbor desde la
 *     API pública del Banco Central Europeo (POST /api/macro/actualizar-bce)
 *   · actualizar TODOS con la IA + búsqueda web (POST /api/macro/actualizar-ia)
 *     usando la misma ANTHROPIC_API_KEY. Si la búsqueda web no está
 *     habilitada en la cuenta de Anthropic, avisa y no cambia nada.
 * Los indicadores son comunes a las tres empresas.
 */
// Valores iniciales (buscados el 24/09/2026). Se pueden cambiar desde la pantalla.
const INDICADORES_INICIALES = [
  { id: "ipc", nombre: "IPC / Inflación", que: "Subida general de precios", afecta: "Aumentan gastos generales, servicios, dietas, alquileres, seguros, etc.", valor: "4,3 % anual (subyacente 2,9 %)", fecha: "2026-08", fuente: "INE, 15/09/2026", url: "https://www.ine.es/dyngs/Prensa/IPC0826.htm" },
  { id: "ipri", nombre: "IPRI – Precios industriales", que: "Evolución de precios de productos industriales", afecta: "Puede anticipar subidas de materiales y equipos", valor: "9,2 % anual (energía 20,8 %)", fecha: "2026-07", fuente: "INE, 25/08/2026", url: "https://www.ine.es/dyngs/Prensa/IPRI0726.htm" },
  { id: "gasoleo", nombre: "Precio del gasóleo", que: "Coste del combustible", afecta: "Afecta a vehículos, desplazamientos y maquinaria", valor: "1,834 €/litro (+2,2 % semanal)", fecha: "2026-09-14", fuente: "Boletín Petrolero UE", url: "https://www.cadenadesuministro.es/transporte-carretera/precio-gasoleo-retoma-subidas-alcanza-1834-euros_1518390_102.html" },
  { id: "electricidad", nombre: "Precio de la electricidad", que: "Coste energético", afecta: "Afecta a oficinas, talleres y proveedores", valor: "157,24 €/MWh mayorista (PVPC 194,26 €/MWh)", fecha: "2026-09-24", fuente: "OMIE", url: "https://www.omie.es/" },
  { id: "gas", nombre: "Precio del gas natural", que: "Coste energético industrial", afecta: "Puede repercutir en precios de fabricantes y proveedores", valor: "≈ 84 €/MWh (máximos desde enero 2023)", fecha: "2026-09", fuente: "MIBGAS", url: "https://www.mibgas.es/es/market-results" },
  { id: "cobre", nombre: "Precio del cobre", que: "Coste de una materia prima clave", afecta: "Impacta especialmente en cableado e instalaciones eléctricas", valor: "≈ 14.355 USD/t (+40 % interanual)", fecha: "2026-09-02", fuente: "LME / Cochilco", url: "https://www.lme.com/metals/non-ferrous/lme-copper" },
  { id: "acero", nombre: "Precio del acero", que: "Coste de estructuras y materiales metálicos", afecta: "Afecta a construcción, soportes, tuberías, estructuras, etc.", valor: "≈ 700 €/t bobina caliente Europa (+10 % interanual)", fecha: "2026-04", fuente: "Reportacero (dato de abril, revisar)", url: "https://reportacero.com/precios-del-acero-en-europa-suben-hasta-100-euros-por-tonelada-en-2026/" },
  { id: "aluminio", nombre: "Precio del aluminio", que: "Coste de materiales metálicos", afecta: "Puede afectar a cerramientos, instalaciones y componentes", valor: "3.242 USD/t", fecha: "2026-09-22", fuente: "LME (Westmetall)", url: "https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Al_cash" },
  { id: "salarios", nombre: "Costes salariales", que: "Evolución de salarios", afecta: "Incrementa directamente el coste por hora trabajado", valor: "3.388 €/trabajador/mes (+4,0 % anual)", fecha: "2026-T2", fuente: "INE ETCL, 17/09/2026", url: "https://www.ine.es/dyngs/INEbase/operacion.htm?c=Estadistica_C&cid=1254736045053&idp=1254735976596" },
  { id: "convenio", nombre: "Convenio colectivo", que: "Subidas salariales obligatorias", afecta: "Puede reducir margen si no actualizas precio/hora", valor: "+3,04 % subida media pactada", fecha: "2026-08", fuente: "Ministerio de Trabajo", url: "https://www.infobae.com/espana/agencias/2026/09/10/los-salarios-en-convenio-suben-un-304-hasta-agosto-con-la-inflacion-disparada-al-43/" },
  { id: "ss", nombre: "Cotizaciones a la Seguridad Social", que: "Coste empresarial del trabajador", afecta: "Aumenta el coste laboral real", valor: "CC 23,60 % empresa · MEI 0,75 % · base máx. 5.101,20 €/mes", fecha: "2026", fuente: "Orden de cotización 2026", url: "https://www.cuatrecasas.com/es/spain/laboral/art/claves-orden-cotizacion-2026" },
  { id: "bce", nombre: "Tipos de interés del BCE", que: "Coste general de financiación", afecta: "Puede encarecer préstamos, pólizas y leasing", valor: "2,50 % facilidad de depósito (+0,25 desde 16/09)", fecha: "2026-09-16", fuente: "BCE", url: "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.es.html" },
  { id: "euribor", nombre: "Euríbor", que: "Coste de financiación variable", afecta: "Puede aumentar gastos financieros", valor: "3,218 % media septiembre (3,331 % hoy)", fecha: "2026-09-24", fuente: "euribordiario.es", url: "https://www.euribordiario.es/" },
  { id: "eurusd", nombre: "Tipo de cambio EUR/USD", que: "Valor del euro frente al dólar", afecta: "Puede encarecer materiales importados", valor: "1,1426 USD por €", fecha: "2026-09-23", fuente: "Infobae / BCE", url: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A" },
  { id: "transporte", nombre: "Coste del transporte", que: "Coste logístico", afecta: "Proveedores pueden trasladarlo a sus precios", valor: "1,42 €/km articulado; combustible +14,4 % anual", fecha: "2026-T2", fuente: "Observatorio de costes (Mº Transportes) / Fenadismer", url: "https://www.fenadismer.es/continuan-los-incrementos-de-costes-pero-tambien-de-actividad-del-transporte-en-2-trimestre-2026/" },
  { id: "pib", nombre: "PIB", que: "Evolución general de la economía", afecta: "Si cae, puede reducirse la inversión y el volumen de trabajo", valor: "+0,7 % trimestral · +2,7 % anual", fecha: "2026-T2", fuente: "INE", url: "https://www.ine.es/dyngs/Prensa/avCNTR2T26.htm" },
  { id: "ipi", nombre: "Producción industrial", que: "Actividad de la industria", afecta: "Muy útil si trabajáis con clientes industriales", valor: "+2,6 % anual (corregido +2,3 %)", fecha: "2026-07", fuente: "INE, 10/09/2026", url: "https://www.ine.es/prensa/ipi_tabla.htm" },
  { id: "construccion", nombre: "Actividad de la construcción", que: "Evolución del sector construcción", afecta: "Puede anticipar más o menos demanda", valor: "−9,8 % anual (edificación −35,2 %, obra civil −4,6 %)", fecha: "2026-07", fuente: "INE IPCO, 14/09/2026", url: "https://www.ine.es/dyngs/INEbase/operacion.htm?c=Estadistica_C&cid=1254736177119&idp=1254735576757" },
  { id: "confianza", nombre: "Confianza empresarial", que: "Expectativas de las empresas", afecta: "Si baja, los clientes pueden posponer inversiones", valor: "+3,2 % trimestral (23 % favorables / 13,9 % desfavorables)", fecha: "2026-T3", fuente: "INE ICE", url: "https://www.ine.es/dyngs/Prensa/ICE3T26.htm" },
  { id: "paro", nombre: "Desempleo", que: "Situación del mercado laboral", afecta: "Puede indicar desaceleración o dificultad para contratar personal", valor: "9,87 % (2.495.300 parados)", fecha: "2026-T2", fuente: "INE EPA", url: "https://www.ine.es/dyngs/Prensa/EPA2T26.htm" },
  {
    id: "impagos",
    nombre: "Impagos / retraso de cobro",
    que: "Clientes que pagan tarde (o dejan de pagar)",
    afecta: "Atasca la caja: necesitas más tesorería o una póliza para seguir pagando nóminas, proveedores y gastos",
    valor: "Se calcula con tu contabilidad (PM de cobro y tesorería)",
    fecha: "en vivo",
    fuente: "Tu BC · clientes (43) + tesorería (57)",
    url: "",
    local: true,
  },
];

module.exports = function montarMacro({ app, fetchConReintento, db }) {
  const CLAVE = "indicadores_macro";

  async function leer() {
    const guardados = await db.getDoc(CLAVE, {});
    const lista = INDICADORES_INICIALES.map((ind) => ({ ...ind, ...(guardados.indicadores?.[ind.id] || {}) }));
    return { indicadores: lista, actualizado: guardados.actualizado || "2026-09-24", origen: guardados.origen || "Valores iniciales (24/09/2026)" };
  }
  async function guardar(cambios, origen) {
    const g = await db.getDoc(CLAVE, {});
    g.indicadores = g.indicadores || {};
    for (const [id, c] of Object.entries(cambios)) {
      if (!INDICADORES_INICIALES.some((i) => i.id === id)) continue;
      const limpio = {};
      for (const k of ["valor", "fecha", "fuente", "url"]) if (c[k] != null) limpio[k] = String(c[k]).slice(0, 300);
      g.indicadores[id] = { ...(g.indicadores[id] || {}), ...limpio };
    }
    g.actualizado = new Date().toISOString().slice(0, 10);
    g.origen = origen;
    await db.setDoc(CLAVE, g);
  }

  app.get("/api/macro/indicadores", async (req, res) => res.json(await leer()));

  app.post("/api/macro/indicadores", async (req, res) => {
    try {
      await guardar(req.body?.cambios || {}, "Editado a mano");
      res.json(await leer());
    } catch (e) {
      res.status(500).json({ error: "No se pudo guardar.", detalle: String(e.message || e) });
    }
  });

  // --- Banco Central Europeo (API pública, sin clave) ---
  async function ultimoBCE(serie) {
    const r = await fetchConReintento(`https://data-api.ecb.europa.eu/service/data/${serie}?lastNObservations=1&format=jsondata`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`BCE ${r.status}`);
    const j = await r.json();
    const obs = Object.values(j.dataSets[0].series)[0].observations;
    const k = Object.keys(obs).sort((a, b) => a - b).pop();
    const fechas = j.structure.dimensions.observation[0].values;
    return { valor: obs[k][0], fecha: fechas[Number(k)].id };
  }
  const n = (v, d) => Number(v).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });

  app.post("/api/macro/actualizar-bce", async (req, res) => {
    const cambios = {}, errores = [];
    const tareas = [
      ["eurusd", "EXR/D.USD.EUR.SP00.A", (o) => ({ valor: `${n(o.valor, 4)} USD por €`, fecha: o.fecha, fuente: "BCE (tipo de referencia)", url: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A" })],
      ["bce", "FM/D.U2.EUR.4F.KR.DFR.LEV", (o) => ({ valor: `${n(o.valor, 2)} % facilidad de depósito`, fecha: o.fecha, fuente: "BCE", url: "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV" })],
      ["euribor", "FM/M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA", (o) => ({ valor: `${n(o.valor, 3)} % (media mensual 12 meses)`, fecha: o.fecha, fuente: "BCE / EMMI", url: "https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA" })],
    ];
    for (const [id, serie, fmt] of tareas) {
      try { cambios[id] = fmt(await ultimoBCE(serie)); } catch (e) { errores.push(`${id}: ${e.message}`); }
    }
    if (Object.keys(cambios).length) await guardar(cambios, "Actualizado desde el BCE");
    res.json({ ...(await leer()), actualizados: Object.keys(cambios), errores });
  });

  // --- IA con búsqueda web: actualiza todos los indicadores ---
  app.post("/api/macro/actualizar-ia", async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "Falta ANTHROPIC_API_KEY en backend/.env" });
    const hoy = new Date().toISOString().slice(0, 10);
    const lista = (await leer()).indicadores.filter((i) => !i.local).map((i) => `- ${i.id}: ${i.nombre} (valor guardado: ${i.valor}, fecha ${i.fecha})`).join("\n");
    const prompt = `Hoy es ${hoy}. Busca en la web el ÚLTIMO dato publicado de cada indicador económico de ESPAÑA (o del mercado europeo/internacional cuando sea un precio de materia prima) y devuélvelos.\n${lista}\n\nReglas: usa fuentes oficiales cuando existan (INE, BCE, OMIE, MIBGAS, LME, Ministerios). "valor" corto y en español con unidades y variación anual si la hay (formato como el guardado). "fecha" = periodo o día del dato (YYYY-MM, YYYY-MM-DD o YYYY-Tn). Si no encuentras un dato más reciente que el guardado, NO incluyas ese indicador.\nResponde SOLO con un JSON: {"id": {"valor": "...", "fecha": "...", "fuente": "...", "url": "..."}, ...}`;
    try {
      let r;
      for (let intento = 0; intento < 3; intento++) {
        r = await fetchConReintento("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
            max_tokens: 8000,
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 25 }],
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (![429, 500, 502, 503, 529].includes(r.status)) break;
        await new Promise((ok) => setTimeout(ok, 4000 * (intento + 1)));
      }
      if (!r.ok) {
        const t = await r.text();
        const sinWeb = /web_search|not enabled|tool/i.test(t);
        return res.status(502).json({ error: sinWeb ? "La búsqueda web no está habilitada en la cuenta de Anthropic (console.anthropic.com → Settings → Privacy/Web search). Puedes actualizar desde el BCE o editar a mano." : "La IA no pudo actualizar los indicadores.", detalle: t.slice(0, 400) });
      }
      const data = await r.json();
      const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const m = texto.match(/\{[\s\S]*\}/);
      if (!m) return res.status(502).json({ error: "La IA no devolvió datos en el formato esperado.", detalle: texto.slice(0, 400) });
      let cambios;
      try { cambios = JSON.parse(m[0]); } catch { return res.status(502).json({ error: "La respuesta de la IA no es un JSON válido.", detalle: m[0].slice(0, 400) }); }
      await guardar(cambios, `Actualizado con IA + búsqueda web (${hoy})`);
      res.json({ ...(await leer()), actualizados: Object.keys(cambios).filter((id) => INDICADORES_INICIALES.some((i) => i.id === id)) });
    } catch (e) {
      console.error("Error /api/macro/actualizar-ia:", e);
      res.status(500).json({ error: "No se pudieron actualizar los indicadores.", detalle: String(e.message || e) });
    }
  });

  // --- IA: explica en fácil cómo afecta cada situación, con un ejemplo y soluciones ---
  // body: { empresa, modo: "uno" | "todo", filas: [{nombre, valor, fecha, escenario, unidad, efectoAnual, base, etiqueta, texto, que, afecta}], resumen: {...} }
  app.post("/api/macro/explicar", async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "Falta ANTHROPIC_API_KEY en backend/.env" });
    const { empresa = "la empresa", modo = "uno", filas = [], resumen = {} } = req.body || {};
    if (!filas.length) return res.status(400).json({ error: "No hay ningún indicador para explicar." });
    const eurTxt = (v) => (v == null || !isFinite(v) ? "—" : `${Math.round(v).toLocaleString("es-ES")} €`);
    const detalle = modo === "ratio"
      ? filas.map((f) =>
        `- ${f.nombre} (apartado: ${f.grupo || "ratios"}). Fórmula: ${f.formula || "—"}. Periodo actual (${f.etiqActual || "actual"}): ${f.valor}. Mismo periodo del año anterior (${f.etiqPrev || "anterior"}): ${f.anterior}. Guía ya mostrada en pantalla: ${f.que || "—"}.`
      ).join("\n")
      : filas.map((f) =>
        `- ${f.nombre}: dato actual ${f.valor} (${f.fecha}). Qué indica: ${f.que}. Cómo afecta en general: ${f.afecta}.` +
        (f.escenario != null && f.escenario !== "" ? ` ESCENARIO: ${Number(f.escenario) > 0 ? "sube" : "baja"} ${Math.abs(Number(f.escenario))} ${f.unidad}. Cálculo con la contabilidad real: ${f.texto} Efecto anual: ${eurTxt(f.efectoAnual)}. Base afectada: ${eurTxt(f.base)} (${f.etiqueta}).` : " Sin escenario: explica qué pasaría si subiera o bajara de forma notable.")
      ).join("\n");
    const pctTxt = (v) => (v == null || !isFinite(v) ? "—" : `${(v * 100).toFixed(1)} %`);
    const cifras = modo === "ratio"
      ? `Cifras reales del periodo (${resumen.periodo || "actual"}), comparadas con ${resumen.periodoPrev || "el año anterior"}: ventas ${eurTxt(resumen.ventas)} (antes ${eurTxt(resumen.ventasPrev)}), EBITDA ${eurTxt(resumen.ebitda)} (antes ${eurTxt(resumen.ebitdaPrev)}), EBIT ${eurTxt(resumen.ebit)}, beneficio líquido ${eurTxt(resumen.bn)}, margen EBITDA ${pctTxt(resumen.margen)}, tesorería ${eurTxt(resumen.tesoreria)}, clientes ${eurTxt(resumen.clientes)}, proveedores ${eurTxt(resumen.proveedores)}, fondo de maniobra ${eurTxt(resumen.fondoManiobra)}, activo ${eurTxt(resumen.activo)}, patrimonio ${eurTxt(resumen.patrimonio)}, deudas ${eurTxt(resumen.deudas)}.`
      : `Cifras anualizadas de la empresa: ventas ${eurTxt(resumen.ventas)}, EBITDA ${eurTxt(resumen.ebitda)}, margen EBITDA ${pctTxt(resumen.margen)}, gastos de personal ${eurTxt(resumen.personal)}, compras/consumos ${eurTxt(resumen.consumos)}, deuda bancaria ${eurTxt(resumen.deuda)}.` +
        (resumen.totalEbitda != null ? ` Efecto total del escenario: EBITDA ${eurTxt(resumen.totalEbitda)}/año, intereses ${eurTxt(resumen.totalFin)}/año.` : "");
    const sistema = `Eres un asesor financiero que explica las cosas de forma FÁCIL a la responsable de administración de ${empresa} (Grup AC, Tortosa). ${/also/i.test(empresa) ? "ALSO CASALS es una empresa instaladora (electricidad, fontanería, clima, mantenimiento industrial) que trabaja con OTs, materiales (cable de cobre, tubería, acero…), técnicos con furgonetas y clientes industriales y de obra. " : "Es una empresa del grupo; no supongas detalles de su actividad que no se deduzcan de las cifras. "}Escribe en castellano, frases cortas, sin tecnicismos (si usas uno, explícalo). Usa SIEMPRE los números reales que te doy (en €). Las soluciones deben ser concretas y aplicables por una pyme (precios, tarifas por hora, cláusulas de revisión de precios en presupuestos, compras, stock, rutas, financiación, etc.). No inventes datos que no te doy; si das un ejemplo inventado, dilo ("por ejemplo, una obra de 10.000 €…").`;
    const instr = modo === "todo"
      ? `Explica el ESCENARIO COMPLETO de estos indicadores y su efecto conjunto. Responde SOLO con JSON: {"explicacion": "3-5 frases fáciles sobre qué está pasando y qué significa para la empresa", "ejemplo": "un caso concreto con los números reales (ej.: una OT o un mes típico)", "soluciones": ["5-7 acciones concretas, ordenadas de más a menos importante, cada una de 1-2 frases"], "prioridad": "la UNA cosa que haría esta semana"}`
      : modo === "ratio"
        ? `Explica este ratio o esta masa del balance con las cifras REALES de la empresa (periodo actual y año anterior). Di si ha mejorado o empeorado. Responde SOLO con JSON: {"explicacion": "2-4 frases fáciles: qué significa ESTE número para la empresa", "ejemplo": "un caso concreto usando estos euros o este ratio (una obra, un mes de cobros, el banco, el almacén…)", "soluciones": ["3-5 acciones concretas, 1-2 frases cada una: qué hacer si el dato es flojo, o cómo aprovecharlo si es bueno"], "prioridad": "la acción más útil esta semana, en una frase"}`
        : `Explica este indicador. Responde SOLO con JSON: {"explicacion": "2-4 frases fáciles: qué es y cómo afecta a la empresa", "ejemplo": "un caso concreto con los números reales (ej.: en una OT típica, en un mes, en la furgoneta de un técnico…)", "soluciones": ["3-5 posibles soluciones concretas, 1-2 frases cada una"], "prioridad": "la acción más urgente, en una frase"}`;
    try {
      let r;
      for (let intento = 0; intento < 3; intento++) {
        r = await fetchConReintento("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5", max_tokens: 2500, system: sistema, messages: [{ role: "user", content: `${cifras}\n\n${detalle}\n\n${instr}` }] }),
        });
        if (![429, 500, 502, 503, 529].includes(r.status)) break;
        await new Promise((ok) => setTimeout(ok, 3000 * (intento + 1)));
      }
      if (!r.ok) return res.status(502).json({ error: "La IA no pudo responder.", detalle: (await r.text()).slice(0, 300) });
      const data = await r.json();
      const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const m = texto.match(/\{[\s\S]*\}/);
      let j = null;
      try { j = m ? JSON.parse(m[0]) : null; } catch { /* texto libre */ }
      if (!j) j = { explicacion: texto.trim(), ejemplo: "", soluciones: [], prioridad: "" };
      res.json({ explicacion: String(j.explicacion || ""), ejemplo: String(j.ejemplo || ""), soluciones: Array.isArray(j.soluciones) ? j.soluciones.map(String) : [], prioridad: String(j.prioridad || "") });
    } catch (e) {
      console.error("Error /api/macro/explicar:", e);
      res.status(500).json({ error: "No se pudo obtener la explicación.", detalle: String(e.message || e) });
    }
  });
};
