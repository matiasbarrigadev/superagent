# Superagent

Un agente que vive en WhatsApp y trabaja con **Claude Code**. Es autoalojado: lo levantás en Railway o en tu máquina
con Docker, vinculás un número de WhatsApp, conectás tu cuenta de Claude y listo. Desde ahí lo configurás hablando
con él por WhatsApp.

- **Con vos (el Propietario)** es Claude Code completo: terminal, archivos, logins de CLIs (`gh`, `vercel`,
  `supabase`…), MCPs, procesos en segundo plano, acceso total a WhatsApp. La aprobación está en el diálogo.
- **Con los demás** aplica roles que definís con él en la conversación: qué puede hacer cada persona, qué grupos
  escucha, con quién puede iniciar una conversación. Lo que pide un rol inferior te lo consulta a vos por WhatsApp.
- **Usa WhatsApp a fondo**: cita mensajes, reacciona con emojis, manda fotos como foto o como documento, videos,
  stickers, ubicaciones, contactos y encuestas (y se entera de cada voto), corrige o borra lo que mandó, y menciona
  en grupos. Con vos tiene además toda la API de WhatsApp: grupos, estados, etiquetas, canales y más. Ver
  [docs/WHATSAPP.md](docs/WHATSAPP.md).
- **Bandeja en el panel**: todas las conversaciones como en WhatsApp, con fotos, audios, videos y PDF a la vista,
  reacciones, mensajes editados o borrados, y cualquier otro archivo para descargar.
- **Rutinas que se editan conversando** (horario, destino, con qué permisos corren) y conectores de **solo
  lectura** que no piden aprobación por cada consulta. Ver [docs/RUTINAS.md](docs/RUTINAS.md).
- **Cuida su disco**: limpia solo lo que ya cumplió su función (trabajos terminados, adjuntos viejos, temporales),
  avisa al 80 % y el agente ordena su propio espacio con criterio. Ver [docs/DISCO.md](docs/DISCO.md).
- **Escucha todo** lo que llega a WhatsApp y se despierta según quién escribe: directos, grupos activos (decide por
  contexto si le hablan a él), tareas en segundo plano que terminan, rutinas y webhooks.
- **Cuida el consumo**: ve el uso de tu plan de Claude en cada iteración, compacta el contexto y avisa a quien
  corresponda cuando queda poco.
- **Varios motores**: tu suscripción de Claude, Claude con clave de API, Codex (con tu ChatGPT), Gemini (con capa
  gratis) u OpenCode con DeepSeek, MiniMax, Kimi, Qwen u OpenRouter. Elegís uno por tipo de conversación (por
  ejemplo, Claude para vos y DeepSeek para atender clientes), con respaldo automático si uno se queda sin plan y
  topes de gasto. Se configura conversando con el agente o en el panel. Ver [docs/MOTORES.md](docs/MOTORES.md).

> 🤖 **¿Sos un agente (Claude Code u otro) y te pidieron instalar esto?** Leé [AGENTS.md](AGENTS.md) y seguí la
> skill [`.claude/skills/instalar-superagent`](.claude/skills/instalar-superagent/SKILL.md).

## Instalar

Necesitás:

- Una **suscripción de Claude** (Pro o Max) para conectar Claude Code, o una clave de API de Anthropic
  (`ANTHROPIC_API_KEY`, por uso).
- Un **número de WhatsApp para el agente**, de preferencia dedicado, con el teléfono a mano para escanear el QR.
- Tu **WhatsApp personal**, para que el agente te reconozca como Propietario.

### Con la imagen publicada (recomendado)

Superagent se publica como imagen de Docker pública, para amd64 y arm64:

```
ghcr.io/matiasbarrigadev/superagent:latest    # la última versión estable
ghcr.io/matiasbarrigadev/superagent:0.3.0     # una versión fija (lo más seguro)
```

Conviene instalar desde la imagen y no desde el repo:

