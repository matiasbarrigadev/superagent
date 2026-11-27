// "Ver al agente": cada paso de una corrida (lo que dice, las herramientas que llama y lo que le devuelven), con un
// título en palabras simples, para mostrarlo en el panel como una conversación y no como una terminal.
// La privacidad va acá, en código: antes de guardar se tachan los valores de las variables del entorno y todo lo que
// tenga forma de token, se recortan las salidas y no se guarda el contenido de archivos sensibles.
import { tachar } from '../codigo/procedimiento.mjs';
import { tacharTokens } from './esperas.mjs';

const MAX_DETALLE = 1500;
const DIAS = 30;
const SENSIBLE = /(^|\/)(\.env[^/]*|\.netrc|\.npmrc|\.pypirc|credentials?(\.json)?|secrets?\b[^/]*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|hosts\.yml|auth\.json|access-token|\.git-credentials)$/i;

const corto = (t, n = 80) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const base = (p) => String(p ?? '').split(/[\\/]/).pop();

/** Nombre corto del conector o servidor de un mcp__x__y. */
function partesMcp(nombre) {
  const m = /^mcp__(.+?)__(.+)$/.exec(nombre ?? '');
  return m ? { servidor: m[1], herramienta: m[2] } : null;
}

/** Título y categoría de una llamada, en palabras simples (como lo contaría una persona). */
export function describirHerramienta(nombre, entrada = {}) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const mcp = partesMcp(nombre);
  if (mcp?.servidor === 'superagent') {
    const h = mcp.herramienta;
    const tabla = {
      responder: ['Respondió', 'responder'], reaccionar: ['Reaccionó a un mensaje', 'responder'], enviar_archivo: ['Mandó un archivo', 'responder'],
      enviar_audio: ['Mandó un audio', 'responder'], enviar_encuesta: ['Mandó una encuesta', 'responder'], enviar_ubicacion: ['Mandó una ubicación', 'responder'],
      enviar_contacto: ['Mandó un contacto', 'responder'], editar_mensaje: ['Editó un mensaje', 'responder'], borrar_mensaje: ['Borró un mensaje', 'responder'],
      iniciar_conversacion: ['Le escribió a alguien', 'responder'], no_responder: ['Decidió no responder', 'decision'],
      guardar_memoria: ['Guardó algo en memoria', 'memoria'], guardar_leccion: ['Anotó una lección', 'memoria'], anotar_decision: ['Anotó una decisión', 'decision'],
      decidir: ['Decidió un pedido', 'decision'], preguntar_al_propietario: ['Le consultó al Propietario', 'decision'],
      delegar_trabajo: ['Lanzó un trabajo en segundo plano', 'trabajo'], estado_de_trabajo: ['Miró un trabajo', 'trabajo'],
      programar_rutina: ['Programó una rutina', 'rutina'], rutinas: ['Revisó las rutinas', 'rutina'],
      agregar_conector: ['Agregó un conector', 'conexion'], conectar_app: ['Pidió conectar una cuenta', 'conexion'], esperar_autorizacion: ['Quedó esperando una autorización', 'conexion'],
      pedir_variable: ['Pidió una clave', 'conexion'], panel: ['Usó el panel', 'configuracion'], reiniciar_contexto: ['Empezó un contexto nuevo', 'configuracion'],
    };
    const [titulo, tipo] = tabla[h] ?? [`Usó ${h.replace(/_/g, ' ')}`, 'gateway'];
    const extra = h === 'responder' ? corto(e.texto, 120) : h === 'no_responder' ? corto(e.motivo, 160) : h === 'iniciar_conversacion' ? corto(e.chat ?? e.telefono, 40) : '';
    return { titulo: extra && h !== 'responder' ? `${titulo}: ${extra}` : titulo, tipo, resumen: h === 'responder' ? extra : null };
  }
  if (mcp) return { titulo: `Usó ${mcp.servidor.replace(/^conector_?/, '')}: ${mcp.herramienta.replace(/_/g, ' ')}`, tipo: 'conector' };
  switch (nombre) {
    case 'Bash': return { titulo: `Ejecutó un comando${e.description ? `: ${corto(e.description, 80)}` : ''}`, tipo: 'comando', resumen: corto(e.command, 160) };
    case 'BashOutput': case 'KillShell': case 'KillBash': return { titulo: 'Miró un proceso en segundo plano', tipo: 'comando' };
    case 'Read': return { titulo: `Leyó ${base(e.file_path) || 'un archivo'}`, tipo: 'archivo' };
    case 'Write': return { titulo: `Escribió ${base(e.file_path) || 'un archivo'}`, tipo: 'archivo' };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { titulo: `Editó ${base(e.file_path ?? e.notebook_path) || 'un archivo'}`, tipo: 'archivo' };
    case 'Glob': case 'Grep': case 'LS': return { titulo: `Buscó en archivos${e.pattern ? `: ${corto(e.pattern, 60)}` : ''}`, tipo: 'archivo' };
    case 'WebSearch': return { titulo: `Buscó en la web: ${corto(e.query, 80)}`, tipo: 'web' };
    case 'WebFetch': return { titulo: `Leyó una página: ${corto(e.url, 80)}`, tipo: 'web' };
    case 'Task': case 'Agent': return { titulo: `Lanzó un subagente${e.description ? `: ${corto(e.description, 60)}` : ''}`, tipo: 'trabajo' };
    case 'TodoWrite': return { titulo: 'Actualizó su lista de tareas', tipo: 'plan' };
    case 'Skill': return { titulo: `Usó una habilidad${e.skill ? `: ${e.skill}` : ''}`, tipo: 'plan' };
    default: return { titulo: `Usó ${String(nombre ?? 'una herramienta').replace(/_/g, ' ')}`, tipo: 'otro' };
  }
}

