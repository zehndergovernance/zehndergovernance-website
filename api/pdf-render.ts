// api/pdf-render.ts
// Vercel Serverless — Pages Router API Route (Next.js)
//
// VERSIONSSTRATEGIE:
//   @sparticuz/chromium-min  123.0.1  + puppeteer-core 22.8.2 (Chrome 123, verifiziert kompatibel)
//   chromium-min (~40MB) statt full (~170MB) — Vercel Lambda Limit: 250MB unzipped
//
// VERCEL CONFIG (vercel.json):
//   memory: 3009 MB | maxDuration: 60s | runtime: nodejs
//
// ENV VARS:
//   PDF_RENDER_SECRET — min. 32 Zeichen, identisch in Vercel + Supabase

// ── Pages Router: IncomingMessage/ServerResponse (NextApiRequest/Response) ──
import type { NextApiRequest, NextApiResponse } from "next";
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";
import { generatePDFHtml } from "../../lib/generatePDFHtml";

// Vercel Function Config
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb", // Payload mit HTML kann gross sein
    },
  },
};

const SECRET = process.env.PDF_RENDER_SECRET || "";

// ── VALIDIERUNG ───────────────────────────────────────────────
const ALLOWED_PRIORITIES   = ["KRITISCH","WICHTIG","MODERAT","HINWEIS"];
const ALLOWED_CONFIDENCES  = ["HIGH","MEDIUM","LOW"];
const ALLOWED_AI_CLASSES   = ["VERBOTEN","HOCHRISIKO","BEGRENZT","MINIMAL-RISIKO","KEIN-RISIKO",""];
const ALLOWED_SCORE_RANGE  = (n: number) => n >= 0 && n <= 100;

interface ValResult { valid: boolean; errors: string[] }

function numInRange(v: unknown, min: number, max: number, field: string, errors: string[]) {
  if (typeof v !== "number" || isNaN(v) || v < min || v > max)
    errors.push(`${field}: muss Zahl ${min}–${max} sein (erhalten: ${typeof v} ${v})`);
}
function nonEmptyStr(v: unknown, field: string, errors: string[]) {
  if (!v || typeof v !== "string" || v.trim() === "")
    errors.push(`${field}: muss nicht-leerer String sein`);
}

function validatePayload(p: any): ValResult {
  const errors: string[] = [];

  // Pflichtfelder
  nonEmptyStr(p.company, "company", errors);
  numInRange(p.total_score, 0, 100, "total_score", errors);
  numInRange(p.ds_score, 0, 100, "ds_score", errors);
  numInRange(p.maturity_level, 1, 5, "maturity_level", errors);
  nonEmptyStr(p.risk_level, "risk_level", errors);
  if (typeof p.risk_score !== "number") errors.push("risk_score: muss Zahl sein");

  // Optionale Felder mit Typ-Prüfung
  if (p.legal_score !== undefined && p.legal_score !== null)
    numInRange(p.legal_score, 0, 100, "legal_score", errors);
  if (p.gov_maturity_score !== undefined && p.gov_maturity_score !== null)
    numInRange(p.gov_maturity_score, 0, 100, "gov_maturity_score", errors);
  if (p.ai_score !== null && p.ai_score !== undefined)
    numInRange(p.ai_score, 0, 100, "ai_score", errors);
  if (p.ai_legal_class !== undefined && p.ai_legal_class !== null) {
    if (typeof p.ai_legal_class !== "string")
      errors.push("ai_legal_class: muss String sein");
    else if (p.ai_legal_class && !ALLOWED_AI_CLASSES.includes(p.ai_legal_class))
      errors.push(`ai_legal_class: unbekannter Wert "${p.ai_legal_class}"`);
  }

  // active_countries
  if (p.active_countries !== undefined && p.active_countries !== null) {
    if (!Array.isArray(p.active_countries) && typeof p.active_countries !== "string")
      errors.push("active_countries: muss Array oder String sein");
  }

  // gaps_json: parsebar + Array + Pflichtfelder pro Gap
  if (p.gaps_json) {
    let gaps: any[];
    try {
      gaps = JSON.parse(p.gaps_json);
      if (!Array.isArray(gaps)) {
        errors.push("gaps_json: kein Array nach Parse");
      } else {
        gaps.forEach((g, i) => {
          const pre = `gaps_json[${i}]`;
          if (!g.id)         errors.push(`${pre}.id: fehlt`);
          if (!g.condition)  errors.push(`${pre}.condition: fehlt`);
          // norm kann leer sein — kein harter Fehler
          if (!g.priority)   errors.push(`${pre}.priority: fehlt`);
          if (!g.confidence) errors.push(`${pre}.confidence: fehlt`);
          if (!g.reportText) errors.push(`${pre}.reportText: fehlt`);
          if (g.priority && !ALLOWED_PRIORITIES.includes(g.priority))
            errors.push(`${pre}.priority: ungültiger Wert "${g.priority}" (erlaubt: ${ALLOWED_PRIORITIES.join(",")})`);
          if (g.confidence && !ALLOWED_CONFIDENCES.includes(g.confidence))
            errors.push(`${pre}.confidence: ungültiger Wert "${g.confidence}"`);
          if (g.impact !== undefined && typeof g.impact !== "number")
            errors.push(`${pre}.impact: muss Zahl sein`);
        });
        // Nur erste 5 Gap-Fehler zeigen (nicht überfluten)
      }
    } catch (e: any) {
      errors.push(`gaps_json: nicht parsebar — ${e?.message}`);
    }
  }

  // scores_json parsebar prüfen
  if (p.scores_json) {
    try { JSON.parse(p.scores_json); }
    catch (e: any) { errors.push(`scores_json: nicht parsebar — ${e?.message}`); }
  }

  return { valid: errors.length === 0, errors };
}

