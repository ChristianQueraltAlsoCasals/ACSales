/** Excel de la valoración de una OT con presupuesto, para el correo de
 *  revisión de material. Mismos importes que la ficha: coste de hora 21,50,
 *  venta de hora según tarifa ACSales (Excel) y tipo real, compras × 1,68. */

import ExcelJS from "exceljs";

const NAVY = "FF0F2740";
const NAVY2 = "FF1E3A5F";
const SLATE = "FF475569";
const LINE = "FFE2E8F0";
const PAPER = "FFF8FAFC";
const WHITE = "FFFFFFFF";
const INK = "FF1E293B";
const PLAN = "FFEFF6FF";
const PLAN2 = "FFF8FBFF";
const COMPRA = "FFFFF7ED";
const COMPRA2 = "FFFFFBF5";
const TOTAL = "FF0F2740";
const VERDE = "FFECFDF5";
const VERDE_INK = "FF065F46";
const INDICO = "FFEEF2FF";
const INDICO_INK = "FF3730A3";
const AMBAR = "FFFFFBEB";
const AMBAR_INK = "FF92400E";
const ROJO = "FFFEF2F2";
const ROJO_INK = "FF991B1B";

const EUR = '#,##0.00 "€";[Red]-#,##0.00 "€"';
const NUM = "#,##0.00;[Red]-#,##0.00";

const borde = () => {
  const c = { style: "thin", color: { argb: LINE } };
  return { top: c, left: c, bottom: c, right: c };
};

const relleno = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

function fechaTxt(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || "");
}

function aplicar(cell, { valor, formula, result, fmt, font, fill, align, bordeSi = true }) {
  if (formula) cell.value = { formula, result: result == null ? 0 : result };
  else if (valor !== undefined) cell.value = valor;
  if (fmt) cell.numFmt = fmt;
  cell.font = { name: "Calibri", size: 10, color: { argb: INK }, ...(font || {}) };
  if (fill) cell.fill = relleno(fill);
  cell.alignment = { vertical: "middle", wrapText: false, ...(align || {}) };
  if (bordeSi) cell.border = borde();
}

function banner(ws, cols, titulo, subtitulo) {
  ws.mergeCells(1, 1, 1, cols);
  ws.getRow(1).height = 34;
  aplicar(ws.getCell(1, 1), {
    valor: titulo,
    font: { size: 18, bold: true, color: { argb: WHITE } },
    fill: NAVY,
    align: { horizontal: "left", indent: 1 },
    bordeSi: false,
  });
  ws.mergeCells(2, 1, 2, cols);
  ws.getRow(2).height = 32;
  aplicar(ws.getCell(2, 1), {
    valor: subtitulo,
    font: { size: 10, italic: true, color: { argb: SLATE } },
    fill: PAPER,
    align: { horizontal: "left", indent: 1, wrapText: true },
    bordeSi: false,
  });
  ws.getRow(3).height = 8;
}

function titulos(ws, fila, textos) {
  const row = ws.getRow(fila);
  row.height = 32;
  textos.forEach((txt, i) => {
    aplicar(row.getCell(i + 1), {
      valor: txt,
      font: { size: 9, bold: true, color: { argb: WHITE } },
      fill: NAVY2,
      align: { horizontal: "center", wrapText: true },
    });
  });
}

