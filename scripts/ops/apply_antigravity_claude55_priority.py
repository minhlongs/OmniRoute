import sqlite3
import json
import datetime

DB_PATH = "/Users/macbookprom1/omniroute/data/storage.sqlite"

SLOT_FARM_AGY_CONNS = [
    "ac0b226d-44fa-4e2c-ad36-8ccc7b90dd7a",  # billwill
    "0085d792-025d-43d5-9f7e-562a33c44873",  # longtho
    "dc96ba4d-7213-46b4-8964-56a31f586420",  # cashback
    "bdaf9d9b-c524-4e4e-b0b4-a76207fe535d",  # ntnha
]

SLOT_FARM_ANTIGRAVITY_CONNS = [
    "a66a2b56-a930-49eb-ad0e-236383fd5b89",  # billwill
    "5f5455c0-d8ad-489c-8868-2c9df2008ee1",  # longtho
    "38f1c262-1b86-475d-8780-79c271dd41ca",  # cashback
    "bdaf9d9b-c524-4e4e-b0b4-a76207fe535c",  # ntnha IDE
    "c1ba716a-939e-4a61-9c16-56a297e6e58b",  # ntnha
    # also allow CLI IDs in antigravity pool for cross-fallback
    "ac0b226d-44fa-4e2c-ad36-8ccc7b90dd7a",
    "0085d792-025d-43d5-9f7e-562a33c44873",
    "dc96ba4d-7213-46b4-8964-56a31f586420",
    "bdaf9d9b-c524-4e4e-b0b4-a76207fe535d",
]

MINHLONG_CONNS = [
    "6a920176-52d7-4f67-9c08-32aa8c25a119",
    "e4aeb3eb-d9d8-4a34-b625-c16835c29cf7",
]

ALL_SLOT_FARM = list(set(SLOT_FARM_AGY_CONNS + SLOT_FARM_ANTIGRAVITY_CONNS))

def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # 1. Update provider_connections
    for cid in ALL_SLOT_FARM:
        cursor.execute("""
            UPDATE provider_connections
            SET priority = 1,
                is_active = 1,
                rate_limited_until = NULL,
                updated_at = datetime('now')
            WHERE id = ?
        """, (cid,))
        print(f"Set connection {cid} priority=1, active=1, rate_limited_until=NULL")

    for cid in MINHLONG_CONNS:
        cursor.execute("UPDATE provider_connections SET is_active = 0, updated_at = datetime('now') WHERE id = ?", (cid,))
        print(f"Ensured Pro connection {cid} is_active=0")

    # 2. Update key_value providerStrategies
    cursor.execute("SELECT value FROM key_value WHERE key = 'providerStrategies'")
    row = cursor.fetchone()
    strategies = json.loads(row[0]) if row and row[0] else {}
    strategies["antigravity"] = {"fallbackStrategy": "round-robin", "stickyRoundRobinLimit": 1}
    strategies["agy"] = {"fallbackStrategy": "round-robin", "stickyRoundRobinLimit": 1}
    cursor.execute("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'providerStrategies', ?)", (json.dumps(strategies),))
    print("Updated providerStrategies: antigravity & agy -> round-robin, stickyRoundRobinLimit=1")

    # 3. Update combos
    cursor.execute("SELECT id, name, data FROM combos")
    combos = cursor.fetchall()

    def model_name(m):
        return m.get("model", "") if isinstance(m, dict) else str(m)

    def get_priority(m):
        name = model_name(m).lower()
        if ("agy/" in name or "antigravity/" in name) and ("claude-opus-5-5" in name or "claude-sonnet-5-5" in name):
            return 1
        if "zunef/" in name and ("claude-opus-5-5" in name or "claude-sonnet-5-5" in name):
            return 2
        if "argon" in name or "gemini-4" in name:
            return 3
        return 4

    # Template legs for Antigravity Claude
    ag_claude_template = [
        {
            "model": "agy/claude-opus-5-5-high",
            "providerId": "agy",
            "allowedConnectionIds": SLOT_FARM_AGY_CONNS,
            "targetTimeoutMs": 120000
        },
        {
            "model": "antigravity/claude-opus-5-5-high",
            "providerId": "antigravity",
            "allowedConnectionIds": SLOT_FARM_ANTIGRAVITY_CONNS,
            "targetTimeoutMs": 120000
        },
        {
            "model": "agy/claude-sonnet-5-5-high",
            "providerId": "agy",
            "allowedConnectionIds": SLOT_FARM_AGY_CONNS,
            "targetTimeoutMs": 120000
        },
        {
            "model": "antigravity/claude-sonnet-5-5-high",
            "providerId": "antigravity",
            "allowedConnectionIds": SLOT_FARM_ANTIGRAVITY_CONNS,
            "targetTimeoutMs": 120000
        },
        {
            "model": "agy/claude-opus-5-5-medium",
            "providerId": "agy",
            "allowedConnectionIds": SLOT_FARM_AGY_CONNS,
            "targetTimeoutMs": 120000
        },
        {
            "model": "agy/claude-sonnet-5-5-medium",
            "providerId": "agy",
            "allowedConnectionIds": SLOT_FARM_AGY_CONNS,
            "targetTimeoutMs": 120000
        }
    ]

    reordered_count = 0
    for cid, name, data_raw in combos:
        data = json.loads(data_raw)
        models = data.get("models", [])
        has_zunef55 = any("zunef/" in model_name(m) and ("claude-opus-5-5" in model_name(m) or "claude-sonnet-5-5" in model_name(m)) for m in models)
        if not has_zunef55:
            continue

        # Check if it has any agy/antigravity claude legs
        has_ag_claude = any(("agy/" in model_name(m) or "antigravity/" in model_name(m)) and ("claude-opus-5-5" in model_name(m) or "claude-sonnet-5-5" in model_name(m)) for m in models)
        if not has_ag_claude:
            print(f"Injecting Antigravity Claude legs into combo {name}")
            models = ag_claude_template + models

        # Ensure allowedConnectionIds on any agy/antigravity claude legs includes all slot-farm accounts
        for m in models:
            if isinstance(m, dict):
                mname = m.get("model", "")
                if mname.startswith("agy/claude-") and ("5-5" in mname):
                    m["allowedConnectionIds"] = SLOT_FARM_AGY_CONNS
                elif mname.startswith("antigravity/claude-") and ("5-5" in mname):
                    m["allowedConnectionIds"] = SLOT_FARM_ANTIGRAVITY_CONNS

        sorted_models = sorted(models, key=get_priority)
        orig_names = [model_name(m) for m in models]
        new_names = [model_name(m) for m in sorted_models]

        data["models"] = sorted_models
        cursor.execute("UPDATE combos SET data = ?, updated_at = datetime('now') WHERE id = ?", (json.dumps(data), cid))
        reordered_count += 1
        print(f"Updated combo {name} ({cid}): top={new_names[:3]}")

    conn.commit()
    conn.close()
    print(f"Done! Updated {reordered_count} combos successfully.")

if __name__ == "__main__":
    main()
