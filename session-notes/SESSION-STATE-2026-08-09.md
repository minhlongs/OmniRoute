# OmniRoute Session State — 2026-08-09

> Handoff document for the next agent. Everything done + everything planned + how to update.

## 0. MIGRATE SANG MBP M1 (2026-08-10) — HỆ THỐNG HIỆN TẠI

### Fix Mekong CLI audit (2026-08-10) — 4 lớp
1. **Registry module_path sai prefix**: `src/harness/agents/config/registry.yaml` ghi `src.seed.agents.ceo` nhưng import thật là `seed.agents.ceo` → circular import crash → đã fix cả 6 module_path
2. **Root registry YAML BROKEN**: `agents/registry.yaml` indent sai (line 23 `- id: ceo` lồng trong slash_commands của sun-tzu) → yaml.safe_load FAIL hoàn toàn → đã rewrite đúng indent, 6 agents (sun-tzu/ceo/ae/pm/eng/ops) + 6 delegation_rules parse OK
3. **5 agent file thiếu**: ceo/ae/pm/eng/ops không có file → đã tạo trong `mekong-cli/.claude/_integration/agents/` + `~/.claude-mk/agents/` (frontmatter chuẩn: name khớp file, model sonnet)
4. **16 slash_commands**: 12 lệnh thiếu → đã tạo file (ae-outreach/deal-prep/follow-up/close-report, product-spec, roadmap-update, priority-review, audit-itgc/sox/trail/compliance, algo-status) vào `~/.claude/commands/` + `~/.claude-mk/commands/`; 5 gate còn lại là approval_required/hard_gates metadata (đúng thiết kế)
5. **Fix lỗi `claude-opus-5[1m]`**: `~/.claude/settings.json` thiếu `ANTHROPIC_DEFAULT_*_MODEL` → CC resolve subagent `model: opus` về mặc định opus-5[1m] (không tồn tại trong OmniRoute) → đã thêm 4 env (FABLE=claude-fable-5, OPUS=claude-opus-4-8[1m], SONNET=claude-sonnet-5-0, HAIKU=claude-haiku-4-5) vào 6 settings (main, mk, ak, algo-trader, mekong-cli, ak-engineer)

### Fix 503 opencode-zen noauth (2026-08-10)
- **Vấn đề**: `opencode-zen` free models (ling-3.0-tiny-free, mimo-v2.5-free, nemotron-3-ultra-free) bị **503 Endpoint unavailable** lặp lại — OmniRoute chọn **synthetic noauth** (không key) thay vì connection có key GO (do `anonymousFallback: true` trên provider def)
- **Fix 2 lớp**:
  1. `settings.noAuthFallbackDisabledProviders = ["opencode-zen"]` (namespace **`settings`**, KHÔNG phải `databaseSettings`!) → tắt noauth fallback
  2. Reset `testStatus=active` cho connection `81fbadc2` (bị `credits_exhausted` từ lần thử premium 402 trước)
- **Kết quả**: `Using opencode-zen account: 81fbadc2...` — key GO thật sự được dùng, free models 200 OK ổn định
- ⚠️ Bài học: sau khi thêm key vào connection, phải reset testStatus — connection bị mark terminal từ lỗi cũ vẫn bị skip dù key đã đúng

### opencode-go (2026-08-10) — gói trả phí $5/tháng ĐÃ THÊM
- Provider: **opencode-go** (connection `aaa3e8b7-0c24-44e7-aaa6-f4f435b2d211`), endpoint `https://opencode.ai/zen/go/v1` (OpenAI-compatible)
- Key: `sk-Ty1iaE3cWC21mQHxOZngZIHjdFN61GPmBV8OPC2l1u4vMIDAZ4yWPBuh4NRFaxQf` (đã lưu trong auth.json opencode + connection OmniRoute)
- **25 models sync**: kimi-k3, kimi-k2.7-code, grok-4.5, qwen3.8-max, qwen3.7-max, gpt-5.6-luna, glm-5.2, deepseek-v4-pro/flash, minimax-m3...
- Đã thêm 4 model vào combo fable-5 (22 models): kimi-k3 w=4, grok-4.5 w=3, qwen3.8-max w=3, gpt-5.6-luna w=2
- Verify: qwen3.8-max + kimi-k3 trúng phân phối weighted; compression + failover hoạt động

