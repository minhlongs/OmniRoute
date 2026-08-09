# Session Notes — OmniRoute Optimization

Handoff documents cho agent các phiên sau.

| File | Nội dung |
|---|---|
| `SESSION-STATE-2026-08-09.md` | Trạng thái hệ thống hiện tại (đang chạy), bài học kỹ thuật, việc đã làm, việc chuẩn bị làm, credentials, lệnh kiểm tra |
| `UPDATE-PLAN-2026-08-09.md` | Kế hoạch update v3.8.49 → v3.8.50 (1874 commits), backup/rollback, kiểm tra sau update, nguồn free tier cần thử |

## Quy tắc
- **ĐỌC SESSION-STATE trước khi đụng hệ thống** — có mọi credentials + gotcha (UA node, restart reset state, commit image trước khi recreate)
- Update OmniRoute: làm theo UPDATE-PLAN, backup trước, verify sau
- Thêm provider/combos mới: test 200 trước khi đưa vào ladder
- Sau mỗi phiên làm việc: cập nhật file này + commit
