// Etapa 5b: audios, adjuntos y documentos (con los programas de medios reemplazados por un doble).
// La prueba con los programas de verdad está en scripts/verificar-medios.mjs (dentro del contenedor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armar, persona, escribe } from './ayuda.mjs';

/** Doble de ffmpeg, whisper, pdftotext, tesseract, etc. `pdfConTexto` decide si el PDF "tiene" texto. */
function medios({ pdfConTexto = false } = {}) {
  const llamadas = [];
  const correr = async (cmd, args, opts) => {
    llamadas.push({ cmd: path.basename(cmd), args, opts });
    const c = path.basename(cmd);
    if (c === 'ffmpeg') return { codigo: 0, out: '', err: '' };
    if (c.includes('whisper')) return { codigo: 0, out: ' Hola, te mando el presupuesto para el evento del sábado.\n' };
    if (c === 'pdfinfo') return { codigo: 0, out: 'Pages:          1\n' };
    if (c === 'pdftotext') return { codigo: 0, out: pdfConTexto ? 'Factura 0001-00012345\nTotal: $ 150.000\n'.repeat(3) : '\f' };
    if (c === 'pdftoppm') return { codigo: 0, out: '' };
    if (c === 'sh') return { codigo: 0, out: 'FACTURA ESCANEADA\nTotal $ 98.500\n' };
    if (c === 'python3') return { codigo: 0, out: '## Hoja1\nProducto | Precio\nSilla | 1200\n' };
    return { codigo: 1, out: '', err: 'no' };
  };
  return { correr, llamadas };
}

async function conAdjunto({ mime, nombre, rol = null, pdfConTexto = false, guion = () => [] }) {
  const m = medios({ pdfConTexto });
  const t = armar({ correrMedios: m.correr, guion });
  if (rol) persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol });
  await escribe(t.nucleo, { telefono: rol ? '5491122222222' : '5491199999999', texto: '', media: { mime, nombre } });
  await t.nucleo.medios.esperar();
  return { ...t, m, adj: () => t.db.prepare('SELECT * FROM adjuntos').get() };
}

test('un audio deja su transcripción en adjuntos, y al Tercero le llega como dato externo', async () => {
  const t = await conAdjunto({ mime: 'audio/ogg; codecs=opus' });
  const a = t.adj();
  assert.equal(a.tipo, 'audio');
  assert.equal(a.procesado, 1);
  assert.match(a.texto, /presupuesto para el evento del sábado/);
  assert.deepEqual(t.m.llamadas.map((l) => l.cmd), ['ffmpeg', 'whisper-cli']);
  await t.avanzar(46_000);
  const c = t.corridas[0];
  assert.equal(c.spec.variante, 'tercero');
  assert.match(c.spec.prompt, /<dato_externo tipo="audio">[\s\S]*presupuesto[\s\S]*<\/dato_externo>/);
  assert.deepEqual(c.spec.adjuntos, [], 'al Tercero no se le copia el archivo');
  t.limpiar();
});

test('un PDF escaneado pasa por OCR; uno con texto, no', async () => {
  const escaneado = await conAdjunto({ mime: 'application/pdf', nombre: 'factura.pdf' });
  assert.match(escaneado.adj().texto, /FACTURA ESCANEADA/);
  assert.ok(escaneado.m.llamadas.some((l) => l.cmd === 'pdftoppm'));
  escaneado.limpiar();
  const conTexto = await conAdjunto({ mime: 'application/pdf', nombre: 'factura.pdf', pdfConTexto: true });
  assert.match(conTexto.adj().texto, /Factura 0001-00012345/);
  assert.ok(!conTexto.m.llamadas.some((l) => l.cmd === 'pdftoppm'));
  conTexto.limpiar();
});

test('un video deja el audio transcripto y el texto en pantalla', async () => {
  const t = await conAdjunto({ mime: 'video/mp4' });
  assert.match(t.adj().texto, /^Audio: Hola, te mando el presupuesto[\s\S]*Texto en pantalla: FACTURA ESCANEADA/);
  t.limpiar();
});

test('una imagen deja el texto que tiene (OCR)', async () => {
  const t = await conAdjunto({ mime: 'image/jpeg' });
  assert.match(t.adj().texto, /Texto en la imagen: FACTURA ESCANEADA/);
  t.limpiar();
});

