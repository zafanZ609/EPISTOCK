(function () {
  "use strict";

  var sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  var EMPRESA = { nombre: "Tu Empresa", logo_url: null, titulo_principal: "Prevención de Riesgos Laborales", titulo_secundario: "EPIStock" };
  var CAE_CONFIG = { retencion_meses: 48, aviso_legal: "" };

  var ui = {
    screen: "loading", // loading | login | crear-password | admin-login | home | admin
    rol: null, // 'trabajador' | 'admin'
    trabajador: null, // fila completa de public.trabajadores del usuario actual
    pendingNumero: null,
    pendingNombre: null,
    loginError: "",
    adminError: "",
    formError: "",
    busy: false
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
      '<p class="field-hint" style="margin-top:24px;">Esta es la nueva versión conectada a la base de datos propia. Las pantallas de EPIs, riesgos, información de interés, perfil y empresa externa se están migrando por partes — vuelven en breve.</p>' +
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
      html = renderHomeScreen();
    } else if (ui.screen === "admin") {
      html = renderAdminScreen();
    }
    root.innerHTML = html;
  }

  /* ---------- eventos ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var action = el.getAttribute("data-action");
    if (action === "admin-login") goAdminLogin();
    else if (action === "goto-login") goToLogin();
    else if (action === "cancelar-crear-password") cancelCrearPassword();
    else if (action === "logout") logout();
    else if (action === "go-epis" || action === "go-riesgos" || action === "go-interes" || action === "go-perfil" || action === "go-externa") {
      toast("Esta pantalla todavía se está migrando. Vuelve en breve.");
    }
  });

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f && f.id === "form-login") { e.preventDefault(); submitLogin(f); }
    else if (f && f.id === "form-crear-password") { e.preventDefault(); submitCrearPassword(f); }
    else if (f && f.id === "form-admin-login") { e.preventDefault(); submitAdminLogin(f); }
  });

  boot();
})();
