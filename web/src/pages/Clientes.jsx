// Clientes: grupos, proyectos, nivel de autonomía y roles por cliente.
import { useState } from 'react';
import { patch, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, Campo, Estado, Selector, Tarjeta, Vacio } from '../components/ui.jsx';

const AUTONOMIA = [
  { valor: 'via_libre', texto: 'Vía libre (lo que permite cada rol)' },
  { valor: 'consultar_lo_importante', texto: 'Consultar lo importante (publicar, escribir primero)' },
  { valor: 'consultar_todo', texto: 'Consultar todo lo que tenga efecto' },
];

function Cliente({ cl, grupos, personas, roles, recargar }) {
  const { error, correr } = useAccion();
  const [persona, setPersona] = useState('');
  const [rol, setRol] = useState('');
  const sinCliente = grupos.filter((g) => g.cliente_id !== cl.id);
  return (
    <Tarjeta titulo={cl.nombre} accion={cl.tipo === 'propio' ? <Estado tono="ok">Propio</Estado> : <Estado>{cl.estado}</Estado>}>
      <Selector etiqueta="Autonomía" value={cl.autonomia} opciones={AUTONOMIA}
        onChange={(e) => correr('a', async () => { await patch(`/api/clientes/${cl.id}`, { autonomia: e.target.value }); recargar(); })()} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium">Grupos y chats</p>
          {cl.chats.length ? <ul className="text-sm">{cl.chats.map((ch) => <li key={ch.id}>{ch.nombre || ch.id} {!ch.activo && <span className="text-xs text-stone-500">(inactivo)</span>}</li>)}</ul> : <p className="text-sm text-stone-500">Ninguno.</p>}
          {sinCliente.length > 0 && (
            <Selector className="mt-2" aria-label="Asignar un grupo" value="" opciones={[{ valor: '', texto: 'Asignar un grupo…' }, ...sinCliente.map((g) => ({ valor: g.id, texto: g.nombre || g.id }))]}
              onChange={(e) => e.target.value && correr('g', async () => { await patch(`/api/chats/${encodeURIComponent(e.target.value)}`, { cliente_id: cl.id }); recargar(); })()} />
          )}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Proyectos</p>
          {cl.proyectos.length ? <ul className="text-sm">{cl.proyectos.map((p) => <li key={p.id}>{p.nombre} {p.repo && <code className="text-xs">{p.repo}</code>}</li>)}</ul> : <p className="text-sm text-stone-500">Ninguno (se cargan en Conexiones).</p>}
        </div>
      </div>
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium">Roles en este cliente</p>
        <p className="mb-2 text-xs text-stone-500">Si alguien no tiene un rol acá, usa su rol general.</p>
        <ul className="text-sm">
          {cl.roles.map((r) => (
            <li key={r.persona_id} className="flex items-center justify-between gap-2 py-1">
              <span>{r.nombre ?? `+${r.telefono}`}: <span className="font-medium">{r.rol}</span></span>
              <Boton variante="fantasma" onClick={correr('q', async () => { await post(`/api/clientes/${cl.id}/roles`, { personaId: r.persona_id, rolId: null }); recargar(); })}>Quitar</Boton>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Selector aria-label="Persona" value={persona} onChange={(e) => setPersona(e.target.value)} opciones={[{ valor: '', texto: 'Persona…' }, ...personas.map((p) => ({ valor: p.id, texto: p.nombre ?? `+${p.telefono}` }))]} />
          <Selector aria-label="Rol" value={rol} onChange={(e) => setRol(e.target.value)} opciones={[{ valor: '', texto: 'Rol…' }, ...roles.map((r) => ({ valor: r.id, texto: r.nombre }))]} />
          <Boton variante="secundario" disabled={!persona || !rol} onClick={correr('r', async () => { await post(`/api/clientes/${cl.id}/roles`, { personaId: Number(persona), rolId: Number(rol) }); setPersona(''); setRol(''); recargar(); })}>Asignar</Boton>
        </div>
      </div>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

export default function Clientes() {
  const { datos, cargar } = useDatos('/api/clientes');
  const pers = useDatos('/api/personas');
  const [f, setF] = useState({ nombre: '', autonomia: 'consultar_lo_importante' });
  const { cargando, error, correr } = useAccion();
  return (
    <div className="grid grid-cols-1 gap-5 [&>*]:min-w-0">
      <Tarjeta titulo="Lista de clientes">
        <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Para trabajar como agencia: cada cliente tiene sus grupos, proyectos, memoria y nivel de autonomía. El agente también puede proponer uno cuando aparece un grupo nuevo.</p>
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={correr('c', async () => { await post('/api/clientes', f); setF({ nombre: '', autonomia: 'consultar_lo_importante' }); cargar(); })}>
          <Campo etiqueta="Nombre" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} required />
          <Selector etiqueta="Autonomía" value={f.autonomia} onChange={(e) => setF({ ...f, autonomia: e.target.value })} opciones={AUTONOMIA} />
          <Boton cargando={cargando === 'c'}>Agregar</Boton>
        </form>
        {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
      </Tarjeta>
      {datos?.clientes?.length ? datos.clientes.map((cl) => (
        <Cliente key={cl.id} cl={cl} grupos={datos.grupos} personas={pers.datos?.personas ?? []} roles={pers.datos?.roles ?? []} recargar={cargar} />
      )) : <Vacio>Cargando…</Vacio>}
    </div>
  );
}
