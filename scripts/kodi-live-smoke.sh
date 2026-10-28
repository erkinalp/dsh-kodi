#!/usr/bin/env bash
# =============================================================================
# dsh-kodi — LIVE smoke test against a running Kodi
#
# Exercises exactly the JSON-RPC surface the dsh-kodi service layer sits on:
#   JSONRPC.Ping · Application.GetProperties · VideoLibrary.Get{Movies,TVShows,Episodes}
#   Player.Open (library id and raw file) · Player.GetItem · Player.GetProperties
#   Player.PlayPause · Player.Seek · Player.Stop
#
# It asserts, against the real Kodi process, that:
#   1. the web server answers on :8080 and rejects unauthenticated clients (401),
#   2. JSONRPC.Ping returns "pong",
#   3. the video library is non-empty (movies / tvshows / episodes),
#   4. a library item opens and reaches the video player,
#   5. the timeline actually advances (a stub cannot fake this),
#   6. pause stops it (speed 0) and resume starts it again (speed 1),
#   7. an absolute seek lands where it was asked to,
#   8. an episode opens by raw file path (no library id) with show/season/episode,
#   9. stop returns the player to idle.
#
# Exit status: 0 = every check passed, 1 = at least one check failed.
# Safe to re-run: it always opens its own item and stops playback at the end,
# so it never leaves a film running on the desktop. Do not run it while another
# agent is mid-playback on the same instance, since it reuses player 1.
#
# Usage:
#   scripts/kodi-live-smoke.sh              # full smoke, stops playback when done
#   scripts/kodi-live-smoke.sh --keep       # leave the item playing
#   scripts/kodi-live-smoke.sh --no-episode # skip the raw-file episode check
#   scripts/kodi-live-smoke.sh --quiet      # only the PASS/FAIL summary
# =============================================================================
set -euo pipefail

# The shell, awk and printf must not follow the user's locale: a Turkish locale
# formats decimals as "49,99" and makes `printf '%.2f'` fail outright, which
# silently breaks every float comparison below. Kodi's JSON is locale-neutral.
export LC_ALL=C

KODI_PORT=${KODI_PORT:-8080}
KODI_USER=${KODI_USER:-kodi}
KODI_PASS=${KODI_PASS:-kodi}
KODI_RPC_TIMEOUT=${KODI_RPC_TIMEOUT:-15}
BASE="http://127.0.0.1:${KODI_PORT}/jsonrpc"

KEEP_PLAYING=0
CHECK_EPISODE=1
QUIET=0
RPC_ID=0
PASSES=0
FAILS=0

for arg in "$@"; do
  case "$arg" in
    --keep)         KEEP_PLAYING=1 ;;
    --no-episode)   CHECK_EPISODE=0 ;;
    --quiet)        QUIET=1 ;;
    -h|--help)      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; Z=$'\033[0m'; else G=; R=; B=; Z=; fi

section() { [ "$QUIET" -eq 1 ] || printf '\n%s== %s ==%s\n' "$B" "$*" "$Z"; }
note()    { [ "$QUIET" -eq 1 ] || printf '       %s\n' "$*"; }
ok()      { PASSES=$((PASSES + 1)); printf '  %sPASS%s %s\n' "$G" "$Z" "$*"; }
bad()     { FAILS=$((FAILS + 1));   printf '  %sFAIL%s %s\n' "$R" "$Z" "$*"; }

fatal() { # a failure that makes further checks meaningless
  bad "$*"
  printf '\n%ssmoke aborted%s\n' "$R" "$Z"
  exit 1
}

# ----------------------------------------------------------------------------
# transport
# ----------------------------------------------------------------------------
kodi_rpc() { # METHOD [PARAMS_JSON]
  local method=$1 params=${2:-'{}'}
  RPC_ID=$((RPC_ID + 1))
  curl -sS --max-time "$KODI_RPC_TIMEOUT" \
       -u "${KODI_USER}:${KODI_PASS}" \
       -H 'Content-Type: application/json' \
       --data-binary "{\"jsonrpc\":\"2.0\",\"id\":${RPC_ID},\"method\":\"${method}\",\"params\":${params}}" \
       "$BASE"
}

