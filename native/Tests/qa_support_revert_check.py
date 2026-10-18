"""Revert-check proxy for the Mac support-request fixes (no Swift toolchain on the Linux box).

Faithful Python ports of GDAccountContract/GDAccountDeletion support logic at f106a7b
(native/Sources/GDAccountContract.swift:339-392, GDAccountDeletion.swift:246-270), plus
one mutant per fix that restores the pre-fix code. The case tables are copied from
SupportRequestMonitorTests.swift at f106a7b. A fix is "pinned" if its mutant fails >=1 case.
"""
import math, sys

JOB = "00000000-0000-4000-8000-00000000000a"
OTHER = "00000000-0000-4000-8000-000000000009"
TOK = "S" * 42 + "1"
SWIFT_WS = set(" \t\n\r\x0b\x0c\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000")

def blank(s): return all(c in SWIFT_WS for c in s)

def retry_new(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)): return 60
    if not math.isfinite(v) or v <= 0: return 60
    return int(min(86400.0, max(1.0, float(v))))

def retry_old(v):
    if isinstance(v, bool): v = int(v)
    return max(0, int(v)) if isinstance(v, (int, float)) and math.isfinite(v) else 0

class Impl:
    def __init__(self, **mut): self.m = mut
    def interpret(self, status, js):
        if status == 202 and js.get("status") == "received" and js.get("requestId"): return ("received", js["requestId"])
        if self.m.get("old429"):
            if status == 429 and (js.get("error") or js.get("code")) == "rate_limited": return ("rateLimited", retry_old(js.get("retryAfterSec")))
        elif status == 429: return ("rateLimited", retry_new(js.get("retryAfterSec")))
        if self.m.get("old409"):
            if status == 409 and (js.get("error") or js.get("code")) in ("support_not_needed", "not_needed"): return ("notNeeded",)
        elif status == 409 and js.get("error") == "support_not_needed": return ("notNeeded",)
        return ("fallback",)
    def needs_refresh(self, status, js):
        if self.m.get("old409"): return status == 409 and (js.get("error") or js.get("code")) not in ("support_not_needed", "not_needed")
        return status == 409 and js.get("error") == "support_not_needed"
    def refresh(self, status, js):
        ok = (status == 200) if self.m.get("old200") else (200 <= status < 300)
        if not ok or js.get("jobId") != JOB or not isinstance(js.get("status"), str): return ("fallback",)
        return ("notNeeded",) if js["status"] in ("queued", "running", "done") else ("fallback",)
    def allowed(self, req, saved, tok):
        if self.m.get("noBlankGuard"): return bool(req) and bool(saved) and bool(tok) and req == saved
        return not blank(req) and not blank(saved) and not blank(tok) and req == saved
    def run(self, saved, req, replies):
        sent = []
        replies = list(replies)
        if saved is None or not self.allowed(req, saved[0], saved[1]): return ("fallback",), sent
        sent.append("POST")
        r = replies.pop(0) if replies else None
        if r is None: return ("fallback",), sent
        if not self.needs_refresh(*r): return self.interpret(*r), sent
        sent.append("GET")
        r2 = replies.pop(0) if replies else None
        if r2 is None: return ("fallback",), sent
        return self.refresh(*r2), sent

SAVED = (JOB, TOK)
R = lambda n: ("rateLimited", n)
CASES = []
def case(name, saved, req, replies, expect, sent):
    CASES.append((name, saved, req, replies, expect, sent))
# testEmptyStatusTokenSendsNothing (f106a7b table)
for t in ["", "   ", "\n", "\t", " \t\r\n "]:
    case(f"blank token {t!r}", (JOB, t), JOB, [(202, {"status": "received", "requestId": "never"})], ("fallback",), [])
case("empty jobId", SAVED, "", [(202, {"status": "received", "requestId": "never"})], ("fallback",), [])
case("jobId mismatch", SAVED, OTHER, [(202, {"status": "received", "requestId": "never"})], ("fallback",), [])
case("no saved job", None, JOB, [(202, {"status": "received", "requestId": "never"})], ("fallback",), [])
case("received", SAVED, JOB, [(202, {"status": "received", "requestId": "r1"})], ("received", "r1"), ["POST"])
for s, c in [(401, "unauthorized"), (404, "not_found"), (500, "internal"), (502, "internal"), (503, "internal"), (400, "bad_request"), (403, "forbidden"), (410, "gone"), (422, "invalid")]:
    case(f"{s} {c}", SAVED, JOB, [(s, {"error": c})], ("fallback",), ["POST"])
