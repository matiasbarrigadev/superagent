// Motor: una corrida a la vez por chat, espera de silencio para juntar ráfagas (45 s, máximo 3 min),
// reintentos y carta muerta, y espera cuando Claude no responde (sesión vencida o límite del plan).
// Todo avanza con tick(): en producción cada segundo; en los tests, con un reloj falso.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { esGrupo, esPanel } from '../util.mjs';
import { auditar } from '../db/index.mjs';

const SALTO = String.fromCharCode(10);
import { herramientaDeConector } from '../mcp/herramientas.mjs';

const ES_DESPERTAR_PROPIO = /^(rutina|entrada):/;

export function crearMotor({
  db, config = {}, ajustes, politica, armador, ejecutar, mcp, salida, avisos, aprobaciones, propuestas,
  archivos = null, aislamiento = null, conectores = null, repos = null, sesiones = null, waha = null, consumo = null, motores = null, preguntar = null, alFallaRutina = null, reloj = () => Date.now(), log = console,
}) {
  const pendientes = new Map(); // chatId → { primero, listoEn }
  const corriendo = new Set();
  const trabajosCorriendo = new Set();
  const enVuelo = new Set();
  let bloqueo = null; // { hasta, motivo }
  // Se guarda en la base para no repetir el aviso en cada reinicio.
  const avisado = { get: () => ajustes.bool('aviso_claude_enviado', false), set: (v) => ajustes.set('aviso_claude_enviado', v ? '1' : '0') };
  const alTick = [];
  const avisoPausa = new Map(); // chat → última vez que se le avisó que el agente está en pausa

  const pausada = () => db.prepare('SELECT estado FROM cuentas WHERE id = 1').get()?.estado === 'pausada';

  /** Pausa (kill switch): no se despiertan corridas, se cortan las activas y quien escribe recibe un mensaje fijo. */
  function pausar(quien = null) {
    db.prepare("UPDATE cuentas SET estado = 'pausada' WHERE id = 1").run();
    if (aislamiento) {
      const claves = [...corriendo].map((c) => (c.startsWith('sesion:') ? c : `chat:${c}`)).concat([...trabajosCorriendo].map((t) => `trabajo:${t}`), ['propietario']);
      for (const c of claves) { try { aislamiento.matarProcesos(aislamiento.usuarioDe(c)); } catch {} }
    }
    pendientes.clear();
    auditar(db, 'pausa', { actor: String(quien ?? ''), rol: 'Propietario' });
    avisos.alPropietario('Superagent quedó en pausa: no se procesa nada hasta que lo reanudes (panel o "reanudá" por WhatsApp).', { tipo: 'aviso', whatsapp: false });
  }
  function reanudar(quien = null) {
    db.prepare("UPDATE cuentas SET estado = 'activa' WHERE id = 1").run();
    avisoPausa.clear();
    auditar(db, 'reanudar', { actor: String(quien ?? ''), rol: 'Propietario' });
    return recuperar();
  }

  const marcar = (seqs, estado) => {
    if (!seqs.length) return;
    const st = db.prepare('UPDATE mensajes SET procesado = ? WHERE seq = ?');
    for (const s of seqs) st.run(estado, s);
  };

  function programar(chatId, ahora, espera) {
    const silencioMax = ajustes.num('espera_maxima_s', 180) * 1000;
    const p = pendientes.get(chatId) ?? { primero: ahora };
    p.listoEn = Math.min(ahora + espera, p.primero + silencioMax);
    pendientes.set(chatId, p);
  }

  function lanzar(promesa) {
    const p = promesa.catch((e) => log.error('[motor]', e)).finally(() => enVuelo.delete(p));
    enVuelo.add(p);
    return p;
  }

  // --- Comandos del Propietario desde su número: "dale A-3", "no A-3 porque…", "confirmo P-2", "descarto P-2".
  const RE_SI = /^\s*(dale|s[ií]|ok|apruebo|aprobad[oa]|confirmo|confirmad[oa])\s+([AP])-?(\d+)\s*[.!]*\s*$/i;
  const RE_NO = /^\s*(no|rechazo|rechazad[oa]|descarto|descartad[oa])\s+([AP])-?(\d+)\b[\s:,.-]*([\s\S]*)$/i;

  /** Reconoce el comando y lo ejecuta en segundo plano (una aprobación puede publicar: no se frena el webhook). */
  const RE_PAUSA = /^\s*(paus[aá]|pausar)\s+todo\s*[.!]*\s*$/i;
  const RE_REANUDAR = /^\s*(reanud[aá]|reanudar|seguí|segui)(\s+todo)?\s*[.!]*\s*$/i;

  function comandoPropietario(m) {
    const t = String(m.cuerpo ?? '');
    if (RE_PAUSA.test(t) || RE_REANUDAR.test(t)) {
      const p = db.prepare('SELECT * FROM personas WHERE id = ?').get(m.personaId);
      const esDueño = p && politica.para({ personaId: p.id }).decidir('aprobar').decision === 'permitir' && (esPanel(m.chatId) || (p.verificada && !m.grupo));
      if (!esDueño) return false;
      marcar([m.seq], 1);
      if (RE_PAUSA.test(t)) pausar(p.id); else reanudar(p.id);
      salida.encolar({ chatId: m.chatId, texto: RE_PAUSA.test(t) ? 'Listo: quedó todo en pausa. Escribí "reanudá" para seguir.' : 'Listo: sigo. Proceso lo que quedó en cola.', origen: 'comando' });
      salida.procesar().catch(() => {});
      return true;
    }
    const si = RE_SI.exec(t), no = si ? null : RE_NO.exec(t);
    if (!si && !no) return false;
    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(m.personaId);
    if (!persona) return false;
    const rol = politica.rolDe(persona.id, 1);
    const esDueño = politica.para({ personaId: persona.id }).decidir('aprobar').decision === 'permitir';
    // Solo cuenta desde el número verificado del Propietario (o desde el panel, que ya pidió login).
    if (!esDueño || (!esPanel(m.chatId) && (!persona.verificada || m.grupo))) return false;
    const letra = (si ?? no)[2].toUpperCase(), id = `${letra}-${(si ?? no)[3]}`;
    const actor = { personaId: persona.id, permisos: rol.permisos };
    marcar([m.seq], 1);
    lanzar((async () => {
      let respuesta;
      try {
        if (letra === 'A') {
          const a = si ? await aprobaciones.aprobar(id, { personaId: persona.id, donde: 'whatsapp' }) : await aprobaciones.rechazar(id, { personaId: persona.id, donde: 'whatsapp', comentario: no[4]?.trim() || null });
          respuesta = `Listo: ${a.id} ${a.estado}.${a.resultado ? ` ${a.resultado}` : ''}`;
        } else {
          const p = si ? propuestas.confirmar(id, actor, { donde: 'whatsapp' }) : propuestas.descartar(id, actor, { donde: 'whatsapp' });
          respuesta = `Listo: ${p.id} ${p.estado}.`;
        }
      } catch (e) {
        respuesta = e.message;
      }
      salida.encolar({ chatId: m.chatId, texto: respuesta, origen: 'comando' });
      salida.procesar().catch(() => {});
    })());
    return true;
  }

  // "activá este grupo" / "desactivá este grupo", dentro del grupo. Solo el Propietario, desde su número verificado.
  const RE_GRUPO = /^\s*(?:@\S+\s+)?(activ[aá]|activar|desactiv[aá]|desactivar)\s+(?:este\s+)?grupo\s*[.!]*\s*$/i;

  function comandoGrupo(m) {
    const x = RE_GRUPO.exec(String(m.cuerpo ?? ''));
    if (!x) return false;
    const persona = m.personaId ? db.prepare('SELECT verificada FROM personas WHERE id = ?').get(m.personaId) : null;
    const esDueño = persona?.verificada && politica.para({ personaId: m.personaId }).decidir('aprobar').decision === 'permitir';
    marcar([m.seq], 1);
    if (!esDueño) {
      salida.encolar({ chatId: m.chatId, texto: 'Solo el Propietario puede activar o desactivar el agente en este grupo.', origen: 'comando' });
    } else {
      const activar = !/^desactiv/i.test(x[1]);
      db.prepare('UPDATE chats SET activo = ? WHERE id = ?').run(activar ? 1 : 0, m.chatId);
      auditar(db, activar ? 'chat.activar' : 'chat.desactivar', { actor: String(m.personaId), rol: 'Propietario', detalle: { chat: m.chatId } });
      salida.encolar({ chatId: m.chatId, texto: activar ? 'Listo: estoy activo en este grupo. Leo la charla y respondo cuando es para mí (me nombran, me responden o me preguntan algo).' : 'Listo: dejo de leer este grupo.', origen: 'comando' });
    }
    salida.procesar().catch(() => {});
    return true;
  }

  /** Llega un mensaje (de WhatsApp o del panel). Decide si dispara una corrida y la programa. */
  async function alMensaje(m) {
    const ahora = reloj();
    if (m.personaId && !m.grupo && comandoPropietario(m)) return 'comando';
    if (m.grupo && comandoGrupo(m)) return 'comando';
    if (pausada()) {
      // El mensaje queda guardado (se procesa al reanudar) y se avisa con el mensaje fijo, como mucho cada 30 min.
      if (!m.grupo || m.menciona || m.responde) {
        const ultima = avisoPausa.get(m.chatId) ?? 0;
        if (ahora - ultima > 30 * 60_000) {
          avisoPausa.set(m.chatId, ahora);
          salida.encolar({ chatId: m.chatId, texto: ajustes.get('mensaje_pausa') || 'El agente está en pausa.', origen: 'pausa' });
          salida.procesar().catch(() => {});
        }
      }
      return 'pausa';
    }
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(m.chatId);
    if (!chat || !chat.activo) { marcar([m.seq], 1); return 'chat_inactivo'; }
    // Grupos: "solo menciones" ignora lo que no lo nombra; los atentos (por defecto) leen todo y deciden después.
    const atento = m.grupo && !chat.responder_solo_si_mencionan;
    if (m.grupo && !m.menciona && !m.responde && !atento) { marcar([m.seq], 1); return 'contexto'; }
    const rol = politica.rolDe(m.personaId, chat.cliente_id ?? 1);
    if (!rol.permisos.conversar) { marcar([m.seq], 1); return 'sin_conversar'; }
    const persona = m.personaId ? db.prepare('SELECT alta_manual FROM personas WHERE id = ?').get(m.personaId) : null;
    const sinAlta = !persona?.alta_manual && !esPanel(m.chatId);
    if (sinAlta && !db.prepare('SELECT responder_sin_alta FROM cuentas WHERE id = 1').get()?.responder_sin_alta) {
      marcar([m.seq], 1);
      return 'sin_alta';
    }
    // La espera de silencio junta mensajes seguidos. Con el Propietario en su chat es corta: es una charla de trabajo.
    const esDueño = !m.grupo && rol.permisos?.aprobar === true;
    const espera = esPanel(m.chatId) ? 800
      : esDueño ? Math.min(ajustes.num('espera_propietario_s', 4), ajustes.num('espera_silencio_s', 45)) * 1000
        : ajustes.num('espera_silencio_s', 45) * 1000;
    // En un grupo atento, lo que no lo nombra espera un poco más: se junta la charla antes de decidir.
    programar(m.chatId, ahora, m.grupo && !m.menciona && !m.responde ? Math.max(espera, ajustes.num('espera_grupo_s', 20) * 1000) : espera);
    return 'programado';
  }

  /** Mensaje del gateway (resultado de trabajo, rutina, entrada, aprobación) que despierta al orquestador. */
  function despertar({ chatId, personaId = null, texto, origen }) {
    if (!chatId) return null;
    const ahora = reloj();
    db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, creado) VALUES (?, ?, 1, 1, ?) ON CONFLICT(id) DO NOTHING")
      .run(chatId, esGrupo(chatId) ? 'grupo' : 'directo', ahora);
    const seq = Number(db.prepare(`INSERT INTO mensajes (session, id, chat_id, persona_id, remitente, from_me, tipo, cuerpo, ts, procesado, recibido, canal)
      VALUES ('interno', ?, ?, ?, ?, 0, 'evento', ?, ?, 0, ?, ?)`)
      .run(`evt-${crypto.randomUUID()}`, chatId, personaId, origen, String(texto).slice(0, 12_000), Math.floor(ahora / 1000), ahora, esPanel(chatId) ? 'panel' : 'whatsapp').lastInsertRowid);
    programar(chatId, ahora, 1500);
    return seq;
  }

  function sesionDe(chatId, clave) {
    return db.prepare('SELECT session_id FROM sesiones_claude WHERE chat_id = ? AND clave = ?').get(chatId, clave)?.session_id ?? null;
  }
  function guardarSesion(chatId, clave, sid) {
    db.prepare(`INSERT INTO sesiones_claude (chat_id, clave, session_id, actualizada) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, clave) DO UPDATE SET session_id = excluded.session_id, actualizada = excluded.actualizada`).run(chatId, clave, sid, reloj());
  }

  function bloquear(motivo) {
    const espera = motivo === 'limite' ? 15 * 60_000 : 5 * 60_000;
    bloqueo = { hasta: reloj() + espera, motivo };
    if (!avisado.get()) {
      avisado.set(true);
      const texto = motivo === 'limite'
        ? 'Aviso de Superagent: Claude no está respondiendo porque se alcanzó el límite del plan. Los mensajes quedan en cola y se responden cuando vuelva.'
        : motivo === 'sin_binario'
          ? 'Aviso de Superagent: no se encontró Claude Code en el servidor. Los mensajes quedan en cola.'
          : 'Aviso de Superagent: la cuenta de Claude no está conectada o venció. Entrá al panel → Claude → Conectar. Los mensajes quedan en cola.';
      avisos.alPropietario(texto, { tipo: 'error' });
    }
    log.warn(`[motor] Claude no responde (${motivo}); se reintenta en ${Math.round(espera / 60_000)} min`);
  }

  function avisarMotor(motor, motivo, error) {
    const clave = `aviso_motor:${motor}:${motivo}`;
    const previo = Number(ajustes.get(clave)) || 0;
    if (reloj() - previo < 6 * 3_600_000) return;
    ajustes.set(clave, String(reloj()));
    if (motivo === 'respaldo') {
      avisos.alPropietario(`Aviso de Superagent: respaldo de motores. ${String(error ?? '').slice(0, 300)}. Se vuelve al motor de siempre solo, cuando se recupere.`, { tipo: 'aviso' });
      return;
    }
    if (motivo === 'tope') {
      avisos.alPropietario(`Aviso de Superagent: tope de gasto. ${String(error ?? '').slice(0, 300)} Las charlas que usan ese motor esperan hasta que se renueve el tope o lo subas (decímelo o cambialo en el panel → Motores).`, { tipo: 'error' });
      return;
    }
    const que = motivo === 'limite' ? 'se quedó sin crédito o llegó a su límite' : motivo === 'sin_binario' ? 'no está instalado en el servidor' : 'no tiene la clave o la clave no funciona';
    avisos.alPropietario(`Aviso de Superagent: el motor ${motor} ${que}. Las charlas que corren con él quedan en espera y se reintentan cada 15 minutos (podés pedirme que use otro motor o configurar un respaldo). Detalle: ${String(error ?? '').slice(0, 300)}`, { tipo: 'error' });
    log.warn(`[motor] ${motor} no responde (${motivo})`);
  }

  /** Una corrida completa: armado, MCP con token propio, ejecución y estado de los mensajes. */
  async function correr({ tipo, chatId, personaId, mensajes = [], trabajo = null, rutina = null, origen = null, buzon = [], chatOrigen = null }) {
    const seqs = mensajes.map((m) => m.seq);
    marcar(seqs, 2);
    const spec = armador.armar({ tipo, chatId, personaId, mensajes, trabajo, rutina, origen, buzon });
    // Motor de esta corrida (lo elige el Propietario por tipo). Las sesiones no se cruzan entre motores.
    const claveBase = spec.clave, modeloBase = spec.modelo;
    const aplicarMotor = (e) => {
      spec.motor = e.motor;
      spec.modelo = e.modelo || modeloBase;
      spec.clave = e.familia !== 'claude' ? `${e.familia}:${claveBase}` : claveBase;
      if (e.nota) log.info?.(`[motor] ${e.nota}`);
    };
    if (motores) {
      const e = motores.elegir(spec);
      // Todos los motores posibles pasaron su tope de gasto: no se corre; esa charla espera y se avisa.
      if (e.detener) {
        marcar(seqs, 0);
        avisarMotor(e.motor, 'tope', e.detener);
        if (chatId && seqs.length) programar(chatId, reloj(), 60 * 60_000);
        return { r: { ok: false, tipoError: 'tope', error: e.detener, herramientas: [] }, ctx: null, spec, corridaId: null };
      }
      aplicarMotor(e);
      if (e.respaldo) avisarMotor(e.motor, 'respaldo', e.nota);
    }
    const chat = chatId ? db.prepare('SELECT proyecto_id FROM chats WHERE id = ?').get(chatId) : null;
    // Si sigue una charla y sus herramientas cambiaron desde la última corrida (cambió el rol o sus conectores),
    // se le dice: así no se queda con lo que creía tener o no tener.
    if (chatId && tipo !== 'trabajo' && sesionDe(chatId, spec.clave)) {
      const ant = db.prepare("SELECT herramientas FROM corridas WHERE chat_id = ? AND estado = 'ok' ORDER BY id DESC LIMIT 1").get(chatId);
      let previo = null;
      try { previo = ant?.herramientas ? JSON.parse(ant.herramientas) : null; } catch {}
      if (previo) {
        const ahora = new Set([...(spec.herramientasClaude ?? []), ...(spec.herramientasGateway ?? [])]);
        const antes = new Set([...(previo.claude ?? []), ...(previo.gateway ?? [])]);
        const nuevas = [...ahora].filter((h) => !antes.has(h)), fuera = [...antes].filter((h) => !ahora.has(h));
        if (nuevas.length || fuera.length) {
          spec.prompt = `(gateway) Tus herramientas cambiaron desde la última vez en esta charla.${nuevas.length ? ` Ahora tenés: ${nuevas.slice(0, 40).join(', ')}.` : ''}${fuera.length ? ` Ya no tenés: ${fuera.slice(0, 40).join(', ')}.` : ''} Lo que hayas dicho antes sobre tener o no tener algo ya no vale: guiate por esto.\n\n${spec.prompt}`;
        }
      }
    }
    const corridaId = Number(db.prepare(`INSERT INTO corridas (tipo, chat_id, persona_id, persona_origen, rol, credencial_usada, modelo, esfuerzo,
        trabajo_id, estado, inicio, canal, origen, cliente_id, herramientas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'corriendo', ?, ?, ?, ?, ?)`)
      .run(tipo, chatId ?? null, personaId ?? null, trabajo?.pedido_por ?? personaId ?? null, spec.rol.nombre, spec.motor ?? 'claude', spec.modelo, spec.esfuerzo,
        trabajo?.id ?? null, reloj(), spec.canal, origen, spec.clienteId, JSON.stringify({ claude: spec.herramientasClaude, gateway: spec.herramientasGateway }))
      .lastInsertRowid);
    for (const s of seqs) db.prepare('UPDATE mensajes SET corrida_id = ? WHERE seq = ?').run(corridaId, s);

    const ctx = {
      corridaId, tipo, variante: spec.variante, completo: !!spec.completo, chatId, canal: spec.canal, personaId,
      personaOrigen: trabajo?.pedido_por ?? personaId, rol: spec.rol, clienteId: spec.clienteId, proyectoId: chat?.proyecto_id ?? null,
      decidir: spec.decidir, herramientasGateway: spec.herramientasGateway, destinos: spec.destinos, origen, llamadas: [],
      rutas: spec.rutas, usuario: aislamiento && spec.claveAislamiento ? aislamiento.usuarioDe(spec.claveAislamiento) : null,
      trabajo: trabajo ? { id: trabajo.id, proyecto_id: trabajo.proyecto_id ?? null, rama: trabajo.rama ?? null } : null,
      chatOrigen,
      dinamicas: (spec.dinamicas ?? []).map((d) => herramientaDeConector(d, { conectores, aprobaciones })),
    };
    // Un trabajo con proyecto recibe su clon del repo, en su carpeta y con su usuario, antes de arrancar.
    if (trabajo?.proyecto_id && trabajo?.rama && repos) spec.preparar = (lugar) => repos.prepararClon(trabajo.proyecto_id, lugar, trabajo.rama);
    const token = mcp.registrar(ctx);
    spec.mcp = { url: config.mcpUrl ?? 'http://127.0.0.1:8081/mcp', token };

    const conEscribiendo = tipo === 'orquestador' && spec.canal === 'whatsapp' && waha?.escribiendo && mensajes.some((m) => m.tipo !== 'evento');
    let refresco = null;
    if (conEscribiendo) {
      waha.escribiendo(chatId, true);
      refresco = setInterval(() => waha.escribiendo(chatId, true), 20_000);
      refresco.unref?.();
    }
    const timeoutMs = tipo === 'trabajo' || tipo === 'sesion' ? 60 * 60_000 : 15 * 60_000;
    let r;
    try {
      const previa = tipo === 'trabajo' ? null : sesionDe(chatId, spec.clave);
      let sid = previa ?? crypto.randomUUID();
      r = await ejecutar(spec, { sesion: sid, nueva: !previa, timeoutMs });
      // Respaldo: el motor se quedó sin plan, crédito o credencial y hay otro configurado: sigue ese, con sesión nueva.
      for (let i = 0; motores && i < 3 && !r.ok && ['limite', 'sin_sesion', 'sin_binario'].includes(r.tipoError); i++) {
        motores.bloquear(spec.motor, r.tipoError);
        const e = motores.elegir(spec);
        if (e.detener || e.motor === spec.motor) break;
        const de = spec.motor;
        aplicarMotor(e);
        avisarMotor(e.motor, 'respaldo', `${de} ${r.tipoError === 'limite' ? 'llegó a su límite' : 'no tiene credencial que funcione'}: sigo con ${e.motor}`);
        db.prepare('UPDATE corridas SET credencial_usada = ?, modelo = ? WHERE id = ?').run(spec.motor, spec.modelo, corridaId);
        const prev = tipo === 'trabajo' ? null : sesionDe(chatId, spec.clave);
        sid = prev ?? crypto.randomUUID();
        r = await ejecutar(spec, { sesion: sid, nueva: !prev, timeoutMs });
      }
      if (!r.ok && r.tipoError === 'sesion_perdida' && previa) {
        db.prepare('DELETE FROM sesiones_claude WHERE chat_id = ? AND clave = ?').run(chatId, spec.clave);
        sid = crypto.randomUUID();
        r = await ejecutar(spec, { sesion: sid, nueva: true, timeoutMs });
      }
      if (r.ok && tipo !== 'trabajo') guardarSesion(chatId, spec.clave, r.sessionId ?? sid);
      r.sessionId = r.sessionId ?? sid;
    } catch (e) {
      r = { ok: false, tipoError: 'otro', error: e.message, herramientas: [] };
    } finally {
      mcp.liberar(token);
      if (refresco) clearInterval(refresco);
      if (conEscribiendo && !ctx.respondio) waha.escribiendo(chatId, false);
    }

    db.prepare('UPDATE corridas SET estado = ?, fin = ?, error = ?, session_id_claude = ?, resultado = ?, tokens_entrada = ?, tokens_cache = ?, tokens_salida = ?, costo_usd = ?, contexto_tokens = ? WHERE id = ?')
      .run(r.ok ? 'ok' : 'error', reloj(), r.ok ? null : String(r.error ?? '').slice(0, 2000), r.sessionId ?? null, String(r.resultado ?? '').slice(0, 4000),
        r.uso?.entrada ?? null, r.uso?.cache ?? null, r.uso?.salida ?? null, r.uso?.costo ?? null, r.uso?.contexto ?? null, corridaId);
    // Contexto nuevo a pedido del agente (después de dejar en memoria lo que importa).
    if (ctx.reiniciarContexto && chatId) db.prepare('DELETE FROM sesiones_claude WHERE chat_id = ? AND clave = ?').run(chatId, spec.clave);
    // El chat del Propietario donde se trabajó último: ahí lo despiertan los avisos de su entorno.
    if (spec.completo && chatId) { ajustes.set('propietario_ultimo_chat', chatId); ajustes.set('propietario_persona', String(personaId ?? '')); }
    if (consumo && r.uso) consumo.revisar().catch(() => {});
    auditar(db, `corrida.${tipo}`, { actor: String(ctx.personaOrigen ?? ''), rol: spec.rol.nombre, decision: r.ok ? 'ok' : r.tipoError, detalle: { corridaId, llamadas: ctx.llamadas.map((l) => l.nombre), herramientas: r.herramientas } });

    if (!r.ok && tipo === 'rutina' && rutina && !pausada() && !['sin_sesion', 'limite', 'sin_binario'].includes(r.tipoError)) {
      try { alFallaRutina?.({ rutina, error: r.error }); } catch (e) { log.warn('[motor] alFallaRutina', e.message); }
    }
    if (!r.ok && pausada()) {
      // Cortada por la pausa: lo que estaba en curso vuelve a la cola sin contar como intento.
      marcar(seqs, 0);
    } else if (r.ok) {
      marcar(seqs, 1);
      if (avisado.get()) {
        avisado.set(false);
        avisos.alPropietario('Claude volvió a responder: se están procesando los mensajes en cola.', { tipo: 'aviso', whatsapp: false });
      }
      bloqueo = null;
    } else if (['sin_sesion', 'limite', 'sin_binario'].includes(r.tipoError) && spec.motor && spec.motor !== 'claude') {
      motores?.bloquear(spec.motor, r.tipoError);
      // Otro motor sin crédito o sin clave: no frena a Claude. Esa charla espera y el Propietario se entera una vez.
      marcar(seqs, 0);
      avisarMotor(spec.motor, r.tipoError, r.error);
      if (chatId && seqs.length) programar(chatId, reloj(), 15 * 60_000);
    } else if (['sin_sesion', 'limite', 'sin_binario'].includes(r.tipoError)) {
      marcar(seqs, 0);
      bloquear(r.tipoError);
      if (chatId && seqs.length) programar(chatId, reloj(), 0);
    } else if (seqs.length) {
      const intentos = Math.max(...mensajes.map((m) => (m.intentos ?? 0) + 1));
      for (const s of seqs) db.prepare('UPDATE mensajes SET intentos = ? WHERE seq = ?').run(intentos, s);
      if (intentos >= 3) {
        marcar(seqs, 3);
        avisos.alPropietario(`No pude procesar ${seqs.length} mensaje(s) del chat ${chatId} después de 3 intentos. Último error: ${String(r.error ?? '').slice(0, 300)}`, { tipo: 'error', chatOrigen: chatId });
      } else {
        marcar(seqs, 0);
        programar(chatId, reloj(), 30_000 * 4 ** (intentos - 1));
      }
    }
    salida.procesar().catch(() => {});
    return { r, ctx, spec, corridaId };
  }

  /**
   * Grupo atento: ¿los mensajes nuevos son para el agente? Lo decide el modelo más barato con la charla reciente
   * (apodos, respuestas a lo que dijo, preguntas dirigidas a él). Sin ese modelo, solo si lo nombran.
   */
  async function esParaElAgente(chatId, tanda) {
    if (!preguntar) return false;
    const nombre = ajustes.get('nombre_agente') || 'el agente';
    const apodos = String(ajustes.get('apodos_agente') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const desde = Math.min(...tanda.map((m) => m.seq));
    const previos = db.prepare(`SELECT m.from_me, m.cuerpo, m.nombre_remitente, p.nombre AS persona FROM mensajes m LEFT JOIN personas p ON p.id = m.persona_id
      WHERE m.chat_id = ? AND m.seq < ? AND m.tipo != 'evento' ORDER BY m.seq DESC LIMIT 15`).all(chatId, desde).reverse();
    const linea = (m, nuevo = false) => `${nuevo ? '>> ' : ''}${m.from_me ? `${nombre} (el agente)` : (m.persona || m.nombre_persona || m.nombre_remitente || 'Alguien')}: ${String(m.cuerpo ?? '').slice(0, 500)}`;
    const texto = [`Charla reciente del grupo:`, previos.map((m) => linea(m)).join(SALTO) || '(nada)', '', 'Mensajes nuevos:', tanda.map((m) => linea(m, true)).join(SALTO)].join(SALTO);
    const sistema = `Sos un filtro para un agente de WhatsApp que está en un grupo. El agente se llama ${nombre}${apodos.length ? ` (también le dicen ${apodos.join(', ')})` : ''}. `
      + 'Decidí si los mensajes nuevos (los que empiezan con >>) le hablan al agente o esperan que el agente conteste: lo llaman por un apodo o diminutivo, '
      + 'siguen una charla con él, responden a algo que dijo, o es una pregunta o pedido dirigido a él. Si la charla es entre personas y no lo involucra, '
      + 'o es solo un saludo general, la respuesta es NO. Contestá solo SI o NO.';
    const r = await preguntar({ sistema, texto });
    const si = /^\s*s[ií]/i.test(r ?? '');
    log.info?.(`[motor] grupo ${chatId}: ¿es para el agente? ${r ?? '(sin respuesta)'}`);
    return si;
  }

  async function correrChat(chatId) {
    corriendo.add(chatId);
    try {
      const filas = db.prepare(`SELECT m.*, p.nombre AS nombre_persona FROM mensajes m LEFT JOIN personas p ON p.id = m.persona_id
        WHERE m.chat_id = ? AND m.procesado = 0 AND m.from_me = 0 ORDER BY m.seq`).all(chatId);
      if (!filas.length) return;
      const primero = filas[0];
      const propio = (f) => f.tipo === 'evento' && ES_DESPERTAR_PROPIO.test(f.remitente ?? '');
      // Una tanda = una persona; las rutinas y entradas corren solas.
      const tanda = propio(primero) ? [primero] : filas.filter((f) => f.persona_id === primero.persona_id && !propio(f));
      // Si llegó un adjunto, se espera a que el gateway lo pase a texto (como mucho 3 minutos).
      const ahora = reloj();
      const adjuntoPendiente = tanda.some((m) => m.tiene_adjunto && ahora - m.recibido < 180_000
        && (db.prepare('SELECT procesado FROM adjuntos WHERE mensaje_seq = ?').get(m.seq)?.procesado ?? 0) === 0);
      if (adjuntoPendiente) { programar(chatId, ahora, 5000); return; }
      const origen = propio(primero) ? primero.remitente : null;
      // Grupo atento: si nadie lo nombró, un filtro rápido decide si la charla es para el agente.
      if (!origen && esGrupo(chatId) && !tanda.some((m) => m.menciona || m.responde_al_agente)) {
        const para = await esParaElAgente(chatId, tanda);
        if (!para) {
          marcar(tanda.map((m) => m.seq), 1);
          if (filas.length > tanda.length) programar(chatId, reloj(), 0);
          return;
        }
      }
      const tipo = origen?.startsWith('rutina:') ? 'rutina' : 'orquestador';
      const rutina = tipo === 'rutina' ? db.prepare('SELECT * FROM rutinas WHERE id = ?').get(Number(origen.split(':')[1])) : null;
      await correr({ tipo, chatId, personaId: primero.persona_id, mensajes: tanda, rutina, origen });
      if (filas.length > tanda.length) programar(chatId, reloj(), 0);
    } finally {
      corriendo.delete(chatId);
    }
  }

  /** Lo que un trabajo dejó en su carpeta de salida pasa a ser un archivo F-n del chat (leído con el usuario del trabajo). */
  function recogerArchivos(t, ctx) {
    if (!archivos || !aislamiento || !ctx?.rutas?.salida || !ctx.usuario) return [];
    let nombres = [];
    try { nombres = fs.readdirSync(ctx.rutas.salida).slice(0, 10); } catch { return []; }
    const ids = [];
    for (const n of nombres) {
      try {
        const datos = aislamiento.leerComo(ctx.usuario, path.join(ctx.rutas.salida, n));
        ids.push(`F-${archivos.guardar({ chatId: t.chat_id, nombre: n, datos, origen: `trabajo:${t.id}` })} (${n})`);
      } catch (e) {
        log.warn('[motor] archivo de', t.id, n, e.message);
      }
    }
    return ids;
  }

  /** Una sesión de proyecto lee su buzón, trabaja con su --resume y le contesta al orquestador (nunca a una persona). */
  async function correrSesion(s) {
    const clave = `sesion:${s.id}`;
    corriendo.add(clave);
    try {
      const msgs = sesiones.pendientesDe(s.id).map((b) => ({ ...b, nombre_persona: b.persona_origen ? db.prepare('SELECT nombre FROM personas WHERE id = ?').get(b.persona_origen)?.nombre : null }));
      if (!msgs.length) return;
      for (const b of msgs) db.prepare("UPDATE buzon SET estado = 'leido' WHERE id = ?").run(b.id);
      const ultimo = msgs.at(-1);
      const persona = ultimo.persona_origen ?? s.persona_origen;
      const chatOrigen = ultimo.chat_origen ?? s.chat_origen;
      const p = db.prepare('SELECT cliente_id FROM proyectos WHERE id = ?').get(s.proyecto_id);
      const { r } = await correr({
        tipo: 'sesion', chatId: clave, personaId: persona, buzon: msgs, chatOrigen,
        trabajo: { id: `S-${s.id}`, numero: s.id, nombre: s.nombre, proyecto_id: s.proyecto_id, rama: s.rama, cliente_id: p?.cliente_id ?? 1, pedido_por: persona },
      });
      db.prepare('UPDATE sesiones_proyecto SET ultima_actividad = ? WHERE id = ?').run(reloj(), s.id);
      if (r.ok) {
        sesiones.escribir(s.id, { de: 'sesion', tipo: 'respuesta', contenido: r.resultado || '(sin respuesta)', personaOrigen: persona, chatOrigen, respuestaA: ultimo.id });
        despertar({ chatId: chatOrigen, personaId: persona, texto: `[S-${s.id} ${s.nombre} respondió] ${String(r.resultado ?? '').slice(0, 6000)}`, origen: `sesion:${s.id}` });
      } else if (pausada() || ['sin_sesion', 'limite', 'sin_binario', 'tope'].includes(r.tipoError)) {
        for (const b of msgs) db.prepare("UPDATE buzon SET estado = 'pendiente' WHERE id = ?").run(b.id);
      } else {
        despertar({ chatId: chatOrigen, personaId: persona, texto: `[S-${s.id} falló] ${String(r.error ?? '').slice(0, 1000)}`, origen: `sesion:${s.id}` });
      }
    } finally {
      corriendo.delete(clave);
    }
  }

  async function correrTrabajo(t) {
    trabajosCorriendo.add(t.id);
    try {
      db.prepare("UPDATE trabajos SET estado = 'corriendo', inicio = ? WHERE id = ?").run(reloj(), t.id);
      const { r, ctx } = await correr({ tipo: 'trabajo', chatId: t.chat_id, personaId: t.pedido_por, trabajo: t });
      if (r.ok) {
        db.prepare("UPDATE trabajos SET estado = 'terminado', fin = ?, resultado = ? WHERE id = ?").run(reloj(), String(r.resultado ?? '').slice(0, 20_000), t.id);
        const listos = recogerArchivos(t, ctx);
        despertar({ chatId: t.chat_id, personaId: t.pedido_por, texto: `[${t.id} terminado] ${String(r.resultado ?? '(sin informe)').slice(0, 6000)}${listos.length ? `
Archivos listos para mandar con enviar_archivo: ${listos.join(', ')}` : ''}`, origen: `trabajo:${t.id}` });
      } else if (pausada() || ['sin_sesion', 'limite', 'sin_binario', 'tope'].includes(r.tipoError)) {
        db.prepare("UPDATE trabajos SET estado = 'en_cola' WHERE id = ?").run(t.id);
      } else {
        db.prepare("UPDATE trabajos SET estado = 'fallido', fin = ?, resultado = ? WHERE id = ?").run(reloj(), String(r.error ?? '').slice(0, 4000), t.id);
        despertar({ chatId: t.chat_id, personaId: t.pedido_por, texto: `[${t.id} falló] ${String(r.error ?? '').slice(0, 1000)}`, origen: `trabajo:${t.id}` });
      }
    } finally {
      trabajosCorriendo.delete(t.id);
    }
  }

  /**
   * Avisos del entorno del Propietario: lo que deja corriendo en segundo plano escribe un archivo en ~/avisos al
   * terminar, y eso despierta al agente en el último chat donde trabajó con el Propietario.
   */
  let ultimaRevisionAvisos = 0;
  function revisarAvisosDelEntorno(ahora) {
    if (!aislamiento?.rutas || ahora - ultimaRevisionAvisos < 5000) return;
    ultimaRevisionAvisos = ahora;
    const chatId = ajustes.get('propietario_ultimo_chat');
    if (!chatId) return;
    const dir = path.join(aislamiento.rutas('propietario').base, 'avisos');
    let nombres = [];
    try { nombres = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).slice(0, 10); } catch { return; }
    if (!nombres.length) return;
    const usuario = aislamiento.usuarioDe('propietario');
    const lineas = [];
    for (const n of nombres) {
      const ruta = path.join(dir, n);
      let contenido = '';
      try { contenido = aislamiento.leerComo(usuario, ruta, 20_000).toString('utf8').trim(); } catch (e) { contenido = `(no se pudo leer: ${e.message})`; }
      try { fs.rmSync(ruta, { force: true, recursive: true }); } catch {}
      lineas.push(`[aviso de tu entorno: ${n}] ${contenido.slice(0, 4000) || '(terminó)'}`);
    }
    despertar({ chatId, personaId: Number(ajustes.get('propietario_persona')) || null, texto: lineas.join(String.fromCharCode(10)), origen: 'entorno' });
  }

  function tick() {
    const ahora = reloj();
    if (pausada()) { salida.procesar().catch(() => {}); return; }
    revisarAvisosDelEntorno(ahora);
    for (const f of alTick) { try { f(ahora); } catch (e) { log.error('[motor] tick', e); } }
    const bloqueado = bloqueo && ahora < bloqueo.hasta;
    if (!bloqueado) {
      const maxCorridas = Math.max(1, ajustes.num('max_corridas', 3));
      for (const [chatId, p] of pendientes) {
        if (p.listoEn > ahora || corriendo.has(chatId)) continue;
        if (corriendo.size >= maxCorridas) break;
        pendientes.delete(chatId);
        lanzar(correrChat(chatId));
      }
      // Trabajos en segundo plano: un límite de concurrencia (no de gasto) para no agotar el plan de Claude.
      // Sesiones de proyecto con mensajes en el buzón (las pausadas no se despiertan).
      if (sesiones) {
        for (const s of sesiones.conPendientes()) {
          if (corriendo.has(`sesion:${s.id}`) || corriendo.size >= maxCorridas) continue;
          corriendo.add(`sesion:${s.id}`);
          lanzar(correrSesion(s));
        }
      }
      const maxTrabajos = Math.max(1, ajustes.num('max_trabajos', 2));
      while (trabajosCorriendo.size < maxTrabajos) {
        const t = db.prepare("SELECT * FROM trabajos WHERE estado = 'en_cola' ORDER BY numero LIMIT 1").get();
        if (!t || trabajosCorriendo.has(t.id)) break;
        trabajosCorriendo.add(t.id);
        lanzar(correrTrabajo(t));
      }
    }
    salida.procesar().catch(() => {});
  }

  /** Al arrancar: lo que quedó a medias vuelve a la cola. */
  function recuperar() {
    db.prepare('UPDATE mensajes SET procesado = 0 WHERE procesado = 2').run();
    db.prepare("UPDATE trabajos SET estado = 'en_cola' WHERE estado = 'corriendo'").run();
    db.prepare("UPDATE corridas SET estado = 'interrumpida', fin = ? WHERE estado = 'corriendo'").run(reloj());
    const chats = db.prepare('SELECT DISTINCT chat_id FROM mensajes WHERE procesado = 0 AND from_me = 0').all();
    for (const c of chats) programar(c.chat_id, reloj(), 2000);
    return chats.length;
  }

  /** Para los tests: espera a que terminen las corridas en vuelo. */
  async function esperar() {
    while (enVuelo.size) await Promise.all([...enVuelo]);
  }

  return {
    alMensaje, despertar, tick, recuperar, esperar, correr, programar,
    alCadaTick: (f) => alTick.push(f),
    pausar, reanudar, pausada,
    /** Al reconectar Claude: la cola se destraba sin esperar el reintento. */
    desbloquear: () => { if (bloqueo) bloqueo.hasta = 0; },
    estado: () => ({ pendientes: pendientes.size, corriendo: corriendo.size, trabajos: trabajosCorriendo.size, bloqueo }),
    corriendoEn: (chatId) => corriendo.has(chatId) || pendientes.has(chatId),
  };
}
