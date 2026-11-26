// Secretos compartidos con WAHA y de sesión.
// Orden: variable de entorno → archivo de secretos generado (docker compose) → archivo propio en /data.
// Nunca se imprimen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOMBRES = ['WAHA_API_KEY', 'WHATSAPP_HOOK_HMAC_KEY', 'SUPERAGENT_SESSION_SECRET'];

export function parsearEnv(texto) {
  const out = {};
  for (const linea of texto.split(/\r?\n/)) {
    const m = linea.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function generarSecreto(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function leerSecretos(env, dataDir) {
  const compartido = env.SUPERAGENT_SECRETS_FILE ?? '/secretos/superagent.env';
  const desdeArchivo = fs.existsSync(compartido) ? parsearEnv(fs.readFileSync(compartido, 'utf8')) : {};
  const propioPath = path.join(dataDir, '.secretos.env');
  const propio = fs.existsSync(propioPath) ? parsearEnv(fs.readFileSync(propioPath, 'utf8')) : {};

  const out = {};
  let cambio = false;
  for (const n of NOMBRES) {
    out[n] = env[n] || desdeArchivo[n] || propio[n];
    if (!out[n]) {
      // La clave de la API de WAHA tiene que ser la misma en los dos servicios: esa no se puede inventar acá.
      // La de HMAC sí: el gateway se la pasa a WAHA por la API al configurar la sesión.
      if (n === 'WAHA_API_KEY') continue;
      out[n] = propio[n] = generarSecreto();
      cambio = true;
    }
  }
  if (cambio) {
    const texto = Object.entries(propio).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(propioPath, texto, { mode: 0o600 });
  }
  return out;
}
