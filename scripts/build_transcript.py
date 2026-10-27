#!/usr/bin/env python3
"""Turn a Claude Code session log (.jsonl) into transcript.md and a standalone, collapsible transcript.html.

Usage: python3 scripts/build_transcript.py <session.jsonl> [out_dir=docs]

* A "turn" is one human interaction (typed prompt, queued mid-turn message, or `!` shell command).
* Everything Claude did until the next turn (text + one-line tool summaries) goes in a collapsed block.
* System noise (reminders, task notifications, tool results) is dropped. Secrets are redacted.
"""
import html, json, re, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Redaction rules are generic: nothing personal is hard-coded here. The home directory and
# username come from the machine running the script, the app token from the local .token file.
HOME = Path.home()
RULES = []  # (compiled regex, replacement string or function)
tok = ROOT / '.token'
if tok.exists() and tok.read_text().strip():
    RULES.append((re.compile(re.escape(tok.read_text().strip())), '[REDACTED-TOKEN]'))
RULES += [
    (re.compile(re.escape(str(HOME))), '~'),
    (re.compile(r'/(?:Users|home)/[A-Za-z0-9._-]+'), '~'),  # any other home dir
    (re.compile(r'(?<![\w-])' + re.escape(HOME.name) + r'(?![\w-])'), '[user]'),  # bare username
    (re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+'), lambda m: m.group(0) if m.group(0).endswith('@anthropic.com') else '[email]'),
    (re.compile(r'(?<=\.)[a-z0-9-]+(?=\.workers\.dev)'), '[account]'),  # <app>.<account>.workers.dev
    (re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'), '[uuid]'),  # db / version / org ids
    (re.compile(r'session_[A-Za-z0-9]{10,}'), 'session_[id]'),
]


def redact(s):
    for rx, rep in RULES:
        s = rx.sub(rep, s)
    return s


# ---------- parse the session log ----------

NOISE = ('<local-command', '<command-name>', '<command-message>', '<system-reminder>', '<task-notification>')


def clean_user_text(t):
    t = re.sub(r'<system-reminder>.*?</system-reminder>', '', t, flags=re.S).strip()
    return t


def tool_summary(b):
    n, i = b.get('name', 'tool'), b.get('input') or {}
    if n == 'Bash':
        return f"Bash: {i.get('description') or i.get('command', '')[:90]}"
    if n in ('Write', 'Edit', 'Read'):
        return f"{n}: {i.get('file_path', '')}"
    if n == 'Artifact':
        return 'Artifact'
    return n


def parse(path):
    turns, cur = [], None
    for line in open(path):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t, ts = d.get('type'), d.get('timestamp')
        if t == 'user' and not d.get('isMeta'):
            c = d['message']['content']
            if isinstance(c, list):
                if any(b.get('type') == 'tool_result' for b in c):
                    continue
                c = ' '.join(b.get('text', '') for b in c if b.get('type') == 'text')
            m = re.match(r'<bash-input>(.*)</bash-input>', c, re.S)
            if m:
                cur = dict(ts=ts, user='! ' + m.group(1).strip(), out=None, blocks=[])
                turns.append(cur)
                continue
            m = re.match(r'<bash-stdout>(.*?)</bash-stdout>', c, re.S)
            if m:
                if cur is not None:
                    cur['out'] = m.group(1).strip()
                continue
            if c.lstrip().startswith(NOISE):
                continue
            c = clean_user_text(c)
            if c:
                cur = dict(ts=ts, user=c, out=None, blocks=[])
                turns.append(cur)
        elif t == 'attachment' and d['attachment'].get('type') == 'queued_command':
            a = d['attachment']
            if a.get('origin', {}).get('kind') == 'human' and not a['prompt'].startswith('<'):
                cur = dict(ts=a.get('timestamp') or ts, user=a['prompt'].strip(), out=None, blocks=[], queued=True)
                turns.append(cur)
        elif t == 'assistant' and cur is not None:
            for b in d['message']['content']:
                if b.get('type') == 'text' and b['text'].strip():
                    cur['blocks'].append(('text', b['text'].strip()))
                elif b.get('type') == 'tool_use':
                    cur['blocks'].append(('tool', tool_summary(b)))
    return turns


# ---------- tiny markdown -> html ----------

def inline(s):
    s = html.escape(s, quote=False)
    codes = []
    s = re.sub(r'`([^`]+)`', lambda m: codes.append(m.group(1)) or f'\0{len(codes) - 1}\0', s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', s)
    s = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    s = re.sub(r'(?<![">])(https?://[^\s<)]+[^\s<).,;:])', r'<a href="\1" target="_blank" rel="noopener">\1</a>', s)
    return re.sub(r'\0(\d+)\0', lambda m: f'<code>{codes[int(m.group(1))]}</code>', s)


LI = re.compile(r'^(\s*)([-*]|\d+[.)])\s+(.*)$')


def render_list(items):
    """items: list of (indent, ordered, text); builds nested lists by indent."""
    out, stack = [], []  # stack of (indent, tag)
    for ind, ordered, text in items:
        tag = 'ol' if ordered else 'ul'
        while stack and ind < stack[-1][0]:
            out.append(f'</li></{stack.pop()[1]}>')
        if stack and ind == stack[-1][0]:
            out.append('</li>')
        elif not stack or ind > stack[-1][0]:
            out.append(f'<{tag}>')
            stack.append((ind, tag))
        out.append(f'<li>{inline(text)}')
    while stack:
        out.append(f'</li></{stack.pop()[1]}>')
    return ''.join(out)


def md(text):
    lines, out, i = text.split('\n'), [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith('```'):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                buf.append(lines[i]); i += 1
            i += 1
            out.append(f'<pre><code>{html.escape(chr(10).join(buf))}</code></pre>')
        elif re.match(r'^#{1,6}\s', ln):
            lvl = min(len(ln) - len(ln.lstrip('#')) + 2, 6)
            out.append(f'<h{lvl}>{inline(ln.lstrip("#").strip())}</h{lvl}>'); i += 1
        elif re.match(r'^\s*---+\s*$', ln):
            out.append('<hr>'); i += 1
        elif '|' in ln and i + 1 < len(lines) and re.match(r'^\s*\|?[\s:|-]+\|[\s:|-]*$', lines[i + 1]):
            cells = lambda r: [c.strip() for c in r.strip().strip('|').split('|')]
            head = cells(ln); i += 2
            rows = []
            while i < len(lines) and '|' in lines[i]:
                rows.append(cells(lines[i])); i += 1
            out.append('<div class="tbl"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>'
                       + ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows) + '</tbody></table></div>')
        elif ln.startswith('>'):
            buf = []
            while i < len(lines) and lines[i].startswith('>'):
                buf.append(lines[i].lstrip('> ')); i += 1
            out.append(f'<blockquote>{inline(" ".join(buf))}</blockquote>')
        elif LI.match(ln):
            items = []
            while i < len(lines):
                m = LI.match(lines[i])
                if m:
                    items.append((len(m.group(1)), m.group(2)[0].isdigit(), m.group(3))); i += 1
                elif lines[i].strip() and lines[i].startswith('  ') and items:
                    ind, o, t = items[-1]; items[-1] = (ind, o, t + ' ' + lines[i].strip()); i += 1
                else:
                    break
            out.append(render_list(items))
        elif not ln.strip():
            i += 1
        else:
            buf = []
            while i < len(lines) and lines[i].strip() and not LI.match(lines[i]) and not lines[i].strip().startswith(('```', '#', '>')):
                buf.append(lines[i].strip()); i += 1
            out.append(f'<p>{inline(" ".join(buf))}</p>')
    return '\n'.join(out)


# ---------- outputs ----------

def fmt_ts(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).strftime('%d %b %Y, %H:%M UTC')
    except Exception:
        return ''


def to_markdown(turns):
    o = ['# Transcript: Wake Up, Sleeping Beauty', '',
         'Claude Code session, one turn per human interaction. Secrets are redacted.', '']
    for n, t in enumerate(turns, 1):
        o += [f'## Turn {n}' + (f'  ({fmt_ts(t["ts"])})' if t['ts'] else ''), '', '**User:**', '', t['user'], '']
        if t['out']:
            o += ['**Shell output:**', '', '```', t['out'], '```', '']
        o += ['**Claude:**', '']
        for kind, v in t['blocks']:
            o += [v if kind == 'text' else f'*[{v}]*', '']
    return redact('\n'.join(o))


PAGE = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript: Wake Up, Sleeping Beauty</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#6e6e73;--line:#e3e3e6;--field:#f5f5f7;--accent:#000}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#f2f2f4;--muted:#98989f;--line:#2a2a2e;--field:#111113;--accent:#fff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 18px 80px}
h1{font-size:26px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 18px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 22px;position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);z-index:2}
button,.btn{font:inherit;font-size:14px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:6px 12px;border-radius:10px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--field)}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 26px}.toc a{font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:2px 8px;text-decoration:none}
.toc a:hover{color:var(--fg);background:var(--field)}
.turn{margin:0 0 30px;scroll-margin-top:70px}
.turn>h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between;gap:10px}
.turn>h2 span{font-weight:400;letter-spacing:0;text-transform:none}
.user{background:var(--accent);color:var(--bg);border-radius:16px;padding:14px 16px;white-space:pre-wrap;word-wrap:break-word}
.user.cmd{font-family:ui-monospace,Menlo,monospace;font-size:14px}
details.resp{margin-top:10px;border:1px solid var(--line);border-radius:14px}
details.resp>summary{cursor:pointer;padding:10px 14px;font-weight:600;font-size:14px;list-style:none;display:flex;justify-content:space-between;gap:10px}
details.resp>summary::-webkit-details-marker{display:none}
details.resp>summary::before{content:"▸";margin-right:8px;transition:transform .15s;display:inline-block}
details.resp[open]>summary::before{transform:rotate(90deg)}
details.resp>summary small{color:var(--muted);font-weight:400;margin-left:auto}
.body{padding:2px 16px 14px;border-top:1px solid var(--line)}
.body p,.body li{margin:.55em 0}.body h3,.body h4,.body h5{margin:1em 0 .3em}
code{background:var(--field);padding:1px 5px;border-radius:5px;font:13px ui-monospace,Menlo,monospace}
pre{background:var(--field);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto}pre code{background:none;padding:0}
.tool{font:12.5px ui-monospace,Menlo,monospace;color:var(--muted);margin:.35em 0;padding-left:10px;border-left:2px solid var(--line)}
.tbl{overflow:auto}table{border-collapse:collapse;font-size:14px}td,th{border:1px solid var(--line);padding:5px 9px;text-align:left}th{background:var(--field)}
blockquote{margin:.6em 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
details.out{margin-top:8px}details.out summary{cursor:pointer;color:var(--muted);font-size:13px}
.note{color:var(--muted);font-size:13px;border:1px dashed var(--line);border-radius:10px;padding:10px 12px;margin-top:30px}
</style></head><body><main>
<h1>Transcript: Wake Up, Sleeping Beauty</h1>
<p class="sub">__COUNT__ turns, one per human interaction. Click a turn's response to expand it. Secrets are redacted.</p>
<div class="bar"><button id="all">Expand all</button><button id="none">Collapse all</button><a class="btn" href="index.html">&larr; Home</a></div>
<nav class="toc">__TOC__</nav>
__TURNS__
<p class="note">Exported from the Claude Code session log. Tool calls appear as one-line summaries; tool output is omitted for brevity. The final turn's closing message was written after this export and is not included.</p>
</main>
<script>
const ds=()=>document.querySelectorAll('details.resp');
document.getElementById('all').onclick=()=>ds().forEach(d=>d.open=true);
document.getElementById('none').onclick=()=>ds().forEach(d=>d.open=false);
if(location.hash){const t=document.querySelector(location.hash+' details.resp');if(t)t.open=true}
</script></body></html>'''


def to_html(turns):
    toc, parts = [], []
    for n, t in enumerate(turns, 1):
        toc.append(f'<a href="#turn-{n}">{n}</a>')
        is_cmd = t['user'].startswith('! ')
        texts = sum(1 for k, _ in t['blocks'] if k == 'text')
        tools = sum(1 for k, _ in t['blocks'] if k == 'tool')
        body = ''.join(md(v) if k == 'text' else f'<div class="tool">{html.escape(v)}</div>' for k, v in t['blocks'])
        if not body:
            body = '<p><em>(no response text)</em></p>'
        out = f'<details class="out"><summary>Shell output</summary><pre><code>{html.escape(t["out"])}</code></pre></details>' if t['out'] else ''
        parts.append(
            f'<section class="turn" id="turn-{n}"><h2>Turn {n}<span>{fmt_ts(t["ts"])}</span></h2>'
            f'<div class="user{" cmd" if is_cmd else ""}">{html.escape(t["user"])}</div>{out}'
            f'<details class="resp"><summary>Claude\'s response<small>{texts} message(s), {tools} tool call(s)</small></summary>'
            f'<div class="body">{body}</div></details></section>')
    page = PAGE.replace('__COUNT__', str(len(turns))).replace('__TOC__', ''.join(toc)).replace('__TURNS__', '\n'.join(parts))
    return redact(page)


if __name__ == '__main__':
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'docs'
    out.mkdir(parents=True, exist_ok=True)
    turns = parse(src)
    (ROOT / 'transcript.md').write_text(to_markdown(turns))
    (out / 'transcript.html').write_text(to_html(turns))
    print(f'{len(turns)} turns -> transcript.md, {out}/transcript.html')
