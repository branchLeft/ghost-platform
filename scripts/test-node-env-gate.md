# test-node-env-gate.sh

## What this proves

Proves the NODE_ENV gate LLD-3's gate-set table attributes to this
component: "the container reports production, read from the process rather
than from the file that configured it." LLD-2's own spike found that a
container started with NODE_ENV away from "production" serves normally,
answers every request and errors nothing -- so no health check and no
smoke assertion can ever catch it, only an assertion that execs into the
running process and asks it directly.

This proves the assertion goes both ways: it passes for a correctly
configured container, and -- the sabotage this control needs to prove
itself against -- it goes red for one started with NODE_ENV set away from
"production", even though that container is otherwise indistinguishable:
Ghost still answers 200 throughout.
