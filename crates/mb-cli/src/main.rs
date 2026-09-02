//! `memberberry` — command line entry point.
//!
//! A shim. Everything worth testing lives in the library beside it (`lib.rs`), so it can be
//! exercised without spawning a process; this file only wires real stdin and stdout to it
//! and turns an error into an exit code.

use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let result = if mb_cli::reads_password_from_terminal(&args) {
        run_with_terminal_passwords(&args, &mut out)
    } else {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        mb_cli::run(&args, &mut input, &mut out)
    };
    // A failed flush here is almost always a closed pipe — `memberberry inspect x | head`.
    // Reporting it would turn an ordinary shell idiom into a scary error.
    drop(out.flush());

    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("memberberry: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run_with_terminal_passwords(args: &[String], out: &mut dyn Write) -> Result<ExitCode, String> {
    let password_input = if matches!(args.get(1).map(String::as_str), Some("reset-password")) {
        let admin_password = rpassword::prompt_password("Administrator password: ")
            .map_err(|error| format!("reading administrator password: {error}"))?;
        let new_password = rpassword::prompt_password("New password: ")
            .map_err(|error| format!("reading new password: {error}"))?;
        format!("{admin_password}\n{new_password}").into_bytes()
    } else {
        rpassword::prompt_password("Password: ")
            .map_err(|error| format!("reading password: {error}"))?
            .into_bytes()
    };
    let mut input = password_input.as_slice();
    // The command library deliberately takes an injected reader for tests. The binary is
    // the only caller that owns a terminal, so it supplies the no-echo password here.
    mb_cli::run(args, &mut input, out)
}
