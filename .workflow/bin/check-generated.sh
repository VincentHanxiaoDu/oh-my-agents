#!/usr/bin/env bash
# Gate: files that are generated must not be hand-authored.
#
# `openspec/specs/**` is derived from the changes that have been archived. Editing it directly
# produces a specification that agrees with nobody's code and disagrees with the change history —
# and because it reads like a specification, it is believed.
#
# NOT APPLICABLE when the project has no openspec/specs/ — a project that does not generate
# anything is outside this gate, not failing it. Said explicitly, because a silent pass and an
# inapplicable check look identical from a green tick.
#
# Usage: check-generated.sh <base-sha>
#        check-generated.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

GENERATED_PATHS='openspec/specs'

run_gate() {
  local base=$1 touched p present=0

  for p in $GENERATED_PATHS; do
    git cat-file -e "HEAD:$p" 2>/dev/null && present=1
  done
  [ "$present" -eq 1 ] || {
    echo "NOT APPLICABLE: this project generates none of $GENERATED_PATHS, so there is nothing here to protect."
    return 0
  }

  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
    echo "::error::base commit '$base' is not in this clone, so the changed files cannot be determined." >&2
    echo "  This is a CHECKOUT problem — the job needs fetch-depth: 0 — and NOT a statement that nothing generated was edited." >&2
    return 1
  }

  touched=""
  for p in $GENERATED_PATHS; do
    touched="$touched$(git diff --name-only "$base"...HEAD -- "$p/**" || true)"$'\n'
  done
  touched=$(printf '%s' "$touched" | grep -v '^$' || true)

  [ -n "$touched" ] || { echo "generated files untouched: $GENERATED_PATHS"; return 0; }

  # AN ARCHIVING PULL REQUEST LEGITIMATELY REGENERATES THEM. That is the one edit that is not
  # hand-authoring, and refusing it would make the correct action impossible.
  if git diff --name-only "$base"...HEAD -- 'openspec/changes/archive/**' | grep -q .; then
    echo "generated files changed alongside an archive — that is regeneration, not hand-authoring:"
    printf '%s\n' "$touched" | sed 's/^/  /'
    return 0
  fi

  # THE `## Purpose` SECTION IS THE ONE PART openspec ASKS A HUMAN TO WRITE. Archiving stamps
  # `TBD - created by archiving change <name>. Update Purpose after archive.` into every new spec,
  # and it is generated from nothing — there is no change to go back and edit. So this gate forbade
  # exactly what the tool instructs, on every new capability, with a remedy that does not exist.
  #
  # An edit confined to that section is therefore allowed. Everything else in the file is still
  # derived and still refused.
  # COMPARED WITH THE PURPOSE SECTION REMOVED FROM BOTH SIDES. The first attempt matched the diff's
  # own lines against `TBD|Purpose`, which of course fails: the NEW purpose text contains neither.
  # Strip the section and compare what is left — if that is identical, only the purpose moved.
  strip_purpose() { awk '/^## Purpose$/{p=1; next} /^## /{p=0} !p'; }
  local only_purpose=1 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! diff -q <(git show "$base:$f" 2>/dev/null | strip_purpose) \
                 <(git show "HEAD:$f"  2>/dev/null | strip_purpose) >/dev/null 2>&1; then
      only_purpose=0; break
    fi
  done <<<"$touched"
  if [ "$only_purpose" -eq 1 ]; then
    echo "generated files changed only where openspec asks a person to write — the Purpose section:"
    printf '%s\n' "$touched" | sed 's/^/  /'
    return 0
  fi

  echo "::error::these generated files were edited without archiving a change:" >&2
  printf '%s\n' "$touched" | sed 's/^/  /' >&2
  echo "  $GENERATED_PATHS is derived, never authored. Change the spec inside the OpenSpec change" >&2
  echo "  and let archiving regenerate it — an edit here disagrees with the history that produced it." >&2
  echo "  The one exception is the '## Purpose' line, which archiving stamps as TBD and asks you to write." >&2
  return 1
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  _mk() { local d=$1; mkdir -p "$d"; git -C "$d" init -q -b main
    git -C "$d" config user.email t@t; git -C "$d" config user.name t
    echo x > "$d/seed"; git -C "$d" add -A; git -C "$d" commit -qm "chore: seed"
    git -C "$d" rev-parse HEAD > "$d/.base"; }
  _run() { ( cd "$1" && bash "$me" "$(cat .base)" ) 2>&1; }

  # 1. NO GENERATED TREE AT ALL MUST PASS AND SAY SO — the arm that stops this blocking a project
  #    it does not apply to.
  _mk "$tmp/none"
  out=$(_run "$tmp/none") || { echo "SELF-TEST FAIL: a project with no generated tree was BLOCKED" >&2; rc=1; }
  case "$out" in *"NOT APPLICABLE"*) : ;; *) echo "SELF-TEST FAIL: an inapplicable check did not say so: $out" >&2; rc=1 ;; esac

  # 2. A HAND EDIT WITH NO ARCHIVE MUST FAIL. This is the check.
  _mk "$tmp/hand"; mkdir -p "$tmp/hand/openspec/specs/store"
  echo "# generated" > "$tmp/hand/openspec/specs/store/spec.md"
  git -C "$tmp/hand" add -A; git -C "$tmp/hand" commit -qm "chore: seed specs"
  git -C "$tmp/hand" rev-parse HEAD > "$tmp/hand/.base"
  echo "# hand written" >> "$tmp/hand/openspec/specs/store/spec.md"
  git -C "$tmp/hand" add -A; git -C "$tmp/hand" commit -qm "docs: edit"
  _run "$tmp/hand" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a hand edit to a generated file PASSED" >&2; rc=1; }

  # 3. THE SAME EDIT ALONGSIDE AN ARCHIVE MUST PASS — regeneration is the correct action.
  _mk "$tmp/regen"; mkdir -p "$tmp/regen/openspec/specs/store"
  echo "# generated" > "$tmp/regen/openspec/specs/store/spec.md"
  git -C "$tmp/regen" add -A; git -C "$tmp/regen" commit -qm "chore: seed specs"
  git -C "$tmp/regen" rev-parse HEAD > "$tmp/regen/.base"
  echo "# regenerated" >> "$tmp/regen/openspec/specs/store/spec.md"
  mkdir -p "$tmp/regen/openspec/changes/archive/2026-01-01-c1"
  echo "- [x] a" > "$tmp/regen/openspec/changes/archive/2026-01-01-c1/tasks.md"
  git -C "$tmp/regen" add -A; git -C "$tmp/regen" commit -qm "chore: archive c1"
  _run "$tmp/regen" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: regeneration alongside an archive was blocked — the correct action is impossible" >&2; rc=1; }

  # 3b. FILLING IN THE `## Purpose` TBD MUST PASS. openspec stamps it on every archive and tells you
  #     to write it; forbidding that made the gate refuse the tool's own instruction on every new
  #     capability, with a remedy — "change it inside the change" — that does not exist, because
  #     Purpose is generated from nothing.
  _mk "$tmp/purpose"; mkdir -p "$tmp/purpose/openspec/specs/greeting"
  printf '# greeting Specification\n\n## Purpose\nTBD - created by archiving change add-greeting. Update Purpose after archive.\n\n## Requirements\nx\n' \
    > "$tmp/purpose/openspec/specs/greeting/spec.md"
  git -C "$tmp/purpose" add -A; git -C "$tmp/purpose" commit -qm "chore: seed specs"
  git -C "$tmp/purpose" rev-parse HEAD > "$tmp/purpose/.base"
  sed -i.bak 's/TBD - created by archiving change add-greeting. Update Purpose after archive./Greeting a person by name./' "$tmp/purpose/openspec/specs/greeting/spec.md"
  rm -f "$tmp/purpose/openspec/specs/greeting/spec.md.bak"
  git -C "$tmp/purpose" add -A; git -C "$tmp/purpose" commit -qm "docs: fill in the purpose"
  _run "$tmp/purpose" >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: filling in the Purpose TBD was refused — the gate forbids what openspec instructs" >&2; rc=1; }
  # AND AN EDIT ELSEWHERE IN THE SAME FILE MUST STILL FAIL, or the exception swallows the rule.
  sed -i.bak 's/^x$/hand-written requirement/' "$tmp/purpose/openspec/specs/greeting/spec.md"
  rm -f "$tmp/purpose/openspec/specs/greeting/spec.md.bak"
  git -C "$tmp/purpose" add -A; git -C "$tmp/purpose" commit -qm "docs: edit a requirement by hand"
  _run "$tmp/purpose" >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a hand edit outside the Purpose section PASSED — the exception swallowed the rule" >&2; rc=1; }

  # 4. UNTOUCHED MUST PASS.
  _mk "$tmp/clean"; mkdir -p "$tmp/clean/openspec/specs/store"
  echo "# generated" > "$tmp/clean/openspec/specs/store/spec.md"
  git -C "$tmp/clean" add -A; git -C "$tmp/clean" commit -qm "chore: seed specs"
  git -C "$tmp/clean" rev-parse HEAD > "$tmp/clean/.base"
  echo y > "$tmp/clean/other"; git -C "$tmp/clean" add -A; git -C "$tmp/clean" commit -qm "feat: elsewhere"
  _run "$tmp/clean" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: a PR touching nothing generated was blocked" >&2; rc=1; }

  # 5. AN UNREACHABLE BASE MUST FAIL AND MUST NOT CLAIM IT LOOKED.
  out=$( cd "$tmp/hand" && bash "$me" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1 ) \
    && { echo "SELF-TEST FAIL: an unreachable base PASSED" >&2; rc=1; }
  case "$out" in *"not in this clone"*) : ;; *) echo "SELF-TEST FAIL: an unreachable base gave no explanation" >&2; rc=1 ;; esac
  case "$out" in *"generated files untouched"*) echo "SELF-TEST FAIL: a lookup failure reported as 'untouched'" >&2; rc=1 ;; esac

  [ "$rc" -eq 0 ] && echo "self-test passed: no generated tree passes and says so, a hand edit fails, regeneration alongside an archive passes, and an unreachable base fails without claiming it looked"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: check-generated.sh <base-sha> | --self-test" >&2; exit 2 ;;
  *) run_gate "$1" ;;
esac
