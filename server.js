const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'contacts.json');

// ─── AUTH CONFIG ──────────────────────────────────────────
var AUTH_USER = process.env.AUTH_USER || 'martin';
var AUTH_PASS_HASH = process.env.AUTH_PASS_HASH || '3646f12368fa2f7d37bc6faea4464c1723c6a815550e9e3eaa5543ee4366bc2c';
var SESSION_SECRET = process.env.SESSION_SECRET || '996eb6fe4e0c45cf5d977ef10471628a39e4789261240b1b1a431e6a42a8eb14';
var SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours
var sessions = {};

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidSession(req) {
  var cookie = req.headers.cookie || '';
  var match = cookie.match(/session=([a-f0-9]+)/);
  if (!match) return false;
  var sessionId = match[1];
  var session = sessions[sessionId];
  if (!session) return false;
  if (Date.now() > session.expires) {
    delete sessions[sessionId];
    return false;
  }
  return true;
}

function setSessionCookie(res, sessionId) {
  var expires = new Date(Date.now() + SESSION_DURATION).toUTCString();
  res.setHeader('Set-Cookie', 'session=' + sessionId + '; Path=/; HttpOnly; SameSite=Strict; Expires=' + expires);
}

function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { return []; }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sha256(str) {
  return str ? crypto.createHash('sha256').update(str.trim().toLowerCase()).digest('hex') : null;
}

function jsonRes(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(function(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Login page (public) ──
  if (method === 'GET' && url.pathname === '/login') {
    var loginHtml = fs.readFileSync(path.join(__dirname, 'public', 'login.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml);
    return;
  }

  // ── POST /api/auth/login ──
  if (method === 'POST' && url.pathname === '/api/auth/login') {
    var username = body.username || '';
    var password = body.password || '';
    var passHash = crypto.createHash('sha256').update(password).digest('hex');
    if (username === AUTH_USER && passHash === AUTH_PASS_HASH) {
      var sessionId = generateSessionId();
      sessions[sessionId] = { user: username, expires: Date.now() + SESSION_DURATION };
      setSessionCookie(res, sessionId);
      return jsonRes(res, { ok: true });
    } else {
      return jsonRes(res, { ok: false, error: 'Usuario o contraseña incorrectos' }, 401);
    }
  }

  // ── POST /api/auth/logout ──
  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    var cookie = req.headers.cookie || '';
    var match = cookie.match(/session=([a-f0-9]+)/);
    if (match) delete sessions[match[1]];
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    return jsonRes(res, { ok: true });
  }

  // ── GET /api/auth/check ──
  if (method === 'GET' && url.pathname === '/api/auth/check') {
    return jsonRes(res, { ok: isValidSession(req) });
  }

  // ── Static files (protected) ──
  if (method === 'GET' && !url.pathname.startsWith('/api')) {
    // Allow robots.txt without auth
    if (url.pathname === '/robots.txt') {
      var robotsPath = path.join(__dirname, 'public', 'robots.txt');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath) : 'User-agent: *\nAllow: /');
      return;
    }

    // Redirect to login if not authenticated
    if (!isValidSession(req)) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
      return;
    }

    var filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, 'public', filePath);
    var ext = path.extname(filePath);
    var mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.txt': 'text/plain' };
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': mime[ext] || 'text/plain',
        'X-Robots-Tag': 'all',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Protect all API routes ──
  if (url.pathname.startsWith('/api') && 
      url.pathname !== '/api/auth/login' && 
      url.pathname !== '/api/auth/logout' &&
      url.pathname !== '/api/auth/check' &&
      url.pathname !== '/api/webhook/calendly') {
    if (!isValidSession(req)) {
      return jsonRes(res, { error: 'No autorizado' }, 401);
    }
  }

  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    try { body = body ? JSON.parse(body) : {}; } catch (e) { body = {}; }
    handleRoute(res, url, method, body);
  });
});