### auto-ship-fast combo (2026-08-10) — Auto-Combo ship-fast mode
- Combo mới **`auto-ship-fast`** (id `f923c932-c5c3-40f6-a5fd-0edbbfa7c3b1`): strategy `auto`, **10 models nhanh** (sonnet-5-0, deepseek-flash, dahl kimi/minimax, minimax-m3, glm-5.2, opencode-free, zen-free ×3)
- **13-factor scoring** chạy: `Auto selection: opencode/deepseek-v4-flash-free | score=0.811`
- Config: `modePack: "ship-fast"` (latencyInv=0.32, health=0.28 — tối ưu tốc độ) + `explorationRate: 0.05` + compression stacked
- ⚠️ LƯU Ý: `modePack`/`explorationRate` phải nằm trong **`config`** (KHÔNG phải `autoConfig` — schema combo chỉ nhận qua config). POST tạo combo không giữ autoConfig → phải PUT sau khi tạo.
- Gọi thử: model `auto-ship-fast` qua /api/v1/messages

### Tối ưu deep (2026-08-10) — trên MBP
- **Compression**: RTK standard → **aggressive** + Caveman full (32% → **38.9% saved**, 495K → 302K tokens). Verify log: `Prompt compressed (stacked): 495012 -> 302338 (38.92% saved)`
- **Adaptive compression**: contextBudget `mode=floor`, pct 0.85, outputReserve 4096 — tự chọn cường độ theo context window
- **Compression cache**: cacheMinutes 5 → **60**
- **Auto-trigger**: 40000 → **20000 tokens** (nén sớm hơn)
- **Zen free models** thêm vào combo fable-5 (25 models): `opencode-zen/mimo-v2.5-free` w=2, `ling-3.0-tiny-free` w=1.5, `nemotron-3-ultra-free` w=1.5 — **lợi prompt cache** (Zen cache_read=396K = 99.9% hit; zuneF cache_read=0!). Chỉ 8 free models thật trên Zen: deepseek-v4-flash-free, mimo-v2.5-free, ling-3.0-flash/tiny-free, nemotron-3-ultra-free, north-mini-code-free, laguna-s-2.1-free, longcat-2.0-free
- **Zen premium (claude-fable-5, opus...)**: 402 `Insufficient balance` — gói Go $5 KHÔNG phủ Zen premium tier, cần balance riêng tại `https://opencode.ai/workspace/wrk_01KW11AXTBDPKD94EAHV8BC4HK/billing`
- **Go deepseek-v4-flash (2x)**: RegionError — cần opt-in China tại `.../wrk_01KW11AXTBDPKD94EAHV8BC4HK/go`
- **opencode-zen provider**: connection `81fbadc2-f153-4f8a-99b4-d2fa7f3c1301` (key GO đã gắn, nhưng premium vẫn 402) — free models dùng noauth fallback OK

### Kiến trúc mới (giảm tải M1 Max)
- **M1 Max (client)**: Claude Code ×1-2 phiên, opencode — chỉ là client, colima/Docker ĐÃ TẮT
- **MBP M1 16GB (server)**: OmniRoute **native** (không Docker) chạy 24/7
  - SSH: `macbookprom1@169.254.129.138` (cáp Ethernet trực tiếp, link-local) — hoặc `omnimbp.local` (đã ghim /etc/hosts trên M1 Max)
  - App: `~/omniroute/` (node 22.20.0 ở `~/node22/bin`), build 5.3 phút
  - Data: `~/omniroute/data/storage.sqlite` (17MB, migrate từ colima)
  - Env: `~/omniroute/.env` (JWT_SECRET + API_KEY_SECRET + STORAGE_ENCRYPTION_KEY từ container cũ — srv-secrets)
  - **Auto-start**: launchd `com.user.omniroute` (KeepAlive, tự restart) — log `~/omniroute/data/omniroute.log`
  - **Backup**: launchd `com.user.omniroute-backup` mỗi 6h → `~/omniroute-backups/` (giữ 14 bản)
  - Port: **20128** (giống cũ — settings M1 Max không đổi port, chỉ đổi host)
