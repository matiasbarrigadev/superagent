// Primer arranque: código de setup → cuenta del Propietario → app de códigos → códigos de recuperación.
import { useEffect, useRef, useState } from 'react';
import { post } from '../api.js';
import { Aviso, Boton, Campo, Pantalla, Tarjeta } from '../components/ui.jsx';

const TODOS = ['Código', 'Cuenta', 'Verificación', 'Recuperación'];

function Pasos({ actual, conCodigo }) {
  const PASOS = conCodigo ? TODOS : TODOS.slice(1);
  if (!conCodigo) actual -= 1;
  return (
    <ol className="flex gap-2 text-xs" aria-label="Pasos del setup">
      {PASOS.map((p, i) => (
        <li key={p} className="flex flex-1 flex-col gap-1">
          <span className={`h-1 rounded-full ${i <= actual ? 'bg-emerald-600' : 'bg-stone-200 dark:bg-stone-800'}`} />
          <span className={i === actual ? 'font-medium' : 'text-stone-500 dark:text-stone-400'} aria-current={i === actual ? 'step' : undefined}>{p}</span>
        </li>
      ))}
    </ol>
  );
}

export default function Setup({ alTerminar, codigoRequerido = true, invitacion = null }) {
  // Sin código requerido (primeras horas de una instalación nueva, o una invitación) se arranca directo en la cuenta.
  if (invitacion) codigoRequerido = false;
  const [paso, setPaso] = useState(codigoRequerido ? 0 : 1);
  // El link de setup trae el código en ?setup=: se carga solo y se borra de la barra de direcciones.
  const [codigo, setCodigo] = useState(() => {
    const desdeLink = new URLSearchParams(window.location.search).get('setup') ?? '';
    if (desdeLink) window.history.replaceState(null, '', window.location.pathname);
    return desdeLink;
  });
  const [nombre, setNombre] = useState(invitacion?.nombre ?? '');
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [repetir, setRepetir] = useState('');
  const [inicio, setInicio] = useState(null);
  const [totp, setTotp] = useState('');
  const [recuperacion, setRecuperacion] = useState([]);
  const [guardados, setGuardados] = useState(false);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);

  const correr = (fn) => async (e) => {
    e?.preventDefault();
    setError(null);
    setCargando(true);
    try { await fn(); } catch (err) { setError(err.message); } finally { setCargando(false); }
  };

  const verificarCodigo = correr(async () => {
    await post('/api/setup/codigo', { codigo });
    setPaso(1);
  });

  // Entrando por el link de setup, el código se valida solo y se pasa directo a crear la cuenta.
  const autoValidado = useRef(false);
  useEffect(() => {
    if (codigoRequerido && codigo && !autoValidado.current) { autoValidado.current = true; verificarCodigo(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const crearCuenta = correr(async () => {
    if (contrasena !== repetir) throw new Error('Las contraseñas no coinciden.');
    setInicio(invitacion
      ? await post('/api/invitacion/iniciar', { invitacion: invitacion.token, email, contrasena })
      : await post('/api/setup/iniciar', { codigo, email, contrasena }));
    setPaso(2);
  });

  const confirmar = correr(async () => {
    const r = await post(invitacion ? '/api/invitacion/confirmar' : '/api/setup/confirmar', { token: inicio.token, totp, nombre });
    setRecuperacion(r.recuperacion);
    setPaso(3);
  });

  const descargar = () => {
    const texto = `Códigos de recuperación de Superagent (${email})\nCada uno sirve una sola vez, en lugar del código de la app.\n\n${recuperacion.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'superagent-codigos-recuperacion.txt' });
    a.click();
    URL.revokeObjectURL(url);
    setGuardados(true);
  };

  return (
    <Pantalla>
      <Pasos actual={paso} conCodigo={codigoRequerido} />

      {paso === 0 && (
        <Tarjeta titulo="Bienvenido">
          <form onSubmit={verificarCodigo} className="flex flex-col gap-4">
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Para crear la cuenta del Propietario, escribí el código de setup. Está en los logs del servidor
              (línea que empieza con <code className="font-mono">[setup]</code>) o en la variable <code className="font-mono">SUPERAGENT_SETUP_CODE</code>.
            </p>
            <Campo etiqueta="Código de setup" value={codigo} onChange={(e) => setCodigo(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" required autoFocus />
            <Aviso>{error}</Aviso>
            <Boton type="submit" cargando={cargando}>Continuar</Boton>
          </form>
        </Tarjeta>
      )}

      {paso === 1 && (
        <Tarjeta titulo={invitacion ? 'Tu cuenta en el panel' : 'Cuenta del Propietario'}>
          <form onSubmit={crearCuenta} className="flex flex-col gap-4">
            {invitacion && (
              <p className="text-sm text-stone-600 dark:text-stone-400">
                Te invitaron al panel del agente. Vas a ver: {invitacion.accesos.join(', ')}.
              </p>
            )}
            <Campo etiqueta="Tu nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="name" />
            <Campo etiqueta="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
            <Campo etiqueta="Contraseña" type="password" value={contrasena} onChange={(e) => setContrasena(e.target.value)} autoComplete="new-password" minLength={12} required ayuda="Al menos 12 caracteres." />
            <Campo etiqueta="Repetir contraseña" type="password" value={repetir} onChange={(e) => setRepetir(e.target.value)} autoComplete="new-password" required />
            <Aviso>{error}</Aviso>
            <Boton type="submit" cargando={cargando}>Continuar</Boton>
          </form>
        </Tarjeta>
      )}

      {paso === 2 && inicio && (
        <Tarjeta titulo="App de códigos">
          <form onSubmit={confirmar} className="flex flex-col gap-4">
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Escaneá este QR con una app de códigos (Google Authenticator, 1Password, Authy…) y escribí el código de 6 dígitos que muestra.
            </p>
            <img src={inicio.qr} alt="QR para la app de códigos" className="mx-auto size-60 rounded-lg bg-white p-2" />
            <details className="text-xs text-stone-500 dark:text-stone-400">
              <summary className="cursor-pointer">No puedo escanear</summary>
              <p className="mt-2">Cargá esta clave a mano:</p>
              <code className="mt-1 block break-all rounded bg-stone-100 p-2 font-mono dark:bg-stone-800">{inicio.secreto}</code>
            </details>
            <Campo etiqueta="Código de 6 dígitos" value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
            <Aviso>{error}</Aviso>
            <Boton type="submit" cargando={cargando}>Verificar</Boton>
          </form>
        </Tarjeta>
      )}

      {paso === 3 && (
        <Tarjeta titulo="Códigos de recuperación">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-stone-600 dark:text-stone-400">
              Si perdés el teléfono, cada uno de estos códigos te deja entrar una vez. Guardalos en un lugar seguro: no se vuelven a mostrar.
            </p>
            <ul className="grid grid-cols-2 gap-2 rounded-lg bg-stone-100 p-3 font-mono text-sm dark:bg-stone-800">
              {recuperacion.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <Boton variante="secundario" onClick={descargar}>Descargar .txt</Boton>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={guardados} onChange={(e) => setGuardados(e.target.checked)} className="size-4 accent-emerald-700" />
              Ya los guardé
            </label>
            <Boton onClick={alTerminar} disabled={!guardados}>Ir al panel</Boton>
          </div>
        </Tarjeta>
      )}
    </Pantalla>
  );
}
