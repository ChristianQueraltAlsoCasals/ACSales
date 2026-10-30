/**
 * Acciones de la app que la IA puede pedir (tareas, calendario, navegación).
 * El servidor las propone; el navegador las ejecuta (localStorage / UI).
 */
import { cargarTareas, guardarTareas } from "./tareas.jsx";

export const LS_EVENTOS = "agente_ventas_calendario_v1";
export const EVT_TAREAS = "acsales-tareas-cambio";
export const EVT_EVENTOS = "acsales-eventos-cambio";

export const SECCIONES_APP = [
  { id: "cargar", nombre: "Cargar datos" },
  { id: "memoria", nombre: "Memoria histórica" },
  { id: "explorador", nombre: "Explorador de OTs" },
  { id: "recepcion", nombre: "Recepción de material" },
  { id: "facturascompra", nombre: "Validación de facturas" },
  { id: "precios", nombre: "Precios de artículos" },
  { id: "pedidosventa", nombre: "Pedidos de venta" },
  { id: "facturasventa", nombre: "Facturas de venta" },
  { id: "analisiscliente", nombre: "Anàlisi per client" },
  { id: "simuladortarifas", nombre: "Simulador tarifas 2027" },
  { id: "correo", nombre: "Correo" },
  { id: "tareas", nombre: "Mis tareas" },
  { id: "calendario", nombre: "Calendario" },
  { id: "ia", nombre: "Asistente IA" },
  { id: "ratios", nombre: "Ratios financieros" },
  { id: "horas", nombre: "Control de horas" },
];

export const cargarEventos = () => {
  try { return JSON.parse(localStorage.getItem(LS_EVENTOS) || "[]"); } catch { return []; }
};
export const guardarEventos = (e) => {
  try { localStorage.setItem(LS_EVENTOS, JSON.stringify(e)); } catch { /* ok */ }
};

const sello = () =>
  new Date().toLocaleString("es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Texto corto para el prompt de la IA (estado de la app en el navegador). */
export function snapshotAppParaIA() {
  const hoy = hoyISO();
  const tareas = cargarTareas().filter((t) => !t.hecha).slice(0, 40);
  const eventos = cargarEventos()
    .filter((e) => e.fecha && e.fecha >= hoy)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.hora || "").localeCompare(String(b.hora || "")))
    .slice(0, 30);

  const lineasT = tareas.length
    ? tareas.map((t) => {
        const p = t.prioridad || "media";
        const f = t.fecha ? ` · límite ${t.fecha}${t.fecha < hoy ? " VENCIDA" : ""}` : "";
        return `- [${t.id}] ${t.titulo} (${p})${f}`;
      }).join("\n")
    : "(ninguna pendiente)";

  const lineasE = eventos.length
    ? eventos.map((e) => `- [${e.id}] ${e.fecha}${e.hora ? ` ${e.hora}` : ""} · ${e.titulo}`).join("\n")
    : "(ninguno próximo)";

  const pantallas = SECCIONES_APP.map((s) => `${s.id}=${s.nombre}`).join(", ");

  return [
    `Pantallas de ACSales (id=nombre): ${pantallas}`,
    `Tareas pendientes en el navegador (${tareas.length}):`,
    lineasT,
    `Eventos de calendario próximos (${eventos.length}):`,
    lineasE,
  ].join("\n");
}

/**
 * Ejecuta acciones pedidas por la IA.
 * @returns {{ aplicadas: object[], mensajes: string[] }}
 */