function ancho(ws, lista) {
  lista.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function preparar(ws, { tab, orientacion }) {
  ws.properties.tabColor = { argb: tab };
  ws.pageSetup = {
    orientation: orientacion || "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    horizontalCentered: true,
  };
  ws.pageSetup.printTitlesRow = "1:4";
  ws.headerFooter = {
    oddHeader: "&LValoración&C&A&R&D",
    oddFooter: "&LImportes sin IVA&RPágina &P de &N",
  };
  ws.sheetProperties = { pageSetUpPr: { fitToPage: true } };
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
}

async function aBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function excelValoracionPresupuesto(ficha, v) {
  const ot = (typeof ficha === "object" && ficha && ficha._otExcel) || codigoDesdeFicha(ficha);
  const cliente = ficha?.general?.cliente || "";
  const descripcion = ficha?.general?.descripcion || "";
  const presupuesto = ficha?.general?.presupuesto || "";
  const horas = v?.horas || [];
  const compras = v?.compras || [];
  const primera = 5;
  const ultima = Math.max(primera, 4 + horas.length + compras.length);
  const facturado = Number(ficha?.venta?.importeCuentaVentas) || 0;
  const sub = [ot, cliente, presupuesto ? `Presupuesto ${presupuesto}` : "", descripcion, "Importes sin IVA"]
    .filter(Boolean)
    .join("  ·  ");

  const wb = new ExcelJS.Workbook();
  wb.creator = "ACSales";
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  const wsRes = wb.addWorksheet("RESUMEN", { properties: { tabColor: { argb: NAVY } } });
  const wsVal = wb.addWorksheet("VALORACION CONJUNTA", { properties: { tabColor: { argb: "FF0F766E" } } });
  const wsPlan = wb.addWorksheet("PLANIFICACION", { properties: { tabColor: { argb: "FF1D4ED8" } } });
  const wsComp = wb.addWorksheet("COMPRAS", { properties: { tabColor: { argb: "FFB45309" } } });

  hojaResumen(wsRes, { ot, sub, v, horas, compras, facturado, primera, ultima });
  hojaConjunta(wsVal, { ot, sub, horas, compras, primera, ultima });
  hojaPlan(wsPlan, { ot, sub, horas, primera });
  hojaCompras(wsComp, { ot, sub, compras, primera });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = await aBase64(buffer);
  return {
    nombre: `Valoracion_unificada_OT_${String(ot).replace(/[\\/]/g, "_")}.xlsx`,
    base64,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function codigoDesdeFicha(ficha) {
  const o = ficha?.numeroOTOrigenes || {};
  const deOrigen = String(o.listadoOTs || o.listado || o.lineasVenta || o.lineasCompra || "").trim();
  if (deOrigen && deOrigen.includes("/")) return deOrigen;
  return String(ficha?.numeroOT || deOrigen || "").trim();
}

function hojaResumen(ws, { ot, sub, v, horas, compras, facturado, primera, ultima }) {
  banner(ws, 5, `VALORACIÓN  ·  ${ot}`, sub);
  ancho(ws, [3, 46, 22, 3, 62]);
  ws.getRow(4).height = 22;
  ws.mergeCells(4, 2, 4, 3);
  aplicar(ws.getCell(4, 3), {
    valor: null,
    font: { size: 11, bold: true, color: { argb: WHITE } },
    fill: NAVY2,
  });
  aplicar(ws.getCell(4, 2), {
    valor: "RESUMEN ECONÓMICO",
    font: { size: 11, bold: true, color: { argb: WHITE } },
    fill: NAVY2,
    align: { horizontal: "left", indent: 1 },
  });

  const rangoA = `'VALORACION CONJUNTA'!A${primera}:A${ultima}`;
  const col = (letra) => `'VALORACION CONJUNTA'!${letra}${primera}:${letra}${ultima}`;
  const filas = [
    ["Horas de mano de obra", { formula: `SUMIF(${rangoA},"PLANIFICACIÓN",${col("I")})`, result: Number(v?.totalHoras) || 0 }, NUM, PAPER],
    ["Coste mano de obra", { formula: `SUMIF(${rangoA},"PLANIFICACIÓN",${col("M")})`, result: Number(v?.costeMO) || 0 }, EUR, PAPER],
    ["Coste compras", { formula: `SUMIF(${rangoA},"COMPRA",${col("M")})`, result: Number(v?.costeCompras) || 0 }, EUR, PAPER],
    ["Coste conjunto", { formula: "C6+C7", result: Number(v?.costeConjunto) || 0 }, EUR, NAVY, WHITE],
    ["Venta mano de obra", { formula: `SUMIF(${rangoA},"PLANIFICACIÓN",${col("O")})`, result: Number(v?.ventaMOConocida) || 0 }, EUR, "FFFFFFFF"],
    ["Venta compras (coste × 1,68)", { formula: `SUMIF(${rangoA},"COMPRA",${col("O")})`, result: Number(v?.ventaCompras) || 0 }, EUR, "FFFFFFFF"],
    ["Venta conjunta", { formula: "C9+C10", result: (Number(v?.ventaMOConocida) || 0) + (Number(v?.ventaCompras) || 0) }, EUR, VERDE, VERDE_INK],
    ["Venta objetivo × 1,68", { formula: "C8*1.68", result: (Number(v?.costeConjunto) || 0) * 1.68 }, EUR, INDICO, INDICO_INK],
    ["Venta registrada (cuenta 700)", facturado > 0 ? facturado : "—", facturado > 0 ? EUR : null, "FFFFFFFF"],
    ["Diferencia provisional", facturado > 0 ? { formula: "C13-C12", result: facturado - (Number(v?.costeConjunto) || 0) * 1.68 } : "—", facturado > 0 ? EUR : null, facturado > 0 && facturado - (Number(v?.costeConjunto) || 0) * 1.68 < 0 ? ROJO : "FFFFFFFF", facturado > 0 && facturado - (Number(v?.costeConjunto) || 0) * 1.68 < 0 ? ROJO_INK : INK],
  ];
  filas.forEach((f, i) => {
    const r = 5 + i;
    const destacado = f[3] === NAVY || f[3] === VERDE || f[3] === INDICO;
    ws.getRow(r).height = destacado ? 24 : 20;
    aplicar(ws.getCell(r, 2), {
      valor: f[0],
      font: { bold: destacado, color: { argb: f[4] || INK } },
      fill: f[3],
      align: { horizontal: "left", indent: 1 },
    });
    const valor = f[1];
    aplicar(ws.getCell(r, 3), {
      ...(valor && typeof valor === "object" ? { formula: valor.formula, result: valor.result } : { valor }),
      fmt: f[2] || undefined,
      font: { bold: true, color: { argb: f[4] || INK } },
      fill: f[3],
      align: { horizontal: "right" },
    });
  });

  const nota = v?.sinTarifa
    ? `${v.sinTarifa} línea(s) de horas sin tarifa: falta el grupo del recurso o el tipo de hora. Su venta no entra en el total.`
    : "Todas las horas tienen tarifa.";
  ws.mergeCells(16, 2, 16, 5);
  ws.getRow(16).height = 28;
  aplicar(ws.getCell(16, 2), {
    valor: nota,
    font: { size: 10, color: { argb: v?.sinTarifa ? AMBAR_INK : VERDE_INK } },
    fill: v?.sinTarifa ? AMBAR : VERDE,
    align: { horizontal: "left", indent: 1, wrapText: true },
  });
  ws.mergeCells(18, 2, 18, 5);
  ws.getRow(18).height = 32;
  aplicar(ws.getCell(18, 2), {
    valor: "La venta de compras es el coste de cada línea × 1,68. La venta de mano de obra es la tarifa ACSales (Excel de Anàlisi per client: general o especial del cliente) según grupo de recurso y tipo de hora (normal, extra, festivo o guardia). El coste de la hora es 21,50 €.",
    font: { size: 9, italic: true, color: { argb: SLATE } },
    fill: PAPER,
    align: { horizontal: "left", indent: 1, wrapText: true },
    bordeSi: false,
  });
  aplicar(ws.getCell(20, 2), { valor: "Líneas de horas", font: { color: { argb: SLATE } }, fill: PAPER, align: { indent: 1 } });
  aplicar(ws.getCell(20, 3), { valor: horas.length, fmt: "#,##0", font: { bold: true }, fill: PAPER, align: { horizontal: "right" } });
  aplicar(ws.getCell(21, 2), { valor: "Líneas de compras", font: { color: { argb: SLATE } }, fill: PAPER, align: { indent: 1 } });
  aplicar(ws.getCell(21, 3), { valor: compras.length, fmt: "#,##0", font: { bold: true }, fill: PAPER, align: { horizontal: "right" } });

  ws.views = [{ showGridLines: false, state: "frozen", ySplit: 3 }];
  ws.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 9 };
  ws.pageSetup.margins = { left: 0.5, right: 0.5, top: 0.6, bottom: 0.5, header: 0.2, footer: 0.2 };
  ws.headerFooter = { oddFooter: "&LImportes sin IVA&R&D" };
  ws.sheetProperties = { pageSetUpPr: { fitToPage: true } };
}

function hojaConjunta(ws, { ot, sub, horas, compras, primera, ultima }) {
  const cab = ["Origen", "OT / tarea", "Documento", "Fecha", "Tipo", "Código", "Operario / proveedor", "Descripción", "Cantidad", "Unidad", "Pendiente", "Coste unitario", "Coste total", "Venta unitaria", "Venta total", "Revisión", "Grupo", "Tipo hora"];
  banner(ws, cab.length, `VALORACIÓN CONJUNTA  ·  ${ot}`, sub);
  titulos(ws, 4, cab);
  ancho(ws, [16, 16, 16, 12, 12, 14, 32, 42, 12, 10, 12, 15, 15, 15, 15, 20, 14, 16]);
  preparar(ws, { tab: "FF0F766E" });

  horas.forEach((h, i) => {
    const r = primera + i;
    const sin = h.precio == null;
    const fondo = i % 2 ? PLAN2 : PLAN;
    const row = ws.getRow(r);
    row.height = 18;
    const vals = [
      "PLANIFICACIÓN",
      h.tarea || ot,
      h.documento || "",
      fechaTxt(h.fecha),
      "Recurso",
      h.recurso || "",
      h.nombre || "",
      h.descripcion || h.nombre || "",
      Number(h.cantidad) || 0,
      h.unidad || "h",
      0,
      21.5,
      null,
      sin ? null : h.precio,
      null,
      "Pendiente de revisar",
      h.grupo || "",
      h.tipoTrabajo || (sin ? "Sin tipo" : ""),
    ];
    vals.forEach((valor, c) => {
      const col = c + 1;
      const dinero = col >= 12 && col <= 15;
      aplicar(row.getCell(col), {
        valor: valor == null ? null : valor,
        fmt: col === 9 || col === 11 ? NUM : dinero ? EUR : undefined,
        fill: (sin && (col === 14 || col === 15 || col === 18)) ? AMBAR : fondo,
        font: {
          bold: col === 1,
          color: { argb: col === 1 ? "FF1D4ED8" : (sin && (col === 14 || col === 18)) ? AMBAR_INK : col === 16 ? AMBAR_INK : INK },
        },
        align: { horizontal: col >= 9 && col <= 15 ? "right" : "left" },
      });
    });
    aplicar(row.getCell(13), { formula: `I${r}*L${r}`, result: Number(h.coste) || 0, fmt: EUR, fill: fondo, align: { horizontal: "right" } });
    if (!sin) {
      aplicar(row.getCell(15), { formula: `I${r}*N${r}`, result: Number(h.venta) || 0, fmt: EUR, fill: fondo, font: { bold: true }, align: { horizontal: "right" } });
    }
  });

  compras.forEach((c, i) => {
    const r = primera + horas.length + i;
    const fondo = i % 2 ? COMPRA2 : COMPRA;
    const cant = Number(c.cantidad) || 0;
    const row = ws.getRow(r);
    row.height = 18;
    const vals = [
      "COMPRA",
      ot,
      c.documento || "",
      fechaTxt(c.fecha),
      "",
      c.numero || "",
      c.proveedor || "",
      c.descripcion || "",
      cant,
      "",
      "",
      Number(c.costeUnitario) || 0,
      Number(c.importe) || 0,
      null,
      null,
      "Pendiente de revisar",
      "",
      "",
    ];
    vals.forEach((valor, idx) => {
      const col = idx + 1;
      const dinero = col >= 12 && col <= 15;
      aplicar(row.getCell(col), {
        valor,
        fmt: col === 9 ? NUM : dinero ? EUR : undefined,
        fill: fondo,
        font: { bold: col === 1, color: { argb: col === 1 ? "FFC2410C" : col === 16 ? AMBAR_INK : INK } },
        align: { horizontal: col >= 9 && col <= 15 ? "right" : "left" },
      });
    });
    aplicar(row.getCell(15), { formula: `M${r}*1.68`, result: Number(c.venta) || 0, fmt: EUR, fill: fondo, font: { bold: true }, align: { horizontal: "right" } });
    if (cant) {
      aplicar(row.getCell(14), {
        formula: `O${r}/I${r}`,
        result: (Number(c.importe) || 0) / cant * 1.68,
        fmt: EUR,
        fill: fondo,
        align: { horizontal: "right" },
      });
    }
  });

  const tot = (horas.length + compras.length) ? ultima + 1 : primera;
  if (horas.length + compras.length) {
    ws.getRow(tot).height = 22;
    for (let c = 1; c <= cab.length; c++) {
      aplicar(ws.getRow(tot).getCell(c), {
        valor: c === 1 ? "TOTAL" : null,
        fill: TOTAL,
        font: { bold: true, color: { argb: WHITE } },
        align: { horizontal: c >= 9 ? "right" : "left" },
      });
    }
    aplicar(ws.getCell(tot, 9), {
      formula: `SUMIF(A${primera}:A${ultima},"PLANIFICACIÓN",I${primera}:I${ultima})`,
      result: horas.reduce((a, h) => a + (Number(h.cantidad) || 0), 0),
      fmt: NUM, fill: TOTAL, font: { bold: true, color: { argb: WHITE } }, align: { horizontal: "right" },
    });
    aplicar(ws.getCell(tot, 13), {
      formula: `SUM(M${primera}:M${ultima})`,
      result: horas.reduce((a, h) => a + (Number(h.coste) || 0), 0) + compras.reduce((a, c) => a + (Number(c.importe) || 0), 0),
      fmt: EUR, fill: TOTAL, font: { bold: true, color: { argb: WHITE } }, align: { horizontal: "right" },
    });
    aplicar(ws.getCell(tot, 15), {
      formula: `SUM(O${primera}:O${ultima})`,
      result: horas.reduce((a, h) => a + (Number(h.venta) || 0), 0) + compras.reduce((a, c) => a + (Number(c.venta) || 0), 0),
      fmt: EUR, fill: TOTAL, font: { bold: true, color: { argb: WHITE } }, align: { horizontal: "right" },
    });
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, ultima), column: cab.length } };
}

