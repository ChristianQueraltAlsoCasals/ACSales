/**
 * horas.cjs — CONTROL DE HORAS de los trabajadores (24/09/2026).
 *
 * Carga desde BC los MOVIMIENTOS DE PROYECTO (página 92 «Movs. proyecto»,
 * publicada como servicio web OData) de tipo Recurso y los guarda en
 * Postgres (claveEmpresa horas / horas_ferros…). Solo LECTURA de BC.
 * El cliente de cada OT NO se pide a Job_List: se reutiliza Memoria histórica
 * (otFiles / fichas en estado).
 *
 *   GET  /api/horas/estado          → horas guardadas + tipos de trabajo + ajustes
 *   POST /api/horas/cargar          {desde, hasta} → lee BC y guarda
 *   POST /api/horas/ajustes         {tipos, jornada, festivos} → guarda la clasificación
 *   GET  /api/horas/servicios       → qué servicios web hay publicados (ayuda)
 *
 * Servicio web: «JobLedgerEntries» (publicado en BC), o BC_WS_MOVSPROYECTO en
 * .env, o se busca en el catálogo (nombres tipo «Movs_proyecto»…).
 *
 * Un trabajador en activo (con alguna imputación en los 21 días anteriores al
 * periodo) entra en el cuadro aunque el periodo elegido no tenga ninguna línea
 * suya: ese día laborable sale como sin imputar.
 */
const DIAS_ACTIVO = 21;

function fechaMenos(iso, dias) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dias);
  return dt.toISOString().slice(0, 10);
}

