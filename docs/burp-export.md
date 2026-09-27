# HTTP capture and Burp export

With `captureHttpHistory` on, the crawl doubles as a proxy capture. Every
request/response pair is reconstructed as a raw HTTP message and written twice:

- **`output/http-history.jsonl`** — appended per exchange, so an interrupted crawl still
  leaves a readable file.
- **`output/http-history.xml`** — Burp Suite proxy-history schema, serialised at the end.
  XML needs its closing root tag, so it cannot be appended safely.

```json
{
  "captureHttpHistory": true,
  "captureMaxBodyBytes": 2000000,
  "captureOffOrigin": false
}
```

Import via Burp's **Proxy → HTTP history → right-click → Import items**, or load it in
anything else that reads the format. `npm run export:burp` re-serialises the XML from an
existing JSONL without re-crawling.

> ## This file contains credentials
>
> It is a verbatim record of every request, `Cookie` and `Authorization` headers included.
> On a `crawl:auth` run that is your live session. In a representative capture, **467 of
> 469 recorded requests carried a `Cookie` header.**
>
> Never attach it to a ticket, never upload it as a CI artifact, never commit it. The
> supplied workflow excludes it, and excludes Playwright traces for the same reason. See
> [ci.md](ci.md#what-must-never-be-uploaded).

## Budget for the size

A full 60-page crawl produced **469 exchanges → 70 MB**, about 152 KB each, and the JSONL
and XML each hold a full copy. Capture is off by default for this reason.

Turn it on for a run you actually intend to analyse. If you only need headers and small
payloads, drop `captureMaxBodyBytes` to something like `200000`. Do not enable it in CI
without lowering that first.

## Fidelity against a real Burp export

The output was diffed against a genuine Burp export. Verified, specifically:

- **Prolog and DOCTYPE are byte-identical**, CRLF line endings included.
- Same 14 elements in Burp's order; same `host@ip`, `request@base64`, `response@base64`
  attributes; same `<comment></comment>`; same trailing bytes.
- CDATA on exactly the five fields Burp wraps — `url`, `method`, `path`, `request`,
  `response`. `time`, `host`, `protocol`, `extension` and `mimetype` are plain escaped
  text. Matching Burp means **not** over-applying CDATA.
- `<time>` and `exportTime` in Java's `Date.toString()` form —
  `Thu May 14 14:15:07 EEST 2026`, local time with a zone abbreviation, not ISO 8601.
  Importers parse this field, so the shape has to match. `en-GB` is used to resolve the
  zone abbreviation because `en-US` falls back to `GMT+3` for most non-US zones, which is
  not what a JVM writes.
- `<responselength>` is the length of the **whole raw response message, headers
  included** — measured against the reference file, not assumed.

That last point was wrong for a long time. It used to be the *body* length, which is short
by the header block on every single item:

```
reference:  responselength=460      message=460      body=43
this tool:  responselength=4072     message=5384     body=4072    <- wrong
after fix:  responselength=5384     message=5384     body=4072
```

Existing captures do not need re-recording: `readHistory()` recomputes the value from the
stored message when it disagrees.

Raw messages preserve what the server actually sent, including a missing reason phrase
(`HTTP/1.1 404 `) where one is absent.

## Where the export deliberately differs from the wire

Two cases, both because reproducing the bytes exactly would produce a message no parser
can read.

**Truncated bodies.** A body cut at `captureMaxBodyBytes` gets its `Content-Length`
rewritten to the truncated size, plus an `X-QA-Agent-Truncated: original-body-N-bytes`
marker. Left alone, the message promises megabytes and delivers what fits, and any tool
that parses it per RFC 9112 sees a message that terminates early. The JSONL also records
`truncated` and `fullBodyLength`.

**`Content-Encoding` is dropped.** Playwright hands back an already-decoded body, so
leaving the header in place would tell an importer to inflate plain bytes.

HTTP/2 pseudo-headers (`:method`, `:path`, …) are skipped, since they are not part of an
HTTP/1.1 message. A `Host:` header is synthesised if the captured headers lack one.

## XML hardening

Three classes of input would otherwise corrupt or destroy the export.

**Characters XML forbids.** Control bytes (`0x00`–`0x08`, `0x0B`, `0x0C`, `0x0E`–`0x1F`)
and lone surrogates are illegal in XML 1.0 **anywhere, CDATA included**. One such byte in
one URL makes the entire file unparseable:

```
System.Xml: "'', hexadecimal value 0x01, is an invalid character. Line 28, position 37."
```

There is no partial recovery — a single odd request destroys a 70 MB capture, and the
failure lands at import time, long after the crawl. They are now stripped at
serialisation.

**Attribute injection.** Element text and attribute values need different escaping.
Sharing one function meant an `ip` of `1" evil="y` silently produced a second,
attacker-chosen attribute on `<host>`. `xmlAttr()` is now separate and escapes quotes.

**Non-numeric numbers.** `export:burp` reads a JSONL that this process may not have
written, so `port`, `status` and `responselength` are coerced rather than interpolated
raw. A status of `200</status><x>` used to land in the document verbatim.

`]]>` inside a CDATA field is split across two sections, which was always handled
correctly.

All of this is regression-tested in `src/guards.test.ts`.

## Scope

Capture is scoped to `allowedOrigins` by default — a proxy history of the target is the
point, and recording every CDN and tracker just bloats the file. `captureOffOrigin: true`
records third parties, and also stops them being blocked at all, which will slow the crawl
considerably.

In-flight captures are **drained before the browser closes**. `response.body()` throws
once the context is gone, and those failures are swallowed by design (one unreadable
exchange must never interrupt a crawl) — so without an explicit drain the last exchanges
of every run went missing silently.

## Verifying an export yourself

```bash
npm run export:burp

# well-formedness (Windows)
powershell -c "$x=New-Object System.Xml.XmlDocument; $x.XmlResolver=$null;
               $x.Load('output/http-history.xml'); 'OK'"

# well-formedness (anywhere with xmllint)
xmllint --noout output/http-history.xml && echo OK

# prolog + DOCTYPE parity against a reference export
head -24 output/http-history.xml | cmp - <(head -24 /path/to/reference.xml)
```