function hojaPlan(ws, { ot, sub, horas, primera }) {
  const cab = ["N.º tarea", "Tipo línea", "Fecha", "Nº documento", "Tipo", "Nº", "Descripción", "Pendiente", "Cantidad", "Coste unitario", "Coste total", "Precio venta", "Importe línea", "Tipo hora"];
  banner(ws, cab.length, `HORAS  ·  ${ot}`, `Uso real de la OT. Coste 21,50 €/h. ${sub}`);
  titulos(ws, 4, cab);
  ancho(ws, [14, 14, 12, 16, 12, 10, 36, 12, 12, 15, 15, 14, 16, 16]);
  preparar(ws, { tab: "FF1D4ED8" });
  horas.forEach((h, i) => {
    const r = primera + i;
    const sin = h.precio == null;
    const fondo = i % 2 ? PLAN2 : PLAN;
    const row = ws.getRow(r);
    row.height = 18;
    const vals = [h.tarea || "", "Uso", fechaTxt(h.fecha), h.documento || "", "Recurso", h.recurso || "", h.nombre || h.descripcion || "", 0, Number(h.cantidad) || 0, 21.5, null, sin ? null : h.precio, null, h.tipoTrabajo || ""];
    vals.forEach((valor, c) => {
      const col = c + 1;
      aplicar(row.getCell(col), {
        valor,
        fmt: col === 8 || col === 9 ? NUM : col >= 10 && col <= 13 ? EUR : undefined,
        fill: (sin && (col === 12 || col === 13 || col === 14)) ? AMBAR : fondo,
        font: { color: { argb: (sin && (col === 12 || col === 14)) ? AMBAR_INK : INK } },
        align: { horizontal: col >= 8 && col <= 13 ? "right" : "left" },
      });
    });
    aplicar(row.getCell(11), { formula: `I${r}*J${r}`, result: Number(h.coste) || 0, fmt: EUR, fill: fondo, align: { horizontal: "right" } });
    if (!sin) aplicar(row.getCell(13), { formula: `I${r}*L${r}`, result: Number(h.venta) || 0, fmt: EUR, fill: fondo, font: { bold: true }, align: { horizontal: "right" } });
  });
  if (horas.length) {
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: primera + horas.length - 1, column: cab.length } };
  }
}

