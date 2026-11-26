# Payloads de webhook de WAHA (GOWS)

Armados con el formato documentado de WAHA para el motor GOWS (`gows-2026.10.1`): sobre `event`, `session`,
`me`, `engine` y `payload` con `id`, `from`, `fromMe`, `participant`, `body`, `hasMedia`, `media`, `replyTo` y
`_data` (`Info` y `Message` crudos de whatsmeow). Los números son de mentira.

Para reemplazarlos por capturas reales en el piloto: arrancar el gateway con `SUPERAGENT_GRABAR_WEBHOOKS=1`.
Cada evento queda en `/data/grabaciones/webhooks.jsonl`; copiar los que sirvan acá, cambiando los números.
