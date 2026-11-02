//! Trusted native controls. Remote commands can relay/stop, never bind/start.
use crate::{debug_forwarder::{Event, Frame, Group, Reply}, debug_profile::{self as profile, Config, Context}};
use gtk::{glib, prelude::*};
use serde::Deserialize;
use serde_json::json;
use std::{cell::RefCell, path::PathBuf, sync::{Arc, Mutex}};
use tauri::{ipc::Channel, Manager};
use webkit2gtk::{CookieManagerExt, CookiePersistentStorage, DownloadExt, NavigationPolicyDecisionExt, PermissionRequestExt, PolicyDecisionExt, URIRequestExt, WebContextExt, WebViewExt};

#[derive(Default)]
pub struct State(Mutex<Core>);
#[derive(Default)]
struct Core { generation: u64, run: u64, binding: Option<Binding> }
struct Binding { origin: String, context: Option<Context>, channel: Channel<Event>, group: Option<Arc<Group>> }
struct Settings { window: gtk::Window, target: gtk::Label, status: gtk::Label, ports: gtk::Entry, entry: gtk::Entry, scheme: gtk::ComboBoxText, start: gtk::Button }
thread_local! {
    static SETTINGS: RefCell<Option<Settings>> = const { RefCell::new(None) };
    static APPLICATION: RefCell<Option<gtk::Window>> = const { RefCell::new(None) };
}
fn status(message: &str) { SETTINGS.with(|ui| { if let Some(ui) = ui.borrow().as_ref() { ui.status.set_text(message); } }); }
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("application-debug")) }
fn close_application() { let previous = APPLICATION.with(|window| window.borrow_mut().take()); if let Some(window) = previous { window.close(); } }
fn stop(app: &tauri::AppHandle, message: &str) {
    let group = app.state::<State>().0.lock().unwrap().binding.as_mut().and_then(|b| b.group.take());
    if let Some(group) = group { group.stop(); }
    close_application(); status(message);
}
/// Must run on UI thread. Navigation invalidates pending as well as active runs.
pub fn reset(app: &tauri::AppHandle, message: &str) {
    stop(app, message);
    app.state::<State>().0.lock().unwrap().binding = None;
    update_settings(app);
}
fn group_for(app: &tauri::AppHandle, generation: u64) -> Result<Arc<Group>, String> {
    let state = app.state::<State>(); let core = state.0.lock().unwrap();
    if core.generation != generation { return Err("Stale desktop debug generation; no bytes were written. Reopen settings after reconnecting.".into()); }
    core.binding.as_ref().and_then(|b| b.group.clone()).ok_or("No debug group is active. Start explicitly from the native settings window.".into())
}
fn is_current(app: &tauri::AppHandle, group: &Arc<Group>) -> bool {
    group_for(app, group.generation).is_ok_and(|current| Arc::ptr_eq(&current, group))
}
fn update_settings(app: &tauri::AppHandle) {
    let target = { let state = app.state::<State>(); let core = state.0.lock().unwrap(); core.binding.as_ref().and_then(|b| b.context.clone().map(|c| (b.origin.clone(), c))) };
    SETTINGS.with(|ui| { if let Some(ui) = ui.borrow().as_ref() {
        ui.start.set_sensitive(target.is_some());
        if let Some((origin, context)) = target {
            ui.target.set_text(&format!("Server: {origin}\nAccount: {}\nWorkspace: {}\nExecutor: {}\nSession: {}", context.principal_key, context.workspace_id, context.executor_id, context.session_id));
            match root(app).and_then(|dir| profile::load(&dir.join("settings"), &context.scope(&origin))) {
                Ok(saved) => {
                    let config = saved.unwrap_or(Config { ports: vec![5173, 5000], entry_port: 5173, scheme: "http".into() });
                    ui.ports.set_text(&config.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", "));
                    ui.entry.set_text(&config.entry_port.to_string()); ui.scheme.set_active_id(Some(&config.scheme));
                }
                Err(error) => { ui.status.set_text(&error); ui.start.set_sensitive(false); }
            }
        } else { ui.target.set_text("Select an online Workspace Session in the authenticated Dashboard. Waiting for application debugging v1 authorization."); }
    } });
}
pub fn show(app: &tauri::AppHandle) -> Result<(), String> {
    if SETTINGS.with(|ui| { if let Some(ui) = ui.borrow().as_ref() { ui.window.present(); true } else { false } }) { return Ok(()) }
    let window = gtk::Window::new(gtk::WindowType::Toplevel); window.set_title("Kala — Application debugging"); window.set_default_size(620, 480);
    let layout = gtk::Box::new(gtk::Orientation::Vertical, 10); layout.set_border_width(18);
    let target = gtk::Label::new(None); target.set_xalign(0.0); target.set_line_wrap(true); target.set_selectable(true); layout.pack_start(&target, false, false, 0);
    let description = gtk::Label::new(Some("Manually forward 1–8 same-number loopback ports to the selected Executor. Start is authorized only here. No automatic reconnect or application-request replay. Configuration is saved locally without Kala credentials."));
    description.set_line_wrap(true); description.set_xalign(0.0); layout.pack_start(&description, false, false, 0);
    let ports = gtk::Entry::new(); ports.set_placeholder_text(Some("Ports, e.g. 5173, 5000")); ports.set_max_length(64); layout.pack_start(&ports, false, false, 0);
    let entry = gtk::Entry::new(); entry.set_placeholder_text(Some("Entry port, e.g. 5173")); entry.set_max_length(5); layout.pack_start(&entry, false, false, 0);
    let scheme = gtk::ComboBoxText::new(); scheme.append(Some("http"), "HTTP"); scheme.append(Some("https"), "HTTPS (certificate validation enabled)"); layout.pack_start(&scheme, false, false, 0);
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let start_button = gtk::Button::with_mnemonic("_Start and save"); let stop_button = gtk::Button::with_mnemonic("Sto_p"); let open = gtk::Button::with_mnemonic("_Open application");
    actions.add(&start_button); actions.add(&stop_button); actions.add(&open); layout.pack_start(&actions, false, false, 0);
    let message = gtk::Label::new(Some("Stopped. Review the target and ports before starting.")); message.set_xalign(0.0); message.set_line_wrap(true); message.set_selectable(true); layout.pack_start(&message, false, false, 0);
    window.add(&layout);
    let handle = app.clone(); start_button.connect_clicked(move |_| { if let Err(error) = start(&handle) { status(&error); } });
    let handle = app.clone(); stop_button.connect_clicked(move |_| stop(&handle, "Stopped. All listeners and streams were closed; application requests were not replayed."));
    open.connect_clicked(move |_| { APPLICATION.with(|window| { if let Some(window) = window.borrow().as_ref() { window.present(); } else { status("No application window is running. Start the group explicitly first."); } }); });
    // Closing settings is not closing the Tauri main window or authorizing background work.
    let handle = app.clone(); window.connect_delete_event(move |window, _| { stop(&handle, "Stopped when settings closed."); window.hide(); glib::Propagation::Stop });
    SETTINGS.with(|ui| *ui.borrow_mut() = Some(Settings { window: window.clone(), target, status: message, ports, entry, scheme, start: start_button }));
    update_settings(app); window.show_all(); window.present(); Ok(())
}
fn start(app: &tauri::AppHandle) -> Result<(), String> {
    // A native GTK callback is the ONLY caller of this operation; it is not IPC.
    let config = SETTINGS.with(|ui| -> Result<Config, String> {
        let ui = ui.borrow(); let ui = ui.as_ref().ok_or("Open native debug settings first.")?;
        let ports = ui.ports.text().split(|c: char| c == ',' || c.is_whitespace()).filter(|p| !p.is_empty()).map(|p| p.parse::<u16>().map_err(|_| "Enter numeric ports between 1024 and 65535.".to_owned())).collect::<Result<Vec<_>, _>>()?;
        let config = Config { ports, entry_port: ui.entry.text().parse().map_err(|_| "Enter a numeric entry port from the forwarded group.")?, scheme: ui.scheme.active_id().ok_or("Choose HTTP or HTTPS.")?.to_string() };
        config.validate()?; Ok(config.canonical())
    })?;
    let (generation, run, origin, context, channel) = {
        let state = app.state::<State>(); let mut core = state.0.lock().unwrap();
        let binding = core.binding.as_ref().ok_or("The Dashboard transport is unavailable. Reconnect and select a Session before starting.")?;
        if binding.group.is_some() { return Err("A group is already starting or active. Stop it before changing the configuration.".into()); }
        let context = binding.context.clone().ok_or("The Host has not authorized a target. Check the selected Session, permissions and server version.")?;
        let origin = binding.origin.clone(); let channel = binding.channel.clone();
        core.run += 1; (core.generation, core.run, origin, context, channel)
    };
    let dir = root(app)?; profile::save(&dir.join("settings"), context.scope(&origin), config.clone())?;
    let handle = app.clone();
    let notice = Arc::new(move |message: String, fatal: bool| {
        // Never stop synchronously in an acceptor callback (would self-join).
        let app = handle.clone(); let _ = handle.run_on_main_thread(move || {
            if group_for(&app, generation).is_ok_and(|group| group.run == run) {
                if fatal { stop(&app, &message); } else { status(&message); }
            }
        });
    });
    let group = Group::new(generation, run, config.ports.clone(), Arc::new(move |event| channel.send(event).map_err(|_| "Dashboard debug transport was destroyed. Reconnect and restart explicitly.".into())), notice)?;
    app.state::<State>().0.lock().unwrap().binding.as_mut().ok_or("Debug context changed.")?.group = Some(group.clone());
    status("Starting: local ports reserved; waiting for remote authorization. Not running yet.");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let requested = group.clone();
        let reply = tauri::async_runtime::spawn_blocking(move || requested.request(json!({"op":"start", "ports":requested.ports}))).await.map_err(|e| e.to_string()).and_then(|r| r);
        let app = handle.clone(); let _ = handle.run_on_main_thread(move || {
            if !is_current(&app, &group) { group.stop(); return }
            let result = reply.and_then(|reply| reply.grant_id.ok_or("Host returned no debug grant. Update the Host before restarting.".into()))
                .and_then(|grant| group.activate(grant))
                .and_then(|_| open_application(&app, group.clone(), &dir, &context, &origin, config));
            if let Err(error) = result { stop(&app, &error); }
            else { status(if group.ipv4_only { "Running — IPv4 loopback only; IPv6 is unavailable. Closing either native window stops this group." } else { "Running — IPv4 and IPv6 loopback. Closing either native window stops this group." }); }
        });
    });
    Ok(())
}
fn open_application(app: &tauri::AppHandle, group: Arc<Group>, root: &std::path::Path, context: &Context, origin: &str, config: Config) -> Result<(), String> {
    use webkit2gtk::{NavigationPolicyDecision, PolicyDecisionType, WebContext, WebView, WebsiteDataManager};
    let profile = root.join("applications").join(profile::fingerprint(&(context.scope(origin), &config)));
    let application_root = root.join("applications"); profile::private_dir(&application_root)?;
    if !profile.exists() && std::fs::read_dir(&application_root).map_err(|e| e.to_string())?.count() >= 64 {
        return Err("The isolated application profile limit (64) is reached. Review unused application profiles before adding another; no login data was deleted.".into());
    }
    let data = profile.join("data"); let cache = profile.join("cache"); profile::private_dir(&profile)?; profile::private_dir(&data)?; profile::private_dir(&cache)?;
    let manager = WebsiteDataManager::builder().base_data_directory(data.to_string_lossy()).base_cache_directory(cache.to_string_lossy()).build();
    let context = WebContext::with_website_data_manager(&manager);
    context.cookie_manager().ok_or("Isolated application cookie storage is unavailable; forwarding was stopped.")?
        .set_persistent_storage(&data.join("cookies.sqlite").to_string_lossy(), CookiePersistentStorage::Sqlite);
    context.connect_download_started(|_, download| download.cancel());
    let webview = WebView::with_context(&context);
    webview.connect_permission_request(|_, request| { request.deny(); true });
    let approved = config.clone();
    webview.connect_decide_policy(move |_, decision, kind| {
        if kind == PolicyDecisionType::NewWindowAction { decision.ignore(); return true }
        if kind == PolicyDecisionType::NavigationAction {
            let allowed = decision.downcast_ref::<NavigationPolicyDecision>().and_then(|d| d.navigation_action()).and_then(|a| a.request()).and_then(|r| r.uri()).is_some_and(|url| profile::navigation_allowed(&url, &approved));
            if !allowed { decision.ignore(); return true }
        }
        false
    });
    let window = gtk::Window::new(gtk::WindowType::Toplevel); window.set_title("Kala — Isolated application"); window.set_default_size(1100, 760);
    let layout = gtk::Box::new(gtk::Orientation::Vertical, 0); let refresh = gtk::Button::with_label("Refresh application"); let view = webview.clone(); refresh.connect_clicked(move |_| view.reload());
    layout.pack_start(&refresh, false, false, 0); layout.pack_start(&webview, true, true, 0); window.add(&layout);
    let handle = app.clone(); window.connect_delete_event(move |_, _| { if is_current(&handle, &group) { APPLICATION.with(|slot| { slot.borrow_mut().take(); }); stop(&handle, "Stopped when the application window closed. No application request was replayed."); } glib::Propagation::Proceed });
    // Plain WebKit, not Tauri: no initialization script, IPC handler or capabilities.
    APPLICATION.with(|slot| *slot.borrow_mut() = Some(window.clone()));
    window.show_all(); window.present(); webview.load_uri(&config.url()); Ok(())
}

