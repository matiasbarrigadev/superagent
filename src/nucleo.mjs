// Arma el núcleo: política, roles, memoria, salida, avisos, aprobaciones, propuestas, MCP, motor,
// rutinas, entradas e ingesta. Lo usan el servidor y los tests (con dobles de WAHA y de Claude).
import path from 'node:path';
import { crearAjustes, esPanel } from './util.mjs';
import { auditar } from './db/index.mjs';
import { zonaValida } from './rutinas/cron.mjs';
import { unificarChatsLid, repararChatPropio } from './wa/unificar.mjs';
import { normalizarJid } from './wa/webhook.mjs';
import { crearEntorno } from './servicios/entorno.mjs';
import { crearApps } from './servicios/apps.mjs';
import { sincronizarGrupos } from './wa/grupos.mjs';
import { crearBitacora } from './servicios/bitacora.mjs';
import { crearConsumo } from './servicios/consumo.mjs';
import { crearLoginsDelEntorno } from './claude/logins.mjs';
import { crearPolitica } from './roles/politica.mjs';
import { crearRoles } from './roles/servicio.mjs';
import { crearPaquetes } from './servicios/paquetes.mjs';
import { crearMemoria } from './servicios/memoria.mjs';
import { crearAvisos } from './servicios/avisos.mjs';
import { crearAprobaciones } from './servicios/aprobaciones.mjs';
import { crearPropuestas } from './servicios/propuestas.mjs';
import { crearEntradas } from './servicios/entradas.mjs';
import { crearVerificacion } from './servicios/verificacion.mjs';
import { crearSalida } from './wa/salida.mjs';
import { crearIngesta } from './wa/webhook.mjs';
import { crearNumeros } from './wa/numeros.mjs';
import { crearHerramientas, chatDeDestino } from './mcp/herramientas.mjs';
import { crearRutinas } from './rutinas/servicio.mjs';
import { crearServidorMcp } from './mcp/servidor.mjs';
import { crearArmador } from './engine/contexto.mjs';
import { crearAdaptadorClaude } from './engine/claude.mjs';
import { crearAdaptadorOpenCode } from './engine/opencode.mjs';
import { crearAdaptadorCodex, crearCuentaCodex } from './engine/codex.mjs';
import { crearAdaptadorGemini } from './engine/gemini.mjs';
import { crearEjecutorComun } from './engine/ejecutor.mjs';
import { crearMotores } from './engine/motores.mjs';
import { crearDisco } from './servicios/disco.mjs';
import { crearMotor } from './engine/motor.mjs';
import { crearProgramador } from './rutinas/programador.mjs';
import { proxima } from './rutinas/cron.mjs';
import { crearAislamiento } from './claude/aislamiento.mjs';
import { crearArchivos } from './servicios/archivos.mjs';
import { crearProcesadorMedios } from './medios/procesador.mjs';
import { crearConectores } from './conectores/servicio.mjs';
import { crearGithub } from './codigo/github.mjs';
import { crearRepos } from './codigo/repos.mjs';
import { crearPublicador } from './codigo/publicar.mjs';
import { crearProcedimientos } from './codigo/procedimiento.mjs';
import { crearSesiones } from './codigo/sesiones.mjs';