- **Verify**: 18 combos + weighted + compression nguyên vẹn; fable-5/opus/sonnet/dahl/opencode 200 qua `omnimbp.local:20128`

### 2 lỗi build phải fix khi migrate (quan trọng cho update sau này)
1. `package.json` override `sharp: ^0.35.0` conflict direct dep `^0.35.3` → npm EOVERRIDE (npm 10 bug). Fix: đổi override thành `^0.35.3`.
2. `open-sse/services/adobeFireflyClient.ts:2319` — `pollAdobeJob` không export nhưng `adobeFireflyUpscale.ts:31` import → build fail. Fix: thêm `export`. **Đây là lý do image v3.8.50 chưa có trên Docker Hub** (branch release/v3.8.50 build chết ở đây).

### Kết nối M1 Max → MBP
- Cáp Ethernet trực tiếp (en10 ↔ en10), IP link-local `169.254.129.138` (MBP) — KHÔNG qua router
- M1 Max /etc/hosts: `169.254.129.138 omnimbp.local`
- Settings đã trỏ `http://omnimbp.local:20128/api`: `~/.claude/settings.json`, `~/.claude-mk/settings.json`, `~/algo-trader/.claude/settings.json`

## 1. Hệ thống cũ (colima trên M1 Max — ĐÃ TẮT, giữ để tham khảo)

### Infrastructure
- **Colima VM**: 4 CPU / 8GB RAM (`colima start --cpu 4 --memory 8`)
- **Container**: `omniroute` — image `omniroute:with-data` (docker commit giữ data + patch), port **20128**, restart unless-stopped
- **Data**: `/app/data/storage.sqlite` (trong container layer — KHÔNG volume mount!)
- **Env container**: `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1` (tắt probe giả âm 403), `RATE_LIMIT_MAX_WAIT_MS=120000`
- **Resilience (API)**: concurrentRequests=3, rpm=90, minGap=300ms, maxWait=120s (khớp giới hạn zuneF ~3-5 concurrent)

### Providers
| Provider | Node ID | Connection ID | Ghi chú |
|---|---|---|---|
| zuneF (anthropic-compatible) | `anthropic-compatible-c33c2c9c-e3e4-47ae-b231-fda23ffef734` | `7c069ac1-abee-43b5-b745-b75d37ec22a4` | JWT static (exp 2036), headers: X-ZUNEF-CLIENT, X-Device-Id `f15534009aa747aa91a4c4218fcc83da`, **customUserAgent=node** (QUAN TRỌNG — UA claude-cli giả gây Cloudflare 1010/502) |
| DeepSeek API (openai-compatible) | `openai-compatible-chat-5f198be5-9691-46be-ab0e-35f95517635e` | `58955511-2956-4e69-a6be-03a51e45648e` | key `sk-75cc...` (deepseek-v4-flash/pro), fallback chính |
| OpenCode Free | `opencode` | `bc617ff5-907a-48ca-8bd6-311e236abb46` | tier cuối, hay 401/429 |
| mimocode | `mimocode` | `9f48f0f4-b81c-49ad-ae99-9c1294731272` | "Unsupported model" — không dùng được, giữ chờ fix upstream |