#[tauri::command]
pub async fn application_debug_begin(app: tauri::AppHandle, window: tauri::WebviewWindow, channel: Channel<Event>) -> Result<u64, String> {
    crate::desktop::on_ui(app, move |app| {
        let origin = crate::desktop::authorize_dashboard(app, &window)?;
        reset(app, "Context changed. Forwarding stopped; review the target and explicitly restart.");
        let state = app.state::<State>(); let mut core = state.0.lock().unwrap();
        core.generation += 1;
        if core.generation > 9_007_199_254_740_991 { return Err("Desktop debug generation limit reached. Restart the desktop.".into()); }
        core.binding = Some(Binding { origin, context: None, channel, group: None }); Ok(core.generation)
    }).await
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    Context { generation: u64, context: Context }, Reply { generation: u64, id: u64, result: Reply },
    Receive { generation: u64, frame: Frame }, Touch { generation: u64, grant_id: String },
    Abort { generation: u64, run: u64, error: String }, Detach { generation: u64 },
    Unavailable { generation: u64, error: String }, Show,
}
#[tauri::command]
pub async fn application_debug(app: tauri::AppHandle, window: tauri::WebviewWindow, request: Request) -> Result<(), String> {
    let job = crate::desktop::on_ui(app, move |app| {
        let origin = crate::desktop::authorize_dashboard(app, &window)?;
        let generation = match &request {
            Request::Context { generation, .. } | Request::Reply { generation, .. } | Request::Receive { generation, .. } | Request::Touch { generation, .. } | Request::Abort { generation, .. } | Request::Detach { generation } | Request::Unavailable { generation, .. } => *generation,
            Request::Show => { show(app)?; return Ok(None) },
        };
        { let state = app.state::<State>(); let core = state.0.lock().unwrap();
          if core.generation != generation || !core.binding.as_ref().is_some_and(|b| b.origin == origin) { return Err("Stale or unavailable debug context. Reconnect before restarting; no application data was written.".into()); } }
        match request {
            Request::Context { context, .. } => {
                context.validate()?;
                { let state = app.state::<State>(); let mut core = state.0.lock().unwrap(); let binding = core.binding.as_mut().unwrap();
                  if binding.context.as_ref().is_some_and(|old| old != &context) { return Err("Changing an authenticated target requires a new native debug generation.".into()); }
                  binding.context = Some(context); }
                update_settings(app);
            }
            Request::Reply { id, result, .. } => group_for(app, generation)?.reply(id, result)?,
            Request::Receive { frame, .. } => return group_for(app, generation)?.prepare(frame),
            Request::Touch { grant_id, .. } => group_for(app, generation)?.touch(&grant_id)?,
            Request::Abort { run, error, .. } => { if error.len() > 2048 { return Err("Oversized debug error rejected.".into()); } if group_for(app, generation)?.run == run { stop(app, &error); } }
            Request::Detach { .. } => reset(app, "Dashboard transport detached. Forwarding stopped; explicitly restart after reconnecting."),
            Request::Unavailable { error, .. } => { if error.len() > 2048 { return Err("Oversized debug error rejected.".into()); } reset(app, &error); }
            Request::Show => unreachable!(),
        }
        Ok(None)
    }).await?;
    // prepare() takes the per-stream bounded slot BEFORE joining the blocking pool.
    if let Some(job) = job { tauri::async_runtime::spawn_blocking(move || job.write()).await.map_err(|e| e.to_string())??; }
    Ok(())
}
