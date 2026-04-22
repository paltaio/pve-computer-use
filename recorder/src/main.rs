use std::process::ExitCode;

use anyhow::Result;
use clap::Parser;
use pve_record::{args::Args, init_logging, run, RunFailure};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<ExitCode> {
    let args = Args::parse();
    init_logging(args.verbose);

    match run(args).await {
        Ok(code) => Ok(code),
        Err(RunFailure::Preflight(message)) => {
            eprintln!("{message}");
            Ok(ExitCode::from(2))
        }
        Err(RunFailure::Dirty(message)) => {
            eprintln!("{message}");
            Ok(ExitCode::from(3))
        }
        Err(RunFailure::Internal(error)) => Err(error),
    }
}
