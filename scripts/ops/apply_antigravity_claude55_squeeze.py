import sqlite3
import json
import datetime

# 1. Update auth.ts on m1pro-home
auth_path = '/Users/macbookprom1/omniroute/src/sse/services/auth.ts'
content = open(auth_path).read()

old1 = """    if (availableConnections.length === 0 && (provider === "antigravity" || provider === "agy")) {
      const failOpenCandidates = connections.filter((c) => {
        if (excludedConnectionIds.has(c.id)) return false;
        const st = connectionFilterStatus.get(c.id);
        return st === "modelLocked" || st === "rateLimited";
      });
      if (failOpenCandidates.length > 0) {
        log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] retaining ${failOpenCandidates.length} cooldown/locked account(s) for live fallback`);
        availableConnections = failOpenCandidates;
      }
    }"""

new1 = """    if (availableConnections.length === 0 && (provider === "antigravity" || provider === "agy")) {
      const isClaude = requestedModel && /claude/i.test(requestedModel);
      if (!isClaude) {
        const failOpenCandidates = connections.filter((c) => {
          if (excludedConnectionIds.has(c.id)) return false;
          const st = connectionFilterStatus.get(c.id);
          return st === "modelLocked" || st === "rateLimited";
        });
        if (failOpenCandidates.length > 0) {
          log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] retaining ${failOpenCandidates.length} cooldown/locked account(s) for live fallback`);
          availableConnections = failOpenCandidates;
        }
      }
    }"""

old2 = """    if (policyEligibleConnections.length === 0 && peakHourEligibleConnections.length > 0 && (provider === "antigravity" || provider === "agy")) {
      log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] bypassing cached quota policy filter (${blockedByPolicy.length} connections)`);
      policyEligibleConnections = peakHourEligibleConnections;
    }"""

new2 = """    if (policyEligibleConnections.length === 0 && peakHourEligibleConnections.length > 0 && (provider === "antigravity" || provider === "agy")) {
      const isClaude = requestedModel && /claude/i.test(requestedModel);
      if (!isClaude) {
        log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] bypassing cached quota policy filter (${blockedByPolicy.length} connections)`);
        policyEligibleConnections = peakHourEligibleConnections;
      }
    }"""

old3 = """    if (withQuota.length === 0 && exhaustedQuota.length > 0 && (provider === "antigravity" || provider === "agy")) {
      log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] bypassing cached quota exhaustion (${exhaustedQuota.length} connections)`);
      withQuota.push(...exhaustedQuota);
    }"""

new3 = """    if (withQuota.length === 0 && exhaustedQuota.length > 0 && (provider === "antigravity" || provider === "agy")) {
      const isClaude = requestedModel && /claude/i.test(requestedModel);
      if (!isClaude) {
        log.warn("AUTH", `${provider} | [FAIL-OPEN-ANTIGRAVITY] bypassing cached quota exhaustion (${exhaustedQuota.length} connections)`);
        withQuota.push(...exhaustedQuota);
      }
    }"""

assert old1 in content, "old1 not found!"
assert old2 in content, "old2 not found!"
assert old3 in content, "old3 not found!"

content = content.replace(old1, new1, 1)
content = content.replace(old2, new2, 1)
content = content.replace(old3, new3, 1)

open(auth_path, 'w').write(content)
print("[OK] auth.ts patched successfully!")

# 2. Update SQLite database
DB_PATH = "/Users/macbookprom1/omniroute/data/storage.sqlite"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Set all active agy and antigravity connections to priority = 1
cursor.execute("UPDATE provider_connections SET priority = 1 WHERE provider IN ('agy', 'antigravity')")
print(f"[OK] provider_connections updated rows: {cursor.rowcount}")

# Update providerStrategies in key_value
row = cursor.execute("SELECT value FROM key_value WHERE key = 'providerStrategies'").fetchone()
if row:
    strat = json.loads(row[0])
    strat["antigravity"] = {"fallbackStrategy": "round-robin", "stickyRoundRobinLimit": 1}
    strat["agy"] = {"fallbackStrategy": "round-robin", "stickyRoundRobinLimit": 1}
    cursor.execute("UPDATE key_value SET value = ? WHERE key = 'providerStrategies'", (json.dumps(strat),))
    print("[OK] key_value.providerStrategies updated to round-robin with sticky limit 1")

# 3. Update combos
ALL_AG_CONNS = [
    "ac0b226d-44fa-4e2c-ad36-8ccc7b90dd7a", # billwill CLI (agy)
    "a66a2b56-a930-49eb-ad0e-236383fd5b89", # billwill IDE (antigravity)
    "0085d792-025d-43d5-9f7e-562a33c44873", # longtho CLI (agy)
    "5f5455c0-d8ad-489c-8868-2c9df2008ee1", # longtho IDE (antigravity)
    "dc96ba4d-7213-46b4-8964-56a31f586420", # cashback CLI (agy)
    "38f1c262-1b86-475d-8780-79c271dd41ca", # cashback IDE (antigravity)
    "bdaf9d9b-c524-4e4e-b0b4-a76207fe535d", # ntnha CLI (agy)
    "bdaf9d9b-c524-4e4e-b0b4-a76207fe535c", # ntnha IDE (antigravity)
    "c1ba716a-939e-4a61-9c16-56a297e6e58b"  # ntnha IDE (antigravity)
]
ZUNEF_CONN_ID = "7c069ac1-abee-43b5-b745-b75d37ec22a4"
ZUNEF_PROV_ID = "anthropic-compatible-c33c2c9c-e3e4-47ae-b231-fda23ffef734"