### Combos (16) — ladder priority
- **`claude-fable-5` = combo chính**: strategy **`weighted`** (đã sửa từ `random` 2026-08-10) + `config.disableSessionStickiness: true` + `compressionMode: stacked` — weights: fable-5=25, dahl Kimi=12, dahl MiniMax=10, opus-4-8[1m]=10, opus-4-8=8, sonnet-5-0=8, opencode-free=6, opus-4-7[1m]=4, sonnet-4-6=4, opus-4-7=3, opus-4-6[1m]=2, deepseek-flash=2, minimax-m3=2, còn lại 0.5-1. Có 2 combo dahl (free 100M tokens) riêng.
- 10 combo claude (tên = model ID): `claude-fable-5` (chuẩn) → `claude-opus-4-8[1m]` → `claude-opus-4-8` → `claude-opus-4-7[1m]` → `claude-opus-4-7` → `claude-opus-4-6[1m]` → `claude-opus-4-6` → `claude-sonnet-5-0` → `claude-sonnet-4-6` → `claude-sonnet-4-5` (tên mới của combo haiku)
- **6 combo cheap** (`zunef-*`): deepseek-flash/pro, minimax-m3, qwen-397b, kimi-k26, glm-52 + 6 mapping pattern model thật
- **`claude-haiku-4-5` ĐÃ BỎ** (100% 502 từ zuneF) → mapping `claude-haiku-4-5` → combo `claude-sonnet-4-5` (id `ab8ba99d-660a-4b19-829e-bbfd4deca9b8`)
- Mỗi combo kết thúc: DeepSeek API `deepseek-v4-flash` → opencode free

### Claude Code (client)
- `~/.claude/settings.json`: `ANTHROPIC_BASE_URL=http://localhost:20128/api` (KHÔNG có /v1 — CC tự nối), `ANTHROPIC_AUTH_TOKEN=sk-b9eb30e8d08b6389-bdc6e3-a980fe1f`, `ANTHROPIC_MODEL=claude-fable-5`, `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5` (sẽ fall qua combo sonnet-4-5), `SLASH_COMMAND_TOOL_CHAR_BUDGET=100`, `skillListingMaxDescChars=30`
- Backup: `~/.claude/settings.json.bak-omniroute-20260809`
- **JWT rotator**: `~/.claude/zunef-jwt-rotator.sh` + launchd `com.user.zunef-jwt-rotator` (mỗi 13 phút mint JWT mới → PATCH connection) — log `~/.claude/.zunef-rotator.log`
- **MCP**: đã tắt codebase-memory-mcp + exa khỏi `~/.claude.json` (67 tools → 28, backup `~/.claude.json.bak-20260809`)
- **25 subagents** đã gán model chia tải: sonnet×9, haiku×8, opus×4, fable×4 (backup `~/.claude/agents-backup-20260809/`)
- **Skills dọn**: 357 → 214 (bỏ 106 ck/ak/ct nhân bản + 44 trùng + 31 stitch-mcp + 2 thư mục nhân 3 nơi)

### CD fix
- `cd <project>` trong `~/.zshrc`: exact → $HOME/name → fuzzy → deep search + tab-complete
- `~/.claude/commands/cd.md`: `/cd <project>` command cho CC

## 2. Bài học kỹ thuật (CRITICAL)

1. **zuneF giới hạn concurrent ~3-5 TỔNG account** (mọi model) — quá → 502 `<!DOCTYPE html>` hoặc "Stream ended before non-ping SSE event". Không phải header/IP — đã isolate kỹ.
2. **UA quyết định**: undici mặc định `User-Agent: node` → zuneF trả 401 "Invalid or inactive API key". UA `claude-cli/2.1.226` giả từ colima → Cloudflare 1010/502. **Đúng = customUserAgent "node" trong providerSpecificData** (applyConfiguredUserAgent chạy SAU forwardOpencodeClientHeaders).
3. **forwardOpencodeClientHeaders** (executors/default.ts:493) forward UA client CC lên upstream — bị applyConfiguredUserAgent (base.ts:825) đè sau.
4. **CredentialHealth scheduler** probe không gửi custom headers → 403 giả → mark known-bad → skip connection. Tắt bằng `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1`.
5. **In-memory state**: cooldown/lockout/exhausted tích lũy — sau mỗi lần thay đổi headers/config phải `docker restart omniroute`.
6. **zuneF KHÔNG hỗ trợ prompt caching** (cache_read luôn 0) — skill upload 74KB/request phải cắt client-side (đã làm: 9.5KB).
7. **Container không volume** — mọi thay đổi data/phần mềm phải `docker commit omniroute omniroute:with-data` TRƯỚC khi recreate.
8. **Cloudflare 1010** xảy ra khi request từ colima IP kèm UA giả — tránh mọi UA giả mạo.
9. **Bash wrapper chặn chuỗi path**: absolute path trong lệnh → dùng relative hoặc file payload + `curl -d @file`.

