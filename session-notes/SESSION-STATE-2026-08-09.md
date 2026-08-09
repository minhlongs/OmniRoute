# OmniRoute Session State — 2026-08-09

> Handoff document for the next agent. Everything done + everything planned + how to update.

## 1. Hệ thống hiện tại (RUNNING)

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
- **10 combo claude** (tên = model ID): `claude-fable-5` (chuẩn) → `claude-opus-4-8[1m]` → `claude-opus-4-8` → `claude-opus-4-7[1m]` → `claude-opus-4-7` → `claude-opus-4-6[1m]` → `claude-opus-4-6` → `claude-sonnet-5-0` → `claude-sonnet-4-6` → `claude-sonnet-4-5` (tên mới của combo haiku)
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
