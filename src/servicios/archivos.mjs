// Archivos que el agente puede mandar: copias del gateway (en /data/salientes, solo root), con un id F-n.
// Así lo que se manda nunca se lee de una carpeta que el agente controla en el momento del envío.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
export const mimeDe = (nombre) => MIME[path.extname(String(nombre)).slice(1).toLowerCase()] ?? 'application/octet-stream';

export function crearArchivos({ db, config, reloj = () => Date.now() }) {
  const dir = path.join(config.dataDir, 'salientes');

  function guardar({ chatId = null, nombre, datos, origen = null }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const limpio = String(nombre ?? 'archivo').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').slice(-100) || 'archivo';
    const ruta = path.join(dir, crypto.randomUUID());
    fs.writeFileSync(ruta, datos, { mode: 0o600 });
    return Number(db.prepare('INSERT INTO archivos (chat_id, nombre, ruta, mime, tamano, origen, creado) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(chatId, limpio, ruta, mimeDe(limpio), datos.length, origen, reloj()).lastInsertRowid);
  }

  const obtener = (id) => db.prepare('SELECT * FROM archivos WHERE id = ?').get(Number(String(id).replace(/^F-/i, '')));

  return { guardar, obtener, leer: (a) => fs.readFileSync(a.ruta) };
}
