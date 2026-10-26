<h1 align="center">FeedbackOS</h1>

<p align="center">
  <strong>The feedback, roadmap, changelog, help center, support and status portal behind PayGlue.</strong>
</p>

<p align="center">
  A fork of <a href="https://github.com/QuackbackIO/quackback">Quackback</a>.
</p>

<p align="center">
  <a href="https://github.com/QuackbackIO/quackback"><img src="https://img.shields.io/badge/fork%20of-Quackback-f5a623" alt="Fork of Quackback" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0" /></a>
</p>

## What this is

FeedbackOS is the instance PayGlue runs for its customers at
[hub.payglue.io](https://hub.payglue.io) and
[docs.payglue.io](https://docs.payglue.io): feedback board, roadmap, changelog,
help center, support inbox with tickets, and status page. It is used for PayGlue
itself and is not offered as a product of its own.

It is a fork of [Quackback](https://github.com/QuackbackIO/quackback), modified
since October 2026 by PayGlue. The complete source code of the running instance
lives in this repository, on the `payglue` branch. What changed compared to
Quackback is listed in [FORK.md](FORK.md).

For setup, configuration and self-hosting, follow the
[Quackback documentation](https://quackback.io/docs). Everything there applies
here; the additions in this fork are configured through the environment
variables listed in [FORK.md](FORK.md).

## Not affiliated with Quackback

"Quackback" is the name of the original project. This fork is not affiliated
with, and is not endorsed by, the Quackback project or its maintainers. Bugs in
this fork belong in this repository, not upstream.

## Forking FeedbackOS

The code is licensed under the AGPL-3.0 and you are welcome to use it under that
licence. The names and logos "FeedbackOS" and "PayGlue" are not part of the AGPL
licensing. If you fork this repository, replace our names and logos with your
own, the way we replaced Quackback's.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a network service, the
AGPL requires you to offer your users the source code of that version.
