#!/usr/bin/python3 -I
# Denies every bridged container on the demo host any connection it opens
# itself; the host keeps its own egress. What it allows, and why it refuses
# to run elsewhere: branchleft_demo_egress.md.
#
# Standard library only, and no shell: every tool is run from an argv list,
# never through a shell.

import os
import shutil
import socket
import subprocess
import sys

FORWARD_CHAIN = "BRANCHLEFT-DEMO-EGRESS"
INPUT_CHAIN = "BRANCHLEFT-DEMO-INPUT"
# docker0 is the default bridge; br-+ is every user-defined bridge network.
BRIDGES = ("docker0", "br-+")
# Seconds a single tool call may run. A call that hangs stops the program
# before any later step, which is the same refusal a failed call gets.
TIMEOUT = 30


def say(message):
    print(f"branchleft-demo-egress: {message}", flush=True)


def die(message):
    print(f"branchleft-demo-egress: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def ruleset():
    lines = [
        "*filter",
        f":{FORWARD_CHAIN} - [0:0]",
        f":{INPUT_CHAIN} - [0:0]",
        f"-A {FORWARD_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
    ]
    for bridge in BRIDGES:
        lines.append(f"-A {FORWARD_CHAIN} -i {bridge} ! -o {bridge} -j REJECT")
    lines.append(f"-A {INPUT_CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN")
    lines.append(f"-A {INPUT_CHAIN} -j REJECT")
    lines.append("COMMIT\n")
    return "\n".join(lines)


def run_tool(argv, **kwargs):
    return subprocess.run(argv, timeout=TIMEOUT, check=False, **kwargs)


def must(argv, **kwargs):
    # A failing step ends the program with that step's own status, as the
    # shell program did under set -e.
    returncode = run_tool(argv, **kwargs).returncode
    if returncode != 0:
        sys.exit(returncode if returncode > 0 else 128 - returncode)


# Inserted first, because an accept ahead of the jump would outrank it.
def ensure_jump(tool, chain, *rule):
    if run_tool([tool, "-t", "filter", "-C", chain, *rule], stderr=subprocess.DEVNULL).returncode == 0:
        say(f"{tool} {chain} already carries: {' '.join(rule)}")
    else:
        must([tool, "-t", "filter", "-I", chain, "1", *rule])
        say(f"{tool} inserted into {chain}: {' '.join(rule)}")


def uses_nftables(tool):
    version = run_tool([tool, "--version"], stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True)
    return "nf_tables" in version.stdout


def apply_family(tool):
    if shutil.which(tool) is None:
        die(f"{tool} is not installed -- Docker brings it; install Docker first")
    restore = f"{tool}-restore"
    if shutil.which(restore) is None:
        die(f"{restore} is not installed -- it comes with {tool}; install iptables first")
    probe = run_tool([tool, "-t", "filter", "-S", "DOCKER-USER"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode != 0:
        # Docker creates this chain when dockerd starts, and dockerd starts the
        # slot containers that carry a restart policy. At boot the unit runs
        # before dockerd, so the chain is made here and Docker finds it there.
        # Docker keeps its own chains in nftables when that backend is active,
        # and a chain made in the legacy tables would then guard nothing.
        if uses_nftables(tool):
            die(f"{tool} uses the nftables backend, so a DOCKER-USER chain made here would not be the one Docker forwards through -- this policy has no safe substitute there")
        must([tool, "-t", "filter", "-N", "DOCKER-USER"])
        say(f"{tool} made DOCKER-USER before Docker starts, so the policy is in force when Docker starts its containers")

    must([restore, "--noflush"], input=ruleset(), text=True)
    ensure_jump(tool, "DOCKER-USER", "-j", FORWARD_CHAIN)
    for bridge in BRIDGES:
        ensure_jump(tool, "INPUT", "-i", bridge, "-j", INPUT_CHAIN)


def main():
    expected_host = os.environ.get("BRANCHLEFT_DEMO_EGRESS_HOST") or "demo1"
    this_host = socket.gethostname().split(".", 1)[0]
    if this_host != expected_host:
        die(f"this host is '{this_host}', not '{expected_host}' -- the demo container egress policy belongs on the demo host only")

    apply_family("iptables")
    apply_family("ip6tables")

    say(f"demo container egress denied on {this_host}")


def run():
    try:
        main()
    except subprocess.TimeoutExpired as expired:
        die(f"{expired.cmd[0]} did not finish within {TIMEOUT}s -- stopped there, and nothing after it ran")


if __name__ == "__main__":
    run()
