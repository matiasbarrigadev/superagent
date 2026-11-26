// Setup del Propietario, login, sesiones web y límite de intentos.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { auditar } from '../db/index.mjs';
import { crearInvitacion as crearInvitacionEnBase } from './invitaciones.mjs';
import {
  hashContrasena, verificarContrasena, nuevoSecretoTotp, verificarTotp, urlOtpauth,
  cifrar, descifrar, token, sha256, igualSeguro, codigoLegible, normalizarCodigo,
} from './cripto.mjs';

const DURACION_SESION = 14 * 24 * 3600_000;
const DURACION_SETUP = 15 * 60_000;
const VENTANA_INTENTOS = 15 * 60_000;
const MAX_INTENTOS = 8;

export class ErrorAuth extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

export function crearAuth({ db, config, log = console }) {
  const pendientes = new Map(); // token de setup → { email, hash, secreto, vence }
  const intentos = new Map();   // clave → [timestamps]
  const recuperacionesWa = new Map(); // usuario → código por WhatsApp (hash)
  const nuevosTotp = new Map();       // token → TOTP nuevo pendiente de confirmar

  // El código de setup: el de la variable o uno generado en cada arranque mientras no haya Propietario.
  let codigoSetup = config.setupCode;
  const enSetup = () => !db.prepare('SELECT 1 FROM usuarios_web LIMIT 1').get();
  if (enSetup() && !codigoSetup) {
    codigoSetup = codigoLegible(3, 4);
    log.log(`\n[setup] Código de setup para abrir el panel por primera vez: ${codigoSetup}\n[setup] Se genera uno nuevo en cada arranque hasta que se cree el Propietario.\n`);
  }
  // Ventana sin código: durante las primeras horas desde el primer arranque, el panel crea el Propietario sin
  // pedir el código de setup (la URL de la instalación es nueva y no está publicada). Se cuenta una sola vez:
  // reiniciar no la extiende, y un reset del Propietario siempre pide el código.
  const ventanaMs = Number(config.setupSinCodigoMs ?? 0);
  let abiertoHasta = 0;
  if (enSetup() && ventanaMs > 0) {
    const fila = db.prepare("SELECT valor FROM ajustes WHERE clave = 'setup_abierto_hasta'").get();
    abiertoHasta = fila ? Number(fila.valor) : Date.now() + ventanaMs;
    if (!fila) db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('setup_abierto_hasta', ?)").run(String(abiertoHasta));
    if (Date.now() < abiertoHasta) log.log(`[setup] Sin código hasta ${new Date(abiertoHasta).toISOString()}: abrí el panel y creá el Propietario.
`);
  }
  const setupSinCodigo = () => enSetup() && Date.now() < abiertoHasta;
  if (enSetup() && codigoSetup && config.publicUrl) {
    log.log(`[setup] Link directo al setup: ${config.publicUrl}/?setup=${encodeURIComponent(codigoSetup)}\n`);
  }

  function limitar(clave) {
    const ahora = Date.now();
    const lista = (intentos.get(clave) ?? []).filter((t) => ahora - t < VENTANA_INTENTOS);
    intentos.set(clave, lista);
    if (lista.length >= MAX_INTENTOS) throw new ErrorAuth('Demasiados intentos. Esperá unos minutos.', 429);
  }
  const fallo = (clave) => intentos.set(clave, [...(intentos.get(clave) ?? []), Date.now()]);

  function validarEmail(email) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new ErrorAuth('Email inválido.');
    return e;
  }
  function validarContrasena(c) {
    if (typeof c !== 'string' || c.length < 12) throw new ErrorAuth('La contraseña debe tener al menos 12 caracteres.');
    if (c.length > 256) throw new ErrorAuth('La contraseña es demasiado larga.');
    return c;
  }

  return {
    enSetup,
    setupSinCodigo,

    verificarCodigoSetup(codigo, ip) {
      if (!enSetup()) throw new ErrorAuth('El setup ya se completó.', 409);
      limitar(`setup:${ip}`);
      if (setupSinCodigo()) return;
      if (!codigoSetup || !igualSeguro(normalizarCodigo(codigo), normalizarCodigo(codigoSetup))) {
        fallo(`setup:${ip}`);
        throw new ErrorAuth('Código de setup incorrecto.', 401);
      }
    },

    async iniciarSetup({ codigo, email, contrasena }, ip) {
      this.verificarCodigoSetup(codigo, ip);
      const e = validarEmail(email);
      validarContrasena(contrasena);
      const secreto = nuevoSecretoTotp();
      const t = token();
      pendientes.set(t, { email: e, hash: hashContrasena(contrasena), secreto, vence: Date.now() + DURACION_SETUP });
      const otpauth = urlOtpauth(secreto, e);
      return { token: t, otpauth, secreto, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }) };
    },

    confirmarSetup({ token: t, totp: codigo, nombre }, meta) {
      if (!enSetup()) throw new ErrorAuth('El setup ya se completó.', 409);
      const p = pendientes.get(t);
      if (!p || p.vence < Date.now()) throw new ErrorAuth('El setup venció. Empezá de nuevo.', 410);
      const paso = verificarTotp(p.secreto, codigo);
      if (paso == null) throw new ErrorAuth('El código de la app no coincide. Revisá la hora del teléfono y probá de nuevo.', 401);

      const ahora = Date.now();
      const recuperacion = Array.from({ length: 10 }, () => codigoLegible(2, 5));
      db.exec('BEGIN');
      try {
        const rol = db.prepare("SELECT id FROM roles WHERE nombre = 'Propietario' AND predefinido = 1").get();
        const persona = db.prepare('INSERT INTO personas (nombre, rol_id, alta_manual, creada) VALUES (?, ?, 1, ?)')
          .run(String(nombre ?? '').trim().slice(0, 100) || null, rol.id, ahora);
        const u = db.prepare(`INSERT INTO usuarios_web (persona_id, email, hash_contrasena, totp_secreto, totp_ultimo_paso, creado)
          VALUES (?, ?, ?, ?, ?, ?)`).run(persona.lastInsertRowid, p.email, p.hash, cifrar(config.sessionSecret, p.secreto, 'totp'), paso, ahora);
        const ins = db.prepare('INSERT INTO codigos_recuperacion (usuario_id, hash) VALUES (?, ?)');
        for (const c of recuperacion) ins.run(u.lastInsertRowid, sha256(normalizarCodigo(c)));
        db.exec('COMMIT');
        pendientes.delete(t);
        codigoSetup = null;
        auditar(db, 'setup.propietario_creado', { actor: p.email, rol: 'Propietario' });
        const sesion = this.crearSesion(Number(u.lastInsertRowid), meta);
        return { recuperacion, sesion };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    login({ email, contrasena, codigo }, meta) {
      const e = String(email ?? '').trim().toLowerCase();
      limitar(`login:${meta.ip}`);
      limitar(`login:${e}`);
      const u = db.prepare('SELECT * FROM usuarios_web WHERE email = ?').get(e);
      const malo = () => {
        fallo(`login:${meta.ip}`); fallo(`login:${e}`);
        auditar(db, 'login.fallido', { actor: e, detalle: { ip: meta.ip } });
        return new ErrorAuth('Email, contraseña o código incorrectos.', 401);
      };
      // Con usuario inexistente igual se calcula un hash, para no delatar por tiempo.
      const okContrasena = u
        ? verificarContrasena(String(contrasena ?? ''), u.hash_contrasena)
        : (hashContrasena('x'), false);
      if (!okContrasena) throw malo();

      const c = String(codigo ?? '').trim();
      if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
        const paso = verificarTotp(descifrar(config.sessionSecret, u.totp_secreto, 'totp'), c);
        if (paso == null || paso <= u.totp_ultimo_paso) throw malo();
        db.prepare('UPDATE usuarios_web SET totp_ultimo_paso = ? WHERE id = ?').run(paso, u.id);
      } else {
        const r = db.prepare('SELECT id FROM codigos_recuperacion WHERE usuario_id = ? AND hash = ? AND usado_en IS NULL')
          .get(u.id, sha256(normalizarCodigo(c)));
        if (!r) throw malo();
        db.prepare('UPDATE codigos_recuperacion SET usado_en = ? WHERE id = ?').run(Date.now(), r.id);
        auditar(db, 'login.codigo_recuperacion', { actor: e });
      }
      intentos.delete(`login:${e}`);
      auditar(db, 'login.ok', { actor: e, detalle: { ip: meta.ip } });
      return this.crearSesion(u.id, meta);
    },

    // --- Recuperación de acceso (TEORIA §4.4). Siempre con dos factores; al recuperar se cierran todas las sesiones.

    /** Contraseña perdida: TOTP + un código de recuperación → contraseña nueva. */
    recuperarContrasena({ email, totp: codigo, recuperacion, nueva }, meta = {}) {
      const u = this._usuarioParaRecuperar(email, meta);
      validarContrasena(nueva);
      const paso = verificarTotp(descifrar(config.sessionSecret, u.totp_secreto, 'totp'), codigo);
      const cod = db.prepare('SELECT id FROM codigos_recuperacion WHERE usuario_id = ? AND hash = ? AND usado_en IS NULL').get(u.id, sha256(normalizarCodigo(recuperacion)));
      if (paso == null || paso <= u.totp_ultimo_paso || !cod) throw this._falloRecuperacion(u.email, meta);
      db.prepare('UPDATE codigos_recuperacion SET usado_en = ? WHERE id = ?').run(Date.now(), cod.id);
      db.prepare('UPDATE usuarios_web SET hash_contrasena = ?, totp_ultimo_paso = ? WHERE id = ?').run(hashContrasena(nueva), paso, u.id);
      return this._cerrarTodoYAuditar(u, 'recuperar.contrasena');
    },

    /** Contraseña perdida, otra vía: código por WhatsApp al número verificado del Propietario + TOTP. */
    async pedirCodigoWhatsapp({ email }, meta = {}) {
      const e = String(email ?? '').trim().toLowerCase();
      limitar(`recuperar:${meta.ip}`);
      fallo(`recuperar:${meta.ip}`); // cuenta como intento: frena el envío de muchos códigos
      const u = db.prepare('SELECT u.id, p.id AS persona_id, p.telefono, p.verificada FROM usuarios_web u JOIN personas p ON p.id = u.persona_id WHERE u.email = ?').get(e);
      // Misma respuesta exista o no la cuenta (no se puede averiguar qué emails existen).
      if (!u?.verificada || !u.telefono || !this.enviarWhatsapp) return { ok: true };
      const codigo = String(crypto.randomInt(100000, 1000000));
      recuperacionesWa.set(u.id, { hash: sha256(codigo), vence: Date.now() + 10 * 60_000, intentos: 0 });
      await this.enviarWhatsapp(`${u.telefono}@c.us`, `Código para recuperar tu acceso a Superagent: ${codigo}. Vence en 10 minutos. Si no lo pediste, ignoralo.`);
      return { ok: true };
    },

    recuperarContrasenaPorWhatsapp({ email, codigoWhatsapp, totp: codigo, nueva }, meta = {}) {
      const u = this._usuarioParaRecuperar(email, meta);
      validarContrasena(nueva);
      const r = recuperacionesWa.get(u.id);
      const paso = verificarTotp(descifrar(config.sessionSecret, u.totp_secreto, 'totp'), codigo);
      const okWa = r && r.vence > Date.now() && r.intentos < 5 && igualSeguro(sha256(String(codigoWhatsapp ?? '').replace(/\D/g, '')), r.hash);
      if (r) r.intentos++;
      if (!okWa || paso == null || paso <= u.totp_ultimo_paso) throw this._falloRecuperacion(u.email, meta);
      recuperacionesWa.delete(u.id);
      db.prepare('UPDATE usuarios_web SET hash_contrasena = ?, totp_ultimo_paso = ? WHERE id = ?').run(hashContrasena(nueva), paso, u.id);
      return this._cerrarTodoYAuditar(u, 'recuperar.contrasena_whatsapp');
    },

    /** Teléfono del TOTP perdido: contraseña + código de recuperación → TOTP nuevo (y códigos nuevos al confirmar). */
    async iniciarNuevoTotp({ email, contrasena, recuperacion }, meta = {}) {
      const u = this._usuarioParaRecuperar(email, meta);
      const cod = db.prepare('SELECT id FROM codigos_recuperacion WHERE usuario_id = ? AND hash = ? AND usado_en IS NULL').get(u.id, sha256(normalizarCodigo(recuperacion)));
      if (!verificarContrasena(String(contrasena ?? ''), u.hash_contrasena) || !cod) throw this._falloRecuperacion(u.email, meta);
      db.prepare('UPDATE codigos_recuperacion SET usado_en = ? WHERE id = ?').run(Date.now(), cod.id);
      const secreto = nuevoSecretoTotp();
      const t = token();
      nuevosTotp.set(t, { usuarioId: u.id, secreto, vence: Date.now() + DURACION_SETUP });
      const otpauth = urlOtpauth(secreto, u.email);
      return { token: t, secreto, otpauth, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }) };
    },

    confirmarNuevoTotp({ token: t, totp: codigo }) {
      const n = nuevosTotp.get(t);
      if (!n || n.vence < Date.now()) throw new ErrorAuth('Venció. Empezá de nuevo.', 410);
      const paso = verificarTotp(n.secreto, codigo);
      if (paso == null) throw new ErrorAuth('El código de la app no coincide.', 401);
      const recuperacion = Array.from({ length: 10 }, () => codigoLegible(2, 5));
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE usuarios_web SET totp_secreto = ?, totp_ultimo_paso = ? WHERE id = ?').run(cifrar(config.sessionSecret, n.secreto, 'totp'), paso, n.usuarioId);
        db.prepare('DELETE FROM codigos_recuperacion WHERE usuario_id = ?').run(n.usuarioId);
        const ins = db.prepare('INSERT INTO codigos_recuperacion (usuario_id, hash) VALUES (?, ?)');
        for (const c of recuperacion) ins.run(n.usuarioId, sha256(normalizarCodigo(c)));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      nuevosTotp.delete(t);
      const u = db.prepare('SELECT * FROM usuarios_web WHERE id = ?').get(n.usuarioId);
      this._cerrarTodoYAuditar(u, 'recuperar.totp');
      return { recuperacion };
    },

    /**
     * Último recurso (SUPERAGENT_RESET_OWNER): borra solo las cuentas del panel (usuarios, sesiones, códigos)
     * y vuelve a modo setup. Personas, roles, memoria, repos y todo lo demás se conserva.
     * Se aplica una vez por valor de la variable (para otro reset, otro valor).
     */
    resetPropietario(valor) {
      const marca = sha256(`reset:${valor}`);
      const previa = db.prepare("SELECT valor FROM ajustes WHERE clave = 'reset_owner_aplicado'").get()?.valor;
      if (previa === marca) return false;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM sesiones_web').run();
        db.prepare('DELETE FROM codigos_recuperacion').run();
        db.prepare('DELETE FROM usuarios_web').run();
        db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('reset_owner_aplicado', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(marca);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      auditar(db, 'reset_owner', { actor: 'variable SUPERAGENT_RESET_OWNER', rol: 'sistema' });
      abiertoHasta = 0;
      codigoSetup = config.setupCode || codigoLegible(3, 4);
      log.log(`\n[setup] SUPERAGENT_RESET_OWNER: el panel volvió a modo setup (personas, roles, memoria y repos se conservan).\n[setup] Código de setup: ${codigoSetup}\n[setup] Quitá la variable cuando termines.\n`);
      return true;
    },

    _usuarioParaRecuperar(email, meta) {
      const e = String(email ?? '').trim().toLowerCase();
      limitar(`recuperar:${meta.ip}`);
      limitar(`recuperar:${e}`);
      const u = db.prepare('SELECT * FROM usuarios_web WHERE email = ?').get(e);
      if (!u) { fallo(`recuperar:${meta.ip}`); fallo(`recuperar:${e}`); throw new ErrorAuth('Los datos no coinciden.', 401); }
      return u;
    },
    _falloRecuperacion(email, meta) {
      fallo(`recuperar:${meta.ip}`); fallo(`recuperar:${email}`);
      auditar(db, 'recuperar.fallido', { actor: email, detalle: { ip: meta.ip ?? null } });
      return new ErrorAuth('Los datos no coinciden.', 401);
    },
    _cerrarTodoYAuditar(u, accion) {
      db.prepare('DELETE FROM sesiones_web WHERE usuario_id = ?').run(u.id);
      intentos.delete(`recuperar:${u.email}`);
      auditar(db, accion, { actor: u.email, rol: 'Propietario' });
      return { ok: true };
    },

    crearSesion(usuarioId, { ip = null, userAgent = null } = {}) {
      const valor = token();
      const ahora = Date.now();
      db.prepare('INSERT INTO sesiones_web (id, usuario_id, creada, vence, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sha256(valor), usuarioId, ahora, ahora + DURACION_SESION, ip, String(userAgent ?? '').slice(0, 300));
      return { valor, vence: ahora + DURACION_SESION };
    },

    sesionDe(valorCookie) {
      if (!valorCookie) return null;
      const s = db.prepare(`SELECT s.id, s.usuario_id, s.vence, u.email, u.persona_id, u.accesos, p.nombre, r.nombre AS rol
        FROM sesiones_web s JOIN usuarios_web u ON u.id = s.usuario_id
        JOIN personas p ON p.id = u.persona_id LEFT JOIN roles r ON r.id = p.rol_id
        WHERE s.id = ?`).get(sha256(valorCookie));
      if (!s) return null;
      if (s.vence < Date.now()) {
        db.prepare('DELETE FROM sesiones_web WHERE id = ?').run(s.id);
        return null;
      }
      return s;
    },

    // --- Invitaciones al panel: link de un solo uso (72 h). El invitado crea su cuenta con contraseña y app de
    // códigos, y ve solo las secciones que le dieron (o todo, como co-propietario).
    crearInvitacion({ nombre, accesos, creadaPor }) {
      return crearInvitacionEnBase(db, { nombre, accesos, creadaPor });
    },

    verInvitacion(valor) {
      const i = db.prepare('SELECT * FROM invitaciones WHERE hash = ?').get(sha256(String(valor ?? '')));
      if (!i || i.usada || i.vence < Date.now()) throw new ErrorAuth('La invitación no es válida o ya se usó. Pedí una nueva.', 410);
      return { id: i.id, nombre: i.nombre, accesos: i.accesos ? JSON.parse(i.accesos) : 'todo' };
    },

    listarInvitaciones() {
      const inv = db.prepare('SELECT id, nombre, accesos, creada, vence, usada FROM invitaciones WHERE usada IS NULL AND vence > ? ORDER BY creada DESC').all(Date.now());
      const usuarios = db.prepare(`SELECT u.id, u.email, u.accesos, u.creado, p.nombre, r.nombre AS rol FROM usuarios_web u
        JOIN personas p ON p.id = u.persona_id LEFT JOIN roles r ON r.id = p.rol_id ORDER BY u.creado`).all();
      const acc = (a, rol) => (rol === 'Propietario' || a == null ? 'todo' : JSON.parse(a));
      return {
        invitaciones: inv.map((i) => ({ ...i, accesos: i.accesos ? JSON.parse(i.accesos) : 'todo' })),
        usuarios: usuarios.map((u) => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, accesos: acc(u.accesos, u.rol), creado: u.creado })),
      };
    },

    revocarInvitacion(id, actor) {
      const r = db.prepare('DELETE FROM invitaciones WHERE id = ? AND usada IS NULL').run(id);
      if (r.changes) auditar(db, 'invitacion.revocar', { actor: actor ?? '', detalle: { id } });
      return r.changes > 0;
    },

    /** Quita el acceso al panel de un usuario (nunca al único Propietario). */
    quitarUsuario(usuarioId, actor) {
      const u = db.prepare(`SELECT u.id, r.nombre AS rol FROM usuarios_web u JOIN personas p ON p.id = u.persona_id
        LEFT JOIN roles r ON r.id = p.rol_id WHERE u.id = ?`).get(usuarioId);
      if (!u) throw new ErrorAuth('No existe ese usuario.', 404);
      const dueños = db.prepare(`SELECT COUNT(*) AS n FROM usuarios_web u JOIN personas p ON p.id = u.persona_id
        JOIN roles r ON r.id = p.rol_id WHERE r.nombre = 'Propietario'`).get().n;
      if (u.rol === 'Propietario' && dueños <= 1) throw new ErrorAuth('No se puede quitar al único Propietario.', 409);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM sesiones_web WHERE usuario_id = ?').run(usuarioId);
        db.prepare('DELETE FROM codigos_recuperacion WHERE usuario_id = ?').run(usuarioId);
        db.prepare('UPDATE invitaciones SET usuario_id = NULL WHERE usuario_id = ?').run(usuarioId);
        db.prepare('DELETE FROM usuarios_web WHERE id = ?').run(usuarioId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      auditar(db, 'panel.quitar_usuario', { actor: actor ?? '', detalle: { usuarioId } });
      return true;
    },

    async iniciarInvitacion({ invitacion, email, contrasena }, ip) {
      limitar(`invitacion:${ip}`);
      const inv = this.verInvitacion(invitacion);
      const e = validarEmail(email);
      if (db.prepare('SELECT 1 FROM usuarios_web WHERE email = ?').get(e)) throw new ErrorAuth('Ese email ya tiene cuenta en este panel.', 409);
      validarContrasena(contrasena);
      const secreto = nuevoSecretoTotp();
      const t = token();
      pendientes.set(t, { email: e, hash: hashContrasena(contrasena), secreto, vence: Date.now() + DURACION_SETUP, invitacion: inv.id });
      const otpauth = urlOtpauth(secreto, e);
      return { token: t, otpauth, secreto, qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 240 }) };
    },

    confirmarInvitacion({ token: t, totp: codigo, nombre }, meta) {
      const p = pendientes.get(t);
      if (!p?.invitacion || p.vence < Date.now()) throw new ErrorAuth('Se venció. Empezá de nuevo desde el link.', 410);
      const inv = db.prepare('SELECT * FROM invitaciones WHERE id = ?').get(p.invitacion);
      if (!inv || inv.usada || inv.vence < Date.now()) throw new ErrorAuth('La invitación no es válida o ya se usó.', 410);
      const paso = verificarTotp(p.secreto, codigo);
      if (paso == null) throw new ErrorAuth('El código de la app no coincide. Revisá la hora del teléfono y probá de nuevo.', 401);
      const ahora = Date.now();
      const recuperacion = Array.from({ length: 10 }, () => codigoLegible(2, 5));
      db.exec('BEGIN');
      try {
        // Acceso total = co-propietario. Con secciones, entra como Tercero: para el agente no tiene permisos
        // hasta que el Propietario le dé un rol.
        const rol = db.prepare('SELECT id FROM roles WHERE nombre = ? AND predefinido = 1').get(inv.accesos ? 'Tercero' : 'Propietario');
        const persona = db.prepare('INSERT INTO personas (nombre, rol_id, alta_manual, creada) VALUES (?, ?, 1, ?)')
          .run(String(nombre || inv.nombre || '').trim().slice(0, 100) || null, rol.id, ahora);
        const u = db.prepare(`INSERT INTO usuarios_web (persona_id, email, hash_contrasena, totp_secreto, totp_ultimo_paso, creado, accesos)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(persona.lastInsertRowid, p.email, p.hash, cifrar(config.sessionSecret, p.secreto, 'totp'), paso, ahora, inv.accesos);
        const ins = db.prepare('INSERT INTO codigos_recuperacion (usuario_id, hash) VALUES (?, ?)');
        for (const c of recuperacion) ins.run(u.lastInsertRowid, sha256(normalizarCodigo(c)));
        db.prepare('UPDATE invitaciones SET usada = ?, usuario_id = ? WHERE id = ?').run(ahora, u.lastInsertRowid, inv.id);
        db.exec('COMMIT');
        pendientes.delete(t);
        auditar(db, 'invitacion.aceptada', { actor: p.email, detalle: { invitacion: inv.id } });
        return { recuperacion, sesion: this.crearSesion(Number(u.lastInsertRowid), meta) };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    cerrarSesion(valorCookie) {
      if (valorCookie) db.prepare('DELETE FROM sesiones_web WHERE id = ?').run(sha256(valorCookie));
    },

    listarSesiones(usuarioId, idActual) {
      return db.prepare('SELECT id, creada, vence, ip, user_agent FROM sesiones_web WHERE usuario_id = ? AND vence > ? ORDER BY creada DESC')
        .all(usuarioId, Date.now())
        .map((s) => ({ actual: s.id === idActual, creada: s.creada, vence: s.vence, ip: s.ip, userAgent: s.user_agent }));
    },

    cerrarOtras(usuarioId, idActual) {
      const r = db.prepare('DELETE FROM sesiones_web WHERE usuario_id = ? AND id != ?').run(usuarioId, idActual);
      return r.changes;
    },

    codigosRestantes(usuarioId) {
      return db.prepare('SELECT COUNT(*) n FROM codigos_recuperacion WHERE usuario_id = ? AND usado_en IS NULL').get(usuarioId).n;
    },
  };
}
