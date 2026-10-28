#!/usr/bin/env bash
# =============================================================================
# dsh-kodi — provision a REAL local Kodi instance for development and demos
#
# Idempotent and safe to re-run. It performs, in order:
#
#   1. verifies `kodi` is installed            (--install tries pkexec + apt)
#   2. generates the sample video library      (~/Videos/kodi-samples, ffmpeg + .nfo)
#   3. enables Kodi's JSON-RPC web server      (:8080, user/pass kodi/kodi)
#   4. registers the two video sources         (~/.kodi/userdata/sources.xml)
#   5. sets each source's *content type*       (video DB `path` table)
#   6. launches Kodi windowed, scans the library, prints a summary
#
# Why step 5 touches the SQLite database:
#   Kodi has no JSON-RPC method to set a source's content type. Verified on the
#   installed 21.3 with JSONRPC.Introspect: `Files.GetSources` and
#   `VideoLibrary.GetSources` exist, `Files.SetSources` does NOT. A source that
#   is only listed in sources.xml has an empty strContent, and VideoLibrary.Scan
#   then adds nothing to the library (measured: scan finished in 10 ms, 0 files).
#   The `path` table is exactly what Kodi's own "Set content" dialog writes.
#
# Measured facts this script encodes (Kodi 21.3, Ubuntu 26.04, Wayland session):
#   * plain `kodi` auto-selects the NATIVE WAYLAND windowing system and AMD
#     hardware GL; no --windowing flag and no LIBGL_ALWAYS_SOFTWARE are needed;
#   * it starts WINDOWED (GUI.GetProperties fullscreen=false), so it does not
#     take over the desktop; `kodi -fs` reports fullscreen=true;
#   * the web server binds 0.0.0.0:8080 and [::]:8080 (Kodi has no bind-address
#     setting); it is reached over loopback and requires HTTP basic auth;
#   * Kodi's default library exclude regexp `[!-._ \/]sample[-._ \/]` skips any
#     folder whose name contains the word "sample" — hence the TV show here is
#     called "Demo Show", not "Sample Show" (a "Sample Show" folder is silently
#     excluded from the scan).
#
# Usage:
#   scripts/kodi-provision.sh                 # provision / verify, launch, scan
#   scripts/kodi-provision.sh --install       # also install kodi via pkexec
#   scripts/kodi-provision.sh --no-launch     # configure only, leave Kodi stopped
#   scripts/kodi-provision.sh --rescan        # force a library rescan
#   scripts/kodi-provision.sh --force-media   # regenerate the sample videos
#   scripts/kodi-provision.sh --status        # print state, change nothing
#
# Exit: 0 ok | 1 failure | 2 missing prerequisite | 3 kodi not installed
# =============================================================================
set -euo pipefail

# locale-independent numbers for awk/printf (see kodi-live-smoke.sh)
export LC_ALL=C

# ----------------------------------------------------------------------------
# configuration (override with environment variables)
# ----------------------------------------------------------------------------
KODI_PORT=${KODI_PORT:-8080}
KODI_USER=${KODI_USER:-kodi}
KODI_PASS=${KODI_PASS:-kodi}
KODI_SAMPLES=${KODI_SAMPLES:-${HOME}/Videos/kodi-samples}
KODI_DATA=${KODI_DATA:-${HOME}/.kodi}
KODI_LOG=${KODI_LOG:-/tmp/kodi-live.log}
KODI_DISPLAY=${KODI_DISPLAY:-:0}
KODI_WINDOWING=${KODI_WINDOWING:-auto}   # auto|wayland|x11|gbm
KODI_RPC_TIMEOUT=${KODI_RPC_TIMEOUT:-15}
KODI_BOOT_TIMEOUT=${KODI_BOOT_TIMEOUT:-60}
KODI_SCAN_TIMEOUT=${KODI_SCAN_TIMEOUT:-90}
EXPECT_MOVIES=${EXPECT_MOVIES:-6}
EXPECT_EPISODES=${EXPECT_EPISODES:-2}

DO_INSTALL=0
DO_LAUNCH=1
DO_RESCAN=0
DO_MEDIA_FORCE=0
STATUS_ONLY=0
RPC_ID=0

