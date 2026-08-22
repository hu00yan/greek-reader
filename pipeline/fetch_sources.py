"""Download every manifest source file into .cache-corpus/texts/."""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, ".cache-corpus", "texts")

def fetch(task):
    url, out = task
    if os.path.exists(out) and os.path.getsize(out) > 1024:
        return True
    for _ in range(2):
        subprocess.run(["curl", "-sSL", "--retry", "3", "--max-time", "120",
                        "-o", out, url])
        if os.path.exists(out) and os.path.getsize(out) > 1024:
            return True
    return False

man = json.load(open(os.path.join(HERE, "manifest.json")))
os.makedirs(CACHE, exist_ok=True)
tasks = []
for w in man["works"]:
    for f in w["files"]:
        out = os.path.join(CACHE, os.path.basename(f["path"]))
        tasks.append((w["source"] + f["path"], out))
ok = sum(1 for _ in ThreadPoolExecutor(8).map(fetch, tasks))
print(f"[S1] downloaded {ok}/{len(tasks)} source files")
sys.exit(0 if ok == len(tasks) else 1)
