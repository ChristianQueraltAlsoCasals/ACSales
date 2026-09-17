import fs from 'fs';
import { adaptarFilasJob, adaptarFacturasPDF, descripcionesDeFacturasPDF, construirFichasOT, enriquecerFichasConAtributos, sugerirParaOTNueva, normalizarNumeroOT } from './src/agenteInteligente.js';

const archivos = ['Factura_venta_P001723','Factura_venta_P25000028','Factura_venta_P26000432','Factura_venta_P26000549'].map(n => ({
  nombre: n + '.pdf', base64: fs.readFileSync('/mnt/user-data/uploads/' + n + '.pdf').toString('base64')
}));
const resp = await fetch('http://localhost:3000/api/facturas/pdf', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({archivos}) });
const { data: facturas } = await resp.json();

const proyectos = JSON.parse(fs.readFileSync('/mnt/user-data/uploads/proyectos.json','utf8')).data;
const mapa = construirFichasOT(adaptarFilasJob(proyectos), adaptarFacturasPDF(facturas), []);

// añadir SIEMPRE las descripciones de partes (misma lógica que la pantalla)
const descPorOT = descripcionesDeFacturasPDF(facturas);
for (const [clave, descs] of descPorOT) {
  const f = mapa.get(clave);
  if (!f) continue;
  const act = f.general.descripcion || "";
  const nuevas = descs.filter(d => !act.toLowerCase().includes(d.toLowerCase()));
  if (nuevas.length) f.general.descripcion = act ? act + " · " + nuevas.join(" · ") : nuevas.join(" · ");
}

await enriquecerFichasConAtributos(mapa, { tamanoLote: 500 });
const r = await sugerirParaOTNueva('fuga de agua', mapa, { tarifaHora: 31 });
if (!r.referencias?.length) { console.log('SIN REFERENCIAS:', r.mensaje); process.exit(0); }
console.log('n similares:', r.estadisticas.nSimilares, '· confianza:', r.confianza);
console.log('Horas: mediana', r.estadisticas.horas.mediana, 'h · rango', r.estadisticas.horas.rango.map(x=>x.toFixed(1)).join('–'), 'h');
console.log('Importe:', Math.round(r.estadisticas.importeTotal.rango[0]), '–', Math.round(r.estadisticas.importeTotal.rango[1]), '€');
const mf = r.estadisticas.materialesFrecuentes;
if (mf) {
  console.log('\n🧰 Material habitual (base ' + mf.baseOTs + ' OTs):');
  mf.familias.forEach(f => console.log(`   ${f.familia} — ${Math.round(f.pct*100)}% · ej: ${f.ejemplos[0]?.slice(0,55)}`));
} else console.log('materialesFrecuentes: null');
console.log('\nCombinada a 31€/h:', r.recomendacionCombinada ? Math.round(r.recomendacionCombinada.rangoTotal[0]) + '–' + Math.round(r.recomendacionCombinada.rangoTotal[1]) + '€ (' + r.recomendacionCombinada.contraste + ')' : '—');
