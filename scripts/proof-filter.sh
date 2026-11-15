#!/bin/bash
# scripts/proof-filter.sh — sentinel-prod-8428 proof-output wrapper parity (R1).
# WHY: the filter, the full log on disk and the 4000-byte capped failure report have exactly
# ONE owner, /Users/misty/sentinel/sentinel-prod/tools/proof_filter.sh. This file is a door and
# nothing else: it resolves that owner and execs it with the caller's arguments untouched, so
# the label, the caller's cwd, stdout, stderr and the exit status (81 included) all belong to
# the owner. A second implementation here would drift from the owner the first time either side
# changed, which is the defect this slice exists to prevent.
# PROOF_FILTER_TOOL is the only knob and exists for fixture and host configuration: the parity
# test points it at a byte-identical copy of the owner so both runs log inside a temp tree.
# WHY bash and not an exec bit on the owner: the owner may sit in a checkout where the mode was
# lost; running it through bash keeps the door working and keeps this adapter's own mode honest.
set -uo pipefail
tool="${PROOF_FILTER_TOOL:-/Users/misty/sentinel/sentinel-prod/tools/proof_filter.sh}"
if [ ! -f "$tool" ]; then
  # A missing owner must be loud: a silent success here would report a proof that never ran.
  echo "proof-filter: shared tool not found: $tool" >&2
  echo "proof-filter: set PROOF_FILTER_TOOL to its path" >&2
  exit 3
fi
exec bash "$tool" "$@"
