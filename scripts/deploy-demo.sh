#!/usr/bin/env bash
#
# Royalty — put the bid demo on the internet.
#
# Everything in docs/deploy.md's first-time sequence, in one script, plus the
# one step that runbook does not have: seeding the demo roster onto the volume.
# A fresh volume is an EMPTY database, so a deploy with no seed step is a live
# hostname serving nobody — the app comes up, /api/health passes, and every
# access link 404s.
#
# Run `fly auth login` first; this script refuses to start without it.
#
#   bash scripts/deploy-demo.sh
#
# Re-runnable: every step checks for what it would create before creating it,
# so a run that fails halfway can just be run again.
set -euo pipefail

APP="${FLY_APP:-royalty-schedule}"
REGION="${FLY_REGION:-ord}"
VOLUME="royalty_data"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v fly >/dev/null 2>&1 || die "flyctl is not installed. See the notes at the end of docs/deploy.md."
fly auth whoami >/dev/null 2>&1 || die "Not logged in to Fly. Run:  fly auth login"

say "Logged in as $(fly auth whoami)"

# ---------------------------------------------------------------------------
# 1. The app
# ---------------------------------------------------------------------------
if fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  say "App '$APP' already exists — skipping create"
else
  say "Creating app '$APP'"
  fly apps create "$APP"
fi

# ---------------------------------------------------------------------------
# 2. The volume
#
# ⚠️ ONE volume, and therefore one machine. A Fly volume attaches to a single
# machine, so a second machine is a second, empty database behind the same
# hostname — not more capacity. Every deploy below passes --ha=false.
# ---------------------------------------------------------------------------
if fly volumes list -a "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  say "Volume '$VOLUME' already exists — skipping create"
else
  say "Creating 1GB volume '$VOLUME' in $REGION"
  fly volumes create "$VOLUME" -a "$APP" --region "$REGION" --size 1 --yes
fi

# ---------------------------------------------------------------------------
# 3. Secrets
#
# The boot gate in server/lib/deploy-config.js refuses to start in production
# without ADMIN_PASSWORD and SESSION_SECRET. Both are generated here and shown
# once — Fly cannot read a secret back out.
# ---------------------------------------------------------------------------
EXISTING_SECRETS="$(fly secrets list -a "$APP" 2>/dev/null || true)"

if grep -q 'ADMIN_PASSWORD' <<<"$EXISTING_SECRETS"; then
  say "ADMIN_PASSWORD already set — leaving it alone"
  ADMIN_PW=""
else
  ADMIN_PW="$(openssl rand -base64 18)"
  say "Setting ADMIN_PASSWORD"
  fly secrets set -a "$APP" --stage ADMIN_PASSWORD="$ADMIN_PW" >/dev/null
fi

if grep -q 'SESSION_SECRET' <<<"$EXISTING_SECRETS"; then
  say "SESSION_SECRET already set — leaving it alone"
else
  say "Setting SESSION_SECRET"
  # ⚠️ Pinned in the environment on purpose. The fallback is generated INTO the
  # database, which is the file backups copy off-box — so an unpinned secret
  # puts a live signing key in every snapshot, and a rebuilt volume signs all
  # ~280 phones out.
  fly secrets set -a "$APP" --stage SESSION_SECRET="$(openssl rand -hex 32)" >/dev/null
fi

# Access links in the CSV export are built from this. Wrong hostname here means
# 280 links the recipients discover are broken.
say "Setting PUBLIC_BASE_URL"
fly secrets set -a "$APP" --stage PUBLIC_BASE_URL="https://${APP}.fly.dev" >/dev/null

# ---------------------------------------------------------------------------
# 4. Deploy
#
# The build args are the only channel by which the running machine can name its
# release: .git/ is in .dockerignore, so there is no repository in the image and
# no honest runtime fallback. A plain `fly deploy` produces a machine that
# answers "unknown".
# ---------------------------------------------------------------------------
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="false"; [ -n "$(git status --porcelain 2>/dev/null)" ] && DIRTY="true"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

