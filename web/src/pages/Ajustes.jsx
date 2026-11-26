import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Aviso, Boton, Tarjeta } from '../components/ui.jsx';

const fecha = (ms) => new Date(ms).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

function navegador(ua = '') {
  const n = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const s = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return s ? `${n} en ${s}` : n;
}

export default function Ajustes({ usuario, version }) {
  const [datos, setDatos] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [cargando, setCargando] = useState(false);

  const cargar = () => api('/api/auth/sesiones').then(setDatos).catch((e) => setAviso({ tipo: 'error', texto: e.message }));
  useEffect(() => { cargar(); }, []);

  const cerrarOtras = async () => {
    setCargando(true);
    try {
      const r = await post('/api/auth/cerrar-otras');
      setAviso({ tipo: 'ok', texto: r.cerradas ? `Se cerraron ${r.cerradas} sesiones.` : 'No había otras sesiones abiertas.' });
      await cargar();
    } catch (e) {
      setAviso({ tipo: 'error', texto: e.message });
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 [&>*]:min-w-0">
      <Tarjeta titulo="Tu cuenta">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-stone-500 dark:text-stone-400">Email</dt><dd className="break-all">{usuario?.email}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Rol</dt><dd>{usuario?.rol}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Códigos de recuperación</dt>
          <dd>{datos ? `${datos.codigosRestantes} sin usar` : '…'}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Versión</dt><dd>{version}</dd>
        </dl>
      </Tarjeta>

      <Tarjeta titulo="Sesiones abiertas" accion={<Boton variante="secundario" cargando={cargando} onClick={cerrarOtras}>Cerrar las demás</Boton>}>
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {datos?.sesiones.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{navegador(s.userAgent)}{s.actual && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">esta</span>}</span>
              <span className="text-stone-500 dark:text-stone-400">{fecha(s.creada)}{s.ip ? ` · ${s.ip}` : ''}</span>
            </li>
          ))}
        </ul>
        {aviso && <div className="mt-3"><Aviso tipo={aviso.tipo}>{aviso.texto}</Aviso></div>}
      </Tarjeta>
    </div>
  );
}
