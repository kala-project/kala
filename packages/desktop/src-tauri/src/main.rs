#[cfg(not(target_os = "linux"))]
compile_error!("Kala desktop is supported only on Linux.");

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use gtk::prelude::*;
use base64::Engine;
mod tray;
mod desktop;
mod placement;
mod connection;
mod media_permissions;
mod debug_forwarder;
mod debug_profile;
mod application_debug;

const DESKTOP_INIT: &str = include_str!("desktop-init.js");
struct ConnectionOrigin(std::sync::Mutex<String>);

#[derive(Debug, PartialEq)]
enum Shortcut {
    Reconnect,
    Reload,
    ForceRefresh,
    Quit,
}

fn shortcut(key: gtk::gdk::keys::Key, modifiers: gtk::gdk::ModifierType) -> Option<Shortcut> {
    use gtk::gdk::{keys::constants, ModifierType};
    let modifiers = modifiers
        & (ModifierType::CONTROL_MASK | ModifierType::SHIFT_MASK | ModifierType::MOD1_MASK
            | ModifierType::SUPER_MASK | ModifierType::META_MASK | ModifierType::HYPER_MASK);
    if modifiers == (ModifierType::CONTROL_MASK | ModifierType::SHIFT_MASK) {
        match key {
            constants::o | constants::O => Some(Shortcut::Reconnect),
            constants::r | constants::R => Some(Shortcut::ForceRefresh),
            _ => None,
        }
    } else if modifiers == ModifierType::CONTROL_MASK {
        match key {
            constants::r | constants::R => Some(Shortcut::Reload),
            constants::q | constants::Q => Some(Shortcut::Quit),
            _ => None,
        }
    } else {
        None
    }
}

fn install_shortcuts(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let minimize_app = window.app_handle().clone();
    let label = window.label().to_owned();
    window.gtk_window()?.connect_window_state_event(move |_, event| {
        if event.new_window_state().contains(gtk::gdk::WindowState::ICONIFIED) {
            tray::hide_if_available(&minimize_app, &label);
        }
        gtk::glib::Propagation::Proceed
    });
    let app = window.app_handle().clone();
    let dashboard_window = window.label() == "dashboard";
    // Native GTK events cannot be synthesized by an unprivileged remote page.
    window.gtk_window()?.connect_key_press_event(move |_, event| {
        match shortcut(event.keyval(), event.state()) {
            Some(Shortcut::Reconnect) => {
                tray::show_launcher(&app);
            }
            Some(Shortcut::Reload) if dashboard_window => {
                if let Some(dashboard) = app.get_webview_window("dashboard") {
                    let _ = dashboard.reload();
                }
            }
            Some(Shortcut::ForceRefresh) if dashboard_window => {
                if let Some(dashboard) = app.get_webview_window("dashboard") {
                    let _ = force_refresh_dashboard(&app, &dashboard);
                }
            }
            Some(Shortcut::Quit) => { placement::capture(&app); app.exit(0); }
            _ => return gtk::glib::Propagation::Proceed,
        }
        gtk::glib::Propagation::Stop
    });
    Ok(())
}

fn endpoint_url(input: &str) -> Result<tauri::Url, String> {
    let input = input.trim();
    if input.chars().any(char::is_control) || input.contains('\\') {
        return Err("Enter a valid HTTP or HTTPS Dashboard origin.".into());
    }
    let url = tauri::Url::parse(input).map_err(|_| "Enter a valid Dashboard origin.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTP or HTTPS origin without credentials, paths, query or fragment.".into());
    }
    Ok(url)
}

fn native_integration_allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        || url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn navigation_allowed(url: &tauri::Url, origin: &str) -> bool {
    // OIDC can redirect to another HTTPS origin. It never gains native privileges.
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || url.origin().ascii_serialization() == origin)
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    endpoint: String,
) -> Result<String, String> {
    desktop::on_ui(app, move |app| {
        authorize_launcher(&window)?;
        connect_dashboard(app.clone(), window, endpoint)
    }).await
}

fn authorize_launcher(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "launcher" || window.url().map_err(|e| e.to_string())?.scheme() != "tauri" {
        return Err("Only the packaged connection screen can open a Dashboard.".into());
    }
    Ok(())
}

fn authorize_window_control(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "launcher" && window.url().map_err(|e| e.to_string())?.scheme() == "tauri" {
        return Ok(());
    }
    desktop::authorize_selected_dashboard(app, window).map(|_| ())
}

#[tauri::command]
async fn desktop_window(app: tauri::AppHandle, window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    desktop::on_ui(app, move |app| {
        authorize_window_control(app, &window)?;
        match action.as_str() {
            "start-dragging" => window.start_dragging().map_err(|e| e.to_string()),
            "minimize" => window.minimize().map_err(|e| e.to_string()),
            "toggle-maximize" => {
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())
                } else {
                    window.maximize().map_err(|e| e.to_string())
                }
            }
            "close" => {
                if !tray::hide_if_available(app, window.label()) {
                    window.close().map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            _ => Err("Unsupported window action.".into()),
        }
    }).await
}