function handleRoute(req, res, url, method, body) {

  if (method === 'GET' && url.pathname === '/api/contacts') {
    return jsonRes(res, readDB());
  }

  if (method === 'POST' && url.pathname === '/api/contacts') {
    var contacts = readDB();
    var contact = Object.assign({ id: uid(), createdAt: new Date().toISOString(), metaSent: {}, source: 'manual' }, body);
    contacts.unshift(contact);
    writeDB(contacts);
    return jsonRes(res, contact, 201);
  }

  if (method === 'PATCH' && url.pathname.startsWith('/api/contacts/')) {
    var id = url.pathname.split('/')[3];
    var contacts = readDB();
    var idx = contacts.findIndex(function(c) { return c.id === id; });
    if (idx === -1) return jsonRes(res, { error: 'Not found' }, 404);
    contacts[idx] = Object.assign({}, contacts[idx], body);
    writeDB(contacts);
    return jsonRes(res, contacts[idx]);
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/contacts/')) {
    var id = url.pathname.split('/')[3];
    var contacts = readDB().filter(function(c) { return c.id !== id; });
    writeDB(contacts);
    return jsonRes(res, { ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/webhook/calendly') {
    var event = body.event;
    if (event !== 'invitee.created') return jsonRes(res, { ok: true, ignored: true });

    var payload = body.payload || {};
    var invitee = payload.invitee || {};
    var scheduled = payload.event || {};
    var qa = invitee.questions_and_answers || [];
    var telefono = '';
    var negocio = '';

    qa.forEach(function(q) {
      var ql = (q.question || '').toLowerCase();
      if (ql.includes('tel') || ql.includes('whatsapp') || ql.includes('phone')) telefono = q.answer || '';
      if (ql.includes('negocio') || ql.includes('empresa') || ql.includes('business')) negocio = q.answer || '';
    });

    var nameParts = (invitee.name || '').split(' ');
    var contact = {
      id: uid(),
      createdAt: new Date().toISOString(),
      metaSent: {},
      source: 'calendly',
      nombre: nameParts[0] || '',
      apellido: nameParts.slice(1).join(' ') || '',
      email: invitee.email || '',
      telefono: telefono,
      negocio: negocio,
      fecha: scheduled.start_time || new Date().toISOString(),
      estado: 'agendado',
      notas: ''
    };

    var contacts = readDB();
    var exists = contacts.find(function(c) { return c.email === contact.email && c.fecha === contact.fecha; });
    if (exists) return jsonRes(res, { ok: true, duplicate: true });

    contacts.unshift(contact);
    writeDB(contacts);
    console.log('[Calendly] Nuevo agendamiento: ' + contact.nombre + ' ' + contact.apellido);
    return jsonRes(res, { ok: true, contact: contact });
  }

  if (method === 'POST' && url.pathname === '/api/simulate/calendly') {
    var names = ['Lucia Fernandez', 'Diego Martinez', 'Valentina Lopez', 'Mateo Garcia', 'Camila Rodriguez'];
    var businesses = ['E-commerce ropa', 'Agencia diseno', 'Consultoria RRHH', 'Startup tech', 'Tienda fisica'];
    var pick = function(arr) { return arr[Math.floor(Math.random() * arr.length)]; };
    var fullName = pick(names);
    var nameParts = fullName.split(' ');

    var contact = {
      id: uid(),
      createdAt: new Date().toISOString(),
      metaSent: {},
      source: 'calendly-simulado',
      nombre: nameParts[0],
      apellido: nameParts.slice(1).join(' '),
      email: 'demo' + Date.now() + '@ejemplo.com',
      telefono: '+54 11 ' + Math.floor(Math.random() * 90000000 + 10000000),
      negocio: pick(businesses),
      fecha: new Date(Date.now() + 86400000 * Math.floor(Math.random() * 5 + 1)).toISOString(),
      estado: 'agendado',
      notas: 'Contacto simulado para demo'
    };

    var contacts = readDB();
    contacts.unshift(contact);
    writeDB(contacts);
    console.log('[Simulacion] Nuevo contacto: ' + contact.nombre);
    return jsonRes(res, { ok: true, contact: contact });
  }

  if (method === 'POST' && url.pathname === '/api/meta/send') {
    var contactId = body.contactId;
    var eventName = body.eventName;
    var pixelId = body.pixelId;
    var accessToken = body.accessToken;

    if (!pixelId || !accessToken || !contactId || !eventName) {
      return jsonRes(res, { error: 'Faltan parametros' }, 400);
    }

    var contacts = readDB();
    var contact = contacts.find(function(c) { return c.id === contactId; });
    if (!contact) return jsonRes(res, { error: 'Contacto no encontrado' }, 404);

    var em = sha256(contact.email);
    var ph = contact.telefono ? sha256(contact.telefono.replace(/\D/g, '')) : null;

    var userData = {};
    if (em) userData.em = [em];
    if (ph) userData.ph = [ph];

    var testCode = body.testCode || '';
    var metaPayloadObj = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'crm',
        user_data: userData,
        custom_data: { crm_status: contact.estado, negocio: contact.negocio || '' }
      }]
    };
    if (testCode) metaPayloadObj.test_event_code = testCode;
    var metaPayload = JSON.stringify(metaPayloadObj);

    var metaPath = '/v19.0/' + pixelId + '/events?access_token=' + accessToken;
    var options = {
      hostname: 'graph.facebook.com',
      path: metaPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(metaPayload) }
    };

    var metaReq = https.request(options, function(metaRes) {
      var data = '';
      metaRes.on('data', function(chunk) { data += chunk; });
      metaRes.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          if (parsed.events_received > 0 || parsed.fbtrace_id) {
            var idx = contacts.findIndex(function(c) { return c.id === contactId; });
            if (!contacts[idx].metaSent) contacts[idx].metaSent = {};
            contacts[idx].metaSent[eventName] = new Date().toISOString();
            writeDB(contacts);
            jsonRes(res, { ok: true, meta: parsed });
          } else {
            jsonRes(res, { error: (parsed.error && parsed.error.message) || 'Meta error' }, 400);
          }
        } catch (e) {
          jsonRes(res, { error: e.message }, 500);
        }
      });
    });

    metaReq.on('error', function(err) { jsonRes(res, { error: err.message }, 500); });
    metaReq.write(metaPayload);
    metaReq.end();
    return;
  }

  // POST /api/meta/validate — validate by sending a test event to Meta CAPI
  if (method === 'POST' && url.pathname === '/api/meta/validate') {
    var pixelId = body.pixelId;
    var accessToken = body.accessToken;
    var testCode = body.testCode || '';

    if (!pixelId || !accessToken) {
      return jsonRes(res, { error: 'Faltan pixelId o accessToken' }, 400);
    }

    // Send a real test event to Meta CAPI — this is the only reliable way to validate
    var testEmail = sha256('test-validation@crm-martin.com');
    var validatePayloadObj = {
      data: [{
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'crm',
        user_data: { em: [testEmail] },
        custom_data: { validation: true }
      }]
    };
    if (testCode) validatePayloadObj.test_event_code = testCode;
    var validatePayload = JSON.stringify(validatePayloadObj);

    var metaPath = '/v19.0/' + pixelId + '/events?access_token=' + accessToken;
    var options = {
      hostname: 'graph.facebook.com',
      path: metaPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(validatePayload) }
    };

    var valReq = https.request(options, function(valRes) {
      var d = '';
      valRes.on('data', function(c) { d += c; });
      valRes.on('end', function() {
        try {
          var parsed = JSON.parse(d);
          if (parsed.events_received > 0 || parsed.fbtrace_id) {
            jsonRes(res, { ok: true, events_received: parsed.events_received, pixelId: pixelId });
          } else {
            var errMsg = (parsed.error && parsed.error.message) || 'Error desconocido';
            jsonRes(res, { ok: false, step: 'pixel', error: errMsg }, 400);
          }
        } catch(e) { jsonRes(res, { error: e.message }, 500); }
      });
    });
    valReq.on('error', function(e) { jsonRes(res, { error: e.message }, 500); });
    valReq.write(validatePayload);
    valReq.end();
    return;
  }

  jsonRes(res, { error: 'Not found' }, 404);
}

server.listen(PORT, function() {
  console.log('CRM Martin corriendo en http://localhost:' + PORT);
});

// ── Monkey-patch: insert debug endpoint before server.listen ──