# jq over an RPC response; prints nothing (and fails) on a JSON-RPC error
jq_rpc() { # METHOD PARAMS JQEXPR
  local out
  out=$(kodi_rpc "$1" "$2") || return 1
  printf '%s' "$out" | jq -er "$3" 2>/dev/null
}

# jq without -e: for values that are legitimately `false` or `0`
jq_soft() { # METHOD PARAMS JQEXPR
  local out
  out=$(kodi_rpc "$1" "$2") || return 1
  printf '%s' "$out" | jq -r "$3" 2>/dev/null
}

gt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 > b+0)}'; }
in_range() { awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN{exit !(v+0 >= lo+0 && v+0 <= hi+0)}'; }

# poll a player property until it matches, max ~5 s
wait_prop() { # PROPERTY EXPECTED_CMP(awk expr)  -> prints the final value, 1 on timeout
  local prop=$1 expr=$2 i val
  for i in $(seq 1 25); do
    val=$(jq_rpc Player.GetProperties "{\"playerid\":1,\"properties\":[\"$prop\"]}" ".result.$prop" 2>/dev/null || echo '')
    if [ -n "$val" ] && awk -v v="$val" "BEGIN{exit !($expr)}"; then
      printf '%s' "$val"; return 0
    fi
    sleep 0.2
  done
  printf '%s' "${val:-}"
  return 1
}

active_player() { jq_rpc Player.GetActivePlayers '{}' '.result[0].playerid // empty' 2>/dev/null || true; }

# ----------------------------------------------------------------------------
# 0. prerequisites
# ----------------------------------------------------------------------------
for cmd in curl jq awk; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing prerequisite: $cmd" >&2; exit 2; }
done

printf '%s\ndsh-kodi live smoke — Kodi at 127.0.0.1:%s\n%s\n' \
       "$B" "$KODI_PORT" "$Z"

# ----------------------------------------------------------------------------
# 1. reachability + authentication
# ----------------------------------------------------------------------------
section "reachability & auth"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"JSONRPC.Ping"}' "$BASE" || echo 000)
if [ "$code" = "401" ]; then
  ok "unauthenticated request rejected with HTTP 401 (web server authentication is on)"
else
  bad "expected HTTP 401 without credentials, got '$code'"
fi

ping=$(kodi_rpc JSONRPC.Ping | jq -r '.result // empty' 2>/dev/null || true)
if [ "$ping" = "pong" ]; then
  ok "JSONRPC.Ping -> pong"
else
  fatal "JSONRPC.Ping -> '${ping:-<no answer>}' (is Kodi running? check /tmp/kodi-live.log)"
fi

version=$(jq_rpc Application.GetProperties '{"properties":["version","name"]}' \
          '"\(.result.name) \(.result.version.major).\(.result.version.minor) rev=\(.result.version.revision) tag=\(.result.version.tag)"' || true)
if [ -n "$version" ]; then
  ok "Kodi version: $version"
else
  bad "Application.GetProperties did not return a version"
fi

instances=$(pgrep -x kodi.bin 2>/dev/null | wc -l)
if [ "$instances" -gt 1 ]; then
  note "WARNING: $instances kodi.bin processes are running — one shared instance only (see docs/KODI-SETUP.md)"
fi

fs=$(jq_soft GUI.GetProperties '{"properties":["fullscreen"]}' '.result.fullscreen' || echo unknown)
note "GUI fullscreen=$fs at idle (Kodi is windowed at idle and takes the screen only while a video plays)"

# ----------------------------------------------------------------------------
# 2. library
# ----------------------------------------------------------------------------
section "video library"
movies=$(jq_rpc VideoLibrary.GetMovies '{"limits":{"start":0,"end":0}}' '.result.limits.total' || echo 0)
shows=$(jq_rpc VideoLibrary.GetTVShows '{"limits":{"start":0,"end":0}}' '.result.limits.total' || echo 0)
episodes=$(jq_rpc VideoLibrary.GetEpisodes '{"limits":{"start":0,"end":0}}' '.result.limits.total' || echo 0)