function hojaCompras(ws, { ot, sub, compras, primera }) {
  const cab = ["Tipo documento", "Cód. OT", "Nº documento", "Proveedor", "Nº", "Descripción", "Cantidad", "% Dto. 1", "% Dto. 2", "% Dto. 3", "Coste unitario", "Fecha pedido", "Importe línea", "Venta × 1,68"];
  banner(ws, cab.length, `COMPRAS  ·  ${ot}`, sub);
  titulos(ws, 4, cab);
  ancho(ws, [16, 18, 16, 36, 16, 48, 12, 11, 11, 11, 15, 14, 16, 16]);
  preparar(ws, { tab: "FFB45309" });
  compras.forEach((c, i) => {
    const r = primera + i;
    const fondo = i % 2 ? COMPRA2 : COMPRA;
    const dtos = c.dtos || [0, 0, 0];
    const row = ws.getRow(r);
    row.height = 18;
    const vals = [
      String(c.documento || "").toUpperCase().startsWith("PC") ? "Pedido" : "",
      ot,
      c.documento || "",
      c.proveedor || "",
      c.numero || "",
      c.descripcion || "",
      Number(c.cantidad) || 0,
      Number(dtos[0]) || 0,
      Number(dtos[1]) || 0,
      Number(dtos[2]) || 0,
      Number(c.costeUnitario) || 0,
      fechaTxt(c.fecha),
      Number(c.importe) || 0,
      Number(c.venta) || 0,
    ];
    vals.forEach((valor, idx) => {
      const col = idx + 1;
      aplicar(row.getCell(col), {
        valor,
        fmt: col === 7 ? NUM : (col >= 8 && col <= 10) ? "0.00" : (col === 11 || col === 13 || col === 14) ? EUR : undefined,
        fill: fondo,
        font: { bold: col === 14, color: { argb: INK } },
        align: { horizontal: col >= 7 && col !== 12 ? "right" : "left" },
      });
    });
    aplicar(row.getCell(14), {
      formula: `M${r}*1.68`,
      result: Number(c.venta) || 0,
      fmt: EUR,
      fill: fondo,
      font: { bold: true },
      align: { horizontal: "right" },
    });
  });
  if (compras.length) {
    const tot = primera + compras.length;
    ws.getRow(tot).height = 22;
    for (let c = 1; c <= cab.length; c++) {
      aplicar(ws.getRow(tot).getCell(c), {
        valor: c === 1 ? "TOTAL" : null,
        fill: TOTAL,
        font: { bold: true, color: { argb: WHITE } },
      });
    }
    aplicar(ws.getCell(tot, 13), {
      formula: `SUM(M${primera}:M${tot - 1})`,
      result: compras.reduce((a, c) => a + (Number(c.importe) || 0), 0),
      fmt: EUR, fill: TOTAL, font: { bold: true, color: { argb: WHITE } }, align: { horizontal: "right" },
    });
    aplicar(ws.getCell(tot, 14), {
      formula: `SUM(N${primera}:N${tot - 1})`,
      result: compras.reduce((a, c) => a + (Number(c.venta) || 0), 0),
      fmt: EUR, fill: TOTAL, font: { bold: true, color: { argb: WHITE } }, align: { horizontal: "right" },
    });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: tot - 1, column: cab.length } };
  }
}