export function crearNucleo({ dormir = undefined, correrPasos = undefined, fetchVerificacion = undefined, fetchGithub = undefined, gitRepos = undefined, fetchConectores = undefined, db, config, waha, crearClienteWa = null, cuentaClaude = null, ejecutar = null, aislamiento = null, correrMedios = undefined, reloj = () => Date.now(), version = '0.0.0', log = console, alCambiarEstado = () => {} }) {
  const ajustes = crearAjustes(db);
  // Primera vez: la zona horaria sale de TZ del contenedor (la del template), si nadie la eligió todavía.
  const tz = process.env.TZ;
  if (tz && tz !== 'UTC' && zonaValida(tz) && ajustes.get('zona_horaria') === 'UTC' && !ajustes.get('zona_horaria_inicial')) {
    ajustes.set('zona_horaria', tz);
    ajustes.set('zona_horaria_inicial', '1');
  }
  unificarChatsLid(db, log);
  const politica = crearPolitica(db);
  const roles = crearRoles({ db, politica });
  const memoria = crearMemoria(db);
  const entorno = crearEntorno({ db, config, reloj });
  const bitacora = crearBitacora({ db, reloj });
  const rutinas = crearRutinas({ db, bitacora, chatDeDestino, reloj });
  const archivos = crearArchivos({ db, config, reloj });
  // Números de WhatsApp (sesiones de WAHA) con su política; el principal es `waha`.
  const numeros = crearNumeros({ db, principal: waha, nombrePrincipal: config.waha?.session ?? 'default', crearCliente: crearClienteWa, bitacora, reloj, log });
  const salida = crearSalida({ db, waha, numeros, ajustes, archivos, dormir, reloj, log });
  // "Escribiendo…" por el número que corresponde al chat (y solo si ese número puede enviar ahí).
  const waRuteado = {
    ...waha,
    escribiendo: (chatId, prendido) => {
      const s = numeros.sesionPara(chatId);
      if (!numeros.puedeEnviar(s, chatId).ok) return undefined;
      return numeros.cliente(s).escribiendo?.(chatId, prendido);
    },
  };
  const avisos = crearAvisos({ db, salida, log });
  const consumo = crearConsumo({ db, ajustes, politica, salida, avisos, plan: () => (cuentaClaude?.usoPlan ? cuentaClaude.usoPlan() : null), reloj, log });
  const ais = aislamiento ?? crearAislamiento({ db, config, log });
  const logins = crearLoginsDelEntorno({ aislamiento: ais });
  const github = crearGithub({ db, config, salida, tokenRespaldo: () => logins.tokenGithub(), ...(fetchGithub ? { fetch: fetchGithub } : {}), reloj, log });
  const repos = crearRepos({ db, config, aislamiento: ais, github, ...(gitRepos ? { git: gitRepos } : {}), log });
  const procedimientos = crearProcedimientos({ db, config, aislamiento: ais, repos, ...(correrPasos ? { correr: correrPasos } : {}), ...(fetchVerificacion ? { fetch: fetchVerificacion } : {}), reloj, log });
  const publicador = crearPublicador({ db, repos, github, procedimientos });
  /**
   * El agente le cuenta algo a cada Propietario verificado, en su chat y con sus palabras (como un colaborador),
   * en vez de un aviso con formato de sistema. Devuelve a cuántos despertó.
   */
  function despertarPropietarios({ texto, origen, excepto = null }) {
    if (!ref.motor) return 0;
    const duenos = db.prepare(`SELECT p.id, p.telefono FROM personas p JOIN roles r ON r.id = p.rol_id
      WHERE r.nombre = 'Propietario' AND r.predefinido = 1 AND p.activa = 1 AND p.verificada = 1 AND p.telefono IS NOT NULL`).all()
      .filter((d) => d.id !== excepto);
    for (const d of duenos) ref.motor.despertar({ chatId: `${d.telefono}@c.us`, personaId: d.id, origen, texto });
    return duenos.length;
  }
  const nombreDe = (id) => { const p = id ? db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?').get(id) : null; return p ? (p.nombre ?? `+${p.telefono}`) : 'alguien'; };

  const conectores = crearConectores({ db, config, salida,
    // Un conector que pierde la autorización no se queda callado: el agente avisa y ofrece reconectarlo.
    alCaer: (c) => {
      avisos.alPropietario(`El conector ${c.app} perdió la autorización.`, { tipo: 'aviso', whatsapp: false });
      despertarPropietarios({ origen: `conector:${c.id}`, texto: `[conector ${c.app} sin autorización] El conector ${c.app} (id ${c.id}) dejó de aceptar la autorización: sus herramientas no andan hasta reconectarlo. Avisale al Propietario y ofrecele el link (panel POST /api/conectores/${c.id}/autorizar).` });
    }, ...(fetchConectores ? { fetch: fetchConectores } : {}), reloj, log });
  const ref = { motor: null, sesiones: null };
  const sesiones = crearSesiones({ db, reloj });
  ref.sesiones = sesiones;

  /** Chat donde se le habla a una persona: su WhatsApp verificado (o dado de alta) o, si entra al panel, el chat del panel. */
  function chatDePersona(personaId) {
    const p = personaId ? db.prepare('SELECT id, telefono, verificada, alta_manual FROM personas WHERE id = ?').get(personaId) : null;
    if (!p) return null;
    const panel = db.prepare('SELECT 1 FROM usuarios_web WHERE persona_id = ?').get(p.id);
    if (p.telefono && (p.verificada || (p.alta_manual && !panel))) return `${p.telefono}@c.us`;
    return panel ? `panel:${p.id}` : null;
  }

  const aprobaciones = crearAprobaciones({ bitacora,
    db, avisos, salida, config, reloj, log,
    ejecutores: {
      conector: async ({ conexionId, herramienta, args }) => {
        const r = await conectores.llamar(conexionId, herramienta, args);
        return `${r.esError ? 'El conector devolvió un error' : 'Resultado'}: ${r.texto.slice(0, 2000)}`;
      },
      memoria: (d) => memoria.guardar(d),
      rutina: ({ rutinaId }) => {
        const r = db.prepare('SELECT * FROM rutinas WHERE id = ?').get(rutinaId);
        if (!r) throw new Error('La rutina ya no existe.');
        db.prepare('UPDATE rutinas SET activa = 1, aprobada = 1, proxima = ? WHERE id = ?').run(proxima(r.cuando, r.zona_horaria, reloj()), r.id);
        return `Rutina R-${r.id} activa.`;
      },
      enviar: ({ chatId, texto, contactoNuevo }) => {
        salida.encolar({ chatId, texto, contactoNuevo, origen: 'aprobacion' });
        avisos.resolverConsultasDe(chatId);
        salida.procesar().catch(() => {});
        return 'Mensaje en cola.';
      },
      leccion: ({ leccionId }) => {
        db.prepare("UPDATE lecciones SET estado = 'activa' WHERE id = ? AND estado = 'propuesta'").run(leccionId);
        return `Lección L-${leccionId} activa.`;
      },
      publicar: async (d, a) => {
        if (!d.proyecto || typeof d.proyecto !== 'number') return 'Quedó aprobado, pero no hay un proyecto con repo: no se publicó nada.';
        // Si la publicación falla, la aprobación igual queda registrada y el resultado dice dónde falló.
        try { return await publicador.publicarAhora(d, { pedidaPor: a.pedida_por, aprobacionId: a.id }); } catch (e) { return e.message; }
      },
      instrucciones: ({ version }, a) => publicador.activarInstrucciones(version, a.decidida_por),
    },
    // El pedido lo cuenta el agente en el chat de cada Propietario verificado, como un colaborador: sin códigos.
    // Si al rol de quien pide le faltan conectores, el agente lo sabe antes de que el Propietario diga que sí.
    alPedir: ({ id, detalle, quien, pedidaPor }) => {
      const de = quien ? (quien.nombre ?? `+${quien.telefono}`) : 'alguien del equipo';
      let nota = '';
      if (pedidaPor) {
        const rol = politica.rolDe(pedidaPor, 1);
        const faltan = conectores.fueraDeAlcance({ rol });
        if (faltan.length) nota = ` (Ojo: el rol ${rol.nombre} no tiene ${faltan.join(', ')}. Si esto los necesita, ofrecé aprobarlo para que corra con los permisos del Propietario (decidir con como_propietario, solo rutinas) o habilitar el conector para ese rol.)`;
      }
      return despertarPropietarios({ origen: `aprobacion:${id}`, texto: `[pedido ${id}] ${de} necesita tu ok para esto: ${detalle}${nota}` });
    },
    alDecidir: (a) => {
      // A los otros Propietarios que se les preguntó: ya está resuelto, que no lo vuelvan a preguntar.
      if (a.decidida_por) despertarPropietarios({ origen: `aprobacion:${a.id}`, excepto: a.decidida_por, texto: `[${a.id} ${a.estado} por ${nombreDe(a.decidida_por)}] ${a.detalle}` });
      if (!a.chat_origen) return;
      ref.motor.despertar({
        chatId: a.chat_origen, personaId: a.pedida_por, origen: `aprobacion:${a.id}`,
        texto: `[${a.id} ${a.estado}] ${a.detalle}${a.comentario ? ` — comentario del Propietario: ${a.comentario}` : ''}${a.resultado ? ` — ${a.resultado}` : ''}`,
      });
    },
  });

  const propuestas = crearPropuestas({ bitacora,
    db, roles,
    aplicadores: {
      // Cliente nuevo (7e): se crea y, si vino de un grupo, el grupo pasa a ese cliente.
      cliente: (d, actor) => {
        const id = Number(db.prepare("INSERT INTO clientes (nombre, tipo, autonomia, estado, creado_por) VALUES (?, 'cliente', ?, 'activo', ?)")
          .run(d.nombre, d.autonomia ?? 'consultar_lo_importante', actor.personaId ?? null).lastInsertRowid);
        if (d.chat_id) db.prepare('UPDATE chats SET cliente_id = ? WHERE id = ?').run(id, d.chat_id);
        return id;
      },
      sesion: (d) => ref.sesiones.crear(d),
    },
    alDecidir: (p) => {
      if (!p.chat_origen || esPanel(p.chat_origen)) return;
      const persona = db.prepare('SELECT persona_origen FROM propuestas WHERE id = ?').get(Number(p.id.slice(2)))?.persona_origen ?? null;
      const que = { rol: `rol "${p.datos.nombre}"`, persona: `${p.datos.nombre} como ${p.datos.rol}`, cliente: `cliente "${p.datos.nombre}"`, sesion: `sesión de proyecto "${p.datos.nombre}"` }[p.tipo];
      ref.motor.despertar({ chatId: p.chat_origen, personaId: persona, origen: `propuesta:${p.id}`, texto: `[${p.id} ${p.estado}] ${que}` });
    },
  });

  // Apps del agente publicadas en /apps/<nombre>/ (el proxy está en server.mjs).
  const apps = crearApps({ db, config, aislamiento: ais, entorno, pausada: () => db.prepare('SELECT estado FROM cuentas WHERE id = 1').get()?.estado === 'pausada', reloj, log });
  const paquetes = crearPaquetes({ db, roles, memoria, numeros, entorno, procedimientos, ajustes, reloj });
  // Motores: Claude (suscripción o clave de API), Codex (ChatGPT o clave), Gemini y OpenCode (otros proveedores).
  // Cada corrida elige el suyo.
  const cuentaCodex = crearCuentaCodex({ config, ajustes, bin: config.codex?.bin ?? 'codex', log });
  const adaptadores = {
    claude: crearAdaptadorClaude({ cuenta: cuentaClaude }),
    'claude-api': crearAdaptadorClaude({ cuenta: cuentaClaude, credencial: 'api' }),
    opencode: crearAdaptadorOpenCode({ bin: config.opencode?.bin ?? 'opencode', clave: (n) => entorno.valor(n), dirConfigVacio: path.join(config.dataDir ?? '.', 'opencode-config') }),
    codex: crearAdaptadorCodex({ bin: config.codex?.bin ?? 'codex', clave: (n) => entorno.valor(n), cuenta: cuentaCodex }),
    gemini: crearAdaptadorGemini({ bin: config.gemini?.bin ?? 'gemini', clave: (n) => entorno.valor(n), dirSistema: config.gemini?.dirSistema ?? path.join(config.dataDir ?? '.', 'gemini-sistema') }),
  };
  const motores = crearMotores({ ajustes, adaptadores, cuenta: cuentaClaude, reloj,
    gasto: (motor, desde) => db.prepare('SELECT COALESCE(SUM(costo_usd), 0) AS g FROM corridas WHERE credencial_usada = ? AND inicio >= ?').get(motor, desde).g });
  // Disco: limpieza automática, aviso al llenarse y lo que ve el agente para cuidar su espacio.
  const disco = config.dataDir ? crearDisco({ db, config, ajustes, aislamiento: ais, avisos, despertarPropietarios, reloj, log }) : null;
  const herramientas = crearHerramientas({ db, disco, rutinas, motores, cuentaCodex, numeros, paquetes, despertarPropietarios, panel: (o) => (ref.panel ? ref.panel(o) : Promise.reject(new Error('El panel no está disponible.'))), waha, apps, publicUrl: config.publicUrl, bitacora, consumo, salida, ajustes, memoria, entorno, avisos, aprobaciones, propuestas, archivos, aislamiento: ais, conectores, repos, github, publicador, sesiones, chatDePersona, despertarSalida: () => salida.procesar().catch(() => {}), reloj });
  const mcp = crearServidorMcp({ herramientas, version, log });
  const armador = crearArmador({ db, config, politica, ajustes, memoria, entorno, consumo, disco, rutinas, avisos, aislamiento: ais, conectores, roles, numeros });
  const ej = ejecutar ?? crearEjecutorComun({ adaptadores, aislamiento: ais, log });
  const motor = crearMotor({ db, config,
    // Una rutina que falla por algo técnico: el agente se lo cuenta a los Propietarios.
    alFallaRutina: ({ rutina, error }) => despertarPropietarios({ origen: `rutina:${rutina.id}`, texto: `[rutina R-${rutina.id} falló] ${nombreDe(rutina.creada_por)} la había pedido ("${String(rutina.instruccion).slice(0, 200)}"). Error: ${String(error ?? '').slice(0, 300)}` }), ajustes, politica, armador, ejecutar: ej, motores, mcp, salida, avisos, aprobaciones, propuestas, archivos, aislamiento: ais, conectores, repos, sesiones, waha: waRuteado, consumo, preguntar: cuentaClaude?.preguntar ? (o) => cuentaClaude.preguntar(o) : null, reloj, log });
  ref.motor = motor;
  const programador = crearProgramador({ db, politica, motor, avisos, bitacora, log });
  motor.alCadaTick((ahora) => programador.tick(ahora));
  const entradas = crearEntradas({ db, motor, chatDePersona });
  const verificacion = crearVerificacion({ db, waha, reloj });
  const medios = crearProcesadorMedios({ db, config, aislamiento: ais, cuenta: cuentaClaude, ajustes, politica, ...(correrMedios ? { correr: correrMedios } : {}), log });
  /**
   * Instalación nueva: cuando el Propietario verifica su número, el agente le escribe primero por WhatsApp y arranca
   * la configuración (nombre, para qué es, tono, personas). Una sola vez, y solo si todavía no hablaron.
   */
  function iniciarConfiguracion(personaId, { porWhatsApp = false } = {}) {
    if (ajustes.bool('onboarding_hecho', false) || ajustes.get('configuracion_iniciada')) return false;
    const p = db.prepare('SELECT telefono, verificada FROM personas WHERE id = ?').get(personaId);
    if (!p?.verificada || !p.telefono) return false;
    if (politica.para({ personaId }).decidir('aprobar').decision !== 'permitir') return false;
    // Si ya vienen hablando, no hace falta arrancar nada (salvo cuando lo que escribió fue el código de confirmación).
    if (!porWhatsApp && db.prepare("SELECT 1 FROM mensajes WHERE persona_id = ? AND from_me = 0 AND tipo != 'evento' LIMIT 1").get(personaId)) return false;
    ajustes.set('configuracion_iniciada', String(reloj()));
    ref.motor.despertar({
      chatId: `${p.telefono}@c.us`, personaId, origen: 'configuracion',
      texto: porWhatsApp
        ? '[configuración inicial] El Propietario acaba de confirmar su número respondiendo con el código: ya sabés que es él. Saludalo, presentate en una línea y empezá la configuración con la primera pregunta (tu personalidad).'
        : '[configuración inicial] El Propietario acaba de verificar su número en el panel. Escribile vos primero por acá: presentate en una línea y hacé la primera pregunta de la configuración.',
    });
    return true;
  }

  /** Con el número andando: grupos al día y lo propio en su chat. */
  function alConectar(e) {
    sincronizarGrupos(db, waha, log).catch(() => {});
    try { repararChatPropio(db, normalizarJid(e?.me?.id ?? ''), log); } catch (err) { log.warn?.('[chats] reparación', err.message); }
    // Número del Propietario cargado antes de vincular: el agente lo saluda apenas se conecta.
    verificacion.saludarPendientes().catch(() => {});
  }
  // La respuesta con el código confirma el número del Propietario y arranca la configuración.
  function alMensaje(m) {
    if (!m.grupo) {
      const dueño = verificacion.porRespuesta(m);
      if (dueño) {
        db.prepare('UPDATE mensajes SET procesado = 1 WHERE seq = ?').run(m.seq);
        auditar(db, 'persona.verificar_numero_whatsapp', { actor: String(dueño) });
        iniciarConfiguracion(dueño, { porWhatsApp: true });
        return 'verificado';
      }
    }
    return motor.alMensaje(m);
  }
  /** Un número que se vincula: se anota su teléfono y, si es nuevo, el agente le pregunta al Propietario qué hacer con él. */
  async function alVincularNumero(nombre) {
    try {
      const e = await numeros.cliente(nombre).estado();
      const nuevo = numeros.anotarNumero(nombre, e?.me);
      const f = numeros.obtener(nombre);
      if (nuevo && f && !f.principal) {
        despertarPropietarios({ origen: `numero:${nombre}`, texto: `[número nuevo vinculado] "${f.etiqueta ?? nombre}" (+${numeros.obtener(nombre).numero}) quedó vinculado y por ahora no hace nada: no lee, no guarda y no responde. Preguntale al Propietario qué quiere que hagas con este número (responder, solo leer, solo avisos; qué chats; si se guardan y cuánto tiempo; si puede escribir primero) y armá la política con configurar_sesion.` });
      }
    } catch (err) { log.warn?.('[whatsapp] número', nombre, err.message); }
  }
  const ingesta = crearIngesta({ db, waha, numeros, config, ajustes, alMensaje, alAdjunto: (id) => medios.procesar(id), alEvento: (e) => ref.motor?.despertar(e), alCambiarEstado: (estado, evt) => {
    const nombre = evt?.session ?? numeros.nombrePrincipal;
    if (estado === 'WORKING') {
      alVincularNumero(nombre);
      // Con el número principal andando, se traen los grupos aunque nadie haya escrito todavía.
      if (nombre === numeros.nombrePrincipal) waha.estado?.().then(alConectar).catch(() => {});
    }
    alCambiarEstado(estado, evt);
  }, reloj, log });

  return {
    // La API del panel (la arma app.mjs): el agente la usa en nombre del Propietario, con la herramienta panel.
    usarPanel: (fn) => { ref.panel = fn; },
    paquetes, numeros, alVincularNumero,
    apps, waha,
    ajustes, politica, roles, memoria, entorno, bitacora, consumo, salida, avisos, aprobaciones, propuestas, herramientas, mcp, armador, motor, motores, cuentaCodex, disco, rutinas,
    alConectar, iniciarConfiguracion, logins, programador, entradas, verificacion, ingesta, chatDePersona, aislamiento: ais, archivos, medios, conectores, github, repos, publicador, procedimientos, sesiones,
  };
}
