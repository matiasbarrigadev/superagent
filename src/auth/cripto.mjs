// Contraseñas (argon2id), TOTP (RFC 6238), cifrado de secretos en la base y tokens.
import crypto from 'node:crypto';

// --- Contraseñas: argon2id con los parámetros mínimos de OWASP (19 MiB, 2 pasadas).
const ARGON = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 };

export function hashContrasena(contrasena) {
  const nonce = crypto.randomBytes(16);
  const tag = crypto.argon2Sync('argon2id', { ...ARGON, message: contrasena, nonce });
  return `argon2id$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${nonce.toString('base64url')}$${tag.toString('base64url')}`;
}

export function verificarContrasena(contrasena, guardado) {
  const [alg, params, nonceB64, tagB64] = String(guardado).split('$');
  if (alg !== 'argon2id') return false;
  const p = Object.fromEntries(params.split(',').map((kv) => kv.split('=')));
  const esperado = Buffer.from(tagB64, 'base64url');
  const tag = crypto.argon2Sync('argon2id', {
    message: contrasena, nonce: Buffer.from(nonceB64, 'base64url'),
    parallelism: Number(p.p), memory: Number(p.m), passes: Number(p.t), tagLength: esperado.length,
  });
  return crypto.timingSafeEqual(tag, esperado);
}

// --- TOTP: SHA-1, 6 dígitos, 30 s, compatible con cualquier app de códigos.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31];
  return out;
}

export function desdeBase32(txt) {
  let bits = 0, valor = 0;
  const out = [];
  for (const c of txt.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function nuevoSecretoTotp() {
  return base32(crypto.randomBytes(20));
}

export function totp(secretoB32, paso) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', desdeBase32(secretoB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

export const pasoActual = (ahora = Date.now()) => Math.floor(ahora / 30_000);

/** Devuelve el paso que coincide (ventana ±1) o null. El que llama rechaza pasos ya usados. */
export function verificarTotp(secretoB32, codigo, ahora = Date.now()) {
  const c = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const p = pasoActual(ahora);
  for (const d of [0, -1, 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secretoB32, p + d)), Buffer.from(c))) return p + d;
  }
  return null;
}

export function urlOtpauth(secretoB32, cuentaLabel, emisor = 'Superagent') {
  const label = encodeURIComponent(`${emisor}:${cuentaLabel}`);
  return `otpauth://totp/${label}?secret=${secretoB32}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;
}

// --- Cifrado de secretos guardados en la base (AES-256-GCM con clave derivada del secreto de sesión).
function clave(secretoMaestro, uso) {
  return Buffer.from(crypto.hkdfSync('sha256', secretoMaestro, Buffer.alloc(0), `superagent:${uso}`, 32));
}

export function cifrar(secretoMaestro, texto, uso = 'base') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave(secretoMaestro, uso), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${datos.toString('base64url')}`;
}

export function descifrar(secretoMaestro, sobre, uso = 'base') {
  const [v, iv, tag, datos] = String(sobre).split('.');
  if (v !== 'v1') throw new Error('formato de cifrado desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', clave(secretoMaestro, uso), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64url')), d.final()]).toString('utf8');
}

// --- Tokens y códigos.
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (txt) => crypto.createHash('sha256').update(String(txt)).digest('hex');

export function igualSeguro(a, b) {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
}

/** Código legible sin caracteres ambiguos, en grupos: "K7QM-2XRP-9HTD". */
export function codigoLegible(grupos = 3, largo = 4) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const partes = [];
  for (let g = 0; g < grupos; g++) {
    let s = '';
    for (let i = 0; i < largo; i++) s += alfabeto[crypto.randomInt(alfabeto.length)];
    partes.push(s);
  }
  return partes.join('-');
}

export const normalizarCodigo = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
