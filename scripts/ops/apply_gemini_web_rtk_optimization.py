#!/usr/bin/env python3
"""
apply_gemini_web_rtk_optimization.py
Enables Gemini Web Ultra (longtho) and adds gemini-web/gemini-4-argon & gemini-web/gemini-4-argon-high
into OmniRoute RTK combos and all primary combos for unmetered load offloading.
Updates taskAwareRouting.ts with precise scoring.
Follows the safe 4-step deployment protocol.
"""

import os
import sys
import json
import sqlite3
import subprocess
import time

OMNIROUTE_DIR = "/Users/macbookprom1/omniroute"
SQLITE_PATH = os.path.join(OMNIROUTE_DIR, "data/storage.sqlite")
TASK_AWARE_PATH = os.path.join(OMNIROUTE_DIR, "open-sse/services/taskAwareRouting.ts")
PLIST_PATH = "/Users/macbookprom1/Library/LaunchAgents/com.user.omniroute.plist"

GEMINI_WEB_CONN_ID = "9c3a1013-6a45-4ef5-b829-1a0529de8003" # longtho (Full cookie session for 4 Argon)

def run_cmd(cmd, check=True):
    print(f"[EXEC] {cmd}")
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and res.returncode != 0:
        print(f"[ERR] Failed code {res.returncode}: {res.stderr}")
    return res

def patch_database():
    print("=== 1. PATCHING SQLITE DATABASE ===")
    conn = sqlite3.connect(SQLITE_PATH)
    cursor = conn.cursor()

    # 1.1 Backup combos table
    cursor.execute("CREATE TABLE IF NOT EXISTS combos_bak_20261103_gemini_web AS SELECT * FROM combos;")
    print("  [BACKUP] Created table combos_bak_20261103_gemini_web")

    # 1.2 Activate Gemini Web Connection
    cursor.execute("UPDATE provider_connections SET is_active = 1, priority = 1 WHERE id = ?", (GEMINI_WEB_CONN_ID,))
    print(f"  [CONNECTION] Activated gemini-web connection {GEMINI_WEB_CONN_ID} (is_active=1)")

    # 1.3 Ensure model_capabilities for gemini-web & gemini-business
    web_models = [
        ("gemini-web", "gemini-4-argon", 1, 1, 1048576),
        ("gemini-web", "gemini-4-argon-high", 1, 1, 1048576),
        ("gemini-web", "gemini-3.1-pro", 1, 1, 1048576),
        ("gemini-web", "gemini-3.5-flash", 1, 1, 1048576),
        ("gemini-web", "gemini-3.1-flash-lite", 1, 1, 1048576),
        ("gemini-business", "gemini-3-pro", 1, 1, 1048576),
        ("gemini-business", "gemini-2.5-pro", 1, 1, 1048576),
        ("gemini-business", "gemini-2.5-flash", 1, 1, 1048576),
        ("gemini-business", "gemini-2.5-flash-thinking", 1, 1, 1048576),
    ]
    for prov, mid, tc, reas, ctx in web_models:
        cursor.execute("""
            INSERT OR REPLACE INTO model_capabilities (provider, model_id, tool_call, reasoning, limit_context)
            VALUES (?, ?, ?, ?, ?)
        """, (prov, mid, tc, reas, ctx))
    print(f"  [CAPABILITIES] Ensured {len(web_models)} model_capabilities for gemini-web and gemini-business")

    # 1.4 Update Combos with gemini-web targets
    cursor.execute("SELECT id, name, data FROM combos")
    rows = cursor.fetchall()
    updated_count = 0
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

    for cid, name, data_json in rows:
        data = json.loads(data_json)
        models = data.get("models", [])
        if not isinstance(models, list):
            continue

        # Check if combo already has gemini-web targets
        has_gemini_web = any(
            isinstance(m, dict) and "gemini-web" in str(m.get("model", ""))
            for m in models
        )
        if has_gemini_web:
            continue

        # We add gemini-web to combos that route Claude, Argon, or RTK-omni
        is_relevant = (
            "rtk-omni" in name or
            "claude" in name or
            "argon" in name or
            any("zunef" in str(m.get("model", "")) or "argon" in str(m.get("model", "")) for m in models if isinstance(m, dict))
        )
        if not is_relevant:
            continue

        slug = name.replace(" ", "-").replace("/", "-").lower()

        target_web_high = {
            "id": f"{slug}-gemini-web-argon-high",
            "kind": "model",
            "model": "gemini-web/gemini-4-argon-high",
            "providerId": "gemini-web",
            "label": "Gemini Web 4 Argon High (Unmetered Web Fallback)",
            "weight": 0,
            "targetTimeoutMs": 120000,
            "allowedConnectionIds": [GEMINI_WEB_CONN_ID],
            "connectionId": GEMINI_WEB_CONN_ID
        }

        target_web_med = {
            "id": f"{slug}-gemini-web-argon",
            "kind": "model",
            "model": "gemini-web/gemini-4-argon",
            "providerId": "gemini-web",
            "label": "Gemini Web 4 Argon (Unmetered Web Fallback)",
            "weight": 0,
            "targetTimeoutMs": 120000,
            "allowedConnectionIds": [GEMINI_WEB_CONN_ID],
            "connectionId": GEMINI_WEB_CONN_ID
        }

        # Ensure all existing targets have safe 120s timeout
        for m in models:
            if isinstance(m, dict):
                m["targetTimeoutMs"] = max(m.get("targetTimeoutMs", 0) or 0, 120000)

        # Append gemini-web targets at the end of the combo
        models.append(target_web_high)
        models.append(target_web_med)

        data["models"] = models
        data["updatedAt"] = now_iso

        cursor.execute("UPDATE combos SET data = ?, updated_at = ? WHERE id = ?", (json.dumps(data), now_iso, cid))
        updated_count += 1
        print(f"  [COMBO] Added gemini-web to: {name} (now {len(models)} targets)")

    conn.commit()
    conn.close()
    print(f"  [DONE] Updated {updated_count} combos in storage.sqlite")

