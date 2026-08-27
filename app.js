(function () {
  "use strict";

  var sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  var EMPRESA = { nombre: "Tu Empresa", logo_url: null, titulo_principal: "Prevención de Riesgos Laborales", titulo_secundario: "EPIStock" };
  var CAE_CONFIG = { retencion_meses: 48, aviso_legal: "" };

  var CATEGORIA_ICONO = {
    "Protección de la cabeza": "⛑️", "Protección auditiva": "🎧", "Protección ocular y facial": "🥽",
    "Protección respiratoria": "😷", "Protección de manos": "🧤", "Protección de pies": "🥾",
    "Protección del cuerpo": "🦺", "Trabajos en altura": "🪢", "Otros": "📦"
  };

  var EPIS = [];
  var PUESTOS = [];
  var DOCS_INTERES = [];

  var ui = {
    screen: "loading", // loading | login | crear-password | admin-login | home | admin | epis | riesgos | interes | perfil | solicitud
    rol: null, // 'trabajador' | 'admin'
    trabajador: null, // fila completa de public.trabajadores del usuario actual
    pendingNumero: null,
    pendingNombre: null,
    loginError: "",
    adminError: "",
    formError: "",
    busy: false,
    modal: null,
    puestoAbierto: null,
    solicitud: null,
    misMovimientos: null, // se rellena al entrar en "Mi perfil"
    lastConfirm: null // último movimiento confirmado, para la pantalla de éxito + imprimir
  };

  /* ---------- utilidades ---------- */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString("es-ES") + ", " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }
  function toast(msg, duration) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () { el.classList.remove("show"); }, duration || 4200);
  }
  function numeroToEmail(numero) {
    return "empleado-" + encodeURIComponent(numero).toLowerCase() + "@epistock.local";
  }
  function brandMarkHtml() {
    return EMPRESA.logo_url ? ('<img src="' + escapeHtml(EMPRESA.logo_url) + '" alt="" style="width:100%;height:100%;object-fit:contain;">') : "🦺";
  }
  function brandTextHtml() {
    return "<h1>" + escapeHtml(EMPRESA.titulo_principal || "Prevención de Riesgos Laborales") + "</h1><p>" + escapeHtml(EMPRESA.titulo_secundario || "EPIStock") + "</p>";
  }
  function epiIcon(epi) { return CATEGORIA_ICONO[epi.categoria] || "📦"; }
  function stockEstado(epi) { if (epi.stock <= 0) return "critical"; if (epi.stock <= epi.umbral) return "warning"; return "ok"; }
  function getEpi(id) { for (var i = 0; i < EPIS.length; i++) if (EPIS[i].id === id) return EPIS[i]; return null; }
  function getPuesto(id) { for (var i = 0; i < PUESTOS.length; i++) if (PUESTOS[i].id === id) return PUESTOS[i]; return null; }
  function getDocInteres(id) { for (var i = 0; i < DOCS_INTERES.length; i++) if (DOCS_INTERES[i].id === id) return DOCS_INTERES[i]; return null; }
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    var mime = parts[0].match(/:(.*?);/)[1];
    var bstr = atob(parts[1]);
    var n = bstr.length;
    var u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], { type: mime });
  }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // alternativa para navegadores sin randomUUID nativo
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ---------- arranque ---------- */
  async function boot() {
    render();
    try {
      await cargarBranding();
    } catch (e) {
      console.error("Error cargando branding", e);
    }
    var sess = await sb.auth.getSession();
    var session = sess.data && sess.data.session;
    if (session) {
      await resolverSesion();
    } else {
      ui.screen = "login";
    }
    render();

    sb.auth.onAuthStateChange(function (event) {
      // Ignoramos el evento cuando el propio código ya está gestionando el cierre de sesión
      // (por ejemplo, un admin-login rechazado que necesita mostrar su propio error):
      // ese código controla la pantalla/errores explícitamente después de su propio signOut().
      if (event === "SIGNED_OUT" && !suppressAuthListener) {
        ui.screen = "login";
        ui.rol = null;
        ui.trabajador = null;
        ui.loginError = "";
        ui.adminError = "";
        render();
      }
    });
  }

  var suppressAuthListener = false;
  async function signOutSilently() {
    suppressAuthListener = true;
    await sb.auth.signOut();
    suppressAuthListener = false;
  }

  async function cargarBranding() {
    var r1 = await sb.from("empresa_config").select("*").eq("id", 1).single();
    if (r1.data) EMPRESA = r1.data;
    var r2 = await sb.from("cae_config").select("*").eq("id", 1).single();
    if (r2.data) CAE_CONFIG = r2.data;
  }

  async function resolverSesion() {
    var adminRes = await sb.rpc("is_admin");
    if (adminRes.error) {
      console.error(adminRes.error);
      ui.screen = "login";
      return;
    }
    if (adminRes.data === true) {
      ui.rol = "admin";
      ui.screen = "admin";
      return;
    }
    var perfilRes = await sb.from("perfiles").select("trabajador_id").single();
    if (perfilRes.error || !perfilRes.data || !perfilRes.data.trabajador_id) {
      // sesión sin perfil válido (no debería pasar en uso normal)
      await signOutSilently();
      ui.screen = "login";
      ui.loginError = "Tu cuenta no está vinculada a ningún trabajador. Contacta con administración.";
      return;
    }
    var tRes = await sb.from("trabajadores").select("*, puestos(nombre)").eq("id", perfilRes.data.trabajador_id).single();
    if (tRes.error || !tRes.data) {
      await signOutSilently();
      ui.screen = "login";
      return;
    }
    ui.trabajador = tRes.data;
    ui.rol = "trabajador";
    ui.screen = "home";
    try { await cargarCatalogo(); } catch (e) { console.error("Error cargando catálogo", e); }
  }

  async function cargarCatalogo() {
    var episRes = await sb.from("epis").select("*").order("nombre");
    EPIS = episRes.data || [];

    var puestosRes = await sb.from("puestos").select("*").order("nombre");
    var puestoEpisRes = await sb.from("puesto_epis").select("puesto_id, epi_id");
    var mapa = {};
    (puestoEpisRes.data || []).forEach(function (row) {
      if (!mapa[row.puesto_id]) mapa[row.puesto_id] = [];
      mapa[row.puesto_id].push(row.epi_id);
    });
    PUESTOS = (puestosRes.data || []).map(function (p) {
      p.episObligatorios = mapa[p.id] || [];
      return p;
    });

    var docsRes = await sb.from("documentos_interes").select("*").order("fecha", { ascending: false });
    DOCS_INTERES = docsRes.data || [];
  }

  /* ---------- login trabajador ---------- */
  async function submitLogin(form) {
    var numero = form.numero.value.trim();
    var password = form.password.value;
    if (!numero) { ui.loginError = "Introduce tu número de empleado."; render(); return; }
    ui.busy = true; ui.loginError = ""; render();
    var res = await sb.rpc("trabajador_estado", { p_numero_empleado: numero });
    ui.busy = false;
    if (res.error) { ui.loginError = "No se ha podido comprobar el número de empleado. Inténtalo de nuevo."; render(); return; }
    var estado = res.data;
    if (!estado || !estado.existe) {
      ui.loginError = "Número de empleado no reconocido. Contacta con administración.";
      render();
      return;
    }
    if (!estado.tiene_password) {
      ui.pendingNumero = numero;
      ui.pendingNombre = estado.nombre;
      ui.screen = "crear-password";
      ui.loginError = "";
      render();
      return;
    }
    if (!password) { ui.loginError = "Introduce tu contraseña."; render(); return; }
    ui.busy = true; render();
    var signInRes = await sb.auth.signInWithPassword({ email: numeroToEmail(numero), password: password });
    ui.busy = false;
    if (signInRes.error) {
      ui.loginError = "Contraseña incorrecta.";
      render();
      return;
    }
    await resolverSesion();
    render();
  }

  function cancelCrearPassword() {
    ui.pendingNumero = null; ui.pendingNombre = null; ui.loginError = ""; ui.screen = "login"; render();
  }

  async function submitCrearPassword(form) {
    var p1 = form.p1.value, p2 = form.p2.value;
    if (!p1 || p1.length < 4) { ui.loginError = "La contraseña debe tener al menos 4 caracteres."; render(); return; }
    if (p1 !== p2) { ui.loginError = "Las contraseñas no coinciden."; render(); return; }
    ui.busy = true; ui.loginError = ""; render();
    var email = numeroToEmail(ui.pendingNumero);
    var signUpRes = await sb.auth.signUp({ email: email, password: p1 });
    if (signUpRes.error) {
      ui.busy = false;
      ui.loginError = "No se ha podido crear la contraseña: " + signUpRes.error.message;
      render();
      return;
    }
    if (!signUpRes.data.session) {
      // el proyecto tiene activada la confirmación por email; con estas cuentas internas debe estar desactivada
      ui.busy = false;
      ui.loginError = "No se ha podido iniciar sesión automáticamente. Pide a administración que revise la configuración de Supabase (confirmación de email debe estar desactivada).";
      render();
      return;
    }
    var vincularRes = await sb.rpc("vincular_trabajador", { p_numero_empleado: ui.pendingNumero });
    ui.busy = false;
    if (vincularRes.error) {
      ui.loginError = "No se ha podido vincular la cuenta: " + vincularRes.error.message;
      await signOutSilently();
      render();
      return;
    }
    ui.pendingNumero = null; ui.pendingNombre = null;
    await resolverSesion();
    render();
  }

  /* ---------- login admin ---------- */
  function goAdminLogin() { ui.screen = "admin-login"; ui.adminError = ""; render(); }
  function goToLogin() { ui.screen = "login"; ui.loginError = ""; render(); }

  async function submitAdminLogin(form) {
    var email = form.email.value.trim();
    var password = form.password.value;
    if (!email || !password) { ui.adminError = "Rellena correo y contraseña."; render(); return; }
    ui.busy = true; ui.adminError = ""; render();
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) {
      ui.busy = false;
      ui.adminError = "Credenciales incorrectas.";
      render();
      return;
    }
    var adminRes = await sb.rpc("is_admin");
    ui.busy = false;
    if (adminRes.error || adminRes.data !== true) {
      ui.adminError = "Esta cuenta no tiene permisos de administración.";
      await signOutSilently();
      render();
      return;
    }
    ui.rol = "admin";
    ui.screen = "admin";
    render();
  }

  async function logout() {
    await sb.auth.signOut();
    ui.trabajador = null; ui.rol = null; ui.screen = "login";
    render();
  }

  function goScreen(screen) {
    if (screen !== "solicitud") ui.solicitud = null;
    ui.modal = null; ui.formError = "";
    ui.screen = screen;
    if (screen === "perfil") { cargarMisMovimientos(); }
    render();
  }

  /* ---------- firma táctil ---------- */
  var sigDrawing = false, sigLastPt = null, sigWriteFn = null;
  function setupSignaturePad(writeFn, existingDataUrl) {
    sigWriteFn = writeFn || function (v) { if (ui.solicitud) ui.solicitud.sig = v; };
    window.setTimeout(function () {
      var canvas = document.getElementById("sig-canvas");
      if (!canvas) return;
      var ratio = window.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width * ratio);
      canvas.height = Math.max(1, rect.height * ratio);
      var ctx = canvas.getContext("2d");
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
      var cs = getComputedStyle(document.documentElement);
      ctx.strokeStyle = cs.getPropertyValue("--text").trim() || "#16211D";

      if (existingDataUrl) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, rect.width, rect.height); };
        img.src = existingDataUrl;
        var ph0 = document.getElementById("sig-placeholder");
        if (ph0) ph0.style.display = "none";
        var btn0 = document.getElementById("btn-confirmar-firma");
        if (btn0) btn0.disabled = false;
      }

      function pos(e) {
        var r = canvas.getBoundingClientRect();
        var p = e.touches ? e.touches[0] : e;
        return { x: p.clientX - r.left, y: p.clientY - r.top };
      }
      function start(e) { e.preventDefault(); sigDrawing = true; sigLastPt = pos(e); }
      function move(e) {
        if (!sigDrawing) return;
        e.preventDefault();
        var p = pos(e);
        ctx.beginPath(); ctx.moveTo(sigLastPt.x, sigLastPt.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        sigLastPt = p;
      }
      function end(e) {
        if (!sigDrawing) return;
        sigDrawing = false;
        var ph = document.getElementById("sig-placeholder");
        if (ph) ph.style.display = "none";
        if (sigWriteFn) sigWriteFn(canvas.toDataURL("image/png"));
        ui.formError = "";
        var btn = document.getElementById("btn-confirmar-firma");
        if (btn) btn.disabled = false;
      }
      canvas.onpointerdown = start; canvas.onpointermove = move;
      canvas.onpointerup = end; canvas.onpointerleave = end; canvas.onpointercancel = end;
      canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
    }, 20);
  }
  function clearSignature() {
    var canvas = document.getElementById("sig-canvas");
    if (canvas) { var ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    var ph = document.getElementById("sig-placeholder"); if (ph) ph.style.display = "flex";
    if (sigWriteFn) sigWriteFn(null);
    var btn = document.getElementById("btn-confirmar-firma"); if (btn) btn.disabled = true;
  }

  /* ---------- EPIs ---------- */
  function renderEpiTile(epi, extraAction) {
    var estado = stockEstado(epi);
    var photo = epi.foto_url ? ('<img src="' + escapeHtml(epi.foto_url) + '" alt="">') : epiIcon(epi);
    var badge = estado === "ok" ? '<span class="badge badge-ok">Disponible</span>' : estado === "warning" ? '<span class="badge badge-warning">Pocas unidades</span>' : '<span class="badge badge-critical">Agotado</span>';
    return '<button class="epi-tile" data-action="' + (extraAction || "open-accion") + '" data-id="' + epi.id + '">' +
      '<div class="epi-tile-photo">' + photo + "</div>" +
      '<div class="epi-tile-name">' + escapeHtml(epi.nombre) + "</div>" +
      '<div class="epi-tile-stock">' + badge + "</div>" +
      "</button>";
  }
  function renderEpisScreen() {
    if (EPIS.length === 0) return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>EPIs</span></div><p class="empty-note">Todavía no hay EPIs en el catálogo.</p>';
    return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>EPIs</span></div>' +
      '<h2 style="font-size:20px;margin-bottom:16px;">Catálogo de EPIs</h2>' +
      '<div class="epi-grid">' + EPIS.map(function (e) { return renderEpiTile(e); }).join("") + "</div>";
  }

  /* ---------- riesgos por puesto ---------- */
  function renderRiesgosScreen() {
    if (PUESTOS.length === 0) return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>Riesgos por puesto</span></div><p class="empty-note">Todavía no hay puestos de trabajo configurados.</p>';
    return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>Riesgos por puesto</span></div>' +
      '<h2 style="font-size:20px;margin-bottom:16px;">Riesgos por puesto</h2>' +
      '<div class="puesto-list">' + PUESTOS.map(function (p) {
        var open = ui.puestoAbierto === p.id;
        var epis = p.episObligatorios.map(function (id) { return getEpi(id); }).filter(Boolean);
        var riesgos = p.riesgos || [];
        return '<div class="puesto-card' + (open ? " open" : "") + '">' +
          '<button class="puesto-head" data-action="toggle-puesto" data-id="' + p.id + '"><div><h3>' + escapeHtml(p.nombre) + '</h3><div class="meta">' + riesgos.length + " riesgos identificados · " + epis.length + ' EPI obligatorios</div></div><span class="puesto-chevron">⌄</span></button>' +
          '<div class="puesto-body">' +
          '<ul class="riesgos-list">' + (riesgos.length ? riesgos.map(function (r) { return '<li><span class="dot"></span>' + escapeHtml(r) + "</li>"; }).join("") : '<li style="color:var(--text-muted);">Sin riesgos registrados.</li>') + "</ul>" +
          (epis.length ? ('<div class="puesto-epis-label">EPIs obligatorios</div><div class="puesto-epis-grid">' + epis.map(function (e) {
              var photo = e.foto_url ? ('<img src="' + escapeHtml(e.foto_url) + '" alt="">') : epiIcon(e);
              return '<button class="puesto-epi-btn" data-action="solicitar-desde-puesto" data-id="' + e.id + '"><div class="epi-tile-photo">' + photo + '</div><span class="nm">' + escapeHtml(e.nombre) + "</span></button>";
            }).join("") + "</div>") : "") +
          "</div></div>";
      }).join("") + "</div>";
  }

  /* ---------- información de interés ---------- */
  function renderInteresScreen() {
    if (DOCS_INTERES.length === 0) return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>Información de interés</span></div><p class="empty-note">Todavía no se ha publicado ningún documento.</p>';
    return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>Información de interés</span></div>' +
      '<h2 style="font-size:20px;margin-bottom:16px;">Información de interés</h2>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Documento</th><th>Categoría</th><th>Fecha</th><th></th></tr></thead><tbody>' +
      DOCS_INTERES.map(function (d) {
        return "<tr><td>" + escapeHtml(d.titulo) + "</td><td>" + (d.categoria ? escapeHtml(d.categoria) : "—") + "</td><td>" + fmtDateTime(d.fecha) + '</td><td><button class="btn btn-ghost btn-sm" data-action="open-doc-interes" data-id="' + d.id + '">Ver documento</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  /* ---------- mi perfil ---------- */
  async function cargarMisMovimientos() {
    ui.misMovimientos = null; render();
    var res = await sb.from("movimientos").select("*").eq("tipo", "solicitud").order("ts", { ascending: false });
    var movs = res.data || [];
    for (var i = 0; i < movs.length; i++) {
      if (movs[i].firma_url) {
        var signed = await sb.storage.from("firmas").createSignedUrl(movs[i].firma_url, 3600);
        movs[i]._firmaSignedUrl = signed.data ? signed.data.signedUrl : null;
      }
    }
    ui.misMovimientos = movs;
    render();
  }
  function renderPerfilScreen() {
    var t = ui.trabajador;
    var body;
    if (ui.misMovimientos === null) {
      body = '<p class="field-note">Cargando…</p>';
    } else {
      var mios = ui.misMovimientos;
      var rows = mios.length === 0 ? '<tr class="empty-row"><td colspan="5">Todavía no has realizado ninguna solicitud de EPI.</td></tr>' :
        mios.map(function (m) {
          return "<tr><td>" + fmtDateTime(m.ts) + "</td><td>" + escapeHtml(m.epi_nombre) + "</td><td>" + (m.talla ? escapeHtml(m.talla) : "—") + '</td><td class="mono">' + m.cantidad + "</td><td>" +
            (m._firmaSignedUrl ? ('<img class="sig-thumb" src="' + m._firmaSignedUrl + '" alt="Firma">') : "—") + "</td></tr>";
        }).join("");
      body = '<h3 style="font-size:15px;margin-bottom:12px;">Mis solicitudes de EPI</h3>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Fecha</th><th>EPI</th><th>Talla</th><th>Cantidad</th><th>Firma</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
    }
    return '<div class="crumb"><button data-action="go-home">Inicio</button><span>/</span><span>Mi perfil</span></div>' +
      '<h2 style="font-size:20px;margin-bottom:4px;">' + escapeHtml(t.nombre) + '</h2>' +
      '<p class="mini-item-sub" style="margin-bottom:20px;">Nº empleado ' + escapeHtml(t.numero_empleado) + " · " + escapeHtml(t.puestos ? t.puestos.nombre : "Sin puesto asignado") + "</p>" +
      body;
  }

  /* ---------- solicitud de EPI ---------- */
  function startSolicitud(epiId) {
    var epi = getEpi(epiId);
    if (!epi || epi.stock < 1) { toast("Este EPI no tiene stock disponible."); return; }
    ui.solicitud = { epiId: epiId, step: 1, talla: (epi.tallas && epi.tallas[0]) || null, cantidad: 1, sig: null };
    ui.modal = null;
    ui.screen = "solicitud";
    render();
  }
  function cancelSolicitud() { ui.solicitud = null; ui.screen = "epis"; render(); }
  function solicitudSetTalla(t) { if (ui.solicitud) { ui.solicitud.talla = t; render(); } }
  function solicitudCantidad(delta) {
    if (!ui.solicitud) return;
    var epi = getEpi(ui.solicitud.epiId);
    var n = ui.solicitud.cantidad + delta;
    if (n < 1) n = 1;
    if (epi && n > epi.stock) n = epi.stock;
    ui.solicitud.cantidad = n;
    render();
  }
  function solicitudAceptar() {
    if (!ui.solicitud) return;
    var epi = getEpi(ui.solicitud.epiId);
    if (!epi || epi.stock < ui.solicitud.cantidad) { ui.formError = "No hay stock suficiente."; render(); return; }
    ui.formError = "";
    ui.solicitud.step = 2;
    render();
  }
  function solicitudVolverPaso(n) { if (ui.solicitud) { ui.solicitud.step = n; ui.formError = ""; render(); } }
  function solicitudIrFirma() { if (ui.solicitud) { ui.solicitud.step = 3; render(); } }
  async function solicitudConfirmar() {
    var s = ui.solicitud;
    if (!s || !s.sig) { ui.formError = "Es necesario firmar antes de continuar."; render(); return; }
    var epi = getEpi(s.epiId);
    if (!epi) return;
    ui.busy = true; ui.formError = ""; render();

    var movId = uuid();
    var path = "solicitudes/" + ui.trabajador.id + "/" + movId + ".png";
    var blob = dataUrlToBlob(s.sig);
    var upRes = await sb.storage.from("firmas").upload(path, blob, { contentType: "image/png", upsert: true });
    if (upRes.error) {
      ui.busy = false;
      ui.formError = "No se ha podido guardar la firma: " + upRes.error.message;
      render();
      return;
    }
    var rpcRes = await sb.rpc("crear_solicitud_epi", { p_epi_id: s.epiId, p_talla: s.talla, p_cantidad: s.cantidad, p_firma_url: path });
    ui.busy = false;
    if (rpcRes.error) {
      var msg = rpcRes.error.message || "";
      if (msg.indexOf("stock_insuficiente") !== -1) ui.formError = "Ya no hay stock suficiente de este EPI.";
      else ui.formError = "No se ha podido registrar la solicitud: " + msg;
      render();
      return;
    }
    epi.stock = rpcRes.data.stock_restante;
    ui.lastConfirm = {
      id: rpcRes.data.movimiento_id, ts: rpcRes.data.ts, trabajadorNombre: ui.trabajador.nombre,
      epiNombre: epi.nombre, talla: s.talla, cantidad: s.cantidad, firmaPng: s.sig
    };
    s.step = 4;
    render();
  }
  function finishSolicitud() { ui.solicitud = null; ui.screen = "epis"; render(); }

  function renderSolicitudScreen() {
    var s = ui.solicitud; if (!s) return "";
    var epi = getEpi(s.epiId);
    if (!epi) return '<p class="empty-note">Este EPI ya no está disponible.</p>';
    var pct = s.step;
    var progress = [1, 2, 3, 4].map(function (n) { return '<span class="' + (n <= pct ? "done" : "") + '"></span>'; }).join("");

    var body = "";
    if (s.step === 1) {
      var tallaHtml = "";
      if (epi.tallas && epi.tallas.length) {
        tallaHtml = '<div class="field"><label>Talla / referencia</label><div class="tile-select">' +
          epi.tallas.map(function (t) { return '<button type="button" class="' + (t === s.talla ? "selected" : "") + '" data-action="set-talla" data-talla="' + escapeHtml(t) + '">' + escapeHtml(t) + "</button>"; }).join("") +
          "</div></div>";
      }
      body = '<div class="epi-detail-head"><div class="epi-detail-photo">' + (epi.foto_url ? ('<img src="' + escapeHtml(epi.foto_url) + '" alt="">') : epiIcon(epi)) + '</div><div><h3 style="font-size:18px;">' + escapeHtml(epi.nombre) + '</h3><div class="mini-item-sub">' + escapeHtml(epi.categoria || "") + " · stock: " + epi.stock + "</div></div></div>" +
        tallaHtml +
        '<div class="field"><label>Cantidad</label><div class="qty-stepper">' +
        '<button type="button" data-action="qty-menos"' + (s.cantidad <= 1 ? " disabled" : "") + ">−</button>" +
        '<div class="qty-value mono">' + s.cantidad + "</div>" +
        '<button type="button" data-action="qty-mas"' + (s.cantidad >= epi.stock ? " disabled" : "") + ">+</button>" +
        "</div></div>" +
        (ui.formError ? '<p class="field-error" style="text-align:center;">' + escapeHtml(ui.formError) + "</p>" : "") +
        '<div class="btn-row" style="margin-top:18px;"><button class="btn btn-ghost" data-action="cancelar-solicitud">Cancelar</button>' +
        '<button class="btn btn-primary" data-action="solicitud-aceptar"' + (epi.stock < 1 ? " disabled" : "") + ">Aceptar</button></div>";
    } else if (s.step === 2) {
      body = '<h3 style="font-size:18px;margin-bottom:4px;">Resumen de la solicitud</h3><p class="mini-item-sub" style="margin-bottom:6px;">Revisa los datos antes de firmar.</p>' +
        '<div class="summary-list">' +
        '<div class="summary-row"><span class="label">Trabajador</span><span class="value">' + escapeHtml(ui.trabajador.nombre) + "</span></div>" +
        '<div class="summary-row"><span class="label">EPI</span><span class="value">' + escapeHtml(epi.nombre) + "</span></div>" +
        (s.talla ? '<div class="summary-row"><span class="label">Talla</span><span class="value">' + escapeHtml(s.talla) + "</span></div>" : "") +
        '<div class="summary-row"><span class="label">Cantidad</span><span class="value">' + s.cantidad + "</span></div>" +
        '<div class="summary-row"><span class="label">Fecha y hora</span><span class="value">' + fmtDateTime(new Date().toISOString()) + "</span></div>" +
        "</div>" +
        '<div class="btn-row"><button class="btn btn-ghost" data-action="solicitud-volver" data-paso="1">Atrás</button>' +
        '<button class="btn btn-primary" data-action="solicitud-ir-firma">Firmar</button></div>';
    } else if (s.step === 3) {
      body = '<h3 style="font-size:18px;margin-bottom:4px;">Firma del trabajador</h3><p class="mini-item-sub" style="margin-bottom:6px;">Firma con el dedo o el lápiz táctil en el recuadro.</p>' +
        '<div class="sign-pad-wrap"><canvas id="sig-canvas"></canvas><div class="sign-pad-placeholder" id="sig-placeholder">Firma aquí</div></div>' +
        '<div class="sign-actions"><button class="btn-link" type="button" data-action="borrar-firma">Borrar firma</button></div>' +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        '<div class="btn-row"><button class="btn btn-ghost" data-action="solicitud-volver" data-paso="2">Atrás</button>' +
        '<button class="btn btn-primary" id="btn-confirmar-firma" data-action="solicitud-confirmar" disabled' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Guardando…" : "Confirmar y guardar") + '</button></div>';
    } else if (s.step === 4) {
      body = '<div class="confirmation-icon">✓</div>' +
        '<h3 style="font-size:19px;text-align:center;margin-bottom:6px;">Solicitud registrada</h3>' +
        '<p class="mini-item-sub" style="text-align:center;margin-bottom:20px;">' + escapeHtml(epi.nombre) + (s.talla ? " · talla " + escapeHtml(s.talla) : "") + " · " + s.cantidad + " ud. · " + fmtDateTime(ui.lastConfirm ? ui.lastConfirm.ts : new Date().toISOString()) + "</p>" +
        '<div class="btn-row">' +
        '<button class="btn btn-outline" data-action="print-solicitud">Imprimir / Guardar como PDF</button>' +
        "</div>" +
        '<button class="btn btn-primary" style="margin-top:10px;" data-action="finalizar-solicitud">Volver a EPIs</button>';
    }

    return '<div class="stepper-card"><div class="stepper-progress">' + progress + "</div>" + body + "</div>";
  }

  /* ---------- modales de trabajador ---------- */
  function openFicha(epiId) { ui.modal = { mode: "ficha", epiId: epiId }; render(); }
  function openAccion(epiId) { ui.modal = { mode: "accion", epiId: epiId }; render(); }
  function closeModal() { ui.modal = null; ui.formError = ""; render(); }
  async function openDocInteres(id) {
    var d = getDocInteres(id);
    if (!d) return;
    ui.modal = { mode: "doc-interes", docId: id, pdfSignedUrl: null };
    render();
    if (d.pdf_url) {
      var signed = await sb.storage.from("documentos-interes").createSignedUrl(d.pdf_url, 3600);
      if (ui.modal && ui.modal.mode === "doc-interes" && ui.modal.docId === id) {
        ui.modal.pdfSignedUrl = signed.data ? signed.data.signedUrl : null;
        render();
      }
    }
  }

  function renderWorkerModal() {
    if (!ui.modal) return '<div class="modal-overlay" id="modal-overlay"></div>';

    if (ui.modal.mode === "accion" || ui.modal.mode === "ficha") {
      var epi = getEpi(ui.modal.epiId);
      if (!epi) return '<div class="modal-overlay" id="modal-overlay"></div>';

      if (ui.modal.mode === "accion") {
        return '<div class="modal-overlay open" id="modal-overlay"><div class="modal-panel">' +
          '<div class="modal-head"><h3>' + escapeHtml(epi.nombre) + '</h3><button class="modal-close" data-action="close-modal" aria-label="Cerrar">&times;</button></div>' +
          '<div class="action-choice">' +
          '<button class="btn btn-outline" data-action="open-ficha" data-id="' + epi.id + '">📄 Consultar ficha técnica</button>' +
          '<button class="btn btn-primary" data-action="solicitar-epi" data-id="' + epi.id + '"' + (epi.stock < 1 ? " disabled" : "") + '>🦺 Solicitar EPI</button>' +
          "</div></div></div>";
      }

      var pdfBlock = epi.ficha_pdf_url ? ('<iframe class="pdf-frame" src="' + escapeHtml(epi.ficha_pdf_url) + '"></iframe>') :
        ('<dl class="ficha-doc">' +
          '<dt>Normativa aplicable</dt><dd>' + escapeHtml(epi.normativa || "—") + "</dd>" +
          '<dt>Marcado CE</dt><dd>' + escapeHtml(epi.marcado_ce || "—") + "</dd>" +
          '<dt>Instrucciones de uso</dt><dd>' + escapeHtml(epi.instrucciones || "—") + "</dd>" +
          '<dt>Mantenimiento</dt><dd>' + escapeHtml(epi.mantenimiento || "—") + "</dd>" +
          '<dt>Vida útil</dt><dd>' + escapeHtml(epi.vida_util || "—") + "</dd>" +
          "</dl>");
      return '<div class="modal-overlay open" id="modal-overlay"><div class="modal-panel wide">' +
        '<div class="modal-head"><h3>Ficha técnica</h3><button class="modal-close" data-action="close-modal" aria-label="Cerrar">&times;</button></div>' +
        pdfBlock +
        '<div class="modal-foot"><button class="btn btn-outline btn-sm" data-action="print-ficha" data-id="' + epi.id + '">Imprimir / Guardar como PDF</button>' +
        '<button class="btn btn-ghost btn-sm" data-action="close-modal">Cerrar</button></div>' +
        "</div></div>";
    }

    if (ui.modal.mode === "doc-interes") {
      var d = getDocInteres(ui.modal.docId);
      if (!d) return '<div class="modal-overlay" id="modal-overlay"></div>';
      var body = ui.modal.pdfSignedUrl ? ('<iframe class="pdf-frame" src="' + escapeHtml(ui.modal.pdfSignedUrl) + '"></iframe>') :
        (d.pdf_url ? '<p class="field-note">Cargando documento…</p>' : '<p class="empty-note">Todavía no se ha adjuntado el PDF de este documento.</p>');
      return '<div class="modal-overlay open" id="modal-overlay"><div class="modal-panel wide">' +
        '<div class="modal-head"><h3>' + escapeHtml(d.titulo) + '</h3><button class="modal-close" data-action="close-modal" aria-label="Cerrar">&times;</button></div>' +
        body + '<div class="modal-foot"><button class="btn btn-ghost btn-sm" data-action="close-modal">Cerrar</button></div></div></div>';
    }

    return '<div class="modal-overlay" id="modal-overlay"></div>';
  }

  /* ---------- impresión ---------- */
  function printDoc(kind, epiId) {
    var root = document.getElementById("print-root");
    if (!root) return;
    var html = "";
    if (kind === "solicitud" && ui.lastConfirm) {
      var m = ui.lastConfirm;
      html = '<div class="print-doc"><h2>Solicitud de EPI</h2>' +
        '<div class="print-meta">Documento generado el ' + fmtDateTime(new Date().toISOString()) + '</div>' +
        '<table>' +
        '<tr><td class="k">Trabajador</td><td>' + escapeHtml(m.trabajadorNombre) + '</td></tr>' +
        '<tr><td class="k">EPI solicitado</td><td>' + escapeHtml(m.epiNombre) + '</td></tr>' +
        (m.talla ? '<tr><td class="k">Talla / referencia</td><td>' + escapeHtml(m.talla) + '</td></tr>' : '') +
        '<tr><td class="k">Cantidad</td><td>' + m.cantidad + '</td></tr>' +
        '<tr><td class="k">Fecha y hora de la solicitud</td><td>' + fmtDateTime(m.ts) + '</td></tr>' +
        '</table>' +
        '<div class="sig-box"><div style="font-size:11px;color:#555;margin-bottom:6px;">Firma del trabajador</div>' +
        (m.firmaPng ? ('<img src="' + m.firmaPng + '" alt="Firma">') : '<div>Sin firma</div>') +
        '</div></div>';
    } else if (kind === "ficha") {
      var epi = getEpi(epiId);
      if (!epi) return;
      html = '<div class="print-doc"><h2>Ficha técnica — ' + escapeHtml(epi.nombre) + '</h2>' +
        '<div class="print-meta">Categoría: ' + escapeHtml(epi.categoria || "") + '</div>' +
        '<table>' +
        '<tr><td class="k">Normativa aplicable</td><td>' + escapeHtml(epi.normativa || "—") + '</td></tr>' +
        '<tr><td class="k">Marcado CE</td><td>' + escapeHtml(epi.marcado_ce || "—") + '</td></tr>' +
        '<tr><td class="k">Instrucciones de uso</td><td>' + escapeHtml(epi.instrucciones || "—") + '</td></tr>' +
        '<tr><td class="k">Mantenimiento</td><td>' + escapeHtml(epi.mantenimiento || "—") + '</td></tr>' +
        '<tr><td class="k">Vida útil</td><td>' + escapeHtml(epi.vida_util || "—") + '</td></tr>' +
        '</table></div>';
    }
    if (!html) return;
    root.innerHTML = html;
    window.setTimeout(function () { window.print(); }, 60);
  }

  /* ---------- render ---------- */
  function shellExtras() { return ""; }

  function renderLoginScreen() {
    return '<div class="login-screen"><div class="login-card">' +
      '<div class="login-brand"><div class="brand-mark">' + brandMarkHtml() + "</div>" + brandTextHtml() + "</div>" +
      '<form id="form-login">' +
      '<div class="field"><label for="numero">Número de empleado</label><input id="numero" name="numero" inputmode="numeric" autocomplete="username" required></div>' +
      '<div class="field"><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="current-password"></div>' +
      (ui.loginError ? '<p class="field-error">' + escapeHtml(ui.loginError) + "</p>" : "") +
      '<button class="btn btn-primary" type="submit"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Comprobando…" : "Entrar") + '</button>' +
      "</form>" +
      '<div class="login-footer"><button class="btn-link" data-action="admin-login">Acceso administración</button></div>' +
      '<div class="login-divider">o</div>' +
      '<button class="btn btn-outline" data-action="go-externa" style="width:100%;">Soy de una empresa externa</button>' +
      "</div></div>";
  }

  function renderCrearPasswordScreen() {
    return '<div class="login-screen"><div class="login-card">' +
      '<div class="login-brand"><div class="brand-mark">' + brandMarkHtml() + "</div>" + brandTextHtml() + "</div>" +
      '<p class="field-note">Hola, ' + escapeHtml(ui.pendingNombre || "") + '. Es tu primer acceso: crea tu contraseña.</p>' +
      '<form id="form-crear-password">' +
      '<div class="field"><label for="p1">Nueva contraseña</label><input id="p1" name="p1" type="password" autocomplete="new-password" required></div>' +
      '<div class="field"><label for="p2">Repite la contraseña</label><input id="p2" name="p2" type="password" autocomplete="new-password" required></div>' +
      (ui.loginError ? '<p class="field-error">' + escapeHtml(ui.loginError) + "</p>" : "") +
      '<button class="btn btn-primary" type="submit"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Creando…" : "Crear contraseña y entrar") + '</button>' +
      "</form>" +
      '<div class="login-footer"><button class="btn-link" data-action="cancelar-crear-password">Volver</button></div>' +
      "</div></div>";
  }

  function renderAdminLoginScreen() {
    return '<div class="login-screen"><div class="login-card">' +
      '<div class="login-brand"><div class="brand-mark">' + brandMarkHtml() + "</div>" + brandTextHtml() + "</div>" +
      '<p class="field-note">Acceso de administración</p>' +
      '<form id="form-admin-login">' +
      '<div class="field"><label for="admin-email">Correo</label><input id="admin-email" name="email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="admin-password">Contraseña</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required></div>' +
      (ui.adminError ? '<p class="field-error">' + escapeHtml(ui.adminError) + "</p>" : "") +
      '<button class="btn btn-primary" type="submit"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Accediendo…" : "Entrar") + '</button>' +
      "</form>" +
      '<div class="login-footer"><button class="btn-link" data-action="goto-login">Volver</button></div>' +
      "</div></div>";
  }

  function renderWorkerHeader() {
    var t = ui.trabajador;
    return '<header class="app-header"><div class="app-header-inner">' +
      '<div class="brand"><div class="brand-mark" aria-hidden="true">' + brandMarkHtml() + '</div><div class="brand-text">' + brandTextHtml() + "</div></div>" +
      '<div class="header-user"><div class="header-user-info" style="text-align:right;"><div class="name">' + escapeHtml(t ? t.nombre : "") + '</div><div class="role">' + escapeHtml(t && t.puestos ? t.puestos.nombre : "Sin puesto asignado") + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" data-action="logout">Salir</button></div>' +
      "</div></header>";
  }

  function renderHomeScreen() {
    return renderWorkerHeader() +
      '<main><div class="home-welcome"><div class="eyebrow">Bienvenido/a</div><h1>' + escapeHtml(ui.trabajador.nombre) + "</h1></div>" +
      '<div class="home-grid">' +
      '<button class="home-card" data-action="go-epis"><div class="icon">🦺</div><h2>EPIs</h2><p>Consulta la ficha técnica de cada equipo o solicita uno nuevo.</p></button>' +
      '<button class="home-card" data-action="go-riesgos"><div class="icon">⚠️</div><h2>Riesgos por puesto</h2><p>Revisa los riesgos de tu puesto y los EPIs obligatorios.</p></button>' +
      '<button class="home-card" data-action="go-interes"><div class="icon">📚</div><h2>Información de interés</h2><p>Mediciones, formaciones y documentación de PRL.</p></button>' +
      '<button class="home-card" data-action="go-perfil"><div class="icon">🧑</div><h2>Mi perfil</h2><p>Consulta tus solicitudes y movimientos anteriores.</p></button>' +
      "</div>" +
      "</main>";
  }

  function renderAdminHeader() {
    return '<header class="app-header"><div class="app-header-inner">' +
      '<div class="brand"><div class="brand-mark" aria-hidden="true">' + brandMarkHtml() + '</div><div class="brand-text"><h1>' + escapeHtml(EMPRESA.titulo_principal || "Prevención de Riesgos Laborales") + '</h1><p>Administración · ' + escapeHtml(EMPRESA.titulo_secundario || "EPIStock") + '</p></div></div>' +
      '<div class="header-user"><button class="btn btn-ghost btn-sm" data-action="logout">Salir</button></div>' +
      "</div></header>";
  }

  function renderAdminScreen() {
    return renderAdminHeader() +
      '<main><h2 style="font-size:20px;margin-bottom:10px;">Panel de administración</h2>' +
      '<p class="field-hint">Sesión de administrador conectada correctamente a Supabase. El resto del panel (trabajadores, EPIs, puestos, historial, empresas externas...) se está migrando por partes.</p>' +
      "</main>";
  }

  function render() {
    var root = document.getElementById("root");
    if (!root) return;
    var html = "";
    if (ui.screen === "loading") {
      html = '<div class="login-screen"><div class="login-card"><p class="field-note">Cargando…</p></div></div>';
    } else if (ui.screen === "login") {
      html = renderLoginScreen();
    } else if (ui.screen === "crear-password") {
      html = renderCrearPasswordScreen();
    } else if (ui.screen === "admin-login") {
      html = renderAdminLoginScreen();
    } else if (ui.screen === "home") {
      html = renderHomeScreen() + renderWorkerModal();
    } else if (ui.screen === "epis") {
      html = renderWorkerHeader() + "<main>" + renderEpisScreen() + "</main>" + renderWorkerModal();
    } else if (ui.screen === "riesgos") {
      html = renderWorkerHeader() + "<main>" + renderRiesgosScreen() + "</main>" + renderWorkerModal();
    } else if (ui.screen === "interes") {
      html = renderWorkerHeader() + "<main>" + renderInteresScreen() + "</main>" + renderWorkerModal();
    } else if (ui.screen === "perfil") {
      html = renderWorkerHeader() + "<main>" + renderPerfilScreen() + "</main>" + renderWorkerModal();
    } else if (ui.screen === "solicitud") {
      html = renderWorkerHeader() + "<main>" + renderSolicitudScreen() + "</main>" + renderWorkerModal();
    } else if (ui.screen === "admin") {
      html = renderAdminScreen();
    }
    root.innerHTML = html;
    if (ui.screen === "solicitud" && ui.solicitud && ui.solicitud.step === 3) {
      setupSignaturePad(function (v) { if (ui.solicitud) ui.solicitud.sig = v; }, ui.solicitud.sig);
    }
  }

  /* ---------- eventos ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    if (action === "admin-login") goAdminLogin();
    else if (action === "goto-login") goToLogin();
    else if (action === "cancelar-crear-password") cancelCrearPassword();
    else if (action === "logout") logout();
    else if (action === "go-home") goScreen("home");
    else if (action === "go-epis") goScreen("epis");
    else if (action === "go-riesgos") goScreen("riesgos");
    else if (action === "go-interes") goScreen("interes");
    else if (action === "go-perfil") goScreen("perfil");
    else if (action === "go-externa") {
      toast("Esta pantalla todavía se está migrando. Vuelve en breve.");
    }
    else if (action === "open-accion") openAccion(id);
    else if (action === "open-ficha") openFicha(id);
    else if (action === "solicitar-epi") startSolicitud(id);
    else if (action === "solicitar-desde-puesto") startSolicitud(id);
    else if (action === "toggle-puesto") { ui.puestoAbierto = ui.puestoAbierto === id ? null : id; render(); }
    else if (action === "close-modal") closeModal();
    else if (action === "open-doc-interes") openDocInteres(id);
    else if (action === "cancelar-solicitud") cancelSolicitud();
    else if (action === "set-talla") solicitudSetTalla(el.getAttribute("data-talla"));
    else if (action === "qty-menos") solicitudCantidad(-1);
    else if (action === "qty-mas") solicitudCantidad(1);
    else if (action === "solicitud-aceptar") solicitudAceptar();
    else if (action === "solicitud-volver") solicitudVolverPaso(parseInt(el.getAttribute("data-paso"), 10));
    else if (action === "solicitud-ir-firma") solicitudIrFirma();
    else if (action === "borrar-firma") clearSignature();
    else if (action === "solicitud-confirmar") solicitudConfirmar();
    else if (action === "print-solicitud") printDoc("solicitud");
    else if (action === "print-ficha") printDoc("ficha", id);
    else if (action === "finalizar-solicitud") finishSolicitud();
  });

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && f.id === "form-login") { e.preventDefault(); submitLogin(f); }
    else if (f && f.id === "form-crear-password") { e.preventDefault(); submitCrearPassword(f); }
    else if (f && f.id === "form-admin-login") { e.preventDefault(); submitAdminLogin(f); }
  });

  boot();
})();
