# OmniRoute Update Plan — v3.8.49 → v3.8.50

> Execute AFTER reading SESSION-STATE-2026-08-09.md. Repo: ~/omniroute-src (branch release/v3.8.50)

## Diff summary
- **1874 commits** giữa v3.8.49 (container đang chạy) và release/v3.8.50 (repo clone)
- Điểm nổi bật (top commits):
  - `fix(providers): per-provider opt-out for anonymous no-auth fallback (opencode-go/zen 401s)` — LIÊN QUAN trực tiếp vấn đề opencode 401 của ta!
  - `feat(responses): add encrypted reasoning replay opt-in`
  - `fix(translator): preserve Kimi K3 Responses reasoning`
  - `fix(settings): use provider prefixes in model overrides`
  - `fix(db): resolve ccr migration version collision`
  - Hàng loạt "conflict-resolved fallback" fixes (fallback pipeline)

## Cách update an toàn (3 bước)

### Bước 1: Backup data container hiện tại
```bash
docker commit omniroute omniroute:with-data-v3849   # snapshot TRƯỚC khi update
docker cp omniroute:/app/data/storage.sqlite ~/omniroute-src/session-notes/storage-v3849.sqlite
```

### Bước 2: Pull image mới + chạy
```bash
docker pull diegosouzapw/omniroute:latest
docker rm -f omniroute
docker run -d --name omniroute -p 20128:20128 --restart unless-stopped \
  -e OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1 \
  -e RATE_LIMIT_MAX_WAIT_MS=120000 \
  diegosouzapw/omniroute:latest
```

### Bước 3: Kiểm tra + restore config nếu cần
```bash
# 1. Login + đếm combos/providers (data trong container layer — nếu mất, restore từ sqlite backup)
curl -s -X POST localhost:20128/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@local","password":"OmniRoute-Admin-2026"}' -c /private/tmp/omni_cookies.txt
curl -s -b /private/tmp/omni_cookies.txt localhost:20128/api/combos | grep -c claude
# Kỳ vọng: 16 combos, 4 providers, admin login OK

# 2. Nếu DB mới trống (data mất):
docker cp ~/omniroute-src/session-notes/storage-v3849.sqlite omniroute:/app/data/storage.sqlite
docker restart omniroute

# 3. Verify end-to-end (fable-5 qua zuneF)
curl -s localhost:20128/api/v1/messages -H 'Content-Type: application/json' \
  -H 'x-api-key: sk-b9eb30e8d08b6389-bdc6e3-a980fe1f' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-fable-5","max_tokens":20,"messages":[{"role":"user","content":"hi"}]}'
# Kỳ vọng: 200, model: claude-fable-5

# 4. Re-apply các config KHÔNG nằm trong DB (env container):
#    - OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1 (đã có trong docker run)
#    - Resilience concurrent=3/rpm=90 (lưu trong DB key_value — giữ nếu DB giữ)
#    - customUserAgent=node (lưu trong provider_specific_data — giữ nếu DB giữ)
```

