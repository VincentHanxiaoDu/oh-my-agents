#!/usr/bin/env bash
# The archivability gate, run against THIS repository rather than against a fixture invented for it.
#
# `bin/check-archivable.sh --self-test` covers the gate's arms in throwaway git repositories. This
# suite answers a different question, and it is the question that went unanswered twice: does the
# gate catch THE DEFECT, in THIS repository's real OpenSpec change, as an author would hit it?
#
# So it copies this repository's own in-flight change into a scratch tree, lowercases `SHALL` in the
# requirement BODY text — the exact defect that reached product on PR #10 and survived a full review
# on PR #13 — and requires the gate to refuse it. The unmodified copy must pass IN THE SAME RUN: a
# gate that fails on everything "catches" the defect too and is worth nothing.
#
# HEADERS ARE LEFT ALONE by the mutation, deliberately. `### Requirement:` headers stay in prose;
# uppercasing one renames the requirement and moves its identifier. The defect is in bodies and the
# fixture is in bodies.
#
# EVERY ASSERTION HERE HAS BEEN WATCHED GO RED, by inverting it and by breaking the gate.
#
# ENVIRONMENT IS PROBED, NOT NAMED. Without a usable `openspec` CLI nothing here can validate
# anything, so it SKIPS with a stated reason rather than passing on having done nothing. This
# machine is darwin and CI is Linux; no path and no version is assumed.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
GATE="$root/bin/check-archivable.sh"

pass=0; fail=0; skip=0
ok()   { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/          /'; }
skipf(){ skip=$((skip+1)); printf '  SKIP  %s — %s\n' "$1" "$2"; }

WORK=$(mktemp -d)             # NOT /tmp: mktemp answers where temp files go on this machine.
trap 'rm -rf "$WORK"' EXIT

echo "archivability gate, against this repository's own change"

# ── the changes this repository actually carries ─────────────────────────────────────────────────
# ALL of them, not the first one found. The first version took `openspec/changes/*/` head and it
# picked up whichever sorted first — which changed the moment this branch added its own change, and
# the suite started asserting things about a different specification than the one it described.
changes=""
change=""
for d in "$root"/openspec/changes/*/; do
  d=${d%/}; b=${d##*/}
  [ "$b" = archive ] && continue
  [ "$b" = '*' ] && continue
  [ -d "$d/specs" ] || continue
  changes="$changes $b"
  [ -n "$change" ] || change=$b
done

# PROBE, don't name: is there any CLI at all here?
have_cli=0
if command -v "${OPENSPEC_BIN:-openspec}" >/dev/null 2>&1; then have_cli=1
elif command -v npx >/dev/null 2>&1 && npx --yes "${OPENSPEC_NPX_SPEC:-@fission-ai/openspec@1.7.0}" --version >/dev/null 2>&1; then have_cli=1
fi

if [ -z "$change" ]; then
  skipf "real-fixture arms" "this repository carries no in-flight change with a specs/ directory to copy"
elif [ "$have_cli" -eq 0 ]; then
  skipf "real-fixture arms" "no usable openspec CLI here (not on \$PATH, and npx could not fetch it), so nothing could be validated and these arms would prove nothing"
