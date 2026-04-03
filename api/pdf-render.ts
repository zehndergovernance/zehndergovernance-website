// ============================================================================
// TRUSTSPHERE 360 — ENTERPRISE PDF WORKER v7.0
// © 2026 Zehnder Governance
//
// ENTERPRISE-ARCHITEKTUR:
//  [E2] Atomisches Job-Claiming: locked_at + worker_id verhindert Doppelverarbeitung
//  [E3] Retry mit Backoff: 5min → 30min → 2h → 24h → pdf_failed (max 4 Versuche)
//  [E5] PDF in Supabase Storage (nicht Base64-Attachment)
//  [E6] Signierte Download-URL statt direktem Attachment
//  [E7] Statusmaschine: pdf_pending→pdf_generating→delivery_pending→delivery_sent/failed
//  [E8] Structured Error Logging: pdfError, last_error_at, error_class
//
// AUFRUF:
//   POST /functions/v1/trustsphere-pdf
//   Body (optional): { "submission_id": "uuid" }
//     → Verarbeitet diese spezifische Submission
//   Body leer:
//     → Verarbeitet den ältesten fälligen pdf_pending Job
//
// FÜR CRON (Supabase pg_cron oder externer Scheduler):
//   SELECT net.http_post(url, '{}', headers) FROM cron.job_run_details;
//   → Alle 5 Minuten aufrufen für automatischen Retry
// ============================================================================

import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

const ENGINE_VERSION = "v7.0";

