#!/usr/bin/env bash
# GitHub runner prerequisite; deployment does not invoke this helper.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'CJK fonts: GitHub runner required' >&2; exit 2; }
export LC_ALL=C
apt_common=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1)
apt_source=()
font_version=''
font_tmp=''
trap 'if [[ -n "$font_tmp" ]]; then rm -rf -- "$font_tmp"; fi' EXIT

download_fonts() {
  timeout --kill-after=5s 60s sudo -n apt-get "${apt_common[@]}" "${apt_source[@]}" update --error-on=any -qq || return $?
  font_version=$(apt-cache "${apt_source[@]}" policy fonts-noto-cjk | awk '/Candidate:/ {print $2; exit}') || return $?
  [[ -n "$font_version" && "$font_version" != '(none)' ]] || return 1
  timeout --kill-after=5s 120s sudo -n apt-get "${apt_common[@]}" "${apt_source[@]}" install -y --no-install-recommends --download-only "fonts-noto-cjk=$font_version" || return $?
}

if ! download_fonts; then
  echo 'CJK fonts: primary download failed; retry once with official Ubuntu sources' >&2
  font_tmp=$(mktemp -d "${RUNNER_TEMP:?}/oc-cjk-fonts.XXXXXX")
  chmod 755 "$font_tmp"
  python3 - "$font_tmp/ubuntu.sources" <<'PY_SOURCES'
from pathlib import Path
import re, sys
source = Path('/etc/apt/sources.list.d/ubuntu.sources').read_text()
allowed = {
    'mirror+file:/etc/apt/apt-mirrors.txt',
    *('https://' + host + '/ubuntu' for host in ('azure.archive.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com')),
    *('http://' + host + '/ubuntu' for host in ('azure.archive.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com')),
}
converted = []
for stanza in re.split(r'\n\s*\n', source.strip()):
    uri = re.search(r'^URIs:[ \t]*(.+)$', stanza, re.M)
    if uri is None or not all(value.rstrip('/') in allowed for value in uri[1].split()):
        continue
    suites = re.search(r'^Suites:[ \t]*(.+)$', stanza, re.M)
    if suites is None or not re.search(r'^Components:[ \t]*\S', stanza, re.M) or not re.search(r'^Signed-By:[ \t]*\S', stanza, re.M):
        raise SystemExit('CJK fonts: incomplete Ubuntu source stanza')
    host = 'security.ubuntu.com' if all(s.endswith('-security') for s in suites[1].split()) else 'archive.ubuntu.com'
    converted.append(re.sub(r'^URIs:.*$', 'URIs: https://' + host + '/ubuntu', stanza, flags=re.M))
if not converted:
    raise SystemExit('CJK fonts: no supported Ubuntu sources')
Path(sys.argv[1]).write_text('\n\n'.join(converted) + '\n')
PY_SOURCES
  apt_source=(-o "Dir::Etc::sourcelist=$font_tmp/ubuntu.sources" -o Dir::Etc::sourceparts=-)
  download_fonts
fi

timeout --kill-after=5s 60s sudo -n apt-get "${apt_common[@]}" "${apt_source[@]}" install -y --no-install-recommends --no-download "fonts-noto-cjk=$font_version"
[[ $(dpkg-query -W -f='${db:Status-Status}' fonts-noto-cjk) == installed ]]
[[ $(dpkg-query -W -f='${Version}' fonts-noto-cjk) == "$font_version" ]]
family=$(fc-match --format '%{family}' 'Noto Sans CJK SC:lang=zh-cn')
[[ "$family" == *'Noto Sans CJK SC'* ]]
printf 'CJK_FONTS_READY version=%s\n' "$font_version"