/** Resumen de un turno al estilo "Recibió un mensaje, ejecutó 2 comandos y respondió". */
export function resumirTurno(pasos, { disparo = null } = {}) {
  const cuenta = new Map();
  for (const p of pasos) if (p.tipo === 'herramienta') cuenta.set(p.categoria, (cuenta.get(p.categoria) ?? 0) + 1);
  const n = (k) => cuenta.get(k) ?? 0;
  const partes = [];
  if (disparo) partes.push(disparo);
  const plural = (k, uno, varios) => (n(k) ? (n(k) === 1 ? uno : varios.replace('#', n(k))) : null);
  for (const t of [
    plural('comando', 'ejecutó un comando', 'ejecutó # comandos'), plural('archivo', 'tocó un archivo', 'tocó # archivos'),
    plural('web', 'buscó en la web', 'buscó en la web # veces'), plural('conector', 'usó un conector', 'usó conectores # veces'),
    plural('trabajo', 'lanzó un trabajo', 'lanzó # trabajos'), plural('memoria', 'guardó en memoria', 'guardó en memoria # veces'),
    plural('conexion', 'gestionó una conexión', 'gestionó # conexiones'), plural('configuracion', 'cambió la configuración', 'cambió la configuración # veces'),
    plural('rutina', 'tocó una rutina', 'tocó # rutinas'), plural('gateway', 'usó una herramienta', 'usó # herramientas'),
    plural('otro', 'usó una herramienta', 'usó # herramientas'),
  ]) if (t) partes.push(t);
  if (pasos.some((p) => p.nombre?.endsWith('__no_responder'))) partes.push('decidió no responder');
  else if (n('responder')) partes.push(n('responder') === 1 ? 'respondió' : `mandó ${n('responder')} mensajes`);
  if (!partes.length) return 'Pensó sin usar herramientas';
  const t = partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}` : partes[0];
  return t[0].toUpperCase() + t.slice(1);
}

export function crearActividad({ db, entorno = null, reloj = () => Date.now(), log = console }) {
  // Valores de las variables del entorno, para tacharlos (se leen cada tanto, no en cada paso).
  let secretos = [], leidos = 0;
  function valoresSecretos() {
    if (!entorno || reloj() - leidos < 60_000) return secretos;
    leidos = reloj();
    try { secretos = Object.values(entorno.variables()).filter((v) => String(v).length >= 6); } catch { secretos = []; }
    return secretos;
  }
  const limpiar = (t, n = MAX_DETALLE) => {
    const s = tacharTokens(tachar(String(t ?? ''), valoresSecretos()));
    return s.length > n ? `${s.slice(0, n)}\n… (recortado)` : s;
  };

  // Qué herramienta abrió cada id (para saber si la salida es de un archivo sensible).
  const abiertas = new Map();
  const escuchas = new Set();
  let ultimaPoda = 0;

  /** Guarda un paso de una corrida. paso: {tipo: 'texto'|'herramienta'|'resultado', ...}. */
  function registrar(corridaId, paso) {
    if (!corridaId || !paso) return;
    try {
      const ts = reloj();
      let fila;
      if (paso.tipo === 'texto') {
        const t = String(paso.texto ?? '').trim();
        if (!t) return;
        fila = { tipo: 'texto', nombre: null, titulo: null, categoria: null, detalle: limpiar(t, 4000), error: 0, ref: null };
      } else if (paso.tipo === 'herramienta') {
        const d = describirHerramienta(paso.nombre, paso.entrada);
        const ruta = paso.entrada?.file_path ?? paso.entrada?.notebook_path ?? '';
        if (paso.ref) abiertas.set(paso.ref, { sensible: SENSIBLE.test(String(ruta)), corrida: corridaId });
        const entrada = paso.entrada && Object.keys(paso.entrada).length ? JSON.stringify(paso.entrada, null, 1) : '';
        fila = { tipo: 'herramienta', nombre: paso.nombre ?? null, titulo: limpiar(d.titulo, 200), categoria: d.tipo, detalle: entrada ? limpiar(entrada) : null, resumen: d.resumen ? limpiar(d.resumen, 300) : null, error: 0, ref: paso.ref ?? null };
      } else if (paso.tipo === 'resultado') {
        const a = paso.ref ? abiertas.get(paso.ref) : null;
        if (paso.ref) abiertas.delete(paso.ref);
        const salida = a?.sensible ? '(contenido de un archivo sensible: no se muestra)' : limpiar(paso.salida);
        fila = { tipo: 'resultado', nombre: null, titulo: null, categoria: null, detalle: salida, error: paso.error ? 1 : 0, ref: paso.ref ?? null };
      } else return;
      const id = Number(db.prepare(`INSERT INTO corrida_pasos (corrida_id, ts, tipo, nombre, titulo, categoria, detalle, resumen, error, ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(corridaId, ts, fila.tipo, fila.nombre, fila.titulo, fila.categoria, fila.detalle, fila.resumen ?? null, fila.error, fila.ref).lastInsertRowid);
      avisar({ evento: 'paso', id, corrida_id: corridaId, ts, ...fila });
    } catch (e) {
      log.warn?.('[actividad]', e.message);
    }
  }

  /** Se borran los pasos viejos (los turnos quedan; el detalle no hace falta para siempre). */
  function podar() {
    if (reloj() - ultimaPoda < 60 * 60_000) return;
    ultimaPoda = reloj();
    db.prepare('DELETE FROM corrida_pasos WHERE ts < ?').run(reloj() - DIAS * 24 * 60 * 60_000);
  }

  function pasos(corridaId) {
    return db.prepare('SELECT id, ts, tipo, nombre, titulo, categoria, detalle, resumen, error, ref FROM corrida_pasos WHERE corrida_id = ? ORDER BY id').all(corridaId);
  }

  /** Suscribirse a lo que pasa (pasos nuevos, turnos que empiezan o terminan), para verlo en vivo. */
  function escuchar(f) { escuchas.add(f); return () => escuchas.delete(f); }
  function avisar(e) { for (const f of escuchas) { try { f(e); } catch {} } }
  /** Un turno empezó o terminó (lo avisa el motor). */
  function turno(tipo, corridaId) { avisar({ evento: 'turno', tipo, corrida_id: corridaId, ts: reloj() }); }

  return { registrar, pasos, podar, escuchar, turno, limpiarTexto: limpiar, describirHerramienta, resumirTurno };
}
