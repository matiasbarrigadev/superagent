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

/** Cómo se ve en el chat del panel lo que no es texto. */
function comoTexto(tipo, d, arch) {
  if (arch) return `📎 ${arch.nombre} [F-${arch.id}]${d?.epigrafe ? `\n${d.epigrafe}` : ''}`;
  if (tipo === 'ubicacion') return `📍 ${d.titulo ?? 'Ubicación'} (${d.latitud}, ${d.longitud})`;
  if (tipo === 'contacto') return `👤 ${d.nombre} +${String(d.telefono).replace(/\D/g, '')}`;
  if (tipo === 'encuesta') return `📊 ${d.pregunta}\n${d.opciones.map((o) => `○ ${o}`).join('\n')}`;
  if (tipo === 'reaccion') return `(reaccionó ${d.emoji || 'sin emoji'})`;
  return `(${tipo})`;
}

/** Cuánto tarda una persona en tipear un texto: ~30 ms por letra, entre 1 y 4 segundos, con algo de azar. */
export function tiempoDeEscritura(texto, azar = Math.random) {
  const base = Math.min(4000, Math.max(1000, 600 + String(texto ?? '').length * 30));
  return Math.round(base * (0.8 + azar() * 0.4));
}

export function crearSalida({ db, waha, numeros = null, ajustes, archivos = null, alRechazo = null, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), reloj = () => Date.now(), log = console }) {
  const ins = db.prepare(`INSERT INTO salida (chat_id, tipo, contenido, responde_a, contacto_nuevo, estado, no_antes_de, corrida_id, origen, creado, sesion)
    VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`);
  const insPanel = db.prepare(`INSERT INTO mensajes (session, id, chat_id, from_me, tipo, cuerpo, ts, procesado, recibido, canal)
    VALUES ('panel', ?, ?, 1, 'chat', ?, ?, 1, ?, 'panel')`);

  /**
   * Encola algo para mandar. tipo: texto | archivo | imagen | video | sticker | voz (con `archivo`: { archivoId,
   * epigrafe }) | reaccion | ubicacion | contacto | encuesta | editar | borrar (con `datos`).
   */
  function encolar({ chatId, texto, tipo = 'texto', archivo = null, datos = null, respondeA = null, contactoNuevo = false, corridaId = null, origen = null, sesion = null }) {
    const ahora = reloj();
    const ids = [];
    const piezas = tipo === 'texto' ? partir(texto) : [JSON.stringify(archivo ?? datos ?? {})];
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

  // WhatsApp cuida a los números nuevos: escribirle primero a quien nunca escribió es lo que más los arriesga.
  // Un error 463 es WhatsApp diciendo "este número no puede iniciar charlas así": no se reintenta (cada intento empeora
  // la reputación) y por unos días no sale ningún mensaje en frío desde ese número.
  const RESTRICCION_MS = 72 * 3_600_000;
  const claveRestriccion = (sesion) => `wa_restriccion:${sesion ?? 'principal'}`;
  const restringidoHasta = (sesion) => Number(ajustes?.get(claveRestriccion(sesion)) ?? 0);
  /** Cuántos mensajes en frío por día según la edad del número en el sistema (los nuevos, pocos). */
  function cupoEnFrio(sesion, ahora) {
    const creada = sesion ? db.prepare('SELECT creada FROM sesiones_wa WHERE nombre = ?').get(sesion)?.creada : null;
    if (!creada) return Infinity;
    const dias = (ahora - creada) / 86_400_000;
    return dias < 7 ? Math.max(1, ajustes?.num('frio_por_dia_nuevo', 5) ?? 5) : dias < 14 ? Math.max(1, ajustes?.num('frio_por_dia_reciente', 15) ?? 15) : Infinity;
  }
  function rechazar(f, sesion, motivo) {
    db.prepare("UPDATE salida SET estado = 'fallido', error = ?, sesion = COALESCE(sesion, ?) WHERE id = ?").run(motivo, sesion ?? null, f.id);
    log.warn('[salida] rechazado', f.chat_id, motivo);
    try { alRechazo?.({ chatId: f.chat_id, sesion, corridaId: f.corrida_id, origen: f.origen, motivo }); } catch {}
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
          if (f.contacto_nuevo) {
            if (restringidoHasta(sesion) > ahora) {
              rechazar(f, sesion, `WhatsApp restringió a este número para iniciar charlas (error 463): no sale nada en frío hasta ${new Date(restringidoHasta(sesion)).toISOString().slice(0, 16)} UTC.`);
              continue;
            }
            const cupo = cupoEnFrio(sesion, ahora);
            if (Number.isFinite(cupo)) {
              const hechos = db.prepare("SELECT enviado FROM salida WHERE contacto_nuevo = 1 AND estado = 'enviado' AND sesion = ? AND enviado > ? ORDER BY enviado").all(sesion, ahora - 86_400_000).map((r) => r.enviado);
              if (hechos.length >= cupo) {
                db.prepare('UPDATE salida SET no_antes_de = ? WHERE id = ?').run(hechos[hechos.length - cupo] + 86_400_000, f.id);
                continue;
              }
            }
          }
        }
        try {
          const d = f.tipo === 'texto' ? null : JSON.parse(f.contenido);
          const conArchivo = ['archivo', 'imagen', 'video', 'sticker', 'voz'].includes(f.tipo);
          const arch = conArchivo ? archivos?.obtener(d.archivoId) : null;
          if (conArchivo && !arch) throw new Error('El archivo ya no existe.');
          const archivo = arch ? { mimetype: arch.mime, filename: arch.nombre, data: archivos.leer(arch).toString('base64') } : null;
          let wahaId = null;
          if (esPanel(f.chat_id)) {
            insPanel.run(`panel-${f.id}`, f.chat_id, f.tipo === 'texto' ? f.contenido : comoTexto(f.tipo, d, arch), Math.floor(ahora / 1000), ahora);
          } else if (f.tipo === 'texto') {
            // "Escribiendo…" un rato acorde al largo, y recién ahí el mensaje (lo que recomienda WAHA para no parecer un bot).
            if (cliente.escribiendo && ajustes?.bool('escritura_humana', true)) {
              await cliente.escribiendo(f.chat_id, true);
              await dormir(tiempoDeEscritura(f.contenido));
            }
            wahaId = await cliente.enviarTexto(f.chat_id, f.contenido, { responderA: f.responde_a, menciones: d?.menciones ?? menciones(f) });
          } else if (f.tipo === 'archivo') {
            wahaId = await cliente.enviarArchivo(f.chat_id, archivo, { epigrafe: d.epigrafe });
          } else if (f.tipo === 'imagen') {
            wahaId = await cliente.enviarImagen(f.chat_id, archivo, { epigrafe: d.epigrafe, responderA: f.responde_a });
          } else if (f.tipo === 'video') {
            wahaId = await cliente.enviarVideo(f.chat_id, archivo, { epigrafe: d.epigrafe, responderA: f.responde_a });
          } else if (f.tipo === 'sticker') {
            wahaId = await cliente.enviarSticker(f.chat_id, archivo);
          } else if (f.tipo === 'voz') {
            wahaId = await cliente.enviarVoz(f.chat_id, { mimetype: arch.mime, data: archivo.data });
          } else if (f.tipo === 'reaccion') {
            await cliente.reaccionar(d.mensajeId, d.emoji);
          } else if (f.tipo === 'ubicacion') {
            wahaId = await cliente.enviarUbicacion(f.chat_id, d);
          } else if (f.tipo === 'contacto') {
            wahaId = await cliente.enviarContacto(f.chat_id, d);
          } else if (f.tipo === 'encuesta') {
            wahaId = await cliente.enviarEncuesta(f.chat_id, d);
          } else if (f.tipo === 'editar') {
            wahaId = await cliente.editarMensaje(f.chat_id, d.mensajeId, d.texto);
          } else if (f.tipo === 'borrar') {
            await cliente.borrarMensaje(f.chat_id, d.mensajeId);
          }
          db.prepare("UPDATE salida SET estado = 'enviado', enviado = ?, intentos = intentos + 1, waha_id = ? WHERE id = ?").run(reloj(), wahaId ?? null, f.id);
          enviados++;
        } catch (e) {
          if (/\berror 463\b/i.test(String(e.message)) && !esPanel(f.chat_id)) {
            const sesion = f.sesion ?? numeros?.sesionPara?.(f.chat_id) ?? null;
            ajustes?.set(claveRestriccion(sesion), String(ahora + RESTRICCION_MS));
            rechazar(f, sesion, 'WhatsApp no dejó iniciar la charla (error 463): este número no puede escribirle primero a quien no le escribió. No se reintenta.');
            continue;
          }
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

  // Menciones de un texto en un grupo: los @numero que aparecen.
  function menciones(f) {
    if (!String(f.chat_id).endsWith('@g.us')) return null;
    const m = [...String(f.contenido).matchAll(/@(\d{8,15})\b/g)].map((x) => `${x[1]}@c.us`);
    return m.length ? [...new Set(m)] : null;
  }

  return { encolar, procesar, esperaRitmo };
}
