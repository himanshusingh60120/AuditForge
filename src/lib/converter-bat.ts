"use client";
import { downloadText } from "./exports";

/**
 * The one-click Screaming Frog → CSV converter, embedded in the tool.
 * Offered as a download whenever a Derby-mode project is detected, so the
 * fix ships with the error. Batch files want CRLF line endings.
 */
const BAT_LINES = [
  "@echo off",
  "REM ============================================================",
  "REM  AuditForge crawl converter",
  "REM  USAGE: drag your .dbseospider / .seospider file onto this",
  "REM  .bat file in Explorer. It exports internal_all.csv and",
  "REM  all_inlinks.csv into an \"auditforge-export\" folder next to",
  "REM  your project file.",
  "REM  IMPORTANT: close the Screaming Frog app first - it locks",
  "REM  the crawl database while open.",
  "REM ============================================================",
  "setlocal",
  "",
  "if \"%~1\"==\"\" (",
  "  echo No file received.",
  "  echo Drag your .dbseospider file onto this .bat file in Explorer.",
  "  pause",
  "  exit /b 1",
  ")",
  "",
  "set \"SF=C:\\Program Files (x86)\\Screaming Frog SEO Spider\"",
  "if not exist \"%SF%\\ScreamingFrogSEOSpiderCli.exe\" set \"SF=C:\\Program Files\\Screaming Frog SEO Spider\"",
  "if not exist \"%SF%\\ScreamingFrogSEOSpiderCli.exe\" (",
  "  echo Screaming Frog CLI not found in the default install locations.",
  "  echo Edit the SF path at the top of this file to match your install.",
  "  pause",
  "  exit /b 1",
  ")",
  "",
  "set \"OUT=%~dp1auditforge-export\"",
  "mkdir \"%OUT%\" 2>nul",
  "",
  "echo.",
  "echo Converting: %~nx1",
  "echo Output to:  %OUT%",
  "echo.",
  "echo Large projects can take a while - the CLI loads the whole",
  "echo database before exporting. Leave this window open.",
  "echo.",
  "",
  "\"%SF%\\ScreamingFrogSEOSpiderCli.exe\" --headless --load-crawl \"%~1\" --export-tabs \"Internal:All\" --bulk-export \"All Inlinks\" --export-format csv --output-folder \"%OUT%\" --overwrite",
  "",
  "echo.",
  "if exist \"%OUT%\\internal_all.csv\" (",
  "  echo SUCCESS. In AuditForge:",
  "  echo   1. Drop internal_all.csv on the main upload zone",
  "  echo   2. Add all_inlinks.csv in the \"All Inlinks\" slot",
  ") else (",
  "  echo Export finished but internal_all.csv was not found.",
  "  echo Common causes:",
  "  echo   - Screaming Frog app was still open [close it and re-run]",
  "  echo   - CLI features require a paid licence",
  "  echo   - Export names differ on your version - check with:",
  "  echo     \"%SF%\\ScreamingFrogSEOSpiderCli.exe\" --help bulk-export",
  ")",
  "echo.",
  "pause",
];

export const CONVERTER_BAT = BAT_LINES.join("\r\n") + "\r\n";

export function downloadConverterBat(): void {
  downloadText("convert-for-auditforge.bat", CONVERTER_BAT, "application/octet-stream");
}
