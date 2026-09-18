#!/usr/bin/env python3
"""
签到统一入口 v2：TRAE + WorkBuddy + token 监控 + 每日战报（飞书卡片）

推送策略：
  - 每日必发战报卡片（签到结果 + 积分明细 + 余额 + 台账累计）
  - 任何失败/告警 → 卡片头部红色 + 告警区块
  - WEBHOOK 未配置时只写日志不推送
  - 重复运行安全：签到幂等、台账按日去重

cron（北京时间 08:05）：
  5 8 * * * /usr/bin/python3 /home/ubuntu/checkin/run_all.py >> /home/ubuntu/checkin/logs/cron.log 2>&1
"""
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).parent
LOG_DIR = BASE / "logs"
LOG_DIR.mkdir(exist_ok=True)
LEDGER = BASE / "ledger.json"

# ---- 飞书 webhook（notify.env, chmod 600） ----
WEBHOOK = ""
env_file = BASE / "notify.env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if line.startswith("WEBHOOK="):
            WEBHOOK = line.split("=", 1)[1].strip().strip('"').strip("'")

# ---- 阈值 ----
TRAE_ACCESS_WARN_DAYS = 2
TRAE_REFRESH_WARN_DAYS = 30
WB_ACCESS_WARN_DAYS = 7
WB_REFRESH_WARN_DAYS = 7


def fmt(n) -> str:
    """千分位"""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n or 0)


def days_until(v) -> int:
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    if isinstance(v, (int, float)):
        exp = datetime.fromtimestamp(v / 1000, tz=timezone.utc)
    else:
        exp = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return (exp - now).days


def run_cmd(cmd: list) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180, cwd=BASE)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:
        return 1, f"执行异常: {e}"


def extract_json(text: str):
    """从输出中提取 JSON 对象（容忍前后杂行）"""
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(text[s:e + 1])
    except Exception:
        return None


# ================= 1. TRAE =================
def run_trae():
    rc, out = run_cmd(["node", str(BASE / "trae" / "trae_checkin_server.js")])
    (LOG_DIR / "trae.log").open("a").write(f"[{datetime.now():%F %T}] rc={rc}\n{out}\n")
    if rc != 0:
        return {"ok": False, "err": out[-300:]}
    j = extract_json(out) or {}
    return {
        "ok": j.get("status") == "ok",
        "action": j.get("action", ""),
        "got": j.get("credits", 0) or 0,
        "balance": j.get("balance"),  # {total, used, remaining} or None
        "err": "" if j.get("status") == "ok" else out[-300:],
    }


# ================= 2. WorkBuddy =================
def run_workbuddy():
    rc, out = run_cmd(["python3", str(BASE / "workbuddy_checkin.py"), "--no-notify"])
    (LOG_DIR / "workbuddy.log").open("a").write(f"[{datetime.now():%F %T}] rc={rc}\n{out}\n")
    if rc != 0:
        return {"ok": False, "err": out[-300:]}
    j = extract_json(out) or {}
    if j.get("status") != "ok":
        return {"ok": False, "err": (j.get("msg") or out)[-300:]}
    # 深挖明细
    data = {}
    try:
        data = j.get("detail", {}).get("status_resp", {}).get("data", {}) or {}
    except Exception:
        pass
    msg = j.get("msg", "")
    # 猫猫旅行段落："... ｜ 派猫猫旅行：xxx"
    travel = ""
    if "派猫猫旅行：" in msg:
        travel = msg.split("派猫猫旅行：", 1)[1].strip()
    # 旅行收益 "+N 积分"
    m = re.search(r"已领取旅行奖励\s*\+(\d+)\s*积分", msg)
    travel_got = int(m.group(1)) if m else 0
    # 余额修正：脚本的 balance 是签到【前】的快照（来自签到前 status 查询），
    # 签到成功后应为 快照 + daily_credit。注意 total_credits 语义是
    # "Buddy 加油站本季活动累计"（按季重置），不是账户总余额。
    balance = j.get("balance")
    if balance is not None and j.get("action") == "clicked":
        balance = (balance or 0) + (data.get("daily_credit") or 100)
    return {
        "ok": True,
        "action": j.get("action", ""),
        "got": j.get("points", 0) or 0,
        "travel_got": travel_got,
        "balance": balance,
        "streak": data.get("streak_days"),
        "week_days": data.get("week_checkin_days"),
        "travel": travel,
    }


