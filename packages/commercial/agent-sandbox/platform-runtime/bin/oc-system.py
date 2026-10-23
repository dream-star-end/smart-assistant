#!/usr/bin/env python3
"""Read trusted, revision-pinned system help without network or user state."""
import argparse
from pathlib import Path
import sys

SELF_ROOT = Path(__file__).resolve().parent.parent
GUIDES = SELF_ROOT / "prompts" / "system-assistant"
TOPICS = ('index', 'account-privacy', 'preferences', 'models', 'sessions-goals', 'projects-files', 'memory-profile', 'skills-market', 'plugins', 'schedules', 'usage-billing', 'sharing-notices', 'collaboration-media', 'organization-admin', 'tasks', 'ui-system-actions', 'ui', 'ui-preview', 'input-prediction')


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog="oc-system", description="按需读取系统操作、设置与智能UI指南（只读帮助）。")
    subparsers = parser.add_subparsers(dest="command")
    skill = subparsers.add_parser("skill", help="读取指南；不带topic列出所有主题")
    skill.add_argument("topic", nargs="?", default="index", choices=TOPICS)
    if not args or args == ["help"]:
        parser.print_help()
        return 0
    options = parser.parse_args(args)
    if options.command != "skill":
        parser.error("需要skill子命令")
    path = GUIDES / ("SKILL.md" if options.topic == "index" else "references/" + options.topic + ".md")
    # Also safe when invoked through the hot current symlink or from an arbitrary cwd.
    if path.is_symlink() or not path.resolve().is_relative_to(GUIDES.resolve()):
        parser.error("指南路径不受信")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        parser.exit(1, "系统指南暂不可用，请使用现有界面或稍后重试。\n")
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
