// Configuración del gateway. Ninguna variable es obligatoria: lo que falta se
// genera en el primer arranque (ver src/secretos.mjs) o tiene un valor por defecto.
import path from 'node:path';
import fs from 'node:fs';
import { leerSecretos } from './secretos.mjs';

export function cargarConfig(env = process.env) {
  const dataDir = path.resolve(env.SUPERAGENT_DATA_DIR ?? (process.platform === 'win32' ? './data' : '/data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const secretos = leerSecretos(env, dataDir);
  const port = Number(env.PORT ?? env.SUPERAGENT_PORT ?? 8080);
  const publicUrl = (env.SUPERAGENT_PUBLIC_URL
    ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, '');
  // En Railway las direcciones internas salen solas: el servicio de WhatsApp se llama "waha" y el propio
  // gateway se alcanza por su dominio privado.
  const enRailway = Boolean(env.RAILWAY_PRIVATE_DOMAIN);
  const wahaUrl = env.WAHA_URL ?? (enRailway ? 'http://waha.railway.internal:3000' : 'http://waha:3000');
  const internalUrl = env.SUPERAGENT_INTERNAL_URL
    ?? (enRailway ? `http://${env.RAILWAY_PRIVATE_DOMAIN}:${port}` : `http://superagent:${port}`);
  return {
    port,
    // "::" escucha IPv4 e IPv6; la red privada de Railway es IPv6.
    host: env.SUPERAGENT_HOST ?? '::',
    dataDir,
    dbPath: path.join(dataDir, 'superagent.db'),
    publicUrl,
    cookieSegura: publicUrl.startsWith('https://'),
    webDist: path.resolve(env.SUPERAGENT_WEB_DIST ?? './web/dist'),
    setupCode: env.SUPERAGENT_SETUP_CODE || null,
    // Minutos desde el primer arranque en los que el setup no pide código (0 = siempre lo pide).
    setupSinCodigoMs: Number(env.SUPERAGENT_SETUP_SIN_CODIGO_MIN ?? 120) * 60_000,
    // MCP del gateway: solo en 127.0.0.1, para las corridas de Claude Code (nunca se publica).
    mcpPort: Number(env.SUPERAGENT_MCP_PORT ?? port + 1),
    mcpUrl: `http://127.0.0.1:${Number(env.SUPERAGENT_MCP_PORT ?? port + 1)}/mcp`,
    // GitHub: la aplicación OAuth para el login por dispositivo (si falta, se pega un token limitado en el panel).
    github: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID || null,
      web: env.GITHUB_WEB_URL ?? 'https://github.com',
      api: env.GITHUB_API_URL ?? 'https://api.github.com',
    },
    // Navegador del agente (MCP de Playwright con Chromium sin interfaz), por corrida y con el usuario de la corrida.
    navegador: {
      mcp: env.PLAYWRIGHT_MCP_BIN ?? 'playwright-mcp',
      chromium: env.CHROMIUM_BIN ?? '/usr/bin/chromium',
    },
    // Guarda los webhooks crudos en /data/grabaciones para armar payloads de prueba reales.
    grabarWebhooks: env.SUPERAGENT_GRABAR_WEBHOOKS === '1',
    sessionSecret: secretos.SUPERAGENT_SESSION_SECRET,
    waha: {
      url: wahaUrl.replace(/\/$/, ''),
      apiKey: secretos.WAHA_API_KEY,
      hmacKey: secretos.WHATSAPP_HOOK_HMAC_KEY,
      session: env.WAHA_SESSION ?? 'default',
      // URL por la que WAHA le manda los eventos al gateway (red interna).
      hookUrl: env.WHATSAPP_HOOK_URL ?? `${internalUrl.replace(/\/$/, '')}/webhook/waha`,
    },
    claude: {
      bin: env.CLAUDE_BIN ?? 'claude',
      usuarioSO: env.SUPERAGENT_AGENT_USER ?? 'agente',
    },
    opencode: {
      bin: env.OPENCODE_BIN ?? 'opencode',
    },
    codex: {
      bin: env.CODEX_BIN ?? 'codex',
    },
    gemini: {
      bin: env.GEMINI_BIN ?? 'gemini',
      // Carpeta de root para los settings de sistema de Gemini (no la acepta si otro usuario puede escribirla).
      dirSistema: env.GEMINI_SISTEMA_DIR ?? (process.platform === 'win32' ? null : '/etc/superagent/gemini'),
    },
  };
}