# ================= 3. 台账 =================
def update_ledger(date_str: str, trae_got: int, wb_got: int, wb_travel: int):
    """只记当日首次获得；返回累计统计"""
    led = {"start_date": date_str, "totals": {"trae": 0, "wb": 0}, "records": {}}
    if LEDGER.exists():
        try:
            led = json.loads(LEDGER.read_text())
        except Exception:
            pass
    rec = led["records"].get(date_str)
    if rec is None:  # 当日首次执行才记账（幂等：重复运行不重复计）
        rec = {"trae": trae_got, "wb": wb_got, "travel": wb_travel}
        led["records"][date_str] = rec
        led["totals"]["trae"] += trae_got
        led["totals"]["wb"] += wb_got + wb_travel
    LEDGER.write_text(json.dumps(led, ensure_ascii=False, indent=1))
    return {
        "days": len(led["records"]),
        "trae_total": led["totals"]["trae"],
        "wb_total": led["totals"]["wb"],
    }


# ================= 4. token 监控 =================
def monitor_tokens():
    alerts, info = [], []
    try:
        auth = json.loads((BASE / "trae" / "trae_auth.json").read_text())["auth"]
        d_acc, d_ref = days_until(auth["expiredAt"]), days_until(auth["refreshExpiredAt"])
        info.append(f"TRAE token：access 续期 {d_acc} 天 · refresh {d_ref} 天")
        if d_acc < TRAE_ACCESS_WARN_DAYS:
            alerts.append(f"⚠️ TRAE accessToken 仅剩 {d_acc} 天（自动刷新疑似失效）")
        if d_ref < TRAE_REFRESH_WARN_DAYS:
            alerts.append(f"⚠️ TRAE refreshToken 仅剩 {d_ref} 天（请重新导出同步）")
    except Exception as e:
        alerts.append(f"⚠️ TRAE token 状态读取失败: {e}")
    try:
        info2 = json.loads((Path.home() / ".workbuddy" / "auth" / "workbuddy-desktop.info").read_text())["auth"]
        d_acc, d_ref = days_until(info2["expiresAt"]), days_until(info2["refreshExpiresAt"])
        info.append(f"WorkBuddy 登录态 {d_acc} 天 · refresh {d_ref} 天")
        if d_acc < WB_ACCESS_WARN_DAYS:
            alerts.append(f"⚠️ WorkBuddy 登录态仅剩 {d_acc} 天：请从本机拷贝 workbuddy-desktop.info 上传（见 deployment.md）")
        if d_ref < WB_REFRESH_WARN_DAYS:
            alerts.append(f"⚠️ WorkBuddy refreshToken 仅剩 {d_ref} 天：本机打开客户端续期后重新同步")
    except Exception as e:
        alerts.append(f"⚠️ WorkBuddy token 状态读取失败: {e}")
    return alerts, info


# ================= 5. 飞书卡片 =================
def notify_card(elements: list, header_title: str, template: str = "blue"):
    if not WEBHOOK:
        print("[notify] WEBHOOK 未配置，跳过推送")
        return
    payload = json.dumps({
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {"template": template,
                       "title": {"tag": "plain_text", "content": header_title}},
            "elements": elements,
        },
    }).encode()
    try:
        req = urllib.request.Request(WEBHOOK, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"[notify] HTTP {resp.status}")
    except Exception as e:
        print(f"[notify] 推送失败: {e}")


def md(content: str) -> dict:
    return {"tag": "div", "text": {"tag": "lark_md", "content": content}}


HR = {"tag": "hr"}


def note(content: str) -> dict:
    return {"tag": "note", "elements": [{"tag": "plain_text", "content": content}]}


