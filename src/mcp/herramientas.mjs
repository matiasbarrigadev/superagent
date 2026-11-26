// Herramientas del MCP del gateway. Cada una vuelve a mirar la política: aunque el armado ya recortó la lista,
// la decisión final se toma acá, con la persona de origen de la corrida.
import { ErrorHerramienta } from './servidor.mjs';
import { SECCIONES } from '../servicios/memoria.mjs';
import { normalizar, excesos, PERMISOS } from '../roles/permisos.mjs';
import { proxima, zonaValida } from '../rutinas/cron.mjs';
import { auditar } from '../db/index.mjs';
import { diffTexto } from '../codigo/publicar.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { soloDigitos, esGrupo, esPanel, json } from '../util.mjs';
import { sincronizarGrupos } from '../wa/grupos.mjs';
import { crearInvitacion, linkInvitacion } from '../auth/invitaciones.mjs';
import { fichaRol, fichaConector } from '../roles/ficha.mjs';
import { huellaPaquete } from '../servicios/paquetes.mjs';

const texto = (v, max = 4000) => String(v ?? '').trim().slice(0, max);

/** Teléfono o JID → chat id normalizado. */
export function chatDeDestino(destino) {
  const d = String(destino ?? '').trim();
  if (/@g\.us$|@c\.us$|@lid$/.test(d) || d.startsWith('panel:')) return d;
  const dig = soloDigitos(d);
  return dig.length >= 8 && dig.length <= 15 ? `${dig}@c.us` : null;
}

/**
 * Herramienta de un conector remoto para una corrida. Lo que escribe, pedido por alguien que no es el
 * Propietario (o con un cliente que pide consultar), pasa por aprobación; al aprobar lo ejecuta el gateway.
 */
export function herramientaDeConector(def, { conectores, aprobaciones }) {
  return {
    ...def,
    async ejecutar(ctx, args) {
      const accion = def.escribe ? 'conector_escribir' : 'conector_leer';
      let d = ctx.decidir(accion).decision;
      if (d === 'negar') throw new ErrorHerramienta('Tu rol no lo permite.');
      if (def.escribe && d === 'permitir' && ctx.decidir('aprobar').decision !== 'permitir') d = 'con_aprobacion';
      if (d === 'con_aprobacion') {
        const a = aprobaciones.pedir({
          tipo: 'conector', accion: 'conector', pedidaPor: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
          detalle: `usar ${def.descripcion.slice(1, def.descripcion.indexOf(']'))} → ${def.herramienta} con ${JSON.stringify(args).slice(0, 300)}`,
          datos: { conexionId: def.conexionId, herramienta: def.herramienta, args },
        });
        return `Pendiente de aprobación ${a}: esta acción escribe en ${def.descripcion.slice(1, def.descripcion.indexOf(']')).replace(', escribe', '')} y la tiene que aprobar el Propietario.`;
      }
      try {
        const r = await conectores.llamar(def.conexionId, def.herramienta, args);
        if (r.esError) throw new ErrorHerramienta(r.texto);
        return r.texto;
      } catch (e) {
        throw e instanceof ErrorHerramienta ? e : new ErrorHerramienta(e.message);
      }
    },
  };
}

// Lo que el agente no hace por la API del panel: la cuenta y el acceso de cada persona (logins, sesiones, contraseñas,
// invitaciones públicas), la conexión del sistema (vincular WhatsApp, Claude, tokens) y el chat del panel (es él mismo).
const PANEL_FUERA = [/^\/api\/(auth|setup|recuperar|invitacion|estado)(\/|$)/, /^\/api\/chat$/, /^\/api\/personas\/yo(\/|$)/,
  /^\/api\/claude\/(login|desconectar|terminal)/, /^\/api\/whatsapp\/(codigo|desvincular|qr)/, /^\/api\/whatsapp\/numeros\/[^/]+\/(codigo|desvincular|qr)/, /^\/api\/github\/(token|dispositivo)/];
// Los secretos se cargan con pedir_variable (link al panel): nunca pasan por el chat.
export const rutaPanelPermitida = (ruta, metodo = 'GET') => !PANEL_FUERA.some((re) => re.test(ruta)) && !(metodo === 'POST' && /^\/api\/entorno\/?$/.test(ruta))
  // Sumar o quitar un número de WhatsApp es vincular: se hace en el panel (su política, conversando).
  && !(metodo !== 'GET' && /^\/api\/whatsapp\/numeros(\/|$)/.test(ruta))
  // Los motores se cambian con configurar_motores (ficha y confirmación en otro mensaje).
  && !(metodo !== 'GET' && /^\/api\/motores(\/|$)/.test(ruta));

