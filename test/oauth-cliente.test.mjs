// Canje de código OAuth con cualquier servidor: cliente público, secreto en el cuerpo o en el encabezado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canjearCodigo } from '../src/conectores/oauth.mjs';

function servidor(modo) {
  const pedidos = [];
  const f = async (url, o) => {
    const cuerpo = Object.fromEntries(new URLSearchParams(o.body));
    const basico = o.headers.Authorization?.startsWith('Basic ');
    pedidos.push({ cuerpo, basico });
    const ok = modo === 'publico' ? !cuerpo.client_secret && !basico
      : modo === 'post' ? cuerpo.client_secret === 's3' : basico && Buffer.from(o.headers.Authorization.slice(6), 'base64').toString() === 'c1:s3';
    const json = ok ? { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 } : { error: 'invalid_client' };
    return { ok, status: ok ? 200 : 401, json: async () => json };
  };
  return { f, pedidos };
}
const base = { meta: { token_endpoint: 'https://auth.test/token' }, clientId: 'c1', codigo: 'x', redirectUri: 'https://a.test/cb', verificador: 'v', recurso: 'https://mcp.test' };

for (const [modo, secreto, intentos] of [['publico', null, 1], ['post', 's3', 1], ['basic', 's3', 2]]) {
  test(`canje con servidor ${modo}`, async () => {
    const s = servidor(modo);
    const t = await canjearCodigo({ ...base, clientSecret: secreto, fetch: s.f });
    assert.equal(t.access_token, 'tok');
    assert.equal(s.pedidos.length, intentos);
  });
}

test('si el servidor rechaza, el error dice por qué', async () => {
  const f = async () => ({ ok: false, status: 422, json: async () => ({ message: 'Required parameter: client_secret' }) });
  await assert.rejects(canjearCodigo({ ...base, fetch: f }), /422: Required parameter: client_secret/);
});
