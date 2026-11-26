// Salida: todo lo que manda el agente pasa por la tabla `salida`, con reintentos.
// Ritmo suave (decisión 37): solo para conversaciones que el agente inicia con números que nunca escribieron.
// Responder, y todo lo que inicia la gente, no espera nunca.
import { esPanel } from '../util.mjs';

const LARGO_MAXIMO = 3800;

/** Parte un texto largo en pedazos, cortando en saltos de línea cuando se puede. */
export function partir(texto, max = LARGO_MAXIMO) {
  const t = String(texto ?? '').trim();
  if (t.length <= max) return t ? [t] : [];
  const partes = [];
  let resto = t;
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max);
    if (corte < max * 0.5) corte = resto.lastIndexOf(' ', max);
    if (corte < max * 0.5) corte = max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

export function crearSalida({ db, waha, numeros = null, ajustes, archivos = null, reloj = () => Date.now(), log = console }) {
  const ins = db.prepare(`INSERT INTO salida (chat_id, tipo, contenido, responde_a, contacto_nuevo, estado, no_antes_de, corrida_id, origen, creado, sesion)
    VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`);
  const insPanel = db.prepare(`INSERT INTO mensajes (session, id, chat_id, from_me, tipo, cuerpo, ts, procesado, recibido, canal)
    VALUES ('panel', ?, ?, 1, 'chat', ?, ?, 1, ?, 'panel')`);

  function encolar({ chatId, texto, tipo = 'texto', archivo = null, respondeA = null, contactoNuevo = false, corridaId = null, origen = null, sesion = null }) {
    const ahora = reloj();
    const ids = [];
    const piezas = tipo === 'texto' ? partir(texto) : [JSON.stringify(archivo)];
    for (const [i, contenido] of piezas.entries()) {
      ids.push(Number(ins.run(chatId, tipo, contenido, i === 0 ? respondeA : null, contactoNuevo ? 1 : 0, ahora, corridaId, origen, ahora, sesion).lastInsertRowid));
    }
    return ids;
  }

  /** Si un contacto nuevo tiene que esperar por el ritmo suave, devuelve desde cuándo puede salir. */
  function esperaRitmo(ahora) {
    if (!ajustes?.bool('ritmo_suave', true)) return 0;
    const porHora = Math.max(1, ajustes.num('ritmo_por_hora', 4));
    const espaciado = Math.max(0, ajustes.num('ritmo_espaciado_min', 5)) * 60_000;
    const enviados = db.prepare("SELECT enviado FROM salida WHERE contacto_nuevo = 1 AND estado = 'enviado' AND enviado > ? ORDER BY enviado")
      .all(ahora - 3_600_000).map((r) => r.enviado);
    let desde = 0;
    if (enviados.length >= porHora) desde = enviados[enviados.length - porHora] + 3_600_000;
    if (enviados.length) desde = Math.max(desde, enviados.at(-1) + espaciado);
    return desde > ahora ? desde : 0;
  }

  let ocupado = false;
  async function procesar() {
    if (ocupado) return 0;
    ocupado = true;
    let enviados = 0;
    try {
      for (;;) {
        const ahora = reloj();
        const f = db.prepare("SELECT * FROM salida WHERE estado = 'pendiente' AND no_antes_de <= ? ORDER BY id LIMIT 1").get(ahora);
        if (!f) break;
        if (f.contacto_nuevo) {
          // Un contacto nuevo por vez y respetando el ritmo; el resto de la cola no se frena.
          const desde = esperaRitmo(ahora);
          if (desde) {
            db.prepare('UPDATE salida SET no_antes_de = ? WHERE id = ?').run(desde, f.id);
            continue;
          }
        }
        // Por qué número sale y si la política lo permite: lo que no está permitido no sale, lo pida quien lo pida.
        let cliente = waha;
        if (numeros && !esPanel(f.chat_id)) {
          const sesion = f.sesion ?? numeros.sesionPara(f.chat_id);
          const ok = numeros.puedeEnviar(sesion, f.chat_id, { contactoNuevo: !!f.contacto_nuevo });
          if (!ok.ok) {
            db.prepare("UPDATE salida SET estado = 'fallido', error = ?, sesion = ? WHERE id = ?").run(`Bloqueado por la política: ${ok.motivo}`, sesion, f.id);
            log.warn('[salida] bloqueado', f.chat_id, ok.motivo);
            continue;
          }
          if (!f.sesion) db.prepare('UPDATE salida SET sesion = ? WHERE id = ?').run(sesion, f.id);
          cliente = numeros.cliente(sesion);
        }
        try {
          const adj = f.tipo === 'texto' ? null : JSON.parse(f.contenido);
          const arch = adj ? archivos?.obtener(adj.archivoId) : null;
          if (adj && !arch) throw new Error('El archivo ya no existe.');
          if (esPanel(f.chat_id)) {
            insPanel.run(`panel-${f.id}`, f.chat_id, f.tipo === 'texto' ? f.contenido : `📎 ${arch.nombre} [F-${arch.id}]${adj.epigrafe ? `
${adj.epigrafe}` : ''}`, Math.floor(ahora / 1000), ahora);
          } else if (f.tipo === 'texto') {
            await cliente.enviarTexto(f.chat_id, f.contenido, { responderA: f.responde_a });
          } else if (f.tipo === 'archivo') {
            await cliente.enviarArchivo(f.chat_id, { mimetype: arch.mime, filename: arch.nombre, data: archivos.leer(arch).toString('base64') }, { epigrafe: adj.epigrafe });
          } else {
            await cliente.enviarVoz(f.chat_id, { mimetype: arch.mime, data: archivos.leer(arch).toString('base64') });
          }
          db.prepare("UPDATE salida SET estado = 'enviado', enviado = ?, intentos = intentos + 1 WHERE id = ?").run(reloj(), f.id);
          enviados++;
        } catch (e) {
          const intentos = f.intentos + 1;
          const fallido = intentos >= 6;
          db.prepare('UPDATE salida SET intentos = ?, error = ?, estado = ?, no_antes_de = ? WHERE id = ?')
            .run(intentos, String(e.message).slice(0, 300), fallido ? 'fallido' : 'pendiente', ahora + 15_000 * 2 ** intentos, f.id);
          log.warn('[salida]', f.chat_id, e.message);
          if (fallido) log.error('[salida] no se pudo entregar', f.id);
        }
      }
    } finally {
      ocupado = false;
    }
    return enviados;
  }

  return { encolar, procesar, esperaRitmo };
}