// ── HELPER ────────────────────────────────────────────────────
function jsonRes(res: NextApiResponse, body: any, status = 200) {
  res.status(status).json(body);
}

// ── HANDLER ──────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startMs = Date.now();

  if (req.method !== "POST") {
    return jsonRes(res, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405);
  }

  const { submission_id, secret, assessment_payload } = req.body || {};

  // 1. Secret (401)
  if (!SECRET) {
    console.error("[pdf-render] FEHLER: PDF_RENDER_SECRET nicht gesetzt");
    return jsonRes(res, { error: "Server misconfigured", code: "NO_SECRET" }, 500);
  }
  if (!secret || secret !== SECRET) {
    console.warn(`[pdf-render] Ungültiges Secret | submission_id=${submission_id}`);
    return jsonRes(res, { error: "Unauthorized", code: "INVALID_SECRET" }, 401);
  }

  // 2. Basis-Prüfungen (400)
  if (!submission_id || typeof submission_id !== "string") {
    return jsonRes(res, { error: "Missing submission_id", code: "MISSING_FIELD" }, 400);
  }
  if (!assessment_payload || typeof assessment_payload !== "object") {
    return jsonRes(res, { error: "Missing assessment_payload", code: "MISSING_PAYLOAD" }, 400);
  }

  const company   = assessment_payload.company || "–";
  const gapsCount = (() => {
    try { return assessment_payload.gaps_json ? JSON.parse(assessment_payload.gaps_json).length : 0; } catch { return 0; }
  })();
  const ctryCount = Array.isArray(assessment_payload.active_countries)
    ? assessment_payload.active_countries.length : 0;

  console.log(`[pdf-render] START | id=${submission_id} | company="${company}" | gaps=${gapsCount} | ctry=${ctryCount} | payloadKeys=${Object.keys(assessment_payload).length}`);

  // 3. Strikte Payload-Validierung
  const val = validatePayload(assessment_payload);
  if (!val.valid) {
    const errSlice = val.errors.slice(0, 10); // max. 10 Fehler im Response
    console.error(`[pdf-render] VALIDATION FAIL | id=${submission_id} | errors=${val.errors.length} | first: ${errSlice[0]}`);
    return jsonRes(res, {
      error:       "Payload validation failed",
      code:        "INVALID_PAYLOAD",
      fields:      errSlice,
      total_errors: val.errors.length,
      submission_id,
    }, 400);
  }
  console.log(`[pdf-render] VALIDATION OK | id=${submission_id}`);

  // 4. HTML generieren (reine Präsentation)
  let html: string;
  try {
    html = generatePDFHtml(assessment_payload);
    console.log(`[pdf-render] HTML OK | id=${submission_id} | chars=${html.length}`);
  } catch (e: any) {
    console.error(`[pdf-render] HTML FAIL | id=${submission_id} | ${e?.message}`);
    return jsonRes(res, { error: "HTML generation failed", code: "HTML_ERROR", detail: e?.message?.slice(0,200) }, 500);
  }

  // 5. Chromium + Puppeteer
  let browser: any = null;
  try {
    // Browser starten
    const t_browser = Date.now();
    let executablePath: string;
    try {
      executablePath = await chromium.executablePath();
    } catch (e: any) {
      console.error(`[pdf-render] CHROMIUM PATH FAIL | ${e?.message}`);
      return jsonRes(res, { error: "Chromium not found", code: "CHROMIUM_ERROR", detail: e?.message?.slice(0,200) }, 500);
    }

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--font-render-hinting=none",
        "--disable-font-subpixel-positioning",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
      ],
      defaultViewport: { width: 1240, height: 1754 },
      executablePath,
      headless: true,
    });
    console.log(`[pdf-render] BROWSER OK | id=${submission_id} | ms=${Date.now()-t_browser}`);

    // Page und Content
    const page = await browser.newPage();
    const t_content = Date.now();
    try {
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    } catch (e: any) {
      console.error(`[pdf-render] SETCONTENT FAIL | id=${submission_id} | ${e?.message}`);
      throw new Error(`setContent fehlgeschlagen: ${e?.message}`);
    }
    console.log(`[pdf-render] CONTENT OK | id=${submission_id} | ms=${Date.now()-t_content}`);

    // PDF render
    const date     = new Date().toISOString().slice(0,10);
    const filename = `TrustSphere360_${String(assessment_payload.company).replace(/[^a-zA-Z0-9]/g,"_").slice(0,30)}_${date}.pdf`;
    const t_pdf    = Date.now();
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // Header/Footer sind inline in HTML — kein Puppeteer-Template (stabiler)
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      displayHeaderFooter: false,
    });

    await browser.close();
    browser = null;

    const totalMs = Date.now() - startMs;
    console.log(`[pdf-render] PDF OK | id=${submission_id} | bytes=${pdfBuffer.length} | renderMs=${Date.now()-t_pdf} | totalMs=${totalMs} | file=${filename}`);

    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Length",      pdfBuffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Submission-Id",     submission_id);
    res.setHeader("X-Render-Ms",         String(totalMs));
    res.status(200).end(pdfBuffer);

  } catch (err: any) {
    const phase = browser ? "pdf-render" : "browser-launch";
    console.error(`[pdf-render] RENDER ERROR | id=${submission_id} | phase=${phase} | ${err?.message}`);
    if (browser) { try { await browser.close(); } catch {} }
    return jsonRes(res, {
      error:  "PDF rendering failed",
      code:   "RENDER_ERROR",
      phase,
      detail: err?.message?.slice(0,300) || "unknown",
      submission_id,
    }, 500);
  }
}
