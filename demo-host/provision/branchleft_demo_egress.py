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


# Where systemd keeps its runtime state. Where it is absent (a container, a host
# without systemd), the unit cannot be asked about, and the other sources decide.
SYSTEMD_RUN_DIR = "/run/systemd/system"
PROC_DIR = "/proc"
ARGV_TEXT = re.compile(r"argv\[\]=([^;\n]*)")
ENVIRONMENT_FILE = re.compile(r"^EnvironmentFile=(\S+)(.*)$", re.MULTILINE)
FIREWALL_FLAG = re.compile(r"--firewall-backend[= \t]+(\S+)")
FIREWALL_ENV = re.compile(r"DOCKER_FIREWALL_BACKEND=(\S+)")


def systemd_run_dir():
    # Read at call time, so a test can name a directory of its own.
    return os.environ.get("BRANCHLEFT_DEMO_EGRESS_SYSTEMD_DIR") or SYSTEMD_RUN_DIR


def proc_dir():
    return os.environ.get("BRANCHLEFT_DEMO_EGRESS_PROC") or PROC_DIR


def says_nftables(text):
    # Quotes belong to systemd and the shell, never to the value, so they go first.
    text = text.replace('"', "").replace("'", "")
    values = [m.group(1) for m in FIREWALL_FLAG.finditer(text)]
    values += [m.group(1) for m in FIREWALL_ENV.finditer(text)]
    return any(value.rstrip(";}").lower() == "nftables" for value in values)


def config_says_nftables(path, required):
    # A config file dockerd names must exist; the default daemon.json may be absent.
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        if required:
            die(f"{path} does not exist -- dockerd names it as its config, and this policy will not guess")
        return False
    except (OSError, ValueError) as error:
        die(f"cannot read {path} ({error}) -- its firewall-backend decides where Docker keeps its rules, and this policy will not guess")
    if not isinstance(config, dict):
        die(f"{path} is not a JSON object -- its firewall-backend decides where Docker keeps its rules, and this policy will not guess")
    value = config.get("firewall-backend")
    return isinstance(value, str) and value.lower() == "nftables"


def config_files_in(tokens):
    # --config-file=<path> or --config-file <path>: the file dockerd reads instead of the default.
    paths = []
    for index, token in enumerate(tokens):
        token = token.strip("\"'")
        if token.startswith("--config-file="):
            paths.append(token.split("=", 1)[1])
        elif token == "--config-file":
            if index + 1 >= len(tokens):
                die("dockerd's --config-file names no path -- cannot tell which firewall backend it runs with, and this policy will not guess")
            paths.append(tokens[index + 1].strip("\"'"))
    return paths


def environment_file_text(path, optional):
    # An EnvironmentFile is read by systemd for dockerd; its assignments can name the backend.
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        if optional:
            return ""
        die(f"{path} does not exist -- systemd reads it for dockerd, and this policy will not guess")
    except (OSError, ValueError) as error:
        die(f"cannot read {path} ({error}) -- systemd reads it for dockerd, and this policy will not guess")


def systemd_unit_text():
    # The docker unit as systemd shows it: ExecStart, Environment, EnvironmentFile, drop-ins included.
    argv = ["systemctl", "show", DOCKER_UNIT, "--no-pager", "--property=LoadState",
            "--property=NeedDaemonReload", "--property=ExecStart", "--property=Environment",
            "--property=EnvironmentFile"]
    try:
        done = run_tool(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as error:
        die(f"systemd keeps its state here, but systemctl cannot run ({error}) -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    lines = done.stdout.splitlines()
    if done.returncode != 0 or "LoadState=loaded" not in lines:
        die(f"systemd does not show {DOCKER_UNIT} as loaded -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    if "NeedDaemonReload=yes" in lines:
        die(f"systemd has changed {DOCKER_UNIT} without a daemon-reload -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    return done.stdout


def unit_says_nftables(text):
    if says_nftables(text):
        return True
    for match in ENVIRONMENT_FILE.finditer(text):
        path = match.group(1).lstrip("-")
        optional = "ignore_errors=yes" in match.group(2)
        if says_nftables(environment_file_text(path, optional)):
            return True
    for segment in ARGV_TEXT.finditer(text):
        for path in config_files_in(segment.group(1).split()):
            if config_says_nftables(path, required=True):
                return True
    return False


def running_dockerd_says_nftables():
    # No systemd: the dockerd processes that exist are read directly, command line and environment.
    base = proc_dir()
    try:
        entries = os.listdir(base)
    except OSError as error:
        die(f"cannot list {base} ({error}) -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(os.path.join(base, entry, "comm"), encoding="utf-8") as handle:
                comm = handle.read().strip()
        except OSError:
            continue  # the process has gone
        if comm != "dockerd":
            continue
        try:
            argv = read_nul_list(os.path.join(base, entry, "cmdline"))
            environ = read_nul_list(os.path.join(base, entry, "environ"))
        except OSError as error:
            die(f"cannot read dockerd's command line or environment in {base}/{entry} ({error}) -- cannot tell which firewall backend dockerd runs with, and this policy will not guess")
        if says_nftables(" ".join(argv) + " " + " ".join(environ)):
            return True
        for path in config_files_in(argv):
            if config_says_nftables(path, required=True):
                return True
    return False


def read_nul_list(path):
    with open(path, "rb") as handle:
        return [item.decode("utf-8", "replace") for item in handle.read().split(b"\0") if item]


def docker_uses_nftables():
    # Docker decides where it keeps its rules, from its own setting. The iptables
    # binary's variant does not decide it: Debian 13 prints (nf_tables) for
    # iptables 1.8.11 while Docker still writes iptables rules.
    if os.environ.get("DOCKER_FIREWALL_BACKEND", "").lower() == "nftables":
        return True
    if config_says_nftables(daemon_json_path(), required=False):
        return True
    if os.path.isdir(systemd_run_dir()):
        return unit_says_nftables(systemd_unit_text())
    return running_dockerd_says_nftables()


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
        die("Docker is set to the nftables firewall backend (firewall-backend in daemon.json or a --config-file, --firewall-backend or DOCKER_FIREWALL_BACKEND in dockerd or its systemd unit or EnvironmentFile, or DOCKER_FIREWALL_BACKEND in this environment), so the iptables tables this policy writes are not the ones Docker forwards through -- this policy has no safe substitute there")

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
