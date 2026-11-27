// Entrada de WhatsApp (etapa 1): firma HMAC, normalización GOWS, LID con caché, mensajes únicos,
// chats y personas, menciones y respuestas al agente en grupos, y descarga de adjuntos.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { soloDigitos, mismoTelefono, telefonoDeJid, esGrupo } from '../util.mjs';
import { moverChat } from './unificar.mjs';

export function verificarHmac(clave, firma, crudo) {
  if (!clave) return false;
  const esperado = crypto.createHmac('sha512', clave).update(crudo).digest('hex');
  const got = String(firma ?? '');
  return got.length === esperado.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(esperado));
}

// GOWS usa "<num>@s.whatsapp.net" (a veces con ":<dispositivo>"); el resto del sistema usa "<num>@c.us".
export function normalizarJid(id) {
  if (typeof id !== 'string') return id ?? null;
  return id.replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '@c.us');
}

/** Busca en profundidad (acotada) todas las listas de menciones del payload crudo, sin depender de un motor. */
function mencionesCrudas(obj, prof = 0, out = []) {
  if (!obj || typeof obj !== 'object' || prof > 7) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (/^mentioned(jid|jids|ids)$/i.test(k) && Array.isArray(v)) out.push(...v.map(String));
    else if (v && typeof v === 'object') mencionesCrudas(v, prof + 1, out);
  }
  return out;
}

/** Participante del mensaje citado (contextInfo) en el payload crudo. */
function citadoCrudo(obj, prof = 0) {
  if (!obj || typeof obj !== 'object' || prof > 7) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/^contextinfo$/i.test(k) && v && typeof v === 'object') {
      const part = v.participant ?? v.Participant ?? null;
      const id = v.stanzaID ?? v.stanzaId ?? v.StanzaID ?? null;
      if (part || id) return { participant: part, id };
    }
    if (v && typeof v === 'object') {
      const r = citadoCrudo(v, prof + 1);
      if (r) return r;
    }
  }
  return null;
}

const digitosJid = (j) => soloDigitos(String(j ?? '').replace(/@.*$/, '').replace(/:\d+$/, ''));

/**
 * ¿El mensaje de grupo es para el agente? Lo mencionan (por JID, LID o "@número" en el texto),
 * le responden a un mensaje suyo, o lo llaman por su nombre.
 */
