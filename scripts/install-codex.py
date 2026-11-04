#!/usr/bin/env python3
"""Register this checkout, preserving a private backup and other MCP entries."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True, help='Absolute path to Node.js 24+')
parser.add_argument('--config', help='Codex TOML path (default: ~/.codex/config.toml)')
args = parser.parse_args()
node = str(Path(args.node).resolve())
major = int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True))
if major < 24:
    raise SystemExit('Use Node.js 24 or newer.')
root = Path(__file__).resolve().parent.parent
config = Path(args.config).resolve() if args.config else Path.home() / '.codex/config.toml'
config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
text = config.read_text() if config.exists() else ''
parsed = tomllib.loads(text)
for name in ['bambu-printer', 'bambu-printer-ceweldy', 'bambi-a1']:
    # Modify only the main server table, leaving env subtables and other servers intact.
    pattern = rf'(^\[mcp_servers\.(?:{re.escape(name)}|"{re.escape(name)}")\]\s*\n)(.*?)(?=^\[|\Z)'
    if name == 'bambi-a1':
        text = re.sub(pattern, '', text, flags=re.M | re.S)
    else:
        def disable(match):
            body = re.sub(r'^enabled\s*=.*\n?', '', match[2], flags=re.M)
            return match[1] + 'enabled = false\n' + body
        text = re.sub(pattern, disable, text, flags=re.M | re.S)
text = text.rstrip() + '\n\n[mcp_servers.bambi-a1]\n' + \
    f'command = {json.dumps(node)}\nargs = [{json.dumps(str(root / "src/server.mjs"))}]\n' + \
    'startup_timeout_sec = 30\ntool_timeout_sec = 600\n'
tomllib.loads(text)
backup = config.with_name('config.toml.before-bambi-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
if config.exists():
    shutil.copyfile(config, backup)
    os.chmod(backup, 0o600)
temporary = config.with_suffix('.bambi.tmp')
temporary.write_text(text)
os.chmod(temporary, 0o600)
temporary.replace(config)
print('Registered bambi-a1; existing duplicate Bambu entries were disabled in Codex only.')
if backup.exists():
    print('Private configuration backup:', backup)
print('Reload/restart the T3 Codex session to discover the new tools.')
