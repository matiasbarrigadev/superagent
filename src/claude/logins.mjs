// Logins que el agente hizo con las CLIs en el entorno del Propietario (gh, vercel, supabase). El panel los muestra
// como conectados y GitHub los usa para los repos de los trabajos, sin pedir otro token.
// Se leen con el usuario del entorno (nunca como root siguiendo enlaces) y no se muestra ningún valor.
import path from 'node:path';

export function crearLoginsDelEntorno({ aislamiento }) {
  function leer(rel) {
    if (!aislamiento?.rutas) return null;
    const base = aislamiento.rutas('propietario').base;
    try { return aislamiento.leerComo(aislamiento.usuarioDe('propietario'), path.join(base, rel), 200_000).toString('utf8'); } catch { return null; }
  }
  const alguno = (rutas) => rutas.some((r) => leer(r) != null);

  /** Token y usuario de "gh auth login" (hosts.yml de gh, sin llavero en el contenedor). */
  function github() {
    const y = leer('.config/gh/hosts.yml');
    if (!y) return null;
    const bloque = y.split(/\n(?=\S)/).find((b) => /^github\.com:/.test(b)) ?? '';
    const token = /oauth_token:\s*(\S+)/.exec(bloque)?.[1] ?? null;
    const usuario = /^\s+user:\s*(\S+)/m.exec(bloque)?.[1] ?? null;
    return token ? { token, usuario } : null;
  }

  function detectar() {
    const gh = github();
    return [
      { servicio: 'GitHub', conectado: !!gh, cuenta: gh?.usuario ?? null, como: 'gh auth login' },
      { servicio: 'Vercel', conectado: alguno(['.local/share/com.vercel.cli/auth.json', '.vercel/auth.json']), cuenta: null, como: 'vercel login' },
      { servicio: 'Supabase', conectado: alguno(['.supabase/access-token']), cuenta: null, como: 'supabase login' },
    ];
  }

  return { detectar, tokenGithub: () => github()?.token ?? null, usuarioGithub: () => github()?.usuario ?? null };
}