export function crearHerramientas({ db, motores = null, cuentaCodex = null, numeros = null, paquetes = null, despertarPropietarios = null, panel = null, waha = null, apps = null, publicUrl = null, bitacora = null, consumo = null, salida, ajustes, memoria, entorno = null, avisos, aprobaciones, propuestas, archivos = null, aislamiento = null, conectores = null, repos = null, github = null, publicador = null, sesiones = null, chatDePersona = () => null, despertarSalida = () => {}, reloj = () => Date.now() }) {
  const publicarAhora = (d, o) => publicador.publicarAhora(d, o);
  const activarInstrucciones = (v, quien) => publicador.activarInstrucciones(v, quien);
  const politicaDe = (ctx, accion) => {
    const r = ctx.decidir(accion);
    auditar(db, `mcp.${accion}`, { actor: String(ctx.personaOrigen ?? ctx.personaId ?? ''), rol: ctx.rol?.nombre, decision: r.decision, detalle: { corrida: ctx.corridaId } });
    return r;
  };
  const exigir = (ctx, accion) => {
    const r = politicaDe(ctx, accion);
    if (r.decision === 'negar') throw new ErrorHerramienta(r.motivo ?? 'Tu rol no lo permite.');
    // Con el Propietario en su charla, el ok está en el diálogo: no hay A-n ni tarjetas.
    if (ctx.completo && r.decision === 'con_aprobacion') {
      bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'hecho', que: `${accion.replace(/_/g, ' ')}: lo pidió el Propietario en la charla (sin aprobación aparte)`, ref: accion });
      return 'permitir';
    }
    return r.decision;
  };
  /** Con el Propietario en su charla, lo propuesto se aplica en el momento. Devuelve el texto de "hecho" o null. */
  // Fichas de roles y conectores que el agente ya le mostró al Propietario (para aplicar recién cuando confirma).
  const fichasMostradas = new Map();
  /** Ficha del cambio que se pide por la API del panel (roles y conectores), con lo que quedaría. */
  function fichaDeCambio(metodo, camino, cuerpo) {
    const rolId = /^\/api\/roles\/(\d+)$/.exec(camino)?.[1];
    const conId = /^\/api\/conectores\/(\d+)/.exec(camino)?.[1];
    if (camino === '/api/roles' && metodo === 'POST') return fichaRol(db, { nombre: texto(cuerpo.nombre, 40), descripcion: cuerpo.descripcion, permisos: cuerpo.permisos });
    if (rolId) {
      const actual = db.prepare('SELECT nombre, descripcion, permisos FROM roles WHERE id = ?').get(Number(rolId));
      if (!actual) return 'Ese rol no existe.';
      if (metodo === 'DELETE') return `Se borra el rol "${actual.nombre}". Así estaba:\n${fichaRol(db, actual)}`;
      const permisos = { ...normalizar(actual.permisos), ...(cuerpo.permisos ?? {}) };
      return `Antes:\n${fichaRol(db, actual)}\nDespués:\n${fichaRol(db, { nombre: cuerpo.nombre ?? actual.nombre, descripcion: cuerpo.descripcion ?? actual.descripcion, permisos })}`;
    }
    if (conId) {
      const c = db.prepare('SELECT app, habilitada_para FROM conexiones WHERE id = ?').get(Number(conId));
      if (!c) return 'Ese conector no existe.';
      const roles = Array.isArray(cuerpo.roles) ? cuerpo.roles.map(String) : (json(c.habilitada_para, {}).roles ?? []);
      if (metodo === 'DELETE') return `Se borra el conector ${c.app}: nadie lo puede usar más hasta conectarlo de nuevo.`;
      return fichaConector(db, conId, { roles });
    }
    return 'Cambio de configuración de roles o conectores.';
  }
  const aplicarSiEsDueño = (ctx, id, hecho) => {
    if (!ctx.completo) return null;
    try { propuestas.confirmar(id, { personaId: ctx.personaId, permisos: ctx.rol?.permisos }, { avisar: false, donde: 'charla' }); }
    catch (e) { throw new ErrorHerramienta(e.message); }
    return hecho;
  };
  const nombrePersona = (id) => {
    const p = id ? db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?').get(id) : null;
    return p ? (p.nombre ?? (p.telefono ? `+${p.telefono}` : 'alguien')) : 'alguien';
  };
  /** Un archivo para mandar: un F-n de este chat, o una ruta dentro de la carpeta de salida de la corrida. */
  function archivoPara(ctx, referencia) {
    const ref = String(referencia ?? '').trim();
    if (/^F-\d+$/i.test(ref)) {
      const a = archivos.obtener(ref);
      if (!a || (a.chat_id && a.chat_id !== ctx.chatId)) throw new ErrorHerramienta(`No hay un archivo ${ref} en esta conversación.`);
      return a.id;
    }
    if (!ctx.rutas?.salida) throw new ErrorHerramienta('Esta corrida no tiene carpeta de salida.');
    // Solo archivos que estén directamente en la carpeta de salida o en la de trabajo de esta corrida
    // (las capturas del navegador quedan en la de trabajo).
    const ruta = path.resolve(ctx.rutas.salida, ref);
    if (![ctx.rutas.salida, ctx.rutas.trabajo].map((d) => path.resolve(d)).includes(path.dirname(ruta))) {
      throw new ErrorHerramienta(`Solo se pueden mandar archivos que estén directamente en ${ctx.rutas.salida} o en ${ctx.rutas.trabajo}.`);
    }
    let datos;
    try { datos = aislamiento.leerComo(ctx.usuario, ruta); } catch (e) { throw new ErrorHerramienta(e.message); }
    return archivos.guardar({ chatId: ctx.chatId, nombre: path.basename(ruta), datos, origen: `corrida:${ctx.corridaId}` });
  }

  /** Puede escribir en esta charla (lo mismo que exige responder). */
  function puedeEscribir(ctx) {
    if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no le escribe a nadie: devolvé el resultado en tu respuesta final.');
    if (ctx.tipo === 'rutina' && !(ctx.destinos ?? []).includes(ctx.chatId)) throw new ErrorHerramienta('Esta rutina no tiene aprobado escribir en este chat.');
    exigir(ctx, 'responder');
  }
  /** "M-n": un mensaje de esta conversación (los que te llegan llevan esa marca). Devuelve su id de WhatsApp. */
  function mensajeDe(ctx, ref) {
    const n = /^M-(\d+)$/i.exec(String(ref ?? '').trim());
    if (!n) throw new ErrorHerramienta('Indicá el mensaje con su marca M-n (la que aparece en cada mensaje que te llega).');
    const m = db.prepare('SELECT seq, id, chat_id, session, from_me FROM mensajes WHERE seq = ?').get(Number(n[1]));
    if (!m || m.chat_id !== ctx.chatId || ['interno', 'panel'].includes(m.session)) throw new ErrorHerramienta(`M-${n[1]} no es un mensaje de WhatsApp de esta conversación.`);
    return m;
  }
  /** "S-n" (algo que mandaste, te lo devuelve responder) o "M-n" propio: su id de WhatsApp, para editar o borrar. */
  function enviadoDe(ctx, ref) {
    const r = String(ref ?? '').trim();
    if (/^M-\d+$/i.test(r)) {
      const m = mensajeDe(ctx, r);
      if (!m.from_me) throw new ErrorHerramienta('Solo podés editar o borrar mensajes que mandaste vos.');
      return m.id;
    }
    const n = /^S-(\d+)$/i.exec(r);
    if (!n) throw new ErrorHerramienta('Indicá el mensaje con S-n (lo que te devolvió responder) o M-n.');
    const s = db.prepare('SELECT chat_id, estado, waha_id FROM salida WHERE id = ?').get(Number(n[1]));
    if (!s || s.chat_id !== ctx.chatId) throw new ErrorHerramienta(`S-${n[1]} no es un mensaje tuyo en esta conversación.`);
    if (!s.waha_id) throw new ErrorHerramienta(s.estado === 'pendiente' ? 'Ese mensaje todavía no salió: probá en unos segundos.' : 'Ese mensaje no se puede editar ni borrar (no salió o WhatsApp no devolvió su id).');
    return s.waha_id;
  }
  const soloWhatsapp = (ctx) => { if (esPanel(ctx.chatId)) throw new ErrorHerramienta('Esto es solo para chats de WhatsApp.'); };
  const encolarAccion = (ctx, tipo, datos, origen) => {
    const [id] = salida.encolar({ chatId: ctx.chatId, tipo, datos, corridaId: ctx.corridaId, origen });
    ctx.respondio = true;
    despertarSalida();
    return id;
  };

  const escribioAntes = (chatId) => !!db.prepare('SELECT 1 FROM mensajes WHERE chat_id = ? AND from_me = 0 AND tipo != ? LIMIT 1').get(chatId, 'evento');

  return {
    responder: {
      descripcion: 'Manda un mensaje a la persona o al grupo de esta conversación. Es la única forma de que te lean. Con "citar" (M-n) responde citando ese mensaje, como en WhatsApp. En grupos, para mencionar a alguien escribí @ y su número con código de país (por ejemplo @5491112345678). Devuelve S-n: con eso podés editarlo o borrarlo después.',
      esquema: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Mensaje, con formato de WhatsApp.' },
          citar: { type: 'string', description: 'Opcional: M-n del mensaje que querés citar.' },
        },
        required: ['texto'],
      },
      ejecutar(ctx, { texto: t, citar = null }) {
        if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no le escribe a nadie: devolvé el resultado en tu respuesta final.');
        const msg = texto(t, 20_000);
        if (!msg) throw new ErrorHerramienta('El mensaje está vacío.');
        if (ctx.tipo === 'rutina' && !(ctx.destinos ?? []).includes(ctx.chatId)) throw new ErrorHerramienta('Esta rutina no tiene aprobado escribir en este chat.');
        exigir(ctx, 'responder');
        const respondeA = citar && !esPanel(ctx.chatId) ? mensajeDe(ctx, citar).id : null;
        const ids = salida.encolar({ chatId: ctx.chatId, texto: msg, respondeA, corridaId: ctx.corridaId, origen: 'responder' });
        ctx.respondio = true;
        despertarSalida();
        return `Enviado (${ids.map((i) => `S-${i}`).join(', ')}).`;
      },
    },

    enviar_archivo: {
      descripcion: 'Manda un archivo a esta conversación: uno de tu carpeta de salida (por nombre), uno de tu carpeta de trabajo (ruta completa, por ejemplo una captura del navegador) o uno que preparó un trabajo (F-n). "como": "auto" (fotos JPG/PNG como foto común de WhatsApp, videos MP4 como video, lo demás como documento), "foto", "video", "documento" (llega como archivo, sin comprimir: sirve para mandar una foto en calidad original) o "sticker" (tiene que ser WebP).',
      esquema: {
        type: 'object',
        properties: {
          archivo: { type: 'string', description: 'Nombre del archivo en tu carpeta de salida, o F-n.' },
          epigrafe: { type: 'string' },
          como: { type: 'string', enum: ['auto', 'foto', 'video', 'documento', 'sticker'] },
        },
        required: ['archivo'],
      },
      ejecutar(ctx, { archivo, epigrafe, como = 'auto' }) {
        if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no le manda nada a nadie: dejá el archivo en tu carpeta de salida y el orquestador lo va a recibir.');
        exigir(ctx, 'responder');
        const id = archivoPara(ctx, archivo);
        const mime = String(archivos.obtener(id)?.mime ?? '');
        let tipo = { foto: 'imagen', video: 'video', documento: 'archivo', sticker: 'sticker' }[como] ?? null;
        if (!tipo) tipo = /^image\/(jpeg|png)$/.test(mime) ? 'imagen' : mime === 'video/mp4' ? 'video' : 'archivo';
        if (tipo === 'imagen' && !/^image\/(jpeg|png|webp)$/.test(mime)) throw new ErrorHerramienta(`Como foto van JPG o PNG (este es ${mime || 'desconocido'}): mandalo como documento o convertilo.`);
        if (tipo === 'video' && !mime.startsWith('video/')) throw new ErrorHerramienta('Eso no es un video: mandalo como documento.');
        if (tipo === 'sticker' && mime !== 'image/webp') throw new ErrorHerramienta('Un sticker tiene que ser WebP (por ejemplo, convertilo con ffmpeg o Python).');
        const [sid] = salida.encolar({ chatId: ctx.chatId, tipo, archivo: { archivoId: id, epigrafe: epigrafe && tipo !== 'sticker' ? texto(epigrafe, 1000) : null }, corridaId: ctx.corridaId, origen: 'enviar_archivo' });
        despertarSalida();
        return `Archivo F-${id} enviado como ${{ imagen: 'foto', video: 'video', archivo: 'documento', sticker: 'sticker' }[tipo]} (S-${sid}).`;
      },
    },

    enviar_audio: {
      descripcion: 'Manda un audio de tu carpeta de salida como nota de voz.',
      esquema: { type: 'object', properties: { archivo: { type: 'string' } }, required: ['archivo'] },
      ejecutar(ctx, { archivo }) {
        if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no le manda nada a nadie.');
        if (!ajustes.bool('enviar_audio', false)) throw new ErrorHerramienta('Las notas de voz están apagadas en esta instalación.');
        exigir(ctx, 'responder');
        const id = archivoPara(ctx, archivo);
        salida.encolar({ chatId: ctx.chatId, tipo: 'voz', archivo: { archivoId: id }, corridaId: ctx.corridaId, origen: 'enviar_audio' });
        despertarSalida();
        return 'Nota de voz enviada.';
      },
    },

    reaccionar: {
      descripcion: 'Reacciona con un emoji a un mensaje de esta conversación (M-n), como en WhatsApp. Útil para acusar recibo sin escribir ("👍", "✅", "🙏"). Con emoji vacío quita tu reacción.',
      esquema: { type: 'object', properties: { mensaje: { type: 'string', description: 'M-n del mensaje.' }, emoji: { type: 'string' } }, required: ['mensaje', 'emoji'] },
      ejecutar(ctx, { mensaje, emoji }) {
        puedeEscribir(ctx); soloWhatsapp(ctx);
        const e = String(emoji ?? '').trim();
        if (e.length > 16 || /[\w<>]/.test(e)) throw new ErrorHerramienta('La reacción es un solo emoji.');
        const m = mensajeDe(ctx, mensaje);
        encolarAccion(ctx, 'reaccion', { mensajeId: m.id, emoji: e }, 'reaccionar');
        return e ? `Reaccionaste ${e} a M-${m.seq}.` : `Quitaste tu reacción de M-${m.seq}.`;
      },
    },

    enviar_ubicacion: {
      descripcion: 'Manda una ubicación (pin en el mapa) a esta conversación.',
      esquema: {
        type: 'object',
        properties: { latitud: { type: 'number' }, longitud: { type: 'number' }, titulo: { type: 'string', description: 'Nombre del lugar (opcional).' } },
        required: ['latitud', 'longitud'],
      },
      ejecutar(ctx, { latitud, longitud, titulo = null }) {
        puedeEscribir(ctx);
        const la = Number(latitud), lo = Number(longitud);
        if (!(la >= -90 && la <= 90 && lo >= -180 && lo <= 180)) throw new ErrorHerramienta('Coordenadas inválidas.');
        const id = encolarAccion(ctx, 'ubicacion', { latitud: la, longitud: lo, titulo: titulo ? texto(titulo, 200) : null }, 'enviar_ubicacion');
        return `Ubicación enviada (S-${id}).`;
      },
    },

    enviar_contacto: {
      descripcion: 'Manda una tarjeta de contacto (vCard) a esta conversación, para que la persona lo agende o le escriba con un toque.',
      esquema: {
        type: 'object',
        properties: { nombre: { type: 'string' }, telefono: { type: 'string', description: 'Con código de país.' }, empresa: { type: 'string' } },
        required: ['nombre', 'telefono'],
      },
      ejecutar(ctx, { nombre, telefono, empresa = null }) {
        puedeEscribir(ctx);
        const tel = soloDigitos(telefono);
        if (tel.length < 8 || tel.length > 15) throw new ErrorHerramienta('El teléfono va con código de país (por ejemplo 5491112345678).');
        const id = encolarAccion(ctx, 'contacto', { nombre: texto(nombre, 100), telefono: tel, empresa: empresa ? texto(empresa, 100) : null }, 'enviar_contacto');
        return `Contacto enviado (S-${id}).`;
      },
    },

    enviar_encuesta: {
      descripcion: 'Manda una encuesta de WhatsApp a esta conversación (sirve mucho en grupos: elegir un horario, confirmar asistencia). Cada voto te llega como [voto en tu encuesta].',
      esquema: {
        type: 'object',
        properties: {
          pregunta: { type: 'string' },
          opciones: { type: 'array', items: { type: 'string' }, description: 'Entre 2 y 12.' },
          varias: { type: 'boolean', description: 'true si se puede elegir más de una.' },
        },
        required: ['pregunta', 'opciones'],
      },
      ejecutar(ctx, { pregunta, opciones, varias = false }) {
        puedeEscribir(ctx);
        const ops = [...new Set((opciones ?? []).map((o) => texto(o, 100)).filter(Boolean))];
        if (ops.length < 2 || ops.length > 12) throw new ErrorHerramienta('Una encuesta lleva entre 2 y 12 opciones distintas.');
        const id = encolarAccion(ctx, 'encuesta', { pregunta: texto(pregunta, 255), opciones: ops, varias: !!varias }, 'enviar_encuesta');
        return `Encuesta enviada (S-${id}).`;
      },
    },

    editar_mensaje: {
      descripcion: 'Corrige un mensaje que ya mandaste en esta conversación (S-n o M-n tuyo). WhatsApp deja editar durante unos 15 minutos y muestra "editado".',
      esquema: { type: 'object', properties: { mensaje: { type: 'string' }, texto: { type: 'string' } }, required: ['mensaje', 'texto'] },
      ejecutar(ctx, { mensaje, texto: t }) {
        puedeEscribir(ctx); soloWhatsapp(ctx);
        const msg = texto(t, 4000);
        if (!msg) throw new ErrorHerramienta('El texto nuevo está vacío.');
        const id = encolarAccion(ctx, 'editar', { mensajeId: enviadoDe(ctx, mensaje), texto: msg }, 'editar_mensaje');
        return `Editado (S-${id}).`;
      },
    },

    borrar_mensaje: {
      descripcion: 'Borra para todos un mensaje que mandaste en esta conversación (S-n o M-n tuyo). Usalo para corregir un error, no para esconder algo que el Propietario tiene que ver: queda en la bitácora.',
      esquema: { type: 'object', properties: { mensaje: { type: 'string' } }, required: ['mensaje'] },
      ejecutar(ctx, { mensaje }) {
        puedeEscribir(ctx); soloWhatsapp(ctx);
        const wid = enviadoDe(ctx, mensaje);
        encolarAccion(ctx, 'borrar', { mensajeId: wid }, 'borrar_mensaje');
        auditar(db, 'whatsapp.borrar_mensaje', { actor: String(ctx.personaOrigen ?? ctx.personaId ?? ''), rol: ctx.rol?.nombre, detalle: { chat: ctx.chatId, mensaje: String(mensaje) } });
        return 'Borrado para todos.';
      },
    },

    guardar_memoria: {
      descripcion: `Guarda algo para recordar en próximas conversaciones. Secciones: ${SECCIONES.join(', ')}. Alcance "contacto" es la persona que escribe; "cuenta" es la organización; "cliente" y "proyecto", los del chat.`,
      esquema: {
        type: 'object',
        properties: {
          contenido: { type: 'string' },
          seccion: { type: 'string', enum: SECCIONES },
          alcance: { type: 'string', enum: ['contacto', 'cuenta', 'cliente', 'proyecto'], default: 'contacto' },
          publica: { type: 'boolean', description: 'Si la puede saber cualquier persona externa (solo cuenta, cliente o proyecto).' },
        },
        required: ['contenido', 'seccion'],
      },
      ejecutar(ctx, { contenido, seccion, alcance = 'contacto', publica = false }) {
        if (!SECCIONES.includes(seccion)) throw new ErrorHerramienta(`Sección inválida. Usá una de: ${SECCIONES.join(', ')}.`);
        const autor = ctx.personaOrigen ?? ctx.personaId;
        if (alcance === 'contacto') {
          if (!ctx.personaId) throw new ErrorHerramienta('No hay un contacto en esta conversación.');
          exigir(ctx, 'guardar_memoria_contacto');
          const id = memoria.guardar({ alcance: 'contacto', alcanceId: ctx.personaId, seccion, contenido, autor });
          return `Guardado en la memoria de ${nombrePersona(ctx.personaId)} (#${id}).`;
        }
        const alcanceId = alcance === 'cuenta' ? null : alcance === 'cliente' ? ctx.clienteId : ctx.proyectoId ?? null;
        if (alcance === 'proyecto' && !alcanceId) throw new ErrorHerramienta('Este chat no tiene un proyecto asociado.');
        const d = exigir(ctx, 'guardar_memoria');
        if (d === 'con_aprobacion') {
          const id = aprobaciones.pedir({
            tipo: 'cambiar_agente', accion: 'memoria', pedidaPor: autor, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
            detalle: `guardar en la memoria (${alcance}, ${seccion}): "${texto(contenido, 300)}"`,
            datos: { alcance, alcanceId, seccion, contenido: texto(contenido), autor, publica: !!publica },
          });
          return `Pendiente de aprobación ${id}: cambiar la memoria de la ${alcance} necesita el ok del Propietario.`;
        }
        const id = memoria.guardar({ alcance, alcanceId, seccion, contenido, autor, publica: !!publica });
        return `Guardado (#${id}).`;
      },
    },

    agregar_conector: {
      descripcion: 'Agrega un conector MCP remoto (URL del servidor MCP del proveedor). El gateway le manda a la persona el link oficial para autorizar; nunca pidas ni repitas claves por el chat.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          url: { type: 'string', description: 'URL https del servidor MCP remoto.' },
          para: { type: 'string', enum: ['instalacion', 'mi_cuenta'], description: '"mi_cuenta" = una cuenta propia de quien lo pide, usada solo en sus corridas.' },
        },
        required: ['nombre', 'url'],
      },
      async ejecutar(ctx, { nombre, url, para = 'instalacion' }) {
        const propio = para === 'mi_cuenta';
        exigir(ctx, propio ? 'conectar_mis_cuentas' : 'agregar_conector');
        const persona = ctx.personaOrigen ?? ctx.personaId;
        let id;
        try { id = conectores.crear({ nombre, url, alcance: propio ? 'persona' : 'instalacion', personaId: persona, creadoPor: persona }); } catch (e) { throw new ErrorHerramienta(e.message); }
        // El link lo manda el gateway, directo a la persona: el agente no lo arma ni lo puede cambiar.
        const destino = esPanel(ctx.chatId) || !esGrupo(ctx.chatId) ? ctx.chatId : chatDePersona(persona);
        let link;
        try { link = await conectores.autorizar(id, { chatAviso: destino }); } catch (e) {
          return `El conector quedó creado, pero no se pudo iniciar la autorización automática (${e.message}). Si usa una clave, el Propietario la carga en el panel.`;
        }
        if (!link) return 'Conector agregado: no necesita autorización.';
        salida.encolar({ chatId: destino, texto: `Para conectar ${texto(nombre, 40)}, abrí este link oficial y autorizá (vence en 30 minutos):\n${link}`, origen: 'conector' });
        despertarSalida();
        return 'Le mandé a la persona el link para autorizar. Cuando lo haga, el conector queda activo.';
      },
    },

    guardar_leccion: {
      descripcion: 'Guarda una lección cuando te corrigen ("no le hables de usted", "antes de migrar, respaldá"). Entra en todas las corridas siguientes. La de un Colaborador queda como propuesta para el Propietario.',
      esquema: {
        type: 'object',
        properties: {
          regla: { type: 'string', description: 'La regla, corta e imperativa.' },
          porque: { type: 'string' },
          como_aplicar: { type: 'string' },
          publica: { type: 'boolean', description: 'Si también aplica cuando hablás con personas externas.' },
        },
        required: ['regla'],
      },
      ejecutar(ctx, { regla, porque, como_aplicar, publica = false }) {
        const d = exigir(ctx, 'guardar_memoria');
        const r = texto(regla, 500);
        if (r.length < 3) throw new ErrorHerramienta('La regla está vacía.');
        const autor = ctx.personaOrigen ?? ctx.personaId;
        const id = Number(db.prepare(`INSERT INTO lecciones (regla, porque, como_aplicar, publica, autor, estado, creada) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(r, texto(porque, 800) || null, texto(como_aplicar, 800) || null, publica ? 1 : 0, autor, d === 'permitir' ? 'activa' : 'propuesta', reloj()).lastInsertRowid);
        if (d === 'con_aprobacion') {
          const a = aprobaciones.pedir({ tipo: 'cambiar_agente', accion: 'leccion', pedidaPor: autor, chatOrigen: ctx.chatId, corridaId: ctx.corridaId, detalle: `nueva lección: "${r}"`, datos: { leccionId: id } });
          return `Lección propuesta (${a}): entra cuando el Propietario la apruebe.`;
        }
        return `Lección guardada (L-${id}).`;
      },
    },

    preguntar_al_propietario: {
      descripcion: 'Le hace una consulta al Propietario (por WhatsApp y en el panel). Usalo cuando algo excede lo que podés resolver.',
      esquema: { type: 'object', properties: { pregunta: { type: 'string' } }, required: ['pregunta'] },
      ejecutar(ctx, { pregunta }) {
        exigir(ctx, 'preguntar_al_propietario');
        const q = texto(pregunta, 1500);
        if (!q) throw new ErrorHerramienta('La pregunta está vacía.');
        const p = ctx.personaId ? db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?').get(ctx.personaId) : null;
        const quien = p ? `${p.nombre ?? 'Sin nombre'}${p.telefono ? ` (+${p.telefono})` : ''}` : 'alguien';
        const enGrupo = esGrupo(ctx.chatId) ? ' en un grupo' : '';
        // Se la cuenta el agente a cada Propietario con sus palabras; si no hay a quién, va el aviso de texto.
        const despertados = despertarPropietarios?.({ origen: `consulta:${ctx.chatId}`, texto: `[consulta de ${quien}${enGrupo}] ${q}` }) ?? 0;
        avisos.alPropietario(`Consulta de ${quien}${enGrupo}: ${q}`, { tipo: 'consulta', chatOrigen: ctx.chatId, personaOrigen: ctx.personaId, whatsapp: !despertados });
        return 'Le pregunté al Propietario. Decile a la persona que lo consultás y que le vas a avisar.';
      },
    },

    proponer_rol: {
      descripcion: 'Propone un rol nuevo. Aparece como tarjeta en el panel; recién cuando el Propietario la confirma se crea.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          descripcion: { type: 'string', description: 'Qué hace este rol, en lenguaje simple.' },
          permisos: { type: 'object', description: `Valores por permiso: ${Object.entries(PERMISOS).map(([k, d]) => `${k} (${d.niveles.join('|')})`).join('; ')}` },
        },
        required: ['nombre', 'permisos'],
      },
      ejecutar(ctx, { nombre, descripcion, permisos }) {
        exigir(ctx, 'gestionar_roles');
        const n = texto(nombre, 40);
        if (n.length < 2) throw new ErrorHerramienta('El rol necesita un nombre.');
        if (db.prepare('SELECT 1 FROM roles WHERE nombre = ?').get(n)) throw new ErrorHerramienta('Ya existe un rol con ese nombre.');
        const p = normalizar(permisos);
        const pasa = excesos(ctx.rol.permisos, p);
        if (pasa.length) throw new ErrorHerramienta(`No se puede proponer un rol con más permisos que los de quien lo pide: ${pasa.join(', ')}.`);
        const id = propuestas.crear({ tipo: 'rol', datos: { nombre: n, descripcion: texto(descripcion, 300), permisos: p }, personaOrigen: ctx.personaId, chatOrigen: ctx.chatId });
        const ficha = fichaRol(db, { nombre: n, descripcion: texto(descripcion, 300), permisos: p });
        if (ctx.completo) {
          fichasMostradas.set(`propuesta|${id}`, { corridaId: ctx.corridaId, ts: reloj() });
          return `Propuesta ${id} (rol "${n}"): todavía no existe. Explicale al Propietario con tus palabras qué va a poder hacer de verdad, qué pide aprobación y qué queda solo como instrucción, y preguntale si lo confirma:\n${ficha}\nSi confirma en un mensaje nuevo, usá decidir con ${id}.`;
        }
        if (!esPanel(ctx.chatId)) avisos.alPropietario(`Propuesta ${id}: rol "${n}". Confirmala en el panel o respondé "confirmo ${id}".`, { whatsapp: false });
        return `Propuesta ${id} creada (rol "${n}"). Todavía no existe: la confirma el Propietario en el panel${esPanel(ctx.chatId) ? '' : ` o respondiendo "confirmo ${id}"`}.`;
      },
    },

    proponer_persona: {
      descripcion: 'Propone dar de alta a una persona con un rol. Aparece como tarjeta en el panel; recién cuando el Propietario la confirma se aplica.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          telefono: { type: 'string', description: 'Con código de país, solo dígitos (ej. 5491112345678).' },
          rol: { type: 'string', description: 'Nombre de un rol existente o propuesto.' },
        },
        required: ['nombre', 'telefono', 'rol'],
      },
      ejecutar(ctx, { nombre, telefono, rol }) {
        exigir(ctx, 'gestionar_personas');
        const tel = soloDigitos(telefono);
        if (tel.length < 8 || tel.length > 15) throw new ErrorHerramienta('Número inválido: tiene que llevar código de país, solo dígitos.');
        const r = texto(rol, 40);
        const existe = db.prepare('SELECT permisos FROM roles WHERE nombre = ?').get(r);
        const propuesto = db.prepare("SELECT 1 FROM propuestas WHERE tipo = 'rol' AND estado = 'pendiente' AND json_extract(datos, '$.nombre') = ?").get(r);
        if (!existe && !propuesto) throw new ErrorHerramienta(`No existe el rol "${r}". Proponelo primero con proponer_rol.`);
        if (existe && excesos(ctx.rol.permisos, existe.permisos).length) throw new ErrorHerramienta('No se puede asignar un rol con más permisos que los de quien lo pide.');
        const id = propuestas.crear({ tipo: 'persona', datos: { nombre: texto(nombre, 80), telefono: tel, rol: r }, personaOrigen: ctx.personaId, chatOrigen: ctx.chatId });
        const hechoPersona = aplicarSiEsDueño(ctx, id, `Listo: ${texto(nombre, 80)} (+${tel}) quedó dado de alta como ${r}.`);
        if (hechoPersona) return hechoPersona;
        if (!esPanel(ctx.chatId)) avisos.alPropietario(`Propuesta ${id}: ${texto(nombre, 80)} (+${tel}) como ${r}. Confirmala en el panel o respondé "confirmo ${id}".`, { whatsapp: false });
        return `Propuesta ${id} creada: ${texto(nombre, 80)} como ${r}. Se aplica cuando el Propietario la confirma${esPanel(ctx.chatId) ? ' en el panel' : ` (panel o "confirmo ${id}")`}.`;
      },
    },

    crear_sesion_proyecto: {
      descripcion: 'Propone abrir una sesión de proyecto (S-n): una conversación larga con memoria propia del proyecto, a la que le reenviás pedidos y consultas. La confirma el Propietario.',
      esquema: { type: 'object', properties: { nombre: { type: 'string' }, proyecto: { type: 'string' } }, required: ['nombre', 'proyecto'] },
      ejecutar(ctx, { nombre, proyecto }) {
        exigir(ctx, 'delegar');
        const p = db.prepare('SELECT id, nombre FROM proyectos WHERE id = ? OR nombre = ? COLLATE NOCASE').get(Number(proyecto) || -1, String(proyecto ?? ''));
        if (!p) throw new ErrorHerramienta(`No existe el proyecto ${proyecto}.`);
        const n = texto(nombre, 80);
        const id = propuestas.crear({ tipo: 'sesion', datos: { nombre: n, proyecto_id: p.id, persona_origen: ctx.personaOrigen ?? ctx.personaId, chat_origen: ctx.chatId }, personaOrigen: ctx.personaId, chatOrigen: ctx.chatId });
        const hechaSesion = aplicarSiEsDueño(ctx, id, `Listo: la sesión de proyecto "${n}" (${p.nombre}) quedó abierta.`);
        if (hechaSesion) return hechaSesion;
        if (!esPanel(ctx.chatId)) avisos.alPropietario(`Propuesta ${id}: sesión de proyecto "${n}" (${p.nombre}). Confirmala en el panel o respondé "confirmo ${id}".`, { whatsapp: false });
        return `Propuesta ${id}: sesión "${n}" para ${p.nombre}. Se abre cuando el Propietario la confirma.`;
      },
    },

    reenviar_a_sesion: {
      descripcion: 'Le pasa un pedido o un mensaje a una sesión de proyecto (S-n). La respuesta te llega como "[S-n … respondió]".',
      esquema: { type: 'object', properties: { sesion: { type: 'string', description: 'S-n' }, contenido: { type: 'string' }, tipo: { type: 'string', enum: ['reenvio', 'pedido'] } }, required: ['sesion', 'contenido'] },
      ejecutar(ctx, { sesion, contenido, tipo = 'pedido' }) {
        if (ctx.tipo !== 'orquestador' && ctx.tipo !== 'rutina') throw new ErrorHerramienta('Solo el orquestador le escribe a una sesión.');
        exigir(ctx, 'delegar');
        try {
          const s = sesiones.obtener(sesion);
          sesiones.escribir(s.id, { de: 'orquestador', tipo, contenido: texto(contenido, 20_000), personaOrigen: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId });
          return s.estado === 'pausada' ? `S-${s.id} está pausada: el mensaje queda en su buzón hasta que se reanude.` : `Enviado a S-${s.id}. Te aviso cuando conteste.`;
        } catch (e) { throw new ErrorHerramienta(e.message); }
      },
    },

    consultar_sesion: {
      descripcion: 'Le hace una consulta a una sesión de proyecto (S-n) sobre lo que sabe del proyecto.',
      esquema: { type: 'object', properties: { sesion: { type: 'string' }, pregunta: { type: 'string' } }, required: ['sesion', 'pregunta'] },
      ejecutar(ctx, { sesion, pregunta }) {
        if (ctx.tipo !== 'orquestador' && ctx.tipo !== 'rutina') throw new ErrorHerramienta('Solo el orquestador le escribe a una sesión.');
        exigir(ctx, 'delegar');
        try {
          const s = sesiones.obtener(sesion);
          sesiones.escribir(s.id, { de: 'orquestador', tipo: 'consulta', contenido: texto(pregunta, 8000), personaOrigen: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId });
          return `Consulta enviada a S-${s.id}.`;
        } catch (e) { throw new ErrorHerramienta(e.message); }
      },
    },

    proponer_cliente: {
      descripcion: 'Propone dar de alta un cliente (por ejemplo, cuando un grupo parece de un cliente nuevo). Aparece como tarjeta; hasta que el Propietario la confirma no cambia nada.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          autonomia: { type: 'string', enum: ['via_libre', 'consultar_lo_importante', 'consultar_todo'], description: 'Cuánto podés hacer sin consultar en ese cliente.' },
          asignar_este_chat: { type: 'boolean', description: 'Si este grupo o chat pasa a ser de ese cliente (por defecto sí).' },
        },
        required: ['nombre'],
      },
      ejecutar(ctx, { nombre, autonomia = 'consultar_lo_importante', asignar_este_chat = true }) {
        exigir(ctx, 'gestionar_personas');
        const n = texto(nombre, 80);
        if (n.length < 2) throw new ErrorHerramienta('El cliente necesita un nombre.');
        if (db.prepare('SELECT 1 FROM clientes WHERE nombre = ? COLLATE NOCASE').get(n)) throw new ErrorHerramienta('Ya hay un cliente con ese nombre.');
        const chat = asignar_este_chat && !esPanel(ctx.chatId) ? ctx.chatId : null;
        const id = propuestas.crear({ tipo: 'cliente', datos: { nombre: n, autonomia, chat_id: chat }, personaOrigen: ctx.personaId, chatOrigen: ctx.chatId });
        const hechoCliente = aplicarSiEsDueño(ctx, id, `Listo: el cliente "${n}" quedó creado${chat ? ' y este chat es suyo' : ''}.`);
        if (hechoCliente) return hechoCliente;
        if (!esPanel(ctx.chatId)) avisos.alPropietario(`Propuesta ${id}: cliente "${n}"${chat ? ' para este chat' : ''}. Confirmala en el panel o respondé "confirmo ${id}".`, { whatsapp: false });
        return `Propuesta ${id} creada (cliente "${n}"). Todavía no existe: la confirma el Propietario${esPanel(ctx.chatId) ? ' en el panel' : ` (panel o "confirmo ${id}")`}.`;
      },
    },

    delegar_trabajo: {
      descripcion: 'Crea un trabajo en segundo plano (T-n) para tareas largas. Respondé enseguida a la persona; el resultado te llega como mensaje del gateway.',
      esquema: {
        type: 'object',
        properties: {
          descripcion: { type: 'string', description: 'Qué hay que hacer, con todo el contexto necesario: el trabajo no ve esta conversación.' },
          modelo: { type: 'string', description: 'Opcional, de la lista permitida (por ejemplo opus, sonnet, haiku).' },
          esfuerzo: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
          proyecto: { type: 'string', description: 'Opcional: proyecto con repo. El trabajo recibe un clon propio en una rama nueva.' },
        },
        required: ['descripcion'],
      },
      ejecutar(ctx, { descripcion, modelo, esfuerzo, proyecto }) {
        if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no puede delegar otro trabajo.');
        exigir(ctx, 'delegar');
        const d = texto(descripcion, 8000);
        if (d.length < 10) throw new ErrorHerramienta('Describí la tarea con más detalle.');
        const permitidos = json(db.prepare("SELECT permitidos FROM ajustes_modelo WHERE tipo_corrida = 'trabajo'").get()?.permitidos, []);
        if (modelo && !permitidos.includes(modelo)) throw new ErrorHerramienta(`Ese modelo no está permitido. Podés usar: ${permitidos.join(', ') || 'el de por defecto'}.`);
        let proyectoId = null;
        if (proyecto) {
          exigir(ctx, 'editar_codigo');
          try { proyectoId = repos.proyecto(proyecto).id; } catch (e) { throw new ErrorHerramienta(e.message); }
        }
        const n = (db.prepare('SELECT MAX(numero) AS n FROM trabajos').get().n ?? 0) + 1;
        const id = `T-${n}`;
        db.prepare(`INSERT INTO trabajos (id, numero, pedido_por, chat_id, cliente_id, descripcion, modelo, esfuerzo, estado, creado, proyecto_id, rama)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_cola', ?, ?, ?)`)
          .run(id, n, ctx.personaOrigen ?? ctx.personaId, ctx.tipo === 'sesion' ? ctx.chatOrigen : ctx.chatId, ctx.clienteId ?? 1, d, modelo ?? null, esfuerzo ?? null, Date.now(), proyectoId, proyectoId ? `superagent/${id}` : null);
        auditar(db, 'trabajo.crear', { actor: String(ctx.personaOrigen ?? ctx.personaId ?? ''), rol: ctx.rol?.nombre, detalle: { id } });
        return `${id} quedó en cola. Cuando termine te llega "[${id} terminado]" en esta conversación.`;
      },
    },

    estado_de_trabajo: {
      descripcion: 'Lista los trabajos en segundo plano de esta conversación (o uno, por id).',
      esquema: { type: 'object', properties: { id: { type: 'string' } } },
      ejecutar(ctx, { id }) {
        const filas = id
          ? db.prepare('SELECT id, estado, descripcion, resultado FROM trabajos WHERE id = ? AND (chat_id = ? OR ? = 1)').all(String(id).toUpperCase(), ctx.chatId, ctx.decidir('aprobar').decision === 'permitir' ? 1 : 0)
          : db.prepare('SELECT id, estado, descripcion, resultado FROM trabajos WHERE chat_id = ? ORDER BY numero DESC LIMIT 10').all(ctx.chatId);
        if (!filas.length) return 'No hay trabajos.';
        return filas.map((t) => `${t.id} — ${t.estado.replace('_', ' ')}: ${t.descripcion.slice(0, 150)}${t.resultado ? `\n  Resultado: ${t.resultado.slice(0, 600)}` : ''}`).join('\n');
      },
    },

    programar_rutina: {
      descripcion: 'Programa una rutina: a la hora indicada te despierta en esta conversación con la instrucción. Formato cron de 5 campos (minuto hora día mes día-de-semana).',
      esquema: {
        type: 'object',
        properties: {
          cuando: { type: 'string', description: 'Ej.: "0 9 * * 1" = lunes 9:00.' },
          instruccion: { type: 'string' },
          zona_horaria: { type: 'string', description: 'IANA, por ejemplo America/Argentina/Buenos_Aires. Por defecto la de la instalación.' },
          destinos: { type: 'array', items: { type: 'string' }, description: 'A quién más puede escribirle (teléfonos o chats). Este chat siempre está incluido.' },
          modelo: { type: 'string' },
        },
        required: ['cuando', 'instruccion'],
      },
      ejecutar(ctx, { cuando, instruccion, zona_horaria, destinos = [], modelo }) {
        const d = exigir(ctx, 'programar_rutina');
        const tz = zona_horaria || ajustes.get('zona_horaria', 'UTC') || 'UTC';
        if (!zonaValida(tz)) throw new ErrorHerramienta(`Zona horaria inválida: ${tz}.`);
        let prox;
        try { prox = proxima(cuando, tz, reloj()); } catch (e) { throw new ErrorHerramienta(e.message); }
        if (!prox) throw new ErrorHerramienta('Esa expresión no se cumple nunca.');
        const lista = [ctx.chatId, ...destinos.map(chatDeDestino)].filter(Boolean);
        if (lista.length !== destinos.length + 1) throw new ErrorHerramienta('Algún destino no es un teléfono o chat válido.');
        const unicos = [...new Set(lista)];
        const aprobada = d === 'permitir';
        const id = Number(db.prepare(`INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, modelo, activa, proxima, destinos, aprobada, creada)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(String(cuando).trim(), tz, texto(instruccion, 4000), ctx.personaOrigen ?? ctx.personaId, ctx.chatId, modelo ?? null, aprobada ? 1 : 0, prox, JSON.stringify(unicos), aprobada ? 1 : 0, Date.now()).lastInsertRowid);
        if (!aprobada) {
          const a = aprobaciones.pedir({
            tipo: 'rutina', accion: 'rutina', pedidaPor: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
            detalle: `rutina R-${id} "${String(cuando).trim()}" (${tz}): ${texto(instruccion, 200)}. Destinos: ${unicos.join(', ')}`,
            datos: { rutinaId: id },
          });
          return `Rutina R-${id} creada, pendiente de aprobación ${a}.`;
        }
        return `Rutina R-${id} programada. Próxima: ${new Date(prox).toISOString()} (${tz}).`;
      },
    },

    iniciar_conversacion: {
      descripcion: 'Le escribe primero a una persona o grupo (otro chat). A números que nunca escribieron solo se puede con una regla de contacto aprobada o con aprobación del Propietario, y salen con ritmo suave.',
      esquema: {
        type: 'object',
        properties: { destino: { type: 'string', description: 'Teléfono con código de país, o id de chat.' }, texto: { type: 'string' } },
        required: ['destino', 'texto'],
      },
      ejecutar(ctx, { destino, texto: t }) {
        if (ctx.tipo === 'trabajo') throw new ErrorHerramienta('Un trabajo no le escribe a nadie: devolvé el resultado en tu respuesta final.');
        const chatId = chatDeDestino(destino);
        if (!chatId || esPanel(chatId)) throw new ErrorHerramienta('Destino inválido: usá un teléfono con código de país o un id de chat.');
        const msg = texto(t, 20_000);
        if (!msg) throw new ErrorHerramienta('El mensaje está vacío.');
        if (ctx.tipo === 'rutina' && !(ctx.destinos ?? []).includes(chatId)) throw new ErrorHerramienta('Esta rutina no tiene aprobado ese destino.');
        let d = exigir(ctx, 'iniciar_conversacion');
        const nuevo = !escribioAntes(chatId);
        if (nuevo && d === 'permitir') {
          // A un número nuevo: hace falta una regla de contacto del origen o los destinos aprobados de una rutina.
          // Si no, aprobación en cada caso, aunque lo pida el Propietario: una página o un archivo con instrucciones
          // escondidas no puede hacer que el agente le escriba a un desconocido.
          // Excepción: el Propietario en su charla (modo completo) le escribe directo a lo que ya conoce: grupos del
          // número, chats existentes y personas dadas de alta. Un número desconocido sigue necesitando su "sí" en un
          // mensaje nuevo (no en la misma corrida), para que una página no pueda mandar datos afuera.
          const conocido = esGrupo(chatId) || !!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)
            || !!db.prepare('SELECT 1 FROM personas WHERE alta_manual = 1 AND activa = 1 AND telefono = ?').get(soloDigitos(chatId));
          const directoDelPropietario = ctx.tipo === 'rutina' || (ctx.completo && conocido);
          const regla = db.prepare('SELECT * FROM reglas_contacto WHERE activa = 1 AND aprobada_por IS NOT NULL AND (origen = ? OR origen = ?)').all(ctx.origen ?? '-', '*')
            .find((r) => r.a_quien === '*' || json(r.a_quien, []).some((x) => chatDeDestino(x) === chatId));
          if (!directoDelPropietario && !regla) d = 'con_aprobacion';
          if (d === 'permitir' && ctx.completo) bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'hecho', que: `escribirle a ${chatId} (primer mensaje): "${texto(msg, 200)}"`, ref: 'iniciar_conversacion' });
        }
        if (d === 'con_aprobacion') {
          const a = aprobaciones.pedir({
            tipo: 'iniciar_conversacion', accion: 'enviar', pedidaPor: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
            detalle: `escribirle a ${chatId}${nuevo ? ' (nunca escribió)' : ''}: "${texto(msg, 300)}"`,
            datos: { chatId, texto: msg, contactoNuevo: nuevo },
            avisar: !ctx.completo,
          });
          if (ctx.completo) return `${a}: es un número que nunca escribió. Por seguridad no sale hasta que el Propietario te diga que sí en su próximo mensaje: preguntale en una línea, con el número y el texto. Cuando diga que sí, usá decidir con ${a}.`;
          return `Pendiente de aprobación ${a}: el Propietario tiene que aprobar este mensaje.`;
        }
        salida.encolar({ chatId, texto: msg, contactoNuevo: nuevo, corridaId: ctx.corridaId, origen: 'iniciar_conversacion' });
        db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, creado) VALUES (?, ?, 1, 1, ?) ON CONFLICT(id) DO NOTHING").run(chatId, esGrupo(chatId) ? 'grupo' : 'directo', Date.now());
        avisos.resolverConsultasDe(chatId);
        despertarSalida();
        return nuevo ? 'En cola: es un contacto nuevo, sale respetando el ritmo suave.' : 'Enviado.';
      },
    },

    invitar_panel: {
      descripcion: 'Solo el Propietario: crea un link de invitación al panel web (un solo uso, vence en 72 h) para alguien del equipo o un cliente. Elegí qué secciones ve: whatsapp (vincular el número), claude (conectar la cuenta y ver consumo), bandeja (leer chats), equipo (ver personas y roles), conexiones, bitacora; o "todo" (co-propietario, con acceso total). Mandale el link a esa persona (por ejemplo con iniciar_conversacion) o pasáselo al Propietario.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'A quién es (aparece en la invitación).' },
          accesos: { type: 'array', items: { type: 'string', enum: ['todo', 'whatsapp', 'claude', 'bandeja', 'equipo', 'conexiones', 'bitacora'] } },
        },
        required: ['nombre', 'accesos'],
      },
      ejecutar(ctx, { nombre, accesos }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario invita al panel.');
        let r;
        try { r = crearInvitacion(db, { nombre: texto(nombre, 100), accesos, creadaPor: `agente (persona ${ctx.personaId ?? '?'})`, ahora: reloj() }); } catch (e) { throw new ErrorHerramienta(e.message); }
        bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'decision', que: `invitación al panel para ${nombre}: ${[].concat(accesos).join(', ')}` });
        return `Link de invitación para ${nombre} (un solo uso, vence en 72 h): ${linkInvitacion(publicUrl, r.token)}`;
      },
    },

    apps: {
      descripcion: 'Publica lo que levantás en tu entorno (un sistema, un panel a medida, una calculadora, un simulador, un informe) en una URL pública propia: <url>/apps/<nombre>/. Vos corrés el servidor en un puerto local; esto lo expone (HTTP y WebSocket, con recarga en vivo) y, si le pasás el comando, lo vuelve a levantar solo si se cae o se reinicia el servidor. Sin comando, mantenerlo vivo es cosa tuya. Acceso: la URL es pública; si hace falta contraseña o login, construilo en la app.',
      esquema: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['listar', 'publicar', 'quitar', 'reiniciar', 'registro'] },
          nombre: { type: 'string', description: 'Minúsculas, números y guiones: queda en /apps/<nombre>/.' },
          puerto: { type: 'number', description: 'publicar: puerto local donde escucha la app (ej. 3000-3999; no 8080/8081).' },
          comando: { type: 'string', description: 'publicar: cómo levantarla (ej. "npm run dev -- --port 3001 --host 127.0.0.1"). Recibe PORT, BASE_PATH (/apps/<nombre>) y PUBLIC_URL.' },
          dir: { type: 'string', description: 'publicar: carpeta donde corre el comando, relativa a tu HOME (ej. "trabajo/crm").' },
          quitar_prefijo: { type: 'boolean', description: 'publicar: true = la app recibe las rutas sin /apps/<nombre> (sirve para estáticos con links relativos). Por defecto false: la app tiene que servir bajo BASE_PATH (vite --base, next basePath, etc.).' },
          descripcion: { type: 'string', description: 'publicar: para qué es (y para quién).' },
        },
        required: ['accion'],
      },
      async ejecutar(ctx, { accion, nombre, puerto, comando, dir, quitar_prefijo, descripcion }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario publica apps.');
        if (!apps) throw new ErrorHerramienta('Las apps no están disponibles en esta instalación.');
        if (accion === 'listar') {
          const lista = await apps.estado();
          if (!lista.length) return 'No hay apps publicadas.';
          return lista.map((a) => `- ${a.nombre} · ${a.url} · puerto ${a.puerto} · ${a.viva ? 'viva' : 'no responde'}${a.comando ? ` · se mantiene sola (${a.comando})` : ' · sin comando'}${a.descripcion ? ` · ${a.descripcion}` : ''}`).join('\n');
        }
        const n = String(nombre ?? '').trim().toLowerCase();
        if (!n) throw new ErrorHerramienta('Falta el nombre de la app.');
        try {
          if (accion === 'publicar') {
            const a = apps.publicar({ nombre: n, puerto, comando: comando ? texto(comando, 1000) : null, dir: dir ? texto(dir, 300) : null, quitarPrefijo: !!quitar_prefijo, descripcion: descripcion ? texto(descripcion, 300) : null });
            const estado = (await apps.estado()).find((x) => x.nombre === n)?.viva ?? false;
            if (!estado && a.comando) await apps.reiniciar(n);
            bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'decision', que: `app publicada: ${n} → ${apps.url(n)}` });
            return `Publicada: ${apps.url(n)} (puerto ${a.puerto}). ${estado ? 'Ya responde.' : a.comando ? 'La estoy levantando con el comando; revisá en unos segundos con listar (y con registro si no arranca).' : 'Todavía no responde nada en ese puerto: levantala vos.'}`;
          }
          if (accion === 'quitar') return apps.quitar(n) ? `Quitada: ${n} ya no está publicada (si la levantaste vos, el proceso sigue corriendo).` : 'No hay una app con ese nombre.';
          if (accion === 'reiniciar') { await apps.reiniciar(n); return `Reiniciando ${n}.`; }
          if (accion === 'registro') return `Lo que imprime está en ~/registros/${n}.log (leelo con tail).`;
        } catch (e) {
          throw new ErrorHerramienta(e.message);
        }
        throw new ErrorHerramienta('Acción desconocida.');
      },
    },

    chats: {
      descripcion: 'Solo el Propietario: lista los chats y grupos de WhatsApp y configura cómo los atendés. Cuando el Propietario te pide sumarte o atender un grupo, activalo vos con esto. En un grupo activo leés toda la charla y decidís si es para vos (apodos, respuestas a lo que dijiste, preguntas dirigidas a vos); con solo_menciones, solo respondés si te nombran o te responden. También guarda tus apodos ("Sandrito").',
      esquema: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['listar', 'configurar'] },
          buscar: { type: 'string', description: 'listar: filtra por nombre o número.' },
          chat: { type: 'string', description: 'configurar: id del chat (de listar) o su nombre exacto.' },
          activo: { type: 'boolean', description: 'Si lo atendés.' },
          solo_menciones: { type: 'boolean', description: 'Grupos: true = solo si te nombran o te responden; false = leés todo y decidís (por defecto).' },
          apodos: { type: 'string', description: 'Tus apodos, separados por coma (reemplaza la lista). Valen en todos los grupos.' },
          responder_desconocidos: { type: 'boolean', description: 'configurar (sin chat): true = respondés directo a cualquier número que te escriba (como Tercero); false = solo a las personas dadas de alta, y el resto lo vas abriendo con el Propietario.' },
          cliente: { type: 'string', description: 'Nombre del cliente al que pertenece ("Propio" para el negocio propio).' },
        },
        required: ['accion'],
      },
      async ejecutar(ctx, { accion, buscar, chat, activo, solo_menciones, apodos, cliente, responder_desconocidos }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario configura los chats.');
        if (accion === 'listar') {
          await sincronizarGrupos(db, waha);
          const q = buscar ? `%${String(buscar).trim()}%` : '%';
          const filas = db.prepare(`SELECT c.id, c.tipo, c.activo, c.nombre, c.responder_solo_si_mencionan AS solo, cl.nombre AS cliente, p.nombre AS persona,
              (SELECT MAX(recibido) FROM mensajes m WHERE m.chat_id = c.id) AS ultimo
            FROM chats c LEFT JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN personas p ON p.id = c.persona_id
            WHERE c.id NOT LIKE 'panel:%' AND (COALESCE(c.nombre, '') LIKE ? OR c.id LIKE ? OR COALESCE(p.nombre, '') LIKE ?)
            ORDER BY ultimo DESC NULLS LAST LIMIT 40`).all(q, q, q);
          if (!filas.length) return 'No hay chats que coincidan.';
          return filas.map((f) => `- ${f.id} · ${f.tipo} · ${f.nombre || f.persona || 'sin nombre'} · ${f.activo ? 'activo' : 'inactivo'}${f.tipo === 'grupo' && f.activo ? (f.solo ? ' · solo menciones' : ' · lee todo') : ''} · cliente ${f.cliente ?? 'Propio'}`).join('\n');
        }
        const cambios = [];
        if (responder_desconocidos != null) {
          db.prepare('UPDATE cuentas SET responder_sin_alta = ? WHERE id = 1').run(responder_desconocidos ? 1 : 0);
          cambios.push(responder_desconocidos ? 'respondés a cualquier número' : 'solo respondés a quienes están dados de alta');
          bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'decision', que: `contactos sin alta: ${responder_desconocidos ? 'se les responde' : 'no se les responde hasta darlos de alta'}` });
          if (!chat && apodos == null) return `Listo: ${cambios.join(', ')}.`;
        }
        if (apodos != null) {
          const lista = String(apodos).split(',').map((x) => texto(x, 30)).filter((x) => x && x.length >= 2).slice(0, 10);
          ajustes.set('apodos_agente', lista.join(', '));
          cambios.push(lista.length ? `apodos: ${lista.join(', ')}` : 'sin apodos');
          bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'decision', que: `apodos del agente: ${lista.join(', ') || 'ninguno'}` });
          if (!chat) return `Listo: ${cambios.join(', ')}.`;
        }
        if (!chat && cambios.length) return `Listo: ${cambios.join(', ')}.`;
        const ch = String(chat ?? '').trim();
        // Por id, por nombre exacto o, si hay uno solo que lo contenga, por parte del nombre ("Ventas").
        let c = db.prepare("SELECT * FROM chats WHERE id = ? OR (nombre = ? COLLATE NOCASE AND id NOT LIKE 'panel:%') ORDER BY id = ? DESC LIMIT 1").get(ch, ch, ch);
        if (!c && ch.length >= 3) {
          const parecidos = db.prepare("SELECT * FROM chats WHERE id NOT LIKE 'panel:%' AND nombre LIKE ? COLLATE NOCASE LIMIT 3").all(`%${ch}%`);
          if (parecidos.length === 1) c = parecidos[0];
          else if (parecidos.length > 1) throw new ErrorHerramienta(`Hay varios chats con "${ch}": ${parecidos.map((x) => `${x.nombre} (${x.id})`).join(', ')}. Usá el id.`);
        }
        if (!c) throw new ErrorHerramienta('No encontré ese chat: usá accion "listar" para ver los ids.');
        if (activo !== undefined) { db.prepare('UPDATE chats SET activo = ? WHERE id = ?').run(activo ? 1 : 0, c.id); cambios.push(activo ? 'activo' : 'inactivo'); }
        if (solo_menciones !== undefined) {
          db.prepare('UPDATE chats SET responder_solo_si_mencionan = ? WHERE id = ?').run(solo_menciones ? 1 : 0, c.id);
          cambios.push(solo_menciones ? 'solo responde si lo nombran' : 'lee toda la charla y decide');
        }
        if (cliente) {
          const cl = db.prepare("SELECT id, nombre FROM clientes WHERE nombre = ? COLLATE NOCASE AND estado = 'activo'").get(String(cliente).trim());
          if (!cl) throw new ErrorHerramienta(`No hay un cliente "${cliente}": proponelo con proponer_cliente.`);
          db.prepare('UPDATE chats SET cliente_id = ? WHERE id = ?').run(cl.id, c.id);
          cambios.push(`cliente ${cl.nombre}`);
        }
        if (!cambios.length) return 'No pediste ningún cambio.';
        auditar(db, 'chat.configurar', { actor: String(ctx.personaId ?? ''), rol: ctx.rol?.nombre, detalle: { chat: c.id, cambios } });
        return `Listo: ${c.nombre || c.id} → ${cambios.join(', ')}.`;
      },
    },

    consumo: {
      descripcion: 'Consumo de Claude: cuánto del plan se usó (ventana de 5 horas y semana, si la cuenta lo informa) y lo gastado por las corridas. El Propietario también define acá desde qué porcentaje avisar y a qué porcentaje del contexto compactar (cuanto más bajo, más barato cada mensaje, con menos memoria de corto plazo). Quién más ve el consumo se define con el permiso "ver consumo" del rol.',
      esquema: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['ver', 'configurar'] },
          avisar_desde_pct: { type: 'number', description: 'configurar: avisar cuando el plan pase este porcentaje (0 = no avisar).' },
          compactar_pct: { type: 'number', description: 'configurar: compactar el contexto al llegar a este porcentaje (30 a 95).' },
        },
        required: ['accion'],
      },
      async ejecutar(ctx, { accion, avisar_desde_pct, compactar_pct }) {
        if (ctx.decidir('ver_consumo').decision !== 'permitir') throw new ErrorHerramienta('Tu rol no ve el consumo.');
        if (!consumo) throw new ErrorHerramienta('El consumo no está disponible.');
        if (accion === 'configurar') {
          if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Los umbrales los define el Propietario.');
          const cambios = [];
          if (avisar_desde_pct != null) { const v = Math.max(0, Math.min(100, Math.round(Number(avisar_desde_pct)))); ajustes.set('aviso_consumo_pct', String(v)); cambios.push(v ? `aviso desde el ${v}%` : 'sin avisos'); }
          if (compactar_pct != null) { const v = Math.max(30, Math.min(95, Math.round(Number(compactar_pct)))); ajustes.set('compactar_pct', String(v)); cambios.push(`compactar al ${v}%`); }
          if (!cambios.length) return 'No pediste ningún cambio.';
          bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'decision', que: `consumo de Claude: ${cambios.join(', ')}` });
          return `Listo: ${cambios.join(', ')}.`;
        }
        const r = await consumo.resumen();
        const p = r.plan;
        const fmt = (x) => (x?.pct != null ? `${Math.round(x.pct)}%${x.reinicia ? ` (se renueva ${new Date(x.reinicia).toLocaleString('es', { timeZone: ajustes.get('zona_horaria', 'UTC') || 'UTC' })})` : ''}` : 'sin dato');
        const l = r.local;
        return [
          p ? `Plan: ventana de 5 h ${fmt(p.cincoHoras)}; semana ${fmt(p.semana)}.` : 'La cuenta no informa el porcentaje del plan: solo está lo medido por corrida.',
          `Últimas 5 h: ${l.cincoHoras.corridas} corridas, ${l.cincoHoras.entrada} tokens de entrada, ${l.cincoHoras.cache} de caché, ${l.cincoHoras.salida} de salida (≈ US$ ${l.cincoHoras.costo.toFixed(2)} a precio de API).`,
          `Última semana: ${l.semana.corridas} corridas (≈ US$ ${l.semana.costo.toFixed(2)}).`,
          `Aviso desde: ${r.avisoPct || 'apagado'}${r.avisoPct ? '%' : ''}. Compactación: al ${r.compactarPct}% del contexto.`,
        ].join('\n');
      },
    },

    reiniciar_contexto: {
      descripcion: 'Empieza esta conversación con un contexto nuevo desde el próximo mensaje (más barato). Antes, guardá con guardar_memoria lo que haga falta recordar: lo que no esté en la memoria se pierde.',
      esquema: { type: 'object', properties: { motivo: { type: 'string' } } },
      ejecutar(ctx) {
        ctx.reiniciarContexto = true;
        return 'Listo: desde el próximo mensaje arranco con el contexto limpio (la memoria se mantiene).';
      },
    },

    anotar_decision: {
      descripcion: 'Anota en la bitácora de decisiones algo que el Propietario decidió en la charla ("usamos Vercel para el sitio", "a los clientes no se les pasan precios por WhatsApp"). Las aprobaciones, altas y mensajes que hacés por pedido suyo ya se anotan solos.',
      esquema: { type: 'object', properties: { que: { type: 'string', description: 'La decisión en una línea, con sus palabras.' } }, required: ['que'] },
      ejecutar(ctx, { que }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('La bitácora la escribe el Propietario (a través tuyo).');
        const t = texto(que, 500);
        if (!t) throw new ErrorHerramienta('La decisión está vacía.');
        bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: esPanel(ctx.chatId) ? 'panel' : 'charla', resultado: 'decision', que: t });
        return 'Anotado en la bitácora.';
      },
    },

    decidir: {
      descripcion: 'Solo el Propietario: aprueba o rechaza un pedido pendiente (A-n) o confirma o descarta una propuesta (P-n) cuando te lo dice en la charla ("sí, dale", "no, eso no"). Las pendientes están en el bloque <superagent>.',
      esquema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A-n o P-n.' },
          si: { type: 'boolean', description: 'true = aprobar/confirmar; false = rechazar/descartar.' },
          comentario: { type: 'string', description: 'Al rechazar: el motivo, con las palabras del Propietario.' },
          como_propietario: { type: 'boolean', description: 'Solo rutinas: que corra con los permisos de este Propietario (por ejemplo, si necesita un conector que el rol de quien la pidió no tiene). Lo que mande lo lee el destino.' },
        },
        required: ['id', 'si'],
      },
      async ejecutar(ctx, { id, si, comentario = null, como_propietario = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, decide pedidos y propuestas.');
        const x = String(id ?? '').trim().toUpperCase();
        try {
          if (/^A-\d+$/.test(x)) {
            // El "sí" tiene que venir de un mensaje del Propietario: no de la misma corrida que hizo el pedido.
            const pend = db.prepare('SELECT corrida_id FROM aprobaciones WHERE id = ?').get(x);
            if (pend && pend.corrida_id && pend.corrida_id === ctx.corridaId) throw new ErrorHerramienta(`${x} lo pediste en esta misma corrida: esperá a que el Propietario conteste.`);
            if (si && como_propietario) {
              const ap = aprobaciones.obtener(x);
              if (ap.accion !== 'rutina' || ap.estado !== 'pendiente') throw new ErrorHerramienta('"como_propietario" es solo para rutinas pendientes.');
              db.prepare('UPDATE rutinas SET ejecuta_como = ? WHERE id = ?').run(ctx.personaId, ap.datos.rutinaId);
            }
            const a = si ? await aprobaciones.aprobar(x, { personaId: ctx.personaId, donde: 'charla' }) : await aprobaciones.rechazar(x, { personaId: ctx.personaId, donde: 'charla', comentario: comentario ? texto(comentario, 500) : null });
            return `${a.id} ${a.estado}.${a.resultado ? ` ${typeof a.resultado === 'string' ? a.resultado : JSON.stringify(a.resultado)}` : ''} Quien lo pidió recibe el aviso.`;
          }
          if (/^P-\d+$/.test(x)) {
            // Un rol que propusiste en esta misma corrida: el Propietario tiene que ver la ficha y contestar primero.
            if (fichasMostradas.get(`propuesta|${x}`)?.corridaId === ctx.corridaId) throw new ErrorHerramienta(`${x} lo propusiste en esta misma corrida: mostrale la ficha al Propietario y esperá a que conteste.`);
            fichasMostradas.delete(`propuesta|${x}`);
            const actor = { personaId: ctx.personaId, permisos: ctx.rol?.permisos };
            const p = si ? propuestas.confirmar(x, actor, { avisar: false, donde: 'charla' }) : propuestas.descartar(x, actor, { donde: 'charla' });
            return `${p.id} ${p.estado}.`;
          }
        } catch (e) { throw new ErrorHerramienta(e.message); }
        throw new ErrorHerramienta('El id tiene que ser A-n o P-n.');
      },
    },

    whatsapp: {
      descripcion: 'Solo el Propietario: acceso directo a la API de WAHA (motor GOWS, la que conecta el número de WhatsApp). Sirve para todo lo que las otras herramientas no cubren: grupos (crear, nombre, descripción, foto, participantes, admins, invitaciones, pedidos para entrar, quién puede escribir o editar la info), contactos (foto de perfil, ver si un número tiene WhatsApp con /api/contacts/check-exists), chats (mensajes anteriores, marcar leído o no leído, foto), estados/historias (/api/{session}/status/text, image, video, voice), etiquetas (crear, asignar a chats), canales (crear, buscar, seguir), presencia (en línea, escribiendo), mensajes de evento de calendario (/api/{session}/events) y rechazar llamadas (/api/{session}/calls/reject). La ruta usa {session} (por ejemplo GET /api/{session}/groups, GET /api/{session}/chats/<chatId>/messages?limit=20). Documentación: https://waha.devlike.pro/docs/overview/introduction/ . Para contestarle a alguien usá responder o iniciar_conversacion, así queda registrado. No se puede desvincular ni borrar la sesión desde acá.',
      esquema: {
        type: 'object',
        properties: {
          metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          ruta: { type: 'string', description: 'Ruta de la API, empieza con /api/.' },
          cuerpo: { type: 'object', description: 'JSON del cuerpo (POST, PUT, PATCH).' },
        },
        required: ['metodo', 'ruta'],
      },
      async ejecutar(ctx, { metodo, ruta, cuerpo = null }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario usa la API de WhatsApp.');
        if (!waha?.api) throw new ErrorHerramienta('WAHA no está disponible.');
        const r = String(ruta ?? '').trim();
        if (!/^\/api\/[\w{}@.\-/?=&%:,+]*$/.test(r) || r.includes('..')) throw new ErrorHerramienta('La ruta tiene que empezar con /api/ (por ejemplo /api/{session}/groups).');
        // Lo que dejaría al agente sin número (o cambiaría el webhook firmado) queda en el panel.
        if (/^\/api\/sessions(\/|$|\?)/.test(r) && metodo !== 'GET') throw new ErrorHerramienta('La sesión (vincular, desvincular, reiniciar, webhook) se maneja desde el panel.');
        if (/^\/api\/\{session\}\/auth\b|^\/api\/[^/]+\/auth\b|\/logout\b/.test(r)) throw new ErrorHerramienta('La vinculación del número se maneja desde el panel.');
        let res;
        try { res = await waha.api(metodo, r, cuerpo); } catch (e) { throw new ErrorHerramienta(e.message); }
        auditar(db, 'whatsapp.api', { actor: String(ctx.personaId ?? ''), rol: ctx.rol?.nombre, detalle: { metodo, ruta: r.split('?')[0], status: res.status } });
        // Si trajo grupos, quedan en la lista de chats (inactivos hasta que el Propietario los active).
        if (metodo === 'GET' && /\/groups(\?|$)/.test(r)) await sincronizarGrupos(db, waha);
        const t = typeof res.datos === 'string' ? res.datos : JSON.stringify(res.datos);
        return `HTTP ${res.status}\n${(t ?? '').slice(0, 15_000)}${t && t.length > 15_000 ? '\n(recortado)' : ''}`;
      },
    },

    panel: {
      descripcion: 'Solo el Propietario, en su charla: hace en el panel lo mismo que haría él (con sus permisos), por la API del panel. Para lo que no tiene otra herramienta: roles y sus permisos, qué roles usan cada conector, personas y su rol, clientes, rutinas, entradas, reglas de contacto, lecciones, ajustes y modelos, equipo, chats, proyectos. Leé primero (GET) para ver ids y forma, contale al Propietario qué vas a cambiar y hacelo cuando te diga que sí. Rutas útiles: GET /api/roles; PATCH /api/roles/:id {nombre?, descripcion?, permisos?}; POST /api/roles; GET /api/conectores (cada uno con habilitada_para.roles); PATCH /api/conectores/:id {roles: [nombres de rol], apagadas?: [herramientas]} (roles reemplaza la lista completa); GET /api/personas; POST /api/personas {nombre, telefono, rolId}; PATCH /api/personas/:id {nombre?, rolId?}; GET/PATCH/DELETE /api/rutinas[/:id]; GET/PATCH /api/ajustes; GET/POST/PATCH /api/clientes; GET /api/bitacora; GET /api/aprobaciones. Lo de la cuenta de cada uno (logins, contraseñas, vincular o desvincular WhatsApp, conectar o desconectar Claude, tokens) se hace en el panel, no acá.',
      esquema: {
        type: 'object',
        properties: {
          metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          ruta: { type: 'string', description: 'Ruta de la API del panel, empieza con /api/ (por ejemplo /api/roles).' },
          cuerpo: { type: 'object', description: 'JSON del cuerpo (POST, PUT, PATCH).' },
          confirmado: { type: 'boolean', description: 'Roles y conectores: true solo después de mostrarle la ficha al Propietario y que confirme en un mensaje nuevo.' },
        },
        required: ['metodo', 'ruta'],
      },
      async ejecutar(ctx, { metodo, ruta, cuerpo = null, confirmado = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, usa el panel a través tuyo.');
        if (!panel) throw new ErrorHerramienta('El panel no está disponible.');
        const r = String(ruta ?? '').trim();
        const m = String(metodo ?? 'GET').toUpperCase();
        if (!/^\/api\/[\w\-/?=&%.,:]*$/.test(r) || r.includes('..')) throw new ErrorHerramienta('La ruta tiene que empezar con /api/ (por ejemplo /api/roles).');
        const camino = r.split('?')[0];
        if (!rutaPanelPermitida(camino, m)) throw new ErrorHerramienta('Eso lo hace el Propietario directo en el panel (es de su cuenta o de la conexión del sistema).');
        if (/^\/api\/paquetes(\/|$)/.test(camino)) throw new ErrorHerramienta('Para paquetes usá importar_paquete (con ensayo y confirmación) o exportar_paquete.');
        // Roles y conectores: primero la ficha al Propietario, y se aplica recién cuando confirma (en otro mensaje).
        if (m !== 'GET' && /^\/api\/(roles|conectores)(\/|$)/.test(camino)) {
          const clave = `${ctx.personaId}|${m}|${camino}|${JSON.stringify(cuerpo ?? {})}`;
          const previa = fichasMostradas.get(clave);
          if (!confirmado || !previa) {
            const ficha = fichaDeCambio(m, camino, cuerpo ?? {});
            fichasMostradas.set(clave, { corridaId: ctx.corridaId, ts: reloj() });
            return `Todavía no se aplicó. Explicale esto al Propietario con tus palabras (qué va a poder hacer de verdad, qué pide aprobación y qué queda solo como instrucción) y preguntale si lo confirma:\n${ficha}\nCuando te confirme en un mensaje nuevo, repetí exactamente esta llamada con confirmado: true.`;
          }
          if (previa.corridaId === ctx.corridaId) throw new ErrorHerramienta('El Propietario todavía no vio la ficha: mostrásela y esperá a que conteste antes de confirmar.');
          fichasMostradas.delete(clave);
        }
        let res;
        try { res = await panel({ personaId: ctx.personaId, metodo: m, ruta: r, cuerpo }); } catch (e) { throw new ErrorHerramienta(e.message); }
        if (m !== 'GET') auditar(db, 'panel.agente', { actor: String(ctx.personaId ?? ''), rol: ctx.rol?.nombre, detalle: { metodo: m, ruta: camino, status: res.status } });
        const t = typeof res.datos === 'string' ? res.datos : JSON.stringify(res.datos);
        return `HTTP ${res.status}\n${(t ?? '').slice(0, 15_000)}${t && t.length > 15_000 ? '\n(recortado)' : ''}`;
      },
    },

    numeros: {
      descripcion: 'Solo el Propietario: datos de los números de WhatsApp de la instalación, para razonar y consultarle. Sin "numero": todos, con su política (lo que pidió el Propietario y el resumen), estado del vínculo y los chats que ven varios números (quién los ve, quién puede responder y quién quedó elegido). Con "numero": además, los chats que ve ese número.',
      esquema: { type: 'object', properties: { numero: { type: 'string', description: 'Nombre de la sesión (opcional).' } } },
      async ejecutar(ctx, { numero = null }) {
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario consulta los números.');
        if (!numeros) throw new ErrorHerramienta('Esta instalación maneja un solo número.');
        const lista = await Promise.all(numeros.listar().map(async (f) => {
          let estado = null;
          try { estado = (await numeros.cliente(f.nombre).estado()).status; } catch {}
          return { nombre: f.nombre, etiqueta: f.etiqueta, numero: f.numero, principal: f.principal, estado, politica: f.politica, fuera_de_alcance: f.fuera_de_alcance };
        }));
        const out = { numeros: lista, compartidos: numeros.compartidos() };
        if (numero) {
          if (!numeros.obtener(numero)) throw new ErrorHerramienta(`No existe el número "${numero}".`);
          out.chats_de = numeros.chatsDe(numero);
        }
        return JSON.stringify(out).slice(0, 30_000);
      },
    },

    vincular_numero: {
      descripcion: 'Solo el Propietario, en su charla: sumar y vincular números de WhatsApp sin que tenga que entrar al panel, guiándolo paso a paso. Acciones: "crear" (numero: nombre corto en minúsculas, etiqueta: cómo lo llama) deja el número listo para vincular y mudo; "codigo" (numero, telefono del número nuevo con código de país) genera un código de 8 caracteres para vincular desde el teléfono, que es lo más cómodo; "qr" manda la imagen del QR a esta charla (vence en unos 20 segundos: sirve si lo abre en otra pantalla); "estado" dice si ya quedó vinculado; "quitar" lo desvincula y borra su configuración (pide confirmación en otro mensaje). Cuando quede vinculado te llega [número nuevo vinculado]: ahí armás su política con configurar_sesion.',
      esquema: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['crear', 'codigo', 'qr', 'estado', 'quitar'] },
          numero: { type: 'string', description: 'Nombre corto del número (sesión). Para el principal, su nombre (figura en el contexto).' },
          etiqueta: { type: 'string', description: 'Al crear: cómo lo llama la gente ("empresa", "personal de Ana").' },
          telefono: { type: 'string', description: 'Para "codigo": el teléfono del número que se va a vincular, con código de país.' },
          confirmado: { type: 'boolean', description: 'Para "quitar": true solo después de que el Propietario lo confirme en un mensaje nuevo.' },
        },
        required: ['accion'],
      },
      async ejecutar(ctx, { accion, numero = null, etiqueta = null, telefono = null, confirmado = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, suma o vincula números.');
        if (!numeros) throw new ErrorHerramienta('Esta instalación no maneja varios números.');
        const n = String(numero ?? '').trim().toLowerCase();
        if (accion === 'crear') {
          let nombre;
          try { nombre = await numeros.crear({ nombre: n, etiqueta: etiqueta ?? n }); } catch (e) { throw new ErrorHerramienta(e.message); }
          return `Listo: el número "${etiqueta ?? nombre}" [${nombre}] quedó creado, mudo (no lee, no guarda, no responde) y esperando vincularse. Pedile al Propietario el teléfono de ese número para mandarle un código de vinculación (accion "codigo"), o mandale el QR (accion "qr"). También puede vincularlo en el panel.`;
        }
        const f = numeros.obtener(n);
        if (!f) throw new ErrorHerramienta(`No existe el número "${n}". Los que hay: ${numeros.listar().map((x) => x.nombre).join(', ')}.`);
        const cliente = numeros.cliente(f.nombre);
        let e;
        try { e = await cliente.estado(); } catch (err) { throw new ErrorHerramienta(err.message); }
        if (accion === 'estado') {
          const st = { WORKING: 'vinculado y andando', SCAN_QR_CODE: 'esperando que lo vinculen', STARTING: 'arrancando', STOPPED: 'detenido', FAILED: 'con falla (se reintenta solo)', NO_CREADA: 'preparándose' }[e.status] ?? e.status;
          const tel = String(e?.me?.id ?? '').replace(/@.*$/, '');
          return `"${f.etiqueta ?? f.nombre}": ${st}${tel ? ` (+${tel})` : ''}. Lo que hace: ${f.politica.modo === 'nada' ? 'nada todavía, hay que configurarlo con configurar_sesion' : f.politica.modo}.`;
        }
        if (accion === 'quitar') {
          if (f.principal) throw new ErrorHerramienta('El número principal no se quita (se puede volver a vincular).');
          const clave = `quitar|${ctx.personaId}|${f.nombre}`;
          const previa = fichasMostradas.get(clave);
          if (!confirmado || !previa) {
            fichasMostradas.set(clave, { corridaId: ctx.corridaId, ts: reloj() });
            return `Todavía no se quitó. Contale al Propietario que se desvincula "${f.etiqueta ?? f.nombre}" y se borra su configuración (lo ya guardado de sus chats queda), y preguntale si lo confirma. Si confirma en un mensaje nuevo, repetí con confirmado: true.`;
          }
          if (previa.corridaId === ctx.corridaId) throw new ErrorHerramienta('El Propietario todavía no lo confirmó: esperá su respuesta.');
          fichasMostradas.delete(clave);
          try { await numeros.borrar(f.nombre); } catch (err) { throw new ErrorHerramienta(err.message); }
          return `Listo: "${f.etiqueta ?? f.nombre}" quedó desvinculado y quitado.`;
        }
        if (e.status === 'WORKING') throw new ErrorHerramienta(`"${f.etiqueta ?? f.nombre}" ya está vinculado${e?.me?.id ? ` (+${String(e.me.id).replace(/@.*$/, '')})` : ''}.`);
        if (e.status !== 'SCAN_QR_CODE') {
          try { await cliente.asegurar(); } catch {}
          throw new ErrorHerramienta('El número se está preparando para vincularse: probá de nuevo en unos segundos (accion "estado" para ver cómo va).');
        }
        if (accion === 'codigo') {
          const tel = soloDigitos(telefono ?? '');
          if (tel.length < 8 || tel.length > 15) throw new ErrorHerramienta('Necesito el teléfono del número que se va a vincular, con código de país (por ejemplo 5491112345678).');
          let r;
          try { r = await cliente.pedirCodigo(tel); } catch (err) { throw new ErrorHerramienta(err.message); }
          auditar(db, 'whatsapp.codigo_vinculacion', { actor: String(ctx.personaId ?? ''), detalle: { nombre: f.nombre } });
          return `Código de vinculación: ${r.codigo}. Pasáselo al Propietario con estos pasos, para hacer en el teléfono de ese número: WhatsApp → Ajustes (o los tres puntos) → Dispositivos vinculados → Vincular un dispositivo → "Vincular con el número de teléfono" → escribir el código. Vence en pocos minutos: si no llega a tiempo, pedís otro. Cuando quede, te llega [número nuevo vinculado].`;
        }
        if (accion === 'qr') {
          if (!archivos) throw new ErrorHerramienta('No puedo mandar imágenes en esta instalación.');
          let q;
          try { q = await cliente.qr(); } catch (err) { throw new ErrorHerramienta(err.message); }
          const id = archivos.guardar({ chatId: ctx.chatId, nombre: `qr-${f.nombre}.png`, datos: q.datos, origen: `corrida:${ctx.corridaId}` });
          salida.encolar({ chatId: ctx.chatId, tipo: 'archivo', archivo: { archivoId: id, epigrafe: `QR para vincular "${f.etiqueta ?? f.nombre}". Vence en unos 20 segundos.` }, corridaId: ctx.corridaId, origen: 'vincular_numero' });
          despertarSalida();
          return 'QR enviado a esta charla. Decile que lo abra en otra pantalla (por ejemplo, WhatsApp Web en la compu) y lo escanee desde el teléfono del número nuevo: WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Si vence, pedí otro; si se complica, mejor el código (accion "codigo").';
        }
        throw new ErrorHerramienta('Acción desconocida.');
      },
    },

    configurar_motores: {
      descripcion: 'Solo el Propietario, en su charla: qué motor de IA corre cada tipo de conversación, el respaldo automático y los topes de gasto. Tipos: propietario (su charla), equipo (charlas internas y grupos), terceros (clientes y externos), trabajos, rutinas, y defecto. Motores: claude (su suscripción), claude-api (clave ANTHROPIC_API_KEY, por uso), codex (su cuenta de ChatGPT, o CODEX_API_KEY), gemini (GEMINI_API_KEY de Google AI Studio, con capa gratis), opencode (DeepSeek, MiniMax, Kimi, Qwen, OpenRouter… con modelo "proveedor/modelo" y la clave de ese proveedor, por ejemplo DEEPSEEK_API_KEY). "ver" muestra cómo está, qué falta y lo gastado. "cambiar" (cambios: { tipo: { motor, modelo } | null, respaldo: [{ motor, modelo }, …] (en orden; [] o null lo apaga), topes: { motor: { dia, mes } en dólares | null } }) primero muestra la ficha y pide confirmación en otro mensaje (repetí con confirmado: true). "conectar_chatgpt" manda el link y el código para conectar su cuenta de ChatGPT a Codex. Las claves faltantes pedilas con pedir_variable.',
      esquema: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['ver', 'cambiar', 'conectar_chatgpt'] },
          cambios: { type: 'object', description: 'Por tipo: { "motor": "opencode", "modelo": "deepseek/deepseek-chat" } o null para volver al de por defecto; "respaldo": lista en orden; "topes": { "opencode": { "dia": 5, "mes": 50 } }.' },
          confirmado: { type: 'boolean', description: 'true solo después de que el Propietario confirme la ficha en un mensaje nuevo.' },
        },
        required: ['accion'],
      },
      async ejecutar(ctx, { accion, cambios = null, confirmado = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, elige los motores.');
        if (!motores) throw new ErrorHerramienta('Esta instalación no maneja otros motores.');
        if (accion === 'ver') return `Motores por tipo de conversación:
${motores.ficha()}`;
        if (accion === 'conectar_chatgpt') {
          if (!cuentaCodex) throw new ErrorHerramienta('Codex no está disponible en esta instalación.');
          let l;
          try {
            l = await cuentaCodex.iniciarLogin({ alTerminar: (ok) => despertarPropietarios?.({ origen: 'codex', texto: ok ? '[Codex conectado] La cuenta de ChatGPT quedó conectada: ya se puede usar el motor codex.' : '[Codex sin conectar] El login de ChatGPT terminó sin completarse (venció o se canceló).' }) });
          } catch (e) { throw new ErrorHerramienta(e.message); }
          auditar(db, 'motores.codex_login', { actor: String(ctx.personaId ?? '') });
          return `Pasale al Propietario estos pasos: abrir ${l.url} , entrar con su cuenta de ChatGPT y escribir el código ${l.codigo} (vence en 15 minutos). Avisale que no lo comparta con nadie. Cuando termine, te llega [Codex conectado].`;
        }
        if (accion !== 'cambiar') throw new ErrorHerramienta('Acción desconocida.');
        let v;
        try { v = motores.validar(cambios); } catch (e) { throw new ErrorHerramienta(e.message); }
        if (!Object.keys(v).length) throw new ErrorHerramienta('No hay cambios.');
        const firma = JSON.stringify(v);
        const clave = `motores|${ctx.personaId}`;
        const previa = fichasMostradas.get(clave);
        if (!confirmado || !previa || previa.firma !== firma) {
          fichasMostradas.set(clave, { corridaId: ctx.corridaId, ts: reloj(), firma });
          return `Todavía no se cambió nada. Así quedaría:
${motores.ficha(v)}

Mostráselo al Propietario (con lo que cuesta cada uno y lo que falta cargar) y preguntale si lo confirma. Si confirma en un mensaje nuevo, repetí con los mismos cambios y confirmado: true.`;
        }
        if (previa.corridaId === ctx.corridaId) throw new ErrorHerramienta('El Propietario todavía no lo confirmó: esperá su respuesta.');
        fichasMostradas.delete(clave);
        motores.configurar(v);
        auditar(db, 'motores.configurar', { actor: String(ctx.personaId ?? ''), detalle: v });
        bitacora?.anotar({ personaId: ctx.personaId, chatId: ctx.chatId, donde: 'charla', resultado: 'hecho', que: `motores: ${Object.entries(v).map(([t, a]) => `${t} → ${a ? `${a.motor}${a.modelo ? ` (${a.modelo})` : ''}` : 'por defecto'}`).join(', ')}`, ref: 'configurar_motores' });
        return `Listo, quedó así:
${motores.ficha()}
Las charlas que cambian de motor arrancan una conversación nueva (con la memoria de siempre).`;
      },
    },

    configurar_sesion: {
      descripcion: 'Solo el Propietario, en su charla: guarda lo que el Propietario quiere que hagas con un número de WhatsApp. Va su pedido con sus palabras (politica.texto) y el resumen mínimo que hace cumplir el gateway: modo (responder | leer | avisos | nada), qué chats entran (todos | grupos | directos | clientes | lista, con "lista" y "excluir" de JIDs), si se guardan y cuántos días, si escribe primero (segun_rol | no), conectores (lista o null = los del rol) y notas (instrucciones tuyas, no bloqueos). También qué número responde en un chat compartido (responde_en). Te devuelve la ficha: explicásela y aplicala recién cuando confirme en un mensaje nuevo (misma llamada con confirmado: true); eso lo exige el sistema.',
      esquema: {
        type: 'object',
        properties: {
          numero: { type: 'string', description: 'Nombre de la sesión (el que figura entre corchetes en el contexto).' },
          politica: { type: 'object', description: 'Solo lo que cambia: { texto, modo, chats, lista, excluir, guardar, dias, escribir_primero, conectores, notas }. "texto": lo que pidió el Propietario, con sus palabras (se guarda tal cual). El resto es el resumen mínimo que hace cumplir el gateway.' },
          etiqueta: { type: 'string', description: 'Cómo lo llama la gente ("empresa", "personal de Ana").' },
          responde_en: { type: 'array', items: { type: 'object', properties: { chat: { type: 'string' }, numero: { type: ['string', 'null'] } } }, description: 'Qué número responde en cada chat compartido (numero: null = ninguno elegido).' },
          confirmado: { type: 'boolean', description: 'true solo después de mostrarle la ficha al Propietario y que confirme en un mensaje nuevo.' },
        },
      },
      ejecutar(ctx, { numero = null, politica = null, etiqueta = null, responde_en = [], confirmado = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, define qué hace cada número.');
        if (!numeros) throw new ErrorHerramienta('Esta instalación no maneja varios números.');
        const n = numero ? String(numero).trim() : null;
        if (n && !numeros.obtener(n)) throw new ErrorHerramienta(`No existe el número "${n}". Los que hay: ${numeros.listar().map((f) => f.nombre).join(', ')}.`);
        if (!n && !responde_en.length) throw new ErrorHerramienta('Decime qué número configurar (numero) o en qué chats elegir quién responde (responde_en).');
        const lineas = [];
        try {
          if (n && (politica || etiqueta)) lineas.push(numeros.ficha(n, politica ?? {}));
        } catch (e) { throw new ErrorHerramienta(e.message); }
        for (const r of responde_en) lineas.push(`- En ${r.chat}: ${r.numero ? `responde "${numeros.obtener(r.numero)?.etiqueta ?? r.numero}"` : 'no responde ningún número'}.`);
        const clave = `numero|${ctx.personaId}|${JSON.stringify({ n, politica, etiqueta, responde_en })}`;
        const previa = fichasMostradas.get(clave);
        if (!confirmado || !previa) {
          fichasMostradas.set(clave, { corridaId: ctx.corridaId, ts: reloj() });
          return `Todavía no se aplicó. Explicale esto al Propietario con tus palabras y preguntale si lo confirma:\n${lineas.join('\n')}\nCuando confirme en un mensaje nuevo, repetí exactamente esta llamada con confirmado: true.`;
        }
        if (previa.corridaId === ctx.corridaId) throw new ErrorHerramienta('El Propietario todavía no vio la ficha: mostrásela y esperá a que conteste.');
        fichasMostradas.delete(clave);
        try {
          if (n && (politica || etiqueta)) numeros.configurar(n, politica ?? {}, { actor: ctx.personaId, etiqueta });
          for (const r of responde_en) numeros.elegirEnChat(String(r.chat), r.numero ?? null, ctx.personaId);
        } catch (e) { throw new ErrorHerramienta(e.message); }
        return 'Listo, quedó aplicado. Revisá con la herramienta numeros si quedó algún chat compartido para definir con el Propietario.';
      },
    },

    importar_paquete: {
      descripcion: 'Solo el Propietario, en su charla: trae trabajo previo (clientes, proyectos, personas y sus roles, grupos, memoria, lecciones, rutinas, y la lista de secretos y conectores que hacen falta) desde un paquete JSON (formato en docs/IMPORTAR.md). Primero ensaya y te devuelve qué crea, actualiza u omite: contáselo al Propietario y aplicalo recién cuando confirme en un mensaje nuevo (misma llamada con confirmado: true). Es idempotente: lo que ya está no se duplica. Nunca pongas valores de secretos en el paquete. Si el Propietario trae material suelto (un CLAUDE.md, notas, planillas, un cron, un repo), armá vos el paquete: clasificá la memoria por alcance y sección, uní lo repetido, descartá lo vencido y preguntá lo que no esté claro.',
      esquema: {
        type: 'object',
        properties: {
          paquete: { type: 'object', description: 'El paquete JSON (superagent: 1, ...).' },
          archivo: { type: 'string', description: 'O la ruta de un .json dentro de tu entorno (por ejemplo en tu carpeta de trabajo).' },
          confirmado: { type: 'boolean', description: 'true solo después de mostrarle el ensayo al Propietario y que confirme en un mensaje nuevo.' },
        },
      },
      ejecutar(ctx, { paquete = null, archivo = null, confirmado = false }) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario, en su charla, importa paquetes.');
        if (!paquetes) throw new ErrorHerramienta('La importación no está disponible.');
        let p = paquete;
        if (!p && archivo) {
          const base = ctx.rutas?.base ? path.resolve(ctx.rutas.base) : null;
          const ruta = base ? path.resolve(base, String(archivo)) : null;
          if (!ruta || !ruta.startsWith(base + path.sep)) throw new ErrorHerramienta('El archivo tiene que estar dentro de tu entorno.');
          let crudo;
          try { crudo = aislamiento ? aislamiento.leerComo(ctx.usuario, ruta) : null; } catch (e) { throw new ErrorHerramienta(e.message); }
          if (!crudo) throw new ErrorHerramienta('No se pudo leer el archivo.');
          if (crudo.length > 5 * 1024 * 1024) throw new ErrorHerramienta('El paquete pesa más de 5 MB: partilo en varios.');
          try { p = JSON.parse(String(crudo)); } catch { throw new ErrorHerramienta('El archivo no es un JSON válido.'); }
        }
        if (!p) throw new ErrorHerramienta('Pasame el paquete (paquete) o la ruta del archivo (archivo).');
        const actor = { personaId: ctx.personaId, permisos: ctx.rol?.permisos };
        const huella = `paquete|${ctx.personaId}|${huellaPaquete(p)}`;
        try {
          const previa = fichasMostradas.get(huella);
          if (!confirmado || !previa) {
            const plan = paquetes.ensayar(p, actor);
            fichasMostradas.set(huella, { corridaId: ctx.corridaId, ts: reloj() });
            return `${paquetes.resumen(plan)}\n\nContale esto al Propietario (sin pegarlo entero: lo importante, lo que se actualiza y lo que hay que revisar) y preguntale si lo importás. Cuando confirme en un mensaje nuevo, repetí esta llamada con confirmado: true.`;
          }
          if (previa.corridaId === ctx.corridaId) throw new ErrorHerramienta('El Propietario todavía no vio el ensayo: mostráselo y esperá a que conteste.');
          const plan = paquetes.importar(p, actor);
          fichasMostradas.delete(huella);
          const faltan = [...plan.faltan.secretos.map((s) => s.nombre), ...plan.faltan.conectores.map((c) => c.nombre)];
          return `${paquetes.resumen(plan, { aplicado: true })}${faltan.length ? '\n\nAhora pedile lo que falta, de a uno: los secretos con pedir_variable y los conectores con agregar_conector (o el link del panel).' : ''}`;
        } catch (e) {
          throw e instanceof ErrorHerramienta ? e : new ErrorHerramienta(e.message);
        }
      },
    },

    exportar_paquete: {
      descripcion: 'Solo el Propietario: exporta la configuración (clientes, proyectos, personas, grupos, memoria, lecciones, rutinas y los nombres de secretos y conectores, nunca sus valores) como paquete JSON en tu carpeta de salida, para respaldo o para mudarla a otra instalación. Mandalo con enviar_archivo si lo pide.',
      esquema: { type: 'object', properties: {} },
      ejecutar(ctx) {
        if (ctx.decidir('aprobar').decision !== 'permitir' || !ctx.completo) throw new ErrorHerramienta('Solo el Propietario exporta la configuración.');
        if (!paquetes) throw new ErrorHerramienta('La exportación no está disponible.');
        if (!ctx.rutas?.salida) throw new ErrorHerramienta('Esta corrida no tiene carpeta de salida.');
        const p = paquetes.exportar();
        const nombre = `superagent-${new Date(reloj()).toISOString().slice(0, 10)}.json`;
        const ruta = path.join(ctx.rutas.salida, nombre);
        try {
          // La carpeta la arma la corrida; si no está (corrida sin preparar), se crea.
          if (!fs.existsSync(ctx.rutas.salida)) fs.mkdirSync(ctx.rutas.salida, { recursive: true });
          aislamiento?.escribirArchivo(ruta, JSON.stringify(p, null, 2), ctx.usuario);
        } catch (e) { throw new ErrorHerramienta(e.message); }
        auditar(db, 'paquete.exportar', { actor: String(ctx.personaId ?? '') });
        const n = (k) => (Array.isArray(p[k]) ? p[k].length : 0);
        return `Listo: ${ruta} (${n('clientes')} clientes, ${n('proyectos')} proyectos, ${n('personas')} personas, ${n('chats')} chats, ${n('memoria')} notas de memoria, ${n('lecciones')} lecciones, ${n('rutinas')} rutinas; secretos y conectores solo por nombre).`;
      },
    },

    pedir_variable: {
      descripcion: 'Pide al Propietario una clave, token o dato secreto como variable de entorno (por ejemplo VERCEL_TOKEN). El gateway le manda un link al panel para cargarla; nunca la pidas ni la aceptes por el chat. Queda cifrada y disponible en tus corridas del Propietario como variable de entorno.',
      esquema: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre de la variable, en mayúsculas (VERCEL_TOKEN, MP_ACCESS_TOKEN).' },
          para: { type: 'string', description: 'Para qué la necesitás y dónde se saca, en una o dos frases.' },
        },
        required: ['nombre', 'para'],
      },
      ejecutar(ctx, { nombre, para }) {
        if (!entorno) throw new ErrorHerramienta('Las variables de entorno no están disponibles.');
        if (ctx.decidir('aprobar').decision !== 'permitir') throw new ErrorHerramienta('Solo el Propietario carga variables de entorno.');
        let p;
        try { p = entorno.pedir({ nombre, para, chatId: ctx.chatId }); } catch (e) { throw new ErrorHerramienta(e.message); }
        // El link lo manda el gateway (el agente no lo arma): al WhatsApp del Propietario o al chat del panel.
        salida.encolar({ chatId: ctx.chatId, texto: `Para cargar *${p.nombre}* de forma segura (sin pegarla en el chat), abrí este link del panel. Vence en 30 minutos:\n${entorno.link(p.id)}`, origen: 'entorno' });
        despertarSalida();
        return `Le mandé al Propietario el link para cargar ${p.nombre}. Cuando la cargue te llega un aviso del gateway; desde la próxima corrida está en tu entorno. No le pidas el valor por el chat.`;
      },
    },

    conectar_app: {
      descripcion: 'Conecta una app de la instalación (por ahora: github). El gateway le manda a la persona el link oficial y el código; vos no los ves ni los repetís.',
      esquema: { type: 'object', properties: { app: { type: 'string', enum: ['github'] } }, required: ['app'] },
      async ejecutar(ctx) {
        exigir(ctx, 'conectar_cuentas');
        const persona = ctx.personaOrigen ?? ctx.personaId;
        const destino = esGrupo(ctx.chatId) ? chatDePersona(persona) : ctx.chatId;
        try { await github.conectarPorDispositivo({ chatId: destino, personaId: persona }); } catch (e) { throw new ErrorHerramienta(e.message); }
        return 'Le mandé a la persona el link de GitHub y el código para autorizar. Cuando lo haga, te llega el aviso.';
      },
    },

    subir_rama: {
      descripcion: 'Sube la rama de este trabajo al repo remoto (nunca la principal). Antes commiteá en tu clon.',
      esquema: { type: 'object', properties: {} },
      async ejecutar(ctx) {
        exigir(ctx, 'editar_codigo');
        if (!ctx.trabajo?.proyecto_id) throw new ErrorHerramienta('Subir ramas se hace desde un trabajo con proyecto.');
        try {
          await repos.importarRama(ctx.trabajo.proyecto_id, { dirRepo: path.join(ctx.rutas.trabajo, 'repo'), usuario: ctx.usuario, rama: ctx.trabajo.rama });
          await repos.subirRama(ctx.trabajo.proyecto_id, ctx.trabajo.rama);
        } catch (e) { throw new ErrorHerramienta(e.message); }
        auditar(db, 'codigo.subir_rama', { actor: String(ctx.personaOrigen ?? ''), rol: ctx.rol?.nombre, detalle: { trabajo: ctx.trabajo.id, rama: ctx.trabajo.rama } });
        return `Rama ${ctx.trabajo.rama} subida.`;
      },
    },

    abrir_pr: {
      descripcion: 'Abre un pull request de la rama de este trabajo contra la rama principal (subí la rama antes).',
      esquema: { type: 'object', properties: { titulo: { type: 'string' }, descripcion: { type: 'string' } }, required: ['titulo'] },
      async ejecutar(ctx, { titulo, descripcion }) {
        exigir(ctx, 'editar_codigo');
        if (!ctx.trabajo?.proyecto_id) throw new ErrorHerramienta('Los PR se abren desde un trabajo con proyecto.');
        const p = repos.proyecto(ctx.trabajo.proyecto_id);
        if (!repos.esGithub(p)) return `Este repo no es de GitHub: la rama ${ctx.trabajo.rama} queda lista para publicar con publicar (rama "${ctx.trabajo.rama}").`;
        try {
          const pr = await github.crearPr(p.repo, { titulo: texto(titulo, 200), rama: ctx.trabajo.rama, base: p.rama_principal, cuerpo: texto(descripcion, 20_000) });
          return `PR #${pr.number} abierto: ${pr.html_url}`;
        } catch (e) { throw new ErrorHerramienta(e.message); }
      },
    },

    publicar: {
      descripcion: 'Publica un cambio: merge del PR (o de la rama) a la principal. Si tu rol lo pide con aprobación, el Propietario recibe el resumen y un link con el diff.',
      esquema: {
        type: 'object',
        properties: {
          proyecto: { type: 'string' }, pr: { type: 'number', description: 'Número del PR (repos de GitHub).' },
          rama: { type: 'string', description: 'Rama a publicar (repos que no son de GitHub).' }, resumen: { type: 'string' },
        },
        required: ['resumen'],
      },
      async ejecutar(ctx, { proyecto, pr, rama, resumen }) {
        const d = exigir(ctx, 'publicar');
        let p = null;
        try { p = repos.proyecto(proyecto ?? ctx.trabajo?.proyecto_id); } catch { /* sin proyecto con repo */ }
        const ramaFinal = rama ?? ctx.trabajo?.rama ?? null;
        const datos = { proyecto: p?.id ?? texto(proyecto, 80) ?? null, pr: pr ?? null, rama: ramaFinal, resumen: texto(resumen, 2000) };
        if (p) {
          // Como mucho 3 rondas de revisión por cambio.
          const rechazadas = db.prepare("SELECT datos FROM aprobaciones WHERE accion = 'publicar' AND estado = 'rechazada'").all()
            .filter((a) => { const x = json(a.datos, {}); return x.proyecto === p.id && (x.pr ?? x.rama) === (pr ?? ramaFinal); }).length;
          if (rechazadas >= 3) throw new ErrorHerramienta('Este cambio ya tuvo 3 rondas de revisión rechazadas: pedile al Propietario que lo revise directamente.');
          if (d === 'con_aprobacion') {
            let diff = { stat: `Deploy de la rama principal (${p.rama_principal}) con el procedimiento del proyecto.`, diff: '' };
            if (pr || ramaFinal) try {
              const r = repos.esGithub(p) && pr ? (await github.pr(p.repo, pr)).head.ref : ramaFinal;
              diff = await repos.diff(p.id, r);
            } catch (e) { diff = { stat: `(no se pudo armar el diff: ${e.message})`, diff: '' }; }
            const a = aprobaciones.pedir({
              tipo: 'publicar_sistema', accion: 'publicar', pedidaPor: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
              detalle: `publicar en ${p.nombre}${pr ? ` el PR #${pr}` : ramaFinal ? ` la rama ${ramaFinal}` : ''}: ${texto(resumen, 400)}\n${diff.stat}`,
              datos: { ...datos, ronda: rechazadas + 1 }, diff: diff.diff, enlace: true,
            });
            return `Pendiente de aprobación ${a}: el Propietario recibió el resumen y el link con el diff.`;
          }
          try { return await publicarAhora(datos, { pedidaPor: ctx.personaOrigen ?? ctx.personaId }); } catch (e) { throw new ErrorHerramienta(e.message); }
        }
        if (d === 'con_aprobacion') {
          const a = aprobaciones.pedir({
            tipo: 'publicar_sistema', accion: 'publicar', pedidaPor: ctx.personaOrigen ?? ctx.personaId, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
            detalle: `publicar${proyecto ? ` ${texto(proyecto, 80)}` : ''}: ${texto(resumen, 400)}`, datos,
          });
          return `Pendiente de aprobación ${a}: publicar necesita el ok del Propietario.`;
        }
        throw new ErrorHerramienta('No hay un proyecto con repo para publicar. Cargalo en el panel (Agente → Proyectos).');
      },
    },

    cambiar_instrucciones: {
      descripcion: 'Propone una versión nueva de tus instrucciones (se suman a las base). Si tu rol lo pide con aprobación, el Propietario ve el cambio y lo aprueba.',
      esquema: { type: 'object', properties: { contenido: { type: 'string', description: 'El texto completo de las instrucciones nuevas.' }, motivo: { type: 'string' } }, required: ['contenido'] },
      ejecutar(ctx, { contenido, motivo }) {
        const d = exigir(ctx, 'cambiar_instrucciones');
        const nuevo = texto(contenido, 20_000);
        if (nuevo.length < 10) throw new ErrorHerramienta('Las instrucciones están vacías.');
        const actual = db.prepare('SELECT contenido FROM instrucciones WHERE activa = 1 ORDER BY version DESC LIMIT 1').get()?.contenido ?? '';
        const version = (db.prepare('SELECT MAX(version) AS v FROM instrucciones').get().v ?? 0) + 1;
        const autor = ctx.personaOrigen ?? ctx.personaId;
        db.prepare('INSERT INTO instrucciones (version, contenido, pedida_por, activa) VALUES (?, ?, ?, 0)').run(version, nuevo, autor);
        if (d === 'permitir') {
          activarInstrucciones(version, autor);
          return `Instrucciones v${version} activas.`;
        }
        const a = aprobaciones.pedir({
          tipo: 'cambiar_agente', accion: 'instrucciones', pedidaPor: autor, chatOrigen: ctx.chatId, corridaId: ctx.corridaId,
          detalle: `instrucciones v${version}${motivo ? `: ${texto(motivo, 300)}` : ''}`, datos: { version }, diff: diffTexto(actual, nuevo), enlace: true,
        });
        return `Pendiente de aprobación ${a}: el Propietario ve el cambio y lo aprueba.`;
      },
    },

    terminar_onboarding: {
      descripcion: 'Cierra la conversación de configuración inicial y guarda el nombre del agente y la zona horaria.',
      esquema: { type: 'object', properties: { nombre_agente: { type: 'string' }, zona_horaria: { type: 'string' } } },
      ejecutar(ctx, { nombre_agente, zona_horaria }) {
        if (ctx.variante !== 'onboarding') throw new ErrorHerramienta('No hay una configuración inicial en curso.');
        if (zona_horaria && !zonaValida(zona_horaria)) throw new ErrorHerramienta(`Zona horaria inválida: ${zona_horaria}.`);
        if (nombre_agente) ajustes.set('nombre_agente', texto(nombre_agente, 40));
        if (zona_horaria) ajustes.set('zona_horaria', zona_horaria);
        ajustes.set('onboarding_hecho', '1');
        auditar(db, 'onboarding.terminar', { actor: String(ctx.personaId ?? '') });
        return 'Listo: la configuración inicial quedó cerrada.';
      },
    },
  };
}
