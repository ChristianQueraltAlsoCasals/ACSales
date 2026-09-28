// =====================================================================
// INFORME — Pedidos de venta pendientes de facturar (.docx)
// Genera un documento Word real (con la librería "docx", que corre en el
// navegador) con el mismo formato que el ANEXO de previsión de
// facturación: una tabla "Resumen por unidad de negocio" y una tabla
// "Detalle" con todos los pedidos, en el orden en que se ven en pantalla
// (respeta los filtros aplicados, incluido el Excel con el importe real
// si está cargado).
//
// Requiere la dependencia "docx" (ya instalada en package.json).
// =====================================================================
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  AlignmentType,
  ShadingType,
  BorderStyle,
} from "docx";
import { normalizarNumeroOT } from "./agenteInteligente.js";

const AZUL_ALSO = "1D4ED8"; // azul de cabecera (aprox. marca)
const GRIS_CLARO = "F1F5F9";
const GRIS_BORDE = "CBD5E1";

function eurTxt(n) {
  return (Number(n) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function fechaTxt(iso) {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(iso);
}

const bordeFino = { style: BorderStyle.SINGLE, size: 2, color: GRIS_BORDE };
const bordesCelda = { top: bordeFino, bottom: bordeFino, left: bordeFino, right: bordeFino };

function celda(texto, { bold = false, align = AlignmentType.LEFT, shade = null, color = null, size = 18 } = {}) {
  return new TableCell({
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    borders: bordesCelda,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text: String(texto ?? ""), bold, color: color || undefined, size })],
      }),
    ],
  });
}

function filaCabecera(textos) {
  return new TableRow({
    tableHeader: true,
    children: textos.map((t) =>
      celda(t.texto ?? t, {
        bold: true,
        align: t.align ?? AlignmentType.LEFT,
        shade: "334155",
        color: "FFFFFF",
        size: 18,
      })
    ),
  });
}

function filaDatos(celdas) {
  return new TableRow({
    children: celdas.map((c) => celda(c.texto ?? c, { align: c.align ?? AlignmentType.LEFT, size: 18 })),
  });
}

/**
 * pedidos: array de { num, cliente, fecha, ot, un, estado, total, pend },
 * tal como lo produce la pantalla "Pedidos de venta pendientes de
 * facturar" (PedidosVentaPendientes) — ya filtrado, en el mismo orden
 * que ve Maria en pantalla.
 *
 * descripcionPorOT: Map (o objeto) de Nº de OT NORMALIZADO
 * (normalizarNumeroOT) → descripción de la OT (del Listado de OT's /
 * memoria histórica). Se usa para la columna "Descripción" de la tabla
 * de detalle, en vez de listar los números de pedido.
 */
