# 0002. LWP3 test vectors

Status: accepted

## Context

The official LWP3 docs describe fields and tables but contain no full-packet examples (only isolated cases such as the length field and the version number). Tests need byte vectors, and a wrong vector gives false confidence.

## Decision

Every LWP3 test vector carries a comment with its origin:

- `literal`: copied from the docs (cite the section).
- `derivado del layout`: built by hand from a doc section and cross-checked against pylgbst, node-poweredup and pybricksdev. The comment says which sources agreed. Cross-checking means comparing bytes only; no code is copied (license compatibility).
- `capturado`: recorded from a real hub, stored in `fixtures/`.

Captured vectors win. If one contradicts a derived vector, the derived vector is corrected, and the discrepancy goes in `docs/protocol-notes.md`. Anything not confirmed by the docs or the cross-check sources is marked `TODO(hw)` and listed in that file.

Parsing rules:

- Multibyte fields are little-endian by default. The only exception is the MAC address, which the docs (3.5.5 note G) say is big-endian.
- Length tolerance: bytes beyond the declared length are ignored; a declared length longer than the buffer is a `truncated` error; a payload shorter than the message minimum is an error. `decode` never throws; encoders throw `RangeError` on invalid input.

Robustness: a property test with fast-check checks that `decode` never throws on arbitrary bytes. It uses a fixed seed so CI is deterministic.

## Consequences

Vectors are only as good as their origin label. Until real captures exist, derived vectors are best guesses and the `TODO(hw)` list is the backlog for hardware testing.
