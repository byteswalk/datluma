//! 命令行提供方：在空的临时目录里运行智能体命令行，提示词写进标准输入，读标准输出。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use datluma_core::{Error, Result, msg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// 按空白拆分命令行，支持双引号和单引号包住含空格的参数。不经过 shell。
pub(crate) fn split(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            None => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// 在 PATH 里找程序。Windows 上 npm 装的命令行是 `.cmd`，标准库只会补 `.exe`，所以按 PATHEXT 自己找。
fn resolve(program: &str) -> Option<PathBuf> {
    let p = Path::new(program);
    if p.components().count() > 1 {
        return p.is_file().then(|| p.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into());
        if p.extension().is_some() {
            vec![String::new()]
        } else {
            pathext.split(';').filter(|e| !e.is_empty()).map(str::to_owned).collect()
        }
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .find_map(|dir| exts.iter().map(|e| dir.join(format!("{program}{e}"))).find(|c| c.is_file()))
}

pub(crate) async fn run(command: &str, input: &str, timeout: Duration) -> Result<String> {
    let parts = split(command);
    let (program, args) = parts.split_first().ok_or_else(|| Error::invalid(msg!("ai.command_required")))?;
    let exe = resolve(program).ok_or_else(|| Error::invalid(msg!("ai.cli_not_found", program = program)))?;
    let dir = std::env::temp_dir().join(format!("datluma-ai-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| Error::internal(msg!("ai.cli_failed", detail = e)))?;
    let result = run_in(&exe, args, &dir, input, timeout).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn run_in(exe: &Path, args: &[String], dir: &Path, input: &str, timeout: Duration) -> Result<String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // 桌面版没有控制台，避免弹出黑框
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| Error::internal(msg!("ai.cli_failed", detail = e)))?;
    let mut stdin = child.stdin.take().expect("stdin piped");
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let input = input.to_owned();
    let work = async move {
        // 先写完再关闭标准输入，同时读输出，避免管道写满互相等待
        let writer = async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            drop(stdin);
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (_, o, e) = tokio::join!(writer, stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        o.and(e).map_err(|e| Error::internal(msg!("ai.cli_failed", detail = e)))?;
        let status = child.wait().await.map_err(|e| Error::internal(msg!("ai.cli_failed", detail = e)))?;
        Ok::<_, Error>((status, out, err))
    };
    let (status, out, err) = tokio::time::timeout(timeout, work).await.map_err(|_| Error::Timeout)??;
    if !status.success() {
        let detail = crate::excerpt(&String::from_utf8_lossy(&err), 300);
        let code = status.code().map(|c| c.to_string()).unwrap_or_default();
        return Err(Error::internal(msg!("ai.cli_exit", code = code, detail = detail)));
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_quotes() {
        assert_eq!(split(r#"claude -p --x "a b" 'c d'"#), ["claude", "-p", "--x", "a b", "c d"]);
        assert!(split("   ").is_empty());
        assert_eq!(split(r#"x """#), ["x", ""]);
    }

    #[tokio::test]
    async fn missing_program() {
        let err = run("datluma-no-such-cli", "x", Duration::from_secs(5)).await.unwrap_err();
        assert!(matches!(err, Error::Invalid { .. }), "{err:?}");
    }
}