function altaRecurso(fila, campo) {
  const emp = String(campo(fila, ["Employment_Date", "Fecha_empleo", "EmploymentDate"]) || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(emp) && emp > "1900-01-01" ? emp : "";
}

module.exports = function montarHoras({ app, obtenerTokenBC, fetchConReintento, EMPRESA_NOMBRE, EMPRESA_ID, db, claveEmpresa }) {
  const fs = require("fs");
  const path = require("path");
  const raiz = () => `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/ODataV4/Company('${encodeURIComponent(EMPRESA_NOMBRE() || "")}')`;
  const leerJSON = async (base, def) => db.getDoc(claveEmpresa(base), def);
  const escribirJSON = async (base, d) => db.setDoc(claveEmpresa(base), d);
  const { erpConfigurado, getPool, sql, esErrorConectividadErp } = require("./erp-db");
  const { puedeTarifasPago } = require("./permisos");

  function exigirTarifasPago(req, res) {
    if (puedeTarifasPago(req.usuario)) return true;
    res.status(403).json({ error: "No tienes permiso para Tarifas y pago." });
    return false;
  }

  /** Tarifa MO de Anàlisi per client (Excel): semilla disco + Postgres. */
  function leerTarifaDefectoDisco() {
    try {
      const candidatos = [
        path.join(__dirname, "data", "tarifas_mo_defecto.json"),
        path.join(__dirname, "..", "data", "tarifas_mo_defecto.json"),
      ];
      const p = candidatos.find((x) => fs.existsSync(x));
      if (!p) return null;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!j || !Array.isArray(j.filas) || !j.filas.length) return null;
      return {
        origen: j.origen || "tarifas_mo_defecto.json",
        actualizado: j.actualizado || null,
        filas: j.filas,
        ambito: "general",
      };
    } catch {
      return null;
    }
  }

  function preciosDesdeFilas(filas) {
    const precios = {};
    for (const r of filas || []) {
      const prod = String(r.producto || r["N.º de producto"] || r.Product_No || "").trim();
      const tipo = String(r.tipoTrabajo || r["Cód. tipo trabajo"] || r.Work_Type_Code || "").trim();
      const precio = Number(r.precio ?? r["Precio venta"] ?? r.Unit_Price);
      if (!prod || !tipo || !(precio > 0)) continue;
      precios[`${prod}|${tipo}`] = precio;
    }
    return precios;
  }

  function buscarTarifaEspecial(doc, candidatos) {
    const mapa = doc && doc.clientes && typeof doc.clientes === "object" ? doc.clientes : {};
    const keys = Object.keys(mapa);
    for (const c of candidatos) {
      if (!c) continue;
      if (mapa[c] && Array.isArray(mapa[c].filas) && mapa[c].filas.length) return mapa[c];
      const low = c.toLowerCase();
      const hit = keys.find((k) => k.toLowerCase() === low);
      if (hit && mapa[hit]?.filas?.length) return mapa[hit];
    }
    return null;
  }

  async function resolverTarifaAcsales(candidatosCliente) {
    let doc = {};
    if (db && claveEmpresa) {
      try {
        doc = await db.getDoc(claveEmpresa("analisis_cliente_tarifas"), {});
      } catch {
        doc = {};
      }
    }
    let general = doc.general && Array.isArray(doc.general.filas) && doc.general.filas.length
      ? doc.general
      : null;
    if (!general) general = leerTarifaDefectoDisco();
    const especial = buscarTarifaEspecial(doc, candidatosCliente);
    const activa = especial && especial.filas?.length ? especial : general;
    return {
      general,
      especial: especial || null,
      activa,
      usaEspecial: !!(especial && especial.filas?.length),
    };
  }

  let catEstado = "";
  async function catalogo(token) {
    try {
      const r = await fetchConReintento(raiz(), { headers: { Authorization: `Bearer ${token}` } });
      catEstado = r.ok ? "ok" : `BC ${r.status}`;
      return r.ok ? ((await r.json()).value || []).map((x) => x.name) : [];
    } catch (e) { catEstado = String(e.message || e); return []; }
  }
  function elegir(cat, candidatos, patrones) {
    const c = candidatos.filter(Boolean).find((n) => !cat.length || cat.includes(n));
    if (c && (cat.includes(c) || !cat.length)) return c;
    return cat.find((n) => patrones.every((re) => re.test(n))) || null;
  }
  // Valor de un campo probando varios nombres posibles (según idioma/versión de la página)
  const campo = (fila, nombres) => {
    for (const n of nombres) if (fila[n] != null && fila[n] !== "") return fila[n];
    return "";
  };

  /**
   * Cliente (y línea de negocio) de cada OT desde Memoria histórica — sin bajar Job_List.
   * Fuentes: otFiles (listado «Desde BC» / CSV) y fichas construidas. Opcional: clientes
   * de la carga anterior de horas para OTs que aún no estén en la memoria.
   */
  async function otsDesdeMemoriaHistorica(otsUsadas, clientesPrevios = null) {
    const mapa = {}; // ot → { cliente, dimension }
    if (!otsUsadas?.size) return { mapa, cubiertas: 0 };
    const pref = claveEmpresa("estado");
    const poner = (ot, cliente, dimension) => {
      const no = String(ot || "").trim();
      if (!no || !otsUsadas.has(no)) return;
      const prev = mapa[no] || { cliente: "", dimension: "" };
      const cli = String(cliente || "").trim();
      const dim = String(dimension || "").trim();
      if (cli && !prev.cliente) prev.cliente = cli;
      if (dim && !prev.dimension) prev.dimension = dim;
      mapa[no] = prev;
    };
    try {
      const otFiles = await db.getDoc(`${pref}.otFiles`, []);
      if (Array.isArray(otFiles)) {
        for (const archivo of otFiles) {
          for (const fila of archivo?.data || []) {
            poner(
              fila.OT || fila.ot,
              fila.Client || fila.Cliente || fila.cliente,
              fila["Línia negoci"] || fila["Linea negoci"] || fila.lineaNegocio
            );
          }
        }
      }
    } catch { /* sin otFiles */ }
    try {
      const raw = await db.getDoc(`${pref}.fichas`, []);
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const f = Array.isArray(entry) ? entry[1] : entry;
          if (!f) continue;
          const cli = f.general?.cliente;
          const dim = f.general?.segmento || f.general?.unidadNegocio || "";
          for (const ot of [
            f.numeroOTOrigenes?.listado,
            f.numeroOTOrigenes?.listadoOTs,
            f.numeroOT,
          ]) poner(ot, cli, dim);
        }
      }
    } catch { /* sin fichas */ }
    if (clientesPrevios && typeof clientesPrevios === "object") {
      for (const ot of otsUsadas) {
        if (mapa[ot]?.cliente) continue;
        const cli = String(clientesPrevios[ot] || "").trim();
        if (cli) poner(ot, cli, "");
      }
    }
    return { mapa, cubiertas: Object.values(mapa).filter((x) => x.cliente).length };
  }

  /** Nº de recurso → grupo (MOINS01, MOMA02…). La ficha de recurso de BC. */
  async function leerGruposRecurso(token, cat) {
    const servRec = elegir(cat, [process.env.BC_WS_RECURSOS, "Ficha_recurso_Excel", "Recursos", "Resource_List", "Lista_recursos", "Resources"], [/recurs|resource/i]);
    if (!servRec) return { grupos: {}, nombres: {}, tipoRecurso: {}, alta: {}, servicio: null };
    const sel = servRec === "Ficha_recurso_Excel" ? "?$select=No,Name,Type,Resource_Group_No,Employment_Date" : "";
    const grupos = {};
    const nombres = {};
    const tipoRecurso = {};
    const alta = {};
    let filasRec;
    try {
      filasRec = await leerTodo(`${raiz()}/${encodeURIComponent(servRec)}${sel}`, token, 20000);
    } catch (e) {
      if (!sel || (e.status !== 400 && e.status !== 404)) throw e;
      filasRec = await leerTodo(`${raiz()}/${encodeURIComponent(servRec)}`, token, 20000);
    }
    for (const r of filasRec) {
      const no = String(campo(r, ["No", "No_", "Nº"]));
      if (!no) continue;
      nombres[no] = String(campo(r, ["Name", "Nombre"]) || no);
      tipoRecurso[no] = String(campo(r, ["Type", "Tipo"]) || "");
      const g = String(campo(r, ["Resource_Group_No", "Grupo_recurso", "ResourceGroupNo"]) || "").trim();
      if (g) grupos[no] = g;
      const altaDia = altaRecurso(r, campo);
      if (altaDia) alta[no] = altaDia;
    }
    return { grupos, nombres, tipoRecurso, alta, servicio: servRec };
  }

  async function leerTodo(url, token, max = 200000) {
    const filas = [];
    while (url && filas.length < max) {
      const r = await fetchConReintento(url, { headers: { Authorization: `Bearer ${token}`, Prefer: "odata.maxpagesize=5000" } });
      if (!r.ok) { const t = await r.text(); const e = new Error(`BC ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
      const j = await r.json();
      filas.push(...(j.value || []));
      url = j["@odata.nextLink"] || null;
    }
    return filas;
  }

  app.get("/api/horas/servicios", async (req, res) => {
    try {
      const token = await obtenerTokenBC();
      const cat = await catalogo(token);
      res.json({ empresa: EMPRESA_NOMBRE(), servicios: cat });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get("/api/horas/estado", async (req, res) => {
    res.json({
      datos: await leerJSON("horas", null),
      ajustes: await leerJSON("horas_ajustes", { tipos: {}, jornada: 8, festivos: [] }),
    });
  });

  // Grupos de recurso (departamento) sin exigir la tabla Recursos de Cargar datos.
  app.get("/api/horas/grupos", async (req, res) => {
    try {
      const prev = await leerJSON("horas", null);
      if (prev?.grupos && Object.keys(prev.grupos).length) {
        return res.json({ grupos: prev.grupos, origen: "guardado" });
      }
      const token = await obtenerTokenBC();
      const cat = await catalogo(token);
      const leido = await leerGruposRecurso(token, cat);
      if (!Object.keys(leido.grupos).length) {
        return res.status(404).json({ error: "La ficha de recurso no trae el grupo.", servicio: leido.servicio });
      }
      if (prev) await escribirJSON("horas", { ...prev, grupos: leido.grupos });
      res.json({ grupos: leido.grupos, servicio: leido.servicio });
    } catch (e) {
      console.error("Error /api/horas/grupos:", e);
      res.status(500).json({ error: "No se pudieron leer los departamentos.", detalle: String(e.message || e) });
    }
  });

  app.post("/api/horas/ajustes", async (req, res) => {
    try {
      const a = req.body || {};
      const fecha = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
      const txt = (v, n = 200) => String(v ?? "").slice(0, n);
      const prev = await leerJSON("horas_ajustes", {});
      const limpio = {
        tipos: typeof a.tipos === "object" && a.tipos ? a.tipos : {},
        jornada: Number(a.jornada) > 0 ? Number(a.jornada) : 8,
        jornadaViernes: Number(a.jornadaViernes) > 0 ? Number(a.jornadaViernes) : null,
        festivos: Array.isArray(a.festivos) ? a.festivos.filter(fecha) : [],
        // Festivos línea a línea (trabajador o «Todos» · tipo · fecha · descripción)
        festivosLista: Array.isArray(a.festivosLista) ? a.festivosLista.filter((l) => fecha(l.fecha)).map((l) => ({ id: txt(l.id, 40), recurso: txt(l.recurso, 40), tipo: txt(l.tipo, 40), fecha: l.fecha, desc: txt(l.desc, 200) })) : undefined,
        // Configuración (24/09/2026): festivos por población, población de cada trabajador e incidencias
        poblaciones: Array.isArray(a.poblaciones) ? a.poblaciones.map((p) => ({ nombre: txt(p.nombre, 80), festivos: (p.festivos || []).filter(fecha) })).filter((p) => p.nombre) : [],
        asignacion: typeof a.asignacion === "object" && a.asignacion ? Object.fromEntries(Object.entries(a.asignacion).map(([k, v]) => [txt(k, 40), txt(v, 80)])) : {},
        incidencias: Array.isArray(a.incidencias) ? a.incidencias.map((i) => ({
          id: txt(i.id, 40), recurso: txt(i.recurso, 40), tipo: txt(i.tipo, 30), desde: fecha(i.desde) ? i.desde : "", hasta: fecha(i.hasta) ? i.hasta : "",
          horas: Number(i.horas) || 0, codigo: txt(i.codigo, 40), motivo: txt(i.motivo, 300),
        })).filter((i) => i.recurso && i.tipo) : [],
      };
      // Un formulario que aún no ha cargado lo guardado manda listas vacías.
      // En ese caso se conservan festivos, jornada por trabajador y tipos.
      const sinListas = !Array.isArray(a.festivosLista) && !Array.isArray(a.incidencias)
        && (!Array.isArray(a.festivos) || a.festivos.length === 0)
        && (!a.tipos || !Object.keys(a.tipos).length);
      const prevTiene = (Array.isArray(prev.festivosLista) && prev.festivosLista.length)
        || (Array.isArray(prev.incidencias) && prev.incidencias.length)
        || (Array.isArray(prev.festivos) && prev.festivos.length)
        || (prev.tipos && Object.keys(prev.tipos).length);
      if (sinListas && prevTiene) {
        limpio.tipos = prev.tipos || {};
        limpio.festivos = prev.festivos || [];
        limpio.festivosLista = prev.festivosLista;
        limpio.poblaciones = prev.poblaciones || [];
        limpio.asignacion = prev.asignacion || {};
        limpio.incidencias = prev.incidencias || [];
      }
      const idsRecurso = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => txt(x, 40)).filter(Boolean))] : null);
      limpio.inactivos = idsRecurso(a.inactivos) || (Array.isArray(prev.inactivos) ? prev.inactivos : []);
      limpio.activosForzados = idsRecurso(a.activosForzados) || (Array.isArray(prev.activosForzados) ? prev.activosForzados : []);
      await escribirJSON("horas_ajustes", limpio);
      res.json({ ajustes: limpio });
    } catch (e) { res.status(500).json({ error: "No se pudieron guardar los ajustes.", detalle: String(e.message || e) }); }
  });

  // Tabla de tarifas (Excel de Maria con los precios de las extras por trabajador)
  app.get("/api/horas/tarifas", async (req, res) => {
    if (!exigirTarifasPago(req, res)) return;
    res.json({ tarifas: await leerJSON("horas_tarifas", null) });
  });
  app.post("/api/horas/tarifas", async (req, res) => {
    if (!exigirTarifasPago(req, res)) return;
    try {
      const t = req.body || {};
      const columnas = Array.isArray(t.columnas) ? t.columnas.map((c) => String(c).slice(0, 120)) : [];
      const filas = Array.isArray(t.filas) ? t.filas.slice(0, 5000).map((f) => Object.fromEntries(columnas.map((c) => [c, f?.[c] ?? ""]))) : [];
      const tarifas = {
        archivo: String(t.archivo || "").slice(0, 200), hoja: String(t.hoja || "").slice(0, 100),
        subido: t.subido || new Date().toISOString(), columnas, filas,
        mapeo: typeof t.mapeo === "object" && t.mapeo ? t.mapeo : {},
      };
      await escribirJSON("horas_tarifas", tarifas);
      res.json({ tarifas });
    } catch (e) { res.status(500).json({ error: "No se pudo guardar la tabla de tarifas.", detalle: String(e.message || e) }); }
  });

  // Partes con amianto (ALSOAPP.dbo.Parte, esAmiant=1) para el plus diario en Control de horas.
  // Fecha del día = date_created. Solo lectura. Precio por defecto 30 €/día (editable en pantalla).
  app.get("/api/horas/amianto", async (req, res) => {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.desde) ? req.query.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.hasta) ? req.query.hasta : null;
    if (!desde || !hasta) return res.status(400).json({ error: "Indica desde y hasta (AAAA-MM-DD)." });
    if (!erpConfigurado()) return res.status(503).json({ error: "SQL del ERP (ALSOAPP) no configurado. Revisa ERP_MSSQL_* en .env y Tailscale." });
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input("desde", sql.DateTime, new Date(`${desde}T00:00:00`))
        .input("hasta", sql.DateTime, new Date(`${hasta}T23:59:59.997`))
        .query(`
          SELECT id, idOT, codiTreballador, treballador, codigoParte, date_created
          FROM [ALSOAPP].[dbo].[Parte]
          WHERE esAmiant = 1
            AND date_created >= @desde AND date_created <= @hasta
          ORDER BY date_created, id
        `);
      const partes = (r.recordset || []).map((p) => ({
        id: String(p.id),
        idOT: p.idOT != null ? String(p.idOT) : "",
        codiTreballador: String(p.codiTreballador || "").trim(),
        treballador: String(p.treballador || "").trim(),
        codigoParte: String(p.codigoParte || "").trim(),
        fecha: p.date_created ? new Date(p.date_created).toISOString().slice(0, 10) : "",
      })).filter((p) => p.fecha && p.codiTreballador);
      res.json({ desde, hasta, precioDefecto: 30, partes });
    } catch (e) {
      console.error("Error /api/horas/amianto:", e);
      const msg = esErrorConectividadErp(e)
        ? "No se pudo conectar al SQL de producción (¿Tailscale activo?)."
        : "No se pudieron leer los partes de amianto.";
      res.status(esErrorConectividadErp(e) ? 503 : 500).json({ error: msg, detalle: String(e.message || e) });
    }
  });

  app.post("/api/horas/cargar", async (req, res) => {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.desde) ? req.body.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.hasta) ? req.body.hasta : null;
    if (!desde || !hasta) return res.status(400).json({ error: "Indica las fechas desde y hasta." });
    try {
      const token = await obtenerTokenBC();
      const cat = await catalogo(token);
      // Candidatos: el de .env, los del catálogo que encajan y los nombres habituales.
      // Se prueban por orden; un 404 = no existe con ese nombre → siguiente.
      const candidatos = [...new Set([
        process.env.BC_WS_MOVSPROYECTO,
        // Página 92 «Movs. proyecto» publicada en BC como Movs_proyecto_Excel: trae el Nº de recurso,
        // el tipo (Recurso/Producto…), el tipo de movimiento y la cantidad. OJO: «JobLedgerEntries» es la
        // CONSULTA 268 y NO trae el Nº de recurso, así que no sirve para horas por trabajador.
        "Movs_proyecto_Excel",
        ...cat.filter((n) => /mov|ledger/i.test(n) && /proyect|job/i.test(n) && n !== "JobLedgerEntries"),
        ...(cat.length ? [] : ["Movs_proyecto", "Movs_proyectos", "Movimientos_proyecto", "Mov_proyecto", "Job_Ledger_Entries", "JobLedgerEntries"]),
      ].filter(Boolean))];
      const probados = [];
      let servicio = null, brutas = null, avisoFiltro = "";
      // 21 días antes del periodo: solo para saber quién está en activo.
      // Esas líneas no se pintan; si el periodo no tiene ninguna, el día sale en rojo.
      const desdeActivo = fechaMenos(desde, DIAS_ACTIVO);
      for (const nombre of candidatos) {
        const base = `${raiz()}/${encodeURIComponent(nombre)}`;
        try {
          // Filtro de fechas en BC; si el campo se llama distinto, se filtra aquí
          try {
            const sel = nombre === "Movs_proyecto_Excel" ? "&$select=Entry_No,Posting_Date,Entry_Type,Document_No,Job_No,Job_Task_No,Type,No,Description,Work_Type_Code,Unit_of_Measure_Code,Quantity,Total_Cost_LCY" : "";
            brutas = await leerTodo(`${base}?$filter=${encodeURIComponent(`Posting_Date ge ${desdeActivo} and Posting_Date le ${hasta}`)}${sel}`, token);
          } catch (e) {
            if (e.status !== 400) throw e;
            avisoFiltro = "El servicio no admite filtrar por Posting_Date: se ha leído completo y filtrado aquí (más lento).";
            brutas = await leerTodo(base, token);
          }
          if (brutas.length && !("No" in brutas[0])) { // sin Nº de recurso no se puede repartir por trabajador
            probados.push(`${nombre} → no trae el campo «No» (Nº de recurso)`);
            brutas = null; avisoFiltro = "";
            continue;
          }
          servicio = nombre;
          break;
        } catch (e) {
          probados.push(`${nombre} → ${String(e.message || e).slice(0, 120)}`);
          if (e.status !== 404) throw Object.assign(new Error(`Servicio «${nombre}»: ${e.message}`), { status: e.status });
        }
      }
      if (!servicio) {
        return res.status(404).json({
          error: "No encuentro publicado en BC el servicio web de «Movs. proyecto».",
          detalle: `En BC (empresa ${EMPRESA_NOMBRE()}): busca «Servicios web» → Nuevo → Tipo de objeto: Página · Id. objeto: 92 · Nombre del servicio: Movs_proyecto · marca «Publicado». Después vuelve a pulsar «Cargar desde BC». Si ya lo tienes con otro nombre, ponlo en backend/.env como BC_WS_MOVSPROYECTO=NombreDelServicio y reinicia.`,
          probados,
          servicios: cat.length ? cat.slice(0, 300) : [`(no se pudo leer la lista de servicios de BC: ${catEstado})`],
        });
      }
      const fechaDe = (f) => String(campo(f, ["Posting_Date", "Fecha_registro", "PostingDate"])).slice(0, 10);
      const filas = [];
      const activos = new Set();
      const descActivo = {};
      for (const f of brutas) {
        const fecha = fechaDe(f);
        if (!fecha || fecha < desdeActivo || fecha > hasta) continue;
        const tipo = String(campo(f, ["Type", "Tipo"]));
        if (tipo && !/resour|recurs/i.test(tipo)) continue; // solo recursos (personas/máquinas)
        const tipoMov = String(campo(f, ["Entry_Type", "Tipo_movimiento", "EntryType"]));
        if (tipoMov && !/usage|uso|consumo/i.test(tipoMov)) continue; // SOLO tipo de movimiento «Uso» (Entry_Type = Usage)
        const recurso = String(campo(f, ["No", "No_", "Nº"]));
        if (recurso) {
          activos.add(recurso);
          if (!descActivo[recurso]) descActivo[recurso] = String(campo(f, ["Description", "Descripción", "Descripcion"]));
        }
        if (fecha < desde || fecha > hasta) continue;
        filas.push({
          n: campo(f, ["Entry_No", "No_mov", "EntryNo"]),
          fecha,
          recurso: String(campo(f, ["No", "No_", "Nº"])),
          desc: String(campo(f, ["Description", "Descripción", "Descripcion"])),
          ot: String(campo(f, ["Job_No", "No_proyecto", "JobNo"])),
          tarea: String(campo(f, ["Job_Task_No", "No_tarea_proyecto", "JobTaskNo"])),
          tipoTrabajo: String(campo(f, ["Work_Type_Code", "Cod_tipo_trabajo", "WorkTypeCode"])),
          unidad: String(campo(f, ["Unit_of_Measure_Code", "Cod_unidad_medida", "UnitOfMeasureCode"])),
          horas: Number(campo(f, ["Quantity", "Cantidad"])) || 0,
          coste: Number(campo(f, ["Total_Cost_LCY", "Total_Cost", "Coste_total_DL"])) || 0,
          doc: String(campo(f, ["Document_No", "No_documento", "DocumentNo"])),
        });
      }
      // Nombres, tipo y grupo de recurso (departamento) desde la ficha de recurso.
      let nombres = {}, tipoRecurso = {}, grupos = {}, alta = {}, servRec = null;
      try {
        const leido = await leerGruposRecurso(token, cat);
        nombres = leido.nombres;
        tipoRecurso = leido.tipoRecurso;
        grupos = leido.grupos;
        alta = leido.alta || {};
        servRec = leido.servicio;
      } catch { /* sin ficha: se usa la descripción del movimiento */ }
      for (const rec of activos) if (!nombres[rec] && descActivo[rec]) nombres[rec] = descActivo[rec];
      for (const f of filas) if (!nombres[f.recurso] && f.desc) nombres[f.recurso] = f.desc;
      // Cliente de cada OT: Memoria histórica (otFiles / fichas), no Job_List de BC
      const otsUsadas = new Set(filas.map((f) => f.ot).filter(Boolean));
      const prevHoras = await leerJSON("horas", null);
      const { mapa: otsMem, cubiertas } = await otsDesdeMemoriaHistorica(otsUsadas, prevHoras?.clientes || null);
      const clientes = {};
      for (const [ot, v] of Object.entries(otsMem)) if (v.cliente) clientes[ot] = v.cliente;
      let avisoClientes = "";
      if (otsUsadas.size && !cubiertas) {
        avisoClientes = "Sin cliente de OT: carga el listado en Memoria histórica («Desde BC») o construye la memoria.";
      } else if (otsUsadas.size && cubiertas < otsUsadas.size) {
        avisoClientes = `Cliente de OT desde memoria histórica (${cubiertas}/${otsUsadas.size}); el resto sin cliente en el listado.`;
      }
      const aviso = [avisoFiltro, avisoClientes].filter(Boolean).join(" ");
      const datos = {
        empresa: EMPRESA_NOMBRE(), desde, hasta, servicio, servicioRecursos: servRec || null,
        cargado: new Date().toISOString(), leidas: brutas.length, filas, nombres, tipoRecurso, grupos, alta, activos: [...activos], clientes, aviso,
        camposEjemplo: brutas[0] ? Object.keys(brutas[0]).filter((k) => !k.startsWith("@")) : [],
      };
      await escribirJSON("horas", datos);
      console.log(`[horas] ${datos.empresa} ${desde}→${hasta}: ${brutas.length} movimientos leídos de ${servicio}, ${filas.length} de recursos · clientes memoria ${cubiertas}/${otsUsadas.size}`);
      res.json({ datos });
    } catch (e) {
      console.error("Error /api/horas/cargar:", e);
      res.status(500).json({ error: "No se pudieron cargar las horas de BC.", detalle: String(e.message || e) });
    }
  });

  // Horas reales de Movs. proyecto. Solo recurso y tipo de movimiento Uso.
  app.get("/api/horas/mano-obra", async (req, res) => {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.desde) ? req.query.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.hasta) ? req.query.hasta : null;
    if (!desde || !hasta) return res.status(400).json({ error: "Indica las fechas desde y hasta." });
    if (desde > hasta) return res.status(400).json({ error: "La fecha inicial no puede ser posterior a la fecha final." });
    try {
      const token = await obtenerTokenBC();
      const cat = await catalogo(token);
      const candidatos = [...new Set([
        process.env.BC_WS_MOVSPROYECTO,
        "Movs_proyecto_Excel",
        ...cat.filter((n) => /mov|ledger/i.test(n) && /proyect|job/i.test(n) && n !== "JobLedgerEntries"),
      ].filter(Boolean))];
      let brutas = null;
      let servicio = null;
      for (const nombre of candidatos) {
        const base = `${raiz()}/${encodeURIComponent(nombre)}`;
        try {
          const sel = nombre === "Movs_proyecto_Excel" ? "&$select=Entry_No,Posting_Date,Entry_Type,Document_No,Job_No,Job_Task_No,Type,No,Description,Work_Type_Code,Unit_of_Measure_Code,Quantity,Total_Cost_LCY" : "";
          try {
            brutas = await leerTodo(`${base}?$filter=${encodeURIComponent(`Posting_Date ge ${desde} and Posting_Date le ${hasta}`)}${sel}`, token);
          } catch (e) {
            if (e.status !== 400) throw e;
            brutas = await leerTodo(base, token);
          }
          if (brutas.length && !("No" in brutas[0])) { brutas = null; continue; }
          servicio = nombre;
          break;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      if (!servicio) return res.status(404).json({ error: "No encuentro el servicio de Movs. proyecto publicado." });

      const filas = [];
      for (const f of brutas) {
        const fecha = String(campo(f, ["Posting_Date", "Fecha_registro", "PostingDate"])).slice(0, 10);
        if (!fecha || fecha < desde || fecha > hasta) continue;
        const tipo = String(campo(f, ["Type", "Tipo"]));
        if (tipo && !/resour|recurs/i.test(tipo)) continue;
        const tipoMov = String(campo(f, ["Entry_Type", "Tipo_movimiento", "EntryType"])).trim();
        if (!/^(usage|uso)$/i.test(tipoMov)) continue;
        filas.push({
          recurso: String(campo(f, ["No", "No_", "Nº"])),
          desc: String(campo(f, ["Description", "Descripción", "Descripcion"])),
          ot: String(campo(f, ["Job_No", "No_proyecto", "JobNo"])),
          horas: Number(campo(f, ["Quantity", "Cantidad"])) || 0,
        });
      }

      const nombres = {};
      let avisoNombre = "";
      const servRec = elegir(cat, [process.env.BC_WS_RECURSOS, "Ficha_recurso_Excel", "Recursos", "Resource_List", "Lista_recursos", "Resources"], [/recurs|resource/i]);
      if (servRec) {
        try {
          const recursos = await leerTodo(`${raiz()}/${encodeURIComponent(servRec)}?$select=No,Name`, token, 20000);
          for (const r of recursos) {
            const no = String(campo(r, ["No", "No_", "Nº"]));
            if (!no) continue;
            nombres[no] = String(campo(r, ["Name", "Nombre"]) || no);
          }
        } catch (e) {
          if (e.status !== 400) throw e;
          avisoNombre = "No se ha podido leer el nombre del recurso.";
        }
      }

      const otsUsadas = new Set(filas.map((f) => f.ot).filter(Boolean));
      const { mapa: ots, cubiertas } = await otsDesdeMemoriaHistorica(otsUsadas);
      let avisoOt = "";
      if (otsUsadas.size && !cubiertas) {
        avisoOt = "Sin cliente/dimensión de OT en Memoria histórica (carga el listado «Desde BC» o construye la memoria).";
      }

      const grupos = new Map();
      for (const f of filas) {
        const ot = ots[f.ot] || { cliente: "", dimension: "" };
        const clave = [f.recurso, f.ot, ot.cliente, ot.dimension].join("|");
        const prev = grupos.get(clave) || {
          recurso: f.recurso,
          nombre: nombres[f.recurso] || f.desc || f.recurso,
          ot: f.ot,
          cliente: ot.cliente,
          dimension: ot.dimension,
          horas: 0,
        };
        prev.horas += f.horas;
        grupos.set(clave, prev);
      }
      const salida = [...grupos.values()]
        .map((r) => ({ ...r, horas: Math.round(r.horas * 100) / 100 }))
        .sort((a, b) => b.horas - a.horas || a.nombre.localeCompare(b.nombre, "es"));

      console.log(`[horas/mano-obra] ${EMPRESA_NOMBRE()} ${desde}→${hasta}: ${filas.length} movimientos de uso, ${salida.length} líneas`);
      res.json({
        empresa: EMPRESA_NOMBRE(),
        desde,
        hasta,
        servicio,
        aviso: [avisoNombre, avisoOt].filter(Boolean).join(" "),
        filas: salida,
      });
    } catch (e) {
      console.error("Error /api/horas/mano-obra:", e);
      res.status(500).json({ error: "No se pudieron cargar las horas.", detalle: String(e.message || e) });
    }
  });

  // Horas de UNA OT con presupuesto. Movs. proyecto, todas las fechas:
  // tipo de movimiento Uso y tipo Recurso. Cualquier tipo de trabajo.
  app.get("/api/horas/ot-uso", async (req, res) => {
    const no = String(req.query?.no || "").trim();
    if (!no) return res.status(400).json({ error: "Falta el nº de OT (ej. AC014549/2026)." });
    try {
      const token = await obtenerTokenBC();
      const cat = await catalogo(token);
      const candidatos = [...new Set([
        process.env.BC_WS_MOVSPROYECTO,
        "Movs_proyecto_Excel",
        ...cat.filter((n) => /mov|ledger/i.test(n) && /proyect|job/i.test(n) && n !== "JobLedgerEntries"),
      ].filter(Boolean))];
      const noSafe = no.replace(/'/g, "''");
      const selects = [
        "&$select=Entry_No,Posting_Date,Entry_Type,Document_No,Job_No,Job_Task_No,Type,No,Description,Work_Type_Code,Unit_of_Measure_Code,Quantity",
        "",
      ];
      const camposJob = ["Job_No", "No_proyecto", "JobNo"];
      let brutas = null;
      let servicio = null;
      let campoJob = null;
      let ultimo = null;
      for (const nombre of candidatos) {
        const base = `${raiz()}/${encodeURIComponent(nombre)}`;
        let encontrado = false;
        for (const sel of selects) {
          for (const campo of camposJob) {
            try {
              brutas = await leerTodo(`${base}?$filter=${encodeURIComponent(`${campo} eq '${noSafe}'`)}${sel}`, token);
              servicio = nombre;
              campoJob = campo;
              encontrado = true;
              break;
            } catch (e) {
              ultimo = e;
              if (e.status === 404) { encontrado = false; break; }
              if (e.status === 400) continue;
              throw e;
            }
          }
          if (encontrado || (ultimo && ultimo.status === 404)) break;
        }
        if (brutas) break;
      }
      if (!brutas) {
        return res.status(404).json({
          error: "No encuentro Movs. proyecto para esta OT.",
          detalle: ultimo ? String(ultimo.message || ultimo).slice(0, 300) : "",
        });
      }
      const filas = [];
      for (const f of brutas) {
        const tipo = String(campo(f, ["Type", "Tipo"])).trim();
        if (!/resour|recurs/i.test(tipo)) continue;
        const tipoMov = String(campo(f, ["Entry_Type", "Tipo_movimiento", "EntryType"])).trim();
        if (!/^(usage|uso)$/i.test(tipoMov)) continue;
        filas.push({
          fecha: String(campo(f, ["Posting_Date", "Fecha_registro", "PostingDate"])).slice(0, 10),
          documento: String(campo(f, ["Document_No", "No_documento", "DocumentNo"])),
          tarea: String(campo(f, ["Job_Task_No", "No_tarea_proyecto", "JobTaskNo"])),
          recurso: String(campo(f, ["No", "No_", "Nº"])),
          descripcion: String(campo(f, ["Description", "Descripción", "Descripcion"])),
          tipoTrabajo: String(campo(f, ["Work_Type_Code", "Cod_tipo_trabajo", "WorkTypeCode"])),
          unidad: String(campo(f, ["Unit_of_Measure_Code", "Cod_unidad_medida", "UnitOfMeasureCode"])),
          cantidad: Number(campo(f, ["Quantity", "Cantidad"])) || 0,
        });
      }
      const horas = Math.round(filas.reduce((a, f) => a + f.cantidad, 0) * 100) / 100;
      console.log(`[horas/ot-uso] ${EMPRESA_NOMBRE()} ${no}: ${brutas.length} movs, ${filas.length} de uso/recurso, ${horas} h (${servicio} · ${campoJob})`);
      res.json({ no, servicio, campoJob, horas, filas });
    } catch (e) {
      console.error("Error /api/horas/ot-uso:", e);
      res.status(500).json({ error: "No se pudieron leer las horas de Movs. proyecto.", detalle: String(e.message || e) });
    }
  });

  // Tarifa de mano de obra para valoración OT con presupuesto:
  // precios desde Excel ACSales (Anàlisi G: general o especial del cliente);
  // grupos de recurso desde BC (Ficha_recurso).
  app.get("/api/ot/tarifa-mano-obra", async (req, res) => {
    try {
      const candidatos = [
        String(req.query.cliente || "").trim(),
        String(req.query.nombre || "").trim(),
        String(req.query.numero || "").trim(),
      ].filter(Boolean);

      const tarifaAc = await resolverTarifaAcsales(candidatos);
      if (!tarifaAc.activa?.filas?.length) {
        return res.status(404).json({
          error: "No hi ha tarifa de mà d'obra a ACSales. Puja l'Excel a Anàlisi per client (G).",
        });
      }
      const precios = preciosDesdeFilas(tarifaAc.activa.filas);

      const token = await obtenerTokenBC();
      const recursos = await leerTodo(
        `${raiz()}/Ficha_recurso_Excel?$select=No,Name,Resource_Group_No`,
        token,
        20000
      );
      const grupos = {};
      const nombres = {};
      for (const r of recursos) {
        const no = String(r.No || "").trim();
        if (!no) continue;
        grupos[no] = String(r.Resource_Group_No || "").trim();
        nombres[no] = String(r.Name || "").trim();
      }

      res.json({
        grupos,
        nombres,
        precios,
        lineas: Object.keys(precios).length,
        recursos: Object.keys(grupos).length,
        origen: tarifaAc.activa.origen || (tarifaAc.usaEspecial ? "especial" : "general"),
        usaEspecial: tarifaAc.usaEspecial,
        ambito: tarifaAc.usaEspecial ? "cliente" : "general",
        actualizado: tarifaAc.activa.actualizado || null,
      });
    } catch (e) {
      console.error("Error /api/ot/tarifa-mano-obra:", e);
      res.status(500).json({ error: "No se ha podido leer la tarifa de mano de obra.", detalle: String(e.message || e) });
    }
  });
};
