// Estructura del panel: sidebar con las secciones (cajón en el teléfono) y el contenido a la derecha.
// La sección queda en la URL (#bandeja, #chat…) para que recargar no te saque de donde estabas.
import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { useDatos } from '../hooks.js';
import { Avatar } from '../components/Mensajes.jsx';
import {
  IconoAgente, IconoBandeja, IconoBitacora, IconoCerrar, IconoChat, IconoClientes, IconoConexiones, IconoCuenta, IconoInicio, IconoMenu, IconoMotores, IconoPersonas, IconoSalir,
} from '../components/iconos.jsx';
import Inicio from './Inicio.jsx';
import Bandeja from './Bandeja.jsx';
import Ajustes from './Ajustes.jsx';
import VerAgente from './VerAgente.jsx';
import Personas from './Personas.jsx';
import Agente from './Agente.jsx';
import Conexiones from './Conexiones.jsx';
import Clientes from './Clientes.jsx';
import Bitacora from './Bitacora.jsx';
import Motores from './Motores.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');

const SECCIONES = [
  // requiere: sección de acceso que necesita un invitado ("libre" = cualquiera; sin requiere = solo acceso total).
  { id: 'inicio', nombre: 'Inicio', Icono: IconoInicio, requiere: 'libre' },
  { id: 'bandeja', nombre: 'Bandeja', Icono: IconoBandeja, completa: true, requiere: 'bandeja' },
  { id: 'chat', nombre: 'Ver al agente', corto: 'Agente IA', Icono: IconoChat, completa: true },
  { separador: 'Equipo' },
  { id: 'personas', nombre: 'Personas', Icono: IconoPersonas, requiere: 'equipo' },
  { id: 'clientes', nombre: 'Clientes', Icono: IconoClientes, requiere: 'equipo' },
  { id: 'bitacora', nombre: 'Bitácora', Icono: IconoBitacora, requiere: 'bitacora' },
  { separador: 'Configuración' },
  { id: 'agente', nombre: 'Agente', Icono: IconoAgente },
  { id: 'motores', nombre: 'Motores de IA', Icono: IconoMotores },
  { id: 'conexiones', nombre: 'Conexiones', Icono: IconoConexiones, requiere: 'conexiones' },
  { id: 'ajustes', nombre: 'Cuenta', Icono: IconoCuenta, requiere: 'libre' },
];
/** ¿Este usuario ve la sección (o el acceso) dado? */
export const tiene = (usuario, acceso) => usuario?.accesos === 'todo' || acceso === 'libre' || (Array.isArray(usuario?.accesos) && usuario.accesos.includes(acceso));
const visibles = (usuario) => {
  const v = SECCIONES.filter((s) => s.separador || tiene(usuario, s.requiere ?? 'todo'));
  return v.filter((s, i) => !s.separador || (v[i + 1] && !v[i + 1].separador));
};
const VALIDAS = SECCIONES.filter((s) => s.id).map((s) => s.id);
// "#entorno?pedido=…" (el link que manda el agente) abre Conexiones, donde se cargan las variables.
const ALIAS = { entorno: 'conexiones' };
const desdeHash = () => {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const s = ALIAS[h] ?? h;
  return VALIDAS.includes(s) ? s : 'inicio';
};

function Punto({ tono }) {
  const color = { ok: 'bg-emerald-500', espera: 'bg-amber-500', error: 'bg-red-500', neutro: 'bg-stone-400' }[tono];
  return <span className={cx('size-2 shrink-0 rounded-full', color)} aria-hidden="true" />;
}

