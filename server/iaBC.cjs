/**
 * iaBC.cjs — ASISTENTE IA con acceso a Business Central (24/09/2026)
 * ---------------------------------------------------------------------
 * Pantalla «Asistente IA» del Agente de Ventas. La IA (Claude, misma
 * ANTHROPIC_API_KEY) puede:
 *   · CONSULTAR cualquier dato de BC (API v2.0 estándar o web services
 *     OData publicados) — sin preguntar.
 *   · PROPONER cambios: MODIFICAR campos o CREAR registros/líneas.
 *     NUNCA los aplica ella: quedan PENDIENTES y solo se ejecutan cuando
 *     la usuaria pulsa «Aplicar» en la tarjeta del cambio.
 *   · NO puede borrar, registrar/postear ni lanzar acciones de BC
 *     (decisión de Maria, 24/09/2026).
 * Empresas permitidas: ALSO CASALS, FERROSCA y QUIMLAB (IA_BC_EMPRESAS
 * en .env para cambiarlo — expresión regular sobre el nombre).
 * Cada cambio aplicado queda anotado en Postgres (clave cambios_bc).
 */
module.exports = function montarIaBC({ app, obtenerTokenBC, fetchConReintento, db }) {
  const RAIZ = () => `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}`;
  const RE_EMPRESAS = () => new RegExp(process.env.IA_BC_EMPRESAS || "also|ferros|quimlab", "i");
  const pendientes = new Map();

  const leerReglas = async () => {
    const v = await db.getDoc("reglas_ia", []);
    return Array.isArray(v) ? v : [];
  };
  const escribirReglas = async (lista) => db.setDoc("reglas_ia", lista);
  const reglasPara = async (empresaNombre) => (await leerReglas()).filter((r) => r.ambito === "todas" || r.ambito === empresaNombre);
  const MAX_RESULTADO = 14000; // caracteres de resultado que se devuelven a la IA

  // ---------- utilidades ----------
  let cacheEmpresas = null;
  async function empresas() {
    if (cacheEmpresas && Date.now() - cacheEmpresas.ts < 10 * 60 * 1000) return cacheEmpresas.lista;
    const token = await obtenerTokenBC();
    const r = await fetchConReintento(`${RAIZ()}/api/v2.0/companies`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`BC respondió ${r.status} al listar empresas`);
    const lista = ((await r.json()).value || [])
      .map((c) => ({ id: c.id, nombre: c.name, displayName: c.displayName }))
      .filter((c) => RE_EMPRESAS().test(`${c.nombre} ${c.displayName || ""}`));
    cacheEmpresas = { ts: Date.now(), lista };
    return lista;
  }
  async function resolverEmpresa(texto) {
    const lista = await empresas();
    const t = String(texto || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const e =
      lista.find((c) => c.id === texto) ||
      lista.find((c) => c.nombre.toLowerCase().replace(/[^a-z0-9]/g, "") === t) ||
      lista.find((c) => c.nombre.toLowerCase().replace(/[^a-z0-9]/g, "").includes(t) || (c.displayName || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(t));
    if (!e) throw new Error(`Empresa "${texto}" no permitida o no encontrada. Permitidas: ${lista.map((c) => c.nombre).join(", ")}`);
    return e;
  }
  const RE_RECURSO = /^[A-Za-z0-9_À-ſ]+$/; // sin "/" ni acciones
  function validarRecurso(recurso) {
    if (!RE_RECURSO.test(String(recurso || ""))) throw new Error(`Nombre de recurso no válido: "${recurso}"`);
  }
  function validarClave(clave) {
    const c = String(clave || "").trim();
    // Solo "(...)" sin "/" (evita llamar a acciones tipo /Microsoft.NAV.post)
    if (!/^\(.+\)$/.test(c) || c.includes("/") || /Microsoft\.NAV/i.test(c)) throw new Error(`Clave no válida: "${clave}" — debe ser (guid) o (Campo='valor',...)`);
    return c;
  }
  async function urlBase(origen, empresa) {
    const e = await resolverEmpresa(empresa);
    if (origen === "odata") return { e, base: `${RAIZ()}/ODataV4/Company('${encodeURIComponent(e.nombre)}')` };
    return { e, base: `${RAIZ()}/api/v2.0/companies(${e.id})` };
  }
  async function pedir(url, opciones = {}) {
    const token = await obtenerTokenBC();
    const r = await fetchConReintento(url, { ...opciones, headers: { Authorization: `Bearer ${token}`, ...(opciones.headers || {}) } });
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch {}
    return { ok: r.ok, status: r.status, json, texto };
  }
  // El 502 que ve Maria es este servidor traduciendo un rechazo de BC.
  // Aquí se deja solo la frase útil (sin CorrelationId ni JSON).
  function textoErrorBC(texto) {
    let msg = String(texto || "");
    try {
      const j = JSON.parse(msg);
      msg = j?.error?.message || j?.message || msg;
    } catch { /* BC a veces responde texto plano */ }
    msg = msg.replace(/\s*CorrelationId:.*$/i, "").trim();
    const serie = msg.match(/No\. Series\s+(\S+)/i);
    if (serie && /assign numbers automatically/i.test(msg)) {
      return `Business Central no asigna el código solo: en la serie ${serie[1]} no está activado «Números por defecto». En clientes y proveedores el código es el NIF, sin guiones.`;
    }
    return msg || "Business Central ha rechazado el cambio.";
  }
  // ALSO CASALS, FERROS y QUIMLAB: el Nº de cliente/proveedor ES el NIF
  // (serie CLIE sin «Números por defecto»). Sin number, el alta falla.
  const FICHAS_CODIGO_NIF = new Set(["customers", "vendors"]);
  const normalizarNif = (v) => String(v || "").toUpperCase().replace(/[\s.\-]/g, "");
  function completarAltaFicha(recurso, datos) {
    if (!FICHAS_CODIGO_NIF.has(recurso) || !datos || typeof datos !== "object") return datos;
    const out = { ...datos };
    if (out.taxRegistrationNumber != null && String(out.taxRegistrationNumber).trim() !== "") {
      out.taxRegistrationNumber = normalizarNif(out.taxRegistrationNumber);
    }
    if (out.number != null && String(out.number).trim() !== "") out.number = normalizarNif(out.number);
    if (!out.number && out.taxRegistrationNumber) out.number = out.taxRegistrationNumber;
    return out;
  }
  const limpiar = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    const o = {};
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith("@odata") || k === "@odata.etag") o[k] = v;
    return o;
  };
  const recortar = (x) => {
    const s = typeof x === "string" ? x : JSON.stringify(x);
    return s.length > MAX_RESULTADO ? s.slice(0, MAX_RESULTADO) + `… [recortado: ${s.length} caracteres en total — usa $select/filtro/top para acotar]` : s;
  };

  // ---------- herramientas para la IA ----------
  const HERRAMIENTAS = [
    {
      name: "guardar_regla",
      description:
        "Guarda una REGLA para aplicarla siempre a partir de ahora (memoria permanente). Úsala cuando Maria diga cosas como «a partir de ahora siempre…», «recuerda que…», «cuando crees un cliente pon…», «esto hazlo siempre así». Redáctala clara, concreta y en imperativo (qué hacer, cuándo, con qué valores). Si ya existe una regla parecida, en vez de duplicarla usa reemplazar_id.",
      input_schema: {
        type: "object",
        properties: {
          texto: { type: "string", description: "La regla, en una o dos frases, en imperativo" },
          ambito: { type: "string", enum: ["esta_empresa", "todas"], description: "Solo la empresa actual o las 3 empresas. Si no está claro, esta_empresa." },
          reemplazar_id: { type: "string", description: "Opcional: id de una regla existente a sustituir" },
        },
        required: ["texto", "ambito"],
      },
    },
    {
      name: "borrar_regla",
      description: "Borra una regla guardada cuando Maria diga que ya no se aplica o que la olvides.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "listar_empresas",
      description: "Lista las empresas de Business Central a las que tienes acceso (id y nombre).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "listar_recursos",
      description:
        "Lista los recursos consultables de una empresa. origen='api' → entidades de la API v2.0 estándar (customers, vendors, items, salesOrders, salesOrderLines, purchaseOrders, purchaseOrderLines, purchaseInvoices, projects…). origen='odata' → web services publicados por la empresa (p.ej. Pedido_compra_Excel, PurchaseLines, SalesInvLines…), que suelen tener más campos (OT = Shortcut_Dimension_2_Code, departamento = Shortcut_Dimension_1_Code).",
      input_schema: {
        type: "object",
        properties: { empresa: { type: "string" }, origen: { type: "string", enum: ["api", "odata"] } },
        required: ["empresa", "origen"],
      },
    },
    {
      name: "consultar",
      description:
        "Consulta registros de BC (solo lectura). Usa filtro OData ($filter), select, orderby y top para acotar. Ejemplos de filtro: \"number eq 'PC26-003403'\" (api), \"Document_No eq 'PC26-003403'\" (odata), \"Shortcut_Dimension_2_Code eq 'AC015129/2026'\". Para ver un registro concreto por clave usa 'clave'.",
      input_schema: {
        type: "object",
        properties: {
          empresa: { type: "string" },
          origen: { type: "string", enum: ["api", "odata"] },
          recurso: { type: "string", description: "Entidad (api) o web service (odata)" },
          clave: { type: "string", description: "Opcional: (guid) o (Campo='valor',...)" },
          filtro: { type: "string" },
          select: { type: "string", description: "Campos separados por comas" },
          orderby: { type: "string" },
          top: { type: "integer", description: "Máximo de registros (por defecto 20, máx. 200)" },
        },
        required: ["empresa", "origen", "recurso"],
      },
    },
    {
      name: "proponer_cambio",
      description:
        "PROPONE un cambio en BC: 'modificar' campos de un registro existente (necesita clave) o 'crear' un registro nuevo (p.ej. una línea de pedido: recurso purchaseOrderLines con documentId, lineType, lineObjectNumber, quantity, directUnitCost…). NO se aplica: la usuaria verá una tarjeta y decidirá. Antes de proponer, CONSULTA el registro para usar la clave y nombres de campo exactos. Un cambio por llamada; puedes proponer varios. No se puede borrar ni registrar documentos.",
      input_schema: {
        type: "object",
        properties: {
          empresa: { type: "string" },
          origen: { type: "string", enum: ["api", "odata"] },
          recurso: { type: "string" },
          operacion: { type: "string", enum: ["modificar", "crear"] },
          clave: { type: "string", description: "Obligatoria para 'modificar': (guid) o (Campo='valor',...)" },
          datos: { type: "object", description: "Campos y valores a poner" },
          descripcion: { type: "string", description: "Frase corta en castellano: qué se cambia y por qué" },
        },
        required: ["empresa", "origen", "recurso", "operacion", "datos", "descripcion"],
      },
    },
  ];

  // ---------- API v2.0: códigos → GUID (24/09/2026) ----------
  // En la API v2.0 los campos «…Id» (paymentTermsId, paymentMethodId…) son
  // GUIDs, pero la IA (y Maria) conocen los CÓDIGOS («0D», «TRANSF»). Aquí se
  // traducen solos consultando la tabla correspondiente de BC.
  const RE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TABLAS_ID = {
    paymentTermsId: ["paymentTerms", "code", "términos de pago"],
    paymentMethodId: ["paymentMethods", "code", "forma de pago"],
    shipmentMethodId: ["shipmentMethods", "code", "condiciones de envío"],
    currencyId: ["currencies", "code", "divisa"],
    customerId: ["customers", "number", "cliente"],
    vendorId: ["vendors", "number", "proveedor"],
    itemId: ["items", "number", "artículo"],
    itemCategoryId: ["itemCategories", "code", "categoría de artículo"],
    unitOfMeasureId: ["unitsOfMeasure", "code", "unidad de medida"],
    baseUnitOfMeasureId: ["unitsOfMeasure", "code", "unidad de medida"],
    taxAreaId: ["taxAreas", "code", "área de impuesto"],
    locationId: ["locations", "code", "almacén"],
    projectId: ["projects", "number", "proyecto"],
    accountId: ["accounts", "number", "cuenta"],
  };
  // Alias que a veces usa la IA con el código en vez del Id
  const ALIAS_CODIGO = {
    paymentTermsCode: "paymentTermsId", paymentMethodCode: "paymentMethodId", shipmentMethodCode: "shipmentMethodId",
    currencyCode: "currencyId", locationCode: "locationId", itemCategoryCode: "itemCategoryId",
  };
  async function resolverCodigosApi(base, datos) {
    const salida = { ...datos };
    const legible = {};
    for (const [alias, campoId] of Object.entries(ALIAS_CODIGO)) {
      // currencyCode SÍ existe como campo propio en varias entidades: solo se traduce si no hay currencyId
      if (alias in salida && !(campoId in salida) && alias !== "currencyCode") { salida[campoId] = salida[alias]; delete salida[alias]; }
    }
    for (const [campo, valor] of Object.entries(salida)) {
      const tabla = TABLAS_ID[campo];
      if (!tabla || valor === null || valor === "" || RE_GUID.test(String(valor))) continue;
      const [recurso, campoCodigo, nombre] = tabla;
      const cod = String(valor).trim();
      const r = await pedir(`${base}/${recurso}?$filter=${encodeURIComponent(`${campoCodigo} eq '${cod.replace(/'/g, "''")}'`)}&$top=1`);
      const encontrado = r.ok && r.json?.value?.[0];
      if (!encontrado) {
        const lista = await pedir(`${base}/${recurso}?$top=50`);
        const opciones = ((lista.ok && lista.json?.value) || []).map((x) => `${x[campoCodigo]}${x.displayName ? ` (${x.displayName})` : ""}`).join(", ");
        throw new Error(`No existe ${nombre} «${cod}» en BC (${recurso}). Valores disponibles: ${opciones || "—"}`);
      }
      salida[campo] = encontrado.id;
      legible[campo] = `${cod}${encontrado.displayName ? ` · ${encontrado.displayName}` : ""}`;
    }
    return { datos: salida, legible };
  }

  // 24/09/2026: la conversación trabaja SIEMPRE en UNA empresa (la del
  // botón seleccionado). Cualquier otra empresa que pida la IA se rechaza.
  async function ejecutarHerramienta(nombre, entradaOriginal, empresaFija) {
    const entrada = { ...(entradaOriginal || {}) };
    if (empresaFija) {
      if (entrada.empresa) {
        const pedida = await resolverEmpresa(entrada.empresa).catch(() => null);
        if (!pedida || pedida.id !== empresaFija.id) {
          throw new Error(`En esta conversación solo puedes trabajar en ${empresaFija.nombre}. Para otra empresa, Maria tiene que cambiar de empresa con los botones de la pantalla.`);
        }
      }
      entrada.empresa = empresaFija.id;
    }
    switch (nombre) {
      case "guardar_regla": {
        const texto = String(entradaOriginal?.texto || "").trim();
        if (!texto) throw new Error("La regla está vacía.");
        const ambito = entradaOriginal?.ambito === "todas" ? "todas" : empresaFija?.nombre || "todas";
        const lista = await leerReglas();
        const idx = entradaOriginal?.reemplazar_id ? lista.findIndex((r) => r.id === entradaOriginal.reemplazar_id) : -1;
        const regla = { id: idx >= 0 ? lista[idx].id : `r${Date.now()}`, texto, ambito, ts: new Date().toISOString() };
        if (idx >= 0) lista[idx] = regla; else lista.push(regla);
        await escribirReglas(lista);
        console.log(`[ia-bc] REGLA ${idx >= 0 ? "actualizada" : "nueva"} (${ambito}): ${texto}`);
        return { guardada: true, regla };
      }
      case "borrar_regla": {
        const lista = await leerReglas();
        const nueva = lista.filter((r) => r.id !== entradaOriginal?.id);
        if (nueva.length === lista.length) throw new Error("No existe ninguna regla con ese id.");
        await escribirReglas(nueva);
        return { borrada: true };
      }
      case "listar_empresas":
        return empresaFija ? [{ id: empresaFija.id, nombre: empresaFija.nombre }] : (await empresas()).map((c) => ({ id: c.id, nombre: c.nombre }));

      case "listar_recursos": {
        const { base } = await urlBase(entrada.origen, entrada.empresa);
        const r = await pedir(base);
        if (!r.ok) throw new Error(`BC ${r.status}: ${r.texto.slice(0, 300)}`);
        return ((r.json && r.json.value) || []).map((x) => x.name || x.url).filter(Boolean);
      }

      case "consultar": {
        validarRecurso(entrada.recurso);
        const { base } = await urlBase(entrada.origen, entrada.empresa);
        let url = `${base}/${encodeURIComponent(entrada.recurso)}`;
        if (entrada.clave) {
          url += validarClave(entrada.clave);
          const r = await pedir(url);
          if (!r.ok) throw new Error(`BC ${r.status}: ${r.texto.slice(0, 400)}`);
          return limpiar(r.json);
        }
        const q = [];
        if (entrada.filtro) q.push(`$filter=${encodeURIComponent(entrada.filtro)}`);
        if (entrada.select) q.push(`$select=${encodeURIComponent(entrada.select)}`);
        if (entrada.orderby) q.push(`$orderby=${encodeURIComponent(entrada.orderby)}`);
        q.push(`$top=${Math.min(Math.max(Number(entrada.top) || 20, 1), 200)}`);
        const r = await pedir(`${url}?${q.join("&")}`);
        if (!r.ok) throw new Error(`BC ${r.status}: ${r.texto.slice(0, 400)}`);
        const filas = ((r.json && r.json.value) || []).map(limpiar);
        return { registros: filas.length, valor: filas };
      }

      case "proponer_cambio": {
        validarRecurso(entrada.recurso);
        if (!["modificar", "crear"].includes(entrada.operacion)) throw new Error("Operación no permitida (solo modificar o crear).");
        if (!entrada.datos || typeof entrada.datos !== "object" || !Object.keys(entrada.datos).length) throw new Error("Faltan 'datos'.");
        const { e, base } = await urlBase(entrada.origen, entrada.empresa);
        let datos = entrada.datos, legible = {};
        if (entrada.origen === "api") {
          ({ datos, legible } = await resolverCodigosApi(base, entrada.datos));
          // CREAR: comprobar que los campos existen en esta entidad (con un registro de muestra)
          if (entrada.operacion === "crear") {
            datos = completarAltaFicha(entrada.recurso, datos);
            const muestra = await pedir(`${base}/${encodeURIComponent(entrada.recurso)}?$top=1`);
            const ej = muestra.ok && muestra.json?.value?.[0];
            if (ej) {
              const faltan = Object.keys(datos).filter((k) => !(k in ej));
              if (faltan.length) {
                throw new Error(
                  `Estos campos NO existen en '${entrada.recurso}' de la API v2.0: ${faltan.join(", ")}. Campos válidos: ${Object.keys(limpiar(ej)).filter((k) => !k.startsWith("@")).join(", ").slice(0, 1500)}. ` +
                    `Quítalos del alta. Si son grupos contables u otros datos de ficha, crea primero el registro y después propón modificarlos en un web service OData de ficha (búscalo con listar_recursos origen odata, p.ej. ficha de cliente/proveedor); si no hay ninguno publicado, díselo a Maria.`
                );
              }
            }
            if (FICHAS_CODIGO_NIF.has(entrada.recurso) && datos.number) {
              const ya = await pedir(`${base}/${encodeURIComponent(entrada.recurso)}?$filter=${encodeURIComponent(`number eq '${String(datos.number).replace(/'/g, "''")}'`)}&$select=number,displayName&$top=1`);
              const existe = ya.ok && ya.json?.value?.[0];
              if (existe) {
                const tipo = entrada.recurso === "customers" ? "cliente" : "proveedor";
                throw new Error(`Ya existe el ${tipo} ${existe.number}${existe.displayName ? ` (${existe.displayName})` : ""}. No hace falta crearlo.`);
              }
            }
          }
        }
        const cambio = {
          id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          ts: new Date().toISOString(),
          empresa: e.nombre,
          empresaId: e.id,
          origen: entrada.origen,
          recurso: entrada.recurso,
          operacion: entrada.operacion,
          clave: entrada.operacion === "modificar" ? validarClave(entrada.clave) : null,
          datos,
          legible,
          descripcion: entrada.descripcion || "",
          antes: null,
          estado: "pendiente",
        };
        if (cambio.operacion === "modificar") {
          const r = await pedir(`${base}/${encodeURIComponent(cambio.recurso)}${cambio.clave}`);
          if (!r.ok) throw new Error(`No encuentro el registro a modificar (BC ${r.status}): ${r.texto.slice(0, 300)}`);
          const actual = r.json || {};
          const faltan = Object.keys(cambio.datos).filter((k) => !(k in actual));
          if (faltan.length) throw new Error(`Estos campos no existen en el registro: ${faltan.join(", ")}. Campos disponibles: ${Object.keys(limpiar(actual)).filter((k) => k !== "@odata.etag").join(", ").slice(0, 1500)}`);
          cambio.antes = Object.fromEntries(Object.keys(cambio.datos).map((k) => [k, actual[k]]));
          // datos de contexto para que la tarjeta se entienda (nº documento, descripción…)
          cambio.contexto = Object.fromEntries(
            ["number", "No", "Document_No", "documentNumber", "Line_No", "sequence", "description", "Description", "displayName", "Name"].filter((k) => actual[k] != null && actual[k] !== "").map((k) => [k, actual[k]])
          );
        }
        pendientes.set(cambio.id, cambio);
        return { pendiente: true, id: cambio.id, mensaje: "Cambio preparado. La usuaria lo verá en una tarjeta y decidirá si lo aplica. No digas que está hecho." };
      }
      default:
        throw new Error(`Herramienta desconocida: ${nombre}`);
    }
  }

  const SISTEMA = async (empresaFija) => {
    const reglas = await reglasPara(empresaFija?.nombre);
    const bloqueReglas = reglas.length
      ? `REGLAS DE MARIA — OBLIGATORIAS (te las ha ido enseñando; aplícalas SIEMPRE, sin que te las repita, y por encima de tus criterios por defecto):
${reglas.map((r) => `- [${r.id}] (${r.ambito === "todas" ? "todas las empresas" : r.ambito}) ${r.texto}`).join("\n")}
Si una regla choca con lo que Maria pide ahora, haz lo que pide ahora y pregúntale si quiere actualizar la regla.

`
      : "";
    return `Eres el asistente IA del «Agente de Ventas» de ALSO CASALS INSTAL·LACIONS (Grup AC). Trabajas sobre Microsoft Dynamics 365 Business Central (BC Online). Hoy es ${new Date().toLocaleDateString("es-ES")}.
Respondes en castellano, claro y breve. Hablas con Maria (compras, administración de ventas y operaciones).

Qué puedes hacer:
- Consultar cualquier dato de BC con las herramientas.${empresaFija ? `
- EMPRESA DE ESTA CONVERSACIÓN: ${empresaFija.nombre}. SOLO puedes consultar y modificar esta empresa. Si te piden algo de otra empresa (ALSO CASALS, FERROSCA o QUIMLAB), di que cambie de empresa con los botones de abajo de la pantalla.` : " Si no te dicen empresa, usa ALSO CASALS."}
- Proponer cambios (modificar campos o crear registros/líneas) con proponer_cambio. NUNCA se aplican solos: Maria verá una tarjeta y pulsará «Aplicar». Por eso, tras proponer, di "te he preparado el cambio, revísalo y pulsa Aplicar" — nunca digas que ya está hecho.
- NO puedes borrar registros, ni registrar/postear documentos, ni lanzar acciones de BC. Si te lo piden, explica que eso se hace en BC directamente.

${bloqueReglas}Aprender: cuando Maria te enseñe una forma de hacer algo que se repite («a partir de ahora…», «siempre…», «recuerda…», o te corrija algo que seguramente querrá igual la próxima vez), guárdalo con guardar_regla y díselo en una frase («📌 Apuntado: …»). Si solo es para este caso, no lo guardes.

Cómo trabajar:
- Antes de proponer un cambio, consulta el registro para tener la clave exacta y los nombres de campo reales. En la API v2.0 la clave es (id-guid). En los web services OData la clave suele ser compuesta, p.ej. Pedido_compra_Excel(Document_Type='Order',No='PC26-003403') o PurchaseLines(Document_Type='Order',Document_No='PC26-003403',Line_No=20000).
- Convenciones de ALSO CASALS: pedidos de compra PCaa-nnnnnn, ofertas de compra OCaa-nnnnnn, pedidos de venta PVaa-nnnnnn; OT = Shortcut_Dimension_2_Code (formato AC015129/2026); departamento/unidad de negocio = Shortcut_Dimension_1_Code (MAN, INS, CON, AMT, AUT…). Nº albarán del proveedor en la cabecera de compra = Vendor_Shipment_No.
- IMÁGENES: Maria puede pegar capturas (fichas de cliente o proveedor de otro programa, albaranes, pedidos…). Léelas con cuidado, campo a campo. Si algún dato no se lee bien o es ambiguo, pregúntalo antes de proponer el cambio. No inventes datos que no salgan en la imagen.
- CREAR UN CLIENTE: 1) comprueba que no exista ya. El campo taxRegistrationNumber NO se puede filtrar: busca por number (el código) y por displayName parecido. 2) Consulta un cliente parecido existente para ver cómo se rellenan los campos en esta empresa. 3) Propón crear en recurso 'customers' (origen api) con: number, displayName, addressLine1 (y addressLine2 si hace falta), city, state (provincia), postalCode, country ('ES'), phoneNumber, email, taxRegistrationNumber. En ALSO CASALS, FERROS y QUIMLAB el código del cliente ES el NIF/CIF/NIE: number y taxRegistrationNumber iguales, en mayúsculas y SIN guiones ni espacios (Y9583277-L se envía como Y9583277L). La serie de BC no numera sola; si omites number, el alta falla. El «Código» de una captura de otro programa no lo uses si no es el NIF. Términos y forma de pago: en la API van como paymentTermsId / paymentMethodId — puedes poner el CÓDIGO (p.ej. «0D», «TRANSF») y el sistema lo traduce solo. La API v2.0 de customers/vendors NO tiene grupos contables (genBusPostingGroup, vatBusPostingGroup, customerPostingGroup…): no los pongas en el alta; después del alta busca un web service OData de ficha de cliente/proveedor (listar_recursos origen odata) y propón ahí un segundo cambio con los grupos. Datos como persona de contacto, forma de pago o tarifa: menciónalos y, tras crear el cliente, ofrece ponerlos con un segundo cambio si hay un campo en BC para ello (consúltalo). Un proveedor igual con 'vendors' (el código también es el NIF).
- Si una consulta devuelve demasiado, acota con filtro/select/top. Si algo falla, explica el error de BC en palabras sencillas y propone alternativa.
- Resume los resultados en tablas o listas cortas; no vuelques JSON en bruto.`;
  };
  app.post("/api/ia-bc/chat", async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en backend/.env." });
    const historial = Array.isArray(req.body?.historial) ? req.body.historial : [];
    const mensaje = String(req.body?.mensaje || "").trim();
    // Imágenes pegadas en el chat (capturas, fichas de cliente…) — 24/09/2026
    const imagenes = (Array.isArray(req.body?.imagenes) ? req.body.imagenes : [])
      .filter((im) => im && typeof im.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(im.media_type || ""))
      .slice(0, 10);
    if (!mensaje && !imagenes.length) return res.status(400).json({ error: "Falta el mensaje." });
    let empresaFija = null;
    try {
      if (!req.body?.empresa) return res.status(400).json({ error: "Falta elegir la empresa (botones de abajo)." });
      empresaFija = await resolverEmpresa(req.body.empresa);
    } catch (e) {
      return res.status(400).json({ error: String(e.message || e) });
    }
    // Turnos anteriores: sin imágenes (pesan mucho; la IA ya las leyó) y con
    // los resultados de consultas recortados (la IA puede volver a consultar).
    const sinImagenes = (m) =>
      Array.isArray(m.content)
        ? { ...m, content: m.content.map((b) => (b.type === "image" ? { type: "text", text: "[imagen enviada por Maria en este mensaje]" } : b)) }
        : m;
    const previo = historial.map((m) =>
      Array.isArray(m.content)
        ? sinImagenes({ ...m, content: m.content.map((b) => (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 1500 ? { ...b, content: b.content.slice(0, 1500) + "… [recortado]" } : b)) })
        : m
    );
    // Contexto de la pantalla desde la que se pregunta (botón flotante 🤖) — 24/09/2026
    const ctx = req.body?.contexto;
    const textoCtx = ctx && ctx.pantalla
      ? `[Contexto automático: Maria te escribe desde la pantalla «${String(ctx.pantalla).slice(0, 80)}» del Agente de Ventas. Esto es lo que tiene en pantalla ahora mismo (texto, puede estar recortado):\n"""\n${String(ctx.texto || "").slice(0, 9000)}\n"""\nÚsalo para entender a qué se refiere ("este pedido", "esta OT", "estos datos"…). Si necesitas más datos, consulta BC.]\n\n`
      : "";
    const contenidoUsuario = imagenes.length
      ? [
          ...imagenes.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
          { type: "text", text: textoCtx + (mensaje || "Mira estas imágenes.") },
        ]
      : textoCtx + mensaje;
    const msgs = [...previo, { role: "user", content: contenidoUsuario }];
    const propuestos = [];
    const pasos = [];
    try {
      for (let vuelta = 0; vuelta < 10; vuelta++) {
        let r = null;
        for (let intento = 0; intento < 3; intento++) {
          r = await fetchConReintento("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5", max_tokens: 4000, system: await SISTEMA(empresaFija), tools: HERRAMIENTAS, messages: msgs }),
          });
          if (![429, 500, 502, 503, 529].includes(r.status)) break;
          await new Promise((ok) => setTimeout(ok, 3000 * (intento + 1)));
        }
        if (!r.ok) throw new Error(`API Claude respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const data = await r.json();
        msgs.push({ role: "assistant", content: data.content });
        const usos = (data.content || []).filter((b) => b.type === "tool_use");
        if (data.stop_reason !== "tool_use" || !usos.length) break;
        const resultados = [];
        for (const u of usos) {
          let contenido, esError = false;
          try {
            const salida = await ejecutarHerramienta(u.name, u.input || {}, empresaFija);
            if (u.name === "proponer_cambio" && salida?.id) propuestos.push(pendientes.get(salida.id));
            contenido = recortar(salida);
            pasos.push({ herramienta: u.name, entrada: u.input, ok: true });
          } catch (e) {
            esError = true;
            contenido = `ERROR: ${String(e.message || e)}`;
            pasos.push({ herramienta: u.name, entrada: u.input, ok: false, error: String(e.message || e) });
          }
          resultados.push({ type: "tool_result", tool_use_id: u.id, content: contenido, is_error: esError });
        }
        msgs.push({ role: "user", content: resultados });
      }
      const ultimo = msgs[msgs.length - 1];
      const texto = ultimo.role === "assistant" ? (ultimo.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() : "";
      res.json({ texto, cambios: propuestos, pasos, historial: msgs.map(sinImagenes) });
    } catch (err) {
      console.error("Error /api/ia-bc/chat:", err);
      res.status(500).json({ error: "Error hablando con la IA.", detalle: String(err.message || err) });
    }
  });

  // Aplicar / descartar un cambio propuesto (SOLO desde el botón de la usuaria)
  app.post("/api/ia-bc/aplicar", async (req, res) => {
    const cambio = pendientes.get(String(req.body?.id || ""));
    if (!cambio) return res.status(404).json({ error: "Ese cambio ya no está pendiente (¿se reinició el backend?). Pídeselo otra vez a la IA." });
    if (cambio.estado !== "pendiente") return res.status(409).json({ error: `Ese cambio ya está ${cambio.estado}.` });
    if (req.body?.empresa) {
      const sel = await resolverEmpresa(req.body.empresa).catch(() => null);
      if (!sel || sel.id !== cambio.empresaId) return res.status(403).json({ error: `Este cambio es de ${cambio.empresa} y ahora tienes seleccionada otra empresa. Vuelve a ${cambio.empresa} para aplicarlo.` });
    }
    try {
      const base = cambio.origen === "odata"
        ? `${RAIZ()}/ODataV4/Company('${encodeURIComponent(cambio.empresa)}')`
        : `${RAIZ()}/api/v2.0/companies(${cambio.empresaId})`;
      let r;
      if (cambio.operacion === "modificar") {
        const url = `${base}/${encodeURIComponent(cambio.recurso)}${cambio.clave}`;
        const actual = await pedir(url);
        if (!actual.ok) throw new Error(`No se pudo leer el registro (BC ${actual.status}): ${actual.texto.slice(0, 300)}`);
        r = await pedir(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "If-Match": (actual.json && actual.json["@odata.etag"]) || "*" },
          body: JSON.stringify(cambio.datos),
        });
      } else {
        if (cambio.origen === "api") cambio.datos = completarAltaFicha(cambio.recurso, cambio.datos);
        r = await pedir(`${base}/${encodeURIComponent(cambio.recurso)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cambio.datos),
        });
      }
      cambio.estado = r.ok ? "aplicado" : "error";
      cambio.resultado = r.ok ? limpiar(r.json) : { status: r.status, error: r.texto.slice(0, 600) };
      cambio.aplicadoTs = new Date().toISOString();
      await anotar(cambio);
      if (!r.ok) return res.status(502).json({ error: textoErrorBC(r.texto), detalle: r.texto.slice(0, 600), cambio });
      res.json({ ok: true, cambio });
    } catch (err) {
      cambio.estado = "error";
      cambio.resultado = { error: String(err.message || err) };
      await anotar(cambio);
      res.status(500).json({ error: "No se pudo aplicar el cambio.", detalle: String(err.message || err), cambio });
    }
  });

  app.post("/api/ia-bc/descartar", (req, res) => {
    const cambio = pendientes.get(String(req.body?.id || ""));
    if (cambio && cambio.estado === "pendiente") { cambio.estado = "descartado"; }
    res.json({ ok: true });
  });

  // ---------- VER EL RESULTADO de un cambio aplicado (24/09/2026) ----------
  // Página de BC (cliente web) donde se abre cada tipo de registro, y el
  // campo que la identifica. Las líneas abren su DOCUMENTO.
  const PAGINAS_BC = {
    customers: { pagina: 21, campo: "number", tipo: "cliente" },
    vendors: { pagina: 26, campo: "number", tipo: "proveedor" },
    items: { pagina: 30, campo: "number", tipo: "artículo" },
    projects: { pagina: 88, campo: "number", tipo: "proyecto/OT" },
    purchaseOrders: { pagina: 50, campo: "number", tipo: "pedido de compra" },
    purchaseInvoices: { pagina: 51, campo: "number", tipo: "factura de compra" },
    salesQuotes: { pagina: 41, campo: "number", tipo: "oferta de venta" },
    salesOrders: { pagina: 42, campo: "number", tipo: "pedido de venta" },
    salesInvoices: { pagina: 43, campo: "number", tipo: "factura de venta" },
    salesCreditMemos: { pagina: 44, campo: "number", tipo: "abono de venta" },
    contacts: { pagina: 5050, campo: "number", tipo: "contacto" },
  };
  const LINEAS_PADRE = {
    purchaseOrderLines: "purchaseOrders",
    purchaseInvoiceLines: "purchaseInvoices",
    salesOrderLines: "salesOrders",
    salesInvoiceLines: "salesInvoices",
    salesQuoteLines: "salesQuotes",
    salesCreditMemoLines: "salesCreditMemos",
  };
  const urlClienteWeb = (empresa, pagina, valor) =>
    `https://businesscentral.dynamics.com/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/?company=${encodeURIComponent(empresa)}&page=${pagina}&filter=${encodeURIComponent(`'No.' IS '${String(valor).replace(/'/g, "''")}'`)}`;

  async function buscarCambio(id) {
    if (pendientes.has(id)) return pendientes.get(id);
    try {
      const lista = await db.getDoc("cambios_bc", []);
      return (Array.isArray(lista) ? lista : []).slice().reverse().find((c) => c.id === id) || null;
    } catch { return null; }
  }

  app.post("/api/ia-bc/ver", async (req, res) => {
    const cambio = await buscarCambio(String(req.body?.id || ""));
    if (!cambio) return res.status(404).json({ error: "No encuentro ese cambio." });
    if (cambio.estado !== "aplicado") return res.status(409).json({ error: "Ese cambio no se ha aplicado." });
    try {
      const base = cambio.origen === "odata"
        ? `${RAIZ()}/ODataV4/Company('${encodeURIComponent(cambio.empresa)}')`
        : `${RAIZ()}/api/v2.0/companies(${cambio.empresaId})`;
      let clave = cambio.clave;
      if (!clave && cambio.origen === "api" && cambio.resultado?.id) clave = `(${cambio.resultado.id})`;
      let registro = cambio.resultado || null;
      if (clave) {
        const r = await pedir(`${base}/${encodeURIComponent(cambio.recurso)}${clave}`);
        if (r.ok) registro = limpiar(r.json);
      }
      let enlace = null, etiqueta = null;
      const rec = cambio.recurso;
      if (cambio.origen === "api" && PAGINAS_BC[rec] && registro?.[PAGINAS_BC[rec].campo]) {
        enlace = urlClienteWeb(cambio.empresa, PAGINAS_BC[rec].pagina, registro[PAGINAS_BC[rec].campo]);
        etiqueta = `Abrir ${PAGINAS_BC[rec].tipo} ${registro[PAGINAS_BC[rec].campo]} en BC`;
      } else if (cambio.origen === "api" && LINEAS_PADRE[rec] && registro?.documentId) {
        const padre = LINEAS_PADRE[rec];
        const rp = await pedir(`${base}/${padre}(${registro.documentId})?$select=number`);
        if (rp.ok && rp.json?.number) {
          enlace = urlClienteWeb(cambio.empresa, PAGINAS_BC[padre].pagina, rp.json.number);
          etiqueta = `Abrir ${PAGINAS_BC[padre].tipo} ${rp.json.number} en BC`;
        }
      } else if (cambio.origen === "odata") {
        const tipoDoc = String(registro?.Document_Type || "");
        const num = /pedido_compra|purchase.?header/i.test(rec) ? registro?.No : /purch|compra/i.test(rec) ? registro?.Document_No : null;
        if (num && (!tipoDoc || /order/i.test(tipoDoc))) {
          enlace = urlClienteWeb(cambio.empresa, 50, num);
          etiqueta = `Abrir pedido de compra ${num} en BC`;
        } else if (/sales|venta/i.test(rec) && registro?.Document_No && /order/i.test(tipoDoc)) {
          enlace = urlClienteWeb(cambio.empresa, 42, registro.Document_No);
          etiqueta = `Abrir pedido de venta ${registro.Document_No} en BC`;
        }
      }
      res.json({ registro, enlace, etiqueta });
    } catch (err) {
      res.status(500).json({ error: "No se pudo leer el registro.", detalle: String(err.message || err) });
    }
  });

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
      const id = validarIdChat(b.id || `chat${Date.now()}${Math.random().toString(36).slice(2, 6)}`);
      const mapa = await db.getDoc("chats_ia", {});
      const previo = mapa[id] || {};
      const primero = (b.mensajes || []).find((m) => m.rol === "yo");
      const chat = {
        id,
        empresa: b.empresa || previo.empresa || "",
        empresaNombre: b.empresaNombre || previo.empresaNombre || "",
        titulo: b.titulo || previo.titulo || (primero ? String(primero.texto || "").replace(/\s+/g, " ").slice(0, 80) : "Conversación nueva"),
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

  app.get("/api/ia-bc/reglas", async (req, res) => res.json({ reglas: await leerReglas() }));
  app.post("/api/ia-bc/reglas", async (req, res) => {
    const texto = String(req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "La regla está vacía." });
    const lista = await leerReglas();
    const id = req.body?.id;
    const idx = id ? lista.findIndex((r) => r.id === id) : -1;
    const regla = { id: idx >= 0 ? id : `r${Date.now()}`, texto, ambito: String(req.body?.ambito || "todas"), ts: new Date().toISOString() };
    if (idx >= 0) lista[idx] = regla; else lista.push(regla);
    await escribirReglas(lista);
    res.json({ ok: true, regla });
  });
  app.post("/api/ia-bc/reglas/borrar", async (req, res) => {
    await escribirReglas((await leerReglas()).filter((r) => r.id !== req.body?.id));
    res.json({ ok: true });
  });

  app.get("/api/ia-bc/empresas", async (req, res) => {
    try { res.json({ empresas: (await empresas()).map((c) => ({ id: c.id, nombre: c.nombre, displayName: c.displayName })) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get("/api/ia-bc/historial-cambios", async (req, res) => {
    try {
      const lista = await db.getDoc("cambios_bc", []);
      res.json({ cambios: (Array.isArray(lista) ? lista : []).slice(-100).reverse() });
    } catch { res.json({ cambios: [] }); }
  });

  // Copia el pedido de venta con las columnas visibles de la rejilla de Maria
  // (oct 2026) y el precio de venta que propone el asistente. Business Central
  // exige el mismo número de columnas, en el mismo orden, para pegar la fila.
  app.post("/api/ia-bc/copiar-pedido", async (req, res) => {
    try {
      const cuerpo = req.body || {};
      const propuesta = (Array.isArray(cuerpo.articulos) ? cuerpo.articulos : [])
        .map((a) => ({
          no: String(a?.no || "").trim().toUpperCase(),
          descripcion: String(a?.descripcion || "").replace(/[\t\r\n]+/g, " ").trim(),
          precio: Number(a?.precio),
          cantidad: a?.cantidad == null || a.cantidad === "" ? null : Number(a.cantidad),
        }))
        .filter((a) => /^[A-Z0-9._-]{3,40}$/.test(a.no) && Number.isFinite(a.precio));
      if (!propuesta.length) return res.status(400).json({ error: "No hay artículos con precio para copiar." });
      const precios = new Map(propuesta.map((a) => [a.no, a]));
      const ot = String(cuerpo.ot || "").trim();
      const documento = String(cuerpo.documento || "").trim();
      if (ot && !/^[A-Za-z0-9./-]{4,30}$/.test(ot)) return res.status(400).json({ error: "La OT no tiene un formato válido." });
      if (documento && !/^[A-Za-z0-9-]{4,30}$/.test(documento)) return res.status(400).json({ error: "El número de pedido no es válido." });

      const { e, base } = await urlBase("odata", cuerpo.empresa || cuerpo.empresaNombre);
      const servicio = process.env.BC_WS_LINEASVENTA || "SalesInvLines";
      validarRecurso(servicio);
      const esc = (s) => String(s).replace(/'/g, "''");
      const traer = async (filtro) => {
        const filas = [];
        let url = `${base}/${encodeURIComponent(servicio)}?$filter=${encodeURIComponent(filtro)}&$top=500`;
        for (let i = 0; i < 12 && url; i++) {
          const r = await pedir(url);
          if (!r.ok) throw new Error(textoErrorBC(r.texto) || `BC respondió ${r.status}`);
          filas.push(...(r.json?.value || []));
          url = r.json?.["@odata.nextLink"] || null;
        }
        return filas;
      };
      const leer = (fila, nombres) => {
        const claves = Object.keys(fila || {});
        for (const nombre of nombres) {
          if (Object.prototype.hasOwnProperty.call(fila, nombre)) return fila[nombre];
          const hit = claves.find((k) => k.toLowerCase() === nombre.toLowerCase());
          if (hit) return fila[hit];
        }
        return undefined;
      };
      const num = (fila, nombres) => {
        const v = leer(fila, nombres);
        if (v == null || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const normNo = (fila) => String(leer(fila, ["No", "No."]) || "").trim().toUpperCase();
      const elegir = (filas) => {
        const map = new Map();
        for (const f of filas) {
          const doc = String(leer(f, ["Document_No"]) || "").trim();
          if (!doc) continue;
          if (!map.has(doc)) map.set(doc, { doc, tipo: String(leer(f, ["Document_Type"]) || ""), n: 0 });
          if (precios.has(normNo(f))) map.get(doc).n += 1;
        }
        const lista = [...map.values()].filter((x) => x.n > 0);
        lista.sort((a, b) => {
          const ap = /order|pedido/i.test(a.tipo) ? 1 : 0;
          const bp = /order|pedido/i.test(b.tipo) ? 1 : 0;
          if (ap !== bp) return bp - ap;
          if (a.n !== b.n) return b.n - a.n;
          return b.doc.localeCompare(a.doc);
        });
        return lista[0] || null;
      };

      let elegido = null;
      if (documento) {
        const filasDoc = await traer(`Document_No eq '${esc(documento)}'`);
        elegido = elegir(filasDoc) || (filasDoc[0] ? { doc: documento, tipo: String(leer(filasDoc[0], ["Document_Type"]) || ""), n: 0 } : null);
      }
      if (!elegido && ot) elegido = elegir(await traer(`Shortcut_Dimension_2_Code eq '${esc(ot)}'`));
      if (!elegido) {
        const filtroNos = propuesta.map((a) => `No eq '${esc(a.no)}'`).join(" or ");
        elegido = elegir(await traer(filtroNos));
      }

      const dinero = (n) => {
        const x = Number(n);
        if (!Number.isFinite(x)) return "";
        const [ent, decRaw] = x.toFixed(5).split(".");
        let dec = decRaw.replace(/0+$/, "");
        if (dec.length < 2) dec = dec.padEnd(2, "0");
        return `${ent},${dec}`;
      };
      const cantTxt = (n) => {
        if (n == null || n === "") return "";
        const x = Number(n);
        if (!Number.isFinite(x)) return "";
        return x.toFixed(5).replace(/\.?0+$/, "").replace(".", ",");
      };
      const txt = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
      const tipoVisible = (v) => {
        const t = String(v ?? "").trim().toLowerCase();
        if (!t || t === "comment" || t === "comentario") return "Comentario";
        if (t === "item" || t === "artículo" || t === "articulo") return "Artículo";
        if (t === "resource" || t === "recurso") return "Recurso";
        if (t === "g/l account" || t === "account" || t === "cuenta") return "Cuenta";
        if (t.includes("charge") || t.includes("cargo")) return "Cargo (producto)";
        if (t.includes("fixed") || t.includes("activo")) return "Activo fijo";
        return String(v ?? "").trim();
      };
      const htmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const esArticulo = (f) => {
        const t = String(leer(f, ["Type"]) ?? "").trim().toLowerCase();
        if (/resource|recurso|comment|comentario|g\/l|cuenta|charge|cargo|fixed|activo/.test(t)) return false;
        if (t === "item" || t === "artículo" || t === "articulo") return true;
        return /^PR\d/i.test(normNo(f));
      };

      let lineas = [];
      let actualizados = 0;
      const noEncontrados = [];
      if (elegido) {
        lineas = await traer(`Document_No eq '${esc(elegido.doc)}'`);
        lineas.sort((a, b) => (num(a, ["Line_No"]) || 0) - (num(b, ["Line_No"]) || 0));
        lineas = lineas.filter((f) => esArticulo(f) && precios.has(normNo(f)));
        if (lineas.length > 400) lineas = lineas.slice(0, 400);
        const presentes = new Set(lineas.map(normNo));
        for (const a of propuesta) if (!presentes.has(a.no)) noEncontrados.push(a.no);
      }

      const filaPegado = (f, forzar) => {
        const no = normNo(f);
        const prop = precios.get(no);
        const precioBc = num(f, ["Unit_Price"]);
        const cambia = !!(prop && (precioBc == null || Math.abs(prop.precio - precioBc) > 0.0000001));
        const precio = prop ? prop.precio : precioBc;
        if (cambia) actualizados += 1;
        const d1 = num(f, ["Percent_Dto_linea_1", "Line_Discount_Percent", "Line_Discount_x0025_"]) || 0;
        const d2 = num(f, ["Percent_Dto_linea_2"]) || 0;
        const d3 = num(f, ["Percent_Dto_linea_3"]) || 0;
        const cantidad = num(f, ["Quantity"]);
        const importeBc = num(f, ["Line_Amount"]);
        const importe = cambia && cantidad != null
          ? cantidad * prop.precio * (1 - d1 / 100) * (1 - d2 / 100) * (1 - d3 / 100)
          : importeBc;
        const claveEmp = Object.keys(f).find((k) => /emplead/i.test(k));
        const claveCargo = Object.keys(f).find((k) => /item_charge_qty_to_handle|qty_to_handle/i.test(k));
        const celdas = [
          tipoVisible(leer(f, ["Type"])),
          no,
          txt(leer(f, ["VAT_Prod_Posting_Group"])),
          txt(leer(f, ["Item_Reference_No", "Cross_Reference_No"])),
          txt(forzar?.descripcion || leer(f, ["Description"])),
          txt(leer(f, ["Location_Code"])),
          txt(leer(f, ["Shortcut_Dimension_2_Code"])),
          cantTxt(cantidad),
          cantTxt(num(f, ["Quantity_Shipped"])),
          cantTxt(num(f, ["Qty_to_Ship"])),
          dinero(precio ?? 0),
          dinero(d1),
          dinero(d2),
          dinero(d3),
          dinero(importe ?? 0),
          cantTxt(num(f, ["Qty_to_Invoice"])),
          cantTxt(num(f, ["Quantity_Invoiced"])),
          txt(leer(f, ["Unit_of_Measure_Code"])),
          cantTxt(num(f, ["Qty_to_Assign"]) ?? 0),
          cantTxt(claveCargo ? num(f, [claveCargo]) ?? 0 : 0),
          cantTxt(num(f, ["Qty_Assigned"]) ?? 0),
          txt(leer(f, ["Shortcut_Dimension_1_Code"])),
          txt(claveEmp ? leer(f, [claveEmp]) : ""),
        ];
        return celdas;
      };

      let filas;
      if (lineas.length) {
        filas = lineas.map((f) => filaPegado(f));
      } else {
        filas = propuesta.map((a) => filaPegado({
          Type: "Item",
          No: a.no,
          Description: a.descripcion,
          Quantity: a.cantidad || 1,
          Qty_to_Ship: a.cantidad || 1,
          Qty_to_Invoice: a.cantidad || 1,
          Unit_Price: a.precio,
        }, a));
        actualizados = propuesta.length;
      }

      const tsv = filas.map((f) => f.join("\t")).join("\r\n");
      const html = `<table><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${htmlEsc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      const que = elegido && /quote|oferta/i.test(elegido.tipo) ? "oferta" : "pedido";
      let mensaje;
      if (elegido && lineas.length) {
        mensaje = `Copiado el ${que} ${elegido.doc}: ${filas.length} líneas de artículo y ${actualizados} precios actualizados. En BC, selecciona solo esas líneas de artículo y pulsa Ctrl+V.`;
        if (noEncontrados.length) mensaje += ` No están en el documento: ${noEncontrados.slice(0, 8).join(", ")}.`;
      } else {
        mensaje = `No he encontrado un pedido abierto con estos artículos. He copiado ${filas.length} líneas nuevas: en BC, haz clic en una línea vacía y pulsa Ctrl+V.`;
      }
      res.json({ tsv, html, pedido: elegido?.doc || "", lineas: filas.length, actualizados, mensaje, empresa: e.nombre });
    } catch (e) {
      console.error("[ia-bc] copiar-pedido:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  async function anotar(cambio) {
    try {
      let lista = await db.getDoc("cambios_bc", []);
      if (!Array.isArray(lista)) lista = [];
      lista.push({ ...cambio });
      await db.setDoc("cambios_bc", lista);
    } catch (e) {
      console.warn("[ia-bc] No se pudo anotar el cambio:", e.message);
    }
    console.log(`[ia-bc] ${cambio.estado.toUpperCase()} · ${cambio.empresa} · ${cambio.operacion} ${cambio.recurso}${cambio.clave || ""} · ${JSON.stringify(cambio.datos).slice(0, 200)}`);
  }
};