// Retry-Backoff-Strategie: nach N Versuchen wartet man X Minuten
const RETRY_BACKOFF_MINUTES = [5, 30, 120, 1440]; // 5min, 30min, 2h, 24h
const MAX_PDF_ATTEMPTS      = 4;
const MAX_DELIVERY_ATTEMPTS = 3;
const LOCK_TIMEOUT_MINUTES  = 10; // nach 10min gilt ein Lock als verfallen

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" }});
  }

  const workerId = `worker_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
  console.log(`[${workerId}] PDF-Worker gestartet`);

  const supabaseUrl = Deno.env.get("DB_URL")!;
  const serviceKey  = Deno.env.get("DB_SERVICE_KEY")!;
  const brevoKey    = Deno.env.get("BREVO_API_KEY")!;
  const leadTo      = Deno.env.get("LEAD_TO") || "zehndergovernance@gmail.com";
  const storageUrl  = `${supabaseUrl}/storage/v1`;
  const BUCKET      = "trustsphere-reports";

  if (!brevoKey)    return new Response(JSON.stringify({error:"BREVO_API_KEY fehlt",code:"E003"}), {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  if (!serviceKey)  return new Response(JSON.stringify({error:"DB_SERVICE_KEY fehlt",code:"E006"}), {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

  try {
    const body = await req.json().catch(() => ({}));
    const targetId: string|null = body?.submission_id || null;

    // ── [E2] ECHTES ATOMISCHES JOB-CLAIMING via SQL RPC ─────────
    // PostgreSQL FOR UPDATE SKIP LOCKED: lesen + locken in einer einzigen Transaktion
    // Unmöglich dass zwei Worker denselben Job gleichzeitig claimt
    // Entspricht ChatGPT-Empfehlung: "SQL/RPC-Claim-Logik in einem Schritt"

    const now = new Date();
    let submissions: any[];

    if (targetId) {
      // FIX Bug 3: Statusmaschine beim manuellen submission_id-Pfad prüfen
      // Nur erlaubte Übergänge zulassen, nicht blind auf pdf_generating setzen
      const directRes = await fetch(
        `${supabaseUrl}/rest/v1/trustsphere_submissions?id=eq.${targetId}&select=*`,
        { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } }
      );
      if (!directRes.ok) throw new Error(`DB fetch failed: ${directRes.status}`);
      const directData = await directRes.json();

      if (!directData?.length) {
        return new Response(JSON.stringify({ error:"Submission nicht gefunden", submissionId:targetId }), {
          status:404, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
        });
      }

      const existing = directData[0];
      const allowedStates = ["pdf_pending", "pdf_failed", "delivery_pending", "delivery_failed"];
      if (!allowedStates.includes(existing.processing_status)) {
        return new Response(JSON.stringify({
          error:`Unzulässiger Status für manuellen Aufruf: '${existing.processing_status}'. Erlaubt: ${allowedStates.join(", ")}`,
          submissionId:targetId, currentStatus: existing.processing_status
        }), { status:409, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });
      }

      // Korrekten Lock basierend auf Status setzen
      const isDeliveryRetry = existing.processing_status === "delivery_pending" || existing.processing_status === "delivery_failed";
      if (isDeliveryRetry) {
        await patchDBHard(existing.id, {
          processing_status: "delivery_sending",
          delivery_locked_at: now.toISOString(),
          delivery_worker_id: workerId,
          delivery_attempts: (existing.delivery_attempts||0) + 1,
        });
        (globalThis as any).__jobMode = "delivery";
      } else {
        await patchDBHard(existing.id, {
          processing_status: "pdf_generating",
          pdf_locked_at: now.toISOString(),
          pdf_worker_id: workerId,
          pdf_attempts: (existing.pdf_attempts||0) + 1,  // manuelle Aufrufe erhöhen selbst
        });
        (globalThis as any).__jobMode = "pdf";
      }
      submissions = directData;
    } else {
      // FIX Bug 2: zuerst delivery_pending abarbeiten (Priorisierung ausstehender Zustellungen)
      // dann pdf_pending — so bleiben keine Delivery-Retries liegen
      let jobMode: "delivery" | "pdf" = "delivery";

      const deliveryRpc = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_delivery_job`, {
        method:"POST",
        headers:{"Content-Type":"application/json","apikey":serviceKey,"Authorization":`Bearer ${serviceKey}`},
        body: JSON.stringify({ worker_id_in: workerId }),
      });
      if (!deliveryRpc.ok) {
        const errTxt = await deliveryRpc.text();
        console.warn(`[${workerId}] claim_delivery_job warn: ${deliveryRpc.status}: ${errTxt}`);
      }
      const deliveryJobs = deliveryRpc.ok ? await deliveryRpc.json() : [];

      if (deliveryJobs?.length) {
        submissions = deliveryJobs;
        jobMode = "delivery";
        console.log(`[${workerId}] Delivery-Job geclaimt (delivery_pending hat Priorität)`);
      } else {
        // Keine ausstehenden Zustellungen → PDF-Job holen
        const pdfRpc = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_pdf_job`, {
          method:"POST",
          headers:{"Content-Type":"application/json","apikey":serviceKey,"Authorization":`Bearer ${serviceKey}`},
          body: JSON.stringify({ worker_id_in: workerId }),
        });
        if (!pdfRpc.ok) {
          const errTxt = await pdfRpc.text();
          throw new Error(`RPC claim_pdf_job failed: ${pdfRpc.status}: ${errTxt}`);
        }
        submissions = await pdfRpc.json();
        jobMode = "pdf";
      }

      // jobMode für spätere Verzweigung merken
      (globalThis as any).__jobMode = jobMode;
    }

    if (!submissions?.length) {
      console.log(`[${workerId}] Keine fälligen Jobs gefunden`);
      return new Response(JSON.stringify({ success:true, message:"Keine fälligen Jobs", workerId }), {
        headers: {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
      });
    }

    const sub = submissions[0];
    // Gemeinsame Felder — sowohl PDF- als auch Delivery-Jobs haben company/email/id
    const { id, company, email, pdf_attempts, delivery_attempts, processing_status,
            // PDF-Job-Felder
            total_score, ds_score, ai_score, legal_score, gov_maturity_score,
            maturity_level, risk_level, risk_score, ai_legal_class, gaps_count, compliant_count,
            active_countries, customer_html,
            // Delivery-Job-Felder
            pdf_signed_url: sub_signed_url, pdf_storage_path: sub_storage_path,
          } = sub;

    // ── JOBMODE BRANCHING — MUSS ZUERST KOMMEN (ChatGPT Fix) ─────
    // Bestimme Modus VOR jeder modusabhängigen Logik
    // Delivery hat andere Felder, andere Max-Checks, anderen Status
    const jobMode: "pdf" | "delivery" = (globalThis as any).__jobMode || "pdf";
    console.log(`[${workerId}] Job-Modus: ${jobMode} | id=${id} | company=${company}`);

    // Email-Prüfung: modusabhängiger Fehlerstatus
    if (!email) {
      const failStatus = jobMode === "delivery" ? "delivery_failed" : "pdf_failed";
      await patchDB(id, {
        processing_status: failStatus,
        ...(jobMode === "pdf" ? { pdf_error: "Keine E-Mail-Adresse" } : { delivery_error: "Keine E-Mail-Adresse" }),
      });
      return new Response(JSON.stringify({ error:"Keine E-Mail", submissionId:id }), {
        status:400, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
      });
    }

    // ── NUR FÜR PDF-JOBS: Max-Versuche und Lock ──────────────────
    if (jobMode === "pdf") {
      // Max-PDF-Versuche prüfen (nur für pdf_pending Jobs relevant)
      if ((pdf_attempts||0) >= MAX_PDF_ATTEMPTS) {
        await patchDB(id, { processing_status:"pdf_failed", pdf_error:`Max. Versuche (${MAX_PDF_ATTEMPTS}) erreicht`, last_error_at:now.toISOString() });
        await sendLeadAlert(brevoKey, leadTo, company, email, id, `Max. PDF-Versuche erschöpft`, "pdf_failed");
        return new Response(JSON.stringify({ success:false, error:"Max PDF attempts reached", submissionId:id }), {
          status:410, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
        });
      }
      // Lock bestätigen — pdf_attempts wurde vom RPC bereits erhöht
      await patchDBHard(id, {
        processing_status: "pdf_generating",
        pdf_locked_at: now.toISOString(),
        pdf_worker_id: workerId,
        // pdf_attempts: NICHT erhöhen — RPC hat das bereits getan
      });
    }
    // Delivery-Lock wurde bereits im Claim (RPC oder manuell) gesetzt — kein weiterer Lock nötig

    // ── DELIVERY MODE: bestehende PDF-URL verwenden, Mail senden ─
    if (jobMode === "delivery") {
      // Felder wurden bereits oben aus sub destrukturiert (sub_signed_url, sub_storage_path)

      if (!sub_signed_url && !sub_storage_path) {
        // Kein PDF im Storage — versuche PDF neu zu generieren und dann zu liefern
        console.warn(`[${workerId}] Delivery-Modus aber kein Storage-Pfad — setze zurück auf pdf_pending`);
        await patchDB(id, { processing_status:"pdf_pending", delivery_locked_at:null, delivery_worker_id:null });
        return new Response(JSON.stringify({ success:false, error:"Kein PDF im Storage, zurückgesetzt auf pdf_pending", submissionId:id }), {
          headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
        });
      }

      const deliveryAttempt = sub.delivery_attempts||1;
      const scoreColor = (total_score||0)>=75?"#10B981":(total_score||0)>=55?"#E98126":"#DC2626";
      const safeComp = (company||"").replace(/[^a-zA-Z0-9]/g,"_").substring(0,40);
      const dateStr  = now.toISOString().slice(0,10);

      const deliveryHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#0f1f0f;font-family:Arial,sans-serif;padding:20px;"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#1a2e1a;border-radius:12px;overflow:hidden;margin:0 auto;"><tr><td style="height:3px;background:linear-gradient(90deg,#2e7d32,#66bb6a);"></td></tr><tr><td style="padding:24px 30px;"><p style="margin:0 0 4px;font-size:9px;color:#66bb6a;letter-spacing:1px;">TRUSTSPHERE 360 · PDF-REPORT</p><p style="margin:0 0 12px;font-size:15px;color:#e8f5e9;font-weight:bold;">📄 Ihr Compliance-Report als PDF</p><p style="margin:0 0 14px;font-size:12px;color:#a5d6a7;line-height:1.7;">Anbei erhalten Sie Ihren vollständigen TrustSphere 360 Compliance-Report für <strong style="color:#66bb6a;">${company}</strong>.<br><br>Score: <strong style="color:${scoreColor};">${total_score}/100</strong> | Risiko: <strong>${risk_level}</strong></p>${sub_signed_url?`<table cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr><td style="background:linear-gradient(135deg,#2e7d32,#1b5e20);border-radius:6px;"><a href="${sub_signed_url}" style="display:inline-block;padding:12px 24px;color:#e8f5e9;text-decoration:none;font-weight:bold;font-size:12px;">📥 PDF herunterladen</a></td></tr></table><p style="margin:0 0 10px;font-size:9px;color:#558b2f;">Link gültig bis: ${new Date(Date.now()+7*24*3600*1000).toLocaleDateString("de-CH")}</p>`:""}</td></tr><tr><td style="padding:10px 30px;background:#0a140a;border-top:1px solid #1a3a1a;"><p style="margin:0;font-size:8px;color:#2e7d32;">© 2026 Zehnder Governance · Keine Rechtsberatung</p></td></tr><tr><td style="height:3px;background:linear-gradient(90deg,#1b5e20,#66bb6a);"></td></tr></table></body></html>`;

      let deliverySent = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(()=>ctrl.abort(), 20000);
        const mRes = await fetch("https://api.brevo.com/v3/smtp/email", {
          method:"POST",
          headers:{"accept":"application/json","content-type":"application/json","api-key":brevoKey},
          body: JSON.stringify({
            sender:{name:"Zehnder Governance",email:"report@zehndergovernance.com"},
            to:[{email, name:company}],
            subject:`📄 Ihr PDF-Report: ${company} — TrustSphere 360 (Score: ${total_score}/100)`,
            htmlContent: deliveryHtml,
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const mTxt = await mRes.text();
        if (mRes.ok) { deliverySent=true; console.log(`[${workerId}] DELIVERY-MAIL OK ${mRes.status}`); }
        else { console.error(`[${workerId}] DELIVERY-MAIL FAIL ${mRes.status}: ${mTxt}`); }
      } catch(e:any) { console.error(`[${workerId}] DELIVERY-MAIL EXCEPTION:`, e?.message); }

      const nextStatus = deliverySent ? "delivery_sent"
        : deliveryAttempt >= MAX_DELIVERY_ATTEMPTS ? "delivery_failed" : "delivery_pending";
      // FIX: RPC hat delivery_attempts schon erhöht — Backoff auf attempt-1
      const waitMins = RETRY_BACKOFF_MINUTES[Math.max(0, deliveryAttempt - 1)] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length-1];
      await patchDB(id, {
        processing_status: nextStatus,
        delivery_locked_at: null,
        delivery_worker_id: null,
        customer_email_sent_at: deliverySent ? now.toISOString() : null,
        delivery_error: deliverySent ? null : "Delivery mail failed",
        next_retry_at: deliverySent ? null : new Date(Date.now()+waitMins*60*1000).toISOString(),
      });
      if (!deliverySent && deliveryAttempt >= MAX_DELIVERY_ATTEMPTS) {
        await sendLeadAlert(brevoKey, leadTo, company, email, id, "Max. Delivery-Versuche erschöpft", "delivery_failed");
      }
      return new Response(JSON.stringify({ success:deliverySent, mode:"delivery", submissionId:id, deliverySent }), {
        headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
      });
    }

    // ── PDF MODE: PDF generieren → Storage → delivery_pending setzen ─
    // ── [E5] PDF GENERIERUNG via Vercel Puppeteer ────────────────
    let pdfBytes: Uint8Array|null = null;
    let pdfError: string|null = null;
    
    const pdfRenderUrl  = Deno.env.get("PDF_RENDER_URL")  || "";
    const pdfRenderSecret = Deno.env.get("PDF_RENDER_SECRET") || "";

    try {
      if (!pdfRenderUrl) throw new Error("PDF_RENDER_URL nicht konfiguriert");
      
      console.log(`[${workerId}] PDF-Render via Vercel Puppeteer...`);
      
      // Assessment-Payload aus DB — KEINE neue Bewertungslogik
      // PDF rendert exakt dieselben Daten wie die Email
      // Assessment-Payload: NUR aus DB lesen — KEINE neue Bewertungslogik
      const assessmentPayload = {
        company:             sub.company,
        email:               sub.email,
        total_score:         typeof sub.total_score === "number" ? sub.total_score : null,
        ds_score:            typeof sub.ds_score === "number" ? sub.ds_score : null,
        ai_score:            sub.ai_score ?? null,
        legal_score:         typeof sub.legal_score === "number" ? sub.legal_score : null,
        gov_maturity_score:  typeof sub.gov_maturity_score === "number" ? sub.gov_maturity_score : null,
        risk_level:          sub.risk_level || null,
        risk_score:          typeof sub.risk_score === "number" ? sub.risk_score : null,
        maturity_level:      typeof sub.maturity_level === "number" ? sub.maturity_level : null,
        gaps_count:          sub.gaps_count || 0,
        compliant_count:     sub.compliant_count || 0,
        active_countries:    sub.active_countries || [],
        ai_legal_class:      sub.ai_legal_class || null,
        // Vollständige JSON-Blobs aus Intake (1:1 — nie modifiziert)
        scores_json:         sub.scores_json || null,
        gaps_json:           sub.gaps_json || null,
      };

      const renderRes = await fetch(pdfRenderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submission_id:     sub.id,
          secret:            pdfRenderSecret,
          assessment_payload: assessmentPayload,
        }),
      });

      if (!renderRes.ok) {
        const ct = renderRes.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const err = await renderRes.json();
          throw new Error(`Render API ${renderRes.status}: ${err.code} — ${err.detail||err.error}`);
        } else {
          const errText = await renderRes.text();
          throw new Error(`Render API ${renderRes.status}: ${errText.substring(0,200)}`);
        }
      }

      const pdfArrayBuffer = await renderRes.arrayBuffer();
      pdfBytes = new Uint8Array(pdfArrayBuffer);
      console.log(`[${workerId}] PDF OK: ${pdfBytes.length} bytes`);

    } catch(e: any) {
      pdfError = e?.message || "Unbekannter PDF-Fehler";
      console.error(`[${workerId}] PDF GEN FAIL:`, pdfError);
      // Fallback: Email bleibt unberührt, Status → failed, Retry möglich
    }

    if (!pdfBytes) {
      // [E3] Retry planen
      // FIX: pdf_attempts wurde vom RPC bereits erhöht — kein +1 mehr
      const attempt = pdf_attempts || 1;
      const waitMinutes = RETRY_BACKOFF_MINUTES[Math.max(0, attempt - 1)] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length-1];
      const nextRetry = new Date(Date.now() + waitMinutes * 60 * 1000).toISOString();

      await patchDB(id, {
        processing_status: attempt >= MAX_PDF_ATTEMPTS ? "pdf_failed" : "pdf_pending",
        pdf_locked_at: null,
        pdf_worker_id: null,
        pdf_error: pdfError,
        last_error_at: now.toISOString(),
        next_retry_at: nextRetry,
      });

      if (attempt >= MAX_PDF_ATTEMPTS) {
        await sendLeadAlert(brevoKey, leadTo, company, email, id, pdfError||"PDF-Fehler", "pdf_failed");
      } else {
        console.log(`[${workerId}] Retry geplant in ${waitMinutes} Minuten (Versuch ${attempt}/${MAX_PDF_ATTEMPTS})`);
      }

      return new Response(JSON.stringify({ success:false, pdfError, nextRetry, attempt, submissionId:id }), {
        status: 500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
      });
    }

    // ── [E5] SUPABASE STORAGE UPLOAD ─────────────────────────────
    const dateStr = now.toISOString().slice(0,10);
    const safeCompany = (company||"unknown").replace(/[^a-zA-Z0-9]/g,"_").substring(0,40);
    const storagePath = `reports/${dateStr}/${safeCompany}_${id.substring(0,8)}.pdf`;

    let storageOk = false;
    let storageError: string|null = null;

    try {
      const uploadRes = await fetch(`${storageUrl}/object/${BUCKET}/${storagePath}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/pdf",
          "x-upsert": "true",
        },
        body: pdfBytes,
      });

      if (uploadRes.ok) {
        storageOk = true;
        console.log(`[${workerId}] Storage OK: ${storagePath}`);
      } else {
        storageError = await uploadRes.text();
        console.error(`[${workerId}] Storage FAIL ${uploadRes.status}: ${storageError}`);
      }
    } catch(e: any) {
      storageError = e?.message;
      console.error(`[${workerId}] Storage EXCEPTION:`, storageError);
    }

    // [E6] Signierte URL erstellen (7 Tage gültig)
    let signedUrl: string|null = null;

    if (storageOk) {
      try {
        const signRes = await fetch(`${storageUrl}/object/sign/${BUCKET}/${storagePath}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 7 * 24 * 3600 }), // 7 Tage
        });

        if (signRes.ok) {
          const signData = await signRes.json();
          signedUrl = `${storageUrl}${signData.signedURL}`;
          console.log(`[${workerId}] Signed URL erstellt: ${signedUrl?.substring(0,60)}...`);
        } else {
          console.error(`[${workerId}] Sign URL FAIL: ${await signRes.text()}`);
        }
      } catch(e: any) {
        console.error(`[${workerId}] Sign URL EXCEPTION:`, e?.message);
      }
    }

    // DB: Storage-Pfad und Status speichern
    await patchDB(id, {
      processing_status: "delivery_pending",
      pdf_storage_path: storageOk ? storagePath : null,
      pdf_signed_url: signedUrl,
      pdf_generated_at: now.toISOString(),
      pdf_locked_at: null,
      pdf_worker_id: null,
      pdf_error: storageError || null,
    });

    // FIX 4: PDF-Modus endet hier — delivery_pending ist gesetzt
    // Der nächste Cron-Lauf (oder manueller Aufruf) übernimmt die Zustellung
    // Trennung: PDF-Worker = PDF+Storage | Delivery-Worker = Mail
    console.log(`[${workerId}] PDF-Modus abgeschlossen. Submission ${id} auf delivery_pending — nächster Lauf übernimmt Zustellung.`);
    return new Response(JSON.stringify({
      success: true,
      mode: "pdf",
      submissionId: id,
      pdfGenerated: true,
      pdfBytes: pdfBytes!.length,
      storageOk,
      storagePath: storageOk ? storagePath : null,
      nextStatus: "delivery_pending",
      message: "PDF erzeugt und gespeichert. Zustellung erfolgt im nächsten Worker-Lauf."
    }), { headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });

    // ── DIESER BLOCK WIRD NICHT MEHR ERREICHT (bleibt als Referenz) ─────
    // [E6] PDF-MAIL — wird nun vom Delivery-Modus (jobMode=delivery) übernommen
    /* REMOVED: direct mail send after PDF generation 

    const scoreColor = total_score>=75?"#10B981":total_score>=55?"#E98126":"#DC2626";
    const pdfName = `TrustSphere360_${safeCompany}_${dateStr}.pdf`;

    const pdfMailHtml = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f1f0f;font-family:'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1f0f;">
<tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;background:#1a2e1a;border-radius:14px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.6);">
  <tr><td style="height:3px;background:linear-gradient(90deg,#2e7d32,#66bb6a,#a5d6a7);"></td></tr>
  <tr><td style="padding:24px 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><p style="margin:0;font-size:16px;font-weight:900;color:#e8f5e9;letter-spacing:2px;">TRUSTSPHERE 360</p><p style="margin:2px 0 0;font-size:9px;color:#66bb6a;">PDF-Report · ${ENGINE_VERSION}</p></td>
      <td align="right"><p style="margin:0;font-size:10px;color:#a5d6a7;">${dateStr}</p></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 32px;"><div style="height:1px;background:linear-gradient(90deg,transparent,#2e7d32,transparent);"></div></td></tr>
  <tr><td style="padding:20px 32px 16px;">
    <p style="margin:0 0 10px;font-size:14px;color:#e8f5e9;font-weight:bold;">📄 Ihr PDF-Report ist bereit</p>
    <p style="margin:0 0 14px;font-size:12px;color:#a5d6a7;line-height:1.7;">Guten Tag,<br><br>anbei erhalten Sie Ihren vollständigen TrustSphere 360 Compliance-Report für <strong style="color:#66bb6a;">${escHtml(company)}</strong>.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1f0f;border-radius:8px;margin-bottom:16px;"><tr>
      <td style="width:33%;padding:12px;text-align:center;border-right:1px solid #1a3a1a;"><p style="margin:0;font-size:7px;color:#558b2f;font-weight:bold;letter-spacing:1px;">SCORE</p><p style="margin:3px 0;font-size:24px;color:${scoreColor};font-weight:900;">${total_score}</p><p style="margin:0;font-size:8px;color:#2e7d32;">/100 Punkte</p></td>
      <td style="width:33%;padding:12px;text-align:center;border-right:1px solid #1a3a1a;"><p style="margin:0;font-size:7px;color:#558b2f;font-weight:bold;letter-spacing:1px;">RISIKO</p><p style="margin:3px 0;font-size:13px;color:${risk_score>=7?"#DC2626":risk_score>=4?"#E98126":"#10B981"};font-weight:900;">${risk_level}</p><p style="margin:0;font-size:8px;color:#2e7d32;">${parseFloat(risk_score||0).toFixed(1)}/10</p></td>
      <td style="width:33%;padding:12px;text-align:center;"><p style="margin:0;font-size:7px;color:#558b2f;font-weight:bold;letter-spacing:1px;">LÜCKEN</p><p style="margin:3px 0;font-size:24px;color:#ff6b6b;font-weight:900;">${gaps_count||0}</p><p style="margin:0;font-size:8px;color:#2e7d32;">identifiziert</p></td>
    </tr></table>
    ${signedUrl ? `
    <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:14px;"><tr><td align="center">
      <a href="${signedUrl}" style="display:inline-block;background:linear-gradient(135deg,#2e7d32,#1b5e20);border-radius:8px;padding:13px 28px;color:#e8f5e9;text-decoration:none;font-weight:bold;font-size:13px;">📥 PDF herunterladen (7 Tage gültig)</a>
    </td></tr></table>
    <p style="margin:0 0 10px;font-size:10px;color:#558b2f;text-align:center;">Link gültig bis: ${new Date(Date.now()+7*24*3600*1000).toLocaleDateString("de-CH")}</p>
    ` : `<p style="margin:0 0 10px;font-size:11px;color:#ffa94d;">PDF-Report als Anhang dieser E-Mail.</p>`}
    <table cellpadding="0" cellspacing="0" align="center"><tr><td style="background:linear-gradient(135deg,#1b5e20,#2e7d32);border-radius:6px;"><a href="https://zehndergovernance.com" style="display:inline-block;padding:10px 22px;color:#e8f5e9;text-decoration:none;font-weight:bold;font-size:12px;">Alle Lücken schliessen →</a></td></tr></table>
  </td></tr>
  <tr><td style="padding:12px 32px;background:#0a140a;border-top:1px solid #1a3a1a;text-align:center;"><p style="margin:0;font-size:9px;color:#2e7d32;">© 2026 Zehnder Governance · Alex Zehnder, lic.iur., LL.M., CIPP/E · Keine Rechtsberatung</p></td></tr>
  <tr><td style="height:3px;background:linear-gradient(90deg,#1b5e20,#66bb6a,#1b5e20);"></td></tr>
</table></td></tr></table>
</body></html>`;

    // [E3] Delivery Attempts prüfen
    const deliveryAttempt = (delivery_attempts||0) + 1;
    if (deliveryAttempt > MAX_DELIVERY_ATTEMPTS) {
      await patchDB(id, { processing_status:"delivery_failed", last_error_at:now.toISOString() });
      await sendLeadAlert(brevoKey, leadTo, company, email, id, `Max. Delivery-Versuche (${MAX_DELIVERY_ATTEMPTS})`, "delivery_failed");
      return new Response(JSON.stringify({ success:false, error:"Max delivery attempts", submissionId:id }), { status:410, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });
    }

    await patchDBHard(id, { delivery_attempts: deliveryAttempt, delivery_locked_at: now.toISOString(), delivery_worker_id: workerId });

    // Mail-Payload: signierte URL primär, PDF-Attachment als Fallback wenn kein Storage
    const mailPayload: Record<string,unknown> = {
      sender:   { name:"Zehnder Governance", email:"report@zehndergovernance.com" },
      to:       [{ email, name:company }],
      subject:  `📄 Ihr PDF-Report: ${company} — TrustSphere 360 (Score: ${total_score}/100)`,
      htmlContent: pdfMailHtml,
    };

    // Attachment nur wenn kein Storage (Fallback)
    if (!storageOk || !signedUrl) {
      let binary=""; const chunk=8192;
      for(let i=0;i<pdfBytes.length;i+=chunk) binary+=String.fromCharCode(...pdfBytes.slice(i,i+chunk));
      mailPayload.attachment = [{ content: btoa(binary), name: pdfName }];
      console.log(`[${workerId}] Kein Storage → PDF als Attachment (${pdfBytes.length} bytes)`);
    }

    let pdfMailSent = false;
    let deliveryError: string|null = null;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const mailRes = await fetch("https://api.brevo.com/v3/smtp/email", {
        method:"POST",
        headers:{"accept":"application/json","content-type":"application/json","api-key":brevoKey},
        body: JSON.stringify(mailPayload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const mailTxt = await mailRes.text();
      if (mailRes.ok) { pdfMailSent=true; console.log(`[${workerId}] PDF-MAIL OK ${mailRes.status}`); }
      else { deliveryError = `${mailRes.status}: ${mailTxt}`; console.error(`[${workerId}] PDF-MAIL FAIL: ${deliveryError}`); }
    } catch(e:any) {
      deliveryError = e?.message;
      console.error(`[${workerId}] PDF-MAIL EXCEPTION:`, deliveryError);
    }

    // ── FINAL DB UPDATE ───────────────────────────────────────────
    if (pdfMailSent) {
      await patchDB(id, {
        processing_status: "delivery_sent",
        customer_email_sent_at: new Date().toISOString(),
        delivery_locked_at: null,
        delivery_worker_id: null,
        delivery_error: null,
        next_retry_at: null,
      });
      console.log(`[${workerId}] DONE: id=${id} | storage=${storageOk} | signedUrl=${!!signedUrl} | delivered=true`);
    } else {
      // [E3] Delivery-Retry planen
      // FIX: RPC hat delivery_attempts schon erhöht — Backoff auf attempt-1
      const waitMinutes = RETRY_BACKOFF_MINUTES[Math.max(0, deliveryAttempt - 1)] ?? RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length-1];
      const nextRetry = new Date(Date.now() + waitMinutes * 60 * 1000).toISOString();

      await patchDB(id, {
        processing_status: deliveryAttempt >= MAX_DELIVERY_ATTEMPTS ? "delivery_failed" : "delivery_pending",
        delivery_locked_at: null,
        delivery_worker_id: null,
        delivery_error: deliveryError,
        last_error_at: now.toISOString(),
        next_retry_at: nextRetry,
      });

      if (deliveryAttempt >= MAX_DELIVERY_ATTEMPTS) {
        await sendLeadAlert(brevoKey, leadTo, company, email, id, deliveryError||"Mail-Fehler", "delivery_failed");
      }
    }

    // END OF REMOVED SECTION */

    // This code is unreachable — kept for reference only
    // Delivery is now handled by the delivery jobMode branch above
    return new Response(JSON.stringify({ error:"unreachable" }), {
      headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });

    // ── HELPER FUNCTIONS ─────────────────────────────────────────

    // [FIX 2] patchDB mit hartem Status-Check (ChatGPT: "zu weich für Produktion")
    async function patchDBHard(subId: string, data: Record<string,unknown>): Promise<void> {
      const res = await fetch(`${supabaseUrl}/rest/v1/trustsphere_submissions?id=eq.${subId}`, {
        method:"PATCH",
        headers:{"Content-Type":"application/json","apikey":serviceKey,"Authorization":`Bearer ${serviceKey}`,"Prefer":"return=minimal"},
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`DB patch failed [${res.status}]: ${errTxt.substring(0,100)}`);
      }
    }

    // patchDB: weichere Version für nicht-kritische Updates (Monitoring, Logs)
    async function patchDB(subId: string, data: Record<string,unknown>): Promise<void> {
      try {
        const res = await fetch(`${supabaseUrl}/rest/v1/trustsphere_submissions?id=eq.${subId}`, {
          method:"PATCH",
          headers:{"Content-Type":"application/json","apikey":serviceKey,"Authorization":`Bearer ${serviceKey}`},
          body: JSON.stringify(data),
        });
        if (!res.ok) console.error(`DB patch warn (${subId}) ${res.status}: ${await res.text()}`);
      } catch(e:any) { console.warn(`DB patch exception (${subId}):`, e?.message); }
    }

    async function sendLeadAlert(key: string, to: string, comp: string, mail: string, subId: string, errorMsg: string, status: string): Promise<void> {
      try {
        await fetch("https://api.brevo.com/v3/smtp/email", {
          method:"POST",
          headers:{"accept":"application/json","content-type":"application/json","api-key":key},
          body: JSON.stringify({
            sender:{name:"Zehnder Governance",email:"report@zehndergovernance.com"},
            to:[{email:to}],
            subject:`⚠️ ${status.toUpperCase()}: ${comp} (${subId.substring(0,8)})`,
            htmlContent:`<p><strong>Status: ${status}</strong><br>Unternehmen: ${comp}<br>E-Mail: ${mail}<br>Submission-ID: ${subId}<br>Fehler: ${errorMsg}<br>Worker: ${workerId}<br>Zeit: ${new Date().toISOString()}</p><p>→ Manuelle Prüfung in Supabase erforderlich.</p>`,
          }),
        });
      } catch(e:any) { console.warn("Alert mail failed:", e?.message); }
    }

    function escHtml(s: string): string {
      return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

  } catch(error:any) {
    console.error(`[${workerId}] FATAL:`, error.message, error.stack);
    return new Response(JSON.stringify({ error:error.message, code:"E000", workerId }), {
      status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });
  }
});


