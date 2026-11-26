# WhatsApp a fondo

Superagent habla por WhatsApp a través de [WAHA](https://waha.devlike.pro) con el motor **GOWS**: sin navegador, por
WebSocket, versión `gows-2026.10.1`. El agente usa WhatsApp como una persona que lo conoce bien, siempre dentro de
lo que permite su rol y la política de cada número.

## Lo que hace el agente en una conversación

| Qué | Herramienta | Quién la tiene |
|---|---|---|
| Responder, citando un mensaje (`citar: M-n`) | `responder` | Todos |
| Reaccionar con un emoji (o quitar la reacción) | `reaccionar` | Todos, también los terceros |
| Mencionar en grupos (`@` + número) | `responder` | Todos |
| Foto común, video, sticker o documento | `enviar_archivo` (`como`) | Con permiso de archivos |
| Nota de voz | `enviar_audio` | Si está prendido en Agente |
| Ubicación (pin en el mapa) | `enviar_ubicacion` | Equipo y Propietario |
| Tarjeta de contacto (vCard) | `enviar_contacto` | Equipo y Propietario |
| Encuesta (y enterarse de cada voto) | `enviar_encuesta` | Equipo y Propietario |
| Corregir lo que mandó (unos 15 minutos) | `editar_mensaje` | Equipo y Propietario |
| Borrar lo que mandó, para todos | `borrar_mensaje` | Equipo y Propietario |

### Las marcas `M-n` y `S-n`

- Cada mensaje que le llega al agente trae su marca `M-n` (por ejemplo `[10:32 · M-1542] Ana: …`). Con ella cita o
  reacciona.
- Cada cosa que manda le devuelve `S-n`, que usa para editarla o borrarla.

El gateway traduce esas marcas al id de WhatsApp y **solo acepta las de la conversación en curso**: el agente no
puede reaccionar, citar ni borrar en otro chat. Editar y borrar valen solo para lo que mandó él.

### Fotos: ¿foto o documento?

| Cómo llega | Cuándo |
|---|---|
| **Foto** (por defecto, JPG o PNG) | Se ve en el chat, comprimida como cualquier foto de WhatsApp |
| **Documento** (`como: "documento"`) | Llega como archivo, en calidad original: planos, comprobantes, fotos para imprimir |
| **Video** | MP4, se ve en el chat |
| **Sticker** | Tiene que ser WebP |

## Lo que llega

| Evento | Qué hace el gateway |
|---|---|
| Mensajes y adjuntos | Los guarda, descarga el adjunto y saca su texto (transcripción, OCR) |
| Reacciones | Las guarda y se ven en la bandeja |
| Mensajes editados | Actualiza el texto y lo marca como editado |
| Mensajes borrados | Deja de mostrar el contenido ("Se eliminó este mensaje") |
| Votos en encuestas del agente | Le llegan al agente en esa charla: `[voto en tu encuesta] Ana eligió: Martes` |

Las instalaciones que ya existían reciben estos eventos solas: al arrancar, el gateway actualiza el webhook de cada
número una vez (WAHA reinicia la sesión, sin desvincular).

## Con el Propietario: toda la API

Con vos, el agente tiene además la herramienta `whatsapp`: acceso directo a la API de WAHA para todo lo demás.

- **Grupos**: crear, nombre, descripción, foto, participantes, admins, invitaciones, pedidos para entrar, quién
  puede escribir o editar la info.
- **Contactos**: foto de perfil, si un número tiene WhatsApp.
- **Chats**: mensajes anteriores, marcar como leído o no leído.
- **Estados/historias**: texto, foto, video y voz.
- **Etiquetas**: crear y asignar a chats.
- **Canales**: crear, buscar y seguir.
- **Presencia**: en línea o escribiendo.
- **Llamadas**: rechazarlas.
- **Mensajes de evento de calendario.**

Lo que dejaría al agente sin número (vincular, desvincular, cambiar el webhook) solo se hace en el panel.

## La bandeja del panel

**Panel → Bandeja** muestra todas las conversaciones como en WhatsApp:

- **Fotos y stickers** a la vista, con un visor a pantalla completa.
- **Audios y videos** con su reproductor, y la transcripción desplegable.
- **PDF** con vista previa dentro del panel y botón para descargar.
- **Cualquier otro archivo** (zip, Excel, Word…) como tarjeta con nombre, peso y **Descargar**.
- Reacciones, "editado" y "Se eliminó este mensaje".

Seguridad de los adjuntos:

- Solo se muestran en la página los tipos que el navegador no puede ejecutar: fotos sin SVG, audio, video y PDF.
  Todo lo demás, incluido un SVG o un HTML, se descarga y nunca corre dentro del panel.
- Cada archivo sale con una política de contenido que no deja ejecutar scripts.
- Los archivos piden sesión y no quedan guardados en la caché del navegador.