/** Estado de WhatsApp y Claude, abajo de la sidebar. */
function Conexion({ irA, usuario }) {
  const [wa, setWa] = useState(null);
  const [cl, setCl] = useState(null);
  useEffect(() => {
    let vivo = true;
    const traer = async () => {
      const [a, b] = await Promise.all([api('/api/whatsapp/estado').catch(() => null), api('/api/claude/estado').catch(() => null)]);
      if (vivo) { setWa(a); setCl(b); }
    };
    traer();
    const t = setInterval(traer, 20000);
    return () => { vivo = false; clearInterval(t); };
  }, []);
  const estadoWa = String(wa?.estado ?? wa?.status ?? '').toUpperCase();
  const waOk = estadoWa === 'WORKING' || wa?.conectado;
  const filas = [
    tiene(usuario, 'whatsapp') && { nombre: 'WhatsApp', tono: !wa ? 'neutro' : waOk ? 'ok' : 'espera', texto: !wa ? '…' : waOk ? 'Conectado' : estadoWa === 'SCAN_QR_CODE' ? 'Falta vincular' : 'Sin conectar' },
    tiene(usuario, 'claude') && { nombre: 'Claude', tono: !cl ? 'neutro' : cl.conectado && cl.funciona === false ? 'error' : cl.conectado ? 'ok' : 'espera', texto: !cl ? '…' : cl.conectado && cl.funciona === false ? 'No funciona' : cl.conectado ? 'Conectado' : 'Sin conectar' },
  ].filter(Boolean);
  if (!filas.length) return null;
  return (
    <button type="button" onClick={() => irA('inicio')} className="mx-3 mb-2 flex flex-col gap-1.5 rounded-xl bg-stone-100 px-3 py-2.5 text-left text-xs transition hover:bg-stone-200/70 dark:bg-stone-800/60 dark:hover:bg-stone-800">
      {filas.map((f) => (
        <span key={f.nombre} className="flex items-center gap-2">
          <Punto tono={f.tono} />
          <span className="font-medium">{f.nombre}</span>
          <span className="ml-auto text-stone-500 dark:text-stone-400">{f.texto}</span>
        </span>
      ))}
    </button>
  );
}

