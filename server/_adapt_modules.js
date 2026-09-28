/** Adapta módulos Proves → Postgres (db + claveEmpresa). */
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

// ---- macro.cjs ----
{
  let s = fs.readFileSync(path.join(DIR, "macro.cjs"), "utf8");
  s = s.replace('Guarda en data/indicadores_macro.json', 'Guarda en Postgres (clave indicadores_macro)');
  s = s.replace('const fs = require("fs");\n\n', "");
  s = s.replace(
    'module.exports = function montarMacro({ app, fetchConReintento, dirData }) {\n  const archivo = require("path").join(dirData, "indicadores_macro.json");\n\n  function leer() {\n    let guardados = {};\n    try { guardados = JSON.parse(fs.readFileSync(archivo, "utf8")); } catch { /* primera vez */ }\n    const lista = INDICADORES_INICIALES.map((ind) => ({ ...ind, ...(guardados.indicadores?.[ind.id] || {}) }));\n    return { indicadores: lista, actualizado: guardados.actualizado || "2026-09-24", origen: guardados.origen || "Valores iniciales (24/09/2026)" };\n  }\n  function guardar(cambios, origen) {\n    let g = {};\n    try { g = JSON.parse(fs.readFileSync(archivo, "utf8")); } catch { /* nuevo */ }\n    g.indicadores = g.indicadores || {};\n    for (const [id, c] of Object.entries(cambios)) {\n      if (!INDICADORES_INICIALES.some((i) => i.id === id)) continue;\n      const limpio = {};\n      for (const k of ["valor", "fecha", "fuente", "url"]) if (c[k] != null) limpio[k] = String(c[k]).slice(0, 300);\n      g.indicadores[id] = { ...(g.indicadores[id] || {}), ...limpio };\n    }\n    g.actualizado = new Date().toISOString().slice(0, 10);\n    g.origen = origen;\n    fs.mkdirSync(dirData, { recursive: true });\n    fs.writeFileSync(archivo, JSON.stringify(g, null, 2));\n  }\n\n  app.get("/api/macro/indicadores", (req, res) => res.json(leer()));\n\n  app.post("/api/macro/indicadores", (req, res) => {\n    try {\n      guardar(req.body?.cambios || {}, "Editado a mano");\n      res.json(leer());\n    } catch (e) {\n      res.status(500).json({ error: "No se pudo guardar.", detalle: String(e.message || e) });\n    }\n  });',
    `module.exports = function montarMacro({ app, fetchConReintento, db }) {
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
  });`
  );
  s = s.replace(
    'if (Object.keys(cambios).length) guardar(cambios, "Actualizado desde el BCE");\n    res.json({ ...leer(), actualizados: Object.keys(cambios), errores });',
    'if (Object.keys(cambios).length) await guardar(cambios, "Actualizado desde el BCE");\n    res.json({ ...(await leer()), actualizados: Object.keys(cambios), errores });'
  );
  s = s.replace(
    'const lista = leer().indicadores.map',
    'const lista = (await leer()).indicadores.map'
  );
  s = s.replace(
    'guardar(cambios, `Actualizado con IA + búsqueda web (${hoy})`);\n      res.json({ ...leer(), actualizados:',
    'await guardar(cambios, `Actualizado con IA + búsqueda web (${hoy})`);\n      res.json({ ...(await leer()), actualizados:'
  );
  fs.writeFileSync(path.join(DIR, "macro.cjs"), s);
  console.log("macro OK", !s.includes("readFileSync") && !s.includes("dirData"));
}

// ---- correoPC.cjs ----
{
  let s = fs.readFileSync(path.join(DIR, "correoPC.cjs"), "utf8");
  s = s.replace("const d = leerRecep();", "const d = await leerRecep();");
  s = s.replace("if (añadidas) escribirRecep(d);", "if (añadidas) await escribirRecep(d);");
  fs.writeFileSync(path.join(DIR, "correoPC.cjs"), s);
  console.log("correoPC OK");
}