else
  # A scratch repository holding a COPY of the real change. The gate is run with no base sha, which
  # is how `make ci` runs it, so the scope is every in-flight change in the tree.
  mk() { local d=$1; mkdir -p "$d"; git -C "$d" init -q -b main
         git -C "$d" config user.email t@t; git -C "$d" config user.name t
         cp "$root/openspec/config.yaml" "$d/openspec/config.yaml" 2>/dev/null || {
           mkdir -p "$d/openspec"; printf 'schema: spec-driven\n' > "$d/openspec/config.yaml"; }
         mkdir -p "$d/openspec/changes"
         local c; for c in $changes; do cp -R "$root/openspec/changes/$c" "$d/openspec/changes/$c"; done
         git -C "$d" add -A; git -C "$d" commit -qm "chore: copy of$changes"; }

  mkdir -p "$WORK/good/openspec" "$WORK/bad/openspec"
  mk "$WORK/good"
  mk "$WORK/bad"

  # THE DEFECT, applied to requirement BODY LINES ONLY. Any line that is a markdown heading is left
  # exactly as it was.
  #
  # BOTH KEYWORDS ARE LOWERED. Lowering only SHALL left requirements whose bodies also said MUST
  # still valid, so the fixture validated cleanly and the arm below failed on correct code — the
  # fixture, not the gate, was wrong. openspec accepts either keyword, so a fixture that removes one
  # removes nothing.
  mutated=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    perl -i -pe 's/\bSHALL\b/shall/g, s/\bMUST\b/must/g unless /^\s*#/' "$f" 2>/dev/null || {
      # No perl: do it with sed, skipping heading lines by address.
      sed -i.bak -e '/^[[:space:]]*#/{p;d;}' -e 's/SHALL/shall/g; s/MUST/must/g' "$f" && rm -f "$f.bak"; }
    mutated=1
  done < <(find "$WORK/bad/openspec/changes" -name 'spec.md' -not -path '*/archive/*' 2>/dev/null)
  git -C "$WORK/bad" commit -aqm "feat: lowercase shall in requirement bodies" 2>/dev/null

  if [ "$mutated" -eq 0 ]; then
    skipf "real-fixture arms" "no specs/**/spec.md found under $change to build the fixture from"
  elif git -C "$WORK/bad" diff --quiet HEAD~1 HEAD 2>/dev/null; then
    # THE FIXTURE MUST ACTUALLY DIFFER. A mutation that changed nothing would make the arm below
    # assert that a VALID change fails, which is the reverse of the rule — and it would look green
    # only by accident. Better to say the fixture could not be built.
    skipf "real-fixture arms" "the fixture is byte-identical to the real change — no uppercase SHALL in a body to lower"
  else
    out=$(cd "$WORK/good" && bash "$GATE" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then ok "this repository's real change is one openspec will archive"
    else bad "this repository's real change is one openspec will archive" "$out"; fi

    out=$(cd "$WORK/bad" && bash "$GATE" 2>&1); rc=$?
    if [ "$rc" -eq 1 ]; then ok "lowercase 'shall' in a requirement body is REFUSED (exit 1)"
    else bad "lowercase 'shall' in a requirement body is REFUSED (exit 1)" "exit $rc; output: $out"; fi
    case "$out" in
      *"BODY text"*) ok "the refusal points the author at bodies" ;;
      *) bad "the refusal points the author at bodies" "$out" ;;
    esac
    case "$out" in
      *"HEADERS in prose"*) ok "the refusal warns against uppercasing headers" ;;
      *) bad "the refusal warns against uppercasing headers" "$out" ;;
    esac
  fi
fi

# ── the outcomes must be three, in this repository too ───────────────────────────────────────────
# A tree with no openspec/ at all: PASS, and say so. Asserted here and not only in the self-test
# because this is the arm whose failure blocks every pull request in every project that does not
# use OpenSpec, and it is worth two independent witnesses.
mkdir -p "$WORK/bare"
( cd "$WORK/bare" && git init -q -b main && git config user.email t@t && git config user.name t )
out=$(cd "$WORK/bare" && bash "$GATE" 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "a project with no openspec/ passes"; else bad "a project with no openspec/ passes" "$out"; fi
case "$out" in *"NOT APPLICABLE"*) ok "…and says NOT APPLICABLE rather than passing silently" ;;
                *) bad "…and says NOT APPLICABLE rather than passing silently" "$out" ;; esac

# A cannot-tell is neither of the other two: its own exit code, its own words.
mkdir -p "$WORK/binpath"
for t in git sed grep awk sort find basename dirname cat mktemp rm mkdir perl; do
  p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$WORK/binpath/$t"
done
if [ -n "$change" ]; then
  mkdir -p "$WORK/nocli/openspec/changes"
  cp "$root/openspec/config.yaml" "$WORK/nocli/openspec/config.yaml" 2>/dev/null || printf 'schema: spec-driven\n' > "$WORK/nocli/openspec/config.yaml"
  cp -R "$root/openspec/changes/$change" "$WORK/nocli/openspec/changes/$change"
  out=$(cd "$WORK/nocli" && PATH="$WORK/binpath" OPENSPEC_BIN= OPENSPEC_NO_NPX=1 "$BASH" "$GATE" 2>&1); rc=$?
  if [ "$rc" -eq 3 ]; then ok "no CLI is a cannot-tell (exit 3), not a pass and not a verdict"
  else bad "no CLI is a cannot-tell (exit 3), not a pass and not a verdict" "exit $rc; output: $out"; fi
  case "$out" in
    *"CANNOT TELL"*) ok "…and says so in words, naming what went unvalidated" ;;
    *) bad "…and says so in words, naming what went unvalidated" "$out" ;;
  esac
  case "$out" in
    *"No in-flight OpenSpec change"*) bad "a cannot-tell must not read as 'nothing to validate'" "$out" ;;
    *) ok "a cannot-tell does not read as 'nothing to validate'" ;;
  esac
else
  skipf "cannot-tell arms" "this repository carries no in-flight change to leave unvalidated"
fi

echo
printf '  %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1
