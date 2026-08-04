//! Regression test for the large-push authentication failure.
//!
//! Git attaches an `authtype` credential only to the request it was filled
//! for. A push whose body exceeds `http.postBuffer` is preceded by a *probe
//! RPC* — a tiny POST git sends deliberately unauthenticated to discover the
//! challenge. Git then erased the credential on that 401 instead of re-filling
//! it, so the pack that followed carried no `Authorization` at all and the push
//! died with a misleading `401`, pointing every investigator at credentials
//! rather than at the probe.
//!
//! The fix is for the helper to answer with `Basic` when the server offers it,
//! because curl handles that scheme natively and attaches it to every request.
//!
//! **Nothing at the unit level catches this.** The helper's reply is correct in
//! isolation and the relay's verification is correct in isolation; the bug lives
//! purely in how git carries one to the other. So this test drives a real `git
//! push` against a stub server and asserts on what actually arrived.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

/// One request as the server saw it.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    chunked: bool,
}

fn pkt(line: &[u8]) -> Vec<u8> {
    let mut out = format!("{:04x}", line.len() + 4).into_bytes();
    out.extend_from_slice(line);
    out
}

/// Serve just enough of the git smart-HTTP protocol to make a push happen,
/// challenging with both schemes exactly as the relay does.
fn serve(listener: TcpListener, seen: Arc<Mutex<Vec<Seen>>>) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { return };
        if !handle(&mut stream, &seen) {
            return;
        }
    }
}

fn handle(stream: &mut TcpStream, seen: &Arc<Mutex<Vec<Seen>>>) -> bool {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return true;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut authorization = None;
    let mut content_length = 0usize;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.to_string()),
            "content-length" => content_length = value.parse().unwrap_or(0),
            "transfer-encoding" => chunked = value.eq_ignore_ascii_case("chunked"),
            _ => {}
        }
    }

    seen.lock().unwrap().push(Seen {
        method: method.clone(),
        path: path.clone(),
        authorization: authorization.clone(),
        chunked,
    });

    // Drain whatever the client sent so the connection stays usable.
    if chunked {
        loop {
            let mut size_line = String::new();
            if reader.read_line(&mut size_line).unwrap_or(0) == 0 {
                break;
            }
            let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
                .unwrap_or(0);
            if size == 0 {
                let mut trailer = String::new();
                let _ = reader.read_line(&mut trailer);
                break;
            }
            let mut body = vec![0u8; size];
            if reader.read_exact(&mut body).is_err() {
                break;
            }
            let mut crlf = [0u8; 2];
            let _ = reader.read_exact(&mut crlf);
        }
    } else if content_length > 0 {
        let mut body = vec![0u8; content_length];
        let _ = reader.read_exact(&mut body);
    }

    if authorization.is_none() {
        // Offer both schemes, as the relay does.
        let response = concat!(
            "HTTP/1.1 401 Unauthorized\r\n",
            "WWW-Authenticate: Nostr realm=\"buzz\", method=\"POST\"\r\n",
            "WWW-Authenticate: Basic realm=\"buzz\"\r\n",
            "Content-Length: 0\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes());
        return true;
    }

    let body = if method == "GET" {
        let mut body = pkt(b"# service=git-receive-pack\n");
        body.extend_from_slice(b"0000");
        let caps = b"report-status delete-refs side-band-64k quiet atomic ofs-delta agent=stub/1.0";
        let mut advert = vec![b'0'; 40];
        advert.extend_from_slice(b" capabilities^{}\0");
        advert.extend_from_slice(caps);
        advert.push(b'\n');
        body.extend_from_slice(&pkt(&advert));
        body.extend_from_slice(b"0000");
        body
    } else {
        let mut body = pkt(b"unpack ok\n");
        body.extend_from_slice(b"0000");
        body
    };
    let content_type = if method == "GET" {
        "application/x-git-receive-pack-advertisement"
    } else {
        "application/x-git-receive-pack-result"
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body);
    true
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "probe")
        .env("GIT_AUTHOR_EMAIL", "probe@test")
        .env("GIT_COMMITTER_NAME", "probe")
        .env("GIT_COMMITTER_EMAIL", "probe@test")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A push big enough to trigger git's probe RPC must authenticate every
/// request it makes — including the probe and the pack that follows it.
#[test]
fn every_request_of_a_large_push_carries_authorization() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let seen = Arc::clone(&seen);
        std::thread::spawn(move || serve(listener, seen));
    }

    let workdir = tempdir();
    git(&workdir, &["init", "--quiet", "--initial-branch=main"]);
    // Comfortably past the tiny `http.postBuffer` set below, so git takes the
    // large-request path rather than buffering.
    std::fs::write(workdir.join("payload.bin"), vec![b'x'; 256 * 1024]).expect("write payload");
    git(&workdir, &["add", "payload.bin"]);
    git(&workdir, &["commit", "--quiet", "-m", "payload"]);

    let key: String = {
        // Any valid key: the stub never verifies the signature, it only records
        // whether a credential arrived.
        let bytes: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(1));
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };

    let helper = env!("CARGO_BIN_EXE_git-credential-nostr").replace('\\', "/");
    let out = Command::new("git")
        .args([
            "-c",
            &format!("credential.helper={helper}"),
            "-c",
            "credential.useHttpPath=true",
            // Force the large-request path: anything above this streams.
            "-c",
            "http.postBuffer=4096",
            "push",
            &format!("http://127.0.0.1:{port}/r.git"),
            "main",
        ])
        .current_dir(&workdir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("NOSTR_PRIVATE_KEY", &key)
        .output()
        .expect("run git push");

    let requests = seen.lock().unwrap().clone();
    let posts: Vec<_> = requests.iter().filter(|r| r.method == "POST").collect();

    assert!(
        !requests.is_empty(),
        "stub server saw no requests at all; git said: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Two POSTs means the probe path was exercised. If git ever stops probing,
    // this test would otherwise keep passing while guarding nothing.
    assert!(
        posts.len() >= 2,
        "expected a probe POST followed by the pack, saw {} POST(s): {requests:#?}",
        posts.len()
    );

    // The regression itself: before the fix, the probe and the pack both went
    // out with no credential.
    let unauthenticated: Vec<_> = posts
        .iter()
        .filter(|r| r.authorization.is_none())
        .map(|r| r.path.as_str())
        .collect();
    assert!(
        unauthenticated.is_empty(),
        "these POSTs carried no Authorization: {unauthenticated:?}\nall requests: {requests:#?}"
    );

    // And it must be the scheme that survives the probe path.
    assert!(
        posts.iter().all(|r| r
            .authorization
            .as_deref()
            .is_some_and(|v| v.starts_with("Basic "))),
        "expected Basic on every POST — authtype credentials do not survive the \
         probe RPC: {requests:#?}"
    );

    // The pack is streamed, which is what made it a "large request" at all.
    assert!(
        posts.iter().any(|r| r.chunked),
        "no chunked POST, so the large-request path was never taken: {requests:#?}"
    );
}

fn tempdir() -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "git-cred-nostr-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).expect("create tempdir");
    base
}
