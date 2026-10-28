#!/usr/bin/env bash
# =============================================================================
# Package the DSH Kodi add-on as an installable zip.
#
#   kodi-addon/package-addon.sh              -> kodi-addon/dist/program.dsh-0.1.0.zip
#   kodi-addon/package-addon.sh --publish    -> also copy it into ~/.kodi/addons
#
# Kodi installs a zip whose root contains the add-on directory ("program.dsh/"),
# which is exactly how this archive is built. Pycache/DS_Store/editor droppings
# are excluded so the zip stays reproducible-ish and small.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${HERE}/program.dsh"
DIST="${HERE}/dist"

[[ -f "${SOURCE}/addon.xml" ]] || { echo "error: ${SOURCE}/addon.xml is missing" >&2; exit 1; }

VERSION="$(python3 - "${SOURCE}/addon.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
print(ET.parse(sys.argv[1]).getroot().get("version", "0.0.0"))
PY
)"

OUT="${DIST}/program.dsh-${VERSION}.zip"
mkdir -p "${DIST}"
rm -f "${OUT}"

cd "${HERE}"
if command -v zip >/dev/null 2>&1; then
    zip -qr "${OUT}" program.dsh \
        -x 'program.dsh/__pycache__' \
        -x 'program.dsh/**/__pycache__' \
        -x 'program.dsh/**/__pycache__/*' \
        -x 'program.dsh/**/*.pyc' \
        -x 'program.dsh/.DS_Store' \
        -x 'program.dsh/**/.DS_Store'
else
    python3 - "${OUT}" <<'PY'
import os, sys, zipfile
out, root = sys.argv[1], "program.dsh"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            if name.endswith((".pyc", ".DS_Store")):
                continue
            path = os.path.join(base, name)
            archive.write(path, path)
PY
fi

echo "packaged ${OUT} ($(du -h "${OUT}" | cut -f1))"

if [[ "${1:-}" == "--publish" ]]; then
    TARGET="${HOME}/.kodi/addons/program.dsh"
    echo "installing into ${TARGET}"
    rm -rf "${TARGET}"
    cp -r "${SOURCE}" "${TARGET}"
    echo "installed; enable it in Kodi: Add-ons -> Program add-ons -> DSH"
fi
