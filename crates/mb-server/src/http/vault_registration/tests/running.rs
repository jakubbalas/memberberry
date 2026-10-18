//! Actual server timer/index/sync lifecycle, with recovery sweeps disabled as a negative control.
use super::*;

async fn start(
    f: &mut Fixture,
) -> (
    std::net::SocketAddr,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<Result<(), Error>>,
) {
    drop(f._lease.take());
    f.state
        .registration
        .hooks
        .disable_sweeps
        .store(true, Ordering::Relaxed);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral listener");
    let address = listener.local_addr().expect("address");
    let (ready, release) = f.state.registration.hooks.arm(Phase::Serving);
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let state = f.state.clone();
    let task = tokio::spawn(super::super::super::serve_listener(
        state,
        listener,
        async {
            let _ = stopped.await;
        },
    ));
    wait(ready).await;
    release.send(()).expect("serving");
    (address, stop, task)
}
async fn request(
    f: &Fixture,
    address: std::net::SocketAddr,
    action: &str,
    input: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let request = client
        .post(format!(
            "http://{address}/api/v1/vault-locations/projects/{action}"
        ))
        // why: the real fixture already supplies exactly one Content-Type. Reqwest's
        // .header() appends; a second identical field is now correctly refused by E29.
        .headers(f.headers.clone())
        .header(header::CONNECTION, "close")
        .timeout(Duration::from_secs(10))
        .body(input.to_string())
        .build()
        .expect("wire request");
    assert_eq!(
        request
            .headers()
            .get_all(header::CONTENT_TYPE)
            .iter()
            .count(),
        1,
        "running-server positive control must not send ambiguous Content-Type"
    );
    let response = client
        .execute(request)
        .await
        .expect("real signed-session HTTP");
    let status = response.status();
    let body = response.bytes().await.expect("response");
    (status, serde_json::from_slice(&body).expect("JSON"))
}
async fn completed(rx: &mut tokio::sync::mpsc::Receiver<Changes>, path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await.expect("running timer observation") {
                Changes::All => {
                    panic!("recovery sweep cannot substitute for actual enrolled watcher events")
                }
                Changes::Only(paths) if paths.contains(path) => break,
                Changes::Only(_) => {}
            }
        }
    })
    .await
    .expect("actual server maintenance must consume the exact event");
}

#[tokio::test]
async fn running_server_timer_indexes_and_syncs_dynamic_external_roots_without_recovery_sweeps() {
    for new in [false, true] {
        let mut f = Fixture::new();
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        *f.state
            .registration
            .hooks
            .maintenance_completed
            .lock()
            .expect("hook") = Some(tx);
        let (address, stop, task) = start(&mut f).await;
        let input = f.input(new);
        let (status, preview) = request(&f, address, "preview", input.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let mut input = input;
        input["confirmation"] = preview["confirmation"].clone();
        assert_eq!(
            request(&f, address, "register", input).await.0,
            StatusCode::CREATED
        );
        let root = f.dir.path().join(if new {
            "Projects/New"
        } else {
            "Projects/Public"
        });
        let path = root.join("Readme.md");
        std::fs::write(&path, "# AutomaticallyCreated\n").expect("external Markdown create/write");
        completed(&mut rx, &path).await;
        let slug = Slug::parse("project").expect("slug");
        let vault = f
            .state
            .vaults
            .read()
            .expect("vaults")
            .get(&slug)
            .expect("published")
            .clone();
        let user = Username::parse("alice").expect("creator");
        assert!(f.state.may_read_note("project", "Readme.md", &user));
        let canonical = vault.canonical_note("Readme.md").expect("note");
        let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
        f.state
            .security
            .sync
            .subscribe(
                &vault,
                &canonical,
                "Readme.md",
                &user,
                ConnectionId::issue(),
                outbound,
            )
            .expect("actual sync room");
        while inbox.try_recv().is_ok() {}
        std::fs::write(&path, "# AutomaticallyChanged\n").expect("external change");
        completed(&mut rx, &path).await;
        assert!(
            matches!(inbox.try_recv(), Ok(ServerFrame::Update { .. })),
            "normal running timer imports the real watcher change into an actual subscribed sync room"
        );
        let index = f.state.indexes.get(&vault).expect("live index");
        let policy = AccessFile::load(&root).expect("policy");
        let graph = index
            .lock()
            .expect("index")
            .reader(policy.policy(), &user)
            .expect("filtered reader")
            .vault_graph(Some(2000))
            .expect("filtered graph");
        assert!(
            graph
                .nodes
                .iter()
                .any(|node| node.label == "AutomaticallyChanged")
        );
        std::fs::remove_file(&path).expect("external removal");
        completed(&mut rx, &path).await;
        let graph = index
            .lock()
            .expect("index")
            .reader(policy.policy(), &user)
            .expect("filtered reader")
            .vault_graph(Some(2000))
            .expect("filtered graph");
        assert!(
            graph.nodes.is_empty(),
            "exact removal updates the live index without recovery"
        );
        std::fs::write(
            root.join("access.toml"),
            "[[members]]\nuser='spare'\nrole='owner'\n",
        )
        .expect("external policy change");
        completed(&mut rx, &root.join("access.toml")).await;
        assert!(!f.state.may_read_note("project", "Readme.md", &user));
        let signal = f
            .state
            .watchers
            .0
            .lock()
            .expect("watchers")
            .as_ref()
            .expect("running")
            .signal
            .clone();
        stop.send(()).expect("shutdown");
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("bounded complete teardown")
            .expect("join")
            .expect("served");
        assert!(f.state.watchers.0.lock().expect("watchers").is_none());
        assert!(
            std::net::TcpStream::connect(address).is_err(),
            "real serving task/listener stopped"
        );
        let generation = signal.generation();
        std::fs::write(root.join("AfterStop.md"), "# Stopped\n").expect("after stop");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), signal.changed_after(generation))
                .await
                .is_err(),
            "actual lifecycle stopped dynamic delivery"
        );
    }
}

#[tokio::test]
async fn server_shutdown_waits_for_its_inflight_blocking_maintenance_job() {
    let mut f = Fixture::new();
    let (working, finish_work) = f.state.registration.hooks.arm(Phase::Maintenance);
    let (mut stopped, release_stop) = f.state.registration.hooks.arm(Phase::Stopped);
    let (_, stop, task) = start(&mut f).await;
    wait(working).await;
    stop.send(()).expect("request shutdown");
    let premature = tokio::time::timeout(Duration::from_millis(100), &mut stopped)
        .await
        .is_ok();
    finish_work.send(()).expect("finish actual blocking job");
    if !premature {
        wait(stopped).await;
    }
    release_stop.send(()).expect("finish teardown");
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("bounded shutdown")
        .expect("join")
        .expect("served");
    assert!(
        !premature,
        "shutdown must join the actual blocking maintenance job, not detach it by aborting its async waiter"
    );
}
