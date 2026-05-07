# CRM — Martín Vieira Taroco

CRM para gestión de calls de diagnóstico con integración a Meta CAPI y webhook de Calendly.

## Setup local

```bash
node server.js
# Abre http://localhost:3000
```

## Deploy en Railway (gratis)

1. Subí este repo a GitHub
2. Entrá a railway.app → New Project → Deploy from GitHub
3. Seleccioná el repo → Railway detecta Node.js automáticamente
4. En Settings → Variables → agregá `PORT=3000` si es necesario
5. Railway te da una URL pública tipo `crm-martin.up.railway.app`

## Configurar webhook en Calendly

1. Entrá a Calendly → Integraciones → Webhooks
2. Nueva suscripción → URL: `https://TU-URL.up.railway.app/api/webhook/calendly`
3. Eventos: `invitee.created`
4. Guardar

## Endpoints

- `GET /api/contacts` — listar contactos
- `POST /api/contacts` — agregar contacto manual
- `PATCH /api/contacts/:id` — actualizar contacto
- `DELETE /api/contacts/:id` — eliminar contacto
- `POST /api/webhook/calendly` — recibir webhook de Calendly
- `POST /api/simulate/calendly` — simular agendamiento (demo)
- `POST /api/meta/send` — enviar evento a Meta CAPI