- **Elegís cuándo actualizar.** Tu instalación sigue en la versión que fijaste aunque el repo cambie. Cuando sale
  una nueva, la subís cuando quieras y, si algo no te gusta, volvés a la anterior cambiando el tag.
- **Sale lo probado.** Cada versión pasa los tests antes de publicarse.
- **Arranca rápido.** No compila nada: se baja y arranca.

Las versiones están en [Releases](https://github.com/matiasbarrigadev/superagent/releases). Fijar una versión
(`0.3.0`) es más seguro que `latest`, que cambia sola cuando sale una nueva. `:edge` es lo último de `main`, sin
versión: solo para probar.

### Opción A: Railway (recomendada para tenerlo 24/7)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/superagente-en-whatsapp)

1. Tocá **Deploy on Railway**. El template crea los dos servicios: `waha` (WhatsApp) y `superagent` (imagen
   `ghcr.io/matiasbarrigadev/superagent`), con sus volúmenes, el dominio y los secretos. La receta, por si lo querés
   armar a mano, está en [railway/TEMPLATE.md](railway/TEMPLATE.md).
2. Cuando `superagent` esté en verde, abrí su dominio público y seguí [Primeros pasos](#primeros-pasos).

Plan recomendado: Hobby o superior, con al menos 2 GB de RAM para `superagent`. **Actualizar:** en el servicio
`superagent` → *Settings → Source*, cambiá el tag de la imagen a la versión nueva (o, con `latest`, tocá
*Redeploy*). Tus datos quedan en los volúmenes.

### Opción B: Docker en tu máquina o en un servidor

Requisitos: Docker con Compose v2, unos 8 GB libres de disco y 4 GB de RAM. No hace falta clonar el repo: alcanza
con el `docker-compose.yml`.

```sh
mkdir superagent && cd superagent
curl -fsSLO https://raw.githubusercontent.com/matiasbarrigadev/superagent/main/docker-compose.yml
echo "SUPERAGENT_VERSION=0.3.0" > .env           # la versión que querés usar
docker compose up -d
docker compose logs superagent | grep setup       # link y código de setup
```

Abrí <http://localhost:8080>. No hace falta escribir ninguna variable más: los secretos se generan en el primer
arranque. Para cambiar algo (zona horaria, puerto, URL pública), mirá [`.env.ejemplo`](.env.ejemplo).

**Actualizar:** cambiá `SUPERAGENT_VERSION` en `.env` y corré `docker compose pull && docker compose up -d`. Los
datos quedan en los volúmenes de Docker.

**HTTPS con dominio propio** (el dominio tiene que apuntar al servidor, puertos 80 y 443 abiertos):

```sh
SUPERAGENT_DOMINIO=agente.ejemplo.com SUPERAGENT_PUBLIC_URL=https://agente.ejemplo.com \
  docker compose --profile https up -d
```

En local sin dominio funciona todo, salvo los links que el agente manda por WhatsApp (OAuth de servicios, pedidos
de variables): apuntan a `localhost`, así que solo abren en la misma máquina. Para usarlos desde el teléfono,
poné una URL pública (Caddy con dominio, o un túnel como Cloudflare Tunnel) en `SUPERAGENT_PUBLIC_URL`.

## Primeros pasos

1. **Crear el Propietario**: en el panel, nombre, email, contraseña y app de códigos (TOTP). Guardá los 10 códigos
   de recuperación. En las primeras 2 horas no pide el código de setup; después, sí (está en los logs, o en Railway
   en la variable `SUPERAGENT_SETUP_LINK`).
2. **Conectar Claude**: *Inicio → Claude → Conectar*. Abre `claude setup-token` en una terminal del panel; autorizá
   con tu cuenta y pegá el código. Queda guardado cifrado.
3. **Tu número**: *Inicio → Tu número de WhatsApp*. Cargá tu WhatsApp personal: así el agente sabe quién sos.
   El panel te muestra un código de 6 dígitos.
4. **Vincular WhatsApp**: *Inicio → WhatsApp*. Escaneá el QR con el teléfono del agente (Dispositivos vinculados),
   o pedí un código de vinculación por número. Apenas queda vinculado, el agente te escribe: respondele con el
   código y arranca la configuración por WhatsApp (su personalidad, en qué te va a ayudar y cómo trata a los
   contactos). Hasta que lo decidas ahí, no le responde a nadie que no esté dado de alta.

Desde ahí todo es conversación. Algunos ejemplos:

- "Conectate a GitHub, Vercel y Supabase" → te manda los links de login y queda conectado en su entorno.
- "Activá el grupo del equipo y respondé solo cuando te hablen" / "Te dicen Sandrito también".
- "Juan es colaborador: puede pedirte cambios en el repo X, pero publicar me lo consultás".
- "Avisame a mí cuando quede menos del 20 % del plan".
- "Pausá todo" corta todo al instante.

El panel queda para mirar: bandeja de chats, personas y roles, bitácora de decisiones, conexiones y consumo.
Para sumar a alguien al panel (por ejemplo, un cliente que tiene que vincular el WhatsApp), *Personas → Acceso al
panel* crea un link de invitación de un solo uso con las secciones que elijas; o pedíselo al agente por WhatsApp. Si no
tenés el link a mano, pedíselo al agente por WhatsApp ("pasame el panel"). Él conoce su URL pública
(`SUPERAGENT_PUBLIC_URL` o el dominio de Railway), y además aparece en los logs al arrancar (`panel: <url>`).

## Cómo funciona

```
WhatsApp ⇄ WAHA (GOWS) ──eventos firmados──▶ gateway (Node 24 + SQLite) ──▶ claude -p (Claude Code oficial)
                                                 │  panel React          ▲  MCP del gateway (127.0.0.1)
                                                 └──── roles y política ─┘  herramientas: responder, chats,
                                                                            whatsapp, decidir, consumo…
```

- **WAHA** mantiene la sesión de WhatsApp y le manda cada evento (HMAC) al gateway. No se expone a internet.
- **El gateway** guarda los mensajes, resuelve quién escribe (teléfono o LID, un solo chat por persona), espera un
  silencio corto y lanza una corrida de `claude -p`. Decide herramientas, modelo, instrucciones y memoria según el
  rol de quien escribe. Lo que el agente dice solo sale por su herramienta `responder`.
- **Aislamiento**: cada conversación corre con su propio usuario de Linux y su carpeta 0700. El entorno del
  Propietario es persistente (logins, repos, procesos en segundo plano); los demás no lo ven.
- **Despertar**: una tarea en segundo plano que termina deja un archivo en `~/avisos/` y el agente se despierta
  solo para contarte.
- **Bitácora**: todo lo que se aprueba o se rechaza queda anotado, sin botones de confirmación.
- **Adjuntos**: audios (whisper.cpp), PDFs (poppler + OCR), imágenes, video y Office pasan a texto.
- **Navegador**: MCP de Playwright con Chromium sin interfaz.
- **Conectores**: cualquier servicio con login: por CLI en el entorno del agente o por MCP remoto con OAuth
  (registro dinámico + PKCE), con el token guardado cifrado en el gateway.

Más detalle para desarrollar: [AGENTS.md](AGENTS.md) y la skill
[`.claude/skills/desarrollar-superagent`](.claude/skills/desarrollar-superagent/SKILL.md).

## Varios números de WhatsApp

Además del número principal, podés sumar otros: el de la empresa, otro de ventas, o tu WhatsApp personal para que
el agente solo lea los chats de clientes. Cada uno se vincula en el panel (*Inicio → Sumar otro número*). Qué hace
lo definís conversando con el agente:

- responde, solo lee o solo manda avisos;
- qué chats entran;
- si se guardan los mensajes y por cuánto tiempo;
- si puede escribir primero;
- qué conectores usa.

Un número nuevo arranca sin hacer nada hasta que lo configures. Lo que es autoridad o privacidad lo hace cumplir
el gateway: un número en solo lectura no envía nada, aunque el agente se equivoque, y lo que no entra no se guarda.
El resto lo razona el agente con lo que le pediste. Por ejemplo, si un grupo se ve desde dos números, se da cuenta
y te pregunta cuál responde. Más en [docs/NUMEROS.md](docs/NUMEROS.md).

## Traer lo que ya venías haciendo

¿Ya trabajabas con otro asistente, planillas o notas? Decíselo al agente por WhatsApp y te ayuda a traer todo:
clientes, proyectos, personas, grupos, memoria, reglas y tareas programadas.

1. Lo ordena en un paquete.
2. Te muestra qué va a cargar.
3. Lo aplica cuando le decís que sí.
4. Al final te pide de a uno los secretos y las conexiones que falten.

También sirve para respaldar o mudar una instalación. El formato y los casos están en
[docs/IMPORTAR.md](docs/IMPORTAR.md).

## Roles: qué es un límite y qué es una instrucción

Cada rol tiene dos capas, y el agente te las explica antes de guardar cualquier cambio:

- **Límites reales** (los hace cumplir el gateway, el modelo no los puede saltar):
  - qué permisos tiene el rol;
  - qué conectores tiene habilitados;
  - qué herramientas de cada conector puede usar.

  Las herramientas que escriben pasan siempre por la aprobación de un Propietario si quien las usa no es Propietario.
- **Instrucciones** (las respeta el agente, pero no son un bloqueo): lo que dice la descripción del rol, como "solo
  cantidades, sin montos" o "solo su ciudad". Si el rol tiene un conector de base de datos, técnicamente alcanza
  todo lo que ese conector alcanza.

Cuando le pedís al agente crear o cambiar un rol, o habilitarle un conector, te muestra una ficha con esas dos
capas. El cambio se guarda recién cuando lo confirmás en un mensaje aparte.

## Seguridad y riesgos conocidos

- Cada instalación usa la suscripción de Claude de su Propietario, con el binario oficial de Claude Code sin
  modificar. Revisá los términos de Anthropic para tu caso de uso.
- **El modo completo es poderoso a propósito.** Solo corre en el chat directo del Propietario (o el panel), nunca
  por webhooks de entrada. Si una página o un archivo le inyecta instrucciones, el agente tiene terminal; por eso
  escribirle a un número desconocido siempre necesita tu "sí" en un mensaje nuevo, y los demás roles no tienen
  Bash salvo que se lo des.
- La salida de red de las corridas no está filtrada. Dale terminal solo a gente de confianza y rotá el token de
  Claude (*Inicio → Claude → Desconectar*) si sospechás una fuga.
- Recuperación de acceso: contraseña + TOTP, códigos de recuperación, código por WhatsApp, y
  `SUPERAGENT_RESET_OWNER=<un valor nuevo>` como último recurso (vuelve a modo setup y conserva todo lo demás).

## Desarrollo

```sh
npm install && npm --prefix web install
npm test                 # tests del gateway (node --test)
npm run web:build        # compila el panel
npm run dev              # gateway en :8080 (necesita WAHA)
npm run web:dev          # panel con recarga en :5173
```

Necesita Node 24.7 o superior. Ver [AGENTS.md](AGENTS.md) para la estructura del código y las convenciones.

Para probar tus cambios en Docker, construí la imagen desde el repo:

```sh
docker compose -f docker-compose.yml -f docker-compose.desarrollo.yml up -d --build
```

Cada tag `vX.Y.Z` publica la imagen `ghcr.io/matiasbarrigadev/superagent:X.Y.Z` (y `:latest`) con
[`.github/workflows/imagen.yml`](.github/workflows/imagen.yml), después de correr los tests. Cada push a `main`
publica `:edge`.

## Licencia

[Apache-2.0](LICENSE).
