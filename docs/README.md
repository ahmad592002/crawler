# QA Agent — documentation

The root [`README.md`](../README.md) is the quick start. These pages are the reference.

| Page | Read it when |
|---|---|
| [running.md](running.md) | You are setting this up and running it on another machine, step by step. |
| [architecture.md](architecture.md) | You want to know what actually runs, in what order, and why the pipeline is split the way it is. |
| [configuration.md](configuration.md) | You are pointing this at a new site, or a knob is not doing what you expected. |
| [safety.md](safety.md) | **Before you run this against anything you care about.** What the guardrails cover, what they provably do not, and the threat model. |
| [data-formats.md](data-formats.md) | You are reading `output/*.jsonl` by hand, or writing a tool that consumes it. |
| [multi-user.md](multi-user.md) | You are testing something that needs two people, or checking one user cannot read another's data. |
| [email.md](email.md) | You are testing a signup or verification flow. |
| [burp-export.md](burp-export.md) | You want the HTTP capture in Burp/ZAP, or you are checking the export against a real one. |
| [ci.md](ci.md) | You are wiring this into a pipeline. Read the artifact section in particular. |
| [development.md](development.md) | You are changing the code. |
| [troubleshooting.md](troubleshooting.md) | Something is failing and you want the known causes first. |
| [../CHANGELOG.md](../CHANGELOG.md) | You used an earlier version and want to know what changed and why. |

## The 30-second version

A plain Node/Playwright crawler inventories the site into JSONL. Claude reads that
inventory, explores features, and writes findings. A script turns those findings into an
ordinary Playwright suite. A script renders everything as one HTML file.

```
crawl (script)  ->  explore (Claude)  ->  suite (script)  ->  report (script)
   fast, free        the thinking         fast, free          fast, free
```

Claude is used only where judgement is needed. Everything repeatable is a script, so the
nightly run costs nothing and the AI cost is paid once per feature, not once per run.

## Ground rules

Three things are true of this tool and are not negotiable by configuration:

1. **It is a testing tool, not a scanner.** Point it at a site you own or have written
   permission to test. Ideally staging, with disposable data.
2. **The deny-list is a guard rail, not a seat belt.** It reduces the chance of touching
   something destructive. It cannot eliminate it. [safety.md](safety.md) is specific about
   where the edges are.
3. **The HTTP capture and Playwright traces contain live credentials.** Cookies,
   `Authorization` headers, session state. Treat those files as secrets. See
   [ci.md](ci.md#what-must-never-be-uploaded).