note "movies=$movies  tvshows=$shows  episodes=$episodes"
[ "$movies" -ge 1 ]   && ok "library has movies ($movies)"     || bad "library has no movies — run scripts/kodi-provision.sh"
[ "$shows" -ge 1 ]    && ok "library has tv shows ($shows)"    || bad "library has no tv shows — run scripts/kodi-provision.sh"
[ "$episodes" -ge 1 ] && ok "library has episodes ($episodes)" || bad "library has no episodes — run scripts/kodi-provision.sh"

[ "$movies" -ge 1 ] || fatal "no movie to play; cannot test playback"

# pick the longest movie so the timeline checks have room
movie=$(jq_rpc VideoLibrary.GetMovies '{"properties":["title","runtime","file","year"]}' \
        '.result.movies | sort_by(-.runtime) | .[0]' || true)
movieid=$(printf '%s' "$movie" | jq -r '.movieid')
movietitle=$(printf '%s' "$movie" | jq -r '.title')
movieruntime=$(printf '%s' "$movie" | jq -r '.runtime')
note "chosen movie: $movietitle (id=$movieid, ${movieruntime}s)"

# ----------------------------------------------------------------------------
# 3. open a library item
# ----------------------------------------------------------------------------
section "playback: open, timeline, pause, resume, seek"
opened=$(jq_rpc Player.Open "{\"item\":{\"movieid\":$movieid}}" 'if .result then "ok" else "no" end' || true)
if [ "$opened" = "ok" ]; then
  ok "Player.Open movieid=$movieid accepted"
else
  fatal "Player.Open movieid=$movieid was rejected"
fi

playerid=''
for i in $(seq 1 25); do playerid=$(active_player); [ -n "$playerid" ] && break; sleep 0.2; done
if [ "$playerid" = "1" ]; then
  ok "player 1 is active"
else
  fatal "no active player after Player.Open (got '${playerid:-none}')"
fi

pct_start=$(jq_rpc Player.GetProperties '{"playerid":1,"properties":["percentage","totaltime"]}' '.result.percentage' || echo '')
speed=$(jq_rpc Player.GetProperties '{"playerid":1,"properties":["speed"]}' '.result.speed' || echo '')
[ "$speed" = "1" ] && ok "speed=1 (playing)" || bad "expected speed=1 after open, got '${speed:-none}'"

item=$(jq_rpc Player.GetItem '{"playerid":1,"properties":["title","file","year","showtitle","season","episode"]}' '.result.item' || true)
title=$(printf '%s' "$item" | jq -r '.title // ""')
itype=$(printf '%s' "$item" | jq -r '.type // ""')
if [ -n "$title" ] && [ "$itype" = "movie" ]; then
  ok "Player.GetItem -> type=movie title=\"$title\""
else
  bad "Player.GetItem -> type='$itype' title='$title'"
fi

sleep 3
pct_later=$(jq_rpc Player.GetProperties '{"playerid":1,"properties":["percentage"]}' '.result.percentage' || echo '')
if [ -n "$pct_start" ] && [ -n "$pct_later" ] && gt "$pct_later" "$pct_start"; then
  ok "timeline advanced while playing ($(printf '%.2f' "$pct_start")% -> $(printf '%.2f' "$pct_later")%)"
else
  bad "timeline did not advance (start=${pct_start:-?}% later=${pct_later:-?}%)"
fi

if jq_rpc Player.PlayPause '{"playerid":1,"play":false}' 'if .result then "ok" else "no" end' >/dev/null 2>&1 \
   && paused=$(wait_prop speed 'v == 0'); then
  ok "Player.PlayPause(play=false) -> speed=0 (paused)"
else
  bad "pause did not take effect (speed stayed non-zero)"
fi

if jq_rpc Player.PlayPause '{"playerid":1,"play":true}' 'if .result then "ok" else "no" end' >/dev/null 2>&1 \
   && resumed=$(wait_prop speed 'v == 1'); then
  ok "Player.PlayPause(play=true) -> speed=1 (resumed)"
else
  bad "resume did not take effect (speed stayed 0)"
fi

