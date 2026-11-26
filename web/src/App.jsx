import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Girando, Pantalla, Aviso, Boton } from './components/ui.jsx';
import Setup from './pages/Setup.jsx';
import Login from './pages/Login.jsx';
import Panel from './pages/Panel.jsx';
import { post } from './api.js';

// "#invitacion=<token>": link de invitación al panel. Se lee una vez y se borra de la barra de direcciones.
const tokenInvitacion = (() => {
  const m = /^#invitacion=([\w-]+)/.exec(window.location.hash);
  if (m) window.history.replaceState(null, '', window.location.pathname);
  return m?.[1] ?? null;
})();

export default function App() {
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState(null);
  const [invitacion, setInvitacion] = useState(tokenInvitacion ? { token: tokenInvitacion, cargando: true } : null);

  useEffect(() => {
    if (!invitacion?.cargando) return;
    post('/api/invitacion/ver', { invitacion: invitacion.token })
      .then((i) => setInvitacion({ token: invitacion.token, ...i }))
      .catch((e) => setInvitacion({ token: invitacion.token, error: e.message }));
  }, [invitacion]);

  const cargar = useCallback(async () => {
    try {
      setError(null);
      setEstado(await api('/api/estado'));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    cargar();
    const alVencer = () => setEstado((s) => (s?.modo === 'panel' ? { ...s, modo: 'login' } : s));
    window.addEventListener('sesion-vencida', alVencer);
    return () => window.removeEventListener('sesion-vencida', alVencer);
  }, [cargar]);

  if (error) {
    return (
      <Pantalla>
        <Aviso>{error}</Aviso>
        <Boton variante="secundario" onClick={cargar}>Reintentar</Boton>
      </Pantalla>
    );
  }
  if (!estado) {
    return <div className="flex min-h-dvh items-center justify-center text-stone-500"><Girando className="size-6" /></div>;
  }
  if (invitacion && estado.modo !== 'setup') {
    if (invitacion.cargando) return <div className="flex min-h-dvh items-center justify-center text-stone-500"><Girando className="size-6" /></div>;
    if (invitacion.error) {
      return (
        <Pantalla>
          <Aviso>{invitacion.error}</Aviso>
          <Boton variante="secundario" onClick={() => setInvitacion(null)}>Ir al panel</Boton>
        </Pantalla>
      );
    }
    return <Setup invitacion={invitacion} alTerminar={() => { setInvitacion(null); cargar(); }} />;
  }
  if (estado.modo === 'setup') return <Setup alTerminar={cargar} codigoRequerido={estado.codigoRequerido !== false} />;
  if (estado.modo === 'login') return <Login alEntrar={cargar} />;
  return <Panel usuario={estado.usuario} secciones={estado.secciones} version={estado.version} alSalir={cargar} />;
}