## Kiểm tra sau update
- [ ] 16 combos nguyên vẹn (fable-5, opus×6, sonnet×2, sonnet-4-5, zunef×6)
- [ ] 4 providers (zuneF, DeepSeek, OpenCode, mimocode)
- [ ] zuneF customHeaders + customUserAgent=node còn
- [ ] mapping claude-haiku-4-5 → sonnet-4-5 còn
- [ ] fable-5 200 qua zuneF
- [ ] 10 tab test: 10/10 OK 0 crash
- [ ] `opencode-zen 401 fix` (commit #9675) — test opencode free lại, có thể giờ dùng được!
- [ ] Compression settings (RTK/Caveman) — kiểm tra có reset không

## Nếu update lỗi (rollback)
```bash
docker rm -f omniroute
docker run -d --name omniroute -p 20128:20128 --restart unless-stopped omniroute:with-data-v3849
# hoặc đơn giản: docker start omniroute (nếu chưa rm)
```

## Nguồn free tier cần thử (sau update — có thể fix #9675 mở lại opencode)
1. `opencode-zen/deepseek-v4-flash-free` — test 429 còn không
2. `agentrouter/claude-haiku-4-5-20251001` (200M one-time) — POST /api/providers (cần key agentrouter.org — $200 free signup)
3. `agy/gemini-3.6-flash-low` (keyless) — cần connection agy (OAuth wizard)
4. `api-airforce/google/gemini-2.5-flash` (recurring-daily)
5. `bazaarlink/claude-haiku-4.5` (recurring-daily)

Mỗi provider thêm xong: test 200 trước khi đưa vào combo. KHÔNG thêm provider chưa verify.

## ✅ ĐÃ LÀM (16:37 UTC) — Dahl Free Tier (100M tokens)
- **Dahl**: POST /api/dahl/tokens → auto-gen token `dahl_...` (100M tokens free, MiniMax M2.7 + Kimi K2.6)
- POST /api/providers {"provider":"dahl","name":"Dahl Free","apiKey":"<token>"} → connection `abba8a57-d2d1-4834-be49-75233473795f`, test valid 337ms
- 2 combo mới: `dahl-minimax` (3e84a427) + `dahl-kimi` (c1ac79ec) — đều 200 end-to-end qua /api/v1/messages
- 18/18 combos gán compression default-caveman
- GHI CHÚ: POST /api/providers CHỈ admit: FREE_APIKEY_PROVIDER_IDS (qoder/mimocode/opencode/dahl/codebuddy-cn/auggie) + compatible prefix. theoldllm/aihorde/chipotle (noauth) KHÔNG add được qua API — chỉ dashboard wizard.

## ✅ ĐÃ LÀM (16:41 UTC) — Phân luồng auto + Dahl vào ladder fable-5
- **Cơ chế phân luồng đa tab CỦA OmniRoute**: semaphore per-model (`concurrencyPerModel` default 3) → model bận thì queue → `queueTimeoutMs` (8s) → **tự failover model kế**. 429 → mark rate-limited cả phiên. Strategies: priority/weighted/round-robin/least-used/cost-optimized/p2c/auto/headroom... (19 loại, src/shared/constants/routingStrategies.ts, dispatch trong open-sse/services/combo.ts)
- **Combo `claude-fable-5` (19 models)**: config `{compressionMode: stacked, concurrencyPerModel: 3, queueTimeoutMs: 8000, failoverBeforeRetry: true}`. Ladder: 0-8 zuneF claude → 9-14 zuneF non-claude (deepseek/minimax/qwen/kimi/glm) → 15 DeepSeek API → **16-17 Dahl (Kimi-K2.6, MiniMax-M2.7)** → 18 opencode-free (cuối, hay 429)
- **Verify đa tab**: 8 request song song → 7 đi zuneF + 1 tự tràn DeepSeek (zuneF bận concurrent) — failover auto chạy đúng
- Lưu ý: `queueDepth` chỉ áp dụng round-robin (bị strip khi set priority) — muốn failover nhanh hơn có thể đổi strategy round-robin + queueDepth 0-2

## ⚠️ BUG PHÁT HIỆN + FIX (16:50 UTC) — Claude Code văng do wedge queue
- **Triệu chứng**: Claude Code thoát đột ngột (0 crash report, 0 jetsam — KHÔNG phải RAM/Docker; RAM 95% free)
- **Nguyên nhân**: `concurrencyPerModel: 3` trên combo CHỒNG LÊN global rate-limit queue (resilience concurrent=3) → 2 lớp quản lý concurrent race → `WEDGED: queued=2 running=0 executing=0 stalled=141418ms` → force-reset → 502 → Claude Code exit. Chỉ 1 lần trong log, đúng lúc test 8 parallel.
- **Fix**: BỎ `concurrencyPerModel` khỏi combo config (giữ global resilience concurrent=3 — vốn ổn định cả ngày 10 tab). Verify: 8 parallel → 8/8 thành công, 0 wedge, tất cả đi zuneF.
- **KẾT LUẬN**: KHÔNG bật concurrencyPerModel song song với global resilience queue cùng giá trị. Nếu cần failover-theo-bận: đổi hẳn sang round-robin (semaphore per-model riêng) — không trộn 2 lớp trên priority.
- Config fable-5 hiện tại: `{compressionMode: stacked, failoverBeforeRetry: true}` — failover khi zuneF thật sự fail, không khi bận.