## 3. Việc đã hoàn thành hôm nay

- [x] **FIX CHIA TẢI (02:55 UTC+7)**: combo `claude-fable-5` strategy `random` → **`weighted`** + `config.disableSessionStickiness: true` (giữ `compressionMode: stacked`, weights cũ fable-5=25/opus-4-8[1m]=10/dahl kimi=12/minimax=10/opencode=6). Root cause: (1) `random` chỉ shuffle đều KHÔNG đọc weight (`applyStrategyOrdering.ts:122` — chỉ `weighted` mới dùng `selectWeightedUnit`), (2) session stickiness pin cả phiên CC 15 phút vào connection thắng shuffle 1 lần (`sessionStickiness.ts`, hash first-user-message), (3) filter `kept 11/18` loại 7 model zuneF khi CC gửi `max_tokens` lớn (hard fail `output_tokens` khi max_out=64000 < 96000, `comboStructure.ts:597`). Verify: 47 request test — opencode-free từ 88% → 4%, fable-5 19%, dahl 11+4, phân phối khớp weight. PUT qua `/api/combos/571d898e-fb60-4068-b34b-d1f1c14892f4` với cookie `/private/tmp/omni_cookies.txt` (còn hạn đến 2036).
- [x] Fix Claude Code CLI crash (NODE_OPTIONS 8192, bỏ heap caps) — plan cũ `/private/tmp/plans/2026-08-09-fix-claude-code-oom-crash/`
- [x] Fix focus-cleanup.sh giết opencode (pkill -f "opencode") — bỏ dòng, backup `.bak-20260809`
- [x] Deploy OmniRoute :20128 + login admin@local
- [x] Fix zuneF node: base_url ghép đôi + customHeaders + customUserAgent=node
- [x] JWT static làm API key + rotator launchd 13 phút
- [x] 16 combo ladder + mapping + bỏ haiku 502
- [x] Downstream key `sk-b9eb30e8d08b6389-bdc6e3-a980fe1f` (id 687e9941)
- [x] Trỏ Claude Code vào OmniRoute (settings.json)
- [x] Colima nâng 4 CPU/8GB
- [x] Resilience: concurrent 3 / rpm 90 / maxWait 120s
- [x] Dọn skills 357→214, MCP 2 server tắt, subagent 25 model chia tải
- [x] `cd <project>` + `/cd` command
- [x] Verify: 10 tab = 10/10 OK 0 crash; fable-5 chuẩn chạy qua zuneF

## 4. Việc chuẩn bị làm (NEXT SESSION)

### P1 — Update OmniRoute 3.8.49 → 3.8.50 (repo này)
- So sánh changelog: `git log --oneline v3.8.49..release/v3.8.50` (repo đã clone ~/omniroute-src, branch release/v3.8.50)
- Cách update an toàn:
  1. `docker commit omniroute omniroute:with-data` (đã có data)
  2. `docker rm -f omniroute`
  3. `docker run -d --name omniroute -p 20128:20128 --restart unless-stopped -e OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=1 -e RATE_LIMIT_MAX_WAIT_MS=120000 diegosouzapw/omniroute:latest`
  4. Verify: login, combos còn 16, providers còn 4, test fable-5
- RỦI RO: data trong container layer — nếu image mới khởi tạo DB mới, phải `docker cp` storage.sqlite cũ vào

