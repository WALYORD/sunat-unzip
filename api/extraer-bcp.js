const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const FECHA_RE = /^\d{2}(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SET|SEP|OCT|NOV|DIC)$/i;
const MONTO_RE = /^(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/;
const PERIODO_RE = /DEL\s+(\d{2})\/(\d{2})\/(\d{2,4})\s+AL\s+(\d{2})\/(\d{2})\/(\d{2,4})/i;

const MESES = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SET: 9, SEP: 9, OCT: 10, NOV: 11, DIC: 12
};

function redondear2(numero) {
  return Math.round((Number(numero) + Number.EPSILON) * 100) / 100;
}

function convertirMonto(texto) {
  return redondear2(Number(String(texto).replace(/,/g, '')));
}

function convertirAnio(anio) {
  const n = Number(anio);
  return n < 100 ? 2000 + n : n;
}

function fechaIso(codigo, anio) {
  const dia = Number(codigo.slice(0, 2));
  const mes = MESES[codigo.slice(2).toUpperCase()];
  if (!mes) throw new Error(`Mes no reconocido: ${codigo}`);
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function agruparLineas(items, tolerancia = 2.5) {
  const palabras = items
    .filter(item => String(item.str || '').trim())
    .map(item => ({
      texto: String(item.str).trim(),
      x: Number(item.transform[4]),
      y: Number(item.transform[5]),
      ancho: Number(item.width || 0)
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lineas = [];
  for (const palabra of palabras) {
    let linea = lineas.find(l => Math.abs(l.y - palabra.y) <= tolerancia);
    if (!linea) {
      linea = { y: palabra.y, palabras: [] };
      lineas.push(linea);
    }
    linea.palabras.push(palabra);
  }

  for (const linea of lineas) {
    linea.palabras.sort((a, b) => a.x - b.x);
  }

  return lineas.sort((a, b) => b.y - a.y);
}

function extraerPeriodo(texto) {
  const m = texto.replace(/\s+/g, ' ').match(PERIODO_RE);
  if (!m) throw new Error('No se pudo identificar el periodo del estado de cuenta.');

  const anioInicio = convertirAnio(m[3]);
  const anioFin = convertirAnio(m[6]);

  return {
    inicio: `${anioInicio}-${m[2]}-${m[1]}`,
    fin: `${anioFin}-${m[5]}-${m[4]}`,
    anio: anioInicio,
    texto: `${m[1]}/${m[2]}/${anioInicio} al ${m[4]}/${m[5]}/${anioFin}`
  };
}

function extraerTotales(texto) {
  let parte = texto;
  const pos = parte.toUpperCase().lastIndexOf('TEN PRESENTE');
  if (pos >= 0) parte = parte.slice(0, pos);

  const montos = parte.match(/(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g) || [];
  if (montos.length < 3) {
    return { salidasPdf: null, ingresosPdf: null, saldoFinal: null };
  }

  const ultimos = montos.slice(-3);
  return {
    salidasPdf: convertirMonto(ultimos[0]),
    ingresosPdf: convertirMonto(ultimos[1]),
    saldoFinal: convertirMonto(ultimos[2])
  };
}

function limpiarDescripcion(texto) {
  return String(texto || '')
    .replace(/\s+\*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function procesarPdf(buffer) {
  const documento = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const paginas = [];
  let textoCompleto = '';

  for (let numero = 1; numero <= documento.numPages; numero++) {
    const pagina = await documento.getPage(numero);
    const contenido = await pagina.getTextContent();
    const lineas = agruparLineas(contenido.items);
    paginas.push({ numero, ancho: pagina.getViewport({ scale: 1 }).width, lineas });
    textoCompleto += '\n' + contenido.items.map(i => i.str).join(' ');
  }

  const periodo = extraerPeriodo(textoCompleto);
  const movimientos = [];

  for (const pagina of paginas) {
    const ancho = pagina.ancho;

    // Formato BCP Ahorros: descripción ~21%-52%; cargos ~52%-77%; abonos ~77%-100%.
    const xDescripcionInicio = ancho * 0.20;
    const xCargosInicio = ancho * 0.52;
    const xAbonosInicio = ancho * 0.77;

    for (const linea of pagina.lineas) {
      const p = linea.palabras;
      if (p.length < 3 || !FECHA_RE.test(p[0].texto) || !FECHA_RE.test(p[1].texto)) {
        continue;
      }

      const candidatosMonto = p.filter(w => MONTO_RE.test(w.texto) && w.x >= xCargosInicio);
      if (!candidatosMonto.length) continue;

      // Solo debe haber un importe real por fila; si hay más, elegimos el más a la derecha.
      const importe = candidatosMonto.sort((a, b) => b.x - a.x)[0];
      const descripcion = limpiarDescripcion(
        p.filter(w => w.x >= xDescripcionInicio && w.x < xCargosInicio)
          .map(w => w.texto)
          .join(' ')
      );

      const descMayus = descripcion.toUpperCase();
      if (!descripcion || descMayus.startsWith('SALDO') || descMayus.startsWith('TOTAL')) {
        continue;
      }

      const monto = convertirMonto(importe.texto);
      const esIngreso = importe.x >= xAbonosInicio;

      movimientos.push({
        pagina: pagina.numero,
        fecha: fechaIso(p[0].texto.toUpperCase(), periodo.anio),
        descripcion,
        numeroOperacion: '',
        ingreso: esIngreso ? monto : 0,
        salida: esIngreso ? 0 : monto
      });
    }
  }

  const totales = extraerTotales(textoCompleto);
  const ingresosGenerados = redondear2(movimientos.reduce((s, m) => s + Number(m.ingreso || 0), 0));
  const salidasGeneradas = redondear2(movimientos.reduce((s, m) => s + Number(m.salida || 0), 0));
  const diferenciaIngresos = totales.ingresosPdf == null ? null : redondear2(ingresosGenerados - totales.ingresosPdf);
  const diferenciaSalidas = totales.salidasPdf == null ? null : redondear2(salidasGeneradas - totales.salidasPdf);

  return {
    ok: true,
    periodo,
    movimientos,
    control: {
      operaciones: movimientos.length,
      ingresosGenerados,
      salidasGeneradas,
      ingresosPdf: totales.ingresosPdf,
      salidasPdf: totales.salidasPdf,
      saldoFinal: totales.saldoFinal,
      diferenciaIngresos,
      diferenciaSalidas,
      cuadra: diferenciaIngresos === 0 && diferenciaSalidas === 0
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      mensaje: 'Extractor BCP operativo. Envíe el PDF por POST.'
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const { nombre = 'estado-cuenta.pdf', base64 } = req.body || {};
    if (!base64) {
      return res.status(400).json({ ok: false, error: 'No se recibió el PDF en Base64.' });
    }

    const limpio = String(base64).includes(',') ? String(base64).split(',').pop() : String(base64);
    const buffer = Buffer.from(limpio, 'base64');

    if (buffer.length < 100 || buffer.slice(0, 4).toString() !== '%PDF') {
      return res.status(400).json({ ok: false, error: 'El archivo recibido no es un PDF válido.' });
    }

    const resultado = await procesarPdf(buffer);
    resultado.archivo = nombre;

    if (!resultado.movimientos.length) {
      return res.status(422).json({ ok: false, error: 'No se encontraron movimientos bancarios.' });
    }

    return res.status(200).json(resultado);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}
