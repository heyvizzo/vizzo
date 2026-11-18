# Claude Code 2.1.327 edit evidence

These are paired assistant and user events from three separate Claude Code sessions running Haiku against dummy files in a temporary directory. The sessions used stream-json input and output, `--restricted`, `--safe-mode`, `--strict-mcp-config`, `--permission-mode acceptEdits`, and `--no-session-persistence`. Only the Edit and Write calls shown here were retained. The capture replaces the directory and session identifiers and omits unrelated event metadata. It keeps the tool calls, result attachments, and tool call IDs.

| File | Bytes before the call (decoded as UTF-8) | Bytes after the call | Reported evidence |
| --- | --- | --- | --- |
| `lf.txt` | `header\norange café\nfooter\n` | `header\nblue thé\nfooter\n` | Edit reported the original and a patch with LF line endings |
| `crlf.txt` | `header\r\norange café\r\nfooter\r\n` | `header\r\nblue thé\r\nfooter\r\n` | Edit reported the same original and patch as for `lf.txt` |
| `mixed.txt` | `header\norange café\r\nfooter\n` | `header\nblue thé\nfooter\n` | Edit reported the same original and patch as for `lf.txt` |
| `no-final.txt` | `header\norange café` | `header\nblue thé` | Edit patch included the missing-final-newline marker |
| `rewrite.txt` | `prior café\r\n` | `new café\n` | Write reported `type: "update"` with an LF-normalized original |
| `new.txt` | absent | `crée\n` | Write reported `type: "create"`, `originalFile: null`, and matching `content` |
| `empty.txt` | absent | empty file | Write reported `type: "create"`, `originalFile: null`, and `content: ""` |
| `unread.txt` | `existing unread file\n` | `existing unread file\n` | Write reported `is_error: true` because the existing file had not been read |

The CLI exposed Edit, Read, and Write when the requested tools were `Read,Edit,Write,MultiEdit`. The fixture tests construct repeated completions, reconnect replay, and malformed events from these captures. They also exercise literal CRLF in a synthetic create result. In the live capture the model sent LF in its Write arguments when asked to create a CRLF file.
