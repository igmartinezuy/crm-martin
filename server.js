const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'contacts.json');

// ─── DB helpers ───────────────────────────────────────────
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch { return []; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ─── ROUTER ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-calendly-webhook-signature');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static files (frontend) ──
  if (method === 'GET' && !url.pathname.startsWith('/api')) {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, 'public', filePath);
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Body parser ──
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { body = body ? JSON.parse(body) : {}; } catch { body = {}; }
    route(req, res, url, method, body);
  });
});

function route(req, res, url, method, body) {
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── GET /api/contacts ──
  if (method === 'GET' && url.pathname === '/api/contacts') {
    return json(readDB());
  }

  // ── POST /api/contacts ── (manual add)
  if (method === 'POST' && url.pathname === '/api/contacts') {
    const contacts = readDB();
    const contact = {
      id: uid(),
      createdAt: new Date().toISOString(),
      metaSent: {},
      source: 'manual',
      ...body
    };
    contacts.unshift(contact);
    writeDB(contacts);
    return json(contact, 201);
  }

  // ── PATCH /api/contacts/:id ── (update status, notes, etc)
  if (method === 'PATCH' && url.pathname.startsWith('/api/contacts/')) {
    const id = url.pathname.split('/')[3];
    const contacts = readDB();
    const idx = contacts.findIndex(c => c.id === id);
    if (idx === -1) return json({ error: 'Not found' }, 404);
    contacts[idx] = { ...contacts[idx], ...body };
    writeDB(contacts);
    return json(contacts[idx]);
  }

  // ── DELETE /api/contacts/:id ──
  if (method === 'DELETE' && url.pathname.startsWith('/api/contacts/')) {
    const id = url.pathname.split('/')[3];
    let contacts = readDB();
    contacts = contacts.filter(c => c.id !== id);
    writeDB(contacts);
    return json({ ok: true });
  }

  // ── POST /api/webhook/calendly ── (Calendly webhook)
  if (method === 'POST' && url.pathname === '/api/webhook/calendly') {
    const event = body.event || body.payload?.event_type?.name;
    
    // Only process new bookings
    if (event !== 'invitee.created' && body.event !== 'invitee.created') {
      return json({ ok: true, ignored: true });
    }

    const payload = body.payload || body;
    const invitee = payload.invitee || {};
    const scheduled = payload.event || {};

    // Extract phone from questions_and_answers if present
    let telefono = '';
    const qa = invitee.questions_and_answers || [];
    const phoneQ = qa.find(q =>
      q.question?.toLowerCase().includes('tel') ||
      q.question?.toLowerCase().includes('whatsapp') ||
      q.question?.toLowerCase().includes('phone')
    );
    if (phoneQ) telefono = phoneQ.answer || '';

    // Extract negocio/empresa
    let negocio = '';
    const negQ = qa.find(q =>
      q.question?.toLowerCase().includes('negocio') ||
      q.question?.toLowerCase().includes('empresa') ||
      q.question?.toLowerCase().includes('business')
    );
    if (negQ) negocio = negQ.answer || '';

    const nameParts = (invitee.name || '').split(' ');
    const nombre = nameParts[0] || '';
    const apellido = nameParts.slice(1).join(' ') || '';

    const contact = {
      id: uid(),
      createdAt: new Date().toISOString(),
      metaSent: {},
      source: 'calendly',
      nombre,
      apellido,
      email: invitee.email || '',
      telefono,
      negocio,
      fecha: scheduled.start_time || invitee.scheduled_event?.start_time || new Date().toISOString(),
      estado: 'agendado',
      notas: '',
      calendlyUri: invitee.uri || ''
    };

    const contacts = readDB();
    // Avoid duplicates by email + fecha
    const exists = contacts.find(c => c.email === contact.email && c.fecha === contact.fecha);
    if (exists) return json({ ok: true, duplicate: true });

    contacts.unshift(contact);
    writeDB(contacts);

    console.log(`[Calendly] Nuevo agendamiento: ${contact.nombre} ${contact.apellido} <${contact.email}>`);
    return json({ ok: true, contact });
  }

  // ── POST /api/meta/send ── (send event to Meta CAPI)
  if (method === 'POST' && url.pathname === '/api/meta/send') {
    const { contactId, eventName, pixelId, accessToken } = body;
    if (!pixelId || !accessToken || !contactId || !eventName) {
      return json({ error: 'Faltan parámetros' }, 400);
    }

    const contacts = readDB();
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return json({ error: 'Contacto no encontrado' }, 404);

    // Hash email and phone
    function sha256(str) {
      return str ? crypto.createHash('sha256').update(str.trim().toLowerCase()).digest('hex') : null;
    }

    const em = sha256(contact.email);
    const ph = contact.telefono ? sha256(contact.telefono.replace(/\D/g, '')) : null;

    const metaPayload = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'crm',
        user_data: {
          ...(em && { em: [em] }),
          ...(ph && { ph: [ph] }),
        },
        custom_data: {
          crm_status: contact.estado,
          negocio: contact.negocio || '',
        }
      }]
    };

    // Call Meta CAPI
    const metaUrl = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;
    
    fetch(metaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaPayload)
    })
    .then(r => r.json())
    .then(data => {
      if (data.events_received > 0 || data.fbtrace_id) {
        // Update contact metaSent
        const idx = contacts.findIndex(c => c.id === contactId);
        if (!contacts[idx].metaSent) contacts[idx].metaSent = {};
        contacts[idx].metaSent[eventName] = new Date().toISOString();
        writeDB(contacts);
        json({ ok: true, meta: data });
      } else {
        json({ error: data?.error?.message || 'Meta error', raw: data }, 400);
      }
    })
    .catch(err => json({ error: err.message }, 500));

    return; // async
  }

  // ── POST /api/simulate/calendly ── (simulate a Calendly booking for demo)
  if (method === 'POST' && url.pathname === '/api/simulate/calendly') {
    const names = ['Lucía Fernández', 'Diego Martínez', 'Valentina López', 'Mateo García', 'Camila Rodríguez'];
    const businesses = ['E-commerce ropa', 'Agencia diseño', 'Consultoría RRHH', 'Startup tech', 'Tienda física'];
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const name = pick(names).split(' ');

    const fakePayload = {
      event: 'invitee.created',
      payload: {
        invitee: {
          name: pick(names),
          email: `demo${Date.now()}@ejemplo.com`,
          questions_and_answers: [
            { question: 'WhatsApp', answer: '+54 11 ' + Math.floor(Math.random()*90000000+10000000) },
            { question: '¿A qué se dedica tu negocio?', answer: pick(businesses) }
          ]
        },
        event: {
          start_time: new Date(Date.now() + 86400000 * Math.floor(Math.random()*5+1)).toISOString()
        }
      }
    };

    // Reuse webhook logic
    const invitee = fakePayload.payload.invitee;
    const scheduled = fakePayload.payload.event;
    const qa = invitee.questions_and_answers || [];
    const phoneQ = qa.find(q => q.question?.toLowerCase().includes('whatsapp'));
    const negQ = qa.find(q => q.question?.toLowerCase().includes('negocio'));
    const nameParts = invitee.name.split(' ');

    const contact = {
      id: uid(),
      createdAt: new Date().toISOString(),
      metaSent: {},
      source: 'calendly-simulado',
      nombre: nameParts[0],
      apellido: nameParts.slice(1).join(' '),
      email: invitee.email,
      telefono: phoneQ?.answer || '',
      negocio: negQ?.answer || '',
      fecha: scheduled.start_time,
      estado: 'agendado',
      notas: '⚡ Contacto simulado para demo'
    };

    const contacts = readDB();
    contacts.unshift(contact);
    writeDB(contacts);

    console.log(`[Simulación] Nuevo contacto: ${contact.nombre} ${contact.apellido}`);
    return json({ ok: true, contact });
  }

  json({ error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`CRM Martín corriendo en http://localhost:${PORT}`);
});