export async function generarInformePendientesDocx(
  pedidos,
  {
    titulo = "Pedidos de venta pendientes de facturar",
    fuente = "",
    descripcionPorOT = null,
    estadoAppPorOT = null,
    comparativaPorUnidad = null,
    periodoFacturadoTexto = "",
  } = {}
) {
  const descOT = (ot) => {
    if (!descripcionPorOT) return "—";
    const clave = normalizarNumeroOT(ot);
    if (!clave) return "—";
    const d = descripcionPorOT instanceof Map ? descripcionPorOT.get(clave) : descripcionPorOT[clave];
    return d ? String(d).trim() || "—" : "—";
  };
  // Estat App de la OT (PENDENT / PROCÉS / FINALITZAT / FACTURAT...), la
  // misma que se ve como badge en el Explorador de OTs — en vez del
  // estado "crudo" del pedido de venta de BC (p.ej. "Lanzado").
  const estadoAppOT = (ot) => {
    if (!estadoAppPorOT) return "—";
    const clave = normalizarNumeroOT(ot);
    if (!clave) return "—";
    const e = estadoAppPorOT instanceof Map ? estadoAppPorOT.get(clave) : estadoAppPorOT[clave];
    return e ? String(e).trim() || "—" : "—";
  };
  // --- Resumen por unidad de negocio ---
  const porUnidad = new Map();
  for (const p of pedidos) {
    const clave = p.un || "Sin UN";
    const acc = porUnidad.get(clave) || { n: 0, total: 0 };
    acc.n += 1;
    acc.total += p.pend;
    porUnidad.set(clave, acc);
  }
  const unidadesOrdenadas = [...porUnidad.entries()].sort((a, b) => b[1].total - a[1].total);
  const totalGeneral = pedidos.reduce((a, p) => a + p.pend, 0);

  const tablaResumen = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      filaCabecera([
        { texto: "UN" },
        { texto: "Nº pedidos", align: AlignmentType.RIGHT },
        { texto: "Pendiente de facturar €", align: AlignmentType.RIGHT },
      ]),
      ...unidadesOrdenadas.map(([un, { n, total }]) =>
        filaDatos([
          { texto: un },
          { texto: String(n), align: AlignmentType.RIGHT },
          { texto: eurTxt(total), align: AlignmentType.RIGHT },
        ])
      ),
      new TableRow({
        children: [
          celda("TOTAL", { bold: true, shade: GRIS_CLARO }),
          celda(String(pedidos.length), { bold: true, align: AlignmentType.RIGHT, shade: GRIS_CLARO }),
          celda(eurTxt(totalGeneral), { bold: true, align: AlignmentType.RIGHT, shade: GRIS_CLARO }),
        ],
      }),
    ],
  });

  // --- Detalle: UNIFICADO por OT — varios pedidos de la misma OT se
  // suman en una sola fila (el total pendiente de esa OT según los
  // pedidos de venta), en vez de salir repetida una fila por pedido.
  // Los pedidos sin OT quedan cada uno en su propia fila.
  const porOT = new Map();
  for (const p of pedidos) {
    const clave = p.ot ? `ot:${p.ot}` : `pedido:${p.num}`;
    const acc = porOT.get(clave) || {
      ot: p.ot || "",
      cliente: p.cliente || "",
      un: p.un || "",
      estados: new Set(),
      pedidos: [],
      fechaMax: p.fecha || "",
      pend: 0,
    };
    acc.pend += p.pend;
    acc.pedidos.push(p.num);
    if (p.estado) acc.estados.add(p.estado);
    if (!acc.cliente && p.cliente) acc.cliente = p.cliente;
    if (!acc.un && p.un) acc.un = p.un;
    if (p.fecha && p.fecha > acc.fechaMax) acc.fechaMax = p.fecha;
    porOT.set(clave, acc);
  }
  const detalleOrdenado = [...porOT.values()].sort((a, b) => {
    const un = (a.un || "").localeCompare(b.un || "");
    if (un !== 0) return un;
    return b.pend - a.pend;
  });

  // Tabla de detalle dividida en una sub-tabla por unidad de negocio (en
  // vez de una tabla única con la UN repetida en cada fila). Cada bloque
  // lleva su propio subtítulo con el nº de OTs y el importe de esa UN.
  // Se agrupa recorriendo detalleOrdenado (ya ordenado por UN + importe)
  // para que el orden de las UN sea siempre el mismo que en el resumen.
  const gruposPorUnidad = new Map();
  for (const r of detalleOrdenado) {
    const clave = r.un || "Sin UN";
    if (!gruposPorUnidad.has(clave)) gruposPorUnidad.set(clave, []);
    gruposPorUnidad.get(clave).push(r);
  }

  const bloquesDetalle = [];
  for (const [un, filas] of gruposPorUnidad) {
    const totalUnidad = filas.reduce((a, r) => a + r.pend, 0);
    bloquesDetalle.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 80 },
        children: [
          new TextRun({ text: `${un} ` }),
          new TextRun({ text: `— ${filas.length} OT(s) · ${eurTxt(totalUnidad)}`, color: "64748B", bold: false }),
        ],
      })
    );
    bloquesDetalle.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          filaCabecera([
            { texto: "OT" },
            { texto: "Cliente" },
            { texto: "Última fecha" },
            { texto: "Estado" },
            { texto: "Descripción" },
            { texto: "Pendiente de facturar €", align: AlignmentType.RIGHT },
          ]),
          ...filas.map((r) =>
            filaDatos([
              { texto: r.ot || "—" },
              { texto: r.cliente || "—" },
              { texto: fechaTxt(r.fechaMax) },
              { texto: estadoAppOT(r.ot) },
              { texto: descOT(r.ot) },
              { texto: eurTxt(r.pend), align: AlignmentType.RIGHT },
            ])
          ),
        ],
      })
    );
  }

  // --- Comparativa: facturado (histórico) vs pendiente de facturar
  // (sobre lo que se ve en pantalla), por unidad de negocio.
  const filasComparativa = comparativaPorUnidad?.filas?.length ? comparativaPorUnidad.filas : [];
  const tablaComparativa = filasComparativa.length
    ? new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          filaCabecera([
            { texto: "UN" },
            { texto: "Facturado €", align: AlignmentType.RIGHT },
            { texto: "Pendiente de facturar €", align: AlignmentType.RIGHT },
            { texto: "% facturado", align: AlignmentType.RIGHT },
          ]),
          ...filasComparativa.map((r) =>
            filaDatos([
              { texto: r.un },
              { texto: eurTxt(r.facturado), align: AlignmentType.RIGHT },
              { texto: eurTxt(r.pendiente), align: AlignmentType.RIGHT },
              { texto: `${Math.round(r.pct)}%`, align: AlignmentType.RIGHT },
            ])
          ),
          new TableRow({
            children: [
              celda("TOTAL", { bold: true, shade: GRIS_CLARO }),
              celda(eurTxt(comparativaPorUnidad.totalFacturado), { bold: true, align: AlignmentType.RIGHT, shade: GRIS_CLARO }),
              celda(eurTxt(comparativaPorUnidad.totalPendiente), { bold: true, align: AlignmentType.RIGHT, shade: GRIS_CLARO }),
              celda(
                `${comparativaPorUnidad.totalGeneral > 0 ? Math.round((comparativaPorUnidad.totalFacturado / comparativaPorUnidad.totalGeneral) * 100) : 0}%`,
                { bold: true, align: AlignmentType.RIGHT, shade: GRIS_CLARO }
              ),
            ],
          }),
        ],
      })
    : null;

  const hoy = new Date();
  const fechaGenTxt = hoy.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 20 } },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 100 },
            children: [new TextRun({ text: titulo, color: AZUL_ALSO })],
          }),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: `ALSO CASALS${fuente ? ` · ${fuente}` : ""} · Generado el ${fechaGenTxt}`,
                italics: true,
                size: 18,
                color: "64748B",
              }),
            ],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
            children: [new TextRun({ text: "1. Resumen por unidad de negocio" })],
          }),
          tablaResumen,
          ...(tablaComparativa
            ? [
                new Paragraph({
                  heading: HeadingLevel.HEADING_2,
                  spacing: { before: 300, after: 100 },
                  children: [new TextRun({ text: "2. Comparativa: facturado vs pendiente de facturar" })],
                }),
                new Paragraph({
                  spacing: { after: 100 },
                  children: [
                    new TextRun({
                      text:
                        `Facturado: ${periodoFacturadoTexto || "todo el histórico"}. ` +
                        `Pendiente de facturar: todo lo abierto en pantalla (sin filtro de periodo, filtros de la pantalla aplicados).`,
                      italics: true,
                      size: 16,
                      color: "64748B",
                    }),
                  ],
                }),
                tablaComparativa,
              ]
            : []),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 100 },
            children: [new TextRun({ text: `${tablaComparativa ? "3" : "2"}. Detalle` })],
          }),
          ...bloquesDetalle,
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

export function nombreArchivoInformePendientes() {
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, "0");
  const dd = String(hoy.getDate()).padStart(2, "0");
  return `Pedidos_pendientes_facturar_${yyyy}${mm}${dd}.docx`;
}