case("network", SAVED, JOB, [None], ("fallback",), ["POST"])
for st in ["queued", "running", "done"]:
    case(f"409 snn -> {st}", SAVED, JOB, [(409, {"error": "support_not_needed"}), (200, {"jobId": JOB, "status": st, "retryable": True})], ("notNeeded",), ["POST", "GET"])
for i, rr in enumerate([(200, {"jobId": JOB, "status": "failed"}), (200, {"jobId": OTHER, "status": "done"}), (200, {"jobId": JOB, "status": "completed"}),
                        (200, {"jobId": JOB}), (200, {}), (401, {"error": "invalid_token"}), (404, {"error": "not_found"}), (500, {"error": "internal"}), None]):
    case(f"409 snn -> bad refresh #{i}", SAVED, JOB, [(409, {"error": "support_not_needed"}), rr], ("fallback",), ["POST", "GET"])
for b in [{"error": "deletion_not_retryable", "jobId": JOB}, {"error": "conflict"}, {"error": "not_needed"}, {"code": "support_not_needed"}, {}]:
    case(f"409 other {b}", SAVED, JOB, [(409, b), (200, {"jobId": JOB, "status": "done"})], ("fallback",), ["POST"])
for v, e in [(-5, 60), (0, 60), (None, 60), (120, 120), (86400, 86400), (999999, 86400), ("120", 60), (True, 60), (math.inf, 60), (math.nan, 60), (0.5, 1)]:
    js = {"error": "rate_limited"} if v is None else {"error": "rate_limited", "retryAfterSec": v}
    case(f"429 retryAfter {v!r}", SAVED, JOB, [(429, js)], R(e), ["POST"])
for js, e in [({}, 60), ({"error": "too_many_requests", "retryAfterSec": 300}, 300), ({"code": "slow_down"}, 60)]:
    case(f"429 any {js}", SAVED, JOB, [(429, js)], R(e), ["POST"])
# Extra QA cases from the steering brief (not in the XCTest file):
case("QA 409 snn -> cancelled", SAVED, JOB, [(409, {"error": "support_not_needed"}), (200, {"jobId": JOB, "status": "cancelled"})], ("fallback",), ["POST", "GET"])
case("QA 409 snn -> empty status", SAVED, JOB, [(409, {"error": "support_not_needed"}), (200, {"jobId": JOB, "status": ""})], ("fallback",), ["POST", "GET"])
case("QA 409 snn -> missing jobId", SAVED, JOB, [(409, {"error": "support_not_needed"}), (200, {"status": "done"})], ("fallback",), ["POST", "GET"])
case("QA 409 snn -> 204 done", SAVED, JOB, [(409, {"error": "support_not_needed"}), (204, {"jobId": JOB, "status": "done"})], ("notNeeded",), ["POST", "GET"])

def score(impl):
    bad = []
    for name, saved, req, replies, expect, sent in CASES:
        got, s = impl.run(saved, req, replies)
        if got != expect or s != sent: bad.append(f"{name}: got {got} sent {s}, want {expect} sent {sent}")
    return bad

ok = True
base = score(Impl())
print(f"f106a7b port: {len(CASES) - len(base)}/{len(CASES)} pass"); [print("  ", b) for b in base]
ok &= not base
for label, mut in [("revert f106a7b 429 rule", {"old429": True}), ("revert 79352a4 409 rule", {"old409": True}),
                   ("revert 79352a4 2xx refresh", {"old200": True}), ("revert 8efe063 blank-token guard (isEmpty only)", {"noBlankGuard": True})]:
    b = score(Impl(**mut))
    print(f"{label}: {len(b)} case(s) fail -> {'PINNED' if b else 'NOT PINNED'}")
    for x in b[:4]: print("   ", x)
sys.exit(0 if ok else 1)