// ---- horas.cjs ----
{
  let s = fs.readFileSync(path.join(DIR, "horas.cjs"), "utf8");
  s = s.replace(/data\/horas\.json \(por empresa: horas_ferros\.json…\)/, "Postgres (claveEmpresa horas / horas_ferros…)");
  s = s.replace('const fs = require("fs");\nconst path = require("path");\n\n', "");
  s = s.replace(
    'module.exports = function montarHoras({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE, archivoEmpresa }) {\n  const raiz = () => `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company(\'${encodeURIComponent(EMPRESA_NOMBRE() || "")}\')`;\n  const leerJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };\n  const escribirJSON = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); };',
    `module.exports = function montarHoras({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE, db, claveEmpresa }) {
  const raiz = () => \`https://api.businesscentral.dynamics.com/v2.0/\${process.env.BC_TENANT_ID}/\${process.env.BC_ENVIRONMENT}/ODataV4/Company('\${encodeURIComponent(EMPRESA_NOMBRE() || "")}')\`;
  const leerJSON = async (base, def) => db.getDoc(claveEmpresa(base), def);
  const escribirJSON = async (base, d) => db.setDoc(claveEmpresa(base), d);`
  );
  s = s.replace(
    `app.get("/api/horas/estado", (req, res) => {
    res.json({
      datos: leerJSON(archivoEmpresa("horas.json"), null),
      ajustes: leerJSON(archivoEmpresa("horas_ajustes.json"), { tipos: {}, jornada: 8, festivos: [] }),
    });
  });`,
    `app.get("/api/horas/estado", async (req, res) => {
    res.json({
      datos: await leerJSON("horas", null),
      ajustes: await leerJSON("horas_ajustes", { tipos: {}, jornada: 8, festivos: [] }),
    });
  });`
  );
  s = s.replace('app.post("/api/horas/ajustes", (req, res) => {', 'app.post("/api/horas/ajustes", async (req, res) => {');
  s = s.replace('escribirJSON(archivoEmpresa("horas_ajustes.json"), limpio);', 'await escribirJSON("horas_ajustes", limpio);');
  s = s.replace(
    'app.get("/api/horas/tarifas", (req, res) => res.json({ tarifas: leerJSON(archivoEmpresa("horas_tarifas.json"), null) }));',
    'app.get("/api/horas/tarifas", async (req, res) => res.json({ tarifas: await leerJSON("horas_tarifas", null) }));'
  );
  s = s.replace('app.post("/api/horas/tarifas", (req, res) => {', 'app.post("/api/horas/tarifas", async (req, res) => {');
  s = s.replace('escribirJSON(archivoEmpresa("horas_tarifas.json"), tarifas);', 'await escribirJSON("horas_tarifas", tarifas);');
  s = s.replace('escribirJSON(archivoEmpresa("horas.json"), datos);', 'await escribirJSON("horas", datos);');
  fs.writeFileSync(path.join(DIR, "horas.cjs"), s);
  console.log("horas OK", !s.includes("archivoEmpresa") && !s.includes("readFileSync"));
}

