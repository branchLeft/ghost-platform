# yaml.ts

## toYaml

A deliberately tiny YAML emitter for the one document this component
produces.

Not a general serialiser and not a dependency: the alternative was adding a
YAML library to a package whose whole output is one fixed-shape document,
and a general emitter's quoting rules are a larger surface to reason about
than the four value types below. It handles maps, sequences, strings,
finite numbers and booleans, and throws on anything else rather than
emitting something that parses differently than it reads.

Every string is single-quoted. YAML's plain scalars are where the format's
surprises live — `no` parses as `false`, `10:00` as a sexagesimal integer,
a leading `*` as an alias — and a Compose file carries UIDs, ports and
image digests that sit close to all three. Quoting unconditionally costs
some readability on the host and removes the entire class.

Quoting is not escaping, and the difference is the reason `quote` refuses
control characters outright: a single-quoted scalar has exactly one escape
(a doubled quote) and no representation at all for a newline that does not
change the document's structure. Refusing is the only faithful option, so
this emitter throws rather than emitting a string it cannot round-trip.

## UNQUOTABLE

Characters a single-quoted YAML scalar cannot carry faithfully.

A newline inside a single-quoted scalar is *legal* YAML — it folds, or
begins a new document line — which is exactly why it has to be refused
rather than emitted. A tenant-supplied value carrying one breaks out of its
scalar and its remainder is parsed as document structure: at the right
indentation that is a new mapping key, and `cap_add:` is a mapping key. The
runtime-posture check cannot see it, because that runs over the object
before serialisation and the object holds one well-formed string.

So the refusal is here, at the one place that turns objects into document
text. C0 controls, DEL and the C1 range go with it: none of them belongs in
a Compose file, and each has its own way of being read differently than it
looks.
