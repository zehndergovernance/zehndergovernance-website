// lib/generatePDFHtml.ts
// REINE PRÄSENTATIONSFUNKTION
// Liest Assessment-Payload → escaped → formatiert → rendert HTML
// Keine eigene Bewertungslogik, keine Neuberechnung von Scores oder Prioritäten
// Erlaubt: defensive Darstellungs-Fallbacks für Rendering-Stabilität (fehlende Werte, unbekannte Typen)

// ── HTML ESCAPING (zentrales Sicherheitsnetz) ─────────────────
function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")  // Emojis entfernen
    .replace(/[\u2600-\u26FF]/gu, "")         // Misc Symbole
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Zahlen sicher ausgeben — null/undefined → null (wird als "–" dargestellt)
function num(v: unknown, fallback: number | null = null): number | null {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function numScore(v: unknown): string {
  const n = num(v);
  return n === null ? "n.v." : `${n}/100`;
}



// ── FARBEN (identisch zum Email) ─────────────────────────────
function scoreColor(s: number): string {
  return s >= 75 ? "#2E7D32" : s >= 55 ? "#E65100" : "#C62828";
}
function riskColor(r: string): string {
  const u = (r || "")
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  if (u.includes("SCHWERWIEGEND") || u.includes("KRITISCH")) return "#C62828";
  if (u.includes("ERHOHT") || u.includes("HOCH")) return "#E65100";
  if (u.includes("MODERAT")) return "#F9A825";
  return "#2E7D32";
}
function priColor(p: string): string {
  return p === "KRITISCH" ? "#C62828" : p === "WICHTIG" ? "#E65100" : "#2E7D32";
}
function confColor(c: string): string {
  return c === "HIGH" ? "#2E7D32" : c === "MEDIUM" ? "#E65100" : "#C62828";
}
function confLabel(c: string): string {
  return c === "HIGH" ? "Hoch" : c === "MEDIUM" ? "Mittel" : "Niedrig";
}
function matLabel(m: number): string {
  return (["", "INITIAL","ENTWICKLUNG","ETABLIERT","GEMANAGT","OPTIMIERT"])[m] || "INITIAL";
}
function scoreLabel(s: number): string {
  return s >= 75 ? "GUT" : s >= 55 ? "MITTEL" : "KRITISCH";
}

// ── SEITEN-TRENNER ───────────────────────────────────────────
function pb(): string {
  return `<div style="page-break-before:always;height:1px;"></div>`;
}

// ── CSS ──────────────────────────────────────────────────────
const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 10px;
  color: #222;
  background: #fff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* PAGE HEADER */
/* HEADER/FOOTER — inline in HTML-Body pro Seite (robust, kein Puppeteer-Template) */
.ph {
  background: #1B3A1B; color: #fff;
  padding: 7px 20px;
  display: flex; justify-content: space-between; align-items: center;
  width: 100%;
}
.ph-brand  { font-size: 8px; font-weight: bold; letter-spacing: 1px; color: #66BB6A; }
.ph-company{ font-size: 7.5px; color: #a5d6a7; }
.ph-ver    { font-size: 7px; color: #66BB6A; }
.pf {
  background: #1B3A1B; color: #a5d6a7;
  padding: 5px 20px;
  font-size: 7px;
  display: flex; justify-content: space-between; align-items: center;
  width: 100%; margin-top: auto;
}

/* CONTENT AREA */
.pg { padding: 14px 20px 18px 20px; }

/* SECTION TITLE BAR */
.st {
  background: #1B3A1B;
  color: #fff;
  padding: 5px 10px;
  font-size: 9.5px;
  font-weight: bold;
  letter-spacing: 0.3px;
  margin: 12px 0 7px 0;
}

/* HINT BOX (grün) */
.hint {
  background: #E8F5E9;
  border-left: 4px solid #2E7D32;
  padding: 9px 12px;
  margin-bottom: 10px;
  border-radius: 0 3px 3px 0;
}
.hint-title { font-size: 9px; font-weight: bold; color: #1B3A1B; margin-bottom: 3px; }

/* WARN BOX (orange) */
.warn {
  background: #FFF8E1;
  border-left: 4px solid #F9A825;
  padding: 9px 12px;
  margin-bottom: 10px;
  border-radius: 0 3px 3px 0;
}

/* SCORE CIRCLE */
.score-outer {
  width: 110px; height: 110px; border-radius: 50%;
  background: #E8F5E9;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.score-mid {
  width: 92px; height: 92px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
}
.score-inner {
  width: 72px; height: 72px; border-radius: 50%;
  background: #fff;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.score-num { font-size: 26px; font-weight: bold; line-height: 1; }
.score-denom { font-size: 9px; color: #888; }
.score-label { font-size: 8px; font-weight: bold; margin-top: 3px; }

/* SUBSCORE BAR */
.ssrow {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
}
.sslabel { font-size: 7.5px; color: #666; width: 108px; flex-shrink: 0; font-weight: bold; }
.ssbg { flex: 1; height: 9px; background: #E8F5E9; border-radius: 4px; overflow: hidden; }
.ssbar { height: 9px; border-radius: 4px; }
.ssval { font-size: 8.5px; font-weight: bold; width: 40px; text-align: right; flex-shrink: 0; }

/* KPI BOXES */
.kpirow { display: flex; gap: 7px; margin-bottom: 10px; }
.kpi {
  flex: 1; background: #F7F9F7; border-radius: 3px; padding: 8px 8px 7px 8px;
}
.kpi-label { font-size: 6.5px; color: #888; letter-spacing: 0.4px; margin-bottom: 3px; }
.kpi-val { font-size: 17px; font-weight: bold; line-height: 1; margin-bottom: 2px; }
.kpi-sub { font-size: 7.5px; color: #666; }

/* GAP DIST BAR */
.gdlabel { font-size: 7.5px; color: #888; font-weight: bold; margin-bottom: 3px; }
.gdbar { display: flex; height: 18px; border-radius: 2px; overflow: hidden; margin-bottom: 10px; }
.gdseg { display: flex; align-items: center; padding: 0 5px; font-size: 7.5px; font-weight: bold; color: #fff; white-space: nowrap; }

/* REIFESTUFE */
.reiferow { display: flex; gap: 2px; margin: 5px 0 8px 0; }
.reifestep {
  flex: 1; height: 24px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; border-radius: 2px;
}
.reife-n { font-size: 9px; font-weight: bold; }
.reife-l { font-size: 5.5px; }

/* COUNTRY BADGES */
.cbadges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.cbadge {
  padding: 3px 8px; border-radius: 3px; font-size: 7.5px; font-weight: bold;
  background: #E8F5E9; color: #1B3A1B; border: 1px solid #A5D6A7;
}

/* TOP RISKS */
.trisk {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  background: #FFF5F5; border-left: 4px solid #C62828; margin-bottom: 4px;
  border-radius: 0 3px 3px 0;
}
.trisk-text { font-size: 8.5px; font-weight: bold; color: #333; flex: 1; }
.trisk-norm { font-size: 7px; color: #2E7D32; white-space: nowrap; }

/* GAP CARD */
.gcard {
  border-left: 5px solid #ccc;
  border-radius: 0 3px 3px 0;
  margin-bottom: 11px;
  overflow: hidden;
  page-break-inside: avoid;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
.gchead {
  padding: 6px 10px; display: flex; align-items: center; gap: 8px;
}
.gcpri { font-size: 8px; font-weight: bold; color: #fff; }
.gcid { font-size: 7px; color: rgba(255,255,255,0.75); flex: 1; }
.gcconf {
  padding: 2px 7px; border-radius: 10px;
  font-size: 6.5px; font-weight: bold; color: #fff;
}
.gcbody { padding: 7px 10px; background: #fff; }
.gctitle { font-size: 9.5px; font-weight: bold; color: #1B3A1B; margin-bottom: 6px; line-height: 1.4; }
.gcfields { border-top: 1px solid #eee; padding-top: 5px; }
.gcf { display: flex; gap: 6px; margin-bottom: 3px; font-size: 8px; line-height: 1.4; }
.gcfl { font-weight: bold; flex-shrink: 0; width: 125px; }
.gcfv { color: #444; flex: 1; }
.gcfoot {
  border-top: 1px solid #eee; margin-top: 5px; padding-top: 3px;
  font-size: 7px; color: #888; display: flex; gap: 12px;
}

/* MASSNAHMEN TABLE */
.mthead { padding: 7px 10px; font-size: 9px; font-weight: bold; color: #fff; margin-top: 8px; border-radius: 2px 2px 0 0; }
.mtitem { display: flex; gap: 8px; padding: 5px 10px; border-bottom: 1px solid #f0f0f0; page-break-inside: avoid; }
.mtitem:nth-child(even) { background: #FAFAFA; }
.mtdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; }
.mtcond { font-size: 8.5px; font-weight: bold; color: #333; flex: 1; }
.mtnorm { font-size: 7px; color: #2E7D32; width: 100px; flex-shrink: 0; text-align: right; }
.mtrep { font-size: 7.5px; color: #555; }

/* COUNTRY BLOCK */
.cblock { border: 1px solid #e0e0e0; border-radius: 3px; margin-bottom: 9px; overflow: hidden; page-break-inside: avoid; }
.chead { padding: 7px 10px; display: flex; gap: 10px; align-items: center; }
.cname { font-size: 10px; font-weight: bold; }
.claw { font-size: 8px; opacity: 0.85; flex: 1; }
.crow { display: flex; gap: 8px; padding: 3px 10px; font-size: 8px; line-height: 1.4; }
.crowl { font-weight: bold; width: 80px; flex-shrink: 0; }
.crowv { color: #444; flex: 1; }

/* SERVICES */
.scard {
  display: flex; margin-bottom: 9px; border-radius: 3px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.1); page-break-inside: avoid;
}
.snum {
  width: 40px; display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: bold; color: #fff; flex-shrink: 0;
}
.sbody { flex: 1; padding: 9px 11px; background: #fff; }
.sname { font-size: 10.5px; font-weight: bold; color: #1B3A1B; }
.sprice { font-size: 10.5px; font-weight: bold; float: right; margin-top: -13px; }
.sdesc { font-size: 8px; color: #555; margin-top: 4px; line-height: 1.5; }
.surl { font-size: 7.5px; color: #2E7D32; margin-top: 3px; }
.sbadge {
  display: inline-block; background: #C62828; color: #fff;
  font-size: 6.5px; font-weight: bold; padding: 1px 6px; border-radius: 10px; margin-bottom: 2px;
}

/* DISCLAIMER */
.disc {
  background: #F5F5F5; border-left: 4px solid #888;
  padding: 9px 11px; border-radius: 0 3px 3px 0; margin-top: 12px;
}
.disc-title { font-size: 9px; font-weight: bold; color: #444; margin-bottom: 4px; }

/* TABLES */
table { width: 100%; border-collapse: collapse; font-size: 8px; margin-bottom: 10px; }
th { background: #1B3A1B; color: #fff; padding: 5px 7px; text-align: left; font-size: 8px; }
td { padding: 4px 7px; border-bottom: 1px solid #eee; vertical-align: top; }
tr:nth-child(even) td { background: #F7F9F7; }
tr.total td { background: #E8F5E9; font-weight: bold; }

/* MASSNAHMENPLAN TABLE */
.mptable th { background: #1B3A1B; }
.mptable td { font-size: 7.5px; }

@page { margin: 0; } /* Puppeteer: margins via padding/layout */
`;

// ── HEADER / FOOTER ──────────────────────────────────────────
function header(rawCompany: string, section: string): string {
  return `<div class="ph">
    <div class="ph-brand">TRUSTSPHERE 360</div>
    <div class="ph-company">${esc(rawCompany)} — VERTRAULICH &nbsp;·&nbsp; ${esc(section)}</div>
    <div class="ph-ver">v8.0</div>
  </div>`;
}
function footer(date: string): string {
  return `<div class="pf">
    <span>Zehnder Governance &nbsp;·&nbsp; Alex Zehnder, lic.iur., LL.M., CIPP/E &nbsp;·&nbsp; zehndergovernance.com</span>
    <span>${esc(date)}</span>
  </div>`;
}

// ── HAUPT-EXPORT ─────────────────────────────────────────────
// Globales Country-Alias-Mapping
const COUNTRY_ALIASES: Record<string,string> = {
  ch:"schweiz", schweiz:"schweiz", eu:"eu",
  de:"deutschland", deutschland:"deutschland",
  at:"oesterreich", oesterreich:"oesterreich", "österreich":"oesterreich",
  uk:"uk", gb:"uk", us:"usa", usa:"usa",
  cn:"china", china:"china",
  br:"brasilien", brasilien:"brasilien",
  sg:"singapur", singapur:"singapur",
  "in":"indien", indien:"indien",
  au:"australien", australien:"australien",
  jp:"japan", japan:"japan",
  kr:"suedkorea", suedkorea:"suedkorea", "südkorea":"suedkorea",
  vn:"vietnam", vietnam:"vietnam",
  hk:"hongkong", hongkong:"hongkong",
};

export function generatePDFHtml(p: any): string {
  // Payload aus Assessment — NUR lesen, NICHT neu berechnen
  // Fix: Rohdaten roh halten, esc() erst beim Rendern anwenden (verhindert double-escape)
  const companyRaw   = String(p.company || "");
  const company = esc(companyRaw);  // für ${company} im HTML-Body
  const today        = new Date().toLocaleDateString("de-CH", {day:"2-digit",month:"2-digit",year:"numeric"});

  // Fix: Alle Scores zuerst — dann erst Farb-Ableitungen (verhindert TDZ-Error)
  const totalScore   = num(p.total_score);
  const dsScore      = num(p.ds_score);
  const legalScore   = num(p.legal_score);
  const govMatScore  = num(p.gov_maturity_score);
  const aiScore      = (p.ai_score !== null && p.ai_score !== undefined) ? num(p.ai_score) : null;
  const riskLevel    = String(p.risk_level || "");
  const riskScore    = num(p.risk_score);
  const matLevel     = num(p.maturity_level, 1) ?? 1;
  const gapsCount    = num(p.gaps_count) ?? 0;
  const complCount   = num(p.compliant_count) ?? 0;
  const aiLegalClass = String(p.ai_legal_class || "");
  const hasAI        = aiScore !== null;

  // Null-sichere Farbvariablen — NACH allen Score-Definitionen
  // Fehlende Scores werden grau (#888), nie rot/kritisch
  const scCol   = totalScore  === null ? "#888" : scoreColor(totalScore);
  const scLabel = totalScore  === null ? "n.v." : scoreLabel(totalScore);
  const dsCol   = dsScore     === null ? "#888" : scoreColor(dsScore);
  const lsCol   = legalScore  === null ? "#888" : scoreColor(legalScore);
  const gmCol   = govMatScore === null ? "#888" : scoreColor(govMatScore);
  const aiCol   = aiScore     === null ? "#888" : scoreColor(aiScore);

  // Active countries — aus Payload lesen
  let activeCtry: string[] = [];
  const rawCtry = p.active_countries;
  if (Array.isArray(rawCtry)) activeCtry = rawCtry.map(String);
  else if (typeof rawCtry === "string" && rawCtry.length > 0) {
    const cleaned = rawCtry.replace(/^\[|\]$|^\{|\}$/g, "").replace(/"/g, "");
    activeCtry = cleaned.split(",").map((s: string) => s.trim()).filter(Boolean);
  }

  // Gaps — aus gaps_json lesen (KEINE Neuberechnung)
  let allGaps: any[] = [];
  try {
    if (p.gaps_json) allGaps = JSON.parse(p.gaps_json);
    else if (Array.isArray(p.gaps)) allGaps = p.gaps;
  } catch { allGaps = []; }

  // Prioritäten normalisieren VOR Filter — Engine kann HOCH/MITTEL liefern
  function normalizePriority(p: unknown): string {
    const s = String(p || "").toUpperCase();
    if (s === "KRITISCH")                   return "KRITISCH";
    if (s === "HOCH" || s === "WICHTIG")    return "WICHTIG";
    if (s === "MITTEL" || s === "MODERAT")  return "MODERAT";
    if (s === "HINWEIS")                    return "HINWEIS";
    return "MODERAT";
  }
  allGaps.forEach((g: any) => { g.priority = normalizePriority(g.priority); });
  const critGaps  = allGaps.filter((g: any) => g.priority === "KRITISCH");
  const wichtGaps = allGaps.filter((g: any) => g.priority === "WICHTIG");
  // MODERAT + HINWEIS bewusst zusammengefasst (keine separate Seite für HINWEIS)
  const modGaps   = allGaps.filter((g: any) => !["KRITISCH","WICHTIG"].includes(g.priority));
  const sofortG   = allGaps.filter((g: any) => (g.impactLabel || "").includes("Sofort"));
  const kurzG     = allGaps.filter((g: any) => (g.impactLabel || "").includes("Kurzfristig"));
  const mittelG   = allGaps.filter((g: any) => !(g.impactLabel||"").includes("Sofort") && !(g.impactLabel||"").includes("Kurzfristig"));

  const gapTotal = critGaps.length + wichtGaps.length + modGaps.length || 1;



  // ── GAP CARD ─────────────────────────────────────────────
  function gapCard(g: any): string {
    const conf = String(g.confidence || "HIGH");  // PFLICHT — sonst ReferenceError
    const col  = priColor(g.priority || "MODERAT");
    const cc   = confColor(conf);
    return `<div class="gcard" style="border-left-color:${col};">
      <div class="gchead" style="background:${col};">
        <span class="gcpri">${esc(g.priority||"MODERAT")}</span>
        <span class="gcid">${esc(g.id||"")}</span>
        <span class="gcconf" style="background:${cc};">${confLabel(conf)}</span>
      </div>
      <div class="gcbody">
        <div class="gctitle">${esc(g.condition||"")}</div>
        <div class="gcfields">
          <div class="gcf">
            <span class="gcfl" style="color:#2E7D32;">${conf==="HIGH"?"Warum anwendbar:":conf==="MEDIUM"?"Hinweis auf potenziellen Handlungsbedarf:":"Vorbehaltlich Klärung:"}</span>
            <span class="gcfv">${esc(g.evidence||"Auf Basis der Angaben besteht potenzieller Handlungsbedarf.")}</span>
          </div>
          <div class="gcf">
            <span class="gcfl" style="color:#2E7D32;">Rechtsgrundlage:</span>
            <span class="gcfv">${esc(g.norm||"–")}</span>
          </div>
          <div class="gcf">
            <span class="gcfl" style="color:#C62828;">${conf==="HIGH"?"Risiko/Sanktion:":conf==="MEDIUM"?"Mögliche Sanktion:":"Sanktionspotenzial (vorbehaltlich):"}</span>
            <span class="gcfv" style="color:#C62828;">${esc(g.sanction||"Regulatorische Massnahmen möglich.")}</span>
          </div>
          <div class="gcf">
            <span class="gcfl" style="color:#2E7D32;">${conf==="HIGH"?"Empfohlene Massnahme:":conf==="MEDIUM"?"Vorläufig empfohlene Massnahme:":"Zu prüfende Massnahme:"}</span>
            <span class="gcfv">${esc(g.reportText||"–")}</span>
          </div>
        </div>
        <div class="gcfoot">
          <span>Frist: <strong>${esc(g.impactLabel||"–")}</strong></span>
          <span>Priorität: <strong style="color:${col}">${esc(g.priority||"")}</strong></span>
          <span>Sicherheit: <strong style="color:${cc}">${confLabel(g.confidence||"HIGH")}</strong></span>
        </div>
      </div>
    </div>`;
  }

  // ── COUNTRY INFO (fest hinterlegt, vorsichtig formuliert) ─
  const CI: Record<string, {law:string, auth:string, fine:string, note:string}> = {
    schweiz:    { law:"nDSG (revidiertes DSG)", auth:"EDOEB, Bern", fine:"CHF 250'000 (Strafrecht)", note:"Potenziell anwendbar bei Datenbearbeitung in der Schweiz oder mit Bezug zur Schweiz — Einzelfallprüfung erforderlich." },
    eu:         { law:"DSGVO (EU) 2016/679", auth:"Jeweilige nationale DPA", fine:"EUR 20 Mio. / 4% Jahresumsatz", note:"Potenziell anwendbar sofern Niederlassung in der EU oder Adressierung von EU-Betroffenen. Sanktionsrahmen stark einzelfallabhängig — indikative Referenz. Einzelfallprüfung erforderlich." },
    deutschland:{ law:"DSGVO / BDSG", auth:"Landesdatenschutzbehörde", fine:"EUR 20 Mio. / 4% Jahresumsatz", note:"Potenziell anwendbar sofern Niederlassung oder Marktaktivität in Deutschland. Sanktionsrahmen stark einzelfallabhängig — indikative Referenz. Einzelfallprüfung erforderlich." },
    oesterreich:{ law:"DSGVO / DSG", auth:"Datenschutzbehörde Wien", fine:"EUR 20 Mio. / 4% Jahresumsatz", note:"Potenziell anwendbar sofern Niederlassung oder Marktaktivität in Österreich. Sanktionsrahmen stark einzelfallabhängig — indikative Referenz. Einzelfallprüfung erforderlich." },
    uk:         { law:"UK GDPR / Data Protection Act 2018", auth:"ICO, London", fine:"GBP 17.5 Mio. / 4% Jahresumsatz", note:"Potenziell anwendbar sofern Marktaktivität im UK oder Niederlassung. Sanktionsrahmen stark einzelfallabhängig — indikative Referenz. Einzelfallprüfung erforderlich." },
    usa:        { law:"CCPA/CPRA (CA) u.a.", auth:"California AG / FTC", fine:"USD 2'500–7'500 pro Verletzung", note:"Potenziell anwendbar sofern Schwellenwerte (Umsatz, Nutzerzahlen) erfüllt. Ob und welches US-Gesetz gilt, haengt von Bundesstaat, Branche und konkreten Aktivitaeten ab — Einzelfallpruefung durch US-Fachperson erforderlich." },
    china:      { law:"PIPL (Personal Information Protection Law)", auth:"CAC (Cyberspace Administration)", fine:"CNY 50 Mio. / 5% Jahresumsatz", note:"Potenziell anwendbar sofern Verarbeitung von Daten chinesischer Staatsangehöriger. Hochkomplexes Rechtsumfeld — Einzelfallprüfung durch lokale Fachperson dringend empfohlen." },
    brasilien:  { law:"LGPD", auth:"ANPD", fine:"BRL 50 Mio. / 2% Umsatz in Brasilien", note:"Potenziell anwendbar sofern Datenverarbeitung mit Brasilien-Bezug. Finale Beurteilung erfordert Einzelfallprüfung unter Berücksichtigung lokaler Ausführungsbestimmungen." },
    singapur:   { law:"PDPA", auth:"PDPC", fine:"SGD 1 Mio.", note:"Potenziell anwendbar sofern Marktaktivität oder Datenverarbeitung mit Singapur-Bezug. Einzelfallprüfung erforderlich." },
    indien:     { law:"DPDPA 2023", auth:"Data Protection Board", fine:"INR 250 Crore (~EUR 28 Mio.)", note:"Potenziell anwendbar sofern Verarbeitung von Daten indischer Staatsangehöriger. DPDPA 2023 in Implementierungsphase — laufende Rechtsentwicklung beachten, Einzelfallprüfung erforderlich." },
    australien: { law:"Privacy Act 1988 / APPs", auth:"OAIC", fine:"AUD 50 Mio.", note:"Potenziell anwendbar sofern Jahresumsatz > AUD 3 Mio. oder besondere Datenkategorien. Schwellenwerte und Ausnahmen erfordern Einzelfallprüfung." },
    japan:      { law:"APPI", auth:"PPC", fine:"JPY 100 Mio.", note:"Potenziell anwendbar sofern Verarbeitung von Daten japanischer Staatsangehöriger. Einzelfallprüfung erforderlich." },
    suedkorea:  { law:"PIPA", auth:"PIPC", fine:"KRW 3 Mrd. / 3% Umsatz", note:"Potenziell anwendbar sofern Marktaktivität in Südkorea. Strenge Anforderungen — Einzelfallprüfung erforderlich." },
    vietnam:    { law:"PDPD (Decree 13/2023)", auth:"Ministerium für Öffentliche Sicherheit", fine:"VND 100 Mio.", note:"Potenziell anwendbar sofern Verarbeitung von Daten mit Vietnam-Bezug. Junge Regulierung — Rechtsentwicklung beachten, Einzelfallprüfung erforderlich." },
    hongkong:   { law:"PDPO", auth:"PCPD", fine:"HKD 1 Mio. + Strafrecht", note:"Potenziell anwendbar sofern Marktaktivität in Hongkong SAR. Eigenständiges Rechtsgebiet — Einzelfallprüfung empfohlen." },
  };

  // ── SEITE 1: EXECUTIVE SUMMARY ───────────────────────────
  const p1 = `
  ${header(companyRaw, "EXECUTIVE SUMMARY")}
  <div class="pg">
    <div style="font-size:22px;font-weight:bold;color:#1B3A1B;margin-bottom:3px;">${company}</div>
    <div style="font-size:8.5px;color:#888;border-bottom:2px solid #2E7D32;padding-bottom:5px;margin-bottom:13px;">
      TrustSphere 360 Compliance-Analyse &nbsp;·&nbsp; ${today} &nbsp;·&nbsp; Engine v8.0
    </div>

    <div style="display:flex;gap:18px;align-items:flex-start;margin-bottom:13px;">
      <div>
        <div class="score-outer">
          <div class="score-mid" style="background:${scCol};">
            <div class="score-inner">
              <div class="score-num" style="color:${scCol};">${totalScore === null ? "n.v." : totalScore}</div>
              <div class="score-denom">/100</div>
            </div>
          </div>
        </div>
        <div style="text-align:center;font-size:8.5px;font-weight:bold;color:${scCol};margin-top:3px;">${scLabel}</div>
      </div>
      <div style="flex:1;">
        <div class="ssrow">
          <div class="sslabel">DATENSCHUTZ</div>
          <div class="ssbg">${dsScore!==null?`<div class="ssbar" style="width:${dsScore}%;background:${dsCol};"></div>`:""}</div>
          <div class="ssval" style="color:${dsCol};">${numScore(dsScore)}</div>
        </div>
        ${legalScore!==null?`<div class="ssrow">
          <div class="sslabel">LEGAL COMPLIANCE</div>
          <div class="ssbg"><div class="ssbar" style="width:${legalScore}%;background:${lsCol};"></div></div>
          <div class="ssval" style="color:${lsCol};">${legalScore === null ? "n.v." : `${legalScore}/100`}</div>
        </div>`:""}
        ${govMatScore!==null?`<div class="ssrow">
          <div class="sslabel">GOVERNANCE-REIFE</div>
          <div class="ssbg"><div class="ssbar" style="width:${govMatScore}%;background:${gmCol};"></div></div>
          <div class="ssval" style="color:${gmCol};">${govMatScore === null ? "n.v." : `${govMatScore}/100`}</div>
        </div>`:""}
        ${hasAI ? `<div class="ssrow">
          <div class="sslabel">KI-GOVERNANCE</div>
          <div class="ssbg"><div class="ssbar" style="width:${aiScore}%;background:${aiCol};"></div></div>
          <div class="ssval" style="color:${aiCol};">${aiScore === null ? "n.v." : `${aiScore}/100`}</div>
        </div>` : ""}
      </div>
    </div>

    <div class="kpirow">
      <div class="kpi" style="border-top:3px solid ${riskColor(riskLevel)};">
        <div class="kpi-label">GOVERNANCE-RISIKO</div>
        <div class="kpi-val" style="color:${riskColor(riskLevel)};">${esc(riskLevel)}</div>
        <div class="kpi-sub">Risikoscore: ${riskScore === null ? "n.v." : `${riskScore}/10`}</div>
      </div>
      <div class="kpi" style="border-top:3px solid ${scCol};">
        <div class="kpi-label">GESAMT-SCORE</div>
        <div class="kpi-val" style="color:${scCol};">${totalScore === null ? "n.v." : `${totalScore}/100`}</div>
        <div class="kpi-sub">${scLabel}</div>
      </div>
      <div class="kpi" style="border-top:3px solid ${gapsCount>10?"#C62828":gapsCount>5?"#E65100":"#2E7D32"};">
        <div class="kpi-label">COMPLIANCE-LÜCKEN</div>
        <div class="kpi-val" style="color:${gapsCount>10?"#C62828":gapsCount>5?"#E65100":"#2E7D32"};">${gapsCount}</div>
        <div class="kpi-sub">${complCount} Kriterien erfüllt</div>
      </div>
      ${hasAI ? `<div class="kpi" style="border-top:3px solid #1B3A1B;">
        <div class="kpi-label">KI-RECHTSKLASSE</div>
        <div class="kpi-val" style="color:#1B3A1B;font-size:11px;">${esc(aiLegalClass)||"–"}</div>
        <div class="kpi-sub">EU AI Act</div>
      </div>` : ""}
    </div>

    ${gapsCount > 0 ? `
    <div class="gdlabel">LÜCKEN NACH PRIORITÄT</div>
    <div class="gdbar">
      ${critGaps.length > 0 ? `<div class="gdseg" style="width:${Math.round(critGaps.length/gapTotal*100)}%;background:#C62828;">${critGaps.length} Kritisch</div>` : ""}
      ${wichtGaps.length > 0 ? `<div class="gdseg" style="width:${Math.round(wichtGaps.length/gapTotal*100)}%;background:#E65100;">${wichtGaps.length} Wichtig</div>` : ""}
      ${modGaps.length > 0 ? `<div class="gdseg" style="width:${Math.round(modGaps.length/gapTotal*100)}%;background:#2E7D32;">${modGaps.length} Moderat</div>` : ""}
    </div>` : ""}

    <div class="st">REIFESTUFE</div>
    <div class="reiferow">
      ${["INITIAL","ENTWICKLUNG","ETABLIERT","GEMANAGT","OPTIMIERT"].map((s,i) => {
        const act = i+1===matLevel; const past = i+1<matLevel;
        const bg  = act?"#2E7D32":past?"#A5D6A7":"#E8F0E8";
        const tc  = act||past?"#fff":"#888";
        return `<div class="reifestep" style="background:${bg};">
          <div class="reife-n" style="color:${tc};">${i+1}</div>
          <div class="reife-l" style="color:${tc};">${s}</div>
        </div>`;
      }).join("")}
    </div>
    <div style="font-size:7.5px;color:#666;margin-bottom:10px;">
      Stufe ${matLevel}/5 — ${matLabel(matLevel)}.
      ${critGaps.length+wichtGaps.length > 0
        ? `${critGaps.length} kritische + ${wichtGaps.length} wichtige Lücken bis Stufe ${Math.min(matLevel+1,5)}.`
        : "Kontinuierliche Optimierung empfohlen."}
    </div>

    ${critGaps.length > 0 ? `
    <div class="st">TOP KRITISCHE RISIKEN</div>
    ${critGaps.slice(0,3).map(g => `<div class="trisk">
      <div class="trisk-text">${esc((g.condition||"").substring(0,80))}</div>
      <div class="trisk-norm">${esc((g.norm||"").substring(0,45))}</div>
    </div>`).join("")}` : ""}

    <div class="st">ANWENDBARE RECHTSSYSTEME</div>
    ${activeCtry.length === 0
      ? `<div style="color:#888;font-size:8px;padding:4px 0;">Keine Rechtssysteme angegeben — bitte Angaben vervollständigen.</div>`
      : `<div class="cbadges">${activeCtry.map(c => `<span class="cbadge">${esc(c.toUpperCase())}</span>`).join("")}</div>`}

    <div class="st">EXECUTIVE FAZIT</div>
    <p style="font-size:9px;line-height:1.6;color:#333;">
      ${gapsCount===0
        ? `Die Analyse zeigt ein weitgehend konformes Datenschutzprofil für <strong>${company}</strong>.`
        : `Die Analyse identifiziert Risikopotenzial in <strong>${gapsCount} Bereichen</strong> für <strong>${company}</strong>.`}
      Gesamt-Score: <strong style="color:${scCol}">${totalScore === null ? "n.v." : `${totalScore}/100`}</strong> &nbsp;·&nbsp;
      Governance-Risiko: <strong style="color:${riskColor(riskLevel)}">${esc(riskLevel)}</strong> (${riskScore === null ? "n.v." : riskScore + "/10"}) &nbsp;·&nbsp;
      Reifestufe: <strong>${matLabel(matLevel)}</strong> (${matLevel}/5).
      ${critGaps.length > 0 ? `<strong style="color:#C62828">${critGaps.length} Bereiche erfordern sofortigen Handlungsbedarf.</strong>` : ""}
      Diese indikative Ersteinschätzung basiert auf den gemachten Angaben und ersetzt keine Einzelfallprüfung.
    </p>
  ${footer(today)}
  </div>`;

  // ── SEITE 2: METHODIK ─────────────────────────────────────
  const p2 = `${pb()}
  ${header(companyRaw, "METHODIK & LESELOGIK")}
  <div class="pg">
    <div class="hint">
      <div class="hint-title">WICHTIGER RECHTLICHER HINWEIS</div>
      Dieser Report wurde automatisiert auf Basis Ihrer strukturierten Antworten erstellt.
      Er stellt eine indikative Ersteinschätzung dar und begründet keine Rechtsberatung im Sinne des Anwaltsgesetzes.
      Für verbindliche Beurteilungen ist eine Einzelfallprüfung durch eine qualifizierte Fachperson erforderlich.
    </div>

    <div class="st">SCORING-MODELL</div>
    <table>
      <tr><th>Kategorie</th><th>Gewichtung</th><th>Ihr Wert</th><th>Schwellenwert</th><th>Einschätzung</th></tr>
      <tr><td>Datenschutz (nDSG/DSGVO)</td><td>${hasAI?"70%":"100%"}</td>
          <td style="font-weight:bold;color:${dsCol}">${dsScore === null ? "n.v." : `${dsScore}/100`}</td>
          <td>≥ 75</td><td style="color:${dsCol};font-weight:bold;">${dsScore === null ? "n.v." : scoreLabel(dsScore)}</td></tr>
      <tr><td>KI-Governance (EU AI Act)</td><td>${hasAI?"30%":"–"}</td>
          <td>${hasAI?`<span style="font-weight:bold;color:${aiCol}">${aiScore === null ? "n.v." : `${aiScore}/100`}</span>`:"Nicht anwendbar"}</td>
          <td>≥ 70</td><td>${hasAI?`<span style="color:${aiCol};font-weight:bold;">${aiScore === null ? "n.v." : scoreLabel(aiScore)}</span>`:"–"}</td></tr>
      <tr><td>Legal Compliance</td><td>Indikator</td>
          <td style="font-weight:bold;color:${lsCol}">${legalScore === null ? "n.v." : `${legalScore}/100`}</td>
          <td>≥ 75</td><td style="color:${lsCol};font-weight:bold;">${legalScore === null ? "n.v." : scoreLabel(legalScore)}</td></tr>
      <tr><td>Governance-Reife</td><td>Indikator</td>
          <td style="font-weight:bold;color:${gmCol}">${govMatScore === null ? "n.v." : `${govMatScore}/100`}</td>
          <td>≥ 70</td><td style="color:${gmCol};font-weight:bold;">${govMatScore === null ? "n.v." : scoreLabel(govMatScore)}</td></tr>
      <tr class="total"><td>GESAMT-SCORE</td><td>–</td>
          <td style="color:${scCol};font-size:12px;">${totalScore === null ? "n.v." : `${totalScore}/100`}</td>
          <td>≥ 75</td><td style="color:${scCol};">${scLabel}</td></tr>
    </table>

    <div class="st">BEWERTUNGSSICHERHEIT (CONFIDENCE)</div>
    <p style="font-size:8px;color:#555;margin-bottom:7px;">
      Jede Einzelbewertung wird mit einem Confidence-Level ausgewiesen, das anzeigt, wie sicher die Aussage
      auf Basis der gemachten Angaben ist:
    </p>
    <table>
      <tr><th>Level</th><th>Bedeutung</th><th>Konsequenz</th></tr>
      <tr><td><strong style="color:#2E7D32;">HOCH</strong></td>
          <td>Angaben eindeutig und vollständig</td>
          <td>Bewertung direkt verwertbar</td></tr>
      <tr><td><strong style="color:#E65100;">MITTEL</strong></td>
          <td>Angaben teilweise unklar oder unvollständig</td>
          <td>Konservative Einschätzung — Verifizierung empfohlen</td></tr>
      <tr><td><strong style="color:#C62828;">NIEDRIG</strong></td>
          <td>Angaben fehlen oder widersprüchlich</td>
          <td>Worst-Case-Annahme — dringende Klärung erforderlich</td></tr>
    </table>

    <div class="st">PRIORITÄTS- UND IMPACT-MATRIX</div>
    <table>
      <tr><th>Impact-Score</th><th>Priorität</th><th>Handlungsfrist</th><th>Potenzielle Rechtsfolge</th></tr>
      <tr><td>9–10</td><td style="color:#C62828;font-weight:bold;">KRITISCH</td><td>0–4 Wochen</td><td>Bussen bis EUR 20 Mio. / 4% Jahresumsatz möglich</td></tr>
      <tr><td>7–8</td><td style="color:#E65100;font-weight:bold;">WICHTIG</td><td>1–3 Monate</td><td>Aufsichtsmassnahmen, formelle Abmahnungen möglich</td></tr>
      <tr><td>4–6</td><td style="color:#2E7D32;font-weight:bold;">MODERAT</td><td>3–12 Monate</td><td>Reputationsrisiko, zivilrechtliche Ansprüche möglich</td></tr>
      <tr><td>1–3</td><td style="color:#666;font-weight:bold;">HINWEIS</td><td>&gt;12 Monate</td><td>Best Practice / präventive Massnahme empfohlen</td></tr>
    </table>

    <div style="font-size:7.5px;color:#888;margin-bottom:8px;border-top:1px solid #eee;padding-top:6px;">Dieser Report umfasst typischerweise 8–15 Seiten, abhängig von Anzahl Compliance-Lücken und aktiven Rechtssystemen.</div>
    <div class="hint" style="margin-top:6px;">
      <div class="hint-title">WICHTIG: GRUNDLAGE DIESES REPORTS</div>
      Alle Bewertungen basieren ausschliesslich auf Ihren Antworten im TrustSphere 360 Compliance Navigator.
      Fehlende oder unklare Angaben führen zu konservativen Einschätzungen (Worst-Case).
      Der Report rechnet keine Scores neu — er zeigt exakt das Ergebnis der initialen Analyse.
    </div>
  ${footer(today)}
  </div>`;

  // ── SEITEN 3–5: GAPS ─────────────────────────────────────
  const gapSecs = [
    { title:"KRITISCHE COMPLIANCE-LÜCKEN — SOFORTIGER HANDLUNGSBEDARF", gaps:critGaps, col:"#C62828",
      intro:`${critGaps.length} Bereiche mit erheblichem Risiko einer Nicht-Konformität. Unverzügliche Massnahmen erforderlich.` },
    { title:"WICHTIGE COMPLIANCE-LÜCKEN — KURZFRISTIGER HANDLUNGSBEDARF", gaps:wichtGaps, col:"#E65100",
      intro:`${wichtGaps.length} Bereiche mit Risikopotenzial. Adressierung innerhalb 1–3 Monate empfohlen.` },
    { title:"MODERATE COMPLIANCE-LÜCKEN — MITTELFRISTIGER HANDLUNGSBEDARF", gaps:modGaps, col:"#2E7D32",
      intro:`${modGaps.length} Optimierungsbereiche. Adressierung innerhalb 3–12 Monate empfohlen.` },
  ];

  const gapPages = gapSecs
    .filter(s => s.gaps.length > 0)
    .map(s => `${pb()}
      ${header(companyRaw, s.title.split("—")[0].trim())}
      <div class="pg">
        <div class="st" style="background:${s.col};">${s.title}</div>
        <p style="font-size:8.5px;color:#666;margin-bottom:9px;">${s.intro}</p>
        ${s.gaps.map(g => gapCard(g)).join("")}
      ${footer(today)}
      </div>`
    ).join("");

  // ── SEITE 6: JURISDIKTIONEN ───────────────────────────────
  const p6 = `${pb()}
  ${header(companyRaw, "RECHTSSYSTEME")}
  <div class="pg">
    <div class="st">ANWENDBARE RECHTSSYSTEME — INDIKATIVE ÜBERSICHT</div>
    <div style="background:#FFF8E1;border-left:3px solid #F9A825;padding:7px 10px;margin-bottom:10px;border-radius:0 3px 3px 0;font-size:8px;color:#555;">
      <strong>Orientierende Übersicht — keine verbindliche Aussage.</strong>
      Die aufgeführten Gesetze, Behörden und Sanktionsrahmen sind Referenzangaben auf Basis öffentlich zugänglicher Quellen
      und dienen der groben Orientierung. Sie stellen keine verbindliche Aussage zur tatsächlichen Anwendbarkeit oder
      Sanktionshöhe im Einzelfall dar. Sanktionsrahmen sind stark einzelfallabhängig.
      Einzelfallprüfung durch eine qualifizierte Fachperson ist stets erforderlich.
    </div>
    ${activeCtry.length === 0
      ? `<div class="warn"><strong>Keine Rechtssysteme identifiziert.</strong><br>
         Bitte vervollständigen Sie Ihre Angaben zu Unternehmensstandorten und Marktaktivitäten.</div>`
      : activeCtry.map(c => {
                    const rawKey = String(c || "").trim().toLowerCase();
          const ctryKey = COUNTRY_ALIASES[rawKey];
          const info = ctryKey ? CI[ctryKey] : undefined;
          if (!info) return `<div class="warn">Keine Detailinformationen für "${esc(c)}" verfügbar.</div>`;
          const isCore = ["schweiz","eu","deutschland","oesterreich","uk"].includes(ctryKey || "");
          return `<div class="cblock">
            <div class="chead" style="background:${isCore?"#1B3A1B":"#F5F5F5"};">
              <div class="cname" style="color:${isCore?"#fff":"#333"};">${esc(c.toUpperCase())}</div>
              <div class="claw" style="color:${isCore?"#a5d6a7":"#666"};">${esc(info.law)}</div>
            </div>
            <div>
              <div class="crow"><div class="crowl">Anwendbarkeit:</div><div class="crowv">${esc(info.note)}</div></div>
              <div class="crow"><div class="crowl" style="color:#2E7D32;">Behörde:</div><div class="crowv">${esc(info.auth)}</div></div>
              <div class="crow"><div class="crowl" style="color:#C62828;">Max. Sanktion:</div><div class="crowv" style="color:#C62828;font-weight:bold;">${esc(info.fine)}</div></div>
            </div>
          </div>`;
        }).join("")}
  ${footer(today)}
  </div>`;

  // ── SEITE 7: MASSNAHMENPLAN ──────────────────────────────
  const mSecs = [
    { title:"SOFORT (0–4 Wochen)",         gaps: sofortG.length ? sofortG : critGaps,  col:"#C62828" },
    { title:"KURZFRISTIG (1–3 Monate)",    gaps: kurzG.length   ? kurzG   : wichtGaps, col:"#E65100" },
    { title:"MITTELFRISTIG (3–12 Monate)", gaps: mittelG.length  ? mittelG : modGaps,  col:"#2E7D32" },
  ];

  const p7 = `${pb()}
  ${header(companyRaw, "MASSNAHMENPLAN")}
  <div class="pg">
    <div class="st">PRIORISIERTER MASSNAHMENPLAN</div>
    <p style="font-size:8.5px;color:#666;margin-bottom:8px;">
      Direkt abgeleitet aus den identifizierten Compliance-Risiken. Priorisierung nach Impact-Score und gesetzlicher Dringlichkeit.
    </p>
    ${allGaps.length === 0
      ? `<div class="hint"><strong style="color:#2E7D32;font-size:12px;">Keine Compliance-Lücken identifiziert.</strong><br>
         Das Unternehmen weist ein gutes Compliance-Profil auf. Kontinuierliche Überprüfung empfohlen.</div>`
      : mSecs.filter(m => m.gaps.length > 0).map(m => `
          <div class="mthead" style="background:${m.col};">${esc(m.title)} — ${m.gaps.length} Massnahmen</div>
          ${m.gaps.map(g => `<div class="mtitem">
            <div class="mtdot" style="background:${m.col};"></div>
            <div style="flex:1;">
              <div style="display:flex;gap:8px;align-items:flex-start;">
                <div class="mtcond" style="flex:1;">${esc((g.condition||"").substring(0,80))}</div>
                <div class="mtnorm">${esc((g.norm||"").substring(0,50))}</div>
              </div>
              <div class="mtrep">${esc((g.reportText||"").substring(0,120))}</div>
            </div>
          </div>`).join("")}
        `).join("")}
  ${footer(today)}
  </div>`;

  // ── SEITE 8: SERVICES + DISCLAIMER ───────────────────────

  const p8 = `${pb()}
  ${header(companyRaw, "NÄCHSTE SCHRITTE")}
  <div class="pg">
    <div class="st">NÄCHSTE SCHRITTE — UMSETZUNGSPLAN</div>

    <!-- Schritt 1: Analyse abgeschlossen -->
    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;padding:10px;background:#E8F5E9;border-radius:3px;">
      <div style="width:28px;height:28px;background:#2E7D32;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:#fff;font-size:14px;font-weight:bold;">✓</span>
      </div>
      <div>
        <div style="font-size:10px;font-weight:bold;color:#1B3A1B;margin-bottom:3px;">Schritt 1: Analyse abgeschlossen</div>
        <div style="font-size:8.5px;color:#333;">Der Compliance Navigator hat ${gapsCount} Compliance-Lücken identifiziert und priorisiert.
        Dieser Report dokumentiert den aktuellen Stand Ihres Datenschutz-Reifegrads.</div>
      </div>
    </div>

    <!-- Schritt 2: Umsetzung via Flatrate (Hauptangebot) -->
    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;padding:10px;background:#fff;border:2px solid #1B3A1B;border-radius:3px;">
      <div style="width:28px;height:28px;background:#1B3A1B;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:#fff;font-size:12px;font-weight:bold;">2</span>
      </div>
      <div style="flex:1;">
        <div style="font-size:10px;font-weight:bold;color:#1B3A1B;margin-bottom:3px;">Schritt 2: Lücken systematisch schliessen</div>
        <div style="font-size:8.5px;color:#333;margin-bottom:8px;">Der Compliance Navigator identifiziert und priorisiert Ihre Lücken. Die Compliance-Flatrate liefert Vorlagen, Schulungsbausteine und Tools, die die strukturierte Schliessung typischer Compliance-Lücken unterstützen. Sie ersetzt keine individuelle Rechtsprüfung bei komplexen Spezialfällen.</div>

        <!-- Flatrate Standard -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 10px;background:#F7F9F7;border-left:3px solid #2E7D32;margin-bottom:6px;">
          <div style="flex:1;">
            <div style="font-size:9.5px;font-weight:bold;color:#1B3A1B;">Compliance-Flatrate Standard</div>
            <div style="font-size:8px;color:#555;margin-top:2px;">Vollständige Massnahmenvorlagen · Schulungsvideos · Update-Newsletter · für alle identifizierten Lücken</div>
          </div>
          <div style="font-size:10px;font-weight:bold;color:#2E7D32;margin-left:12px;white-space:nowrap;">CHF 149/Mt.</div>
        </div>

        <!-- Flatrate Enterprise -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 10px;background:#F7F9F7;border-left:3px solid #1B3A1B;margin-bottom:4px;">
          <div style="flex:1;">
            <div style="font-size:9.5px;font-weight:bold;color:#1B3A1B;">Compliance-Flatrate Enterprise</div>
            <div style="font-size:8px;color:#555;margin-top:2px;">Alle Standard-Inhalte + erweiterte Jurisdiktionen (UK/US/SG/HK) · Jahres-Audit · Priority-Support</div>
          </div>
          <div style="font-size:10px;font-weight:bold;color:#1B3A1B;margin-left:12px;white-space:nowrap;">CHF 299/Mt.</div>
        </div>

        <div style="font-size:7.5px;color:#2E7D32;margin-top:5px;font-style:italic;">→ zehndergovernance.com/flatrate</div>
      </div>
    </div>

    <!-- Schritt 3: Optional -->
    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;padding:10px;background:#F9F9F9;border-radius:3px;border:1px solid #e0e0e0;">
      <div style="width:28px;height:28px;background:#888;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="color:#fff;font-size:12px;font-weight:bold;">3</span>
      </div>
      <div>
        <div style="font-size:9px;font-weight:bold;color:#555;margin-bottom:3px;">Schritt 3: Optional — individuelle Unterstützung</div>
        <div style="font-size:8px;color:#666;">Für Spezialfragen: DPO-as-a-Service (externer Datenschutzbeauftragter auf Abruf) oder
        Einzelberatung mit Alex Zehnder, lic.iur., LL.M., CIPP/E. Diese Leistungen ergänzen die Flatrate
        und sind nicht Voraussetzung für die Umsetzung.</div>
        <div style="font-size:7.5px;color:#888;margin-top:4px;">zehndergovernance.com</div>
      </div>
    </div>

    <div class="disc">
      <div class="disc-title">HAFTUNGSAUSSCHLUSS UND RECHTLICHE HINWEISE</div>
      Dieser Report wurde automatisiert auf Basis der im Compliance Navigator gemachten Angaben erstellt.
      Er stellt eine indikative Ersteinschätzung dar und begründet weder eine Rechtsberatung im Sinne
      des Anwaltsgesetzes noch eine Mandatsbeziehung. Die Ergebnisse basieren auf Selbstauskunft und
      regelbasierter Auswertung — sie ersetzen keine individuelle Einzelfallprüfung durch eine qualifizierte
      Fachperson. Zehnder Governance übernimmt keine Haftung für Entscheidungen auf alleiniger Basis
      dieses Reports. Massgeblich sind die jeweils aktuell gültigen gesetzlichen Bestimmungen.<br><br>
      © 2026 Zehnder Governance &nbsp;·&nbsp; Alex Zehnder, lic.iur., LL.M., CIPP/E, Mediator SDM-FSM
      &nbsp;·&nbsp; zehndergovernance.com
    </div>
  ${footer(today)}
  </div>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>TrustSphere 360 — ${esc(companyRaw)}</title>
  <style>${CSS}</style>
</head>
<body>
  ${p1}${p2}${gapPages}${p6}${p7}${p8}
</body>
</html>`;
}