def patch_task_aware_routing():
    print("=== 2. PATCHING taskAwareRouting.ts ===")
    with open(TASK_AWARE_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # 2.1 Model power score addition
    if "gemini-web/" not in content:
        old_power = 'else if (/\\b(sol|sonnet-5|sonnet-4|argon-medium|gemini-4-medium|deepseek-v4-pro|opus|glm-5|codex)\\b/i.test(id)) {'
        new_power = 'else if (/\\b(sol|sonnet-5|sonnet-4|argon-medium|gemini-4-medium|gemini-4-argon|deepseek-v4-pro|opus|glm-5|codex)\\b/i.test(id)) {'
        if old_power in content:
            content = content.replace(old_power, new_power, 1)
            print("  [OK] Patched modelPowerScore for gemini-4-argon")

    # 2.2 Patch scoreModelForTask sections:
    # A. isAdvise
    old_advise_block = """    if (modelLower === "agy/gemini-4-argon-low") return 800;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 790;
    return 700;"""

    new_advise_block = """    if (modelLower === "gemini-web/gemini-4-argon-high") return 1335;
    if (modelLower === "gemini-web/gemini-4-argon") return 885;
    if (modelLower === "agy/gemini-4-argon-low") return 800;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 790;
    return 700;"""

    if old_advise_block in content:
        content = content.replace(old_advise_block, new_advise_block, 1)
        print("  [OK] Patched isAdvise section with gemini-web")

    # B. isTier1Architect
    old_arch_block = """    if (modelLower === "agy/gemini-4-argon-low") return 900;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 890;
    return 800;"""

    new_arch_block = """    if (modelLower === "gemini-web/gemini-4-argon-high") return 1335;
    if (modelLower === "gemini-web/gemini-4-argon") return 1135;
    if (modelLower === "agy/gemini-4-argon-low") return 900;
    if (modelLower === "antigravity/gemini-4-argon-low" || modelLower === "gemini-4-argon-low") return 890;
    return 800;"""

    if old_arch_block in content:
        content = content.replace(old_arch_block, new_arch_block, 1)
        print("  [OK] Patched isTier1Architect section with gemini-web")

    # C. isTier3RoutineToolLoop
    old_tool_block = """    if (modelLower === "agy/gemini-4-argon-high") return 850; // Penalized!
    if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 840;
    return 800;"""

    new_tool_block = """    if (modelLower === "gemini-web/gemini-4-argon") return 1285; // Unmetered workhorse for routine tool loops
    if (modelLower === "gemini-web/gemini-4-argon-high") return 835;
    if (modelLower === "agy/gemini-4-argon-high") return 850; // Penalized!
    if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 840;
    return 800;"""

    if old_tool_block in content:
        content = content.replace(old_tool_block, new_tool_block, 1)
        print("  [OK] Patched isTier3RoutineToolLoop section with gemini-web")

    # D. Tier 2 (Coding / Multi-file)
    old_tier2_block = """  if (modelLower === "agy/gemini-4-argon-high") return 1050; // Backup
  if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 1040;"""

    new_tier2_block = """  if (modelLower === "gemini-web/gemini-4-argon") return 1265;
  if (modelLower === "gemini-web/gemini-4-argon-high") return 1035;
  if (modelLower === "agy/gemini-4-argon-high") return 1050; // Backup
  if (modelLower === "antigravity/gemini-4-argon-high" || modelLower === "gemini-4-argon-high") return 1040;"""

    if old_tier2_block in content:
        content = content.replace(old_tier2_block, new_tier2_block, 1)
        print("  [OK] Patched Tier 2 coding section with gemini-web")

    # E. General fallback score
    old_general_block = """  if (modelLower.startsWith("zunef/")) score += 500;
  else if (modelLower.startsWith("agy/")) score += 14;
  else if (modelLower.startsWith("antigravity/")) score += 10;"""

    new_general_block = """  if (modelLower.startsWith("zunef/")) score += 500;
  else if (modelLower.startsWith("agy/")) score += 14;
  else if (modelLower.startsWith("antigravity/")) score += 10;
  else if (modelLower.startsWith("gemini-web/")) score += 12;"""

    if old_general_block in content:
        content = content.replace(old_general_block, new_general_block, 1)
        print("  [OK] Patched general fallback score with gemini-web")

    with open(TASK_AWARE_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print("  [DONE] taskAwareRouting.ts written successfully")

def main():
    print("=== STARTING GEMINI WEB RTK OPTIMIZATION DEPLOYMENT ===")

    # Step 1: launchctl bootout
    print("\n--- Step 1: launchctl bootout ---")
    run_cmd("launchctl bootout gui/501/com.user.omniroute 2>/dev/null || true", check=False)
    time.sleep(2)
    run_cmd("killall node 2>/dev/null || true", check=False)
    time.sleep(1)

    # Step 2: Database & Code Patches
    patch_database()
    patch_task_aware_routing()

    # Step 3: Checkpoint WAL
    print("\n--- Step 3: sqlite3 wal_checkpoint(TRUNCATE) ---")
    conn = sqlite3.connect(SQLITE_PATH)
    res = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);").fetchall()
    conn.close()
    print(f"  [OK] PRAGMA wal_checkpoint(TRUNCATE) returned: {res}")

    # Step 4: launchctl bootstrap
    print("\n--- Step 4: launchctl bootstrap ---")
    run_cmd(f"launchctl bootstrap gui/501 {PLIST_PATH}")
    time.sleep(3)

    # Health check polling
    print("  Waiting for 127.0.0.1:20128/api/health...")
    for _ in range(15):
        h = run_cmd("curl -s http://127.0.0.1:20128/api/health", check=False)
        if "ok" in h.stdout:
            print("  [ONLINE] OmniRoute is UP and healthy!")
            break
        time.sleep(1)
    else:
        print("  [WARN] Health check did not return ok within 15s")

    print("\n=== DEPLOYMENT COMPLETE ===")

if __name__ == "__main__":
    main()