export function analizarGrupo(p, { meTelefono, meLid, nombreAgente, apodos = [], esMensajePropio = () => false }) {
  const ids = new Set([meTelefono, meLid].filter(Boolean).map(digitosJid).filter(Boolean));
  const cuerpo = String(p.body ?? '');
  const mencionados = [...(Array.isArray(p.mentionedIds) ? p.mentionedIds : []), ...mencionesCrudas(p._data)].map(digitosJid);
  let menciona = mencionados.some((d) => ids.has(d));
  if (!menciona) for (const d of ids) if (new RegExp(`@${d}(?!\\d)`).test(cuerpo)) menciona = true;
  if (!menciona && nombreAgente) {
    const esc = (x) => x.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // El nombre, los apodos que se guardaron y los diminutivos ("Sandro" → "Sandrito", "Sandrín").
    const nombres = [nombreAgente, ...apodos].map((x) => String(x ?? '').trim()).filter((x) => x.length >= 2);
    for (const n of nombres) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(cuerpo)) menciona = true;
    }
    const base = nombreAgente.trim();
    if (!menciona && base.length >= 5) {
      const raiz = esc(base.slice(0, base.length - 1));
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${raiz}(it[oa]s?|ín|in|ucho|uch[oa]|i)(?=$|[^\\p{L}\\p{N}])`, 'iu').test(cuerpo)) menciona = true;
    }
  }
  const citado = p.replyTo && typeof p.replyTo === 'object' ? { participant: p.replyTo.participant, id: p.replyTo.id } : citadoCrudo(p._data);
  let responde = false;
  if (citado?.participant && ids.has(digitosJid(citado.participant))) responde = true;
  if (!responde && citado?.id && esMensajePropio(String(citado.id))) responde = true;
  return { menciona, responde };
}

/** Núcleo del id de un mensaje (el mismo desde dos números): el ID de WhatsApp, sin el prefijo del chat. */
export function idNucleo(p) {
  const info = p?._data?.Info?.ID;
  if (info) return String(info);
  const partes = String(p?.id ?? '').split('_');
  return partes.length >= 3 ? partes[2] : String(p?.id ?? '');
}

export function crearIngesta({ db, waha = null, numeros = null, config = {}, ajustes = null, alMensaje = () => {}, alAdjunto = () => {}, alEvento = () => {}, alCambiarEstado = () => {}, reloj = () => Date.now(), log = console }) {
  const insertar = db.prepare(`INSERT OR IGNORE INTO mensajes
    (session, id, chat_id, persona_id, remitente, telefono, nombre_remitente, from_me, tipo, cuerpo, tiene_adjunto,
     media_url, media_tipo, responde_a, menciona, responde_al_agente, ts, procesado, recibido, canal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp')`);
  const evento = db.prepare('INSERT INTO eventos_wa (session, estado, ts) VALUES (?, ?, ?)');
  const qLid = db.prepare('SELECT telefono FROM lids WHERE lid = ?');
  const ponerLid = db.prepare('INSERT OR REPLACE INTO lids (lid, telefono, actualizado) VALUES (?, ?, ?)');
  // ¿Lo mandó el agente? Por el id que devolvió WAHA o, si el webhook llegó antes de anotarlo, por el texto reciente.
  const qEnvioPorId = db.prepare("SELECT 1 FROM salida WHERE chat_id = ? AND (waha_id = ? OR waha_id LIKE '%\\_' || ? ESCAPE '\\') LIMIT 1");
  const qEnvioPorTexto = db.prepare("SELECT 1 FROM salida WHERE chat_id = ? AND contenido = ? AND creado > ? AND estado IN ('pendiente', 'enviado') LIMIT 1");
  function esEnvioDelAgente(chatId, p) {
    const id = String(p.id ?? '');
    if (id && qEnvioPorId.get(chatId, id, id.split('_').at(-1))) return true;
    return !!(p.body && qEnvioPorTexto.get(chatId, String(p.body), reloj() - 5 * 60_000));
  }
  const qPropio = db.prepare("SELECT 1 FROM mensajes WHERE from_me = 1 AND (id = ? OR id LIKE '%\\_' || ? ESCAPE '\\') LIMIT 1");
  const dirAdjuntos = config.dataDir ? path.join(config.dataDir, 'adjuntos') : null;
  const dirGrabaciones = config.dataDir ? path.join(config.dataDir, 'grabaciones') : null;
  const tercero = () => db.prepare("SELECT id FROM roles WHERE nombre = 'Tercero' AND predefinido = 1").get().id;

  async function resolverLid(lid) {
    const fila = qLid.get(lid);
    if (fila?.telefono) return fila.telefono;
    if (!waha?.telefonoDeLid) return null;
    try {
      const tel = await waha.telefonoDeLid(lid);
      if (tel) ponerLid.run(lid, tel, Date.now());
      return tel;
    } catch {
      return null;
    }
  }

  /** Teléfono (dígitos) de un JID de persona: directo de "@c.us" o resolviendo el LID. */
  async function telefonoDe(jid) {
    if (!jid) return null;
    if (/@lid$/.test(jid)) return resolverLid(jid);
    return telefonoDeJid(jid);
  }

  /** Persona por teléfono (o LID); si no existe, alta automática como Tercero (no es un alta manual). */
  function personaPara({ telefono, lid, nombre }) {
    let p = null;
    if (telefono) {
      p = db.prepare('SELECT id, activa FROM personas WHERE telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)) ORDER BY alta_manual DESC, id LIMIT 1').get(telefono, telefono);
    }
    if (!p && lid) p = db.prepare('SELECT id, activa FROM personas WHERE lid = ? LIMIT 1').get(lid);
    if (p) {
      if (lid) db.prepare('UPDATE personas SET lid = COALESCE(lid, ?) WHERE id = ?').run(lid, p.id);
      if (telefono) db.prepare('UPDATE personas SET telefono = COALESCE(telefono, ?) WHERE id = ?').run(telefono, p.id);
      if (!p.activa) db.prepare('UPDATE personas SET activa = 1, rol_id = ?, alta_manual = 0 WHERE id = ?').run(tercero(), p.id);
      return p.id;
    }
    if (!telefono && !lid) return null;
    return Number(db.prepare('INSERT INTO personas (nombre, telefono, lid, rol_id, alta_manual, activa, creada) VALUES (?, ?, ?, ?, 0, 1, ?)')
      .run(nombre ?? null, telefono, lid, tercero(), Date.now()).lastInsertRowid);
  }

  function asegurarChat(chatId, { tipo, personaId, nombre }) {
    // Los grupos nacen inactivos (decisión 30); los privados, activos.
    db.prepare(`INSERT INTO chats (id, tipo, persona_id, cliente_id, activo, nombre, creado) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET persona_id = COALESCE(chats.persona_id, excluded.persona_id), nombre = COALESCE(chats.nombre, excluded.nombre)`)
      .run(chatId, tipo, personaId ?? null, tipo === 'grupo' ? 0 : 1, nombre ?? null, Date.now());
  }

  function grabar(evt) {
    if (!config.grabarWebhooks || !dirGrabaciones) return;
    try {
      fs.mkdirSync(dirGrabaciones, { recursive: true });
      fs.appendFileSync(path.join(dirGrabaciones, 'webhooks.jsonl'), JSON.stringify(evt) + '\n');
    } catch (e) {
      log.warn('[ingesta] no se pudo grabar el webhook:', e.message);
    }
  }

  async function descargarAdjunto(seq, media) {
    if (!dirAdjuntos || !waha?.descargar || !media?.url) return;
    const nombre = String(media.filename ?? `adjunto-${seq}${extensionDe(media.mimetype)}`).replace(/[^\w.\-]+/g, '_').slice(-80);
    const id = Number(db.prepare('INSERT INTO adjuntos (mensaje_seq, tipo, mime, nombre, estado, creado) VALUES (?, ?, ?, ?, ?, ?)')
      .run(seq, tipoAdjunto(media.mimetype), media.mimetype ?? null, media.filename ?? null, 'pendiente', Date.now()).lastInsertRowid);
    try {
      const { datos } = await waha.descargar(media.url);
      fs.mkdirSync(dirAdjuntos, { recursive: true });
      const ruta = path.join(dirAdjuntos, `${seq}-${nombre}`);
      fs.writeFileSync(ruta, datos);
      db.prepare("UPDATE adjuntos SET ruta = ?, tamano = ?, estado = 'listo' WHERE id = ?").run(ruta, datos.length, id);
      alAdjunto(id);
    } catch (e) {
      db.prepare("UPDATE adjuntos SET estado = 'fallido', procesado = 2 WHERE id = ?").run(id);
      log.warn('[ingesta] adjunto', seq, e.message);
    }
  }

  /** Un mensaje guardado por su id de WhatsApp (completo, o solo la parte final, como lo mandan algunos motores). */
  const qMensaje = db.prepare("SELECT seq, chat_id, from_me, cuerpo FROM mensajes WHERE id = ? OR id LIKE '%\\_' || ? ESCAPE '\\' ORDER BY seq DESC LIMIT 1");
  const idCorto = (id) => String(id ?? '').split('_').pop();
  const buscarMensaje = (id) => (id ? qMensaje.get(String(id), idCorto(id)) : null);

  /** Reacciones, ediciones, borrados y votos de encuestas. */
  async function otroEvento(evt) {
    const p = evt.payload ?? {};
    const sesion = evt.session ?? 'default';
    if (evt.event === 'message.reaction') {
      const objetivo = p.reaction?.messageId;
      const m = buscarMensaje(objetivo);
      if (!m) return 'ignorado';
      const de = normalizarJid(p.participant ?? p.from ?? '') || (p.fromMe ? 'yo' : 'alguien');
      db.prepare(`INSERT INTO reacciones (session, chat_id, mensaje_id, de, emoji, ts) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session, mensaje_id, de) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`)
        .run(sesion, m.chat_id, String(objetivo), p.fromMe ? 'yo' : de, String(p.reaction?.text ?? ''), Date.now());
      return 'reaccion';
    }
    if (evt.event === 'message.edited') {
      const m = buscarMensaje(p.editedMessageId ?? p._data?.editedMessageId ?? p.id);
      if (!m) return 'ignorado';
      db.prepare('UPDATE mensajes SET cuerpo = ?, editado = 1 WHERE seq = ?').run(String(p.body ?? p.after?.body ?? m.cuerpo ?? ''), m.seq);
      return 'editado';
    }
    if (evt.event === 'message.revoked') {
      const m = buscarMensaje(p.revokedMessageId ?? p.before?.id ?? p.after?.id ?? p.id);
      if (!m) return 'ignorado';
      // Lo que la persona borró no se sigue mostrando.
      db.prepare('UPDATE mensajes SET cuerpo = NULL, borrado = 1 WHERE seq = ?').run(m.seq);
      return 'borrado';
    }
    // Voto en una encuesta que mandó el agente: le llega como evento a esa charla.
    const idEncuesta = p.poll?.id ?? p.vote?.pollId;
    let encuesta = buscarMensaje(idEncuesta);
    if (!encuesta && idEncuesta) {
      const s = db.prepare("SELECT chat_id, contenido FROM salida WHERE tipo = 'encuesta' AND (waha_id = ? OR waha_id LIKE '%\\_' || ? ESCAPE '\\')").get(String(idEncuesta), idCorto(idEncuesta));
      if (s) { let d = {}; try { d = JSON.parse(s.contenido); } catch {} encuesta = { chat_id: s.chat_id, from_me: 1, cuerpo: `${d.pregunta ?? ''} (${(d.opciones ?? []).join(' / ')})` }; }
    }
    if (!encuesta || !encuesta.from_me) return 'ignorado';
    if (numeros && !numeros.puedeResponder(encuesta.chat_id)) return 'ignorado';
    const opciones = (p.vote?.selectedOptions ?? []).map((o) => (typeof o === 'string' ? o : o?.name ?? '')).filter(Boolean);
    const quien = normalizarJid(p.vote?.from ?? p.vote?.participant ?? '');
    // En grupos el voto llega con el LID de la persona: se busca su teléfono y su nombre.
    const tel = await telefonoDe(quien).catch(() => null);
    const persona = tel ? db.prepare('SELECT nombre FROM personas WHERE telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)) ORDER BY alta_manual DESC LIMIT 1').get(tel, tel)?.nombre : null;
    const contacto = persona ?? (quien ? db.prepare('SELECT nombre_remitente FROM mensajes WHERE remitente = ? AND nombre_remitente IS NOT NULL ORDER BY seq DESC LIMIT 1').get(quien)?.nombre_remitente : null);
    db.prepare(`INSERT INTO encuesta_votos (session, encuesta_id, chat_id, de, nombre, opciones, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session, encuesta_id, de) DO UPDATE SET opciones = excluded.opciones, nombre = COALESCE(excluded.nombre, encuesta_votos.nombre), ts = excluded.ts`)
      .run(sesion, idCorto(idEncuesta), encuesta.chat_id, quien || 'alguien', contacto ?? (tel ? `+${tel}` : null), JSON.stringify(opciones), Date.now());
    alEvento({ chatId: encuesta.chat_id, origen: 'encuesta', texto: `[voto en tu encuesta] ${contacto ?? (tel ? `+${tel}` : 'Alguien')} ${opciones.length ? `eligió: ${opciones.join(', ')}` : 'quitó su voto'}. La encuesta: ${String(encuesta.cuerpo ?? '').slice(0, 300)}` });
    return 'voto';
  }

  let meLidCache = null;
  async function meLid(me) {
    if (me?.lid) return me.lid;
    if (meLidCache) return meLidCache;
    const tel = telefonoDeJid(normalizarJid(me?.id));
    if (!tel || !waha?.lidDeTelefono) return null;
    try { meLidCache = await waha.lidDeTelefono(tel); } catch {}
    return meLidCache;
  }

  return async function procesar(evt) {
    grabar(evt);
    if (evt.event === 'session.status') {
      evento.run(evt.session ?? null, evt.payload?.status ?? null, Date.now());
      alCambiarEstado(evt.payload?.status, evt);
      return 'estado';
    }
    if (['message.reaction', 'message.edited', 'message.revoked', 'poll.vote'].includes(evt.event)) return otroEvento(evt);
    if (evt.event !== 'message.any' && evt.event !== 'message') return 'ignorado';
    const p = evt.payload ?? {};
    const fromMe = p.fromMe ? 1 : 0;
    // WEBJS manda el chat propio en "to"; GOWS deja "to" vacío y lo pone en from / _data.Info.Chat.
    // Lo que manda el propio número: el chat es el destino. WEBJS lo pone en "to"; GOWS en _data.Info.Chat y, en
    // grupos, a veces deja en "to" el propio número. Se toma el primero que no sea el propio número.
    const yo = normalizarJid(evt.me?.id ?? '');
    let chatId = fromMe
      ? ([p._data?.Info?.Chat, p.to, p.from].map((x) => normalizarJid(x ?? '')).find((x) => x && x !== yo) ?? normalizarJid(p.to || p.from))
      : normalizarJid(p.from);
    if (!chatId || !p.id || /@broadcast$|@newsletter$/.test(chatId) || chatId === 'status@broadcast') return 'ignorado';
    const grupo = esGrupo(chatId);
    const nombre = p._data?.notifyName ?? p._data?.pushName ?? p._data?.Info?.PushName ?? p.notifyName ?? null;
    const remitenteJid = normalizarJid(grupo ? (p.participant ?? p._data?.Info?.Sender) : (fromMe ? evt.me?.id : chatId));

    let telefono = null, personaId = null;
    if (!fromMe) telefono = await telefonoDe(remitenteJid);
    // Un solo chat por persona: el directo que llega por LID se guarda con el teléfono, si se conoce.
    if (!grupo && /@lid$/.test(chatId)) {
      const tel = fromMe ? await telefonoDe(chatId) : telefono;
      if (tel) {
        const canonico = `${tel}@c.us`;
        moverChat(db, chatId, canonico);
        chatId = canonico;
      }
    }

    // Política del número por el que llegó: se aplica antes de guardar nada y antes de despertar al agente.
    const sesion = evt.session ?? numeros?.nombrePrincipal ?? 'default';
    const politica = numeros?.politicaDe(sesion) ?? null;
    // En un número donde el agente no escribe, lo que sale "de mí" lo escribió la persona dueña de ese teléfono.
    let deDueno = false, canalDueno = false;
    if (numeros) {
      if (!numeros.enAlcance(sesion, chatId)) { numeros.contarFuera(sesion); return 'fuera_de_alcance'; }
      numeros.verChat(chatId, sesion);
      // Lo que manda otro número propio lo guarda ese número (como suyo): acá no despierta a nadie.
      if (!fromMe && telefono && numeros.numerosPropios().has(telefono)) return 'propio';
      // El mismo mensaje visto desde dos números se guarda una sola vez.
      const nucleoId = idNucleo(p);
      if (nucleoId && db.prepare("SELECT 1 FROM mensajes WHERE chat_id = ? AND session != ? AND (id = ? OR id LIKE '%' || ? || '%') LIMIT 1").get(chatId, sesion, String(p.id), nucleoId)) return 'duplicado';
      if (!politica.guardar) return 'sin_guardar';
      // Número personal del Propietario: lo que sale del teléfono y no lo mandó el agente lo escribió él.
      const personal = politica.personal_de ?? null;
      const delAgente = fromMe && esEnvioDelAgente(chatId, p);
      if (fromMe && personal && !delAgente && !grupo && chatId === numeros.chatPropio(sesion)) {
        // "Mensaje a ti mismo": le habla al agente.
        canalDueno = true;
        personaId = personal;
        telefono = numeros.obtener(sesion)?.numero ?? telefono;
      } else if (fromMe && ((personal && !delAgente) || politica.modo !== 'responder')) {
        deDueno = true;
        const n = numeros.obtener(sesion)?.numero;
        if (n) telefono = n;
      }
    }
    if ((!fromMe || deDueno) && !canalDueno) personaId = personaPara({ telefono, lid: !deDueno && /@lid$/.test(remitenteJid ?? '') ? remitenteJid : null, nombre });
    asegurarChat(chatId, { tipo: grupo ? 'grupo' : 'directo', personaId: grupo ? null : personaId, nombre: grupo ? (p._data?.Info?.GroupName ?? null) : nombre });

    let menciona = 0, responde = 0;
    if (grupo && !fromMe) {
      const a = analizarGrupo(p, {
        meTelefono: evt.me?.id ? normalizarJid(evt.me.id) : null,
        meLid: await meLid(evt.me),
        nombreAgente: ajustes?.get('nombre_agente'),
        apodos: String(ajustes?.get('apodos_agente') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        esMensajePropio: (id) => !!qPropio.get(id, id.split('_').at(-1)),
      });
      menciona = a.menciona ? 1 : 0;
      responde = a.responde ? 1 : 0;
    }

    // Despierta al agente si algún número que ve este chat puede responder ahí (autoridad). Si conviene responder o
    // no en un chat compartido lo decide el agente, con los datos de quién lo ve y quién quedó elegido.
    const despierta = (!fromMe || canalDueno) && (!numeros || numeros.puedeResponder(chatId));
    const tipo = p._data?.Info?.Type ?? p._data?.type ?? p.type ?? (p.hasMedia ? 'media' : 'chat');
    const r = insertar.run(
      sesion, String(p.id), chatId, personaId, remitenteJid, telefono, fromMe && !deDueno && !canalDueno ? null : nombre, deDueno || canalDueno ? 0 : fromMe,
      String(tipo), p.body ?? '', p.hasMedia ? 1 : 0, p.media?.url ?? null, p.media?.mimetype ?? null,
      (typeof p.replyTo === 'object' ? p.replyTo?.id : p.replyTo) ?? null, menciona, responde,
      Number(p.timestamp ?? Math.floor(Date.now() / 1000)),
      despierta ? 0 : 1, // lo propio, lo que solo se lee y lo que responde otro número nace procesado: es contexto
      reloj(),
    );
    if (!r.changes) return 'duplicado';
    const seq = Number(r.lastInsertRowid);
    if (p.hasMedia && p.media?.url) descargarAdjunto(seq, p.media).catch(() => {});
    if (despierta) alMensaje({ seq, chatId, personaId, grupo, menciona: !!menciona, responde: !!responde, telefono, cuerpo: p.body ?? '', sesion });
    return 'guardado';
  };
}

const EXTENSIONES = { 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
export const extensionDe = (mime = '') => EXTENSIONES[String(mime ?? '').split(';')[0].trim()] ?? '';

export function tipoAdjunto(mime = '') {
  const m = String(mime ?? '');
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'imagen';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  return 'documento';
}

export { mismoTelefono };
