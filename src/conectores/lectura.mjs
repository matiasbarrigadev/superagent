// Conector de solo lectura: sus herramientas no cuentan como escritura (no piden aprobación y las ve un rol que solo
// lee). Lo es si su URL se lo pide al servicio (por ejemplo Supabase con read_only=true, que bloquea las escrituras
// en la propia base) o si el Propietario lo marcó así, con confirmación, sabiendo que el servicio solo lee.
import { json } from '../util.mjs';

export const pideSoloLectura = (url) => /[?&]read_only=(true|1)(&|$)/i.test(String(url ?? ''));

export function soloLectura(c) {
  const hab = typeof c?.habilitada_para === 'string' ? json(c.habilitada_para, {}) : (c?.habilitada_para ?? {});
  return hab.solo_lectura === true || pideSoloLectura(c?.url_mcp);
}
