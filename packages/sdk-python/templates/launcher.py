"""启动器模板：读指针，启动当前版本。

把这个文件单独用 PyInstaller 打包一次（见文末命令），产物放在应用根目录，
用户的快捷方式指向它。之后每次更新换的都是 versions/ 里的内容，
启动器本身不用再动——这也是它必须保持简单、不引入依赖的原因。

目录结构：
    YourApp/
    ├── launcher.exe        ← 本文件打包产物，快捷方式指向它
    ├── current.txt         ← 内容是版本号，如 1.2.0
    ├── versions/
    │   ├── 1.1.0/
    │   └── 1.2.0/app.exe
    └── data/               ← 用户数据放这里，更新不会碰
"""

import os
import subprocess
import sys

# 主程序在版本目录里的相对路径，按你的打包产物改
ENTRY = "app.exe"
POINTER = "current.txt"


def app_root():
    """启动器所在目录就是应用根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def read_pointer(root):
    try:
        with open(os.path.join(root, POINTER), "r", encoding="utf-8") as fp:
            return fp.read().strip() or None
    except OSError:
        return None


def sort_key(version):
    """按版本号大小排序，让回退时优先挑最新的一个。"""
    parts = []
    for chunk in str(version).replace("-", ".").split("."):
        parts.append((0, int(chunk)) if chunk.isdigit() else (1, chunk))
    return parts


def candidates(root):
    """候选版本：指针指的排第一，其余按版本号从新到旧兜底。

    指针指向的版本可能被杀毒软件误删或解压残缺，
    所以这里保留退路，不至于让用户面对一个打不开的软件。
    """
    versions_dir = os.path.join(root, "versions")
    try:
        installed = [
            name for name in os.listdir(versions_dir)
            if os.path.isdir(os.path.join(versions_dir, name))
        ]
    except OSError:
        installed = []
    installed.sort(key=sort_key, reverse=True)

    ordered = []
    pointer = read_pointer(root)
    if pointer and pointer in installed:
        ordered.append(pointer)
    ordered.extend(v for v in installed if v not in ordered)
    return [os.path.join(versions_dir, v) for v in ordered]


def main():
    root = app_root()
    tried = []
    for version_dir in candidates(root):
        entry = os.path.join(version_dir, ENTRY)
        if not os.path.isfile(entry):
            tried.append(version_dir)
            continue
        try:
            # 传递命令行参数，并把工作目录设为版本目录，
            # 让主程序用相对路径找自己的资源时行为和直接双击一致
            completed = subprocess.run([entry] + sys.argv[1:], cwd=version_dir)
            sys.exit(completed.returncode)
        except OSError:
            tried.append(version_dir)

    message = "启动失败：没有找到可运行的版本。\n已尝试：\n" + "\n".join(tried or ["(versions 目录为空)"])
    try:
        import tkinter.messagebox as mb
        import tkinter as tk

        tk.Tk().withdraw()
        mb.showerror("启动失败", message)
    except Exception:  # noqa: BLE001 - 无图形环境时退回控制台
        sys.stderr.write(message + "\n")
    sys.exit(1)


if __name__ == "__main__":
    main()

# 打包命令（只需执行一次，之后升级不用重打）：
#   pyinstaller --onefile --noconsole --name launcher launcher.py
# 产物 dist/launcher.exe 放到应用根目录即可。
