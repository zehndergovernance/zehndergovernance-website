import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { generatePDFHtml } from "../lib/generatePDFHtml";

const SECRET = process.env.PDF_RENDER_SECRET || "";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { submission_id, secret, assessment_payload } = req.body || {};
  if (!secret || secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (!submission_id) return res.status(400).json({ error: "Missing submission_id" });
  if (!assessment_payload) return res.status(400).json({ error: "Missing payload" });
  let html: string;
  try { html = generatePDFHtml(assessment_payload); }
  catch(e: any) { return res.status(500).json({ error: "HTML failed", detail: e?.message }); }
  let browser: any = null;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      executablePath,
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" } });
    await browser.close(); browser = null;
    console.log(`[pdf-render] PDF OK | bytes=${pdfBuffer.length}`);
    res.setHeader("Content-Type", "application/pdf");
    return res.status(200).end(pdfBuffer);
  } catch(err: any) {
    if (browser) { try { await browser.close(); } catch {} }
    return res.status(500).json({ error: "Render failed", detail: err?.message?.slice(0,300) });
  }
}
