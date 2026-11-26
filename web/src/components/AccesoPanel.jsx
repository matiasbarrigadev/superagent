// Quién entra al panel: usuarios con su acceso, invitaciones pendientes y un link nuevo de invitación.
// El invitado crea su cuenta (contraseña + app de códigos) y ve solo las secciones elegidas.
import { useState } from 'react';
import { borrar, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, Campo, Estado, Tarjeta } from './ui.jsx';

const fecha = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export default function AccesoPanel({ secciones = {}, usuario }) {
  const d = useDatos('/api/invitaciones');
  const [nombre, setNombre] = useState('');
  const [todo, setTodo] = useState(false);
  const [elegidas, setElegidas] = useState(['whatsapp']);
  const [link, setLink] = useState(null);
  const [copiado, setCopiado] = useState(false);
  const { cargando, error, correr } = useAccion();
  const nombreDe = (a) => (a === 'todo' ? 'Todo (co-propietario)' : a.map((s) => secciones[s]?.nombre ?? s).join(', '));
  const alternar = (s) => setElegidas((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));

  const invitar = correr('invitar', async () => {
    const r = await post('/api/invitaciones', { nombre, accesos: todo ? ['todo'] : elegidas });
    setLink(r.link); setCopiado(false); setNombre(''); d.cargar();
  });
  const copiar = async () => { try { await navigator.clipboard.writeText(link); setCopiado(true); } catch {} };

  return (
    <Tarjeta titulo="Acceso al panel">
      <div className="flex flex-col gap-5 text-sm">
        <ul className="flex flex-col divide-y divide-stone-100 dark:divide-stone-800">
          {(d.datos?.usuarios ?? []).map((u) => (
            <li key={`u${u.id}`} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium">{u.nombre || u.email}</span>
              <span className="text-stone-500 dark:text-stone-400">{u.email}</span>
              <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{u.rol === 'Propietario' && u.accesos === 'todo' ? 'Propietario' : nombreDe(u.accesos)}</span>
              {u.email !== usuario?.email && (
                <Boton variante="fantasma" cargando={cargando === `q${u.id}`} onClick={correr(`q${u.id}`, async () => { await borrar(`/api/usuarios-panel/${u.id}`); d.cargar(); })}>Quitar</Boton>
              )}
            </li>
          ))}
          {(d.datos?.invitaciones ?? []).map((i) => (
            <li key={`i${i.id}`} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium">{i.nombre || 'Invitación'}</span>
              <Estado tono="espera">Invitado · vence {fecha(i.vence)}</Estado>
              <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{nombreDe(i.accesos)}</span>
              <Boton variante="fantasma" cargando={cargando === `r${i.id}`} onClick={correr(`r${i.id}`, async () => { await borrar(`/api/invitaciones/${i.id}`); d.cargar(); })}>Revocar</Boton>
            </li>
          ))}
        </ul>

        <form onSubmit={invitar} className="flex flex-col gap-3 rounded-xl bg-stone-50 p-4 dark:bg-stone-800/40">
          <p className="font-medium">Invitar a alguien</p>
          <Campo etiqueta="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Por ejemplo, Ana" required />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-stone-500 dark:text-stone-400">Qué puede ver y hacer</legend>
            {Object.entries(secciones).map(([id, s]) => (
              <label key={id} className={`flex items-start gap-2 ${todo ? 'opacity-50' : ''}`}>
                <input type="checkbox" className="mt-0.5 size-4 accent-emerald-700" disabled={todo} checked={todo || elegidas.includes(id)} onChange={() => alternar(id)} />
                <span><span className="font-medium">{s.nombre}</span> <span className="text-stone-500 dark:text-stone-400">· {s.detalle}</span></span>
              </label>
            ))}
            <label className="mt-1 flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-emerald-700" checked={todo} onChange={(e) => setTodo(e.target.checked)} />
              <span><span className="font-medium">Todo, como co-propietario</span> <span className="text-stone-500 dark:text-stone-400">· acceso total al panel y al agente.</span></span>
            </label>
          </fieldset>
          <Boton cargando={cargando === 'invitar'} disabled={!nombre || (!todo && !elegidas.length)}>Crear link de invitación</Boton>
        </form>

        {link && (
          <div className="flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p>Mandale este link (sirve una sola vez y vence en 72 horas):</p>
            <code className="break-all rounded bg-white p-2 font-mono text-xs dark:bg-stone-900">{link}</code>
            <div><Boton variante="secundario" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar link'}</Boton></div>
          </div>
        )}
        {error && <Aviso>{error}</Aviso>}
        <p className="text-xs text-stone-500 dark:text-stone-400">También le podés pedir al agente por WhatsApp: "invitá a Ana al panel para que vincule el WhatsApp".</p>
      </div>
    </Tarjeta>
  );
}
