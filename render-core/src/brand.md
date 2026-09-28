# brand.ts

## Branded types

A branded type carries a phantom tag no plain `string` or `number` has, so
TypeScript refuses an unvalidated value in a branded position — the value can
only be produced by the matching `validate*` function below, which is the
only place the tag is attached. This is a compile-time defence only: data
arriving as JSON (over HTTP, from a file) is untyped at the language
boundary, so `validate()` in `./validate.ts` re-checks every one of these at
runtime rather than trusting the type.
