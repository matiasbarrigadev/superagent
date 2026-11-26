// Panel de conexiones: logins del entorno, GitHub por "gh auth login", conectores colgados y saludo inicial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armar, persona } from './ayuda.mjs';

test('logins del entorno: gh, vercel y supabase se detectan; GitHub del sistema usa el de gh si no hay otro', () => {
  const t = armar({ guion: () => [] });
  const lugar = t.nucleo.aislamiento.preparar('propietario');
  t.nucleo.aislamiento.terminar(lugar);
  fs.mkdirSync(path.join(lugar.base, '.config/gh'), { recursive: true });
  fs.writeFileSync(path.join(lugar.base, '.config/gh/hosts.yml'), 'github.com:\n    git_protocol: https\n    users:\n        matias:\n            oauth_token: gho_abc123\n    user: matias\n    oauth_token: gho_abc123\n');
  fs.mkdirSync(path.join(lugar.base, '.local/share/com.vercel.cli'), { recursive: true });
  fs.writeFileSync(path.join(lugar.base, '.local/share/com.vercel.cli/auth.json'), '{"token":"x"}');
  const e = Object.fromEntries(t.nucleo.logins.detectar().map((x) => [x.servicio, x]));
  assert.equal(e.GitHub.conectado, true);
  assert.equal(e.GitHub.cuenta, 'matias');
  assert.equal(e.Vercel.conectado, true);
  assert.equal(e.Supabase.conectado, false);
  assert.equal(t.nucleo.github.conectado(), true);
  assert.equal(t.nucleo.github.origen(), 'entorno');
  assert.equal(t.nucleo.github.token(), 'gho_abc123');
  t.limpiar();
});

test('conectores colgados: se borra el pendiente si ya hay otro activo del mismo servicio o si su link venció hace rato', () => {
  const t = armar({ guion: () => [] });
  const c = t.nucleo.conectores;
  const ins = t.db.prepare("INSERT INTO conexiones (app, alcance, proveedor, estado, url_mcp, permisos) VALUES (?, 'instalacion', 'directo', ?, ?, '[]')");
  ins.run('Supabase', 'activa', 'https://mcp.supabase.com/mcp');
  ins.run('Supabase', 'pendiente', 'https://mcp.supabase.com/mcp');
  ins.run('Notion', 'pendiente', 'https://mcp.notion.com/mcp');
  assert.deepEqual(c.listar().map((x) => `${x.app}:${x.estado}`), ['Supabase:activa', 'Notion:pendiente'], 'sin credencial de pedido, el de Notion queda');
  t.limpiar();
});

test('instalación nueva: al verificar su número, el agente le escribe al Propietario para configurarse (una sola vez)', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('[configuración inicial]') ? [{ herramienta: 'responder', args: { texto: '¡Hola! Soy tu agente. ¿Cómo querés que me llame?' } }] : []) });
  const yo = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  assert.equal(t.nucleo.iniciarConfiguracion(yo), true);
  await t.avanzar(5000);
  assert.equal(t.corridas.at(-1).spec.variante, 'onboarding');
  assert.ok(t.waha.enviados.some((e) => e.chatId === '5491111111111@c.us' && /Cómo querés que me llame/.test(e.texto)));
  assert.equal(t.nucleo.iniciarConfiguracion(yo), false, 'no repite');
  t.limpiar();
});