// ── PDF GENERATION ──────────────────────────────────────────
// TRUSTSPHERE 360 — PROFESSIONAL PDF REPORT v8.0
// 8 Seiten | BigLaw-sicher | 100% aus DB-Daten


const GREEN_DARK  = rgb(0.106, 0.231, 0.106);  // #1B3A1B
const GREEN_MID   = rgb(0.180, 0.490, 0.196);  // #2E7D32
const GREEN_LIGHT = rgb(0.400, 0.733, 0.416);  // #66BB6A
const GREEN_BG    = rgb(0.910, 0.961, 0.913);  // #E8F5E9
const RED         = rgb(0.835, 0.153, 0.153);  // #D52727
const ORANGE      = rgb(0.902, 0.502, 0.149);  // #E68026
const GRAY_DARK   = rgb(0.200, 0.200, 0.200);  // #333
const GRAY_MID    = rgb(0.400, 0.400, 0.400);  // #666
const GRAY_LIGHT  = rgb(0.941, 0.941, 0.941);  // #F0F0F0
const WHITE       = rgb(1,1,1);
const BLACK       = rgb(0,0,0);

// Seitenmasse A4
const PW = 595; const PH = 842;
const ML = 45; const MR = 45; const MT = 55; const MB = 45;
const CW = PW - ML - MR; // 505

