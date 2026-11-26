// Cliente de WAHA (motor GOWS): sesión, QR, código de vinculación y desvincular.
export class ErrorWaha extends Error {
  constructor(mensaje, status = 502) { super(mensaje); this.status = status; }
}

export function crearWaha({ url, apiKey, session, hookUrl, hmacKey, fetch: f = globalThis.fetch }) {
  async function llamar(ruta, { method = 'GET', body, accept = 'application/json' } = {}) {
    let r;
    try {
      r = await f(`${url}${ruta}`, {
        method,
        headers: { 'X-Api-Key': apiKey ?? '', Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ErrorWaha(`WAHA no responde (${e.cause?.code ?? e.name}).`, 503);
    }
    return r;
  }

  // Eventos que escucha el gateway (GOWS los soporta todos): mensajes, reacciones, ediciones, borrados y votos.
  const EVENTOS = ['message.any', 'session.status', 'message.reaction', 'message.edited', 'message.revoked', 'poll.vote'];
  const configSesion = () => ({
    webhooks: [{
      url: hookUrl,
      events: EVENTOS,
      hmac: { key: hmacKey },
      retries: { policy: 'linear', delaySeconds: 5, attempts: 15 },
    }],
  });

  let eventosAlDia = false;
  const enviar = async (ruta, cuerpo, que) => idEnviado(await llamar(ruta, { method: 'POST', body: { session, ...cuerpo } }), que);
  const enc = (x) => encodeURIComponent(x);

  return {
    session,

    async estado() {
      const r = await llamar(`/api/sessions/${session}`);
      if (r.status === 404) return { status: 'NO_CREADA', me: null };
      if (r.status === 401) throw new ErrorWaha('WAHA rechazó la clave de API.', 502);
      if (!r.ok) throw new ErrorWaha(`WAHA respondió ${r.status}.`);
      const s = await r.json();
      return { status: s.status ?? 'DESCONOCIDO', me: s.me ? { id: s.me.id, nombre: s.me.pushName ?? null } : null };
    },

    /** Crea la sesión si no existe (con el webhook firmado) y la arranca si está parada. */
    async asegurar() {
      const { status } = await this.estado();
      if (status === 'NO_CREADA') {
        const r = await llamar('/api/sessions', { method: 'POST', body: { name: session, start: true, config: configSesion() } });
        if (!r.ok && r.status !== 409 && r.status !== 422) throw new ErrorWaha(`No se pudo crear la sesión (${r.status}).`);
        return;
      }
      // Sesiones creadas antes de sumar eventos: se actualiza el webhook una vez (WAHA reinicia la sesión, sin desvincular).
      if (status === 'WORKING' && !eventosAlDia) {
        const s = await llamar(`/api/sessions/${session}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const actuales = new Set(s?.config?.webhooks?.find((w) => w.url === hookUrl)?.events ?? []);
        if (s && EVENTOS.some((e) => !actuales.has(e))) {
          const r = await llamar(`/api/sessions/${session}`, { method: 'PUT', body: { config: { ...(s.config ?? {}), ...configSesion() } } });
          if (r.ok) eventosAlDia = true;
        } else if (s) eventosAlDia = true;
        return;
      }
      if (status === 'STOPPED' || status === 'FAILED') {
        // Al arrancar se reaplica la config, por si cambió la URL del webhook o la clave HMAC.
        await llamar(`/api/sessions/${session}`, { method: 'PUT', body: { config: configSesion() } });
        const r = await llamar(`/api/sessions/${session}/start`, { method: 'POST' });
        if (!r.ok && r.status !== 409 && r.status !== 422) throw new ErrorWaha(`No se pudo arrancar la sesión (${r.status}).`);
      }
    },

    /** Grupos en los que está el número: [{ id, nombre }]. */
    async grupos() {
      const r = await llamar(`/api/${session}/groups?limit=500`);
      if (!r.ok) throw new ErrorWaha(`WAHA respondió ${r.status} al listar grupos.`);
      const d = await r.json();
      const lista = Array.isArray(d) ? d : Object.values(d ?? {});
      return lista.map((g) => ({
        id: String(g.JID ?? g.id?._serialized ?? g.id ?? ''),
        nombre: g.Name ?? g.name ?? g.subject ?? null,
      })).filter((g) => g.id.endsWith('@g.us'));
    },

    /** Llamada directa a la API de WAHA (para el Propietario). `{session}` en la ruta se reemplaza. */
    async api(metodo, ruta, cuerpo = null) {
      const r = await llamar(ruta.replaceAll('{session}', session), { method: metodo, body: cuerpo ?? undefined });
      const tipo = r.headers.get('content-type') ?? '';
      const datos = tipo.includes('json') ? await r.json().catch(() => null) : tipo.startsWith('text/') ? await r.text() : `(${tipo || 'binario'}, ${r.headers.get('content-length') ?? '?'} bytes)`;
      return { status: r.status, datos };
    },

    /** PNG del QR. Solo existe mientras el estado es SCAN_QR_CODE. */
    async qr() {
      const r = await llamar(`/api/${session}/auth/qr?format=image`, { accept: 'image/png' });
      if (!r.ok) throw new ErrorWaha('No hay QR disponible ahora.', r.status === 404 || r.status === 422 ? 409 : 502);
      return { tipo: r.headers.get('content-type') ?? 'image/png', datos: Buffer.from(await r.arrayBuffer()) };
    },

    /** Código de vinculación de 8 caracteres para cuando no se puede escanear. */
    async pedirCodigo(telefono) {
      const r = await llamar(`/api/${session}/auth/request-code`, { method: 'POST', body: { phoneNumber: telefono } });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new ErrorWaha(`WAHA no pudo generar el código (${r.status})${txt ? `: ${txt.slice(0, 200)}` : ''}.`, r.status === 422 ? 409 : 502);
      }
      const d = await r.json();
      return { codigo: d.code ?? d.pairingCode ?? null };
    },

    /** Desvincula el número y deja la sesión lista para un QR nuevo. */
    async desvincular() {
      await llamar(`/api/sessions/${session}/logout`, { method: 'POST' });
      const { status } = await this.estado();
      if (status === 'STOPPED' || status === 'FAILED') await llamar(`/api/sessions/${session}/start`, { method: 'POST' });
    },

    /** Borra la sesión de WAHA (desvincula y la elimina). Solo para números que no son el principal. */
    async borrar() {
      await llamar(`/api/sessions/${session}/logout`, { method: 'POST' }).catch(() => {});
      await llamar(`/api/sessions/${session}`, { method: 'DELETE' });
    },

    async reiniciar() {
      const r = await llamar(`/api/sessions/${session}/restart`, { method: 'POST' });
      if (!r.ok) throw new ErrorWaha(`No se pudo reiniciar la sesión (${r.status}).`);
    },

    // --- Salida.
    async enviarTexto(chatId, texto, { responderA = null, menciones = null } = {}) {
      const r = await llamar('/api/sendText', { method: 'POST', body: { session, chatId, text: texto, ...(responderA ? { reply_to: responderA } : {}), ...(menciones?.length ? { mentions: menciones } : {}) } });
      return idEnviado(r, 'texto');
    },

    /** Foto común de WhatsApp (se ve en el chat, no como documento). archivo: { mimetype, filename, data } */
    enviarImagen(chatId, archivo, { epigrafe = null, responderA = null } = {}) {
      return enviar('/api/sendImage', { chatId, file: archivo, ...(epigrafe ? { caption: epigrafe } : {}), ...(responderA ? { reply_to: responderA } : {}) }, 'foto');
    },
    enviarVideo(chatId, archivo, { epigrafe = null, responderA = null } = {}) {
      return enviar('/api/sendVideo', { chatId, file: archivo, convert: true, asNote: false, ...(epigrafe ? { caption: epigrafe } : {}), ...(responderA ? { reply_to: responderA } : {}) }, 'video');
    },
    /** Sticker: tiene que ser WebP. */
    enviarSticker(chatId, archivo) {
      return enviar('/api/sendSticker', { chatId, file: archivo }, 'sticker');
    },
    /** Reacción a un mensaje (emoji vacío la quita). */
    async reaccionar(mensajeId, emoji) {
      const r = await llamar('/api/reaction', { method: 'PUT', body: { session, messageId: mensajeId, reaction: emoji } });
      if (!r.ok) throw new ErrorWaha(`WAHA no pudo reaccionar (${r.status}).`);
      return null;
    },
    enviarUbicacion(chatId, { latitud, longitud, titulo = null }) {
      return enviar('/api/sendLocation', { chatId, latitude: latitud, longitude: longitud, ...(titulo ? { title: titulo } : {}) }, 'ubicación');
    },
    enviarContacto(chatId, { nombre, telefono, empresa = null }) {
      const digitos = String(telefono).replace(/\D/g, '');
      return enviar('/api/sendContactVcard', { chatId, contacts: [{ fullName: nombre, phoneNumber: `+${digitos}`, whatsappId: digitos, ...(empresa ? { organization: empresa } : {}) }] }, 'contacto');
    },
    enviarEncuesta(chatId, { pregunta, opciones, varias = false }) {
      return enviar('/api/sendPoll', { chatId, poll: { name: pregunta, options: opciones, multipleAnswers: !!varias } }, 'encuesta');
    },
    async editarMensaje(chatId, mensajeId, texto) {
      const r = await llamar(`/api/${session}/chats/${enc(chatId)}/messages/${enc(mensajeId)}`, { method: 'PUT', body: { text: texto } });
      if (!r.ok) throw new ErrorWaha(`WAHA no pudo editar el mensaje (${r.status}).`);
      return mensajeId;
    },
    async borrarMensaje(chatId, mensajeId) {
      const r = await llamar(`/api/${session}/chats/${enc(chatId)}/messages/${enc(mensajeId)}`, { method: 'DELETE' });
      if (!r.ok) throw new ErrorWaha(`WAHA no pudo borrar el mensaje (${r.status}).`);
      return mensajeId;
    },

    /** archivo: { mimetype, filename, data (base64) } */
    async enviarArchivo(chatId, archivo, { epigrafe = null } = {}) {
      const r = await llamar('/api/sendFile', { method: 'POST', body: { session, chatId, file: archivo, ...(epigrafe ? { caption: epigrafe } : {}) } });
      return idEnviado(r, 'archivo');
    },

    async enviarVoz(chatId, archivo) {
      const r = await llamar('/api/sendVoice', { method: 'POST', body: { session, chatId, file: archivo, convert: true } });
      return idEnviado(r, 'audio');
    },

    /** "Escribiendo…" (best effort: si falla no importa). */
    async escribiendo(chatId, prendido = true) {
      try { await llamar(prendido ? '/api/startTyping' : '/api/stopTyping', { method: 'POST', body: { session, chatId } }); } catch {}
    },

    async visto(chatId) {
      try { await llamar('/api/sendSeen', { method: 'POST', body: { session, chatId } }); } catch {}
    },

    // --- Entrada.
    /** Teléfono (solo dígitos) de un LID, o null. */
    async telefonoDeLid(lid) {
      const r = await llamar(`/api/${session}/lids/${encodeURIComponent(lid)}`);
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      const pn = String(d?.pn ?? '').replace(/@.*$/, '').replace(/\D/g, '');
      return pn || null;
    },

    /** LID (con @lid) de un teléfono, o null. */
    async lidDeTelefono(telefono) {
      const r = await llamar(`/api/${session}/lids/pn/${encodeURIComponent(telefono)}`);
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      return d?.lid ?? null;
    },

    /** Descarga un adjunto de WAHA. La URL que manda WAHA puede tener otro host (WAHA_BASE_URL): se usa solo la ruta. */
    async descargar(urlMedia, maxBytes = 50 * 1024 * 1024) {
      let ruta;
      try { ruta = new URL(urlMedia).pathname; } catch { ruta = String(urlMedia); }
      if (!ruta.startsWith('/api/files/')) throw new ErrorWaha('URL de adjunto inesperada.', 400);
      const r = await llamar(ruta, { accept: '*/*' });
      if (!r.ok) throw new ErrorWaha(`WAHA no entregó el adjunto (${r.status}).`);
      const largo = Number(r.headers.get('content-length') ?? 0);
      if (largo > maxBytes) throw new ErrorWaha('El adjunto es demasiado grande.', 413);
      const datos = Buffer.from(await r.arrayBuffer());
      if (datos.length > maxBytes) throw new ErrorWaha('El adjunto es demasiado grande.', 413);
      return { datos, tipo: r.headers.get('content-type') ?? 'application/octet-stream' };
    },
  };

  async function idEnviado(r, que) {
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new ErrorWaha(`WAHA no pudo enviar el ${que} (${r.status})${txt ? `: ${txt.slice(0, 200)}` : ''}.`, r.status >= 500 ? 503 : 502);
    }
    const d = await r.json().catch(() => ({}));
    return typeof d?.id === 'string' ? d.id : d?.id?._serialized ?? d?.key?.id ?? null;
  }
}

/** WhatsApp acepta el número internacional solo con dígitos (sin +, espacios ni guiones). */
export function normalizarTelefono(t) {
  const d = String(t ?? '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return null;
  return d;
}