function Sidebar({ seccion, irA, pendientes, usuario, salir, cerrar }) {
  return (
    <div className="flex h-full flex-col bg-white dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <img src="/icono.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">Superagent</span>
        </div>
        {cerrar && (
          <button type="button" onClick={cerrar} className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Cerrar menú"><IconoCerrar /></button>
        )}
      </div>
      <nav className="scroll-fino flex-1 overflow-y-auto px-3" aria-label="Secciones">
        {visibles(usuario).map((s, i) => (s.separador ? (
          <p key={`s${i}`} className="mt-5 mb-1.5 px-3 text-[0.7rem] font-semibold tracking-wider text-stone-400 uppercase dark:text-stone-500">{s.separador}</p>
        ) : (
          <button key={s.id} type="button" onClick={() => irA(s.id)} aria-current={seccion === s.id ? 'page' : undefined}
            className={cx('group mb-0.5 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition',
              seccion === s.id
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100')}>
            <s.Icono className={cx('size-5 shrink-0', seccion === s.id ? 'text-emerald-600 dark:text-emerald-400' : 'text-stone-400 group-hover:text-stone-600 dark:text-stone-500 dark:group-hover:text-stone-300')} />
            <span className="truncate">{s.nombre}</span>
            {s.id === 'inicio' && pendientes > 0 && <span className="ml-auto rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">{pendientes}</span>}
          </button>
        )))}
      </nav>
      <Conexion irA={irA} usuario={usuario} />
      <div className="flex items-center gap-3 border-t border-stone-200 px-4 py-3 dark:border-stone-800">
        <Avatar nombre={usuario?.nombre || usuario?.email} className="size-9 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{usuario?.nombre || usuario?.email}</p>
          <p className="truncate text-xs text-stone-500 dark:text-stone-400">{usuario?.email}</p>
        </div>
        <button type="button" onClick={salir} className="rounded-lg p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100" aria-label="Salir" title="Salir">
          <IconoSalir />
        </button>
      </div>
    </div>
  );
}

export default function Panel({ usuario, secciones, version, alSalir }) {
  const [seccion, setSeccionCruda] = useState(desdeHash);
  // Un invitado que llega a una sección que no ve, cae en Inicio.
  const setSeccion = (id) => setSeccionCruda(visibles(usuario).some((s) => s.id === id) ? id : 'inicio');
  useEffect(() => { setSeccion(seccion); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [menu, setMenu] = useState(false);
  const resumen = useDatos('/api/resumen', { cada: 10000 });
  const r = resumen.datos;
  const pendientes = (r?.propuestas ?? 0) + (r?.aprobaciones ?? 0);

  useEffect(() => {
    const alCambiar = () => setSeccion(desdeHash());
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, []);
  useEffect(() => {
    const s = SECCIONES.find((x) => x.id === seccion);
    document.title = s && seccion !== 'inicio' ? `${s.corto ?? s.nombre} · Superagent` : 'Superagent';
  }, [seccion]);

  const irA = (id) => {
    setMenu(false);
    if (id !== seccion) window.location.hash = id === 'inicio' ? '' : id;
    setSeccion(id);
  };
  const salir = async () => {
    await post('/api/auth/logout').catch(() => {});
    alSalir();
  };
  const actual = SECCIONES.find((s) => s.id === seccion);
  const lateral = { seccion, irA, pendientes, usuario, salir };

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar fija en pantallas grandes. */}
      <aside className="hidden w-64 shrink-0 border-r border-stone-200 lg:block dark:border-stone-800">
        <Sidebar {...lateral} />
      </aside>

      {/* Cajón en el teléfono. */}
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <button type="button" className="absolute inset-0 bg-stone-950/40 backdrop-blur-[1px]" onClick={() => setMenu(false)} aria-label="Cerrar menú" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl"><Sidebar {...lateral} cerrar={() => setMenu(false)} /></div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-3 py-2.5 lg:hidden dark:border-stone-800 dark:bg-stone-900">
          <button type="button" onClick={() => setMenu(true)} className="relative rounded-lg p-1.5 text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800" aria-label="Abrir menú">
            <IconoMenu />
            {pendientes > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-amber-500" />}
          </button>
          <img src="/icono.svg" alt="" className="size-6" />
          <span className="truncate font-semibold">{actual?.corto ?? actual?.nombre}</span>
        </header>

        {actual?.completa ? (
          <main className="min-h-0 flex-1">
            {seccion === 'bandeja' && <Bandeja />}
            {seccion === 'chat' && <VerAgente />}
          </main>
        ) : (
          <main className="scroll-fino min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
              {seccion === 'inicio' && <Inicio resumen={resumen} irA={irA} usuario={usuario} />}
              {seccion === 'personas' && <Encabezado titulo="Personas" texto="Quiénes pueden hablar con el agente y con qué rol, y quién entra al panel." ><Personas usuario={usuario} secciones={secciones} /></Encabezado>}
              {seccion === 'clientes' && <Encabezado titulo="Clientes" texto="Cada cliente con su rol, su autonomía y su memoria."><Clientes /></Encabezado>}
              {seccion === 'bitacora' && <Encabezado titulo="Bitácora" texto="Lo que se aprobó, rechazó o decidió con el agente."><Bitacora /></Encabezado>}
              {seccion === 'agente' && <Encabezado titulo="Agente" texto="Modelos, grupos, rutinas, entradas y reglas de contacto."><Agente /></Encabezado>}
              {seccion === 'motores' && <Encabezado titulo="Motores de IA" texto="Claude, Codex, Gemini y OpenCode: quién atiende cada conversación, el respaldo, los topes de gasto y las claves."><Motores /></Encabezado>}
              {seccion === 'conexiones' && <Encabezado titulo="Conexiones" texto="GitHub, proyectos y conectores que el agente puede usar."><Conexiones /></Encabezado>}
              {seccion === 'ajustes' && <Encabezado titulo="Cuenta" texto="Tu acceso al panel y la seguridad de la instalación."><Ajustes usuario={usuario} version={version} /></Encabezado>}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

function Encabezado({ titulo, texto, children }) {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{titulo}</h1>
        {texto && <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{texto}</p>}
      </div>
      {children}
    </>
  );
}
