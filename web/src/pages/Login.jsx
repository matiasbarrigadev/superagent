import { useState } from 'react';
import { post } from '../api.js';
import { Aviso, Boton, Campo, Pantalla, Tarjeta } from '../components/ui.jsx';
import Recuperar from './Recuperar.jsx';

export default function Login({ alEntrar }) {
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [codigo, setCodigo] = useState('');
  const [usarRecuperacion, setUsarRecuperacion] = useState(false);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [recuperando, setRecuperando] = useState(false);

  const entrar = async (e) => {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      await post('/api/auth/login', { email, contrasena, codigo });
      alEntrar();
    } catch (err) {
      setError(err.message);
    } finally {
      setCargando(false);
    }
  };

  if (recuperando) return <Pantalla><Recuperar alVolver={() => setRecuperando(false)} /></Pantalla>;

  return (
    <Pantalla>
      <Tarjeta titulo="Entrar al panel">
        <form onSubmit={entrar} className="flex flex-col gap-4">
          <Campo etiqueta="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
          <Campo etiqueta="Contraseña" type="password" value={contrasena} onChange={(e) => setContrasena(e.target.value)} autoComplete="current-password" required />
          {usarRecuperacion ? (
            <Campo key="rec" etiqueta="Código de recuperación" value={codigo} onChange={(e) => setCodigo(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX" required />
          ) : (
            <Campo key="totp" etiqueta="Código de la app" value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
          )}
          <button type="button" className="self-start text-xs text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
            onClick={() => { setUsarRecuperacion(!usarRecuperacion); setCodigo(''); }}>
            {usarRecuperacion ? 'Usar el código de la app' : 'No tengo el teléfono: usar un código de recuperación'}
          </button>
          <Aviso>{error}</Aviso>
          <Boton type="submit" cargando={cargando}>Entrar</Boton>
          <button type="button" className="self-center text-xs text-stone-500 underline-offset-2 hover:underline dark:text-stone-400" onClick={() => setRecuperando(true)}>¿Perdiste el acceso?</button>
        </form>
      </Tarjeta>
    </Pantalla>
  );
}