# ================= 主流程 =================
def main():
    now = datetime.now()
    date_str = now.strftime("%F")
    weekday = "周" + "一二三四五六日"[now.weekday()]

    trae = run_trae()
    wb = run_workbuddy()
    tok_alerts, tok_info = monitor_tokens()

    # 台账（已签跳过时 got=0，不重复计）
    stats = update_ledger(date_str, trae.get("got", 0) if trae["ok"] else 0,
                          wb.get("got", 0) if wb["ok"] else 0,
                          wb.get("travel_got", 0) if wb["ok"] else 0)

    # ---- 组装战报 ----
    alerts = []
    if not trae["ok"]:
        alerts.append(f"**TRAE 签到失败**\n{trae.get('err', '')}")
    if not wb["ok"]:
        alerts.append(f"**WorkBuddy 签到失败**\n{wb.get('err', '')}")
    alerts += tok_alerts

    trae_got = trae.get("got", 0)
    wb_got = wb.get("got", 0) + wb.get("travel_got", 0)
    day_total = (trae_got if trae["ok"] else 0) + (wb_got if wb["ok"] else 0)

    # 今日明细
    lines = []
    if trae["ok"]:
        if trae.get("action") == "clicked":
            lines.append(f"▪️ TRAE：**+{trae_got}**")
        else:
            lines.append(f"▪️ TRAE：今日已签（此前已领取）")
    if wb["ok"]:
        streak = f" · 连续第 {wb['streak']} 天" if wb.get("streak") else ""
        if wb.get("action") == "clicked":
            lines.append(f"▪️ WorkBuddy：**+{wb.get('got', 0)}**{streak}")
        else:
            lines.append(f"▪️ WorkBuddy：今日已签{streak}")
        if wb.get("travel_got"):
            lines.append(f"▪️ 猫猫旅行：**+{wb['travel_got']}**")
    detail = md("**今日明细**\n" + ("\n".join(lines) if lines else "（无）"))

    # 余额
    blines = []
    if trae.get("balance"):
        b = trae["balance"]
        blines.append(f"▪️ TRAE：总额 {fmt(b['total'])} · 已用 {fmt(b['used'])} · **剩余 {fmt(b['remaining'])}**")
    if wb.get("balance") is not None:
        blines.append(f"▪️ WorkBuddy 加油站：本季累计 **{fmt(wb['balance'])}**（按季重置）")
    balance_md = md("**积分状态**\n" + ("\n".join(blines) if blines else "（查询失败）")) if blines else None

    # 猫猫动态
    travel_md = md(f"🐱 {wb['travel']}") if wb.get("travel") else None

    # 累计
    cum = md(
        f"**累计战果**（自动签到 {stats['days']} 天）\n"
        f"TRAE +{fmt(stats['trae_total'])} ｜ WorkBuddy +{fmt(stats['wb_total'])}"
        + (f"\n本周已签 {wb['week_days']}/7 天" if wb.get("week_days") is not None else "")
    )

    # 告警块
    alert_md = md("🚨 **告警**\n" + "\n".join(alerts)) if alerts else None

    # 汇总行
    if alerts:
        head = f"🪙 今日获得 +{fmt(day_total)} 积分" + ("" if day_total else "（有异常，见告警）")
    else:
        head = f"🪙 今日获得 +{fmt(day_total)} 积分"

    elements = [md(f"**{head}**"), detail]
    if balance_md:
        elements += [HR, balance_md]
    if travel_md:
        elements += [travel_md]
    elements += [HR, cum]
    if alert_md:
        elements += [HR, alert_md]
    elements.append(note("⏰ 每日 08:05 自动执行 ｜ " + (" ｜ ".join(tok_info) if tok_info else "token 正常")))

    title = f"📅 签到战报 · {now.strftime('%m-%d')} {weekday}"
    notify_card(elements, title, "red" if alerts else "blue")

    # 控制台摘要 + 退出码
    print(f"[{now:%F %T}] TRAE {'OK' if trae['ok'] else 'FAIL'} / WorkBuddy {'OK' if wb['ok'] else 'FAIL'} / 今日+{day_total}")
    sys.exit(1 if alerts else 0)


if __name__ == "__main__":
    main()