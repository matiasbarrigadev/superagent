// Registro dinámico: un servicio que solo acepta aplicaciones aprobadas devuelve un error claro, con la salida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrar } from '../src/conectores/oauth.mjs';

const responder = (status, cuerpo) => async () => new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

test('redirect no aprobado: dice que use la CLI del servicio, no un error crudo', async () => {
  const f = responder(400, { error: 'invalid_redirect_uri', error_description: 'not approved' });
  await assert.rejects(registrar({ registration_endpoint: 'https://auth.test/register' }, { redirectUri: 'https://x.test/oauth/callback', fetch: f }),
    /solo deja conectar a aplicaciones que aprobó.*CLI/);
});

test('otro error: conserva el código y la descripción del servicio', async () => {
  const f = responder(400, { error: 'invalid_client_metadata', error_description: 'falta algo' });
  await assert.rejects(registrar({ registration_endpoint: 'https://auth.test/register' }, { redirectUri: 'https://x.test/oauth/callback', fetch: f }),
    /400 \(invalid_client_metadata: falta algo\)/);
});