// Hilfsfunktionen
function scoreColor(score: number) {
  if (score >= 75) return GREEN_MID;
  if (score >= 55) return ORANGE;
  return RED;
}
function scoreLabel(score: number) {
  if (score >= 75) return "GUT";
  if (score >= 55) return "MITTEL";
  return "KRITISCH";
}
function priColor(pri: string) {
  if (pri === "KRITISCH") return RED;
  if (pri === "WICHTIG")  return ORANGE;
  return GREEN_MID;
}
function riskColor(level: string) {
  if (level === "SEHR HOCH" || level === "KRITISCH") return RED;
  if (level === "ERHOEHT" || level === "ERHÖHT")    return ORANGE;
  return GREEN_MID;
}
function confLabel(c: string) {
  if (c === "LOW")    return "Niedrig (Angaben unklar)";
  if (c === "MEDIUM") return "Mittel (Angaben teils unklar)";
  return "Hoch (Angaben eindeutig)";
}
function matLabel(m: number) {
  return ["","INITIAL","ENTWICKLUNG","ETABLIERT","GEMANAGT","OPTIMIERT"][m] || "INITIAL";
}

// Sanitize text - entferne alle non-Latin1 Zeichen für pdf-lib
function san(t: string): string {
  if (!t) return "";
  // WinAnsi (Latin-1) unterstuetzt deutsche Umlaute nativ (0x00-0xFF)
  // Nur Zeichen ausserhalb Latin-1 muessen ersetzt werden
  return t
    .replace(/—/g, " - ")   // em-dash
    .replace(/–/g, "-")      // en-dash
    .replace(/•/g, "-")      // bullet
    .replace(/“|”/g, '"') // typogr. Anfuehrungszeichen
    .replace(/‘|’/g, "'") // typogr. Apostroph
    .replace(/…/g, "...")    // Ellipsis
    .replace(/♥/g, "")       // Herz-Symbol
    .replace(/ß/g, "ss")     // sz (nicht in allen Fonts)
    .replace(/[^ -ÿ]/g, ""); // alles andere ausserhalb Latin-1 entfernen
}

