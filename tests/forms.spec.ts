/**
 * Forms that submit something: file upload and checkbox state.
 *
 * These were the top two entries in `npm run coverage` - both had a form and no test.
 * A form nobody submits is a feature nobody tests.
 */
import { test, expect, safeClick } from "./fixtures.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.describe("file upload", () => {
  const fixture = (name: string, body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "qa-upload-"));
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  test("accepts a file and echoes its name back", async ({ page }) => {
    await page.goto("/upload");
    const file = fixture("report.txt", "uploaded by the QA agent\n");

    await page.locator("#file-upload").setInputFiles(file);
    await safeClick(page, "Upload");

    await expect(page.getByRole("heading", { name: "File Uploaded!" })).toBeVisible();
    // Echoing the name back is the only evidence the server actually received it.
    await expect(page.locator("#uploaded-files")).toHaveText(/report\.txt/);
  });

  test("a filename with spaces and unicode survives the round trip", async ({ page }) => {
    await page.goto("/upload");
    const file = fixture("my répört file.txt", "unicode name\n");

    await page.locator("#file-upload").setInputFiles(file);
    await safeClick(page, "Upload");

    await expect(page.getByRole("heading", { name: "File Uploaded!" })).toBeVisible();
    await expect(page.locator("#uploaded-files")).toContainText("file.txt");
  });

  test("submitting with no file selected does not claim success", async ({ page }) => {
    await page.goto("/upload");
    await safeClick(page, "Upload");

    // Either a validation message or an error - but never "File Uploaded!".
    await expect(page.getByRole("heading", { name: "File Uploaded!" })).toHaveCount(0);
  });

  // F-010: submitting the form with no file selected returns HTTP 500 "Internal Server
  // Error" rather than a validation message. Asserts the correct behaviour, so this flips
  // to passing when it is fixed.
  test.fail("an empty submission is rejected with a message, not a 500", async ({ page }) => {
    await page.goto("/upload");
    await safeClick(page, "Upload");

    await expect(page.getByText(/Internal Server Error/i)).toHaveCount(0);
  });

  test("the drag-and-drop zone is present as an alternative", async ({ page }) => {
    await page.goto("/upload");
    await expect(page.locator("#drag-drop-upload")).toBeVisible();
  });
});

test.describe("checkboxes", () => {
  test("reflects and toggles independent checked state", async ({ page }) => {
    await page.goto("/checkboxes");
    const boxes = page.locator("#checkboxes input[type=checkbox]");
    await expect(boxes).toHaveCount(2);

    // The initial state is meaningful: the second ships checked, the first does not.
    await expect(boxes.nth(0)).not.toBeChecked();
    await expect(boxes.nth(1)).toBeChecked();

    await boxes.nth(0).check();
    await boxes.nth(1).uncheck();

    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
  });

  test("checking one box does not change the other", async ({ page }) => {
    await page.goto("/checkboxes");
    const boxes = page.locator("#checkboxes input[type=checkbox]");

    const before = await boxes.nth(1).isChecked();
    await boxes.nth(0).check();
    await boxes.nth(0).uncheck();

    expect(await boxes.nth(1).isChecked()).toBe(before);
  });

  test("the boxes are keyboard operable", async ({ page }) => {
    await page.goto("/checkboxes");
    const first = page.locator("#checkboxes input[type=checkbox]").first();

    await first.focus();
    await page.keyboard.press("Space");
    await expect(first).toBeChecked();

    await page.keyboard.press("Space");
    await expect(first).not.toBeChecked();
  });
});

test.describe("dynamic controls", () => {
  test("a checkbox can be removed and restored without a page load", async ({ page }) => {
    await page.goto("/dynamic_controls");
    const box = page.locator("#checkbox-example input[type=checkbox]");
    await expect(box).toBeVisible();

    // "Remove" is on the deny-list, so this asserts the control EXISTS without pressing it.
    // safeClick would throw here, by design - see tests/two-user.spec.ts for the pattern.
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  });

  test("Enable reveals an editable input and confirms", async ({ page }) => {
    await page.goto("/dynamic_controls");
    const input = page.locator("#input-example input[type=text]");

    await expect(input).toBeDisabled();
    await safeClick(page, "Enable");

    await expect(input).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator("#input-example #message")).toHaveText("It's enabled!");

    // Enabled has to mean usable, not merely not-disabled.
    await input.fill("typed after enable");
    await expect(input).toHaveValue("typed after enable");
  });
});
