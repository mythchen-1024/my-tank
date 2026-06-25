#!/usr/bin/env python3
"""
AgenTank 发布工具（多坦克档案，支持批量发布）
用法:
  python publish.py                          # 排名坦克: 构建并发布到档案中所有 key
  python publish.py --only 护盾,加速         # 只发布到指定名称的坦克
  python publish.py --tank survivor          # 生存坦克: 发布 survivor-tank.js 到 raid(出击)分支
  python publish.py --tank survivor -b multiplayer  # 同一份代码发布到多人分支
  python publish.py --no-build               # 跳过构建，直接发布现有文件
  python publish.py --file path/to/code.js   # 发布指定文件(覆盖档案默认)
  python publish.py --notes "修复追击逻辑"   # 附带版本说明
  python publish.py --branch raid            # 覆盖档案默认分支
  python publish.py --no-minify              # 关闭代码压缩，原样发布
  python publish.py --dry-run                # 只打印请求体，不实际发布
  python publish.py --status                 # 查看所有坦克当前状态
  python publish.py -s --tank survivor       # 查看生存坦克状态
  python publish.py --matches                # 查看最近战斗记录

坦克档案(--tank)在 TANK_PROFILES 定义，绑定 keys(多个)/默认文件/默认分支/构建命令/署名。
keys 为列表，每项 {"name": "显示名", "key": "agtk_xxx"}。
--only 可逗号分隔选择部分坦克名称发布；不指定则全量发布。
命令行显式 --file/--branch 优先级高于档案默认值。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime

BASE_URL = "https://agentank.ai"

# 坦克档案：每档案绑定 keys(列表) / 默认文件 / 默认分支 / 构建命令 / 署名。
# build_cmd 为 None 表示单文件无需构建。
# myth-survivor agtk_cce872653e5d5b90f76db3ac370a2d2809b6 冰冻
# myth-tank001 agtk_4b1cdd58062b79c270f0983872acaeddac07 传送
# myth-tank006 agtk_e8dd544d3f9a4727a0d82285e24b2dbad8c4 加速
# myth-tank007 agtk_97f38c3f2cd8666b86ba86d407a7c758bc24 护盾
# myth-tank008 agtk_97cd318efe1ebf6a28908e6199da68ccf9ce 超载
# myth-tank009 agtk_7dfcb309cbcf0b41efe34117d388401b2819 眩晕
# myth-tank010 agtk_796f437f245ac76962630640aa0b08fc400c 隐身
TANK_PROFILES = {
    "bt": {
        "keys": [
            {"name": "myth-survivor", "key": "agtk_cce872653e5d5b90f76db3ac370a2d2809b6"},
            {"name": "myth-tank001", "key": "agtk_4b1cdd58062b79c270f0983872acaeddac07"},
            {"name": "myth-tank006", "key": "agtk_e8dd544d3f9a4727a0d82285e24b2dbad8c4"},
            {"name": "myth-tank007", "key": "agtk_97f38c3f2cd8666b86ba86d407a7c758bc24"},
            {"name": "myth-tank008", "key": "agtk_97cd318efe1ebf6a28908e6199da68ccf9ce"},
            {"name": "myth-tank009", "key": "agtk_7dfcb309cbcf0b41efe34117d388401b2819"},
            {"name": "myth-tank010", "key": "agtk_796f437f245ac76962630640aa0b08fc400c"},
        ],
        "file": "bt-tank-submit.js",
        "branch": "main",
        "build_cmd": ["node", "build.js"],
        "submitted_by": "Claude",
    },
}
DEFAULT_TANK = "bt"


def get_tank_keys(profile, only=None):
    """获取档案中的 key 列表，支持 --only 过滤。"""
    keys = profile.get("keys", [])
    if not keys:
        print("错误: 该坦克档案未配置 keys。请在 TANK_PROFILES 中填写 keys 列表。")
        sys.exit(1)
    if only:
        names = [n.strip() for n in only.split(",")]
        filtered = [k for k in keys if k["name"] in names]
        not_found = set(names) - {k["name"] for k in filtered}
        if not_found:
            all_names = [k["name"] for k in keys]
            print(f"错误: 未找到坦克名: {', '.join(not_found)}  可用: {', '.join(all_names)}")
            sys.exit(1)
        return filtered
    return keys


def load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())


class PublishError(Exception):
    pass


def api_request(method, path, body=None, tank_key=None, exit_on_error=True):
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tank_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        msg = f"HTTP {e.code} {e.reason}"
        print(msg)
        try:
            err = json.loads(body_text)
            print(json.dumps(err, ensure_ascii=False, indent=2))
        except Exception:
            print(body_text[:500])
        if exit_on_error:
            sys.exit(1)
        raise PublishError(msg)
    except urllib.error.URLError as e:
        msg = f"网络错误: {e.reason}"
        print(msg)
        if exit_on_error:
            sys.exit(1)
        raise PublishError(msg)


def cmd_status(tank_keys):
    for entry in tank_keys:
        print(f"\n{'='*40}")
        print(f"正在获取坦克状态 [{entry['name']}]...")
        data = api_request("GET", "/api/agent/tank", tank_key=entry["key"])
        tank = data.get("tank", {})
        standing = data.get("standing", {})
        sim_cooldown = data.get("simulateCooldown")

        print(f"坦克: {tank.get('name')} (ID: {tank.get('id')})")
        print(f"所有者: {tank.get('ownerDisplayName')}")
        print(f"技能: {tank.get('skillType', '未知')}")
        print(f"排名分数: {tank.get('rankScore')}  等级: {tank.get('rankTier')} {tank.get('rankDivision')}")
        print(f"排名分: {tank.get('rankPoints')}  胜/负: {tank.get('effectiveWins')}/{tank.get('effectiveLosses')}")
        if standing:
            print(f"全球排名: #{standing.get('rank')} / {standing.get('totalPublic')}")
        if sim_cooldown:
            print(f"模拟冷却: {sim_cooldown}")

        branches = data.get("branches", {})
        if branches:
            print("代码分支:")
            for branch, info in branches.items():
                ver = info.get("version", "?")
                ts = info.get("publishedAt", "")[:10] if info.get("publishedAt") else ""
                print(f"  {branch}: v{ver}  {ts}")


def cmd_matches(tank_keys, limit=5):
    for entry in tank_keys:
        print(f"\n{'='*40}")
        print(f"正在获取 [{entry['name']}] 最近 {limit} 场战斗...")
        data = api_request("GET", f"/api/agent/tank/matches?limit={limit}&offset=0", tank_key=entry["key"])
        matches = data.get("matches", [])
        if not matches:
            print("暂无战斗记录")
            continue
        for m in matches:
            result = "胜" if m.get("won") else "负"
            opponent = m.get("opponentName", "?")
            map_id = m.get("mapId", "?")
            ts = m.get("createdAt", "")[:10]
            url_id = m.get("matchUrlId", "")
            print(f"  [{result}] vs {opponent}  地图:{map_id}  {ts}  /history/{url_id}")


def minify_js(code):
    """使用 Terser 进行 JS 压缩（变量名缩短+死代码消除+常量折叠）。

    如果 Terser 不可用则回退到轻量级压缩（去注释+去空白）。
    """
    # 先尝试用 Terser 深度压缩
    try:
        result = subprocess.run(
            ["terser", "--compress", "--mangle"],
            input=code,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=os.path.dirname(__file__) or ".",
            timeout=60,
            shell=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            print("  [压缩引擎: Terser]")
            return result.stdout.strip()
        else:
            print(f"  [Terser 失败, 回退轻量压缩] stderr: {result.stderr[:200]}")
    except FileNotFoundError:
        print("  [Terser 未安装, 回退轻量压缩] 建议: npm install -g terser")
    except subprocess.TimeoutExpired:
        print("  [Terser 超时, 回退轻量压缩]")
    except Exception as e:
        print(f"  [Terser 异常, 回退轻量压缩] {e}")

    # 回退: 轻量级压缩(去注释+去空白)
    return _minify_js_fallback(code)


def _minify_js_fallback(code):
    """轻量级 JS 压缩回退: 去注释、去多余空白, 保留换行(ASI 安全)。"""
    out = []
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if c in ('"', "'"):
            quote = c
            out.append(c)
            i += 1
            while i < n:
                ch = code[i]
                out.append(ch)
                if ch == "\\" and i + 1 < n:
                    out.append(code[i + 1])
                    i += 2
                    continue
                i += 1
                if ch == quote:
                    break
        elif c == "/" and nxt == "/":
            i += 2
            while i < n and code[i] != "\n":
                i += 1
        elif c == "/" and nxt == "*":
            i += 2
            while i < n and not (code[i] == "*" and i + 1 < n and code[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c)
            i += 1

    text = "".join(out)
    lines = []
    for line in text.split("\n"):
        stripped = re.sub(r"[ \t]+", " ", line).strip()
        if stripped:
            lines.append(stripped)
    return "\n".join(lines)


def cmd_build(build_cmd):
    """执行构建命令(如 node my-tank/build.js)，生成单文件提交产物。"""
    print("正在构建 (" + " ".join(build_cmd) + ") ...")
    result = subprocess.run(
        build_cmd,
        cwd=os.path.dirname(__file__) or ".",
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        print("构建失败:\n" + result.stderr)
        sys.exit(1)
    print(result.stdout.strip())


def cmd_publish(tank_keys, file_path, notes, branch, dry_run, minify, submitted_by):
    if not os.path.exists(file_path):
        print(f"错误: 文件不存在: {file_path}")
        sys.exit(1)

    with open(file_path, encoding="utf-8") as f:
        code = f.read()

    raw_len = len(code)
    if minify:
        code = minify_js(code)
        saved = raw_len - len(code)
        pct = (saved / raw_len * 100) if raw_len else 0
        print(f"文件: {file_path}  ({raw_len} -> {len(code)} 字符, 压缩 {saved} 字符 / {pct:.1f}%)")
    else:
        print(f"文件: {file_path}  ({raw_len} 字符)")

    body = {
        "code": code,
        "submittedBy": submitted_by,
        "branch": branch,
    }
    if notes:
        body["notes"] = notes

    if dry_run:
        print(f"\n[dry-run] 将发布到 {len(tank_keys)} 个坦克: {', '.join(e['name'] for e in tank_keys)}")
        preview = dict(body)
        preview["code"] = code[:200] + "..." if len(code) > 200 else code
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return

    print(f"\n准备发布到 {len(tank_keys)} 个坦克, 分支 [{branch}]...")
    success, failed = [], []
    for entry in tank_keys:
        name = entry["name"]
        print(f"\n  [{name}] 发布中...")
        try:
            result = api_request("POST", "/api/agent/tank/code", body=body, tank_key=entry["key"], exit_on_error=False)
            tank = result.get("tank", {})
            version = tank.get("codeVersion") or result.get("version", "?")
            print(f"  [{name}] 成功! v{version}  排名:{tank.get('rankScore')}  胜/负:{tank.get('effectiveWins')}/{tank.get('effectiveLosses')}")
            success.append(name)
        except PublishError:
            print(f"  [{name}] 发布失败, 继续下一个...")
            failed.append(name)

    print(f"\n{'='*40}")
    print(f"发布完成: 成功 {len(success)}/{len(tank_keys)}")
    if success:
        print(f"  成功: {', '.join(success)}")
    if failed:
        print(f"  失败: {', '.join(failed)}")

    # 备份已发布的文件
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    bak_name = f"{os.path.splitext(file_path)[0]}.{ts}.bak.js"
    try:
        with open(bak_name, "w", encoding="utf-8") as f:
            f.write(code)
        print(f"备份: {bak_name}")
    except Exception:
        pass


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="AgenTank 发布工具（多坦克档案，支持批量发布）")
    parser.add_argument("--tank", "-t", default=DEFAULT_TANK, choices=list(TANK_PROFILES.keys()),
                        help=f"坦克档案 (默认: {DEFAULT_TANK})")
    parser.add_argument("--only", "-o", default=None,
                        help="只发布到指定坦克(逗号分隔名称, 如: 护盾,加速)")
    parser.add_argument("--file", "-f", default=None, help="要发布的 JS 文件 (默认取自坦克档案)")
    parser.add_argument("--notes", "-n", default="", help="版本说明")
    parser.add_argument("--branch", "-b", default=None, choices=["main", "raid", "multiplayer"],
                        help="发布分支 (默认取自坦克档案)")
    parser.add_argument("--build", dest="build", action="store_true",  default=True,  help="发布前先运行构建（默认开启）")
    parser.add_argument("--no-build",               action="store_false", dest="build",  help="跳过构建，直接发布现有文件")
    parser.add_argument("--dry-run", action="store_true", help="预览请求体，不实际发布")
    parser.add_argument("--no-minify", dest="minify", action="store_false", help="不压缩代码，原样发布")
    parser.set_defaults(minify=True)
    parser.add_argument("--status", "-s", action="store_true", help="查看坦克当前状态")
    parser.add_argument("--matches", "-m", action="store_true", help="查看最近战斗记录")
    parser.add_argument("--limit", type=int, default=5, help="--matches 返回条数 (默认: 5)")
    args = parser.parse_args()

    profile = TANK_PROFILES[args.tank]
    tank_keys = get_tank_keys(profile, only=args.only)

    file_path = args.file if args.file is not None else profile["file"]
    branch    = args.branch if args.branch is not None else profile["branch"]
    submitted_by = profile.get("submitted_by", "Claude")
    build_cmd = profile.get("build_cmd")

    names_str = ", ".join(e["name"] for e in tank_keys)
    print(f"[坦克档案: {args.tank}]  目标: {names_str}  分支: {branch}  文件: {file_path}")

    if args.status:
        cmd_status(tank_keys)
    elif args.matches:
        cmd_matches(tank_keys, args.limit)
    else:
        if args.build and build_cmd and args.file is None and not args.dry_run:
            cmd_build(build_cmd)
        cmd_publish(tank_keys, file_path, args.notes, branch, args.dry_run, args.minify, submitted_by)


if __name__ == "__main__":
    main()
