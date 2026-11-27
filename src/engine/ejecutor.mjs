// Ejecutor común a todos los motores: prepara el lugar de la corrida (usuario y carpeta de su conversación),
// lanza la CLI del motor con lo que arma su adaptador, lee su salida línea por línea y corta por tiempo.
// Lo que cambia entre motores (flags, config, entorno, formato de eventos) vive en cada adaptador.
//
// adaptador = {
//   id, nombre,
//   preparar({ spec, lugar, aislamiento, sesion, nueva }) → { file, args, env, stdin, archivoMcp, alTerminar, sinCosto }
//   lector() → { linea(texto, r), stderr(texto, r) → tipoError para cortar | null, cerrar(r, { codigo, err }) }
//   clasificarError(texto, codigo) → sin_sesion | limite | sesion_perdida | otro
//   puedeNegar: herramientas (nombres de Claude Code) que el motor sabe sacar de verdad
// }
import path from 'node:path';
import { spawn as spawnNode } from 'node:child_process';

export class ErrorMotor extends Error {
  constructor(tipoError, mensaje) { super(mensaje); this.tipoError = tipoError; }
}

export function crearEjecutorComun({ adaptadores, aislamiento, lanzar = spawnNode, log = console }) {
  return async function ejecutar(spec, { sesion, nueva, timeoutMs = 15 * 60_000 } = {}) {
    const ad = adaptadores[spec.motor ?? 'claude'];
    if (!ad) return { ok: false, tipoError: 'otro', error: `Motor desconocido: ${spec.motor}`, herramientas: [] };
    const lugar = aislamiento.preparar(spec.claveAislamiento);
    // Preparación propia de la corrida (por ejemplo, el clon del repo de un trabajo), con la carpeta ya lista.
    if (spec.preparar) {
      try { await spec.preparar(lugar); } catch (e) {
        aislamiento.terminar(lugar);
        return { ok: false, tipoError: 'otro', error: `No se pudo preparar la corrida: ${e.message}`, herramientas: [], lugar };
      }
    }
    // Adjuntos de esta tanda: se copian adentro, así solo los ve esta conversación.
    for (const a of spec.adjuntos ?? []) {
      try { aislamiento.copiarAdentro(a.origen, path.join(lugar.adjuntos, a.nombre), lugar.usuario); } catch (e) { log.warn('[corrida] adjunto', a.nombre, e.message); }
    }
    for (const f of spec.archivosExtra ?? []) aislamiento.escribirArchivo(path.join(lugar.base, f.nombre), f.contenido, lugar.usuario);
    let c;
    try {
      c = ad.preparar({ spec, lugar, aislamiento, sesion, nueva });
    } catch (e) {
      aislamiento.terminar(lugar);
      return { ok: false, tipoError: e.tipoError ?? 'otro', error: e.message, herramientas: [], lugar };
    }
    const comoUsuario = aislamiento.activo ? { uid: lugar.usuario.uid, gid: lugar.usuario.gid } : {};
    const lector = ad.lector();
    return new Promise((resolve) => {
      const fin = (r) => {
        try { c.alTerminar?.(r); } catch (e) { log.warn?.('[corrida] al terminar', e.message); }
        if (c.sinCosto && r.uso) r.uso.costo = null;
        aislamiento.terminar(lugar, { archivoMcp: c.archivoMcp ?? null });
        resolve({ ...r, motor: ad.id, lugar });
      };
      let hijo;
      try {
        hijo = lanzar(c.file, c.args, { env: c.env, cwd: lugar.trabajo, ...comoUsuario, windowsHide: true });
      } catch (e) {
        fin({ ok: false, tipoError: 'sin_binario', error: e.message, herramientas: [] });
        return;
      }
      const r = { ok: false, sessionId: null, resultado: '', error: null, tipoError: null, herramientas: [], codigoError: null };
      let buf = '', bufErr = '', err = '', vencida = false, cortada = null;
      // Pasos para "Ver al agente": el lector de cada motor los da si sabe; si no, al menos qué herramientas usó.
      const emitir = (p) => { try { spec.alPaso?.(p); } catch {} };
      let vistas = 0;
      const leer = (l) => {
        lector.linea(l, r, emitir);
        if (!lector.pasosPropios) while (vistas < r.herramientas.length) emitir({ tipo: 'herramienta', nombre: r.herramientas[vistas++] });
      };
      const cortar = (tipo) => { if (cortada) return; cortada = tipo; try { hijo.kill('SIGKILL'); } catch {} };
      const reloj = setTimeout(() => { vencida = true; try { hijo.kill('SIGKILL'); } catch {} }, timeoutMs);
      hijo.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) leer(l); }
      });
      hijo.stderr.on('data', (d) => {
        if (err.length < 20_000) err += d;
        bufErr += d;
        let i;
        while ((i = bufErr.indexOf('\n')) >= 0) {
          const l = bufErr.slice(0, i); bufErr = bufErr.slice(i + 1);
          const t = lector.stderr?.(l, r);
          if (t) cortar(t);
        }
        if (bufErr.length > 50_000) bufErr = bufErr.slice(-10_000);
      });
      hijo.on('error', (e) => {
        clearTimeout(reloj);
        fin({ ...r, ok: false, tipoError: e.code === 'ENOENT' ? 'sin_binario' : 'otro', error: e.message });
      });
      hijo.on('close', (codigo) => {
        clearTimeout(reloj);
        if (buf.trim()) leer(buf);
        if (cortada) { fin({ ...r, ok: false, tipoError: cortada, error: r.error || `${ad.nombre}: ${cortada === 'limite' ? 'se alcanzó el límite de uso' : 'la credencial no funciona'}` }); return; }
        if (vencida) { fin({ ...r, ok: false, tipoError: 'tiempo', error: 'La corrida tardó demasiado y se cortó.' }); return; }
        lector.cerrar?.(r, { codigo, err });
        if (codigo !== 0 && r.ok) r.ok = false;
        if (!r.ok) {
          r.error = r.error || err.trim().slice(0, 2000) || `${ad.nombre} terminó con código ${codigo}`;
          r.tipoError = r.tipoError ?? ad.clasificarError(`${r.error}\n${err}`, r.codigoError);
        }
        fin(r);
      });
      hijo.stdin.on('error', () => {});
      hijo.stdin.end(c.stdin ?? '');
    });
  };
}
