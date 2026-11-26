// Genera los secretos del primer arranque (docker compose). Si ya existen, no toca nada.
// waha.env       → lo que necesita WAHA: su clave de API y credenciales de dashboard/swagger
//                  (están apagados, pero si faltan WAHA las genera e imprime en los logs).
// superagent.env → lo que necesita el gateway.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2] ?? '/secretos';
const s = (n = 32) => crypto.randomBytes(n).toString('hex');
const archivoGateway = path.join(dir, 'superagent.env');
const archivoWaha = path.join(dir, 'waha.env');

fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(archivoGateway) && fs.existsSync(archivoWaha)) {
  console.log('[secretos] ya existen, no se cambian');
  process.exit(0);
}
const wahaKey = s();
const panelWaha = s(24);
fs.writeFileSync(archivoWaha, [
  `WAHA_API_KEY=${wahaKey}`,
  'WAHA_DASHBOARD_USERNAME=admin',
  `WAHA_DASHBOARD_PASSWORD=${panelWaha}`,
  'WHATSAPP_SWAGGER_USERNAME=admin',
  `WHATSAPP_SWAGGER_PASSWORD=${panelWaha}`,
].join('\n') + '\n', { mode: 0o644 });
fs.writeFileSync(archivoGateway, [
  `WAHA_API_KEY=${wahaKey}`,
  `WHATSAPP_HOOK_HMAC_KEY=${s()}`,
  `SUPERAGENT_SESSION_SECRET=${s(48)}`,
].join('\n') + '\n', { mode: 0o644 });
console.log('[secretos] generados');
