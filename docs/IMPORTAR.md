# Traer el trabajo que ya venías haciendo

Si ya trabajabas con otro asistente (Claude Code en tu compu, otro bot, planillas, notas), Superagent lo puede
cargar. Hay dos caminos, y los dos terminan en lo mismo: un **paquete** que el agente ensaya, te muestra y aplica
recién cuando le decís que sí.

- **Conversando (lo normal).** Le pasás al agente por WhatsApp lo que tengas: un `CLAUDE.md`, notas, una lista de
  clientes, tu cron, el link a un repo. Él lo lee y lo ordena en el formato. En el camino:
  - clasifica la memoria;
  - une lo repetido y descarta lo vencido;
  - parte lo que sea muy largo;
  - te pregunta lo que no esté claro.

  Después te muestra un resumen y te pregunta si lo carga.
- **Con un paquete ya armado.** Si tenés el JSON (por ejemplo, el que exportó otra instalación), mandáselo al
  agente o usá la API del panel (`POST /api/paquetes/ensayar` y `POST /api/paquetes/importar`).

Para respaldar o mudar una instalación: pedile al agente "exportá la configuración" (`exportar_paquete`) o usá
`GET /api/paquetes/exportar`.

## Reglas

- **Nunca lleva secretos.** Los tokens, claves y contraseñas se nombran en `secretos` y se cargan después, de a uno,
  con el link que manda el agente (`pedir_variable`). Si el paquete trae algo que parece un secreto, se rechaza
  entero.
- **Primero el ensayo.** Antes de tocar nada, el agente te dice qué se crea, qué se actualiza, qué queda igual y
  qué hay que revisar. Lo aplica cuando confirmás, en otro mensaje.
- **Idempotente.** Importar dos veces el mismo paquete no duplica nada. Lo que ya está igual se omite, y lo que
  cambió se actualiza.
- **Referencias por nombre o teléfono**, nunca por ids internos:
  - los clientes y proyectos, por nombre;
  - las personas, por teléfono con código de país;
  - los grupos, por su JID (`…@g.us`).
- **Todo o nada.** La importación corre en una transacción: si algo falla, no queda nada a medias.

## Formato (versión 1)

```json
{
  "superagent": 1,
  "roles": [
    { "nombre": "Ventas", "descripcion": "Consulta ventas; solo cantidades.", "permisos": { "conversar": true, "herramientas_negocio": "lectura" } }
  ],
  "clientes": [
    { "nombre": "Estudio Ejemplo", "autonomia": "consultar_lo_importante" }
  ],
  "personas": [
    { "nombre": "Ana", "telefono": "5491100000001", "rol": "Colaborador",
      "clientes": [{ "cliente": "Estudio Ejemplo", "rol": "Ventas" }] }
  ],
  "proyectos": [
    { "nombre": "sitio", "cliente": "Estudio Ejemplo", "repo": "miorg/sitio", "rama_principal": "main",
      "dominios": ["ejemplo.com"],
      "procedimiento": { "respaldo": "echo sin respaldo", "ensayo": "npm test", "migraciones": "echo sin migraciones",
        "deploy": "vercel deploy --prod --yes", "verificacion": [{ "url": "https://ejemplo.com", "contiene": "Bienvenidos" }] } }
  ],
  "chats": [
    { "id": "120363000000000000@g.us", "nombre": "Equipo sitio", "cliente": "Estudio Ejemplo", "proyecto": "sitio",
      "activo": true, "solo_si_mencionan": true }
  ],
  "memoria": [
    { "alcance": "cuenta", "seccion": "Contexto", "contenido": "Somos un estudio de diseño de 4 personas.", "publica": true },
    { "alcance": "cliente", "de": "Estudio Ejemplo", "seccion": "Comportamiento", "contenido": "Prefieren audios cortos." },
    { "alcance": "contacto", "de": "5491100000001", "seccion": "Contexto", "contenido": "Ana coordina las entregas." }
  ],
  "lecciones": [
    { "regla": "No publicar los viernes después de las 18.", "porque": "No hay quién mire si algo se rompe." }
  ],
  "rutinas": [
    { "cuando": "0 9 * * 1-5", "zona_horaria": "America/Argentina/Buenos_Aires",
      "instruccion": "Mandale a Ana el resumen de pedidos de ayer.", "destino": "5491100000001", "pedida_por": "5491100000001" }
  ],
  "secretos": [{ "nombre": "VERCEL_TOKEN", "para": "Publicar el sitio" }],
  "conectores": [{ "nombre": "Supabase", "url": "https://mcp.supabase.com/mcp" }]
}
```

Todas las secciones son opcionales, salvo `"superagent": 1`.

| Sección | Se identifica por | Notas |
|---|---|---|
| `roles` | nombre | Los predefinidos (Propietario, Colaborador, Tercero) no se tocan. Los permisos son los del catálogo (`src/roles/permisos.mjs`); lo que falte queda en el nivel más bajo. El agente te explica la ficha de cada rol nuevo o cambiado antes de aplicar. |
| `clientes` | nombre | `autonomia`: `via_libre`, `consultar_lo_importante` (por defecto) o `consultar_todo`. |
| `personas` | teléfono (o `lid`) | `rol`: el rol general. `clientes`: el rol en cada cliente. Un Propietario que suma un Propietario lo deja verificado. |
| `proyectos` | nombre | `repo` va como `dueño/nombre`. El `procedimiento` se valida igual que en el panel: los cuatro pasos y una verificación contra los dominios del proyecto. |
| `chats` | `id` (JID) o `telefono` | Grupos con `…@g.us`. `solo_si_mencionan`: el agente responde solo si lo nombran. |
| `memoria` | alcance + a quién + sección + texto | Secciones: Contexto, Comportamiento, Alcance, Decisiones, Pendientes, Historial. `de`: el cliente o proyecto (por nombre) o el contacto (por teléfono). Más de 4000 caracteres se parte en varias notas. `publica`: lo que puede saber cualquiera. |
| `lecciones` | texto de la regla | Quedan activas. |
| `rutinas` | instrucción + cron + destino | `cuando`: cron de 5 campos. `destino`: teléfono, JID o `"propietario"`. `pedida_por`: con qué persona (y sus permisos) corre; si no está, corre con los tuyos. Quedan aprobadas y con su próxima ejecución calculada. |
| `numeros` | nombre de la sesión | `{ nombre, etiqueta, politica }`: la política de cada número de WhatsApp (ver [NUMEROS.md](NUMEROS.md)). Sin credenciales: los números nuevos quedan para vincular en el panel. En `chats`, `responde_por` dice qué número responde en un chat compartido. |
| `secretos` | nombre | Solo nombres en mayúsculas. Los que falten se piden al final. |
| `conectores` | nombre o URL | Los que no estén conectados se ofrecen al final (OAuth por link). |

## Casos

- **Venías con Claude Code en tu compu:**
  - pasale al agente tu `CLAUDE.md` y las memorias, que van a `memoria` de la cuenta o de cada cliente;
  - los repos con los que trabajás van a `proyectos`;
  - lo que tenías en `cron` o en tareas programadas va a `rutinas`;
  - las variables de entorno van a `secretos`, solo los nombres.
- **Venías con planillas:** una lista de clientes y contactos se convierte en `clientes` y `personas`. El agente te
  pregunta qué rol le da a cada uno.
- **Mudar de instalación:** exportá en la vieja, importá en la nueva y cargá los secretos y conectores que te pida.
  WhatsApp se vincula de nuevo con el QR.
