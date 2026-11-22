# usedTokens.ts

## The ledger

An invitation is single use. The record of which ones were used is one file per
token in the gate's own directory, named by the SHA-256 of the token's `jti` and
holding its expiry. The file is created exclusively (`wx`), so of two requests
carrying the same token exactly one creates it and the other is told it was
used. That is the whole control: nothing is checked and then recorded in two
steps.

The directory has to outlive the process. A record lost to a restart would let
a used link work again, which is why the adapter's own memory-only record is
not enough on its own.

## Sweeping and the bound

A record is dropped only once its token has expired, when it would be refused
as expired anyway, so a sweep never reopens a replay. A sweep runs at most every
30 seconds. A record that cannot be read is kept until it is older than any
token could be.

A full ledger (10 000 records) refuses to record. Evicting the oldest would let
its token work again; refusing only stops new arrivals until records expire,
and a link lives at most 15 minutes.

## What it does not do

It says nothing about whether a token is genuine. `isUsed` is a read for the
confirmation page, never a gate: only `consume` decides.
