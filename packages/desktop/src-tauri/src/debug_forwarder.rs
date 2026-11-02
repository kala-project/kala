//! Bounded loopback-only desktop TCP endpoint. No credentials, filesystem or UI.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap, io::{Read, Write}, net::{Shutdown, TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}, mpsc, Arc, Condvar, Mutex},
    thread::{self, JoinHandle}, time::{Duration, Instant},
};

pub const CHUNK: usize = 16 * 1024;
const ACK: Duration = Duration::from_secs(15);
const LEASE: Duration = Duration::from_secs(60);
const IDLE: Duration = Duration::from_secs(600);
static REQUEST: AtomicU64 = AtomicU64::new(1);
static READERS: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply { pub ok: bool, pub error: Option<String>, pub grant_id: Option<String> }
impl Reply {
    fn failed(message: &str) -> Self { Self { ok: false, error: Some(message.into()), grant_id: None } }
}
#[derive(Clone, Serialize)]
pub struct Event { pub generation: u64, pub run: u64, pub id: u64, pub request: Value }
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Frame {
    Data { grant_id: String, stream_id: String, seq: u32, data: String },
    End { grant_id: String, stream_id: String, seq: u32 },
    Close { grant_id: String, stream_id: String },
}
impl Frame {
    fn ids(&self) -> (&str, &str) { match self {
        Self::Data { grant_id, stream_id, .. } | Self::End { grant_id, stream_id, .. } | Self::Close { grant_id, stream_id } => (grant_id, stream_id),
    } }
}
pub fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 80 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') }
pub fn validate_ports(ports: &[u16]) -> Result<(), String> {
    if ports.is_empty() || ports.len() > 8 || ports.iter().any(|port| *port < 1024) || ports.iter().enumerate().any(|(i, port)| ports[..i].contains(port)) {
        return Err("Enter 1–8 unique ports between 1024 and 65535; the same local ports will be reserved.".into());
    }
    Ok(())
}
pub fn reserve(ports: &[u16]) -> Result<(Vec<TcpListener>, bool), String> {
    validate_ports(ports)?;
    let mut listeners = Vec::new(); let mut ipv4_only = false;
    for &port in ports {
        let local = TcpListener::bind(("127.0.0.1", port)).map_err(|error| format!("Cannot reserve local port {port}: {error}. No part of this group remains active. Stop the conflicting service or change the remote application's port; Kala will not remap or terminate it."))?;
        local.set_nonblocking(true).map_err(|error| error.to_string())?; listeners.push(local);
        match TcpListener::bind(("::1", port)) {
            Ok(local) => { local.set_nonblocking(true).map_err(|error| error.to_string())?; listeners.push(local); }
            Err(error) if error.kind() == std::io::ErrorKind::AddrNotAvailable || matches!(error.raw_os_error(), Some(93 | 97)) => ipv4_only = true,
            Err(error) => return Err(format!("Cannot reserve IPv6 loopback port {port}: {error}. All ports from this attempt were released; no remapping was performed.")),
        }
    }
    Ok((listeners, ipv4_only))
}
struct Pending { stream_id: Option<String>, sender: mpsc::SyncSender<Reply> }
struct Stream {
    socket: TcpStream, writer: Mutex<TcpStream>, busy: AtomicBool, input_seq: AtomicU64,
    read_ended: AtomicBool, write_ended: AtomicBool, activity: Mutex<Instant>,
}
pub struct Group {
    pub generation: u64, pub run: u64, pub ports: Vec<u16>, pub ipv4_only: bool,
    alive: AtomicBool, grant: Mutex<Option<String>>, listeners: Mutex<Vec<TcpListener>>,
    acceptors: Mutex<Vec<JoinHandle<()>>>, lifecycle: Mutex<()>, streams: Mutex<HashMap<String, Arc<Stream>>>,
    pending: Mutex<HashMap<u64, Pending>>, clock: Mutex<Instant>, wake: Condvar,
    send: Arc<dyn Fn(Event) -> Result<(), String> + Send + Sync>,
    notice: Arc<dyn Fn(String, bool) + Send + Sync>,
}
impl Group {
    pub fn new(generation: u64, run: u64, ports: Vec<u16>, send: Arc<dyn Fn(Event) -> Result<(), String> + Send + Sync>, notice: Arc<dyn Fn(String, bool) + Send + Sync>) -> Result<Arc<Self>, String> {
        let (listeners, ipv4_only) = reserve(&ports)?;
        Ok(Arc::new(Self { generation, run, ports, ipv4_only, alive: AtomicBool::new(true), grant: Mutex::new(None), listeners: Mutex::new(listeners), acceptors: Mutex::new(Vec::new()), lifecycle: Mutex::new(()), streams: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()), clock: Mutex::new(Instant::now()), wake: Condvar::new(), send, notice }))
    }
    pub fn alive(&self) -> bool { self.alive.load(Ordering::Acquire) }
    pub fn grant_id(&self) -> Option<String> { self.grant.lock().unwrap().clone() }
    pub fn stream_count(&self) -> usize { self.streams.lock().unwrap().len() }
    fn emit(&self, id: u64, request: Value) -> Result<(), String> { (self.send)(Event { generation: self.generation, run: self.run, id, request }) }
    pub fn request(&self, request: Value) -> Result<Reply, String> {
        let id = REQUEST.fetch_add(1, Ordering::Relaxed);
        if id > 9_007_199_254_740_991 { return Err("Debug request identity limit reached. Restart the desktop.".into()); }
        let (sender, receiver) = mpsc::sync_channel(1);
        let stream_id = request.get("frame").and_then(|frame| frame.get("streamId")).and_then(Value::as_str).map(str::to_owned);
        { let mut pending = self.pending.lock().unwrap();
          if !self.alive() || pending.len() >= 33 { return Err("Forwarding stopped or its bounded request limit was reached. Restart it explicitly.".into()); }
          pending.insert(id, Pending { stream_id, sender }); }
        if let Err(error) = self.emit(id, request) { self.pending.lock().unwrap().remove(&id); return Err(error); }
        let result = receiver.recv_timeout(ACK);
        self.pending.lock().unwrap().remove(&id);
        let reply = result.map_err(|_| "Debug acknowledgement timed out. The application request may already have executed; inspect its state before retrying.".to_owned())?;
        if reply.ok { Ok(reply) } else { Err(reply.error.unwrap_or_else(|| "Debug request failed. Check forwarding and application state before retrying.".into())) }
    }
    pub fn reply(&self, id: u64, reply: Reply) -> Result<(), String> {
        if reply.error.as_ref().is_some_and(|error| error.len() > 2048) { return Err("Oversized debug error was rejected.".into()); }
        let pending = self.pending.lock().unwrap().remove(&id).ok_or("Stale debug acknowledgement was ignored.")?;
        pending.sender.try_send(reply).map_err(|_| "Debug request is no longer waiting; it was not replayed.".into())
    }
    pub fn touch(&self, grant_id: &str) -> Result<(), String> {
        if !self.alive() || self.grant_id().as_deref() != Some(grant_id) { return Err("Forwarding authorization is no longer active.".into()); }
        *self.clock.lock().unwrap() = Instant::now(); self.wake.notify_all(); Ok(())
    }
    fn mark_closed(&self, error: Option<String>) {
        if !self.alive.swap(false, Ordering::AcqRel) { return }
        // Pair notification with the predicate mutex: otherwise stop can race
        // between a watchdog's alive check and wait, retaining its thread/Arc.
        { let _clock = self.clock.lock().unwrap(); self.wake.notify_all(); }
        for (_, pending) in self.pending.lock().unwrap().drain() { let _ = pending.sender.try_send(Reply::failed("Forwarding stopped. The application request may already have executed; inspect its state before retrying.")); }
        for (_, stream) in self.streams.lock().unwrap().drain() { let _ = stream.socket.shutdown(Shutdown::Both); }
        let _ = self.emit(0, json!({"op":"stop", "grantId":self.grant_id()}));
        if let Some(error) = error { (self.notice)(error, true); }
    }
    pub fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.mark_closed(None);
        self.listeners.lock().unwrap().clear();
        for handle in self.acceptors.lock().unwrap().drain(..) { let _ = handle.join(); }
    }
    pub fn activate(self: &Arc<Self>, grant_id: String) -> Result<(), String> {
        if !valid_id(&grant_id) { return Err("Host returned an invalid debug grant. Update it before restarting.".into()); }
        let outcome = (|| {
            let _lifecycle = self.lifecycle.lock().unwrap();
            if !self.alive() || self.grant_id().is_some() { return Err("This forwarding attempt was cancelled or already activated.".into()); }
            *self.grant.lock().unwrap() = Some(grant_id);
            for listener in self.listeners.lock().unwrap().drain(..) {
                let group = self.clone();
                let handle = thread::Builder::new().name("kala-debug-listener".into()).spawn(move || group.accept(listener)).map_err(|error| error.to_string())?;
                self.acceptors.lock().unwrap().push(handle);
            }
            let group = self.clone();
            thread::Builder::new().name("kala-debug-lease".into()).spawn(move || {
                let mut clock = group.clock.lock().unwrap();
                while group.alive() {
                    let elapsed = clock.elapsed();
                    if elapsed >= LEASE { drop(clock); group.mark_closed(Some("Forwarding authorization expired. Reconnect and explicitly restart it; application bytes were not replayed.".into())); return }
                    clock = group.wake.wait_timeout(clock, LEASE - elapsed).unwrap().0;
                }
            }).map_err(|error| error.to_string())?;
            Ok(())
        })();
        if outcome.is_err() { self.stop() }
        outcome
    }
    fn accept(self: Arc<Self>, listener: TcpListener) {
        let port = match listener.local_addr() { Ok(address) => address.port(), Err(_) => return };
        while self.alive() {
            match listener.accept() {
                Ok((socket, _)) => {
                    if !self.alive() || READERS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| (count < 32).then_some(count + 1)).is_err() { let _ = socket.shutdown(Shutdown::Both); continue }
                    let cloned = socket.try_clone();
                    let stream = match cloned { Ok(writer) => Arc::new(Stream { socket, writer: Mutex::new(writer), busy: AtomicBool::new(false), input_seq: AtomicU64::new(0), read_ended: AtomicBool::new(false), write_ended: AtomicBool::new(false), activity: Mutex::new(Instant::now()) }), Err(_) => { READERS.fetch_sub(1, Ordering::AcqRel); continue } };
                    let stream_id = format!("s{}-{}", self.run, REQUEST.fetch_add(1, Ordering::Relaxed));
                    {
                        let mut streams = self.streams.lock().unwrap();
                        if !self.alive() || streams.len() >= 32 { READERS.fetch_sub(1, Ordering::AcqRel); let _ = stream.socket.shutdown(Shutdown::Both); continue }
                        streams.insert(stream_id.clone(), stream.clone());
                    }
                    let group = self.clone(); let id = stream_id.clone();
                    let worker = thread::Builder::new().name("kala-debug-stream".into()).spawn(move || {
                        struct Slot; impl Drop for Slot { fn drop(&mut self) { READERS.fetch_sub(1, Ordering::AcqRel); } }
                        let _slot = Slot;
                        if let Err(error) = group.read(&id, port, &stream) { if group.alive() { (group.notice)(error, false) }; group.close_stream(&id, true); }
                    });
                    if worker.is_err() { READERS.fetch_sub(1, Ordering::AcqRel); self.close_stream(&stream_id, true); self.mark_closed(Some("Could not create a bounded forwarding worker. Close unused applications and restart forwarding.".into())); return }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => { let guard = self.clock.lock().unwrap(); if self.alive() { drop(self.wake.wait_timeout(guard, Duration::from_millis(50)).unwrap()); } }
                Err(error) => { self.mark_closed(Some(format!("Local debug listener failed: {error}. All forwarding was stopped."))); return }
            }
        }
    }
    fn read(self: &Arc<Self>, stream_id: &str, port: u16, stream: &Arc<Stream>) -> Result<(), String> {
        let grant = self.grant_id().ok_or("Debug grant is not active.")?;
        let frame = |value: Value| json!({"op":"frame", "frame":value});
        self.request(frame(json!({"op":"open", "grantId":grant,"streamId":stream_id,"port":port})))?;
        let mut reader = stream.socket.try_clone().map_err(|error| error.to_string())?;
        reader.set_read_timeout(Some(IDLE)).map_err(|error| error.to_string())?;
        reader.set_write_timeout(Some(ACK)).map_err(|error| error.to_string())?;
        let mut buffer = [0u8; CHUNK]; let mut seq: u32 = 0;
        while self.alive() {
            // Server-push traffic also keeps the duplex stream active. A read
            // timeout alone must not kill an SSE/WebSocket receiving data.
            let remaining = IDLE.saturating_sub(stream.activity.lock().unwrap().elapsed());
            if remaining.is_zero() { return Err("Application connection was idle for 10 minutes. Reopen it after checking forwarding status.".into()); }
            reader.set_read_timeout(Some(remaining)).map_err(|error| error.to_string())?;
            let length = match reader.read(&mut buffer) {
                Ok(length) => length,
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                Err(_) => return Err("Local application connection closed. No bytes were replayed.".into()),
            };
            *stream.activity.lock().unwrap() = Instant::now();
            if length == 0 {
                self.request(frame(json!({"op":"end","grantId":grant,"streamId":stream_id,"seq":seq})))?;
                stream.read_ended.store(true, Ordering::Release); self.finish(stream_id, stream); return Ok(())
            }
            self.request(frame(json!({"op":"data","grantId":grant,"streamId":stream_id,"seq":seq,"data":STANDARD.encode(&buffer[..length])})))?;
            seq = seq.checked_add(1).filter(|seq| *seq <= 2_147_483_647).ok_or("Debug sequence limit reached. Reopen this application connection.")?;
        }
        Err("Forwarding stopped; application requests were not replayed.".into())
    }
    fn finish(&self, stream_id: &str, stream: &Stream) {
        if stream.read_ended.load(Ordering::Acquire) && stream.write_ended.load(Ordering::Acquire) { self.close_stream(stream_id, false); }
    }
    fn close_stream(&self, stream_id: &str, notify: bool) {
        let stream = self.streams.lock().unwrap().remove(stream_id);
        if let Some(stream) = stream { let _ = stream.socket.shutdown(Shutdown::Both); } else { return }
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<_> = pending.iter().filter(|(_, pending)| pending.stream_id.as_deref() == Some(stream_id)).map(|(id, _)| *id).collect();
        for id in ids { if let Some(pending) = pending.remove(&id) { let _ = pending.sender.try_send(Reply::failed("This debug stream was closed. Inspect application state before retrying.")); } }
        drop(pending);
        if notify && self.alive() { let _ = self.emit(0, json!({"op":"frame","frame":{"op":"close","grantId":self.grant_id(),"streamId":stream_id}})); }
    }
    pub fn prepare(self: &Arc<Self>, frame: Frame) -> Result<Option<WriteJob>, String> {
        let (grant_id, stream_id) = frame.ids();
        if !self.alive() || !valid_id(grant_id) || !valid_id(stream_id) || self.grant_id().as_deref() != Some(grant_id) { return Err("Stale or unknown debug grant was rejected without writing application data.".into()); }
        if let Frame::Data { data, .. } = &frame {
            if data.is_empty() || data.len() > CHUNK.div_ceil(3) * 4 { self.close_stream(stream_id, true); return Err("Invalid or oversized desktop frame was rejected before queuing a TCP write.".into()); }
        }
        if matches!(frame, Frame::Close { .. }) { self.close_stream(stream_id, false); return Ok(None) }
        let stream = self.streams.lock().unwrap().get(stream_id).cloned().ok_or("Debug stream is closed or was never opened.")?;
        if stream.busy.swap(true, Ordering::AcqRel) { self.close_stream(stream_id, true); return Err("Concurrent debug writes were rejected and the stream was closed.".into()); }
        Ok(Some(WriteJob { group: self.clone(), stream, frame }))
    }
}
pub struct WriteJob { group: Arc<Group>, stream: Arc<Stream>, frame: Frame }
impl Drop for WriteJob { fn drop(&mut self) { self.stream.busy.store(false, Ordering::Release); } }
impl WriteJob {
    pub fn write(self) -> Result<(), String> {
        let (_, stream_id) = self.frame.ids();
        let operation = || -> Result<(), String> {
            if !self.group.alive() || self.stream.write_ended.load(Ordering::Acquire) { return Err("Debug stream ended before this write; no bytes were replayed.".into()); }
            let mut writer = self.stream.writer.lock().unwrap();
            writer.set_write_timeout(Some(ACK)).map_err(|error| error.to_string())?;
            let seq = match &self.frame { Frame::Data { seq, .. } | Frame::End { seq, .. } => *seq, Frame::Close { .. } => unreachable!() };
            if seq > 2_147_483_647 || self.stream.input_seq.load(Ordering::Acquire) != u64::from(seq) { return Err("Out-of-order desktop write was rejected. Check application state before reconnecting.".into()); }
            match &self.frame {
                Frame::Data { data, .. } => {
                    if data.len() > CHUNK.div_ceil(3) * 4 { return Err("Debug data exceeds 16 KiB; the stream was closed.".into()); }
                    let bytes = STANDARD.decode(data).map_err(|_| "Invalid base64 debug data was rejected.")?;
                    if bytes.is_empty() || bytes.len() > CHUNK || STANDARD.encode(&bytes) != *data { return Err("Invalid or oversized debug data was rejected.".into()); }
                    writer.write_all(&bytes).map_err(|_| "Local TCP write failed. The application request may have been partly received; inspect its state before retrying.")?;
                }
                Frame::End { .. } => { writer.shutdown(Shutdown::Write).map_err(|error| error.to_string())?; self.stream.write_ended.store(true, Ordering::Release); }
                Frame::Close { .. } => unreachable!(),
            }
            *self.stream.activity.lock().unwrap() = Instant::now();
            self.stream.input_seq.fetch_add(1, Ordering::AcqRel);
            Ok(())
        };
        let result = operation();
        if result.is_err() { self.group.close_stream(stream_id, true) } else { self.group.finish(stream_id, &self.stream) }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn free_port() -> u16 { TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port() }
    #[test]
    fn validates_manual_ports_and_never_renumbers_conflicts() {
        for ports in [vec![], vec![80], vec![5173,5173], vec![5000;9]] { assert!(reserve(&ports).is_err()); }
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap(); let second = occupied.local_addr().unwrap().port(); let first = free_port();
        assert!(reserve(&[first,second]).unwrap_err().contains(&second.to_string()));
        assert!(TcpListener::bind(("127.0.0.1", first)).is_ok());
        assert!(occupied.local_addr().is_ok());
    }
    #[test]
    fn stop_releases_all_reserved_ports_before_activation() {
        let port = free_port(); let group = Group::new(1,1,vec![port],Arc::new(|_| Ok(())),Arc::new(|_,_| {})).unwrap();
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err()); group.stop();
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
    #[test]
    fn stop_releases_active_watchdog_and_acceptor_ownership() {
        let port = free_port();
        let group = Group::new(1,4,vec![port],Arc::new(|_| Ok(())),Arc::new(|_,_| {})).unwrap();
        group.activate("grant".into()).unwrap(); let weak = Arc::downgrade(&group);
        group.stop(); drop(group);
        for _ in 0..100 { if weak.upgrade().is_none() { break } thread::sleep(Duration::from_millis(5)); }
        assert!(weak.upgrade().is_none(), "stopped forwarding retained a watchdog or acceptor");
        assert!(TcpListener::bind(("127.0.0.1",port)).is_ok());
    }
    #[test]
    fn cancellation_unblocks_pending_request_and_rejects_late_ack() {
        let port = free_port(); let (tx,rx) = mpsc::sync_channel(1);
        let group = Group::new(1,2,vec![port],Arc::new(move |event| { if event.id != 0 { tx.try_send(event).unwrap(); } Ok(()) }),Arc::new(|_,_| {})).unwrap();
        let request_group = group.clone(); let handle = thread::spawn(move || request_group.request(json!({"op":"start","ports":[port]})));
        let event = rx.recv_timeout(Duration::from_secs(2)).unwrap(); group.stop();
        assert!(handle.join().unwrap().unwrap_err().contains("stopped"));
        assert!(group.reply(event.id, Reply { ok:true,error:None,grant_id:Some("late".into()) }).is_err());
        assert!(group.activate("late".into()).is_err());
    }
    #[test]
    fn real_local_tcp_preserves_binary_and_response_after_client_half_close() {
        let port = free_port(); let (tx, rx) = mpsc::sync_channel(16);
        let group = Group::new(1,3,vec![port],Arc::new(move |event| tx.try_send(event).map_err(|error| error.to_string())),Arc::new(|_,_| {})).unwrap();
        struct Stop(Arc<Group>); impl Drop for Stop { fn drop(&mut self) { self.0.stop(); } }
        let _stop = Stop(group.clone());
        group.activate("grant".into()).unwrap();
        let remote = group.clone();
        let relay = thread::spawn(move || {
            let mut input = Vec::new();
            while let Ok(event) = rx.recv_timeout(Duration::from_secs(3)) {
                if event.request["op"] == "stop" { break }
                let frame = &event.request["frame"];
                if frame["op"] == "data" { input.extend(STANDARD.decode(frame["data"].as_str().unwrap()).unwrap()); }
                if frame["op"] == "end" {
                    let stream_id = frame["streamId"].as_str().unwrap();
                    let output = [b"response:".as_slice(), &input].concat(); let mut seq = 0;
                    for bytes in output.chunks(CHUNK) {
                        remote.prepare(Frame::Data { grant_id:"grant".into(), stream_id:stream_id.into(), seq, data:STANDARD.encode(bytes) }).unwrap().unwrap().write().unwrap(); seq += 1;
                    }
                    remote.prepare(Frame::End { grant_id:"grant".into(), stream_id:stream_id.into(), seq }).unwrap().unwrap().write().unwrap();
                }
                if event.id != 0 { remote.reply(event.id, Reply { ok:true,error:None,grant_id:None }).unwrap(); }
            }
        });
        let mut client = TcpStream::connect(("127.0.0.1",port)).unwrap(); client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let input: Vec<u8> = (0..40_003).map(|i| (i % 251) as u8).collect();
        client.write_all(&input).unwrap(); client.shutdown(Shutdown::Write).unwrap();
        let mut output = Vec::new(); client.read_to_end(&mut output).unwrap();
        assert_eq!(output, [b"response:".as_slice(), &input].concat());
        for _ in 0..100 { if group.stream_count() == 0 { break } thread::sleep(Duration::from_millis(5)); }
        assert_eq!(group.stream_count(),0);
        group.stop(); relay.join().unwrap(); assert!(TcpListener::bind(("127.0.0.1",port)).is_ok());
    }
}
