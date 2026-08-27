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
    lastConfirm: null, // último movimiento confirmado, para la pantalla de éxito + imprimir
    adminTab: "resumen",
    adminTrabajadores: null, // lista completa, solo admin
    adminHistorial: null, // movimientos recientes, solo admin
    filtroHistorial: ""
  };
  var ADMIN_TABS = [
    ["resumen", "Resumen"], ["trabajadores", "Trabajadores"], ["puestos", "Puestos"],
    ["epis", "Catálogo EPIs"], ["interes", "Info. interés"], ["historial", "Historial EPIs"],
    ["empresa", "Empresa"], ["ajustes", "Ajustes"]
  ];
  var CATEGORIAS = Object.keys(CATEGORIA_ICONO);

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
  function fileExt(name) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "dat";
  }
  async function subirArchivo(bucket, path, file) {
    var res = await sb.storage.from(bucket).upload(path, file, { contentType: file.type || undefined, upsert: true });
    if (res.error) throw new Error(res.error.message);
    return path;
  }
  function publicUrl(bucket, path) {
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
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
      try { await cargarCatalogo(); } catch (e) { console.error("Error cargando catálogo", e); }
      cargarAdminTrabajadores();
      cargarAdminHistorial();
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
    render();
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
    try { await cargarCatalogo(); } catch (e) { console.error("Error cargando catálogo", e); }
    cargarAdminTrabajadores();
    cargarAdminHistorial();
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
  async function openFicha(epiId) {
    ui.modal = { mode: "ficha", epiId: epiId, fichaPdfSignedUrl: null };
    render();
    var epi = getEpi(epiId);
    if (epi && epi.ficha_pdf_url) {
      var signed = await sb.storage.from("fichas-pdf").createSignedUrl(epi.ficha_pdf_url, 3600);
      if (ui.modal && ui.modal.mode === "ficha" && ui.modal.epiId === epiId) {
        ui.modal.fichaPdfSignedUrl = signed.data ? signed.data.signedUrl : null;
        render();
      }
    }
  }
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

      var pdfBlock = epi.ficha_pdf_url ? (ui.modal.fichaPdfSignedUrl ? ('<iframe class="pdf-frame" src="' + escapeHtml(ui.modal.fichaPdfSignedUrl) + '"></iframe>') : '<p class="field-note">Cargando documento…</p>') :
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

  /* ---------- admin: utilidades de renderizado ---------- */
  function statCard(label, value, caption, tone) {
    return '<div class="stat-card' + (tone ? " is-" + tone : "") + '"><div class="eyebrow">' + escapeHtml(label) + '</div><div class="value mono">' + value + '</div><div class="caption">' + escapeHtml(caption) + "</div></div>";
  }
  function modalFoot(submitLabel) {
    return '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancelar</button><button type="submit" class="btn btn-primary" style="width:auto;"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Guardando…" : submitLabel) + "</button></div>";
  }
  function modalWrap(title, body) {
    return '<div class="modal-overlay open" id="modal-overlay"><div class="modal-panel wide"><div class="modal-head"><h3>' + title + '</h3><button class="modal-close" data-action="close-modal" aria-label="Cerrar">&times;</button></div>' + body + "</div></div>";
  }

  /* ---------- admin: carga de datos ---------- */
  async function cargarAdminTrabajadores() {
    ui.adminTrabajadores = null; render();
    var res = await sb.from("trabajadores").select("*, puestos(nombre)").order("nombre");
    ui.adminTrabajadores = res.data || [];
    render();
  }
  async function cargarAdminHistorial() {
    ui.adminHistorial = null; render();
    var res = await sb.from("movimientos").select("*").order("ts", { ascending: false }).limit(200);
    var movs = res.data || [];
    var paths = movs.filter(function (m) { return m.firma_url; }).map(function (m) { return m.firma_url; });
    if (paths.length) {
      var signedRes = await sb.storage.from("firmas").createSignedUrls(paths, 3600);
      var mapa = {};
      (signedRes.data || []).forEach(function (s) { if (s.signedUrl) mapa[s.path] = s.signedUrl; });
      movs.forEach(function (m) { if (m.firma_url) m._firmaSignedUrl = mapa[m.firma_url] || null; });
    }
    ui.adminHistorial = movs;
    render();
  }

  function adminGoTab(tab) {
    ui.adminTab = tab; ui.formError = ""; render();
    if ((tab === "trabajadores" || tab === "resumen") && ui.adminTrabajadores === null) cargarAdminTrabajadores();
    if ((tab === "historial" || tab === "resumen") && ui.adminHistorial === null) cargarAdminHistorial();
  }

  /* ---------- admin: pantallas ---------- */
  function renderAdminScreen() {
    var nav = '<nav class="admin-nav">' + ADMIN_TABS.map(function (t) {
      return '<button data-action="admin-tab" data-tab="' + t[0] + '" aria-selected="' + (ui.adminTab === t[0]) + '">' + t[1] + "</button>";
    }).join("") + "</nav>";
    var body = "";
    if (ui.adminTab === "resumen") body = renderAdminResumen();
    else if (ui.adminTab === "trabajadores") body = renderAdminTrabajadores();
    else if (ui.adminTab === "puestos") body = renderAdminPuestos();
    else if (ui.adminTab === "epis") body = renderAdminEpis();
    else if (ui.adminTab === "interes") body = renderAdminInteres();
    else if (ui.adminTab === "historial") body = renderAdminHistorial();
    else if (ui.adminTab === "empresa") body = renderAdminEmpresa();
    else if (ui.adminTab === "ajustes") body = renderAdminAjustes();
    return nav + body;
  }

  function renderAdminResumen() {
    var bajoStock = EPIS.filter(function (e) { return stockEstado(e) !== "ok"; });
    var totalUnidades = EPIS.reduce(function (a, e) { return a + (e.stock || 0); }, 0);
    var now = new Date();
    var movs = ui.adminHistorial || [];
    var solicitudesMes = movs.filter(function (m) {
      if (m.tipo !== "solicitud") return false;
      var d = new Date(m.ts);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    var numTrabajadores = ui.adminTrabajadores === null ? "…" : ui.adminTrabajadores.length;
    var stats = '<div class="stats-grid">' +
      statCard("Trabajadores", numTrabajadores, "dados de alta") +
      statCard("Tipos de EPI", EPIS.length, "en catálogo") +
      statCard("Unidades en stock", totalUnidades, "en almacén") +
      statCard("Solicitudes este mes", solicitudesMes, now.toLocaleDateString("es-ES", { month: "long", year: "numeric" })) +
      statCard("Stock bajo mínimo", bajoStock.length, bajoStock.length ? "requieren reposición" : "todo en orden", bajoStock.length ? (bajoStock.some(function (e) { return e.stock <= 0; }) ? "critical" : "warning") : "") +
      "</div>";
    var alerts = "";
    if (bajoStock.length) {
      alerts = '<div class="section"><div class="section-head"><h2>Alertas de stock mínimo<span class="count-badge">' + bajoStock.length + "</span></h2></div>" +
        '<div class="alerts-list">' + bajoStock.map(function (e) {
          var crit = e.stock <= 0;
          return '<div class="alert-card' + (crit ? " is-critical" : "") + '"><div><div class="alert-card-title">' + escapeHtml(e.nombre) + "</div><div class=\"alert-card-sub\">" + escapeHtml(e.categoria || "") + "</div></div>" +
            '<div style="display:flex;align-items:center;gap:16px;"><div class="alert-card-stock mono">' + e.stock + " / " + e.umbral + " uds.</div>" +
            '<button class="btn btn-outline btn-sm" data-action="admin-open-reponer" data-id="' + e.id + '">Reponer stock</button></div></div>';
        }).join("") + "</div></div>";
    }
    return stats + alerts;
  }

  function renderAdminTrabajadores() {
    if (ui.adminTrabajadores === null) return '<p class="field-note">Cargando…</p>';
    var rows = ui.adminTrabajadores.length === 0 ? '<tr class="empty-row"><td colspan="5">Todavía no hay trabajadores dados de alta.</td></tr>' :
      ui.adminTrabajadores.map(function (t) {
        var estadoBadge = !t.activo ? '<span class="badge badge-critical">Baja</span>' : (t.auth_user_id ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-warning">Pendiente 1er acceso</span>');
        return "<tr><td>" + escapeHtml(t.numero_empleado) + "</td><td>" + escapeHtml(t.nombre) + "</td><td>" + (t.puestos ? escapeHtml(t.puestos.nombre) : '<span style="color:var(--text-muted)">Sin asignar</span>') + "</td><td>" + estadoBadge + '</td><td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-open-trabajador" data-id="' + t.id + '">Editar</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-reset-acceso" data-id="' + t.id + '">Restablecer acceso</button>' +
          '<button class="btn-danger-text" data-action="admin-toggle-baja" data-id="' + t.id + '">' + (t.activo ? "Dar de baja" : "Reactivar") + "</button>" +
          "</div></td></tr>";
      }).join("");
    return '<div class="section"><div class="section-head"><h2>Trabajadores</h2><button class="btn btn-primary" style="width:auto;" data-action="admin-open-trabajador">+ Añadir trabajador</button></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Nº empleado</th><th>Nombre</th><th>Puesto</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }

  function renderAdminPuestos() {
    var rows = PUESTOS.length === 0 ? '<tr class="empty-row"><td colspan="4">Todavía no hay puestos configurados.</td></tr>' :
      PUESTOS.map(function (p) {
        var epis = (p.episObligatorios || []).map(function (id) { return getEpi(id); }).filter(Boolean).map(function (e) { return e.nombre; }).join(", ");
        return "<tr><td>" + escapeHtml(p.nombre) + '</td><td class="wrap">' + (p.riesgos || []).length + " riesgos</td><td class=\"wrap\">" + (epis || "—") + '</td><td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-open-puesto" data-id="' + p.id + '">Editar</button>' +
          '<button class="btn-danger-text" data-action="admin-eliminar-puesto" data-id="' + p.id + '">Eliminar</button>' +
          "</div></td></tr>";
      }).join("");
    return '<div class="section"><div class="section-head"><h2>Puestos de trabajo</h2><button class="btn btn-primary" style="width:auto;" data-action="admin-open-puesto">+ Añadir puesto</button></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Puesto</th><th>Riesgos</th><th>EPIs obligatorios</th><th>Acciones</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }

  function renderAdminEpis() {
    var rows = EPIS.length === 0 ? '<tr class="empty-row"><td colspan="7">Aún no has añadido ningún EPI al catálogo.</td></tr>' :
      EPIS.map(function (e) {
        var estado = stockEstado(e);
        var badge = estado === "ok" ? '<span class="badge badge-ok">OK</span>' : estado === "warning" ? '<span class="badge badge-warning">Bajo</span>' : '<span class="badge badge-critical">Agotado</span>';
        var photo = e.foto_url ? ('<img src="' + escapeHtml(e.foto_url) + '" alt="" style="width:100%;height:100%;object-fit:cover;">') : epiIcon(e);
        return "<tr><td><div class=\"file-preview\">" + photo + "</div></td><td>" + escapeHtml(e.nombre) + "</td><td>" + escapeHtml(e.categoria || "") + '</td><td class="mono">' + e.stock + '</td><td class="mono">' + e.umbral + "</td><td>" + badge + '</td><td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-open-reponer" data-id="' + e.id + '">Reponer</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-open-epi" data-id="' + e.id + '">Editar</button>' +
          '<button class="btn-danger-text" data-action="admin-eliminar-epi" data-id="' + e.id + '">Eliminar</button>' +
          "</div></td></tr>";
      }).join("");
    return '<div class="section"><div class="section-head"><h2>Catálogo y stock</h2><button class="btn btn-primary" style="width:auto;" data-action="admin-open-epi">+ Añadir EPI</button></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Foto</th><th>Nombre</th><th>Categoría</th><th>Stock</th><th>Umbral</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }

  function renderAdminInteres() {
    var rows = DOCS_INTERES.length === 0 ? '<tr class="empty-row"><td colspan="4">Todavía no has publicado ningún documento.</td></tr>' :
      DOCS_INTERES.map(function (d) {
        return "<tr><td>" + escapeHtml(d.titulo) + "</td><td>" + (d.categoria ? escapeHtml(d.categoria) : "—") + "</td><td>" + fmtDateTime(d.fecha) + '</td><td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-sm" data-action="admin-open-doc-interes" data-id="' + d.id + '">Editar</button>' +
          '<button class="btn-danger-text" data-action="admin-eliminar-doc-interes" data-id="' + d.id + '">Eliminar</button>' +
          "</div></td></tr>";
      }).join("");
    return '<div class="section"><div class="section-head"><h2>Información de interés</h2><button class="btn btn-primary" style="width:auto;" data-action="admin-open-doc-interes">+ Publicar documento</button></div>' +
      '<p class="field-hint" style="margin-bottom:14px;">Mediciones, resúmenes de formaciones y documentación de PRL visible para todos los trabajadores.</p>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Título</th><th>Categoría</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }

  function renderAdminHistorial() {
    if (ui.adminHistorial === null) return '<p class="field-note">Cargando…</p>';
    var filtro = ui.filtroHistorial.trim().toLowerCase();
    var movimientos = ui.adminHistorial.filter(function (m) {
      if (!filtro) return true;
      return ((m.trabajador_nombre || m.responsable || "") + " " + (m.epi_nombre || "")).toLowerCase().indexOf(filtro) !== -1;
    });
    var rows = movimientos.length === 0 ? ('<tr class="empty-row"><td colspan="7">' + (ui.adminHistorial.length === 0 ? "Todavía no hay movimientos registrados." : "Ningún movimiento coincide con la búsqueda.") + "</td></tr>") :
      movimientos.map(function (m) {
        var tipoBadge = m.tipo === "solicitud" ? '<span class="badge badge-solicitud">Solicitud</span>' : '<span class="badge badge-reposicion">Reposición</span>';
        var cantidadHtml = m.tipo === "solicitud" ? '<span class="mono amount-out">-' + m.cantidad + "</span>" : '<span class="mono amount-in">+' + m.cantidad + "</span>";
        return "<tr><td>" + fmtDateTime(m.ts) + "</td><td>" + tipoBadge + "</td><td>" + escapeHtml(m.trabajador_nombre || m.responsable || "—") + "</td><td>" + escapeHtml(m.epi_nombre || "—") + "</td><td>" + (m.talla ? escapeHtml(m.talla) : "—") + "</td><td>" + cantidadHtml + "</td><td>" +
          (m._firmaSignedUrl ? ('<img class="sig-thumb" src="' + m._firmaSignedUrl + '" alt="Firma">') : "—") + "</td></tr>";
      }).join("");
    return '<div class="section"><div class="section-head"><h2>Historial de movimientos</h2>' +
      '<div class="section-actions"><input class="filter-input" type="search" placeholder="Buscar trabajador o EPI…" value="' + escapeHtml(ui.filtroHistorial) + '" data-action="filter-historial">' +
      '<button class="btn btn-ghost btn-sm" data-action="print-historial">Imprimir listado / Guardar como PDF</button></div></div>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Fecha</th><th>Tipo</th><th>Trabajador / Responsable</th><th>EPI</th><th>Talla</th><th>Cantidad</th><th>Firma</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<p class="field-hint" style="margin-top:10px;">Se muestran los últimos 200 movimientos.</p>' +
      "</div>";
  }

  function renderAdminEmpresa() {
    var logoPreview = EMPRESA.logo_url ? ('<img src="' + escapeHtml(EMPRESA.logo_url) + '" alt="" style="width:100%;height:100%;object-fit:contain;">') : "🦺";
    return '<div class="section"><div class="section-head"><h2>Empresa y marca</h2></div>' +
      '<div class="card" style="max-width:520px;">' +
      '<form id="form-empresa">' +
      '<div class="field"><label>Logo de la empresa</label><div class="file-input-row"><div class="file-preview">' + logoPreview + '</div><input type="file" name="logo" accept="image/*"></div></div>' +
      '<div class="field"><label>Nombre de la empresa</label><input name="nombre" required value="' + escapeHtml(EMPRESA.nombre || "") + '"></div>' +
      '<div class="field"><label>Título principal de la app</label><input name="tituloPrincipal" required value="' + escapeHtml(EMPRESA.titulo_principal || "") + '">' +
      '<span class="field-hint">Se muestra en grande en la pantalla de acceso y en la cabecera.</span></div>' +
      '<div class="field"><label>Título secundario de la app</label><input name="tituloSecundario" required value="' + escapeHtml(EMPRESA.titulo_secundario || "") + '">' +
      '<span class="field-hint">Se muestra más pequeño, debajo del título principal.</span></div>' +
      (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
      '<button class="btn btn-primary" type="submit" style="width:auto;"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Guardando…" : "Guardar") + "</button>" +
      "</form></div></div>";
  }

  function renderAdminAjustes() {
    return '<div class="section"><div class="section-head"><h2>Ajustes</h2></div>' +
      '<div class="card" style="max-width:420px;"><h3 style="font-size:15px;margin-bottom:6px;">Contraseña de administración</h3>' +
      '<p class="field-hint" style="margin-bottom:14px;">Cambia la contraseña de esta cuenta de administración.</p>' +
      '<form id="form-admin-password">' +
      '<div class="field"><label>Nueva contraseña</label><input name="p1" type="password" autocomplete="new-password" required></div>' +
      '<div class="field"><label>Repite la contraseña</label><input name="p2" type="password" autocomplete="new-password" required></div>' +
      (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
      '<button class="btn btn-primary" type="submit" style="width:auto;"' + (ui.busy ? " disabled" : "") + '>' + (ui.busy ? "Guardando…" : "Cambiar contraseña") + "</button>" +
      "</form></div></div>";
  }

  /* ---------- admin: modal genérico ---------- */
  function renderAdminModal() {
    if (!ui.modal) return '<div class="modal-overlay" id="modal-overlay"></div>';
    var mode = ui.modal.mode;

    if (mode === "trabajador") {
      var t = ui.modal.id ? ui.adminTrabajadores.filter(function (x) { return x.id === ui.modal.id; })[0] : null;
      var puestoOptions = '<option value="">Sin asignar</option>' + PUESTOS.map(function (p) { return '<option value="' + p.id + '"' + (t && t.puesto_id === p.id ? " selected" : "") + '>' + escapeHtml(p.nombre) + "</option>"; }).join("");
      return modalWrap(t ? "Editar trabajador" : "Añadir trabajador",
        '<form id="form-admin-modal">' +
        '<div class="row-2"><div class="field"><label>Nº empleado</label><input name="numero" required' + (t ? " disabled" : "") + ' value="' + (t ? escapeHtml(t.numero_empleado) : "") + '"></div>' +
        '<div class="field"><label>Puesto</label><select name="puesto">' + puestoOptions + "</select></div></div>" +
        '<div class="field"><label>Nombre completo</label><input name="nombre" required value="' + (t ? escapeHtml(t.nombre) : "") + '"></div>' +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        modalFoot(t ? "Guardar cambios" : "Añadir") + "</form>");
    }

    if (mode === "puesto") {
      var p = ui.modal.id ? getPuesto(ui.modal.id) : null;
      var epiChips = EPIS.map(function (e) {
        var checked = p && (p.episObligatorios || []).indexOf(e.id) !== -1;
        return '<label><input type="checkbox" name="epiOb" value="' + e.id + '"' + (checked ? " checked" : "") + '>' + escapeHtml(e.nombre) + "</label>";
      }).join("");
      return modalWrap(p ? "Editar puesto" : "Añadir puesto",
        '<form id="form-admin-modal">' +
        '<div class="field"><label>Nombre del puesto</label><input name="nombre" required value="' + (p ? escapeHtml(p.nombre) : "") + '"></div>' +
        '<div class="field"><label>Riesgos (uno por línea)</label><textarea name="riesgos" rows="4">' + (p ? escapeHtml((p.riesgos || []).join("\n")) : "") + '</textarea></div>' +
        '<div class="field"><label>EPIs obligatorios</label><div class="chip-select">' + (epiChips || '<span class="field-hint">Añade primero algún EPI al catálogo.</span>') + "</div></div>" +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        modalFoot(p ? "Guardar cambios" : "Añadir") + "</form>");
    }

    if (mode === "epi") {
      var e = ui.modal.id ? getEpi(ui.modal.id) : null;
      return modalWrap(e ? "Editar EPI" : "Añadir EPI al catálogo",
        '<form id="form-admin-modal">' +
        '<div class="field"><label>Nombre</label><input name="nombre" required placeholder="Ej. Guantes anticorte" value="' + (e ? escapeHtml(e.nombre) : "") + '"></div>' +
        '<div class="field"><label>Categoría</label><select name="categoria"><option value="">— Elegir —</option>' + CATEGORIAS.map(function (c) { return '<option value="' + escapeHtml(c) + '"' + (e && e.categoria === c ? " selected" : "") + '>' + escapeHtml(c) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Tallas / referencias (opcional)</label><input name="tallas" placeholder="Ej. S, M, L, XL" value="' + (e ? escapeHtml((e.tallas || []).join(", ")) : "") + '"></div>' +
        '<div class="row-2">' + (e ? "" : '<div class="field"><label>Stock inicial</label><input name="stock" type="number" min="0" step="1" value="0" required></div>') +
        '<div class="field"><label>Umbral de alerta</label><input name="umbral" type="number" min="0" step="1" value="' + (e ? e.umbral : 5) + '" required></div></div>' +
        '<div class="field"><label>Foto del EPI (opcional)</label><input type="file" name="foto" accept="image/*"></div>' +
        '<div class="field"><label>Ficha técnica en PDF (opcional)</label><input type="file" name="fichaPdf" accept="application/pdf"></div>' +
        '<div class="field"><label>Normativa aplicable</label><input name="normativa" value="' + escapeHtml(e && e.normativa || "") + '"></div>' +
        '<div class="field"><label>Marcado CE</label><input name="marcadoCE" value="' + escapeHtml(e && e.marcado_ce || "") + '"></div>' +
        '<div class="field"><label>Instrucciones de uso</label><textarea name="instrucciones" rows="2">' + escapeHtml(e && e.instrucciones || "") + "</textarea></div>" +
        '<div class="field"><label>Mantenimiento</label><textarea name="mantenimiento" rows="2">' + escapeHtml(e && e.mantenimiento || "") + "</textarea></div>" +
        '<div class="field"><label>Vida útil</label><input name="vidaUtil" value="' + escapeHtml(e && e.vida_util || "") + '"></div>' +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        modalFoot(e ? "Guardar cambios" : "Añadir") + "</form>");
    }

    if (mode === "reponer") {
      var e2 = getEpi(ui.modal.id);
      return modalWrap("Reponer stock" + (e2 ? " — " + escapeHtml(e2.nombre) : ""),
        '<form id="form-admin-modal">' +
        '<p class="field-hint" style="margin-bottom:14px;">Stock actual: <strong class="mono">' + (e2 ? e2.stock : "—") + "</strong> uds.</p>" +
        '<div class="field"><label>Unidades a añadir</label><input name="cantidad" type="number" min="1" step="1" value="1" required></div>' +
        '<div class="field"><label>Responsable de la reposición</label><input name="responsable" required placeholder="Nombre de quien repone"></div>' +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        modalFoot("Reponer") + "</form>");
    }

    if (mode === "doc-interes") {
      var di = ui.modal.id ? getDocInteres(ui.modal.id) : null;
      return modalWrap(di ? "Editar documento" : "Publicar documento",
        '<form id="form-admin-modal">' +
        '<div class="field"><label>Título</label><input name="titulo" required value="' + (di ? escapeHtml(di.titulo) : "") + '"></div>' +
        '<div class="field"><label>Categoría (opcional)</label><input name="categoria" placeholder="Ej. Mediciones, Formación…" value="' + (di ? escapeHtml(di.categoria || "") : "") + '"></div>' +
        '<div class="field"><label>Archivo PDF' + (di ? " (opcional, sustituye al actual)" : "") + '</label><input type="file" name="pdf" accept="application/pdf"' + (di ? "" : " required") + "></div>" +
        (ui.formError ? '<p class="field-error">' + escapeHtml(ui.formError) + "</p>" : "") +
        modalFoot(di ? "Guardar cambios" : "Publicar") + "</form>");
    }
    return '<div class="modal-overlay" id="modal-overlay"></div>';
  }

  /* ---------- admin: guardar / eliminar ---------- */
  async function adminGuardarTrabajador(form, id) {
    var numero = form.numero.value.trim();
    var nombre = form.nombre.value.trim();
    var puestoId = form.puesto.value || null;
    if (!id && !numero) { ui.formError = "Indica el número de empleado."; render(); return; }
    if (!nombre) { ui.formError = "Indica el nombre completo."; render(); return; }
    ui.busy = true; ui.formError = ""; render();
    var res;
    if (id) {
      res = await sb.from("trabajadores").update({ nombre: nombre, puesto_id: puestoId }).eq("id", id);
    } else {
      res = await sb.from("trabajadores").insert({ numero_empleado: numero, nombre: nombre, puesto_id: puestoId });
    }
    ui.busy = false;
    if (res.error) {
      ui.formError = res.error.message.indexOf("duplicate") !== -1 ? "Ya existe un trabajador con ese número de empleado." : "No se ha podido guardar: " + res.error.message;
      render();
      return;
    }
    ui.modal = null; ui.formError = "";
    await cargarAdminTrabajadores();
    toast(id ? "Trabajador actualizado." : "Trabajador añadido.");
  }
  function adminResetAcceso(id) {
    var t = ui.adminTrabajadores.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    if (!window.confirm('¿Restablecer el acceso de "' + t.nombre + '"? Deberá crear una contraseña nueva en su próximo inicio de sesión.')) return;
    sb.rpc("admin_resetear_trabajador", { p_trabajador_id: id }).then(function (res) {
      if (res.error) { toast("No se ha podido restablecer: " + res.error.message, 6000); return; }
      cargarAdminTrabajadores();
      toast("Acceso restablecido.");
    });
  }
  function adminToggleBaja(id) {
    var t = ui.adminTrabajadores.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var msg = t.activo ? ('¿Dar de baja a "' + t.nombre + '"? No podrá volver a iniciar sesión hasta que lo reactives.') : ('¿Reactivar a "' + t.nombre + '"?');
    if (!window.confirm(msg)) return;
    sb.from("trabajadores").update({ activo: !t.activo }).eq("id", id).then(function (res) {
      if (res.error) { toast("No se ha podido actualizar: " + res.error.message, 6000); return; }
      cargarAdminTrabajadores();
      toast(t.activo ? "Trabajador dado de baja." : "Trabajador reactivado.");
    });
  }

  async function adminGuardarPuesto(form, id) {
    var nombre = form.nombre.value.trim();
    var riesgosRaw = form.riesgos.value.trim();
    var riesgos = riesgosRaw ? riesgosRaw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var episObligatorios = Array.prototype.slice.call(form.querySelectorAll('input[name="epiOb"]:checked')).map(function (i) { return i.value; });
    if (!nombre) { ui.formError = "Indica el nombre del puesto."; render(); return; }
    ui.busy = true; ui.formError = ""; render();
    var puestoId = id;
    var res = id ? await sb.from("puestos").update({ nombre: nombre, riesgos: riesgos }).eq("id", id) :
      await sb.from("puestos").insert({ nombre: nombre, riesgos: riesgos }).select().single();
    if (res.error) { ui.busy = false; ui.formError = "No se ha podido guardar: " + res.error.message; render(); return; }
    if (!id) puestoId = res.data.id;
    await sb.from("puesto_epis").delete().eq("puesto_id", puestoId);
    if (episObligatorios.length) {
      await sb.from("puesto_epis").insert(episObligatorios.map(function (eid) { return { puesto_id: puestoId, epi_id: eid }; }));
    }
    ui.busy = false; ui.modal = null; ui.formError = "";
    await cargarCatalogo();
    toast(id ? "Puesto actualizado." : "Puesto añadido.");
  }
  function adminEliminarPuesto(id) {
    if (!window.confirm("¿Eliminar este puesto de trabajo?")) return;
    sb.from("puestos").delete().eq("id", id).then(function (res) {
      if (res.error) { toast("No se ha podido eliminar: " + res.error.message, 6000); return; }
      cargarCatalogo().then(function () { render(); });
      toast("Puesto eliminado.");
    });
  }

  async function adminGuardarEpi(form, id) {
    var nombre = form.nombre.value.trim();
    var categoria = form.categoria.value || null;
    var tallasRaw = form.tallas.value.trim();
    var tallas = tallasRaw ? tallasRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var umbral = parseInt(form.umbral.value, 10);
    if (!nombre) { ui.formError = "Indica el nombre del EPI."; render(); return; }
    if (isNaN(umbral) || umbral < 0) { ui.formError = "Indica un umbral de alerta válido."; render(); return; }
    var fotoFile = form.foto && form.foto.files[0];
    var pdfFile = form.fichaPdf && form.fichaPdf.files[0];
    ui.busy = true; ui.formError = ""; render();

    var payload = {
      nombre: nombre, categoria: categoria, tallas: tallas, umbral: umbral,
      normativa: form.normativa.value.trim() || null, marcado_ce: form.marcadoCE.value.trim() || null,
      instrucciones: form.instrucciones.value.trim() || null, mantenimiento: form.mantenimiento.value.trim() || null,
      vida_util: form.vidaUtil.value.trim() || null
    };
    try {
      var epiId = id;
      if (id) {
        var upd = await sb.from("epis").update(payload).eq("id", id);
        if (upd.error) throw new Error(upd.error.message);
      } else {
        var stockInicial = parseInt(form.stock.value, 10);
        if (isNaN(stockInicial) || stockInicial < 0) stockInicial = 0;
        payload.stock = stockInicial;
        var ins = await sb.from("epis").insert(payload).select().single();
        if (ins.error) throw new Error(ins.error.message);
        epiId = ins.data.id;
      }
      if (fotoFile) {
        var pathFoto = "epis/" + epiId + "/foto-" + uuid() + "." + fileExt(fotoFile.name);
        await subirArchivo("epi-fotos", pathFoto, fotoFile);
        await sb.from("epis").update({ foto_url: publicUrl("epi-fotos", pathFoto) }).eq("id", epiId);
      }
      if (pdfFile) {
        var pathPdf = "epis/" + epiId + "/ficha-" + uuid() + ".pdf";
        await subirArchivo("fichas-pdf", pathPdf, pdfFile);
        await sb.from("epis").update({ ficha_pdf_url: pathPdf }).eq("id", epiId);
      }
    } catch (err) {
      ui.busy = false; ui.formError = "No se ha podido guardar: " + err.message; render(); return;
    }
    ui.busy = false; ui.modal = null; ui.formError = "";
    await cargarCatalogo();
    toast(id ? "EPI actualizado." : "EPI añadido al catálogo.");
  }
  function adminEliminarEpi(id) {
    if (!window.confirm("¿Eliminar este EPI del catálogo? El historial de solicitudes se conservará.")) return;
    sb.from("epis").delete().eq("id", id).then(function (res) {
      if (res.error) { toast("No se ha podido eliminar: " + res.error.message, 6000); return; }
      cargarCatalogo().then(function () { render(); });
      toast("EPI eliminado.");
    });
  }
  async function adminReponer(form, id) {
    var epi = getEpi(id);
    var cantidad = parseInt(form.cantidad.value, 10);
    var responsable = form.responsable.value.trim();
    if (!epi) { ui.modal = null; render(); return; }
    if (!cantidad || cantidad < 1) { ui.formError = "Indica una cantidad válida."; render(); return; }
    if (!responsable) { ui.formError = "Indica quién realiza la reposición."; render(); return; }
    ui.busy = true; ui.formError = ""; render();
    var nuevoStock = epi.stock + cantidad;
    var upd = await sb.from("epis").update({ stock: nuevoStock }).eq("id", id);
    if (upd.error) { ui.busy = false; ui.formError = "No se ha podido reponer: " + upd.error.message; render(); return; }
    await sb.from("movimientos").insert({ tipo: "reposicion", trabajador_id: null, trabajador_nombre: null, epi_id: epi.id, epi_nombre: epi.nombre, talla: null, cantidad: cantidad, firma_url: null, responsable: responsable });
    ui.busy = false; ui.modal = null; ui.formError = "";
    await cargarCatalogo();
    if (ui.adminHistorial !== null) await cargarAdminHistorial();
    toast("Stock repuesto: +" + cantidad + " × " + epi.nombre + ".");
  }

  async function adminGuardarEmpresa(form) {
    var nombre = form.nombre.value.trim();
    var t1 = form.tituloPrincipal.value.trim();
    var t2 = form.tituloSecundario.value.trim();
    if (!nombre || !t1 || !t2) { ui.formError = "Rellena todos los campos."; render(); return; }
    var logoFile = form.logo && form.logo.files[0];
    ui.busy = true; ui.formError = ""; render();
    var logoUrl = EMPRESA.logo_url;
    try {
      if (logoFile) {
        var path = "branding/logo-" + uuid() + "." + fileExt(logoFile.name);
        await subirArchivo("epi-fotos", path, logoFile);
        logoUrl = publicUrl("epi-fotos", path);
      }
      var upd = await sb.from("empresa_config").update({ nombre: nombre, titulo_principal: t1, titulo_secundario: t2, logo_url: logoUrl }).eq("id", 1);
      if (upd.error) throw new Error(upd.error.message);
    } catch (err) {
      ui.busy = false; ui.formError = "No se ha podido guardar: " + err.message; render(); return;
    }
    ui.busy = false; ui.formError = "";
    await cargarBranding();
    toast("Datos de la empresa actualizados.");
    render();
  }

  async function adminGuardarDocInteres(form, id) {
    var titulo = form.titulo.value.trim();
    var categoria = form.categoria.value.trim();
    var pdfFile = form.pdf.files[0];
    if (!titulo) { ui.formError = "Indica el título del documento."; render(); return; }
    if (!id && !pdfFile) { ui.formError = "Adjunta el archivo PDF."; render(); return; }
    ui.busy = true; ui.formError = ""; render();
    try {
      var docId = id;
      var payload = { titulo: titulo, categoria: categoria || null };
      if (id) {
        var upd = await sb.from("documentos_interes").update(payload).eq("id", id);
        if (upd.error) throw new Error(upd.error.message);
      } else {
        var ins = await sb.from("documentos_interes").insert(payload).select().single();
        if (ins.error) throw new Error(ins.error.message);
        docId = ins.data.id;
      }
      if (pdfFile) {
        var path = "docs/" + docId + "/" + uuid() + ".pdf";
        await subirArchivo("documentos-interes", path, pdfFile);
        await sb.from("documentos_interes").update({ pdf_url: path }).eq("id", docId);
      }
    } catch (err) {
      ui.busy = false; ui.formError = "No se ha podido guardar: " + err.message; render(); return;
    }
    ui.busy = false; ui.modal = null; ui.formError = "";
    await cargarCatalogo();
    toast(id ? "Documento actualizado." : "Documento publicado.");
  }
  function adminEliminarDocInteres(id) {
    if (!window.confirm("¿Eliminar este documento?")) return;
    sb.from("documentos_interes").delete().eq("id", id).then(function (res) {
      if (res.error) { toast("No se ha podido eliminar: " + res.error.message, 6000); return; }
      cargarCatalogo().then(function () { render(); });
      toast("Documento eliminado.");
    });
  }

  async function adminCambiarPassword(form) {
    var p1 = form.p1.value, p2 = form.p2.value;
    if (!p1 || p1.length < 4) { ui.formError = "La contraseña debe tener al menos 4 caracteres."; render(); return; }
    if (p1 !== p2) { ui.formError = "Las contraseñas no coinciden."; render(); return; }
    ui.busy = true; ui.formError = ""; render();
    var res = await sb.auth.updateUser({ password: p1 });
    ui.busy = false;
    if (res.error) { ui.formError = "No se ha podido cambiar la contraseña: " + res.error.message; render(); return; }
    ui.formError = "";
    toast("Contraseña actualizada correctamente.");
    render();
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
    } else if (kind === "historial") {
      var filtro = ui.filtroHistorial.trim().toLowerCase();
      var movs = (ui.adminHistorial || []).filter(function (m) {
        if (!filtro) return true;
        return ((m.trabajador_nombre || m.responsable || "") + " " + (m.epi_nombre || "")).toLowerCase().indexOf(filtro) !== -1;
      });
      html = '<div class="print-doc"><h2>Historial de movimientos de EPIs</h2>' +
        '<div class="print-meta">Documento generado el ' + fmtDateTime(new Date().toISOString()) + (filtro ? (' · filtro: "' + escapeHtml(ui.filtroHistorial) + '"') : '') + '</div>' +
        '<table><tr><th>Fecha</th><th>Tipo</th><th>Trabajador / Responsable</th><th>EPI</th><th>Talla</th><th>Cantidad</th></tr>' +
        movs.map(function (m) {
          return '<tr><td>' + fmtDateTime(m.ts) + '</td><td>' + (m.tipo === "solicitud" ? "Solicitud" : "Reposición") + '</td><td>' + escapeHtml(m.trabajador_nombre || m.responsable || "—") + '</td><td>' + escapeHtml(m.epi_nombre || "—") + '</td><td>' + (m.talla ? escapeHtml(m.talla) : "—") + '</td><td>' + (m.tipo === "solicitud" ? "-" : "+") + m.cantidad + '</td></tr>';
        }).join("") +
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
      html = renderAdminHeader() + "<main>" + renderAdminScreen() + "</main>" + renderAdminModal();
    }
    root.innerHTML = html;
    if (ui.screen === "solicitud" && ui.solicitud && ui.solicitud.step === 3) {
      setupSignaturePad(function (v) { if (ui.solicitud) ui.solicitud.sig = v; }, ui.solicitud.sig);
    }
  }

  /* ---------- eventos ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) {
      if (e.target && e.target.id === "modal-overlay") closeModal();
      return;
    }
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
    else if (action === "admin-tab") adminGoTab(el.getAttribute("data-tab"));
    else if (action === "admin-open-trabajador") { ui.modal = { mode: "trabajador", id: id || null }; ui.formError = ""; render(); }
    else if (action === "admin-open-puesto") { ui.modal = { mode: "puesto", id: id || null }; ui.formError = ""; render(); }
    else if (action === "admin-open-epi") { ui.modal = { mode: "epi", id: id || null }; ui.formError = ""; render(); }
    else if (action === "admin-open-reponer") { ui.modal = { mode: "reponer", id: id }; ui.formError = ""; render(); }
    else if (action === "admin-open-doc-interes") { ui.modal = { mode: "doc-interes", id: id || null }; ui.formError = ""; render(); }
    else if (action === "admin-reset-acceso") adminResetAcceso(id);
    else if (action === "admin-toggle-baja") adminToggleBaja(id);
    else if (action === "admin-eliminar-puesto") adminEliminarPuesto(id);
    else if (action === "admin-eliminar-epi") adminEliminarEpi(id);
    else if (action === "admin-eliminar-doc-interes") adminEliminarDocInteres(id);
    else if (action === "print-historial") printDoc("historial");
  });

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && f.id === "form-login") { e.preventDefault(); submitLogin(f); }
    else if (f && f.id === "form-crear-password") { e.preventDefault(); submitCrearPassword(f); }
    else if (f && f.id === "form-admin-login") { e.preventDefault(); submitAdminLogin(f); }
    else if (f && f.id === "form-empresa") { e.preventDefault(); adminGuardarEmpresa(f); }
    else if (f && f.id === "form-admin-password") { e.preventDefault(); adminCambiarPassword(f); }
    else if (f && f.id === "form-admin-modal") {
      e.preventDefault();
      if (!ui.modal) return;
      var mode = ui.modal.mode, id = ui.modal.id;
      if (mode === "trabajador") adminGuardarTrabajador(f, id);
      else if (mode === "puesto") adminGuardarPuesto(f, id);
      else if (mode === "epi") adminGuardarEpi(f, id);
      else if (mode === "reponer") adminReponer(f, id);
      else if (mode === "doc-interes") adminGuardarDocInteres(f, id);
    }
  });

  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t) return;
    if (t.matches('[data-action="filter-historial"]')) {
      ui.filtroHistorial = t.value; render();
      var inp = document.querySelector('[data-action="filter-historial"]');
      if (inp) { inp.focus(); inp.selectionStart = inp.selectionEnd = inp.value.length; }
    }
  });

  boot();
})();
