#!/usr/bin/env bash
# Gate: every in-flight OpenSpec change this branch carries is one `openspec archive` will accept.
#
# WHY THIS EXISTS. `check-tasks-complete.sh` verifies STRUCTURALLY that `## ADDED Requirements`,
# `### Requirement:` and `#### Scenario:` are present. It never runs `openspec validate`. So a
# change can satisfy every gate in this repository and still be one openspec REFUSES to archive —
# the work merges and the specification does not, and the person who finds out is whoever merges.
#
# It has cost two branches, with the same defect both times: requirement BODY text written with
# lowercase `shall` where the normative keyword must be `SHALL`. PR #10 passed all five gates,
# reached product at UAT, and `openspec archive` refused with 9 errors. PR #13 passed all five
# gates AND a thorough independent review, and was caught only because someone ran
# `openspec validate` by hand. A defect that survives five green gates and a careful review is
# exactly what a gate is for.
#
# THE MESSAGE POINTS AT BODIES, NOT HEADERS. `### Requirement: …` headers stay in prose —
# uppercasing a header RENAMES the requirement and moves its identifier, so a gate that told an
# author to uppercase headers would be actively harmful. `openspec` itself only ever complains
# about body text; this file only ever says body text.
#
# WHY IT LIVES IN `bin/` AND NOT IN `.workflow/bin/`. `.workflow/bin/`, `.claude/` and `.github/`
# belong to the installer and are replaced WHOLESALE on every refresh — twice in one round,
# mid-flight, with branches open. A gate written into `.workflow/bin/check-*.sh` is lost on the
# next install, SILENTLY, which is the worst kind: the protection appears to exist and does not.
# `bin/` is this project's own directory; the installer neither creates nor replaces it. This file
# EDITS NOTHING the installer owns. Same answer Issue #11 reached for `bin/watch.sh`.
#
# THREE OUTCOMES, AND THEY NEVER SHARE AN EXIT CODE OR A RENDERING:
#
#   0  pass            every change in scope validates, or there is no change in scope
#   0  NOT APPLICABLE  this project has no `openspec/` directory — pass, and SAY SO. A gate that
#                      turns "does not apply" into a permanent red blocks every pull request, and
#                      the cost is not one bad verdict; it is that nothing merges until somebody
#                      notices.
#   1  fail            a change in scope is one openspec will not archive
#   3  CANNOT TELL     the check could not be performed: no `openspec` CLI anywhere, or a change
#                      that should be on disk is not. **"Could not determine" is not "determined
#                      to be nothing."** This BLOCKS — a gate whose whole purpose is to stop an
#                      unarchivable change reaching product must never degrade into a pass — but
#                      it blocks under its own word, so nobody reads the red as "your spec is bad".
#   2  usage
#
# SCOPE. With a base sha, only the changes THIS BRANCH TOUCHES, computed exactly the way
# `check-tasks-complete.sh` computes it: diff against the base, exclude `openspec/changes/archive/`,
# and treat a change that is gone on HEAD as archived rather than broken. Without a base — which is
# the CI case, where `make ci` checks out shallow and has no range to diff — every in-flight change
# present in the tree is validated instead, and the widening is PRINTED. That widening is sound in
# the direction that matters: the wider set CONTAINS the touched set, so a pass still means this
# branch's changes are archivable. A failure under the widened scope names the change, so a change
# that is not yours is visibly not yours.
#
# Usage: check-archivable.sh [<base-sha>]
#        check-archivable.sh --self-test
#
# Environment:
#   OPENSPEC_BIN        an explicit CLI to use. Probed like any other candidate, never trusted.
#   OPENSPEC_NPX_SPEC   package spec for the npx fallback. Default: @fission-ai/openspec@1.7.0
#   OPENSPEC_NO_NPX=1   do not fall back to npx (used by this file's own self-test to reach the
#                       cannot-tell arm on a machine that has the CLI).
set -uo pipefail

EX_FAIL=1
EX_USAGE=2
EX_CANNOT_TELL=3