#[tauri::command]
async fn desktop_clipboard_image(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    desktop::on_ui(app, move |app| {
        desktop::authorize_dashboard(app, &window)?;
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let Some(image) = clipboard.wait_for_image() else { return Ok(None); };
        let width = image.width();
        let height = image.height();
        if width <= 0 || height <= 0 || width > 8192 || height > 8192
            || i64::from(width) * i64::from(height) > 40_000_000 {
            return Err("Clipboard image dimensions exceed the supported limit.".into());
        }
        let png = image.save_to_bufferv("png", &[]).map_err(|error| error.to_string())?;
        if png.len() > 20 * 1024 * 1024 {
            return Err("Clipboard image exceeds the 20 MiB encoded limit.".into());
        }
        Ok(Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))))
    }).await
}

fn force_refresh_dashboard(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    use webkit2gtk::{WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};

    desktop::authorize_selected_dashboard(app, window)?;
    let mut url = window.url().map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("__kala_desktop_refresh", &std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string());
    let dashboard = window.clone();
    window.with_webview(move |platform| {
        let Some(manager) = platform.inner().website_data_manager() else {
            let _ = dashboard.navigate(url);
            return;
        };
        let types = WebsiteDataTypes::MEMORY_CACHE
            | WebsiteDataTypes::DISK_CACHE
            | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
            | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
            | WebsiteDataTypes::DOM_CACHE;
        manager.clear(types, gtk::glib::TimeSpan::from_microseconds(0), None::<&gtk::gio::Cancellable>, move |result| {
            if let Err(error) = result {
                eprintln!("Unable to fully clear the Dashboard WebKit cache: {error}");
            }
            if let Err(error) = dashboard.navigate(url) {
                eprintln!("Unable to force-refresh the Dashboard: {error}");
                let _ = dashboard.reload();
            }
        });
    }).map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_force_refresh(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    desktop::on_ui(app, move |app| force_refresh_dashboard(app, &window)).await
}

fn connect_dashboard(app: tauri::AppHandle, window: tauri::WebviewWindow, endpoint: String) -> Result<String, String> {
    let url = endpoint_url(&endpoint)?;
    let origin = url.origin().ascii_serialization();
    desktop::prepare_origin(&app, &origin)?;
    if let Some(previous) = app.get_webview_window("dashboard") {
        if connection::confirmed(&app, &origin) && previous.url().map_err(|e| e.to_string())?.origin().ascii_serialization() == origin {
            tray::reveal(&previous);
            window.hide().map_err(|e| e.to_string())?;
            return Ok(origin);
        }
    }
    application_debug::reset(&app, "Dashboard target changed. Debug forwarding stopped.");
    *app.state::<ConnectionOrigin>().0.lock().map_err(|e| e.to_string())? = origin.clone();
    connection::begin(&app, &origin);
    if let Some(previous) = app.get_webview_window("dashboard") {
        previous.navigate(url).map_err(|e| e.to_string())?;
        previous.show().map_err(|e| e.to_string())?;
        previous.set_focus().map_err(|e| e.to_string())?;
        window.hide().map_err(|e| e.to_string())?;
        desktop::connected(&app, &origin)?;
        return Ok(origin);
    }
    let navigation_app = app.clone();
    let (width, height) = placement::initial_size(&app, "dashboard", (1100.0, 760.0));
    // WebKit download callbacks belong to a context, not a window. Keep the
    // Dashboard separate from the launcher's default automatic download handler.
    let profile = app.path().app_data_dir().map_err(|e| e.to_string())?.join("dashboard-profile");
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let dashboard = WebviewWindowBuilder::new(&app, "dashboard", WebviewUrl::External(url))
        .data_directory(profile)
        .title("Kala")
        .decorations(false)
        .inner_size(width, height)
        .min_inner_size(800.0, 600.0)
        .initialization_script(DESKTOP_INIT)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                connection::loaded(window.app_handle());
            }
        })
        .on_navigation(move |url| {
            application_debug::reset(&navigation_app, "Dashboard navigation stopped debugging. Explicitly restart after authentication.");
            navigation_app.state::<ConnectionOrigin>().0.lock()
                .map(|origin| navigation_allowed(url, &origin)).unwrap_or(false)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_document_title_changed(|window, _| {
            let _ = window.set_title("Kala");
        })
        .on_download(|webview, event| {
            if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                let parent = match webview.window().gtk_window() {
                    Ok(parent) => parent,
                    Err(error) => {
                        eprintln!("Unable to show desktop save dialog: {error}");
                        return false;
                    }
                };
                let dialog = gtk::FileChooserNative::new(
                    Some("Save Dashboard download"),
                    Some(&parent),
                    gtk::FileChooserAction::Save,
                    Some("Save"),
                    Some("Cancel"),
                );
                if let Some(name) = destination.file_name().and_then(|name| name.to_str()) {
                    dialog.set_current_name(name);
                }
                dialog.set_do_overwrite_confirmation(true);
                let accepted = dialog.run() == gtk::ResponseType::Accept;
                let path = dialog.filename();
                dialog.destroy();
                if accepted {
                    if let Some(path) = path {
                        *destination = path;
                        return true;
                    }
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    install_shortcuts(&dashboard).map_err(|e| e.to_string())?;
    connection::watch_load_failures(&dashboard)?;
    media_permissions::install(&dashboard)?;
    placement::restore(&dashboard);
    window.hide().map_err(|e| e.to_string())?;
    desktop::connected(&app, &origin)?;
    Ok(origin)
}

fn main() {
    match desktop::instance() {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => { eprintln!("{error}"); std::process::exit(2); }
    }
    tauri::Builder::default()
        .manage(ConnectionOrigin(std::sync::Mutex::new(String::new())))
        .manage(tray::State::default())
        .manage(desktop::State::default())
        .manage(connection::State::default())
        .manage(media_permissions::State::default())
        .manage(application_debug::State::default())
        .invoke_handler(tauri::generate_handler![application_debug::application_debug_begin, application_debug::application_debug, connect, desktop_window, desktop_clipboard_image, desktop_force_refresh, connection::launcher_bootstrap, desktop::desktop_ui, desktop::desktop_status, desktop::desktop_notify, desktop::desktop_connection_ready])
        .setup(|app| {
            if let Some(launcher) = app.get_webview_window("launcher") {
                install_shortcuts(&launcher)?;
            }
            if let Err(error) = tray::setup(app) {
                eprintln!("System tray could not be confirmed; the window will remain reachable: {error}");
            }
            desktop::setup(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                desktop::publish_window_state(window.app_handle());
            }
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)) {
                placement::event(window, event);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                placement::capture(window.app_handle());
                if tray::hide_if_available(window.app_handle(), window.label()) {
                    api.prevent_close();
                } else if tray::keep_open_when_uncertain(window) {
                    api.prevent_close();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Kala desktop")
        .run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_shortcuts_require_exact_modifiers_but_allow_lock_keys() {
        use gtk::gdk::{keys::constants, ModifierType as M};
        assert_eq!(shortcut(constants::O, M::CONTROL_MASK | M::SHIFT_MASK), Some(Shortcut::Reconnect));
        assert_eq!(shortcut(constants::o, M::CONTROL_MASK | M::SHIFT_MASK | M::LOCK_MASK | M::MOD2_MASK), Some(Shortcut::Reconnect));
        assert_eq!(shortcut(constants::r, M::CONTROL_MASK), Some(Shortcut::Reload));
        assert_eq!(shortcut(constants::r, M::CONTROL_MASK | M::SHIFT_MASK), Some(Shortcut::ForceRefresh));
        assert_eq!(shortcut(constants::Q, M::CONTROL_MASK | M::LOCK_MASK), Some(Shortcut::Quit));
        for (key, modifiers) in [
            (constants::o, M::CONTROL_MASK),
            (constants::O, M::SHIFT_MASK),
            (constants::q, M::empty()),
            (constants::q, M::CONTROL_MASK | M::MOD1_MASK),
            (constants::O, M::CONTROL_MASK | M::SHIFT_MASK | M::SUPER_MASK),
            (constants::Left, M::MOD1_MASK),
        ] {
            assert_eq!(shortcut(key, modifiers), None);
        }
    }

    #[test]
    fn accepts_http_and_https_origins_without_url_secrets() {
        for endpoint in ["https://runlab.example", "https://runlab.example:13000/", "http://remote.example", "http://192.0.2.4:13000", "http://127.0.0.1:13000", "http://localhost:13000", "http://[::1]:13000"] {
            assert!(endpoint_url(endpoint).is_ok(), "{endpoint}");
        }
        for endpoint in [concat!("https://", "user", ":", "secret", "@example.org"), "https://example.org/path", "https://example.org?token=secret", "https://example.org/#token", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "https://example.org%40evil.example.invalid", concat!("https", "://exam", "\n", "ple.org")] {
            assert!(endpoint_url(endpoint).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn native_integration_requires_tls_except_on_explicit_loopback() {
        for endpoint in ["https://runlab.example", "https://192.0.2.4:13000", "http://127.0.0.1:13000", "http://localhost:13000", "http://[::1]:13000"] {
            assert!(native_integration_allowed(&endpoint_url(endpoint).unwrap()), "{endpoint}");
        }
        for endpoint in ["http://remote.example", "http://192.0.2.4:13000"] {
            assert!(!native_integration_allowed(&endpoint_url(endpoint).unwrap()), "{endpoint}");
        }
    }

    #[test]
    fn navigation_preserves_https_oidc_without_allowing_local_protocols() {
        let origin = "http://127.0.0.1:13000";
        for endpoint in ["https://id.example.org/authorize?state=1", "http://127.0.0.1:13000/auth/callback"] {
            assert!(navigation_allowed(&tauri::Url::parse(endpoint).unwrap(), origin));
        }
        for endpoint in ["http://127.0.0.1:22", "http://remote.example", "tauri://localhost", "file:///etc/passwd", concat!("https://", "user", ":", "secret", "@example.org")] {
            assert!(!navigation_allowed(&tauri::Url::parse(endpoint).unwrap(), origin));
        }
    }
}