// ---- iaBC.cjs ----
{
  let s = fs.readFileSync(path.join(DIR, "iaBC.cjs"), "utf8");
  s = s.replace(/Cada cambio aplicado queda anotado en backend\/data\/cambios_bc\.json\./, "Cada cambio aplicado queda anotado en Postgres (clave cambios_bc).");
  s = s.replace('const fs = require("fs");\n\n', "");
  s = s.replace(
    `module.exports = function montarIaBC({ app, obtenerTokenBC, fetchConReintento, path, dirData }) {
  const RAIZ = () => \`https://api.businesscentral.dynamics.com/v2.0/\${process.env.BC_TENANT_ID}/\${process.env.BC_ENVIRONMENT}\`;
  const RE_EMPRESAS = () => new RegExp(process.env.IA_BC_EMPRESAS || "also|ferros|quimlab", "i");
  const LOG_FILE = path.join(dirData, "cambios_bc.json");
  const pendientes = new Map(); // id → cambio propuesto (en memoria)

  // ---------- REGLAS APRENDIDAS (24/09/2026) ----------
  // Lo que Maria le va enseñando («a partir de ahora siempre…»). Se guarda en
  // backend/data/reglas_ia.json y se le recuerda a la IA en CADA conversación.
  // ambito: "todas" (las 3 empresas) o el nombre de una empresa.
  const REGLAS_FILE = path.join(dirData, "reglas_ia.json");
  const leerReglas = () => { try { return JSON.parse(fs.readFileSync(REGLAS_FILE, "utf8")); } catch { return []; } };
  const escribirReglas = (lista) => { fs.mkdirSync(path.dirname(REGLAS_FILE), { recursive: true }); fs.writeFileSync(REGLAS_FILE, JSON.stringify(lista, null, 1)); };
  const reglasPara = (empresaNombre) => leerReglas().filter((r) => r.ambito === "todas" || r.ambito === empresaNombre);`,
    `module.exports = function montarIaBC({ app, obtenerTokenBC, fetchConReintento, db }) {
  const RAIZ = () => \`https://api.businesscentral.dynamics.com/v2.0/\${process.env.BC_TENANT_ID}/\${process.env.BC_ENVIRONMENT}\`;
  const RE_EMPRESAS = () => new RegExp(process.env.IA_BC_EMPRESAS || "also|ferros|quimlab", "i");
  const pendientes = new Map(); // id → cambio propuesto (en memoria)

  // ---------- REGLAS APRENDIDAS (Postgres: reglas_ia) ----------
  const leerReglas = async () => {
    const v = await db.getDoc("reglas_ia", []);
    return Array.isArray(v) ? v : [];
  };
  const escribirReglas = async (lista) => db.setDoc("reglas_ia", lista);
  const reglasPara = async (empresaNombre) => (await leerReglas()).filter((r) => r.ambito === "todas" || r.ambito === empresaNombre);`
  );

  s = s.replace(
    `function buscarCambio(id) {
    if (pendientes.has(id)) return pendientes.get(id);
    try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")).reverse().find((c) => c.id === id) || null; } catch { return null; }
  }`,
    `async function buscarCambio(id) {
    if (pendientes.has(id)) return pendientes.get(id);
    try {
      const lista = await db.getDoc("cambios_bc", []);
      return (Array.isArray(lista) ? lista : []).slice().reverse().find((c) => c.id === id) || null;
    } catch { return null; }
  }`
  );
  s = s.replace(
    "const cambio = buscarCambio(String(req.body?.id || \"\"));",
    "const cambio = await buscarCambio(String(req.body?.id || \"\"));"
  );

  // Replace chats section — find markers
  const chatStart = s.indexOf("// ---------- CHATS GUARDADOS");
  const reglasGet = s.indexOf('app.get("/api/ia-bc/reglas"');
  if (chatStart < 0 || reglasGet < 0) throw new Error("chats markers not found");
  const chatsNew = `// ---------- CHATS GUARDADOS (Postgres: chats_ia = { [id]: chat }) ----------
  const validarIdChat = (id) => {
    if (!/^[a-z0-9_-]{4,60}$/i.test(String(id || ""))) throw new Error("Id de chat no válido");
    return String(id);
  };
  app.get("/api/ia-bc/chats", async (req, res) => {
    try {
      const empresa = String(req.query.empresa || "");
      const mapa = await db.getDoc("chats_ia", {});
      const lista = Object.values(mapa || {}).map((c) => ({
        id: c.id, titulo: c.titulo, empresa: c.empresa, empresaNombre: c.empresaNombre,
        creado: c.creado, actualizado: c.actualizado,
        nMensajes: (c.mensajes || []).filter((m) => m.rol === "yo").length,
      })).filter((c) => !empresa || c.empresa === empresa);
      lista.sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)));
      res.json({ chats: lista });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  app.get("/api/ia-bc/chats/:id", async (req, res) => {
    try {
      const id = validarIdChat(req.params.id);
      const mapa = await db.getDoc("chats_ia", {});
      if (!mapa[id]) return res.status(404).json({ error: "No encuentro ese chat." });
      res.json(mapa[id]);
    } catch { res.status(404).json({ error: "No encuentro ese chat." }); }
  });
  app.post("/api/ia-bc/chats", async (req, res) => {
    try {
      const b = req.body || {};
      const id = validarIdChat(b.id || \`chat\${Date.now()}\${Math.random().toString(36).slice(2, 6)}\`);
      const mapa = await db.getDoc("chats_ia", {});
      const previo = mapa[id] || {};
      const primero = (b.mensajes || []).find((m) => m.rol === "yo");
      const chat = {
        id,
        empresa: b.empresa || previo.empresa || "",
        empresaNombre: b.empresaNombre || previo.empresaNombre || "",
        titulo: b.titulo || previo.titulo || (primero ? String(primero.texto || "").replace(/\\s+/g, " ").slice(0, 80) : "Conversación nueva"),
        creado: previo.creado || new Date().toISOString(),
        actualizado: new Date().toISOString(),
        mensajes: Array.isArray(b.mensajes) ? b.mensajes : previo.mensajes || [],
        historial: Array.isArray(b.historial) ? b.historial : previo.historial || [],
      };
      mapa[id] = chat;
      await db.setDoc("chats_ia", mapa);
      res.json({ ok: true, id, titulo: chat.titulo });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  app.post("/api/ia-bc/chats/borrar", async (req, res) => {
    try {
      const id = validarIdChat(req.body?.id);
      const mapa = await db.getDoc("chats_ia", {});
      delete mapa[id];
      await db.setDoc("chats_ia", mapa);
    } catch {}
    res.json({ ok: true });
  });

  `;
  s = s.slice(0, chatStart) + chatsNew + s.slice(reglasGet);

  s = s.replace(
    'app.get("/api/ia-bc/reglas", (req, res) => res.json({ reglas: leerReglas() }));',
    'app.get("/api/ia-bc/reglas", async (req, res) => res.json({ reglas: await leerReglas() }));'
  );
  s = s.replace(
    `app.post("/api/ia-bc/reglas", (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "La regla está vacía." });
    const lista = leerReglas();
    const id = req.body?.id;
    const idx = id ? lista.findIndex((r) => r.id === id) : -1;
    const regla = { id: idx >= 0 ? id : \`r\${Date.now()}\`, texto, ambito: String(req.body?.ambito || "todas"), ts: new Date().toISOString() };
    if (idx >= 0) lista[idx] = regla; else lista.push(regla);
    escribirReglas(lista);
    res.json({ ok: true, regla });
  });`,
    `app.post("/api/ia-bc/reglas", async (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "La regla está vacía." });
    const lista = await leerReglas();
    const id = req.body?.id;
    const idx = id ? lista.findIndex((r) => r.id === id) : -1;
    const regla = { id: idx >= 0 ? id : \`r\${Date.now()}\`, texto, ambito: String(req.body?.ambito || "todas"), ts: new Date().toISOString() };
    if (idx >= 0) lista[idx] = regla; else lista.push(regla);
    await escribirReglas(lista);
    res.json({ ok: true, regla });
  });`
  );
  s = s.replace(
    `app.post("/api/ia-bc/reglas/borrar", (req, res) => {
    escribirReglas(leerReglas().filter((r) => r.id !== req.body?.id));
    res.json({ ok: true });
  });`,
    `app.post("/api/ia-bc/reglas/borrar", async (req, res) => {
    await escribirReglas((await leerReglas()).filter((r) => r.id !== req.body?.id));
    res.json({ ok: true });
  });`
  );
  s = s.replace(
    `app.get("/api/ia-bc/historial-cambios", (req, res) => {
    try { res.json({ cambios: JSON.parse(fs.readFileSync(LOG_FILE, "utf8")).slice(-100).reverse() }); }
    catch { res.json({ cambios: [] }); }
  });`,
    `app.get("/api/ia-bc/historial-cambios", async (req, res) => {
    try {
      const lista = await db.getDoc("cambios_bc", []);
      res.json({ cambios: (Array.isArray(lista) ? lista : []).slice(-100).reverse() });
    } catch { res.json({ cambios: [] }); }
  });`
  );
  s = s.replace(
    `function anotar(cambio) {
    try {
      let lista = [];
      try { lista = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); } catch {}
      lista.push({ ...cambio });
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.writeFileSync(LOG_FILE, JSON.stringify(lista, null, 1));
    } catch (e) {
      console.warn("[ia-bc] No se pudo anotar el cambio:", e.message);
    }`,
    `async function anotar(cambio) {
    try {
      let lista = await db.getDoc("cambios_bc", []);
      if (!Array.isArray(lista)) lista = [];
      lista.push({ ...cambio });
      await db.setDoc("cambios_bc", lista);
    } catch (e) {
      console.warn("[ia-bc] No se pudo anotar el cambio:", e.message);
    }`
  );

  // Await async helpers where used (reglasPara / anotar)
  s = s.replace(/([^w])reglasPara\(/g, "$1await reglasPara(");
  s = s.replace(/await await reglasPara\(/g, "await reglasPara(");
  // anotar calls — only bare anotar(
  s = s.replace(/(^|[^\w.])anotar\(/gm, "$1await anotar(");
  s = s.replace(/await await anotar\(/g, "await anotar(");
  s = s.replace(/async await function anotar/g, "async function anotar");

  fs.writeFileSync(path.join(DIR, "iaBC.cjs"), s);
  console.log("iaBC OK", !s.includes("LOG_FILE") && !s.includes("readFileSync") && !s.includes("dirData"));
}

console.log("Modules adapted.");