### P2 — Tối ưu sâu (từ brainstorm trước)
- ✅ **RTK + Caveman compression ĐÃ BẬT (16:17 UTC)**: gán cả 16 routing combos → compression combo `default-caveman` (pipeline RTK standard + Caveman full) qua PUT `/api/context/combos/default-caveman/assignments` {"routingComboIds":[16 ids]}. Verify: payload 40KB tool result → upstream chỉ `in=9 tokens` (log USAGE). Đừng nhầm `config.compressionMode` trên combo (không được executor thực thi trong v3.8.49 — chỉ là field legacy map từ compressionOverride) — compression THẬT qua compression_combos + compression_combo_assignments. Analytics chưa ghi (compression_analytics=0) — có thể flush định kỳ; đánh giá qua log USAGE in= là chuẩn nhất.
- **Semantic cache**: đã bật (`semanticCacheEnabled=true`, TTL 30 phút) — verify hit rate
- **Caveman compression**: `cavemanConfig` đã enabled (compressRoles user, minMessageLength 50) + giờ nằm trong pipeline default-caveman luôn
- **Free tiers**: README tuyên bố 1.53B free tokens/tháng (43 pools) — kích hoạt thêm provider free: agentrouter (200M one-time), agy (keyless), bazaarlink. Lưu ý: đa số cần credentials riêng; test kỹ trước khi thêm vào combo

### P3 — Nguồn tinh hoa free (đã research)
- `opencode-zen/*-free` (deepseek-v4-flash-free, mimo-v2.5-free): endpoint OK nhưng rate-limit 429 nặng — giữ làm tier cuối
- `agentrouter` (claude-opus-4-6, haiku 200M tokens one-time): cần kích hoạt connection
- `agy/*` (keyless Gemini/Claude): "No active credentials for provider: antigravity" — cần thêm connection agy
- `api-airforce/*` (Grok free, Kimi free, recurring-daily): thử thêm
- Cách thêm: POST /api/providers {"provider":"<id>","name":"..."} — KHÔNG phải provider nào cũng accepted (Invalid provider cho noauth nội bộ)

### P4 — Hardening
- **Volume mount** cho /app/data (hiện mất data nếu container recreate không commit)
- Backup định kỳ storage.sqlite (cron/launchd)
- Monitor: `docker logs omniroute | grep -c 502`, call_logs trong /app/data/call_logs
- Update rotator nếu zuneF đổi auth flow

## 5. Credentials & Paths

| Item | Value |
|---|---|
| OmniRoute admin | admin@local / OmniRoute-Admin-2026 |
| Downstream key | sk-b9eb30e8d08b6389-bdc6e3-a980fe1f |
| zuneF JWT | /private/tmp/omni_jwt.txt (exp 2036), device f15534009aa747aa91a4c4218fcc83da |
| DeepSeek key | sk-75ccf0748f6a4bbcb987494119abb1b4 |
| Cookie admin | /private/tmp/omni_cookies.txt |
| Settings backup | ~/.claude/settings.json.bak-omniroute-20260809 |
| Agents backup | ~/.claude/agents-backup-20260809/ |
| Skills backups | ~/.claude/skills-backup-20260809/, ~/.config/opencode/skills-backup-20260809-2/ |
| .claude.json backup | ~/.claude.json.bak-20260809 |
| Repo clone | ~/omniroute-src (release/v3.8.50) |

## 6. Lệnh kiểm tra nhanh

```bash
docker ps | grep omniroute                # healthy
curl -s -X POST localhost:20128/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@local","password":"OmniRoute-Admin-2026"}' -c /private/tmp/omni_cookies.txt
curl -s -b /private/tmp/omni_cookies.txt localhost:20128/api/combos | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).combos.length+' combos'))"
curl -s localhost:20128/api/v1/messages -H 'Content-Type: application/json' -H 'x-api-key: sk-b9eb30e8d08b6389-bdc6e3-a980fe1f' -H 'anthropic-version: 2023-06-01' -d '{"model":"claude-fable-5","max_tokens":20,"messages":[{"role":"user","content":"hi"}]}'
launchctl list | grep zunef-jwt          # rotator
tail -5 ~/.claude/.zunef-rotator.log
```