def make_step(step_id, model, provider_id, label, allowed_conns, timeout_ms):
    m = {
        "id": step_id,
        "kind": "model",
        "model": model,
        "providerId": provider_id,
        "label": label,
        "weight": 0,
        "targetTimeoutMs": timeout_ms,
        "allowedConnectionIds": allowed_conns
    }
    if provider_id == ZUNEF_PROV_ID:
        m["connectionId"] = ZUNEF_CONN_ID
    return m

def patch_combo_config(cfg):
    if not isinstance(cfg, dict):
        cfg = {}
    cfg["targetTimeoutMs"] = 45000
    cfg["failoverBeforeRetry"] = True
    cfg["failoverBeforeRetryExplicit"] = True
    cfg["compatFilterFailOpen"] = True
    cfg["maxRetries"] = 0
    return cfg

now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

opus_combos = [
    "claude-opus-5-5", "claude-opus-5-0", "claude-opus-4-8", "claude-opus-4-8[1m]",
    "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]",
    "rtk-omni-coding", "dahl-minimax", "dahl-kimi"
]

for c in opus_combos:
    row = cursor.execute("SELECT data FROM combos WHERE name = ?", (c,)).fetchone()
    if row:
        cd = json.loads(row[0])
        models = [
            make_step(f"{c}-agy-opus-5-5-high", "agy/claude-opus-5-5-high", "agy", "Antigravity Claude Opus 5.5 High (#1 Primary)", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-opus-5-5-high", "antigravity/claude-opus-5-5-high", "antigravity", "Antigravity Claude Opus 5.5 High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-sonnet-5-5-high", "agy/claude-sonnet-5-5-high", "agy", "Antigravity Claude Sonnet 5.5 High", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-sonnet-5-5-high", "antigravity/claude-sonnet-5-5-high", "antigravity", "Antigravity Claude Sonnet 5.5 High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-opus-5-5-medium", "agy/claude-opus-5-5-medium", "agy", "Antigravity Claude Opus 5.5 Medium", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-sonnet-5-5-medium", "agy/claude-sonnet-5-5-medium", "agy", "Antigravity Claude Sonnet 5.5 Medium", ALL_AG_CONNS, 45000),
            make_step(f"{c}-zunef-opus-5-5", "zunef/claude-opus-5-5", ZUNEF_PROV_ID, "Zunef Claude Opus 5.5 (Heavy Fallback #1)", [ZUNEF_CONN_ID], 60000),
            make_step(f"{c}-zunef-sonnet-5-5", "zunef/claude-sonnet-5-5", ZUNEF_PROV_ID, "Zunef Claude Sonnet 5.5 (Fast Fallback #2)", [ZUNEF_CONN_ID], 45000),
            make_step(f"{c}-agy-argon-high", "agy/gemini-4-argon-high", "agy", "Owner Argon High Fallback", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-argon-high", "antigravity/gemini-4-argon-high", "antigravity", "Slot-Farm Argon High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-argon-medium", "agy/gemini-4-argon-medium", "agy", "Owner Argon Medium Fallback", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-argon-medium", "antigravity/gemini-4-argon-medium", "antigravity", "Slot-Farm Argon Medium Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-argon-low", "agy/gemini-4-argon-low", "agy", "Owner Argon Low Fallback", ALL_AG_CONNS, 35000),
            make_step(f"{c}-antigravity-argon-low", "antigravity/gemini-4-argon-low", "antigravity", "Slot-Farm Argon Low Direct", ALL_AG_CONNS, 35000)
        ]
        cd["models"] = models
        cd["strategy"] = "task-aware"
        cd["config"] = patch_combo_config(cd.get("config", {}))
        cd["updatedAt"] = now_iso
        cursor.execute("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?", (json.dumps(cd), now_iso, c))
        print(f"[OK] Updated Opus combo {c} ({len(models)} models)")

sonnet_combos = [
    "claude-sonnet-5-5", "claude-sonnet-5-0", "claude-sonnet-4-6", "claude-sonnet-4-5",
    "smooth-code", "claude-auto", "claude-cache-opt", "rtk-omni", "rtk-omni-uiux", "strategist"
]

for c in sonnet_combos:
    row = cursor.execute("SELECT data FROM combos WHERE name = ?", (c,)).fetchone()
    if row:
        cd = json.loads(row[0])
        models = [
            make_step(f"{c}-agy-sonnet-5-5-high", "agy/claude-sonnet-5-5-high", "agy", "Antigravity Claude Sonnet 5.5 High (#1 Primary)", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-sonnet-5-5-high", "antigravity/claude-sonnet-5-5-high", "antigravity", "Antigravity Claude Sonnet 5.5 High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-opus-5-5-high", "agy/claude-opus-5-5-high", "agy", "Antigravity Claude Opus 5.5 High", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-opus-5-5-high", "antigravity/claude-opus-5-5-high", "antigravity", "Antigravity Claude Opus 5.5 High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-sonnet-5-5-medium", "agy/claude-sonnet-5-5-medium", "agy", "Antigravity Claude Sonnet 5.5 Medium", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-opus-5-5-medium", "agy/claude-opus-5-5-medium", "agy", "Antigravity Claude Opus 5.5 Medium", ALL_AG_CONNS, 45000),
            make_step(f"{c}-zunef-sonnet-5-5", "zunef/claude-sonnet-5-5", ZUNEF_PROV_ID, "Zunef Claude Sonnet 5.5 (Fast Fallback #1)", [ZUNEF_CONN_ID], 45000),
            make_step(f"{c}-zunef-opus-5-5", "zunef/claude-opus-5-5", ZUNEF_PROV_ID, "Zunef Claude Opus 5.5 (Heavy Fallback #2)", [ZUNEF_CONN_ID], 60000),
            make_step(f"{c}-agy-argon-medium", "agy/gemini-4-argon-medium", "agy", "Owner Argon Medium Fallback", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-argon-medium", "antigravity/gemini-4-argon-medium", "antigravity", "Slot-Farm Argon Medium Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-argon-high", "agy/gemini-4-argon-high", "agy", "Owner Argon High Fallback", ALL_AG_CONNS, 45000),
            make_step(f"{c}-antigravity-argon-high", "antigravity/gemini-4-argon-high", "antigravity", "Slot-Farm Argon High Direct", ALL_AG_CONNS, 45000),
            make_step(f"{c}-agy-argon-low", "agy/gemini-4-argon-low", "agy", "Owner Argon Low Fallback", ALL_AG_CONNS, 35000),
            make_step(f"{c}-antigravity-argon-low", "antigravity/gemini-4-argon-low", "antigravity", "Slot-Farm Argon Low Direct", ALL_AG_CONNS, 35000)
        ]
        cd["models"] = models
        cd["strategy"] = "task-aware"
        cd["config"] = patch_combo_config(cd.get("config", {}))
        cd["updatedAt"] = now_iso
        cursor.execute("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?", (json.dumps(cd), now_iso, c))
        print(f"[OK] Updated Sonnet combo {c} ({len(models)} models)")

fast_combos = ["rtk-omni-fast", "auto-ship-fast", "claude-haiku-4-5", "claude-haiku-5-5"]
for c in fast_combos:
    row = cursor.execute("SELECT data FROM combos WHERE name = ?", (c,)).fetchone()
    if row:
        cd = json.loads(row[0])
        models = [
            make_step(f"{c}-agy-sonnet-5-5-medium", "agy/claude-sonnet-5-5-medium", "agy", "Antigravity Claude Sonnet 5.5 Medium (#1 Primary)", ALL_AG_CONNS, 35000),
            make_step(f"{c}-antigravity-sonnet-5-5-low", "antigravity/claude-sonnet-5-5-low", "antigravity", "Antigravity Claude Sonnet 5.5 Low Direct", ALL_AG_CONNS, 35000),
            make_step(f"{c}-zunef-haiku-4-5", "zunef/claude-haiku-4-5", ZUNEF_PROV_ID, "Zunef Claude Haiku 4.5 Fallback", [ZUNEF_CONN_ID], 35000),
            make_step(f"{c}-zunef-sonnet-5-5", "zunef/claude-sonnet-5-5", ZUNEF_PROV_ID, "Zunef Claude Sonnet 5.5 Fallback", [ZUNEF_CONN_ID], 45000),
            make_step(f"{c}-agy-flash-38-high", "agy/gemini-3.8-flash-high", "agy", "Owner Gemini 3.8 Flash High", ALL_AG_CONNS, 35000),
            make_step(f"{c}-antigravity-flash-38-tiered", "antigravity/gemini-3.8-flash-tiered", "antigravity", "Slot-Farm Flash Tiered", ALL_AG_CONNS, 35000),
            make_step(f"{c}-agy-argon-low", "agy/gemini-4-argon-low", "agy", "Owner Argon Low Fallback", ALL_AG_CONNS, 35000)
        ]
        cd["models"] = models
        cd["strategy"] = "task-aware"
        cd["config"] = patch_combo_config(cd.get("config", {}))
        cd["updatedAt"] = now_iso
        cursor.execute("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?", (json.dumps(cd), now_iso, c))
        print(f"[OK] Updated Fast combo {c} ({len(models)} models)")

conn.commit()
conn.close()
print("[OK] All database updates completed successfully!")
