// Recuperación de acceso (siempre con dos factores): contraseña con TOTP + código de recuperación, contraseña con
// código por WhatsApp + TOTP, o TOTP nuevo con contraseña + código de recuperación.
import { useState } from 'react';
import { post } from '../api.js';
import { Aviso, Boton, Campo, Tarjeta } from '../components/ui.jsx';

const OPCIONES = [
  { id: 'contrasena', texto: 'Olvidé la contraseña (tengo la app de códigos y un código de recuperación)' },
  { id: 'whatsapp', texto: 'Olvidé la contraseña (tengo la app de códigos y mi WhatsApp)' },
  { id: 'totp', texto: 'Perdí el teléfono con la app de códigos (sé la contraseña y tengo un código de recuperación)' },
];

export default function Recuperar({ alVolver }) {
  const [opcion, setOpcion] = useState(null);
  const [f, setF] = useState({ email: '', totp: '', recuperacion: '', nueva: '', contrasena: '', codigoWhatsapp: '' });
  const [paso, setPaso] = useState(0);
  const [qr, setQr] = useState(null);
  const [codigos, setCodigos] = useState(null);
  const [ok, setOk] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const accion = (fn) => async (e) => {
    e.preventDefault();
    setError(null); setCargando(true);
    try { await fn(); } catch (err) { setError(err.message); } finally { setCargando(false); }
  };

  if (!opcion) {
    return (
      <Tarjeta titulo="Recuperar el acceso">
        <div className="flex flex-col gap-2">
          {OPCIONES.map((o) => <Boton key={o.id} variante="secundario" className="justify-start text-left" onClick={() => setOpcion(o.id)}>{o.texto}</Boton>)}
        </div>
        <p className="mt-4 text-xs text-stone-500 dark:text-stone-400">Si perdiste todo, quien administra el servidor puede poner la variable SUPERAGENT_RESET_OWNER=1: el panel vuelve a modo setup y se conservan las personas, los roles, la memoria y los repos.</p>
        <button type="button" className="mt-4 text-sm underline" onClick={alVolver}>Volver al login</button>
      </Tarjeta>
    );
  }

  return (
    <Tarjeta titulo={OPCIONES.find((o) => o.id === opcion).texto}>
      {ok ? (
        <div className="flex flex-col gap-3">
          <Aviso tipo="ok">{ok}</Aviso>
          {codigos && <ul className="grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-3 font-mono text-sm dark:bg-stone-800">{codigos.map((c) => <li key={c}>{c}</li>)}</ul>}
          <Boton onClick={alVolver}>Ir al login</Boton>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={accion(async () => {
          if (opcion === 'contrasena') {
            await post('/api/recuperar/contrasena', f);
            setOk('Listo: ya podés entrar con la contraseña nueva. Se cerraron todas las sesiones.');
          } else if (opcion === 'whatsapp' && paso === 0) {
            await post('/api/recuperar/whatsapp/pedir', { email: f.email });
            setPaso(1);
          } else if (opcion === 'whatsapp') {
            await post('/api/recuperar/whatsapp/confirmar', f);
            setOk('Listo: ya podés entrar con la contraseña nueva. Se cerraron todas las sesiones.');
          } else if (paso === 0) {
            const r = await post('/api/recuperar/totp/iniciar', f);
            setQr(r); setPaso(1);
          } else {
            const r = await post('/api/recuperar/totp/confirmar', { token: qr.token, totp: f.totp });
            setCodigos(r.recuperacion);
            setOk('Listo: la app de códigos nueva quedó configurada. Guardá estos códigos de recuperación nuevos (los anteriores ya no sirven).');
          }
        })}>
          <Campo etiqueta="Email" type="email" value={f.email} onChange={set('email')} required disabled={paso > 0} />
          {opcion === 'contrasena' && (
            <>
              <Campo etiqueta="Código de la app" inputMode="numeric" value={f.totp} onChange={set('totp')} required />
              <Campo etiqueta="Código de recuperación" value={f.recuperacion} onChange={set('recuperacion')} required />
              <Campo etiqueta="Contraseña nueva (12 caracteres o más)" type="password" autoComplete="new-password" value={f.nueva} onChange={set('nueva')} required />
            </>
          )}
          {opcion === 'whatsapp' && paso === 1 && (
            <>
              <p className="text-sm text-stone-600 dark:text-stone-400">Si el email es correcto y tu número está verificado, te llegó un código por WhatsApp.</p>
              <Campo etiqueta="Código de WhatsApp" inputMode="numeric" value={f.codigoWhatsapp} onChange={set('codigoWhatsapp')} required />
              <Campo etiqueta="Código de la app" inputMode="numeric" value={f.totp} onChange={set('totp')} required />
              <Campo etiqueta="Contraseña nueva (12 caracteres o más)" type="password" autoComplete="new-password" value={f.nueva} onChange={set('nueva')} required />
            </>
          )}
          {opcion === 'totp' && paso === 0 && (
            <>
              <Campo etiqueta="Contraseña" type="password" autoComplete="current-password" value={f.contrasena} onChange={set('contrasena')} required />
              <Campo etiqueta="Código de recuperación" value={f.recuperacion} onChange={set('recuperacion')} required />
            </>
          )}
          {opcion === 'totp' && paso === 1 && qr && (
            <>
              <p className="text-sm">Escaneá este código con la app nueva y escribí el código que muestra.</p>
              <img src={qr.qr} alt="Código QR para la app de códigos" className="mx-auto size-48 rounded-lg bg-white p-2" />
              <p className="break-all text-center font-mono text-xs text-stone-500">{qr.secreto}</p>
              <Campo etiqueta="Código de la app nueva" inputMode="numeric" value={f.totp} onChange={set('totp')} required />
            </>
          )}
          <Aviso>{error}</Aviso>
          <Boton type="submit" cargando={cargando}>{opcion === 'whatsapp' && paso === 0 ? 'Mandarme el código' : 'Continuar'}</Boton>
          <button type="button" className="self-start text-sm underline" onClick={alVolver}>Volver al login</button>
        </form>
      )}
    </Tarjeta>
  );
}
