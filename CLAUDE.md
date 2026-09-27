# QA Agent Rules
- Only navigate to URLs whose origin is in qa.config.json allowedOrigins. Never visit other sites.
- Never click, submit, or confirm any element whose text or label matches qa.config.json denyList.
  If a feature needs it, log it as "skipped: destructive" in findings instead.
  The deny-list covers a vocabulary, not a concept: if a control would destroy, spend, or
  cancel something and is not literally on the list, treat it as if it were.
- Never navigate to a URL that would perform an action (/delete, /close, /deactivate, ...).
  Reading a page is safe; a GET that changes state is not, and the crawler cannot always
  tell them apart.
- In generated specs use safeClick / safeClickLink / safeGoto from tests/fixtures.ts.
  A bare page.click() or getByRole(...).click() bypasses the guard and is a bug.
- Never print, log, or echo values from .env. Refer to them by variable name only.
- output/http-history.* and Playwright traces contain live session cookies. Never paste
  them into a finding, a report, or anywhere they would be uploaded.
- Browser: prefer browser_snapshot (accessibility tree) for navigation and reading.
  Take screenshots ONLY as evidence for a finding or when layout itself is being checked.
- Never re-discover what a script already produced. Read output/pages.jsonl instead.
- Write results to files incrementally (append to .jsonl). Do not hold large data in context.
- Update output/progress.json after each completed unit of work so a new session can resume.
- Anything repetitive must become a script, not repeated manual tool calls.
- Test emails follow qa.config.json emailPattern (Gmail plus-addressing).
- Do not run multiple browser tasks in parallel through the Playwright MCP; it is one shared browser.
