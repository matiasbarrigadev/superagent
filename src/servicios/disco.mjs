// Disco: cuánto ocupa el volumen de datos, qué es lo que ocupa, limpieza automática y aviso al llenarse.
// La limpieza toca solo lo que se puede volver a generar o ya cumplió su función: carpetas de trabajos terminados,
// adjuntos y archivos enviados viejos (queda su texto extraído), temporales y grabaciones de prueba. Nunca la base,
// los secretos, las conversaciones en curso ni el entorno del Propietario (eso lo ordena el agente, con criterio).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIA = 86_400_000;
const GB = 1024 ** 3;
export const legible = (b) => (b == null ? '—' : b >= GB ? `${(b / GB).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${Math.max(0, Math.round(b / 1024))} KB`);

/** Tamaño de una carpeta o archivo en bytes (du en Linux; recorrido en otros sistemas). */
export function tamanoDe(ruta) {
  if (!fs.existsSync(ruta)) return 0;
  if (process.platform === 'linux') {
    try { return Number(execFileSync('du', ['-sb', '--', ruta], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\t')[0]) || 0; } catch { /* sigue con el recorrido */ }
  }
  let total = 0;
  const pila = [ruta];
  while (pila.length) {
    const r = pila.pop();
    let st;
    try { st = fs.lstatSync(r); } catch { continue; }
    if (st.isDirectory()) { try { for (const n of fs.readdirSync(r)) pila.push(path.join(r, n)); } catch {} } else total += st.size;
  }
  return total;
}

function volumenReal(dir) {
  const s = fs.statfsSync(dir);
  const total = s.blocks * s.bsize;
  const libre = s.bavail * s.bsize;
  return { total, libre, usado: total - s.bfree * s.bsize };
}

export function crearDisco({ db, config, ajustes, aislamiento = null, avisos = null, despertarPropietarios = null, volumen = volumenReal, medir = tamanoDe, reloj = () => Date.now(), log = console }) {
  const dir = config.dataDir;
  let cache = { en: 0, datos: null };

  const conf = () => ({
    diasAdjuntos: ajustes.num('disco_dias_adjuntos', 90),
    umbral: ajustes.num('disco_umbral_pct', 80),
    automatica: ajustes.bool('disco_limpieza_auto', true),
  });

  /** Total, usado y porcentaje del volumen. Si el disco no dice su tamaño, se usa el límite configurado. */
  function estadoVolumen() {
    let v;
    try { v = volumen(dir); } catch { v = { total: 0, libre: 0, usado: 0 } }
    const limite = Number(process.env.SUPERAGENT_DISCO_LIMITE_GB || 0) * GB;
    const total = limite || v.total;
    const usado = limite ? Math.min(medir(dir), total) : v.usado;
    return { total, usado, libre: Math.max(0, total - usado), pct: total ? Math.round((usado / total) * 1000) / 10 : null };
  }

  /** Qué ocupa: cada conversación o trabajo (con su nombre), y las carpetas del gateway. Con caché de 10 minutos. */
  function desglose({ fresco = false } = {}) {
    if (!fresco && cache.datos && reloj() - cache.en < 10 * 60_000) return cache.datos;
    const partes = [];
    const aislados = path.join(dir, 'aislados');
    if (aislamiento && fs.existsSync(aislados)) {
      const conocidas = new Map(db.prepare('SELECT clave FROM usuarios_so').all().map((f) => [path.basename(aislamiento.rutas(f.clave).base), f.clave]));
      for (const n of fs.readdirSync(aislados)) {
        const clave = conocidas.get(n) ?? null;
        partes.push({ tipo: tipoDeClave(clave), clave, nombre: nombreDeClave(clave), tamano: medir(path.join(aislados, n)) });
      }
    }
    for (const [sub, tipo, nombre] of [['adjuntos', 'adjuntos', 'Adjuntos de WhatsApp'], ['salientes', 'salientes', 'Archivos enviados'], ['repos', 'repos', 'Copias de los repos'], ['grabaciones', 'grabaciones', 'Grabaciones de webhooks']]) {
      const t = medir(path.join(dir, sub));
      if (t) partes.push({ tipo, clave: null, nombre, tamano: t });
    }
    const base = ['superagent.db', 'superagent.db-wal', 'superagent.db-shm'].reduce((s, f) => s + medir(path.join(dir, f)), 0);
    partes.push({ tipo: 'base', clave: null, nombre: 'Base de datos', tamano: base });
    partes.sort((a, b) => b.tamano - a.tamano);
    cache = { en: reloj(), datos: partes };
    return partes;
  }

  function tipoDeClave(clave) {
    if (!clave) return 'otro';
    if (clave === 'propietario') return 'propietario';
    return clave.split(':')[0];
  }
  function nombreDeClave(clave) {
    if (!clave) return 'Carpeta sin dueño';
    if (clave === 'propietario') return 'Tu entorno (Propietario)';
    const [t, ...r] = clave.split(':');
    const id = r.join(':');
    if (t === 'trabajo') {
      const tr = db.prepare('SELECT estado FROM trabajos WHERE id = ?').get(id);
      return `Trabajo ${id}${tr ? ` (${tr.estado})` : ''}`;
    }
    if (t === 'sesion') return `Sesión de proyecto S-${id}`;
    if (t === 'chat') {
      const c = db.prepare('SELECT ch.nombre, p.nombre AS persona FROM chats ch LEFT JOIN personas p ON p.id = ch.persona_id WHERE ch.id = ?').get(id);
      return `Charla: ${c?.nombre || c?.persona || id.split('@')[0]}`;
    }
    return clave;
  }

  /**
   * Limpieza. Devuelve { liberado, acciones: [texto] }. `simular`: dice qué haría sin borrar nada.
   */
  function limpiar({ simular = false } = {}) {
    const ahora = reloj();
    const c = conf();
    const acciones = [];
    let liberado = 0;
    const borrar = (ruta) => { const t = medir(ruta); if (!simular) fs.rmSync(ruta, { recursive: true, force: true }); liberado += t; return t; };

    // 1. Trabajos terminados o fallidos hace más de un día: su carpeta (clon del repo, dependencias). Lo que dejaron
    //    para mandar ya pasó a ser un archivo F-n al terminar.
    if (aislamiento) {
      for (const t of db.prepare("SELECT id, fin FROM trabajos WHERE estado IN ('terminado', 'fallido') AND fin IS NOT NULL AND fin < ?").all(ahora - DIA)) {
        const r = aislamiento.rutas(`trabajo:${t.id}`);
        if (!fs.existsSync(r.base)) continue;
        if (!simular) { try { aislamiento.matarProcesos?.(aislamiento.usuarioDe(`trabajo:${t.id}`)); } catch {} }
        acciones.push(`carpeta del trabajo ${t.id} (${legible(borrar(r.base))})`);
      }
    }
    // 2. Adjuntos de WhatsApp viejos: se borra el archivo y queda el texto extraído (transcripción, OCR).
    if (c.diasAdjuntos > 0) {
      let n = 0, t = 0;
      for (const a of db.prepare("SELECT id, ruta FROM adjuntos WHERE estado = 'listo' AND ruta IS NOT NULL AND creado IS NOT NULL AND creado < ?").all(ahora - c.diasAdjuntos * DIA)) {
        if (fs.existsSync(a.ruta)) t += borrar(a.ruta);
        if (!simular) db.prepare("UPDATE adjuntos SET estado = 'vencido', ruta = NULL WHERE id = ?").run(a.id);
        n++;
      }
      if (n) acciones.push(`${n} adjunto(s) de más de ${c.diasAdjuntos} días (${legible(t)}; queda su texto)`);
      n = 0; t = 0;
      for (const a of db.prepare('SELECT id, ruta FROM archivos WHERE creado < ?').all(ahora - c.diasAdjuntos * DIA)) {
        if (!a.ruta || !fs.existsSync(a.ruta)) continue;
        t += borrar(a.ruta);
        n++;
      }
      if (n) acciones.push(`${n} archivo(s) enviado(s) de más de ${c.diasAdjuntos} días (${legible(t)})`);
    }
    // 3. Temporales de cada conversación con más de un día, y grabaciones de webhooks de más de una semana.
    // La edad de un archivo se mide con el reloj del sistema de archivos (no con el del gateway).
    const viejos = (carpeta, edad) => {
      const ahora = Date.now();
      let t = 0;
      if (!fs.existsSync(carpeta)) return 0;
      for (const n of fs.readdirSync(carpeta)) {
        const r = path.join(carpeta, n);
        try { if (fs.lstatSync(r).mtimeMs < ahora - edad) t += borrar(r); } catch {}
      }
      return t;
    };
    const aislados = path.join(dir, 'aislados');
    if (fs.existsSync(aislados)) {
      let t = 0;
      for (const n of fs.readdirSync(aislados)) t += viejos(path.join(aislados, n, 'tmp'), DIA);
      if (t) acciones.push(`temporales de más de un día (${legible(t)})`);
    }
    const g = viejos(path.join(dir, 'grabaciones'), 7 * DIA);
    if (g) acciones.push(`grabaciones de webhooks de más de una semana (${legible(g)})`);

    if (!simular) {
      cache = { en: 0, datos: null };
      ajustes.set('disco_ultima_limpieza', JSON.stringify({ en: ahora, liberado, acciones }));
      if (acciones.length) log.log?.(`[disco] limpieza: ${legible(liberado)} liberados (${acciones.join('; ')})`);
    }
    return { liberado, acciones };
  }

  /** Cada hora: limpieza automática (si está prendida) y aviso si el volumen pasó el umbral. */
  function revisar() {
    const c = conf();
    let limpieza = null;
    if (c.automatica) {
      try { limpieza = limpiar(); } catch (e) { log.warn?.('[disco] limpieza', e.message); }
    }
    const v = estadoVolumen();
    if (v.pct == null || v.pct < c.umbral) return { volumen: v, limpieza, aviso: false };
    const clave = `disco_aviso:${Math.floor(reloj() / DIA)}`;
    if (ajustes.get(clave)) return { volumen: v, limpieza, aviso: false };
    ajustes.set(clave, '1');
    const top = desglose({ fresco: true }).slice(0, 5).map((p) => `${p.nombre} ${legible(p.tamano)}`).join(', ');
    // El aviso es para el agente, no para la persona: él ordena el espacio y solo la molesta si es crítico.
    despertarPropietarios?.({ origen: 'disco', texto: `[disco al ${v.pct}%] Aviso interno, no se lo reenvíes al Propietario. El volumen de datos va por ${legible(v.usado)} de ${legible(v.total)}; lo que más ocupa: ${top}. Hacete cargo: mirá el detalle con la herramienta disco y liberá por tu cuenta lo que se regenera solo (dependencias, builds, cachés, clones que ya no usás). No borres nada que no se pueda recuperar. Escribile al Propietario solo si es crítico: si aun así queda muy poco espacio (más del 95%) o para liberar hace falta borrar algo suyo. En ese caso, en palabras simples y sin tecnicismos: qué pasa, qué proponés y qué tiene que decidir (por ejemplo, ampliar el volumen). Si lo resolviste, no le escribas.` });
    return { volumen: v, limpieza, aviso: true };
  }

  /** Una línea para el contexto del agente (sin medir carpetas: usa lo que haya en caché). */
  function linea() {
    const v = estadoVolumen();
    if (v.pct == null) return null;
    const c = conf();
    const top = (cache.datos ?? []).slice(0, 3).map((p) => `${p.nombre} ${legible(p.tamano)}`).join(', ');
    return `Disco: ${legible(v.usado)} de ${legible(v.total)} (${v.pct}%)${v.pct >= c.umbral ? ' — pasó el umbral de aviso: ordená espacio con la herramienta disco' : ''}${top ? `. Lo que más ocupa: ${top}` : ''}.`;
  }

  function estado() {
    let ultima = null;
    try { ultima = JSON.parse(ajustes.get('disco_ultima_limpieza') || 'null'); } catch {}
    return { volumen: estadoVolumen(), desglose: desglose(), config: conf(), ultimaLimpieza: ultima };
  }

  function configurar({ diasAdjuntos, umbral, automatica } = {}) {
    if (diasAdjuntos !== undefined) {
      const d = Number(diasAdjuntos);
      if (!(Number.isInteger(d) && d >= 0 && d <= 3650)) throw new Error('Los días de los adjuntos van de 0 (nunca se borran) a 3650.');
      ajustes.set('disco_dias_adjuntos', String(d));
    }
    if (umbral !== undefined) {
      const u = Number(umbral);
      if (!(u >= 50 && u <= 99)) throw new Error('El aviso va entre 50 y 99 %.');
      ajustes.set('disco_umbral_pct', String(u));
    }
    if (automatica !== undefined) ajustes.set('disco_limpieza_auto', automatica ? '1' : '0');
    return conf();
  }

  return { estadoVolumen, desglose, limpiar, revisar, linea, estado, configurar, conf };
}