// Text umbrechen auf Breite w
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = san(text).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    try {
      if (font.widthOfTextAtSize(test, size) <= maxWidth) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    } catch { cur = test; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Page Header
function drawHeader(page: PDFPage, fB: PDFFont, fR: PDFFont, company: string, pageNum: number, total: number) {
  // gruene Leiste oben
  page.drawRectangle({ x: 0, y: PH - 28, width: PW, height: 28, color: GREEN_DARK });
  page.drawText("TRUSTSPHERE 360", { x: ML, y: PH - 18, size: 9, font: fB, color: WHITE });
  page.drawText(san(company) + " - VERTRAULICH", { x: ML + 100, y: PH - 18, size: 8, font: fR, color: GREEN_LIGHT });
  page.drawText("v8.0", { x: PW - MR - 25, y: PH - 18, size: 7, font: fR, color: GREEN_LIGHT });
  // gruene Leiste unten
  page.drawRectangle({ x: 0, y: 0, width: PW, height: 22, color: GREEN_DARK });
  page.drawText("Zehnder Governance | Alex Zehnder, lic.iur., LL.M., CIPP/E | zehndergovernance.com", 
    { x: ML, y: 7, size: 6.5, font: fR, color: GREEN_LIGHT });
  page.drawText(`${pageNum} / ${total}`, { x: PW - MR - 20, y: 7, size: 7, font: fB, color: WHITE });
}

// Sektion-Titel
function drawSectionTitle(page: PDFPage, fB: PDFFont, text: string, y: number): number {
  page.drawRectangle({ x: ML, y: y - 4, width: CW, height: 20, color: GREEN_DARK });
  page.drawText(san(text), { x: ML + 8, y: y + 2, size: 10, font: fB, color: WHITE });
  return y - 30;
}

// KPI Box
function drawKPI(page: PDFPage, fB: PDFFont, fR: PDFFont, x: number, y: number, w: number, h: number, label: string, value: string, sub: string, col: any) {
  page.drawRectangle({ x, y: y - h, width: w, height: h, color: GRAY_LIGHT });
  page.drawRectangle({ x, y: y - 3, width: w, height: 3, color: col });
  page.drawText(san(label), { x: x + 6, y: y - 16, size: 6.5, font: fR, color: GRAY_MID });
  page.drawText(san(value), { x: x + 6, y: y - 30, size: 14, font: fB, color: col });
  if (sub) page.drawText(san(sub), { x: x + 6, y: y - 44, size: 7, font: fR, color: GRAY_MID });
}


// Gap-Block zeichnen — gibt neue Y-Position zurueck

// Laender-Daten (feststehend, BigLaw-sicher)
const COUNTRY_INFO: Record<string, { law: string; authority: string; maxFine: string; note: string }> = {
  schweiz:    { law: "nDSG (revidiertes DSG)", authority: "EDOEB (Bern)", maxFine: "CHF 250'000 (Strafrecht)", note: "Anwendbar bei Datenbearbeitung in der Schweiz oder mit Bezug zur Schweiz." },
  deutschland:{ law: "DSGVO / BDSG", authority: "jeweilige Landesdatenschutzbehoerde", maxFine: "EUR 20 Mio. oder 4% Jahresumsatz", note: "Potenziell anwendbar sofern Niederlassung oder Marktaktivitaet in Deutschland." },
  oesterreich:{ law: "DSGVO / DSG", authority: "Datenschutzbehoerde Wien", maxFine: "EUR 20 Mio. oder 4% Jahresumsatz", note: "Potenziell anwendbar sofern Niederlassung oder Marktaktivitaet in Oesterreich." },
  usa:        { law: "CCPA/CPRA (CA), VCDPA, CPA u.a.", authority: "California Attorney General, FTC", maxFine: "USD 2'500 - 7'500 pro vorsaetzlicher Verletzung", note: "Potenziell anwendbar sofern Schwellenwerte (Umsatz/Nutzer) erfuellt sind. Finale Beurteilung erfordert Einzelfallpruefung." },
  eu:         { law: "DSGVO (EU) 2016/679", authority: "Jeweilige nationale DPA", maxFine: "EUR 20 Mio. oder 4% Jahresumsatz", note: "Anwendbar bei Niederlassung in der EU oder wenn Betroffene in der EU adressiert werden." },
  uk:         { law: "UK GDPR / Data Protection Act 2018", authority: "ICO (London)", maxFine: "GBP 17.5 Mio. oder 4% Jahresumsatz", note: "Potenziell anwendbar sofern Marktaktivitaet im UK oder Niederlassung." },
  china:      { law: "PIPL (Personal Information Protection Law)", authority: "CAC (Cyberspace Administration)", maxFine: "CNY 50 Mio. oder 5% Jahresumsatz", note: "Potenziell anwendbar sofern Verarbeitung von Daten chinesischer Buerger." },
  brasilien:  { law: "LGPD (Lei Geral de Protecao de Dados)", authority: "ANPD", maxFine: "BRL 50 Mio. oder 2% Umsatz", note: "Potenziell anwendbar sofern Verarbeitung in Brasilien oder Betroffene in Brasilien." },
  singapur:   { law: "PDPA (Personal Data Protection Act)", authority: "PDPC", maxFine: "SGD 1 Mio.", note: "Potenziell anwendbar sofern Marktaktivitaet in Singapur." },
  indien:     { law: "DPDPA (Digital Personal Data Protection Act)", authority: "Data Protection Board", maxFine: "INR 250 Crore (ca. EUR 28 Mio.)", note: "Potenziell anwendbar sofern Verarbeitung von Daten indischer Buerger." },
  australien: { law: "Privacy Act 1988 / APPs", authority: "OAIC", maxFine: "AUD 50 Mio.", note: "Potenziell anwendbar sofern Umsatz > AUD 3 Mio. und Marktaktivitaet in Australien." },
  japan:      { law: "APPI (Act on Protection of Personal Information)", authority: "PPC", maxFine: "JPY 100 Mio.", note: "Potenziell anwendbar sofern Verarbeitung von Daten japanischer Buerger." },
  sudkorea:   { law: "PIPA (Personal Information Protection Act)", authority: "PIPC", maxFine: "KRW 3 Mrd. oder 3% Umsatz", note: "Potenziell anwendbar sofern Marktaktivitaet in Suedkorea." },
  vietnam:    { law: "PDPD (Decree 13/2023/ND-CP)", authority: "Ministerium für ÖffentlicheSicherheit", maxFine: "VND 100 Mio.", note: "Potenziell anwendbar sofern Verarbeitung von Daten vietnamesischer Buerger." },
  hongkong:   { law: "PDPO (Personal Data Privacy Ordinance)", authority: "PCPD", maxFine: "HKD 1 Mio. + Strafrecht", note: "Potenziell anwendbar sofern Marktaktivitaet in Hongkong." },
};

// HAUPTFUNKTION


// ── VISUELLE HILFSFUNKTIONEN ────────────────────────────────────

// Schöner Score-Kreis mit 3 Ringen
function drawScoreCircle(page: PDFPage, fB: PDFFont, fR: PDFFont, cx: number, cy: number, score: number) {
  const col = scoreColor(score);
  const r   = 52;
  // Äusserer Ring (hell)
  page.drawEllipse({ x:cx, y:cy, xScale:r+12, yScale:r+12, color:GREEN_BG });
  // Mittlerer Ring (Farbe)
  page.drawEllipse({ x:cx, y:cy, xScale:r+4, yScale:r+4, color:col });
  // Innerer Ring (weiss)
  page.drawEllipse({ x:cx, y:cy, xScale:r-6, yScale:r-6, color:WHITE });
  // Score-Zahl
  const s = `${score}`;
  const xOff = s.length >= 3 ? 16 : s.length === 2 ? 12 : 7;
  page.drawText(s, { x:cx-xOff, y:cy-10, size:26, font:fB, color:col });
  page.drawText("/100", { x:cx-14, y:cy-24, size:9, font:fR, color:GRAY_MID });
  page.drawText(scoreLabel(score), { x:cx-18, y:cy+22, size:8, font:fB, color:col });
}

// Horizontaler Balken (z.B. für Sub-Scores)
function drawBar(page: PDFPage, x: number, y: number, w: number, h: number, val: number, max: number, col: any, bgCol: any) {
  page.drawRectangle({ x, y, width:w, height:h, color:bgCol });
  const filled = Math.max(4, Math.round(val/max*w));
  page.drawRectangle({ x, y, width:filled, height:h, color:col });
}

// Professionelle Gap-Karte
function drawGapBlockPro(page: PDFPage, fB: PDFFont, fR: PDFFont, gap: any, x: number, y: number, w: number): number {
  const col = priColor(gap.priority||"MODERAT");
  const conf = gap.confidence||"HIGH";
  const confCol = conf==="HIGH"?GREEN_MID:conf==="MEDIUM"?ORANGE:RED;

  // Karten-Hintergrund
  page.drawRectangle({ x, y:y-118, width:w, height:118, color:rgb(0.98,0.99,0.98) });
  // Linker farbiger Streifen (dicker, auffälliger)
  page.drawRectangle({ x, y:y-118, width:5, height:118, color:col });
  // Obere farbige Leiste
  page.drawRectangle({ x, y:y-18, width:w, height:18, color:col });

  // Priorität + ID
  page.drawText(san(gap.priority||"MODERAT"), { x:x+10, y:y-13, size:8.5, font:fB, color:WHITE });
  page.drawText(san(gap.id||""), { x:x+80, y:y-13, size:7.5, font:fR, color:rgb(0.85,0.95,0.85) });

  // Confidence Badge rechts
  page.drawRectangle({ x:x+w-80, y:y-16, width:78, height:14, color:confCol });
  const confText = conf==="HIGH"?"✓ Hoch":conf==="MEDIUM"?"~ Mittel":"! Niedrig";
  page.drawText(san(confText.replace("✓","").replace("~","").replace("!","").trim()),
    { x:x+w-72, y:y-12, size:6.5, font:fB, color:WHITE });

  // Titel
  const titleLines = wrapText(gap.condition||"", fB, 9, w-18);
  let ty = y-30;
  for (const line of titleLines.slice(0,2)) {
    page.drawText(line, { x:x+10, y:ty, size:9, font:fB, color:GRAY_DARK });
    ty -= 12;
  }

  // 4 Felder in 2-Spalten Layout
  const fields = [
    { label:"Warum anwendbar", text: gap.evidence||"Auf Basis der Angaben besteht Risikopotenzial.", col:GREEN_MID },
    { label:"Rechtsgrundlage",  text: gap.norm||"–", col:GREEN_MID },
    { label:"Risiko",           text: gap.sanction||"Regulatorische Konsequenzen möglich.", col:RED },
    { label:"Massnahme",        text: gap.reportText||"–", col:GREEN_MID },
  ];

  let fy = ty - 4;
  for (const [fi, field] of fields.entries()) {
    if (fy < y-115) break;
    page.drawText(field.label + ":", { x:x+10, y:fy, size:6.5, font:fB, color:field.col });
    const flines = wrapText(field.text, fR, 7.5, w-18);
    fy -= 10;
    for (const fline of flines.slice(0,1)) {
      page.drawText(fline, { x:x+10, y:fy, size:7.5, font:fR, color:GRAY_DARK });
      fy -= 10;
    }
  }

  // Frist unten rechts
  if (gap.impactLabel) {
    page.drawText("Frist: "+san(gap.impactLabel), { x:x+w-130, y:y-113, size:6.5, font:fB, color:col });
  }

  return y - 125; // Nächste Karte
}


export async function generatePDFProfessional(sub: any): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const fB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fR = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── DATEN ─────────────────────────────────────────────────────
  const company   = san(sub.company || "Unbekannt");
  const today     = new Date().toLocaleDateString("de-CH");
  const scores    = sub.scores_json ? JSON.parse(sub.scores_json) : {};
  const allGaps   = sub.gaps_json  ? JSON.parse(sub.gaps_json)  : [];

  const totalScore  = scores.totalScore    || sub.total_score        || 0;
  const dsScore     = scores.dsScore       || sub.ds_score           || 0;
  const aiScore     = scores.aiScore       !== undefined ? scores.aiScore : (sub.ai_score ?? null);
  const legalScore  = scores.legalScore    || sub.legal_score        || 0;
  const govMatScore = scores.govMatScore   || sub.gov_maturity_score || 0;
  const govRiskLevel= san(scores.govRiskLevel || sub.risk_level || "UNBEKANNT");
  const govRiskScore= scores.govRiskScore  || sub.risk_score         || 0;
  const matLevel    = scores.maturityLevel || sub.maturity_level     || 1;
  const gapsCount   = allGaps.length       || sub.gaps_count         || 0;
  const complCount  = scores.compliantCount|| sub.compliant_count    || 0;
  const hasAI       = aiScore !== null && aiScore !== undefined;

  // active_countries robust
  let activeCtry: string[] = [];
  const rawCtry = scores.activeCountries || sub.active_countries;
  if (Array.isArray(rawCtry)) activeCtry = rawCtry as string[];
  else if (typeof rawCtry === "string" && rawCtry.length > 0) {
    const cleaned = rawCtry.replace(/^\[|\]$|^\{|\}$/g, "").replace(/"/g, "");
    activeCtry = cleaned.split(",").map((s:string) => s.trim()).filter(Boolean);
  }

  const critGaps  = allGaps.filter((g:any) => g.priority === "KRITISCH");
  const wichtGaps = allGaps.filter((g:any) => g.priority === "WICHTIG");
  const modGaps   = allGaps.filter((g:any) => !["KRITISCH","WICHTIG"].includes(g.priority||""));
  const sofortG   = allGaps.filter((g:any) => (g.impactLabel||"").includes("Sofort"));
  const kurzG     = allGaps.filter((g:any) => (g.impactLabel||"").includes("Kurzfristig"));
  const mittelG   = allGaps.filter((g:any) => !(g.impactLabel||"").includes("Sofort") && !(g.impactLabel||"").includes("Kurzfristig"));

  const gapPageCount = (critGaps.length>0?1:0)+(wichtGaps.length>0?1:0)+(modGaps.length>0?1:0);
  const TOTAL = 4 + gapPageCount + 1 + 1; // immer Länder + Services

  // ─── SEITE 1: EXECUTIVE SUMMARY ──────────────────────────────
  {
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, 1, TOTAL);
    let y = PH - 48;

    // Firmen-Titel
    page.drawText(company, { x:ML, y, size:22, font:fB, color:GREEN_DARK });
    y -= 16;
    page.drawText("TrustSphere 360 Compliance-Analyse  ·  " + today, { x:ML, y, size:9, font:fR, color:GRAY_MID });
    y -= 5;
    page.drawLine({ start:{x:ML,y}, end:{x:ML+CW,y}, thickness:1, color:GREEN_MID });
    y -= 22;

    // LINKE SPALTE: Score-Kreis (grösser)
    const circleX = ML + 70;
    const circleY = y - 60;
    drawScoreCircle(page, fB, fR, circleX, circleY, totalScore);

    // RECHTE SPALTE: Sub-Score Balken
    const bx = ML + 155;
    const bw = CW - 155;
    const subScores = [
      { label:"DATENSCHUTZ", val:dsScore, col:scoreColor(dsScore) },
      { label:"LEGAL COMPLIANCE", val:legalScore, col:scoreColor(legalScore) },
      { label:"GOVERNANCE", val:govMatScore, col:scoreColor(govMatScore) },
      ...(hasAI ? [{ label:"KI-GOVERNANCE", val:aiScore as number, col:scoreColor(aiScore as number) }] : []),
    ];

    let by = y - 8;
    for (const ss of subScores) {
      page.drawText(ss.label, { x:bx, y:by, size:7, font:fR, color:GRAY_MID });
      page.drawText(`${ss.val}/100`, { x:bx+bw-35, y:by, size:7, font:fB, color:ss.col });
      by -= 11;
      drawBar(page, bx, by, bw-40, 8, ss.val, 100, ss.col, rgb(0.92,0.95,0.92));
      by -= 15;
    }

    y = Math.min(circleY - 75, by - 5);

    // 3 KPI Boxen
    const kw = (CW-8)/3;
    [
      { label:"GOVERNANCE-RISIKO", val:san(govRiskLevel), sub:`${govRiskScore}/10`, col:riskColor(govRiskLevel) },
      { label:"GESAMT-SCORE",      val:`${totalScore}/100`, sub:scoreLabel(totalScore), col:scoreColor(totalScore) },
      { label:"COMPLIANCE-LÜCKEN", val:`${gapsCount}`, sub:`${complCount} Kriterien erfüllt`, col:gapsCount>10?RED:gapsCount>5?ORANGE:GREEN_MID },
    ].forEach((kpi,i) => {
      const kx = ML + i*(kw+4);
      // Karten-Schatten-Effekt
      page.drawRectangle({ x:kx+2, y:y-56, width:kw, height:56, color:rgb(0.85,0.88,0.85) });
      page.drawRectangle({ x:kx, y:y-54, width:kw, height:54, color:WHITE });
      page.drawRectangle({ x:kx, y:y-4,  width:kw, height:4,  color:kpi.col });
      page.drawText(kpi.label, { x:kx+6, y:y-16, size:6.5, font:fR, color:GRAY_MID });
      page.drawText(kpi.val,   { x:kx+6, y:y-32, size:15,  font:fB, color:kpi.col });
      page.drawText(kpi.sub,   { x:kx+6, y:y-47, size:7,   font:fR, color:GRAY_MID });
    });
    y -= 68;

    // Gap-Verteilung MINI-GRAFIK
    if (gapsCount > 0) {
      page.drawText("LÜCKEN NACH PRIORITÄT", { x:ML, y, size:7, font:fB, color:GRAY_MID });
      y -= 10;
      const barW = CW;
      const barH = 16;
      const total3 = critGaps.length + wichtGaps.length + modGaps.length || 1;
      let bxStart = ML;
      const bars = [
        { count:critGaps.length,  col:RED,      label:"Kritisch" },
        { count:wichtGaps.length, col:ORANGE,   label:"Wichtig" },
        { count:modGaps.length,   col:GREEN_MID,label:"Moderat" },
      ];
      for (const bar of bars) {
        if (bar.count === 0) continue;
        const w3 = Math.round(bar.count/total3*barW);
        page.drawRectangle({ x:bxStart, y:y-barH, width:w3, height:barH, color:bar.col });
        if (w3 > 30) {
          page.drawText(`${bar.count} ${bar.label}`, { x:bxStart+4, y:y-12, size:7, font:fB, color:WHITE });
        }
        bxStart += w3;
      }
      y -= barH + 10;
    }

    // Reifestufe
    y = drawSectionTitle(page, fB, "REIFESTUFE", y);
    const stages = ["INITIAL","ENTWICKLUNG","ETABLIERT","GEMANAGT","OPTIMIERT"];
    const stW = CW/5;
    stages.forEach((s,i) => {
      const active = i+1===matLevel;
      const past   = i+1 < matLevel;
      const bx2    = ML+i*stW;
      const fillCol = active ? GREEN_MID : past ? GREEN_BG : GRAY_LIGHT;
      page.drawRectangle({ x:bx2, y:y-24, width:stW-2, height:24, color:fillCol });
      if (active) {
        page.drawRectangle({ x:bx2, y:y-3, width:stW-2, height:3, color:GREEN_DARK });
      }
      page.drawText(`${i+1}`, { x:bx2+5, y:y-11, size:9, font:fB, color:active?WHITE:past?GREEN_MID:GRAY_MID });
      page.drawText(s, { x:bx2+4, y:y-21, size:5.5, font:active?fB:fR, color:active?WHITE:past?GREEN_MID:GRAY_MID });
    });
    y -= 32;
    const prioritaerCount2 = critGaps.length + wichtGaps.length;
    page.drawText(
      `Stufe ${matLevel}/5 — ${matLabel(matLevel)}. ` +
      (prioritaerCount2>0 ? `${prioritaerCount2} prioritäre Lücken bis Stufe ${Math.min(matLevel+1,5)}.` : "Gutes Compliance-Profil."),
      { x:ML, y, size:7.5, font:fR, color:GRAY_MID }
    );
    y -= 18;

    // Top-3 Risiken (wenn vorhanden)
    if (critGaps.length > 0) {
      y = drawSectionTitle(page, fB, "TOP KRITISCHE RISIKEN", y);
      for (const g of critGaps.slice(0,3)) {
        if (y < MB+22) break;
        page.drawRectangle({ x:ML, y:y-14, width:CW, height:14, color:rgb(1,0.95,0.95) });
        page.drawRectangle({ x:ML, y:y-14, width:4, height:14, color:RED });
        page.drawText(san((g.condition||"").substring(0,72)), { x:ML+9, y:y-11, size:8, font:fB, color:GRAY_DARK });
        page.drawText(san((g.norm||"").substring(0,40)), { x:PW-MR-145, y:y-11, size:6.5, font:fR, color:GREEN_MID });
        y -= 16;
      }
      y -= 4;
    }

    // Jurisdiktionen
    y = drawSectionTitle(page, fB, "ANWENDBARE RECHTSSYSTEME", y);
    if (activeCtry.length === 0) {
      page.drawText("Keine Rechtssysteme angegeben — bitte Angaben vervollständigen.",
        { x:ML, y, size:8, font:fR, color:GRAY_MID });
      y -= 14;
    } else {
      const coreJur = ["schweiz","eu","deutschland","oesterreich","uk"];
      activeCtry.slice(0,8).forEach((c,i) => {
        const bx3 = ML+(i%4)*(CW/4);
        const by3 = y-(Math.floor(i/4)*14);
        const isCore = coreJur.includes(c.toLowerCase());
        page.drawRectangle({ x:bx3, y:by3-12, width:CW/4-4, height:12,
          color: isCore ? GREEN_BG : GRAY_LIGHT });
        page.drawText((isCore?"✓ ":"~ ")+san(c.toUpperCase()),
          { x:bx3+4, y:by3-9, size:7, font:isCore?fB:fR, color:isCore?GREEN_DARK:GRAY_MID });
      });
      y -= Math.ceil(Math.min(activeCtry.length,8)/4)*14+6;
    }

    // Executive Fazit
    y = drawSectionTitle(page, fB, "EXECUTIVE FAZIT", y);
    const fazit = (gapsCount===0
      ? `Die Analyse zeigt ein weitgehend konformes Datenschutzprofil für ${company}. `
      : `Die Analyse identifiziert Risikopotenzial in ${gapsCount} Bereichen für ${company}. `) +
      `Score: ${totalScore}/100 · Risiko: ${govRiskLevel} (${govRiskScore}/10) · Reifestufe: ${matLabel(matLevel)} (${matLevel}/5). ` +
      `Diese indikative Ersteinschätzung ersetzt keine Einzelfallprüfung.`;
    for (const line of wrapText(fazit, fR, 8.5, CW)) {
      if (y < MB+14) break;
      page.drawText(line, { x:ML, y, size:8.5, font:fR, color:GRAY_DARK });
      y -= 12;
    }
  }

  // ─── SEITE 2: METHODIK ────────────────────────────────────────
  {
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, 2, TOTAL);
    let y = PH - 50;

    y = drawSectionTitle(page, fB, "BEWERTUNGSMETHODIK UND RECHTLICHE EINORDNUNG", y);

    // Hinweis-Box
    page.drawRectangle({ x:ML, y:y-50, width:CW, height:50, color:GREEN_BG });
    page.drawRectangle({ x:ML, y:y-50, width:5,  height:50, color:GREEN_MID });
    page.drawText("WICHTIGER RECHTLICHER HINWEIS", { x:ML+10, y:y-14, size:9, font:fB, color:GREEN_DARK });
    page.drawText("Diese Analyse ist eine indikative Ersteinschätzung und stellt keine Rechtsberatung dar.",
      { x:ML+10, y:y-27, size:8, font:fR, color:GRAY_DARK });
    page.drawText("Für verbindliche Beurteilungen ist eine Einzelfallprüfung durch eine Fachperson erforderlich.",
      { x:ML+10, y:y-39, size:8, font:fR, color:GRAY_DARK });
    y -= 60;

    page.drawText("Scoring-Modell", { x:ML, y, size:11, font:fB, color:GREEN_DARK });
    y -= 16;

    // Scoring-Tabelle mit Visualisierung
    const sRows = [
      ["Kategorie","Gewichtung","Ihr Wert","Status"],
      ["Datenschutz (nDSG/DSGVO)", hasAI?"70%":"100%", `${dsScore}/100`, scoreLabel(dsScore)],
      ["KI-Governance (EU AI Act)", hasAI?"30%":"–", hasAI?`${aiScore}/100`:"Nicht anwendbar", hasAI?scoreLabel(aiScore as number):"–"],
      ["Legal Compliance","Indikator",`${legalScore}/100`,scoreLabel(legalScore)],
      ["Governance-Reife","Indikator",`${govMatScore}/100`,scoreLabel(govMatScore)],
      ["GESAMT-SCORE","–",`${totalScore}/100`,scoreLabel(totalScore)],
    ];
    const sColW = [200,70,70,100];
    sRows.forEach((row,ri) => {
      const isH = ri===0; const isL = ri===sRows.length-1;
      const rowH = 18;
      let rx2 = ML;
      row.forEach((cell,ci) => {
        const bgCol = isH?GREEN_DARK:isL?GREEN_BG:ri%2===0?WHITE:rgb(0.97,0.99,0.97);
        page.drawRectangle({ x:rx2, y:y-rowH+2, width:sColW[ci]-2, height:rowH, color:bgCol });
        const textCol = isH?WHITE:ci===3&&!isH?scoreColor(parseInt(row[2])||totalScore):GRAY_DARK;
        page.drawText(san(cell), { x:rx2+5, y:y-12, size:7.5, font:(isH||isL)?fB:fR, color:textCol });
        rx2 += sColW[ci];
      });
      y -= rowH;
    });
    y -= 15;

    // Confidence-Level visuell
    page.drawText("Bewertungssicherheit (Confidence)", { x:ML, y, size:11, font:fB, color:GREEN_DARK });
    y -= 14;
    const confDefs = [
      { level:"HOCH",   col:GREEN_MID, desc:"Angaben eindeutig · Bewertung direkt umsetzbar" },
      { level:"MITTEL", col:ORANGE,    desc:"Angaben teils unklar · konservative Einschätzung" },
      { level:"NIEDRIG",col:RED,       desc:"Angaben fehlen · Worst-Case-Annahme · Klärung erforderlich" },
    ];
    for (const cd of confDefs) {
      page.drawRectangle({ x:ML, y:y-18, width:70, height:18, color:cd.col });
      page.drawText(cd.level, { x:ML+6, y:y-13, size:8, font:fB, color:WHITE });
      page.drawText(cd.desc, { x:ML+76, y:y-13, size:8, font:fR, color:GRAY_DARK });
      y -= 20;
    }
    y -= 10;

    // Impact-Matrix visuell (3x4 Grid)
    page.drawText("Prioritäts- und Impact-Matrix", { x:ML, y, size:11, font:fB, color:GREEN_DARK });
    y -= 14;
    const matrixRows = [
      ["Impact","Priorität","Handlungsfrist","Rechtsfolge bei Untätigkeit"],
      ["9–10","KRITISCH","0–4 Wochen","Bussen bis EUR 20 Mio. / 4% Jahresumsatz"],
      ["7–8","WICHTIG","1–3 Monate","Aufsichtsmassnahmen, Abmahnungen"],
      ["4–6","MODERAT","3–12 Monate","Reputationsrisiko, zivilrechtliche Haftung"],
      ["1–3","HINWEIS",">12 Monate","Best Practice, präventive Massnahmen"],
    ];
    const mColW = [55,80,120,250];
    const mColors = [GREEN_DARK,RED,ORANGE,GREEN_MID,GRAY_MID];
    matrixRows.forEach((row,ri) => {
      const isH = ri===0;
      const mh = 17;
      let rx3 = ML;
      row.forEach((cell,ci) => {
        const bg = isH ? GREEN_DARK : ri%2===0 ? GRAY_LIGHT : WHITE;
        page.drawRectangle({ x:rx3, y:y-mh+2, width:mColW[ci]-2, height:mh, color:bg });
        if (!isH && ci===1) {
          page.drawRectangle({ x:rx3, y:y-mh+2, width:mColW[ci]-2, height:mh, color:mColors[ri] });
        }
        page.drawText(san(cell), { x:rx3+4, y:y-12, size:7.5,
          font:isH||ci===1?fB:fR, color:isH||ci===1?WHITE:GRAY_DARK });
        rx3 += mColW[ci];
      });
      y -= mh;
    });
  }

  // ─── GAP-SEITEN 3-5 ──────────────────────────────────────────
  const gapSecs = [
    { title:"KRITISCHE COMPLIANCE-LÜCKEN — SOFORTIGER HANDLUNGSBEDARF",
      gaps:critGaps, col:RED,
      intro:`${critGaps.length} Bereiche mit erheblichem Risiko einer Nicht-Konformität — unverzügliche Massnahmen erforderlich.` },
    { title:"WICHTIGE COMPLIANCE-LÜCKEN — KURZFRISTIGER HANDLUNGSBEDARF",
      gaps:wichtGaps, col:ORANGE,
      intro:`${wichtGaps.length} Bereiche mit Risikopotenzial — Adressierung innerhalb 1–3 Monate empfohlen.` },
    { title:"MODERATE COMPLIANCE-LÜCKEN — MITTELFRISTIGER HANDLUNGSBEDARF",
      gaps:modGaps, col:GREEN_MID,
      intro:`${modGaps.length} Optimierungsbereiche — Adressierung innerhalb 3–12 Monate empfohlen.` },
  ];

  let pageNum = 3;
  for (const sec of gapSecs) {
    if (sec.gaps.length === 0) continue;
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, pageNum++, TOTAL);
    let y = PH - 50;

    y = drawSectionTitle(page, fB, sec.title, y);
    page.drawText(sec.intro, { x:ML, y, size:8, font:fR, color:GRAY_MID });
    y -= 15;

    for (const gap of sec.gaps) {
      if (y < MB + 130) {
        page.drawText(`+ ${sec.gaps.indexOf(gap)} weitere — siehe Massnahmenplan`,
          { x:ML, y, size:7.5, font:fR, color:GRAY_MID });
        break;
      }
      y = drawGapBlockPro(page, fB, fR, gap, ML, y, CW);
      y -= 5;
    }
  }

  // ─── LÄNDER-SEITE ─────────────────────────────────────────────
  {
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, pageNum++, TOTAL);
    let y = PH - 50;

    y = drawSectionTitle(page, fB, "ANWENDBARE RECHTSSYSTEME — ANALYSE", y);
    page.drawText(
      "Basierend auf Ihren Angaben zu Unternehmensstandorten und Marktaktivitäten. " +
      "Finale Anwendbarkeit erfordert individuelle Prüfung.",
      { x:ML, y, size:7.5, font:fR, color:GRAY_MID }
    );
    y -= 18;

    if (activeCtry.length === 0) {
      page.drawRectangle({ x:ML, y:y-50, width:CW, height:50, color:GRAY_LIGHT });
      page.drawRectangle({ x:ML, y:y-50, width:5, height:50, color:ORANGE });
      page.drawText("Keine Rechtssysteme identifiziert", { x:ML+12, y:y-20, size:11, font:fB, color:GRAY_DARK });
      page.drawText("Bitte vervollständigen Sie Ihre Angaben zu Standorten und Marktaktivitäten.",
        { x:ML+12, y:y-34, size:8, font:fR, color:GRAY_MID });
    } else {
      const coreJur2 = ["schweiz","eu","deutschland","oesterreich","uk"];
      for (const ctry of activeCtry) {
        if (y < MB+60) break;
        const info = COUNTRY_INFO[ctry.toLowerCase()];
        if (!info) continue;
        const isCore = coreJur2.includes(ctry.toLowerCase());

        // Länder-Block
        page.drawRectangle({ x:ML, y:y-18, width:CW, height:18, color:isCore?GREEN_DARK:GRAY_LIGHT });
        page.drawRectangle({ x:ML, y:y-18, width:5, height:18, color:isCore?GREEN_LIGHT:ORANGE });
        page.drawText(san(ctry.toUpperCase()), { x:ML+10, y:y-13, size:9.5, font:fB, color:isCore?WHITE:GRAY_DARK });
        page.drawText(san(info.law), { x:ML+120, y:y-13, size:7.5, font:fR, color:isCore?GREEN_LIGHT:GRAY_MID });
        y -= 22;

        const rows2 = [
          { label:"Anwendbarkeit:", text:info.note, col:GRAY_MID },
          { label:"Behörde:", text:info.authority, col:GREEN_MID },
          { label:"Max. Sanktion:", text:info.maxFine, col:RED },
        ];
        for (const row of rows2) {
          page.drawText(row.label, { x:ML+8, y, size:7.5, font:fB, color:row.col });
          const rLines = wrapText(row.text, fR, 7.5, CW-90);
          page.drawText(san(rLines[0]||""), { x:ML+85, y, size:7.5, font:fR, color:GRAY_DARK });
          if (rLines[1]) {
            page.drawText(san(rLines[1]), { x:ML+85, y:y-10, size:7.5, font:fR, color:GRAY_DARK });
            y -= 10;
          }
          y -= 12;
        }
        page.drawLine({ start:{x:ML,y:y-3}, end:{x:ML+CW,y:y-3}, thickness:0.3, color:GRAY_LIGHT });
        y -= 10;
      }
    }
  }

  // ─── MASSNAHMENPLAN ───────────────────────────────────────────
  {
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, pageNum++, TOTAL);
    let y = PH - 50;

    y = drawSectionTitle(page, fB, "PRIORISIERTER MASSNAHMENPLAN", y);

    if (allGaps.length === 0) {
      page.drawRectangle({ x:ML, y:y-40, width:CW, height:40, color:GREEN_BG });
      page.drawText("Keine Compliance-Lücken identifiziert.", { x:ML+10, y:y-18, size:11, font:fB, color:GREEN_MID });
      page.drawText("Das Unternehmen weist ein gutes Compliance-Profil auf.", { x:ML+10, y:y-32, size:8.5, font:fR, color:GRAY_DARK });
      y -= 50;
    } else {
      const mSecs = [
        { title:"SOFORT (0–4 Wochen)", gaps:sofortG.length?sofortG:critGaps, col:RED },
        { title:"KURZFRISTIG (1–3 Monate)", gaps:kurzG.length?kurzG:wichtGaps, col:ORANGE },
        { title:"MITTELFRISTIG (3–12 Monate)", gaps:mittelG.length?mittelG:modGaps, col:GREEN_MID },
      ];
      for (const ms of mSecs) {
        if (ms.gaps.length===0 || y<MB+35) continue;
        page.drawRectangle({ x:ML, y:y-18, width:CW, height:18, color:ms.col });
        page.drawText(`${ms.title}  (${ms.gaps.length})`, { x:ML+8, y:y-13, size:9, font:fB, color:WHITE });
        y -= 22;
        for (const gap of ms.gaps) {
          if (y<MB+25) break;
          page.drawRectangle({ x:ML, y:y-14, width:4, height:14, color:ms.col });
          page.drawRectangle({ x:ML, y:y-14, width:CW, height:14, color:rgb(0.98,0.99,0.98) });
          page.drawText(san((gap.condition||"").substring(0,70)), { x:ML+9, y:y-11, size:8, font:fB, color:GRAY_DARK });
          page.drawText(san((gap.norm||"").substring(0,45)), { x:PW-MR-160, y:y-11, size:6.5, font:fR, color:GREEN_MID });
          y -= 14;
          const repLines = wrapText(gap.reportText||"", fR, 7.5, CW-12);
          for (const line of repLines.slice(0,1)) {
            page.drawText(line, { x:ML+9, y, size:7.5, font:fR, color:GRAY_MID });
            y -= 11;
          }
          page.drawLine({ start:{x:ML,y:y-2}, end:{x:ML+CW,y:y-2}, thickness:0.2, color:GRAY_LIGHT });
          y -= 6;
        }
        y -= 6;
      }
    }
  }

  // ─── SERVICES + DISCLAIMER ────────────────────────────────────
  {
    const page = pdfDoc.addPage([PW, PH]);
    drawHeader(page, fB, fR, company, pageNum, TOTAL);
    let y = PH - 50;

    y = drawSectionTitle(page, fB, "NÄCHSTE SCHRITTE — UNTERSTÜTZUNGSANGEBOTE", y);
    page.drawText("Basierend auf dem vorliegenden Analyse-Ergebnis empfehlen wir:",
      { x:ML, y, size:8.5, font:fR, color:GRAY_DARK });
    y -= 20;

    const svcList = [
      { n:"01", name:"Compliance-Flatrate Standard",   price:"CHF 149/Mt.",    urgent:critGaps.length>0,
        desc:"Vollständige Massnahmenvorlagen, rechtssichere Dokumentvorlagen, monatlicher Update-Newsletter." },
      { n:"02", name:"Compliance-Flatrate Enterprise", price:"CHF 299/Mt.",    urgent:activeCtry.length>3,
        desc:"Alle Standard-Leistungen + erweiterte Jurisdiktionen, Jahres-Audit, Priority-Support." },
      { n:"03", name:"Compliance Navigator Review",    price:"CHF 490 einmalig",urgent:false,
        desc:"Dieser Report inkl. 30-Min. Einzelberatung mit Alex Zehnder, lic.iur., LL.M., CIPP/E." },
      { n:"04", name:"DPO-as-a-Service",               price:"auf Anfrage",    urgent:false,
        desc:"Externer Datenschutzbeauftragter — juristische Verantwortung, operative Unterstützung." },
      { n:"05", name:"30-Min. Beratungsgespräch",      price:"kostenlos",      urgent:false,
        desc:"Report persönlich besprechen. Sofortmassnahmen identifizieren. zehndergovernance.com/call" },
    ];

    for (const svc of svcList) {
      if (y < MB+55) break;
      const urgentCol = svc.urgent ? RED : GREEN_DARK;
      // Schatten
      page.drawRectangle({ x:ML+2, y:y-50, width:CW, height:50, color:rgb(0.88,0.90,0.88) });
      // Karte
      page.drawRectangle({ x:ML, y:y-48, width:CW, height:48, color:WHITE });
      page.drawRectangle({ x:ML, y:y-48, width:38, height:48, color:urgentCol });
      // Nummer
      page.drawText(svc.n, { x:ML+8, y:y-26, size:16, font:fB, color:WHITE });
      if (svc.urgent) page.drawText("!", { x:ML+22, y:y-42, size:10, font:fB, color:WHITE });
      // Inhalt
      page.drawText(san(svc.name), { x:ML+44, y:y-14, size:10, font:fB, color:GREEN_DARK });
      page.drawText(san(svc.price), { x:ML+44+240, y:y-14, size:10, font:fB, color:urgentCol });
      if (svc.urgent) {
        page.drawText("Empfohlen basierend auf Ihren Ergebnissen",
          { x:ML+44, y:y-25, size:7, font:fB, color:RED });
      }
      const descY = svc.urgent ? y-36 : y-27;
      const dLines = wrapText(svc.desc, fR, 7.5, CW-52);
      page.drawText(san(dLines[0]||""), { x:ML+44, y:descY, size:7.5, font:fR, color:GRAY_DARK });
      if (dLines[1]) page.drawText(san(dLines[1]), { x:ML+44, y:descY-10, size:7.5, font:fR, color:GRAY_DARK });
      page.drawText("zehndergovernance.com", { x:ML+44, y:y-45, size:7, font:fR, color:GREEN_MID });
      y -= 56;
    }

    y -= 8;
    // Disclaimer
    page.drawRectangle({ x:ML, y:y-68, width:CW, height:68, color:rgb(0.95,0.95,0.95) });
    page.drawRectangle({ x:ML, y:y-68, width:5, height:68, color:GRAY_MID });
    page.drawText("HAFTUNGSAUSSCHLUSS", { x:ML+10, y:y-14, size:8.5, font:fB, color:GRAY_DARK });
    const disLines = [
      "Dieser Report wurde automatisiert auf Basis strukturierter Eingaben erstellt.",
      "Er stellt keine Rechtsberatung dar und ersetzt keine individuelle juristische Prüfung.",
      "Die Ergebnisse basieren auf den eingegebenen Informationen und sind indikativ.",
      "Zehnder Governance übernimmt keine Haftung für Entscheidungen auf Basis dieses Reports.",
      "Massgeblich sind stets die aktuell gültigen gesetzlichen Bestimmungen.",
    ];
    disLines.forEach((line,i) => {
      page.drawText(san(line), { x:ML+10, y:y-26-i*10, size:7, font:fR, color:GRAY_MID });
    });
    page.drawText("© 2026 Zehnder Governance · Alex Zehnder, lic.iur., LL.M., CIPP/E, Mediator SDM-FSM",
      { x:ML+10, y:y-66, size:6.5, font:fR, color:GRAY_MID });
  }

  return pdfDoc.save();
}







