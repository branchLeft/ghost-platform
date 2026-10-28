# host_key_register.py

## Module overview

The host-key register is one reviewed file, `infra/provisioning/host-key-register.txt`,
holding each estate host's SSH **public** host key. This tool reads it, adds to it
and turns it into a `known_hosts` file. It is pure standard library, offline, and
never runs `ssh-keyscan`: a host key comes from the host, recorded once by a
person, never from whatever answered a scan.

A line is `role ssh-ed25519 base64`. A host is named by its **role** (`app1`, the
tenant app host; `db1`, the database host), never by an address. The address
belongs to whoever connects, and is given at fill time. The register is public by
design, so nothing private may enter it: no address, no host name, no comment text
carrying either. `test_host_key_register.py` pins that over the shipped file.

The functions are the interface, so the provisioning controller can import them;
the command line is a thin layer over them. Every refusal raises `RegisterError`,
and the command line turns it into one line on stderr and a non-zero exit.

## parse_key_line

Takes the first two fields of one line and drops any trailing comment (the
`root@host` that `ssh_host_ed25519_key.pub` ends with). Refuses a leading field
that is not `ssh-ed25519` — an address, options such as `command=`, `@cert-authority`
or another key type — a body that is not strict base64 of an ed25519 public key
blob (a length-prefixed `ssh-ed25519` followed by exactly 32 key bytes), and
empty or multi-line input.

## parse_register

Reads the whole file. A non-comment line must be exactly `role ssh-ed25519 base64`
with single spaces. Refuses a repeated role and one key under two roles.

## record

Pure: returns the new text. Refuses a role already recorded with a different key
and a key already recorded under another role. Recording the identical pair again
changes nothing. It never overwrites: **rotating a host's key is a reviewed edit
to the register file**, never a flag on this tool.

The command line is
`record ROLE [--key-file F] [--register P]`, reading the key line from stdin when
`--key-file` is absent, and writing the file atomically. It prints
`recorded ROLE SHA256:...`, the fingerprint `ssh-keygen -lf` shows for the same
key, to compare with the host's own. Recording a key from a host is a root session
on that host, so it is a person's step.

## fill

`fill ROLE ADDRESS [--register P]` prints a short comment header and one line,
`<address> ssh-ed25519 <base64>`. That is the file the tenant deploy job reads with
`ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=known_hosts`. Refuses an
unknown or empty role, and an address that is not a plain IPv4 address or DNS name:
no IPv6, no port, no wildcard or negated pattern, no list, no marker. A port is not
supported, matching the plain `deploy@address` the deploy job uses.

## check

`check [--require ROLE ...] [--register P]` validates the whole register and
refuses a missing required role. `provision-tenant.yml` runs it, and a dry
`fill`, in its input validation, before the tenant repository exists, so a missing
`app1` refuses the run without stranding a created repository.

## The proof

`test_host_key_register.py::RealSshdTests` is the control for the trust root: a
real ssh client held to a real sshd by the filled file. It starts an unprivileged
`sshd` on loopback with a host key made by `ssh-keygen` for the test, records that
key, fills the file, and runs a real `ssh` with `StrictHostKeyChecking=yes` and
nothing else to trust: it connects; with one character of the recorded key changed it is refused with ssh's
own `Host key verification failed`; restored, it connects. The file is the tool's
output unchanged; ssh is given `HostKeyAlias` so the port-less line is the one
looked up on a non-default port. On CI a missing `sshd` fails the test rather than
skipping it.