say "Deploying ($COMMIT, dirty=$DIRTY) — first build takes a few minutes"
fly deploy -a "$APP" --ha=false \
  --build-arg "RELEASE=demo-${COMMIT}" \
  --build-arg "RELEASE_COMMIT=${COMMIT}" \
  --build-arg "RELEASE_BUILT_AT=${BUILT_AT}" \
  --build-arg "RELEASE_DIRTY=${DIRTY}"

# ---------------------------------------------------------------------------
# 5. Seed the demo roster onto the volume
#
# The step the runbook does not have, and the one whose absence looks like a
# working deploy: a fresh volume holds an empty database, so without this every
# access link resolves to nothing.
#
# ⚠️ Wait for the machine first. `fly deploy` returns once the release is
# created, which is *before* the machine is accepting SSH — the first run of
# this script died here on "app has no started VMs", and the failure landed
# after a successful deploy, so it read as a broken deploy when what was
# actually broken was an empty database behind a passing health check.
# ---------------------------------------------------------------------------
say "Waiting for the machine to accept connections"
READY=""
for i in $(seq 1 30); do
  if fly ssh console -a "$APP" -C "true" >/dev/null 2>&1; then READY=1; break; fi
  printf '.'; sleep 5
done
printf '\n'
[ -n "$READY" ] || die "The machine never came up. Check:  fly status -a $APP  and  fly logs -a $APP"

# Is there already a roster on the volume? Anything but a clean "yes" is treated
# as "no" and seeded — an empty database is the failure worth fixing twice, and
# re-seeding a populated one is refused on the next line anyway.
HAS_ROSTER="$(fly ssh console -a "$APP" -C \
  "node -e \"import('./server/db.js').then(({db})=>console.log(db.prepare('SELECT COUNT(*) n FROM people').get().n))\"" \
  2>/dev/null | tr -dc '0-9' || true)"

if [ -n "$HAS_ROSTER" ] && [ "$HAS_ROSTER" -gt 0 ] 2>/dev/null; then
  say "The volume already holds $HAS_ROSTER people — NOT re-seeding (that would rotate every access code)"
else
  say "Seeding the demo roster"
  fly ssh console -a "$APP" -C "npm run seed:demo"
fi

# ---------------------------------------------------------------------------
# 6. Prove it
# ---------------------------------------------------------------------------
say "One machine?"
fly status -a "$APP"

say "What the machine thinks of its own configuration"
fly ssh console -a "$APP" -C "npm run preflight" || true

say "Access codes — these are the demo links"
fly ssh console -a "$APP" -C "npm run codes -- --list" || true

printf '\n\033[32mDone.\033[0m  https://%s.fly.dev\n' "$APP"
printf '        admin at https://%s.fly.dev/admin\n' "$APP"
if [ -n "$ADMIN_PW" ]; then
  printf '\n  ADMIN_PASSWORD (shown once, Fly will not show it again):\n    %s\n\n' "$ADMIN_PW"
else
  printf '\n  ADMIN_PASSWORD was already set. If you do not have it:\n'
  printf '    fly secrets set -a %s ADMIN_PASSWORD="$(openssl rand -base64 18)"\n\n' "$APP"
fi

# ⚠️ This machine does not stop on its own — see the note at the end of this file.
printf '  This runs until you stop it. When the interview is over:\n'
printf '    fly apps destroy %s          # everything, including the data\n' "$APP"
printf '    fly scale count 0 -a %s      # or just stop the compute, keep the volume\n\n' "$APP"

# ---------------------------------------------------------------------------
# What this costs, and how to stop it costing that
#
# Billing is per-second: a shared-cpu-1x/1GB machine is about $5.92 for a full
# month, and the volume is under the 10GB that costs nothing. A demo that is up
# for a few days is cents, and a new account's $5 trial credit generally covers
# it outright.
#
# ⚠️ It does NOT stop on its own. `auto_stop_machines = false` and
# `min_machines_running = 1` in fly.toml are deliberate — during the real event
# an idle machine is a cold start in front of 280 phones — but for a demo they
# mean the meter runs until you say otherwise. When the interview is over:
#
#   fly apps destroy royalty-schedule       # machine, volume and all
#
# Or keep the app and just stop paying for compute:
#
#   fly scale count 0 -a royalty-schedule   # volume and data stay, machine stops
#   fly scale count 1 -a royalty-schedule --ha=false   # bring it back
# ---------------------------------------------------------------------------