test('una planilla deja su contenido', async () => {
  const t = await conAdjunto({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', nombre: 'precios.xlsx' });
  assert.match(t.adj().texto, /Silla \| 1200/);
  t.limpiar();
});

test('quien tiene herramientas recibe el archivo copiado en su carpeta, y el motor espera a que esté procesado', async () => {
  let liberar;
  const lento = new Promise((r) => { liberar = r; });
  const m = medios();
  const t = armar({ correrMedios: async (...a) => { await lento; return m.correr(...a); }, guion: () => [] });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'mirá', media: { mime: 'audio/ogg' } });
  t.tiempo.t += 46_000;
  t.nucleo.motor.tick();
  await t.nucleo.motor.esperar();
  assert.equal(t.corridas.length, 0, 'espera a que el audio esté transcripto');
  liberar();
  await t.avanzar(6000);
  const c = t.corridas[0];
  assert.equal(c.spec.adjuntos.length, 1);
  assert.match(c.spec.prompt, new RegExp(`en ${c.spec.rutas.adjuntos.replace(/\\/g, '\\\\')}`));
  assert.match(c.spec.prompt, /presupuesto/);
  t.limpiar();
});

test('enviar_archivo: solo desde la carpeta de salida de la corrida (o un F-n del mismo chat)', async () => {
  const t = armar({
    guion: async (spec, ctx, llamar) => {
      fs.mkdirSync(spec.rutas.salida, { recursive: true });
      fs.writeFileSync(path.join(spec.rutas.salida, 'informe.pdf'), '%PDF-1.4 informe');
      await llamar('enviar_archivo', { archivo: 'informe.pdf', epigrafe: 'Acá va' });
      await llamar('enviar_archivo', { archivo: '../config/.credentials.json' });
      await llamar('enviar_archivo', { archivo: path.join(t.config.dataDir, 'superagent.db') });
      await llamar('enviar_archivo', { archivo: 'F-99' });
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.waha.enviarArchivo = async (chatId, archivo, o) => { t.waha.enviados.push({ chatId, archivo, epigrafe: o?.epigrafe }); };
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'mandame el informe' });
  await t.avanzar(46_000);
  const r = t.corridas[0].resultados.map((x) => [x.r.isError ?? false, x.r.content[0].text]);
  assert.match(r[0][1], /Archivo F-1 enviado/);
  assert.ok(r[1][0] && /directamente en/.test(r[1][1]), 'fuera de salida: falla');
  assert.ok(r[2][0], 'ruta absoluta fuera de salida: falla');
  assert.ok(r[3][0] && /No hay un archivo F-99/.test(r[3][1]));
  const enviado = t.waha.enviados.find((e) => e.archivo);
  assert.equal(enviado.archivo.filename, 'informe.pdf');
  assert.equal(enviado.archivo.mimetype, 'application/pdf');
  assert.equal(Buffer.from(enviado.archivo.data, 'base64').toString(), '%PDF-1.4 informe');
  assert.equal(enviado.epigrafe, 'Acá va');
  t.limpiar();
});

test('enviar_audio está apagado por defecto y el Tercero no puede mandar archivos', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491199999999', texto: 'hola' });
  await t.avanzar(46_000);
  const [duena, tercero] = t.corridas;
  assert.ok(duena.spec.herramientasGateway.includes('enviar_archivo'));
  assert.ok(!duena.spec.herramientasGateway.includes('enviar_audio'));
  assert.ok(!tercero.spec.herramientasGateway.includes('enviar_archivo'));
  t.limpiar();
});

test('lo que un trabajo deja en su salida le llega al orquestador como F-n', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.tipo === 'trabajo') {
        fs.mkdirSync(spec.rutas.salida, { recursive: true });
        fs.writeFileSync(path.join(spec.rutas.salida, 'resumen.pdf'), '%PDF resumen');
        return [];
      }
      return spec.prompt.includes('armá') ? [{ herramienta: 'delegar_trabajo', args: { descripcion: 'Armar el resumen en PDF del mes' } }] : [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'armá el resumen' });
  await t.avanzar(46_000);
  await t.avanzar(2000);
  assert.match(t.corridas.at(-1).spec.prompt, /\[T-1 terminado\][\s\S]*F-1 \(resumen\.pdf\)/);
  assert.equal(t.db.prepare('SELECT chat_id FROM archivos').get().chat_id, '5491111111111@c.us');
  t.limpiar();
});
