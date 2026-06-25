#!/usr/bin/env python3
"""
批量对战胜率统计工具

用法:
  python match_runner.py                              # 跑 TANK_KEYS 全部坦克，各 20 场
  python match_runner.py -n 10                        # 每坦克各跑 10 场
  python match_runner.py -k KEY1 KEY2 -n 15          # 只跑指定 key，各 15 场
  python match_runner.py --delay 1.5                  # 每局间隔 1.5 秒（默认 0.5）
  python match_runner.py --save results.json          # 结果保存到 JSON 文件
  python match_runner.py --map grassy_field           # 固定地图（默认 random）
  python match_runner.py --opponent tnk_8lbIwTIeW23JbJ9YF             # 指定对手坦克 ID（反复挑战同一人）

比赛模式:
  --mode challenge   排名对战（默认，随机真实对手）
  --mode simulate    模拟对战（需搭配 --bot 指定机器人名）

机器人名（--mode simulate 时使用）:
  nova-scout / azure-hunter / crimson-bastion /
  emerald-striker / obsidian-phantom / golden-overlord
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

# Windows 控制台强制 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_URL = "https://agentank.ai"
DEFAULT_ROUNDS = 50
DEFAULT_DELAY = 0.5

# ── 在此处预配置坦克 key，可自由增删 ──────────────────────────────────────────
# myth-survivor agtk_cce872653e5d5b90f76db3ac370a2d2809b6 冰冻
# myth-tank001 agtk_4b1cdd58062b79c270f0983872acaeddac07 传送
# myth-tank006 agtk_e8dd544d3f9a4727a0d82285e24b2dbad8c4 加速
# myth-tank007 agtk_97f38c3f2cd8666b86ba86d407a7c758bc24 护盾
# myth-tank008 agtk_97cd318efe1ebf6a28908e6199da68ccf9ce 超载
# myth-tank009 agtk_7dfcb309cbcf0b41efe34117d388401b2819 眩晕
# myth-tank010 agtk_796f437f245ac76962630640aa0b08fc400c 隐身
TANK_KEYS = [
    # {"key": "agtk_cce872653e5d5b90f76db3ac370a2d2809b6", "name": "myth-survivor"},
    # {"key": "agtk_4b1cdd58062b79c270f0983872acaeddac07", "name": "myth-tank001"},
    # {"key": "agtk_e8dd544d3f9a4727a0d82285e24b2dbad8c4", "name": "myth-tank006"},
    # {"key": "agtk_97f38c3f2cd8666b86ba86d407a7c758bc24", "name": "myth-tank007"},
    # {"key": "agtk_97cd318efe1ebf6a28908e6199da68ccf9ce", "name": "myth-tank008"},
    # {"key": "agtk_7dfcb309cbcf0b41efe34117d388401b2819", "name": "myth-tank009"},
    {"key": "agtk_796f437f245ac76962630640aa0b08fc400c", "name": "myth-tank010"}
]
# ─────────────────────────────────────────────────────────────────────────────


def api_post(path, tank_key, body=None):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tank_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(path, tank_key):
    headers = {
        "Authorization": f"Bearer {tank_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    req = urllib.request.Request(BASE_URL + path, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve_opponent_id(tank_key, identifier):
    """将对手标识（数字ID 或 tnk_字符串 或 坦克名）解析为数字 ID。"""
    # 已经是纯数字
    if identifier.isdigit():
        return int(identifier)

    # 从最近对局里按 tnk_ 或名字匹配
    matches = api_get("/api/agent/tank/matches?limit=50&offset=0", tank_key)
    for m in matches if isinstance(matches, list) else matches.get("matches", []):
        # 检查对手字段
        for field_id, field_name in [("defenderTankId", "defenderTankName"),
                                     ("challengerTankId", "challengerTankName")]:
            tid = m.get(field_id)
            tname = m.get(field_name, "")
            turl_id = m.get("defenderTankUrlId", "") or m.get("challengerTankUrlId", "")
            if str(tid) == identifier or turl_id == identifier or tname == identifier:
                return int(tid)

    print(f"  警告: 无法解析对手 '{identifier}'，尝试直接当数字使用")
    return int(identifier)


def run_challenge(tank_key, map_id, my_tank_id_ref, opponent_id=None):
    """发起排名挑战，返回 (tag, opponent, url_id)"""
    body = {"mapId": map_id}
    if opponent_id:
        body["opponentTankId"] = opponent_id
    else:
        body["randomOpponent"] = True

    result = api_post("/api/agent/tank/challenge", tank_key, body)
    url_id = result.get("urlId") or result.get("matchUrlId", "")
    winner = result.get("winnerTankId")
    opponent = result.get("defenderTankName", "?")
    challenger_id = result.get("challengerTankId")

    if my_tank_id_ref[0] is None and challenger_id:
        my_tank_id_ref[0] = challenger_id

    my_id = my_tank_id_ref[0]
    if winner == my_id:
        tag = "W"
    elif winner and winner != my_id:
        tag = "L"
    else:
        tag = "D"

    return tag, opponent, url_id


def run_simulate(tank_key, bot_name):
    """发起模拟对战，返回 (tag, bot_name, url_id)"""
    result = api_post("/api/agent/tank/simulate", tank_key, {"opponentBot": bot_name})
    winner = result.get("winner")
    url_id = result.get("urlId") or result.get("matchUrlId", "")

    if winner == "me":
        tag = "W"
    elif winner in ("opponent", "training-bot"):
        tag = "L"
    elif winner == "tie":
        tag = "D"
    else:
        tag = "D"

    return tag, bot_name, url_id


def run_tank(tank_key, tank_name, rounds, mode, map_id, bot_name, delay, opponent_id=None):
    """对单个坦克跑 rounds 场比赛，返回详细记录列表和统计。"""
    print(f"\n{'='*56}")
    opponent_hint = f"  对手:{opponent_id}" if opponent_id else ""
    print(f"  {tank_name}  ({tank_key[:16]}...)  模式:{mode}  场次:{rounds}{opponent_hint}")
    print(f"{'='*56}")

    wins = losses = draws = errors = 0
    records = []
    my_tank_id_ref = [None]

    # 解析对手 ID（支持数字/tnk_字符串/坦克名）
    resolved_opponent = None
    if opponent_id:
        try:
            resolved_opponent = resolve_opponent_id(tank_key, opponent_id)
            print(f"  对手数字 ID: {resolved_opponent}")
        except Exception as e:
            print(f"  解析对手 ID 失败: {e}，将直接使用原值")
            resolved_opponent = int(opponent_id) if opponent_id.isdigit() else None

    for i in range(rounds):
        ts = datetime.now().strftime("%H:%M:%S")
        try:
            if mode == "challenge":
                tag, opponent, url_id = run_challenge(tank_key, map_id, my_tank_id_ref, resolved_opponent)
            else:
                tag, opponent, url_id = run_simulate(tank_key, bot_name)

            if tag == "W":
                wins += 1
            elif tag == "L":
                losses += 1
            else:
                draws += 1

            total = wins + losses + draws
            wr = wins / total * 100 if total else 0
            match_url = f"https://agentank.ai/history/{url_id}" if url_id else ""
            print(f"  [{i+1:>3}/{rounds}] {tag}  vs {opponent:<24}  W:{wins} L:{losses} D:{draws}  WR:{wr:5.1f}%  {ts}")

            records.append({
                "index": i + 1,
                "result": tag,
                "opponent": opponent,
                "url": match_url,
                "time": ts,
            })

        except urllib.error.HTTPError as e:
            errors += 1
            body_text = e.read().decode("utf-8", errors="replace")
            print(f"  [{i+1:>3}/{rounds}] ERROR HTTP {e.code}: {body_text[:120]}")
            records.append({"index": i + 1, "result": "ERROR", "error": str(e)})

        except Exception as e:
            errors += 1
            print(f"  [{i+1:>3}/{rounds}] ERROR: {e}")
            records.append({"index": i + 1, "result": "ERROR", "error": str(e)})

        time.sleep(delay)

    total = wins + losses + draws
    wr = wins / total * 100 if total else 0

    print(f"\n  ── {tank_name} 汇总 ──")
    print(f"  有效场次: {total}  错误: {errors}")
    print(f"  胜 {wins}  负 {losses}  平 {draws}  胜率: {wr:.1f}%")

    loss_records = [r for r in records if r.get("result") == "L" and r.get("url")]
    if loss_records:
        print(f"  负场回放:")
        for r in loss_records:
            print(f"    [{r['index']:>3}] vs {r['opponent']}  {r['url']}")

    return {
        "tank_key": tank_key,
        "tank_name": tank_name,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "errors": errors,
        "win_rate": round(wr, 2),
        "records": records,
    }


def print_summary(all_stats):
    print(f"\n{'='*56}")
    print("  全部坦克汇总")
    print(f"{'='*56}")
    print(f"  {'坦克名':<24} {'场次':>4}  {'胜':>4}  {'负':>4}  {'平':>4}  {'胜率':>7}")
    print(f"  {'-'*52}")
    for s in all_stats:
        total = s["wins"] + s["losses"] + s["draws"]
        print(f"  {s['tank_name']:<24} {total:>4}  {s['wins']:>4}  {s['losses']:>4}  {s['draws']:>4}  {s['win_rate']:>6.1f}%")
    print(f"{'='*56}")


def main():
    parser = argparse.ArgumentParser(description="AgenTank 批量对战胜率统计")
    parser.add_argument("-k", "--keys", nargs="+", metavar="KEY",
                        help="指定一个或多个坦克 API key（不填则使用脚本顶部 TANK_KEYS）")
    parser.add_argument("-n", "--rounds", type=int, default=DEFAULT_ROUNDS,
                        help=f"每坦克比赛场次（默认: {DEFAULT_ROUNDS}）")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                        help=f"每局间隔秒数（默认: {DEFAULT_DELAY}）")
    parser.add_argument("--mode", choices=["challenge", "simulate"], default="challenge",
                        help="比赛模式: challenge=排名对战(默认)  simulate=机器人模拟")
    parser.add_argument("--map", default="random",
                        help="地图 ID（challenge 模式，默认: random）")
    parser.add_argument("--bot", default="azure-hunter",
                        help="机器人名（simulate 模式，默认: azure-hunter）")
    parser.add_argument("--opponent", metavar="TANK_ID",
                        help="指定对手（数字ID / tnk_字符串 / 坦克名，会自动从对局历史解析）")
    parser.add_argument("--save", metavar="FILE",
                        help="将详细结果保存为 JSON 文件（如 results.json）")
    args = parser.parse_args()

    # 确定要跑的 key 列表
    if args.keys:
        tanks = [{"key": k, "name": k[:20] + "..."} for k in args.keys]
    else:
        tanks = TANK_KEYS

    if not tanks:
        print("错误: 没有可用的坦克 key，请在 TANK_KEYS 中配置或使用 -k 传入。")
        sys.exit(1)

    print(f"共 {len(tanks)} 个坦克，每坦克 {args.rounds} 场，模式: {args.mode}")

    all_stats = []
    for t in tanks:
        stats = run_tank(
            tank_key=t["key"],
            tank_name=t["name"],
            rounds=args.rounds,
            mode=args.mode,
            map_id=args.map,
            bot_name=args.bot,
            delay=args.delay,
            opponent_id=args.opponent,
        )
        all_stats.append(stats)

    print_summary(all_stats)

    if args.save:
        output = {
            "generated_at": datetime.now().isoformat(),
            "rounds": args.rounds,
            "mode": args.mode,
            "tanks": all_stats,
        }
        with open(args.save, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"\n详细结果已保存: {args.save}")


if __name__ == "__main__":
    main()