# absolute seek: {percentage:50}; only meaningful for items long enough
if [ "$movieruntime" -ge 10 ]; then
  if jq_rpc Player.Seek '{"playerid":1,"value":{"percentage":50.0}}' '.result' >/dev/null 2>&1; then
    seeked=$(wait_prop percentage 'v >= 45 && v <= 60')
    if [ -n "$seeked" ]; then
      ok "Player.Seek {percentage:50} landed at $(printf '%.2f' "$seeked")%"
    else
      bad "seek did not land near 50% (got '${seeked:-none}')"
    fi
  else
    bad "Player.Seek {percentage:50} was rejected by Kodi"
  fi
else
  note "skipping seek: chosen movie is only ${movieruntime}s"
fi

# ----------------------------------------------------------------------------
# 4. open an episode by raw file path (the kodi_play {file} path)
# ----------------------------------------------------------------------------
if [ "$CHECK_EPISODE" -eq 1 ] && [ "$episodes" -ge 1 ]; then
  section "playback: episode by file path"
  epfile=$(jq_rpc VideoLibrary.GetEpisodes '{"properties":["file","title","showtitle","season","episode"]}' \
           '.result.episodes[0].file' || true)
  if [ -n "$epfile" ] && [ "$epfile" != "null" ]; then
    if jq_rpc Player.Open "{\"item\":{\"file\":$(printf '%s' "$epfile" | jq -Rs .)}}" \
         'if .result then "ok" else "no" end' >/dev/null 2>&1; then
      ok "Player.Open file=$epfile"
      epitem=''
      for i in $(seq 1 25); do
        epitem=$(jq_rpc Player.GetItem '{"playerid":1,"properties":["title","showtitle","season","episode"]}' '.result.item' 2>/dev/null || true)
        if [ -n "$epitem" ] && printf '%s' "$epitem" | jq -e '.showtitle // "" | length > 0' >/dev/null 2>&1; then
          break
        fi
        sleep 0.2
      done
      eshow=$(printf '%s' "$epitem" | jq -r '.showtitle // ""')
      eseason=$(printf '%s' "$epitem" | jq -r '.season // 0')
      eep=$(printf '%s' "$epitem" | jq -r '.episode // 0')
      etype=$(printf '%s' "$epitem" | jq -r '.type // ""')
      if [ "$etype" = "episode" ] && [ -n "$eshow" ]; then
        ok "Player.GetItem -> type=episode show=\"$eshow\" ${eseason}x$(printf '%02d' "$eep")"
      else
        bad "episode open returned type='$etype' show='$eshow'"
      fi
    else
      bad "Player.Open by file path was rejected: $epfile"
    fi
  else
    bad "could not read an episode file path from the library"
  fi
fi

# ----------------------------------------------------------------------------
# 5. stop / idle
# ----------------------------------------------------------------------------
section "stop"
if [ "$KEEP_PLAYING" -eq 1 ]; then
  note "--keep given: leaving the current item playing"
else
  if jq_rpc Player.Stop '{"playerid":1}' 'if .result then "ok" else "no" end' >/dev/null 2>&1; then
    ok "Player.Stop accepted"
  else
    bad "Player.Stop was rejected"
  fi
  idle=''
  for i in $(seq 1 25); do idle=$(active_player); [ -z "$idle" ] && break; sleep 0.2; done
  if [ -z "$idle" ]; then
    ok "player idle again (no active players)"
  else
    bad "player still active after stop (playerid=$idle)"
  fi
fi

# ----------------------------------------------------------------------------
# summary
# ----------------------------------------------------------------------------
printf '\n%s--------------------------------------------%s\n' "$B" "$Z"
printf '  kodi      %s\n' "${version:-unknown}"
printf '  library   movies=%s tvshows=%s episodes=%s\n' "$movies" "$shows" "$episodes"
printf '  played    %s\n' "${movietitle:-?}"
printf '  checks    %s passed, %s failed\n' "$PASSES" "$FAILS"
printf '%s--------------------------------------------%s\n' "$B" "$Z"
if [ "$FAILS" -eq 0 ]; then
  printf '%sSMOKE PASS%s\n' "$G" "$Z"
  exit 0
fi
printf '%sSMOKE FAIL%s\n' "$R" "$Z"
exit 1