# ── locating the CLI ─────────────────────────────────────────────────────────────────────────────
# PROBED, NEVER NAMED. The path here is under nvm; CI has no openspec at all and is Linux. A gate
# that hardcodes either is a gate that is wrong on the other machine.
resolve_cli() {
  local c
  for c in "${OPENSPEC_BIN:-}" openspec ./node_modules/.bin/openspec; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || continue
    "$c" --version >/dev/null 2>&1 || continue
    printf '%s' "$c"; return 0
  done
  # npx LAST, because it may reach the network and a gate should prefer what is already here.
  # This is what makes the gate runnable on a GitHub runner, which has node and no openspec.
  if [ "${OPENSPEC_NO_NPX:-}" != 1 ] && command -v npx >/dev/null 2>&1; then
    local spec=${OPENSPEC_NPX_SPEC:-@fission-ai/openspec@1.7.0}
    if npx --yes "$spec" --version >/dev/null 2>&1; then
      printf 'npx --yes %s' "$spec"; return 0
    fi
  fi
  return 1
}

cannot_tell() { # cannot_tell <line>...
  local l
  echo "::error::CANNOT TELL whether this branch's OpenSpec change can be archived." >&2
  for l in "$@"; do printf '  %s\n' "$l" >&2; done
  echo "  This is NOT a finding about your specification and NOT a pass. Nothing was validated." >&2
  return "$EX_CANNOT_TELL"
}

# ── scope ────────────────────────────────────────────────────────────────────────────────────────
# A BASH GLOB, NOT `find | sort`. The self-test reaches the missing-CLI arm by handing this script
# a PATH with no `openspec` on it, and the first version of that arm emptied PATH entirely — so
# `find` and `sort` were not found either, the scope came back EMPTY, and the gate printed "no
# in-flight change to validate" over a repository holding one. That is the vacuous pass this whole
# file exists to remove, produced by the file itself. A glob cannot fail that way: it is the shell.
in_flight_in_tree() { # every change directory present in the working tree, archive excluded
  local d
  [ -d openspec/changes ] || return 0
  for d in openspec/changes/*/; do
    d=${d%/}; d=${d##*/}
    [ "$d" = '*' ] && return 0          # nothing matched the glob
    [ "$d" = archive ] && continue
    printf '%s\n' "$d"
  done
}

touched_changes() { # touched_changes <base>  -> change directory names, archive excluded
  git diff --name-only "$1"...HEAD -- 'openspec/changes/**' \
    | { grep -v '^openspec/changes/archive/' || true; } \
    | sed -n 's#^openspec/changes/\([^/]*\)/.*#\1#p' | sort -u
}

