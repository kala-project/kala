use gtk::{gio, glib, prelude::*};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::VecDeque, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use tauri::Manager;

thread_local! {
    static APPLICATION: RefCell<Option<gio::Application>> = const { RefCell::new(None) };
    static HANDLE: RefCell<Option<tauri::AppHandle>> = const { RefCell::new(None) };
    static PENDING: RefCell<Option<(Option<String>, String)>> = const { RefCell::new(None) };
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Activity { Idle, Running, Attention, Completed }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notice {
    id: String,
    session_id: String,
    title: String,
    body: String,
    silent: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiState {
    status: Activity,
    running: u32,
    attention: u32,
    completed: u32,
}

fn activity_label(state: &UiState) -> String {
    match state.status {
        Activity::Idle => "Idle".to_owned(),
        Activity::Running => format!("Running: {} active · {} queued/completed", state.running, state.completed),
        Activity::Attention => format!("Needs attention: {} · {} active", state.attention, state.running),
        Activity::Completed => format!("Completed: {} · {} active", state.completed, state.running),
    }
}

pub struct State {
    activity: Mutex<Activity>,
    delivered: Mutex<VecDeque<String>>,
    rate: Mutex<VecDeque<Instant>>,
    notifications_available: AtomicBool,
    origins: Mutex<Vec<String>>,
    notifications: Mutex<VecDeque<(u32, String, String)>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            activity: Mutex::new(Activity::Idle), delivered: Mutex::new(VecDeque::new()),
            rate: Mutex::new(VecDeque::new()), notifications_available: AtomicBool::new(false), origins: Mutex::new(Vec::new()),
            notifications: Mutex::new(VecDeque::new()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub version: String,
    pub focused: bool,
    pub visible: bool,
    pub notifications_available: bool,
    pub tray_available: bool,
}

pub fn valid_id(id: &str) -> bool {
    valid_bounded_id(id, 128)
}

fn valid_bounded_id(id: &str, limit: usize) -> bool {
    !id.is_empty() && id.len() <= limit && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
}

pub fn session_link(input: &str) -> Option<String> {
    let id = input.strip_prefix("agent-runlab://session/")?;
    valid_id(id).then(|| id.to_owned())
}

pub fn instance() -> Result<bool, String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let session = match args.as_slice() {
        [] => None,
        [uri] => Some(session_link(uri).ok_or("Only canonical agent-runlab://session/<id> links are accepted.")?),
        _ => return Err("Unexpected desktop arguments.".into()),
    };
    glib::set_application_name("Kala");
    let app = gio::Application::new(Some("io.github.xingsy97.akernel.desktop"), gio::ApplicationFlags::empty());
    app.connect_activate(|_| HANDLE.with(|h| {
        if let Some(app) = h.borrow().as_ref() { crate::tray::restore(app); }
    }));
    let action = gio::SimpleAction::new("open-session", Some(glib::VariantTy::STRING));
    action.connect_activate(|_, target| {
        if let Some(id) = target.and_then(|v| v.str()).filter(|id| valid_id(id)) {
            PENDING.with(|p| *p.borrow_mut() = Some((None, id.to_owned())));
            HANDLE.with(|h| if let Some(app) = h.borrow().as_ref() { route_pending(app); });
        }
    });
    app.add_action(&action);
    let notification = gio::SimpleAction::new("notification-session", Some(glib::VariantTy::new("(ss)").unwrap()));
    notification.connect_activate(|_, target| {
        if let Some((origin, id)) = target.and_then(|v| v.get::<(String, String)>()) {
            if !valid_id(&id) || crate::endpoint_url(&origin).is_err() { return; }
            PENDING.with(|p| *p.borrow_mut() = Some((Some(origin), id)));
            HANDLE.with(|h| {
                if let Some(app) = h.borrow().as_ref() {
                    route_pending(app);
                }
            });
        }
    });
    app.add_action(&notification);
    app.register(gio::Cancellable::NONE).map_err(|e| e.to_string())?;
    if app.is_remote() {
        if let Some(id) = session { app.activate_action("open-session", Some(&id.to_variant())); }
        else { app.activate(); }
        if let Some(bus) = app.dbus_connection() { let _ = bus.flush_sync(gio::Cancellable::NONE); }
        return Ok(false);
    }
    PENDING.with(|p| *p.borrow_mut() = session.map(|id| (None, id)));
    APPLICATION.with(|value| *value.borrow_mut() = Some(app));
    Ok(true)
}

pub fn setup(app: &tauri::AppHandle) {
    HANDLE.with(|h| *h.borrow_mut() = Some(app.clone()));
    crate::placement::setup(app);
    if let Err(error) = subscribe_notifications(app) {
        eprintln!("Unable to subscribe to desktop notification actions: {error}");
    }
    let app = app.clone();
    let mut previous = None;
    let mut last_services = None;
    glib::timeout_add_local(Duration::from_secs(1), move || {
        if last_services.is_none_or(|at: Instant| at.elapsed() >= Duration::from_secs(30)) {
            app.state::<State>().notifications_available.store(notification_service_available(), Ordering::Release);
            last_services = Some(Instant::now());
        }
        if let Some(window) = app.get_webview_window("dashboard") {
            if authorize_dashboard(&app, &window).is_ok() {
                let state = status(&app, &window);
                let current = (state.focused, state.visible);
                if previous != Some(current) {
                    publish_window_state(&app);
                    previous = Some(current);
                }
            }
        }
        glib::ControlFlow::Continue
    });
}

fn notification_service_available() -> bool {
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else { return false; };
    ["ListNames", "ListActivatableNames"].iter().any(|method| {
        bus.call_sync(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", "org.freedesktop.DBus",
            method, None, None, gio::DBusCallFlags::NONE, 250, gio::Cancellable::NONE).ok()
            .and_then(|value| value.get::<(Vec<String>,)>())
            .is_some_and(|(names,)| names.iter().any(|name| name == "org.freedesktop.Notifications"))
    })
}

pub(crate) fn authorize_selected_dashboard(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<String, String> {
    let origin = app.state::<crate::ConnectionOrigin>().0.lock().unwrap().clone();
    if window.label() != "dashboard" || window.url().map_err(|e| e.to_string())?.origin().ascii_serialization() != origin
        || crate::endpoint_url(&origin).is_err() {
        return Err("Desktop requests are accepted only from the selected Dashboard origin.".into());
    }
    Ok(origin)
}

pub(crate) fn authorize_dashboard(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<String, String> {
    let origin = authorize_selected_dashboard(app, window)?;
    let url = crate::endpoint_url(&origin)?;
    if !crate::native_integration_allowed(&url) {
        return Err("Native desktop integration requires HTTPS or an explicit loopback origin.".into());
    }
    Ok(origin)
}

fn status(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> DesktopStatus {
    let (focused, visible) = window.gtk_window().map(|native| {
        let iconified = native.window().is_some_and(|w| w.state().contains(gtk::gdk::WindowState::ICONIFIED));
        let visible = native.is_visible() && native.is_mapped() && !iconified;
        (native.is_active() && visible, visible)
    }).unwrap_or((false, false));
    DesktopStatus { version: env!("CARGO_PKG_VERSION").into(), focused, visible,
        notifications_available: app.state::<State>().notifications_available.load(Ordering::Acquire),
        tray_available: crate::tray::available(app) }
}

pub(crate) async fn on_ui<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = sender.send(operation(&handle)); }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|error| error.to_string()).and_then(|result| result))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<DesktopStatus, String> {
    on_ui(app, move |app| {
        authorize_dashboard(app, &window)?;
        app.state::<State>().notifications_available.store(notification_service_available(), Ordering::Release);
        Ok(status(app, &window))
    }).await
}

#[tauri::command]
pub async fn desktop_connection_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    on_ui(app, move |app| {
        let origin = authorize_selected_dashboard(app, &window)?;
        crate::connection::confirm(app, &origin)
    }).await
}

pub fn publish_window_state(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("dashboard") {
        if authorize_dashboard(app, &window).is_ok() {
            let state = status(app, &window);
            let payload = serde_json::json!({"focused": state.focused, "visible": state.visible});
            if let Err(error) = window.eval(&format!("window.dispatchEvent(new CustomEvent('runlab:window-state',{{detail:{payload}}}));")) {
                eprintln!("Unable to update desktop window state: {error}");
            }
        }
    }
}

pub fn prepare_origin(app: &tauri::AppHandle, origin: &str) -> Result<(), String> {
    let url = crate::endpoint_url(origin)?;
    let state = app.state::<State>();
    let mut origins = state.origins.lock().unwrap();
    if !origins.iter().any(|existing| existing == origin) {
        let capability = tauri::ipc::CapabilityBuilder::new(format!("desktop-ui-{}", origins.len()))
            .local(false).window("dashboard").remote(format!("{origin}/*"));
        let capability = if crate::native_integration_allowed(&url) {
            capability.permission("allow-desktop-ui").permission("allow-application-debug")
        } else {
            capability.permission("allow-window-control").permission("allow-connection-ready")
        };
        app.add_capability(capability).map_err(|e| e.to_string())?;
        origins.push(origin.to_owned());
    }
    drop(origins);
    Ok(())
}

pub fn connected(app: &tauri::AppHandle, origin: &str) -> Result<(), String> {
    prepare_origin(app, origin)?;
    let handle = app.clone();
    app.run_on_main_thread(move || route(&handle, true)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn route_pending(app: &tauri::AppHandle) {
    route(app, false);
}

fn route(app: &tauri::AppHandle, force_navigation: bool) {
    let pending = PENDING.with(|p| p.borrow().clone());
    let Some((expected_origin, id)) = pending else { return; };
    let origin = app.state::<crate::ConnectionOrigin>().0.lock().unwrap().clone();
    let Some(window) = app.get_webview_window("dashboard") else {
        crate::tray::show_launcher(app);
        return;
    };
    if crate::endpoint_url(&origin).is_err() { return; }
    if expected_origin.as_deref().is_some_and(|expected| expected != origin) {
        PENDING.with(|p| *p.borrow_mut() = None);
        crate::tray::show_launcher(app);
        return;
    }
    if !force_navigation { crate::tray::reveal(&window); }
    let current_origin = window.url().map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    if current_origin == origin && !force_navigation {
        let value = serde_json::to_string(&id).unwrap();
        if let Err(error) = window.eval(&format!(
            "(()=>{{const sessionId={value};const u=new URL(location.href);u.searchParams.set('desktopSession',sessionId);history.replaceState(history.state,'',u);window.dispatchEvent(new CustomEvent('runlab:navigate-session',{{detail:{{sessionId}}}}));}})()"
        )) {
            eprintln!("Unable to open desktop session: {error}");
            return;
        }
    } else if let Ok(url) = tauri::Url::parse(&format!("{origin}/?desktopSession={id}")) {
        if let Err(error) = window.navigate(url) {
            eprintln!("Unable to navigate to desktop session: {error}");
            return;
        }
    }
    PENDING.with(|p| *p.borrow_mut() = None);
}

fn badge(app: &tauri::AppHandle, activity: Activity) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("runlab") else { return Ok(()); };
    let icon = app.default_window_icon().ok_or("Missing desktop tray icon")?;
    let mut rgba = icon.rgba().to_vec();
    if activity != Activity::Idle {
        let color = match activity {
            Activity::Running => [59, 130, 246, 255], Activity::Attention => [245, 158, 11, 255],
            Activity::Completed => [34, 197, 94, 255], Activity::Idle => unreachable!(),
        };
        let (w, h) = (icon.width() as i32, icon.height() as i32);
        let radius = w.min(h) / 5;
        for y in (h - radius * 2).max(0)..h {
            for x in (w - radius * 2).max(0)..w {
                if (x - (w - radius)).pow(2) + (y - (h - radius)).pow(2) <= radius.pow(2) {
                    let at = ((y * w + x) * 4) as usize;
                    rgba[at..at + 4].copy_from_slice(&color);
                }
            }
        }
    }
    tray.set_icon(Some(tauri::image::Image::new_owned(rgba, icon.width(), icon.height()))).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_ui(app: tauri::AppHandle, window: tauri::WebviewWindow, state: UiState) -> Result<(), String> {
    if [state.running, state.attention, state.completed].iter().any(|count| *count > 100_000) {
        return Err("Invalid bounded desktop activity count.".into());
    }
    on_ui(app, move |app| {
        authorize_dashboard(app, &window)?;
        let data = app.state::<State>();
        let mut previous = data.activity.lock().unwrap();
        if *previous != state.status { badge(app, state.status)?; *previous = state.status; }
        crate::tray::set_status(app, &activity_label(&state))?;
        Ok(())
    }).await
}

fn validate_notice(notice: &Notice) -> Result<(), String> {
    if !valid_bounded_id(&notice.id, 256) || !valid_id(&notice.session_id)
        || notice.title != "Kala" || notice.body.chars().count() > 512
        || notice.body.chars().any(|character| character.is_control() && character != '\n') {
        return Err("Invalid bounded desktop notification.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_notify(app: tauri::AppHandle, window: tauri::WebviewWindow, notification: Notice) -> Result<(), String> {
    validate_notice(&notification)?;
    on_ui(app, move |app| {
        let origin = authorize_dashboard(app, &window)?;
        let notice = notification;
        let data = app.state::<State>();
        let mut delivered = data.delivered.lock().unwrap();
        let key = format!("{origin}:{}", notice.id);
        if delivered.contains(&key) { return Ok(()); }
        let mut rate = data.rate.lock().unwrap();
        while rate.front().is_some_and(|at| at.elapsed() > Duration::from_secs(60)) { rate.pop_front(); }
        if rate.len() >= 30 { return Err("Desktop notification rate limit reached; retry later.".into()); }
        let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).map_err(|error| error.to_string())?;
        let hints = std::collections::HashMap::from([
            ("desktop-entry", "kala-desktop".to_variant()),
            ("suppress-sound", notice.silent.to_variant()),
        ]);
        let reply = bus.call_sync(Some("org.freedesktop.Notifications"), "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications", "Notify",
            Some(&("Kala", 0u32, "kala-desktop", "Kala",
                glib::markup_escape_text(&notice.body).as_str(), vec!["default", "Open Kala"], hints, -1i32).to_variant()),
            None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE).map_err(|error| error.to_string())?;
        let (id,) = reply.get::<(u32,)>().ok_or("Invalid desktop notification response")?;
        let mut notifications = data.notifications.lock().unwrap();
        notifications.push_back((id, origin, notice.session_id));
        if notifications.len() > 256 { notifications.pop_front(); }
        rate.push_back(Instant::now());
        delivered.push_back(key);
        if delivered.len() > 2048 { delivered.pop_front(); }
        Ok(())
    }).await
}

fn subscribe_notifications(app: &tauri::AppHandle) -> Result<(), String> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).map_err(|error| error.to_string())?;
    let handle = app.clone();
    bus.signal_subscribe(Some("org.freedesktop.Notifications"), Some("org.freedesktop.Notifications"),
        None, Some("/org/freedesktop/Notifications"), None, gio::DBusSignalFlags::NONE,
        move |_, _, _, _, signal, parameters| {
            let data = handle.state::<State>();
            if signal == "ActionInvoked" {
                if let Some((id, action)) = parameters.get::<(u32, String)>() {
                    if action != "default" { return; }
                    let target = data.notifications.lock().unwrap().iter().find(|(candidate, _, _)| *candidate == id).cloned();
                    if let Some((_, origin, session)) = target {
                        PENDING.with(|pending| *pending.borrow_mut() = Some((Some(origin), session)));
                        route_pending(&handle);
                    }
                }
            } else if signal == "NotificationClosed" {
                if let Some((id, _)) = parameters.get::<(u32, u32)>() {
                    data.notifications.lock().unwrap().retain(|(candidate, _, _)| *candidate != id);
                }
            }
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_and_bridge_are_bounded_and_cannot_carry_urls_or_actions() {
        assert_eq!(session_link("agent-runlab://session/abc-123"), Some("abc-123".into()));
        for link in ["agent-runlab://session/abc?token=x", "agent-runlab://server/abc", "agent-runlab://session/../abc", "agent-runlab://session/a%2Fb", "https://example.org"] {
            assert!(session_link(link).is_none());
        }
        assert!(!valid_id(&"a".repeat(129)));
        assert!(serde_json::from_str::<Notice>(r#"{"id":"a","sessionId":"b","kind":"complete","body":"secret"}"#).is_err());
        assert!(valid_id("fork.1:branch-2"));
        let valid = Notice { id: "session:42:completed".into(), session_id: "session".into(), title: "Kala".into(), body: "Task completed".into(), silent: true };
        assert!(validate_notice(&valid).is_ok());
        assert!(validate_notice(&Notice { body: "x".repeat(513), ..valid.clone() }).is_err());
        assert!(validate_notice(&Notice { title: "Unexpected".into(), ..valid }).is_err());
    }

    #[test]
    fn public_activity_schema_requires_exact_status_counts_and_fields() {
        for status in ["idle", "running", "attention", "completed"] {
            let value = serde_json::json!({"status": status, "running": 1, "attention": 0, "completed": 0});
            assert!(serde_json::from_value::<UiState>(value).is_ok());
        }
        for value in [
            serde_json::json!({"status": "working", "running": 1, "attention": 0, "completed": 0}),
            serde_json::json!({"status": "idle", "running": -1, "attention": 0, "completed": 0}),
            serde_json::json!({"status": "idle", "running": 0.5, "attention": 0, "completed": 0}),
            serde_json::json!({"status": "idle", "running": 0, "attention": 0}),
            serde_json::json!({"status": "idle", "running": 0, "attention": 0, "completed": 0, "notification": null}),
        ] {
            assert!(serde_json::from_value::<UiState>(value).is_err());
        }
    }

    #[test]
    fn notification_identifiers_and_plain_body_obey_public_boundaries() {
        let notice = Notice {
            id: "a".repeat(256), session_id: "b".repeat(128),
            title: "Kala".into(), body: "x".repeat(512), silent: true,
        };
        assert!(validate_notice(&notice).is_ok());
        assert!(validate_notice(&Notice { id: "a".repeat(257), ..notice.clone() }).is_err());
        assert!(validate_notice(&Notice { session_id: "b".repeat(129), ..notice.clone() }).is_err());
        for id in ["", "-leading", "with space", "with/slash", "https://origin", "a?token=b", "a#fragment"] {
            assert!(validate_notice(&Notice { id: id.into(), ..notice.clone() }).is_err());
        }
        assert!(validate_notice(&Notice { id: "a.b:c_-1".into(), ..notice.clone() }).is_ok());
        assert!(validate_notice(&Notice { body: "line one\nline two".into(), ..notice.clone() }).is_ok());
        assert!(validate_notice(&Notice { body: "control\u{1}".into(), ..notice }).is_err());
    }
}
