# choose-apply-environment.py

Run by the plan job of `infra-hosts-ci.yml` and `infra-demo-host-ci.yml` after
the spend gate. It prints `production-free` only when every input is exactly
the good value. Every other input, missing or odd, picks the stack's own owner
environment (`production` for the hosts stack, `production-demo-host` for the
demo host, named by `--owner-environment`), where the owner approves. The rule
and its reasons are in `decide()`.

It reads the four inputs from the environment, never from arguments, so
nothing the plan produced is parsed as a flag. It writes the choice to the
GitHub output and summary files it is given. The owner environment argument
must be a plain lower-case name and is never `production-free` itself.

An exit status other than 0 writes nothing. The workflow reads an unset output
as the owner environment, so a crash here also lands on the owner's
environment.

`fixtures/choose-apply-environment/` holds the output files the pinned spend
gate wrote when run over its own preview fixtures; the tests feed the route
the verdicts in them.