run_gate() {
  local base=${1:-} rc=0 scope="" id widened=0

  # NOT APPLICABLE. Said out loud, because a silent pass and an inapplicable check look identical,
  # and this gate would otherwise be a permanent red in every project that does not use OpenSpec.
  if [ ! -d openspec ]; then
    echo "NOT APPLICABLE: this project has no openspec/ directory, so there is no change to archive."
    return 0
  fi

  if [ -n "$base" ]; then
    git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
      cannot_tell "base commit '$base' is not in this clone, so the changes this branch touches" \
                  "cannot be determined. That is a CHECKOUT problem — the job needs fetch-depth: 0." \
      ; return $?; }
    scope=$(touched_changes "$base")
  else
    widened=1
    scope=$(in_flight_in_tree)
  fi

  if [ -z "$scope" ]; then
    # A CHANGE CREATED AND ARCHIVED IN THE SAME BRANCH LEAVES NO TRACE IN THE NET DIFF. Passing is
    # right; "no change touched" is not — a reader would take it as "nothing was checked".
    if [ -n "$base" ] && git diff --name-only "$base"...HEAD -- 'openspec/changes/archive/**' | grep -q .; then
      echo "This branch archives a change and leaves none in flight — that is what finished looks like in a diff."
    else
      echo "No in-flight OpenSpec change to validate."
    fi
    return 0
  fi

  local cli
  cli=$(resolve_cli) || {
    cannot_tell "no usable 'openspec' CLI: not in \$OPENSPEC_BIN, not on \$PATH, not in" \
                "./node_modules/.bin, and npx could not fetch ${OPENSPEC_NPX_SPEC:-@fission-ai/openspec@1.7.0}." \
                "In scope and UNVALIDATED: ${scope//$'\n'/ }" \
                "Install it (npm i -g @fission-ai/openspec) or give the runner network access to npx." \
    ; return $?; }

  if [ "$widened" -eq 1 ]; then
    echo "note: no base sha given, so EVERY in-flight change in the tree is validated, not only the"
    echo "      ones this branch touches. A pass therefore still covers this branch; a failure below"
    echo "      names the change, so one that is not yours is visibly not yours."
  fi

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ ! -d "openspec/changes/$id" ]; then
      # Gone on HEAD means this branch archived or removed it: that is what finished looks like.
      if [ -n "$base" ] && ! git cat-file -e "HEAD:openspec/changes/$id" 2>/dev/null; then
        echo "  archived or removed: $id"; continue
      fi
      # Present in the tree per git and absent on disk is not something this gate may guess at.
      cannot_tell "change '$id' is in scope but openspec/changes/$id is not on disk." \
                  "The tree and the range disagree; nothing about '$id' has been judged." || rc=$?
      continue
    fi
    local out vrc=0
    # $cli IS DELIBERATELY UNQUOTED: the npx fallback resolves to three words. It is built by
    # resolve_cli from a fixed template and an env var, never from repository content.
    out=$($cli validate "$id" --strict 2>&1) || vrc=$?
    if [ "$vrc" -eq 0 ]; then
      echo "  archivable: $id"
    else
      echo "::error::openspec will NOT archive '$id' — it fails 'openspec validate $id --strict'." >&2
      printf '%s\n' "$out" | sed 's/^/    /' >&2
      echo "  Fix the change, not the gate. The defect that has cost this project two branches is" >&2
      echo "  lowercase 'shall' in requirement BODY text where the normative keyword must be" >&2
      echo "  uppercase SHALL (or MUST). Rewrite the BODY lines." >&2
      echo "  Leave '### Requirement:' HEADERS in prose — uppercasing a header renames the" >&2
      echo "  requirement and moves its identifier, which breaks more than it fixes." >&2
      rc=$EX_FAIL
    fi
  done <<<"$scope"

  return "$rc"
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────────
# Every arm below has been watched go RED, by inverting the assertion or breaking the code, before
# being kept. The valid case is asserted in the SAME run as the invalid one, because a gate that
# fails on everything "catches" the defect too and is worthless.
self_test() {
  local tmp rc=0 out me srcrc=0 t p
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d) || return 1
  trap 'rm -rf "$tmp"' RETURN

  _mk() { local d=$1; mkdir -p "$d"; git -C "$d" init -q -b main
    git -C "$d" config user.email t@t; git -C "$d" config user.name t
    echo x > "$d/seed"; git -C "$d" add -A; git -C "$d" commit -qm "chore: seed"
    git -C "$d" rev-parse HEAD > "$d/.base"; }
  _change() { # _change <repo> <id> <shall-word>
    local d=$1 id=$2 word=$3
    mkdir -p "$d/openspec/changes/$id/specs/thing"
    printf 'schema: spec-driven\n' > "$d/openspec/config.yaml"
    printf '## Why\nBecause.\n\n## What Changes\n- a thing\n' > "$d/openspec/changes/$id/proposal.md"
    printf -- '- [x] do it\n' > "$d/openspec/changes/$id/tasks.md"
    printf '## ADDED Requirements\n\n### Requirement: A thing that works\nThe system %s work.\n\n#### Scenario: it runs\n- **WHEN** it is run\n- **THEN** it works\n' \
      "$word" > "$d/openspec/changes/$id/specs/thing/spec.md"
    git -C "$d" add -A; git -C "$d" commit -qm "feat: $id"; }
  _run() { local d=$1; shift; ( cd "$d" && bash "$me" "$@" ) 2>&1; }

  # 0. THE ENVIRONMENT IS PROBED, NOT NAMED. Without a CLI the validating arms cannot run at all,
  #    so they SKIP with a stated reason rather than passing on having done nothing.
  local have_cli=1
  ( cd "$tmp" && resolve_cli >/dev/null 2>&1 ) || have_cli=0

  # 1. NO openspec/ AT ALL MUST PASS, AND MUST SAY SO. This is the arm that stops a gate becoming
  #    a permanent red in a project it does not apply to.
  _mk "$tmp/none"
  out=$(_run "$tmp/none") || { echo "SELF-TEST FAIL: a project with no openspec/ was BLOCKED" >&2; rc=1; }
  case "$out" in *"NOT APPLICABLE"*) : ;; *) echo "SELF-TEST FAIL: an inapplicable check did not say so: $out" >&2; rc=1 ;; esac

  if [ "$have_cli" -eq 1 ]; then
    # 2. THE REAL DEFECT: lowercase `shall` in requirement BODY text must FAIL.
    _mk "$tmp/bad"; _change "$tmp/bad" c1 shall
    out=$(_run "$tmp/bad") && { echo "SELF-TEST FAIL: a change with lowercase 'shall' in a requirement body PASSED" >&2; rc=1; }
    case "$out" in *"will NOT archive"*) : ;; *) echo "SELF-TEST FAIL: the refusal did not name the reason: $out" >&2; rc=1 ;; esac
    # AND IT MUST POINT AT BODIES. A gate telling an author to uppercase '### Requirement:' headers
    # would rename the requirement and move its identifier.
    case "$out" in *"BODY text"*) : ;; *) echo "SELF-TEST FAIL: the message does not point at requirement bodies" >&2; rc=1 ;; esac

    # 3. AND A VALID CHANGE MUST PASS IN THE SAME RUN, or arm 2 proves nothing: a gate that fails
    #    on everything catches the defect too and is useless.
    _mk "$tmp/good"; _change "$tmp/good" c1 SHALL
    out=$(_run "$tmp/good") || { echo "SELF-TEST FAIL: a valid change was rejected: $out" >&2; rc=1; }
    case "$out" in *"archivable: c1"*) : ;; *) echo "SELF-TEST FAIL: a valid change passed without saying it validated: $out" >&2; rc=1 ;; esac

    # 4. SCOPE: a change the branch does not touch must not be validated when a base is given.
    #    Built as an ALREADY-INVALID change committed at the base, so if the gate widened its scope
    #    it would fail — and it must not.
    _mk "$tmp/scope"; _change "$tmp/scope" other shall
    git -C "$tmp/scope" rev-parse HEAD > "$tmp/scope/.base"
    _change "$tmp/scope" mine SHALL
    out=$(_run "$tmp/scope" "$(cat "$tmp/scope/.base")") || { echo "SELF-TEST FAIL: an untouched invalid change failed this branch: $out" >&2; rc=1; }
    case "$out" in *other*) echo "SELF-TEST FAIL: a change this branch does not touch was validated: $out" >&2; rc=1 ;; esac
    # …and with NO base the widened scope must catch it, and must SAY it widened.
    out=$(_run "$tmp/scope") && { echo "SELF-TEST FAIL: the widened scope missed an invalid change" >&2; rc=1; }
    case "$out" in *"EVERY in-flight change"*) : ;; *) echo "SELF-TEST FAIL: the widened scope was not disclosed: $out" >&2; rc=1 ;; esac
  else
    echo "  SKIP: every arm that needs the openspec CLI — no usable CLI here (not on \$PATH, not in"
    echo "        ./node_modules/.bin, and npx could not fetch it). Nothing was validated, so the"
    echo "        valid/invalid arms would have proved nothing."
  fi

  # 5. A MISSING CLI IS A CANNOT-TELL, NOT A PASS, and carries its own exit code. Reached by
  #    denying the fallbacks rather than by uninstalling anything.
  _mk "$tmp/nocli"; _change "$tmp/nocli" c1 SHALL
  # PATH is emptied rather than a CLI uninstalled — and bash is invoked by its ABSOLUTE path,
  # because an emptied PATH cannot find `bash` either. The first version of this arm exited 127
  # ("bash: command not found") and the assertion caught it, which is the point of the assertion.
  # A PATH WITH NO `openspec` ON IT, built by symlinking the tools this script legitimately uses
  # and NOT the one under test. Emptying PATH outright was the first attempt and it removed `find`
  # and `sort` as well, which made the gate report "nothing to validate" — a real defect, now fixed
  # in in_flight_in_tree, that this arm found. Everything here is PROBED: a tool that is not on
  # this machine is simply not linked.
  mkdir -p "$tmp/binpath"
  for t in git sed grep awk sort find basename dirname cat mktemp rm mkdir; do
    p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$tmp/binpath/$t"
  done
  out=$( cd "$tmp/nocli" && PATH="$tmp/binpath" OPENSPEC_BIN= OPENSPEC_NO_NPX=1 "$BASH" "$me" 2>&1 ); srcrc=$?
  [ "$srcrc" -eq "$EX_CANNOT_TELL" ] || { echo "SELF-TEST FAIL: a missing CLI exited $srcrc, not $EX_CANNOT_TELL — 'could not tell' must not share a code with 'clean'" >&2; rc=1; }
  case "$out" in *"CANNOT TELL"*) : ;; *) echo "SELF-TEST FAIL: a missing CLI did not say it could not tell: $out" >&2; rc=1 ;; esac
  case "$out" in *"UNVALIDATED: c1"*) : ;; *) echo "SELF-TEST FAIL: a cannot-tell did not name what went unvalidated: $out" >&2; rc=1 ;; esac

  # 6. AN UNREACHABLE BASE IS A CANNOT-TELL, and must not read as "this branch touches no change".
  _mk "$tmp/unreach"; _change "$tmp/unreach" c1 SHALL
  out=$( cd "$tmp/unreach" && bash "$me" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1 ); srcrc=$?
  [ "$srcrc" -eq "$EX_CANNOT_TELL" ] || { echo "SELF-TEST FAIL: an unreachable base exited $srcrc, not $EX_CANNOT_TELL" >&2; rc=1; }
  case "$out" in *"No in-flight OpenSpec change"*) echo "SELF-TEST FAIL: a lookup failure was reported as 'nothing to validate'" >&2; rc=1 ;; esac

  # 7. A BRANCH THAT ARCHIVES ITS CHANGE MUST PASS — and by recognising the archive.
  _mk "$tmp/arch"; _change "$tmp/arch" c1 SHALL
  git -C "$tmp/arch" rev-parse HEAD > "$tmp/arch/.base"
  mkdir -p "$tmp/arch/openspec/changes/archive/2026-01-01-c1"
  git -C "$tmp/arch" mv openspec/changes/c1 openspec/changes/archive/2026-01-01-c1/c1
  git -C "$tmp/arch" commit -qm "chore: archive"
  out=$(_run "$tmp/arch" "$(cat "$tmp/arch/.base")") || { echo "SELF-TEST FAIL: an archiving branch was blocked: $out" >&2; rc=1; }
  case "$out" in
    *"archived or removed"*|*"archives a change"*) : ;;
    *) echo "SELF-TEST FAIL: the archive passed for the wrong reason: $out" >&2; rc=1 ;;
  esac

  [ "$rc" -eq 0 ] && echo "self-test passed: no openspec passes and says so, an unarchivable change fails while a valid one passes, an absent CLI and an unreachable base are cannot-tell (exit $EX_CANNOT_TELL) rather than either verdict"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  -*) echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit "$EX_USAGE" ;;
  *) run_gate "${1:-}"; exit $? ;;
esac