# ----------------------------------------------------------------------------
# logging helpers
# ----------------------------------------------------------------------------
log()  { printf '[provision] %s\n' "$*"; }
warn() { printf '[provision] WARN: %s\n' "$*" >&2; }
die()  { printf '[provision] FAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

for arg in "$@"; do
  case "$arg" in
    --install)     DO_INSTALL=1 ;;
    --no-launch)   DO_LAUNCH=0 ;;
    --rescan)      DO_RESCAN=1 ;;
    --force-media) DO_MEDIA_FORCE=1 ;;
    --status)      STATUS_ONLY=1 ;;
    -h|--help)     sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "unknown argument: $arg (try --help)" 2 ;;
  esac
done

# ----------------------------------------------------------------------------
# session environment — Kodi must attach to the user's existing desktop
# ----------------------------------------------------------------------------
ensure_session_env() {
  export DISPLAY="${DISPLAY:-$KODI_DISPLAY}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR}/wayland-0" ]; then
    export WAYLAND_DISPLAY=wayland-0
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

# ----------------------------------------------------------------------------
# JSON-RPC helpers
# ----------------------------------------------------------------------------
kodi_rpc() { # METHOD [PARAMS_JSON]
  local method=$1 params=${2:-'{}'}
  RPC_ID=$((RPC_ID + 1))
  curl -sS --max-time "$KODI_RPC_TIMEOUT" \
       -u "${KODI_USER}:${KODI_PASS}" \
       -H 'Content-Type: application/json' \
       --data-binary "{\"jsonrpc\":\"2.0\",\"id\":${RPC_ID},\"method\":\"${method}\",\"params\":${params}}" \
       "http://127.0.0.1:${KODI_PORT}/jsonrpc"
}

kodi_up() {
  kodi_rpc 'JSONRPC.Ping' 2>/dev/null | grep -q '"pong"'
}

kodi_total() { # METHOD -> total in result.limits.total (0 when absent)
  local out
  out=$(kodi_rpc "$1" '{"limits":{"start":0,"end":0}}' 2>/dev/null) || { echo 0; return; }
  printf '%s' "$out" | jq -r '.result.limits.total // 0' 2>/dev/null || echo 0
}

KODI_PIDFILE=${KODI_PIDFILE:-/tmp/kodi-dsh.pid}

kodi_pids()    { pgrep -x kodi.bin 2>/dev/null || true; }   # every instance
kodi_running() { [ -n "$(kodi_pids)" ]; }
kodi_pid()     { kodi_pids | head -1; }

wait_for_kodi() {
  local i
  for i in $(seq 1 "$KODI_BOOT_TIMEOUT"); do
    kodi_up && return 0
    sleep 1
  done
  return 1
}

# ----------------------------------------------------------------------------
# step 1 — installation
# ----------------------------------------------------------------------------
ensure_kodi_installed() {
  if command -v kodi >/dev/null 2>&1; then
    log "kodi present: $(kodi --version 2>/dev/null | head -1)"
    return 0
  fi
  if [ "$DO_INSTALL" -ne 1 ]; then
    warn "kodi is not installed."
    warn "Run this once (a polkit dialog appears on the desktop):"
    warn "  pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y kodi"
    warn "or re-run: $0 --install"
    exit 3
  fi
  ensure_session_env
  log "installing kodi via pkexec (approve the polkit dialog on the desktop)…"
  if ! pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y kodi; then
    die "pkexec/apt install failed — run manually:
  pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y kodi" 3
  fi
  command -v kodi >/dev/null 2>&1 || die "kodi still not on PATH after install" 3
  log "kodi installed: $(kodi --version 2>/dev/null | head -1)"
}

# ----------------------------------------------------------------------------
# step 2 — sample media (videos + .nfo metadata)
# ----------------------------------------------------------------------------
# path|lavfi-source|seconds|title|year|plot
MEDIA_SPECS=(
  "Movies/Night Drive (2021).mkv|testsrc2=size=640x360:rate=25|30|Night Drive|2021|Test-pattern movie used by the dsh-kodi playback smoke tests."
  "Movies/Colour Bars (2019).mkv|smptebars=size=640x360:rate=25|20|Colour Bars|2019|SMPTE colour bars sample."
  "Movies/Mandelbrot Zoom (2020).mkv|mandelbrot=size=640x360:rate=25|45|Mandelbrot Zoom|2020|Fractal zoom sample."
  "Movies/Sine Sweep (2018).mkv|rgbtestsrc=size=640x360:rate=25|25|Sine Sweep|2018|RGB test pattern with a sine tone."
  "Movies/Gradient Flow (2022).mkv|gradients=size=640x360:rate=25|40|Gradient Flow|2022|Animated gradient sample."
  "Movies/Clock Face (2017).mkv|testsrc=size=1280x720:rate=30|60|Clock Face|2017|720p test pattern, one full minute."
  "TV/Demo Show/Season 01/Demo Show S01E01.mkv|testsrc2=size=640x360:rate=25|20|Episode 1|2026|Sample episode 1."
  "TV/Demo Show/Season 01/Demo Show S01E02.mkv|gradients=size=640x360:rate=25|35|Episode 2|2026|Sample episode 2."
)

