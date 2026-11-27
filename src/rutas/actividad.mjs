// "Ver al agente" (solo el Propietario): qué hizo en cada turno, qué mensajes no le pasaron y por qué, y en qué
// estado está todo. Los pasos ya se guardan tachados (servicios/actividad.mjs); acá solo se arman para mostrar.
import { resumirTurno } from '../servicios/actividad.mjs';

const MOTIVOS = {
  chat_inactivo: 'el chat está apagado',
  contexto: 'grupo sin mención (lo lee como contexto)',
  sin_conversar: 'su rol no puede conversar',
  sin_alta: 'número sin alta (no se le responde hasta darlo de alta)',
};

export function montarActividad(app, { db, nucleo }) {
  const nombreChat = (ch, id) => ch?.nombre || ch?.persona || (ch?.telefono ? `+${ch.telefono}` : null) || (String(id).startsWith('panel:') ? 'Panel' : String(id ?? '').split('@')[0]);
  const qChat = db.prepare('SELECT ch.id, ch.tipo, ch.nombre, p.nombre AS persona, p.telefono FROM chats ch LEFT JOIN personas p ON p.id = ch.persona_id WHERE ch.id = ?');
  const chatDe = (id) => (id ? qChat.get(id) : null);
  const qPersona = db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?');
  const nombrePersona = (id) => { const p = id ? qPersona.get(id) : null; return p ? (p.nombre ?? `+${p.telefono}`) : null; };

  /** Qué despertó al agente, en una línea. */
  function disparo(c, mensajes) {
    const reales = mensajes.filter((m) => m.tipo !== 'evento');
    if (reales.length) {
      const quienes = [...new Set(reales.map((m) => (m.from_me ? 'vos' : nombrePersona(m.persona_id) ?? m.remitente ?? 'alguien')))];
      return `Recibió ${reales.length === 1 ? 'un mensaje' : `${reales.length} mensajes`} de ${quienes.slice(0, 3).join(', ')}`;
    }
    const evento = mensajes.find((m) => m.tipo === 'evento');
    if (evento) {
      const t = /^\[([^\]]{1,80})\]/.exec(String(evento.cuerpo ?? ''))?.[1];
      return t ? `Lo despertó: ${t}` : 'Lo despertó un aviso del sistema';
    }
    if (c.tipo === 'rutina') return `Corrió una rutina${c.origen ? ` (${c.origen.replace('rutina:', 'R-')})` : ''}`;
    if (c.tipo === 'trabajo') return `Trabajo en segundo plano${c.trabajo_id ? ` ${c.trabajo_id}` : ''}`;
    if (c.tipo === 'sesion') return 'Sesión de proyecto';
    return null;
  }

  const qMensajes = db.prepare('SELECT seq, tipo, cuerpo, persona_id, remitente, from_me, recibido FROM mensajes WHERE corrida_id = ? ORDER BY seq');
  const qPasos = db.prepare('SELECT tipo, nombre, categoria FROM corrida_pasos WHERE corrida_id = ? ORDER BY id');
  const qNoResponde = db.prepare("SELECT titulo FROM corrida_pasos WHERE corrida_id = ? AND nombre LIKE '%no_responder' ORDER BY id DESC LIMIT 1");

  function turno(c) {
    const mensajes = qMensajes.all(c.id);
    const pasos = qPasos.all(c.id);
    const ch = chatDe(c.chat_id);
    const dis = disparo(c, mensajes);
    return {
      clase: 'turno', id: c.id, ts: c.inicio, fin: c.fin, tipo: c.tipo, estado: c.estado, error: c.error,
      chat_id: c.chat_id, chat: c.chat_id ? nombreChat(ch, c.chat_id) : null, rol: c.rol,
      motor: c.credencial_usada, modelo: c.modelo, costo: c.costo_usd, duracion: c.fin && c.inicio ? c.fin - c.inicio : null,
      resumen: resumirTurno(pasos, { disparo: dis ? dis.charAt(0).toLowerCase() + dis.slice(1) : null }),
      pasos: pasos.length, noResponde: qNoResponde.get(c.id)?.titulo?.replace(/^Decidió no responder:\s*/, '') ?? null,
      nota: c.resultado ? String(c.resultado).slice(0, 600) : null,
    };
  }

  // Línea de tiempo: turnos y mensajes que el gateway no le pasó, lo más nuevo primero.
  app.get('/api/actividad', (c) => {
    const chat = c.req.query('chat') || null;
    const antes = Number(c.req.query('antes')) || Number.MAX_SAFE_INTEGER;
    const limite = Math.min(100, Math.max(5, Number(c.req.query('limite')) || 30));
    const corridas = db.prepare(`SELECT * FROM corridas WHERE inicio < ? ${chat ? 'AND chat_id = ?' : ''} ORDER BY inicio DESC LIMIT ?`)
      .all(...[antes, ...(chat ? [chat] : []), limite]);
    const desde = corridas.length === limite ? corridas.at(-1).inicio : 0;
    const descartes = db.prepare(`SELECT seq, chat_id, persona_id, remitente, cuerpo, tipo, recibido, descarte FROM mensajes
        WHERE descarte IS NOT NULL AND recibido < ? AND recibido >= ? ${chat ? 'AND chat_id = ?' : ''} ORDER BY recibido DESC LIMIT 200`)
      .all(...[antes, desde, ...(chat ? [chat] : [])]);
    const items = [
      ...corridas.map(turno),
      ...descartes.map((m) => ({
        clase: 'descarte', id: `m${m.seq}`, ts: m.recibido, chat_id: m.chat_id, chat: nombreChat(chatDe(m.chat_id), m.chat_id),
        de: nombrePersona(m.persona_id) ?? m.remitente ?? 'alguien', texto: String(m.cuerpo ?? `[${m.tipo}]`).slice(0, 200),
        motivo: MOTIVOS[m.descarte] ?? m.descarte,
      })),
    ].sort((a, b) => b.ts - a.ts);
    return c.json({ items, mas: corridas.length === limite ? corridas.at(-1).inicio : null });
  });

  // Un turno completo: qué lo despertó y cada paso (texto, herramienta con su resultado).
  app.get('/api/actividad/turnos/:id', (c) => {
    const corrida = db.prepare('SELECT * FROM corridas WHERE id = ?').get(Number(c.req.param('id')));
    if (!corrida) return c.json({ error: 'Ese turno no existe.' }, 404);
    const mensajes = qMensajes.all(corrida.id).map((m) => ({
      tipo: m.tipo, de: m.from_me ? 'vos' : nombrePersona(m.persona_id) ?? m.remitente ?? 'alguien', ts: m.recibido,
      texto: String(m.cuerpo ?? '').slice(0, m.tipo === 'evento' ? 600 : 2000),
    }));
    return c.json({ turno: turno(corrida), mensajes, pasos: nucleo.actividad.pasos(corrida.id) });
  });

  // Chats con actividad, para elegir cuál mirar.
  app.get('/api/actividad/chats', (c) => c.json({
    chats: db.prepare(`SELECT chat_id AS id, MAX(inicio) AS ultimo, COUNT(*) AS turnos FROM corridas WHERE chat_id IS NOT NULL
        GROUP BY chat_id ORDER BY ultimo DESC LIMIT 60`).all().map((x) => ({ ...x, nombre: nombreChat(chatDe(x.id), x.id) })),
  }));

  // Estado del entorno, en una franja: qué está haciendo ahora y cómo están las piezas.
  app.get('/api/actividad/estado', async (c) => {
    const enCurso = db.prepare("SELECT * FROM corridas WHERE estado = 'corriendo' ORDER BY inicio").all().map(turno);
    const disco = (() => { try { const e = nucleo.disco?.estado(); return e ? { pct: e.volumen.pct } : null; } catch { return null; } })();
    return c.json({
      enCurso,
      pausada: nucleo.motor.pausada(),
      motor: nucleo.motor.estado(),
      disco,
      trabajos: db.prepare("SELECT COUNT(*) AS n FROM trabajos WHERE estado IN ('en_cola', 'corriendo')").get().n,
      esperas: db.prepare('SELECT servicio, chat_id, vence FROM esperas ORDER BY id').all(),
      aprobaciones: db.prepare("SELECT COUNT(*) AS n FROM aprobaciones WHERE estado = 'pendiente'").get().n,
    });
  });
}
