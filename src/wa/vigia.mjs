// Vigía de la sesión de WhatsApp. WAHA guarda las credenciales en su volumen y solo las borra si WhatsApp
// desvincula el dispositivo (o alguien lo hace desde el teléfono o el panel). Todo lo demás —un corte de red, un
// reinicio de WAHA, un FAILED pasajero— se arregla volviendo a arrancar la sesión, sin QR nuevo.
// Antes eso solo pasaba al arrancar el gateway o con el panel abierto; ahora lo hace este vigía, solo.
//
// - WORKING / STARTING / SCAN_QR_CODE: no se toca (lo último necesita a una persona con el teléfono).
// - STOPPED / FAILED / NO_CREADA: se arranca de nuevo, con espera creciente para no insistir en loop
//   (30 s, 1 min, 2 min, 5 min, y después cada 10 min) hasta que vuelva a andar.
// - Nunca hace logout ni borra nada.

const ESPERAS = [30_000, 60_000, 120_000, 300_000, 600_000];
const CAIDA = new Set(['STOPPED', 'FAILED', 'NO_CREADA']);

export function crearVigiaWhatsApp({ waha, reloj = () => Date.now(), log = console, intervalo = 30_000 }) {
  let intentos = 0;
  let proximo = 0;
  let ultimo = null;
  let ocupado = false;

  async function revisar() {
    if (ocupado) return null;
    ocupado = true;
    try {
      const { status } = await waha.estado();
      if (status !== ultimo) {
        if (ultimo != null) log.log?.(`[whatsapp] vigía: ${ultimo} → ${status}`);
        ultimo = status;
      }
      if (!CAIDA.has(status)) { intentos = 0; proximo = 0; return status; }
      if (reloj() < proximo) return status;
      intentos++;
      proximo = reloj() + ESPERAS[Math.min(intentos - 1, ESPERAS.length - 1)];
      log.warn?.(`[whatsapp] vigía: sesión ${status}, se vuelve a arrancar (intento ${intentos})`);
      await waha.asegurar();
      return status;
    } catch (e) {
      // WAHA no responde (reiniciándose): se vuelve a mirar en la próxima vuelta.
      if (ultimo !== 'SIN_WAHA') log.warn?.('[whatsapp] vigía:', e.message);
      ultimo = 'SIN_WAHA';
      return null;
    } finally {
      ocupado = false;
    }
  }

  let t = null;
  return {
    revisar,
    iniciar() { if (!t) { t = setInterval(revisar, intervalo); t.unref?.(); } },
    detener() { clearInterval(t); t = null; },
    /** Un evento de estado de WAHA: si es una caída, se mira enseguida (sin esperar la vuelta). */
    aviso(status) { if (CAIDA.has(status)) setTimeout(revisar, 2_000).unref?.(); },
  };
}