write_movie_nfo() { # file title year plot
  cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>$2</title>
    <originaltitle>$2</originaltitle>
    <year>$3</year>
    <plot>$4</plot>
    <genre>Short</genre>
    <director>dsh-kodi samples</director>
    <studio>local</studio>
    <runtime>1</runtime>
</movie>
EOF
}

write_episode_nfo() { # file title season episode plot
  cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<episodedetails>
    <title>$2</title>
    <season>$3</season>
    <episode>$4</episode>
    <plot>$5</plot>
    <runtime>1</runtime>
</episodedetails>
EOF
}

ensure_media() {
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required to generate the sample media" 2
  local spec out src dur title year plot nfo made=0
  for spec in "${MEDIA_SPECS[@]}"; do
    IFS='|' read -r out src dur title year plot <<<"$spec"
    out="$KODI_SAMPLES/$out"
    nfo="${out%.mkv}.nfo"
    mkdir -p "$(dirname "$out")"
    if [ -f "$out" ] && [ "$DO_MEDIA_FORCE" -ne 1 ]; then
      continue
    fi
    log "encoding $(basename "$out") (${dur}s, $src)"
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "$src" -f lavfi -i "sine=frequency=440:duration=${dur}" \
      -t "$dur" -c:v libx264 -preset ultrafast -crf 34 -pix_fmt yuv420p \
      -c:a aac -b:a 64k -shortest "$out"
    made=$((made + 1))
  done
  # series-level metadata (title comes from here, not from the folder name)
  cat > "$KODI_SAMPLES/TV/Demo Show/tvshow.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
    <title>Demo Show</title>
    <plot>Two-episode sample show generated for dsh-kodi smoke tests.</plot>
    <genre>Short</genre>
    <studio>local</studio>
</tvshow>
EOF
  # per-item metadata (so the library is deterministic and offline)
  local nfo
  for spec in "${MEDIA_SPECS[@]}"; do
    IFS='|' read -r out src dur title year plot <<<"$spec"
    case "$out" in
      TV/*) continue ;;                       # episodes are written just below
    esac
    nfo="$KODI_SAMPLES/${out%.mkv}.nfo"
    if [ "$DO_MEDIA_FORCE" -eq 1 ] || [ ! -f "$nfo" ]; then
      write_movie_nfo "$nfo" "$title" "$year" "$plot"
    fi
  done
  # episode metadata carries the season/episode numbers Kodi needs
  local ep
  for ep in 01 02; do
    nfo="$KODI_SAMPLES/TV/Demo Show/Season 01/Demo Show S01E${ep}.nfo"   # must match the .mkv name
    if [ "$DO_MEDIA_FORCE" -eq 1 ] || [ ! -f "$nfo" ]; then
      write_episode_nfo "$nfo" "Episode $((10#$ep))" 1 "$((10#$ep))" \
                        "Sample episode $((10#$ep)) for dsh-kodi smoke tests."
    fi
  done
  log "sample library ready: $(find "$KODI_SAMPLES" -name '*.mkv' | wc -l) videos, $made newly encoded ($(du -sh "$KODI_SAMPLES" | cut -f1))"
}

# ----------------------------------------------------------------------------
# step 3 — guisettings.xml (JSON-RPC web server + credentials)
# ----------------------------------------------------------------------------
patch_guisettings() {
  mkdir -p "$KODI_DATA/userdata"
  KODI_DATA="$KODI_DATA" KODI_PORT="$KODI_PORT" KODI_USER="$KODI_USER" KODI_PASS="$KODI_PASS" \
  python3 - <<'PY'
import os, sys, xml.etree.ElementTree as ET

path = os.path.join(os.environ['KODI_DATA'], 'userdata', 'guisettings.xml')
want = {
    'services.webserver':               'true',
    'services.webserverport':           os.environ['KODI_PORT'],
    'services.webserverauthentication': 'true',
    'services.webserverusername':       os.environ['KODI_USER'],
    'services.webserverpassword':       os.environ['KODI_PASS'],
}

if os.path.exists(path):
    tree = ET.parse(path)
    root = tree.getroot()
else:
    root = ET.Element('settings', {'version': '2'})
    tree = ET.ElementTree(root)

have = {e.get('id'): e for e in root.findall('setting')}
changed = []
for key, value in want.items():
    el = have.get(key)
    if el is None:
        el = ET.SubElement(root, 'setting', {'id': key})
        el.text = value
        changed.append(key)
    elif (el.text or '') != value:
        el.text = value
        el.attrib.pop('default', None)   # a non-default value is an explicit setting
        changed.append(key)

if changed:
    ET.indent(tree, space='    ')
    tree.write(path, encoding='UTF-8', xml_declaration=True)
    print('guisettings: set ' + ', '.join(changed))
else:
    print('guisettings: already configured')

# honesty check — every id we wrote must be declared by this Kodi build
decl = '/usr/share/kodi/system/settings/settings.xml'
if os.path.exists(decl):
    known = {e.get('id') for e in ET.parse(decl).getroot().iter('setting')}
    unknown = [k for k in want if k not in known]
    if unknown:
        print('guisettings: WARNING ids not declared by this Kodi build: ' + ', '.join(unknown))
PY
}

# ----------------------------------------------------------------------------
# step 4 — sources.xml (the two video sources)
# ----------------------------------------------------------------------------
patch_sources() {
  KODI_DATA="$KODI_DATA" KODI_SAMPLES="$KODI_SAMPLES" python3 - <<'PY'
import os, xml.etree.ElementTree as ET

path = os.path.join(os.environ['KODI_DATA'], 'userdata', 'sources.xml')
samples = os.environ['KODI_SAMPLES']

if os.path.exists(path):
    tree = ET.parse(path)
    root = tree.getroot()
else:
    root = ET.Element('sources')
    for section in ('programs', 'video', 'music', 'pictures', 'files'):
        sec = ET.SubElement(root, section)
        ET.SubElement(sec, 'default', {'pathversion': '1'})
    tree = ET.ElementTree(root)

video = root.find('video')
if video is None:
    video = ET.SubElement(root, 'video')
    ET.SubElement(video, 'default', {'pathversion': '1'})

existing = {(s.findtext('path') or '').rstrip('/') for s in video.findall('source')}
added = []
for name, rel in (('Kodi Samples Movies', 'Movies'), ('Kodi Samples TV', 'TV')):
    uri = os.path.join(samples, rel)
    if uri.rstrip('/') in existing:
        continue
    src = ET.SubElement(video, 'source')
    ET.SubElement(src, 'name').text = name
    ET.SubElement(src, 'path', {'pathversion': '1'}).text = uri + '/'
    ET.SubElement(src, 'allowsharing').text = 'true'
    added.append(uri)

if added:
    ET.indent(tree, space='    ')
    tree.write(path, encoding='UTF-8', xml_declaration=True)
    print('sources.xml: added ' + ', '.join(added))
else:
    print('sources.xml: both sources already registered')
PY
}

# ----------------------------------------------------------------------------
# step 5 — source content types in the video DB (movies / tvshows)
# ----------------------------------------------------------------------------
# Prints one line per source; exit 10 when it changed something (Kodi must then
# be restarted, because it caches the path table in memory).
ensure_content_types() {
  local rc=0
  # writing the DB while Kodi holds it open is what corrupts the library
  if kodi_running; then
    warn "refusing to edit the video database while kodi is running (pids: $(printf '%s ' $(kodi_pids)))"
    return 1
  fi
  KODI_DATA="$KODI_DATA" KODI_SAMPLES="$KODI_SAMPLES" python3 - <<'PY' || rc=$?
import datetime, glob, os, sqlite3, sys

db_dir = os.path.join(os.environ['KODI_DATA'], 'userdata', 'Database')
dbs = [p for p in glob.glob(os.path.join(db_dir, 'MyVideos*.db')) if os.path.isfile(p)]
if not dbs:
    print('db: no MyVideos*.db yet (Kodi must run once to create it)')
    sys.exit(2)

db = max(dbs, key=os.path.getmtime)
print('db: ' + db)

samples = os.environ['KODI_SAMPLES']
want = [(os.path.join(samples, 'Movies') + '/', 'movies', 'metadata.local'),
        (os.path.join(samples, 'TV') + '/',     'tvshows', 'metadata.local')]

con = sqlite3.connect(db)
changed = 0
for path, content, scraper in want:
    row = con.execute('SELECT idPath, strContent, strScraper FROM path WHERE strPath=?',
                      (path,)).fetchone()
    if row and row[1] == content and (row[2] or '') == scraper:
        print('  ok  %-6s %s' % (content, path))
        continue
    if row:
        con.execute('UPDATE path SET strContent=?, strScraper=? WHERE idPath=?',
                    (content, scraper, row[0]))
        print('  set %-6s %s (was content=%r scraper=%r)' % (content, path, row[1], row[2]))
    else:
        con.execute("""INSERT INTO path (strPath, strContent, strScraper, strHash,
                          scanRecursive, useFolderNames, strSettings, noUpdate, exclude,
                          allAudio, dateAdded, idParentPath)
                       VALUES (?, ?, ?, '', 0, 0, '', 0, 0, 0, ?, NULL)""",
                    (path, content, scraper, datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
        print('  add %-6s %s (new path row)' % (content, path))
    changed += 1
con.commit()
con.close()
sys.exit(10 if changed else 0)
PY
  return "$rc"
}

# ----------------------------------------------------------------------------
# Kodi process control
#
# Exactly ONE kodi.bin may run against ~/.kodi: two instances fight over the
# video database and port 8080, and the loser often shows a modal dialog that
# blocks both Application.Quit and SIGTERM. Measured on 2026-10-28: a second
# instance started by another shell left the video DB unusable and made the
# provisioning run fail at its stop step.
# ----------------------------------------------------------------------------
ensure_single_instance() {
  local n
  n=$(kodi_pids | wc -l)
  if [ "$n" -gt 1 ]; then
    warn "$n kodi instances are running — one shared instance only (see docs/KODI-SETUP.md)"
    stop_kodi || die "could not stop the duplicate kodi instances" 1
  elif [ "$n" -eq 1 ] && ! kodi_up; then
    warn "a kodi instance (pid $(kodi_pid)) is running but answers nothing on :${KODI_PORT}"
    warn "stopping it so this script owns the single instance"
    stop_kodi || die "could not stop the unresponsive kodi instance" 1
  fi
  return 0
}

start_kodi() {
  ensure_session_env
  local flags=(--logging=console) pid
  [ "$KODI_WINDOWING" != "auto" ] && flags+=("--windowing=${KODI_WINDOWING}")
  log "starting kodi (${flags[*]}) on DISPLAY=$DISPLAY WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-none}"
  # --logging=console mirrors Kodi's own log to stderr; we keep it for evidence
  setsid nohup kodi "${flags[@]}" >>"$KODI_LOG" 2>&1 </dev/null &
  if ! wait_for_kodi; then
    warn "Kodi did not answer JSON-RPC within ${KODI_BOOT_TIMEOUT}s — last log lines:"
    tail -n 20 "$KODI_LOG" >&2 || true
    return 1
  fi
  pid=$(kodi_pid)
  printf '%s\n' "$pid" >"$KODI_PIDFILE"
  log "kodi up (pid ${pid}, pidfile ${KODI_PIDFILE})"
}

stop_kodi() {
  local pids pid i
  pids=$(kodi_pids)
  if [ -z "$pids" ]; then rm -f "$KODI_PIDFILE"; return 0; fi
  log "stopping kodi (pids: $(printf '%s ' $pids))"
  kodi_rpc 'Application.Quit' >/dev/null 2>&1 || true
  for i in $(seq 1 20); do
    if ! kodi_running; then rm -f "$KODI_PIDFILE"; log "kodi stopped"; return 0; fi
    sleep 0.5
  done
  warn "JSON-RPC quit did not stop kodi (a modal dialog can block it); sending TERM"
  for pid in $(kodi_pids); do kill -TERM "$pid" 2>/dev/null || true; done
  for i in $(seq 1 20); do
    if ! kodi_running; then rm -f "$KODI_PIDFILE"; log "kodi stopped (TERM)"; return 0; fi
    sleep 0.5
  done
  warn "TERM did not stop kodi; sending KILL to $(printf '%s ' $(kodi_pids))"
  for pid in $(kodi_pids); do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 2
  if ! kodi_running; then rm -f "$KODI_PIDFILE"; log "kodi stopped (KILL)"; return 0; fi
  return 1
}

# ----------------------------------------------------------------------------
# step 6 — library scan
# ----------------------------------------------------------------------------
scan_and_wait() {
  log "scanning the video library…"
  kodi_rpc 'VideoLibrary.Scan' '{"showdialogs":false}' >/dev/null
  local i m e
  for i in $(seq 1 "$KODI_SCAN_TIMEOUT"); do
    m=$(kodi_total VideoLibrary.GetMovies)
    e=$(kodi_total VideoLibrary.GetEpisodes)
    if [ "$m" -ge "$EXPECT_MOVIES" ] && [ "$e" -ge "$EXPECT_EPISODES" ]; then
      log "scan complete: $m movies, $e episodes (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  warn "scan did not reach $EXPECT_MOVIES movies / $EXPECT_EPISODES episodes (got $m / $e)"
  warn "hint: check '$KODI_LOG' for VideoInfoScanner lines, and note that Kodi"
  warn "      excludes folders matching [!-._ \\/]sample[-._ \\/] by default"
  return 1
}

# ----------------------------------------------------------------------------
# summary
# ----------------------------------------------------------------------------
print_summary() {
  local version counts fs pid
  version=$(kodi_rpc 'Application.GetProperties' '{"properties":["version"]}' \
            | jq -r 'if .result then "\(.result.version.major).\(.result.version.minor) (tag=\(.result.version.tag), rev=\(.result.version.revision))" else "unknown" end')
  counts=$(printf 'movies=%s tvshows=%s episodes=%s' \
            "$(kodi_total VideoLibrary.GetMovies)" \
            "$(kodi_total VideoLibrary.GetTVShows)" \
            "$(kodi_total VideoLibrary.GetEpisodes)")
  fs=$(kodi_rpc 'GUI.GetProperties' '{"properties":["fullscreen"]}' \
       | jq -r 'if .result.fullscreen == null then "unknown" else (.result.fullscreen|tostring) end')
  pid=$(cat "$KODI_PIDFILE" 2>/dev/null || true)
  [ -n "$pid" ] || pid=$(kodi_pid || true)
  cat <<EOF

[provision] ------------------------------------------------
  kodi          ${version}
  endpoint      http://127.0.0.1:${KODI_PORT}/jsonrpc  (basic auth ${KODI_USER}:***)
  pid           ${pid:-not running}
  window        fullscreen=${fs} at idle (windowed; playback takes the screen)
  library       ${counts}
  samples       ${KODI_SAMPLES}
  kodi log      ${KODI_DATA}/temp/kodi.log  (console copy: ${KODI_LOG})
  next          scripts/kodi-live-smoke.sh
[provision] ------------------------------------------------
EOF
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
main() {
  local m i
  ensure_session_env

  if [ "$STATUS_ONLY" -eq 1 ]; then
    command -v kodi >/dev/null 2>&1 || die "kodi is not installed" 3
    if ! kodi_up; then
      log "kodi is installed but not running (no JSON-RPC answer on :${KODI_PORT})"
      exit 1
    fi
    print_summary
    exit 0
  fi

  for cmd in curl jq python3; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing prerequisite: $cmd" 2
  done

  ensure_kodi_installed
  ensure_media
  patch_guisettings
  patch_sources
  ensure_single_instance

  # 1st pass: make sure Kodi runs so the video DB exists
  if ! kodi_up; then
    [ "$DO_LAUNCH" -eq 1 ] || { log "kodi is not running and --no-launch was given"; exit 0; }
    start_kodi
  fi

  # already populated? then only rescan when asked
  m=$(kodi_total VideoLibrary.GetMovies)
  i=$(kodi_total VideoLibrary.GetEpisodes)
  if [ "$m" -ge "$EXPECT_MOVIES" ] && [ "$i" -ge "$EXPECT_EPISODES" ] && [ "$DO_RESCAN" -ne 1 ]; then
    log "library already populated (movies=$m episodes=$i) — nothing to do"
    print_summary
    exit 0
  fi

  # content types are only writable with Kodi stopped (DB cache) and only exist
  # after the first run, so: stop -> patch -> start -> scan
  log "ensuring source content types (needs kodi stopped)"
  stop_kodi
  local rc=0
  ensure_content_types || rc=$?
  if [ "$rc" -eq 2 ]; then
    warn "no video database yet — starting kodi once to create it"
    start_kodi
    stop_kodi
    rc=0
    ensure_content_types || rc=$?
  fi
  [ "$rc" -eq 10 ] && log "content types updated — kodi restart required"
  [ "$rc" -eq 0 ] || [ "$rc" -eq 10 ] || die "could not set source content types (rc=$rc)"

  start_kodi
  scan_and_wait || exit 1
  print_summary
}

main