export function aplicarAccionesApp(acciones, { abrirSeccion } = {}) {
  const lista = Array.isArray(acciones) ? acciones : [];
  const aplicadas = [];
  const mensajes = [];

  for (const a of lista) {
    const tipo = String(a?.tipo || a?.name || "");
    try {
      if (tipo === "crear_tarea") {
        const titulo = String(a.titulo || "").trim();
        if (!titulo) throw new Error("Falta el título de la tarea.");
        const prioridad = ["alta", "media", "baja"].includes(a.prioridad) ? a.prioridad : "media";
        const fecha = String(a.fecha || "").slice(0, 10);
        const notas = String(a.notas || "").trim();
        const periodicidad = String(a.periodicidad || "").trim();
        const notaTxt = [notas, periodicidad ? `Periodicidad: ${periodicidad}` : ""].filter(Boolean).join("\n");
        const nueva = {
          id: Date.now() + Math.random(),
          titulo,
          prioridad,
          fecha,
          hecha: false,
          creada: new Date().toISOString(),
          correo: null,
          notasDiario: notaTxt ? [{ ts: sello(), txt: notaTxt }] : [],
          historial: [{ ts: sello(), tipo: "ia", txt: "Tasca creada per l'assistent IA" }],
          _extId: a._extId || `ia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        };
        const prev = cargarTareas();
        if (nueva._extId && prev.some((t) => t._extId === nueva._extId)) {
          aplicadas.push({ tipo, ok: true, duplicada: true, titulo });
          mensajes.push(`Tarea ya existía: ${titulo}`);
          continue;
        }
        guardarTareas([nueva, ...prev]);
        window.dispatchEvent(new CustomEvent(EVT_TAREAS));
        aplicadas.push({ tipo, ok: true, id: nueva.id, titulo });
        mensajes.push(`Tarea creada: ${titulo}`);
      } else if (tipo === "crear_evento") {
        const titulo = String(a.titulo || "").trim();
        if (!titulo) throw new Error("Falta el título del evento.");
        const fecha = String(a.fecha || "").slice(0, 10) || hoyISO();
        const hora = String(a.hora || "").slice(0, 5);
        const notas = String(a.notas || "").trim();
        const nuevo = {
          id: Date.now() + Math.random(),
          titulo,
          fecha,
          hora,
          notas,
          creado: new Date().toISOString(),
          _extId: a._extId || `ia-ev-${Date.now()}`,
        };
        const prev = cargarEventos();
        if (nuevo._extId && prev.some((e) => e._extId === nuevo._extId)) {
          aplicadas.push({ tipo, ok: true, duplicada: true, titulo });
          mensajes.push(`Evento ya existía: ${titulo}`);
          continue;
        }
        guardarEventos([nuevo, ...prev]);
        window.dispatchEvent(new CustomEvent(EVT_EVENTOS));
        aplicadas.push({ tipo, ok: true, id: nuevo.id, titulo, fecha });
        mensajes.push(`Evento creado: ${titulo} (${fecha}${hora ? ` ${hora}` : ""})`);
      } else if (tipo === "abrir_pantalla") {
        const id = String(a.pantalla || a.seccion || "").trim();
        const ok = SECCIONES_APP.some((s) => s.id === id);
        if (!ok) throw new Error(`Pantalla desconocida: ${id}`);
        if (typeof abrirSeccion === "function") abrirSeccion(id);
        aplicadas.push({ tipo, ok: true, pantalla: id });
        const nom = SECCIONES_APP.find((s) => s.id === id)?.nombre || id;
        mensajes.push(`Abierta: ${nom}`);
      } else if (tipo === "marcar_tarea") {
        const id = a.id;
        const hecha = a.hecha !== false;
        const prev = cargarTareas();
        const idx = prev.findIndex((t) => String(t.id) === String(id));
        if (idx < 0) throw new Error(`No encuentro la tarea ${id}`);
        const next = prev.map((t, i) => (i === idx ? { ...t, hecha: !!hecha } : t));
        guardarTareas(next);
        window.dispatchEvent(new CustomEvent(EVT_TAREAS));
        aplicadas.push({ tipo, ok: true, id, hecha: !!hecha });
        mensajes.push(hecha ? `Tarea marcada hecha` : `Tarea marcada pendiente`);
      } else {
        aplicadas.push({ tipo, ok: false, error: `Acción desconocida: ${tipo}` });
      }
    } catch (e) {
      aplicadas.push({ tipo, ok: false, error: String(e.message || e) });
      mensajes.push(`Error: ${e.message || e}`);
    }
  }
  return { aplicadas, mensajes };
}
