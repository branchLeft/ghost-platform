#!/usr/bin/python3 -I
# Denies every bridged container on the demo host any connection it opens
# itself; the host keeps its own egress. What it allows, and why it refuses
# to run elsewhere: branchleft_demo_egress.md.
#
# Standard library only, and no shell: every tool is run from an argv list,
# never through a shell.

import json
import os
import re
import shutil
import socket
import subprocess
import sys

# Docker's own configuration, which names its firewall backend.
DAEMON_JSON = "/etc/docker/daemon.json"
# The unit that starts dockerd. Its drop-ins and command line are read from systemd.
DOCKER_UNIT = "docker.service"
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


def daemon_json_path():
    # Read at call time, so a test can name a file of its own.
    return os.environ.get("BRANCHLEFT_DEMO_EGRESS_DAEMON_JSON") or DAEMON_JSON


def systemd_docker_backends():
    # The backend named on dockerd's command line or in its unit environment, drop-ins
    # included, as systemd reports the unit. A unit systemd cannot show is a refusal.
    try:
        done = run_tool(["systemctl", "show", DOCKER_UNIT, "--no-pager",
                         "--property=LoadState", "--property=ExecStart", "--property=Environment"],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError:
        die("systemctl is not installed -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    if done.returncode != 0 or "LoadState=loaded" not in done.stdout:
        die(f"systemd does not show {DOCKER_UNIT} as loaded -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    backends = [m.group(1) for m in re.finditer(r"--firewall-backend[=\s]+(\S+)", done.stdout)]
    backends += [m.group(1) for m in re.finditer(r"DOCKER_FIREWALL_BACKEND=(\S+)", done.stdout)]
    return backends


def docker_uses_nftables():
    # Docker decides where it keeps its rules, from its own setting. The iptables
    # binary's variant does not decide it: Debian 13 prints (nf_tables) for
    # iptables 1.8.11 while Docker still writes iptables rules.
    if os.environ.get("DOCKER_FIREWALL_BACKEND") == "nftables":
        return True
    path = daemon_json_path()
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        config = {}
    except (OSError, ValueError) as error:
        die(f"cannot read {path} ({error}) -- its firewall-backend decides where Docker keeps its rules, and this policy will not guess")
    if not isinstance(config, dict):
        die(f"{path} is not a JSON object -- its firewall-backend decides where Docker keeps its rules, and this policy will not guess")
    if config.get("firewall-backend") == "nftables":
        return True
    return "nftables" in systemd_docker_backends()


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

    # Docker set to nftables keeps its rules there, so a policy written to the
    # iptables tables would guard nothing. Refused before anything is written.
    if docker_uses_nftables():
        die("Docker is set to the nftables firewall backend (firewall-backend in daemon.json, --firewall-backend or DOCKER_FIREWALL_BACKEND in its systemd unit, or DOCKER_FIREWALL_BACKEND in this environment), so the iptables tables this policy writes are not the ones Docker forwards through -- this policy has no safe substitute there")

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
